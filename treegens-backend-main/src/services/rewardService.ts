import mongoose from 'mongoose'
import env from '../config/environment'
import HealthCheck from '../models/HealthCheck'
import RewardAllocation from '../models/RewardAllocation'
import Submission from '../models/Submission'
import User from '../models/User'
import RewardClaimQueueService from './rewardClaimQueueService'
import RewardMintService, {
  PendingVerifierApprovalError,
} from './rewardMintService'

function normalizeWallet(w: string): string {
  return String(w).toLowerCase()
}

function addSeconds(base: Date, seconds: number): Date {
  return new Date(base.getTime() + seconds * 1000)
}

export function computeTotalMgroWei(treesPlanted: number): bigint {
  const trees = BigInt(Math.floor(Math.max(0, treesPlanted)))
  const decimals = BigInt(env.MGRO_DECIMALS)
  const factor = 10n ** decimals
  return trees * factor
}

export function getClaimScheduleConfig(): {
  intervalSeconds: number
  durationSeconds: number
  totalTranches: number
} {
  const intervalSeconds = Math.max(1, env.MGRO_CLAIM_INTERVAL)
  const totalTranches = Math.max(1, env.MGRO_CLAIM_COUNT)
  const durationSeconds = intervalSeconds * totalTranches
  return { intervalSeconds, durationSeconds, totalTranches }
}

/**
 * Latest checkpoint that should be unlocked by elapsed time.
 * 1 == initial claim window at approval; health checks apply to 2..N.
 */
export function computeLatestDueCheckpointOneBased(input: {
  approvedAt: Date | string
  now: Date
  intervalSeconds: number
  totalTranches: number
}): number {
  const N = Math.max(1, Math.floor(input.totalTranches))
  const interval = Math.max(1, Math.floor(input.intervalSeconds))
  const approvedAt =
    input.approvedAt instanceof Date
      ? input.approvedAt
      : new Date(input.approvedAt)
  const elapsedSec = Math.max(
    0,
    Math.floor((input.now.getTime() - approvedAt.getTime()) / 1000),
  )
  const k = Math.floor(elapsedSec / interval) + 1
  return Math.min(N, Math.max(1, k))
}

/**
 * Equal-split amount for tranche index 0 only (remainder goes to last tranche in full N-way split).
 */
export function computeFirstTrancheWei(
  planterTotalWei: bigint,
  totalTranches: number,
): bigint {
  const N = Math.max(1, totalTranches)
  if (planterTotalWei === 0n) return 0n
  return planterTotalWei / BigInt(N)
}

/**
 * Planter total minus first tranche; survival and health checks apply only to this pool across tranches 1..N-1.
 */
export function computeSurvivalPoolWei(
  planterTotalWei: bigint,
  totalTranches: number,
): bigint {
  const first = computeFirstTrancheWei(planterTotalWei, totalTranches)
  const rest = planterTotalWei - first
  return rest > 0n ? rest : 0n
}

/**
 * Cumulative planter wei owed through checkpoint k (1-based).
 * k=1: first tranche only (no survival).
 * k>=2: firstTrancheWei + floor(survivalPool * (k-1) * min(T, treesAlive) / ((N-1) * T)).
 */
export function computeSurvivalPlanterTargetCumulativeWei(input: {
  planterTotalWei: bigint
  checkpointOneBased: number
  initialTrees: number
  treesAlive: number
  totalTranches: number
}): bigint {
  const N = Math.max(1, input.totalTranches)
  const k = Math.min(Math.max(1, input.checkpointOneBased), N)
  const first = computeFirstTrancheWei(input.planterTotalWei, N)
  const survivalPool = computeSurvivalPoolWei(input.planterTotalWei, N)
  if (k === 1) {
    return first
  }
  const T = Math.max(1, Math.floor(input.initialTrees))
  const alive = Math.max(0, Math.floor(input.treesAlive))
  const minTa = BigInt(Math.min(T, alive))
  const nSurv = N - 1
  if (nSurv <= 0 || survivalPool === 0n) {
    return first
  }
  const extra =
    (survivalPool * BigInt(k - 1) * minTa) / (BigInt(nSurv) * BigInt(T))
  return first + extra
}

export function computeSurvivalPlanterPayNow(input: {
  planterTotalWei: bigint
  checkpointOneBased: number
  initialTrees: number
  treesAlive: number
  totalTranches: number
  planterCumulativePaidWei: bigint
}): bigint {
  const target = computeSurvivalPlanterTargetCumulativeWei({
    planterTotalWei: input.planterTotalWei,
    checkpointOneBased: input.checkpointOneBased,
    initialTrees: input.initialTrees,
    treesAlive: input.treesAlive,
    totalTranches: input.totalTranches,
  })
  const paid = input.planterCumulativePaidWei
  return target > paid ? target - paid : 0n
}

export type RewardDisplayState =
  | 'NEXT_CLAIM'
  | 'PENDING_CLAIM'
  | 'COMPLETED'
  | 'NONE'

/** Verifier MGRO slice (for planters who also voted yes, or standalone verifier UI). */
export type VerifierRewardSlice = {
  totalRewardWei: string
  claimedAmountWei: string
  pendingClaimAmountWei: string
  canClaim: boolean
  displayState: RewardDisplayState
  scheduleCompleted: boolean
}

export type RewardStatusProjection = {
  submissionId: string
  allocationId: string
  walletAddress: string
  role: 'planter' | 'verifier'
  totalRewardWei: string
  claimedAmountWei: string
  pendingClaimAmountWei: string
  nextClaimAmountWei: string | null
  nextClaimAt: string | null
  remainingMs: number | null
  isOverdue: boolean
  scheduleCompleted: boolean
  canClaim: boolean
  displayState: RewardDisplayState
  approvedAt: string
  intervalsMissed: number
  /** When the wallet is also a yes-voter, verifier MGRO state (planter primary role). */
  verifier?: VerifierRewardSlice
  /** Set on GET /api/rewards/status/:submissionId — true if a claim job exists for this wallet and is not completed. */
  activeClaimJob?: boolean
  /** Planter: true when the next due tranche requires an approved health check before claiming. */
  healthCheckRequiredForNextClaim?: boolean
  /** Planter UX: primary action for the reward card. */
  nextPlanterAction?: 'claim' | 'health_check' | 'wait'
  /** 1-based checkpoint index when health_check is required, else null. */
  pendingHealthCheckpointIndex?: number | null
}

type RewardAllocationLike = {
  _id: any
  submissionId: any
  approvedAt: Date | string
  planterWallet: string
  planterTotalWei: string
  planterCumulativePaidWei?: string
  treesPlanted?: number
  verifierPoolWei: string
  verifierRewardWei: string
  yesVoterCount: number
  tranches?: Array<{
    index: number
    amountWei: string
    unlockAt: Date
    status: string
    proposalId?: number
  }>
  verifierClaims?: Array<{
    wallet: string
    status: string
    txHash?: string
    lastError?: string
    proposalId?: number
  }>
}

export type HealthCheckLean = {
  checkpointIndex: number
  status: string
  treesAlive?: number
  distanceMeters?: number
}

export type SubmissionVotesLike = {
  votes?: Array<{ voterWalletAddress: string; vote: string }>
  /** Denormalized cumulative planter MGRO wei (updated on mint); listing / analytics. */
  planterRewardClaimedWei?: string | null
}

function sumBigints(values: Array<string | bigint>): bigint {
  return values.reduce<bigint>((acc, v) => acc + BigInt(v), 0n)
}

function getSortedYesWallets(sub: SubmissionVotesLike): string[] {
  const yes = (sub.votes || [])
    .filter(v => v.vote === 'yes')
    .map(v => normalizeWallet(v.voterWalletAddress))
  return [...new Set(yes)].sort((a, b) => a.localeCompare(b))
}

export function isYesVoterForSubmission(
  submission: SubmissionVotesLike,
  wallet: string,
): boolean {
  const w = normalizeWallet(wallet)
  return (submission.votes || []).some(
    v => normalizeWallet(v.voterWalletAddress) === w && v.vote === 'yes',
  )
}

/** Verifier pool is split across yes-voters; status is derived from submission votes + verifierClaims. */
function hasVerifierPool(allocation: RewardAllocationLike): boolean {
  return (
    Number(allocation.yesVoterCount) > 0 &&
    BigInt(allocation.verifierPoolWei || '0') > 0n
  )
}

/** Remainder wei goes to the last wallet in sorted yes-voter order (stable tie-break). */
export function computeVerifierShareWei(
  verifierPoolWei: string,
  sortedYesWallets: string[],
  wallet: string,
): bigint | null {
  const w = normalizeWallet(wallet)
  const n = sortedYesWallets.length
  if (n === 0) return null
  const idx = sortedYesWallets.indexOf(w)
  if (idx === -1) return null
  const pool = BigInt(verifierPoolWei || '0')
  const base = pool / BigInt(n)
  const rem = pool % BigInt(n)
  const lastIdx = n - 1
  return idx === lastIdx ? base + rem : base
}

function hasVerifierPaid(
  allocation: RewardAllocationLike,
  wallet: string,
): boolean {
  const w = normalizeWallet(wallet)
  return (allocation.verifierClaims || []).some(
    c => c.wallet === w && c.status === 'paid',
  )
}

function findVerifierClaimRow(
  allocation: RewardAllocationLike,
  wallet: string,
) {
  const w = normalizeWallet(wallet)
  return (allocation.verifierClaims || []).find(c => c.wallet === w)
}

function buildVerifierSlice(
  allocation: RewardAllocationLike,
  wallet: string,
  sortedYes: string[],
  _now: Date,
): VerifierRewardSlice | null {
  const w = normalizeWallet(wallet)
  const poolWei = String(allocation.verifierPoolWei || '0')
  if (BigInt(poolWei) === 0n || sortedYes.length === 0) return null

  const share = computeVerifierShareWei(poolWei, sortedYes, w)
  if (share === null || share === 0n) return null

  const total = share.toString()
  const paid = hasVerifierPaid(allocation, w)
  const row = findVerifierClaimRow(allocation, w)
  const inFlight = row?.status === 'processing'

  const claimed = paid ? share : 0n
  const pending = paid ? 0n : share

  const canClaim =
    pending > 0n &&
    !paid &&
    !inFlight &&
    (row === undefined || row.status === 'failed')

  let displayState: RewardDisplayState = 'NONE'
  if (paid) {
    displayState = 'COMPLETED'
  } else if (pending > 0n) {
    displayState = 'PENDING_CLAIM'
  }

  return {
    totalRewardWei: total,
    claimedAmountWei: claimed.toString(),
    pendingClaimAmountWei: pending.toString(),
    canClaim,
    displayState,
    scheduleCompleted: paid,
  }
}

export function calculateRewardStatusProjection(
  allocation: RewardAllocationLike,
  walletAddress: string,
  now = new Date(),
  submission?: SubmissionVotesLike | null,
  healthChecks?: HealthCheckLean[] | null,
): RewardStatusProjection {
  const w = normalizeWallet(walletAddress)
  const verifierPoolActive = hasVerifierPool(allocation)
  const sortedYes = submission ? getSortedYesWallets(submission) : []

  const planterProjection = (): RewardStatusProjection => {
    if (healthChecks === undefined) {
      return planterProjectionLegacy()
    }

    const tranches = [...(allocation.tranches || [])].sort(
      (a, b) => a.index - b.index,
    )
    const cumulativeStr = String(allocation.planterCumulativePaidWei ?? '')
    const claimedFromTranches = sumBigints(
      tranches.filter(t => t.status === 'paid').map(t => t.amountWei as string),
    )
    const claimedFromField =
      cumulativeStr && /^\d+$/.test(cumulativeStr) ? BigInt(cumulativeStr) : 0n
    const claimed =
      claimedFromField > 0n ? claimedFromField : claimedFromTranches

    const { intervalSeconds, totalTranches: N } = getClaimScheduleConfig()
    const planterTotal = BigInt(String(allocation.planterTotalWei || '0'))
    const initialTrees = Math.max(
      1,
      Math.floor(Number(allocation.treesPlanted ?? 0)),
    )
    const maxDist = env.HEALTH_CHECK_MAX_DISTANCE_METERS

    const hcList = healthChecks || []
    const approvedForCheckpoint = (k: number) =>
      hcList.find(
        c =>
          c.checkpointIndex === k &&
          c.status === 'approved' &&
          (c.distanceMeters ?? 0) <= maxDist,
      )
    const pendingForCheckpoint = (k: number) =>
      hcList.some(c => c.checkpointIndex === k && c.status === 'pending_review')

    let pendingClaim = 0n
    let nextClaimAmountWei: string | null = null
    let nextClaimAt: string | null = null
    let remainingMs: number | null = null
    let canClaim = false
    let healthCheckRequiredForNextClaim = false
    let nextPlanterAction: 'claim' | 'health_check' | 'wait' = 'wait'
    let pendingHealthCheckpointIndex: number | null = null
    let dueUnpaidCount = 0

    const firstIncomplete = tranches.find(t => t.status !== 'paid')
    const scheduleCompleted =
      tranches.length > 0 && tranches.every(t => t.status === 'paid')
    const approvedAt = new Date(allocation.approvedAt)
    const latestDueCheckpoint = computeLatestDueCheckpointOneBased({
      approvedAt,
      now,
      intervalSeconds,
      totalTranches: N,
    })
    const dueUnpaid = tranches.filter(
      x =>
        x.unlockAt <= now && (x.status === 'pending' || x.status === 'failed'),
    )
    dueUnpaidCount = dueUnpaid.length

    const approvedDueHealthChecks = hcList
      .filter(
        c =>
          c.status === 'approved' &&
          (c.distanceMeters ?? 0) <= maxDist &&
          c.checkpointIndex >= 2 &&
          c.checkpointIndex <= latestDueCheckpoint,
      )
      .sort((a, b) => b.checkpointIndex - a.checkpointIndex)
    const latestApprovedDueHealthCheck =
      approvedDueHealthChecks.length > 0 ? approvedDueHealthChecks[0] : null
    const nextFutureUnpaid = tranches.find(t => {
      if (t.status !== 'pending' && t.status !== 'failed') return false
      const unlockAt =
        t.unlockAt instanceof Date ? t.unlockAt : new Date(t.unlockAt)
      return unlockAt > now
    })

    if (!scheduleCompleted && firstIncomplete) {
      const firstUnlockAt =
        firstIncomplete.unlockAt instanceof Date
          ? firstIncomplete.unlockAt
          : new Date(firstIncomplete.unlockAt)

      if (dueUnpaid.length === 0 && firstUnlockAt > now) {
        nextClaimAmountWei = '0'
        nextClaimAt = firstUnlockAt.toISOString()
        remainingMs = Math.max(0, firstUnlockAt.getTime() - now.getTime())
        nextPlanterAction = 'wait'
        healthCheckRequiredForNextClaim = false
        pendingHealthCheckpointIndex = null
      } else {
        const hasDueFirstTranche = dueUnpaid.some(x => x.index === 0)
        if (hasDueFirstTranche) {
          const payNow = computeSurvivalPlanterPayNow({
            planterTotalWei: planterTotal,
            checkpointOneBased: 1,
            initialTrees,
            treesAlive: initialTrees,
            totalTranches: N,
            planterCumulativePaidWei: claimedFromField,
          })
          pendingClaim = payNow
          nextClaimAmountWei = payNow.toString()
          canClaim = payNow > 0n
          nextPlanterAction = 'claim'
          healthCheckRequiredForNextClaim = false
          pendingHealthCheckpointIndex = null
        } else if (latestApprovedDueHealthCheck) {
          const coveredMaxIndex =
            latestApprovedDueHealthCheck.checkpointIndex - 1
          const hasCoveredDue = dueUnpaid.some(x => x.index <= coveredMaxIndex)
          if (hasCoveredDue) {
            const payNow = computeSurvivalPlanterPayNow({
              planterTotalWei: planterTotal,
              checkpointOneBased: latestApprovedDueHealthCheck.checkpointIndex,
              initialTrees,
              treesAlive: Math.max(
                0,
                Math.floor(latestApprovedDueHealthCheck.treesAlive ?? 0),
              ),
              totalTranches: N,
              planterCumulativePaidWei: claimedFromField,
            })
            pendingClaim = payNow
            nextClaimAmountWei = payNow.toString()
            canClaim = payNow > 0n
            nextPlanterAction = 'claim'
            healthCheckRequiredForNextClaim = false
            pendingHealthCheckpointIndex = null
          }
        }

        if (!canClaim) {
          if (
            latestDueCheckpoint >= 2 &&
            pendingForCheckpoint(latestDueCheckpoint)
          ) {
            nextPlanterAction = 'wait'
            healthCheckRequiredForNextClaim = false
            pendingHealthCheckpointIndex = latestDueCheckpoint
          } else if (
            latestDueCheckpoint >= 2 &&
            !approvedForCheckpoint(latestDueCheckpoint)
          ) {
            healthCheckRequiredForNextClaim = true
            nextPlanterAction = 'health_check'
            pendingHealthCheckpointIndex = latestDueCheckpoint
          } else {
            nextPlanterAction = 'wait'
            healthCheckRequiredForNextClaim = false
            pendingHealthCheckpointIndex = null
          }
        } else {
          nextPlanterAction = 'claim'
        }

        if (!canClaim && !nextClaimAt && nextFutureUnpaid) {
          const nextUnlockAt =
            nextFutureUnpaid.unlockAt instanceof Date
              ? nextFutureUnpaid.unlockAt
              : new Date(nextFutureUnpaid.unlockAt)
          nextClaimAt = nextUnlockAt.toISOString()
          remainingMs = Math.max(0, nextUnlockAt.getTime() - now.getTime())
          nextClaimAmountWei = '0'
        }
      }
    }

    const isOverdue = pendingClaim > 0n

    let displayState: RewardDisplayState = 'NONE'
    if (scheduleCompleted) {
      displayState = 'COMPLETED'
    } else if (pendingClaim > 0n && canClaim) {
      displayState = 'PENDING_CLAIM'
    } else if (nextClaimAt && remainingMs !== null && remainingMs > 0) {
      displayState = 'NEXT_CLAIM'
    } else if (
      healthCheckRequiredForNextClaim ||
      nextPlanterAction === 'health_check'
    ) {
      displayState = 'NEXT_CLAIM'
    } else if (nextPlanterAction === 'wait' && firstIncomplete) {
      if (nextClaimAt && remainingMs !== null) {
        displayState = 'NEXT_CLAIM'
      }
    }

    let verifierSlice: VerifierRewardSlice | undefined
    if (
      submission &&
      isYesVoterForSubmission(submission, w) &&
      verifierPoolActive
    ) {
      const v = buildVerifierSlice(allocation, w, sortedYes, now)
      if (v) verifierSlice = v
    }

    return {
      submissionId: String(allocation.submissionId),
      allocationId: String(allocation._id),
      walletAddress: w,
      role: 'planter',
      totalRewardWei: String(allocation.planterTotalWei || '0'),
      claimedAmountWei: claimed.toString(),
      pendingClaimAmountWei: pendingClaim.toString(),
      nextClaimAmountWei,
      nextClaimAt,
      remainingMs,
      isOverdue,
      scheduleCompleted,
      canClaim,
      displayState,
      approvedAt: new Date(allocation.approvedAt).toISOString(),
      intervalsMissed: dueUnpaidCount,
      verifier: verifierSlice,
      healthCheckRequiredForNextClaim,
      nextPlanterAction,
      pendingHealthCheckpointIndex,
    }
  }

  function planterProjectionLegacy(): RewardStatusProjection {
    const tranches = [...(allocation.tranches || [])].sort(
      (a, b) => a.index - b.index,
    )
    const claimed = sumBigints(
      tranches.filter(t => t.status === 'paid').map(t => t.amountWei as string),
    )
    const dueUnpaid = tranches.filter(
      t =>
        t.unlockAt <= now &&
        (t.status === 'pending' || t.status === 'failed') &&
        t.amountWei !== '0',
    )
    const pendingClaim = sumBigints(dueUnpaid.map(t => t.amountWei as string))
    const nextUnpaid = tranches.find(
      t =>
        t.status !== 'paid' &&
        (t.status === 'pending' || t.status === 'failed') &&
        t.amountWei !== '0',
    )

    const nextClaimAmountWei =
      nextUnpaid && nextUnpaid.unlockAt > now
        ? String(nextUnpaid.amountWei)
        : null
    const nextClaimAt =
      nextUnpaid && nextUnpaid.unlockAt > now
        ? new Date(nextUnpaid.unlockAt).toISOString()
        : null
    const remainingMs =
      nextUnpaid && nextUnpaid.unlockAt > now
        ? Math.max(0, nextUnpaid.unlockAt.getTime() - now.getTime())
        : null

    const scheduleCompleted =
      tranches.length > 0 && tranches.every(t => t.status === 'paid')
    const isOverdue = pendingClaim > 0n
    const canClaim = pendingClaim > 0n

    let displayState: RewardDisplayState = 'NONE'
    if (scheduleCompleted) {
      displayState = 'COMPLETED'
    } else if (pendingClaim > 0n) {
      displayState = 'PENDING_CLAIM'
    } else if (nextClaimAmountWei) {
      displayState = 'NEXT_CLAIM'
    }

    let verifierSlice: VerifierRewardSlice | undefined
    if (
      submission &&
      isYesVoterForSubmission(submission, w) &&
      verifierPoolActive
    ) {
      const v = buildVerifierSlice(allocation, w, sortedYes, now)
      if (v) verifierSlice = v
    }

    return {
      submissionId: String(allocation.submissionId),
      allocationId: String(allocation._id),
      walletAddress: w,
      role: 'planter',
      totalRewardWei: String(allocation.planterTotalWei || '0'),
      claimedAmountWei: claimed.toString(),
      pendingClaimAmountWei: pendingClaim.toString(),
      nextClaimAmountWei,
      nextClaimAt,
      remainingMs,
      isOverdue,
      scheduleCompleted,
      canClaim,
      displayState,
      approvedAt: new Date(allocation.approvedAt).toISOString(),
      intervalsMissed: dueUnpaid.length,
      verifier: verifierSlice,
    }
  }

  if (allocation.planterWallet === w) {
    return planterProjection()
  }

  if (!submission) {
    throw new Error('Submission context required for verifier reward status')
  }
  if (!isYesVoterForSubmission(submission, w)) {
    throw new Error('This wallet has no reward allocation for this submission')
  }
  const v = buildVerifierSlice(allocation, w, sortedYes, now)
  if (!v) {
    throw new Error('This wallet has no reward allocation for this submission')
  }
  return {
    submissionId: String(allocation.submissionId),
    allocationId: String(allocation._id),
    walletAddress: w,
    role: 'verifier',
    totalRewardWei: v.totalRewardWei,
    claimedAmountWei: v.claimedAmountWei,
    pendingClaimAmountWei: v.pendingClaimAmountWei,
    nextClaimAmountWei: null,
    nextClaimAt: null,
    remainingMs: null,
    isOverdue: v.pendingClaimAmountWei !== '0',
    scheduleCompleted: v.scheduleCompleted,
    canClaim: v.canClaim,
    displayState: v.displayState,
    approvedAt: new Date(allocation.approvedAt).toISOString(),
    intervalsMissed: v.pendingClaimAmountWei !== '0' ? 1 : 0,
  }
}

export class RewardService {
  private mintService = new RewardMintService()
  private rewardClaimQueueService = new RewardClaimQueueService()

  private async addClaimedTokensForWallet(
    walletAddress: string,
    amountWei: string,
  ): Promise<void> {
    const w = normalizeWallet(walletAddress)
    const incWei = BigInt(amountWei || '0')
    if (incWei <= 0n) return

    const user = await User.findOne({ walletAddress: w }).select(
      '_id walletAddress tokensClaimed',
    )
    if (!user) {
      return
    }

    const rawCurrent = String((user as any).tokensClaimed || '0')
    const currentWei = /^\d+$/.test(rawCurrent) ? BigInt(rawCurrent) : 0n
    const nextWei = currentWei + incWei

    await User.updateOne(
      { _id: (user as any)._id },
      { $set: { tokensClaimed: nextWei.toString() } },
    )
  }

  /**
   * Whether the wallet may use planter and/or verifier parts of POST /claim.
   */
  getClaimEligibility(
    submission: { status?: string; votes?: SubmissionVotesLike['votes'] },
    allocation: {
      planterWallet: string
      yesVoterCount: number
      verifierPoolWei: string
    },
    walletAddress: string,
  ): { planter: boolean; verifier: boolean } {
    const w = normalizeWallet(walletAddress)
    const planter = allocation.planterWallet === w
    let verifier = false
    if (
      submission.status === 'approved' &&
      isYesVoterForSubmission(submission, w)
    ) {
      verifier =
        Number(allocation.yesVoterCount) > 0 &&
        BigInt(allocation.verifierPoolWei || '0') > 0n
    }
    return { planter, verifier }
  }

  /**
   * Build allocation document fields from an approved submission. Returns null if no rewards apply.
   */
  buildAllocationFields(submission: {
    _id: mongoose.Types.ObjectId
    userWalletAddress?: string | null
    treesPlanted?: number | null
    votes?: {
      voterWalletAddress: string
      vote: string
    }[]
  }): Record<string, unknown> | null {
    const trees = Math.floor(Number(submission.treesPlanted ?? 0))
    if (!trees || trees <= 0) {
      return null
    }
    const planter = submission.userWalletAddress
    if (!planter || !planter.trim()) {
      console.warn(
        '[RewardService] Skipping allocation: missing userWalletAddress',
        { submissionId: submission._id },
      )
      return null
    }
    const planterWallet = normalizeWallet(planter)
    const yesWallets = (submission.votes || [])
      .filter(v => v.vote === 'yes')
      .map(v => normalizeWallet(v.voterWalletAddress))
    // Defense in depth: the planter can never be paid from the verifier pool
    // for their own submission, even if a self-vote somehow slipped through.
    const uniqueYes = [...new Set(yesWallets)]
      .filter(w => w !== planterWallet)
      .sort((a, b) => a.localeCompare(b))

    const totalMgroWei = computeTotalMgroWei(trees)
    const verifierPoolWei = (totalMgroWei * 5n) / 100n
    const planterTotalWei = totalMgroWei - verifierPoolWei
    const n = uniqueYes.length
    const verifierRewardWei =
      n > 0 ? (verifierPoolWei / BigInt(n)).toString() : '0'

    const approvedAt = new Date()
    const { intervalSeconds, totalTranches } = getClaimScheduleConfig()
    const tranches = Array.from({ length: totalTranches }, (_, index) => ({
      index,
      amountWei: '0',
      unlockAt: addSeconds(approvedAt, intervalSeconds * index),
      status: 'pending' as const,
    }))

    return {
      submissionId: submission._id,
      planterWallet,
      treesPlanted: trees,
      approvedAt,
      totalMgroWei: totalMgroWei.toString(),
      verifierPoolWei: verifierPoolWei.toString(),
      planterTotalWei: planterTotalWei.toString(),
      planterCumulativePaidWei: '0',
      yesVoterCount: n,
      verifierRewardWei,
      verifierClaims: [],
      tranches,
    }
  }

  async getRewardStatusForWallet(
    submissionId: string,
    walletAddress: string,
    now = new Date(),
  ): Promise<RewardStatusProjection> {
    const w = normalizeWallet(walletAddress)
    const sid = new mongoose.Types.ObjectId(submissionId)
    const allocation = await RewardAllocation.findOne({ submissionId: sid })
    if (!allocation) {
      throw new Error('No reward allocation for this submission')
    }
    const submission = await Submission.findById(sid).lean()
    if (!submission) {
      throw new Error('Submission not found')
    }
    const healthDocs = await HealthCheck.find({ submissionId: sid })
      .select('checkpointIndex status treesAlive distanceMeters')
      .lean()
    const healthChecks: HealthCheckLean[] = healthDocs.map(d => ({
      checkpointIndex: d.checkpointIndex,
      status: d.status,
      treesAlive: d.treesAlive,
      distanceMeters: d.distanceMeters,
    }))
    return calculateRewardStatusProjection(
      allocation as any,
      w,
      now,
      submission as SubmissionVotesLike,
      healthChecks,
    )
  }

  async ensureAllocationFromApprovedSubmission(
    submission: mongoose.Document & {
      _id: mongoose.Types.ObjectId
      status?: string
      userWalletAddress?: string | null
      treesPlanted?: number | null
      votes?: { voterWalletAddress: string; vote: string }[]
    },
  ): Promise<{ created: boolean; allocationId?: string }> {
    if (submission.status !== 'approved') {
      return { created: false }
    }

    const existing = await RewardAllocation.findOne({
      submissionId: submission._id,
    })
    if (existing) {
      return { created: false, allocationId: String(existing._id) }
    }

    const fields = this.buildAllocationFields(submission)
    if (!fields) {
      return { created: false }
    }

    try {
      const doc = await RewardAllocation.create(fields as any)
      return { created: true, allocationId: String(doc._id) }
    } catch (e: any) {
      if (e?.code === 11000) {
        const again = await RewardAllocation.findOne({
          submissionId: submission._id,
        })
        if (again) {
          return { created: false, allocationId: String(again._id) }
        }
      }
      throw e
    }
  }

  /**
   * After approval: create allocation if needed and enqueue planter claim processing.
   * Verifier MGRO remains manual via POST /claim.
   */
  async handleSubmissionApproved(
    submission: mongoose.Document & {
      _id: mongoose.Types.ObjectId
      status?: string
      userWalletAddress?: string | null
      treesPlanted?: number | null
      votes?: { voterWalletAddress: string; vote: string }[]
    },
  ): Promise<{
    allocationCreated: boolean
    allocationId?: string
    claimJobEnqueued: boolean
    claimJobId?: string
  }> {
    const { created } =
      await this.ensureAllocationFromApprovedSubmission(submission)

    const allocation = await RewardAllocation.findOne({
      submissionId: submission._id,
    })

    if (!allocation) {
      return {
        allocationCreated: created,
        claimJobEnqueued: false,
      }
    }

    if (!created) {
      return {
        allocationCreated: false,
        allocationId: String(allocation._id),
        claimJobEnqueued: false,
      }
    }

    const pw = normalizeWallet(String(allocation.planterWallet || ''))
    try {
      const { job } = await this.rewardClaimQueueService.enqueueOrReuseClaimJob(
        {
          submissionId: String(submission._id),
          walletAddress: pw,
          claimType: 'planter',
        },
      )
      return {
        allocationCreated: true,
        allocationId: String(allocation._id),
        claimJobEnqueued: true,
        claimJobId: String(job.jobId),
      }
    } catch (e: any) {
      console.warn('enqueue planter claim after approval:', e?.message || e)
      return {
        allocationCreated: true,
        allocationId: String(allocation._id),
        claimJobEnqueued: false,
      }
    }
  }

  private async reloadAllocation(allocationId: mongoose.Types.ObjectId) {
    const a = await RewardAllocation.findById(allocationId)
    if (!a) throw new Error('Reward allocation not found')
    return a
  }

  /**
   * Mint verifier share: amount from verifierPoolWei / sorted yes-voters; ledger in verifierClaims only.
   */
  async tryMintVerifierPayout(
    allocationId: mongoose.Types.ObjectId,
    wallet: string,
    submission: SubmissionVotesLike & { _id?: unknown },
  ): Promise<{ ok: boolean; txHash?: string; reason?: string }> {
    const w = normalizeWallet(wallet)
    const allocation = await this.reloadAllocation(allocationId)
    const alloc = allocation.toObject() as unknown as RewardAllocationLike
    if (!isYesVoterForSubmission(submission, w)) {
      return {
        ok: false,
        reason: 'Verifier did not vote yes on this submission',
      }
    }

    const sortedYes = getSortedYesWallets(submission)
    const expectedN = Number(alloc.yesVoterCount ?? -1)
    if (sortedYes.length !== expectedN) {
      return {
        ok: false,
        reason: 'Yes-voter count no longer matches allocation snapshot',
      }
    }

    const amount = computeVerifierShareWei(
      String(alloc.verifierPoolWei || '0'),
      sortedYes,
      w,
    )
    if (amount === null || amount === 0n) {
      return { ok: false, reason: 'No verifier reward for this wallet' }
    }

    if (hasVerifierPaid(alloc, w)) {
      return { ok: false, reason: 'Already paid or zero amount' }
    }

    const amountStr = amount.toString()
    const id = allocation._id as mongoose.Types.ObjectId

    const pushNew = await RewardAllocation.updateOne(
      {
        _id: id,
        verifierClaims: { $not: { $elemMatch: { wallet: w } } },
      },
      {
        $push: {
          verifierClaims: {
            wallet: w,
            status: 'processing',
            updatedAt: new Date(),
          },
        },
      },
    )

    let locked = pushNew.modifiedCount > 0

    if (!locked) {
      const unlockFailed = await RewardAllocation.updateOne(
        { _id: id },
        {
          $set: {
            'verifierClaims.$[v].status': 'processing',
            'verifierClaims.$[v].updatedAt': new Date(),
            'verifierClaims.$[v].lastError': undefined,
          },
        },
        {
          arrayFilters: [{ 'v.wallet': w, 'v.status': 'failed' }],
        },
      )
      locked = unlockFailed.modifiedCount > 0
    }

    if (!locked) {
      const row = findVerifierClaimRow(alloc, w)
      if (row?.status === 'processing') {
        return { ok: false, reason: 'Claim already in progress' }
      }
      return { ok: false, reason: 'Could not lock payout (not pending?)' }
    }

    try {
      const priorRow = findVerifierClaimRow(alloc, w)
      const result = await this.mintService.mintTo(w, amountStr, {
        evidenceURI: `treegens://submission/${String(alloc.submissionId)}/verifier/${w}`,
        existingProposalId: priorRow?.proposalId,
      })
      await RewardAllocation.updateOne(
        { _id: id },
        {
          $set: {
            'verifierClaims.$[v].status': 'paid',
            'verifierClaims.$[v].txHash': result.txHash,
            'verifierClaims.$[v].lastError': undefined,
            'verifierClaims.$[v].updatedAt': new Date(),
          },
        },
        { arrayFilters: [{ 'v.wallet': w, 'v.status': 'processing' }] },
      )
      await this.addClaimedTokensForWallet(w, amountStr)
      return { ok: true, txHash: result.txHash }
    } catch (err: any) {
      const msg = err?.message || String(err)
      const pendingProposalId =
        err instanceof PendingVerifierApprovalError ? err.proposalId : undefined
      await RewardAllocation.updateOne(
        { _id: id },
        {
          $set: {
            'verifierClaims.$[v].status': 'failed',
            'verifierClaims.$[v].lastError': msg,
            'verifierClaims.$[v].updatedAt': new Date(),
            ...(pendingProposalId !== undefined
              ? { 'verifierClaims.$[v].proposalId': pendingProposalId }
              : {}),
          },
        },
        { arrayFilters: [{ 'v.wallet': w, 'v.status': 'processing' }] },
      )
      if (pendingProposalId !== undefined) {
        // Not a failure: the mint is on-chain awaiting verifier approvals.
        return { ok: false, reason: msg }
      }
      throw err
    }
  }

  /** Keep Submission.planterRewardClaimedWei in sync with allocation cumulative (denormalized for clients). */
  private async syncSubmissionPlanterRewardClaimed(
    submissionId: mongoose.Types.ObjectId,
    cumulativeWei: bigint,
  ) {
    await Submission.updateOne(
      { _id: submissionId },
      { $set: { planterRewardClaimedWei: cumulativeWei.toString() } },
    )
  }

  async tryMintPlanterTranches(
    allocationId: mongoose.Types.ObjectId,
    planterWallet: string,
    onlyDue = true,
  ): Promise<{
    txHashes: string[]
    amountsWei: string[]
    /** Set when a tranche is on-chain awaiting verifier approvals. */
    pendingVerifierProposalId?: number
  }> {
    const pw = normalizeWallet(planterWallet)
    let allocation = await this.reloadAllocation(allocationId)
    if (allocation.planterWallet !== pw) {
      throw new Error('Planter wallet mismatch')
    }

    const now = new Date()
    const txHashes: string[] = []
    const amountsWei: string[] = []

    const { totalTranches: N } = getClaimScheduleConfig()
    const maxHealthCheckDistance = env.HEALTH_CHECK_MAX_DISTANCE_METERS
    const latestApprovedHealthCheckpoint = await HealthCheck.findOne({
      submissionId: allocation.submissionId,
      status: 'approved',
      checkpointIndex: { $gte: 2, $lte: N },
      distanceMeters: { $lte: maxHealthCheckDistance },
    })
      .sort({ checkpointIndex: -1 })
      .select('checkpointIndex treesAlive')
      .lean()

    const catchupCheckpoint = latestApprovedHealthCheckpoint
      ? Math.max(2, Math.min(N, latestApprovedHealthCheckpoint.checkpointIndex))
      : null
    const catchupTreesAlive = latestApprovedHealthCheckpoint
      ? Math.max(
          0,
          Math.floor(Number(latestApprovedHealthCheckpoint.treesAlive ?? 0)),
        )
      : null

    const planterTotal = BigInt(String(allocation.planterTotalWei || '0'))
    const initialTrees = Math.max(
      1,
      Math.floor(Number(allocation.treesPlanted || 0)),
    )

    const tranches = [...(allocation.tranches || [])].sort(
      (a, b) => a.index - b.index,
    )

    for (const t of tranches) {
      if (onlyDue && t.unlockAt > now) continue
      if (t.status === 'paid') continue

      const k = t.index + 1

      allocation = await this.reloadAllocation(allocationId)
      let cumulative = BigInt(
        String(allocation.planterCumulativePaidWei || '0'),
      )

      let payNow: bigint

      if (t.index === 0) {
        payNow = computeSurvivalPlanterPayNow({
          planterTotalWei: planterTotal,
          checkpointOneBased: 1,
          initialTrees,
          treesAlive: initialTrees,
          totalTranches: N,
          planterCumulativePaidWei: cumulative,
        })
      } else {
        if (catchupCheckpoint === null || catchupTreesAlive === null) continue
        if (k > catchupCheckpoint) {
          continue
        }

        payNow = computeSurvivalPlanterPayNow({
          planterTotalWei: planterTotal,
          checkpointOneBased: catchupCheckpoint,
          initialTrees,
          treesAlive: catchupTreesAlive,
          totalTranches: N,
          planterCumulativePaidWei: cumulative,
        })
      }

      const amountStr = payNow.toString()

      const locked = await RewardAllocation.updateOne(
        { _id: allocationId },
        {
          $set: {
            'tranches.$[tr].status': 'processing',
            'tranches.$[tr].updatedAt': new Date(),
          },
        },
        {
          arrayFilters: [
            {
              'tr.index': t.index,
              'tr.status': { $in: ['pending', 'failed'] },
            },
          ],
        },
      )
      if (locked.modifiedCount === 0) continue

      try {
        if (payNow > 0n) {
          const result = await this.mintService.mintTo(pw, amountStr, {
            evidenceURI: `treegens://submission/${String(allocation.submissionId)}/planter/tranche/${t.index}`,
            existingProposalId: (t as { proposalId?: number }).proposalId,
          })
          cumulative += payNow
          await RewardAllocation.updateOne(
            { _id: allocationId },
            {
              $set: {
                planterCumulativePaidWei: cumulative.toString(),
                'tranches.$[tr].status': 'paid',
                'tranches.$[tr].amountWei': amountStr,
                'tranches.$[tr].txHash': result.txHash,
                'tranches.$[tr].lastError': undefined,
                'tranches.$[tr].updatedAt': new Date(),
              },
            },
            {
              arrayFilters: [
                { 'tr.index': t.index, 'tr.status': 'processing' },
              ],
            },
          )
          await this.addClaimedTokensForWallet(pw, amountStr)
          await this.syncSubmissionPlanterRewardClaimed(
            allocation.submissionId as mongoose.Types.ObjectId,
            cumulative,
          )
          txHashes.push(result.txHash)
          amountsWei.push(amountStr)
        } else {
          await RewardAllocation.updateOne(
            { _id: allocationId },
            {
              $set: {
                'tranches.$[tr].status': 'paid',
                'tranches.$[tr].amountWei': '0',
                'tranches.$[tr].lastError': undefined,
                'tranches.$[tr].updatedAt': new Date(),
              },
            },
            {
              arrayFilters: [
                { 'tr.index': t.index, 'tr.status': 'processing' },
              ],
            },
          )
          await this.syncSubmissionPlanterRewardClaimed(
            allocation.submissionId as mongoose.Types.ObjectId,
            cumulative,
          )
        }
      } catch (err: any) {
        const msg = err?.message || String(err)
        const pendingProposalId =
          err instanceof PendingVerifierApprovalError
            ? err.proposalId
            : undefined
        await RewardAllocation.updateOne(
          { _id: allocationId },
          {
            $set: {
              'tranches.$[tr].status': 'failed',
              'tranches.$[tr].lastError': msg,
              'tranches.$[tr].updatedAt': new Date(),
              ...(pendingProposalId !== undefined
                ? { 'tranches.$[tr].proposalId': pendingProposalId }
                : {}),
            },
          },
          {
            arrayFilters: [{ 'tr.index': t.index, 'tr.status': 'processing' }],
          },
        )
        if (pendingProposalId !== undefined) {
          // The mint is proposed on-chain and waits for verifier approvals.
          // Stop here so one claim never opens several parallel proposals.
          return {
            txHashes,
            amountsWei,
            pendingVerifierProposalId: pendingProposalId,
          }
        }
        throw err
      }
    }

    return { txHashes, amountsWei }
  }

  /**
   * Claim all eligible rewards for JWT wallet: verifier (if yes-voter) then planter tranches.
   */
  async claimForWallet(
    submissionId: string,
    walletAddress: string,
  ): Promise<{
    verifier?: { txHash?: string; amountWei?: string; skippedReason?: string }
    planter?: { txHashes: string[]; amountsWei: string[] }
    allocation: any
    nothingToClaim: boolean
    status: RewardStatusProjection
    /** Set when a mint is proposed on-chain awaiting verifier approvals. */
    pendingVerifierProposalId?: number
  }> {
    if (!this.mintService.isConfigured()) {
      throw new Error(
        'MGRO rewards are not configured (set BASE_RPC_URL and MGRO_MINTER_PRIVATE_KEY)',
      )
    }

    const w = normalizeWallet(walletAddress)
    const sid = new mongoose.Types.ObjectId(submissionId)
    const submission = await Submission.findById(sid)
    if (!submission || submission.status !== 'approved') {
      throw new Error('Submission not found or not approved')
    }

    const allocation = await RewardAllocation.findOne({ submissionId: sid })
    if (!allocation) {
      throw new Error('No reward allocation for this submission')
    }

    const { planter: eligiblePlanter, verifier: eligibleVerifier } =
      this.getClaimEligibility(submission, allocation, w)

    const result: {
      verifier?: { txHash?: string; amountWei?: string; skippedReason?: string }
      planter?: { txHashes: string[]; amountsWei: string[] }
      allocation: any
      nothingToClaim: boolean
      status: RewardStatusProjection
      pendingVerifierProposalId?: number
    } = {
      nothingToClaim: true,
      allocation,
      status: await this.getRewardStatusForWallet(submissionId, w),
    }

    if (eligibleVerifier) {
      const allocLike = allocation.toObject() as unknown as RewardAllocationLike
      const row = findVerifierClaimRow(allocLike, w)
      const shouldTry =
        !hasVerifierPaid(allocLike, w) &&
        row?.status !== 'processing' &&
        (!row || row.status === 'failed')

      if (shouldTry) {
        const expectedWei = computeVerifierShareWei(
          String(allocation.verifierPoolWei),
          getSortedYesWallets(submission),
          w,
        )?.toString()
        try {
          const minted = await this.tryMintVerifierPayout(
            allocation._id,
            w,
            submission,
          )
          result.verifier = {
            txHash: minted.txHash,
            amountWei: expectedWei,
            skippedReason: minted.ok ? undefined : minted.reason,
          }
          if (minted.ok) result.nothingToClaim = false
        } catch (e: any) {
          result.verifier = {
            amountWei: expectedWei,
            skippedReason: e?.message || String(e),
          }
        }
      }
    }

    if (eligiblePlanter) {
      const planterResult = await this.tryMintPlanterTranches(
        allocation._id,
        w,
        true,
      )
      if (planterResult.txHashes.length > 0) {
        result.planter = planterResult
        result.nothingToClaim = false
      }
      if (planterResult.pendingVerifierProposalId !== undefined) {
        result.pendingVerifierProposalId =
          planterResult.pendingVerifierProposalId
      }
    }

    const fresh = await RewardAllocation.findById(allocation._id)
    result.allocation = fresh
    result.status = await this.getRewardStatusForWallet(submissionId, w)

    return result
  }
}

export default RewardService
