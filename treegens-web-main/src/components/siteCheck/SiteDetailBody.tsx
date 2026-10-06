'use client'

import { hydrologySummaryOf } from '@/modules/siteCheck/siteForm'
import { computeSiteVerdict } from '@/modules/siteCheck/siteVerdict'
import type { ISiteDoc, SitePhotoKind } from '@/types'
import { formatArea } from '@/utils/geo'
import { formatTimeAgo } from '@/utils/timeAgo'
import { ReasonList } from './ReasonList'
import { SatelliteSummary } from './SatelliteSummary'
import { SiteAnswersSummary } from './SiteAnswersSummary'
import { siteLocationText } from './SiteCard'
import { SitePhotos } from './SitePhotos'
import { SiteStatusPill } from './SiteStatusPill'
import { SpeciesList } from './SpeciesList'
import { VerdictCard } from './VerdictCard'

type Props = {
  site: ISiteDoc
  onRecheck?: () => void
  rechecking?: boolean
  onPickPhoto?: (kind: SitePhotoKind, file: File) => void
  uploading?: { kind: SitePhotoKind; percent: number } | null
}

/** The stored verdict, or one worked out here for older records. */
export function verdictOfSite(site: ISiteDoc) {
  return (
    site.verdict ??
    computeSiteVerdict({
      answers: site.answers ?? {},
      hydrology: hydrologySummaryOf(site.hydrology),
      countryCode: site.countryCode,
    })
  )
}

function SiteHeading({ site }: { site: ISiteDoc }) {
  const method =
    site.boundaryMethod === 'walked'
      ? 'Walked boundary'
      : `Circle of ${site.radiusM ?? 0} m`
  return (
    <div>
      <div className="flex flex-row items-start justify-between gap-2">
        <h2 className="min-w-0 break-words text-2xl font-bold text-[#1a2610]">
          {site.name}
        </h2>
        <SiteStatusPill status={site.status} />
      </div>
      <p className="mt-1 text-sm text-gray-600">{siteLocationText(site)}</p>
      <p className="mt-1 text-xs text-gray-500">
        {formatArea(site.areaM2)} · {method} · Added{' '}
        {formatTimeAgo(site.createdAt)}
      </p>
    </div>
  )
}

function ReviewStatus({ site }: { site: ISiteDoc }) {
  const votes = site.votes ?? []
  const yes = votes.filter(v => v.vote === 'yes').length
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <h3 className="mb-2 text-base font-bold text-gray-900">Review</h3>
      <div className="flex flex-row flex-wrap items-center gap-2 text-sm text-gray-700">
        <SiteStatusPill status={site.status} />
        {site.status === 'draft' ? (
          <span>Not sent for review yet.</span>
        ) : (
          <span>
            {votes.length} vote{votes.length === 1 ? '' : 's'}: {yes} yes,{' '}
            {votes.length - yes} no
          </span>
        )}
      </div>
    </section>
  )
}

/** Everything about a site; shared by the owner and verifier pages. */
export function SiteDetailBody({
  site,
  onRecheck,
  rechecking,
  onPickPhoto,
  uploading,
}: Props) {
  const verdict = verdictOfSite(site)
  return (
    <div className="flex flex-col gap-4">
      <SiteHeading site={site} />
      <VerdictCard verdict={verdict} />
      <SpeciesList
        zone={verdict.recommendedZone}
        speciesIds={verdict.recommendedSpeciesIds}
      />
      <section className="rounded-2xl border border-gray-200 bg-white p-4">
        <h3 className="mb-3 text-base font-bold text-gray-900">Why</h3>
        <ReasonList reasons={verdict.reasons} />
      </section>
      <SatelliteSummary
        hydrology={site.hydrology}
        onRecheck={onRecheck}
        rechecking={rechecking}
      />
      <SitePhotos
        photos={site.photos ?? []}
        onPick={onPickPhoto}
        uploading={uploading}
      />
      <SiteAnswersSummary answers={site.answers ?? {}} />
      <ReviewStatus site={site} />
    </div>
  )
}
