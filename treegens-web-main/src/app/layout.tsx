import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import { Toaster } from 'react-hot-toast'
import { AuthGuard } from '@/components/AuthGuard'
import { MobileAppShell } from '@/components/Layout/MobileAppShell'
import { DesktopMobileOnlyGate } from '@/components/Layout/DesktopMobileOnlyGate'
import { SiteJsonLd } from '@/components/seo/SiteJsonLd'
import { ThirdwebAutoConnect } from '@/components/providers/ThirdwebAutoConnect'
import { TreeGensThirdwebProvider } from '@/components/providers/TreeGensThirdwebProvider'
import PWAInstaller from '@/components/PWAInstaller'
import { siteMeta } from '@/config/siteMeta'
import { AuthProvider } from '@/contexts/AuthProvider'
import { ConnectivityProvider } from '@/contexts/ConnectivityProvider'
import { NotificationProvider } from '@/contexts/NotificationProvider'
import { UserProvider } from '@/contexts/UserProvider'
import './globals.css'

// Inter is latin-only. Amharic (the planting rules, the species guide) falls
// back to the self-hosted Noto Sans Ethiopic declared in globals.css; many
// field Androids have no Ethiopic font of their own and show it blank. Set
// here because next/font puts the whole font-family on the body's class.
const inter = Inter({ subsets: ['latin'], fallback: ['Noto Sans Ethiopic'] })

const googleVerify = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION?.trim()

export const metadata: Metadata = {
  metadataBase: new URL(siteMeta.url),
  title: {
    default: `${siteMeta.name} — ${siteMeta.shortTitle}`,
    template: `%s · ${siteMeta.name}`,
  },
  description: siteMeta.description,
  applicationName: siteMeta.name,
  keywords: [...siteMeta.keywords],
  authors: [{ name: siteMeta.name, url: siteMeta.url }],
  creator: siteMeta.name,
  publisher: siteMeta.name,
  category: 'environment',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  openGraph: {
    type: 'website',
    locale: siteMeta.locale,
    url: siteMeta.url,
    siteName: siteMeta.name,
    title: siteMeta.ogTitle,
    description: siteMeta.seoSnippet,
  },
  twitter: {
    card: 'summary_large_image',
    title: siteMeta.ogTitle,
    description: siteMeta.seoSnippet,
    creator: siteMeta.twitterHandle,
    site: siteMeta.twitterHandle,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  alternates: {
    canonical: '/',
  },
  ...(googleVerify
    ? { verification: { google: googleVerify } }
    : {}),
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: siteMeta.name,
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: siteMeta.themeColor,
  colorScheme: 'light',
}

const RootLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <html lang="en">
      <head>
        <SiteJsonLd />
      </head>
      <body className={inter.className}>
        <TreeGensThirdwebProvider>
          <ThirdwebAutoConnect />
          <ConnectivityProvider>
            <AuthProvider>
              <UserProvider>
                <NotificationProvider>
                  <AuthGuard>
                    <PWAInstaller />
                    <MobileAppShell>{children}</MobileAppShell>
                    <DesktopMobileOnlyGate />
                  </AuthGuard>
                </NotificationProvider>
              </UserProvider>
            </AuthProvider>
          </ConnectivityProvider>
        </TreeGensThirdwebProvider>
        <Toaster
          position="top-center"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#363636',
              color: '#fff',
            },
          }}
        />
      </body>
    </html>
  )
}

export default RootLayout
