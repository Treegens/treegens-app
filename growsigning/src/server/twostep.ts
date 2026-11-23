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
import { cookie, readCookie, SESSION_COOKIE, type Auth } from './auth.ts';
import { sendMail } from './mail.ts';
import { record } from './seclog.ts';
import { floorForAccount } from './orgs.ts';
import type { Ctx } from './router.ts';
import { TWO_STEP_TRIES, TWO_STEP_PAUSE_MINUTES, TWO_STEP_REMEMBER_DAYS, TWO_STEP_RECOVERY_CODES, TWO_STEP_EMAIL_RESET_DAYS, TWO_STEP_SIGNIN_MINUTES, TWO_STEP_RESET_BLOCK_DAYS } from '../lib/policy.ts';

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

export const ISSUER = 'GrowSigning';
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
export type LogWhat = 'on' | 'moved' | 'off' | 'codes' | 'recovery_used' | 'paused' | 'reset_by_admin' | 'email_reset_started' | 'email_reset_stopped' | 'email_reset_done' | 'devices_forgotten' | 'lost_asked' | 'email_reset_off' | 'email_reset_on';
export function logStep(userId: string, what: LogWhat, by?: { id?: string; name?: string } | null, account?: { id?: string; name?: string } | null) {
  run('INSERT INTO two_step_log (user_id, at, what, by_id, by_name, account_id, account_name) VALUES (?,?,?,?,?,?,?)', userId, now(), what, by?.id || null, by?.name || null, account?.id || null, account?.name || null);
}

// Everything the second step of a login is made of goes: the secret, the recovery codes, the remembered browsers,
// sign-ins that wait for a code and a reset that was under way. Call inside tx().
export function clearTwoStep(userId: string) {
  run('UPDATE users SET two_step_secret=NULL, two_step_on_at=NULL, two_step_last_step=NULL, two_step_codes=NULL, two_step_new_secret=NULL, two_step_new_at=NULL, two_step_wrong=0, two_step_wrong_known=0, two_step_paused_until=NULL, two_step_reset_at=NULL, two_step_reset_noticed_at=NULL, two_step_reset_stopped_at=NULL WHERE id=?', userId);
  for (const t of ['two_step_devices', 'two_step_pending', 'two_step_resets', 'two_step_tries', 'two_step_stops']) run(`DELETE FROM ${t} WHERE user_id=?`, userId);
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

const minutesWords = (m: number) => (m === 1 ? 'one more minute' : `${m} more minutes`);
function paused(until: string, at: 'signin' | 'settings' = 'signin'): HttpError {
  const m = minutesTo(until);
  return new HttpError(429, at === 'settings'
    ? `${TWO_STEP_TRIES} wrong codes in a row were typed in this browser, so changes here that need a code are paused for ${minutesWords(m)}. Nothing was changed. Wait, then type the newest code from your authenticator app, or a recovery code.`
    : `${TWO_STEP_TRIES} wrong codes in a row were typed for this login, so its second step is paused for ${minutesWords(m)}. Nothing else was changed. Wait, then type the newest code from your authenticator app, or a recovery code. When this happens after the right password, the owner of the login is emailed (once a day at most).`,
  { code: 'two_step_paused', paused_until: until, minutes: m });
}
export const pausedUntil = (u: any): string | null => (u?.two_step_paused_until && u.two_step_paused_until > now() ? u.two_step_paused_until : null);

// Wrong codes are counted where they can do harm, and nowhere else (the owner's decision: five wrong codes pause for
// TWO_STEP_PAUSE_MINUTES, nobody can lock anyone else out, and parallel requests get no extra tries):
//   - After the right first step (the password, or Google or Microsoft): on the login itself. The fifth in a row
//     pauses its second step for everyone, and emails the owner (once a day at most). Only someone who has the
//     password can do that, and then its owner should hear of it.
//   - After a wrong password: on that login and that internet address only, because a stranger who does not know
//     the password must not keep its owner out. Nothing is checked there anyway. The words and the count are the
//     same as after the right password (which counts on its address too), so neither says which it was; and the right
//     code after the right password, from the app or a recovery code, still gets through such a pause.
//   - Under Settings, in a browser that is signed in: on that browser, so that a pause from sign-in attempts never
//     keeps the owner from changing a password someone else knows.
// A try is taken by one conditional UPDATE before the code is looked at, and the fifth sets the pause in that same
// statement, so requests sent at the same moment find it set and are never checked. A right code takes it back.
const ipKey = (userId: string, ip?: string) => `ip:${userId}:${ip || 'unknown'}`;
const triesPausedUntil = (key: string): string | null => get('SELECT paused_until p FROM two_step_tries WHERE key=? AND paused_until > ?', key, now())?.p || null;
type Try = { n: number; until: string | null };
function takeLoginTry(userId: string, till: string): Try | null {
  return get(`UPDATE users SET two_step_wrong = CASE WHEN two_step_paused_until IS NOT NULL THEN 1 ELSE two_step_wrong + 1 END,
      two_step_paused_until = CASE WHEN (CASE WHEN two_step_paused_until IS NOT NULL THEN 1 ELSE two_step_wrong + 1 END) >= ? THEN ? ELSE NULL END
    WHERE id=? AND (two_step_paused_until IS NULL OR two_step_paused_until <= ?) RETURNING two_step_wrong n, two_step_paused_until until`, TWO_STEP_TRIES, till, userId, now()) || null;
}
function takeTry(key: string, userId: string, till: string): Try | null {
  return get(`INSERT INTO two_step_tries (key, user_id, wrong, paused_until, at) VALUES (?,?,1,?,?)
    ON CONFLICT(key) DO UPDATE SET wrong = CASE WHEN paused_until IS NOT NULL THEN 1 ELSE wrong + 1 END,
      paused_until = CASE WHEN (CASE WHEN paused_until IS NOT NULL THEN 1 ELSE wrong + 1 END) >= ? THEN ? ELSE NULL END, at = excluded.at
    WHERE paused_until IS NULL OR paused_until <= ? RETURNING wrong n, paused_until until`, key, userId, TWO_STEP_TRIES <= 1 ? till : null, now(), TWO_STEP_TRIES, till, now()) || null;
}
// The pause the second screen shows for a waiting sign-in: the login's, else that of its internet address. The same
// for a right and a wrong password.
export const pausedFor = (u: any, ip?: string): string | null => pausedUntil(fresh(u.id)) || triesPausedUntil(ipKey(u.id, ip));

// A code typed for this login: the 6 digits from the app, or a recovery code. Throws in words when it is not right
// or the second step is paused. `passwordOk: false` is a sign-in whose password was wrong: nothing is checked, and
// the answer is the one a wrong code gets, so this step never says whether the password was right. `at` says where
// the code was typed; `ip` (sign-in) and `session` (Settings) say where its tries are counted.
export async function useCode(u: any, typed: any, o: { passwordOk?: boolean; at?: 'signin' | 'settings'; ip?: string; session?: string | null } = {}): Promise<{ kind: 'app' | 'recovery'; left: number }> {
  const me = fresh(u.id);
  if (!twoStepOn(me)) throw bad('Two-step login is not switched on for this login, so there is no code to type.', 409, { code: 'two_step_off' });
  const t = typedForm(typed);
  if (!t) throw bad('Type the 6-digit code from your authenticator app, or one of your recovery codes.', 400, { code: 'code_needed' });
  const known = o.passwordOk !== false;
  const at = o.at === 'settings' ? 'settings' : 'signin';
  const till = new Date(Date.now() + TWO_STEP_PAUSE_MINUTES * 60_000).toISOString();
  const side = at === 'settings' ? `session:${o.session || me.id}` : ipKey(me.id, o.ip);
  let login: Try | null = null;
  let mine: Try | null = null;
  const sidePaused = triesPausedUntil(side);
  if (at === 'signin') {
    const lp = pausedUntil(me);
    if (lp) throw paused(lp);
    if (!known) {
      // A wrong password: counted on its address, and that is all.
      if (sidePaused || !(mine = takeTry(side, me.id, till))) throw paused(sidePaused || triesPausedUntil(side) || till);
    } else {
      if (!(login = takeLoginTry(me.id, till))) throw paused(pausedUntil(fresh(me.id)) || till);
      if (!sidePaused) mine = takeTry(side, me.id, till);
    }
  } else if (sidePaused || !(mine = takeTry(side, me.id, till))) throw paused(sidePaused || triesPausedUntil(side) || till, 'settings');
  let ok: { kind: 'app' | 'recovery'; left: number } | null = null;
  if (known && /^\d{6}$/.test(t)) {
    const k = matchStep(me.two_step_secret, t, me.two_step_last_step ?? -1);
    // Written only if no other request used this step or a later one in the meantime: two answers for one code is
    // one too many.
    if (k >= 0 && run('UPDATE users SET two_step_last_step=? WHERE id=? AND (two_step_last_step IS NULL OR two_step_last_step < ?)', k, me.id, k).changes) ok = { kind: 'app', left: recoveryLeft(me) };
  } else if (known && /^[a-z0-9]{10}$/.test(t)) {
    const list = codesOf(me);
    const h = recoveryHash(me.id, t);
    const rest = list.filter((x) => x !== h);
    if (rest.length < list.length && run('UPDATE users SET two_step_codes=? WHERE id=? AND two_step_codes=?', JSON.stringify(rest), me.id, me.two_step_codes).changes) {
      logStep(me.id, 'recovery_used');
      ok = { kind: 'recovery', left: rest.length };
    }
  }
  if (ok) {
    // Right: the count starts again, and a pause this very try set is taken back.
    if (login) run('UPDATE users SET two_step_wrong=0, two_step_wrong_known=0, two_step_paused_until=CASE WHEN two_step_paused_until=? THEN NULL ELSE two_step_paused_until END WHERE id=?', till, me.id);
    run('DELETE FROM two_step_tries WHERE key=?', side);
    return ok;
  }
  // The login's own pause is the one its owner hears about: it means someone typed the right first step.
  if (login?.until || (at === 'settings' && mine?.until)) {
    logStep(me.id, 'paused');
    if (run('UPDATE users SET two_step_paused_mail_at=? WHERE id=? AND (two_step_paused_mail_at IS NULL OR two_step_paused_mail_at <= ?)', now(), me.id, new Date(Date.now() - 864e5).toISOString()).changes)
      await sendMail({ to: me.email, subject: 'Wrong codes were typed for your GrowSigning login', heading: 'The second step of your login is paused',
        lines: [at === 'settings'
          ? `${TWO_STEP_TRIES} codes in a row that were typed under Settings, in a browser signed in to your GrowSigning login, were not right, so changes that need a code are paused in that browser until ${whenFor(me, till)}.`
          : `${TWO_STEP_TRIES} codes in a row that were typed for your GrowSigning login were not right, so its second step is paused until ${whenFor(me, till)}. They came after your correct password (or after Google or Microsoft), so whoever typed them got past the first step.`,
        'If that was not you, someone knows your password: change it under Settings, Security. Pauses from signing in do not stop you there, in a browser where you are signed in. Or use "Forgot password" on the sign-in page.',
        'If it was you: wait, then type the newest code your authenticator app shows. Codes depend on the time, so check that the time on your phone is set automatically.',
        'We email you about this at most once a day. Settings, Security lists every pause under "What happened to your second step".'],
        cta: { label: 'Open GrowSigning', url: `${baseUrl()}/login` } });
  }
  if (login?.until || mine?.until || sidePaused) throw paused(login?.until || mine?.until || sidePaused!, at);
  const left = TWO_STEP_TRIES - (mine?.n ?? login?.n ?? 1);
  const tries = at === 'settings'
    ? `${left === 1 ? 'One more try' : `${left} more tries`}, then changes here that need a code pause for ${TWO_STEP_PAUSE_MINUTES} minutes.`
    : `${left === 1 ? 'One more try' : `${left} more tries`}, then the second step of this login pauses for ${TWO_STEP_PAUSE_MINUTES} minutes.`;
  throw bad(at === 'settings'
    ? `That code is not right, so nothing was changed. Type the newest code from your authenticator app, or one of your recovery codes. ${tries}`
    : `That did not work: the code is not right, or the password you typed before it was not. We do not say which, so that nobody can find out a password by trying it here. ${tries} Type the newest code from your app, or start again with your password.`, 401, { code: 'wrong_code', tries_left: left });
}

// For a change that needs the current code when two-step login is on: the password, the email address, the second
// step itself, and a few team settings. Without two-step login nothing is asked.
export async function needCode(c: Ctx, typed: any, what: string) {
  if (!twoStepOn(c.user)) return null;
  if (!typedForm(typed)) throw bad(`To ${what}, type the 6-digit code from your authenticator app as well, or one of your recovery codes. Nothing was changed.`, 403, { code: 'code_needed' });
  return useCode(c.user, typed, { at: 'settings', session: c.auth?.sessionId || null });
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

const deviceOf = (c: Ctx, u: any): any => {
  const t = readCookie(c.req, deviceCookie(c, u.id));
  return t ? get('SELECT * FROM two_step_devices WHERE id=? AND user_id=? AND expires_at > ?', sha256(t), u.id, now()) : null;
};
export function rememberedDevice(c: Ctx, u: any): any {
  const d = deviceOf(c, u);
  if (d) run('UPDATE two_step_devices SET last_used_at=?, ua=? WHERE id=?', now(), str(c.ua, 300) || d.ua, d.id);
  return d;
}
// Returns the id of the device row, so that the session made with it can be tied to it (sessionMade).
export function rememberDevice(c: Ctx, userId: string): string {
  const t = token();
  const until = new Date(Date.now() + TWO_STEP_REMEMBER_DAYS * 864e5).toISOString();
  run('DELETE FROM two_step_devices WHERE user_id=? AND expires_at <= ?', userId, now());
  run('INSERT INTO two_step_devices (id, user_id, ua, created_at, last_used_at, expires_at) VALUES (?,?,?,?,?,?)', sha256(t), userId, str(c.ua, 300) || null, now(), now(), until);
  c.cookies.push(cookie(deviceCookie(c, userId), t, TWO_STEP_REMEMBER_DAYS * 86400, c.secure));
  return sha256(t);
}
// Whether a sign-in of this login in this browser will stop for a code: what holdForSecondStep decides, without doing
// it. The Google and Microsoft callback asks first, because with a code to come it connects nothing yet.
export const secondStepWaits = (c: Ctx, u: any): boolean => twoStepOn(u) && !(u.two_step_reset_at && u.two_step_reset_at <= now()) && !deviceOf(c, u);

// Every sign-in that passed the second step (a code, a recovery code or a remembered device) does this before its
// session is made: a reset by email that was under way stops, one that was stopped may be asked for again, and the
// session to come is tied to the device that let it in, so that withdrawing the device signs it out (sessionMade).
export async function passedSecondStep(c: Ctx, u: any, how: 'signed_in' | 'device', deviceId?: string | null): Promise<boolean> {
  run('UPDATE users SET two_step_reset_stopped_at=NULL WHERE id=? AND two_step_reset_stopped_at IS NOT NULL', u.id);
  const stopped = await stopEmailReset(u, how);
  // Kept on this request only, for signInAs, which makes the session a moment later.
  (c as any).twoStepPassed = { device: deviceId || null, stopped };
  return stopped;
}
// Called by signInAs (routes-account.ts) right after it made the session: ties it to the remembered device, and says
// whether a reset by email stopped, for the first screen.
export function sessionMade(c: Ctx): { reset_stopped?: true } {
  const s = (c as any).twoStepPassed;
  if (!s) return {};
  const ck = [...c.cookies].reverse().find((x) => x.startsWith(`${SESSION_COOKIE}=`));
  const t = ck ? decodeURIComponent(ck.slice(SESSION_COOKIE.length + 1).split(';')[0]) : '';
  if (s.device && t) run('UPDATE sessions SET two_step_device=? WHERE id=?', s.device, sha256(t));
  return s.stopped ? { reset_stopped: true } : {};
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
  return { two_step: true as const, minutes: TWO_STEP_SIGNIN_MINUTES, paused_until: pausedFor(u, c.ip) };
}

// Called by signInAs (routes-account.ts), which ends every way of signing in: null when the sign-in goes on, or the
// answer that holds it for the second step. A reset by email whose day has come takes effect here, and the sign-in
// goes on without a second step. A remembered device is the second step of this login, so it counts as passing it.
export async function holdForSecondStep(c: Ctx, u: any, o: Hold = {}) {
  if (!twoStepOn(u)) return null;
  if (await resetIfDue(u)) return null;
  const d = rememberedDevice(c, u);
  if (d) {
    await passedSecondStep(c, u, 'device', d.id);
    return null;
  }
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
// go to another workspace, leave the team, have the confirmation email sent again, see and end where they are signed
// in, or close their login. Those are about the login, not the account. Everything else in that account answers 403
// with "code": "two_step_setup". API keys are not affected.
const OPEN_WHILE_REQUIRED = [/^[A-Z]+ \/me\/two-step/, /^POST \/me\/phone/, /^POST \/auth\/switch$/, /^POST \/account\/leave$/, /^POST \/auth\/resend-verification$/, /^POST \/auth\/verify-code$/, /^[A-Z]+ \/me\/sessions/, /^POST \/me\/delete$/];
export function twoStepGate(auth: Auth | null, what: string) {
  if (auth?.via !== 'session' || !auth.account?.two_step_required_at || twoStepOn(auth.user)) return;
  if (OPEN_WHILE_REQUIRED.some((re) => re.test(what))) return;
  // An organisation above the account may be the one asking (src/server/orgs.ts): it is named, never the agency.
  const by = auth.account.org_id ? floorForAccount(auth.account.id).from.two_step_required : undefined;
  throw new HttpError(403, `${by ? `${by} asks everyone in ${auth.account.name}` : `${auth.account.name} asks everyone on the team`} to sign in with two-step login, and yours is not set up yet. Set it up first: it takes a minute with an authenticator app on your phone. Until then nothing else in ${auth.account.name} opens for you. Your other workspaces are not affected.`, { code: 'two_step_setup' });
}
// The part of GET /me about the second step: null for an API key, which reads nothing of it. reset_at is what every
// page of the app shows while a reset by email is under way (AppShell).
export const twoStepMe = (c: Ctx) => {
  if (c.auth?.via !== 'session') return null;
  const on = twoStepOn(c.user);
  const required = !!c.account?.two_step_required_at;
  return { on, required, setup_required: required && !on, recovery_left: on ? recoveryLeft(c.user) : 0, reset_at: c.user?.two_step_reset_at || null };
};

// ---- Resetting it, without phone and recovery codes -------------------------------------------------------------

export const ownsAnAccount = (userId: string) => !!get("SELECT 1 x FROM memberships WHERE user_id=? AND role='owner' LIMIT 1", userId);
// The teams whose owner or admins may switch this person's second step off (the owner's decision): a team they are
// on but do not own, while they are not an owner or admin of any other workspace. Switching it off would open that
// other workspace too, and nobody on this team speaks for it. Everyone else has the reset by email, or nothing.
export function adminResetTeams(userId: string): string[] {
  const ms: any[] = all('SELECT account_id, role FROM memberships WHERE user_id=?', userId);
  return ms.filter((m) => m.role !== 'owner' && !ms.some((o) => o.account_id !== m.account_id && (o.role === 'owner' || o.role === 'admin'))).map((m) => m.account_id);
}

// The reset by email, as the owner decided it: it needs the right password first (whoever lost the phone still
// knows it), only one waits at a time, and it takes effect TWO_STEP_EMAIL_RESET_DAYS after its link was opened. Every
// day until then an email says so, with a link that stops it without signing in, and every page of the app says so in
// every browser that is signed in (AppShell). Any sign-in that passes the second step stops it at once (a remembered
// device too), and so does changing the password while signed in. Stopped any other way, a new one waits
// TWO_STEP_RESET_BLOCK_DAYS unless the person signs in with the second step first. Each person can switch it off
// under Settings, Security.
export const emailResetAllowed = (u: any): boolean => !u?.two_step_email_reset_off;
export const resetBlockedUntil = (u: any): string | null => {
  const at = Date.parse(u?.two_step_reset_stopped_at || '');
  const until = at ? new Date(at + TWO_STEP_RESET_BLOCK_DAYS * 864e5).toISOString() : null;
  return until && until > now() ? until : null;
};
// Each email about a reset under way has its own link that stops it. All of them stop working when the reset ends.
function stopUrl(userId: string): string {
  const t = token();
  run('INSERT INTO two_step_stops (token_hash, user_id, created_at) VALUES (?,?,?)', sha256(t), userId, now());
  return `${baseUrl()}/two-step-reset?stop=${t}`;
}

export async function startEmailReset(u: any): Promise<string> {
  const at = new Date(Date.now() + TWO_STEP_EMAIL_RESET_DAYS * 864e5).toISOString();
  // Only one waits at a time: a second link opened meanwhile changes nothing.
  if (!run('UPDATE users SET two_step_reset_at=?, two_step_reset_noticed_at=? WHERE id=? AND two_step_reset_at IS NULL', at, now(), u.id).changes) return fresh(u.id)?.two_step_reset_at || at;
  logStep(u.id, 'email_reset_started');
  await mailReset(fresh(u.id), at, 'start');
  return at;
}
export async function mailReset(u: any, at: string, kind: 'start' | 'daily' | 'again') {
  const days = Math.max(1, Math.ceil((Date.parse(at) - Date.now()) / 864e5));
  await sendMail({ to: u.email, subject: kind === 'start' ? 'Two-step login of your GrowSigning login will be switched off' : kind === 'again' ? 'A reset of your two-step login is already under way' : `Reminder: two-step login of your GrowSigning login goes off in ${days === 1 ? 'one day' : `${days} days`}`,
    heading: 'Your second step is being reset',
    lines: [`Someone who typed the right password of your GrowSigning login said they lost the phone with the authenticator app and the recovery codes, and opened the link we emailed here. So two-step login of your login will be switched off on ${whenFor(u, at)}. From then on signing in asks for no code, until you set it up again.`,
      ...(kind === 'again' ? ['It was asked for again just now. Only one reset waits at a time, so nothing else changed.'] : []),
      'We email you about it every day until then, and every browser where you are signed in to GrowSigning says so on every page. If this was you, there is nothing to do but wait.',
      'If it was not you: stop it with the button below. It works without signing in. Signing in with your code, a recovery code or a remembered device stops it as well. Then change your password and the password of this mailbox, because someone has both.'],
    cta: { label: 'Stop the reset', url: stopUrl(u.id) } });
}
type StopHow = 'signed_in' | 'device' | 'settings' | 'link' | 'password' | 'off';
const STOPPED_BY: Record<StopHow, string> = {
  signed_in: 'Someone signed in to your GrowSigning login with the code from your authenticator app or a recovery code',
  device: 'Someone signed in to your GrowSigning login on a device that is remembered for it, which skips the second step',
  settings: 'It was stopped under Settings, in a browser that is signed in to your GrowSigning login',
  link: 'It was stopped with the link in one of our emails about it',
  password: 'The password of your GrowSigning login was changed in a browser that is signed in to it',
  off: 'The reset by email was switched off under Settings, in a browser that is signed in to your GrowSigning login',
};
export async function stopEmailReset(u: any, how: StopHow): Promise<boolean> {
  // After a sign-in with the second step the phone (or a device that stands for it) is there, so nothing waits. Any
  // other stop makes the next reset wait, so that a reset cannot be started over and over.
  const block = how === 'signed_in' || how === 'device' ? null : now();
  if (!run('UPDATE users SET two_step_reset_at=NULL, two_step_reset_noticed_at=NULL, two_step_reset_stopped_at=COALESCE(?, two_step_reset_stopped_at) WHERE id=? AND two_step_reset_at IS NOT NULL', block, u.id).changes) return false;
  run('DELETE FROM two_step_stops WHERE user_id=?', u.id);
  logStep(u.id, 'email_reset_stopped');
  const again = block ? new Date(Date.parse(block) + TWO_STEP_RESET_BLOCK_DAYS * 864e5).toISOString() : null;
  await sendMail({ to: u.email, subject: 'The reset of your two-step login was stopped', heading: 'Two-step login stays on',
    lines: [`${STOPPED_BY[how]}, so the reset of your second step that was under way has stopped.`,
      `Two-step login stays on as it was.${again ? ` A new reset by email can be asked for from ${whenFor(u, again)}, or sooner after you sign in with your code.` : ''}`,
      'If you did not start the reset, someone knows your password and can read this mailbox: change both.'] });
  return true;
}
// The password changed (POST /me/password, or a reset by email in POST /auth/reset). A sign-in that typed the old
// one and waits for its code ends, and so does an emailed link that would start a reset by email: both were earned
// with the old password. Changed while signed in (with the code, if two-step login is on), it also stops a reset by
// email that was under way, as the owner decided.
export async function passwordChanged(u: any, how: 'settings' | 'email') {
  run('DELETE FROM two_step_pending WHERE user_id=?', u.id);
  run('DELETE FROM two_step_resets WHERE user_id=?', u.id);
  if (how === 'settings') await stopEmailReset(u, 'password');
}

// The day has come: off, in words, to the person. Every browser that is signed in is signed out too, so that someone
// who did not ask for it notices at once (and a lost phone that was signed in is out).
export async function resetIfDue(u: any): Promise<boolean> {
  if (!u?.two_step_reset_at || u.two_step_reset_at > now()) return false;
  if (!tx(() => {
    if (!get('SELECT 1 x FROM users WHERE id=? AND two_step_reset_at IS NOT NULL AND two_step_reset_at <= ?', u.id, now())) return false;
    clearTwoStep(u.id);
    run('DELETE FROM sessions WHERE user_id=?', u.id);
    logStep(u.id, 'email_reset_done');
    record('two_step.reset', { by: { type: 'system' }, member: u.id, about: ['user', u.id], details: { how: 'by_email_after_waiting' } });
    return true;
  })) return false;
  await sendMail({ to: u.email, subject: 'Two-step login of your GrowSigning login is off', heading: 'Your second step was reset',
    lines: [`As announced, two-step login of your GrowSigning login was switched off ${TWO_STEP_EMAIL_RESET_DAYS} days after the reset was started. Signing in asks for no code now, and every browser that was signed in was signed out.`,
      'Set it up again under Settings, Security, with the authenticator app on your new phone. If a team you are on asks for it, you are asked to do that the next time you sign in.',
      'If you did not ask for this, someone knows your password and can read this mailbox: change both, set two-step login up again (that signs out every other browser), and write to us through the help page.'],
    cta: { label: 'Set it up again', url: `${baseUrl()}/app/settings?tab=security#two-step` } });
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
  // Wrong codes after a wrong password, or under Settings, that nobody followed up for a day start again from none.
  run('DELETE FROM two_step_tries WHERE (paused_until IS NULL OR paused_until <= ?) AND at <= ?', now(), new Date(Date.now() - 864e5).toISOString());
  run('DELETE FROM two_step_stops WHERE user_id IN (SELECT id FROM users WHERE two_step_reset_at IS NULL)');
  return { reminded, switched_off };
}
