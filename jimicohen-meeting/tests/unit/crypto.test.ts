import { describe, expect, it } from 'vitest';
import {
  hasValidSecretKey,
  hashPassword,
  hmacHex,
  open,
  randomId,
  randomToken,
  safeEqual,
  seal,
  sha256Hex,
  signPayload,
  verifyPassword,
  verifyPayload,
} from '../../server/lib/crypto';
import { makeTestCtx } from '../helpers/ctx';

const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

/** Flips one character of a base64url string to another valid character. */
function flipChar(s: string, index: number): string {
  const replacement = s[index] === 'A' ? 'B' : 'A';
  return s.slice(0, index) + replacement + s.slice(index + 1);
}

describe('ids and hashes', () => {
  it('randomId: prefix, underscore, 16 lowercase url-safe characters', () => {
    const id = randomId('bkg');
    expect(id).toMatch(/^bkg_[a-z2-7]{16}$/);
  });

  it('randomId does not repeat', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => randomId('x')));
    expect(ids.size).toBe(2000);
  });

  it('randomToken: base64url, 24 bytes by default', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(24);
    expect(Buffer.from(randomToken(48), 'base64url')).toHaveLength(48);
    expect(randomToken()).not.toBe(randomToken());
  });

  it('randomToken refuses sizes too small to be a secret', () => {
    expect(() => randomToken(4)).toThrow();
    expect(() => randomToken(1.5)).toThrow();
  });

  it('sha256Hex matches the known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('safeEqual compares content, whatever the lengths', () => {
    expect(safeEqual('token-value', 'token-value')).toBe(true);
    expect(safeEqual('token-value', 'token-valuf')).toBe(false);
    expect(safeEqual('short', 'a much longer string')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('a', undefined as unknown as string)).toBe(false);
  });
});

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same password 123'), hashPassword('same password 123')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password 123', b)).toBe(true);
  });

  it('rejects malformed or tampered records without throwing', async () => {
    const stored = await hashPassword('another password 456');
    const [scheme, params, salt, hash] = stored.split('$');
    expect(await verifyPassword('another password 456', '')).toBe(false);
    expect(await verifyPassword('another password 456', 'plaintext')).toBe(false);
    expect(await verifyPassword('another password 456', `bcrypt$${params}$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword('another password 456', `${scheme}$${params}$${salt}$${flipChar(hash, 3)}`)).toBe(false);
    expect(await verifyPassword('another password 456', `${scheme}$${params}$${flipChar(salt, 3)}$${hash}`)).toBe(false);
    // Absurd cost parameters must be refused, not attempted.
    expect(await verifyPassword('another password 456', `${scheme}$N=1073741824,r=8,p=1$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword('another password 456', `${scheme}$N=65535,r=8,p=1$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword('another password 456', `${scheme}$N=16,r=8$${salt}$${hash}`)).toBe(false);
  });

  it('refuses empty and oversized passwords', async () => {
    await expect(hashPassword('')).rejects.toThrow();
    await expect(hashPassword('x'.repeat(5000))).rejects.toThrow();
  });
});

describe('seal / open', () => {
  it('round-trips text, including unicode and the empty string', () => {
    const ctx = makeTestCtx();
    const secret = 'refresh-token 1//0g✓ ünïcödé 🌱';
    const sealed = seal(ctx, 'google-refresh', secret);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain('refresh-token');
    expect(open(ctx, 'google-refresh', sealed)).toBe(secret);
    expect(open(ctx, 'google-refresh', seal(ctx, 'google-refresh', ''))).toBe('');
  });

  it('produces a different ciphertext every time', () => {
    const ctx = makeTestCtx();
    expect(seal(ctx, 'p', 'same')).not.toBe(seal(ctx, 'p', 'same'));
  });

  it('returns null when any part was tampered with', () => {
    const ctx = makeTestCtx();
    const sealed = seal(ctx, 'ics-url', 'https://example.com/private.ics');
    const body = sealed.slice(3);
    for (const index of [0, 5, Math.floor(body.length / 2), body.length - 2]) {
      expect(open(ctx, 'ics-url', `v1.${flipChar(body, index)}`)).toBeNull();
    }
    expect(open(ctx, 'ics-url', `v1.${body.slice(0, -4)}`)).toBeNull();
    expect(open(ctx, 'ics-url', `v2.${body}`)).toBeNull();
  });

  it('returns null for another purpose or another key', () => {
    const ctx = makeTestCtx();
    const sealed = seal(ctx, 'secrets', '{"a":1}');
    expect(open(ctx, 'google-refresh', sealed)).toBeNull();
    expect(open(makeTestCtx({ env: { secretKey: OTHER_KEY } }), 'secrets', sealed)).toBeNull();
  });

  it('returns null for garbage instead of throwing', () => {
    const ctx = makeTestCtx();
    for (const junk of ['', 'v1.', 'v1.!!!', 'not sealed at all', 'v1.AAAA', null, undefined, 42]) {
      expect(open(ctx, 'secrets', junk as unknown as string)).toBeNull();
    }
  });
});

describe('signPayload / verifyPayload', () => {
  it('round-trips the payload', () => {
    const ctx = makeTestCtx();
    const token = signPayload(ctx, 'gstate', { hostId: 'host_owner', returnTo: '/meeting/admin', n: 'abc' }, 600);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyPayload(ctx, 'gstate', token)).toEqual({ hostId: 'host_owner', returnTo: '/meeting/admin', n: 'abc' });
  });

  it('expires exactly ttl seconds after signing', () => {
    const ctx = makeTestCtx({ now: '2026-11-16T09:00:00.000Z' });
    const token = signPayload(ctx, 'session', { v: 1 }, 600);
    ctx.clock.advance(599_999);
    expect(verifyPayload(ctx, 'session', token)).toEqual({ v: 1 });
    ctx.clock.advance(1);
    expect(verifyPayload(ctx, 'session', token)).toBeNull();
    ctx.clock.advance(86_400_000);
    expect(verifyPayload(ctx, 'session', token)).toBeNull();
  });

  it('rejects a changed payload, a changed signature, another purpose and another key', () => {
    const ctx = makeTestCtx();
    const token = signPayload(ctx, 'session', { v: 1 }, 600);
    const [body, sig] = token.split('.');

    const forgedBody = Buffer.from(JSON.stringify({ d: { v: 2 }, exp: ctx.now().getTime() + 10 ** 9 }), 'utf8').toString('base64url');
    expect(verifyPayload(ctx, 'session', `${forgedBody}.${sig}`)).toBeNull();
    expect(verifyPayload(ctx, 'session', `${body}.${flipChar(sig, 4)}`)).toBeNull();
    expect(verifyPayload(ctx, 'gstate', token)).toBeNull();
    expect(verifyPayload(makeTestCtx({ env: { secretKey: OTHER_KEY } }), 'session', token)).toBeNull();
  });

  it('rejects malformed tokens without throwing', () => {
    const ctx = makeTestCtx();
    for (const junk of ['', '.', 'abc', 'abc.', '.abc', 'a.b.c', 'x'.repeat(10_000), null, undefined, {}]) {
      expect(verifyPayload(ctx, 'session', junk as unknown as string)).toBeNull();
    }
  });

  it('keeps a payload field named exp apart from the real expiry', () => {
    const ctx = makeTestCtx();
    const token = signPayload(ctx, 'p', { exp: 1, note: 'mine' }, 60);
    expect(verifyPayload(ctx, 'p', token)).toEqual({ exp: 1, note: 'mine' });
  });

  it('refuses a non-positive ttl', () => {
    const ctx = makeTestCtx();
    expect(() => signPayload(ctx, 'p', { a: 1 }, 0)).toThrow();
    expect(() => signPayload(ctx, 'p', { a: 1 }, Number.NaN)).toThrow();
  });
});

describe('hmacHex', () => {
  it('is deterministic and depends on data, purpose and key', () => {
    const ctx = makeTestCtx();
    const mac = hmacHex(ctx, 'manage', 'bkg_123');
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacHex(ctx, 'manage', 'bkg_123')).toBe(mac);
    expect(hmacHex(ctx, 'manage', 'bkg_124')).not.toBe(mac);
    expect(hmacHex(ctx, 'other', 'bkg_123')).not.toBe(mac);
    expect(hmacHex(makeTestCtx({ env: { secretKey: OTHER_KEY } }), 'manage', 'bkg_123')).not.toBe(mac);
  });

  it('is not interchangeable with a signature or a seal key for the same purpose', () => {
    const ctx = makeTestCtx();
    const token = signPayload(ctx, 'manage', { id: 'bkg_123' }, 60);
    const body = token.split('.')[0];
    const sigHex = Buffer.from(token.split('.')[1], 'base64url').toString('hex');
    expect(hmacHex(ctx, 'manage', body)).not.toBe(sigHex);
  });
});

describe('master secret', () => {
  it('accepts 32 random bytes in base64 or base64url, and long raw strings', () => {
    expect(hasValidSecretKey(makeTestCtx())).toBe(true);
    expect(hasValidSecretKey(makeTestCtx({ env: { secretKey: Buffer.alloc(32, 250).toString('base64url') } }))).toBe(true);
    expect(hasValidSecretKey(makeTestCtx({ env: { secretKey: 'a passphrase with spaces that is long enough!' } }))).toBe(true);
  });

  it('refuses a missing or short secret everywhere', () => {
    for (const secretKey of ['', 'short', Buffer.alloc(16, 1).toString('base64')]) {
      const ctx = makeTestCtx({ env: { secretKey } });
      expect(hasValidSecretKey(ctx)).toBe(false);
      expect(() => seal(ctx, 'p', 'x')).toThrow(/MEETING_SECRET_KEY/);
      expect(() => signPayload(ctx, 'p', { a: 1 }, 60)).toThrow(/MEETING_SECRET_KEY/);
      expect(() => hmacHex(ctx, 'p', 'x')).toThrow(/MEETING_SECRET_KEY/);
      // open/verify never throw: an unusable key simply opens nothing.
      expect(open(ctx, 'p', 'v1.AAAA')).toBeNull();
      expect(verifyPayload(ctx, 'p', 'a.b')).toBeNull();
    }
  });
});
