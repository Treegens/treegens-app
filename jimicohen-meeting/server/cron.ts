/**
 * What the scheduled function does every two minutes: send everything that is due, then, at most
 * every half hour, housekeeping, and last, on every run, removing rate limit counters whose window is
 * over. Each housekeeping step stands alone: one that fails is logged and reported in the summary,
 * and the others still run. The run as a whole never fails because of them.
 */
import type { CallRecord, Host } from '../shared/types';
import { alertCalendarTrouble, reconcileBookings, registerBookingJobHandlers } from './lib/booking';
import { getHostBusy, syncHostTimezone, type BusyProblem } from './lib/busy';
import { accountsOf } from './lib/googleAccounts';
import { remindEndingConnections } from './lib/googleExpiry';
import type { Ctx } from './lib/ctx';
import { runDueJobs } from './lib/jobs';
import { KEYS, PRUNE_BUDGET_MS, PRUNE_LIMIT_PER_PREFIX, cacheGet, cacheSet, listHosts, pruneEphemeral } from './lib/repo';
import { runAssistantModelMove, runOpenHoursMove, runShortLinkMove } from './lib/seed';
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
/**
 * Netlify ends a scheduled run at 30 seconds. The cleanup steps after the booking check only use what
 * is left of this much, counted from the start of the run; what they do not get to waits for the next run.
 */
const RUN_DEADLINE_MS = 25_000;
/** How much longer than its own budget a pruning step is waited for (a delete that is slow to answer). */
const PRUNE_GRACE_MS = 1_500;
/** Less time than this left: a cleanup step is not started at all. */
const MIN_CLEANUP_MS = 1_000;

const EPHEMERAL_MAX_AGE_MS = 2 * DAY_MS;
/**
 * Rate limit counters one run may remove. A visitor makes about one a minute on the booking page,
 * and a flood from many addresses makes them faster than a half-hourly sweep could ever remove, so
 * they are swept on every run, with all the time the run has left. The time is the real bound.
 */
const RATE_LIMIT_PRUNE_LIMIT = 10_000;
const CALL_MAX_AGE_MS = 90 * DAY_MS;
const CALL_SCAN_LIMIT = 2000;
const READ_CONCURRENCY = 16;
/** Hosts whose calendars the health check reads at the same time (each reads all of its accounts at once). */
const PROBE_CONCURRENCY = 8;

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
  // Every Google account of a host counts, not only the main one.
  const connected = hosts.filter((h) => accountsOf(h).length > 0 || (Array.isArray(h.icsFeeds) && h.icsFeeds.length > 0));
  const nowMs = ctx.now().getTime();
  const failures: { host: Host; error: string; problems?: BusyProblem[] }[] = [];
  // A host reads all of its accounts at once; a few hosts at a time keeps the run's requests bounded.
  await eachLimited(connected, PROBE_CONCURRENCY, async (host) => {
    const result = await getHostBusy(ctx, host, { start: nowMs, end: nowMs + DAY_MS }, { fresh: true });
    if (!result.ok) failures.push({ host, error: result.error ?? 'Calendar could not be read.', ...(result.problems?.length ? { problems: result.problems } : {}) });
  });
  failures.sort((a, b) => a.host.id.localeCompare(b.host.id));
  const alerted = failures.length > 0 ? await alertCalendarTrouble(ctx, failures) : 0;
  return { checked: connected.length, broken: failures.length, alerted };
}

/** Call records (transcripts included) are kept for 90 days. Checked once a day; stops starting new reads at `untilMs`. */
async function pruneOldCalls(ctx: Ctx, untilMs: number): Promise<{ checked: number; removed: number } | 'not_due'> {
  if (await cacheGet(ctx, CALLS_MARK)) return 'not_due';
  await cacheSet(ctx, CALLS_MARK, { at: ctx.now().toISOString() }, CALLS_EVERY_SEC);

  const cutoff = ctx.now().getTime() - CALL_MAX_AGE_MS;
  const keys = (await ctx.kv.list(KEYS.callPrefix)).slice(0, CALL_SCAN_LIMIT);
  let checked = 0;
  let removed = 0;
  await eachLimited(keys, READ_CONCURRENCY, async (key) => {
    // Out of time: the rest is looked at tomorrow.
    if (ctx.now().getTime() >= untilMs) return;
    checked++;
    const record = await ctx.kv.getJSON<Partial<CallRecord>>(key);
    if (!record) return;
    // The last change counts: a call that was touched recently is not old. A record without a readable date stays.
    const stamps = [Date.parse(record.updatedAt ?? ''), Date.parse(record.createdAt ?? '')].filter((ms) => Number.isFinite(ms));
    if (stamps.length === 0 || Math.max(...stamps) >= cutoff) return;
    await ctx.kv.delete(key);
    removed++;
  });
  return { checked, removed };
}

async function housekeeping(ctx: Ctx, waitMs: { network: number; reconcile: number }, deadlineMs: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const left = (): number => deadlineMs - ctx.now().getTime();
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
  // Connections Google said would end soon (an app still in Testing): the owner hears two days and one day before.
  out.ending = await step(ctx, 'the Google end date reminders', () => remindEndingConnections(ctx, hosts));
  // The repair comes before the cleanup: it gives back times held by interrupted bookings and re-queues
  // failed calendar writes, and a backlog of old keys must never keep it from running.
  out.bookings = await networkStep(ctx, 'the booking check', waitMs.reconcile, () => reconcileBookings(ctx));

  // Rate limit counters are not part of this: every run removes them (pruneRateLimits).
  const pruneBudget = Math.min(PRUNE_BUDGET_MS, left() - PRUNE_GRACE_MS);
  out.pruned =
    pruneBudget >= MIN_CLEANUP_MS
      ? await networkStep(ctx, 'pruning old claims and cache entries', pruneBudget + PRUNE_GRACE_MS, () =>
          pruneEphemeral(ctx, EPHEMERAL_MAX_AGE_MS, PRUNE_LIMIT_PER_PREFIX, pruneBudget, [KEYS.claimPrefix, KEYS.cachePrefix]),
        )
      : { skipped: 'out_of_time' };
  out.calls =
    left() >= MIN_CLEANUP_MS
      ? await networkStep(ctx, 'pruning old call records', left(), () => pruneOldCalls(ctx, deadlineMs - PRUNE_GRACE_MS))
      : { skipped: 'out_of_time' };
  return out;
}

/**
 * Removes the rate limit counters whose window is over, with what is left of the run's time (never
 * past `deadlineMs`). What it does not get to waits for the next run, two minutes later.
 */
async function pruneRateLimits(ctx: Ctx, deadlineMs: number): Promise<unknown> {
  const budget = deadlineMs - ctx.now().getTime() - PRUNE_GRACE_MS;
  if (budget < MIN_CLEANUP_MS) return { skipped: 'out_of_time' };
  return networkStep(ctx, 'pruning old rate limit counters', budget + PRUNE_GRACE_MS, () =>
    pruneEphemeral(ctx, EPHEMERAL_MAX_AGE_MS, RATE_LIMIT_PRUNE_LIMIT, budget, [KEYS.rateLimitPrefix]),
  );
}

export interface ScheduledRunOptions {
  /** how long a housekeeping step that talks to calendars is waited for (default 6 s; the booking check 5 s) */
  stepWaitMs?: number;
  /**
   * Run the one-time changes to stored data first (server/lib/seed.ts). Passed only by the scheduled
   * function of the deploy (netlify/functions/cron.mts), never by the dev server's timer or POST /dev/run-jobs.
   */
  oneTimeMoves?: boolean;
}

/** How long the one-time setup is waited for before the run carries on (it then finishes in the background). */
const ONE_TIME_MOVES_MS = 5_000;

/**
 * One scheduled run. Never throws because of a job or a housekeeping step: what went wrong is in the
 * returned summary (plain JSON) and in the log.
 */
export async function runScheduled(ctx: Ctx, opts?: ScheduledRunOptions): Promise<Record<string, unknown>> {
  // The job runner needs every handler in place, whichever module happened to be loaded first.
  registerBookingJobHandlers();
  const startedMs = ctx.now().getTime();
  const summary: Record<string, unknown> = { at: ctx.now().toISOString() };

  // A failure is logged and reported, a slow store stops being waited for: the due jobs below always run.
  if (opts?.oneTimeMoves) {
    summary.shortLinks = await networkStep(ctx, 'the short link setup', ONE_TIME_MOVES_MS, () => runShortLinkMove(ctx));
    summary.assistantModel = await networkStep(ctx, 'the assistant model move', ONE_TIME_MOVES_MS, () => runAssistantModelMove(ctx));
    summary.openHours = await networkStep(ctx, 'the open hours move', ONE_TIME_MOVES_MS, () => runOpenHoursMove(ctx));
  }

  const lastRun = await step(ctx, 'reading the housekeeping marker', () => cacheGet<{ at: string }>(ctx, HOUSEKEEPING_MARK));
  const unreadable = !!lastRun && typeof lastRun === 'object' && 'error' in lastRun;
  const due = !unreadable && lastRun === null;

  summary.jobs = await step(ctx, 'running the due jobs', () => runDueJobs(ctx, { budgetMs: due ? JOBS_BUDGET_WITH_HOUSEKEEPING_MS : JOBS_BUDGET_MS }));

  if (!due) {
    summary.housekeeping = unreadable ? 'skipped' : 'not_due';
  } else {
    // Marked before the work starts: a step that fails or runs long must not bring housekeeping back every two minutes.
    const marked = await step(ctx, 'saving the housekeeping marker', async () => {
      await cacheSet(ctx, HOUSEKEEPING_MARK, { at: ctx.now().toISOString() }, HOUSEKEEPING_EVERY_SEC);
      return true;
    });
    if (marked !== true) {
      summary.housekeeping = 'skipped';
    } else {
      const wait = typeof opts?.stepWaitMs === 'number' && opts.stepWaitMs >= 0 ? opts.stepWaitMs : null;
      summary.housekeeping = await housekeeping(ctx, { network: wait ?? NETWORK_STEP_MS, reconcile: wait ?? RECONCILE_STEP_MS }, startedMs + RUN_DEADLINE_MS);
    }
  }
  summary.rateLimits = await pruneRateLimits(ctx, startedMs + RUN_DEADLINE_MS);
  return summary;
}
