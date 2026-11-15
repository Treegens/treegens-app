/**
 * jimicohen.com/meet and jimicohen.com/pod, the way a visitor and a link preview see them.
 *
 * The dev server answers /meet and /pod at its root from the static pages the build writes, with the
 * netlify.toml headers, the way jimicohen.com proxies them: http://localhost:<port>/pod here is
 * https://jimicohen.com/pod in production, and http://127.0.0.1:<port>/pod plays the app's own address.
 * Every scenario runs the one-time setup (POST /dev/one-time-moves) after preparing the site.
 */
import { defineSuite, metaOf } from './lib.mjs';
import { PHONE, PHONE_TYPED, PHONE_VIEWPORT, calendarReady, fillDetails, confirmBooking, offeredSlots, pickDay, prepare } from './public-helpers.mjs';

const NY = 'America/New_York';
const TUESDAY = '2026-11-17';
const ECO = 'brand_eco_champions';
const SAND = 'rgb(250, 245, 230)';
const FOREST = 'rgb(11, 29, 20)';

/** The path the browser shows, with its query. */
function where(page) {
  const u = new URL(page.url());
  return `${u.pathname}${u.search}`;
}

async function cssVar(page, name) {
  return page.evaluate((n) => getComputedStyle(document.querySelector('.m-scope') ?? document.documentElement).getPropertyValue(n).trim().toLowerCase(), name);
}

async function rootBackground(page) {
  return page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
}

/** Owner email set, setup run: every message goes somewhere the test can read. */
async function preparePod(s) {
  const owner = await prepare(s);
  await s.apiOk('PUT', '/admin/hosts/host_owner', { body: { email: 'jimi@example.com' } });
  const moved = await s.runOneTimeMoves();
  s.expect(moved, 'the one-time setup').toMatchObject({ meet: { eventTypeId: 'evt_meeting' }, pod: { eventTypeId: 'evt_eco_champions' } });
  return owner;
}

export default defineSuite('public-short-links', { mockCreds: true }, async (t) => {
  await t.scenario('jimicohen.com/meet books Jimi alone, and the address stays /meet', async (s) => {
    await preparePod(s);
    for (const size of ['desktop', 'phone']) {
      const page = await s.newPage({ timezoneId: NY, ...(size === 'phone' ? PHONE_VIEWPORT : {}) });
      const email = `ada.${size}@example.com`;
      let slot;
      await s.step(`${size}: /meet opens "Meeting with Jimi" in Jimi's own look`, async () => {
        await page.goto(s.shortUrl('meet'));
        await page.getByRole('heading', { name: 'Meeting with Jimi', level: 1 }).waitFor();
        await calendarReady(page);
        s.expect(where(page), 'address').toBe('/meet');
        // The meeting's own name once the page runs; the link preview says "Meet with Jimi" (checked below).
        s.expect(await page.title(), 'tab title').toBe('Meeting with Jimi');
        s.expect(await page.getByRole('link', { name: 'All meeting types' }).count(), 'no list of meetings').toBe(0);
        s.expect(await cssVar(page, '--m-bg'), 'forest page').toBe('#0b1d14');
        s.expect(await page.locator('.bw-summary__logo').count(), 'no brand logo').toBe(0);
        await s.screenshot(page, `meet ${size} calendar`, { fullPage: size === 'desktop' });
      });
      await s.step(`${size}: a day, a time and the form, still on /meet`, async () => {
        await pickDay(page, TUESDAY);
        slot = (await offeredSlots(page))[0];
        await page.locator(`.bw-slot[data-start="${Date.parse(slot.start)}"]`).click();
        await fillDetails(page, { name: 'Ada Lovelace', email });
        s.expect(where(page), 'address on the form').toBe('/meet');
        await s.screenshot(page, `meet ${size} details`, { fullPage: size === 'desktop' });
      });
      if (size === 'desktop') {
        await s.step('a reload on the form starts again at the calendar, still on /meet', async () => {
          await page.reload();
          await calendarReady(page);
          s.expect(where(page), 'address after the reload').toBe('/meet');
          s.expect(await page.getByRole('form', { name: 'Your details' }).count(), 'the form is gone').toBe(0);
          await pickDay(page, TUESDAY);
          await page.locator(`.bw-slot[data-start="${Date.parse(slot.start)}"]`).click();
          await fillDetails(page, { name: 'Ada Lovelace', email });
        });
      }
      await s.step(`${size}: books, and the confirmation stays on /meet`, async () => {
        await confirmBooking(s, page);
        await page.getByRole('heading', { name: "You're booked" }).waitFor();
        s.expect(where(page), 'address on the confirmation').toBe('/meet');
        await s.settle();
        await s.screenshot(page, `meet ${size} confirmation`, { fullPage: size === 'desktop' });
      });
      await s.step(`${size}: the booking is Jimi's own, and its links lead to /meeting/booking`, async () => {
        const [booking] = await s.bookings((b) => b.invitee.email === email);
        s.expect(booking.eventTitle, 'event').toBe('Meeting with Jimi');
        s.expect(booking.brandId, 'no brand').toBe(undefined);
        s.expect(booking.hostIds, 'Jimi alone').toEqual(['host_owner']);
        const [mail] = await s.outbox({ kind: 'email', to: email });
        s.expect(mail.from, 'sender').toMatch(/^Jimi Cohen </);
        s.expect(mail.links.some((l) => l.startsWith(`${s.server.base}/booking/${booking.id}`)), 'manage link').toBeTruthy();
        s.expect(mail.html, 'no brand').not.toContain('Eco Champions <');
        if (size === 'desktop') await s.screenshotEmail(mail, 'meet email to the invitee');
      });
      if (size === 'desktop') {
        await s.step('"Reschedule" opens the app page of the booking, in Jimi\'s look', async () => {
          await page.getByRole('link', { name: 'Reschedule' }).click();
          await page.waitForURL(/\/meeting\/booking\/[^/]+\/reschedule\?t=/);
          await calendarReady(page);
          s.expect(await cssVar(page, '--m-bg'), 'forest').toBe('#0b1d14');
          await s.screenshot(page, 'meet manage reschedule');
        });
      }
    }
  });

  await t.scenario('jimicohen.com/pod books Jimi and Ian together, all in Eco Champions', async (s) => {
    const owner = await preparePod(s);
    let ian;
    await s.step('Ian joins the pod meeting as he is added, and connects his calendar', async () => {
      const added = await s.apiOk('POST', '/admin/hosts', { body: { name: 'Ian Poirier', email: 'ian@example.com', addToEventTypeIds: ['evt_eco_champions'] } });
      ian = added.host;
      s.expect(added.eventTypes.map((e) => e.id), 'joined').toEqual(['evt_eco_champions']);
      const { result } = await s.connectGoogle(owner, 'ian@example.com', 'Europe/London', { start: { hostId: ian.id } });
      s.expect(result.status, 'Ian connected').toBe('connected');
      await s.setGoogleBusy('ian@example.com', [{ start: `${TUESDAY}T10:00:00.000Z`, end: `${TUESDAY}T10:30:00.000Z` }]);
    });

    const page = await s.newPage({ timezoneId: NY });
    const start = `${TUESDAY}T15:00:00.000Z`; // 10:00 in New York, 3 PM in London
    await s.step('/pod: the Eco Champions logo, sand and green, Fraunces and Inter, Jimi and Ian, only shared free times', async () => {
      await page.goto(s.shortUrl('pod'));
      await page.getByRole('heading', { name: 'Eco Champions conversation', level: 1 }).waitFor();
      await calendarReady(page);
      s.expect(where(page), 'address').toBe('/pod');
      s.expect(await page.title(), 'tab title').toBe('Eco Champions conversation');
      s.expect(await page.locator('.bw-summary__logo').getAttribute('src'), 'logo').toBe('/meeting/brand/eco-champions/logo.svg');
      s.expect(await cssVar(page, '--m-primary'), 'eco green').toBe('#14432f');
      s.expect(await cssVar(page, '--m-bg'), 'sand').toBe('#faf5e6');
      const fonts = await page.locator('link[data-mtg-font]').evaluateAll((links) => links.map((l) => l.href).join(' '));
      s.expect(fonts, 'fonts').toMatch(/Fraunces/);
      s.expect(fonts, 'fonts').toMatch(/Inter/);
      await page.getByText('Jimi Cohen and Ian Poirier', { exact: true }).waitFor();
      await page.getByText('Both will join', { exact: true }).waitFor();
      s.expect(await page.locator('link[rel="icon"]').first().getAttribute('href'), 'tab icon').toBe('/meeting/brand/eco-champions/favicon.svg');
      await pickDay(page, TUESDAY);
      const times = (await offeredSlots(page)).map((x) => x.start);
      s.expect(times, 'Ian is busy at 10:00 London').not.toContain(`${TUESDAY}T10:00:00.000Z`);
      s.expect(times, '3 PM London is free for both').toContain(start);
      s.expect(await page.getByText('Scheduling by Eco Champions').count(), 'credit').toBe(1);
      s.expect(await page.getByRole('link', { name: /Scheduling by/ }).count(), 'the credit is not a link').toBe(0);
      await s.screenshot(page, 'pod desktop calendar');
    });
    await s.step('books with a phone number, still on /pod', async () => {
      await page.locator(`.bw-slot[data-start="${Date.parse(start)}"]`).click();
      await fillDetails(page, { name: 'Ann Lee', email: 'ann@example.com', phone: PHONE_TYPED, sms: true, call: true });
      await s.screenshot(page, 'pod desktop details');
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await page.getByText('Thanks, Ann. We look forward to talking with you.').waitFor();
      s.expect(where(page), 'address').toBe('/pod');
      await s.settle();
      await s.screenshot(page, 'pod desktop confirmation');
    });

    let booking;
    await s.step('the booking carries the brand; the emails, the text and the calendar file are Eco Champions', async () => {
      [booking] = await s.bookings((b) => b.invitee.email === 'ann@example.com');
      s.expect(booking.brandId, 'brand').toBe(ECO);
      s.expect(booking.hostIds, 'both hosts').toEqual(['host_owner', ian.id]);
      const [mail] = await s.outbox({ kind: 'email', to: 'ann@example.com' });
      s.expect(mail.from, 'sender').toMatch(/^Eco Champions </);
      s.expect(mail.html, 'footer').toContain('You are getting this email because a meeting was booked with Eco Champions using this address.');
      // Emails show pictures from https addresses only (the unit tests check the logo in the email); the asset
      // route the email points at serves the built-in logo to anyone.
      const logo = await fetch(`${s.server.api}/assets/builtin_eco_champions_email`);
      s.expect([logo.status, logo.headers.get('content-type')], 'the email logo from the asset route').toEqual([200, 'image/png']);
      s.expect(mail.subject, 'subject').toMatch(/^Confirmed: Eco Champions conversation with Jimi and Ian/);
      if (mail.ics) s.expect(mail.ics.content.replace(/\r\n /g, ''), 'calendar file').toContain(`Booked through Eco Champions: ${s.shortUrl('pod')}`);
      await s.screenshotEmail(mail, 'pod email to the invitee');
      const hostMails = await s.outbox({ kind: 'email', subject: /^New booking/ });
      s.expect(hostMails.length, 'host emails').toBeGreaterThanOrEqual(1);
      for (const m of hostMails) {
        s.expect(m.from, 'host email sender').toMatch(/^Eco Champions </);
        s.expect(m.html, 'host footer').toContain('Sent by the Eco Champions booking page.');
      }
      await s.screenshotEmail(hostMails[0], 'pod email to a host');
      const [text] = await s.outbox({ kind: 'sms', to: PHONE });
      s.expect(text.body, 'text names the brand through the title, no prefix').toMatch(/^Hi Ann, you're booked: Eco Champions conversation with Jimi and Ian/);
    });
    await s.step('the Google event invites both hosts and starts with the brand line', async () => {
      const events = (await s.googleEvents('jimi@example.com')).map((e) => e.event);
      const event = events.find((e) => (e.summary ?? '').startsWith('Eco Champions conversation'));
      s.expect(event?.summary, 'title').toBe('Eco Champions conversation: Ann Lee, Jimi Cohen and Ian Poirier');
      s.expect((event?.description ?? '').split('\n')[0], 'first line').toBe(`Booked through Eco Champions: ${s.shortUrl('pod')}`);
      s.expect((event?.attendees ?? []).map((a) => a.email), 'Ian is on it').toContain('ian@example.com');
    });
    await s.step('the reminder call two hours before speaks for Eco Champions, with Jimi and Ian', async () => {
      await s.setClock(`${TUESDAY}T13:00:00.000Z`);
      await s.runJobs();
      const [call] = await s.calls();
      s.expect(call?.record?.script?.brandName, 'brand on the call record').toBe('Eco Champions');
      const answer = await s.voice(call, 'start');
      s.expect(answer.said, 'greeting').toMatch(/an AI assistant calling for Eco Champions\. A quick reminder about your Eco Champions conversation with Jimi and Ian/);
    });
    await s.step('the manage page from the email is Eco Champions, names both hosts, and stays so when the event loses the brand', async () => {
      await s.setClock('2026-11-16T09:00:00.000Z');
      await s.apiOk('PUT', '/admin/event-types/evt_eco_champions', { body: { brandId: null } });
      const manage = await s.newPage({ timezoneId: NY });
      await manage.goto(booking.manageUrl);
      await manage.getByRole('heading', { name: /Eco Champions conversation/ }).first().waitFor();
      s.expect(await cssVar(manage, '--m-primary'), 'eco green').toBe('#14432f');
      s.expect(await manage.title(), 'tab title').toMatch(/Eco Champions conversation/);
      s.expect(await manage.locator('.bm__logo').getAttribute('src'), 'the Eco Champions logo on the manage page').toBe('/meeting/brand/eco-champions/logo.svg');
      await s.screenshot(manage, 'pod manage page');
      // Both hosts join, so both are named: "Let Jimi and Ian know", and the thank-you says they both know.
      await manage.getByText('Let Jimi and Ian know with one tap.', { exact: true }).waitFor();
      s.expect(await manage.getByText('Let Jimi know with one tap.').count(), 'only the first host').toBe(0);
      await manage.getByRole('button', { name: "I'll be there" }).click();
      await manage.getByText('Jimi and Ian know you will be there.', { exact: true }).waitFor();
      await manage.getByText('You said you will be there').waitFor();
      await s.screenshot(manage, 'pod manage page attending');
      await s.clearOutbox();
      await manage.getByRole('link', { name: 'Cancel meeting' }).click();
      await manage.getByText('Jimi and Ian will see this with the cancellation.', { exact: true }).waitFor();
      await manage.getByRole('button', { name: 'Cancel meeting' }).click();
      await manage.getByRole('link', { name: 'Book a new time' }).waitFor();
      s.expect(await manage.getByRole('link', { name: 'Book a new time' }).getAttribute('href'), 'book again at /pod').toBe(s.shortUrl('pod'));
      await s.settle();
      const [cancelled] = await s.outbox({ kind: 'email', to: 'ann@example.com' });
      s.expect(cancelled.from, 'still Eco Champions').toMatch(/^Eco Champions </);
      await s.screenshot(manage, 'pod manage cancelled');
      await s.screenshotEmail(cancelled, 'pod email cancelled');
    });
  });

  await t.scenario('phones: /pod at 390 px through every step, and its closed page at 360 px', async (s) => {
    await preparePod(s);
    const page = await s.newPage({ timezoneId: NY, ...PHONE_VIEWPORT });
    await s.step('the calendar, a day, the form and the confirmation', async () => {
      await page.goto(s.shortUrl('pod'));
      await calendarReady(page);
      await s.screenshot(page, 'pod phone calendar', { fullPage: false });
      await pickDay(page, TUESDAY);
      await s.screenshot(page, 'pod phone times', { fullPage: false });
      const [slot] = await offeredSlots(page);
      await page.locator(`.bw-slot[data-start="${Date.parse(slot.start)}"]`).click();
      await fillDetails(page, { name: 'Ann Lee', email: 'ann.phone@example.com' });
      await s.screenshot(page, 'pod phone details', { fullPage: false });
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      s.expect(where(page), 'address').toBe('/pod');
      await s.settle();
      await s.screenshot(page, 'pod phone confirmation');
      const scrolls = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      s.expect(scrolls, 'no sideways scrolling').toBeFalsy();
    });
    await s.step('the closed page at 360 px', async () => {
      await s.apiOk('PUT', '/admin/event-types/evt_eco_champions', { body: { active: false } });
      const small = await s.newPage({ timezoneId: NY, viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await small.goto(s.shortUrl('pod'));
      await small.getByRole('heading', { name: 'Eco Champions is not taking bookings right now' }).waitFor();
      await small.getByText('Please check back soon.').waitFor();
      s.expect(await small.getByRole('link', { name: 'See all meeting types' }).count(), 'no way into Jimi list').toBe(0);
      s.expect(await cssVar(small, '--m-bg'), 'sand').toBe('#faf5e6');
      await s.screenshot(small, 'pod phone closed 360');
    });
  });

  await t.scenario('link previews without scripts, the headers, and paths below the short ones', async (s) => {
    await preparePod(s);
    const own = `http://127.0.0.1:${s.server.port}`;
    s.allowLocalOrigin(own);
    for (const [name, title, siteName, image] of [
      ['pod', 'Eco Champions conversation', 'Eco Champions', '/meeting/brand/eco-champions/og.png'],
      ['meet', 'Meet with Jimi', 'Jimi Cohen', '/meeting/og/meet.png'],
    ]) {
      await s.step(`/${name}: the preview a crawler reads`, async () => {
        const res = await s.fetchHtml(s.shortUrl(name));
        s.expect(res.status, 'status').toBe(200);
        const m = metaOf(res.text);
        s.expect(m.titles, 'one title').toEqual([title]);
        s.expect(m.meta['og:title'], 'og:title').toBe(title);
        s.expect(m.meta['og:site_name'], 'og:site_name').toBe(siteName);
        s.expect(m.meta['og:url'], 'og:url').toBe(`https://jimicohen.com/${name}`);
        s.expect(m.meta['og:image'], 'og:image').toBe(`https://jimicohen.com${image}`);
        s.expect(m.meta['twitter:card'], 'twitter:card').toBe('summary_large_image');
        s.expect(m.meta['og:description'].length, 'description length').toBeLessThanOrEqual(200);
        s.expect(m.meta['og:description'], 'no dashes').not.toMatch(/[–—]/);
        const picture = await fetch(`${s.server.origin}${image}`);
        s.expect(picture.status, 'picture').toBe(200);
        s.expect(picture.headers.get('content-type'), 'picture type').toBe('image/png');
        s.expect(res.headers.get('content-security-policy'), 'CSP').toContain("frame-ancestors 'none'");
        s.expect(res.headers.get('x-frame-options'), 'X-Frame-Options').toBe('DENY');
        s.expect(res.text, 'no inline script').not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
        const same = await s.fetchHtml(`${own}/${name}`);
        s.expect(same.text, 'the app address answers the same page').toBe(res.text);
      });
    }
    await s.step('/pod/anything opens the same page, and the app puts the address back to /pod', async () => {
      const page = await s.newPage({ timezoneId: NY });
      await page.goto(`${s.shortUrl('pod')}/anything?utm_source=linkedin`);
      await page.getByRole('heading', { name: 'Eco Champions conversation', level: 1 }).waitFor();
      await s.eventually(async () => s.expect(where(page), 'address').toBe('/pod?utm_source=linkedin'));
    });
    await s.step("/meeting/eco-champions has the brand's tab and home screen icons, and Jimi's page gets its own back", async () => {
      const icons = (page) =>
        page.evaluate(() => ({
          svg: document.querySelector('link[rel="icon"][type="image/svg+xml"]')?.getAttribute('href') ?? null,
          png: [...document.querySelectorAll('link[rel="icon"][type="image/png"]')].map((l) => l.getAttribute('href')),
          touch: [...document.querySelectorAll('link[rel="apple-touch-icon"]')].map((l) => l.getAttribute('href')),
        }));
      const page = await s.newPage({ timezoneId: NY });
      await page.goto(s.url('/eco-champions'));
      await page.getByRole('heading', { name: 'Eco Champions conversation', level: 1 }).waitFor();
      await s.eventually(async () =>
        s.expect(await icons(page), 'icons on the brand page').toEqual({ svg: '/meeting/brand/eco-champions/favicon.svg', png: [], touch: ['/meeting/brand/eco-champions/apple-touch-icon.png'] }),
      );
      const touch = await fetch(`${s.server.origin}/meeting/brand/eco-champions/apple-touch-icon.png`);
      s.expect([touch.status, touch.headers.get('content-type')], 'the home screen icon file').toEqual([200, 'image/png']);
      // On to Jimi's own page in the same tab: his tab icon is back and the brand's home screen icon is gone, so the
      // phone uses jimicohen.com's own.
      await page.evaluate(() => {
        window.history.pushState({}, '', '/meeting/intro');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await page.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      await s.eventually(async () => s.expect(await icons(page), "icons on Jimi's page").toEqual({ svg: '/meeting/favicon.svg', png: [], touch: [] }));
      const fresh = await s.newPage({ timezoneId: NY });
      await fresh.goto(s.url('/intro'));
      await fresh.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      s.expect(await icons(fresh), "icons on Jimi's page opened directly").toEqual({ svg: '/meeting/favicon.svg', png: [], touch: [] });
      // jimicohen.com/pod keeps the brand's icons from its own page, the small PNG one included.
      const pod = await s.newPage({ timezoneId: NY });
      await pod.goto(s.shortUrl('pod'));
      await pod.getByRole('heading', { name: 'Eco Champions conversation', level: 1 }).waitFor();
      s.expect(await icons(pod), 'icons on /pod').toEqual({
        svg: '/meeting/brand/eco-champions/favicon.svg',
        png: ['/meeting/brand/eco-champions/favicon-32.png'],
        touch: ['/meeting/brand/eco-champions/apple-touch-icon.png'],
      });
    });
    await s.step('a booking path that slips through leaves for /meeting/booking with replace, and Back returns to /pod', async () => {
      const page = await s.newPage({ timezoneId: NY, allowConsoleErrors: [/status of 404/] });
      await page.goto(s.shortUrl('pod'));
      await calendarReady(page);
      await page.evaluate(() => {
        window.history.pushState({}, '', '/pod/booking/bkg_none?t=abc');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await page.waitForURL(/\/meeting\/booking\/bkg_none\?t=abc$/);
      await page.getByRole('heading', { name: 'We could not find that booking' }).waitFor();
      await page.goBack();
      await page.waitForURL((u) => u.pathname === '/pod');
      await page.getByRole('heading', { name: 'Eco Champions conversation', level: 1 }).waitFor();
    });
  });

  await t.scenario('no forest on /pod while it loads, and loading screens are never remembered', async (s) => {
    await preparePod(s);
    await s.step('before any script runs, the page is already sand', async () => {
      const page = await s.newPage({ timezoneId: NY });
      await page.route(/\/meeting\/assets\/.*\.js$/, (route) => route.abort('blockedbyclient'));
      s.allowConsoleErrors(/Failed to load resource/, /net::ERR_BLOCKED_BY_CLIENT/);
      await page.goto(s.shortUrl('pod'));
      s.expect(await rootBackground(page), 'canvas before scripts').toBe(SAND);
      await page.close();
    });
    await s.step('while the data loads: sand on the canvas and the skeleton, nothing written', async () => {
      const page = await s.newPage({ timezoneId: NY });
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      await page.route(/\/meeting\/api\/public\/short\/pod$/, async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(s.shortUrl('pod'));
      await page.locator('.bw--skeleton').waitFor();
      s.expect(await rootBackground(page), 'canvas while loading').toBe(SAND);
      s.expect(await cssVar(page, '--m-bg'), 'skeleton').toBe('#faf5e6');
      const stored = await page.evaluate(() => [localStorage.getItem('mtg:boot-theme'), localStorage.getItem('mtg:boot-theme:brand_eco_champions')]);
      s.expect(stored, 'nothing remembered while loading').toEqual([null, null]);
      await s.screenshot(page, 'pod loading', { fullPage: false });
      release();
      await page.getByRole('heading', { name: 'Eco Champions conversation', level: 1 }).waitFor();
      await s.eventually(async () => {
        const after = await page.evaluate(() => localStorage.getItem('mtg:boot-theme:brand_eco_champions'));
        s.expect(JSON.parse(after ?? '{}').bg, 'the brand look is remembered once shown').toBe('#faf5e6');
      });
    });
    await s.step('after a visit to /pod, /meet still boots in Jimi\'s own look, never in Eco Champions', async () => {
      const page = await s.newPage({ timezoneId: NY });
      await page.goto(s.shortUrl('pod'));
      await page.getByRole('heading', { name: 'Eco Champions conversation', level: 1 }).waitFor();
      // The look seen last is Eco Champions now (a guest's manage page from an email boots in it).
      await s.eventually(async () => s.expect(JSON.parse((await page.evaluate(() => localStorage.getItem('mtg:boot-theme'))) ?? '{}').bg, 'last look').toBe('#faf5e6'));
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      await page.route(/\/meeting\/api\/public\/short\/meet$/, async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(s.shortUrl('meet'));
      await page.locator('.bw--skeleton').waitFor();
      s.expect(await rootBackground(page), 'canvas while /meet loads').toBe(FOREST);
      s.expect(await cssVar(page, '--m-bg'), 'skeleton while /meet loads').toBe('#0b1d14');
      await s.screenshot(page, 'meet loading after pod', { fullPage: false });
      release();
      await page.getByRole('heading', { name: 'Meeting with Jimi', level: 1 }).waitFor();
    });

    await s.step("a first visit to /meeting/meeting boots in Jimi's forest, and its loading screen is not remembered", async () => {
      const page = await s.newPage({ timezoneId: NY });
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      await page.route(/\/meeting\/api\/public\/event\/meeting$/, async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(s.url('/meeting'));
      await page.locator('.bw--skeleton').waitFor();
      s.expect(await rootBackground(page), 'forest while loading').toBe(FOREST);
      s.expect(await page.evaluate(() => [localStorage.getItem('mtg:boot-theme'), localStorage.getItem('mtg:boot-theme:own')]), 'nothing remembered').toEqual([null, null]);
      release();
      await page.getByRole('heading', { name: 'Meeting with Jimi', level: 1 }).waitFor();
      await s.eventually(async () => s.expect(await page.evaluate(() => localStorage.getItem('mtg:boot-theme')), 'remembered once shown').not.toBeNull());
      // Jimi's own look is also kept apart, for jimicohen.com/meet (which never boots in a brand's look seen since).
      s.expect(JSON.parse((await page.evaluate(() => localStorage.getItem('mtg:boot-theme:own'))) ?? '{}').bg, 'own look').toBe('#0b1d14');
    });
  });

  await t.scenario('closed and moved links', async (s) => {
    const owner = await preparePod(s);
    await s.step('a paused pod meeting: the Eco Champions closed page, with no way into Jimi\'s list', async () => {
      await s.apiOk('PUT', '/admin/event-types/evt_eco_champions', { body: { active: false } });
      const page = await s.newPage({ timezoneId: NY });
      await page.goto(s.shortUrl('pod'));
      await page.getByRole('heading', { name: 'Eco Champions is not taking bookings right now' }).waitFor();
      s.expect(await page.getByRole('link', { name: 'See all meeting types' }).count(), 'no link').toBe(0);
      s.expect(await cssVar(page, '--m-primary'), 'eco green').toBe('#14432f');
      await s.screenshot(page, 'pod closed');
    });
    await s.step('/pod moved to "Intro call" in the Short links card, with the box ticked: Intro call in Eco Champions', async () => {
      await owner.goto(s.url('/admin/event-types'));
      const card = owner.getByRole('region', { name: 'Short links' });
      await card.getByRole('combobox', { name: 'What localhost:' + s.server.port + '/pod opens' }).selectOption({ label: 'Intro call' });
      const dialog = owner.getByRole('dialog', { name: /Move localhost:\d+\/pod\?/ });
      await dialog.getByRole('checkbox', { name: /Use the Eco Champions look for Intro call too/ }).waitFor();
      await dialog.getByRole('button', { name: 'Move it' }).click();
      await dialog.waitFor({ state: 'hidden' });
      const page = await s.newPage({ timezoneId: NY });
      await page.goto(s.shortUrl('pod'));
      await page.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      s.expect(await cssVar(page, '--m-primary'), 'eco green').toBe('#14432f');
    });
    await s.step('/meet set to "Nothing for now": not open, with the way to every meeting', async () => {
      const card = owner.getByRole('region', { name: 'Short links' });
      await card.getByRole('combobox', { name: 'What localhost:' + s.server.port + '/meet opens' }).selectOption({ label: 'Nothing for now' });
      const dialog = owner.getByRole('dialog', { name: /Turn off localhost:\d+\/meet\?/ });
      await dialog.getByRole('button', { name: 'Turn it off' }).click();
      await dialog.waitFor({ state: 'hidden' });
      const page = await s.newPage({ timezoneId: NY });
      await page.goto(s.shortUrl('meet'));
      await page.getByRole('heading', { name: 'This link is not open right now' }).waitFor();
      s.expect(await cssVar(page, '--m-bg'), 'forest').toBe('#0b1d14');
      await s.screenshot(page, 'meet closed');
      await page.getByRole('link', { name: 'See all meeting types' }).click();
      await page.waitForURL((u) => u.pathname === '/meeting/');
      await page.getByRole('heading', { name: 'Book time with Jimi' }).waitFor();
    });
  });
});
