// Signing at a service counter (research/government.json, G18). Many people sign in front of an official, not at
// home. This builds on signing in person: the envelope comes from a template the agency marked for the counter, its
// person "signs in person", and the official records, with their own login, what they checked and what help they gave.
//
//   - The counter permission (counter_staff) is given by an admin, one person at a time, in Settings, Team. Nobody
//     has it until then, admins included, so nothing of this appears in an account that does not use it.
//   - A visit (counter_visits) is one person with one official. Until the official has recorded how they know who
//     is in front of them, the signing page of that person opens nothing (counterGate, called from look() in
//     routes-sign.ts), on any device.
//   - What the official states is theirs: it is an audit line in their name and a line on the certificate that says
//     it is their statement. GrowSigning cannot look at an identity document (CANNOT_CHECK_ID in src/lib/counter.ts).
//   - The person's own screen (a tablet facing them) is connected by a short code or its QR code: one use, ten
//     minutes. That screen holds a cookie for this one visit and nothing else, and once the person has finished it
//     is never given their signing link again. "Next person" clears it.
//   - A picture of the ID document is kept only when the account switched that on, and the switch only exists when
//     stored files are encrypted (FILE_ENCRYPTION_KEY). The picture is kept encrypted in the visit's row, so it goes
//     with the envelope, and it is in the evidence pack.
import crypto from 'node:crypto';
import { type Ctx } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { bad, id, now, sha256, str, rateLimit, baseUrl, HttpError, token as newToken } from './util.ts';
import { cookie, readCookie } from './auth.ts';
import { audit, signUrl, type Actor } from './envelopes.ts';
import { keys as fileKeyring } from './filestore.ts';
import { sealFile, openFile } from './filecrypt.ts';
import { sameEmail } from './credits.ts';
import { clearHand } from './handlive.ts';
import { isWitness } from '../lib/witness.ts';
import { ownCopyRow } from './visibility.ts';
import {
  CANNOT_CHECK_ID, ID_STATEMENT, HELPS, HELP_KINDS, helpStatement, behalfSecond, PAIR_ALPHABET, PAIR_LENGTH, PAIR_MINUTES, SCREEN_PATH,
  cleanCode, cleanLast, idWords, ID_DOC_TYPES, receiptCheckLine, type HelpKind,
} from '../lib/counter.ts';

export const SCREEN_COOKIE = 'ts_counter';
const SCREEN_HOURS = 4;
const SCAN_MAX = 6 * 1024 * 1024;
const SCAN_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

// ---- Settings and the permission --------------------------------------------------------------------------------

export type CounterSettings = { contact: string; official_may_witness: boolean; id_scans: boolean };
export function settingsOf(accountId: string): CounterSettings {
  const s = get('SELECT * FROM counter_settings WHERE account_id=?', accountId);
  return { contact: s?.contact || '', official_may_witness: !!s?.official_may_witness, id_scans: !!s?.id_scans && scansPossible() };
}

/** A picture of an ID document can only be kept encrypted: without a working file key the switch does not exist. */
export const scansPossible = (): boolean => {
  const k = fileKeyring();
  return !!k.current && !k.badCurrent;
};

export const isStaff = (accountId: string, userId: string): boolean => !!get('SELECT 1 x FROM counter_staff WHERE account_id=? AND user_id=?', accountId, userId);

/** For GET /me: { counter: true } for a person with the counter permission in this account, nothing otherwise. */
export function counterMe(c: Ctx): { counter?: true } {
  return c.auth?.via === 'session' && c.account && c.user && isStaff(c.account.id, c.user.id) ? { counter: true } : {};
}

/** The counter is for a person at a desk: an official signed in, with the permission. Never an API key. */
export function assertStaff(c: Ctx) {
  if (c.auth?.via !== 'session') throw bad('The counter is for an official signed in to the app, not for an API key. Sign in as that official to use it.', 403);
  if (!isStaff(c.account.id, c.user.id)) throw bad('You do not have the counter permission in this account. Ask an admin to give it to you in Settings, Team, More options.', 403, { code: 'not_counter_staff' });
}

/** Templates usable at the counter: marked by an admin, still in this account, with someone who signs in person. */
export function counterTemplates(accountId: string): any[] {
  return all(`SELECT e.id, e.subject, ct.show_values FROM counter_templates ct JOIN envelopes e ON e.id=ct.template_id
    WHERE ct.account_id=? AND e.account_id=? AND e.kind='template' ORDER BY e.subject COLLATE NOCASE`, accountId, accountId)
    .map((t: any) => ({ id: t.id, subject: t.subject || 'Untitled template', show_values: !!t.show_values }));
}

export function hasInPerson(templateId: string): boolean {
  return !!get("SELECT 1 x FROM recipients WHERE envelope_id=? AND role='inperson'", templateId);
}

// ---- Visits ----------------------------------------------------------------------------------------------------

const actorOf = (c: Ctx): Actor => c.actor;
const officialName = (c: Ctx) => str(c.user?.name || c.user?.email, 120);

/** The in-person signers still waiting on the account's counter envelopes, oldest first, and today's finished ones. */
export function queue(accountId: string, userId = '') {
  const rows = all(`SELECT e.id envelope_id, e.subject, e.sent_at, r.id recipient_id, r.name, r.status, r.completed_at,
      (SELECT v.id FROM counter_visits v WHERE v.recipient_id=r.id AND v.closed_at IS NULL ORDER BY v.created_at DESC LIMIT 1) visit_id
    FROM envelopes e JOIN counter_templates ct ON ct.template_id=e.template_id AND ct.account_id=e.account_id
    JOIN recipients r ON r.envelope_id=e.id AND r.role='inperson'
    WHERE e.account_id=? AND e.kind='envelope' AND e.hidden_at IS NULL AND e.purged_at IS NULL
      AND ((e.status='sent' AND r.status IN ('sent','viewed','pending')) OR (r.status='completed' AND r.completed_at > ?))
    ORDER BY e.sent_at LIMIT 200`, accountId, new Date(Date.now() - 864e5).toISOString());
  const visit = (vid: string | null) => (vid ? get('SELECT official_name, official_id, id_at FROM counter_visits WHERE id=?', vid) : null);
  const line = (x: any) => {
    const v = visit(x.visit_id);
    return { envelope_id: x.envelope_id, recipient_id: x.recipient_id, subject: x.subject, name: x.name, sent_at: x.sent_at, completed_at: x.completed_at, visit_id: x.visit_id,
      with: v?.official_name || null, mine: !!v && v.official_id === userId, waiting_second: !!x.visit_id && !!get('SELECT 1 x FROM counter_helps WHERE visit_id=? AND kind=? AND withdrawn_at IS NULL AND second_at IS NULL', x.visit_id, 'behalf') };
  };
  return { waiting: rows.filter((x: any) => x.status !== 'completed').map(line), finished: rows.filter((x: any) => x.status === 'completed').map(line) };
}

/** A visit of this account, with its envelope and person. 404 for anything else. */
export function visitFor(c: Ctx, visitId: string) {
  const v = get('SELECT * FROM counter_visits WHERE id=? AND account_id=?', str(visitId, 80), c.account.id);
  if (!v) throw bad('That visit is not in this account. Go back to the Counter and choose the person from the list.', 404);
  const e = get('SELECT * FROM envelopes WHERE id=?', v.envelope_id);
  const r = get('SELECT * FROM recipients WHERE id=? AND envelope_id=?', v.recipient_id, v.envelope_id);
  if (!e || !r) throw bad('The document of this visit is gone. Go back to the Counter and start again.', 410);
  return { v, e, r };
}

/** "Start": the person in front of the official, on an envelope of the counter that waits for them. */
export function openVisit(c: Ctx, envelopeId: string, recipientId?: string) {
  assertStaff(c);
  const e = get(`SELECT e.* FROM envelopes e JOIN counter_templates ct ON ct.template_id=e.template_id AND ct.account_id=e.account_id
    WHERE e.id=? AND e.account_id=? AND e.kind='envelope'`, str(envelopeId, 80), c.account.id);
  if (!e) throw bad('That document is not one of the counter. Choose a person from the list, or start a new one from a counter template.', 404);
  if (e.status !== 'sent') throw bad('That document is no longer out for signing. Choose another person from the list.', 409);
  const r = recipientId ? get("SELECT * FROM recipients WHERE id=? AND envelope_id=? AND role='inperson'", str(recipientId, 80), e.id)
    : get("SELECT * FROM recipients WHERE envelope_id=? AND role='inperson' AND status!='completed' ORDER BY routing_order, position LIMIT 1", e.id);
  if (!r) throw bad('Nobody on that document signs in person. Choose another person from the list.', 404);
  if (r.status === 'completed') throw bad(`${r.name} has already signed this document. Print the receipt from Finished today.`, 409);
  return tx(() => {
    const open = get('SELECT * FROM counter_visits WHERE recipient_id=? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1', r.id);
    if (open && open.official_id === c.user.id) return open.id as string;
    // Another official had them: this one takes over, and what that one recorded does not carry over.
    if (open) {
      run('UPDATE counter_visits SET closed_at=? WHERE id=?', now(), open.id);
      run('UPDATE counter_screens SET ended_at=? WHERE visit_id=? AND ended_at IS NULL', now(), open.id);
      audit(e.id, actorOf(c), 'Counter visit taken over', `${officialName(c)} took over from ${open.official_name}. What ${open.official_name} recorded stays in this trail and does not count for this visit.`);
    }
    const vid = id('cv');
    run('INSERT INTO counter_visits (id, account_id, envelope_id, recipient_id, official_id, official_name, created_at) VALUES (?,?,?,?,?,?,?)', vid, c.account.id, e.id, r.id, c.user.id, officialName(c), now());
    audit(e.id, actorOf(c), 'Counter visit started', `${r.name} at the counter with ${officialName(c)}.`);
    return vid;
  });
}

const openVisitOf = (recipientId: string) => get('SELECT * FROM counter_visits WHERE recipient_id=? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1', recipientId);
const helpsOf = (visitId: string): any[] => all('SELECT * FROM counter_helps WHERE visit_id=? AND withdrawn_at IS NULL ORDER BY at', visitId);

function assertMine(c: Ctx, v: any, r: any) {
  if (v.closed_at) throw bad('Another official took this person over, so this visit is closed. Go back to the Counter.', 409, { code: 'visit_closed' });
  if (v.official_id !== c.user.id) throw bad(`${v.official_name} is with this person. Press Start on their line to take them over.`, 409, { code: 'not_your_visit' });
  if (r.status === 'completed') throw bad(`${r.name} has already finished, so nothing more can be recorded for this signing. Print the receipt.`, 409, { code: 'finished' });
}

/** The official records how they know who is in front of them, and states it with their own login. */
export function recordIdentity(c: Ctx, visitId: string, b: any) {
  assertStaff(c);
  const { v, e, r } = visitFor(c, visitId);
  assertMine(c, v, r);
  if (b?.attest !== true) throw bad(`Tick "${ID_STATEMENT}" to record the check. It is your statement, in your name.`);
  const method = str(b?.method, 20);
  let doc = '', last = '', country = '';
  if (method === 'document') {
    const type = str(b?.doc_type, 60).trim();
    doc = type === 'Other' || !(ID_DOC_TYPES as readonly string[]).includes(type) ? str(b?.doc_other, 60).trim() : type;
    if (!doc) throw bad('Say which kind of document you saw. Choose one, or choose Other and type its name.');
    last = cleanLast(b?.last4) || '';
    if (!last) throw bad('Type the last 4 letters or digits of the document number. Only those 4 are kept.');
    country = str(b?.country, 60).trim();
    if (!country) throw bad('Type the country or authority that issued the document.');
  } else if (method === 'eid') {
    throw bad('Checking an eID is not set up on this server. Choose an identity document, or "I know this person".');
  } else if (method !== 'known') throw bad('Choose how you know who this is: an identity document you saw, or that you know them.');
  const words = idWords({ id_method: method, id_doc_type: doc, id_last4: last, id_country: country });
  tx(() => {
    run('UPDATE counter_visits SET id_method=?, id_doc_type=?, id_last4=?, id_country=?, id_at=? WHERE id=?', method, doc || null, last || null, country || null, now(), v.id);
    audit(e.id, actorOf(c), 'Identity checked at the counter', `${officialName(c)} stated: "${ID_STATEMENT}" For ${r.name}: ${words} ${CANNOT_CHECK_ID}`);
  });
  return { ok: true };
}

/** A picture of the ID document, only when the account keeps them (and so only with encrypted files). */
export async function storeScan(c: Ctx, visitId: string) {
  assertStaff(c);
  const { v, e, r } = visitFor(c, visitId);
  assertMine(c, v, r);
  if (!settingsOf(c.account.id).id_scans) throw bad('This account does not keep pictures of ID documents. Record what you saw in words instead.', 403);
  const k = fileKeyring();
  if (!k.current) throw bad('Pictures of ID documents can only be kept encrypted, and stored files are not encrypted on this server. Record what you saw in words instead.', 503);
  const form = await c.req.formData().catch(() => null);
  const f = form?.get('file');
  if (!f || typeof f === 'string') throw bad('Choose the picture or PDF of the document to keep.');
  const type = SCAN_TYPES[(f as File).type];
  if (!type) throw bad('Keep a JPEG or PNG picture, or a PDF. Other kinds of file are not kept.');
  if ((f as File).size > SCAN_MAX) throw bad(`That file is larger than ${SCAN_MAX / 1048576} MB. Take a smaller picture and try again.`);
  const plain = new Uint8Array(await (f as File).arrayBuffer());
  const sha = sha256(plain);
  const sealed = sealFile(plain, sha, k.current);
  run('UPDATE counter_visits SET id_scan=?, id_scan_type=? WHERE id=?', sealed, `${(f as File).type};${sha}`, v.id);
  audit(e.id, actorOf(c), 'Picture of the ID document kept', `${officialName(c)} kept a picture of the document ${r.name} showed, encrypted, SHA-256 ${sha}. It is in the evidence pack.`);
  return { ok: true, sha256: sha };
}

function scanOf(v: any): { data: Buffer; ext: string; sha: string } | null {
  if (!v?.id_scan || !v.id_scan_type) return null;
  const [type, sha] = String(v.id_scan_type).split(';');
  try {
    return { data: openFile(Buffer.from(v.id_scan), sha, fileKeyring()).data, ext: SCAN_TYPES[type] || 'bin', sha };
  } catch {
    return null;
  }
}

/** Help with signing. Each is the official's statement in their name, and a line on the certificate. */
export function addHelp(c: Ctx, visitId: string, b: any) {
  assertStaff(c);
  const { v, e, r } = visitFor(c, visitId);
  assertMine(c, v, r);
  const kind = str(b?.kind, 20) as HelpKind;
  if (!HELP_KINDS.includes(kind)) throw bad('Choose the help you gave: a mark, someone signing for them, reading aloud, or an interpreter.');
  if (b?.attest !== true) throw bad('Tick the statement to record it. It is your statement, in your name.');
  if (helpsOf(v.id).some((h) => h.kind === kind)) throw bad(`"${HELPS[kind].label}" is already recorded for this person. Take it back first to record it again.`, 409);
  const language = str(b?.language, 60).trim();
  const interpreter = str(b?.interpreter, 120).trim();
  if ((kind === 'read_aloud' || kind === 'interpreter') && !language) throw bad('Type the language. It is written on the certificate.');
  if (kind === 'interpreter' && !interpreter) throw bad("Type the interpreter's full name. It is written on the certificate.");
  if (kind === 'mark') assertWitnessFor(c.account.id, e.id, r, c.user);
  if (kind === 'behalf' && helpsOf(v.id).some((h) => h.kind === 'mark')) throw bad('A mark and someone signing for them cannot both be recorded. Take one back first.', 409);
  if (kind === 'mark' && helpsOf(v.id).some((h) => h.kind === 'behalf')) throw bad('A mark and someone signing for them cannot both be recorded. Take one back first.', 409);
  const said = helpStatement(kind, { p: r.name, language, interpreter });
  const hid = id('ch');
  tx(() => {
    run('INSERT INTO counter_helps (id, visit_id, kind, language, interpreter, by_id, by_name, at) VALUES (?,?,?,?,?,?,?,?)', hid, v.id, kind, language || null, interpreter || null, c.user.id, officialName(c), now());
    audit(e.id, actorOf(c), `Counter: ${HELPS[kind].label}`, `${officialName(c)} stated: "${said}"${kind === 'behalf' ? ' A second official has to confirm it before the document can be finished.' : ''}`);
  });
  return { ok: true, id: hid };
}

/** The second official, with their own login, confirms that they heard the person ask someone to sign for them. */
export function confirmHelp(c: Ctx, visitId: string, helpId: string, b: any) {
  assertStaff(c);
  const { v, e, r } = visitFor(c, visitId);
  if (v.closed_at || r.status === 'completed') throw bad('This visit is over, so nothing more can be confirmed. Go back to the Counter.', 409);
  const h = get('SELECT * FROM counter_helps WHERE id=? AND visit_id=? AND withdrawn_at IS NULL', str(helpId, 80), v.id);
  if (!h || h.kind !== 'behalf') throw bad('There is nothing to confirm on this visit. Go back to the Counter.', 404);
  if (h.second_at) throw bad(`${h.second_name} has already confirmed it.`, 409);
  if (h.by_id === c.user.id) throw bad('A second official has to confirm this, with their own login. Ask a colleague with the counter permission to confirm it on their device.', 403, { code: 'same_official' });
  if (b?.attest !== true) throw bad('Tick the statement to confirm it. It is your statement, in your name.');
  const said = behalfSecond(r.name, h.by_name);
  tx(() => {
    run('UPDATE counter_helps SET second_id=?, second_name=?, second_at=? WHERE id=? AND second_at IS NULL', c.user.id, officialName(c), now(), h.id);
    audit(e.id, actorOf(c), 'Counter: second official confirmed', `${officialName(c)} stated: "${said}"`);
  });
  return { ok: true };
}

/** Taking back help recorded by mistake, before the person finishes. The trail keeps both lines. */
export function withdrawHelp(c: Ctx, visitId: string, helpId: string) {
  assertStaff(c);
  const { v, e, r } = visitFor(c, visitId);
  assertMine(c, v, r);
  const h = get('SELECT * FROM counter_helps WHERE id=? AND visit_id=? AND withdrawn_at IS NULL', str(helpId, 80), v.id);
  if (!h) throw bad('That help is not recorded on this visit. Reload the page to see what is.', 404);
  tx(() => {
    run('UPDATE counter_helps SET withdrawn_at=? WHERE id=?', now(), h.id);
    audit(e.id, actorOf(c), 'Counter: help taken back', `${officialName(c)} took back "${HELPS[h.kind as HelpKind]?.label || h.kind}", recorded by mistake. It is not on the certificate.`);
  });
  return { ok: true };
}

// The witness of someone who signs with a mark: the existing witness role, for this person. The official may be
// that witness only where the account's rules allow it (counter_settings.official_may_witness).
function witnessOfSigner(envelopeId: string, r: any) {
  return all("SELECT * FROM recipients WHERE envelope_id=? AND role='witness' AND witness_for=?", envelopeId, r.id)[0] || null;
}
function assertWitnessFor(accountId: string, envelopeId: string, r: any, official: { id: string; name?: string; email?: string } | null) {
  const w = witnessOfSigner(envelopeId, r);
  if (!w || !isWitness(w)) throw bad(`Signing with a mark needs a witness for ${r.name} on the document. Use a counter template with a witness for the person who signs in person.`, 409, { code: 'no_witness' });
  if (official && !settingsOf(accountId).official_may_witness) {
    const o = get('SELECT name, email FROM users WHERE id=?', official.id) || official;
    if (sameEmail(w.email, o.email)) throw bad(`Your account's rules say the official may not be the witness, and the witness on this document is you. Ask a colleague or another person to be the witness.`, 409, { code: 'official_is_witness' });
  }
  return w;
}

// ---- Gates on the signing page ------------------------------------------------------------------------------------

/**
 * Called from look() in routes-sign.ts for every signing request. A person at the counter whose official has not
 * yet recorded the identity check sees nothing of the document, on any device.
 */
export function counterGate(e: any, r: any) {
  if (r?.role !== 'inperson' || r.status === 'completed' || e?.status !== 'sent') return;
  const v = openVisitOf(r.id);
  if (v?.id_at) return;
  // A counter document opens only through a visit: also one sent the ordinary way, or opened from the official's own
  // "Host an in-person signing" email before anyone pressed Start.
  if (v || isCounterEnvelope(e, r)) throw new HttpError(423, COUNTER_WAIT, { code: 'counter_id_first' });
}

/** What the signing page says while it waits for the official (src/components/counter/CounterWait.tsx shows it). */
export const COUNTER_WAIT = 'This document is signed at a service counter. It opens once the official has pressed Start on the Counter and recorded who is signing. Please wait for them: this page opens by itself.';

/** An in-person signer of a document from a counter template, or of one an official has already worked on. */
export function isCounterEnvelope(e: any, r: any): boolean {
  if (r?.role !== 'inperson') return false;
  if (get('SELECT 1 x FROM counter_visits WHERE recipient_id=? LIMIT 1', r.id)) return true;
  return !!e?.template_id && !!get('SELECT 1 x FROM counter_templates WHERE template_id=? AND account_id=?', e.template_id, e.account_id);
}

/**
 * Called by completeRecipient (envelopes.ts) once the person's Finish is recorded, before any email goes out. The link
 * that was open on the counter screen or the official's device stays in that browser's history, so it stops working
 * here, and the completed email carries a new one that only the person has.
 */
export function counterFinished(e: any, r: any) {
  if (r?.role !== 'inperson' || !get('SELECT 1 x FROM counter_visits WHERE recipient_id=? LIMIT 1', r.id)) return;
  run('UPDATE recipients SET token=? WHERE id=?', newToken(), r.id);
  audit(e.id, { name: 'System' }, 'Counter link closed', `${r.name} finished at the counter. The signing link used there no longer opens the document, so the next person at the counter cannot open it. Their own copy is emailed to them with a new link.`);
}

/** Before Finish: someone signing for the person needs a second official, and a mark needs its witness. */
export function counterBeforeFinish(e: any, r: any) {
  if (r?.role !== 'inperson') return;
  const v = openVisitOf(r.id);
  if (!v) return;
  const hs = helpsOf(v.id);
  if (hs.some((h) => h.kind === 'behalf' && !h.second_at)) throw bad('A second official has to confirm that this person asked for someone to sign for them. Ask a colleague to confirm it on their device, then press Finish again.', 409, { code: 'counter_second_official' });
  const mark = hs.find((h) => h.kind === 'mark');
  if (mark) assertWitnessFor(v.account_id, e.id, r, { id: v.official_id });
}

/** For GET /sign/:token: what the person's own counter screen needs on the done screen. Absent everywhere else. */
// screen: this browser is the person's own counter screen. Present for any counter signer, so the done screen does not
// offer the old link's download (counterFinished closes it).
export function counterFacts(c: Ctx, e: any, r: any): { counter?: { screen: boolean; envelope_id: string } } {
  if (!isCounterEnvelope(e, r)) return {};
  const s = screenOf(c);
  return { counter: { screen: !!s && s.recipient_id === r?.id, envelope_id: e.id } };
}

// ---- The person's own screen ----------------------------------------------------------------------------------------

const newCode = (): string => Array.from({ length: PAIR_LENGTH }, () => PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)]).join('');
const codeHash = (code: string) => sha256(`counter-code:${code}`);

/** "Connect the person's screen": a new code for this visit. An earlier unused one stops working. */
export function makeCode(c: Ctx, visitId: string) {
  assertStaff(c);
  const { v, r } = visitFor(c, visitId);
  assertMine(c, v, r);
  rateLimit(`counter-code:${c.user.id}`, 60, 3600_000);
  const code = newCode();
  const at = now();
  const expires = new Date(Date.now() + PAIR_MINUTES * 60_000).toISOString();
  tx(() => {
    run('DELETE FROM counter_codes WHERE visit_id=? AND used_at IS NULL', v.id);
    run('INSERT INTO counter_codes (code_hash, visit_id, created_at, expires_at) VALUES (?,?,?,?)', codeHash(code), v.id, now(), expires);
  });
  return { code, created_at: at, expires_at: expires, url: `${baseUrl()}${SCREEN_PATH}?code=${code}` };
}

/** The person's screen types the code (or scans it). One use, ten minutes. */
export function pairScreen(c: Ctx, raw: unknown) {
  // Per address: tablets of a whole office often share one. 100 tries in 10 minutes against codes of 32^6 that live
  // 10 minutes still leaves guessing one hopeless.
  rateLimit(`counter-pair:${c.ip}`, 100, 600_000);
  const code = cleanCode(raw);
  if (!code) throw bad(`Type the ${PAIR_LENGTH} letters and digits the official's screen shows.`);
  const t = now();
  const hit = get('UPDATE counter_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at > ? RETURNING visit_id', t, codeHash(code), t);
  if (!hit) throw bad('That code does not work. It may be mistyped, used already, or older than 10 minutes. Ask the official for a new one.', 400, { code: 'bad_code' });
  const v = get('SELECT * FROM counter_visits WHERE id=?', hit.visit_id);
  if (!v || v.closed_at) throw bad('That code belonged to a visit that has ended. Ask the official for a new one.', 400, { code: 'bad_code' });
  // The screen's own token: random, kept only as its SHA-256 (id() in util.ts).
  const token = id('cs');
  run('UPDATE counter_screens SET ended_at=? WHERE visit_id=? AND ended_at IS NULL', t, v.id);
  run('INSERT INTO counter_screens (token_hash, visit_id, created_at) VALUES (?,?,?)', sha256(token), v.id, t);
  // The browser forgets who it was handed to before: a new person starts here (handlive.ts).
  clearHand(c);
  c.cookies.push(cookie(SCREEN_COOKIE, token, SCREEN_HOURS * 3600, c.secure));
  audit(v.envelope_id, { name: v.official_name, ip: c.ip, ua: c.ua }, "Person's own screen connected", 'A screen facing the person at the counter was connected with a one-use code.');
  return screenState(c, token);
}

function screenOf(c: Ctx, token?: string): any {
  const t = token || readCookie(c.req, SCREEN_COOKIE);
  if (!t) return null;
  const s = get('SELECT s.*, v.recipient_id, v.envelope_id, v.id_at, v.closed_at visit_closed FROM counter_screens s JOIN counter_visits v ON v.id=s.visit_id WHERE s.token_hash=? AND s.ended_at IS NULL AND s.created_at > ?', sha256(t), new Date(Date.now() - SCREEN_HOURS * 3600_000).toISOString());
  return s && !s.visit_closed ? s : null;
}

/** What the person's screen shows: nothing connected, wait for the official, the document, or finished. */
export function screenState(c: Ctx, token?: string): { state: 'none' | 'waiting' | 'ready' | 'done' | 'closed'; url?: string; name?: string } {
  const s = screenOf(c, token);
  if (!s) return { state: 'none' };
  const r = get('SELECT * FROM recipients WHERE id=?', s.recipient_id);
  const e = get('SELECT status FROM envelopes WHERE id=?', s.envelope_id);
  if (!r || !e) return { state: 'none' };
  if (r.status === 'completed') return { state: 'done' };
  // Declined, withdrawn or out of time: nothing was finished, and there is no receipt.
  if (e.status !== 'sent') return { state: 'closed' };
  if (!s.id_at) return { state: 'waiting', name: r.name };
  return { state: 'ready', url: signUrl(r), name: r.name };
}

/** "Next person": the screen is disconnected and forgets everything this server gave it. */
export function endScreen(c: Ctx) {
  const t = readCookie(c.req, SCREEN_COOKIE);
  if (t) run('UPDATE counter_screens SET ended_at=? WHERE token_hash=? AND ended_at IS NULL', now(), sha256(t));
  c.cookies.push(cookie(SCREEN_COOKIE, '', 0, c.secure));
  clearHand(c);
  return { ok: true };
}

/** The signing link for the official's own device ("Hand this device over"). The browser locks when it opens. */
export function handLink(c: Ctx, visitId: string) {
  assertStaff(c);
  const { v, e, r } = visitFor(c, visitId);
  assertMine(c, v, r);
  if (!v.id_at) throw bad('Record how you know who this is first. The document opens after that.', 409, { code: 'counter_id_first' });
  if (!r.token) throw bad('This document has no signing link yet. Go back to the Counter and start again.', 409);
  audit(e.id, actorOf(c), 'Signing link issued', `${r.name}, on the official's own device at the counter.`);
  return { url: signUrl(r) };
}

// ---- What the official sees ---------------------------------------------------------------------------------------

/** The visit as the official's screen shows it: progress, and what the person types only when the template allows it. */
export function visitView(c: Ctx, visitId: string) {
  assertStaff(c);
  const { v, e, r } = visitFor(c, visitId);
  const fields = all('SELECT id, type, label, value FROM fields WHERE envelope_id=? AND recipient_id=? ORDER BY page, y', e.id, r.id);
  const filled = fields.filter((f: any) => f.value != null && String(f.value) !== '').length;
  const showValues = !!get('SELECT show_values x FROM counter_templates WHERE template_id=?', e.template_id)?.x;
  const w = witnessOfSigner(e.id, r);
  const hs = helpsOf(v.id);
  return {
    visit: { id: v.id, official: v.official_name, mine: v.official_id === c.user.id, closed: !!v.closed_at, started_at: v.created_at },
    envelope: { id: e.id, subject: e.subject, status: e.status },
    person: { name: r.name, email: r.email, status: r.status, opened: !!r.viewed_at, agreed: !!r.consent_at, finished_at: r.completed_at },
    identity: v.id_at ? { method: v.id_method, doc_type: v.id_doc_type, last4: v.id_last4, country: v.id_country, at: v.id_at, words: idWords(v), picture: !!v.id_scan } : null,
    helps: hs.map((h: any) => ({ id: h.id, kind: h.kind, label: HELPS[h.kind as HelpKind]?.label || h.kind, language: h.language, interpreter: h.interpreter, by: h.by_name, by_me: h.by_id === c.user.id, second: h.second_name, needs_second: h.kind === 'behalf' && !h.second_at })),
    witness: w ? { name: w.name, status: w.status } : null,
    progress: { fields: fields.length, filled, ...(showValues ? { values: fields.map((f: any) => ({ label: f.label || f.type, value: f.type === 'signature' || f.type === 'initials' ? (f.value ? 'Signed' : '') : f.value || '' })) } : {}) },
    screen: !!get('SELECT 1 x FROM counter_screens WHERE visit_id=? AND ended_at IS NULL', v.id),
    screen_at: get('SELECT created_at x FROM counter_screens WHERE visit_id=? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1', v.id)?.x || null,
    settings: settingsOf(c.account.id),
  };
}

/** The receipt after Finish: what the person takes home. */
export function receipt(c: Ctx, visitId: string) {
  assertStaff(c);
  const { e, r } = visitFor(c, visitId);
  if (r.status !== 'completed') throw bad(`${r.name} has not finished yet, so there is no receipt. Print it once they have pressed Finish.`, 409);
  const a = get('SELECT name FROM accounts WHERE id=?', e.account_id);
  const s = settingsOf(e.account_id);
  const verify = `${baseUrl()}/verify`;
  return {
    agency: a?.name || '', contact: s.contact || null, subject: e.subject, name: r.name, envelope_id: e.id, signed_at: r.completed_at,
    // The fingerprint of the completed PDF exists once everyone on the document has finished.
    // A person shown only some of the files takes home the fingerprint of their own copy (visibility.ts).
    fingerprint: ownCopyRow(e, r.id)?.sha256 || e.final_sha256 || null, all_done: e.status === 'completed',
    copy: r.email ? `A copy of the completed document is emailed to ${r.email}${e.status === 'completed' ? '' : ' once everyone has signed'}.` : null,
    check: receiptCheckLine(verify, e.id),
    note: CANNOT_CHECK_ID,
  };
}

// ---- Certificate and evidence ---------------------------------------------------------------------------------------

/** The lines the certificate adds under a person who signed at the counter. [label, value] pairs. */
export function counterCertLines(e: any, r: any, ts: (s: any) => string): [string, string][] {
  if (r?.role !== 'inperson') return [];
  const v = get('SELECT * FROM counter_visits WHERE recipient_id=? AND closed_at IS NULL AND id_at IS NOT NULL ORDER BY created_at DESC LIMIT 1', r.id);
  if (!v) return [];
  const out: [string, string][] = [
    ['At the counter', `With the official ${v.official_name}`],
    ['ID seen by the official', idWords(v)],
    ["Official's statement", `"${ID_STATEMENT}" Stated by ${v.official_name} on ${ts(v.id_at)}. ${CANNOT_CHECK_ID}`],
  ];
  if (v.id_scan) out.push(['Picture of the ID', 'Kept encrypted by the agency, in the evidence pack.']);
  for (const h of helpsOf(v.id)) {
    const said = helpStatement(h.kind, { p: r.name, language: h.language, interpreter: h.interpreter });
    if (h.kind === 'behalf') out.push(['Signed for them', `Signed by ${h.by_name} for ${r.name}. ${h.by_name} stated: "${said}"${h.second_at ? ` ${h.second_name} stated: "${behalfSecond(r.name, h.by_name)}"` : ''}`]);
    else out.push([HELPS[h.kind as HelpKind]?.label || h.kind, `${h.by_name} stated: "${said}"`]);
  }
  return out;
}

/** Files for the evidence pack: what was recorded at the counter, and the ID picture when one was kept. */
export function counterEvidence(e: any): { files: { name: string; data: Buffer }[]; readme: string[] } {
  const visits = all('SELECT * FROM counter_visits WHERE envelope_id=? ORDER BY created_at', e.id);
  if (!visits.length) return { files: [], readme: [] };
  const files: { name: string; data: Buffer }[] = [];
  const lines = [`What officials recorded at the counter for "${e.subject}" (envelope ${e.id}). ${CANNOT_CHECK_ID}`, ''];
  for (const v of visits) {
    const r = get('SELECT name FROM recipients WHERE id=?', v.recipient_id);
    lines.push(`${r?.name || 'A person no longer on the document'}, with ${v.official_name}, started ${v.created_at}${v.closed_at ? `, taken over by another official on ${v.closed_at}` : ''}.`);
    lines.push(v.id_at ? `Identity: ${idWords(v)} Stated by ${v.official_name} on ${v.id_at}: "${ID_STATEMENT}"` : 'Identity: not recorded.');
    for (const h of all('SELECT * FROM counter_helps WHERE visit_id=? ORDER BY at', v.id)) {
      lines.push(`${HELPS[h.kind as HelpKind]?.label || h.kind}: stated by ${h.by_name} on ${h.at}: "${helpStatement(h.kind, { p: r?.name || 'the person', language: h.language, interpreter: h.interpreter })}"${h.second_at ? ` Confirmed by ${h.second_name} on ${h.second_at}.` : ''}${h.withdrawn_at ? ` Taken back on ${h.withdrawn_at}.` : ''}`);
    }
    const scan = scanOf(v);
    if (scan) {
      const name = `counter/id-document-${v.id.slice(-6)}.${scan.ext}`;
      files.push({ name, data: scan.data });
      lines.push(`Picture of the ID document: ${name}, SHA-256 ${scan.sha}.`);
    } else if (v.id_scan) lines.push('A picture of the ID document was kept, but it cannot be read with the keys this server has now.');
    lines.push('');
  }
  files.unshift({ name: 'counter.txt', data: Buffer.from(lines.join('\r\n')) });
  return { files, readme: [`counter.txt           what the official stated at the counter: how they knew who signed, and any help they gave. Their statements, not checked by GrowSigning.${files.length > 1 ? ' counter/ holds the picture of the ID document the agency kept.' : ''}`] };
}

/** On the timer: codes past their ten minutes go, and ID pictures go with documents that were purged. */
export function counterTick(): number {
  const t = now();
  const codes = run('DELETE FROM counter_codes WHERE expires_at < ?', new Date(Date.now() - 864e5).toISOString()).changes;
  const pics = run('UPDATE counter_visits SET id_scan=NULL WHERE id_scan IS NOT NULL AND envelope_id IN (SELECT id FROM envelopes WHERE purged_at IS NOT NULL)').changes;
  run('UPDATE counter_screens SET ended_at=? WHERE ended_at IS NULL AND created_at < ?', t, new Date(Date.now() - SCREEN_HOURS * 3600_000).toISOString());
  return Number(codes) + Number(pics);
}
