/**
 * Double booking. Two people look at the same free time; only one can have it. The other is
 * told kindly, the time disappears from their list, what they typed is still there, and another
 * time books fine. Also the harder case: a meeting with two hosts loses its time because ONE of
 * the hosts was booked meanwhile through a different event type, or added something in Google.
 */
import { defineSuite } from './lib.mjs';
import { OWNER_GOOGLE, PHONE_TYPED, addCoHost, confirmBooking, createEventType, fillDetails, offeredSlots, openEvent, pickDay, pickSlot, prepare } from './public-helpers.mjs';

const NEW_YORK = 'America/New_York';
const WED_2PM = '2026-11-18T14:00:00.000Z';
const WED_230PM = '2026-11-18T14:30:00.000Z';
const ALEX_GOOGLE = 'alex@example.com';

/** The form as the visitor left it, read back from the page. */
async function formValues(page) {
  const form = page.getByRole('form', { name: 'Your details' });
  return {
    name: await form.getByRole('textbox', { name: 'Name', exact: true }).inputValue(),
    email: await form.getByRole('textbox', { name: 'Email', exact: true }).inputValue(),
    phone: await form.locator('input[type="tel"]').inputValue(),
    topic: await form.getByRole('textbox', { name: 'What would you like to talk about?' }).inputValue(),
    guests: await form.getByRole('list', { name: 'Guests added' }).getByRole('listitem').allInnerTexts(),
    sms: await form.getByRole('switch', { name: 'Text me the confirmation and reminders' }).getAttribute('aria-checked'),
  };
}

/** The friendly "just taken" state: back at the times, with a notice, and no error left on screen. */
async function expectJustTaken(s, page) {
  const notice = page.getByRole('alert').filter({ hasText: 'That time was just taken' });
  await notice.waitFor();
  s.expect((await notice.innerText()).replace(/\s+/g, ' '), 'notice').toBe('That time was just taken Please pick another one. Everything you typed is still here.');
  await page.getByRole('heading', { name: 'Pick a time' }).waitFor();
  s.expect(await page.getByRole('form', { name: 'Your details' }).count(), 'the form is put away').toBe(0);
}

export default defineSuite('public-conflicts', { mockCreds: true }, async (t) => {
  await t.scenario('two visitors pick the same time: the second is told kindly and books another', async (s) => {
    await s.step('prepare', async () => {
      await prepare(s);
      // Bob brings a guest: the owner lets people do that on the intro call.
      await s.apiOk('PUT', '/admin/event-types/evt_intro', { body: { allowGuests: true } });
    });
    s.allowConsoleErrors(/status of 409/);
    const ada = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
    const bob = await s.newPage({ timezoneId: 'Europe/Paris', locale: 'en-US', ip: '203.0.113.77' });
    const bobDetails = { name: 'Bob Builder', email: 'bob@example.com', phone: PHONE_TYPED, sms: false, guests: ['wendy@example.com'], topic: 'Can we fix it?' };

    await s.step('both open Wednesday and see 2:00 PM London time as free', async () => {
      for (const page of [ada, bob]) {
        await openEvent(s, page, 'intro');
        await pickDay(page, '2026-11-18');
        s.expect((await offeredSlots(page)).map((x) => x.start), 'times offered').toContain(WED_2PM);
      }
    });

    await s.step('both pick it and fill in their details', async () => {
      await pickSlot(ada, WED_2PM);
      await fillDetails(ada, { name: 'Ada Lovelace', email: 'ada@example.com' });
      await pickSlot(bob, WED_2PM);
      await fillDetails(bob, { ...bobDetails, phone: undefined });
      // Bob is in Paris, so the country list starts on France. His number is American: he picks that first.
      const form = bob.getByRole('form', { name: 'Your details' });
      const country = form.getByRole('combobox', { name: 'Country calling code' });
      s.expect(await country.inputValue(), 'country guessed from the Paris zone').toBe('FR');
      await country.selectOption('US');
      await fillDetails(bob, { phone: bobDetails.phone, sms: false });
    });

    await s.step('Ada confirms first and gets the time', async () => {
      await confirmBooking(s, ada);
      await ada.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      s.expect(await s.bookings(), 'bookings').toMatchObject([{ start: WED_2PM, invitee: { email: 'ada@example.com' } }]);
    });

    const before = await s.step('Bob confirms a moment later and is told the time was just taken', async () => {
      const values = await formValues(bob);
      const outboxBefore = (await s.outbox()).length;
      await confirmBooking(s, bob);
      await expectJustTaken(s, bob);
      await s.settle();
      // Nothing was created for Bob: no booking, no calendar event, no message.
      s.expect(await s.bookings(), 'bookings').toHaveLength(1);
      const since = await s.outbox((e) => e.index >= outboxBefore);
      s.expect(since.map((e) => e.kind).filter((k) => k !== 'freebusy'), 'provider calls caused by the refused booking').toEqual([]);
      await s.screenshot(bob, 'just taken');
      return values;
    });

    await s.step('the time is gone from his list, the day is still open', async () => {
      await bob.getByRole('heading', { name: 'Wednesday, November 18', exact: true }).waitFor();
      await s.eventually(async () => {
        const starts = (await offeredSlots(bob)).map((x) => x.start);
        s.expect(starts, 'times offered').not.toContain(WED_2PM);
        s.expect(starts, 'times offered').toContain(WED_230PM);
        // 32 minus the booked quarter hour and its two neighbours (buffers).
        s.expect(starts.length, 'times left on Wednesday').toBe(29);
      });
    });

    await s.step('he picks 3:30 PM Paris time and everything he typed is still there', async () => {
      await pickSlot(bob, WED_230PM);
      await bob.getByRole('form', { name: 'Your details' }).waitFor();
      s.expect(await formValues(bob), 'form values after the refusal').toEqual(before);
      s.expect(before, 'what he typed').toMatchObject({ name: 'Bob Builder', email: 'bob@example.com', phone: '(415) 555-2671', topic: 'Can we fix it?', sms: 'false' });
      s.expect(before.guests.map((g) => g.trim()), 'guests').toEqual(['wendy@example.com']);
      await bob.locator('.bw-summary').getByText('3:30 – 3:45 PM').waitFor();
      // The notice belongs to the refused time. It is not shown on the form for the new one.
      s.expect(await bob.getByText('That time was just taken').count(), 'old notice').toBe(0);
    });

    await s.step('and that one books fine', async () => {
      await confirmBooking(s, bob);
      await bob.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      const all = await s.bookings();
      // Sorted here: with the clock frozen both were created at the same instant, so their stored order says nothing.
      s.expect(all.map((b) => `${b.invitee.email} ${b.start}`).sort(), 'bookings').toEqual([`ada@example.com ${WED_2PM}`, `bob@example.com ${WED_230PM}`]);
      s.expect(all.find((b) => b.invitee.email === 'bob@example.com'), "Bob's booking").toMatchObject({ guests: ['wendy@example.com'], consent: { sms: false, call: true }, invitee: { timezone: 'Europe/Paris', phone: '+14155552671' } });
      s.expect((await s.outbox({ kind: 'calendar_insert' })).map((e) => e.event.start.dateTime).map((d) => new Date(d).toISOString()), 'calendar events').toEqual([WED_2PM, WED_230PM]);
      s.expect((await s.outbox({ kind: 'email', to: 'bob@example.com' })).map((e) => e.subject), "Bob's emails").toEqual(['Confirmed: Intro call with Jimi Cohen, Wed, Nov 18, 3:30 PM GMT+1']);
    });
  });

  await t.scenario('five requests for one time at the same instant: exactly one wins', async (s) => {
    await s.step('prepare', () => prepare(s));
    await s.step('five bookings sent together', async () => {
      const answers = await Promise.all([1, 2, 3, 4, 5].map((n) => s.book({ start: WED_2PM, email: `racer${n}@example.com`, name: `Racer ${n}` })));
      s.expect(answers.map((a) => a.status).sort(), 'answers').toEqual([201, 409, 409, 409, 409]);
      for (const refused of answers.filter((a) => a.status === 409)) {
        s.expect(refused.data.error, 'refusal').toMatchObject({ code: 'slot_taken', message: /taken|available|free/i });
      }
      await s.settle();
      s.expect(await s.bookings(), 'bookings').toHaveLength(1);
      s.expect(await s.outbox({ kind: 'calendar_insert' }), 'calendar events').toHaveLength(1);
      s.expect((await s.outbox({ kind: 'email', subject: /^Confirmed/ })).length, 'confirmations').toBe(1);
      s.expect((await s.kv('index/bookings')).filter((e) => e.status === 'confirmed'), 'index entries').toHaveLength(1);
    });

    await s.step('overlapping lengths of another event type collide too', async () => {
      // A 60 minute "Meeting" from 13:30 would run through the 14:00 intro call.
      const long = await s.book({ slug: 'meeting', start: '2026-11-18T13:30:00.000Z', durationMin: 60, email: 'long@example.com' });
      s.expect(long.status, 'overlapping booking').toBe(409);
      const fits = await s.book({ slug: 'meeting', start: '2026-11-18T12:30:00.000Z', durationMin: 60, email: 'long@example.com' });
      s.expect(fits.status, 'a booking that ends 30 minutes before').toBe(201);
    });
  });

  await t.scenario('collective: the time is lost because ONE host was booked through another event type', async (s) => {
    s.allowConsoleErrors(/status of 409/);
    const start = '2026-11-19T10:00:00.000Z'; // Thursday 10:00 London, 13:00 Nairobi
    const setup = await s.step('prepare: a joint event with Jimi and Alex, and a solo event for Alex alone', async () => {
      const ownerPage = await prepare(s);
      const alex = await addCoHost(s, ownerPage, { name: 'Alex Kimani', email: ALEX_GOOGLE, zone: 'Africa/Nairobi' });
      const scheduling = { minNoticeMinutes: 240, maxDaysAhead: 60, bufferBeforeMin: 0, bufferAfterMin: 10, slotIncrementMin: 30 };
      await createEventType(s, { title: 'Joint session', slug: 'joint', kind: 'collective', hostIds: ['host_owner', alex.id], durations: [30], defaultDuration: 30, scheduling });
      await createEventType(s, { title: 'Coffee with Alex', slug: 'alex', kind: 'solo', hostIds: [alex.id], durations: [30], defaultDuration: 30, scheduling });
      return { alex };
    });

    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
    await s.step('a visitor picks Thursday 10:00 London time for the joint session and fills the form', async () => {
      await openEvent(s, page, 'joint');
      await pickDay(page, '2026-11-19');
      // Jimi 09:00 to 17:00 London and Alex 09:00 to 17:00 Nairobi (06:00 to 14:00 UTC) share 09:00 to 14:00 UTC.
      s.expect((await offeredSlots(page)).map((x) => x.start), 'joint times on Thursday').toEqual(
        ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30'].map((time) => `2026-11-19T${time}:00.000Z`),
      );
      await pickSlot(page, start);
      await fillDetails(page, { name: 'Nia Okafor', email: 'nia@example.com', topic: 'Still here after the refusal?' });
    });

    await s.step('meanwhile someone books coffee with Alex alone at that very time', async () => {
      const coffee = await s.book({ slug: 'alex', start, durationMin: 30, email: 'coffee@example.com', name: 'Coffee Drinker' });
      s.expect(coffee.status, 'coffee booking').toBe(201);
      await s.settle();
      const stored = (await s.bookings())[0];
      s.expect(stored.hostIds, 'coffee is with Alex only').toEqual([setup.alex.id]);
      // The event went onto Alex's own calendar: he is the only host and has Google connected.
      s.expect((await s.outbox({ kind: 'calendar_insert' })).map((e) => e.account), 'calendar of the coffee').toEqual([ALEX_GOOGLE]);
      // Jimi is still free then: his own event types offer the time.
      s.expect(await s.slots({ slug: 'meeting', duration: 30, from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' }), "Jimi's own Thursday").toContain(start);
    });

    await s.step('the joint booking is refused kindly: one of the two is no longer free', async () => {
      await confirmBooking(s, page);
      await expectJustTaken(s, page);
      await s.settle();
      s.expect(await s.bookings(), 'bookings').toHaveLength(1);
      s.expect(await s.outbox({ kind: 'calendar_insert' }), 'calendar events').toHaveLength(1);
    });

    await s.step('the list now leaves out what Alex can no longer do, and nothing else', async () => {
      await s.eventually(async () => {
        // Gone: 09:30 (would run into the coffee with its 10 minutes after), 10:00 (the coffee), 10:30 (the coffee keeps 10 minutes after).
        s.expect((await offeredSlots(page)).map((x) => x.start), 'joint times on Thursday').toEqual(['09:00', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30'].map((time) => `2026-11-19T${time}:00.000Z`));
      });
    });

    await s.step('another time books fine, with both hosts, and the form kept its values', async () => {
      await pickSlot(page, '2026-11-19T11:00:00.000Z');
      const form = page.getByRole('form', { name: 'Your details' });
      s.expect(await form.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'name').toBe('Nia Okafor');
      s.expect(await form.getByRole('textbox', { name: 'What would you like to talk about?' }).inputValue(), 'topic').toBe('Still here after the refusal?');
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      const [joint] = await s.bookings({ eventSlug: 'joint' });
      s.expect(joint, 'joint booking').toMatchObject({ kind: 'collective', hostIds: ['host_owner', setup.alex.id], start: '2026-11-19T11:00:00.000Z' });
      const insert = (await s.outbox({ kind: 'calendar_insert' })).at(-1);
      s.expect(insert.account, 'organizer').toBe(OWNER_GOOGLE);
      s.expect(insert.event.attendees.map((a) => a.email), 'attendees').toEqual([ALEX_GOOGLE, 'nia@example.com']);
    });
  });

  await t.scenario('collective: one host added a meeting in Google while the visitor was typing', async (s) => {
    s.allowConsoleErrors(/status of 409/);
    const start = '2026-11-19T12:00:00.000Z';
    await s.step('prepare', async () => {
      const ownerPage = await prepare(s);
      const alex = await addCoHost(s, ownerPage, { name: 'Alex Kimani', email: ALEX_GOOGLE, zone: 'Africa/Nairobi' });
      await createEventType(s, { title: 'Joint session', slug: 'joint', kind: 'collective', hostIds: ['host_owner', alex.id], durations: [30], defaultDuration: 30 });
    });
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });

    await s.step('the visitor picks Thursday 12:00 UTC', async () => {
      await openEvent(s, page, 'joint');
      await pickDay(page, '2026-11-19');
      await pickSlot(page, start);
      await fillDetails(page, { name: 'Nia Okafor', email: 'nia@example.com' });
    });

    await s.step('Alex puts a lunch on his own Google Calendar; the page has not heard of it', async () => {
      // keepCache: the page's list was computed a moment ago and is still what the visitor sees.
      await s.apiOk('PUT', '/dev/google/busy', { body: { email: ALEX_GOOGLE, busy: [{ start: '2026-11-19T11:45:00.000Z', end: '2026-11-19T12:45:00.000Z' }], keepCache: true } });
    });

    await s.step('booking asks Google afresh, finds Alex busy, and refuses kindly', async () => {
      await confirmBooking(s, page);
      await expectJustTaken(s, page);
      await s.settle();
      s.expect(await s.bookings(), 'bookings').toEqual([]);
      s.expect(await s.outbox({ kind: 'calendar_insert' }), 'calendar events').toEqual([]);
      s.expect(await s.outbox({ kind: 'email' }), 'emails').toEqual([]);
    });

    await s.step('the list is right at once: the lunch and what would run into it are gone, 1:00 PM UTC is there', async () => {
      // No waiting for the minute-old availability to expire: a refusal like this one means it is out of date.
      await s.eventually(async () => {
        const starts = (await offeredSlots(page)).map((x) => x.start);
        for (const gone of ['2026-11-19T11:30:00.000Z', start, '2026-11-19T12:30:00.000Z']) s.expect(starts, 'times offered').not.toContain(gone);
        s.expect(starts, 'times offered').toContain('2026-11-19T11:00:00.000Z');
        s.expect(starts, 'times offered').toContain('2026-11-19T13:00:00.000Z');
      });
      // Another visitor who opens the page now sees the same.
      const fresh = await s.slots({ slug: 'joint', duration: 30, from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' });
      s.expect(fresh, 'slots from the API').not.toContain(start);
    });

    await s.step('1:00 PM UTC books, and the form still has the name', async () => {
      await pickSlot(page, '2026-11-19T13:00:00.000Z');
      s.expect(await page.getByRole('form', { name: 'Your details' }).getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'name').toBe('Nia Okafor');
      await confirmBooking(s, page);
      await page.getByRole('heading', { name: "You're booked" }).waitFor();
      await s.settle();
      s.expect(await s.bookings(), 'bookings').toMatchObject([{ start: '2026-11-19T13:00:00.000Z', kind: 'collective' }]);
    });
  });
});
