/**
 * Reminders, actually delivered. The clock is moved to each instant, the cron run is played,
 * and what left for the invitee is read from the provider mocks: the email a day before, the
 * assistant's call two hours before (with Twilio's side of the conversation played here), the
 * email an hour before and the text 15 minutes before. Each exactly once, in the invitee's own
 * time zone. Then everything a call can turn into: a reschedule request, a cancellation that
 * needs a second yes, voicemail, a call that would ring at night, and a "C" sent by text.
 */
import { defineSuite } from './lib.mjs';
import { HOUR, MINUTE, OWNER_GOOGLE, PHONE, jobLines, plus, prepare } from './public-helpers.mjs';

const NEW_YORK = 'America/New_York';
const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };
/** Wednesday 11:00 AM in New York (4:00 PM in London). The call two hours before rings at 9:00 AM. */
const START = '2026-11-18T16:00:00.000Z';
const T = { dayBefore: plus(START, -24 * HOUR), call: plus(START, -2 * HOUR), hourBefore: plus(START, -1 * HOUR), text: plus(START, -15 * MINUTE) };

async function bookWithReminders(s, extra = {}) {
  const res = await s.book({ start: START, ...ADA, timezone: NEW_YORK, phone: PHONE, consent: { sms: true, call: true }, ...extra });
  s.expect(res.status, 'booking').toBe(201);
  await s.settle();
  await s.clearOutbox();
  return (await s.bookings({ id: res.data.booking.id }))[0];
}

/** What reached people (emails, texts, calls) since the outbox was last cleared, as short lines. */
async function sent(s) {
  return (await s.outbox((e) => ['email', 'sms', 'call'].includes(e.kind))).map((e) => `${e.kind} to ${[].concat(e.to).join(',')}${e.subject ? `: ${e.subject}` : ''}`);
}

/**
 * Lets the day-before email go out at its time, then moves the clock to the call time, runs the
 * cron, and returns the call Twilio was asked to place. The outbox holds only what happened at call time.
 */
async function ringAtCallTime(s) {
  await s.setClock(T.dayBefore);
  await s.runJobs();
  await s.clearOutbox();
  await s.setClock(T.call);
  await s.runJobs();
  const calls = await s.calls();
  s.expect(calls, 'calls placed').toHaveLength(1);
  return calls[0];
}

const stored = async (s) => (await s.bookings())[0];
const timelineOf = async (s) => (await stored(s)).timeline.map((e) => e.type);

export default defineSuite('public-reminders', { mockCreds: true }, async (t) => {
  await t.scenario('every default reminder arrives once, at its instant, in the invitee\'s zone and words', async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books for Wednesday 11:00 AM New York time, with her number and both consents', async () => {
      const made = await bookWithReminders(s);
      s.expect(await jobLines(s), 'queued').toEqual([`${T.dayBefore} reminder email invitee`, `${T.call} reminder call invitee`, `${T.hourBefore} reminder email invitee`, `${T.text} reminder sms invitee`]);
      return made;
    });

    await s.step('a minute too early nothing goes out', async () => {
      await s.setClock(plus(T.dayBefore, -MINUTE));
      await s.runJobs();
      s.expect(await sent(s), 'sent').toEqual([]);
      s.expect(await s.jobs(), 'jobs').toHaveLength(4);
    });

    await s.step('24 hours before: the email, once', async () => {
      await s.setClock(T.dayBefore);
      await s.runJobs();
      await s.runJobs();
      s.expect(await sent(s), 'sent').toEqual([`email to ${ADA.email}: Reminder: Intro call with Jimi Cohen is tomorrow at 11:00 AM`]);
      const [mail] = await s.outbox({ kind: 'email' });
      s.expect(mail, 'reminder').toMatchObject({ service: 'resend', status: 200, at: T.dayBefore, replyTo: OWNER_GOOGLE });
      s.expect(mail.text, 'wording').toContain('Hi Ada,');
      s.expect(mail.text, 'wording').toContain('A quick reminder that your Intro call with Jimi Cohen is tomorrow at 11:00 AM (Eastern Standard Time).');
      s.expect(mail.text, 'details').toContain('Wednesday, November 18, 2026\n  11:00 AM to 11:15 AM (Eastern Standard Time)');
      s.expect(mail.text, 'no London time').not.toContain('4:00 PM');
      for (const link of [booking.location.joinUrl, `${s.url(`/booking/${booking.id}/reschedule`)}?t=${booking.manageToken}`, `${s.url(`/booking/${booking.id}/cancel`)}?t=${booking.manageToken}`, `${booking.manageUrl}&confirm=1`]) {
        s.expect(mail.links, 'links').toContain(link);
      }
      s.expect(mail.hasIcs, 'a reminder carries no calendar file').toBe(false);
      s.expect(await jobLines(s), 'left in the queue').toEqual([`${T.call} reminder call invitee`, `${T.hourBefore} reminder email invitee`, `${T.text} reminder sms invitee`]);
      s.expect(await timelineOf(s), 'timeline').toContain('reminder_email_sent');
      await s.screenshotEmail(mail, 'reminder a day before');
      await s.clearOutbox();
    });

    const call = await s.step('2 hours before: the assistant calls her number', async () => {
      await s.setClock(T.call);
      await s.runJobs();
      const [placed] = await s.calls();
      s.expect(await sent(s), 'sent').toEqual([`call to ${PHONE}`]);
      const [request] = await s.outbox({ kind: 'call' });
      s.expect(request, 'the Calls request').toMatchObject({
        service: 'twilio',
        method: 'POST',
        url: /\/2010-04-01\/Accounts\/AC[^/]+\/Calls\.json$/,
        status: 201,
        to: PHONE,
        from: '+15005550006',
        at: T.call,
        webhookUrl: `${s.url('/api/twilio/voice/start')}?c=${placed.callId}`,
        statusCallback: `${s.url('/api/twilio/voice/status')}?c=${placed.callId}`,
        amdCallback: `${s.url('/api/twilio/voice/amd')}?c=${placed.callId}`,
        machineDetection: 'DetectMessageEnd',
      });
      s.expect(placed, 'what Twilio was told').toMatchObject({ method: 'POST', statusCallbackEvent: 'completed', timeout: 25, status: 'queued', record: { bookingId: booking.id, status: 'queued', purpose: 'reminder', to: PHONE } });
      // Running the cron again does not ring twice.
      await s.runJobs();
      s.expect(await s.calls(), 'calls after a second run').toHaveLength(1);
      return placed;
    });

    await s.step('Twilio connects: the greeting says who is calling, that it is an AI, and the time in her zone', async () => {
      const start = await s.voice(call, 'start');
      s.expect(start.status, 'start webhook').toBe(200);
      s.expect(start.said, 'greeting').toBe('Hi Ada, this is Ava, an AI assistant calling for Jimi. A quick reminder about your Intro call today at 11:00 AM your time. Are you still able to make it?');
      s.expect(start.listens, 'waits for an answer').toBe(true);
      s.expect(start.xml, 'gathers speech and keys, and posts the answer to our turn webhook').toContain(`<Gather input="speech dtmf" action="${s.url('/api/twilio/voice/turn')}?c=${call.callId}" method="POST"`);
      // A request that does not carry Twilio's signature is turned away.
      const forged = await s.visitor().request('POST', '/twilio/voice/start', { query: { c: call.callId }, form: { CallSid: call.sid }, headers: { 'X-Twilio-Signature': 'not-the-signature' } });
      s.expect(forged.status, 'forged webhook').toBe(403);
    });

    await s.step('she says yes: attendance is confirmed and the assistant says goodbye', async () => {
      const turn = await s.voice(call, 'turn', { SpeechResult: 'Yes, I will be there.', Confidence: '0.93' });
      s.expect(turn.status, 'turn webhook').toBe(200);
      s.expect(turn.said, 'answer').toMatch(/noted|see you|great|wonderful|thank/i);
      const [model] = await s.outbox({ kind: 'llm' });
      s.expect(model, 'model call').toMatchObject({ service: 'anthropic', status: 200, model: 'claude-opus-5-5', caller: 'Yes, I will be there.', reply: { action: 'confirm_attendance' } });
      s.expect((await stored(s)).attendance, 'attendance').toMatchObject({ confirmedAt: T.call, confirmedVia: 'call' });
      // Whether the assistant hung up itself or she did: Twilio reports the end of the call.
      if (!turn.hangsUp) await s.voice(call, 'turn', { SpeechResult: 'No, that is all. Goodbye.' });
      const status = await s.voice(call, 'status', { CallStatus: 'completed', CallDuration: '24' });
      s.expect(status.status, 'status webhook').toBeLessThan(300);
      await s.settle();
    });

    await s.step('the booking shows attendance confirmed, and the timeline says how', async () => {
      const b = await stored(s);
      const confirmed = b.timeline.find((e) => e.type === 'attendance_confirmed');
      s.expect(confirmed, 'timeline entry').toMatchObject({ at: T.call, detail: 'Confirmed on the reminder call' });
      const ended = b.timeline.find((e) => e.type === 'call_completed');
      s.expect(ended.detail, 'call summary').toContain('They confirmed they are coming.');
      s.expect(ended.detail, 'call summary').toContain('Call length: 24 seconds.');
      s.expect(ended.detail, 'transcript').toContain('Yes, I will be there.');
      s.expect((await s.calls())[0].record, 'call record').toMatchObject({ status: 'completed', outcome: 'confirmed', pendingCancel: false });
      // Her own booking page agrees.
      const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
      await page.goto(booking.manageUrl);
      await page.getByText('You said you will be there').waitFor();
      s.expect(await page.getByRole('button', { name: "I'll be there" }).count(), 'no need to ask again').toBe(0);
      await s.screenshot(page, 'booking page after the call');
      // Nobody else was bothered: no email, no text because of a plain "yes".
      s.expect(await sent(s), 'sent around the call').toEqual([`call to ${PHONE}`]);
      await s.clearOutbox();
    });

    await s.step('1 hour before: the second email, once', async () => {
      await s.setClock(T.hourBefore);
      await s.runJobs();
      await s.runJobs();
      s.expect(await sent(s), 'sent').toEqual([`email to ${ADA.email}: Reminder: Intro call with Jimi Cohen is today at 11:00 AM`]);
      const [mail] = await s.outbox({ kind: 'email' });
      s.expect(mail.text, 'wording').toContain('is today at 11:00 AM (Eastern Standard Time)');
      // She already said she is coming: the reminder does not ask again.
      s.expect(mail.links.some((l) => l.includes('confirm=1')), 'confirm link').toBe(false);
      await s.clearOutbox();
    });

    await s.step('15 minutes before: the text, once', async () => {
      await s.setClock(T.text);
      await s.runJobs();
      await s.runJobs();
      s.expect(await sent(s), 'sent').toEqual([`sms to ${PHONE}`]);
      const [text] = await s.outbox({ kind: 'sms' });
      s.expect(text, 'text').toMatchObject({ service: 'twilio', status: 201, to: PHONE, from: '+15005550006', at: T.text });
      s.expect(text.body, 'wording').toMatch(/^Hi Ada, .*Intro call with Jimi Cohen.*11:00 AM/);
      s.expect(text.body, 'join link first, this close to the start').toContain(`Join: ${booking.location.joinUrl}`);
      s.expect(text.body, 'manage link').toContain(`Change or cancel: ${booking.manageUrl}`);
      s.expect(text.body.length, 'length').toBeLessThanOrEqual(300);
      s.expect(text.body, 'no em dash').not.toContain('—');
    });

    await s.step('the queue is empty, nothing failed, and the meeting passing sends nothing more', async () => {
      s.expect(await s.jobs(), 'queue').toEqual([]);
      s.expect(await s.outbox((e) => !e.ok), 'failed provider calls').toEqual([]);
      await s.clearOutbox();
      await s.setClock(plus(START, 30 * MINUTE));
      await s.runJobs();
      s.expect(await sent(s), 'sent after the meeting').toEqual([]);
      s.expect((await timelineOf(s)).filter((type) => /^reminder_/.test(type)), 'reminder entries on the timeline').toEqual(['reminder_email_sent', 'reminder_call_sent', 'reminder_email_sent', 'reminder_sms_sent']);
    });
  });

  await t.scenario('on the call she asks to reschedule: a text with her link goes out and the host is told', async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books', () => bookWithReminders(s));
    const call = await s.step('the assistant calls', () => ringAtCallTime(s));

    await s.step('"Could we move it?": the assistant promises the link and the text is sent at once', async () => {
      await s.voice(call, 'start');
      const turn = await s.voice(call, 'turn', { SpeechResult: 'Actually, could we reschedule to another day?' });
      s.expect(turn.said, 'answer').toMatch(/text|link/i);
      await s.settle();
      const texts = await s.outbox({ kind: 'sms' });
      s.expect(texts, 'texts').toHaveLength(1);
      s.expect(texts[0], 'text').toMatchObject({ to: PHONE, at: T.call });
      s.expect(texts[0].body, 'the link').toContain(booking.manageUrl);
      s.expect(texts[0].body, 'wording').toMatch(/reschedule|change/i);
      if (!turn.hangsUp) await s.voice(call, 'turn', { SpeechResult: 'Thanks, bye.' });
      await s.voice(call, 'status', { CallStatus: 'completed', CallDuration: '31' });
      await s.settle();
      // The note for the host is queued when the call ends and leaves with the next cron run (every two minutes).
      s.expect(await jobLines(s, { kind: 'host_alert' }), 'queued for the host').toEqual([`${T.call} host_alert email host`]);
      await s.runJobs();
    });

    await s.step('nothing was changed: still booked, not confirmed, reminders still queued', async () => {
      const b = await stored(s);
      s.expect(b, 'booking').toMatchObject({ status: 'confirmed', start: START, attendance: {} });
      s.expect(b.timeline.find((e) => e.type === 'call_completed').detail, 'call summary').toContain('They asked for a link to reschedule.');
      s.expect((await s.calls())[0].record, 'call record').toMatchObject({ status: 'completed', outcome: 'reschedule_requested', linkSent: true });
      s.expect(await jobLines(s), 'queue').toEqual([`${T.hourBefore} reminder email invitee`, `${T.text} reminder sms invitee`]);
      s.expect(await s.outbox({ kind: 'calendar_delete' }), 'calendar deletes').toEqual([]);
    });

    await s.step('the host hears about it by email', async () => {
      const [alert] = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
      s.expect(alert.subject, 'subject').toBe('Ada Lovelace asked to move Intro call');
      s.expect(alert.text, 'text').toContain('Ava just spoke with Ada Lovelace on a reminder call about Intro call');
      s.expect(alert.text, 'text').toContain('The meeting stays in your calendar as booked until they pick a new time.');
      s.expect(await s.outbox({ kind: 'email', to: ADA.email }), 'emails to the invitee').toEqual([]);
    });

    await s.step('the link from the text opens her booking, ready to be moved', async () => {
      const [text] = await s.outbox({ kind: 'sms' });
      const link = /https?:\/\/\S+/.exec(text.body)[0];
      const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
      await page.goto(link);
      await page.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      await page.getByRole('link', { name: 'Reschedule' }).waitFor();
    });
  });

  await t.scenario('cancelling on the call takes two steps, and then nothing more is sent', async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books', () => bookWithReminders(s));
    const call = await s.step('the assistant calls', () => ringAtCallTime(s));

    await s.step('"I need to cancel": the assistant asks first, and nothing is cancelled yet', async () => {
      await s.voice(call, 'start');
      const turn = await s.voice(call, 'turn', { SpeechResult: 'I need to cancel, sorry.' });
      s.expect(turn.said, 'question').toBe('I can cancel the meeting for you. Just to be sure, do you want me to cancel it? Yes or no?');
      s.expect(turn.listens, 'waits for the answer').toBe(true);
      s.expect((await stored(s)).status, 'booking').toBe('confirmed');
      s.expect((await s.calls())[0].record.pendingCancel, 'waiting for the second yes').toBe(true);
      s.expect(await s.outbox({ kind: 'calendar_delete' }), 'calendar deletes').toEqual([]);
    });

    await s.step('"Yes": now it is cancelled, by the assistant on her behalf', async () => {
      const turn = await s.voice(call, 'turn', { SpeechResult: 'Yes.' });
      s.expect(turn.said, 'answer').toBe('All right, your meeting is cancelled. Thank you, and take care. Goodbye.');
      s.expect(turn.hangsUp, 'hangs up').toBe(true);
      await s.voice(call, 'status', { CallStatus: 'completed', CallDuration: '40' });
      await s.settle();
      await s.runJobs();
      const b = await stored(s);
      s.expect(b, 'booking').toMatchObject({ status: 'cancelled', cancellation: { by: 'assistant', at: T.call } });
      s.expect(b.timeline.find((e) => e.type === 'cancelled').detail, 'timeline').toMatch(/^Cancelled by the invitee on the reminder call/);
      s.expect(b.timeline.find((e) => e.type === 'call_completed').detail, 'call summary').toContain('They cancelled the meeting, after confirming twice.');
      s.expect((await s.calls())[0].record, 'call record').toMatchObject({ status: 'completed', outcome: 'cancelled' });
    });

    await s.step('the calendar event is gone and everyone was told once', async () => {
      const deletes = await s.outbox({ kind: 'calendar_delete' });
      s.expect(deletes, 'calendar deletes').toHaveLength(1);
      s.expect(deletes[0], 'delete').toMatchObject({ status: 204, account: OWNER_GOOGLE, eventId: booking.google.eventId, sendUpdates: 'all' });
      const lines = await sent(s);
      s.expect(lines.filter((l) => l.startsWith(`email to ${ADA.email}`)), 'emails to the invitee').toEqual([`email to ${ADA.email}: Cancelled: Intro call with Jimi Cohen, Wed, Nov 18, 11:00 AM`]);
      s.expect(lines.filter((l) => l.startsWith('sms to')), 'texts').toEqual([`sms to ${PHONE}`]);
      const hostMail = (await s.outbox({ kind: 'email', to: OWNER_GOOGLE })).map((e) => e.subject).sort();
      s.expect(hostMail, 'emails to the host').toEqual(['Ada Lovelace cancelled Intro call by phone', 'Cancelled: Ada Lovelace for Intro call, Wed, Nov 18, 4:00 PM']);
    });

    await s.step('no reminder is left, and the hour and the quarter hour before pass in silence', async () => {
      s.expect(await s.jobs(), 'queue').toEqual([]);
      await s.clearOutbox();
      for (const at of [T.hourBefore, T.text, START]) {
        await s.setClock(at);
        await s.runJobs();
      }
      s.expect(await sent(s), 'sent after the cancellation').toEqual([]);
    });
  });

  await t.scenario('a "no" to the second question keeps the meeting', async (s) => {
    await s.step('prepare', () => prepare(s));
    await s.step('Ada books', () => bookWithReminders(s));
    const call = await s.step('the assistant calls', () => ringAtCallTime(s));

    await s.step('"cancel", then "no, keep it"', async () => {
      await s.voice(call, 'start');
      await s.voice(call, 'turn', { SpeechResult: 'Cancel it please.' });
      await s.scriptModel([{ say: 'No problem, I will leave it as it is. See you then. Goodbye.', action: 'end_call' }]);
      const turn = await s.voice(call, 'turn', { SpeechResult: 'No, wait, keep it.' });
      s.expect(turn.said, 'answer').toContain('leave it as it is');
      await s.voice(call, 'status', { CallStatus: 'completed', CallDuration: '33' });
      await s.settle();
      s.expect((await stored(s)).status, 'booking').toBe('confirmed');
      s.expect(await s.outbox({ kind: 'calendar_delete' }), 'calendar deletes').toEqual([]);
    });

    await s.step('a model that tries to cancel in one step is stopped by the server', async () => {
      // New booking, new call, and a model that answers "confirm_cancel" to the very first sentence.
      await s.setClock('2026-11-16T09:00:00.000Z');
      const res = await s.book({ start: '2026-11-19T16:00:00.000Z', name: 'Grace Hopper', email: 'grace@example.com', timezone: NEW_YORK, phone: '+14155552672', consent: { sms: true, call: true } });
      s.expect(res.status, 'second booking').toBe(201);
      await s.settle();
      await s.setClock('2026-11-19T14:00:00.000Z');
      await s.runJobs();
      const second = (await s.calls()).find((c) => c.to === '+14155552672');
      await s.voice(second, 'start');
      await s.scriptModel([{ say: 'Done, it is cancelled.', action: 'confirm_cancel' }]);
      const turn = await s.voice(second, 'turn', { SpeechResult: 'Hello? Who is this?' });
      s.expect(turn.said, 'what was said instead').not.toContain('cancelled');
      const grace = (await s.bookings({ id: res.data.booking.id }))[0];
      s.expect(grace.status, "Grace's booking").toBe('confirmed');
    });
  });

  await t.scenario('voicemail: the answering machine gets a short message and she gets her link by text', async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books', () => bookWithReminders(s));
    const call = await s.step('the assistant calls', () => ringAtCallTime(s));

    await s.step('Twilio hears a machine: the call is switched to the voicemail message', async () => {
      await s.voice(call, 'start');
      const amd = await s.voice(call, 'amd', { AnsweredBy: 'machine_end_beep', MachineDetectionDuration: '4200' });
      s.expect(amd.status, 'amd webhook').toBeLessThan(300);
      await s.settle();
      const updates = await s.outbox({ kind: 'call_update' });
      s.expect(updates, 'updates of the live call').toHaveLength(1);
      s.expect(updates[0], 'update').toMatchObject({ service: 'twilio', sid: call.sid, status: 200 });
      s.expect(updates[0].text, 'voicemail message').toMatch(/^Hi Ada, this is Ava, an AI assistant calling for Jimi/);
      s.expect(updates[0].text, 'voicemail message').toContain('Intro call');
      s.expect(updates[0].text, 'voicemail message').toContain('11:00 AM');
      s.expect(updates[0].twiml, 'hangs up after the message').toContain('<Hangup/>');
    });

    await s.step('her link follows by text, the call is recorded as voicemail, nothing is confirmed', async () => {
      await s.voice(call, 'status', { CallStatus: 'completed', CallDuration: '18', AnsweredBy: 'machine_end_beep' });
      await s.settle();
      const texts = await s.outbox({ kind: 'sms' });
      s.expect(texts, 'texts').toHaveLength(1);
      s.expect(texts[0].body, 'the link').toContain(booking.manageUrl);
      const b = await stored(s);
      s.expect(b, 'booking').toMatchObject({ status: 'confirmed', attendance: {} });
      s.expect(b.timeline.find((e) => e.type === 'call_voicemail'), 'timeline').toMatchObject({ detail: 'Reached voicemail and left a reminder message.' });
      s.expect((await s.calls())[0].record, 'call record').toMatchObject({ status: 'voicemail', outcome: 'voicemail' });
      // No model was asked anything: nobody spoke.
      s.expect(await s.outbox({ kind: 'llm' }), 'model calls').toEqual([]);
      // A machine is not a reason to alarm the host.
      s.expect(await s.outbox({ kind: 'email', to: OWNER_GOOGLE }), 'emails to the host').toEqual([]);
    });

    await s.step('a late "human" verdict or a second machine verdict changes nothing', async () => {
      await s.voice(call, 'amd', { AnsweredBy: 'machine_end_beep' });
      await s.settle();
      s.expect(await s.outbox({ kind: 'call_update' }), 'updates').toHaveLength(1);
      s.expect(await s.outbox({ kind: 'sms' }), 'texts').toHaveLength(1);
    });
  });

  await t.scenario('a call that would ring outside calling hours is skipped, the other reminders still go', async (s) => {
    await s.step('prepare', () => prepare(s));
    // The same instant for someone in Tokyo: the meeting is at 1:00 AM, two hours before is 11:00 PM.
    const booking = await s.step('Yuki in Tokyo books Wednesday 16:00 UTC', async () => {
      const made = await bookWithReminders(s, { name: 'Yuki Tanaka', email: 'yuki@example.com', timezone: 'Asia/Tokyo', phone: '+14155552673' });
      s.expect(await jobLines(s), 'queued').toEqual([`${T.dayBefore} reminder email invitee`, `${T.call} reminder call invitee`, `${T.hourBefore} reminder email invitee`, `${T.text} reminder sms invitee`]);
      return made;
    });

    await s.step('the day before, her email says "tomorrow at 1:00 AM"', async () => {
      // Tuesday 16:00 UTC is Wednesday 1:00 AM in Tokyo; the meeting is Thursday 1:00 AM there.
      await s.setClock(T.dayBefore);
      await s.runJobs();
      const [mail] = await s.outbox({ kind: 'email', to: 'yuki@example.com' });
      s.expect(mail.subject, 'subject').toBe('Reminder: Intro call with Jimi Cohen is tomorrow at 1:00 AM');
      await s.clearOutbox();
    });

    await s.step('at 11:00 PM her time the call is not placed, and not tried again later', async () => {
      await s.setClock(T.call);
      await s.runJobs();
      s.expect(await s.calls(), 'calls placed').toEqual([]);
      s.expect(await s.outbox({ kind: 'call' }), 'Calls requests').toEqual([]);
      const b = (await s.bookings({ id: booking.id }))[0];
      s.expect(b.timeline.find((e) => e.type === 'reminder_call_skipped'), 'timeline').toMatchObject({ at: T.call, detail: /outside calling hours/ });
      s.expect(await jobLines(s), 'queue').toEqual([`${T.hourBefore} reminder email invitee`, `${T.text} reminder sms invitee`]);
      await s.setClock(plus(T.call, 30 * MINUTE));
      await s.runJobs();
      s.expect(await s.calls(), 'calls placed half an hour later').toEqual([]);
    });

    await s.step('the email and the text still arrive, in Tokyo time', async () => {
      await s.setClock(T.hourBefore);
      await s.runJobs();
      const [mail] = await s.outbox({ kind: 'email', to: 'yuki@example.com' });
      s.expect(mail.subject, 'subject').toBe('Reminder: Intro call with Jimi Cohen is today at 1:00 AM');
      s.expect(mail.text, 'text').toContain('Thursday, November 19, 2026\n  1:00 AM to 1:15 AM (Japan Standard Time)');
      await s.setClock(T.text);
      await s.runJobs();
      const [text] = await s.outbox({ kind: 'sms', to: '+14155552673' });
      s.expect(text.body, 'text').toContain('1:00 AM');
    });

    await s.step('the edges of the window: 8:00 AM rings, 9:00 PM does not', async () => {
      await s.setClock('2026-11-16T09:00:00.000Z');
      // Thursday 15:00 UTC is 10:00 AM in New York: the call is due at 8:00 AM sharp.
      const early = await s.book({ start: '2026-11-19T15:00:00.000Z', name: 'Early Bird', email: 'early@example.com', timezone: NEW_YORK, phone: '+14155552674', consent: { sms: false, call: true } });
      // Friday 16:00 UTC is 11:00 PM in Jakarta (UTC+7): the call would be due at 9:00 PM sharp, which is already outside.
      const late = await s.book({ start: '2026-11-20T16:00:00.000Z', name: 'Night Owl', email: 'late@example.com', timezone: 'Asia/Jakarta', phone: '+14155552675', consent: { sms: false, call: true } });
      s.expect([early.status, late.status], 'bookings').toEqual([201, 201]);
      await s.settle();
      await s.setClock('2026-11-19T13:00:00.000Z');
      await s.runJobs();
      s.expect((await s.calls()).map((c) => c.to), 'calls at 8:00 AM New York time').toEqual(['+14155552674']);
      await s.setClock('2026-11-20T14:00:00.000Z');
      await s.runJobs();
      s.expect((await s.calls()).map((c) => c.to), 'calls at 9:00 PM Jakarta time').toEqual(['+14155552674']);
    });
  });

  await t.scenario('a text "C" from her number confirms attendance', async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books', () => bookWithReminders(s));

    await s.step('"C" is answered with thanks and recorded', async () => {
      await s.setClock(T.dayBefore);
      const answer = await s.inboundSms(PHONE, 'C');
      s.expect(answer.status, 'webhook').toBe(200);
      s.expect(answer.reply, 'reply').toMatch(/^Thanks Ada, you are confirmed for Intro call on .*11:00 AM.*See you then\.$/);
      const b = await stored(s);
      s.expect(b.attendance, 'attendance').toMatchObject({ confirmedAt: T.dayBefore, confirmedVia: 'sms' });
      s.expect(b.timeline.at(-1), 'timeline').toMatchObject({ type: 'attendance_confirmed', detail: 'Confirmed by text message' });
    });

    await s.step('lower case, "yes" and "confirm" are understood too; anything else gets the link', async () => {
      for (const word of ['c', ' Yes ', 'CONFIRM']) {
        const answer = await s.inboundSms(PHONE, word);
        s.expect(answer.reply, `reply to "${word}"`).toMatch(/confirmed/);
      }
      s.expect((await stored(s)).timeline.filter((e) => e.type === 'attendance_confirmed'), 'recorded once').toHaveLength(1);
      const other = await s.inboundSms(PHONE, 'Where do I change the time?');
      s.expect(other.reply, 'reply to a question').toContain(booking.manageUrl);
    });

    await s.step('a number we do not know, and a request without Twilio\'s signature', async () => {
      const stranger = await s.inboundSms('+14155550000', 'C');
      s.expect(stranger.reply, 'reply to a stranger').toContain('We could not find an upcoming meeting for this number.');
      s.expect(stranger.reply, 'no booking details for a stranger').not.toContain(booking.id);
      const forged = await s.visitor().request('POST', '/twilio/sms', { form: { From: PHONE, Body: 'C' }, headers: { 'X-Twilio-Signature': 'forged' } });
      s.expect(forged.status, 'forged webhook').toBe(403);
    });
  });
});
