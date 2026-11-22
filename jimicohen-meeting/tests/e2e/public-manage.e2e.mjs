/**
 * The links an invitee gets by email: look at the booking, say "I'll be there" (also straight
 * from the reminder email), move it, cancel it with a reason. And the dead ends: a wrong token,
 * a meeting that was already cancelled, a meeting that has already started.
 */
import { defineSuite } from './lib.mjs';
import { HOUR, MINUTE, OWNER_GOOGLE, PHONE, PHONE_VIEWPORT, calendarReady, jobLines, manageView, offeredSlots, overflowReport, pickDay, pickSlot, plus, prepare } from './public-helpers.mjs';

const NEW_YORK = 'America/New_York';
const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };
/** Wednesday 11:00 AM in New York. */
const START = '2026-11-18T16:00:00.000Z';
/** Thursday 9:30 AM in New York. */
const NEW_START = '2026-11-19T14:30:00.000Z';

async function bookForAda(s, extra = {}) {
  const res = await s.book({ start: START, ...ADA, timezone: NEW_YORK, phone: PHONE, consent: { sms: true, call: true }, ...extra });
  s.expect(res.status, 'booking').toBe(201);
  await s.settle();
  return (await s.bookings({ id: res.data.booking.id }))[0];
}

const facts = async (page) => (await page.locator('.bk-facts').innerText()).replace(/\s+/g, ' ');

export default defineSuite('public-manage', { mockCreds: true }, async (t) => {
  await t.scenario('view the booking from the email, and say "I\'ll be there"', async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books; her confirmation carries the manage links', () => bookForAda(s));
    const [mail] = await s.outbox({ kind: 'email', to: ADA.email });
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });

    await s.step('the reschedule and cancel links of the email open the right screens', async () => {
      const reschedule = mail.links.find((l) => l.includes('/reschedule?t='));
      const cancel = mail.links.find((l) => l.includes('/cancel?t='));
      s.expect(reschedule, 'reschedule link').toBe(`${s.url(`/booking/${booking.id}/reschedule`)}?t=${booking.manageToken}`);
      s.expect(cancel, 'cancel link').toBe(`${s.url(`/booking/${booking.id}/cancel`)}?t=${booking.manageToken}`);
      await page.goto(cancel);
      await page.getByRole('heading', { name: 'Cancel this meeting?', level: 1 }).waitFor();
      await page.getByText('Intro call with Jimi Cohen, Wed, Nov 18 at 11:00 AM.').waitFor();
      await page.goto(reschedule);
      await page.getByRole('heading', { name: 'Pick a new time' }).waitFor();
      await page.getByText('Rescheduling', { exact: true }).waitFor();
    });

    await s.step('the booking page shows the meeting in her zone', async () => {
      await page.goto(booking.manageUrl);
      await page.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      await page.getByText('Confirmed', { exact: true }).waitFor();
      await page.getByText('Ada, here is your meeting with Jimi Cohen.').waitFor();
      s.expect(await facts(page), 'facts').toContain('Wednesday, November 18, 2026 11:00 – 11:15 AM Eastern Time (New York)');
      s.expect(await page.getByRole('link', { name: 'Open the meeting link' }).getAttribute('href'), 'meeting link').toBe(booking.location.joinUrl);
      s.expect(await page.title(), 'tab title').toBe('Intro call · your booking');
      s.expect(await page.getByRole('link', { name: 'Reschedule' }).getAttribute('href'), 'reschedule').toBe(`/meeting/booking/${booking.id}/reschedule?t=${booking.manageToken}`);
      s.expect(await page.getByRole('link', { name: 'Cancel meeting' }).getAttribute('href'), 'cancel').toBe(`/meeting/booking/${booking.id}/cancel?t=${booking.manageToken}`);
      s.expect(await overflowReport(page), 'overflow').toMatchObject({ scrolls: false, offenders: [] });
      await s.screenshot(page, 'manage page');
    });

    await s.step('the time zone can be changed here too', async () => {
      await page.getByRole('button', { name: /^Times are in: Eastern Time \(New York\)/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Choose a time zone' });
      await dialog.getByRole('combobox', { name: 'Search time zones' }).fill('nairobi');
      await dialog.getByRole('option', { name: /Nairobi/ }).first().click();
      await s.eventually(async () => s.expect(await facts(page), 'facts in Nairobi').toContain('Wednesday, November 18, 2026 7:00 – 7:15 PM East Africa Time (Nairobi)'));
      await page.getByRole('button', { name: /^Times are in:/ }).click();
      await page.getByRole('dialog', { name: 'Choose a time zone' }).getByRole('button', { name: /^Use my device time zone/ }).click();
      await s.eventually(async () => s.expect(await facts(page), 'facts back in New York').toContain('11:00 – 11:15 AM Eastern Time (New York)'));
    });

    await s.step('"I\'ll be there" is recorded and shown', async () => {
      await page.getByText('Still coming?').waitFor();
      await page.getByRole('button', { name: "I'll be there" }).click();
      await page.getByText('You said you will be there').waitFor();
      await page.getByText('Jimi knows you will be there.').waitFor();
      s.expect(await page.getByRole('button', { name: "I'll be there" }).count(), 'the button is gone').toBe(0);
      const stored = (await s.bookings())[0];
      s.expect(stored.attendance, 'attendance').toMatchObject({ confirmedAt: '2026-11-16T09:00:00.000Z', confirmedVia: 'link' });
      s.expect(stored.timeline.at(-1), 'timeline').toMatchObject({ type: 'attendance_confirmed', detail: 'Confirmed from the booking page' });
      s.expect((await manageView(s, booking)).booking.attendanceConfirmed, 'manage API').toBe(true);
      await s.screenshot(page, 'attendance confirmed');
      // It stays that way after a reload, and asking again changes nothing.
      await page.reload();
      await page.getByText('You said you will be there').waitFor();
      const again = await s.visitor().request('POST', `/public/bookings/${booking.id}/confirm`, { body: { t: booking.manageToken } });
      s.expect(again.status, 'confirming twice').toBe(200);
      s.expect((await s.bookings())[0].timeline.filter((e) => e.type === 'attendance_confirmed'), 'timeline entries').toHaveLength(1);
    });
  });

  await t.scenario('the confirm link in the reminder email confirms attendance when it is opened', async (s) => {
    await s.step('prepare', () => prepare(s));
    // A meeting somewhere other than Google Meet, so the reminder has a button "I'll be there" as its main action.
    const booking = await s.step('Ada books a meeting in person', async () => {
      await s.apiOk('PUT', '/admin/event-types/evt_intro', { body: { locations: [{ type: 'in_person', value: '1 Forest Road, London' }] } });
      return bookForAda(s);
    });

    const link = await s.step('a day before, the reminder arrives with the link', async () => {
      await s.clearOutbox();
      await s.setClock(plus(START, -24 * HOUR));
      await s.runJobs();
      const [reminder] = await s.waitForOutbox({ kind: 'email', to: ADA.email });
      s.expect(reminder.subject, 'subject').toBe('Reminder: Intro call with Jimi Cohen is tomorrow at 11:00 AM EST');
      const confirm = `${booking.manageUrl}&confirm=1`;
      s.expect(reminder.links, 'links in the reminder').toContain(confirm);
      s.expect(reminder.html, 'the button').toMatch(/I(&#39;|&apos;|')ll be there/);
      s.expect(reminder.text, 'the plain text').toContain("I'll be there");
      await s.screenshotEmail(reminder, 'reminder with the confirm button');
      return confirm;
    });

    await s.step('opening it is enough: the page says so and the host can see it', async () => {
      const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
      await page.goto(link);
      await page.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      await page.getByText('You said you will be there').waitFor();
      await page.getByText('Jimi knows you will be there.').waitFor();
      const stored = (await s.bookings())[0];
      s.expect(stored.attendance, 'attendance').toMatchObject({ confirmedAt: plus(START, -24 * HOUR), confirmedVia: 'link' });
      // The instruction is taken out of the address, so a reload or a forwarded link does not repeat it.
      s.expect(new URL(page.url()).searchParams.has('confirm'), 'confirm left in the address').toBe(false);
      s.expect(new URL(page.url()).searchParams.get('t'), 'token kept in the address').toBe(booking.manageToken);
      await s.screenshot(page, 'confirmed from the reminder link');
      await page.reload();
      await page.getByText('You said you will be there').waitFor();
      s.expect((await s.bookings())[0].timeline.filter((e) => e.type === 'attendance_confirmed'), 'timeline entries').toHaveLength(1);
    });

    await s.step('the next reminder no longer asks', async () => {
      await s.clearOutbox();
      await s.setClock(plus(START, -1 * HOUR));
      await s.runJobs();
      const [reminder] = await s.waitForOutbox({ kind: 'email', to: ADA.email });
      s.expect(reminder.links.some((l) => l.includes('confirm=1')), 'confirm link in the second reminder').toBe(false);
    });
  });

  await t.scenario('reschedule: the event moves, the old reminders are replaced, both sides are told', async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books Wednesday 11:00 AM and says she will be there', async () => {
      const made = await bookForAda(s);
      await s.visitor().ok('POST', `/public/bookings/${made.id}/confirm`, { body: { t: made.manageToken } });
      s.expect(await jobLines(s), 'reminders before').toEqual([
        `${plus(START, -24 * HOUR)} reminder email invitee`,
        `${plus(START, -2 * HOUR)} reminder call invitee`,
        `${plus(START, -1 * HOUR)} reminder email invitee`,
        `${plus(START, -15 * MINUTE)} reminder sms invitee`,
      ]);
      await s.clearOutbox();
      return made;
    });

    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
    await s.step('from her booking page she opens "Reschedule"', async () => {
      await page.goto(booking.manageUrl);
      await page.getByRole('link', { name: 'Reschedule' }).click();
      await page.getByRole('heading', { name: 'Pick a new time' }).waitFor();
      await calendarReady(page);
      const summary = page.locator('.bw-summary');
      await summary.getByText('Currently booked for').waitFor();
      await summary.getByText('Wednesday, November 18, 11:00 – 11:15 AM').waitFor();
      // The calendar opens on her day, and her own time is offered (it is hers) and marked.
      await page.getByRole('heading', { name: 'Wednesday, November 18', exact: true }).waitFor();
      s.expect(await page.locator('.bw-day[data-day="2026-11-18"]').getAttribute('aria-label'), 'her day').toMatch(/^Wednesday, November 18, your current booking, 32 times available$/);
      const current = page.locator(`.bw-slot[data-start="${Date.parse(START)}"]`);
      s.expect(await current.locator('.bw-slot__time').textContent(), 'her time').toBe('11:00 AM');
      s.expect(await current.locator('.bw-slot__tag').textContent(), 'its tag').toBe('Current');
      await current.click();
      s.expect(await page.getByRole('button', { name: 'This is your current time' }).isDisabled(), 'cannot "move" to the same time').toBe(true);
      await s.screenshot(page, 'reschedule');
    });

    await s.step('she picks Thursday 9:30 AM and confirms', async () => {
      await pickDay(page, '2026-11-19');
      await pickSlot(page, NEW_START);
      const bar = page.locator('.bw-confirmbar');
      s.expect(await bar.locator('.bw-confirmbar__label').textContent(), 'confirm bar label').toBe('New time');
      s.expect(await bar.locator('.bw-confirmbar__value').textContent(), 'confirm bar value').toBe('Thu, Nov 19, 9:30 AM');
      await bar.getByRole('button', { name: 'Confirm new time' }).click();
      await page.getByText('Your meeting has moved').waitFor();
      await page.getByText(`Google Calendar is sending an updated invitation to ${ADA.email}, which moves the meeting in your calendar.`).waitFor();
      await s.settle();
      s.expect(new URL(page.url()).pathname, 'back on the booking page').toBe(`/meeting/booking/${booking.id}`);
      const shown = await page.locator('.bm__facts').innerText();
      s.expect(shown.replace(/\s+/g, ' '), 'facts').toContain('Thursday, November 19, 2026 9:30 – 9:45 AM Eastern Time (New York)');
      s.expect(shown.replace(/\s+/g, ' '), 'moved from').toContain('Moved from Wednesday, November 18, 2026, 11:00 – 11:15 AM');
      // A move resets "I'll be there": the question is asked again for the new time.
      await page.getByText('Still coming?').waitFor();
      await s.screenshot(page, 'after rescheduling');
    });

    await s.step('the stored booking moved and remembers where from', async () => {
      const stored = (await s.bookings())[0];
      s.expect(stored, 'booking').toMatchObject({ id: booking.id, status: 'confirmed', start: NEW_START, end: plus(NEW_START, 15 * MINUTE), rescheduledFromStart: START, rescheduleCount: 1, attendance: {}, hostIds: ['host_owner'] });
      s.expect(stored.timeline.map((e) => e.type), 'timeline').toContain('rescheduled');
      s.expect(await s.bookings(), 'still one booking').toHaveLength(1);
    });

    await s.step('the calendar event was patched, not recreated', async () => {
      s.expect(await s.outbox({ kind: 'calendar_insert' }), 'new events').toEqual([]);
      const patches = await s.outbox({ kind: 'calendar_patch' });
      s.expect(patches, 'patches').toHaveLength(1);
      s.expect(patches[0], 'patch').toMatchObject({ status: 200, account: OWNER_GOOGLE, eventId: booking.google.eventId, moved: true, sendUpdates: 'all', notified: [ADA.email], meetUrl: booking.location.joinUrl });
      s.expect([Date.parse(patches[0].event.start.dateTime), Date.parse(patches[0].event.end.dateTime)], 'new instants').toEqual([Date.parse(NEW_START), Date.parse(NEW_START) + 15 * MINUTE]);
      const events = await s.googleEvents(OWNER_GOOGLE);
      s.expect(events, 'events on the calendar').toHaveLength(1);
      s.expect(events[0].event, 'the event').toMatchObject({ id: booking.google.eventId, status: 'confirmed', sequence: 1 });
    });

    await s.step('old reminders are gone, new ones wait at the new instants', async () => {
      s.expect(await jobLines(s), 'reminders after').toEqual([
        `${plus(NEW_START, -24 * HOUR)} reminder email invitee`,
        // 9:30 AM in New York: two hours before is before calling hours, so the call rings when they open at 8:00
        `${plus(NEW_START, -90 * MINUTE)} reminder call invitee`,
        `${plus(NEW_START, -1 * HOUR)} reminder email invitee`,
        `${plus(NEW_START, -15 * MINUTE)} reminder sms invitee`,
      ]);
      for (const job of await s.jobs()) s.expect(job.forStart, 'job planned for').toBe(NEW_START);
    });

    await s.step('the invitee and the host each get one "moved" message', async () => {
      const emails = await s.outbox({ kind: 'email' });
      s.expect(emails.map((e) => `${e.to.join(',')} | ${e.subject}`).sort(), 'emails').toEqual([
        `${ADA.email} | New time: Intro call with Jimi Cohen, Thu, Nov 19, 9:30 AM EST`,
        `${OWNER_GOOGLE} | Rescheduled: Ada Lovelace for Intro call, now Thu, Nov 19, 2:30 PM GMT`,
      ]);
      const [mail] = await s.outbox({ kind: 'email', to: ADA.email });
      s.expect(mail.text, 'invitee text').toContain('9:30 AM to 9:45 AM (Eastern Standard Time)');
      s.expect(mail.text, 'invitee text, previously').toContain('Wednesday, November 18, 2026');
      // Google moves its own invitation in her calendar (the patch above notified her): no file of ours beside it.
      s.expect(mail.hasIcs, 'calendar file').toBe(false);
      s.expect(mail.text, 'says Google moves it').toContain('Google Calendar is sending you an updated invitation from Jimi Cohen, which moves the meeting in your calendar.');
      // She moved it herself a moment ago: the email and Google's update say it all, a text on top is not needed.
      s.expect(await s.outbox({ kind: 'sms' }), 'texts').toEqual([]);
      await s.screenshotEmail(mail, 'rescheduled email');
    });

    await s.step('her old time is free again, the new one is taken', async () => {
      const other = await s.newPage({ timezoneId: NEW_YORK });
      await other.goto(s.url('/intro'));
      await pickDay(other, '2026-11-18');
      s.expect((await offeredSlots(other)).map((x) => x.start), 'Wednesday').toContain(START);
      await pickDay(other, '2026-11-19');
      s.expect((await offeredSlots(other)).map((x) => x.start), 'Thursday').not.toContain(NEW_START);
    });

    await s.step('on a phone, the button to confirm the new time is in view right after a time is tapped', async () => {
      // A full day is a long list on a phone. The answer to a tap must not be somewhere below it, out of sight.
      const phone = await s.newPage({ ...PHONE_VIEWPORT, timezoneId: NEW_YORK, locale: 'en-US' });
      await phone.goto(`${s.url(`/booking/${booking.id}/reschedule`)}?t=${booking.manageToken}`);
      await calendarReady(phone);
      await phone.locator('.bw-day[data-day="2026-11-20"]').tap();
      await phone.getByRole('heading', { name: 'Friday, November 20', exact: true }).waitFor();
      const slot = phone.locator(`.bw-slot[data-start="${Date.parse('2026-11-20T11:00:00.000Z')}"]`);
      // The worst case: the time sits at the very bottom edge of the screen when it is tapped, where the bar will appear.
      await slot.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().bottom - window.innerHeight + 4));
      await slot.tap();
      const confirm = phone.getByRole('button', { name: 'Confirm new time' });
      await confirm.waitFor();
      await s.eventually(async () => {
        const box = await confirm.boundingBox();
        s.expect(box.y, 'top of the confirm button').toBeGreaterThanOrEqual(0);
        s.expect(box.y + box.height, 'bottom of the confirm button (the screen is 844 px tall)').toBeLessThanOrEqual(844);
      });
      // The bar says which time it is about, so it is clear what the button will do even where it floats over the list.
      s.expect(await phone.locator('.bw-confirmbar__value').textContent(), 'the bar names the tapped time').toBe('Fri, Nov 20, 6:00 AM');
      // The time that was tapped stays readable above the bar.
      await s.eventually(async () => {
        const [slotBox, barBox] = [await slot.boundingBox(), await phone.locator('.bw-confirmbar').boundingBox()];
        s.expect(Math.round(slotBox.y + slotBox.height), 'bottom of the tapped time').toBeLessThanOrEqual(Math.round(barBox.y));
        s.expect(slotBox.y, 'top of the tapped time').toBeGreaterThanOrEqual(0);
      });
      await s.screenshot(phone, 'reschedule on a phone', { fullPage: false });
    });

    await s.step('a time someone else holds cannot be moved onto', async () => {
      const taken = await s.book({ start: '2026-11-20T10:00:00.000Z', email: 'someone@example.com' });
      s.expect(taken.status, 'another booking').toBe(201);
      const refused = await s.visitor().request('POST', `/public/bookings/${booking.id}/reschedule`, { body: { t: booking.manageToken, start: '2026-11-20T10:00:00.000Z' } });
      s.expect(refused.status, 'moving onto it').toBe(409);
      s.expect(refused.data.error.code, 'code').toBe('slot_taken');
      s.expect((await s.bookings({ id: booking.id }))[0].start, 'the booking stayed').toBe(NEW_START);
    });
  });

  await t.scenario('cancel with a reason: event deleted, everyone told, reminders gone, time offered again', async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books', async () => {
      const made = await bookForAda(s);
      await s.clearOutbox();
      return made;
    });
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });

    await s.step('the cancel link asks first, and "Keep it" changes nothing', async () => {
      await page.goto(`${s.url(`/booking/${booking.id}/cancel`)}?t=${booking.manageToken}`);
      await page.getByRole('heading', { name: 'Cancel this meeting?', level: 1 }).waitFor();
      await s.screenshot(page, 'cancel form');
      await page.getByRole('link', { name: 'Keep it' }).click();
      await page.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      s.expect((await s.bookings())[0].status, 'status').toBe('confirmed');
    });

    await s.step('she cancels and says why', async () => {
      await page.getByRole('link', { name: 'Cancel meeting' }).click();
      await page.getByRole('textbox', { name: /Anything you would like to say/ }).fill('My flight was moved, sorry!');
      await page.getByRole('button', { name: 'Cancel meeting' }).click();
      await page.getByRole('heading', { name: 'This meeting was cancelled', level: 1 }).waitFor();
      await s.settle();
      await page.getByText('Cancelled', { exact: true }).waitFor();
      await page.getByText('Intro call with Jimi Cohen, cancelled by you on Mon, Nov 16.').waitFor();
      await page.getByText('My flight was moved, sorry!').waitFor();
      s.expect(await page.getByRole('link', { name: 'Book a new time' }).getAttribute('href'), 'rebook link').toBe('/meeting/intro');
      s.expect(await page.getByRole('link', { name: 'Open the meeting link' }).count(), 'join link on a cancelled meeting').toBe(0);
      await s.screenshot(page, 'cancelled');
    });

    await s.step('the booking is cancelled with her reason', async () => {
      const stored = (await s.bookings())[0];
      s.expect(stored, 'booking').toMatchObject({ status: 'cancelled', cancellation: { by: 'invitee', reason: 'My flight was moved, sorry!', at: '2026-11-16T09:00:00.000Z' } });
      s.expect(stored.timeline.find((e) => e.type === 'cancelled'), 'timeline').toMatchObject({ detail: 'Cancelled by the invitee: My flight was moved, sorry!' });
      s.expect((await manageView(s, booking)).booking, 'manage API').toMatchObject({ status: 'cancelled', canCancel: false, canReschedule: false, cancellation: { by: 'invitee', reason: 'My flight was moved, sorry!' } });
    });

    await s.step('the calendar event is deleted and the guests are told by Google', async () => {
      const deletes = await s.outbox({ kind: 'calendar_delete' });
      s.expect(deletes, 'deletes').toHaveLength(1);
      s.expect(deletes[0], 'delete').toMatchObject({ status: 204, account: OWNER_GOOGLE, eventId: booking.google.eventId, sendUpdates: 'all', notified: [ADA.email] });
      s.expect((await s.googleEvents(OWNER_GOOGLE))[0].event.status, 'event status').toBe('cancelled');
    });

    await s.step('cancellation emails: one to her, one to the host with the reason', async () => {
      const emails = await s.outbox({ kind: 'email' });
      s.expect(emails.map((e) => `${e.to.join(',')} | ${e.subject}`).sort(), 'emails').toEqual([
        `${ADA.email} | Cancelled: Intro call with Jimi Cohen, Wed, Nov 18, 11:00 AM EST`,
        `${OWNER_GOOGLE} | Cancelled: Ada Lovelace for Intro call, Wed, Nov 18, 4:00 PM GMT`,
      ]);
      const [host] = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
      s.expect(host.text, 'host text').toContain('My flight was moved, sorry!');
      const [mail] = await s.outbox({ kind: 'email', to: ADA.email });
      s.expect(mail.links, 'invitee can book again').toContain(s.url('/intro'));
      // She cancelled on the page herself: no text about it as well.
      s.expect(await s.outbox({ kind: 'sms' }), 'texts').toEqual([]);
      await s.screenshotEmail(mail, 'cancellation email');
    });

    await s.step('no reminder is left, and none goes out later', async () => {
      s.expect(await s.jobs(), 'queued jobs').toEqual([]);
      await s.clearOutbox();
      for (const at of [plus(START, -24 * HOUR), plus(START, -2 * HOUR), plus(START, -1 * HOUR), plus(START, -15 * MINUTE), START]) {
        await s.setClock(at);
        await s.runJobs();
      }
      s.expect((await s.outbox()).filter((e) => ['email', 'sms', 'call'].includes(e.kind)), 'messages after the cancellation').toEqual([]);
      await s.setClock('2026-11-16T09:00:00.000Z');
    });

    await s.step('the time is offered again and can be booked by someone else', async () => {
      s.expect(await s.slots({ slug: 'intro', duration: 15, from: '2026-11-18T00:00:00Z', to: '2026-11-19T00:00:00Z' }), 'Wednesday').toContain(START);
      const next = await s.book({ start: START, email: 'next@example.com' });
      s.expect(next.status, 'booking the freed time').toBe(201);
    });

    await s.step('cancelling again changes nothing and sends nothing', async () => {
      await s.settle();
      await s.clearOutbox();
      const again = await s.visitor().request('POST', `/public/bookings/${booking.id}/cancel`, { body: { t: booking.manageToken, reason: 'again' } });
      s.expect(again.status, 'second cancel').toBe(200);
      s.expect(again.data.booking.cancellation.reason, 'reason kept').toBe('My flight was moved, sorry!');
      await s.settle();
      s.expect((await s.outbox()).filter((e) => e.kind === 'email' || e.kind === 'calendar_delete'), 'messages').toEqual([]);
    });
  });

  await t.scenario('dead ends: wrong token, already cancelled, already started', async (s) => {
    await s.step('prepare', () => prepare(s));
    s.allowConsoleErrors(/status of 404/, /status of 410/);
    const booking = await s.step('Ada books', () => bookForAda(s));
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
    const visitor = s.visitor();

    await s.step('a wrong or missing token finds nothing, and does not say whether the booking exists', async () => {
      // The right token with its last character changed (whatever that character is).
      const wrong = `${booking.manageToken.slice(0, -1)}${booking.manageToken.endsWith('0') ? '1' : '0'}`;
      for (const [label, path] of [
        ['wrong token', `/booking/${booking.id}?t=${wrong}`],
        ['no token', `/booking/${booking.id}`],
        ['unknown booking', `/booking/bkg_doesnotexist0000?t=${booking.manageToken}`],
        ['wrong token on the cancel page', `/booking/${booking.id}/cancel?t=${wrong}`],
      ]) {
        await page.goto(s.url(path));
        await page.getByRole('heading', { name: 'We could not find that booking', level: 1 }).waitFor();
        await page.getByText('The link may be incomplete or out of date. Please open it again from your confirmation email.').waitFor();
        s.expect(await page.getByText(ADA.name).count(), `${label}: nothing about the booking is shown`).toBe(0);
      }
      await s.screenshot(page, 'not found');
      const real = await visitor.request('GET', `/public/bookings/${booking.id}`, { query: { t: wrong } });
      const fake = await visitor.request('GET', '/public/bookings/bkg_doesnotexist0000', { query: { t: wrong } });
      s.expect([real.status, fake.status], 'statuses').toEqual([404, 404]);
      s.expect(real.data, 'same answer for an existing and a missing booking').toEqual(fake.data);
      for (const action of ['cancel', 'reschedule', 'confirm']) {
        const res = await visitor.request('POST', `/public/bookings/${booking.id}/${action}`, { body: { t: wrong, start: NEW_START } });
        s.expect(res.status, `${action} with a wrong token`).toBe(404);
      }
      s.expect((await s.bookings())[0].status, 'the booking is untouched').toBe('confirmed');
    });

    await s.step('a meeting that has started can no longer be moved or cancelled from the link', async () => {
      await s.setClock(plus(START, 5 * MINUTE));
      await page.goto(`${s.url(`/booking/${booking.id}/reschedule`)}?t=${booking.manageToken}`);
      await page.getByText('This meeting can no longer be rescheduled from here.').waitFor();
      await page.getByText('Please contact Jimi directly.').waitFor();
      s.expect(await page.getByRole('heading', { name: 'Pick a new time' }).count(), 'no calendar').toBe(0);
      await page.goto(`${s.url(`/booking/${booking.id}/cancel`)}?t=${booking.manageToken}`);
      await page.getByText('This meeting can no longer be cancelled from here.').waitFor();
      s.expect(await page.getByRole('button', { name: 'Cancel meeting' }).count(), 'no cancel button').toBe(0);
      s.expect(await page.getByRole('link', { name: 'Reschedule' }).count(), 'no reschedule link').toBe(0);
      await s.screenshot(page, 'started');
      const view = await manageView(s, booking);
      s.expect(view.booking, 'manage API').toMatchObject({ status: 'confirmed', canCancel: false, canReschedule: false });
      const cancel = await visitor.request('POST', `/public/bookings/${booking.id}/cancel`, { body: { t: booking.manageToken } });
      s.expect([cancel.status, cancel.data.error.code], 'cancel after the start').toEqual([410, 'too_late']);
      const move = await visitor.request('POST', `/public/bookings/${booking.id}/reschedule`, { body: { t: booking.manageToken, start: '2026-11-20T10:00:00.000Z' } });
      s.expect([move.status, move.data.error.code], 'move after the start').toEqual([410, 'too_late']);
      s.expect((await s.bookings())[0], 'the booking is untouched').toMatchObject({ status: 'confirmed', start: START });
    });

    await s.step('after it ended the page says it has taken place', async () => {
      await s.setClock(plus(START, 2 * HOUR));
      await page.goto(booking.manageUrl);
      await page.getByRole('heading', { name: 'This meeting has taken place', level: 1 }).waitFor();
      await page.getByText('Past meeting').waitFor();
      s.expect(await page.getByRole('button', { name: "I'll be there" }).count(), 'no attendance button').toBe(0);
      s.expect(await page.getByRole('link', { name: 'Book another time' }).getAttribute('href'), 'rebook').toBe('/meeting/intro');
      const confirm = await visitor.request('POST', `/public/bookings/${booking.id}/confirm`, { body: { t: booking.manageToken } });
      s.expect([confirm.status, confirm.data.error.code], 'confirming a past meeting').toEqual([410, 'too_late']);
      await s.screenshot(page, 'past');
    });

    await s.step('a cancelled meeting: both links lead to the cancelled state, and it cannot be moved', async () => {
      await s.setClock('2026-11-16T09:00:00.000Z');
      const second = await bookForAda(s, { start: '2026-11-20T15:00:00.000Z', email: 'ada2@example.com' });
      const cancelled = await visitor.request('POST', `/public/bookings/${second.id}/cancel`, { body: { t: second.manageToken } });
      s.expect(cancelled.status, 'cancel').toBe(200);
      await s.settle();
      for (const action of ['reschedule', 'cancel']) {
        await page.goto(`${s.url(`/booking/${second.id}/${action}`)}?t=${second.manageToken}`);
        await page.getByRole('heading', { name: 'This meeting was cancelled', level: 1 }).waitFor();
        s.expect(await page.getByRole('heading', { name: 'Pick a new time' }).count(), `${action}: no calendar`).toBe(0);
        s.expect(await page.getByRole('button', { name: 'Cancel meeting' }).count(), `${action}: no cancel button`).toBe(0);
        await page.getByRole('link', { name: 'Book a new time' }).waitFor();
      }
      const move = await visitor.request('POST', `/public/bookings/${second.id}/reschedule`, { body: { t: second.manageToken, start: '2026-11-20T10:00:00.000Z' } });
      s.expect([move.status, move.data.error.code], 'moving a cancelled booking').toEqual([410, 'cancelled']);
      const confirm = await visitor.request('POST', `/public/bookings/${second.id}/confirm`, { body: { t: second.manageToken } });
      s.expect([confirm.status, confirm.data.error.code], 'confirming a cancelled booking').toEqual([410, 'cancelled']);
    });
  });

  await t.scenario('a host moves and then cancels the meeting from the link in their own email', { reset: true }, async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books from New York', () => bookForAda(s));
    const [notice] = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
    const hostLink = `${booking.manageUrl}&as=host`;
    s.expect(notice.links, 'the host notice carries the marked manage link').toContain(hostLink);
    await s.clearOutbox();

    // The host is travelling: their browser is in Nairobi.
    const page = await s.newPage({ timezoneId: 'Africa/Nairobi', locale: 'en-US', allowConsoleErrors: [/status of 409/] });
    await s.step('the page speaks to the host about Ada, and offers no "I\'ll be there" that would be taken as hers', async () => {
      await page.goto(hostLink);
      await page.getByText("Ada's meeting with Jimi Cohen.").waitFor();
      await page.getByText('Ada has not said yet whether they will be there.').waitFor();
      s.expect(await page.getByRole('button', { name: "I'll be there" }).count(), 'no attendance button for a host').toBe(0);
      s.expect(await page.getByText('Still coming?').count(), 'no question for Ada').toBe(0);
      // The reminder email's one-tap link opened as a host's does not answer for her either.
      await page.goto(`${hostLink}&confirm=1`);
      await page.getByText("Ada's meeting with Jimi Cohen.").waitFor();
      await s.settle();
      s.expect((await s.bookings({ id: booking.id }))[0].attendance, 'attendance').toEqual({});
      const asHost = await s.visitor().request('POST', `/public/bookings/${booking.id}/confirm`, { body: { t: booking.manageToken, as: 'host' } });
      s.expect([asHost.status, asHost.data.error.code], 'confirm from a host link').toEqual([409, 'host_link']);
      await s.screenshot(page, 'booking page from a host link');
    });

    await s.step('the link keeps saying a host is acting on every page it leads to', async () => {
      await page.goto(hostLink);
      const reschedule = page.getByRole('link', { name: 'Reschedule' });
      s.expect(await reschedule.getAttribute('href'), 'reschedule link').toBe(`/meeting/booking/${booking.id}/reschedule?t=${booking.manageToken}&as=host`);
      await reschedule.click();
      await page.getByRole('heading', { name: 'Pick a new time' }).waitFor();
      await calendarReady(page);
    });

    await s.step('the host picks Thursday and confirms: Ada keeps her own zone and is told by email and text', async () => {
      await pickDay(page, '2026-11-19');
      await pickSlot(page, NEW_START);
      await page.locator('.bw-confirmbar').getByRole('button', { name: 'Confirm new time' }).click();
      await page.getByText('Your meeting has moved').waitFor();
      await s.settle();
      const stored = (await s.bookings({ id: booking.id }))[0];
      s.expect(stored, 'booking').toMatchObject({ start: NEW_START, rescheduleCount: 1, invitee: { timezone: NEW_YORK } });
      s.expect(stored.timeline.filter((e) => e.type === 'rescheduled').at(-1).detail, 'timeline').toMatch(/by a host, from the booking page$/);
      const [mail] = await s.outbox({ kind: 'email', to: ADA.email });
      s.expect(mail.text, 'her email, in her zone').toContain('9:30 AM to 9:45 AM (Eastern Standard Time)');
      s.expect((await s.outbox({ kind: 'sms' })).map((x) => x.to), 'texts').toEqual([PHONE]);
    });

    await s.step('the host cancels from the same link: recorded as a host\'s, Ada and the owner are told', async () => {
      await s.clearOutbox();
      await page.goto(`${s.url(`/booking/${booking.id}/cancel`)}?t=${booking.manageToken}&as=host`);
      await page.getByRole('heading', { name: 'Cancel this meeting?', level: 1 }).waitFor();
      // Typed through a host's link, the reason is mailed to the hosts only (the invitee holds the same link),
      // but it shows on the booking page, which Ada opens too: the hint says so, not that only hosts see it.
      await page.getByText('The hosts are sent this. It also shows on this page, which Ada can open too.').waitFor();
      s.expect(await page.getByText(/Only the hosts see this/).count(), 'a hint that hides who reads it').toBe(0);
      await page.getByRole('textbox').fill('Something came up on my side.');
      await page.getByRole('button', { name: 'Cancel meeting' }).click();
      await page.getByRole('heading', { name: 'This meeting was cancelled', level: 1 }).waitFor();
      // Any host may hold that link, so the page does not guess a name.
      await page.getByText(/^Intro call with Jimi Cohen, cancelled by the host on /).waitFor();
      await s.settle();
      const stored = (await s.bookings({ id: booking.id }))[0];
      s.expect(stored.cancellation, 'cancellation').toMatchObject({ by: 'host', via: 'host_link', reason: 'Something came up on my side.' });
      s.expect(stored.timeline.find((e) => e.type === 'cancelled').detail, 'timeline').toBe('Cancelled by a host, from the booking page: Something came up on my side.');
      const toAda = await s.outbox({ kind: 'email', to: ADA.email });
      s.expect(toAda, 'email to Ada').toHaveLength(1);
      s.expect(toAda[0].text, 'what Ada is sent').not.toContain('Something came up on my side.');
      const toOwner = await s.outbox({ kind: 'email', to: OWNER_GOOGLE });
      s.expect(toOwner, 'email to the owner').toHaveLength(1);
      s.expect(toOwner[0].text, 'what the owner is sent').toContain('Something came up on my side.');
      s.expect((await s.outbox({ kind: 'sms' })).map((x) => x.to), 'texts').toEqual([PHONE]);
      // Ada opens the link from her own emails: the booking page shows her the reason, as the hint said it would.
      const ada = await s.newPage({ timezoneId: NEW_YORK });
      await ada.goto(`${s.url(`/booking/${booking.id}`)}?t=${booking.manageToken}`);
      await ada.getByRole('heading', { name: 'This meeting was cancelled', level: 1 }).waitFor();
      s.expect(await ada.locator('.bm__reason').innerText(), "the reason on Ada's page").toContain('Something came up on my side.');
    });
  });

  await t.scenario('the signed-in owner moves a meeting the invitee may no longer move, and cancels it after it started', { reset: true }, async (s) => {
    await s.step('prepare', () => prepare(s));
    // The owner's own browser, signed in to the dashboard.
    const owner = await s.newPage({ signedIn: true, timezoneId: 'Europe/London', locale: 'en-US' });
    const booking = await s.step('Ada books from New York and moves the meeting five times, the most she may', async () => {
      const made = await bookForAda(s);
      const moves = ['2026-11-19T10:00:00.000Z', '2026-11-19T11:00:00.000Z', '2026-11-19T12:00:00.000Z', '2026-11-20T10:00:00.000Z', '2026-11-20T11:00:00.000Z'];
      for (const [i, start] of moves.entries()) {
        if (i === 3) await s.advanceClock({ hours: 1 }); // three moves an hour
        const res = await s.visitor().request('POST', `/public/bookings/${made.id}/reschedule`, { body: { t: made.manageToken, start, timezone: NEW_YORK } });
        s.expect(res.status, `move ${i + 1}`).toBe(200);
      }
      await s.settle();
      s.expect((await s.bookings({ id: made.id }))[0].rescheduleCount, 'moves').toBe(5);
      return made;
    });

    await s.step('a host link without the owner\'s session is held to the same limit', async () => {
      const coHost = await s.newPage({ timezoneId: 'Africa/Nairobi', locale: 'en-US', allowConsoleErrors: [/status of 409/] });
      await coHost.goto(`${s.url(`/booking/${booking.id}/reschedule`)}?t=${booking.manageToken}&as=host`);
      await coHost.getByRole('heading', { name: 'Pick a new time' }).waitFor();
      await calendarReady(coHost);
      await pickDay(coHost, '2026-11-19');
      await pickSlot(coHost, NEW_START);
      await s.linger(coHost);
      await coHost.locator('.bw-confirmbar').getByRole('button', { name: 'Confirm new time' }).click();
      const notice = coHost.getByRole('alert').filter({ hasText: 'This meeting cannot be moved again right now' });
      await notice.waitFor();
      s.expect(await notice.innerText(), 'notice').toContain('The owner can still move it here while signed in to the dashboard in this browser.');
      s.expect((await s.bookings({ id: booking.id }))[0].start, 'not moved').toBe('2026-11-20T11:00:00.000Z');
      await coHost.close();
    });

    const tab = await s.step('the owner opens Reschedule in the dashboard drawer and moves it', async () => {
      await owner.goto(s.url(`/admin/bookings?b=${booking.id}`));
      const drawer = owner.getByRole('dialog').filter({ has: owner.locator('.adm-bk__body') });
      const link = drawer.getByRole('link', { name: 'Reschedule' });
      const [opened] = await Promise.all([owner.context().waitForEvent('page'), link.click()]);
      await opened.waitForLoadState();
      await opened.getByRole('heading', { name: 'Pick a new time' }).waitFor();
      await calendarReady(opened);
      await pickDay(opened, '2026-11-19');
      await pickSlot(opened, NEW_START);
      await s.linger(opened);
      await opened.locator('.bw-confirmbar').getByRole('button', { name: 'Confirm new time' }).click();
      await opened.getByText('Your meeting has moved').waitFor();
      await s.settle();
      const stored = (await s.bookings({ id: booking.id }))[0];
      s.expect(stored, 'booking').toMatchObject({ start: NEW_START, rescheduleCount: 6, invitee: { timezone: NEW_YORK } });
      s.expect(stored.timeline.filter((e) => e.type === 'rescheduled').at(-1).detail, 'timeline').toMatch(/by the owner, from the booking page$/);
      return opened;
    });

    await s.step('once the meeting has started only the owner can still cancel it: recorded as the owner\'s, and Ada is told', async () => {
      await s.clearOutbox();
      await s.setClock('2026-11-19T14:35:00.000Z');
      await tab.goto(`${s.url(`/booking/${booking.id}/cancel`)}?t=${booking.manageToken}&as=host`);
      await tab.getByRole('heading', { name: 'Cancel this meeting?', level: 1 }).waitFor();
      // The owner's reason goes to Ada, and the hint says so (not that the host will see it).
      await tab.getByText('Ada will see this with the cancellation.').waitFor();
      s.expect(await tab.getByText('Jimi will see this with the cancellation.').count(), 'the hint for an invitee').toBe(0);
      await tab.getByRole('textbox').fill('I have to stop early today.');
      await tab.getByRole('button', { name: 'Cancel meeting' }).click();
      await tab.getByRole('heading', { name: 'This meeting was cancelled', level: 1 }).waitFor();
      await tab.getByText(/cancelled by Jimi on /).waitFor();
      await s.settle();
      const stored = (await s.bookings({ id: booking.id }))[0];
      s.expect(stored.cancellation, 'cancellation').toEqual({ at: '2026-11-19T14:35:00.000Z', by: 'host', reason: 'I have to stop early today.' });
      s.expect(stored.timeline.find((e) => e.type === 'cancelled').detail, 'timeline').toBe('Cancelled by the owner, from the booking page: I have to stop early today.');
      const toAda = await s.outbox({ kind: 'email', to: ADA.email });
      s.expect(toAda, 'email to Ada').toHaveLength(1);
      s.expect(toAda[0].text, "the owner's reason, sent to Ada").toContain('Reason given: I have to stop early today.');
      s.expect(await s.outbox({ kind: 'email', to: OWNER_GOOGLE }), 'no email to the owner about their own cancellation').toHaveLength(0);
    });
  });

  await t.scenario('a meeting that now lies past a shorter booking window can still be moved to the weeks before it', { reset: true }, async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books Monday, December 7', async () => {
      const res = await s.book({ start: '2026-12-07T10:00:00.000Z', ...ADA, timezone: 'Europe/London' });
      s.expect(res.status, 'booking').toBe(201);
      await s.settle();
      return (await s.bookings({ id: res.data.booking.id }))[0];
    });
    await s.step('the owner then lets people book only ten days ahead', () => s.apiOk('PUT', '/admin/event-types/evt_intro', { body: { scheduling: { maxDaysAhead: 10 } } }));

    const page = await s.newPage({ timezoneId: 'Europe/London', locale: 'en-US' });
    await s.step('the reschedule page opens on the weeks that have times, not on "No open times"', async () => {
      await page.goto(s.url(`/booking/${booking.id}/reschedule?t=${booking.manageToken}`));
      await page.getByRole('heading', { name: 'Pick a new time' }).waitFor();
      await page.getByRole('grid', { name: 'November 2026' }).waitFor();
      await calendarReady(page);
      s.expect(await page.getByText('No open times right now').count(), 'the dead end').toBe(0);
      s.expect((await page.locator('.bw-day.is-open').evaluateAll((nodes) => nodes.map((n) => n.dataset.day)))[0], 'first day with times').toBe('2026-11-16');
      await s.screenshot(page, 'reschedule inside the shorter window');
    });

    await s.step('while Google cannot be asked, the move waits: "try again in a minute", and the time stays chosen', async () => {
      s.allowConsoleErrors(/status of 503/);
      await pickDay(page, '2026-11-18');
      await pickSlot(page, '2026-11-18T10:00:00.000Z');
      await s.failService('google-freebusy');
      await s.linger(page);
      await page.getByRole('button', { name: 'Confirm new time' }).click();
      const notice = page.getByRole('alert').filter({ hasText: 'The calendar is not answering right now' });
      await notice.waitFor();
      s.expect((await notice.innerText()).replace(/\s+/g, ' '), 'notice').toBe('The calendar is not answering right now Your meeting has not been moved. Please try again in a minute.');
      s.expect(await page.getByText('That time was just taken').count(), 'told the time was taken').toBe(0);
      s.expect(await page.locator('.bw-slot.is-selected').getAttribute('data-start'), 'the chosen time').toBe(String(Date.parse('2026-11-18T10:00:00.000Z')));
      s.expect((await s.bookings({ id: booking.id }))[0].start, 'the booking').toBe('2026-12-07T10:00:00.000Z');
    });

    await s.step('and once Google answers again, the meeting moves', async () => {
      await s.clearFailures();
      // A failed calendar read is remembered for a few seconds.
      await s.advanceClock({ seconds: 20 });
      await s.linger(page);
      await page.getByRole('button', { name: 'Confirm new time' }).click();
      await page.getByText('Your meeting has moved').waitFor();
      await page.getByText(`Google Calendar is sending an updated invitation to ${ADA.email}, which moves the meeting in your calendar.`).waitFor();
      await s.settle();
      s.expect((await s.bookings({ id: booking.id }))[0], 'the booking').toMatchObject({ start: '2026-11-18T10:00:00.000Z', rescheduleCount: 1 });
    });
  });

  await t.scenario('a move that runs into another change of the same booking says so, and keeps the chosen time', { reset: true }, async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books from New York', () => bookForAda(s));
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
    await s.step('her move is refused because another change of the booking is still being saved', async () => {
      s.allowConsoleErrors(/status of 409/);
      await page.goto(s.url(`/booking/${booking.id}/reschedule?t=${booking.manageToken}`));
      await page.getByRole('heading', { name: 'Pick a new time' }).waitFor();
      await calendarReady(page);
      await pickDay(page, '2026-11-19');
      await pickSlot(page, NEW_START);
      // What the server answers while record and index of the booking disagree (a move still being saved).
      const message = 'This booking was just changed somewhere else. Please wait a few minutes, then reload the page to see where it stands.';
      await page.route(
        (url) => url.pathname === `/meeting/api/public/bookings/${booking.id}/reschedule`,
        (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'changed', message } }) }),
        { times: 1 },
      );
      await s.linger(page);
      await page.locator('.bw-confirmbar').getByRole('button', { name: 'Confirm new time' }).click();
      const notice = page.getByRole('alert').filter({ hasText: 'This booking was just changed' });
      await notice.waitFor();
      s.expect((await notice.innerText()).replace(/\s+/g, ' '), 'notice').toBe(`This booking was just changed ${message}`);
      s.expect(await page.getByText('That time was just taken').count(), 'told the time was taken').toBe(0);
      s.expect(await page.locator('.bw-slot.is-selected').getAttribute('data-start'), 'the chosen time').toBe(String(Date.parse(NEW_START)));
    });
    await s.step('trying again moves the meeting', async () => {
      await s.linger(page);
      await page.locator('.bw-confirmbar').getByRole('button', { name: 'Confirm new time' }).click();
      await page.getByText('Your meeting has moved').waitFor();
      await s.settle();
      s.expect((await s.bookings({ id: booking.id }))[0], 'the booking').toMatchObject({ start: NEW_START, rescheduleCount: 1 });
    });
  });

  await t.scenario('a meeting of a paused event type: the owner is told why it cannot be moved, not to contact themselves', { reset: true }, async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books, then the owner pauses Intro call', async () => {
      const made = await bookForAda(s);
      await s.apiOk('PUT', '/admin/event-types/evt_intro', { body: { active: false } });
      return made;
    });
    const owner = await s.newPage({ signedIn: true, timezoneId: 'Europe/London', locale: 'en-US' });
    await s.step('the drawer says the meeting cannot be moved while its event type is paused, instead of offering Reschedule', async () => {
      await owner.goto(s.url(`/admin/bookings?b=${booking.id}`));
      const drawer = owner.getByRole('dialog').filter({ has: owner.locator('.adm-bk__body') });
      await drawer.getByText('"Intro call" is paused, so this meeting cannot be moved. Turn it back on under Event types to move it.').waitFor();
      s.expect(await drawer.getByRole('link', { name: 'Reschedule' }).count(), 'Reschedule in the drawer').toBe(0);
      await drawer.getByRole('button', { name: 'Cancel meeting' }).waitFor();
      await s.screenshot(owner, 'drawer for a booking of a paused event type');
    });
    await s.step("the booking page opened as the owner names the pause, and never says to contact the owner", async () => {
      await owner.goto(`${s.url(`/booking/${booking.id}/reschedule`)}?t=${booking.manageToken}&as=host`);
      await owner.getByText('"Intro call" is paused, so this meeting cannot be moved.').waitFor();
      await owner.getByText('Turn it back on under Event types in your dashboard to move it, or cancel the meeting.').waitFor();
      s.expect(await owner.getByText(/Please contact Jimi/).count(), 'told to contact Jimi').toBe(0);
    });
    await s.step('Ada herself is still asked to get in touch with Jimi', async () => {
      const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US' });
      await page.goto(`${s.url(`/booking/${booking.id}/reschedule`)}?t=${booking.manageToken}`);
      await page.getByText('This meeting can no longer be rescheduled from here.').waitFor();
      await page.getByText('Please contact Jimi directly.').waitFor();
    });
  });

  await t.scenario('the answer to a move is lost on the way back: the page shows the meeting as moved', { reset: true }, async (s) => {
    await s.step('prepare', () => prepare(s));
    const booking = await s.step('Ada books from New York', () => bookForAda(s));
    const page = await s.newPage({ timezoneId: NEW_YORK, locale: 'en-US', allowConsoleErrors: [/ERR_FAILED/, /ERR_CONNECTION_RESET/, /Failed to load resource/] });
    let dropped = false;
    await page.route('**/public/bookings/*/reschedule', async (route) => {
      if (dropped) return route.continue();
      dropped = true;
      await route.fetch(); // the server gets it and moves the meeting
      await route.abort('connectionreset'); // the phone loses the answer
    });
    await s.step('she confirms Thursday; the answer is lost, and the page looks before it says anything', async () => {
      await page.goto(`${s.url(`/booking/${booking.id}/reschedule`)}?t=${booking.manageToken}`);
      await page.getByRole('heading', { name: 'Pick a new time' }).waitFor();
      await calendarReady(page);
      await pickDay(page, '2026-11-19');
      await pickSlot(page, NEW_START);
      await s.linger(page);
      await page.locator('.bw-confirmbar').getByRole('button', { name: 'Confirm new time' }).click();
      await page.getByText('Your meeting has moved').waitFor();
      s.expect(dropped, 'the answer was dropped').toBe(true);
      s.expect(await page.getByText('We could not move your meeting').count(), 'told the move failed').toBe(0);
      await s.settle();
      const [stored] = await s.bookings({ id: booking.id });
      s.expect(stored, 'the booking').toMatchObject({ start: NEW_START, rescheduleCount: 1 });
      await s.screenshot(page, 'a move whose answer was lost');
    });
  });
});
