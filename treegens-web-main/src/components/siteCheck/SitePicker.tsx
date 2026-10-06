'use client'

import cn from 'classnames'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { HiPlus } from 'react-icons/hi2'
import { Spinner } from '@/components/ui/Spinner'
import { routes } from '@/config/appConfig'
import { useConnectivity } from '@/contexts/ConnectivityProvider'
import { listMySites } from '@/services/siteService'
import type { ISiteDoc } from '@/types'
import { apiErrorMessage } from '@/utils/apiErrorMessage'
import { ChoiceChip } from './ChoiceChip'
import { siteLocationText } from './SiteCard'
import { SiteStatusPill } from './SiteStatusPill'
import { VerdictChip } from './VerdictChip'

/** leaveWarning for a page holding a recorded video that is not sent yet */
export const UNSENT_VIDEO_LEAVE_WARNING =
  'Leave this page? The video you recorded is not sent yet and will be lost.'

type Props = {
  value: string
  onChange: (siteId: string, site: ISiteDoc | null) => void
  /**
   * Asked before "Check a new site" leaves the page, when leaving would
   * lose unsaved work (a recorded video lives only in memory).
   */
  leaveWarning?: string
}

/** Approved "plant here" sites first, then approved, in review, drafts. */
function plantingRank(site: ISiteDoc) {
  if (site.status === 'approved') return site.verdict?.code === 'plant' ? 0 : 1
  if (site.status === 'pending_review') return 2
  return site.status === 'draft' ? 3 : 4
}

function SiteOption({
  site,
  selected,
  onSelect,
}: {
  site: ISiteDoc
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex w-full flex-row items-start gap-2.5 rounded-xl border-2 px-3 py-3 text-left transition-colors',
        selected
          ? 'border-tree-green-2 bg-[#E8F7ED]'
          : 'border-gray-200 bg-white',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
          selected ? 'border-tree-green-2 bg-tree-green-2' : 'border-gray-300',
        )}
        aria-hidden
      >
        {selected ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-gray-900">
          {site.name}
        </span>
        <span className="block truncate text-xs text-gray-500">
          {siteLocationText(site)}
        </span>
        <span className="mt-2 flex flex-row flex-wrap gap-1.5">
          <VerdictChip code={site.verdict?.code} />
          <SiteStatusPill status={site.status} />
        </span>
      </span>
    </button>
  )
}

/** Lets a planter link a planting to one of their checked sites. */
export function SitePicker({ value, onChange, leaveWarning }: Props) {
  const { isUserOnline } = useConnectivity()
  const [sites, setSites] = useState<ISiteDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data } = await listMySites(1, 50)
      const list = data.data.sites ?? []
      setSites([...list].sort((a, b) => plantingRank(a) - plantingRank(b)))
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not load your sites.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isUserOnline) void load()
    else setLoading(false)
  }, [isUserOnline, load])

  return (
    <div className="flex flex-col gap-2">
      {loading ? (
        <div className="flex justify-center py-3">
          <Spinner size="sm" />
        </div>
      ) : !isUserOnline ? (
        <p className="text-sm text-gray-500">
          You are offline. Connect to choose a site.
        </p>
      ) : error ? (
        <button
          type="button"
          onClick={() => void load()}
          className="text-left text-sm text-red-600 underline"
        >
          {error} Tap to try again.
        </button>
      ) : (
        sites.map(site => (
          <SiteOption
            key={site._id}
            site={site}
            selected={value === site._id}
            onSelect={() => onChange(site._id, site)}
          />
        ))
      )}
      <ChoiceChip selected={!value} onClick={() => onChange('', null)}>
        No site / not mangroves
      </ChoiceChip>
      <Link
        href={routes.NewSite}
        onClick={e => {
          if (leaveWarning && !window.confirm(leaveWarning)) e.preventDefault()
        }}
        className="mt-1 inline-flex min-h-11 items-center gap-1.5 self-start rounded-full px-1 text-sm font-semibold text-tree-green-2"
      >
        <HiPlus className="h-5 w-5" aria-hidden />
        Check a new site
      </Link>
    </div>
  )
}
