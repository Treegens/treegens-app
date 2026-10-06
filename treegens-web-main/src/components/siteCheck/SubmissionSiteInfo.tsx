'use client'

import cn from 'classnames'
import Link from 'next/link'
import { HiChevronRight } from 'react-icons/hi2'
import { buildSiteReviewPath } from '@/config/appConfig'
import { speciesLabel } from '@/modules/siteCheck/speciesLabels'
import type { ISubmissionSiteCheck } from '@/types'
import { formatDistance } from '@/utils/geo'
import { VerdictChip } from './VerdictChip'

type Props = {
  siteId?: string
  siteCheck?: ISubmissionSiteCheck
  species?: string[]
  className?: string
}

/**
 * The API measures 0 m for a clip filmed inside the boundary, else the
 * distance to its edge; `insideSite` also allows a GPS tolerance, so a
 * positive distance always means the clip was filmed outside the boundary.
 */
function place(insideSite: boolean, distanceM = 0) {
  if (distanceM <= 0) {
    return { text: 'inside the site', className: 'text-green-800' }
  }
  if (insideSite) {
    return {
      text: `${formatDistance(distanceM)} outside the edge (within GPS tolerance)`,
      className: 'text-amber-800',
    }
  }
  return {
    text: `${formatDistance(distanceM)} outside the site`,
    className: 'text-red-700',
  }
}

/** Where each clip was filmed, for the clips the snapshot measured. */
function clipPlaces(siteCheck?: ISubmissionSiteCheck) {
  if (!siteCheck) return []
  const clips: [string, boolean | undefined, number | undefined][] = [
    ['Before video', siteCheck.insideSite, siteCheck.distanceToSiteM],
    [
      'Planting video',
      siteCheck.plantInsideSite,
      siteCheck.plantDistanceToSiteM,
    ],
  ]
  return clips.flatMap(([label, inside, distanceM]) =>
    inside == null ? [] : [{ label, ...place(inside, distanceM) }],
  )
}

/** Compact Site Check chip and species names for a submission review. */
export function SubmissionSiteInfo({
  siteId,
  siteCheck,
  species,
  className,
}: Props) {
  const id = siteId || siteCheck?.siteId
  if (!id && !species?.length) return null
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {id ? (
        <Link
          href={buildSiteReviewPath(id)}
          className="flex flex-row flex-wrap items-center gap-2 rounded-[14px] border border-neutral-200 bg-white px-3 py-2.5"
        >
          <span className="text-sm font-semibold text-[#2d2419]">
            Site Check
          </span>
          <VerdictChip code={siteCheck?.verdictCode} />
          {clipPlaces(siteCheck).map(clip => (
            <span
              key={clip.label}
              className={cn('text-xs font-medium', clip.className)}
            >
              {clip.label}: {clip.text}
            </span>
          ))}
          <HiChevronRight
            className="ml-auto h-5 w-5 text-[#4d341e]"
            aria-hidden
          />
        </Link>
      ) : null}
      {species?.length ? (
        <p className="text-sm text-[#4d341e]">
          <span className="font-semibold">Species: </span>
          {species.map(speciesLabel).join(', ')}
        </p>
      ) : null}
    </div>
  )
}
