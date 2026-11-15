/**
 * Event types and availability, driven through the dashboard in a real browser against the
 * real backend. Every edit is checked twice: in what is stored, and in the page after a reload.
 */
import { defineSuite } from './lib.mjs';
import { MONDAY, clearToasts, expectFieldProblem, expectToast, offeredTimes, openBookingPage, openDays, openPage, saveBar, timeRange, wallTime } from './admin-helpers.mjs';

const CO_HOST = { name: 'Alex Rivera', email: 'alex@example.com' };

/** The stored event type with this link. */
async function storedEvent(s, slug) {
  return (await s.kv('event-types')).find((e) => e.slug === slug) ?? null;
}

/** Creates an event type through "New event type" and returns its id. */
async function createThroughUi(s, page, kindButton, title) {
  await openPage(page, 'Event types');
  await page.getByRole('button', { name: 'New event type' }).first().click();
  await page.getByRole('dialog', { name: 'What kind of meeting?' }).getByRole('button', { name: kindButton }).click();
  await page.getByRole('heading', { name: 'New event type', level: 1 }).waitFor();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(title);
  await saveBar(page).getByRole('button', { name: 'Create event type' }).click();
  await expectToast(page, `"${title}" is ready to share`);
  await page.waitForURL(/\/admin\/event-types\/evt_[A-Za-z0-9_-]+$/);
  await page.getByRole('heading', { name: title, level: 1 }).waitFor();
  await clearToasts(page);
  return new URL(page.url()).pathname.split('/').pop();
}

async function openTab(page, name) {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
  await page.getByRole('tab', { name: new RegExp(`^${name}`), selected: true }).waitFor();
  return page.getByRole('tabpanel');
}

/** One question card on the Questions tab, by its position (1-based). */
function questionCard(page, n) {
  return page.locator('li.adm-question').nth(n - 1);
}

/** The next save of an event type is sent with a changed body, as a stale or broken client would send it. */
async function tamperNextSave(page, mutate) {
  await page.route(
    (url) => url.pathname.startsWith('/meeting/api/admin/event-types'),
    async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      mutate(body);
      await route.continue({ postData: JSON.stringify(body) });
    },
    { times: 1 },
  );
}

/** Presses the save button and returns the server's answer to it. */
async function saveAndCatch(page, id) {
  const answer = page.waitForResponse((r) => r.url().endsWith(`/api/admin/event-types/${id}`) && r.request().method() === 'PUT');
  await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
  const response = await answer;
  return { status: response.status(), body: await response.json() };
}

export default defineSuite('admin-events', { mockCreds: true }, async (t) => {
  await t.scenario('event types: create each kind, edit every tab, validation, reorder, duplicate, pause, delete', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'UTC' });
    const coHost = (await s.apiOk('POST', '/admin/hosts', { body: CO_HOST })).host;
    const page = await s.newPage({ signedIn: true });
    await page.goto(s.url('/admin'));
    const ids = {};

    await s.step('create one of each kind through the dashboard', async () => {
      ids.solo = await createThroughUi(s, page, /^Just me/, 'Strategy session');
      s.expect(await storedEvent(s, 'strategy-session'), 'the solo event').toMatchObject({ id: ids.solo, title: 'Strategy session', kind: 'solo', hostIds: ['host_owner'], durations: [30], active: true, visibility: 'public' });

      ids.together = await createThroughUi(s, page, /^Together/, 'Joint review');
      s.expect(await storedEvent(s, 'joint-review'), 'the together event').toMatchObject({ id: ids.together, kind: 'collective', hostIds: ['host_owner', coHost.id] });
      await page.getByText('Together', { exact: true }).first().waitFor();

      ids.robin = await createThroughUi(s, page, /^Round robin/, 'Quick help');
      s.expect(await storedEvent(s, 'quick-help'), 'the round robin event').toMatchObject({ id: ids.robin, kind: 'round_robin', hostIds: ['host_owner', coHost.id] });

      // All three are on the list, after the two starter events, and on the public page.
      await openPage(page, 'Event types');
      const titles = await page.locator('ul.adm-events > li .adm-event__title').allTextContents();
      s.expect(titles, 'event types on the list').toEqual(['Intro call', 'Meeting', 'Strategy session', 'Joint review', 'Quick help']);
      const site = await s.apiOk('GET', '/public/site');
      s.expect(site.eventTypes.map((e) => e.slug), 'event types on the public page').toEqual(['intro', 'meeting', 'strategy-session', 'joint-review', 'quick-help']);
    });

    await s.step('basics: description, emoji, colour, several lengths, several places', async () => {
      await page.getByRole('link', { name: 'Strategy session', exact: true }).click();
      await page.getByRole('heading', { name: 'Strategy session', level: 1 }).waitFor();
      const panel = page.getByRole('tabpanel');
      await panel.getByLabel('Description').fill('Ninety minutes on where to take things next.');
      await panel.getByRole('button', { name: 'Use 🎯' }).click();
      await panel.getByRole('group', { name: 'Event colour: suggestions' }).getByRole('button', { name: 'Use #3b6fd4' }).click();
      const lengths = panel.getByRole('group', { name: 'Lengths on offer' });
      await lengths.getByRole('button', { name: '45 min' }).click();
      await lengths.getByRole('button', { name: '60 min' }).click();
      await lengths.getByRole('textbox', { name: 'Another length in minutes' }).fill('50');
      await lengths.getByRole('button', { name: 'Add this length' }).click();
      await lengths.getByRole('button', { name: '50 min', pressed: true }).waitFor();
      await panel.getByLabel('Chosen by default').selectOption({ label: '45 minutes' });
      await panel.getByRole('button', { name: 'Add another place' }).click();
      await panel.getByRole('combobox', { name: 'Location 2' }).selectOption({ label: 'In person' });
      await panel.getByRole('textbox', { name: 'Address' }).fill('12 Garden Lane, Nairobi');
      await panel.getByRole('button', { name: 'Add another place' }).click();
      await panel.getByRole('combobox', { name: 'Location 3' }).selectOption({ label: 'Video link' });
      await panel.getByRole('textbox', { name: 'Link', exact: true }).last().fill('https://video.example.com/room/jimi');
    });

    await s.step('hosts: turn it into a together meeting with the co-host', async () => {
      const panel = await openTab(page, 'Hosts');
      await panel.getByRole('radio', { name: /^Together/ }).check();
      await panel.getByRole('checkbox', { name: /^Alex Rivera/ }).and(page.locator(':checked')).waitFor();
      await panel.getByRole('checkbox', { name: /^Jimi Cohen/ }).and(page.locator(':checked')).waitFor();
      await panel.getByText('People only see times when Jimi and Alex are both free.').waitFor();
    });

    await s.step('scheduling: notice, window, dates, buffers, increments, daily limit, restricted hours', async () => {
      const panel = await openTab(page, 'Scheduling');
      await panel.getByRole('combobox', { name: 'Minimum notice, unit' }).selectOption('days');
      await panel.getByRole('textbox', { name: 'Minimum notice, amount' }).fill('2');
      await panel.getByRole('textbox', { name: 'Book up to' }).fill('30');
      await panel.getByRole('switch', { name: 'Only between two dates' }).click();
      await panel.getByLabel('From', { exact: true }).fill('2026-11-17');
      await panel.getByLabel('Until', { exact: true }).fill('2026-12-18');
      await panel.getByLabel('Buffer before').selectOption({ label: '15 minutes' });
      await panel.getByLabel('Buffer after').selectOption({ label: '30 minutes' });
      await panel.getByLabel('Start times every').selectOption({ label: '1 hour' });
      await panel.getByRole('switch', { name: 'Limit bookings per day' }).click();
      await panel.getByRole('textbox', { name: 'Bookings per day' }).fill('2');
      await panel.getByRole('switch', { name: 'Only offer this event during certain hours' }).click();
      const week = panel.getByRole('group', { name: 'Weekly hours' });
      await week.getByRole('combobox', { name: 'Monday, range 1, start' }).selectOption('13:00');
      await week.getByRole('switch', { name: 'Friday' }).click();
      await week.getByRole('combobox', { name: 'Friday, range 1, start' }).waitFor({ state: 'detached' });
    });

    await s.step('questions: phone required, fewer guests, one question of every type', async () => {
      const panel = await openTab(page, 'Questions');
      await panel.getByRole('radiogroup', { name: 'Phone number' }).getByRole('radio', { name: 'Required' }).click();
      await panel.getByRole('textbox', { name: 'Guests per booking' }).fill('2');
      const add = async (n, label, type, { choices, hint, required } = {}) => {
        await panel.getByRole('button', { name: 'Add a question' }).click();
        const card = questionCard(page, n);
        await card.getByRole('textbox', { name: `Question ${n}`, exact: true }).fill(label);
        await card.getByLabel('Answer type').selectOption({ label: type });
        if (choices) {
          await card.getByLabel('Choices').fill(choices.join('\n'));
          await card.getByLabel('Choices').blur();
        }
        if (hint) await card.getByLabel('Hint inside the box').fill(hint);
        if (required) await card.getByRole('switch', { name: 'Required' }).click();
      };
      await add(2, 'Company', 'Short answer', { hint: 'Where you work', required: true });
      await add(3, 'Team size', 'Dropdown', { choices: ['1 to 10', '11 to 50', '51 or more'] });
      await add(4, 'Preferred format', 'Pick one', { choices: ['Workshop', 'Conversation'] });
      await add(5, 'Topics', 'Pick several', { choices: ['Strategy', 'Fundraising', 'Hiring'] });
      await add(6, 'Website', 'Link');
      await add(7, 'Budget in USD', 'Number', { required: true });
      // The last one moves up one place.
      await questionCard(page, 7).getByRole('button', { name: 'Move up' }).click();
      s.expect(await questionCard(page, 6).getByRole('textbox', { name: 'Question 6', exact: true }).inputValue(), 'question 6 after the move').toBe('Budget in USD');
    });

    await s.step('reminders: a custom text, an AI call, custom email wording, a host follow-up, one off, one removed', async () => {
      const panel = await openTab(page, 'Reminders');
      const addMenu = async (item) => {
        await panel.getByRole('button', { name: 'Add a reminder' }).click();
        await page.getByRole('menuitem', { name: item }).click();
        return page.getByRole('dialog', { name: 'Add a reminder' });
      };

      // A text with wording of my own, 30 minutes before. A variable is inserted with a click.
      let dialog = await addMenu(/^Text message/);
      await dialog.getByRole('textbox', { name: 'When, amount' }).fill('30');
      await dialog.getByRole('switch', { name: 'Write my own wording' }).click();
      await dialog.getByLabel('Message').fill('See you soon, ');
      await dialog.getByRole('button', { name: '{{invitee_first_name}}' }).click();
      s.expect(await dialog.getByLabel('Message').inputValue(), 'text wording').toBe('See you soon, {{invitee_first_name}}');
      await dialog.getByRole('button', { name: 'Add reminder' }).click();
      await panel.getByText('Text the invitee 30 minutes before').waitFor();

      // An AI call one hour before.
      dialog = await addMenu(/^AI phone call/);
      // It opens as "2 hours", in its own unit, not in the minutes the last reminder was written in.
      s.expect(await dialog.getByRole('textbox', { name: 'When, amount' }).inputValue(), 'amount a call rule starts with').toBe('2');
      s.expect(await dialog.getByRole('combobox', { name: 'When, unit' }).inputValue(), 'unit a call rule starts with').toBe('hours');
      await dialog.getByRole('textbox', { name: 'When, amount' }).fill('1');
      await dialog.getByText('Ava makes the call').waitFor();
      await dialog.getByRole('button', { name: 'Add reminder' }).click();
      await panel.getByText('AI assistant calls the invitee 1 hour before').waitFor();

      // The day-before email gets a subject and a message of its own.
      await panel.getByRole('listitem').filter({ hasText: 'Email the invitee 24 hours before' }).getByRole('button', { name: 'Edit this reminder' }).click();
      dialog = page.getByRole('dialog', { name: 'Edit reminder' });
      await dialog.getByRole('switch', { name: 'Write my own wording' }).click();
      await dialog.getByLabel('Subject').fill('Tomorrow: {{event_name}}');
      await dialog.getByLabel('Message').fill('Hi {{invitee_first_name}}, see you at {{time}}.');
      await dialog.getByRole('button', { name: 'Done' }).click();
      await panel.getByRole('listitem').filter({ hasText: 'Email the invitee 24 hours before' }).getByText('Your own wording').waitFor();

      // A follow-up email to the hosts two hours after the meeting.
      dialog = await addMenu(/^Email/);
      await dialog.getByRole('radiogroup', { name: 'Who gets it' }).getByRole('radio', { name: 'The hosts' }).click();
      await dialog.getByRole('combobox', { name: 'When, unit' }).selectOption('hours');
      await dialog.getByRole('textbox', { name: 'When, amount' }).fill('2');
      await dialog.getByLabel('Before or after').selectOption({ label: 'after it ends' });
      await dialog.getByRole('button', { name: 'Add reminder' }).click();
      await panel.getByText(/^Email the hosts 2 hours after/).waitFor();

      await panel.getByRole('switch', { name: 'Email the invitee 1 hour before: on' }).click();
      await panel.getByRole('listitem').filter({ hasText: 'Text the invitee 15 minutes before' }).getByRole('button', { name: 'Remove this reminder' }).click();
      await panel.getByText('Text the invitee 15 minutes before').waitFor({ state: 'detached' });
    });

    await s.step('confirmation and advanced: message, redirect, unlisted, no Google invite, a look of its own', async () => {
      let panel = await openTab(page, 'Confirmation');
      await panel.getByLabel('Your message').fill('Thank you. I will send an agenda the day before.');
      await panel.getByLabel('Redirect link').fill('https://example.com/thanks');
      await panel.getByText('People are sent to this link straight after booking').waitFor();
      panel = await openTab(page, 'Advanced');
      await panel.getByRole('radio', { name: /^Unlisted/ }).check();
      await panel.getByRole('switch', { name: 'Invite the invitee on the calendar event' }).click();
      await panel.getByRole('combobox', { name: 'Layout' }).selectOption({ label: 'Stacked' });
      await panel.getByRole('combobox', { name: 'Calendar' }).selectOption({ label: 'Minimal' });
      await panel.getByRole('combobox', { name: 'Time slots' }).selectOption({ label: 'Chips' });
    });

    const expected = {
      id: null,
      slug: 'strategy-session',
      title: 'Strategy session',
      description: 'Ninety minutes on where to take things next.',
      emoji: '🎯',
      color: '#3b6fd4',
      kind: 'collective',
      durations: [30, 45, 50, 60],
      defaultDuration: 45,
      locations: [{ type: 'google_meet' }, { type: 'in_person', value: '12 Garden Lane, Nairobi' }, { type: 'custom_link', value: 'https://video.example.com/room/jimi' }],
      visibility: 'unlisted',
      active: true,
      scheduling: {
        minNoticeMinutes: 2880,
        maxDaysAhead: 30,
        dateRange: { start: '2026-11-17', end: '2026-12-18' },
        bufferBeforeMin: 15,
        bufferAfterMin: 30,
        slotIncrementMin: 60,
        maxPerDay: 2,
        restrictHours: {
          0: [],
          1: [{ start: '13:00', end: '17:00' }],
          2: [{ start: '09:00', end: '17:00' }],
          3: [{ start: '09:00', end: '17:00' }],
          4: [{ start: '09:00', end: '17:00' }],
          5: [],
          6: [],
        },
      },
      questions: [
        { label: 'What would you like to talk about?', type: 'textarea', required: false },
        { label: 'Company', type: 'text', required: true, placeholder: 'Where you work' },
        { label: 'Team size', type: 'select', required: false, options: ['1 to 10', '11 to 50', '51 or more'] },
        { label: 'Preferred format', type: 'radio', required: false, options: ['Workshop', 'Conversation'] },
        { label: 'Topics', type: 'checkbox', required: false, options: ['Strategy', 'Fundraising', 'Hiring'] },
        { label: 'Budget in USD', type: 'number', required: true },
        { label: 'Website', type: 'url', required: false },
      ],
      allowGuests: true,
      maxGuests: 2,
      phone: 'required',
      reminders: [
        { enabled: true, channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 1440, subject: 'Tomorrow: {{event_name}}', body: 'Hi {{invitee_first_name}}, see you at {{time}}.' },
        { enabled: true, channel: 'call', audience: 'invitee', trigger: 'before_start', offsetMinutes: 120 },
        { enabled: false, channel: 'email', audience: 'invitee', trigger: 'before_start', offsetMinutes: 60 },
        { enabled: true, channel: 'call', audience: 'invitee', trigger: 'before_start', offsetMinutes: 60 },
        { enabled: true, channel: 'sms', audience: 'invitee', trigger: 'before_start', offsetMinutes: 30, body: 'See you soon, {{invitee_first_name}}' },
        { enabled: true, channel: 'email', audience: 'host', trigger: 'after_end', offsetMinutes: 120 },
      ],
      confirmation: { message: 'Thank you. I will send an agenda the day before.', redirectUrl: 'https://example.com/thanks' },
      googleInvite: false,
      themeOverride: { layout: 'stacked', calendarStyle: 'minimal', slotStyle: 'chips' },
    };

    await s.step('save: every value is stored', async () => {
      await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
      await expectToast(page, 'Saved');
      await saveBar(page).waitFor({ state: 'hidden' });
      const stored = await storedEvent(s, 'strategy-session');
      s.expect(stored, 'the stored event type').toMatchObject({ ...expected, id: ids.solo, hostIds: ['host_owner', coHost.id] });
      s.expect(stored.reminders.length, 'number of reminders').toBe(expected.reminders.length);
      s.expect(stored.questions.length, 'number of questions').toBe(expected.questions.length);
      // Wording that was not written stays empty, so the standard text is used.
      s.expect(stored.reminders[1].body ?? '', 'body of the call rule').toBe('');
      s.expect(stored.reminders[5].subject ?? '', 'subject of the host follow-up').toBe('');
    });

    await s.step('reload: every tab shows what was saved', async () => {
      await page.reload();
      await page.getByRole('heading', { name: 'Strategy session', level: 1 }).waitFor();
      await page.getByText('Unlisted', { exact: true }).first().waitFor();
      let panel = await openTab(page, 'Basics');
      const value = async (locator) => locator.inputValue();
      s.expect(await value(panel.getByRole('textbox', { name: 'Name', exact: true })), 'name').toBe('Strategy session');
      s.expect(await value(panel.getByRole('textbox', { name: 'Link', exact: true }).first()), 'link').toBe('strategy-session');
      s.expect(await value(panel.getByLabel('Description')), 'description').toBe(expected.description);
      s.expect(await value(panel.getByLabel('Emoji')), 'emoji').toBe('🎯');
      s.expect(await value(panel.getByRole('textbox', { name: 'Event colour: hex value' })), 'colour').toBe('#3b6fd4');
      const pressed = await panel.getByRole('group', { name: 'Lengths on offer' }).getByRole('button', { pressed: true }).allTextContents();
      s.expect(pressed, 'lengths switched on').toEqual(['30 min', '45 min', '50 min', '60 min']);
      s.expect(await value(panel.getByLabel('Chosen by default')), 'default length').toBe('45');
      s.expect(await value(panel.getByRole('combobox', { name: 'Location 1' })), 'location 1').toBe('google_meet');
      s.expect(await value(panel.getByRole('combobox', { name: 'Location 2' })), 'location 2').toBe('in_person');
      s.expect(await value(panel.getByRole('textbox', { name: 'Address' })), 'address').toBe('12 Garden Lane, Nairobi');
      s.expect(await value(panel.getByRole('combobox', { name: 'Location 3' })), 'location 3').toBe('custom_link');
      s.expect(await value(panel.getByRole('textbox', { name: 'Link', exact: true }).last()), 'video link').toBe('https://video.example.com/room/jimi');

      panel = await openTab(page, 'Hosts');
      s.expect(await panel.getByRole('radio', { name: /^Together/ }).isChecked(), 'together').toBe(true);
      s.expect(await panel.getByRole('checkbox', { name: /^Jimi Cohen/ }).isChecked(), 'Jimi hosts').toBe(true);
      s.expect(await panel.getByRole('checkbox', { name: /^Alex Rivera/ }).isChecked(), 'Alex hosts').toBe(true);

      panel = await openTab(page, 'Scheduling');
      s.expect(await value(panel.getByRole('textbox', { name: 'Minimum notice, amount' })), 'notice amount').toBe('2');
      s.expect(await value(panel.getByRole('combobox', { name: 'Minimum notice, unit' })), 'notice unit').toBe('days');
      s.expect(await value(panel.getByRole('textbox', { name: 'Book up to' })), 'window').toBe('30');
      s.expect(await panel.getByRole('switch', { name: 'Only between two dates' }).getAttribute('aria-checked'), 'date range switch').toBe('true');
      s.expect(await value(panel.getByLabel('From', { exact: true })), 'from').toBe('2026-11-17');
      s.expect(await value(panel.getByLabel('Until', { exact: true })), 'until').toBe('2026-12-18');
      s.expect(await value(panel.getByLabel('Buffer before')), 'buffer before').toBe('15');
      s.expect(await value(panel.getByLabel('Buffer after')), 'buffer after').toBe('30');
      s.expect(await value(panel.getByLabel('Start times every')), 'increment').toBe('60');
      s.expect(await value(panel.getByRole('textbox', { name: 'Bookings per day' })), 'daily limit').toBe('2');
      const week = panel.getByRole('group', { name: 'Weekly hours' });
      s.expect(await value(week.getByRole('combobox', { name: 'Monday, range 1, start' })), 'restricted Monday start').toBe('13:00');
      s.expect(await week.getByRole('switch', { name: 'Friday' }).getAttribute('aria-checked'), 'restricted Friday').toBe('false');
      s.expect(await week.getByRole('switch', { name: 'Tuesday' }).getAttribute('aria-checked'), 'restricted Tuesday').toBe('true');

      panel = await openTab(page, 'Questions');
      s.expect(await panel.getByRole('radiogroup', { name: 'Phone number' }).getByRole('radio', { name: 'Required' }).getAttribute('aria-checked'), 'phone required').toBe('true');
      s.expect(await value(panel.getByRole('textbox', { name: 'Guests per booking' })), 'guests').toBe('2');
      const shown = [];
      for (let n = 1; n <= 7; n++) {
        const card = questionCard(page, n);
        const type = await value(card.getByLabel('Answer type'));
        const entry = { label: await value(card.getByRole('textbox', { name: `Question ${n}`, exact: true })), type, required: (await card.getByRole('switch', { name: 'Required' }).getAttribute('aria-checked')) === 'true' };
        if (['select', 'radio', 'checkbox'].includes(type)) entry.options = (await value(card.getByLabel('Choices'))).split('\n');
        else if (await value(card.getByLabel('Hint inside the box'))) entry.placeholder = await value(card.getByLabel('Hint inside the box'));
        shown.push(entry);
      }
      s.expect(shown, 'questions on the page').toEqual(expected.questions);

      panel = await openTab(page, 'Reminders');
      const sentences = await panel.locator('ul.adm-rules .adm-rule__sentence').allTextContents();
      s.expect(sentences, 'reminders on the page').toEqual([
        'Email the invitee 24 hours before',
        'AI assistant calls the invitee 2 hours before',
        'Email the invitee 1 hour before',
        'AI assistant calls the invitee 1 hour before',
        'Text the invitee 30 minutes before',
        'Email the hosts 2 hours after it ends',
      ]);
      s.expect(await panel.getByRole('switch', { name: 'Email the invitee 1 hour before: on' }).getAttribute('aria-checked'), 'the switched-off reminder').toBe('false');
      await panel.getByRole('listitem').filter({ hasText: 'Text the invitee 30 minutes before' }).getByRole('button', { name: 'Edit this reminder' }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit reminder' });
      s.expect(await value(dialog.getByLabel('Message')), 'text wording in the dialog').toBe('See you soon, {{invitee_first_name}}');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });

      panel = await openTab(page, 'Confirmation');
      s.expect(await value(panel.getByLabel('Your message')), 'confirmation message').toBe(expected.confirmation.message);
      s.expect(await value(panel.getByLabel('Redirect link')), 'redirect').toBe('https://example.com/thanks');

      panel = await openTab(page, 'Advanced');
      s.expect(await panel.getByRole('radio', { name: /^Unlisted/ }).isChecked(), 'unlisted').toBe(true);
      s.expect(await panel.getByRole('switch', { name: 'Invite the invitee on the calendar event' }).getAttribute('aria-checked'), 'google invite').toBe('false');
      s.expect(await value(panel.getByRole('combobox', { name: 'Layout' })), 'layout').toBe('stacked');
      s.expect(await value(panel.getByRole('combobox', { name: 'Calendar' })), 'calendar style').toBe('minimal');
      s.expect(await value(panel.getByRole('combobox', { name: 'Time slots' })), 'slot style').toBe('chips');
      s.expect(await saveBar(page).count(), 'save bar after a reload').toBe(0);
      await s.screenshot(page, 'advanced tab after reload');
    });

    await s.step('the public side follows: unlisted, the lengths, the places, the questions and the look', async () => {
      const site = await s.apiOk('GET', '/public/site');
      s.expect(site.eventTypes.map((e) => e.slug), 'listed event types').toEqual(['intro', 'meeting', 'joint-review', 'quick-help']);
      const { eventType } = await s.apiOk('GET', '/public/event/strategy-session');
      s.expect(eventType, 'the public event type').toMatchObject({
        title: 'Strategy session',
        emoji: '🎯',
        color: '#3b6fd4',
        kind: 'collective',
        durations: [30, 45, 50, 60],
        defaultDuration: 45,
        phone: 'required',
        maxGuests: 2,
        themeOverride: { layout: 'stacked', calendarStyle: 'minimal', slotStyle: 'chips' },
      });
      s.expect(eventType.hosts.map((h) => h.name), 'hosts on the public page').toEqual(['Jimi Cohen', 'Alex Rivera']);
      s.expect(eventType.locations.map((l) => l.type), 'places on the public page').toEqual(['google_meet', 'in_person', 'custom_link']);
      s.expect(eventType.questions.map((q) => q.label), 'questions on the public page').toEqual(expected.questions.map((q) => q.label));
      // Two days of notice from Monday 09:00, no Fridays, Mondays only from 13:00, hourly starts, 45 minutes by default.
      const visitor = await s.newPage({ timezoneId: 'UTC' });
      await openBookingPage(s, visitor, 'strategy-session');
      await visitor.getByRole('heading', { name: 'Strategy session', level: 1 }).waitFor();
      const days = await openDays(visitor);
      s.expect(days.slice(0, 4), 'first days on offer').toEqual(['2026-11-18', '2026-11-19', '2026-11-23', '2026-11-24']);
      const wednesday = (await offeredTimes(visitor, '2026-11-18')).map((iso) => wallTime(iso, 'UTC'));
      s.expect(wednesday, 'times on Wednesday the 18th').toEqual(timeRange('09:00', '17:00', 60));
      const monday = (await offeredTimes(visitor, '2026-11-23')).map((iso) => wallTime(iso, 'UTC'));
      s.expect(monday, 'times on Monday the 23rd').toEqual(['13:00', '14:00', '15:00', '16:00']);
      // The date range ends on December 18: nothing is offered after it, although the 30 day window... ends earlier still.
      s.expect(days.every((day) => day >= '2026-11-18' && day <= '2026-12-16'), 'every day is inside the 30 day window').toBe(true);
      await s.screenshot(visitor, 'public page of the edited event');
      await visitor.context().close();
    });

    await s.step('validation on the page: a reserved link lands on Basics, wherever I am', async () => {
      await openPage(page, 'Event types');
      await page.getByRole('link', { name: 'Quick help', exact: true }).click();
      await page.getByRole('heading', { name: 'Quick help', level: 1 }).waitFor();
      let sent = 0;
      const count = (request) => {
        if (request.method() === 'PUT' && request.url().includes('/api/admin/event-types/')) sent += 1;
      };
      page.on('request', count);
      await page.getByRole('tabpanel').getByRole('textbox', { name: 'Link', exact: true }).fill('admin');
      await openTab(page, 'Advanced');
      await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
      await expectToast(page, 'A few things need fixing');
      await page.getByRole('tab', { name: /^Basics/, selected: true }).waitFor();
      await expectFieldProblem(s, page.getByRole('tabpanel').getByRole('textbox', { name: 'Link', exact: true }), 'That link is reserved. Please choose another.', 'problem on the link');
      s.expect(await page.getByRole('tab', { name: /^Basics/ }).textContent(), 'the Basics tab counts its problems').toMatch(/1/);
      s.expect(sent, 'saves sent to the server').toBe(0);
      page.off('request', count);
      await saveBar(page).getByRole('button', { name: 'Discard' }).click();
      await clearToasts(page);
    });

    await s.step('validation by the server: reserved link, duplicate link, bad length, a together meeting with one host', async () => {
      s.allowConsoleErrors(/status of 422/);
      const panel = page.getByRole('tabpanel');
      const link = () => page.getByRole('tabpanel').getByRole('textbox', { name: 'Link', exact: true });

      // Reserved: the page sends a link it believes is fine, the server knows better.
      await link().fill('quick-help-two');
      await tamperNextSave(page, (body) => {
        body.slug = 'api';
      });
      let answer = await saveAndCatch(page, ids.robin);
      s.expect(answer.status, 'status for a reserved link').toBe(422);
      s.expect(answer.body.error.fields, 'fields for a reserved link').toEqual({ slug: 'That link is reserved. Please choose another.' });
      await expectFieldProblem(s, link(), 'That link is reserved. Please choose another.', 'problem on the link');
      await clearToasts(page);

      // Duplicate: another window made an event with this link after this page had loaded.
      await s.apiOk('POST', '/admin/event-types', { body: { title: 'Made elsewhere', slug: 'taken-link' } });
      await link().fill('taken-link');
      s.expect(await page.getByRole('tabpanel').getByRole('textbox', { name: 'Link', exact: true }).getAttribute('aria-invalid'), 'the old problem is gone while typing').toBeNull();
      answer = await saveAndCatch(page, ids.robin);
      s.expect(answer.status, 'status for a duplicate link').toBe(422);
      s.expect(answer.body.error.fields, 'fields for a duplicate link').toEqual({ slug: 'Another event type already uses this link.' });
      await expectFieldProblem(s, link(), 'Another event type already uses this link.', 'problem on the link');
      await clearToasts(page);
      await link().fill('quick-help');

      // A length the server refuses, saved from the Advanced tab: the editor jumps to Basics.
      await panel.getByLabel('Description').fill('Whoever is free picks it up.');
      await openTab(page, 'Advanced');
      await tamperNextSave(page, (body) => {
        body.durations = [3, 30];
      });
      answer = await saveAndCatch(page, ids.robin);
      s.expect(answer.status, 'status for a bad length').toBe(422);
      s.expect(Object.keys(answer.body.error.fields), 'fields for a bad length').toEqual(['durations']);
      await page.getByRole('tab', { name: /^Basics/, selected: true }).waitFor();
      await page.getByRole('tabpanel').getByRole('group', { name: 'Lengths on offer' }).getByRole('alert').filter({ hasText: answer.body.error.fields.durations }).waitFor();
      s.expect(answer.body.error.fields.durations, 'message for a bad length').toContain('between 5 minutes and 8 hours');
      await clearToasts(page);

      // A together meeting that arrives with a single host: the editor jumps to Hosts.
      await openTab(page, 'Advanced');
      await tamperNextSave(page, (body) => {
        body.kind = 'collective';
        body.hostIds = ['host_owner'];
      });
      answer = await saveAndCatch(page, ids.robin);
      s.expect(answer.status, 'status for one host').toBe(422);
      s.expect(answer.body.error.fields, 'fields for one host').toEqual({ hostIds: 'Choose at least two hosts for this kind of meeting.' });
      await page.getByRole('tab', { name: /^Hosts/, selected: true }).waitFor();
      await page.getByRole('tabpanel').getByRole('group', { name: 'Hosts on this meeting' }).getByRole('alert').filter({ hasText: 'Choose at least two hosts for this kind of meeting.' }).waitFor();
      await clearToasts(page);

      // The same mistake made on the page itself is caught before it is sent.
      await page.getByRole('tabpanel').getByRole('checkbox', { name: /^Alex Rivera/ }).uncheck();
      await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
      await page.getByRole('tabpanel').getByRole('group', { name: 'Hosts on this meeting' }).getByRole('alert').filter({ hasText: 'Choose at least two hosts for this kind of meeting.' }).waitFor();
      await clearToasts(page);
      await page.getByRole('tabpanel').getByRole('checkbox', { name: /^Alex Rivera/ }).check();

      // Nothing of all this was stored. Then the honest save goes through.
      s.expect(await storedEvent(s, 'quick-help'), 'the stored event after refused saves').toMatchObject({ kind: 'round_robin', durations: [30], description: '', hostIds: ['host_owner', coHost.id] });
      answer = await saveAndCatch(page, ids.robin);
      s.expect(answer.status, 'status of the honest save').toBe(200);
      await expectToast(page, 'Saved');
      s.expect((await storedEvent(s, 'quick-help')).description, 'description after the honest save').toBe('Whoever is free picks it up.');
      await clearToasts(page);
    });

    await s.step('reorder with the arrows: the list, the store and the public page follow', async () => {
      await page.goto(s.url('/admin/event-types'));
      await page.getByRole('heading', { name: 'Event types', level: 1 }).waitFor();
      const titles = () => page.locator('ul.adm-events > li .adm-event__title').allTextContents();
      s.expect(await titles(), 'order before').toEqual(['Intro call', 'Meeting', 'Strategy session', 'Joint review', 'Quick help', 'Made elsewhere']);
      const move = async (title, item) => {
        const saved = page.waitForResponse((r) => r.url().endsWith('/api/admin/event-types-order') && r.status() === 200);
        await page.getByRole('button', { name: `More actions for ${title}` }).click();
        await page.getByRole('menuitem', { name: item }).click();
        await saved;
      };
      await move('Quick help', 'Move up');
      await move('Quick help', 'Move up');
      await move('Intro call', 'Move down');
      const wanted = ['Meeting', 'Intro call', 'Quick help', 'Strategy session', 'Joint review', 'Made elsewhere'];
      s.expect(await titles(), 'order after').toEqual(wanted);
      const stored = (await s.kv('event-types')).slice().sort((a, b) => a.position - b.position);
      s.expect(stored.map((e) => e.title), 'stored order').toEqual(wanted);
      s.expect(stored.map((e) => e.position), 'stored positions').toEqual([0, 1, 2, 3, 4, 5]);
      await page.reload();
      await page.getByRole('heading', { name: 'Event types', level: 1 }).waitFor();
      s.expect(await titles(), 'order after a reload').toEqual(wanted);
      // The first row cannot move up, the last cannot move down.
      await page.getByRole('button', { name: 'More actions for Meeting' }).click();
      s.expect(await page.getByRole('menuitem', { name: 'Move up' }).getAttribute('aria-disabled'), 'move up on the first row').toBe('true');
      await page.keyboard.press('Escape');
      const site = await s.apiOk('GET', '/public/site');
      s.expect(site.eventTypes.map((e) => e.title), 'order on the public page').toEqual(['Meeting', 'Intro call', 'Quick help', 'Joint review', 'Made elsewhere']);
    });

    await s.step('duplicate: a copy with its own link opens in the editor', async () => {
      await page.getByRole('button', { name: 'More actions for Meeting' }).click();
      await page.getByRole('menuitem', { name: 'Duplicate' }).click();
      await expectToast(page, 'Copied as "Copy of Meeting"');
      await page.getByRole('heading', { name: 'Copy of Meeting', level: 1 }).waitFor();
      const copy = await storedEvent(s, 'meeting-copy');
      const source = await storedEvent(s, 'meeting');
      s.expect(copy, 'the copy').toMatchObject({ title: 'Copy of Meeting', durations: source.durations, kind: source.kind, hostIds: source.hostIds, reminders: source.reminders, position: 6 });
      s.expect(copy.id, 'the copy has an id of its own').not.toBe(source.id);
      s.expect(new URL(page.url()).pathname, 'address of the copy').toBe(`/meeting/admin/event-types/${copy.id}`);
      await clearToasts(page);
    });

    await s.step('pause: nobody can book it, and it leaves the public page', async () => {
      await openPage(page, 'Event types');
      await page.getByRole('switch', { name: 'Joint review: accept bookings' }).click();
      await expectToast(page, 'Joint review is paused');
      await page.getByRole('switch', { name: 'Joint review: accept bookings', checked: false }).waitFor();
      s.expect((await storedEvent(s, 'joint-review')).active, 'stored active flag').toBe(false);
      s.expect((await s.api('GET', '/public/event/joint-review')).status, 'public status of a paused event').toBe(404);
      const site = await s.apiOk('GET', '/public/site');
      s.expect(site.eventTypes.map((e) => e.slug).includes('joint-review'), 'paused event on the public page').toBe(false);
      // And back on.
      await clearToasts(page);
      await page.getByRole('switch', { name: 'Joint review: accept bookings' }).click();
      await expectToast(page, 'Joint review is taking bookings');
      s.expect((await s.api('GET', '/public/event/joint-review')).status, 'public status once it is back on').toBe(200);
      await clearToasts(page);
    });

    await s.step('delete: refused while there is an upcoming booking, with the reason shown', async () => {
      s.allowConsoleErrors(/status of 409/);
      const [start] = await s.slots({ slug: 'intro', duration: 15, from: '2026-11-17T00:00:00.000Z' });
      s.expect((await s.book({ slug: 'intro', start })).status, 'booking status').toBe(201);
      await page.getByRole('button', { name: 'More actions for Intro call' }).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete "Intro call"?' });
      await dialog.getByRole('button', { name: 'Delete event type' }).click();
      const toast = await expectToast(page, 'Could not delete it');
      s.expect(await toast.textContent(), 'the reason in the toast').toContain('"Intro call" still has 1 upcoming booking. Switch it off instead');
      // The dialog stays, nothing was removed.
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      s.expect(await storedEvent(s, 'intro'), 'the event type is still there').toMatchObject({ slug: 'intro' });
      await page.getByRole('link', { name: 'Intro call', exact: true }).waitFor();
      await clearToasts(page);
    });

    await s.step('delete: an event type without bookings goes, from the list and from the editor', async () => {
      await page.getByRole('button', { name: 'More actions for Copy of Meeting' }).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await page.getByRole('dialog', { name: 'Delete "Copy of Meeting"?' }).getByRole('button', { name: 'Delete event type' }).click();
      await expectToast(page, 'Deleted "Copy of Meeting"');
      await page.getByRole('link', { name: 'Copy of Meeting', exact: true }).waitFor({ state: 'detached' });
      s.expect(await storedEvent(s, 'meeting-copy'), 'the copy in the store').toBeNull();
      s.expect((await s.api('GET', '/public/event/meeting-copy')).status, 'public status of a deleted event').toBe(404);
      await clearToasts(page);

      await page.getByRole('link', { name: 'Made elsewhere', exact: true }).click();
      await openTab(page, 'Advanced');
      await page.getByRole('button', { name: 'Delete this event type' }).click();
      await page.getByRole('dialog', { name: 'Delete "Made elsewhere"?' }).getByRole('button', { name: 'Delete event type' }).click();
      await expectToast(page, 'Deleted "Made elsewhere"');
      await page.getByRole('heading', { name: 'Event types', level: 1 }).waitFor();
      s.expect(await storedEvent(s, 'taken-link'), 'the event deleted from its editor').toBeNull();
      s.expect((await s.kv('event-types')).map((e) => e.title).sort(), 'event types left').toEqual(['Intro call', 'Joint review', 'Meeting', 'Quick help', 'Strategy session']);
    });
  });
  await t.scenario('availability: weekly hours, date overrides and a second schedule decide what the public page offers', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'UTC' });
    const page = await s.newPage({ signedIn: true });
    const visitor = await s.newPage({ timezoneId: 'UTC' });
    const owner = async () => (await s.kv('hosts'))[0];
    /** What the public page of an event offers on a day, as wall times in UTC. */
    const offered = async (slug, day) => {
      await openBookingPage(s, visitor, slug);
      return (await offeredTimes(visitor, day)).map((iso) => wallTime(iso, 'UTC'));
    };
    const saveHours = async () => {
      await saveBar(page).getByRole('button', { name: 'Save hours' }).click();
      await expectToast(page, 'Availability saved');
      await saveBar(page).waitFor({ state: 'hidden' });
      await clearToasts(page);
    };

    await s.step('the starter hours: Monday to Friday, 9 to 5', async () => {
      await page.goto(s.url('/admin/availability'));
      await page.getByRole('heading', { name: 'Availability', level: 1 }).waitFor();
      s.expect(await offered('intro', '2026-11-17'), 'Tuesday before any change').toEqual(timeRange('09:00', '17:00', 15));
      s.expect((await openDays(visitor)).slice(0, 5), 'first days on offer').toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
    });

    const TUESDAY = [
      { start: '09:00', end: '11:00' },
      { start: '14:00', end: '16:00' },
      { start: '17:00', end: '18:00' },
    ];

    await s.step('weekly hours: three ranges on Tuesday, copied to Thursday, Wednesday off', async () => {
      const week = page.getByRole('region', { name: 'Weekly hours' }).getByRole('group', { name: 'Weekly hours' });
      await week.getByRole('button', { name: 'Add a time range on Tuesday' }).click();
      await week.getByRole('combobox', { name: 'Tuesday, range 1, end' }).selectOption('11:00');
      await week.getByRole('combobox', { name: 'Tuesday, range 2, start' }).selectOption('14:00');
      await week.getByRole('combobox', { name: 'Tuesday, range 2, end' }).selectOption('16:00');
      await week.getByRole('button', { name: 'Add a time range on Tuesday' }).click();
      s.expect(await week.getByRole('combobox', { name: 'Tuesday, range 3, start' }).inputValue(), 'the third range starts an hour after the second').toBe('17:00');
      // Overlapping ranges are refused before they can be saved.
      await week.getByRole('combobox', { name: 'Tuesday, range 3, start' }).selectOption('15:00');
      await week.getByRole('alert').filter({ hasText: 'These times overlap.' }).waitFor();
      await saveBar(page).getByText('Working hours, Tuesday: These times overlap.').waitFor();
      s.expect(await saveBar(page).getByRole('button', { name: 'Save hours' }).isDisabled(), 'save is blocked while ranges overlap').toBe(true);
      await week.getByRole('combobox', { name: 'Tuesday, range 3, start' }).selectOption('17:00');
      await week.getByRole('alert').waitFor({ state: 'detached' });

      await week.getByRole('button', { name: "Copy Tuesday's hours to other days" }).click();
      const copy = page.getByRole('dialog', { name: "Copy Tuesday's hours to other days" });
      await copy.getByRole('checkbox', { name: 'Thursday' }).check();
      await copy.getByRole('button', { name: 'Copy to 1 day' }).click();
      await week.getByRole('combobox', { name: 'Thursday, range 3, start' }).waitFor();
      await week.getByRole('switch', { name: 'Wednesday' }).click();
      await saveHours();

      const schedule = (await owner()).schedules[0];
      s.expect(schedule.weekly[2], 'stored Tuesday').toEqual(TUESDAY);
      s.expect(schedule.weekly[4], 'stored Thursday').toEqual(TUESDAY);
      s.expect(schedule.weekly[3], 'stored Wednesday').toEqual([]);
      s.expect(schedule.weekly[1], 'stored Monday').toEqual([{ start: '09:00', end: '17:00' }]);
    });

    const tuesdayTimes = [...timeRange('09:00', '11:00', 15), ...timeRange('14:00', '16:00', 15), ...timeRange('17:00', '18:00', 15)];

    await s.step('the public page offers exactly those times', async () => {
      s.expect(await offered('intro', '2026-11-17'), 'Tuesday').toEqual(tuesdayTimes);
      s.expect(await offered('intro', '2026-11-19'), 'Thursday').toEqual(tuesdayTimes);
      s.expect(await offered('intro', '2026-11-18'), 'Wednesday').toEqual([]);
      s.expect(await offered('intro', '2026-11-20'), 'Friday').toEqual(timeRange('09:00', '17:00', 15));
      // The API says the same as the page.
      const api = (await s.slots({ slug: 'intro', duration: 15, from: '2026-11-17T00:00:00.000Z', to: '2026-11-18T00:00:00.000Z' })).map((iso) => wallTime(iso, 'UTC'));
      s.expect(api, 'Tuesday from the API').toEqual(tuesdayTimes);
      // A reload of the dashboard shows the saved hours.
      await page.reload();
      const week = page.getByRole('region', { name: 'Weekly hours' }).getByRole('group', { name: 'Weekly hours' });
      s.expect(await week.getByRole('combobox', { name: 'Tuesday, range 2, start' }).inputValue(), 'Tuesday range 2 after a reload').toBe('14:00');
      s.expect(await week.getByRole('switch', { name: 'Wednesday' }).getAttribute('aria-checked'), 'Wednesday after a reload').toBe('false');
    });

    await s.step('date overrides: Thursday off, special hours on Friday and Saturday', async () => {
      const overrides = page.getByRole('region', { name: 'Date overrides' });
      await overrides.getByRole('button', { name: 'Add a date override' }).click();
      let dialog = page.getByRole('dialog', { name: 'Add a date override' });
      await dialog.locator('button[data-key="2026-11-19"]').click();
      s.expect(await dialog.getByRole('radio', { name: 'Unavailable' }).getAttribute('aria-checked'), 'a new override starts as a day off').toBe('true');
      await dialog.getByRole('button', { name: 'Apply to 1 date' }).click();
      await overrides.getByText('Unavailable').waitFor();

      await overrides.getByRole('button', { name: 'Add a date override' }).click();
      dialog = page.getByRole('dialog', { name: 'Add a date override' });
      await dialog.locator('button[data-key="2026-11-20"]').click();
      await dialog.locator('button[data-key="2026-11-21"]').click();
      await dialog.getByRole('radio', { name: 'Custom hours' }).click();
      await dialog.getByRole('combobox', { name: 'Override, range 1, end' }).selectOption('12:00');
      await dialog.getByRole('combobox', { name: 'Override, range 1, start' }).selectOption('10:00');
      await dialog.getByRole('button', { name: 'Add a time range' }).click();
      s.expect(await dialog.getByRole('combobox', { name: 'Override, range 2, start' }).inputValue(), 'second override range').toBe('13:00');
      await dialog.getByRole('button', { name: 'Apply to 2 dates' }).click();
      await overrides.getByText('10:00 AM to 12:00 PM, 1:00 PM to 2:00 PM').waitFor();
      s.expect(await overrides.getByRole('listitem').count(), 'override lines').toBe(2);
      await s.screenshot(page, 'availability with overrides');
      await saveHours();

      const special = [
        { start: '10:00', end: '12:00' },
        { start: '13:00', end: '14:00' },
      ];
      s.expect((await owner()).schedules[0].overrides, 'stored overrides').toEqual([
        { date: '2026-11-19', ranges: [] },
        { date: '2026-11-20', ranges: special },
        { date: '2026-11-21', ranges: special },
      ]);
    });

    const specialTimes = [...timeRange('10:00', '12:00', 15), ...timeRange('13:00', '14:00', 15)];

    await s.step('the public page follows the overrides, and only on those dates', async () => {
      s.expect(await offered('intro', '2026-11-19'), 'Thursday the 19th, a day off').toEqual([]);
      s.expect(await offered('intro', '2026-11-20'), 'Friday the 20th').toEqual(specialTimes);
      s.expect(await offered('intro', '2026-11-21'), 'Saturday the 21st, normally closed').toEqual(specialTimes);
      s.expect(await offered('intro', '2026-11-26'), 'the Thursday after').toEqual(tuesdayTimes);
      s.expect(await offered('intro', '2026-11-27'), 'the Friday after').toEqual(timeRange('09:00', '17:00', 15));
      s.expect(await offered('intro', '2026-11-28'), 'the Saturday after').toEqual([]);
    });

    let eveningsId = '';
    await s.step('a second schedule, "Evenings", for the weekdays', async () => {
      await page.getByRole('button', { name: 'New schedule' }).click();
      await page.getByRole('textbox', { name: 'Schedule name' }).fill('Evenings');
      const week = page.getByRole('region', { name: 'Weekly hours' }).getByRole('group', { name: 'Weekly hours' });
      await week.getByRole('combobox', { name: 'Monday, range 1, end' }).selectOption('20:00');
      await week.getByRole('combobox', { name: 'Monday, range 1, start' }).selectOption('18:00');
      await week.getByRole('button', { name: "Copy Monday's hours to other days" }).click();
      const copy = page.getByRole('dialog', { name: "Copy Monday's hours to other days" });
      await copy.getByRole('button', { name: 'Weekdays' }).click();
      await copy.getByRole('button', { name: 'Copy to 4 days' }).click();
      await week.getByRole('combobox', { name: 'Friday, range 1, start' }).and(page.locator(':has(option[value="18:00"]:checked)')).waitFor();
      await saveHours();
      const stored = await owner();
      s.expect(stored.schedules.map((x) => x.name), 'stored schedules').toEqual(['Working hours', 'Evenings']);
      s.expect(stored.defaultScheduleId, 'the default schedule is still the first').toBe(stored.schedules[0].id);
      eveningsId = stored.schedules[1].id;
      for (const day of [1, 2, 3, 4, 5]) s.expect(stored.schedules[1].weekly[day], `Evenings, weekday ${day}`).toEqual([{ start: '18:00', end: '20:00' }]);
      await page.getByRole('tablist', { name: 'Schedules' }).getByRole('tab', { name: /Evenings/, selected: true }).waitFor();
      // Nothing changes for visitors yet: no event type uses it.
      s.expect(await offered('intro', '2026-11-17'), 'Tuesday on the intro call').toEqual(tuesdayTimes);
    });

    await s.step('assign it to "Meeting": that event offers evenings, the other one does not', async () => {
      await openPage(page, 'Event types');
      await page.getByRole('link', { name: 'Meeting', exact: true }).click();
      const panel = await openTab(page, 'Scheduling');
      await panel.getByLabel('Schedule', { exact: true }).selectOption({ label: 'Evenings' });
      await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
      await expectToast(page, 'Saved');
      s.expect((await storedEvent(s, 'meeting')).scheduling.scheduleIds, 'schedule chosen for the event').toEqual({ host_owner: eveningsId });
      s.expect(await offered('meeting', '2026-11-17'), 'Tuesday on "Meeting"').toEqual(['18:00', '18:30', '19:00', '19:30']);
      // The overrides belong to "Working hours": Thursday the 19th is open in the evening.
      s.expect(await offered('meeting', '2026-11-19'), 'Thursday the 19th on "Meeting"').toEqual(['18:00', '18:30', '19:00', '19:30']);
      s.expect(await offered('meeting', '2026-11-21'), 'Saturday the 21st on "Meeting"').toEqual([]);
      s.expect(await offered('intro', '2026-11-17'), 'Tuesday on the intro call').toEqual(tuesdayTimes);
      await page.reload();
      s.expect(await (await openTab(page, 'Scheduling')).getByLabel('Schedule', { exact: true }).inputValue(), 'schedule select after a reload').toBe(eveningsId);
    });

    await s.step('delete the second schedule: the event goes back to the default hours', async () => {
      await openPage(page, 'Availability');
      await page.getByRole('tablist', { name: 'Schedules' }).getByRole('tab', { name: /Evenings/ }).click();
      await page.getByRole('button', { name: 'More schedule actions' }).click();
      await page.getByRole('menuitem', { name: 'Delete schedule' }).click();
      await page.getByRole('dialog', { name: 'Delete "Evenings"?' }).getByRole('button', { name: 'Delete schedule' }).click();
      await saveHours();
      s.expect((await owner()).schedules.map((x) => x.name), 'stored schedules').toEqual(['Working hours']);
      // 30 minute meetings on a 30 minute grid, inside Tuesday's three ranges.
      s.expect(await offered('meeting', '2026-11-17'), 'Tuesday on "Meeting" after the schedule is gone').toEqual([...timeRange('09:00', '11:00', 30), ...timeRange('14:00', '16:00', 30), ...timeRange('17:00', '18:00', 30)]);
      await openPage(page, 'Event types');
      await page.getByRole('link', { name: 'Meeting', exact: true }).click();
      s.expect(await (await openTab(page, 'Scheduling')).getByLabel('Schedule', { exact: true }).inputValue(), 'schedule select once the schedule is gone').toBe('');
    });
  });
});
