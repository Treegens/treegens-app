'use client'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { routes } from '@/config/appConfig'

/**
 * The universal "you" glyph: head and shoulders cut off by the circle. It
 * replaced the address-derived Blobbie, which read as a coloured ball rather
 * than a way into your profile.
 */
const ProfileSilhouette = () => (
  <svg viewBox="0 0 36 36" className="h-full w-full" aria-hidden>
    <circle cx="18" cy="18" r="18" fill="#eef4dc" />
    <circle cx="18" cy="14" r="6.5" fill="#6b8c3b" />
    <path
      d="M4.5 33.5C6.5 26.5 11.8 22.5 18 22.5S29.5 26.5 31.5 33.5A18 18 0 0 1 4.5 33.5Z"
      fill="#6b8c3b"
    />
  </svg>
)

/** Matches `mobile/components/ui/home/Header.tsx`: logo + profile. */
export const AppHeader = () => {
  const router = useRouter()

  return (
    <header className="sticky top-0 z-50 flex flex-row items-center justify-between bg-white px-4 py-3">
      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full">
        <Image
          src="/img/treegens-logo.svg"
          alt="Treegens"
          fill
          className="object-cover"
          sizes="40px"
          priority
        />
      </div>

      <div className="flex flex-row items-center gap-4">
        <button
          type="button"
          onClick={() => router.push(routes.Profile)}
          className="block h-9 w-9 shrink-0 overflow-hidden rounded-full leading-none ring-2 ring-[#6b8c3b] ring-offset-2 ring-offset-white"
          aria-label="Profile"
          title="Profile"
        >
          <ProfileSilhouette />
        </button>
      </div>
    </header>
  )
}
