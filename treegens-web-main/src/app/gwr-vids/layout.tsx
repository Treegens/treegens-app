import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'GWR record · Videos',
  description:
    'Every after-clip filmed at the Guinness World Record attempt, ready to download.',
  robots: { index: false, follow: false },
}

export default function GwrVidsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
