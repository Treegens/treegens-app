import { describe, expect, it, vi } from 'vitest';
import { saveSecrets } from '../../server/lib/repo';
import {
  blockNumber,
  computeTwilioSignature,
  DeadlineError,
  getTwilioAccount,
  isNumberBlocked,
  isRestrictedNumber,
  normalizePhone,
  publicRequestUrls,
  twilioConfigured,
  TwilioError,
  twilioFeatures,
  twilioRequest,
  TWILIO_TIMEOUT_MS,
  twimlResponse,
  unblockNumber,
  verifyTwilioRequest,
  withDeadline,
  xmlEscape,
} from '../../server/lib/twilio';
import { makeTestCtx, type TestCtx } from '../helpers/ctx';

// Built at runtime so the fake id is not a literal that secret scanners flag.
const SID = 'AC' + '0123456789abcdef'.repeat(2);
const TOKEN = 'test-auth-token';

async function configured(opts: Parameters<typeof makeTestCtx>[0] = {}, twilio: Record<string, string> = {}): Promise<TestCtx> {
  const ctx = makeTestCtx(opts);
  await saveSecrets(ctx, { twilio: { accountSid: SID, authToken: TOKEN, fromNumber: '+15005550006', ...twilio } });
  return ctx;
}

interface Seen {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const seen = { url: String(input), init };
    calls.push(seen);
    return respond(seen);
  }) as typeof fetch;
  return { calls, impl };
}

function webhook(url: string, form: Record<string, string>, signature?: string): { req: Request; form: URLSearchParams } {
  const body = new URLSearchParams(form);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (signature !== undefined) headers['x-twilio-signature'] = signature;
  return { req: new Request(url, { method: 'POST', headers, body: body.toString() }), form: body };
}

describe('computeTwilioSignature', () => {
  // The vector used by Twilio's own helper libraries (twilio-node, twilio-python request validator tests).
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' };
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';

  it('reproduces the official helper library vector', () => {
    expect(computeTwilioSignature('12345', url, params)).toBe('RSOYDt4T1cUTdK1PDd93/VVr8B8=');
  });

  it("reproduces the worked example from Twilio's security documentation", () => {
    const docs = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
    expect(computeTwilioSignature('12345', url, docs)).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });

  it('does not depend on the order the fields arrive in', () => {
    const shuffled = { To: params.To, Digits: params.Digits, CallSid: params.CallSid, From: params.From, Caller: params.Caller };
    expect(computeTwilioSignature('12345', url, shuffled)).toBe('RSOYDt4T1cUTdK1PDd93/VVr8B8=');
  });

  it('changes with the token, the URL and every field', () => {
    const good = computeTwilioSignature('12345', url, params);
    expect(computeTwilioSignature('12346', url, params)).not.toBe(good);
    expect(computeTwilioSignature('12345', `${url}&x=1`, params)).not.toBe(good);
    expect(computeTwilioSignature('12345', url, { ...params, Digits: '1235' })).not.toBe(good);
    expect(computeTwilioSignature('12345', url, { ...params, Extra: '' })).not.toBe(good);
  });
});

describe('verifyTwilioRequest', () => {
  const form = { CallSid: 'CA00000000000000000000000000000001', SpeechResult: 'yes I will be there', Confidence: '0.93' };
  const publicUrl = 'https://jimicohen.com/meeting/api/twilio/voice/turn?c=call_abc';
  // What the function really sees behind the proxy: its own host, the same path and query.
  const internalUrl = 'https://jimicohen-meeting.netlify.app/meeting/api/twilio/voice/turn?c=call_abc';

  it('accepts a signature made over the public URL even though the request arrives on the internal host', async () => {
    const ctx = await configured();
    const { req, form: body } = webhook(internalUrl, form, computeTwilioSignature(TOKEN, publicUrl, form));
    expect(await verifyTwilioRequest(ctx, req, body)).toBe(true);
  });

  it('rejects a signature made over the internal URL, a wrong token, a changed field and a changed query', async () => {
    const ctx = await configured();
    const overInternal = webhook(internalUrl, form, computeTwilioSignature(TOKEN, internalUrl, form));
    expect(await verifyTwilioRequest(ctx, overInternal.req, overInternal.form)).toBe(false);

    const wrongToken = webhook(internalUrl, form, computeTwilioSignature('someone-else', publicUrl, form));
    expect(await verifyTwilioRequest(ctx, wrongToken.req, wrongToken.form)).toBe(false);

    const tampered = webhook(internalUrl, { ...form, SpeechResult: 'cancel everything' }, computeTwilioSignature(TOKEN, publicUrl, form));
    expect(await verifyTwilioRequest(ctx, tampered.req, tampered.form)).toBe(false);

    const otherCall = webhook(internalUrl.replace('call_abc', 'call_xyz'), form, computeTwilioSignature(TOKEN, publicUrl, form));
    expect(await verifyTwilioRequest(ctx, otherCall.req, otherCall.form)).toBe(false);
  });

  it('rejects a missing or empty signature', async () => {
    const ctx = await configured();
    const none = webhook(internalUrl, form);
    expect(await verifyTwilioRequest(ctx, none.req, none.form)).toBe(false);
    const empty = webhook(internalUrl, form, '');
    expect(await verifyTwilioRequest(ctx, empty.req, empty.form)).toBe(false);
  });

  it('accepts the literal signature "mock" only in mock mode', async () => {
    const live = await configured();
    const a = webhook(internalUrl, form, 'mock');
    expect(await verifyTwilioRequest(live, a.req, a.form)).toBe(false);

    const dev = makeTestCtx({ env: { mockProviders: true } });
    const b = webhook(internalUrl, form, 'mock');
    expect(await verifyTwilioRequest(dev, b.req, b.form)).toBe(true);
    const c = webhook(internalUrl, form, 'not-mock');
    expect(await verifyTwilioRequest(dev, c.req, c.form)).toBe(false);
  });

  it('rejects everything when Twilio is not configured', async () => {
    const ctx = makeTestCtx();
    const { req, form: body } = webhook(internalUrl, form, computeTwilioSignature('', publicUrl, form));
    expect(await verifyTwilioRequest(ctx, req, body)).toBe(false);
  });

  it('accepts a signature that includes the default port, as some Twilio edges send', async () => {
    const ctx = await configured();
    const withPort = publicUrl.replace('jimicohen.com/', 'jimicohen.com:443/');
    const { req, form: body } = webhook(internalUrl, form, computeTwilioSignature(TOKEN, withPort, form));
    expect(await verifyTwilioRequest(ctx, req, body)).toBe(true);
  });

  it('accepts the app origin as well when one is configured, and nothing else', async () => {
    const ctx = await configured({ env: { embedBaseUrl: 'https://jimicohen-meeting.netlify.app/meeting' } });
    const viaApp = webhook(internalUrl, form, computeTwilioSignature(TOKEN, internalUrl, form));
    expect(await verifyTwilioRequest(ctx, viaApp.req, viaApp.form)).toBe(true);
    const viaElsewhere = webhook(internalUrl, form, computeTwilioSignature(TOKEN, publicUrl.replace('jimicohen.com', 'evil.example'), form));
    expect(await verifyTwilioRequest(ctx, viaElsewhere.req, viaElsewhere.form)).toBe(false);
  });

  it('signs repeated fields the way Twilio does: each distinct value once, sorted', async () => {
    const ctx = await configured();
    const body = new URLSearchParams([
      ['MediaUrl', 'b'],
      ['MediaUrl', 'a'],
      ['MediaUrl', 'b'],
      ['From', '+14155552671'],
    ]);
    const signature = computeTwilioSignature(TOKEN, 'https://jimicohen.com/meeting/api/twilio/smsFrom+14155552671MediaUrlaMediaUrlb', {});
    const req = new Request('https://jimicohen-meeting.netlify.app/meeting/api/twilio/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
      body: body.toString(),
    });
    expect(await verifyTwilioRequest(ctx, req, body)).toBe(true);
  });

  it('never builds a URL from a path outside the API', () => {
    const ctx = makeTestCtx();
    expect(publicRequestUrls(ctx, new Request('https://internal.example/other/path?c=1', { method: 'POST' }))).toEqual([]);
    expect(publicRequestUrls(ctx, new Request(internalUrl, { method: 'POST' }))).toEqual([publicUrl, publicUrl.replace('jimicohen.com/', 'jimicohen.com:443/')]);
  });
});

describe('twilioRequest', () => {
  it('posts form encoded parameters with HTTP Basic auth to the account URL', async () => {
    const net = fakeFetch(() => Response.json({ sid: 'SM123' }, { status: 201 }));
    const ctx = await configured({ fetch: net.impl });
    const out = await twilioRequest(ctx, 'POST', '/Messages.json', { To: '+14155552671', Body: 'Hi & bye' });
    expect(out).toEqual({ sid: 'SM123' });
    expect(net.calls).toHaveLength(1);
    const { url, init } = net.calls[0];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(String(init.body)).get('Body')).toBe('Hi & bye');
    expect(String(init.body)).toBe('To=%2B14155552671&Body=Hi+%26+bye');
  });

  it('puts GET parameters in the query string', async () => {
    const net = fakeFetch(() => Response.json({ calls: [] }));
    const ctx = await configured({ fetch: net.impl });
    await twilioRequest(ctx, 'GET', '/Calls.json', { PageSize: '5' });
    expect(net.calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json?PageSize=5`);
    expect(net.calls[0].init.body).toBeUndefined();
  });

  it('turns an API error into a TwilioError with the status and code, without leaking the token', async () => {
    const net = fakeFetch(() => Response.json({ code: 21211, message: "The 'To' number is not a valid phone number.", status: 400 }, { status: 400 }));
    const ctx = await configured({ fetch: net.impl });
    const err = await twilioRequest(ctx, 'POST', '/Messages.json', { To: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(TwilioError);
    expect(err.status).toBe(400);
    expect(err.code).toBe(21211);
    expect(err.message).toContain('not a valid phone number');
    expect(err.message).not.toContain(TOKEN);
  });

  it('reports a network failure and an unreadable answer as TwilioError', async () => {
    const down = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const ctx = await configured({ fetch: down.impl });
    const err = await twilioRequest(ctx, 'GET', '/Calls.json').catch((e) => e);
    expect(err).toBeInstanceOf(TwilioError);
    expect(err.status).toBe(0);

    const html = fakeFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    const ctx2 = await configured({ fetch: html.impl });
    await expect(twilioRequest(ctx2, 'GET', '/Calls.json')).rejects.toBeInstanceOf(TwilioError);
  });

  it('gives up when Twilio does not answer, even if the fetch ignores the abort signal', async () => {
    vi.useFakeTimers();
    try {
      const hang = fakeFetch(() => new Promise<Response>(() => undefined));
      const ctx = await configured({ fetch: hang.impl });
      const pending = twilioRequest(ctx, 'POST', '/Calls.json', { To: '+14155552671' }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(TWILIO_TIMEOUT_MS + 10);
      const err = await pending;
      expect(err).toBeInstanceOf(TwilioError);
      expect(err.message).toMatch(/did not answer in time/);
      expect((hang.calls[0].init.signal as AbortSignal).aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses paths that could leave the account', async () => {
    const net = fakeFetch(() => Response.json({}));
    const ctx = await configured({ fetch: net.impl });
    for (const path of ['/../Accounts.json', '../Accounts.json', '/Calls.json?x=1', '/Calls/../../x', '//evil.example/x', '/Calls.json#frag', '/Calls/a b.json', '']) {
      await expect(twilioRequest(ctx, 'GET', path), path).rejects.toBeInstanceOf(TwilioError);
    }
    expect(net.calls).toHaveLength(0);
  });

  it('accepts a path with or without the leading slash', async () => {
    const net = fakeFetch(() => Response.json({}));
    const ctx = await configured({ fetch: net.impl });
    await twilioRequest(ctx, 'GET', 'Messages.json');
    await twilioRequest(ctx, 'GET', '/Calls/CA0123456789abcdef0123456789abcdef.json');
    expect(net.calls.map((c) => c.url)).toEqual([
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls/CA0123456789abcdef0123456789abcdef.json`,
    ]);
  });

  it('fails clearly when nothing is configured', async () => {
    const ctx = makeTestCtx();
    await expect(twilioRequest(ctx, 'GET', '/Calls.json')).rejects.toThrow(/not configured/);
  });
});

describe('account and features', () => {
  it('is not configured without credentials', async () => {
    const ctx = makeTestCtx();
    expect(await twilioConfigured(ctx)).toBe(false);
    expect(await getTwilioAccount(ctx)).toBeNull();
    expect(await twilioFeatures(ctx)).toEqual({ sms: false, calls: false });
  });

  it('is configured with a sender number, and can call', async () => {
    const ctx = await configured();
    expect(await twilioConfigured(ctx)).toBe(true);
    expect(await twilioFeatures(ctx)).toEqual({ sms: true, calls: true });
    expect((await getTwilioAccount(ctx))?.provider).toBe('twilio');
  });

  it('can text but not call with only a messaging service', async () => {
    const ctx = await configured({}, { fromNumber: '', messagingServiceSid: 'MG0123456789abcdef0123456789abcdef' });
    expect(await twilioConfigured(ctx)).toBe(true);
    expect(await twilioFeatures(ctx)).toEqual({ sms: true, calls: false });
  });

  it('is not configured with credentials but no sender at all', async () => {
    const ctx = await configured({}, { fromNumber: '' });
    expect(await twilioConfigured(ctx)).toBe(false);
  });

  it('lets environment credentials win over stored ones', async () => {
    const ctx = await configured({ env: { overrides: { twilioAuthToken: 'from-env' } } });
    expect((await getTwilioAccount(ctx))?.authToken).toBe('from-env');
  });

  it('is not set up in mock mode either until credentials exist, so a fresh dev server looks like a fresh deployment', async () => {
    const fresh = makeTestCtx({ env: { mockProviders: true } });
    expect(await getTwilioAccount(fresh)).toBeNull();
    expect(await twilioFeatures(fresh)).toEqual({ sms: false, calls: false });

    // With credentials (the dev server's DEV_MOCK_CREDS, or values saved in the dashboard) the provider reads "mock".
    const ctx = makeTestCtx({ env: { mockProviders: true, overrides: { twilioAccountSid: SID, twilioAuthToken: TOKEN, twilioFromNumber: '+15005550006' } } });
    const account = await getTwilioAccount(ctx);
    expect(account?.provider).toBe('mock');
    expect(await twilioFeatures(ctx)).toEqual({ sms: true, calls: true });
  });
});

describe('normalizePhone', () => {
  it('returns E.164 for international input in any common spelling', () => {
    expect(normalizePhone('+1 (415) 555-2671')).toBe('+14155552671');
    expect(normalizePhone('+254 712 345 678')).toBe('+254712345678');
    expect(normalizePhone('+44 7911 123456')).toBe('+447911123456');
    expect(normalizePhone('0044 7911 123456')).toBe('+447911123456');
    expect(normalizePhone('＋１４１５５５５２６７１')).toBe('+14155552671');
  });

  it('uses the default country for national numbers', () => {
    expect(normalizePhone('(415) 555-2671', 'US')).toBe('+14155552671');
    expect(normalizePhone('0712 345 678', 'KE')).toBe('+254712345678');
    expect(normalizePhone('0712 345 678', 'ke')).toBe('+254712345678');
  });

  it('returns null for anything that is not a valid number', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('hello')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('(415) 555-2671')).toBeNull(); // national, no country given
    expect(normalizePhone('+1 415 555')).toBeNull();
    expect(normalizePhone('+1415555267199999')).toBeNull();
    expect(normalizePhone('0712 345 678', 'XX')).toBeNull();
    expect(normalizePhone('+1 415 555 2671'.repeat(5))).toBeNull();
    expect(normalizePhone(undefined as unknown as string)).toBeNull();
    expect(normalizePhone(14155552671 as unknown as string)).toBeNull();
  });
});

describe('isRestrictedNumber', () => {
  it('flags premium rate numbers and lets ordinary ones through', () => {
    expect(isRestrictedNumber('+19005551234')).toBe(true);
    expect(isRestrictedNumber('+14155552671')).toBe(false);
    expect(isRestrictedNumber('+254712345678')).toBe(false);
    expect(isRestrictedNumber('+18005551212')).toBe(false);
    expect(isRestrictedNumber('nonsense')).toBe(false);
  });
});

describe('the do-not-contact list', () => {
  it('blocks a number per channel until it is lifted', async () => {
    const ctx = makeTestCtx();
    expect(await isNumberBlocked(ctx, '+14155552671', 'call')).toBe(false);
    await blockNumber(ctx, '+14155552671', ['call']);
    expect(await isNumberBlocked(ctx, '+14155552671', 'call')).toBe(true);
    expect(await isNumberBlocked(ctx, '+14155552671', 'sms')).toBe(false);
    expect(await isNumberBlocked(ctx, '+14155552672', 'call')).toBe(false);
    await blockNumber(ctx, '+14155552671', ['sms', 'call']);
    expect(await isNumberBlocked(ctx, '+14155552671', 'sms')).toBe(true);
    await unblockNumber(ctx, '+14155552671', ['sms', 'call']);
    expect(await isNumberBlocked(ctx, '+14155552671', 'sms')).toBe(false);
    expect(await isNumberBlocked(ctx, '+14155552671', 'call')).toBe(false);
  });

  it('lasts 180 days and never stores the number itself', async () => {
    const ctx = makeTestCtx();
    await blockNumber(ctx, '+14155552671', ['call']);
    const keys = await ctx.kv.list('');
    expect(keys.join(' ')).not.toContain('4155552671');
    for (const key of keys) expect(JSON.stringify(await ctx.kv.getJSON(key))).not.toContain('4155552671');
    ctx.clock.advance(179 * 86_400_000);
    expect(await isNumberBlocked(ctx, '+14155552671', 'call')).toBe(true);
    ctx.clock.advance(2 * 86_400_000);
    expect(await isNumberBlocked(ctx, '+14155552671', 'call')).toBe(false);
  });
});

describe('TwiML helpers', () => {
  it('escapes the five XML characters and removes characters XML cannot carry', () => {
    expect(xmlEscape(`Tom & "Jerry" <b>'s</b>`)).toBe('Tom &amp; &quot;Jerry&quot; &lt;b&gt;&apos;s&lt;/b&gt;');
    expect(xmlEscape('a\u0000b\u0008c\u000Bd')).toBe('abcd');
    expect(xmlEscape('line\nbreak\ttab')).toBe('line\nbreak\ttab');
    expect(xmlEscape('lone \uD800 surrogate')).toBe('lone  surrogate');
    expect(xmlEscape('emoji 🌱 stays')).toBe('emoji 🌱 stays');
    expect(xmlEscape(null)).toBe('');
  });

  it('wraps verbs in a Response document served as XML and never cached', async () => {
    const res = twimlResponse('<Hangup/>');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });
});

describe('withDeadline', () => {
  it('passes results and errors through, and rejects with DeadlineError when time runs out', async () => {
    await expect(withDeadline(Promise.resolve(7), 50)).resolves.toBe(7);
    await expect(withDeadline(Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom');
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      const pending = withDeadline(new Promise(() => undefined), 1000, expired).catch((e) => e);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await pending).toBeInstanceOf(DeadlineError);
      expect(expired).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
