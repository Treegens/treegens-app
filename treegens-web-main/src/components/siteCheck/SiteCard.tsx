'use client'

import type { ISiteDoc } from '@/types'
import { formatArea } from '@/utils/geo'
import { formatTimeAgo } from '@/utils/timeAgo'
import { SatelliteStatusLine } from './SatelliteStatusLine'
import { SiteStatusPill } from './SiteStatusPill'
import { VerdictChip } from './VerdictChip'

type Props = { site: ISiteDoc; onClick: () => void }

export function siteLocationText(site: ISiteDoc) {
  if (site.reverseGeocode) return site.reverseGeocode
  const { latitude, longitude } = site.center ?? {}
  if (latitude == null || longitude == null) return ''
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
}

/** One site in a list: name, verdict, review status and satellite state. */
export function SiteCard({ site, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-2xl border border-[#e5e7eb] bg-white p-4 text-left shadow-sm shadow-black/5 transition-opacity hover:opacity-95 active:scale-[0.99]"
    >
      <div className="flex flex-row items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-bold text-[#111827]">
            {site.name}
          </p>
          <p className="truncate text-xs text-gray-500">
            {siteLocationText(site)}
          </p>
        </div>
        <SiteStatusPill status={site.status} />
      </div>
      <div className="mt-3 flex flex-row flex-wrap items-center gap-2">
        <VerdictChip code={site.verdict?.code} />
        <SatelliteStatusLine hydrology={site.hydrology} />
      </div>
      <p className="mt-2 text-xs text-gray-500">
        {formatArea(site.areaM2)} · Added {formatTimeAgo(site.createdAt)}
      </p>
    </button>
  )
}
