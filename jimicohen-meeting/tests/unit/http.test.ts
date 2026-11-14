import { describe, expect, it } from 'vitest';
import { dispatch, HttpError, json, matchPattern, readForm, readJson, redirect, route, type Route } from '../../server/lib/http';
import { makeTestCtx } from '../helpers/ctx';

const BASE = 'https://jimicohen.com/meeting/api';

function jsonRequest(body: string, headers: Record<string, string> = { 'content-type': 'application/json' }): Request {
  return new Request(`${BASE}/x`, { method: 'POST', headers, body });
}

/** A body that arrives in chunks with no Content-Length, like a chunked upload. */
function streamedRequest(chunks: Uint8Array[], contentType = 'application/json'): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request(`${BASE}/x`, { method: 'POST', headers: { 'content-type': contentType }, body: stream, duplex: 'half' } as RequestInit);
}

async function errorOf(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error('expected the promise to reject');
}

describe('json()', () => {
  it('serialises with the right headers and status', async () => {
    const res = json({ ok: true, n: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.json()).toEqual({ ok: true, n: 1 });
    expect(json({ a: 1 }, 201).status).toBe(201);
  });

  it('is never cacheable, even when a caller asks for it', () => {
    const res = json({}, 200, { 'Cache-Control': 'public, max-age=3600', 'Set-Cookie': 'a=b; Path=/meeting' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBe('a=b; Path=/meeting');
  });

  it('refuses header values with line breaks', () => {
    expect(() => json({}, 200, { 'X-Thing': 'a\r\nSet-Cookie: evil=1' })).toThrow();
  });

  it('sends null for undefined so the body is always valid JSON', async () => {
    expect(await json(undefined).text()).toBe('null');
  });
});

describe('redirect()', () => {
  it('sends a 302 to the location by default', () => {
    const res = redirect('/meeting/admin?google=connected');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/meeting/admin?google=connected');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(redirect('https://accounts.google.com/o/oauth2/v2/auth?x=1', 303, { 'Set-Cookie': 'a=b' }).status).toBe(303);
  });

  it('refuses a location that would split the response, and non-redirect statuses', () => {
    expect(() => redirect('/meeting/\r\nSet-Cookie: evil=1')).toThrow();
    expect(() => redirect('/meeting/', 200)).toThrow();
  });
});

describe('readJson()', () => {
  it('parses a JSON object', async () => {
    expect(await readJson<{ name: string }>(jsonRequest('{"name":"Ada","n":[1,2]}'))).toEqual({ name: 'Ada', n: [1, 2] });
    expect(await readJson(jsonRequest('{"a":1}', { 'content-type': 'application/json; charset=utf-8' }))).toEqual({ a: 1 });
    expect(await readJson(jsonRequest('{"a":1}', { 'content-type': 'application/merge-patch+json' }))).toEqual({ a: 1 });
  });

  it('answers 415 for anything that is not JSON', async () => {
    const variants: Record<string, string>[] = [
      {},
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-type': 'text/json-ish' },
    ];
    for (const headers of variants) {
      const err = await errorOf(readJson(new Request(`${BASE}/x`, { method: 'POST', headers, body: new TextEncoder().encode('{"a":1}') })));
      expect(err.status).toBe(415);
    }
  });

  it('answers 413 when Content-Length is over the limit', async () => {
    const err = await errorOf(readJson(jsonRequest(JSON.stringify({ text: 'x'.repeat(200) })), 100));
    expect(err).toMatchObject({ status: 413, code: 'too_large' });
  });

  it('answers 413 when a streamed body grows past the limit, whatever the headers say', async () => {
    const chunk = new TextEncoder().encode('"' + 'x'.repeat(62) + '",');
    const chunks = [new TextEncoder().encode('{"list":['), ...Array.from({ length: 50 }, () => chunk), new TextEncoder().encode('""]}')];
    const err = await errorOf(readJson(streamedRequest(chunks), 1000));
    expect(err).toMatchObject({ status: 413, code: 'too_large' });
    // The same body is fine with room to spare.
    expect(await readJson<{ list: string[] }>(streamedRequest(chunks), 100_000)).toHaveProperty('list');
  });

  it('accepts a body exactly at the limit', async () => {
    const body = JSON.stringify({ t: 'x'.repeat(50) });
    expect(await readJson(jsonRequest(body), body.length)).toEqual({ t: 'x'.repeat(50) });
    expect((await errorOf(readJson(jsonRequest(body), body.length - 1))).status).toBe(413);
  });

  it('answers 400 for empty, malformed or non-object JSON', async () => {
    for (const body of ['', '   ', '{', '{"a":}', 'undefined', '[1,2]', '"text"', '42', 'null', 'true']) {
      const err = await errorOf(readJson(jsonRequest(body)));
      expect(err.status).toBe(400);
      expect(err.code).toBe('invalid_json');
    }
  });

  it('answers 400 for bytes that are not UTF-8', async () => {
    const req = new Request(`${BASE}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) });
    expect((await errorOf(readJson(req))).status).toBe(400);
  });

  it('drops __proto__ keys at every depth', async () => {
    const parsed = await readJson<Record<string, unknown>>(jsonRequest('{"a":1,"__proto__":{"admin":true},"nested":{"__proto__":{"x":1},"b":2}}'));
    expect(Object.keys(parsed)).toEqual(['a', 'nested']);
    expect(Object.keys(parsed.nested as object)).toEqual(['b']);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect((Object.assign({}, parsed) as Record<string, unknown>).admin).toBeUndefined();
  });
});

describe('readForm()', () => {
  it('parses a URL encoded form', async () => {
    const req = new Request(`${BASE}/twilio/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: 'From=%2B15550001111&Body=YES+please&Empty=',
    });
    const form = await readForm(req);
    expect(form.get('From')).toBe('+15550001111');
    expect(form.get('Body')).toBe('YES please');
    expect(form.get('Empty')).toBe('');
    expect(form.get('Missing')).toBeNull();
  });

  it('answers 415 for other content types and 413 for oversized forms', async () => {
    const wrong = new Request(`${BASE}/twilio/sms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect((await errorOf(readForm(wrong))).status).toBe(415);
    const big = new Request(`${BASE}/twilio/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `Body=${'x'.repeat(5000)}`,
    });
    expect((await errorOf(readForm(big, 1000))).status).toBe(413);
  });
});

describe('route() and matchPattern()', () => {
  it('normalises the method and requires a leading slash', () => {
    const r = route('get', '/public/site', async () => json({}));
    expect(r.method).toBe('GET');
    expect(() => route('GET', 'public/site', async () => json({}))).toThrow();
  });

  it('matches literal and parameter segments', () => {
    expect(matchPattern('/public/event/:slug', ['public', 'event', 'intro'])).toEqual({ params: { slug: 'intro' }, literal: 2 });
    expect(matchPattern('/public/event/:slug', ['public', 'event'])).toBeNull();
    expect(matchPattern('/public/event/:slug', ['public', 'events', 'intro'])).toBeNull();
    expect(matchPattern('/public/event/:slug', ['public', 'event', ''])).toBeNull();
    expect(matchPattern('/a/:x/b/:y', ['a', '1', 'b', '2'])).toEqual({ params: { x: '1', y: '2' }, literal: 2 });
    expect(matchPattern('/', [])).toEqual({ params: {}, literal: 0 });
  });
});

describe('dispatch()', () => {
  const calls: string[] = [];
  const routes: Route[] = [
    route('GET', '/public/site', async () => json({ route: 'site' })),
    route('GET', '/public/event/:slug', async ({ params }) => json({ route: 'event', slug: params.slug })),
    route('GET', '/public/bookings/:id', async ({ params, url }) => json({ route: 'booking', id: params.id, t: url.searchParams.get('t') })),
    route('POST', '/public/bookings/:id/cancel', async ({ params, req }) => json({ route: 'cancel', id: params.id, body: await readJson(req) })),
    route('GET', '/things/:id', async ({ params }) => json({ route: 'param', id: params.id })),
    route('GET', '/things/special', async () => json({ route: 'literal' })),
    route('GET', '/admin/bookings.csv', async () => new Response('a,b\n1,2\n', { headers: { 'Content-Type': 'text/csv; charset=utf-8' } })),
    route('GET', '/assets/:id', async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } })),
    route('POST', '/fail/http', async () => {
      throw new HttpError(422, 'invalid', 'Please check the highlighted fields.', { email: 'Enter a valid email address.' });
    }),
    route('GET', '/fail/limited', async () => {
      throw new HttpError(429, 'rate_limited', 'Too many requests.', undefined, { 'Retry-After': '30' });
    }),
    route('GET', '/fail/unavailable', async () => {
      throw new HttpError(503, 'calendar_unavailable', 'We could not check the calendar. Please try again.');
    }),
    route('GET', '/fail/crash', async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'secretToken')");
    }),
    route('GET', '/fail/nothing', async () => undefined as unknown as Response),
    route('GET', '/called', async ({ ctx }) => {
      calls.push(ctx.requestId);
      return json({ ok: true });
    }),
  ];

  const get = (path: string, init?: RequestInit) => new Request(`${BASE}${path}`, init);

  it('runs the matching handler with decoded params', async () => {
    const ctx = makeTestCtx();
    expect(await (await dispatch(routes, ctx, get('/public/site'))).json()).toEqual({ route: 'site' });
    expect(await (await dispatch(routes, ctx, get('/public/event/intro'))).json()).toEqual({ route: 'event', slug: 'intro' });
    expect(await (await dispatch(routes, ctx, get('/public/event/caf%C3%A9%20chat'))).json()).toEqual({ route: 'event', slug: 'café chat' });
    expect(await (await dispatch(routes, ctx, get('/public/bookings/bkg_1?t=tok'))).json()).toEqual({ route: 'booking', id: 'bkg_1', t: 'tok' });
  });

  it('treats an encoded slash as part of the parameter, not as a path separator', async () => {
    const res = await dispatch(routes, makeTestCtx(), get('/public/event/a%2Fb'));
    expect(await res.json()).toEqual({ route: 'event', slug: 'a/b' });
  });

  it('ignores one trailing slash', async () => {
    expect((await dispatch(routes, makeTestCtx(), get('/public/site/'))).status).toBe(200);
  });

  it('passes the body through to POST handlers', async () => {
    const req = get('/public/bookings/bkg_9/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"t":"x","reason":"busy"}' });
    const res = await dispatch(routes, makeTestCtx(), req);
    expect(await res.json()).toEqual({ route: 'cancel', id: 'bkg_9', body: { t: 'x', reason: 'busy' } });
  });

  it('prefers the more specific pattern whatever the registration order', async () => {
    const ctx = makeTestCtx();
    expect(await (await dispatch(routes, ctx, get('/things/special'))).json()).toEqual({ route: 'literal' });
    expect(await (await dispatch(routes, ctx, get('/things/other'))).json()).toEqual({ route: 'param', id: 'other' });
    expect(await (await dispatch([...routes].reverse(), ctx, get('/things/special'))).json()).toEqual({ route: 'literal' });
  });

  it('answers 404 JSON for unknown paths and for anything outside the API prefix', async () => {
    const ctx = makeTestCtx();
    for (const url of [`${BASE}/nope`, `${BASE}/public`, `${BASE}/public/site/extra`, `${BASE}//public/site`, `${BASE}`, 'https://jimicohen.com/meeting/apix/public/site', 'https://jimicohen.com/public/site', 'https://jimicohen.com/.netlify/functions/api']) {
      const res = await dispatch(routes, ctx, new Request(url));
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
  });

  it('answers 405 with an Allow header when the path exists for another method', async () => {
    const ctx = makeTestCtx();
    const res = await dispatch(routes, ctx, get('/public/site', { method: 'DELETE' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect((await res.json()).error.code).toBe('method_not_allowed');

    const res2 = await dispatch(routes, ctx, get('/public/bookings/bkg_1/cancel'));
    expect(res2.status).toBe(405);
    expect(res2.headers.get('allow')).toBe('POST');
  });

  it('answers HEAD from the GET route, without a body', async () => {
    const res = await dispatch(routes, makeTestCtx(), get('/public/site', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).toBe('');
    expect((await dispatch(routes, makeTestCtx(), get('/public/bookings/b/cancel', { method: 'HEAD' }))).status).toBe(405);
  });

  it('maps HttpError to its status, code, message, fields and headers', async () => {
    const ctx = makeTestCtx();
    const res = await dispatch(routes, ctx, get('/fail/http', { method: 'POST' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: 'invalid', message: 'Please check the highlighted fields.', fields: { email: 'Enter a valid email address.' } },
    });

    const limited = await dispatch(routes, ctx, get('/fail/limited'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect(await limited.json()).toEqual({ error: { code: 'rate_limited', message: 'Too many requests.' } });
    expect(ctx.logs.some((l) => l.level === 'error')).toBe(false);
  });

  it('passes a deliberate 5xx HttpError through with its own message', async () => {
    const ctx = makeTestCtx();
    const res = await dispatch(routes, ctx, get('/fail/unavailable'));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toEqual({ code: 'calendar_unavailable', message: 'We could not check the calendar. Please try again.' });
    expect(ctx.logs.some((l) => l.level === 'error')).toBe(true);
  });

  it('turns an unexpected error into a 500 with the request id and no internals', async () => {
    const ctx = makeTestCtx({ requestId: 'req_abc123' });
    const res = await dispatch(routes, ctx, get('/fail/crash'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: { code: 'internal', message: expect.any(String), requestId: 'req_abc123' } });
    expect(JSON.stringify(body)).not.toContain('secretToken');
    expect(JSON.stringify(body)).not.toContain('TypeError');
    expect(res.headers.get('x-request-id')).toBe('req_abc123');

    const logged = ctx.logs.find((l) => l.level === 'error');
    expect(logged?.msg).toBe('request failed');
    expect(logged?.data).toMatchObject({ method: 'GET', path: '/meeting/api/fail/crash', status: 500, error: { name: 'TypeError' } });
    expect((logged?.data as { error: { stack: string } }).error.stack).toContain('secretToken');
  });

  it('treats a handler that returns nothing as a server error', async () => {
    const res = await dispatch(routes, makeTestCtx(), get('/fail/nothing'));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('internal');
  });

  it('answers 400 for a parameter that is not valid percent-encoding', async () => {
    const res = await dispatch(routes, makeTestCtx(), get('/public/event/%E0%A4%A'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  it('adds safe default headers but keeps what the handler chose', async () => {
    const ctx = makeTestCtx({ requestId: 'req_headers' });
    const csv = await dispatch(routes, ctx, get('/admin/bookings.csv'));
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('cache-control')).toBe('no-store');
    expect(csv.headers.get('x-content-type-options')).toBe('nosniff');
    expect(csv.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(csv.headers.get('x-request-id')).toBe('req_headers');
    expect(await csv.text()).toBe('a,b\n1,2\n');

    const asset = await dispatch(routes, ctx, get('/assets/ast_1'));
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect([...new Uint8Array(await asset.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('logs method, path and status, but never the query string', async () => {
    const ctx = makeTestCtx();
    await dispatch(routes, ctx, get('/public/bookings/bkg_1?t=super-secret-manage-token'));
    expect(ctx.logs).toHaveLength(1);
    expect(ctx.logs[0]).toMatchObject({ level: 'info', msg: 'request', data: { method: 'GET', path: '/meeting/api/public/bookings/bkg_1', status: 200 } });
    expect(JSON.stringify(ctx.logs)).not.toContain('super-secret-manage-token');
  });

  it('gives every handler the request context it was called with', async () => {
    calls.length = 0;
    await dispatch(routes, makeTestCtx({ requestId: 'req_one' }), get('/called'));
    await dispatch(routes, makeTestCtx({ requestId: 'req_two' }), get('/called'));
    expect(calls).toEqual(['req_one', 'req_two']);
  });

  it('copes with a response whose headers cannot be changed', async () => {
    const frozen = Response.redirect('https://jimicohen.com/meeting/admin', 302);
    const res = await dispatch([route('GET', '/go', async () => frozen)], makeTestCtx({ requestId: 'req_frozen' }), get('/go'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://jimicohen.com/meeting/admin');
    expect(res.headers.get('x-request-id')).toBe('req_frozen');
  });

  it('with no routes at all, every API path is a JSON 404', async () => {
    const res = await dispatch([], makeTestCtx(), get('/auth/state'));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });
});
