/**
 * Harness self-check: every control a suite relies on, used once against the real backend.
 * It doubles as a set of short examples: clock, slots, mock Google busy time, failure
 * injection, due jobs, and a reminder call driven through the Twilio webhooks.
 */
import { defineSuite } from './lib.mjs';

/** Monday 09:00 in London (GMT in November). Starter hours: Monday to Friday, 09:00 to 17:00. */
const MONDAY = '2026-11-16T09:00:00.000Z';
const OWNER_GOOGLE = 'jimi@example.com';
const WED_2PM = '2026-11-18T14:00:00.000Z';
const WED_4PM = '2026-11-18T16:00:00.000Z';
const PHONE = '+14155552671';

/** Fresh data, frozen clock, an owner who is signed in and has connected Google through the real routes. */
async function prepare(s) {
  await s.reset();
  await s.setClock(MONDAY);
  await s.setupAdmin({ timezone: 'Europe/London' });
  // Without a callback number no reminder call is placed (server/lib/voice.ts usableCallbackNumber).
  await s.apiOk('PUT', '/admin/site', { body: { assistant: { callbackNumber: '+12125550100' } } });
  const page = await s.newPage({ signedIn: true, timezoneId: 'Europe/London', locale: 'en-GB' });
  const { result } = await s.connectGoogle(page, OWNER_GOOGLE, 'Europe/London', { start: { hostId: 'host_owner' } });
  s.expect(result.status, `google connect (${result.reason ?? 'no reason'})`).toBe('connected');
  return page;
}

export default defineSuite('harness', { mockCreds: true }, async (t) => {
  await t.scenario('clock, sign-in and the busy time of a mock Google account', async (s) => {
    const page = await s.step('prepare: reset, freeze the clock, set up, connect Google', () => prepare(s));

    await s.step('a signed-in page shows the dashboard at the frozen time', async () => {
      s.expect(await s.now(), 'server clock').toBe(MONDAY);
      await page.goto(s.url('/admin'));
      await page.getByRole('heading', { name: /Good morning, Jimi/ }).waitFor();
      await page.getByText('Monday, 16 November 2026').waitFor();
    });

    await s.step('busy time on the mock calendar removes slots, clearing it brings them back', async () => {
      const wednesday = { slug: 'intro', duration: 15, from: '2026-11-18T00:00:00Z', to: '2026-11-19T00:00:00Z' };
      const free = await s.slots(wednesday);
      s.expect(free.length, 'slots on a free Wednesday').toBe(32);
      s.expect(free, 'free slots').toContain(WED_2PM);

      await s.setGoogleBusy(OWNER_GOOGLE, [{ start: WED_2PM, end: '2026-11-18T15:00:00.000Z' }]);
      const busy = await s.slots(wednesday);
      // 14:00 to 14:45 overlap the busy hour, and 13:45 would run into it with the 5 minute buffer.
      s.expect(busy.length, 'slots with one busy hour').toBe(27);
      s.expect(busy, 'slots while busy').not.toContain(WED_2PM);
      s.expect(busy, 'slots while busy').toContain('2026-11-18T15:00:00.000Z');
      s.expect((await s.outbox({ kind: 'freebusy' })).at(-1).busy.primary, 'what mock Google answered').toEqual([{ start: WED_2PM, end: '2026-11-18T15:00:00.000Z' }]);

      await s.clearGoogleBusy(OWNER_GOOGLE);
      s.expect(await s.slots(wednesday), 'slots after clearing').toContain(WED_2PM);
    });

    await s.step('moving the clock moves the page as well', async () => {
      await s.advanceClock({ days: 1 });
      s.expect(await s.now(), 'server clock').toBe('2026-11-17T09:00:00.000Z');
      await page.reload();
      await page.getByText('Tuesday, 17 November 2026').waitFor();
    });
  });

  await t.scenario('failure injection: a calendar that cannot be read blocks the booking', async (s) => {
    await s.step('prepare', () => prepare(s));

    await s.step('while free/busy fails, booking answers 503 and nothing is stored', async () => {
      await s.failService('google-freebusy');
      const refused = await s.book({ start: WED_2PM });
      s.expect(refused.status, 'booking while the calendar is down').toBe(503);
      s.expect(refused.data.error.code, 'error code').toBe('calendar_unavailable');
      s.expect(await s.bookings(), 'bookings').toEqual([]);
      s.expect((await s.outbox({ kind: 'freebusy', injected: 'error' })).length, 'injected free/busy failures').toBeGreaterThan(0);
    });

    await s.step('a failure that happens once is survived by the retry', async () => {
      await s.clearFailures();
      await s.failService('google-events-insert', { status: 503, times: 1 });
      const booked = await s.book({ start: WED_2PM });
      s.expect(booked.status, 'booking after the outage').toBe(201);
      await s.settle();
      s.expect((await s.outbox({ kind: 'calendar_insert' })).map((e) => e.status), 'calendar insert attempts').toEqual([503, 200]);
      s.expect(await s.bookings({ status: 'confirmed' }), 'bookings').toHaveLength(1);
    });
  });

  await t.scenario('reminders: due jobs, a text, and a call answered with "yes"', async (s) => {
    await s.step('prepare', () => prepare(s));

    const booking = await s.step('book with a phone number and consent', async () => {
      // 11:00 AM in New York, so the call two hours earlier falls inside calling hours (8 AM to 9 PM there).
      const res = await s.book({ start: WED_4PM, phone: PHONE, consent: { sms: true, call: true } });
      s.expect(res.status, 'booking').toBe(201);
      await s.settle();
      s.expect((await s.jobs()).map((j) => `${j.dueAt} ${j.channel}`), 'queued reminders').toEqual([
        '2026-11-17T16:00:00.000Z email',
        '2026-11-18T14:00:00.000Z call',
        '2026-11-18T15:00:00.000Z email',
        '2026-11-18T15:45:00.000Z sms',
      ]);
      await s.clearOutbox();
      return res.data.booking;
    });

    await s.step('a day before: the reminder email goes out', async () => {
      await s.setClock('2026-11-17T16:00:00.000Z');
      await s.runJobs();
      const [reminder] = await s.waitForOutbox({ kind: 'email', to: 'ada@example.com' });
      s.expect(reminder.subject, 'reminder subject').toContain('Intro call');
      s.expect(reminder.at, 'sent at the frozen time').toBe('2026-11-17T16:00:00.000Z');
      s.expect(await s.jobs(), 'jobs left').toHaveLength(3);
    });

    await s.step('two hours before: the assistant calls, hears "yes", and the booking is confirmed', async () => {
      await s.setClock('2026-11-18T14:00:00.000Z');
      await s.runJobs();
      const [call] = await s.calls();
      s.expect(call, 'the call').toMatchObject({ to: PHONE, status: 'queued', record: { bookingId: booking.id, status: 'queued' } });

      const start = await s.voice(call, 'start');
      s.expect(start.said, 'greeting').toContain('an AI assistant');
      s.expect(start.listens, 'the greeting waits for an answer').toBe(true);

      const turn = await s.voice(call, 'turn', { SpeechResult: 'Yes, I will be there.' });
      s.expect(turn.status, 'turn webhook').toBe(200);
      s.expect(await s.outbox({ kind: 'llm' }), 'model calls').toMatchObject([{ status: 200, caller: 'Yes, I will be there.', reply: { action: 'confirm_attendance' } }]);
      s.expect(turn.hangsUp, 'the confirmation ends the call').toBe(true);

      await s.voice(call, 'status', { CallStatus: 'completed', CallDuration: '21' });
      const [stored] = await s.bookings();
      s.expect(stored.attendance, 'attendance').toMatchObject({ confirmedVia: 'call' });
      s.expect(stored.timeline.map((entry) => entry.type), 'timeline').toContain('call_completed');
      s.expect((await s.calls())[0].record, 'call record').toMatchObject({ status: 'completed', outcome: 'confirmed' });
    });

    await s.step('fifteen minutes before: the text reminder, and a reply gets the manage link', async () => {
      await s.setClock('2026-11-18T15:45:00.000Z');
      await s.runJobs();
      const [text] = await s.waitForOutbox({ kind: 'sms', to: PHONE });
      s.expect(text.body, 'reminder text').toContain('Intro call');
      const answer = await s.inboundSms(PHONE, 'where do I change this?');
      s.expect(answer.reply, 'reply to an inbound text').toContain(`/booking/${booking.id}`);
      s.expect(await s.outbox((e) => !e.ok), 'failed provider calls').toEqual([]);
    });
  });
});
