import { beforeEach, describe, expect, it } from 'vitest';
import type { Host, HostGoogle } from '../../shared/types';
import { getBusyForHosts, getHostBusy, syncHostTimezone } from '../../server/lib/busy';
import { seal } from '../../server/lib/crypto';
import { getHost, getSite, saveHost, saveSecrets, updateHost } from '../../server/lib/repo';
import type { Interval } from '../../server/lib/time';
import { makeTestCtx, type TestCtx } from '../helpers/ctx';

// ───────────────────────── fake network ─────────────────────────

interface Call {
  url: string;
  method: string;
  body: string;
}

type Handler = (call: Call) => Response | Promise<Response>;

function useFetch(ctx: TestCtx, handler: Handler): Call[] {
  const calls: Call[] = [];
  ctx.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), body: typeof init?.body === 'string' ? init.body : '' };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const TIMEZONE_URL = 'https://www.googleapis.com/calendar/v3/users/me/settings/timezone';
const WORK_FEED = 'https://calendar.example.org/private/WORK-FEED-SECRET/basic.ics';
const HOME_FEED = 'https://feeds.example.net/HOME-FEED-SECRET.ics';
const OWNER = 'host_owner';

const ms = (iso: string): number => Date.parse(iso);
const iv = (start: string, end: string): Interval => ({ start: ms(start), end: ms(end) });
const WEEK: Interval = iv('2026-11-16T00:00:00Z', '2026-11-23T00:00:00Z');

function ics(...events: [string, string][]): string {
  const body = events.map(([start, end], i) => `BEGIN:VEVENT\r\nUID:e${i}\r\nDTSTART:${start}\r\nDTEND:${end}\r\nEND:VEVENT\r\n`).join('');
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}END:VCALENDAR\r\n`;
}

function icsResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/calendar' } });
}

/** Google answers with the given busy blocks; the two feeds answer with theirs. */
function network(opts: { google?: [string, string][]; work?: [string, string][]; home?: [string, string][]; zone?: unknown } = {}): Handler {
  return (call) => {
    if (call.url === TOKEN_URL) return jsonResponse({ access_token: 'access-1', expires_in: 3599, token_type: 'Bearer' });
    if (call.url === FREEBUSY_URL) {
      return jsonResponse({ calendars: { primary: { busy: (opts.google ?? []).map(([start, end]) => ({ start, end })) } } });
    }
    if (call.url === TIMEZONE_URL) return jsonResponse({ kind: 'calendar#setting', id: 'timezone', value: opts.zone ?? 'Europe/Lisbon' });
    if (call.url === WORK_FEED) return icsResponse(ics(...(opts.work ?? [])));
    if (call.url === HOME_FEED) return icsResponse(ics(...(opts.home ?? [])));
    return new Response('not found', { status: 404 });
  };
}

function googleConnection(ctx: TestCtx, over: Partial<HostGoogle> = {}): HostGoogle {
  return {
    email: 'jimi@example.com',
    refreshTokenEnc: seal(ctx, 'google-refresh', 'refresh-token-1'),
    scopes: [],
    busyCalendarIds: ['primary'],
    writeCalendarId: 'primary',
    gmailSend: false,
    status: 'ok',
    connectedAt: ctx.now().toISOString(),
    ...over,
  };
}

async function setHost(ctx: TestCtx, change: (h: Host) => Host, id = OWNER): Promise<Host> {
  const saved = await updateHost(ctx, id, change);
  if (!saved) throw new Error('host missing');
  return saved;
}

function feed(ctx: TestCtx, id: string, label: string, url: string): Host['icsFeeds'][number] {
  return { id, label, urlEnc: seal(ctx, 'ics-url', url) };
}

let ctx: TestCtx;
beforeEach(async () => {
  ctx = makeTestCtx();
  await getSite(ctx);
  await saveSecrets(ctx, { google: { clientId: 'client-id', clientSecret: 'client-secret' } });
});

// ───────────────────────── getHostBusy ─────────────────────────

describe('getHostBusy', () => {
  it('is empty and healthy for a host without any calendar', async () => {
    const calls = useFetch(ctx, network());
    const host = (await getHost(ctx, OWNER)) as Host;
    expect(await getHostBusy(ctx, host, WEEK)).toEqual({ hostId: OWNER, busy: [], ok: true });
    expect(calls).toHaveLength(0);
    expect((await getHost(ctx, OWNER))?.updatedAt).toBe(host.updatedAt);
  });

  it('merges Google free/busy with every feed', async () => {
    const host = await setHost(ctx, (h) => ({
      ...h,
      timezone: 'Africa/Nairobi',
      google: googleConnection(ctx),
      icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED), feed(ctx, 'f2', 'Home', HOME_FEED)],
    }));
    const calls = useFetch(
      ctx,
      network({
        google: [['2026-11-17T10:00:00Z', '2026-11-17T11:00:00Z']],
        work: [
          ['20261117T103000Z', '20261117T120000Z'],
          ['20261118T080000Z', '20261118T083000Z'],
        ],
        home: [['20261119T170000Z', '20261119T180000Z']],
      }),
    );
    const result = await getHostBusy(ctx, host, WEEK);
    expect(result).toEqual({
      hostId: OWNER,
      ok: true,
      busy: [
        iv('2026-11-17T10:00:00Z', '2026-11-17T12:00:00Z'),
        iv('2026-11-18T08:00:00Z', '2026-11-18T08:30:00Z'),
        iv('2026-11-19T17:00:00Z', '2026-11-19T18:00:00Z'),
      ],
    });
    expect(calls.map((c) => c.url).sort()).toEqual([WORK_FEED, HOME_FEED, TOKEN_URL, FREEBUSY_URL].sort());
    expect((await getHost(ctx, OWNER))?.calendarHealth).toEqual({ ok: true, at: ctx.now().toISOString() });
  });

  it('blocks all-day feed events for the host\'s local day', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, timezone: 'America/Los_Angeles', icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED)] }));
    useFetch(ctx, () => icsResponse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;VALUE=DATE:20261118\r\nDTEND;VALUE=DATE:20261119\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'));
    expect((await getHostBusy(ctx, host, WEEK)).busy).toEqual([iv('2026-11-18T08:00:00Z', '2026-11-19T08:00:00Z')]);
  });

  it('serves a cached answer for 60 seconds and refetches when asked for a fresh one', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED)] }));
    let block: [string, string] = ['20261117T100000Z', '20261117T110000Z'];
    const calls = useFetch(ctx, () => icsResponse(ics(block)));

    const first = await getHostBusy(ctx, host, WEEK);
    expect(first.busy).toEqual([iv('2026-11-17T10:00:00Z', '2026-11-17T11:00:00Z')]);
    expect(calls).toHaveLength(1);

    block = ['20261117T140000Z', '20261117T150000Z'];
    ctx.clock.advance(59_000);
    expect(await getHostBusy(ctx, host, WEEK)).toEqual(first);
    expect(calls).toHaveLength(1);

    // another range is another cache entry
    await getHostBusy(ctx, host, { start: WEEK.start, end: WEEK.end + 86_400_000 });
    expect(calls).toHaveLength(2);

    const fresh = await getHostBusy(ctx, host, WEEK, { fresh: true });
    expect(fresh.busy).toEqual([iv('2026-11-17T14:00:00Z', '2026-11-17T15:00:00Z')]);
    expect(calls).toHaveLength(3);
    // the fresh answer replaced the cached one
    expect((await getHostBusy(ctx, host, WEEK)).busy).toEqual(fresh.busy);
    expect(calls).toHaveLength(3);

    ctx.clock.advance(61_000);
    await getHostBusy(ctx, host, WEEK);
    expect(calls).toHaveLength(4);
  });

  it('does not serve a cached answer after the calendar setup changed', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED)] }));
    const calls = useFetch(ctx, network({ work: [['20261117T100000Z', '20261117T110000Z']], home: [['20261118T100000Z', '20261118T110000Z']] }));
    expect((await getHostBusy(ctx, host, WEEK)).busy).toHaveLength(1);
    const changed = await setHost(ctx, (h) => ({ ...h, icsFeeds: [...h.icsFeeds, feed(ctx, 'f2', 'Home', HOME_FEED)] }));
    expect((await getHostBusy(ctx, changed, WEEK)).busy).toHaveLength(2);
    expect(calls).toHaveLength(3);
  });

  it('reports a failing feed, keeps what it could read and records the health once', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, google: googleConnection(ctx), icsFeeds: [feed(ctx, 'f1', 'Work "main"', WORK_FEED)] }));
    useFetch(ctx, (call) => (call.url === WORK_FEED ? new Response('gone', { status: 404 }) : network({ google: [['2026-11-17T10:00:00Z', '2026-11-17T11:00:00Z']] })(call)));

    const result = await getHostBusy(ctx, host, WEEK);
    expect(result.ok).toBe(false);
    expect(result.busy).toEqual([iv('2026-11-17T10:00:00Z', '2026-11-17T11:00:00Z')]);
    expect(result.error).toMatch(/^Calendar feed "Work main": /);
    expect(result.error).not.toContain('WORK-FEED-SECRET');
    expect(result.error).not.toContain('calendar.example.org');

    const afterFirst = (await getHost(ctx, OWNER)) as Host;
    expect(afterFirst.calendarHealth).toEqual({ ok: false, message: result.error, at: ctx.now().toISOString() });

    // same verdict again: nothing is written
    ctx.clock.advance(5 * 60_000);
    const again = await getHostBusy(ctx, afterFirst, WEEK, { fresh: true });
    expect(again.ok).toBe(false);
    const afterSecond = (await getHost(ctx, OWNER)) as Host;
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);
    expect(afterSecond.calendarHealth?.at).toBe(afterFirst.calendarHealth?.at);

    // the feed comes back: health flips to ok
    useFetch(ctx, network({ work: [] }));
    const recovered = await getHostBusy(ctx, afterSecond, WEEK, { fresh: true });
    expect(recovered).toEqual({ hostId: OWNER, busy: [], ok: true });
    expect((await getHost(ctx, OWNER))?.calendarHealth).toEqual({ ok: true, at: ctx.now().toISOString() });
    expect(JSON.stringify(ctx.logs)).not.toContain('WORK-FEED-SECRET');
  });

  it('remembers a failure only briefly', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED)] }));
    const calls = useFetch(ctx, () => new Response('down', { status: 503 }));
    expect((await getHostBusy(ctx, host, WEEK)).ok).toBe(false);
    ctx.clock.advance(10_000);
    const cached = await getHostBusy(ctx, host, WEEK);
    expect(cached.ok).toBe(false);
    expect(cached.error).toMatch(/Calendar feed "Work"/);
    expect(calls).toHaveLength(1);
    ctx.clock.advance(6_000);
    await getHostBusy(ctx, host, WEEK);
    expect(calls).toHaveLength(2);
  });

  it('fails without touching the network when Google needs a reconnect', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, google: googleConnection(ctx, { status: 'needs_reconnect' }) }));
    const calls = useFetch(ctx, network());
    const result = await getHostBusy(ctx, host, WEEK);
    expect(result).toEqual({ hostId: OWNER, busy: [], ok: false, error: 'Google Calendar needs to be reconnected.' });
    expect(calls).toHaveLength(0);
    expect((await getHost(ctx, OWNER))?.calendarHealth).toMatchObject({ ok: false, message: 'Google Calendar needs to be reconnected.' });
  });

  it('turns a revoked Google grant into a failed result and marks the host', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, google: googleConnection(ctx) }));
    useFetch(ctx, () => jsonResponse({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    const result = await getHostBusy(ctx, host, WEEK);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Google Calendar needs to be reconnected.');
    const stored = await getHost(ctx, OWNER);
    expect(stored?.google?.status).toBe('needs_reconnect');
    expect(stored?.calendarHealth?.ok).toBe(false);
  });

  it('fails when Google reports an unreadable calendar', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, google: googleConnection(ctx) }));
    useFetch(ctx, (call) =>
      call.url === TOKEN_URL ? jsonResponse({ access_token: 'a', expires_in: 3599 }) : jsonResponse({ calendars: { primary: { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] } } }),
    );
    const result = await getHostBusy(ctx, host, WEEK);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/notFound/);
  });

  it('fails when a stored feed address cannot be decrypted, without a request', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, icsFeeds: [{ id: 'f1', label: 'Old', urlEnc: 'v1.garbage' }] }));
    const calls = useFetch(ctx, network());
    const result = await getHostBusy(ctx, host, WEEK);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Calendar feed "Old" needs to be added again/);
    expect(calls).toHaveLength(0);
  });

  it('fails when a stored feed address is no longer acceptable', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, icsFeeds: [feed(ctx, 'f1', 'Intranet', 'https://10.0.0.5/cal.ics')] }));
    const calls = useFetch(ctx, network());
    const result = await getHostBusy(ctx, host, WEEK);
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('10.0.0.5');
    expect(calls).toHaveLength(0);
  });

  it('clears a stale failure once a host has no calendars left', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, calendarHealth: { ok: false, message: 'old problem', at: '2026-11-01T00:00:00.000Z' } }));
    expect(await getHostBusy(ctx, host, WEEK)).toEqual({ hostId: OWNER, busy: [], ok: true });
    expect((await getHost(ctx, OWNER))?.calendarHealth ?? null).toBeNull();
  });

  it('never throws, even when storage fails underneath it', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED)] }));
    useFetch(ctx, network());
    const broken: TestCtx = { ...ctx, kv: { ...ctx.kv, getJSON: () => Promise.reject(new Error('storage offline')) } };
    expect(await getHostBusy(broken, host, WEEK)).toEqual({ hostId: OWNER, busy: [], ok: false, error: 'Calendar could not be read.' });
  });
});

// ───────────────────────── getBusyForHosts ─────────────────────────

describe('getBusyForHosts', () => {
  it('answers per host, in order, and one host\'s failure does not affect the other', async () => {
    const owner = await setHost(ctx, (h) => ({ ...h, icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED)] }));
    const cohost = await saveHost(ctx, {
      ...owner,
      id: 'host_alex',
      role: 'member',
      name: 'Alex',
      email: 'alex@example.com',
      google: null,
      icsFeeds: [feed(ctx, 'f2', 'Home', HOME_FEED)],
      calendarHealth: null,
    });
    const nobody = await saveHost(ctx, { ...owner, id: 'host_sam', role: 'member', name: 'Sam', email: 'sam@example.com', icsFeeds: [] });
    useFetch(ctx, (call) => (call.url === HOME_FEED ? new Response('nope', { status: 500 }) : network({ work: [['20261117T100000Z', '20261117T110000Z']] })(call)));

    const results = await getBusyForHosts(ctx, [cohost, owner, nobody], WEEK, { fresh: true });
    expect(results.map((r) => r.hostId)).toEqual(['host_alex', OWNER, 'host_sam']);
    expect(results[0].ok).toBe(false);
    expect(results[1]).toEqual({ hostId: OWNER, ok: true, busy: [iv('2026-11-17T10:00:00Z', '2026-11-17T11:00:00Z')] });
    expect(results[2]).toEqual({ hostId: 'host_sam', ok: true, busy: [] });

    // both health updates landed although they were written at the same time
    expect((await getHost(ctx, 'host_alex'))?.calendarHealth?.ok).toBe(false);
    expect((await getHost(ctx, OWNER))?.calendarHealth?.ok).toBe(true);
    expect(await getBusyForHosts(ctx, [], WEEK)).toEqual([]);
  });
});

// ───────────────────────── syncHostTimezone ─────────────────────────

describe('syncHostTimezone', () => {
  it('follows the Google Calendar zone when the host asked for that', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, timezone: 'UTC', timezoneMode: 'google', google: googleConnection(ctx) }));
    const calls = useFetch(ctx, network({ zone: 'Africa/Nairobi' }));
    const synced = await syncHostTimezone(ctx, host);
    expect(synced.timezone).toBe('Africa/Nairobi');
    expect((await getHost(ctx, OWNER))?.timezone).toBe('Africa/Nairobi');
    expect(calls.some((c) => c.url === TIMEZONE_URL)).toBe(true);

    // unchanged zone: no write
    const before = (await getHost(ctx, OWNER)) as Host;
    const same = await syncHostTimezone(ctx, before);
    expect(same).toBe(before);
    expect((await getHost(ctx, OWNER))?.updatedAt).toBe(before.updatedAt);
  });

  it.each(['device', 'fixed'] as const)('leaves a host in %s mode alone', async (mode) => {
    const host = await setHost(ctx, (h) => ({ ...h, timezone: 'UTC', timezoneMode: mode, google: googleConnection(ctx) }));
    const calls = useFetch(ctx, network({ zone: 'Africa/Nairobi' }));
    expect(await syncHostTimezone(ctx, host)).toBe(host);
    expect(calls).toHaveLength(0);
  });

  it('does nothing without a working Google connection', async () => {
    const calls = useFetch(ctx, network());
    const unconnected = await setHost(ctx, (h) => ({ ...h, timezoneMode: 'google', google: null }));
    expect(await syncHostTimezone(ctx, unconnected)).toBe(unconnected);
    const broken = await setHost(ctx, (h) => ({ ...h, timezoneMode: 'google', google: googleConnection(ctx, { status: 'needs_reconnect' }) }));
    expect(await syncHostTimezone(ctx, broken)).toBe(broken);
    expect(calls).toHaveLength(0);
  });

  it('ignores a zone it does not know and survives a failing request', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, timezone: 'Europe/London', timezoneMode: 'google', google: googleConnection(ctx) }));
    useFetch(ctx, network({ zone: 'Atlantis/Central' }));
    expect((await syncHostTimezone(ctx, host)).timezone).toBe('Europe/London');
    useFetch(ctx, (call) => (call.url === TOKEN_URL ? jsonResponse({ access_token: 'a', expires_in: 3599 }) : jsonResponse({ error: { code: 400, message: 'bad' } }, 400)));
    expect(await syncHostTimezone(ctx, host)).toBe(host);
    expect((await getHost(ctx, OWNER))?.timezone).toBe('Europe/London');
  });

  it('does not overwrite a mode the host changed in the meantime', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, timezone: 'UTC', timezoneMode: 'google', google: googleConnection(ctx) }));
    useFetch(ctx, network({ zone: 'Africa/Nairobi' }));
    await setHost(ctx, (h) => ({ ...h, timezoneMode: 'fixed', timezone: 'Asia/Tokyo' }));
    const result = await syncHostTimezone(ctx, host); // called with the stale copy
    expect(result.timezone).toBe('Asia/Tokyo');
    expect((await getHost(ctx, OWNER))?.timezone).toBe('Asia/Tokyo');
  });
});
