/**
 * Signing in to the dashboard.
 *
 *   GET  /auth/state     { setupRequired, authenticated }
 *   POST /auth/setup     { code, password, deviceTimezone?, email? }  first run: creates the admin and signs in.
 *                        Later: a NEW setup code (a different MEETING_SETUP_CODE_HASH, deployed) replaces
 *                        a forgotten password and signs every other session out.
 *   POST /auth/login     { password }
 *   POST /auth/logout
 *   POST /auth/password  { current, next }                    signed in; keeps this session, ends all others
 *
 * Every POST passes the same-origin check (assertSameOrigin, directly or through requireAdmin).
 * Guessing is slowed down per visitor, and failed sign-ins also by a ceiling for everyone together
 * that browsers which signed in before do not meet. A failed sign-in always gets the same answer,
 * whatever the reason.
 */
import type { AuthState } from '../../shared/types';
import {
  assertSameOrigin,
  changeAdminPassword,
  createAdminAuth,
  deviceSetCookie,
  getAdminAuth,
  isAdmin,
  isKnownDevice,
  noteSetupCode,
  rateLimit,
  rateLimitCount,
  rateLimitRefund,
  requireAdmin,
  resetAdminPassword,
  sessionClearCookie,
  sessionSetCookie,
} from '../lib/auth';
import { MAX_PASSWORD_LENGTH, safeEqual, sha256Hex, verifyPassword } from '../lib/crypto';
import type { Ctx } from '../lib/ctx';
import { HttpError, json, readJson, route, type Route } from '../lib/http';
import { getSite, updateHost } from '../lib/repo';
import { isEmail, isZone } from '../lib/validate';

export const MIN_PASSWORD_LENGTH = 10;
const ATTEMPTS_PER_VISITOR = 8;
const VISITOR_WINDOW_SEC = 10 * 60;
/**
 * Failed sign-ins from everyone together, per hour. Only failures count, and a browser that signed in
 * before is not held back by it, so strangers cannot close the door on the owner with a few requests.
 * It still caps guessing spread over many addresses.
 */
export const LOGIN_FAILURES_OVERALL = 300;
/** Password changes need a session, so this ceiling cannot be filled from outside. */
const PASSWORD_ATTEMPTS_OVERALL = 40;
const OVERALL_WINDOW_SEC = 60 * 60;

/** The allowance per visitor (an IPv6 visitor counts by its /64, see runtime.ts). Every attempt counts. */
async function limitVisitor(ctx: Ctx, bucket: 'login' | 'setup' | 'password'): Promise<void> {
  await rateLimit(ctx, `${bucket}-ip`, ctx.ip ?? 'unknown', ATTEMPTS_PER_VISITOR, VISITOR_WINDOW_SEC);
}

const ALREADY_SET_UP = 'This dashboard is already set up. Please sign in with your password.';

function signedIn(ctx: Ctx, passwordVersion: number): Response {
  const res = json({ ok: true }, 200, { 'Set-Cookie': sessionSetCookie(ctx, passwordVersion) });
  res.headers.append('Set-Cookie', deviceSetCookie(ctx, passwordVersion));
  return res;
}

function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

export const routes: Route[] = [
  route('GET', '/auth/state', async ({ ctx, req }) => {
    const admin = await getAdminAuth(ctx);
    // A record from before setup codes were remembered learns which one is deployed now (see noteSetupCode).
    await noteSetupCode(ctx, admin);
    const state: AuthState = { setupRequired: !admin, authenticated: !!admin && (await isAdmin(ctx, req)) };
    return json(state);
  }),

  route('POST', '/auth/setup', async ({ ctx, req }) => {
    assertSameOrigin(ctx, req);
    const expected = ctx.env.setupCodeHash;
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) {
      if (await getAdminAuth(ctx)) throw new HttpError(409, 'already_set_up', ALREADY_SET_UP);
      throw new HttpError(
        503,
        'setup_unavailable',
        'Setup is not possible yet because this deployment has no setup code. Set MEETING_SETUP_CODE_HASH in the deployment settings, redeploy, and open this page again.',
      );
    }
    // Per visitor only. The code is a deployment secret compared hash to hash, so a shared ceiling would
    // only let strangers block the owner's first setup, or a password reset during an attack.
    await limitVisitor(ctx, 'setup');

    const body = await readJson<{ code?: unknown; password?: unknown; deviceTimezone?: unknown; email?: unknown }>(req);
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    // Compared in constant time, hash against hash, so nothing about the code leaks through timing.
    // Checked before anything else, so a visitor without the code learns nothing about the dashboard.
    if (code === '' || code.length > 512 || !safeEqual(sha256Hex(code), expected.toLowerCase())) {
      throw new HttpError(403, 'wrong_setup_code', 'That setup code is not right.', { code: 'That setup code is not right.' });
    }
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(422, 'invalid', 'Please check the highlighted fields.', { password: problem });
    // Optional on the first run: where the owner's booking notices go, so they arrive from the first booking on.
    const noticesTo = typeof body.email === 'string' ? body.email.trim() : '';
    if (noticesTo !== '' && !isEmail(noticesTo)) throw new HttpError(422, 'invalid', 'Please check the highlighted fields.', { email: 'That email address does not look right.' });

    if (await getAdminAuth(ctx)) {
      // Forgotten password: a code that has not set a password yet replaces it.
      const reset = await resetAdminPassword(ctx, body.password as string, expected);
      if (reset === null || reset === 'code_used') throw new HttpError(409, 'already_set_up', ALREADY_SET_UP);
      ctx.log('warn', 'setup: a new setup code replaced the dashboard password; every other session is signed out');
      return signedIn(ctx, reset.passwordVersion);
    }

    // Create-only: when two setups race, exactly one of them gets a record back.
    const admin = await createAdminAuth(ctx, body.password as string, expected);
    if (!admin) throw new HttpError(409, 'already_set_up', ALREADY_SET_UP);

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
    if (noticesTo !== '') {
      try {
        const site = await getSite(ctx);
        await updateHost(ctx, site.ownerHostId, (h) => (isEmail(h.email) ? h : { ...h, email: noticesTo }));
      } catch (err) {
        // The account exists and the owner is signed in. Home asks for the address until it is there.
        ctx.log('warn', 'setup: could not store the address for booking notices', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    ctx.log('info', 'setup: the dashboard was set up');
    return signedIn(ctx, admin.passwordVersion);
  }),

  route('POST', '/auth/login', async ({ ctx, req }) => {
    assertSameOrigin(ctx, req);
    await limitVisitor(ctx, 'login');
    const admin = await getAdminAuth(ctx);
    // Strangers' failures can fill the shared ceiling; a browser that signed in before is not stopped by it.
    // Any other browser takes its place under the ceiling before the password is checked, so guesses sent
    // all at once cannot get past it together, and gives the place back when the password was right.
    const counted = !isKnownDevice(ctx, req, admin);
    if (counted) await rateLimit(ctx, 'login-all', 'everyone', LOGIN_FAILURES_OVERALL, OVERALL_WINDOW_SEC);
    const body = await readJson<{ password?: unknown }>(req);
    const password = typeof body.password === 'string' ? body.password : '';
    // One answer for every failure: no password, a wrong one, or a dashboard that is not set up yet.
    if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
      if (!counted) await rateLimitCount(ctx, 'login-all', 'everyone', OVERALL_WINDOW_SEC);
      throw new HttpError(401, 'invalid_credentials', 'That password is not right. Please try again.');
    }
    if (counted) {
      try {
        await rateLimitRefund(ctx, 'login-all', 'everyone', OVERALL_WINDOW_SEC);
      } catch (err) {
        // The owner is in. The place stays taken until the hour is over, which only errs on the safe side.
        ctx.log('warn', 'auth: could not give back a place under the sign-in ceiling', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    await noteSetupCode(ctx, admin);
    return signedIn(ctx, admin.passwordVersion);
  }),

  route('POST', '/auth/logout', async ({ ctx, req }) => {
    assertSameOrigin(ctx, req);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionClearCookie(ctx) });
  }),

  route('POST', '/auth/password', async ({ ctx, req }) => {
    await requireAdmin(ctx, req);
    await limitVisitor(ctx, 'password');
    await rateLimit(ctx, 'password-all', 'everyone', PASSWORD_ATTEMPTS_OVERALL, OVERALL_WINDOW_SEC);
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
