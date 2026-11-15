/**
 * The design editor in a real browser against the real backend: every group of controls, the
 * live preview, and above all the public booking page after Save, which must show the same
 * theme (computed styles and texts are read from the public page, not only from the preview).
 */
import { defineSuite } from './lib.mjs';
import { MONDAY, clearToasts, expectToast, navLink, offeredTimes, openBookingPage, pngFile, rgb } from './admin-helpers.mjs';

const VARS = [
  '--m-primary',
  '--m-accent',
  '--m-bg',
  '--m-surface',
  '--m-text',
  '--m-muted',
  '--m-border',
  '--m-on-primary',
  '--m-radius',
  '--m-radius-btn',
  '--m-font-heading',
  '--m-font-body',
  '--m-font-scale',
  '--m-btn-bg',
  '--m-btn-fg',
  '--m-btn-border',
  '--m-card-bg',
  '--m-card-shadow',
  '--m-bg-image',
  '--m-density',
  '--m-cover-height',
];

/** The theme as an element carries it: the CSS variables and the data-* switches. */
async function themeOf(scope) {
  return scope.evaluate((el, names) => {
    const style = getComputedStyle(el);
    const vars = Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
    const data = {};
    for (const attribute of el.attributes) if (attribute.name.startsWith('data-')) data[attribute.name] = attribute.value;
    return { vars, data };
  }, VARS);
}

/** Computed styles of one element that do not depend on how wide the page is. */
async function lookOf(locator) {
  return locator.first().evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      color: s.color,
      backgroundColor: s.backgroundColor,
      borderTopColor: s.borderTopColor,
      borderTopWidth: s.borderTopWidth,
      borderTopLeftRadius: s.borderTopLeftRadius,
      fontFamily: s.fontFamily,
      fontWeight: s.fontWeight,
      boxShadow: s.boxShadow,
      outline: `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}`,
    };
  });
}

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a, b) {
  const luminance = (hex) => {
    const channel = (i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const COLOURS = { primary: '#7c3aed', accent: '#f59e0b', background: '#fdf4ff', surface: '#ffffff', text: '#1f1147', muted: '#6b5b95', border: '#e9d5ff' };
const TEXTS = {
  pickTimeLabel: 'Choose a moment',
  ctaLabel: 'Book it',
  confirmationTitle: 'See you soon',
  confirmationBody: 'We sent the details to {{invitee_email}}.',
  footerNote: 'Questions? Write to hello@example.com',
};
const CUSTOM_CSS = '.bw__card { outline: 3px solid rgb(255, 0, 128); }';

export default defineSuite('admin-design', { mockCreds: true }, async (t) => {
  await t.scenario('design: every control, the live preview, and the public page after Save', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'UTC' });
    const page = await s.newPage({ signedIn: true, viewport: { width: 1440, height: 900 } });
    const controls = page.locator('.dx-side');
    const preview = page.locator('.dx-stage__scope');
    const status = page.locator('.dx-head__status');
    const theme = async () => (await s.kv('site')).theme;
    /** Opens one group of controls (they close each other) and returns it. */
    const group = async (name) => {
      // The name of a group also says what is in it ("Shape 2 unsaved changes", "Colours 1 colour is hard to read").
      const region = controls.getByRole('region', { name: new RegExp(`^${name}( |$)`) });
      if (!(await region.isVisible().catch(() => false))) await controls.getByRole('button', { name: new RegExp(`^${name}`) }).first().click();
      await region.waitFor();
      return region;
    };
    const colour = async (region, name, hex) => {
      const box = region.getByRole('textbox', { name, exact: true });
      await box.fill(hex);
      await box.blur();
    };
    /** Picks one option of a radio group. Picture tiles are real radio inputs under their picture, the others are buttons. */
    const choose = async (region, groupName, option) => {
      const radio = region.getByRole('radiogroup', { name: groupName }).getByRole('radio', { name: option, exact: true });
      if ((await radio.evaluate((el) => el.tagName)) === 'INPUT') await radio.check({ force: true });
      else await radio.click();
    };
    const save = async () => {
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expectToast(page, 'Design saved');
      await status.getByText('Everything is saved').waitFor();
      await clearToasts(page);
    };

    await s.step('the editor opens on the saved design, with nothing to save', async () => {
      await page.goto(s.url('/admin/design'));
      await page.getByRole('heading', { name: 'Design', level: 1 }).waitFor();
      await status.getByText('Everything is saved').waitFor();
      s.expect(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'save button with nothing changed').toBe(true);
      s.expect((await themeOf(preview)).data['data-preset'], 'preset in the preview').toBe('forest');
    });

    await s.step('a preset changes the whole look: the preview at once, the public page after Save', async () => {
      const presets = await group('Presets');
      await presets.getByRole('button', { name: /^Daylight/ }).click();
      await presets.getByRole('button', { name: /^Daylight/, pressed: true }).waitFor();
      await status.getByText('Unsaved changes').waitFor();
      const before = await themeOf(preview);
      s.expect(before.data, 'preview after picking Daylight').toMatchObject({ 'data-preset': 'daylight', 'data-scheme': 'light' });
      // Not saved yet: visitors still get the old look.
      s.expect((await s.apiOk('GET', '/public/site')).theme.preset, 'public preset before Save').toBe('forest');
      await save();
      s.expect((await theme()).preset, 'stored preset').toBe('daylight');
      const visitor = await s.newPage({ timezoneId: 'UTC', colorScheme: 'light' });
      await openBookingPage(s, visitor, 'intro');
      const live = await themeOf(visitor.locator('.m-scope.m-page'));
      s.expect(live, 'the public page carries the same theme as the preview').toEqual(await themeOf(preview));
      s.expect(live.vars['--m-primary'], 'brand colour of Daylight on the public page').toBe((await theme()).colors.primary);
      await visitor.context().close();
    });

    await s.step('colours and background', async () => {
      const colours = await group('Colours');
      await choose(colours, 'Palettes', 'One palette');
      await colour(colours, 'Brand', COLOURS.primary);
      await colour(colours, 'Accent', COLOURS.accent);
      await colour(colours, 'Page', COLOURS.background);
      await colour(colours, 'Cards', COLOURS.surface);
      await colour(colours, 'Text', COLOURS.text);
      await colour(colours, 'Secondary text', COLOURS.muted);
      await colour(colours, 'Lines', COLOURS.border);
      await colours.getByRole('group', { name: 'Readability' }).getByText('All good').waitFor();
      s.expect((await themeOf(preview)).vars, 'colours in the preview').toMatchObject({ '--m-primary': COLOURS.primary, '--m-text': COLOURS.text, '--m-border': COLOURS.border });

      const background = await group('Background');
      await choose(background, 'Background style', 'Gradient');
      await colour(background, 'From', '#fdf4ff');
      await colour(background, 'To', '#ede9fe');
      await background.getByRole('slider', { name: 'Direction' }).fill('135');
      const now = await themeOf(preview);
      s.expect(now.data['data-bg'], 'background type in the preview').toBe('gradient');
      s.expect(now.vars['--m-bg-image'], 'background layers in the preview').toMatch(/linear-gradient\(135deg/);
    });

    await s.step('fonts, radius, buttons, cards, shadow, photos', async () => {
      const type = await group('Typography');
      // Each font is written in its own face. The list stays open after a pick, so the preview can be compared.
      await type.getByRole('button', { name: /^Heading font:/ }).click();
      await page.getByRole('listbox', { name: 'Heading font' }).getByRole('option', { name: /Playfair Display$/ }).click();
      await page.getByRole('listbox', { name: 'Heading font' }).getByRole('option', { name: /Playfair Display$/, selected: true }).waitFor();
      await page.keyboard.press('Escape');
      await type.getByRole('button', { name: 'Heading font: Playfair Display. Change' }).waitFor();
      await type.getByRole('button', { name: /^Body font:/ }).click();
      await page.getByRole('listbox', { name: 'Body font' }).getByRole('option', { name: /DM Sans$/ }).click();
      await page.keyboard.press('Escape');
      await type.getByRole('button', { name: 'Body font: DM Sans. Change' }).waitFor();
      await type.getByRole('slider', { name: 'Text size' }).fill('1.1');
      const fonts = (await themeOf(preview)).vars;
      s.expect(fonts['--m-font-heading'], 'heading font in the preview').toMatch(/^"?Playfair Display/);
      s.expect(fonts['--m-font-body'], 'body font in the preview').toMatch(/^"?DM Sans/);
      s.expect(fonts['--m-font-scale'], 'text size in the preview').toBe('1.1');

      const shape = await group('Shape');
      await shape.getByRole('slider', { name: 'Corner radius' }).fill('6');
      await choose(shape, 'Button fill', 'Outline');
      await choose(shape, 'Button shape', 'Square');
      await choose(shape, 'Card style', 'Outlined');
      await choose(shape, 'Shadow', 'None');
      await choose(shape, 'Photo shape', 'Square');
      const now = await themeOf(preview);
      s.expect(now.vars['--m-radius'], 'radius in the preview').toBe('6px');
      s.expect(now.data, 'shape switches in the preview').toMatchObject({ 'data-button': 'outline', 'data-button-shape': 'square', 'data-card': 'bordered', 'data-avatar': 'square' });
    });

    await s.step('layout, calendar and slot styles, clock and week start', async () => {
      const layout = await group('Layout');
      await choose(layout, 'Arrangement', 'Stacked');
      await choose(layout, 'Spacing', 'Compact');
      await choose(layout, 'Motion', 'None');
      await layout.getByRole('switch', { name: 'Confetti when a booking is confirmed' }).click();
      const calendar = await group('Calendar and times');
      await choose(calendar, 'Calendar days', 'Boxes');
      await choose(calendar, 'Time slots', 'Two columns');
      await choose(calendar, 'Clock', '14:30');
      await choose(calendar, 'Week starts on', 'Monday');
      s.expect((await themeOf(preview)).data, 'layout switches in the preview').toMatchObject({
        'data-layout': 'stacked',
        'data-density': 'compact',
        'data-animations': 'none',
        'data-calendar': 'grid',
        'data-slots': 'grid',
      });
      // The preview is the real widget: its first weekday and its clock follow.
      const stage = page.getByRole('region', { name: 'Live preview of your booking page' });
      s.expect(await stage.getByRole('columnheader').first().textContent(), 'first weekday in the preview').toMatch(/^Mon/);
      s.expect(await stage.locator('button.bw-slot').first().textContent(), 'a time in the preview').toMatch(/^\d\d:\d\d$/);
    });

    const uploaded = {};
    await s.step('images: a logo and a cover are uploaded and show in the preview', async () => {
      const images = await group('Images');
      const upload = async (label, file, purpose) => {
        const answer = page.waitForResponse((r) => r.url().endsWith('/api/admin/assets') && r.request().method() === 'POST');
        await images.locator('.x-image').filter({ hasText: label }).locator('input[type="file"]').setInputFiles(file);
        const response = await answer;
        s.expect(response.status(), `upload status of the ${purpose}`).toBe(201);
        const body = await response.json();
        s.expect(body.url, `address of the ${purpose}`).toBe(`/meeting/api/assets/${body.id}`);
        return body.id;
      };
      uploaded.logo = await upload('Logo', pngFile('logo.png', 120, 40, [200, 30, 60]), 'logo');
      uploaded.cover = await upload('Cover image', pngFile('cover.png', 600, 200, [30, 90, 200]), 'cover');
      await images.getByRole('slider', { name: 'Cover height' }).fill('200');
      const stage = page.getByRole('region', { name: 'Live preview of your booking page' });
      await stage.locator('img.bw-summary__logo').waitFor();
      s.expect(await stage.locator('img.bw-summary__logo').evaluate((img) => img.naturalWidth), 'logo in the preview').toBe(120);
      s.expect(await stage.locator('.bw__cover img').evaluate((img) => img.naturalWidth), 'cover in the preview').toBe(600);
      // Something that is not an image is refused, with a reason.
      await images.locator('.x-image').filter({ hasText: 'Logo' }).locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
      await images.getByRole('alert').filter({ hasText: 'Please choose a PNG, JPEG, WebP or GIF image.' }).waitFor();
    });

    await s.step('wording and custom CSS', async () => {
      const wording = await group('Wording');
      await wording.getByRole('textbox', { name: 'Heading above the times' }).fill(TEXTS.pickTimeLabel);
      await wording.getByRole('textbox', { name: 'Booking button' }).fill(TEXTS.ctaLabel);
      await wording.getByRole('textbox', { name: 'Confirmation title' }).fill(TEXTS.confirmationTitle);
      await wording.getByRole('textbox', { name: 'Confirmation message' }).fill(TEXTS.confirmationBody);
      await wording.getByRole('textbox', { name: 'Footer note' }).fill(TEXTS.footerNote);
      const stage = page.getByRole('region', { name: 'Live preview of your booking page' });
      await stage.getByRole('heading', { name: TEXTS.pickTimeLabel }).waitFor();
      await stage.getByText(TEXTS.footerNote).waitFor();
      await choose(page, 'Screen', 'Details');
      await stage.getByRole('button', { name: TEXTS.ctaLabel }).waitFor();
      await choose(page, 'Screen', 'Confirmed');
      await stage.getByRole('heading', { name: TEXTS.confirmationTitle }).waitFor();
      await choose(page, 'Screen', 'Times');

      const advanced = await group('Advanced');
      await advanced.getByRole('textbox', { name: 'Custom CSS' }).fill(CUSTOM_CSS);
      await advanced.getByRole('switch', { name: 'Hide the scheduling credit in the footer' }).click();
      await s.eventually(async () => s.expect((await lookOf(stage.locator('.bw__card'))).outline, 'custom CSS in the preview').toBe('3px solid rgb(255, 0, 128)'));
      s.expect(await stage.getByText('Scheduling by').count(), 'credit in the preview').toBe(0);
      await s.screenshot(page, 'design editor before saving', { fullPage: false });
    });

    let previewTheme = null;
    let previewLooks = null;
    await s.step('save: the whole theme is stored', async () => {
      await save();
      s.expect(await theme(), 'the stored theme').toMatchObject({
        preset: 'custom',
        scheme: 'fixed',
        colors: COLOURS,
        background: { type: 'gradient', gradientFrom: '#fdf4ff', gradientTo: '#ede9fe', gradientAngle: 135 },
        fontHeading: 'playfair-display',
        fontBody: 'dm-sans',
        fontScale: 1.1,
        radius: 6,
        buttonStyle: 'outline',
        buttonShape: 'square',
        cardStyle: 'bordered',
        shadow: 0,
        layout: 'stacked',
        calendarStyle: 'grid',
        slotStyle: 'grid',
        density: 'compact',
        avatarShape: 'square',
        coverAssetId: uploaded.cover,
        coverHeight: 200,
        logoAssetId: uploaded.logo,
        timeFormat: '24h',
        weekStart: 'monday',
        animations: 'none',
        confetti: false,
        texts: TEXTS,
        customCss: CUSTOM_CSS,
        hideBranding: true,
      });
      // A reload of the editor starts from what was stored.
      await page.reload();
      await status.getByText('Everything is saved').waitFor();
      const stage = page.getByRole('region', { name: 'Live preview of your booking page' });
      await stage.getByRole('heading', { name: TEXTS.pickTimeLabel }).waitFor();
      await stage.locator('img.bw-summary__logo').waitFor();
      previewTheme = await themeOf(preview);
      previewLooks = { card: await lookOf(stage.locator('.bw__card')), title: await lookOf(stage.getByRole('heading', { level: 1 })), slot: await lookOf(stage.locator('button.bw-slot')) };
      const shape = await group('Shape');
      s.expect(await shape.getByRole('slider', { name: 'Corner radius' }).inputValue(), 'radius control after a reload').toBe('6');
      s.expect(await shape.getByRole('radiogroup', { name: 'Button shape' }).getByRole('radio', { name: 'Square' }).isChecked(), 'button shape after a reload').toBe(true);
    });

    const visitor = await s.newPage({ timezoneId: 'UTC', colorScheme: 'light' });
    await s.step('the public booking page shows the same theme: variables, switches and real styles', async () => {
      await openBookingPage(s, visitor, 'intro');
      const scope = visitor.locator('.m-scope.m-page');
      const live = await themeOf(scope);
      s.expect(live.data, 'switches on the public page').toEqual(previewTheme.data);
      s.expect(live.vars, 'variables on the public page').toEqual(previewTheme.vars);
      // Absolute values, read from the page itself.
      s.expect(live.vars, 'colours on the public page').toMatchObject({ '--m-primary': COLOURS.primary, '--m-accent': COLOURS.accent, '--m-surface': COLOURS.surface, '--m-text': COLOURS.text, '--m-muted': COLOURS.muted, '--m-border': COLOURS.border, '--m-radius': '6px', '--m-font-scale': '1.1', '--m-cover-height': '200px' });
      s.expect(live.data, 'switches on the public page').toMatchObject({ 'data-preset': 'custom', 'data-layout': 'stacked', 'data-calendar': 'grid', 'data-slots': 'grid', 'data-card': 'bordered', 'data-button': 'outline', 'data-button-shape': 'square', 'data-density': 'compact', 'data-avatar': 'square', 'data-animations': 'none', 'data-bg': 'gradient' });
      s.expect(await visitor.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'page colour behind everything').toBe(rgb(COLOURS.background));

      const card = await lookOf(visitor.locator('.bw__card'));
      s.expect(card.outline, 'custom CSS on the public page').toBe('3px solid rgb(255, 0, 128)');
      s.expect(card.backgroundColor, 'card colour').toBe(rgb(COLOURS.surface));
      s.expect(card.borderTopColor, 'card border colour').toBe(rgb(COLOURS.border));
      s.expect(card.boxShadow, 'card shadow').toBe('none');
      s.expect(card, 'the card looks like the one in the preview').toEqual(previewLooks.card);
      const title = await lookOf(visitor.getByRole('heading', { level: 1 }));
      s.expect(title.fontFamily, 'heading font').toMatch(/^"?Playfair Display/);
      s.expect(title.color, 'heading colour').toBe(rgb(COLOURS.text));
      s.expect(title, 'the title looks like the one in the preview').toEqual(previewLooks.title);
      s.expect(await visitor.evaluate(() => getComputedStyle(document.querySelector('.bw-summary__desc, .bw p')).fontFamily), 'body font').toMatch(/^"?DM Sans/);

      // Week starts on Monday, the 24 hour clock, the uploaded images.
      s.expect(await visitor.getByRole('columnheader').first().textContent(), 'first weekday').toMatch(/^Mon/);
      const times = await offeredTimes(visitor, '2026-11-17');
      s.expect(times.length, 'times on Tuesday').toBe(32);
      s.expect(await visitor.locator('button.bw-slot').first().textContent(), 'first time, on the 24 hour clock').toBe('09:00');
      const slot = await lookOf(visitor.locator('button.bw-slot'));
      s.expect(slot, 'a time button looks like the one in the preview').toEqual(previewLooks.slot);
      // "Square" keeps a hint of a corner: the radius the theme hands to buttons.
      s.expect(live.vars['--m-radius-btn'], 'button radius of the theme').toBe('2px');
      s.expect(slot.borderTopLeftRadius, 'corners of a time button').toBe('2px');
      const logo = visitor.locator('img.bw-summary__logo');
      s.expect(await logo.getAttribute('src'), 'logo address').toBe(`/meeting/api/assets/${uploaded.logo}`);
      s.expect(await logo.evaluate((img) => img.complete && img.naturalWidth), 'logo loaded').toBe(120);
      const cover = visitor.locator('.bw__cover img');
      s.expect(await cover.getAttribute('src'), 'cover address').toBe(`/meeting/api/assets/${uploaded.cover}`);
      s.expect(await cover.evaluate((img) => img.complete && img.naturalWidth), 'cover loaded').toBe(600);
      s.expect(await visitor.locator('.bw__cover').evaluate((el) => Math.round(el.getBoundingClientRect().height)), 'cover height').toBe(200);
      await s.screenshot(visitor, 'public page with the saved design');
    });

    await s.step('the wording is on the public page, from the heading to the confirmation', async () => {
      await visitor.getByRole('heading', { name: TEXTS.pickTimeLabel }).waitFor();
      await visitor.getByText(TEXTS.footerNote).waitFor();
      s.expect(await visitor.getByText('Scheduling by').count(), 'credit on the public page').toBe(0);
      await visitor.locator('button.bw-slot').first().click();
      const form = visitor.getByRole('form', { name: 'Your details' });
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Ada Lovelace');
      await form.getByRole('textbox', { name: 'Email', exact: true }).fill('ada@example.com');
      const cta = visitor.getByRole('button', { name: TEXTS.ctaLabel });
      // An outlined, square button in the brand colour.
      const look = await lookOf(cta);
      s.expect(look.borderTopLeftRadius, 'booking button corners').toBe('2px');
      s.expect(look.borderTopColor, 'booking button outline').toBe(rgb(COLOURS.primary));
      await s.linger(visitor);
      await cta.click();
      await visitor.getByRole('heading', { name: TEXTS.confirmationTitle }).waitFor();
      await visitor.getByText('We sent the details to ada@example.com.').waitFor();
      s.expect(await visitor.locator('canvas').count(), 'confetti canvases when confetti is off').toBe(0);
      await s.settle();
      // The landing page wears it too.
      await visitor.goto(s.url('/'));
      await visitor.locator('img.pl__logo').waitFor();
      s.expect(await themeOf(visitor.locator('.m-scope.m-page')), 'theme on the landing page').toEqual(previewTheme);
      s.expect(await visitor.locator('img.pl__logo').evaluate((img) => img.complete && img.naturalWidth), 'logo on the landing page').toBe(120);
      await s.screenshot(visitor, 'landing page with the saved design');
    });

    await s.step('undo and redo, with the buttons and from the keyboard', async () => {
      const shape = await group('Shape');
      const pill = shape.getByRole('radiogroup', { name: 'Button shape' }).getByRole('radio', { name: 'Pill' });
      const square = shape.getByRole('radiogroup', { name: 'Button shape' }).getByRole('radio', { name: 'Square' });
      s.expect(await page.getByRole('button', { name: 'Undo the last change' }).isDisabled(), 'undo with nothing to undo').toBe(true);
      await pill.check({ force: true });
      await status.getByText('Unsaved changes').waitFor();
      s.expect((await themeOf(preview)).data['data-button-shape'], 'preview after the change').toBe('pill');
      await page.getByRole('button', { name: 'Undo the last change' }).click();
      await status.getByText('Everything is saved').waitFor();
      s.expect(await square.isChecked(), 'button shape after undo').toBe(true);
      s.expect((await themeOf(preview)).data['data-button-shape'], 'preview after undo').toBe('square');
      await page.getByRole('button', { name: 'Redo' }).click();
      await status.getByText('Unsaved changes').waitFor();
      s.expect(await pill.isChecked(), 'button shape after redo').toBe(true);
      // Ctrl+Z outside a text field undoes, Ctrl+Shift+Z redoes.
      await page.locator('.dx-head').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Control+z');
      await status.getByText('Everything is saved').waitFor();
      await page.keyboard.press('Control+Shift+z');
      await status.getByText('Unsaved changes').waitFor();
      await page.keyboard.press('Control+z');
      await status.getByText('Everything is saved').waitFor();
      // Inside a text field the keys belong to the field.
      const wording = await group('Wording');
      await wording.getByRole('textbox', { name: 'Booking button' }).fill('Reserve');
      await status.getByText('Unsaved changes').waitFor();
      await page.getByRole('button', { name: 'Undo the last change' }).click();
      s.expect(await wording.getByRole('textbox', { name: 'Booking button' }).inputValue(), 'button wording after undo').toBe(TEXTS.ctaLabel);
      await status.getByText('Everything is saved').waitFor();
    });

    await s.step('discard goes back to the saved design, and can itself be undone', async () => {
      const layout = await group('Layout');
      await choose(layout, 'Arrangement', 'Centered');
      await choose(layout, 'Spacing', 'Comfortable');
      await status.getByText('Unsaved changes').waitFor();
      await page.getByRole('button', { name: 'Discard' }).click();
      const toast = await expectToast(page, 'Back to the saved design');
      await status.getByText('Everything is saved').waitFor();
      s.expect((await themeOf(preview)).data, 'preview after discard').toMatchObject({ 'data-layout': 'stacked', 'data-density': 'compact' });
      await toast.getByRole('button', { name: 'Undo' }).click();
      await status.getByText('Unsaved changes').waitFor();
      s.expect((await themeOf(preview)).data, 'preview after undoing the discard').toMatchObject({ 'data-layout': 'centered', 'data-density': 'comfortable' });
      await page.getByRole('button', { name: 'Discard' }).click();
      await status.getByText('Everything is saved').waitFor();
      await clearToasts(page);
      s.expect((await theme()).layout, 'nothing of this was stored').toBe('stacked');
    });

    await s.step('leaving with unsaved changes asks first: links, and closing or reloading the tab', async () => {
      // Arrive through the menu, so the browser has a page of the dashboard to go back to.
      await navLink(page, 'Home').click();
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Jimi$/, level: 1 }).waitFor();
      await navLink(page, 'Design').click();
      await status.getByText('Everything is saved').waitFor();
      const layout = await group('Layout');
      await choose(layout, 'Motion', 'Lively');
      await status.getByText('Unsaved changes').waitFor();
      await navLink(page, 'Home').click();
      const dialog = page.getByRole('dialog', { name: 'Leave without saving?' });
      await dialog.getByRole('button', { name: 'Keep editing' }).click();
      await dialog.waitFor({ state: 'hidden' });
      s.expect(new URL(page.url()).pathname, 'still on the design page').toBe('/meeting/admin/design');
      await status.getByText('Unsaved changes').waitFor();

      // Reloading: the browser itself asks. Staying keeps the draft.
      const asked = [];
      page.once('dialog', (d) => {
        asked.push(d.type());
        void d.dismiss();
      });
      await page.evaluate(() => {
        window.location.reload();
      });
      await s.eventually(() => s.expect(asked, 'what the browser asked').toEqual(['beforeunload']));
      await status.getByText('Unsaved changes').waitFor();
      s.expect(await (await group('Layout')).getByRole('radiogroup', { name: 'Motion' }).getByRole('radio', { name: 'Lively' }).isChecked(), 'the draft is still there').toBe(true);

      // The browser's back button is guarded as well. The guard puts the visitor back with a
      // history step of its own, and here that step is slow: the draft must survive the wait,
      // which it only does when the router never hears about the press.
      await page.evaluate(() => {
        const go = window.history.go.bind(window.history);
        window.history.go = (delta) => {
          window.setTimeout(() => go(delta), 400);
        };
        window.__restoreHistoryGo = () => {
          window.history.go = go;
        };
      });
      await page.goBack();
      await dialog.getByRole('button', { name: 'Keep editing' }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForURL((url) => url.pathname === '/meeting/admin/design');
      await page.waitForTimeout(600);
      s.expect(await status.textContent(), 'the draft after pressing "back" and staying').toBe('Unsaved changes');
      s.expect(await (await group('Layout')).getByRole('radiogroup', { name: 'Motion' }).getByRole('radio', { name: 'Lively' }).isChecked(), 'the change is still on the page').toBe(true);
      await page.evaluate(() => window.__restoreHistoryGo());

      // And "Leave page" after pressing back really goes back, to the page before.
      await page.goBack();
      await dialog.getByRole('button', { name: 'Leave page' }).click();
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Jimi$/, level: 1 }).waitFor();
      s.expect(new URL(page.url()).pathname, 'address after leaving with the back button').toBe('/meeting/admin');
      s.expect((await theme()).animations, 'the abandoned change was not stored').toBe('none');
      await page.goForward();
      await status.getByText('Everything is saved').waitFor();
      await choose(await group('Layout'), 'Motion', 'Lively');
      await status.getByText('Unsaved changes').waitFor();

      await navLink(page, 'Home').click();
      await dialog.getByRole('button', { name: 'Leave page' }).click();
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Jimi$/, level: 1 }).waitFor();
      s.expect((await theme()).animations, 'the abandoned change was not stored').toBe('none');
      await navLink(page, 'Design').click();
      await status.getByText('Everything is saved').waitFor();
      s.expect((await themeOf(preview)).data['data-animations'], 'the editor is back on the saved design').toBe('none');
    });

    await s.step('a pair of colours that is hard to read is flagged, and Fix repairs it', async () => {
      const colours = await group('Colours');
      await colour(colours, 'Text', '#f3f0ff');
      const readability = colours.getByRole('group', { name: 'Readability' });
      await readability.getByText('Text is hard to read against the card colour.').waitFor();
      await page.locator('.dx-head__warn').getByText('1 readability warning').waitFor();
      s.expect(contrast('#f3f0ff', COLOURS.surface), 'contrast of the bad pair').toBeLessThan(3);
      await readability.getByRole('button', { name: 'Fix: Text on cards' }).click();
      await readability.getByText('All good').waitFor();
      s.expect(await page.locator('.dx-head__warn').count(), 'warnings in the header after Fix').toBe(0);
      const repaired = await colours.getByRole('textbox', { name: 'Text', exact: true }).inputValue();
      s.expect(repaired, 'the repaired colour').toMatch(/^#[0-9a-f]{6}$/i);
      s.expect(contrast(repaired.toLowerCase(), COLOURS.surface), 'contrast after Fix').toBeGreaterThanOrEqual(4.5);
      s.expect((await themeOf(preview)).vars['--m-text'].toLowerCase(), 'the preview uses the repaired colour').toBe(repaired.toLowerCase());
      // One click on Undo brings the unreadable colour back, so Fix is a single step.
      await page.getByRole('button', { name: 'Undo the last change' }).click();
      await readability.getByText('Text is hard to read against the card colour.').waitFor();
      await page.getByRole('button', { name: 'Redo' }).click();
      await readability.getByText('All good').waitFor();
      await save();
      s.expect((await theme()).colors.text.toLowerCase(), 'the stored text colour').toBe(repaired.toLowerCase());
    });
  });
});
