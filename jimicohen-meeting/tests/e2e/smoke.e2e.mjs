/**
 * Smoke: the whole chain once, in a real browser against the real backend.
 * First-run setup, the owner connects Google Calendar through the (played) consent screen,
 * a visitor books the starter "Intro call", and the outbox shows the calendar event with a
 * Meet link, the confirmation to the invitee and the notice to the host.
 */
import { DEFAULT_PASSWORD, SETUP_CODE, defineSuite } from './lib.mjs';

/** Monday 09:00 in London. The owner's starter hours are Monday to Friday, 09:00 to 17:00. */
const MONDAY_9AM_LONDON = '2026-11-16T09:00:00.000Z';
const OWNER_GOOGLE = 'jimi@example.com';
const INVITEE = { name: 'Ada Lovelace', email: 'ada@example.com' };
/** Wednesday 9:00 AM in New York, which is 2 PM in London. */
const BOOKED_START = '2026-11-18T14:00:00.000Z';

export default defineSuite('smoke', { mockCreds: true }, async (t) => {
  await t.scenario('first run, Google Calendar, and a booking made in the browser', async (s) => {
    await s.setClock(MONDAY_9AM_LONDON);
    const owner = await s.newPage({ timezoneId: 'Europe/London', locale: 'en-GB' });

    await s.step('first-run setup in the browser', async () => {
      s.expect((await s.api('GET', '/auth/state')).data, 'auth state before setup').toEqual({ setupRequired: true, authenticated: false });
      await owner.goto(s.url('/admin'));
      await owner.getByRole('heading', { name: 'Set up your dashboard' }).waitFor();
      await owner.getByLabel('Setup code').fill(SETUP_CODE);
      await owner.getByLabel('New password').fill(DEFAULT_PASSWORD);
      await owner.getByLabel('Repeat password').fill(DEFAULT_PASSWORD);
      await owner.getByRole('button', { name: 'Create my dashboard' }).click();
      await owner.getByRole('heading', { name: /Good morning, Jimi/ }).waitFor();
      s.expect((await s.api('GET', '/auth/state')).data, 'auth state after setup').toEqual({ setupRequired: false, authenticated: false });
      // The owner's zone came from the device that ran the setup.
      const [host] = await s.kv('hosts');
      s.expect(host, 'owner host').toMatchObject({ id: 'host_owner', timezone: 'Europe/London', timezoneMode: 'device' });
      await s.screenshot(owner, 'dashboard after setup');
    });

    await s.step('the owner connects Google Calendar', async () => {
      await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Integrations' }).click();
      await owner.getByRole('heading', { name: 'Integrations', level: 1 }).waitFor();
      const google = await s.connectGoogle(owner, OWNER_GOOGLE, 'Europe/London');
      await owner.getByRole('button', { name: 'Connect Google Calendar' }).click();
      const result = await google.done();
      s.expect(result.status, `google connect result (${result.reason ?? 'no reason'})`).toBe('connected');
      s.expect(result.request, 'authorization request').toMatchObject({ clientId: /\.apps\.googleusercontent\.com$/, gmailRequested: false });
      await owner.getByText(`Connected as ${OWNER_GOOGLE}`).waitFor();
      await owner.getByRole('checkbox', { name: new RegExp(`^${OWNER_GOOGLE.replace('.', '\\.')}`) }).waitFor();

      // The real code ran: token exchange, then the defaults for a first connection.
      const [host] = await s.kv('hosts');
      s.expect(host, 'owner host after connecting').toMatchObject({
        timezone: 'Europe/London',
        timezoneMode: 'google',
        google: { email: OWNER_GOOGLE, status: 'ok', busyCalendarIds: ['primary'], writeCalendarId: 'primary', gmailSend: false },
      });
      s.expect(await s.outbox({ kind: 'token' }), 'token exchanges').toMatchObject([{ service: 'google', status: 200, grant: 'authorization_code', account: OWNER_GOOGLE }]);
      s.expect((await s.outbox({ kind: 'timezone' })).length, 'calendar time zone lookups').toBeGreaterThan(0);
      await s.screenshot(owner, 'google connected');
    });

    const visitor = await s.newPage({ timezoneId: 'America/New_York', locale: 'en-US' });

    await s.step('a visitor opens the booking page and picks the intro call', async () => {
      await visitor.goto(s.url('/'));
      await visitor.getByRole('heading', { name: 'Book time with Jimi' }).waitFor();
      await visitor.getByRole('link', { name: /Intro call/ }).click();
      await visitor.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      await visitor.getByRole('grid', { name: 'November 2026' }).waitFor();
      // Times are shown in the visitor's own zone.
      await visitor.getByText('Eastern Time (New York)').waitFor();
    });

    await s.step('picks Wednesday at 9:00 AM and fills in the details', async () => {
      await visitor.getByRole('button', { name: /^Wednesday, November 18, \d+ times available$/ }).click();
      await visitor.getByRole('heading', { name: 'Wednesday, November 18' }).waitFor();
      await visitor.getByRole('button', { name: '9:00 AM', exact: true }).click();
      const form = visitor.getByRole('form', { name: 'Your details' });
      await form.waitFor();
      // The summary beside the form repeats the choice, in the visitor's zone.
      await visitor.getByRole('list').getByText('9:00 – 9:15 AM').waitFor();
      // By role, not by label: the country picker next to the phone field lists "Namibia", which a loose label match for "Name" finds too.
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill(INVITEE.name);
      await form.getByRole('textbox', { name: 'Email', exact: true }).fill(INVITEE.email);
      await form.getByRole('textbox', { name: 'What would you like to talk about?' }).fill('Planting trees together.');
      await s.screenshot(visitor, 'details form');
    });

    await s.step('confirms, and sees the confirmation', async () => {
      // A person takes a moment over a form. One that is sent the instant it opens is refused as a bot's.
      await s.linger(visitor);
      await visitor.getByRole('button', { name: 'Confirm booking' }).click();
      await visitor.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      await s.screenshot(visitor, 'confirmation');
    });

    await s.step('the booking is stored, in the right place in time', async () => {
      const bookings = await s.bookings();
      s.expect(bookings, 'bookings').toHaveLength(1);
      s.expect(bookings[0], 'the booking').toMatchObject({
        status: 'confirmed',
        eventSlug: 'intro',
        start: BOOKED_START,
        durationMin: 15,
        hostIds: ['host_owner'],
        invitee: { name: INVITEE.name, email: INVITEE.email, timezone: 'America/New_York' },
        google: { hostId: 'host_owner', meetUrl: /^https:\/\/meet\.google\.com\// },
        location: { type: 'google_meet', joinUrl: /^https:\/\/meet\.google\.com\// },
      });
    });

    await s.step('the calendar event was written with a Meet link', async () => {
      const [booking] = await s.bookings();
      const inserts = await s.outbox({ kind: 'calendar_insert' });
      s.expect(inserts, 'calendar inserts').toHaveLength(1);
      s.expect(inserts[0], 'calendar insert').toMatchObject({
        service: 'google',
        status: 200,
        account: OWNER_GOOGLE,
        conferenceRequested: true,
        sendUpdates: 'all',
        meetUrl: booking.google.meetUrl,
        eventId: booking.google.eventId,
        notified: [INVITEE.email],
        event: {
          start: { dateTime: BOOKED_START },
          end: { dateTime: '2026-11-18T14:15:00.000Z' },
          hangoutLink: booking.google.meetUrl,
          extendedProperties: { private: { meetingBookingId: booking.id } },
        },
      });
      s.expect(inserts[0].event.summary, 'event title').toContain('Intro call');
      s.expect(inserts[0].event.attendees.map((a) => a.email), 'event attendees').toEqual([INVITEE.email]);
      // The event is on the mock calendar, so the time is now busy for Google as well.
      const events = await s.googleEvents(OWNER_GOOGLE);
      s.expect(events, 'events on the mock calendar').toMatchObject([{ account: OWNER_GOOGLE, event: { id: booking.google.eventId, status: 'confirmed' } }]);
    });

    await s.step('the invitee got a confirmation and the host a notice', async () => {
      const [booking] = await s.bookings();
      const emails = await s.outbox({ kind: 'email' });
      s.expect(emails.map((e) => e.to.join(',')).sort(), 'email recipients').toEqual([INVITEE.email, OWNER_GOOGLE].sort());

      const [confirmation] = await s.outbox({ kind: 'email', to: INVITEE.email });
      s.expect(confirmation.subject, 'confirmation subject').toContain('Intro call');
      s.expect(confirmation.text, 'confirmation text').toContain(booking.google.meetUrl);
      // Shown in the invitee's zone: 9:00 AM in New York.
      s.expect(confirmation.text, 'confirmation text').toContain('9:00 AM to 9:15 AM (Eastern Standard Time)');
      const manage = (action) => `${s.url(`/booking/${booking.id}/${action}`)}?t=${booking.manageToken}`;
      for (const link of [booking.google.meetUrl, manage('reschedule'), manage('cancel')]) s.expect(confirmation.links, 'links in the confirmation').toContain(link);
      // Google invites her (the event above has her on it): the email says so and adds no second copy of its own.
      s.expect(confirmation.hasIcs, 'no calendar file beside Google\'s invitation').toBe(false);
      s.expect(confirmation.text, 'says Google is adding it').toContain(`This meeting is being added to your calendar with a Google Calendar invitation from Jimi Cohen, sent to ${INVITEE.email}.`);
      s.expect(confirmation.links, 'the backup calendar file').toContain(`${s.url(`/api/public/bookings/${booking.id}/ics`)}?t=${booking.manageToken}`);
      await s.screenshotEmail(confirmation, 'confirmation email');

      const [notice] = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
      s.expect(notice.subject, 'host notice subject').toContain(INVITEE.name);
      // Shown in the host's zone: 2:00 PM in London. The reply goes to the invitee.
      s.expect(notice.text, 'host notice text').toContain('2:00 PM to 2:15 PM (Greenwich Mean Time)');
      // The host's copy of the manage link says a host is acting (their zone then stays off the invitee).
      s.expect(notice.links, 'links in the host notice').toContain(`${booking.manageUrl}&as=host`);
      s.expect(notice.replyTo, 'reply-to of the host notice').toBe(INVITEE.email);

      // Nothing failed on the way, and nothing unknown was called.
      s.expect(await s.outbox((e) => !e.ok), 'failed provider calls').toEqual([]);
      s.expect(await s.outbox({ kind: 'unknown' }), 'calls without a mock').toEqual([]);
    });

    await s.step('reminders are queued, and the dashboard shows the meeting', async () => {
      const jobs = await s.jobs();
      s.expect(jobs.length, 'queued reminder jobs').toBeGreaterThan(0);
      s.expect(jobs.map((j) => j.kind), 'job kinds').toContain('reminder');
      await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Bookings' }).click();
      await owner.getByText(INVITEE.name).first().waitFor();
      await s.screenshot(owner, 'bookings in the dashboard');
    });
  });
});
