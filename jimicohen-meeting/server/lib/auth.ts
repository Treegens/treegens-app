/**
 * Admin session, CSRF defence, co-host token check and rate limiting.
 *
 * Session = signPayload(ctx, 'session', { v: passwordVersion }, 30 days) in an HttpOnly cookie.
 * Changing the password bumps the version, which signs every older session out.
 */
import { randomInt } from 'node:crypto';
import type { Host } from '../../shared/types';
import { hashPassword, hmacHex, safeEqual, sha256Hex, signPayload, verifyPayload } from './crypto';
import { BASE_PATH, type Ctx } from './ctx';
import { HttpError } from './http';
import { getHost, KEYS } from './repo';

export const SESSION_COOKIE = 'mtg_session';
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60;
const SESSION_PURPOSE = 'session';
/** Sent by our own client on every request. A cross-site form cannot add it, and a cross-site fetch would need a CORS preflight we never answer. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'meeting';

// ───────────────────────── admin record ─────────────────────────

/** Stored at `auth/admin`. Its existence means first-run setup is done. */
export interface AdminAuth {
  passwordHash: string;
  passwordVersion: number;
  setupUsedAt: string;
  /**
   * MEETING_SETUP_CODE_HASH that set the current password. A setup code works once: only a different
   * hash, deployed later, can replace a forgotten password. '' when the record predates this field and
   * no code was deployed when it was first looked at (any code deployed later is then a new one).
   */
  setupCodeHash?: string;
  /** when a new setup code last replaced the password */
  passwordResetAt?: string;
}

export async function getAdminAuth(ctx: Ctx): Promise<AdminAuth | null> {
  return ctx.kv.getJSON<AdminAuth>(KEYS.adminAuth);
}

/**
 * First-run setup: creates the admin record. Returns null when one already exists
 * (create-only write, so two racing setup requests cannot both win).
 * `setupCodeHash` is the deployed hash the code was checked against.
 */
export async function createAdminAuth(ctx: Ctx, password: string, setupCodeHash?: string | null): Promise<AdminAuth | null> {
  if (await getAdminAuth(ctx)) return null;
  const record: AdminAuth = {
    passwordHash: await hashPassword(password),
    // Random, not 1: should the record ever be made again (deleted by hand, restored from an old copy),
    // sessions signed for the earlier record must not match the new one.
    passwordVersion: randomInt(1, 2 ** 31),
    setupUsedAt: ctx.now().toISOString(),
    setupCodeHash: (setupCodeHash ?? ctx.env.setupCodeHash ?? '').toLowerCase(),
  };
  const written = await ctx.kv.setJSON(KEYS.adminAuth, record, { onlyIfNew: true });
  return written.modified ? record : null;
}

/**
 * Read-modify-write of the admin record. `fn` returns null to leave it as it is. Answers null when
 * there is no record, else `{ after }` with what was written (null when `fn` left it alone).
 */
async function mutateAdminAuth(ctx: Ctx, fn: (current: AdminAuth) => AdminAuth | null): Promise<{ after: AdminAuth | null } | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const found = await ctx.kv.getJSONWithEtag<AdminAuth>(KEYS.adminAuth);
    if (!found) return null;
    const next = fn(found.value);
    if (!next) return { after: null };
    const written = await ctx.kv.setJSON(KEYS.adminAuth, next, { onlyIfMatch: found.etag });
    if (written.modified) return { after: next };
    await Promise.resolve();
  }
  throw new HttpError(503, 'busy', 'The server is busy right now. Please try again in a moment.');
}

/**
 * A record made before the setup code hash was kept has none. The first time one is seen, the hash
 * deployed right then is taken as the one that was used (or '' when none is deployed). That refuses
 * the code already in place and accepts any code deployed later.
 */
export async function noteSetupCode(ctx: Ctx, admin: AdminAuth | null): Promise<void> {
  if (!admin || typeof admin.setupCodeHash === 'string') return;
  try {
    await mutateAdminAuth(ctx, (current) =>
      typeof current.setupCodeHash === 'string' ? null : { ...current, setupCodeHash: (ctx.env.setupCodeHash ?? '').toLowerCase() },
    );
  } catch (err) {
    ctx.log('warn', 'auth: could not note the setup code on the admin record', { error: err instanceof Error ? err.name : 'unknown' });
  }
}

/**
 * Forgotten password: a setup code whose hash differs from the one that set the current password
 * replaces it. Bumps the version, which signs every existing session out. `setupCodeHash` is the
 * deployed hash the presented code was checked against. 'code_used' when that hash already set the
 * current password; null before setup.
 */
export async function resetAdminPassword(ctx: Ctx, newPassword: string, setupCodeHash: string): Promise<AdminAuth | 'code_used' | null> {
  const wanted = setupCodeHash.toLowerCase();
  const before = await getAdminAuth(ctx);
  if (!before) return null;
  await noteSetupCode(ctx, before);
  const passwordHash = await hashPassword(newPassword);
  const outcome = await mutateAdminAuth(ctx, (current) => {
    if (typeof current.setupCodeHash !== 'string' || current.setupCodeHash.toLowerCase() === wanted) return null;
    return { ...current, passwordHash, passwordVersion: current.passwordVersion + 1, setupCodeHash: wanted, passwordResetAt: ctx.now().toISOString() };
  });
  if (!outcome) return null;
  return outcome.after ?? 'code_used';
}

/** Stores a new password and bumps the version, invalidating every existing session. Returns null before setup. */
export async function changeAdminPassword(ctx: Ctx, newPassword: string): Promise<AdminAuth | null> {
  if (!(await getAdminAuth(ctx))) return null;
  const passwordHash = await hashPassword(newPassword);
  const outcome = await mutateAdminAuth(ctx, (current) => ({ ...current, passwordHash, passwordVersion: current.passwordVersion + 1 }));
  return outcome?.after ?? null;
}

// ───────────────────────── session cookie ─────────────────────────

function isDev(ctx: Ctx): boolean {
  return ctx.env.publicBaseUrl.startsWith('http://');
}

function cookieAttributes(secure: boolean): string {
  return `Path=${BASE_PATH}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax`;
}

/** Set-Cookie value for a fresh 30 day session. `Secure` is dropped only on a plain-http dev origin. */
export function sessionSetCookie(ctx: Ctx, passwordVersion: number): string {
  const token = signPayload(ctx, SESSION_PURPOSE, { v: passwordVersion }, SESSION_TTL_SEC);
  return `${SESSION_COOKIE}=${token}; ${cookieAttributes(!isDev(ctx))}; Max-Age=${SESSION_TTL_SEC}`;
}

/** Set-Cookie value that removes the session. Pass `ctx` so the attributes mirror the cookie that was set. */
export function sessionClearCookie(ctx?: Ctx): string {
  const secure = ctx ? !isDev(ctx) : true;
  return `${SESSION_COOKIE}=; ${cookieAttributes(secure)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

// ───────────────────────── known device cookie ─────────────────────────

/**
 * Set next to the session on every successful sign-in and kept when signing out. It lets a browser
 * that signed in before skip the shared ceiling on failed sign-ins, so strangers filling that ceiling
 * cannot lock the owner out of the devices they already use. The per-visitor limit still applies.
 * It carries the password version, so changing or resetting the password retires every older one.
 */
export const DEVICE_COOKIE = 'mtg_device';
/** About 400 days, the longest browsers keep a cookie. */
export const DEVICE_TTL_SEC = 400 * 24 * 60 * 60;
const DEVICE_PURPOSE = 'device';

export function deviceSetCookie(ctx: Ctx, passwordVersion: number): string {
  const token = signPayload(ctx, DEVICE_PURPOSE, { v: passwordVersion }, DEVICE_TTL_SEC);
  return `${DEVICE_COOKIE}=${token}; ${cookieAttributes(!isDev(ctx))}; Max-Age=${DEVICE_TTL_SEC}`;
}

/** True when the request carries a device cookie issued for the current password. */
export function isKnownDevice(ctx: Ctx, req: Request, admin: AdminAuth | null): boolean {
  if (!admin) return false;
  return cookieValues(req, DEVICE_COOKIE)
    .map((token) => verifyPayload<{ v?: unknown }>(ctx, DEVICE_PURPOSE, token))
    .some((p) => p !== null && p.v === admin.passwordVersion);
}

/** Every value sent for `name` (a browser can hold several cookies with one name on different paths). */
function cookieValues(req: Request, name: string): string[] {
  const header = req.headers.get('cookie');
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (value) values.push(value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value);
  }
  return values;
}

export async function isAdmin(ctx: Ctx, req: Request): Promise<boolean> {
  const versions = cookieValues(req, SESSION_COOKIE)
    .map((token) => verifyPayload<{ v?: unknown }>(ctx, SESSION_PURPOSE, token))
    .filter((p): p is { v: number } => p !== null && typeof p.v === 'number');
  if (versions.length === 0) return false;
  const admin = await getAdminAuth(ctx);
  return !!admin && versions.some((p) => p.v === admin.passwordVersion);
}

/** 401 when not signed in. State-changing methods must also pass the CSRF checks (403). */
export async function requireAdmin(ctx: Ctx, req: Request): Promise<void> {
  assertSameOrigin(ctx, req);
  if (!(await isAdmin(ctx, req))) throw new HttpError(401, 'unauthorized', 'Please sign in.');
}

// ───────────────────────── CSRF ─────────────────────────

function originOf(value: string | null): string | null {
  if (!value || value === 'null') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function isSafeMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

/**
 * For state-changing requests (anything but GET/HEAD):
 *  - the header `X-Requested-With: meeting` must be present, and
 *  - the Origin header (Referer as a fallback) must be present and equal the public site origin,
 *    the app's own (embed) origin, or the origin the request itself was addressed to
 *    (deploy previews, the local dev proxy).
 * Throws HttpError(403, 'csrf'). Does nothing for GET/HEAD.
 */
export function assertSameOrigin(ctx: Ctx, req: Request): void {
  if (isSafeMethod(req.method)) return;
  const denied = new HttpError(403, 'csrf', 'This request could not be verified. Reload the page and try again.');
  if ((req.headers.get(CSRF_HEADER) ?? '').trim().toLowerCase() !== CSRF_HEADER_VALUE) throw denied;
  const source = originOf(req.headers.get('origin')) ?? originOf(req.headers.get('referer'));
  if (!source) throw denied;
  const trusted = [originOf(ctx.env.publicBaseUrl), originOf(ctx.env.embedBaseUrl ?? null), originOf(req.url)];
  if (!trusted.includes(source)) throw denied;
}

// ───────────────────────── co-host self-service ─────────────────────────

/** The host when `token` is that host's current invite token, else null. Only the hash is stored. */
export async function hostFromToken(ctx: Ctx, hostId: string, token: string | null): Promise<Host | null> {
  if (typeof token !== 'string' || token.length < 16 || token.length > 512 || typeof hostId !== 'string') return null;
  const host = await getHost(ctx, hostId);
  if (!host || !host.inviteTokenHash) return null;
  return safeEqual(sha256Hex(token), host.inviteTokenHash) ? host : null;
}

// ───────────────────────── rate limiting ─────────────────────────

const RATE_LIMIT_ATTEMPTS = 8;

/**
 * Key of the fixed-window counter: `rl/<bucket>/<idHash>/<windowStartMs>`.
 * The id (an IP address, an email) is stored only as a keyed SHA-256, so the raw value is
 * neither in the key nor recoverable from it by guessing.
 */
export function rateLimitKey(ctx: Ctx, bucket: string, id: string, windowSec: number): { key: string; windowStartMs: number; windowMs: number } {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(bucket)) throw new Error(`rateLimit: invalid bucket "${bucket}"`);
  const windowMs = Math.max(1, Math.round(windowSec)) * 1000;
  const windowStartMs = Math.floor(ctx.now().getTime() / windowMs) * windowMs;
  return { key: `${KEYS.rateLimitPrefix}${bucket}/${hmacHex(ctx, 'rate-limit', id)}/${windowStartMs}`, windowStartMs, windowMs };
}

/**
 * Counts one hit for `id` in `bucket` and throws HttpError(429) once more than `limit` hits
 * landed in the current window of `windowSec` seconds. The counter is incremented with
 * compare-and-swap, so parallel requests cannot slip past the limit.
 */
function tooManyRequests(ctx: Ctx, windowStartMs: number, windowMs: number): HttpError {
  const retryAfterSec = Math.max(1, Math.ceil((windowStartMs + windowMs - ctx.now().getTime()) / 1000));
  return new HttpError(429, 'rate_limited', 'Too many requests. Please wait a little and try again.', undefined, {
    'Retry-After': String(retryAfterSec),
  });
}

export async function rateLimit(ctx: Ctx, bucket: string, id: string, limit: number, windowSec: number): Promise<void> {
  const { key, windowStartMs, windowMs } = rateLimitKey(ctx, bucket, id, windowSec);
  const tooMany = tooManyRequests(ctx, windowStartMs, windowMs);

  for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt++) {
    const found = await ctx.kv.getJSONWithEtag<{ n: number }>(key);
    const n = found && Number.isFinite(found.value?.n) ? found.value.n : 0;
    if (n >= limit) throw tooMany;
    const written = await ctx.kv.setJSON(key, { n: n + 1 }, found ? { onlyIfMatch: found.etag } : { onlyIfNew: true });
    if (written.modified) return;
    await Promise.resolve();
  }
  // Only reachable when many requests for the same id collide at once, which is itself the thing being limited.
  throw tooMany;
}

/**
 * The same 429 as rateLimit once `limit` hits are in the current window, but without counting this
 * request. Not a limit on its own when requests arrive together: they can all look before any of them
 * is counted. Sign-in uses rateLimit plus rateLimitRefund for that reason.
 */
export async function rateLimitPeek(ctx: Ctx, bucket: string, id: string, limit: number, windowSec: number): Promise<void> {
  const { key, windowStartMs, windowMs } = rateLimitKey(ctx, bucket, id, windowSec);
  const found = await ctx.kv.getJSON<{ n: number }>(key);
  const n = found && Number.isFinite(found.n) ? found.n : 0;
  if (n >= limit) throw tooManyRequests(ctx, windowStartMs, windowMs);
}

/** Counts one hit in the window and never refuses. A count lost to heavy contention is let go. */
export async function rateLimitCount(ctx: Ctx, bucket: string, id: string, windowSec: number): Promise<void> {
  try {
    await rateLimit(ctx, bucket, id, Number.MAX_SAFE_INTEGER, windowSec);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 429)) throw err;
  }
}

/**
 * Gives back one hit that rateLimit counted in the current window (never below zero). For a limit
 * that takes its place before the outcome is known and keeps only what went wrong: a sign-in counts
 * itself before the password is checked, so guesses sent all at once cannot pass the ceiling together,
 * and gives the place back when the password was right. Best effort: a refund lost to contention or
 * to a window that just ended stays counted, which only errs on the safe side.
 */
export async function rateLimitRefund(ctx: Ctx, bucket: string, id: string, windowSec: number): Promise<void> {
  const { key } = rateLimitKey(ctx, bucket, id, windowSec);
  for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt++) {
    const found = await ctx.kv.getJSONWithEtag<{ n: number }>(key);
    const n = found && Number.isFinite(found.value?.n) ? found.value.n : 0;
    if (!found || n <= 0) return;
    const written = await ctx.kv.setJSON(key, { n: n - 1 }, { onlyIfMatch: found.etag });
    if (written.modified) return;
    await Promise.resolve();
  }
}
