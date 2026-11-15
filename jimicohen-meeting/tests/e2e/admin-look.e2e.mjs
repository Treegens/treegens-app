/**
 * Look at it: every dashboard page and the co-host page with real data, at 1440 and 390 wide,
 * light and dark. Each visit is checked for failed requests, browser errors and sideways
 * scrolling, and leaves a screenshot under tests/e2e/screenshots/admin-look/ for a person to read.
 */
import { defineSuite } from './lib.mjs';
import { MONDAY } from './admin-helpers.mjs';

const OWNER_GOOGLE = 'jimi@example.com';
const CO_HOST = { name: 'Alex Rivera', email: 'alex@example.com' };

const VARIANTS = [
  { key: '1440-light', context: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' } },
  { key: '1440-dark', context: { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' } },
  { key: '390-light', context: { viewport: { width: 390, height: 844 }, colorScheme: 'light', isMobile: true, hasTouch: true } },
  { key: '390-dark', context: { viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true } },
];

/** Watches a page: answers of 400 and up, requests that never got an answer. */
function watch(page, problems) {
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.request().method()} ${response.url()} (on ${page.url()})`);
  });
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? '';
    // A request the page itself gave up on (it moved on to another screen) is not a failure.
    if (reason.includes('ERR_ABORTED')) return;
    problems.push(`failed ${request.method()} ${request.url()}: ${reason} (on ${page.url()})`);
  });
}

/** How far the page can be scrolled sideways, in pixels. A page that fits gives 0. */
async function sideways(page) {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

/** Elements that stick out of the viewport on the right (the usual cause of sideways scrolling). */
async function overflowing(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > width + 1 && getComputedStyle(el).position !== 'fixed') {
        const hidden = (() => {
          for (let p = el.parentElement; p; p = p.parentElement) {
            const o = getComputedStyle(p).overflowX;
            if (o === 'hidden' || o === 'auto' || o === 'scroll' || o === 'clip') return true;
          }
          return false;
        })();
        if (!hidden) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} right=${Math.round(rect.right)}`);
      }
      if (out.length >= 5) break;
    }
    return out;
  });
}

export default defineSuite('admin-look', { mockCreds: true }, async (t) => {
  await t.scenario('the first-run and sign-in screens, in every size and scheme', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    const problems = [];
    for (const variant of VARIANTS) {
      await s.step(`setup screen, ${variant.key}`, async () => {
        const page = await s.newPage({ timezoneId: 'Africa/Nairobi', ...variant.context });
        watch(page, problems);
        await page.goto(s.url('/admin'));
        await page.getByRole('heading', { name: 'Set up your dashboard', level: 1 }).waitFor();
        await page.waitForLoadState('networkidle');
        s.expect(await sideways(page), `sideways scrolling on the setup screen (${(await overflowing(page)).join(', ')})`).toBe(0);
        await s.screenshot(page, `${variant.key}-setup`);
        await page.context().close();
      });
    }
    await s.setupAdmin({ timezone: 'UTC' });
    for (const variant of VARIANTS) {
      await s.step(`sign-in screen, ${variant.key}`, async () => {
        const page = await s.newPage({ ...variant.context });
        watch(page, problems);
        await page.goto(s.url('/admin/bookings'));
        await page.getByRole('heading', { name: 'Sign in', level: 1 }).waitFor();
        await page.waitForLoadState('networkidle');
        s.expect(await sideways(page), `sideways scrolling on the sign-in screen (${(await overflowing(page)).join(', ')})`).toBe(0);
        await s.screenshot(page, `${variant.key}-sign-in`);
        await page.context().close();
      });
    }
    s.expect(problems, 'failed requests').toEqual([]);
  });

  await t.scenario('every dashboard page and the co-host page with real data, in every size and scheme', async (s) => {
    const seeded = {};
    await s.step('real data: calendars, a co-host, a joint meeting, a design, bookings of every kind', async () => {
      await s.setClock(MONDAY);
      const setup = await s.newPage({ signedIn: false });
      await s.login();
      const owner = await s.newPage({ signedIn: true });
      const google = await s.connectGoogle(owner, OWNER_GOOGLE, 'UTC', { gmail: true, start: { hostId: 'host_owner', gmail: true } });
      s.expect(google.result.status, 'owner connect result').toBe('connected');
      await s.apiOk('PUT', '/admin/site', {
        body: {
          profile: { headline: 'Time with Jimi, made simple', welcome: 'Pick whatever suits you. I read every note before we talk.', links: [{ label: 'Website', url: 'https://jimicohen.com' }] },
          email: { fromEmail: 'meetings@example.com', replyTo: 'hello@jimicohen.com' },
        },
      });
      const added = await s.apiOk('POST', '/admin/hosts', { body: CO_HOST });
      seeded.hostId = added.host.id;
      seeded.inviteUrl = added.inviteUrl;
      const token = new URL(added.inviteUrl).searchParams.get('t');
      const connected = await s.connectGoogle(setup, CO_HOST.email, 'Europe/Berlin', { start: { hostId: added.host.id, token, returnTo: `/meeting/host/${added.host.id}?t=${token}` } });
      s.expect(connected.result.status, 'co-host connect result').toBe('connected');
      const feed = await s.setIcsFeed('alex-work', { events: [{ start: '2026-11-17T12:00:00.000Z', end: '2026-11-17T13:00:00.000Z' }] });
      await s.visitor().ok('PUT', `/host/${added.host.id}`, { query: { t: token }, body: { title: 'Head of Partnerships', addIcsFeed: { label: 'Work calendar', url: feed } } });
      const joint = await s.apiOk('POST', '/admin/event-types', { body: { title: 'Meet Jimi and Alex', slug: 'jimi-and-alex', kind: 'collective', hostIds: ['host_owner', added.host.id], description: 'A meeting with both of us.' } });
      seeded.jointId = joint.eventType.id;
      await s.apiOk('POST', '/admin/event-types', { body: { title: 'Office hours', slug: 'office-hours', emoji: '☕', color: '#d9643a', visibility: 'unlisted', active: false, description: 'Drop in with anything.' } });
      await s.apiOk('PUT', '/admin/hosts/host_owner', {
        body: {
          schedules: [
            { id: 'sch_default', name: 'Working hours', weekly: { 0: [], 1: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }], 2: [{ start: '09:00', end: '17:00' }], 3: [{ start: '09:00', end: '17:00' }], 4: [{ start: '09:00', end: '17:00' }], 5: [{ start: '09:00', end: '15:00' }], 6: [] }, overrides: [{ date: '2026-12-24', ranges: [] }, { date: '2026-12-25', ranges: [] }, { date: '2026-11-27', ranges: [{ start: '10:00', end: '12:00' }] }] },
            { id: 'sch_evenings', name: 'Evenings', weekly: { 0: [], 1: [{ start: '18:00', end: '20:00' }], 2: [], 3: [{ start: '18:00', end: '20:00' }], 4: [], 5: [], 6: [] }, overrides: [] },
          ],
          defaultScheduleId: 'sch_default',
        },
      });
      const book = async (body) => {
        const res = await s.book(body);
        s.expect(res.status, `booking for ${body.name}`).toBe(201);
        return { id: res.data.booking.id, token: res.data.manageToken };
      };
      seeded.past = await book({ slug: 'intro', start: '2026-11-16T14:00:00.000Z', name: 'Mary Jackson', email: 'mary@example.com', timezone: 'UTC' });
      seeded.ada = await book({ slug: 'intro', start: '2026-11-17T10:00:00.000Z', name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'America/New_York', phone: '+14155552671', consent: { sms: true, call: true }, guests: ['grace@example.com'], answers: { q_topic: 'Planting trees together, and how a small team can keep a very large promise.' } });
      await book({ slug: 'meeting', start: '2026-11-18T13:00:00.000Z', durationMin: 45, name: 'Katherine Johnson-Goble de la Fontaine', email: 'katherine.johnson.goble@a-rather-long-domain-name.example.com', timezone: 'America/Chicago' });
      await book({ slug: 'jimi-and-alex', start: '2026-11-19T10:00:00.000Z', durationMin: 30, name: 'Alan Turing', email: 'alan@example.com', timezone: 'Europe/London' });
      const gone = await book({ slug: 'intro', start: '2026-11-17T15:00:00.000Z', name: 'Dorothy Vaughan', email: 'dorothy@example.com', timezone: 'UTC' });
      await s.visitor().ok('POST', `/public/bookings/${gone.id}/cancel`, { body: { t: gone.token, reason: 'Travelling that day.' } });
      await s.visitor().ok('POST', `/public/bookings/${seeded.ada.id}/confirm`, { body: { t: seeded.ada.token } });
      await s.settle();
      await s.setClock('2026-11-16T16:00:00.000Z');
      await s.runJobs();
      await owner.context().close();
      await setup.context().close();
    });

    const pages = () => [
      { name: 'home', path: '/admin', heading: /^Good (morning|afternoon|evening), Jimi$/ },
      { name: 'event-types', path: '/admin/event-types', heading: 'Event types' },
      { name: 'event-new-kind', path: '/admin/event-types?new=1', heading: 'Event types', dialog: 'What kind of meeting?' },
      { name: 'event-basics', path: '/admin/event-types/evt_meeting', heading: 'Meeting' },
      { name: 'event-hosts', path: `/admin/event-types/${seeded.jointId}?tab=hosts`, heading: 'Meet Jimi and Alex' },
      { name: 'event-scheduling', path: `/admin/event-types/${seeded.jointId}?tab=scheduling`, heading: 'Meet Jimi and Alex' },
      { name: 'event-questions', path: '/admin/event-types/evt_intro?tab=questions', heading: 'Intro call' },
      { name: 'event-reminders', path: '/admin/event-types/evt_intro?tab=reminders', heading: 'Intro call' },
      { name: 'event-confirmation', path: '/admin/event-types/evt_intro?tab=confirmation', heading: 'Intro call' },
      { name: 'event-advanced', path: '/admin/event-types/evt_intro?tab=advanced', heading: 'Intro call' },
      { name: 'availability', path: '/admin/availability', heading: 'Availability' },
      { name: 'bookings', path: '/admin/bookings', heading: 'Bookings' },
      { name: 'bookings-drawer', path: `/admin/bookings?b=${seeded.ada.id}`, heading: 'Bookings', dialog: 'Ada Lovelace' },
      { name: 'bookings-cancelled', path: '/admin/bookings?scope=cancelled', heading: 'Bookings' },
      { name: 'bookings-nothing-found', path: '/admin/bookings?q=nobody', heading: 'Bookings' },
      { name: 'team', path: '/admin/team', heading: 'Team' },
      { name: 'design', path: '/admin/design', heading: 'Design' },
      { name: 'integrations', path: '/admin/integrations', heading: 'Integrations' },
      { name: 'integrations-email', path: '/admin/integrations#email', heading: 'Integrations' },
      { name: 'settings', path: '/admin/settings', heading: 'Settings' },
      { name: 'not-found', path: '/admin/nothing-here', heading: null },
    ];

    for (const variant of VARIANTS) {
      await s.step(`dashboard, ${variant.key}`, async () => {
        const problems = [];
        const layout = [];
        const page = await s.newPage({ signedIn: true, ...variant.context });
        watch(page, problems);
        for (const item of pages()) {
          await page.goto(s.url(item.path));
          if (item.heading) await page.getByRole('heading', { name: item.heading, level: 1 }).waitFor();
          else await page.getByRole('heading', { name: 'That page is not part of the dashboard' }).waitFor();
          if (item.dialog) await page.getByRole('dialog').getByRole('heading', { name: item.dialog }).waitFor();
          await page.waitForLoadState('networkidle');
          await page.locator('[aria-busy="true"]').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
          const extra = await sideways(page);
          if (extra > 0) layout.push(`${item.name}: scrolls sideways by ${extra}px (${(await overflowing(page)).join(', ')})`);
          await s.screenshot(page, `${variant.key}-${item.name}`, { fullPage: !item.dialog });
        }
        if (variant.context.isMobile) {
          // The phone navigation: the tab bar and the "More" sheet.
          await page.goto(s.url('/admin'));
          await page.getByRole('button', { name: 'More' }).click();
          await page.getByRole('dialog', { name: 'More' }).getByRole('link', { name: 'Integrations' }).waitFor();
          await s.screenshot(page, `${variant.key}-more-sheet`, { fullPage: false });
          await page.getByRole('dialog', { name: 'More' }).getByRole('link', { name: 'Team' }).click();
          await page.getByRole('heading', { name: 'Team', level: 1 }).waitFor();
        }
        s.expect(problems, `failed requests (${variant.key})`).toEqual([]);
        s.expect(layout, `pages that do not fit the screen (${variant.key})`).toEqual([]);
        await page.context().close();
      });

      await s.step(`co-host page, ${variant.key}`, async () => {
        const problems = [];
        const page = await s.newPage({ timezoneId: 'Europe/Berlin', ...variant.context });
        watch(page, problems);
        await page.goto(seeded.inviteUrl);
        await page.getByRole('heading', { name: 'You are all set, Alex.', level: 1 }).waitFor();
        await page.getByRole('region', { name: 'Your calendar' }).getByRole('checkbox').first().waitFor();
        await page.waitForLoadState('networkidle');
        s.expect(await sideways(page), `sideways scrolling on the co-host page (${(await overflowing(page)).join(', ')})`).toBe(0);
        await s.screenshot(page, `${variant.key}-co-host`);
        s.expect(problems, `failed requests on the co-host page (${variant.key})`).toEqual([]);
        await page.context().close();
      });
    }
  });
});
