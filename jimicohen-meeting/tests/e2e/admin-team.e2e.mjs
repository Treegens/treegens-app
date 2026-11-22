/**
 * Team and joint meetings in a real browser against the real backend: the owner adds a
 * co-host, the co-host sets themselves up through their private link (a different browser, no
 * dashboard session), and a joint meeting only offers times when both are free.
 */
import { createHash } from 'node:crypto';
import { defineSuite } from './lib.mjs';
import { MONDAY, clearToasts, expectFieldProblem, expectToast, offeredTimes, openBookingPage, openPage, pngFile, saveAndWait, wallTime } from './admin-helpers.mjs';

const OWNER_GOOGLE = 'jimi@example.com';
const CO_HOST = { name: 'Alex Rivera', email: 'alex@example.com' };
const TUESDAY = '2026-11-17';
const at = (time) => `${TUESDAY}T${time}:00.000Z`;

export default defineSuite('admin-team', { mockCreds: true }, async (t) => {
  await t.scenario('a co-host joins through a private link, and a joint meeting offers only shared free time', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'Europe/London' });
    const owner = await s.newPage({ signedIn: true, timezoneId: 'Europe/London', viewport: { width: 1440, height: 900 } });
    await owner.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const alexHost = async () => (await s.kv('hosts')).find((h) => h.email === CO_HOST.email) ?? null;
    const visitor = await s.newPage({ timezoneId: 'UTC' });
    const offered = async (slug, day = TUESDAY) => {
      await openBookingPage(s, visitor, slug);
      return (await offeredTimes(visitor, day)).map((iso) => wallTime(iso, 'UTC'));
    };
    let inviteUrl = '';
    let hostId = '';

    await s.step('the owner connects their own calendar first', async () => {
      const google = await s.connectGoogle(owner, OWNER_GOOGLE, 'Europe/London', { start: { hostId: 'host_owner', returnTo: '/meeting/admin/team' } });
      s.expect(google.result.status, `owner connect result (${google.result.reason ?? 'no reason'})`).toBe('connected');
      await owner.getByRole('heading', { name: 'Team', level: 1 }).waitFor();
      await owner.getByRole('listitem').filter({ hasText: 'Jimi Cohen' }).getByText('Calendar connected').waitFor();
      // Team says what happened and takes the result off the address, as Integrations does.
      await expectToast(owner, 'Google is connected');
      await owner.waitForURL((url) => !url.searchParams.has('google'));
      s.expect(new URL(owner.url()).pathname + new URL(owner.url()).search, 'address after coming back to Team').toBe('/meeting/admin/team');
      await clearToasts(owner);
    });

    await s.step('add a co-host: a bad email lands on its field, a good one gives the private link', async () => {
      await owner.getByRole('button', { name: 'Add a co-host' }).first().click();
      const dialog = owner.getByRole('dialog', { name: 'Add a co-host' });
      await dialog.getByLabel('Name').fill(CO_HOST.name);
      await dialog.getByLabel('Email').fill('alex-at-example');
      await dialog.getByRole('button', { name: 'Add and get their link' }).click();
      await expectFieldProblem(s, dialog.getByLabel('Email'), 'Please enter a full email address.', 'problem on the email');
      s.expect((await s.kv('hosts')).length, 'hosts after a refused add').toBe(1);
      await dialog.getByLabel('Email').fill(CO_HOST.email);
      await dialog.getByRole('button', { name: 'Add and get their link' }).click();

      const added = owner.getByRole('dialog', { name: 'Alex is on the team' });
      inviteUrl = await added.getByRole('textbox', { name: `Private link for ${CO_HOST.name}` }).inputValue();
      const stored = await alexHost();
      hostId = stored.id;
      s.expect(stored, 'the stored co-host').toMatchObject({ role: 'member', name: CO_HOST.name, email: CO_HOST.email, timezone: 'Europe/London', timezoneMode: 'device', google: null, icsFeeds: [] });
      const link = new URL(inviteUrl);
      s.expect(link.origin + link.pathname, 'address of the private link').toBe(s.url(`/host/${hostId}`));
      const token = link.searchParams.get('t');
      // Only a hash of the token is kept, so the link cannot be shown again or read from the store.
      s.expect(stored.inviteTokenHash, 'stored token hash').toBe(createHash('sha256').update(token).digest('hex'));
      s.expect(JSON.stringify(await s.kv('hosts')).includes(token), 'the token itself is in the store').toBe(false);
      s.expect((await s.api('GET', '/admin/hosts')).text.includes(token), 'the token is in the hosts list').toBe(false);
    });

    await s.step('copy the invite link', async () => {
      const added = owner.getByRole('dialog', { name: 'Alex is on the team' });
      await added.getByRole('button', { name: 'Copy link' }).click();
      await s.eventually(async () => s.expect(await owner.evaluate(() => navigator.clipboard.readText()), 'clipboard').toBe(inviteUrl));
      s.expect(await added.getByRole('link', { name: 'Email it to Alex' }).getAttribute('href'), 'mail link').toContain(encodeURIComponent(inviteUrl));
      await added.getByRole('button', { name: 'Done' }).click();
      await added.waitFor({ state: 'hidden' });
      const row = owner.getByRole('listitem').filter({ hasText: CO_HOST.name });
      await row.getByText('No calendar yet').waitFor();
      await row.getByText('Waiting for Alex to open their private link and connect a calendar.').waitFor();
      await s.screenshot(owner, 'team with a co-host who has not connected yet');
    });

    await s.step('the same email cannot be added twice', async () => {
      s.allowConsoleErrors(/status of 422/);
      await owner.getByRole('button', { name: 'Add a co-host' }).first().click();
      const dialog = owner.getByRole('dialog', { name: 'Add a co-host' });
      await dialog.getByLabel('Name').fill('Another Alex');
      await dialog.getByLabel('Email').fill('ALEX@example.com');
      await dialog.getByRole('button', { name: 'Add and get their link' }).click();
      await expectFieldProblem(s, dialog.getByLabel('Email'), 'Someone with this email is already on the team.', 'problem on the email');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      s.expect((await s.kv('hosts')).length, 'hosts').toBe(2);
    });

    // A different browser: no dashboard session, another city, another Google account.
    const alex = await s.newPage({ timezoneId: 'America/New_York', viewport: { width: 1280, height: 900 }, ip: '10.99.0.7' });

    await s.step('the co-host opens the link: their page loads, and their zone follows their device', async () => {
      await alex.goto(inviteUrl);
      await alex.getByRole('heading', { name: 'Hi Alex. One step to go.', level: 1 }).waitFor();
      await alex.getByText('Co-host page · meetings with Jimi Cohen').waitFor();
      await expectToast(alex, 'Your time zone is now Eastern Time (New York)');
      s.expect(await alexHost(), 'co-host after opening the link').toMatchObject({ timezone: 'America/New_York', timezoneMode: 'device' });
      await alex.getByRole('region', { name: 'Your time zone' }).getByText('Eastern Time (New York)').first().waitFor();
      await alex.getByRole('region', { name: 'Your calendar' }).getByText('Not connected').waitFor();
      s.expect((await alex.context().cookies()).filter((c) => c.name === 'mtg_session'), 'dashboard session in the co-host browser').toEqual([]);
      await clearToasts(alex);
    });

    await s.step('the link opens this one record only: no dashboard, no other host, no changing who they are', async () => {
      s.allowConsoleErrors(/status of 40[14]/);
      const token = new URL(inviteUrl).searchParams.get('t');
      const guest = s.visitor();
      s.expect((await guest.request('GET', '/admin/bootstrap')).status, 'dashboard data without a session').toBe(401);
      s.expect((await guest.request('GET', '/host/host_owner', { query: { t: token } })).status, "the owner's record with the co-host's token").toBe(404);
      s.expect((await guest.request('GET', `/host/${hostId}`, { query: { t: 'not-the-token' } })).status, 'the record with a wrong token').toBe(404);
      s.expect((await guest.request('GET', '/google/connect', { query: { host: hostId, gmail: 0, return: `/meeting/host/${hostId}`, t: 'not-the-token' } })).status, 'Google connect with a wrong token').toBeGreaterThanOrEqual(400);
      const sneaky = await guest.request('PUT', `/host/${hostId}`, { query: { t: token }, body: { email: 'mallory@example.com', role: 'owner', title: 'Co-founder' } });
      s.expect(sneaky.status, 'an update that also tries to change email and role').toBe(200);
      s.expect(await alexHost(), 'what was stored of it').toMatchObject({ email: CO_HOST.email, role: 'member', title: 'Co-founder' });
    });

    let familyId = '';
    await s.step('the co-host connects Google Calendar as a different account', async () => {
      const google = await s.connectGoogle(alex, CO_HOST.email, 'Africa/Nairobi');
      await alex.getByRole('button', { name: 'Connect Google Calendar' }).click();
      const result = await google.done();
      s.expect(result.status, `co-host connect result (${result.reason ?? 'no reason'})`).toBe('connected');
      await expectToast(alex, 'Your calendar is connected');
      // Their hours now follow the calendar's zone (Nairobi), not the device's (New York): said, not done in silence.
      s.expect(new URL(result.url).searchParams.get('zone'), 'zone reported by the return from Google').toBe('Africa/Nairobi');
      await expectToast(alex, 'Your time zone is now');
      const zoneCard = alex.getByRole('region', { name: 'Your time zone' });
      await zoneCard.getByText(/^This device is in .*New York.*Your hours follow Google Calendar: .*Nairobi/).waitFor();
      await zoneCard.getByRole('button', { name: 'Follow this device instead' }).waitFor();
      await alex.getByRole('heading', { name: 'You are all set, Alex.', level: 1 }).waitFor();
      const calendar = alex.getByRole('region', { name: 'Your calendar' });
      await calendar.getByText(`Connected as ${CO_HOST.email}`).waitFor();
      s.expect(await alexHost(), 'co-host after connecting').toMatchObject({
        timezone: 'Africa/Nairobi',
        timezoneMode: 'google',
        google: { email: CO_HOST.email, status: 'ok', busyCalendarIds: ['primary'], writeCalendarId: 'primary' },
      });
      // The owner's connection is untouched: two people, two accounts.
      s.expect((await s.kv('hosts'))[0].google.email, "the owner's Google account").toBe(OWNER_GOOGLE);
      // Back on their page, at their address, without the leftovers of the round trip.
      s.expect(new URL(alex.url()).pathname, 'address after connecting').toBe(`/meeting/host/${hostId}`);
      await clearToasts(alex);
    });

    await s.step('picks the calendars that count, and where new meetings go', async () => {
      const calendar = alex.getByRole('region', { name: 'Your calendar' });
      const choices = calendar.getByRole('group', { name: 'Keep me free when these calendars are busy' });
      await choices.getByRole('checkbox', { name: /^alex@example\.com/ }).and(alex.locator(':checked')).waitFor();
      const saved = alex.waitForResponse((r) => r.url().includes(`/api/host/${hostId}`) && r.request().method() === 'PUT' && r.status() === 200);
      // Saved on its own: the tick appears once the server has answered.
      await choices.getByRole('checkbox', { name: 'Family' }).click();
      await saved;
      await choices.getByRole('checkbox', { name: 'Family' }).and(alex.locator(':checked')).waitFor();
      const stored = (await alexHost()).google;
      s.expect(stored.busyCalendarIds.length, 'calendars that count').toBe(2);
      familyId = stored.busyCalendarIds.find((id) => id !== 'primary');
      s.expect(familyId, 'id of the Family calendar').toMatch(/^family.+@group\.calendar\.google\.com$/);
      // The holiday calendar is read-only: it can be checked for busy time, but meetings cannot be written to it.
      const write = calendar.getByLabel('Add new meetings to');
      s.expect(await write.locator('option').allTextContents(), 'calendars meetings can go to').toEqual(['alex@example.com (main)', 'Family']);
      await s.screenshot(alex, 'co-host page with calendars');
    });

    await s.step('sets their weekly hours', async () => {
      const hours = alex.getByRole('region', { name: 'Your hours' });
      const week = hours.getByRole('group', { name: 'Weekly hours' });
      await week.getByRole('combobox', { name: 'Monday, range 1, end' }).selectOption('20:00');
      await week.getByRole('combobox', { name: 'Monday, range 1, start' }).selectOption('14:00');
      await week.getByRole('button', { name: "Copy Monday's hours to other days" }).click();
      const copy = alex.getByRole('dialog', { name: "Copy Monday's hours to other days" });
      await copy.getByRole('button', { name: 'Weekdays' }).click();
      await copy.getByRole('button', { name: 'Copy to 4 days' }).click();
      await hours.getByRole('button', { name: 'Save hours' }).click();
      await expectToast(alex, 'Your hours are saved');
      await hours.getByText('Your hours are saved.').waitFor();
      const weekly = (await alexHost()).schedules[0].weekly;
      for (const day of [1, 2, 3, 4, 5]) s.expect(weekly[day], `stored hours, weekday ${day}`).toEqual([{ start: '14:00', end: '20:00' }]);
      s.expect(weekly[0], 'stored Sunday').toEqual([]);
      await clearToasts(alex);
    });

    await s.step('fixes their time zone to Dubai', async () => {
      const zone = alex.getByRole('region', { name: 'Your time zone' });
      await zone.getByRole('radio', { name: /^Keep it fixed/ }).click();
      await expectToast(alex, 'Time zone fixed to East Africa Time (Nairobi)');
      await zone.getByRole('button', { name: /^Time zone: East Africa Time \(Nairobi\)\. Change$/ }).click();
      const dialog = alex.getByRole('dialog', { name: 'Choose a time zone' });
      await dialog.getByRole('combobox', { name: 'Search time zones' }).fill('dubai');
      await dialog.getByRole('option', { name: /Dubai/ }).first().click();
      await expectToast(alex, /Time zone set to .*\(Dubai\)/);
      s.expect(await alexHost(), 'co-host zone').toMatchObject({ timezone: 'Asia/Dubai', timezoneMode: 'fixed' });
      await alex.getByRole('region', { name: 'Your hours' }).getByText(/Times are in .*\(Dubai\)/).waitFor();
      // A reload in New York does not move a fixed zone.
      await clearToasts(alex);
      await alex.reload();
      await alex.getByRole('heading', { name: 'You are all set, Alex.', level: 1 }).waitFor();
      await alex.waitForLoadState('networkidle');
      s.expect(await alexHost(), 'co-host zone after a reload').toMatchObject({ timezone: 'Asia/Dubai', timezoneMode: 'fixed' });
    });

    let feedUrl = '';
    await s.step('another calendar: a bad link is refused with a reason, a good one is linked', async () => {
      s.allowConsoleErrors(/status of 422/);
      const other = alex.getByRole('region', { name: 'Another calendar' });
      const link = other.getByRole('textbox', { name: 'ICS link' });
      s.expect(await other.getByRole('button', { name: 'Link calendar' }).isDisabled(), 'link button with nothing typed').toBe(true);
      // Not a link at all: caught on the page.
      await link.fill('calendar.example.com/alex.ics');
      await other.getByRole('button', { name: 'Link calendar' }).click();
      await expectFieldProblem(s, link, 'Paste the full link. It starts with https:// or webcal://', 'problem on the link');
      // A link into a private network: refused by the server.
      await link.fill('https://192.168.1.20/private/alex.ics');
      const refused = alex.waitForResponse((r) => r.url().includes(`/api/host/${hostId}`) && r.request().method() === 'PUT');
      await other.getByRole('button', { name: 'Link calendar' }).click();
      const answer = await refused;
      s.expect(answer.status(), 'status for a private address').toBe(422);
      const fields = (await answer.json()).error.fields;
      s.expect(Object.keys(fields), 'field of the refusal').toEqual(['addIcsFeed.url']);
      await expectFieldProblem(s, link, fields['addIcsFeed.url'], 'problem on the link');
      s.expect((await alexHost()).icsFeeds, 'feeds after refused links').toEqual([]);

      // A real feed with one busy hour on Tuesday.
      feedUrl = await s.setIcsFeed('alex-work', { events: [{ start: at('12:00'), end: at('13:00'), summary: 'Board call' }] });
      await other.getByLabel('Name').fill('Work');
      await link.fill(feedUrl);
      await other.getByRole('button', { name: 'Link calendar' }).click();
      await expectToast(alex, 'Calendar linked');
      await other.getByText('Work', { exact: true }).waitFor();
      const feeds = (await alexHost()).icsFeeds;
      s.expect(feeds, 'stored feeds').toMatchObject([{ label: 'Work' }]);
      // The address is a secret: sealed in the store, never sent back to any browser.
      s.expect(JSON.stringify(feeds).includes('mockcal'), 'the feed address is readable in the store').toBe(false);
      const token = new URL(inviteUrl).searchParams.get('t');
      s.expect((await s.visitor().request('GET', `/host/${hostId}`, { query: { t: token } })).text.includes('mockcal'), 'the feed address in the co-host answer').toBe(false);
      s.expect((await s.api('GET', '/admin/bootstrap')).text.includes('mockcal'), 'the feed address in the dashboard answer').toBe(false);
      s.expect(await link.inputValue(), 'the link box is empty again').toBe('');
      await clearToasts(alex);

      // The same feed twice is pointless.
      await link.fill(feedUrl);
      await other.getByRole('button', { name: 'Link calendar' }).click();
      await expectFieldProblem(s, link, 'That calendar is already linked.', 'problem on the link');
      await link.fill('');
      await s.screenshot(alex, 'co-host page fully set up');
    });

    await s.step('back in the dashboard the co-host shows as connected', async () => {
      await owner.reload();
      await owner.getByRole('heading', { name: 'Team', level: 1 }).waitFor();
      const row = owner.getByRole('listitem').filter({ hasText: CO_HOST.name });
      await row.getByText('Calendar connected').waitFor();
      await row.getByText(CO_HOST.email).first().waitFor();
      await row.getByText(/\(Dubai\)/).waitFor();
      s.expect(await row.getByText('Waiting for Alex').count(), 'the "waiting" note').toBe(0);
      await s.screenshot(owner, 'team with a connected co-host');
    });

    let joint = null;
    await s.step('"Create a joint meeting" makes a together event with both', async () => {
      const row = owner.getByRole('listitem').filter({ hasText: CO_HOST.name });
      await row.getByRole('button', { name: 'Create a joint meeting' }).click();
      await expectToast(owner, 'Joint meeting created');
      joint = (await s.kv('event-types')).find((e) => e.slug === 'jimi-and-alex');
      s.expect(joint, 'the joint event type').toMatchObject({ title: 'Meet Jimi and Alex', kind: 'collective', hostIds: ['host_owner', hostId], durations: [30], active: true, visibility: 'public' });
      await row.getByRole('link', { name: /Meet Jimi and Alex/ }).waitFor();
    });

    await s.step('the public page offers only times when both are free', async () => {
      // Jimi: London, 09:00 to 17:00, busy 10:00 to 11:00.  Alex: Dubai, 14:00 to 20:00 there (10:00 to 16:00 UTC),
      // busy 13:00 to 13:30 on the main calendar, 14:00 to 15:00 on Family, 12:00 to 13:00 on the linked feed.
      await s.setGoogleBusy(OWNER_GOOGLE, [{ start: at('10:00'), end: at('11:00') }]);
      await s.setGoogleBusy(CO_HOST.email, [
        { start: at('13:00'), end: at('13:30') },
        { start: at('14:00'), end: at('15:00'), calendarId: familyId },
      ]);
      // 30 minutes on a 30 minute grid, with 10 minutes kept free after each meeting.
      s.expect(await offered('jimi-and-alex'), 'Tuesday, both free').toEqual(['11:00', '15:00', '15:30']);
      await visitor.getByText('Jimi Cohen and Alex Rivera').first().waitFor();
      await s.screenshot(visitor, 'public page of the joint meeting');
      // On his own the owner has far more to offer: the limits really come from Alex.
      const alone = await offered('meeting');
      s.expect(alone.slice(0, 3), "the owner's own Tuesday starts").toEqual(['09:00', '11:00', '11:30']);
      s.expect(alone.length, "the owner's own Tuesday").toBeGreaterThan(10);
    });

    await s.step('unticking a calendar on the co-host page frees that time for visitors', async () => {
      const choices = alex.getByRole('region', { name: 'Your calendar' }).getByRole('group', { name: 'Keep me free when these calendars are busy' });
      const saved = alex.waitForResponse((r) => r.url().includes(`/api/host/${hostId}`) && r.request().method() === 'PUT' && r.status() === 200);
      await choices.getByRole('checkbox', { name: 'Family' }).click();
      await saved;
      await choices.getByRole('checkbox', { name: 'Family' }).and(alex.locator(':not(:checked)')).waitFor();
      s.expect((await alexHost()).google.busyCalendarIds, 'calendars that count').toEqual(['primary']);
      await s.setGoogleBusy(CO_HOST.email, [
        { start: at('13:00'), end: at('13:30') },
        { start: at('14:00'), end: at('15:00'), calendarId: familyId },
      ]);
      s.expect(await offered('jimi-and-alex'), 'Tuesday without the Family calendar').toEqual(['11:00', '13:30', '14:00', '14:30', '15:00', '15:30']);
    });

    await s.step('a booking of the joint meeting lands on both calendars', async () => {
      const booked = await s.book({ slug: 'jimi-and-alex', start: at('15:00'), durationMin: 30, name: 'Ada Lovelace', email: 'ada@example.com' });
      s.expect(booked.status, 'booking status').toBe(201);
      await s.settle();
      const [booking] = await s.bookings();
      s.expect(booking, 'the booking').toMatchObject({ kind: 'collective', hostIds: ['host_owner', hostId], google: { hostId: 'host_owner' } });
      const [insert] = await s.outbox({ kind: 'calendar_insert' });
      s.expect(insert.account, 'organiser of the calendar event').toBe(OWNER_GOOGLE);
      s.expect(insert.event.attendees.map((a) => a.email).sort(), 'people on the calendar event').toEqual(['ada@example.com', CO_HOST.email]);
      // The slot is gone for the next visitor.
      s.expect(await offered('jimi-and-alex'), 'Tuesday after the booking').toEqual(['11:00', '13:30', '14:00']);
    });

    await s.step('a new private link: the old one stops working at once', async () => {
      s.allowConsoleErrors(/status of 404/);
      const row = owner.getByRole('listitem').filter({ hasText: CO_HOST.name });
      await row.getByRole('button', { name: `More actions for ${CO_HOST.name}` }).click();
      await owner.getByRole('menuitem', { name: 'Make a new private link' }).click();
      await owner.getByRole('dialog', { name: 'Make a new link for Alex?' }).getByRole('button', { name: 'Make a new link' }).click();
      const fresh = owner.getByRole('dialog', { name: 'New private link for Alex' });
      const newUrl = await fresh.getByRole('textbox', { name: `Private link for ${CO_HOST.name}` }).inputValue();
      s.expect(newUrl, 'the new link').not.toBe(inviteUrl);
      s.expect(new URL(newUrl).pathname, 'the new link points at the same page').toBe(new URL(inviteUrl).pathname);
      await fresh.getByRole('button', { name: 'Done' }).click();

      const oldToken = new URL(inviteUrl).searchParams.get('t');
      s.expect((await s.visitor().request('GET', `/host/${hostId}`, { query: { t: oldToken } })).status, 'the old link through the API').toBe(404);
      await alex.reload();
      await alex.getByRole('heading', { name: 'This link does not work any more' }).waitFor();
      await alex.getByText('Ask the person who invited you to send a fresh link.').waitFor();
      await s.screenshot(alex, 'co-host page with an old link');
      await alex.goto(newUrl);
      await alex.getByRole('heading', { name: 'You are all set, Alex.', level: 1 }).waitFor();
      // Everything they set up is still there.
      await alex.getByRole('region', { name: 'Another calendar' }).getByText('Work', { exact: true }).waitFor();
      inviteUrl = newUrl;
    });

    await s.step("the owner corrects the co-host's details: problems land on their fields, good values are kept", async () => {
      s.allowConsoleErrors(/status of 422/);
      const row = owner.getByRole('listitem').filter({ hasText: CO_HOST.name });
      await row.getByRole('button', { name: `More actions for ${CO_HOST.name}` }).click();
      await owner.getByRole('menuitem', { name: 'Edit details' }).click();
      const dialog = owner.getByRole('dialog', { name: 'Edit details' });
      const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
      const title = dialog.getByLabel('Role or title');
      const email = dialog.getByLabel('Email');
      // It opens with what is stored, including the title the co-host gave themselves.
      s.expect([await name.inputValue(), await title.inputValue(), await email.inputValue()], 'what the dialog opens with').toEqual([CO_HOST.name, 'Co-founder', CO_HOST.email]);
      await name.fill('  ');
      await email.fill('alex-at-example');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expectFieldProblem(s, name, 'Please enter a name.', 'problem on the name');
      await expectFieldProblem(s, email, 'Please enter a full email address.', 'problem on the email');
      // The owner's own address is taken, whatever the capitals.
      const ownerEmail = (await s.kv('hosts')).find((h) => h.id === 'host_owner').email;
      s.expect(ownerEmail, "the owner's address, from Google").toBe(OWNER_GOOGLE);
      await name.fill(CO_HOST.name);
      await email.fill(ownerEmail.toUpperCase());
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expectFieldProblem(s, email, 'Someone with this email is already on the team.', 'problem on a taken email');
      s.expect(await alexHost(), 'co-host after the refused saves').toMatchObject({ name: CO_HOST.name, title: 'Co-founder', email: CO_HOST.email });

      // Texts about their bookings need a mobile number to go to.
      const mobile = dialog.getByLabel('Mobile number');
      const texts = dialog.getByRole('switch', { name: 'Text Alex about bookings' });
      s.expect(await texts.getAttribute('aria-checked'), 'texts to the co-host, out of the box').toBe('false');
      await dialog.getByText('New, moved and cancelled bookings, and any reminder texts set up for the hosts.').waitFor();
      await texts.click();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expectFieldProblem(s, mobile, 'Add a mobile number for the texts, or switch them off.', 'problem on the mobile number');
      await mobile.fill('+1 415 555 2690');

      await title.fill('Head of Partnerships');
      await email.fill('alex.rivera@example.com');
      // A photo for the booking pages, so Alex is not just initials next to the owner's photo.
      const photo = dialog.locator('.x-image').filter({ hasText: 'Photo' });
      const uploaded = owner.waitForResponse((r) => r.url().endsWith('/api/admin/assets') && r.request().method() === 'POST');
      await photo.locator('input[type="file"]').setInputFiles(pngFile('alex.png', 96, 96, [180, 120, 60]));
      const answer = await uploaded;
      s.expect(answer.status(), 'upload status of the photo').toBe(201);
      const photoId = (await answer.json()).id;
      await photo.locator('img').waitFor();
      // Nothing is stored until Save.
      s.expect((await alexHost()).avatarAssetId ?? null, 'photo before saving').toBeNull();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expectToast(owner, 'Details saved');
      await dialog.waitFor({ state: 'hidden' });
      s.expect(await row.locator('.tm-host__part').allTextContents(), 'the line under the name').toEqual(['Head of Partnerships', 'alex.rivera@example.com']);
      const stored = (await s.kv('hosts')).find((h) => h.id === hostId);
      s.expect(stored, 'the stored co-host').toMatchObject({ name: CO_HOST.name, title: 'Head of Partnerships', email: 'alex.rivera@example.com', phone: '+14155552690', notify: { email: true, sms: true }, avatarAssetId: photoId });
      s.expect(await row.locator('img').first().getAttribute('src'), 'the photo on the Team page').toBe(`/meeting/api/assets/${photoId}`);
      const { eventType: jointPage } = await s.apiOk('GET', '/public/event/jimi-and-alex');
      s.expect(jointPage.hosts.find((h) => h.name === CO_HOST.name)?.avatarUrl, 'the photo on the joint booking page').toBe(`/meeting/api/assets/${photoId}`);
      // Their calendar and their private link are untouched by it.
      s.expect(stored.google.email, 'their Google account').toBe(CO_HOST.email);
      s.expect((await s.visitor().request('GET', `/host/${hostId}`, { query: { t: new URL(inviteUrl).searchParams.get('t') } })).status, 'their private link').toBe(200);
      await clearToasts(owner);
    });

    await s.step("the owner disconnects the co-host's calendar: it stops counting, and the co-host can connect again from their link", async () => {
      const row = owner.getByRole('listitem').filter({ hasText: CO_HOST.name });
      await row.getByRole('button', { name: `More actions for ${CO_HOST.name}` }).click();
      await owner.getByRole('menuitem', { name: 'Disconnect their calendar' }).click();
      const confirm = owner.getByRole('dialog', { name: "Disconnect Alex's calendar?" });
      await confirm.getByText('They can connect again from their private link.').waitFor();
      await confirm.getByRole('button', { name: 'Disconnect' }).click();
      await expectToast(owner, "Alex's calendar was disconnected");
      // Google is gone; the feed they linked themselves is still theirs, and the card says which one is left.
      await row.getByText('Calendar feed linked').waitFor();
      // A feed can only be read: the card says plainly that meetings no longer reach Alex's calendar.
      await row.getByText("Work. Busy times are checked, but meetings are not added to Alex's calendar until Google Calendar is connected.").waitFor();
      s.expect(await row.getByText('Calendar connected').count(), '"Calendar connected" after the disconnect').toBe(0);
      const left = (await s.kv('hosts')).find((h) => h.id === hostId);
      s.expect(left.google, 'the stored connection').toBe(null);
      s.expect(left.icsFeeds.map((f) => f.label), 'feeds still linked').toEqual(['Work']);
      s.expect((await s.outbox({ kind: 'revoke' })).length, 'Google grants handed back').toBe(1);
      // With nothing to check, the 13:00 that Alex's calendar was blocking is offered. Their linked feed still counts.
      s.expect(await offered('jimi-and-alex'), 'Tuesday without the co-host calendar').toEqual(['11:00', '13:00', '13:30', '14:00']);
      // No calendar, so no option left in the menu.
      await row.getByRole('button', { name: `More actions for ${CO_HOST.name}` }).click();
      await owner.getByRole('menuitem', { name: 'Edit details' }).waitFor();
      s.expect(await owner.getByRole('menuitem', { name: 'Disconnect their calendar' }).count(), '"Disconnect" in the menu without a calendar').toBe(0);
      await owner.keyboard.press('Escape');
      await clearToasts(owner);

      // On their own page Google shows as not connected; the feed they linked still counts as a calendar.
      await alex.reload();
      await alex.getByRole('region', { name: 'Your calendar' }).getByText('Not connected').waitFor();
      await alex.getByRole('region', { name: 'Another calendar' }).getByText('Work', { exact: true }).waitFor();
      // Not "You are all set": with only a feed, booked meetings are not added to their calendar, and the page says so.
      await alex.getByRole('heading', { name: 'Your busy times are checked, Alex.', level: 1 }).waitFor();
      await alex.getByText(/a calendar feed can only be read, so meetings booked with you are not added to your calendar/).waitFor();
      // Joint meetings still reach them, by Google's invitation to the address on file: the page says where.
      await alex.getByText(/Their invitations go to [^\s]+@example\.com instead\./).waitFor();
      await alex.getByRole('region', { name: 'Your calendar' }).getByText(/meetings booked with you are not added to your calendar\. Connect Google Calendar to have them added\./).waitFor();
      const google = await s.connectGoogle(alex, CO_HOST.email, 'Africa/Nairobi');
      await alex.getByRole('button', { name: 'Connect Google Calendar' }).click();
      const result = await google.done();
      s.expect(result.status, `reconnect result (${result.reason ?? 'no reason'})`).toBe('connected');
      await alex.getByRole('region', { name: 'Your calendar' }).getByText('Connected', { exact: true }).waitFor();
      const again = (await s.kv('hosts')).find((h) => h.id === hostId);
      s.expect(again.google, 'the new connection').toMatchObject({ email: CO_HOST.email, status: 'ok', busyCalendarIds: ['primary'], writeCalendarId: 'primary' });
      // The zone they fixed by hand stays theirs, whatever Google says.
      s.expect([again.timezone, again.timezoneMode], 'their zone after reconnecting').toEqual(['Asia/Dubai', 'fixed']);
      await clearToasts(alex);
      await s.setGoogleBusy(CO_HOST.email, [{ start: at('13:00'), end: at('13:30') }]);
      s.expect(await offered('jimi-and-alex'), 'Tuesday with the calendar back').toEqual(['11:00', '13:30', '14:00']);
      await owner.reload();
      await owner.getByRole('listitem').filter({ hasText: CO_HOST.name }).getByText('Calendar connected').waitFor();
    });

    await s.step('the co-host picks another Google account, then disconnects it, from their own page', async () => {
      const calendar = alex.getByRole('region', { name: 'Your calendar' });
      // By id: the owner has changed Alex's email address by now.
      const stored = async () => (await s.kv('hosts')).find((h) => h.id === hostId);
      // The owner typed Alex's work address, so Google was hinted at that one. Alex wants their personal account.
      const personal = 'alex.personal@example.com';
      const google = await s.connectGoogle(alex, personal, 'Asia/Dubai');
      await calendar.getByRole('button', { name: 'Use a different Google account' }).click();
      const result = await google.done();
      s.expect(result.status, `switch result (${result.reason ?? 'no reason'})`).toBe('connected');
      s.expect(result.request, 'what was asked of Google').toMatchObject({ accountChooser: true, loginHint: null });
      await calendar.getByText(`Connected as ${personal}`).waitFor();
      s.expect((await stored()).google, 'the connection now').toMatchObject({ email: personal, status: 'ok' });
      await clearToasts(alex);

      await calendar.getByRole('button', { name: 'Disconnect' }).click();
      const confirm = alex.getByRole('dialog', { name: 'Disconnect Google Calendar?' });
      await confirm.getByText(`Your busy times in ${personal} will no longer be checked`, { exact: false }).waitFor();
      await confirm.getByRole('button', { name: 'Disconnect' }).click();
      await expectToast(alex, 'Google Calendar is disconnected');
      await calendar.getByText('Not connected').waitFor();
      await calendar.getByRole('button', { name: 'Connect Google Calendar' }).waitFor();
      const after = await stored();
      s.expect(after.google, 'the stored connection after disconnecting').toBe(null);
      s.expect(after.icsFeeds.map((f) => f.label), 'their feed is kept').toEqual(['Work']);
      // A zone they fixed by hand is theirs to keep.
      s.expect([after.timezone, after.timezoneMode], 'their zone after disconnecting').toEqual(['Asia/Dubai', 'fixed']);
      // The owner's Team page agrees.
      await owner.reload();
      await owner.getByRole('listitem').filter({ hasText: CO_HOST.name }).getByText('Calendar feed linked').waitFor();
      await clearToasts(alex);
    });

    await s.step('removing the co-host is refused while an event type uses them', async () => {
      s.allowConsoleErrors(/status of 409/);
      const row = owner.getByRole('listitem').filter({ hasText: CO_HOST.name });
      await row.getByRole('button', { name: `More actions for ${CO_HOST.name}` }).click();
      await owner.getByRole('menuitem', { name: 'Remove from team' }).click();
      const dialog = owner.getByRole('dialog', { name: `Remove ${CO_HOST.name}?` });
      await dialog.getByRole('button', { name: 'Remove from team' }).click();
      const toast = await expectToast(owner, 'Alex was not removed');
      s.expect(await toast.textContent(), 'the reason').toContain('Alex Rivera still hosts "Meet Jimi and Alex". Remove them from that event type first.');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      s.expect((await s.kv('hosts')).length, 'hosts after the refused removal').toBe(2);
      await clearToasts(owner);
    });

    await s.step('once no event type uses them, they can be removed and their link dies', async () => {
      s.allowConsoleErrors(/status of 404/);
      await s.apiOk('PUT', `/admin/event-types/${joint.id}`, { body: { kind: 'solo', hostIds: ['host_owner'] } });
      await owner.reload();
      const row = owner.getByRole('listitem').filter({ hasText: CO_HOST.name });
      await row.getByRole('button', { name: `More actions for ${CO_HOST.name}` }).click();
      await owner.getByRole('menuitem', { name: 'Remove from team' }).click();
      await owner.getByRole('dialog', { name: `Remove ${CO_HOST.name}?` }).getByRole('button', { name: 'Remove from team' }).click();
      await expectToast(owner, `${CO_HOST.name} was removed`);
      await owner.getByRole('heading', { name: CO_HOST.name, level: 2 }).waitFor({ state: 'detached' });
      s.expect((await s.kv('hosts')).map((h) => h.id), 'hosts left').toEqual(['host_owner']);
      // Their Google grant was handed back (the second time: once at the disconnect above), and their page is gone.
      s.expect((await s.outbox({ kind: 'revoke' })).length, 'Google grants handed back').toBe(2);
      const token = new URL(inviteUrl).searchParams.get('t');
      s.expect((await s.visitor().request('GET', `/host/${hostId}`, { query: { t: token } })).status, 'the link of a removed co-host').toBe(404);
      await alex.reload();
      await alex.getByRole('heading', { name: 'This link does not work any more' }).waitFor();
    });
  });

  await t.scenario('a joint meeting whose hours never meet: said when it is made, in the editor and on Home, and the public page promises nothing', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    // Jimi in Los Angeles, Alex in Berlin, both on the 9 to 5 every co-host starts with: nine hours apart, never both at work.
    await s.setupAdmin({ timezone: 'America/Los_Angeles' });
    await s.apiOk('PUT', '/admin/hosts/host_owner', { body: { email: OWNER_GOOGLE } });
    const { host, inviteUrl } = await s.apiOk('POST', '/admin/hosts', { body: CO_HOST });
    const owner = await s.newPage({ signedIn: true, timezoneId: 'America/Los_Angeles', viewport: { width: 1440, height: 900 } });
    const alex = await s.newPage({ timezoneId: 'Europe/Berlin', viewport: { width: 1280, height: 900 }, ip: '10.99.0.8' });
    let joint = null;

    await s.step('the co-host opens their link in Berlin, and adds a number for texts about bookings', async () => {
      await alex.goto(inviteUrl);
      await alex.getByRole('heading', { name: 'Hi Alex. One step to go.', level: 1 }).waitFor();
      await s.eventually(async () => s.expect((await s.kv('hosts')).find((h) => h.id === host.id).timezone, 'co-host zone').toBe('Europe/Berlin'));
      await clearToasts(alex);
      const details = alex.getByRole('region', { name: 'Your details' });
      const texts = details.getByRole('switch', { name: 'Text me about bookings' });
      s.expect(await texts.isDisabled(), 'texts before a number is saved').toBe(true);
      await details.getByText(/Save your mobile number above first\.$/).waitFor();
      await details.getByLabel('Mobile number').fill('+49 151 1234 5678');
      await details.getByRole('button', { name: 'Save details' }).click();
      await expectToast(alex, 'Saved');
      await texts.click();
      await s.eventually(async () => s.expect((await s.kv('hosts')).find((h) => h.id === host.id), 'co-host contact details').toMatchObject({ phone: '+4915112345678', notify: { email: true, sms: true } }));
      await s.eventually(async () => s.expect(await texts.getAttribute('aria-checked'), 'texts once switched on').toBe('true'));
      await details.getByText('New, moved and cancelled meetings, and any reminder texts Jimi set up for the hosts, sent to +4915112345678.').waitFor();
    });

    await s.step('"Create a joint meeting" says straight away that nobody can book it, and why', async () => {
      await owner.goto(s.url('/admin/team'));
      await owner.getByRole('heading', { name: 'Team', level: 1 }).waitFor();
      const row = owner.getByRole('listitem').filter({ hasText: CO_HOST.name });
      await row.getByRole('button', { name: 'Create a joint meeting' }).click();
      const toast = await expectToast(owner, 'Joint meeting created, but nobody can book it yet');
      const said = await toast.textContent();
      s.expect(said, 'why').toContain('"Meet Jimi and Alex" cannot be booked: there is no time when you and Alex are both working.');
      s.expect(said, 'the two zones').toContain("Your hours are in Los Angeles time and Alex's hours are in Berlin time.");
      s.expect(said, 'no long dashes').not.toContain('—');
      joint = (await s.kv('event-types')).find((e) => e.slug === 'jimi-and-alex');
      s.expect(joint, 'the joint event type').toMatchObject({ kind: 'collective', hostIds: ['host_owner', host.id] });
      await clearToasts(owner);
    });

    await s.step('Home says so too, and links to where it is fixed', async () => {
      await owner.goto(s.url('/admin'));
      const warning = owner.locator('.adm-home__warnings .adm-notice').filter({ hasText: '"Meet Jimi and Alex" cannot be booked' });
      await warning.waitFor();
      s.expect(await warning.getByRole('link', { name: 'Fix this' }).getAttribute('href'), 'where it is fixed').toBe('/meeting/admin/availability');
      const { warnings } = await s.apiOk('GET', '/admin/overview');
      s.expect(warnings.map((w) => w.key), 'warnings on Home').toContain(`shared_hours_${joint.id}`);
    });

    await s.step('the editor shows it on the Hosts tab, and only for a together meeting', async () => {
      await owner.goto(s.url(`/admin/event-types/${joint.id}?tab=hosts`));
      const panel = owner.getByRole('tabpanel');
      const notice = panel.locator('.adm-notice').filter({ hasText: 'Nobody can book this meeting' });
      await notice.getByText(/there is no time when you and Alex are both working/).waitFor();
      await panel.getByRole('radio', { name: /^Round robin/ }).check();
      await notice.waitFor({ state: 'detached' });
      await panel.getByRole('radio', { name: /^Together/ }).check();
      await notice.waitFor();
      await s.screenshot(owner, 'joint meeting whose hours never meet');
    });

    const CHECK = (url) => url.pathname.endsWith('/api/admin/event-types-check');
    await s.step('the Scheduling tab shows it too, drops it the moment an edit there starts a new check, and asks again', async () => {
      await owner.getByRole('tab', { name: /^Scheduling/ }).click();
      await owner.getByRole('tab', { name: /^Scheduling/, selected: true }).waitFor();
      const panel = owner.getByRole('tabpanel');
      const notice = panel.locator('.adm-notice').filter({ hasText: 'Nobody can book this meeting' });
      await notice.getByText(/there is no time when you and Alex are both working/).waitFor();
      s.expect(await notice.textContent(), 'before the event has limited hours').not.toContain('limited hours');
      // The next check is held back until the test lets it go, so what is on screen meanwhile can be read.
      let release = () => undefined;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      await owner.route(CHECK, async (route) => {
        await held;
        await route.continue();
      }, { times: 1 });
      const asked = owner.waitForRequest((r) => CHECK(new URL(r.url())));
      await panel.getByRole('switch', { name: 'Only offer this event during certain hours' }).click();
      // The answer about the hours as they were says nothing about the hours as they are: it goes at once.
      await notice.waitFor({ state: 'detached' });
      const body = (await asked).postDataJSON();
      s.expect(body.scheduling.restrictHours, 'the limited hours, sent with the check').toBeTruthy();
      release();
      await notice.getByText(/The limited hours on its Scheduling tab count too\./).waitFor();
      await notice.scrollIntoViewIfNeeded();
      await s.screenshot(owner, 'joint meeting hours on the Scheduling tab', { fullPage: false });
    });

    await s.step('a check that cannot run says so quietly, on both tabs, and saving still works', async () => {
      s.allowConsoleErrors(/status of 500/);
      await owner.route(CHECK, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'server_error', message: 'Something went wrong on our side.' } }) }));
      const panel = owner.getByRole('tabpanel');
      const notice = panel.locator('.adm-notice').filter({ hasText: 'Nobody can book this meeting' });
      const quiet = panel.getByText("Could not check whether the hosts' working hours meet.");
      await panel.getByRole('switch', { name: 'Only offer this event during certain hours' }).click();
      await quiet.waitFor();
      s.expect(await notice.count(), 'an earlier answer left on screen').toBe(0);
      await owner.getByRole('tab', { name: /^Hosts/ }).click();
      await owner.getByRole('tab', { name: /^Hosts/, selected: true }).waitFor();
      await quiet.waitFor();
      s.expect(await notice.count(), 'an earlier answer on the Hosts tab').toBe(0);
      // Saving does not wait for the check, or care that it failed.
      await owner.getByRole('tab', { name: /^Scheduling/ }).click();
      await panel.getByLabel('Buffer before').selectOption({ label: '15 minutes' });
      await saveAndWait(owner, 'Save changes');
      s.expect((await s.kv('event-types')).find((e) => e.id === joint.id).scheduling, 'saved').toMatchObject({ bufferBeforeMin: 15, restrictHours: null });
      await owner.unroute(CHECK);
    });

    await s.step('the public page does not tell visitors to come back for times that will never open', async () => {
      const visitor = await s.newPage({ timezoneId: 'UTC' });
      await visitor.goto(s.url('/jimi-and-alex'));
      await visitor.getByRole('heading', { name: 'No open times right now' }).waitFor();
      await visitor.getByText('There is no time in the next 60 days when Jimi Cohen and Alex Rivera are both free. If someone sent you this link, let them know.').waitFor();
      s.expect(await visitor.getByText(/check back soon/).count(), 'a promise of new times').toBe(0);
    });
  });
});
