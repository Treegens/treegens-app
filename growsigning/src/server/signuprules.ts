// The rules for making an account (owner's decision, 23 November 2026; the words and the parsing are in
// src/lib/signup.ts):
//
//   1. No "+" in the address of a new account, and one account per mailbox: addresses that differ only by capital
//      letters, by dots before the @ at Gmail, or by googlemail for gmail are the same mailbox. Checked wherever a
//      login is made or moved: sign-up, Google and Microsoft, an organisation's sign-in, an invitation to a team, a
//      change of address. A login that already has a + keeps working. Signers and recipients are never checked.
//   2. A phone number for every login, kept in international form, one login per number unless a person who runs
//      the server allowed that number for more. It is asked for on the sign-up form. A login made with Google or
//      Microsoft gives it once on the "One more thing" screen before the app opens. A login from before this rule is
//      asked once, may say "Not now", and needs it before it sends its next new document: nothing that is already
//      out is touched, and keys and public forms that already work go on working.
//   3. The number is shown to its owner and to the people who run the server (OPERATOR_EMAILS). Nobody else in a
//      team sees it, and it is in no list of members.
//
// users.phone holds the number (encrypted with the other encrypted columns when FILE_ENCRYPTION_KEY is set),
// users.phone_key a keyed fingerprint of it for "is this number taken", users.email_key the mailbox of the address.
// users.phone_rule says how the login is asked: NULL a login from before the rule, 1 a login made since, 2 a login an
// organisation made through its own sign-in service (the organisation answers for its people; never asked).
// No verification text is sent unless the server has a text message provider: then checking by code is offered,
// never required, and users.phone_verified_at says when it was done.
import crypto from 'node:crypto';
import { route, type Ctx } from './router.ts';
import { all, db, get, run } from './db.ts';
import { bad, hmac, now, str, rateLimit, safeEqual, HttpError } from './util.ts';
import { seal } from './colcrypt.ts';
import { smsProvider } from '../lib/checks.ts';
import { isDeploymentBilling } from '../lib/billingmode.ts';
import { plusInEmail, mailboxKey, parsePhone, phoneProblemText, showPhone, PLUS_REFUSAL, SAME_MAILBOX_REFUSAL, PHONE_TAKEN, PHONE_BEFORE_SEND } from '../lib/signup.ts';

const g = globalThis as any;

/**
 * Whether this server asks for a phone number. SIGNUP_PHONE=off switches it off, SIGNUP_PHONE=required on. Left
 * unset it is on, except on a server paid for under a contract (BILLING_MODE=deployment), whose people are its own.
 */
export function phoneRequired(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.SIGNUP_PHONE ?? '').trim().toLowerCase();
  if (['off', '0', 'false', 'no'].includes(v)) return false;
  if (['required', 'on', '1', 'true', 'yes'].includes(v)) return true;
  return !isDeploymentBilling(env as any);
}

// What this file needs next to the columns in db.ts: two indexes and the list of numbers allowed for more than one
// login. Made once per database.
function ready() {
  const d = db();
  if (g.__tsSignupRules === d) return;
  d.exec(`CREATE INDEX IF NOT EXISTS users_email_key ON users(email_key);
    CREATE INDEX IF NOT EXISTS users_phone_key ON users(phone_key);
    CREATE TABLE IF NOT EXISTS phone_shared (phone_key TEXT PRIMARY KEY, by_user TEXT, at TEXT NOT NULL);`);
  g.__tsSignupRules = d;
}
// Logins written before email_key existed, or by code that does not know it, get theirs here.
function fillKeys() {
  ready();
  for (const u of all('SELECT id, email FROM users WHERE email_key IS NULL LIMIT 2000')) run('UPDATE users SET email_key=? WHERE id=?', mailboxKey(u.email), u.id);
}

// ---- Email -------------------------------------------------------------------------------------------

/** Refuses an address with a + before the @. For every way a login is made or moved, never for a recipient. */
export function refusePlus(email: string) {
  if (plusInEmail(email)) throw bad(PLUS_REFUSAL, 400, { code: 'plus_in_email' });
}
/** The login that already has this mailbox, under this spelling or another one, or null. */
export function mailboxOwner(email: string, exceptUserId?: string | null): any {
  fillKeys();
  const exact = get('SELECT * FROM users WHERE email=?', String(email).trim().toLowerCase());
  if (exact && exact.id !== exceptUserId) return exact;
  return get('SELECT * FROM users WHERE email_key=? AND id != ? ORDER BY created_at LIMIT 1', mailboxKey(email), exceptUserId || '') || null;
}
/**
 * The whole rule for the address of a new login, or of a login that moves: no +, and no login on that mailbox yet.
 * A login with exactly this address is the caller's to refuse in its own words, so only another spelling is refused here.
 */
export function newAddressOk(email: string, exceptUserId?: string | null) {
  refusePlus(email);
  const owner = mailboxOwner(email, exceptUserId);
  if (owner && String(owner.email).toLowerCase() !== String(email).trim().toLowerCase()) throw bad(SAME_MAILBOX_REFUSAL, 409, { code: 'same_mailbox' });
}
export const emailKeyOf = (email: string) => mailboxKey(email);

// ---- Phone -------------------------------------------------------------------------------------------

const phoneKeyOf = (e164: string) => hmac(`login-tel:${e164}`).slice(0, 40);

/** The number in a request body ("phone", with "phone_country" for a number written without a country code), in international form. Refused in words when it is not a plausible number. */
export function readPhone(b: any): string {
  const r = parsePhone(str(b?.phone, 40), str(b?.phone_country, 2));
  if (!r.ok) throw bad(phoneProblemText(r.why, r.iso), 400, { code: 'phone', why: r.why });
  return r.e164;
}
/** Refused when another login has the number, unless a person who runs the server allowed it for more than one. */
export function phoneFree(e164: string, exceptUserId?: string | null) {
  ready();
  const key = phoneKeyOf(e164);
  if (get('SELECT 1 x FROM phone_shared WHERE phone_key=?', key)) return;
  if (get('SELECT 1 x FROM users WHERE phone_key=? AND id != ?', key, exceptUserId || '')) throw bad(PHONE_TAKEN, 409, { code: 'phone_taken' });
}
/** Writes the number of a login. A changed number is no longer a checked one. */
export function savePhone(userId: string, e164: string) {
  ready();
  run('UPDATE users SET phone=?, phone_key=?, phone_verified_at=NULL, phone_code=NULL WHERE id=?', seal('users.phone', e164), phoneKeyOf(e164), userId);
}

export type PhoneAsk = 'now' | 'may_wait' | 'before_send' | null;
/**
 * Where a login stands. ask: 'now' the app opens only the screen that asks (a login made since the rule); 'may_wait'
 * a login from before the rule is asked once and may say not now; 'before_send' it said not now, and is asked again
 * when it sends something new; null nothing to ask.
 */
export function phoneState(u: any): { number: string | null; verified: boolean; needed: boolean; ask: PhoneAsk; can_verify: boolean } {
  const has = typeof u?.phone === 'string' && !!u.phone;
  const needed = !has && phoneRequired() && Number(u?.phone_rule) !== 2;
  const ask: PhoneAsk = !needed ? null : Number(u?.phone_rule) === 1 ? 'now' : u?.phone_asked_at ? 'before_send' : 'may_wait';
  return { number: has ? showPhone(u.phone) : null, verified: has && !!u.phone_verified_at, needed, ask, can_verify: has && !u.phone_verified_at && !!smsProvider() };
}

/**
 * Before a person sends something new from the app, makes a key or publishes a form: their login has a number.
 * Only for a person signed in to the app. A key that already works and a form that is already public go on working,
 * so nothing that is out stops because of this rule.
 */
export function phoneBeforeSend(c: Ctx) {
  if (c.auth?.via !== 'session' || !phoneState(c.user).needed) return;
  throw bad(`${PHONE_BEFORE_SEND} It takes ten seconds, and everything you have is kept. Nothing was sent.`, 403, { code: 'phone_needed' });
}

const person = (c: Ctx) => {
  if (c.auth?.via !== 'session') throw new HttpError(403, 'An API key cannot see or change the phone number of a login. That needs a person signed in to the app.');
};

// Gives or changes the number of the login that is signed in.
route('POST', '/me/phone', async (c) => {
  person(c);
  rateLimit(`phone:${c.user.id}`, 10, 3600_000);
  const e164 = readPhone(await c.body());
  phoneFree(e164, c.user.id);
  savePhone(c.user.id, e164);
  return { ok: true, phone: phoneState(get('SELECT * FROM users WHERE id=?', c.user.id)) };
});

// "Not now", once, and only for a login from before the rule. It is asked again when it sends something new.
route('POST', '/me/phone/later', (c) => {
  person(c);
  if (phoneState(c.user).ask !== 'may_wait') throw bad('Please add your phone number to go on.', 409, { code: 'phone_needed' });
  run('UPDATE users SET phone_asked_at=? WHERE id=?', now(), c.user.id);
  return { ok: true };
});

// ---- Checking the number by code: only where the server can send text messages, and never required ----

const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const codeMark = (userId: string, code: string) => hmac(`login-tel-code:${userId}:${code}`);

route('POST', '/me/phone/code', async (c) => {
  person(c);
  if (!smsProvider()) throw bad('This server does not send text messages, so a number cannot be checked by code. Your number is saved as it is.', 404, { code: 'no_texts' });
  if (!c.user.phone) throw bad('Add your phone number first.', 409);
  if (c.user.phone_verified_at) return { ok: true, verified: true };
  rateLimit(`phone-code:${c.user.id}`, 3, 3600_000);
  rateLimit(`phone-code-ip:${c.ip}`, 10, 3600_000);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const until = new Date(Date.now() + CODE_MINUTES * 60_000).toISOString();
  run('UPDATE users SET phone_code=? WHERE id=?', JSON.stringify({ mark: codeMark(c.user.id, code), until, wrong: 0 }), c.user.id);
  // Loaded only here: the text module carries the whole signing side with it.
  const { sendText } = await import('./sms.ts');
  const sent = await sendText({ to: c.user.phone, accountId: c.account.id, kind: 'code', expiresAt: until, text: `Your GrowSigning code is ${code.slice(0, 3)} ${code.slice(3)}. It works for ${CODE_MINUTES} minutes. Nobody from GrowSigning will ask you for it.` });
  if (sent.status === 'failed') throw bad('The text message could not be sent just now. Your number is saved, and you can try the code again later.', 502, { code: 'text_failed' });
  return { ok: true, minutes: CODE_MINUTES };
});

route('POST', '/me/phone/verify', async (c) => {
  person(c);
  const typed = str((await c.body()).code, 20).replace(/\D/g, '');
  let held: any = null;
  try {
    held = JSON.parse(c.user.phone_code || 'null');
  } catch {}
  if (!c.user.phone || !held || held.until <= now() || held.wrong >= CODE_TRIES) throw bad('That code no longer works. Ask for a new one.', 410, { code: 'code_gone' });
  if (!safeEqual(codeMark(c.user.id, typed), String(held.mark))) {
    run('UPDATE users SET phone_code=? WHERE id=?', JSON.stringify({ ...held, wrong: held.wrong + 1 }), c.user.id);
    throw bad('That is not the code from the text message. Please check it and try again.', 400, { code: 'wrong_code' });
  }
  run('UPDATE users SET phone_verified_at=?, phone_code=NULL WHERE id=?', now(), c.user.id);
  return { ok: true, verified: true };
});

// ---- The people who run the server -------------------------------------------------------------------

const operator = async (c: Ctx) => {
  const { isOperator } = await import('./routes-trust.ts');
  if (!isOperator(c.user)) throw new HttpError(404, 'Not found');
};

// The people of one account with their numbers, for whoever answers a help request or looks at a report.
route('GET', '/operator/accounts/:id/people', async (c) => {
  await operator(c);
  ready();
  if (!get('SELECT 1 x FROM accounts WHERE id=?', c.params.id)) throw bad('Account not found.', 404);
  return {
    people: all('SELECT u.id, u.name, u.email, u.phone, u.phone_key, u.phone_verified_at, u.phone_rule, u.created_at, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? ORDER BY m.created_at', c.params.id).map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at,
      phone: u.phone ? showPhone(u.phone) : null, phone_verified: !!u.phone_verified_at,
      // How many other logins have the same number (more than 0 only for a number that was allowed for more).
      phone_also_on: u.phone_key ? get('SELECT COUNT(*) n FROM users WHERE phone_key=? AND id != ?', u.phone_key, u.id).n : 0,
      phone_shared: !!u.phone_key && !!get('SELECT 1 x FROM phone_shared WHERE phone_key=?', u.phone_key),
      asked: phoneState(u).ask,
    })),
  };
});

// Allows one number for more than one login (a family, a shop with one phone), or takes that back. Logins that
// already share it keep it either way.
route('POST', '/operator/phones', async (c) => {
  await operator(c);
  ready();
  const b = await c.body();
  if (typeof b.shared !== 'boolean') throw bad('Say what to change: "shared": true or false, with the "phone". Nothing was changed.');
  const key = phoneKeyOf(readPhone(b));
  if (b.shared) run('INSERT OR IGNORE INTO phone_shared (phone_key, by_user, at) VALUES (?,?,?)', key, c.user.id, now());
  else run('DELETE FROM phone_shared WHERE phone_key=?', key);
  return { ok: true, shared: b.shared };
});

// ---- Export ------------------------------------------------------------------------------------------

/** The login of whoever makes an export, with its phone number: a file of their own in the ZIP. Nobody else's number is in an export. */
export function ownLoginFile(userId: string): Buffer {
  const u = get('SELECT name, email, phone, phone_verified_at, created_at FROM users WHERE id=?', userId) || {};
  return Buffer.from(JSON.stringify({
    about: 'Your own login. The phone number is kept to keep accounts real and to reach you about your account. It is never shared and never used for marketing. It is deleted with your login.',
    name: u.name || null, email: u.email || null, phone: u.phone || null, phone_checked_by_code: !!u.phone_verified_at, created_at: u.created_at || null,
  }, null, 2));
}
