import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/lib/booking', async () => {
  const { hmacHex } = await import('../../server/lib/crypto');
  return {
    manageToken: (ctx: never, id: string) => hmacHex(ctx, 'manage', id),
    verifyManageToken: vi.fn(() => false),
    cancelBooking: vi.fn(),
    confirmAttendance: vi.fn(),
    rescheduleBooking: vi.fn(),
    createBooking: vi.fn(),
    getSlots: vi.fn(),
    toPublicSite: vi.fn(),
    toPublicEventType: vi.fn(),
    toPublicBooking: vi.fn(),
    syncBookingToCalendar: vi.fn(),
  };
});
vi.mock('../../server/routes/public', () => ({ routes: [] }));
vi.mock('../../server/routes/webhooks', () => ({ routes: [] }));
vi.mock('../../server/cron', () => ({ runScheduled: async () => ({}) }));

import { handle } from '../../server/api';
import { rateLimitKey } from '../../server/lib/auth';
import { open, randomToken, seal, sha256Hex } from '../../server/lib/crypto';
import { GOOGLE_CALENDAR_SCOPES } from '../../server/lib/google';
import * as repo from '../../server/lib/repo';
import type { AdminHost, Host, HostSelfResponse } from '../../shared/types';
import { apiRequest, makeTestCtx, TEST_NOW, type TestCtx } from '../helpers/ctx';

// ───────────────────────── helpers ─────────────────────────

interface Team {
  ctx: TestCtx;
  alex: Host;
  alexToken: string;
  sam: Host;
  samToken: string;
}

async function addMember(ctx: TestCtx, id: string, name: string, email: string): Promise<{ host: Host; token: string }> {
  const token = randomToken(24);
  const host = await repo.saveHost(ctx, {
    id,
    role: 'member',
    name,
    email,
    title: '',
    avatarAssetId: null,
    timezone: 'UTC',
    timezoneMode: 'device',
    schedules: [{ id: 'sch_default', name: 'Working hours', weekly: { 0: [], 1: [{ start: '09:00', end: '17:00' }], 2: [], 3: [], 4: [], 5: [], 6: [] }, overrides: [] }],
    defaultScheduleId: 'sch_default',
    google: null,
    icsFeeds: [],
    inviteTokenHash: sha256Hex(token),
    notify: { email: true, sms: false },
    calendarHealth: null,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  });
  return { host, token };
}

async function team(): Promise<Team> {
  const ctx = makeTestCtx();
  await repo.getSite(ctx);
  const alex = await addMember(ctx, 'host_alex', 'Alex Rivera', 'alex@example.com');
  const sam = await addMember(ctx, 'host_sam', 'Sam Okafor', 'sam@example.com');
  return { ctx, alex: alex.host, alexToken: alex.token, sam: sam.host, samToken: sam.token };
}

function link(hostId: string, token: string | null, suffix = ''): string {
  return `/host/${hostId}${suffix}${token === null ? '' : `?t=${encodeURIComponent(token)}`}`;
}

function get(ctx: TestCtx, path: string): Promise<Response> {
  return handle(apiRequest('GET', path), ctx);
}

function put(ctx: TestCtx, path: string, body: unknown, extra: { headers?: Record<string, string>; origin?: string | null } = {}): Promise<Response> {
  return handle(apiRequest('PUT', path, { body, ...extra }), ctx);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Response | Promise<Response>): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(200);
  return JSON.parse(text) as T;
}

async function connectGoogle(ctx: TestCtx, hostId: string): Promise<void> {
  await repo.updateHost(ctx, hostId, (h) => ({
    ...h,
    google: {
      email: `${hostId}@gmail.example`,
      refreshTokenEnc: seal(ctx, 'google-refresh', 'refresh-token-very-secret'),
      scopes: [...GOOGLE_CALENDAR_SCOPES],
      busyCalendarIds: ['primary'],
      writeCalendarId: 'primary',
      gmailSend: false,
      status: 'ok',
      connectedAt: TEST_NOW,
    },
  }));
}

// ───────────────────────── tests ─────────────────────────

describe('GET /host/:id', () => {
  it('opens the page of the host the link belongs to, and nothing more', async () => {
    const t = await team();
    await repo.saveSecrets(t.ctx, { google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'GOCSPX-super-secret-value' } });
    await connectGoogle(t.ctx, 'host_alex');
    await connectGoogle(t.ctx, 'host_owner');
    await repo.updateHost(t.ctx, 'host_alex', (h) => ({ ...h, icsFeeds: [{ id: 'ics_1', label: 'Work', urlEnc: seal(t.ctx, 'ics-url', 'https://calendar.example.com/private-abc123.ics') }] }));

    const res = await get(t.ctx, link('host_alex', t.alexToken));
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = JSON.parse(text) as HostSelfResponse;
    expect(Object.keys(body).sort()).toEqual(['calendars', 'googleConfigured', 'host', 'siteName', 'theme']);
    expect(body.siteName).toBe('Jimi Cohen');
    expect(body.googleConfigured).toBe(true);
    expect(body.calendars).toBeNull();
    expect(body.theme.preset).toBe('forest');
    expect(body.host).toMatchObject({
      id: 'host_alex',
      role: 'member',
      name: 'Alex Rivera',
      email: 'alex@example.com',
      hasInviteLink: true,
      google: { email: 'host_alex@gmail.example', status: 'ok', busyCalendarIds: ['primary'], writeCalendarId: 'primary', gmailSend: false },
      icsFeeds: [{ id: 'ics_1', label: 'Work' }],
    });

    // Nothing about anyone else, and nothing secret about themselves.
    const stored = (await repo.getHost(t.ctx, 'host_alex'))!;
    for (const forbidden of [
      'host_owner',
      'host_sam',
      'sam@example.com',
      'Sam Okafor',
      t.alexToken,
      t.samToken,
      stored.inviteTokenHash!,
      'inviteTokenHash',
      'refreshTokenEnc',
      stored.google!.refreshTokenEnc,
      'refresh-token-very-secret',
      'urlEnc',
      stored.icsFeeds[0].urlEnc,
      'private-abc123',
      'GOCSPX-super-secret-value',
      'ownerHostId',
    ]) {
      expect(text.includes(forbidden), `leaks ${forbidden.slice(0, 24)}`).toBe(false);
    }
  });

  it('says whether Google can be connected at all', async () => {
    const t = await team();
    expect((await ok<HostSelfResponse>(get(t.ctx, link('host_alex', t.alexToken)))).googleConfigured).toBe(false);
    const viaEnv = makeTestCtx({ kv: t.ctx.kv, env: { overrides: { googleClientId: 'id.apps.googleusercontent.com', googleClientSecret: 'secret-value' } } });
    expect((await ok<HostSelfResponse>(get(viaEnv, link('host_alex', t.alexToken)))).googleConfigured).toBe(true);
  });

  it('gives the same 404 for a wrong token, another host\'s token, no token, and a host that does not exist', async () => {
    const t = await team();
    const attempts = [
      link('host_alex', 'wrong-token-wrong-token-wrong-token'),
      link('host_alex', t.samToken),
      link('host_sam', t.alexToken),
      link('host_alex', null),
      link('host_alex', ''),
      link('host_alex', 'short'),
      link('host_alex', sha256Hex(t.alexToken)),
      link('host_nobody', t.alexToken),
      link('host_owner', t.alexToken),
      link('host_owner', null),
      link('host_alex', t.alexToken, '/calendars').replace(t.alexToken, t.samToken),
    ];
    const bodies = new Set<string>();
    for (const path of attempts) {
      const res = await get(t.ctx, path);
      expect(res.status, path).toBe(404);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0]).error.code).toBe('not_found');
  });

  it('stops working when the link is replaced', async () => {
    const t = await team();
    expect((await get(t.ctx, link('host_alex', t.alexToken))).status).toBe(200);
    const fresh = randomToken(24);
    await repo.updateHost(t.ctx, 'host_alex', (h) => ({ ...h, inviteTokenHash: sha256Hex(fresh) }));
    expect((await get(t.ctx, link('host_alex', t.alexToken))).status).toBe(404);
    expect((await get(t.ctx, link('host_alex', fresh))).status).toBe(200);
  });

  it('slows down someone hammering the links', async () => {
    const t = await team();
    await t.ctx.kv.setJSON(rateLimitKey(t.ctx, 'host-link', t.ctx.ip ?? 'unknown', 600).key, { n: 120 });
    const res = await get(t.ctx, link('host_alex', t.alexToken));
    expect(res.status).toBe(429);
    // Other visitors are not affected.
    expect((await get(makeTestCtx({ kv: t.ctx.kv, ip: '198.51.100.20' }), link('host_alex', t.alexToken))).status).toBe(200);
  });
});

describe('PUT /host/:id', () => {
  it('lets a co-host set their own name, hours, zone and notifications', async () => {
    const t = await team();
    const res = await ok<{ host: AdminHost; timezone: string; timezoneChanged: boolean }>(
      put(t.ctx, link('host_alex', t.alexToken), {
        name: ' Alexandra  Rivera ',
        title: 'Head of Partnerships',
        phone: '+1 415 555 2671',
        deviceTimezone: 'Europe/Berlin',
        notify: { email: true, sms: true },
        schedules: [{ id: 'sch_default', name: 'My hours', weekly: { 2: [{ start: '10:00', end: '16:00' }] }, overrides: [{ date: '2026-12-24', ranges: [] }] }],
        defaultScheduleId: 'sch_default',
      }),
    );
    expect(res).toMatchObject({ timezone: 'Europe/Berlin', timezoneChanged: true });
    expect(res.host).toMatchObject({ name: 'Alexandra Rivera', title: 'Head of Partnerships', phone: '+14155552671', timezone: 'Europe/Berlin', notify: { email: true, sms: true } });
    expect(res.host.schedules[0].weekly[2]).toEqual([{ start: '10:00', end: '16:00' }]);
    expect(res.host.schedules[0].weekly[1]).toEqual([]);
    const stored = (await repo.getHost(t.ctx, 'host_alex'))!;
    expect(stored.name).toBe('Alexandra Rivera');
    expect(stored.schedules[0].overrides).toEqual([{ date: '2026-12-24', ranges: [] }]);
    // Sam is untouched.
    expect(await repo.getHost(t.ctx, 'host_sam')).toEqual(t.sam);
  });

  it('never changes the role, the email address, the photo or the link itself', async () => {
    const t = await team();
    await t.ctx.kv.setBlob('assets/ast_somebodyelse00000', new Uint8Array([1, 2, 3]), { contentType: 'image/png', purpose: 'avatar' });
    const res = await ok<{ host: AdminHost }>(
      put(t.ctx, link('host_alex', t.alexToken), {
        role: 'owner',
        email: 'attacker@evil.example',
        avatarAssetId: 'ast_somebodyelse00000',
        inviteTokenHash: sha256Hex('a-token-of-my-own-choosing-000000'),
        id: 'host_owner',
        google: { email: 'x@evil.example', status: 'ok' },
        createdAt: '2000-01-01T00:00:00.000Z',
        title: 'Still just a co-host',
      }),
    );
    expect(res.host).toMatchObject({ id: 'host_alex', role: 'member', email: 'alex@example.com', avatarAssetId: null, google: null, title: 'Still just a co-host' });
    const stored = (await repo.getHost(t.ctx, 'host_alex'))!;
    expect(stored.role).toBe('member');
    expect(stored.email).toBe('alex@example.com');
    expect(stored.inviteTokenHash).toBe(sha256Hex(t.alexToken));
    expect(stored.createdAt).toBe(TEST_NOW);
    expect((await repo.getHost(t.ctx, 'host_owner'))!.role).toBe('owner');
    expect(await repo.listHosts(t.ctx)).toHaveLength(3);
  });

  it('follows the device zone only while the mode says so', async () => {
    const t = await team();
    const path = link('host_alex', t.alexToken);
    expect(await ok(put(t.ctx, path, { deviceTimezone: 'Asia/Tokyo' }))).toMatchObject({ timezone: 'Asia/Tokyo', timezoneChanged: true });
    expect(await ok(put(t.ctx, path, { deviceTimezone: 'Asia/Tokyo' }))).toMatchObject({ timezone: 'Asia/Tokyo', timezoneChanged: false });
    expect(await ok(put(t.ctx, path, { timezoneMode: 'fixed', timezone: 'Europe/London' }))).toMatchObject({ timezone: 'Europe/London', timezoneChanged: true });
    expect(await ok(put(t.ctx, path, { deviceTimezone: 'Asia/Tokyo' }))).toMatchObject({ timezone: 'Europe/London', timezoneChanged: false });
    expect(await ok(put(t.ctx, path, { timezoneMode: 'device', deviceTimezone: 'Africa/Nairobi' }))).toMatchObject({ timezone: 'Africa/Nairobi', timezoneChanged: true });
    // Following Google needs a connected calendar.
    const res = await put(t.ctx, path, { timezoneMode: 'google' });
    expect(res.status).toBe(422);
    expect(Object.keys((await res.json()).error.fields)).toEqual(['timezoneMode']);
  });

  it('validates like the dashboard does', async () => {
    const t = await team();
    const res = await put(t.ctx, link('host_alex', t.alexToken), {
      name: '',
      phone: 'call me',
      timezone: 'Not/AZone',
      schedules: [{ id: 'sch_default', name: 'Hours', weekly: { 1: [{ start: '12:00', end: '09:00' }] } }],
      addIcsFeed: { label: 'Internal', url: 'https://10.0.0.5/calendar.ics' },
    });
    expect(res.status).toBe(422);
    expect(Object.keys((await res.json()).error.fields).sort()).toEqual(['addIcsFeed.url', 'name', 'phone', 'schedules.0.weekly.1', 'timezone']);
    expect(await repo.getHost(t.ctx, 'host_alex')).toEqual(t.alex);
  });

  it('links and removes a calendar feed without echoing its address', async () => {
    const t = await team();
    const path = link('host_alex', t.alexToken);
    const res = await put(t.ctx, path, { addIcsFeed: { label: 'Outlook', url: 'webcal://outlook.example.com/owa/calendar/private-xyz/reachcalendar.ics' } });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).not.toContain('private-xyz');
    const host = JSON.parse(text).host as AdminHost;
    expect(host.icsFeeds).toEqual([{ id: host.icsFeeds[0].id, label: 'Outlook' }]);
    const stored = (await repo.getHost(t.ctx, 'host_alex'))!;
    expect(open(t.ctx, 'ics-url', stored.icsFeeds[0].urlEnc)).toBe('https://outlook.example.com/owa/calendar/private-xyz/reachcalendar.ics');

    const removed = await ok<{ host: AdminHost }>(put(t.ctx, path, { removeIcsFeedId: host.icsFeeds[0].id }));
    expect(removed.host.icsFeeds).toEqual([]);
  });

  it('refuses cross-site requests even with a valid link', async () => {
    const t = await team();
    const path = link('host_alex', t.alexToken);
    for (const extra of [{ origin: 'https://evil.example' }, { origin: null }, { headers: { 'x-requested-with': '' } }]) {
      const res = await put(t.ctx, path, { name: 'Changed by a stranger' }, extra);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('csrf');
    }
    expect((await repo.getHost(t.ctx, 'host_alex'))!.name).toBe('Alex Rivera');
  });

  it('needs the right link for the right person', async () => {
    const t = await team();
    for (const path of [link('host_sam', t.alexToken), link('host_alex', null), link('host_owner', t.alexToken), link('host_alex', 'x'.repeat(40))]) {
      expect((await put(t.ctx, path, { name: 'Nope' })).status, path).toBe(404);
    }
    expect(await repo.getHost(t.ctx, 'host_sam')).toEqual(t.sam);
    expect((await repo.getHost(t.ctx, 'host_owner'))!.name).toBe('Jimi Cohen');
  });
});

describe('GET /host/:id/calendars', () => {
  it('lists the calendars of the connected Google account', async () => {
    const t = await team();
    expect((await get(t.ctx, link('host_alex', t.alexToken, '/calendars'))).status).toBe(409);

    await connectGoogle(t.ctx, 'host_alex');
    await repo.saveSecrets(t.ctx, { google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret-value' } });
    const seen: string[] = [];
    t.ctx.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push(url);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at-1', expires_in: 3600 });
      if (url.includes('/users/me/calendarList')) return Response.json({ items: [{ id: 'alex@gmail.example', summary: 'Alex', primary: true, accessRole: 'owner' }, { id: 'team', summary: 'Team', accessRole: 'reader' }] });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const res = await ok<{ calendars: { id: string; summary: string; primary: boolean; accessRole: string }[] }>(get(t.ctx, link('host_alex', t.alexToken, '/calendars')));
    expect(res.calendars).toEqual([
      { id: 'alex@gmail.example', summary: 'Alex', primary: true, accessRole: 'owner' },
      { id: 'team', summary: 'Team', primary: false, accessRole: 'reader' },
    ]);
    expect(seen.some((u) => u.includes('calendarList'))).toBe(true);

    // And then chooses which ones count.
    const saved = await ok<{ host: AdminHost }>(put(t.ctx, link('host_alex', t.alexToken), { busyCalendarIds: ['primary', 'team'], writeCalendarId: 'primary' }));
    expect(saved.host.google).toMatchObject({ busyCalendarIds: ['primary', 'team'], writeCalendarId: 'primary' });
  });

  it('turns trouble at Google into something the page can show', async () => {
    const t = await team();
    await connectGoogle(t.ctx, 'host_alex');
    await repo.saveSecrets(t.ctx, { google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret-value' } });
    t.ctx.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const res = await get(t.ctx, link('host_alex', t.alexToken, '/calendars'));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('google_needs_reconnect');
    expect((await repo.getHost(t.ctx, 'host_alex'))!.google!.status).toBe('needs_reconnect');
  });
});

describe('POST /host/:id/google/disconnect', () => {
  function post(ctx: TestCtx, path: string, extra: { origin?: string | null } = {}): Promise<Response> {
    return handle(apiRequest('POST', path, { body: {}, ...extra }), ctx);
  }

  it('lets a co-host take their own Google account off, and gives the zone back to their device', async () => {
    const t = await team();
    await connectGoogle(t.ctx, 'host_alex');
    await repo.updateHost(t.ctx, 'host_alex', (h) => ({ ...h, timezoneMode: 'google', timezone: 'Europe/Berlin', calendarHealth: { ok: false, message: 'old', at: TEST_NOW } }));
    await t.ctx.kv.setJSON('cache/busy-host_alex-b670-abc', { value: { b: [], ok: true }, exp: Date.parse(TEST_NOW) + 60_000 });
    const revoked: string[] = [];
    t.ctx.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://oauth2.googleapis.com/revoke') {
        revoked.push(String(init?.body ?? ''));
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const res = await ok<{ ok: boolean; host: AdminHost }>(post(t.ctx, link('host_alex', t.alexToken, '/google/disconnect')));
    expect(res.ok).toBe(true);
    expect(res.host.google).toBeNull();
    expect(res.host.timezoneMode).toBe('device');
    expect(JSON.stringify(res)).not.toContain('refresh-token-very-secret');
    const stored = (await repo.getHost(t.ctx, 'host_alex'))!;
    expect(stored).toMatchObject({ google: null, calendarHealth: null, timezoneMode: 'device', timezone: 'Europe/Berlin' });
    // Google is told the grant is no longer wanted, and nothing read from it is offered from the cache.
    expect(revoked).toHaveLength(1);
    expect(await t.ctx.kv.list('cache/busy-host_alex-')).toEqual([]);
  });

  it('touches nobody else, needs the right link, and refuses cross-site requests', async () => {
    const t = await team();
    await connectGoogle(t.ctx, 'host_alex');
    await connectGoogle(t.ctx, 'host_sam');
    await connectGoogle(t.ctx, 'host_owner');
    t.ctx.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
    for (const path of [link('host_sam', t.alexToken, '/google/disconnect'), link('host_owner', t.alexToken, '/google/disconnect'), link('host_alex', null, '/google/disconnect'), link('host_alex', 'x'.repeat(40), '/google/disconnect')]) {
      expect((await post(t.ctx, path)).status, path).toBe(404);
    }
    for (const origin of ['https://evil.example', null]) {
      const res = await post(t.ctx, link('host_alex', t.alexToken, '/google/disconnect'), { origin });
      expect(res.status).toBe(403);
    }
    for (const id of ['host_alex', 'host_sam', 'host_owner']) expect((await repo.getHost(t.ctx, id))!.google?.status, id).toBe('ok');
  });

  it('is harmless when nothing is connected', async () => {
    const t = await team();
    const res = await ok<{ host: AdminHost }>(post(t.ctx, link('host_alex', t.alexToken, '/google/disconnect')));
    expect(res.host.google).toBeNull();
    expect(res.host.timezoneMode).toBe('device');
  });
});

describe('what a co-host link cannot reach', () => {
  it('no dashboard route answers to it', async () => {
    const t = await team();
    for (const path of ['/admin/bootstrap', '/admin/hosts', '/admin/bookings', '/admin/integrations', '/admin/hosts/host_alex/calendars']) {
      const res = await get(t.ctx, `${path}?t=${encodeURIComponent(t.alexToken)}`);
      expect(res.status, path).toBe(401);
    }
    const write = await put(t.ctx, `/admin/hosts/host_alex?t=${encodeURIComponent(t.alexToken)}`, { name: 'Self-promoted' });
    expect(write.status).toBe(401);
  });
});
