/**
 * What the scheduled function does every two minutes: send everything that is due, then, at most
 * every half hour, housekeeping. Each housekeeping step stands alone: one that fails is logged and
 * reported in the summary, and the others still run. The run as a whole never fails because of them.
 */
import type { CallRecord, Host } from '../shared/types';
import { alertCalendarTrouble, reconcileBookings, registerBookingJobHandlers } from './lib/booking';
import { getHostBusy, syncHostTimezone } from './lib/busy';
import type { Ctx } from './lib/ctx';
import { runDueJobs } from './lib/jobs';
import { KEYS, cacheGet, cacheSet, listHosts, pruneEphemeral } from './lib/repo';
import { DAY_MS } from './lib/time';

const HOUSEKEEPING_MARK = 'housekeeping-ran';
const HOUSEKEEPING_EVERY_SEC = 30 * 60;
const CALLS_MARK = 'housekeeping-calls-ran';
const CALLS_EVERY_SEC = 24 * 60 * 60;

/** A scheduled invocation has about 30 seconds. Jobs get less of it on the runs that also do housekeeping. */
const JOBS_BUDGET_MS = 20_000;
const JOBS_BUDGET_WITH_HOUSEKEEPING_MS = 8_000;
/** Steps that talk to calendars stop being waited for after this long; they finish in the background. */
const NETWORK_STEP_MS = 6_000;
const RECONCILE_STEP_MS = 5_000;

const EPHEMERAL_MAX_AGE_MS = 2 * DAY_MS;
const CALL_MAX_AGE_MS = 90 * DAY_MS;
const CALL_SCAN_LIMIT = 2000;
const READ_CONCURRENCY = 16;

function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error';
}

/** Runs one step. Its result goes into the summary; a failure becomes `{ error }` there and a log line. */
async function step<T>(ctx: Ctx, name: string, work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (err) {
    const error = shortError(err);
    ctx.log('error', `cron: ${name} failed`, { error });
    return { error };
  }
}

const TIMED_OUT = Symbol('timed out');

/** Like step(), but stops waiting after `ms`. The work is left to finish under waitUntil. */
async function networkStep<T>(ctx: Ctx, name: string, ms: number, work: () => Promise<T>): Promise<T | { error: string } | { timedOut: true }> {
  const running = step(ctx, name, work);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    const outcome = await Promise.race([running, timeout]);
    if (outcome !== TIMED_OUT) return outcome;
    ctx.log('warn', `cron: ${name} is taking long, leaving it to finish in the background`);
    ctx.waitUntil(running);
    return { timedOut: true };
  } finally {
    clearTimeout(timer);
  }
}

async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Hosts who follow their Google Calendar zone get the zone that calendar has now. */
async function syncTimezones(ctx: Ctx, hosts: Host[]): Promise<{ checked: number; changed: number }> {
  const following = hosts.filter((h) => h.timezoneMode === 'google' && h.google?.status === 'ok');
  let changed = 0;
  await Promise.all(
    following.map(async (host) => {
      // Never throws: a failed lookup leaves the host as it was.
      const after = await syncHostTimezone(ctx, host);
      if (after.timezone !== host.timezone) changed++;
    }),
  );
  return { checked: following.length, changed };
}

/**
 * Reads tomorrow's busy time of every host who has a calendar connected. The read itself updates
 * host.calendarHealth; a calendar that cannot be read is reported to the owner, once a day per host.
 */
async function probeCalendars(ctx: Ctx, hosts: Host[]): Promise<{ checked: number; broken: number; alerted: number }> {
  const connected = hosts.filter((h) => !!h.google || (Array.isArray(h.icsFeeds) && h.icsFeeds.length > 0));
  const nowMs = ctx.now().getTime();
  const failures: { host: Host; error: string }[] = [];
  await Promise.all(
    connected.map(async (host) => {
      const result = await getHostBusy(ctx, host, { start: nowMs, end: nowMs + DAY_MS }, { fresh: true });
      if (!result.ok) failures.push({ host, error: result.error ?? 'Calendar could not be read.' });
    }),
  );
  failures.sort((a, b) => a.host.id.localeCompare(b.host.id));
  const alerted = failures.length > 0 ? await alertCalendarTrouble(ctx, failures) : 0;
  return { checked: connected.length, broken: failures.length, alerted };
}

/** Call records (transcripts included) are kept for 90 days. Checked once a day. */
async function pruneOldCalls(ctx: Ctx): Promise<{ checked: number; removed: number } | 'not_due'> {
  if (await cacheGet(ctx, CALLS_MARK)) return 'not_due';
  await cacheSet(ctx, CALLS_MARK, { at: ctx.now().toISOString() }, CALLS_EVERY_SEC);

  const cutoff = ctx.now().getTime() - CALL_MAX_AGE_MS;
  const keys = (await ctx.kv.list(KEYS.callPrefix)).slice(0, CALL_SCAN_LIMIT);
  let removed = 0;
  await eachLimited(keys, READ_CONCURRENCY, async (key) => {
    const record = await ctx.kv.getJSON<Partial<CallRecord>>(key);
    if (!record) return;
    // The last change counts: a call that was touched recently is not old. A record without a readable date stays.
    const stamps = [Date.parse(record.updatedAt ?? ''), Date.parse(record.createdAt ?? '')].filter((ms) => Number.isFinite(ms));
    if (stamps.length === 0 || Math.max(...stamps) >= cutoff) return;
    await ctx.kv.delete(key);
    removed++;
  });
  return { checked: keys.length, removed };
}

async function housekeeping(ctx: Ctx, waitMs: { network: number; reconcile: number }): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const loaded = await step(ctx, 'loading the hosts', () => listHosts(ctx));
  const hosts = Array.isArray(loaded) ? loaded : [];
  if (!Array.isArray(loaded)) out.hosts = loaded;

  // The two calendar steps share one waiting window.
  const [timezones, calendars] = await Promise.all([
    networkStep(ctx, 'the time zone sync', waitMs.network, () => syncTimezones(ctx, hosts)),
    networkStep(ctx, 'the calendar health check', waitMs.network, () => probeCalendars(ctx, hosts)),
  ]);
  out.timezones = timezones;
  out.calendars = calendars;
  out.pruned = await step(ctx, 'pruning old claims and rate limit counters', () => pruneEphemeral(ctx, EPHEMERAL_MAX_AGE_MS));
  out.calls = await step(ctx, 'pruning old call records', () => pruneOldCalls(ctx));
  out.bookings = await networkStep(ctx, 'the booking check', waitMs.reconcile, () => reconcileBookings(ctx));
  return out;
}

export interface ScheduledRunOptions {
  /** how long a housekeeping step that talks to calendars is waited for (default 6 s; the booking check 5 s) */
  stepWaitMs?: number;
}

/**
 * One scheduled run. Never throws because of a job or a housekeeping step: what went wrong is in the
 * returned summary (plain JSON) and in the log.
 */
export async function runScheduled(ctx: Ctx, opts?: ScheduledRunOptions): Promise<Record<string, unknown>> {
  // The job runner needs every handler in place, whichever module happened to be loaded first.
  registerBookingJobHandlers();
  const summary: Record<string, unknown> = { at: ctx.now().toISOString() };

  const lastRun = await step(ctx, 'reading the housekeeping marker', () => cacheGet<{ at: string }>(ctx, HOUSEKEEPING_MARK));
  const unreadable = !!lastRun && typeof lastRun === 'object' && 'error' in lastRun;
  const due = !unreadable && lastRun === null;

  summary.jobs = await step(ctx, 'running the due jobs', () => runDueJobs(ctx, { budgetMs: due ? JOBS_BUDGET_WITH_HOUSEKEEPING_MS : JOBS_BUDGET_MS }));

  if (!due) {
    summary.housekeeping = unreadable ? 'skipped' : 'not_due';
    return summary;
  }
  // Marked before the work starts: a step that fails or runs long must not bring housekeeping back every two minutes.
  const marked = await step(ctx, 'saving the housekeeping marker', async () => {
    await cacheSet(ctx, HOUSEKEEPING_MARK, { at: ctx.now().toISOString() }, HOUSEKEEPING_EVERY_SEC);
    return true;
  });
  if (marked !== true) {
    summary.housekeeping = 'skipped';
    return summary;
  }
  const wait = typeof opts?.stepWaitMs === 'number' && opts.stepWaitMs >= 0 ? opts.stepWaitMs : null;
  summary.housekeeping = await housekeeping(ctx, { network: wait ?? NETWORK_STEP_MS, reconcile: wait ?? RECONCILE_STEP_MS });
  return summary;
}
