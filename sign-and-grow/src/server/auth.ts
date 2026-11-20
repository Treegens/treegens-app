import crypto from 'node:crypto';
import { all, get, run } from './db.ts';
import { sha256, token, now, HttpError } from './util.ts';
import { SESSION_DAYS, SESSION_TOUCH_MINUTES } from '../lib/policy.ts';

export const SESSION_COOKIE = 'ts_session';
const DAYS = SESSION_DAYS;

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function checkPassword(pw: string, stored: string): boolean {
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// A login made by signing in with Google or Microsoft has no password until its owner chooses one. This is stored
// in the password's place. It is not the hash of anything, so nothing typed into a password box matches it.
export const NO_PASSWORD = '!';
export const hasPassword = (u: any): boolean => typeof u?.password_hash === 'string' && u.password_hash.startsWith('scrypt$');

// The first time somebody proves that the address of a login is theirs (Google or Microsoft vouches for it, or they
// open the reset link we sent there), everything attached to the login before that moment was attached by someone
// who had proved nothing. That can be a stranger who made the login in this person's name and waited for them to
// arrive. So that moment cuts every earlier way in: browsers that are signed in, API keys this login made, and
// sign-in connections whose provider did not vouch for the address. The password is the caller's to deal with.
// Returns the providers that were disconnected. Call inside tx().
export function cutEarlierAccess(userId: string): string[] {
  const gone = all('SELECT provider FROM identities WHERE user_id=? AND vouched=0', userId).map((r) => r.provider as string);
  run('DELETE FROM identities WHERE user_id=? AND vouched=0', userId);
  run('DELETE FROM sessions WHERE user_id=?', userId);
  run('DELETE FROM api_keys WHERE user_id=?', userId);
  // Two-step login set up before then was set up by the same nobody, and would keep the owner out with a stranger's
  // phone. It goes as clearTwoStep() in twostep.ts clears it (written out here: auth.ts imports nothing of that file).
  run('UPDATE users SET two_step_secret=NULL, two_step_on_at=NULL, two_step_last_step=NULL, two_step_codes=NULL, two_step_new_secret=NULL, two_step_new_at=NULL, two_step_wrong=0, two_step_wrong_known=0, two_step_paused_until=NULL, two_step_reset_at=NULL, two_step_reset_noticed_at=NULL WHERE id=?', userId);
  for (const t of ['two_step_devices', 'two_step_pending', 'two_step_resets']) run(`DELETE FROM ${t} WHERE user_id=?`, userId);
  return gone;
}

export function cookie(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}
export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function createSession(userId: string, accountId: string, secure: boolean): string {
  const t = token();
  // Signing in here adds a browser. It never signs another one out: each has a row of its own. Rows that ran out
  // are cleared on the way, so the list under Settings is only what is still signed in.
  run('DELETE FROM sessions WHERE user_id=? AND expires_at <= ?', userId, now());
  run('INSERT INTO sessions (id, user_id, account_id, expires_at, created_at) VALUES (?,?,?,?,?)', sha256(t), userId, accountId, new Date(Date.now() + DAYS * 864e5).toISOString(), now());
  return cookie(SESSION_COOKIE, t, DAYS * 86400, secure);
}

// A browser that is used stays signed in. Each use moves the end of its session to SESSION_DAYS from now, so
// someone who opens the app on their phone every week is never asked to sign in again, and a browser nobody uses
// is signed out SESSION_DAYS after its last visit. To keep reading a page from writing to the database every time,
// the use is written down at most once every SESSION_TOUCH_MINUTES, together with what the browser calls itself:
// Settings shows both under "Where you are signed in". The end moves at most once a day. When it does, true comes
// back and the router sends the cookie again (renewedCookie), because the browser forgets a cookie on the date it
// was given with, whatever the database says.
function touch(s: any, req: Request): boolean {
  const t = Date.now();
  if (t - (Date.parse(s.last_used_at || '') || 0) < SESSION_TOUCH_MINUTES * 60_000) return false;
  const slide = Date.parse(s.expires_at) - t < (DAYS - 1) * 864e5;
  run('UPDATE sessions SET last_used_at=?, ua=?, expires_at=? WHERE id=?', new Date(t).toISOString(), (req.headers.get('user-agent') || '').slice(0, 300) || null, slide ? new Date(t + DAYS * 864e5).toISOString() : s.expires_at, s.id);
  return slide;
}
export const renewedCookie = (req: Request, secure: boolean): string => cookie(SESSION_COOKIE, readCookie(req, SESSION_COOKIE) || '', DAYS * 86400, secure);

// A key's scope: 'send' does the everyday work, 'admin' may also change account settings. What each can reach is
// decided in one place, router.ts.
// slid: this request moved the end of the browser's session forward, so its cookie is to be sent again (see touch).
export type Auth = { user: any; account: any; role: string; via: 'session' | 'api_key'; sessionId?: string; scope?: 'send' | 'admin'; slid?: boolean };

const KEYS_PAGE = 'Settings, API and webhooks';

// With "required" (every route that needs signing in), a key that was sent but cannot be used is refused in words
// that say which thing went wrong, because a program cannot act on "Please sign in." Without it, on public routes,
// such a caller is simply nobody.
export function authenticate(req: Request, required = false): Auth | null {
  const refuse = (status: number, message: string, data?: Record<string, any>): null => {
    if (required) throw new HttpError(status, message, data);
    return null;
  };
  const header = (req.headers.get('authorization') || '').trim();
  // The scheme name is not case sensitive in HTTP, and some clients send "bearer".
  const bearer = /^Bearer\s+(tsk_[A-Za-z0-9_-]+)$/i.exec(header)?.[1];
  if (bearer) {
    const k = get('SELECT * FROM api_keys WHERE key_hash=?', sha256(bearer));
    if (!k) return refuse(401, `This API key is not known here. It was revoked, or it was not copied in full. Create a new key under ${KEYS_PAGE}.`);
    const m = get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', k.account_id, k.user_id);
    if (k.stopped_at || !m) return refuse(401, `This API key stopped working${k.stopped_at ? ` on ${k.stopped_at.slice(0, 10)}` : ''} because the person who created it is no longer in the account. An admin of the account can create a new key under ${KEYS_PAGE}.`);
    const user = get('SELECT * FROM users WHERE id=?', k.user_id);
    const account = get('SELECT * FROM accounts WHERE id=?', k.account_id);
    // Closing an account signs every browser out. A key must not keep sending for it in the meantime: whatever it
    // sent would be deleted with the account when the grace period ends.
    const closing = account.closing_at || user.closing_at;
    if (closing) return refuse(403, `${account.closing_at ? 'This account is being closed' : 'The person who created this API key is closing their login'}, so the key is switched off. Nothing is deleted before ${closing.slice(0, 10)}. Signing in to the app before then restores everything, and this key works again.`);
    run('UPDATE api_keys SET last_used_at=? WHERE id=?', now(), k.id);
    return { user, account, role: m.role, via: 'api_key', scope: k.scope === 'admin' ? 'admin' : 'send' };
  }
  const t = readCookie(req, SESSION_COOKIE);
  const s = t ? get('SELECT * FROM sessions WHERE id=? AND expires_at > ?', sha256(t), now()) : null;
  // A browser that was handed to someone to sign in person opens nothing until its owner has typed their password
  // (src/server/handover.ts). Until then it counts as nobody, and is not noted as used.
  if (s?.locked_at) return refuse(401, 'This device was handed to someone to sign in person, so your account is locked in this browser. Open Sign&Grow here and type your password to come back.', { code: 'handed_over' });
  const m = s ? get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', s.account_id, s.user_id) : null;
  if (m) return { user: get('SELECT * FROM users WHERE id=?', s.user_id), account: get('SELECT * FROM accounts WHERE id=?', s.account_id), role: m.role, via: 'session', sessionId: s.id, slid: touch(s, req) };
  // Something was sent in place of a key, but not in the form a key has.
  if (header) return refuse(401, `We could not read an API key from the Authorization header. Send it as "Authorization: Bearer tsk_..." with a key from ${KEYS_PAGE}.`);
  return null;
}
