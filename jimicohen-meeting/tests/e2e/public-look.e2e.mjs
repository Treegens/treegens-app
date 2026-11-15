/**
 * Look at it. Every public screen with real data, at desktop width and on a 390 px phone, in the
 * default forest look and in two other presets set through the dashboard API. The screenshots
 * land in tests/e2e/screenshots/public-look/ for a person to read; what a program can judge is
 * asserted here on every screen: nothing sticks out sideways, no text is cut off, the main
 * controls are big enough for a finger, and text has enough contrast on what is behind it.
 */
import { spawnSync } from 'node:child_process';
import { ROOT, defineSuite } from './lib.mjs';
import { PHONE_TYPED, PHONE_VIEWPORT, addCoHost, calendarReady, confirmBooking, createEventType, fillDetails, openEvent, overflowReport, pickDay, pickSlot, prepare } from './public-helpers.mjs';

const NEW_YORK = 'America/New_York';
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const SIZES = [
  ['desktop', DESKTOP],
  ['phone', PHONE_VIEWPORT],
];
/** forest is the default; the other two differ in layout, calendar, time list, buttons and brightness. */
const PRESETS = ['forest', 'paper', 'midnight'];

/** The preset themes, read from shared/presets.ts (the same objects the design editor applies). */
function loadPresets() {
  const script = "import('./shared/presets.ts').then((m) => process.stdout.write(JSON.stringify(m.THEME_PRESETS)))";
  const run = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`Could not read the theme presets: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

/**
 * What a program can see of a screen's quality. Returns a list of problems (empty = fine):
 *  - text that is cut off by its own box (wider than the box, without an ellipsis asked for)
 *  - headings, buttons and form labels whose text overflows
 *  - text whose contrast against the nearest solid background behind it is below 3:1
 */
async function qualityProblems(page) {
  return page.evaluate(() => {
    const problems = [];
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05 && !el.closest('.u-vh') && !el.closest('[aria-hidden="true"]');
    };
    const describe = (el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.textContent || '').trim().slice(0, 40)}"`;

    // Cut-off text.
    for (const el of document.querySelectorAll('h1, h2, h3, button, a, label, p, span, dt, dd, li')) {
      if (!visible(el) || el.children.length > 0 || !(el.textContent || '').trim()) continue;
      const st = getComputedStyle(el);
      if (st.textOverflow === 'ellipsis') continue;
      if (el.scrollWidth > el.clientWidth + 1 && st.overflowX !== 'visible') problems.push(`cut off: ${describe(el)}`);
    }

    // Contrast of text on the nearest opaque background.
    const parse = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const [r, g, b, a = '1'] = m[1].split(/[,\s/]+/).filter(Boolean);
      return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const backdropOf = (el) => {
      // Stack the translucent layers up to the first opaque one. A gradient or image ends the search: not judged.
      const layers = [];
      for (let p = el; p; p = p.parentElement) {
        const st = getComputedStyle(p);
        if (st.backgroundImage && st.backgroundImage !== 'none') return null;
        const bg = parse(st.backgroundColor);
        if (bg && bg.a > 0) {
          layers.push(bg);
          if (bg.a >= 0.999) break;
        }
      }
      if (!layers.length || layers.at(-1).a < 0.999) return null;
      let colour = layers.pop();
      while (layers.length) colour = over(layers.pop(), colour);
      return colour;
    };
    const seen = new Set();
    for (const el of document.querySelectorAll('h1, h2, h3, p, span, a, button, label, dd, li')) {
      if (!visible(el) || el.children.length > 0) continue;
      const text = (el.textContent || '').trim();
      if (text.length < 2 || el.closest('[disabled], [aria-disabled="true"], .is-outside, .is-past')) continue;
      const st = getComputedStyle(el);
      const fg = parse(st.color);
      const bg = backdropOf(el);
      if (!fg || !bg) continue;
      const colour = fg.a < 1 ? over(fg, bg) : fg;
      const [hi, lo] = [lum(colour), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const key = `${el.className}|${Math.round(ratio * 10)}`;
      if (ratio < 3 && !seen.has(key)) {
        seen.add(key);
        problems.push(`low contrast ${ratio.toFixed(2)}: ${describe(el)}`);
      }
    }
    return problems;
  });
}

export default defineSuite('public-look', { mockCreds: true }, async (t) => {
  const presets = loadPresets();

  for (const key of PRESETS) {
    await t.scenario(`${key}: every public screen on desktop and phone`, async (s) => {
      const preset = presets.find((p) => p.key === key);
      if (!preset) throw new Error(`No preset called ${key}`);
      s.allowConsoleErrors(/status of 404/);

      await s.step(`prepare: a site with real data in the ${preset.label} look`, async () => {
        const owner = await prepare(s);
        await s.apiOk('PUT', '/admin/site', {
          body: {
            theme: preset.theme,
            profile: {
              headline: 'Book time with Jimi',
              welcome: 'Pick a meeting type below and choose a time that works. Times show in your own time zone.\n\nI plant trees with communities in Kenya and Ethiopia, and I am always glad to talk about how to do it well.',
              links: [
                { label: 'jimicohen.com', url: 'https://jimicohen.com' },
                { label: 'Treegens', url: 'https://treegens.app' },
              ],
            },
          },
        });
        const alex = await addCoHost(s, owner, { name: 'Alexandria Wanjiru-Kimani', email: 'alex@example.com', zone: 'Africa/Nairobi' });
        await createEventType(s, {
          title: 'Partnership deep dive with the whole team',
          slug: 'joint',
          kind: 'collective',
          hostIds: ['host_owner', alex.id],
          durations: [30, 60],
          defaultDuration: 30,
          emoji: '🤝',
          description: 'A longer conversation with both of us about restoration projects, funding and reporting.\n\nPlease share a few lines about your organisation beforehand.',
          locations: [{ type: 'google_meet' }, { type: 'in_person', value: 'Karura Forest Environmental Education Trust, Limuru Road, Nairobi' }, { type: 'phone_host_calls' }],
        });
        s.expect((await s.visitor().ok('GET', '/public/site')).theme.preset, 'theme in force').toBe(key);
      });

      for (const [size, options] of SIZES) {
        const shot = async (page, label) => {
          // Let fonts settle and colour transitions end (a day that was just picked fades in), then judge and capture.
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(350);
          s.expect(await overflowReport(page), `${size} ${label}: sideways overflow`).toMatchObject({ scrolls: false, offenders: [] });
          s.expect(await qualityProblems(page), `${size} ${label}: quality problems`).toEqual([]);
          await s.screenshot(page, `${key} ${size} ${label}`);
        };
        const page = await s.newPage({ ...options, timezoneId: NEW_YORK, locale: 'en-US' });
        const start = size === 'desktop' ? '2026-11-18T16:00:00.000Z' : '2026-11-19T16:00:00.000Z';
        const person = size === 'desktop' ? { name: 'Ada Lovelace', email: 'ada@example.com' } : { name: 'Grace Brewster Murray Hopper', email: 'grace.hopper.the.admiral@navy.example.com' };

        await s.step(`${size}: landing`, async () => {
          await page.goto(s.url('/'));
          await page.getByRole('heading', { name: 'Book time with Jimi', level: 1 }).waitFor();
          await shot(page, '01 landing');
        });

        await s.step(`${size}: event page with a choice of lengths`, async () => {
          await openEvent(s, page, 'meeting');
          await pickDay(page, '2026-11-18');
          await shot(page, '02 event page');
          if (size === 'phone') {
            // Fingers: days and times are tall enough to hit.
            const day = await page.locator('.bw-day[data-day="2026-11-18"]').boundingBox();
            const slot = await page.locator('.bw-slot').first().boundingBox();
            s.expect(Math.round(day.height), 'day cell height').toBeGreaterThanOrEqual(40);
            s.expect(Math.round(slot.height), 'time button height').toBeGreaterThanOrEqual(44);
          }
        });

        await s.step(`${size}: joint event with two hosts, a long title and three places to meet`, async () => {
          await openEvent(s, page, 'joint');
          await shot(page, '03 joint event page');
        });

        await s.step(`${size}: the time zone dialog`, async () => {
          await page.getByRole('button', { name: /^Times are in:/ }).click();
          const dialog = page.getByRole('dialog', { name: 'Choose a time zone' });
          await dialog.getByRole('combobox', { name: 'Search time zones' }).fill('new');
          await dialog.getByRole('option').first().waitFor();
          await s.screenshot(page, `${key} ${size} 04 time zone dialog`, { fullPage: false });
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
        });

        await s.step(`${size}: details form, first with mistakes, then filled in`, async () => {
          await openEvent(s, page, 'intro');
          await pickDay(page, start.slice(0, 10));
          await pickSlot(page, start);
          const form = page.getByRole('form', { name: 'Your details' });
          await form.waitFor();
          await form.getByRole('textbox', { name: 'Email', exact: true }).fill('not-an-email');
          await page.getByRole('button', { name: 'Confirm booking' }).click();
          await form.getByText('Please enter your name.').waitFor();
          await form.getByText('That email address does not look right.').waitFor();
          await shot(page, '05 form with errors');
          await fillDetails(page, { ...person, phone: PHONE_TYPED, guests: ['charles.babbage@analytical-engines.example.org'], topic: 'How do you keep seedlings alive through the first dry season? We lost about a third last year and would love to compare notes.' });
          s.expect(await form.getByText('Please enter your name.').count(), 'the name error went away').toBe(0);
          await shot(page, '06 form filled');
        });

        await s.step(`${size}: confirmation`, async () => {
          await confirmBooking(s, page);
          await page.getByRole('heading', { name: "You're booked" }).waitFor();
          await s.settle();
          // Let the confetti finish before the picture is taken.
          await s.linger(page, 6000);
          await shot(page, '07 confirmation');
        });

        // By address, not by position: with the clock frozen every booking has the same creation time.
        const [booking] = await s.bookings((b) => b.invitee.email === person.email);

        await s.step(`${size}: the booking page from the email`, async () => {
          await page.goto(booking.manageUrl);
          await page.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
          await shot(page, '08 manage');
        });

        await s.step(`${size}: reschedule, with a new time chosen`, async () => {
          await page.getByRole('link', { name: 'Reschedule' }).click();
          await page.getByRole('heading', { name: 'Pick a new time' }).waitFor();
          await calendarReady(page);
          await pickDay(page, '2026-11-20');
          await pickSlot(page, '2026-11-20T15:30:00.000Z');
          await page.getByRole('button', { name: 'Confirm new time' }).waitFor();
          await shot(page, '09 reschedule');
        });

        await s.step(`${size}: cancel form, then the cancelled booking`, async () => {
          await page.goto(`${s.url(`/booking/${booking.id}/cancel`)}?t=${booking.manageToken}`);
          await page.getByRole('heading', { name: 'Cancel this meeting?', level: 1 }).waitFor();
          await page.getByRole('textbox', { name: /Anything you would like to say/ }).fill('Something came up at the nursery. I will book again next week.');
          await shot(page, '10 cancel form');
          await page.getByRole('button', { name: 'Cancel meeting' }).click();
          await page.getByRole('heading', { name: 'This meeting was cancelled', level: 1 }).waitFor();
          await s.settle();
          await shot(page, '11 cancelled');
        });

        await s.step(`${size}: a link that leads nowhere`, async () => {
          await page.goto(s.url('/no-such-meeting'));
          await page.getByRole('heading', { name: 'This meeting type is not available', level: 1 }).waitFor();
          await shot(page, '12 not available');
        });
      }
    });
  }
});
