/**
 * The provider mocks, driven by the REAL client code: every test goes through the same modules
 * the app uses in production (google.ts, busy.ts, email.ts, sms.ts, voice.ts, booking.ts, the
 * Anthropic SDK), with createMockFetch as ctx.fetch and an in-memory store.
 */
import { describe, expect, it } from 'vitest';
import type { CreateBookingRequest, Host } from '../../shared/types';
import { handle } from '../../server/api';
import { runIntegrationTest } from '../../server/lib/admin/integrations';
import { cancelBooking, createBooking } from '../../server/lib/booking';
import { getHostBusy } from '../../server/lib/busy';
import type { Env } from '../../server/lib/ctx';
import { sendEmail } from '../../server/lib/email';
import {
  GoogleApiError,
  GoogleAuthError,
  buildGoogleAuthUrl,
  completeGoogleAuth,
  disconnectGoogle,
  googleCreateEvent,
  googleDeleteEvent,
  googleFreeBusy,
  googleGetTimezone,
  googleListCalendars,
  googleUpdateEvent,
  type CalendarEventInput,
} from '../../server/lib/google';
import { fetchIcsBusy } from '../../server/lib/icsfeed';
import { runDueJobs } from '../../server/lib/jobs';
import { anthropicRequestProblem, configureMocks, createMockFetch, decodeRawEmail, getMockKV, mockFetch } from '../../server/lib/mocks';
import { getBooking, getCall, getHost, getSite, listJobs as listQueuedJobs, saveHost, saveSite, updateHost, updateSite } from '../../server/lib/repo';
import { sendSms } from '../../server/lib/sms';
import { memoryKV } from '../../server/lib/store';
import { startReminderCall } from '../../server/lib/voice';
import { defaultOwnerHost } from '../../shared/defaults';
import {
  DEV_FAIL_PREFIX,
  DEV_GOOGLE_ACCOUNT_PREFIX,
  DEV_GOOGLE_BUSY_PREFIX,
  DEV_ICS_ORIGIN,
  DEV_ICS_PREFIX,
  DEV_LLM_SCRIPT_KEY,
  parseFailSpec,
  readOutbox,
} from '../../server/routes/dev';
import { TEST_BASE_URL, apiRequest, makeTestCtx, markSetUp, type TestCtx } from '../helpers/ctx';
import { mainOf, type AccountRef } from '../../server/lib/googleAccounts';

/** The host's main Google account, the way every Google call now names the account it is made as. */
function main(host: Host): AccountRef {
  const ref = mainOf(host);
  if (!ref) throw new Error('no main account');
  return ref;
}

// ───────────────────────── fixtures ─────────────────────────

const OWNER = 'host_owner';
const ALEX = 'host_alex';
/** Monday 09:00 UTC. The owner works Monday to Friday, 09:00 to 17:00 UTC. */
const NOW = '2026-11-16T09:00:00.000Z';
const WED_14 = '2026-11-18T14:00:00.000Z';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const JIMI = 'jimi@example.com';

const ALL_CREDS: Env['overrides'] = {
  googleClientId: 'mock-client-id.apps.googleusercontent.com',
  googleClientSecret: 'mock-client-secret',
  // Built at run time so no literal in this file looks like a real account id.
  twilioAccountSid: 'AC' + '0'.repeat(32),
  twilioAuthToken: 'mock-twilio-auth-token',
  twilioFromNumber: '+15005550006',
  anthropicApiKey: 'mock-anthropic-key',
  resendApiKey: 'mock-resend-key',
};

interface Entry {
  kind: string;
  service: string;
  status: number;
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

async function world(opts: { overrides?: Env['overrides']; now?: string } = {}): Promise<TestCtx> {
  const ctx = makeTestCtx({ now: opts.now ?? NOW, env: { mockProviders: true, overrides: opts.overrides ?? ALL_CREDS } });
  ctx.fetch = createMockFetch({ kv: ctx.kv, now: ctx.now });
  await getSite(ctx);
  await updateHost(ctx, OWNER, (h) => ({ ...h, email: JIMI }));
  // First-run setup is done, so the booking page takes bookings (booking.ts siteIsOpen).
  await markSetUp(ctx);
  return ctx;
}

async function outbox(ctx: TestCtx, kind?: string): Promise<Entry[]> {
  const all = (await readOutbox(ctx.kv)) as Entry[];
  return kind ? all.filter((e) => e.kind === kind) : all;
}

/** The real connect flow minus the browser: our signed state, then Google's answer with a mock code. */
async function connect(ctx: TestCtx, hostId: string, code: string, gmail = false) {
  const authUrl = new URL(await buildGoogleAuthUrl(ctx, { hostId, returnTo: '/meeting/admin/integrations', gmail }));
  return completeGoogleAuth(ctx, new URLSearchParams({ state: authUrl.searchParams.get('state')!, code }));
}

async function owner(ctx: TestCtx) {
  const host = await getHost(ctx, OWNER);
  if (!host) throw new Error('owner host missing');
  return host;
}

function eventInput(over: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return {
    summary: 'Intro call with Ada',
    description: 'Booked through the scheduler.',
    startIso: WED_14,
    endIso: '2026-11-18T14:15:00.000Z',
    timezone: 'Europe/London',
    attendees: [{ email: 'ada@example.com', name: 'Ada Lovelace', accepted: true }],
    createMeet: true,
    bookingId: 'bk_mock_1',
    notifyAttendees: true,
    ...over,
  };
}

function bookingRequest(over: Partial<CreateBookingRequest> = {}): CreateBookingRequest {
  return { slug: 'intro', start: WED_14, durationMin: 15, name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'Europe/London', elapsedMs: 5200, ...over };
}

async function voiceHook(ctx: TestCtx, step: 'start' | 'turn' | 'status' | 'amd', callId: string, sid: string, fields: Record<string, string> = {}) {
  const req = new Request(`${TEST_BASE_URL}/api/twilio/voice/${step}?c=${callId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'mock' },
    body: new URLSearchParams({ CallSid: sid, ...fields }).toString(),
  });
  const res = await handle(req, ctx);
  const xml = await res.text();
  const said = [...xml.matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)].map((m) => m[1].replace(/&apos;/g, "'").replace(/&amp;/g, '&')).join(' ');
  return { status: res.status, xml, said, listens: xml.includes('<Gather '), hangsUp: xml.includes('<Hangup/>') };
}

/** A booking with a phone number and consent, and the reminder call for it placed through mock Twilio. */
async function bookedAndRinging(ctx: TestCtx, start?: string) {
  // Reminder calls need a number to call back on (voice.ts usableCallbackNumber).
  await updateSite(ctx, (s) => ({ ...s, assistant: { ...s.assistant, callbackNumber: '+12125550100' } }));
  const { booking } = await createBooking(ctx, bookingRequest({ phone: '+14155552671', consent: { sms: true, call: true }, ...(start ? { start } : {}) }));
  await ctx.settle();
  const result = await startReminderCall(ctx, { booking, purpose: 'reminder' });
  expect(result).toMatchObject({ ok: true, provider: 'mock' });
  const placed = (await outbox(ctx, 'call')).at(-1)!;
  return { booking, sid: placed.sid as string, callId: placed.callId as string, result };
}

// ───────────────────────── Google: OAuth ─────────────────────────

describe('mock Google: sign-in', () => {
  it('the code names the account and its time zone, and the exchange grants both calendar scopes', async () => {
    const ctx = await world();
    const result = await connect(ctx, OWNER, 'mock:jimi@example.com:Europe/London');
    expect(result).toMatchObject({ ok: true, hostId: OWNER, email: JIMI, firstConnect: true, returnTo: '/meeting/admin/integrations' });

    const host = await owner(ctx);
    expect(host.google).toMatchObject({ email: JIMI, status: 'ok', gmailSend: false, busyCalendarIds: ['primary'], writeCalendarId: 'primary' });
    expect(host.google!.scopes).toEqual(expect.arrayContaining(['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events']));
    expect(await googleGetTimezone(ctx, main(host))).toBe('Europe/London');

    const [token] = await outbox(ctx, 'token');
    expect(token).toMatchObject({ service: 'google', status: 200, ok: true, account: JIMI, grant: 'authorization_code', refreshTokenIssued: true, at: NOW });
    // The identity came from the id_token (right audience and issuer), so userinfo was never needed.
    expect(await outbox(ctx, 'userinfo')).toEqual([]);
  });

  it('different codes connect different hosts as different accounts', async () => {
    const ctx = await world();
    await saveHost(ctx, { ...defaultOwnerHost(NOW, 'UTC'), id: ALEX, role: 'member', name: 'Alex Kim', email: 'alex@example.com' });
    await connect(ctx, OWNER, 'mock:jimi@example.com:Europe/London');
    await connect(ctx, ALEX, 'mock:alex@example.com:Africa/Nairobi');
    const alex = (await getHost(ctx, ALEX))!;
    expect(alex.google?.email).toBe('alex@example.com');
    expect(await googleGetTimezone(ctx, main(alex))).toBe('Africa/Nairobi');
    expect(await googleGetTimezone(ctx, main(await owner(ctx)))).toBe('Europe/London');
  });

  it('flags on the code: gmail, noidtoken, norefresh, nocalendar', async () => {
    const ctx = await world();
    expect(await connect(ctx, OWNER, 'mock:jimi@example.com:UTC:gmail:noidtoken', true)).toMatchObject({ ok: true, email: JIMI });
    expect((await owner(ctx)).google).toMatchObject({ gmailSend: true });
    expect(await outbox(ctx, 'userinfo')).toHaveLength(1);

    const fresh = await world();
    const noRefresh = await connect(fresh, OWNER, 'mock:jimi@example.com:UTC:norefresh');
    expect(noRefresh.ok).toBe(false);
    expect(noRefresh.error).toContain('myaccount.google.com/permissions');
    const noCalendar = await connect(fresh, OWNER, 'mock:jimi@example.com:UTC:nocalendar');
    expect(noCalendar.ok).toBe(false);
    expect(noCalendar.error).toContain('Calendar access was not granted');
    expect((await owner(fresh)).google ?? null).toBeNull();
  });

  it('turns down a wrong client secret and a code it does not know, like Google does', async () => {
    const wrong = await world({ overrides: { ...ALL_CREDS, googleClientSecret: 'invalid-secret' } });
    const refused = await connect(wrong, OWNER, 'mock:jimi@example.com:UTC');
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toContain('client ID or client secret');
    expect((await outbox(wrong, 'token'))[0]).toMatchObject({ status: 401, ok: false, error: 'invalid_client' });

    const ctx = await world();
    expect(await connect(ctx, OWNER, 'a-code-the-mock-never-issued')).toMatchObject({ ok: false });
    expect((await outbox(ctx, 'token'))[0]).toMatchObject({ status: 400, error: 'invalid_grant' });
  });

  it('access tokens expire with the clock and are refreshed; a revoked account needs a reconnect', async () => {
    const ctx = await world();
    await connect(ctx, OWNER, 'mock:jimi@example.com:Europe/London');
    await googleGetTimezone(ctx, main(await owner(ctx)));
    expect(await outbox(ctx, 'token')).toHaveLength(1);

    ctx.clock.advance(2 * HOUR);
    expect(await googleGetTimezone(ctx, main(await owner(ctx)))).toBe('Europe/London');
    const tokens = await outbox(ctx, 'token');
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toMatchObject({ grant: 'refresh_token', status: 200, account: JIMI });

    await ctx.kv.setJSON(`${DEV_GOOGLE_ACCOUNT_PREFIX}${JIMI}`, { email: JIMI, timezone: 'Europe/London', revoked: true });
    ctx.clock.advance(2 * HOUR);
    await expect(googleGetTimezone(ctx, main(await owner(ctx)))).rejects.toBeInstanceOf(GoogleAuthError);
    expect((await owner(ctx)).google?.status).toBe('needs_reconnect');
    expect((await outbox(ctx, 'token')).at(-1)).toMatchObject({ status: 400, error: 'invalid_grant' });

    // Signing in again repairs the account.
    expect(await connect(ctx, OWNER, 'mock:jimi@example.com:Europe/London')).toMatchObject({ ok: true, firstConnect: false });
    expect(await googleGetTimezone(ctx, main(await owner(ctx)))).toBe('Europe/London');
  });

  it('disconnecting revokes the grant at the mock too', async () => {
    const ctx = await world();
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');
    await disconnectGoogle(ctx, OWNER);
    expect((await owner(ctx)).google ?? null).toBeNull();
    expect(await outbox(ctx, 'revoke')).toMatchObject([{ status: 200, account: JIMI }]);
  });
});

// ───────────────────────── Google: calendar ─────────────────────────

describe('mock Google: calendars and free/busy', () => {
  it('lists the calendars of the account, the main one first, and the zone can be changed later', async () => {
    const ctx = await world();
    await connect(ctx, OWNER, 'mock:jimi@example.com:Europe/London');
    const calendars = await googleListCalendars(ctx, main(await owner(ctx)));
    expect(calendars[0]).toMatchObject({ id: JIMI, primary: true, accessRole: 'owner' });
    expect(calendars.map((c) => c.summary)).toEqual([JIMI, 'Family', 'Holidays in United States']);

    await ctx.kv.setJSON(`${DEV_GOOGLE_ACCOUNT_PREFIX}${JIMI}`, { email: JIMI, timezone: 'Asia/Tokyo', calendars: [{ id: 'team@group.calendar.google.com', summary: 'Team' }] });
    expect(await googleGetTimezone(ctx, main(await owner(ctx)))).toBe('Asia/Tokyo');
    expect((await googleListCalendars(ctx, main(await owner(ctx)))).map((c) => c.id)).toEqual([JIMI, 'team@group.calendar.google.com']);
  });

  it('free/busy is empty by default and reads dev/google-busy/<email>, clipped to the window', async () => {
    const ctx = await world();
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');
    const range = { start: Date.parse('2026-11-18T00:00:00Z'), end: Date.parse('2026-11-19T00:00:00Z') };
    expect(await getHostBusy(ctx, await owner(ctx), range, { fresh: true })).toEqual({ hostId: OWNER, busy: [], ok: true });

    await ctx.kv.setJSON(`${DEV_GOOGLE_BUSY_PREFIX}${JIMI}`, [
      { start: '2026-11-18T10:00:00Z', end: '2026-11-18T11:00:00Z' },
      { start: '2026-11-18T10:30:00Z', end: '2026-11-18T12:00:00Z' },
      { start: '2026-11-18T23:30:00Z', end: '2026-11-19T02:00:00Z' },
      { start: '2026-11-25T10:00:00Z', end: '2026-11-25T11:00:00Z' },
    ]);
    const busy = await getHostBusy(ctx, await owner(ctx), range, { fresh: true });
    expect(busy.ok).toBe(true);
    expect(busy.busy).toEqual([
      { start: Date.parse('2026-11-18T10:00:00Z'), end: Date.parse('2026-11-18T12:00:00Z') },
      { start: Date.parse('2026-11-18T23:30:00Z'), end: range.end },
    ]);
    const asked = (await outbox(ctx, 'freebusy')).at(-1)!;
    expect(asked).toMatchObject({ account: JIMI, calendars: ['primary'], status: 200 });
    expect(asked.busy.primary).toHaveLength(2);
  });

  it('answers with one calendars entry per requested id, and reports a calendar it does not know', async () => {
    const ctx = await world();
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');
    const family = (await googleListCalendars(ctx, main(await owner(ctx))))[1].id;
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: { ...h.google!, busyCalendarIds: ['primary', family] } }));
    await ctx.kv.setJSON(`${DEV_GOOGLE_BUSY_PREFIX}${JIMI}`, [
      { start: '2026-11-18T09:00:00Z', end: '2026-11-18T09:30:00Z' },
      { start: '2026-11-18T15:00:00Z', end: '2026-11-18T16:00:00Z', calendarId: family },
    ]);
    const range = { start: Date.parse('2026-11-18T00:00:00Z'), end: Date.parse('2026-11-19T00:00:00Z') };
    expect(await googleFreeBusy(ctx, main(await owner(ctx)), range)).toHaveLength(2);
    expect(Object.keys((await outbox(ctx, 'freebusy')).at(-1)!.busy)).toEqual(['primary', family]);

    await updateHost(ctx, OWNER, (h) => ({ ...h, google: { ...h.google!, busyCalendarIds: ['gone@group.calendar.google.com'] } }));
    const broken = await getHostBusy(ctx, await owner(ctx), range, { fresh: true });
    expect(broken.ok).toBe(false);
    expect(broken.error).toContain('notFound');
  });
});

describe('mock Google: events', () => {
  it('insert returns an id, a Meet link and conference data, and the outbox entry is assertable', async () => {
    const ctx = await world();
    await connect(ctx, OWNER, 'mock:jimi@example.com:Europe/London');
    const created = await googleCreateEvent(ctx, main(await owner(ctx)), eventInput());
    expect(created.eventId).toMatch(/^mtg[0-9a-f]{40}$/);
    expect(created.calendarId).toBe('primary');
    expect(created.meetUrl).toMatch(/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    expect(created.htmlLink).toMatch(/^https:\/\/www\.google\.com\/calendar\/event\?eid=/);

    const [insert] = await outbox(ctx, 'calendar_insert');
    expect(insert).toMatchObject({
      service: 'google',
      status: 200,
      account: JIMI,
      calendarId: JIMI,
      eventId: created.eventId,
      sendUpdates: 'all',
      conferenceRequested: true,
      meetUrl: created.meetUrl,
      notified: ['ada@example.com'],
    });
    expect(insert.event).toMatchObject({
      summary: 'Intro call with Ada',
      start: { dateTime: WED_14, timeZone: 'Europe/London' },
      attendees: [{ email: 'ada@example.com', displayName: 'Ada Lovelace', responseStatus: 'accepted' }],
      hangoutLink: created.meetUrl,
      extendedProperties: { private: { meetingBookingId: 'bk_mock_1' } },
      organizer: JIMI,
    });

    // Without a Meet request there is no link.
    const plain = await googleCreateEvent(ctx, main(await owner(ctx)), eventInput({ bookingId: 'bk_mock_2', createMeet: false, startIso: '2026-11-19T10:00:00.000Z', endIso: '2026-11-19T10:15:00.000Z' }));
    expect(plain.meetUrl).toBeUndefined();
  });

  it('a second insert with the same id is a 409, which the real client turns into "adopt the event"', async () => {
    const ctx = await world();
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');
    const first = await googleCreateEvent(ctx, main(await owner(ctx)), eventInput());
    const again = await googleCreateEvent(ctx, main(await owner(ctx)), eventInput());
    expect(again).toEqual({ ...first, adopted: true });
    expect((await outbox(ctx, 'calendar_insert')).map((e) => e.status)).toEqual([200, 409]);
    expect(await outbox(ctx, 'calendar_get')).toMatchObject([{ status: 200, eventId: first.eventId }]);
  });

  it('events are busy time, patch moves them, delete frees the time, and unknown ids are 404', async () => {
    const ctx = await world();
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');
    const host = await owner(ctx);
    const range = { start: Date.parse('2026-11-18T00:00:00Z'), end: Date.parse('2026-11-20T00:00:00Z') };
    const created = await googleCreateEvent(ctx, main(host), eventInput());
    expect(await googleFreeBusy(ctx, main(host), range)).toEqual([{ start: Date.parse(WED_14), end: Date.parse(WED_14) + 15 * 60_000 }]);

    await googleUpdateEvent(ctx, main(host), created.calendarId, created.eventId, { startIso: '2026-11-19T10:00:00.000Z', endIso: '2026-11-19T10:15:00.000Z', timezone: 'UTC' });
    expect(await googleFreeBusy(ctx, main(host), range)).toEqual([{ start: Date.parse('2026-11-19T10:00:00Z'), end: Date.parse('2026-11-19T10:15:00Z') }]);
    const [patch] = await outbox(ctx, 'calendar_patch');
    expect(patch).toMatchObject({ status: 200, eventId: created.eventId, moved: true, sendUpdates: 'all', notified: ['ada@example.com'] });
    expect(patch.event).toMatchObject({ sequence: 1, start: { dateTime: '2026-11-19T10:00:00.000Z' }, hangoutLink: created.meetUrl });

    await googleDeleteEvent(ctx, main(host), created.calendarId, created.eventId, true);
    expect(await googleFreeBusy(ctx, main(host), range)).toEqual([]);
    // Deleting it again is "already gone" (410), which the client accepts.
    await googleDeleteEvent(ctx, main(host), created.calendarId, created.eventId, false);
    expect((await outbox(ctx, 'calendar_delete')).map((e) => e.status)).toEqual([204, 410]);

    await expect(googleUpdateEvent(ctx, main(host), 'primary', 'mtgunknown00000', { summary: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(googleUpdateEvent(ctx, main(host), 'primary', 'mtgunknown00000', { summary: 'x' })).rejects.toBeInstanceOf(GoogleApiError);

    // The id of a deleted event stays taken: creating the booking's event again revives it.
    const revived = await googleCreateEvent(ctx, main(host), eventInput());
    expect(revived.eventId).toBe(created.eventId);
    expect(await googleFreeBusy(ctx, main(host), range)).toHaveLength(1);
  });

  it('an invitation blocks the calendar of a guest who is also a mock account', async () => {
    const ctx = await world();
    await saveHost(ctx, { ...defaultOwnerHost(NOW, 'UTC'), id: ALEX, role: 'member', name: 'Alex Kim', email: 'alex@example.com' });
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');
    await connect(ctx, ALEX, 'mock:alex@example.com:UTC');
    await googleCreateEvent(ctx, main(await owner(ctx)), eventInput({ attendees: [{ email: 'alex@example.com', accepted: true }, { email: 'ada@example.com' }] }));
    const range = { start: Date.parse('2026-11-18T00:00:00Z'), end: Date.parse('2026-11-19T00:00:00Z') };
    expect(await googleFreeBusy(ctx, main((await getHost(ctx, ALEX))!), range)).toEqual([{ start: Date.parse(WED_14), end: Date.parse(WED_14) + 15 * 60_000 }]);
  });
});

// ───────────────────────── email ─────────────────────────

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:bk_1@jimicohen.com', 'SUMMARY:Intro call', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

describe('mock email', () => {
  it('Resend: records recipients, subject, bodies, links and the calendar attachment', async () => {
    const ctx = await world();
    const site = await getSite(ctx);
    await saveSite(ctx, { ...site, email: { ...site.email, fromEmail: 'meetings@jimicohen.com', replyTo: 'jimi@jimicohen.com' } });
    const sent = await sendEmail(ctx, {
      to: 'ada@example.com',
      toName: 'Ada Lovelace',
      subject: 'Confirmed: Intro call',
      text: 'See you there.\nManage: https://jimicohen.com/meeting/booking/bk_1?t=abc',
      html: '<p>See you there.</p><a href="https://jimicohen.com/meeting/booking/bk_1?t=abc&amp;x=1">Manage</a>',
      ics: { filename: 'invite.ics', content: ICS, method: 'REQUEST' },
      idempotencyKey: 'job_1-invitee',
    });
    expect(sent).toMatchObject({ ok: true, provider: 'resend' });
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/);

    const [email] = await outbox(ctx, 'email');
    expect(email).toMatchObject({
      service: 'resend',
      status: 200,
      at: NOW,
      to: ['ada@example.com'],
      toRaw: 'Ada Lovelace <ada@example.com>',
      fromEmail: 'meetings@jimicohen.com',
      replyTo: 'jimi@jimicohen.com',
      subject: 'Confirmed: Intro call',
      links: ['https://jimicohen.com/meeting/booking/bk_1?t=abc&x=1'],
      hasIcs: true,
      messageId: sent.id,
    });
    expect(email.text).toContain('See you there.');
    expect(email.html).toContain('<p>See you there.</p>');
    expect(email.ics).toMatchObject({ filename: 'invite.ics', method: 'REQUEST', contentType: 'text/calendar' });
    expect(email.ics.content).toContain('UID:bk_1@jimicohen.com');

    // The same idempotency key with the same message is the same email: nothing new is delivered.
    const again = {
      to: 'ada@example.com',
      toName: 'Ada Lovelace',
      subject: 'Confirmed: Intro call',
      text: 'See you there.\nManage: https://jimicohen.com/meeting/booking/bk_1?t=abc',
      html: '<p>See you there.</p><a href="https://jimicohen.com/meeting/booking/bk_1?t=abc&amp;x=1">Manage</a>',
      ics: { filename: 'invite.ics', content: ICS, method: 'REQUEST' as const },
      idempotencyKey: 'job_1-invitee',
    };
    const repeat = await sendEmail(ctx, again);
    expect(repeat).toMatchObject({ ok: true, id: sent.id });
    expect(await outbox(ctx, 'email')).toHaveLength(1);
    expect(await outbox(ctx, 'email_duplicate')).toHaveLength(1);

    // The same key with a different message is refused, as Resend does; the sender then sends the
    // new version under a key of its own, and a repeat of that version is a duplicate again.
    const changed = { ...again, text: 'x', html: '<p>x</p>' };
    const resent = await sendEmail(ctx, changed);
    expect(resent).toMatchObject({ ok: true });
    expect(resent.id).not.toBe(sent.id);
    expect((await outbox(ctx, 'email_conflict')).map((e) => [e.status, e.error])).toEqual([[409, 'invalid_idempotent_request']]);
    expect(await outbox(ctx, 'email')).toHaveLength(2);
    expect(await sendEmail(ctx, changed)).toMatchObject({ ok: true, id: resent.id });
    expect(await outbox(ctx, 'email')).toHaveLength(2);
  });

  it('Resend: a wrong key is refused, and the dev fallback works with nothing configured', async () => {
    const refused = await world({ overrides: { ...ALL_CREDS, resendApiKey: 'invalid-key' } });
    const site = await getSite(refused);
    await saveSite(refused, { ...site, email: { ...site.email, fromEmail: 'meetings@jimicohen.com' } });
    const failed = await sendEmail(refused, { to: 'ada@example.com', subject: 'Hi', text: 'x', html: '<p>x</p>' });
    expect(failed).toMatchObject({ ok: false, provider: 'resend' });
    expect(failed.error).toContain('403');

    const bare = await world({ overrides: {} });
    expect(await sendEmail(bare, { to: 'ada@example.com', subject: 'Hi', text: 'x', html: '<p>x</p>' })).toMatchObject({ ok: true, provider: 'mock' });
    expect(await outbox(bare, 'email')).toMatchObject([{ service: 'resend', to: ['ada@example.com'], subject: 'Hi', hasIcs: false, ics: null }]);
  });

  it('Gmail: decodes the raw MIME message, including a non-ASCII subject and the invitation', async () => {
    const ctx = await world({ overrides: { ...ALL_CREDS, resendApiKey: undefined } });
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC:gmail', true);
    const sent = await sendEmail(ctx, {
      to: 'zoe@example.com',
      toName: 'Zoë Müller',
      subject: 'Bestätigt: Kaffee ☕ mit Jimi am Mittwoch um halb drei',
      text: 'Bis bald, Zoë.\nhttps://jimicohen.com/meeting/booking/bk_9?t=tok',
      html: '<p>Bis bald, Zo&euml;.</p><a href="https://jimicohen.com/meeting/booking/bk_9?t=tok">Verwalten</a>',
      ics: { filename: 'invite.ics', content: ICS, method: 'REQUEST' },
    });
    expect(sent).toMatchObject({ ok: true, provider: 'gmail' });

    const [email] = await outbox(ctx, 'email');
    expect(email).toMatchObject({
      service: 'gmail',
      account: JIMI,
      status: 200,
      to: ['zoe@example.com'],
      fromEmail: JIMI,
      subject: 'Bestätigt: Kaffee ☕ mit Jimi am Mittwoch um halb drei',
      links: ['https://jimicohen.com/meeting/booking/bk_9?t=tok'],
      hasIcs: true,
      messageId: sent.id,
    });
    expect(email.toRaw).toContain('Zoë Müller');
    expect(email.text).toContain('Bis bald, Zoë.');
    expect(email.html).toContain('Verwalten');
    // REQUEST travels inline (so mail clients offer accept/decline) and as a file.
    expect(email.ics).toMatchObject({ filename: 'invite.ics', method: 'REQUEST', inline: true });
    expect(email.attachments).toEqual([{ filename: 'invite.ics', contentType: 'application/ics' }]);

    // PUBLISH is an attachment only.
    await sendEmail(ctx, { to: 'zoe@example.com', subject: 'Plain', text: 'x', html: '<p>x</p>', ics: { filename: 'event.ics', content: ICS.replace('METHOD:REQUEST', 'METHOD:PUBLISH'), method: 'PUBLISH' } });
    expect((await outbox(ctx, 'email'))[1].ics).toMatchObject({ filename: 'event.ics', method: 'PUBLISH', inline: false });
  });

  it('Gmail: refuses to send without the gmail.send grant', async () => {
    const ctx = await world({ overrides: { ...ALL_CREDS, resendApiKey: undefined } });
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');
    // Pretend the app believed it may send: the mock still enforces the scope, like Google.
    await updateHost(ctx, OWNER, (h) => ({ ...h, google: { ...h.google!, gmailSend: true } }));
    const sent = await sendEmail(ctx, { to: 'ada@example.com', subject: 'Hi', text: 'x', html: '<p>x</p>' });
    expect(sent).toMatchObject({ ok: false, provider: 'gmail' });
    expect((await outbox(ctx, 'email'))[0]).toMatchObject({ status: 403, ok: false, error: 'insufficientPermissions' });
  });

  it('decodeRawEmail reads quoted-printable bodies and folded headers too', () => {
    const raw = [
      'From: "Jimi Cohen" <jimi@example.com>',
      'To: ada@example.com,',
      ' "Lovelace, Ada" <ada2@example.com>',
      'Subject: =?UTF-8?Q?Caf=C3=A9_at_3?=',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=C3=A9 is booked, see you=',
      ' there.',
    ].join('\r\n');
    expect(decodeRawEmail(raw)).toMatchObject({ fromEmail: 'jimi@example.com', to: ['ada@example.com', 'ada2@example.com'], subject: 'Café at 3', text: 'Café is booked, see you there.', hasIcs: false });
  });
});

// ───────────────────────── Twilio and the voice assistant ─────────────────────────

describe('mock Twilio', () => {
  it('texts: a sid made of letters and digits, and the message in the outbox', async () => {
    const ctx = await world();
    const sent = await sendSms(ctx, { to: '+1 415 555 2671', body: 'Reminder: Intro call at 2:00 PM.' });
    expect(sent).toMatchObject({ ok: true, provider: 'mock' });
    expect(sent.id).toMatch(/^SM[0-9a-f]{32}$/);
    expect(await outbox(ctx, 'sms')).toMatchObject([{ service: 'twilio', status: 201, to: '+14155552671', from: '+15005550006', body: 'Reminder: Intro call at 2:00 PM.', sid: sent.id }]);
  });

  it('texts: a wrong auth token is refused', async () => {
    const ctx = await world({ overrides: { ...ALL_CREDS, twilioAuthToken: 'invalid-token' } });
    const sent = await sendSms(ctx, { to: '+14155552671', body: 'Hi' });
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain('20003');
  });

  it('calls: remembers the call, and "yes" on the phone confirms through the mock model', async () => {
    const ctx = await world();
    const { booking, sid, callId, result } = await bookedAndRinging(ctx);
    expect(sid).toMatch(/^CA[0-9a-f]{32}$/);
    expect(result.id).toBe(sid);
    expect((await outbox(ctx, 'call')).at(-1)).toMatchObject({ to: '+14155552671', from: '+15005550006', webhookUrl: `${TEST_BASE_URL}/api/twilio/voice/start?c=${callId}`, machineDetection: 'DetectMessageEnd' });

    const listed = await (await handle(apiRequest('GET', '/dev/calls'), ctx)).json();
    expect(listed.calls).toHaveLength(1);
    expect(listed.calls[0]).toMatchObject({ sid, callId, to: '+14155552671', status: 'queued', record: { id: callId, bookingId: booking.id, status: 'queued' } });

    const start = await voiceHook(ctx, 'start', callId, sid);
    expect(start.status).toBe(200);
    expect(start.listens).toBe(true);
    expect(start.said).toContain('an AI assistant');

    const turn = await voiceHook(ctx, 'turn', callId, sid, { SpeechResult: 'Yes, I will be there.' });
    expect(turn.said).toBe('Wonderful, I have noted that you will be there. To reach Jimi, call 2 1 2, 5 5 5, 0 1 0 0. Goodbye.');
    expect(turn.hangsUp).toBe(true);
    expect((await getBooking(ctx, booking.id))?.attendance).toMatchObject({ confirmedVia: 'call' });
    const [llm] = await outbox(ctx, 'llm');
    // The default: Claude Haiku 5.5, thinking off, and no refusal fallback (it has none).
    expect(llm).toMatchObject({ service: 'anthropic', status: 200, model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, fallbacks: null, betas: [], structured: true, caller: 'Yes, I will be there.', reply: { action: 'confirm_attendance' } });
    expect((await getCall(ctx, callId))?.outcome).toBe('confirmed');
  });

  it('calls: "reschedule" sends the link and ends the call, "cancel" asks first and only a following "yes" cancels', async () => {
    const ctx = await world();
    const first = await bookedAndRinging(ctx);
    await voiceHook(ctx, 'start', first.callId, first.sid);
    const moved = await voiceHook(ctx, 'turn', first.callId, first.sid, { SpeechResult: 'Can we reschedule?' });
    expect(moved.said).toBe('No problem. I am sending you a link where you can pick a new time. To reach Jimi, call 2 1 2, 5 5 5, 0 1 0 0. Goodbye.');
    expect(moved.hangsUp).toBe(true);
    await ctx.settle();
    expect((await outbox(ctx, 'sms')).some((sms) => String(sms.body).includes(`/booking/${first.booking.id}`))).toBe(true);
    expect((await getCall(ctx, first.callId))?.outcome).toBe('reschedule_requested');

    const second = await bookedAndRinging(ctx, '2026-11-18T15:00:00.000Z');
    await voiceHook(ctx, 'start', second.callId, second.sid);
    const asked = await voiceHook(ctx, 'turn', second.callId, second.sid, { SpeechResult: 'Actually, please cancel it.' });
    expect(asked.listens).toBe(true);
    expect((await getCall(ctx, second.callId))?.pendingCancel).toBe(true);
    expect((await getBooking(ctx, second.booking.id))?.status).toBe('confirmed');

    const done = await voiceHook(ctx, 'turn', second.callId, second.sid, { SpeechResult: 'Yes.' });
    expect(done.hangsUp).toBe(true);
    expect(done.said).toBe('All right, your meeting is cancelled. Thank you, and take care. To reach Jimi, call 2 1 2, 5 5 5, 0 1 0 0. Goodbye.');
    expect(await getBooking(ctx, second.booking.id)).toMatchObject({ status: 'cancelled', cancellation: { by: 'assistant' } });
    expect((await outbox(ctx, 'llm')).map((e) => e.reply.action)).toEqual(['send_manage_link', 'request_cancel', 'confirm_cancel']);
  });

  it('the model can be scripted: a refusal falls back to the scripted flow, and a cancel without the question is not carried out', async () => {
    const ctx = await world();
    const { booking, sid, callId } = await bookedAndRinging(ctx);
    await voiceHook(ctx, 'start', callId, sid);

    await ctx.kv.setJSON(DEV_LLM_SCRIPT_KEY, [{ stopReason: 'refusal' }, { say: 'Done, it is cancelled.', action: 'confirm_cancel' }]);
    const fallback = await voiceHook(ctx, 'turn', callId, sid, { SpeechResult: 'hmm, what was this about again?' });
    expect(fallback.status).toBe(200);
    expect((await outbox(ctx, 'llm')).at(-1)).toMatchObject({ scripted: true, stopReason: 'refusal' });

    // The model claims a cancellation that was never asked for: the server-side guard keeps the booking.
    await voiceHook(ctx, 'turn', callId, sid, { SpeechResult: 'thanks' });
    expect((await getBooking(ctx, booking.id))?.status).toBe('confirmed');
    expect(await ctx.kv.getJSON(DEV_LLM_SCRIPT_KEY)).toEqual([]);
  });

  it('the Anthropic connection test of the dashboard gets a real Messages answer, asked the way a call asks', async () => {
    const ctx = await world();
    expect(await runIntegrationTest(ctx, { channel: 'anthropic' })).toMatchObject({ ok: true });
    expect((await outbox(ctx, 'llm'))[0]).toMatchObject({ status: 200, model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, betas: [], structured: true, reply: { action: 'continue' } });

    const bad = await world({ overrides: { ...ALL_CREDS, anthropicApiKey: 'invalid-key' } });
    const refused = await runIntegrationTest(bad, { channel: 'anthropic' });
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain('did not accept this key');
  });
});

describe('mock Anthropic: the request rules of the Claude API reference', () => {
  const FALLBACK = ['server-side-fallback-2026-07-01'];
  const body = (model: string, extra: Record<string, unknown> = {}) => ({ model, max_tokens: 2000, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'hi' }], ...extra });

  it.each([
    // Claude Opus 5.5: thinking cannot be disabled.
    ['claude-opus-5-5', { thinking: { type: 'disabled' } }, [], '"thinking.type.disabled" is not supported for this model.'],
    ['claude-opus-5-5', { thinking: { type: 'between_tools' } }, [], '"thinking.type.between_tools" is not supported for this model.'],
    ['claude-opus-5-5', { thinking: { type: 'enabled', budget_tokens: 2000 } }, [], '"thinking.type.enabled" is not supported for this model.'],
    // Claude Sonnet 5.5: "disabled" is a 400, "between_tools" at effort high or below with nothing else in it.
    ['claude-sonnet-5-5', { thinking: { type: 'disabled' } }, [], 'To turn thinking off on this model, send "thinking": {"type": "between_tools"}'],
    ['claude-sonnet-5-5', { thinking: { type: 'between_tools' }, output_config: { effort: 'xhigh' } }, [], "output_config.effort 'xhigh' is not supported when thinking is disabled"],
    ['claude-sonnet-5-5', { thinking: { type: 'between_tools', display: 'summarized' } }, [], 'no other field'],
    // Claude Haiku 5.5: "disabled" up to effort high only; no between_tools; no list of fallbacks.
    ['claude-haiku-5-5', { thinking: { type: 'disabled' }, output_config: { effort: 'max' } }, [], "output_config.effort 'max' is not supported when thinking is disabled"],
    ['claude-haiku-5-5', { thinking: { type: 'between_tools' } }, [], '"thinking.type.between_tools" is not supported for this model.'],
    ['claude-haiku-5-5', { fallbacks: [{ model: 'claude-sonnet-5-5' }] }, FALLBACK, 'claude-haiku-5-5 has no server-side fallback'],
    // The fallback parameter needs its beta.
    ['claude-opus-5-5', { fallbacks: 'default' }, [], 'needs the server-side-fallback beta'],
  ] as const)('turns down %s with %j', (model, extra, betas, message) => {
    expect(anthropicRequestProblem(body(model, extra), [...betas])).toContain(message);
  });

  it.each([
    ['claude-haiku-5-5', { thinking: { type: 'disabled' } }, []],
    ['claude-haiku-5-5', { thinking: { type: 'disabled' }, output_config: { effort: 'high' } }, []],
    ['claude-sonnet-5-5', { thinking: { type: 'between_tools' }, fallbacks: 'default' }, FALLBACK],
    ['claude-opus-5-5', { fallbacks: 'default' }, FALLBACK],
    ['claude-opus-5-5', { thinking: { type: 'adaptive' } }, []],
    ['claude-some-other-model', {}, []],
  ] as const)('accepts %s with %j', (model, extra, betas) => {
    expect(anthropicRequestProblem(body(model, extra), [...betas])).toBeNull();
  });

  it('answers a request it turns down with the 400 the API gives', async () => {
    const ctx = await world();
    const res = await ctx.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'sk-ant-mock', 'content-type': 'application/json' },
      body: JSON.stringify(body('claude-sonnet-5-5', { thinking: { type: 'disabled' } })),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
  });
});

// ───────────────────────── the whole booking, end to end ─────────────────────────

describe('a booking through every mock', () => {
  it('writes the calendar event with a Meet link and sends the confirmation and the host notice', async () => {
    const ctx = await world({ overrides: { ...ALL_CREDS, resendApiKey: undefined } });
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');
    const { booking } = await createBooking(ctx, bookingRequest());
    await ctx.settle();

    const [insert] = await outbox(ctx, 'calendar_insert');
    expect(insert).toMatchObject({ status: 200, account: JIMI, conferenceRequested: true, sendUpdates: 'all' });
    expect(insert.event.attendees.map((a: { email: string }) => a.email)).toContain('ada@example.com');
    const stored = (await getBooking(ctx, booking.id))!;
    expect(stored.google).toMatchObject({ hostId: OWNER, eventId: insert.eventId, meetUrl: insert.meetUrl });
    expect(stored.location.joinUrl).toBe(insert.meetUrl);

    const emails = await outbox(ctx, 'email');
    const toInvitee = emails.find((e) => e.to.includes('ada@example.com'))!;
    const toHost = emails.find((e) => e.to.includes(JIMI))!;
    expect(toInvitee.subject).toContain('Intro call');
    expect(toInvitee.text).toContain(insert.meetUrl);
    // Google invited her: its invitation is the one copy, so our email carries no calendar file.
    expect(toInvitee.hasIcs).toBe(false);
    expect(toInvitee.text).toContain('Google Calendar invitation from');
    expect(toHost.subject).toContain('Ada Lovelace');

    // The time is now taken on the mock calendar as well.
    const range = { start: Date.parse(WED_14) - DAY, end: Date.parse(WED_14) + DAY };
    expect(await googleFreeBusy(ctx, main(await owner(ctx)), range)).toEqual([{ start: Date.parse(WED_14), end: Date.parse(WED_14) + 15 * 60_000 }]);

    await cancelBooking(ctx, booking.id, { by: 'invitee', reason: 'Something came up' });
    await ctx.settle();
    expect(await outbox(ctx, 'calendar_delete')).toMatchObject([{ status: 204, eventId: insert.eventId }]);
    expect(await googleFreeBusy(ctx, main(await owner(ctx)), range)).toEqual([]);
  });
});

// ───────────────────────── failure injection ─────────────────────────

describe('failure injection (dev/fail/<service>)', () => {
  it('reads the shorthands', () => {
    expect(parseFailSpec(true)).toEqual({ mode: 'error', status: 500 });
    expect(parseFailSpec(503)).toEqual({ mode: 'error', status: 503 });
    expect(parseFailSpec('timeout')).toEqual({ mode: 'timeout' });
    expect(parseFailSpec({ mode: 'error', status: 400, code: 21610, times: 2 })).toEqual({ mode: 'error', status: 400, code: 21610, times: 2 });
    expect(parseFailSpec({ mode: 'spent' })).toBeNull();
    expect(parseFailSpec('nonsense')).toBeNull();
  });

  it('a failing service answers 500 until the key is cleared, and the failed calls are recorded', async () => {
    const ctx = await world();
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');
    const range = { start: Date.parse('2026-11-18T00:00:00Z'), end: Date.parse('2026-11-19T00:00:00Z') };
    await ctx.kv.setJSON(`${DEV_FAIL_PREFIX}google-freebusy`, true);
    const failed = await getHostBusy(ctx, await owner(ctx), range, { fresh: true });
    expect(failed.ok).toBe(false);
    // The client retries a 5xx once: two recorded attempts, both injected.
    expect((await outbox(ctx, 'freebusy')).map((e) => [e.status, e.injected, e.failService])).toEqual([
      [500, 'error', 'google-freebusy'],
      [500, 'error', 'google-freebusy'],
    ]);
    // Other Google calls are untouched.
    expect(await googleGetTimezone(ctx, main(await owner(ctx)))).toBe('UTC');

    await ctx.kv.delete(`${DEV_FAIL_PREFIX}google-freebusy`);
    expect((await getHostBusy(ctx, await owner(ctx), range, { fresh: true })).ok).toBe(true);
  });

  it('a counted failure clears itself, so the client\'s own retry gets through', async () => {
    const ctx = await world();
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');
    await ctx.kv.setJSON(`${DEV_FAIL_PREFIX}google`, { mode: 'error', status: 503, times: 1 });
    expect(await googleGetTimezone(ctx, main(await owner(ctx)))).toBe('UTC');
    expect((await outbox(ctx, 'timezone')).map((e) => e.status)).toEqual([503, 200]);
    expect(await ctx.kv.getJSON(`${DEV_FAIL_PREFIX}google`)).toBeNull();
  });

  it('a timeout never answers; with ms it gives up quickly, and a network failure fails at once', async () => {
    const ctx = await world();
    await ctx.kv.setJSON(`${DEV_FAIL_PREFIX}twilio`, { mode: 'timeout', ms: 30 });
    const slow = await sendSms(ctx, { to: '+14155552671', body: 'Hi' });
    expect(slow.ok).toBe(false);
    expect((await outbox(ctx, 'sms'))[0]).toMatchObject({ status: 0, ok: false, injected: 'timeout' });

    await ctx.kv.setJSON(`${DEV_FAIL_PREFIX}twilio`, 'network');
    const down = await sendSms(ctx, { to: '+14155552671', body: 'Hi' });
    expect(down.ok).toBe(false);
    expect(down.error).toContain('Could not reach Twilio');

    // Without ms the mock waits for the caller to give up, like a hung connection.
    await ctx.kv.setJSON(`${DEV_FAIL_PREFIX}twilio`, 'timeout');
    const controller = new AbortController();
    const pending = ctx.fetch('https://api.twilio.com/2010-04-01/Accounts/ACx/Messages.json', { method: 'POST', body: 'To=%2B1', signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('provider error codes: a Twilio "opted out" answer becomes a skip, not a retry', async () => {
    const ctx = await world();
    await ctx.kv.setJSON(`${DEV_FAIL_PREFIX}twilio-sms`, { mode: 'error', status: 400, code: 21610, message: 'Attempt to send to unsubscribed recipient' });
    expect(await sendSms(ctx, { to: '+14155552671', body: 'Hi' })).toMatchObject({ ok: false, skipped: 'recipient_opted_out' });
  });

  it('can be limited to one Google account', async () => {
    const ctx = await world();
    await saveHost(ctx, { ...defaultOwnerHost(NOW, 'UTC'), id: ALEX, role: 'member', name: 'Alex Kim', email: 'alex@example.com' });
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');
    await connect(ctx, ALEX, 'mock:alex@example.com:UTC');
    await ctx.kv.setJSON(`${DEV_FAIL_PREFIX}google-calendar`, { mode: 'error', account: 'alex@example.com' });
    const range = { start: Date.parse('2026-11-18T00:00:00Z'), end: Date.parse('2026-11-19T00:00:00Z') };
    expect((await getHostBusy(ctx, await owner(ctx), range, { fresh: true })).ok).toBe(true);
    expect((await getHostBusy(ctx, (await getHost(ctx, ALEX))!, range, { fresh: true })).ok).toBe(false);
  });

  it('a delay answers normally, later', async () => {
    const ctx = await world();
    await ctx.kv.setJSON(`${DEV_FAIL_PREFIX}sms`, { mode: 'delay', ms: 25 });
    expect(await sendSms(ctx, { to: '+14155552671', body: 'Hi' })).toMatchObject({ ok: true });
    expect((await outbox(ctx, 'sms'))[0]).toMatchObject({ status: 201, delayedMs: 25 });
  });
});

// ───────────────────────── everything else ─────────────────────────

describe('calendar feeds and unknown services', () => {
  it('serves a feed from dev/ics/<name>, built from events or given as text', async () => {
    const ctx = await world();
    const range = { start: Date.parse('2026-11-18T00:00:00Z'), end: Date.parse('2026-11-19T00:00:00Z') };
    await ctx.kv.setJSON(`${DEV_ICS_PREFIX}alex`, { events: [{ start: '2026-11-18T13:00:00.000Z', end: '2026-11-18T14:30:00.000Z', summary: 'Dentist' }] });
    expect(await fetchIcsBusy(ctx, `${DEV_ICS_ORIGIN}/alex.ics`, range)).toEqual([{ start: Date.parse('2026-11-18T13:00:00Z'), end: Date.parse('2026-11-18T14:30:00Z') }]);
    expect((await outbox(ctx, 'ics_feed'))[0]).toMatchObject({ service: 'ics', status: 200, feed: 'alex' });

    await expect(fetchIcsBusy(ctx, `${DEV_ICS_ORIGIN}/missing.ics`, range)).rejects.toThrow(/no longer valid/);
  });

  it('answers 501 with a clear message for anything it has no stand-in for, and records it', async () => {
    const ctx = await world();
    const res = await ctx.fetch('https://api.example-provider.com/v2/things?x=1', { method: 'POST', body: '{"a":1}' });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe('mock_not_implemented');
    expect(body.error.message).toContain('No mock for POST https://api.example-provider.com/v2/things');
    expect((await outbox(ctx))[0]).toMatchObject({ service: 'unknown', kind: 'unknown', status: 501, ok: false, method: 'POST', url: 'https://api.example-provider.com/v2/things' });
  });

  it('mockFetch uses the store given to configureMocks and stamps entries with the frozen dev clock', async () => {
    const kv = memoryKV();
    configureMocks({ kv, now: () => new Date('2026-01-01T00:00:00Z') });
    expect(getMockKV()).toBe(kv);
    await mockFetch('https://api.example-provider.com/ping');
    await kv.setJSON('dev/clock', { now: '2026-12-24T18:00:00.000Z' });
    await mockFetch('https://api.example-provider.com/ping');
    expect(((await readOutbox(kv)) as Entry[]).map((e) => e.at)).toEqual(['2026-01-01T00:00:00.000Z', '2026-12-24T18:00:00.000Z']);
  });
});

// ───────────────────────── dev routes for the mocks ─────────────────────────

describe('dev routes that steer the mocks', () => {
  it('set, read and clear Google busy time, and drop the cached free/busy answer', async () => {
    const ctx = await world();
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');
    const range = { start: Date.parse('2026-11-18T00:00:00Z'), end: Date.parse('2026-11-19T00:00:00Z') };
    expect((await getHostBusy(ctx, await owner(ctx), range)).busy).toEqual([]);

    const put = await handle(apiRequest('PUT', '/dev/google/busy', { body: { email: 'Jimi@Example.com', busy: [{ start: '2026-11-18T10:00:00Z', end: '2026-11-18T11:00:00Z' }] } }), ctx);
    expect(await put.json()).toEqual({ email: JIMI, busy: [{ start: '2026-11-18T10:00:00.000Z', end: '2026-11-18T11:00:00.000Z' }] });
    // Not `fresh`: the cached empty answer was dropped by the route.
    expect((await getHostBusy(ctx, await owner(ctx), range)).busy).toHaveLength(1);
    expect((await (await handle(apiRequest('GET', '/dev/google/busy'), ctx)).json()).busy).toEqual({ [JIMI]: [{ start: '2026-11-18T10:00:00.000Z', end: '2026-11-18T11:00:00.000Z' }] });

    expect((await handle(apiRequest('DELETE', `/dev/google/busy?email=${encodeURIComponent(JIMI)}`), ctx)).status).toBe(200);
    expect((await getHostBusy(ctx, await owner(ctx), range)).busy).toEqual([]);

    const bad = await handle(apiRequest('PUT', '/dev/google/busy', { body: { email: JIMI, busy: [{ start: '2026-11-18T11:00:00Z', end: '2026-11-18T10:00:00Z' }] } }), ctx);
    expect(bad.status).toBe(422);
  });

  it('accounts, events, failure injection, jobs, bookings, the raw store, the model script and feeds', async () => {
    const ctx = await world({ overrides: { ...ALL_CREDS, resendApiKey: undefined } });
    await connect(ctx, OWNER, 'mock:jimi@example.com:UTC');

    const account = await handle(apiRequest('PUT', '/dev/google/account', { body: { email: JIMI, timezone: 'America/New_York' } }), ctx);
    expect((await account.json()).account).toMatchObject({ email: JIMI, timezone: 'America/New_York', revoked: false });
    expect(await googleGetTimezone(ctx, main(await owner(ctx)))).toBe('America/New_York');
    expect((await (await handle(apiRequest('GET', '/dev/google/accounts'), ctx)).json()).accounts).toHaveLength(1);

    const { booking, manageToken } = await createBooking(ctx, bookingRequest());
    await ctx.settle();
    const events = (await (await handle(apiRequest('GET', `/dev/google/events?email=${encodeURIComponent(JIMI)}`), ctx)).json()).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ account: JIMI, calendarId: JIMI, event: { status: 'confirmed', summary: expect.stringContaining('Intro call') } });

    const bookings = (await (await handle(apiRequest('GET', '/dev/bookings'), ctx)).json()).bookings;
    expect(bookings).toMatchObject([{ id: booking.id, status: 'confirmed', manageToken, manageUrl: `${TEST_BASE_URL}/booking/${booking.id}?t=${manageToken}` }]);

    const jobs = await (await handle(apiRequest('GET', '/dev/jobs'), ctx)).json();
    expect(jobs.now).toBe(NOW);
    expect(jobs.jobs.map((j: { key: string }) => j.key)).toEqual((await listQueuedJobs(ctx)).map((j) => j.key));
    expect(jobs.jobs.length).toBeGreaterThan(0);
    expect(jobs.jobs.every((j: { bookingId: string }) => j.bookingId === booking.id)).toBe(true);

    expect((await handle(apiRequest('PUT', '/dev/fail', { body: { service: 'resend' } }), ctx)).status).toBe(200);
    expect((await handle(apiRequest('PUT', '/dev/fail', { body: { service: 'twilio-sms', mode: 'error', status: 400, code: 21610 } }), ctx)).status).toBe(200);
    expect((await (await handle(apiRequest('GET', '/dev/fail'), ctx)).json()).fail).toEqual({ resend: { mode: 'error', status: 500 }, 'twilio-sms': { mode: 'error', status: 400, code: 21610 } });
    expect(await sendSms(ctx, { to: '+14155552671', body: 'Hi' })).toMatchObject({ ok: false, skipped: 'recipient_opted_out' });
    expect((await handle(apiRequest('DELETE', '/dev/fail?service=twilio-sms'), ctx)).status).toBe(200);
    expect(await sendSms(ctx, { to: '+14155552671', body: 'Hi' })).toMatchObject({ ok: true });
    expect((await handle(apiRequest('DELETE', '/dev/fail'), ctx)).status).toBe(200);
    expect((await (await handle(apiRequest('GET', '/dev/fail'), ctx)).json()).fail).toEqual({});
    expect((await handle(apiRequest('PUT', '/dev/fail', { body: { service: 'x y' } }), ctx)).status).toBe(422);

    const keys = (await (await handle(apiRequest('GET', '/dev/kv?prefix=bookings/'), ctx)).json()).keys;
    expect(keys).toEqual([`bookings/${booking.id}`]);
    expect((await (await handle(apiRequest('GET', `/dev/kv?key=bookings/${booking.id}`), ctx)).json()).value).toMatchObject({ id: booking.id });

    expect((await handle(apiRequest('PUT', '/dev/llm-script', { body: { replies: [{ say: 'Hello', action: 'continue' }] } }), ctx)).status).toBe(200);
    expect(await ctx.kv.getJSON(DEV_LLM_SCRIPT_KEY)).toEqual([{ say: 'Hello', action: 'continue' }]);
    expect((await handle(apiRequest('DELETE', '/dev/llm-script'), ctx)).status).toBe(200);
    expect(await ctx.kv.getJSON(DEV_LLM_SCRIPT_KEY)).toBeNull();

    const feed = await (await handle(apiRequest('PUT', '/dev/ics', { body: { name: 'alex', events: [{ start: '2026-11-18T13:00:00Z', end: '2026-11-18T14:00:00Z', summary: 'Dentist' }] } }), ctx)).json();
    expect(feed).toEqual({ name: 'alex', url: `${DEV_ICS_ORIGIN}/alex.ics` });
    const range = { start: Date.parse('2026-11-18T00:00:00Z'), end: Date.parse('2026-11-19T00:00:00Z') };
    expect(await fetchIcsBusy(ctx, feed.url, range)).toHaveLength(1);
    expect((await handle(apiRequest('DELETE', '/dev/ics?name=alex'), ctx)).status).toBe(200);
    await expect(fetchIcsBusy(ctx, feed.url, range)).rejects.toThrow();
  });

  it('delivering due jobs goes through the mocks as well', async () => {
    const ctx = await world({ overrides: { ...ALL_CREDS, resendApiKey: undefined } });
    const { booking } = await createBooking(ctx, bookingRequest({ phone: '+14155552671', consent: { sms: true, call: true } }));
    await ctx.settle();
    const before = (await outbox(ctx)).length;
    // 15 minutes before the meeting every reminder is due.
    ctx.clock.set(Date.parse(booking.start) - 14 * 60_000);
    await runDueJobs(ctx);
    await ctx.settle();
    const later = (await outbox(ctx)).slice(before);
    expect(later.some((e) => e.kind === 'sms' && e.to === '+14155552671')).toBe(true);
    expect(later.every((e) => e.at === ctx.now().toISOString())).toBe(true);
  });

  it('none of them exist without mocked providers', async () => {
    const prod = makeTestCtx();
    for (const [method, path] of [
      ['GET', '/dev/google/busy'],
      ['PUT', '/dev/google/busy'],
      ['DELETE', '/dev/google/busy'],
      ['GET', '/dev/google/accounts'],
      ['PUT', '/dev/google/account'],
      ['GET', '/dev/google/events'],
      ['GET', '/dev/fail'],
      ['PUT', '/dev/fail'],
      ['DELETE', '/dev/fail'],
      ['GET', '/dev/jobs'],
      ['GET', '/dev/calls'],
      ['GET', '/dev/bookings'],
      ['GET', '/dev/kv'],
      ['PUT', '/dev/llm-script'],
      ['DELETE', '/dev/llm-script'],
      ['PUT', '/dev/ics'],
      ['DELETE', '/dev/ics'],
    ]) {
      const res = await handle(apiRequest(method, path, method === 'PUT' ? { body: {} } : {}), prod);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});
