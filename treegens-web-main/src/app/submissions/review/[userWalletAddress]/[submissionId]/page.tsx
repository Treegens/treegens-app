'use client'

import { ApproveSubmissionModal } from '@/components/ApproveSubmissionModal'
import { RejectSubmissionModal } from '@/components/RejectSubmissionModal'
import { AiVerdictCard } from '@/components/submission-detail/AiVerdictCard'
import { PlantingCountCard } from '@/components/submission-detail/PlantingCountCard'
import { RewardClaimStatusPill } from '@/components/submission-detail/RewardClaimStatusPill'
import { SubmissionDmThread } from '@/components/submission-detail/SubmissionDmThread'
import { SubmissionSiteInfo } from '@/components/siteCheck/SubmissionSiteInfo'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { useUser } from '@/contexts/UserProvider'
import {
  getSubmissionById,
  getVerifierWarningBanner,
  voteOnSubmission,
} from '@/services/app'
import { claimReward, getRewardStatus } from '@/services/rewardService'
import {
  type ISubmissionDoc,
  type IVerifierWarningBanner,
  type IVideo,
  VideoStatus,
} from '@/types'
import type { RewardStatusProjection } from '@/types/reward'
import { verifierClaimFooterState } from '@/utils/claimUiState'
import { formatGeocodeParts } from '@/utils/formatGeocode'
import { truncateAddress } from '@/utils/helpers'
import { ipfsGatewayUrl } from '@/utils/ipfsGatewayUrl'
import { formatWeiToMgro } from '@/utils/formatWeiToMgro'
import {
  submissionDocToPlanterGroup,
  type PlanterSubmissionGroup,
} from '@/utils/submissionPlanterGroup'
import { formatTimeAgo } from '@/utils/timeAgo'
import { getVerifierRewardFromStatus } from '@/utils/verifierRewardSlice'
import { apiErrorMessage, notifyError } from '@/utils/apiErrorMessage'
import { useParams, useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { HiArrowLeft, HiArrowPath } from 'react-icons/hi2'
import { IoPlayCircleOutline } from 'react-icons/io5'

function hasUserVotedOnVideo(
  video: IVideo | undefined,
  verifierWallet: string | undefined,
): boolean {
  if (!video || !verifierWallet) return false
  const votes = video.votes
  if (!Array.isArray(votes)) return false
  const wallet = verifierWallet.toLowerCase()
  return votes.some(v => v.voterWalletAddress?.toLowerCase() === wallet)
}

function hasUserVotedYesOnVideo(
  video: IVideo | undefined,
  verifierWallet: string | undefined,
): boolean {
  if (!video || !verifierWallet) return false
  const votes = video.votes
  if (!Array.isArray(votes)) return false
  const wallet = verifierWallet.toLowerCase()
  return votes.some(
    v => v.voterWalletAddress?.toLowerCase() === wallet && v.vote === 'yes',
  )
}

function submissionFullyApproved(group: PlanterSubmissionGroup): boolean {
  const representative = group.plantVideo || group.landVideo
  return representative?.status === VideoStatus.APPROVED
}

function verifierNeedsVote(
  group: PlanterSubmissionGroup,
  verifierWallet: string | undefined,
): boolean {
  const representative = group.plantVideo || group.landVideo
  return (
    !!representative &&
    representative.status === VideoStatus.PENDING &&
    !hasUserVotedOnVideo(representative, verifierWallet)
  )
}

function VideoMetaBlock({ video }: { video?: IVideo }) {
  const { cityState, country } = formatGeocodeParts(video?.reverseGeocode)
  const timeAgo = video ? formatTimeAgo(video.createdAt) : '-'
  const locationLabel =
    cityState === 'Unknown location' && !country
      ? 'Unknown location'
      : [cityState, country].filter(Boolean).join(', ')

  return (
    <div className="flex items-start justify-between gap-3 px-0.5 pt-0.5">
      <p className="flex-1 text-base font-semibold text-[#2d2419] line-clamp-2">
        {locationLabel}
      </p>
      <p className="shrink-0 pt-0.5 text-sm text-[#6b6560]">{timeAgo}</p>
    </div>
  )
}

function VideoPanel({
  video,
  emptyMessage,
}: {
  video?: IVideo
  emptyMessage: string
}) {
  const uri = video ? ipfsGatewayUrl(video.videoCID) : null
  if (!video) {
    return (
      <div className="w-full overflow-hidden rounded-[14px] bg-[#ebe6e0]">
        <div className="flex aspect-video w-full items-center justify-center gap-2 bg-[#ebe6e0]">
          <IoPlayCircleOutline className="h-14 w-14 text-[#c4bbb2]" />
          <p className="px-6 text-center text-sm text-[#7a736b]">
            {emptyMessage}
          </p>
        </div>
      </div>
    )
  }

  if (!uri) {
    return (
      <div className="w-full overflow-hidden rounded-[14px] bg-[#ebe6e0]">
        <div className="flex aspect-video w-full items-center justify-center gap-2 bg-[#ebe6e0]">
          <p className="px-6 text-center text-sm text-[#7a736b]">
            No video reference on this submission.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full overflow-hidden rounded-[14px] bg-[#ebe6e0]">
      <video className="aspect-video w-full bg-black object-contain" controls>
        <source src={uri} type="video/mp4" />
        Your browser does not support the video tag.
      </video>
    </div>
  )
}

export default function ReviewSubmission() {
  const params = useParams()
  const router = useRouter()
  const { user } = useUser()
  const [isLoading, setIsLoading] = useState(true)
  const [isApproveOpen, setIsApproveOpen] = useState(false)
  const [isRejectOpen, setIsRejectOpen] = useState(false)
  const [submissionGroup, setSubmissionGroup] =
    useState<PlanterSubmissionGroup | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [warningBanner, setWarningBanner] =
    useState<IVerifierWarningBanner | null>(null)
  const [verifierReward, setVerifierReward] =
    useState<RewardStatusProjection | null>(null)
  const [claimingVerifier, setClaimingVerifier] = useState(false)
  const [siteInfo, setSiteInfo] = useState<
    Pick<ISubmissionDoc, 'siteId' | 'siteCheck' | 'species'>
  >({})

  const submissionId =
    typeof params.submissionId === 'string' ? params.submissionId : ''
  const isVerifier = Boolean(user?.isVerifier)
  const verifierWallet = user?.walletAddress

  const landVideo = submissionGroup?.landVideo
  const plantVideo = submissionGroup?.plantVideo
  const representative = plantVideo || landVideo

  const needsVote = submissionGroup
    ? verifierNeedsVote(submissionGroup, verifierWallet)
    : false
  const fullyApproved = submissionGroup
    ? submissionFullyApproved(submissionGroup)
    : false

  const headerBadge = useMemo((): 'pending' | 'voted' | 'approved' => {
    if (fullyApproved) return 'approved'
    if (needsVote) return 'pending'
    return 'voted'
  }, [fullyApproved, needsVote])

  const load = useCallback(
    async (isRefresh = false) => {
      if (!submissionId) {
        setError('Missing submission details.')
        setIsLoading(false)
        return
      }
      if (isRefresh) setRefreshing(true)
      else setIsLoading(true)
      setError('')
      try {
        if (!isVerifier) return
        const [response, warningResponse] = await Promise.all([
          getSubmissionById(submissionId),
          getVerifierWarningBanner().catch(() => null),
        ])
        const doc = response.data.data as ISubmissionDoc &
          Record<string, unknown>
        setSubmissionGroup(submissionDocToPlanterGroup(doc))
        setSiteInfo({
          siteId: doc.siteId,
          siteCheck: doc.siteCheck,
          species: doc.species,
        })
        setWarningBanner(warningResponse?.data?.data || null)
      } catch (e) {
        console.error('Failed to load submission', e)
        setError('Could not load this submission.')
      } finally {
        if (isRefresh) setRefreshing(false)
        else setIsLoading(false)
      }
    },
    [submissionId, isVerifier],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  useEffect(() => {
    if (
      !fullyApproved ||
      !submissionId ||
      !hasUserVotedYesOnVideo(plantVideo, verifierWallet)
    ) {
      setVerifierReward(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await getRewardStatus(submissionId)
        if (!cancelled) setVerifierReward(data.data)
      } catch {
        if (!cancelled) setVerifierReward(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fullyApproved, submissionId, plantVideo, verifierWallet])

  useEffect(() => {
    if (!submissionId || !verifierReward?.activeClaimJob) return
    const intervalId = setInterval(async () => {
      try {
        const { data } = await getRewardStatus(submissionId)
        setVerifierReward(data.data)
      } catch {
        // ignore polling failures
      }
    }, 4000)
    return () => clearInterval(intervalId)
  }, [submissionId, verifierReward?.activeClaimJob])

  const openApproveModal = useCallback(() => {
    if (!submissionId || !submissionGroup) return
    if (
      !representative ||
      representative.status !== VideoStatus.PENDING ||
      !verifierNeedsVote(submissionGroup, verifierWallet)
    ) {
      toast('No pending vote for this submission.')
      return
    }
    setIsApproveOpen(true)
  }, [submissionId, submissionGroup, representative, verifierWallet])

  const openRejectModal = useCallback(() => {
    if (!submissionId || !submissionGroup) return
    if (!verifierNeedsVote(submissionGroup, verifierWallet)) {
      toast('No pending vote for this submission.')
      return
    }
    setIsRejectOpen(true)
  }, [submissionId, submissionGroup, verifierWallet])

  const verifierSlice = useMemo(
    () => getVerifierRewardFromStatus(verifierReward),
    [verifierReward],
  )

  const verifierRewardClaimDisplay = useMemo((): boolean | null => {
    if (!fullyApproved || !verifierSlice) return null
    return verifierSlice.scheduleCompleted
  }, [fullyApproved, verifierSlice])

  const showVerifierClaim =
    fullyApproved &&
    !!verifierSlice &&
    verifierSlice.displayState !== 'COMPLETED'

  const verifierClaimMgro = verifierSlice
    ? formatWeiToMgro(verifierSlice.pendingClaimAmountWei) ||
      formatWeiToMgro(verifierSlice.totalRewardWei)
    : 0

  const verifierClaimFooter = useMemo(
    () =>
      verifierClaimFooterState(
        verifierReward,
        Boolean(verifierSlice?.canClaim),
      ),
    [verifierReward, verifierSlice?.canClaim],
  )

  const onVerifierClaim = async () => {
    if (!submissionId || claimingVerifier) return
    if (verifierClaimFooter.variant !== 'claim') return
    try {
      setClaimingVerifier(true)
      await claimReward(submissionId)
      toast.success('Claim queued for processing')
      const { data } = await getRewardStatus(submissionId)
      setVerifierReward(data.data)
    } catch (claimErr: unknown) {
      notifyError(apiErrorMessage(claimErr, 'Claim failed'))
    } finally {
      setClaimingVerifier(false)
    }
  }

  const warningMessage = useMemo(() => {
    if (!warningBanner?.shouldShow || !warningBanner.warningCount) return null
    return warningBanner.warningCount >= 2
      ? "You've been cautioned AGAIN for your vote on "
      : "You've been cautioned for your vote on "
  }, [warningBanner])

  const warningHref = useMemo(() => {
    if (!warningBanner?.submissionId) return null
    return `/submissions/cautioned/${encodeURIComponent(warningBanner.submissionId)}`
  }, [warningBanner])

  if (isLoading) {
    return (
      <div className="flex h-full min-h-screen items-center justify-center bg-[#f6f1ea] px-6">
        <Spinner size="lg" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full min-h-screen flex-col items-center justify-center bg-[#f6f1ea] px-6">
        <p className="text-center text-base text-red-600">{error}</p>
      </div>
    )
  }

  if (!isVerifier) {
    return (
      <div className="flex h-full min-h-screen flex-col items-center justify-center bg-[#f6f1ea] px-6">
        <p className="text-center text-base text-[#6b6560]">
          Only verifiers can review submissions.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f6f1ea]">
      <header className="sticky top-0 z-10 border-b border-neutral-200/80 bg-[#f6f1ea] px-4 py-3">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-md p-1 text-[#4d341e] hover:bg-neutral-200/50"
            aria-label="Back"
          >
            <HiArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold text-[#2d2419]">
            Review Submission
          </h1>
          <button
            type="button"
            onClick={() => void load(true)}
            className="rounded-md p-1 text-[#4d341e] hover:bg-neutral-200/50"
            aria-label="Refresh"
          >
            <HiArrowPath
              className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`}
            />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 pb-24 pt-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-[#2d2419]">
            {truncateAddress(submissionGroup?.userWalletAddress || '')}
          </p>
          <div className="flex items-center gap-2">
            {verifierRewardClaimDisplay !== null ? (
              <RewardClaimStatusPill claimed={verifierRewardClaimDisplay} />
            ) : (
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  headerBadge === 'approved'
                    ? 'bg-green-100 text-green-800'
                    : headerBadge === 'pending'
                      ? 'bg-yellow-100 text-yellow-800'
                      : 'bg-slate-100 text-slate-700'
                }`}
              >
                {headerBadge === 'pending'
                  ? 'In review'
                  : headerBadge === 'voted'
                    ? 'Voted'
                    : 'Approved'}
              </span>
            )}
          </div>
        </div>

        <SubmissionSiteInfo {...siteInfo} className="mt-3" />

        <section className="mt-4 space-y-2.5">
          <h2 className="text-lg font-bold tracking-wide text-[#4d341e]">
            Land
          </h2>
          <VideoPanel
            video={landVideo}
            emptyMessage="No land video submitted"
          />
          <VideoMetaBlock video={landVideo} />
        </section>

        <section className="mt-6 space-y-3">
          <h2 className="text-lg font-bold tracking-wide text-[#4d341e]">
            Plant
          </h2>
          {(plantVideo || submissionGroup?.submissionTreesPlanted != null) &&
          submissionGroup ? (
            <PlantingCountCard
              declaredTrees={
                typeof plantVideo?.treesPlanted === 'number'
                  ? plantVideo.treesPlanted
                  : submissionGroup.submissionTreesPlanted
              }
              species={
                plantVideo?.treetype?.trim() ||
                submissionGroup.submissionTreeSpecies ||
                null
              }
              aiVerification={submissionGroup.aiVerification}
            />
          ) : null}
          <VideoPanel
            video={plantVideo}
            emptyMessage="No plant video submitted"
          />
          <VideoMetaBlock video={plantVideo} />
          {submissionGroup &&
          submissionGroup.aiVerification &&
          (
            submissionGroup.plantVideo?.treetype?.toLowerCase() === 'mangrove' ||
            submissionGroup.submissionTreeSpecies?.toLowerCase() === 'mangrove'
          ) ? (
            <AiVerdictCard
              aiVerification={submissionGroup.aiVerification}
              declaredTrees={
                typeof plantVideo?.treesPlanted === 'number'
                  ? plantVideo.treesPlanted
                  : submissionGroup.submissionTreesPlanted
              }
            />
          ) : null}
          {submissionGroup?.submissionId ? (
            <SubmissionDmThread submissionId={submissionGroup.submissionId} />
          ) : null}
        </section>
      </main>

      <footer className="border-t border-neutral-200/80 bg-[#f6f1ea] px-4 pb-6 pt-3">
        {warningMessage ? (
          <div className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
            <p className="text-sm font-medium leading-6">
              {warningMessage}
              {warningHref ? (
                <a
                  className="underline underline-offset-2"
                  href={warningHref}
                  onClick={event => {
                    event.preventDefault()
                    router.push(warningHref)
                  }}
                >
                  this submission
                </a>
              ) : (
                'this submission'
              )}
              .
            </p>
          </div>
        ) : null}
        {showVerifierClaim && verifierSlice ? (
          verifierClaimFooter.variant === 'queue' ? (
            <div className="rounded-2xl border border-[#bfdbfe] bg-[#eff6ff] px-4 py-3.5">
              <p className="text-center text-lg leading-6 text-[#1e40af]">
                Your claim has been queued and will be processed shortly.
              </p>
            </div>
          ) : (
            <button
              type="button"
              className={`w-full rounded-2xl py-3.5 text-lg font-semibold text-white ${
                verifierClaimFooter.variant === 'claim' && !claimingVerifier
                  ? 'bg-green-600'
                  : 'bg-slate-400'
              }`}
              onClick={() => void onVerifierClaim()}
              disabled={
                verifierClaimFooter.variant !== 'claim' || claimingVerifier
              }
            >
              {claimingVerifier
                ? 'Claiming...'
                : `Claim ${verifierClaimMgro.toLocaleString()} MGRO`}
            </button>
          )
        ) : needsVote ? (
          <div className="flex gap-3">
            <Button
              className="flex-1 rounded-2xl py-3.5 text-lg font-semibold"
              color="red"
              outline
              onClick={openRejectModal}
            >
              Reject
            </Button>
            <Button
              className="flex-1 rounded-2xl py-3.5 text-lg font-semibold"
              color="success"
              onClick={openApproveModal}
            >
              Approve
            </Button>
          </div>
        ) : !fullyApproved ? (
          <p className="text-center text-base font-medium text-[#4b5563]">
            You voted. Waiting for other verifiers.
          </p>
        ) : null}
      </footer>

      <ApproveSubmissionModal
        isOpen={isApproveOpen}
        onClose={() => setIsApproveOpen(false)}
        onApprove={async ({ reasons }) => {
          try {
            if (!submissionId) return
            await voteOnSubmission(submissionId, 'yes', reasons)
            toast.success('Vote submitted')
            setIsApproveOpen(false)
            await load(true)
          } catch (e) {
            console.error(e)
            notifyError(apiErrorMessage(e, 'Vote failed'))
          }
        }}
      />
      <RejectSubmissionModal
        isOpen={isRejectOpen}
        onClose={() => setIsRejectOpen(false)}
        onReject={async ({ reasons }) => {
          const cleaned = reasons.map(r => String(r).trim()).filter(Boolean)
          if (cleaned.length === 0) {
            notifyError('Add a rejection reason')
            return
          }
          try {
            if (!submissionId) return
            await voteOnSubmission(submissionId, 'no', cleaned)
            toast.success('Vote submitted')
            setIsRejectOpen(false)
            await load(true)
          } catch (e) {
            console.error(e)
            notifyError(apiErrorMessage(e, 'Vote failed'))
          }
        }}
      />
    </div>
  )
}
