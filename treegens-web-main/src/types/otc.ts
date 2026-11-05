/** Mirrors treegens-backend-main/src/models/Otc*.ts and routes/otc.ts. */

export type OtcDealStatus =
  | 'awaiting_count'
  | 'awaiting_payment'
  | 'payment_sent'
  | 'confirmed'
  | 'disputed'
  | 'cancelled'

export type OtcCountSource = 'ai' | 'approved' | 'manual' | 'none'

export type OtcReleaseStatus =
  | 'held'
  | 'released'
  | 'returned'
  | 'n/a'
  | 'unfundable'

export type OtcReleaseMode = 'full' | 'vesting'

export type OtcPayOn = 'ai_count' | 'approval'

export type OtcDisputeReasonCode =
  | 'nothing_arrived'
  | 'wrong_amount'
  | 'wrong_number'
  | 'other'

export type OtcResolutionOutcome = 'release_to_buyer' | 'return_to_planter'

export interface OtcInvite {
  _id: string
  code: string
  buyerWallet: string
  label?: string
  ratePerTreeKes: number
  maxUses: number | null
  uses: number
  expiresAt: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
  /** Full join URL, computed by the API. */
  url: string
}

export interface OtcInvitePreview {
  code: string
  label: string
  buyerLabel: string
  buyerWallet: string
  ratePerTreeKes: number
  isActive: boolean
  expired: boolean
  exhausted: boolean
  acceptable: boolean
  reason?: 'inactive' | 'expired' | 'exhausted' | null
  /** How the planter's MGRO is released to the buyer (D1). */
  releaseMode?: OtcReleaseMode
}

export interface OtcEnrollment {
  _id: string
  planterWallet: string
  buyerWallet: string
  inviteId?: string
  inviteCode?: string
  mpesaNumber: string
  mpesaName: string
  ratePerTreeKes: number
  status: 'active' | 'paused'
  joinedAt: string
  createdAt: string
  updatedAt: string
}

export interface OtcEnrollmentRow extends OtcEnrollment {
  planterName?: string
  dealCounts: {
    total: number
    awaiting_count: number
    awaiting_payment: number
    payment_sent: number
    confirmed: number
    disputed: number
    cancelled: number
  }
}

export interface OtcDealPayment {
  screenshotUrl?: string
  screenshotPath?: string
  mimeType?: string
  /** Full code for the buyer; masked (`••••••••K1`) when the planter is viewing. */
  mpesaRef?: string
  /** Last 2 characters of the code; only present on planter-facing responses. */
  mpesaRefHint?: string
  amountKes?: number
  /** Buyer ticked "partial payment" because amountKes differs from the deal. */
  partial?: boolean
  note?: string
  sentAt?: string
}

export interface OtcDealResolution {
  outcome: OtcResolutionOutcome
  evidence: string
  by: string
  at: string
}

export interface OtcDealEvent {
  type: string
  at: string
  by: string
  note?: string
}

export interface OtcDeal {
  _id: string
  submissionId: string
  planterWallet: string
  buyerWallet: string
  enrollmentId?: string
  mpesaNumber: string
  mpesaName: string
  trees: number
  countSource: OtcCountSource
  ratePerTreeKes: number
  amountKes: number
  expectedMgroWei: string
  status: OtcDealStatus
  /** Why the deal is not payable yet (batch rule, AI failure, awaiting approval). */
  countNote?: string
  /** True when the submission is approved or the AI auto-approved it. */
  verified?: boolean
  /** Denormalised snapshot of the submission status. */
  submissionStatus?: string
  payment?: OtcDealPayment
  resolution?: OtcDealResolution
  cancelledFromStatus?: string
  reminderSentAt?: string
  confirmedAt?: string
  disputedAt?: string
  disputeReason?: string
  cancelledAt?: string
  cancelReason?: string
  cancelledBy?: string
  release: {
    status: OtcReleaseStatus
    allocationId?: string
    releasedAt?: string
    returnedAt?: string
    claimJobId?: string
  }
  events: OtcDealEvent[]
  createdAt: string
  updatedAt: string
}

export interface OtcDealSubmissionSummary {
  _id: string
  status: string
  treesPlanted?: number
  treeType?: string
  reviewedAt?: string
  aiVerification?: {
    status?: string
    countedMangroves?: number
    confidence?: number
    decision?: string
    error?: string
    skipReason?: string
  }
  plant?: {
    publicUrl?: string
    rawPublicUrl?: string
    reverseGeocode?: string
    gpsCoordinates?: { latitude: number; longitude: number }
    uploadedAt?: string
  }
}

export interface OtcDealDetail extends OtcDeal {
  submission: OtcDealSubmissionSummary | null
  planter: { walletAddress: string; name?: string } | null
  enrollment: {
    mpesaNumber: string
    mpesaName: string
    ratePerTreeKes: number
    status: 'active' | 'paused'
  } | null
  /** Desk-only invite label (D9); never show it to the planter. */
  buyer: { walletAddress: string; label: string } | null
  /** Planter-facing buyer name (`OTC_BUYER_DISPLAY_NAME`, default TreeGens). */
  buyerLabel?: string
  allocation: {
    exists: boolean
    hold: boolean
    planterWallet?: string
    planterCumulativePaidWei?: string
    planterTotalWei?: string
    tranches?: Array<{
      index: number
      status: string
      txHash?: string
      amountWei?: string
      unlockAt?: string
    }>
  }
  releaseMode?: OtcReleaseMode
  confirmRequiresRef?: boolean
}

export interface OtcSummary {
  counts: Record<OtcDealStatus, number>
  kesToPay: number
  kesAwaitingConfirmation: number
  kesConfirmed: number
  /** Sum of every payment uploaded, any status. */
  kesSent?: number
  treesConfirmed: number
  expectedMgroWeiConfirmed: string
  releasedCount: number
  unfundableCount?: number
  enrollmentCount: number
  defaults: { ratePerTreeKes: number | null }
  telegram: boolean
  releaseMode?: OtcReleaseMode
  payOn?: OtcPayOn
}

/** Row of GET /api/otc/enrollments/:planterWallet/submissions (desk picker). */
export interface OtcEligibleSubmission {
  submissionId: string
  status: string
  treesPlanted?: number
  aiCount?: number | null
  treeType?: string
  uploadedAt?: string
  location?: string
  hasDeal: boolean
  eligible: boolean
  ineligibleReason?: string | null
}

/** Summary attached to the plant-clip upload response when a deal was created. */
export interface OtcDealUploadSummary {
  id: string
  status: OtcDealStatus
  amountKes: number
  trees: number
}

export interface OtcMeResponse {
  isBuyer: boolean
  enrollment: OtcEnrollment | null
  /** `label` is the desk-only invite label; planters see `displayName` (D9). */
  buyer: {
    walletAddress: string
    label: string
    displayName?: string
  } | null
  deals: OtcDeal[]
}

export interface OtcPaginated<T> {
  items: T[]
  total: number
  page: number
  limit: number
}

export type OtcEnvelope<T> = { message: string; data: T }
