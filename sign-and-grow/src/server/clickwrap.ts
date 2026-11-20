// Click-to-agree ("clickwrap"): terms a website's visitors accept with one click, and the record of who accepted
// which version and when. The words are in src/lib/clickwrap.ts, the routes in routes-clickwrap.ts. Here: drafts and
// versions, the link a website signs to say who its visitor is, recording an acceptance (the same rules for our page,
// a frame on another website and the API), the monthly limit, the scam filter, the certificate and deleting.
//
// What an acceptance is: a row that is written once and never changed (a trigger in db.ts refuses any change), sealed
// with the server's secret so a changed row is noticed, and kept for the account until the account is deleted. It is
// not a signature and costs none.
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { all, get, run, readBlob } from './db.ts';
import { bad, baseUrl, hmac, id, isEmail, now, safeEqual, sha256, str, HttpError } from './util.ts';
import { sendMail } from './mail.ts';
import { dailyCap, hasNotPaid, nameRefusal, noteReached, pausedText } from './envelopes.ts';
import { lureIn, posesAs } from './fakenotice.ts';
import { withKeptText } from './searchtext.ts';
import { sheetPdf } from './pdf.ts';
import { clickwrapMonthlyLimit, CLICKWRAP_WARN_PERCENT, paidTrustText } from '../lib/policy.ts';
import {
  CLICK_LAW, DEFAULT_BUTTON, DEFAULT_CHECKBOX, IDENTITY_LABEL, LABEL_MAX, NAME_MAX, TERMS_MAX_CHARS, VIA_LABEL, VIEW_MAX_HOURS, WHO_MAX_DAYS,
  VIEW_MATCH_LABEL, coverLine, recordShows, termsPlain, usageLine, type Identity, type Via,
} from '../lib/clickwrap.ts';

export const pageUrl = (slug: string) => `${baseUrl()}/agree/${slug}`;

// ---- The monthly limit ----------------------------------------------------------------------------------------------

const monthStart = (t = Date.now()) => `${new Date(t).toISOString().slice(0, 7)}-01T00:00:00.000Z`;
const nextMonth = (t = Date.now()) => {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
};
// Two counts, each with the whole monthly limit: acceptances visitors typed their own details into (anyone who opens
// the page can do that), and acceptances the website vouched for (a signed link, or the API). Strangers typing on a
// page can fill the first, never the second, so the website's own visitors and its server keep working.
export type Bucket = 'typed' | 'vouched';
export const bucketOf = (identity: string): Bucket => (identity === 'typed' ? 'typed' : 'vouched');
export function usage(accountId: string): { used: number; typed: number; vouched: number; limit: number; resets: string; line: string } {
  const typed = get("SELECT COUNT(*) n FROM clickwrap_acceptances WHERE account_id=? AND at >= ? AND identity='typed'", accountId, monthStart()).n;
  const vouched = get("SELECT COUNT(*) n FROM clickwrap_acceptances WHERE account_id=? AND at >= ? AND identity!='typed'", accountId, monthStart()).n;
  const limit = clickwrapMonthlyLimit();
  return { used: typed + vouched, typed, vouched, limit, resets: nextMonth(), line: usageLine(typed, vouched, limit, nextMonth()) };
}
const admins = (accountId: string): string[] => all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", accountId).map((u) => u.email);

// The admins hear once a month for each count when it reaches 80 percent of the limit, and once when it is reached,
// before a customer tells them that their website's terms page stopped taking acceptances. The 80 percent mail about
// typed acceptances is also how they hear that strangers are pressing the button over and over.
async function tellAdmins(accountId: string, kind: Bucket) {
  const u = usage(accountId);
  if (u.limit <= 0) return;
  const [warnCol, fullCol] = kind === 'typed' ? ['clickwrap_typed_warned', 'clickwrap_typed_full'] : ['clickwrap_warned', 'clickwrap_full'];
  const a = get(`SELECT name, ${warnCol} warned_for, ${fullCol} full_for FROM accounts WHERE id=?`, accountId);
  if (!a) return;
  const month = monthStart().slice(0, 7);
  const url = `${baseUrl()}/app/agreements`;
  const n = u[kind];
  const who = kind === 'typed' ? 'visitors who typed their own name and address' : 'people your website named in a signed link and acceptances your website sent through the API';
  const other = kind === 'typed' ? `People your website names in a signed link, and acceptances your website sends through the API, are counted apart and still work (${u.vouched} of ${u.limit} used).` : `Visitors who type their own details are counted apart (${u.typed} of ${u.limit} used).`;
  if (n >= u.limit && a.full_for !== month) {
    run(`UPDATE accounts SET ${fullCol}=?, ${warnCol}=? WHERE id=?`, month, month, accountId);
    for (const to of admins(accountId))
      await sendMail({ to, subject: `${a.name}: no more click-to-agree acceptances by ${kind === 'typed' ? 'typed-in visitors' : 'your website'} this month`, heading: `Until ${u.resets}, ${who} cannot accept your terms`,
        lines: [`${a.name} has recorded ${n} acceptances this month by ${who}. That is the most this server records for one account in a month, so until ${u.resets} they are told that the terms cannot be accepted right now${kind === 'typed' ? '' : ', and the API answers 429'}, and nothing is recorded for them. Nothing that was recorded is lost. ${other}`,
          kind === 'typed' ? 'If you did not expect this many, look at the list of acceptances for names you do not know: someone may be pressing the button over and over. Switching on "Only people the website names" stops anyone your website has not sent.'
            : `An acceptance is not a signature and costs nothing. The limit is there so that the records cannot be filled without end. If your website really needs more, use the contact form at ${baseUrl()}/help and say how many you expect: the operator of this server can raise it.`],
        cta: { label: 'Open your agreements', url } });
  } else if (n >= Math.ceil((u.limit * CLICKWRAP_WARN_PERCENT) / 100) && a.warned_for !== month) {
    run(`UPDATE accounts SET ${warnCol}=? WHERE id=?`, month, accountId);
    for (const to of admins(accountId))
      await sendMail({ to, subject: `${a.name}: ${CLICKWRAP_WARN_PERCENT} percent of this month's click-to-agree acceptances by ${kind === 'typed' ? 'typed-in visitors' : 'your website'} used`, heading: `${n} of ${u.limit} acceptances by ${kind === 'typed' ? 'typed-in visitors' : 'your website'} this month`,
        lines: [`${a.name} has recorded ${n} acceptances this month by ${who}, out of ${u.limit}. When the limit is reached, they cannot accept your terms until ${u.resets}: they are told so and nothing is recorded for them. ${other}`,
          `If that is more than you expected, look at the list of acceptances for names you do not know: someone may be pressing the button over and over. Switching on "Only people the website names" stops anyone your website has not sent. If your website really needs more, use the contact form at ${baseUrl()}/help.`],
        cta: { label: 'Open your agreements', url } });
  }
}

// ---- Drafts and versions --------------------------------------------------------------------------------------------

export function loadAgreement(idOrNull: any, accountId: string) {
  const cw = get('SELECT * FROM clickwraps WHERE id=? AND account_id=?', str(idOrNull, 80), accountId);
  if (!cw) throw bad('That agreement does not exist, or it belongs to another account.', 404);
  return cw;
}
export const versionOf = (cw: any, n = cw.current_version) => (n ? get('SELECT * FROM clickwrap_versions WHERE clickwrap_id=? AND number=?', cw.id, n) : null);
// The lowest version an acceptance must be of to count now: the newest version that asked everyone to accept again.
export const minVersion = (cw: any): number => get('SELECT MAX(number) n FROM clickwrap_versions WHERE clickwrap_id=? AND ask_again=1', cw.id)?.n || 0;

// What the draft would publish, read from the agreement's own columns and its file.
function draftOf(cw: any) {
  // The kept text may be encrypted (FILE_ENCRYPTION_KEY): withKeptText opens it in memory for the filter (searchtext.ts).
  const file = cw.draft_format === 'pdf' && cw.draft_file_id ? withKeptText(get('SELECT * FROM files WHERE id=? AND account_id=?', cw.draft_file_id, cw.account_id)) : null;
  return {
    title: cw.name, format: cw.draft_format === 'pdf' ? 'pdf' : 'text', text: cw.draft_text || '', file,
    checkbox: cw.draft_checkbox || DEFAULT_CHECKBOX, button: cw.draft_button || DEFAULT_BUTTON, scroll: cw.draft_scroll ? 1 : 0,
  };
}

// The scam filter (src/server/fakenotice.ts) reads the terms of every account it applies to (hasNotPaid): our page
// prints them under our name to anyone with the link, so a page that reads like a fake payment notice must never be
// shown. Answers what to tell the team, or null. `scan` says the terms are a PDF the filter could not read. `words` is
// everything else the page shows or a copy mails with them, read together with the terms as fakeNotice reads the
// labels of fields with an envelope: the words next to the box and on the button, the notes of what changed (a
// returning visitor is shown them), and the details a website put in its signed link.
export function termsRefusal(account: any, title: string, text: string, scan = false, words: any[] = []): string | null {
  if (!account || !hasNotPaid(account)) return null;
  if (posesAs(account.name)) return nameRefusal([account.name]);
  const brand = posesAs(title);
  if (brand) return `The name "${str(title, 120)}" reads like ${brand}. A page that seems to come from a well-known company is how people get tricked, so terms cannot be published under a name like that. Use a name of your own. If you really do write for ${brand}, use the contact form at ${baseUrl()}/help and a person will clear your account. ${paidTrustText()}`;
  if (scan) return `We cannot read the words of this PDF: at least one page is a picture (a scan or a photo). Our page shows these terms under the GrowSigning name to anyone with the link, and until this account has earned trust we read what it would show, to keep fake payment notices off it. Use a PDF made from a document, or write the terms as text. ${paidTrustText()}`;
  const lure = lureIn([title, text, account.name, ...words]);
  return lure ? `These terms, or the words shown with them (next to the box, on the button, in a note of what changed), read like a payment notice from a well-known brand with a phone number to call, which is how scams look. What set this off: the name ${lure.brand}, words about money ("${lure.money}") and what looks like a phone number (${lure.phone}). If that is not what you mean, take one of the three out. If it is genuine, use the contact form at ${baseUrl()}/help and a person will clear your account. ${paidTrustText()}` : null;
}
const isScan = (file: any) => !file?.text?.trim() || !!file?.scan_pages;
// The words a page shows beside its terms: the box, the button, and every note of what changed (a visitor who accepted
// an earlier version is shown the notes of the versions since).
const shownWords = (cw: any, v: { checkbox: string; button: string }): string[] =>
  [v.checkbox, v.button, ...all('SELECT note FROM clickwrap_versions WHERE clickwrap_id=? AND note IS NOT NULL', cw.id).map((x) => x.note)];

// Publishing makes the draft the next version. Any change to what the page shows (the terms, their name, the words of
// the box or the button, the rule about scrolling) is a new version; nothing changed is refused, so a version number
// always means something. `askAgain` says whether people who accepted an earlier version have to accept again.
export function publish(cw: any, user: any, note: string, askAgain: boolean) {
  const d = draftOf(cw);
  const account = get('SELECT * FROM accounts WHERE id=?', cw.account_id);
  if (account.suspended_at) throw bad(pausedText(account), 403);
  if (d.format === 'text' && !termsPlain(d.text).trim()) throw bad('Write the terms first, or choose a PDF. Nothing was published.');
  if (d.format === 'pdf' && !d.file) throw bad('Choose the PDF with your terms first. Nothing was published.');
  const sha = d.format === 'pdf' ? d.file.sha256 : sha256(d.text);
  const why = str(note, 500).trim();
  const no = termsRefusal(account, d.title, d.format === 'pdf' ? d.file.text || '' : termsPlain(d.text), d.format === 'pdf' && isScan(d.file), [...shownWords(cw, d), why]);
  if (no) throw bad(`${no} Nothing was published.`, 422);
  const cur = versionOf(cw);
  if (cur && cur.terms_sha256 === sha && cur.title === d.title && cur.checkbox === d.checkbox && cur.button === d.button && cur.scroll === d.scroll)
    throw bad(`Nothing has changed since version ${cur.number}, so there is nothing to publish. Change the terms, their name, the words next to the box or on the button, or the rule about scrolling first.`, 409);
  if (cur && !why) throw bad('Say in a sentence what changed. People who accepted an earlier version are shown it when they are asked to accept again, and it stays with the version. Nothing was published.');
  const number = (cur?.number || 0) + 1;
  // Version 1 always counts as asking everyone: nobody has accepted anything before it.
  const ask = !cur || askAgain ? 1 : 0;
  // The account's name goes with the version: the page showed it above the terms, and a later rename must not change
  // whom a record says the terms were from.
  run('INSERT INTO clickwrap_versions (id, clickwrap_id, number, title, format, body, file_sha256, pages, terms_sha256, checkbox, button, scroll, note, ask_again, published_by, published_at, account_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id('cwv'), cw.id, number, d.title, d.format, d.format === 'text' ? d.text : null, d.format === 'pdf' ? d.file.sha256 : null, d.format === 'pdf' ? d.file.pages : null, sha,
    d.checkbox, d.button, d.scroll, why || null, ask, user ? `${user.name} <${user.email}>` : null, now(), account.name);
  run('UPDATE clickwraps SET current_version=?, updated_at=? WHERE id=?', number, now(), cw.id);
  // Who has to accept again: everyone whose acceptances are all of earlier versions, counted as people (the
  // website's id for them, or else their address).
  const people = cur ? get('SELECT COUNT(DISTINCT COALESCE(person_id, lower(email), id)) n FROM clickwrap_acceptances WHERE clickwrap_id=? AND version < ?', cw.id, number).n : 0;
  const again = !cur ? 'This is the first version: everyone who opens the page is asked to accept it.'
    : ask ? `${people === 1 ? 'The one person' : `All ${people} people`} who accepted an earlier version ${people === 1 ? 'is' : 'are'} asked to accept version ${number} the next time they come, and "has accepted" answers no for them until they do.`
      : `Nobody has to accept again: acceptances of version ${minVersion(cw)} and later still count, and new visitors accept version ${number}.`;
  return { version: number, sha256: sha, asked_again: ask && cur ? people : 0, again };
}

// ---- Who the visitor is ------------------------------------------------------------------------------------------
// A website names its visitor in two parts it makes on its own server: "who", base64url of JSON {id, name, email,
// exp}, and "sig", the HMAC-SHA256 of exactly that text with the agreement's key, in base64url or hex. Without the
// key nobody can make one, so a visitor cannot accept as somebody else. The signature is checked before anything in
// "who" is read.

export type Person = { id: string | null; name: string | null; email: string | null };
export function readWho(cw: any, who: any, sig: any): Person | null {
  const w = str(who, 4000).trim();
  const s = str(sig, 200).trim();
  if (!w && !s) return null;
  if (!w || !s) throw bad('The link from the website is missing half of what says who you are. Go back to the website and follow its link again.', 400, { code: 'who_incomplete' });
  const mac = crypto.createHmac('sha256', cw.secret).update(w).digest();
  if (!safeEqual(s, mac.toString('base64url')) && !safeEqual(s.toLowerCase(), mac.toString('hex')))
    throw bad('The link from the website could not be checked: it was not made with the key of these terms, it was changed on the way, or the key was replaced since. Go back to the website and open its link again. If that keeps happening, tell the website.', 403, { code: 'who_not_signed' });
  let o: any;
  try {
    o = JSON.parse(Buffer.from(w, 'base64url').toString('utf8'));
    if (!o || typeof o !== 'object') throw 0;
  } catch {
    throw bad('The link from the website carries something we cannot read as JSON. "who" must be base64url of a JSON object such as {"id":"c_123","exp":1767225600}.', 400, { code: 'who_unreadable' });
  }
  const exp = Number(o.exp);
  if (!Number.isFinite(exp)) throw bad('The link from the website has no end time ("exp", in seconds since 1970), so it is not accepted. A link that never ends would let anyone who finds it accept in your name.', 400, { code: 'who_no_exp' });
  if (exp > 1e11) throw bad('"exp" in the link from the website looks like milliseconds. It is counted in seconds since 1970 (Unix time): divide by 1000.', 400, { code: 'who_exp_ms' });
  if (exp * 1000 < Date.now()) throw bad('The link from the website has run out. Go back to the website and follow its link again: it makes a fresh one.', 403, { code: 'who_expired' });
  if (exp * 1000 > Date.now() + WHO_MAX_DAYS * 864e5) throw bad(`The link from the website stays valid for more than ${WHO_MAX_DAYS} days, which is longer than we accept. Make links that end sooner.`, 400, { code: 'who_exp_far' });
  const person: Person = { id: str(o.id ?? '', 200).trim() || null, name: str(o.name ?? '', 200).trim() || null, email: str(o.email ?? '', 254).trim() || null };
  if (person.email && !isEmail(person.email)) throw bad(`The link from the website gives "${str(person.email, 80)}" as the email address, which is not one. Leave it out, or give a real address.`, 400, { code: 'who_bad_email' });
  if (!person.id && !person.email) throw bad('The link from the website names nobody: it needs "id" (your own id for the person) or "email", or both.', 400, { code: 'who_nobody' });
  return person;
}
/** The link a website would make, for tests and for the team's own trial on the agreement page. */
export function signWho(secret: string, person: { id?: string; name?: string; email?: string }, exp = Math.floor(Date.now() / 1000) + 3600) {
  const who = Buffer.from(JSON.stringify({ ...person, exp })).toString('base64url');
  return { who, sig: crypto.createHmac('sha256', secret).update(who).digest('base64url') };
}

// One internet address, for limits and comparisons: an IPv6 address by its /64, the block one household or phone is
// given (its last half changes by itself for privacy), and an IPv4 address written as IPv6 (::ffff:1.2.3.4) as IPv4.
export function addressKey(ip: any): string {
  const s = str(ip, 100).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4 || !s.includes(':')) return v4 ? v4[1] : s;
  const [head, tail = ''] = s.split('::');
  const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
  const all8 = s.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return `${all8.slice(0, 4).map((x) => (x || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// The page hands out a "view" with the terms: which version it showed, when, and to which address and browser (as
// fingerprints). Accepting needs it, so a press always belongs to the version that was on the screen, the record can
// say how long the terms were open, and whether the press came from where the terms were handed out to.
const whoFor = (ip?: string, ua?: string) => (ip === undefined && ua === undefined ? '-' : `${hmac(`cwvip:${addressKey(ip)}`).slice(0, 12)}~${hmac(`cwvua:${ua || ''}`).slice(0, 12)}`);
export const viewToken = (versionId: string, t = Date.now(), ip?: string, ua?: string) => {
  const who = whoFor(ip, ua);
  return `${versionId}.${t}.${who}.${hmac(`cwview:${versionId}:${t}:${who}`).slice(0, 32)}`;
};
/** Whether the address and the browser that press are the ones the terms were handed to: 'same', or which differ. */
export type ViewMatch = 'same' | 'address' | 'browser' | 'both' | null;
export function readView(view: any, cur: any, ip?: string, ua?: string): { open: number; match: ViewMatch } {
  const [vid, t, who, mac] = str(view, 200).split('.');
  if (!vid || !t || !who || !mac || !safeEqual(mac, hmac(`cwview:${vid}:${t}:${who}`).slice(0, 32))) throw bad('Load the page again and press the button there.', 400, { code: 'no_view' });
  if (vid !== cur.id) throw bad(`These terms were changed while the page was open. The page now shows version ${cur.number}: read it, then accept again if you agree. Nothing was recorded.`, 409, { code: 'terms_changed' });
  const open = Date.now() - Number(t);
  if (open > VIEW_MAX_HOURS * 3600_000) throw bad(`This page was open for more than ${VIEW_MAX_HOURS} hours. Load it again to make sure you see the current terms, then accept. Nothing was recorded.`, 409, { code: 'view_old' });
  // A phone that moves from wifi to its own network changes address between the page and the press, so a difference
  // is recorded and said, never refused.
  let match: ViewMatch = null;
  if (who !== '-' && (ip !== undefined || ua !== undefined)) {
    const [hi, hu] = who.split('~'), [ni, nu] = whoFor(ip, ua).split('~');
    match = hi === ni ? (hu === nu ? 'same' : 'browser') : hu === nu ? 'address' : 'both';
  }
  return { open: Math.max(0, open), match };
}

// ---- Why terms cannot be accepted right now ------------------------------------------------------------------------
// For the team: the real reason. A visitor is told only that the terms cannot be accepted here right now, with
// nothing recorded, so a stranger learns nothing about the account.
export const CLOSED_TEXT = 'These terms cannot be accepted here right now. Nothing was recorded. Please contact the website that sent you here.';
export function closedWhy(cw: any, v: any = versionOf(cw), extra: any[] = []): string | null {
  const account = get('SELECT * FROM accounts WHERE id=?', cw.account_id);
  if (!account) return 'The account no longer exists.';
  if (account.suspended_at) return `${pausedText(account)} While sending is paused, its click-to-agree pages are closed too.`;
  if (account.closing_at) return `The account is being closed and will be deleted on ${String(account.closing_at).slice(0, 10)}, so its terms cannot be accepted. Signing in again before then keeps the account.`;
  if (!v) return 'Nothing is published yet. Publish the terms to open the page.';
  if (!cw.active) return 'You closed these terms. Open them again to take acceptances.';
  // Read again every time: an account that loses its trust (a refund, a dispute) has its pages read like a new one.
  const file = v.format === 'pdf' ? withKeptText(get('SELECT id, text, text_sealed, scan_pages FROM files WHERE sha256=? AND account_id=? LIMIT 1', v.file_sha256, cw.account_id)) : null;
  return termsRefusal(account, v.title, v.format === 'text' ? termsPlain(v.body) : file?.text || '', v.format === 'pdf' && isScan(file), [...shownWords(cw, v), ...extra]);
}
// The same for one visitor named in a signed link: the page prints their name and address ("You accept as ...") and a
// copy is mailed to them, so a website that puts a payment notice in its links is refused like terms that read as one.
// For the team, the reason says it was the link.
export function linkWhy(cw: any, v: any, person: Person | null): string | null {
  if (!person) return null;
  const why = closedWhy(cw, v, [person.name, person.email, person.id]);
  return why && !closedWhy(cw, v) ? `The details your website put in its signed link for one visitor (name "${str(person.name || '', 80)}", id "${str(person.id || '', 80)}") are shown on the page with the terms, and together with them they read like a fake payment notice. That visitor was turned away. ${why}` : why;
}
// The team hears why a visitor was turned away, once a day at most, when it is something they did not choose.
export async function tellOwnerClosed(cw: any, why: string) {
  if (!cw.active || (cw.alerted_at && Date.parse(cw.alerted_at) >= Date.now() - 864e5)) return;
  run('UPDATE clickwraps SET alerted_at=? WHERE id=?', now(), cw.id);
  for (const to of admins(cw.account_id))
    await sendMail({ to, subject: `Your terms "${cw.name}" could not be accepted`, heading: 'Someone tried to accept your terms and could not',
      lines: [`What stopped it: ${why}`, 'They were told only that the terms cannot be accepted here right now, and nothing was recorded for them.'], cta: { label: 'Open your agreements', url: `${baseUrl()}/app/agreements/${cw.id}` } });
}

// ---- Recording an acceptance ---------------------------------------------------------------------------------------

const SEALED = ['id', 'clickwrap_id', 'account_id', 'version_id', 'version', 'terms_sha256', 'identity', 'person_id', 'name', 'email', 'via', 'page_url', 'ip', 'ua', 'given_ip', 'given_ua', 'shown_ms', 'scrolled', 'unobscured', 'recorded_by', 'at'];
// Sealed since they were added, and only when set: a row written before them still fits the seal it was given, and
// setting or clearing one afterwards breaks the seal like any other change.
const SEALED_LATER = ['view_match'];
const sealOf = (row: any) => hmac(`cwseal:${JSON.stringify([...SEALED.map((k) => row[k] ?? null), ...SEALED_LATER.filter((k) => row[k] != null).map((k) => [k, row[k]])])}`);
export const intact = (row: any) => safeEqual(row.seal || '', sealOf(row));
/** The secret a visitor's browser holds for their own acceptance: the copy by email and the certificate. Never stored. */
export const receiptOf = (acceptanceId: string) => `cwr_${hmac(`cwreceipt:${acceptanceId}`).slice(0, 40)}`;
// The receipt goes only to the browser that accepted: in the answer to its press, and again only to the same page load
// (the same "view") pressing twice, say after an answer that never arrived. Anyone else who opens the same signed link
// (a forwarded email, a shared screen, a browser's history) is told the person accepted, and nothing more.
export const mayHaveReceipt = (row: any, view: any) => !!row.view_hash && !!view && row.view_hash === sha256(String(view));

// A web address of a page, as given: only http or https, and never more than 500 characters. Anything else is not kept.
export function cleanUrl(raw: any): string | null {
  const s = str(raw, 2000).trim();
  if (!s || s.length > 500) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export type AcceptIn = {
  cw: any; v: any; identity: Identity; person: Person; via: Via; page_url?: string | null; ip: string; ua: string;
  given_ip?: string | null; given_ua?: string | null; shown_ms?: number | null; scrolled?: boolean | null; unobscured?: boolean | null; recorded_by?: string | null;
  view?: string | null; view_match?: ViewMatch; onRecorded?: () => void;
};
export class LimitReached extends HttpError {}

// The one way an acceptance is written, for our page, a frame and the API. Counting and writing happen in one step
// with nothing in between that waits, so two presses at the same moment cannot both take the last place of the month.
export async function recordAcceptance(a: AcceptIn, visitorWords = false): Promise<{ row: any; already: boolean }> {
  const { cw, v, person } = a;
  // The same person named by the website (or by the API) accepting the same version again is not a second record:
  // the first one is the answer. A typed name proves nothing, so there only a double press within a minute from
  // the same address is caught.
  const same = a.identity === 'typed'
    ? get("SELECT * FROM clickwrap_acceptances WHERE clickwrap_id=? AND version=? AND identity='typed' AND lower(email)=lower(?) AND ip IS ? AND at > ? ORDER BY at DESC LIMIT 1", cw.id, v.number, person.email || '', a.ip || null, new Date(Date.now() - 60_000).toISOString())
    : person.id ? get("SELECT * FROM clickwrap_acceptances WHERE clickwrap_id=? AND version=? AND person_id=? AND identity != 'typed' ORDER BY at DESC LIMIT 1", cw.id, v.number, person.id)
      : get("SELECT * FROM clickwrap_acceptances WHERE clickwrap_id=? AND version=? AND person_id IS NULL AND lower(email)=lower(?) AND identity != 'typed' ORDER BY at DESC LIMIT 1", cw.id, v.number, person.email || '');
  if (same) return { row: same, already: true };
  const u = usage(cw.account_id);
  const kind = bucketOf(a.identity);
  if (u[kind] >= u.limit) {
    await tellAdmins(cw.account_id, kind);
    throw new LimitReached(429, visitorWords ? CLOSED_TEXT : `This account has recorded ${u[kind]} click-to-agree acceptances this month from its website (signed links and the API), and ${u.limit} is the most this server records for one account in a month. Nothing was recorded. The count starts again on ${u.resets}. If you need more, use the contact form at ${baseUrl()}/help.`, { code: 'monthly_limit', resets: u.resets });
  }
  const row: any = {
    id: id('cwa'), clickwrap_id: cw.id, account_id: cw.account_id, version_id: v.id, version: v.number, terms_sha256: v.terms_sha256, identity: a.identity,
    person_id: person.id, name: person.name, email: person.email, via: a.via, page_url: a.page_url ?? null, ip: a.ip || null, ua: str(a.ua, 400) || null,
    given_ip: a.given_ip ?? null, given_ua: a.given_ua ?? null, shown_ms: a.shown_ms ?? null, scrolled: a.scrolled == null ? null : a.scrolled ? 1 : 0,
    unobscured: a.unobscured == null ? null : a.unobscured ? 1 : 0, recorded_by: a.recorded_by ?? null, at: now(), view_match: a.view_match ?? null,
  };
  row.receipt_hash = sha256(receiptOf(row.id));
  row.seal = sealOf(row);
  // The page load that pressed: only it is given the receipt again when it presses twice (mayHaveReceipt).
  row.view_hash = a.view ? sha256(String(a.view)) : null;
  const cols = [...SEALED, ...SEALED_LATER, 'receipt_hash', 'seal', 'view_hash'];
  run(`INSERT INTO clickwrap_acceptances (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((k) => row[k]));
  // Counted in the same step as the write, so only what was recorded counts (the limits per address).
  a.onRecorded?.();
  await tellAdmins(cw.account_id, kind);
  return { row, already: false };
}

// What the team and the API see of an acceptance. "agreement" is the name of the version that was accepted, never the
// draft's name now: a renamed draft must not make an old record name terms nobody accepted.
export function acceptanceView(r: any) {
  const title = r.version_title ?? get('SELECT title FROM clickwrap_versions WHERE id=?', r.version_id)?.title ?? null;
  return {
    id: r.id, agreement_id: r.clickwrap_id, agreement: title, version: r.version, terms_sha256: r.terms_sha256, accepted_at: r.at,
    identity: r.identity, person: { id: r.person_id, name: r.name, email: r.email }, via: r.via, page_url: r.page_url, ip: r.ip, user_agent: r.ua,
    given_ip: r.given_ip, given_user_agent: r.given_ua, seconds_open: r.shown_ms == null ? null : Math.round(r.shown_ms / 100) / 10,
    scrolled: r.scrolled == null ? null : !!r.scrolled, button_uncovered: r.unobscured == null ? null : !!r.unobscured, recorded_by: r.recorded_by,
    terms_handed_to: r.view_match ?? null, intact: intact(r),
  };
}

// Has this person accepted what counts now? Asked by the website's own server. A person is found by the website's id
// for them when one is given, otherwise by email address. An address that was typed by a visitor proves nothing, and
// the answer says how each acceptance came about, so a website can decide which it trusts.
export function statusFor(cw: any, q: { person_id?: string; email?: string }) {
  const pid = str(q.person_id, 200).trim();
  const email = str(q.email, 254).trim();
  if (!pid && !email) throw bad('Say who: person_id (your own id for them) or email.');
  const rows = pid ? all('SELECT * FROM clickwrap_acceptances WHERE clickwrap_id=? AND person_id=? ORDER BY version DESC, at DESC', cw.id, pid)
    : all('SELECT * FROM clickwrap_acceptances WHERE clickwrap_id=? AND lower(email)=lower(?) ORDER BY version DESC, at DESC', cw.id, email);
  const need = minVersion(cw);
  const best = rows[0] || null;
  return {
    agreement_id: cw.id, current_version: cw.current_version || null, counts_from_version: need || null,
    accepted: !!best && need > 0 && best.version >= need, latest: best ? acceptanceView(best) : null,
    versions_accepted: [...new Set(rows.map((r) => r.version))].sort((a, b) => a - b),
  };
}

// ---- The certificate -------------------------------------------------------------------------------------------------

const stamp = (s: string | null | undefined) => (s ? s.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '-');
export async function certificatePdf(r: any): Promise<Uint8Array> {
  const cw = get('SELECT * FROM clickwraps WHERE id=?', r.clickwrap_id);
  const v = get('SELECT * FROM clickwrap_versions WHERE id=?', r.version_id);
  const account = get('SELECT name FROM accounts WHERE id=?', r.account_id)?.name || '';
  let host = '';
  try {
    host = r.page_url ? new URL(r.page_url).host : '';
  } catch {}
  const words = recordShows(r.identity, r.via, host);
  const ok = intact(r);
  // The pages of terms in a PDF are read before the sheet is written, so the sheet says what this file really holds:
  // the pages after it, or why they could not be read (filestore.ts refuses a damaged or locked file). Never a promise
  // of pages that are then left out.
  let terms: PDFDocument | null = null;
  let unread = '';
  // Terms whose agreement was deleted are no longer stored, and asking for them would only report a missing file.
  if (v.format === 'pdf' && v.file_sha256 && cw)
    try {
      terms = await PDFDocument.load(readBlob(v.file_sha256), { updateMetadata: false, ignoreEncryption: true });
    } catch (e: any) {
      unread = e?.data?.code === 'file_locked' ? 'they are locked with an encryption key this server was not given' : e?.data?.code === 'file_damaged' ? 'the stored copy failed its check' : 'the stored copy could not be opened';
    }
  return sheetPdf('Record of acceptance', `Record of acceptance ${r.id}`, (s) => {
    s.h2('What was accepted');
    s.kv('Terms', v.title);
    s.kv('Written by', v.account_name || (account ? `${account} (the account's name now: versions published before the name was kept with them do not say what it was then)` : '-'));
    s.kv('Version', `${v.number}, published ${stamp(v.published_at)}${v.note ? `. What changed: ${v.note}` : ''}`);
    s.kv('SHA-256 of the terms', v.terms_sha256);
    if (r.via !== 'api') {
      // What the browser reported, never more: this server sees what a browser sends, not a screen or a hand.
      s.kv('How it was accepted', `The page reported that the box "${v.checkbox}" was ticked and the button "${v.button}" was pressed. This server cannot see a screen: this is what the browser, or a program acting as one, sent it.`);
      s.kv('Scrolling', v.scroll ? `The page asked for the terms to be scrolled to the end first${r.scrolled ? ', and the browser reported that they were' : ''}.` : 'Not asked for.');
    }
    s.h2('Who, as given');
    s.kv('Name', r.name || '-');
    s.kv('Email', r.email || '-');
    s.kv('Their id at the website', r.person_id || '-');
    s.kv('Where these came from', IDENTITY_LABEL[r.identity as Identity] || r.identity);
    s.h2('When and where');
    s.kv('Accepted', stamp(r.at));
    s.kv('How', VIA_LABEL[r.via as Via] || r.via);
    s.kv('Page', r.page_url ? `${r.page_url} (as the ${r.via === 'api' ? 'website said' : 'browser reported it'})` : '-');
    s.kv(r.via === 'api' ? 'Address of the website' : 'Internet address', r.ip || '-');
    s.kv(r.via === 'api' ? 'Program of the website' : 'Browser', r.ua || '-');
    if (r.via === 'api') {
      s.kv('Visitor address, as given', r.given_ip || '-');
      s.kv('Visitor browser, as given', r.given_ua || '-');
      s.kv('Recorded by', r.recorded_by || '-');
    } else {
      s.kv('Open before the press', r.shown_ms == null ? '-' : `${Math.round(r.shown_ms / 1000)} seconds between when this server handed out the terms and when it received the press. That is how long the page was open, not that anyone read it.`);
      s.kv('Terms handed out to', r.view_match ? VIEW_MATCH_LABEL[r.view_match] : 'Not recorded: this acceptance is from before it was kept.');
      s.kv('Button covered?', coverLine(r.via, r.unobscured));
    }
    s.h2('What this record shows');
    s.text(words.shows, { size: 9, gap: 4 });
    s.text(words.not, { size: 9, gap: 4 });
    s.text(CLICK_LAW, { size: 9, gap: 4 });
    s.h2('Seal');
    s.kv('Record ID', r.id);
    s.kv('Seal', r.seal);
    s.kv('State', ok ? 'Unchanged since it was recorded: the seal still fits every line above.' : 'CHANGED: this record no longer fits its seal. Something changed it after it was written. Do not rely on it.');
    s.h2('The terms as shown');
    if (v.format === 'text') for (const para of termsPlain(v.body || '').split('\n')) s.text(para || ' ', { size: 8.5, gap: 1 });
    else s.text(`The terms were a PDF of ${v.pages || 'several'} page${v.pages === 1 ? '' : 's'}. ${terms ? 'They follow this page, exactly as they were stored' : !cw ? 'They are no longer stored' : `They could not be read from storage when this record was made (${unread}), so they are not in this file. The people who run this server have been told. Ask for this record again later`} (SHA-256 above).`, { size: 9 });
  }, terms ? async (doc) => {
    for (const p of await doc.copyPages(terms!, terms!.getPageIndices())) doc.addPage(p);
  } : undefined);
}

// ---- The copy by email -----------------------------------------------------------------------------------------------
// Nothing a visitor or a stranger types ever reaches an inbox under our name. So a copy goes only to an address the
// website put in the link it signed (it vouched for it): an address typed on the page is anybody's, and a copy would
// be a way to make us write to a stranger under a customer's name. Only on the person's request (their browser holds
// the receipt), and once for each acceptance, ever. Never while the account is paused or closing, or while what the
// copy carries reads like a fake payment notice. For an account the checks apply to, the people reached this way in a
// day count against a limit of their own, as visitors of a public form do. Our stored copy carries the agreement in
// about_user ("clickwrap:<id>") so it goes when the account is deleted (forgetClickwraps).
const masked = (email: string) => {
  const [user, domain] = String(email).split('@');
  return `${user.slice(0, 1)}***@${domain}`;
};
export const COPY_ELSEWHERE = 'Download the copy instead: it is the same record, with the terms.';
export function copyClaim(r: any): { status: number; code: string; message: string } | null {
  if (r.identity !== 'website') return { status: 409, code: 'not_vouched', message: `We email a copy only to an address the website gave us in its signed link. This one was typed on the page, and we cannot know that it is yours, so we do not write to it. ${COPY_ELSEWHERE}` };
  if (!r.email) return { status: 409, code: 'no_email', message: `No email address was given with this acceptance, so there is nowhere to send a copy. ${COPY_ELSEWHERE}` };
  const cw = get('SELECT * FROM clickwraps WHERE id=?', r.clickwrap_id);
  const v = get('SELECT * FROM clickwrap_versions WHERE id=?', r.version_id);
  const account = get('SELECT * FROM accounts WHERE id=?', r.account_id);
  // What the copy carries is read as the page is: the terms of the accepted version, the words shown with them, the
  // account's name and the details the website signed in.
  const file = v?.format === 'pdf' ? withKeptText(get('SELECT id, text, text_sealed, scan_pages FROM files WHERE sha256=? AND account_id=? LIMIT 1', v.file_sha256, r.account_id)) : null;
  if (!cw || !v || !account || account.suspended_at || account.closing_at
    || termsRefusal(account, v.title, v.format === 'text' ? termsPlain(v.body) : file?.text || '', v.format === 'pdf' && isScan(file), [...shownWords(cw, v), r.name, r.email, r.person_id]))
    return { status: 409, code: 'closed', message: `We cannot send a copy by email right now. Nothing was sent. ${COPY_ELSEWHERE}` };
  const had = get('SELECT at FROM clickwrap_copies WHERE acceptance_id=?', r.id);
  if (had) return { status: 409, code: 'copy_sent', message: `A copy of this acceptance was emailed to ${masked(r.email)} on ${stamp(had.at)}. We send one copy for each acceptance. ${COPY_ELSEWHERE}` };
  if (hasNotPaid(account)) {
    const have = all("SELECT DISTINCT lower(email) e FROM reached WHERE account_id=? AND via='clickwrap' AND at > ?", r.account_id, new Date(Date.now() - 864e5).toISOString()).map((x) => x.e);
    if (!have.includes(r.email.toLowerCase()) && have.length >= dailyCap(account).cap)
      return { status: 429, code: 'copies_today', message: `We cannot send more copies by email for this organisation today. Nothing was sent. ${COPY_ELSEWHERE}` };
  }
  // Taken in one step with nothing in between that waits, so two presses at the same moment send one copy.
  if (!run('INSERT OR IGNORE INTO clickwrap_copies (acceptance_id, at) VALUES (?,?)', r.id, now()).changes)
    return { status: 409, code: 'copy_sent', message: `A copy of this acceptance was already sent. ${COPY_ELSEWHERE}` };
  if (hasNotPaid(account)) noteReached({ account_id: r.account_id }, [r.email], 'clickwrap');
  return null;
}
export async function emailCopy(r: any): Promise<{ status: string; to: string }> {
  const cw = get('SELECT * FROM clickwraps WHERE id=?', r.clickwrap_id);
  const v = get('SELECT * FROM clickwrap_versions WHERE id=?', r.version_id);
  const account = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', r.account_id);
  const by = v.account_name || account?.name || 'a GrowSigning customer';
  const words = recordShows(r.identity, r.via);
  const status = await sendMail({
    to: r.email, about: `clickwrap:${cw.id}`, subject: `Your copy: ${v.title}`, heading: `What you accepted: ${v.title}`, fromName: account?.name,
    brand: { name: account?.name, color: account?.brand_color, logo: account?.brand_logo },
    lines: [`On ${stamp(r.at)} someone using a browser at ${r.ip || 'an unknown address'} accepted version ${v.number} of "${v.title}" from ${by}, with the name ${r.name ? `"${r.name}"` : 'left out'} and this email address, which ${by} gave us in its link to these terms, and asked for a copy here.`,
      'The terms and the full record are in the attached PDF.', `Fingerprint (SHA-256) of the terms: ${v.terms_sha256}`, words.shows, words.not,
      `We send one copy for each acceptance, only when it is asked for on the page, and only to an address the website gave us. If you did not accept these terms, tell ${by}: they put your address in the link. If this looks like a scam, report the page with the link below.`],
    links: [{ label: 'Report this page', url: `${pageUrl(cw.slug)}?report=1` }],
    attachments: [{ filename: `acceptance-${r.id}.pdf`, content: Buffer.from(await certificatePdf(r)) }],
  });
  return { status, to: masked(r.email) };
}

// ---- CSV -------------------------------------------------------------------------------------------------------------
// A name a visitor typed can start with "=" and run as a formula in a spreadsheet. Such a cell gets a ' in front.
const cell = (v: any) => {
  const s = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};
export const CSV_HEAD = ['acceptance_id', 'agreement', 'version', 'terms_sha256', 'accepted_at', 'identity', 'person_id', 'name', 'email', 'via', 'page_url', 'ip', 'browser', 'visitor_ip_as_given', 'visitor_browser_as_given', 'seconds_open', 'scrolled', 'button_uncovered', 'recorded_by', 'intact', 'terms_handed_to'];
export function csvOf(rows: any[]): string {
  const yes = (b: any) => (b == null ? '' : b ? 'yes' : 'no');
  return '﻿' + [CSV_HEAD.map(cell).join(','), ...rows.map((r) => {
    const a = acceptanceView(r);
    return [a.id, a.agreement, a.version, a.terms_sha256, a.accepted_at, a.identity, a.person.id, a.person.name, a.person.email, a.via, a.page_url, a.ip, a.user_agent, a.given_ip, a.given_user_agent, a.seconds_open, yes(a.scrolled), yes(a.button_uncovered), a.recorded_by, yes(a.intact), a.terms_handed_to].map(cell).join(',');
  })].join('\r\n');
}

// ---- Deleting ------------------------------------------------------------------------------------------------------
// The agreements, versions and acceptances go with the account (ON DELETE CASCADE). What does not hang on it in the
// database is removed here: our stored copies of the emails that sent people a copy of what they accepted. Called
// from purgeUser in routes-trust.ts, inside its transaction and before the account row is deleted. With a mail server
// set up, each copy's certificate PDF (the person's name, address and internet address) waits in the file store for
// a later try: the answer is those files, for removeUnusedBlobs once the transaction is done.
export function forgetClickwraps(accountId: string): string[] {
  const where = "envelope_id IS NULL AND about_user IN (SELECT 'clickwrap:' || id FROM clickwraps WHERE account_id=?)";
  const shas = attachedFiles(all(`SELECT payload FROM emails WHERE ${where}`, accountId));
  run(`DELETE FROM emails WHERE ${where}`, accountId);
  return shas;
}
/** The stored files attached to these emails (sendMail keeps them by fingerprint in the payload). */
export const attachedFiles = (rows: { payload: string | null }[]): string[] => rows.flatMap((r) => {
  try {
    return (JSON.parse(r.payload || '{}').attachments || []).map((a: any) => String(a.sha256 || '')).filter(Boolean);
  } catch {
    return [];
  }
});

export { TERMS_MAX_CHARS, NAME_MAX, LABEL_MAX };
