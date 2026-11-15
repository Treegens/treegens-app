/**
 * The dashboard's front door and the owner's automatic time zone, in a real browser against
 * the real backend: first-run setup, sign out, sign in, change password, and the three ways
 * the owner's zone is kept (this device, Google Calendar, fixed).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PASSWORD, SETUP_CODE, defineSuite } from './lib.mjs';
import { MONDAY, clearToasts, expectFieldProblem, expectToast, fieldProblem, openPage, timesOn, toasts } from './admin-helpers.mjs';

const NEW_PASSWORD = 'a much better passphrase';
const OWNER_GOOGLE = 'jimi@example.com';

export default defineSuite('admin-auth', { mockCreds: true }, async (t) => {
  await t.scenario('first run: setup, sign out, sign in, change password', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    // Chosen at random when the dashboard is set up; every password change adds one.
    let firstVersion = 0;
    // Refusals are part of this story: wrong code (403), a second setup (409), wrong passwords (401, 403), an ended session (401).
    s.allowConsoleErrors(/status of 40[139]/, /status of 422/);
    const page = await s.newPage({ timezoneId: 'Europe/Berlin' });
    const late = await s.newPage({ timezoneId: 'Europe/Berlin' });

    await s.step('the dashboard opens on the setup screen', async () => {
      s.expect((await s.api('GET', '/auth/state')).data, 'auth state on a fresh site').toEqual({ setupRequired: true, authenticated: false });
      await page.goto(s.url('/admin'));
      await page.getByRole('heading', { name: 'Set up your dashboard', level: 1 }).waitFor();
      await page.getByText('Central European Time (Berlin)').waitFor();
      // A second tab that is still looking at the setup screen when the first one finishes.
      await late.goto(s.url('/admin/bookings'));
      await late.getByRole('heading', { name: 'Set up your dashboard', level: 1 }).waitFor();
    });

    await s.step('a wrong setup code is reported on the code field', async () => {
      await page.getByLabel('Setup code').fill('not-the-code');
      await page.getByLabel('New password').fill(DEFAULT_PASSWORD);
      await page.getByLabel('Repeat password').fill(DEFAULT_PASSWORD);
      await page.getByRole('button', { name: 'Create my dashboard' }).click();
      await expectFieldProblem(s, page.getByLabel('Setup code'), 'That setup code is not right.', 'problem on the code field');
      s.expect(await fieldProblem(page.getByLabel('New password')), 'problem on the password field').toBe('');
      s.expect((await s.api('GET', '/auth/state')).data.setupRequired, 'still not set up').toBe(true);
    });

    await s.step('a short password is reported on the password field, by the page and by the server', async () => {
      await page.getByLabel('Setup code').fill(SETUP_CODE);
      await page.getByLabel('New password').fill('too short');
      await page.getByLabel('Repeat password').fill('too short');
      await page.getByRole('button', { name: 'Create my dashboard' }).click();
      await expectFieldProblem(s, page.getByLabel('New password'), 'Use at least 10 characters.', 'problem on the password field');
      s.expect(await fieldProblem(page.getByLabel('Setup code')), 'problem on the code field').toBe('');
      // Two passwords that differ land on the repeat field.
      await page.getByLabel('New password').fill(DEFAULT_PASSWORD);
      await page.getByLabel('Repeat password').fill(`${DEFAULT_PASSWORD}!`);
      await page.getByRole('button', { name: 'Create my dashboard' }).click();
      await expectFieldProblem(s, page.getByLabel('Repeat password'), 'The two passwords do not match.', 'problem on the repeat field');
      // The server says the same thing with the same field key when the page is bypassed.
      const direct = await s.visitor().request('POST', '/auth/setup', { body: { code: SETUP_CODE, password: 'too short' } });
      s.expect(direct.status, 'status for a short password').toBe(422);
      s.expect(direct.data.error.fields, 'fields for a short password').toEqual({ password: 'Use at least 10 characters.' });
      s.expect((await s.api('GET', '/auth/state')).data.setupRequired, 'still not set up').toBe(true);
    });

    await s.step('the right code signs in and shows the checklist', async () => {
      await page.getByLabel('Repeat password').fill(DEFAULT_PASSWORD);
      // Optional: where booking notices go, asked for here so they arrive from the first booking on.
      await page.getByLabel('Your email').fill('jimi-at-home');
      await page.getByRole('button', { name: 'Create my dashboard' }).click();
      await expectFieldProblem(s, page.getByLabel('Your email'), 'Please enter a full email address, or leave this empty.', 'problem on the email field');
      await page.getByLabel('Your email').fill('jimi@jimicohen.com');
      await page.getByRole('button', { name: 'Create my dashboard' }).click();
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Jimi$/, level: 1 }).waitFor();
      const checklist = page.getByRole('region', { name: 'Finish setting up' });
      await checklist.getByRole('link', { name: 'Connect your Google Calendar' }).waitFor();
      await checklist.getByText('Set your weekly hours').waitFor();
      await checklist.getByRole('progressbar', { name: 'Setup progress' }).waitFor();
      s.expect(new URL(page.url()).pathname, 'address after setup').toBe('/meeting/admin');
      // Stored: an admin record, and the owner in the zone of the device that ran the setup.
      firstVersion = (await s.kv('auth/admin')).passwordVersion;
      s.expect(Number.isInteger(firstVersion) && firstVersion >= 1, `password version (${firstVersion})`).toBe(true);
      s.expect((await s.kv('hosts'))[0], 'owner host').toMatchObject({ id: 'host_owner', role: 'owner', timezone: 'Europe/Berlin', timezoneMode: 'device', email: 'jimi@jimicohen.com' });
      const cookies = await page.context().cookies();
      s.expect(cookies.find((c) => c.name === 'mtg_session'), 'session cookie').toMatchObject({ httpOnly: true, path: '/meeting', sameSite: 'Lax' });
      // A reload keeps the session.
      await page.reload();
      await page.getByRole('region', { name: 'Finish setting up' }).waitFor();
    });

    await s.step('a second setup is refused, in the other tab and through the API', async () => {
      await late.getByLabel('Setup code').fill(SETUP_CODE);
      await late.getByLabel('New password').fill('somebody else was here');
      await late.getByLabel('Repeat password').fill('somebody else was here');
      await late.getByRole('button', { name: 'Create my dashboard' }).click();
      await late.getByRole('alert').filter({ hasText: 'This dashboard is already set up. Please sign in with your password.' }).waitFor();
      const direct = await s.visitor().request('POST', '/auth/setup', { body: { code: SETUP_CODE, password: 'somebody else was here' } });
      s.expect(direct.status, 'status of a second setup').toBe(409);
      s.expect(direct.data.error.code, 'error code of a second setup').toBe('already_set_up');
      s.expect((await s.kv('auth/admin')).passwordVersion, 'password version is untouched').toBe(firstVersion);
      // The notice offers the way out.
      await late.getByRole('button', { name: 'Go to sign in' }).click();
      await late.getByRole('heading', { name: 'Sign in', level: 1 }).waitFor();
    });

    await s.step('sign out', async () => {
      await page.getByRole('complementary', { name: 'Dashboard' }).getByRole('button', { name: /Jimi Cohen/ }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();
      await page.getByRole('heading', { name: 'Sign in', level: 1 }).waitFor();
      await expectToast(page, 'You are signed out');
      s.expect((await page.context().cookies()).filter((c) => c.name === 'mtg_session'), 'session cookie after signing out').toEqual([]);
      // Nothing of the dashboard is served without the session.
      const bootstrap = await page.evaluate(async () => (await fetch('/meeting/api/admin/bootstrap')).status);
      s.expect(bootstrap, 'bootstrap status when signed out').toBe(401);
    });

    await s.step('sign in: a wrong password is refused on the field, the right one keeps the deep link', async () => {
      await page.goto(s.url('/admin/event-types/evt_intro?tab=scheduling'));
      await page.getByRole('heading', { name: 'Sign in', level: 1 }).waitFor();
      await page.getByLabel('Password', { exact: true }).fill('not my password');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expectFieldProblem(s, page.getByLabel('Password', { exact: true }), 'That password is not right. Please try again.', 'problem on the password field');
      await page.getByLabel('Password', { exact: true }).fill(DEFAULT_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      const url = new URL(page.url());
      s.expect(url.pathname + url.search, 'address after signing in').toBe('/meeting/admin/event-types/evt_intro?tab=scheduling');
      await page.getByRole('tab', { name: 'Scheduling', selected: true }).waitFor();
    });

    await s.step('the other tab signs in too', async () => {
      await late.getByLabel('Password', { exact: true }).fill(DEFAULT_PASSWORD);
      await late.getByRole('button', { name: 'Sign in' }).click();
      // It was opened on the bookings page, and that is where it lands.
      await late.getByRole('heading', { name: 'Bookings', level: 1 }).waitFor();
    });

    await s.step('change password: problems land on their fields', async () => {
      await openPage(page, 'Settings');
      const form = page.locator('form.st-password');
      await form.getByLabel('Current password').fill('not my password');
      await form.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
      await form.getByLabel('New password, once more').fill(NEW_PASSWORD);
      await form.getByRole('button', { name: 'Change password' }).click();
      await expectFieldProblem(s, form.getByLabel('Current password'), 'That is not your current password.', 'problem on the current password');
      s.expect((await s.kv('auth/admin')).passwordVersion, 'password version after a refused change').toBe(firstVersion);
      await form.getByLabel('Current password').fill(DEFAULT_PASSWORD);
      await form.getByLabel('New password, once more').fill(`${NEW_PASSWORD}?`);
      await form.getByRole('button', { name: 'Change password' }).click();
      await expectFieldProblem(s, form.getByLabel('New password, once more'), 'The two new passwords do not match.', 'problem on the repeated password');
    });

    await s.step('change password: this session stays in, the other one is signed out', async () => {
      const form = page.locator('form.st-password');
      await form.getByLabel('New password, once more').fill(NEW_PASSWORD);
      await form.getByRole('button', { name: 'Change password' }).click();
      await expectToast(page, 'Password changed');
      s.expect((await s.kv('auth/admin')).passwordVersion, 'password version').toBe(firstVersion + 1);
      s.expect(await form.getByLabel('Current password').inputValue(), 'current password field after the change').toBe('');

      // This browser carries on: a reload still shows the dashboard.
      await page.reload();
      await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();

      // The other browser is asked to sign in again at its next step, and keeps its place.
      await late.getByRole('tab', { name: /Past/ }).click();
      await late.getByRole('heading', { name: 'Sign in', level: 1 }).waitFor();
      await expectToast(late, 'Your session has ended');
      await late.getByLabel('Password', { exact: true }).fill(DEFAULT_PASSWORD);
      await late.getByRole('button', { name: 'Sign in' }).click();
      await expectFieldProblem(s, late.getByLabel('Password', { exact: true }), 'That password is not right.', 'the old password no longer works');
      await late.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
      await late.getByRole('button', { name: 'Sign in' }).click();
      await late.getByRole('heading', { name: 'Bookings', level: 1 }).waitFor();
    });
  });

  await t.scenario('forgot your password: a new setup code replaces it and signs the other devices out', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    // A used code (409), the old password (401) and the ended session of the other browser (401) are part of this story.
    s.allowConsoleErrors(/status of 40[19]/);
    await s.setupAdmin();
    const setUpVersion = (await s.kv('auth/admin')).passwordVersion;
    const other = await s.newPage({ signedIn: true });
    await other.goto(s.url('/admin/bookings'));
    await other.getByRole('heading', { name: 'Bookings', level: 1 }).waitFor();
    const page = await s.newPage({ ip: '10.250.1.1' });

    await s.step('the sign-in screen offers a way back in', async () => {
      await page.goto(s.url('/admin'));
      await page.getByRole('heading', { name: 'Sign in', level: 1 }).waitFor();
      await page.getByRole('button', { name: 'Forgot your password?' }).click();
      await page.getByRole('heading', { name: 'Choose a new password', level: 1 }).waitFor();
      const steps = page.getByRole('note').filter({ hasText: 'First, give this site a new setup code' });
      await steps.getByText('MEETING_SETUP_CODE_HASH').waitFor();
      s.expect(await steps.locator('li').count(), 'steps on screen').toBe(3);
      s.expect(await page.getByLabel('Your email').count(), 'no email field when resetting').toBe(0);
      await s.screenshot(page, 'forgot password');
      await page.getByRole('button', { name: 'Back to sign in' }).click();
      await page.getByRole('heading', { name: 'Sign in', level: 1 }).waitFor();
      await page.getByRole('button', { name: 'Forgot your password?' }).click();
      await page.getByRole('heading', { name: 'Choose a new password', level: 1 }).waitFor();
    });

    await s.step('the code that set the password does not work again', async () => {
      await page.getByLabel('New setup code').fill(SETUP_CODE);
      await page.getByLabel('New password').fill(NEW_PASSWORD);
      await page.getByLabel('Repeat password').fill(NEW_PASSWORD);
      await page.getByRole('button', { name: 'Save my new password' }).click();
      await page.getByRole('alert').filter({ hasText: 'This setup code was already used. Deploy the hash of a new code first, then try again.' }).waitFor();
      s.expect((await s.kv('auth/admin')).passwordVersion, 'password version').toBe(setUpVersion);
    });

    await s.step('after a new code is deployed, it sets the new password', async () => {
      // As if MEETING_SETUP_CODE_HASH had been changed and the site deployed again: the record now says an
      // older code set the password, so the code this server has deployed is a new one.
      const file = path.join(s.server.dataDir, `${encodeURIComponent('auth/admin')}.json`);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...record, setupCodeHash: createHash('sha256').update('the code from before').digest('hex') }));

      await page.getByRole('button', { name: 'Save my new password' }).click();
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Jimi$/, level: 1 }).waitFor();
      s.expect((await s.kv('auth/admin')).passwordVersion, 'password version').toBe(setUpVersion + 1);
      const cookies = await page.context().cookies();
      s.expect(cookies.find((c) => c.name === 'mtg_device'), 'device cookie').toMatchObject({ httpOnly: true, path: '/meeting', sameSite: 'Lax' });
    });

    await s.step('the other browser is signed out, and only the new password works', async () => {
      await other.getByRole('tab', { name: /Past/ }).click();
      await other.getByRole('heading', { name: 'Sign in', level: 1 }).waitFor();
      s.expect((await s.visitor().request('POST', '/auth/login', { body: { password: DEFAULT_PASSWORD } })).status, 'old password').toBe(401);
      s.expect((await s.visitor().request('POST', '/auth/login', { body: { password: NEW_PASSWORD } })).status, 'new password').toBe(200);
    });
  });

  await t.scenario('the owner time zone follows the device, then Google Calendar, then stays fixed', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'UTC' });
    /** What a visitor is offered on Tuesday, as wall times in a zone. */
    const tuesdayIn = async (zone) => timesOn(await s.slots({ slug: 'intro', duration: 15, from: '2026-11-16T12:00:00.000Z', to: '2026-11-19T00:00:00.000Z' }), '2026-11-17', zone);
    const ownerZone = async () => {
      const [owner] = await s.kv('hosts');
      return { timezone: owner.timezone, timezoneMode: owner.timezoneMode };
    };

    await s.step('set up in UTC: Tuesday starts at 09:00 UTC', async () => {
      s.expect(await ownerZone(), 'owner zone').toEqual({ timezone: 'UTC', timezoneMode: 'device' });
      const times = await tuesdayIn('UTC');
      s.expect(times[0], 'first time on Tuesday (UTC)').toBe('09:00');
      s.expect(times.at(-1), 'last time on Tuesday (UTC)').toBe('16:45');
    });

    const berlin = await s.newPage({ signedIn: true, timezoneId: 'Europe/Berlin' });
    await s.step('opened in Berlin: the zone follows, with a toast', async () => {
      await berlin.goto(s.url('/admin'));
      await expectToast(berlin, 'Your time zone is now Central European Time (Berlin)');
      s.expect(await ownerZone(), 'owner zone').toEqual({ timezone: 'Europe/Berlin', timezoneMode: 'device' });
      await berlin.getByText('Times here are in Central European Time (Berlin).').waitFor();
      await openPage(berlin, 'Availability');
      const zone = berlin.getByRole('region', { name: 'Your time zone' });
      await zone.getByText('Central European Time (Berlin)').first().waitFor();
      await zone.getByRole('radio', { name: 'Follow this device' }).and(berlin.locator(':checked')).waitFor();
      // 09:00 UTC on the frozen clock is 10:00 in Berlin.
      await zone.getByText(/10:00 AM right now · (GMT|UTC)\+1/).waitFor();
      await berlin.getByText('Times are in Central European Time (Berlin)').waitFor();
      await s.screenshot(berlin, 'availability in berlin');
    });

    await s.step('the public slots moved to Berlin hours', async () => {
      const times = await tuesdayIn('Europe/Berlin');
      s.expect(times[0], 'first time on Tuesday (Berlin)').toBe('09:00');
      s.expect(times.at(-1), 'last time on Tuesday (Berlin)').toBe('16:45');
      s.expect((await tuesdayIn('UTC'))[0], 'the same first time in UTC').toBe('08:00');
    });

    await s.step('a reload in the same zone changes nothing and stays quiet', async () => {
      const before = (await s.kv('hosts'))[0].updatedAt;
      await berlin.reload();
      await berlin.getByRole('heading', { name: 'Availability', level: 1 }).waitFor();
      await s.settle();
      await berlin.waitForLoadState('networkidle');
      s.expect(await toasts(berlin).count(), 'toasts after a reload in the same zone').toBe(0);
      s.expect((await s.kv('hosts'))[0].updatedAt, 'owner record untouched').toBe(before);
    });

    const newYork = await s.newPage({ signedIn: true, timezoneId: 'America/New_York' });
    await s.step('opened in New York: the zone follows again', async () => {
      await newYork.goto(s.url('/admin/availability'));
      await expectToast(newYork, 'Your time zone is now Eastern Time (New York)');
      s.expect(await ownerZone(), 'owner zone').toEqual({ timezone: 'America/New_York', timezoneMode: 'device' });
      const zone = newYork.getByRole('region', { name: 'Your time zone' });
      await zone.getByText('Eastern Time (New York)').first().waitFor();
      await zone.getByText(/4:00 AM right now · (GMT|UTC)-5/).waitFor();
      const times = await tuesdayIn('America/New_York');
      s.expect(times[0], 'first time on Tuesday (New York)').toBe('09:00');
      s.expect((await tuesdayIn('UTC'))[0], 'the same first time in UTC').toBe('14:00');
    });

    await s.step('connecting Google Calendar switches to its zone (Nairobi)', async () => {
      await openPage(newYork, 'Integrations');
      const google = await s.connectGoogle(newYork, OWNER_GOOGLE, 'Africa/Nairobi');
      await newYork.getByRole('button', { name: 'Connect Google Calendar' }).click();
      const result = await google.done();
      s.expect(result.status, `google connect result (${result.reason ?? 'no reason'})`).toBe('connected');
      await newYork.getByText(`Connected as ${OWNER_GOOGLE}`).waitFor();
      s.expect(await ownerZone(), 'owner zone').toEqual({ timezone: 'Africa/Nairobi', timezoneMode: 'google' });
      // Every hour offered just moved by eight hours: the page says so, it does not happen in silence.
      s.expect(new URL(result.url).searchParams.get('zone'), 'zone reported by the return from Google').toBe('Africa/Nairobi');
      await expectToast(newYork, 'Your time zone is now East Africa Time (Nairobi)');
      await openPage(newYork, 'Availability');
      const zone = newYork.getByRole('region', { name: 'Your time zone' });
      await zone.getByText('East Africa Time (Nairobi)').first().waitFor();
      await zone.getByRole('radio', { name: 'Follow Google Calendar' }).and(newYork.locator(':checked')).waitFor();
      // And while this device is elsewhere, Availability keeps saying it, with a way back to the device.
      await zone.getByText(/This device is in Eastern Time \(New York\)\. Your hours follow Google Calendar: East Africa Time \(Nairobi\)\./).waitFor();
      await zone.getByRole('button', { name: 'Follow this device instead' }).waitFor();
      const times = await tuesdayIn('Africa/Nairobi');
      s.expect(times[0], 'first time on Tuesday (Nairobi)').toBe('09:00');
      s.expect((await tuesdayIn('UTC'))[0], 'the same first time in UTC').toBe('06:00');
      await s.screenshot(newYork, 'availability following google');
    });

    await s.step('the device no longer moves it: Berlin opens the dashboard, Nairobi stays', async () => {
      await clearToasts(berlin);
      await berlin.goto(s.url('/admin/availability'));
      const zone = berlin.getByRole('region', { name: 'Your time zone' });
      await zone.getByText('East Africa Time (Nairobi)').first().waitFor();
      await berlin.waitForLoadState('networkidle');
      s.expect(await ownerZone(), 'owner zone').toEqual({ timezone: 'Africa/Nairobi', timezoneMode: 'google' });
      s.expect(await toasts(berlin).count(), 'toasts in Berlin').toBe(0);
      s.expect((await tuesdayIn('UTC'))[0], 'first time on Tuesday in UTC').toBe('06:00');
    });

    await s.step('Google Calendar moves to Tokyo: the next scheduled run follows', async () => {
      await s.setGoogleAccount(OWNER_GOOGLE, { timezone: 'Asia/Tokyo' });
      await s.advanceClock({ minutes: 31 });
      await s.runJobs();
      s.expect(await ownerZone(), 'owner zone').toEqual({ timezone: 'Asia/Tokyo', timezoneMode: 'google' });
      await berlin.reload();
      await berlin.getByRole('region', { name: 'Your time zone' }).getByText('Japan Standard Time (Tokyo)').first().waitFor();
    });

    await s.step('a fixed zone: chosen once, kept whatever the device or Google say', async () => {
      const zone = berlin.getByRole('region', { name: 'Your time zone' });
      // The choice is saved at once, and the radio moves when the server has answered.
      await zone.getByRole('radio', { name: 'Keep it fixed' }).click();
      await expectToast(berlin, 'Time zone fixed to Japan Standard Time (Tokyo)');
      await zone.getByRole('radio', { name: 'Keep it fixed' }).and(berlin.locator(':checked')).waitFor();
      s.expect(await ownerZone(), 'owner zone').toEqual({ timezone: 'Asia/Tokyo', timezoneMode: 'fixed' });
      await zone.getByRole('button', { name: /^Time zone: Japan Standard Time \(Tokyo\)\. Change$/ }).click();
      const dialog = berlin.getByRole('dialog', { name: 'Choose a time zone' });
      await dialog.getByRole('combobox', { name: 'Search time zones' }).fill('kolkata');
      await dialog.getByRole('option', { name: /Kolkata/ }).first().click();
      await expectToast(berlin, /Time zone set to India Standard Time \(Kolkata\)/);
      // Chromium lists this zone under its older name, Asia/Calcutta. Both names are the same zone everywhere.
      s.expect(await ownerZone(), 'owner zone').toMatchObject({ timezone: /^Asia\/(Kolkata|Calcutta)$/, timezoneMode: 'fixed' });
      await zone.getByText('India Standard Time (Kolkata)').first().waitFor();
      // 09:00 in Kolkata is 03:30 UTC.
      s.expect((await tuesdayIn('UTC'))[0], 'first time on Tuesday in UTC').toBe('03:30');

      // Another device, another Google zone, another scheduled run: nothing moves it.
      await clearToasts(newYork);
      await newYork.goto(s.url('/admin/availability'));
      await newYork.getByRole('region', { name: 'Your time zone' }).getByText('India Standard Time (Kolkata)').first().waitFor();
      await newYork.waitForLoadState('networkidle');
      await s.setGoogleAccount(OWNER_GOOGLE, { timezone: 'America/Sao_Paulo' });
      await s.advanceClock({ minutes: 31 });
      await s.runJobs();
      s.expect(await ownerZone(), 'owner zone').toMatchObject({ timezone: /^Asia\/(Kolkata|Calcutta)$/, timezoneMode: 'fixed' });
      s.expect(await toasts(newYork).count(), 'toasts in New York').toBe(0);
    });

    await s.step('back to "follow this device": it takes the zone of this browser at once', async () => {
      const zone = newYork.getByRole('region', { name: 'Your time zone' });
      await zone.getByRole('radio', { name: 'Follow this device' }).click();
      await expectToast(newYork, 'Following this device: Eastern Time (New York)');
      await zone.getByRole('radio', { name: 'Follow this device' }).and(newYork.locator(':checked')).waitFor();
      s.expect(await ownerZone(), 'owner zone').toEqual({ timezone: 'America/New_York', timezoneMode: 'device' });
    });
  });
});
