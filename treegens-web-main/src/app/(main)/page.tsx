'use client'
import { Spinner } from '@/components/ui/Spinner'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { FaChevronRight } from 'react-icons/fa'
import { AppHeader } from '@/components/Layout/AppHeader'
import SubmissionCard from '@/components/SubmissionCard'
import { SiteCheckPromoCard } from '@/components/siteCheck/SiteCheckPromoCard'
import { SitesToReviewSection } from '@/components/siteCheck/SitesToReviewSection'
import { VerifierHealthCheckCard } from '@/components/VerifierHealthCheckCard'
import { SubmissionReviewCard } from '@/components/SubmissionReviewCard'
import { appConfig } from '@/config/appConfig'
import { useUser } from '@/contexts/UserProvider'
import { getMySubmissions } from '@/services/app'
import { listHealthCheckModeration } from '@/services/healthCheckService'
import { getRewardStatus } from '@/services/rewardService'
import type { IHealthCheckDoc, ISubmissionDoc, ISubmissionGroup } from '@/types'
import { formatMgroCollectedDisplay } from '@/utils/formatMgro'
import { getPlanterSubmissionBadge } from '@/utils/planterSubmissionBadge'
import { rewardScheduleFullyClaimed } from '@/utils/rewardScheduleClaimed'
import {
  submissionDocToPlanterGroup,
  type PlanterSubmissionGroup,
} from '@/utils/submissionPlanterGroup'
import {
  loadVerifierSubmissionRows,
  type VerifierSubmissionRow,
} from '@/utils/verifierModeration'
import axios from 'axios'

function primaryVideoFromGroup(group: ISubmissionGroup) {
  return group.plantVideo ?? group.landVideo ?? null
}

function hasVerifierVotedOnHealthCheck(
  hc: IHealthCheckDoc,
  verifierWalletAddress?: string | null,
) {
  const wallet = verifierWalletAddress?.trim().toLowerCase()
  if (!wallet) return false
  const votes = hc.votes
  if (!Array.isArray(votes)) return false
  return votes.some(v => v.voterWalletAddress?.toLowerCase() === wallet)
}

export default function HomePage() {
  const router = useRouter()
  const { user } = useUser()
  const [myPlantGroups, setMyPlantGroups] = useState<PlanterSubmissionGroup[]>(
    [],
  )
  const [myPlantsLoading, setMyPlantsLoading] = useState(false)
  const [rewardClaimedById, setRewardClaimedById] = useState<
    Record<string, boolean | null>
  >({})
  /** One card per submission (land + plant are one group), like mobile `MyPlants` `latestSubmissions.slice(0, 2)`. */
  const latestSubmissions = useMemo(
    () => myPlantGroups.slice(0, 2),
    [myPlantGroups],
  )
  const isVerifier = Boolean(user?.isVerifier)
  const [reviewRows, setReviewRows] = useState<VerifierSubmissionRow[]>([])
  const previewReviewRows = useMemo(() => reviewRows.slice(0, 2), [reviewRows])
  const [modLoading, setModLoading] = useState<boolean>(false)
  const [hcPreview, setHcPreview] = useState<IHealthCheckDoc[]>([])
  const [hcLoading, setHcLoading] = useState(false)

  useEffect(() => {
    const loadMySubmissions = async () => {
      if (!user?._id) {
        setMyPlantGroups([])
        setRewardClaimedById({})
        return
      }
      setMyPlantsLoading(true)
      try {
        const { data } = await getMySubmissions({ page: 1, limit: 100 })
        const docs = (data?.data?.submissions ?? []) as Array<
          ISubmissionDoc & Record<string, unknown>
        >
        setMyPlantGroups(docs.map(doc => submissionDocToPlanterGroup(doc)))
      } catch (e) {
        console.error('Failed to fetch my submissions for home preview:', e)
      } finally {
        setMyPlantsLoading(false)
      }
    }
    void loadMySubmissions()
  }, [user?._id])

  useEffect(() => {
    const approvedIds = myPlantGroups
      .filter(g => g.submissionStatus === 'approved')
      .map(g => g.submissionId)

    if (!approvedIds.length) {
      setRewardClaimedById({})
      return
    }

    let cancelled = false
    ;(async () => {
      const entries = await Promise.all(
        approvedIds.map(async id => {
          try {
            const rs = await getRewardStatus(id)
            return [id, rewardScheduleFullyClaimed(rs.data?.data)] as const
          } catch (e) {
            if (axios.isAxiosError(e) && e.response?.status === 404) {
              return [id, null] as const
            }
            return [id, null] as const
          }
        }),
      )
      if (!cancelled) {
        setRewardClaimedById(Object.fromEntries(entries))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [myPlantGroups])

  useEffect(() => {
    const fetchModerationVideos = async () => {
      if (!user?._id || !isVerifier || !user?.walletAddress) {
        setReviewRows([])
        return
      }
      setModLoading(true)
      try {
        const rows = await loadVerifierSubmissionRows(user.walletAddress, {
          limit: 20,
          page: 1,
        })
        setReviewRows(rows)
      } catch (e) {
        console.error('Failed to fetch moderation videos:', e)
      } finally {
        setModLoading(false)
      }
    }
    fetchModerationVideos()
  }, [user?._id, user?.walletAddress, isVerifier])

  useEffect(() => {
    const loadHc = async () => {
      if (!user?._id || !isVerifier) {
        setHcPreview([])
        return
      }
      setHcLoading(true)
      try {
        const { data } = await listHealthCheckModeration(1, 3)
        const filtered = (data?.data?.healthChecks ?? []).filter(
          hc => !hasVerifierVotedOnHealthCheck(hc, user?.walletAddress),
        )
        setHcPreview(filtered)
      } catch (e) {
        console.error('Failed to fetch health check queue preview:', e)
      } finally {
        setHcLoading(false)
      }
    }
    loadHc()
  }, [user?._id, isVerifier])

  return (
    <>
      <AppHeader />
      <div className="mb-30 flex flex-col gap-6 p-6">
        <section className="relative overflow-hidden rounded-3xl border border-white/60 bg-gradient-to-br from-white via-[#f9fcf6] to-[#e8f2dc]/95 p-6 shadow-[0_24px_60px_rgba(48,62,26,0.14)]">
          <div className="pointer-events-none absolute -right-16 top-0 h-44 w-44 rounded-full bg-[#DFEA8A]/45 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-12 -left-10 h-40 w-40 rounded-full bg-[#6B8C3B]/22 blur-3xl" />
          <div className="relative">
            <p className="text-[11px] font-black uppercase tracking-[0.28em] text-[#435F24]">
              Welcome
            </p>
            <h2 className="mt-2 text-2xl font-black leading-tight tracking-tight text-[#0f160c]">
              Verify real planting.
              <span className="block text-[#435F24]">Earn rewards.</span>
            </h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-[#5c534a]">
              TreeGens ties your mangrove and forest clips to on-chain proof —
              loyalty points, MGRO claims, and verifier-reviewed submissions in
              one flow.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href={appConfig.routes.NewPlant}
                className="tg-cta inline-flex items-center justify-center rounded-2xl px-5 py-3 text-sm font-black uppercase tracking-wide text-[#16210c]"
              >
                Plant trees
              </Link>
              <Link
                href={appConfig.routes.Earn}
                className="tg-card inline-flex items-center justify-center rounded-2xl border-[#435F24]/20 px-5 py-3 text-sm font-bold text-[#303E1A]"
              >
                Earn & tasks
              </Link>
            </div>
          </div>
        </section>

        <SiteCheckPromoCard />

        <div className="mb-4 flex flex-col gap-2.5 rounded-[20px] bg-warm-grey p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
          <h3 className="text-2xl font-bold">Overview</h3>

          <div className="flex flex-col gap-2.5">
            <div className="flex flex-row items-center gap-[7px]">
              <Image
                src="/img/tree.svg"
                alt=""
                width={29}
                height={29}
                className="h-[29px] w-[29px]"
              />
              <span
                className="font-bold leading-none text-tree-green-2"
                style={{ fontSize: '1.5rem' }}
              >
                {user?.treesPlanted ?? 0}
              </span>
            </div>
            <p className="text-sm font-medium text-brown-2">Trees Planted</p>
          </div>

          <div className="mt-2.5 flex flex-col gap-2.5">
            <div className="flex flex-row items-center gap-[7px]">
              <Image
                src="/img/mgrow-token-logo.svg"
                alt=""
                width={29}
                height={29}
                className="h-[29px] w-[29px]"
              />
              <span
                className="font-bold leading-none text-brown-2"
                style={{ fontSize: '1.5rem' }}
              >
                {formatMgroCollectedDisplay(user?.tokensClaimed)}
              </span>
            </div>
            <p className="text-sm font-medium text-brown-2">$MGRO Collected</p>
          </div>
        </div>

        {isVerifier && (
          <div className="flex flex-col gap-4 p-6 bg-warm-grey rounded-3xl">
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center">
                <h3 className="font-bold text-2xl">Submissions</h3>
                {Boolean(reviewRows.length) && (
                  <div
                    onClick={() =>
                      router.push(appConfig.routes.SubmissionsReview)
                    }
                    className="flex gap-1 items-center cursor-pointer"
                  >
                    <span
                      role="button"
                      className="text-brown-2 font-bold  text-sm"
                    >
                      View all
                    </span>
                    <FaChevronRight className="w-3 h-3 text-brown-2" />
                  </div>
                )}
              </div>
              <p className="text-xs text-brown-1 max-w-52">
                Review plantations submitted by members
              </p>
            </div>
            {modLoading ? (
              <div className="flex justify-center py-8">
                <Spinner size="md" />
              </div>
            ) : previewReviewRows.length ? (
              <div className="flex flex-col gap-4">
                {previewReviewRows.map(row => (
                  <SubmissionReviewCard
                    key={row.group.submissionId}
                    group={row.group}
                    verifierBadge={row.badge}
                    verifierRewardClaimed={
                      row.badge === 'approved' ? false : null
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="text-tree-green-3 text-sm font-semibold mx-auto">
                No submissions to review
              </p>
            )}
          </div>
        )}

        {isVerifier && (
          <div className="flex flex-col gap-4 p-6 bg-warm-grey rounded-3xl">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-2xl">Health checks</h3>
              {Boolean(hcPreview.length) && (
                <div
                  onClick={() => router.push(appConfig.routes.HealthChecks)}
                  className="flex gap-1 items-center cursor-pointer"
                >
                  <span
                    role="button"
                    className="text-brown-2 font-bold text-sm"
                  >
                    View all
                  </span>
                  <FaChevronRight className="w-3 h-3 text-brown-2" />
                </div>
              )}
            </div>
            {hcLoading ? (
              <div className="flex justify-center py-8">
                <Spinner size="md" />
              </div>
            ) : hcPreview.length ? (
              <ul className="flex flex-col gap-3">
                {hcPreview.map(hc => (
                  <li key={hc._id}>
                    <VerifierHealthCheckCard
                      hc={hc}
                      onClick={() =>
                        router.push(
                          `/health-checks/${encodeURIComponent(hc._id)}?submissionId=${encodeURIComponent(hc.submissionId)}`,
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-tree-green-3 text-sm font-semibold mx-auto">
                No health checks to review
              </p>
            )}
          </div>
        )}

        {isVerifier && <SitesToReviewSection />}

        <div className="flex flex-col gap-4 p-6 bg-warm-grey rounded-3xl">
          <div className="flex justify-between items-center">
            <h3 className="font-bold text-2xl">My Plants</h3>
            {Boolean(myPlantGroups.length) && (
              <div
                className="flex gap-1 items-center cursor-pointer"
                onClick={() => router.push(appConfig.routes.MySubmissions)}
              >
                <span role="button" className="text-brown-2 font-bold  text-sm">
                  View all
                </span>
                <FaChevronRight className="w-3 h-3 text-brown-2" />
              </div>
            )}
          </div>
          {myPlantsLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          ) : latestSubmissions.length ? (
            <div className="flex flex-col gap-4">
              {latestSubmissions.map(group => {
                const clip = primaryVideoFromGroup(group)
                if (!clip) return null
                const awaitingPlant =
                  group.submissionStatus === 'awaiting_plant' ||
                  !group.plantVideo
                return (
                  <SubmissionCard
                    key={group.submissionId}
                    video={clip}
                    detailHref={`${appConfig.routes.MySubmissions}/${encodeURIComponent(group.submissionId)}`}
                    statusMeta={getPlanterSubmissionBadge(group)}
                    aiVerification={group.aiVerification}
                    treeSpecies={group.submissionTreeSpecies}
                    awaitingPlantClip={awaitingPlant && !!group.landVideo}
                    completePlantHref={
                      awaitingPlant
                        ? `/submissions/create/${encodeURIComponent(group.submissionId)}`
                        : undefined
                    }
                    rewardClaimDisplay={
                      typeof rewardClaimedById[group.submissionId] === 'boolean'
                        ? rewardClaimedById[group.submissionId]
                        : null
                    }
                  />
                )
              })}
            </div>
          ) : (
            <>
              <p className="text-xs">
                Without trees, the world loses its breath. Plant your first
                mangrove trees and revive hope.
              </p>
              <Image
                className="mx-auto"
                src={'/img/plant-sign.svg'}
                alt="Plant Sign"
                width={115}
                height={90}
              />
            </>
          )}
        </div>
      </div>
    </>
  )
}
