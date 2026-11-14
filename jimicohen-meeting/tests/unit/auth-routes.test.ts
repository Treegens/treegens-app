import { describe, expect, it, vi } from 'vitest';

// The booking engine and the public routes belong to another module. These tests are about
// signing in, so they are replaced with stand-ins and cannot be affected by work in progress there.
vi.mock('../../server/lib/booking', async () => {
  const { hmacHex } = await import('../../server/lib/crypto');
  return {
    manageToken: (ctx: never, id: string) => hmacHex(ctx, 'manage', id),
    verifyManageToken: vi.fn(() => false),
    cancelBooking: vi.fn(),
    confirmAttendance: vi.fn(),
    rescheduleBooking: vi.fn(),
    createBooking: vi.fn(),
    getSlots: vi.fn(),
    toPublicSite: vi.fn(),
    toPublicEventType: vi.fn(),
    toPublicBooking: vi.fn(),
    syncBookingToCalendar: vi.fn(),
  };
});
vi.mock('../../server/routes/public', () => ({ routes: [] }));
vi.mock('../../server/routes/webhooks', () => ({ routes: [] }));
vi.mock('../../server/cron', () => ({ runScheduled: async () => ({}) }));

import { handle } from '../../server/api';
import { getAdminAuth, rateLimitKey, SESSION_COOKIE } from '../../server/lib/auth';
import { sha256Hex } from '../../server/lib/crypto';
import { getHost, getSite, updateHost } from '../../server/lib/repo';
import { apiRequest, cookiePair, makeTestCtx, type TestCtx } from '../helpers/ctx';

const SETUP_CODE = 'first-run-code-123';
const PASSWORD = 'correct horse battery';

function newCtx(env: Record<string, unknown> = {}): TestCtx {
  return makeTestCtx({ env: { setupCodeHash: sha256Hex(SETUP_CODE), ...env } });
}

function post(ctx: TestCtx, path: string, body: unknown, opts: { cookie?: string; headers?: Record<string, string>; origin?: string | null } = {}): Promise<Response> {
  return handle(apiRequest('POST', path, { body, ...opts }), ctx);
}

async function state(ctx: TestCtx, cookie?: string): Promise<{ setupRequired: boolean; authenticated: boolean }> {
  const res = await handle(apiRequest('GET', '/auth/state', { cookie }), ctx);
  expect(res.status).toBe(200);
  return res.json();
}

async function setUp(ctx: TestCtx, password = PASSWORD): Promise<string> {
  const res = await post(ctx, '/auth/setup', { code: SETUP_CODE, password, deviceTimezone: 'Africa/Nairobi' });
  expect(res.status).toBe(200);
  return cookiePair(res.headers.get('set-cookie') ?? '');
}

describe('GET /auth/state', () => {
  it('asks for setup on a fresh install and reports the session afterwards', async () => {
    const ctx = newCtx();
    expect(await state(ctx)).toEqual({ setupRequired: true, authenticated: false });
    const cookie = await setUp(ctx);
    expect(await state(ctx)).toEqual({ setupRequired: false, authenticated: false });
    expect(await state(ctx, cookie)).toEqual({ setupRequired: false, authenticated: true });
    expect(await state(ctx, `${SESSION_COOKIE}=not-a-session`)).toEqual({ setupRequired: false, authenticated: false });
  });
});

describe('POST /auth/setup', () => {
  it('says clearly that setup is impossible without a setup code in the deployment', async () => {
    const ctx = makeTestCtx();
    const res = await post(ctx, '/auth/setup', { code: 'anything', password: PASSWORD });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('setup_unavailable');
    expect(body.error.message).toContain('MEETING_SETUP_CODE_HASH');
    expect(await getAdminAuth(ctx)).toBeNull();
  });

  it('refuses a wrong code with 403 and a message on the code field', async () => {
    const ctx = newCtx();
    for (const code of ['wrong-code', '', SETUP_CODE.toUpperCase(), `${SETUP_CODE}x`]) {
      const res = await post(ctx, '/auth/setup', { code, password: PASSWORD });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.fields).toEqual({ code: 'That setup code is not right.' });
    }
    // A missing or non-text code is just another wrong code.
    expect((await post(ctx, '/auth/setup', { code: 12345, password: PASSWORD })).status).toBe(403);
    expect(await getAdminAuth(ctx)).toBeNull();
    expect((await state(ctx)).setupRequired).toBe(true);
  });

  it('asks for at least 10 characters with 422 and a message on the password field', async () => {
    const ctx = newCtx();
    for (const password of ['short', '123456789', undefined, 12345678901]) {
      const res = await post(ctx, '/auth/setup', { code: SETUP_CODE, password });
      expect(res.status).toBe(422);
      expect((await res.json()).error.fields.password).toMatch(/at least 10/);
    }
    expect(await getAdminAuth(ctx)).toBeNull();
  });

  it('creates the admin, signs in, and takes the owner time zone from the device', async () => {
    const ctx = newCtx();
    const res = await post(ctx, '/auth/setup', { code: `  ${SETUP_CODE} `, password: PASSWORD, deviceTimezone: 'Africa/Nairobi' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/meeting');

    const admin = await getAdminAuth(ctx);
    expect(admin?.passwordVersion).toBe(1);
    expect(admin?.passwordHash).not.toContain(PASSWORD);
    const site = await getSite(ctx);
    expect((await getHost(ctx, site.ownerHostId))?.timezone).toBe('Africa/Nairobi');

    const bootstrap = await handle(apiRequest('GET', '/admin/bootstrap', { cookie: cookiePair(setCookie) }), ctx);
    expect(bootstrap.status).toBe(200);
  });

  it('ignores a device time zone it cannot use, and one for an owner who fixed their zone', async () => {
    const odd = newCtx();
    expect((await post(odd, '/auth/setup', { code: SETUP_CODE, password: PASSWORD, deviceTimezone: 'Mars/Olympus' })).status).toBe(200);
    expect((await getHost(odd, 'host_owner'))?.timezone).toBe('UTC');

    const fixed = newCtx();
    await getSite(fixed);
    await updateHost(fixed, 'host_owner', (h) => ({ ...h, timezoneMode: 'fixed', timezone: 'Europe/London' }));
    expect((await post(fixed, '/auth/setup', { code: SETUP_CODE, password: PASSWORD, deviceTimezone: 'Africa/Nairobi' })).status).toBe(200);
    expect((await getHost(fixed, 'host_owner'))?.timezone).toBe('Europe/London');
  });

  it('works exactly once: a second setup gets 409, even with the right code', async () => {
    const ctx = newCtx();
    await setUp(ctx);
    const again = await post(ctx, '/auth/setup', { code: SETUP_CODE, password: 'another password!' });
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('already_set_up');
    // The first password is still the one that works.
    expect((await post(ctx, '/auth/login', { password: PASSWORD })).status).toBe(200);
    expect((await post(ctx, '/auth/login', { password: 'another password!' })).status).toBe(401);
  });

  it('lets only one of two racing setups win', async () => {
    const ctx = newCtx();
    const results = await Promise.all([
      post(ctx, '/auth/setup', { code: SETUP_CODE, password: 'the first password' }),
      post(ctx, '/auth/setup', { code: SETUP_CODE, password: 'the second password' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results[0].status === 200 ? 'the first password' : 'the second password';
    const loser = results[0].status === 200 ? 'the second password' : 'the first password';
    expect((await post(ctx, '/auth/login', { password: winner })).status).toBe(200);
    expect((await post(ctx, '/auth/login', { password: loser })).status).toBe(401);
  });

  it('slows down code guessing like sign-in attempts', async () => {
    const ctx = newCtx();
    for (let i = 0; i < 8; i++) expect((await post(ctx, '/auth/setup', { code: `guess-${i}`, password: PASSWORD })).status).toBe(403);
    const blocked = await post(ctx, '/auth/setup', { code: SETUP_CODE, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await getAdminAuth(ctx)).toBeNull();
    // The window passes and the real owner gets in.
    ctx.clock.advance(10 * 60_000 + 1000);
    expect((await post(ctx, '/auth/setup', { code: SETUP_CODE, password: PASSWORD })).status).toBe(200);
  });
});

describe('POST /auth/login and /auth/logout', () => {
  it('gives every failure the same answer', async () => {
    const before = newCtx();
    const notSetUp = await post(before, '/auth/login', { password: PASSWORD });
    const ctx = newCtx();
    await setUp(ctx);
    const wrong = await post(ctx, '/auth/login', { password: 'not the password' });
    const empty = await post(ctx, '/auth/login', {});
    const odd = await post(ctx, '/auth/login', { password: { $ne: null } });
    const bodies = await Promise.all([notSetUp, wrong, empty, odd].map((r) => r.json()));
    for (const res of [notSetUp, wrong, empty, odd]) {
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0].error.code).toBe('invalid_credentials');
  });

  it('signs in with the right password and signs out again', async () => {
    const ctx = newCtx();
    await setUp(ctx);
    const res = await post(ctx, '/auth/login', { password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = cookiePair(res.headers.get('set-cookie') ?? '');
    expect((await state(ctx, cookie)).authenticated).toBe(true);

    const out = await post(ctx, '/auth/logout', {}, { cookie });
    expect(out.status).toBe(200);
    const cleared = out.headers.get('set-cookie') ?? '';
    expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(cleared).toContain('Max-Age=0');
    // The browser now sends nothing, and nothing means signed out.
    expect((await state(ctx, cookiePair(cleared))).authenticated).toBe(false);
    // Signing out twice, or without ever having signed in, is fine.
    expect((await post(ctx, '/auth/logout', {})).status).toBe(200);
  });

  it('blocks a visitor after 8 attempts in 10 minutes, even with the right password', async () => {
    const ctx = newCtx();
    await setUp(ctx);
    for (let i = 0; i < 8; i++) expect((await post(ctx, '/auth/login', { password: `guess number ${i}` })).status).toBe(401);
    const blocked = await post(ctx, '/auth/login', { password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe('rate_limited');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);

    // Someone else is not affected.
    const elsewhere = makeTestCtx({ kv: ctx.kv, ip: '198.51.100.9', env: ctx.env });
    expect((await post(elsewhere, '/auth/login', { password: PASSWORD })).status).toBe(200);

    ctx.clock.advance(10 * 60_000 + 1000);
    expect((await post(ctx, '/auth/login', { password: PASSWORD })).status).toBe(200);
  });

  it('stops everyone once 40 attempts were made in an hour', async () => {
    const ctx = newCtx();
    await setUp(ctx);
    // 40 earlier attempts from all over the place.
    await ctx.kv.setJSON(rateLimitKey(ctx, 'login-all', 'everyone', 3600).key, { n: 40 });
    const res = await post(makeTestCtx({ kv: ctx.kv, ip: '198.51.100.77', env: ctx.env }), '/auth/login', { password: PASSWORD });
    expect(res.status).toBe(429);
  });
});

describe('POST /auth/password', () => {
  it('needs a session', async () => {
    const ctx = newCtx();
    await setUp(ctx);
    const res = await post(ctx, '/auth/password', { current: PASSWORD, next: 'a brand new password' });
    expect(res.status).toBe(401);
  });

  it('checks the current password and the new one', async () => {
    const ctx = newCtx();
    const cookie = await setUp(ctx);

    const wrong = await post(ctx, '/auth/password', { current: 'not my password', next: 'a brand new password' }, { cookie });
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error.fields).toEqual({ current: 'That is not your current password.' });

    const short = await post(ctx, '/auth/password', { current: PASSWORD, next: 'tooshort' }, { cookie });
    expect(short.status).toBe(422);
    expect((await short.json()).error.fields.next).toMatch(/at least 10/);

    const same = await post(ctx, '/auth/password', { current: PASSWORD, next: PASSWORD }, { cookie });
    expect(same.status).toBe(422);
    expect((await same.json()).error.fields.next).toMatch(/not using now/);

    expect((await getAdminAuth(ctx))?.passwordVersion).toBe(1);
  });

  it('keeps this session signed in and signs every older one out', async () => {
    const ctx = newCtx();
    const first = await setUp(ctx);
    const login = await post(ctx, '/auth/login', { password: PASSWORD });
    const other = cookiePair(login.headers.get('set-cookie') ?? '');

    const res = await post(ctx, '/auth/password', { current: PASSWORD, next: 'a brand new password' }, { cookie: first });
    expect(res.status).toBe(200);
    const fresh = cookiePair(res.headers.get('set-cookie') ?? '');
    expect(fresh).not.toBe(first);
    expect((await getAdminAuth(ctx))?.passwordVersion).toBe(2);

    expect((await handle(apiRequest('GET', '/admin/bootstrap', { cookie: fresh }), ctx)).status).toBe(200);
    for (const stale of [first, other]) {
      expect((await handle(apiRequest('GET', '/admin/bootstrap', { cookie: stale }), ctx)).status).toBe(401);
      expect((await state(ctx, stale)).authenticated).toBe(false);
    }
    expect((await post(ctx, '/auth/login', { password: PASSWORD })).status).toBe(401);
    expect((await post(ctx, '/auth/login', { password: 'a brand new password' })).status).toBe(200);
  });
});

describe('cross-site requests', () => {
  it('are refused on every auth POST', async () => {
    const ctx = newCtx();
    const cookie = await setUp(ctx);
    const cases: [string, unknown][] = [
      ['/auth/setup', { code: SETUP_CODE, password: PASSWORD }],
      ['/auth/login', { password: PASSWORD }],
      ['/auth/logout', {}],
      ['/auth/password', { current: PASSWORD, next: 'a brand new password' }],
    ];
    for (const [path, body] of cases) {
      const foreign = await post(ctx, path, body, { cookie, origin: 'https://evil.example' });
      expect(foreign.status, `${path} from another origin`).toBe(403);
      expect((await foreign.json()).error.code).toBe('csrf');

      const noHeader = await post(ctx, path, body, { cookie, headers: { 'x-requested-with': 'XMLHttpRequest' } });
      expect(noHeader.status, `${path} without our header`).toBe(403);

      const noOrigin = await post(ctx, path, body, { cookie, origin: null });
      expect(noOrigin.status, `${path} without an origin`).toBe(403);
    }
    // Nothing happened: the password is unchanged and the session still works.
    expect((await getAdminAuth(ctx))?.passwordVersion).toBe(1);
    expect((await state(ctx, cookie)).authenticated).toBe(true);
  });
});
