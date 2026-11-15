/**
 * Where two pieces of the app meet: several Google accounts per person (admin-google-accounts) and the short
 * links with the Eco Champions brand on /pod (public-short-links, admin-brands).
 *
 * Jimi has two Google accounts, and so does Ian, his co-host on the Eco Champions conversation behind /pod.
 * Busy time on either second account closes that time on /pod, while /meet only minds Jimi's own accounts.
 * A broken second account of Ian's is named on Home in Jimi's own words, and closes /pod but not /meet.
 * Bookings still go to Jimi's main account; a /pod booking speaks for Eco Champions and a /meet booking for
 * Jimi, also after Jimi switches his main account and the /pod booking is no longer linked to its event.
 * Every page is looked at at 1280 and at 390 px.
 */
import { defineSuite } from './lib.mjs';
import { clearToasts, expectToast } from './admin-helpers.mjs';
import { PHONE_VIEWPORT, calendarReady, offeredSlots, pickDay, prepare } from './public-helpers.mjs';

const JIMI = 'jimi@example.com'; // Jimi's main account (prepare connects it)
const JIMI_WORK = 'jimi@work.example';
const JIMI_NEW = 'jimi@new.example';
const IAN = 'ian@example.com';
const IAN_STUDIO = 'ian@studio.example';
const ECO = 'brand_eco_champions';
const POD = 'evt_eco_champions';
const ECO_GREEN = '#14432f';
const TUESDAY = '2026-11-17';
const at = (time) => `${TUESDAY}T${time}:00.000Z`;
const DESKTOP = { viewport: { width: 1280, height: 900 } };

async function cssVar(page, name) {
  return page.evaluate((n) => getComputedStyle(document.querySelector('.m-scope') ?? document.documentElement).getPropertyValue(n).trim().toLowerCase(), name);
}

export default defineSuite('joint-pod-accounts', { mockCreds: true }, async (t) => {
  const state = { ianId: '', inviteUrl: '', podSlug: '', meetSlug: '', podBookingId: '', meetBookingId: '' };

  const googleCard = (page) => page.getByRole('region', { name: 'Google Calendar', exact: true });
  const otherAccounts = (page) => googleCard(page).getByRole('region', { name: 'Other Google accounts' });
  const openGoogleCard = async (page) => {
    const toggle = googleCard(page).getByRole('button', { name: 'Google Calendar', exact: true });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  };
  const ianCard = (page) => page.getByRole('listitem').filter({ hasText: 'Ian Poirier' }).first();
  const slotsOf = (s, slug, duration) => s.slots({ slug, duration, from: at('00:00'), to: '2026-11-18T00:00:00.000Z' });
  const eventsOf = async (s, email) => (await s.googleEvents(email)).map((e) => e.event);
  const mailsTo = async (s, email) => (await s.outbox({ kind: 'email' })).filter((m) => m.to.some((to) => to.includes(email)));
  const noSideScroll = async (s, page, label) =>
    s.expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: no sideways scroll`).toBe(true);

  await t.scenario('Jimi and Ian with two Google accounts each: either one closes the time on /pod, Home names the second', { reset: true }, async (s) => {
    const owner = await prepare(s);
    await owner.setViewportSize(DESKTOP.viewport);
    await s.apiOk('PUT', '/admin/hosts/host_owner', { body: { email: JIMI } });
    await s.runOneTimeMoves();
    const types = await s.kv('event-types');
    const site = await s.kv('site');
    state.podSlug = types.find((e) => e.id === site.shortLinks.pod).slug;
    state.meetSlug = types.find((e) => e.id === site.shortLinks.meet).slug;
    s.expect(site.shortLinks.pod, '/pod opens the Eco Champions conversation').toBe(POD);
    const phone = await s.newPage({ signedIn: true, timezoneId: 'Europe/London', locale: 'en-GB', ...PHONE_VIEWPORT });

    await s.step('Integrations: Jimi adds a second Google account, at 1280 and at 390', async () => {
      await owner.goto(s.url('/admin/integrations'));
      await openGoogleCard(owner);
      await s.addGoogleAccount(owner, otherAccounts(owner), JIMI_WORK, 'Europe/London');
      await expectToast(owner, `${JIMI_WORK} is connected`);
      await clearToasts(owner);
      const { main, extras } = await s.googleAccountsOf('host_owner');
      s.expect([main.email, ...extras.map((a) => a.email)], "Jimi's accounts").toEqual([JIMI, JIMI_WORK]);
      await openGoogleCard(owner);
      await otherAccounts(owner).getByText(JIMI_WORK, { exact: true }).waitFor();
      await googleCard(owner).getByText('New meetings go here').waitFor();
      await noSideScroll(s, owner, 'Integrations at 1280');
      await s.screenshot(owner, 'integrations two accounts 1280');
      await phone.goto(s.url('/admin/integrations'));
      await openGoogleCard(phone);
      await otherAccounts(phone).getByText(JIMI_WORK, { exact: true }).waitFor();
      await noSideScroll(s, phone, 'Integrations at 390');
      await s.screenshot(phone, 'integrations two accounts 390');
    });

    await s.step('Team: Ian is added with the /pod meeting ticked, and gets his private link', async () => {
      await owner.goto(s.url('/admin/team'));
      await owner.getByRole('heading', { name: 'Team', level: 1 }).waitFor();
      await owner.getByRole('button', { name: 'Add a co-host' }).first().click();
      const dialog = owner.getByRole('dialog', { name: 'Add a co-host' });
      await dialog.getByLabel('Name').fill('Ian Poirier');
      await dialog.getByLabel('Email').fill(IAN);
      const box = dialog.getByRole('checkbox', { name: 'Add Ian to Eco Champions conversation' });
      s.expect(await box.isChecked(), 'the /pod meeting is ticked').toBe(true);
      await dialog.getByRole('button', { name: 'Add and get their link' }).click();
      const added = owner.getByRole('dialog', { name: 'Ian is on the team' });
      state.inviteUrl = await added.getByRole('textbox', { name: 'Private link for Ian Poirier' }).inputValue();
      await added.getByRole('button', { name: 'Done' }).click();
      state.ianId = (await s.kv('hosts')).find((h) => h.email === IAN).id;
      const pod = (await s.kv('event-types')).find((e) => e.id === POD);
      s.expect(pod.hostIds, 'the /pod meeting').toEqual(['host_owner', state.ianId]);
      s.expect(pod.kind, 'joint').toBe('collective');
    });

    await s.step("Ian's private page: he connects his main account and adds a second, at 1280 and at 390", async () => {
      const ian = await s.newPage({ timezoneId: 'Europe/London', ip: '10.99.0.21', ...DESKTOP });
      const calendar = ian.getByRole('region', { name: 'Your calendar' });
      await ian.goto(state.inviteUrl);
      await ian.getByRole('heading', { name: 'Hi Ian. One step to go.', level: 1 }).waitFor();
      const first = await s.connectGoogle(ian, IAN, 'Europe/London', { start: calendar.getByRole('button', { name: 'Connect Google Calendar' }) });
      s.expect(first.result.status, 'main account').toBe('connected');
      await clearToasts(ian);
      const second = await s.addGoogleAccount(ian, calendar, IAN_STUDIO, 'Europe/London');
      s.expect(new URL(second.url).pathname, 'back on his page').toBe(`/meeting/host/${state.ianId}`);
      await expectToast(ian, `${IAN_STUDIO} is connected`);
      await clearToasts(ian);
      const { main, extras } = await s.googleAccountsOf(state.ianId);
      s.expect([main.email, ...extras.map((a) => a.email)], "Ian's accounts").toEqual([IAN, IAN_STUDIO]);
      await calendar.getByText(IAN_STUDIO, { exact: true }).waitFor();
      // His private page stays in Jimi's look, like the dashboard, although he hosts the Eco Champions meeting.
      s.expect(await cssVar(ian, '--m-primary'), 'not the Eco Champions green').not.toBe(ECO_GREEN);
      await noSideScroll(s, ian, 'co-host page at 1280');
      await s.screenshot(ian, 'co-host page two accounts 1280');
      const ianPhone = await s.newPage({ timezoneId: 'Europe/London', ip: '10.99.0.21', ...PHONE_VIEWPORT });
      await ianPhone.goto(state.inviteUrl);
      await ianPhone.getByRole('region', { name: 'Your calendar' }).getByText(IAN_STUDIO, { exact: true }).waitFor();
      await noSideScroll(s, ianPhone, 'co-host page at 390');
      await s.screenshot(ianPhone, 'co-host page two accounts 390');
      // The notices about his accounts are about the dashboard: Jimi's own name and look, never Eco Champions.
      await s.runJobs();
      const notices = [...(await mailsTo(s, IAN)), ...(await mailsTo(s, JIMI))].filter((m) => /Google account/.test(m.subject));
      s.expect(notices.map((m) => m.subject).sort(), 'the notices').toEqual(['A Google account was connected to your booking page', 'A Google account was connected to your booking page', 'Ian connected another Google account', 'Ian connected another Google account']);
      for (const m of notices) s.expect(`${m.from}\n${m.html}`, `"${m.subject}"`).not.toMatch(/Eco Champions|builtin_eco_champions_email/);
    });

    await s.step('busy on either second account closes that time on /pod; /meet only minds Jimi\'s accounts', async () => {
      await s.setGoogleBusy(IAN_STUDIO, [{ start: at('10:00'), end: at('10:30') }]);
      await s.setGoogleBusy(JIMI_WORK, [{ start: at('11:00'), end: at('11:30') }]);
      const pod = await slotsOf(s, state.podSlug, 30);
      s.expect(pod.includes(at('10:00')), "/pod at 10:00 (Ian's second account)").toBe(false);
      s.expect(pod.includes(at('11:00')), "/pod at 11:00 (Jimi's second account)").toBe(false);
      s.expect(pod.includes(at('14:00')), '/pod at 14:00').toBe(true);
      const meet = await slotsOf(s, state.meetSlug, 30);
      s.expect(meet.includes(at('10:00')), '/meet at 10:00 (Ian is not on it)').toBe(true);
      s.expect(meet.includes(at('11:00')), "/meet at 11:00 (Jimi's second account)").toBe(false);
    });

    await s.step('/pod in the browser, in Eco Champions, offers neither time, at 1280 and at 390', async () => {
      for (const [label, options] of [
        ['1280', DESKTOP],
        ['390', PHONE_VIEWPORT],
      ]) {
        const visitor = await s.newPage({ timezoneId: 'Europe/London', locale: 'en-GB', ...options });
        await visitor.goto(s.shortUrl('pod'));
        await visitor.getByRole('heading', { name: 'Eco Champions conversation', level: 1 }).waitFor();
        await calendarReady(visitor);
        s.expect(await cssVar(visitor, '--m-primary'), 'Eco Champions green').toBe(ECO_GREEN);
        await visitor.getByText('Jimi Cohen and Ian Poirier', { exact: true }).waitFor();
        await pickDay(visitor, TUESDAY, 'en-GB');
        const times = (await offeredSlots(visitor)).map((x) => x.start);
        s.expect(times, `${label}: 10:00 is busy on Ian's second account`).not.toContain(at('10:00'));
        s.expect(times, `${label}: 11:00 is busy on Jimi's second account`).not.toContain(at('11:00'));
        s.expect(times, `${label}: 14:00 is free for both`).toContain(at('14:00'));
        await noSideScroll(s, visitor, `/pod at ${label}`);
        await s.screenshot(visitor, `pod times with second accounts busy ${label}`);
      }
    });

    await s.step("Team lists Ian's two accounts, at 1280 and at 390", async () => {
      for (const [label, page] of [
        ['1280', owner],
        ['390', phone],
      ]) {
        await page.goto(s.url('/admin/team'));
        const card = ianCard(page);
        await card.getByText('2 Google accounts').waitFor();
        await card.getByRole('button', { name: 'Show accounts' }).click();
        await card.getByText(IAN_STUDIO, { exact: true }).waitFor();
        await card.getByText(`Main account: ${IAN}. New meetings with Ian go there.`).waitFor();
        s.expect(await card.getByRole('button', { name: 'Add another Google account' }).count(), 'adding stays with Ian').toBe(0);
        await noSideScroll(s, page, `Team at ${label}`);
        await s.screenshot(page, `team ian two accounts ${label}`);
      }
    });

    await s.step("Ian's second account stops working: /pod closes, /meet does not, and Home names it in Jimi's words", async () => {
      await s.setGoogleAccount(IAN_STUDIO, { revoked: true });
      // The busy time read a moment ago is kept for a minute: after that the next visitor's read meets the revoke.
      await s.advanceClock({ seconds: 61 });
      const answer = await s.visitor().ok('GET', '/public/slots', { query: { slug: state.podSlug, duration: 30, from: at('00:00'), to: '2026-11-18T00:00:00.000Z' } });
      s.expect([answer.slots.length, answer.unavailableReason], '/pod').toEqual([0, 'calendar_error']);
      const meet = await slotsOf(s, state.meetSlug, 30);
      s.expect(meet.includes(at('14:00')), '/meet still offers 14:00').toBe(true);
      const overview = await s.apiOk('GET', '/admin/overview');
      const message = `Ian's Google account ${IAN_STUDIO} needs to be reconnected. Until then, times that include Ian are not offered. Ask Ian to open their private link and reconnect it.`;
      s.expect(overview.warnings.find((w) => w.key === `google_reconnect_${state.ianId}`)?.message, 'the Home warning').toBe(message);
      for (const [label, page] of [
        ['1280', owner],
        ['390', phone],
      ]) {
        await page.goto(s.url('/admin'));
        await page.locator('.adm-home__warnings').getByText(message).waitFor();
        await page.getByRole('region', { name: 'Your links' }).getByText('Eco Champions conversation. You and Ian, in the Eco Champions look.').waitFor();
        await noSideScroll(s, page, `Home at ${label}`);
        await s.screenshot(page, `home warning for ian's second account ${label}`, { fullPage: false });
      }
      const turnedAway = await s.book({ slug: state.podSlug, start: at('14:00'), durationMin: 30, name: 'Cal Ng', email: 'cal@example.com' });
      s.expect(turnedAway.status, 'a /pod booking is turned away').toBe(503);
      // The alert is about the dashboard, so it comes in Jimi's own name and look, never as Eco Champions.
      await s.runJobs();
      const alerts = (await s.outbox({ kind: 'email' })).filter((m) => String(m.subject).startsWith('A calendar needs attention'));
      s.expect(alerts.map((m) => m.subject), 'the alert').toEqual([`A calendar needs attention: Ian Poirier (${IAN_STUDIO})`]);
      s.expect(alerts[0].text, 'what it says').toContain(`Ian Poirier, ${IAN_STUDIO}: Google Calendar needs to be reconnected.`);
      s.expect(alerts[0].from, "the alert's sender").not.toMatch(/Eco Champions/);
      s.expect(alerts[0].html, "the alert's logo").not.toContain('builtin_eco_champions_email');
    });

    await s.step('a /pod visitor sees the calendar problem in the Eco Champions look', async () => {
      const visitor = await s.newPage({ timezoneId: 'Europe/London', locale: 'en-GB', ...PHONE_VIEWPORT });
      await visitor.goto(s.shortUrl('pod'));
      await visitor.getByRole('heading', { name: 'Eco Champions conversation', level: 1 }).waitFor();
      await visitor.getByRole('heading', { name: 'We cannot check the calendar right now' }).waitFor();
      s.expect(await cssVar(visitor, '--m-primary'), 'Eco Champions green').toBe(ECO_GREEN);
      await s.screenshot(visitor, 'pod while ian needs a reconnect 390');
    });

    await s.step('Ian reconnects it from his own page, and /pod offers times again', async () => {
      await s.setGoogleAccount(IAN_STUDIO, { revoked: false });
      const ian = await s.newPage({ timezoneId: 'Europe/London', ip: '10.99.0.21', ...DESKTOP });
      await ian.goto(state.inviteUrl);
      const row = ian.getByRole('region', { name: 'Your calendar' }).locator('li.ga-row').filter({ has: ian.getByText(IAN_STUDIO, { exact: true }) });
      await row.getByText('Needs reconnecting').waitFor();
      await s.screenshot(ian, 'co-host page reconnect 1280');
      const google = await s.connectGoogle(ian, IAN_STUDIO, 'Europe/London', { start: row.getByRole('button', { name: 'Reconnect' }) });
      s.expect(google.result.status, 'reconnected').toBe('connected');
      s.expect(google.result.request.loginHint, 'Google is asked for that account').toBe(IAN_STUDIO);
      const pod = await slotsOf(s, state.podSlug, 30);
      s.expect(pod.includes(at('14:00')), '/pod at 14:00').toBe(true);
      s.expect(pod.includes(at('10:00')), "/pod at 10:00 (still busy on Ian's second account)").toBe(false);
      const overview = await s.apiOk('GET', '/admin/overview');
      s.expect(overview.warnings.some((w) => w.key === `google_reconnect_${state.ianId}`), 'the warning is gone').toBe(false);
    });
  });

  await t.scenario('bookings: /pod speaks for Eco Champions and /meet for Jimi, also once the /pod booking is detached', async (s) => {
    await s.login();
    await s.clearOutbox();

    await s.step('a /pod booking: Eco Champions emails, its event in Jimi\'s main account with Ian\'s main address', async () => {
      const booked = await s.book({ slug: state.podSlug, start: at('14:00'), durationMin: 30, name: 'Ann Lee', email: 'ann@example.com' });
      s.expect(booked.status, 'booked').toBe(201);
      state.podBookingId = booked.data.booking.id;
      await s.settle();
      const booking = (await s.bookings()).find((b) => b.id === state.podBookingId);
      s.expect(booking.brandId, 'brand').toBe(ECO);
      s.expect(booking.hostIds, 'both hosts').toEqual(['host_owner', state.ianId]);
      s.expect(booking.google, 'the account that holds the event').toMatchObject({ hostId: 'host_owner', accountEmail: JIMI });
      const [event] = (await eventsOf(s, JIMI)).filter((e) => (e.summary ?? '').startsWith('Eco Champions conversation'));
      s.expect(event?.summary, 'title').toBe('Eco Champions conversation: Ann Lee, Jimi Cohen and Ian Poirier');
      s.expect((event?.description ?? '').split('\n')[0], 'first line').toBe(`Booked through Eco Champions: ${s.shortUrl('pod')}`);
      const invited = (event?.attendees ?? []).map((a) => a.email);
      s.expect(invited, "Ian's main address").toContain(IAN);
      s.expect(invited, "not Ian's second address").not.toContain(IAN_STUDIO);
      for (const other of [JIMI_WORK, IAN, IAN_STUDIO]) s.expect(await s.googleEvents(other), `nothing written to ${other}`).toEqual([]);

      const [invitee] = await mailsTo(s, 'ann@example.com');
      s.expect(invitee?.from, 'sender').toMatch(/^Eco Champions </);
      s.expect(invitee?.subject, 'subject').toMatch(/^Confirmed: Eco Champions conversation with Jimi and Ian/);
      s.expect(invitee?.html, 'footer').toContain('You are getting this email because a meeting was booked with Eco Champions using this address.');
      await s.screenshotEmail(invitee, 'pod confirmation to the invitee');
      for (const host of [JIMI, IAN]) {
        const [mail] = (await mailsTo(s, host)).filter((m) => /^New booking/.test(m.subject));
        s.expect(mail?.from, `notice to ${host}`).toMatch(/^Eco Champions </);
        s.expect(mail?.html, `footer to ${host}`).toContain('Sent by the Eco Champions booking page.');
      }
      await s.screenshotEmail((await mailsTo(s, IAN)).find((m) => /^New booking/.test(m.subject)), 'pod notice to ian');
    });

    await s.step('a /meet booking: Jimi\'s own emails and event, with nothing of Eco Champions', async () => {
      await s.clearOutbox();
      const booked = await s.book({ slug: state.meetSlug, start: at('15:00'), durationMin: 30, name: 'Bea Cruz', email: 'bea@example.com' });
      s.expect(booked.status, 'booked').toBe(201);
      state.meetBookingId = booked.data.booking.id;
      await s.settle();
      const booking = (await s.bookings()).find((b) => b.id === state.meetBookingId);
      s.expect(booking.brandId ?? null, 'no brand').toBe(null);
      s.expect(booking.google, 'the account that holds the event').toMatchObject({ hostId: 'host_owner', accountEmail: JIMI });
      const event = (await eventsOf(s, JIMI)).find((e) => (e.description ?? '').includes(state.meetBookingId));
      s.expect(event?.description ?? '', 'the event').not.toContain('Eco Champions');
      const mails = [...(await mailsTo(s, 'bea@example.com')), ...(await mailsTo(s, JIMI))];
      s.expect(mails.length, 'emails').toBeGreaterThanOrEqual(2);
      for (const m of mails) {
        s.expect(m.from, `sender of "${m.subject}"`).not.toMatch(/Eco Champions/);
        s.expect(`${m.subject}\n${m.text}\n${m.html}\n${m.ics?.content ?? ''}`, `"${m.subject}"`).not.toContain('Eco Champions');
      }
      await s.screenshotEmail(mails.find((m) => m.to.some((to) => to.includes('bea@example.com'))), 'meet confirmation to the invitee');
    });

    await s.step('Jimi switches his main account: both bookings stay in the old one and are no longer linked', async () => {
      const owner = await s.newPage({ signedIn: true, timezoneId: 'Europe/London', ...DESKTOP });
      await owner.goto(s.url('/admin/integrations'));
      await openGoogleCard(owner);
      await googleCard(owner).getByRole('button', { name: 'Use a different Google account' }).click();
      const dialog = owner.getByRole('dialog', { name: 'Use a different Google account?' });
      await dialog.getByText(`2 upcoming meetings are in ${JIMI}.`, { exact: false }).waitFor();
      const google = await s.connectGoogle(owner, JIMI_NEW, 'Europe/London', { start: dialog.getByRole('button', { name: 'Choose another account' }) });
      s.expect(google.result.status, 'switched').toBe('connected');
      const { main, extras } = await s.googleAccountsOf('host_owner');
      s.expect([main.email, ...extras.map((a) => a.email)], "Jimi's accounts").toEqual([JIMI_NEW, JIMI_WORK]);
      for (const id of [state.podBookingId, state.meetBookingId]) {
        s.expect((await s.bookings()).find((b) => b.id === id).google, `booking ${id}`).toMatchObject({ detached: true, accountEmail: JIMI });
      }
    });

    await s.step('moving the /pod booking: Eco Champions emails with our own calendar file and the sentence, nothing written to Google', async () => {
      await s.clearOutbox();
      const record = (await s.bookings()).find((b) => b.id === state.podBookingId);
      const moved = await s.visitor().request('POST', `/public/bookings/${state.podBookingId}/reschedule`, { body: { t: record.manageToken, start: at('16:00') } });
      s.expect(moved.status, 'moved').toBe(200);
      await s.runJobs();
      s.expect(await s.outbox({ kind: 'calendar_insert' }), 'no new event').toEqual([]);
      s.expect(await s.googleEvents(JIMI_NEW), 'nothing in the new main account').toEqual([]);
      const mail = (await mailsTo(s, 'ann@example.com')).find((m) => m.ics);
      s.expect(mail?.from, 'sender').toMatch(/^Eco Champions </);
      s.expect(mail?.ics?.method, 'our own invitation').toBe('REQUEST');
      s.expect(mail.ics.content.replace(/\r\n /g, ''), 'the calendar file').toContain(`Booked through Eco Champions: ${s.shortUrl('pod')}`);
      s.expect(mail.text, 'the sentence').toContain('You may still see this meeting at its old time in your calendar, from the earlier Google Calendar invitation.');
      await s.screenshotEmail(mail, 'pod moved while detached to the invitee');
      const [ianMail] = await mailsTo(s, IAN);
      s.expect(ianMail?.from, 'to Ian').toMatch(/^Eco Champions </);
      s.expect(ianMail?.ics?.method, 'Ian gets a calendar file').toBe('PUBLISH');
    });

    await s.step('cancelling the /meet booking: Jimi\'s own email with our cancellation file and the sentence', async () => {
      await s.clearOutbox();
      const record = (await s.bookings()).find((b) => b.id === state.meetBookingId);
      const cancelled = await s.visitor().request('POST', `/public/bookings/${state.meetBookingId}/cancel`, { body: { t: record.manageToken, reason: 'Something came up' } });
      s.expect(cancelled.status, 'cancelled').toBe(200);
      await s.runJobs();
      const mail = (await mailsTo(s, 'bea@example.com')).find((m) => m.ics);
      s.expect(mail?.from, 'sender').not.toMatch(/Eco Champions/);
      s.expect(mail?.ics?.method, 'our own cancellation').toBe('CANCEL');
      s.expect(`${mail.text}\n${mail.html}\n${mail.ics.content}`, 'nothing of Eco Champions').not.toContain('Eco Champions');
      s.expect(mail.text, 'the sentence').toContain('If this meeting is still in your calendar from the earlier Google Calendar invitation, please delete it there.');
      await s.screenshotEmail(mail, 'meet cancelled while detached to the invitee');
    });
  });
});
