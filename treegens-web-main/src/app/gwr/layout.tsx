import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'GWR record · After video',
  description:
    'Film the trees planted at the Guinness World Record attempt and hand in your clip. No account needed.',
  robots: { index: false, follow: false },
}

export default function GwrLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
