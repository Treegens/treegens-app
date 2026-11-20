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
import './styles/comments.css';
import type { Metadata, Viewport } from 'next';
import { Toasts } from '@/components/ui';

export const metadata: Metadata = {
  title: { default: 'Sign&Grow · e-signatures that plant trees', template: '%s · Sign&Grow' },
  description: 'Send, sign and manage documents without paper. Every dollar plants 10 mangrove trees with Treegens.',
  icons: { icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%231f6f43' d='M2 22C2 9 10 2 22 2c0 12-7 20-20 20Z'/%3E%3C/svg%3E" },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#134a2c' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toasts />
      </body>
    </html>
  );
}
