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
import { rateLimitKey, sessionSetCookie } from '../../server/lib/auth';
import { open, randomToken, sha256Hex } from '../../server/lib/crypto';
import { GMAIL_SEND_SCOPE, GOOGLE_CALENDAR_SCOPES } from '../../server/lib/google';
import * as repo from '../../server/lib/repo';
import { absoluteReturnUrl } from '../../server/routes/google';
import type { Host } from '../../shared/types';
import { apiRequest, cookiePair, makeTestCtx, TEST_BASE_URL, TEST_NOW, type TestCtx, type TestCtxOptions } from '../helpers/ctx';

// ───────────────────────── helpers ─────────────────────────

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-client-secret-value';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const APP_HOST = 'https://jimicohen-meeting.netlify.app/meeting';

interface World {
  ctx: TestCtx;
  /** the owner's dashboard session */
  cookie: string;
  alexToken: string;
  samToken: string;
}

async function addMember(ctx: TestCtx, id: string, name: string, email: string): Promise<string> {
  const token = randomToken(24);
  const host: Host = {
    id,
    role: 'member',
    name,
    email,
    title: '',
    avatarAssetId: null,
    timezone: 'UTC',
    timezoneMode: 'device',
    schedules: [{ id: 'sch_default', name: 'Working hours', weekly: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }, overrides: [] }],
    defaultScheduleId: 'sch_default',
    google: null,
    icsFeeds: [],
    inviteTokenHash: sha256Hex(token),
    notify: { email: true, sms: false },
    calendarHealth: null,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  };
  await repo.saveHost(ctx, host);
  return token;
}

async function world(opts: TestCtxOptions & { configured?: boolean } = {}): Promise<World> {
  const ctx = makeTestCtx(opts);
  await repo.getSite(ctx);
  await ctx.kv.setJSON('auth/admin', { passwordHash: 'not-used-in-these-tests', passwordVersion: 1, setupUsedAt: TEST_NOW });
  if (opts.configured !== false) await repo.saveSecrets(ctx, { google: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
  const alexToken = await addMember(ctx, 'host_alex', 'Alex Rivera', 'alex@example.com');
  const samToken = await addMember(ctx, 'host_sam', 'Sam Okafor', 'sam@example.com');
  return { ctx, cookie: cookiePair(sessionSetCookie(ctx, 1)), alexToken, samToken };
}

interface ConnectOptions {
  host?: string | null;
  cookie?: string;
  t?: string;
  gmail?: string;
  returnTo?: string;
  /** send the Accept header of a browser navigation */
  browser?: boolean;
  /** the address the request arrives at (behind the proxy this is not the public one) */
  baseUrl?: string;
}

function connect(ctx: TestCtx, o: ConnectOptions = {}): Promise<Response> {
  const query = new URLSearchParams();
  if (o.host !== null) query.set('host', o.host ?? 'host_owner');
  if (o.gmail !== undefined) query.set('gmail', o.gmail);
  if (o.returnTo !== undefined) query.set('return', o.returnTo);
  if (o.t !== undefined) query.set('t', o.t);
  const headers: Record<string, string> = o.browser ? { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } : {};
  return handle(apiRequest('GET', `/google/connect?${query.toString()}`, { cookie: o.cookie, headers, baseUrl: o.baseUrl }), ctx);
}

/** Starts a connection and returns the `state` Google would send back. */
async function begin(ctx: TestCtx, o: ConnectOptions): Promise<string> {
  const res = await connect(ctx, o);
  expect(res.status, await res.clone().text()).toBe(302);
  return new URL(res.headers.get('location')!).searchParams.get('state')!;
}

function callback(ctx: TestCtx, params: Record<string, string>, baseUrl?: string): Promise<Response> {
  return handle(apiRequest('GET', `/google/callback?${new URLSearchParams(params).toString()}`, { baseUrl }), ctx);
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function idToken(email: string): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1', email, email_verified: true })}.signature`;
}

interface GoogleFake {
  calls: string[];
  /** bodies of the token requests */
  tokenForms: URLSearchParams[];
}

/** Google as it answers a successful sign-in: the token exchange, then the calendar's time zone. */
function fakeGoogle(ctx: TestCtx, o: { email?: string; scopes?: string[]; zone?: string; tokenStatus?: number; tokenError?: string } = {}): GoogleFake {
  const fake: GoogleFake = { calls: [], tokenForms: [] };
  ctx.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fake.calls.push(url);
    if (url === TOKEN_URL) {
      fake.tokenForms.push(new URLSearchParams(String(init?.body ?? '')));
      if (o.tokenError) return Response.json({ error: o.tokenError }, { status: o.tokenStatus ?? 400 });
      return Response.json({
        access_token: 'access-token-1',
        expires_in: 3600,
        refresh_token: 'refresh-token-very-secret',
        scope: (o.scopes ?? GOOGLE_CALENDAR_SCOPES).join(' '),
        id_token: idToken(o.email ?? 'jimi@example.com'),
      });
    }
    if (url.endsWith('/users/me/settings/timezone')) return Response.json({ value: o.zone ?? 'America/New_York' });
    throw new Error(`Unexpected network call in a test: ${url}`);
  }) as typeof fetch;
  return fake;
}

function locationOf(res: Response): URL {
  expect(res.status).toBe(302);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return new URL(res.headers.get('location')!);
}

// ───────────────────────── /google/connect ─────────────────────────

describe('GET /google/connect: who may start a connection', () => {
  it('nobody without a session or a link', async () => {
    const w = await world();
    for (const o of [{}, { host: 'host_alex' }, { t: 'not-a-real-token-not-a-real-token' }, { host: 'host_alex', t: '' }, { cookie: 'mtg_session=garbage' }] as ConnectOptions[]) {
      const res = await connect(w.ctx, o);
      expect(res.status).toBe(401);
      expect(res.headers.get('location')).toBeNull();
      expect((await res.json()).error.code).toBe('unauthorized');
    }
  });

  it('the signed-in owner, for anyone on the team', async () => {
    const w = await world();
    for (const host of ['host_owner', 'host_alex', 'host_sam']) {
      const to = locationOf(await connect(w.ctx, { cookie: w.cookie, host }));
      expect(`${to.origin}${to.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(to.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(to.searchParams.get('redirect_uri')).toBe(`${TEST_BASE_URL}/api/google/callback`);
      expect(to.searchParams.get('response_type')).toBe('code');
      expect(to.searchParams.get('access_type')).toBe('offline');
      expect(to.searchParams.get('prompt')).toBe('consent');
      expect(to.searchParams.get('scope')!.split(' ')).toEqual(GOOGLE_CALENDAR_SCOPES);
      expect(to.searchParams.get('state')!.length).toBeGreaterThan(40);
    }
    expect((await connect(w.ctx, { cookie: w.cookie, host: 'host_nobody' })).status).toBe(404);
    expect((await connect(w.ctx, { cookie: w.cookie, host: null })).status).toBe(400);
    expect((await connect(w.ctx, { cookie: w.cookie, host: '../site' })).status).toBe(400);
  });

  it('a co-host with their own link, for themselves only', async () => {
    const w = await world();
    const to = locationOf(await connect(w.ctx, { host: 'host_alex', t: w.alexToken }));
    expect(to.hostname).toBe('accounts.google.com');
    expect(to.searchParams.get('login_hint')).toBe('alex@example.com');

    const refused: ConnectOptions[] = [
      { host: 'host_sam', t: w.alexToken },
      { host: 'host_owner', t: w.alexToken },
      { host: 'host_alex', t: w.samToken },
      { host: 'host_alex', t: sha256Hex(w.alexToken) },
      { host: 'host_nobody', t: w.alexToken },
    ];
    for (const o of refused) {
      const res = await connect(w.ctx, o);
      expect(res.status, JSON.stringify(o)).toBe(401);
      expect(res.headers.get('location')).toBeNull();
    }
    // A replaced link is as good as none.
    await repo.updateHost(w.ctx, 'host_alex', (h) => ({ ...h, inviteTokenHash: sha256Hex(randomToken(24)) }));
    expect((await connect(w.ctx, { host: 'host_alex', t: w.alexToken })).status).toBe(401);
  });

  it('asks for Gmail only for the owner, and only when the owner asks', async () => {
    const w = await world();
    const scopeOf = async (o: ConnectOptions): Promise<string[]> => locationOf(await connect(w.ctx, o)).searchParams.get('scope')!.split(' ');
    expect(await scopeOf({ cookie: w.cookie, gmail: '1' })).toEqual([...GOOGLE_CALENDAR_SCOPES, GMAIL_SEND_SCOPE]);
    expect(await scopeOf({ cookie: w.cookie, gmail: '0' })).toEqual(GOOGLE_CALENDAR_SCOPES);
    expect(await scopeOf({ cookie: w.cookie, gmail: 'true' })).toEqual(GOOGLE_CALENDAR_SCOPES);
    expect(await scopeOf({ cookie: w.cookie, host: 'host_alex', gmail: '1' })).toEqual(GOOGLE_CALENDAR_SCOPES);
    expect(await scopeOf({ host: 'host_alex', t: w.alexToken, gmail: '1' })).toEqual(GOOGLE_CALENDAR_SCOPES);
  });

  it('only returns to a path inside the app', async () => {
    const w = await world();
    for (const returnTo of ['https://evil.example/meeting/admin', '//evil.example/meeting', '/elsewhere', '/meetingx/admin', '/meeting/../admin', '\\\\evil.example', 'javascript:alert(1)', '']) {
      const res = await connect(w.ctx, { cookie: w.cookie, returnTo });
      expect(res.status, returnTo).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_return');
    }
    for (const returnTo of ['/meeting/admin/integrations', '/meeting/admin/team?tab=1', '/meeting']) {
      expect((await connect(w.ctx, { cookie: w.cookie, returnTo })).status, returnTo).toBe(302);
    }
  });

  it('explains when Google has not been set up yet', async () => {
    const w = await world({ configured: false });
    const res = await connect(w.ctx, { cookie: w.cookie });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('google_not_configured');
  });

  it('shows a refusal on a page, not as raw JSON, when a browser navigated here', async () => {
    const w = await world();
    const signedOut = locationOf(await connect(w.ctx, { browser: true }));
    expect(`${signedOut.origin}${signedOut.pathname}`).toBe(`${TEST_BASE_URL}/admin/integrations`);
    expect(signedOut.searchParams.get('google')).toBe('error');
    expect(signedOut.searchParams.get('reason')).toBe('Please sign in, then connect Google again.');

    const badLink = locationOf(await connect(w.ctx, { browser: true, host: 'host_alex', t: w.samToken }));
    expect(`${badLink.origin}${badLink.pathname}`).toBe(`${TEST_BASE_URL}/host/host_alex`);
    expect(badLink.searchParams.get('t')).toBe(w.samToken);
    expect(badLink.searchParams.get('google')).toBe('error');

    const unconfigured = await world({ configured: false });
    const to = locationOf(await connect(unconfigured.ctx, { browser: true, cookie: unconfigured.cookie }));
    expect(to.searchParams.get('reason')).toMatch(/client ID and client secret/);
    // The refusal page is always ours, whatever `return` asked for.
    const evil = locationOf(await connect(w.ctx, { browser: true, returnTo: 'https://evil.example/' }));
    expect(evil.origin).toBe(new URL(TEST_BASE_URL).origin);
  });

  it('builds the redirect address from the public address, not from where the request arrived', async () => {
    const w = await world({ env: { embedBaseUrl: APP_HOST } });
    const to = locationOf(await connect(w.ctx, { cookie: w.cookie, baseUrl: APP_HOST }));
    expect(to.searchParams.get('redirect_uri')).toBe(`${TEST_BASE_URL}/api/google/callback`);
    const refused = locationOf(await connect(w.ctx, { browser: true, baseUrl: APP_HOST }));
    expect(refused.href.startsWith(`${TEST_BASE_URL}/admin/integrations?`)).toBe(true);
  });

  it('is rate limited per visitor', async () => {
    const w = await world();
    await w.ctx.kv.setJSON(rateLimitKey(w.ctx, 'google-connect', w.ctx.ip ?? 'unknown', 600).key, { n: 30 });
    expect((await connect(w.ctx, { cookie: w.cookie })).status).toBe(429);
  });
});

// ───────────────────────── /google/callback ─────────────────────────

describe('GET /google/callback', () => {
  it('connects the owner, applies the defaults, and returns to where they started', async () => {
    const w = await world();
    const state = await begin(w.ctx, { cookie: w.cookie, returnTo: '/meeting/admin/integrations' });
    const google = fakeGoogle(w.ctx);
    const res = await callback(w.ctx, { state, code: 'auth-code-1', scope: 'ignored' });
    expect(locationOf(res).href).toBe(`${TEST_BASE_URL}/admin/integrations?google=connected`);

    expect(google.tokenForms).toHaveLength(1);
    expect(Object.fromEntries(google.tokenForms[0])).toEqual({ code: 'auth-code-1', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: `${TEST_BASE_URL}/api/google/callback`, grant_type: 'authorization_code' });

    const owner = (await repo.getHost(w.ctx, 'host_owner'))!;
    expect(owner.google).toMatchObject({ email: 'jimi@example.com', status: 'ok', busyCalendarIds: ['primary'], writeCalendarId: 'primary', gmailSend: false });
    expect(open(w.ctx, 'google-refresh', owner.google!.refreshTokenEnc)).toBe('refresh-token-very-secret');
    // First connection of someone who followed their device: the calendar's zone takes over.
    expect(owner.timezoneMode).toBe('google');
    expect(owner.timezone).toBe('America/New_York');
    expect(google.calls.filter((u) => u.endsWith('/settings/timezone'))).toHaveLength(1);
    // Nothing secret travels in the redirect.
    expect(res.headers.get('location')).not.toContain('refresh');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('brings a co-host back to their own page, link and all', async () => {
    const w = await world();
    const returnTo = `/meeting/host/host_alex?t=${encodeURIComponent(w.alexToken)}`;
    const state = await begin(w.ctx, { host: 'host_alex', t: w.alexToken, returnTo });
    fakeGoogle(w.ctx, { email: 'alex@gmail.example', zone: 'Europe/Berlin' });
    const to = locationOf(await callback(w.ctx, { state, code: 'auth-code-2' }));
    expect(`${to.origin}${to.pathname}`).toBe(`${TEST_BASE_URL}/host/host_alex`);
    expect(to.searchParams.get('t')).toBe(w.alexToken);
    expect(to.searchParams.get('google')).toBe('connected');
    expect([...to.searchParams.keys()].sort()).toEqual(['google', 't']);

    const alex = (await repo.getHost(w.ctx, 'host_alex'))!;
    expect(alex.google).toMatchObject({ email: 'alex@gmail.example', status: 'ok' });
    expect(alex.timezoneMode).toBe('google');
    expect(alex.timezone).toBe('Europe/Berlin');
    // Only Alex was connected.
    expect((await repo.getHost(w.ctx, 'host_owner'))!.google ?? null).toBeNull();
    expect((await repo.getHost(w.ctx, 'host_sam'))!.google ?? null).toBeNull();
  });

  it('without a return path it uses the page the connection was started from', async () => {
    const w = await world();
    fakeGoogle(w.ctx);
    const admin = await begin(w.ctx, { cookie: w.cookie });
    expect(locationOf(await callback(w.ctx, { state: admin, code: 'c1' })).href).toBe(`${TEST_BASE_URL}/admin/integrations?google=connected`);
    const cohost = await begin(w.ctx, { host: 'host_alex', t: w.alexToken });
    fakeGoogle(w.ctx, { email: 'alex@gmail.example' });
    expect(locationOf(await callback(w.ctx, { state: cohost, code: 'c2' })).href).toBe(`${TEST_BASE_URL}/host/host_alex?t=${w.alexToken}&google=connected`);
  });

  it('leaves a chosen zone mode alone, and does not switch again on a reconnect', async () => {
    const w = await world();
    await repo.updateHost(w.ctx, 'host_owner', (h) => ({ ...h, timezoneMode: 'fixed', timezone: 'Africa/Nairobi' }));
    let google = fakeGoogle(w.ctx);
    await callback(w.ctx, { state: await begin(w.ctx, { cookie: w.cookie }), code: 'c1' });
    let owner = (await repo.getHost(w.ctx, 'host_owner'))!;
    expect(owner.google?.status).toBe('ok');
    expect(owner.timezoneMode).toBe('fixed');
    expect(owner.timezone).toBe('Africa/Nairobi');
    expect(google.calls.filter((u) => u.endsWith('/settings/timezone'))).toHaveLength(0);

    // Later the owner chooses "follow this device", then reconnects Google: it stays their choice.
    await repo.updateHost(w.ctx, 'host_owner', (h) => ({ ...h, timezoneMode: 'device', google: { ...h.google!, busyCalendarIds: ['primary', 'family'], writeCalendarId: 'family' } }));
    google = fakeGoogle(w.ctx);
    const res = await callback(w.ctx, { state: await begin(w.ctx, { cookie: w.cookie }), code: 'c2' });
    expect(locationOf(res).searchParams.get('google')).toBe('connected');
    owner = (await repo.getHost(w.ctx, 'host_owner'))!;
    expect(owner.timezoneMode).toBe('device');
    expect(owner.timezone).toBe('Africa/Nairobi');
    // The calendars they had picked for this account are kept.
    expect(owner.google).toMatchObject({ busyCalendarIds: ['primary', 'family'], writeCalendarId: 'family' });
  });

  it('fills in the calendar defaults when a connection has none', async () => {
    const w = await world();
    fakeGoogle(w.ctx);
    await callback(w.ctx, { state: await begin(w.ctx, { cookie: w.cookie }), code: 'c1' });
    // A record from an older version, or edited by hand: no calendars chosen at all.
    await repo.updateHost(w.ctx, 'host_owner', (h) => ({ ...h, google: { ...h.google!, email: 'someone-else@example.com', busyCalendarIds: [], writeCalendarId: '' } }));
    fakeGoogle(w.ctx);
    await callback(w.ctx, { state: await begin(w.ctx, { cookie: w.cookie }), code: 'c2' });
    expect((await repo.getHost(w.ctx, 'host_owner'))!.google).toMatchObject({ email: 'jimi@example.com', busyCalendarIds: ['primary'], writeCalendarId: 'primary' });
  });

  it('remembers that sending from Gmail was allowed', async () => {
    const w = await world();
    const state = await begin(w.ctx, { cookie: w.cookie, gmail: '1' });
    fakeGoogle(w.ctx, { scopes: [...GOOGLE_CALENDAR_SCOPES, GMAIL_SEND_SCOPE] });
    await callback(w.ctx, { state, code: 'c1' });
    expect((await repo.getHost(w.ctx, 'host_owner'))!.google?.gmailSend).toBe(true);
  });

  it('comes back with a readable reason when the person said no at Google', async () => {
    const w = await world();
    const state = await begin(w.ctx, { cookie: w.cookie, returnTo: '/meeting/admin/integrations' });
    const google = fakeGoogle(w.ctx);
    const to = locationOf(await callback(w.ctx, { state, error: 'access_denied' }));
    expect(`${to.origin}${to.pathname}`).toBe(`${TEST_BASE_URL}/admin/integrations`);
    expect(to.searchParams.get('google')).toBe('error');
    expect(to.searchParams.get('reason')).toBe('Google sign-in was cancelled, so nothing was connected.');
    expect(google.calls).toEqual([]);
    expect((await repo.getHost(w.ctx, 'host_owner'))!.google ?? null).toBeNull();
    expect((await repo.getHost(w.ctx, 'host_owner'))!.timezoneMode).toBe('device');
  });

  it('sends a tampered, foreign or missing state to the fallback page with an error', async () => {
    const w = await world();
    const good = await begin(w.ctx, { host: 'host_alex', t: w.alexToken, returnTo: `/meeting/host/host_alex?t=${w.alexToken}` });
    const google = fakeGoogle(w.ctx);
    const [body, signature] = good.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ d: { hostId: 'host_owner', returnTo: 'https://evil.example', gmail: true, n: 'x' }, exp: Date.parse(TEST_NOW) + 60_000 }), 'utf8').toString('base64url');
    const otherKey = makeTestCtx({ env: { secretKey: Buffer.alloc(32, 9).toString('base64') } });
    await repo.getSite(otherKey);
    await repo.saveSecrets(otherKey, { google: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
    await otherKey.kv.setJSON('auth/admin', { passwordHash: 'x', passwordVersion: 1, setupUsedAt: TEST_NOW });
    const foreign = await begin(otherKey, { cookie: cookiePair(sessionSetCookie(otherKey, 1)) });

    for (const state of [`${body}x.${signature}`, `${body}.${signature}x`, `${forgedPayload}.${signature}`, foreign, 'garbage', '']) {
      const to = locationOf(await callback(w.ctx, state === '' ? { code: 'auth-code' } : { state, code: 'auth-code' }));
      expect(to.href.startsWith(`${TEST_BASE_URL}/admin/integrations?google=error&reason=`), state.slice(0, 20)).toBe(true);
      expect(to.searchParams.get('reason')).toBe('This Google sign-in link has expired. Please start again.');
    }
    expect(google.calls).toEqual([]);
    for (const id of ['host_owner', 'host_alex', 'host_sam']) expect((await repo.getHost(w.ctx, id))!.google ?? null).toBeNull();
  });

  it('accepts each state once, and not after ten minutes', async () => {
    const w = await world();
    fakeGoogle(w.ctx);
    const state = await begin(w.ctx, { cookie: w.cookie });
    expect(locationOf(await callback(w.ctx, { state, code: 'c1' })).searchParams.get('google')).toBe('connected');
    const replay = locationOf(await callback(w.ctx, { state, code: 'c1' }));
    expect(replay.searchParams.get('google')).toBe('error');
    expect(replay.searchParams.get('reason')).toMatch(/already used/);

    const stale = await begin(w.ctx, { cookie: w.cookie });
    w.ctx.clock.advance(11 * 60_000);
    const late = locationOf(await callback(w.ctx, { state: stale, code: 'c2' }));
    expect(late.searchParams.get('reason')).toMatch(/expired/);
  });

  it('reports what went wrong at Google in a sentence', async () => {
    const w = await world();
    fakeGoogle(w.ctx, { tokenError: 'invalid_client', tokenStatus: 401 });
    const to = locationOf(await callback(w.ctx, { state: await begin(w.ctx, { cookie: w.cookie }), code: 'c1' }));
    expect(to.searchParams.get('google')).toBe('error');
    expect(to.searchParams.get('reason')).toBe('Google rejected the client ID or client secret. Check them under Integrations.');
    expect((await repo.getHost(w.ctx, 'host_owner'))!.google ?? null).toBeNull();

    // Calendar permission was not ticked on the consent screen.
    fakeGoogle(w.ctx, { scopes: ['openid', 'email'] });
    const partial = locationOf(await callback(w.ctx, { state: await begin(w.ctx, { cookie: w.cookie }), code: 'c2' }));
    expect(partial.searchParams.get('reason')).toMatch(/Calendar access was not granted/);
  });

  it('still says "connected" when reading the calendar zone fails afterwards', async () => {
    const w = await world();
    const state = await begin(w.ctx, { cookie: w.cookie });
    w.ctx.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === TOKEN_URL) return Response.json({ access_token: 'at', expires_in: 3600, refresh_token: 'rt', scope: GOOGLE_CALENDAR_SCOPES.join(' '), id_token: idToken('jimi@example.com') });
      return Response.json({ error: { code: 500 } }, { status: 500 });
    }) as typeof fetch;
    const to = locationOf(await callback(w.ctx, { state, code: 'c1' }));
    expect(to.searchParams.get('google')).toBe('connected');
    const owner = (await repo.getHost(w.ctx, 'host_owner'))!;
    expect(owner.google?.status).toBe('ok');
    expect(owner.timezoneMode).toBe('google');
    expect(owner.timezone).toBe('UTC');
  });

  it('always redirects to the public address, wherever the request arrived', async () => {
    const w = await world({ env: { embedBaseUrl: APP_HOST } });
    fakeGoogle(w.ctx);
    const state = await begin(w.ctx, { cookie: w.cookie, baseUrl: APP_HOST });
    const ok = locationOf(await callback(w.ctx, { state, code: 'c1' }, APP_HOST));
    expect(ok.href).toBe(`${TEST_BASE_URL}/admin/integrations?google=connected`);
    const bad = locationOf(await callback(w.ctx, { state: 'garbage' }, APP_HOST));
    expect(bad.origin).toBe('https://jimicohen.com');
    const hostile = await handle(new Request('https://evil.example/meeting/api/google/callback?state=garbage', { headers: { host: 'evil.example' } }), w.ctx);
    expect(locationOf(hostile).origin).toBe('https://jimicohen.com');
  });

  it('turns too many attempts into an error on the page', async () => {
    const w = await world();
    const state = await begin(w.ctx, { cookie: w.cookie });
    const google = fakeGoogle(w.ctx);
    await w.ctx.kv.setJSON(rateLimitKey(w.ctx, 'google-callback', w.ctx.ip ?? 'unknown', 600).key, { n: 30 });
    const to = locationOf(await callback(w.ctx, { state, code: 'c1' }));
    expect(`${to.origin}${to.pathname}`).toBe(`${TEST_BASE_URL}/admin/integrations`);
    expect(to.searchParams.get('reason')).toMatch(/Too many attempts/);
    expect(google.calls).toEqual([]);
    expect((await repo.getHost(w.ctx, 'host_owner'))!.google ?? null).toBeNull();
  });

  it('refuses to guess an address when the site does not know its own', async () => {
    const w = await world({ env: { publicBaseUrl: '' } });
    const res = await handle(new Request('https://jimicohen-meeting.netlify.app/meeting/api/google/callback?state=x'), w.ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get('location')).toBeNull();
    expect((await res.json()).error.code).toBe('not_configured');
  });
});

// ───────────────────────── return addresses ─────────────────────────

describe('absoluteReturnUrl', () => {
  const ctx = makeTestCtx();
  const fallback = `${TEST_BASE_URL}/admin/integrations`;

  it.each([
    ['/meeting/admin/integrations', `${TEST_BASE_URL}/admin/integrations`],
    ['/meeting/admin/team?x=1#people', `${TEST_BASE_URL}/admin/team?x=1#people`],
    ['/meeting/host/host_1?t=abc-_123', `${TEST_BASE_URL}/host/host_1?t=abc-_123`],
    ['/meeting', TEST_BASE_URL],
    ['/meeting?embed=1', `${TEST_BASE_URL}?embed=1`],
  ])('keeps %s inside the app', (input, expected) => {
    expect(absoluteReturnUrl(ctx, input)?.href).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['https://evil.example/meeting/admin'],
    ['//evil.example/meeting/admin'],
    ['/meetingevil/admin'],
    ['/meeting/../../etc/passwd'],
    ['/meeting/%2e%2e/%2e%2e/secret'],
    ['/meeting//evil.example'],
    ['/meeting\\evil.example'],
    ['/meeting/admin\r\nSet-Cookie: x=1'],
    ['/other'],
    ['meeting/admin'],
    [`/meeting/${'a'.repeat(2000)}`],
  ])('sends %s to the fallback page', (input) => {
    expect(absoluteReturnUrl(ctx, input as string | null | undefined)?.href).toBe(fallback);
  });

  it('works with a public address that has another mount path, and gives up without one', () => {
    const custom = makeTestCtx({ env: { publicBaseUrl: 'https://example.org/book/' } });
    expect(absoluteReturnUrl(custom, '/meeting/admin/team')?.href).toBe('https://example.org/book/admin/team');
    expect(absoluteReturnUrl(custom, 'https://evil.example')?.href).toBe('https://example.org/book/admin/integrations');
    expect(absoluteReturnUrl(makeTestCtx({ env: { publicBaseUrl: '' } }), '/meeting/admin')).toBeNull();
    expect(absoluteReturnUrl(makeTestCtx({ env: { publicBaseUrl: 'ftp://example.org/meeting' } }), '/meeting/admin')).toBeNull();
  });
});
