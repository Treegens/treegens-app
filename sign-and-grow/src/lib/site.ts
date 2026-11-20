// The public address of this app as the page head needs it, and the web app manifest. Shared by src/app/layout.tsx,
// src/app/manifest.ts and tests/brand.test.ts. Nothing here reads a request: a Host header can be forged, so only
// APP_URL names the address (the same rule as baseUrl() in src/server/util.ts, which pages may not import).

import { COLORS } from './brandMark.ts';

/** The product's name as it is written in a sentence, a title or an email. The drawn logo writes it "growsigning". */
export const PRODUCT = 'GrowSigning';

/** Where link previews point. APP_URL when it is a usable http or https address, else this machine during development, so
 * a mistyped APP_URL gives previews with the wrong address instead of taking every page down with it. */
export function siteBase(appUrl: string | undefined = process.env.APP_URL): URL {
  try {
    const u = new URL(String(appUrl || '').trim());
    if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname) return new URL(u.origin);
  } catch {
    /* not an address: fall through */
  }
  return new URL('http://localhost:3000');
}

/** The alt text of the link preview picture (src/app/opengraph-image.png), also in src/app/opengraph-image.alt.txt. */
export const OG_ALT = 'GrowSigning: sign on screen. Every dollar plants mangroves.';

/** The web app manifest, served at /manifest.webmanifest by src/app/manifest.ts. */
export function webManifest() {
  return {
    name: PRODUCT,
    short_name: PRODUCT,
    description: 'Send, sign and keep agreements on screen. Every dollar paid plants mangrove trees with Treegens.',
    id: '/app',
    start_url: '/app',
    scope: '/',
    display: 'standalone' as const,
    background_color: COLORS.paper,
    theme_color: COLORS.deep,
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' as const },
    ],
  };
}
