import crypto from 'node:crypto';
import { all, get, run, tx } from './db.ts';
import { bad, hmac, now, str, safeEqual, sha256, baseUrl } from './util.ts';
import { cookie, readCookie } from './auth.ts';
import { sendMail } from './mail.ts';
import { sendText, smsMode, phoneKey, textsLeft, numbersToday, linkTextsToday, textsRoomInHours, onTextOutcome, dropCodeTexts, onTextRetry, dropTexts } from './sms.ts';
import { audit, emailRefusal, hasNotPaid, dailyCap, signUrl, notifySender, senderOf, correctRecipient, loadEnvelope, samePerson, type Actor } from './envelopes.ts';
import { reporterKey } from './bysender.ts';
import { CHECKS, isCodeCheck, CHANNEL_WORDS, normalPhone, PHONE_HOW, maskPhone, maskEmail, checkLine, plainTime, SMS_OFF } from '../lib/checks.ts';
import { SIGNER_CODE_DIGITS, SIGNER_CODE_MINUTES, SIGNER_CODE_TRIES, SIGNER_CODE_WAIT_SECONDS, SIGNER_CODES_PER_HOUR, SIGNER_CODES_PER_CALLER_HOUR, SIGNER_CODES_PER_DESTINATION_DAY, LINK_TEXTS_PER_NUMBER_DAY, SIGNER_PASS_HOURS, smsDailyPerAccount } from '../lib/policy.ts';

// Checking who signs. A sender can ask that a recipient types a one-time code before the document opens for them: a
// code sent to their email address, or by text message to a mobile number the sender typed. This file holds all of
// it: what a recipient's check is and how it is saved and corrected, the code itself (made, sent, limited, checked,
// never stored), what a device that passed carries, the record for the certificate, and the texts that carry a
// signing link. envelopes.ts and routes-sign.ts call in here at the few places where a recipient is written, sent
// to, opened or passed on. Nothing in here calls into envelopes.ts while this module is being loaded, which is what
// lets the two files use each other.

const iso = (ms: number) => new Date(ms).toISOString();
const SYSTEM: Actor = { name: 'System' };
const sameAddress = (a: any, b: any) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const many = (n: number, one: string, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;
// Whether an email can reach anyone from this server: a mail server, or the outbox of a development machine.
const canEmail = () => !!process.env.SMTP_URL || process.env.NODE_ENV !== 'production' || process.env.DEV_OUTBOX === '1';
const CHECK_WORDS = (v: any) => (v === 'email_code' ? 'a one-time code by email' : v === 'sms_code' ? 'a one-time code by text message' : 'no extra check');
// Who is texted about an envelope: someone who is also sent the link by text (never an in-person signer, whose link
// goes to the sender), and someone whose code travels by text.
const texted = (r: any) => (!!r.text_link && r.role !== 'inperson') || r.verify === 'sms_code';

// ---- The record, and what a device that passed carries -------------------------------------------------

// A check is passed by one person, and never counts for another. The record of a passed check is tied to the link it
// was passed under and to the person on the request (person_gen, which goes up whenever the request passes to
// someone else, also to another person at the same address, who keeps the link). So it stops counting by itself the
// moment the link is replaced (the address was corrected, the role changed, the signer passed the document on) or
// another person takes the place at the same inbox. No code that swaps a person has to remember to clear it.
// (person_gen 0 adds nothing, so records made before it was part of the stamp still count.)
const gen = (r: any) => (Number(r.person_gen) > 0 ? `:p${Number(r.person_gen)}` : '');
const linkStamp = (r: any) => sha256(`check:${r.id}:${r.token}${gen(r)}`);

/** The record of a code typed correctly by whoever holds this link now, or null: how it was sent, to where (masked), and when. */
export const passedCheck = (r: any): { how: string; at: string } | null =>
  r?.checked_at && r.checked_how && r.token && r.checked_for === linkStamp(r) ? { how: r.checked_how, at: r.checked_at } : null;

// What the browser of someone who typed the right code is given, remembered the way a correct access code is (see
// POST /sign/:token/unlock): a cookie for this recipient that only the server can make. It names the link, the
// person, the kind of check and check_gen, which goes up whenever the sender changes the check or the number, so
// every one of those makes every device pass the check again. It also carries the moment the code was typed, signed
// with the rest: the server refuses it SIGNER_PASS_HOURS later, whatever the browser does, so a copied cookie stops
// working at the same moment, and two devices that passed never hold the same value.
const deviceStamp = (r: any) => hmac(`vc:${r.id}:${r.token}:${r.check_gen || 0}:${r.verify}${gen(r)}`);
const jar = (r: any) => `ts_vc_${r.id}`;
const passValue = (r: any, at: number) => `${at}.${hmac(`pass:${deviceStamp(r)}:${at}`)}`;
export const passCookie = (r: any, secure: boolean) => cookie(jar(r), passValue(r, Date.now()), SIGNER_PASS_HOURS * 3600, secure);

/** The one-time code this request still has to pass before the document opens, or null. */
export function gateOf(req: Request, r: any): 'email_code' | 'sms_code' | null {
  if (!isCodeCheck(r.verify)) return null;
  const held = readCookie(req, jar(r)) || '';
  const at = Number(held.split('.')[0]);
  // A minute of leeway for a clock that is a little ahead; never a moment further in the future than that.
  const fresh = Number.isInteger(at) && at <= Date.now() + 60_000 && Date.now() - at < SIGNER_PASS_HOURS * 3600_000;
  return fresh && safeEqual(held, passValue(r, at)) ? null : r.verify;
}

// Where a recipient's code goes: the address itself (never given out), how it is shown, and a keyed fingerprint to
// count by.
function destOf(r: any): { to: string | null; masked: string; key: string } {
  if (r.verify === 'sms_code') {
    const to = normalPhone(r.phone);
    return { to, masked: maskPhone(to || r.phone), key: phoneKey(to || String(r.phone || '')) };
  }
  return { to: r.email || null, masked: maskEmail(r.email), key: hmac(`mail:${String(r.email || '').trim().toLowerCase()}`).slice(0, 32) };
}

// The newest code made for this recipient, if it still counts: made for the link and the check as they are now,
// not used, not replaced, not run out.
function liveCode(r: any): any {
  const c = get('SELECT * FROM signer_codes WHERE recipient_id=? ORDER BY id DESC LIMIT 1', r.id);
  return c && !c.ended_at && c.expires_at > now() && c.stamp === deviceStamp(r) ? c : null;
}

// In how many seconds a new code can be asked for, and which of the two rules makes the person wait: one a minute,
// and SIGNER_CODES_PER_HOUR an hour.
function waitFor(r: any): { seconds: number; why: 'minute' | 'hour' | '' } {
  const t = Date.now();
  const rows = all('SELECT at, stamp FROM signer_codes WHERE recipient_id=? AND at > ? ORDER BY id DESC', r.id, iso(t - 3600_000));
  const last = rows.map((c) => Date.parse(c.at));
  const hour = last.length >= SIGNER_CODES_PER_HOUR ? Math.ceil((last[SIGNER_CODES_PER_HOUR - 1] + 3600_000 - t) / 1000) : 0;
  // The minute is counted from the last code for the check as it is now. When the sender has just corrected the
  // number or the check, or the document passed to someone else, nobody waits for a code that went elsewhere.
  const minute = rows.length && rows[0].stamp === deviceStamp(r) ? Math.ceil((last[0] + SIGNER_CODE_WAIT_SECONDS * 1000 - t) / 1000) : 0;
  return hour > 0 && hour >= minute ? { seconds: hour, why: 'hour' } : minute > 0 ? { seconds: minute, why: 'minute' } : { seconds: 0, why: '' };
}

/**
 * What GET /sign/:token answers while the document is still locked. For a recipient with no one-time code it is
 * what it always was. For one who has to pass a code it is less: no subject, no reason for a void, and the email
 * address only masked, because whoever holds a link must not learn from us where the code goes or what the document
 * is. `check` says what the screen needs to ask for the code and nothing about the code itself.
 */
export function lockedView(view: any, r: any, accessLocked: boolean, gate: string | null): any {
  if (!isCodeCheck(r.verify)) return view;
  const live = gate && !accessLocked ? liveCode(r) : null;
  return {
    ...view,
    envelope: { ...view.envelope, subject: '', void_reason: null },
    recipient: { ...view.recipient, email: maskEmail(r.email) },
    // The access code comes first when there is one: it costs nothing to ask for, and a stranger who has only the
    // link cannot make us send a text.
    needs: accessLocked ? 'access_code' : 'code',
    code_next: accessLocked && !!gate,
    check: !gate || accessLocked ? undefined : {
      kind: r.verify, to: destOf(r).masked, minutes: SIGNER_CODE_MINUTES, digits: SIGNER_CODE_DIGITS,
      sent: !!live, expires_in: live ? Math.max(0, Math.ceil((Date.parse(live.expires_at) - Date.now()) / 1000)) : 0,
      tries_left: live ? Math.max(0, SIGNER_CODE_TRIES - live.fails) : 0, resend_in: waitFor(r).seconds,
      // Someone using this link said the number is not theirs. No code goes to it until the sender has corrected it.
      stopped: r.verify === 'sms_code' && !!r.check_stop,
    },
  };
}

/** A copy of the envelope whose recipients each carry `check_line`: how they were checked, for the certificate. */
export const withCheckLines = (e: any) => ({ ...e, recipients: e.recipients.map((r: any) => ({ ...r, check_line: checkLine(r, passedCheck(r)) })) });

/**
 * What a sender is given about a recipient's check: "verify" always as one of the three words, "text_link" as yes or
 * no, and "check" with the sentence the certificate will carry. The columns that only the server needs are left out.
 */
export function publicCheck(r: any, token: string | null): any {
  const { check_gen: _g, checked_at, checked_how, checked_for, check_stop, texted_at: _t, ...rest } = r;
  const passed = passedCheck({ ...r, token, checked_at, checked_how, checked_for });
  return { ...rest, verify: isCodeCheck(r.verify) ? r.verify : 'none', phone: r.phone || null, text_link: !!r.text_link,
    check: { line: checkLine(r, passed), passed_at: passed?.at || null, stopped: !!check_stop } };
}

/** What became of every text about an envelope, for its sender. The number is only ever shown masked, and never the text. */
export const textsOf = (envelopeId: string) =>
  all('SELECT recipient_id, kind, to_masked "to", status, error, at, tries, tried_at, next_try_at FROM texts WHERE envelope_id=? ORDER BY id DESC LIMIT 60', envelopeId);

// ---- Saving a recipient's check -----------------------------------------------------------------------

type CheckValues = { verify: 'email_code' | 'sms_code' | null; phone: string | null; text_link: number };

// What a request asks a recipient's check to be. Whatever the request leaves out stays as it was, so a caller who
// knows nothing of checks changes none. `strict` is for an envelope that is already out: a number must then be
// complete. A draft may hold a half-typed one like a half-typed address: it is checked before anything is sent.
function readCheck(r: any, old: any, whom: string, strict: boolean): CheckValues {
  let verify: CheckValues['verify'] = isCodeCheck(old?.verify) ? old.verify : null;
  if (r.verify !== undefined) {
    if (r.verify == null || r.verify === '' || r.verify === 'none') verify = null;
    else if (!isCodeCheck(r.verify)) throw bad(`The check "${str(r.verify, 40)}" for ${whom} does not exist. Use one of: ${CHECKS.join(', ')}. Nothing was saved.`);
    else verify = r.verify;
  }
  let phone: string | null = old?.phone || null;
  if (r.phone !== undefined) {
    const typed = str(r.phone, 40).trim();
    phone = typed ? normalPhone(typed) ?? (strict ? null : typed) : null;
    if (typed && !phone) throw bad(`"${typed}", the mobile number of ${whom}, is not a number we can text. ${PHONE_HOW} Nothing was saved.`);
  }
  let link = old?.text_link ? 1 : 0;
  if (r.text_link !== undefined) link = r.text_link === true || r.text_link === 1 || r.text_link === '1' || r.text_link === 'true' ? 1 : 0;
  // Asking for a text on a server that cannot send one is refused where it is asked, in words. A check that was
  // saved while texts were on is not turned down here again and again: it is refused when the envelope is sent.
  const asks = (r.verify === 'sms_code' && old?.verify !== 'sms_code') || (link === 1 && !old?.text_link);
  if (asks && !smsMode()) throw bad(`${SMS_OFF} For ${whom}, choose a one-time code by email or no extra check, and leave "also text the signing link" off. Nothing was saved.`, 400, { code: 'texts_off' });
  return { verify, phone, text_link: link };
}

const FORM_NO_TEXT = 'A public form cannot check its visitor with a code by text message or text them the link: the number would be typed by a stranger, and every start would send a text to any number they like. In the template, give the open role a one-time code by email or no extra check, and switch "also text the signing link" off. A one-time code by email does work on a public form: it shows that the visitor can read the mailbox they typed.';

// Why a recipient's check cannot go out as it stands, or null. Asked when an envelope is sent and whenever one
// that is out is corrected. `e` is the envelope they are on.
function checkProblem(r: any, e: any): string | null {
  const name = r.name || r.role_name || 'One of the recipients';
  const byText = r.verify === 'sms_code';
  if ((byText || r.text_link) && !smsMode()) return `${SMS_OFF} ${name} is set to get ${byText ? 'a one-time code by text message' : 'the signing link by text message'}. Choose a one-time code by email or no extra check for them, and leave "also text the signing link" off.`;
  if (r.phone && !normalPhone(r.phone)) return `"${str(r.phone, 40)}", the mobile number of ${name}, is not a number we can text. ${PHONE_HOW}`;
  // The visitor of a public form types their own details. A number typed by a stranger would let anyone make this
  // server text any phone at the owner's cost, so a form's visitor is never texted.
  if (e?.powerform_id && e.form_recipient_id === r.id && (byText || r.text_link)) return FORM_NO_TEXT;
  if (byText && !r.phone) return `${name} is checked with a one-time code by text message, so they need a mobile number. ${PHONE_HOW}`;
  if (r.text_link && r.role === 'inperson') return `${name} signs in person on your device, so there is no link to text them. Switch "also text the signing link" off for them.`;
  if (r.text_link && !r.phone) return `"Also text the signing link" is on for ${name}, so they need a mobile number. ${PHONE_HOW}`;
  if (r.verify === 'email_code' && !canEmail()) return `This server has no mail server set up, so a one-time code by email could never reach ${name}. Choose another check for them.`;
  return null;
}

// What an account may still text, said to its sender before anything goes out: the hard stop per day
// (SMS_DAILY_PER_ACCOUNT), and for an account the daily limit on emails applies to, the same number of phone
// numbers a day. A text is counted like an email to that person.
function textRefusal(e: any, recipients: any[], atOnce = 0): string | null {
  const will = recipients.filter((r) => texted(r) && normalPhone(r.phone));
  if (!will.length || !smsMode()) return null;
  const cap = smsDailyPerAccount(), left = textsLeft(e.account_id);
  const room = `There is room again in about ${many(textsRoomInHours(e.account_id), 'hour')}, because the limit looks at the last 24 hours.`;
  const without = 'To send now, do it without text messages: choose a one-time code by email, and leave "also text the signing link" off.';
  if (!cap) return `The operator of this server has set the number of text messages an account can send in a day to zero, so none can be sent. Nothing was sent. ${without}`;
  if (left < 1) return `This account has used all ${cap} text messages this server sends for one account in a day. Nothing was sent. ${room} ${without}`;
  if (atOnce > left) return `This would send ${many(atOnce, 'text message')} at once, and this account can send ${left} more today (the limit is ${cap} in 24 hours). Nothing was sent. Send to fewer people at a time, or ${without.replace(/^To send now, do/, 'do')}`;
  const account = get('SELECT * FROM accounts WHERE id=?', e.account_id);
  if (!hasNotPaid(account)) return null;
  const { cap: people, firstWeek } = dailyCap(account);
  const have = numbersToday(account.id);
  const fresh = new Set(will.map((r) => phoneKey(normalPhone(r.phone)!)).filter((k) => !have.has(k)));
  if (!fresh.size || have.size + fresh.size <= people) return null;
  return `${firstWeek ? 'In its first week, an account that has not paid' : 'An account that has not paid'} can text ${people} phone numbers a day, as many as the people it can email. This account has texted ${have.size} in the last 24 hours and this would add ${fresh.size}. Nothing was sent. ${have.size ? room : ''} ${without} The limit is lifted the same way as the limit on emails: the contact form at ${baseUrl()}/help reaches a person who can lift it.`.replace(/\s+/g, ' ');
}

/** Before an envelope goes out: every recipient's check can work, and the account may text the people it asks to. */
export function assertChecks(e: any) {
  for (const r of e.recipients) {
    const problem = checkProblem(r, e);
    if (problem) throw bad(problem, 400);
  }
  const no = textRefusal(e, e.recipients);
  if (no) throw bad(no, 429);
}

// A changed check or number makes every device pass the check again, ends any code that is still on its way, and
// lets the number be texted again if someone had said it was not theirs. The record of a check that was passed goes
// too, except for someone who has finished: theirs says how they were checked when they signed, and that stays true.
function resetCheck(recipientId: string, finished: boolean) {
  run(`UPDATE recipients SET check_gen=check_gen+1, check_stop=NULL, texted_at=NULL${finished ? '' : ', checked_at=NULL, checked_how=NULL, checked_for=NULL'} WHERE id=?`, recipientId);
  run("UPDATE signer_codes SET ended_at=?, ended_how='changed' WHERE recipient_id=? AND ended_at IS NULL", now(), recipientId);
  // A text still waiting for another try was meant for the number, the check or the person as they were: a signing
  // link to a number the sender just said is wrong must never go out late.
  dropTexts(recipientId, 'the number, the check or the person changed after it was written');
}
const differs = (old: any, c: CheckValues) => (old?.verify || null) !== c.verify || (old?.phone || null) !== c.phone;
function applyCheck(recipientId: string, old: any, c: CheckValues) {
  run('UPDATE recipients SET verify=?, phone=?, text_link=? WHERE id=?', c.verify, c.phone, c.text_link, recipientId);
  if (old && differs(old, c)) resetCheck(recipientId, old.status === 'completed');
}

/**
 * Called by writeContent() in envelopes.ts once the recipients of a save are written, inside its transaction. Reads
 * "verify", "phone" and "text_link" of every recipient in the request and saves them. On an envelope that is out
 * (`correcting`) a check that cannot work is refused and nothing of the correction is saved.
 */
export function saveChecks(e: any, asked: { rid: string; r: any; i: number }[], before: Map<string, any>, correcting: boolean) {
  for (const { rid, r, i } of asked) {
    const old = before.get(rid);
    const whom = `recipient ${i + 1}${r?.name ? ` (${str(r.name, 120)})` : ''}`;
    const c = readCheck(r, old, whom, correcting);
    const row = get('SELECT id, name, role_name, role, email, status FROM recipients WHERE id=?', rid);
    if (!row) continue;
    if (correcting) {
      // A different address is a different person, and the number on file was typed for the first one. A text to
      // it would hand the new person's code or link to the old one, so the number has to be said again.
      // The same goes for another person at the same address (see samePerson in envelopes.ts).
      const otherHere = !!old && sameAddress(old.email, row.email) && old.name !== row.name && !samePerson(old.name, row.name);
      if (old && (!sameAddress(old.email, row.email) || otherHere) && r.phone === undefined && old.phone) {
        if (c.verify === 'sms_code' || c.text_link) throw bad(`${whom[0].toUpperCase()}${whom.slice(1)} ${otherHere ? `is another person than ${old.name}, at the same email address` : 'now has another email address, so this is another person'}, and the mobile number on file was typed for ${old.name}. Send "phone" with the number of ${row.name}, or change "verify" and "text_link" so that no text is needed. Nothing was saved.`);
        c.phone = null;
      }
      const problem = checkProblem({ ...row, ...c }, e);
      // What was true before this correction and is not touched by it is not held against it: a sender must still
      // be able to fix a typo in a name on a server whose operator has switched text messages off since.
      const untouched = !!old && !differs(old, c) && !!old.text_link === !!c.text_link && sameAddress(old.email, row.email) && old.role === row.role;
      if (problem && !untouched) throw bad(`${problem} Nothing was saved.`);
    }
    applyCheck(rid, old, c);
  }
}

/**
 * Called by copyEnvelope() for every recipient it copies (a template that is used, a bulk row, a public form, a
 * clone). The check goes with the copy. A row that fills in a role may bring that person's own number as "phone".
 */
export function copyCheck(from: any, newId: string, fill: any = {}) {
  let phone: string | null = from.phone || null;
  if (fill?.phone !== undefined) {
    const typed = str(fill.phone, 40).trim();
    phone = typed ? normalPhone(typed) : null;
    if (typed && !phone) throw bad(`"${typed}" is not a mobile number we can text. ${PHONE_HOW}`);
  }
  if (!from.verify && !phone && !from.text_link) return;
  run('UPDATE recipients SET verify=?, phone=?, text_link=? WHERE id=?', isCodeCheck(from.verify) ? from.verify : null, phone, from.text_link ? 1 : 0, newId);
}

/**
 * A bulk send is checked as a whole before anything is written: every row has a number where the template texts
 * that role, every number is a real one, and the account may send that many texts today.
 */
export function assertBulkChecks(tpl: any, rows: any[], open: any[]) {
  const people: any[] = tpl.recipients.filter((r: any) => r.email);
  let atOnce = 0;
  rows.forEach((row, i) => {
    for (const r of open) {
      const v = row?.[r.role_name || r.id] || {};
      const typed = str(v.phone, 40).trim();
      const phone = typed ? normalPhone(typed) : null;
      const role = r.role_name || 'Recipient';
      if (typed && !phone) throw bad(`Row ${i + 1}: "${typed}" is not a mobile number we can text for "${role}". ${PHONE_HOW}`);
      if (texted(r) && !phone) throw bad(`Row ${i + 1}: "${role}" needs a mobile number, because this template ${r.verify === 'sms_code' ? 'checks them with a one-time code by text message' : 'also texts them the signing link'}. Add a "phone" to the row. ${PHONE_HOW}`);
      people.push({ ...r, phone: phone || r.phone });
      if (r.text_link && r.role !== 'inperson') atOnce++;
    }
  });
  atOnce += rows.length * tpl.recipients.filter((r: any) => r.email && r.text_link && r.role !== 'inperson' && r.phone).length;
  if (people.some((r) => texted(r)) && !smsMode()) throw bad(`${SMS_OFF} This template asks for text messages. Change the template to a one-time code by email or no extra check, and switch "also text the signing link" off.`, 400, { code: 'texts_off' });
  const no = textRefusal({ account_id: tpl.account_id }, people, atOnce);
  if (no) throw bad(no, 429);
}

/** The same answer without stopping anything, for the bulk page's look ahead (POST /bulk/check). */
export function bulkChecksRefusal(tpl: any, rows: any[], open: any[]): { status: number; message: string } | null {
  try {
    assertBulkChecks(tpl, rows, open);
    return null;
  } catch (e: any) {
    if (typeof e?.status !== 'number') throw e;
    return { status: e.status, message: e.message };
  }
}

/** A public form is made from a template: its open role, the visitor, can never be texted. Said when the form is made. */
export function assertFormChecks(open: any) {
  if (open?.verify === 'sms_code' || open?.text_link) throw bad(FORM_NO_TEXT);
}

/**
 * What a correction did to one person's check, in words for the audit trail (see describeCorrection in envelopes.ts).
 * `o` is the recipient before and `r` after. Numbers are only ever written masked.
 */
export function checkBits(o: any, r: any): string[] {
  const bits: string[] = [];
  if ((o.verify || '') !== (r.verify || '')) bits.push(`check before the document opens changed from ${CHECK_WORDS(o.verify)} to ${CHECK_WORDS(r.verify)}`);
  if ((o.phone || '') !== (r.phone || '')) bits.push(!r.phone ? `mobile number ${maskPhone(o.phone)} removed` : o.phone ? `mobile number changed from ${maskPhone(o.phone)} to ${maskPhone(r.phone)}` : `mobile number ${maskPhone(r.phone)} added`);
  if (!!o.text_link !== !!r.text_link) bits.push(r.text_link ? 'the signing link is now also sent by text message' : 'the signing link is no longer sent by text message');
  const had = passedCheck(o);
  // Another person at the same address (person_gen went up) never keeps the pass of the one before.
  const reset = (o.verify || '') !== (r.verify || '') || (o.phone || '') !== (r.phone || '') || !sameAddress(o.email, r.email) || (Number(o.person_gen) || 0) !== (Number(r.person_gen) || 0);
  if (had && reset && o.status !== 'completed') bits.push(`the one-time code that was passed on ${plainTime(had.at)} no longer counts${isCodeCheck(r.verify) ? ', and a new one is asked for' : ''}`);
  return bits;
}

/**
 * The quick correction of one person (POST /envelopes/:id/correct), with their check. "verify", "phone" and
 * "text_link" are read first and refused in words when they cannot work. Then the name, the address and the access
 * code are corrected as before, and if that is refused the check is put back as it was, so the call does all of it
 * or none.
 */
export async function correctWithCheck(e: any, recipientId: string, patch: any, actor: Actor) {
  const r = e?.recipients?.find((x: any) => x.id === recipientId);
  const asks = !!patch && (patch.verify !== undefined || patch.phone !== undefined || patch.text_link !== undefined || patch.number_confirmed !== undefined);
  const email = patch?.email !== undefined ? str(patch.email, 254).trim() : r?.email;
  const name = patch?.name !== undefined ? str(patch.name, 120).trim() || r?.name : r?.name;
  // Another person: another address, or at the same address a name that is not the old one in another spelling
  // (a couple or an office can share an inbox: see samePerson in envelopes.ts). The number on file was typed for
  // the first one, and what they passed is theirs.
  const sameInbox = !!r && sameAddress(r.email, email);
  const swapped = !!r && (!sameInbox || (name !== r.name && !samePerson(r.name, name)));
  const other = !!patch && (patch.name !== undefined || patch.email !== undefined || patch.access_code !== undefined);
  // Nothing about a check in the call and the same person: exactly what it always did. So are the refusals for an
  // envelope that is not out and a person who is not on it or has finished.
  if (!r || e.status !== 'sent' || r.status === 'completed' || (!asks && !(swapped && (r.phone || r.verify || r.text_link)))) return correctRecipient(e, recipientId, patch, actor);
  const whom = r.name || 'this recipient';
  const c = readCheck(patch, r, whom, true);
  if (swapped && patch.phone === undefined && r.phone) {
    const who = sameInbox ? `${name} is another person than ${r.name}, at the same email address` : 'You are sending this to another email address, so to another person';
    if (c.verify === 'sms_code' || c.text_link) throw bad(`${who}, and the mobile number on file was typed for ${r.name}. Send "phone" with the number of ${name}, or change "verify" and "text_link" so that no text is needed. Nothing was changed.`);
    c.phone = null;
  }
  // person_gen goes up with the correction below (correctRecipient), and the record says what that does to a pass.
  const after = { ...r, ...c, name, email, person_gen: swapped ? (Number(r.person_gen) || 0) + 1 : r.person_gen };
  const changed = differs(r, c) || !!r.text_link !== !!c.text_link;
  if (changed || swapped) {
    const problem = checkProblem(after, e);
    if (problem) throw bad(`${problem} Nothing was changed.`);
    const no = textRefusal(e, [after]);
    if (no) throw bad(no, 429);
  }
  // "number_confirmed": someone using the link said the number is not theirs, and the sender has since heard from
  // the person, a way they trust, that it is right after all (a finger slipped, a relative held the phone). Codes go
  // to the same number again. Only when said in so many words: a call that sends the whole recipient back to fix a
  // name must never lift a stop that protects whoever owns the number.
  const confirm = patch.number_confirmed === true && !!r.check_stop && !changed && !swapped && c.verify === 'sms_code';
  const was = get('SELECT verify, phone, text_link, check_gen, checked_at, checked_how, checked_for, check_stop, texted_at FROM recipients WHERE id=?', r.id);
  const bits = checkBits(r, after);
  if (changed) applyCheck(r.id, r, c);
  if (confirm) {
    run('UPDATE recipients SET check_stop=NULL WHERE id=?', r.id);
    bits.push(`the sender confirmed that ${maskPhone(r.phone)} is their number, after someone using the link had said it was not, so codes go to it again`);
  }
  if (other) {
    try {
      await correctRecipient(changed ? loadEnvelope(e.id) : e, recipientId, patch, actor);
    } catch (err) {
      if (changed || confirm) run('UPDATE recipients SET verify=?, phone=?, text_link=?, check_gen=?, checked_at=?, checked_how=?, checked_for=?, check_stop=?, texted_at=? WHERE id=?',
        was.verify, was.phone, was.text_link, was.check_gen, was.checked_at, was.checked_how, was.checked_for, was.check_stop, was.texted_at, r.id);
      throw err;
    }
  }
  if (bits.length) audit(e.id, actor, 'Check corrected', `${after.name} <${after.email}>: ${bits.join(', ')}.`);
  if (changed) await textWaiting(e.id);
}

/**
 * A signer passed the document on to someone else (see reassignRecipient). The number on file was typed by the
 * sender for the first person, so no text goes to it for the second: a check by text message becomes a one-time
 * code to the new person's mailbox, which is the check we can still make, and the link is no longer texted. A check
 * the first person passed does not count for the second. The record says all of it and the sender is told.
 */
export async function passCheckOn(e: any, old: any, actor: Actor) {
  if (!old.phone && !isCodeCheck(old.verify) && !old.text_link) return;
  const cur = get('SELECT name, email FROM recipients WHERE id=?', old.id);
  if (!cur) return;
  const had = passedCheck(old);
  run('UPDATE recipients SET verify=?, phone=NULL, text_link=0 WHERE id=?', old.verify === 'sms_code' ? 'email_code' : isCodeCheck(old.verify) ? old.verify : null, old.id);
  resetCheck(old.id, false);
  const said: string[] = [];
  if (old.verify === 'sms_code') said.push(`${old.name} was checked with a one-time code by text message to ${maskPhone(old.phone)}, a number the sender typed for them. ${cur.name} is asked for a one-time code by email instead, sent to ${maskEmail(cur.email)}.`);
  else if (old.verify === 'email_code') said.push(`${cur.name} is asked for a one-time code by email, sent to ${maskEmail(cur.email)}.`);
  if (old.text_link) said.push(`The signing link is no longer sent by text message, because the number on file was typed for ${old.name}.`);
  if (had) said.push(`The one-time code ${old.name} passed on ${plainTime(had.at)} does not count for ${cur.name}.`);
  if (!said.length) return;
  audit(e.id, actor, 'Check passed on', said.join(' '));
  if (old.verify === 'sms_code')
    await notifySender(e, 'always', `Check changed: ${e.subject}`, `${cur.name} is checked by email, not by text message`,
      [`${old.name} passed "${e.subject}" on to ${cur.name} <${cur.email}>. You had asked for a one-time code by text message to ${maskPhone(old.phone)}, which is the number of ${old.name}, so we cannot use it for ${cur.name}.`,
        `${cur.name} is asked for a one-time code by email instead. That proves less than a text: it only shows they can read the mailbox the link went to. If you want the check by text message, open the envelope, choose Correct next to their name and type the mobile number of ${cur.name}.`]);
}

// ---- Texting a signing link ------------------------------------------------------------------------------

// Why a text must not go to this number right now, or null. Asked at the moment of every text, so no path to a
// text can walk round a limit: the hard stop per account and day, the daily number of phone numbers for an account
// the email limit applies to, and for a link or a reminder how many of those one number gets in a day.
// `own` is for a text the timer tries again: it was counted when it was first written, and while that count is
// still inside the last 24 hours it is not counted against itself a second time.
function mayText(e: any, phone: string, kind: 'code' | 'link' | 'reminder', own = false): string | null {
  if (!smsMode()) return 'text messages are switched off on this server';
  const mine = own ? 1 : 0;
  if (textsLeft(e.account_id) + mine < 1) return `the account this document was sent from has sent as many text messages as this server allows in a day (${smsDailyPerAccount()})`;
  const account = get('SELECT * FROM accounts WHERE id=?', e.account_id);
  if (hasNotPaid(account)) {
    const have = numbersToday(account.id);
    if (!have.has(phoneKey(phone)) && have.size >= dailyCap(account).cap) return `the account this document was sent from has texted as many phone numbers as it may in a day (${dailyCap(account).cap})`;
  }
  if (kind !== 'code' && linkTextsToday(e.account_id, phone) - mine >= LINK_TEXTS_PER_NUMBER_DAY) return `${LINK_TEXTS_PER_NUMBER_DAY} texts about documents have gone to this number from this account in the last 24 hours, which is the most we send to one number`;
  return null;
}

// The pause and the filter for fake payment notices, in the words a record of a text uses, or null. They read the
// same words a text is made of (the sender's name and the subject) and hold whoever the text goes to.
function textGuard(e: any): string | null {
  const guard = emailRefusal(e);
  return !guard ? null : guard.status === 403 ? 'sending is paused on this account' : 'the envelope reads like a fake payment notice, or goes out under a name that reads like a well-known brand';
}
const reported = (e: any, r: any) => !!get('SELECT 1 x FROM abuse_reports WHERE envelope_id=? AND lower(reporter)=lower(?)', e.id, reporterKey(r));

// Something stood in the way of a text, and the record says what. The sender hears it once a day for each person.
async function textHeld(e: any, r: any, what: string, why: string) {
  const detail = `${r.name}: ${what} to ${maskPhone(r.phone)} was not sent, because ${why}.`;
  if (get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Text not sent' AND detail=? AND at > ?", e.id, detail, iso(Date.now() - 864e5))) return;
  audit(e.id, SYSTEM, 'Text not sent', detail);
  await notifySender(e, 'problems', `Text not sent: ${e.subject}`, `We did not text ${r.name}`,
    [`${what[0].toUpperCase()}${what.slice(1)} to ${maskPhone(r.phone)} was not sent, because ${why}.`, 'The email with the same link was not affected. You can also copy their signing link from the envelope page and send it yourself.']);
}

const clip = (s: any, max: number) => (String(s ?? '').length > max ? `${String(s).slice(0, max - 3).trimEnd()}...` : String(s ?? ''));
const ASKS: Record<string, string> = { signer: 'is waiting for you to sign', approver: 'is waiting for you to approve', viewer: 'is waiting for you to read', cc: 'was sent to you as a copy' };

// Short on purpose: who it is for, which document, that it comes from Sign&Grow for that sender, and the link.
function linkText(e: any, r: any, sender: any, kind: string): string {
  const doc = `"${clip(e.subject, 60)}"`, who = clip(sender?.name || 'the sender', 40);
  const asks = ASKS[r.role] || ASKS.signer;
  if (kind === 'reminder') return `Reminder from Sign&Grow, sent for ${who}: ${doc} ${asks.replace('is waiting', 'is still waiting')}. ${signUrl(r)}`;
  if (kind === 'again') return `Sign&Grow, sent for ${who}: ${doc} was changed and ${asks} again. ${signUrl(r)}`;
  return `Sign&Grow, sent for ${who}: ${doc} ${asks}. ${signUrl(r)}`;
}

/**
 * Called by notifyRecipient() in envelopes.ts after an email about a document was written: the same news by text,
 * for a recipient the sender chose that for. Only for a new request, a request to sign again, a reopened envelope
 * and a reminder, and a reminder by text follows at most once a day. Never for someone who declined or reported
 * the document, never while the sender is paused or the envelope reads like a fake notice, and never past a limit.
 * It never throws: a text that cannot go is written down, and the email it accompanies has gone already.
 */
export async function alsoText(e: any, r: any, kind: string): Promise<void> {
  try {
    if (!r?.text_link || r.role === 'inperson' || !['new', 'again', 'reopened', 'reminder'].includes(kind)) return;
    const cur = get('SELECT * FROM recipients WHERE id=?', r.id);
    const phone = normalPhone(cur?.phone);
    if (!cur || !cur.text_link || !phone || !cur.token || cur.status === 'declined' || cur.muted && kind === 'reminder') return;
    // Someone using the link said this number is not theirs. Its owner is left alone: no code and no link by text
    // either, until the sender corrects the number or confirms it. The sender was told when it was said.
    if (cur.check_stop) return;
    if (kind === 'reminder' && cur.texted_at && Date.now() - Date.parse(cur.texted_at) < 864e5) return;
    const what = kind === 'reminder' ? 'a reminder by text message' : 'the signing link by text message';
    // Someone who told us this document looks wrong hears nothing more from us about it by text. Whoever holds the
    // link can report without a code, so the sender is told the texts stopped and can reach the person another way.
    // The pause and the filter for fake payment notices hold for a text whoever it goes to, also when the email went
    // to the sender's own address.
    const no = reported(e, cur) ? 'someone using their signing link reported this document as suspicious, and we send nothing more to them about it by text' : textGuard(e) || mayText(e, phone, kind === 'reminder' ? 'reminder' : 'link');
    if (no) return void (await textHeld(e, cur, what, no));
    run('UPDATE recipients SET texted_at=? WHERE id=?', now(), cur.id);
    const { status } = await sendText({ to: phone, text: linkText(e, cur, senderOf(e), kind), accountId: e.account_id, envelopeId: e.id, recipientId: cur.id, kind: kind === 'reminder' ? 'reminder' : 'link' });
    if (status === 'sent') audit(e.id, SYSTEM, kind === 'reminder' ? 'Reminder sent by text message' : 'Signing link sent by text message', `${cur.name}, to ${maskPhone(phone)}`);
    else if (status === 'outbox') audit(e.id, SYSTEM, 'Not texted', `${cur.name}, to ${maskPhone(phone)}. This machine has no text message provider, so the text was only written to the outbox.`);
  } catch (err: any) {
    console.error('[sms] could not text a signing link', err?.message);
  }
}

/**
 * After a correction: whoever has the document, is set to get the link by text and has never been texted it (the
 * sender just switched that on, or changed the number) gets it now, not with the next reminder.
 */
export async function textWaiting(envelopeId: string): Promise<void> {
  const e = loadEnvelope(envelopeId);
  if (!e || e.status !== 'sent') return;
  for (const r of e.recipients) if (r.text_link && !r.texted_at && (r.status === 'sent' || r.status === 'viewed')) await alsoText(e, r, 'new');
}

// A text the provider did not take the first time is tried again by the timer (retryTexts in sms.ts). That try is
// decided again by everything that applies at that moment, exactly as a first try is: the number on file now, the
// check and the link as they are now, a "not my number", a finished, declined or muted person, a report, the pause,
// the fake-notice filter and the daily limits. A text to a number the sender has since corrected, to someone who
// has signed, or to someone who said it is not their number, is never sent late. Returns why not, or null.
onTextRetry('envelope', async (t) => {
  if (!t.envelope_id || !t.recipient_id) return null;
  const e = loadEnvelope(t.envelope_id);
  const r = e?.recipients?.find((x: any) => x.id === t.recipient_id);
  if (!e || !r) return 'the person or the document it was about is no longer there';
  const phone = normalPhone(r.phone);
  if (!phone || phone !== t.to_phone) return 'the mobile number on file was changed after it was written';
  if (r.check_stop) return 'someone using the signing link said the number is not theirs';
  if (t.kind === 'code') {
    // A code text only ever carries the newest code for the check as it is now.
    const live = r.verify === 'sms_code' ? liveCode(r) : null;
    if (!live || live.expires_at !== t.expires_at) return 'the code in it no longer works';
  } else {
    if (!r.text_link || r.role === 'inperson') return 'the signing link is no longer sent to them by text message';
    if (!r.token || !String(t.body || '').includes(`/sign/${r.token}`)) return 'the link in it was replaced';
    if (e.status !== 'sent' || !['sent', 'viewed'].includes(r.status)) return r.status === 'completed' ? 'they have finished' : r.status === 'declined' ? 'they declined' : 'it is not their turn now';
    if (t.kind === 'reminder' && r.muted) return 'they asked not to be reminded';
  }
  const what = t.kind === 'code' ? 'a one-time code by text message' : t.kind === 'reminder' ? 'a reminder by text message' : 'the signing link by text message';
  const own = Date.parse(t.at) > Date.now() - 864e5;
  const no = (t.kind !== 'code' && reported(e, r) ? 'someone using their signing link reported this document as suspicious, and we send nothing more to them about it by text' : null)
    || textGuard(e) || mayText(e, phone, t.kind, own);
  // The sender hears it the way they hear a first try that is held back. A code is asked for by whoever holds the
  // link, who is told why at once when they ask for the next one.
  if (no && t.kind !== 'code') await textHeld(e, r, what, no);
  return no;
});

// What became of a text belongs in its envelope's record, like an email (see onMailOutcome in envelopes.ts): the
// first failed try as exactly that, a later try that goes through as sent, and the end of trying as final. Then the
// sender is told, because only they can correct the number or reach the person another way.
onTextOutcome('envelope', async (t, what) => {
  const e = t.envelope_id && get('SELECT id, subject, account_id, sender_id FROM envelopes WHERE id=?', t.envelope_id);
  if (!e) return;
  const r = t.recipient_id ? get('SELECT name FROM recipients WHERE id=?', t.recipient_id) : null;
  const kind = t.kind === 'code' ? 'A one-time code' : t.kind === 'reminder' ? 'A reminder' : 'The signing link';
  const which = `${kind} by text message to ${r?.name ? `${r.name}, ` : ''}${t.to_masked}`;
  const said = t.error ? ` What went wrong: ${str(t.error, 300).replace(/[.\s]+$/, '')}.` : '';
  const tries = t.tries > 1 ? ` after ${t.tries} tries` : '';
  if (what === 'delayed') audit(e.id, SYSTEM, 'Text could not be sent yet', `${which}.${said} It is tried again automatically${t.kind === 'code' ? ' while the code still works' : ''}.`);
  if (what === 'sent') audit(e.id, SYSTEM, 'Text sent', `${which}, on try ${t.tries}.`);
  if (what !== 'gave_up') return;
  audit(e.id, SYSTEM, 'Text could not be sent', `${which}${tries}.${said} No more tries are made.`);
  await notifySender(e, 'problems', `Text not delivered: ${e.subject}`, `We could not text ${r?.name || t.to_masked}`,
    [`${which} could not be handed to the text message provider${tries}, so we have stopped trying.${said}`,
      t.kind === 'code' ? `${r?.name || 'They'} cannot open the document until a code reaches them. Check the number: open the envelope and choose Correct next to their name. There you can also switch to a one-time code by email.`
        : 'The email with the same link was sent separately and is not affected. Check the number: open the envelope and choose Correct next to their name.']);
});

// ---- The one-time code ---------------------------------------------------------------------------------------

const codeHash = (r: any, stamp: string, code: string) => hmac(`otp:${r.id}:${stamp}:${code}`);
const brandOf = (accountId: string) => {
  const a = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', accountId);
  return { name: a?.name, color: a?.brand_color, logo: a?.brand_logo };
};
// Told to the sender at most once a day for each person and reason, with the envelope's record as the memory.
async function tellOnce(e: any, action: string, detail: string, mail: () => Promise<void>) {
  if (get('SELECT 1 x FROM audit WHERE envelope_id=? AND action=? AND detail=? AND at > ?', e.id, action, detail, iso(Date.now() - 864e5))) return;
  audit(e.id, SYSTEM, action, detail);
  await mail();
}

/**
 * Makes a new one-time code for this recipient and sends it: by email to their address, or by text to the number
 * the sender typed. The answer never holds the code, and never the address or the number in full. Everything that
 * limits how often this can be done is counted in the database, before the code is made:
 * one a minute and SIGNER_CODES_PER_HOUR an hour for a recipient, SIGNER_CODES_PER_CALLER_HOUR an hour for a device
 * address over every link it opens, SIGNER_CODES_PER_DESTINATION_DAY a day for one mailbox or number whoever asks,
 * and for a text the account's own limits. A new code ends the one before it.
 */
export async function requestCode(e: any, r: any, actor: Actor): Promise<any> {
  if (!isCodeCheck(r.verify)) throw bad('This document does not ask for a one-time code.', 409);
  // A code is only worth sending for a document this person can open once they have it.
  if (r.status === 'pending' || !(e.status === 'sent' || e.status === 'completed' || (r.status === 'completed' && r.role !== 'cc'))) throw bad('This document is not waiting for a code right now.', 409);
  const sender = senderOf(e) || { name: 'the sender', email: '' };
  const reach = sender.email ? `${sender.name}: ${sender.email}` : sender.name;
  const kind: 'email_code' | 'sms_code' = r.verify;
  const byText = kind === 'sms_code';
  const d = destOf(r);
  const how = CHANNEL_WORDS[kind];
  if (byText && r.check_stop) throw bad(`No code is sent to ${d.masked} any more, because someone using this link said it is not their number. ${sender.name} has been told and has to put in the right number. Until then this document cannot be opened. You can reach ${reach}.`, 409, { code: 'stopped' });
  // The server cannot send this kind of message at all, or the number cannot be texted. Nothing the signer did.
  const cannot = byText ? (!smsMode() ? 'text messages are switched off on this server' : !d.to ? 'the mobile number on file is not complete' : '') : !canEmail() || !d.to ? 'this server cannot send email' : '';
  const sorry = (why: string) => bad(`We cannot send you a code by ${how} right now. That is nothing you did: ${why}. ${sender.name} has been told and can fix it or choose another check. You can reach ${reach}. Nothing you filled in is lost.`, 503, { code: 'unavailable' });
  const tellSender = (why: string) => tellOnce(e, 'One-time code could not be sent', `${r.name}: a code by ${how} to ${d.masked} was asked for and not sent, because ${why}.`, () =>
    notifySender(e, 'always', `Cannot open: ${e.subject}`, `${r.name} cannot get a one-time code`,
      [`${r.name} asked for the one-time code that opens "${e.subject}", by ${how} to ${d.masked}. We did not send it, because ${why}.`,
        'They cannot open the document until this is fixed. Open the envelope and choose Correct next to their name: there you can change the number, switch to a one-time code by email, or take the check off.']));
  if (cannot) {
    await tellSender(cannot);
    throw sorry(cannot);
  }

  const t = Date.now();
  const wait = waitFor(r);
  if (wait.why === 'minute') throw bad(`A code was sent less than a minute ago. You can ask for a new one in ${many(wait.seconds, 'second')}.`, 429, { code: 'wait', resend_in: wait.seconds });
  if (wait.why === 'hour') throw bad(`${SIGNER_CODES_PER_HOUR} codes were sent for this document in the last hour, which is the most we send. You can ask for a new one in ${many(Math.ceil(wait.seconds / 60), 'minute')}. The newest code you were sent may still work.`, 429, { code: 'wait', resend_in: wait.seconds });
  // An address we cannot tell apart (no proxy in front) is not counted, or every visitor would share one limit.
  if (actor.ip && actor.ip !== 'unknown' && get('SELECT COUNT(*) n FROM signer_codes WHERE ip=? AND at > ?', actor.ip, iso(t - 3600_000)).n >= SIGNER_CODES_PER_CALLER_HOUR)
    throw bad(`${SIGNER_CODES_PER_CALLER_HOUR} codes were asked for from your internet connection in the last hour, which is the most we send. Wait a while and try again. If you need help, you can reach ${reach}.`, 429, { code: 'wait_caller' });
  if (get('SELECT COUNT(*) n FROM signer_codes WHERE dest_hash=? AND at > ?', d.key, iso(t - 864e5)).n >= SIGNER_CODES_PER_DESTINATION_DAY)
    throw bad(`${SIGNER_CODES_PER_DESTINATION_DAY} codes have gone to ${d.masked} in the last 24 hours, which is the most we send to one ${byText ? 'number' : 'mailbox'} in a day. Try again tomorrow. If you need the document sooner, you can reach ${reach}.`, 429, { code: 'wait_destination' });
  if (byText) {
    const no = mayText(e, d.to!, 'code');
    if (no) {
      await tellSender(no);
      throw sorry(no);
    }
  }

  const code = String(crypto.randomInt(0, 10 ** SIGNER_CODE_DIGITS)).padStart(SIGNER_CODE_DIGITS, '0');
  const stamp = deviceStamp(r);
  const at = iso(t), expires = iso(t + SIGNER_CODE_MINUTES * 60_000);
  // The newer code ends the older one in the same step that makes it, so there is never more than one that works.
  const id = tx(() => {
    run("UPDATE signer_codes SET ended_at=?, ended_how='replaced' WHERE recipient_id=? AND ended_at IS NULL", at, r.id);
    return Number(run('INSERT INTO signer_codes (recipient_id, envelope_id, account_id, channel, dest, dest_hash, code_hash, stamp, ip, at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      r.id, e.id, e.account_id, kind, d.masked, d.key, codeHash(r, stamp, code), stamp, actor.ip || null, at, expires).lastInsertRowid);
  });
  // An older code that is still waiting to be sent would arrive after this one and work for nothing.
  // (An email about an envelope that carries an end time is a code email. They are filed under the envelope and the
  // address, not under the recipient, so the sender's page keeps showing the signing email as the last one to them.)
  if (!byText) run("UPDATE emails SET expires_at=? WHERE envelope_id=? AND lower(to_email)=lower(?) AND expires_at IS NOT NULL AND expires_at > ? AND status IN ('queued','failed')", at, e.id, d.to, at);
  dropCodeTexts(r.id);

  let delivery: string;
  if (byText) {
    // The last line is the form phones read to offer the code on this site only.
    const host = baseUrl().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
    delivery = (await sendText({ to: d.to!, kind: 'code', accountId: e.account_id, envelopeId: e.id, recipientId: r.id, expiresAt: expires,
      text: `${code} is your Sign&Grow code to open a document from ${clip(sender.name, 40)}. It works for ${SIGNER_CODE_MINUTES} minutes. Did not ask for it? Ignore this text.\n\n@${host} #${code}` })).status;
  } else {
    delivery = await sendMail({
      to: d.to!, subject: `Your code to open a document from ${sender.name}`, heading: `${code} is your code`,
      lines: [`Type this code on the page that asked for it. It works for ${SIGNER_CODE_MINUTES} minutes, and only for the document ${sender.name} sent you.`,
        `Nobody at Sign&Grow and nobody working for ${sender.name} will ever ask you for this code. If you did not just open a document from ${sender.name}, someone else has the link that was emailed to you: do not pass the code on${sender.email ? `, and tell ${sender.name} (${sender.email})` : ''}.`],
      envelopeId: e.id, brand: brandOf(e.account_id), replyTo: sender.email || undefined, fromName: sender.name, expiresAt: expires,
    });
    // Once the mail server has it, our own copy of the email no longer needs to hold the code.
    if (delivery === 'sent') run("UPDATE emails SET html=replace(html, ?, '(removed)'), payload=replace(payload, ?, '(removed)') WHERE id=(SELECT MAX(id) FROM emails WHERE envelope_id=? AND lower(to_email)=lower(?) AND expires_at=?)", code, code, e.id, d.to, expires);
  }
  run('UPDATE signer_codes SET delivery=? WHERE id=?', delivery, id);
  const to = `${r.name}: by ${how} to ${d.masked}`;
  if (delivery === 'sent') audit(e.id, actor, 'One-time code sent', to);
  else if (delivery === 'outbox') audit(e.id, actor, 'One-time code not delivered', `${to}. This machine has no ${byText ? 'text message provider' : 'mail server'}, so the code was only written to the outbox.`);
  else {
    // The record of why is written by the listeners for emails and texts. The person is told at once, and may ask again.
    audit(e.id, actor, 'One-time code could not be sent', `${to}. The ${byText ? 'text message provider' : 'mail server'} would not take it.`);
    throw bad(`We could not send the code just now. That is nothing you did, and nothing you filled in is lost. Try again in a minute. If it keeps happening, tell ${reach}.`, 502, { code: 'not_sent', resend_in: SIGNER_CODE_WAIT_SECONDS });
  }
  return { sent: true, kind, to: d.masked, minutes: SIGNER_CODE_MINUTES, expires_in: SIGNER_CODE_MINUTES * 60, resend_in: SIGNER_CODE_WAIT_SECONDS, tries_left: SIGNER_CODE_TRIES, delivery };
}

/**
 * Checks a code somebody typed. Only the newest code for this recipient can be right, for SIGNER_CODE_MINUTES, and
 * SIGNER_CODE_TRIES wrong tries end it. What was typed is compared as a keyed fingerprint, in the same time whether
 * it is right or wrong. Looking the code up, comparing and counting a wrong try happen with nothing waited for in
 * between, so tries made at the same moment are counted one after the other. Returns when the code was right; the
 * caller then gives the browser passCookie().
 */
export async function checkCode(e: any, r: any, typed: any, actor: Actor): Promise<{ ok: true }> {
  if (!isCodeCheck(r.verify)) return { ok: true };
  const digits = String(typed ?? '').replace(/\D/g, '');
  if (digits.length !== SIGNER_CODE_DIGITS) throw bad(`The code has ${SIGNER_CODE_DIGITS} digits. Type all of them, with nothing else.`, 400, { code: 'format' });
  const d = destOf(r);
  const how = CHANNEL_WORDS[r.verify as 'email_code' | 'sms_code'];
  const out = tx((): { kind: 'none' | 'expired' | 'spent' | 'ok' | 'wrong'; left?: number } => {
    const c = get('SELECT * FROM signer_codes WHERE recipient_id=? ORDER BY id DESC LIMIT 1', r.id);
    if (!c || c.stamp !== deviceStamp(r) || (c.ended_at && c.ended_how !== 'tries')) return { kind: 'none' };
    if (c.ended_how === 'tries') return { kind: 'spent' };
    if (c.expires_at <= now()) return { kind: 'expired' };
    if (safeEqual(codeHash(r, c.stamp, digits), c.code_hash)) {
      const t = now();
      run("UPDATE signer_codes SET ended_at=?, ended_how='used' WHERE id=?", t, c.id);
      // The record for the certificate: how the code was sent, to where (masked) and when it was typed. Someone
      // who has finished keeps the record of the check they passed before they signed.
      if (r.status !== 'completed' || !passedCheck(r)) run('UPDATE recipients SET checked_at=?, checked_how=?, checked_for=? WHERE id=?', t, `One-time code sent by ${how} to ${d.masked}`, linkStamp(r), r.id);
      return { kind: 'ok' };
    }
    const fails = c.fails + 1, spent = fails >= SIGNER_CODE_TRIES;
    run('UPDATE signer_codes SET fails=?, ended_at=?, ended_how=? WHERE id=?', fails, spent ? now() : null, spent ? 'tries' : null, c.id);
    return { kind: 'wrong', left: SIGNER_CODE_TRIES - fails };
  });
  const spentText = `That code was typed wrongly ${SIGNER_CODE_TRIES} times, so it no longer works. Ask for a new one below.`;
  if (out.kind === 'ok') {
    audit(e.id, actor, 'One-time code accepted', `${r.name}: the code sent by ${how} to ${d.masked}`);
    return { ok: true };
  }
  if (out.kind === 'none') throw bad('There is no code waiting to be typed in. Ask for a new one below.', 410, { code: 'no_code' });
  if (out.kind === 'expired') throw bad(`That code is more than ${SIGNER_CODE_MINUTES} minutes old and no longer works. Ask for a new one below.`, 410, { code: 'expired' });
  if (out.kind === 'spent') throw bad(spentText, 423, { code: 'spent' });
  audit(e.id, actor, 'One-time code failed', `${r.name}: a wrong code was typed for the one sent by ${how} to ${d.masked}`);
  if (!out.left) {
    // Five wrong tries at one code are more than a slip of the finger. The sender hears it, once a day.
    await tellOnce(e, 'One-time code used up', `${r.name}: ${SIGNER_CODE_TRIES} wrong tries at the code sent by ${how} to ${d.masked}, so that code no longer works`, () =>
      notifySender(e, 'problems', `Wrong codes: ${e.subject}`, `Someone typed ${SIGNER_CODE_TRIES} wrong codes for ${r.name}`,
        [`The one-time code we sent by ${how} to ${d.masked} was typed wrongly ${SIGNER_CODE_TRIES} times through the signing link of ${r.name}, so that code no longer works. A new one can be asked for on the same page.`,
          'This is usually someone reading an older message. If it keeps happening, somebody who does not have the code may be trying to open the document. You do not have to do anything: without the right code it stays closed.']));
    throw bad(spentText, 423, { code: 'spent' });
  }
  throw bad(`That code is not right. Only the newest ${byWhat(r.verify)} from us has the code that works. You can try ${many(out.left!, 'more time')} with this code.`, 401, { code: 'wrong', tries_left: out.left });
}
const byWhat = (v: any) => (v === 'sms_code' ? 'text message' : 'email');

/**
 * The way out when the code never arrives: "This is not my number" and "I do not get the code". Both are written to
 * the record and told to the sender whatever their email settings, because nobody gets in until the sender acts,
 * and the screen says so. After "not my number" no further code goes to that number until the sender corrects it.
 */
export async function codeProblem(e: any, r: any, what: any, actor: Actor): Promise<{ told: true; stopped: boolean }> {
  if (!isCodeCheck(r.verify)) throw bad('This document does not ask for a one-time code.', 409);
  if (r.status === 'pending' || !['sent', 'completed'].includes(e.status)) throw bad('This document is not waiting for a code right now.', 409);
  const byText = r.verify === 'sms_code';
  const notMine = what === 'not_mine';
  if (notMine && !byText) throw bad('That choice is for a code by text message. Choose "I do not get the code" instead.');
  if (!notMine && what !== 'no_code') throw bad('Say what is wrong: "not_mine" (this is not my number) or "no_code" (I do not get the code).');
  const d = destOf(r);
  const how = CHANNEL_WORDS[r.verify as 'email_code' | 'sms_code'];
  const fix = `Open the envelope and choose Correct next to their name: there you can ${byText ? 'put in the right number, switch to a one-time code by email' : 'correct the address, switch to a one-time code by text message if this server sends them'}, or take the check off.`;
  const careful = 'Before you change anything, make sure you are dealing with the right person. Reach them a way you already trust, such as a call to a number you know: someone who should not have the link could be the one asking.';
  if (notMine) {
    run('UPDATE recipients SET check_stop=? WHERE id=?', now(), r.id);
    run("UPDATE signer_codes SET ended_at=?, ended_how='stopped' WHERE recipient_id=? AND ended_at IS NULL", now(), r.id);
    dropTexts(r.id, 'someone using the signing link said the number is not theirs');
    audit(e.id, actor, 'One-time code: not my number', `Someone using the signing link of ${r.name} said the mobile number ${d.masked} is not theirs. No more codes or links are texted to it until the sender corrects it or confirms it with them.`);
    await notifySender(e, 'always', `Wrong number: ${e.subject}`, `${r.name} says the mobile number is not theirs`,
      [`Someone using the signing link of ${r.name} told us that ${d.masked}, the number you typed for the one-time code, is not their number. We have stopped sending codes to it, so whoever owns that number is left alone.`,
        `${r.name} cannot open "${e.subject}" until you fix this. ${fix} If the number turns out to be right after all, tick "I checked with ${r.name} that this is their number" there, and codes go to it again.`, careful]);
    return { told: true, stopped: true };
  }
  audit(e.id, actor, 'One-time code: did not arrive', `Someone using the signing link of ${r.name} said the code sent by ${how} to ${d.masked} did not arrive.`);
  await notifySender(e, 'always', `Code did not arrive: ${e.subject}`, `${r.name} does not get the one-time code`,
    [`Someone using the signing link of ${r.name} told us that the one-time code we sent by ${how} to ${d.masked} does not arrive.`,
      `${byText ? 'Check that the number is right and can receive text messages.' : 'It goes to the same mailbox as the signing link, so it may be in their spam folder.'} ${r.name} cannot open "${e.subject}" until a code reaches them. ${fix}`, careful]);
  return { told: true, stopped: false };
}
