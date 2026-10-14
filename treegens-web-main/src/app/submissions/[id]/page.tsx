'use client'

import { ClaimCard } from '@/components/submission-detail/ClaimCard'
import { LandVideoSection } from '@/components/submission-detail/LandVideoSection'
import { PlantVideoSection } from '@/components/submission-detail/PlantVideoSection'
import { SubmissionDmThread } from '@/components/submission-detail/SubmissionDmThread'
import { RejectionReasonsCard } from '@/components/submission-detail/RejectionReasonsCard'
import { SubmissionStatusBadges } from '@/components/submission-detail/SubmissionStatusBadges'
import { TwoVideoProofSteps } from '@/components/submission/TwoVideoProofSteps'
import { Spinner } from '@/components/ui/Spinner'
import { getSubmissionById } from '@/services/app'
import { claimReward, getRewardStatus } from '@/services/rewardService'
import type { RewardStatusProjection } from '@/types/reward'
import type { ISubmissionDoc } from '@/types'
import { planterClaimFooterState } from '@/utils/claimUiState'
import { formatWeiToMgro } from '@/utils/formatWeiToMgro'
import { getPlanterSubmissionBadge } from '@/utils/planterSubmissionBadge'
import { getRejectionDetails } from '@/utils/rejectionFeedback'
import { rewardScheduleFullyClaimed } from '@/utils/rewardScheduleClaimed'
import {
  getSubmissionDetailVideoUrl,
  formatTimeLeft,
} from '@/utils/submissionDetailVideo'
import {
  submissionDocToPlanterGroup,
  type PlanterSubmissionGroup,
} from '@/utils/submissionPlanterGroup'
import { formatTimeAgo } from '@/utils/timeAgo'
import { formatGeocodeParts } from '@/utils/formatGeocode'
import axios from 'axios'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { HiArrowLeft, HiArrowPath } from 'react-icons/hi2'
import { IoPulseOutline } from 'react-icons/io5'

export default function SubmissionDetailPage() {
  const params = useParams()
  const id = typeof params.id === 'string' ? params.id : ''
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [group, setGroup] = useState<PlanterSubmissionGroup | null>(null)
  const [error, setError] = useState('')
  const [rewardStatus, setRewardStatus] =
    useState<RewardStatusProjection | null>(null)
  const [statusLoadedAt, setStatusLoadedAt] = useState(() => Date.now())
  const [claiming, setClaiming] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const timerBoundaryRefreshKeyRef = useRef<string | null>(null)

  const load = useCallback(
    async (isRefresh = false) => {
      if (!id) {
        setError('Invalid submission')
        setLoading(false)
        setRefreshing(false)
        return
      }

      if (isRefresh) setRefreshing(true)
      else setLoading(true)
      setError('')
      try {
        const res = await getSubmissionById(id)
        const doc = res.data.data as ISubmissionDoc & Record<string, unknown>
        setGroup(submissionDocToPlanterGroup(doc))

        try {
          const rs = await getRewardStatus(id)
          setRewardStatus(rs.data.data)
          setStatusLoadedAt(Date.now())
        } catch (rewardErr: unknown) {
          if (
            axios.isAxiosError(rewardErr) &&
            rewardErr.response?.status === 404
          ) {
            setRewardStatus(null)
          } else {
            console.error('Failed to load reward status', rewardErr)
          }
        }
      } catch (e) {
        console.error('Failed to load submission details', e)
        setError('Failed to load submission')
      } finally {
        if (isRefresh) setRefreshing(false)
        else setLoading(false)
      }
    },
    [id],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  const onRefresh = useCallback(() => load(true), [load])

  const landVideo = group?.landVideo
  const plantVideo = group?.plantVideo
  const landVideoUrl = useMemo(
    () => getSubmissionDetailVideoUrl(landVideo),
    [landVideo],
  )
  const plantVideoUrl = useMemo(
    () => getSubmissionDetailVideoUrl(plantVideo),
    [plantVideo],
  )
  const landVideoTimestamp = useMemo(
    () => (landVideo ? formatTimeAgo(landVideo.createdAt) : ''),
    [landVideo],
  )
  const plantVideoTimestamp = useMemo(
    () => (plantVideo ? formatTimeAgo(plantVideo.createdAt) : ''),
    [plantVideo],
  )

  const { cityState, country } = useMemo(
    () => formatGeocodeParts(group?.location),
    [group?.location],
  )
  const locationText = useMemo(() => {
    if (!group?.location?.trim()) return 'Unknown location'
    return country ? `${cityState}, ${country}` : cityState
  }, [cityState, country, group?.location])

  const statusMeta = useMemo(
    () => (group ? getPlanterSubmissionBadge(group) : null),
    [group],
  )

  const rejectionDetails = useMemo(() => getRejectionDetails(group), [group])

  const rewardClaimDisplay = useMemo((): boolean | null => {
    if (group?.submissionStatus !== 'approved' || !rewardStatus) return null
    return rewardScheduleFullyClaimed(rewardStatus)
  }, [group?.submissionStatus, rewardStatus])

  const claimed = formatWeiToMgro(rewardStatus?.claimedAmountWei)
  const isClaimCompleted = rewardStatus?.displayState === 'COMPLETED'

  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const countdown = useMemo(() => {
    if (rewardStatus?.remainingMs == null) return null
    const elapsed = now - statusLoadedAt
    return formatTimeLeft(Math.max(1000, rewardStatus.remainingMs - elapsed))
  }, [now, rewardStatus?.remainingMs, statusLoadedAt])

  const isTimerEnded = useMemo(() => {
    if (rewardStatus?.remainingMs == null) return false
    return now - statusLoadedAt >= rewardStatus.remainingMs
  }, [rewardStatus?.remainingMs, now, statusLoadedAt])

  const canClaim = useMemo(() => {
    if (!rewardStatus) return false
    return rewardStatus.canClaim && !claiming
  }, [rewardStatus, claiming])

  useEffect(() => {
    if (!id || !rewardStatus) return
    if (rewardStatus.activeClaimJob) return
    if (!isTimerEnded) return

    const boundaryKey = `${statusLoadedAt}:${rewardStatus.remainingMs ?? 'none'}`
    if (timerBoundaryRefreshKeyRef.current === boundaryKey) return
    timerBoundaryRefreshKeyRef.current = boundaryKey

    void (async () => {
      try {
        const rs = await getRewardStatus(id)
        setRewardStatus(rs.data.data)
        setStatusLoadedAt(Date.now())
      } catch {
        /* ignore */
      }
    })()
  }, [id, rewardStatus, isTimerEnded, statusLoadedAt])

  const claimDetail = useMemo(() => {
    if (!rewardStatus) {
      return { label: 'Next claim', value: 'Not available' }
    }
    if (rewardStatus.displayState === 'PENDING_CLAIM') {
      return {
        label: 'Next claim',
        value: countdown ?? 'Not available',
      }
    }
    if (rewardStatus.displayState === 'NEXT_CLAIM') {
      return {
        label: 'Next claim',
        value: countdown ?? 'Not available',
      }
    }
    if (rewardStatus.displayState === 'COMPLETED') {
      return { label: '', value: 'Completed' }
    }
    return { label: 'Next claim', value: 'Unavailable' }
  }, [rewardStatus, countdown])

  const claimFooter = useMemo(
    () => planterClaimFooterState(rewardStatus, canClaim),
    [rewardStatus, canClaim],
  )

  const claimCardVariant = useMemo(() => {
    if (claimFooter.variant === 'queue') return 'queue' as const
    if (rewardStatus?.nextPlanterAction === 'health_check') {
      return 'health_check' as const
    }
    return claimFooter.variant
  }, [claimFooter.variant, rewardStatus?.nextPlanterAction])

  useEffect(() => {
    if (!id || !rewardStatus?.activeClaimJob) return
    const tick = async () => {
      try {
        const rs = await getRewardStatus(id)
        setRewardStatus(rs.data.data)
        setStatusLoadedAt(Date.now())
      } catch {
        /* ignore */
      }
    }
    const timerId = setInterval(() => void tick(), 4000)
    return () => clearInterval(timerId)
  }, [id, rewardStatus?.activeClaimJob])

  const onClaim = async () => {
    if (!id || !rewardStatus || claiming) return
    if (claimFooter.variant !== 'claim' || claimCardVariant === 'health_check')
      return
    try {
      setClaiming(true)
      await claimReward(id)
      toast.success('Claim queued for processing')
      const rs = await getRewardStatus(id)
      setRewardStatus(rs.data.data)
      setStatusLoadedAt(Date.now())
    } catch (claimErr: unknown) {
      const msg =
        axios.isAxiosError(claimErr) && claimErr.response?.data
          ? (claimErr.response.data as { error?: string }).error
          : null
      toast.error(msg || 'Failed to claim reward')
    } finally {
      setClaiming(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="sticky top-0 z-10 flex flex-row items-center justify-between border-b border-gray-100 bg-white px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-md p-0.5 text-[#111] hover:bg-gray-100"
            aria-label="Back"
          >
            <HiArrowLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={refreshing || loading}
            className="rounded-md p-0.5 text-[#111] hover:bg-gray-100 disabled:opacity-40"
            aria-label="Refresh"
          >
            <HiArrowPath
              className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`}
            />
          </button>
        </div>
        <h1 className="text-[18px] font-bold text-[#111]">Submission</h1>
        <div className="w-10 shrink-0 flex justify-end">
          {group?.submissionStatus === 'approved' ? (
            <Link
              href={`/submissions/${encodeURIComponent(id)}/health-checks`}
              className="p-1 text-[#111]"
              aria-label="Health checks"
            >
              <IoPulseOutline className="h-6 w-6" />
            </Link>
          ) : (
            <span className="w-6" aria-hidden />
          )}
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-y-auto px-[15px] pb-24 pt-[15px]">
        {loading ? (
          <div className="mt-8 flex items-center justify-center">
            <Spinner size="lg" />
          </div>
        ) : group ? (
          <div className="flex flex-col gap-3.5">
            <SubmissionStatusBadges
              rewardClaimDisplay={rewardClaimDisplay}
              statusMeta={statusMeta}
            />

            {rejectionDetails ? (
              <RejectionReasonsCard details={rejectionDetails} />
            ) : null}

            {!plantVideo && group.submissionStatus === 'awaiting_plant' ? (
              <Link
                href={`/submissions/create/${encodeURIComponent(id)}`}
                className="rounded-2xl border-2 border-amber-300 bg-amber-50 px-4 py-4 text-center shadow-sm"
              >
                <p className="text-sm font-bold text-amber-950">
                  Step 2 of 2 — after video required
                </p>
                <p className="mt-1 text-sm text-amber-900/90">
                  Tap here to upload your after video
                  {group.submissionTreeSpecies?.toLowerCase() === 'mangrove' ||
                  group.submissionTreesPlanted != null
                    ? ' and get your AI mangrove count'
                    : ''}
                  .
                </p>
              </Link>
            ) : null}

            <TwoVideoProofSteps activeStep={3} className="mb-1" />

            <LandVideoSection
              videoUrl={landVideoUrl}
              locationText={locationText}
              timeAgo={landVideoTimestamp}
            />

            <PlantVideoSection
              submissionId={id}
              plantVideo={plantVideo}
              plantVideoUrl={plantVideoUrl}
              locationText={locationText}
              timeAgo={plantVideoTimestamp}
              aiVerification={group.aiVerification}
              submissionTreesPlanted={group.submissionTreesPlanted}
              submissionTreeSpecies={group.submissionTreeSpecies}
            />

            <SubmissionDmThread submissionId={id} />

            {group.submissionStatus === 'approved' ? (
              isClaimCompleted ? (
                <div className="mt-0.5 flex flex-col items-center justify-center rounded-2xl border border-gray-200 bg-lime-green-1/50 p-3.5">
                  <p className="text-base text-tree-green-2">
                    You&apos;ve completely claimed
                  </p>
                  <p className="text-xl font-semibold text-tree-green-2">
                    {claimed.toLocaleString()} MGRO
                  </p>
                </div>
              ) : rewardStatus?.displayState === 'NONE' ? null : (
                <ClaimCard
                  variant={claimCardVariant}
                  claimed={claimed}
                  detailLabel={claimDetail.label}
                  detailValue={claimDetail.value}
                  buttonLabel={claiming ? 'Claiming...' : 'Claim'}
                  onClaim={onClaim}
                  onHealthCheck={() =>
                    router.push(
                      `/submissions/${encodeURIComponent(id)}/health-checks/create`,
                    )
                  }
                />
              )
            ) : null}
          </div>
        ) : (
          <div className="mt-8 flex items-center justify-center">
            <p className="text-red-700">{error || 'Submission not found'}</p>
          </div>
        )}
      </div>
    </div>
  )
}
