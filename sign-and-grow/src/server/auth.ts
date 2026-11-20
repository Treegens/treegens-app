import crypto from 'node:crypto';
import { get, run } from './db.ts';
import { sha256, token, now } from './util.ts';

export const SESSION_COOKIE = 'ts_session';
const DAYS = 30;

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
  run('INSERT INTO sessions (id, user_id, account_id, expires_at) VALUES (?,?,?,?)', sha256(t), userId, accountId, new Date(Date.now() + DAYS * 864e5).toISOString());
  return cookie(SESSION_COOKIE, t, DAYS * 86400, secure);
}

export type Auth = { user: any; account: any; role: string; via: 'session' | 'api_key'; sessionId?: string };

export function authenticate(req: Request): Auth | null {
  const bearer = /^Bearer\s+(tsk_[A-Za-z0-9_-]+)$/.exec(req.headers.get('authorization') || '')?.[1];
  if (bearer) {
    const k = get('SELECT * FROM api_keys WHERE key_hash=?', sha256(bearer));
    if (!k) return null;
    const m = get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', k.account_id, k.user_id);
    if (!m) return null;
    run('UPDATE api_keys SET last_used_at=? WHERE id=?', now(), k.id);
    return { user: get('SELECT * FROM users WHERE id=?', k.user_id), account: get('SELECT * FROM accounts WHERE id=?', k.account_id), role: m.role, via: 'api_key' };
  }
  const t = readCookie(req, SESSION_COOKIE);
  if (!t) return null;
  const s = get('SELECT * FROM sessions WHERE id=? AND expires_at > ?', sha256(t), now());
  if (!s) return null;
  const m = get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', s.account_id, s.user_id);
  if (!m) return null;
  return { user: get('SELECT * FROM users WHERE id=?', s.user_id), account: get('SELECT * FROM accounts WHERE id=?', s.account_id), role: m.role, via: 'session', sessionId: s.id };
}
