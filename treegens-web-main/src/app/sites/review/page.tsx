'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { SiteCard } from '@/components/siteCheck/SiteCard'
import { SiteFlowHeader } from '@/components/siteCheck/SiteFlowHeader'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { appConfig, buildSiteReviewPath } from '@/config/appConfig'
import { useUser } from '@/contexts/UserProvider'
import { listSiteModeration } from '@/services/siteService'
import type { ISiteDoc } from '@/types'

const PAGE_SIZE = 20

export default function SitesReviewQueuePage() {
  const router = useRouter()
  const { user } = useUser()
  const isVerifier = Boolean(user?.isVerifier)
  const [rows, setRows] = useState<ISiteDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)

  const loadPage = useCallback(async (nextPage: number, append: boolean) => {
    const { data } = await listSiteModeration(nextPage, PAGE_SIZE)
    const list = data.data.sites ?? []
    setTotalPages(data.data.pagination?.pages ?? 0)
    setPage(nextPage)
    setRows(prev => (append ? [...prev, ...list] : list))
  }, [])

  const load = useCallback(async () => {
    if (!user?._id || !isVerifier) {
      setRows([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      await loadPage(1, false)
    } catch (e) {
      console.error(e)
      toast.error('Failed to load sites')
    } finally {
      setLoading(false)
    }
  }, [user?._id, isVerifier, loadPage])

  useEffect(() => {
    void load()
  }, [load])

  const onRefresh = async () => {
    setRefreshing(true)
    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  const onLoadMore = async () => {
    if (loadingMore || page >= totalPages) return
    setLoadingMore(true)
    try {
      await loadPage(page + 1, true)
    } catch (e) {
      console.error(e)
      toast.error('Failed to load more')
    } finally {
      setLoadingMore(false)
    }
  }

  if (!isVerifier) {
    return (
      <div className="p-6">
        <p className="text-brown-2">Only verifiers can review sites.</p>
        <Button
          className="mt-4 rounded-full px-5 py-2.5 font-semibold"
          color="success"
          onClick={() => router.push(appConfig.routes.Stake)}
        >
          Request verifier access
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f6f1ea]">
      <SiteFlowHeader
        verifier
        title="Sites to review"
        onRefresh={() => void onRefresh()}
        refreshing={refreshing}
      />
      <main className="flex flex-col gap-3 px-4 pb-10 pt-4">
        <p className="text-sm text-[#6b6560]">
          Check that the photos and answers are honest and fit the satellite
          result. Oldest first.
        </p>
        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : rows.length ? (
          <>
            <ul className="flex flex-col gap-2">
              {rows.map(site => (
                <li key={site._id}>
                  <SiteCard
                    site={site}
                    onClick={() => router.push(buildSiteReviewPath(site._id))}
                  />
                </li>
              ))}
            </ul>
            {totalPages > 0 && page < totalPages ? (
              <div className="flex justify-center">
                <Button
                  size="sm"
                  color="gray"
                  disabled={loadingMore}
                  onClick={() => void onLoadMore()}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="py-8 text-center text-brown-2">
            No sites waiting for your review.
          </p>
        )}
      </main>
    </div>
  )
}
