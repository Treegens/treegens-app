'use client'

import { useParams } from 'next/navigation'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { ApproveSiteModal } from '@/components/siteCheck/ApproveSiteModal'
import { RejectSiteModal } from '@/components/siteCheck/RejectSiteModal'
import { SiteDetailBody } from '@/components/siteCheck/SiteDetailBody'
import { SiteFlowHeader } from '@/components/siteCheck/SiteFlowHeader'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { useUser } from '@/contexts/UserProvider'
import { useSite } from '@/hooks/useSite'
import { recheckSiteHydrology, voteOnSite } from '@/services/siteService'
import type { ISiteDoc } from '@/types'
import { apiErrorMessage, notifyError } from '@/utils/apiErrorMessage'

/** Why this verifier cannot vote now, or null when a vote is open. */
function voteBlocker(site: ISiteDoc, wallet: string): string | null {
  if (site.userWalletAddress?.toLowerCase() === wallet) {
    return 'This is your own site. Other verifiers will review it.'
  }
  const voted = (site.votes ?? []).some(
    v => v.voterWalletAddress?.toLowerCase() === wallet,
  )
  if (voted) return 'You voted. Waiting for other verifiers.'
  if (site.status === 'draft') return 'This site has not been sent for review.'
  if (site.status !== 'pending_review')
    return 'The review of this site is closed.'
  return null
}

export default function ReviewSitePage() {
  const params = useParams()
  const siteId = typeof params.id === 'string' ? params.id : ''
  const { user } = useUser()
  const isVerifier = Boolean(user?.isVerifier)
  const wallet = user?.walletAddress?.toLowerCase() ?? ''
  const { site, setSite, loading, error, reload } = useSite(siteId)
  const [refreshing, setRefreshing] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [isApproveOpen, setIsApproveOpen] = useState(false)
  const [isRejectOpen, setIsRejectOpen] = useState(false)

  const refresh = async () => {
    setRefreshing(true)
    await reload()
    setRefreshing(false)
  }

  const recheck = async () => {
    setRechecking(true)
    try {
      const { data } = await recheckSiteHydrology(siteId)
      setSite(data.data)
      toast.success('Satellite check started')
    } catch (e) {
      notifyError(apiErrorMessage(e, 'Could not start the satellite check'))
    } finally {
      setRechecking(false)
    }
  }

  const vote = async (choice: 'yes' | 'no', reasons: string[]) => {
    try {
      await voteOnSite(siteId, choice, reasons)
      toast.success('Vote submitted')
      setIsApproveOpen(false)
      setIsRejectOpen(false)
      await reload()
    } catch (e) {
      console.error(e)
      notifyError(apiErrorMessage(e, 'Vote failed'))
    }
  }

  if (!isVerifier) {
    return (
      <div className="flex h-full min-h-screen flex-col items-center justify-center bg-[#f6f1ea] px-6">
        <p className="text-center text-base text-[#6b6560]">
          Only verifiers can review sites.
        </p>
      </div>
    )
  }

  const blocker = site ? voteBlocker(site, wallet) : null
  return (
    <div className="flex min-h-screen flex-col bg-[#f6f1ea]">
      <SiteFlowHeader
        verifier
        title="Review site"
        onRefresh={() => void refresh()}
        refreshing={refreshing}
      />
      <main className="flex-1 px-4 pb-6 pt-3">
        {loading ? (
          <div className="flex justify-center py-16">
            <Spinner size="lg" />
          </div>
        ) : site ? (
          <SiteDetailBody
            site={site}
            onRecheck={() => void recheck()}
            rechecking={rechecking}
          />
        ) : (
          <p className="mt-6 text-center text-base text-red-600">
            {error || 'Site not found.'}
          </p>
        )}
      </main>
      {site ? (
        <footer className="border-t border-neutral-200/80 bg-[#f6f1ea] px-4 pb-6 pt-3">
          {blocker ? (
            <p className="text-center text-base font-medium text-[#4b5563]">
              {blocker}
            </p>
          ) : (
            <div className="flex gap-3">
              <Button
                className="flex-1 rounded-2xl py-3.5 text-lg font-semibold"
                color="red"
                outline
                onClick={() => setIsRejectOpen(true)}
              >
                Reject
              </Button>
              <Button
                className="flex-1 rounded-2xl py-3.5 text-lg font-semibold"
                color="success"
                onClick={() => setIsApproveOpen(true)}
              >
                Approve
              </Button>
            </div>
          )}
        </footer>
      ) : null}
      <ApproveSiteModal
        isOpen={isApproveOpen}
        onClose={() => setIsApproveOpen(false)}
        onApprove={({ reasons }) => void vote('yes', reasons)}
      />
      <RejectSiteModal
        isOpen={isRejectOpen}
        onClose={() => setIsRejectOpen(false)}
        onReject={({ reasons }) => {
          const cleaned = reasons.map(r => r.trim()).filter(Boolean)
          if (!cleaned.length) {
            notifyError('Add a rejection reason')
            return
          }
          void vote('no', cleaned)
        }}
      />
    </div>
  )
}
