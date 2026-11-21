import './globals.css';
import './styles/editor.css';
import './styles/sign.css';
import './styles/sender.css';
import './styles/settings.css';
import './styles/public.css';
import './styles/support.css';
import './styles/checks.css';
import './styles/abroad.css';
import './styles/qr.css';
import './styles/signphone.css';
import './styles/tplroles.css';
import './styles/groups.css';
import './styles/twostep.css';
import './styles/clickwrap.css';
import './styles/comments.css';
import './styles/witness.css';
import './styles/stamps.css';
import './styles/chat.css';
import './styles/seclog.css';
import './styles/retention.css';
import './styles/customfields.css';
import './styles/simplesign.css';
import './styles/start.css';
import './styles/impact.css';
// After globals.css, so its --serif (Lora first) wins. Keep it the last style import.
import './styles/brand.css';
import type { Metadata, Viewport } from 'next';
import { siteBase, SITE_TITLE } from '@/lib/site';
import { Toasts } from '@/components/ui';
import { headers } from 'next/headers';
import { chooseLocale, dir } from '@/lib/i18n';

export const metadata: Metadata = {
  title: { default: SITE_TITLE, template: '%s · GrowSigning' },
  description: 'Send, sign and manage documents without paper. Every dollar plants 10 mangrove trees with Treegens.',
  // The icons, the link preview picture and its alt text are files in src/app (favicon.ico, icon.svg, apple-icon.png,
  // opengraph-image.png, opengraph-image.alt.txt), copied from the brand kit by scripts/build-brand.mjs; Next writes
  // their tags. The preview's address is absolute, from APP_URL (src/lib/site.ts).
  metadataBase: siteBase(),
  twitter: { card: 'summary_large_image' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#134a2c' };

// The language of the page and its direction, from what the browser asks for among the languages switched on, else
// English (src/lib/i18n.ts). Only English is switched on, so today this is lang="en" dir="ltr" everywhere. The signing
// page sets its signer's own language when its words are translated (lang-signing).
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = chooseLocale({ acceptLanguage: (await headers()).get('accept-language') });
  return (
    <html lang={lang} dir={dir(lang)}>
      <body>
        {children}
        <Toasts />
      </body>
    </html>
  );
}
