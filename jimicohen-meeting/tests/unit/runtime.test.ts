import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleLogger, envFromProcess, netlifyCtx, normalizeBaseUrl, redactForLog } from '../../server/lib/runtime';

const ENV_NAMES = [
  'MEETING_SECRET_KEY',
  'MEETING_SETUP_CODE_HASH',
  'PUBLIC_BASE_URL',
  'URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'ANTHROPIC_API_KEY',
  'RESEND_API_KEY',
  'MEETING_CLIENT_IP_HEADER',
  'MEETING_MOCK_PROVIDERS',
];

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const name of ENV_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.restoreAllMocks();
});

describe('normalizeBaseUrl', () => {
  it('removes trailing slashes and keeps the mount path', () => {
    expect(normalizeBaseUrl('https://jimicohen.com/meeting')).toBe('https://jimicohen.com/meeting');
    expect(normalizeBaseUrl('https://jimicohen.com/meeting/')).toBe('https://jimicohen.com/meeting');
    expect(normalizeBaseUrl('http://localhost:8788/meeting')).toBe('http://localhost:8788/meeting');
  });

  it('adds the mount path to a bare origin', () => {
    expect(normalizeBaseUrl('https://jimicohen.com')).toBe('https://jimicohen.com/meeting');
    expect(normalizeBaseUrl('https://meeting-site.netlify.app/')).toBe('https://meeting-site.netlify.app/meeting');
  });

  it('returns an empty string for anything unusable', () => {
    for (const bad of [undefined, '', 'jimicohen.com/meeting', 'ftp://jimicohen.com/meeting', 'not a url']) expect(normalizeBaseUrl(bad)).toBe('');
  });
});

describe('envFromProcess', () => {
  it('reads every documented variable', () => {
    process.env.MEETING_SECRET_KEY = ' c2VjcmV0 ';
    process.env.MEETING_SETUP_CODE_HASH = 'AB'.repeat(32);
    process.env.PUBLIC_BASE_URL = 'https://jimicohen.com/meeting/';
    process.env.GOOGLE_CLIENT_ID = 'gid';
    process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
    process.env.TWILIO_ACCOUNT_SID = 'AC1';
    process.env.TWILIO_AUTH_TOKEN = 'ttoken';
    process.env.TWILIO_FROM_NUMBER = '+15550001111';
    process.env.ANTHROPIC_API_KEY = 'akey';
    process.env.RESEND_API_KEY = 'rkey';

    expect(envFromProcess()).toEqual({
      secretKey: 'c2VjcmV0',
      setupCodeHash: 'ab'.repeat(32),
      publicBaseUrl: 'https://jimicohen.com/meeting',
      mockProviders: false,
      overrides: {
        googleClientId: 'gid',
        googleClientSecret: 'gsecret',
        twilioAccountSid: 'AC1',
        twilioAuthToken: 'ttoken',
        twilioFromNumber: '+15550001111',
        anthropicApiKey: 'akey',
        resendApiKey: 'rkey',
      },
    });
  });

  it('has safe values when nothing is set', () => {
    const env = envFromProcess();
    expect(env.secretKey).toBe('');
    expect(env.setupCodeHash).toBeNull();
    expect(env.publicBaseUrl).toBe('');
    expect(env.mockProviders).toBe(false);
    expect(Object.values(env.overrides).every((v) => v === undefined)).toBe(true);
  });

  it('falls back to the Netlify site URL and ignores a malformed setup hash', () => {
    process.env.URL = 'https://meeting-site.netlify.app';
    process.env.MEETING_SETUP_CODE_HASH = 'not-a-sha256';
    process.env.GOOGLE_CLIENT_ID = '   ';
    const env = envFromProcess();
    expect(env.publicBaseUrl).toBe('https://meeting-site.netlify.app/meeting');
    expect(env.setupCodeHash).toBeNull();
    expect(env.overrides.googleClientId).toBeUndefined();
  });

  it('can never be switched to mock providers from the environment', () => {
    process.env.MEETING_MOCK_PROVIDERS = '1';
    expect(envFromProcess().mockProviders).toBe(false);
  });
});

describe('redactForLog', () => {
  it('masks values under credential-looking keys at any depth', () => {
    const out = redactForLog({
      user: 'ada@example.com',
      password: 'hunter2hunter2',
      refreshTokenEnc: 'v1.abc',
      nested: { authToken: 't', apiKey: 'k', api_key: 'k2', Authorization: 'Bearer x', list: [{ clientSecret: 's', ok: 1 }] },
      headers: { cookie: 'mtg_session=abc', 'x-twilio-signature': 'sig' },
    });
    expect(out).toEqual({
      user: 'ada@example.com',
      password: '[redacted]',
      refreshTokenEnc: '[redacted]',
      nested: { authToken: '[redacted]', apiKey: '[redacted]', api_key: '[redacted]', Authorization: '[redacted]', list: [{ clientSecret: '[redacted]', ok: 1 }] },
      headers: { cookie: '[redacted]', 'x-twilio-signature': '[redacted]' },
    });
  });

  it('makes errors, dates, cycles and oversized strings loggable', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const out = redactForLog({ error: new RangeError('boom'), at: new Date('2026-11-16T09:00:00Z'), cyclic, long: 'x'.repeat(5000), big: 10n }) as Record<string, any>;
    expect(out.error).toMatchObject({ name: 'RangeError', message: 'boom' });
    expect(out.error.stack).toContain('boom');
    expect(out.at).toBe('2026-11-16T09:00:00.000Z');
    expect(out.cyclic).toEqual({ name: 'loop', self: '[circular]' });
    expect(out.long.length).toBeLessThan(2100);
    expect(out.big).toBe('10');
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe('consoleLogger', () => {
  it('writes one JSON line per call to the stream that matches the level', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = consoleLogger('req_1');

    logger('info', 'request', { status: 200, token: 'secret-value' });
    logger('warn', 'slow');
    logger('error', 'failed', { error: new Error('nope') });

    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ level: 'info', msg: 'request', requestId: 'req_1', data: { status: 200, token: '[redacted]' } });
    expect(JSON.parse(warn.mock.calls[0][0])).toEqual({ level: 'warn', msg: 'slow', requestId: 'req_1' });
    expect(JSON.parse(error.mock.calls[0][0]).data.error.message).toBe('nope');
    expect(log.mock.calls[0][0]).not.toContain('secret-value');
  });
});

describe('netlifyCtx', () => {
  const request = () => new Request('https://meeting-site.netlify.app/meeting/api/public/site', { headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' } });

  it('builds a context from the invocation', () => {
    process.env.MEETING_SECRET_KEY = 'k'.repeat(44);
    process.env.PUBLIC_BASE_URL = 'https://jimicohen.com/meeting';
    const ctx = netlifyCtx(request(), { ip: '203.0.113.7', requestId: '01HREQ', waitUntil: () => undefined });
    expect(ctx.env.publicBaseUrl).toBe('https://jimicohen.com/meeting');
    expect(ctx.env.mockProviders).toBe(false);
    expect(ctx.ip).toBe('203.0.113.7');
    expect(ctx.requestId).toBe('01HREQ');
    expect(Math.abs(ctx.now().getTime() - Date.now())).toBeLessThan(5000);
    expect(typeof ctx.fetch).toBe('function');
    expect(typeof ctx.kv.getJSON).toBe('function');
  });

  it('derives the public URL from the request when nothing is configured, and invents a request id', () => {
    const ctx = netlifyCtx(request(), {});
    expect(ctx.env.publicBaseUrl).toBe('https://meeting-site.netlify.app/meeting');
    expect(ctx.ip).toBeNull();
    expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('takes the visitor address from a configured proxy header', () => {
    process.env.MEETING_CLIENT_IP_HEADER = 'x-forwarded-for';
    expect(netlifyCtx(request(), { ip: '203.0.113.7' }).ip).toBe('198.51.100.9');
    process.env.MEETING_CLIENT_IP_HEADER = 'x-not-sent';
    expect(netlifyCtx(request(), { ip: '203.0.113.7' }).ip).toBe('203.0.113.7');
  });

  it('hands background work to the platform and swallows its failures into the log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handed: Promise<unknown>[] = [];
    const ctx = netlifyCtx(request(), { waitUntil: (p) => void handed.push(p) });

    ctx.waitUntil(Promise.reject(new Error('background boom')));
    ctx.waitUntil(Promise.resolve('fine'));
    expect(handed).toHaveLength(2);
    await expect(Promise.all(handed)).resolves.toBeDefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('background boom');

    // Without platform support the work still runs and still cannot crash the process.
    const bare = netlifyCtx(request(), {});
    expect(() => bare.waitUntil(Promise.reject(new Error('also fine')))).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalledTimes(2);
  });
});
