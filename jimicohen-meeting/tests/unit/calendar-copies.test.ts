/**
 * One copy of the meeting in the invitee's calendar and in each host's, whatever order things happen in:
 * Google connected after the booking, the event type's "Google invites them" switched either way after it,
 * a calendar write that fails and is retried after a move. Through the real modules: booking, the jobs that
 * send the emails, housekeeping, and a fake Google that records every call.
 */
import { describe, expect, it } from 'vitest';
import type { Booking, EventType } from '../../shared/types';
import type { Env } from '../../server/lib/ctx';
import { runDueJobs } from '../../server/lib/jobs';
import { HAND_ADDED_NOTE, cancelBooking, createBooking, getManageView, reconcileBookings, rescheduleBooking } from '../../server/lib/booking';
import { googleUidFor } from '../../server/lib/invite';
import { getBooking, getEventType, getSite, saveEventType, saveSecrets, saveSite, updateBooking, updateHost } from '../../server/lib/repo';
import { makeTestCtx, markSetUp, type TestCtx } from '../helpers/ctx';
import { fakeGoogle, setMain, type FakeGoogle } from '../helpers/google';

const OWNER = 'host_owner';
const NOW = '2026-11-16T09:00:00.000Z';
const A = 'jimi@gmail.example';
const ADA = 'ada@example.com';
const GOOGLE_ENV: Partial<Env> = { overrides: { googleClientId: 'client-id.apps.googleusercontent.com', googleClientSecret: 'client-secret' } };
const wed = (time: string): string => `2026-11-18T${time}:00.000Z`;

interface Mail {
  to: string[];
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: string; content_type: string }[];
}

async function setup(): Promise<TestCtx> {
  const ctx = makeTestCtx({ now: NOW, env: GOOGLE_ENV });
  await getSite(ctx);
  await updateHost(ctx, OWNER, (h) => ({ ...h, email: 'jimi@example.com', googleExtra: [] }));
  await markSetUp(ctx);
  return ctx;
}

/** Email through Resend, recorded. */
async function emailOn(ctx: TestCtx): Promise<void> {
  const site = await getSite(ctx);
  await saveSite(ctx, { ...site, email: { provider: 'auto', fromName: 'Jimi Cohen', fromEmail: 'meet@jimicohen.com', replyTo: '' } });
  await saveSecrets(ctx, { resend: { apiKey: 're_test' } });
}

/** Google (and Resend, when it is set up) answering, with every call and every email recorded. */
function world(ctx: TestCtx): { g: FakeGoogle; mails: Mail[] } {
  const mails: Mail[] = [];
  const g = fakeGoogle(ctx, {
    other: (url, init) => {
      if (url !== 'https://api.resend.com/emails') return null;
      mails.push(JSON.parse(String(init?.body)) as Mail);
      return Response.json({ id: `email_${mails.length}` });
    },
  });
  return { g, mails };
}

const to = (mails: Mail[], who: string, subject: RegExp): Mail[] => mails.filter((m) => m.to.some((t) => t.includes(who)) && subject.test(m.subject));
const icsOf = (m: Mail): string => Buffer.from(m.attachments![0].content, 'base64').toString('utf8');
const calls = (g: FakeGoogle, kind: string) => g.calls.filter((c) => c.kind === kind);
const attendeesOf = (g: FakeGoogle): string[] => calls(g, 'event_insert').flatMap((c) => ((JSON.parse(c.body).attendees ?? []) as { email: string }[]).map((a) => a.email));
const descriptionOf = (g: FakeGoogle): string => String(JSON.parse(calls(g, 'event_insert').at(-1)!.body).description ?? '');

function request(start: string) {
  return { slug: 'intro', start, durationMin: 15, name: 'Ada Lovelace', email: ADA, timezone: 'Europe/London', elapsedMs: 5200 };
}

async function book(ctx: TestCtx, start = wed('12:00')): Promise<Booking> {
  const { booking } = await createBooking(ctx, request(start));
  await ctx.settle();
  return (await getBooking(ctx, booking.id))!;
}

async function setGoogleInvite(ctx: TestCtx, on: boolean): Promise<void> {
  const et = (await getEventType(ctx, 'evt_intro')) as EventType;
  await saveEventType(ctx, { ...et, googleInvite: on });
}

/** Housekeeping, then the jobs it queued. */
async function housekeeping(ctx: TestCtx): Promise<void> {
  await reconcileBookings(ctx);
  await runDueJobs(ctx, { jobTimeoutMs: 3000 });
  await ctx.settle();
}

describe('a booking made before Google was connected', () => {
  it('whose invitee got our own invitation: the hosts get the event once Google is connected, she keeps the one copy our files keep up to date', async () => {
    const ctx = await setup();
    await emailOn(ctx);
    const { g, mails } = world(ctx);
    const booking = await book(ctx);
    expect(booking.google).toBeNull();
    const [confirmed] = to(mails, ADA, /^Confirmed/);
    expect(icsOf(confirmed)).toContain('METHOD:REQUEST');
    expect(icsOf(confirmed)).toContain(`UID:${booking.id}@jimicohen.com`);
    expect(booking.inviteVia).toBe('file');

    // Google is connected afterwards: housekeeping writes the event into the owner's calendar, without her.
    await setMain(ctx, OWNER, { email: A });
    await housekeeping(ctx);
    expect(calls(g, 'event_insert')).toHaveLength(1);
    expect(attendeesOf(g)).not.toContain(ADA);
    const synced = (await getBooking(ctx, booking.id))!;
    expect(synced.google?.eventId).toBeTruthy();
    expect(synced.inviteVia).toBe('file');
    expect(descriptionOf(g)).not.toContain(HAND_ADDED_NOTE);
    // The page promises no Google invitation: her calendar has ours.
    expect((await getManageView(ctx, booking.id))!.booking.delivery?.calendarInvite).toBe(false);

    // She moves it: Google moves the hosts' copy, our email moves hers (same UID, next SEQUENCE).
    await rescheduleBooking(ctx, booking.id, { startIso: wed('14:00'), by: 'invitee' });
    await ctx.settle();
    expect(calls(g, 'event_patch').length).toBeGreaterThanOrEqual(1);
    expect(calls(g, 'event_insert')).toHaveLength(1);
    const [moved] = to(mails, ADA, /^New time/);
    expect(icsOf(moved)).toContain('METHOD:REQUEST');
    expect(icsOf(moved)).toContain(`UID:${booking.id}@jimicohen.com`);
    expect(icsOf(moved)).toContain('SEQUENCE:1');
    expect(icsOf(moved)).toContain('DTSTART:20261118T140000Z');

    // And cancels it: our CANCEL takes her copy out, Google takes the hosts' out.
    await cancelBooking(ctx, booking.id, { by: 'invitee' });
    await ctx.settle();
    const [gone] = to(mails, ADA, /^Cancelled/);
    expect(icsOf(gone)).toContain('METHOD:CANCEL');
    expect(icsOf(gone)).toContain(`UID:${booking.id}@jimicohen.com`);
    expect(calls(g, 'event_delete')).toHaveLength(1);
  });

  it('that reached nobody (no email, no Google): once Google is connected, Google invites her', async () => {
    const ctx = await setup();
    const { g, mails } = world(ctx);
    const booking = await book(ctx);
    expect(mails).toHaveLength(0);
    expect(booking.inviteVia).toBeUndefined();
    expect((await getManageView(ctx, booking.id))!.booking.delivery).toEqual({ email: false, calendarInvite: false });

    await setMain(ctx, OWNER, { email: A });
    await housekeeping(ctx);
    expect(calls(g, 'event_insert')).toHaveLength(1);
    expect(attendeesOf(g)).toEqual([ADA]);
    expect(calls(g, 'event_insert')[0].url).toContain('sendUpdates=all');
    expect((await getBooking(ctx, booking.id))!.inviteVia).toBe('google');
    // Her booking page told her to add the meeting by hand (nothing could be emailed): Google's invitation says
    // that copy can go, so she is not left with two without a word.
    expect(booking.timeline.map((t) => t.type)).toContain('confirmation_email_skipped');
    expect(descriptionOf(g)).toContain(HAND_ADDED_NOTE);
    expect((await getManageView(ctx, booking.id))!.booking.delivery?.calendarInvite).toBe(true);
  });

  it('is queued at once when the main account is connected (the connect route), not only by housekeeping', async () => {
    const ctx = await setup();
    const { g } = world(ctx);
    const booking = await book(ctx);
    await setMain(ctx, OWNER, { email: A });
    const { queueCalendarBackfill } = await import('../../server/lib/booking');
    expect(await queueCalendarBackfill(ctx, OWNER)).toBe(1);
    // Asked again (a second connect, housekeeping): nothing twice within two hours.
    expect(await queueCalendarBackfill(ctx, OWNER)).toBe(0);
    await runDueJobs(ctx, { jobTimeoutMs: 3000 });
    expect(calls(g, 'event_insert')).toHaveLength(1);
    expect((await getBooking(ctx, booking.id))!.google?.eventId).toBeTruthy();
  });

  it('is left alone while no host can take it, and a past one is never written', async () => {
    const ctx = await setup();
    const { g } = world(ctx);
    await book(ctx);
    await housekeeping(ctx);
    expect(calls(g, 'event_insert')).toHaveLength(0);
    // Connected only once the meeting is over: nothing is sent for a meeting that has happened.
    await setMain(ctx, OWNER, { email: A });
    ctx.clock.set('2026-11-19T09:00:00.000Z');
    await housekeeping(ctx);
    expect(calls(g, 'event_insert')).toHaveLength(0);
  });
});

describe("the event type's switch changed after the booking", () => {
  it('switched off: Google keeps moving the invitation it sent, and our email adds no second one', async () => {
    const ctx = await setup();
    await emailOn(ctx);
    await setMain(ctx, OWNER, { email: A });
    const { g, mails } = world(ctx);
    const booking = await book(ctx);
    expect(attendeesOf(g)).toEqual([ADA]);
    expect(booking.inviteVia).toBe('google');
    expect(to(mails, ADA, /^Confirmed/)[0].attachments).toBeUndefined();
    // Booked with Google there from the start: nothing was added by hand, and the invitation says nothing about it.
    expect(descriptionOf(g)).not.toContain(HAND_ADDED_NOTE);

    await setGoogleInvite(ctx, false);
    await rescheduleBooking(ctx, booking.id, { startIso: wed('14:00'), by: 'invitee' });
    await ctx.settle();
    const [moved] = to(mails, ADA, /^New time/);
    expect(moved.attachments).toBeUndefined();
    expect(calls(g, 'event_patch').some((c) => c.url.includes('sendUpdates=all'))).toBe(true);
    expect((await getManageView(ctx, booking.id))!.booking.delivery?.calendarInvite).toBe(true);
  });

  it('switched on: she keeps our invitation, the page promises no Google one, and our CANCEL takes it out', async () => {
    const ctx = await setup();
    await emailOn(ctx);
    await setMain(ctx, OWNER, { email: A });
    await setGoogleInvite(ctx, false);
    const { g, mails } = world(ctx);
    const booking = await book(ctx);
    expect(attendeesOf(g)).toEqual([]);
    expect(booking.inviteVia).toBe('file');
    expect(icsOf(to(mails, ADA, /^Confirmed/)[0])).toContain('METHOD:REQUEST');

    await setGoogleInvite(ctx, true);
    await rescheduleBooking(ctx, booking.id, { startIso: wed('14:00'), by: 'invitee' });
    await ctx.settle();
    expect((await getManageView(ctx, booking.id))!.booking.delivery?.calendarInvite).toBe(false);
    const [moved] = to(mails, ADA, /^New time/);
    expect(icsOf(moved)).toContain('METHOD:REQUEST');
    expect(icsOf(moved)).toContain('SEQUENCE:1');

    await cancelBooking(ctx, booking.id, { by: 'invitee' });
    await ctx.settle();
    expect(icsOf(to(mails, ADA, /^Cancelled/)[0])).toContain('METHOD:CANCEL');
  });
});

describe('a first calendar write that fails', () => {
  it('sends the hosts no file while it is retried, and a move before it works sends one invitation, not an invitation and an update', async () => {
    const ctx = await setup();
    await emailOn(ctx);
    await setMain(ctx, OWNER, { email: A });
    const { g, mails } = world(ctx);
    g.accounts[A] = { fail: 500, failKinds: ['event_insert'] };
    const booking = await book(ctx);
    expect(booking.google?.error).toBeTruthy();
    // The owner's calendar gets the event when the retry works: a file now would be a second copy.
    const [notice] = to(mails, 'jimi@example.com', /^New booking/);
    expect(notice.attachments).toBeUndefined();
    expect(notice.text).not.toContain('not in your Google Calendar');
    // Google invites her once it works: no file beside that either.
    expect(to(mails, ADA, /^Confirmed/)[0].attachments).toBeUndefined();

    await rescheduleBooking(ctx, booking.id, { startIso: wed('14:00'), by: 'invitee' });
    await ctx.settle();
    g.accounts[A].fail = undefined;
    ctx.clock.advance(5 * 60_000);
    await runDueJobs(ctx, { jobTimeoutMs: 3000 });
    await ctx.settle();
    const inserted = calls(g, 'event_insert');
    expect((await getBooking(ctx, booking.id))!.google?.eventId).toBeTruthy();
    // Made at the new time: no "updated" notice right after the invitation.
    expect(calls(g, 'event_patch')).toHaveLength(0);
    expect(JSON.parse(inserted.at(-1)!.body).start.dateTime).toBe(wed('14:00'));
  });
});

describe('who invites her is decided once, also when two decide at the same instant', () => {
  it('lets the first decision stand: the calendar write and the first email can never disagree', async () => {
    const ctx = await setup();
    world(ctx);
    const booking = await book(ctx);
    expect(booking.inviteVia).toBeUndefined();
    const { settleInvite } = await import('../../server/lib/invite');
    // Both read the booking undecided; only one write can land first, and the other must take it as it is.
    const [a, b] = await Promise.all([settleInvite(ctx, booking.id, () => 'google'), settleInvite(ctx, booking.id, () => 'file')]);
    const stored = (await getBooking(ctx, booking.id))!.inviteVia;
    expect(stored).toBeDefined();
    expect(a!.inviteVia).toBe(stored);
    expect(b!.inviteVia).toBe(stored);
  });
});

describe('a booking recorded for Google whose first write never reached Google', () => {
  it('still promises Google\'s invitation while a host can write it, and stops promising it when none can', async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    const { g } = world(ctx);
    g.accounts[A] = { fail: 500, failKinds: ['event_insert'] };
    const booking = await book(ctx);
    expect(booking.inviteVia).toBe('google');
    // The process stopped after deciding and before anything was stored about the write.
    await updateBooking(ctx, booking.id, (b) => ({ ...b, google: null }));
    // Housekeeping writes it with her on it while the owner's calendar works, so the page promises Google's invitation.
    expect((await getManageView(ctx, booking.id))!.booking.delivery?.calendarInvite).toBe(true);
    // No host can write it any more: nothing is on its way from Google, and the page says no such thing.
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: null }));
    expect((await getManageView(ctx, booking.id))!.booking.delivery?.calendarInvite).toBe(false);
  });
});

describe('the calendar file a Google-invited booker can download', () => {
  it("has Google's UID, so a calendar that also gets Google's invitation keeps one meeting", async () => {
    const ctx = await setup();
    await setMain(ctx, OWNER, { email: A });
    world(ctx);
    const booking = await book(ctx);
    expect(booking.inviteVia).toBe('google');
    const { handle } = await import('../../server/api');
    const { apiRequest } = await import('../helpers/ctx');
    const { manageToken } = await import('../../server/lib/booking');
    const res = await handle(apiRequest('GET', `/public/bookings/${booking.id}/ics?t=${manageToken(ctx, booking.id)}`), ctx);
    const text = await res.text();
    expect(text).toContain(`UID:${googleUidFor(booking.id)}\r\n`);
    expect(googleUidFor(booking.id)).toBe(`${booking.google!.eventId}@google.com`);
    expect(text).toContain('METHOD:PUBLISH');
  });
});
