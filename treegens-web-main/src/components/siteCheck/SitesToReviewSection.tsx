'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { FaChevronRight } from 'react-icons/fa'
import { Spinner } from '@/components/ui/Spinner'
import { appConfig, buildSiteReviewPath } from '@/config/appConfig'
import { useUser } from '@/contexts/UserProvider'
import { listSiteModeration } from '@/services/siteService'
import type { ISiteDoc } from '@/types'
import { SiteCard } from './SiteCard'

/** Verifier home section: the first sites waiting for a vote. */
export function SitesToReviewSection() {
  const router = useRouter()
  const { user } = useUser()
  const [sites, setSites] = useState<ISiteDoc[]>([])
  const [loading, setLoading] = useState(false)
  const isVerifier = Boolean(user?.isVerifier)

  useEffect(() => {
    if (!user?._id || !isVerifier) {
      setSites([])
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const { data } = await listSiteModeration(1, 3)
        if (!cancelled) setSites(data.data.sites ?? [])
      } catch (e) {
        console.error('Failed to fetch site review queue preview:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user?._id, isVerifier])

  return (
    <div className="flex flex-col gap-4 p-6 bg-warm-grey rounded-3xl">
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <h3 className="font-bold text-2xl">Sites to review</h3>
          {Boolean(sites.length) && (
            <div
              onClick={() => router.push(appConfig.routes.SitesReview)}
              className="flex gap-1 items-center cursor-pointer"
            >
              <span role="button" className="text-brown-2 font-bold text-sm">
                View all
              </span>
              <FaChevronRight className="w-3 h-3 text-brown-2" />
            </div>
          )}
        </div>
        <p className="text-xs text-brown-1 max-w-52">
          Check that site photos and answers are honest
        </p>
      </div>
      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner size="md" />
        </div>
      ) : sites.length ? (
        <ul className="flex flex-col gap-3">
          {sites.map(site => (
            <li key={site._id}>
              <SiteCard
                site={site}
                onClick={() => router.push(buildSiteReviewPath(site._id))}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-tree-green-3 text-sm font-semibold mx-auto">
          No sites to review
        </p>
      )}
    </div>
  )
}
