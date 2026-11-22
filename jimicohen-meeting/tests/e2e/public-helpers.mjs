/**
 * Shared pieces of the public-*.e2e.mjs suites: what a visitor does on the booking pages, and
 * small independent calculations (wall clock times with Intl) the suites compare the app with.
 * Not a suite itself: the runner only picks up files that end in .e2e.mjs.
 */

/** Monday 09:00 in London (GMT in November). Starter hours are Monday to Friday, 09:00 to 17:00. */
export const MONDAY = '2026-11-16T09:00:00.000Z';
export const OWNER_GOOGLE = 'jimi@example.com';
export const FROM_EMAIL = 'meetings@jimicohen.test';
/** A US number the phone library accepts, as people type it and as the server stores it. */
export const PHONE_TYPED = '4155552671';
export const PHONE = '+14155552671';
/** The number every reminder call gives for calling back (Settings, AI assistant), and how it is read to a US number. */
export const CALLBACK = '+12125550100';
export const REACH = 'To reach Jimi, call 2 1 2, 5 5 5, 0 1 0 0.';
export const PHONE_VIEWPORT = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const iso = (ms) => new Date(ms).toISOString();
export const plus = (at, ms) => iso(Date.parse(at) + ms);

// ───────────────────────── independent time maths (Intl only) ─────────────────────────

const clean = (text) => text.replace(/[  ]/g, ' ');

/** "9:00 AM" or "09:00": what a clock on the wall of `zone` shows at that instant. */
export function wallTime(at, zone, { hour12 = true, locale = 'en-US' } = {}) {
  const options = hour12 ? { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' } : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  return clean(new Intl.DateTimeFormat(locale, { timeZone: zone, ...options }).format(new Date(at)));
}

/** "2026-11-18": the calendar day of that instant in `zone`. */
export function wallDay(at, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** "Wednesday, November 18": how the page names a day. */
export function dayName(day, locale = 'en-US') {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${day}T12:00:00Z`));
}

/** "Wednesday, November 18, 2026" */
export function longDate(at, zone, locale = 'en-US') {
  return new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(at));
}

/** Minutes east of UTC at that instant, read from the zone's own clock. */
export function offsetMinutes(at, zone) {
  const ms = Date.parse(at);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE);
}

/** The instant at which the wall clock of `zone` shows `day` `time` ("2026-11-18", "09:30"). */
export function zoned(day, time, zone) {
  const [h, m] = time.split(':').map(Number);
  const naive = Date.parse(`${day}T00:00:00Z`) + h * HOUR + m * MINUTE;
  // Two rounds settle on the right offset on days when the clocks change.
  let guess = naive - offsetMinutes(iso(naive), zone) * MINUTE;
  guess = naive - offsetMinutes(iso(guess), zone) * MINUTE;
  return iso(guess);
}

/** 0 = Sunday … 6 = Saturday for a "YYYY-MM-DD" day. */
export function weekdayOf(day) {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

export function addDays(day, n) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

// ───────────────────────── preparing a site ─────────────────────────

/**
 * A fresh site at a frozen time: the owner is set up and signed in, Google Calendar is connected
 * through the real routes, and mail goes out through the real provider path (a from address is
 * set, so nothing falls back to the development shortcut). Returns the owner's dashboard page.
 */
export async function prepare(s, { clock = MONDAY, zone = 'Europe/London', google = OWNER_GOOGLE, fromEmail = FROM_EMAIL, connect = true } = {}) {
  await s.reset();
  await s.setClock(clock);
  await s.setupAdmin({ timezone: zone });
  if (fromEmail) await s.apiOk('PUT', '/admin/site', { body: { email: { fromEmail } } });
  // Without a callback number no reminder call is placed (server/lib/voice.ts usableCallbackNumber).
  await s.apiOk('PUT', '/admin/site', { body: { assistant: { callbackNumber: CALLBACK } } });
  const page = await s.newPage({ signedIn: true, timezoneId: zone, locale: 'en-GB' });
  if (connect) {
    const { result } = await s.connectGoogle(page, google, zone, { start: { hostId: 'host_owner' } });
    s.expect(result.status, `owner google connect (${result.reason ?? 'no reason'})`).toBe('connected');
  }
  return page;
}

/** Adds a co-host through the dashboard API and connects their Google account (as the owner may). Returns the host. */
export async function addCoHost(s, ownerPage, { name, email, zone, google = email, weekly, connect = true }) {
  const created = await s.apiOk('POST', '/admin/hosts', { body: { name, email } });
  const id = created.host.id;
  if (connect) {
    const { result } = await s.connectGoogle(ownerPage, google, zone, { start: { hostId: id } });
    s.expect(result.status, `${name} google connect (${result.reason ?? 'no reason'})`).toBe('connected');
  } else {
    await s.apiOk('PUT', `/admin/hosts/${id}`, { body: { timezoneMode: 'fixed', timezone: zone } });
  }
  if (weekly) {
    const hours = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], ...weekly };
    await s.apiOk('PUT', `/admin/hosts/${id}`, { body: { schedules: [{ id: 'sch_default', name: 'Working hours', weekly: hours, overrides: [] }], defaultScheduleId: 'sch_default' } });
  }
  const host = (await s.kv('hosts')).find((h) => h.id === id);
  return { ...host, inviteUrl: created.inviteUrl };
}

/** Creates an event type through the dashboard API and returns it. */
export async function createEventType(s, body) {
  return (await s.apiOk('POST', '/admin/event-types', { body })).eventType;
}

// ───────────────────────── what a visitor does ─────────────────────────

/** Waits until the month on screen has loaded its times (or says there are none). */
export async function calendarReady(page) {
  await page.locator('.bw-cal:not(.is-loading)').waitFor();
}

/** Opens the page of one meeting type and waits for the calendar. */
export async function openEvent(s, page, slug, query = '') {
  await page.goto(s.url(`/${slug}${query}`));
  await calendarReady(page);
}

/** Days of the month on screen that can be picked: [{ day: '2026-11-18', label, count }]. */
export async function offeredDays(page) {
  await calendarReady(page);
  return page.locator('.bw-day.is-open').evaluateAll((nodes) =>
    nodes.map((n) => ({ day: n.dataset.day, label: n.getAttribute('aria-label'), count: Number(/(\d+) times? available/.exec(n.getAttribute('aria-label') ?? '')?.[1] ?? 0) })),
  );
}

/** Times offered for the chosen day: [{ start: ISO, label: '9:00 AM' }]. */
export async function offeredSlots(page) {
  return page.locator('.bw-slot').evaluateAll((nodes) => nodes.map((n) => ({ start: new Date(Number(n.dataset.start)).toISOString(), label: n.querySelector('.bw-slot__time').textContent })));
}

/** Picks a day in the month on screen, by its date ("2026-11-18"), and waits for its times. */
export async function pickDay(page, day, locale = 'en-US') {
  await calendarReady(page);
  await page.locator(`.bw-day[data-day="${day}"]`).click();
  await page.getByRole('heading', { name: dayName(day, locale), exact: true }).waitFor();
}

/** Presses the time that starts at that instant. */
export async function pickSlot(page, start) {
  await page.locator(`.bw-slot[data-start="${Date.parse(start)}"]`).click();
}

/**
 * Fills the details form. `phone` is typed as given; `sms` / `call` set the two reminder
 * switches when a number is there; `guests` are added one by one; `topic` answers the starter question.
 */
export async function fillDetails(page, { name, email, phone, sms, call, guests = [], topic } = {}) {
  const form = page.getByRole('form', { name: 'Your details' });
  await form.waitFor();
  if (name !== undefined) await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  if (email !== undefined) await form.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  if (phone !== undefined) {
    const field = form.locator('input[type="tel"]');
    await field.click();
    await field.pressSequentially(phone);
    for (const [wanted, label] of [
      [sms, 'Text me the confirmation and reminders'],
      [call, /^Reminder call from /],
    ]) {
      if (wanted === undefined) continue;
      const toggle = form.getByRole('switch', { name: label });
      if (((await toggle.getAttribute('aria-checked')) === 'true') !== wanted) await toggle.click();
    }
  }
  if (topic !== undefined) await form.getByRole('textbox', { name: 'What would you like to talk about?' }).fill(topic);
  for (const guest of guests) {
    const add = form.getByRole('button', { name: 'Add guests' });
    if (await add.isVisible()) await add.click();
    const field = form.getByRole('textbox', { name: /^Guests/ });
    await field.fill(guest);
    await field.press('Enter');
    await form.getByRole('list', { name: 'Guests added' }).getByText(guest, { exact: true }).waitFor();
  }
  return form;
}

/** Presses the confirm button the way a person would: after a moment, not within the bot window. */
export async function confirmBooking(s, page, label = 'Confirm booking') {
  await s.linger(page);
  await page.getByRole('button', { name: label }).click();
}

/** The whole visit: open the event, pick the day and time, fill the form, confirm, wait for the confirmation. */
export async function bookInBrowser(s, page, { slug = 'intro', start, zone, details, query = '' }) {
  await openEvent(s, page, slug, query);
  const day = wallDay(start, zone);
  // The calendar opens on the first month with a free time; move on when the day is in a later one.
  for (let i = 0; i < 3 && (await page.locator(`.bw-day[data-day="${day}"]`).count()) === 0; i++) {
    await page.getByRole('button', { name: 'Next month' }).click();
    await calendarReady(page);
  }
  await pickDay(page, day);
  await pickSlot(page, start);
  await fillDetails(page, details);
  await confirmBooking(s, page);
  await page.getByRole('heading', { name: "You're booked" }).waitFor();
  await s.settle();
  // Found by start and address, not by position: with the clock frozen all bookings share one creation time.
  const mine = await s.bookings((b) => b.start === start && (!details?.email || b.invitee.email === details.email));
  return mine.at(-1);
}

/** What the manage API says about a booking, as the invitee's browser would read it. */
export async function manageView(s, booking) {
  return s.visitor().ok('GET', `/public/bookings/${booking.id}`, { query: { t: booking.manageToken } });
}

/** Queued jobs as short lines: "2026-11-17T16:00:00.000Z reminder email invitee". */
export async function jobLines(s, filter) {
  return (await s.jobs(filter)).map((j) => `${j.dueAt} ${j.kind ?? j.type} ${j.channel ?? '-'} ${j.audience ?? '-'}`);
}

/** No horizontal overflow: nothing sticks out of the viewport and the page does not scroll sideways. */
export async function overflowReport(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.visibility === 'hidden' || style.display === 'none') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > width + 1 || rect.left < -1) {
        // Something inside a scroller or a clipped box is allowed to be wider than the page.
        let clipped = false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(`${o.overflowX}`)) {
            clipped = true;
            break;
          }
        }
        if (!clipped && !el.closest('.u-vh')) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} right=${Math.round(rect.right)} left=${Math.round(rect.left)}`);
      }
    }
    return { scrolls: document.documentElement.scrollWidth > width + 1, width, scrollWidth: document.documentElement.scrollWidth, offenders: offenders.slice(0, 8) };
  });
}
