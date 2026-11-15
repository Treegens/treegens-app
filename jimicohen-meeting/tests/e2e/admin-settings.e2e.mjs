/**
 * Settings, bookings and sharing, driven through the dashboard in a real browser against the
 * real backend. Every setting is followed to the place where it matters: the landing page, the
 * booking form, the next email, the next reminder call.
 *
 * The server runs with EMBED_BASE_URL pointing at the same app under another origin
 * (127.0.0.1 instead of localhost), the way the Netlify address relates to jimicohen.com.
 */
import fs from 'node:fs';
import { defineSuite } from './lib.mjs';
import { MONDAY, clearToasts, expectFieldProblem, expectToast, openBookingPage, offeredTimes, openPage, pngFile, saveBar } from './admin-helpers.mjs';

const section = (page, title) => page.locator('section.adm-section').filter({ has: page.getByRole('heading', { name: title, level: 2, exact: true }) });
const tue = (time) => `2026-11-17T${time}:00.000Z`;
const MOBILE = '+14155552671';

/** A CSV file as rows of cells (quotes and line breaks inside cells handled). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export default defineSuite('admin-settings', { mockCreds: true, env: { EMBED_BASE_URL: 'http://127.0.0.1:{port}/meeting' } }, async (t) => {
  await t.scenario('settings: profile, assistant, booking form and email identity reach the places they are for', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'UTC' });
    // Email goes out through (mock) Resend from this address. The Integrations suite covers setting it in the browser.
    await s.apiOk('PUT', '/admin/site', { body: { email: { fromEmail: 'meetings@example.com' } } });
    const { voiceOptions } = await s.apiOk('GET', '/admin/bootstrap');
    const voice = voiceOptions.find((v) => v.id === 'Polly.Amy-Neural');
    const page = await s.newPage({ signedIn: true, viewport: { width: 1440, height: 900 } });
    const site = async () => s.kv('site');
    const save = async () => {
      await saveBar(page).getByRole('button', { name: 'Save settings' }).click();
      await expectToast(page, 'Settings saved');
      await saveBar(page).waitFor({ state: 'hidden' });
      await clearToasts(page);
    };
    let avatarId = '';

    await s.step('profile: photo, headline, welcome and links', async () => {
      await page.goto(s.url('/admin/settings'));
      await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
      const profile = section(page, 'Profile');
      const uploaded = page.waitForResponse((r) => r.url().endsWith('/api/admin/assets') && r.request().method() === 'POST');
      await profile.locator('input[type="file"]').setInputFiles(pngFile('me.png', 96, 96, [40, 120, 90]));
      avatarId = (await (await uploaded).json()).id;
      await profile.getByRole('button', { name: 'Change photo' }).waitFor();
      await profile.getByLabel('Name').fill('Jimi A. Cohen');
      await profile.getByLabel('Headline').fill('Time with Jimi, made simple');
      await profile.getByLabel('Welcome message').fill('Pick whatever suits you. I read every note before we talk.');
      await profile.getByRole('button', { name: 'Add a link' }).click();
      await profile.getByRole('textbox', { name: 'Link 1, label' }).fill('Website');
      await profile.getByRole('textbox', { name: 'Link 1, address' }).fill('jimicohen.com');
      await profile.getByRole('textbox', { name: 'Link 1, address' }).blur();
      // People rarely type the scheme: it is added for them.
      s.expect(await profile.getByRole('textbox', { name: 'Link 1, address' }).inputValue(), 'address after leaving the box').toBe('https://jimicohen.com');
      await profile.getByRole('button', { name: 'Add a link' }).click();
      await profile.getByRole('textbox', { name: 'Link 2, label' }).fill('LinkedIn');
      await profile.getByRole('textbox', { name: 'Link 2, address' }).fill('https://www.linkedin.com/in/jimicohen');

      // A link without an address cannot be saved, and the bar says which one.
      await profile.getByRole('button', { name: 'Add a link' }).click();
      await profile.getByRole('textbox', { name: 'Link 3, label' }).fill('Blog');
      await profile.getByRole('textbox', { name: 'Link 3, address' }).fill('ht!tp:/nope');
      await saveBar(page).getByText('The link "Blog" needs a full address that starts with https://').waitFor();
      s.expect(await saveBar(page).getByRole('button', { name: 'Save settings' }).isDisabled(), 'save with a broken link').toBe(true);
      await profile.getByRole('button', { name: 'Remove link 3' }).click();
      await save();

      s.expect((await site()).profile, 'stored profile').toEqual({
        name: 'Jimi A. Cohen',
        headline: 'Time with Jimi, made simple',
        welcome: 'Pick whatever suits you. I read every note before we talk.',
        avatarAssetId: avatarId,
        links: [
          { label: 'Website', url: 'https://jimicohen.com' },
          { label: 'LinkedIn', url: 'https://www.linkedin.com/in/jimicohen' },
        ],
      });
      // The owner as a host (event pages, emails, calls) is the person on the profile: photo and name follow.
      s.expect((await s.kv('hosts'))[0], 'the owner as a host').toMatchObject({ avatarAssetId: avatarId, name: 'Jimi A. Cohen' });
      await page.getByRole('complementary', { name: 'Dashboard' }).getByRole('button', { name: /Jimi A\. Cohen/ }).waitFor();
    });

    await s.step('the landing page shows the profile', async () => {
      const visitor = await s.newPage({ timezoneId: 'UTC' });
      await visitor.goto(s.url('/'));
      await visitor.getByRole('heading', { name: 'Time with Jimi, made simple', level: 1 }).waitFor();
      await visitor.getByText('Pick whatever suits you. I read every note before we talk.').waitFor();
      const photo = visitor.locator('.pl__avatar img');
      s.expect(await photo.getAttribute('src'), 'photo address').toBe(`/meeting/api/assets/${avatarId}`);
      s.expect(await photo.evaluate((img) => img.complete && img.naturalWidth), 'photo loaded').toBe(96);
      const links = visitor.locator('ul.pl__links a');
      s.expect(await links.evaluateAll((nodes) => nodes.map((a) => [a.textContent.trim(), a.getAttribute('href')])), 'links on the landing page').toEqual([
        ['Website', 'https://jimicohen.com'],
        ['LinkedIn', 'https://www.linkedin.com/in/jimicohen'],
      ]);
      // And the event page shows the same photo next to the host's name.
      await openBookingPage(s, visitor, 'intro');
      s.expect(await visitor.locator('.bw-summary img').first().getAttribute('src'), 'host photo on the event page').toBe(`/meeting/api/assets/${avatarId}`);
      await visitor.locator('.bw-summary').getByText('Jimi A. Cohen').first().waitFor();
      await s.screenshot(visitor, 'landing page with the profile');
      await visitor.context().close();
    });

    await s.step('assistant: name, language, voice, personality and calling hours', async () => {
      const assistant = section(page, 'AI assistant');
      await assistant.getByLabel('Name').fill('Nia');
      await assistant.getByLabel('Language').selectOption({ label: 'English (United Kingdom)' });
      await assistant.getByRole('combobox', { name: 'Voice' }).selectOption(voice.id);
      await assistant.getByLabel('Personality').fill('Warm, brief and a little dry.');
      await assistant.getByRole('combobox', { name: 'Earliest call' }).selectOption('10');
      await assistant.getByRole('combobox', { name: 'Latest call' }).selectOption('18');
      // The example line follows the name at once.
      await assistant.getByText('Hi Sam, this is Nia, an AI assistant calling for Jimi.').waitFor();
      // Hours that end before they start cannot be saved.
      await assistant.getByRole('combobox', { name: 'Latest call' }).selectOption('9');
      await saveBar(page).getByText('Calls must start before they end.').waitFor();
      await assistant.getByRole('combobox', { name: 'Latest call' }).selectOption('18');
      await save();
      s.expect((await site()).assistant, 'stored assistant').toMatchObject({ name: 'Nia', language: 'en-GB', voice: voice.id, persona: 'Warm, brief and a little dry.', callWindowStartHour: 10, callWindowEndHour: 18 });
    });

    await s.step('booking form: reminders off by default, own consent wording, a privacy link', async () => {
      const form = section(page, 'Booking form');
      const optIn = form.getByRole('switch', { name: 'Start with reminders switched on' });
      s.expect(await optIn.getAttribute('aria-checked'), 'reminders start switched on, out of the box').toBe('true');
      await optIn.click();
      await form.getByLabel('Consent wording').fill('By adding your number you agree that {{host_first_name}} may text or call you about this meeting.');
      await form.getByLabel('Privacy policy link').fill('example.com/privacy');
      await form.getByLabel('Privacy policy link').blur();
      s.expect(await form.getByLabel('Privacy policy link').inputValue(), 'privacy link after leaving the box').toBe('https://example.com/privacy');
      await save();
      s.expect((await site()).booking, 'stored booking defaults').toEqual({
        reminderOptInDefault: false,
        consentText: 'By adding your number you agree that {{host_first_name}} may text or call you about this meeting.',
        privacyUrl: 'https://example.com/privacy',
      });
    });

    await s.step('Home asks where booking notices should go, and its link opens that field', async () => {
      await page.goto(s.url('/admin'));
      const warning = page.locator('.adm-home__warnings .adm-notice').filter({ hasText: 'You have not said where your booking notices should go' });
      await warning.getByRole('link', { name: 'Fix this' }).click();
      await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
      s.expect(new URL(page.url()).hash, 'where the link lands').toBe('#notices');
      const notices = section(page, 'Email identity').getByLabel('Send my booking notices to');
      await s.eventually(async () => s.expect(await notices.evaluate((el) => el === document.activeElement), 'the notice address has the focus').toBe(true));
    });

    await s.step('email identity: sender name and where replies go', async () => {
      const identity = section(page, 'Email identity');
      await identity.getByLabel('Sender name').fill('Jimi at Treegens');
      await identity.getByLabel('Replies go to').fill('hello-at-jimicohen');
      await saveBar(page).getByText('The reply-to address is not a full email address.').waitFor();
      await identity.getByLabel('Replies go to').fill('hello@jimicohen.com');
      // Where the owner's own notices go. Nothing is connected in this scenario, so it starts empty.
      const notices = identity.getByLabel('Send my booking notices to');
      s.expect(await notices.inputValue(), 'notice address before anything is set').toBe('');
      await identity.getByText('Without an address you are not emailed about new bookings.').waitFor();
      await notices.fill('jimi-at-home');
      await saveBar(page).getByText('The address for your booking notices is not a full email address.').waitFor();
      // An address a co-host already uses is refused by the server, and nothing at all is saved.
      s.allowConsoleErrors(/status of 422/);
      await s.apiOk('POST', '/admin/hosts', { body: { name: 'Sam Okafor', email: 'sam@example.com' } });
      await notices.fill('SAM@example.com');
      await saveBar(page).getByRole('button', { name: 'Save settings' }).click();
      const refused = await expectToast(page, 'Your settings were not saved');
      s.expect(await refused.textContent(), 'why it was refused').toContain('Someone with this email is already on the team.');
      await saveBar(page).getByText('Someone with this email is already on the team.').waitFor();
      s.expect((await s.kv('hosts'))[0].email, "the owner's address after the refusal").toBe('');
      s.expect((await site()).email.fromName, 'the sender name after the refusal').not.toBe('Jimi at Treegens');
      await clearToasts(page);
      await notices.fill('jimi@jimicohen.com');
      // Texts about bookings, right next to it: they need a mobile number.
      const textMe = identity.getByRole('switch', { name: 'Text me about bookings' });
      s.expect(await textMe.getAttribute('aria-checked'), 'texts to the owner, out of the box').toBe('false');
      await identity.getByText('New, moved and cancelled bookings, and any reminder texts you set up for the host.').waitFor();
      await textMe.click();
      await saveBar(page).getByText('Add your mobile number to get texts about bookings, or switch the texts off.').waitFor();
      await identity.getByLabel('Your mobile number').fill('+1 (415) 555-2680');
      await save();
      s.expect((await site()).email, 'stored email identity').toMatchObject({ fromName: 'Jimi at Treegens', replyTo: 'hello@jimicohen.com', fromEmail: 'meetings@example.com' });
      s.expect((await s.kv('hosts'))[0], "the owner's own details").toMatchObject({ email: 'jimi@jimicohen.com', phone: '+14155552680', notify: { email: true, sms: true } });
      // A reload shows everything that was saved.
      await page.reload();
      await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
      s.expect(await section(page, 'AI assistant').getByLabel('Name').inputValue(), 'assistant name after a reload').toBe('Nia');
      s.expect(await section(page, 'AI assistant').getByRole('combobox', { name: 'Voice' }).inputValue(), 'voice after a reload').toBe(voice.id);
      s.expect(await section(page, 'Email identity').getByLabel('Sender name').inputValue(), 'sender name after a reload').toBe('Jimi at Treegens');
      s.expect(await section(page, 'Email identity').getByLabel('Send my booking notices to').inputValue(), 'notice address after a reload').toBe('jimi@jimicohen.com');
      s.expect(await section(page, 'Email identity').getByLabel('Your mobile number').inputValue(), 'mobile number after a reload').toBe('+14155552680');
      s.expect(await section(page, 'Email identity').getByRole('switch', { name: 'Text me about bookings' }).getAttribute('aria-checked'), 'texts after a reload').toBe('true');
      s.expect(await section(page, 'Profile').getByRole('textbox', { name: 'Link 2, label' }).inputValue(), 'second link after a reload').toBe('LinkedIn');
      s.expect(await saveBar(page).count(), 'save bar after a reload').toBe(0);
      await s.screenshot(page, 'settings after saving');
    });

    await s.step('the public form shows the reminder defaults, the consent wording and the privacy link', async () => {
      const visitor = await s.newPage({ timezoneId: 'America/New_York' });
      await openBookingPage(s, visitor, 'intro');
      await offeredTimes(visitor, '2026-11-17');
      await visitor.locator('button.bw-slot').first().click();
      const form = visitor.getByRole('form', { name: 'Your details' });
      await form.getByLabel('Phone').fill(MOBILE);
      const texts = form.getByRole('switch', { name: 'Text me the confirmation and reminders' });
      const calls = form.getByRole('switch', { name: "Reminder call from Nia, Jimi's AI assistant" });
      await texts.waitFor();
      s.expect(await texts.getAttribute('aria-checked'), 'text reminders start off').toBe('false');
      s.expect(await calls.getAttribute('aria-checked'), 'reminder calls start off').toBe('false');
      s.expect(await form.locator('.bw-reminders__consent').count(), 'consent wording before anything is switched on').toBe(0);
      await calls.click();
      s.expect(await form.locator('.bw-reminders__consent').textContent(), 'consent wording').toBe('By adding your number you agree that Jimi may text or call you about this meeting.');
      s.expect(await visitor.locator('a[href="https://example.com/privacy"]').count(), 'privacy links on the page').toBeGreaterThan(0);
      await s.screenshot(visitor, 'booking form with the consent wording');
      await visitor.context().close();
    });

    await s.step('the next confirmation email uses the sender name and the reply-to address', async () => {
      // 16:00 UTC is 5 PM in Berlin: the reminder call two hours before falls inside Nia's hours there.
      const berlin = await s.book({ slug: 'intro', start: tue('16:00'), name: 'Lise Meitner', email: 'lise@example.com', timezone: 'Europe/Berlin', phone: '+4915112345678', consent: { sms: true, call: true } });
      s.expect(berlin.status, 'booking status').toBe(201);
      // 15:00 UTC is 10 AM in New York: two hours before is 8 AM there, before Nia may call, and 10 AM
      // leaves no time that morning, so the call goes out the evening before.
      const newYork = await s.book({ slug: 'intro', start: tue('15:00'), name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'America/New_York', phone: MOBILE, consent: { sms: true, call: true } });
      s.expect(newYork.status, 'booking status').toBe(201);
      await s.settle();
      const [confirmation] = await s.outbox({ kind: 'email', to: 'lise@example.com' });
      s.expect(confirmation, 'the confirmation email').toMatchObject({ service: 'resend', ok: true, fromEmail: 'meetings@example.com', replyTo: 'hello@jimicohen.com' });
      s.expect(confirmation.from, 'the From line').toBe('Jimi at Treegens <meetings@example.com>');
      s.expect(confirmation.text, 'the host is named as on the profile').toContain('Jimi A. Cohen');
      // The owner hears about it at the address they chose, and a reply goes to the invitee.
      const [notice] = await s.outbox({ kind: 'email', to: 'jimi@jimicohen.com', subject: /Lise Meitner/ });
      s.expect(notice, 'the notice to the owner').toMatchObject({ ok: true, replyTo: 'lise@example.com' });
      // What the invitee agreed to is kept with the booking, in the words they saw.
      const [stored] = await s.bookings({ invitee: { email: 'lise@example.com' } });
      s.expect(stored.consent, 'consent kept with the booking').toMatchObject({ sms: true, call: true, text: 'By adding your number you agree that Jimi may text or call you about this meeting.' });
    });

    await s.step('a reminder call that would come before the calling hours rings in the last calling hour the day before', async () => {
      const [ada] = await s.bookings({ invitee: { email: 'ada@example.com' } });
      // Nia may call from 10 AM to 6 PM: 5 PM on Monday in New York is 22:00 UTC.
      await s.setClock('2026-11-16T21:59:00.000Z');
      await s.runJobs();
      s.expect(await s.calls(), 'calls placed before 5 PM New York time').toEqual([]);
      await s.setClock('2026-11-16T22:00:00.000Z');
      await s.runJobs();
      s.expect((await s.calls()).map((c) => c.to), 'calls placed at 5 PM New York time the day before').toEqual([MOBILE]);
      s.expect((await s.bookings({ id: ada.id }))[0].timeline.some((entry) => entry.type === 'reminder_call_sent'), 'the timeline says the call went out').toBe(true);
    });

    await s.step('a reminder call inside them uses the assistant name, voice and language', async () => {
      await s.setClock(tue('14:00'));
      await s.runJobs();
      const calls = (await s.calls()).filter((c) => c.to !== MOBILE);
      s.expect(calls.map((c) => c.to), 'calls placed at 3 PM Berlin time').toEqual(['+4915112345678']);
      const spoken = await s.voice(calls[0], 'start');
      s.expect(spoken.status, 'status of the voice webhook').toBe(200);
      s.expect(spoken.xml, 'voice in the TwiML').toContain(`voice="${voice.id}"`);
      s.expect(spoken.xml, 'language in the TwiML').toContain('language="en-GB"');
      s.expect(spoken.said, 'what is said first').toMatch(/^Hi Lise, this is Nia, an AI assistant calling for Jimi\./);
      // The personality goes to the model with the next turn.
      await s.voice(calls[0], 'turn', { SpeechResult: 'Yes, I will be there.' });
      const [asked] = await s.outbox({ kind: 'llm' });
      s.expect(asked.system, 'instructions for the model').toContain('Warm, brief and a little dry.');
      s.expect(asked.system, 'instructions for the model').toContain('Nia');
    });
  });

  await t.scenario('bookings: tabs, counts, search, the drawer, cancel, no-show, the reschedule link, CSV, and Home', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'UTC' });
    await s.apiOk('PUT', '/admin/site', { body: { email: { fromEmail: 'meetings@example.com' } } });
    s.allowConsoleErrors(/status of 409/);

    const made = {};
    await s.step('five bookings come in through the public API', async () => {
      const book = async (key, body) => {
        const res = await s.book(body);
        s.expect(res.status, `status of the booking for ${body.name}`).toBe(201);
        made[key] = { id: res.data.booking.id, token: res.data.manageToken };
      };
      const ada = { slug: 'intro', start: tue('10:00'), name: 'Ada Lovelace', email: 'ada@example.com', timezone: 'America/New_York', phone: MOBILE, consent: { sms: true, call: true }, answers: { q_topic: 'Planting trees together.' } };
      // No calendar is connected here, so Google would invite nobody: a guest Ada brings would never hear of it.
      const withGuest = await s.book({ ...ada, guests: ['grace@example.com'] });
      s.expect([withGuest.status, withGuest.data.error.fields], 'a guest without a calendar to invite them').toEqual([422, { guests: 'Guests cannot be added to this meeting.' }]);
      await book('ada', ada);
      await book('alan', { slug: 'intro', start: tue('11:00'), name: 'Alan Turing', email: 'alan@example.com', timezone: 'Europe/London' });
      await book('katherine', { slug: 'meeting', start: '2026-11-18T13:00:00.000Z', durationMin: 30, name: 'Katherine Johnson', email: 'katherine@example.com', timezone: 'America/Chicago' });
      await book('mary', { slug: 'intro', start: '2026-11-16T14:00:00.000Z', name: 'Mary Jackson', email: 'mary@example.com', timezone: 'UTC' });
      await book('dorothy', { slug: 'intro', start: tue('15:00'), name: 'Dorothy Vaughan', email: 'dorothy@example.com', timezone: 'UTC' });
      // Dorothy cancels herself, and Mary's meeting goes by.
      const cancelled = await s.visitor().request('POST', `/public/bookings/${made.dorothy.id}/cancel`, { body: { t: made.dorothy.token, reason: 'Travelling that day.' } });
      s.expect(cancelled.status, 'status of the invitee cancelling').toBe(200);
      await s.settle();
      await s.setClock('2026-11-16T16:00:00.000Z');
      await s.clearOutbox();
    });

    const page = await s.newPage({ signedIn: true, viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const tab = (name) => page.getByRole('tablist', { name: 'Bookings' }).getByRole('tab', { name: new RegExp(`^${name}`) });
    const counts = async () => Object.fromEntries(await Promise.all(['Upcoming', 'Past', 'Cancelled'].map(async (name) => [name, (await tab(name).textContent()).replace(name, '').trim()])));
    const names = () => page.locator('.adm-agenda__who > span:first-child').allTextContents();
    const drawer = page.getByRole('dialog').filter({ has: page.locator('.adm-bk__body') });

    await s.step('the list: three tabs with their counts, grouped by day, in my time zone', async () => {
      await page.goto(s.url('/admin/bookings'));
      await page.getByRole('heading', { name: 'Bookings', level: 1 }).waitFor();
      await page.getByText('Times are in Coordinated Universal Time (UTC).').waitFor();
      await page.getByRole('link', { name: /Ada Lovelace/ }).waitFor();
      s.expect(await counts(), 'tab counts').toEqual({ Upcoming: '3', Past: '1', Cancelled: '1' });
      s.expect(await names(), 'upcoming, soonest first').toEqual(['Ada Lovelace', 'Alan Turing', 'Katherine Johnson']);
      s.expect(await page.locator('.adm-agenda__date').allTextContents(), 'day headings').toEqual(['Tomorrow, Tue, Nov 17', 'Wed, Nov 18']);
      s.expect(await page.locator('.adm-agenda__start').allTextContents(), 'start times').toEqual(['10:00 AM', '11:00 AM', '1:00 PM']);
      await s.screenshot(page, 'bookings list');

      await tab('Past').click();
      await page.getByRole('link', { name: /Mary Jackson/ }).waitFor();
      s.expect(await names(), 'past').toEqual(['Mary Jackson']);
      s.expect(new URL(page.url()).searchParams.get('scope'), 'the tab is in the address').toBe('past');
      await tab('Cancelled').click();
      await page.getByRole('link', { name: /Dorothy Vaughan/ }).waitFor();
      s.expect(await names(), 'cancelled').toEqual(['Dorothy Vaughan']);
      await tab('Upcoming').click();
      await page.getByRole('link', { name: /Ada Lovelace/ }).waitFor();
    });

    await s.step('search by name, email and event, with the counts left honest', async () => {
      const search = page.getByRole('searchbox', { name: 'Search bookings' });
      await search.fill('alan');
      await s.eventually(async () => s.expect(await names(), 'search for "alan"').toEqual(['Alan Turing']));
      s.expect(new URL(page.url()).searchParams.get('q'), 'the search is in the address').toBe('alan');
      // The badges count the tabs, not the search.
      s.expect(await counts(), 'tab counts while searching').toEqual({ Upcoming: '3', Past: '1', Cancelled: '1' });
      await search.fill('katherine@example.com');
      await s.eventually(async () => s.expect(await names(), 'search by email').toEqual(['Katherine Johnson']));
      await search.fill('intro');
      await s.eventually(async () => s.expect(await names(), 'search by event').toEqual(['Ada Lovelace', 'Alan Turing']));
      await search.fill('nobody at all');
      await page.getByRole('heading', { name: 'Nothing matches "nobody at all"' }).waitFor();
      await page.getByRole('button', { name: 'Clear search' }).last().click();
      await s.eventually(async () => s.expect(await names(), 'after clearing').toEqual(['Ada Lovelace', 'Alan Turing', 'Katherine Johnson']));
      // A reload with a search in the address shows the same list.
      await page.goto(s.url('/admin/bookings?scope=cancelled&q=dorothy'));
      await page.getByRole('link', { name: /Dorothy Vaughan/ }).waitFor();
      s.expect(await page.getByRole('searchbox', { name: 'Search bookings' }).inputValue(), 'search box after a reload').toBe('dorothy');
      s.expect(await tab('Cancelled').getAttribute('aria-selected'), 'selected tab after a reload').toBe('true');
      await page.goto(s.url('/admin/bookings'));
      await page.getByRole('link', { name: /Ada Lovelace/ }).waitFor();
    });

    let adaBooking = null;
    await s.step('the drawer: who, when for both sides, where, answers, the timeline and the manage link', async () => {
      await page.getByRole('link', { name: /Ada Lovelace/ }).click();
      await drawer.getByRole('heading', { name: 'Ada Lovelace' }).waitFor();
      await drawer.getByText('Intro call').first().waitFor();
      await drawer.getByText('Upcoming', { exact: true }).waitFor();
      await drawer.getByText('Tuesday, November 17, 2026').waitFor();
      await drawer.getByText('10:00 – 10:15 AM').waitFor();
      // Ada is in New York, where the same meeting starts at 5 AM.
      await drawer.getByText(/5:00 AM on Tue, Nov 17 for Ada, who is in Eastern/).waitFor();
      await drawer.getByText('Google Meet').waitFor();
      await drawer.getByRole('link', { name: 'ada@example.com' }).waitFor();
      await drawer.getByRole('link', { name: MOBILE }).waitFor();
      await drawer.getByText('Agreed to texts and reminder calls').waitFor();
      s.expect(await drawer.getByText('grace@example.com').count(), 'guests (none could be added without a calendar)').toBe(0);
      const answers = drawer.getByRole('region', { name: 'Answers' });
      await answers.getByText('What would you like to talk about?').waitFor();
      await answers.getByText('Planting trees together.').waitFor();
      const timeline = drawer.getByRole('region', { name: 'Timeline' });
      s.expect(await timeline.getByRole('listitem').count(), 'timeline entries').toBeGreaterThanOrEqual(2);
      s.expect((await timeline.textContent()).toLowerCase(), 'the timeline').toMatch(/booked/);
      s.expect((await timeline.textContent()).toLowerCase(), 'the timeline').toMatch(/confirmation/);
      // Services by the names people know, never the ids stored with each entry.
      s.expect(await timeline.textContent(), 'provider names in the timeline').not.toMatch(/via (mock|resend|gmail|twilio)\b/);
      s.expect(await timeline.textContent(), 'provider names in the timeline').toMatch(/via (the test outbox|Resend|Gmail)/);
      s.expect(new URL(page.url()).searchParams.get('b'), 'the open booking is in the address').toBe(made.ada.id);
      [adaBooking] = await s.bookings({ id: made.ada.id });
      await s.screenshot(page, 'booking drawer', { fullPage: false });
    });

    await s.step('the reschedule link opens the public reschedule page for that booking', async () => {
      const link = drawer.getByRole('link', { name: 'Reschedule' });
      const href = await link.getAttribute('href');
      // Opened from the dashboard, the page knows a host is acting.
      s.expect(href, 'reschedule link').toBe(`${s.url(`/booking/${made.ada.id}/reschedule`)}?t=${made.ada.token}&as=host`);
      s.expect(await link.getAttribute('target'), 'opens in a new tab').toBe('_blank');
      const manage = drawer.getByRole('region', { name: 'Manage link' });
      // "Open" carries the host mark too; "Copy" hands out the plain link, which is the one for the invitee.
      s.expect(await manage.locator('input, a').evaluateAll((nodes) => nodes.map((n) => n.value || n.getAttribute('href')).filter(Boolean)), 'the manage link shown').toContain(`${adaBooking.manageUrl}&as=host`);
      const [opened] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
      await opened.waitForLoadState();
      s.expect(opened.url(), 'address of the new tab').toBe(href);
      await opened.getByRole('heading', { level: 1 }).first().waitFor();
      await opened.getByText('Intro call').first().waitFor();
      await opened.locator('table.bw-cal__grid').waitFor();
      await opened.close();
    });

    await s.step('cancel with a reason: the invitee is told, the calendar is cleared, the tabs follow', async () => {
      await drawer.getByRole('button', { name: 'Cancel meeting' }).click();
      const confirm = page.getByRole('dialog', { name: 'Cancel this meeting?' });
      await confirm.getByLabel('Reason').fill('Something came up, sorry. Please pick another time.');
      await confirm.getByRole('button', { name: 'Cancel meeting' }).click();
      await expectToast(page, 'Meeting cancelled');
      await drawer.getByText('Cancelled', { exact: true }).first().waitFor();
      await drawer.getByText(/Cancelled by you on .*: "Something came up, sorry\. Please pick another time\."/).waitFor();
      s.expect(await drawer.getByRole('button', { name: 'Cancel meeting' }).count(), 'cancel button on a cancelled meeting').toBe(0);
      await s.settle();

      const [stored] = await s.bookings({ id: made.ada.id });
      s.expect(stored, 'the stored booking').toMatchObject({ status: 'cancelled', cancellation: { by: 'host', reason: 'Something came up, sorry. Please pick another time.' } });
      const [email] = await s.outbox({ kind: 'email', to: 'ada@example.com' });
      s.expect(email.subject.toLowerCase(), 'subject of the email to the invitee').toMatch(/cancel/);
      s.expect(email.text, 'the email carries the reason').toContain('Something came up, sorry. Please pick another time.');
      s.expect(email.text, 'the email names the meeting').toContain('Intro call');
      s.expect(await s.jobs({ bookingId: made.ada.id, kind: 'reminder' }), 'reminders still queued for the cancelled meeting').toEqual([]);
      await s.screenshotEmail(email, 'cancellation email');

      await page.keyboard.press('Escape');
      await drawer.waitFor({ state: 'hidden' });
      await s.eventually(async () => s.expect(await counts(), 'tab counts after cancelling').toEqual({ Upcoming: '2', Past: '1', Cancelled: '2' }));
      s.expect(await names(), 'upcoming after cancelling').toEqual(['Alan Turing', 'Katherine Johnson']);
      await clearToasts(page);
    });

    await s.step('a cancelled meeting says who cancelled and why', async () => {
      await tab('Cancelled').click();
      await page.getByRole('link', { name: /Dorothy Vaughan/ }).click();
      await drawer.getByRole('heading', { name: 'Dorothy Vaughan' }).waitFor();
      await drawer.getByText(/Cancelled by the invitee on .*: "Travelling that day\."/).waitFor();
      await page.keyboard.press('Escape');
      await drawer.waitFor({ state: 'hidden' });
      s.expect(await names(), 'cancelled, latest first').toEqual(['Dorothy Vaughan', 'Ada Lovelace']);
    });

    await s.step('mark a past meeting as a no-show, and clear it again', async () => {
      await tab('Past').click();
      await page.getByRole('link', { name: /Mary Jackson/ }).click();
      await drawer.getByRole('heading', { name: 'Mary Jackson' }).waitFor();
      await drawer.getByText('Finished', { exact: true }).waitFor();
      await drawer.getByRole('button', { name: 'Mark as a no-show' }).click();
      await expectToast(page, 'Marked as a no-show');
      await drawer.getByText('No-show', { exact: true }).first().waitFor();
      let [stored] = await s.bookings({ id: made.mary.id });
      s.expect(stored.attendance.noShow, 'stored no-show').toBe(true);
      s.expect(stored.timeline.at(-1).type, 'last timeline entry').toBe('marked_no_show');
      await page.getByRole('link', { name: /Mary Jackson/ }).getByText('No-show').waitFor();
      await clearToasts(page);
      await drawer.getByRole('button', { name: 'Clear no-show' }).click();
      await expectToast(page, 'No-show cleared');
      [stored] = await s.bookings({ id: made.mary.id });
      s.expect(stored.attendance.noShow, 'stored no-show after clearing').toBe(false);
      await page.keyboard.press('Escape');
      await drawer.waitFor({ state: 'hidden' });
      // A meeting that has not started cannot be a no-show.
      const early = await s.api('POST', `/admin/bookings/${made.alan.id}/no-show`, { body: { noShow: true } });
      s.expect(early.status, 'no-show on an upcoming meeting').toBe(409);
      await clearToasts(page);
    });

    await s.step('CSV export: the file holds what the tab shows', async () => {
      const download = async () => {
        const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export CSV' }).click()]);
        const text = fs.readFileSync(await file.path(), 'utf8');
        return { name: file.suggestedFilename(), text, rows: parseCsv(text.replace(/^﻿/, '')) };
      };
      await tab('Upcoming').click();
      await page.getByRole('link', { name: /Alan Turing/ }).waitFor();
      const upcoming = await download();
      s.expect(upcoming.name, 'file name').toBe('bookings-upcoming-2026-11-16.csv');
      s.expect(upcoming.text.charCodeAt(0), 'byte order mark, so spreadsheets read accents').toBe(0xfeff);
      const header = upcoming.rows[0];
      s.expect(header.slice(0, 9), 'first columns').toEqual(['Booking ID', 'Status', 'Event', 'Start (UTC)', 'End (UTC)', 'Local start (UTC)', 'Minutes', 'Invitee', 'Email']);
      const col = (row, name) => row[header.indexOf(name)];
      s.expect(upcoming.rows.slice(1).map((row) => [col(row, 'Invitee'), col(row, 'Email'), col(row, 'Event'), col(row, 'Status'), col(row, 'Start (UTC)'), col(row, 'Minutes')]), 'rows of the upcoming export').toEqual([
        ['Alan Turing', 'alan@example.com', 'Intro call', 'confirmed', tue('11:00'), '15'],
        ['Katherine Johnson', 'katherine@example.com', 'Meeting', 'confirmed', '2026-11-18T13:00:00.000Z', '30'],
      ]);

      await tab('Cancelled').click();
      await page.getByRole('link', { name: /Dorothy Vaughan/ }).waitFor();
      const cancelled = await download();
      s.expect(cancelled.name, 'file name').toBe('bookings-cancelled-2026-11-16.csv');
      const ada = cancelled.rows.slice(1).find((row) => col(row, 'Email') === 'ada@example.com');
      s.expect([col(ada, 'Status'), col(ada, 'Cancelled by'), col(ada, 'Cancellation reason'), col(ada, 'Phone'), col(ada, 'Guests'), col(ada, 'Answers')], "Ada's row").toEqual([
        'cancelled',
        'host',
        'Something came up, sorry. Please pick another time.',
        // A cell that starts with "+" would be run as a formula by a spreadsheet, so it is written as text.
        `'${MOBILE}`,
        '',
        'What would you like to talk about?: Planting trees together.',
      ]);
      // With a search, only what matches.
      await page.getByRole('searchbox', { name: 'Search bookings' }).fill('dorothy');
      await s.eventually(async () => s.expect(await names(), 'search for "dorothy"').toEqual(['Dorothy Vaughan']));
      const searched = await download();
      s.expect(searched.rows.slice(1).map((row) => col(row, 'Invitee')), 'rows of the searched export').toEqual(['Dorothy Vaughan']);
      // The manage link can cancel a meeting, so it is never in an export. And an export needs the session.
      s.expect(cancelled.text.includes(made.ada.token) || upcoming.text.includes(made.alan.token), 'a manage token in an export').toBe(false);
      s.expect((await s.visitor().request('GET', '/admin/bookings.csv')).status, 'export without a session').toBe(401);
      const everything = parseCsv((await s.api('GET', '/admin/bookings.csv')).text.replace(/^﻿/, ''));
      s.expect(everything.length - 1, 'rows of the full export').toBe(5);
    });

    await s.step("Home: the numbers, what is coming up, and what needs attention", async () => {
      const overview = await s.apiOk('GET', '/admin/overview');
      s.expect(overview.stats, 'overview numbers').toEqual({ upcomingCount: 2, last30Count: 5, cancelledLast30: 2, confirmedByAssistant: 0 });
      await openPage(page, 'Home', /^Good (morning|afternoon|evening), Jimi$/);
      const stat = async (label) => (await page.locator('dl, .adm-stats').locator(`xpath=.//dt[normalize-space()="${label}"]/following-sibling::dd[1]`).first().textContent()).trim();
      // The heading is there before the numbers are: they come with the overview request.
      await s.eventually(async () => s.expect(await stat('Upcoming'), 'upcoming on Home').toBe('2'));
      s.expect(await stat('Booked'), 'booked on Home').toBe('5');
      s.expect(await stat('Cancelled'), 'cancelled on Home').toBe('2');
      s.expect(await stat('Confirmed by your assistant'), 'confirmed by the assistant on Home').toBe('0');
      const coming = page.getByRole('region', { name: 'Coming up' });
      s.expect(await coming.locator('.adm-agenda__who > span:first-child').allTextContents(), 'coming up').toEqual(['Alan Turing', 'Katherine Johnson']);
      // The calendar is not connected in this scenario, and Home says so with a way to fix it.
      const warning = page.getByRole('note').filter({ hasText: 'Your calendar is not connected yet' });
      s.expect(await warning.getByRole('link', { name: 'Fix this' }).getAttribute('href'), 'where "Fix this" leads').toBe('/meeting/admin/integrations#google');
      // Nor has the owner said where booking notices go, so nobody tells them about these bookings.
      s.expect(overview.warnings.map((w) => w.key), 'warnings').toEqual(['google_not_connected', 'owner_no_email']);
      s.expect(overview.warnings.find((w) => w.key === 'owner_no_email').href, 'where that is fixed').toBe('/admin/settings#notices');
      await s.screenshot(page, 'home with bookings');
      // A meeting on Home opens its details on the bookings page.
      await coming.getByRole('link', { name: /Alan Turing/ }).click();
      await page.getByRole('dialog').getByRole('heading', { name: 'Alan Turing' }).waitFor();
      s.expect(new URL(page.url()).pathname, 'where the meeting opens').toBe('/meeting/admin/bookings');
    });

    await s.step('when the invitee confirms they are coming, the booking and the list say so', async () => {
      await s.apiOk('POST', `/public/bookings/${made.alan.id}/confirm`, { body: { t: made.alan.token } });
      await page.reload();
      const open = page.getByRole('dialog').filter({ has: page.locator('.adm-bk__body') });
      await open.getByText('Confirmed', { exact: true }).waitFor();
      // An upcoming meeting cannot be deleted: it is cancelled first.
      s.expect(await open.getByRole('button', { name: 'Delete booking' }).count(), 'delete button on an upcoming meeting').toBe(0);
      await page.keyboard.press('Escape');
      await page.getByRole('link', { name: /Alan Turing/ }).getByText('Confirmed').waitFor();
    });

    await s.step('a cancelled booking is deleted for good, only after asking, and nothing of it is left', async () => {
      await clearToasts(page);
      await tab('Cancelled').click();
      await page.getByRole('link', { name: /Dorothy Vaughan/ }).click();
      await drawer.getByRole('heading', { name: 'Dorothy Vaughan' }).waitFor();
      await drawer.getByRole('button', { name: 'Delete booking' }).click();
      const confirm = page.getByRole('dialog', { name: 'Delete this booking for good?' });
      await confirm.getByText(/This cannot be undone\./).waitFor();
      await s.screenshot(page, 'delete a booking, confirm', { fullPage: false });
      // "Keep it" changes nothing.
      await confirm.getByRole('button', { name: 'Keep it' }).click();
      await confirm.waitFor({ state: 'hidden' });
      s.expect(await s.bookings({ id: made.dorothy.id }), 'still stored after "Keep it"').toHaveLength(1);

      await drawer.getByRole('button', { name: 'Delete booking' }).click();
      await confirm.getByRole('button', { name: 'Delete booking' }).click();
      await expectToast(page, 'Booking deleted');
      await drawer.waitFor({ state: 'hidden' });
      s.expect(new URL(page.url()).searchParams.get('b'), 'the address no longer names it').toBeNull();
      s.expect(await s.bookings({ id: made.dorothy.id }), 'stored after deleting').toEqual([]);
      s.expect(await s.jobs({ bookingId: made.dorothy.id }), 'jobs left for it').toEqual([]);
      s.expect(JSON.stringify(await s.kv('index/bookings')), 'the booking index').not.toContain(made.dorothy.id);
      await s.eventually(async () => s.expect(await counts(), 'tab counts after deleting').toEqual({ Upcoming: '2', Past: '1', Cancelled: '1' }));
      s.expect(await names(), 'cancelled after deleting').toEqual(['Ada Lovelace']);
      // The server refuses an upcoming meeting as well, and says what to do instead.
      const refused = await s.api('DELETE', `/admin/bookings/${made.alan.id}`);
      s.expect(refused.status, 'deleting an upcoming meeting').toBe(409);
      s.expect(refused.data.error.message, 'what the server says').toBe('This meeting has not happened yet. Cancel it first, then you can delete it.');
      s.expect(await s.bookings({ id: made.alan.id }), 'the upcoming meeting is still there').toHaveLength(1);
    });
  });

  await t.scenario('a cancelled meeting whose Google event could not be removed: tried again, then deleted after a second question', { reset: true }, async (s) => {
    const OWNER_GOOGLE = 'jimi@example.com';
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'UTC' });
    s.allowConsoleErrors(/status of 409/);
    const page = await s.newPage({ signedIn: true, viewport: { width: 1440, height: 900 } });
    const google = await s.connectGoogle(page, OWNER_GOOGLE, 'UTC', { start: { hostId: 'host_owner' } });
    s.expect(google.result.status, 'Google connected').toBe('connected');
    const drawer = page.getByRole('dialog').filter({ has: page.locator('.adm-bk__body') });
    const second = page.getByRole('dialog', { name: 'The calendar event could not be removed' });
    const made = {};
    const eventNamed = async (eventId) => (await s.googleEvents(OWNER_GOOGLE)).find((e) => e.event.id === eventId);

    await s.step('two meetings are booked, then cancelled while Google refuses to remove their events', async () => {
      for (const [key, name, start] of [
        ['ada', 'Ada Lovelace', tue('10:00')],
        ['alan', 'Alan Turing', tue('11:00')],
      ]) {
        const res = await s.book({ slug: 'intro', start, name, email: `${key}@example.com`, timezone: 'UTC' });
        s.expect(res.status, `status of the booking for ${name}`).toBe(201);
        made[key] = res.data.booking.id;
      }
      await s.settle();
      made.adaEvent = (await s.bookings({ id: made.ada }))[0].google.eventId;
      made.alanEvent = (await s.bookings({ id: made.alan }))[0].google.eventId;
      await s.failService('google-events-delete');
      for (const id of [made.ada, made.alan]) await s.apiOk('POST', `/admin/bookings/${id}/cancel`, { body: {} });
      await s.settle();
      for (const id of [made.ada, made.alan]) {
        const [stored] = await s.bookings({ id });
        s.expect(stored.status, 'status after cancelling').toBe('cancelled');
        s.expect(stored.google.error, 'what Google said').toMatch(/Google request failed/);
        s.expect((await eventNamed(stored.google.eventId)).event.status, 'the event, still on the calendar').toBe('confirmed');
      }
    });

    await s.step('Google still refuses: the owner is told the event stays, and Cancel keeps the booking', async () => {
      await page.goto(s.url(`/admin/bookings?scope=cancelled&b=${made.ada}`));
      await drawer.getByRole('heading', { name: 'Ada Lovelace' }).waitFor();
      await drawer.getByText(/Still on Google Calendar: Google request failed/).waitFor();
      await drawer.getByRole('button', { name: 'Delete booking' }).click();
      const first = page.getByRole('dialog', { name: 'Delete this booking for good?' });
      const tried = (await s.outbox({ kind: 'calendar_delete' })).length;
      await first.getByRole('button', { name: 'Delete booking' }).click();
      await second.getByText('The event is still on your Google Calendar and will stay there. Remove it by hand. Delete the booking anyway?').waitFor();
      await first.waitFor({ state: 'hidden' });
      // It was tried again before asking.
      s.expect((await s.outbox({ kind: 'calendar_delete' })).length, 'calendar deletes tried by the delete').toBeGreaterThan(tried);
      await s.screenshot(page, 'delete a booking, the calendar event stays', { fullPage: false });
      await second.getByRole('button', { name: 'Cancel' }).click();
      await second.waitFor({ state: 'hidden' });
      s.expect(await s.bookings({ id: made.ada }), 'still stored after Cancel').toHaveLength(1);
    });

    await s.step('"Delete anyway" deletes it, and the event is left on the calendar', async () => {
      await clearToasts(page);
      await drawer.getByRole('button', { name: 'Delete booking' }).click();
      await page.getByRole('dialog', { name: 'Delete this booking for good?' }).getByRole('button', { name: 'Delete booking' }).click();
      await second.getByRole('button', { name: 'Delete anyway' }).click();
      await expectToast(page, 'Booking deleted');
      await drawer.waitFor({ state: 'hidden' });
      s.expect(await s.bookings({ id: made.ada }), 'stored after deleting').toEqual([]);
      s.expect(await s.jobs({ bookingId: made.ada }), 'jobs left for it, the calendar retry included').toEqual([]);
      s.expect(JSON.stringify(await s.kv('index/bookings')), 'the booking index').not.toContain(made.ada);
      s.expect((await eventNamed(made.adaEvent)).event.status, 'the event, left as the owner was told').toBe('confirmed');
    });

    await s.step('while the removal of a cancelled meeting\'s event is still on its way, the drawer says "Being removed", not "Removed"', async () => {
      // The server's own answer, with its flag for a removal that has not happened yet (unit-tested on the server).
      const detail = `**/api/admin/bookings/${made.alan}`;
      await page.route(detail, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.booking.google = { ...body.booking.google, error: undefined };
        body.booking.calendarRemoving = true;
        await route.fulfill({ response, json: body });
      });
      await page.goto(s.url(`/admin/bookings?scope=cancelled&b=${made.alan}`));
      await drawer.getByRole('heading', { name: 'Alan Turing' }).waitFor();
      const calendar = drawer.locator('.adm-bk__facts div').filter({ has: page.locator('dt', { hasText: 'Calendar' }) }).locator('dd');
      await calendar.getByText('Being removed', { exact: true }).waitFor();
      s.expect(await calendar.getByText('Removed', { exact: true }).count(), '"Removed" while it is still on its way').toBe(0);
      await page.unroute(detail);
      // Without the flag the real state shows again: Google still refuses.
      await page.goto(s.url(`/admin/bookings?scope=cancelled&b=${made.alan}`));
      await drawer.getByText(/Still on Google Calendar: Google request failed/).waitFor();
    });

    await s.step('once Google works again, a delete takes the event off first and asks nothing more', async () => {
      await s.clearFailures();
      await clearToasts(page);
      await page.goto(s.url(`/admin/bookings?scope=cancelled&b=${made.alan}`));
      await drawer.getByRole('heading', { name: 'Alan Turing' }).waitFor();
      await drawer.getByRole('button', { name: 'Delete booking' }).click();
      await page.getByRole('dialog', { name: 'Delete this booking for good?' }).getByRole('button', { name: 'Delete booking' }).click();
      await expectToast(page, 'Booking deleted');
      s.expect(await second.count(), 'the second question').toBe(0);
      s.expect(await s.bookings({ id: made.alan }), 'stored after deleting').toEqual([]);
      s.expect((await eventNamed(made.alanEvent)).event.status, 'the event, taken off').toBe('cancelled');
      const [gone] = (await s.outbox({ kind: 'calendar_delete', status: 204 })).filter((e) => e.eventId === made.alanEvent);
      s.expect(gone, 'the delete Google was sent').toMatchObject({ account: OWNER_GOOGLE, sendUpdates: 'all' });
    });
  });

  await t.scenario('a long list of bookings is paged, and the counts stay right', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'UTC' });
    await s.step('forty-five people book the intro call', async () => {
      const starts = await s.slots({ slug: 'intro', duration: 15, from: '2026-11-17T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' });
      for (let i = 0; i < 45; i++) {
        const res = await s.book({ slug: 'intro', start: starts[i * 2], name: `Guest ${String(i + 1).padStart(2, '0')}`, email: `guest${i + 1}@example.com`, timezone: 'UTC' });
        s.expect(res.status, `status of booking ${i + 1}`).toBe(201);
      }
      await s.settle();
    });
    const page = await s.newPage({ signedIn: true, viewport: { width: 1440, height: 900 } });
    await s.step('the first forty are shown, "Show more" brings the rest, in order', async () => {
      await page.goto(s.url('/admin/bookings'));
      const names = () => page.locator('.adm-agenda__who > span:first-child').allTextContents();
      await page.getByRole('link', { name: /Guest 01/ }).waitFor();
      s.expect((await names()).length, 'rows on the first page').toBe(40);
      s.expect((await page.getByRole('tablist', { name: 'Bookings' }).getByRole('tab', { name: /^Upcoming/ }).textContent()).replace('Upcoming', '').trim(), 'upcoming count').toBe('45');
      await page.getByText('40 of 45').waitFor();
      await page.getByRole('button', { name: 'Show more' }).click();
      await page.getByRole('link', { name: /Guest 45/ }).waitFor();
      const all = await names();
      s.expect(all.length, 'rows after "Show more"').toBe(45);
      s.expect(all, 'soonest first, nobody twice').toEqual(Array.from({ length: 45 }, (_, i) => `Guest ${String(i + 1).padStart(2, '0')}`));
      s.expect(await page.getByRole('button', { name: 'Show more' }).count(), '"Show more" once everything is shown').toBe(0);
      // A search runs over all of them, not only the rows on screen.
      await page.getByRole('searchbox', { name: 'Search bookings' }).fill('guest45@example.com');
      await s.eventually(async () => s.expect(await names(), 'search result').toEqual(['Guest 45']));
      // Home shows the next eight and the true total.
      const overview = await s.apiOk('GET', '/admin/overview');
      s.expect(overview.stats.upcomingCount, 'upcoming on Home').toBe(45);
      s.expect(overview.upcoming.length, 'meetings listed on Home').toBe(8);
    });
  });

  await t.scenario('share and embed: the link is the public one, both snippets load from the embed address, copy works', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'UTC' });
    const page = await s.newPage({ signedIn: true, viewport: { width: 1440, height: 900 } });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    const publicBase = s.server.base;
    const embedBase = `http://127.0.0.1:${s.server.port}/meeting`;

    await s.step('the dashboard knows both addresses', async () => {
      const boot = await s.apiOk('GET', '/admin/bootstrap');
      s.expect(boot.publicUrl, 'public address').toBe(publicBase);
      s.expect(boot.embedBaseUrl, 'embed address').toBe(embedBase);
    });

    await s.step('Home: the booking page link and each event link can be copied', async () => {
      await page.goto(s.url('/admin'));
      const share = page.getByRole('region', { name: 'Your booking page' });
      await share.getByRole('button', { name: 'Copy', exact: true }).click();
      await s.eventually(async () => s.expect(await clipboard(), 'clipboard after copying the page link').toBe(publicBase));
      await share.getByRole('button', { name: 'Copy the link to Meeting' }).click();
      await s.eventually(async () => s.expect(await clipboard(), 'clipboard after copying an event link').toBe(`${publicBase}/meeting`));
    });

    const dialog = page.getByRole('dialog', { name: 'Share Intro call' });
    await s.step('the Share panel: the link people get is the public one', async () => {
      await openPage(page, 'Event types');
      // The quick copy button on the row.
      await page.locator('ul.adm-events > li').filter({ hasText: 'Intro call' }).getByRole('button', { name: 'Copy link' }).click();
      await s.eventually(async () => s.expect(await clipboard(), 'clipboard after the row button').toBe(`${publicBase}/intro`));
      await page.getByRole('button', { name: 'More actions for Intro call' }).click();
      await page.getByRole('menuitem', { name: 'Share and embed' }).click();
      await dialog.getByRole('tab', { name: 'Link', selected: true }).waitFor();
      const link = dialog.locator('a.sp__url');
      s.expect(await link.getAttribute('href'), 'the link').toBe(`${publicBase}/intro`);
      s.expect((await link.textContent()).trim(), 'the link as shown').toBe(`localhost:${s.server.port}/meeting/intro`);
      await page.evaluate(() => navigator.clipboard.writeText(''));
      await dialog.getByRole('button', { name: 'Copy link' }).click();
      await s.eventually(async () => s.expect(await clipboard(), 'clipboard after "Copy link"').toBe(`${publicBase}/intro`));
      await s.screenshot(page, 'share panel, link', { fullPage: false });
    });

    await s.step('"On a web page": the snippet frames the page from the embed address and loads embed.js from there', async () => {
      await dialog.getByRole('tab', { name: 'On a web page' }).click();
      const expected = `<div data-meeting-url="${embedBase}/intro"><a href="${publicBase}/intro" data-meeting-fallback>Book a meeting</a></div>\n<script src="${embedBase}/embed.js" async></script>`;
      const code = dialog.getByLabel('Embed code for "Intro call"');
      s.expect(await code.textContent(), 'inline snippet').toBe(expected);
      // The main site (here localhost, in real life jimicohen.com) does not let the embed in: the panel says so.
      s.expect(await dialog.getByRole('note').textContent(), 'note about the main site').toBe(
        `Not for pages on localhost:${s.server.port} itself: that site does not allow embedded calendars, so the code shows only a plain link there. Use the link from the Link tab on those pages.`,
      );
      await dialog.getByRole('button', { name: 'Copy code' }).click();
      await s.eventually(async () => s.expect(await clipboard(), 'clipboard after "Copy code"').toBe(expected));
      await s.screenshot(page, 'share panel, inline snippet', { fullPage: false });
      // Both addresses in the snippet really answer, and may be framed there.
      const script = await fetch(`${embedBase}/embed.js`);
      s.expect(script.status, 'status of embed.js at the embed address').toBe(200);
      s.expect(script.headers.get('content-type'), 'type of embed.js').toMatch(/javascript/);
      s.expect(await script.text(), 'embed.js').toContain('data-meeting-url');
      const framed = await fetch(`${embedBase}/intro`);
      s.expect(framed.status, 'status of the framed page').toBe(200);
      s.expect(framed.headers.get('x-frame-options'), 'X-Frame-Options on a public page of the app itself').toBeNull();
    });

    await s.step('"Popup button": the link falls back to the public page, the popup opens the embed address', async () => {
      await dialog.getByRole('tab', { name: 'Popup button' }).click();
      const snippet = (text) => `<a href="${publicBase}/intro" data-meeting-popup="${embedBase}/intro">${text}</a>\n<script src="${embedBase}/embed.js" async></script>`;
      const code = dialog.getByLabel('Popup button code for "Intro call"');
      s.expect(await code.textContent(), 'popup snippet').toBe(snippet('Book a meeting'));
      s.expect(await dialog.getByRole('note').textContent(), 'note about the main site').toContain(`Not for pages on localhost:${s.server.port} itself`);
      // The words on the button are the owner's, and anything typed there is escaped.
      await dialog.getByLabel('Text on the button').fill('Talk to <Jimi> & co');
      s.expect(await code.textContent(), 'popup snippet with other words').toBe(snippet('Talk to &lt;Jimi&gt; &amp; co'));
      await dialog.getByRole('button', { name: 'Copy code' }).click();
      await s.eventually(async () => s.expect(await clipboard(), 'clipboard after "Copy code"').toBe(snippet('Talk to &lt;Jimi&gt; &amp; co')));
      await dialog.getByRole('button', { name: 'Close' }).click();
      await dialog.waitFor({ state: 'hidden' });
    });

    await s.step('the editor of an event has the same copy button', async () => {
      await page.getByRole('link', { name: 'Meeting', exact: true }).click();
      await page.getByRole('heading', { name: 'Meeting', level: 1 }).waitFor();
      await page.getByRole('button', { name: 'Copy link' }).click();
      await s.eventually(async () => s.expect(await clipboard(), 'clipboard after copying from the editor').toBe(`${publicBase}/meeting`));
      s.expect(await page.getByRole('link', { name: 'Open page' }).getAttribute('href'), '"Open page" link').toBe(`${publicBase}/meeting`);
    });
  });
});
