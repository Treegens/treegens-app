/**
 * The dashboard routes together with the real booking engine and the real route table.
 * The other dashboard tests replace the booking module with a stand-in: this file is the
 * check that the two halves actually fit.
 */
import { describe, expect, it } from 'vitest';
import { allRoutes, handle } from '../../server/api';
import { sessionSetCookie } from '../../server/lib/auth';
import { verifyManageToken } from '../../server/lib/booking';
import { runDueJobs } from '../../server/lib/jobs';
import { getBooking, getBookingIndex, getSite, indexEntryOf, listJobs, mutateBookingIndex, saveBooking } from '../../server/lib/repo';
import type { AdminBooking, Booking } from '../../shared/types';
import { apiRequest, cookiePair, makeTestCtx, TEST_BASE_URL, TEST_NOW } from '../helpers/ctx';

function booking(id: string, startOffsetHours: number): Booking {
  const start = new Date(Date.parse(TEST_NOW) + startOffsetHours * 3_600_000);
  return {
    id,
    eventTypeId: 'evt_intro',
    eventSlug: 'intro',
    eventTitle: 'Intro call',
    kind: 'solo',
    hostIds: ['host_owner'],
    start: start.toISOString(),
    end: new Date(start.getTime() + 15 * 60_000).toISOString(),
    durationMin: 15,
    status: 'confirmed',
    invitee: { name: 'Sam Rivera', email: 'sam@example.com', timezone: 'America/New_York' },
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
  };
}

describe('dashboard routes with the real booking engine', () => {
  it('every route answers to exactly one handler', () => {
    const routes = allRoutes(makeTestCtx({ env: { mockProviders: true } }));
    const shape = (pattern: string): string => pattern.split('/').map((part) => (part.startsWith(':') ? ':' : part)).join('/');
    const keys = routes.map((r) => `${r.method} ${shape(r.pattern)}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    for (const expected of ['GET /auth/state', 'GET /admin/bootstrap', 'PUT /admin/site', 'GET /admin/bookings.csv', 'PUT /host/:', 'GET /google/callback', 'POST /public/bookings', 'GET /assets/:']) {
      expect(keys, expected).toContain(expected);
    }
  });

  it('cancels a booking as the host, end to end', async () => {
    const ctx = makeTestCtx();
    await getSite(ctx);
    await ctx.kv.setJSON('auth/admin', { passwordHash: 'not-used-here', passwordVersion: 1, setupUsedAt: TEST_NOW });
    const cookie = cookiePair(sessionSetCookie(ctx, 1));
    const saved = await saveBooking(ctx, booking('bkg_wiring0000000001', 48));
    await mutateBookingIndex(ctx, (entries) => [...entries, indexEntryOf(saved)]);

    // The manage link the dashboard shows is one the public pages accept.
    const detail = (await (await handle(apiRequest('GET', '/admin/bookings/bkg_wiring0000000001', { cookie }), ctx)).json()) as { booking: AdminBooking };
    const manage = new URL(detail.booking.manageUrl);
    expect(`${manage.origin}${manage.pathname}`).toBe(`${TEST_BASE_URL}/booking/bkg_wiring0000000001`);
    expect(verifyManageToken(ctx, 'bkg_wiring0000000001', manage.searchParams.get('t'))).toBe(true);

    const res = await handle(apiRequest('POST', '/admin/bookings/bkg_wiring0000000001/cancel', { cookie, body: { reason: 'Something came up' } }), ctx);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const cancelled = (JSON.parse(text) as { booking: AdminBooking }).booking;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellation).toMatchObject({ by: 'host', reason: 'Something came up' });
    expect(cancelled.timeline.some((t) => t.type === 'cancelled')).toBe(true);
    expect(cancelled.hosts.map((h) => h.id)).toEqual(['host_owner']);
    await ctx.settle();

    // Stored, and the time is free again.
    expect((await getBooking(ctx, 'bkg_wiring0000000001'))?.status).toBe('cancelled');
    expect((await getBookingIndex(ctx)).find((e) => e.id === 'bkg_wiring0000000001')?.status).toBe('cancelled');
    // No reminders are left waiting for a meeting that will not happen.
    expect((await listJobs(ctx)).filter((j) => j.kind === 'reminder')).toEqual([]);

    const lists = (await (await handle(apiRequest('GET', '/admin/bookings?scope=cancelled', { cookie }), ctx)).json()) as { total: number; counts: Record<string, number> };
    expect(lists.total).toBe(1);
    expect(lists.counts).toEqual({ upcoming: 0, past: 0, cancelled: 1 });
    // With its only upcoming booking gone, the event type can be deleted.
    expect((await handle(apiRequest('DELETE', '/admin/event-types/evt_intro', { cookie }), ctx)).status).toBe(200);
  });

  it('deletes a booking only after it was cancelled, with nothing of it left behind', async () => {
    const ctx = makeTestCtx({ env: { mockProviders: true } });
    await getSite(ctx);
    await ctx.kv.setJSON('auth/admin', { passwordHash: 'not-used-here', passwordVersion: 1, setupUsedAt: TEST_NOW });
    const cookie = cookiePair(sessionSetCookie(ctx, 1));
    const saved = await saveBooking(ctx, booking('bkg_wiring0000000002', 48));
    await mutateBookingIndex(ctx, (entries) => [...entries, indexEntryOf(saved)]);
    const del = () => handle(apiRequest('DELETE', '/admin/bookings/bkg_wiring0000000002', { cookie }), ctx);

    const refused = await del();
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe('upcoming');

    expect((await handle(apiRequest('POST', '/admin/bookings/bkg_wiring0000000002/cancel', { cookie, body: {} }), ctx)).status).toBe(200);
    await ctx.settle();
    const pending = async () => (await listJobs(ctx)).filter((j) => j.bookingId === 'bkg_wiring0000000002');
    // With no email set up here, the email telling the invitee failed once and waits for its retry.
    // Deleting now would take that retry with it, so it is refused.
    expect((await pending()).map((j) => j.kind)).toEqual(['cancelled']);
    const early = await del();
    expect(early.status).toBe(409);
    expect((await early.json()).error.code).toBe('still_cancelling');

    // Once the retries are over (sent or given up), the booking can go.
    for (let round = 0; round < 6 && (await pending()).length > 0; round++) {
      ctx.clock.advance(60 * 60_000);
      await runDueJobs(ctx);
    }
    expect(await pending()).toEqual([]);
    const res = await del();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await getBooking(ctx, 'bkg_wiring0000000002')).toBeNull();
    expect((await getBookingIndex(ctx)).some((e) => e.id === 'bkg_wiring0000000002')).toBe(false);
    expect((await listJobs(ctx)).filter((j) => j.bookingId === 'bkg_wiring0000000002')).toEqual([]);
  });
});
