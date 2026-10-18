'use client'

import cn from 'classnames'
import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { HiArrowLeft, HiArrowPath } from 'react-icons/hi2'

type Props = {
  title: string
  /** Shows a refresh button on the right */
  onRefresh?: () => void
  refreshing?: boolean
  /** Any other control on the right */
  right?: ReactNode
  /** Warm background of the verifier pages */
  verifier?: boolean
}

/** Sticky back / title header used by the Site Check pages. */
export function SiteFlowHeader({
  title,
  onRefresh,
  refreshing,
  right,
  verifier,
}: Props) {
  const router = useRouter()
  const refresh = onRefresh ? (
    <button
      type="button"
      onClick={onRefresh}
      className="rounded-md p-1 text-[#111] hover:bg-gray-100"
      aria-label="Refresh"
    >
      <HiArrowPath className={cn('h-5 w-5', refreshing && 'animate-spin')} />
    </button>
  ) : null
  return (
    <header
      className={cn(
        'sticky top-0 z-10 flex flex-row items-center justify-between gap-2 border-b px-4 py-2',
        verifier
          ? 'border-neutral-200/80 bg-[#f6f1ea]'
          : 'border-gray-100 bg-white',
      )}
    >
      <button
        type="button"
        onClick={() => router.back()}
        className="rounded-md p-1 text-[#111] hover:bg-gray-100"
        aria-label="Back"
      >
        <HiArrowLeft className="h-6 w-6" />
      </button>
      <h1 className="truncate text-[20px] font-bold text-[#111]">{title}</h1>
      {right ?? refresh ?? <span className="w-8 shrink-0" aria-hidden />}
    </header>
  )
}
