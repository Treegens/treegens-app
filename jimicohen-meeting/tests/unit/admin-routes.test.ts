import { afterEach, describe, expect, it, vi } from 'vitest';

// The booking engine belongs to another module. Here it is a stand-in that does the one thing
// these tests need from it (cancelling), so the dashboard routes are tested on their own.
vi.mock('../../server/lib/booking', async () => {
  const { hmacHex } = await import('../../server/lib/crypto');
  const repo = await import('../../server/lib/repo');
  return {
    manageToken: (ctx: never, id: string) => hmacHex(ctx, 'manage', id),
    verifyManageToken: vi.fn(() => false),
    cancelBooking: vi.fn(async (ctx: Parameters<typeof repo.updateBooking>[0], id: string, p: { by: 'invitee' | 'host' | 'assistant'; reason?: string }) => {
      const at = ctx.now().toISOString();
      const saved = await repo.updateBooking(ctx, id, (b) => ({ ...b, status: 'cancelled', cancellation: { at, by: p.by, reason: p.reason } }));
      await repo.mutateBookingIndex(ctx, (entries) => entries.map((e) => (e.id === id ? { ...e, status: 'cancelled' as const } : e)));
      return saved;
    }),
    confirmAttendance: vi.fn(),
    rescheduleBooking: vi.fn(),
    createBooking: vi.fn(),
    getSlots: vi.fn(),
    toPublicSite: vi.fn(),
    toPublicEventType: vi.fn(),
    toPublicBooking: vi.fn(),
    syncBookingToCalendar: vi.fn(),
    calendarEventIdFor: (id: string) => `mtg${id}`,
  };
});
vi.mock('../../server/routes/public', () => ({ routes: [] }));
vi.mock('../../server/routes/webhooks', () => ({ routes: [] }));
vi.mock('../../server/cron', () => ({ runScheduled: async () => ({}) }));

import { handle } from '../../server/api';
import { hostFromToken, sessionSetCookie } from '../../server/lib/auth';
import { cancelBooking } from '../../server/lib/booking';
import { hmacHex, open, seal, sha256Hex } from '../../server/lib/crypto';
import { GOOGLE_CALENDAR_SCOPES } from '../../server/lib/google';
import { HttpError, matchPattern } from '../../server/lib/http';
import * as repo from '../../server/lib/repo';
import { TEMPLATE_VARIABLES } from '../../server/lib/templates';
import { VOICE_OPTIONS } from '../../server/lib/voice';
import { routes as adminRoutes } from '../../server/routes/admin';
import type { AdminBooking, AdminBootstrap, AdminHost, AdminOverview, Booking, CallRecord, EventType, Host, HostGoogle, IntegrationsStatus, Job, SharedHoursCheck, SiteSettings } from '../../shared/types';
import { apiRequest, cookiePair, makeTestCtx, TEST_BASE_URL, TEST_NOW, type TestCtx, type TestCtxOptions } from '../helpers/ctx';

// ───────────────────────── helpers ─────────────────────────

interface Session {
  ctx: TestCtx;
  cookie: string;
}

/** A context with the starter data and a signed-in owner. (No password hashing: only the session version matters here.) */
async function signIn(opts: TestCtxOptions = {}): Promise<Session> {
  const ctx = makeTestCtx(opts);
  await repo.getSite(ctx);
  await ctx.kv.setJSON('auth/admin', { passwordHash: 'not-used-in-these-tests', passwordVersion: 1, setupUsedAt: TEST_NOW });
  return { ctx, cookie: cookiePair(sessionSetCookie(ctx, 1)) };
}

function call(s: Session, method: string, path: string, body?: unknown, extra: { headers?: Record<string, string>; origin?: string | null } = {}): Promise<Response> {
  return handle(apiRequest(method, path, { body, cookie: s.cookie, ...extra }), s.ctx);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return JSON.parse(text) as T;
}

/** The `fields` of an error answer, after checking its status. */
async function fieldsOf(res: Response | Promise<Response>, status = 422): Promise<Record<string, string>> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return (JSON.parse(text).error.fields ?? {}) as Record<string, string>;
}

async function errorOf(res: Response | Promise<Response>, status: number): Promise<{ code: string; message: string }> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return JSON.parse(text).error;
}

interface NetCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** Replaces the network of a context with `handler` and returns the list every request is recorded in. */
function useFetch(ctx: TestCtx, handler: (call: NetCall) => Response | Promise<Response>): NetCall[] {
  const calls: NetCall[] = [];
  ctx.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const entry: NetCall = { url, method: (init?.method ?? 'GET').toUpperCase(), headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : '' };
    calls.push(entry);
    return handler(entry);
  }) as typeof fetch;
  return calls;
}

function hoursFromNow(hours: number): string {
  return new Date(Date.parse(TEST_NOW) + hours * 3_600_000).toISOString();
}

function makeBooking(id: string, patch: Partial<Booking> = {}): Booking {
  const start = patch.start ?? hoursFromNow(48);
  return {
    id,
    eventTypeId: 'evt_intro',
    eventSlug: 'intro',
    eventTitle: 'Intro call',
    kind: 'solo',
    hostIds: ['host_owner'],
    start,
    end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
    durationMin: 30,
    status: 'confirmed',
    invitee: { name: 'Sam Rivera', email: 'sam@example.com', phone: '+14155552671', timezone: 'America/New_York' },
    guests: [],
    answers: [],
    location: { type: 'google_meet', label: 'Google Meet' },
    consent: { sms: false, call: false, at: TEST_NOW, text: '' },
    google: null,
    attendance: {},
    cancellation: null,
    rescheduleCount: 0,
    source: 'page',
    timeline: [{ at: TEST_NOW, type: 'created' }],
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...patch,
  };
}

async function seedBooking(ctx: TestCtx, id: string, patch: Partial<Booking> = {}): Promise<Booking> {
  const saved = await repo.saveBooking(ctx, makeBooking(id, patch));
  await repo.mutateBookingIndex(ctx, (entries) => [...entries.filter((e) => e.id !== id), repo.indexEntryOf(saved)]);
  return saved;
}

async function connectGoogle(ctx: TestCtx, hostId = 'host_owner', over: Partial<HostGoogle> = {}): Promise<Host> {
  const google: HostGoogle = {
    email: 'jimi@example.com',
    refreshTokenEnc: seal(ctx, 'google-refresh', 'refresh-token-very-secret'),
    scopes: [...GOOGLE_CALENDAR_SCOPES],
    busyCalendarIds: ['primary'],
    writeCalendarId: 'primary',
    gmailSend: false,
    status: 'ok',
    connectedAt: TEST_NOW,
    ...over,
  };
  return (await repo.updateHost(ctx, hostId, (h) => ({ ...h, google })))!;
}

async function addCoHost(s: Session, name = 'Alex Rivera', email = 'alex@example.com'): Promise<{ host: AdminHost; inviteUrl: string; token: string }> {
  const created = await ok<{ host: AdminHost; inviteUrl: string }>(call(s, 'POST', '/admin/hosts', { name, email }), 201);
  return { ...created, token: new URL(created.inviteUrl).searchParams.get('t') ?? '' };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(40, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBP', 'latin1'), Buffer.alloc(40, 4)]);

function dataUrl(type: string, bytes: Buffer): string {
  return `data:${type};base64,${bytes.toString('base64')}`;
}

async function upload(s: Session, type = 'image/png', bytes: Buffer = PNG, purpose = 'logo'): Promise<{ id: string; url: string }> {
  return ok(call(s, 'POST', '/admin/assets', { dataUrl: dataUrl(type, bytes), purpose }), 201);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ───────────────────────── who gets in ─────────────────────────

const EVERY_ROUTE: [method: string, path: string, body?: unknown][] = [
  ['GET', '/admin/bootstrap'],
  ['GET', '/admin/overview'],
  ['PUT', '/admin/site', { profile: { name: 'Mallory' } }],
  ['POST', '/admin/event-types', { title: 'Sneaky' }],
  ['PUT', '/admin/event-types/evt_intro', { active: false }],
  ['DELETE', '/admin/event-types/evt_intro'],
  ['POST', '/admin/event-types/evt_intro/duplicate', {}],
  ['PUT', '/admin/event-types-order', { ids: ['evt_meeting', 'evt_intro'] }],
  ['POST', '/admin/event-types-check', { kind: 'collective', hostIds: ['host_owner', 'host_someone'] }],
  ['GET', '/admin/hosts'],
  ['POST', '/admin/hosts', { name: 'Mallory', email: 'mallory@example.com' }],
  ['PUT', '/admin/hosts/host_owner', { name: 'Mallory' }],
  ['DELETE', '/admin/hosts/host_someone'],
  ['POST', '/admin/hosts/host_someone/invite', {}],
  ['GET', '/admin/hosts/host_owner/calendars'],
  ['POST', '/admin/hosts/host_owner/google/disconnect', {}],
  ['GET', '/admin/bookings'],
  ['GET', '/admin/bookings.csv'],
  ['GET', '/admin/bookings/bk_1'],
  ['POST', '/admin/bookings/bk_1/cancel', { reason: 'no' }],
  ['POST', '/admin/bookings/bk_1/no-show', { noShow: true }],
  ['DELETE', '/admin/bookings/bk_1'],
  ['GET', '/admin/integrations'],
  ['PUT', '/admin/integrations', { resend: { apiKey: 're_stolen_key_123' } }],
  ['POST', '/admin/integrations/test', { channel: 'email' }],
  ['POST', '/admin/assets', { dataUrl: dataUrl('image/png', PNG), purpose: 'logo' }],
  ['DELETE', '/admin/assets/ast_1'],
];

describe('access to /admin/*', () => {
  it('the route list used by these tests covers every admin route there is', () => {
    for (const r of adminRoutes) {
      const covered = EVERY_ROUTE.some(([method, path]) => method === r.method && matchPattern(r.pattern, path.slice(1).split('/')) !== null);
      expect(covered, `${r.method} ${r.pattern}`).toBe(true);
    }
    expect(adminRoutes.every((r) => r.pattern.startsWith('/admin/'))).toBe(true);
    expect(EVERY_ROUTE).toHaveLength(adminRoutes.length);
  });

  it('answers 401 on every route without a session, and changes nothing', async () => {
    const s = await signIn();
    await seedBooking(s.ctx, 'bk_1');
    const before = JSON.stringify([await repo.getSite(s.ctx), await repo.listHosts(s.ctx), await repo.listEventTypes(s.ctx), await repo.getBooking(s.ctx, 'bk_1'), await repo.getStoredSecrets(s.ctx)]);
    const stale = cookiePair(sessionSetCookie(s.ctx, 7)); // signed by us, but for another password version
    for (const [method, path, body] of EVERY_ROUTE) {
      for (const cookie of [undefined, 'mtg_session=garbage', stale]) {
        const res = await handle(apiRequest(method, path, { body, cookie }), s.ctx);
        expect(res.status, `${method} ${path} with ${cookie ?? 'no cookie'}`).toBe(401);
        expect((await res.json()).error.code).toBe('unauthorized');
      }
    }
    const after = JSON.stringify([await repo.getSite(s.ctx), await repo.listHosts(s.ctx), await repo.listEventTypes(s.ctx), await repo.getBooking(s.ctx, 'bk_1'), await repo.getStoredSecrets(s.ctx)]);
    expect(after).toBe(before);
    expect(await s.ctx.kv.list('assets/')).toEqual([]);
  });

  it('a session ends after 30 days', async () => {
    const s = await signIn();
    expect((await call(s, 'GET', '/admin/hosts')).status).toBe(200);
    s.ctx.clock.advance(31 * 86_400_000);
    expect((await call(s, 'GET', '/admin/hosts')).status).toBe(401);
  });

  it('refuses cross-site requests on every route that changes something, session or not', async () => {
    const s = await signIn();
    await seedBooking(s.ctx, 'bk_1');
    const before = JSON.stringify([await repo.getSite(s.ctx), await repo.listHosts(s.ctx), await repo.listEventTypes(s.ctx), await repo.getBooking(s.ctx, 'bk_1')]);
    for (const [method, path, body] of EVERY_ROUTE.filter(([m]) => m !== 'GET')) {
      const foreign = await call(s, method, path, body, { origin: 'https://evil.example' });
      expect(foreign.status, `${method} ${path} from another origin`).toBe(403);
      expect((await foreign.json()).error.code).toBe('csrf');
      const plainForm = await call(s, method, path, body, { headers: { 'x-requested-with': '' } });
      expect(plainForm.status, `${method} ${path} without our header`).toBe(403);
    }
    expect(JSON.stringify([await repo.getSite(s.ctx), await repo.listHosts(s.ctx), await repo.listEventTypes(s.ctx), await repo.getBooking(s.ctx, 'bk_1')])).toBe(before);
    expect(vi.mocked(cancelBooking)).not.toHaveBeenCalled();
  });

  it('accepts the app origin as well as the public one', async () => {
    const s = await signIn({ env: { embedBaseUrl: 'https://jimicohen-meeting.netlify.app/meeting' } });
    const res = await call(s, 'PUT', '/admin/site', { profile: { headline: 'Hello' } }, { origin: 'https://jimicohen-meeting.netlify.app' });
    expect(res.status).toBe(200);
  });
});

// ───────────────────────── bootstrap ─────────────────────────

describe('GET /admin/bootstrap', () => {
  it('carries everything the dashboard needs on load', async () => {
    const s = await signIn();
    const b = await ok<AdminBootstrap>(call(s, 'GET', '/admin/bootstrap'));
    expect(b.publicUrl).toBe(TEST_BASE_URL);
    expect(b.embedBaseUrl).toBe(TEST_BASE_URL);
    expect(b.voiceOptions).toEqual(VOICE_OPTIONS);
    expect(b.templateVariables).toEqual(TEMPLATE_VARIABLES);
    expect(b.site.ownerHostId).toBe('host_owner');
    expect(b.hosts.map((h) => h.id)).toEqual(['host_owner']);
    expect(b.hosts[0]).toMatchObject({ role: 'owner', google: null, icsFeeds: [], hasInviteLink: false, avatarUrl: null });
    expect(b.eventTypes.map((e) => e.slug)).toEqual(['intro', 'meeting']);
    expect(b.integrations.baseUrl).toBe(TEST_BASE_URL);
    expect(b.integrations.google.redirectUri).toBe(`${TEST_BASE_URL}/api/google/callback`);
  });

  it('uses the app address for embeds when one is set', async () => {
    const s = await signIn({ env: { embedBaseUrl: 'https://jimicohen-meeting.netlify.app/meeting' } });
    const b = await ok<AdminBootstrap>(call(s, 'GET', '/admin/bootstrap'));
    expect(b.embedBaseUrl).toBe('https://jimicohen-meeting.netlify.app/meeting');
    expect(b.publicUrl).toBe(TEST_BASE_URL);
  });

  it('never lets a secret out: no tokens, no hashes, no sealed values, no feed addresses, no keys', async () => {
    const s = await signIn({ env: { overrides: { anthropicApiKey: 'sk-ant-from-the-environment-000' } } });
    const { host } = await addCoHost(s);
    const owner = await connectGoogle(s.ctx);
    await ok(call(s, 'PUT', `/admin/hosts/${host.id}`, { addIcsFeed: { label: 'Work', url: 'https://calendar.example.com/private-abc123/basic.ics' } }));
    await repo.saveSecrets(s.ctx, {
      google: { clientId: '123456789-abcdef.apps.googleusercontent.com', clientSecret: 'GOCSPX-super-secret-value' },
      twilio: { accountSid: `AC${'0123456789abcdef'.repeat(2)}`, authToken: 'twilio-auth-token-secret-value-1', fromNumber: '+15005550006' },
      resend: { apiKey: 're_secret_resend_key_value' },
    });
    const stored = (await repo.getHost(s.ctx, host.id))!;

    for (const path of ['/admin/bootstrap', '/admin/hosts', '/admin/integrations', '/admin/overview']) {
      const text = await (await call(s, 'GET', path)).text();
      for (const secret of [
        'refresh-token-very-secret',
        owner.google!.refreshTokenEnc,
        'refreshTokenEnc',
        stored.inviteTokenHash!,
        'inviteTokenHash',
        stored.icsFeeds[0].urlEnc,
        'urlEnc',
        'private-abc123',
        'GOCSPX-super-secret-value',
        'twilio-auth-token-secret-value-1',
        `AC${'0123456789abcdef'.repeat(2)}`,
        're_secret_resend_key_value',
        'sk-ant-from-the-environment-000',
        '123456789-abcdef',
      ]) {
        expect(text.includes(secret), `${path} leaks ${secret.slice(0, 24)}`).toBe(false);
      }
    }
    const b = await ok<AdminBootstrap>(call(s, 'GET', '/admin/bootstrap'));
    expect(b.hosts.find((h) => h.id === host.id)).toMatchObject({ hasInviteLink: true, icsFeeds: [{ label: 'Work' }] });
    expect(b.hosts[0].google).toEqual({ email: 'jimi@example.com', status: 'ok', busyCalendarIds: ['primary'], writeCalendarId: 'primary', gmailSend: false });
  });
});

// ───────────────────────── site ─────────────────────────

describe('PUT /admin/site', () => {
  it('merges a partial update and leaves everything else alone', async () => {
    const s = await signIn();
    const before = await repo.getSite(s.ctx);
    s.ctx.clock.advance(1000);
    const { site } = await ok<{ site: SiteSettings }>(
      call(s, 'PUT', '/admin/site', {
        profile: { name: '  Jimi   C.  ', links: [{ label: 'Website', url: 'https://jimicohen.com' }] },
        theme: { colors: { primary: '#ABC' }, radius: 12, texts: { ctaLabel: 'Book it' }, background: { type: 'gradient', gradientAngle: 90 } },
        assistant: { name: 'Mia', callWindowEndHour: 24 },
        booking: { reminderOptInDefault: false, privacyUrl: 'https://jimicohen.com/privacy' },
        email: { provider: 'resend', fromEmail: 'meet@jimicohen.com', replyTo: '' },
      }),
    );
    expect(site.profile.name).toBe('Jimi C.');
    expect(site.profile.headline).toBe(before.profile.headline);
    expect(site.profile.links).toEqual([{ label: 'Website', url: 'https://jimicohen.com' }]);
    expect(site.theme.colors).toEqual({ ...before.theme.colors, primary: '#aabbcc' });
    expect(site.theme.radius).toBe(12);
    expect(site.theme.texts).toEqual({ ...before.theme.texts, ctaLabel: 'Book it' });
    expect(site.theme.background).toEqual({ ...before.theme.background, type: 'gradient', gradientAngle: 90 });
    expect(site.theme.fontHeading).toBe(before.theme.fontHeading);
    expect(site.assistant).toEqual({ ...before.assistant, name: 'Mia', callWindowEndHour: 24 });
    expect(site.booking).toEqual({ ...before.booking, reminderOptInDefault: false, privacyUrl: 'https://jimicohen.com/privacy' });
    expect(site.email).toEqual({ ...before.email, provider: 'resend', fromEmail: 'meet@jimicohen.com' });
    expect(site.updatedAt).not.toBe(before.updatedAt);
    expect(await repo.getSite(s.ctx)).toEqual(site);
  });

  it('accepts a whole theme sent back as it was received', async () => {
    const s = await signIn();
    const before = await repo.getSite(s.ctx);
    const { site } = await ok<{ site: SiteSettings }>(call(s, 'PUT', '/admin/site', { theme: before.theme }));
    expect(site.theme).toEqual(before.theme);
  });

  it('ignores keys it does not know and never moves the owner', async () => {
    const s = await signIn();
    const { site } = await ok<{ site: SiteSettings }>(
      call(s, 'PUT', '/admin/site', { nonsense: 1, ownerHostId: 'host_evil', updatedAt: '2000-01-01T00:00:00.000Z', profile: { headline: 'Hi', admin: true }, theme: { nonsense: true, colors: { magenta: '#ff00ff' } } }),
    );
    expect(site.ownerHostId).toBe('host_owner');
    expect(site.updatedAt.startsWith('2026')).toBe(true);
    const text = JSON.stringify(site);
    expect(text).not.toContain('nonsense');
    expect(text).not.toContain('magenta');
    expect(text).not.toContain('"admin"');
  });

  it('reports every bad field by its dotted path and saves nothing', async () => {
    const s = await signIn();
    const before = await repo.getSite(s.ctx);
    const fields = await fieldsOf(
      call(s, 'PUT', '/admin/site', {
        profile: { name: '   ', links: [{ label: '', url: 'javascript:alert(1)' }] },
        theme: {
          preset: 'no-such-preset',
          colors: { primary: 'red', accent: '#12345', text: 'rgb(0,0,0)' },
          darkColors: { background: '#gggggg' },
          background: { type: 'video', overlayOpacity: 2, blur: -1 },
          fontHeading: 'comic-sans',
          fontScale: 3,
          radius: 99,
          shadow: 9,
          layout: 'sideways',
          showAvatar: 'yes',
          texts: { ctaLabel: 'x'.repeat(41) },
        },
        assistant: { voice: 'not a voice name!', model: 'bad model id', language: 'english please', callWindowStartHour: 22, callWindowEndHour: 8 },
        booking: { consentText: '', privacyUrl: 'http://insecure.example.com', reminderOptInDefault: 'yes' },
        email: { provider: 'pigeon', fromEmail: 'not-an-address', replyTo: 'also not' },
      }),
    );
    expect(Object.keys(fields).sort()).toEqual(
      [
        'assistant.callWindowEndHour',
        'assistant.language',
        'assistant.model',
        'assistant.voice',
        'booking.consentText',
        'booking.privacyUrl',
        'booking.reminderOptInDefault',
        'email.fromEmail',
        'email.provider',
        'email.replyTo',
        'profile.links.0.label',
        'profile.links.0.url',
        'profile.name',
        'theme.background.blur',
        'theme.background.overlayOpacity',
        'theme.background.type',
        'theme.colors.accent',
        'theme.colors.primary',
        'theme.colors.text',
        'theme.darkColors.background',
        'theme.fontHeading',
        'theme.fontScale',
        'theme.layout',
        'theme.preset',
        'theme.radius',
        'theme.shadow',
        'theme.showAvatar',
        'theme.texts.ctaLabel',
      ].sort(),
    );
    expect(fields['theme.colors.primary']).toMatch(/hex colour/);
    expect(await repo.getSite(s.ctx)).toEqual(before);
  });

  it('limits the number of profile links', async () => {
    const s = await signIn();
    const links = Array.from({ length: 7 }, (_, i) => ({ label: `Link ${i}`, url: 'https://example.com' }));
    expect(Object.keys(await fieldsOf(call(s, 'PUT', '/admin/site', { profile: { links } })))).toEqual(['profile.links']);
  });

  it('cleans custom CSS so it cannot break out of its style element or load anything from elsewhere', async () => {
    const s = await signIn();
    const css = [
      '.m-card { color: red }',
      '</style><script>alert(1)</script>',
      '</STYLE >',
      '</sty</stylele>',
      '@import url("https://evil.example/x.css");',
      '.x { background: url(https://evil.example/a.png) }',
      '.y { width: expression(alert(1)) }',
    ].join('\n');
    const { site } = await ok<{ site: SiteSettings }>(call(s, 'PUT', '/admin/site', { theme: { customCss: css } }));
    const saved = site.theme.customCss;
    expect(saved).toContain('.m-card { color: red }');
    expect(saved.toLowerCase()).not.toContain('</style');
    expect(saved.toLowerCase()).not.toContain('<script');
    expect(saved).not.toContain('@import');
    expect(saved).not.toContain('evil.example');
    expect(saved).not.toContain('expression(');
  });

  it('accepts 20 kB of custom CSS and refuses more', async () => {
    const s = await signIn();
    const exactly = `.a{}${' '.repeat(20_000 - 8)}.b{}`;
    expect(exactly.length).toBe(20_000);
    await ok(call(s, 'PUT', '/admin/site', { theme: { customCss: exactly } }));
    const fields = await fieldsOf(call(s, 'PUT', '/admin/site', { theme: { customCss: `${exactly}x` } }));
    expect(fields['theme.customCss']).toMatch(/20 kB/);
    // Counted in bytes, so wide characters do not sneak more in.
    expect(Object.keys(await fieldsOf(call(s, 'PUT', '/admin/site', { theme: { customCss: 'é'.repeat(10_001) } })))).toEqual(['theme.customCss']);
  });

  it('only points at images that exist, and keeps the owner photo in step with the profile photo', async () => {
    const s = await signIn();
    const missing = await fieldsOf(call(s, 'PUT', '/admin/site', { theme: { logoAssetId: 'ast_doesnotexist0000', background: { imageAssetId: '../secrets' } }, profile: { avatarAssetId: 'ast_alsomissing00000' } }));
    expect(Object.keys(missing).sort()).toEqual(['profile.avatarAssetId', 'theme.background.imageAssetId', 'theme.logoAssetId']);

    const image = await upload(s, 'image/png', PNG, 'avatar');
    const { site } = await ok<{ site: SiteSettings }>(call(s, 'PUT', '/admin/site', { theme: { logoAssetId: image.id }, profile: { avatarAssetId: image.id } }));
    expect(site.theme.logoAssetId).toBe(image.id);
    expect(site.profile.avatarAssetId).toBe(image.id);
    const b = await ok<AdminBootstrap>(call(s, 'GET', '/admin/bootstrap'));
    expect(b.hosts[0].avatarUrl).toBe(`/meeting/api/assets/${image.id}`);

    const cleared = await ok<{ site: SiteSettings }>(call(s, 'PUT', '/admin/site', { profile: { avatarAssetId: null } }));
    expect(cleared.site.profile.avatarAssetId).toBeNull();
    expect((await repo.getHost(s.ctx, 'host_owner'))?.avatarAssetId).toBeNull();
  });

  it("keeps the owner's name in step with the profile name, and nobody else's", async () => {
    const s = await signIn();
    const alex = await addCoHost(s);
    expect((await repo.getHost(s.ctx, 'host_owner'))?.name).toBe('Jimi Cohen');

    await ok(call(s, 'PUT', '/admin/site', { profile: { name: '  Jimi A. Cohen ' } }));
    expect((await repo.getHost(s.ctx, 'host_owner'))?.name).toBe('Jimi A. Cohen');
    expect((await repo.getHost(s.ctx, alex.host.id))?.name).toBe('Alex Rivera');
    // The dashboard, event pages, emails and calls all read the host record, so they follow too.
    const b = await ok<AdminBootstrap>(call(s, 'GET', '/admin/bootstrap'));
    expect(b.hosts.map((h) => h.name)).toEqual(['Jimi A. Cohen', 'Alex Rivera']);

    // A save that does not touch the name leaves the host alone.
    const before = (await repo.getHost(s.ctx, 'host_owner'))?.updatedAt;
    await ok(call(s, 'PUT', '/admin/site', { profile: { headline: 'Time with Jimi' } }));
    expect((await repo.getHost(s.ctx, 'host_owner'))?.updatedAt).toBe(before);
  });

  it('wants a JSON object', async () => {
    const s = await signIn();
    expect((await call(s, 'PUT', '/admin/site', '[1,2,3]')).status).toBe(400);
    expect((await call(s, 'PUT', '/admin/site', 'not json at all')).status).toBe(400);
  });

  it('moves the reminder calls already planned when the calling hours change, and only then', async () => {
    const s = await signIn();
    const rule = { id: 'rem_call_2h', enabled: true, channel: 'call' as const, audience: 'invitee' as const, trigger: 'before_start' as const, offsetMinutes: 120 };
    await repo.saveEventType(s.ctx, { ...(await repo.getEventType(s.ctx, 'evt_intro'))!, reminders: [rule] });
    // A 10 AM meeting in New York: its call was planned for 8 AM there, when calling hours open by default.
    const booking = await seedBooking(s.ctx, 'bk_call', { start: '2026-11-18T15:00:00.000Z', consent: { sms: false, call: true, at: TEST_NOW, text: 'ok' } });
    const job: Job & { forStart: string } = {
      key: 'jobs/2026-11-18T13:00:00.000Z_job_call1',
      id: 'job_call1',
      type: 'message',
      bookingId: booking.id,
      dueAt: '2026-11-18T13:00:00.000Z',
      attempt: 0,
      createdAt: TEST_NOW,
      channel: 'call',
      audience: 'invitee',
      kind: 'reminder',
      ruleId: rule.id,
      forStart: booking.start,
    };
    await repo.putJob(s.ctx, job);
    const calls = async () => (await repo.listJobs(s.ctx)).map((j) => [j.id, j.dueAt]);

    await ok(call(s, 'PUT', '/admin/site', { assistant: { name: 'Mia' } }));
    await s.ctx.settle();
    expect(await calls()).toEqual([['job_call1', '2026-11-18T13:00:00.000Z']]);

    await ok(call(s, 'PUT', '/admin/site', { assistant: { callWindowStartHour: 9 } }));
    await s.ctx.settle();
    expect(await calls()).toEqual([['job_call1', '2026-11-18T14:00:00.000Z']]); // 9 AM in New York
    expect(s.ctx.logs.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  });

  it('plans the reminder call of a booking that the old calling hours had left without one', async () => {
    const s = await signIn();
    const rule = { id: 'rem_call_2h', enabled: true, channel: 'call' as const, audience: 'invitee' as const, trigger: 'before_start' as const, offsetMinutes: 120 };
    await repo.saveEventType(s.ctx, { ...(await repo.getEventType(s.ctx, 'evt_intro'))!, reminders: [rule] });
    // A 10 AM meeting in New York with no call queued: the hours it was booked under had no time for it.
    const booking = await seedBooking(s.ctx, 'bk_nocall', { start: '2026-11-18T15:00:00.000Z', consent: { sms: false, call: true, at: TEST_NOW, text: 'ok' } });
    await ok(call(s, 'PUT', '/admin/site', { assistant: { callWindowStartHour: 9 } }));
    await s.ctx.settle();
    const calls = (await repo.listJobs(s.ctx)).filter((j) => j.channel === 'call');
    expect(calls.map((j) => [j.bookingId, j.ruleId, j.dueAt])).toEqual([[booking.id, rule.id, '2026-11-18T14:00:00.000Z']]); // 9 AM in New York
    expect(s.ctx.logs.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  });

  it('a failing move of the reminder calls never fails the save', async () => {
    const s = await signIn();
    vi.spyOn(repo, 'listJobs').mockRejectedValue(new Error('storage hiccup'));
    const { site } = await ok<{ site: SiteSettings }>(call(s, 'PUT', '/admin/site', { assistant: { callWindowStartHour: 9 } }));
    expect(site.assistant.callWindowStartHour).toBe(9);
    await s.ctx.settle();
    expect(s.ctx.logs.some((l) => l.level === 'error' && l.msg.includes('re-planning reminder calls'))).toBe(true);
  });
});

// ───────────────────────── event types ─────────────────────────

describe('event types', () => {
  it('creates one from just a title, with the defaults and ids of its own', async () => {
    const s = await signIn();
    const { eventType } = await ok<{ eventType: EventType }>(
      call(s, 'POST', '/admin/event-types', { title: '  Coffee  chat ', id: 'evt_hacked', position: -5, createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z' }),
      201,
    );
    expect(eventType.id).toMatch(/^evt_[a-z2-7]{16}$/);
    expect(eventType).toMatchObject({
      title: 'Coffee chat',
      slug: 'coffee-chat',
      kind: 'solo',
      hostIds: ['host_owner'],
      durations: [30],
      defaultDuration: 30,
      active: true,
      visibility: 'public',
      position: 2,
      createdAt: TEST_NOW,
    });
    expect(eventType.reminders.length).toBeGreaterThan(0);
    expect(await repo.getEventType(s.ctx, eventType.id)).toEqual(eventType);

    // The same title again gets the next free link.
    const again = await ok<{ eventType: EventType }>(call(s, 'POST', '/admin/event-types', { title: 'Coffee chat' }), 201);
    expect(again.eventType.slug).toBe('coffee-chat-2');
    expect(again.eventType.position).toBe(3);
    // A title that would land on a reserved address does too.
    const reserved = await ok<{ eventType: EventType }>(call(s, 'POST', '/admin/event-types', { title: 'Admin' }), 201);
    expect(reserved.eventType.slug).toBe('admin-2');
  });

  it('creates a joint meeting the way the Team page does', async () => {
    const s = await signIn();
    const { host } = await addCoHost(s);
    const { eventType } = await ok<{ eventType: EventType }>(
      call(s, 'POST', '/admin/event-types', {
        title: 'Meet Jimi and Alex',
        slug: 'jimi-and-alex',
        description: 'A meeting with both of us.',
        kind: 'collective',
        hostIds: ['host_owner', host.id],
        durations: [30],
        defaultDuration: 30,
      }),
      201,
    );
    expect(eventType).toMatchObject({ kind: 'collective', hostIds: ['host_owner', host.id], slug: 'jimi-and-alex' });
  });

  const BAD: [what: string, body: Record<string, unknown>, field: string][] = [
    ['no title', {}, 'title'],
    ['an empty title', { title: '   ' }, 'title'],
    ['a title that is too long', { title: 'x'.repeat(81) }, 'title'],
    ['a link with capitals and spaces', { title: 'A', slug: 'Not A Slug' }, 'slug'],
    ['a link with a dash at the end', { title: 'A', slug: 'bad-' }, 'slug'],
    ['a reserved link', { title: 'A', slug: 'admin' }, 'slug'],
    ['another reserved link', { title: 'A', slug: 'booking' }, 'slug'],
    ['a link that is taken', { title: 'A', slug: 'intro' }, 'slug'],
    ['a link that is too long', { title: 'A', slug: 'a'.repeat(61) }, 'slug'],
    ['no lengths', { title: 'A', durations: [] }, 'durations'],
    ['a length under 5 minutes', { title: 'A', durations: [3] }, 'durations'],
    ['a length over 8 hours', { title: 'A', durations: [30, 481] }, 'durations'],
    ['half minutes', { title: 'A', durations: [30.5] }, 'durations'],
    ['lengths that are not numbers', { title: 'A', durations: ['30'] }, 'durations'],
    ['a default length that is not on offer', { title: 'A', durations: [30], defaultDuration: 45 }, 'defaultDuration'],
    ['no hosts', { title: 'A', hostIds: [] }, 'hostIds'],
    ['a host who is not on the team', { title: 'A', hostIds: ['host_nobody'] }, 'hostIds'],
    ['a joint meeting with one host', { title: 'A', kind: 'collective', hostIds: ['host_owner'] }, 'hostIds'],
    ['a round robin with one host', { title: 'A', kind: 'round_robin' }, 'hostIds'],
    ['an unknown kind', { title: 'A', kind: 'webinar' }, 'kind'],
    ['negative notice', { title: 'A', scheduling: { minNoticeMinutes: -1 } }, 'scheduling.minNoticeMinutes'],
    ['a booking window of zero days', { title: 'A', scheduling: { maxDaysAhead: 0 } }, 'scheduling.maxDaysAhead'],
    ['a huge buffer', { title: 'A', scheduling: { bufferBeforeMin: 999 } }, 'scheduling.bufferBeforeMin'],
    ['a buffer that is not a number', { title: 'A', scheduling: { bufferAfterMin: '10' } }, 'scheduling.bufferAfterMin'],
    ['start times every 3 minutes', { title: 'A', scheduling: { slotIncrementMin: 3 } }, 'scheduling.slotIncrementMin'],
    ['a daily limit of zero', { title: 'A', scheduling: { maxPerDay: 0 } }, 'scheduling.maxPerDay'],
    ['a date range that ends before it starts', { title: 'A', scheduling: { dateRange: { start: '2026-12-10', end: '2026-12-01' } } }, 'scheduling.dateRange.end'],
    ['a date range with an impossible date', { title: 'A', scheduling: { dateRange: { start: '2026-02-30', end: '2026-03-01' } } }, 'scheduling.dateRange.start'],
    ['limited hours with every day off', { title: 'A', scheduling: { restrictHours: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] } } }, 'scheduling.restrictHours'],
    ['limited hours that overlap', { title: 'A', scheduling: { restrictHours: { 1: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] } } }, 'scheduling.restrictHours'],
    ['a question without words', { title: 'A', questions: [{ id: 'q1', label: ' ', type: 'text', required: false }] }, 'questions.0.label'],
    ['a second question without words', { title: 'A', questions: [{ label: 'Fine' }, { label: '' }] }, 'questions.1.label'],
    ['a choice question without choices', { title: 'A', questions: [{ label: 'Pick one', type: 'select', options: [' '] }] }, 'questions.0.options'],
    ['an unknown question type', { title: 'A', questions: [{ label: 'Hm', type: 'file' }] }, 'questions.0.type'],
    ['a reminder more than 30 days out', { title: 'A', reminders: [{ channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 43201 }] }, 'reminders.0.offsetMinutes'],
    ['a reminder with a negative offset', { title: 'A', reminders: [{ channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: -5 }] }, 'reminders.0.offsetMinutes'],
    ['a reminder by fax', { title: 'A', reminders: [{ channel: 'fax', audience: 'invitee', trigger: 'before_start', offsetMinutes: 60 }] }, 'reminders.0.channel'],
    ['a reminder for nobody', { title: 'A', reminders: [{ channel: 'email', audience: 'everyone', trigger: 'before_start', offsetMinutes: 60 }] }, 'reminders.0.audience'],
    ['a reminder with no timing', { title: 'A', reminders: [{ channel: 'email', audience: 'invitee', offsetMinutes: 60 }] }, 'reminders.0.trigger'],
    ['a reminder call to the host', { title: 'A', reminders: [{ channel: 'call', audience: 'host', trigger: 'before_start', offsetMinutes: 60 }] }, 'reminders.0.audience'],
    ['a reminder call after the meeting', { title: 'A', reminders: [{ channel: 'call', audience: 'invitee', trigger: 'after_end', offsetMinutes: 60 }] }, 'reminders.0.trigger'],
    ['no location', { title: 'A', locations: [] }, 'locations'],
    ['an in-person meeting without an address', { title: 'A', locations: [{ type: 'in_person' }] }, 'locations.0.value'],
    ['a video link that is not https', { title: 'A', locations: [{ type: 'google_meet' }, { type: 'custom_link', value: 'http://zoom.example/room' }] }, 'locations.1.value'],
    ['a phone location without a number', { title: 'A', locations: [{ type: 'phone_invitee_calls', value: 'call me' }] }, 'locations.0.value'],
    ['an unknown location type', { title: 'A', locations: [{ type: 'hologram' }] }, 'locations.0'],
    ['a redirect that is not https', { title: 'A', confirmation: { redirectUrl: 'http://example.com/thanks' } }, 'confirmation.redirectUrl'],
    ['a redirect that is a script', { title: 'A', confirmation: { redirectUrl: 'javascript:alert(1)' } }, 'confirmation.redirectUrl'],
    ['a colour that is a word', { title: 'A', color: 'red' }, 'color'],
    ['an unknown visibility', { title: 'A', visibility: 'secret' }, 'visibility'],
    ['an unknown phone setting', { title: 'A', phone: 'maybe' }, 'phone'],
    ['too many guests', { title: 'A', maxGuests: 99 }, 'maxGuests'],
    ['a look that does not exist', { title: 'A', themeOverride: { layout: 'sideways' } }, 'themeOverride.layout'],
    ['a cover image that does not exist', { title: 'A', coverAssetId: 'ast_missing000000000' }, 'coverAssetId'],
    ['active that is not a switch', { title: 'A', active: 'yes' }, 'active'],
  ];

  it.each(BAD)('refuses %s', async (_what, body, field) => {
    const s = await signIn();
    const fields = await fieldsOf(call(s, 'POST', '/admin/event-types', body));
    expect(Object.keys(fields)).toEqual([field]);
    expect(fields[field].length).toBeGreaterThan(5);
    expect(await repo.listEventTypes(s.ctx)).toHaveLength(2);
  });

  it('reports several problems at once, and the same rules hold when editing', async () => {
    const s = await signIn();
    const fields = await fieldsOf(
      call(s, 'PUT', '/admin/event-types/evt_intro', {
        title: '',
        slug: 'meeting',
        durations: [1],
        reminders: [{ channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 60 }, { channel: 'sms', audience: 'invitee', trigger: 'before_start', offsetMinutes: 99999 }],
        confirmation: { redirectUrl: 'ftp://example.com' },
      }),
    );
    expect(Object.keys(fields).sort()).toEqual(['confirmation.redirectUrl', 'durations', 'reminders.1.offsetMinutes', 'slug', 'title']);
    expect((await repo.getEventType(s.ctx, 'evt_intro'))?.title).toBe('Intro call');
  });

  it('applies a partial edit and keeps what the server owns', async () => {
    const s = await signIn();
    const before = (await repo.getEventType(s.ctx, 'evt_intro'))!;
    s.ctx.clock.advance(60_000);
    const toggled = await ok<{ eventType: EventType }>(call(s, 'PUT', '/admin/event-types/evt_intro', { active: false }));
    expect(toggled.eventType).toEqual({ ...before, active: false, updatedAt: s.ctx.now().toISOString() });

    const edited = await ok<{ eventType: EventType }>(
      call(s, 'PUT', '/admin/event-types/evt_intro', {
        id: 'evt_other',
        position: 40,
        createdAt: '1999-01-01T00:00:00.000Z',
        slug: 'intro',
        title: 'Intro',
        durations: [45, 15, 45],
        scheduling: { minNoticeMinutes: 60, scheduleIds: { host_owner: 'sch_gone', host_stranger: 'sch_default' } },
        questions: [{ id: 'q_topic', label: 'Topic?', type: 'radio', required: true, options: ['A', ' B ', 'A', ''] }, { label: 'Anything else?' }],
        reminders: [{ id: 'rem_1', enabled: false, channel: 'sms', audience: 'invitee', trigger: 'before_start', offsetMinutes: 30, subject: 'ignored for texts', body: 'See you soon' }],
        locations: [{ type: 'custom_link', value: ' https://zoom.example/my-room ', label: 'Zoom' }, { type: 'google_meet', value: 'dropped' }],
        confirmation: { message: 'Thanks!', redirectUrl: '' },
        color: '#FA0',
        themeOverride: { layout: 'stacked', colors: {}, nonsense: 1 },
      }),
    );
    const et = edited.eventType;
    expect(et.id).toBe('evt_intro');
    expect(et.position).toBe(before.position);
    expect(et.createdAt).toBe(before.createdAt);
    expect(et.durations).toEqual([15, 45]);
    expect(et.defaultDuration).toBe(15);
    expect(et.scheduling).toEqual({ ...before.scheduling, minNoticeMinutes: 60, scheduleIds: {} });
    expect(et.questions[0]).toEqual({ id: 'q_topic', label: 'Topic?', type: 'radio', required: true, options: ['A', 'B'] });
    expect(et.questions[1]).toMatchObject({ label: 'Anything else?', type: 'text', required: false });
    expect(et.questions[1].id).toMatch(/^q_/);
    expect(et.reminders).toEqual([{ id: 'rem_1', enabled: false, channel: 'sms', audience: 'invitee', trigger: 'before_start', offsetMinutes: 30, body: 'See you soon' }]);
    expect(et.locations).toEqual([{ type: 'custom_link', value: 'https://zoom.example/my-room', label: 'Zoom' }, { type: 'google_meet' }]);
    expect(et.confirmation).toEqual({ message: 'Thanks!', redirectUrl: '' });
    expect(et.color).toBe('#ffaa00');
    expect(et.themeOverride).toEqual({ layout: 'stacked' });

    expect((await errorOf(call(s, 'PUT', '/admin/event-types/evt_missing', { active: true }), 404)).code).toBe('not_found');
  });

  it('round-trips an event type sent back whole, as the editor does', async () => {
    const s = await signIn();
    const before = (await repo.getEventType(s.ctx, 'evt_meeting'))!;
    const { eventType } = await ok<{ eventType: EventType }>(call(s, 'PUT', '/admin/event-types/evt_meeting', before));
    expect({ ...eventType, updatedAt: before.updatedAt }).toEqual(before);
  });

  it('turns the store refusing a taken link into the same field message', async () => {
    const s = await signIn();
    // Two saves that passed the first check at the same moment: the store catches the second one.
    vi.spyOn(repo, 'saveEventType').mockRejectedValueOnce(new HttpError(409, 'slug_taken', 'Another event type already uses that link.', { slug: 'This link is already in use.' }));
    const fields = await fieldsOf(call(s, 'POST', '/admin/event-types', { title: 'Racing', slug: 'racing' }));
    expect(fields).toEqual({ slug: 'Another event type already uses this link.' });
  });

  it('refuses to delete an event type that still has upcoming bookings', async () => {
    const s = await signIn();
    await seedBooking(s.ctx, 'bk_up');
    await seedBooking(s.ctx, 'bk_up2', { start: hoursFromNow(72) });
    await seedBooking(s.ctx, 'bk_old', { start: hoursFromNow(-72) });
    await seedBooking(s.ctx, 'bk_gone', { status: 'cancelled' });
    const refused = await errorOf(call(s, 'DELETE', '/admin/event-types/evt_intro'), 409);
    expect(refused.code).toBe('has_upcoming_bookings');
    expect(refused.message).toContain('2 upcoming bookings');
    expect(refused.message).toMatch(/Switch it off instead/);
    expect(await repo.getEventType(s.ctx, 'evt_intro')).not.toBeNull();

    // An event type nobody has booked goes at once. Past and cancelled bookings do not hold one back.
    await ok(call(s, 'DELETE', '/admin/event-types/evt_meeting'));
    expect(await repo.getEventType(s.ctx, 'evt_meeting')).toBeNull();
    await ok(call(s, 'POST', '/admin/bookings/bk_up/cancel', {}));
    await ok(call(s, 'POST', '/admin/bookings/bk_up2/cancel', {}));
    await ok(call(s, 'DELETE', '/admin/event-types/evt_intro'));
    expect(await repo.listEventTypes(s.ctx)).toEqual([]);
    // Deleting what is already gone is not an error.
    await ok(call(s, 'DELETE', '/admin/event-types/evt_intro'));
  });

  it('duplicates as "Copy of ..." with a free link', async () => {
    const s = await signIn();
    const first = await ok<{ eventType: EventType }>(call(s, 'POST', '/admin/event-types/evt_intro/duplicate', {}), 201);
    const source = (await repo.getEventType(s.ctx, 'evt_intro'))!;
    expect(first.eventType).toEqual({ ...source, id: first.eventType.id, title: 'Copy of Intro call', slug: 'intro-copy', position: 2 });
    expect(first.eventType.id).not.toBe('evt_intro');
    const second = await ok<{ eventType: EventType }>(call(s, 'POST', '/admin/event-types/evt_intro/duplicate', {}), 201);
    expect(second.eventType).toMatchObject({ slug: 'intro-copy-2', title: 'Copy of Intro call', position: 3 });
    expect((await errorOf(call(s, 'POST', '/admin/event-types/evt_nope/duplicate', {}), 404)).code).toBe('not_found');
  });

  it('reorders, keeping ids it was not told about at the end', async () => {
    const s = await signIn();
    const extra = await ok<{ eventType: EventType }>(call(s, 'POST', '/admin/event-types', { title: 'Third' }), 201);
    const res = await ok<{ ok: boolean; eventTypes: EventType[] }>(call(s, 'PUT', '/admin/event-types-order', { ids: [extra.eventType.id, 'evt_unknown', 'evt_meeting'] }));
    expect(res.eventTypes.map((e) => e.id)).toEqual([extra.eventType.id, 'evt_meeting', 'evt_intro']);
    expect((await repo.listEventTypes(s.ctx)).map((e) => e.position)).toEqual([0, 1, 2]);
    expect(Object.keys(await fieldsOf(call(s, 'PUT', '/admin/event-types-order', { ids: 'evt_intro' })))).toEqual(['ids']);
  });

  it('re-plans the reminders of upcoming bookings when the rules change, and only then', async () => {
    const s = await signIn();
    const upcoming = await seedBooking(s.ctx, 'bk_up', { start: hoursFromNow(72) });
    await seedBooking(s.ctx, 'bk_old', { start: hoursFromNow(-72) });
    await seedBooking(s.ctx, 'bk_gone', { status: 'cancelled', start: hoursFromNow(72) });
    await seedBooking(s.ctx, 'bk_other', { eventTypeId: 'evt_meeting', start: hoursFromNow(72) });
    const rule = { id: 'rem_new', enabled: true, channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 120 };

    await ok(call(s, 'PUT', '/admin/event-types/evt_intro', { reminders: [rule] }));
    await s.ctx.settle();
    let jobs = await repo.listJobs(s.ctx);
    expect(jobs.map((j) => [j.bookingId, j.ruleId, j.dueAt])).toEqual([['bk_up', 'rem_new', new Date(Date.parse(upcoming.start) - 120 * 60_000).toISOString()]]);

    // Saving the same rules again, or something unrelated, plans nothing.
    for (const job of jobs) await repo.deleteJob(s.ctx, job.key);
    await ok(call(s, 'PUT', '/admin/event-types/evt_intro', { reminders: [rule] }));
    await ok(call(s, 'PUT', '/admin/event-types/evt_intro', { title: 'Intro call, renamed' }));
    await s.ctx.settle();
    expect(await repo.listJobs(s.ctx)).toEqual([]);

    // A changed rule replaces the pending reminder instead of adding a second one.
    await ok(call(s, 'PUT', '/admin/event-types/evt_intro', { reminders: [{ ...rule, offsetMinutes: 30 }] }));
    await ok(call(s, 'PUT', '/admin/event-types/evt_intro', { reminders: [{ ...rule, offsetMinutes: 45 }] }));
    await s.ctx.settle();
    jobs = await repo.listJobs(s.ctx);
    expect(jobs.map((j) => [j.bookingId, j.dueAt])).toEqual([['bk_up', new Date(Date.parse(upcoming.start) - 45 * 60_000).toISOString()]]);
    expect(s.ctx.logs.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('reads the job queue once when it re-plans many bookings, not once for each', async () => {
    const s = await signIn();
    for (let i = 0; i < 5; i++) await seedBooking(s.ctx, `bk_up${i}`, { start: hoursFromNow(72 + i) });
    const rule = { id: 'rem_new', enabled: true, channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 120 };
    const listJobs = vi.spyOn(repo, 'listJobs');
    await ok(call(s, 'PUT', '/admin/event-types/evt_intro', { reminders: [rule] }));
    await s.ctx.settle();
    expect(listJobs).toHaveBeenCalledTimes(1);
    expect((await repo.listJobs(s.ctx)).map((j) => j.bookingId).sort()).toEqual(['bk_up0', 'bk_up1', 'bk_up2', 'bk_up3', 'bk_up4']);
  });

  it('a failing re-plan never fails the save', async () => {
    const s = await signIn();
    await seedBooking(s.ctx, 'bk_up', { start: hoursFromNow(72) });
    vi.spyOn(repo, 'getBookingIndex').mockRejectedValue(new Error('storage hiccup'));
    const rule = { id: 'rem_new', enabled: true, channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 120 };
    await ok(call(s, 'PUT', '/admin/event-types/evt_intro', { reminders: [rule] }));
    await s.ctx.settle();
    expect(s.ctx.logs.some((l) => l.level === 'error' && l.msg.includes('re-planning'))).toBe(true);
  });
});

// ───────────────────────── team ─────────────────────────

describe('hosts', () => {
  it('adds a co-host with a private link that is shown once and stored only as a hash', async () => {
    const s = await signIn();
    const res = await call(s, 'POST', '/admin/hosts', { name: ' Alex  Rivera ', email: ' alex@example.com ' });
    const text = await res.text();
    expect(res.status).toBe(201);
    const { host, inviteUrl } = JSON.parse(text) as { host: AdminHost; inviteUrl: string };
    expect(host).toMatchObject({ role: 'member', name: 'Alex Rivera', email: 'alex@example.com', timezoneMode: 'device', hasInviteLink: true, google: null });
    expect(host.schedules).toHaveLength(1);
    expect(host.defaultScheduleId).toBe(host.schedules[0].id);

    const url = new URL(inviteUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${TEST_BASE_URL}/host/${host.id}`);
    const token = url.searchParams.get('t')!;
    expect(token.length).toBeGreaterThanOrEqual(32);
    const stored = (await repo.getHost(s.ctx, host.id))!;
    expect(stored.inviteTokenHash).toBe(sha256Hex(token));
    expect(text).not.toContain(stored.inviteTokenHash!);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect((await hostFromToken(s.ctx, host.id, token))?.id).toBe(host.id);

    const listed = await ok<{ hosts: AdminHost[] }>(call(s, 'GET', '/admin/hosts'));
    expect(listed.hosts.map((h) => h.id)).toEqual(['host_owner', host.id]);
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  it('checks the name and the email address, and each address is used once', async () => {
    const s = await signIn();
    expect(Object.keys(await fieldsOf(call(s, 'POST', '/admin/hosts', {}))).sort()).toEqual(['email', 'name']);
    expect(Object.keys(await fieldsOf(call(s, 'POST', '/admin/hosts', { name: 'Alex', email: 'alex@' })))).toEqual(['email']);
    await addCoHost(s);
    const dup = await fieldsOf(call(s, 'POST', '/admin/hosts', { name: 'Other Alex', email: 'ALEX@example.com' }));
    expect(dup.email).toMatch(/already on the team/);
    expect(await repo.listHosts(s.ctx)).toHaveLength(2);
  });

  it('rotates the link: the old one dies, the new one works', async () => {
    const s = await signIn();
    const { host, token } = await addCoHost(s);
    const rotated = await ok<{ host: AdminHost; inviteUrl: string }>(call(s, 'POST', `/admin/hosts/${host.id}/invite`, {}));
    const fresh = new URL(rotated.inviteUrl).searchParams.get('t')!;
    expect(fresh).not.toBe(token);
    expect(rotated.host.hasInviteLink).toBe(true);
    expect(await hostFromToken(s.ctx, host.id, token)).toBeNull();
    expect((await hostFromToken(s.ctx, host.id, fresh))?.id).toBe(host.id);

    expect((await errorOf(call(s, 'POST', '/admin/hosts/host_owner/invite', {}), 400)).code).toBe('owner_uses_dashboard');
    expect((await repo.getHost(s.ctx, 'host_owner'))?.inviteTokenHash ?? null).toBeNull();
    expect((await errorOf(call(s, 'POST', '/admin/hosts/host_nobody/invite', {}), 404)).code).toBe('not_found');
  });

  it('removes a co-host, but never the owner and never someone an event type still needs', async () => {
    const s = await signIn();
    const { host, token } = await addCoHost(s);
    expect((await errorOf(call(s, 'DELETE', '/admin/hosts/host_owner'), 400)).code).toBe('owner_required');

    await ok(call(s, 'POST', '/admin/event-types', { title: 'Together', kind: 'collective', hostIds: ['host_owner', host.id] }), 201);
    await ok(call(s, 'POST', '/admin/event-types', { title: 'Either of us', kind: 'round_robin', hostIds: [host.id, 'host_owner'] }), 201);
    const refused = await errorOf(call(s, 'DELETE', `/admin/hosts/${host.id}`), 409);
    expect(refused.code).toBe('host_in_use');
    expect(refused.message).toContain('"Together"');
    expect(refused.message).toContain('"Either of us"');
    expect(await repo.getHost(s.ctx, host.id)).not.toBeNull();

    for (const et of await repo.listEventTypes(s.ctx)) {
      if (et.hostIds.includes(host.id)) await ok(call(s, 'PUT', `/admin/event-types/${et.id}`, { kind: 'solo', hostIds: ['host_owner'] }));
    }
    await ok(call(s, 'DELETE', `/admin/hosts/${host.id}`));
    expect(await repo.getHost(s.ctx, host.id)).toBeNull();
    expect(await hostFromToken(s.ctx, host.id, token)).toBeNull();
    await ok(call(s, 'DELETE', `/admin/hosts/${host.id}`));
    expect(await repo.listHosts(s.ctx)).toHaveLength(1);
  });

  it('edits details, and keeps email addresses unique', async () => {
    const s = await signIn();
    const { host } = await addCoHost(s);
    const res = await ok<{ host: AdminHost }>(call(s, 'PUT', `/admin/hosts/${host.id}`, { name: 'Alexandra Rivera', title: 'Head of Partnerships', email: 'alexandra@example.com', phone: '+1 415 555 2671', notify: { email: false, sms: true } }));
    expect(res.host).toMatchObject({ name: 'Alexandra Rivera', title: 'Head of Partnerships', email: 'alexandra@example.com', phone: '+14155552671', notify: { email: false, sms: true } });
    await ok(call(s, 'PUT', '/admin/hosts/host_owner', { email: 'jimi@example.com' }));
    const fields = await fieldsOf(call(s, 'PUT', `/admin/hosts/${host.id}`, { name: '', email: 'jimi@example.com', phone: '12345', notify: 'all' }));
    expect(Object.keys(fields).sort()).toEqual(['email', 'name', 'notify', 'phone']);
    const cleared = await ok<{ host: AdminHost }>(call(s, 'PUT', `/admin/hosts/${host.id}`, { phone: '' }));
    expect(cleared.host.phone).toBeUndefined();
    expect((await errorOf(call(s, 'PUT', '/admin/hosts/host_nobody', { name: 'X' }), 404)).code).toBe('not_found');
  });

  describe('time zone', () => {
    it('follows the device while the mode is "device", and says when it changed', async () => {
      const s = await signIn();
      const first = await ok<{ host: AdminHost; timezone: string; timezoneChanged: boolean }>(call(s, 'PUT', '/admin/hosts/host_owner', { deviceTimezone: 'Africa/Nairobi' }));
      expect(first).toMatchObject({ timezone: 'Africa/Nairobi', timezoneChanged: true });
      expect(first.host.timezone).toBe('Africa/Nairobi');
      expect(first.host.timezoneMode).toBe('device');

      // The dashboard reports the zone on every load: the same zone again changes and writes nothing.
      const stamp = (await repo.getHost(s.ctx, 'host_owner'))!.updatedAt;
      s.ctx.clock.advance(5000);
      const again = await ok<{ timezone: string; timezoneChanged: boolean }>(call(s, 'PUT', '/admin/hosts/host_owner', { deviceTimezone: 'Africa/Nairobi' }));
      expect(again).toMatchObject({ timezone: 'Africa/Nairobi', timezoneChanged: false });
      expect((await repo.getHost(s.ctx, 'host_owner'))!.updatedAt).toBe(stamp);

      // A zone we cannot use is not applied, and is not an error either.
      const odd = await ok<{ timezone: string; timezoneChanged: boolean }>(call(s, 'PUT', '/admin/hosts/host_owner', { deviceTimezone: 'Mars/Olympus' }));
      expect(odd).toMatchObject({ timezone: 'Africa/Nairobi', timezoneChanged: false });
    });

    it('stays put while the mode is "fixed"', async () => {
      const s = await signIn();
      const fixed = await ok<{ host: AdminHost; timezoneChanged: boolean }>(call(s, 'PUT', '/admin/hosts/host_owner', { timezoneMode: 'fixed', timezone: 'Europe/London' }));
      expect(fixed.host).toMatchObject({ timezoneMode: 'fixed', timezone: 'Europe/London' });
      expect(fixed.timezoneChanged).toBe(true);
      const ping = await ok<{ timezone: string; timezoneChanged: boolean }>(call(s, 'PUT', '/admin/hosts/host_owner', { deviceTimezone: 'Asia/Tokyo' }));
      expect(ping).toMatchObject({ timezone: 'Europe/London', timezoneChanged: false });
      // Back to following the device, with the zone the browser reports right now.
      const back = await ok<{ host: AdminHost }>(call(s, 'PUT', '/admin/hosts/host_owner', { timezoneMode: 'device', deviceTimezone: 'Asia/Tokyo' }));
      expect(back.host).toMatchObject({ timezoneMode: 'device', timezone: 'Asia/Tokyo' });
      expect(Object.keys(await fieldsOf(call(s, 'PUT', '/admin/hosts/host_owner', { timezoneMode: 'fixed', timezone: 'Not/AZone' })))).toEqual(['timezone']);
      expect(Object.keys(await fieldsOf(call(s, 'PUT', '/admin/hosts/host_owner', { timezoneMode: 'sundial' })))).toEqual(['timezoneMode']);
    });

    it('is left to Google Calendar while the mode is "google"', async () => {
      const s = await signIn();
      // Not connected: there is nothing to follow.
      const fields = await fieldsOf(call(s, 'PUT', '/admin/hosts/host_owner', { timezoneMode: 'google' }));
      expect(fields.timezoneMode).toMatch(/Connect Google Calendar first/);

      await connectGoogle(s.ctx);
      await repo.saveSecrets(s.ctx, { google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret-value' } });
      const calls = useFetch(s.ctx, (c) => {
        if (c.url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at-1', expires_in: 3600 });
        if (c.url.endsWith('/users/me/settings/timezone')) return Response.json({ value: 'America/New_York' });
        throw new Error(`unexpected ${c.url}`);
      });
      const switched = await ok<{ host: AdminHost; timezone: string; timezoneChanged: boolean }>(call(s, 'PUT', '/admin/hosts/host_owner', { timezoneMode: 'google' }));
      expect(switched).toMatchObject({ timezone: 'America/New_York', timezoneChanged: true });
      expect(switched.host.timezoneMode).toBe('google');

      // The device no longer has a say, and nobody asks Google on a plain page load.
      const before = calls.length;
      const ping = await ok<{ timezone: string; timezoneChanged: boolean }>(call(s, 'PUT', '/admin/hosts/host_owner', { deviceTimezone: 'Asia/Tokyo' }));
      expect(ping).toMatchObject({ timezone: 'America/New_York', timezoneChanged: false });
      expect(calls.length).toBe(before);
    });
  });

  describe('schedules', () => {
    const week = (monday: unknown): Record<string, unknown> => ({ 0: [], 1: monday, 2: [], 3: [], 4: [], 5: [], 6: [] });
    const schedule = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'sch_default', name: 'Working hours', weekly: week([{ start: '09:00', end: '17:00' }]), overrides: [], ...over });

    it('saves valid hours, sorted, with "24:00" allowed as an end', async () => {
      const s = await signIn();
      const res = await ok<{ host: AdminHost }>(
        call(s, 'PUT', '/admin/hosts/host_owner', {
          schedules: [
            schedule({
              weekly: week([{ start: '13:00', end: '24:00' }, { start: '08:00', end: '12:00' }]),
              overrides: [{ date: '2026-12-25', ranges: [] }, { date: '2026-12-24', ranges: [{ start: '09:00', end: '12:00' }] }],
            }),
            { id: 'sch_evenings', name: ' Evenings ', weekly: { 2: [{ start: '18:00', end: '21:00' }] } },
          ],
          defaultScheduleId: 'sch_evenings',
        }),
      );
      expect(res.host.defaultScheduleId).toBe('sch_evenings');
      expect(res.host.schedules[0].weekly[1]).toEqual([{ start: '08:00', end: '12:00' }, { start: '13:00', end: '24:00' }]);
      expect(res.host.schedules[0].overrides.map((o) => o.date)).toEqual(['2026-12-24', '2026-12-25']);
      expect(res.host.schedules[1]).toEqual({ id: 'sch_evenings', name: 'Evenings', weekly: { 0: [], 1: [], 2: [{ start: '18:00', end: '21:00' }], 3: [], 4: [], 5: [], 6: [] }, overrides: [] });
    });

    const BAD_SCHEDULES: [what: string, schedules: unknown, field: string, message: RegExp][] = [
      ['overlapping ranges', [schedule({ weekly: week([{ start: '09:00', end: '12:00' }, { start: '11:30', end: '14:00' }]) })], 'schedules.0.weekly.1', /Working hours, Monday: these times overlap/],
      ['a range that ends before it starts', [schedule({ weekly: week([{ start: '17:00', end: '09:00' }]) })], 'schedules.0.weekly.1', /end after it starts/],
      ['a range of no length', [schedule({ weekly: week([{ start: '09:00', end: '09:00' }]) })], 'schedules.0.weekly.1', /end after it starts/],
      ['a time that is not a time', [schedule({ weekly: week([{ start: '9am', end: '17:00' }]) })], 'schedules.0.weekly.1', /09:00/],
      ['a start at 24:00', [schedule({ weekly: week([{ start: '24:00', end: '24:00' }]) })], 'schedules.0.weekly.1', /09:00/],
      ['13 ranges in a day', [schedule({ weekly: week(Array.from({ length: 13 }, (_, i) => ({ start: `${String(i + 8).padStart(2, '0')}:00`, end: `${String(i + 8).padStart(2, '0')}:30` }))) })], 'schedules.0.weekly.1', /at most 12/],
      ['367 date overrides', [schedule({ overrides: Array.from({ length: 367 }, (_, i) => ({ date: new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10), ranges: [] })) })], 'schedules.0.overrides', /at most 366/],
      ['an override on a date that does not exist', [schedule({ overrides: [{ date: '2026-02-30', ranges: [] }] })], 'schedules.0.overrides.0.date', /valid date/],
      ['the same date twice', [schedule({ overrides: [{ date: '2026-12-24', ranges: [] }, { date: '2026-12-24', ranges: [] }] })], 'schedules.0.overrides.1.date', /twice/],
      ['an override with overlapping ranges', [schedule({ overrides: [{ date: '2026-12-24', ranges: [{ start: '09:00', end: '11:00' }, { start: '10:00', end: '12:00' }] }] })], 'schedules.0.overrides.0.ranges', /overlap/],
      ['a schedule without a name', [schedule({ name: '  ' })], 'schedules.0.name', /name/],
      ['two schedules with one id', [schedule(), schedule({ name: 'Copy' })], 'schedules.1.id', /Copy/],
      ['no schedules at all', [], 'schedules', /at least one/],
      ['a second schedule with a problem', [schedule(), schedule({ id: 'sch_2', name: 'Weekend', weekly: { 6: [{ start: '10:00', end: '09:00' }] } })], 'schedules.1.weekly.6', /Weekend, Saturday/],
    ];

    it.each(BAD_SCHEDULES)('refuses %s', async (_what, schedules, field, message) => {
      const s = await signIn();
      const before = await repo.getHost(s.ctx, 'host_owner');
      const fields = await fieldsOf(call(s, 'PUT', '/admin/hosts/host_owner', { schedules }));
      expect(Object.keys(fields)).toEqual([field]);
      expect(fields[field]).toMatch(message);
      expect(await repo.getHost(s.ctx, 'host_owner')).toEqual(before);
    });

    it('needs the default to be one of the schedules', async () => {
      const s = await signIn();
      expect(Object.keys(await fieldsOf(call(s, 'PUT', '/admin/hosts/host_owner', { defaultScheduleId: 'sch_nope' })))).toEqual(['defaultScheduleId']);
      // When the old default is removed and no new one is named, the first schedule takes over.
      const res = await ok<{ host: AdminHost }>(call(s, 'PUT', '/admin/hosts/host_owner', { schedules: [schedule({ id: 'sch_new', name: 'New' })] }));
      expect(res.host.defaultScheduleId).toBe('sch_new');
    });
  });

  describe('calendars', () => {
    it('links a calendar feed without ever showing its address again', async () => {
      const s = await signIn();
      const res = await call(s, 'PUT', '/admin/hosts/host_owner', { addIcsFeed: { label: 'Calendar feed', url: ' webcal://calendar.example.com/private-abc123/basic.ics ' } });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      expect(text).not.toContain('private-abc123');
      const host = JSON.parse(text).host as AdminHost;
      expect(host.icsFeeds).toHaveLength(1);
      expect(host.icsFeeds[0].label).toBe('Calendar feed (calendar.example.com)');
      expect(Object.keys(host.icsFeeds[0]).sort()).toEqual(['id', 'label']);
      const stored = (await repo.getHost(s.ctx, 'host_owner'))!;
      expect(stored.icsFeeds[0].urlEnc).not.toContain('calendar.example.com');
      expect(open(s.ctx, 'ics-url', stored.icsFeeds[0].urlEnc)).toBe('https://calendar.example.com/private-abc123/basic.ics');

      // The same calendar twice, and a label that is really the address.
      expect((await fieldsOf(call(s, 'PUT', '/admin/hosts/host_owner', { addIcsFeed: { label: 'Again', url: 'https://calendar.example.com/private-abc123/basic.ics' } })))['addIcsFeed.url']).toMatch(/already linked/);
      const second = await ok<{ host: AdminHost }>(call(s, 'PUT', '/admin/hosts/host_owner', { addIcsFeed: { label: 'https://other.example.org/secret-xyz.ics', url: 'https://other.example.org/secret-xyz.ics' } }));
      expect(second.host.icsFeeds[1].label).toBe('Calendar feed (other.example.org)');
      expect(JSON.stringify(second)).not.toContain('secret-xyz');

      const removed = await ok<{ host: AdminHost }>(call(s, 'PUT', '/admin/hosts/host_owner', { removeIcsFeedId: host.icsFeeds[0].id }));
      expect(removed.host.icsFeeds.map((f) => f.label)).toEqual(['Calendar feed (other.example.org)']);
    });

    it.each([
      ['http://calendar.example.com/a.ics'],
      ['https://127.0.0.1/a.ics'],
      ['https://localhost/a.ics'],
      ['https://user:pass@calendar.example.com/a.ics'],
      ['https://printer.local/a.ics'],
      ['file:///etc/passwd'],
      [''],
    ])('refuses the feed address %s', async (url) => {
      const s = await signIn();
      const fields = await fieldsOf(call(s, 'PUT', '/admin/hosts/host_owner', { addIcsFeed: { label: 'x', url } }));
      expect(Object.keys(fields)).toEqual(['addIcsFeed.url']);
      expect((await repo.getHost(s.ctx, 'host_owner'))!.icsFeeds).toEqual([]);
    });

    it('allows five feeds per person', async () => {
      const s = await signIn();
      for (let i = 0; i < 5; i++) await ok(call(s, 'PUT', '/admin/hosts/host_owner', { addIcsFeed: { label: `Feed ${i}`, url: `https://calendar.example.com/feed-${i}.ics` } }));
      expect((await fieldsOf(call(s, 'PUT', '/admin/hosts/host_owner', { addIcsFeed: { label: 'One more', url: 'https://calendar.example.com/feed-6.ics' } })))['addIcsFeed.url']).toMatch(/up to 5/);
    });

    it('chooses Google calendars only once Google is connected, and forgets a stale health verdict', async () => {
      const s = await signIn();
      expect(Object.keys(await fieldsOf(call(s, 'PUT', '/admin/hosts/host_owner', { busyCalendarIds: ['primary'] })))).toEqual(['busyCalendarIds']);
      expect(Object.keys(await fieldsOf(call(s, 'PUT', '/admin/hosts/host_owner', { writeCalendarId: 'primary' })))).toEqual(['writeCalendarId']);
      expect((await errorOf(call(s, 'GET', '/admin/hosts/host_owner/calendars'), 409)).code).toBe('google_not_connected');

      await connectGoogle(s.ctx);
      await repo.updateHost(s.ctx, 'host_owner', (h) => ({ ...h, calendarHealth: { ok: false, message: 'Old trouble', at: TEST_NOW } }));
      const res = await ok<{ host: AdminHost }>(call(s, 'PUT', '/admin/hosts/host_owner', { busyCalendarIds: ['primary', 'family@group.calendar.google.com', 'primary'], writeCalendarId: 'family@group.calendar.google.com' }));
      expect(res.host.google).toMatchObject({ busyCalendarIds: ['primary', 'family@group.calendar.google.com'], writeCalendarId: 'family@group.calendar.google.com' });
      expect(res.host.calendarHealth).toBeNull();
      expect(Object.keys(await fieldsOf(call(s, 'PUT', '/admin/hosts/host_owner', { busyCalendarIds: 'primary' })))).toEqual(['busyCalendarIds']);
    });

    it('lists Google calendars, and explains when Google wants a new sign-in', async () => {
      const s = await signIn();
      await connectGoogle(s.ctx);
      await repo.saveSecrets(s.ctx, { google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret-value' } });
      useFetch(s.ctx, (c) => {
        if (c.url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at-1', expires_in: 3600 });
        if (c.url.includes('/users/me/calendarList')) return Response.json({ items: [{ id: 'family', summary: 'Family', accessRole: 'owner' }, { id: 'jimi@example.com', summary: 'Jimi', primary: true, accessRole: 'owner', backgroundColor: '#2f6b57' }] });
        throw new Error(`unexpected ${c.url}`);
      });
      const res = await ok<{ calendars: { id: string; primary: boolean }[] }>(call(s, 'GET', '/admin/hosts/host_owner/calendars'));
      expect(res.calendars.map((c) => c.id)).toEqual(['jimi@example.com', 'family']);

      await connectGoogle(s.ctx, 'host_owner', { status: 'needs_reconnect' });
      expect((await errorOf(call(s, 'GET', '/admin/hosts/host_owner/calendars'), 409)).code).toBe('google_needs_reconnect');
    });

    it('disconnects Google and stops following its time zone', async () => {
      const s = await signIn();
      await connectGoogle(s.ctx);
      await repo.updateHost(s.ctx, 'host_owner', (h) => ({ ...h, timezoneMode: 'google', timezone: 'America/New_York' }));
      const revoked = useFetch(s.ctx, () => new Response(null, { status: 200 }));
      const res = await ok<{ ok: boolean; host: AdminHost }>(call(s, 'POST', '/admin/hosts/host_owner/google/disconnect', {}));
      expect(res.host.google).toBeNull();
      expect(res.host.timezoneMode).toBe('device');
      expect(res.host.timezone).toBe('America/New_York');
      expect(revoked.map((c) => c.url)).toEqual(['https://oauth2.googleapis.com/revoke']);
      expect((await repo.getHost(s.ctx, 'host_owner'))?.google ?? null).toBeNull();
      expect((await errorOf(call(s, 'POST', '/admin/hosts/host_nobody/google/disconnect', {}), 404)).code).toBe('not_found');
    });
  });
});

// ───────────────────────── bookings ─────────────────────────

describe('bookings', () => {
  async function seeded(): Promise<Session> {
    const s = await signIn();
    await seedBooking(s.ctx, 'bk_soon', { start: hoursFromNow(2), invitee: { name: 'Sam Rivera', email: 'sam@example.com', timezone: 'America/New_York' } });
    await seedBooking(s.ctx, 'bk_later', { start: hoursFromNow(50), eventTypeId: 'evt_meeting', eventTitle: 'Meeting', invitee: { name: 'Dana Okafor', email: 'dana@acme.test', timezone: 'Europe/London' } });
    await seedBooking(s.ctx, 'bk_now', { start: hoursFromNow(-0.25), invitee: { name: 'Nia Running', email: 'nia@example.com', timezone: 'UTC' } });
    await seedBooking(s.ctx, 'bk_yesterday', { start: hoursFromNow(-24), invitee: { name: 'Omar Past', email: 'omar@example.com', timezone: 'UTC' } });
    await seedBooking(s.ctx, 'bk_lastweek', { start: hoursFromNow(-170), eventTypeId: 'evt_meeting', eventTitle: 'Meeting', invitee: { name: 'Lena Older', email: 'lena@acme.test', timezone: 'UTC' } });
    await seedBooking(s.ctx, 'bk_cancelled', { start: hoursFromNow(30), status: 'cancelled', cancellation: { at: TEST_NOW, by: 'invitee', reason: 'Sick' }, invitee: { name: 'Cory Cancelled', email: 'cory@example.com', timezone: 'UTC' } });
    return s;
  }

  const ids = (r: { bookings: AdminBooking[] }): string[] => r.bookings.map((b) => b.id);

  it('lists each tab in its own order, with counts for all three', async () => {
    const s = await seeded();
    const upcoming = await ok<{ bookings: AdminBooking[]; total: number; counts: Record<string, number> }>(call(s, 'GET', '/admin/bookings?scope=upcoming'));
    expect(ids(upcoming)).toEqual(['bk_now', 'bk_soon', 'bk_later']);
    expect(upcoming.total).toBe(3);
    expect(upcoming.counts).toEqual({ upcoming: 3, past: 2, cancelled: 1 });
    expect(ids(await ok(call(s, 'GET', '/admin/bookings?scope=past')))).toEqual(['bk_yesterday', 'bk_lastweek']);
    expect(ids(await ok(call(s, 'GET', '/admin/bookings?scope=cancelled')))).toEqual(['bk_cancelled']);
    // No scope, or one we do not know, means upcoming.
    expect(ids(await ok(call(s, 'GET', '/admin/bookings')))).toEqual(['bk_now', 'bk_soon', 'bk_later']);
    expect(ids(await ok(call(s, 'GET', '/admin/bookings?scope=everything')))).toEqual(['bk_now', 'bk_soon', 'bk_later']);

    // A meeting moves from upcoming to past when it ends.
    s.ctx.clock.advance(3 * 3_600_000);
    expect(ids(await ok(call(s, 'GET', '/admin/bookings?scope=upcoming')))).toEqual(['bk_later']);
    expect(ids(await ok(call(s, 'GET', '/admin/bookings?scope=past')))).toEqual(['bk_soon', 'bk_now', 'bk_yesterday', 'bk_lastweek']);
  });

  it('searches by name, email address and event title', async () => {
    const s = await seeded();
    const find = async (q: string, scope = 'upcoming'): Promise<string[]> => ids(await ok(call(s, 'GET', `/admin/bookings?scope=${scope}&q=${encodeURIComponent(q)}`)));
    expect(await find('sam')).toEqual(['bk_soon']);
    expect(await find('ACME.test')).toEqual(['bk_later']);
    expect(await find('acme', 'past')).toEqual(['bk_lastweek']);
    expect(await find('intro call')).toEqual(['bk_now', 'bk_soon']);
    expect(await find('  dana   meeting ')).toEqual(['bk_later']);
    expect(await find('dana intro')).toEqual([]);
    expect(await find('nobody at all')).toEqual([]);
    // The total follows the search, the tab counts do not.
    const res = await ok<{ total: number; counts: Record<string, number> }>(call(s, 'GET', '/admin/bookings?scope=upcoming&q=sam'));
    expect(res.total).toBe(1);
    expect(res.counts.upcoming).toBe(3);
  });

  it('pages with limit and offset', async () => {
    const s = await seeded();
    const page1 = await ok<{ bookings: AdminBooking[]; total: number }>(call(s, 'GET', '/admin/bookings?scope=upcoming&limit=2&offset=0'));
    expect(ids(page1)).toEqual(['bk_now', 'bk_soon']);
    expect(page1.total).toBe(3);
    expect(ids(await ok(call(s, 'GET', '/admin/bookings?scope=upcoming&limit=2&offset=2')))).toEqual(['bk_later']);
    expect(ids(await ok(call(s, 'GET', '/admin/bookings?scope=upcoming&limit=2&offset=40')))).toEqual([]);
    expect(ids(await ok(call(s, 'GET', '/admin/bookings?scope=upcoming&limit=0&offset=-3')))).toEqual(['bk_now']);
    expect(ids(await ok(call(s, 'GET', '/admin/bookings?scope=upcoming&limit=abc')))).toHaveLength(3);
  });

  it('shows one booking with its hosts and the manage link', async () => {
    const s = await seeded();
    const { booking } = await ok<{ booking: AdminBooking }>(call(s, 'GET', '/admin/bookings/bk_soon'));
    expect(booking.id).toBe('bk_soon');
    expect(booking.hosts).toEqual([{ id: 'host_owner', name: 'Jimi Cohen', avatarUrl: null }]);
    expect(booking.manageUrl).toBe(`${TEST_BASE_URL}/booking/bk_soon?t=${hmacHex(s.ctx, 'manage', 'bk_soon')}`);
    expect(booking.timeline).toEqual([{ at: TEST_NOW, type: 'created' }]);
    expect((await errorOf(call(s, 'GET', '/admin/bookings/bk_missing'), 404)).code).toBe('not_found');
    expect((await errorOf(call(s, 'GET', '/admin/bookings/..%2Fsite'), 404)).code).toBe('not_found');
  });

  it('cancels as the host, passing the reason on', async () => {
    const s = await seeded();
    const { booking } = await ok<{ booking: AdminBooking }>(call(s, 'POST', '/admin/bookings/bk_soon/cancel', { reason: '  Something came up,\r\nsorry.  ' }));
    expect(vi.mocked(cancelBooking)).toHaveBeenLastCalledWith(s.ctx, 'bk_soon', { by: 'host', reason: 'Something came up,\nsorry.' });
    expect(booking.status).toBe('cancelled');
    expect(booking.cancellation).toMatchObject({ by: 'host', reason: 'Something came up,\nsorry.' });
    expect(booking.manageUrl).toContain('/booking/bk_soon?t=');

    await ok(call(s, 'POST', '/admin/bookings/bk_later/cancel', {}));
    expect(vi.mocked(cancelBooking)).toHaveBeenLastCalledWith(s.ctx, 'bk_later', { by: 'host' });
    await ok(call(s, 'POST', '/admin/bookings/bk_now/cancel', { reason: 12345 }));
    expect(vi.mocked(cancelBooking)).toHaveBeenLastCalledWith(s.ctx, 'bk_now', { by: 'host' });

    const calls = vi.mocked(cancelBooking).mock.calls.length;
    expect((await errorOf(call(s, 'POST', '/admin/bookings/bk_missing/cancel', {}), 404)).code).toBe('not_found');
    expect(vi.mocked(cancelBooking).mock.calls.length).toBe(calls);
  });

  it('marks and clears a no-show, with a line in the timeline each time', async () => {
    const s = await seeded();
    s.ctx.clock.advance(60_000);
    const marked = await ok<{ booking: AdminBooking }>(call(s, 'POST', '/admin/bookings/bk_yesterday/no-show', { noShow: true }));
    expect(marked.booking.attendance.noShow).toBe(true);
    expect(marked.booking.timeline.at(-1)).toEqual({ at: s.ctx.now().toISOString(), type: 'marked_no_show' });
    // Saying the same thing twice does not add a second line.
    const again = await ok<{ booking: AdminBooking }>(call(s, 'POST', '/admin/bookings/bk_yesterday/no-show', { noShow: true }));
    expect(again.booking.timeline).toHaveLength(2);
    const cleared = await ok<{ booking: AdminBooking }>(call(s, 'POST', '/admin/bookings/bk_yesterday/no-show', { noShow: false }));
    expect(cleared.booking.attendance.noShow).toBe(false);
    expect(cleared.booking.timeline.map((t) => t.type)).toEqual(['created', 'marked_no_show', 'no_show_cleared']);

    expect(Object.keys(await fieldsOf(call(s, 'POST', '/admin/bookings/bk_yesterday/no-show', { noShow: 'yes' })))).toEqual(['noShow']);
    expect((await errorOf(call(s, 'POST', '/admin/bookings/bk_soon/no-show', { noShow: true }), 409)).code).toBe('not_started');
    expect((await errorOf(call(s, 'POST', '/admin/bookings/bk_cancelled/no-show', { noShow: true }), 409)).code).toBe('cancelled');
    expect((await errorOf(call(s, 'POST', '/admin/bookings/bk_missing/no-show', { noShow: true }), 404)).code).toBe('not_found');
  });

  describe('delete', () => {
    function job(id: string, bookingId: string, patch: Partial<Job> = {}): Job {
      const dueAt = patch.dueAt ?? hoursFromNow(1);
      return { key: repo.jobKey(dueAt, id), id, type: 'message', bookingId, dueAt, channel: 'email', audience: 'invitee', kind: 'followup', attempt: 0, createdAt: TEST_NOW, ...patch };
    }

    function callRecord(id: string, bookingId: string, said = 'Yes, I will be there. My door code is 4411.'): CallRecord {
      return {
        id,
        bookingId,
        to: '+14155552671',
        status: 'completed',
        turns: [{ role: 'caller', text: said, at: TEST_NOW }],
        pendingCancel: false,
        outcome: 'confirmed',
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      };
    }

    const jobsOf = async (s: Session, bookingId: string): Promise<string[]> => (await repo.listJobs(s.ctx)).filter((j) => j.bookingId === bookingId).map((j) => j.id);
    const indexIds = async (s: Session): Promise<string[]> => (await repo.getBookingIndex(s.ctx)).map((e) => e.id).sort();

    it('erases a past booking with its index entry, pending jobs and call records, and nothing else', async () => {
      const s = await seeded();
      await repo.putJob(s.ctx, job('job_thanks', 'bk_yesterday'));
      await repo.putJob(s.ctx, job('job_other', 'bk_soon', { kind: 'reminder' }));
      await repo.saveCall(s.ctx, callRecord('call_a', 'bk_yesterday'));
      await repo.saveCall(s.ctx, callRecord('call_b', 'bk_yesterday'));
      await repo.saveCall(s.ctx, callRecord('call_c', 'bk_soon', 'Yes, see you then.'));

      expect(await ok(call(s, 'DELETE', '/admin/bookings/bk_yesterday'))).toEqual({ ok: true });

      expect(await repo.getBooking(s.ctx, 'bk_yesterday')).toBeNull();
      expect(await indexIds(s)).toEqual(['bk_cancelled', 'bk_lastweek', 'bk_later', 'bk_now', 'bk_soon']);
      expect(await jobsOf(s, 'bk_yesterday')).toEqual([]);
      expect(await jobsOf(s, 'bk_soon')).toEqual(['job_other']);
      expect(await s.ctx.kv.list('calls/')).toEqual(['calls/call_c']);
      // Nothing of what the invitee said on the call is left anywhere in storage.
      for (const key of await s.ctx.kv.list('')) expect(JSON.stringify(await s.ctx.kv.getJSON(key).catch(() => null)), key).not.toContain('door code');
      const listed = await ok<{ total: number; counts: Record<string, number> }>(call(s, 'GET', '/admin/bookings?scope=past'));
      expect(listed.total).toBe(1);
      expect(listed.counts).toEqual({ upcoming: 3, past: 1, cancelled: 1 });
      expect((await errorOf(call(s, 'GET', '/admin/bookings/bk_yesterday'), 404)).code).toBe('not_found');

      // Asking again changes nothing and is not an error: the booking is gone either way.
      expect(await ok(call(s, 'DELETE', '/admin/bookings/bk_yesterday'))).toEqual({ ok: true });
      expect((await errorOf(call(s, 'DELETE', '/admin/bookings/..%2Fsite'), 404)).code).toBe('not_found');
      expect(await repo.getSite(s.ctx)).toBeTruthy();
    });

    it('refuses an upcoming or running meeting: it is cancelled first', async () => {
      const s = await seeded();
      await repo.putJob(s.ctx, job('job_reminder', 'bk_soon', { kind: 'reminder' }));
      const soon = await errorOf(call(s, 'DELETE', '/admin/bookings/bk_soon'), 409);
      expect(soon).toEqual({ code: 'upcoming', message: 'This meeting has not happened yet. Cancel it first, then you can delete it.' });
      expect((await errorOf(call(s, 'DELETE', '/admin/bookings/bk_now'), 409)).code).toBe('in_progress');
      // Nothing was touched.
      expect(await repo.getBooking(s.ctx, 'bk_soon')).toMatchObject({ id: 'bk_soon', status: 'confirmed' });
      expect(await jobsOf(s, 'bk_soon')).toEqual(['job_reminder']);
      expect(await indexIds(s)).toContain('bk_now');

      // Once it is over, it can go.
      s.ctx.clock.advance(3 * 3_600_000);
      await ok(call(s, 'DELETE', '/admin/bookings/bk_soon'));
      expect(await repo.getBooking(s.ctx, 'bk_soon')).toBeNull();
      expect(await jobsOf(s, 'bk_soon')).toEqual([]);
    });

    it('waits for a cancellation that is still being finished, so no calendar event or notice is left behind', async () => {
      const s = await seeded();
      // bk_cancelled is ahead (in 30 hours). The email telling the invitee is still queued.
      await repo.putJob(s.ctx, job('job_told', 'bk_cancelled', { kind: 'cancelled', dueAt: TEST_NOW }));
      expect((await errorOf(call(s, 'DELETE', '/admin/bookings/bk_cancelled'), 409)).code).toBe('still_cancelling');
      await repo.deleteJob(s.ctx, repo.jobKey(TEST_NOW, 'job_told'));

      // The calendar retry is queued, or the cancellation marker is still on the record.
      await repo.putJob(s.ctx, job('job_gcal', 'bk_cancelled', { type: 'gcal_sync', kind: undefined, channel: undefined, audience: undefined }));
      expect((await errorOf(call(s, 'DELETE', '/admin/bookings/bk_cancelled'), 409)).code).toBe('still_cancelling');
      await repo.deleteJob(s.ctx, repo.jobKey(hoursFromNow(1), 'job_gcal'));
      await repo.updateBooking(s.ctx, 'bk_cancelled', (b) => ({ ...b, followUp: { kind: 'cancelled', id: 'fu_1', at: TEST_NOW, by: 'invitee' } }));
      expect((await errorOf(call(s, 'DELETE', '/admin/bookings/bk_cancelled'), 409)).code).toBe('still_cancelling');

      // Google could not take the event off: say why, and keep the booking unless the owner says the event may stay.
      await repo.updateBooking(s.ctx, 'bk_cancelled', ({ followUp: _done, ...b }) => ({
        ...b,
        google: { hostId: 'host_owner', calendarId: 'primary', eventId: 'ev_1', error: 'Google Calendar needs to be reconnected.' },
      }));
      const left = await errorOf(call(s, 'DELETE', '/admin/bookings/bk_cancelled'), 409);
      expect(left.code).toBe('calendar_event_left');
      expect(left.message).toBe(
        'The event for this meeting is still on Google Calendar, because it could not be removed. Google Calendar needs to be reconnected. If you delete the booking anyway, the event stays on the calendar until someone removes it by hand.',
      );
      expect(left.message).not.toContain('—');
      expect(await repo.getBooking(s.ctx, 'bk_cancelled')).not.toBeNull();

      await repo.updateBooking(s.ctx, 'bk_cancelled', (b) => ({ ...b, google: { hostId: 'host_owner', calendarId: 'primary', eventId: 'ev_1', syncedAt: TEST_NOW } }));
      await ok(call(s, 'DELETE', '/admin/bookings/bk_cancelled'));
      expect(await repo.getBooking(s.ctx, 'bk_cancelled')).toBeNull();
      expect(await indexIds(s)).not.toContain('bk_cancelled');
    });

    it('lets a cancelled meeting whose time has passed go, whatever is left of its cancellation', async () => {
      const s = await signIn();
      await seedBooking(s.ctx, 'bk_gone', {
        start: hoursFromNow(-5),
        status: 'cancelled',
        cancellation: { at: TEST_NOW, by: 'host' },
        followUp: { kind: 'cancelled', id: 'fu_2', at: hoursFromNow(-48) },
        google: { hostId: 'host_owner', calendarId: 'primary', eventId: 'ev_2', error: 'Google Calendar needs to be reconnected.' },
      });
      await repo.putJob(s.ctx, job('job_late', 'bk_gone', { kind: 'cancelled' }));
      await ok(call(s, 'DELETE', '/admin/bookings/bk_gone'));
      expect(await repo.getBooking(s.ctx, 'bk_gone')).toBeNull();
      expect(await jobsOf(s, 'bk_gone')).toEqual([]);
    });

    describe('a cancelled meeting ahead whose Google event could not be removed', () => {
      const EVENT_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events/ev_1';
      const TOKEN_URL = 'https://oauth2.googleapis.com/token';

      /** bk_cancelled (in 30 hours): the event is still on the owner's calendar, and its calendar retry is queued. */
      async function stuck(): Promise<Session> {
        const s = await seeded();
        await repo.saveSecrets(s.ctx, { google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret-value' } });
        await repo.updateBooking(s.ctx, 'bk_cancelled', (b) => ({
          ...b,
          google: { hostId: 'host_owner', calendarId: 'primary', eventId: 'ev_1', error: 'Google request failed (503).' },
          timeline: [...(b.timeline ?? []), { at: TEST_NOW, type: 'calendar_sync_failed', detail: 'Google request failed (503).' }],
        }));
        // That retry is the same trouble, not work that is about to finish: it does not hold the delete up on its own.
        await repo.putJob(s.ctx, job('job_gcal', 'bk_cancelled', { type: 'gcal_sync', kind: undefined, channel: undefined, audience: undefined }));
        return s;
      }

      const deletesOf = (calls: NetCall[]): NetCall[] => calls.filter((c) => c.method === 'DELETE' && c.url.startsWith(EVENT_URL));

      it('tries Google once more first, and deletes at once when the event comes off now', async () => {
        const s = await stuck();
        await connectGoogle(s.ctx);
        const calls = useFetch(s.ctx, (c) => {
          if (c.url === TOKEN_URL) return Response.json({ access_token: 'at-1', expires_in: 3600 });
          if (c.method === 'DELETE' && c.url.startsWith(EVENT_URL)) return new Response(null, { status: 204 });
          throw new Error(`unexpected ${c.method} ${c.url}`);
        });

        expect(await ok(call(s, 'DELETE', '/admin/bookings/bk_cancelled'))).toEqual({ ok: true });
        const removed = deletesOf(calls);
        expect(removed).toHaveLength(1);
        // The attendees hear from Google that the event is gone, as they would have at the cancellation.
        expect(new URL(removed[0].url).searchParams.get('sendUpdates')).toBe('all');
        expect(await repo.getBooking(s.ctx, 'bk_cancelled')).toBeNull();
        expect(await jobsOf(s, 'bk_cancelled')).toEqual([]);
        expect(await indexIds(s)).not.toContain('bk_cancelled');
        expect(s.ctx.logs.find((l) => l.msg.includes('left in place'))).toBeUndefined();
      });

      it('when Google still cannot, refuses and says why, then deletes once the owner says the event may stay', async () => {
        const s = await stuck();
        await connectGoogle(s.ctx);
        const calls = useFetch(s.ctx, (c) => {
          if (c.url === TOKEN_URL) return Response.json({ access_token: 'at-1', expires_in: 3600 });
          if (c.url.startsWith(EVENT_URL)) return Response.json({ error: { code: 503, message: 'Backend Error' } }, { status: 503 });
          throw new Error(`unexpected ${c.method} ${c.url}`);
        });

        const refused = await errorOf(call(s, 'DELETE', '/admin/bookings/bk_cancelled'), 409);
        expect(refused.code).toBe('calendar_event_left');
        expect(refused.message).toBe(
          'The event for this meeting is still on Google Calendar, because it could not be removed. Google request failed (503). If you delete the booking anyway, the event stays on the calendar until someone removes it by hand.',
        );
        const firstTry = deletesOf(calls).length;
        expect(firstTry).toBeGreaterThan(0);
        // Nothing of the booking was touched.
        expect(await repo.getBooking(s.ctx, 'bk_cancelled')).toMatchObject({ status: 'cancelled', google: { error: 'Google request failed (503).' } });
        expect(await jobsOf(s, 'bk_cancelled')).toEqual(['job_gcal']);

        // Only that answer lets it go.
        expect((await errorOf(call(s, 'DELETE', '/admin/bookings/bk_cancelled?leaveCalendarEvent=0'), 409)).code).toBe('calendar_event_left');
        const before = deletesOf(calls).length;
        expect(await ok(call(s, 'DELETE', '/admin/bookings/bk_cancelled?leaveCalendarEvent=1'))).toEqual({ ok: true, calendarEventLeft: true });
        // Google was still asked first: it might have worked this time.
        expect(deletesOf(calls).length).toBeGreaterThan(before);
        expect(await repo.getBooking(s.ctx, 'bk_cancelled')).toBeNull();
        expect(await jobsOf(s, 'bk_cancelled')).toEqual([]);
        expect(await indexIds(s)).not.toContain('bk_cancelled');
        expect(s.ctx.logs.find((l) => l.msg.includes('left in place'))).toMatchObject({ level: 'warn', data: { bookingId: 'bk_cancelled', hostId: 'host_owner' } });
      });

      it('asks Google nothing when nobody can reach that calendar now, and still needs the answer after the error was cleared', async () => {
        const s = await stuck();
        // Google was disconnected: the calendar sync noted that the event was left there, and cleared the error.
        await repo.updateBooking(s.ctx, 'bk_cancelled', (b) => ({
          ...b,
          google: { hostId: 'host_owner', calendarId: 'primary', eventId: 'ev_1' },
          timeline: [...(b.timeline ?? []), { at: TEST_NOW, type: 'calendar_event_left', detail: 'Google Calendar is no longer connected, so the event was not removed.' }],
        }));
        const calls = useFetch(s.ctx, (c) => {
          throw new Error(`unexpected ${c.method} ${c.url}`);
        });
        const refused = await errorOf(call(s, 'DELETE', '/admin/bookings/bk_cancelled'), 409);
        expect(refused.code).toBe('calendar_event_left');
        expect(refused.message).toContain('Google Calendar is no longer connected, so the event was not removed.');

        // The flag only ever covers the calendar event: an upcoming meeting, or a cancellation still being told, is refused as before.
        expect((await errorOf(call(s, 'DELETE', '/admin/bookings/bk_soon?leaveCalendarEvent=1'), 409)).code).toBe('upcoming');
        await repo.putJob(s.ctx, job('job_told', 'bk_cancelled', { kind: 'cancelled', dueAt: TEST_NOW }));
        expect((await errorOf(call(s, 'DELETE', '/admin/bookings/bk_cancelled?leaveCalendarEvent=1'), 409)).code).toBe('still_cancelling');
        await repo.deleteJob(s.ctx, repo.jobKey(TEST_NOW, 'job_told'));

        expect(await ok(call(s, 'DELETE', '/admin/bookings/bk_cancelled?leaveCalendarEvent=1'))).toEqual({ ok: true, calendarEventLeft: true });
        expect(await repo.getBooking(s.ctx, 'bk_cancelled')).toBeNull();
        expect(calls).toEqual([]);
      });
    });

    it('finishes a delete that was cut off after the record went, but never touches a booking that is being made', async () => {
      const s = await seeded();
      // The record went, the index entry stayed (an earlier delete was cut off).
      await repo.deleteBooking(s.ctx, 'bk_lastweek');
      await repo.saveCall(s.ctx, callRecord('call_left', 'bk_lastweek'));
      await ok(call(s, 'DELETE', '/admin/bookings/bk_lastweek'));
      expect(await indexIds(s)).not.toContain('bk_lastweek');
      expect(await s.ctx.kv.list('calls/')).toEqual([]);

      // An index entry ahead without a record is a booking being created right now: it stays.
      const entry = { ...repo.indexEntryOf(makeBooking('bk_new', { start: hoursFromNow(5) })) };
      await repo.mutateBookingIndex(s.ctx, (entries) => [...entries, entry]);
      await ok(call(s, 'DELETE', '/admin/bookings/bk_new'));
      expect(await indexIds(s)).toContain('bk_new');
    });
  });

  describe('CSV export', () => {
    /** A small RFC 4180 reader, so the test checks what a spreadsheet would actually see. */
    function parseCsv(text: string): string[][] {
      const rows: string[][] = [];
      let row: string[] = [];
      let cell = '';
      let quoted = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
          if (ch === '"' && text[i + 1] === '"') {
            cell += '"';
            i++;
          } else if (ch === '"') quoted = false;
          else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') {
          row.push(cell);
          cell = '';
        } else if (ch === '\r' && text[i + 1] === '\n') {
          row.push(cell);
          rows.push(row);
          row = [];
          cell = '';
          i++;
        } else cell += ch;
      }
      expect(cell).toBe('');
      expect(row).toEqual([]);
      return rows;
    }

    it('downloads the same selection as the list, as a file', async () => {
      const s = await seeded();
      const res = await call(s, 'GET', '/admin/bookings.csv?scope=upcoming&q=intro');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="bookings-upcoming-2026-11-16.csv"');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const bytes = new Uint8Array(await res.arrayBuffer());
      // A UTF-8 byte order mark first, so spreadsheet apps read accented names correctly.
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(bytes);
      const rows = parseCsv(text);
      expect(rows[0].slice(0, 5)).toEqual(['Booking ID', 'Status', 'Event', 'Start (UTC)', 'End (UTC)']);
      expect(rows.slice(1).map((r) => r[0])).toEqual(['bk_now', 'bk_soon']);
      expect(rows.every((r) => r.length === rows[0].length)).toBe(true);
      // A link that can cancel the meeting has no place in a file that gets passed around.
      expect(text).not.toContain(hmacHex(s.ctx, 'manage', 'bk_soon'));

      const all = parseCsv(await (await call(s, 'GET', '/admin/bookings.csv')).text());
      expect(all).toHaveLength(7);
      const cancelled = await call(s, 'GET', '/admin/bookings.csv?scope=cancelled');
      expect(cancelled.headers.get('content-disposition')).toContain('bookings-cancelled-');
      expect(parseCsv(await cancelled.text()).slice(1).map((r) => r[0])).toEqual(['bk_cancelled']);
    });

    it('quotes what needs quoting and defuses anything a spreadsheet would run as a formula', async () => {
      const s = await signIn();
      await seedBooking(s.ctx, 'bk_tricky', {
        eventTitle: '@SUM(1+1) review',
        invitee: { name: '=HYPERLINK("https://evil.example","Click")', email: 'eve@example.com', phone: '+14155552671', timezone: 'America/New_York' },
        guests: ['a@example.com', 'b@example.com'],
        answers: [
          { questionId: 'q1', label: 'Topic', value: 'Budget, "phase 2"\nand next steps' },
          { questionId: 'q2', label: 'Notes', value: '-1+1' },
        ],
        location: { type: 'in_person', label: 'In person', value: '1 Main St, Suite "B"' },
        cancellation: null,
      });
      await seedBooking(s.ctx, 'bk_tab', { invitee: { name: '\tTabby', email: 'tab@example.com', timezone: 'UTC' }, start: hoursFromNow(60), status: 'cancelled', cancellation: { at: TEST_NOW, by: 'invitee', reason: '-- changed my mind' } });
      const text = await (await call(s, 'GET', '/admin/bookings.csv')).text();
      expect(text).toContain('"\'=HYPERLINK(""https://evil.example"",""Click"")"');
      expect(text.endsWith('\r\n')).toBe(true);

      const rows = parseCsv(text);
      const header = rows[0];
      const row = Object.fromEntries(header.map((h, i) => [h, rows.find((r) => r[0] === 'bk_tricky')![i]]));
      expect(row.Invitee).toBe('\'=HYPERLINK("https://evil.example","Click")');
      expect(row.Event).toBe("'@SUM(1+1) review");
      expect(row.Phone).toBe("'+14155552671");
      expect(row.Email).toBe('eve@example.com');
      expect(row.Guests).toBe('a@example.com, b@example.com');
      expect(row.Answers).toBe('Topic: Budget, "phase 2"\nand next steps\nNotes: -1+1');
      expect(row.Location).toBe('In person: 1 Main St, Suite "B"');
      expect(row.Hosts).toBe('Jimi Cohen');
      expect(row['Start (UTC)']).toBe(hoursFromNow(48));
      expect(row['Local start (UTC)']).toBe('2026-11-18 09:00');
      expect(new Set(header).size).toBe(header.length);
      expect(row.Minutes).toBe('30');
      expect(row['No-show']).toBe('no');

      const tab = Object.fromEntries(header.map((h, i) => [h, rows.find((r) => r[0] === 'bk_tab')![i]]));
      expect(tab.Invitee).toBe("'\tTabby");
      expect(tab['Cancellation reason']).toBe("'-- changed my mind");
      expect(tab['Cancelled by']).toBe('invitee');
      // No cell is left that starts with a character a spreadsheet treats as "this is a formula".
      for (const r of rows.slice(1)) for (const cell of r) expect(/^[=+\-@\t\r]/.test(cell), cell).toBe(false);
    });

    it("shows start times in the owner's zone too", async () => {
      const s = await signIn();
      await repo.updateHost(s.ctx, 'host_owner', (h) => ({ ...h, timezone: 'Africa/Nairobi' }));
      await seedBooking(s.ctx, 'bk_1', { start: '2026-11-17T20:30:00.000Z' });
      const res = await call(s, 'GET', '/admin/bookings.csv');
      const rows = parseCsv(await res.text());
      const column = rows[0].indexOf('Local start (Africa/Nairobi)');
      expect(column).toBeGreaterThan(0);
      expect(rows[1][column]).toBe('2026-11-17 23:30');
    });
  });
});

// ───────────────────────── integrations ─────────────────────────

describe('integrations', () => {
  const SID = `AC${'0123456789abcdef'.repeat(2)}`;
  const TWILIO = { accountSid: SID, authToken: 'twilio-auth-token-secret-value-1', fromNumber: '+15005550006' };

  it('starts with nothing connected', async () => {
    const s = await signIn();
    expect(await ok(call(s, 'GET', '/admin/integrations'))).toEqual({
      baseUrl: TEST_BASE_URL,
      google: { configured: false, redirectUri: `${TEST_BASE_URL}/api/google/callback`, ownerConnected: false },
      twilio: { configured: false, calls: false },
      anthropic: { configured: false, model: 'claude-opus-5-5' },
      email: { setting: 'auto', resolved: 'none', resendConfigured: false, gmailAvailable: false, fromEmail: '' },
      environment: {
        google: { clientId: false, clientSecret: false },
        twilio: { accountSid: false, authToken: false, fromNumber: false },
        anthropic: { apiKey: false },
        resend: { apiKey: false },
      },
    });
  });

  it('saves credentials and shows only that they are there', async () => {
    const s = await signIn();
    const res = await call(s, 'PUT', '/admin/integrations', {
      google: { clientId: ' 123456789-abcdef.apps.googleusercontent.com ', clientSecret: 'GOCSPX-super-secret-value' },
      twilio: { ...TWILIO, fromNumber: '+1 (500) 555-0006', messagingServiceSid: `MG${'f'.repeat(32)}` },
      anthropic: { apiKey: 'sk-ant-api03-very-secret-key-value' },
      resend: { apiKey: 're_secret_resend_key_value' },
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    for (const secret of ['GOCSPX-super-secret-value', TWILIO.authToken, SID, 'sk-ant-api03-very-secret-key-value', 're_secret_resend_key_value', '123456789-abcdef']) expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({
      google: { configured: true, clientIdMasked: '1234….apps.googleusercontent.com' },
      twilio: { configured: true, accountSidMasked: 'AC01…cdef', fromNumber: '+15005550006', messagingServiceSid: `MG${'f'.repeat(32)}` },
      anthropic: { configured: true },
      email: { resendConfigured: true, resolved: 'none' },
    });
    expect(await repo.getStoredSecrets(s.ctx)).toEqual({
      google: { clientId: '123456789-abcdef.apps.googleusercontent.com', clientSecret: 'GOCSPX-super-secret-value' },
      twilio: { ...TWILIO, messagingServiceSid: `MG${'f'.repeat(32)}` },
      anthropic: { apiKey: 'sk-ant-api03-very-secret-key-value' },
      resend: { apiKey: 're_secret_resend_key_value' },
    });
    // Sealed at rest: the stored record is not readable.
    const raw = JSON.stringify(await s.ctx.kv.getJSON('secrets'));
    expect(raw).not.toContain('GOCSPX');
    expect(raw).not.toContain('sk-ant');
  });

  it('changes only what was sent: a value replaces, an empty string clears, a missing key stays', async () => {
    const s = await signIn();
    await repo.saveSecrets(s.ctx, { google: { clientId: 'old.apps.googleusercontent.com', clientSecret: 'old-google-secret' }, twilio: TWILIO, anthropic: { apiKey: 'sk-ant-old-key-000000000000' }, resend: { apiKey: 're_old_key_value' } });

    await ok(call(s, 'PUT', '/admin/integrations', { google: { clientSecret: 'new-google-secret' }, twilio: { fromNumber: '+15005550007', authToken: undefined }, resend: {} }));
    expect(await repo.getStoredSecrets(s.ctx)).toEqual({
      google: { clientId: 'old.apps.googleusercontent.com', clientSecret: 'new-google-secret' },
      twilio: { ...TWILIO, fromNumber: '+15005550007' },
      anthropic: { apiKey: 'sk-ant-old-key-000000000000' },
      resend: { apiKey: 're_old_key_value' },
    });

    const cleared = await ok<{ anthropic: { configured: boolean }; twilio: { configured: boolean; accountSidMasked?: string }; email: { resendConfigured: boolean } }>(
      call(s, 'PUT', '/admin/integrations', { anthropic: { apiKey: '' }, resend: { apiKey: '  ' }, twilio: { accountSid: '', authToken: '', fromNumber: '', messagingServiceSid: '' } }),
    );
    expect(cleared.anthropic.configured).toBe(false);
    expect(cleared.email.resendConfigured).toBe(false);
    expect(cleared.twilio).toEqual({ configured: false, calls: false });
    expect(await repo.getStoredSecrets(s.ctx)).toEqual({ google: { clientId: 'old.apps.googleusercontent.com', clientSecret: 'new-google-secret' } });
  });

  it('checks the shape of what is pasted', async () => {
    const s = await signIn();
    const fields = await fieldsOf(
      call(s, 'PUT', '/admin/integrations', {
        google: { clientId: 'not-a-client-id', clientSecret: 'x' },
        twilio: { accountSid: 'AC123', authToken: 'short', fromNumber: '0044 20 7946 0000', messagingServiceSid: 'MG12' },
        anthropic: { apiKey: 'sk-proj-not-anthropic-0000000000', model: 'bad model id!' },
        resend: { apiKey: 12345 },
      }),
    );
    expect(Object.keys(fields).sort()).toEqual([
      'anthropic.apiKey',
      'anthropic.model',
      'google.clientId',
      'google.clientSecret',
      'resend.apiKey',
      'twilio.accountSid',
      'twilio.authToken',
      'twilio.fromNumber',
      'twilio.messagingServiceSid',
    ]);
    expect(fields['twilio.accountSid']).toMatch(/starts with AC and has 34 characters/);
    expect(fields['google.clientId']).toMatch(/\.apps\.googleusercontent\.com/);
    expect(fields['anthropic.apiKey']).toMatch(/sk-ant-/);
    expect(await repo.getStoredSecrets(s.ctx)).toEqual({});
    expect(Object.keys(await fieldsOf(call(s, 'PUT', '/admin/integrations', { twilio: 'AC…' })))).toEqual(['twilio']);
  });

  it('can set the assistant model along with the key', async () => {
    const s = await signIn();
    const res = await ok<{ anthropic: { configured: boolean; model: string } }>(call(s, 'PUT', '/admin/integrations', { anthropic: { apiKey: 'sk-ant-api03-very-secret-key-value', model: 'claude-sonnet-5-5' } }));
    expect(res.anthropic).toEqual({ configured: true, model: 'claude-sonnet-5-5' });
    expect((await repo.getSite(s.ctx)).assistant.model).toBe('claude-sonnet-5-5');
  });

  it('reports what the environment provides, and never writes those values to storage', async () => {
    const overrides = { googleClientId: 'env-id.apps.googleusercontent.com', googleClientSecret: 'env-google-secret', anthropicApiKey: 'sk-ant-from-the-environment-000', twilioAccountSid: SID };
    const s = await signIn({ env: { overrides } });
    const status = await ok<{ google: { configured: boolean; clientIdMasked: string }; anthropic: { configured: boolean }; twilio: { configured: boolean }; environment: Record<string, Record<string, boolean>> }>(call(s, 'GET', '/admin/integrations'));
    expect(status.google).toMatchObject({ configured: true, clientIdMasked: 'env-….apps.googleusercontent.com' });
    expect(status.anthropic.configured).toBe(true);
    expect(status.twilio.configured).toBe(false); // the SID alone is not enough
    expect(status.environment).toEqual({
      google: { clientId: true, clientSecret: true },
      twilio: { accountSid: true, authToken: false, fromNumber: false },
      anthropic: { apiKey: true },
      resend: { apiKey: false },
    });

    // Saving something else must start from what is stored, not from the merged view.
    await ok(call(s, 'PUT', '/admin/integrations', { resend: { apiKey: 're_new_key_value' }, twilio: { authToken: 'twilio-auth-token-secret-value-1', fromNumber: '+15005550006' } }));
    const stored = await repo.getStoredSecrets(s.ctx);
    expect(stored).toEqual({ twilio: { accountSid: '', authToken: 'twilio-auth-token-secret-value-1', fromNumber: '+15005550006' }, resend: { apiKey: 're_new_key_value' } });
    expect(JSON.stringify(stored)).not.toContain('env-');
    expect(JSON.stringify(stored)).not.toContain('sk-ant-from-the-environment');
    // Together with the environment's SID, Twilio is now complete.
    expect((await ok<{ twilio: { configured: boolean } }>(call(s, 'GET', '/admin/integrations'))).twilio.configured).toBe(true);
  });

  it('a Messaging Service sends texts but cannot place calls', async () => {
    const s = await signIn();
    const service = `MG${'f'.repeat(32)}`;
    const texts = await ok<IntegrationsStatus>(call(s, 'PUT', '/admin/integrations', { twilio: { accountSid: SID, authToken: TWILIO.authToken, messagingServiceSid: service } }));
    expect(texts.twilio).toMatchObject({ configured: true, calls: false, messagingServiceSid: service });
    expect(texts.twilio.fromNumber).toBeUndefined();
    const both = await ok<IntegrationsStatus>(call(s, 'PUT', '/admin/integrations', { twilio: { fromNumber: TWILIO.fromNumber } }));
    expect(both.twilio).toMatchObject({ configured: true, calls: true, fromNumber: TWILIO.fromNumber });
  });

  it('shows Gmail as not sending while the owner\'s Google connection cannot be used', async () => {
    const s = await signIn();
    await repo.saveSecrets(s.ctx, { google: { clientId: '123456789-abcdef.apps.googleusercontent.com', clientSecret: 'GOCSPX-super-secret-value' } });
    await connectGoogle(s.ctx, 'host_owner', { gmailSend: true });
    const email = async () => (await ok<IntegrationsStatus>(call(s, 'GET', '/admin/integrations'))).email;
    expect(await email()).toEqual({ setting: 'auto', resolved: 'gmail', resendConfigured: false, gmailAvailable: true, fromEmail: '' });

    // Google asked for a new sign-in, for example after a password change.
    await connectGoogle(s.ctx, 'host_owner', { gmailSend: true, status: 'needs_reconnect' });
    expect(await email()).toEqual({ setting: 'auto', resolved: 'none', resendConfigured: false, gmailAvailable: false, fromEmail: '', gmailProblem: 'needs_reconnect' });

    // The keys the connection was made with were removed.
    await connectGoogle(s.ctx, 'host_owner', { gmailSend: true });
    await ok(call(s, 'PUT', '/admin/integrations', { google: { clientId: '', clientSecret: '' } }));
    expect(await email()).toMatchObject({ resolved: 'none', gmailAvailable: false, gmailProblem: 'keys_missing' });

    // With Resend there is another way out, so email is not down. Gmail itself still is.
    await repo.saveSecrets(s.ctx, { resend: { apiKey: 're_secret_resend_key_value' } });
    await ok(call(s, 'PUT', '/admin/site', { email: { fromEmail: 'meet@jimicohen.com' } }));
    const withResend = await email();
    expect(withResend).toMatchObject({ resolved: 'resend', gmailAvailable: false });
    expect(withResend.gmailProblem).toBeUndefined();
  });

  describe('POST /admin/integrations/test', () => {
    const test = (s: Session, body: unknown): Promise<{ ok: boolean; detail: string }> => ok(call(s, 'POST', '/admin/integrations/test', body));

    it('answers with a plain result for an unknown channel or a missing setup, never an error', async () => {
      const s = await signIn();
      expect(await test(s, {})).toMatchObject({ ok: false });
      expect(await test(s, { channel: 'carrier-pigeon' })).toMatchObject({ ok: false });
      expect((await test(s, { channel: 'email', to: 'me@example.com' })).detail).toMatch(/No email provider is set up/);
      expect((await test(s, { channel: 'email', to: 'not an address' })).detail).toMatch(/does not look right/);
      expect((await test(s, { channel: 'email' })).detail).toMatch(/Enter an email address/);
      expect((await test(s, { channel: 'sms', to: '+14155552671' })).detail).toMatch(/Twilio is not set up/);
      expect((await test(s, { channel: 'call', to: '+14155552671' })).detail).toMatch(/Twilio phone number/);
      expect((await test(s, { channel: 'google' })).detail).toBe('Your Google Calendar is not connected yet.');
      expect((await test(s, { channel: 'google', hostId: 'host_nobody' })).detail).toMatch(/no longer on the team/);
      expect((await test(s, { channel: 'anthropic' })).detail).toMatch(/No Anthropic key/);
    });

    it('sends a real test email through the configured provider', async () => {
      const s = await signIn();
      await repo.saveSecrets(s.ctx, { resend: { apiKey: 're_secret_resend_key_value' } });
      await ok(call(s, 'PUT', '/admin/site', { email: { fromEmail: 'meet@jimicohen.com', replyTo: 'jimi@jimicohen.com' } }));
      const calls = useFetch(s.ctx, () => Response.json({ id: 'email_1' }));
      const result = await test(s, { channel: 'email', to: 'me@example.com' });
      expect(result).toEqual({ ok: true, detail: 'Test email sent to me@example.com through Resend. It can take a minute to arrive.' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.resend.com/emails');
      const sent = JSON.parse(calls[0].body);
      expect(sent.to).toEqual(['me@example.com']);
      expect(sent.subject).toBe('Test email from Jimi Cohen');
      expect(sent.text).toContain('Email is working');
      expect(sent.html).toContain('Email is working');

      // Without an address the test goes to the owner.
      await test(s, { channel: 'email' });
      expect(JSON.parse(calls[1].body).to).toEqual(['jimi@jimicohen.com']);

      // A provider that says no is a result, not a crash.
      useFetch(s.ctx, () => Response.json({ message: 'The domain is not verified.' }, { status: 403 }));
      const failed = await test(s, { channel: 'email', to: 'me@example.com' });
      expect(failed.ok).toBe(false);
      expect(failed.detail).toMatch(/^The test email was not sent\./);
    });

    it('sends a test text and places a test call through Twilio', async () => {
      const s = await signIn();
      await repo.saveSecrets(s.ctx, { twilio: TWILIO });
      const calls = useFetch(s.ctx, (c) => (c.url.endsWith('/Calls.json') ? Response.json({ sid: `CA${'a1'.repeat(16)}`, status: 'queued' }, { status: 201 }) : Response.json({ sid: 'SM123' }, { status: 201 })));

      expect((await test(s, { channel: 'sms' })).detail).toMatch(/Enter a mobile number/);
      expect((await test(s, { channel: 'sms', to: '555 2671' })).detail).toMatch(/international format/);
      expect(calls).toHaveLength(0);

      expect(await test(s, { channel: 'sms', to: '+1 415 555 2671' })).toEqual({ ok: true, detail: 'Test text sent to +14155552671.' });
      expect(calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
      const text = new URLSearchParams(calls[0].body);
      expect(text.get('To')).toBe('+14155552671');
      expect(text.get('From')).toBe('+15005550006');
      expect(text.get('Body')).toContain('texts are working');

      const rang = await test(s, { channel: 'call', to: '+14155552671' });
      expect(rang.ok).toBe(true);
      expect(rang.detail).toMatch(/^Calling \+14155552671 now\. Ava will say it is a test call/);
      const dial = new URLSearchParams(calls[1].body);
      expect(calls[1].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`);
      expect(dial.get('To')).toBe('+14155552671');
      const callId = new URL(dial.get('Url')!).searchParams.get('c')!;
      expect(dial.get('Url')!.startsWith(`${TEST_BASE_URL}/api/twilio/voice/start`)).toBe(true);
      // Placed as a test: nothing about it touches a real booking.
      const record = await s.ctx.kv.getJSON<{ purpose: string; bookingId: string; to: string }>(`calls/${callId}`);
      expect(record).toMatchObject({ purpose: 'test', to: '+14155552671' });
      expect(await repo.getBooking(s.ctx, record!.bookingId)).toBeNull();
      expect(await s.ctx.kv.list('bookings/')).toEqual([]);

      useFetch(s.ctx, () => Response.json({ code: 21608, message: 'The number is unverified.' }, { status: 400 }));
      expect((await test(s, { channel: 'sms', to: '+14155552671' })).detail).toMatch(/trial account/);
    });

    it('probes Google Calendar for the owner or a named co-host', async () => {
      const s = await signIn();
      const { host } = await addCoHost(s);
      await connectGoogle(s.ctx);
      await repo.saveSecrets(s.ctx, { google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret-value' } });
      const calls = useFetch(s.ctx, (c) => {
        if (c.url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at-1', expires_in: 3600 });
        if (c.url.endsWith('/freeBusy')) return Response.json({ calendars: { primary: { busy: [{ start: hoursFromNow(5), end: hoursFromNow(6) }] } } });
        throw new Error(`unexpected ${c.url}`);
      });
      expect(await test(s, { channel: 'google' })).toEqual({ ok: true, detail: 'Connected as jimi@example.com. Found 1 busy block in the next 7 days.' });
      const probe = JSON.parse(calls.find((c) => c.url.endsWith('/freeBusy'))!.body);
      expect(probe.timeMin).toBe(TEST_NOW);
      expect(probe.timeMax).toBe(hoursFromNow(7 * 24));

      expect((await test(s, { channel: 'google', hostId: host.id })).detail).toBe("Alex's Google Calendar is not connected yet.");
      await connectGoogle(s.ctx, 'host_owner', { status: 'needs_reconnect' });
      expect(await test(s, { channel: 'google' })).toEqual({ ok: false, detail: 'Your Google Calendar needs to be reconnected. Google asked for a new sign-in.' });

      await connectGoogle(s.ctx);
      useFetch(s.ctx, (c) => (c.url === 'https://oauth2.googleapis.com/token' ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : Response.json({}, { status: 500 })));
      await s.ctx.kv.delete('cache/gtok-host_owner');
      const revoked = await test(s, { channel: 'google' });
      expect(revoked).toEqual({ ok: false, detail: 'Google Calendar needs to be reconnected.' });
    });

    function claudeReply(extra: Record<string, unknown> = {}): Response {
      return Response.json(
        { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ready' }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: { input_tokens: 20, output_tokens: 3 }, ...extra },
        { headers: { 'request-id': 'req_test' } },
      );
    }
    function claudeError(status: number, type: string): Response {
      return Response.json({ type: 'error', error: { type, message: 'details from the provider' } }, { status, headers: { 'request-id': 'req_test' } });
    }

    it('sends one tiny message to Claude with the saved key and model', async () => {
      const s = await signIn();
      await repo.saveSecrets(s.ctx, { anthropic: { apiKey: 'sk-ant-api03-very-secret-key-value' } });
      const calls = useFetch(s.ctx, () => claudeReply());
      const result = await test(s, { channel: 'anthropic' });
      expect(result).toEqual({ ok: true, detail: 'The key works. claude-opus-5-5 answered.' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url.startsWith('https://api.anthropic.com/v1/messages')).toBe(true);
      expect(`${calls[0].headers.get('x-api-key') ?? ''} ${calls[0].headers.get('authorization') ?? ''}`).toContain('sk-ant-api03-very-secret-key-value');
      expect(calls[0].headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
      const sent = JSON.parse(calls[0].body);
      expect(sent.model).toBe('claude-opus-5-5');
      expect(sent.output_config).toEqual({ effort: 'low' });
      expect(sent.messages).toHaveLength(1);
      expect(sent.max_tokens).toBeLessThanOrEqual(1024);
      expect(result.detail).not.toContain('sk-ant');

      // Another model, chosen under Integrations.
      await ok(call(s, 'PUT', '/admin/site', { assistant: { model: 'claude-sonnet-5-5' } }));
      const second = useFetch(s.ctx, () => claudeReply({ model: 'claude-sonnet-5-5' }));
      expect((await test(s, { channel: 'anthropic' })).detail).toBe('The key works. claude-sonnet-5-5 answered.');
      expect(JSON.parse(second[0].body).model).toBe('claude-sonnet-5-5');
    });

    it('still passes when the account does not have the refusal fallback option', async () => {
      const s = await signIn();
      await repo.saveSecrets(s.ctx, { anthropic: { apiKey: 'sk-ant-api03-very-secret-key-value' } });
      const calls = useFetch(s.ctx, (c) => (c.headers.has('anthropic-beta') ? claudeError(400, 'invalid_request_error') : claudeReply()));
      expect((await test(s, { channel: 'anthropic' })).ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(JSON.parse(calls[0].body).fallbacks).toBe('default');
      expect(JSON.parse(calls[1].body).fallbacks).toBeUndefined();
      expect(calls[1].headers.has('anthropic-beta')).toBe(false);
      // A request the API turns down either way is reported, not retried for ever.
      const rejected = useFetch(s.ctx, () => claudeError(400, 'invalid_request_error'));
      const result = await test(s, { channel: 'anthropic' });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/turned the test down for claude-opus-5-5/);
      expect(rejected).toHaveLength(2);
    });

    it.each([
      [401, 'authentication_error', /did not accept this key/],
      [403, 'permission_error', /not allowed to use claude-opus-5-5/],
      [404, 'not_found_error', /does not know the model "claude-opus-5-5"/],
      [429, 'rate_limit_error', /limiting this key/],
      [529, 'overloaded_error', /having trouble right now/],
    ])('explains a %i from Anthropic in plain words', async (status, type, message) => {
      const s = await signIn();
      await repo.saveSecrets(s.ctx, { anthropic: { apiKey: 'sk-ant-api03-very-secret-key-value' } });
      useFetch(s.ctx, () => claudeError(status, type));
      const result = await test(s, { channel: 'anthropic' });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(message);
      expect(result.detail).not.toContain('details from the provider');
    });

    it('turns a dead network into a result too', async () => {
      const s = await signIn();
      await repo.saveSecrets(s.ctx, { anthropic: { apiKey: 'sk-ant-api03-very-secret-key-value' } });
      useFetch(s.ctx, () => {
        throw new TypeError('fetch failed');
      });
      expect(await test(s, { channel: 'anthropic' })).toEqual({ ok: false, detail: 'Anthropic could not be reached. Please try again.' });
    });

    it('allows 20 tests an hour', async () => {
      const s = await signIn();
      for (let i = 0; i < 20; i++) expect((await test(s, { channel: 'google' })).ok).toBe(false);
      const limited = await errorOf(call(s, 'POST', '/admin/integrations/test', { channel: 'google' }), 429);
      expect(limited.code).toBe('rate_limited');
      expect(limited.message).toMatch(/a lot of tests/);
      s.ctx.clock.advance(3_600_000);
      expect((await call(s, 'POST', '/admin/integrations/test', { channel: 'google' })).status).toBe(200);
    });
  });
});

// ───────────────────────── images ─────────────────────────

describe('assets', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/webp', WEBP],
    ['image/gif', GIF],
  ])('stores a %s upload', async (type, bytes) => {
    const s = await signIn();
    const { id, url } = await upload(s, type, bytes, 'cover');
    expect(id).toMatch(/^ast_/);
    expect(url).toBe(`/meeting/api/assets/${id}`);
    const stored = await repo.getAsset(s.ctx, id);
    expect(stored?.contentType).toBe(type);
    expect(Buffer.from(stored!.data).equals(bytes)).toBe(true);
    expect((await s.ctx.kv.getBlob(`assets/${id}`))?.metadata.purpose).toBe('cover');
  });

  it('accepts "image/jpg" as JPEG and an odd purpose as a plain image', async () => {
    const s = await signIn();
    const { id } = await ok<{ id: string }>(call(s, 'POST', '/admin/assets', { dataUrl: dataUrl('image/jpg', JPEG), purpose: '../../etc' }), 201);
    expect((await repo.getAsset(s.ctx, id))?.contentType).toBe('image/jpeg');
    expect((await s.ctx.kv.getBlob(`assets/${id}`))?.metadata.purpose).toBe('image');
  });

  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', 'utf8');
  const HTML = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8');

  it.each([
    ['an SVG', dataUrl('image/svg+xml', SVG), /SVG files are not supported/],
    ['an SVG that claims to be a PNG', dataUrl('image/png', SVG), /does not look like a PNG/],
    ['HTML that claims to be a GIF', dataUrl('image/gif', HTML), /does not look like a GIF/],
    ['a JPEG that claims to be a PNG', dataUrl('image/png', JPEG), /is a JPEG image, not a PNG one/],
    ['a PNG that claims to be a WebP', dataUrl('image/webp', PNG), /is a PNG image, not a WebP one/],
    ['a PDF', dataUrl('application/pdf', Buffer.from('%PDF-1.7', 'latin1')), /PNG, JPEG, WebP or GIF/],
    ['a bitmap', dataUrl('image/bmp', Buffer.from('BM000000', 'latin1')), /PNG, JPEG, WebP or GIF/],
    ['a data URL that is not base64', `data:image/png,${encodeURIComponent('\u0089PNG')}`, /could not be read/],
    ['broken base64', 'data:image/png;base64,iVBOR!!!', /could not be read/],
    ['an empty image', 'data:image/png;base64,', /could not be read/],
    ['a web address instead of a file', 'https://example.com/logo.png', /PNG, JPEG, WebP or GIF/],
    ['nothing', undefined, /PNG, JPEG, WebP or GIF/],
  ])('refuses %s', async (_what, value, message) => {
    const s = await signIn();
    const fields = await fieldsOf(call(s, 'POST', '/admin/assets', { dataUrl: value, purpose: 'logo' }));
    expect(fields.dataUrl).toMatch(message);
    expect(await s.ctx.kv.list('assets/')).toEqual([]);
  });

  it('refuses an image over 3 MB, and a request too large to be one', async () => {
    const s = await signIn();
    const exactly = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(3 * 1024 * 1024 - 8, 7)]);
    await upload(s, 'image/png', exactly);
    const over = Buffer.concat([exactly, Buffer.from([1])]);
    expect((await errorOf(call(s, 'POST', '/admin/assets', { dataUrl: dataUrl('image/png', over), purpose: 'logo' }), 413)).code).toBe('too_large');
    const huge = `data:image/png;base64,${'A'.repeat(5 * 1024 * 1024)}`;
    expect((await errorOf(call(s, 'POST', '/admin/assets', { dataUrl: huge, purpose: 'logo' }), 413)).code).toBe('too_large');
    expect(await s.ctx.kv.list('assets/')).toHaveLength(1);
  });

  it('deletes an image and every setting that pointed at it', async () => {
    const s = await signIn();
    const { host } = await addCoHost(s);
    const image = await upload(s);
    const other = await upload(s, 'image/gif', GIF);
    await ok(call(s, 'PUT', '/admin/site', { profile: { avatarAssetId: image.id }, theme: { logoAssetId: image.id, coverAssetId: other.id, background: { type: 'image', imageAssetId: image.id } } }));
    await ok(call(s, 'PUT', `/admin/hosts/${host.id}`, { avatarAssetId: image.id }));
    await ok(call(s, 'PUT', '/admin/event-types/evt_intro', { coverAssetId: image.id, themeOverride: { logoAssetId: image.id, background: { imageAssetId: image.id } } }));
    await ok(call(s, 'PUT', '/admin/event-types/evt_meeting', { coverAssetId: other.id }));

    await ok(call(s, 'DELETE', `/admin/assets/${image.id}`));
    expect(await repo.getAsset(s.ctx, image.id)).toBeNull();
    const site = await repo.getSite(s.ctx);
    expect(site.profile.avatarAssetId).toBeNull();
    expect(site.theme.logoAssetId).toBeNull();
    expect(site.theme.background.imageAssetId).toBeNull();
    expect(site.theme.coverAssetId).toBe(other.id);
    expect((await repo.listHosts(s.ctx)).map((h) => h.avatarAssetId ?? null)).toEqual([null, null]);
    const intro = (await repo.getEventType(s.ctx, 'evt_intro'))!;
    expect(intro.coverAssetId).toBeNull();
    expect(intro.themeOverride).toEqual({ logoAssetId: null, background: { imageAssetId: null } });
    expect((await repo.getEventType(s.ctx, 'evt_meeting'))!.coverAssetId).toBe(other.id);
    expect(await repo.getAsset(s.ctx, other.id)).not.toBeNull();
    expect(JSON.stringify([site, await repo.listHosts(s.ctx), await repo.listEventTypes(s.ctx)])).not.toContain(image.id);

    // Again, and with an id that could never be one.
    await ok(call(s, 'DELETE', `/admin/assets/${image.id}`));
    expect((await errorOf(call(s, 'DELETE', '/admin/assets/..%2F..%2Fsite'), 404)).code).toBe('not_found');
    expect(await repo.getSite(s.ctx)).toEqual(site);
  });
});

// ───────────────────────── overview ─────────────────────────

describe('GET /admin/overview', () => {
  const keys = (o: AdminOverview): string[] => o.warnings.map((w) => w.key);
  const done = (o: AdminOverview): Record<string, boolean> => Object.fromEntries(o.checklist.map((c) => [c.key, c.done]));

  it('on a fresh install: nothing booked, a checklist to work through, and the warnings that matter', async () => {
    const s = await signIn();
    const o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(o.upcoming).toEqual([]);
    expect(o.stats).toEqual({ upcomingCount: 0, last30Count: 0, cancelledLast30: 0, confirmedByAssistant: 0 });
    expect(o.publicUrl).toBe(TEST_BASE_URL);
    expect(done(o)).toEqual({ google: false, availability: true, event: true, email: false, sms: false, assistant: false, design: false });
    expect(keys(o)).toEqual(['google_not_connected', 'no_email', 'owner_no_email', 'bookings_reach_nobody', 'twilio_missing']);
    expect(o.warnings.find((w) => w.key === 'twilio_missing')!.message).toMatch(/"Intro call" and "Meeting" have reminders by text or phone call/);
    // Without email and without a calendar, a booking reaches nobody.
    expect(o.warnings.find((w) => w.key === 'bookings_reach_nobody')!.message).toBe(
      'People can book "Intro call" and "Meeting", but nobody hears about it: no email is sent, and no Google Calendar is connected to put the booking on. Set up email or connect Google Calendar.',
    );
    // Links are routes inside the dashboard, for its own router.
    for (const link of [...o.checklist.map((c) => c.href), ...o.warnings.map((w) => w.href)]) {
      if (link !== undefined) expect(link).toMatch(/^\/admin(\/[a-z-]+)?(#[a-z]+)?$/);
    }
    for (const text of [...o.checklist.map((c) => c.label), ...o.warnings.map((w) => w.message)]) expect(text).not.toContain('—');
  });

  it('ticks things off as they get done', async () => {
    const s = await signIn();
    await connectGoogle(s.ctx, 'host_owner', { gmailSend: true });
    // Notices need an address to go to.
    await ok(call(s, 'PUT', '/admin/hosts/host_owner', { email: 'jimi@example.com' }));
    // A Google connection only works with the keys it was made with.
    await repo.saveSecrets(s.ctx, {
      google: { clientId: '123456789-abcdef.apps.googleusercontent.com', clientSecret: 'GOCSPX-super-secret-value' },
      twilio: { accountSid: `AC${'a'.repeat(32)}`, authToken: 'twilio-auth-token-secret-value-1', fromNumber: '+15005550006' },
      anthropic: { apiKey: 'sk-ant-api03-very-secret-key-value' },
    });
    await ok(call(s, 'PUT', '/admin/site', { theme: { colors: { primary: '#123456' } } }));
    const o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(done(o)).toEqual({ google: true, availability: true, event: true, email: true, sms: true, assistant: true, design: true });
    expect(keys(o)).toEqual([]);

    // Hours and event types can be undone.
    await ok(call(s, 'PUT', '/admin/hosts/host_owner', { schedules: [{ id: 'sch_default', name: 'Working hours', weekly: {}, overrides: [] }] }));
    for (const et of await repo.listEventTypes(s.ctx)) await ok(call(s, 'PUT', `/admin/event-types/${et.id}`, { active: false }));
    const later = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(done(later)).toMatchObject({ availability: false, event: false });
  });

  it('counts what is coming up and what happened in the last 30 days', async () => {
    const s = await signIn();
    for (let i = 0; i < 10; i++) await seedBooking(s.ctx, `bk_up_${i}`, { start: hoursFromNow(10 + i) });
    await seedBooking(s.ctx, 'bk_running', { start: hoursFromNow(-0.1) });
    await seedBooking(s.ctx, 'bk_done', { start: hoursFromNow(-48), createdAt: hoursFromNow(-100), attendance: { confirmedAt: hoursFromNow(-50), confirmedVia: 'call' } });
    await seedBooking(s.ctx, 'bk_link', { start: hoursFromNow(-30), createdAt: hoursFromNow(-100), attendance: { confirmedAt: hoursFromNow(-40), confirmedVia: 'link' } });
    await seedBooking(s.ctx, 'bk_cancelled', { start: hoursFromNow(90), status: 'cancelled', cancellation: { at: hoursFromNow(-5), by: 'invitee' } });
    await seedBooking(s.ctx, 'bk_ancient', { start: hoursFromNow(-24 * 90), createdAt: hoursFromNow(-24 * 100), status: 'cancelled', cancellation: { at: hoursFromNow(-24 * 95), by: 'host' } });
    await seedBooking(s.ctx, 'bk_booked_long_ago', { start: hoursFromNow(200), createdAt: hoursFromNow(-24 * 45) });

    const o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(o.upcoming.map((b) => b.id)).toEqual(['bk_running', ...Array.from({ length: 7 }, (_, i) => `bk_up_${i}`)]);
    expect(o.upcoming[0].manageUrl).toBe(`${TEST_BASE_URL}/booking/bk_running?t=${hmacHex(s.ctx, 'manage', 'bk_running')}`);
    expect(o.upcoming[0].hosts.map((h) => h.id)).toEqual(['host_owner']);
    expect(o.stats).toEqual({ upcomingCount: 12, last30Count: 14, cancelledLast30: 1, confirmedByAssistant: 1 });
  });

  it('warns when Google needs a new sign-in or a calendar cannot be read', async () => {
    const s = await signIn();
    await repo.saveSecrets(s.ctx, { google: { clientId: '123456789-abcdef.apps.googleusercontent.com', clientSecret: 'GOCSPX-super-secret-value' } });
    const { host } = await addCoHost(s);
    await connectGoogle(s.ctx, 'host_owner', { status: 'needs_reconnect' });
    await connectGoogle(s.ctx, host.id, { email: 'alex@example.com', status: 'needs_reconnect' });
    let o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(keys(o)).toEqual(expect.arrayContaining(['google_reconnect_host_owner', `google_reconnect_${host.id}`]));
    expect(o.warnings.find((w) => w.key === 'google_reconnect_host_owner')).toMatchObject({ href: '/admin/integrations#google', message: expect.stringMatching(/^Your Google Calendar needs to be reconnected/) });
    expect(o.warnings.find((w) => w.key === `google_reconnect_${host.id}`)).toMatchObject({ href: '/admin/team', message: expect.stringMatching(/^Alex's Google Calendar needs to be reconnected/) });
    expect(done(o).google).toBe(false);

    await connectGoogle(s.ctx);
    await connectGoogle(s.ctx, host.id, { email: 'alex@example.com' });
    await repo.updateHost(s.ctx, host.id, (h) => ({ ...h, calendarHealth: { ok: false, message: 'Calendar feed "Work" could not be read.', at: TEST_NOW } }));
    o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(keys(o).filter((k) => k.startsWith('google_reconnect'))).toEqual([]);
    const health = o.warnings.find((w) => w.key === `calendar_health_${host.id}`)!;
    expect(health.href).toBe('/admin/team');
    expect(health.message).toBe('Alex\'s calendar could not be read, so times that include Alex are not being offered until this is fixed. Calendar feed "Work" could not be read.');

    await repo.updateHost(s.ctx, host.id, (h) => ({ ...h, calendarHealth: { ok: true, at: TEST_NOW } }));
    expect(keys(await ok<AdminOverview>(call(s, 'GET', '/admin/overview'))).filter((k) => k.startsWith('calendar_health'))).toEqual([]);
  });

  it('warns ahead when a Google connection made in Testing will end, and shows the date on the host', async () => {
    const s = await signIn();
    await repo.saveSecrets(s.ctx, { google: { clientId: '123456789-abcdef.apps.googleusercontent.com', clientSecret: 'GOCSPX-super-secret-value' } });
    const { host } = await addCoHost(s);
    const ends = new Date(Date.parse(TEST_NOW) + 7 * 86_400_000).toISOString();
    await connectGoogle(s.ctx, 'host_owner', { refreshExpiresAt: ends });
    await connectGoogle(s.ctx, host.id, { email: 'alex@example.com', refreshExpiresAt: ends });
    await repo.updateHost(s.ctx, 'host_owner', (h) => ({ ...h, timezone: 'America/New_York' }));

    const o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    const mine = o.warnings.find((w) => w.key === 'google_expiry_host_owner')!;
    expect(mine.href).toBe('/admin/integrations#google');
    expect(mine.message).toMatch(/^Your Google connection ends on \w+day, \w+ \d+, 20\d\d\. After that, no times are offered until you reconnect\./);
    // Google names an end for a consent screen still in Testing, and for a time limit picked when connecting: both are said.
    expect(mine.message).toContain('After that, no times are offered until you reconnect. An end date like this usually means the consent screen in Google Cloud is still in Testing: publish it so it reads In production, then reconnect.');
    expect(mine.message).toContain("If you chose a time limit on Google's screen when you connected, reconnecting and allowing ongoing access is enough.");
    expect(mine.message).not.toContain('because');
    const theirs = o.warnings.find((w) => w.key === `google_expiry_${host.id}`)!;
    expect(theirs).toMatchObject({
      href: '/admin/team',
      message: expect.stringMatching(
        /^Alex's Google connection ends on [^.]+\. An end date like this usually means the consent screen .* then ask Alex to connect again from their private link\. If Alex chose a time limit on Google's screen, connecting again and allowing ongoing access is enough\.$/,
      ),
    });
    for (const w of o.warnings) expect(w.message).not.toMatch(/[‒-―]/);

    // The host view carries the date, so the Google card can say it too.
    const { hosts } = await ok<{ hosts: AdminHost[] }>(call(s, 'GET', '/admin/hosts'));
    expect(hosts.find((h) => h.id === 'host_owner')?.google?.refreshExpiresAt).toBe(ends);

    // Once the day has passed, it says so.
    s.ctx.clock.advance(8 * 86_400_000);
    const ended = (await ok<AdminOverview>(call(s, 'GET', '/admin/overview'))).warnings.find((w) => w.key === 'google_expiry_host_owner')!;
    expect(ended.message).toMatch(/^Your Google connection stopped working on [^.]+\. Until you reconnect, no times are offered\. An end date like this usually means /);

    // Reconnected after publishing: no end, no warning. A connection that already needs reconnecting says that instead.
    await connectGoogle(s.ctx, 'host_owner');
    await connectGoogle(s.ctx, host.id, { email: 'alex@example.com', refreshExpiresAt: ends, status: 'needs_reconnect' });
    const after = keys(await ok<AdminOverview>(call(s, 'GET', '/admin/overview')));
    expect(after.filter((k) => k.startsWith('google_expiry'))).toEqual([]);
    expect(after).toContain(`google_reconnect_${host.id}`);
  });

  it('warns about a joint meeting whose co-host has no calendar yet', async () => {
    const s = await signIn();
    const { host } = await addCoHost(s);
    const { eventType } = await ok<{ eventType: EventType }>(call(s, 'POST', '/admin/event-types', { title: 'Together', kind: 'collective', hostIds: ['host_owner', host.id], reminders: [] }), 201);
    let o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    const warning = o.warnings.find((w) => w.key === `cohost_calendar_${eventType.id}`)!;
    expect(warning.message).toBe('"Together" books Alex too, but Alex has not connected a calendar yet. Only their weekly hours are checked until they do.');
    expect(warning.href).toBe('/admin/team');

    // A calendar feed counts as a calendar. A paused event type does not need a warning.
    await ok(call(s, 'PUT', `/admin/hosts/${host.id}`, { addIcsFeed: { label: 'Work', url: 'https://calendar.example.com/alex.ics' } }));
    o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(keys(o).filter((k) => k.startsWith('cohost_calendar'))).toEqual([]);
  });

  it('only nags about email and Twilio when something actually depends on them', async () => {
    const s = await signIn();
    await ok(call(s, 'PUT', '/admin/site', { email: { provider: 'none' } }));
    for (const et of await repo.listEventTypes(s.ctx)) {
      await ok(call(s, 'PUT', `/admin/event-types/${et.id}`, { reminders: et.reminders.map((r) => ({ ...r, enabled: r.channel === 'email' })) }));
    }
    const o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    // Email off on purpose is not nagged about, but with no calendar either, a booking reaches nobody.
    expect(keys(o)).toEqual(['google_not_connected', 'bookings_reach_nobody']);
  });

  it('says when a booking would reach nobody, until a calendar is connected for every host it can land on', async () => {
    const s = await signIn();
    await ok(call(s, 'PUT', '/admin/site', { email: { provider: 'none' } }));
    await connectGoogle(s.ctx);
    expect(keys(await ok<AdminOverview>(call(s, 'GET', '/admin/overview')))).not.toContain('bookings_reach_nobody');

    // A round robin can land on a co-host without a calendar: that booking would reach nobody.
    const { host } = await addCoHost(s);
    await ok(call(s, 'POST', '/admin/event-types', { title: 'Either of us', kind: 'round_robin', hostIds: ['host_owner', host.id] }), 201);
    const o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(o.warnings.find((w) => w.key === 'bookings_reach_nobody')?.message).toMatch(/^People can book "Either of us", but nobody hears about it/);
    await connectGoogle(s.ctx, host.id, { email: 'alex.calendar@example.com' });
    expect(keys(await ok<AdminOverview>(call(s, 'GET', '/admin/overview')))).not.toContain('bookings_reach_nobody');
  });

  it('does not say people can book a meeting whose calendar cannot be read, but still names one that stays open', async () => {
    const s = await signIn();
    await ok(call(s, 'PUT', '/admin/site', { email: { provider: 'none' } }));
    await repo.saveSecrets(s.ctx, { google: { clientId: ['4242', 'test.apps.googleusercontent.com'].join('-'), clientSecret: ['test', 'client', 'secret'].join('-') } });
    await connectGoogle(s.ctx, 'host_owner', { status: 'needs_reconnect' });
    // Solo meetings with the owner offer no times at all now: the reconnect warning says so, alone.
    let o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(keys(o)).toContain('google_reconnect_host_owner');
    expect(keys(o)).not.toContain('bookings_reach_nobody');

    // A round robin still offers the co-host's times, and with no calendar and no email that booking reaches nobody.
    const { host } = await addCoHost(s);
    await ok(call(s, 'POST', '/admin/event-types', { title: 'Either of us', kind: 'round_robin', hostIds: ['host_owner', host.id] }), 201);
    o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(o.warnings.find((w) => w.key === 'bookings_reach_nobody')?.message).toMatch(/^People can book "Either of us", but nobody hears about it/);
    // Once the co-host's calendar takes the booking, it is heard about.
    await connectGoogle(s.ctx, host.id, { email: 'alex.calendar@example.com' });
    expect(keys(await ok<AdminOverview>(call(s, 'GET', '/admin/overview')))).not.toContain('bookings_reach_nobody');
  });

  it('warns when links would point at the wrong address', async () => {
    const netlify = await signIn({ env: { publicBaseUrl: 'https://jimicohen-meeting.netlify.app/meeting' } });
    const o = await ok<AdminOverview>(handle(apiRequest('GET', '/admin/overview', { cookie: netlify.cookie, baseUrl: 'https://jimicohen-meeting.netlify.app/meeting' }), netlify.ctx));
    const warning = o.warnings.find((w) => w.key === 'public_base_url')!;
    expect(warning.message).toContain('jimicohen-meeting.netlify.app');
    expect(warning.message).toContain('PUBLIC_BASE_URL');
    expect(warning.href).toBeUndefined();

    const insecure = await signIn({ env: { publicBaseUrl: 'http://jimicohen.com/meeting' } });
    const o2 = await ok<AdminOverview>(handle(apiRequest('GET', '/admin/overview', { cookie: insecure.cookie, baseUrl: 'http://jimicohen.com/meeting' }), insecure.ctx));
    expect(keys(o2)).toContain('public_base_url');

    // The local dev server runs on plain http on purpose.
    const dev = await signIn({ env: { publicBaseUrl: 'http://localhost:8788/meeting', mockProviders: true } });
    const o3 = await ok<AdminOverview>(handle(apiRequest('GET', '/admin/overview', { cookie: dev.cookie, baseUrl: 'http://localhost:8788/meeting' }), dev.ctx));
    expect(keys(o3)).not.toContain('public_base_url');
  });

  it('says where to add the address for booking notices when there is none', async () => {
    const s = await signIn();
    const warning = (await ok<AdminOverview>(call(s, 'GET', '/admin/overview'))).warnings.find((w) => w.key === 'owner_no_email')!;
    expect(warning.href).toBe('/admin/settings#notices');
    expect(warning.message).toMatch(/you are not emailed when someone books, moves or cancels a meeting/);
    expect(warning.message).not.toContain('—');

    await ok(call(s, 'PUT', '/admin/hosts/host_owner', { email: 'jimi@example.com' }));
    expect(keys(await ok<AdminOverview>(call(s, 'GET', '/admin/overview')))).not.toContain('owner_no_email');
  });

  it('says plainly what stops when the Google connection behind Gmail dies', async () => {
    const s = await signIn();
    await repo.saveSecrets(s.ctx, { google: { clientId: '123456789-abcdef.apps.googleusercontent.com', clientSecret: 'GOCSPX-super-secret-value' } });
    await ok(call(s, 'PUT', '/admin/hosts/host_owner', { email: 'jimi@example.com' }));
    await connectGoogle(s.ctx, 'host_owner', { gmailSend: true, status: 'needs_reconnect' });
    let o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    const reconnect = o.warnings.find((w) => w.key === 'google_reconnect_host_owner')!;
    expect(reconnect.message).toBe(
      'Your Google Calendar needs to be reconnected. Until then, no times are offered for meetings with you and new bookings cannot reach your calendar. No emails are going out either, because they are sent from your Gmail.',
    );
    expect(reconnect.href).toBe('/admin/integrations#google');
    // One warning for one cause: not a second one that blames a missing email provider, or that says
    // people "can book" meetings that offer no times while the calendar cannot be read.
    expect(keys(o)).not.toContain('no_email');
    expect(keys(o)).not.toContain('bookings_reach_nobody');
    expect(done(o)).toMatchObject({ google: false, email: false });

    // The keys behind the connection were removed: the connection cannot work at all.
    await connectGoogle(s.ctx, 'host_owner', { gmailSend: true });
    await ok(call(s, 'PUT', '/admin/integrations', { google: { clientId: '', clientSecret: '' } }));
    o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    const keysGone = o.warnings.find((w) => w.key === 'google_keys_missing')!;
    expect(keysGone.message).toBe(
      'The Google keys were removed, so your Google Calendar cannot be read and no times are offered for meetings with you. No emails are going out either, because they are sent from your Gmail. Add the same client ID and client secret again under Integrations.',
    );
    expect(keysGone.href).toBe('/admin/integrations#google');
    expect(keys(o).filter((k) => k === 'no_email' || k === 'bookings_reach_nobody' || k.startsWith('google_reconnect') || k.startsWith('calendar_health'))).toEqual([]);
    expect(done(o)).toMatchObject({ google: false, email: false });
  });

  it('names a co-host whose calendar is cut off when the Google keys go', async () => {
    const s = await signIn();
    const { host } = await addCoHost(s);
    await connectGoogle(s.ctx, host.id, { email: 'alex@example.com' });
    const o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(o.warnings.find((w) => w.key === 'google_keys_missing')!.message).toBe(
      "The Google keys were removed, so Alex's Google Calendar cannot be read and times that include Alex are not offered. Add the same client ID and client secret again under Integrations.",
    );
  });

  it('tells reminder calls apart from texts when Twilio has only a Messaging Service', async () => {
    const s = await signIn();
    await repo.saveSecrets(s.ctx, { twilio: { accountSid: `AC${'a'.repeat(32)}`, authToken: 'twilio-auth-token-secret-value-1', fromNumber: '', messagingServiceSid: `MG${'f'.repeat(32)}` } });
    const o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(o.warnings.find((w) => w.key === 'twilio_missing')!.message).toBe(
      '"Intro call" and "Meeting" have reminder calls, but reminder calls need a Twilio phone number and none is saved, so those calls are skipped. Texts still go out.',
    );
    expect(done(o).sms).toBe(false);

    // Texts alone do not need a number.
    for (const et of await repo.listEventTypes(s.ctx)) {
      await ok(call(s, 'PUT', `/admin/event-types/${et.id}`, { reminders: et.reminders.filter((r) => r.channel !== 'call') }));
    }
    expect(keys(await ok<AdminOverview>(call(s, 'GET', '/admin/overview')))).not.toContain('twilio_missing');
  });

  /** Owner in Los Angeles, Alex in Berlin, both on the default 9 to 5. Those hours never meet. */
  async function apartJoint(s: Session): Promise<{ host: AdminHost; eventType: EventType }> {
    const { host } = await addCoHost(s);
    await ok(call(s, 'PUT', '/admin/hosts/host_owner', { timezoneMode: 'fixed', timezone: 'America/Los_Angeles' }));
    await ok(call(s, 'PUT', `/admin/hosts/${host.id}`, { timezoneMode: 'fixed', timezone: 'Europe/Berlin' }));
    const { eventType } = await ok<{ eventType: EventType }>(call(s, 'POST', '/admin/event-types', { title: 'Together', kind: 'collective', hostIds: ['host_owner', host.id], reminders: [] }), 201);
    return { host, eventType };
  }

  it('warns about a joint meeting whose hosts are never working at the same time', async () => {
    const s = await signIn();
    const { host, eventType } = await apartJoint(s);
    let o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    const warning = o.warnings.find((w) => w.key === `shared_hours_${eventType.id}`)!;
    expect(warning.message).toBe(
      '"Together" cannot be booked: there is no time when you and Alex are both working. Your hours are in Los Angeles time and Alex\'s hours are in Berlin time. Change your hours under Availability, or ask Alex to change theirs on their private page.',
    );
    expect(warning.href).toBe('/admin/availability');

    // Someone with no hours at all is a different problem, and said so.
    await ok(call(s, 'PUT', `/admin/hosts/${host.id}`, { schedules: [{ id: 'sch_default', name: 'Working hours', weekly: {}, overrides: [] }] }));
    o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(o.warnings.find((w) => w.key === `shared_hours_${eventType.id}`)).toEqual({
      key: `shared_hours_${eventType.id}`,
      message: '"Together" cannot be booked: Alex has no working hours for it in the next 60 days. Ask Alex to set their hours on their private page.',
      href: '/admin/team',
    });

    // Hours that meet for part of the day are enough.
    await ok(call(s, 'PUT', `/admin/hosts/${host.id}`, { timezone: 'America/New_York', schedules: [{ id: 'sch_default', name: 'Working hours', weekly: { 1: [{ start: '09:00', end: '17:00' }] }, overrides: [] }] }));
    o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(keys(o).filter((k) => k.startsWith('shared_hours'))).toEqual([]);
  });

  it('does not say people can book a joint meeting that cannot be booked, next to the warning that says so', async () => {
    const s = await signIn();
    await ok(call(s, 'PUT', '/admin/site', { email: { provider: 'none' } }));
    const { eventType } = await apartJoint(s);
    await ok(call(s, 'PUT', `/admin/event-types/${eventType.id}`, { reminders: [{ id: 'rem_sms', channel: 'sms', audience: 'invitee', trigger: 'before_start', offsetMinutes: 60, enabled: true }] }));
    const o = await ok<AdminOverview>(call(s, 'GET', '/admin/overview'));
    expect(keys(o)).toContain(`shared_hours_${eventType.id}`);
    // The other meetings can still be booked and are still named; the joint one is not.
    const unheard = o.warnings.find((w) => w.key === 'bookings_reach_nobody')!;
    expect(unheard.message).toMatch(/^People can book "Intro call" and "Meeting", but nobody hears about it/);
    expect(unheard.message).not.toContain('Together');
    expect(o.warnings.find((w) => w.key === 'twilio_missing')?.message ?? '').not.toContain('Together');
  });

  describe('POST /admin/event-types-check', () => {
    it('checks a joint meeting on screen, saved or not, and stores nothing', async () => {
      const s = await signIn();
      const { host, eventType } = await apartJoint(s);
      const before = JSON.stringify(await repo.listEventTypes(s.ctx));

      const draft = await ok<SharedHoursCheck>(call(s, 'POST', '/admin/event-types-check', { title: 'Late night', kind: 'collective', hostIds: ['host_owner', host.id], durations: [30] }));
      expect(draft).toMatchObject({ ok: false, reason: 'no_overlap', href: '/admin/availability' });
      expect(draft.message).toMatch(/^"Late night" cannot be booked: there is no time when you and Alex are both working\./);

      // The saved event, with what is on screen now: a round robin offers either person's hours.
      expect(await ok<SharedHoursCheck>(call(s, 'POST', '/admin/event-types-check', { id: eventType.id }))).toMatchObject({ ok: false, reason: 'no_overlap' });
      expect(await ok<SharedHoursCheck>(call(s, 'POST', '/admin/event-types-check', { id: eventType.id, kind: 'round_robin' }))).toEqual({ ok: true });
      // Limited hours on the Scheduling tab count. With Alex in New York the two overlap from 9 to 2
      // Los Angeles time, but not from 6 to 7 (Alex only) or from 3 to 4 (the owner only).
      await ok(call(s, 'PUT', `/admin/hosts/${host.id}`, { timezone: 'America/New_York' }));
      const joint = { kind: 'collective', hostIds: ['host_owner', host.id] };
      expect(await ok<SharedHoursCheck>(call(s, 'POST', '/admin/event-types-check', joint))).toEqual({ ok: true });
      const apart = [{ start: '06:00', end: '07:00' }, { start: '15:00', end: '16:00' }];
      const limited = await ok<SharedHoursCheck>(call(s, 'POST', '/admin/event-types-check', { ...joint, scheduling: { ...eventType.scheduling, restrictHours: { 0: [], 1: apart, 2: [], 3: [], 4: [], 5: [], 6: [] } } }));
      expect(limited).toMatchObject({ ok: false, reason: 'no_overlap' });
      expect(limited.message).toContain('The limited hours on its Scheduling tab count too.');

      // A draft that does not add up yet has nothing to say: saving it reports the problem.
      expect(await ok<SharedHoursCheck>(call(s, 'POST', '/admin/event-types-check', { kind: 'collective', hostIds: ['host_owner'] }))).toEqual({ ok: true });
      expect(await ok<SharedHoursCheck>(call(s, 'POST', '/admin/event-types-check', { kind: 'solo', hostIds: ['host_owner'] }))).toEqual({ ok: true });
      expect((await errorOf(call(s, 'POST', '/admin/event-types-check', ['not', 'an', 'event']), 400)).code).toBe('invalid_json');
      expect(JSON.stringify(await repo.listEventTypes(s.ctx))).toBe(before);
    });
  });
});
