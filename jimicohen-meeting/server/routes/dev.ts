/**
 * Dev-only routes and the small pieces of dev state they share with the dev server and the
 * provider mocks. server/api.ts registers these routes only when ctx.env.mockProviders is true,
 * and every handler checks again, so they can never answer in production.
 *
 *   GET    /dev/outbox     everything the mocks "sent"            → { outbox: [...] }
 *   DELETE /dev/outbox     forget it
 *   POST   /dev/reset      wipe ALL stored data (fresh first run) → { ok, deleted }
 *   GET    /dev/clock      the fake clock                         → { now: ISO | null }
 *   POST   /dev/clock      { now: ISO } freezes time, { now: null } returns to real time,
 *                          { advanceMs: n } moves on from the current (fake or real) time
 *   POST   /dev/run-jobs   what the cron function does            → result of runScheduled
 */
import { runScheduled } from '../cron';
import type { Ctx, KV } from '../lib/ctx';
import { HttpError, json, readJson, route, type Route } from '../lib/http';

export const DEV_CLOCK_KEY = 'dev/clock';
export const DEV_OUTBOX_KEY = 'dev/outbox';

/** The frozen dev time, or null when the real clock is in use. */
export async function readDevClock(kv: KV): Promise<Date | null> {
  const record = await kv.getJSON<{ now?: unknown }>(DEV_CLOCK_KEY);
  if (!record || typeof record.now !== 'string') return null;
  const ms = Date.parse(record.now);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Appends one record to the outbox (compare-and-swap, so parallel mock calls never lose an entry). */
export async function appendOutbox(kv: KV, entry: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; attempt < 64; attempt++) {
    const found = await kv.getJSONWithEtag<unknown[]>(DEV_OUTBOX_KEY);
    const next = [...(Array.isArray(found?.value) ? found.value : []), entry];
    const written = await kv.setJSON(DEV_OUTBOX_KEY, next, found ? { onlyIfMatch: found.etag } : { onlyIfNew: true });
    if (written.modified) return;
    await Promise.resolve();
  }
  throw new Error('dev outbox: too much contention');
}

/** The outbox array, followed by any entries stored one per key under `dev/outbox/` (in key order). */
export async function readOutbox(kv: KV): Promise<unknown[]> {
  const list = await kv.getJSON<unknown[]>(DEV_OUTBOX_KEY);
  const out: unknown[] = Array.isArray(list) ? [...list] : [];
  for (const key of await kv.list(`${DEV_OUTBOX_KEY}/`)) {
    const entry = await kv.getJSON<unknown>(key);
    if (entry !== null) out.push(entry);
  }
  return out;
}

export async function clearOutbox(kv: KV): Promise<void> {
  await kv.delete(DEV_OUTBOX_KEY);
  for (const key of await kv.list(`${DEV_OUTBOX_KEY}/`)) await kv.delete(key);
}

function assertDev(ctx: Ctx): void {
  if (!ctx.env.mockProviders) throw new HttpError(404, 'not_found', 'Not found.');
}

async function readOptionalJson(req: Request): Promise<Record<string, unknown>> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('json')) return {};
  return readJson<Record<string, unknown>>(req);
}

export const routes: Route[] = [
  route('GET', '/dev/outbox', async ({ ctx }) => {
    assertDev(ctx);
    return json({ outbox: await readOutbox(ctx.kv) });
  }),

  route('DELETE', '/dev/outbox', async ({ ctx }) => {
    assertDev(ctx);
    await clearOutbox(ctx.kv);
    return json({ ok: true });
  }),

  route('POST', '/dev/reset', async ({ ctx }) => {
    assertDev(ctx);
    const keys = await ctx.kv.list('');
    for (const key of keys) await ctx.kv.delete(key);
    return json({ ok: true, deleted: keys.length });
  }),

  route('GET', '/dev/clock', async ({ ctx }) => {
    assertDev(ctx);
    return json({ now: (await readDevClock(ctx.kv))?.toISOString() ?? null });
  }),

  route('POST', '/dev/clock', async ({ ctx, req }) => {
    assertDev(ctx);
    const body = await readOptionalJson(req);
    if (typeof body.advanceMs === 'number' && Number.isFinite(body.advanceMs)) {
      // ctx.now() is already the fake time when one is set.
      const next = new Date(ctx.now().getTime() + body.advanceMs).toISOString();
      await ctx.kv.setJSON(DEV_CLOCK_KEY, { now: next });
      return json({ now: next });
    }
    if (body.now === null || body.now === undefined || body.now === '') {
      await ctx.kv.delete(DEV_CLOCK_KEY);
      return json({ now: null });
    }
    const ms = typeof body.now === 'string' ? Date.parse(body.now) : NaN;
    if (!Number.isFinite(ms)) throw new HttpError(422, 'invalid', 'Send { now: ISO date } or { now: null }.', { now: 'Not a valid date.' });
    const next = new Date(ms).toISOString();
    await ctx.kv.setJSON(DEV_CLOCK_KEY, { now: next });
    return json({ now: next });
  }),

  route('POST', '/dev/run-jobs', async ({ ctx }) => {
    assertDev(ctx);
    return json(await runScheduled(ctx));
  }),
];
