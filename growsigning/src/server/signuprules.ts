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
import type { Ctx } from './router.ts';
import { all, db, get, run } from './db.ts';
import { bad, hmac, str, HttpError } from './util.ts';
import { seal } from './colcrypt.ts';
import { smsProvider } from '../lib/checks.ts';
import { isDeploymentBilling } from '../lib/billingmode.ts';
import { plusInEmail, oddEmail, mailboxKey, parsePhone, phoneProblemText, showPhone, phoneTakenHelp, PLUS_REFUSAL, ODD_EMAIL_REFUSAL, SAME_MAILBOX_REFUSAL, PHONE_TAKEN, PHONE_BEFORE_SEND } from '../lib/signup.ts';
import type { Auth } from './auth.ts';

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
export function ready() {
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
  // Quotes before the @ or a dot at the very end: other spellings of a mailbox that may already have a login.
  if (oddEmail(email)) throw bad(ODD_EMAIL_REFUSAL, 400, { code: 'odd_email' });
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

export const phoneKeyOf = (e164: string) => hmac(`login-tel:${e164}`).slice(0, 40);

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
  // Only a login whose email address is confirmed holds a number against other people. One that never confirmed
  // its address (a typo by an honest person, or someone parking a number that is not theirs) gives way: see
  // savePhone, which takes the number off it when the next person gives it.
  if (get('SELECT 1 x FROM users WHERE phone_key=? AND id != ? AND email_verified=1', key, exceptUserId || ''))
    throw bad(`${PHONE_TAKEN} ${phoneTakenHelp((process.env.SUPPORT_EMAIL || '').trim() || null)}`, 409, { code: 'phone_taken' });
}
/** Writes the number of a login. A changed number is no longer a checked one. */
export function savePhone(userId: string, e164: string) {
  ready();
  const key = phoneKeyOf(e164);
  // A login that never confirmed its email address does not keep a number someone else now gives (phoneFree let
  // them through). It is asked for its number again the next time it is used. Not for a number allowed for several.
  if (!get('SELECT 1 x FROM phone_shared WHERE phone_key=?', key)) run('UPDATE users SET phone=NULL, phone_key=NULL, phone_verified_at=NULL, phone_code=NULL WHERE phone_key=? AND id != ? AND email_verified=0', key, userId);
  run('UPDATE users SET phone=?, phone_key=?, phone_verified_at=NULL, phone_code=NULL WHERE id=?', seal('users.phone', e164), key, userId);
}

export type PhoneAsk = 'now' | 'may_wait' | 'before_send' | null;
/**
 * Where a login stands. ask: 'now' the app opens only the screen that asks (a login made since the rule); 'may_wait'
 * a login from before the rule is asked once and may say not now; 'before_send' it said not now, and is asked again
 * when it sends something new; null nothing to ask.
 */
export function phoneState(u: any): { number: string | null; verified: boolean; needed: boolean; ask: PhoneAsk; can_verify: boolean } {
  const has = typeof u?.phone === 'string' && !!u.phone;
  // "Has the login given a number" is read from its fingerprint, which is never encrypted: a server whose encryption
  // key is missing for a while cannot read the number, and must not ask everyone for it again or shut them out.
  const needed = !has && !u?.phone_key && phoneRequired() && Number(u?.phone_rule) !== 2;
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

// What a login that has to give its number first ('now') may still do: read, give the number, sign out, switch
// workspace, confirm its email address, ask for help, and what is about the login itself and may be asked of it by a
// team before anything else (two-step login, a longer password, where it is signed in, leaving a team, closing the
// login). Everything else waits, on the server and not only on the screen, so nothing reaches other people from a
// login nobody can be reached at.
const OPEN_WITHOUT_PHONE = [/^GET /, /^POST \/me\/phone/, /^POST \/auth\//, /^POST \/me\/delete$/, /^POST \/me\/email\/confirm/, /^POST \/(support|help)\b/,
  /^[A-Z]+ \/me\/two-step/, /^POST \/me\/password$/, /^[A-Z]+ \/me\/sessions/, /^[A-Z]+ \/me\/idle/, /^POST \/account\/leave$/];
export function phoneGate(auth: Auth | null, what: string) {
  if (auth?.via !== 'session' || phoneState(auth.user).ask !== 'now') return;
  if (OPEN_WITHOUT_PHONE.some((re) => re.test(what))) return;
  throw new HttpError(403, 'Please add your phone number first. It takes ten seconds. Until then nothing else can be done with this login, and nothing was changed.', { code: 'phone_needed' });
}

// ---- Export ------------------------------------------------------------------------------------------

/** The login of whoever makes an export, with its phone number: a file of their own in the ZIP. Nobody else's number is in an export. */
export function ownLoginFile(userId: string): Buffer {
  const u = get('SELECT name, email, phone, phone_verified_at, created_at FROM users WHERE id=?', userId) || {};
  return Buffer.from(JSON.stringify({
    about: 'Your own login. The phone number is kept to keep accounts real and to reach you about your account. It is never shared and never used for marketing. It is deleted with your login.',
    name: u.name || null, email: u.email || null, phone: u.phone || null, phone_checked_by_code: !!u.phone_verified_at, created_at: u.created_at || null,
  }, null, 2));
}
