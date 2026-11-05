/** Mirrors `mobile/apis/RewardAPI.ts` projections. */

export type RewardDisplayState =
  | 'NEXT_CLAIM'
  | 'PENDING_CLAIM'
  | 'COMPLETED'
  | 'NONE'

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
  verifier?: VerifierRewardSlice
  activeClaimJob?: boolean
  healthCheckRequiredForNextClaim?: boolean
  nextPlanterAction?: 'claim' | 'health_check' | 'wait'
  pendingHealthCheckpointIndex?: number | null
  /** OTC: planter MGRO is held until the planter confirms the M-Pesa payment. */
  otcHold?: boolean
  /** OTC: the planter confirmed the M-Pesa payment; the MGRO now goes to the buyer. */
  otcReleased?: boolean
  /** OTC deal bound to this allocation (set whether or not it is still held). */
  otcDealId?: string
}

export type RewardStatusResponse = {
  message: string
  data: RewardStatusProjection
}

export type ClaimEnqueueData = {
  submissionId: string
  jobId: string
  status: string
  claimType: 'planter' | 'verifier' | 'both'
  queuedAt: string
  updatedAt: string
  created: boolean
}

export type ClaimEnqueueResponse = {
  message: string
  data: ClaimEnqueueData
}
