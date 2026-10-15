'use client'

import cn from 'classnames'
import { HiSignal } from 'react-icons/hi2'
import { WALK_MAX_ACCURACY_M } from '@/modules/siteCheck/siteForm'

/** "GPS ±6 m": green when good enough to map a boundary, amber when not. */
export function GpsAccuracy({ accuracy }: { accuracy: number | null }) {
  if (accuracy == null) return null
  const good = accuracy <= WALK_MAX_ACCURACY_M
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold',
        good ? 'bg-green-100 text-green-900' : 'bg-amber-100 text-amber-900',
      )}
    >
      <HiSignal className="h-4 w-4" aria-hidden />
      GPS ±{Math.round(accuracy)} m{good ? '' : ', weak'}
    </span>
  )
}
