import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rateLimit } from '../../server/lib/auth';
import { applySecretOverrides } from '../../server/lib/repo';
import { consoleLogger, envFromProcess, netlifyCtx, normalizeBaseUrl, rateLimitAddress, redactForLog } from '../../server/lib/runtime';
import { makeTestCtx } from '../helpers/ctx';

/** Shaped like an Anthropic key, built at run time so no key-like literal sits in the source. */
const anthropicShaped = (fill: string): string => ['sk', 'ant', 'api03', fill.repeat(40)].join('-');

const ENV_NAMES = [
  'MEETING_SECRET_KEY',
  'MEETING_SETUP_CODE_HASH',
  'PUBLIC_BASE_URL',
  'EMBED_BASE_URL',
  'URL',
  'NETLIFY_AI_GATEWAY_KEY',
  'ANTHROPIC_BASE_URL',
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
    process.env.ANTHROPIC_API_KEY = anthropicShaped('a');
    process.env.RESEND_API_KEY = 'rkey';
    process.env.EMBED_BASE_URL = 'https://meeting-site.netlify.app/meeting/';

    expect(envFromProcess()).toEqual({
      secretKey: 'c2VjcmV0',
      setupCodeHash: 'ab'.repeat(32),
      publicBaseUrl: 'https://jimicohen.com/meeting',
      embedBaseUrl: 'https://meeting-site.netlify.app/meeting',
      mockProviders: false,
      overrides: {
        googleClientId: 'gid',
        googleClientSecret: 'gsecret',
        twilioAccountSid: 'AC1',
        twilioAuthToken: 'ttoken',
        twilioFromNumber: '+15550001111',
        anthropicApiKey: anthropicShaped('a'),
        resendApiKey: 'rkey',
      },
    });
  });

  it("does not take Netlify AI Gateway's injected ANTHROPIC_API_KEY for an Anthropic key", () => {
    // What Netlify's functions bootstrap writes when the site sets neither variable (measured: 366 characters,
    // not an sk-ant- key, equal to NETLIFY_AI_GATEWAY_KEY).
    const gateway = `nf${'G'.repeat(364)}`;
    process.env.NETLIFY_AI_GATEWAY_KEY = gateway;
    process.env.ANTHROPIC_API_KEY = gateway;
    process.env.ANTHROPIC_BASE_URL = 'https://meeting-site.netlify.app/.netlify/ai';
    expect(envFromProcess().overrides.anthropicApiKey).toBeUndefined();

    // The key saved in the dashboard is the one that is used.
    const saved = anthropicShaped('s');
    expect(applySecretOverrides({ anthropic: { apiKey: saved } }, envFromProcess().overrides).anthropic?.apiKey).toBe(saved);

    // Equal to the gateway value: ignored, whatever it looks like.
    process.env.NETLIFY_AI_GATEWAY_KEY = anthropicShaped('g');
    process.env.ANTHROPIC_API_KEY = anthropicShaped('g');
    expect(envFromProcess().overrides.anthropicApiKey).toBeUndefined();

    // Anything that is not an Anthropic key is ignored too.
    delete process.env.NETLIFY_AI_GATEWAY_KEY;
    for (const value of ['akey', `${anthropicShaped('x')} trailing`, `sk-ant-${'x'.repeat(400)}`]) {
      process.env.ANTHROPIC_API_KEY = value;
      expect(envFromProcess().overrides.anthropicApiKey, value.slice(0, 12)).toBeUndefined();
    }

    // A real key the site set itself still wins over the dashboard, as documented.
    process.env.NETLIFY_AI_GATEWAY_KEY = gateway;
    process.env.ANTHROPIC_API_KEY = anthropicShaped('e');
    expect(envFromProcess().overrides.anthropicApiKey).toBe(anthropicShaped('e'));
    expect(applySecretOverrides({ anthropic: { apiKey: saved } }, envFromProcess().overrides).anthropic?.apiKey).toBe(anthropicShaped('e'));
  });

  it("uses Netlify's own site address for embeds when EMBED_BASE_URL is not set", () => {
    process.env.PUBLIC_BASE_URL = 'https://jimicohen.com/meeting';
    process.env.URL = 'https://jimicohen-meeting.netlify.app';
    let env = envFromProcess();
    expect(env.publicBaseUrl).toBe('https://jimicohen.com/meeting');
    expect(env.embedBaseUrl).toBe('https://jimicohen-meeting.netlify.app/meeting');

    process.env.EMBED_BASE_URL = 'https://embed.example.net/meeting';
    expect(envFromProcess().embedBaseUrl).toBe('https://embed.example.net/meeting');

    delete process.env.EMBED_BASE_URL;
    delete process.env.URL;
    env = envFromProcess();
    expect(env.embedBaseUrl).toBeUndefined();
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
    // The header value is counted the same way as context.ip.
    process.env.MEETING_CLIENT_IP_HEADER = 'x-real-ip';
    const v6 = new Request('https://meeting-site.netlify.app/meeting/api/public/site', { headers: { 'x-real-ip': '2001:db8:1234:5678::99' } });
    expect(netlifyCtx(v6, { ip: '203.0.113.7' }).ip).toBe('2001:db8:1234:5678::/64');
  });

  it('counts an IPv6 visitor by its /64 and an IPv4 address written as IPv6 as itself', () => {
    expect(netlifyCtx(request(), { ip: '2001:db8:1234:5678:aaaa:bbbb:cccc:dddd' }).ip).toBe('2001:db8:1234:5678::/64');
    expect(netlifyCtx(request(), { ip: '2001:db8:1234:5678::1' }).ip).toBe('2001:db8:1234:5678::/64');
    expect(netlifyCtx(request(), { ip: '2001:db8:1234:5679::1' }).ip).toBe('2001:db8:1234:5679::/64');
    expect(netlifyCtx(request(), { ip: '::ffff:203.0.113.7' }).ip).toBe('203.0.113.7');
    expect(netlifyCtx(request(), { ip: ' 203.0.113.7 ' }).ip).toBe('203.0.113.7');
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

describe('rateLimitAddress', () => {
  it('reduces every spelling of an IPv6 address to the same /64', () => {
    const forms = ['2001:db8:0:5::1', '2001:DB8:0:5:ffff:ffff:ffff:ffff', '2001:0db8:0000:0005:0000:0000:0000:0001', '[2001:db8:0:5::1]:443'];
    expect(forms.map(rateLimitAddress)).toEqual(Array(4).fill('2001:db8:0:5::/64'));
    expect(rateLimitAddress('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rateLimitAddress('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitAddress('64:ff9b::198.51.100.9')).toBe('64:ff9b:0:0::/64');
  });

  it('unwraps an IPv4 address written as IPv6, in both notations', () => {
    expect(rateLimitAddress('::ffff:198.51.100.9')).toBe('198.51.100.9');
    expect(rateLimitAddress('::FFFF:c633:6409')).toBe('198.51.100.9');
    expect(rateLimitAddress('0:0:0:0:0:ffff:198.51.100.9')).toBe('198.51.100.9');
    expect(rateLimitAddress('198.51.100.9:5060')).toBe('198.51.100.9');
  });

  it('keeps anything that is not an address as it was sent', () => {
    expect(rateLimitAddress('unknown')).toBe('unknown');
    expect(rateLimitAddress(' 198.51.100.9 ')).toBe('198.51.100.9');
    expect(rateLimitAddress('999.1.1.1')).toBe('999.1.1.1');
  });

  it('makes a whole /64 share one allowance', async () => {
    const ctx = makeTestCtx();
    // Neighbours in one /64, each on its own address: before, every one of them had 8 tries of its own.
    for (let i = 1; i <= 8; i++) await rateLimit(ctx, 'login-ip', rateLimitAddress(`2001:db8:1234:5678::${i.toString(16)}`), 8, 600);
    await expect(rateLimit(ctx, 'login-ip', rateLimitAddress('2001:db8:1234:5678:9:9:9:9'), 8, 600)).rejects.toMatchObject({ status: 429 });
    // The next /64 is somebody else.
    await expect(rateLimit(ctx, 'login-ip', rateLimitAddress('2001:db8:1234:5679::1'), 8, 600)).resolves.toBeUndefined();
  });
});
