import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertSameOrigin,
  changeAdminPassword,
  createAdminAuth,
  getAdminAuth,
  hostFromToken,
  isAdmin,
  rateLimit,
  rateLimitKey,
  requireAdmin,
  SESSION_COOKIE,
  sessionClearCookie,
  sessionSetCookie,
  type AdminAuth,
} from '../../server/lib/auth';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../../server/lib/crypto';
import { HttpError } from '../../server/lib/http';
import { getHost, saveHost } from '../../server/lib/repo';
import { apiRequest, cookiePair, makeTestCtx, TEST_NOW, type TestCtx } from '../helpers/ctx';

const DAY_MS = 86_400_000;
const PASSWORD = 'a long first password';

// Hashing is deliberately slow, so one real hash is shared by the tests that only need "an admin exists".
let sharedHash = '';
beforeAll(async () => {
  sharedHash = await hashPassword(PASSWORD);
});

async function seedAdmin(ctx: TestCtx, passwordVersion = 1): Promise<AdminAuth> {
  const record: AdminAuth = { passwordHash: sharedHash, passwordVersion, setupUsedAt: ctx.now().toISOString() };
  await ctx.kv.setJSON('auth/admin', record);
  return record;
}

function expectHttpError(fn: () => unknown, status: number, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  expect(thrown).toMatchObject({ status, code });
}

describe('admin record', () => {
  it('createAdminAuth works exactly once', async () => {
    const ctx = makeTestCtx();
    expect(await getAdminAuth(ctx)).toBeNull();
    const created = await createAdminAuth(ctx, PASSWORD);
    expect(created).toMatchObject({ passwordVersion: 1, setupUsedAt: TEST_NOW });
    expect(created!.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, created!.passwordHash)).toBe(true);
    expect(await getAdminAuth(ctx)).toEqual(created);

    expect(await createAdminAuth(ctx, 'someone else tries later')).toBeNull();
    expect(await getAdminAuth(ctx)).toEqual(created);
  });

  it('lets only one of two racing setups win', async () => {
    const ctx = makeTestCtx();
    const results = await Promise.all([createAdminAuth(ctx, 'first racing password'), createAdminAuth(ctx, 'second racing password')]);
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(await getAdminAuth(ctx)).toEqual(winners[0]);
  });

  it('changeAdminPassword is a no-op before setup', async () => {
    expect(await changeAdminPassword(makeTestCtx(), 'whatever password')).toBeNull();
  });
});

describe('session cookie', () => {
  it('round-trips: a cookie from sessionSetCookie signs the admin in', async () => {
    const ctx = makeTestCtx();
    const admin = await seedAdmin(ctx);
    const setCookie = sessionSetCookie(ctx, admin.passwordVersion);

    expect(setCookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    const attributes = setCookie.split('; ').slice(1);
    expect(attributes).toEqual(['Path=/meeting', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=2592000']);

    expect(await isAdmin(ctx, apiRequest('GET', '/admin/bootstrap', { cookie: cookiePair(setCookie) }))).toBe(true);
    await expect(requireAdmin(ctx, apiRequest('GET', '/admin/bootstrap', { cookie: cookiePair(setCookie) }))).resolves.toBeUndefined();
  });

  it('finds the session among other cookies', async () => {
    const ctx = makeTestCtx();
    await seedAdmin(ctx);
    const pair = cookiePair(sessionSetCookie(ctx, 1));
    const req = apiRequest('GET', '/admin/bootstrap', { cookie: `theme=dark; ${pair}; other="quoted value"` });
    expect(await isAdmin(ctx, req)).toBe(true);
    // A stale duplicate (same name, other path) must not hide the valid one.
    const dup = apiRequest('GET', '/admin/bootstrap', { cookie: `${SESSION_COOKIE}=stale.value; ${pair}` });
    expect(await isAdmin(ctx, dup)).toBe(true);
  });

  it('drops Secure only on a plain-http dev origin', () => {
    const dev = makeTestCtx({ env: { publicBaseUrl: 'http://localhost:8788/meeting' } });
    expect(sessionSetCookie(dev, 1)).not.toContain('Secure');
    expect(sessionSetCookie(dev, 1)).toContain('HttpOnly');
    expect(sessionClearCookie(dev)).not.toContain('Secure');
    expect(sessionSetCookie(makeTestCtx(), 1)).toContain('; Secure;');
  });

  it('sessionClearCookie expires the cookie on the same path', () => {
    const cleared = sessionClearCookie();
    expect(cleared).toBe(`${SESSION_COOKIE}=; Path=/meeting; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    expect(sessionClearCookie(makeTestCtx())).toBe(cleared);
  });

  it('is not signed in without a cookie, with junk, or before setup', async () => {
    const ctx = makeTestCtx();
    const cookieBeforeSetup = cookiePair(sessionSetCookie(ctx, 1));
    expect(await isAdmin(ctx, apiRequest('GET', '/admin/bootstrap', { cookie: cookieBeforeSetup }))).toBe(false);

    await seedAdmin(ctx);
    expect(await isAdmin(ctx, apiRequest('GET', '/admin/bootstrap'))).toBe(false);
    for (const cookie of [`${SESSION_COOKIE}=`, `${SESSION_COOKIE}=abc.def`, `${SESSION_COOKIE}=not-a-token`, `other=${cookieBeforeSetup.split('=')[1]}`]) {
      expect(await isAdmin(ctx, apiRequest('GET', '/admin/bootstrap', { cookie }))).toBe(false);
    }
  });

  it('rejects a session signed with another key', async () => {
    const ctx = makeTestCtx();
    await seedAdmin(ctx);
    const forged = cookiePair(sessionSetCookie(makeTestCtx({ env: { secretKey: Buffer.alloc(32, 3).toString('base64') } }), 1));
    expect(await isAdmin(ctx, apiRequest('GET', '/admin/bootstrap', { cookie: forged }))).toBe(false);
  });

  it('expires after 30 days', async () => {
    const ctx = makeTestCtx();
    await seedAdmin(ctx);
    const cookie = cookiePair(sessionSetCookie(ctx, 1));
    ctx.clock.advance(30 * DAY_MS - 1000);
    expect(await isAdmin(ctx, apiRequest('GET', '/admin/bootstrap', { cookie }))).toBe(true);
    ctx.clock.advance(1000);
    expect(await isAdmin(ctx, apiRequest('GET', '/admin/bootstrap', { cookie }))).toBe(false);
  });

  it('is invalidated when the password version changes', async () => {
    const ctx = makeTestCtx();
    await seedAdmin(ctx, 1);
    const oldCookie = cookiePair(sessionSetCookie(ctx, 1));
    expect(await isAdmin(ctx, apiRequest('GET', '/admin/bootstrap', { cookie: oldCookie }))).toBe(true);

    const changed = await changeAdminPassword(ctx, 'a brand new password');
    expect(changed?.passwordVersion).toBe(2);
    expect(changed?.setupUsedAt).toBe(TEST_NOW);
    expect(await verifyPassword('a brand new password', changed!.passwordHash)).toBe(true);
    expect(await verifyPassword(PASSWORD, changed!.passwordHash)).toBe(false);

    expect(await isAdmin(ctx, apiRequest('GET', '/admin/bootstrap', { cookie: oldCookie }))).toBe(false);
    await expect(requireAdmin(ctx, apiRequest('GET', '/admin/bootstrap', { cookie: oldCookie }))).rejects.toMatchObject({ status: 401 });

    const newCookie = cookiePair(sessionSetCookie(ctx, changed!.passwordVersion));
    expect(await isAdmin(ctx, apiRequest('GET', '/admin/bootstrap', { cookie: newCookie }))).toBe(true);
  });
});

describe('requireAdmin', () => {
  it('answers 401 without a session', async () => {
    const ctx = makeTestCtx();
    await seedAdmin(ctx);
    await expect(requireAdmin(ctx, apiRequest('GET', '/admin/bootstrap'))).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    await expect(requireAdmin(ctx, apiRequest('PUT', '/admin/site', { body: {} }))).rejects.toMatchObject({ status: 401 });
  });

  it('lets a signed-in GET through without any CSRF headers', async () => {
    const ctx = makeTestCtx();
    await seedAdmin(ctx);
    const cookie = cookiePair(sessionSetCookie(ctx, 1));
    const bare = new Request('https://jimicohen.com/meeting/api/admin/bootstrap', { headers: { cookie } });
    await expect(requireAdmin(ctx, bare)).resolves.toBeUndefined();
  });

  it('enforces the CSRF checks on state-changing requests even with a valid session', async () => {
    const ctx = makeTestCtx();
    await seedAdmin(ctx);
    const cookie = cookiePair(sessionSetCookie(ctx, 1));

    await expect(requireAdmin(ctx, apiRequest('PUT', '/admin/site', { cookie, body: {} }))).resolves.toBeUndefined();

    const noHeader = new Request('https://jimicohen.com/meeting/api/admin/site', {
      method: 'PUT',
      headers: { cookie, origin: 'https://jimicohen.com', 'content-type': 'application/json' },
      body: '{}',
    });
    await expect(requireAdmin(ctx, noHeader)).rejects.toMatchObject({ status: 403, code: 'csrf' });

    const crossSite = apiRequest('DELETE', '/admin/hosts/host_x', { cookie, origin: 'https://evil.example' });
    await expect(requireAdmin(ctx, crossSite)).rejects.toMatchObject({ status: 403, code: 'csrf' });
  });
});

describe('assertSameOrigin', () => {
  const ctx = makeTestCtx();
  const post = (headers: Record<string, string>, url = 'https://jimicohen.com/meeting/api/public/bookings') =>
    new Request(url, { method: 'POST', headers, body: '{}' });

  it('ignores GET and HEAD', () => {
    expect(() => assertSameOrigin(ctx, new Request('https://jimicohen.com/meeting/api/x'))).not.toThrow();
    expect(() => assertSameOrigin(ctx, new Request('https://jimicohen.com/meeting/api/x', { method: 'HEAD' }))).not.toThrow();
  });

  it('accepts the public origin with the marker header', () => {
    expect(() => assertSameOrigin(ctx, post({ 'x-requested-with': 'meeting', origin: 'https://jimicohen.com' }))).not.toThrow();
    expect(() => assertSameOrigin(ctx, post({ 'X-Requested-With': 'Meeting', Origin: 'https://jimicohen.com' }))).not.toThrow();
  });

  it('needs the marker header with the exact value', () => {
    expectHttpError(() => assertSameOrigin(ctx, post({ origin: 'https://jimicohen.com' })), 403, 'csrf');
    expectHttpError(() => assertSameOrigin(ctx, post({ 'x-requested-with': 'XMLHttpRequest', origin: 'https://jimicohen.com' })), 403, 'csrf');
  });

  it('rejects other origins, including look-alikes', () => {
    for (const origin of [
      'https://evil.example',
      'http://jimicohen.com',
      'https://jimicohen.com.evil.example',
      'https://sub.jimicohen.com',
      'https://jimicohen.com:8443',
      'null',
      'not a url',
    ]) {
      expectHttpError(() => assertSameOrigin(ctx, post({ 'x-requested-with': 'meeting', origin })), 403, 'csrf');
    }
  });

  it('falls back to Referer when there is no Origin', () => {
    expect(() =>
      assertSameOrigin(ctx, post({ 'x-requested-with': 'meeting', referer: 'https://jimicohen.com/meeting/intro?month=2026-11' })),
    ).not.toThrow();
    expectHttpError(() => assertSameOrigin(ctx, post({ 'x-requested-with': 'meeting', referer: 'https://evil.example/meeting/intro' })), 403, 'csrf');
  });

  it('rejects when neither Origin nor Referer is present', () => {
    expectHttpError(() => assertSameOrigin(ctx, post({ 'x-requested-with': 'meeting' })), 403, 'csrf');
  });

  it("accepts the request's own host (deploy previews, local dev behind a proxy)", () => {
    const preview = 'https://deploy-preview-7--meeting.netlify.app/meeting/api/public/bookings';
    expect(() =>
      assertSameOrigin(ctx, post({ 'x-requested-with': 'meeting', origin: 'https://deploy-preview-7--meeting.netlify.app' }, preview)),
    ).not.toThrow();
    expectHttpError(() => assertSameOrigin(ctx, post({ 'x-requested-with': 'meeting', origin: 'https://evil.example' }, preview)), 403, 'csrf');

    const dev = makeTestCtx({ env: { publicBaseUrl: 'http://localhost:8788/meeting' } });
    const viaVite = 'http://localhost:5173/meeting/api/auth/login';
    expect(() => assertSameOrigin(dev, post({ 'x-requested-with': 'meeting', origin: 'http://localhost:5173' }, viaVite))).not.toThrow();
    expect(() => assertSameOrigin(dev, post({ 'x-requested-with': 'meeting', origin: 'http://localhost:8788' }, viaVite))).not.toThrow();
  });
});

describe('hostFromToken', () => {
  it('returns the host only for its current invite token', async () => {
    const ctx = makeTestCtx();
    const token = randomToken();
    const owner = (await getHost(ctx, 'host_owner'))!;
    await saveHost(ctx, { ...owner, id: 'host_alex', role: 'member', name: 'Alex', inviteTokenHash: sha256Hex(token) });

    expect((await hostFromToken(ctx, 'host_alex', token))?.name).toBe('Alex');
    expect(await hostFromToken(ctx, 'host_alex', randomToken())).toBeNull();
    expect(await hostFromToken(ctx, 'host_alex', null)).toBeNull();
    expect(await hostFromToken(ctx, 'host_alex', '')).toBeNull();
    expect(await hostFromToken(ctx, 'host_alex', sha256Hex(token))).toBeNull(); // the stored hash is not a credential
    expect(await hostFromToken(ctx, 'host_unknown', token)).toBeNull();
    // The owner has no invite token: nothing unlocks it this way.
    expect(await hostFromToken(ctx, 'host_owner', token)).toBeNull();
  });

  it('stops accepting the old token once a new one is issued', async () => {
    const ctx = makeTestCtx();
    const oldToken = randomToken();
    const newToken = randomToken();
    const owner = (await getHost(ctx, 'host_owner'))!;
    await saveHost(ctx, { ...owner, id: 'host_alex', role: 'member', inviteTokenHash: sha256Hex(oldToken) });
    await saveHost(ctx, { ...owner, id: 'host_alex', role: 'member', inviteTokenHash: sha256Hex(newToken) });
    expect(await hostFromToken(ctx, 'host_alex', oldToken)).toBeNull();
    expect(await hostFromToken(ctx, 'host_alex', newToken)).not.toBeNull();
  });
});

describe('rateLimit', () => {
  it('allows `limit` hits per window, then answers 429 with Retry-After', async () => {
    const ctx = makeTestCtx({ now: '2026-11-16T09:00:20.000Z' });
    for (let i = 0; i < 3; i++) await rateLimit(ctx, 'login', '203.0.113.7', 3, 60);

    const blocked = rateLimit(ctx, 'login', '203.0.113.7', 3, 60);
    await expect(blocked).rejects.toBeInstanceOf(HttpError);
    await expect(blocked).rejects.toMatchObject({ status: 429, code: 'rate_limited', headers: { 'Retry-After': '40' } });
    // Blocked attempts do not extend the count.
    expect(await ctx.kv.getJSON(rateLimitKey(ctx, 'login', '203.0.113.7', 60).key)).toEqual({ n: 3 });
  });

  it('starts fresh in the next window', async () => {
    const ctx = makeTestCtx({ now: '2026-11-16T09:00:20.000Z' });
    for (let i = 0; i < 2; i++) await rateLimit(ctx, 'login', 'id', 2, 60);
    await expect(rateLimit(ctx, 'login', 'id', 2, 60)).rejects.toMatchObject({ status: 429 });

    ctx.clock.advance(39_999);
    await expect(rateLimit(ctx, 'login', 'id', 2, 60)).rejects.toMatchObject({ status: 429 });
    ctx.clock.advance(1); // 09:01:00.000, the next window
    await expect(rateLimit(ctx, 'login', 'id', 2, 60)).resolves.toBeUndefined();
    await expect(rateLimit(ctx, 'login', 'id', 2, 60)).resolves.toBeUndefined();
    await expect(rateLimit(ctx, 'login', 'id', 2, 60)).rejects.toMatchObject({ status: 429 });
  });

  it('counts ids and buckets separately', async () => {
    const ctx = makeTestCtx();
    await rateLimit(ctx, 'book-ip', '203.0.113.7', 1, 3600);
    await expect(rateLimit(ctx, 'book-ip', '203.0.113.7', 1, 3600)).rejects.toMatchObject({ status: 429 });
    await expect(rateLimit(ctx, 'book-ip', '203.0.113.8', 1, 3600)).resolves.toBeUndefined();
    await expect(rateLimit(ctx, 'book-email', '203.0.113.7', 1, 3600)).resolves.toBeUndefined();
  });

  it('never lets parallel requests past the limit', async () => {
    const ctx = makeTestCtx();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => rateLimit(ctx, 'burst', 'same-id', 4, 60)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 429 });
    expect(await ctx.kv.getJSON(rateLimitKey(ctx, 'burst', 'same-id', 60).key)).toEqual({ n: 4 });
  });

  it('stores only a keyed hash of the id, in the documented key layout', async () => {
    const ctx = makeTestCtx({ now: '2026-11-16T09:00:20.000Z' });
    await rateLimit(ctx, 'book-email', 'ada@example.com', 6, 3600);
    await rateLimit(ctx, 'login', '203.0.113.7', 8, 600);

    const keys = await ctx.kv.list('rl/');
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).not.toContain('ada');
      expect(key).not.toContain('203.0.113.7');
      expect(key).toMatch(/^rl\/[a-z-]+\/[0-9a-f]{64}\/\d+$/);
    }
    const windowStart = Date.parse('2026-11-16T09:00:00.000Z');
    expect(keys.find((k) => k.startsWith('rl/book-email/'))?.endsWith(`/${windowStart}`)).toBe(true);
    // Not a plain SHA-256 either: an IP address would be trivial to recover from one.
    expect(keys.join(' ')).not.toContain(sha256Hex('203.0.113.7'));
    expect(keys.join(' ')).not.toContain(sha256Hex('ada@example.com'));
  });

  it('rejects bucket names that could reshape the key', async () => {
    const ctx = makeTestCtx();
    await expect(rateLimit(ctx, 'a/b', 'id', 1, 60)).rejects.toThrow();
    await expect(rateLimit(ctx, '', 'id', 1, 60)).rejects.toThrow();
  });
});
