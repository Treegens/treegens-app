'use client'

import Link from 'next/link'
import { HiChevronRight, HiMapPin } from 'react-icons/hi2'
import { routes } from '@/config/appConfig'

/** Home page entry to Site Check, shown next to the Plant trees call. */
export function SiteCheckPromoCard() {
  return (
    <Link
      href={routes.Sites}
      className="flex flex-row items-center gap-4 rounded-3xl border border-[#435F24]/15 bg-white/90 p-5 shadow-[0_12px_40px_rgba(30,15,8,0.08)] transition-transform active:scale-[0.98]"
    >
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#E8F7ED]">
        <HiMapPin className="h-7 w-7 text-tree-green-2" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-bold text-[#1a2610]">
          Check your site before planting
        </span>
        <span className="mt-0.5 block text-sm text-[#5c534a]">
          Mangroves only live in the right spot. Answer a few questions first.
        </span>
      </span>
      <HiChevronRight className="h-5 w-5 shrink-0 text-brown-2" aria-hidden />
    </Link>
  )
}
