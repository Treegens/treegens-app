/**
 * Short links: root addresses on the public domain that open one booking calendar straight away.
 *
 *   jimicohen.com/meet   a meeting with Jimi alone, in his own look
 *   jimicohen.com/pod    the Eco Champions conversation: Jimi and every co-host on it, in the Eco Champions look
 *
 * Which event type each one opens lives in the site settings (`site.shortLinks`). The page head of each
 * link (title, description, link preview, icons, the colours before the app has data) is fixed here,
 * because the build writes it into a static page (scripts/shortPages.ts): link previews do not run scripts.
 *
 * Adding a name takes four edits: SHORT_LINK_NAMES and SHORT_LINKS below, the two blocks per name in
 * netlify.toml, and the lines in the jimicohen.com `_redirects` file (README). tests/unit/shortlinks.test.ts
 * ties the first three together.
 */
import type { BrandId, ShortName, SiteSettings } from './types';

export type { ShortName };

/** Root paths on the public domain that jimicohen.com proxies to this app. */
export const SHORT_LINK_NAMES: readonly ShortName[] = ['meet', 'pod'];

/** The public origin every preview URL points at: the origin of the production PUBLIC_BASE_URL. */
export const PUBLIC_ORIGIN = 'https://jimicohen.com';

export interface ShortLinkSpec {
  /** the brand of this link's page head, loading screen and closed page; null = Jimi's own look */
  brandId: BrandId | null;
  /** <title>, og:title, twitter:title */
  title: string;
  /** description, og:description, twitter:description; at most 200 characters */
  description: string;
  /** og:site_name */
  siteName: string;
  /** a PNG, its path below PUBLIC_ORIGIN */
  image: { path: string; width: number; height: number; alt: string };
  /** paths below PUBLIC_ORIGIN */
  icons: { svg: string; png32: string | null; touch: string | null };
  /** the page background before the app has data */
  boot: { bg: string; scheme: 'light' | 'dark' };
}

export const SHORT_LINKS: Record<ShortName, ShortLinkSpec> = {
  meet: {
    brandId: null,
    title: 'Meet with Jimi',
    description: 'Pick a time to talk with Jimi Cohen, Host of the Eco Champions podcast and Founder of Treegens. It goes straight into his calendar.',
    siteName: 'Jimi Cohen',
    image: { path: '/meeting/og/meet.png', width: 1200, height: 630, alt: 'Photo of Jimi Cohen with the words Meet with Jimi' },
    icons: { svg: '/meeting/favicon.svg', png32: null, touch: null },
    boot: { bg: '#0b1d14', scheme: 'dark' },
  },
  pod: {
    brandId: 'brand_eco_champions',
    title: 'Eco Champions conversation',
    description:
      'A conversation with the hosts of Eco Champions, the podcast interviewing the forces of nature on climate and sustainability. Pick a time when the hosts are all free.',
    siteName: 'Eco Champions',
    image: { path: '/meeting/brand/eco-champions/og.png', width: 1200, height: 630, alt: 'Eco Champions logo with the words Book a conversation' },
    icons: {
      svg: '/meeting/brand/eco-champions/favicon.svg',
      png32: '/meeting/brand/eco-champions/favicon-32.png',
      touch: '/meeting/brand/eco-champions/apple-touch-icon.png',
    },
    boot: { bg: '#FAF5E6', scheme: 'light' },
  },
};

export function isShortName(value: unknown): value is ShortName {
  return typeof value === 'string' && (SHORT_LINK_NAMES as readonly string[]).includes(value);
}

/** "/pod", "/pod/", "/pod/x" → "pod". "/meeting/pod", "/pods", "/POD", "/" → null. Case matters, as on jimicohen.com. */
export function shortNameOfPath(pathname: string): ShortName | null {
  const m = /^\/([a-z][a-z0-9-]{1,30})(?:\/.*)?$/.exec(typeof pathname === 'string' ? pathname : '');
  return m && isShortName(m[1]) ? m[1] : null;
}

function originOf(publicBaseUrl: string): string {
  try {
    return new URL(publicBaseUrl).origin;
  } catch {
    return PUBLIC_ORIGIN;
  }
}

/** ("https://jimicohen.com/meeting", "pod") → "https://jimicohen.com/pod": the origin of PUBLIC_BASE_URL plus the name. */
export function shortUrlOf(publicBaseUrl: string, name: ShortName): string {
  return `${originOf(publicBaseUrl)}/${name}`;
}

/** "jimicohen.com/pod", for screens. */
export function shortLabelOf(publicBaseUrl: string, name: ShortName): string {
  try {
    return `${new URL(publicBaseUrl).host}/${name}`;
  } catch {
    return `jimicohen.com/${name}`;
  }
}

/** The event type id a link opens according to the site settings, or null (never set, turned off). */
export function shortLinkTarget(site: Pick<SiteSettings, 'shortLinks'> | null | undefined, name: ShortName): string | null {
  const id = site?.shortLinks?.[name];
  return typeof id === 'string' && id !== '' ? id : null;
}

/** The first short link that opens this event type, or null. */
export function shortNameFor(site: Pick<SiteSettings, 'shortLinks'> | null | undefined, eventTypeId: string | null | undefined): ShortName | null {
  if (!eventTypeId) return null;
  return SHORT_LINK_NAMES.find((name) => shortLinkTarget(site, name) === eventTypeId) ?? null;
}
