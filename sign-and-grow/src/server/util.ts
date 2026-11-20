import crypto from 'node:crypto';
import { secret } from './db.ts';

export class HttpError extends Error {
  status: number;
  // Extra facts sent with the error for a program to act on, such as "code". The message is still the whole story for a person.
  data?: Record<string, any>;
  constructor(status: number, message: string, data?: Record<string, any>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}
export const bad = (message: string, status = 400, data?: Record<string, any>) => new HttpError(status, message, data);

export const id = (prefix: string) => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
export const hmac = (data: string, key = secret()) => crypto.createHmac('sha256', key).update(data).digest('hex');
export const now = () => new Date().toISOString();

// Short code printed in every signing email. Typing it into /check proves the email is genuine without
// clicking anything. No look-alike characters (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const checkCode = () => Array.from(crypto.randomBytes(12), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
// A shorter code from the same alphabet, for a reference a person reads out or types back, such as a help request.
export const shortCode = (length = 8) => Array.from(crypto.randomBytes(length), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
// The same kind of code worked out from something that is already stored, for a record that was written without
// one. It is the same every time for the same seed.
export const codeFrom = (seed: string, length = 8) => Array.from(crypto.createHash('sha256').update(seed).digest().subarray(0, length), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
export const fmtCode = (c: string) => c.replace(/(.{4})(?=.)/g, '$1-');
export const parseCode = (s: any) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const isEmail = (s: any): s is string => typeof s === 'string' && s.length < 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
export const str = (v: any, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
export const esc = (s: any) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Small in-memory rate limiter. Good enough for a single instance; put a proxy limiter in front for more.
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < t) {
    buckets.set(key, { n: 1, reset: t + windowMs });
    if (buckets.size > 20000) for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k);
    return;
  }
  if (++b.n > max) throw new HttpError(429, 'Too many attempts. Please wait a bit and try again.');
}
// For a limit that counts only some attempts (wrong access codes, say). rateWait asks without counting: it answers
// how many milliseconds are left when the key has used up its tries, or 0. rateLimit(key, Infinity, window) counts one.
export function rateWait(key: string, max: number): number {
  const b = buckets.get(key);
  return b && b.reset > Date.now() && b.n >= max ? b.reset - Date.now() : 0;
}

// Public base URL for links in emails. On a real deployment APP_URL is the only source. A Host or X-Forwarded-Host
// header is whatever the caller typed, and a password reset or signing link that points at somebody else's server
// hands them the account or the signature. Without APP_URL, the address of a request is used only when it names
// this machine itself, which is local development. Any other host is ignored, with one loud warning.
const g = globalThis as any;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const setOrigin = (o: string) => {
  if (process.env.APP_URL) return;
  let u: URL | null = null;
  try {
    u = new URL(o);
  } catch {}
  if (u && LOCAL_HOSTS.has(u.hostname) && (u.protocol === 'http:' || u.protocol === 'https:')) g.__tsorigin = u.origin;
  else if (!g.__tsoriginWarned) {
    g.__tsoriginWarned = true;
    console.error(`\n[config] APP_URL IS NOT SET. A request arrived for "${u?.host || 'a host name we could not read'}", and that address is NOT used for links in emails, because a request header can be forged. Links in emails point at ${baseUrl()} until APP_URL is set to the public address of this app, for example APP_URL=https://sign.example.com\n`);
  }
};
export const baseUrl = (): string => (process.env.APP_URL || g.__tsorigin || 'http://localhost:3000').replace(/\/$/, '');
