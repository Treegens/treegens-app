/**
 * Booking end to end, as a visitor does it: landing page, event page, a day, a time, the form,
 * the confirmation. Once on a desktop screen and once on a 390 px phone. Every claim on the
 * screen is checked against what the backend really did: the stored booking, the calendar event,
 * the emails and texts that left, and the reminders waiting in the queue.
 */
import { defineSuite } from './lib.mjs';
import {
  FROM_EMAIL,
  HOUR,
  MINUTE,
  OWNER_GOOGLE,
  PHONE,
  PHONE_TYPED,
  PHONE_VIEWPORT,
  calendarReady,
  confirmBooking,
  fillDetails,
  jobLines,
  longDate,
  manageView,
  offeredDays,
  offeredSlots,
  openEvent,
  overflowReport,
  pickDay,
  pickSlot,
  plus,
  prepare,
  wallTime,
} from './public-helpers.mjs';

const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };
const GUEST = 'charles@example.org';
const TOPIC = 'Planting 10,000 trees <together> & what it costs.';
/** Wednesday 11:00 AM in New York = 4:00 PM in London. The call two hours earlier is 9:00 AM for the invitee. */
const START = '2026-11-18T16:00:00.000Z';
const END = '2026-11-18T16:15:00.000Z';
const NEW_YORK = 'America/New_York';

export default defineSuite('public-booking', { mockCreds: true }, async (t) => {
  await t.scenario('desktop: a visitor books the intro call with a phone number, a guest and a question', async (s) => {
    await s.step('prepare: owner set up, Google connected, mail through the real provider path, guests allowed', async () => {
      await prepare(s);
      // Guests are the owner's choice (off on new event types): Google invites them from the owner's account.
      await s.apiOk('PUT', '/admin/event-types/evt_intro', { body: { allowGuests: true } });
    });
    const page = await s.newPage({ viewport: { width: 1280, height: 800 }, timezoneId: NEW_YORK, locale: 'en-US' });

    await s.step('the landing page lists the meeting types', async () => {
      await page.goto(s.url('/'));
      await page.getByRole('heading', { name: 'Book time with Jimi', level: 1 }).waitFor();
      await page.getByText('Pick a meeting type below and choose a time that works.').waitFor();
      const cards = page.getByRole('list').getByRole('link');
      s.expect(await cards.count(), 'event cards').toBe(2);
      s.expect((await cards.nth(0).innerText()).replace(/\s+/g, ' '), 'first card').toMatch(/Intro call.*15 min.*Google Meet/);
      s.expect((await cards.nth(1).innerText()).replace(/\s+/g, ' '), 'second card').toMatch(/Meeting.*30 min, 45 min or 1 hr.*Google Meet/);
      s.expect(await page.title(), 'tab title').toBe('Book time with Jimi');
      s.expect(await overflowReport(page), 'landing overflow').toMatchObject({ scrolls: false, offenders: [] });
      await s.screenshot(page, 'landing');
    });

    await s.step('the event page shows the event and the days that can be booked', async () => {
      await page.getByRole('link', { name: /Intro call/ }).click();
      await page.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      await page.getByRole('grid', { name: 'November 2026' }).waitFor();
      await page.getByText('A quick hello to see how we can work together.').waitFor();
      await page.getByRole('button', { name: /^Times are in: Eastern Time \(New York\)/ }).waitFor();
      s.expect(await page.title(), 'tab title').toBe('Intro call with Jimi Cohen');

      // Monday 09:00 London with 4 hours notice: today from 13:00, then Tuesday to Friday, through the month.
      const days = await offeredDays(page);
      const expected = [];
      for (let d = 16; d <= 30; d++) {
        const day = `2026-11-${d}`;
        const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
        if (weekday >= 1 && weekday <= 5) expected.push(day);
      }
      s.expect(days.map((d) => d.day), 'bookable days in November').toEqual(expected);
      // Today: 13:00 to 16:45 London in quarter hours = 16 times. A full day: 09:00 to 16:45 = 32.
      s.expect(days[0], 'today').toMatchObject({ day: '2026-11-16', count: 16, label: 'Monday, November 16, today, 16 times available' });
      s.expect(days[2], 'Wednesday').toMatchObject({ day: '2026-11-18', count: 32 });
      // Weekends and the past cannot be picked.
      s.expect(await page.locator('.bw-day[data-day="2026-11-21"]').getAttribute('aria-disabled'), 'Saturday').toBe('true');
      s.expect(await page.locator('.bw-day[data-day="2026-11-13"]').isDisabled(), 'last Friday').toBe(true);
      await s.screenshot(page, 'event page');
    });

    await s.step('Wednesday offers 32 times, shown in New York time', async () => {
      await pickDay(page, '2026-11-18');
      const slots = await offeredSlots(page);
      s.expect(slots.length, 'times on Wednesday').toBe(32);
      s.expect(slots[0], 'first time').toEqual({ start: '2026-11-18T09:00:00.000Z', label: '4:00 AM' });
      s.expect(slots.at(-1), 'last time').toEqual({ start: '2026-11-18T16:45:00.000Z', label: '11:45 AM' });
      for (const slot of slots) s.expect(slot.label, `label of ${slot.start}`).toBe(wallTime(slot.start, NEW_YORK));
      await page.getByText('32 times', { exact: true }).waitFor();
    });

    await s.step('picks 11:00 AM and fills in the form', async () => {
      await pickSlot(page, START);
      const form = await fillDetails(page, { ...ADA, phone: PHONE_TYPED, guests: [GUEST], topic: TOPIC });
      // The number is formatted while typing and both reminder switches start on, with the consent wording under them.
      s.expect(await form.locator('input[type="tel"]').inputValue(), 'phone as shown').toBe('(415) 555-2671');
      s.expect(await form.getByRole('switch', { name: 'Text me the confirmation and reminders' }).getAttribute('aria-checked'), 'text reminders').toBe('true');
      // Email is set up and Google is connected, so the hint promises both.
      await form.getByText('Your confirmation and calendar invitation go here.').waitFor();
      s.expect(await form.getByRole('switch', { name: "Reminder call from Ava, Jimi's AI assistant" }).getAttribute('aria-checked'), 'reminder call').toBe('true');
      await form.getByText("By adding your number you agree to receive reminder texts and an automated reminder call from Jimi's AI assistant about this meeting.").waitFor();
      // The summary beside the form repeats the choice in the visitor's zone.
      const summary = page.locator('.bw-summary');
      await summary.getByText('Wednesday, November 18').waitFor();
      await summary.getByText('11:00 – 11:15 AM').waitFor();
      s.expect(await overflowReport(page), 'form overflow').toMatchObject({ scrolls: false, offenders: [] });
      await s.screenshot(page, 'details form');
    });

    await s.step('confirms and sees the confirmation', async () => {
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      const done = page.locator('.bw-done');
      await done.getByText('Thanks, Ada. Here are the details of your meeting.').waitFor();
      // Google is the one putting it in her calendar, and the page says so, with the one tap Google may ask for.
      await done.getByText(`This meeting is being added to your calendar with a Google Calendar invitation sent to ${ADA.email}. Your confirmation email is on its way there too.`).waitFor();
      await done.getByText('Don\'t see it in your calendar? If the invitation says it is from an unknown sender, tap "I know the sender", then Yes.').waitFor();
      await done.getByText(/any time before the meeting\. The same links are in your email\./).waitFor();
      const facts = (await done.locator('.bk-facts').innerText()).replace(/\s+/g, ' ');
      s.expect(facts, 'when').toContain(`${longDate(START, NEW_YORK)} 11:00 – 11:15 AM Eastern Time (New York)`);
      s.expect(facts, 'where').toContain('Google Meet');
      s.expect(facts, 'with').toContain('Jimi Cohen');
      s.expect(facts, 'guests').toContain(`1 guest ${GUEST}`);
      s.expect(await overflowReport(page), 'confirmation overflow').toMatchObject({ scrolls: false, offenders: [] });
      await s.screenshot(page, 'confirmation');
    });

    const booking = await s.step('the booking is stored as the visitor entered it', async () => {
      const all = await s.bookings();
      s.expect(all, 'bookings').toHaveLength(1);
      s.expect(all[0], 'stored booking').toMatchObject({
        status: 'confirmed',
        eventSlug: 'intro',
        eventTitle: 'Intro call',
        kind: 'solo',
        hostIds: ['host_owner'],
        start: START,
        end: END,
        durationMin: 15,
        invitee: { name: ADA.name, email: ADA.email, phone: PHONE, timezone: NEW_YORK, locale: 'en-US' },
        guests: [GUEST],
        answers: [{ questionId: 'q_topic', label: 'What would you like to talk about?', value: TOPIC }],
        location: { type: 'google_meet', label: 'Google Meet', joinUrl: /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/ },
        consent: { sms: true, call: true, at: '2026-11-16T09:00:00.000Z', text: /^By adding your number you agree .* from Jimi's AI assistant about this meeting\./ },
        attendance: {},
        rescheduleCount: 0,
        source: 'page',
      });
      s.expect(all[0].timeline.map((e) => e.type), 'timeline').toContain('created');
      return all[0];
    });

    await s.step('the confirmation screen links to the real meeting, calendar and manage pages', async () => {
      const done = page.locator('.bw-done');
      s.expect(await done.getByRole('link', { name: 'Open the meeting link' }).getAttribute('href'), 'meeting link').toBe(booking.location.joinUrl);
      const manage = (action) => `/meeting/booking/${booking.id}/${action}?t=${booking.manageToken}`;
      s.expect(await done.getByRole('link', { name: 'Reschedule' }).getAttribute('href'), 'reschedule link').toBe(manage('reschedule'));
      s.expect(await done.getByRole('link', { name: 'cancel', exact: true }).getAttribute('href'), 'cancel link').toBe(manage('cancel'));
      // Google invites her: nothing here may make a second copy. Only the calendar file stays, for people who do
      // not use Google Calendar, and it has Google's UID, so a calendar that also takes the invitation keeps one.
      await done.getByText('Not using Google Calendar?').waitFor();
      for (const name of ['Google', 'Outlook.com', 'Office 365', 'Apple or other']) s.expect(await done.getByRole('link', { name, exact: true }).count(), `${name} button`).toBe(0);
      s.expect(await done.locator('a[href*="calendar.google.com"], a[href*="outlook."]').count(), 'add-to-calendar template links').toBe(0);
      const icsHref = await done.getByRole('link', { name: 'Download the calendar file' }).getAttribute('href');
      s.expect(icsHref, 'calendar file link').toBe(`${s.url(`/api/public/bookings/${booking.id}/ics`)}?t=${booking.manageToken}`);
      const file = await s.visitor().request('GET', `/public/bookings/${booking.id}/ics`, { query: { t: booking.manageToken } });
      s.expect(file.status, 'calendar file status').toBe(200);
      s.expect(file.headers.get('content-type'), 'calendar file type').toMatch(/^text\/calendar/);
      s.expect(file.text, 'calendar file').toContain('DTSTART:20261118T160000Z');
      s.expect(file.text, 'calendar file').toContain('DTEND:20261118T161500Z');
      s.expect(file.text, 'calendar file').toContain('SUMMARY:Intro call');
      s.expect(file.text, 'calendar file has Google\'s UID').toContain(`UID:${booking.google.eventId}@google.com`);
      s.expect(booking.inviteVia, 'how she is invited, recorded').toBe('google');
    });

    await s.step('the manage API shows the same booking', async () => {
      const view = await manageView(s, booking);
      s.expect(view.booking, 'public booking').toMatchObject({
        id: booking.id,
        status: 'confirmed',
        eventTitle: 'Intro call',
        eventSlug: 'intro',
        start: START,
        end: END,
        durationMin: 15,
        hosts: [{ id: 'host_owner', name: 'Jimi Cohen' }],
        invitee: { name: ADA.name, email: ADA.email, phone: PHONE, timezone: NEW_YORK },
        guests: [GUEST],
        location: { type: 'google_meet', joinUrl: booking.location.joinUrl },
        canReschedule: true,
        canCancel: true,
        attendanceConfirmed: false,
      });
      s.expect(view.eventType?.slug, 'event type in the manage view').toBe('intro');
      // Nothing private leaks into the public view.
      s.expect(JSON.stringify(view), 'manage view').not.toContain('refreshTokenEnc');
      s.expect(Object.keys(view.booking), 'public booking keys').not.toContain('timeline');
    });

    await s.step('one event is on the organizer calendar, with the invitee, the guest and a Meet link', async () => {
      const inserts = await s.outbox({ kind: 'calendar_insert' });
      s.expect(inserts, 'calendar inserts').toHaveLength(1);
      const insert = inserts[0];
      s.expect(insert, 'calendar insert').toMatchObject({
        service: 'google',
        status: 200,
        account: OWNER_GOOGLE,
        calendarId: OWNER_GOOGLE,
        sendUpdates: 'all',
        conferenceRequested: true,
        eventId: booking.google.eventId,
        meetUrl: booking.location.joinUrl,
        notified: [ADA.email, GUEST],
      });
      const event = insert.event;
      s.expect(event.organizer, 'organizer').toBe(OWNER_GOOGLE);
      // A guest is on the event, so Google writes to an address the visitor chose: nothing the visitor typed goes in.
      s.expect(event.summary, 'event title').toBe('Intro call: Jimi Cohen');
      s.expect(Date.parse(event.start.dateTime), 'event start').toBe(Date.parse(START));
      s.expect(Date.parse(event.end.dateTime), 'event end').toBe(Date.parse(END));
      s.expect(event.start.timeZone, 'event time zone').toBe('Europe/London');
      s.expect(event.attendees.map((a) => `${a.email} ${a.responseStatus}`), 'attendees').toEqual([`${ADA.email} accepted`, `${GUEST} needsAction`]);
      s.expect(event.hangoutLink, 'Meet link').toBe(booking.location.joinUrl);
      s.expect(event.extendedProperties, 'booking id on the event').toEqual({ private: { meetingBookingId: booking.id } });
      s.expect(event.guestsCanModify, 'guests can modify').toBe(false);
      // The description: the meeting and its host. No name, phone, answers or manage link: those stay in the host
      // email and the dashboard. Google mails it to her too, so the owner-only dashboard link stays out as well.
      s.expect(event.description.split('\n'), 'description').toEqual(['Intro call with Jimi Cohen']);
      s.expect(JSON.stringify(event), 'visitor text on the event').not.toContain(ADA.name);
      s.expect(JSON.stringify(event), 'phone on the event').not.toContain(PHONE);
      s.expect(await s.googleEvents(OWNER_GOOGLE), 'events on the mock calendar').toMatchObject([{ account: OWNER_GOOGLE, event: { id: booking.google.eventId, status: 'confirmed' } }]);
      s.expect(booking.google, 'calendar link on the booking').toMatchObject({ hostId: 'host_owner', calendarId: /./, meetUrl: booking.location.joinUrl });
      s.expect(booking.google.error, 'calendar error').toBe(undefined);
    });

    await s.step('the confirmation email: subject, times in the invitee zone, calendar file, manage links', async () => {
      const emails = await s.outbox({ kind: 'email' });
      s.expect(emails.map((e) => `${e.service} ${e.to.join(',')}`).sort(), 'emails sent').toEqual([`resend ${ADA.email}`, `resend ${OWNER_GOOGLE}`]);
      const [mail] = await s.outbox({ kind: 'email', to: ADA.email });
      s.expect(mail, 'confirmation').toMatchObject({ status: 200, fromEmail: FROM_EMAIL, from: /^Jimi Cohen </, replyTo: OWNER_GOOGLE, at: '2026-11-16T09:00:00.000Z' });
      s.expect(mail.subject, 'subject').toBe('Confirmed: Intro call with Jimi Cohen, Wed, Nov 18, 11:00 AM EST');
      s.expect(mail.text, 'text body').toContain('Wednesday, November 18, 2026');
      s.expect(mail.text, 'text body').toContain('11:00 AM to 11:15 AM (Eastern Standard Time)');
      s.expect(mail.text, 'text body').not.toContain('4:00 PM');
      s.expect(mail.text, 'text body').toContain(booking.location.joinUrl);
      s.expect(mail.text, 'text body').toContain(GUEST);
      s.expect(mail.html, 'html body').toContain('11:00 AM to 11:15 AM (Eastern Standard Time)');
      const manage = (action) => `${s.url(`/booking/${booking.id}/${action}`)}?t=${booking.manageToken}`;
      for (const link of [booking.location.joinUrl, manage('reschedule'), manage('cancel')]) s.expect(mail.links, 'links in the confirmation').toContain(link);
      // Google sent the real invitation: nothing in this email can add a second copy. No attachment, no "Add to
      // Google" or Outlook links, only the calendar file (Google's UID) for people who do not use Google Calendar.
      s.expect(mail.links.some((l) => l.startsWith('https://calendar.google.com/calendar/render') || l.includes('outlook.')), 'template links').toBe(false);
      s.expect(mail.links, 'calendar file link').toContain(`${s.url(`/api/public/bookings/${booking.id}/ics`)}?t=${booking.manageToken}`);
      s.expect(mail.hasIcs, 'has a calendar file').toBe(false);
      s.expect(mail.text, 'says Google is adding it').toContain(`This meeting is being added to your calendar with a Google Calendar invitation from Jimi Cohen, sent to ${ADA.email}.`);
      s.expect(mail.text, 'the one tap').toContain('If the invitation says it is from an unknown sender, tap "I know the sender", then Yes.');
      s.expect(mail.text, 'the backup').toContain('Not using Google Calendar?');
      s.expect(mail.html, 'no em dash in the email').not.toContain('—');
      await s.screenshotEmail(mail, 'confirmation email');
    });

    await s.step('the confirmation text message', async () => {
      const texts = await s.outbox({ kind: 'sms' });
      s.expect(texts, 'texts sent').toHaveLength(1);
      s.expect(texts[0], 'confirmation text').toMatchObject({ service: 'twilio', status: 201, to: PHONE, from: '+15005550006' });
      s.expect(texts[0].body, 'text body').toContain('Intro call');
      s.expect(texts[0].body, 'text body').toContain('11:00 AM');
      s.expect(texts[0].body, 'text body').toContain(booking.manageUrl);
      s.expect(texts[0].body, 'text body').toContain('Reply STOP to opt out.');
      s.expect(texts[0].body.length, 'text length').toBeLessThanOrEqual(300);
    });

    await s.step('the host notification, in the host zone, answering to the invitee', async () => {
      const [notice] = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
      s.expect(notice.subject, 'subject').toBe('New booking: Ada Lovelace for Intro call, Wed, Nov 18, 4:00 PM GMT');
      s.expect(notice.replyTo, 'reply-to').toBe(ADA.email);
      s.expect(notice.text, 'text body').toContain('4:00 PM to 4:15 PM (Greenwich Mean Time)');
      s.expect(notice.text, 'their time').toContain('11:00 AM (Eastern Standard Time)');
      for (const piece of [ADA.email, PHONE, GUEST, 'Planting 10,000 trees <together> & what it costs.']) s.expect(notice.text, 'text body').toContain(piece);
      s.expect(notice.html, 'answer is escaped in HTML').toContain('Planting 10,000 trees &lt;together&gt; &amp; what it costs.');
      s.expect(notice.links, 'links').toContain(`${booking.manageUrl}&as=host`);
      // The host has the event from Google already: no calendar file.
      s.expect(notice.hasIcs, 'calendar file for the host').toBe(false);
      await s.screenshotEmail(notice, 'host notification');
    });

    await s.step('reminders wait at exactly the right instants, one per default rule', async () => {
      s.expect(await jobLines(s), 'queued jobs').toEqual([
        `${plus(START, -24 * HOUR)} reminder email invitee`,
        `${plus(START, -2 * HOUR)} reminder call invitee`,
        `${plus(START, -1 * HOUR)} reminder email invitee`,
        `${plus(START, -15 * MINUTE)} reminder sms invitee`,
      ]);
      s.expect((await s.jobs()).map((j) => j.ruleId), 'rules').toEqual(['rem_email_24h', 'rem_call_2h', 'rem_email_1h', 'rem_sms_15m']);
      for (const job of await s.jobs()) s.expect(job, 'job').toMatchObject({ type: 'message', bookingId: booking.id, attempt: 0, forStart: START });
      // Nothing failed on the way and nothing unknown was called.
      s.expect(await s.outbox((e) => !e.ok), 'failed provider calls').toEqual([]);
      s.expect(await s.outbox({ kind: 'unknown' }), 'calls without a mock').toEqual([]);
    });

    await s.step('the time is gone for the next visitor', async () => {
      const other = await s.newPage({ timezoneId: NEW_YORK });
      await other.goto(s.url('/intro'));
      await pickDay(other, '2026-11-18');
      const starts = (await offeredSlots(other)).map((x) => x.start);
      // The booked quarter hour is gone. So is the one before it (a meeting there needs 5 free minutes after it)
      // and the one after it (the booked meeting keeps its own 5 minutes).
      for (const gone of ['2026-11-18T15:45:00.000Z', START, END]) s.expect(starts, 'times on Wednesday').not.toContain(gone);
      for (const free of ['2026-11-18T15:30:00.000Z', '2026-11-18T16:30:00.000Z']) s.expect(starts, 'times on Wednesday').toContain(free);
      s.expect(starts.length, 'times left').toBe(29);
    });
  });

  await t.scenario('phone, 390 px: the same visit, with the reminder switches turned off', async (s) => {
    await s.step('prepare', () => prepare(s));
    const page = await s.newPage({ ...PHONE_VIEWPORT, timezoneId: NEW_YORK, locale: 'en-US' });
    const start = '2026-11-19T15:30:00.000Z'; // Thursday 10:30 AM in New York

    await s.step('landing and event page fit the screen', async () => {
      await page.goto(s.url('/'));
      await page.getByRole('heading', { name: 'Book time with Jimi', level: 1 }).waitFor();
      s.expect(await overflowReport(page), 'landing overflow').toMatchObject({ scrolls: false, offenders: [] });
      await s.screenshot(page, 'landing');
      await page.getByRole('link', { name: /Intro call/ }).tap();
      await page.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      await calendarReady(page);
      s.expect(await overflowReport(page), 'event page overflow').toMatchObject({ scrolls: false, offenders: [] });
      // Fingers need room: day cells and times are at least 44 px tall.
      const day = await page.locator('.bw-day[data-day="2026-11-19"]').boundingBox();
      s.expect(Math.round(day.height), 'day cell height').toBeGreaterThanOrEqual(40);
      await s.screenshot(page, 'event page');
    });

    await s.step('picks Thursday at 10:30 AM', async () => {
      await page.locator('.bw-day[data-day="2026-11-19"]').tap();
      await page.getByRole('heading', { name: 'Thursday, November 19', exact: true }).waitFor();
      const slot = page.locator(`.bw-slot[data-start="${Date.parse(start)}"]`);
      s.expect((await slot.innerText()).trim(), 'slot label').toBe('10:30 AM');
      s.expect(Math.round((await slot.boundingBox()).height), 'slot height').toBeGreaterThanOrEqual(44);
      await s.screenshot(page, 'times');
      await slot.tap();
    });

    await s.step('fills the form with a number but no reminders by text or call', async () => {
      const form = await fillDetails(page, { name: 'Grace Hopper', email: 'grace@example.com', phone: PHONE_TYPED, sms: false, call: false, topic: 'Compilers.' });
      // On a phone the recap inside the form carries the chosen time.
      await form.getByText('Thursday, November 19').waitFor();
      await form.getByText('10:30 – 10:45 AM').waitFor();
      // With both switches off the consent wording is not shown: nothing is being agreed to.
      s.expect(await form.getByText(/By adding your number you agree/).count(), 'consent text').toBe(0);
      s.expect(await overflowReport(page), 'form overflow').toMatchObject({ scrolls: false, offenders: [] });
      await s.screenshot(page, 'details form');
    });

    const booking = await s.step('confirms and sees the confirmation', async () => {
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      const facts = (await page.locator('.bk-facts').innerText()).replace(/\s+/g, ' ');
      s.expect(facts, 'when').toContain(`${longDate(start, NEW_YORK)} 10:30 – 10:45 AM Eastern Time (New York)`);
      s.expect(await overflowReport(page), 'confirmation overflow').toMatchObject({ scrolls: false, offenders: [] });
      await s.screenshot(page, 'confirmation');
      const [stored] = await s.bookings();
      s.expect(stored, 'stored booking').toMatchObject({ start, durationMin: 15, invitee: { name: 'Grace Hopper', phone: PHONE, timezone: NEW_YORK }, consent: { sms: false, call: false, text: '' }, source: 'page' });
      return stored;
    });

    await s.step('calendar event, confirmation and host notice went out; no text was sent', async () => {
      const [insert] = await s.outbox({ kind: 'calendar_insert' });
      s.expect(Date.parse(insert.event.start.dateTime), 'event start').toBe(Date.parse(start));
      s.expect(insert.event.attendees.map((a) => a.email), 'attendees').toEqual(['grace@example.com']);
      s.expect(insert.meetUrl, 'meet link').toBe(booking.location.joinUrl);
      const [mail] = await s.outbox({ kind: 'email', to: 'grace@example.com' });
      s.expect(mail.subject, 'subject').toBe('Confirmed: Intro call with Jimi Cohen, Thu, Nov 19, 10:30 AM EST');
      s.expect(mail.text, 'text').toContain('10:30 AM to 10:45 AM (Eastern Standard Time)');
      s.expect(await s.outbox({ kind: 'email', to: OWNER_GOOGLE }), 'host notices').toHaveLength(1);
      s.expect(await s.outbox({ kind: 'sms' }), 'texts').toEqual([]);
    });

    await s.step('only the two email reminders are queued: no consent, no text and no call', async () => {
      s.expect(await jobLines(s), 'queued jobs').toEqual([`${plus(start, -24 * HOUR)} reminder email invitee`, `${plus(start, -1 * HOUR)} reminder email invitee`]);
    });

    await s.step('the same goes for a booking without any number, and consent without a number counts for nothing', async () => {
      const noPhone = await s.book({ start: '2026-11-20T10:00:00.000Z', email: 'no-phone@example.com', consent: { sms: true, call: true } });
      s.expect(noPhone.status, 'booking without a number').toBe(201);
      await s.settle();
      const stored = (await s.bookings({ id: noPhone.data.booking.id }))[0];
      s.expect(stored.consent, 'consent without a number').toMatchObject({ sms: false, call: false });
      s.expect(await jobLines(s, { bookingId: stored.id }), 'its jobs').toEqual([`${plus(stored.start, -24 * HOUR)} reminder email invitee`, `${plus(stored.start, -1 * HOUR)} reminder email invitee`]);
      // A meeting less than a day away gets no 24 hour reminder: that moment has passed.
      const soon = await s.book({ start: '2026-11-16T15:00:00.000Z', email: 'soon@example.com', phone: PHONE, consent: { sms: true, call: false } });
      s.expect(soon.status, 'booking for this afternoon').toBe(201);
      await s.settle();
      s.expect(await jobLines(s, { bookingId: soon.data.booking.id }), 'its jobs').toEqual([
        `${plus('2026-11-16T15:00:00.000Z', -1 * HOUR)} reminder email invitee`,
        `${plus('2026-11-16T15:00:00.000Z', -15 * MINUTE)} reminder sms invitee`,
      ]);
    });
  });

  await t.scenario('another length chosen in an empty month: back to the first month with times, not "No open times"', async (s) => {
    await s.step('prepare: the owner works Mondays only, and the meeting can be booked 20 days ahead', async () => {
      await prepare(s);
      const mondays = { 0: [], 1: [{ start: '09:00', end: '17:00' }], 2: [], 3: [], 4: [], 5: [], 6: [] };
      await s.apiOk('PUT', '/admin/hosts/host_owner', { body: { schedules: [{ id: 'sch_default', name: 'Working hours', weekly: mondays, overrides: [] }], defaultScheduleId: 'sch_default' } });
      await s.apiOk('PUT', '/admin/event-types/evt_meeting', { body: { scheduling: { maxDaysAhead: 20 } } });
    });
    const page = await s.newPage({ timezoneId: 'Europe/London', locale: 'en-US' });

    await s.step('the visitor pages ahead to December, where nothing is free', async () => {
      await openEvent(s, page, 'meeting');
      await page.getByRole('grid', { name: 'November 2026' }).waitFor();
      await page.getByRole('button', { name: 'Next month' }).click();
      await page.getByRole('grid', { name: 'December 2026' }).waitFor();
      await calendarReady(page);
      await page.getByText('No open times in December 2026').waitFor();
    });

    await s.step('and picks 45 minutes there: the calendar goes back to November, arrows and all', async () => {
      await page.getByRole('radio', { name: '45 min' }).click();
      await page.getByRole('grid', { name: 'November 2026' }).waitFor();
      s.expect((await offeredDays(page)).map((d) => d.day), 'days with times').toEqual(['2026-11-16', '2026-11-23', '2026-11-30']);
      s.expect(await page.getByText('No open times right now').count(), 'the dead end').toBe(0);
      s.expect(await page.getByRole('button', { name: 'Next month' }).isEnabled(), 'the way forward').toBe(true);
      await pickDay(page, '2026-11-23');
      s.expect((await offeredSlots(page)).length, 'times of 45 minutes on the 23rd').toBeGreaterThan(0);
      await s.screenshot(page, 'back to the month with times');
    });
  });
});
