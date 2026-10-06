'use client'

import { HiGlobeAlt } from 'react-icons/hi2'
import {
  HYDROLOGY_CLASS_STYLES,
  HYDROLOGY_STATUS_LABELS,
} from '@/modules/siteCheck/verdictStyle'
import type { ISiteHydrology } from '@/types'

/** "Satellite: Tide looks right" or "Satellite: Checking", for list rows. */
export function SatelliteStatusLine({
  hydrology,
}: {
  hydrology?: ISiteHydrology | null
}) {
  const status = hydrology?.status ?? 'not_started'
  const label =
    status === 'completed' && hydrology?.result
      ? HYDROLOGY_CLASS_STYLES[hydrology.result.hydrologyClass].label
      : HYDROLOGY_STATUS_LABELS[status]
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-600">
      <HiGlobeAlt className="h-4 w-4 text-gray-500" aria-hidden />
      Satellite: {label}
    </span>
  )
}
