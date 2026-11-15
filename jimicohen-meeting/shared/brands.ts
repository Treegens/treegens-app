/**
 * Brands: a look and a name that a meeting can carry instead of the owner's own (jimicohen.com/pod is
 * Eco Champions). One brand is built in. Its name, art and link preview ship with the app; the owner can
 * change its look, logo and sender name in Design, and those changes live in `site.brands`.
 *
 * Everything an invitee sees is built from the site settings, so a brand is applied in one place: a
 * *view* of the site settings with the brand laid over them (`siteForBrand`). A view is marked with a
 * plain `brandViewOf` field, which survives structuredClone, spreads and JSON, and the repo refuses to
 * save anything that carries it (server/lib/repo.ts). Pure: shared by the server and the dashboard preview.
 */
import { DEFAULT_THEME } from './defaults';
import { applyPreset } from './presets';
import { shortNameFor, shortUrlOf, SHORT_LINKS } from './shortLinks';
import { resolveTheme } from './theme';
import type { BrandId, BrandSettings, SiteSettings, Theme } from './types';

export type { BrandId, BrandSettings };

export const ECO_CHAMPIONS_BRAND_ID: BrandId = 'brand_eco_champions';

/** Files in public/brand/<key>, paths relative to the base path (/meeting). */
export interface BuiltinArt {
  logo: string;
  favicon: string;
  faviconPng: string;
  touchIcon: string;
  /** an id the public asset route answers with built-in bytes (server/lib/builtinAssets.ts) */
  emailLogoAssetId: string;
  previewImage: { path: string; width: number; height: number; alt: string };
}

/** What ships with the app. */
export interface BuiltinBrand {
  id: BrandId;
  /** fixed: it is the brand. On its pages, in emails and texts, said on reminder calls. */
  name: string;
  /** the default look */
  theme: Theme;
  /** the default sender name on emails about its meetings */
  emailFromName: string;
  art: BuiltinArt;
  /** the page shown when its link is closed */
  closed: { title: string; text: string };
}

/** The built-in brand with the owner's stored changes laid over it. */
export type Brand = BuiltinBrand;

function ecoTheme(): Theme {
  const theme = applyPreset(DEFAULT_THEME, 'eco-champions');
  return { ...theme, texts: { ...theme.texts, confirmationBody: 'Thanks, {{invitee_first_name}}. We look forward to talking with you.' } };
}

export const ECO_CHAMPIONS: BuiltinBrand = {
  id: ECO_CHAMPIONS_BRAND_ID,
  name: 'Eco Champions',
  theme: ecoTheme(),
  emailFromName: 'Eco Champions',
  art: {
    logo: 'brand/eco-champions/logo.svg',
    favicon: 'brand/eco-champions/favicon.svg',
    faviconPng: 'brand/eco-champions/favicon-32.png',
    touchIcon: 'brand/eco-champions/apple-touch-icon.png',
    emailLogoAssetId: 'builtin_eco_champions_email',
    previewImage: { path: 'brand/eco-champions/og.png', width: 1200, height: 630, alt: 'Eco Champions logo with the words Book a conversation' },
  },
  closed: { title: 'Eco Champions is not taking bookings right now', text: 'Please check back soon.' },
};

export const BUILTIN_BRANDS: Record<BrandId, BuiltinBrand> = {
  brand_eco_champions: ECO_CHAMPIONS,
};

export const BRAND_IDS = Object.keys(BUILTIN_BRANDS) as BrandId[];

export function isBrandId(value: unknown): value is BrandId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BUILTIN_BRANDS, value);
}

/** The owner's stored changes to a brand, if any (the first entry with that id). */
export function storedBrand(site: Pick<SiteSettings, 'brands'> | null | undefined, id: BrandId): BrandSettings | null {
  const list = Array.isArray(site?.brands) ? site.brands : [];
  return list.find((b) => b && typeof b === 'object' && b.id === id) ?? null;
}

/**
 * The brand of an event type or a booking, merged with the owner's stored changes; null for the owner's own
 * look (also for an unknown id). Its clock and week follow the owner's own theme, so a message about an Eco
 * Champions meeting writes times exactly as one about the owner's own meetings does.
 */
export function brandOf(site: Pick<SiteSettings, 'brands' | 'theme'>, holder: { brandId?: string | null } | null | undefined): Brand | null {
  const id = holder?.brandId;
  if (!isBrandId(id)) return null;
  const builtin = BUILTIN_BRANDS[id];
  const stored = storedBrand(site, id);
  const theme = resolveTheme(builtin.theme, stored?.theme && typeof stored.theme === 'object' ? stored.theme : null);
  theme.timeFormat = site.theme?.timeFormat ?? DEFAULT_THEME.timeFormat;
  theme.weekStart = site.theme?.weekStart ?? DEFAULT_THEME.weekStart;
  const sender = typeof stored?.emailFromName === 'string' ? stored.emailFromName.trim() : '';
  return { ...builtin, theme, emailFromName: sender || builtin.emailFromName };
}

/** The site settings as a brand shows them. A separate type, marked so it can never be saved. */
export interface SiteView extends SiteSettings {
  readonly brandViewOf: BrandId;
}

/** True for a brand view (also for a copy of one: the mark is a plain field). */
export function isSiteView(site: unknown): site is SiteView {
  return !!site && typeof site === 'object' && 'brandViewOf' in site && (site as { brandViewOf?: unknown }).brandViewOf !== undefined;
}

/**
 * The site settings with the brand laid over them: the brand's name as the profile, its look and its sender
 * name. The provider, from address and reply-to, the consent wording, the assistant and everything else stay
 * the site's. Throws when given a view already (a brand on a brand).
 */
export function siteForBrand(site: SiteSettings & { brandViewOf?: never }, brand: Brand): SiteView {
  if (isSiteView(site)) throw new Error('siteForBrand: the site settings are already a brand view');
  return {
    ...site,
    brandViewOf: brand.id,
    profile: { name: brand.name, headline: '', welcome: '', avatarAssetId: null, links: [] },
    theme: brand.theme,
    email: { ...site.email, fromName: brand.emailFromName.trim() || brand.name },
  };
}

/** siteForBrand(site, brandOf(site, holder)), or `site` itself for the owner's own look. */
export function viewFor(site: SiteSettings & { brandViewOf?: never }, holder: { brandId?: string | null } | null | undefined): SiteSettings | SiteView {
  const brand = brandOf(site, holder);
  return brand ? siteForBrand(site, brand) : site;
}

/** The brand a view shows, or null for the site's own settings. */
export function brandOfView(site: SiteSettings): Brand | null {
  if (!isSiteView(site)) return null;
  return brandOf(site, { brandId: site.brandViewOf });
}

/** The event colour to apply: none while a brand is shown (everything on a branded page is the brand's). */
export function eventColorFor(eventType: { color?: string } | null | undefined, brand: Brand | null): string | undefined {
  if (brand) return undefined;
  const color = eventType?.color;
  return typeof color === 'string' && color !== '' ? color : undefined;
}

/** "Meeting with Jimi" + "Jimi Cohen" → "Meeting with Jimi"; "Intro call" + "Jimi Cohen" → "Intro call with Jimi Cohen". */
export function pageTitle(eventTitle: string, name: string): string {
  const title = (eventTitle ?? '').trim();
  const who = (name ?? '').trim();
  if (!who) return title;
  if (!title) return who;
  const first = who.split(/\s+/)[0].toLowerCase();
  const words = title.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  // The title already names the person or the brand: "Meeting with Jimi", "Eco Champions conversation".
  if (title.toLowerCase().includes(who.toLowerCase()) || words.includes(first)) return title;
  return `${title} with ${who}`;
}

/**
 * Where a booking can be made again: the short address when a link opens its event type now and shows the
 * look the booking was made in, else the event's own page.
 */
export function bookUrlFor(publicBaseUrl: string, site: Pick<SiteSettings, 'shortLinks'>, booking: { eventTypeId: string; eventSlug: string; brandId?: string | null }): string {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const name = shortNameFor(site, booking.eventTypeId);
  const bookedIn = isBrandId(booking.brandId) ? booking.brandId : null;
  if (name && SHORT_LINKS[name].brandId === bookedIn) return shortUrlOf(base, name);
  return `${base}/${encodeURIComponent(booking.eventSlug)}`;
}

/** "Booked through Eco Champions: https://jimicohen.com/pod". null for the owner's own look. */
export function brandLine(view: SiteSettings, bookUrl: string): string | null {
  if (!isSiteView(view)) return null;
  const name = (view.profile?.name ?? '').trim();
  return name ? `Booked through ${name}: ${bookUrl}` : null;
}
