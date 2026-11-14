import { describe, expect, it } from 'vitest';
import { defaultOwnerHost, newEventType } from '../../shared/defaults';
import type { Booking, BookingIndexEntry, CreateBookingRequest, EventType, Host, HostGoogle, Job } from '../../shared/types';
// The job module first, on purpose: booking.ts is then loaded from inside the import cycle
// jobs > sms > booking, which is the order that could leave the gcal_sync handler unregistered.
import { runDueJobs } from '../../server/lib/jobs';
import {
  alertCalendarTrouble,
  calendarEventIdFor,
  calendarWriteBudget,
  cancelBooking,
  confirmAttendance,
  createBooking,
  getManageView,
  getPublicEvent,
  getSlots,
  manageToken,
  reconcileBookings,
  rescheduleBooking,
  syncBookingToCalendar,
  toPublicBooking,
  toPublicEventType,
  toPublicSite,
  verifyManageToken,
} from '../../server/lib/booking';
import { hmacHex, seal } from '../../server/lib/crypto';
import type { Env, KV } from '../../server/lib/ctx';
import { HttpError } from '../../server/lib/http';
import {
  getBooking,
  getBookingIndex,
  getEventType,
  getHost,
  getSite,
  listHosts,
  listJobs,
  mutateBookingIndex,
  saveEventType,
  saveHost,
  saveSite,
  updateBooking,
  updateHost,
} from '../../server/lib/repo';
import { memoryKV } from '../../server/lib/store';
import { makeTestCtx, type TestCtx } from '../helpers/ctx';

// ───────────────────────── fixtures ─────────────────────────

const OWNER = 'host_owner';
const ALEX = 'host_alex';
/** Monday 09:00 UTC. The owner works Monday to Friday, 09:00 to 17:00 UTC. */
const NOW = '2026-11-16T09:00:00.000Z';
const WED_14 = '2026-11-18T14:00:00.000Z';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const RESEND_URL = 'https://api.resend.com/emails';
const TWILIO_ROOT = 'https://api.twilio.com/';
const MEET_LINK = 'https://meet.google.com/abc-defg-hij';

const GOOGLE_ENV: Partial<Env> = { overrides: { googleClientId: 'client-id.apps.googleusercontent.com', googleClientSecret: 'client-secret' } };
const TWILIO_ENV: Partial<Env> = { overrides: { twilioAccountSid: 'AC' + '0'.repeat(32), twilioAuthToken: 'twilio-token', twilioFromNumber: '+15005550006' } };
const RESEND_ENV: Partial<Env> = { overrides: { resendApiKey: 're_test_key' } };

async function setup(opts: { now?: string; env?: Partial<Env>; kv?: KV; ip?: string | null } = {}): Promise<TestCtx> {
  const ctx = makeTestCtx({ now: opts.now ?? NOW, env: opts.env, kv: opts.kv, ip: opts.ip });
  await getSite(ctx);
  await updateHost(ctx, OWNER, (h) => ({ ...h, email: 'jimi@example.com' }));
  return ctx;
}

async function addAlex(ctx: TestCtx, over: Partial<Host> = {}): Promise<Host> {
  return saveHost(ctx, { ...defaultOwnerHost(ctx.now().toISOString(), 'UTC'), id: ALEX, role: 'member', name: 'Alex Kim', email: 'alex@example.com', ...over });
}

async function addEvent(ctx: TestCtx, partial: Partial<EventType> & Pick<EventType, 'id' | 'slug' | 'title'>): Promise<EventType> {
  return saveEventType(ctx, newEventType(ctx.now().toISOString(), partial));
}

async function editEvent(ctx: TestCtx, id: string, change: (et: EventType) => EventType): Promise<EventType> {
  const et = await getEventType(ctx, id);
  if (!et) throw new Error(`no event type ${id}`);
  return saveEventType(ctx, change(et));
}

function googleConnection(ctx: TestCtx, over: Partial<HostGoogle> = {}): HostGoogle {
  return {
    email: 'jimi.calendar@gmail.test',
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

async function connectGoogle(ctx: TestCtx, hostId: string, over: Partial<HostGoogle> = {}): Promise<void> {
  await updateHost(ctx, hostId, (h) => ({ ...h, google: googleConnection(ctx, over) }));
}

async function useResend(ctx: TestCtx): Promise<void> {
  const site = await getSite(ctx);
  await saveSite(ctx, { ...site, email: { ...site.email, fromEmail: 'meetings@jimicohen.com' } });
}

function request(over: Partial<CreateBookingRequest> = {}): CreateBookingRequest {
  return { slug: 'intro', start: WED_14, durationMin: 15, name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'Europe/London', elapsedMs: 5200, ...over };
}

// ───────────────────────── fake network ─────────────────────────

interface Call {
  url: string;
  method: string;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

type Reply = Response | undefined | Promise<Response | undefined>;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function defaultReply(call: Call): Response {
  if (call.url === TOKEN_URL) return jsonResponse({ access_token: 'access-1', expires_in: 3599, token_type: 'Bearer' });
  if (call.url === FREEBUSY_URL) return jsonResponse({ calendars: { primary: { busy: [] } } });
  if (call.url.startsWith(EVENTS_URL)) {
    if (call.method === 'POST') {
      return jsonResponse({
        id: call.json.id,
        status: 'confirmed',
        htmlLink: 'https://calendar.google.com/calendar/event?eid=abc',
        ...(call.json.conferenceData ? { hangoutLink: MEET_LINK } : {}),
      });
    }
    if (call.method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse({ id: decodeURIComponent(call.url.slice(EVENTS_URL.length + 1).split('?')[0]), status: 'confirmed', hangoutLink: MEET_LINK });
  }
  if (call.url === RESEND_URL) return jsonResponse({ id: 'email-1' });
  if (call.url.startsWith(TWILIO_ROOT)) return jsonResponse({ sid: 'SM00000000000000000000000000000001' }, 201);
  return new Response('not found', { status: 404 });
}

/** Records every outbound request. `custom` may answer first; everything else gets a healthy provider. */
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
    const call: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), body, json: parsed };
    calls.push(call);
    return (await custom?.(call)) ?? defaultReply(call);
  }) as typeof fetch;
  return calls;
}

const eventCalls = (calls: Call[], method: string): Call[] => calls.filter((c) => c.url.startsWith(EVENTS_URL) && c.method === method);
const emailsTo = (calls: Call[], address: string): Call[] => calls.filter((c) => c.url === RESEND_URL && String(c.json?.to?.[0] ?? '').includes(address));

async function failure(work: Promise<unknown>): Promise<HttpError> {
  try {
    await work;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('Expected the call to be refused, but it went through');
}

async function jobsOf(ctx: TestCtx, match: (j: Job) => boolean): Promise<Job[]> {
  return (await listJobs(ctx)).filter(match);
}

const confirmedIndex = async (ctx: TestCtx): Promise<BookingIndexEntry[]> => (await getBookingIndex(ctx)).filter((e) => e.status === 'confirmed');

/**
 * A store on which the first `racers` compare-and-swap reads of the booking index wait for each other.
 * Every racer therefore starts its swap from the same version of the index: the interleaving in
 * which a check-then-write without a real swap would let both through.
 */
function racingKV(racers: number): KV & { arm(): void } {
  const inner = memoryKV();
  let armed = false;
  let arrived = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    ...inner,
    arm() {
      armed = true;
    },
    async getJSONWithEtag<T>(key: string) {
      if (armed && key === 'index/bookings' && arrived < racers) {
        arrived++;
        if (arrived === racers) open();
        await gate;
      }
      return inner.getJSONWithEtag<T>(key);
    },
  };
}

// ───────────────────────── manage token ─────────────────────────

describe('manage token', () => {
  it('is the keyed hash other modules compute for themselves', async () => {
    const ctx = await setup();
    expect(manageToken(ctx, 'bkg_abc')).toBe(hmacHex(ctx, 'manage', 'bkg_abc'));
    expect(manageToken(ctx, 'bkg_abc')).not.toBe(manageToken(ctx, 'bkg_abd'));
  });

  it('accepts only the exact token of that booking', async () => {
    const ctx = await setup();
    const token = manageToken(ctx, 'bkg_abc');
    expect(verifyManageToken(ctx, 'bkg_abc', token)).toBe(true);
    expect(verifyManageToken(ctx, 'bkg_abd', token)).toBe(false);
    expect(verifyManageToken(ctx, 'bkg_abc', token.slice(0, -1))).toBe(false);
    expect(verifyManageToken(ctx, 'bkg_abc', `${token}0`)).toBe(false);
    expect(verifyManageToken(ctx, 'bkg_abc', '')).toBe(false);
    expect(verifyManageToken(ctx, 'bkg_abc', null)).toBe(false);
    expect(verifyManageToken(ctx, '../site', manageToken(ctx, '../site'))).toBe(false);
    // @ts-expect-error a token that is not a string never matches
    expect(verifyManageToken(ctx, 'bkg_abc', 12345)).toBe(false);
  });

  it('depends on the master secret', async () => {
    const a = await setup();
    const b = makeTestCtx({ env: { secretKey: Buffer.alloc(32, 9).toString('base64') } });
    expect(verifyManageToken(b, 'bkg_abc', manageToken(a, 'bkg_abc'))).toBe(false);
  });
});

// ───────────────────────── public views ─────────────────────────

describe('public views', () => {
  it('lists public, active event types only, and says what the site can do', async () => {
    const ctx = await setup({ env: TWILIO_ENV });
    await addEvent(ctx, { id: 'evt_secret', slug: 'vip', title: 'VIP hour', visibility: 'unlisted', position: 5 });
    await addEvent(ctx, { id: 'evt_paused', slug: 'paused', title: 'Paused', active: false, position: 6 });
    const site = await toPublicSite(ctx);

    expect(site.eventTypes.map((e) => e.slug)).toEqual(['intro', 'meeting']);
    expect(site.features).toEqual({ sms: true, calls: true });
    expect(site.ownerTimezone).toBe('UTC');
    expect(site.assistantName).toBe('Ava');
    expect(site.profile.name).toBe('Jimi Cohen');
    expect(site.themeAssets).toEqual({ coverUrl: null, logoUrl: null, backgroundUrl: null });
    expect(site.booking.consentText).toContain('{{host_first_name}}');
  });

  it('reports no text or call reminders without Twilio', async () => {
    const ctx = await setup();
    expect((await toPublicSite(ctx)).features).toEqual({ sms: false, calls: false });
  });

  it('never carries host emails, calendar connections or other private fields', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    await updateHost(ctx, OWNER, (h) => ({ ...h, phone: '+14155550100', inviteTokenHash: 'hash-of-invite', icsFeeds: [{ id: 'f1', label: 'Work', urlEnc: 'sealed-feed-url' }] }));
    const text = JSON.stringify(await toPublicSite(ctx));
    for (const secret of ['jimi@example.com', 'jimi.calendar@gmail.test', 'refreshTokenEnc', 'sealed-feed-url', 'hash-of-invite', '+14155550100', 'schedules', 'ownerHostId']) {
      expect(text).not.toContain(secret);
    }
  });

  it('strips unsafe pieces from custom CSS on the way out', async () => {
    const ctx = await setup();
    const site = await getSite(ctx);
    await saveSite(ctx, { ...site, theme: { ...site.theme, customCss: '.a{color:red}</style><script>alert(1)</script>@import url(https://evil.test/x.css);' } });
    const css = (await toPublicSite(ctx)).theme.customCss;
    expect(css).toContain('.a{color:red}');
    expect(css).not.toMatch(/<\/style|<script|@import/i);
  });

  it('shows the assigned hosts and keeps links and phone numbers back until someone books', async () => {
    const ctx = await setup();
    await addAlex(ctx, { title: 'Partnerships' });
    const et = await addEvent(ctx, {
      id: 'evt_places',
      slug: 'places',
      title: 'Places',
      kind: 'collective',
      hostIds: [OWNER, ALEX],
      locations: [
        { type: 'google_meet' },
        { type: 'custom_link', value: 'https://zoom.example/j/PRIVATE-ROOM' },
        { type: 'phone_invitee_calls', value: '+14155550199' },
        { type: 'phone_host_calls' },
        { type: 'in_person', value: '12 Garden Lane, Nairobi', label: 'At the office' },
        { type: 'ask_invitee' },
      ],
    });
    const view = toPublicEventType(ctx, et, await listHosts(ctx));

    expect(view.hosts).toEqual([
      { id: OWNER, name: 'Jimi Cohen', avatarUrl: null },
      { id: ALEX, name: 'Alex Kim', title: 'Partnerships', avatarUrl: null },
    ]);
    expect(view.locations).toEqual([
      { type: 'google_meet', label: 'Google Meet', detail: 'You get the link when you book' },
      { type: 'custom_link', label: 'Video call', detail: 'You get the link when you book' },
      { type: 'phone_invitee_calls', label: 'Phone call', detail: 'You get the number when you book' },
      { type: 'phone_host_calls', label: 'Phone call', detail: 'Jimi calls you' },
      { type: 'in_person', label: 'At the office', detail: '12 Garden Lane, Nairobi' },
      { type: 'ask_invitee', label: 'Your choice', detail: 'Tell us where suits you' },
    ]);
    const text = JSON.stringify(view);
    expect(text).not.toContain('PRIVATE-ROOM');
    expect(text).not.toContain('+14155550199');
    expect(text).not.toContain('alex@example.com');
    expect(view.minNoticeMinutes).toBe(240);
    expect(view.maxDaysAhead).toBe(60);
  });

  it('resolves an unlisted event type by its link, and neither a paused nor an unknown one', async () => {
    const ctx = await setup();
    await addEvent(ctx, { id: 'evt_secret', slug: 'vip', title: 'VIP hour', visibility: 'unlisted' });
    await addEvent(ctx, { id: 'evt_paused', slug: 'paused', title: 'Paused', active: false });

    const found = await getPublicEvent(ctx, 'VIP');
    expect(found?.eventType.title).toBe('VIP hour');
    expect(found?.site.eventTypes.map((e) => e.slug)).not.toContain('vip');
    expect(await getPublicEvent(ctx, 'paused')).toBeNull();
    expect(await getPublicEvent(ctx, 'nope')).toBeNull();
    expect(await getPublicEvent(ctx, '')).toBeNull();
  });

  it('shows the invitee their booking without the internal parts', async () => {
    const ctx = await setup();
    await editEvent(ctx, 'evt_intro', (et) => ({ ...et, confirmation: { message: 'See you soon, {{invitee_first_name}}.', redirectUrl: 'https://jimicohen.com/thanks' } }));
    const { booking } = await createBooking(ctx, request({ utm: { utm_source: 'newsletter' }, guests: ['grace@example.com'] }));
    const view = await toPublicBooking(ctx, booking);

    expect(view).toMatchObject({
      id: booking.id,
      status: 'confirmed',
      eventTitle: 'Intro call',
      eventSlug: 'intro',
      start: WED_14,
      end: '2026-11-18T14:15:00.000Z',
      durationMin: 15,
      hosts: [{ id: OWNER, name: 'Jimi Cohen', avatarUrl: null }],
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'Europe/London' },
      guests: ['grace@example.com'],
      location: { type: 'google_meet', label: 'Google Meet' },
      confirmationMessage: 'See you soon, {{invitee_first_name}}.',
      redirectUrl: 'https://jimicohen.com/thanks',
      canReschedule: true,
      canCancel: true,
      cancellation: null,
      rescheduledFromStart: null,
      attendanceConfirmed: false,
    });
    const token = manageToken(ctx, booking.id);
    expect(view.calendarLinks.ics).toBe(`https://jimicohen.com/meeting/api/public/bookings/${booking.id}/ics?t=${token}`);
    expect(view.calendarLinks.google).toContain('calendar.google.com');
    expect(view.calendarLinks.outlook).toContain('outlook.live.com');
    const keys = Object.keys(view);
    for (const hidden of ['timeline', 'consent', 'google', 'utm', 'answers', 'hostIds', 'source', 'attendance']) expect(keys).not.toContain(hidden);
    expect(JSON.stringify(view)).not.toContain('jimi@example.com');
  });

  it('closes self-service when the meeting starts, and never passes on a redirect that is not https', async () => {
    const ctx = await setup();
    await editEvent(ctx, 'evt_intro', (et) => ({ ...et, confirmation: { message: '', redirectUrl: 'javascript:alert(1)' } }));
    const { booking } = await createBooking(ctx, request());
    expect((await toPublicBooking(ctx, booking)).redirectUrl).toBeUndefined();
    expect((await toPublicBooking(ctx, booking)).confirmationMessage).toBeUndefined();

    ctx.clock.set(Date.parse(WED_14) - 1);
    expect(await toPublicBooking(ctx, booking)).toMatchObject({ canReschedule: true, canCancel: true });
    ctx.clock.set(WED_14);
    expect(await toPublicBooking(ctx, booking)).toMatchObject({ canReschedule: false, canCancel: false });
  });

  it('offers cancelling but not moving once the event type is paused or gone', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request());
    await editEvent(ctx, 'evt_intro', (et) => ({ ...et, active: false }));
    expect(await toPublicBooking(ctx, booking)).toMatchObject({ canReschedule: false, canCancel: true });

    const view = await getManageView(ctx, booking.id);
    expect(view?.eventType?.slug).toBe('intro');
    expect(view?.booking.id).toBe(booking.id);
    expect(view && 'record' in view).toBe(false);
    expect(await getManageView(ctx, 'bkg_missing')).toBeNull();
  });
});

// ───────────────────────── creating a booking ─────────────────────────

describe('createBooking: a solo event', () => {
  it('stores the booking, takes the time and returns the manage token', async () => {
    const ctx = await setup();
    const { booking, manageToken: token } = await createBooking(ctx, request({ name: '  Ada   Lovelace ', email: ' Ada.L@Example.COM ', locale: 'en_GB' }));

    expect(token).toBe(manageToken(ctx, booking.id));
    expect(booking.id).toMatch(/^bkg_[a-z2-7]{16}$/);
    expect(booking).toMatchObject({
      eventTypeId: 'evt_intro',
      eventSlug: 'intro',
      eventTitle: 'Intro call',
      kind: 'solo',
      hostIds: [OWNER],
      start: WED_14,
      end: '2026-11-18T14:15:00.000Z',
      durationMin: 15,
      status: 'confirmed',
      invitee: { name: 'Ada Lovelace', email: 'Ada.L@example.com', timezone: 'Europe/London', locale: 'en-GB' },
      guests: [],
      answers: [],
      location: { type: 'google_meet', label: 'Google Meet' },
      consent: { sms: false, call: false, at: NOW, text: '' },
      google: null,
      attendance: {},
      cancellation: null,
      rescheduledFromStart: null,
      rescheduleCount: 0,
      source: 'page',
      createdAt: NOW,
    });
    expect(booking.invitee.phone).toBeUndefined();
    expect(booking.timeline[0]).toEqual({ at: NOW, type: 'created', detail: 'Booked from the booking page' });

    expect(await getBooking(ctx, booking.id)).toMatchObject({ id: booking.id, status: 'confirmed' });
    expect(await getBookingIndex(ctx)).toEqual([
      {
        id: booking.id,
        start: WED_14,
        end: '2026-11-18T14:15:00.000Z',
        hostIds: [OWNER],
        eventTypeId: 'evt_intro',
        status: 'confirmed',
        inviteeName: 'Ada Lovelace',
        inviteeEmail: 'Ada.L@example.com',
        eventTitle: 'Intro call',
      },
    ]);
  });

  it('succeeds with no provider connected at all', async () => {
    const ctx = await setup(); // the test fetch throws on any network call
    const { booking } = await createBooking(ctx, request());
    await ctx.settle();
    expect(booking.status).toBe('confirmed');
    expect(booking.google).toBeNull();
    expect(ctx.logs.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('sends the confirmation and the host notice right away and queues the reminders for the right instants', async () => {
    const ctx = await setup({ env: RESEND_ENV });
    await useResend(ctx);
    const calls = net(ctx);
    const { booking } = await createBooking(ctx, request());
    await ctx.settle();

    const toInvitee = emailsTo(calls, 'ada@example.com');
    expect(toInvitee).toHaveLength(1);
    expect(toInvitee[0].json.subject).toMatch(/^Confirmed: Intro call/);
    expect(toInvitee[0].json.text).toContain(`/booking/${booking.id}/reschedule?t=${manageToken(ctx, booking.id)}`);
    expect(emailsTo(calls, 'jimi@example.com')).toHaveLength(1);
    expect(emailsTo(calls, 'jimi@example.com')[0].json.subject).toMatch(/^New booking: Ada Lovelace/);

    // No phone, so only the two email reminders remain: a day before and an hour before.
    const waiting = await listJobs(ctx);
    expect(waiting.map((j) => [j.kind, j.channel, j.dueAt])).toEqual([
      ['reminder', 'email', '2026-11-17T14:00:00.000Z'],
      ['reminder', 'email', '2026-11-18T13:00:00.000Z'],
    ]);
    const types = (await getBooking(ctx, booking.id))!.timeline.map((t) => t.type);
    expect(types).toEqual(expect.arrayContaining(['created', 'confirmation_email_sent', 'host_new_email_sent']));
  });

  it('records consent with the wording the invitee saw, and plans the text and call reminders', async () => {
    const ctx = await setup({ env: { overrides: { ...TWILIO_ENV.overrides, ...RESEND_ENV.overrides } } });
    await useResend(ctx);
    const calls = net(ctx);
    const { booking } = await createBooking(ctx, request({ phone: '+1 (415) 555-2671', consent: { sms: true, call: true } }));
    await ctx.settle();

    expect(booking.invitee.phone).toBe('+14155552671');
    expect(booking.consent).toEqual({
      sms: true,
      call: true,
      at: NOW,
      text: "By adding your number you agree to receive reminder texts and an automated reminder call from Jimi's AI assistant about this meeting. Message and data rates may apply.",
    });
    const texts = calls.filter((c) => c.url.startsWith(TWILIO_ROOT));
    expect(texts).toHaveLength(1);
    expect(new URLSearchParams(texts[0].body).get('To')).toBe('+14155552671');

    const waiting = (await listJobs(ctx)).map((j) => `${j.kind}/${j.channel}@${j.dueAt}`);
    expect(waiting).toEqual([
      'reminder/email@2026-11-17T14:00:00.000Z',
      'reminder/call@2026-11-18T12:00:00.000Z',
      'reminder/email@2026-11-18T13:00:00.000Z',
      'reminder/sms@2026-11-18T13:45:00.000Z',
    ]);
  });

  it('keeps consent off when a channel is not available or was not chosen', async () => {
    const without = await setup();
    const a = await createBooking(without, request({ phone: '+14155552671', consent: { sms: true, call: true } }));
    expect(a.booking.consent).toMatchObject({ sms: false, call: false, text: '' });
    expect(a.booking.invitee.phone).toBe('+14155552671');

    const withTwilio = await setup({ env: TWILIO_ENV });
    net(withTwilio);
    const b = await createBooking(withTwilio, request({ phone: '+14155552671', consent: { sms: false, call: true } }));
    expect(b.booking.consent).toMatchObject({ sms: false, call: true });
    expect(b.booking.consent.text).toContain("Jimi's AI assistant");

    // Consent without a number means nothing.
    const c = await createBooking(withTwilio, request({ start: '2026-11-18T15:00:00.000Z', email: 'grace@example.com', consent: { sms: true, call: true } }));
    expect(c.booking.consent).toMatchObject({ sms: false, call: false, text: '' });
    await withTwilio.settle();
  });

  it('keeps answers with their question, cleans guests and tracking fields', async () => {
    const ctx = await setup();
    await editEvent(ctx, 'evt_intro', (et) => ({
      ...et,
      questions: [
        { id: 'q_topic', label: 'What would you like to talk about?', type: 'textarea', required: true },
        { id: 'q_size', label: 'Team size', type: 'select', required: false, options: ['1 to 10', '11 to 50'] },
        { id: 'q_tools', label: 'Tools', type: 'checkbox', required: false, options: ['Sheets', 'Slack', 'Other'] },
        { id: 'q_terms', label: 'I have read the notes', type: 'checkbox', required: true },
        { id: 'q_site', label: 'Website', type: 'url', required: false },
        { id: 'q_budget', label: 'Budget', type: 'number', required: false },
        { id: 'q_skip', label: 'Anything else', type: 'text', required: false },
      ],
    }));
    const { booking } = await createBooking(
      ctx,
      request({
        guests: [' Grace@Example.ORG ', 'grace@example.org', '', 'ADA@example.com', 'alan@example.com'],
        answers: { q_topic: '  Reforestation\r\npartnerships  ', q_size: '11 to 50', q_tools: ['Slack', 'Sheets', 'Slack'], q_terms: true, q_site: 'treegens.app', q_budget: '1500', q_unknown: 'ignored' },
        utm: { utm_source: 'newsletter', utm_medium: ' email ', evil: 'x', utm_BAD: 'y' } as Record<string, string>,
        source: 'embed',
      }),
    );

    expect(booking.answers).toEqual([
      { questionId: 'q_topic', label: 'What would you like to talk about?', value: 'Reforestation\npartnerships' },
      { questionId: 'q_size', label: 'Team size', value: '11 to 50' },
      { questionId: 'q_tools', label: 'Tools', value: 'Slack, Sheets' },
      { questionId: 'q_terms', label: 'I have read the notes', value: 'Yes' },
      { questionId: 'q_site', label: 'Website', value: 'treegens.app' },
      { questionId: 'q_budget', label: 'Budget', value: '1500' },
    ]);
    expect(booking.guests).toEqual(['Grace@example.org', 'alan@example.com']);
    expect(booking.utm).toEqual({ utm_source: 'newsletter', utm_medium: 'email' });
    expect(booking.source).toBe('embed');
    expect(booking.timeline[0].detail).toBe('Booked through an embedded page');
  });

  it('builds the location the invitee chose', async () => {
    const ctx = await setup();
    await editEvent(ctx, 'evt_intro', (et) => ({
      ...et,
      phone: 'hidden',
      locations: [
        { type: 'google_meet' },
        { type: 'phone_host_calls' },
        { type: 'phone_invitee_calls', value: '+14155550199' },
        { type: 'in_person', value: '12 Garden Lane, Nairobi' },
        { type: 'custom_link', value: 'https://zoom.example/j/123', label: 'Zoom' },
        { type: 'ask_invitee' },
      ],
    }));
    const starts = ['14:00', '14:30', '15:00', '15:30', '16:00'].map((t) => `2026-11-18T${t}:00.000Z`);
    const book = async (i: number, over: Partial<CreateBookingRequest>): Promise<Booking> =>
      (await createBooking(ctx, request({ start: starts[i], email: `p${i}@example.com`, ...over }))).booking;

    const calls = await book(0, { locationIndex: 1, phone: '+442071838750' });
    expect(calls.location).toEqual({ type: 'phone_host_calls', label: 'Phone call', value: 'Jimi will call +442071838750' });
    expect(calls.invitee.phone).toBe('+442071838750');

    // The event type does not ask for a number, so one that is sent anyway is not kept.
    const dial = await book(1, { locationIndex: 2, phone: '+442071838750' });
    expect(dial.location).toEqual({ type: 'phone_invitee_calls', label: 'Phone call', value: '+14155550199' });
    expect(dial.invitee.phone).toBeUndefined();

    expect((await book(2, { locationIndex: 3 })).location).toEqual({ type: 'in_person', label: 'In person', value: '12 Garden Lane, Nairobi' });
    expect((await book(3, { locationIndex: 4 })).location).toEqual({ type: 'custom_link', label: 'Zoom', value: 'https://zoom.example/j/123', joinUrl: 'https://zoom.example/j/123' });
    expect((await book(4, { locationIndex: 5, locationText: '  Cafe Roma,\n Main Street ' })).location).toEqual({ type: 'ask_invitee', label: 'Location', value: 'Cafe Roma, Main Street' });
  });
});

describe('createBooking: collective and round robin', () => {
  it('puts every host of a collective event on the booking and needs all of them free', async () => {
    const ctx = await setup();
    // Alex stops an hour before Jimi.
    const alex = await addAlex(ctx);
    const weekly = { ...alex.schedules[0].weekly, 3: [{ start: '09:00', end: '16:00' }] };
    await saveHost(ctx, { ...alex, schedules: [{ ...alex.schedules[0], weekly }] });
    await addEvent(ctx, { id: 'evt_joint', slug: 'joint', title: 'Joint call', kind: 'collective', hostIds: [OWNER, ALEX], durations: [30], defaultDuration: 30 });

    const { booking } = await createBooking(ctx, request({ slug: 'joint', durationMin: 30 }));
    expect(booking.kind).toBe('collective');
    expect(booking.hostIds).toEqual([OWNER, ALEX]);
    expect((await getBookingIndex(ctx))[0].hostIds).toEqual([OWNER, ALEX]);

    // 16:00 suits Jimi but not Alex.
    const late = await failure(createBooking(ctx, request({ slug: 'joint', durationMin: 30, start: '2026-11-18T16:00:00.000Z', email: 'grace@example.com' })));
    expect(late).toMatchObject({ status: 409, code: 'slot_taken' });

    // The joint meeting keeps both of them busy for their other event types.
    const solo = await failure(createBooking(ctx, request({ start: '2026-11-18T14:15:00.000Z', email: 'grace@example.com' })));
    expect(solo).toMatchObject({ status: 409, code: 'slot_taken' });
  });

  it('refuses a collective event while one of its hosts no longer exists', async () => {
    const ctx = await setup();
    await addEvent(ctx, { id: 'evt_joint', slug: 'joint', title: 'Joint call', kind: 'collective', hostIds: [OWNER, 'host_gone'], durations: [30], defaultDuration: 30 });
    expect(await failure(createBooking(ctx, request({ slug: 'joint', durationMin: 30 })))).toMatchObject({ status: 409, code: 'slot_taken' });
    expect(await getBookingIndex(ctx)).toEqual([]);
  });

  it('shares round robin bookings out fairly, one host per booking', async () => {
    const ctx = await setup();
    await addAlex(ctx);
    await addEvent(ctx, { id: 'evt_team', slug: 'team', title: 'Team call', kind: 'round_robin', hostIds: [OWNER, ALEX], durations: [30], defaultDuration: 30 });
    const book = async (start: string, n: number): Promise<Booking> =>
      (await createBooking(ctx, request({ slug: 'team', durationMin: 30, start, email: `p${n}@example.com` }))).booking;

    // Nobody has a booking yet: the smaller id goes first, then they take turns.
    const first = await book('2026-11-18T10:00:00.000Z', 1);
    const second = await book('2026-11-18T11:00:00.000Z', 2);
    const third = await book('2026-11-18T12:00:00.000Z', 3);
    const fourth = await book('2026-11-18T13:00:00.000Z', 4);
    expect([first, second, third, fourth].map((b) => b.hostIds)).toEqual([[ALEX], [OWNER], [ALEX], [OWNER]]);
    expect((await getBookingIndex(ctx)).every((e) => e.hostIds.length === 1)).toBe(true);
  });

  it('gives a round robin slot to whoever is still free, and closes it when nobody is', async () => {
    const ctx = await setup();
    await addAlex(ctx);
    await addEvent(ctx, { id: 'evt_team', slug: 'team', title: 'Team call', kind: 'round_robin', hostIds: [OWNER, ALEX], durations: [30], defaultDuration: 30 });
    const book = (n: number): Promise<{ booking: Booking }> => createBooking(ctx, request({ slug: 'team', durationMin: 30, email: `p${n}@example.com` }));

    const a = await book(1);
    const b = await book(2);
    expect([a.booking.hostIds[0], b.booking.hostIds[0]].sort()).toEqual([ALEX, OWNER]);
    expect(await failure(book(3))).toMatchObject({ status: 409, code: 'slot_taken' });
    expect(await confirmedIndex(ctx)).toHaveLength(2);
  });
});

// ───────────────────────── validation ─────────────────────────

describe('createBooking: validation', () => {
  it('answers a filled honeypot and a too-fast form with the same generic refusal', async () => {
    const ctx = await setup();
    const trapped = await failure(createBooking(ctx, request({ website: 'https://spam.example' })));
    const fast = await failure(createBooking(ctx, request({ elapsedMs: 1499 })));
    const odd = await failure(createBooking(ctx, request({ elapsedMs: 'soon' as unknown as number })));

    for (const err of [trapped, fast, odd]) {
      expect(err.status).toBe(422);
      expect(err.code).toBe('invalid');
      expect(err.message).toBe('Could not complete the booking. Please try again.');
      expect(err.fields).toBeUndefined();
    }
    expect(await getBookingIndex(ctx)).toEqual([]);

    // Exactly at the threshold, and without the field at all (other clients), the booking goes ahead.
    expect((await createBooking(ctx, request({ elapsedMs: 1500 }))).booking.status).toBe('confirmed');
    const bare = request({ start: '2026-11-18T15:00:00.000Z', email: 'grace@example.com' });
    delete bare.elapsedMs;
    expect((await createBooking(ctx, bare)).booking.status).toBe('confirmed');
  });

  it('says 404 for an unknown or paused meeting type', async () => {
    const ctx = await setup();
    await addEvent(ctx, { id: 'evt_paused', slug: 'paused', title: 'Paused', active: false });
    expect(await failure(createBooking(ctx, request({ slug: 'nope' })))).toMatchObject({ status: 404, code: 'not_found' });
    expect(await failure(createBooking(ctx, request({ slug: 'paused', durationMin: 30 })))).toMatchObject({ status: 404, code: 'not_found' });
    expect(await failure(createBooking(ctx, request({ slug: undefined as unknown as string })))).toMatchObject({ status: 404 });
  });

  const cases: [string, Partial<CreateBookingRequest>, string][] = [
    ['a missing name', { name: '   ' }, 'name'],
    ['a one-letter name', { name: 'A' }, 'name'],
    ['a name that is too long', { name: 'A'.repeat(121) }, 'name'],
    ['a missing email', { email: '' }, 'email'],
    ['an email without a domain', { email: 'ada@' }, 'email'],
    ['an email with two @ signs', { email: 'ada@@example.com' }, 'email'],
    ['an email that is too long', { email: `${'a'.repeat(250)}@example.com` }, 'email'],
    ['an unknown time zone', { timezone: 'Mars/Olympus_Mons' }, 'timezone'],
    ['a UTC offset instead of a zone', { timezone: '+03:00' }, 'timezone'],
    ['a missing time zone', { timezone: undefined as unknown as string }, 'timezone'],
    ['a start that is not an instant', { start: '2026-11-18 14:00' }, 'start'],
    ['a start without an offset', { start: '2026-11-18T14:00:00' }, 'start'],
    ['a missing start', { start: undefined as unknown as string }, 'start'],
    ['a length that is not offered', { durationMin: 30 }, 'durationMin'],
    ['a length that is not a number', { durationMin: '15' as unknown as number }, 'durationMin'],
    ['a location that does not exist', { locationIndex: 3 }, 'locationIndex'],
    ['a negative location', { locationIndex: -1 }, 'locationIndex'],
    ['a phone number that is not one', { phone: '12345' }, 'phone'],
    ['a phone number without a country code', { phone: '0712 345678' }, 'phone'],
    ['a phone number of the wrong type', { phone: 4155552671 as unknown as string }, 'phone'],
    ['too many guests', { guests: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com', 'f@example.com'] }, 'guests'],
    ['a guest that is not an email', { guests: ['grace@example.com', 'not-an-email'] }, 'guests'],
    ['guests that are not a list', { guests: 'grace@example.com' as unknown as string[] }, 'guests'],
    ['answers that are not an object', { answers: ['x'] as unknown as CreateBookingRequest['answers'] }, 'answers'],
    ['an answer that is too long', { answers: { q_topic: 'x'.repeat(2001) } }, 'answers.q_topic'],
    ['an answer of the wrong type', { answers: { q_topic: { a: 1 } as unknown as string } }, 'answers.q_topic'],
  ];
  it.each(cases)('refuses %s', async (_what, over, field) => {
    const ctx = await setup();
    const err = await failure(createBooking(ctx, request(over)));
    expect(err.status).toBe(422);
    expect(err.code).toBe('invalid');
    expect(Object.keys(err.fields ?? {})).toEqual([field]);
    expect(err.fields?.[field]).toMatch(/\S/);
    expect(err.fields?.[field]).not.toContain('—');
    expect(await getBookingIndex(ctx)).toEqual([]);
    expect(await ctx.kv.list('bookings/')).toEqual([]);
  });

  it('reports every problem at once, keyed the way the form names its fields', async () => {
    const ctx = await setup();
    const err = await failure(createBooking(ctx, request({ name: '', email: 'nope', phone: 'abc', guests: ['x'], timezone: 'Nowhere' })));
    expect(Object.keys(err.fields ?? {}).sort()).toEqual(['email', 'guests', 'name', 'phone', 'timezone']);
    expect(err.message).toBe('Please check the highlighted fields.');
  });

  it('checks the questions of the event type', async () => {
    const ctx = await setup();
    await editEvent(ctx, 'evt_intro', (et) => ({
      ...et,
      questions: [
        { id: 'q_topic', label: 'Topic', type: 'text', required: true },
        { id: 'q_size', label: 'Team size', type: 'radio', required: true, options: ['Small', 'Large'] },
        { id: 'q_tools', label: 'Tools', type: 'checkbox', required: true, options: ['Sheets', 'Slack'] },
        { id: 'q_terms', label: 'Agree', type: 'checkbox', required: true },
        { id: 'q_site', label: 'Website', type: 'url', required: false },
        { id: 'q_budget', label: 'Budget', type: 'number', required: false },
      ],
    }));

    const empty = await failure(createBooking(ctx, request({ answers: {} })));
    expect(empty.fields).toEqual({
      'answers.q_topic': 'Please answer this question.',
      'answers.q_size': 'Please choose an option.',
      'answers.q_tools': 'Please choose at least one.',
      'answers.q_terms': 'Please tick this box to continue.',
    });

    const wrong = await failure(
      createBooking(ctx, request({ answers: { q_topic: '   ', q_size: 'Huge', q_tools: ['Sheets', 'Fax'], q_terms: 'yes' as unknown as boolean, q_site: 'not a link', q_budget: 'lots' } })),
    );
    expect(Object.keys(wrong.fields ?? {}).sort()).toEqual(['answers.q_budget', 'answers.q_site', 'answers.q_size', 'answers.q_terms', 'answers.q_tools', 'answers.q_topic']);

    const ok = await createBooking(ctx, request({ answers: { q_topic: 'Trees', q_size: 'Small', q_tools: 'Slack', q_terms: true, q_site: 'https://treegens.app/about', q_budget: '12,5' } }));
    expect(ok.booking.answers.map((a) => a.value)).toEqual(['Trees', 'Small', 'Slack', 'Yes', 'https://treegens.app/about', '12,5']);
  });

  it('asks for a phone number when the meeting needs one', async () => {
    const ctx = await setup();
    await editEvent(ctx, 'evt_intro', (et) => ({ ...et, phone: 'required' }));
    const required = await failure(createBooking(ctx, request()));
    expect(required.fields).toEqual({ phone: 'Please enter your phone number.' });

    await editEvent(ctx, 'evt_intro', (et) => ({ ...et, phone: 'hidden', locations: [{ type: 'phone_host_calls' }] }));
    const toCall = await failure(createBooking(ctx, request()));
    expect(toCall.fields).toEqual({ phone: 'Jimi needs a number to call you on.' });
  });

  it('asks where to meet when the invitee chooses the place, and refuses guests the event does not allow', async () => {
    const ctx = await setup();
    await editEvent(ctx, 'evt_intro', (et) => ({ ...et, allowGuests: false, locations: [{ type: 'ask_invitee' }] }));
    expect((await failure(createBooking(ctx, request()))).fields).toEqual({ locationText: 'Please tell us where you would like to meet.' });
    expect((await failure(createBooking(ctx, request({ locationText: 'x'.repeat(301) })))).fields).toEqual({ locationText: 'Please keep this under 300 characters.' });
    expect((await failure(createBooking(ctx, request({ locationText: 'Cafe Roma', guests: ['grace@example.com'] })))).fields).toEqual({ guests: 'Guests cannot be added to this meeting.' });
  });

  it('strips control characters and direction overrides from what people type', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request({ name: 'Ada‮ Lovelace\u0007', answers: { q_topic: 'Line one\u0000\r\nLine two' } }));
    expect(booking.invitee.name).toBe('Ada Lovelace');
    expect(booking.answers[0].value).toBe('Line one\nLine two');
  });
});

// ───────────────────────── times that cannot be booked ─────────────────────────

describe('createBooking: the time has to be free', () => {
  const refused: [string, Partial<CreateBookingRequest>][] = [
    ['inside the minimum notice', { start: '2026-11-16T12:45:00.000Z' }],
    ['in the past', { start: '2026-11-13T14:00:00.000Z' }],
    ['beyond the booking window', { start: '2027-03-10T14:00:00.000Z' }],
    ['on a day off', { start: '2026-11-21T14:00:00.000Z' }],
    ['before working hours', { start: '2026-11-18T08:45:00.000Z' }],
    ['running past the end of the day', { start: '2026-11-18T17:00:00.000Z' }],
    ['off the grid', { start: '2026-11-18T14:07:00.000Z' }],
  ];
  it.each(refused)('refuses a time %s with 409 slot_taken', async (_what, over) => {
    const ctx = await setup();
    const err = await failure(createBooking(ctx, request(over)));
    expect(err).toMatchObject({ status: 409, code: 'slot_taken' });
    expect(err.message).toMatch(/Please pick/);
    expect(await getBookingIndex(ctx)).toEqual([]);
  });

  it('refuses a time another booking holds, buffers included, on both sides', async () => {
    const ctx = await setup();
    // "Meeting": 30 minutes with 10 minutes kept free afterwards. "Intro call": 15 minutes with 5 afterwards.
    await createBooking(ctx, request({ slug: 'meeting', durationMin: 30, start: '2026-11-18T14:00:00.000Z' }));
    const at = (time: string): Promise<{ booking: Booking }> => createBooking(ctx, request({ start: `2026-11-18T${time}:00.000Z`, email: `p${time.replace(':', '')}@example.com` }));

    // The meeting keeps its own buffer even though the newcomer has none before it.
    expect(await failure(at('14:30'))).toMatchObject({ status: 409, code: 'slot_taken', message: 'That time was just taken. Please pick another one.' });
    // The newcomer's buffer after it must not run into the meeting.
    expect(await failure(at('13:45'))).toMatchObject({ status: 409, code: 'slot_taken' });
    expect(await failure(at('14:15'))).toMatchObject({ status: 409, code: 'slot_taken' });
    // 13:30 to 13:45 plus 5 minutes is clear, and so is 14:45.
    expect((await at('13:30')).booking.status).toBe('confirmed');
    expect((await at('14:45')).booking.status).toBe('confirmed');
  });

  it('respects the daily limit of an event type', async () => {
    const ctx = await setup();
    await editEvent(ctx, 'evt_intro', (et) => ({ ...et, scheduling: { ...et.scheduling, maxPerDay: 1 } }));
    await createBooking(ctx, request({ start: '2026-11-18T10:00:00.000Z' }));
    expect(await failure(createBooking(ctx, request({ start: '2026-11-18T15:00:00.000Z', email: 'grace@example.com' })))).toMatchObject({ status: 409, code: 'slot_taken' });
    expect((await createBooking(ctx, request({ start: '2026-11-19T15:00:00.000Z', email: 'grace@example.com' }))).booking.status).toBe('confirmed');
  });

  it('books the right instant whatever zone the invitee and the host are in', async () => {
    const ctx = await setup();
    // The owner moves to Nairobi (UTC+3): 09:00 to 17:00 there is 06:00 to 14:00 UTC.
    await updateHost(ctx, OWNER, (h) => ({ ...h, timezone: 'Africa/Nairobi' }));
    const early = await createBooking(ctx, request({ start: '2026-11-18T09:00:00+03:00', timezone: 'America/Los_Angeles' }));
    expect(early.booking.start).toBe('2026-11-18T06:00:00.000Z');
    expect(early.booking.invitee.timezone).toBe('America/Los_Angeles');
    // 14:00 UTC is 17:00 in Nairobi: the working day is over.
    expect(await failure(createBooking(ctx, request({ start: '2026-11-18T14:00:00.000Z', email: 'grace@example.com' })))).toMatchObject({ status: 409 });
  });
});

// ───────────────────────── rate limits ─────────────────────────

describe('createBooking: rate limits', () => {
  it('allows ten attempts an hour from one address, whatever happens to them', async () => {
    const ctx = await setup();
    for (let i = 0; i < 10; i++) {
      expect((await failure(createBooking(ctx, request({ website: 'bot' })))).status).toBe(422);
    }
    const eleventh = await failure(createBooking(ctx, request()));
    expect(eleventh).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(eleventh.headers?.['Retry-After']).toMatch(/^\d+$/);

    // Someone else is not affected, and the hour passes.
    const other = makeTestCtx({ kv: ctx.kv, now: NOW, ip: '198.51.100.9' });
    expect((await createBooking(other, request())).booking.status).toBe('confirmed');
    ctx.clock.advance(HOUR);
    expect((await createBooking(ctx, request({ start: '2026-11-18T15:00:00.000Z', email: 'grace@example.com' }))).booking.status).toBe('confirmed');
  });

  it('allows six attempts an hour for one email address, across visitors and spellings', async () => {
    const ctx = await setup();
    for (let i = 0; i < 6; i++) {
      const visitor = makeTestCtx({ kv: ctx.kv, now: NOW, ip: `198.51.100.${i + 1}` });
      const email = i % 2 === 0 ? 'ada@example.com' : 'ADA@Example.com';
      // A Saturday: refused as a time, but it still counts as an attempt.
      expect((await failure(createBooking(visitor, request({ email, start: '2026-11-21T14:00:00.000Z' })))).status).toBe(409);
    }
    const seventh = makeTestCtx({ kv: ctx.kv, now: NOW, ip: '198.51.100.77' });
    expect(await failure(createBooking(seventh, request()))).toMatchObject({ status: 429, code: 'rate_limited' });
    expect((await createBooking(seventh, request({ email: 'grace@example.com' }))).booking.status).toBe('confirmed');
  });

  it('does not count a request that failed validation against the email address', async () => {
    const ctx = await setup();
    for (let i = 0; i < 8; i++) {
      const visitor = makeTestCtx({ kv: ctx.kv, now: NOW, ip: `198.51.100.${i + 1}` });
      expect((await failure(createBooking(visitor, request({ name: '' })))).status).toBe(422);
    }
    const visitor = makeTestCtx({ kv: ctx.kv, now: NOW, ip: '198.51.100.99' });
    expect((await createBooking(visitor, request())).booking.status).toBe('confirmed');
  });

  it('still limits requests that arrive without a client address, with a wider shared allowance', async () => {
    const ctx = await setup({ ip: null });
    for (let i = 0; i < 120; i++) {
      expect((await failure(createBooking(ctx, request({ website: 'bot' })))).status).toBe(422);
    }
    expect(await failure(createBooking(ctx, request()))).toMatchObject({ status: 429 });
  });
});

// ───────────────────────── double booking ─────────────────────────

describe('createBooking: two requests for the same time', () => {
  it('lets exactly one through when both start from the same state of the index', async () => {
    const kv = racingKV(2);
    const ctx = await setup({ kv });
    kv.arm();
    const results = await Promise.allSettled([
      createBooking(makeTestCtx({ kv, now: NOW, ip: '198.51.100.1' }), request({ email: 'ada@example.com' })),
      createBooking(makeTestCtx({ kv, now: NOW, ip: '198.51.100.2' }), request({ email: 'grace@example.com', name: 'Grace Hopper' })),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(HttpError);
    expect(lost[0].reason).toMatchObject({ status: 409, code: 'slot_taken' });

    const index = await getBookingIndex(ctx);
    expect(index).toHaveLength(1);
    expect(await ctx.kv.list('bookings/')).toEqual([`bookings/${index[0].id}`]);
    // The loser left nothing behind: no reminders, no messages.
    expect((await listJobs(ctx)).every((j) => j.bookingId === index[0].id)).toBe(true);
  });

  it('holds for overlapping times of different lengths', async () => {
    const kv = racingKV(2);
    const ctx = await setup({ kv });
    kv.arm();
    const results = await Promise.allSettled([
      createBooking(makeTestCtx({ kv, now: NOW, ip: '198.51.100.1' }), request({ slug: 'meeting', durationMin: 60, start: '2026-11-18T14:00:00.000Z' })),
      createBooking(makeTestCtx({ kv, now: NOW, ip: '198.51.100.2' }), request({ start: '2026-11-18T14:45:00.000Z', email: 'grace@example.com' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await confirmedIndex(ctx)).toHaveLength(1);
  });

  it('holds across event types when only one host is shared', async () => {
    const kv = racingKV(2);
    const ctx = await setup({ kv });
    await addAlex(ctx);
    await addEvent(ctx, { id: 'evt_joint', slug: 'joint', title: 'Joint call', kind: 'collective', hostIds: [OWNER, ALEX], durations: [30], defaultDuration: 30 });
    await addEvent(ctx, { id: 'evt_alex', slug: 'alex', title: 'Time with Alex', hostIds: [ALEX], durations: [30], defaultDuration: 30 });
    kv.arm();

    // The joint call needs Jimi and Alex. The other one needs Alex alone, at the same time.
    const results = await Promise.allSettled([
      createBooking(makeTestCtx({ kv, now: NOW, ip: '198.51.100.1' }), request({ slug: 'joint', durationMin: 30 })),
      createBooking(makeTestCtx({ kv, now: NOW, ip: '198.51.100.2' }), request({ slug: 'alex', durationMin: 30, email: 'grace@example.com' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason).toMatchObject({ status: 409, code: 'slot_taken' });
    const index = await confirmedIndex(ctx);
    expect(index).toHaveLength(1);
    expect(index[0].hostIds).toContain(ALEX);
  });

  it('never gives the same round robin host two bookings at once, and never books more people than there are hosts', async () => {
    const kv = racingKV(3);
    const ctx = await setup({ kv });
    await addAlex(ctx);
    await addEvent(ctx, { id: 'evt_team', slug: 'team', title: 'Team call', kind: 'round_robin', hostIds: [OWNER, ALEX], durations: [30], defaultDuration: 30 });
    kv.arm();
    const results = await Promise.allSettled(
      [1, 2, 3].map((n) => createBooking(makeTestCtx({ kv, now: NOW, ip: `198.51.100.${n}` }), request({ slug: 'team', durationMin: 30, email: `p${n}@example.com` }))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const index = await confirmedIndex(ctx);
    expect(index.map((e) => e.hostIds[0]).sort()).toEqual([ALEX, OWNER]);
  });

  it('survives a crowd: twelve visitors, one slot, one booking', async () => {
    const ctx = await setup();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, n) => createBooking(makeTestCtx({ kv: ctx.kv, now: NOW, ip: `198.51.100.${n + 1}` }), request({ email: `p${n}@example.com` }))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 409, code: 'slot_taken' });
    expect(await confirmedIndex(ctx)).toHaveLength(1);
    expect(await ctx.kv.list('bookings/')).toHaveLength(1);
  });

  it('gives the time back when the booking record cannot be saved', async () => {
    const inner = memoryKV();
    let breakSaves = false;
    const kv: KV = {
      ...inner,
      async setJSON(key, value, opts) {
        if (breakSaves && key.startsWith('bookings/')) throw new Error('storage is down');
        return inner.setJSON(key, value, opts);
      },
    };
    const ctx = await setup({ kv });
    breakSaves = true;
    await expect(createBooking(ctx, request())).rejects.toThrow('storage is down');
    expect(await getBookingIndex(ctx)).toEqual([]);

    breakSaves = false;
    expect((await createBooking(ctx, request())).booking.status).toBe('confirmed');
  });
});

// ───────────────────────── calendars that cannot be read ─────────────────────────

describe('createBooking: calendars fail closed', () => {
  it('answers 503 and books nothing when a required calendar cannot be read, and tells the owner once a day', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    net(ctx, (call) => (call.url === FREEBUSY_URL ? jsonResponse({ error: { code: 500, message: 'backend error' } }, 500) : undefined));

    const first = await failure(createBooking(ctx, request()));
    expect(first).toMatchObject({ status: 503, code: 'calendar_unavailable' });
    expect(first.message).toContain('nothing was booked');
    expect(await getBookingIndex(ctx)).toEqual([]);
    expect(await ctx.kv.list('bookings/')).toEqual([]);

    let alerts = await jobsOf(ctx, (j) => j.kind === 'host_alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'message', bookingId: '', channel: 'email', audience: 'host', dueAt: NOW });
    expect(alerts[0].subject).toBe('A calendar needs attention: Jimi Cohen');
    expect(alerts[0].body).toContain('Someone just tried to book "Intro call"');
    expect(alerts[0].body).toContain('Jimi Cohen: Google request failed (500');
    expect(`${alerts[0].subject}${alerts[0].body}`).not.toContain('—');

    // Later the same day: still refused, no second email.
    ctx.clock.advance(5 * HOUR);
    expect(await failure(createBooking(ctx, request({ email: 'grace@example.com' })))).toMatchObject({ status: 503 });
    expect(await jobsOf(ctx, (j) => j.kind === 'host_alert')).toHaveLength(1);

    // The next day there is one more.
    ctx.clock.advance(DAY);
    expect(await failure(createBooking(ctx, request({ email: 'alan@example.com' })))).toMatchObject({ status: 503 });
    alerts = await jobsOf(ctx, (j) => j.kind === 'host_alert');
    expect(alerts).toHaveLength(2);
  });

  it('refuses when Google needs a reconnect, without any network call', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER, { status: 'needs_reconnect' });
    const calls = net(ctx);
    expect(await failure(createBooking(ctx, request()))).toMatchObject({ status: 503, code: 'calendar_unavailable' });
    expect(calls).toEqual([]);
    expect((await jobsOf(ctx, (j) => j.kind === 'host_alert'))[0].body).toContain('needs to be reconnected');
  });

  it('refuses a collective event when one of its hosts cannot be read', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await addAlex(ctx);
    await connectGoogle(ctx, ALEX, { status: 'needs_reconnect' });
    await addEvent(ctx, { id: 'evt_joint', slug: 'joint', title: 'Joint call', kind: 'collective', hostIds: [OWNER, ALEX], durations: [30], defaultDuration: 30 });
    net(ctx);
    expect(await failure(createBooking(ctx, request({ slug: 'joint', durationMin: 30 })))).toMatchObject({ status: 503, code: 'calendar_unavailable' });
    expect((await jobsOf(ctx, (j) => j.kind === 'host_alert'))[0].subject).toBe('A calendar needs attention: Alex Kim');
    // The owner's own event type is unaffected.
    expect((await createBooking(ctx, request())).booking.hostIds).toEqual([OWNER]);
  });

  it('carries a round robin on with the hosts that can be read, and never books the unreadable one', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await addAlex(ctx);
    await connectGoogle(ctx, ALEX, { status: 'needs_reconnect' });
    await addEvent(ctx, { id: 'evt_team', slug: 'team', title: 'Team call', kind: 'round_robin', hostIds: [OWNER, ALEX], durations: [30], defaultDuration: 30 });
    net(ctx);

    const first = await createBooking(ctx, request({ slug: 'team', durationMin: 30 }));
    expect(first.booking.hostIds).toEqual([OWNER]);
    expect(await jobsOf(ctx, (j) => j.kind === 'host_alert')).toHaveLength(1);
    // Alex would be free by our own records, but nobody knows what his calendar says.
    expect(await failure(createBooking(ctx, request({ slug: 'team', durationMin: 30, email: 'grace@example.com' })))).toMatchObject({ status: 409, code: 'slot_taken' });

    // With every host unreadable the event is closed.
    await connectGoogle(ctx, OWNER, { status: 'needs_reconnect' });
    expect(await failure(createBooking(ctx, request({ slug: 'team', durationMin: 30, start: '2026-11-18T15:00:00.000Z', email: 'alan@example.com' })))).toMatchObject({ status: 503 });
  });

  it('refuses a time the host calendar shows as busy, and asks Google afresh for every booking', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    let busy: { start: string; end: string }[] = [];
    const calls = net(ctx, (call) => (call.url === FREEBUSY_URL ? jsonResponse({ calendars: { primary: { busy } } }) : undefined));

    // Warm the 60 second cache with an empty calendar, as a visitor browsing times would.
    await getSlots(ctx, { slug: 'intro', durationMin: 15, fromMs: Date.parse('2026-11-18T00:00:00Z'), toMs: Date.parse('2026-11-19T00:00:00Z') });
    busy = [{ start: '2026-11-18T13:50:00Z', end: '2026-11-18T14:05:00Z' }];

    expect(await failure(createBooking(ctx, request()))).toMatchObject({ status: 409, code: 'slot_taken' });
    const asked = calls.filter((c) => c.url === FREEBUSY_URL);
    expect(asked).toHaveLength(2);
    // One day either side of the meeting.
    expect(asked[1].json).toMatchObject({ timeMin: '2026-11-17T14:00:00.000Z', timeMax: '2026-11-19T14:15:00.000Z', items: [{ id: 'primary' }] });
    expect((await createBooking(ctx, request({ start: '2026-11-18T14:30:00.000Z' }))).booking.status).toBe('confirmed');
  });

  it('does not wait forever for a calendar: without an answer in time nothing is booked and nobody is alarmed', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    let release: () => void = () => undefined;
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    net(ctx, async (call) => {
      if (call.url === FREEBUSY_URL) await stuck;
      return undefined;
    });

    const slow = await failure(createBooking(ctx, request(), { calendarReadBudgetMs: 20 }));
    expect(slow).toMatchObject({ status: 503, code: 'calendar_unavailable' });
    expect(await getBookingIndex(ctx)).toEqual([]);
    expect(await ctx.kv.list('bookings/')).toEqual([]);
    // Slow is not broken: no email to the owner.
    expect(await jobsOf(ctx, (j) => j.kind === 'host_alert')).toEqual([]);

    release();
    await ctx.settle();
    expect((await createBooking(ctx, request())).booking.status).toBe('confirmed');
  });

  it('limits calendar alerts to one per broken host per day, however they are raised', async () => {
    const ctx = await setup();
    const alex = await addAlex(ctx);
    const owner = (await getHost(ctx, OWNER))!;
    expect(await alertCalendarTrouble(ctx, [{ host: owner, error: 'Calendar could not be read.' }])).toBe(1);
    expect(await alertCalendarTrouble(ctx, [{ host: owner, error: 'Calendar could not be read.' }], { eventTitle: 'Intro call' })).toBe(0);
    expect(await alertCalendarTrouble(ctx, [{ host: owner, error: 'x' }, { host: { ...alex, name: 'Alex {{admin_url}}' }, error: 'Feed {{site_name}} failed' }])).toBe(1);
    const alerts = await jobsOf(ctx, (j) => j.kind === 'host_alert');
    expect(alerts).toHaveLength(2);
    const routine = alerts.find((j) => j.subject === 'A calendar needs attention: Jimi Cohen');
    expect(routine?.body).toContain('during a routine check');
    // Names and error text are data: they never become template tags.
    const second = alerts.find((j) => j !== routine);
    expect(second?.subject).toBe('A calendar needs attention: Alex { {admin_url} }');
    expect(second?.body).not.toContain('{{site_name}}');
    expect(second?.body).toContain('Feed { {site_name} } failed');
    expect(second?.body).toContain('{{host_first_name}}');
  });
});

// ───────────────────────── Google Calendar ─────────────────────────

describe('Google Calendar sync', () => {
  it('writes the event with a Meet link, the co-host, the invitee and guests, and stores what came back', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    await addAlex(ctx);
    await addEvent(ctx, { id: 'evt_joint', slug: 'joint', title: 'Joint call', kind: 'collective', hostIds: [ALEX, OWNER], durations: [30], defaultDuration: 30 });
    await updateHost(ctx, OWNER, (h) => ({ ...h, timezone: 'Africa/Nairobi', schedules: [{ ...h.schedules[0], weekly: { ...h.schedules[0].weekly, 3: [{ start: '09:00', end: '20:00' }] } }] }));
    const calls = net(ctx);

    const { booking } = await createBooking(
      ctx,
      request({ slug: 'joint', durationMin: 30, phone: '+14155552671', guests: ['grace@example.com'], answers: { q_topic: 'Trees <b>and</b> more' }, name: 'Ada <i>L</i>' }),
    );

    const posts = eventCalls(calls, 'POST');
    expect(posts).toHaveLength(1);
    const url = new URL(posts[0].url);
    expect(url.searchParams.get('conferenceDataVersion')).toBe('1');
    expect(url.searchParams.get('sendUpdates')).toBe('all');
    const body = posts[0].json;
    // The id google.ts derives from the booking: a later cancellation relies on knowing it.
    expect(body.id).toBe(calendarEventIdFor(booking.id));
    expect(body.summary).toBe('Joint call: Ada <i>L</i>, Alex Kim and Jimi Cohen');
    expect(body.start).toEqual({ dateTime: WED_14, timeZone: 'Africa/Nairobi' });
    expect(body.end).toEqual({ dateTime: '2026-11-18T14:30:00.000Z', timeZone: 'Africa/Nairobi' });
    expect(body.attendees).toEqual([
      { email: 'alex@example.com', displayName: 'Alex Kim', responseStatus: 'accepted' },
      { email: 'ada@example.com', displayName: 'Ada <i>L</i>', responseStatus: 'accepted' },
      { email: 'grace@example.com' },
    ]);
    expect(body.conferenceData.createRequest).toMatchObject({ requestId: booking.id, conferenceSolutionKey: { type: 'hangoutsMeet' } });
    expect(body.location).toBeUndefined();
    expect(body.extendedProperties.private.meetingBookingId).toBe(booking.id);
    expect(body.description).toContain('Booked by Ada &lt;i&gt;L&lt;/i&gt; (ada@example.com)');
    expect(body.description).toContain('Phone: +14155552671');
    expect(body.description).toContain('Guests: grace@example.com');
    expect(body.description).toContain('What would you like to talk about? Trees &lt;b&gt;and&lt;/b&gt; more');
    expect(body.description).toContain(`Reschedule or cancel: https://jimicohen.com/meeting/booking/${booking.id}?t=${manageToken(ctx, booking.id)}`);

    // The owner is preferred as organiser even though Alex is listed first.
    expect(booking.google).toEqual({
      hostId: OWNER,
      calendarId: 'primary',
      eventId: calendarEventIdFor(booking.id),
      htmlLink: 'https://calendar.google.com/calendar/event?eid=abc',
      meetUrl: MEET_LINK,
      syncedAt: NOW,
    });
    expect(booking.location).toEqual({ type: 'google_meet', label: 'Google Meet', joinUrl: MEET_LINK });
    expect(booking.timeline.map((t) => t.type)).toEqual(['created', 'calendar_synced']);
    expect(await jobsOf(ctx, (j) => j.type === 'gcal_sync')).toEqual([]);
    await ctx.settle();
  });

  it('leaves the invitee off the event when the event type says so, and writes the place for meetings without Meet', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    await editEvent(ctx, 'evt_intro', (et) => ({ ...et, googleInvite: false, locations: [{ type: 'in_person', value: '12 Garden Lane, Nairobi' }] }));
    const calls = net(ctx);
    const { booking } = await createBooking(ctx, request({ guests: ['grace@example.com'] }));

    const body = eventCalls(calls, 'POST')[0].json;
    expect(body.attendees).toEqual([]);
    expect(body.conferenceData).toBeUndefined();
    expect(body.location).toBe('12 Garden Lane, Nairobi');
    expect(body.description).toContain('Where: 12 Garden Lane, Nairobi');
    expect(booking.location.joinUrl).toBeUndefined();
    expect(booking.google?.meetUrl).toBeUndefined();
  });

  it('uses the first assigned host with a working connection when the owner has none', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await addAlex(ctx);
    await connectGoogle(ctx, ALEX, { email: 'alex.calendar@gmail.test' });
    await addEvent(ctx, { id: 'evt_joint', slug: 'joint', title: 'Joint call', kind: 'collective', hostIds: [OWNER, ALEX], durations: [30], defaultDuration: 30 });
    const calls = net(ctx);
    const { booking } = await createBooking(ctx, request({ slug: 'joint', durationMin: 30 }));
    expect(booking.google?.hostId).toBe(ALEX);
    // The owner has no Google account, so their contact address is invited.
    expect(eventCalls(calls, 'POST')[0].json.attendees[0]).toEqual({ email: 'jimi@example.com', displayName: 'Jimi Cohen', responseStatus: 'accepted' });
  });

  it('keeps the booking when Google fails, notes the problem and queues a retry that repairs it', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    let broken = true;
    const calls = net(ctx, (call) => (broken && call.url.startsWith(EVENTS_URL) ? jsonResponse({ error: { code: 503, message: 'backend error' } }, 503) : undefined));

    const { booking } = await createBooking(ctx, request());
    expect(booking.status).toBe('confirmed');
    expect(booking.google).toMatchObject({ hostId: OWNER, calendarId: 'primary', eventId: '' });
    expect(booking.google?.error).toContain('Google request failed (503');
    expect(booking.timeline.map((t) => t.type)).toContain('calendar_sync_failed');
    expect((await getBookingIndex(ctx))[0]).toMatchObject({ id: booking.id, status: 'confirmed' });

    const retries = await jobsOf(ctx, (j) => j.type === 'gcal_sync');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ bookingId: booking.id, dueAt: '2026-11-16T09:02:00.000Z' });

    // Not due yet.
    await ctx.settle();
    expect(await jobsOf(ctx, (j) => j.type === 'gcal_sync')).toHaveLength(1);

    // Still broken when the retry runs: it stays queued for later, with one timeline line for the same problem.
    ctx.clock.advance(2 * 60_000);
    expect(await runDueJobs(ctx)).toMatchObject({ processed: 1, failed: 1 });
    const again = await jobsOf(ctx, (j) => j.type === 'gcal_sync');
    expect(again).toHaveLength(1);
    expect(again[0].attempt).toBe(1);
    expect((await getBooking(ctx, booking.id))!.timeline.filter((t) => t.type === 'calendar_sync_failed')).toHaveLength(1);

    broken = false;
    ctx.clock.advance(3 * 60_000);
    expect(await runDueJobs(ctx)).toMatchObject({ processed: 1, failed: 0 });
    const repaired = (await getBooking(ctx, booking.id))!;
    expect(repaired.google).toMatchObject({ eventId: calendarEventIdFor(booking.id), meetUrl: MEET_LINK });
    expect(repaired.google?.error).toBeUndefined();
    expect(repaired.location.joinUrl).toBe(MEET_LINK);
    expect(await jobsOf(ctx, (j) => j.type === 'gcal_sync')).toEqual([]);
    expect(eventCalls(calls, 'POST').length).toBeGreaterThanOrEqual(3);
  });

  it('does not wait for a slow Google: the booking answers in time and the event arrives in the background', async () => {
    const ctx = await setup({ env: { overrides: { ...GOOGLE_ENV.overrides, ...RESEND_ENV.overrides } } });
    await useResend(ctx);
    await connectGoogle(ctx, OWNER);
    let release: (r: Response | undefined) => void = () => undefined;
    const slow = new Promise<Response | undefined>((resolve) => {
      release = resolve;
    });
    const calls = net(ctx, (call) => (call.url.startsWith(EVENTS_URL) && call.method === 'POST' ? slow : undefined));

    const { booking } = await createBooking(ctx, request(), { calendarBudgetMs: 25 });
    expect(booking.status).toBe('confirmed');
    expect(booking.google).toEqual({ hostId: OWNER, calendarId: 'primary', eventId: '', error: 'Google Calendar did not answer in time. Trying again shortly.' });
    expect(booking.timeline.map((t) => t.type)).toEqual(['created', 'calendar_sync_delayed']);
    const retries = await jobsOf(ctx, (j) => j.type === 'gcal_sync');
    expect(retries).toHaveLength(1);
    expect(retries[0].dueAt).toBe('2026-11-16T09:01:00.000Z');
    // The confirmation waits for the calendar so that it can carry the link.
    expect(emailsTo(calls, 'ada@example.com')).toEqual([]);

    release(undefined); // Google answers after all
    await ctx.settle();
    const after = (await getBooking(ctx, booking.id))!;
    expect(after.google).toMatchObject({ eventId: calendarEventIdFor(booking.id), meetUrl: MEET_LINK, syncedAt: NOW });
    expect(after.google?.error).toBeUndefined();
    expect(after.location.joinUrl).toBe(MEET_LINK);
    const confirmation = emailsTo(calls, 'ada@example.com');
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0].json.text).toContain(MEET_LINK);

    // The queued retry finds everything in order and does not create a second event.
    ctx.clock.advance(61_000);
    expect(await runDueJobs(ctx)).toMatchObject({ processed: 1, failed: 0 });
    expect(eventCalls(calls, 'POST')).toHaveLength(1);
    expect(await jobsOf(ctx, (j) => j.type === 'gcal_sync')).toEqual([]);
  });

  it('adopts the event of an attempt that never reported back instead of creating a second one', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    let lost = true;
    const calls = net(ctx, (call) => {
      if (!call.url.startsWith(EVENTS_URL) || call.method !== 'POST') return undefined;
      // First attempt: Google creates the event, but the answer never arrives. Second attempt: the id is taken.
      if (lost) return new Promise<Response>(() => undefined);
      return jsonResponse({ error: { code: 409, errors: [{ reason: 'duplicate' }] } }, 409);
    });

    const { booking } = await createBooking(ctx, request(), { calendarBudgetMs: 20 });
    expect(booking.google?.eventId).toBe('');
    lost = false;
    ctx.clock.advance(61_000);
    // The confirmation and host notice are still queued too (their runner waits for the lost attempt).
    expect(await runDueJobs(ctx, { jobTimeoutMs: 3000 })).toMatchObject({ failed: 0, remaining: 0 });
    expect(await jobsOf(ctx, (j) => j.type === 'gcal_sync')).toEqual([]);

    expect(eventCalls(calls, 'POST')).toHaveLength(2);
    expect(eventCalls(calls, 'GET')[0].url).toBe(`${EVENTS_URL}/${calendarEventIdFor(booking.id)}`);
    const after = (await getBooking(ctx, booking.id))!;
    expect(after.google).toMatchObject({ eventId: calendarEventIdFor(booking.id), meetUrl: MEET_LINK });
    expect(after.google?.error).toBeUndefined();
  });

  it('removes the event of a booking that was cancelled while its creation was still unknown', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    const calls = net(ctx, (call) => (call.url.startsWith(EVENTS_URL) && call.method === 'POST' ? new Promise<Response>(() => undefined) : undefined));
    const { booking } = await createBooking(ctx, request(), { calendarBudgetMs: 20 });

    const cancelled = await cancelBooking(ctx, booking.id, { by: 'invitee' });
    expect(cancelled.status).toBe('cancelled');
    const deletes = eventCalls(calls, 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toBe(`${EVENTS_URL}/${calendarEventIdFor(booking.id)}?sendUpdates=all`);
    expect(cancelled.google?.error).toBeUndefined();

    // The retry that was queued for the creation finds a cancelled booking with nothing left to do.
    ctx.clock.advance(61_000);
    await runDueJobs(ctx, { jobTimeoutMs: 3000 });
    expect(await jobsOf(ctx, (j) => j.type === 'gcal_sync')).toEqual([]);
    expect(eventCalls(calls, 'DELETE')).toHaveLength(1);
  });

  it('stops retrying while the host has to reconnect, and leaves the note in place', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    let revoked = false;
    net(ctx, (call) => {
      if (call.url.startsWith(EVENTS_URL)) return jsonResponse({ error: { code: 401 } }, 401);
      if (call.url === TOKEN_URL && revoked) return jsonResponse({ error: 'invalid_grant' }, 400);
      if (call.url === TOKEN_URL) {
        revoked = true;
        return undefined;
      }
      return undefined;
    });

    const { booking } = await createBooking(ctx, request());
    expect(booking.status).toBe('confirmed');
    expect(booking.google?.error).toBe('Google Calendar needs to be reconnected.');
    expect((await getHost(ctx, OWNER))?.google?.status).toBe('needs_reconnect');
    // A repair is queued as for any failure...
    expect(await jobsOf(ctx, (j) => j.type === 'gcal_sync')).toHaveLength(1);
    await ctx.settle();

    // ...but trying again cannot help until a person reconnects, so the job steps aside instead of retrying.
    ctx.clock.advance(2 * 60_000);
    expect(await runDueJobs(ctx)).toMatchObject({ processed: 1, failed: 0 });
    expect(await jobsOf(ctx, (j) => j.type === 'gcal_sync')).toEqual([]);
    expect((await getBooking(ctx, booking.id))?.google?.error).toBe('Google Calendar needs to be reconnected.');

    // After the reconnect the periodic check queues the repair again, and this time it goes through.
    await connectGoogle(ctx, OWNER);
    net(ctx);
    expect(await reconcileBookings(ctx)).toMatchObject({ requeued: 1 });
    expect(await runDueJobs(ctx)).toMatchObject({ processed: 1, failed: 0 });
    const repaired = (await getBooking(ctx, booking.id))!;
    expect(repaired.google).toMatchObject({ eventId: calendarEventIdFor(booking.id), meetUrl: MEET_LINK });
    expect(repaired.google?.error).toBeUndefined();
  });

  it('does nothing, quietly, when nobody has Google connected', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request());
    await syncBookingToCalendar(ctx, booking.id);
    await syncBookingToCalendar(ctx, 'bkg_missing');
    expect((await getBooking(ctx, booking.id))?.google).toBeNull();
    expect((await getBooking(ctx, booking.id))?.timeline.map((t) => t.type)).toEqual(['created']);
  });

  it('never rejects from syncBookingToCalendar and leaves an event that is in order alone', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    const calls = net(ctx);
    const { booking } = await createBooking(ctx, request());
    const before = calls.length;
    await syncBookingToCalendar(ctx, booking.id);
    expect(calls.length).toBe(before);

    net(ctx, () => {
      throw new Error('network down');
    });
    await updateBooking(ctx, booking.id, (b) => ({ ...b, google: { ...b.google!, error: 'earlier problem' } }));
    await expect(syncBookingToCalendar(ctx, booking.id)).resolves.toBeUndefined();
    expect((await getBooking(ctx, booking.id))?.google?.error).toBe('Google could not be reached. Please try again.');
  });
});

describe('time budget of a request', () => {
  it('gives the calendar write up to 7 seconds, less when the earlier steps were slow, and never less than one', () => {
    expect(calendarWriteBudget(0)).toBe(7000);
    expect(calendarWriteBudget(1500)).toBe(7000);
    expect(calendarWriteBudget(2000)).toBe(7000);
    expect(calendarWriteBudget(4000)).toBe(5000);
    expect(calendarWriteBudget(6200)).toBe(2800);
    expect(calendarWriteBudget(8500)).toBe(1000);
    expect(calendarWriteBudget(60_000)).toBe(1000);
    expect(calendarWriteBudget(-50)).toBe(7000);
    expect(calendarWriteBudget(NaN)).toBe(7000);
  });
});

// ───────────────────────── cancelling ─────────────────────────

describe('cancelBooking', () => {
  async function booked(env: Partial<Env> = { overrides: { ...GOOGLE_ENV.overrides, ...RESEND_ENV.overrides, ...TWILIO_ENV.overrides } }): Promise<{ ctx: TestCtx; calls: Call[]; booking: Booking }> {
    const ctx = await setup({ env });
    await useResend(ctx);
    await connectGoogle(ctx, OWNER);
    await addAlex(ctx);
    await addEvent(ctx, { id: 'evt_joint', slug: 'joint', title: 'Joint call', kind: 'collective', hostIds: [OWNER, ALEX], durations: [30], defaultDuration: 30 });
    const calls = net(ctx);
    const { booking } = await createBooking(ctx, request({ slug: 'joint', durationMin: 30, phone: '+14155552671', consent: { sms: true, call: true } }));
    await ctx.settle();
    calls.length = 0;
    return { ctx, calls, booking };
  }

  it('marks the booking, frees the time, removes the event and the reminders, and tells everyone', async () => {
    const { ctx, calls, booking } = await booked();
    expect((await listJobs(ctx)).length).toBeGreaterThan(0);
    ctx.clock.advance(HOUR);

    const cancelled = await cancelBooking(ctx, booking.id, { by: 'invitee', reason: '  Something came up\u0007  ' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellation).toEqual({ at: '2026-11-16T10:00:00.000Z', by: 'invitee', reason: 'Something came up' });
    expect(cancelled.timeline.find((t) => t.type === 'cancelled')?.detail).toBe('Cancelled by the invitee: Something came up');
    expect((await getBookingIndex(ctx))[0]).toMatchObject({ id: booking.id, status: 'cancelled', start: WED_14 });

    const deletes = eventCalls(calls, 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toBe(`${EVENTS_URL}/${calendarEventIdFor(booking.id)}?sendUpdates=all`);
    expect(cancelled.timeline.map((t) => t.type)).toContain('calendar_event_removed');

    await ctx.settle();
    expect(emailsTo(calls, 'ada@example.com').map((c) => c.json.subject)).toEqual([expect.stringMatching(/^Cancelled: Joint call/)]);
    expect(emailsTo(calls, 'jimi@example.com')).toHaveLength(1);
    expect(emailsTo(calls, 'alex@example.com')).toHaveLength(1);
    // The invitee cancelled on the page a moment ago: no text message on top of the email.
    expect(calls.filter((c) => c.url.startsWith(TWILIO_ROOT))).toEqual([]);
    // Every reminder is gone, and nothing else is waiting.
    expect(await listJobs(ctx)).toEqual([]);

    // The time can be booked again.
    expect((await createBooking(ctx, request({ slug: 'joint', durationMin: 30, email: 'grace@example.com' }))).booking.status).toBe('confirmed');
  });

  it('is idempotent: a second cancellation changes nothing and sends nothing', async () => {
    const { ctx, calls, booking } = await booked();
    const first = await cancelBooking(ctx, booking.id, { by: 'invitee', reason: 'First' });
    await ctx.settle();
    const sent = calls.length;

    ctx.clock.advance(HOUR);
    const second = await cancelBooking(ctx, booking.id, { by: 'host', reason: 'Second' });
    await ctx.settle();
    expect(second.cancellation).toEqual(first.cancellation);
    expect(second.timeline.filter((t) => t.type === 'cancelled')).toHaveLength(1);
    expect(calls.length).toBe(sent);
    expect(await listJobs(ctx)).toEqual([]);
  });

  it('does the follow-up work once when two cancellations race', async () => {
    const { ctx, calls, booking } = await booked();
    const [a, b] = await Promise.all([cancelBooking(ctx, booking.id, { by: 'invitee' }), cancelBooking(ctx, booking.id, { by: 'invitee' })]);
    await ctx.settle();
    expect(a.status).toBe('cancelled');
    expect(b.status).toBe('cancelled');
    expect(emailsTo(calls, 'ada@example.com')).toHaveLength(1);
    expect(eventCalls(calls, 'DELETE')).toHaveLength(1);
    expect((await getBooking(ctx, booking.id))!.timeline.filter((t) => t.type === 'cancelled')).toHaveLength(1);
  });

  it('does not notify the owner of a cancellation made from the dashboard, but texts the invitee', async () => {
    const { ctx, calls, booking } = await booked();
    const cancelled = await cancelBooking(ctx, booking.id, { by: 'host', reason: 'Travelling that day' });
    await ctx.settle();
    expect(cancelled.cancellation?.by).toBe('host');
    expect(emailsTo(calls, 'jimi@example.com')).toEqual([]);
    expect(emailsTo(calls, 'alex@example.com')).toHaveLength(1);
    expect(emailsTo(calls, 'ada@example.com')).toHaveLength(1);
    const texts = calls.filter((c) => c.url.startsWith(TWILIO_ROOT));
    expect(texts).toHaveLength(1);
    expect(new URLSearchParams(texts[0].body).get('Body')).toMatch(/is cancelled/);
  });

  it('respects a host who switched email notices off', async () => {
    const { ctx, calls, booking } = await booked();
    await updateHost(ctx, ALEX, (h) => ({ ...h, notify: { email: false, sms: false } }));
    await cancelBooking(ctx, booking.id, { by: 'assistant' });
    await ctx.settle();
    expect(emailsTo(calls, 'alex@example.com')).toEqual([]);
    expect(emailsTo(calls, 'jimi@example.com')).toHaveLength(1);
    expect((await getBooking(ctx, booking.id))!.cancellation?.by).toBe('assistant');
  });

  it('lets the invitee cancel until the meeting starts, the assistant until it ends, and a host at any time', async () => {
    const { ctx, booking } = await booked();
    ctx.clock.set(WED_14);
    const late = await failure(cancelBooking(ctx, booking.id, { by: 'invitee' }));
    expect(late).toMatchObject({ status: 410, code: 'too_late' });
    expect((await getBooking(ctx, booking.id))?.status).toBe('confirmed');

    ctx.clock.set('2026-11-18T14:30:00.000Z');
    expect(await failure(cancelBooking(ctx, booking.id, { by: 'assistant' }))).toMatchObject({ status: 410, code: 'too_late' });
    expect((await cancelBooking(ctx, booking.id, { by: 'host' })).status).toBe('cancelled');
    await ctx.settle();
  });

  it('answers 404 for a booking that does not exist', async () => {
    const ctx = await setup();
    expect(await failure(cancelBooking(ctx, 'bkg_missing', { by: 'invitee' }))).toMatchObject({ status: 404, code: 'not_found' });
    expect(await failure(cancelBooking(ctx, '../site', { by: 'host' }))).toMatchObject({ status: 404 });
  });

  it('cancels cleanly after the organiser disconnected Google', async () => {
    const { ctx, calls, booking } = await booked();
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: null }));
    const cancelled = await cancelBooking(ctx, booking.id, { by: 'invitee' });
    await ctx.settle();
    expect(cancelled.status).toBe('cancelled');
    expect(eventCalls(calls, 'DELETE')).toEqual([]);
    expect(cancelled.timeline.map((t) => t.type)).toContain('calendar_event_left');
    expect(cancelled.google?.error).toBeUndefined();
    expect(await jobsOf(ctx, (j) => j.type === 'gcal_sync')).toEqual([]);
    expect((await getBookingIndex(ctx))[0].status).toBe('cancelled');
  });

  it('still cancels when Google refuses to delete, and queues the clean-up', async () => {
    const { ctx, calls, booking } = await booked();
    let broken = true;
    net(ctx, (call) => {
      calls.push(call);
      return broken && call.method === 'DELETE' ? jsonResponse({ error: { code: 500 } }, 500) : undefined;
    });
    const cancelled = await cancelBooking(ctx, booking.id, { by: 'invitee' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.google?.error).toContain('Google request failed (500');
    expect((await getBookingIndex(ctx))[0].status).toBe('cancelled');
    await ctx.settle();

    broken = false;
    ctx.clock.advance(2 * 60_000);
    expect(await runDueJobs(ctx)).toMatchObject({ processed: 1, failed: 0 });
    expect((await getBooking(ctx, booking.id))?.google?.error).toBeUndefined();
    expect(eventCalls(calls, 'DELETE').length).toBeGreaterThanOrEqual(3);
  });
});

// ───────────────────────── moving a booking ─────────────────────────

describe('rescheduleBooking', () => {
  const NEW_START = '2026-11-19T10:00:00.000Z';

  it('moves the booking, the index entry, the calendar event and the reminders', async () => {
    const ctx = await setup({ env: { overrides: { ...GOOGLE_ENV.overrides, ...RESEND_ENV.overrides } } });
    await useResend(ctx);
    await connectGoogle(ctx, OWNER);
    const calls = net(ctx);
    const { booking } = await createBooking(ctx, request());
    await confirmAttendance(ctx, booking.id, 'link');
    await ctx.settle();
    calls.length = 0;
    ctx.clock.advance(HOUR);

    const moved = await rescheduleBooking(ctx, booking.id, { startIso: '2026-11-19T13:00:00+03:00', by: 'invitee', timezone: 'Africa/Nairobi' });
    expect(moved).toMatchObject({
      id: booking.id,
      status: 'confirmed',
      start: NEW_START,
      end: '2026-11-19T10:15:00.000Z',
      durationMin: 15,
      hostIds: [OWNER],
      rescheduledFromStart: WED_14,
      rescheduleCount: 1,
      attendance: {},
    });
    expect(moved.invitee.timezone).toBe('Africa/Nairobi');
    expect(moved.timeline.find((t) => t.type === 'rescheduled')).toEqual({
      at: '2026-11-16T10:00:00.000Z',
      type: 'rescheduled',
      detail: 'Moved from Wednesday, November 18, 2026 at 2:00 PM UTC by the invitee',
    });
    expect(await getBookingIndex(ctx)).toEqual([expect.objectContaining({ id: booking.id, start: NEW_START, end: '2026-11-19T10:15:00.000Z', status: 'confirmed' })]);

    const patches = eventCalls(calls, 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toBe(`${EVENTS_URL}/${calendarEventIdFor(booking.id)}?conferenceDataVersion=1&sendUpdates=all`);
    expect(patches[0].json).toEqual({ start: { dateTime: NEW_START, timeZone: 'UTC' }, end: { dateTime: '2026-11-19T10:15:00.000Z', timeZone: 'UTC' } });
    expect(eventCalls(calls, 'POST')).toEqual([]);
    // The Meet link stays.
    expect(moved.location.joinUrl).toBe(MEET_LINK);
    expect(moved.timeline.map((t) => t.type)).toContain('calendar_updated');

    await ctx.settle();
    expect(emailsTo(calls, 'ada@example.com').map((c) => c.json.subject)).toEqual([expect.stringMatching(/^New time: Intro call/)]);
    expect(emailsTo(calls, 'jimi@example.com').map((c) => c.json.subject)).toEqual([expect.stringMatching(/^Rescheduled: Ada Lovelace/)]);
    // The reminders now count back from the new start.
    expect((await listJobs(ctx)).map((j) => `${j.kind}/${j.channel}@${j.dueAt}`)).toEqual([
      'reminder/email@2026-11-18T10:00:00.000Z',
      'reminder/email@2026-11-19T09:00:00.000Z',
    ]);

    // The old time is free again, the new one is taken.
    expect(await failure(createBooking(ctx, request({ start: NEW_START, email: 'grace@example.com' })))).toMatchObject({ status: 409 });
    expect((await createBooking(ctx, request({ email: 'grace@example.com' }))).booking.start).toBe(WED_14);
    await ctx.settle();
  });

  it('treats the booking\'s own time as free, and other bookings as taken', async () => {
    const ctx = await setup();
    const mine = (await createBooking(ctx, request({ slug: 'meeting', durationMin: 60, start: '2026-11-18T13:00:00.000Z' }))).booking;
    await createBooking(ctx, request({ slug: 'meeting', durationMin: 30, start: '2026-11-18T15:00:00.000Z', email: 'grace@example.com' }));

    // Half an hour later overlaps its own old time (fine), but would end right at the other meeting, inside its own buffer.
    expect(await failure(rescheduleBooking(ctx, mine.id, { startIso: '2026-11-18T14:00:00.000Z', by: 'invitee' }))).toMatchObject({ status: 409, code: 'slot_taken' });
    expect((await getBooking(ctx, mine.id))?.start).toBe('2026-11-18T13:00:00.000Z');
    expect((await getBookingIndex(ctx)).find((e) => e.id === mine.id)?.start).toBe('2026-11-18T13:00:00.000Z');

    const moved = await rescheduleBooking(ctx, mine.id, { startIso: '2026-11-18T13:30:00.000Z', by: 'invitee' });
    expect(moved).toMatchObject({ start: '2026-11-18T13:30:00.000Z', end: '2026-11-18T14:30:00.000Z', rescheduleCount: 1 });
  });

  it('counts every move and remembers where the meeting was before the last one', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request());
    await rescheduleBooking(ctx, booking.id, { startIso: '2026-11-19T10:00:00.000Z', by: 'invitee' });
    const twice = await rescheduleBooking(ctx, booking.id, { startIso: '2026-11-20T11:00:00.000Z', by: 'host' });
    expect(twice).toMatchObject({ start: '2026-11-20T11:00:00.000Z', rescheduleCount: 2, rescheduledFromStart: '2026-11-19T10:00:00.000Z' });
    expect(twice.timeline.filter((t) => t.type === 'rescheduled').map((t) => t.detail)).toEqual([
      'Moved from Wednesday, November 18, 2026 at 2:00 PM UTC by the invitee',
      'Moved from Thursday, November 19, 2026 at 10:00 AM UTC by the host',
    ]);
    expect(await confirmedIndex(ctx)).toHaveLength(1);
  });

  it('applies the same rules as a new booking to the new time', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request());
    for (const startIso of ['2026-11-21T14:00:00.000Z', '2026-11-18T14:07:00.000Z', '2026-11-16T12:00:00.000Z', '2026-11-18T17:00:00.000Z']) {
      expect(await failure(rescheduleBooking(ctx, booking.id, { startIso, by: 'invitee' }))).toMatchObject({ status: 409, code: 'slot_taken' });
    }
    expect(await failure(rescheduleBooking(ctx, booking.id, { startIso: 'tomorrow', by: 'invitee' }))).toMatchObject({ status: 422, fields: { start: 'Please pick a time.' } });
    expect(await failure(rescheduleBooking(ctx, booking.id, { startIso: WED_14, by: 'invitee' }))).toMatchObject({ status: 422, code: 'invalid' });
    expect((await getBooking(ctx, booking.id))).toMatchObject({ start: WED_14, rescheduleCount: 0 });
  });

  it('refuses to move a cancelled booking, a meeting that has started, or one of a paused event type', async () => {
    const ctx = await setup();
    const a = (await createBooking(ctx, request())).booking;
    const b = (await createBooking(ctx, request({ start: '2026-11-18T15:00:00.000Z', email: 'grace@example.com' }))).booking;
    await cancelBooking(ctx, a.id, { by: 'invitee' });
    const cancelled = await failure(rescheduleBooking(ctx, a.id, { startIso: NEW_START, by: 'invitee' }));
    expect(cancelled).toMatchObject({ status: 410, code: 'cancelled' });
    expect(cancelled.message).toBe('This booking was cancelled, so it cannot be moved. Please book a new time.');

    expect(await failure(rescheduleBooking(ctx, 'bkg_missing', { startIso: NEW_START, by: 'invitee' }))).toMatchObject({ status: 404 });

    await editEvent(ctx, 'evt_intro', (et) => ({ ...et, active: false }));
    expect(await failure(rescheduleBooking(ctx, b.id, { startIso: NEW_START, by: 'invitee' }))).toMatchObject({ status: 410, code: 'not_available' });
    await editEvent(ctx, 'evt_intro', (et) => ({ ...et, active: true }));

    ctx.clock.set('2026-11-18T15:00:00.000Z');
    expect(await failure(rescheduleBooking(ctx, b.id, { startIso: '2026-11-19T15:00:00.000Z', by: 'invitee' }))).toMatchObject({ status: 410, code: 'too_late' });
    expect((await getBooking(ctx, b.id))?.start).toBe('2026-11-18T15:00:00.000Z');
  });

  it('keeps the host of a round robin booking and the length it was booked with', async () => {
    const ctx = await setup();
    await addAlex(ctx);
    await addEvent(ctx, { id: 'evt_team', slug: 'team', title: 'Team call', kind: 'round_robin', hostIds: [OWNER, ALEX], durations: [30, 60], defaultDuration: 30 });
    const withAlex = (await createBooking(ctx, request({ slug: 'team', durationMin: 60, start: '2026-11-18T10:00:00.000Z' }))).booking;
    expect(withAlex.hostIds).toEqual([ALEX]);
    // Alex gets something else at noon on Thursday; Jimi stays free.
    await addEvent(ctx, { id: 'evt_alex', slug: 'alex', title: 'Time with Alex', hostIds: [ALEX], durations: [30], defaultDuration: 30 });
    await createBooking(ctx, request({ slug: 'alex', durationMin: 30, start: '2026-11-19T12:00:00.000Z', email: 'grace@example.com' }));
    // The owner stops offering the 60 minute length.
    await editEvent(ctx, 'evt_team', (et) => ({ ...et, durations: [30] }));

    expect(await failure(rescheduleBooking(ctx, withAlex.id, { startIso: '2026-11-19T12:00:00.000Z', by: 'invitee' }))).toMatchObject({ status: 409, code: 'slot_taken' });
    const moved = await rescheduleBooking(ctx, withAlex.id, { startIso: '2026-11-19T14:00:00.000Z', by: 'invitee' });
    expect(moved).toMatchObject({ hostIds: [ALEX], durationMin: 60, end: '2026-11-19T15:00:00.000Z' });
  });

  it('fails closed on an unreadable calendar and keeps the booking where it was', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    const { booking } = await createBooking(ctx, request());
    await connectGoogle(ctx, OWNER, { status: 'needs_reconnect' });
    net(ctx);
    expect(await failure(rescheduleBooking(ctx, booking.id, { startIso: NEW_START, by: 'invitee' }))).toMatchObject({ status: 503, code: 'calendar_unavailable' });
    expect((await getBooking(ctx, booking.id))).toMatchObject({ start: WED_14, rescheduleCount: 0 });
    expect((await getBookingIndex(ctx))[0].start).toBe(WED_14);
    expect(await jobsOf(ctx, (j) => j.kind === 'host_alert')).toHaveLength(1);
  });

  it('ignores its own Google event when checking the host calendar', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    await editEvent(ctx, 'evt_meeting', (et) => ({ ...et, scheduling: { ...et.scheduling, bufferAfterMin: 0 } }));
    let busy: { start: string; end: string }[] = [];
    const calls = net(ctx, (call) => (call.url === FREEBUSY_URL ? jsonResponse({ calendars: { primary: { busy } } }) : undefined));
    const { booking } = await createBooking(ctx, request({ slug: 'meeting', durationMin: 60, start: '2026-11-18T13:00:00.000Z' }));
    // From now on the host calendar shows the meeting itself (13:00 to 14:00), plus something real later on.
    busy = [
      { start: '2026-11-18T13:00:00Z', end: '2026-11-18T14:00:00Z' },
      { start: '2026-11-18T15:00:00Z', end: '2026-11-18T16:00:00Z' },
    ];
    expect(await failure(rescheduleBooking(ctx, booking.id, { startIso: '2026-11-18T14:30:00.000Z', by: 'invitee' }))).toMatchObject({ status: 409, code: 'slot_taken' });

    const moved = await rescheduleBooking(ctx, booking.id, { startIso: '2026-11-18T13:30:00.000Z', by: 'invitee' });
    expect(moved.start).toBe('2026-11-18T13:30:00.000Z');
    expect(eventCalls(calls, 'PATCH')).toHaveLength(1);
  });

  it('moves cleanly after the organiser disconnected Google', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    const calls = net(ctx);
    const { booking } = await createBooking(ctx, request());
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: null }));
    calls.length = 0;

    const moved = await rescheduleBooking(ctx, booking.id, { startIso: NEW_START, by: 'invitee' });
    expect(moved.start).toBe(NEW_START);
    expect(calls.filter((c) => c.url.startsWith(EVENTS_URL))).toEqual([]);
    expect(moved.timeline.map((t) => t.type)).toContain('calendar_not_updated');
    expect(moved.google?.error).toBeUndefined();
    expect(await jobsOf(ctx, (j) => j.type === 'gcal_sync')).toEqual([]);
  });

  it('keeps the move when Google cannot be told, and repairs the event later', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    let broken = false;
    const calls = net(ctx, (call) => (broken && call.method === 'PATCH' ? jsonResponse({ error: { code: 500 } }, 500) : undefined));
    const { booking } = await createBooking(ctx, request());
    broken = true;

    const moved = await rescheduleBooking(ctx, booking.id, { startIso: NEW_START, by: 'invitee' });
    expect(moved.start).toBe(NEW_START);
    expect(moved.google?.error).toContain('Google request failed (500');
    expect(moved.google?.eventId).toBe(calendarEventIdFor(booking.id));
    await ctx.settle();

    broken = false;
    ctx.clock.advance(2 * 60_000);
    await runDueJobs(ctx);
    expect((await getBooking(ctx, booking.id))?.google?.error).toBeUndefined();
    const last = eventCalls(calls, 'PATCH').at(-1);
    expect(last?.json.start.dateTime).toBe(NEW_START);
  });

  it('lets only one of two simultaneous moves of the same booking through', async () => {
    const kv = racingKV(2);
    const ctx = await setup({ kv });
    const { booking } = await createBooking(ctx, request());
    kv.arm();
    const results = await Promise.allSettled([
      rescheduleBooking(ctx, booking.id, { startIso: '2026-11-19T10:00:00.000Z', by: 'invitee' }),
      rescheduleBooking(ctx, booking.id, { startIso: '2026-11-19T15:00:00.000Z', by: 'invitee' }),
    ]);
    const won = results.filter((r): r is PromiseFulfilledResult<Booking> => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    expect(results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason).toMatchObject({ status: 409, code: 'changed' });
    const stored = (await getBooking(ctx, booking.id))!;
    expect(stored.start).toBe(won[0].value.start);
    expect(stored.rescheduleCount).toBe(1);
    expect((await getBookingIndex(ctx))[0].start).toBe(stored.start);
  });

  it('never lets a move and a new booking land on the same time', async () => {
    const kv = racingKV(2);
    const ctx = await setup({ kv });
    const { booking } = await createBooking(ctx, request());
    kv.arm();
    const results = await Promise.allSettled([
      rescheduleBooking(ctx, booking.id, { startIso: NEW_START, by: 'invitee' }),
      createBooking(makeTestCtx({ kv, now: NOW, ip: '198.51.100.2' }), request({ start: NEW_START, email: 'grace@example.com' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const index = await confirmedIndex(ctx);
    expect(index.filter((e) => e.start === NEW_START)).toHaveLength(1);
  });

  it('gives way to a cancellation that lands in the middle of a move', async () => {
    const inner = memoryKV();
    let cancelNow: (() => Promise<void>) | null = null;
    const kv: KV = {
      ...inner,
      async setJSON(key, value, opts) {
        const result = await inner.setJSON(key, value, opts);
        // Right after the move has taken its new time in the index, the cancellation arrives.
        if (key === 'index/bookings' && result.modified && cancelNow) {
          const run = cancelNow;
          cancelNow = null;
          await run();
        }
        return result;
      },
    };
    const ctx = await setup({ kv });
    const { booking } = await createBooking(ctx, request());
    cancelNow = async () => {
      await cancelBooking(ctx, booking.id, { by: 'invitee' });
    };

    expect(await failure(rescheduleBooking(ctx, booking.id, { startIso: NEW_START, by: 'invitee' }))).toMatchObject({ status: 410, code: 'cancelled' });
    const stored = (await getBooking(ctx, booking.id))!;
    expect(stored).toMatchObject({ status: 'cancelled', start: WED_14, rescheduleCount: 0 });
    expect(await getBookingIndex(ctx)).toEqual([expect.objectContaining({ id: booking.id, status: 'cancelled', start: WED_14 })]);
    // Both times are open again.
    expect((await createBooking(ctx, request({ start: NEW_START, email: 'grace@example.com' }))).booking.status).toBe('confirmed');
    expect((await createBooking(ctx, request({ email: 'alan@example.com' }))).booking.status).toBe('confirmed');
  });
});

// ───────────────────────── attendance ─────────────────────────

describe('confirmAttendance', () => {
  it('records how and when the invitee confirmed, once', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request());
    ctx.clock.advance(HOUR);
    const confirmed = await confirmAttendance(ctx, booking.id, 'sms');
    expect(confirmed.attendance).toEqual({ confirmedAt: '2026-11-16T10:00:00.000Z', confirmedVia: 'sms' });
    expect(confirmed.timeline.at(-1)).toEqual({ at: '2026-11-16T10:00:00.000Z', type: 'attendance_confirmed', detail: 'Confirmed by text message' });

    ctx.clock.advance(HOUR);
    const again = await confirmAttendance(ctx, booking.id, 'call');
    expect(again.attendance).toEqual({ confirmedAt: '2026-11-16T10:00:00.000Z', confirmedVia: 'sms' });
    expect(again.timeline.filter((t) => t.type === 'attendance_confirmed')).toHaveLength(1);
    expect((await toPublicBooking(ctx, again)).attendanceConfirmed).toBe(true);
  });

  it('names each way of confirming', async () => {
    const ctx = await setup();
    const a = (await createBooking(ctx, request())).booking;
    const b = (await createBooking(ctx, request({ start: '2026-11-18T15:00:00.000Z', email: 'grace@example.com' }))).booking;
    expect((await confirmAttendance(ctx, a.id, 'call')).timeline.at(-1)?.detail).toBe('Confirmed on the reminder call');
    expect((await confirmAttendance(ctx, b.id, 'link')).timeline.at(-1)?.detail).toBe('Confirmed from the booking page');
  });

  it('keeps a no-show mark that was set separately', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request());
    await updateBooking(ctx, booking.id, (b) => ({ ...b, attendance: { noShow: false } }));
    expect((await confirmAttendance(ctx, booking.id, 'link')).attendance).toMatchObject({ noShow: false, confirmedVia: 'link' });
  });

  it('refuses for a cancelled booking, a finished meeting and an unknown booking', async () => {
    const ctx = await setup();
    const a = (await createBooking(ctx, request())).booking;
    const b = (await createBooking(ctx, request({ start: '2026-11-18T15:00:00.000Z', email: 'grace@example.com' }))).booking;
    await cancelBooking(ctx, a.id, { by: 'invitee' });
    expect(await failure(confirmAttendance(ctx, a.id, 'link'))).toMatchObject({ status: 410, code: 'cancelled' });
    expect(await failure(confirmAttendance(ctx, 'bkg_missing', 'link'))).toMatchObject({ status: 404 });

    // During the meeting it still counts ("running late, but coming"); afterwards it does not.
    ctx.clock.set('2026-11-18T15:05:00.000Z');
    expect((await confirmAttendance(ctx, b.id, 'link')).attendance.confirmedVia).toBe('link');
    const c = await updateBooking(ctx, b.id, (x) => ({ ...x, attendance: {} }));
    ctx.clock.set('2026-11-18T15:15:00.000Z');
    expect(await failure(confirmAttendance(ctx, c!.id, 'link'))).toMatchObject({ status: 410, code: 'too_late' });
  });
});

// ───────────────────────── available times ─────────────────────────

describe('getSlots', () => {
  const day = (date: string): { fromMs: number; toMs: number } => ({ fromMs: Date.parse(`${date}T00:00:00Z`), toMs: Date.parse(`${date}T00:00:00Z`) + DAY });

  it('lists the bookable start times in order, with the length and the host zone', async () => {
    const ctx = await setup();
    await updateHost(ctx, OWNER, (h) => ({ ...h, timezone: 'Europe/London' }));
    const res = await getSlots(ctx, { slug: 'INTRO', durationMin: 15, ...day('2026-11-16') });
    // Four hours of notice from 09:00, then every quarter of an hour until the last one that ends by 17:00.
    expect(res.durationMin).toBe(15);
    expect(res.hostTimezone).toBe('Europe/London');
    expect(res.unavailableReason).toBeUndefined();
    expect(res.slots).toHaveLength(16);
    expect(res.slots[0]).toEqual({ start: '2026-11-16T13:00:00.000Z' });
    expect(res.slots.at(-1)).toEqual({ start: '2026-11-16T16:45:00.000Z' });
    const starts = res.slots.map((s) => s.start);
    expect([...starts].sort()).toEqual(starts);
  });

  it('leaves out what is taken, buffers included', async () => {
    const ctx = await setup();
    await createBooking(ctx, request({ slug: 'meeting', durationMin: 30 }));
    const starts = (await getSlots(ctx, { slug: 'intro', durationMin: 15, ...day('2026-11-18') })).slots.map((s) => s.start.slice(11, 16));
    expect(starts).toContain('13:30');
    expect(starts).not.toContain('13:45');
    expect(starts).not.toContain('14:00');
    expect(starts).not.toContain('14:30');
    expect(starts).toContain('14:45');
  });

  it('never looks further than 62 days from the start of the range', async () => {
    const ctx = await setup();
    await addEvent(ctx, { id: 'evt_far', slug: 'far', title: 'Far ahead', durations: [60], defaultDuration: 60, scheduling: { minNoticeMinutes: 0, maxDaysAhead: 365, dateRange: null, bufferBeforeMin: 0, bufferAfterMin: 0, slotIncrementMin: 60, maxPerDay: null, scheduleIds: {}, restrictHours: null } });
    const from = Date.parse('2026-12-01T00:00:00Z');
    const res = await getSlots(ctx, { slug: 'far', durationMin: 60, fromMs: from, toMs: from + 300 * DAY });
    expect(res.slots.length).toBeGreaterThan(300);
    expect(Date.parse(res.slots.at(-1)!.start)).toBeLessThan(from + 62 * DAY);
    expect(Date.parse(res.slots.at(-1)!.start)).toBeGreaterThan(from + 58 * DAY);
  });

  it('returns nothing for an empty or backwards range, and for a range in the past', async () => {
    const ctx = await setup();
    const from = Date.parse('2026-11-18T00:00:00Z');
    expect((await getSlots(ctx, { slug: 'intro', durationMin: 15, fromMs: from, toMs: from })).slots).toEqual([]);
    expect((await getSlots(ctx, { slug: 'intro', durationMin: 15, fromMs: from, toMs: from - DAY })).slots).toEqual([]);
    expect((await getSlots(ctx, { slug: 'intro', durationMin: 15, ...day('2026-11-10') })).slots).toEqual([]);
  });

  it('says why when no times can be shown: a paused event type or an unreadable calendar', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await addEvent(ctx, { id: 'evt_paused', slug: 'paused', title: 'Paused', active: false });
    expect(await getSlots(ctx, { slug: 'paused', durationMin: 30, ...day('2026-11-18') })).toEqual({ slots: [], durationMin: 30, hostTimezone: 'UTC', unavailableReason: 'inactive' });

    await connectGoogle(ctx, OWNER);
    net(ctx, (call) => (call.url === FREEBUSY_URL ? jsonResponse({ calendars: { primary: { errors: [{ domain: 'global', reason: 'notFound' }] } } }) : undefined));
    expect(await getSlots(ctx, { slug: 'intro', durationMin: 15, ...day('2026-11-18') })).toEqual({ slots: [], durationMin: 15, hostTimezone: 'UTC', unavailableReason: 'calendar_error' });
    // Browsing does not email the owner; the periodic check and real booking attempts do.
    expect(await jobsOf(ctx, (j) => j.kind === 'host_alert')).toEqual([]);
  });

  it('refuses an unknown meeting type, an unknown length and a range that is not a time', async () => {
    const ctx = await setup();
    expect(await failure(getSlots(ctx, { slug: 'nope', durationMin: 15, ...day('2026-11-18') }))).toMatchObject({ status: 404, code: 'not_found' });
    expect(await failure(getSlots(ctx, { slug: 'intro', durationMin: 20, ...day('2026-11-18') }))).toMatchObject({ status: 422, fields: { duration: expect.any(String) } });
    expect(await failure(getSlots(ctx, { slug: 'intro', durationMin: 15, fromMs: NaN, toMs: 5 }))).toMatchObject({ status: 422, fields: { from: expect.any(String) } });
  });

  it('subtracts the host calendar and reuses the answer for a minute', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await connectGoogle(ctx, OWNER);
    const calls = net(ctx, (call) =>
      call.url === FREEBUSY_URL ? jsonResponse({ calendars: { primary: { busy: [{ start: '2026-11-18T09:00:00Z', end: '2026-11-18T16:00:00Z' }] } } }) : undefined,
    );
    const first = await getSlots(ctx, { slug: 'intro', durationMin: 15, ...day('2026-11-18') });
    expect(first.slots.map((s) => s.start.slice(11, 16))).toEqual(['16:00', '16:15', '16:30', '16:45']);

    // Another visitor in another zone asks for a slightly different range: the calendar is asked in whole
    // days, so both share one answer and Google is not asked again.
    ctx.clock.advance(20_000);
    await getSlots(ctx, { slug: 'intro', durationMin: 15, fromMs: Date.parse('2026-11-17T22:00:00Z'), toMs: Date.parse('2026-11-19T10:00:00Z') });
    expect(calls.filter((c) => c.url === FREEBUSY_URL)).toHaveLength(1);
    expect(calls.filter((c) => c.url === FREEBUSY_URL)[0].json).toMatchObject({ timeMin: '2026-11-17T00:00:00.000Z', timeMax: '2026-11-20T00:00:00.000Z' });

    ctx.clock.advance(61_000);
    await getSlots(ctx, { slug: 'intro', durationMin: 15, ...day('2026-11-18') });
    expect(calls.filter((c) => c.url === FREEBUSY_URL)).toHaveLength(2);
  });

  it('shows only times every host of a collective event is free, and any free host for a round robin', async () => {
    const ctx = await setup();
    const alex = await addAlex(ctx);
    await saveHost(ctx, { ...alex, schedules: [{ ...alex.schedules[0], weekly: { ...alex.schedules[0].weekly, 3: [{ start: '12:00', end: '14:00' }] } }] });
    const scheduling = { minNoticeMinutes: 0, maxDaysAhead: 60, dateRange: null, bufferBeforeMin: 0, bufferAfterMin: 0, slotIncrementMin: 60, maxPerDay: null, scheduleIds: {}, restrictHours: null };
    await addEvent(ctx, { id: 'evt_joint', slug: 'joint', title: 'Joint', kind: 'collective', hostIds: [OWNER, ALEX], durations: [60], defaultDuration: 60, scheduling });
    await addEvent(ctx, { id: 'evt_team', slug: 'team', title: 'Team', kind: 'round_robin', hostIds: [OWNER, ALEX], durations: [60], defaultDuration: 60, scheduling });

    const joint = await getSlots(ctx, { slug: 'joint', durationMin: 60, ...day('2026-11-18') });
    expect(joint.slots.map((s) => s.start.slice(11, 16))).toEqual(['12:00', '13:00']);
    const team = await getSlots(ctx, { slug: 'team', durationMin: 60, ...day('2026-11-18') });
    expect(team.slots).toHaveLength(8);
  });

  it('keeps offering a round robin through the hosts whose calendars can be read', async () => {
    const ctx = await setup({ env: GOOGLE_ENV });
    await addAlex(ctx);
    await connectGoogle(ctx, ALEX, { status: 'needs_reconnect' });
    await addEvent(ctx, { id: 'evt_team', slug: 'team', title: 'Team', kind: 'round_robin', hostIds: [OWNER, ALEX], durations: [30], defaultDuration: 30 });
    await addEvent(ctx, { id: 'evt_joint', slug: 'joint', title: 'Joint', kind: 'collective', hostIds: [OWNER, ALEX], durations: [30], defaultDuration: 30 });
    net(ctx);
    const team = await getSlots(ctx, { slug: 'team', durationMin: 30, ...day('2026-11-18') });
    expect(team.unavailableReason).toBeUndefined();
    expect(team.slots.length).toBeGreaterThan(0);
    expect((await getSlots(ctx, { slug: 'joint', durationMin: 30, ...day('2026-11-18') })).unavailableReason).toBe('calendar_error');
  });

  it('offers a booking its own time again while it is being moved, and only then', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request());
    const normal = (await getSlots(ctx, { slug: 'intro', durationMin: 15, ...day('2026-11-18') })).slots.map((s) => s.start);
    expect(normal).not.toContain(WED_14);
    expect(normal).not.toContain('2026-11-18T13:45:00.000Z');

    const moving = (await getSlots(ctx, { slug: 'intro', durationMin: 15, ...day('2026-11-18'), rescheduleBookingId: booking.id })).slots.map((s) => s.start);
    expect(moving).toContain(WED_14);
    expect(moving).toContain('2026-11-18T13:45:00.000Z');

    // A booking of another event type, a cancelled one or an unknown id changes nothing.
    const other = (await createBooking(ctx, request({ slug: 'meeting', durationMin: 30, start: '2026-11-18T10:00:00.000Z', email: 'grace@example.com' }))).booking;
    const withOther = (await getSlots(ctx, { slug: 'intro', durationMin: 15, ...day('2026-11-18'), rescheduleBookingId: other.id })).slots.map((s) => s.start);
    expect(withOther).not.toContain(WED_14);
    expect((await getSlots(ctx, { slug: 'intro', durationMin: 15, ...day('2026-11-18'), rescheduleBookingId: 'bkg_missing' })).slots.map((s) => s.start)).not.toContain(WED_14);
    await cancelBooking(ctx, booking.id, { by: 'invitee' });
    expect((await getSlots(ctx, { slug: 'intro', durationMin: 15, ...day('2026-11-18'), rescheduleBookingId: booking.id })).slots.map((s) => s.start)).toContain(WED_14);
  });

  it('shows a round robin booking the times of its own host, at the length it was booked with', async () => {
    const ctx = await setup();
    await addAlex(ctx);
    await addEvent(ctx, { id: 'evt_team', slug: 'team', title: 'Team call', kind: 'round_robin', hostIds: [OWNER, ALEX], durations: [30, 60], defaultDuration: 30 });
    await addEvent(ctx, { id: 'evt_alex', slug: 'alex', title: 'Time with Alex', hostIds: [ALEX], durations: [30], defaultDuration: 30 });
    const withAlex = (await createBooking(ctx, request({ slug: 'team', durationMin: 60, start: '2026-11-18T10:00:00.000Z' }))).booking;
    await createBooking(ctx, request({ slug: 'alex', durationMin: 30, start: '2026-11-19T12:00:00.000Z', email: 'grace@example.com' }));
    await editEvent(ctx, 'evt_team', (et) => ({ ...et, durations: [30] }));

    const anyone = (await getSlots(ctx, { slug: 'team', durationMin: 30, ...day('2026-11-19') })).slots.map((s) => s.start);
    expect(anyone).toContain('2026-11-19T12:00:00.000Z');
    const moving = (await getSlots(ctx, { slug: 'team', durationMin: 60, ...day('2026-11-19'), rescheduleBookingId: withAlex.id })).slots.map((s) => s.start);
    expect(moving).not.toContain('2026-11-19T12:00:00.000Z');
    expect(moving).toContain('2026-11-19T14:00:00.000Z');
    // Without the booking, the retired length is refused.
    expect(await failure(getSlots(ctx, { slug: 'team', durationMin: 60, ...day('2026-11-19') }))).toMatchObject({ status: 422 });
  });

  it('agrees with createBooking: every time it lists can be booked, and no other', async () => {
    const ctx = await setup();
    await createBooking(ctx, request({ slug: 'meeting', durationMin: 45, start: '2026-11-18T11:00:00.000Z' }));
    const listed = new Set((await getSlots(ctx, { slug: 'intro', durationMin: 15, ...day('2026-11-18') })).slots.map((s) => s.start));
    let n = 0;
    for (let ms = Date.parse('2026-11-18T10:00:00Z'); ms < Date.parse('2026-11-18T13:00:00Z'); ms += 15 * 60_000) {
      const start = new Date(ms).toISOString();
      const probe = makeTestCtx({ kv: await copyKV(ctx.kv), now: NOW, ip: `198.51.100.${++n}` });
      const outcome = await createBooking(probe, request({ start, email: `p${n}@example.com` })).then(
        () => true,
        () => false,
      );
      expect(outcome, start).toBe(listed.has(start));
    }
  });
});

/** A private copy of a store, so a probe booking does not change what the next probe sees. */
async function copyKV(source: KV): Promise<KV> {
  const copy = memoryKV();
  for (const key of await source.list('')) {
    const value = await source.getJSON<unknown>(key);
    if (value !== null) await copy.setJSON(key, value);
  }
  return copy;
}

// ───────────────────────── healing interrupted requests ─────────────────────────

describe('reconcileBookings', () => {
  const phantom: BookingIndexEntry = {
    id: 'bkg_phantomphantom00',
    start: '2026-11-19T10:00:00.000Z',
    end: '2026-11-19T10:15:00.000Z',
    hostIds: [OWNER],
    eventTypeId: 'evt_intro',
    status: 'confirmed',
    inviteeName: 'Nobody',
    inviteeEmail: 'nobody@example.com',
    eventTitle: 'Intro call',
  };

  it('removes an index entry that never got its booking record, but only after seeing it twice', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request());
    await mutateBookingIndex(ctx, (entries) => [...entries, phantom]);
    expect(await failure(createBooking(ctx, request({ start: phantom.start, email: 'grace@example.com' })))).toMatchObject({ status: 409 });

    expect(await reconcileBookings(ctx)).toEqual({ checked: 2, removed: 0, freed: 0, moved: 0, requeued: 0 });
    expect(await getBookingIndex(ctx)).toHaveLength(2);
    ctx.clock.advance(30 * 60_000);
    expect(await reconcileBookings(ctx)).toMatchObject({ checked: 2, removed: 1 });
    expect((await getBookingIndex(ctx)).map((e) => e.id)).toEqual([booking.id]);
    expect((await createBooking(ctx, request({ start: phantom.start, email: 'grace@example.com' }))).booking.status).toBe('confirmed');
  });

  it('leaves a request that was merely still in flight alone', async () => {
    const ctx = await setup();
    await mutateBookingIndex(ctx, (entries) => [...entries, phantom]);
    await reconcileBookings(ctx);
    // The record arrives after all.
    const { booking } = await createBooking(ctx, request());
    await ctx.kv.setJSON(`bookings/${phantom.id}`, { ...booking, id: phantom.id, start: phantom.start, end: phantom.end });
    ctx.clock.advance(30 * 60_000);
    expect(await reconcileBookings(ctx)).toMatchObject({ removed: 0 });
    expect(await getBookingIndex(ctx)).toHaveLength(2);
  });

  it('gives the time back when a cancellation was recorded but the index was not updated', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request());
    // What a crash between the two writes of cancelBooking leaves behind.
    await updateBooking(ctx, booking.id, (b) => ({ ...b, status: 'cancelled', cancellation: { at: NOW, by: 'invitee' } }));
    expect(await failure(createBooking(ctx, request({ email: 'grace@example.com' })))).toMatchObject({ status: 409 });

    expect(await reconcileBookings(ctx)).toMatchObject({ freed: 1 });
    expect((await getBookingIndex(ctx))[0].status).toBe('cancelled');
    expect((await createBooking(ctx, request({ email: 'grace@example.com' }))).booking.status).toBe('confirmed');
  });

  it('finishes a move whose booking record was never written, and tells people about the new time', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request());
    await confirmAttendance(ctx, booking.id, 'link');
    await ctx.settle();
    // What a crash between the two writes of rescheduleBooking leaves behind: the index moved, the record did not.
    await mutateBookingIndex(ctx, (entries) => entries.map((e) => (e.id === booking.id ? { ...e, start: '2026-11-19T10:00:00.000Z', end: '2026-11-19T10:15:00.000Z' } : e)));
    // Meanwhile nothing can be double booked: the new time is protected, and the old one is simply free.
    expect(await failure(createBooking(ctx, request({ start: '2026-11-19T10:00:00.000Z', email: 'grace@example.com' })))).toMatchObject({ status: 409 });

    expect(await reconcileBookings(ctx)).toMatchObject({ moved: 0 });
    expect((await getBooking(ctx, booking.id))?.start).toBe(WED_14);
    ctx.clock.advance(30 * 60_000);
    expect(await reconcileBookings(ctx)).toMatchObject({ moved: 1 });

    const healed = (await getBooking(ctx, booking.id))!;
    expect(healed).toMatchObject({ start: '2026-11-19T10:00:00.000Z', end: '2026-11-19T10:15:00.000Z', rescheduledFromStart: WED_14, rescheduleCount: 1, attendance: {} });
    expect(healed.timeline.at(-1)?.type).toBe('rescheduled');
    const kinds = (await listJobs(ctx)).map((j) => `${j.kind}/${j.audience}`);
    expect(kinds).toContain('rescheduled/invitee');
    expect(kinds).toContain('rescheduled/host');
    expect((await listJobs(ctx)).filter((j) => j.kind === 'reminder').map((j) => j.dueAt)).toEqual(['2026-11-18T10:00:00.000Z', '2026-11-19T09:00:00.000Z']);

    // A third run finds nothing left to do.
    ctx.clock.advance(30 * 60_000);
    expect(await reconcileBookings(ctx)).toEqual({ checked: 1, removed: 0, freed: 0, moved: 0, requeued: 0 });
  });

  it('lets the invitee simply try the move again while it waits to be healed', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request());
    await mutateBookingIndex(ctx, (entries) => entries.map((e) => (e.id === booking.id ? { ...e, start: '2026-11-19T10:00:00.000Z', end: '2026-11-19T10:15:00.000Z' } : e)));
    const moved = await rescheduleBooking(ctx, booking.id, { startIso: '2026-11-19T11:00:00.000Z', by: 'invitee' });
    expect(moved).toMatchObject({ start: '2026-11-19T11:00:00.000Z', rescheduledFromStart: WED_14, rescheduleCount: 1 });
    expect((await getBookingIndex(ctx))[0].start).toBe('2026-11-19T11:00:00.000Z');
    expect(await reconcileBookings(ctx)).toEqual({ checked: 1, removed: 0, freed: 0, moved: 0, requeued: 0 });
  });

  it('queues a calendar repair for a booking that still carries a calendar problem, at most every two hours', async () => {
    const ctx = await setup();
    const { booking } = await createBooking(ctx, request());
    await updateBooking(ctx, booking.id, (b) => ({ ...b, google: { hostId: OWNER, calendarId: 'primary', eventId: 'evt1', error: 'Google Calendar needs to be reconnected.' } }));

    expect(await reconcileBookings(ctx)).toMatchObject({ requeued: 1 });
    expect(await jobsOf(ctx, (j) => j.type === 'gcal_sync')).toHaveLength(1);
    ctx.clock.advance(30 * 60_000);
    expect(await reconcileBookings(ctx)).toMatchObject({ requeued: 0 });
    ctx.clock.advance(2 * HOUR);
    expect(await reconcileBookings(ctx)).toMatchObject({ requeued: 1 });
    expect(await jobsOf(ctx, (j) => j.type === 'gcal_sync')).toHaveLength(2);
  });

  it('ignores past and cancelled entries', async () => {
    const ctx = await setup();
    const a = (await createBooking(ctx, request())).booking;
    await createBooking(ctx, request({ start: '2026-11-18T15:00:00.000Z', email: 'grace@example.com' }));
    await cancelBooking(ctx, a.id, { by: 'invitee' });
    expect((await reconcileBookings(ctx)).checked).toBe(1);
    ctx.clock.set('2026-11-20T00:00:00.000Z');
    expect((await reconcileBookings(ctx)).checked).toBe(0);
  });
});
