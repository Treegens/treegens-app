import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertSameOrigin,
  changeAdminPassword,
  createAdminAuth,
  DEVICE_COOKIE,
  DEVICE_TTL_SEC,
  deviceSetCookie,
  getAdminAuth,
  hostFromToken,
  isAdmin,
  isKnownDevice,
  noteSetupCode,
  rateLimit,
  rateLimitCount,
  rateLimitKey,
  rateLimitPeek,
  requireAdmin,
  resetAdminPassword,
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
    expect(created).toMatchObject({ passwordVersion: expect.any(Number), setupUsedAt: TEST_NOW });
    expect(created!.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, created!.passwordHash)).toBe(true);
    expect(await getAdminAuth(ctx)).toEqual(created);

    expect(await createAdminAuth(ctx, 'someone else tries later')).toBeNull();
    expect(await getAdminAuth(ctx)).toEqual(created);
  });

  it('starts at a random password version, so a record made again never takes the sessions of an earlier one', async () => {
    const versions = new Set<number>();
    for (let i = 0; i < 4; i++) {
      const ctx = makeTestCtx();
      const created = (await createAdminAuth(ctx, PASSWORD))!;
      expect(Number.isInteger(created.passwordVersion) && created.passwordVersion >= 1 && created.passwordVersion < 2 ** 31).toBe(true);
      versions.add(created.passwordVersion);
    }
    expect(versions.size).toBeGreaterThan(1);

    // The record is deleted by hand and setup is run again: the session from before does not open the new one.
    const ctx = makeTestCtx();
    const before = (await createAdminAuth(ctx, PASSWORD))!;
    const oldSession = cookiePair(sessionSetCookie(ctx, before.passwordVersion));
    await ctx.kv.delete('auth/admin');
    const again = (await createAdminAuth(ctx, 'a password after starting over'))!;
    expect(again.passwordVersion).not.toBe(before.passwordVersion);
    expect(await isAdmin(ctx, apiRequest('GET', '/admin/bootstrap', { cookie: oldSession }))).toBe(false);
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

  it('remembers which setup code set the password, and only a different one can replace it', async () => {
    const first = sha256Hex('the first setup code');
    const second = sha256Hex('the second setup code');
    const ctx = makeTestCtx({ env: { setupCodeHash: first } });
    expect(await resetAdminPassword(ctx, 'too early to reset', first)).toBeNull();
    const created = await createAdminAuth(ctx, PASSWORD, first);
    expect(created).toMatchObject({ setupCodeHash: first });
    const v0 = created!.passwordVersion;

    // The code that created the dashboard does not work a second time.
    expect(await resetAdminPassword(ctx, 'a password from the same code', first)).toBe('code_used');
    expect(await getAdminAuth(ctx)).toEqual(created);

    ctx.clock.advance(DAY_MS);
    const reset = await resetAdminPassword(ctx, 'a password after the reset', second);
    expect(reset).toMatchObject({ passwordVersion: v0 + 1, setupCodeHash: second, setupUsedAt: TEST_NOW, passwordResetAt: new Date(Date.parse(TEST_NOW) + DAY_MS).toISOString() });
    const stored = (await getAdminAuth(ctx))!;
    expect(stored).toEqual(reset);
    expect(await verifyPassword('a password after the reset', stored.passwordHash)).toBe(true);
    expect(await verifyPassword(PASSWORD, stored.passwordHash)).toBe(false);
    // And the new code is used up too.
    expect(await resetAdminPassword(ctx, 'once more with the second', second.toUpperCase())).toBe('code_used');
    expect((await getAdminAuth(ctx))?.passwordVersion).toBe(v0 + 1);
  });

  it('a record from before setup codes were remembered takes the code deployed when it is first seen as used', async () => {
    const original = sha256Hex('the original code');
    const ctx = makeTestCtx({ env: { setupCodeHash: original } });
    await seedAdmin(ctx); // no setupCodeHash
    await noteSetupCode(ctx, await getAdminAuth(ctx));
    expect((await getAdminAuth(ctx))?.setupCodeHash).toBe(original);
    // Never overwritten once known.
    await noteSetupCode(makeTestCtx({ kv: ctx.kv, env: { setupCodeHash: sha256Hex('something else') } }), await getAdminAuth(ctx));
    expect((await getAdminAuth(ctx))?.setupCodeHash).toBe(original);
    expect(await resetAdminPassword(ctx, 'the original code again', original)).toBe('code_used');

    // Seen first while no code was deployed: any code deployed later is a new one.
    const bare = makeTestCtx();
    await seedAdmin(bare);
    await noteSetupCode(bare, await getAdminAuth(bare));
    expect((await getAdminAuth(bare))?.setupCodeHash).toBe('');
    expect(await resetAdminPassword(bare, 'a new password for bare', sha256Hex('deployed later'))).toMatchObject({ passwordVersion: 2 });

    // A reset straight away (nothing looked at the record before) refuses the code that is deployed now.
    const direct = makeTestCtx({ env: { setupCodeHash: original } });
    await seedAdmin(direct);
    expect(await resetAdminPassword(direct, 'a password for direct', original)).toBe('code_used');
    expect((await getAdminAuth(direct))?.passwordVersion).toBe(1);
  });
});

describe('known device cookie', () => {
  it('is long-lived, HttpOnly and on the app path', () => {
    const ctx = makeTestCtx();
    const setCookie = deviceSetCookie(ctx, 1);
    expect(setCookie.startsWith(`${DEVICE_COOKIE}=`)).toBe(true);
    expect(setCookie.split('; ').slice(1)).toEqual(['Path=/meeting', 'HttpOnly', 'Secure', 'SameSite=Lax', `Max-Age=${DEVICE_TTL_SEC}`]);
    expect(DEVICE_TTL_SEC).toBe(400 * 86_400);
    expect(deviceSetCookie(makeTestCtx({ env: { publicBaseUrl: 'http://localhost:8788/meeting' } }), 1)).not.toContain('Secure');
  });

  it('counts only for the current password, and only when it is ours', async () => {
    const ctx = makeTestCtx();
    const admin = await seedAdmin(ctx, 3);
    const withCookie = (cookie: string) => apiRequest('POST', '/auth/login', { cookie });
    expect(isKnownDevice(ctx, withCookie(cookiePair(deviceSetCookie(ctx, 3))), admin)).toBe(true);
    expect(isKnownDevice(ctx, withCookie(`theme=dark; ${cookiePair(deviceSetCookie(ctx, 3))}`), admin)).toBe(true);
    // Issued before the password changed.
    expect(isKnownDevice(ctx, withCookie(cookiePair(deviceSetCookie(ctx, 2))), admin)).toBe(false);
    // A session token under the device name, a forged value, nothing at all, no dashboard yet.
    expect(isKnownDevice(ctx, withCookie(`${DEVICE_COOKIE}=${cookiePair(sessionSetCookie(ctx, 3)).split('=')[1]}`), admin)).toBe(false);
    expect(isKnownDevice(ctx, withCookie(`${DEVICE_COOKIE}=not.valid`), admin)).toBe(false);
    expect(isKnownDevice(ctx, apiRequest('POST', '/auth/login'), admin)).toBe(false);
    expect(isKnownDevice(ctx, withCookie(cookiePair(deviceSetCookie(ctx, 3))), null)).toBe(false);
    // Signed with another secret.
    const other = makeTestCtx({ env: { secretKey: Buffer.alloc(32, 9).toString('base64') } });
    expect(isKnownDevice(ctx, withCookie(cookiePair(deviceSetCookie(other, 3))), admin)).toBe(false);
    // About 400 days later it has run out.
    const later = makeTestCtx({ kv: ctx.kv, now: Date.parse(TEST_NOW) + DEVICE_TTL_SEC * 1000 + 1000 });
    expect(isKnownDevice(later, withCookie(cookiePair(deviceSetCookie(ctx, 3))), admin)).toBe(false);
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

  it('rateLimitPeek refuses like rateLimit without counting, rateLimitCount counts without refusing', async () => {
    const ctx = makeTestCtx({ now: '2026-11-16T09:00:20.000Z' });
    for (let i = 0; i < 5; i++) await rateLimitPeek(ctx, 'login-all', 'everyone', 2, 60);
    expect(await ctx.kv.getJSON(rateLimitKey(ctx, 'login-all', 'everyone', 60).key)).toBeNull();

    for (let i = 0; i < 3; i++) await rateLimitCount(ctx, 'login-all', 'everyone', 60);
    expect(await ctx.kv.getJSON(rateLimitKey(ctx, 'login-all', 'everyone', 60).key)).toEqual({ n: 3 });
    const blocked = rateLimitPeek(ctx, 'login-all', 'everyone', 3, 60);
    await expect(blocked).rejects.toMatchObject({ status: 429, code: 'rate_limited', headers: { 'Retry-After': '40' } });
    await expect(rateLimitPeek(ctx, 'login-all', 'everyone', 4, 60)).resolves.toBeUndefined();

    // Parallel counts are not lost.
    await Promise.all(Array.from({ length: 5 }, () => rateLimitCount(ctx, 'burst-count', 'same-id', 60)));
    expect(await ctx.kv.getJSON(rateLimitKey(ctx, 'burst-count', 'same-id', 60).key)).toEqual({ n: 5 });
  });

  it('rejects bucket names that could reshape the key', async () => {
    const ctx = makeTestCtx();
    await expect(rateLimit(ctx, 'a/b', 'id', 1, 60)).rejects.toThrow();
    await expect(rateLimit(ctx, '', 'id', 1, 60)).rejects.toThrow();
  });
});
