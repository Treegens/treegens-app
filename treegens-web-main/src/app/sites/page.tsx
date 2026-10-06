'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { HiClipboardDocumentCheck, HiPlus } from 'react-icons/hi2'
import {
  IoCameraOutline,
  IoChatbubbleEllipsesOutline,
  IoWalkOutline,
} from 'react-icons/io5'
import { SiteCard } from '@/components/siteCheck/SiteCard'
import { SiteFlowHeader } from '@/components/siteCheck/SiteFlowHeader'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { buildSitePath, routes } from '@/config/appConfig'
import { useConnectivity } from '@/contexts/ConnectivityProvider'
import { useUser } from '@/contexts/UserProvider'
import { listMySites } from '@/services/siteService'
import type { ISiteDoc } from '@/types'
import { apiErrorMessage } from '@/utils/apiErrorMessage'
import {
  readSiteDraft,
  type SiteDraft,
  siteDraftHasContent,
} from '@/utils/siteDraftStore'
import { formatTimeAgo } from '@/utils/timeAgo'

const PAGE_SIZE = 20

const HOW_IT_WORKS = [
  { icon: IoWalkOutline, text: 'Walk around the site with your phone.' },
  {
    icon: IoChatbubbleEllipsesOutline,
    text: 'Answer short questions about the tide and the ground.',
  },
  { icon: IoCameraOutline, text: 'Take two photos at low tide.' },
]

function PauseBeforeYouPlant() {
  return (
    <section className="rounded-2xl border border-gray-200 bg-[#f7fbf3] p-5">
      <h2 className="text-xl font-bold text-[#1a2610]">
        Pause before you plant
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-gray-700">
        Most mangrove planting fails because the spot is wrong: too low, too
        high, or on seagrass and mudflats where mangroves never grew. Check the
        site first: go at low tide and allow about 15 minutes.
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {HOW_IT_WORKS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex flex-row items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white">
              <Icon className="h-6 w-6 text-tree-green-2" aria-hidden />
            </span>
            <span className="text-sm text-gray-800">{text}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function LocalDraftCard({ draft }: { draft: SiteDraft }) {
  return (
    <Link
      href={routes.NewSite}
      className="rounded-2xl border border-sky-200 bg-sky-50 p-4"
    >
      <p className="text-sm font-semibold text-sky-950">
        Unfinished site on this phone
      </p>
      <p className="mt-1 text-sm text-sky-900/90">
        {draft.name?.trim() || 'No name yet'}
        {draft.updatedAt ? ` · saved ${formatTimeAgo(draft.updatedAt)}` : ''}
      </p>
    </Link>
  )
}

export default function MySitesPage() {
  const router = useRouter()
  const { user } = useUser()
  const { isUserOnline } = useConnectivity()
  const [sites, setSites] = useState<ISiteDoc[]>([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [localDraft, setLocalDraft] = useState<SiteDraft | null>(null)

  useEffect(() => {
    const stored = readSiteDraft(user?.walletAddress ?? '')
    setLocalDraft(siteDraftHasContent(stored) ? stored : null)
  }, [user?.walletAddress])

  const loadPage = useCallback(async (next: number, append: boolean) => {
    const { data } = await listMySites(next, PAGE_SIZE)
    const list = data.data.sites ?? []
    setPages(data.data.pagination?.pages ?? 0)
    setPage(next)
    setSites(prev => (append ? [...prev, ...list] : list))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      await loadPage(1, false)
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not load your sites.'))
    } finally {
      setLoading(false)
    }
  }, [loadPage])

  useEffect(() => {
    if (user?._id) void load()
  }, [user?._id, load])

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      await loadPage(page + 1, true)
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not load more sites.'))
    } finally {
      setLoadingMore(false)
    }
  }

  const reviewButton = user?.isVerifier ? (
    <button
      type="button"
      onClick={() => router.push(routes.SitesReview)}
      className="rounded-md p-1 text-[#111] hover:bg-gray-100"
      aria-label="Sites to review"
    >
      <HiClipboardDocumentCheck className="h-6 w-6" />
    </button>
  ) : undefined

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <SiteFlowHeader title="My sites" right={reviewButton} />
      <main className="flex flex-col gap-4 px-5 pb-10 pt-4">
        <Link
          href={routes.NewSite}
          className="tg-cta inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-black uppercase tracking-wide text-[#16210c]"
        >
          <HiPlus className="h-5 w-5" aria-hidden />
          Check a new site
        </Link>
        {localDraft ? <LocalDraftCard draft={localDraft} /> : null}
        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : error && !sites.length ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <p className="text-center text-sm text-red-600">
              {isUserOnline
                ? error
                : 'You are offline. Connect to see your sites.'}
            </p>
            <Button color="success" pill onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : sites.length ? (
          <>
            <ul className="flex flex-col gap-3">
              {sites.map(site => (
                <li key={site._id}>
                  <SiteCard
                    site={site}
                    onClick={() => router.push(buildSitePath(site._id))}
                  />
                </li>
              ))}
            </ul>
            {page < pages ? (
              <Button
                outline
                color="gray"
                className="self-center rounded-full"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            ) : null}
          </>
        ) : (
          <PauseBeforeYouPlant />
        )}
      </main>
    </div>
  )
}
