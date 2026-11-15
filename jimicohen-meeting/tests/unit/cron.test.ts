import { describe, expect, it } from 'vitest';
import { defaultOwnerHost } from '../../shared/defaults';
import type { BookingIndexEntry, CallRecord, Host, HostGoogle, Job } from '../../shared/types';
import { runScheduled } from '../../server/cron';
import { rateLimit } from '../../server/lib/auth';
import { createBooking } from '../../server/lib/booking';
import { seal } from '../../server/lib/crypto';
import type { Env, KV } from '../../server/lib/ctx';
import { enqueueJob } from '../../server/lib/jobs';
import { cacheSet, claim, getBooking, getBookingIndex, getHost, getSite, listJobs, mutateBookingIndex, saveCall, saveHost, saveSite, updateBooking, updateHost } from '../../server/lib/repo';
import { memoryKV } from '../../server/lib/store';
import { makeTestCtx, markSetUp, type TestCtx } from '../helpers/ctx';

// ───────────────────────── fixtures ─────────────────────────

const OWNER = 'host_owner';
const ALEX = 'host_alex';
const NOW = '2026-11-16T09:00:00.000Z';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const TIMEZONE_URL = 'https://www.googleapis.com/calendar/v3/users/me/settings/timezone';
const RESEND_URL = 'https://api.resend.com/emails';

const ENV: Partial<Env> = { overrides: { googleClientId: 'client-id', googleClientSecret: 'client-secret', resendApiKey: 're_test_key' } };

interface Call {
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

type Reply = Response | undefined | Promise<Response | undefined>;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function net(ctx: TestCtx, custom?: (call: Call) => Reply): Call[] {
  const calls: Call[] = [];
  ctx.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    let parsed: unknown = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = null;
    }
    const call: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), json: parsed };
    calls.push(call);
    const special = await custom?.(call);
    if (special) return special;
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'access-1', expires_in: 3599 });
    if (url === FREEBUSY_URL) return jsonResponse({ calendars: { primary: { busy: [] } } });
    if (url === TIMEZONE_URL) return jsonResponse({ kind: 'calendar#setting', id: 'timezone', value: 'Europe/Berlin' });
    if (url === RESEND_URL) return jsonResponse({ id: 'email-1' });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return calls;
}

async function setup(opts: { kv?: KV; env?: Partial<Env> } = {}): Promise<TestCtx> {
  const ctx = makeTestCtx({ now: NOW, env: opts.env ?? ENV, kv: opts.kv });
  const site = await getSite(ctx);
  await saveSite(ctx, { ...site, email: { ...site.email, fromEmail: 'meetings@jimicohen.com' } });
  await updateHost(ctx, OWNER, (h) => ({ ...h, email: 'jimi@example.com' }));
  // First-run setup is done, so the booking page takes bookings (booking.ts siteIsOpen).
  await markSetUp(ctx);
  net(ctx);
  return ctx;
}

function google(ctx: TestCtx, over: Partial<HostGoogle> = {}): HostGoogle {
  return {
    email: 'calendar@gmail.test',
    refreshTokenEnc: seal(ctx, 'google-refresh', 'refresh-token-1'),
    scopes: [],
    busyCalendarIds: ['primary'],
    writeCalendarId: 'primary',
    gmailSend: false,
    status: 'ok',
    connectedAt: NOW,
    ...over,
  };
}

async function addAlex(ctx: TestCtx, over: Partial<Host> = {}): Promise<Host> {
  return saveHost(ctx, { ...defaultOwnerHost(NOW, 'UTC'), id: ALEX, role: 'member', name: 'Alex Kim', email: 'alex@example.com', ...over });
}

function call(id: string, at: string): CallRecord {
  return { id, bookingId: 'bkg_x', to: '+14155552671', status: 'completed', turns: [{ role: 'assistant', text: 'Hi', at }], pendingCancel: false, createdAt: at, updatedAt: at };
}

const alerts = async (ctx: TestCtx): Promise<Job[]> => (await listJobs(ctx)).filter((j) => j.kind === 'host_alert');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const housekeeping = (summary: Record<string, unknown>): any => summary.housekeeping;

// ───────────────────────── jobs ─────────────────────────

describe('runScheduled: jobs', () => {
  it('sends what is due and leaves the rest queued', async () => {
    const ctx = await setup();
    const calls = net(ctx);
    await enqueueJob(ctx, { type: 'message', kind: 'host_alert', bookingId: '', channel: 'email', audience: 'host', subject: 'Heads up', body: 'Hi {{host_first_name}},\n\nSomething happened.', dueAt: NOW });
    await enqueueJob(ctx, { type: 'message', kind: 'host_alert', bookingId: '', channel: 'email', audience: 'host', subject: 'Later', body: 'Later.', dueAt: '2026-11-16T12:00:00.000Z' });

    const summary = await runScheduled(ctx);
    expect(summary.at).toBe(NOW);
    expect(summary.jobs).toEqual({ processed: 1, failed: 0, remaining: 0 });
    const sent = calls.filter((c) => c.url === RESEND_URL);
    expect(sent).toHaveLength(1);
    expect(sent[0].json.subject).toBe('Heads up');
    expect(sent[0].json.to[0]).toContain('jimi@example.com');
    expect((await listJobs(ctx)).map((j) => j.subject)).toEqual(['Later']);
  });

  it('can run calendar repair jobs: their handler is registered by the scheduled run itself', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, { slug: 'intro', start: '2026-11-18T14:00:00.000Z', durationMin: 15, name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'UTC' });
    await ctx.settle();
    await enqueueJob(ctx, { type: 'gcal_sync', bookingId: booking.id, dueAt: NOW });
    const summary = await runScheduled(ctx);
    expect(summary.jobs).toMatchObject({ failed: 0, remaining: 0 });
    expect((await listJobs(ctx)).filter((j) => j.type === 'gcal_sync')).toEqual([]);
  });

  it('reports a job runner that cannot start instead of failing the run', async () => {
    const inner = memoryKV();
    let broken = false;
    const kv: KV = {
      ...inner,
      async list(prefix) {
        if (broken && prefix === 'jobs/') throw new Error('storage is down');
        return inner.list(prefix);
      },
    };
    const ctx = await setup({ kv });
    broken = true;
    const summary = await runScheduled(ctx);
    expect(summary.jobs).toEqual({ error: 'storage is down' });
    expect(typeof housekeeping(summary)).toBe('object');
    expect(ctx.logs.some((l) => l.level === 'error' && l.msg.includes('running the due jobs'))).toBe(true);
  });
});

// ───────────────────────── housekeeping ─────────────────────────

describe('runScheduled: housekeeping', () => {
  it('runs at most every 30 minutes', async () => {
    const ctx = await setup();
    const first = await runScheduled(ctx);
    expect(housekeeping(first)).toMatchObject({
      timezones: { checked: 0, changed: 0 },
      calendars: { checked: 0, broken: 0, alerted: 0 },
      pruned: 0,
      calls: { checked: 0, removed: 0 },
      bookings: { checked: 0, removed: 0, freed: 0, moved: 0, requeued: 0 },
    });

    ctx.clock.advance(2 * MINUTE);
    expect((await runScheduled(ctx)).housekeeping).toBe('not_due');
    ctx.clock.advance(27 * MINUTE);
    expect((await runScheduled(ctx)).housekeeping).toBe('not_due');
    ctx.clock.advance(MINUTE);
    expect(typeof housekeeping(await runScheduled(ctx))).toBe('object');
    ctx.clock.advance(2 * MINUTE);
    expect((await runScheduled(ctx)).housekeeping).toBe('not_due');
  });

  it('returns a summary that is plain JSON', async () => {
    const ctx = await setup();
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: google(ctx), timezoneMode: 'google' }));
    const summary = await runScheduled(ctx);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    expect(Object.keys(summary).sort()).toEqual(['at', 'housekeeping', 'jobs', 'rateLimits']);
  });

  it('follows the Google Calendar zone of hosts who asked for that, and leaves the others alone', async () => {
    const ctx = await setup();
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: google(ctx), timezoneMode: 'google', timezone: 'UTC' }));
    await addAlex(ctx, { google: google(ctx, { email: 'alex@gmail.test' }), timezoneMode: 'device', timezone: 'America/New_York' });
    const calls = net(ctx);

    const summary = await runScheduled(ctx);
    expect(housekeeping(summary).timezones).toEqual({ checked: 1, changed: 1 });
    expect((await getHost(ctx, OWNER))?.timezone).toBe('Europe/Berlin');
    expect((await getHost(ctx, ALEX))?.timezone).toBe('America/New_York');
    expect(calls.filter((c) => c.url === TIMEZONE_URL)).toHaveLength(1);

    ctx.clock.advance(31 * MINUTE);
    expect(housekeeping(await runScheduled(ctx)).timezones).toEqual({ checked: 1, changed: 0 });
  });

  it('probes every connected calendar and tells the owner about a broken one once a day', async () => {
    const ctx = await setup();
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: google(ctx) }));
    await addAlex(ctx, { google: google(ctx, { email: 'alex@gmail.test', status: 'needs_reconnect' }) });
    const calls = net(ctx);

    const first = await runScheduled(ctx);
    expect(housekeeping(first).calendars).toEqual({ checked: 2, broken: 1, alerted: 1 });
    // The owner's calendar was really read: one free/busy request for the next 24 hours.
    const probes = calls.filter((c) => c.url === FREEBUSY_URL);
    expect(probes).toHaveLength(1);
    expect(probes[0].json).toMatchObject({ timeMin: NOW, timeMax: '2026-11-17T09:00:00.000Z' });
    expect((await getHost(ctx, ALEX))?.calendarHealth).toMatchObject({ ok: false, message: 'Google Calendar needs to be reconnected.' });
    expect((await getHost(ctx, OWNER))?.calendarHealth).toMatchObject({ ok: true });

    let queued = await alerts(ctx);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: 'message', bookingId: '', channel: 'email', audience: 'host', subject: 'A calendar needs attention: Alex Kim' });
    expect(queued[0].body).toContain('could not be read during a routine check');
    expect(queued[0].body).toContain('Alex Kim: Google Calendar needs to be reconnected.');
    expect(`${queued[0].subject} ${queued[0].body}`).not.toContain('—');

    // The next run delivers it. Later runs the same day find the calendar still broken and stay quiet.
    ctx.clock.advance(2 * MINUTE);
    await runScheduled(ctx);
    const sent = calls.filter((c) => c.url === RESEND_URL);
    expect(sent).toHaveLength(1);
    expect(sent[0].json.to[0]).toContain('jimi@example.com');
    for (let i = 0; i < 3; i++) {
      ctx.clock.advance(31 * MINUTE);
      expect(housekeeping(await runScheduled(ctx)).calendars).toEqual({ checked: 2, broken: 1, alerted: 0 });
    }
    expect(await alerts(ctx)).toEqual([]);

    // The next day: one more.
    ctx.clock.set('2026-11-17T09:30:00.000Z');
    expect(housekeeping(await runScheduled(ctx)).calendars).toEqual({ checked: 2, broken: 1, alerted: 1 });
    queued = await alerts(ctx);
    expect(queued).toHaveLength(1);
  });

  it('alerts separately for each broken host and shares the daily limit with booking attempts', async () => {
    const ctx = await setup();
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: google(ctx, { status: 'needs_reconnect' }) }));
    await addAlex(ctx, { google: google(ctx, { email: 'alex@gmail.test', status: 'needs_reconnect' }) });
    // A visitor already ran into the owner's broken calendar this morning.
    await createBooking(ctx, { slug: 'intro', start: '2026-11-18T14:00:00.000Z', durationMin: 15, name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'UTC' }).catch(() => undefined);
    expect((await alerts(ctx)).map((j) => j.subject)).toEqual(['A calendar needs attention: Jimi Cohen']);

    const summary = await runScheduled(ctx, { stepWaitMs: 2000 });
    expect(housekeeping(summary).calendars).toEqual({ checked: 2, broken: 2, alerted: 1 });
    // The run delivered the first alert; the new one is about Alex only.
    expect((await alerts(ctx)).map((j) => j.subject)).toEqual(['A calendar needs attention: Alex Kim']);
  });

  it('removes claims older than two days, expired cache entries and rate limit counters that are over, and keeps recent ones', async () => {
    const ctx = await setup();
    await claim(ctx, 'old-claim');
    // A counter in the layout from before the window's length was in the key: two days, as before.
    await ctx.kv.setJSON('rl/slots/abc/1000', { n: 3 });
    await cacheSet(ctx, 'old-cache', { v: 1 }, 60);
    ctx.clock.advance(2 * DAY + HOUR);
    await claim(ctx, 'fresh-claim');
    const freshWindow = Math.floor(ctx.now().getTime() / 60_000) * 60_000;
    await ctx.kv.setJSON(`rl/slots/abc/${freshWindow}`, { n: 1 });
    await ctx.kv.setJSON(`rl/slots/def/${freshWindow}-60`, { n: 1 });
    await ctx.kv.setJSON(`rl/slots/def/${freshWindow - 3 * MINUTE}-60`, { n: 1 });
    await cacheSet(ctx, 'fresh-cache', { v: 1 }, 60);
    // Expired a moment ago: an expired cache entry is never read again, so it goes at once.
    await cacheSet(ctx, 'just-expired', { v: 1 }, 0);

    const summary = await runScheduled(ctx);
    expect(housekeeping(summary).pruned).toBe(3);
    expect(summary.rateLimits).toBe(2);
    const keys = await ctx.kv.list('');
    expect(keys).not.toContain('claims/old-claim');
    expect(keys).not.toContain('rl/slots/abc/1000');
    expect(keys).not.toContain(`rl/slots/def/${freshWindow - 3 * MINUTE}-60`);
    expect(keys).not.toContain('cache/old-cache');
    expect(keys).not.toContain('cache/just-expired');
    expect(keys).toContain('claims/fresh-claim');
    expect(keys).toContain(`rl/slots/abc/${freshWindow}`);
    expect(keys).toContain(`rl/slots/def/${freshWindow}-60`);
    expect(keys).toContain('cache/fresh-cache');
  });

  it('removes rate limit counters on every run, also when housekeeping is not due', async () => {
    const ctx = await setup();
    expect(typeof housekeeping(await runScheduled(ctx))).toBe('object');
    for (let i = 0; i < 5; i++) await rateLimit(ctx, 'slots', `198.51.100.${i}`, 60, 60);
    await rateLimit(ctx, 'login', '203.0.113.7', 8, 600);

    ctx.clock.advance(2 * MINUTE);
    const next = await runScheduled(ctx);
    expect(next.housekeeping).toBe('not_due');
    expect(next.rateLimits).toBe(5);
    expect((await ctx.kv.list('rl/')).map((k) => k.split('/')[1])).toEqual(['login']);
    ctx.clock.advance(10 * MINUTE);
    expect(await runScheduled(ctx)).toMatchObject({ housekeeping: 'not_due', rateLimits: 1 });
    expect(await ctx.kv.list('rl/')).toEqual([]);
  });

  it('repairs the booking index before it prunes, so a pruning backlog cannot hold the repair up', async () => {
    const inner = memoryKV();
    let indexAtPruneStart: BookingIndexEntry[] | null = null;
    const notePruneStart = async (prefix: string): Promise<void> => {
      // The first listing of a pruned prefix is where pruning starts.
      if (indexAtPruneStart === null && ['rl/', 'claims/', 'cache/'].includes(prefix)) indexAtPruneStart = (await inner.getJSON<BookingIndexEntry[]>('index/bookings')) ?? [];
    };
    const kv: KV = {
      ...inner,
      async list(prefix) {
        await notePruneStart(prefix);
        return inner.list(prefix);
      },
      async *listPages(prefix) {
        await notePruneStart(prefix);
        yield* inner.listPages!(prefix);
      },
    };
    const ctx = await setup({ kv });
    const { booking } = await createBooking(ctx, { slug: 'intro', start: '2026-11-18T14:00:00.000Z', durationMin: 15, name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'UTC' });
    await ctx.settle();
    // A cancellation whose second write (the index) never happened: the time is still held.
    await updateBooking(ctx, booking.id, (b) => ({ ...b, status: 'cancelled', cancellation: { at: NOW, by: 'invitee' } }));
    indexAtPruneStart = null;

    const done = housekeeping(await runScheduled(ctx));
    expect(done.bookings).toMatchObject({ freed: 1 });
    // When pruning began, the held time had already been given back.
    expect(indexAtPruneStart).not.toBeNull();
    expect(indexAtPruneStart!).toEqual([expect.objectContaining({ id: booking.id, status: 'cancelled' })]);
  });

  it('leaves the cleanup to a later run when the run is out of time, and still repairs bookings first', async () => {
    const inner = memoryKV();
    let slowIndex = false;
    let ctxRef: TestCtx | null = null;
    const kv: KV = {
      ...inner,
      async getJSON<T>(key: string) {
        // Slow storage: the run has used 24.5 of its 25 seconds by the time the booking check has read the index.
        if (slowIndex && key === 'index/bookings') {
          slowIndex = false;
          ctxRef?.clock.advance(24_500);
        }
        return inner.getJSON<T>(key);
      },
    };
    const ctx = await setup({ kv });
    ctxRef = ctx;
    await claim(ctx, 'old-claim');
    await ctx.kv.setJSON('calls/call_old1', call('call_old1', '2026-08-10T09:00:00.000Z'));
    ctx.clock.advance(3 * DAY);
    slowIndex = true;

    const summary = await runScheduled(ctx);
    const done = housekeeping(summary);
    expect(done.bookings).toMatchObject({ checked: 0 });
    expect(done.pruned).toEqual({ skipped: 'out_of_time' });
    expect(done.calls).toEqual({ skipped: 'out_of_time' });
    // The rate limit sweep at the end of every run never goes past the run's deadline either.
    expect(summary.rateLimits).toEqual({ skipped: 'out_of_time' });
    expect(await ctx.kv.list('claims/')).toContain('claims/old-claim');

    // The next run with time to spare does it, the daily call check included.
    expect(slowIndex).toBe(false);
    ctx.clock.advance(31 * MINUTE);
    const next = housekeeping(await runScheduled(ctx));
    expect(next.pruned).toBeGreaterThanOrEqual(1);
    expect(next.calls).toMatchObject({ removed: 1 });
    expect(await ctx.kv.list('claims/')).not.toContain('claims/old-claim');
  });

  it('deletes call records older than 90 days, once a day', async () => {
    const ctx = await setup();
    const old = '2026-08-10T09:00:00.000Z'; // 98 days ago
    const recent = '2026-10-20T09:00:00.000Z';
    // saveCall stamps updatedAt with "now", so the old ones are written directly.
    await ctx.kv.setJSON('calls/call_old1', call('call_old1', old));
    await ctx.kv.setJSON('calls/call_old2', call('call_old2', old));
    await ctx.kv.setJSON('calls/call_touched', { ...call('call_touched', old), updatedAt: recent });
    await ctx.kv.setJSON('calls/call_undated', { id: 'call_undated', turns: [] });
    await saveCall(ctx, call('call_new', NOW));

    const first = await runScheduled(ctx);
    expect(housekeeping(first).calls).toEqual({ checked: 5, removed: 2 });
    expect(await ctx.kv.list('calls/')).toEqual(['calls/call_new', 'calls/call_touched', 'calls/call_undated']);

    // Half an hour later housekeeping runs again, but the call check has had its turn for today.
    await ctx.kv.setJSON('calls/call_old3', call('call_old3', old));
    ctx.clock.advance(31 * MINUTE);
    expect(housekeeping(await runScheduled(ctx)).calls).toBe('not_due');
    expect(await ctx.kv.list('calls/')).toContain('calls/call_old3');

    ctx.clock.advance(DAY);
    expect(housekeeping(await runScheduled(ctx)).calls).toMatchObject({ removed: 1 });
    expect(await ctx.kv.list('calls/')).not.toContain('calls/call_old3');
  });

  it('heals what interrupted requests left in the booking index', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, { slug: 'intro', start: '2026-11-18T14:00:00.000Z', durationMin: 15, name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'UTC' });
    await ctx.settle();
    const phantom: BookingIndexEntry = { ...(await getBookingIndex(ctx))[0], id: 'bkg_phantomphantom00', start: '2026-11-19T10:00:00.000Z', end: '2026-11-19T10:15:00.000Z' };
    await mutateBookingIndex(ctx, (entries) => [...entries, phantom]);
    // A cancellation whose second write never happened.
    await updateBooking(ctx, booking.id, (b) => ({ ...b, status: 'cancelled', cancellation: { at: NOW, by: 'invitee' } }));

    expect(housekeeping(await runScheduled(ctx)).bookings).toEqual({ checked: 2, removed: 0, freed: 1, moved: 0, requeued: 0 });
    ctx.clock.advance(31 * MINUTE);
    expect(housekeeping(await runScheduled(ctx)).bookings).toEqual({ checked: 1, removed: 1, freed: 0, moved: 0, requeued: 0 });
    expect(await getBookingIndex(ctx)).toEqual([expect.objectContaining({ id: booking.id, status: 'cancelled' })]);
    expect((await getBooking(ctx, booking.id))?.status).toBe('cancelled');
  });

  it('carries on when a step fails: the failure is in the summary and the log, the rest still runs', async () => {
    const inner = memoryKV();
    let broken = false;
    const kv: KV = {
      ...inner,
      async list(prefix) {
        if (broken && (prefix === 'calls/' || prefix === 'rl/' || prefix === 'claims/')) throw new Error(`cannot list ${prefix}`);
        return inner.list(prefix);
      },
      async *listPages(prefix) {
        if (broken && (prefix === 'rl/' || prefix === 'claims/')) throw new Error(`cannot list ${prefix}`);
        yield* inner.listPages!(prefix);
      },
    };
    const ctx = await setup({ kv });
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: google(ctx), timezoneMode: 'google' }));
    net(ctx, (c) => (c.url === TIMEZONE_URL ? jsonResponse({ error: { code: 500 } }, 500) : undefined));
    broken = true;

    const summary = await runScheduled(ctx);
    const done = housekeeping(summary);
    expect(done.pruned).toEqual({ error: 'cannot list claims/' });
    expect(done.calls).toEqual({ error: 'cannot list calls/' });
    expect(summary.rateLimits).toEqual({ error: 'cannot list rl/' });
    // A zone lookup that fails leaves the host as it was and is not an error of the run.
    expect(done.timezones).toEqual({ checked: 1, changed: 0 });
    expect(done.calendars).toEqual({ checked: 1, broken: 0, alerted: 0 });
    expect(done.bookings).toMatchObject({ checked: 0 });
    expect(summary.jobs).toEqual({ processed: 0, failed: 0, remaining: 0 });
    expect(ctx.logs.filter((l) => l.level === 'error').map((l) => l.msg)).toEqual(
      expect.arrayContaining([
        'cron: pruning old claims and cache entries failed',
        'cron: pruning old call records failed',
        'cron: pruning old rate limit counters failed',
      ]),
    );
    expect((await getHost(ctx, OWNER))?.timezone).toBe('UTC');
  });

  it('skips housekeeping when its marker cannot be read or saved, and still runs the jobs', async () => {
    const inner = memoryKV();
    let mode: 'ok' | 'no-read' | 'no-write' = 'ok';
    const kv: KV = {
      ...inner,
      async getJSON<T>(key: string) {
        if (mode === 'no-read' && key === 'cache/housekeeping-ran') throw new Error('read failed');
        return inner.getJSON<T>(key);
      },
      async setJSON(key, value, opts) {
        if (mode === 'no-write' && key === 'cache/housekeeping-ran') throw new Error('write failed');
        return inner.setJSON(key, value, opts);
      },
    };
    const ctx = await setup({ kv });
    await enqueueJob(ctx, { type: 'message', kind: 'host_alert', bookingId: '', channel: 'email', audience: 'host', subject: 'Heads up', body: 'Hi.', dueAt: NOW });

    mode = 'no-read';
    const a = await runScheduled(ctx);
    expect(a.housekeeping).toBe('skipped');
    expect(a.jobs).toEqual({ processed: 1, failed: 0, remaining: 0 });

    mode = 'no-write';
    expect((await runScheduled(ctx)).housekeeping).toBe('skipped');

    mode = 'ok';
    expect(typeof housekeeping(await runScheduled(ctx))).toBe('object');
  });

  it('does not wait for a calendar that hangs: the run finishes and the step is left to the background', async () => {
    const ctx = await setup();
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: google(ctx), timezoneMode: 'google' }));
    let release: () => void = () => undefined;
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    net(ctx, async (c) => {
      if (c.url === TIMEZONE_URL || c.url === FREEBUSY_URL) await stuck;
      return undefined;
    });

    const summary = await runScheduled(ctx, { stepWaitMs: 25 });
    const done = housekeeping(summary);
    expect(done.timezones).toEqual({ timedOut: true });
    expect(done.calendars).toEqual({ timedOut: true });
    expect(done.pruned).toBe(0);
    expect(done.bookings).toMatchObject({ checked: 0 });

    release();
    await ctx.settle();
    expect((await getHost(ctx, OWNER))?.timezone).toBe('Europe/Berlin');
  });
});

// ───────────────────────── rate limit counters under a flood ─────────────────────────

describe('runScheduled: rate limit counters under a flood', () => {
  it('keeps the counters bounded while a flood of addresses asks for times, and clears them within two runs after it stops', async () => {
    // A store that takes time, the way the real one does: every delete and every page of a listing moves
    // the run's clock on. Sixteen deletes run at once, so 3 ms each stands for about 50 ms per delete.
    const inner = memoryKV();
    let charge: TestCtx['clock'] | null = null;
    const kv: KV = {
      ...inner,
      async delete(key) {
        charge?.advance(3);
        return inner.delete(key);
      },
      async *listPages(prefix) {
        for await (const page of inner.listPages!(prefix)) {
          charge?.advance(150);
          yield page;
        }
      },
    };
    const ctx = await setup({ kv });
    const counters = async (): Promise<number> => (await inner.list('rl/')).length;

    // 1,200 new addresses a minute for an hour (72,000 in all, each asking for times once), in steps of
    // 10 seconds, the way GET /public/slots counts them. The scheduled run comes every two minutes.
    const PER_MINUTE = 1200;
    const STEP_MS = 10_000;
    const PER_STEP = PER_MINUTE / (MINUTE / STEP_MS);
    const startMs = ctx.now().getTime();
    let address = 0;
    let most = 0;
    const run = async (): Promise<Record<string, unknown>> => {
      most = Math.max(most, await counters());
      charge = ctx.clock;
      try {
        return await runScheduled(ctx);
      } finally {
        charge = null;
      }
    };
    for (let step = 0; step < HOUR / STEP_MS; step++) {
      const plannedMs = startMs + step * STEP_MS;
      if (ctx.now().getTime() < plannedMs) ctx.clock.set(plannedMs);
      if (step % (2 * MINUTE / STEP_MS) === 0) {
        const summary = await run();
        expect(summary.rateLimits, `run at minute ${step / 6}`).toEqual(expect.any(Number));
      }
      for (let i = 0; i < PER_STEP; i++) {
        address++;
        await rateLimit(ctx, 'slots', `2001:db8:${(address >> 16).toString(16)}:${(address & 0xffff).toString(16)}::`, 60, 60);
      }
    }
    expect(address).toBe(60 * PER_MINUTE);
    // A one minute counter goes a minute after its window ends, and a run comes every two minutes:
    // never more than four minutes of visitors are stored (here about three), not the hour's 72,000.
    expect(most).toBeLessThanOrEqual(4 * PER_MINUTE);
    expect(most).toBeGreaterThan(2 * PER_MINUTE);

    // The flood stops. Two more runs and nothing is left.
    const after: number[] = [];
    for (let i = 0; i < 2; i++) {
      ctx.clock.set(Math.max(ctx.now().getTime(), startMs + HOUR + i * 2 * MINUTE));
      await run();
      after.push(await counters());
    }
    expect(after[after.length - 1]).toBe(0);
  });
});
