/**
 * Brands and short links in the dashboard (DESIGN 8.2, admin-brands): the one-time setup on data like the live
 * site, joint meetings made before the update, "Your links" on Home, the Short links card, the Look section of
 * the event editor, the Eco Champions look in Design, and the /pod meeting offered when a co-host is added.
 *
 * The setup only runs when a test asks for it (POST /dev/one-time-moves), as the scheduled function does once
 * after a deploy.
 */
import { defineSuite } from './lib.mjs';
import { clearToasts, expectToast, openPage, pngFile, saveBar } from './admin-helpers.mjs';
import { PHONE_VIEWPORT, calendarReady, createEventType, prepare } from './public-helpers.mjs';

const ECO = 'brand_eco_champions';
const POD = 'evt_eco_champions';
const NY = 'America/New_York';
const TUESDAY = '2026-11-17';
/** Jimi's profile on the live site, word for word. */
const LIVE_PROFILE = {
  name: 'Jimi Cohen',
  headline: 'Book time with Jimi',
  welcome: 'Host of the Eco Champions podcast and Founder of Treegens. Pick a meeting type below and choose a time that works.',
};

const eventsById = async (s) => Object.fromEntries((await s.kv('event-types')).map((e) => [e.id, e]));

async function cssVar(page, name) {
  return page.evaluate((n) => getComputedStyle(document.querySelector('.m-scope') ?? document.documentElement).getPropertyValue(n).trim().toLowerCase(), name);
}

/** A site like the live one: set up, Google connected, Jimi's profile, mail to Jimi readable. */
async function liveLike(s) {
  const page = await prepare(s);
  await s.apiOk('PUT', '/admin/hosts/host_owner', { body: { email: 'jimi@example.com' } });
  await s.apiOk('PUT', '/admin/site', { body: { profile: LIVE_PROFILE } });
  return page;
}

async function addIan(s, addToEventTypeIds) {
  const added = await s.apiOk('POST', '/admin/hosts', { body: { name: 'Ian Poirier', email: 'ian@example.com', ...(addToEventTypeIds ? { addToEventTypeIds } : {}) } });
  return added.host;
}

/** One row of a list of links ("Your links" on Home, "Short links" on Event types), found by its address. */
function linkRow(region, label) {
  return region.locator('li.ab-links__item').filter({ hasText: label }).first();
}

export default defineSuite('admin-brands', { mockCreds: true }, async (t) => {
  await t.scenario('the one-time setup on data like the live site, and a second run changes nothing', async (s) => {
    const page = await liveLike(s);
    const ian = await addIan(s);
    const siteBefore = await s.kv('site');
    const home = page.getByRole('region', { name: 'Your links' });

    await s.step('before the setup, Home says the short links are being set up', async () => {
      await page.goto(s.url('/admin'));
      await home.getByText('Your short links are being set up. This takes up to two minutes after an update.').waitFor();
      s.expect(await home.getByText('localhost', { exact: false }).count(), 'the main link is still there').toBeGreaterThan(0);
    });

    await s.step('the setup: "Meeting" becomes "Meet with Jimi" for /meet, and a new unlisted joint meeting for /pod', async () => {
      const moved = await s.runOneTimeMoves();
      s.expect(moved, 'what the setup did').toMatchObject({ meet: { eventTypeId: 'evt_meeting', renamed: true }, pod: { eventTypeId: POD, created: true } });
      const events = await eventsById(s);
      s.expect(events.evt_meeting, 'the /meet meeting').toMatchObject({ title: 'Meet with Jimi', slug: 'meeting', hostIds: ['host_owner'] });
      s.expect(events.evt_meeting.brandId ?? null, 'no brand on /meet').toBe(null);
      s.expect(events[POD], 'the /pod meeting').toMatchObject({
        title: 'Eco Champions conversation',
        visibility: 'unlisted',
        kind: 'collective',
        hostIds: ['host_owner', ian.id],
        brandId: ECO,
        durations: [30, 60],
        defaultDuration: 30,
      });
      const site = await s.kv('site');
      s.expect(site.shortLinks, 'the links').toEqual({ meet: 'evt_meeting', pod: POD });
      s.expect(site.profile, 'the profile, untouched').toEqual(siteBefore.profile);
      s.expect(site.theme, 'the forest look, untouched').toEqual(siteBefore.theme);
      s.expect(site.email, 'the email settings, untouched').toEqual(siteBefore.email);
    });

    await s.step('the dashboard shows both links, and each opens its meeting', async () => {
      await page.reload();
      await linkRow(home, `localhost:${s.server.port}/meet`).getByText('Meet with Jimi. Just you.').waitFor();
      await linkRow(home, `localhost:${s.server.port}/pod`).getByText('Eco Champions conversation. You and Ian, in the Eco Champions look.').waitFor();
      s.expect(await linkRow(home, `localhost:${s.server.port}/pod`).locator('.ab-chip').textContent(), 'the brand chip').toBe('Eco Champions');
      s.expect((await s.visitor().ok('GET', '/public/short/meet')).eventType?.id, '/meet opens').toBe('evt_meeting');
      s.expect((await s.visitor().ok('GET', '/public/short/pod')).eventType?.id, '/pod opens').toBe(POD);
      await s.screenshot(page, 'home after the setup', { fullPage: false });
    });

    await s.step('a second run changes nothing', async () => {
      const before = { events: await s.kv('event-types'), site: await s.kv('site') };
      const again = await s.runOneTimeMoves();
      s.expect(again, 'the second run').toBe('already_done');
      s.expect(await s.kv('event-types'), 'events').toEqual(before.events);
      s.expect(await s.kv('site'), 'site').toEqual(before.site);
    });
  });

  await t.scenario('joint meetings made before the update: one is offered for /pod, one that says Eco Champions is taken over', async (s) => {
    let page = await liveLike(s);
    let ian = await addIan(s);
    let earlier;
    let joint;
    await s.step('"Meet Jimi and Ian", made and booked before the update, is not taken over', async () => {
      joint = await createEventType(s, { title: 'Meet Jimi and Ian', slug: 'jimi-and-ian', kind: 'collective', hostIds: ['host_owner', ian.id], durations: [30], defaultDuration: 30 });
      const res = await s.book({ slug: 'jimi-and-ian', start: `${TUESDAY}T10:00:00.000Z`, durationMin: 30, name: 'Ann Lee', email: 'ann@example.com' });
      s.expect(res.status, 'the earlier booking').toBe(201);
      earlier = (await s.bookings((b) => b.invitee.email === 'ann@example.com'))[0];
      const moved = await s.runOneTimeMoves();
      s.expect(moved.pod, 'a new meeting for /pod').toMatchObject({ eventTypeId: POD, created: true });
      const events = await eventsById(s);
      s.expect(events[joint.id].brandId ?? null, 'the joint meeting keeps its look').toBe(null);
      s.expect(events[POD].hostIds, 'the new one has both').toEqual(['host_owner', ian.id]);
    });

    await s.step('Home offers it for /pod; "Use it" moves /pod and brands it, and its earlier booking keeps Jimi\'s look', async () => {
      await page.goto(s.url('/admin'));
      const offer = page.getByRole('group', { name: 'Another meeting for the pod link' });
      await offer.getByText(`You also have "Meet Jimi and Ian", a joint meeting with Ian. Use it for localhost:${s.server.port}/pod instead?`).waitFor();
      await offer.scrollIntoViewIfNeeded();
      await s.screenshot(page, 'home offers a joint meeting for pod', { fullPage: false });
      await offer.getByRole('button', { name: 'Use Meet Jimi and Ian' }).click();
      const dialog = page.getByRole('dialog', { name: `Use "Meet Jimi and Ian" for localhost:${s.server.port}/pod?` });
      await dialog.getByText('People who already booked it keep the look they booked in.', { exact: false }).waitFor();
      await dialog.getByRole('button', { name: 'Use it' }).click();
      await expectToast(page, `localhost:${s.server.port}/pod now opens "Meet Jimi and Ian"`);
      s.expect((await s.kv('site')).shortLinks.pod, '/pod').toBe(joint.id);
      s.expect((await eventsById(s))[joint.id].brandId, 'now in Eco Champions').toBe(ECO);
      s.expect(await offer.count(), 'the offer is gone').toBe(0);
      const visitor = await s.newPage({ timezoneId: NY });
      await visitor.goto(s.shortUrl('pod'));
      await visitor.getByRole('heading', { name: 'Meet Jimi and Ian', level: 1 }).waitFor();
      s.expect(await visitor.locator('.bw-summary__logo').getAttribute('src'), 'the logo').toBe('/meeting/brand/eco-champions/logo.svg');
      const view = await s.visitor().ok('GET', `/public/bookings/${earlier.id}`, { query: { t: earlier.manageToken } });
      s.expect(view.site.brand ?? null, 'the earlier booking keeps Jimi\'s look').toBe(null);
      s.expect(view.site.profile.name, 'and his name').toBe('Jimi Cohen');
    });

    await s.step('Bookings shows the look each meeting was booked in: the new one Eco Champions, the earlier one not', async () => {
      const res = await s.book({ slug: 'jimi-and-ian', start: `${TUESDAY}T11:00:00.000Z`, durationMin: 30, name: 'Bea Cole', email: 'bea@example.com' });
      s.expect(res.status, 'a booking made after the brand').toBe(201);
      await page.goto(s.url('/admin/bookings'));
      const bea = page.locator('a.adm-agenda__row').filter({ hasText: 'Bea Cole' });
      const ann = page.locator('a.adm-agenda__row').filter({ hasText: 'Ann Lee' });
      await bea.getByText('Eco Champions', { exact: true }).waitFor();
      await ann.waitFor();
      s.expect(await ann.getByText('Eco Champions', { exact: true }).count(), 'the earlier booking').toBe(0);
      await s.screenshot(page, 'bookings with the brand chip', { fullPage: false });
      await bea.click();
      const drawer = page.getByRole('dialog', { name: 'Bea Cole' });
      await drawer.getByText('Eco Champions', { exact: true }).first().waitFor();
      await s.screenshot(page, 'booking drawer with the brand chip', { fullPage: false });
    });

    await s.step('on another site, "Eco Champions call" made first is taken over for /pod', async () => {
      page = await liveLike(s);
      ian = await addIan(s);
      const call = await createEventType(s, { title: 'Eco Champions call', slug: 'eco-call', kind: 'collective', hostIds: ['host_owner', ian.id], durations: [30], defaultDuration: 30 });
      const moved = await s.runOneTimeMoves();
      s.expect(moved.pod, 'taken over').toMatchObject({ eventTypeId: call.id });
      const events = await eventsById(s);
      s.expect(events[call.id].brandId, 'branded').toBe(ECO);
      s.expect(events[POD], 'nothing new made').toBe(undefined);
    });
  });

  await t.scenario('Home and Event types: Your links with copy buttons, the Short links card, and the chips', async (s) => {
    const page = await liveLike(s);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    await s.runOneTimeMoves();
    const home = page.getByRole('region', { name: 'Your links' });
    const pod = `localhost:${s.server.port}/pod`;
    const meet = `localhost:${s.server.port}/meet`;

    await s.step('"Your links": what each opens, "Only you for now" while the pod meeting is solo, and the copy buttons', async () => {
      await page.goto(s.url('/admin'));
      await linkRow(home, meet).getByText('Meet with Jimi. Just you.').waitFor();
      await linkRow(home, pod).getByText('Eco Champions conversation. Just you, in the Eco Champions look.').waitFor();
      await linkRow(home, pod).getByText('Only you for now. Add your co-host on the Team page and it will only offer times when you are all free.').waitFor();
      await linkRow(home, meet).getByRole('button', { name: 'Copy', exact: true }).click();
      await s.eventually(async () => s.expect(await clipboard(), 'after copying /meet').toBe(s.shortUrl('meet')));
      await linkRow(home, pod).getByRole('button', { name: 'Copy', exact: true }).click();
      await s.eventually(async () => s.expect(await clipboard(), 'after copying /pod').toBe(s.shortUrl('pod')));
      s.expect(await linkRow(home, pod).getByRole('link', { name: `Open ${pod}` }).getAttribute('href'), 'Open').toBe(s.shortUrl('pod'));
      await home.scrollIntoViewIfNeeded();
      await s.screenshot(page, 'home your links 1280', { fullPage: false });
      const phone = await s.newPage({ signedIn: true, ...PHONE_VIEWPORT });
      await phone.goto(s.url('/admin'));
      await linkRow(phone.getByRole('region', { name: 'Your links' }), pod).getByText('Only you for now', { exact: false }).waitFor();
      await linkRow(phone.getByRole('region', { name: 'Your links' }), pod).scrollIntoViewIfNeeded();
      await s.screenshot(phone, 'home your links 390', { fullPage: false });
    });

    await s.step('a co-host who is not on the pod meeting is named, with the way to add them', async () => {
      await addIan(s);
      await page.reload();
      const hint = linkRow(home, pod).locator('.ab-links__hint');
      await hint.getByText('Ian is on your team but not on this meeting.', { exact: false }).waitFor();
      s.expect(await hint.getByRole('link', { name: 'Hosts tab' }).getAttribute('href'), 'to its Hosts tab').toBe(`/meeting/admin/event-types/${POD}?tab=hosts`);
    });

    await s.step('Event types: the chips on the cards', async () => {
      await openPage(page, 'Event types');
      const card = (title) => page.locator('ul.adm-events > li').filter({ hasText: title }).first();
      s.expect(await card('Eco Champions conversation').locator('.ab-chip').allTextContents(), 'the pod card').toEqual(['Eco Champions', pod]);
      s.expect(await card('Meet with Jimi').locator('.ab-chip').allTextContents(), 'the meet card').toEqual([meet]);
      s.expect(await card('Intro call').locator('.ab-chip').count(), 'Intro call has none').toBe(0);
      await s.screenshot(page, 'event types with short links', { fullPage: false });
    });

    await s.step('the Short links card: /pod moves to "Intro call" with the box unticked, so Intro call keeps Jimi\'s look', async () => {
      const card = page.getByRole('region', { name: 'Short links' });
      await card.getByRole('combobox', { name: `What ${pod} opens` }).selectOption({ label: 'Intro call' });
      const dialog = page.getByRole('dialog', { name: `Move ${pod}?` });
      await dialog.getByText('It opens "Eco Champions conversation" now. After the move it opens "Intro call".').waitFor();
      const box = dialog.getByRole('checkbox', { name: /^Use the Eco Champions look for Intro call too\./ });
      s.expect(await box.isChecked(), 'ticked to begin with').toBe(true);
      await box.uncheck();
      await dialog.getByRole('button', { name: 'Move it' }).click();
      await expectToast(page, `${pod} now opens "Intro call"`);
      s.expect((await s.kv('site')).shortLinks.pod, '/pod').toBe('evt_intro');
      s.expect((await eventsById(s)).evt_intro.brandId ?? null, 'Intro call keeps Jimi\'s look').toBe(null);
      await clearToasts(page);
    });

    await s.step('the Short links card: /meet is turned off', async () => {
      const card = page.getByRole('region', { name: 'Short links' });
      await card.getByRole('combobox', { name: `What ${meet} opens` }).selectOption({ label: 'Nothing for now' });
      await page.getByRole('dialog', { name: `Turn off ${meet}?` }).getByRole('button', { name: 'Turn it off' }).click();
      await expectToast(page, `${meet} is turned off`);
      s.expect((await s.kv('site')).shortLinks.meet, '/meet').toBe(null);
    });
  });

  await t.scenario('the editor: Eco Champions on "Intro call", the pod meeting with its link, and a copy of it', async (s) => {
    const page = await liveLike(s);
    await s.runOneTimeMoves();
    const pod = `localhost:${s.server.port}/pod`;

    await s.step('the pod meeting\'s editor names its brand and its short link, at 1280 and 390 px', async () => {
      await page.goto(s.url(`/admin/event-types/${POD}`));
      await page.getByRole('heading', { name: 'Eco Champions conversation', level: 1 }).waitFor();
      const head = page.locator('.ab-chip');
      s.expect(await head.allTextContents(), 'the chips').toEqual(['Eco Champions', pod]);
      await page.getByText(`Opens at ${pod}. Change this under`, { exact: false }).waitFor();
      s.expect(await page.getByLabel('Brand').inputValue(), 'the brand').toBe(ECO);
      await page.getByText('The Eco Champions colour').waitFor();
      await page.getByRole('link', { name: 'Edit the Eco Champions look' }).waitFor();
      // Opened first, the editor still lays out its cover image field (its styles come with the editor).
      s.expect(await page.locator('.x-image').first().evaluate((el) => getComputedStyle(el).display), 'the cover image field').toBe('grid');
      await s.screenshot(page, 'editor pod meeting 1280');
      const phone = await s.newPage({ signedIn: true, ...PHONE_VIEWPORT });
      await phone.goto(s.url(`/admin/event-types/${POD}`));
      await phone.getByRole('heading', { name: 'Eco Champions conversation', level: 1 }).waitFor();
      await s.screenshot(phone, 'editor pod meeting 390', { fullPage: false });
      await phone.getByRole('link', { name: 'Edit the Eco Champions look' }).scrollIntoViewIfNeeded();
      await s.screenshot(phone, 'editor pod meeting look 390', { fullPage: false });
    });

    await s.step('Intro call in Eco Champions: the colour field gives way to the brand colour, and its page follows', async () => {
      await page.goto(s.url('/admin/event-types/evt_intro'));
      await page.getByRole('heading', { name: 'Intro call', level: 1 }).waitFor();
      s.expect(await page.getByRole('textbox', { name: 'Event colour' }).count(), 'its own colour field').toBeGreaterThan(0);
      await page.getByLabel('Brand').selectOption(ECO);
      await page.getByText('The Eco Champions colour').waitFor();
      s.expect(await page.getByRole('textbox', { name: 'Event colour' }).count(), 'no colour field under a brand').toBe(0);
      await s.screenshot(page, 'editor intro call in eco champions', { fullPage: false });
      await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
      await saveBar(page).waitFor({ state: 'hidden' });
      s.expect((await eventsById(s)).evt_intro.brandId, 'stored').toBe(ECO);
      const visitor = await s.newPage({ timezoneId: NY });
      await visitor.goto(s.url('/intro'));
      await calendarReady(visitor);
      s.expect(await visitor.locator('.bw-summary__logo').getAttribute('src'), 'the logo').toBe('/meeting/brand/eco-champions/logo.svg');
      s.expect(await cssVar(visitor, '--m-primary'), 'the green').toBe('#14432f');
    });

    await s.step('a copy of the pod meeting keeps the brand, and no short link opens it', async () => {
      await openPage(page, 'Event types');
      await page.getByRole('button', { name: 'More actions for Eco Champions conversation' }).click();
      await page.getByRole('menuitem', { name: 'Duplicate' }).click();
      await expectToast(page, 'Copied as "Copy of Eco Champions conversation"');
      await page.getByRole('heading', { name: 'Copy of Eco Champions conversation', level: 1 }).waitFor();
      const copy = (await s.kv('event-types')).find((e) => e.title === 'Copy of Eco Champions conversation');
      s.expect(copy.brandId, 'the copy keeps the brand').toBe(ECO);
      s.expect((await s.kv('site')).shortLinks.pod, '/pod still opens the original').toBe(POD);
      s.expect(await page.locator('.ab-chip').allTextContents(), 'the copy has the brand chip only').toEqual(['Eco Champions']);
      s.expect(await page.getByText('Opens at', { exact: false }).count(), 'no "Opens at"').toBe(0);
    });
  });

  await t.scenario("Design: the Eco Champions look, logo and sender name, while Jimi's own look stays", async (s) => {
    const page = await liveLike(s);
    await s.runOneTimeMoves();
    const jimisLook = (await s.kv('site')).theme;
    const controls = page.locator('.dx-side');
    const group = async (name) => {
      const region = controls.getByRole('region', { name: new RegExp(`^${name}( |$)`) });
      if (!(await region.isVisible().catch(() => false))) await controls.getByRole('button', { name: new RegExp(`^${name}`) }).first().click();
      await region.waitFor();
      return region;
    };
    const save = async () => {
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expectToast(page, 'Design saved');
      await clearToasts(page);
    };
    const bookPod = async (email, start) => {
      await s.clearOutbox();
      const res = await s.book({ slug: 'eco-champions', start, durationMin: 30, name: 'Ann Lee', email });
      s.expect(res.status, 'booked on /pod').toBe(201);
      await s.settle();
      const [mail] = await s.outbox({ kind: 'email', to: email });
      return mail;
    };
    const visitor = await s.newPage({ timezoneId: NY });
    const podLook = async () => {
      await visitor.goto(s.shortUrl('pod'));
      await calendarReady(visitor);
      return { primary: await cssVar(visitor, '--m-primary'), logo: await visitor.locator('.bw-summary__logo').getAttribute('src') };
    };

    await s.step('"Look for" switches to Eco Champions, which says what uses it', async () => {
      await page.goto(s.url('/admin/design'));
      await page.getByRole('heading', { name: 'Design', level: 1 }).waitFor();
      await page.getByRole('radiogroup', { name: 'Look for' }).getByRole('radio', { name: 'Eco Champions' }).click();
      await page.getByText(`Used by Eco Champions conversation (localhost:${s.server.port}/pod).`).waitFor();
      s.expect(await page.locator('.dx-frame__url').textContent(), 'the preview shows the short link').toBe(`localhost:${s.server.port}/pod`);
      await page.getByRole('heading', { name: 'Brand details' }).waitFor();
      s.expect(new URL(page.url()).searchParams.get('brand'), 'the address').toBe(ECO);
      await s.screenshot(page, 'design eco champions 1280', { fullPage: false });
    });

    await s.step('a new green, saved: /pod follows', async () => {
      const colours = await group('Colours');
      const box = colours.getByRole('textbox', { name: 'Brand', exact: true });
      await box.fill('#1d5c40');
      await box.blur();
      await save();
      s.expect((await podLook()).primary, '/pod').toBe('#1d5c40');
    });

    let logoId = '';
    await s.step("an uploaded logo: /pod shows it, and the brand's stored look points at it", async () => {
      const images = await group('Images');
      const answer = page.waitForResponse((r) => r.url().endsWith('/api/admin/assets') && r.request().method() === 'POST');
      await images.locator('.x-image').filter({ hasText: 'Logo' }).locator('input[type="file"]').setInputFiles(pngFile('eco-logo.png', 120, 120, [20, 67, 47]));
      logoId = (await (await answer).json()).id;
      await save();
      s.expect((await podLook()).logo, '/pod').toBe(`/meeting/api/assets/${logoId}`);
      // Emails only show pictures from https addresses, so the logo in the email itself is checked by the unit
      // tests (brand-messages); here the brand's stored look points at the upload, which is what the email reads.
      const stored = (await s.kv('site')).brands.find((x) => x.id === ECO);
      s.expect(stored.theme.logoAssetId, 'the stored logo').toBe(logoId);
    });

    await s.step('"Use the built-in logo" brings the tile back', async () => {
      const images = await group('Images');
      await images.getByRole('button', { name: 'Use the built-in logo' }).click();
      await images.getByText('The Eco Champions logo is built in.').waitFor();
      await save();
      s.expect((await podLook()).logo, '/pod').toBe('/meeting/brand/eco-champions/logo.svg');
    });

    await s.step('a new sender name: the next email is from it, replies still go to Jimi', async () => {
      await page.getByLabel('Sender name').fill('Eco Champions Podcast');
      await save();
      const mail = await bookPod('bea@example.com', `${TUESDAY}T16:00:00.000Z`);
      s.expect(mail.from, 'From').toMatch(/^Eco Champions Podcast </);
    });

    await s.step("Jimi's own look never changed", async () => {
      s.expect((await s.kv('site')).theme, 'the site theme').toEqual(jimisLook);
      await page.getByRole('radiogroup', { name: 'Look for' }).getByRole('radio', { name: 'Jimi Cohen' }).click();
      await page.getByText(`Your own look: localhost:${s.server.port}/meeting, localhost:${s.server.port}/meet and every meeting without a brand.`).waitFor();
      const landing = await s.newPage({ timezoneId: NY });
      await landing.goto(s.url('/'));
      await landing.getByText(LIVE_PROFILE.welcome).waitFor();
      s.expect(await cssVar(landing, '--m-bg'), 'forest').toBe('#0b1d14');
    });
  });

  await t.scenario('Team: a new co-host is offered the pod meeting, ticked; unticked leaves it as it is', async (s) => {
    const page = await liveLike(s);
    await s.runOneTimeMoves();
    const pod = `localhost:${s.server.port}/pod`;
    const podHosts = async () => (await eventsById(s))[POD].hostIds;

    const addCoHost = async (p, { name, email, tick, shotLabel }) => {
      await p.getByRole('button', { name: 'Add a co-host' }).first().click();
      const dialog = p.getByRole('dialog', { name: 'Add a co-host' });
      await dialog.getByLabel('Name').fill(name);
      await dialog.getByLabel('Email').fill(email);
      const first = name.split(' ')[0];
      const box = dialog.getByRole('checkbox', { name: `Add ${first} to Eco Champions conversation` });
      s.expect(await box.isChecked(), 'ticked to begin with').toBe(true);
      if (shotLabel) await s.screenshot(p, shotLabel, { fullPage: false });
      if (!tick) await box.uncheck();
      await dialog.getByRole('button', { name: 'Add and get their link' }).click();
      return { dialog: p.getByRole('dialog', { name: `${first} is on the team` }), box: dialog, first };
    };

    await s.step('Ian, ticked: the offer reads as agreed, and the pod meeting books Jimi and Ian', async () => {
      await page.goto(s.url('/admin/team'));
      await page.getByRole('heading', { name: 'Team', level: 1 }).waitFor();
      await page.getByRole('button', { name: 'Add a co-host' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Add a co-host' });
      await dialog.getByLabel('Name').fill('Ian Poirier');
      await dialog.getByLabel('Email').fill('ian@example.com');
      const offer = dialog.getByRole('group', { name: 'Meetings to add them to' });
      await offer.getByText('Add Ian to Eco Champions conversation', { exact: true }).waitFor();
      await offer.getByText(`Once Ian connects a calendar, ${pod} only offers times when you are both free.`, { exact: true }).waitFor();
      s.expect(await offer.getByRole('checkbox').count(), 'only the pod meeting is offered').toBe(1);
      s.expect(await offer.getByRole('checkbox').isChecked(), 'ticked').toBe(true);
      await s.screenshot(page, 'team add co-host with eco offer 1280', { fullPage: false });
      await dialog.getByRole('button', { name: 'Add and get their link' }).click();
      const added = page.getByRole('dialog', { name: 'Ian is on the team' });
      await added.getByText("Ian is part of Eco Champions conversation now. Until Ian connects a calendar, only Ian's weekly hours are checked.").waitFor();
      await s.screenshot(page, 'team ian added to eco champions 1280', { fullPage: false });
      await added.getByRole('button', { name: 'Done' }).click();
      const ian = (await s.kv('hosts')).find((h) => h.email === 'ian@example.com');
      s.expect(await podHosts(), 'the pod meeting').toEqual(['host_owner', ian.id]);
      s.expect((await eventsById(s))[POD].kind, 'joint').toBe('collective');
    });

    await s.step('Sam, ticked, on a phone: the pod meeting books Jimi, Ian and Sam, and the dialog says so', async () => {
      const phone = await s.newPage({ signedIn: true, ...PHONE_VIEWPORT });
      await phone.goto(s.url('/admin/team'));
      await phone.getByRole('heading', { name: 'Team', level: 1 }).waitFor();
      const { dialog } = await addCoHost(phone, { name: 'Sam Green', email: 'sam@example.com', tick: true, shotLabel: 'team add co-host with eco offer 390' });
      await dialog.getByText('Sam is part of Eco Champions conversation now.', { exact: false }).waitFor();
      await s.screenshot(phone, 'team sam added 390', { fullPage: false });
      const hosts = await s.kv('hosts');
      const id = (email) => hosts.find((h) => h.email === email).id;
      s.expect(await podHosts(), 'the pod meeting').toEqual(['host_owner', id('ian@example.com'), id('sam@example.com')]);
    });

    await s.step('Lee, unticked: the pod meeting is unchanged, and the dialog says nothing about it', async () => {
      await page.reload();
      await page.getByRole('heading', { name: 'Team', level: 1 }).waitFor();
      const before = await podHosts();
      const { dialog } = await addCoHost(page, { name: 'Lee Park', email: 'lee@example.com', tick: false });
      await dialog.getByRole('textbox', { name: 'Private link for Lee Park' }).waitFor();
      s.expect(await dialog.getByText('is part of', { exact: false }).count(), 'no joined line').toBe(0);
      s.expect(await podHosts(), 'the pod meeting').toEqual(before);
    });

    await s.step('Kim, ticked, while Jimi works Saturdays only: the dialog says what the shared-hours check found', async () => {
      // A new co-host starts on 9 to 5, Monday to Friday, in Jimi's time zone: with Jimi on Saturdays only the hours never meet.
      await s.apiOk('PUT', '/admin/hosts/host_owner', {
        body: { schedules: [{ id: 'sch_default', name: 'Working hours', weekly: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [{ start: '10:00', end: '12:00' }] }, overrides: [] }], defaultScheduleId: 'sch_default' },
      });
      await page.reload();
      await page.getByRole('heading', { name: 'Team', level: 1 }).waitFor();
      const { dialog } = await addCoHost(page, { name: 'Kim Diaz', email: 'kim@example.com', tick: true });
      await dialog.getByText('Kim is part of Eco Champions conversation now.', { exact: false }).waitFor();
      await dialog.getByText('"Eco Champions conversation" cannot be booked: there is no time when', { exact: false }).waitFor();
      await s.screenshot(page, 'team kim added with the shared-hours warning', { fullPage: false });
    });
  });
});
