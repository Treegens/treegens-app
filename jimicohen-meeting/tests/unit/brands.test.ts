import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_BRANDS,
  ECO_CHAMPIONS,
  bookUrlFor,
  brandLine,
  brandOf,
  brandOfView,
  eventColorFor,
  isSiteView,
  pageTitle,
  siteForBrand,
  viewFor,
  type SiteView,
} from '../../shared/brands';
import { DEFAULT_CONSENT_TEXT, defaultSite } from '../../shared/defaults';
import { THEME_PRESETS } from '../../shared/presets';
import { resolveTheme } from '../../shared/theme';
import type { SiteSettings } from '../../shared/types';
import { BUILTIN_ASSET_FILES, builtinAsset } from '../../server/lib/builtinAssets';
import * as repo from '../../server/lib/repo';
import { contrastProblems } from '../../src/admin/components/x/contrast';
import { hostFirstName } from '../../src/public/lib/text';
import { makeTestCtx, TEST_NOW } from '../helpers/ctx';

const ROOT = path.resolve(__dirname, '../..');
const ECO = 'brand_eco_champions';

function site(over: Partial<SiteSettings> = {}): SiteSettings {
  return {
    ...defaultSite(TEST_NOW),
    email: { provider: 'resend', fromName: 'Jimi Cohen', fromEmail: 'hello@jimicohen.com', replyTo: 'jimi@jimicohen.com' },
    shortLinks: { meet: 'evt_meeting', pod: 'evt_eco_champions' },
    ...over,
  };
}

describe('brandOf', () => {
  it('is null for no brand and for an id that is not built in', () => {
    expect(brandOf(site(), null)).toBeNull();
    expect(brandOf(site(), {})).toBeNull();
    expect(brandOf(site(), { brandId: null })).toBeNull();
    expect(brandOf(site(), { brandId: 'brand_somebody_else' })).toBeNull();
  });

  it('gives the built-in Eco Champions brand, with the clock and the week of the owner', () => {
    const s = site();
    s.theme = { ...s.theme, timeFormat: '24h', weekStart: 'monday' };
    const brand = brandOf(s, { brandId: ECO })!;
    expect(brand.name).toBe('Eco Champions');
    expect(brand.emailFromName).toBe('Eco Champions');
    expect(brand.theme.preset).toBe('eco-champions');
    expect(brand.theme.colors).toMatchObject({ primary: '#14432f', accent: '#e1f250', background: '#faf5e6', surface: '#ffffff', text: '#06210d' });
    expect(brand.theme.fontHeading).toBe('fraunces');
    expect(brand.theme.texts.confirmationBody).toBe('Thanks, {{invitee_first_name}}. We look forward to talking with you.');
    expect(brand.theme.timeFormat).toBe('24h');
    expect(brand.theme.weekStart).toBe('monday');
  });

  it('lays the stored changes over the built-in brand; the name stays the brand', () => {
    const stored = { ...structuredClone(ECO_CHAMPIONS.theme), colors: { ...ECO_CHAMPIONS.theme.colors, primary: '#0f5132' }, logoAssetId: 'ast_logo1' };
    const s = site({ brands: [{ id: ECO, theme: stored, emailFromName: '  Eco Champions Studio ', updatedAt: TEST_NOW }, { id: 'brand_unknown' as never, theme: stored, emailFromName: 'X', updatedAt: TEST_NOW }] });
    const brand = brandOf(s, { brandId: ECO })!;
    expect(brand.theme.colors.primary).toBe('#0f5132');
    expect(brand.theme.logoAssetId).toBe('ast_logo1');
    expect(brand.emailFromName).toBe('Eco Champions Studio');
    expect(brand.name).toBe('Eco Champions');
    // An empty sender name falls back to the built-in one.
    expect(brandOf(site({ brands: [{ id: ECO, theme: stored, emailFromName: '   ', updatedAt: TEST_NOW }] }), { brandId: ECO })!.emailFromName).toBe('Eco Champions');
  });
});

describe('the brand view', () => {
  const s = site({ booking: { reminderOptInDefault: true, consentText: DEFAULT_CONSENT_TEXT, privacyUrl: 'https://jimicohen.com/privacy' } });
  const view = siteForBrand(s, brandOf(s, { brandId: ECO })!);

  it("shows the brand's name, look and sender, and keeps everything else the site's", () => {
    expect(view.brandViewOf).toBe(ECO);
    expect(view.profile).toEqual({ name: 'Eco Champions', headline: '', welcome: '', avatarAssetId: null, links: [] });
    expect(view.theme.preset).toBe('eco-champions');
    expect(view.email).toEqual({ provider: 'resend', fromName: 'Eco Champions', fromEmail: 'hello@jimicohen.com', replyTo: 'jimi@jimicohen.com' });
    expect(view.assistant).toEqual(s.assistant);
    expect(view.shortLinks).toEqual(s.shortLinks);
    expect(view.ownerHostId).toBe(s.ownerHostId);
    // The consent wording is the site's for every brand: the assistant calls on Jimi's behalf.
    expect(view.booking).toEqual(s.booking);
    expect(view.booking.consentText).toBe(DEFAULT_CONSENT_TEXT);
    // The stored settings are not touched.
    expect(s.profile.name).toBe('Jimi Cohen');
    expect(isSiteView(s)).toBe(false);
  });

  it('viewFor is the site itself for the owner own look', () => {
    expect(viewFor(s, { brandId: null })).toBe(s);
    expect(viewFor(s, {})).toBe(s);
    expect(isSiteView(viewFor(s, { brandId: ECO }))).toBe(true);
    expect(brandOfView(view)?.id).toBe(ECO);
    expect(brandOfView(s)).toBeNull();
  });

  it('refuses a brand on a brand', () => {
    expect(() => siteForBrand(view as never, ECO_CHAMPIONS)).toThrow(/already a brand view/);
  });

  it('the mark survives every way the code copies settings', () => {
    expect(isSiteView(structuredClone(view))).toBe(true);
    expect(isSiteView(JSON.parse(JSON.stringify(view)))).toBe(true);
    expect(isSiteView({ ...view, updatedAt: 'later' })).toBe(true);
  });
});

describe('a brand view can never be saved', () => {
  async function prepared() {
    const ctx = makeTestCtx();
    const stored = await repo.getSite(ctx);
    const view = siteForBrand(stored, brandOf(stored, { brandId: ECO })!);
    return { ctx, stored, view };
  }

  it('saveSite refuses a view and every copy of one', async () => {
    const { ctx, view } = await prepared();
    await expect(repo.saveSite(ctx, view as never)).rejects.toThrow('a brand view cannot be saved');
    await expect(repo.saveSite(ctx, structuredClone(view) as never)).rejects.toThrow('a brand view cannot be saved');
    await expect(repo.saveSite(ctx, JSON.parse(JSON.stringify(view)))).rejects.toThrow('a brand view cannot be saved');
    await expect(repo.saveSite(ctx, { ...view, updatedAt: TEST_NOW } as never)).rejects.toThrow('a brand view cannot be saved');
    expect((await repo.getSite(ctx)).profile.name).toBe('Jimi Cohen');
  });

  it('updateSite refuses a callback that returns a view, and writes nothing', async () => {
    const { ctx, stored } = await prepared();
    await expect(repo.updateSite(ctx, (fresh) => siteForBrand(fresh, brandOf(fresh, { brandId: ECO })!) as never)).rejects.toThrow('a brand view cannot be saved');
    expect(await repo.getSite(ctx)).toEqual(stored);
  });

  it('the compiler refuses one too', async () => {
    const { ctx, view } = await prepared();
    // @ts-expect-error a SiteView is not accepted by saveSite (brandViewOf?: never)
    await expect(repo.saveSite(ctx, view)).rejects.toThrow();
    const typed: SiteView = view;
    // @ts-expect-error nor returned from an updateSite callback
    await expect(repo.updateSite(ctx, () => typed)).rejects.toThrow();
  });
});

describe('small helpers', () => {
  it('drops the event colour while a brand is shown', () => {
    expect(eventColorFor({ color: '#c2417a' }, ECO_CHAMPIONS)).toBeUndefined();
    expect(eventColorFor({ color: '#c2417a' }, null)).toBe('#c2417a');
    expect(eventColorFor({ color: '' }, null)).toBeUndefined();
    expect(eventColorFor(null, null)).toBeUndefined();
    // The page look: a shown brand takes the place of the site theme and the event colour does not apply.
    const theme = resolveTheme(ECO_CHAMPIONS.theme, { layout: 'stacked' }, eventColorFor({ color: '#c2417a' }, ECO_CHAMPIONS));
    expect(theme.colors.primary).toBe('#14432f');
    expect(theme.layout).toBe('stacked');
  });

  it('names a page without saying the name twice', () => {
    expect(pageTitle('Meet with Jimi', 'Jimi Cohen')).toBe('Meet with Jimi');
    expect(pageTitle('Intro call', 'Jimi Cohen')).toBe('Intro call with Jimi Cohen');
    expect(pageTitle('Eco Champions conversation', 'Eco Champions')).toBe('Eco Champions conversation');
    expect(pageTitle('Sponsor call', 'Eco Champions')).toBe('Sponsor call with Eco Champions');
    expect(pageTitle('Meeting', '')).toBe('Meeting');
  });

  it('writes the brand line only for a brand, with the address to book again', () => {
    const s = site();
    const view = viewFor(s, { brandId: ECO });
    expect(brandLine(view, 'https://jimicohen.com/pod')).toBe('Booked through Eco Champions: https://jimicohen.com/pod');
    expect(brandLine(s, 'https://jimicohen.com/meet')).toBeNull();
  });

  it('books again at the short link only when it shows the look the booking was made in', () => {
    const s = site();
    const base = 'https://jimicohen.com/meeting';
    expect(bookUrlFor(base, s, { eventTypeId: 'evt_eco_champions', eventSlug: 'eco-champions', brandId: ECO })).toBe('https://jimicohen.com/pod');
    expect(bookUrlFor(base, s, { eventTypeId: 'evt_meeting', eventSlug: 'meeting' })).toBe('https://jimicohen.com/meet');
    // Booked in Jimi's look before the event got the brand: its own page, as before.
    expect(bookUrlFor(base, s, { eventTypeId: 'evt_eco_champions', eventSlug: 'eco-champions' })).toBe('https://jimicohen.com/meeting/eco-champions');
    expect(bookUrlFor(base, s, { eventTypeId: 'evt_intro', eventSlug: 'intro' })).toBe('https://jimicohen.com/meeting/intro');
    expect(bookUrlFor(base, { shortLinks: { pod: null } }, { eventTypeId: 'evt_eco_champions', eventSlug: 'eco-champions', brandId: ECO })).toBe('https://jimicohen.com/meeting/eco-champions');
  });

  it('a page with no host left names the brand whole, never "Eco", and the owner by first name', () => {
    // The public pages' "a note from ...", the consent wording and the manage page fall back on the page's name.
    const brandPage = { profile: { name: 'Eco Champions' }, brand: { id: ECO, name: 'Eco Champions', iconUrl: null } };
    const ownPage = { profile: { name: 'Jimi Cohen' }, brand: null };
    expect(hostFirstName([], brandPage)).toBe('Eco Champions');
    expect(hostFirstName([], ownPage)).toBe('Jimi');
    expect(hostFirstName([{ name: 'Ian Poirier' }], brandPage)).toBe('Ian');
  });
});

describe('the built-in brand material', () => {
  it('the eco-champions preset reads well everywhere and is in the gallery', () => {
    const preset = THEME_PRESETS.find((p) => p.key === 'eco-champions')!;
    expect(preset.label).toBe('Eco Champions');
    expect(contrastProblems(preset.theme.colors)).toBe(0);
    expect(preset.theme.scheme).toBe('fixed');
    expect(preset.theme.darkColors).toBeNull();
    expect(preset.theme).toMatchObject({ radius: 16, buttonShape: 'pill', cardStyle: 'elevated', shadow: 1, layout: 'split', calendarStyle: 'bubbles', slotStyle: 'list', fontBody: 'inter' });
  });

  it('the built-in art is in public/ where the brand says', () => {
    for (const brand of Object.values(BUILTIN_BRANDS)) {
      for (const file of [brand.art.logo, brand.art.favicon, brand.art.faviconPng, brand.art.touchIcon, brand.art.previewImage.path]) {
        expect(() => readFileSync(path.join(ROOT, 'public', file)), file).not.toThrow();
      }
    }
  });

  it('the email logo served by the asset route is exactly the file in public/', () => {
    for (const [id, file] of Object.entries(BUILTIN_ASSET_FILES)) {
      const asset = builtinAsset(id)!;
      expect(asset.contentType).toBe('image/png');
      expect(Buffer.from(asset.data).equals(readFileSync(path.join(ROOT, file)))).toBe(true);
    }
    expect(BUILTIN_ASSET_FILES[ECO_CHAMPIONS.art.emailLogoAssetId]).toBe('public/brand/eco-champions/email-logo.png');
    expect(builtinAsset('ast_whatever')).toBeNull();
    expect(repo.isStorageId(ECO_CHAMPIONS.art.emailLogoAssetId)).toBe(true);
  });
});
