/**
 * Many Google accounts per person, in a real browser against the real backend and the Google stand-in.
 *
 * The rule of these scenarios (design 13.1): a time that proves an account is read is busy on an account
 * that is neither the main one nor the one connected last, and a time next to it must stay offered, so a
 * page that closes everything cannot pass either.
 */
import { defineSuite } from './lib.mjs';
import { MONDAY, clearToasts, expectToast } from './admin-helpers.mjs';

const A = 'jimi@example.com';
const B = 'jimi@work.example';
const C = 'jimi@eco.example';
const D = 'jimi@new.example';
const WEDNESDAY = '2026-11-18';
const wed = (time) => `${WEDNESDAY}T${time}:00.000Z`;
const THURSDAY = '2026-11-19';
const thu = (time) => `${THURSDAY}T${time}:00.000Z`;
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

export default defineSuite('admin-google-accounts', { mockCreds: true }, async (t) => {
  /** The owner, signed in on Integrations with A as the main account. */
  async function ownerWithA(s, { viewport } = {}) {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'Europe/London' });
    const page = await s.newPage({ signedIn: true, timezoneId: 'Europe/London', ...(viewport ? { viewport } : { viewport: { width: 1280, height: 900 } }) });
    const { result } = await s.connectGoogle(page, A, 'Europe/London', { start: { hostId: 'host_owner' } });
    s.expect(result.status, `A connected (${result.reason ?? ''})`).toBe('connected');
    await page.getByRole('heading', { name: 'Integrations', level: 1 }).waitFor();
    await clearToasts(page);
    return page;
  }
  const card = (page) => page.getByRole('region', { name: 'Google Calendar', exact: true });
  const others = (page) => card(page).getByRole('region', { name: 'Other Google accounts' });
  const row = (page, email) => others(page).locator('li.ga-row').filter({ has: page.getByText(email, { exact: true }) });
  const openCard = async (page) => {
    const toggle = card(page).getByRole('button', { name: 'Google Calendar', exact: true });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  };
  const wednesday = (s) => s.slots({ slug: 'intro', duration: 15, from: wed('00:00'), to: '2026-11-19T00:00:00.000Z' });
  const bookingOf = async (s, id) => (await s.bookings()).find((b) => b.id === id);

  await t.scenario('three accounts block times, meetings still go to the main one, and adding one twice adds nothing', { reset: true }, async (s) => {
    const page = await ownerWithA(s);
    let firstBooking = '';

    await s.step('the owner adds two more accounts: Google is asked for its account chooser, with no hint', async () => {
      await openCard(page);
      await others(page).getByText('None yet.', { exact: false }).waitFor();
      const added = await s.addGoogleAccount(page, others(page), B, 'Europe/London');
      s.expect(added.status, `B (${added.reason ?? ''})`).toBe('connected');
      s.expect(new URL(added.url).searchParams.get('gresult'), 'what came back').toBe('added');
      await expectToast(page, `${B} is connected`);
      await clearToasts(page);
      await s.addGoogleAccount(page, others(page), C, 'Europe/London');
      await expectToast(page, `${C} is connected`);
      const { main, extras } = await s.googleAccountsOf('host_owner');
      s.expect(main.email, 'the main account').toBe(A);
      s.expect(extras.map((a) => a.email), 'the other accounts').toEqual([B, C]);
      await row(page, B).waitFor();
      await row(page, C).waitFor();
      await s.screenshot(page, 'three accounts');
    });

    await s.step('busy time on each of the three accounts keeps that time off the page; the time next to it is offered', async () => {
      await s.setGoogleBusy(A, [{ start: wed('09:00'), end: wed('09:15') }]);
      await s.setGoogleBusy(B, [{ start: wed('10:00'), end: wed('10:15') }]);
      await s.setGoogleBusy(C, [{ start: wed('11:00'), end: wed('11:15') }]);
      const times = await wednesday(s);
      for (const busy of [wed('09:00'), wed('10:00'), wed('11:00')]) s.expect(times.includes(busy), `${busy} offered`).toBe(false);
      s.expect(times.includes(wed('12:00')), '12:00 offered').toBe(true);
      // B is neither the main account nor the last one connected: clearing it brings 10:00 back.
      await s.clearGoogleBusy(B);
      s.expect((await wednesday(s)).includes(wed('10:00')), '10:00 once B is free').toBe(true);
      await s.setGoogleBusy(B, [{ start: wed('10:00'), end: wed('10:15') }]);
    });

    await s.step('a booking lands in the main account only, and says which account it is in', async () => {
      await s.clearOutbox();
      const booked = await s.book({ slug: 'intro', start: wed('12:00'), name: 'Mary Somerville', email: 'mary@example.com' });
      s.expect(booked.status, 'booking').toBe(201);
      await s.settle();
      const inserts = await s.outbox({ kind: 'calendar_insert' });
      s.expect(inserts.map((c) => c.account), 'inserted as').toEqual([A]);
      const booking = await bookingOf(s, booked.data.booking.id);
      const { main } = await s.googleAccountsOf('host_owner');
      s.expect(booking.google, 'the booking').toMatchObject({ accountEmail: A, accountId: main.id });
      firstBooking = booking.id;
    });

    await s.step('the main account says what it is for, "Check all accounts" names each one, and the drawer names where the event is', async () => {
      await page.goto(s.url('/admin/integrations'));
      await openCard(page);
      await card(page).getByText('New meetings go here', { exact: true }).waitFor();
      await card(page).getByRole('button', { name: 'Check all accounts' }).click();
      // One line per account, the main one first (the other two were connected at the same moment, in either order).
      const detail = card(page).getByText(`${A}: `, { exact: false }).filter({ hasText: 'in the next 7 days.' });
      await detail.waitFor();
      const text = (await detail.textContent()).trim();
      s.expect(text.startsWith(`${A}: `), 'the main account first').toBe(true);
      s.expect(text.includes(`${B}: 1 busy block.`) && text.includes(`${C}: 1 busy block.`), `each account named: ${text}`).toBe(true);
      await page.goto(s.url(`/admin/bookings?b=${firstBooking}`));
      await page.getByText(`On Google Calendar (${A})`, { exact: true }).first().waitFor();
    });

    await s.step('adding B again refreshes it: still three accounts, its calendar choice kept', async () => {
      const b = (await s.googleAccountsOf('host_owner')).extras.find((a) => a.email === B);
      // A second calendar of B's that counts too (the stand-in gives every account a Family calendar).
      const { calendars } = await s.apiOk('GET', `/admin/hosts/host_owner/google/${b.id}/calendars`);
      const family = calendars.find((c) => c.summary === 'Family').id;
      await s.apiOk('PUT', '/admin/hosts/host_owner', { body: { googleCalendars: { accountId: b.id, busyCalendarIds: ['primary', family] } } });
      await page.goto(s.url('/admin/integrations'));
      await openCard(page);
      await s.addGoogleAccount(page, others(page), B, 'Europe/London');
      await expectToast(page, `${B} was already connected`);
      const { extras } = await s.googleAccountsOf('host_owner');
      s.expect(extras.map((a) => a.email), 'the other accounts').toEqual([B, C]);
      s.expect(extras[0].busyCalendarIds.length, "B's calendars").toBe(2);
      await clearToasts(page);
    });

    await s.step('Google renames B to B2: picking B2 is the same account, refreshed under its new address', async () => {
      const B2 = 'jimi@work2.example';
      await s.setGoogleAccount(B, { renameTo: B2 });
      await s.addGoogleAccount(page, others(page), B2, 'Europe/London');
      const { extras } = await s.googleAccountsOf('host_owner');
      s.expect(extras.map((a) => a.email), 'the other accounts').toEqual([B2, C]);
      await row(page, B2).waitFor();
      s.expect(await row(page, B).count(), 'a row for the old address').toBe(0);
    });

    await s.step('another Google account takes over the address C: two rows of C, each connected on its own date, and the old one keeps working', async () => {
      await s.setGoogleAccount(C, { newAccount: true });
      await s.advanceClock(86_400_000);
      await clearToasts(page);
      await s.addGoogleAccount(page, others(page), C, 'Europe/London');
      const { extras } = await s.googleAccountsOf('host_owner');
      s.expect(extras.filter((a) => a.email === C).length, 'rows of C').toBe(2);
      const rows = others(page).locator('li.ga-row').filter({ has: page.getByText(C, { exact: true }) });
      await s.eventually(async () => s.expect(await rows.count(), 'rows of C on screen').toBe(2));
      s.expect(await rows.nth(0).locator('.ga-row__meta').textContent(), 'first row').toContain('connected on 16 November');
      s.expect(await rows.nth(1).locator('.ga-row__meta').textContent(), 'second row').toContain('connected on 17 November');
      // The new one goes; the old C (whose 11:00 is still busy) stays and is still read.
      await rows.nth(1).getByRole('button', { name: 'Remove' }).click();
      const dialog = page.getByRole('dialog', { name: `Remove ${C}?` });
      await dialog.getByText('Its busy times will no longer be checked, so people can book over events that are only in this account.').waitFor();
      await dialog.getByRole('button', { name: 'Remove account' }).click();
      await expectToast(page, `${C} was removed`);
      s.expect((await s.googleAccountsOf('host_owner')).extras.filter((a) => a.email === C).length, 'rows of C after removing one').toBe(1);
      s.expect((await wednesday(s)).includes(wed('11:00')), '11:00 while the old C is busy').toBe(false);
    });
  });

  await t.scenario('removing an extra account: its times come back and its grant goes back to Google', { reset: true }, async (s) => {
    const page = await ownerWithA(s);
    await openCard(page);
    await s.addGoogleAccount(page, others(page), B, 'Europe/London');
    await s.addGoogleAccount(page, others(page), C, 'Europe/London');
    await s.setGoogleBusy(A, [{ start: wed('09:00'), end: wed('09:15') }]);
    await s.setGoogleBusy(B, [{ start: wed('10:00'), end: wed('10:15') }]);
    await s.setGoogleBusy(C, [{ start: wed('11:00'), end: wed('11:15') }]);

    await s.step("an extra account's calendars: loaded when opened, the last ticked one cannot be unticked, a tick saves itself", async () => {
      await row(page, B).getByRole('button', { name: 'Calendars' }).click();
      const main = row(page, B).getByRole('checkbox', { name: new RegExp(`^${B.replace(/[.]/g, '\\.')}`) });
      await main.and(page.locator(':checked')).waitFor();
      s.expect(await main.isDisabled(), 'the only ticked calendar can be unticked').toBe(true);
      await row(page, B).getByText('At least one calendar of each account counts. To stop an account counting, remove it.').first().waitFor();
      const saved = page.waitForResponse((r) => r.url().endsWith('/api/admin/hosts/host_owner') && r.request().method() === 'PUT' && r.status() === 200);
      await row(page, B).getByRole('checkbox', { name: 'Family' }).click();
      await saved;
      const b = (await s.googleAccountsOf('host_owner')).extras.find((a) => a.email === B);
      s.expect(b.busyCalendarIds.length, "B's calendars that count").toBe(2);
      s.expect((await s.googleAccountsOf('host_owner')).main.busyCalendarIds, "A's calendars, untouched").toEqual(['primary']);
      await s.screenshot(page, 'calendars of an extra account');
    });

    await s.step('the dialog says what removing it changes, and afterwards 10:00 is offered again', async () => {
      await s.clearOutbox();
      await row(page, B).getByRole('button', { name: 'Remove' }).click();
      const dialog = page.getByRole('dialog', { name: `Remove ${B}?` });
      await dialog.getByText(/Its busy times will no longer be checked/).waitFor();
      await dialog.getByRole('button', { name: 'Remove account' }).click();
      await expectToast(page, `${B} was removed`);
      const times = await wednesday(s);
      s.expect(times.includes(wed('10:00')), '10:00').toBe(true);
      s.expect(times.includes(wed('09:00')), '09:00 (A)').toBe(false);
      s.expect(times.includes(wed('11:00')), '11:00 (C)').toBe(false);
      s.expect((await s.outbox({ kind: 'revoke' })).map((r) => r.account), 'grants handed back').toEqual([B]);
    });
  });

  await t.scenario('one account that cannot be read closes the times, is named everywhere, and one Reconnect mends it', { reset: true }, async (s) => {
    s.allowConsoleErrors(/status of 503/);
    const page = await ownerWithA(s);
    await openCard(page);
    await s.addGoogleAccount(page, others(page), B, 'Europe/London');
    await s.addGoogleAccount(page, others(page), C, 'Europe/London');
    await s.setGoogleBusy(C, [{ start: wed('11:00'), end: wed('11:15') }]);
    await s.apiOk('PUT', '/admin/site', { body: { email: { fromEmail: 'meetings@jimicohen.test' } } });

    await s.step('Google ends B\'s grant: the page offers nothing and a booking is refused', async () => {
      await s.setGoogleAccount(B, { revoked: true });
      const visitor = s.visitor();
      const answer = await visitor.ok('GET', '/public/slots', { query: { slug: 'intro', duration: 15, from: wed('00:00'), to: '2026-11-19T00:00:00.000Z' } });
      s.expect(answer.slots, 'times').toEqual([]);
      s.expect(answer.unavailableReason, 'why').toBe('calendar_error');
      const booked = await s.book({ slug: 'intro', start: wed('12:00') });
      s.expect(booked.status, 'booking').toBe(503);
    });

    await s.step('Home, Integrations and the alert all name B', async () => {
      const overview = await s.apiOk('GET', '/admin/overview');
      const warning = overview.warnings.find((w) => w.key === 'google_reconnect_host_owner');
      s.expect(warning?.message, 'Home warning').toBe(`Your Google account ${B} needs to be reconnected. Until then, no times are offered for meetings with you.`);
      await page.reload();
      await openCard(page);
      await row(page, B).getByText('Needs reconnecting').waitFor();
      s.expect((await card(page).locator('.ix-card__status').textContent()).trim(), 'badge').toBe('1 account needs reconnecting');
      await s.runJobs();
      const alerts = (await s.outbox({ kind: 'email' })).filter((e) => String(e.subject).startsWith('A calendar needs attention'));
      s.expect(alerts.map((e) => e.subject), 'alerts').toEqual([`A calendar needs attention: Jimi Cohen (${B})`]);
      s.expect(alerts[0].text, 'what the alert says').toContain(`Jimi Cohen, ${B}: Google Calendar needs to be reconnected.`);
      await s.screenshot(page, 'an account that needs reconnecting');
    });

    await s.step('Reconnect on its row asks Google for B, and the times come back; C still blocks 11:00', async () => {
      await s.setGoogleAccount(B, { revoked: false });
      const google = await s.connectGoogle(page, B, 'Europe/London', { start: row(page, B).getByRole('button', { name: 'Reconnect' }) });
      s.expect(google.result.status, 'reconnected').toBe('connected');
      s.expect(google.result.request.loginHint, 'hint').toBe(B);
      s.expect(new URL(google.result.url).searchParams.get('gresult'), 'result').toBe('refreshed');
      const times = await wednesday(s);
      s.expect(times.includes(wed('12:00')), '12:00').toBe(true);
      s.expect(times.includes(wed('11:00')), '11:00 (C)').toBe(false);
    });
  });

  await t.scenario('old data: a main account of before and an unstamped booking keep working, and the booking is stamped', { reset: true }, async (s) => {
    const page = await ownerWithA(s);
    await openCard(page);
    await s.addGoogleAccount(page, others(page), C, 'Europe/London');
    const booked = await s.book({ slug: 'intro', start: wed('12:00'), name: 'Ada Lovelace', email: 'ada@example.com' });
    s.expect(booked.status, 'booking').toBe(201);
    await s.settle();
    const id = booked.data.booking.id;

    await s.step('the hosts and the booking are put back in the shape an older deploy writes', async () => {
      const hosts = await s.kv('hosts');
      const owner = hosts.find((h) => h.id === 'host_owner');
      const { id: _id, sub: _sub, health: _h, refreshedAt: _r, ...oldMain } = owner.google;
      owner.google = oldMain;
      await s.putKv('hosts', hosts);
      const key = `bookings/${id}`;
      const record = await s.kv(key);
      const { accountId: _a, accountEmail: _e, ...oldGoogle } = record.google;
      await s.putKv(key, { ...record, google: oldGoogle });
      s.expect((await bookingOf(s, id)).google.accountId, 'stamp before').toBe(undefined);
    });

    await s.step('the dashboard shows both accounts, and the extra one still blocks its times', async () => {
      await page.reload();
      await openCard(page);
      await card(page).getByText(`Connected as ${A}`).waitFor();
      await row(page, C).getByText('Connected', { exact: true }).waitFor();
      await s.setGoogleBusy(C, [{ start: wed('11:00'), end: wed('11:15') }]);
      s.expect((await wednesday(s)).includes(wed('11:00')), '11:00').toBe(false);
    });

    await s.step('housekeeping stamps the booking with the account whose copy carries its id, and a move is written there', async () => {
      await s.advanceClock(31 * 60_000);
      await s.runJobs();
      const after = await bookingOf(s, id);
      s.expect(after.google?.accountEmail, 'stamped with').toBe(A);
      s.expect(after.google?.accountId, 'stamped id').toMatch(/^gacc_/);
      const { main } = await s.googleAccountsOf('host_owner');
      if (main.id) s.expect(after.google.accountId, 'the id stored with the main account').toBe(main.id);
      await s.clearOutbox();
      const moved = await s.visitor().request('POST', `/public/bookings/${id}/reschedule`, { body: { t: after.manageToken, start: wed('13:00') } });
      s.expect(moved.status, 'move').toBe(200);
      await s.settle();
      s.expect((await s.outbox({ kind: 'calendar_patch' })).map((c) => c.account), 'patched as').toEqual([A]);
      s.expect(await s.outbox({ kind: 'calendar_insert' }), 'inserts').toEqual([]);
    });
  });

  await t.scenario('a co-host with two accounts on a joint meeting: both block, the owner hears of the second', { reset: true }, async (s) => {
    const owner = await ownerWithA(s);
    const created = await s.apiOk('POST', '/admin/hosts', { body: { name: 'Alex Rivera', email: 'alex@example.com' } });
    const alexId = created.host.id;
    await s.apiOk('POST', '/admin/event-types', { body: { title: 'Joint call', slug: 'joint', kind: 'collective', hostIds: ['host_owner', alexId], durations: [15], defaultDuration: 15 } });
    const alex = await s.newPage({ timezoneId: 'Europe/London', ip: '10.99.0.8', viewport: { width: 1280, height: 900 } });
    const calendar = alex.getByRole('region', { name: 'Your calendar' });

    await s.step('Alex connects a main account and adds a second, from the private link', async () => {
      await alex.goto(created.inviteUrl);
      await alex.getByRole('heading', { name: 'Hi Alex. One step to go.', level: 1 }).waitFor();
      const first = await s.connectGoogle(alex, 'alex@gmail.example', 'Europe/London', { start: calendar.getByRole('button', { name: 'Connect Google Calendar' }) });
      s.expect(first.result.status, 'first').toBe('connected');
      await clearToasts(alex);
      const second = await s.addGoogleAccount(alex, calendar, 'alex@work.example', 'Europe/London');
      s.expect(new URL(second.url).pathname, 'back on their page').toBe(`/meeting/host/${alexId}`);
      await expectToast(alex, 'alex@work.example is connected');
      const { main, extras } = await s.googleAccountsOf(alexId);
      s.expect([main.email, ...extras.map((a) => a.email)], "Alex's accounts").toEqual(['alex@gmail.example', 'alex@work.example']);
    });

    await s.step('busy on either of Alex\'s accounts closes that time on the joint meeting; 12:00 is offered', async () => {
      await s.setGoogleBusy('alex@gmail.example', [{ start: thu('10:00'), end: thu('10:15') }]);
      await s.setGoogleBusy('alex@work.example', [{ start: thu('11:00'), end: thu('11:15') }]);
      const times = await s.slots({ slug: 'joint', duration: 15, from: thu('00:00'), to: '2026-11-20T00:00:00.000Z' });
      s.expect(times.includes(thu('10:00')), '10:00').toBe(false);
      s.expect(times.includes(thu('11:00')), '11:00').toBe(false);
      s.expect(times.includes(thu('12:00')), '12:00').toBe(true);
    });

    await s.step('the owner is told, and the co-host too', async () => {
      await s.runJobs();
      const emails = await s.outbox({ kind: 'email' });
      s.expect(emails.some((e) => e.subject === 'Alex connected another Google account' && e.to.some((to) => to.includes(A))), 'notice to the owner').toBe(true);
      s.expect(emails.some((e) => e.subject === 'A Google account was connected to your booking page' && e.to.some((to) => to.includes('alex@example.com'))), 'notice to Alex').toBe(true);
    });

    await s.step('a booking at 12:00 lands on the owner\'s calendar with Alex\'s main address invited', async () => {
      await s.clearOutbox();
      const booked = await s.book({ slug: 'joint', start: thu('12:00'), name: 'Grace Hopper', email: 'grace@example.com' });
      s.expect(booked.status, 'booking').toBe(201);
      await s.settle();
      const [insert] = await s.outbox({ kind: 'calendar_insert' });
      s.expect(insert.account, 'organiser').toBe(A);
      const [event] = await s.googleEvents(A);
      s.expect(event.event.attendees.map((a) => a.email), 'attendees').toContain('alex@gmail.example');
      void owner;
    });
  });

  await t.scenario('"Use a different Google account" sends no second invitation for meetings already booked', { reset: true }, async (s) => {
    const page = await ownerWithA(s);
    await s.apiOk('PUT', '/admin/site', { body: { email: { fromEmail: 'meetings@jimicohen.test' } } });
    const booked = await s.book({ slug: 'intro', start: wed('12:00'), name: 'Ada Lovelace', email: 'ada@example.com' });
    await s.settle();
    const id = booked.data.booking.id;

    await s.step('the dialog says the upcoming meeting stays in A, and D becomes the main account', async () => {
      await page.goto(s.url('/admin/integrations'));
      await openCard(page);
      await card(page).getByRole('button', { name: 'Use a different Google account' }).click();
      const dialog = page.getByRole('dialog', { name: 'Use a different Google account?' });
      await dialog.getByText(`1 upcoming meeting is in ${A}.`, { exact: false }).waitFor();
      const google = await s.connectGoogle(page, D, 'Europe/London', { start: dialog.getByRole('button', { name: 'Choose another account' }) });
      s.expect(google.result.status, 'switched').toBe('connected');
      s.expect(google.result.request.accountChooser, 'account chooser').toBe(true);
      s.expect((await s.googleAccountsOf('host_owner')).main.email, 'main account').toBe(D);
      s.expect((await bookingOf(s, id)).google, 'the booking').toMatchObject({ detached: true, accountEmail: A });
    });

    await s.step('moving that meeting makes no event in D, and the invitee gets our calendar file and a plain sentence', async () => {
      await s.clearOutbox();
      const record = await bookingOf(s, id);
      const moved = await s.visitor().request('POST', `/public/bookings/${id}/reschedule`, { body: { t: record.manageToken, start: wed('13:00') } });
      s.expect(moved.status, 'move').toBe(200);
      await s.runJobs();
      s.expect(await s.outbox({ kind: 'calendar_insert' }), 'inserts').toEqual([]);
      s.expect(await s.googleEvents(D), 'events in D').toEqual([]);
      const mail = (await s.outbox({ kind: 'email' })).find((e) => e.to.some((to) => to.includes('ada@example.com')));
      s.expect(mail?.ics?.method, 'calendar file').toBe('REQUEST');
      s.expect(mail?.text, 'the sentence').toContain('You may still see this meeting at its old time in your calendar, from the earlier Google Calendar invitation.');
    });

    await s.step('the booking drawer says it is no longer linked to a Google event', async () => {
      await page.goto(s.url(`/admin/bookings?b=${id}`));
      await page.getByText(`This meeting is no longer linked to a Google Calendar event. The event was in ${A}, which is no longer connected.`, { exact: false }).waitFor();
    });
  });

  await t.scenario('the ceiling: 20 accounts, a disabled button with the reason, and reconnecting still works', { reset: true }, async (s) => {
    s.allowConsoleErrors(/status of 409/);
    const page = await ownerWithA(s);
    const hosts = await s.kv('hosts');
    const owner = hosts.find((h) => h.id === 'host_owner');
    const base = { ...owner.google };
    owner.googleExtra = Array.from({ length: 19 }, (_, i) => ({ ...base, id: `gacc_ceiling_${String(i).padStart(2, '0')}`, email: `n${i}@x.example`, sub: undefined, connectedAt: MONDAY }));
    owner.googleExtra[3].status = 'needs_reconnect';
    await s.putKv('hosts', hosts);

    await s.step('Integrations disables the add button and says why', async () => {
      await page.reload();
      await openCard(page);
      await others(page).getByText('You have connected 20 Google accounts, the most one person can connect here. Remove one to add another.').waitFor();
      s.expect(await others(page).getByRole('button', { name: 'Add another Google account' }).isDisabled(), 'add button').toBe(true);
    });

    await s.step('opening the add link anyway comes back with the same sentence', async () => {
      await page.evaluate((target) => window.location.assign(target), `${s.server.api}/google/connect?host=host_owner&add=1&return=${encodeURIComponent('/meeting/admin/integrations')}`);
      await page.waitForURL((url) => url.searchParams.has('google'));
      const back = new URL(page.url());
      s.expect(back.searchParams.get('reason'), 'reason').toBe('You have connected 20 Google accounts, the most one person can connect here. Remove one to add another.');
    });

    await s.step('Reconnect on a row is still allowed at the ceiling', async () => {
      await page.goto(s.url('/admin/integrations'));
      await openCard(page);
      const google = await s.connectGoogle(page, 'n3@x.example', 'Europe/London', { start: row(page, 'n3@x.example').getByRole('button', { name: 'Reconnect' }) });
      s.expect(google.result.status, `reconnect (${google.result.reason ?? ''})`).toBe('connected');
      s.expect(google.result.request.loginHint, 'hint').toBe('n3@x.example');
      const { extras } = await s.googleAccountsOf('host_owner');
      s.expect(extras.length, 'still 19 others').toBe(19);
      s.expect(extras.find((a) => a.email === 'n3@x.example').status, 'n3').toBe('ok');
    });
  });

  await t.scenario('a private link replaced while the person was at Google connects nothing', { reset: true }, async (s) => {
    await ownerWithA(s);
    const created = await s.apiOk('POST', '/admin/hosts', { body: { name: 'Alex Rivera', email: 'alex@example.com' } });
    const alexId = created.host.id;
    const token = new URL(created.inviteUrl).searchParams.get('t');

    await s.step('Alex starts "Add another Google account", the owner replaces the link, Google sends Alex back', async () => {
      const query = new URLSearchParams({ host: alexId, add: '1', t: token, return: `/meeting/host/${alexId}` });
      const start = await fetch(`${s.server.api}/google/connect?${query}`, { redirect: 'manual', headers: { 'sec-fetch-site': 'same-origin' } });
      s.expect(start.status, 'to Google').toBe(302);
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const cookie = start.headers.get('set-cookie').split(';')[0];
      await s.apiOk('POST', `/admin/hosts/${alexId}/invite`, { body: {} });
      await s.clearOutbox();
      const back = await fetch(`${s.server.api}/google/callback?${new URLSearchParams({ state, code: 'mock:alex@work.example:UTC' })}`, { redirect: 'manual', headers: { cookie } });
      const to = new URL(back.headers.get('location'));
      s.expect(to.searchParams.get('google'), 'result').toBe('error');
      s.expect(to.searchParams.get('reason'), 'reason').toBe('This private link was replaced while you were at Google. Open the new link and connect again.');
      const stored = await s.googleAccountsOf(alexId);
      s.expect([stored.main, stored.extras.length], 'what is stored').toEqual([null, 0]);
      s.expect(await s.outbox({ kind: 'token' }), 'codes exchanged').toEqual([]);
    });
  });

  await t.scenario('phone width: the account rows on Integrations, Team and the co-host page fit, and nothing scrolls sideways', { reset: true }, async (s) => {
    const page = await ownerWithA(s, { viewport: PHONE.viewport });
    await openCard(page);
    await s.addGoogleAccount(page, others(page), 'jimi@a-rather-long-work-address.example', 'Europe/London');
    const created = await s.apiOk('POST', '/admin/hosts', { body: { name: 'Alex Rivera', email: 'alex@example.com' } });
    await s.connectGoogle(page, 'alex@gmail.example', 'Europe/London', { start: { hostId: created.host.id, returnTo: '/meeting/admin/team' } });
    await s.connectGoogle(page, 'alex@work.example', 'Europe/London', { start: { hostId: created.host.id, returnTo: '/meeting/admin/team', add: true } });
    const noSideScroll = async (p, label) => s.expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: no sideways scroll`).toBe(true);

    await s.step('Integrations', async () => {
      await page.goto(s.url('/admin/integrations'));
      await openCard(page);
      await row(page, 'jimi@a-rather-long-work-address.example').waitFor();
      await noSideScroll(page, 'Integrations');
      await s.screenshot(page, 'integrations at 390');
    });

    await s.step('Team', async () => {
      await page.goto(s.url('/admin/team'));
      const alexCard = page.getByRole('listitem').filter({ hasText: 'Alex Rivera' }).first();
      await alexCard.getByText('2 Google accounts').waitFor();
      await alexCard.getByRole('button', { name: 'Show accounts' }).click();
      await alexCard.getByText('alex@work.example', { exact: true }).waitFor();
      // Adding and reconnecting stay with Alex: from this browser Google would sign in the owner's own account.
      s.expect(await alexCard.getByRole('button', { name: 'Add another Google account' }).count(), 'no add button for a co-host').toBe(0);
      s.expect(await alexCard.getByRole('button', { name: 'Reconnect' }).count(), 'no reconnect for a co-host').toBe(0);
      await alexCard.getByText('Alex adds and reconnects their own Google accounts from their private link. You can remove any of them here.').waitFor();
      s.expect(await alexCard.getByRole('button', { name: 'Remove' }).count(), 'remove stays').toBe(1);
      await noSideScroll(page, 'Team');
      await s.screenshot(page, 'team at 390');
    });

    await s.step('the co-host page', async () => {
      const alex = await s.newPage({ timezoneId: 'Europe/London', ip: '10.99.0.9', ...PHONE });
      await alex.goto(created.inviteUrl);
      await alex.getByRole('region', { name: 'Your calendar' }).getByText('alex@work.example', { exact: true }).waitFor();
      // The Google Cloud app is the owner's: Alex is told whom to ask, not to change "your" app.
      const card = alex.getByRole('region', { name: 'Your calendar' });
      await card.getByText('ask Jimi to add the account as a test user', { exact: false }).waitFor();
      s.expect(await card.getByText('your Google Cloud app', { exact: false }).count(), 'no "your Google Cloud app" for a co-host').toBe(0);
      await noSideScroll(alex, 'co-host page');
      await s.screenshot(alex, 'co-host page at 390');
    });
  });
});
