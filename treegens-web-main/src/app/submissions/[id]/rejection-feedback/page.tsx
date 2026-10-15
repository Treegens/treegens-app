'use client'

import { useParams, useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { HiArrowLeft } from 'react-icons/hi'
import { RejectionReasonsCard } from '@/components/submission-detail/RejectionReasonsCard'
import { useUser } from '@/contexts/UserProvider'
import { getSubmissionById } from '@/services/app'
import type { ISubmissionDoc } from '@/types'
import { getRejectionDetails } from '@/utils/rejectionFeedback'
import {
  submissionDocToPlanterGroup,
  type PlanterSubmissionGroup,
} from '@/utils/submissionPlanterGroup'

export default function RejectionFeedbackPage() {
  const router = useRouter()
  const params = useParams()
  const { user } = useUser()
  const id = typeof params.id === 'string' ? params.id : ''
  const [loading, setLoading] = useState(true)
  const [group, setGroup] = useState<PlanterSubmissionGroup | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!id) {
      setError('Invalid submission')
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const response = await getSubmissionById(id)
      const doc = response.data.data as ISubmissionDoc & Record<string, unknown>
      setGroup(submissionDocToPlanterGroup(doc))
    } catch (e) {
      console.error('Failed to load rejection feedback', e)
      setError('Failed to load feedback')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const details = useMemo(() => getRejectionDetails(group), [group])
  const isOwner =
    !!group &&
    !!user?.walletAddress &&
    group.userWalletAddress.toLowerCase() === user.walletAddress.toLowerCase()

  return (
    <div className="mx-auto mb-24 max-w-3xl px-4 pb-8 pt-4">
      <div className="mb-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-md p-1 text-[#111] hover:bg-neutral-200/50"
          aria-label="Back"
        >
          <HiArrowLeft className="h-6 w-6" />
        </button>
        <h1 className="text-2xl font-bold text-[#111]">Verifier feedback</h1>
        <span className="w-8" aria-hidden />
      </div>

      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-neutral-200 border-t-green-600" />
        </div>
      ) : error ? (
        <div className="flex min-h-[40vh] items-center justify-center px-6">
          <p className="text-center text-red-700">{error}</p>
        </div>
      ) : details ? (
        <RejectionReasonsCard details={details} showNextSteps={isOwner} />
      ) : (
        <p className="pt-1 text-base leading-7 text-neutral-600">
          This submission has not been rejected, so there is no verifier
          feedback to show.
        </p>
      )}
    </div>
  )
}
