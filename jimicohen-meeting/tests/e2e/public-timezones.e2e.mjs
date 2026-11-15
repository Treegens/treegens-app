/**
 * Automatic time zones. The same event opened from Nairobi, Los Angeles and Kolkata offers the
 * same instants, each written as that visitor's own clock shows them (expected values are
 * computed here with Intl, not taken from the app), on the day it is for them. The zone can be
 * changed by hand, the clock can be 12 or 24 hours, and the zone on screen is the zone the
 * booking carries. The last scenario books across a daylight saving change.
 */
import { defineSuite } from './lib.mjs';
import {
  HOUR,
  MINUTE,
  MONDAY,
  OWNER_GOOGLE,
  calendarReady,
  confirmBooking,
  dayName,
  fillDetails,
  jobLines,
  offeredDays,
  offeredSlots,
  openEvent,
  pickDay,
  pickSlot,
  plus,
  prepare,
  wallDay,
  wallTime,
} from './public-helpers.mjs';

/** Owner hours for this suite: Monday to Friday, 14:00 to 22:00 in London, so evenings spill into the next day further east. */
const LATE_HOURS = { 1: [{ start: '14:00', end: '22:00' }], 2: [{ start: '14:00', end: '22:00' }], 3: [{ start: '14:00', end: '22:00' }], 4: [{ start: '14:00', end: '22:00' }], 5: [{ start: '14:00', end: '22:00' }] };

const ZONES = [
  { zone: 'Africa/Nairobi', label: 'East Africa Time (Nairobi)', utcOffset: 180 },
  { zone: 'America/Los_Angeles', label: 'Pacific Time (Los Angeles)', utcOffset: -480 },
  { zone: 'Asia/Kolkata', label: 'India Standard Time (Kolkata)', utcOffset: 330 },
];

/**
 * What the owner offers, worked out here from the rules alone: quarter hours from 14:00 to 21:45
 * London time (GMT in November, so UTC) on weekdays, from Monday 16 to Friday 27 November.
 */
function expectedInstants() {
  const out = [];
  for (let d = 16; d <= 27; d++) {
    const midnight = Date.UTC(2026, 10, d);
    const weekday = new Date(midnight).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (let minutes = 14 * 60; minutes <= 21 * 60 + 45; minutes += 15) out.push(new Date(midnight + minutes * MINUTE).toISOString());
  }
  return out;
}

function groupByDay(instants, zone) {
  const days = new Map();
  for (const at of instants) {
    const day = wallDay(at, zone);
    days.set(day, [...(days.get(day) ?? []), at]);
  }
  return days;
}

async function setLateHours(s) {
  await s.apiOk('PUT', '/admin/hosts/host_owner', { body: { schedules: [{ id: 'sch_default', name: 'Working hours', weekly: { 0: [], 6: [], ...LATE_HOURS }, overrides: [] }] } });
}

export default defineSuite('public-timezones', { mockCreds: true }, async (t) => {
  await t.scenario('Nairobi, Los Angeles and Kolkata see the same instants on their own clocks and days', async (s) => {
    await s.step('prepare: the owner works 14:00 to 22:00 in London', async () => {
      await prepare(s);
      await setLateHours(s);
    });

    const instants = expectedInstants();
    const window = { from: '2026-11-16T00:00:00.000Z', to: '2026-11-28T00:00:00.000Z' };

    await s.step('the API offers exactly the instants the rules give', async () => {
      s.expect(instants.length, 'expected instants').toBe(10 * 32);
      s.expect(await s.slots({ slug: 'intro', duration: 15, ...window }), 'slots from the API').toEqual(instants);
    });

    const seen = {};
    for (const { zone, label, utcOffset } of ZONES) {
      await s.step(`${zone}: label detected, days and clock times as that visitor's own`, async () => {
        const page = await s.newPage({ timezoneId: zone, locale: 'en-US' });
        await openEvent(s, page, 'intro');
        await page.getByRole('button', { name: `Times are in: ${label}. Change` }).waitFor();

        // The days of those two weeks, as this zone cuts them.
        const expected = groupByDay(instants, zone);
        const days = (await offeredDays(page)).filter((d) => d.day <= [...expected.keys()].at(-1));
        s.expect(days.map((d) => [d.day, d.count]), `open days in ${zone}`).toEqual([...expected].map(([day, list]) => [day, list.length]));

        // Every day: the same instants, labelled with this zone's wall clock.
        const collected = [];
        for (const [day, list] of expected) {
          await pickDay(page, day);
          const slots = await offeredSlots(page);
          s.expect(slots.map((x) => x.start), `instants on ${day} in ${zone}`).toEqual(list);
          s.expect(slots.map((x) => x.label), `labels on ${day} in ${zone}`).toEqual(list.map((at) => wallTime(at, zone)));
          collected.push(...slots.map((x) => x.start));
        }
        seen[zone] = collected;
        s.expect(collected, `all instants seen from ${zone}`).toEqual(instants);

        // One instant spelled out by hand, so the comparison above cannot be wrong in the same way twice:
        // Monday 14:00 UTC is 5:00 PM in Nairobi, 6:00 AM in Los Angeles and 7:30 PM in Kolkata.
        const byHand = { 'Africa/Nairobi': '5:00 PM', 'America/Los_Angeles': '6:00 AM', 'Asia/Kolkata': '7:30 PM' }[zone];
        s.expect(wallTime('2026-11-16T14:00:00.000Z', zone), `Intl for ${zone}`).toBe(byHand);
        await pickDay(page, '2026-11-16');
        s.expect((await offeredSlots(page))[0], `first time on Monday in ${zone}`).toEqual({ start: '2026-11-16T14:00:00.000Z', label: byHand });
        s.expect(utcOffset, 'offset noted for the reader').toBe({ 'Africa/Nairobi': 180, 'America/Los_Angeles': -480, 'Asia/Kolkata': 330 }[zone]);
        await s.screenshot(page, `event page in ${zone}`);
      });
    }

    await s.step('days shift across midnight where they should', async () => {
      // Friday evening in London is already Saturday in Nairobi (from 21:00 UTC) and in Kolkata (from 18:30 UTC):
      // both see times on a Saturday although the owner never works on one. Los Angeles does not.
      const friday = instants.filter((at) => at.startsWith('2026-11-20'));
      const onSaturday = (zone) => friday.filter((at) => wallDay(at, zone) === '2026-11-21');
      s.expect(onSaturday('Africa/Nairobi').length, 'Friday times that are Saturday in Nairobi').toBe(4);
      s.expect(onSaturday('Asia/Kolkata').length, 'Friday times that are Saturday in Kolkata').toBe(14);
      s.expect(onSaturday('America/Los_Angeles').length, 'Friday times that are Saturday in Los Angeles').toBe(0);

      const kolkata = await s.newPage({ timezoneId: 'Asia/Kolkata' });
      await openEvent(s, kolkata, 'intro');
      const saturday = (await offeredDays(kolkata)).find((d) => d.day === '2026-11-21');
      s.expect(saturday, 'Saturday in Kolkata').toMatchObject({ count: 14, label: 'Saturday, November 21, 14 times available' });
      await pickDay(kolkata, '2026-11-21');
      const slots = await offeredSlots(kolkata);
      s.expect(slots[0], 'first Saturday time in Kolkata').toEqual({ start: '2026-11-20T18:30:00.000Z', label: '12:00 AM' });
      s.expect(slots.at(-1), 'last Saturday time in Kolkata').toEqual({ start: '2026-11-20T21:45:00.000Z', label: '3:15 AM' });
      // Monday is shorter there: the last 14 quarter hours of Monday's London evening are Tuesday.
      s.expect((await offeredDays(kolkata)).find((d) => d.day === '2026-11-16').count, 'Monday in Kolkata').toBe(18);
      s.expect((await offeredDays(kolkata)).find((d) => d.day === '2026-11-17').count, 'Tuesday in Kolkata').toBe(32);

      const la = await s.newPage({ timezoneId: 'America/Los_Angeles' });
      await openEvent(s, la, 'intro');
      s.expect(await la.locator('.bw-day[data-day="2026-11-21"]').getAttribute('aria-label'), 'Saturday in Los Angeles').toBe('Saturday, November 21, no times available');
    });
  });

  await t.scenario('the zone can be changed by hand, the clock can be 12 or 24 hours, and the booking carries the zone on screen', async (s) => {
    await s.step('prepare', async () => {
      await prepare(s);
      await setLateHours(s);
    });
    const page = await s.newPage({ timezoneId: 'Africa/Nairobi', locale: 'en-US' });
    const instants = expectedInstants().filter((at) => at.startsWith('2026-11-18'));

    await s.step('detected zone: Wednesday in Nairobi', async () => {
      await openEvent(s, page, 'intro');
      await page.getByRole('button', { name: 'Times are in: East Africa Time (Nairobi). Change' }).waitFor();
      await pickDay(page, '2026-11-18');
      const slots = await offeredSlots(page);
      // Wednesday there starts with the end of Tuesday's London evening (21:00 to 21:45 UTC is 12:00 to 12:45 AM),
      // then Wednesday 14:00 to 20:45 UTC, which is 5:00 PM to 11:45 PM. The last hour of Wednesday is Thursday there.
      const expected = groupByDay(expectedInstants(), 'Africa/Nairobi').get('2026-11-18');
      s.expect(slots.map((x) => x.start), 'instants in Nairobi').toEqual(expected);
      s.expect(slots.map((x) => x.label), 'labels in Nairobi').toEqual(['12:00 AM', '12:15 AM', '12:30 AM', '12:45 AM', ...instants.slice(0, 28).map((at) => wallTime(at, 'Africa/Nairobi'))]);
      s.expect(slots[4].label, 'first of the evening').toBe('5:00 PM');
      s.expect(slots.at(-1).label, 'last').toBe('11:45 PM');
    });

    await s.step('switching to Tokyo re-renders the same instants on Tokyo clocks', async () => {
      await page.getByRole('button', { name: /^Times are in:/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Choose a time zone' });
      await dialog.getByRole('combobox', { name: 'Search time zones' }).fill('tokyo');
      await dialog.getByRole('option', { name: /Tokyo/ }).first().click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Times are in: Japan Standard Time (Tokyo). Change' }).waitFor();
      await calendarReady(page);

      // Wednesday 14:00 UTC is 11:00 PM in Tokyo: 4 of Wednesday's times stay on Wednesday, the rest are Thursday morning.
      const tokyo = (at) => wallTime(at, 'Asia/Tokyo');
      const tuesday = expectedInstants().filter((at) => at.startsWith('2026-11-17'));
      await pickDay(page, '2026-11-18');
      const wednesday = await offeredSlots(page);
      const expected = [...tuesday.filter((at) => wallDay(at, 'Asia/Tokyo') === '2026-11-18'), ...instants.filter((at) => wallDay(at, 'Asia/Tokyo') === '2026-11-18')];
      s.expect(wednesday.map((x) => x.start), 'instants on Wednesday in Tokyo').toEqual(expected);
      s.expect(wednesday.map((x) => x.label), 'labels on Wednesday in Tokyo').toEqual(expected.map(tokyo));
      s.expect(wednesday.at(-1), 'last time on Wednesday in Tokyo').toEqual({ start: '2026-11-18T14:45:00.000Z', label: '11:45 PM' });
      await pickDay(page, '2026-11-19');
      s.expect((await offeredSlots(page))[0], 'first time on Thursday in Tokyo').toEqual({ start: '2026-11-18T15:00:00.000Z', label: '12:00 AM' });
      await s.screenshot(page, 'after switching to Tokyo');
    });

    await s.step('the 24 hour clock, and back', async () => {
      const before = await offeredSlots(page);
      await page.getByRole('radio', { name: '24 hour clock' }).click();
      const in24 = await offeredSlots(page);
      s.expect(in24.map((x) => x.start), 'instants do not change with the clock style').toEqual(before.map((x) => x.start));
      s.expect(in24.map((x) => x.label), '24 hour labels').toEqual(before.map((x) => wallTime(x.start, 'Asia/Tokyo', { hour12: false })));
      s.expect(in24[0].label, 'midnight on a 24 hour clock').toBe('00:00');
      // Thursday in Tokyo: the rest of Wednesday's London evening until 06:45, then the start of Thursday's from 23:00.
      s.expect(in24.map((x) => x.label).slice(27, 29), 'around the gap').toEqual(['06:45', '23:00']);
      s.expect(in24.at(-1).label, 'last time').toBe('23:45');
      await page.getByRole('radio', { name: '12 hour clock' }).click();
      s.expect((await offeredSlots(page))[0].label, 'midnight on a 12 hour clock').toBe('12:00 AM');
      await page.getByRole('radio', { name: '24 hour clock' }).click();
    });

    await s.step('the choice survives a reload, and the device zone is one tap away', async () => {
      await page.reload();
      await calendarReady(page);
      await page.getByRole('button', { name: 'Times are in: Japan Standard Time (Tokyo). Change' }).waitFor();
      s.expect(await page.getByRole('radio', { name: '24 hour clock' }).getAttribute('aria-checked'), '24 hour clock remembered').toBe('true');
      await page.getByRole('button', { name: /^Times are in:/ }).click();
      await page.getByRole('dialog', { name: 'Choose a time zone' }).getByRole('button', { name: 'Use my device time zone: East Africa Time (Nairobi)' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: 'Choose a time zone' }).waitFor({ state: 'hidden' });
    });

    const start = '2026-11-18T15:00:00.000Z'; // Thursday 00:00 in Tokyo, Wednesday 6:00 PM in Nairobi
    const booking = await s.step('books Thursday 00:00 Tokyo time: summary, confirmation and booking all say Tokyo', async () => {
      await pickDay(page, '2026-11-19');
      await pickSlot(page, start);
      await fillDetails(page, { name: 'Yuki Tanaka', email: 'yuki@example.com' });
      const summary = page.locator('.bw-summary');
      await summary.getByText('Thursday, November 19').waitFor();
      await summary.getByText('00:00 – 00:15').waitFor();
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      const facts = (await page.locator('.bk-facts').innerText()).replace(/\s+/g, ' ');
      s.expect(facts, 'confirmation').toContain('Thursday, November 19, 2026 00:00 – 00:15 Japan Standard Time (Tokyo)');
      const [stored] = await s.bookings();
      s.expect(stored, 'stored booking').toMatchObject({ start, invitee: { timezone: 'Asia/Tokyo' } });
      await s.screenshot(page, 'confirmation in Tokyo time');
      return stored;
    });

    await s.step('the email speaks Tokyo time to the invitee and London time to the host', async () => {
      const [mail] = await s.outbox({ kind: 'email', to: 'yuki@example.com' });
      s.expect(mail.text, 'invitee email').toContain('Thursday, November 19, 2026');
      s.expect(mail.text, 'invitee email').toContain('12:00 AM to 12:15 AM (Japan Standard Time)');
      const [notice] = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
      s.expect(notice.text, 'host email').toContain('Wednesday, November 18, 2026');
      s.expect(notice.text, 'host email').toContain('3:00 PM to 3:15 PM (Greenwich Mean Time)');
      s.expect(notice.text, 'host email, their time').toContain('12:00 AM (Japan Standard Time)');
      s.expect(await jobLines(s, { bookingId: booking.id }), 'reminders').toEqual([`${plus(start, -24 * HOUR)} reminder email invitee`, `${plus(start, -1 * HOUR)} reminder email invitee`]);
    });

    await s.step('a British visitor gets the 24 hour clock without asking', async () => {
      const london = await s.newPage({ timezoneId: 'Europe/London', locale: 'en-GB' });
      await openEvent(s, london, 'intro');
      await london.getByRole('button', { name: 'Times are in: United Kingdom Time (London). Change' }).waitFor();
      await pickDay(london, '2026-11-17', 'en-GB');
      s.expect((await offeredSlots(london))[0], 'first time on Tuesday').toEqual({ start: '2026-11-17T14:00:00.000Z', label: '14:00' });
      s.expect(await london.getByRole('radio', { name: '24 hour clock' }).getAttribute('aria-checked'), '24 hour clock is on').toBe('true');
    });
  });

  await t.scenario('a booking across a daylight saving change (US clocks go forward on 14 March 2027, UK clocks on 28 March)', async (s) => {
    // Friday 12 March 2027, 10:00 in London. New York is still on standard time (UTC-5) until Sunday.
    const FRIDAY = '2027-03-12T10:00:00.000Z';
    const NEW_YORK = 'America/New_York';
    await s.step('prepare: standing on the Friday before the US change', () => prepare(s, { clock: FRIDAY }));
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });

    await s.step('before the change 14:00 UTC is 9:00 AM in New York, after it 10:00 AM', async () => {
      // Worked out by hand, then checked against Intl, then against the page.
      s.expect(wallTime('2027-03-12T14:00:00.000Z', NEW_YORK), 'Friday 14:00 UTC').toBe('9:00 AM');
      s.expect(wallTime('2027-03-15T14:00:00.000Z', NEW_YORK), 'Monday 14:00 UTC').toBe('10:00 AM');
      await openEvent(s, page, 'intro');
      await page.getByRole('grid', { name: 'March 2027' }).waitFor();
      await pickDay(page, '2027-03-12');
      const friday = await offeredSlots(page);
      // Four hours of notice from 10:00: the first time today is 14:00 in London.
      s.expect(friday[0], 'first time on Friday').toEqual({ start: '2027-03-12T14:00:00.000Z', label: '9:00 AM' });
      await pickDay(page, '2027-03-15');
      const monday = await offeredSlots(page);
      s.expect(monday.length, 'times on Monday').toBe(32);
      // The owner still starts at 09:00 London (GMT). For New York that moved from 4:00 AM to 5:00 AM.
      s.expect(monday[0], 'first time on Monday').toEqual({ start: '2027-03-15T09:00:00.000Z', label: '5:00 AM' });
      s.expect(monday.find((x) => x.start === '2027-03-15T14:00:00.000Z').label, 'Monday 14:00 UTC').toBe('10:00 AM');
      for (const slot of monday) s.expect(slot.label, `label of ${slot.start}`).toBe(wallTime(slot.start, NEW_YORK));
    });

    const start = '2027-03-15T14:00:00.000Z';
    const booking = await s.step('books Monday 10:00 AM daylight time', async () => {
      await pickSlot(page, start);
      await fillDetails(page, { name: 'Ada Lovelace', email: 'ada@example.com' });
      await page.locator('.bw-summary').getByText('10:00 – 10:15 AM').waitFor();
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      const facts = (await page.locator('.bk-facts').innerText()).replace(/\s+/g, ' ');
      s.expect(facts, 'confirmation').toContain('Monday, March 15, 2027 10:00 – 10:15 AM Eastern Time (New York)');
      const [stored] = await s.bookings();
      s.expect(stored, 'stored booking').toMatchObject({ start, end: '2027-03-15T14:15:00.000Z', invitee: { timezone: NEW_YORK } });
      return stored;
    });

    await s.step('email, calendar and reminders agree on the instant, each in its own zone', async () => {
      const [mail] = await s.outbox({ kind: 'email', to: 'ada@example.com' });
      s.expect(mail.subject, 'subject').toBe('Confirmed: Intro call with Jimi Cohen, Mon, Mar 15, 10:00 AM EDT');
      s.expect(mail.text, 'invitee email').toContain('10:00 AM to 10:15 AM (Eastern Daylight Time)');
      s.expect(mail.ics.content, 'calendar file').toContain('DTSTART:20270315T140000Z');
      const [notice] = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
      s.expect(notice.text, 'host email').toContain('2:00 PM to 2:15 PM (Greenwich Mean Time)');
      s.expect(notice.text, 'host email, their time').toContain('10:00 AM (Eastern Daylight Time)');
      const [insert] = await s.outbox({ kind: 'calendar_insert' });
      s.expect(Date.parse(insert.event.start.dateTime), 'event start').toBe(Date.parse(start));
      s.expect(insert.event.start.timeZone, 'event zone').toBe('Europe/London');
      // 24 hours before is an instant, not "the same clock time the day before": Sunday 14:00 UTC, which is 10:00 AM EDT.
      s.expect(await jobLines(s, { bookingId: booking.id }), 'reminders').toEqual([`2027-03-14T14:00:00.000Z reminder email invitee`, `2027-03-15T13:00:00.000Z reminder email invitee`]);
    });

    await s.step('the reminder a day before says "tomorrow at 10:00 AM", in daylight time', async () => {
      await s.clearOutbox();
      await s.setClock('2027-03-14T14:00:00.000Z');
      await s.runJobs();
      const [reminder] = await s.waitForOutbox({ kind: 'email', to: 'ada@example.com' });
      s.expect(reminder.subject, 'reminder subject').toBe('Reminder: Intro call with Jimi Cohen is tomorrow at 10:00 AM EDT');
      s.expect(reminder.text, 'reminder text').toContain('10:00 AM to 10:15 AM (Eastern Daylight Time)');
    });

    await s.step('the owner side: after the UK change the working day starts an hour earlier in UTC', async () => {
      // Friday 26 March: 09:00 GMT is 09:00 UTC. Monday 29 March: 09:00 BST is 08:00 UTC.
      const before = await s.slots({ slug: 'intro', duration: 15, from: '2027-03-26T00:00:00Z', to: '2027-03-27T00:00:00Z' });
      const after = await s.slots({ slug: 'intro', duration: 15, from: '2027-03-29T00:00:00Z', to: '2027-03-30T00:00:00Z' });
      s.expect([before[0], before.at(-1), before.length], 'Friday 26 March').toEqual(['2027-03-26T09:00:00.000Z', '2027-03-26T16:45:00.000Z', 32]);
      s.expect([after[0], after.at(-1), after.length], 'Monday 29 March').toEqual(['2027-03-29T08:00:00.000Z', '2027-03-29T15:45:00.000Z', 32]);

      // In the browser: New York is already on daylight time on both days, so the owner's 09:00 moves from 5:00 AM to 4:00 AM.
      const later = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
      await openEvent(s, later, 'intro');
      await pickDay(later, '2027-03-26');
      s.expect((await offeredSlots(later))[0], 'first time on Friday 26 March').toEqual({ start: '2027-03-26T09:00:00.000Z', label: '5:00 AM' });
      await pickDay(later, '2027-03-29');
      s.expect((await offeredSlots(later))[0], 'first time on Monday 29 March').toEqual({ start: '2027-03-29T08:00:00.000Z', label: '4:00 AM' });

      // And a booking on the far side reads 9:00 AM British Summer Time for the host.
      const res = await s.book({ start: '2027-03-29T08:00:00.000Z', email: 'bst@example.com', timezone: NEW_YORK });
      s.expect(res.status, 'booking after the UK change').toBe(201);
      await s.settle();
      const [notice] = await s.outbox({ kind: 'email', to: OWNER_GOOGLE, subject: /New booking/ });
      s.expect(notice.text, 'host email').toContain('9:00 AM to 9:15 AM (British Summer Time)');
      s.expect(dayName('2027-03-29'), 'day').toBe('Monday, March 29');
    });
  });
});

void MONDAY;
