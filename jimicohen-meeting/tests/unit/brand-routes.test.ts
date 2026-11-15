/**
 * Brands and short links through the API: the dashboard routes (bootstrap, brands, short links, event
 * types, adding a co-host, site saves, images) and the public ones (short links, event and manage pages,
 * the calendar file, the built-in email logo).
 */
import { describe, expect, it } from 'vitest';
import { ECO_CHAMPIONS } from '../../shared/brands';
import { newEventType } from '../../shared/defaults';
import type { AdminBootstrap, CreateBookingResponse, EventType, GetBookingResponse, HostInviteResponse, PublicEventResponse, PublicSite, ShortLinkResponse, SiteSettings } from '../../shared/types';
import { handle } from '../../server/api';
import { sessionSetCookie } from '../../server/lib/auth';
import { manageToken } from '../../server/lib/booking';
import type { KV } from '../../server/lib/ctx';
import * as repo from '../../server/lib/repo';
import { runShortLinkMove } from '../../server/lib/seed';
import { apiRequest, cookiePair, makeTestCtx, markSetUp, type TestCtx } from '../helpers/ctx';

const NOW = '2026-11-16T09:00:00.000Z';
const WED_14 = '2026-11-18T14:00:00.000Z';
const ECO = 'brand_eco_champions';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

interface Session {
  ctx: TestCtx;
  cookie: string;
}

async function signIn(opts: { setUp?: boolean } = {}): Promise<Session> {
  const ctx = makeTestCtx({ now: NOW });
  await repo.getSite(ctx);
  await repo.updateHost(ctx, 'host_owner', (h) => ({ ...h, email: 'jimi@example.com' }));
  await ctx.kv.setJSON('auth/admin', { passwordHash: 'not-used-in-these-tests', passwordVersion: 1, setupUsedAt: NOW });
  if (opts.setUp !== false) await markSetUp(ctx);
  return { ctx, cookie: cookiePair(sessionSetCookie(ctx, 1)) };
}

function call(s: Session, method: string, path: string, body?: unknown): Promise<Response> {
  return handle(apiRequest(method, path, { body, cookie: s.cookie }), s.ctx);
}

function get(ctx: TestCtx, path: string): Promise<Response> {
  return handle(apiRequest('GET', path), ctx);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function fieldsOf(res: Response | Promise<Response>, status = 422): Promise<Record<string, string>> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return (JSON.parse(text).error.fields ?? {}) as Record<string, string>;
}

/** Counts the writes made to the store from now on. */
function countWrites(ctx: TestCtx): { writes: string[] } {
  const seen = { writes: [] as string[] };
  const kv = ctx.kv;
  const setJSON = kv.setJSON.bind(kv);
  const setBlob = kv.setBlob.bind(kv);
  const del = kv.delete.bind(kv);
  kv.setJSON = ((key: string, value: unknown, o?: Parameters<KV['setJSON']>[2]) => {
    seen.writes.push(key);
    return setJSON(key, value, o);
  }) as KV['setJSON'];
  kv.setBlob = ((key: string, ...rest: unknown[]) => {
    seen.writes.push(key);
    return (setBlob as (...a: unknown[]) => unknown)(key, ...rest);
  }) as KV['setBlob'];
  kv.delete = ((key: string) => {
    seen.writes.push(`delete ${key}`);
    return del(key);
  }) as KV['delete'];
  return seen;
}

async function podEvent(ctx: TestCtx): Promise<EventType> {
  return (await repo.getEventType(ctx, 'evt_eco_champions'))!;
}

async function bookPod(ctx: TestCtx, over: Record<string, unknown> = {}): Promise<CreateBookingResponse> {
  const body = { slug: 'eco-champions', start: WED_14, durationMin: 30, name: 'Ann Lee', email: 'ann@example.com', timezone: 'Europe/London', elapsedMs: 5200, ...over };
  return ok(handle(apiRequest('POST', '/public/bookings', { body }), ctx), 201);
}

async function upload(s: Session): Promise<string> {
  const res = await ok<{ id: string }>(call(s, 'POST', '/admin/assets', { dataUrl: `data:image/png;base64,${PNG.toString('base64')}`, purpose: 'logo' }), 201);
  return res.id;
}

// ───────────────────────── dashboard ─────────────────────────

describe('GET /admin/bootstrap', () => {
  it('writes nothing, before and after the setup, and lists the short links only once they are set', async () => {
    const s = await signIn();
    let seen = countWrites(s.ctx);
    const before = await ok<AdminBootstrap>(call(s, 'GET', '/admin/bootstrap'));
    expect(seen.writes).toEqual([]);
    expect(before.shortLinks).toBeNull();

    await runShortLinkMove(s.ctx);
    seen = countWrites(s.ctx);
    const after = await ok<AdminBootstrap>(call(s, 'GET', '/admin/bootstrap'));
    expect(seen.writes).toEqual([]);
    expect(after.shortLinks).toEqual([
      { name: 'meet', url: 'https://jimicohen.com/meet', eventTypeId: 'evt_meeting' },
      { name: 'pod', url: 'https://jimicohen.com/pod', eventTypeId: 'evt_eco_champions' },
    ]);
    expect(after.eventTypes.find((e) => e.id === 'evt_eco_champions')?.brandId).toBe(ECO);

    // A link whose event was deleted opens nothing.
    await repo.deleteEventType(s.ctx, 'evt_eco_champions');
    const gone = await ok<AdminBootstrap>(call(s, 'GET', '/admin/bootstrap'));
    expect(gone.shortLinks?.find((l) => l.name === 'pod')?.eventTypeId).toBeNull();
  });
});

describe('PUT /admin/brands/:id', () => {
  it('stores the look, logo and sender name of the brand, and leaves the owner look alone', async () => {
    const s = await signIn();
    const siteBefore = await repo.getSite(s.ctx);
    const logo = await upload(s);
    const res = await ok<{ brand: { id: string; emailFromName: string; theme: { colors: { primary: string }; logoAssetId: string } }; site: SiteSettings }>(
      call(s, 'PUT', `/admin/brands/${ECO}`, { theme: { colors: { primary: '#0f5132' }, logoAssetId: logo }, emailFromName: 'Eco Champions Studio' }),
    );
    expect(res.brand).toMatchObject({ id: ECO, emailFromName: 'Eco Champions Studio', theme: { colors: { primary: '#0f5132' }, logoAssetId: logo } });
    const stored = await repo.getSite(s.ctx);
    expect(stored.brands).toHaveLength(1);
    expect(stored.theme).toEqual(siteBefore.theme);
    expect(stored.profile).toEqual(siteBefore.profile);
    expect(stored.email).toEqual(siteBefore.email);

    // A second change keeps the first.
    await ok(call(s, 'PUT', `/admin/brands/${ECO}`, { theme: { radius: 4 } }));
    const again = (await repo.getSite(s.ctx)).brands![0];
    expect(again.theme).toMatchObject({ radius: 4, logoAssetId: logo, colors: { primary: '#0f5132' } });
    expect(again.emailFromName).toBe('Eco Champions Studio');

    // "Use the built-in logo".
    await ok(call(s, 'PUT', `/admin/brands/${ECO}`, { theme: { logoAssetId: null } }));
    expect((await repo.getSite(s.ctx)).brands![0].theme.logoAssetId).toBeNull();
  });

  it('refuses bad fields under their names, an image that is not there, and a brand that is not built in', async () => {
    const s = await signIn();
    const fields = await fieldsOf(call(s, 'PUT', `/admin/brands/${ECO}`, { theme: { colors: { primary: 'green' }, logoAssetId: 'ast_missing0000000' }, emailFromName: 'x'.repeat(81) }));
    expect(fields['theme.colors.primary']).toMatch(/hex colour/);
    expect(fields['theme.logoAssetId']).toMatch(/not available/);
    expect(fields.emailFromName).toBe('Please keep this to 80 characters or fewer.');
    expect((await repo.getSite(s.ctx)).brands).toBeUndefined();
    const missing = await call(s, 'PUT', '/admin/brands/brand_nobody', { emailFromName: 'Nobody' });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.message).toBe('That brand does not exist.');
  });
});

describe('PUT /admin/short-links', () => {
  it('refuses a name that is not a short link and a meeting that does not exist', async () => {
    const s = await signIn();
    expect(await fieldsOf(call(s, 'PUT', '/admin/short-links', { name: 'pods', eventTypeId: 'evt_intro' }))).toEqual({ name: 'Choose jimicohen.com/meet or jimicohen.com/pod.' });
    expect(await fieldsOf(call(s, 'PUT', '/admin/short-links', { name: 'pod', eventTypeId: 'evt_gone' }))).toEqual({ eventTypeId: 'That meeting no longer exists. Choose another.' });
    expect((await repo.getSite(s.ctx)).shortLinks).toBeUndefined();
  });

  it('moves a link, turns one off, and with brand gives the event the link look first', async () => {
    const s = await signIn();
    await runShortLinkMove(s.ctx);
    const moved = await ok(call(s, 'PUT', '/admin/short-links', { name: 'pod', eventTypeId: 'evt_intro' }));
    expect(moved.shortLinks).toEqual({ meet: 'evt_meeting', pod: 'evt_intro' });
    expect((await repo.getEventType(s.ctx, 'evt_intro'))!.brandId).toBeUndefined();

    const branded = await ok(call(s, 'PUT', '/admin/short-links', { name: 'pod', eventTypeId: 'evt_intro', brand: true }));
    expect(branded.eventType.brandId).toBe(ECO);
    expect((await repo.getEventType(s.ctx, 'evt_intro'))!.brandId).toBe(ECO);

    // /meet with brand: the owner's own look again.
    const own = await ok(call(s, 'PUT', '/admin/short-links', { name: 'meet', eventTypeId: 'evt_intro', brand: true }));
    expect(own.eventType.brandId).toBeNull();
    expect(own.shortLinks).toEqual({ meet: 'evt_intro', pod: 'evt_intro' });

    const off = await ok(call(s, 'PUT', '/admin/short-links', { name: 'pod', eventTypeId: null }));
    expect(off.shortLinks).toEqual({ meet: 'evt_intro', pod: null });
  });

  it('answers 503 when the link cannot be written, and the brand change stays', async () => {
    const s = await signIn();
    await runShortLinkMove(s.ctx);
    const setJSON = s.ctx.kv.setJSON.bind(s.ctx.kv);
    s.ctx.kv.setJSON = (async (key: string, value: unknown, o?: Parameters<KV['setJSON']>[2]) => {
      if (key === 'site') throw new Error('store down');
      return setJSON(key, value, o);
    }) as KV['setJSON'];
    const res = await call(s, 'PUT', '/admin/short-links', { name: 'pod', eventTypeId: 'evt_intro', brand: true });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('busy');
    expect((await repo.getEventType(s.ctx, 'evt_intro'))!.brandId).toBe(ECO);
    expect((await repo.getSite(s.ctx)).shortLinks).toEqual({ meet: 'evt_meeting', pod: 'evt_eco_champions' });
  });
});

describe('event types and the brand', () => {
  it('accepts a known brand, refuses another, and keeps the stored brand when a save does not send it', async () => {
    const s = await signIn();
    expect(await fieldsOf(call(s, 'PUT', '/admin/event-types/evt_intro', { brandId: 'brand_nobody' }))).toEqual({ brandId: 'Choose your own look or Eco Champions.' });
    const set = await ok<{ eventType: EventType }>(call(s, 'PUT', '/admin/event-types/evt_intro', { brandId: ECO }));
    expect(set.eventType.brandId).toBe(ECO);
    // A tab opened before brands existed sends the event without the field: the brand stays.
    const { brandId: _dropped, ...older } = set.eventType;
    const kept = await ok<{ eventType: EventType }>(call(s, 'PUT', '/admin/event-types/evt_intro', { ...older, title: 'Intro call, again' }));
    expect(kept.eventType.brandId).toBe(ECO);
    expect(kept.eventType.title).toBe('Intro call, again');
    const cleared = await ok<{ eventType: EventType }>(call(s, 'PUT', '/admin/event-types/evt_intro', { brandId: null }));
    expect(cleared.eventType.brandId).toBeNull();

    const created = await ok<{ eventType: EventType }>(call(s, 'POST', '/admin/event-types', { title: 'Sponsor call', brandId: ECO }), 201);
    expect(created.eventType.brandId).toBe(ECO);
  });

  it('a copy keeps the brand and no link opens it; reordering keeps every brand', async () => {
    const s = await signIn();
    await runShortLinkMove(s.ctx);
    const copy = await ok<{ eventType: EventType }>(call(s, 'POST', '/admin/event-types/evt_eco_champions/duplicate', {}), 201);
    expect(copy.eventType.brandId).toBe(ECO);
    expect((await repo.getSite(s.ctx)).shortLinks!.pod).toBe('evt_eco_champions');
    await ok(call(s, 'PUT', '/admin/event-types-order', { ids: [copy.eventType.id, 'evt_eco_champions', 'evt_meeting', 'evt_intro'] }));
    expect((await podEvent(s.ctx)).brandId).toBe(ECO);
    expect((await repo.getEventType(s.ctx, copy.eventType.id))!.brandId).toBe(ECO);
  });

  it('a slug that became reserved stays usable for the event that already has it, and no new one gets it', async () => {
    const s = await signIn();
    await repo.saveEventType(s.ctx, newEventType(NOW, { id: 'evt_old_pod', slug: 'pod', title: 'Old pod', position: 4 }));
    await ok(call(s, 'PUT', '/admin/event-types/evt_old_pod', { slug: 'pod', title: 'Old pod, renamed' }));
    expect(await fieldsOf(call(s, 'PUT', '/admin/event-types/evt_intro', { slug: 'meet' }))).toEqual({ slug: 'That link is reserved. Please choose another.' });
    expect(await fieldsOf(call(s, 'POST', '/admin/event-types', { title: 'Brand', slug: 'brand' }))).toEqual({ slug: 'That link is reserved. Please choose another.' });
  });
});

describe('POST /admin/hosts with addToEventTypeIds', () => {
  it('adds the new co-host to the meetings ticked: a solo meeting becomes a joint one', async () => {
    const s = await signIn();
    await runShortLinkMove(s.ctx);
    expect((await podEvent(s.ctx)).kind).toBe('solo');
    const res = await ok<HostInviteResponse>(call(s, 'POST', '/admin/hosts', { name: 'Ian Poirier', email: 'ian@example.com', addToEventTypeIds: ['evt_eco_champions', 'evt_gone'] }), 201);
    expect(res.host.name).toBe('Ian Poirier');
    const pod = await podEvent(s.ctx);
    expect(pod).toMatchObject({ kind: 'collective', hostIds: ['host_owner', res.host.id], brandId: ECO });
    expect(res.eventTypes?.map((e) => e.id)).toEqual(['evt_eco_champions']);
    expect(res.notAddedTo).toEqual([{ id: 'evt_gone', message: 'That meeting no longer exists.' }]);
    // Nothing ticked: nothing changes.
    const sam = await ok<HostInviteResponse>(call(s, 'POST', '/admin/hosts', { name: 'Sam Lee', email: 'sam@example.com' }), 201);
    expect(sam.eventTypes).toBeUndefined();
    expect((await podEvent(s.ctx)).hostIds).toEqual(['host_owner', res.host.id]);
  });

  it('reports a meeting that already has 20 hosts, and still adds the co-host when the meetings cannot be changed', async () => {
    const s = await signIn();
    const full = newEventType(NOW, { id: 'evt_full', slug: 'full', title: 'Full', kind: 'collective', hostIds: ['host_owner', ...Array.from({ length: 19 }, (_, i) => `host_x${i}`)], position: 3 });
    await repo.saveEventType(s.ctx, full);
    const res = await ok<HostInviteResponse>(call(s, 'POST', '/admin/hosts', { name: 'Ian Poirier', email: 'ian@example.com', addToEventTypeIds: ['evt_full'] }), 201);
    expect(res.notAddedTo).toEqual([{ id: 'evt_full', message: 'That meeting already has 20 hosts.' }]);

    const setJSON = s.ctx.kv.setJSON.bind(s.ctx.kv);
    s.ctx.kv.setJSON = (async (key: string, value: unknown, o?: Parameters<KV['setJSON']>[2]) => {
      if (key === 'event-types') throw new Error('store down');
      return setJSON(key, value, o);
    }) as KV['setJSON'];
    const lee = await ok<HostInviteResponse>(call(s, 'POST', '/admin/hosts', { name: 'Lee Park', email: 'lee@example.com', addToEventTypeIds: ['evt_intro'] }), 201);
    expect(lee.notAddedTo).toEqual([{ id: 'evt_intro', message: 'The meeting could not be changed just now.' }]);
    expect((await repo.listHosts(s.ctx)).some((h) => h.email === 'lee@example.com')).toBe(true);
  });

  it('refuses a list it cannot read before anyone is added', async () => {
    const s = await signIn();
    expect(await fieldsOf(call(s, 'POST', '/admin/hosts', { name: 'Ian', email: 'ian@example.com', addToEventTypeIds: 'evt_intro' }))).toEqual({ addToEventTypeIds: 'Choose meetings from the list.' });
    expect(await fieldsOf(call(s, 'POST', '/admin/hosts', { name: 'Ian', email: 'ian@example.com', addToEventTypeIds: Array.from({ length: 21 }, (_, i) => `evt_${i}`) }))).toEqual({
      addToEventTypeIds: 'Choose meetings from the list.',
    });
    expect((await repo.listHosts(s.ctx)).map((h) => h.id)).toEqual(['host_owner']);
  });
});

describe('PUT /admin/site and the other writers of the site settings', () => {
  it('a Design save racing the short link setup keeps the link map', async () => {
    const s = await signIn();
    const setJSON = s.ctx.kv.setJSON.bind(s.ctx.kv);
    let raced = false;
    s.ctx.kv.setJSON = (async (key: string, value: unknown, o?: Parameters<KV['setJSON']>[2]) => {
      // Right before the dashboard's save lands, the setup writes the map.
      if (key === 'site' && !raced && (value as SiteSettings).profile?.headline === 'Talk to Jimi') {
        raced = true;
        const now = (await s.ctx.kv.getJSON<SiteSettings>('site'))!;
        await setJSON('site', { ...now, shortLinks: { meet: 'evt_meeting', pod: 'evt_intro' } });
      }
      return setJSON(key, value, o);
    }) as KV['setJSON'];
    const { site } = await ok<{ site: SiteSettings }>(call(s, 'PUT', '/admin/site', { profile: { headline: 'Talk to Jimi' }, shortLinks: { pod: null }, brands: [] }));
    expect(raced).toBe(true);
    expect(site.profile.headline).toBe('Talk to Jimi');
    // Keys the Design save does not own are never taken from its body.
    expect(site.shortLinks).toEqual({ meet: 'evt_meeting', pod: 'evt_intro' });
    expect(site.brands).toBeUndefined();
  });

  it("renames the owner only while the owner and the profile carry the same name", async () => {
    const s = await signIn();
    await repo.updateHost(s.ctx, 'host_owner', (h) => ({ ...h, name: 'Jimi C.' }));
    await ok(call(s, 'PUT', '/admin/site', { profile: { name: 'Eco Champions Studio' } }));
    expect((await repo.getHost(s.ctx, 'host_owner'))!.name).toBe('Jimi C.');
  });

  it('deleting an image takes it out of the brand look too, back to the built-in logo', async () => {
    const s = await signIn();
    const logo = await upload(s);
    await ok(call(s, 'PUT', `/admin/brands/${ECO}`, { theme: { logoAssetId: logo } }));
    await ok(call(s, 'DELETE', `/admin/assets/${logo}`));
    expect((await repo.getSite(s.ctx)).brands![0].theme.logoAssetId).toBeNull();
    // The built-in email logo is not an upload and cannot be deleted.
    expect((await call(s, 'DELETE', '/admin/assets/builtin_eco_champions_email')).status).toBe(404);
  });
});

// ───────────────────────── public ─────────────────────────

describe('GET /public/short/:name', () => {
  it('opens the event the link points at, in its brand, and writes nothing', async () => {
    const s = await signIn();
    await runShortLinkMove(s.ctx);
    const seen = countWrites(s.ctx);
    const pod = await ok<ShortLinkResponse>(get(s.ctx, '/public/short/pod'));
    expect(seen.writes).toEqual([]);
    expect(pod).toMatchObject({ name: 'pod', url: 'https://jimicohen.com/pod', state: 'open' });
    if (pod.state !== 'open') throw new Error('not open');
    expect(pod.eventType).toMatchObject({ id: 'evt_eco_champions', title: 'Eco Champions conversation', shortUrl: 'https://jimicohen.com/pod' });
    expect(pod.site.profile).toEqual({ name: 'Eco Champions', headline: '', welcome: '', avatarUrl: null, links: [] });
    expect(pod.site.theme.colors.primary).toBe('#14432f');
    expect(pod.site.themeAssets.logoUrl).toBe('/meeting/brand/eco-champions/logo.svg');
    expect(pod.site.brand).toEqual({ id: ECO, name: 'Eco Champions', iconUrl: '/meeting/brand/eco-champions/favicon.svg' });
    expect(pod.site.eventTypes).toEqual([]);
    // The consent wording is the site's, unchanged.
    expect(pod.site.booking.consentText).toBe((await repo.getSite(s.ctx)).booking.consentText);

    const meet = await ok<ShortLinkResponse>(get(s.ctx, '/public/short/meet'));
    expect(meet.state).toBe('open');
    expect(meet.site.profile.name).toBe('Jimi Cohen');
    expect(meet.site.brand).toBeNull();
    if (meet.state === 'open') expect(meet.eventType.title).toBe('Meeting with Jimi');
  });

  it('a paused event, a link opening nothing and the time before setup show the closed page in the right brand', async () => {
    const s = await signIn();
    await runShortLinkMove(s.ctx);
    await repo.updateEventTypes(s.ctx, (list) => ({ next: list.map((e) => (e.id === 'evt_eco_champions' ? { ...e, active: false } : e)), result: null }));
    const paused = await ok<ShortLinkResponse>(get(s.ctx, '/public/short/pod'));
    expect(paused).toMatchObject({ state: 'closed', reason: 'paused', site: { brand: { id: ECO }, profile: { name: 'Eco Champions' } } });

    await repo.updateSite(s.ctx, (site) => ({ ...site, shortLinks: { ...site.shortLinks, pod: null, meet: null } }));
    const unassigned = await ok<ShortLinkResponse>(get(s.ctx, '/public/short/pod'));
    expect(unassigned).toMatchObject({ state: 'closed', reason: 'unassigned', site: { brand: { id: ECO } } });
    const meet = await ok<ShortLinkResponse>(get(s.ctx, '/public/short/meet'));
    expect(meet).toMatchObject({ state: 'closed', reason: 'unassigned', site: { brand: null, profile: { name: 'Jimi Cohen' } } });

    // Before first-run setup there is no admin record at all.
    const fresh = makeTestCtx({ now: NOW });
    await repo.getSite(fresh);
    const before = await ok<ShortLinkResponse>(get(fresh, '/public/short/pod'));
    expect(before).toMatchObject({ state: 'closed', reason: 'not_open', site: { brand: { id: ECO } } });
    const unknown = await get(s.ctx, '/public/short/pods');
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.message).toBe('That short link is not set up.');
  });

  it('an unlisted event opens; the link before the setup opens nothing', async () => {
    const s = await signIn();
    expect(await ok<ShortLinkResponse>(get(s.ctx, '/public/short/pod'))).toMatchObject({ state: 'closed', reason: 'unassigned' });
    await runShortLinkMove(s.ctx);
    expect((await podEvent(s.ctx)).visibility).toBe('unlisted');
    expect((await ok<ShortLinkResponse>(get(s.ctx, '/public/short/pod'))).state).toBe('open');
  });
});

describe('event pages, manage pages and files in the brand', () => {
  it('the event page is branded without the event colour; the landing is not', async () => {
    const s = await signIn();
    await runShortLinkMove(s.ctx);
    await repo.updateEventTypes(s.ctx, (list) => ({ next: list.map((e) => (e.id === 'evt_eco_champions' ? { ...e, color: '#c2417a' } : e)), result: null }));
    const page = await ok<PublicEventResponse>(get(s.ctx, '/public/event/eco-champions'));
    expect(page.site.brand?.id).toBe(ECO);
    expect(page.eventType.color).toBe('');
    expect(page.eventType.shortUrl).toBe('https://jimicohen.com/pod');
    const landing = await ok<PublicSite>(get(s.ctx, '/public/site'));
    expect(landing.brand).toBeNull();
    expect(landing.profile.name).toBe('Jimi Cohen');
    expect(landing.theme.preset).toBe('forest');
    // The pod event is unlisted, so the landing does not list it; "Meeting with Jimi" carries its short link.
    expect(landing.eventTypes.map((e) => e.slug)).toEqual(['intro', 'meeting']);
    expect(landing.eventTypes.find((e) => e.slug === 'meeting')?.shortUrl).toBe('https://jimicohen.com/meet');
    expect(landing.eventTypes.find((e) => e.slug === 'intro')?.shortUrl).toBeUndefined();
  });

  it('a booking keeps the look it was booked in, whatever its event carries later', async () => {
    const s = await signIn();
    await runShortLinkMove(s.ctx);
    const branded = await bookPod(s.ctx);
    expect((await repo.getBooking(s.ctx, branded.booking.id))!.brandId).toBe(ECO);
    // The event loses the brand: the booking's pages stay Eco Champions.
    await ok(call(s, 'PUT', '/admin/event-types/evt_eco_champions', { brandId: null }));
    const view = await ok<GetBookingResponse>(get(s.ctx, `/public/bookings/${branded.booking.id}?t=${branded.manageToken}`));
    expect(view.site.brand?.id).toBe(ECO);
    expect(view.site.profile.name).toBe('Eco Champions');

    // A booking made in Jimi's look on an event that has the brand now stays in Jimi's look.
    const plain = await bookPod(s.ctx, { start: '2026-11-18T15:00:00.000Z', email: 'bo@example.com', name: 'Bo Ek' });
    expect((await repo.getBooking(s.ctx, plain.booking.id))!.brandId).toBeUndefined();
    await ok(call(s, 'PUT', '/admin/event-types/evt_eco_champions', { brandId: ECO }));
    const plainView = await ok<GetBookingResponse>(get(s.ctx, `/public/bookings/${plain.booking.id}?t=${plain.manageToken}`));
    expect(plainView.site.brand).toBeNull();
    expect(plainView.site.profile.name).toBe('Jimi Cohen');
  });

  it('the calendar file of a branded booking says where it was booked, under the brand name', async () => {
    const s = await signIn();
    await runShortLinkMove(s.ctx);
    const made = await bookPod(s.ctx);
    const res = await get(s.ctx, `/public/bookings/${made.booking.id}/ics?t=${manageToken(s.ctx, made.booking.id)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="eco-champions.ics"');
    const text = (await res.text()).replace(/\r\n /g, '');
    expect(text).toContain('Booked through Eco Champions: https://jimicohen.com/pod');
    // The add-to-calendar links carry it too.
    expect(decodeURIComponent(made.booking.calendarLinks.google)).toContain('Booked through Eco Champions: https://jimicohen.com/pod');
    // Folded like every other line of the file: no line longer than 75 octets.
    const raw = await (await get(s.ctx, `/public/bookings/${made.booking.id}/ics?t=${manageToken(s.ctx, made.booking.id)}`)).text();
    for (const line of raw.split('\r\n')) expect(Buffer.byteLength(line, 'utf8'), line).toBeLessThanOrEqual(75);
  });

  it('names the calendar file after the brand whatever the meeting link is, and after the link for the owner own meetings', async () => {
    const s = await signIn();
    await runShortLinkMove(s.ctx);
    // "Intro call" (link "intro") in the Eco Champions look: the file is still eco-champions.ics.
    await ok(call(s, 'PUT', '/admin/event-types/evt_intro', { brandId: ECO }));
    const branded = await bookPod(s.ctx, { slug: 'intro', durationMin: 15 });
    expect(branded.booking.eventSlug).toBe('intro');
    const file = await get(s.ctx, `/public/bookings/${branded.booking.id}/ics?t=${manageToken(s.ctx, branded.booking.id)}`);
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="eco-champions.ics"');
    // A booking on Jimi's own "Meeting with Jimi" (link "meeting") keeps the file name of its link.
    const own = await bookPod(s.ctx, { slug: 'meeting', start: '2026-11-18T15:00:00.000Z', email: 'bo@example.com', name: 'Bo Diaz' });
    const ownFile = await get(s.ctx, `/public/bookings/${own.booking.id}/ics?t=${manageToken(s.ctx, own.booking.id)}`);
    expect(ownFile.headers.get('content-disposition')).toBe('attachment; filename="meeting.ics"');
  });

  it('a moved booking keeps its brand, and its pages stay Eco Champions', async () => {
    const s = await signIn();
    await runShortLinkMove(s.ctx);
    const made = await bookPod(s.ctx);
    const token = manageToken(s.ctx, made.booking.id);
    const moved = await handle(apiRequest('POST', `/public/bookings/${made.booking.id}/reschedule`, { body: { t: token, start: '2026-11-18T15:00:00.000Z', timezone: 'Europe/London' } }), s.ctx);
    expect(moved.status, await moved.clone().text()).toBe(200);
    const stored = (await repo.getBooking(s.ctx, made.booking.id))!;
    expect(stored.start).toBe('2026-11-18T15:00:00.000Z');
    expect(stored.brandId).toBe(ECO);
    const view = await ok<GetBookingResponse>(get(s.ctx, `/public/bookings/${made.booking.id}?t=${token}`));
    expect(view.site.brand?.id).toBe(ECO);
  });

  it('answers the built-in email logo from the app itself, without a cross-origin rule', async () => {
    const s = await signIn();
    const res = await get(s.ctx, `/assets/${ECO_CHAMPIONS.art.emailLogoAssetId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cross-origin-resource-policy')).toBeNull();
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([96, 96]);
  });
});
