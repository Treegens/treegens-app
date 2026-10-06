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

function placeText(siteCheck: ISubmissionSiteCheck) {
  const distance = siteCheck.distanceToSiteM ?? 0
  if (siteCheck.insideSite) {
    return distance > 0
      ? `Inside the site (${formatDistance(distance)} from the edge)`
      : 'Inside the site'
  }
  return `${formatDistance(distance)} outside the site`
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
          {siteCheck?.insideSite != null ? (
            <span
              className={cn(
                'text-xs font-medium',
                siteCheck.insideSite ? 'text-green-800' : 'text-red-700',
              )}
            >
              {placeText(siteCheck)}
            </span>
          ) : null}
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
