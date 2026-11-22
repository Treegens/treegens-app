import crypto from 'node:crypto';
import { all, get, run } from './db.ts';
import { sha256, token, now, HttpError } from './util.ts';
import { SESSION_DAYS, SESSION_MAX_DAYS, SESSION_TOUCH_MINUTES } from '../lib/policy.ts';
import { sessionRule, endedWhy, endedWords } from './secpolicy.ts';
import { dayText } from '../lib/dates.ts';
import { sessionCap } from './orgsso.ts';
import { senderSession } from './embed.ts';

export const SESSION_COOKIE = 'ts_session';
const DAYS = SESSION_DAYS;
// The latest a session can end, however much it is used: SESSION_MAX_DAYS after it signed in, so a copied cookie
// that keeps being used still runs out. A session from before created_at was kept has no known start, so it never
// moves forward again and ends where it stands (at most SESSION_DAYS after its last move, before this rule).
// ends_by: a sooner end set for people whose domain signs in through their organisation's service (orgsso.ts).
export const sessionEnd = (s: any): number => Math.min(Date.parse(s.expires_at) || 0, s.created_at ? Date.parse(s.created_at) + SESSION_MAX_DAYS * 864e5 : Infinity, s.ends_by ? Date.parse(s.ends_by) || 0 : Infinity);

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
  // Two-step login stays exactly as it is: nothing but its owner with a code, an admin reset or the reset by email
  // takes it away (twostep.ts), and proving an address is none of those. A stranger cannot have put their phone in
  // front of this login, because switching it on needs a confirmed address (POST /me/two-step/setup). Sign-ins that
  // wait for a code end here, as the browsers do.
  run('DELETE FROM two_step_pending WHERE user_id=?', userId);
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
  run('DELETE FROM sessions WHERE user_id=? AND (expires_at <= ? OR created_at <= ?)', userId, now(), new Date(Date.now() - SESSION_MAX_DAYS * 864e5).toISOString());
  const days = Math.min(DAYS, SESSION_MAX_DAYS);
  run('INSERT INTO sessions (id, user_id, account_id, expires_at, created_at) VALUES (?,?,?,?,?)', sha256(t), userId, accountId, new Date(Date.now() + days * 864e5).toISOString(), now());
  // Someone whose email domain signs in through their organisation's own service stays in for at most
  // SSO_SESSION_HOURS, then goes through that service again (orgsso.ts): that is what ends access for a leaver.
  const endsBy = sessionCap(userId);
  if (endsBy) run('UPDATE sessions SET ends_by=? WHERE id=?', endsBy, sha256(t));
  return cookie(SESSION_COOKIE, t, endsBy ? Math.max(60, Math.floor((Date.parse(endsBy) - Date.now()) / 1000)) : days * 86400, secure);
}

// A browser that is used stays signed in. Each use moves the end of its session to SESSION_DAYS from now, so
// someone who opens the app on their phone every week is asked to sign in again only SESSION_MAX_DAYS after signing
// in (12 weeks of weekly use at 90), and a browser nobody uses
// is signed out SESSION_DAYS after its last visit. To keep reading a page from writing to the database every time,
// the use is written down at most once every SESSION_TOUCH_MINUTES, together with what the browser calls itself:
// Settings shows both under "Where you are signed in". The end moves at most once a day. When it does, true comes
// back and the router sends the cookie again (renewedCookie), because the browser forgets a cookie on the date it
// was given with, whatever the database says. Never past sessionEnd(): from SESSION_MAX_DAYS after signing in,
// the person signs in again however often they come.
function touch(s: any, req: Request): boolean {
  const t = Date.now();
  if (t - (Date.parse(s.last_used_at || '') || 0) < SESSION_TOUCH_MINUTES * 60_000) return false;
  const end = Math.min(t + DAYS * 864e5, s.created_at ? Date.parse(s.created_at) + SESSION_MAX_DAYS * 864e5 : Date.parse(s.expires_at));
  const slide = end - Date.parse(s.expires_at) > 864e5;
  run('UPDATE sessions SET last_used_at=?, ua=?, expires_at=? WHERE id=?', new Date(t).toISOString(), (req.headers.get('user-agent') || '').slice(0, 300) || null, slide ? new Date(end).toISOString() : s.expires_at, s.id);
  return slide;
}
// The cookie again, given with the time its session has left, never more.
export const renewedCookie = (req: Request, secure: boolean): string => {
  const t = readCookie(req, SESSION_COOKIE) || '';
  const row = t ? get('SELECT expires_at, created_at FROM sessions WHERE id=?', sha256(t)) : null;
  return cookie(SESSION_COOKIE, t, row ? Math.max(0, Math.floor((sessionEnd(row) - Date.now()) / 1000)) : 0, secure);
};

// A key's scope: 'send' does the everyday work, 'admin' may also change account settings. What each can reach is
// decided in one place, router.ts.
// slid: this request moved the end of the browser's session forward, so its cookie is to be sent again (see touch).
// keyId: which key, for the security record (seclog.ts). Never the key itself.
// via 'embed': the sender screen inside a customer's app, for one draft alone (embed.ts): envelopeId says which.
export type Auth = { user: any; account: any; role: string; via: 'session' | 'api_key' | 'embed'; sessionId?: string; scope?: 'send' | 'admin'; slid?: boolean; keyId?: string; envelopeId?: string; viewId?: string };

const KEYS_PAGE = 'Settings, Developers';

// With "required" (every route that needs signing in), a key that was sent but cannot be used is refused in words
// that say which thing went wrong, because a program cannot act on "Please sign in." Without it, on public routes,
// such a caller is simply nobody.
export function authenticate(req: Request, required = false): Auth | null {
  const refuse = (status: number, message: string, data?: Record<string, any>): null => {
    if (required) throw new HttpError(status, message, data);
    return null;
  };
  const header = (req.headers.get('authorization') || '').trim();
  // The sender screen inside a customer's app sends the token its one-time link gave it (embed.ts).
  const screen = /^Bearer\s+(tse_[A-Za-z0-9_-]+)$/i.exec(header)?.[1];
  if (screen) {
    try {
      return { ...senderSession(screen), via: 'embed', scope: 'send' };
    } catch (e: any) {
      return refuse(e.status || 401, e.message, e.data);
    }
  }
  // The scheme name is not case sensitive in HTTP, and some clients send "bearer".
  const bearer = /^Bearer\s+(tsk_[A-Za-z0-9_-]+)$/i.exec(header)?.[1];
  if (bearer) {
    const k = get('SELECT * FROM api_keys WHERE key_hash=?', sha256(bearer));
    if (!k) return refuse(401, `This API key is not known here. It was revoked, or it was not copied in full. Create a new key under ${KEYS_PAGE}.`);
    const m = get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', k.account_id, k.user_id);
    if (k.stopped_at || !m) return refuse(401, `This API key stopped working${k.stopped_at ? ` on ${dayText(k.stopped_at)}` : ''} because the person who created it is no longer in the account. An admin of the account can create a new key under ${KEYS_PAGE}.`);
    const user = get('SELECT * FROM users WHERE id=?', k.user_id);
    const account = get('SELECT * FROM accounts WHERE id=?', k.account_id);
    // Closing an account signs every browser out. A key must not keep sending for it in the meantime: whatever it
    // sent would be deleted with the account when the grace period ends.
    const closing = account.closing_at || user.closing_at;
    if (closing) return refuse(403, `${account.closing_at ? 'This account is being closed' : 'The person who created this API key is closing their login'}, so the key is switched off. Nothing is deleted before ${dayText(closing)}. Signing in to the app before then restores everything, and this key works again.`);
    run('UPDATE api_keys SET last_used_at=? WHERE id=?', now(), k.id);
    return { user, account, role: m.role, via: 'api_key', scope: k.scope === 'admin' ? 'admin' : 'send', keyId: k.id };
  }
  const t = readCookie(req, SESSION_COOKIE);
  const found = t ? get('SELECT * FROM sessions WHERE id=? AND expires_at > ?', sha256(t), now()) : null;
  // Past the most a session may last (a row that slid before that rule existed): nobody, like one that ran out.
  const s = found && sessionEnd(found) > Date.now() ? found : null;
  // A browser that was handed to someone to sign in person opens nothing until its owner has typed their password
  // (src/server/handover.ts). Until then it counts as nobody, and is not noted as used.
  if (s?.locked_at) return refuse(401, 'This device was handed to someone to sign in person, so your account is locked in this browser. Open GrowSigning here and type your password to come back.', { code: 'handed_over' });
  const m = s ? get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', s.account_id, s.user_id) : null;
  // The sign-in rules of the account this browser is in (secpolicy.ts): signed out after too long without use, and
  // one browser at a time. A browser that a rule signed out is told which rule, in place of "Please sign in."
  const ruled = m ? sessionRule(s, req) : null;
  if (ruled) return refuse(ruled.status, ruled.message, ruled.data);
  const why = !found && t ? endedWhy(t) : null;
  if (why) return refuse(401, endedWords(why), { code: 'signed_out', why });
  if (m) return { user: get('SELECT * FROM users WHERE id=?', s.user_id), account: get('SELECT * FROM accounts WHERE id=?', s.account_id), role: m.role, via: 'session', sessionId: s.id, slid: touch(s, req) };
  // Something was sent in place of a key, but not in the form a key has.
  if (header) return refuse(401, `We could not read an API key from the Authorization header. Send it as "Authorization: Bearer tsk_..." with a key from ${KEYS_PAGE}.`);
  return null;
}
