// The account's own consent text (src/lib/disclosure.ts says what it is). Here: saving it as versions that never
// change, choosing the one a person is shown by their language, what the consent line in the audit trail says about
// it, what the evidence pack prints, and "Sign on paper instead", which takes a person's consent back and closes the
// document like a decline.
//
//   disclosure_versions      every text an admin saved, one language each, numbered 1, 2, 3 for that language. A row is
//                            never changed (a trigger refuses it) and never deleted while a document refers to it.
//   accounts.disclosure_now  which version is shown today, by language. Stopping takes the entry out; the versions stay.
//   accounts.disclosure_each_visit  the consent screen every time the link is opened, instead of once for each document.
//   disclosure_shown         which version a person was shown when they agreed, by document, with the number of the
//                            audit line that says so. No name is kept in it. It goes with the document.
//
// Our own sentence on what kind of signature this is always stays on the screen (src/lib/policy.ts). An account that
// never saved a text has no row anywhere here and every screen, line and file is as it was before this existed.
import { all, get, run, tx } from './db.ts';
import { bad, id, now, sha256, rateLimit, HttpError, baseUrl } from './util.ts';
import { audit, hasNotPaid, notifySender, declineRecipient, senderOf, type Actor } from './envelopes.ts';
import { declineForGroup } from './groups.ts';
import { lureIn, posesAs } from './fakenotice.ts';
import { signerLanguage, chosenLocale } from './locales.ts';
import { settingsChanged } from './seclog.ts';
import type { Ctx } from './router.ts';
import { SOURCE_LOCALE, fallbackChain, languageWords, shippedLocales, t } from '../lib/i18n.ts';
import {
  OWN_TEXT_KEYS, OWN_TEXT_MAX, DEFAULT_NEEDS, ESIGN_NOTE, WITHDREW_REASON, NEVER_AGREED_REASON, askedPaper,
  tidyOwnText, ownTextProblem, ownSections, ownTextPlain, type OwnSection, type OwnTextFields,
} from '../lib/disclosure.ts';
import { stampText } from '../lib/dates.ts';

/** The most "agreed again" lines one person can add to one document's audit trail (every time the link is opened). */
export const AGREED_AGAIN_MAX = 50;
/** The fewest seconds between two of them: a double tap or a page that loads twice is one visit. */
export const AGREED_AGAIN_GAP_SECONDS = 60;
/** Saves of the text an account may make in an hour. Each one is a row that is kept. */
export const SAVES_PER_HOUR = 30;

const parse = (s: unknown): any => {
  try {
    return JSON.parse(String(s || 'null'));
  } catch {
    return null;
  }
};
const nowOf = (account: any): Record<string, string> => {
  const o = parse(account?.disclosure_now);
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
};
const accountOf = (accountId: string) => get('SELECT * FROM accounts WHERE id=?', accountId);

/** A saved version as the API gives it. */
function view(v: any) {
  const fields = tidyOwnText(parse(v.fields));
  return { id: v.id, language: v.language, version: v.number, ...fields, sections: (parse(v.sections) || []) as OwnSection[], sha256: v.sha256, saved_at: v.saved_at, saved_by: v.saved_by_name || null };
}

// An account that has not earned trust yet (hasNotPaid in envelopes.ts) cannot put a fake payment notice on a
// signing page through this text either: a well-known brand, words about money and a phone number together, or an
// organisation name that reads like a brand. The same filter reads everything else a sender writes.
function lure(account: any, f: OwnTextFields): boolean {
  if (!hasNotPaid(account)) return false;
  return !!posesAs(f.org) || !!lureIn([f.org, f.email, f.phone, f.address, f.paper, f.paper_cost, f.withdraw, f.needs, f.other]);
}

/**
 * The version a person whose screens are in `locale` is shown: the account's text in their language, then in that
 * language without its region, then in English. `fallback` is true when it is not in their own language. null when
 * the account shows only our words.
 */
export function currentFor(account: any, locale: unknown): { v: any; fallback: boolean } | null {
  const current = nowOf(account);
  const chain = fallbackChain(locale);
  for (const tag of chain) {
    const vid = current[tag];
    const v = vid && get('SELECT * FROM disclosure_versions WHERE id=? AND account_id=?', vid, account.id);
    if (!v) continue;
    if (lure(account, tidyOwnText(parse(v.fields)))) return null;
    return { v, fallback: tag.split('-')[0] !== chain[0].split('-')[0] };
  }
  return null;
}

/** For the signing page (GET /sign/:token): the account's text for this person, or null. */
export function ownTermsFor(e: any, r: any, req?: Request) {
  const account = accountOf(e.account_id);
  if (!account?.disclosure_now) return null;
  const ui = signerLanguage(r, req).locale;
  const cur = currentFor(account, ui);
  if (!cur) return null;
  const x = view(cur.v);
  return {
    id: x.id, version: x.version, language: x.language, org: x.org, sections: x.sections,
    // In another language than the person's screens: the one sentence that says so, in their language (i18n.ts).
    note: cur.fallback ? t(ui, 'legal.in_english') : '',
    each_visit: !!account.disclosure_each_visit,
  };
}

/** Whether this person closed their part by asking for paper: the page then says that, and not "You declined". */
export const paperFacts = (r: any) => ({ asked_paper: askedPaper(r) });

// ---- Settings --------------------------------------------------------------------------------------------------

/** GET /account/disclosure: what is shown today in each language that is switched on, and how often. */
export function readOwnText(account: any) {
  const a = accountOf(account.id);
  const current = nowOf(a);
  const texts: Record<string, any> = {};
  for (const tag of shippedLocales()) {
    const v = current[tag] && get('SELECT * FROM disclosure_versions WHERE id=? AND account_id=?', current[tag], a.id);
    texts[tag] = v ? view(v) : null;
  }
  return {
    each_visit: !!a.disclosure_each_visit, languages: shippedLocales(), texts,
    default_needs: DEFAULT_NEEDS, limits: OWN_TEXT_MAX, note: ESIGN_NOTE,
    // Whether a text was ever saved, so Settings offers the earlier versions only when there are some.
    has_versions: !!get('SELECT 1 x FROM disclosure_versions WHERE account_id=? LIMIT 1', a.id),
  };
}

/**
 * PUT /account/disclosure. "text": the parts for one language ("language", English when left out); each save that
 * changes a word makes a new version. "text": null stops showing the account's text in that language; its versions
 * stay. "each_visit": true or false. Anything left out stays as it is.
 */
export function saveOwnText(c: Ctx, b: any) {
  const before = accountOf(c.account.id);
  if (b == null || typeof b !== 'object' || Array.isArray(b)) throw bad('Send an object with "text", "each_visit" or both. Nothing was saved.');
  if (b.each_visit !== undefined && typeof b.each_visit !== 'boolean') throw bad('"each_visit" is true or false. Send one of the two. Nothing was saved.');
  const language = chosenLocale(b.language, 'The language of the text ("language")') || SOURCE_LOCALE;
  let made: any = null;
  let unchanged = false;
  if (b.text !== undefined && b.text !== null) {
    if (typeof b.text !== 'object' || Array.isArray(b.text)) throw bad(`"text" is an object with these parts: ${OWN_TEXT_KEYS.join(', ')}. Send it that way, or null to stop showing your text. Nothing was saved.`);
    const problem = ownTextProblem(b.text);
    if (problem) throw bad(`${problem} Nothing was saved.`);
    const fields = tidyOwnText(b.text);
    if (lure(before, fields)) throw bad('This text reads like a payment notice from a well-known company: it names one, with words about money and a phone number. Take one of the three out and save again. Nothing was saved.', 422);
    const sections = ownSections(fields, language);
    const hash = sha256(ownTextPlain(sections));
    const current = nowOf(before)[language];
    const cur = current && get('SELECT sha256, fields FROM disclosure_versions WHERE id=? AND account_id=?', current, before.id);
    if (cur && cur.sha256 === hash && cur.fields === JSON.stringify(fields)) unchanged = true;
    else {
      rateLimit(`owntext:${before.id}`, SAVES_PER_HOUR, 3_600_000);
      made = tx(() => {
        const number = (get('SELECT MAX(number) n FROM disclosure_versions WHERE account_id=? AND language=?', before.id, language)?.n || 0) + 1;
        const row = { id: id('dv'), number };
        run('INSERT INTO disclosure_versions (id, account_id, language, number, fields, sections, sha256, saved_by, saved_by_name, saved_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          row.id, before.id, language, number, JSON.stringify(fields), JSON.stringify(sections), hash, c.user?.id || null, c.user?.name || c.actor?.name || null, now());
        // Read again inside the transaction, so two saves at once in two languages never lose one another.
        const next = { ...nowOf(accountOf(before.id)), [language]: row.id };
        run('UPDATE accounts SET disclosure_now=? WHERE id=?', JSON.stringify(next), before.id);
        return row;
      });
    }
  } else if (b.text === null) {
    tx(() => {
      const next = nowOf(accountOf(before.id));
      delete next[language];
      run('UPDATE accounts SET disclosure_now=? WHERE id=?', Object.keys(next).length ? JSON.stringify(next) : null, before.id);
    });
  }
  if (b.each_visit !== undefined) run('UPDATE accounts SET disclosure_each_visit=? WHERE id=?', b.each_visit ? 1 : 0, before.id);
  // Who changed it and when is a line in the account's security record. The words themselves are in the versions.
  settingsChanged({ c }, before, accountOf(before.id), { disclosure_now: 'changed', disclosure_each_visit: 'value' });
  return { ...readOwnText(before), saved: made ? { language, version: made.number, id: made.id } : null, unchanged };
}

/** GET /account/disclosure/versions: every version ever saved, newest first, with how many documents refer to each. */
export function ownTextVersions(account: any, language?: string | null) {
  const a = accountOf(account.id);
  const current = new Set(Object.values(nowOf(a)));
  const tag = language ? chosenLocale(language, 'The language ("language")', 'Nothing was looked up.') : null;
  const rows = all(`SELECT v.*, (SELECT COUNT(DISTINCT s.envelope_id) FROM disclosure_shown s WHERE s.version_id=v.id) documents FROM disclosure_versions v
    WHERE v.account_id=?${tag ? ' AND v.language=?' : ''} ORDER BY v.saved_at DESC, v.number DESC LIMIT 500`, ...(tag ? [a.id, tag] : [a.id]));
  return { versions: rows.map((v) => ({ ...view(v), shown_now: current.has(v.id), documents: v.documents })) };
}

// ---- Agreeing --------------------------------------------------------------------------------------------------

/**
 * Called by POST /sign/:token/consent before anything is written. The screen says which of the account's versions it
 * showed ("own"). It must be the one this person is shown right now: a screen left open while an admin saved a new
 * text is told to show the new one first, so nobody is on record as agreeing next to words they did not have in
 * front of them. `note` goes into the consent line of the audit trail, in front of the part that names our wording;
 * `record` keeps which version it was, and writes "agreed again" for an account that asks every time.
 */
export function ownAtConsent(e: any, r: any, b: any, req?: Request) {
  const account = accountOf(e.account_id);
  const cur = account?.disclosure_now ? currentFor(account, signerLanguage(r, req).locale) : null;
  if (!cur) return { note: '', record: (_actor: Actor, _first: boolean, _line: string): void => {} };
  const v = view(cur.v);
  if (b?.own !== v.id) throw new HttpError(409, `The terms of ${v.org} on this page were not the current ones. They are shown now. Read them, then choose Continue.`, { code: 'terms' });
  // No word of the account's is in the line: a version number, a language and a fingerprint, all ours.
  const note = `Also shown the sender's own consent text, version ${v.version} in ${languageWords(v.language)}, SHA-256 ${v.sha256}. `;
  const record = (actor: Actor, first: boolean, line: string): void => {
    // The line that says they agreed was written just before this, with nothing waited for in between.
    const lastLine = () => get('SELECT MAX(seq) seq FROM audit WHERE envelope_id=?', e.id)?.seq ?? null;
    if (first) return void run('INSERT INTO disclosure_shown (envelope_id, recipient_id, audit_seq, version_id, again, at) VALUES (?,?,?,?,0,?)', e.id, r.id, lastLine(), v.id, now());
    if (!account.disclosure_each_visit || e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) return;
    const had = get('SELECT COUNT(*) n, MAX(at) last FROM disclosure_shown WHERE envelope_id=? AND recipient_id=? AND again=1', e.id, r.id);
    const since = get('SELECT MAX(at) last FROM disclosure_shown WHERE envelope_id=? AND recipient_id=?', e.id, r.id)?.last;
    if (had.n >= AGREED_AGAIN_MAX || (since && Date.now() - Date.parse(since) < AGREED_AGAIN_GAP_SECONDS * 1000)) return;
    audit(e.id, actor, 'Agreed again to electronic records and signatures', `${r.name}. The sender asks for this every time the link is opened. ${note}${line}`);
    run('INSERT INTO disclosure_shown (envelope_id, recipient_id, audit_seq, version_id, again, at) VALUES (?,?,?,?,1,?)', e.id, r.id, lastLine(), v.id, now());
  };
  return { note, record };
}

// ---- Asking for paper instead -------------------------------------------------------------------------------------

/**
 * "Sign on paper instead", "Ask <sender> to send it by post": the person takes back their consent to electronic
 * records (or says they never gave it). Their part closes like a decline, with a reason the software writes, so
 * nothing more can be done on screen on this document. The sender is emailed whatever their notification choices are,
 * because only they can send the paper.
 */
export async function askForPaper(e: any, r: any, actor: Actor) {
  if (r.role === 'cc' || r.role === 'viewer') throw bad(`You were only asked to read this document, so there is nothing here to stop. Ask ${senderOf(e)?.name || 'the sender'} for a paper copy if you want one.`);
  const had = !!r.consent_at;
  const reason = had ? WITHDREW_REASON : NEVER_AGREED_REASON;
  const told = async (x: { e: any; r: any }) => {
    const name = x.r.name;
    await notifySender(x.e, 'always', `Asked for paper: ${x.e.subject}`, `${name} asks for this document on paper`, [
      `${name} ${had ? 'took back their agreement to use electronic records and signatures' : 'did not agree to use electronic records and signatures'} and asked you to send "${x.e.subject}" on paper instead.`,
      'The document is closed for everyone, and nothing more can be signed on screen. Nothing they had filled in is part of a signed document.',
      'What to do now: send them the paper yourself, the way your own consent text says. GrowSigning does not print or post anything.',
      'If they change their mind, you can copy the document and send it again.',
    ], { label: 'Open the document', url: `${baseUrl()}/app/envelopes/${x.e.id}` }, { onPaper: true });
  };
  if (r.group_name) await declineForGroup(e, r, reason, actor, told);
  else await declineRecipient(e, r, reason, actor, told);
  // The one mark that this was a request for paper. The words of the reason are not: anyone can type them in Decline.
  run("UPDATE recipients SET paper_at=COALESCE(completed_at, ?) WHERE id=? AND status='declined'", now(), r.id);
  audit(e.id, actor, reason, `${r.name}. They asked the sender to send the document on paper instead. Nothing more can be done on screen on this document, and nothing they had filled in is part of a signed document.`);
  return { ok: true, reason };
}

// ---- The evidence pack ---------------------------------------------------------------------------------------

const stamp = (at: string) => stampText(at);

/**
 * consent-own-text.txt of the evidence pack: which of the account's versions each person was shown when they agreed,
 * and the exact words of each of those versions, once. '' when nobody on this document was shown one.
 */
export function ownTextEvidence(e: any): string {
  // Who it was is read from the audit line that says they agreed, so a name taken out of the trail is out of here too.
  const shown = all(`SELECT s.*, v.number, v.language, v.sha256, v.sections, v.saved_at, (SELECT a.actor FROM audit a WHERE a.envelope_id=s.envelope_id AND a.seq=s.audit_seq) person
    FROM disclosure_shown s JOIN disclosure_versions v ON v.id=s.version_id WHERE s.envelope_id=? ORDER BY s.id`, e.id);
  if (!shown.length) return '';
  const versions = new Map<string, any>();
  for (const s of shown) versions.set(s.version_id, s);
  const name = (s: any) => `version ${s.number} in ${languageWords(s.language)}`;
  return [
    `The sender's own consent text on "${e.subject}" (envelope ${e.id}). It was shown on the screen where each person agreed to electronic records and signatures, under GrowSigning's own words, which are in consent.txt. Each version below is printed exactly as it was shown. GrowSigning did not write these words and did not check them against any law.`, '',
    'Who was shown which version:', '',
    ...shown.map((s: any) => `${s.person || 'Someone on this document'}, ${stamp(s.at)}: ${name(s)}${s.again ? ', when they opened the link again' : ''}.`), '',
    ...[...versions.values()].flatMap((s: any) => ['----', '', `${name(s)[0].toUpperCase()}${name(s).slice(1)}, saved ${stamp(s.saved_at)}. SHA-256 of the words below (UTF-8, as printed between the lines of dashes, without the empty lines around them): ${s.sha256}`, '',
      ownTextPlain((parse(s.sections) || []) as OwnSection[]), '']),
    '----',
  ].join('\r\n');
}
