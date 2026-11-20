import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Toasts } from '@/components/ui';

export const metadata: Metadata = {
  title: { default: 'Treegens Sign · e-signatures that plant trees', template: '%s · Treegens Sign' },
  description: 'Send, sign and manage documents without paper. 100% of subscription revenue goes to Treegens tree planting.',
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
