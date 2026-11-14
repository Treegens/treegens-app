/**
 * All cryptography in one place (node:crypto only). Every key is derived from the single master
 * secret in ctx.env.secretKey with HKDF, separated by use (seal / sign / mac) and by purpose,
 * so a token minted for one purpose can never be replayed as another.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import type { Ctx } from './ctx';

// ───────────────────────── ids, hashes ─────────────────────────

// 32 symbols, so every random byte maps to one without bias (256 % 32 === 0). Lower case letters and
// digits only: ids are safe in URLs, storage keys and `<a>_<b>` composites.
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_LENGTH = 16; // 80 bits

export function randomId(prefix: string): string {
  const bytes = randomBytes(ID_LENGTH);
  let out = '';
  for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET[bytes[i] & 31];
  return `${prefix}_${out}`;
}

export function randomToken(bytes = 24): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 1024) throw new Error('randomToken: bytes must be an integer from 16 to 1024');
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Constant-time string comparison. Hashing first hides the lengths as well. */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

// ───────────────────────── passwords ─────────────────────────

// OWASP scrypt profile: N = 2^16 (64 MiB), r = 8, p = 2.
const SCRYPT = { N: 1 << 16, r: 8, p: 2 };
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;
export const MAX_PASSWORD_LENGTH = 1024;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function scryptOptions(N: number, r: number, p: number): ScryptOptions {
  // Node refuses anything above maxmem; the work area is about 128 * N * r bytes (plus 128 * r * p).
  return { N, r, p, maxmem: 128 * N * r + 128 * r * p + 1024 * 1024 };
}

/** Format: `scrypt$N=65536,r=8,p=2$<salt b64url>$<hash b64url>` */
export async function hashPassword(pw: string): Promise<string> {
  if (typeof pw !== 'string' || pw.length === 0) throw new Error('hashPassword: empty password');
  if (pw.length > MAX_PASSWORD_LENGTH) throw new Error('hashPassword: password too long');
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await scryptAsync(pw.normalize('NFKC'), salt, SCRYPT_KEYLEN, scryptOptions(SCRYPT.N, SCRYPT.r, SCRYPT.p));
  return `scrypt$N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  if (typeof pw !== 'string' || typeof stored !== 'string' || pw.length === 0 || pw.length > MAX_PASSWORD_LENGTH) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const m = /^N=(\d{1,8}),r=(\d{1,3}),p=(\d{1,3})$/.exec(parts[1]);
  if (!m) return false;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  // Bounds keep a corrupted record from turning a login into a memory or CPU bomb.
  const powerOfTwo = N >= 2 && (N & (N - 1)) === 0;
  if (!powerOfTwo || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[2], 'base64url');
  const expected = Buffer.from(parts[3], 'base64url');
  if (salt.length < 8 || expected.length < 16 || expected.length > 128) return false;
  try {
    const actual = await scryptAsync(pw.normalize('NFKC'), salt, expected.length, scryptOptions(N, r, p));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ───────────────────────── key derivation ─────────────────────────

/**
 * The master secret is meant to be 32 random bytes in base64 (`openssl rand -base64 32`).
 * Any string that decodes to at least 32 bytes is taken as base64 (or base64url);
 * otherwise a raw string of 32+ characters is accepted as-is. Anything weaker is refused.
 */
function masterKey(ctx: Ctx): Buffer {
  const raw = (ctx.env.secretKey ?? '').trim();
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length >= 32) return decoded;
  }
  if (raw.length >= 32) return Buffer.from(raw, 'utf8');
  throw new Error('MEETING_SECRET_KEY is missing or too short. It must be at least 32 random bytes, base64 encoded.');
}

/** True when ctx.env.secretKey is usable. Lets callers fail with a clear message before doing any work. */
export function hasValidSecretKey(ctx: Ctx): boolean {
  try {
    masterKey(ctx);
    return true;
  } catch {
    return false;
  }
}

type KeyUse = 'seal' | 'sign' | 'mac';

function deriveKey(ctx: Ctx, use: KeyUse, purpose: string): Buffer {
  if (typeof purpose !== 'string' || purpose.length === 0 || purpose.length > 200) throw new Error('crypto: invalid purpose');
  const info = Buffer.from(`meeting/v1/${use}/${purpose}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', masterKey(ctx), Buffer.alloc(0), info, 32));
}

// ───────────────────────── sealing (encryption at rest) ─────────────────────────

const SEAL_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM. Output: `v1.<base64url(iv | ciphertext | tag)>`. The purpose is bound as key AND as AAD. */
export function seal(ctx: Ctx, purpose: string, plaintext: string): string {
  if (typeof plaintext !== 'string') throw new Error('seal: plaintext must be a string');
  const key = deriveKey(ctx, 'seal', purpose);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${SEAL_VERSION}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
}

/** Returns null for anything that is not an intact value sealed with this key and purpose. */
export function open(ctx: Ctx, purpose: string, sealed: string): string | null {
  try {
    if (typeof sealed !== 'string' || !sealed.startsWith(`${SEAL_VERSION}.`)) return null;
    const encoded = sealed.slice(SEAL_VERSION.length + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const raw = Buffer.from(encoded, 'base64url');
    if (raw.length < IV_BYTES + TAG_BYTES) return null;
    const key = deriveKey(ctx, 'seal', purpose);
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ───────────────────────── signed payloads + MACs ─────────────────────────

interface SignedEnvelope {
  /** the caller's payload */
  d: unknown;
  /** expiry, epoch ms */
  exp: number;
}

/** `<base64url(json)>.<base64url(hmac-sha256)>`; valid until ttlSec after ctx.now(). */
export function signPayload(ctx: Ctx, purpose: string, payload: object, ttlSec: number): string {
  if (payload === null || typeof payload !== 'object') throw new Error('signPayload: payload must be an object');
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) throw new Error('signPayload: ttlSec must be positive');
  const envelope: SignedEnvelope = { d: payload, exp: ctx.now().getTime() + Math.round(ttlSec * 1000) };
  const body = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
  const sig = createHmac('sha256', deriveKey(ctx, 'sign', purpose)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Returns the payload, or null when the token is malformed, forged, for another purpose, or expired. */
export function verifyPayload<T>(ctx: Ctx, purpose: string, token: string): T | null {
  try {
    if (typeof token !== 'string' || token.length > 8192) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const body = token.slice(0, dot);
    const sig = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = createHmac('sha256', deriveKey(ctx, 'sign', purpose)).update(body).digest();
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    const envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedEnvelope;
    if (!envelope || typeof envelope.exp !== 'number' || envelope.d === null || typeof envelope.d !== 'object') return null;
    if (ctx.now().getTime() >= envelope.exp) return null;
    return envelope.d as T;
  } catch {
    return null;
  }
}

/** Deterministic keyed MAC (hex). Compare results with safeEqual. */
export function hmacHex(ctx: Ctx, purpose: string, data: string): string {
  return createHmac('sha256', deriveKey(ctx, 'mac', purpose)).update(data, 'utf8').digest('hex');
}
