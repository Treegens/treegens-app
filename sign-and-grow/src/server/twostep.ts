// Two-step login with an authenticator app. After the password, or after Google or Microsoft, a person who has
// switched it on types the 6 digits their app shows (or one of their recovery codes) before any session exists.
// The routes are in routes-twostep.ts; this file holds the rules, so that signInAs (routes-account.ts), which ends
// every kind of sign-in, the router and the timer can all reach them.
//
// What each answer tells somebody who is guessing:
//   - A login with two-step login answers a wrong password exactly as a right one: with the second screen. Only the
//     server knows which it was (two_step_pending.password_ok). After a code, both answer "the code is not right, or
//     the password before it was not", count towards the same pause and leave the same number of tries. So a
//     password cannot be found out by trying it here, and the code adds to what has to be guessed.
//   - The pause belongs to the login, not to a browser: five wrong codes in a row, wherever they come from, pause its
//     second step for TWO_STEP_PAUSE_MINUTES, and the owner is emailed (with whether the right password came first).
//   - A code works once: the 30-second step of the last code used is kept, and a code of that step or an earlier one
//     is refused. A recovery code is deleted the moment it is used.
//   - A browser that ticked "Remember this device" skips the second step for that login alone. There a wrong
//     password is answered as on any login without two-step login, because the device is what the second step is.
// API keys are not affected (TWO_STEP_API_KEYS in src/lib/policy.ts).
import crypto from 'node:crypto';
import { all, get, run, tx } from './db.ts';
import { bad, sha256, token, now, HttpError, safeEqual, baseUrl, str } from './util.ts';
import { cookie, readCookie, type Auth } from './auth.ts';
import { sendMail } from './mail.ts';
import type { Ctx } from './router.ts';
import { TWO_STEP_TRIES, TWO_STEP_PAUSE_MINUTES, TWO_STEP_REMEMBER_DAYS, TWO_STEP_RECOVERY_CODES, TWO_STEP_EMAIL_RESET_DAYS, TWO_STEP_SIGNIN_MINUTES } from '../lib/policy.ts';

// ---- The algorithm: HOTP (RFC 4226) and TOTP (RFC 6238), the way authenticator apps do it --------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function toBase32(buf: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) out += B32[(value >>> (bits -= 5)) & 31];
  }
  return bits ? out + B32[(value << (5 - bits)) & 31] : out;
}
export function fromBase32(s: string): Buffer {
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of s.toUpperCase().replace(/[\s=-]/g, '')) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) out.push((value >>> (bits -= 8)) & 255);
  }
  return Buffer.from(out);
}

export const TOTP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS, algorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algorithm, key).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / TOTP_SECONDS);
export const totp = (key: Uint8Array, ms = Date.now(), digits = TOTP_DIGITS, algorithm = 'sha1') => hotp(key, stepAt(ms), digits, algorithm);

// The step a typed code belongs to, or -1. The step before and after now count too, because a phone's clock is often
// some seconds off and a person needs a moment to type. A step at or before `after` (the last one used) never counts:
// that is what makes a code work once.
export function matchStep(secret: string, typed: string, after = -1, ms = Date.now()): number {
  const key = fromBase32(secret);
  const s = stepAt(ms);
  for (const k of [s, s - 1, s + 1]) if (k > after && safeEqual(hotp(key, k), typed)) return k;
  return -1;
}

export const ISSUER = 'Sign&Grow';
export const otpauthUri = (secret: string, email: string) =>
  `otpauth://totp/${encodeURIComponent(`${ISSUER}:${email}`)}?${new URLSearchParams({ secret, issuer: ISSUER, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_SECONDS) })}`;

// ---- Recovery codes -------------------------------------------------------------------------------------------

// Ten characters from letters and digits that are not easily mixed up (no 0/o, 1/l/i), shown as two groups of five.
const RC = 'abcdefghjkmnpqrstuvwxyz23456789';
const newRecoveryCode = () => {
  const s = Array.from({ length: 10 }, () => RC[crypto.randomInt(RC.length)]).join('');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
};
const typedForm = (s: any) => str(s, 60).toLowerCase().replace(/[\s-]/g, '');
// Only a fingerprint is stored, salted with the login, so the list in the database opens nothing.
const recoveryHash = (userId: string, code: string) => sha256(`two-step-recovery:${userId}:${typedForm(code)}`);
const codesOf = (u: any): string[] => {
  try {
    const l = JSON.parse(u?.two_step_codes || '[]');
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
};
export const recoveryLeft = (u: any) => codesOf(u).length;
// A new set replaces every code there was. Returned once, to be shown once. Call inside tx() with the rest.
export function newRecoveryCodes(userId: string): string[] {
  const codes = Array.from({ length: TWO_STEP_RECOVERY_CODES }, newRecoveryCode);
  run('UPDATE users SET two_step_codes=? WHERE id=?', JSON.stringify(codes.map((x) => recoveryHash(userId, x))), userId);
  return codes;
}

// ---- State ----------------------------------------------------------------------------------------------------

export const twoStepOn = (u: any): boolean => !!u?.two_step_on_at && !!u?.two_step_secret;
const fresh = (userId: string) => get('SELECT * FROM users WHERE id=?', userId);

// What happened to someone's second step, and who did it. Settings shows it to them; the team card shows admins who
// reset whose.
export type LogWhat = 'on' | 'moved' | 'off' | 'codes' | 'recovery_used' | 'paused' | 'reset_by_admin' | 'email_reset_started' | 'email_reset_stopped' | 'email_reset_done' | 'devices_forgotten';
export function logStep(userId: string, what: LogWhat, by?: { id?: string; name?: string } | null, account?: { id?: string; name?: string } | null) {
  run('INSERT INTO two_step_log (user_id, at, what, by_id, by_name, account_id, account_name) VALUES (?,?,?,?,?,?,?)', userId, now(), what, by?.id || null, by?.name || null, account?.id || null, account?.name || null);
}

// Everything the second step of a login is made of goes: the secret, the recovery codes, the remembered browsers,
// sign-ins that wait for a code and a reset that was under way. Call inside tx().
export function clearTwoStep(userId: string) {
  run('UPDATE users SET two_step_secret=NULL, two_step_on_at=NULL, two_step_last_step=NULL, two_step_codes=NULL, two_step_new_secret=NULL, two_step_new_at=NULL, two_step_wrong=0, two_step_wrong_known=0, two_step_paused_until=NULL, two_step_reset_at=NULL, two_step_reset_noticed_at=NULL WHERE id=?', userId);
  run('DELETE FROM two_step_devices WHERE user_id=?', userId);
  run('DELETE FROM two_step_pending WHERE user_id=?', userId);
  run('DELETE FROM two_step_resets WHERE user_id=?', userId);
}

// A moment in the words of the person's own time zone (the browser tells us which, see GET /me), else UTC.
export function whenFor(u: any, iso: string): string {
  const d = new Date(iso);
  const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...o, timeZone: u?.tz || 'UTC' }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...o, timeZone: 'UTC' }).format(d);
  }
}
const minutesTo = (iso: string) => Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 60_000));

// ---- Typing a code ------------------------------------------------------------------------------------------

function paused(until: string): HttpError {
  const m = minutesTo(until);
  return new HttpError(429, `${TWO_STEP_TRIES} wrong codes in a row were typed for this login, so its second step is paused for ${m === 1 ? 'one more minute' : `${m} more minutes`}. Nothing else was changed, and the owner of the login was emailed about it. Wait, then type the newest code from your authenticator app.`, { code: 'two_step_paused', paused_until: until, minutes: m });
}
export const pausedUntil = (u: any): string | null => (u?.two_step_paused_until && u.two_step_paused_until > now() ? u.two_step_paused_until : null);

// A code typed for this login: the 6 digits from the app, or a recovery code. Throws in words when it is not right
// or the second step is paused. `passwordOk: false` is a sign-in whose password was wrong: nothing is checked, and
// the answer is the one a wrong code gets, so this step never says whether the password was right. `at` says where
// the code was typed, for the words of the answer.
export async function useCode(u: any, typed: any, o: { passwordOk?: boolean; at?: 'signin' | 'settings' } = {}): Promise<{ kind: 'app' | 'recovery'; left: number }> {
  const me = fresh(u.id);
  if (!twoStepOn(me)) throw bad('Two-step login is not switched on for this login, so there is no code to type.', 409, { code: 'two_step_off' });
  const until = pausedUntil(me);
  if (until) throw paused(until);
  const t = typedForm(typed);
  if (!t) throw bad('Type the 6-digit code from your authenticator app, or one of your recovery codes.', 400, { code: 'code_needed' });
  const known = o.passwordOk !== false;
  if (known && /^\d{6}$/.test(t)) {
    const k = matchStep(me.two_step_secret, t, me.two_step_last_step ?? -1);
    // Written only if no other request used this step or a later one in the meantime: two answers for one code is
    // one too many.
    if (k >= 0 && run('UPDATE users SET two_step_last_step=?, two_step_wrong=0, two_step_wrong_known=0 WHERE id=? AND (two_step_last_step IS NULL OR two_step_last_step < ?)', k, me.id, k).changes) return { kind: 'app', left: recoveryLeft(me) };
  } else if (known && /^[a-z0-9]{10}$/.test(t)) {
    const list = codesOf(me);
    const h = recoveryHash(me.id, t);
    const rest = list.filter((x) => x !== h);
    if (rest.length < list.length && run('UPDATE users SET two_step_codes=?, two_step_wrong=0, two_step_wrong_known=0 WHERE id=? AND two_step_codes=?', JSON.stringify(rest), me.id, me.two_step_codes).changes) {
      logStep(me.id, 'recovery_used');
      return { kind: 'recovery', left: rest.length };
    }
  }
  const wrong = (me.two_step_wrong || 0) + 1;
  const knownWrong = (me.two_step_wrong_known || 0) + (known ? 1 : 0);
  if (wrong >= TWO_STEP_TRIES) {
    const till = new Date(Date.now() + TWO_STEP_PAUSE_MINUTES * 60_000).toISOString();
    run('UPDATE users SET two_step_wrong=0, two_step_wrong_known=0, two_step_paused_until=? WHERE id=?', till, me.id);
    logStep(me.id, 'paused');
    await sendMail({ to: me.email, subject: 'Wrong codes were typed for your Sign&Grow login', heading: 'The second step of your login is paused',
      lines: [`${TWO_STEP_TRIES} codes in a row that were typed for your Sign&Grow login were not right, so its second step is paused until ${whenFor(me, till)}. Until then no code is accepted, also not the right one.`,
        knownWrong ? `At least one of them came after your correct password. If that was not you, someone knows your password: change it under Settings, Profile, as soon as you can sign in again (you need your code for that).` : 'None of them came after your correct password, so whoever typed them does not seem to know it.',
        'If it was you: wait, then type the newest code your authenticator app shows. Codes depend on the time, so check that the time on your phone is set automatically.'],
      cta: { label: 'Open Sign&Grow', url: `${baseUrl()}/login` } });
    throw paused(till);
  }
  run('UPDATE users SET two_step_wrong=?, two_step_wrong_known=? WHERE id=?', wrong, knownWrong, me.id);
  const left = TWO_STEP_TRIES - wrong;
  const tries = `${left === 1 ? 'One more try' : `${left} more tries`}, then the second step of this login pauses for ${TWO_STEP_PAUSE_MINUTES} minutes.`;
  throw bad(o.at === 'settings'
    ? `That code is not right, so nothing was changed. Type the newest code from your authenticator app, or one of your recovery codes. ${tries}`
    : `That did not work: the code is not right, or the password you typed before it was not. We do not say which, so that nobody can find out a password by trying it here. ${tries} Type the newest code from your app, or start again with your password.`, 401, { code: 'wrong_code', tries_left: left });
}

// For a change that needs the current code when two-step login is on: the password, the email address, the second
// step itself, and a few team settings. Without two-step login nothing is asked.
export async function needCode(c: Ctx, typed: any, what: string) {
  if (!twoStepOn(c.user)) return null;
  if (!typedForm(typed)) throw bad(`To ${what}, type the 6-digit code from your authenticator app as well, or one of your recovery codes. Nothing was changed.`, 403, { code: 'code_needed' });
  return useCode(c.user, typed, { at: 'settings' });
}

// ---- The sign-in that waits for its code -------------------------------------------------------------------------

// Over https the cookies carry the "__Host-" prefix, so a neighbouring site under the same domain cannot plant one.
const pendingCookie = (c: Ctx) => `${c.secure ? '__Host-' : ''}sg_twostep`;
// One cookie for each login, so two people who share a browser each have their own, and withdrawing one leaves the
// other. The name is a fingerprint of the login, not its id.
const deviceCookie = (c: Ctx, userId: string) => `${c.secure ? '__Host-' : ''}sg_device_${sha256(`device:${userId}`).slice(0, 12)}`;

export function pendingOf(c: Ctx): any {
  const t = readCookie(c.req, pendingCookie(c));
  return t ? get('SELECT * FROM two_step_pending WHERE id=? AND expires_at > ?', sha256(t), now()) : null;
}
export function endPending(c: Ctx, p: any) {
  run('DELETE FROM two_step_pending WHERE id=?', p.id);
  c.cookies.push(cookie(pendingCookie(c), '', 0, c.secure));
}

export function rememberedDevice(c: Ctx, u: any): any {
  const t = readCookie(c.req, deviceCookie(c, u.id));
  const d = t ? get('SELECT * FROM two_step_devices WHERE id=? AND user_id=? AND expires_at > ?', sha256(t), u.id, now()) : null;
  if (d) run('UPDATE two_step_devices SET last_used_at=?, ua=? WHERE id=?', now(), str(c.ua, 300) || d.ua, d.id);
  return d;
}
export function rememberDevice(c: Ctx, userId: string) {
  const t = token();
  const until = new Date(Date.now() + TWO_STEP_REMEMBER_DAYS * 864e5).toISOString();
  run('DELETE FROM two_step_devices WHERE user_id=? AND expires_at <= ?', userId, now());
  run('INSERT INTO two_step_devices (id, user_id, ua, created_at, last_used_at, expires_at) VALUES (?,?,?,?,?,?)', sha256(t), userId, str(c.ua, 300) || null, now(), now(), until);
  c.cookies.push(cookie(deviceCookie(c, userId), t, TWO_STEP_REMEMBER_DAYS * 86400, c.secure));
}

type Hold = { invite?: any; next?: string | null; note?: any; via?: string | null };
// No session: a line that waits for the code, tied to this browser by a cookie. What the sign-in carried (an
// invitation, the page to open afterwards, what the provider sign-in did) waits with it and is done after the code.
function hold(c: Ctx, u: any, passwordOk: boolean, o: Hold) {
  const t = token();
  run('DELETE FROM two_step_pending WHERE expires_at <= ?', now());
  // One waiting sign-in per browser: a new one replaces the one this browser had.
  const old = readCookie(c.req, pendingCookie(c));
  if (old) run('DELETE FROM two_step_pending WHERE id=?', sha256(old));
  run('INSERT INTO two_step_pending (id, user_id, password_ok, invite, next, note, via, ip, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    sha256(t), u.id, passwordOk ? 1 : 0, o.invite ? str(o.invite, 200) : null, o.next || null, o.note ? JSON.stringify(o.note) : null, o.via || null, c.ip, now(), new Date(Date.now() + TWO_STEP_SIGNIN_MINUTES * 60_000).toISOString());
  c.cookies.push(cookie(pendingCookie(c), t, TWO_STEP_SIGNIN_MINUTES * 60, c.secure));
  const until = pausedUntil(u);
  return { two_step: true as const, minutes: TWO_STEP_SIGNIN_MINUTES, paused_until: until };
}

// Called by signInAs (routes-account.ts), which ends every way of signing in: null when the sign-in goes on, or the
// answer that holds it for the second step. A reset by email whose day has come takes effect here, and the sign-in
// goes on without a second step.
export async function holdForSecondStep(c: Ctx, u: any, o: Hold = {}) {
  if (!twoStepOn(u)) return null;
  if (await resetIfDue(u)) return null;
  if (rememberedDevice(c, u)) return null;
  return hold(c, u, true, o);
}
// POST /auth/login with a wrong password: a login with two-step login answers it with the second screen, as it
// answers the right one. null means: say that the password is wrong, as for every other login.
export function holdWrongPassword(c: Ctx, u: any, invite?: any) {
  if (!u || !twoStepOn(u) || (u.two_step_reset_at && u.two_step_reset_at <= now()) || rememberedDevice(c, u)) return null;
  return hold(c, u, false, { invite });
}

// ---- Teams ----------------------------------------------------------------------------------------------------

// While an account asks everyone for two-step login, a person signed in to it without it can do only this: set it up,
// go to another workspace, leave the team, or have the confirmation email sent again. Everything else in that
// account answers 403 with "code": "two_step_setup". API keys are not affected.
const OPEN_WHILE_REQUIRED = [/^[A-Z]+ \/me\/two-step/, /^POST \/auth\/switch$/, /^POST \/account\/leave$/, /^POST \/auth\/resend-verification$/];
export function twoStepGate(auth: Auth | null, what: string) {
  if (auth?.via !== 'session' || !auth.account?.two_step_required_at || twoStepOn(auth.user)) return;
  if (OPEN_WHILE_REQUIRED.some((re) => re.test(what))) return;
  throw new HttpError(403, `${auth.account.name} asks everyone on the team to sign in with two-step login, and yours is not set up yet. Set it up first: it takes a minute with an authenticator app on your phone. Until then nothing else in ${auth.account.name} opens for you. Your other workspaces are not affected.`, { code: 'two_step_setup' });
}
// The part of GET /me about the second step.
export const twoStepMe = (c: Ctx) => {
  const on = twoStepOn(c.user);
  const required = !!c.account?.two_step_required_at;
  return { on, required, setup_required: required && !on && c.auth?.via === 'session', recovery_left: on ? recoveryLeft(c.user) : 0, reset_at: c.user?.two_step_reset_at || null };
};

// ---- Resetting it by email, for someone nobody else can reset -------------------------------------------------

// Owners: nobody else can reset an owner's second step (an admin may not take the owner's place), so they use the
// reset by email. Someone who owns nothing has a team owner who can.
export const ownsAnAccount = (userId: string) => !!get("SELECT 1 x FROM memberships WHERE user_id=? AND role='owner' LIMIT 1", userId);

export async function startEmailReset(u: any): Promise<string> {
  const at = u.two_step_reset_at || new Date(Date.now() + TWO_STEP_EMAIL_RESET_DAYS * 864e5).toISOString();
  if (!u.two_step_reset_at) {
    run('UPDATE users SET two_step_reset_at=?, two_step_reset_noticed_at=? WHERE id=?', at, now(), u.id);
    logStep(u.id, 'email_reset_started');
    await mailReset(u, at, 'start');
  }
  return at;
}
async function mailReset(u: any, at: string, kind: 'start' | 'daily') {
  const days = Math.max(1, Math.ceil((Date.parse(at) - Date.now()) / 864e5));
  await sendMail({ to: u.email, subject: kind === 'start' ? 'Two-step login of your Sign&Grow login will be switched off' : `Reminder: two-step login of your Sign&Grow login goes off in ${days === 1 ? 'one day' : `${days} days`}`,
    heading: 'Your second step is being reset',
    lines: [`Someone who knew the password of your Sign&Grow login said they lost the phone with the authenticator app and the recovery codes, and opened the link we emailed here. So two-step login will be switched off on ${whenFor(u, at)}. From then on your password alone signs in, until you set it up again.`,
      `We email you about it every day until then. If this was you, there is nothing to do but wait.`,
      'If it was not you: sign in with your password and the code from your app (or a recovery code), and the reset stops. In a browser where you are still signed in, Settings, Profile has a Stop button. Then change your password and the password of this mailbox, because someone has both.'],
    cta: { label: 'Stop it under Settings', url: `${baseUrl()}/app/settings?tab=profile#two-step` } });
}
export async function stopEmailReset(u: any, how: 'signed_in' | 'settings'): Promise<boolean> {
  if (!run('UPDATE users SET two_step_reset_at=NULL, two_step_reset_noticed_at=NULL WHERE id=? AND two_step_reset_at IS NOT NULL', u.id).changes) return false;
  logStep(u.id, 'email_reset_stopped');
  await sendMail({ to: u.email, subject: 'The reset of your two-step login was stopped', heading: 'Two-step login stays on',
    lines: [how === 'signed_in' ? 'Someone signed in to your Sign&Grow login with the code from your authenticator app or a recovery code, so the reset of your second step that was under way has stopped.' : 'The reset of your second step that was under way was stopped under Settings, in a browser that is signed in to your login.',
      'Two-step login stays on as it was. If you did not start the reset, someone knows your password and can read this mailbox: change both.'] });
  return true;
}
// The day has come: off, in words, to the person.
export async function resetIfDue(u: any): Promise<boolean> {
  if (!u?.two_step_reset_at || u.two_step_reset_at > now()) return false;
  if (!tx(() => {
    if (!get('SELECT 1 x FROM users WHERE id=? AND two_step_reset_at IS NOT NULL AND two_step_reset_at <= ?', u.id, now())) return false;
    clearTwoStep(u.id);
    logStep(u.id, 'email_reset_done');
    return true;
  })) return false;
  await sendMail({ to: u.email, subject: 'Two-step login of your Sign&Grow login is off', heading: 'Your second step was reset',
    lines: [`As announced, two-step login of your Sign&Grow login was switched off ${TWO_STEP_EMAIL_RESET_DAYS} days after the reset was started. Your password alone signs in now.`,
      'Set it up again under Settings, Profile, with the authenticator app on your new phone. If a team you are on asks for it, you are asked to do that the next time you sign in.',
      'If you did not ask for this, someone knows your password and can read this mailbox: change both, and write to us through the help page.'],
    cta: { label: 'Set it up again', url: `${baseUrl()}/app/settings?tab=profile#two-step` } });
  return true;
}

// The timer (cron.ts): a reset by email that is due takes effect, one under way is announced once a day, and lines
// that ran out are cleared.
export async function twoStepTick() {
  let reminded = 0, switched_off = 0;
  for (const u of all('SELECT * FROM users WHERE two_step_reset_at IS NOT NULL')) {
    if (u.two_step_reset_at <= now()) {
      if (await resetIfDue(u)) switched_off++;
    } else if (Date.now() - (Date.parse(u.two_step_reset_noticed_at || '') || 0) >= 23 * 3600_000) {
      run('UPDATE users SET two_step_reset_noticed_at=? WHERE id=?', now(), u.id);
      await mailReset(u, u.two_step_reset_at, 'daily');
      reminded++;
    }
  }
  run('DELETE FROM two_step_pending WHERE expires_at <= ?', now());
  run('DELETE FROM two_step_devices WHERE expires_at <= ?', now());
  run('DELETE FROM two_step_resets WHERE expires_at <= ?', now());
  return { reminded, switched_off };
}
