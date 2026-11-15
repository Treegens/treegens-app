import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newEventType } from '../../shared/defaults';
import type { Booking, EventType, Host, Job, ReminderRule } from '../../shared/types';
import { hmacHex } from '../../server/lib/crypto';
import type { KV } from '../../server/lib/ctx';
import { memoryKV } from '../../server/lib/store';
import {
  claim,
  deleteEventType,
  indexEntryOf,
  mutateBookingIndex,
  getBooking,
  getSite,
  listJobs,
  putJob,
  saveBooking,
  saveEventType,
  saveHost,
  saveSecrets,
  saveSite,
  updateHost,
} from '../../server/lib/repo';
import * as repo from '../../server/lib/repo';
import { makeTestCtx, TEST_BASE_URL, TEST_NOW, type TestCtx } from '../helpers/ctx';

// Modules owned by other engineers are replaced by stand-ins: a formatter with the documented
// output, and spies for text messages, calls and Gmail.
vi.mock('../../server/lib/time', async () => {
  const { DateTime } = await import('luxon');
  const FORMATS: Record<string, Intl.DateTimeFormatOptions> = {
    full: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' },
    date: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
    time: { hour: 'numeric', minute: '2-digit' },
    short: { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    spoken: { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  };
  return {
    formatInZone: (ms: number, tz: string, style: string, locale = 'en-US') =>
      DateTime.fromMillis(ms, { zone: tz })
        .setLocale(locale)
        .toLocaleString(FORMATS[style])
        .replace(/[\u00A0\u2009\u202F]/g, ' '),
  };
});
vi.mock('../../server/lib/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../server/lib/voice', () => ({ startReminderCall: vi.fn() }));
vi.mock('../../server/lib/google', () => ({ gmailSendRaw: vi.fn() }));

import {
  cancelBookingJobs,
  composeSms,
  deliverMessage,
  enqueueJob,
  insideCallHours,
  planBookingJobs,
  planCallTime,
  planMissedReminderCalls,
  registerJobHandler,
  removeReminderJobs,
  replanBookingReminders,
  replanReminderCalls,
  runDueJobs,
  scheduleBookingJobs,
  SMS_MAX_LENGTH,
  type StoredJob,
} from '../../server/lib/jobs';
import { sendSms } from '../../server/lib/sms';
import { startReminderCall } from '../../server/lib/voice';

const smsSpy = vi.mocked(sendSms);
const callSpy = vi.mocked(startReminderCall);

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = '2026-11-17T20:30:00.000Z'; // 35.5 hours after TEST_NOW
const END = '2026-11-17T21:00:00.000Z';
const START_MS = Date.parse(START);
const MEET = 'https://meet.google.com/abc-defg-hij';

interface Sent {
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  attachments?: { filename: string; content: string; content_type: string }[];
  idempotencyKey?: string;
}

interface World {
  ctx: TestCtx;
  /** every email handed to the (fake) provider, including ones it rejected */
  emails: Sent[];
  /** set to make the provider answer with an error */
  failEmail: (sent: Sent, attempt: number) => boolean;
  eventType: EventType;
}

const DEFAULT_RULES: ReminderRule[] = [
  { id: 'rem_email_24h', enabled: true, channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 1440 },
  { id: 'rem_call_2h', enabled: true, channel: 'call', audience: 'invitee', trigger: 'before_start', offsetMinutes: 120 },
  { id: 'rem_email_1h', enabled: true, channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 60 },
  { id: 'rem_sms_15m', enabled: true, channel: 'sms', audience: 'invitee', trigger: 'before_start', offsetMinutes: 15 },
];

async function makeWorld(opts: { now?: string; rules?: ReminderRule[]; googleInvite?: boolean; kv?: KV } = {}): Promise<World> {
  const world = { emails: [] as Sent[], failEmail: () => false } as unknown as World;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input) !== 'https://api.resend.com/emails') throw new Error(`unexpected request to ${String(input)}`);
    const sent: Sent = { ...JSON.parse(String(init.body)), idempotencyKey: (init.headers as Record<string, string>)['Idempotency-Key'] };
    world.emails.push(sent);
    if (world.failEmail(sent, world.emails.length)) return Response.json({ message: 'provider is down' }, { status: 500 });
    return Response.json({ id: `email_${world.emails.length}` });
  }) as typeof fetch;

  const ctx = makeTestCtx({ now: opts.now ?? TEST_NOW, fetch: fetchImpl, kv: opts.kv });
  const site = await getSite(ctx);
  await saveSite(ctx, { ...site, email: { provider: 'auto', fromName: 'Jimi Cohen', fromEmail: 'meet@jimicohen.com', replyTo: '' } });
  await saveSecrets(ctx, { resend: { apiKey: 're_test' } });
  await updateHost(ctx, 'host_owner', (h) => ({ ...h, email: 'jimi@example.com', timezone: 'America/New_York' }));
  const owner = (await updateHost(ctx, 'host_owner', (h) => h)) as Host;
  await saveHost(ctx, {
    ...owner,
    id: 'host_alex',
    role: 'member',
    name: 'Alex Mwangi',
    email: 'alex@example.com',
    phone: '+447700900123',
    timezone: 'Europe/London',
    notify: { email: true, sms: false },
  });
  world.eventType = await saveEventType(
    ctx,
    newEventType(TEST_NOW, {
      id: 'evt_intro',
      slug: 'intro',
      title: 'Intro call',
      reminders: opts.rules ?? DEFAULT_RULES,
      googleInvite: opts.googleInvite ?? true,
    }),
  );
  world.ctx = ctx;
  return world;
}

function makeBooking(over: Partial<Booking> = {}): Booking {
  return {
    id: 'bkg_test1',
    eventTypeId: 'evt_intro',
    eventSlug: 'intro',
    eventTitle: 'Intro call',
    kind: 'solo',
    hostIds: ['host_owner'],
    start: START,
    end: END,
    durationMin: 30,
    status: 'confirmed',
    invitee: { name: 'Sam Rivera', email: 'sam@example.com', phone: '+254700000001', timezone: 'Africa/Nairobi', locale: 'en-US' },
    guests: [],
    answers: [{ questionId: 'q_topic', label: 'What would you like to talk about?', value: 'Trees & <b>bees</b>' }],
    location: { type: 'google_meet', label: 'Google Meet', joinUrl: MEET },
    consent: { sms: true, call: true, at: TEST_NOW, text: 'consent text' },
    google: null,
    attendance: {},
    cancellation: null,
    rescheduledFromStart: null,
    rescheduleCount: 0,
    source: 'page',
    timeline: [{ at: TEST_NOW, type: 'created' }],
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...over,
  };
}

async function book(world: World, over: Partial<Booking> = {}, immediate: 'created' | 'rescheduled' | null = 'created'): Promise<Booking> {
  const booking = await saveBooking(world.ctx, makeBooking(over));
  await scheduleBookingJobs(world.ctx, booking, world.eventType, immediate);
  return booking;
}

/** "kind/channel/audience[/host] @ due" for every queued job, in queue order. */
async function queue(ctx: TestCtx): Promise<string[]> {
  return (await listJobs(ctx)).map((job) => {
    const j = job as StoredJob;
    return `${j.kind ?? j.type}/${j.channel ?? '-'}/${j.audience ?? '-'}${j.hostId ? `/${j.hostId}` : ''} @ ${j.dueAt}`;
  });
}

async function timeline(ctx: TestCtx, id = 'bkg_test1'): Promise<string[]> {
  return ((await getBooking(ctx, id))?.timeline ?? []).map((t) => t.type);
}

async function timelineDetail(ctx: TestCtx, type: string, id = 'bkg_test1'): Promise<string[]> {
  return ((await getBooking(ctx, id))?.timeline ?? []).filter((t) => t.type === type).map((t) => t.detail ?? '');
}

function icsOf(sent: Sent): string {
  return Buffer.from(sent.attachments![0].content, 'base64').toString('utf8');
}

const at = (iso: string, deltaMs: number) => new Date(Date.parse(iso) + deltaMs).toISOString();

beforeEach(() => {
  smsSpy.mockReset();
  callSpy.mockReset();
  smsSpy.mockResolvedValue({ ok: true, provider: 'twilio', id: 'SM1' });
  callSpy.mockResolvedValue({ ok: true, provider: 'twilio', id: 'CA1' });
});

// ───────────────────────── queueing ─────────────────────────

describe('enqueueJob', () => {
  it('stores the job under jobs/<dueAt>_<id> with a fresh id', async () => {
    const { ctx } = await makeWorld();
    const job = await enqueueJob(ctx, { type: 'message', bookingId: 'bkg_test1', dueAt: '2026-11-17T20:15:00+03:00', channel: 'email', audience: 'invitee', kind: 'reminder' });
    expect(job.id).toMatch(/^job_[a-z2-7]{16}$/);
    expect(job.dueAt).toBe('2026-11-17T17:15:00.000Z'); // normalised to UTC so keys sort by time
    expect(job.key).toBe(`jobs/2026-11-17T17:15:00.000Z_${job.id}`);
    expect(job.attempt).toBe(0);
    expect(job.createdAt).toBe(TEST_NOW);
    expect(await ctx.kv.getJSON(job.key)).toEqual(job);
  });

  it('refuses a due time that is not a time', async () => {
    const { ctx } = await makeWorld();
    await expect(enqueueJob(ctx, { type: 'message', bookingId: 'b', dueAt: 'soon' })).rejects.toThrow(/dueAt/);
    expect(await listJobs(ctx)).toEqual([]);
  });

  it('sends a message queued twice under one fixed id once (a webhook repeated after a lost answer)', async () => {
    const world = await makeWorld();
    await saveBooking(world.ctx, makeBooking());
    const alert = { type: 'message' as const, bookingId: 'bkg_test1', channel: 'email' as const, audience: 'host' as const, kind: 'host_alert' as const, subject: 'Sam asked to move', body: 'Hi {{host_first_name}}, Sam asked to move.' };
    await enqueueJob(world.ctx, { ...alert, dueAt: TEST_NOW }, { id: 'job_fixed0alert' });
    await enqueueJob(world.ctx, { ...alert, dueAt: at(TEST_NOW, 1000) }, { id: 'job_fixed0alert' });
    expect(await listJobs(world.ctx)).toHaveLength(2);
    for (const minutes of [1, 12, 30, 60]) {
      world.ctx.clock.set(at(TEST_NOW, minutes * MIN));
      await runDueJobs(world.ctx);
    }
    expect(world.emails.filter((e) => e.subject === 'Sam asked to move')).toHaveLength(1);
    expect(await listJobs(world.ctx)).toEqual([]);
  });
});

describe('scheduleBookingJobs', () => {
  it('queues the confirmation batch now and one reminder per rule at the right instant', async () => {
    const world = await makeWorld();
    await book(world);
    expect((await queue(world.ctx)).sort()).toEqual(
      [
        `confirmation/email/invitee @ ${TEST_NOW}`,
        `confirmation/sms/invitee @ ${TEST_NOW}`,
        `host_new/email/host/host_owner @ ${TEST_NOW}`,
        `reminder/email/invitee @ ${at(START, -24 * HOUR)}`,
        // the 2 hour call would ring at 9:30 PM in Nairobi, after calling hours: it rings at 8 PM instead
        `reminder/call/invitee @ ${at(START, -3.5 * HOUR)}`,
        `reminder/email/invitee @ ${at(START, -1 * HOUR)}`,
        `reminder/sms/invitee @ ${at(START, -15 * MIN)}`,
      ].sort(),
    );
    const reminders = ((await listJobs(world.ctx)) as StoredJob[]).filter((j) => j.kind === 'reminder');
    expect(reminders.map((j) => j.ruleId)).toEqual(['rem_email_24h', 'rem_call_2h', 'rem_email_1h', 'rem_sms_15m']);
    expect(reminders.every((j) => j.forStart === START && j.type === 'message' && j.attempt === 0)).toBe(true);
  });

  it('schedules a follow-up after the end and ignores a call rule after the meeting', async () => {
    const world = await makeWorld({
      rules: [
        { id: 'r_follow', enabled: true, channel: 'email', audience: 'invitee', trigger: 'after_end', offsetMinutes: 60 },
        { id: 'r_call_after', enabled: true, channel: 'call', audience: 'invitee', trigger: 'after_end', offsetMinutes: 5 },
      ],
    });
    await book(world, {}, null);
    expect(await queue(world.ctx)).toEqual([`followup/email/invitee @ ${at(END, 60 * MIN)}`]);
  });

  it('only schedules texts and calls the invitee agreed to', async () => {
    const noConsent = await makeWorld();
    await book(noConsent, { consent: { sms: false, call: false, at: TEST_NOW, text: '' } });
    expect((await queue(noConsent.ctx)).filter((j) => !j.includes('/email/'))).toEqual([]);

    const smsOnly = await makeWorld();
    await book(smsOnly, { consent: { sms: true, call: false, at: TEST_NOW, text: '' } });
    const channels = (await queue(smsOnly.ctx)).map((j) => j.split('/')[1]);
    expect(channels).toContain('sms');
    expect(channels).not.toContain('call');

    const noPhone = await makeWorld();
    await book(noPhone, { invitee: { name: 'Sam Rivera', email: 'sam@example.com', timezone: 'Africa/Nairobi' } });
    expect((await queue(noPhone.ctx)).filter((j) => !j.includes('/email/'))).toEqual([]);
  });

  it('gives each host their own job and respects their notification choices', async () => {
    const world = await makeWorld({
      rules: [
        { id: 'h_email', enabled: true, channel: 'email', audience: 'host', trigger: 'before_start', offsetMinutes: 30 },
        { id: 'h_sms', enabled: true, channel: 'sms', audience: 'host', trigger: 'before_start', offsetMinutes: 10 },
        { id: 'h_call', enabled: true, channel: 'call', audience: 'host', trigger: 'before_start', offsetMinutes: 10 },
      ],
    });
    // Jimi: email yes, texts no (no number). Alex: email off, texts on.
    await updateHost(world.ctx, 'host_alex', (h) => ({ ...h, notify: { email: false, sms: true } }));
    await book(world, { kind: 'collective', hostIds: ['host_owner', 'host_alex'], consent: { sms: false, call: false, at: TEST_NOW, text: '' } });
    expect((await queue(world.ctx)).sort()).toEqual(
      [
        `confirmation/email/invitee @ ${TEST_NOW}`,
        `host_new/email/host/host_owner @ ${TEST_NOW}`,
        `host_new/sms/host/host_alex @ ${TEST_NOW}`,
        `reminder/email/host/host_owner @ ${at(START, -30 * MIN)}`,
        `reminder/sms/host/host_alex @ ${at(START, -10 * MIN)}`,
      ].sort(),
    );
  });

  it('skips rules that are switched off or already in the past', async () => {
    const world = await makeWorld({
      rules: [{ ...DEFAULT_RULES[0], enabled: false }, ...DEFAULT_RULES.slice(1)],
      now: at(START, -30 * MIN), // booked half an hour before the start
    });
    await book(world, { createdAt: at(START, -30 * MIN) }, null);
    expect(await queue(world.ctx)).toEqual([`reminder/sms/invitee @ ${at(START, -15 * MIN)}`]);
  });

  it('sends an "at start time" reminder two minutes early so it is not late', async () => {
    const world = await makeWorld({ rules: [{ id: 'r0', enabled: true, channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 0 }] });
    await book(world, {}, null);
    expect(await queue(world.ctx)).toEqual([`reminder/email/invitee @ ${at(START, -2 * MIN)}`]);
  });

  it('can be called again without doubling anything', async () => {
    const world = await makeWorld();
    const booking = await book(world);
    const before = await queue(world.ctx);
    await scheduleBookingJobs(world.ctx, booking, world.eventType, 'created');
    await scheduleBookingJobs(world.ctx, booking, world.eventType, null);
    expect(await queue(world.ctx)).toEqual(before);
  });

  it('does not send a second confirmation when the first already went out', async () => {
    const world = await makeWorld();
    const booking = await book(world);
    await runDueJobs(world.ctx);
    expect(world.emails).toHaveLength(2);
    await scheduleBookingJobs(world.ctx, booking, world.eventType, 'created');
    await runDueJobs(world.ctx);
    expect(world.emails).toHaveLength(2);
    expect(smsSpy).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the reminders around the new time when a booking moves', async () => {
    const world = await makeWorld();
    const booking = await book(world);
    await runDueJobs(world.ctx); // confirmation batch is out
    const newStart = at(START, 24 * HOUR);
    const moved = await saveBooking(world.ctx, { ...booking, start: newStart, end: at(END, 24 * HOUR), rescheduledFromStart: START, rescheduleCount: 1 });
    await scheduleBookingJobs(world.ctx, moved, world.eventType, 'rescheduled');

    expect((await queue(world.ctx)).sort()).toEqual(
      [
        `rescheduled/email/invitee @ ${TEST_NOW}`,
        `rescheduled/sms/invitee @ ${TEST_NOW}`,
        `rescheduled/email/host/host_owner @ ${TEST_NOW}`,
        `reminder/email/invitee @ ${at(newStart, -24 * HOUR)}`,
        `reminder/call/invitee @ ${at(newStart, -3.5 * HOUR)}`,
        `reminder/email/invitee @ ${at(newStart, -1 * HOUR)}`,
        `reminder/sms/invitee @ ${at(newStart, -15 * MIN)}`,
      ].sort(),
    );
    const reminders = ((await listJobs(world.ctx)) as StoredJob[]).filter((j) => j.kind === 'reminder');
    expect(reminders.every((j) => j.forStart === newStart)).toBe(true);

    await runDueJobs(world.ctx);
    const notice = world.emails.find((e) => e.subject.startsWith('New time:'))!;
    expect(notice.subject).toBe('New time: Intro call with Jimi Cohen, Wed, Nov 18, 11:30 PM GMT+3');
    expect(notice.text).toContain('The old time was Tuesday, November 17, 2026 at 11:30 PM GMT+3.');
    expect(icsOf(notice)).toContain('SEQUENCE:1');
  });

  it('queues nothing for a cancelled booking and clears its reminders', async () => {
    const world = await makeWorld();
    const booking = await book(world, {}, null);
    expect((await queue(world.ctx)).length).toBe(4);
    const cancelled = await saveBooking(world.ctx, { ...booking, status: 'cancelled' });
    await scheduleBookingJobs(world.ctx, cancelled, world.eventType, 'rescheduled');
    expect(await queue(world.ctx)).toEqual([]);
  });
});

describe('planBookingJobs', () => {
  it('is a pure function of the booking, the rules and the clock', async () => {
    const world = await makeWorld();
    const owner = (await updateHost(world.ctx, 'host_owner', (h) => h)) as Host;
    const input = { booking: makeBooking(), eventType: world.eventType, hosts: [owner], nowMs: Date.parse(TEST_NOW), immediate: null };
    const plan = planBookingJobs(input);
    expect(plan).toEqual(planBookingJobs(input));
    expect(plan.map((p) => [p.kind, p.channel, p.dueMs - START_MS])).toEqual([
      ['reminder', 'email', -24 * HOUR],
      ['reminder', 'call', -3.5 * HOUR], // moved inside calling hours (8 AM to 9 PM Nairobi time)
      ['reminder', 'email', -1 * HOUR],
      ['reminder', 'sms', -15 * MIN],
    ]);
    expect(planBookingJobs({ ...input, booking: makeBooking({ status: 'cancelled' }), immediate: 'created' })).toEqual([]);
    expect(planBookingJobs({ ...input, booking: makeBooking({ start: 'never' }), immediate: 'created' })).toEqual([]);
  });

  it('drops a rule that falls exactly on the present moment', async () => {
    const world = await makeWorld();
    const plan = planBookingJobs({ booking: makeBooking(), eventType: world.eventType, hosts: [], nowMs: START_MS - 60 * MIN, immediate: null });
    expect(plan.map((p) => p.ruleId)).toEqual(['rem_sms_15m']);
  });
});

describe('cancelBookingJobs', () => {
  it('removes pending messages for that booking but keeps cancellation notices, sync jobs and other bookings', async () => {
    const world = await makeWorld();
    await book(world);
    await book(world, { id: 'bkg_other' }, null);
    await enqueueJob(world.ctx, { type: 'message', bookingId: 'bkg_test1', dueAt: TEST_NOW, channel: 'email', audience: 'invitee', kind: 'cancelled' });
    await enqueueJob(world.ctx, { type: 'message', bookingId: 'bkg_test1', dueAt: TEST_NOW, channel: 'email', audience: 'host', kind: 'host_alert' });
    await enqueueJob(world.ctx, { type: 'gcal_sync', bookingId: 'bkg_test1', dueAt: TEST_NOW });

    await cancelBookingJobs(world.ctx, 'bkg_test1');
    const left = (await listJobs(world.ctx)) as StoredJob[];
    expect(left.filter((j) => j.bookingId === 'bkg_test1').map((j) => j.kind ?? j.type).sort()).toEqual(['cancelled', 'gcal_sync', 'host_alert']);
    expect(left.filter((j) => j.bookingId === 'bkg_other')).toHaveLength(4);
  });
});

// ───────────────────────── running ─────────────────────────

describe('runDueJobs: delivery', () => {
  it('sends what is due, records it on the timeline and leaves the rest queued', async () => {
    const world = await makeWorld();
    await book(world);
    const result = await runDueJobs(world.ctx);
    expect(result).toEqual({ processed: 3, failed: 0, remaining: 0 });
    expect(world.emails.map((e) => e.to[0]).sort()).toEqual(['Jimi Cohen <jimi@example.com>', 'Sam Rivera <sam@example.com>']);
    expect(smsSpy).toHaveBeenCalledTimes(1);
    expect(callSpy).not.toHaveBeenCalled();
    expect((await queue(world.ctx)).every((j) => j.startsWith('reminder/'))).toBe(true);
    expect(await queue(world.ctx)).toHaveLength(4);
    expect((await timeline(world.ctx)).sort()).toEqual(['confirmation_email_sent', 'confirmation_sms_sent', 'created', 'host_new_email_sent']);
    expect(await timelineDetail(world.ctx, 'confirmation_email_sent')).toEqual(['to sam@example.com via resend']);
    expect(await timelineDetail(world.ctx, 'confirmation_sms_sent')).toEqual(['to +254700000001 via twilio']);
  });

  it('writes the confirmation in the invitee zone with the details, buttons and an invitation file', async () => {
    const world = await makeWorld();
    await book(world);
    await runDueJobs(world.ctx);
    const email = world.emails.find((e) => e.to[0].includes('sam@example.com'))!;
    const token = hmacHex(world.ctx, 'manage', 'bkg_test1');
    expect(email.subject).toBe('Confirmed: Intro call with Jimi Cohen, Tue, Nov 17, 11:30 PM GMT+3');
    expect(email.reply_to).toBe('jimi@example.com');
    expect(email.text).toContain("You're all set. Your Intro call with Jimi Cohen is confirmed for Tuesday, November 17, 2026 at 11:30 PM GMT+3.");
    expect(email.text).toContain('When: Tuesday, November 17, 2026\n  11:30 PM to 12:00 AM (East Africa Time)');
    expect(email.text).toContain('Where: Google Meet');
    expect(email.text).toContain(`Link: ${MEET}`);
    expect(email.text).toContain('With: Jimi Cohen');
    expect(email.text).toContain(`Join the meeting: ${MEET}`);
    expect(email.text).toContain(`Reschedule: ${TEST_BASE_URL}/booking/bkg_test1/reschedule?t=${token}`);
    expect(email.text).toContain(`Cancel: ${TEST_BASE_URL}/booking/bkg_test1/cancel?t=${token}`);
    expect(email.text).toContain(`Add to your calendar:\nCalendar file: ${TEST_BASE_URL}/api/public/bookings/bkg_test1/ics?t=${token}`);
    expect(email.text).not.toContain('calendar.google.com'); // the long links stay in the HTML version
    expect(email.html).toContain('>Join the meeting</a>');
    expect(email.html).toContain(`href="${TEST_BASE_URL}/booking/bkg_test1/reschedule?t=${token}"`);
    expect(email.html).toContain('>Reschedule</a>');
    expect(email.html).toContain('>Cancel</a>');
    expect(email.html).toContain('calendar.google.com/calendar/render');
    expect(`${email.subject}${email.text}${email.html}`).not.toMatch(/[\u2012-\u2015]/);
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments![0].filename).toBe('invite.ics');
    expect(email.attachments![0].content_type).toContain('method=REQUEST');
    expect(icsOf(email)).toContain('METHOD:REQUEST');
    expect(icsOf(email)).toContain('UID:bkg_test1@jimicohen.com');
  });

  it("writes the host notice in the host's zone with the invitee's details and answers, escaped", async () => {
    const world = await makeWorld();
    await book(world, { invitee: { name: 'Sam <i>Rivera</i>', email: 'sam@example.com', phone: '+254700000001', timezone: 'Africa/Nairobi' } });
    await runDueJobs(world.ctx);
    const email = world.emails.find((e) => e.to[0].includes('jimi@example.com'))!;
    expect(email.subject).toBe('New booking: Sam <i>Rivera</i> for Intro call, Tue, Nov 17, 3:30 PM EST');
    expect(email.reply_to).toBe('sam@example.com'); // the host answers the invitee directly
    expect(email.text).toContain('Hi Jimi,');
    expect(email.text).toContain('When: Tuesday, November 17, 2026\n  3:30 PM to 4:00 PM (Eastern Standard Time)');
    expect(email.text).toContain('Invitee: Sam <i>Rivera</i>');
    expect(email.text).toContain('Email: sam@example.com');
    expect(email.text).toContain('Phone: +254700000001');
    expect(email.text).toContain('Their time: 11:30 PM (East Africa Time)');
    expect(email.text).toContain('What would you like to talk about? Trees & <b>bees</b>');
    expect(email.html).toContain('Sam &lt;i&gt;Rivera&lt;/i&gt;');
    expect(email.html).toContain('Trees &amp; &lt;b&gt;bees&lt;/b&gt;');
    expect(email.html).not.toContain('<i>Rivera</i>');
    expect(email.html).not.toContain('<b>bees</b>');
    expect(email.html).toContain('>View or change booking</a>');
    // no Google event yet: the host gets a plain calendar file
    expect(icsOf(email)).toContain('METHOD:PUBLISH');
  });

  it('sends a text with the facts first, then the link to change plans, inside the limit', async () => {
    const world = await makeWorld();
    await book(world);
    await runDueJobs(world.ctx);
    const token = hmacHex(world.ctx, 'manage', 'bkg_test1');
    const { to, body } = smsSpy.mock.calls[0][1];
    expect(to).toBe('+254700000001');
    expect(body).toBe(
      `Hi Sam, you're booked: Intro call with Jimi Cohen on Tue, Nov 17, 11:30 PM GMT+3. Change or cancel: ${TEST_BASE_URL}/booking/bkg_test1?t=${token} Reply STOP to opt out.`,
    );
    expect(body.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });

  it('sends each reminder when its time comes', async () => {
    const world = await makeWorld();
    await book(world, {}, null);
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 0, failed: 0, remaining: 0 });

    world.ctx.clock.set(at(START, -24 * HOUR));
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(world.emails).toHaveLength(1);
    expect(world.emails[0].subject).toBe('Reminder: Intro call with Jimi Cohen is tomorrow at 11:30 PM GMT+3');
    expect(world.emails[0].text).toContain('A quick reminder that your Intro call with Jimi Cohen is tomorrow at 11:30 PM (East Africa Time).');
    expect(world.emails[0].attachments).toBeUndefined();

    world.ctx.clock.set(at(START, -2 * HOUR + 30_000));
    await runDueJobs(world.ctx);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy.mock.calls[0][1]).toMatchObject({ booking: { id: 'bkg_test1' }, purpose: 'reminder' });

    world.ctx.clock.set(at(START, -1 * HOUR));
    await runDueJobs(world.ctx);
    expect(world.emails[1].subject).toBe('Reminder: Intro call with Jimi Cohen is today at 11:30 PM GMT+3');

    world.ctx.clock.set(at(START, -15 * MIN));
    await runDueJobs(world.ctx);
    const text = smsSpy.mock.calls[0][1].body;
    // close to the start the join link comes first
    expect(text).toMatch(/^Hi Sam, a reminder: Intro call with Jimi Cohen is today at 11:30 PM GMT\+3\. Join: https:\/\/meet\.google\.com\/abc-defg-hij Change or cancel: https:\/\/jimicohen\.com\/meeting\/booking\/bkg_test1\?t=[0-9a-f]{64}$/);
    expect(text.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);

    expect(await queue(world.ctx)).toEqual([]);
    expect(await timeline(world.ctx)).toEqual(['created', 'reminder_email_sent', 'reminder_call_sent', 'reminder_email_sent', 'reminder_sms_sent']);
  });

  it('uses the wording of the reminder rule when it has its own', async () => {
    const world = await makeWorld({
      rules: [
        {
          id: 'custom',
          enabled: true,
          channel: 'email',
          audience: 'invitee',
          trigger: 'before_start',
          offsetMinutes: 60,
          subject: 'Heads up {{invitee_first_name}}\r\nBcc: evil@example.com',
          body: 'See you {{relative_day}} at {{time}}.\n\nYou wrote: {{answers}}{{#nothing}} never shown{{/nothing}}',
        },
      ],
    });
    await book(world, {}, null);
    world.ctx.clock.set(at(START, -1 * HOUR));
    await runDueJobs(world.ctx);
    expect(world.emails[0].subject).toBe('Heads up Sam Bcc: evil@example.com');
    expect(world.emails[0].text).toContain('See you today at 11:30 PM.\n\nYou wrote: What would you like to talk about? Trees & <b>bees</b>');
    expect(world.emails[0].html).toContain('You wrote: What would you like to talk about? Trees &amp; &lt;b&gt;bees&lt;/b&gt;');
    expect(world.emails[0].text).not.toContain('never shown');
  });

  it('attaches a plain calendar file once Google has sent the real invitation', async () => {
    const world = await makeWorld();
    await book(world, { google: { hostId: 'host_owner', calendarId: 'primary', eventId: 'evt_g1', meetUrl: MEET } });
    await runDueJobs(world.ctx);
    const invitee = world.emails.find((e) => e.to[0].includes('sam@example.com'))!;
    expect(invitee.attachments![0].content_type).toContain('method=PUBLISH');
    expect(icsOf(invitee)).toContain('METHOD:PUBLISH');
    expect(icsOf(invitee)).not.toContain('ATTENDEE');
    const host = world.emails.find((e) => e.to[0].includes('jimi@example.com'))!;
    expect(host.attachments).toBeUndefined(); // the event is already on the host's Google Calendar
  });

  it('sends a real invitation when the event type does not add invitees to the Google event', async () => {
    const world = await makeWorld({ googleInvite: false });
    await book(world, { google: { hostId: 'host_owner', calendarId: 'primary', eventId: 'evt_g1' } });
    await runDueJobs(world.ctx);
    expect(icsOf(world.emails.find((e) => e.to[0].includes('sam@example.com'))!)).toContain('METHOD:REQUEST');
  });

  it('only handles the named booking when asked to', async () => {
    const world = await makeWorld();
    await book(world);
    await book(world, { id: 'bkg_other', invitee: { name: 'Pat Lee', email: 'pat@example.com', timezone: 'UTC' } });
    const result = await runDueJobs(world.ctx, { onlyBookingId: 'bkg_other' });
    expect(result).toEqual({ processed: 2, failed: 0, remaining: 0 });
    expect(world.emails.map((e) => e.to[0])).toContain('Pat Lee <pat@example.com>');
    expect(world.emails.some((e) => e.to[0].includes('sam@example.com'))).toBe(false);
    expect((await queue(world.ctx)).filter((j) => j.startsWith('confirmation/') || j.startsWith('host_new/'))).toHaveLength(3);
  });
});

describe('runDueJobs: never twice', () => {
  it('does nothing on a second run', async () => {
    const world = await makeWorld();
    await book(world);
    await runDueJobs(world.ctx);
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 0, failed: 0, remaining: 0 });
    expect(world.emails).toHaveLength(2);
    expect(smsSpy).toHaveBeenCalledTimes(1);
  });

  it('delivers each job exactly once when several runs overlap', async () => {
    const world = await makeWorld();
    await book(world);
    await book(world, { id: 'bkg_other', invitee: { name: 'Pat Lee', email: 'pat@example.com', phone: '+15550100', timezone: 'UTC' } });
    const results = await Promise.all([runDueJobs(world.ctx), runDueJobs(world.ctx), runDueJobs(world.ctx), runDueJobs(world.ctx)]);
    expect(world.emails).toHaveLength(4);
    expect(new Set(world.emails.map((e) => `${e.to[0]}|${e.subject}`)).size).toBe(4);
    expect(smsSpy).toHaveBeenCalledTimes(2);
    expect(results.reduce((n, r) => n + r.processed, 0)).toBe(6);
    expect((await timeline(world.ctx)).filter((t) => t === 'confirmation_email_sent')).toHaveLength(1);
    expect((await queue(world.ctx)).every((j) => j.startsWith('reminder/'))).toBe(true);
  });

  it('does not send again when a delivered job reappears in the queue', async () => {
    const world = await makeWorld();
    await book(world, { consent: { sms: false, call: false, at: TEST_NOW, text: '' } });
    const before = (await listJobs(world.ctx)).filter((j) => j.kind === 'confirmation');
    await runDueJobs(world.ctx);
    expect(world.emails).toHaveLength(2);
    // as if the run died right after the provider accepted the message, and the job was retried later
    await putJob(world.ctx, { ...before[0], attempt: 1 });
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(world.emails).toHaveLength(2);
    expect(await queue(world.ctx)).toHaveLength(2); // the two email reminders
    expect(await timelineDetail(world.ctx, 'confirmation_email_sent')).toEqual(['to sam@example.com via resend', 'it had already gone out on an earlier try']);
  });

  it('sends the same idempotency key on a retry of the same message', async () => {
    const world = await makeWorld();
    world.failEmail = (_sent, attempt) => attempt === 1;
    await book(world, { hostIds: [], consent: { sms: false, call: false, at: TEST_NOW, text: '' } }, 'created');
    await runDueJobs(world.ctx);
    world.ctx.clock.advance(2 * MIN);
    await runDueJobs(world.ctx);
    expect(world.emails).toHaveLength(2);
    expect(world.emails[0].idempotencyKey).toMatch(/^job_[0-9a-f]{20}-invitee$/); // a confirmation's id comes from its once-only claim
    expect(world.emails[1].idempotencyKey).toBe(world.emails[0].idempotencyKey);
  });
});

describe('runDueJobs: things that must not be sent', () => {
  it('never sends a reminder once the meeting has begun', async () => {
    const world = await makeWorld();
    await book(world, {}, null);
    world.ctx.clock.set(START); // every reminder is overdue and the meeting starts this instant
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 4, failed: 0, remaining: 0 });
    expect(world.emails).toEqual([]);
    expect(smsSpy).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(await queue(world.ctx)).toEqual([]);
    expect(await timeline(world.ctx)).toEqual(['created', 'reminder_email_skipped', 'reminder_call_skipped', 'reminder_email_skipped', 'reminder_sms_skipped']);
    expect(await timelineDetail(world.ctx, 'reminder_sms_skipped')).toEqual(['the meeting had already started']);
  });

  it('still sends a late reminder while the meeting is ahead, worded for the moment it goes out', async () => {
    const world = await makeWorld({ rules: [DEFAULT_RULES[0]] });
    await book(world, {}, null);
    world.ctx.clock.set(at(START, -3 * HOUR)); // the cron was down for 21 hours
    await runDueJobs(world.ctx);
    expect(world.emails[0].subject).toBe('Reminder: Intro call with Jimi Cohen is today at 11:30 PM GMT+3');
  });

  it('drops everything but the cancellation notice once a booking is cancelled', async () => {
    const world = await makeWorld();
    const booking = await book(world);
    await saveBooking(world.ctx, { ...booking, status: 'cancelled', cancellation: { at: TEST_NOW, by: 'invitee', reason: 'Plans changed' } });
    await enqueueJob(world.ctx, { type: 'message', bookingId: booking.id, dueAt: TEST_NOW, channel: 'email', audience: 'invitee', kind: 'cancelled' });
    await enqueueJob(world.ctx, { type: 'message', bookingId: booking.id, dueAt: TEST_NOW, channel: 'email', audience: 'host', kind: 'cancelled' });

    world.ctx.clock.set(at(START, -10 * MIN));
    const result = await runDueJobs(world.ctx);
    expect(result).toEqual({ processed: 9, failed: 0, remaining: 0 });
    expect(world.emails.map((e) => e.subject).sort()).toEqual([
      'Cancelled: Intro call with Jimi Cohen, Tue, Nov 17, 11:30 PM GMT+3',
      'Cancelled: Sam Rivera for Intro call, Tue, Nov 17, 3:30 PM EST',
    ]);
    expect(smsSpy).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(await queue(world.ctx)).toEqual([]);
    const invitee = world.emails.find((e) => e.to[0].includes('sam@'))!;
    // The invitee's own words are not mailed back to them; the host reads them.
    expect(invitee.text).not.toContain('Plans changed');
    expect(world.emails.find((e) => !e.to[0].includes('sam@'))!.text).toContain('Reason given: Plans changed');
    expect(invitee.text).toContain(`Book a new time: ${TEST_BASE_URL}/intro`);
    expect(invitee.text).not.toContain('Reschedule:');
    expect(invitee.attachments![0].filename).toBe('cancelled.ics');
    expect(icsOf(invitee)).toContain('METHOD:CANCEL');
    const host = world.emails.find((e) => e.to[0].includes('jimi@'))!;
    expect(host.text).toContain('was cancelled by Sam Rivera.');
    expect(await timeline(world.ctx)).toEqual(['created', 'cancelled_email_sent', 'cancelled_email_sent']);
  });

  it('leaves the calendar file off a cancellation that Google already announced', async () => {
    const world = await makeWorld();
    const booking = await saveBooking(
      world.ctx,
      makeBooking({ status: 'cancelled', google: { hostId: 'host_owner', calendarId: 'primary', eventId: 'evt_g1' } }),
    );
    await enqueueJob(world.ctx, { type: 'message', bookingId: booking.id, dueAt: TEST_NOW, channel: 'email', audience: 'invitee', kind: 'cancelled' });
    await runDueJobs(world.ctx);
    expect(world.emails).toHaveLength(1);
    expect(world.emails[0].attachments).toBeUndefined();
  });

  it('throws away jobs whose booking no longer exists', async () => {
    const world = await makeWorld();
    await enqueueJob(world.ctx, { type: 'message', bookingId: 'bkg_gone', dueAt: TEST_NOW, channel: 'email', audience: 'invitee', kind: 'confirmation' });
    await enqueueJob(world.ctx, { type: 'message', bookingId: '', dueAt: TEST_NOW, channel: 'email', audience: 'invitee', kind: 'reminder' });
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 2, failed: 0, remaining: 0 });
    expect(world.emails).toEqual([]);
    expect(await queue(world.ctx)).toEqual([]);
  });

  it('drops a reminder that was planned for a start time the booking no longer has', async () => {
    const world = await makeWorld();
    const booking = await book(world, {}, null);
    await saveBooking(world.ctx, { ...booking, start: at(START, 48 * HOUR), end: at(END, 48 * HOUR), rescheduleCount: 1 });
    world.ctx.clock.set(at(START, -1 * HOUR)); // old reminders come due, nobody rebuilt them
    await runDueJobs(world.ctx);
    expect(world.emails).toEqual([]);
    expect(callSpy).not.toHaveBeenCalled();
    expect(await queue(world.ctx)).toEqual([`reminder/sms/invitee @ ${at(START, -15 * MIN)}`]);
    expect(await timeline(world.ctx)).toEqual(['created']);
  });

  it('does not send a confirmation after the meeting is over', async () => {
    const world = await makeWorld({ rules: [] });
    await book(world, { consent: { sms: false, call: false, at: TEST_NOW, text: '' } });
    world.ctx.clock.set(at(END, MIN));
    await runDueJobs(world.ctx);
    expect(world.emails).toEqual([]);
    expect(await timelineDetail(world.ctx, 'confirmation_email_skipped')).toEqual(['the meeting was already over']);
  });

  it('does not thank a no-show for coming', async () => {
    const world = await makeWorld({
      rules: [
        { id: 'f_inv', enabled: true, channel: 'email', audience: 'invitee', trigger: 'after_end', offsetMinutes: 30 },
        { id: 'f_host', enabled: true, channel: 'email', audience: 'host', trigger: 'after_end', offsetMinutes: 30 },
      ],
    });
    const booking = await book(world, {}, null);
    await saveBooking(world.ctx, { ...booking, attendance: { noShow: true } });
    world.ctx.clock.set(at(END, 30 * MIN));
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 2, failed: 0, remaining: 0 });
    expect(world.emails.map((e) => e.subject)).toEqual(['Wrapped up: Intro call with Sam Rivera']);
    expect(await timelineDetail(world.ctx, 'followup_email_skipped')).toEqual(['the invitee was marked as a no-show']);
  });

  it('sends the follow-up after the meeting when all went well', async () => {
    const world = await makeWorld({ rules: [{ id: 'f_inv', enabled: true, channel: 'email', audience: 'invitee', trigger: 'after_end', offsetMinutes: 30 }] });
    await book(world, {}, null);
    world.ctx.clock.set(at(END, 31 * MIN));
    await runDueJobs(world.ctx);
    expect(world.emails).toHaveLength(1);
    expect(world.emails[0].subject).toBe('Thanks for meeting with Jimi Cohen');
    expect(world.emails[0].text).toContain(`Book another time: ${TEST_BASE_URL}/intro`);
    expect(world.emails[0].text).not.toContain('When:'); // a thank-you, not another set of logistics
    expect(world.emails[0].attachments).toBeUndefined();
  });

  it('checks consent again at the moment of sending', async () => {
    const world = await makeWorld({ rules: [DEFAULT_RULES[1], DEFAULT_RULES[3]] });
    const booking = await book(world, {}, null);
    await saveBooking(world.ctx, { ...booking, consent: { sms: false, call: false, at: TEST_NOW, text: '' } });
    world.ctx.clock.set(at(START, -10 * MIN));
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 2, failed: 0, remaining: 0 });
    expect(smsSpy).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(await queue(world.ctx)).toEqual([]);
    expect(await timelineDetail(world.ctx, 'reminder_sms_skipped')).toEqual(['the invitee did not agree to this kind of reminder']);
    expect(await timelineDetail(world.ctx, 'reminder_call_skipped')).toEqual(['the invitee did not agree to this kind of reminder']);
  });

  it('says the invitee asked to stop when a text or call is skipped after a stop word, not that they never agreed', async () => {
    const world = await makeWorld({ rules: [DEFAULT_RULES[1], DEFAULT_RULES[3]] });
    const booking = await book(world, {}, null);
    // What a stop word by text leaves on the booking (sms.ts recordOptOut): consent off, and the reason on the timeline.
    await saveBooking(world.ctx, {
      ...booking,
      consent: { ...booking.consent, sms: false, call: false },
      timeline: [...booking.timeline, { at: TEST_NOW, type: 'sms_opt_out', detail: 'Replied with a stop word. Reminder texts and calls are switched off.' }],
    });
    world.ctx.clock.set(at(START, -10 * MIN));
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 2, failed: 0, remaining: 0 });
    expect(smsSpy).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(await timelineDetail(world.ctx, 'reminder_sms_skipped')).toEqual(['the invitee asked for no more texts']);
    expect(await timelineDetail(world.ctx, 'reminder_call_skipped')).toEqual(['the invitee asked not to be called again']);
  });

  it('says the invitee asked not to be called when a call is skipped after "do not call me" on an earlier call', async () => {
    const world = await makeWorld({ rules: [DEFAULT_RULES[1]] });
    const booking = await book(world, {}, null);
    await saveBooking(world.ctx, {
      ...booking,
      consent: { ...booking.consent, call: false },
      timeline: [...booking.timeline, { at: TEST_NOW, type: 'call_opt_out', detail: 'Asked on a reminder call not to be called again. Reminder calls are switched off.' }],
    });
    world.ctx.clock.set(at(START, -10 * MIN));
    await runDueJobs(world.ctx);
    expect(await timelineDetail(world.ctx, 'reminder_call_skipped')).toEqual(['the invitee asked not to be called again']);
  });

  it('drops a call that falls outside calling hours without retrying it', async () => {
    const world = await makeWorld({ rules: [DEFAULT_RULES[1]] });
    await book(world, {}, null);
    callSpy.mockResolvedValue({ ok: false, provider: 'twilio', skipped: 'outside_call_window' });
    world.ctx.clock.set(at(START, -2 * HOUR));
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(await queue(world.ctx)).toEqual([]);
    expect(await timelineDetail(world.ctx, 'reminder_call_skipped')).toEqual(['it was outside calling hours']);
  });

  it('skips a reminder whose rule was switched off after it was queued', async () => {
    const world = await makeWorld({ rules: [DEFAULT_RULES[2]] });
    await book(world, {}, null);
    await saveEventType(world.ctx, { ...world.eventType, reminders: [{ ...DEFAULT_RULES[2], enabled: false }] });
    world.ctx.clock.set(at(START, -1 * HOUR));
    await runDueJobs(world.ctx);
    expect(world.emails).toEqual([]);
    expect(await timelineDetail(world.ctx, 'reminder_email_skipped')).toEqual(['this reminder was switched off or removed']);
  });

  it('reports email that is not set up as skipped, not as an endless failure', async () => {
    const world = await makeWorld({ rules: [] });
    await saveSite(world.ctx, { ...(await getSite(world.ctx)), email: { provider: 'none', fromName: '', fromEmail: '', replyTo: '' } });
    await book(world, { consent: { sms: false, call: false, at: TEST_NOW, text: '' } });
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 2, failed: 0, remaining: 0 });
    expect(await queue(world.ctx)).toEqual([]);
    expect(await timelineDetail(world.ctx, 'confirmation_email_skipped')).toEqual(['email sending is not set up yet']);
  });
});

describe('runDueJobs: failures', () => {
  it('retries with backoff of 2, 10 and 30 minutes, then gives up after four tries', async () => {
    const world = await makeWorld({ rules: [] });
    world.failEmail = () => true;
    await book(world, { hostIds: [], consent: { sms: false, call: false, at: TEST_NOW, text: '' } });
    const t0 = Date.parse(TEST_NOW);

    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 1, remaining: 0 });
    let [job] = await listJobs(world.ctx);
    expect([job.attempt, job.dueAt]).toEqual([1, new Date(t0 + 2 * MIN).toISOString()]);
    expect(job.key).toBe(`jobs/${job.dueAt}_${job.id}`);

    expect(await runDueJobs(world.ctx)).toEqual({ processed: 0, failed: 0, remaining: 0 }); // not due yet
    world.ctx.clock.advance(2 * MIN);
    await runDueJobs(world.ctx);
    [job] = await listJobs(world.ctx);
    expect([job.attempt, job.dueAt]).toEqual([2, new Date(t0 + 12 * MIN).toISOString()]);

    world.ctx.clock.advance(10 * MIN);
    await runDueJobs(world.ctx);
    [job] = await listJobs(world.ctx);
    expect([job.attempt, job.dueAt]).toEqual([3, new Date(t0 + 42 * MIN).toISOString()]);

    world.ctx.clock.advance(30 * MIN);
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 1, remaining: 0 });
    expect(await listJobs(world.ctx)).toEqual([]);
    expect(world.emails).toHaveLength(4);

    world.failEmail = () => false;
    world.ctx.clock.advance(2 * HOUR);
    await runDueJobs(world.ctx);
    expect(world.emails).toHaveLength(4);

    expect(await timelineDetail(world.ctx, 'confirmation_email_failed')).toEqual([
      'Resend answered 500: provider is down (will try again in 2 min)',
      'Resend answered 500: provider is down (will try again in 10 min)',
      'Resend answered 500: provider is down (will try again in 30 min)',
      'Resend answered 500: provider is down (gave up after 4 tries)',
    ]);
    expect(world.ctx.logs.some((l) => l.level === 'error' && l.msg.includes('giving up'))).toBe(true);
  });

  it('delivers on a later try when the provider recovers', async () => {
    const world = await makeWorld({ rules: [] });
    world.failEmail = (_sent, attempt) => attempt <= 2;
    await book(world, { hostIds: [], consent: { sms: false, call: false, at: TEST_NOW, text: '' } });
    await runDueJobs(world.ctx);
    world.ctx.clock.advance(2 * MIN);
    await runDueJobs(world.ctx);
    world.ctx.clock.advance(10 * MIN);
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(await listJobs(world.ctx)).toEqual([]);
    expect(await timeline(world.ctx)).toEqual(['created', 'confirmation_email_failed', 'confirmation_email_failed', 'confirmation_email_sent']);
  });

  it('keeps going when one job blows up', async () => {
    const world = await makeWorld({ rules: [] });
    await book(world);
    smsSpy.mockRejectedValue(new Error('twilio exploded'));
    const result = await runDueJobs(world.ctx);
    expect(result).toEqual({ processed: 3, failed: 1, remaining: 0 });
    expect(world.emails).toHaveLength(2); // both emails still went out
    expect(await queue(world.ctx)).toEqual([`confirmation/sms/invitee @ ${at(TEST_NOW, 2 * MIN)}`]);
    expect(await timelineDetail(world.ctx, 'confirmation_sms_failed')).toEqual(['twilio exploded (will try again in 2 min)']);
  });

  it('stops retrying a reminder when the next try would land after the start', async () => {
    const world = await makeWorld({ rules: [DEFAULT_RULES[3]] });
    await book(world, {}, null);
    smsSpy.mockResolvedValue({ ok: false, provider: 'twilio', error: 'carrier rejected' });

    world.ctx.clock.set(at(START, -15 * MIN));
    await runDueJobs(world.ctx); // retry at -13
    world.ctx.clock.set(at(START, -13 * MIN));
    await runDueJobs(world.ctx); // retry at -3
    world.ctx.clock.set(at(START, -3 * MIN));
    await runDueJobs(world.ctx); // next would be +27: pointless
    expect(smsSpy).toHaveBeenCalledTimes(3);
    expect(await queue(world.ctx)).toEqual([]);
    expect((await timelineDetail(world.ctx, 'reminder_sms_failed')).pop()).toBe('carrier rejected (not retried: the meeting starts before the next try)');
  });

  it('retries only the host who did not get the message', async () => {
    const world = await makeWorld({ rules: [] });
    const booking = await saveBooking(world.ctx, makeBooking({ kind: 'collective', hostIds: ['host_owner', 'host_alex'], status: 'cancelled' }));
    await enqueueJob(world.ctx, { type: 'message', bookingId: booking.id, dueAt: TEST_NOW, channel: 'email', audience: 'host', kind: 'cancelled' });
    let alexAttempts = 0;
    world.failEmail = (sent) => sent.to[0].includes('alex@') && ++alexAttempts === 1;

    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 1, remaining: 0 });
    world.ctx.clock.advance(2 * MIN);
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(world.emails.filter((e) => e.to[0].includes('jimi@'))).toHaveLength(1);
    expect(world.emails.filter((e) => e.to[0].includes('alex@'))).toHaveLength(2);
    // each host reads their own zone
    expect(world.emails.find((e) => e.to[0].includes('jimi@'))!.subject).toContain('3:30 PM');
    expect(world.emails.filter((e) => e.to[0].includes('alex@'))[1].subject).toContain('8:30 PM');
    expect(await queue(world.ctx)).toEqual([]);
  });

  it('stops for the budget and reports what is left', async () => {
    const world = await makeWorld({ rules: [] });
    const booking = await saveBooking(world.ctx, makeBooking());
    registerJobHandler('gcal_sync', async (ctx) => {
      (ctx as TestCtx).clock.advance(6_000);
      return { ok: true, provider: 'google' };
    });
    for (let i = 0; i < 5; i++) await enqueueJob(world.ctx, { type: 'gcal_sync', bookingId: booking.id, dueAt: at(TEST_NOW, -i * 1000) });
    expect(await runDueJobs(world.ctx, { budgetMs: 10_000 })).toEqual({ processed: 2, failed: 0, remaining: 3 });
    expect(await listJobs(world.ctx)).toHaveLength(3);
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 3, failed: 0, remaining: 0 });
    expect(await timeline(world.ctx)).toEqual(['created']); // sync jobs write their own history
  });

  it('runs the oldest job first', async () => {
    const world = await makeWorld({ rules: [] });
    const booking = await saveBooking(world.ctx, makeBooking());
    const seen: string[] = [];
    registerJobHandler('gcal_sync', async (_ctx, job) => {
      seen.push(job.dueAt);
      return { ok: true, provider: 'google' };
    });
    for (const offset of [-3, -9, -1, -6]) await enqueueJob(world.ctx, { type: 'gcal_sync', bookingId: booking.id, dueAt: at(TEST_NOW, offset * MIN) });
    await runDueJobs(world.ctx);
    expect(seen).toEqual([-9, -6, -3, -1].map((m) => at(TEST_NOW, m * MIN)));
  });

  it('moves on when a job hangs, and lets it finish on its own', async () => {
    const world = await makeWorld({ rules: [] });
    const booking = await saveBooking(world.ctx, makeBooking());
    let release: (() => void) | undefined;
    registerJobHandler('gcal_sync', () => new Promise((resolve) => (release = () => resolve({ ok: true, provider: 'google' }))));
    await enqueueJob(world.ctx, { type: 'gcal_sync', bookingId: booking.id, dueAt: at(TEST_NOW, -MIN) });
    await enqueueJob(world.ctx, { type: 'message', bookingId: booking.id, dueAt: TEST_NOW, channel: 'email', audience: 'invitee', kind: 'confirmation' });

    const result = await runDueJobs(world.ctx, { jobTimeoutMs: 25 });
    expect(result).toEqual({ processed: 2, failed: 1, remaining: 0 });
    expect(world.emails).toHaveLength(1); // the job behind the stuck one still ran
    expect(await listJobs(world.ctx)).toHaveLength(1); // the stuck one is still queued, claimed

    release!();
    await world.ctx.settle();
    expect(await listJobs(world.ctx)).toEqual([]); // it finished late and cleaned up after itself
  });

  it('leaves a job alone when nothing can handle its type', async () => {
    const world = await makeWorld({ rules: [] });
    const booking = await saveBooking(world.ctx, makeBooking());
    await enqueueJob(world.ctx, { type: 'mystery' as Job['type'], bookingId: booking.id, dueAt: TEST_NOW });
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 0, failed: 0, remaining: 1 });
    expect(await listJobs(world.ctx)).toHaveLength(1);
    expect(world.ctx.logs.some((l) => l.level === 'warn' && l.msg.includes('no handler'))).toBe(true);
  });

  it('hands calendar jobs to their handler even for a cancelled booking', async () => {
    const world = await makeWorld({ rules: [] });
    const booking = await saveBooking(world.ctx, makeBooking({ status: 'cancelled' }));
    const handler = vi.fn(async () => ({ ok: true, provider: 'google' }));
    registerJobHandler('gcal_sync', handler);
    const job = await enqueueJob(world.ctx, { type: 'gcal_sync', bookingId: booking.id, dueAt: TEST_NOW });
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(world.ctx, job, { booking: expect.objectContaining({ id: booking.id, status: 'cancelled' }) });
    expect(await listJobs(world.ctx)).toEqual([]);
  });
});

describe('runDueJobs: interrupted runs', () => {
  it('picks an abandoned job back up after ten minutes and sends it once', async () => {
    const world = await makeWorld({ rules: [] });
    await book(world, { hostIds: [], consent: { sms: false, call: false, at: TEST_NOW, text: '' } });
    const [job] = await listJobs(world.ctx);
    expect(await claim(world.ctx, `job-${job.id}-0`)).toBe(true); // a run took the job and then died

    expect(await runDueJobs(world.ctx)).toEqual({ processed: 0, failed: 0, remaining: 1 });
    world.ctx.clock.advance(5 * MIN);
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 0, failed: 0, remaining: 1 });
    expect(world.emails).toEqual([]);

    world.ctx.clock.advance(6 * MIN);
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 1, remaining: 0 });
    const [next] = await listJobs(world.ctx);
    expect(next.id).toBe(job.id);
    expect(next.attempt).toBe(1);
    expect(await listJobs(world.ctx)).toHaveLength(1);

    world.ctx.clock.advance(2 * MIN);
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(world.emails).toHaveLength(1);
    expect(await listJobs(world.ctx)).toEqual([]);
    expect(await timeline(world.ctx)).toEqual(['created', 'confirmation_email_failed', 'confirmation_email_sent']);
  });

  it('recovers only once even when two runs notice at the same time', async () => {
    const world = await makeWorld({ rules: [] });
    await book(world, { hostIds: [], consent: { sms: false, call: false, at: TEST_NOW, text: '' } });
    const [job] = await listJobs(world.ctx);
    await claim(world.ctx, `job-${job.id}-0`);
    await runDueJobs(world.ctx);
    world.ctx.clock.advance(11 * MIN);
    await Promise.all([runDueJobs(world.ctx), runDueJobs(world.ctx), runDueJobs(world.ctx)]);
    expect(await listJobs(world.ctx)).toHaveLength(1);
    world.ctx.clock.advance(2 * MIN);
    await Promise.all([runDueJobs(world.ctx), runDueJobs(world.ctx)]);
    expect(world.emails).toHaveLength(1);
    expect(await listJobs(world.ctx)).toEqual([]);
  });

  it('does not send twice when storage fails right after the provider accepted the message', async () => {
    const kv = memoryKV();
    let failDeletes = 0;
    const flaky: KV = {
      ...kv,
      delete: async (key) => {
        if (key.startsWith('jobs/') && failDeletes > 0) {
          failDeletes--;
          throw new Error('storage is down');
        }
        return kv.delete(key);
      },
    };
    const world = await makeWorld({ rules: [], kv: flaky });
    await book(world, { hostIds: [], consent: { sms: false, call: false, at: TEST_NOW, text: '' } });

    failDeletes = 1;
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(world.emails).toHaveLength(1); // sent, but the job could not be taken off the queue
    expect(await listJobs(world.ctx)).toHaveLength(1);

    for (const minutes of [1, 11, 2, 2, 30]) {
      world.ctx.clock.advance(minutes * MIN);
      await runDueJobs(world.ctx);
    }
    expect(world.emails).toHaveLength(1);
    expect(await listJobs(world.ctx)).toEqual([]);
    // the history still ends up telling the truth
    expect(await timeline(world.ctx)).toEqual(['created', 'confirmation_email_failed', 'confirmation_email_sent']);
    expect(await timelineDetail(world.ctx, 'confirmation_email_sent')).toEqual(['it had already gone out on an earlier try']);
  });

  it('never forks a job into two copies when a stale attempt shows up again', async () => {
    const world = await makeWorld({ rules: [] });
    world.failEmail = (_sent, attempt) => attempt === 1;
    await book(world, { hostIds: [], consent: { sms: false, call: false, at: TEST_NOW, text: '' } });
    const [original] = await listJobs(world.ctx);
    await runDueJobs(world.ctx); // attempt 0 fails, attempt 1 is queued
    await putJob(world.ctx, original); // attempt 0 reappears (a late write from a dead run)
    expect(await listJobs(world.ctx)).toHaveLength(2);

    await runDueJobs(world.ctx); // noted as someone else's
    world.ctx.clock.advance(11 * MIN);
    await runDueJobs(world.ctx); // attempt 1 is sent; the stale attempt 0 is retired without a successor
    world.ctx.clock.advance(45 * MIN);
    await runDueJobs(world.ctx);
    expect(world.emails).toHaveLength(2); // one failure, one delivery
    expect(await listJobs(world.ctx)).toEqual([]);
    expect((await timeline(world.ctx)).filter((t) => t === 'confirmation_email_sent')).toHaveLength(1);
  });

  it('retires a stale attempt quietly when the next attempt has already run', async () => {
    const world = await makeWorld({ rules: [] });
    world.failEmail = (_sent, attempt) => attempt === 1;
    await book(world, { hostIds: [], consent: { sms: false, call: false, at: TEST_NOW, text: '' } });
    const [original] = await listJobs(world.ctx);
    await runDueJobs(world.ctx); // attempt 0 fails, attempt 1 is queued
    world.ctx.clock.advance(3 * MIN);
    await runDueJobs(world.ctx); // attempt 1 is sent
    expect(world.emails).toHaveLength(2);
    await putJob(world.ctx, original); // attempt 0 reappears (a late write from a dead run)
    const before = await timeline(world.ctx);

    for (const wait of [0, 11, 45, 45]) {
      world.ctx.clock.advance(wait * MIN);
      await runDueJobs(world.ctx);
    }
    expect(world.emails).toHaveLength(2);
    expect(await listJobs(world.ctx)).toEqual([]);
    expect(await timeline(world.ctx)).toEqual(before); // no "interrupted" note, no second "sent"
  });

  it('drops an abandoned reminder call instead of ringing twice', async () => {
    const world = await makeWorld({ rules: [DEFAULT_RULES[1]] });
    await book(world, {}, null);
    const [job] = await listJobs(world.ctx);
    world.ctx.clock.set(at(START, -2 * HOUR));
    await claim(world.ctx, `job-${job.id}-0`);
    await runDueJobs(world.ctx);
    world.ctx.clock.advance(11 * MIN);
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 1, remaining: 0 });
    expect(callSpy).not.toHaveBeenCalled();
    expect(await listJobs(world.ctx)).toEqual([]);
    expect(await timelineDetail(world.ctx, 'reminder_call_failed')).toEqual(['interrupted before it finished (not retried, so nobody is called twice)']);
  });
});

// ───────────────────────── direct delivery ─────────────────────────

describe('deliverMessage', () => {
  const job = (over: Partial<StoredJob>): StoredJob => ({
    key: 'jobs/x_job_direct',
    id: 'job_direct',
    type: 'message',
    bookingId: 'bkg_test1',
    dueAt: TEST_NOW,
    attempt: 0,
    createdAt: TEST_NOW,
    ...over,
  });

  it('sends an operational alert about a booking to its hosts, even after a cancellation', async () => {
    const world = await makeWorld();
    await saveBooking(world.ctx, makeBooking({ status: 'cancelled' }));
    const result = await deliverMessage(
      world.ctx,
      job({ channel: 'email', audience: 'host', kind: 'host_alert', subject: '{{invitee_name}} cancelled on the reminder call', body: 'Hi {{host_first_name}},\n\n{{invitee_first_name}} told {{assistant_name}} they cannot make {{event_name}}.' }),
    );
    expect(result).toMatchObject({ ok: true, provider: 'resend', detail: 'to jimi@example.com via resend' });
    expect(world.emails[0].subject).toBe('Sam Rivera cancelled on the reminder call');
    expect(world.emails[0].text).toContain('Sam told Ava they cannot make Intro call.');
  });

  it('sends a site-wide alert to the owner when no booking is involved', async () => {
    const world = await makeWorld();
    await updateHost(world.ctx, 'host_owner', (h) => ({ ...h, notify: { email: false, sms: false } })); // alerts ignore the mute
    await enqueueJob(world.ctx, {
      type: 'message',
      bookingId: '',
      dueAt: TEST_NOW,
      channel: 'email',
      audience: 'host',
      kind: 'host_alert',
      subject: 'Google Calendar needs to be reconnected',
      body: 'Hi {{host_first_name}},\n\nBookings are paused because the calendar connection for {{site_name}} stopped working.',
    });
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(world.emails).toHaveLength(1);
    expect(world.emails[0].to).toEqual(['Jimi Cohen <jimi@example.com>']);
    expect(world.emails[0].subject).toBe('Google Calendar needs to be reconnected');
    expect(world.emails[0].text).toContain('Hi Jimi,\n\nBookings are paused because the calendar connection for Jimi Cohen stopped working.');
    expect(world.emails[0].text).toContain(`Open your dashboard: ${TEST_BASE_URL}/admin`);
    expect(await listJobs(world.ctx)).toEqual([]);
  });

  it('mutes ordinary host email when the host turned it off', async () => {
    const world = await makeWorld();
    await saveBooking(world.ctx, makeBooking());
    await updateHost(world.ctx, 'host_owner', (h) => ({ ...h, notify: { email: false, sms: false } }));
    const result = await deliverMessage(world.ctx, job({ channel: 'email', audience: 'host', kind: 'reminder', hostId: 'host_owner' }));
    expect(result).toMatchObject({ ok: false, skipped: 'host_notifications_off' });
    expect(world.emails).toEqual([]);
  });

  it('texts a host only on their own number and only when they asked for it', async () => {
    const world = await makeWorld();
    await saveBooking(world.ctx, makeBooking({ hostIds: ['host_alex'] }));
    const quiet = await deliverMessage(world.ctx, job({ channel: 'sms', audience: 'host', kind: 'host_new', hostId: 'host_alex' }));
    expect(quiet).toMatchObject({ ok: false, skipped: 'host_notifications_off' });
    await updateHost(world.ctx, 'host_alex', (h) => ({ ...h, notify: { email: true, sms: true } }));
    const sent = await deliverMessage(world.ctx, job({ id: 'job_direct2', channel: 'sms', audience: 'host', kind: 'host_new', hostId: 'host_alex' }));
    expect(sent).toMatchObject({ ok: true, provider: 'twilio' });
    expect(smsSpy.mock.calls[0][1]).toEqual({ to: '+447700900123', body: 'New booking: Sam Rivera for Intro call, Tue, Nov 17, 8:30 PM GMT.', bookingId: 'bkg_test1', kind: 'host_new' });
  });

  it('never phones a host and only phones invitees for reminders', async () => {
    const world = await makeWorld();
    await saveBooking(world.ctx, makeBooking());
    expect(await deliverMessage(world.ctx, job({ channel: 'call', audience: 'host', kind: 'reminder', hostId: 'host_owner' }))).toMatchObject({ skipped: 'unsupported_channel' });
    expect(await deliverMessage(world.ctx, job({ channel: 'call', audience: 'invitee', kind: 'confirmation' }))).toMatchObject({ skipped: 'unsupported_channel' });
    expect(callSpy).not.toHaveBeenCalled();
  });

  it('sends the manage link the assistant promised', async () => {
    const world = await makeWorld();
    await saveBooking(world.ctx, makeBooking());
    const token = hmacHex(world.ctx, 'manage', 'bkg_test1');
    await deliverMessage(world.ctx, job({ channel: 'sms', audience: 'invitee', kind: 'manage_link' }));
    const text = smsSpy.mock.calls[0][1].body;
    expect(text).toBe(
      `Hi Sam, here is your link to reschedule or cancel your Intro call with Jimi Cohen on Tue, Nov 17, 11:30 PM GMT+3: ${TEST_BASE_URL}/booking/bkg_test1?t=${token}`,
    );
    expect(text.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);

    await deliverMessage(world.ctx, job({ id: 'job_direct3', channel: 'email', audience: 'invitee', kind: 'manage_link' }));
    expect(world.emails[0].subject).toBe('Your link to change Intro call with Jimi Cohen');
    expect(world.emails[0].html).toContain('>Reschedule</a>');
  });

  it('offers a one-tap "I\'ll be there" on reminders that have no video link', async () => {
    const world = await makeWorld();
    await saveBooking(world.ctx, makeBooking({ location: { type: 'in_person', label: 'In person', value: '12 Riverside Drive' } }));
    const token = hmacHex(world.ctx, 'manage', 'bkg_test1');
    await deliverMessage(world.ctx, job({ channel: 'email', audience: 'invitee', kind: 'reminder' }));
    expect(world.emails[0].text).toContain(`I'll be there: ${TEST_BASE_URL}/booking/bkg_test1?t=${token}&confirm=1`);
    expect(world.emails[0].text).toContain('Where: In person: 12 Riverside Drive');
  });

  it('skips cleanly when the booking or the host is gone', async () => {
    const world = await makeWorld();
    expect(await deliverMessage(world.ctx, job({ channel: 'email', audience: 'invitee', kind: 'reminder' }))).toMatchObject({ ok: false, skipped: 'booking_missing' });
    await saveBooking(world.ctx, makeBooking());
    expect(await deliverMessage(world.ctx, job({ channel: 'email', audience: 'host', kind: 'reminder', hostId: 'host_deleted' }))).toMatchObject({ skipped: 'host_missing' });
  });
});

describe('composeSms', () => {
  const manage = { label: 'Change or cancel:', url: `https://jimicohen.com/meeting/booking/bkg_abcdefghijklmnop?t=${'a'.repeat(64)}` };
  const join = { label: 'Join:', url: MEET };

  it('appends the links after the wording', () => {
    expect(composeSms('Hi Sam,  see you\ntoday.', [join])).toBe(`Hi Sam, see you today. Join: ${MEET}`);
  });

  it('does not repeat a link the wording already contains', () => {
    expect(composeSms(`Join here: ${MEET}`, [join, manage])).toBe(`Join here: ${MEET} Change or cancel: ${manage.url}`);
  });

  it('drops the closing note first when space is tight', () => {
    const prose = 'x'.repeat(150);
    expect(composeSms('short', [manage], { tail: 'Reply STOP to opt out.' })).toBe(`short Change or cancel: ${manage.url} Reply STOP to opt out.`);
    const out = composeSms(prose, [manage], { tail: 'Reply STOP to opt out.' });
    expect(out).toBe(`${prose} Change or cancel: ${manage.url}`);
    expect(out.length).toBeLessThanOrEqual(300);
  });

  it('shortens the wording at a word boundary rather than cutting a link', () => {
    const prose = `Hi Sam, a reminder: ${'very '.repeat(40)}long event name with Jimi Cohen is today at 3:30 PM EST.`;
    const out = composeSms(prose, [manage, join]);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain(` Change or cancel: ${manage.url}`);
    expect(out.startsWith('Hi Sam, a reminder: very very')).toBe(true);
    expect(out).toMatch(/very\.\.\. Change or cancel:/);
  });

  it('gives up the last link in the list before the wording becomes unreadable', () => {
    const longJoin = { label: 'Join:', url: `https://zoom.example/j/1234567890?pwd=${'p'.repeat(90)}` };
    const prose = 'Hi Sam, a reminder: Intro call with Jimi Cohen is today at 3:30 PM EST. Please be on time.';
    const out = composeSms(prose, [manage, longJoin]);
    expect(out).toBe(`${prose} Change or cancel: ${manage.url}`);
    expect(composeSms(prose, [longJoin, manage])).toBe(`${prose} Join: ${longJoin.url}`);
  });

  it('never exceeds the limit even with nothing but wording', () => {
    const out = composeSms('word '.repeat(200), []);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('...')).toBe(true);
    expect(composeSms('short', [], { max: 160 })).toBe('short');
  });
});

// ───────────────────────── reminder calls inside calling hours ─────────────────────────

describe('planCallTime', () => {
  const NY = 'America/New_York';
  const local = (text: string, tz = NY) => DateTime.fromISO(text, { zone: tz }).toMillis();
  const plan = (startText: string, offsetMin: number, opts: { now?: string; tz?: string; hours?: { callWindowStartHour: number; callWindowEndHour: number } } = {}) => {
    const tz = opts.tz ?? NY;
    const startMs = local(startText, tz);
    const ms = planCallTime({ idealMs: startMs - offsetMin * MIN, startMs, nowMs: opts.now ? local(opts.now, tz) : Date.parse(TEST_NOW), timezone: tz, hours: opts.hours });
    return ms === null ? null : DateTime.fromMillis(ms, { zone: tz }).toFormat("yyyy-MM-dd'T'HH:mm");
  };

  it('keeps the rule time when it is already inside calling hours', () => {
    expect(plan('2026-11-18T14:00', 120)).toBe('2026-11-18T12:00');
    expect(plan('2026-11-18T10:00', 120)).toBe('2026-11-18T08:00'); // the opening hour counts
  });

  it('rings when calling hours open when that still leaves half an hour before the meeting', () => {
    expect(plan('2026-11-18T09:00', 120)).toBe('2026-11-18T08:00');
    expect(plan('2026-11-18T09:30', 120)).toBe('2026-11-18T08:00');
    expect(plan('2026-11-18T08:30', 120)).toBe('2026-11-18T08:00');
  });

  it('rings in the last calling hour of the evening before when the morning is too tight', () => {
    expect(plan('2026-11-18T08:15', 120)).toBe('2026-11-17T20:00');
    expect(plan('2026-11-18T06:00', 60)).toBe('2026-11-17T20:00');
  });

  it('moves a call that would come after calling hours close back into the last hour', () => {
    expect(plan('2026-11-18T23:30', 120)).toBe('2026-11-18T20:00');
  });

  it('plans no call when no time inside calling hours is left before the meeting', () => {
    expect(plan('2026-11-18T08:15', 120, { now: '2026-11-18T06:00' })).toBeNull();
    expect(plan('2026-11-18T14:00', 120, { hours: { callWindowStartHour: 9, callWindowEndHour: 9 } })).toBeNull();
    expect(planCallTime({ idealMs: local('2026-11-18T07:00'), startMs: local('2026-11-18T09:00'), nowMs: 0, timezone: 'Mars/Olympus' })).toBeNull();
  });

  it('follows the calling hours from settings, including a window that runs past midnight', () => {
    expect(plan('2026-11-18T09:00', 120, { hours: { callWindowStartHour: 9, callWindowEndHour: 17 } })).toBe('2026-11-17T16:00');
    expect(plan('2026-11-18T12:00', 120, { hours: { callWindowStartHour: 20, callWindowEndHour: 2 } })).toBe('2026-11-18T01:00');
    expect(plan('2026-11-18T21:00', 120, { hours: { callWindowStartHour: 20, callWindowEndHour: 2 } })).toBe('2026-11-18T20:00');
    expect(plan('2026-11-18T03:00', 60, { hours: { callWindowStartHour: 20, callWindowEndHour: 2 } })).toBe('2026-11-18T01:00');
    expect(plan('2026-11-18T07:00', 60, { hours: { callWindowStartHour: 8, callWindowEndHour: 24 } })).toBe('2026-11-17T23:00');
  });

  it('works on the invitee clock across daylight saving changes', () => {
    expect(plan('2027-03-14T09:00', 120)).toBe('2027-03-14T08:00'); // clocks go forward at 2 AM
    expect(plan('2027-03-14T08:15', 120)).toBe('2027-03-13T20:00');
    expect(plan('2027-11-07T09:00', 120)).toBe('2027-11-07T08:00'); // clocks go back at 2 AM
    expect(plan('2027-11-07T08:15', 120)).toBe('2027-11-06T20:00');
    expect(plan('2026-11-18T09:00', 120, { tz: 'America/Los_Angeles' })).toBe('2026-11-18T08:00');
    expect(plan('2026-11-18T07:00', 120, { tz: 'America/Los_Angeles' })).toBe('2026-11-17T20:00');
  });

  it('only ever returns a time inside calling hours', () => {
    const hours = [
      { callWindowStartHour: 8, callWindowEndHour: 21 },
      { callWindowStartHour: 21, callWindowEndHour: 6 },
      { callWindowStartHour: 0, callWindowEndHour: 24 },
      { callWindowStartHour: 12, callWindowEndHour: 13 },
    ];
    for (const h of hours) {
      for (let hour = 0; hour < 48; hour++) {
        const startMs = local('2026-11-18T00:00') + hour * HOUR + 15 * MIN;
        const ms = planCallTime({ idealMs: startMs - 2 * HOUR, startMs, nowMs: Date.parse(TEST_NOW), timezone: NY, hours: h });
        if (ms !== null) {
          expect(insideCallHours(ms, NY, h), `${JSON.stringify(h)} start ${hour}`).toBe(true);
          expect(ms).toBeLessThan(startMs);
        }
      }
    }
  });
});

describe('scheduleBookingJobs: reminder calls', () => {
  const NY = 'America/New_York';
  const iso = (text: string, tz = NY) => DateTime.fromISO(text, { zone: tz }).toUTC().toISO()!;
  const callOnly = () => makeWorld({ rules: [DEFAULT_RULES[1]] });

  it('plans the default call for a 9 AM meeting at 8 AM and places it then', async () => {
    const world = await callOnly();
    const start = iso('2026-11-18T09:00');
    await book(world, { start, end: at(start, 30 * MIN), invitee: { ...makeBooking().invitee, timezone: NY } }, null);
    expect(await queue(world.ctx)).toEqual([`reminder/call/invitee @ ${iso('2026-11-18T08:00')}`]);
    world.ctx.clock.set(iso('2026-11-18T08:00'));
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(await timeline(world.ctx)).toContain('reminder_call_sent');
  });

  it('uses the invitee zone and the calling hours from settings', async () => {
    const world = await callOnly();
    const site = await getSite(world.ctx);
    await saveSite(world.ctx, { ...site, assistant: { ...site.assistant, callWindowStartHour: 9, callWindowEndHour: 18 } });
    const start = iso('2026-11-18T09:15', 'America/Los_Angeles'); // 9 AM opening is too close: the evening before
    await book(world, { start, end: at(start, 30 * MIN), invitee: { ...makeBooking().invitee, timezone: 'America/Los_Angeles' } }, null);
    expect(await queue(world.ctx)).toEqual([`reminder/call/invitee @ ${iso('2026-11-17T17:00', 'America/Los_Angeles')}`]);
  });

  const calls = async (ctx: TestCtx) => (await queue(ctx)).filter((j) => j.includes('/call/'));
  const inNewYork = { ...makeBooking().invitee, timezone: NY };

  it('notes once on the booking when a call has no time left before the meeting', async () => {
    const world = await callOnly();
    const start = iso('2026-11-16T08:15'); // TEST_NOW is 4 AM in New York that day; calling hours open at 8
    const booking = await book(world, { start, end: at(start, 30 * MIN), invitee: inNewYork }, 'created');
    expect(await calls(world.ctx)).toEqual([]);
    await scheduleBookingJobs(world.ctx, booking, world.eventType, null); // planned again, as after a change to the rules
    await scheduleBookingJobs(world.ctx, booking, world.eventType, 'created');
    expect(await timelineDetail(world.ctx, 'reminder_call_skipped')).toEqual(['the only time inside calling hours before the meeting is in the half hour before it starts']);
  });

  it('says there is no time when calling hours do not open at all before the meeting', async () => {
    const world = await callOnly();
    const start = iso('2026-11-16T07:00'); // booked at 4 AM: calling hours open at 8, after the start
    await book(world, { start, end: at(start, 30 * MIN), invitee: inNewYork }, 'created');
    expect(await calls(world.ctx)).toEqual([]);
    expect(await timelineDetail(world.ctx, 'reminder_call_skipped')).toEqual(['there is no time inside calling hours before the meeting']);
  });

  it('does not call minutes after a late evening booking for an early meeting, and says that was the only time', async () => {
    const world = await callOnly();
    world.ctx.clock.set(iso('2026-11-16T20:30')); // calling hours close at 9 PM
    const start = iso('2026-11-17T06:15');
    await book(world, { start, end: at(start, 30 * MIN), invitee: inNewYork }, 'created');
    expect(await calls(world.ctx)).toEqual([]);
    expect(await timelineDetail(world.ctx, 'reminder_call_skipped')).toEqual(['the only time inside calling hours before the meeting was right after booking']);
  });

  it('does not call a minute after an evening booking for an early meeting either, while an earlier booking still gets its call', async () => {
    // Calling hours 8 AM to 9 PM in New York: the last calling hour before a 7 AM meeting starts at 8 PM the evening before.
    const start = iso('2026-11-17T07:00');
    const justBefore = await callOnly();
    justBefore.ctx.clock.set(iso('2026-11-16T19:59'));
    await book(justBefore, { start, end: at(start, 30 * MIN), invitee: inNewYork }, 'created');
    expect(await calls(justBefore.ctx)).toEqual([]);
    expect(await timelineDetail(justBefore.ctx, 'reminder_call_skipped')).toEqual(['the only time inside calling hours before the meeting was right after booking']);

    const justAfter = await callOnly();
    justAfter.ctx.clock.set(iso('2026-11-16T20:00:30'));
    await book(justAfter, { start, end: at(start, 30 * MIN), invitee: inNewYork }, 'created');
    expect(await calls(justAfter.ctx)).toEqual([]);
    expect(await timelineDetail(justAfter.ctx, 'reminder_call_skipped')).toEqual(['the only time inside calling hours before the meeting was right after booking']);

    const earlier = await callOnly();
    earlier.ctx.clock.set(iso('2026-11-16T18:59'));
    await book(earlier, { start, end: at(start, 30 * MIN), invitee: inNewYork }, 'created');
    expect(await calls(earlier.ctx)).toEqual([`reminder/call/invitee @ ${iso('2026-11-16T20:00')}`]);
    expect(await timelineDetail(earlier.ctx, 'reminder_call_skipped')).toEqual([]);
  });

  it('words the note for a move, and for a meeting that also starts just after calling hours open', async () => {
    const moved = await callOnly();
    moved.ctx.clock.set(iso('2026-11-16T20:30'));
    const early = iso('2026-11-17T06:15');
    await book(moved, { start: early, end: at(early, 30 * MIN), invitee: inNewYork, rescheduleCount: 1 }, 'rescheduled');
    expect(await timelineDetail(moved.ctx, 'reminder_call_skipped')).toEqual(['the only time inside calling hours before the meeting was right after the meeting was moved']);

    const both = await callOnly();
    both.ctx.clock.set(iso('2026-11-16T20:30'));
    const start = iso('2026-11-17T08:10');
    await book(both, { start, end: at(start, 30 * MIN), invitee: inNewYork }, 'created');
    expect(await calls(both.ctx)).toEqual([]);
    expect(await timelineDetail(both.ctx, 'reminder_call_skipped')).toEqual([
      'the only times inside calling hours before the meeting were right after booking and in the half hour before it starts',
    ]);
  });

  it('keeps the evening call of a booking made days ago when the rules are planned again in the hour before it', async () => {
    // Booked at 4 AM (TEST_NOW) for 7 AM the next day: the call goes in the last calling hour, 8 PM the evening before.
    const world = await callOnly();
    const start = iso('2026-11-17T07:00');
    const booking = await book(world, { start, end: at(start, 30 * MIN), invitee: inNewYork }, 'created');
    expect(await calls(world.ctx)).toEqual([`reminder/call/invitee @ ${iso('2026-11-16T20:00')}`]);
    // 7:15 PM: the owner changes a reminder of the meeting type, so every reminder is planned again.
    world.ctx.clock.set(iso('2026-11-16T19:15'));
    await scheduleBookingJobs(world.ctx, booking, world.eventType, null);
    expect(await calls(world.ctx)).toEqual([`reminder/call/invitee @ ${iso('2026-11-16T20:00')}`]);
    expect(await timelineDetail(world.ctx, 'reminder_call_skipped')).toEqual([]);
  });

  it('still keeps the call off a booking made minutes before the evening call when the rules are planned again', async () => {
    const world = await callOnly();
    world.ctx.clock.set(iso('2026-11-16T19:15'));
    const start = iso('2026-11-17T07:00');
    const booking = await book(world, { start, end: at(start, 30 * MIN), invitee: inNewYork, createdAt: iso('2026-11-16T19:15'), timeline: [] }, 'created');
    expect(await calls(world.ctx)).toEqual([]);
    world.ctx.clock.set(iso('2026-11-16T19:20'));
    await scheduleBookingJobs(world.ctx, booking, world.eventType, null);
    expect(await calls(world.ctx)).toEqual([]);
    expect(await timelineDetail(world.ctx, 'reminder_call_skipped')).toEqual(['the only time inside calling hours before the meeting was right after booking']);

    // A rule added after a move names the move.
    const moved = await callOnly();
    moved.ctx.clock.set(iso('2026-11-16T19:20'));
    const later = { ...moved.eventType, reminders: [DEFAULT_RULES[1]] };
    const movedBooking = makeBooking({ start, end: at(start, 30 * MIN), invitee: inNewYork, rescheduleCount: 1, timeline: [{ at: TEST_NOW, type: 'created' }, { at: iso('2026-11-16T19:10'), type: 'rescheduled' }] });
    await saveBooking(moved.ctx, movedBooking);
    await scheduleBookingJobs(moved.ctx, movedBooking, later, null);
    expect(await calls(moved.ctx)).toEqual([]);
    expect(await timelineDetail(moved.ctx, 'reminder_call_skipped')).toEqual(['the only time inside calling hours before the meeting was right after the meeting was moved']);
  });

  it('says nothing when the booking is planned again after its call already rang', async () => {
    const world = await callOnly();
    const start = iso('2026-11-17T08:15');
    const booking = await book(world, { start, end: at(start, 30 * MIN), invitee: inNewYork }, null);
    expect(await calls(world.ctx)).toEqual([`reminder/call/invitee @ ${iso('2026-11-16T20:00')}`]);
    world.ctx.clock.set(iso('2026-11-16T20:00'));
    await runDueJobs(world.ctx);
    expect(callSpy).toHaveBeenCalledTimes(1);
    world.ctx.clock.set(iso('2026-11-16T21:30')); // the rules are changed after the call
    await scheduleBookingJobs(world.ctx, (await getBooking(world.ctx, booking.id))!, world.eventType, null);
    expect(await calls(world.ctx)).toEqual([]);
    expect(await timeline(world.ctx)).not.toContain('reminder_call_skipped');
  });
});

// ───────────────────────── calls move with the calling hours ─────────────────────────

describe('planMissedReminderCalls', () => {
  const NY = 'America/New_York';
  const iso = (text: string, tz = NY) => DateTime.fromISO(text, { zone: tz }).toUTC().toISO()!;
  const inNewYork = { ...makeBooking().invitee, timezone: NY };
  const NARROW = { callWindowStartHour: 9, callWindowEndHour: 10 };
  const WIDE = { callWindowStartHour: 5, callWindowEndHour: 21 };
  const callJobs = async (ctx: TestCtx) => (await listJobs(ctx)).filter((j) => j.channel === 'call');

  /** A 7 AM meeting booked at noon the day before, while calling hours are 9 to 10: its call (2 hours before) gets no time. */
  async function skippedCall(over: Partial<Booking> = {}): Promise<{ world: World; booking: Booking }> {
    const world = await makeWorld({ rules: [DEFAULT_RULES[1]], now: iso('2026-11-17T12:00') });
    const site = await getSite(world.ctx);
    await saveSite(world.ctx, { ...site, assistant: { ...site.assistant, ...NARROW } });
    const start = iso('2026-11-18T07:00');
    const booking = await book(world, { start, end: at(start, 30 * MIN), invitee: inNewYork, ...over }, 'created');
    await mutateBookingIndex(world.ctx, (entries) => [...entries, indexEntryOf(booking)]);
    expect(await callJobs(world.ctx)).toEqual([]);
    return { world, booking };
  }

  it('plans the call once wider calling hours leave a time for it, and it rings once', async () => {
    const { world, booking } = await skippedCall();
    expect(await timelineDetail(world.ctx, 'reminder_call_skipped', booking.id)).toHaveLength(1);
    const site = await getSite(world.ctx);
    await saveSite(world.ctx, { ...site, assistant: { ...site.assistant, ...WIDE } });
    expect(await planMissedReminderCalls(world.ctx, WIDE)).toEqual({ planned: 1, failed: 0, left: 0 });
    // A second pass for the same hours finds it in place.
    expect(await planMissedReminderCalls(world.ctx, WIDE)).toEqual({ planned: 0, failed: 0, left: 0 });
    const calls = await callJobs(world.ctx);
    expect(calls.map((j) => [j.bookingId, j.ruleId, j.dueAt])).toEqual([[booking.id, 'rem_call_2h', iso('2026-11-18T05:00')]]);
    world.ctx.clock.set(iso('2026-11-18T05:00'));
    await runDueJobs(world.ctx);
    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  it('plans nothing for a booking that was called already, has no consent to calls, or has its call queued', async () => {
    const called = await skippedCall({ timeline: [{ at: TEST_NOW, type: 'created' }, { at: TEST_NOW, type: 'reminder_call_sent' }] });
    expect(await planMissedReminderCalls(called.world.ctx, WIDE)).toEqual({ planned: 0, failed: 0, left: 0 });
    expect(await callJobs(called.world.ctx)).toEqual([]);

    const noConsent = await skippedCall({ consent: { sms: true, call: false, at: TEST_NOW, text: 'consent text' } });
    expect(await planMissedReminderCalls(noConsent.world.ctx, WIDE)).toEqual({ planned: 0, failed: 0, left: 0 });
    expect(await callJobs(noConsent.world.ctx)).toEqual([]);

    // A booking whose call is queued is the move pass's (replanReminderCalls), never planned a second time here.
    const world = await makeWorld({ rules: [DEFAULT_RULES[1]] });
    const start = iso('2026-11-18T10:00');
    const queued = await book(world, { start, end: at(start, 30 * MIN), invitee: inNewYork }, null);
    await mutateBookingIndex(world.ctx, (entries) => [...entries, indexEntryOf(queued)]);
    expect(await callJobs(world.ctx)).toHaveLength(1);
    expect(await planMissedReminderCalls(world.ctx, WIDE)).toEqual({ planned: 0, failed: 0, left: 0 });
    expect(await callJobs(world.ctx)).toHaveLength(1);
  });

  it('plans no second call for a booking whose call was cut off while it was being placed', async () => {
    // A 7 AM meeting, its call (2 hours before) in the last calling hour the evening before, at 8 PM.
    const world = await makeWorld({ rules: [DEFAULT_RULES[1]], now: iso('2026-11-17T12:00') });
    const start = iso('2026-11-18T07:00');
    const booking = await book(world, { start, end: at(start, 30 * MIN), invitee: inNewYork }, null);
    await mutateBookingIndex(world.ctx, (entries) => [...entries, indexEntryOf(booking)]);
    const [call] = await callJobs(world.ctx);
    expect(call.dueAt).toBe(iso('2026-11-17T20:00'));
    // 8 PM: a run takes the call and is cut off while placing it. The phone may have rung, so the runner
    // gives it up rather than ring again.
    world.ctx.clock.set(iso('2026-11-17T20:00'));
    expect(await claim(world.ctx, `job-${call.id}-0`)).toBe(true);
    await runDueJobs(world.ctx);
    world.ctx.clock.set(iso('2026-11-17T20:11'));
    await runDueJobs(world.ctx);
    expect(await callJobs(world.ctx)).toEqual([]);
    expect(await timelineDetail(world.ctx, 'reminder_call_failed', booking.id)).toEqual(['interrupted before it finished (not retried, so nobody is called twice)']);
    // 8:30 PM: the owner opens calling hours at 5 AM. The 5 AM time now fits, but this booking may have been called.
    world.ctx.clock.set(iso('2026-11-17T20:30'));
    const site = await getSite(world.ctx);
    await saveSite(world.ctx, { ...site, assistant: { ...site.assistant, ...WIDE } });
    expect(await planMissedReminderCalls(world.ctx, WIDE)).toEqual({ planned: 0, failed: 0, left: 0 });
    expect(await callJobs(world.ctx)).toEqual([]);
    world.ctx.clock.set(iso('2026-11-18T05:00'));
    await runDueJobs(world.ctx);
    expect(callSpy).not.toHaveBeenCalled();
  });
});

describe('replanReminderCalls', () => {
  const NY = 'America/New_York';
  const iso = (text: string, tz = NY) => DateTime.fromISO(text, { zone: tz }).toUTC().toISO()!;
  const inNewYork = { ...makeBooking().invitee, timezone: NY };
  const NINE_TO_NINE = { callWindowStartHour: 9, callWindowEndHour: 21 };

  /** A world with only the default call rule and one booking per start time, each with its call queued. */
  async function withCalls(starts: string[]): Promise<World> {
    const world = await makeWorld({ rules: [DEFAULT_RULES[1]] });
    for (const [i, start] of starts.entries()) await book(world, { id: `bkg_call${i}`, start: iso(start), end: at(iso(start), 30 * MIN), invitee: inNewYork }, null);
    return world;
  }

  const callJobs = async (ctx: TestCtx) => (await listJobs(ctx)).filter((j) => j.channel === 'call').map((j) => [j.bookingId, j.id, j.dueAt]);

  it('moves a call queued for 8 AM to 9 AM when calling hours start at 9, keeping the job', async () => {
    const world = await withCalls(['2026-11-18T10:00']);
    const [before] = await listJobs(world.ctx);
    expect(before.dueAt).toBe(iso('2026-11-18T08:00'));

    expect(await replanReminderCalls(world.ctx, NINE_TO_NINE)).toEqual({ moved: 1, failed: 0, left: 0 });
    expect(await callJobs(world.ctx)).toEqual([['bkg_call0', before.id, iso('2026-11-18T09:00')]]);
    expect(await world.ctx.kv.getJSON(before.key)).toBeNull();

    // It rings once, at the new time.
    world.ctx.clock.set(iso('2026-11-18T08:00'));
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 0, failed: 0, remaining: 0 });
    world.ctx.clock.set(iso('2026-11-18T09:00'));
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  it('moves a call of a booking made days ago to the evening before, also when the hours change in the hour before it', async () => {
    // An 8:45 AM meeting: its call (2 hours before, 6:45) waits for calling hours to open at 8.
    const world = await withCalls(['2026-11-18T08:45']);
    const [before] = await listJobs(world.ctx);
    expect(before.dueAt).toBe(iso('2026-11-18T08:00'));
    // 7:15 PM the evening before, calling hours change to 9 AM to 9 PM: 9 AM is too close to the start, so the
    // call goes to the last calling hour before it, 8 PM, as it would have if the hours had changed earlier.
    world.ctx.clock.set(iso('2026-11-17T19:15'));
    expect(await replanReminderCalls(world.ctx, NINE_TO_NINE)).toEqual({ moved: 1, failed: 0, left: 0 });
    expect(await callJobs(world.ctx)).toEqual([['bkg_call0', before.id, iso('2026-11-17T20:00')]]);
  });

  it('moves calls back out again, and leaves calls the new hours do not change', async () => {
    const world = await withCalls(['2026-11-18T10:00', '2026-11-18T15:00']);
    await replanReminderCalls(world.ctx, NINE_TO_NINE);
    expect(await replanReminderCalls(world.ctx, { callWindowStartHour: 8, callWindowEndHour: 21 })).toEqual({ moved: 1, failed: 0, left: 1 });
    expect((await callJobs(world.ctx)).map((j) => j[2])).toEqual([iso('2026-11-18T08:00'), iso('2026-11-18T13:00')]);
  });

  it('leaves a run cut off part-way with the calls it did not reach at their old time', async () => {
    const world = await withCalls(['2026-11-18T10:00', '2026-11-19T10:00', '2026-11-20T10:00']);
    const before = await callJobs(world.ctx);
    // Each write takes a second of a two second budget: the run stops after the second call.
    const realPut = repo.putJob;
    const slow = vi.spyOn(repo, 'putJob').mockImplementation(async (ctx, job, opts) => {
      world.ctx.clock.advance(1000);
      return realPut(ctx, job, opts);
    });
    expect(await replanReminderCalls(world.ctx, NINE_TO_NINE, { budgetMs: 2000 })).toEqual({ moved: 2, failed: 0, left: 1 });
    slow.mockRestore();
    const after = await callJobs(world.ctx);
    expect(after.map((j) => j[0])).toEqual(['bkg_call0', 'bkg_call1', 'bkg_call2']); // every booking still has its call
    expect(after.map((j) => j[2])).toEqual([iso('2026-11-18T09:00'), iso('2026-11-19T09:00'), before[2][2]]);
    expect(after.map((j) => j[1])).toEqual(before.map((j) => j[1]));
  });

  it('keeps the old call when the new one cannot be written', async () => {
    const world = await withCalls(['2026-11-18T10:00']);
    const before = await callJobs(world.ctx);
    const broken = vi.spyOn(repo, 'putJob').mockRejectedValueOnce(new Error('storage hiccup'));
    const errors: string[] = [];
    expect(await replanReminderCalls(world.ctx, NINE_TO_NINE, { onError: (id) => errors.push(id) })).toEqual({ moved: 0, failed: 1, left: 0 });
    broken.mockRestore();
    expect(errors).toEqual([before[0][1]]);
    expect(await callJobs(world.ctx)).toEqual(before);
  });

  it('leaves alone calls that are retried, for a moved meeting, or left without a time by the new hours', async () => {
    const world = await withCalls(['2026-11-18T10:00', '2026-11-18T10:30', '2026-11-18T10:15', '2026-11-16T09:15']);
    const jobs = (await listJobs(world.ctx)) as StoredJob[];
    const byBooking = (id: string) => jobs.find((j) => j.bookingId === id)!;
    // a retry of a call that failed
    const retry = byBooking('bkg_call1');
    await repo.deleteJob(world.ctx, retry.key);
    await putJob(world.ctx, { ...retry, attempt: 1 });
    // a meeting moved since its call was planned (the runner drops that call)
    await repo.updateBooking(world.ctx, 'bkg_call2', (b) => ({ ...b, start: iso('2026-11-18T12:30'), end: iso('2026-11-18T13:00') }));
    // TEST_NOW is 4 AM: the 9:15 meeting's call at 8 AM finds no time under 9 to 9 hours and stays for the runner to skip
    const before = await callJobs(world.ctx);
    // (A retry is not even looked at; the moved meeting and the call with no time are looked at and left.)
    expect(await replanReminderCalls(world.ctx, NINE_TO_NINE)).toEqual({ moved: 1, failed: 0, left: 2 });
    const after = await callJobs(world.ctx);
    expect(after.find((j) => j[0] === 'bkg_call0')?.[2]).toBe(iso('2026-11-18T09:00'));
    for (const id of ['bkg_call1', 'bkg_call2', 'bkg_call3']) expect(after.find((j) => j[0] === id)).toEqual(before.find((j) => j[0] === id));
  });

  it('leaves a call that is due already to the runner', async () => {
    const world = await withCalls(['2026-11-18T10:00']);
    const before = await callJobs(world.ctx);
    world.ctx.clock.set(iso('2026-11-18T08:00'));
    expect(await replanReminderCalls(world.ctx, NINE_TO_NINE)).toEqual({ moved: 0, failed: 0, left: 0 });
    expect(await callJobs(world.ctx)).toEqual(before);
  });

  it('does not bring back a call that was planned again while it ran, so nobody is called twice', async () => {
    const world = await withCalls(['2026-11-18T10:00']);
    const [old] = await callJobs(world.ctx);
    // The settings route saves the new hours first, then moves the calls in the background.
    const site = await getSite(world.ctx);
    await saveSite(world.ctx, { ...site, assistant: { ...site.assistant, ...NINE_TO_NINE } });
    // Meanwhile the event type's rules are saved too: its bookings are planned again, with a fresh call.
    const realGetBookings = repo.getBookings;
    const spy = vi.spyOn(repo, 'getBookings').mockImplementation(async (ctx, ids) => {
      const found = await realGetBookings(ctx, ids);
      await replanBookingReminders(world.ctx, found, world.eventType);
      return found;
    });
    expect(await replanReminderCalls(world.ctx, NINE_TO_NINE)).toEqual({ moved: 0, failed: 0, left: 1 });
    spy.mockRestore();
    const after = await callJobs(world.ctx);
    expect(after).toHaveLength(1);
    expect(after[0][1]).not.toBe(old[1]);
    expect(after[0][2]).toBe(iso('2026-11-18T09:00'));
    world.ctx.clock.set(iso('2026-11-18T09:00'));
    await runDueJobs(world.ctx);
    world.ctx.clock.set(iso('2026-11-18T09:20'));
    await runDueJobs(world.ctx);
    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  it('does not ring straight away when the rule moment has gone by and the old time still fits the new hours', async () => {
    // Planned under 9 to 9 hours: the 8 AM moment of a 10 AM meeting's call moved to 9.
    const world = await makeWorld({ rules: [DEFAULT_RULES[1]] });
    const site = await getSite(world.ctx);
    await saveSite(world.ctx, { ...site, assistant: { ...site.assistant, ...NINE_TO_NINE } });
    const start = iso('2026-11-18T10:00');
    await book(world, { id: 'bkg_call0', start, end: at(start, 30 * MIN), invitee: inNewYork }, null);
    expect((await callJobs(world.ctx)).map((j) => j[2])).toEqual([iso('2026-11-18T09:00')]);
    // At 8:30 the hours go back to 8 AM to 9 PM: 8 AM has passed, and 9 AM is still inside the hours.
    world.ctx.clock.set(iso('2026-11-18T08:30'));
    expect(await replanReminderCalls(world.ctx, { callWindowStartHour: 8, callWindowEndHour: 21 })).toEqual({ moved: 0, failed: 0, left: 1 });
    expect((await callJobs(world.ctx)).map((j) => j[2])).toEqual([iso('2026-11-18T09:00')]);
    // Hours that no longer include 9 AM: the call moves to now, still inside them, rather than being skipped at 9.
    expect(await replanReminderCalls(world.ctx, { callWindowStartHour: 8, callWindowEndHour: 9 })).toEqual({ moved: 1, failed: 0, left: 0 });
    expect((await callJobs(world.ctx)).map((j) => j[2])).toEqual([iso('2026-11-18T08:30')]);
  });
});

// ───────────────────────── daily limits on texts ─────────────────────────

describe('deliverMessage: daily limit on texts to invitees', () => {
  const textJob = (n: number, over: Partial<StoredJob> = {}): StoredJob => ({
    key: `jobs/x_job_text${n}`,
    id: `job_text${n}`,
    type: 'message',
    bookingId: 'bkg_test1',
    dueAt: TEST_NOW,
    attempt: 0,
    createdAt: TEST_NOW,
    channel: 'sms',
    audience: 'invitee',
    kind: 'reminder',
    ...over,
  });

  it('stops after six texts a day to one number, as a skip that is not retried', async () => {
    const world = await makeWorld({ rules: [] });
    await saveBooking(world.ctx, makeBooking());
    for (let n = 0; n < 6; n++) expect(await deliverMessage(world.ctx, textJob(n))).toMatchObject({ ok: true });
    expect(await deliverMessage(world.ctx, textJob(6))).toMatchObject({ ok: false, provider: 'none', skipped: 'daily_limit' });
    expect(smsSpy).toHaveBeenCalledTimes(6);

    // another invitee's number has its own allowance, and the host's own texts are not counted
    await saveBooking(world.ctx, makeBooking({ id: 'bkg_other', invitee: { ...makeBooking().invitee, phone: '+254700000002' } }));
    expect(await deliverMessage(world.ctx, textJob(7, { bookingId: 'bkg_other' }))).toMatchObject({ ok: true });
    await saveBooking(world.ctx, makeBooking({ hostIds: ['host_alex'] }));
    await updateHost(world.ctx, 'host_alex', (h) => ({ ...h, phone: '+254700000001', notify: { email: true, sms: true } }));
    expect(await deliverMessage(world.ctx, textJob(8, { audience: 'host', hostId: 'host_alex', kind: 'host_new' }))).toMatchObject({ ok: true });

    // a new day, a new allowance
    world.ctx.clock.advance(24 * HOUR);
    expect(await deliverMessage(world.ctx, textJob(9))).toMatchObject({ ok: true });
  });

  it('records the capped text on the timeline and does not retry it', async () => {
    const world = await makeWorld({ rules: [] });
    await saveBooking(world.ctx, makeBooking());
    for (let n = 0; n < 6; n++) await deliverMessage(world.ctx, textJob(n));
    await enqueueJob(world.ctx, { type: 'message', bookingId: 'bkg_test1', dueAt: TEST_NOW, channel: 'sms', audience: 'invitee', kind: 'reminder' });
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(await queue(world.ctx)).toEqual([]);
    expect(await timelineDetail(world.ctx, 'reminder_sms_skipped')).toEqual(['the daily limit of texts or calls was reached']);
  });
});

// ───────────────────────── a text Twilio did not answer for ─────────────────────────

describe('deliverMessage: a text Twilio may have sent', () => {
  const timedOut = { ok: false, provider: 'twilio', error: 'Twilio did not answer in time', uncertain: true };

  it('tells Twilio which booking and which message a text is, for its delivery report', async () => {
    const world = await makeWorld({ rules: [] });
    await saveBooking(world.ctx, makeBooking());
    await enqueueJob(world.ctx, { type: 'message', bookingId: 'bkg_test1', dueAt: TEST_NOW, channel: 'sms', audience: 'invitee', kind: 'reminder' });
    await runDueJobs(world.ctx);
    expect(smsSpy).toHaveBeenCalledWith(world.ctx, expect.objectContaining({ to: '+254700000001', bookingId: 'bkg_test1', kind: 'reminder' }));
  });

  it('counts a reminder as sent and never texts it a second time', async () => {
    const world = await makeWorld({ rules: [] });
    await saveBooking(world.ctx, makeBooking());
    smsSpy.mockResolvedValue(timedOut);
    await enqueueJob(world.ctx, { type: 'message', bookingId: 'bkg_test1', dueAt: TEST_NOW, channel: 'sms', audience: 'invitee', kind: 'reminder' });
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(await queue(world.ctx)).toEqual([]);
    expect(await timelineDetail(world.ctx, 'reminder_sms_sent')).toEqual([
      'to +254700000001 via twilio. Twilio did not confirm it in time, so it may not have arrived. It is not sent again, so nobody gets it twice.',
    ]);
    expect(await timeline(world.ctx)).not.toContain('reminder_sms_failed');
    world.ctx.clock.advance(30 * MIN);
    await runDueJobs(world.ctx);
    expect(smsSpy).toHaveBeenCalledTimes(1);
  });

  it('tries a confirmation again, because a second copy is better than none', async () => {
    const world = await makeWorld({ rules: [] });
    await saveBooking(world.ctx, makeBooking());
    smsSpy.mockResolvedValueOnce(timedOut);
    await enqueueJob(world.ctx, { type: 'message', bookingId: 'bkg_test1', dueAt: TEST_NOW, channel: 'sms', audience: 'invitee', kind: 'confirmation' });
    expect(await runDueJobs(world.ctx)).toMatchObject({ processed: 1, failed: 1 });
    expect(await timelineDetail(world.ctx, 'confirmation_sms_failed')).toEqual(['Twilio did not answer in time (will try again in 2 min)']);
    world.ctx.clock.advance(3 * MIN);
    await runDueJobs(world.ctx);
    expect(smsSpy).toHaveBeenCalledTimes(2);
    expect(await timeline(world.ctx)).toContain('confirmation_sms_sent');
  });
});

// ───────────────────────── a write that fails after its claim ─────────────────────────

describe('scheduleBookingJobs and retries: a failed job write', () => {
  const noPhone = { consent: { sms: false, call: false, at: TEST_NOW, text: '' } };

  function flakyKV(fails: (key: string, value: Job) => 'throw' | 'write-then-throw' | null) {
    const kv = memoryKV();
    const flaky: KV = {
      ...kv,
      setJSON: async (key, value, opts) => {
        const mode = key.startsWith('jobs/') ? fails(key, value as Job) : null;
        if (mode === 'throw') throw new Error('storage is down');
        const written = await kv.setJSON(key, value, opts);
        if (mode === 'write-then-throw') throw new Error('storage answered with an error');
        return written;
      },
    };
    return flaky;
  }

  it('lets the second try queue a confirmation whose first write failed', async () => {
    let failures = 0;
    const world = await makeWorld({ rules: [], kv: flakyKV((_k, job) => (failures > 0 && job.kind === 'confirmation' ? (failures--, 'throw') : null)) });
    const booking = await saveBooking(world.ctx, makeBooking(noPhone));
    failures = 1;
    await expect(scheduleBookingJobs(world.ctx, booking, world.eventType, 'created')).rejects.toThrow('storage is down');
    await scheduleBookingJobs(world.ctx, booking, world.eventType, 'created'); // createBooking tries once more
    await runDueJobs(world.ctx);
    expect(world.emails.map((e) => e.subject).sort()).toEqual([
      'Confirmed: Intro call with Jimi Cohen, Tue, Nov 17, 11:30 PM GMT+3',
      'New booking: Sam Rivera for Intro call, Tue, Nov 17, 3:30 PM EST',
    ]);
  });

  it('still sends once when the failed write had in fact been stored', async () => {
    let failures = 0;
    const world = await makeWorld({ rules: [], kv: flakyKV((_k, job) => (failures > 0 && job.kind === 'confirmation' ? (failures--, 'write-then-throw') : null)) });
    const booking = await saveBooking(world.ctx, makeBooking({ ...noPhone, hostIds: [] }));
    failures = 1;
    await expect(scheduleBookingJobs(world.ctx, booking, world.eventType, 'created')).rejects.toThrow();
    world.ctx.clock.advance(1000);
    await scheduleBookingJobs(world.ctx, booking, world.eventType, 'created');
    expect(await listJobs(world.ctx)).toHaveLength(2); // two copies of one message, under one id
    for (const minutes of [0, 1, 11, 2, 30]) {
      world.ctx.clock.advance(minutes * MIN);
      await runDueJobs(world.ctx);
    }
    expect(world.emails).toHaveLength(1);
    expect(await listJobs(world.ctx)).toEqual([]);
  });

  it('retries an attempt whose successor could not be written', async () => {
    let failures = 0;
    const world = await makeWorld({ rules: [], kv: flakyKV((_k, job) => (failures > 0 && job.attempt === 1 ? (failures--, 'throw') : null)) });
    world.failEmail = (_sent, attempt) => attempt === 1;
    await book(world, { ...noPhone, hostIds: [] });
    failures = 1;
    await runDueJobs(world.ctx); // the send fails, and so does queueing the next try
    for (const minutes of [2, 11, 2, 2]) {
      world.ctx.clock.advance(minutes * MIN);
      await runDueJobs(world.ctx);
    }
    expect(world.emails).toHaveLength(2); // the failed send, then the delivery
    expect(await listJobs(world.ctx)).toEqual([]);
    expect((await timeline(world.ctx)).at(-1)).toBe('confirmation_email_sent');
  });

  it('counts the next try from when the failed attempt started, so a late recovery adds no second copy', async () => {
    const world = await makeWorld({ rules: [] });
    world.failEmail = (_sent, attempt) => attempt === 1;
    await book(world, { ...noPhone, hostIds: [] });
    const [first] = await listJobs(world.ctx);
    await runDueJobs(world.ctx);
    const [retry] = await listJobs(world.ctx);
    expect([retry.attempt, retry.dueAt]).toEqual([1, at(TEST_NOW, 2 * MIN)]);
    // the failed attempt shows up again later (a late write): moving it on lands on the same key
    await putJob(world.ctx, first);
    world.ctx.clock.advance(MIN);
    await runDueJobs(world.ctx);
    world.ctx.clock.advance(11 * MIN);
    await runDueJobs(world.ctx);
    world.ctx.clock.advance(MIN);
    await runDueJobs(world.ctx);
    expect(world.emails).toHaveLength(2);
    expect(await listJobs(world.ctx)).toEqual([]);
  });

  it('keeps the calendar file byte for byte the same on a retry, so the provider sees a repeat', async () => {
    const world = await makeWorld({ rules: [] });
    world.failEmail = (_sent, attempt) => attempt === 1;
    await book(world, { ...noPhone, hostIds: [] });
    world.ctx.clock.advance(10_000); // the failure is noted on the booking ten seconds after it was made
    await runDueJobs(world.ctx);
    world.ctx.clock.advance(2 * MIN);
    await runDueJobs(world.ctx);
    expect(world.emails).toHaveLength(2);
    expect(world.emails[1].idempotencyKey).toBe(world.emails[0].idempotencyKey);
    expect(world.emails[1].attachments![0].content).toBe(world.emails[0].attachments![0].content);
  });
});

// ───────────────────────── rules that changed ─────────────────────────

describe('reminders whose rule changed', () => {
  it('does not send a reminder whose rule was removed, but still sends one whose event type is gone', async () => {
    const world = await makeWorld({ rules: [DEFAULT_RULES[2], DEFAULT_RULES[3]] });
    await book(world, {}, null);
    await saveEventType(world.ctx, { ...world.eventType, reminders: [DEFAULT_RULES[3]] }); // the 1 hour email rule is deleted
    world.ctx.clock.set(at(START, -1 * HOUR));
    await runDueJobs(world.ctx);
    expect(world.emails).toEqual([]);
    expect(await timelineDetail(world.ctx, 'reminder_email_skipped')).toEqual(['this reminder was switched off or removed']);

    await deleteEventType(world.ctx, world.eventType.id);
    world.ctx.clock.set(at(START, -15 * MIN));
    await runDueJobs(world.ctx);
    expect(smsSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the reminders of many bookings with one read of the queue', async () => {
    const kv = memoryKV();
    let reads = 0;
    const counting: KV = {
      ...kv,
      getJSON: async (key) => {
        if (key.startsWith('jobs/')) reads++;
        return kv.getJSON(key);
      },
    };
    const world = await makeWorld({ kv: counting });
    for (const id of ['bkg_a', 'bkg_b', 'bkg_c']) await book(world, { id });
    const total = (await listJobs(world.ctx)).length;
    reads = 0;
    const cleared = await removeReminderJobs(world.ctx, ['bkg_a', 'bkg_b']);
    expect([...cleared].sort()).toEqual(['bkg_a', 'bkg_b']);
    expect(reads).toBe(total);
    const left = (await listJobs(world.ctx)) as StoredJob[];
    expect(left.filter((j) => j.kind === 'reminder').map((j) => j.bookingId)).toEqual(['bkg_c', 'bkg_c', 'bkg_c', 'bkg_c']);
    expect(left.filter((j) => j.kind === 'confirmation' && j.channel === 'email').map((j) => j.bookingId).sort()).toEqual(['bkg_a', 'bkg_b', 'bkg_c']);

    // re-planning one of them after that adds its reminders back without another scan
    reads = 0;
    await scheduleBookingJobs(world.ctx, (await getBooking(world.ctx, 'bkg_a'))!, world.eventType, null, { remindersCleared: true });
    expect(reads).toBe(0);
    expect(((await listJobs(world.ctx)) as StoredJob[]).filter((j) => j.kind === 'reminder' && j.bookingId === 'bkg_a')).toHaveLength(4);
  });

  it('re-plans many bookings with one read of the queue, and a run cut off part-way leaves the rest their old reminders', async () => {
    const kv = memoryKV();
    let listings = 0;
    let siteReads = 0;
    let hangAtSiteRead = 0;
    const watched: KV = {
      ...kv,
      list: async (prefix) => {
        if (prefix.startsWith('jobs/')) listings++;
        return kv.list(prefix);
      },
      // The re-plan of one booking reads the site settings once; a function that is stopped there never goes on.
      getJSON: async (key) => {
        if (key === 'site' && ++siteReads === hangAtSiteRead) return new Promise<never>(() => undefined);
        return kv.getJSON(key);
      },
    };
    const world = await makeWorld({ kv: watched, rules: [DEFAULT_RULES[0], DEFAULT_RULES[2]] });
    for (const id of ['bkg_a', 'bkg_b', 'bkg_c']) await book(world, { id });
    const dues = async (id: string) =>
      ((await listJobs(world.ctx)) as StoredJob[])
        .filter((j) => j.kind === 'reminder' && j.bookingId === id)
        .map((j) => (START_MS - Date.parse(j.dueAt)) / MIN)
        .sort((x, y) => x - y);
    expect(await dues('bkg_c')).toEqual([60, 1440]);

    // The 1 hour email becomes a 2 hour one.
    const changed: EventType = { ...world.eventType, reminders: [DEFAULT_RULES[0], { ...DEFAULT_RULES[2], offsetMinutes: 120 }] };
    await saveEventType(world.ctx, changed);
    const bookings = await Promise.all(['bkg_a', 'bkg_b', 'bkg_c'].map(async (id) => (await getBooking(world.ctx, id))!));

    listings = 0;
    siteReads = 0;
    hangAtSiteRead = 2; // stopped while it re-plans the second booking
    void replanBookingReminders(world.ctx, bookings, changed);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listings).toBe(1);
    expect(await dues('bkg_a')).toEqual([120, 1440]);
    expect(await dues('bkg_c')).toEqual([60, 1440]); // not reached: the old reminders still go out

    hangAtSiteRead = 0;
    listings = 0;
    expect(await replanBookingReminders(world.ctx, bookings, changed)).toBe(0);
    expect(listings).toBe(1);
    for (const id of ['bkg_a', 'bkg_b', 'bkg_c']) expect(await dues(id)).toEqual([120, 1440]);
  });
});

// ───────────────────────── invitations, links and alerts ─────────────────────────

describe('composeBookingEmail: what the invitee receives', () => {
  it('sends no second invitation while Google is still retrying a failed write, and no CANCEL later', async () => {
    const world = await makeWorld();
    const google = { hostId: 'host_owner', calendarId: 'primary', eventId: '', error: 'Google request failed (503 backendError).' };
    const booking = await book(world, { google });
    await runDueJobs(world.ctx);
    const invitee = world.emails.find((e) => e.to[0].includes('sam@example.com'))!;
    expect(invitee.attachments![0].content_type).toContain('method=PUBLISH');
    expect(icsOf(invitee)).not.toContain('ATTENDEE');

    await saveBooking(world.ctx, { ...booking, status: 'cancelled', google });
    await enqueueJob(world.ctx, { type: 'message', bookingId: booking.id, dueAt: TEST_NOW, channel: 'email', audience: 'invitee', kind: 'cancelled' });
    await runDueJobs(world.ctx);
    expect(world.emails.at(-1)!.subject.startsWith('Cancelled:')).toBe(true);
    expect(world.emails.at(-1)!.attachments).toBeUndefined();
  });

  it('offers Outlook.com and Office 365 separately', async () => {
    const world = await makeWorld();
    await book(world);
    await runDueJobs(world.ctx);
    const invitee = world.emails.find((e) => e.to[0].includes('sam@example.com'))!;
    expect(invitee.html).toContain('>Outlook.com</a>');
    expect(invitee.html).toContain('>Office 365</a>');
    expect(invitee.html).toContain('href="https://outlook.office.com/calendar/0/action/compose?');
    expect(invitee.html).toContain('href="https://outlook.live.com/calendar/0/action/compose?');
  });

  it('never turns a web address someone typed into a link, while our own links keep working', async () => {
    const world = await makeWorld({ rules: [] });
    await book(world, {
      invitee: { ...makeBooking().invitee, name: 'https://evil.example/verify-account now', email: 'third.party@example.org' },
      answers: [{ questionId: 'q_topic', label: 'Topic', value: 'see https://evil.example/agenda' }],
    });
    await runDueJobs(world.ctx);
    const invitee = world.emails.find((e) => e.to[0].includes('third.party@example.org'))!;
    expect(invitee.html).not.toMatch(/href="https:\/\/evil\.example/);
    expect(invitee.text).toContain('Hi there,');
    expect(invitee.html).toMatch(new RegExp(`<a href="${MEET.replace(/[.]/g, '\\.')}" class="m-link"`)); // the join link in the details
    const host = world.emails.find((e) => e.to[0].includes('jimi@example.com'))!;
    expect(host.html).toContain('see https://evil.example/agenda');
    expect(host.html).not.toMatch(/href="https:\/\/evil\.example/);
  });

  it("still links web addresses in the owner's own wording", async () => {
    const world = await makeWorld({
      rules: [{ id: 'r_prep', enabled: true, channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 60, body: 'Hi {{invitee_first_name}},\n\nPlease read https://jimicohen.com/prep before we meet.' }],
    });
    await book(world, {}, null);
    world.ctx.clock.set(at(START, -1 * HOUR));
    await runDueJobs(world.ctx);
    expect(world.emails[0].html).toMatch(/<a href="https:\/\/jimicohen\.com\/prep" class="m-link"[^>]*>https:\/\/jimicohen\.com\/prep<\/a> before we meet\./);
  });
});

describe('deliverMessage: alerts to the owner', () => {
  const alert = async (world: World) =>
    enqueueJob(world.ctx, {
      type: 'message',
      bookingId: '',
      dueAt: TEST_NOW,
      channel: 'email',
      audience: 'host',
      kind: 'host_alert',
      subject: 'A calendar needs attention: Jimi Cohen',
      body: 'Hi {{host_first_name}},\n\nThe calendar of Jimi Cohen could not be read.',
    });

  it('goes through Resend even when email is set to the Gmail that may be the thing that broke', async () => {
    const world = await makeWorld();
    await saveSite(world.ctx, { ...(await getSite(world.ctx)), email: { provider: 'gmail', fromName: 'Jimi Cohen', fromEmail: 'meet@jimicohen.com', replyTo: '' } });
    await alert(world);
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(world.emails.map((e) => e.subject)).toEqual(['A calendar needs attention: Jimi Cohen']);
  });

  it('texts the owner when the alert email cannot go out', async () => {
    const world = await makeWorld();
    world.failEmail = () => true;
    await updateHost(world.ctx, 'host_owner', (h) => ({ ...h, phone: '+12025550143', notify: { email: true, sms: false } }));
    await alert(world);
    expect(await runDueJobs(world.ctx)).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(smsSpy).toHaveBeenCalledTimes(1);
    const [, sms] = smsSpy.mock.calls[0];
    expect(sms.to).toBe('+12025550143');
    expect(sms.body).toBe(
      `Jimi Cohen: A calendar needs attention: Jimi Cohen. We could not email you about it, so this is a text instead. Open your dashboard: ${TEST_BASE_URL}/admin`,
    );
    expect(sms.body).not.toContain('\u2014');
    expect(await listJobs(world.ctx)).toEqual([]);

    // with neither email nor a text working, it is tried again later
    const stuck = await makeWorld();
    stuck.failEmail = () => true;
    await updateHost(stuck.ctx, 'host_owner', (h) => ({ ...h, phone: '+12025550143' }));
    smsSpy.mockResolvedValue({ ok: false, provider: 'twilio', error: 'Twilio answered 500' });
    await alert(stuck);
    expect(await runDueJobs(stuck.ctx)).toEqual({ processed: 1, failed: 1, remaining: 0 });
    expect((await listJobs(stuck.ctx)).map((j) => j.attempt)).toEqual([1]);
  });

  it('texts the owner when email is not set up at all, and does not text when the email went out', async () => {
    const world = await makeWorld();
    await saveSecrets(world.ctx, {});
    await saveSite(world.ctx, { ...(await getSite(world.ctx)), email: { provider: 'auto', fromName: '', fromEmail: '', replyTo: '' } });
    await updateHost(world.ctx, 'host_owner', (h) => ({ ...h, phone: '+12025550143' }));
    await alert(world);
    await runDueJobs(world.ctx);
    expect(smsSpy).toHaveBeenCalledTimes(1);

    const fine = await makeWorld();
    await updateHost(fine.ctx, 'host_owner', (h) => ({ ...h, phone: '+12025550143' }));
    await alert(fine);
    await runDueJobs(fine.ctx);
    expect(fine.emails).toHaveLength(1);
    expect(smsSpy).toHaveBeenCalledTimes(1);
  });
});

describe('a detached booking: its Google invitation can no longer be changed', () => {
  // The event is in a Google account that is gone (removed, or replaced by "Use a different Google account").
  const detached = { hostId: 'host_owner', accountId: 'gacc_gone', accountEmail: 'jimi@oldjob.example', calendarId: 'primary', eventId: 'mtgabc123', detached: true };

  it('sends the invitee our CANCEL file and says to delete the earlier invitation, and gives the host a file too', async () => {
    const world = await makeWorld();
    const booking = await book(world, { google: detached }, null);
    await saveBooking(world.ctx, { ...booking, status: 'cancelled', cancellation: { at: TEST_NOW, by: 'host' } });
    await enqueueJob(world.ctx, { type: 'message', bookingId: booking.id, dueAt: TEST_NOW, channel: 'email', audience: 'invitee', kind: 'cancelled' });
    await enqueueJob(world.ctx, { type: 'message', bookingId: booking.id, dueAt: TEST_NOW, channel: 'email', audience: 'host', kind: 'cancelled' });
    await runDueJobs(world.ctx);
    const invitee = world.emails.find((e) => e.to[0].includes('sam@example.com'))!;
    expect(invitee.attachments![0].content_type).toContain('method=CANCEL');
    expect(invitee.text).toContain('If this meeting is still in your calendar from the earlier Google Calendar invitation, please delete it there.');
    expect(invitee.html).toContain('That invitation could not be cancelled for you.');
    const host = world.emails.find((e) => e.to[0].includes('jimi@example.com'))!;
    expect(host.attachments![0].content_type).toContain('method=CANCEL');
    expect(host.text).not.toContain('earlier Google Calendar invitation');
  });

  it('sends a moved invitee our REQUEST file and the sentence about the old time', async () => {
    const world = await makeWorld();
    await book(world, { google: detached, rescheduledFromStart: '2026-11-18T13:00:00.000Z', rescheduleCount: 1 }, 'rescheduled');
    await runDueJobs(world.ctx);
    const invitee = world.emails.find((e) => e.to[0].includes('sam@example.com'))!;
    expect(invitee.attachments![0].content_type).toContain('method=REQUEST');
    expect(invitee.text).toContain('You may still see this meeting at its old time in your calendar, from the earlier Google Calendar invitation.');
    expect(`${invitee.subject} ${invitee.text}`).not.toContain('—');
  });

  it('compat: a booking that is not detached keeps what it had (no CANCEL beside Google, PUBLISH for a move)', async () => {
    const world = await makeWorld();
    const google = { ...detached, detached: undefined };
    await book(world, { google, rescheduledFromStart: '2026-11-18T13:00:00.000Z', rescheduleCount: 1 }, 'rescheduled');
    await runDueJobs(world.ctx);
    const moved = world.emails.find((e) => e.to[0].includes('sam@example.com'))!;
    expect(moved.attachments![0].content_type).toContain('method=PUBLISH');
    expect(moved.text).not.toContain('earlier Google Calendar invitation');
    const host = world.emails.find((e) => e.to[0].includes('jimi@example.com'))!;
    expect(host.attachments).toBeUndefined();
  });
});

describe('a notice to a co-host about their Google accounts', () => {
  it('has no button to a dashboard they cannot open; the owner\'s keeps it', async () => {
    const world = await makeWorld();
    const notice = { type: 'message' as const, kind: 'host_alert' as const, bookingId: '', channel: 'email' as const, audience: 'host' as const, subject: 'A Google account was connected to your booking page', body: 'Hi {{host_first_name}},\n\nalex@work.example was connected.', dueAt: TEST_NOW };
    await enqueueJob(world.ctx, { ...notice, hostId: 'host_alex' });
    await enqueueJob(world.ctx, { ...notice, hostId: 'host_owner' });
    await runDueJobs(world.ctx);
    const toAlex = world.emails.find((e) => e.subject === 'A Google account was connected to your booking page' && !e.to[0].includes('jimi@example.com'))!;
    const toOwner = world.emails.find((e) => e.to[0].includes('jimi@example.com'))!;
    expect(toAlex.html).not.toContain('/admin');
    expect(toAlex.text).not.toContain('Open your dashboard');
    expect(toOwner.html).toContain('Open your dashboard');
  });

  it('when the email cannot go out, the text to the co-host carries no dashboard link either', async () => {
    const world = await makeWorld();
    world.failEmail = (sent) => sent.to[0].includes('alex@example.com');
    await enqueueJob(world.ctx, { type: 'message', kind: 'host_alert', bookingId: '', channel: 'email', audience: 'host', hostId: 'host_alex', subject: 'A Google account was connected to your booking page', body: 'Hi {{host_first_name}},\n\nalex@work.example was connected.', dueAt: TEST_NOW });
    await runDueJobs(world.ctx);
    const texts = smsSpy.mock.calls.map((c) => c[1]);
    expect(texts.map((t) => t.to)).toEqual(['+447700900123']);
    expect(texts[0].body).toContain('A Google account was connected to your booking page');
    expect(texts[0].body).not.toContain('/admin');
    expect(texts[0].body).not.toContain('dashboard');
  });
});
