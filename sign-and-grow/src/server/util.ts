import crypto from 'node:crypto';
import { secret } from './db.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const bad = (message: string, status = 400) => new HttpError(status, message);

export const id = (prefix: string) => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
export const hmac = (data: string, key = secret()) => crypto.createHmac('sha256', key).update(data).digest('hex');
export const now = () => new Date().toISOString();

// Short code printed in every signing email. Typing it into /check proves the email is genuine without
// clicking anything. No look-alike characters (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const checkCode = () => Array.from(crypto.randomBytes(12), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
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

// Public base URL for links in emails. APP_URL wins; otherwise the origin of the latest request.
const g = globalThis as any;
export const setOrigin = (o: string) => {
  g.__tsorigin = o;
};
export const baseUrl = (): string => (process.env.APP_URL || g.__tsorigin || 'http://localhost:3000').replace(/\/$/, '');
