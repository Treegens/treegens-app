/**
 * Signing in to the dashboard.
 *
 *   GET  /auth/state     { setupRequired, authenticated }
 *   POST /auth/setup     { code, password, deviceTimezone? }  first run only: creates the admin and signs in
 *   POST /auth/login     { password }
 *   POST /auth/logout
 *   POST /auth/password  { current, next }                    signed in; keeps this session, ends all others
 *
 * Every POST passes the same-origin check (assertSameOrigin, directly or through requireAdmin).
 * Guessing is slowed down per visitor and overall, and a failed sign-in always gets the same
 * answer, whatever the reason.
 */
import type { AuthState } from '../../shared/types';
import {
  assertSameOrigin,
  changeAdminPassword,
  createAdminAuth,
  getAdminAuth,
  isAdmin,
  rateLimit,
  requireAdmin,
  sessionClearCookie,
  sessionSetCookie,
} from '../lib/auth';
import { MAX_PASSWORD_LENGTH, safeEqual, sha256Hex, verifyPassword } from '../lib/crypto';
import type { Ctx } from '../lib/ctx';
import { HttpError, json, readJson, route, type Route } from '../lib/http';
import { getSite, updateHost } from '../lib/repo';
import { isZone } from '../lib/validate';

export const MIN_PASSWORD_LENGTH = 10;
const ATTEMPTS_PER_VISITOR = 8;
const VISITOR_WINDOW_SEC = 10 * 60;
const ATTEMPTS_OVERALL = 40;
const OVERALL_WINDOW_SEC = 60 * 60;

/** Slows down guessing: a small allowance per visitor, and a ceiling for everyone together. */
async function limitAttempts(ctx: Ctx, bucket: 'login' | 'setup' | 'password'): Promise<void> {
  await rateLimit(ctx, `${bucket}-ip`, ctx.ip ?? 'unknown', ATTEMPTS_PER_VISITOR, VISITOR_WINDOW_SEC);
  await rateLimit(ctx, `${bucket}-all`, 'everyone', ATTEMPTS_OVERALL, OVERALL_WINDOW_SEC);
}

function signedIn(ctx: Ctx, passwordVersion: number): Response {
  return json({ ok: true }, 200, { 'Set-Cookie': sessionSetCookie(ctx, passwordVersion) });
}

function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

export const routes: Route[] = [
  route('GET', '/auth/state', async ({ ctx, req }) => {
    const admin = await getAdminAuth(ctx);
    const state: AuthState = { setupRequired: !admin, authenticated: !!admin && (await isAdmin(ctx, req)) };
    return json(state);
  }),

  route('POST', '/auth/setup', async ({ ctx, req }) => {
    assertSameOrigin(ctx, req);
    if (await getAdminAuth(ctx)) throw new HttpError(409, 'already_set_up', 'This dashboard is already set up. Please sign in with your password.');
    const expected = ctx.env.setupCodeHash;
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) {
      throw new HttpError(
        503,
        'setup_unavailable',
        'Setup is not possible yet because this deployment has no setup code. Set MEETING_SETUP_CODE_HASH in the deployment settings, redeploy, and open this page again.',
      );
    }
    await limitAttempts(ctx, 'setup');

    const body = await readJson<{ code?: unknown; password?: unknown; deviceTimezone?: unknown }>(req);
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    // Compared in constant time, hash against hash, so nothing about the code leaks through timing.
    if (code === '' || code.length > 512 || !safeEqual(sha256Hex(code), expected.toLowerCase())) {
      throw new HttpError(403, 'wrong_setup_code', 'That setup code is not right.', { code: 'That setup code is not right.' });
    }
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(422, 'invalid', 'Please check the highlighted fields.', { password: problem });

    // Create-only: when two setups race, exactly one of them gets a record back.
    const admin = await createAdminAuth(ctx, body.password as string);
    if (!admin) throw new HttpError(409, 'already_set_up', 'This dashboard is already set up. Please sign in with your password.');

    try {
      const site = await getSite(ctx);
      const zone = body.deviceTimezone;
      if (isZone(zone)) {
        await updateHost(ctx, site.ownerHostId, (h) => (h.timezoneMode === 'device' ? { ...h, timezone: zone as string } : h));
      }
    } catch (err) {
      // The account exists and the owner is signed in. The zone follows on the next dashboard load.
      ctx.log('warn', 'setup: could not store the device time zone', { error: err instanceof Error ? err.name : 'unknown' });
    }
    ctx.log('info', 'setup: the dashboard was set up');
    return signedIn(ctx, admin.passwordVersion);
  }),

  route('POST', '/auth/login', async ({ ctx, req }) => {
    assertSameOrigin(ctx, req);
    await limitAttempts(ctx, 'login');
    const body = await readJson<{ password?: unknown }>(req);
    const admin = await getAdminAuth(ctx);
    const password = typeof body.password === 'string' ? body.password : '';
    // One answer for every failure: no password, a wrong one, or a dashboard that is not set up yet.
    if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
      throw new HttpError(401, 'invalid_credentials', 'That password is not right. Please try again.');
    }
    return signedIn(ctx, admin.passwordVersion);
  }),

  route('POST', '/auth/logout', async ({ ctx, req }) => {
    assertSameOrigin(ctx, req);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionClearCookie(ctx) });
  }),

  route('POST', '/auth/password', async ({ ctx, req }) => {
    await requireAdmin(ctx, req);
    await limitAttempts(ctx, 'password');
    const body = await readJson<{ current?: unknown; next?: unknown }>(req);
    const current = typeof body.current === 'string' ? body.current : '';
    const problem = passwordProblem(body.next);
    if (problem) throw new HttpError(422, 'invalid', 'Please check the highlighted fields.', { next: problem });
    const next = body.next as string;

    const admin = await getAdminAuth(ctx);
    if (!admin || !(await verifyPassword(current, admin.passwordHash))) {
      throw new HttpError(403, 'wrong_password', 'That is not your current password.', { current: 'That is not your current password.' });
    }
    if (next === current) throw new HttpError(422, 'invalid', 'Please check the highlighted fields.', { next: 'Choose a password you are not using now.' });

    const changed = await changeAdminPassword(ctx, next);
    if (!changed) throw new HttpError(409, 'setup_required', 'This dashboard is not set up yet.');
    ctx.log('info', 'auth: the dashboard password was changed');
    // Every older session carries the previous version and is now signed out. This one gets a fresh cookie.
    return signedIn(ctx, changed.passwordVersion);
  }),
];
