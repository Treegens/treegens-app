/**
 * With Eco Champions fully present (the one-time setup has run, and its look and sender name have been changed and
 * saved), Jimi's own pages and messages show nothing of it. The other suites never run the setup, so they cannot see
 * a brand reach Jimi's meetings; this one can (DESIGN 8.2).
 *
 * Jimi's landing, /meeting/intro and /meet are opened, booked and managed. On every page, in every email, text,
 * call, Google event and calendar file of those bookings: no Eco Champions logo or colour, no Eco Champions sender,
 * and the words "Eco Champions" only where Jimi wrote them himself: his welcome text, and the /meet link preview
 * that quotes it.
 */
import { defineSuite } from './lib.mjs';
import { PHONE, PHONE_TYPED, PHONE_VIEWPORT, bookInBrowser, calendarReady, confirmBooking, fillDetails, offeredSlots, pickDay, prepare } from './public-helpers.mjs';

const NY = 'America/New_York';
const TUESDAY = '2026-11-17';
const ECO = 'brand_eco_champions';
/** Jimi's welcome text on the live site, word for word: it names the podcast. */
const WELCOME = 'Host of the Eco Champions podcast and Founder of Treegens. Pick a meeting type below and choose a time that works.';
/** The changed look saved before anything is booked, so a brand that is set up is also a brand that was edited. */
const CHANGED_PRIMARY = '#1d5c40';
const CHANGED_SENDER = 'Eco Champions Studio';
/** The /meet link preview's description (SHORT_LINKS.meet.description in shared/shortLinks.ts): Jimi's own words. */
const MEET_DESCRIPTION = 'Pick a time to talk with Jimi Cohen, Host of the Eco Champions podcast and Founder of Treegens. It goes straight into his calendar.';

/** Hex and rgb() spellings of the brand's built-in green and of the changed one. */
const BRAND_COLOURS = ['#14432f', 'rgb(20, 67, 47)', CHANGED_PRIMARY, 'rgb(29, 92, 64)'];
const BRAND_FILES = ['/brand/eco-champions/', 'builtin_eco_champions_email'];

/** The text with Jimi's own words taken out: his welcome, and the /meet preview that quotes it. */
function withoutJimisWords(text) {
  return String(text ?? '')
    .split(WELCOME)
    .join('')
    .split(MEET_DESCRIPTION)
    .join('');
}

/** Every trace of the brand in a piece of text or markup, as short lines for the failure message. */
function traces(text) {
  const raw = String(text ?? '');
  const lower = raw.toLowerCase();
  const found = [];
  if (/eco\s*champions/i.test(withoutJimisWords(raw))) found.push('the words "Eco Champions"');
  for (const colour of BRAND_COLOURS) if (lower.includes(colour)) found.push(`the colour ${colour}`);
  for (const file of BRAND_FILES) if (lower.includes(file)) found.push(`the file ${file}`);
  if (lower.includes(ECO)) found.push(`the id ${ECO}`);
  return found;
}

/** A page as a visitor sees it: its markup, its text, its title, its look, and what it stored in the browser. */
async function pageTraces(page) {
  const seen = await page.evaluate(() => {
    const scope = document.querySelector('.m-scope') ?? document.documentElement;
    const css = getComputedStyle(scope);
    const stored = [];
    try {
      for (let i = 0; i < localStorage.length; i++) stored.push(localStorage.key(i));
    } catch {
      /* storage blocked */
    }
    return {
      html: document.documentElement.outerHTML,
      text: document.body.innerText,
      title: document.title,
      vars: ['--m-primary', '--m-accent', '--m-bg', '--m-surface'].map((n) => css.getPropertyValue(n).trim()).join(' '),
      stored: stored.join(' '),
      logos: document.querySelectorAll('.bw-summary__logo, .bm__logo').length,
    };
  });
  const found = [...traces(seen.html), ...traces(seen.text), ...traces(seen.title), ...traces(seen.vars)];
  if (seen.stored.includes(ECO)) found.push('a remembered Eco Champions look');
  if (seen.logos) found.push(`${seen.logos} brand logo(s)`);
  return [...new Set(found)];
}

/** Everything sent about these bookings: emails with their calendar files, and texts. */
async function messageTraces(s, emails) {
  const out = [];
  for (const entry of await s.outbox()) {
    const to = [].concat(entry.to ?? []).join(',');
    const about = entry.kind === 'sms' ? to === PHONE : emails.some((e) => to.includes(e)) || /jimi@example\.com/.test(to);
    if (!about) continue;
    const label = `${entry.kind} to ${to} "${entry.subject ?? entry.body?.slice(0, 40) ?? ''}"`;
    const found = [
      ...traces(entry.from),
      ...traces(entry.subject),
      ...traces(entry.html),
      ...traces(entry.text),
      ...traces(entry.body),
      ...traces(entry.ics?.content),
      ...(/Eco Champions/i.test(String(entry.from ?? '')) ? ['an Eco Champions sender'] : []),
    ];
    if (found.length) out.push(`${label}: ${[...new Set(found)].join(', ')}`);
  }
  return out;
}

export default defineSuite('public-no-brand-leak', { mockCreds: true }, async (t) => {
  await t.scenario("with Eco Champions set up and edited, Jimi's own pages and messages show none of it", async (s) => {
    await prepare(s);
    await s.apiOk('PUT', '/admin/hosts/host_owner', { body: { email: 'jimi@example.com' } });
    await s.apiOk('PUT', '/admin/site', { body: { profile: { name: 'Jimi Cohen', headline: 'Book time with Jimi', welcome: WELCOME } } });

    await s.step('the one-time setup runs, and the Eco Champions look and sender name are changed and saved', async () => {
      const moved = await s.runOneTimeMoves();
      s.expect(moved, 'the setup').toMatchObject({ meet: { eventTypeId: 'evt_meeting' }, pod: { eventTypeId: 'evt_eco_champions' } });
      const saved = await s.apiOk('PUT', `/admin/brands/${ECO}`, { body: { theme: { colors: { primary: CHANGED_PRIMARY } }, emailFromName: CHANGED_SENDER } });
      s.expect(saved.brand, 'saved').toMatchObject({ emailFromName: CHANGED_SENDER, theme: { colors: { primary: CHANGED_PRIMARY } } });
      const site = await s.kv('site');
      s.expect(site.profile.welcome, 'the welcome is Jimi\'s, untouched').toBe(WELCOME);
      s.expect(site.theme.preset, 'Jimi\'s look, untouched').toBe('forest');
    });

    const page = await s.newPage({ timezoneId: NY });
    await s.step("Jimi's landing: his welcome is the only place the words appear, and the pod meeting is not listed", async () => {
      await page.goto(s.url('/'));
      await page.getByText(WELCOME).waitFor();
      s.expect(await page.getByRole('link', { name: /Eco Champions conversation/ }).count(), 'the pod meeting is unlisted').toBe(0);
      s.expect(await pageTraces(page), 'brand on the landing').toEqual([]);
      await s.screenshot(page, 'landing');
    });

    const intro = `${TUESDAY}T16:00:00.000Z`; // 11 AM in New York, so the call two hours before is inside calling hours
    let introBooking;
    await s.step('/meeting/intro books with a phone number, in Jimi\'s look', async () => {
      introBooking = await bookInBrowser(s, page, { slug: 'intro', start: intro, zone: NY, details: { name: 'Ada Lovelace', email: 'ada@example.com', phone: PHONE_TYPED, sms: true, call: true } });
      s.expect(introBooking.brandId, 'no brand on the booking').toBe(undefined);
      s.expect(await pageTraces(page), 'brand on the confirmation').toEqual([]);
    });

    const meet = await s.newPage({ timezoneId: NY });
    let meetBooking;
    await s.step('/meet books Jimi alone, in his look, and the page shows nothing of the brand', async () => {
      await meet.goto(s.shortUrl('meet'));
      await calendarReady(meet);
      s.expect(await pageTraces(meet), 'brand on the /meet calendar').toEqual([]);
      await pickDay(meet, TUESDAY);
      const start = `${TUESDAY}T15:00:00.000Z`; // 10 AM in New York, still ahead when the clock moves on for the call
      s.expect((await offeredSlots(meet)).map((x) => x.start), 'times on /meet').toContain(start);
      await meet.locator(`.bw-slot[data-start="${Date.parse(start)}"]`).click();
      await fillDetails(meet, { name: 'Grace Hopper', email: 'grace@example.com' });
      s.expect(await pageTraces(meet), 'brand on the /meet form').toEqual([]);
      await confirmBooking(s, meet);
      await meet.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      s.expect(await pageTraces(meet), 'brand on the /meet confirmation').toEqual([]);
      [meetBooking] = await s.bookings((b) => b.invitee.email === 'grace@example.com');
      s.expect(meetBooking.brandId, 'no brand on the booking').toBe(undefined);
    });

    await s.step('the /meet link preview names the podcast only in Jimi\'s own words', async () => {
      const res = await s.fetchHtml(s.shortUrl('meet'));
      s.expect(res.status, 'status').toBe(200);
      s.expect(traces(res.text), 'brand in the /meet page a crawler reads').toEqual([]);
      s.expect(res.text, 'the description that quotes Jimi').toContain(MEET_DESCRIPTION);
    });

    await s.step('every email, text and calendar file so far is Jimi\'s', async () => {
      const mails = await s.outbox({ kind: 'email' });
      s.expect(mails.length, 'emails sent').toBeGreaterThanOrEqual(2);
      for (const m of mails) s.expect(m.from, `sender of "${m.subject}"`).toMatch(/^Jimi Cohen </);
      const [text] = await s.outbox({ kind: 'sms', to: PHONE });
      s.expect(Boolean(text), 'a text to Ada').toBe(true);
      s.expect(await messageTraces(s, ['ada@example.com', 'grace@example.com']), 'brand in the messages').toEqual([]);
      for (const booking of [introBooking, meetBooking]) {
        const ics = await s.visitor().request('GET', `/public/bookings/${booking.id}/ics`, { query: { t: booking.manageToken } });
        s.expect(ics.status, 'calendar file').toBe(200);
        s.expect(traces(ics.text), `brand in the calendar file of ${booking.eventTitle}`).toEqual([]);
        s.expect(ics.headers.get('content-disposition') ?? '', 'file name').not.toContain('eco-champions');
      }
    });

    await s.step('the Google events are Jimi\'s', async () => {
      const events = (await s.googleEvents('jimi@example.com')).map((e) => e.event);
      s.expect(events.length, 'events written').toBeGreaterThanOrEqual(2);
      for (const event of events) s.expect(traces(JSON.stringify(event)), `brand in "${event.summary}"`).toEqual([]);
    });

    await s.step('the reminder call speaks for Jimi', async () => {
      await s.setClock(`${TUESDAY}T14:00:00.000Z`);
      await s.runJobs();
      const [call] = await s.calls();
      s.expect(Boolean(call), 'a call was placed').toBe(true);
      s.expect(call.record?.script?.brandName, 'no brand on the call').toBe(undefined);
      s.expect(traces(JSON.stringify(call.record?.script ?? {})), 'brand in the call script').toEqual([]);
      const answer = await s.voice(call, 'start');
      s.expect(traces(answer.said), 'brand in what the call says').toEqual([]);
    });

    for (const size of ['desktop', 'phone']) {
      await s.step(`${size}: the manage pages of both bookings are Jimi's, and "Book a new time" stays with Jimi`, async () => {
        const manage = await s.newPage({ timezoneId: NY, ...(size === 'phone' ? PHONE_VIEWPORT : {}) });
        for (const [booking, label] of [
          [meetBooking, 'meet'],
          [introBooking, 'intro'],
        ]) {
          await manage.goto(booking.manageUrl);
          await manage.getByRole('heading', { name: booking.eventTitle }).first().waitFor();
          s.expect(await pageTraces(manage), `brand on the manage page of ${label}`).toEqual([]);
          await s.screenshot(manage, `${label} manage page ${size}`, { fullPage: size === 'desktop' });
        }
      });
    }

    await s.step('cancelling the /meet booking: the page, the email and the way back are Jimi\'s', async () => {
      const manage = await s.newPage({ timezoneId: NY });
      await manage.goto(meetBooking.manageUrl);
      await s.clearOutbox();
      await manage.getByRole('link', { name: 'Cancel meeting' }).click();
      await manage.getByRole('button', { name: 'Cancel meeting' }).click();
      const again = manage.getByRole('link', { name: 'Book a new time' });
      await again.waitFor();
      s.expect(await again.getAttribute('href'), 'book again at /meet').toBe(s.shortUrl('meet'));
      await s.settle();
      s.expect(await pageTraces(manage), 'brand on the cancelled page').toEqual([]);
      const [cancelled] = await s.outbox({ kind: 'email', to: 'grace@example.com' });
      s.expect(cancelled.from, 'sender').toMatch(/^Jimi Cohen </);
      s.expect(await messageTraces(s, ['grace@example.com']), 'brand in the cancellation').toEqual([]);
      await s.screenshot(manage, 'meet manage cancelled');
      await s.screenshotEmail(cancelled, 'meet email cancelled');
    });

    await s.step('rescheduling /meeting/intro: the page and the emails are Jimi\'s', async () => {
      const manage = await s.newPage({ timezoneId: NY });
      await manage.goto(introBooking.manageUrl);
      await s.clearOutbox();
      await manage.getByRole('link', { name: 'Reschedule' }).click();
      await calendarReady(manage);
      s.expect(await pageTraces(manage), 'brand on the reschedule page').toEqual([]);
      await pickDay(manage, '2026-11-18');
      const [slot] = await offeredSlots(manage);
      await manage.locator(`.bw-slot[data-start="${Date.parse(slot.start)}"]`).click();
      await s.linger(manage);
      await manage.locator('.bw-confirmbar').getByRole('button', { name: 'Confirm new time' }).click();
      await manage.getByText('Your meeting has moved').waitFor();
      await s.settle();
      s.expect(await pageTraces(manage), 'brand after the move').toEqual([]);
      const mails = await s.outbox({ kind: 'email' });
      s.expect(mails.length, 'emails about the move').toBeGreaterThanOrEqual(1);
      s.expect(await messageTraces(s, ['ada@example.com']), 'brand in the move messages').toEqual([]);
    });

    await s.step('the check itself sees the brand where it belongs: /pod, in its changed green', async () => {
      const pod = await s.newPage({ timezoneId: NY });
      await pod.goto(s.shortUrl('pod'));
      await calendarReady(pod);
      const found = await pageTraces(pod);
      s.expect(found, 'the words').toContain('the words "Eco Champions"');
      s.expect(found, 'the changed green').toContain(`the colour ${CHANGED_PRIMARY}`);
      s.expect(found, 'the logo').toContain('the file /brand/eco-champions/');
    });
  });
});
