/** Mirrors treegens-backend-main/src/models/Otc*.ts and routes/otc.ts. */

export type OtcDealStatus =
  | 'awaiting_count'
  | 'awaiting_payment'
  | 'payment_sent'
  | 'confirmed'
  | 'disputed'
  | 'cancelled'

export type OtcCountSource = 'ai' | 'approved' | 'manual' | 'none'

export type OtcReleaseStatus = 'held' | 'released' | 'returned' | 'n/a'

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
  mpesaRef?: string
  amountKes?: number
  note?: string
  sentAt?: string
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
  payment?: OtcDealPayment
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
  buyer: { walletAddress: string; label: string } | null
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
}

export interface OtcSummary {
  counts: Record<OtcDealStatus, number>
  kesToPay: number
  kesAwaitingConfirmation: number
  kesConfirmed: number
  treesConfirmed: number
  expectedMgroWeiConfirmed: string
  releasedCount: number
  enrollmentCount: number
  defaults: { ratePerTreeKes: number | null }
  telegram: boolean
}

export interface OtcMeResponse {
  isBuyer: boolean
  enrollment: OtcEnrollment | null
  buyer: { walletAddress: string; label: string } | null
  deals: OtcDeal[]
}

export interface OtcPaginated<T> {
  items: T[]
  total: number
  page: number
  limit: number
}

export type OtcEnvelope<T> = { message: string; data: T }
