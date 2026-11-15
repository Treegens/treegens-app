import { describe, expect, it } from 'vitest';
import { allRoutes, handle } from '../../server/api';
import { appendOutbox, clearOutbox, readDevClock, readOutbox } from '../../server/routes/dev';
import { apiRequest, makeTestCtx } from '../helpers/ctx';

describe('handle()', () => {
  it('answers 503 with a clear code when the master secret is missing', async () => {
    const ctx = makeTestCtx({ env: { secretKey: '' } });
    const res = await handle(apiRequest('GET', '/public/site'), ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).error.code).toBe('not_configured');
    expect(ctx.logs.some((l) => l.level === 'error' && l.msg.includes('MEETING_SECRET_KEY'))).toBe(true);
  });

  it('answers JSON 404 for paths no route claims', async () => {
    const res = await handle(apiRequest('GET', '/definitely/not/a/route'), makeTestCtx());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('registers the dev routes only next to mocked providers', async () => {
    const prod = makeTestCtx();
    const dev = makeTestCtx({ env: { mockProviders: true } });
    const devPatterns = allRoutes(dev).map((r) => r.pattern).filter((p) => p.startsWith('/dev/'));
    expect(devPatterns.sort()).toEqual([
      '/dev/bookings',
      '/dev/calls',
      '/dev/clock',
      '/dev/clock',
      '/dev/fail',
      '/dev/fail',
      '/dev/fail',
      '/dev/google/account',
      '/dev/google/accounts',
      '/dev/google/busy',
      '/dev/google/busy',
      '/dev/google/busy',
      '/dev/google/events',
      '/dev/ics',
      '/dev/ics',
      '/dev/jobs',
      '/dev/kv',
      '/dev/llm-script',
      '/dev/llm-script',
      '/dev/outbox',
      '/dev/outbox',
      '/dev/reset',
      '/dev/run-jobs',
    ]);
    expect(allRoutes(prod).some((r) => r.pattern.startsWith('/dev/'))).toBe(false);

    for (const [method, path] of [['GET', '/dev/outbox'], ['POST', '/dev/reset'], ['POST', '/dev/clock'], ['POST', '/dev/run-jobs'], ['GET', '/dev/clock']]) {
      const res = await handle(apiRequest(method, path), prod);
      expect(res.status).toBe(404);
    }
    // Nothing was wiped by the refused reset.
    await prod.kv.setJSON('site', { keep: true });
    await handle(apiRequest('POST', '/dev/reset'), prod);
    expect(await prod.kv.getJSON('site')).toEqual({ keep: true });
  });
});

describe('dev routes', () => {
  it('outbox: lists what the mocks recorded, in order, and can be cleared', async () => {
    const ctx = makeTestCtx({ env: { mockProviders: true } });
    expect(await (await handle(apiRequest('GET', '/dev/outbox'), ctx)).json()).toEqual({ outbox: [] });

    await appendOutbox(ctx.kv, { kind: 'email', to: 'ada@example.com' });
    await appendOutbox(ctx.kv, { kind: 'sms', to: '+15550001111' });
    await ctx.kv.setJSON('dev/outbox/0001', { kind: 'call', to: '+15550001111' });

    const listed = await (await handle(apiRequest('GET', '/dev/outbox'), ctx)).json();
    expect(listed.outbox.map((e: { kind: string }) => e.kind)).toEqual(['email', 'sms', 'call']);

    expect((await handle(apiRequest('DELETE', '/dev/outbox'), ctx)).status).toBe(200);
    expect(await readOutbox(ctx.kv)).toEqual([]);
  });

  it('outbox appends never lose an entry under concurrency', async () => {
    const ctx = makeTestCtx();
    await Promise.all(Array.from({ length: 25 }, (_, i) => appendOutbox(ctx.kv, { i })));
    const entries = (await readOutbox(ctx.kv)) as { i: number }[];
    expect(entries.map((e) => e.i).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    await clearOutbox(ctx.kv);
    expect(await readOutbox(ctx.kv)).toEqual([]);
  });

  it('clock: freeze, advance, read and release', async () => {
    const ctx = makeTestCtx({ env: { mockProviders: true }, now: '2026-11-16T09:00:00.000Z' });
    expect(await (await handle(apiRequest('GET', '/dev/clock'), ctx)).json()).toEqual({ now: null });

    const set = await handle(apiRequest('POST', '/dev/clock', { body: { now: '2026-12-24T18:30:00+03:00' } }), ctx);
    expect(await set.json()).toEqual({ now: '2026-12-24T15:30:00.000Z' });
    expect((await readDevClock(ctx.kv))?.toISOString()).toBe('2026-12-24T15:30:00.000Z');

    // advanceMs is relative to the request's own "now" (the dev server feeds the frozen time in).
    const advanced = await handle(apiRequest('POST', '/dev/clock', { body: { advanceMs: 90 * 60_000 } }), ctx);
    expect(await advanced.json()).toEqual({ now: '2026-11-16T10:30:00.000Z' });

    const bad = await handle(apiRequest('POST', '/dev/clock', { body: { now: 'tomorrow-ish' } }), ctx);
    expect(bad.status).toBe(422);
    expect((await readDevClock(ctx.kv))?.toISOString()).toBe('2026-11-16T10:30:00.000Z');

    const released = await handle(apiRequest('POST', '/dev/clock', { body: { now: null } }), ctx);
    expect(await released.json()).toEqual({ now: null });
    expect(await readDevClock(ctx.kv)).toBeNull();
  });

  it('reset wipes every key, binary ones included', async () => {
    const ctx = makeTestCtx({ env: { mockProviders: true } });
    await ctx.kv.setJSON('site', { a: 1 });
    await ctx.kv.setJSON('bookings/bkg_1', { id: 'bkg_1' });
    await ctx.kv.setJSON('dev/clock', { now: '2026-12-24T15:30:00.000Z' });
    await ctx.kv.setBlob('assets/ast_1', new Uint8Array([1, 2, 3]), { contentType: 'image/png' });

    const res = await handle(apiRequest('POST', '/dev/reset'), ctx);
    expect(await res.json()).toEqual({ ok: true, deleted: 4 });
    expect(await ctx.kv.list('')).toEqual([]);
  });
});
