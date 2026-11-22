/**
 * Both calendars, one copy each. A booking with Google connected goes into the host's Google Calendar and
 * Google invites the booker; the pages and the email say so, with the one tap Google may ask for, and offer
 * nothing that would make a second copy. A booking made before Google was connected reaches the host's
 * calendar as soon as Google is, without a second invitation to a booker our own email already invited.
 * The owner's Home and Integrations say in red that nothing reaches any calendar until Google is connected.
 * Every page whose wording changed is captured at 390 and 1280 px.
 */
import { defineSuite } from './lib.mjs';
import { OWNER_GOOGLE, PHONE_VIEWPORT, bookInBrowser, overflowReport, prepare } from './public-helpers.mjs';

const NEW_YORK = 'America/New_York';
const WIDE = { viewport: { width: 1280, height: 900 } };
const HINT = 'Don\'t see it in your calendar? If the invitation says it is from an unknown sender, tap "I know the sender", then Yes.';

export default defineSuite('calendar-copies', { mockCreds: true }, async (t) => {
  await t.scenario('Google connected: the meeting goes into both calendars, and nothing offers a second copy', async (s) => {
    await s.step('prepare: owner set up, Google connected', async () => {
      await prepare(s);
    });
    let booking;
    for (const [label, options] of [
      ['390', PHONE_VIEWPORT],
      ['1280', WIDE],
    ]) {
      const email = `ada.${label}@gmail.example`;
      const start = label === '390' ? '2026-11-18T15:00:00.000Z' : '2026-11-18T16:00:00.000Z';
      const page = await s.newPage({ ...options, timezoneId: NEW_YORK, locale: 'en-US' });
      await s.step(`${label}: the confirmation says Google is adding it, with the one tap, and only the calendar file as a backup`, async () => {
        booking = await bookInBrowser(s, page, { start, zone: NEW_YORK, details: { name: 'Ada Lovelace', email } });
        const done = page.locator('.bw-done');
        await done.getByText(`This meeting is being added to your calendar with a Google Calendar invitation sent to ${email}. Your confirmation email is on its way there too.`).waitFor();
        await done.getByText(HINT).waitFor();
        await done.getByText('Not using Google Calendar?').waitFor();
        await done.getByRole('link', { name: 'Download the calendar file' }).waitFor();
        s.expect(await done.locator('a[href*="calendar.google.com"], a[href*="outlook."]').count(), 'template links').toBe(0);
        s.expect(await page.locator('body').innerText(), 'no em dash').not.toContain('—');
        s.expect(await overflowReport(page), 'overflow').toMatchObject({ scrolls: false, offenders: [] });
        await s.screenshot(page, `${label} confirmation, Google invites her`);
      });
      await s.step(`${label}: Google was asked to put it in the owner's calendar and to invite her; our email adds no copy`, async () => {
        const inserts = (await s.outbox({ kind: 'calendar_insert' })).filter((c) => c.eventId === booking.google.eventId);
        s.expect(inserts, 'one insert').toHaveLength(1);
        s.expect(inserts[0], 'the insert').toMatchObject({ status: 200, account: OWNER_GOOGLE, sendUpdates: 'all', notified: [email] });
        s.expect(booking.inviteVia, 'recorded').toBe('google');
        const [mail] = await s.outbox({ kind: 'email', to: email });
        s.expect(mail.hasIcs, 'no calendar file attached').toBe(false);
        s.expect(mail.text, 'says Google is adding it').toContain(`This meeting is being added to your calendar with a Google Calendar invitation from Jimi Cohen, sent to ${email}.`);
        s.expect(mail.text, 'the one tap').toContain(HINT);
        s.expect(mail.links.some((l) => l.includes('calendar.google.com/calendar/render') || l.includes('outlook.')), 'template links').toBe(false);
        // The owner has the event from Google itself: no file in the notice either.
        const notices = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
        s.expect(notices.length, 'host notices').toBeGreaterThan(0);
        for (const notice of notices) s.expect(notice.hasIcs, 'host file').toBe(false);
        await s.screenshotEmail(mail, `${label} confirmation email, Google invites her`);
      });
      await s.step(`${label}: the booking page later says where the invitation went, with the same tap`, async () => {
        await page.goto(booking.manageUrl);
        await page.getByText(`Google Calendar sent the invitation for this meeting to ${email}. ${HINT}`).waitFor();
        await page.getByRole('link', { name: 'Download the calendar file' }).waitFor();
        s.expect(await page.locator('a[href*="calendar.google.com"], a[href*="outlook."]').count(), 'template links').toBe(0);
        s.expect(await overflowReport(page), 'overflow').toMatchObject({ scrolls: false, offenders: [] });
        await s.screenshot(page, `${label} booking page, Google invites her`);
      });
    }
  });

  await t.scenario('Google connected: a co-host without a calendar is still invited, and Team says so', async (s) => {
    await s.step('prepare: owner connected, Ian added without a calendar', async () => {
      await prepare(s);
      await s.apiOk('POST', '/admin/hosts', { body: { name: 'Ian Moss', email: 'ian@outlook.test' } });
    });
    for (const [label, options] of [
      ['390', PHONE_VIEWPORT],
      ['1280', WIDE],
    ]) {
      await s.step(`${label}: the Team row says where his invitations go`, async () => {
        const page = await s.newPage({ ...options, signedIn: true, timezoneId: 'Europe/London' });
        await page.goto(s.url('/admin/team'));
        await page.getByText('Joint meetings still reach Ian by a Google Calendar invitation to ian@outlook.test.', { exact: false }).waitFor();
        s.expect(await overflowReport(page), 'overflow').toMatchObject({ scrolls: false, offenders: [] });
        await s.screenshot(page, `${label} team, co-host without a calendar`);
      });
    }
  });

  await t.scenario('booked before Google was connected: the owner is told in red, and once connected the host gets it, the booker keeps one copy', async (s) => {
    let owner;
    await s.step('prepare: owner set up, email works, Google not connected', async () => {
      owner = await prepare(s, { connect: false });
      // Where the owner's booking notices go (with Google connected it is the Google address).
      await s.apiOk('PUT', '/admin/hosts/host_owner', { body: { email: OWNER_GOOGLE } });
    });
    for (const [label, options] of [
      ['390', PHONE_VIEWPORT],
      ['1280', WIDE],
    ]) {
      await s.step(`${label}: Home says first, in red, that bookings reach nobody's calendar, one click from the setup`, async () => {
        const page = await s.newPage({ ...options, signedIn: true, timezoneId: 'Europe/London' });
        await page.goto(s.url('/admin'));
        const notice = page.getByRole('alert').filter({ hasText: "Bookings are not reaching anyone's calendar" });
        await notice.getByText('the people who book get no calendar invitation', { exact: false }).waitFor();
        s.expect(await notice.getByRole('link', { name: 'Connect Google Calendar' }).getAttribute('href'), 'the way to fix it').toBe('/meeting/admin/integrations#google');
        s.expect(await page.locator('.adm-home__warnings .adm-notice').first().getAttribute('class'), 'first and in red').toContain('adm-notice--danger');
        // Nothing else on Home promises a calendar it cannot reach.
        await page.getByText('When someone picks a time it shows up here. Connect Google Calendar to have it go into your calendar too.').waitFor();
        await page.getByText('Send one of these and people can book a time. Connect Google Calendar to have bookings go into your calendar.').waitFor();
        s.expect(await overflowReport(page), 'overflow').toMatchObject({ scrolls: false, offenders: [] });
        await s.screenshot(page, `${label} home without Google`);
        await page.goto(s.url('/admin/integrations'));
        await page.getByRole('alert').filter({ hasText: "Bookings are not reaching anyone's calendar" }).waitFor();
        await page.getByText('it is your own app, made in your own Google Cloud project', { exact: false }).waitFor();
        s.expect(await overflowReport(page), 'overflow').toMatchObject({ scrolls: false, offenders: [] });
        await s.screenshot(page, `${label} integrations without Google`);
        if (label === '1280') {
          // The event editor and the Share panel say the same, instead of promising the calendar.
          await page.goto(s.url('/admin/event-types/evt_intro'));
          await page.getByRole('tab', { name: /^Advanced/ }).click();
          await page.getByText('Your Google Calendar is not connected yet, so bookings are not added to it and the people who book get no calendar invitation.').waitFor();
          await page.getByText('A change applies to new bookings.', { exact: false }).waitFor();
          await page.getByRole('tab', { name: /^Hosts/ }).click();
          await page.getByText('Until Jimi connects Google Calendar, the meeting goes on no calendar.', { exact: false }).waitFor();
          await s.screenshot(page, '1280 event editor without Google');
          await page.goto(s.url('/admin/event-types'));
          await page.getByRole('button', { name: 'More actions for Intro call' }).click();
          await page.getByRole('menuitem', { name: 'Share and embed' }).click();
          await page.getByRole('dialog', { name: 'Share Intro call' }).getByText('People pick a time. Connect Google Calendar to have it land on your calendar.', { exact: false }).waitFor();
        }
      });
    }

    let booking;
    await s.step('390: she books; our email carries the invitation, and the page says so', async () => {
      const page = await s.newPage({ ...PHONE_VIEWPORT, timezoneId: NEW_YORK, locale: 'en-US' });
      booking = await bookInBrowser(s, page, { start: '2026-11-18T16:00:00.000Z', zone: NEW_YORK, details: { name: 'Eve Early', email: 'early@example.com' } });
      const done = page.locator('.bw-done');
      await done.getByText('A confirmation email with a calendar invitation is on its way to early@example.com. Open the invitation to add the meeting to your calendar.').waitFor();
      s.expect(await done.getByText(HINT).count(), 'no Google hint').toBe(0);
      await done.getByText('Or add it yourself').waitFor();
      s.expect(await overflowReport(page), 'overflow').toMatchObject({ scrolls: false, offenders: [] });
      await s.screenshot(page, '390 confirmation, our own invitation');
      const [mail] = await s.outbox({ kind: 'email', to: 'early@example.com' });
      s.expect(mail.ics, 'our invitation').toMatchObject({ method: 'REQUEST' });
      s.expect(mail.ics.content, 'our UID').toContain(`UID:${booking.id}@localhost`);
      const [notice] = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
      s.expect(notice.hasIcs, 'no file for the host: Google puts it in once connected').toBe(false);
      s.expect(notice.text, 'and the host email says how').toContain('This meeting is not in your Google Calendar, because Google Calendar is not connected.');
      s.expect((await s.bookings({ id: booking.id }))[0].inviteVia, 'recorded').toBe('file');
    });

    await s.step('Google is connected: the earlier meeting goes into the owner\'s calendar, without a second invitation to her', async () => {
      const { result } = await s.connectGoogle(owner, OWNER_GOOGLE, 'Europe/London', { start: { hostId: 'host_owner' } });
      s.expect(result.status, 'connected').toBe('connected');
      await s.runJobs();
      const inserts = await s.outbox({ kind: 'calendar_insert' });
      s.expect(inserts, 'one insert').toHaveLength(1);
      s.expect(inserts[0], 'the insert').toMatchObject({ status: 200, account: OWNER_GOOGLE, sendUpdates: 'all', notified: [] });
      s.expect((inserts[0].event.attendees ?? []).map((a) => a.email), 'attendees').not.toContain('early@example.com');
      const stored = (await s.bookings({ id: booking.id }))[0];
      s.expect(stored.google.eventId, 'event written').toBe(inserts[0].eventId);
      s.expect(stored.inviteVia, 'still ours').toBe('file');
    });

    await s.step('she moves it: Google moves the host copy, our email moves hers, under the same UID', async () => {
      await s.clearOutbox();
      const moved = await s.visitor().request('POST', `/public/bookings/${booking.id}/reschedule`, { body: { t: booking.manageToken, start: '2026-11-18T14:00:00.000Z' } });
      s.expect(moved.status, 'moved').toBe(200);
      s.expect(moved.data.booking.delivery, 'what the page promises').toEqual({ email: true, calendarInvite: false });
      await s.settle();
      s.expect(await s.outbox({ kind: 'calendar_insert' }), 'no second event').toEqual([]);
      const [patch] = await s.outbox({ kind: 'calendar_patch' });
      s.expect(patch, 'the patch').toMatchObject({ status: 200, sendUpdates: 'all', notified: [] });
      const [mail] = await s.outbox({ kind: 'email', to: 'early@example.com' });
      s.expect(mail.ics, 'our update').toMatchObject({ method: 'REQUEST' });
      for (const line of [`UID:${booking.id}@localhost`, 'SEQUENCE:1', 'DTSTART:20261118T140000Z']) s.expect(mail.ics.content, 'the update').toContain(line);
    });
  });

  await t.scenario('the live state (no email, no Google): she adds it by hand, and Google\'s later invitation says that copy can go', async (s) => {
    let owner;
    let booking;
    await s.step('prepare: owner set up, email switched off, Google not connected', async () => {
      owner = await prepare(s, { connect: false });
      await s.apiOk('PUT', '/admin/hosts/host_owner', { body: { email: OWNER_GOOGLE } });
      await s.apiOk('PUT', '/admin/site', { body: { email: { provider: 'none' } } });
    });
    await s.step('390: the page says the buttons are the way, and nothing is decided for her yet', async () => {
      const page = await s.newPage({ ...PHONE_VIEWPORT, timezoneId: NEW_YORK, locale: 'en-US' });
      booking = await bookInBrowser(s, page, { start: '2026-11-18T16:00:00.000Z', zone: NEW_YORK, details: { name: 'Hana Hand', email: 'hand@gmail.example' } });
      const done = page.locator('.bw-done');
      await done.getByText('No confirmation email is sent for this booking, so please add it to your calendar with the buttons below.').waitFor();
      await done.getByText('Add to your calendar', { exact: true }).waitFor();
      s.expect(await done.getByText(HINT).count(), 'no Google hint').toBe(0);
      s.expect(await s.outbox({ kind: 'email' }), 'emails').toEqual([]);
      // No email could carry an invitation: Google may still invite her once it is connected.
      s.expect((await s.bookings({ id: booking.id }))[0].inviteVia, 'not decided').toBe(undefined);
    });
    await s.step('Google is connected: Google invites her, and its invitation says the copy she made by hand can go', async () => {
      const { result } = await s.connectGoogle(owner, OWNER_GOOGLE, 'Europe/London', { start: { hostId: 'host_owner' } });
      s.expect(result.status, 'connected').toBe('connected');
      await s.runJobs();
      await s.settle();
      const inserts = await s.outbox({ kind: 'calendar_insert' });
      s.expect(inserts, 'one insert').toHaveLength(1);
      s.expect(inserts[0], 'the insert').toMatchObject({ status: 200, account: OWNER_GOOGLE, sendUpdates: 'all', notified: ['hand@gmail.example'] });
      const [event] = (await s.googleEvents(OWNER_GOOGLE)).filter((e) => e.event.id === inserts[0].eventId);
      s.expect(event.event.description, 'the invitation').toContain('If you added this meeting to your calendar yourself from the booking page, you can delete that copy now. This invitation keeps itself up to date.');
      const stored = (await s.bookings({ id: booking.id }))[0];
      s.expect(stored.inviteVia, 'Google invites her').toBe('google');
      s.expect(stored.location.joinUrl, 'and she has a Meet link now').toMatch(/^https:\/\/meet\.google\.com\//);
    });
  });

  await t.scenario('Testing mode: the Google card says when the connection ends, opened, at 390 and 1280', async (s) => {
    await s.step('prepare: connected while the consent screen is in Testing', async () => {
      await s.reset();
      await s.setClock('2026-11-16T09:00:00.000Z');
      await s.setupAdmin({ timezone: 'Europe/London' });
      const page = await s.newPage({ signedIn: true, timezoneId: 'Europe/London' });
      const { result } = await s.connectGoogle(page, OWNER_GOOGLE, 'Europe/London', { flags: ['testing'], start: { hostId: 'host_owner' } });
      s.expect(result.status, 'connected').toBe('connected');
    });
    for (const [label, options] of [
      ['390', PHONE_VIEWPORT],
      ['1280', WIDE],
    ]) {
      await s.step(`${label}: the badge names the end date and the card starts open`, async () => {
        const page = await s.newPage({ ...options, signedIn: true, timezoneId: 'Europe/London' });
        await page.goto(s.url('/admin/integrations'));
        const card = page.getByRole('region', { name: 'Google Calendar', exact: true });
        s.expect((await card.locator('.ix-card__status').textContent()).trim(), 'badge').toBe('Ends 23 Nov');
        s.expect(await card.getByRole('button', { name: 'Google Calendar', exact: true }).getAttribute('aria-expanded'), 'open').toBe('true');
        await card.getByText(/This connection ends on/).waitFor();
        s.expect(await overflowReport(page), 'overflow').toMatchObject({ scrolls: false, offenders: [] });
        await s.screenshot(page, `${label} integrations in Testing`);
      });
    }
    await s.step('day 8: Google ended it; Integrations says why and that publishing is what keeps it', async () => {
      await s.advanceClock({ days: 8 });
      await s.setGoogleAccount(OWNER_GOOGLE, { revoked: true });
      await s.runJobs();
      const { main } = await s.googleAccountsOf('host_owner');
      s.expect(main.status, 'the account').toBe('needs_reconnect');
      const page = await s.newPage({ ...WIDE, signedIn: true, timezoneId: 'Europe/London' });
      await page.goto(s.url('/admin/integrations'));
      const notice = page.getByRole('note').filter({ hasText: 'Your Google Calendar needs to be reconnected' });
      await notice.getByText('Google ended it on Monday, November 23, 2026, as it said it would when you connected.', { exact: false }).waitFor();
      await notice.getByText('Reconnecting without publishing only lasts another 7 days.', { exact: false }).waitFor();
      const { warnings } = await s.apiOk('GET', '/admin/overview');
      s.expect(warnings.find((w) => w.key === 'google_reconnect_host_owner')?.message, 'Home').toContain('That usually means your Google Cloud app is still in Testing');
      await s.screenshot(page, '1280 integrations after Testing ended');
    });
  });
});
