/**
 * Embeds. A small page of "another website" is written to disk and served from its own local
 * port, under a strict Content Security Policy. It contains exactly the code the dashboard's
 * Share panel hands out (read from the panel in the browser, not retyped here): the inline
 * calendar and the popup button. The frame must size itself to its content, a booking made
 * inside it must work like any other, and the popup must close without leaving anything behind.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineSuite, parsePorts } from './lib.mjs';
import { OWNER_GOOGLE, PHONE_VIEWPORT, confirmBooking, fillDetails, offeredSlots, pickDay, pickSlot, prepare } from './public-helpers.mjs';

const NEW_YORK = 'America/New_York';
const START = '2026-11-18T16:00:00.000Z';

// ───────────────────────── the other website ─────────────────────────

function canListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/** The highest free port of the range the runner was given: its own dev servers are taken from the low end. */
async function pickPort() {
  if (process.env.E2E_EMBED_PORT) return Number(process.env.E2E_EMBED_PORT);
  const ports = parsePorts(process.env.E2E_PORTS || '8800-8899');
  for (const port of [...ports].reverse()) if (await canListen(port)) return port;
  throw new Error('No free port for the page that embeds the app.');
}

const HOST_CSS = `
  body { margin: 0; font: 16px/1.5 Georgia, serif; background: #f6f1e7; color: #1d1d1b; }
  header, main { max-width: 1040px; margin: 0 auto; padding: 24px 16px; }
  h1 { margin: 0 0 4px; }
  #calendar { border: 1px dashed #b9b09c; }
  .tall { height: 1400px; }
`;

/** Notes every event the embed script announces, so the test can read what the host page was told. */
const HOST_JS = `
  window.announced = [];
  ['meeting:booked', 'meeting:rescheduled', 'meeting:cancelled'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      window.announced.push({ type: type, detail: event.detail, from: event.target && event.target.id });
      var log = document.getElementById('log');
      if (log) log.textContent = type + ' ' + (event.detail && event.detail.start);
    });
  });
`;

function hostPage(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="host.css">
</head>
<body>
<header><h1>Acme Trees</h1><p>We plant trees. Book a call with our advisor.</p></header>
<main>
${body}
<p id="log" aria-live="polite"></p>
</main>
<script src="host.js"></script>
</body>
</html>
`;
}

/**
 * Serves `dir` on `port` with a policy stricter than most sites have: scripts and frames only
 * from the app, no inline scripts, no inline style attributes or style elements.
 */
function serveHost(dir, port, appOrigin) {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const csp = `default-src 'none'; script-src 'self' ${appOrigin}; frame-src ${appOrigin}; style-src 'self'; base-uri 'none'; form-action 'none'`;
  // Pages named strict-*: a site that lets in nothing from the app, the way jimicohen.com itself does.
  const strict = `default-src 'none'; script-src 'self'; frame-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'`;
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://localhost').pathname) || 'inline.html';
    const policy = name.startsWith('strict-') ? strict : csp;
    const file = path.join(dir, name);
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'content-security-policy': policy, 'cache-control': 'no-store', 'referrer-policy': 'strict-origin-when-cross-origin' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** Opens "Share and embed" for the intro call in the dashboard and reads the two snippets off the panel. */
async function readSnippets(s, owner) {
  await owner.goto(s.url('/admin/event-types'));
  await owner.getByRole('button', { name: 'More actions for Intro call' }).click();
  await owner.getByRole('menuitem', { name: 'Share and embed' }).click();
  const dialog = owner.getByRole('dialog', { name: 'Share Intro call' });
  await dialog.getByRole('tab', { name: 'On a web page' }).click();
  const inline = await dialog.getByLabel('Embed code for "Intro call"').innerText();
  await dialog.getByRole('tab', { name: 'Popup button' }).click();
  const popup = await dialog.getByLabel('Popup button code for "Intro call"').innerText();
  return { inline: inline.trim(), popup: popup.trim() };
}

/** The two pages of the other website: the snippets pasted in as they are, plus an id to find them by. */
function writeHostPages(dir, snippets) {
  const inline = hostPage('Acme Trees: book a call', `<section id="calendar">\n${snippets.inline.replace('<div ', '<div id="widget" ')}\n</section>`);
  fs.writeFileSync(path.join(dir, 'inline.html'), inline);
  fs.writeFileSync(path.join(dir, 'strict-inline.html'), inline);
  fs.writeFileSync(path.join(dir, 'popup.html'), hostPage('Acme Trees: contact', `<p>Questions? ${snippets.popup.replace('<a ', '<a id="trigger" ')}</p>\n<div class="tall"></div>`));
}

// ───────────────────────── helpers for a framed booking page ─────────────────────────

/** Height the frame element has on the host page, and the height its content needs. */
async function frameHeights(page, frame) {
  const outer = await page.locator('iframe').evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const inner = await frame.locator('main.pp').evaluate((el) => Math.ceil(el.getBoundingClientRect().height));
  const scroll = await frame.locator('html').evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  return { outer, inner, scroll };
}

async function expectFits(s, page, frame, label) {
  await s.eventually(
    async () => {
      const h = await frameHeights(page, frame);
      s.expect(h.outer, `${label}: frame height follows its content (${JSON.stringify(h)})`).toBe(Math.max(240, h.inner));
      s.expect(h.scroll.scrollHeight, `${label}: nothing to scroll inside the frame`).toBeLessThanOrEqual(h.scroll.clientHeight + 1);
      s.expect(h.scroll.scrollWidth, `${label}: nothing sticks out sideways`).toBeLessThanOrEqual(h.scroll.clientWidth + 1);
    },
    { timeout: 4000 },
  );
  return frameHeights(page, frame);
}

export default defineSuite('public-embed', { mockCreds: true }, async (t) => {
  const port = await pickPort();
  const hostOrigin = `http://localhost:${port}`;
  const dir = path.resolve(process.env.E2E_EMBED_DIR || path.join(process.env.E2E_WORK_DIR || os.tmpdir(), 'embed-host'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'host.css'), HOST_CSS);
  fs.writeFileSync(path.join(dir, 'host.js'), HOST_JS);
  const server = await serveHost(dir, port, t.server.origin);
  console.log(`  the embedding page is served from ${hostOrigin} (files in ${dir})`);

  try {
    let snippets = null;

    await t.scenario('the Share panel hands out the embed code', async (s) => {
      const owner = await s.step('prepare', () => prepare(s));

      snippets = await s.step('the owner opens "Share and embed" for the intro call and reads both snippets', async () => {
        const read = await readSnippets(s, owner);
        await s.screenshot(owner, 'share panel, popup code');
        return read;
      });

      await s.step('the code points at the app for both the script and the page', async () => {
        const app = s.url('');
        s.expect(snippets.inline, 'inline code').toBe(
          `<div data-meeting-url="${app}intro"><a href="${app}intro" data-meeting-fallback>Book a meeting</a></div>\n<script src="${app}embed.js" async></script>`,
        );
        s.expect(snippets.popup, 'popup code').toBe(`<a href="${app}intro" data-meeting-popup="${app}intro">Book a meeting</a>\n<script src="${app}embed.js" async></script>`);
        // The script is a plain static file, cacheable, and served as JavaScript.
        const res = await fetch(s.url('/embed.js'));
        s.expect(res.status, 'embed.js status').toBe(200);
        s.expect(res.headers.get('content-type'), 'embed.js type').toMatch(/javascript/);
        // Public pages may be framed by other sites; the dashboard and the co-host page may not.
        const publicPage = await fetch(s.url('/intro?embed=1'));
        s.expect(publicPage.headers.get('x-frame-options'), 'X-Frame-Options on a booking page').toBeNull();
        s.expect(publicPage.headers.get('content-security-policy') ?? '', 'CSP on a booking page').not.toContain('frame-ancestors');
        for (const route of ['/admin/event-types', '/host/host_owner']) {
          s.expect((await fetch(s.url(route))).headers.get('x-frame-options'), `X-Frame-Options on ${route}`).toBe('DENY');
        }
      });

      writeHostPages(dir, snippets);
    });

    await t.scenario('inline embed: the frame sizes itself, and a booking made inside it works', async (s) => {
      const owner = await s.step('prepare', () => prepare(s));
      // Run on its own (-g), this scenario reads the code from the Share panel itself.
      if (!snippets) writeHostPages(dir, (snippets = await readSnippets(s, owner)));
      s.allowLocalOrigin(hostOrigin);
      const page = await s.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: NEW_YORK, locale: 'en-US' });
      const frame = page.frameLocator('#widget iframe');

      await s.step('the other site loads; the script turns the placeholder into a frame of the booking page', async () => {
        await page.goto(`${hostOrigin}/inline.html?utm_source=acme-site`);
        const iframe = page.locator('#widget iframe');
        await iframe.waitFor();
        s.expect(await page.locator('iframe').count(), 'frames on the page').toBe(1);
        const src = new URL(await iframe.getAttribute('src'));
        s.expect(`${src.origin}${src.pathname}`, 'frame address').toBe(s.url('/intro'));
        s.expect(src.searchParams.get('embed'), 'embed mode').toBe('1');
        s.expect(src.searchParams.get('utm_source'), 'campaign tag of the host page is passed along').toBe('acme-site');
        s.expect(await iframe.getAttribute('title'), 'frame title').toBe('Book a meeting');
        // The plain link in the code is only for pages where the script cannot run.
        s.expect(await page.locator('#widget a').count(), 'the fallback link was replaced by the calendar').toBe(0);
        await frame.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
        await frame.locator('.bw-cal:not(.is-loading)').waitFor();
      });

      const heights = {};
      await s.step('the frame is exactly as tall as the calendar inside it, with no page chrome', async () => {
        heights.pick = await expectFits(s, page, frame, 'calendar');
        s.expect(heights.pick.outer, 'the starting height of 680 px was replaced').not.toBe(680);
        // Embedded: no footer credit, no "all meeting types" link, and the host page's own background shows through.
        s.expect(await frame.getByText('Scheduling by').count(), 'footer credit').toBe(0);
        s.expect(await frame.getByRole('link', { name: 'All meeting types' }).count(), 'back link').toBe(0);
        s.expect(await frame.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor), 'frame background').toBe('rgba(0, 0, 0, 0)');
        await s.screenshot(page, 'inline embed, calendar');
      });

      await s.step('picking a time opens the form, and the frame grows with it', async () => {
        await pickDay(frame, '2026-11-18');
        await pickSlot(frame, START);
        await fillDetails(frame, { name: 'Ada Lovelace', email: 'ada@example.com', topic: 'Found you through Acme Trees.' });
        heights.form = await expectFits(s, page, frame, 'form');
        s.expect(heights.form.outer, 'the form is taller than the calendar').toBeGreaterThan(heights.pick.outer);
        await s.screenshot(page, 'inline embed, form');
      });

      const booking = await s.step('confirming inside the frame books the meeting', async () => {
        await s.linger(page);
        await frame.getByRole('button', { name: 'Confirm booking' }).click();
        await frame.getByRole('heading', { name: "You're booked" }).waitFor();
        await s.settle();
        heights.done = await expectFits(s, page, frame, 'confirmation');
        const [stored] = await s.bookings();
        s.expect(stored, 'booking').toMatchObject({
          status: 'confirmed',
          start: START,
          source: 'embed',
          invitee: { name: 'Ada Lovelace', email: 'ada@example.com', timezone: NEW_YORK },
          utm: { utm_source: 'acme-site' },
          google: { meetUrl: /^https:\/\/meet\.google\.com\// },
        });
        s.expect(stored.timeline[0], 'timeline').toMatchObject({ type: 'created', detail: 'Booked through an embedded page' });
        s.expect(await s.outbox({ kind: 'calendar_insert', status: 200 }), 'calendar events').toHaveLength(1);
        s.expect((await s.outbox({ kind: 'email' })).map((e) => e.to.join(',')).sort(), 'emails').toEqual(['ada@example.com', OWNER_GOOGLE]);
        await s.screenshot(page, 'inline embed, confirmation');
        return stored;
      });

      await s.step('the host page is told, through an event on the element it placed', async () => {
        await s.eventually(async () => s.expect(await page.evaluate(() => window.announced.length), 'events announced').toBe(1));
        s.expect(await page.evaluate(() => window.announced), 'what the host page heard').toEqual([{ type: 'meeting:booked', detail: { bookingId: booking.id, start: START, end: '2026-11-18T16:15:00.000Z' }, from: 'widget' }]);
        s.expect(await page.locator('#log').innerText(), 'the host page reacted').toBe(`meeting:booked ${START}`);
      });

      await s.step('the manage links stay inside the frame, in embed mode, and cancelling there is announced too', async () => {
        const cancel = frame.getByRole('link', { name: 'cancel', exact: true });
        s.expect(await cancel.getAttribute('href'), 'cancel link').toBe(`/meeting/booking/${booking.id}/cancel?t=${booking.manageToken}&embed=1`);
        await cancel.click();
        await frame.getByRole('heading', { name: 'Cancel this meeting?', level: 1 }).waitFor();
        await expectFits(s, page, frame, 'cancel form');
        await frame.getByRole('button', { name: 'Cancel meeting' }).click();
        await frame.getByRole('heading', { name: 'This meeting was cancelled', level: 1 }).waitFor();
        await s.settle();
        await expectFits(s, page, frame, 'cancelled');
        s.expect((await s.bookings())[0].status, 'booking').toBe('cancelled');
        s.expect(await page.evaluate(() => window.announced.map((e) => e.type)), 'what the host page heard').toEqual(['meeting:booked', 'meeting:cancelled']);
        // The host page itself never moved.
        s.expect(page.url(), 'host page address').toBe(`${hostOrigin}/inline.html?utm_source=acme-site`);
      });

      await s.step('on a phone the frame fits the narrow page', async () => {
        const phone = await s.newPage({ ...PHONE_VIEWPORT, timezoneId: NEW_YORK, locale: 'en-US' });
        await phone.goto(`${hostOrigin}/inline.html`);
        const narrow = phone.frameLocator('#widget iframe');
        await narrow.locator('.bw-cal:not(.is-loading)').waitFor();
        const h = await expectFits(s, phone, narrow, 'phone');
        s.expect(await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'the host page does not scroll sideways').toBe(true);
        s.expect(h.outer, 'stacked layout is taller than the desktop one').toBeGreaterThan(heights.pick.outer);
        await s.screenshot(phone, 'inline embed on a phone');
      });
    });

    await t.scenario('inline embed on a site that lets nothing in from the app: a plain link instead of an empty box', async (s) => {
      const owner = await s.step('prepare', () => prepare(s));
      if (!snippets) writeHostPages(dir, (snippets = await readSnippets(s, owner)));
      s.allowLocalOrigin(hostOrigin);
      // The browser reports the refused script as a console error: that refusal is the point here.
      s.allowConsoleErrors(/Content Security Policy|Refused to load/);
      const page = await s.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: NEW_YORK, locale: 'en-US' });

      await s.step('the script is refused, the link in the code stays and opens the booking page', async () => {
        await page.goto(`${hostOrigin}/strict-inline.html`);
        const link = page.locator('#widget').getByRole('link', { name: 'Book a meeting' });
        await link.waitFor();
        s.expect(await link.getAttribute('href'), 'where the link goes').toBe(s.url('/intro'));
        // Give the (refused) script time it would have needed to run.
        await page.waitForTimeout(500);
        s.expect(await page.evaluate(() => typeof window.MeetingEmbed), 'the embed script did not run').toBe('undefined');
        s.expect(await page.locator('iframe').count(), 'frames').toBe(0);
        s.expect(await link.isVisible(), 'the link is visible').toBe(true);
        await s.screenshot(page, 'inline embed refused, plain link');
        await link.click();
        await page.waitForURL(s.url('/intro'));
        await page.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      });
    });

    await t.scenario('popup embed: opens over the page, books, and closes cleanly', async (s) => {
      const owner = await s.step('prepare', () => prepare(s));
      if (!snippets) writeHostPages(dir, (snippets = await readSnippets(s, owner)));
      s.allowLocalOrigin(hostOrigin);
      const page = await s.newPage({ viewport: { width: 1280, height: 800 }, timezoneId: NEW_YORK, locale: 'en-US' });
      const trigger = page.locator('#trigger');
      const dialog = page.getByRole('dialog', { name: 'Book a meeting' });
      const frame = page.frameLocator('iframe');

      /** Nothing of the popup is left: no overlay, no frame, scrolling restored, focus back on the link. */
      const expectClosed = async (label) => {
        await dialog.waitFor({ state: 'detached' });
        s.expect(await page.locator('iframe').count(), `${label}: frames left`).toBe(0);
        s.expect(await page.evaluate(() => document.documentElement.style.overflow), `${label}: page scrolling`).toBe('');
        s.expect(await page.evaluate(() => document.activeElement && document.activeElement.id), `${label}: focus`).toBe('trigger');
        s.expect(await page.evaluate(() => document.body.children.length), `${label}: nothing appended to the body is left`).toBe(bodyChildren);
        s.expect(page.url(), `${label}: the page did not navigate`).toBe(`${hostOrigin}/popup.html`);
      };
      let bodyChildren = 0;

      await s.step('the link is an ordinary link until it is clicked', async () => {
        await page.goto(`${hostOrigin}/popup.html`);
        s.expect(await trigger.getAttribute('href'), 'href (works without the script)').toBe(s.url('/intro'));
        s.expect(await page.locator('iframe').count(), 'frames before the click').toBe(0);
        await page.waitForFunction(() => window.MeetingEmbed && window.MeetingEmbed.loaded === true);
        bodyChildren = await page.evaluate(() => document.body.children.length);
      });

      await s.step('a click opens the calendar on top of the page', async () => {
        await trigger.click();
        await dialog.waitFor();
        s.expect(await dialog.getAttribute('aria-modal'), 'modal').toBe('true');
        await frame.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
        await frame.locator('.bw-cal:not(.is-loading)').waitFor();
        // The frame got its height from the page inside it, and the loading note is gone.
        await s.eventually(async () => {
          const outer = await page.locator('iframe').evaluate((el) => Math.round(el.getBoundingClientRect().height));
          const inner = await frame.locator('main.pp').evaluate((el) => Math.ceil(el.getBoundingClientRect().height));
          s.expect(outer, 'popup frame height').toBe(Math.max(240, inner));
        });
        s.expect(await page.getByText('Loading the calendar').count(), 'loading note').toBe(0);
        s.expect(await page.evaluate(() => document.documentElement.style.overflow), 'the page behind does not scroll').toBe('hidden');
        s.expect(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label')), 'focus moved into the popup').toBe('Close');
        s.expect(page.url(), 'the link did not navigate').toBe(`${hostOrigin}/popup.html`);
        await s.screenshot(page, 'popup embed', { fullPage: false });
      });

      await s.step('Escape closes it', async () => {
        await page.keyboard.press('Escape');
        await expectClosed('Escape');
      });

      await s.step('the close button closes it', async () => {
        await trigger.click();
        await dialog.waitFor();
        await page.getByRole('button', { name: 'Close' }).click();
        await expectClosed('close button');
      });

      await s.step('a click beside the calendar closes it; a click inside does not', async () => {
        await trigger.click();
        await dialog.waitFor();
        await frame.locator('.bw-cal:not(.is-loading)').waitFor();
        await frame.getByRole('heading', { name: 'Intro call', level: 1 }).click();
        s.expect(await dialog.count(), 'still open after a click inside').toBe(1);
        await page.mouse.click(8, 400);
        await expectClosed('click outside');
      });

      await s.step('a booking made in the popup works, and the page is told', async () => {
        await trigger.click();
        await dialog.waitFor();
        await pickDay(frame, '2026-11-19');
        s.expect((await offeredSlots(frame)).length, 'times on Thursday').toBe(32);
        await pickSlot(frame, '2026-11-19T15:00:00.000Z');
        await fillDetails(frame, { name: 'Grace Hopper', email: 'grace@example.com' });
        await s.linger(page);
        await frame.getByRole('button', { name: 'Confirm booking' }).click();
        await frame.getByRole('heading', { name: "You're booked" }).waitFor();
        await s.settle();
        const [stored] = await s.bookings();
        s.expect(stored, 'booking').toMatchObject({ start: '2026-11-19T15:00:00.000Z', source: 'embed', invitee: { email: 'grace@example.com' } });
        s.expect(await page.evaluate(() => window.announced), 'what the host page heard').toEqual([{ type: 'meeting:booked', detail: { bookingId: stored.id, start: stored.start, end: stored.end }, from: 'trigger' }]);
        await s.screenshot(page, 'popup embed, booked', { fullPage: false });
      });

      await s.step('Escape also closes it while the focus is inside the calendar (where it is after any use)', async () => {
        // The key is pressed in the framed page, which the page around it never hears about by itself.
        s.expect(await page.evaluate(() => document.activeElement && document.activeElement.tagName), 'focus is in the frame').toBe('IFRAME');
        await page.keyboard.press('Escape');
        await expectClosed('Escape inside the frame');
      });

      await s.step('Escape belongs to the time zone dialog first when that is open inside the popup', async () => {
        await trigger.click();
        await dialog.waitFor();
        await frame.getByRole('button', { name: /^Times are in:/ }).click();
        const zones = frame.getByRole('dialog', { name: 'Choose a time zone' });
        await zones.waitFor();
        await page.keyboard.press('Escape');
        await zones.waitFor({ state: 'hidden' });
        s.expect(await dialog.count(), 'the popup is still open').toBe(1);
        await page.keyboard.press('Escape');
        await expectClosed('second Escape');
      });

      await s.step('opening it again starts fresh, and it can also be driven from code', async () => {
        await trigger.click();
        await dialog.waitFor();
        await frame.getByRole('heading', { name: 'Pick a time' }).waitFor();
        await page.evaluate(() => window.MeetingEmbed.close());
        await expectClosed('MeetingEmbed.close()');
        // Only real web addresses are ever framed.
        s.expect(await page.evaluate(() => window.MeetingEmbed.open('javascript:alert(1)')), 'a javascript: address').toBe(false);
        s.expect(await page.locator('iframe').count(), 'frames').toBe(0);
      });
    });
  } finally {
    await closeServer(server);
  }
});
