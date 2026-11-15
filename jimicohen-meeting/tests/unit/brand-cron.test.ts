/**
 * The one-time short link setup inside the scheduled run (server/cron.ts, server/lib/seed.ts): only the
 * deploy's scheduled function asks for it, it runs once, and it never stops the reminders.
 */
import { describe, expect, it } from 'vitest';
import { runScheduled } from '../../server/cron';
import type { KV } from '../../server/lib/ctx';
import { enqueueJob } from '../../server/lib/jobs';
import * as repo from '../../server/lib/repo';
import { MOVE_MARKER } from '../../server/lib/seed';
import { makeTestCtx, markSetUp, type TestCtx } from '../helpers/ctx';

const NOW = '2026-11-16T09:00:00.000Z';

/** Records every key read and written on the context's store. */
function watch(ctx: TestCtx): { reads: string[]; writes: string[] } {
  const seen = { reads: [] as string[], writes: [] as string[] };
  const kv = ctx.kv;
  const getJSON = kv.getJSON.bind(kv);
  const getJSONWithEtag = kv.getJSONWithEtag.bind(kv);
  const setJSON = kv.setJSON.bind(kv);
  kv.getJSON = ((key: string) => {
    seen.reads.push(key);
    return getJSON(key);
  }) as KV['getJSON'];
  kv.getJSONWithEtag = ((key: string) => {
    seen.reads.push(key);
    return getJSONWithEtag(key);
  }) as KV['getJSONWithEtag'];
  kv.setJSON = ((key: string, value: unknown, opts?: Parameters<KV['setJSON']>[2]) => {
    seen.writes.push(key);
    return setJSON(key, value, opts);
  }) as KV['setJSON'];
  return seen;
}

async function setup(): Promise<TestCtx> {
  const ctx = makeTestCtx({ now: NOW });
  await repo.getSite(ctx);
  await markSetUp(ctx);
  return ctx;
}

/** A job for a booking that does not exist: the runner drops it, which shows the due jobs ran. */
async function dueJob(ctx: TestCtx): Promise<void> {
  await enqueueJob(ctx, { type: 'message', bookingId: 'bkg_gone', dueAt: NOW, channel: 'email', audience: 'invitee', kind: 'reminder' });
}

describe('the scheduled run and the one-time setup', () => {
  it('without the option it never reads the marker and never touches the event types or the site settings', async () => {
    const ctx = await setup();
    const seen = watch(ctx);
    await runScheduled(ctx, { stepWaitMs: 50 });
    expect(seen.reads).not.toContain(MOVE_MARKER);
    expect(seen.writes).not.toContain('event-types');
    expect(seen.writes).not.toContain('site');
    expect((await repo.getSite(ctx)).shortLinks).toBeUndefined();
  });

  it('with it the setup runs once; the next run only reads the marker, and the same store not even that', async () => {
    const ctx = await setup();
    const first = await runScheduled(ctx, { oneTimeMoves: true, stepWaitMs: 50 });
    expect(first.shortLinks).toMatchObject({ meet: { eventTypeId: 'evt_meeting' }, pod: { eventTypeId: 'evt_eco_champions' } });
    expect((await repo.getSite(ctx)).shortLinks).toEqual({ meet: 'evt_meeting', pod: 'evt_eco_champions' });

    // A new scheduled run opens its own store object (on the same data): it reads the marker and stops there.
    const next = makeTestCtx({ now: NOW, kv: { ...ctx.kv } });
    const seenNext = watch(next);
    expect((await runScheduled(next, { oneTimeMoves: true, stepWaitMs: 50 })).shortLinks).toBe('already_done');
    expect(seenNext.reads.filter((k) => k === MOVE_MARKER)).toHaveLength(1);
    expect(seenNext.writes).not.toContain('event-types');
    expect(seenNext.writes).not.toContain('site');

    // The same store again: it remembers, so not even the marker is read.
    const seenAgain = watch(next);
    expect((await runScheduled(next, { oneTimeMoves: true, stepWaitMs: 50 })).shortLinks).toBe('already_done');
    expect(seenAgain.reads).not.toContain(MOVE_MARKER);
  });

  it('a failing setup is reported, and the due jobs still run', async () => {
    const ctx = await setup();
    await dueJob(ctx);
    const getJSON = ctx.kv.getJSON.bind(ctx.kv);
    ctx.kv.getJSON = (async (key: string) => {
      if (key === MOVE_MARKER) throw new Error('marker unreadable');
      return getJSON(key);
    }) as KV['getJSON'];
    const summary = await runScheduled(ctx, { oneTimeMoves: true, stepWaitMs: 50 });
    expect(summary.shortLinks).toEqual({ error: 'marker unreadable' });
    expect(summary.jobs).toMatchObject({ processed: 1 });
    expect(await repo.listJobs(ctx)).toEqual([]);
    expect(ctx.logs.some((l) => l.level === 'error' && l.msg === 'cron: the short link setup failed')).toBe(true);
  });

  it('a setup that hangs is left behind after 5 seconds, and the due jobs run', async () => {
    const ctx = await setup();
    await dueJob(ctx);
    const getJSON = ctx.kv.getJSON.bind(ctx.kv);
    ctx.kv.getJSON = ((key: string) => (key === MOVE_MARKER ? new Promise(() => {}) : getJSON(key))) as KV['getJSON'];
    const started = Date.now();
    const summary = await runScheduled(ctx, { oneTimeMoves: true, stepWaitMs: 50 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
    expect(summary.shortLinks).toEqual({ timedOut: true });
    expect(summary.jobs).toMatchObject({ processed: 1 });
  }, 15_000);
});
