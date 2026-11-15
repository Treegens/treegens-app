/**
 * Two hosts at once. A collective event with hosts in London and Nairobi, each with a Google
 * calendar, their own busy times and their own weekly hours: the page must offer exactly the
 * times both are free (worked out here independently, from the rules), one booking must land on
 * both calendars, and both must hear about it. Then a round robin event: each booking goes to
 * one host only, and the hosts take turns.
 */
import { defineSuite } from './lib.mjs';
import {
  MINUTE,
  MONDAY,
  OWNER_GOOGLE,
  addCoHost,
  addDays,
  bookInBrowser,
  createEventType,
  iso,
  offeredDays,
  offeredSlots,
  openEvent,
  pickDay,
  prepare,
  wallDay,
  wallTime,
  weekdayOf,
  zoned,
} from './public-helpers.mjs';

const ALEX_GOOGLE = 'alex@example.com';
const BERLIN = 'Europe/Berlin';

/** Jimi: London, Monday to Friday 09:00 to 17:00 (the starter hours). */
const JIMI = { zone: 'Europe/London', weekly: { 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] } };
/** Alex: Nairobi, Monday to Thursday 10:00 to 15:00, and Saturday mornings (when Jimi is off). */
const ALEX = { zone: 'Africa/Nairobi', weekly: { 1: [['10:00', '15:00']], 2: [['10:00', '15:00']], 3: [['10:00', '15:00']], 4: [['10:00', '15:00']], 6: [['09:00', '12:00']] } };
const ALEX_WEEKLY = Object.fromEntries(Object.entries(ALEX.weekly).map(([d, ranges]) => [d, ranges.map(([start, end]) => ({ start, end }))]));

/** What Google says each of them is doing already. */
const JIMI_BUSY = [{ start: '2026-11-17T10:00:00.000Z', end: '2026-11-17T11:00:00.000Z' }];
const ALEX_BUSY = [
  { start: '2026-11-17T09:00:00.000Z', end: '2026-11-17T09:30:00.000Z' },
  { start: '2026-11-18T09:30:00.000Z', end: '2026-11-18T10:15:00.000Z' },
];

const JOINT = { durationMin: 30, incrementMin: 30, bufferAfterMin: 10, minNoticeMin: 240 };

/** A host's working windows as instants, for every local day from `fromDay` to `toDay`. */
function windowsOf(host, fromDay, toDay) {
  const out = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    for (const [start, end] of host.weekly[weekdayOf(day)] ?? []) out.push({ start: Date.parse(zoned(day, start, host.zone)), end: Date.parse(zoned(day, end, host.zone)) });
  }
  return out;
}

const overlaps = (start, end, list) => list.some((b) => start < Date.parse(b.end ?? iso(b.endMs)) && end > Date.parse(b.start ?? iso(b.startMs)));
const inside = (start, end, windows) => windows.some((w) => start >= w.start && end <= w.end);

/**
 * The times a 30 minute meeting can start, by the rules alone: on the half hour (London midnight
 * is the anchor), at least four hours from now, inside the hours of every host that has to be
 * free, and with nothing on that host's calendar from the start until 10 minutes after the end.
 * `mode` 'all' = both hosts (collective), 'any' = at least one (round robin).
 */
function expectedStarts({ nowMs, from, to, mode, taken = [] }) {
  const hosts = [
    { windows: windowsOf(JIMI, '2026-11-15', '2026-12-02'), busy: [...JIMI_BUSY, ...taken] },
    { windows: windowsOf(ALEX, '2026-11-15', '2026-12-02'), busy: [...ALEX_BUSY, ...taken] },
  ];
  const out = [];
  for (let s = Date.parse(from); s < Date.parse(to); s += JOINT.incrementMin * MINUTE) {
    if (s < nowMs + JOINT.minNoticeMin * MINUTE) continue;
    const end = s + JOINT.durationMin * MINUTE;
    const free = hosts.map((h) => inside(s, end, h.windows) && !overlaps(s, end + JOINT.bufferAfterMin * MINUTE, h.busy));
    if (mode === 'all' ? free.every(Boolean) : free.some(Boolean)) out.push(iso(s));
  }
  return out;
}

/** Two connected hosts with different hours and busy calendars, and the two shared event types. */
async function prepareTeam(s) {
  const ownerPage = await prepare(s);
  const alex = await addCoHost(s, ownerPage, { name: 'Alex Kimani', email: ALEX_GOOGLE, zone: ALEX.zone, weekly: ALEX_WEEKLY });
  s.expect(alex, 'Alex after connecting Google').toMatchObject({ timezone: 'Africa/Nairobi', timezoneMode: 'google', google: { email: ALEX_GOOGLE, status: 'ok' } });
  await s.setGoogleBusy(OWNER_GOOGLE, JIMI_BUSY);
  await s.setGoogleBusy(ALEX_GOOGLE, ALEX_BUSY);
  const scheduling = { minNoticeMinutes: JOINT.minNoticeMin, maxDaysAhead: 60, bufferBeforeMin: 0, bufferAfterMin: JOINT.bufferAfterMin, slotIncrementMin: JOINT.incrementMin };
  const joint = await createEventType(s, { title: 'Joint session', slug: 'joint', kind: 'collective', hostIds: ['host_owner', alex.id], durations: [30], defaultDuration: 30, scheduling, description: 'Both of us, one call.' });
  const team = await createEventType(s, { title: 'Talk to the team', slug: 'team', kind: 'round_robin', hostIds: ['host_owner', alex.id], durations: [30], defaultDuration: 30, scheduling });
  return { ownerPage, alex, joint, team };
}

export default defineSuite('public-hosts', { mockCreds: true }, async (t) => {
  await t.scenario('collective: only the times both hosts are free, one booking on both calendars, both notified', async (s) => {
    const { alex } = await s.step('prepare: Jimi in London, Alex in Nairobi, both with Google, different hours and busy times', () => prepareTeam(s));
    const nowMs = Date.parse(MONDAY);
    const expected = expectedStarts({ nowMs, from: '2026-11-16T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', mode: 'all' });

    await s.step('the expectation, spelled out for the first week', async () => {
      // Shared hours are 09:00 to 12:00 UTC, Monday to Thursday (Alex stops at 15:00 in Nairobi and is off on Fridays).
      // Monday: nothing, four hours of notice from 09:00 end after Alex has gone home.
      // Tuesday: Alex is busy until 09:30 and Jimi from 10:00 to 11:00, and 09:30 would run into Jimi's meeting with its 10 minutes after.
      // Wednesday: Alex is busy 09:30 to 10:15. Thursday: all six. Friday and the weekend: nothing.
      s.expect(expected.filter((at) => at < '2026-11-22'), 'first week').toEqual([
        '2026-11-17T11:00:00.000Z',
        '2026-11-17T11:30:00.000Z',
        '2026-11-18T10:30:00.000Z',
        '2026-11-18T11:00:00.000Z',
        '2026-11-18T11:30:00.000Z',
        '2026-11-19T09:00:00.000Z',
        '2026-11-19T09:30:00.000Z',
        '2026-11-19T10:00:00.000Z',
        '2026-11-19T10:30:00.000Z',
        '2026-11-19T11:00:00.000Z',
        '2026-11-19T11:30:00.000Z',
      ]);
      s.expect(expected.length, 'two weeks').toBe(11 + 24 + 6);
      s.expect(await s.slots({ slug: 'joint', duration: 30, from: '2026-11-16T00:00:00Z', to: '2026-12-01T00:00:00Z' }), 'slots from the API').toEqual(expected);
    });

    const page = await s.newPage({ timezoneId: BERLIN, locale: 'en-US' });
    await s.step('the page offers exactly that intersection, day by day', async () => {
      await openEvent(s, page, 'joint');
      await page.getByRole('heading', { name: 'Joint session', level: 1 }).waitFor();
      const summary = page.locator('.bw-summary');
      await summary.getByText('Jimi Cohen and Alex Kimani').waitFor();
      await summary.getByText('Both will join').waitFor();
      await summary.getByText('You only see times when Jimi and Alex are both free.').waitFor();

      const byDay = new Map();
      for (const at of expected) byDay.set(wallDay(at, BERLIN), [...(byDay.get(wallDay(at, BERLIN)) ?? []), at]);
      const days = await offeredDays(page);
      s.expect(days.map((d) => [d.day, d.count]), 'open days in November').toEqual([...byDay].map(([day, list]) => [day, list.length]));
      for (const [day, list] of byDay) {
        await pickDay(page, day);
        const slots = await offeredSlots(page);
        s.expect(slots.map((x) => x.start), `times on ${day}`).toEqual(list);
        s.expect(slots.map((x) => x.label), `labels on ${day}`).toEqual(list.map((at) => wallTime(at, BERLIN)));
      }
      // The days one of them cannot make are closed: Monday (notice), Friday (Alex off), Saturday (Jimi off).
      for (const closed of ['2026-11-16', '2026-11-20', '2026-11-21']) s.expect(await page.locator(`.bw-day[data-day="${closed}"]`).getAttribute('aria-label'), closed).toMatch(/no times available$/);
      await pickDay(page, '2026-11-17');
      await s.screenshot(page, 'collective event page');
    });

    await s.step('each host alone has more time than that', async () => {
      const jimiAlone = await s.slots({ slug: 'meeting', duration: 30, from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z' });
      s.expect(jimiAlone.length, "Jimi's own Tuesday").toBeGreaterThan(2);
      s.expect(jimiAlone, "Jimi's own Tuesday").toContain('2026-11-17T14:00:00.000Z');
      // What Google was asked: both calendars, each as its own account.
      const asked = new Set((await s.outbox({ kind: 'freebusy' })).map((e) => e.account));
      s.expect([...asked].sort(), 'accounts asked for free/busy').toEqual([ALEX_GOOGLE, OWNER_GOOGLE]);
    });

    const start = '2026-11-18T10:30:00.000Z';
    const booking = await s.step('a visitor books Wednesday 11:30 Berlin time with both', async () => {
      await s.clearOutbox();
      const stored = await bookInBrowser(s, page, { slug: 'joint', start, zone: BERLIN, details: { name: 'Nia Okafor', email: 'nia@example.com', topic: 'A joint project.' } });
      const facts = (await page.locator('.bk-facts').innerText()).replace(/\s+/g, ' ');
      s.expect(facts, 'when').toContain('Wednesday, November 18, 2026 11:30 AM – 12:00 PM Central European Time (Berlin)');
      s.expect(facts, 'with').toContain('Jimi Cohen and Alex Kimani');
      s.expect(stored, 'stored booking').toMatchObject({ kind: 'collective', hostIds: ['host_owner', alex.id], start, end: '2026-11-18T11:00:00.000Z', invitee: { timezone: BERLIN } });
      await s.screenshot(page, 'collective confirmation');
      return stored;
    });

    await s.step('one event, on the organizer calendar, with the co-host as an accepted attendee', async () => {
      const inserts = await s.outbox({ kind: 'calendar_insert' });
      s.expect(inserts, 'calendar inserts').toHaveLength(1);
      const [insert] = inserts;
      s.expect(insert, 'insert').toMatchObject({ status: 200, account: OWNER_GOOGLE, calendarId: OWNER_GOOGLE, sendUpdates: 'all', eventId: booking.google.eventId, notified: [ALEX_GOOGLE, 'nia@example.com'] });
      s.expect(insert.event.organizer, 'organizer').toBe(OWNER_GOOGLE);
      s.expect(insert.event.attendees.map((a) => `${a.email} ${a.responseStatus} ${a.displayName ?? ''}`.trim()), 'attendees').toEqual([`${ALEX_GOOGLE} accepted Alex Kimani`, 'nia@example.com accepted Nia Okafor']);
      s.expect(insert.event.summary, 'title').toBe('Joint session: Nia Okafor, Jimi Cohen and Alex Kimani');
      s.expect([Date.parse(insert.event.start.dateTime), Date.parse(insert.event.end.dateTime)], 'instants').toEqual([Date.parse(start), Date.parse(start) + 30 * MINUTE]);
      s.expect(insert.event.hangoutLink, 'Meet link').toBe(booking.location.joinUrl);
      s.expect(booking.google, 'booking calendar link').toMatchObject({ hostId: 'host_owner' });
      // Exactly one event exists in the whole mock Google, and it is the one both are on.
      s.expect((await s.googleEvents()).map((e) => `${e.account} ${e.event.id}`), 'all events').toEqual([`${OWNER_GOOGLE} ${booking.google.eventId}`]);
    });

    await s.step('both hosts were told, each in their own time zone, and the invitee in theirs', async () => {
      const emails = await s.outbox({ kind: 'email' });
      s.expect(emails.map((e) => e.to.join(',')).sort(), 'recipients').toEqual([ALEX_GOOGLE, OWNER_GOOGLE, 'nia@example.com']);
      const [jimi] = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
      s.expect(jimi.subject, 'Jimi subject').toBe('New booking: Nia Okafor for Joint session, Wed, Nov 18, 10:30 AM');
      s.expect(jimi.text, 'Jimi text').toContain('10:30 AM to 11:00 AM (Greenwich Mean Time)');
      s.expect(jimi.text, 'Jimi text').toContain('Hi Jimi');
      s.expect(jimi.text, 'Jimi text, also hosting').toContain('Alex Kimani');
      s.expect(jimi.text, 'Jimi text, their time').toContain('11:30 AM (Central European Standard Time)');
      const [alexMail] = await s.outbox({ kind: 'email', to: ALEX_GOOGLE });
      s.expect(alexMail.subject, 'Alex subject').toBe('New booking: Nia Okafor for Joint session, Wed, Nov 18, 1:30 PM');
      s.expect(alexMail.text, 'Alex text').toContain('1:30 PM to 2:00 PM (East Africa Time)');
      s.expect(alexMail.text, 'Alex text').toContain('Hi Alex');
      s.expect(alexMail.text, 'Alex text, also hosting').toContain('Jimi Cohen');
      s.expect(alexMail.text, 'Alex text').toContain('A joint project.');
      const [nia] = await s.outbox({ kind: 'email', to: 'nia@example.com' });
      s.expect(nia.subject, 'invitee subject').toBe('Confirmed: Joint session with Jimi and Alex, Wed, Nov 18, 11:30 AM');
      s.expect(nia.text, 'invitee text').toContain('11:30 AM to 12:00 PM (Central European Standard Time)');
      s.expect(nia.text, 'invitee text, with').toContain('Jimi Cohen, Alex Kimani');
      await s.screenshotEmail(alexMail, 'host notice for the co-host');
      await s.screenshotEmail(nia, 'confirmation for a joint meeting');
      // Reminders: one set for the invitee, not one per host.
      s.expect((await s.jobs({ bookingId: booking.id })).map((j) => `${j.kind} ${j.channel} ${j.audience}`), 'queued reminders').toEqual(['reminder email invitee', 'reminder email invitee']);
    });

    await s.step("the meeting now blocks both people's Google calendars", async () => {
      const before = (await s.outbox()).length;
      // Asking afresh (a booking attempt always does): Google itself reports the time as busy for each account.
      const again = await s.book({ slug: 'joint', start, durationMin: 30, email: 'second@example.com' });
      s.expect(again.status, 'second booking of the same time').toBe(409);
      s.expect(again.data.error.code, 'error code').toBe('slot_taken');
      const answers = await s.outbox((e) => e.kind === 'freebusy' && e.index >= before);
      const busyOf = (account) => Object.values(answers.filter((e) => e.account === account).at(-1).busy).flat();
      s.expect(busyOf(OWNER_GOOGLE), "Jimi's busy time").toContain({ start, end: '2026-11-18T11:00:00.000Z' });
      s.expect(busyOf(ALEX_GOOGLE), "Alex's busy time").toContain({ start, end: '2026-11-18T11:00:00.000Z' });
      s.expect(await s.bookings(), 'bookings').toHaveLength(1);
    });
  });

  await t.scenario('round robin: each booking goes to one host only, and the hosts take turns', async (s) => {
    const { alex } = await s.step('prepare', () => prepareTeam(s));
    const nowMs = Date.parse(MONDAY);
    const emailOf = { host_owner: OWNER_GOOGLE, [alex.id]: ALEX_GOOGLE };
    const other = (id) => (id === 'host_owner' ? alex.id : 'host_owner');

    const page = await s.newPage({ timezoneId: BERLIN, locale: 'en-US' });
    await s.step('the page offers every time at least one of them is free', async () => {
      const expected = expectedStarts({ nowMs, from: '2026-11-17T00:00:00.000Z', to: '2026-11-18T00:00:00.000Z', mode: 'any' });
      // Tuesday in UTC. Alex (07:00 to 12:00, busy 09:00 to 09:30) can start at 07:00, 07:30, 08:00 and from 09:30 to 11:30;
      // 08:30 would run into his 09:00 with its 10 minutes after. Jimi (09:00 to 17:00, busy 10:00 to 11:00) can start
      // at 09:00 and from 11:00 to 16:30. Together that is everything from 07:00 to 16:30 except 08:30.
      const byHand = [];
      for (let m = 7 * 60; m <= 16 * 60 + 30; m += 30) if (m !== 8 * 60 + 30) byHand.push(iso(Date.UTC(2026, 10, 17) + m * MINUTE));
      s.expect(expected, 'times on Tuesday').toEqual(byHand);
      s.expect(expected.length, 'times on Tuesday').toBe(19);
      await openEvent(s, page, 'team');
      const summary = page.locator('.bw-summary');
      await summary.getByText('One of them will meet you').waitFor();
      await summary.getByText('You meet with Jimi or Alex, whoever is free at the time you pick.').waitFor();
      await pickDay(page, '2026-11-17');
      s.expect((await offeredSlots(page)).map((x) => x.start), 'times on Tuesday').toEqual(expected);
      await s.screenshot(page, 'round robin event page');
    });

    await s.step('a time only one of them can make goes to that one, whoever is "next"', async () => {
      // Tuesday 10:00 UTC: Jimi is in a meeting, Alex is free. Tuesday 14:00 UTC: Alex has gone home, Jimi is free.
      const first = await s.book({ slug: 'team', start: '2026-11-17T10:00:00.000Z', durationMin: 30, email: 'rr1@example.com' });
      const second = await s.book({ slug: 'team', start: '2026-11-17T14:00:00.000Z', durationMin: 30, email: 'rr2@example.com' });
      s.expect([first.status, second.status], 'bookings').toEqual([201, 201]);
      await s.settle();
      const hostsOf = async (res) => (await s.bookings({ id: res.data.booking.id }))[0].hostIds;
      s.expect([await hostsOf(first), await hostsOf(second)], 'assigned hosts').toEqual([[alex.id], ['host_owner']]);
      s.expect(first.data.booking.hosts.map((h) => h.name), 'the invitee is told who').toEqual(['Alex Kimani']);
    });

    const turns = [];
    await s.step('when both are free they take turns', async () => {
      // Thursday morning both are free at each of these times, and both now have one meeting ahead of them.
      for (const [i, start] of ['2026-11-19T09:00:00.000Z', '2026-11-19T10:00:00.000Z', '2026-11-19T11:00:00.000Z'].entries()) {
        const res = await s.book({ slug: 'team', start, durationMin: 30, email: `turn${i}@example.com` });
        s.expect(res.status, `booking ${i + 1}`).toBe(201);
        await s.settle();
        const stored = (await s.bookings({ id: res.data.booking.id }))[0];
        s.expect(stored.hostIds, `hosts of booking ${i + 1}`).toHaveLength(1);
        turns.push(stored.hostIds[0]);
      }
      s.expect(turns[1], 'second booking goes to the other host').toBe(other(turns[0]));
      s.expect(turns[2], 'third booking goes back to the first').toBe(turns[0]);
    });

    await s.step('the fourth, made in the browser, evens it out: three each', async () => {
      await s.clearOutbox();
      const stored = await bookInBrowser(s, page, { slug: 'team', start: '2026-11-23T09:00:00.000Z', zone: BERLIN, details: { name: 'Robin Round', email: 'robin@example.com' } });
      s.expect(stored.hostIds, 'assigned host').toEqual([other(turns[2])]);
      const hostName = stored.hostIds[0] === 'host_owner' ? 'Jimi Cohen' : 'Alex Kimani';
      const facts = (await page.locator('.bk-facts').innerText()).replace(/\s+/g, ' ');
      s.expect(facts, 'the confirmation names the one host').toContain(hostName);
      s.expect(facts, 'and not both').not.toContain('Jimi Cohen and Alex Kimani');
      const counts = {};
      for (const b of await s.bookings()) counts[b.hostIds[0]] = (counts[b.hostIds[0]] ?? 0) + 1;
      s.expect(counts, 'bookings per host').toEqual({ host_owner: 3, [alex.id]: 3 });

      // One calendar, one notice: the host who was not picked is on nothing and hears nothing.
      const [insert] = await s.outbox({ kind: 'calendar_insert' });
      s.expect(await s.outbox({ kind: 'calendar_insert' }), 'calendar inserts').toHaveLength(1);
      s.expect(insert.account, 'calendar account').toBe(emailOf[stored.hostIds[0]]);
      s.expect(insert.event.attendees.map((a) => a.email), 'attendees').toEqual(['robin@example.com']);
      const notices = await s.outbox({ kind: 'email', subject: /^New booking/ });
      s.expect(notices.map((e) => e.to.join(',')), 'host notices').toEqual([emailOf[stored.hostIds[0]]]);
      const [mail] = await s.outbox({ kind: 'email', to: 'robin@example.com' });
      s.expect(mail.subject, 'invitee subject').toBe(`Confirmed: Talk to the team with ${hostName}, Mon, Nov 23, 10:00 AM`);
      await s.screenshot(page, 'round robin confirmation');
    });

    await s.step('every booking sits on exactly one calendar', async () => {
      const events = await s.googleEvents();
      const bookings = await s.bookings();
      s.expect(events.length, 'events in Google').toBe(bookings.length);
      for (const b of bookings) {
        const mine = events.filter((e) => e.event.id === b.google.eventId);
        s.expect(mine.map((e) => e.account), `calendar of ${b.invitee.email}`).toEqual([emailOf[b.hostIds[0]]]);
        s.expect((mine[0].event.attendees ?? []).map((a) => a.email), `attendees of ${b.invitee.email}`).not.toContain(emailOf[other(b.hostIds[0])]);
      }
    });
  });
});
