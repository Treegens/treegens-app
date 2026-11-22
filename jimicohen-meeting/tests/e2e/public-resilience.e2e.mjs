/**
 * What a visitor can run into when something is not as usual: Google is down, Google is slow,
 * the calendar write fails, the email provider fails, an event type was switched off or is
 * unlisted, a bot fills the hidden field. And the conveniences around the booking page: links
 * that fill the form in, and the redirect after booking.
 */
import { defineSuite } from './lib.mjs';
import { FROM_EMAIL, MINUTE, MONDAY, OWNER_GOOGLE, PHONE, calendarReady, confirmBooking, fillDetails, jobLines, manageView, offeredSlots, openEvent, pickDay, pickSlot, plus, prepare } from './public-helpers.mjs';

const NEW_YORK = 'America/New_York';
const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };
const START = '2026-11-18T16:00:00.000Z';

async function toTheForm(s, page, { slug = 'intro', start = START, details = ADA } = {}) {
  await openEvent(s, page, slug);
  await pickDay(page, start.slice(0, 10));
  await pickSlot(page, start);
  return fillDetails(page, details);
}

const noticeText = async (page) => (await page.getByRole('form', { name: 'Your details' }).getByRole('alert').innerText()).replace(/\s+/g, ' ');

export default defineSuite('public-resilience', { mockCreds: true }, async (t) => {
  await t.scenario('a fresh deployment: closed until first-run setup, then it promises only what really goes out', { reset: true }, async (s) => {
    s.allowConsoleErrors(/status of 404/);
    await s.setClock(MONDAY);
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });

    await s.step('before setup: nothing on offer, and a booking sent anyway is refused', async () => {
      await page.goto(s.url('/'));
      await page.getByRole('heading', { name: 'Nothing to book just yet' }).waitFor();
      s.expect((await s.visitor().ok('GET', '/public/site')).eventTypes, 'event types on offer').toEqual([]);
      await page.goto(s.url('/intro'));
      await page.getByRole('heading', { name: 'This meeting type is not available', level: 1 }).waitFor();
      const notOpen = { code: 'not_open', message: 'This booking page is not taking bookings yet. Please check back soon.' };
      const booked = await s.book({ start: START, ...ADA });
      s.expect([booked.status, booked.data.error], 'a booking before setup').toEqual([503, notOpen]);
      const slots = await s.visitor().request('GET', '/public/slots', { query: { slug: 'intro', duration: 15, from: '2026-11-18T00:00:00Z', to: '2026-11-19T00:00:00Z' } });
      s.expect([slots.status, slots.data.error], 'times before setup').toEqual([503, notOpen]);
      s.expect(await s.bookings(), 'bookings').toEqual([]);
      s.expect(await s.outbox({ kind: 'email' }), 'emails').toEqual([]);
      await s.screenshot(page, 'closed before setup');
    });

    await s.step('the owner sets up, switches email off and connects no calendar', async () => {
      await s.setupAdmin({ timezone: 'Europe/London' });
      await s.apiOk('PUT', '/admin/site', { body: { email: { provider: 'none' } } });
    });

    await s.step('the page opens, and promises no Meet link, no email and no invitation', async () => {
      await openEvent(s, page, 'intro');
      s.expect(await page.getByText('You get the link when you book').count(), 'a Meet link promised').toBe(0);
      await pickDay(page, '2026-11-18');
      await pickSlot(page, START);
      const form = await fillDetails(page, ADA);
      await form.getByText('So your host can reach you about the meeting.').waitFor();
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      const done = page.locator('.bw-done');
      await done.getByText('No confirmation email is sent for this booking, so please add it to your calendar with the buttons below.').waitFor();
      s.expect(await done.getByText(/is on its way|are on their way/).count(), 'something promised to be on its way').toBe(0);
      s.expect((await done.locator('.bk-facts').innerText()).replace(/\s+/g, ' '), 'where').toContain('Google Meet The meeting link will be on your booking page once it is ready.');
      // Nothing reaches her calendar by itself here: the buttons are the way, under their plain label.
      await done.getByText('Add to your calendar', { exact: true }).waitFor();
      await done.getByRole('link', { name: 'Google', exact: true }).waitFor();
      await done.getByText(/These links are not emailed to you, so keep one of them to find your booking again\./).waitFor();
      s.expect(await s.outbox({ kind: 'email' }), 'emails').toEqual([]);
      await s.screenshot(page, 'a confirmation that promises only what goes out');
    });

    await s.step('and Home tells the owner that a booking reaches nobody', async () => {
      const { warnings } = await s.apiOk('GET', '/admin/overview');
      s.expect(warnings.find((w) => w.key === 'bookings_reach_nobody')?.message, 'the warning').toMatch(/^People can book "Intro call" and "Meeting", but nobody hears about it/);
      s.expect(warnings.find((w) => w.key === 'bookings_reach_nobody')?.href, 'its fix').toBe('/admin/integrations#google');
      s.expect(warnings[0], 'the calendar notice, first and in red').toMatchObject({ key: 'google_not_connected', tone: 'danger', title: "Bookings are not reaching anyone's calendar" });
    });
  });

  await t.scenario('Google is down while booking: nothing is booked, the visitor is told, and it works again later', async (s) => {
    await s.step('prepare', () => prepare(s));
    s.allowConsoleErrors(/status of 503/);
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });

    await s.step('the visitor fills the form while everything is fine', async () => {
      await toTheForm(s, page, { details: { ...ADA, topic: 'Will this survive?' } });
      await s.clearOutbox();
    });

    await s.step('Google stops answering; confirming fails closed with a friendly message', async () => {
      await s.failService('google-freebusy');
      await confirmBooking(s, page);
      await page.getByRole('form', { name: 'Your details' }).getByRole('alert').waitFor();
      s.expect(await noticeText(page), 'notice').toBe('The calendar is not answering right now Nothing was booked. Please try again in a minute, your details are still here.');
      await s.settle();
      s.expect(await s.bookings(), 'bookings').toEqual([]);
      s.expect((await s.kv('index/bookings')) ?? [], 'time held').toEqual([]);
      s.expect(await s.outbox({ kind: 'calendar_insert' }), 'calendar events').toEqual([]);
      s.expect(await s.outbox({ kind: 'email', to: ADA.email }), 'emails to the visitor').toEqual([]);
      // The form is still there, filled in.
      const form = page.getByRole('form', { name: 'Your details' });
      s.expect(await form.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'name').toBe(ADA.name);
      s.expect(await form.getByRole('textbox', { name: 'What would you like to talk about?' }).inputValue(), 'topic').toBe('Will this survive?');
      await s.screenshot(page, 'calendar not answering');
    });

    await s.step('the owner is alerted, once a day, however many people try', async () => {
      const second = await s.book({ start: START, email: 'second@example.com' });
      s.expect([second.status, second.data.error.code], 'another attempt').toEqual([503, 'calendar_unavailable']);
      s.expect(second.data.error.message, 'message').toBe('We could not check the calendar just now, so nothing was booked. Please try again in a minute.');
      await s.runJobs();
      const alerts = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
      // The alert names the Google account that could not be read: a host can have several.
      s.expect(alerts.map((e) => e.subject), 'alerts to the owner').toEqual([`A calendar needs attention: Jimi Cohen (${OWNER_GOOGLE})`]);
      s.expect(alerts[0].text, 'alert text').toContain('Someone just tried to book "Intro call", but the calendar of Jimi Cohen could not be read.');
    });

    await s.step('a new visitor sees why there are no times, not an empty calendar', async () => {
      // What the page knew about the calendar is good for a minute. After that it has to ask again, and cannot.
      await s.advanceClock({ minutes: 2 });
      const other = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
      await other.goto(s.url('/intro'));
      await other.getByRole('heading', { name: 'We cannot check the calendar right now' }).waitFor();
      s.expect(await other.locator('.bw-slot').count(), 'times offered while the calendar cannot be read').toBe(0);
      await other.getByText('We could not check the calendar just now, so no times are shown. Please try again in a minute.').waitFor();
      await s.screenshot(other, 'calendar error on the event page');
      // Google is back. The failure is remembered for a few seconds only.
      await s.clearFailures();
      await s.advanceClock({ seconds: 20 });
      await other.getByRole('button', { name: 'Try again' }).click();
      await calendarReady(other);
      await pickDay(other, '2026-11-18');
      s.expect((await offeredSlots(other)).map((x) => x.start), 'times after Google came back').toContain(START);
    });

    await s.step('the first visitor presses confirm again and is booked', async () => {
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      s.expect(await s.bookings(), 'bookings').toMatchObject([{ start: START, invitee: { email: ADA.email }, answers: [{ value: 'Will this survive?' }] }]);
      s.expect(await s.outbox({ kind: 'calendar_insert', status: 200 }), 'calendar events').toHaveLength(1);
    });
  });

  await t.scenario('the calendar write fails: the booking stands, a job repairs it, and the event appears', async (s) => {
    await s.step('prepare', () => prepare(s));
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });

    const booking = await s.step('Google refuses to store events; the visitor is booked all the same', async () => {
      await toTheForm(s, page);
      await s.clearOutbox();
      await s.failService('google-events-insert', { status: 503 });
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      const [stored] = await s.bookings();
      s.expect(stored, 'booking').toMatchObject({ status: 'confirmed', start: START, google: { hostId: 'host_owner', error: /./ } });
      s.expect(stored.google.eventId, 'no event yet').toBe('');
      s.expect(stored.location.joinUrl, 'no meeting link yet').toBe(undefined);
      // The page does not promise a link it does not have.
      const facts = (await page.locator('.bk-facts').innerText()).replace(/\s+/g, ' ');
      s.expect(facts, 'where').toContain('Google Meet The link is in your calendar invitation.');
      s.expect(await page.getByRole('link', { name: 'Open the meeting link' }).count(), 'join link').toBe(0);
      await s.screenshot(page, 'booked while the calendar write failed');
      return stored;
    });

    await s.step('the attempt was made twice, the time is held, and a repair is queued', async () => {
      s.expect((await s.outbox({ kind: 'calendar_insert' })).map((e) => e.status), 'insert attempts').toEqual([503, 503]);
      s.expect(await jobLines(s, { type: 'gcal_sync' }), 'repair job').toEqual([`${plus('2026-11-16T09:00:00.000Z', 2 * MINUTE)} gcal_sync - -`]);
      s.expect(await s.slots({ slug: 'intro', duration: 15, from: '2026-11-18T00:00:00Z', to: '2026-11-19T00:00:00Z' }), 'times offered').not.toContain(START);
    });

    await s.step('the invitee still got a confirmation, with a calendar file that works on its own', async () => {
      const [mail] = await s.outbox({ kind: 'email', to: ADA.email });
      s.expect(mail.subject, 'subject').toBe('Confirmed: Intro call with Jimi Cohen, Wed, Nov 18, 11:00 AM EST');
      // Google sends the real invitation once the repair job creates the event, so this email carries no file
      // that could become a second entry on her calendar (or the host's, who gets the event from Google too).
      s.expect(mail.hasIcs, 'calendar file').toBe(false);
      s.expect(mail.text, 'says Google is adding it').toContain('Google Calendar invitation from Jimi Cohen');
      const [notice] = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
      s.expect(notice.subject, 'host notice').toMatch(/^New booking: Ada Lovelace/);
      s.expect(notice.hasIcs, 'host calendar file').toBe(false);
    });

    await s.step('two minutes later Google works again: the job creates the event with its Meet link', async () => {
      await s.clearFailures();
      await s.advanceClock({ minutes: 2 });
      await s.runJobs();
      const inserts = await s.outbox({ kind: 'calendar_insert', status: 200 });
      s.expect(inserts, 'successful inserts').toHaveLength(1);
      s.expect(inserts[0].event.attendees.map((a) => a.email), 'attendees').toEqual([ADA.email]);
      s.expect(Date.parse(inserts[0].event.start.dateTime), 'event start').toBe(Date.parse(START));
      const [stored] = await s.bookings();
      s.expect(stored.google, 'calendar link').toMatchObject({ eventId: inserts[0].eventId, meetUrl: /^https:\/\/meet\.google\.com\// });
      s.expect(stored.google.error, 'error cleared').toBe(undefined);
      s.expect(stored.location.joinUrl, 'meeting link').toBe(stored.google.meetUrl);
      s.expect(await s.jobs({ type: 'gcal_sync' }), 'repair jobs left').toEqual([]);
      s.expect(await s.googleEvents(OWNER_GOOGLE), 'events on the calendar').toHaveLength(1);
      // Her booking page now has the link.
      await page.goto(booking.manageUrl);
      s.expect(await page.getByRole('link', { name: 'Open the meeting link' }).getAttribute('href'), 'join link').toBe(stored.google.meetUrl);
      s.expect((await manageView(s, booking)).booking.location.joinUrl, 'manage API').toBe(stored.google.meetUrl);
    });
  });

  await t.scenario('Google is slow on the calendar write: the visitor is not kept waiting, a job finishes it, one event', async (s) => {
    await s.step('prepare', () => prepare(s));
    await s.step('Google takes 8 seconds per write; the booking answers within its 7 second budget', async () => {
      await s.failService('google-events-insert', { mode: 'delay', ms: 8000 });
      const before = Date.now();
      const res = await s.book({ start: START, ...ADA, timezone: NEW_YORK });
      const took = Date.now() - before;
      s.expect(res.status, 'booking').toBe(201);
      s.expect(took, 'time to answer (ms)').toBeLessThan(7900);
      s.expect(took, 'time to answer (ms)').toBeGreaterThan(6000);
      s.expect(res.data.booking, 'answer').toMatchObject({ status: 'confirmed', start: START });
      s.expect(res.data.booking.location.joinUrl, 'no link yet').toBe(undefined);
      const [early] = await s.bookings();
      s.expect(early.google?.error, 'note on the booking').toBe('Google Calendar did not answer in time. Trying again shortly.');
      s.expect(await jobLines(s, { type: 'gcal_sync' }), 'safety net').toEqual([`${plus('2026-11-16T09:00:00.000Z', 1 * MINUTE)} gcal_sync - -`]);
    });

    await s.step('the attempt gives up in the background (each try is cut off after 6 seconds); the booking and its messages stand', async () => {
      await s.settle();
      const [stored] = await s.bookings();
      s.expect(stored, 'booking').toMatchObject({ status: 'confirmed', google: { hostId: 'host_owner', eventId: '', error: /Google/ } });
      s.expect(await s.outbox({ kind: 'calendar_insert', status: 200 }), 'events created so far').toEqual([]);
      // The confirmation went out after the attempt, without a link it does not have, and without a calendar
      // file: the invitation itself comes from Google once the job creates the event.
      const [mail] = await s.outbox({ kind: 'email', to: ADA.email });
      s.expect(mail.subject, 'confirmation').toBe('Confirmed: Intro call with Jimi Cohen, Wed, Nov 18, 11:00 AM EST');
      s.expect(mail.hasIcs, 'calendar file').toBe(false);
      s.expect(mail.text, 'no meeting link invented').not.toContain('meet.google.com');
      s.expect(await s.outbox({ kind: 'email', to: OWNER_GOOGLE }), 'host notice').toHaveLength(1);
    });

    await s.step('a minute later Google is itself again: the job creates the event, exactly once', async () => {
      await s.clearFailures();
      await s.advanceClock({ minutes: 1 });
      await s.runJobs();
      await s.runJobs();
      s.expect(await s.outbox({ kind: 'calendar_insert', status: 200 }), 'events created').toHaveLength(1);
      s.expect(await s.googleEvents(OWNER_GOOGLE), 'events on the calendar').toHaveLength(1);
      const [stored] = await s.bookings();
      s.expect(stored.google, 'calendar link').toMatchObject({ eventId: /./, meetUrl: /^https:\/\/meet\.google\.com\// });
      s.expect(stored.google.error, 'note').toBe(undefined);
      s.expect(stored.location.joinUrl, 'meeting link').toBe(stored.google.meetUrl);
      s.expect(await s.jobs({ type: 'gcal_sync' }), 'repair jobs left').toEqual([]);
      // Google itself now invites the guest (the event was created with notifications on).
      s.expect((await s.outbox({ kind: 'calendar_insert', status: 200 }))[0], 'insert').toMatchObject({ sendUpdates: 'all', notified: [ADA.email] });
    });
  });

  await t.scenario('the email provider fails: the booking stands and the messages are retried until they arrive, once', async (s) => {
    await s.step('prepare', () => prepare(s));
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });

    await s.step('the provider answers 500 while the visitor books', async () => {
      await toTheForm(s, page);
      await s.clearOutbox();
      await s.failService('resend');
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      s.expect(await s.bookings(), 'bookings').toMatchObject([{ status: 'confirmed', start: START }]);
      s.expect((await s.outbox({ kind: 'email' })).map((e) => `${e.service} ${e.status} ${e.injected}`), 'attempts').toEqual(['resend 500 error', 'resend 500 error']);
      const [stored] = await s.bookings();
      s.expect(stored.timeline.map((e) => e.type).filter((type) => type.endsWith('_failed')).sort(), 'timeline').toEqual(['confirmation_email_failed', 'host_new_email_failed']);
    });

    await s.step('both messages wait for a second attempt two minutes later', async () => {
      const retry = plus('2026-11-16T09:00:00.000Z', 2 * MINUTE);
      s.expect((await s.jobs((j) => j.attempt === 1)).map((j) => `${j.dueAt} ${j.kind} ${j.channel} ${j.audience}`).sort(), 'retries').toEqual([`${retry} confirmation email invitee`, `${retry} host_new email host`]);
      // Before that moment nothing is tried again.
      await s.advanceClock({ minutes: 1 });
      await s.runJobs();
      s.expect(await s.outbox({ kind: 'email' }), 'attempts so far').toHaveLength(2);
    });

    await s.step('still failing at the second attempt: a third is planned ten minutes on', async () => {
      await s.advanceClock({ minutes: 1 });
      await s.runJobs();
      s.expect(await s.outbox({ kind: 'email' }), 'attempts so far').toHaveLength(4);
      s.expect((await s.jobs((j) => j.attempt === 2)).map((j) => j.dueAt), 'third attempts').toEqual([plus('2026-11-16T09:02:00.000Z', 10 * MINUTE), plus('2026-11-16T09:02:00.000Z', 10 * MINUTE)]);
    });

    await s.step('the provider recovers: each message arrives exactly once', async () => {
      await s.clearFailures();
      await s.advanceClock({ minutes: 10 });
      await s.runJobs();
      await s.runJobs();
      const delivered = await s.outbox({ kind: 'email', status: 200 });
      s.expect(delivered.map((e) => `${e.to.join(',')} | ${e.subject}`).sort(), 'delivered').toEqual([
        `${ADA.email} | Confirmed: Intro call with Jimi Cohen, Wed, Nov 18, 11:00 AM EST`,
        `${OWNER_GOOGLE} | New booking: Ada Lovelace for Intro call, Wed, Nov 18, 4:00 PM GMT`,
      ]);
      s.expect(delivered[0].fromEmail, 'from').toBe(FROM_EMAIL);
      s.expect(await s.jobs((j) => j.kind === 'confirmation' || j.kind === 'host_new'), 'nothing left to retry').toEqual([]);
      const [stored] = await s.bookings();
      s.expect(stored.timeline.map((e) => e.type).filter((type) => type.endsWith('_email_sent')).sort(), 'timeline').toEqual(['confirmation_email_sent', 'host_new_email_sent']);
    });
  });

  await t.scenario('an event type that was switched off, and one that is unlisted', async (s) => {
    await s.step('prepare', () => prepare(s));
    s.allowConsoleErrors(/status of 404/);
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
    const open = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });

    await s.step('a visitor has the "Meeting" form open when the owner switches it off', async () => {
      await toTheForm(s, open, { slug: 'meeting', start: '2026-11-18T15:00:00.000Z' });
      await s.apiOk('PUT', '/admin/event-types/evt_meeting', { body: { active: false } });
    });

    await s.step('the landing page no longer lists it', async () => {
      await page.goto(s.url('/'));
      await page.getByRole('heading', { name: 'One way to meet' }).waitFor();
      s.expect(await page.getByRole('list').getByRole('link').allInnerTexts(), 'cards').toHaveLength(1);
      s.expect(await page.getByRole('link', { name: /Intro call/ }).count(), 'intro card').toBe(1);
      s.expect(await page.getByRole('link', { name: /^.*Meeting Partnerships/ }).count(), 'meeting card').toBe(0);
    });

    await s.step('its address says it is not available and points to what is', async () => {
      await page.goto(s.url('/meeting'));
      await page.getByRole('heading', { name: 'This meeting type is not available', level: 1 }).waitFor();
      await page.getByText('It may have been renamed or switched off. You can still pick from the meetings on offer.').waitFor();
      await s.screenshot(page, 'switched off');
      await page.getByRole('link', { name: 'See all meeting types' }).click();
      await page.getByRole('heading', { name: 'Book time with Jimi', level: 1 }).waitFor();
    });

    await s.step('the visitor who still had the form open is told, and nothing is booked', async () => {
      await confirmBooking(s, open);
      const alert = open.getByRole('form', { name: 'Your details' }).getByRole('alert');
      await alert.waitFor();
      s.expect((await alert.innerText()).replace(/\s+/g, ' '), 'notice').toBe('We could not complete the booking This meeting type is no longer available.');
      s.expect(await s.bookings(), 'bookings').toEqual([]);
      const api = await s.book({ slug: 'meeting', start: '2026-11-18T15:00:00.000Z', durationMin: 30 });
      s.expect([api.status, api.data.error.code], 'through the API').toEqual([404, 'not_found']);
      const slots = await s.visitor().ok('GET', '/public/slots', { query: { slug: 'meeting', duration: 30, from: '2026-11-18T00:00:00Z', to: '2026-11-19T00:00:00Z' } });
      s.expect(slots, 'slots of a switched-off event').toMatchObject({ slots: [], unavailableReason: 'inactive' });
    });

    await s.step('switched on again but unlisted: not on the landing page, bookable by its link', async () => {
      await s.apiOk('PUT', '/admin/event-types/evt_meeting', { body: { active: true, visibility: 'unlisted' } });
      await page.goto(s.url('/'));
      await page.getByRole('heading', { name: 'One way to meet' }).waitFor();
      s.expect((await s.visitor().ok('GET', '/public/site')).eventTypes.map((e) => e.slug), 'listed event types').toEqual(['intro']);

      await openEvent(s, page, 'meeting');
      await page.getByRole('heading', { name: 'Meeting', level: 1 }).waitFor();
      // A page that is not listed does not link back to a list it is not on.
      s.expect(await page.getByRole('link', { name: 'All meeting types' }).count(), 'back link').toBe(0);
      await pickDay(page, '2026-11-18');
      await pickSlot(page, '2026-11-18T15:00:00.000Z');
      await fillDetails(page, { name: 'Secret Guest', email: 'secret@example.com' });
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      s.expect(await s.bookings(), 'bookings').toMatchObject([{ eventSlug: 'meeting', durationMin: 30, invitee: { email: 'secret@example.com' } }]);
    });

    await s.step('an address that never existed gets the same friendly page', async () => {
      await page.goto(s.url('/no-such-meeting'));
      await page.getByRole('heading', { name: 'This meeting type is not available', level: 1 }).waitFor();
    });
  });

  await t.scenario('the honeypot and the too-fast submit are refused without saying why', async (s) => {
    await s.step('prepare', () => prepare(s));
    s.allowConsoleErrors(/status of 422/);
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });

    await s.step('the hidden field is not visible, not focusable and not announced', async () => {
      await toTheForm(s, page);
      const trap = page.locator('input[name="website"]');
      s.expect(await trap.count(), 'the field exists for bots').toBe(1);
      // Far off the left edge, fully transparent, and it does not take clicks.
      const box = await trap.boundingBox();
      s.expect(box.x + box.width, 'right edge of the field').toBeLessThan(0);
      s.expect(await trap.evaluate((el) => getComputedStyle(el.closest('.bw-hp')).opacity), 'opacity').toBe('0');
      s.expect(await trap.evaluate((el) => el.closest('[aria-hidden="true"]') !== null), 'hidden from assistive tech').toBe(true);
      s.expect(await trap.getAttribute('tabindex'), 'tab stop').toBe('-1');
      s.expect(await trap.getAttribute('autocomplete'), 'autofill').toBe('off');
      s.expect(await page.getByRole('textbox', { name: 'Website' }).count(), 'in the accessibility tree').toBe(0);
    });

    await s.step('a bot that fills it gets a plain refusal, and nothing is stored or sent', async () => {
      await s.clearOutbox();
      await page.locator('input[name="website"]').fill('https://spam.example', { force: true });
      await confirmBooking(s, page);
      const alert = page.getByRole('form', { name: 'Your details' }).getByRole('alert');
      await alert.waitFor();
      s.expect((await alert.innerText()).replace(/\s+/g, ' '), 'notice').toBe('We could not complete the booking Could not complete the booking. Please try again.');
      await s.settle();
      s.expect(await s.bookings(), 'bookings').toEqual([]);
      s.expect((await s.outbox()).filter((e) => e.kind !== 'freebusy'), 'provider calls').toEqual([]);
      await s.screenshot(page, 'refused');
    });

    await s.step('through the API: the trap, a submit after half a second, and both together answer the same', async () => {
      const base = { start: START, ...ADA };
      const trapped = await s.book({ ...base, website: 'x' });
      const tooFast = await s.book({ ...base, elapsedMs: 500 });
      const both = await s.book({ ...base, website: 'x', elapsedMs: 1 });
      for (const res of [trapped, tooFast, both]) {
        s.expect(res.status, 'status').toBe(422);
        s.expect(res.data, 'answer').toEqual({ error: { code: 'invalid', message: 'Could not complete the booking. Please try again.' } });
      }
      s.expect(await s.bookings(), 'bookings').toEqual([]);
      // A person who takes two seconds is fine.
      const human = await s.book({ ...base, elapsedMs: 2000 });
      s.expect(human.status, 'a human-speed booking').toBe(201);
    });
  });

  await t.scenario('links that fill the form in, and field errors from the server', async (s) => {
    await s.step('prepare', () => prepare(s));
    s.allowConsoleErrors(/status of 422/);
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });

    await s.step('name, email, phone and day from the link; campaign tags travel with the booking', async () => {
      const query = `?name=${encodeURIComponent('Sam Lee')}&email=${encodeURIComponent('sam@example.com')}&phone=${encodeURIComponent(PHONE)}&date=2026-11-19&utm_source=newsletter&utm_campaign=${encodeURIComponent('autumn 2026')}&unrelated=1`;
      await openEvent(s, page, 'intro', query);
      // Thursday is already chosen.
      await page.getByRole('heading', { name: 'Thursday, November 19', exact: true }).waitFor();
      s.expect(await page.locator('.bw-day[data-day="2026-11-19"]').getAttribute('aria-pressed'), 'Thursday selected').toBe('true');
      await pickSlot(page, '2026-11-19T15:00:00.000Z');
      const form = page.getByRole('form', { name: 'Your details' });
      await form.waitFor();
      s.expect(await form.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'name').toBe('Sam Lee');
      s.expect(await form.getByRole('textbox', { name: 'Email', exact: true }).inputValue(), 'email').toBe('sam@example.com');
      s.expect(await form.locator('input[type="tel"]').inputValue(), 'phone').toBe(PHONE);
      await s.screenshot(page, 'prefilled form');
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      const [stored] = await s.bookings();
      s.expect(stored, 'booking').toMatchObject({ start: '2026-11-19T15:00:00.000Z', invitee: { name: 'Sam Lee', email: 'sam@example.com', phone: PHONE }, utm: { utm_source: 'newsletter', utm_campaign: 'autumn 2026' } });
      s.expect(Object.keys(stored.utm), 'only campaign tags are kept').toEqual(['utm_source', 'utm_campaign']);
    });

    await s.step('a length and a month from the link', async () => {
      const other = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
      await openEvent(s, other, 'meeting', '?duration=45&month=2026-12');
      await other.getByRole('grid', { name: 'December 2026' }).waitFor();
      s.expect(await other.getByRole('radio', { name: '45 min' }).getAttribute('aria-checked'), '45 minutes preselected').toBe('true');
      await pickDay(other, '2026-12-01');
      const slots = await offeredSlots(other);
      // 45 minutes on a half-hour grid, 09:00 to 17:00 London: the last start is 16:00.
      s.expect([slots[0].start, slots.at(-1).start], 'first and last 45 minute time').toEqual(['2026-12-01T09:00:00.000Z', '2026-12-01T16:00:00.000Z']);
      // A length that is not on offer, a day in the past and a month out of range fall back quietly.
      await openEvent(s, other, 'meeting', '?duration=20&date=2020-01-01&month=1999-01');
      await other.getByRole('grid', { name: 'November 2026' }).waitFor();
      s.expect(await other.getByRole('radio', { name: '30 min' }).getAttribute('aria-checked'), 'default length').toBe('true');
    });

    await s.step('markup in a prefilled name is shown as text, never run', async () => {
      const other = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
      await openEvent(s, other, 'intro', `?name=${encodeURIComponent('<img src=x onerror=alert(1)>')}&date=2026-11-19`);
      await pickSlot(other, '2026-11-19T16:00:00.000Z');
      const form = other.getByRole('form', { name: 'Your details' });
      s.expect(await form.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'name').toBe('<img src=x onerror=alert(1)>');
      s.expect(await other.locator('img[src="x"]').count(), 'injected elements').toBe(0);
    });

    await s.step('what the server does not accept comes back on the right field', async () => {
      // The browser checks first, so these go straight to the API, the way a script or an old tab would.
      const bad = await s.book({ start: '2026-11-20T10:00:00.000Z', name: '', email: 'not-an-email', phone: '12', guests: ['nope'] });
      s.expect(bad.status, 'status').toBe(422);
      s.expect(bad.data.error.code, 'code').toBe('invalid');
      s.expect(Object.keys(bad.data.error.fields).sort(), 'fields').toEqual(['email', 'guests', 'name', 'phone']);
      for (const message of Object.values(bad.data.error.fields)) s.expect(message, 'field message').not.toContain('—');
      const offGrid = await s.book({ start: '2026-11-20T10:07:00.000Z', email: 'grid@example.com' });
      s.expect([offGrid.status, offGrid.data.error.code], 'a time that is not on the grid').toEqual([409, 'slot_taken']);
      const weekend = await s.book({ start: '2026-11-21T10:00:00.000Z', email: 'weekend@example.com' });
      s.expect([weekend.status, weekend.data.error.code], 'a Saturday').toEqual([409, 'slot_taken']);
      const tooSoon = await s.book({ start: '2026-11-16T10:00:00.000Z', email: 'soon@example.com' });
      s.expect([tooSoon.status, tooSoon.data.error.code], 'inside the notice period').toEqual([409, 'slot_taken']);
      s.expect(await s.bookings(), 'bookings').toHaveLength(1);
    });
  });

  await t.scenario('redirect after booking, and a note from the host', async (s) => {
    await s.step('prepare: the intro call sends people on to a thank-you page', async () => {
      await prepare(s);
      await s.apiOk('PUT', '/admin/event-types/evt_intro', {
        body: { confirmation: { message: 'Thanks {{invitee_first_name}}! Bring your questions about {{event_name}}.', redirectUrl: 'https://thanks.example.org/welcome?from=meeting' } },
      });
    });
    // The thank-you page is not ours: the browser may ask for it, and nothing answers there in a test.
    s.allowExternalRequests(/^https:\/\/thanks\.example\.org\//);
    s.allowConsoleErrors(/ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED/);
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });

    await s.step('the confirmation shows the note and counts down', async () => {
      await toTheForm(s, page);
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      await page.getByText('A note from Jimi').waitFor();
      await page.getByText('Thanks Ada! Bring your questions about Intro call.').waitFor();
      await page.getByText(/^Taking you to thanks\.example\.org in \d s\.$/).waitFor();
      s.expect(await page.getByRole('link', { name: 'Go now' }).getAttribute('href'), '"Go now"').toBe('https://thanks.example.org/welcome?from=meeting');
      await s.screenshot(page, 'confirmation with redirect');
    });

    await s.step('"Stay here" stops it', async () => {
      await page.getByRole('button', { name: 'Stay here' }).click();
      await page.getByText('Continue to thanks.example.org whenever you are ready.').waitFor();
      await s.linger(page, 10_000);
      s.expect(new URL(page.url()).origin, 'still on the booking page').toBe(new URL(s.url('/')).origin);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
    });

    await s.step('left alone, the next visitor is taken to the page after six seconds', async () => {
      const other = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
      await toTheForm(s, other, { start: '2026-11-19T16:00:00.000Z', details: { name: 'Grace Hopper', email: 'grace@example.com' } });
      await confirmBooking(s, other);
      await other.getByRole('heading', { name: "You're booked" }).waitFor();
      const leaving = other.waitForRequest((request) => request.url() === 'https://thanks.example.org/welcome?from=meeting' && request.isNavigationRequest());
      for (let i = 0; i < 7; i++) await s.linger(other, 1000);
      await leaving;
    });

    await s.step('the address is only ever taken from the owner, and only https', async () => {
      const view = await manageView(s, (await s.bookings())[0]);
      s.expect(view.booking.redirectUrl, 'redirect in the public view').toBe('https://thanks.example.org/welcome?from=meeting');
      const refused = await s.api('PUT', '/admin/event-types/evt_intro', { body: { confirmation: { redirectUrl: 'javascript:alert(1)' } } });
      s.expect(refused.status, 'a javascript: address').toBe(422);
      const plain = await s.api('PUT', '/admin/event-types/evt_intro', { body: { confirmation: { redirectUrl: 'http://thanks.example.org/' } } });
      s.expect(plain.status, 'an http: address').toBe(422);
    });
  });
});
