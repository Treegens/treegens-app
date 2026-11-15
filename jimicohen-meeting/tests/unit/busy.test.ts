import { beforeEach, describe, expect, it } from 'vitest';
import type { Host, HostGoogle } from '../../shared/types';
import { forgetHostBusy, getBusyForHosts, getHostBusy, syncHostTimezone } from '../../server/lib/busy';
import { seal } from '../../server/lib/crypto';
import { getHost, getSite, saveHost, saveSecrets, updateHost } from '../../server/lib/repo';
import type { Interval } from '../../server/lib/time';
import { makeTestCtx, type TestCtx } from '../helpers/ctx';
import { mainOf } from '../../server/lib/googleAccounts';

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
    sub: `sub-${over.email ?? 'jimi@example.com'}`,
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

  it('serves a cached answer for 60 seconds, and a fresh read asks the calendar itself', async () => {
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

    // Another range inside the same fixed block is the same cache entry.
    expect((await getHostBusy(ctx, host, { start: WEEK.start, end: WEEK.end + 86_400_000 })).busy).toEqual(first.busy);
    expect(calls).toHaveLength(1);

    // A booking reads its own range afresh.
    const fresh = await getHostBusy(ctx, host, WEEK, { fresh: true });
    expect(fresh.busy).toEqual([iv('2026-11-17T14:00:00Z', '2026-11-17T15:00:00Z')]);
    expect(calls).toHaveLength(2);

    ctx.clock.advance(2_000);
    expect((await getHostBusy(ctx, host, WEEK)).busy).toEqual(fresh.busy);
    // The download the fresh read made was kept, so the expired block was rebuilt without a new request.
    expect(calls).toHaveLength(2);
    ctx.clock.advance(61_000);
    await getHostBusy(ctx, host, WEEK);
    expect(calls).toHaveLength(3);
  });

  it('cuts every answer out of the same fixed blocks, so varied ranges cost the calendars nothing more', async () => {
    const host = await setHost(ctx, (h) => ({
      ...h,
      google: googleConnection(ctx),
      icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED)],
    }));
    const calls = useFetch(
      ctx,
      network({
        google: [['2026-11-20T10:00:00Z', '2026-11-20T11:00:00Z'], ['2026-12-28T10:00:00Z', '2026-12-28T11:00:00Z']],
        work: [['20261125T080000Z', '20261125T090000Z'], ['20270105T080000Z', '20270105T090000Z']],
      }),
    );
    const DAY = 86_400_000;
    const start = ms('2026-11-15T00:00:00Z');
    // What the security review did: one visitor, 240 different day ranges in a minute, up to 62 days long.
    for (let i = 0; i < 240; i++) {
      const from = start + (i % 40) * DAY;
      const result = await getHostBusy(ctx, host, { start: from, end: from + (1 + ((i * 7) % 62)) * DAY });
      expect(result.ok).toBe(true);
      // Always exactly what lies inside the range asked for.
      for (const b of result.busy) {
        expect(b.start).toBeGreaterThanOrEqual(from);
        expect(b.end).toBeLessThanOrEqual(from + (1 + ((i * 7) % 62)) * DAY);
      }
      ctx.clock.advance(200);
    }
    const blocks = Math.ceil((40 + 62) / 31) + 1;
    expect(calls.filter((c) => c.url === FREEBUSY_URL).length).toBeLessThanOrEqual(blocks);
    // The feed's server is asked once, however many blocks were read from it.
    expect(calls.filter((c) => c.url === WORK_FEED)).toHaveLength(1);
    // Storage holds a handful of entries for the host, not one per range.
    const keys = await ctx.kv.list(`cache/busy-${OWNER}-`);
    expect(keys.length).toBeLessThanOrEqual(blocks + 1);

    // A range that spans several blocks is stitched together from them.
    const wide = await getHostBusy(ctx, host, { start: ms('2026-11-16T00:00:00Z'), end: ms('2027-01-10T00:00:00Z') });
    expect(wide.busy).toEqual([
      iv('2026-11-20T10:00:00Z', '2026-11-20T11:00:00Z'),
      iv('2026-11-25T08:00:00Z', '2026-11-25T09:00:00Z'),
      iv('2026-12-28T10:00:00Z', '2026-12-28T11:00:00Z'),
      iv('2027-01-05T08:00:00Z', '2027-01-05T09:00:00Z'),
    ]);
  });

  it('reads the blocks a range needs in one go, and asks Google for the whole block', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, google: googleConnection(ctx) }));
    const calls = useFetch(ctx, network({ google: [['2026-11-17T10:00:00Z', '2026-11-17T11:00:00Z']] }));
    expect((await getHostBusy(ctx, host, WEEK)).busy).toEqual([iv('2026-11-17T10:00:00Z', '2026-11-17T11:00:00Z')]);
    const asked = calls.filter((c) => c.url === FREEBUSY_URL).map((c) => JSON.parse(c.body));
    expect(asked).toHaveLength(1);
    // Block 670 since 1 January 1970: 13 November to 14 December 2026, the same for every visitor.
    expect(asked[0]).toMatchObject({ timeMin: '2026-11-13T00:00:00.000Z', timeMax: '2026-12-14T00:00:00.000Z' });
  });

  it('keeps a downloaded feed for a minute whatever range it is read for, sealed', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED)] }));
    const calls = useFetch(ctx, network({ work: [['20261117T100000Z', '20261117T110000Z']] }));
    await getHostBusy(ctx, host, WEEK);
    // A range in another block needs that block read, but not the feed downloaded again.
    await getHostBusy(ctx, host, { start: ms('2027-02-01T00:00:00Z'), end: ms('2027-02-08T00:00:00Z') });
    expect(calls.filter((c) => c.url === WORK_FEED)).toHaveLength(1);
    const stored = JSON.stringify(await Promise.all((await ctx.kv.list('cache/')).map((k) => ctx.kv.getJSON(k))));
    expect(stored).not.toContain('VCALENDAR');
    expect(stored).not.toContain('WORK-FEED-SECRET');
    expect((await ctx.kv.list('cache/')).join(' ')).not.toContain('WORK-FEED-SECRET');
    ctx.clock.advance(61_000);
    await getHostBusy(ctx, host, { start: ms('2027-03-01T00:00:00Z'), end: ms('2027-03-08T00:00:00Z') });
    expect(calls.filter((c) => c.url === WORK_FEED)).toHaveLength(2);
  });

  it('forgets every cached block and kept feed of a host on request, and only of that host', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED)] }));
    await saveHost(ctx, { ...host, id: 'host_other', role: 'member', icsFeeds: [feed(ctx, 'f2', 'Home', HOME_FEED)] });
    const other = (await getHost(ctx, 'host_other')) as Host;
    let block: [string, string] = ['20261117T100000Z', '20261117T110000Z'];
    const calls = useFetch(ctx, () => icsResponse(ics(block)));
    const later: Interval = { start: ms('2027-01-04T00:00:00Z'), end: ms('2027-01-11T00:00:00Z') };

    await getHostBusy(ctx, host, WEEK);
    await getHostBusy(ctx, host, later);
    await getHostBusy(ctx, other, WEEK);
    expect(calls).toHaveLength(2);

    // The calendar changed, and a booking found out the hard way.
    block = ['20261117T140000Z', '20261117T150000Z'];
    await forgetHostBusy(ctx, [OWNER, OWNER, '']);
    expect(await ctx.kv.list(`cache/busy-${OWNER}-`)).toEqual([]);
    expect((await getHostBusy(ctx, host, WEEK)).busy).toEqual([iv('2026-11-17T14:00:00Z', '2026-11-17T15:00:00Z')]);
    expect(calls).toHaveLength(3);
    // The other host's remembered answer was left alone.
    expect((await getHostBusy(ctx, other, WEEK)).busy).toEqual([iv('2026-11-17T10:00:00Z', '2026-11-17T11:00:00Z')]);
    expect(calls).toHaveLength(3);
  });

  it('never throws when the remembered answers cannot be dropped', async () => {
    const broken = makeTestCtx();
    broken.kv.list = async () => {
      throw new Error('storage down');
    };
    await expect(forgetHostBusy(broken, [OWNER])).resolves.toBeUndefined();
  });

  it('does not serve a cached answer after the calendar setup changed', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED)] }));
    const calls = useFetch(ctx, network({ work: [['20261117T100000Z', '20261117T110000Z']], home: [['20261118T100000Z', '20261118T110000Z']] }));
    expect((await getHostBusy(ctx, host, WEEK)).busy).toHaveLength(1);
    const changed = await setHost(ctx, (h) => ({ ...h, icsFeeds: [...h.icsFeeds, feed(ctx, 'f2', 'Home', HOME_FEED)] }));
    expect((await getHostBusy(ctx, changed, WEEK)).busy).toHaveLength(2);
    // Only the new feed had to be downloaded: the other one was kept from a moment ago.
    expect(calls.map((c) => c.url)).toEqual([WORK_FEED, HOME_FEED]);
    // A host who moved to another zone gets an answer for that zone (all-day and floating times depend on it).
    const moved = await setHost(ctx, (h) => ({ ...h, timezone: 'Pacific/Auckland' }));
    expect(await getHostBusy(ctx, moved, WEEK)).toMatchObject({ ok: true });
    expect((await ctx.kv.list(`cache/busy-${OWNER}-b`)).length).toBe(3);
  });

  it('reads floating feed times in the host\'s zone', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, timezone: 'Africa/Nairobi', icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED)] }));
    useFetch(ctx, () => icsResponse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261118T090000\r\nDTEND:20261118T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'));
    expect((await getHostBusy(ctx, host, WEEK)).busy).toEqual([iv('2026-11-18T06:00:00Z', '2026-11-18T07:00:00Z')]);
  });

  it('fails closed for a feed with a busy repeating event it could not read', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, icsFeeds: [feed(ctx, 'f1', 'Work', WORK_FEED)] }));
    useFetch(ctx, () => icsResponse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261116T090000Z\r\nDTEND:20261116T100000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=XX\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'));
    const result = await getHostBusy(ctx, host, WEEK);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Calendar feed "Work": The calendar feed has a repeating event that could not be read.');
    expect((await getHost(ctx, OWNER))?.calendarHealth).toMatchObject({ ok: false, message: result.error });
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
    // The account is named: a host can have several.
    const id = mainOf(host)!.account.id;
    expect(result).toEqual({
      hostId: OWNER,
      busy: [],
      ok: false,
      error: 'jimi@example.com: Google Calendar needs to be reconnected.',
      problems: [{ key: id, label: 'jimi@example.com', message: 'Google Calendar needs to be reconnected.', accountId: id }],
    });
    expect(calls).toHaveLength(0);
    expect((await getHost(ctx, OWNER))?.calendarHealth).toMatchObject({ ok: false, message: 'jimi@example.com: Google Calendar needs to be reconnected.' });
  });

  it('turns a revoked Google grant into a failed result and marks the host', async () => {
    const host = await setHost(ctx, (h) => ({ ...h, google: googleConnection(ctx) }));
    useFetch(ctx, () => jsonResponse({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    const result = await getHostBusy(ctx, host, WEEK);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('jimi@example.com: Google Calendar needs to be reconnected.');
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
