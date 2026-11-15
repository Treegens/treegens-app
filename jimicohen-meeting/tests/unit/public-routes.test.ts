import { afterEach, describe, expect, it, vi } from 'vitest';
import { newEventType } from '../../shared/defaults';
import type { CreateBookingRequest, CreateBookingResponse, EventType, GetBookingResponse, PublicEventResponse, PublicSite, SlotsResponse } from '../../shared/types';
import { handle } from '../../server/api';
import { sessionSetCookie } from '../../server/lib/auth';
import { manageToken } from '../../server/lib/booking';
import { seal, sha256Hex } from '../../server/lib/crypto';
import type { Env } from '../../server/lib/ctx';
import { getBooking, getBookingIndex, getEventType, getSite, listJobs, putAsset, saveEventType, updateBooking, updateHost } from '../../server/lib/repo';
import * as client from '../../src/lib/api';
import { apiRequest, cookiePair, makeTestCtx, markSetUp, type TestCtx } from '../helpers/ctx';

// ───────────────────────── fixtures ─────────────────────────

const OWNER = 'host_owner';
/** Monday 09:00 UTC. The owner works Monday to Friday, 09:00 to 17:00 UTC. */
const NOW = '2026-11-16T09:00:00.000Z';
const WED_14 = '2026-11-18T14:00:00.000Z';
const BOOKING_NOT_FOUND = { error: { code: 'not_found', message: 'We could not find that booking. Check the link in your confirmation email.' } };

async function setup(opts: { env?: Partial<Env>; ip?: string | null; setUp?: boolean } = {}): Promise<TestCtx> {
  const ctx = makeTestCtx({ now: NOW, env: opts.env, ip: opts.ip });
  await getSite(ctx);
  await updateHost(ctx, OWNER, (h) => ({ ...h, email: 'jimi@example.com' }));
  // The owner has been through first-run setup, unless the test is about the time before it.
  if (opts.setUp !== false) await markSetUp(ctx);
  return ctx;
}

async function addEvent(ctx: TestCtx, partial: Partial<EventType> & Pick<EventType, 'id' | 'slug' | 'title'>): Promise<EventType> {
  return saveEventType(ctx, newEventType(ctx.now().toISOString(), partial));
}

function bookingBody(over: Partial<CreateBookingRequest> = {}): CreateBookingRequest {
  return { slug: 'intro', start: WED_14, durationMin: 15, name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'Europe/London', elapsedMs: 5200, ...over };
}

async function book(ctx: TestCtx, over: Partial<CreateBookingRequest> = {}): Promise<CreateBookingResponse> {
  const res = await handle(apiRequest('POST', '/public/bookings', { body: bookingBody(over) }), ctx);
  expect(res.status).toBe(201);
  return (await res.json()) as CreateBookingResponse;
}

const get = (ctx: TestCtx, path: string): Promise<Response> => handle(apiRequest('GET', path), ctx);
const post = (ctx: TestCtx, path: string, body: unknown, opts: Parameters<typeof apiRequest>[2] = {}): Promise<Response> =>
  handle(apiRequest('POST', path, { body, ...opts }), ctx);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// ───────────────────────── site and event types ─────────────────────────

describe('GET /public/site and /public/event/:slug', () => {
  it('serves the public site as uncacheable JSON', async () => {
    const ctx = await setup();
    await addEvent(ctx, { id: 'evt_secret', slug: 'vip', title: 'VIP hour', visibility: 'unlisted', position: 5 });
    const res = await get(ctx, '/public/site');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-request-id')).toBe('req_test');

    const site = (await res.json()) as PublicSite;
    expect(site.eventTypes.map((e) => e.slug)).toEqual(['intro', 'meeting']);
    expect(site.profile.name).toBe('Jimi Cohen');
    expect(site.features).toEqual({ sms: false, calls: false, email: false });
    expect(site.ownerTimezone).toBe('UTC');
    expect(JSON.stringify(site)).not.toContain('jimi@example.com');
  });

  it('is closed until the owner has been through first-run setup', async () => {
    const code = 'first-run-code-123';
    const ctx = await setup({ setUp: false, env: { setupCodeHash: sha256Hex(code) } });
    const slotsPath = '/public/slots?slug=intro&duration=15&from=2026-11-18T00:00:00Z&to=2026-11-19T00:00:00Z';
    const notOpen = { error: { code: 'not_open', message: 'This booking page is not taking bookings yet. Please check back soon.' } };

    const site = (await (await get(ctx, '/public/site')).json()) as PublicSite;
    expect(site.eventTypes).toEqual([]);
    expect((await get(ctx, '/public/event/intro')).status).toBe(404);
    const slots = await get(ctx, slotsPath);
    expect(slots.status).toBe(503);
    expect(await slots.json()).toEqual(notOpen);
    const booked = await post(ctx, '/public/bookings', bookingBody());
    expect(booked.status).toBe(503);
    expect(await booked.json()).toEqual(notOpen);
    expect(await getBookingIndex(ctx)).toEqual([]);

    // The owner sets up: the page opens at once.
    expect((await post(ctx, '/auth/setup', { code, password: 'a long enough password 1', deviceTimezone: 'Europe/London' })).status).toBe(200);
    expect(((await (await get(ctx, '/public/site')).json()) as PublicSite).eventTypes.map((e) => e.slug)).toEqual(['intro', 'meeting']);
    expect((await get(ctx, '/public/event/intro')).status).toBe(200);
    expect((await get(ctx, slotsPath)).status).toBe(200);
    expect((await post(ctx, '/public/bookings', bookingBody())).status).toBe(201);
    await ctx.settle();
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    const ctx = await setup();
    const head = await handle(apiRequest('HEAD', '/public/site'), ctx);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const del = await handle(apiRequest('DELETE', '/public/site'), ctx);
    expect(del.status).toBe(405);
    expect(del.headers.get('allow')).toBe('GET, HEAD');
  });

  it('resolves an event type by its link, unlisted ones included', async () => {
    const ctx = await setup();
    await addEvent(ctx, { id: 'evt_secret', slug: 'vip', title: 'VIP hour', visibility: 'unlisted' });
    await addEvent(ctx, { id: 'evt_paused', slug: 'paused', title: 'Paused', active: false });

    const res = await get(ctx, '/public/event/vip');
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublicEventResponse;
    expect(body.eventType).toMatchObject({ id: 'evt_secret', slug: 'vip', title: 'VIP hour', kind: 'solo', durations: [30], defaultDuration: 30 });
    expect(body.eventType.hosts).toEqual([{ id: OWNER, name: 'Jimi Cohen', avatarUrl: null }]);
    expect(body.site.eventTypes.map((e) => e.slug)).toEqual(['intro', 'meeting']);

    for (const slug of ['paused', 'nope', 'a%20b']) {
      const missing = await get(ctx, `/public/event/${slug}`);
      expect(missing.status).toBe(404);
      expect((await missing.json()).error.code).toBe('not_found');
    }
  });
});

// ───────────────────────── available times ─────────────────────────

describe('GET /public/slots', () => {
  it('takes the range as ISO instants, the way the client sends it', async () => {
    const ctx = await setup();
    const res = await get(ctx, `/public/slots?slug=intro&duration=15&from=${encodeURIComponent('2026-11-18T00:00:00.000Z')}&to=${encodeURIComponent('2026-11-19T00:00:00.000Z')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as SlotsResponse;
    expect(body.durationMin).toBe(15);
    expect(body.hostTimezone).toBe('UTC');
    expect(body.slots).toHaveLength(32);
    expect(body.slots[0]).toEqual({ start: '2026-11-18T09:00:00.000Z' });
    expect(body.slots.at(-1)).toEqual({ start: '2026-11-18T16:45:00.000Z' });
  });

  it('takes epoch milliseconds and offsets as well', async () => {
    const ctx = await setup();
    const from = Date.parse('2026-11-18T00:00:00Z');
    const viaMs = (await (await get(ctx, `/public/slots?slug=intro&duration=15&from=${from}&to=${from + 86_400_000}`)).json()) as SlotsResponse;
    expect(viaMs.slots).toHaveLength(32);
    // A plus sign that was not percent-encoded arrives as a space.
    const viaOffset = await get(ctx, '/public/slots?slug=intro&duration=15&from=2026-11-18T03:00:00+03:00&to=2026-11-19T03:00:00+03:00');
    expect(viaOffset.status).toBe(200);
    expect(((await viaOffset.json()) as SlotsResponse).slots).toHaveLength(32);
  });

  it('names what is missing or unreadable', async () => {
    const ctx = await setup();
    const res = await get(ctx, '/public/slots?duration=abc&from=yesterday');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('invalid');
    expect(Object.keys(body.error.fields).sort()).toEqual(['duration', 'from', 'slug', 'to']);

    expect((await get(ctx, '/public/slots?slug=nope&duration=15&from=1&to=2')).status).toBe(422);
    const unknown = await get(ctx, `/public/slots?slug=nope&duration=15&from=${Date.parse(NOW)}&to=${Date.parse(NOW) + 1000}`);
    expect(unknown.status).toBe(404);
    const length = await get(ctx, `/public/slots?slug=intro&duration=20&from=${Date.parse(NOW)}&to=${Date.parse(NOW) + 1000}`);
    expect(length.status).toBe(422);
    expect((await length.json()).error.fields.duration).toBeTruthy();
  });

  it('reports a paused event type instead of failing', async () => {
    const ctx = await setup();
    await addEvent(ctx, { id: 'evt_paused', slug: 'paused', title: 'Paused', active: false });
    const res = await get(ctx, `/public/slots?slug=paused&duration=30&from=${Date.parse(NOW)}&to=${Date.parse(NOW) + 86_400_000}`);
    expect(await res.json()).toEqual({ slots: [], durationMin: 30, hostTimezone: 'UTC', unavailableReason: 'inactive' });
  });

  it('frees a booking\'s own time for the holder of its manage link, and for nobody else', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    const range = `from=${encodeURIComponent('2026-11-18T00:00:00.000Z')}&to=${encodeURIComponent('2026-11-19T00:00:00.000Z')}`;
    const starts = async (res: Response): Promise<string[]> => ((await res.json()) as SlotsResponse).slots.map((s) => s.start);

    expect(await starts(await get(ctx, `/public/slots?slug=intro&duration=15&${range}`))).not.toContain(WED_14);
    expect(await starts(await get(ctx, `/public/slots?slug=intro&duration=15&${range}&reschedule=${booking.id}&t=${token}`))).toContain(WED_14);

    const refused = [
      `reschedule=${booking.id}`,
      `reschedule=${booking.id}&t=`,
      // One character off. Not simply "ends in 0": one token in sixteen ends in 0 already.
      `reschedule=${booking.id}&t=${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`,
      `reschedule=bkg_doesnotexist0000&t=${manageToken(ctx, 'bkg_doesnotexist0000')}`,
      `reschedule=${encodeURIComponent('../site')}&t=${token}`,
    ];
    for (const extra of refused) {
      const res = await get(ctx, `/public/slots?slug=intro&duration=15&${range}&${extra}`);
      expect(res.status, extra).toBe(404);
      expect(await res.json()).toEqual(BOOKING_NOT_FOUND);
    }
  });

  it('allows 60 requests a minute per visitor', async () => {
    const ctx = await setup();
    const path = `/public/slots?slug=intro&duration=15&from=${Date.parse(NOW)}&to=${Date.parse(NOW) + 3_600_000}`;
    for (let i = 0; i < 60; i++) expect((await get(ctx, path)).status).toBe(200);
    const limited = await get(ctx, path);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await limited.json()).error.code).toBe('rate_limited');
    // Another visitor is unaffected, and so is the first one a minute later.
    expect((await get(makeTestCtx({ kv: ctx.kv, now: NOW, ip: '198.51.100.9' }), path)).status).toBe(200);
    ctx.clock.advance(60_000);
    expect((await get(ctx, path)).status).toBe(200);
  });
});

// ───────────────────────── booking ─────────────────────────

describe('POST /public/bookings', () => {
  it('creates the booking and answers 201 with the public view and the manage token', async () => {
    const ctx = await setup();
    const res = await handle(apiRequest('POST', '/public/bookings', { body: bookingBody({ utm: { utm_source: 'news' } }) }), ctx);
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as CreateBookingResponse;

    expect(body.manageToken).toBe(manageToken(ctx, body.booking.id));
    expect(body.booking).toMatchObject({
      status: 'confirmed',
      eventTitle: 'Intro call',
      eventSlug: 'intro',
      start: WED_14,
      end: '2026-11-18T14:15:00.000Z',
      durationMin: 15,
      hosts: [{ id: OWNER, name: 'Jimi Cohen', avatarUrl: null }],
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'Europe/London' },
      guests: [],
      canReschedule: true,
      canCancel: true,
      attendanceConfirmed: false,
      // Nothing is set up to send email, and no calendar is connected: the page must promise neither.
      delivery: { email: false, calendarInvite: false },
    });
    expect(Object.keys(body.booking).sort()).toEqual(
      ['attendanceConfirmed', 'calendarLinks', 'canCancel', 'canReschedule', 'cancellation', 'delivery', 'durationMin', 'end', 'eventSlug', 'eventTitle', 'guests', 'hosts', 'id', 'invitee', 'location', 'rescheduledFromStart', 'start', 'status'].sort(),
    );
    expect((await getBooking(ctx, body.booking.id))?.utm).toEqual({ utm_source: 'news' });
    expect(await getBookingIndex(ctx)).toHaveLength(1);
    await ctx.settle();
  });

  it('works with no provider connected and keeps working when the same time is asked for again', async () => {
    const ctx = await setup(); // any network call would throw
    await book(ctx);
    const again = await post(ctx, '/public/bookings', bookingBody({ email: 'grace@example.com' }));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: { code: 'slot_taken', message: 'That time was just taken. Please pick another one.' } });
    expect(await getBookingIndex(ctx)).toHaveLength(1);
  });

  it('reports field problems under the names the form uses', async () => {
    const ctx = await setup();
    const res = await post(ctx, '/public/bookings', bookingBody({ name: '', email: 'nope', phone: '123' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('invalid');
    expect(Object.keys(body.error.fields).sort()).toEqual(['email', 'name', 'phone']);

    const trapped = await post(ctx, '/public/bookings', bookingBody({ website: 'x' }));
    expect(trapped.status).toBe(422);
    expect(await trapped.json()).toEqual({ error: { code: 'invalid', message: 'Could not complete the booking. Please try again.' } });
  });

  it('keeps the CSRF check: header, origin, and nothing else gets through', async () => {
    const ctx = await setup({ env: { embedBaseUrl: 'https://jimicohen-meeting.netlify.app/meeting' } });
    const body = bookingBody();
    const refused = [
      apiRequest('POST', '/public/bookings', { body, headers: { 'x-requested-with': 'XMLHttpRequest' } }),
      apiRequest('POST', '/public/bookings', { body, origin: 'https://evil.example' }),
      apiRequest('POST', '/public/bookings', { body, origin: null }),
      new Request('https://jimicohen.com/meeting/api/public/bookings', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://jimicohen.com' }, body: JSON.stringify(body) }),
    ];
    for (const req of refused) {
      const res = await handle(req, ctx);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('csrf');
    }
    expect(await getBookingIndex(ctx)).toEqual([]);

    // The page inside an embed is served from the app's own origin.
    const embedded = await handle(apiRequest('POST', '/public/bookings', { body: bookingBody({ source: 'embed' }), origin: 'https://jimicohen-meeting.netlify.app' }), ctx);
    expect(embedded.status).toBe(201);
  });

  it('refuses bodies that are not JSON or far too large', async () => {
    const ctx = await setup();
    const form = await handle(
      apiRequest('POST', '/public/bookings', { body: 'slug=intro', headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
      ctx,
    );
    expect(form.status).toBe(415);
    const huge = await post(ctx, '/public/bookings', bookingBody({ answers: { q_topic: 'x'.repeat(70_000) } }));
    expect(huge.status).toBe(413);
    const broken = await handle(apiRequest('POST', '/public/bookings', { body: '{"slug":' }), ctx);
    expect(broken.status).toBe(400);
    expect(await getBookingIndex(ctx)).toEqual([]);
  });

  it('answers 503 calendar_unavailable when a required calendar cannot be read', async () => {
    const ctx = await setup({ env: { overrides: { googleClientId: 'id', googleClientSecret: 'secret' } } });
    await updateHost(ctx, OWNER, (h) => ({
      ...h,
      google: { email: 'jimi@gmail.test', refreshTokenEnc: seal(ctx, 'google-refresh', 'rt'), scopes: [], busyCalendarIds: ['primary'], writeCalendarId: 'primary', gmailSend: false, status: 'needs_reconnect', connectedAt: NOW },
    }));
    const res = await post(ctx, '/public/bookings', bookingBody());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('calendar_unavailable');
    expect(await getBookingIndex(ctx)).toEqual([]);
    expect((await listJobs(ctx)).map((j) => j.kind)).toEqual(['host_alert']);
  });

  it('answers 429 with Retry-After once a visitor has tried ten times in an hour', async () => {
    const ctx = await setup();
    for (let i = 0; i < 10; i++) expect((await post(ctx, '/public/bookings', bookingBody({ website: 'bot' }))).status).toBe(422);
    const res = await post(ctx, '/public/bookings', bookingBody());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect((await res.json()).error.code).toBe('rate_limited');
  });

  it('answers 404 for a meeting type that does not exist', async () => {
    const ctx = await setup();
    const res = await post(ctx, '/public/bookings', bookingBody({ slug: 'nope' }));
    expect(res.status).toBe(404);
  });
});

// ───────────────────────── the manage link ─────────────────────────

describe('manage link routes', () => {
  it('shows the booking, the site and the event type to the holder of the token', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    const res = await get(ctx, `/public/bookings/${booking.id}?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as GetBookingResponse;
    expect(Object.keys(body).sort()).toEqual(['booking', 'eventType', 'site']);
    expect(body.booking).toMatchObject({ id: booking.id, status: 'confirmed', canCancel: true, canReschedule: true });
    expect(body.eventType?.slug).toBe('intro');
    expect(body.site.profile.name).toBe('Jimi Cohen');
    expect(JSON.stringify(body.booking)).not.toMatch(/timeline|consent|utm|answers/);
    expect(JSON.stringify(body)).not.toContain('jimi@example.com');
  });

  it('answers the same plain 404 for a wrong token, a missing token and a booking that does not exist', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    const other = await book(ctx, { start: '2026-11-18T15:00:00.000Z', email: 'grace@example.com' });
    const ghost = 'bkg_doesnotexist0000';

    const reads = [
      `/public/bookings/${booking.id}`,
      `/public/bookings/${booking.id}?t=`,
      `/public/bookings/${booking.id}?t=wrong`,
      `/public/bookings/${booking.id}?t=${other.manageToken}`,
      `/public/bookings/${booking.id}?t=${token.toUpperCase()}`,
      `/public/bookings/${ghost}?t=${token}`,
      `/public/bookings/${ghost}?t=${manageToken(ctx, ghost)}`,
      `/public/bookings/${booking.id}/ics?t=wrong`,
      `/public/bookings/${ghost}/ics?t=${manageToken(ctx, ghost)}`,
    ];
    for (const path of reads) {
      const res = await get(ctx, path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual(BOOKING_NOT_FOUND);
    }

    const writes: [string, Record<string, unknown>][] = [
      [`/public/bookings/${booking.id}/cancel`, { t: 'wrong' }],
      [`/public/bookings/${booking.id}/cancel`, {}],
      [`/public/bookings/${booking.id}/cancel`, { t: other.manageToken }],
      [`/public/bookings/${booking.id}/reschedule`, { t: 'wrong', start: '2026-11-19T10:00:00.000Z' }],
      [`/public/bookings/${booking.id}/confirm`, { t: 12345 }],
      [`/public/bookings/${ghost}/cancel`, { t: manageToken(ctx, ghost) }],
      [`/public/bookings/${ghost}/reschedule`, { t: manageToken(ctx, ghost), start: '2026-11-19T10:00:00.000Z' }],
      [`/public/bookings/${ghost}/confirm`, { t: manageToken(ctx, ghost) }],
    ];
    for (const [path, body] of writes) {
      const res = await post(ctx, path, body);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual(BOOKING_NOT_FOUND);
    }
    expect(await getBooking(ctx, booking.id)).toMatchObject({ status: 'confirmed', start: WED_14, attendance: {} });
  });

  it('cancels with a reason, and cancelling again changes nothing', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    const res = await post(ctx, `/public/bookings/${booking.id}/cancel`, { t: token, reason: 'Something came up' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['booking']);
    expect(body.booking).toMatchObject({ status: 'cancelled', canCancel: false, canReschedule: false, cancellation: { at: NOW, by: 'invitee', reason: 'Something came up' } });
    expect((await getBookingIndex(ctx))[0].status).toBe('cancelled');

    ctx.clock.advance(60_000);
    const again = await post(ctx, `/public/bookings/${booking.id}/cancel`, { t: token, reason: 'Changed my mind about the reason' });
    expect(again.status).toBe(200);
    expect((await again.json()).booking.cancellation).toEqual({ at: NOW, by: 'invitee', reason: 'Something came up' });
    await ctx.settle();
  });

  it('checks the reason and stops cancelling once the meeting has started', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    const long = await post(ctx, `/public/bookings/${booking.id}/cancel`, { t: token, reason: 'x'.repeat(1001) });
    expect(long.status).toBe(422);
    expect((await long.json()).error.fields.reason).toBeTruthy();
    const odd = await post(ctx, `/public/bookings/${booking.id}/cancel`, { t: token, reason: { a: 1 } });
    expect(odd.status).toBe(422);

    ctx.clock.set(WED_14);
    const late = await post(ctx, `/public/bookings/${booking.id}/cancel`, { t: token });
    expect(late.status).toBe(410);
    expect(await late.json()).toEqual({ error: { code: 'too_late', message: 'This meeting has already started, so it can no longer be cancelled here.' } });
    expect((await getBooking(ctx, booking.id))?.status).toBe('confirmed');
  });

  it('moves the booking, and answers 409 slot_taken when the new time is gone', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    await book(ctx, { start: '2026-11-19T10:00:00.000Z', email: 'grace@example.com' });

    const taken = await post(ctx, `/public/bookings/${booking.id}/reschedule`, { t: token, start: '2026-11-19T10:00:00.000Z' });
    expect(taken.status).toBe(409);
    expect((await taken.json()).error.code).toBe('slot_taken');

    const res = await post(ctx, `/public/bookings/${booking.id}/reschedule`, { t: token, start: '2026-11-19T11:00:00.000Z', timezone: 'Africa/Nairobi' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['booking']);
    expect(body.booking).toMatchObject({ id: booking.id, start: '2026-11-19T11:00:00.000Z', end: '2026-11-19T11:15:00.000Z', rescheduledFromStart: WED_14, invitee: { timezone: 'Africa/Nairobi' } });

    const missing = await post(ctx, `/public/bookings/${booking.id}/reschedule`, { t: token });
    expect(missing.status).toBe(422);
    expect((await missing.json()).error.fields.start).toBeTruthy();

    await post(ctx, `/public/bookings/${booking.id}/cancel`, { t: token });
    const gone = await post(ctx, `/public/bookings/${booking.id}/reschedule`, { t: token, start: '2026-11-19T12:00:00.000Z' });
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual({ error: { code: 'cancelled', message: 'This booking was cancelled, so it cannot be moved. Please book a new time.' } });
    await ctx.settle();
  });

  it('records "I\'ll be there"', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    const res = await post(ctx, `/public/bookings/${booking.id}/confirm`, { t: token });
    expect(res.status).toBe(200);
    expect((await res.json()).booking.attendanceConfirmed).toBe(true);
    expect((await getBooking(ctx, booking.id))?.attendance).toEqual({ confirmedAt: NOW, confirmedVia: 'link' });
  });

  it('does not take "I\'ll be there" from a host\'s link: only the invitee can say it', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    const res = await post(ctx, `/public/bookings/${booking.id}/confirm`, { t: token, as: 'host' });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('host_link');
    expect((await getBooking(ctx, booking.id))?.attendance).toEqual({});
  });

  it('tells the page why a meeting of a paused event type cannot be moved, and when the owner is looking', async () => {
    const ctx = await setup();
    const ownerCookie = (c: TestCtx) => cookiePair(sessionSetCookie(c, 1));
    const { booking, manageToken: token } = await book(ctx);
    const view = async (query: string, cookie?: string) =>
      ((await (await handle(apiRequest('GET', `/public/bookings/${booking.id}?t=${token}${query}`, cookie ? { cookie } : {}), ctx)).json()) as GetBookingResponse).booking;
    expect(await view('')).not.toHaveProperty('rescheduleBlocked');
    expect(await view('')).not.toHaveProperty('ownerView');
    await saveEventType(ctx, { ...(await getEventType(ctx, 'evt_intro'))!, active: false });
    expect(await view('')).toMatchObject({ canReschedule: false, canCancel: true, rescheduleBlocked: 'paused' });
    expect(await view('&as=host')).not.toHaveProperty('ownerView');
    expect(await view('&as=host', ownerCookie(ctx))).toMatchObject({ canReschedule: false, rescheduleBlocked: 'paused', ownerView: true });
  });

  it('requires the CSRF header and a matching origin on every state-changing manage route', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    for (const action of ['cancel', 'reschedule', 'confirm']) {
      const path = `/public/bookings/${booking.id}/${action}`;
      const body = { t: token, start: '2026-11-19T11:00:00.000Z' };
      const noHeader = await handle(apiRequest('POST', path, { body, headers: { 'x-requested-with': '' } }), ctx);
      expect(noHeader.status, action).toBe(403);
      const crossSite = await handle(apiRequest('POST', path, { body, origin: 'https://evil.example' }), ctx);
      expect(crossSite.status, action).toBe(403);
    }
    expect(await getBooking(ctx, booking.id)).toMatchObject({ status: 'confirmed', start: WED_14, attendance: {} });
  });

  it('keeps a host\'s zone off the invitee when the page was opened from a host link, and records the move as a host\'s', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx, { timezone: 'America/New_York' });

    const byHost = await post(ctx, `/public/bookings/${booking.id}/reschedule`, { t: token, start: '2026-11-19T11:00:00.000Z', timezone: 'Africa/Nairobi', as: 'host' });
    expect(byHost.status).toBe(200);
    expect((await byHost.json()).booking.invitee.timezone).toBe('America/New_York');
    const stored = (await getBooking(ctx, booking.id))!;
    expect(stored.invitee.timezone).toBe('America/New_York');
    expect(stored.timeline.filter((t) => t.type === 'rescheduled').at(-1)?.detail).toMatch(/by a host, from the booking page$/);

    // Anything else in that field is the invitee's own page.
    const own = await post(ctx, `/public/bookings/${booking.id}/reschedule`, { t: token, start: '2026-11-19T12:00:00.000Z', timezone: 'Europe/Paris', as: 'admin' });
    expect(own.status).toBe(200);
    expect((await own.json()).booking.invitee.timezone).toBe('Europe/Paris');
    expect((await getBooking(ctx, booking.id))!.timeline.filter((t) => t.type === 'rescheduled').at(-1)?.detail).toMatch(/by the invitee$/);
    await ctx.settle();
  });

  it('records a cancellation from a host link as made by a host, with the invitee\'s deadline', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    const res = await post(ctx, `/public/bookings/${booking.id}/cancel`, { t: token, as: 'host' });
    expect(res.status).toBe(200);
    expect((await res.json()).booking.cancellation).toMatchObject({ by: 'host' });
    expect((await getBooking(ctx, booking.id))!.cancellation).toMatchObject({ by: 'host', via: 'host_link' });

    const later = await book(ctx, { start: '2026-11-18T15:00:00.000Z' });
    ctx.clock.set('2026-11-18T15:01:00.000Z');
    const tooLate = await post(ctx, `/public/bookings/${later.booking.id}/cancel`, { t: later.manageToken, as: 'host' });
    expect(tooLate.status).toBe(410);
    // The page names nobody: any host may hold that link.
    const view = (await (await get(ctx, `/public/bookings/${booking.id}?t=${token}`)).json()) as GetBookingResponse;
    expect(view.booking.cancellation).toEqual({ at: NOW, by: 'host' });
    await ctx.settle();
  });

  describe('a host link opened by the signed-in owner', () => {
    const APP_ADDRESS = 'https://jimicohen-meeting.netlify.app/meeting';
    const ownerCookie = (ctx: TestCtx) => cookiePair(sessionSetCookie(ctx, 1));

    /** A booking its invitee has already moved five times, the most the booking page allows. */
    async function movedFiveTimes(ctx: TestCtx): Promise<CreateBookingResponse> {
      const made = await book(ctx, { timezone: 'America/New_York' });
      await updateBooking(ctx, made.booking.id, (b) => ({ ...b, rescheduleCount: 5 }));
      return made;
    }

    it('moves the meeting without the invitee\'s limits, on the public address and on the app\'s own', async () => {
      const ctx = await setup();
      const { booking, manageToken: token } = await movedFiveTimes(ctx);
      const path = `/public/bookings/${booking.id}/reschedule`;
      const at = (hour: number) => `2026-11-19T${hour}:00:00.000Z`;

      // Without the session, or without the host mark, it is the booking page as everyone else has it.
      const coHost = await post(ctx, path, { t: token, start: at(11), as: 'host' });
      expect(coHost.status).toBe(409);
      expect((await coHost.json()).error).toEqual({
        code: 'move_limit',
        message:
          'This meeting has been moved 5 times already, so it cannot be moved again from this link. The owner can still move it here while signed in to the dashboard in this browser. Or cancel it and ask the invitee to book a new time.',
      });
      const unmarked = await post(ctx, path, { t: token, start: at(11) }, { cookie: ownerCookie(ctx) });
      expect(unmarked.status).toBe(409);
      expect((await unmarked.json()).error.message).toMatch(/get in touch with your host/);
      // A session for an older password counts for nothing.
      const stale = await post(ctx, path, { t: token, start: at(11), as: 'host' }, { cookie: cookiePair(sessionSetCookie(ctx, 7)) });
      expect(stale.status).toBe(409);

      const moved = await post(ctx, path, { t: token, start: at(11), timezone: 'Africa/Nairobi', as: 'host' }, { cookie: ownerCookie(ctx) });
      expect(moved.status).toBe(200);
      expect((await moved.json()).booking).toMatchObject({ start: at(11), invitee: { timezone: 'America/New_York' } });
      // More than three an hour, from the app's own address, where the owner may just as well be signed in.
      for (const hour of [12, 13, 14]) {
        const res = await post(ctx, path, { t: token, start: at(hour), as: 'host' }, { cookie: ownerCookie(ctx), baseUrl: APP_ADDRESS });
        expect(res.status, `move to ${hour}:00`).toBe(200);
      }
      const stored = (await getBooking(ctx, booking.id))!;
      expect(stored).toMatchObject({ start: at(14), rescheduleCount: 9, invitee: { timezone: 'America/New_York' } });
      expect(stored.timeline.filter((t) => t.type === 'rescheduled').at(-1)?.detail).toMatch(/by the owner, from the booking page$/);

      // The same-origin check still applies to the owner.
      const crossSite = await post(ctx, path, { t: token, start: at(15), as: 'host' }, { cookie: ownerCookie(ctx), origin: 'https://evil.example' });
      expect(crossSite.status).toBe(403);
      // And the token: the session does not open another booking's page.
      const wrongToken = await post(ctx, path, { t: 'x'.repeat(64), start: at(15), as: 'host' }, { cookie: ownerCookie(ctx) });
      expect(wrongToken.status).toBe(404);
      await ctx.settle();
    });

    it('may change a meeting that has started, which the invitee and a co-host may not, and the page offers it', async () => {
      const ctx = await setup();
      const { booking, manageToken: token } = await book(ctx);
      ctx.clock.set('2026-11-18T14:05:00.000Z');
      const view = async (query: string, cookie?: string) =>
        ((await (await handle(apiRequest('GET', `/public/bookings/${booking.id}?t=${token}${query}`, cookie ? { cookie } : {}), ctx)).json()) as GetBookingResponse).booking;

      expect(await view('&as=host')).toMatchObject({ canReschedule: false, canCancel: false });
      expect(await view('', ownerCookie(ctx))).toMatchObject({ canReschedule: false, canCancel: false });
      expect(await view('&as=host', ownerCookie(ctx))).toMatchObject({ canReschedule: true, canCancel: true });

      expect((await post(ctx, `/public/bookings/${booking.id}/cancel`, { t: token, as: 'host' })).status).toBe(410);
      const res = await post(ctx, `/public/bookings/${booking.id}/cancel`, { t: token, as: 'host', reason: 'Ran late' }, { cookie: ownerCookie(ctx), baseUrl: APP_ADDRESS });
      expect(res.status).toBe(200);
      // The page can say who it was: the owner, by name.
      expect((await res.json()).booking.cancellation).toEqual({ at: '2026-11-18T14:05:00.000Z', by: 'host', reason: 'Ran late', byName: 'Jimi Cohen' });
      const stored = (await getBooking(ctx, booking.id))!;
      expect(stored.cancellation).toEqual({ at: '2026-11-18T14:05:00.000Z', by: 'host', reason: 'Ran late' });
      expect(stored.timeline.find((t) => t.type === 'cancelled')?.detail).toBe('Cancelled by the owner, from the booking page: Ran late');
      await ctx.settle();
    });

    it('offers nothing to change once the meeting is over, as the dashboard does', async () => {
      const ctx = await setup();
      const { booking, manageToken: token } = await book(ctx);
      // The meeting ran 14:00 to 14:15. Cancelling it now would only send Ada a cancellation for a meeting that took place.
      ctx.clock.set('2026-11-18T14:20:00.000Z');
      const res = await handle(apiRequest('GET', `/public/bookings/${booking.id}?t=${token}&as=host`, { cookie: ownerCookie(ctx) }), ctx);
      expect(((await res.json()) as GetBookingResponse).booking).toMatchObject({ canReschedule: false, canCancel: false });
      await ctx.settle();
    });
  });

  it('answers a booking request sent again with the booking its first try made', async () => {
    const ctx = await setup();
    const requestKey = 'form-key-' + 'Q'.repeat(24);
    const first = await book(ctx, { requestKey });
    const again = await book(ctx, { requestKey });
    expect(again.booking.id).toBe(first.booking.id);
    expect(again.manageToken).toBe(first.manageToken);
    expect(await getBookingIndex(ctx)).toHaveLength(1);
    await ctx.settle();
  });

  it('limits how often one visitor can change bookings', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    for (let i = 0; i < 30; i++) expect((await post(ctx, `/public/bookings/${booking.id}/confirm`, { t: token })).status).toBe(200);
    expect((await post(ctx, `/public/bookings/${booking.id}/confirm`, { t: token })).status).toBe(429);
    expect((await post(ctx, `/public/bookings/${booking.id}/cancel`, { t: token })).status).toBe(429);
  });
});

// ───────────────────────── calendar file ─────────────────────────

describe('GET /public/bookings/:id/ics', () => {
  it('downloads a calendar file for the booking', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    expect(booking.calendarLinks.ics).toBe(`https://jimicohen.com/meeting/api/public/bookings/${booking.id}/ics?t=${token}`);

    const res = await get(ctx, `/public/bookings/${booking.id}/ics?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8; method=PUBLISH');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="intro.ics"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const text = await res.text();
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text).toContain('METHOD:PUBLISH\r\n');
    expect(text).toContain(`UID:${booking.id}@jimicohen.com\r\n`);
    expect(text).toContain('DTSTART:20261118T140000Z\r\n');
    expect(text).toContain('DTEND:20261118T141500Z\r\n');
    expect(text).toContain('STATUS:CONFIRMED\r\n');
    expect(text.replace(/\r\n /g, '')).toContain(`/booking/${booking.id}?t=${token}`);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);

    const head = await handle(apiRequest('HEAD', `/public/bookings/${booking.id}/ics?t=${token}`), ctx);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toContain('text/calendar');
    expect(await head.text()).toBe('');
  });

  it('turns into a cancellation file once the meeting is cancelled, and keeps the file name harmless', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await book(ctx);
    await post(ctx, `/public/bookings/${booking.id}/cancel`, { t: token });
    // An old booking whose stored link carries characters a header must never see.
    await ctx.kv.setJSON(`bookings/${booking.id}`, { ...(await getBooking(ctx, booking.id)), eventSlug: 'Team "Sync"\r\nX-Injected: 1' });

    const res = await get(ctx, `/public/bookings/${booking.id}/ics?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8; method=CANCEL');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="team-sync-x-injected-1.ics"');
    expect(res.headers.get('x-injected')).toBeNull();
    const text = await res.text();
    expect(text).toContain('METHOD:CANCEL\r\n');
    expect(text).toContain('STATUS:CANCELLED\r\n');
    await ctx.settle();
  });
});

// ───────────────────────── uploaded images ─────────────────────────

describe('GET /assets/:id', () => {
  it('serves an image with a long immutable cache and locked-down headers', async () => {
    const ctx = await setup();
    const id = await putAsset(ctx, PNG, 'image/png', 'avatar');
    const res = await get(ctx, `/assets/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe(String(PNG.byteLength));
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);

    const head = await handle(apiRequest('HEAD', `/assets/${id}`), ctx);
    expect(head.status).toBe(200);
    expect(head.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it('is linked from the public site once the owner uses it', async () => {
    const ctx = await setup();
    const id = await putAsset(ctx, PNG, 'image/png', 'avatar');
    const site = await getSite(ctx);
    await ctx.kv.setJSON('site', { ...site, profile: { ...site.profile, avatarAssetId: id }, theme: { ...site.theme, logoAssetId: id } });
    const body = (await (await get(ctx, '/public/site')).json()) as PublicSite;
    expect(body.profile.avatarUrl).toBe(`/meeting/api/assets/${id}`);
    expect(body.themeAssets.logoUrl).toBe(`/meeting/api/assets/${id}`);
    expect((await get(ctx, `/assets/${id}`)).status).toBe(200);
  });

  it('never renders anything that is not one of the image types uploads can have', async () => {
    const ctx = await setup();
    const html = await putAsset(ctx, new TextEncoder().encode('<script>alert(1)</script>'), 'text/html; charset=utf-8', 'avatar');
    const svg = await putAsset(ctx, new TextEncoder().encode('<svg onload="alert(1)"/>'), 'image/svg+xml', 'logo');
    for (const id of [html, svg]) {
      const res = await get(ctx, `/assets/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('content-disposition')).toBe('attachment');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    }
  });

  it('answers 404 for unknown ids and for ids that are not ids', async () => {
    const ctx = await setup();
    for (const id of ['ast_doesnotexist0000', 'site', encodeURIComponent('../site'), 'a.b']) {
      const res = await get(ctx, `/assets/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });
});

// ───────────────────────── the browser client against the real routes ─────────────────────────

describe('src/lib/api.ts against the real routes', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** What the browser does: resolves the relative URL against the page and adds the Origin header to writes. */
  function wire(ctx: TestCtx): void {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      expect(url.startsWith(`${client.API_BASE}/`)).toBe(true);
      const headers = new Headers(init.headers);
      if (init.method && init.method !== 'GET') headers.set('origin', 'https://jimicohen.com');
      const path = url.slice(client.API_BASE.length);
      return handle(new Request(`https://jimicohen.com/meeting/api${path}`, { method: init.method, headers, body: init.body as string | undefined }), ctx);
    });
  }

  it('carries a visitor from the landing page to a booking, a move, a confirmation and a cancellation', async () => {
    const ctx = await setup();
    wire(ctx);

    const site = await client.getPublicSite();
    expect(site.eventTypes.map((e) => e.slug)).toEqual(['intro', 'meeting']);
    const { eventType } = await client.getPublicEvent('intro');
    expect(eventType.durations).toEqual([15]);

    const from = Date.parse('2026-11-18T00:00:00Z');
    const slots = await client.getSlots({ slug: 'intro', durationMin: 15, from, to: from + 86_400_000 });
    expect(slots.slots.map((s) => s.start)).toContain(WED_14);

    const created = await client.createBooking(bookingBody());
    expect(created.booking.start).toBe(WED_14);
    const { id } = created.booking;
    const token = created.manageToken;

    const taken = await client.createBooking(bookingBody({ email: 'grace@example.com' })).catch((e: unknown) => e);
    expect(client.isApiFailure(taken, 'slot_taken')).toBe(true);
    expect(taken).toMatchObject({ status: 409 });
    const invalid = await client.createBooking(bookingBody({ start: '2026-11-18T15:00:00.000Z', email: 'nope' })).catch((e: unknown) => e);
    expect(invalid).toMatchObject({ status: 422, code: 'invalid', fields: { email: expect.any(String) } });

    const view = await client.getBooking(id, token);
    expect(view.booking.id).toBe(id);
    expect(view.eventType?.slug).toBe('intro');
    const wrong = await client.getBooking(id, 'wrong-token-wrong-token').catch((e: unknown) => e);
    expect(wrong).toMatchObject({ status: 404, code: 'not_found' });

    const whileMoving = await client.getSlots({ slug: 'intro', durationMin: 15, from, to: from + 86_400_000, rescheduleBookingId: id, token });
    expect(whileMoving.slots.map((s) => s.start)).toContain(WED_14);
    const moved = await client.rescheduleBooking(id, token, '2026-11-18T15:00:00.000Z', 'Africa/Nairobi');
    expect(moved).toMatchObject({ id, start: '2026-11-18T15:00:00.000Z', rescheduledFromStart: WED_14, invitee: { timezone: 'Africa/Nairobi' } });
    // The page opened from a host's link says so, and the host's zone stays out of it.
    const byHost = await client.rescheduleBooking(id, token, '2026-11-18T16:00:00.000Z', undefined, 'host');
    expect(byHost).toMatchObject({ start: '2026-11-18T16:00:00.000Z', invitee: { timezone: 'Africa/Nairobi' } });
    expect((await getBooking(ctx, id))!.timeline.filter((t) => t.type === 'rescheduled').at(-1)?.detail).toMatch(/by a host, from the booking page$/);

    const confirmed = await client.confirmBooking(id, token);
    expect(confirmed.attendanceConfirmed).toBe(true);

    const cancelled = await client.cancelBooking(id, token, 'Travelling');
    expect(cancelled).toMatchObject({ status: 'cancelled', cancellation: { by: 'invitee', reason: 'Travelling' } });

    expect(client.bookingIcsUrl(id, token)).toBe(`${client.API_BASE}/public/bookings/${id}/ics?t=${token}`);
    const ics = await get(ctx, `/public/bookings/${id}/ics?t=${token}`);
    expect(ics.status).toBe(200);
    expect(await getEventType(ctx, 'evt_intro')).not.toBeNull();
    await ctx.settle();
  });
});
