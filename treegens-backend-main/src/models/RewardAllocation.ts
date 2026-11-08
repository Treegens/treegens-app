import mongoose from 'mongoose'

const payoutStatus = ['pending', 'processing', 'paid', 'failed'] as const

/** Who claimed / in-flight; mint amount comes from verifierPoolWei + sorted yes-voters (see rewardService). */
const verifierClaimSchema = new mongoose.Schema(
  {
    wallet: { type: String, required: true, lowercase: true },
    status: {
      type: String,
      enum: payoutStatus,
      required: true,
    },
    txHash: { type: String, required: false },
    lastError: { type: String, required: false },
    /** VerifierMinter proposal id when the mint awaits verifier approval. */
    proposalId: { type: Number, required: false },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
)

const trancheSchema = new mongoose.Schema(
  {
    index: { type: Number, required: true, min: 0 },
    amountWei: { type: String, required: true },
    unlockAt: { type: Date, required: true },
    status: {
      type: String,
      enum: payoutStatus,
      default: 'pending',
    },
    txHash: { type: String, required: false },
    lastError: { type: String, required: false },
    /** VerifierMinter proposal id when the mint awaits verifier approval. */
    proposalId: { type: Number, required: false },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
)

/**
 * Planter MGRO routed to an OTC buyer who pre-paid for `trees` of this
 * planting (see models/OtcPurchase). One row per buyer; its own mint ledger,
 * independent of the planter's survival tranches — the buyer already paid, so
 * their MGRO is minted in full at approval, not vested.
 */
const otcPayoutSchema = new mongoose.Schema(
  {
    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OtcPurchase',
      required: true,
    },
    buyerWallet: { type: String, required: true, lowercase: true },
    trees: { type: Number, required: true, min: 1 },
    amountWei: { type: String, required: true },
    status: {
      type: String,
      enum: payoutStatus,
      default: 'pending',
    },
    txHash: { type: String, required: false },
    lastError: { type: String, required: false },
    /** VerifierMinter proposal id when the mint awaits verifier approval. */
    proposalId: { type: Number, required: false },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
)

const rewardAllocationSchema = new mongoose.Schema(
  {
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Submission',
      required: true,
      unique: true,
      index: true,
    },
    planterWallet: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    treesPlanted: { type: Number, required: true, min: 0 },
    approvedAt: { type: Date, required: true },
    totalMgroWei: { type: String, required: true },
    verifierPoolWei: { type: String, required: true },
    planterTotalWei: { type: String, required: true },
    /** Running total of planter MGRO minted under survival schedule (wei string). */
    planterCumulativePaidWei: { type: String, default: '0' },
    /** floor(verifierPoolWei / N); informational; mint uses full pool split in code. */
    verifierRewardWei: { type: String, required: true },
    yesVoterCount: { type: Number, required: true, min: 0 },
    verifierClaims: {
      type: [verifierClaimSchema],
      default: [],
    },
    tranches: {
      type: [trancheSchema],
      default: [],
    },
    /** Trees of this planting pre-sold OTC (sum of otcPayouts[].trees). */
    otcTreesCovered: { type: Number, default: 0, min: 0 },
    /** MGRO wei routed to OTC buyers instead of the planter (sum of otcPayouts[].amountWei). */
    otcTotalWei: { type: String, default: '0' },
    otcPayouts: {
      type: [otcPayoutSchema],
      default: [],
    },
  },
  { timestamps: true },
)

rewardAllocationSchema.index({ planterWallet: 1, submissionId: 1 })
rewardAllocationSchema.index({
  'verifierClaims.wallet': 1,
  submissionId: 1,
})
rewardAllocationSchema.index(
  { 'otcPayouts.buyerWallet': 1, submissionId: 1 },
  { sparse: true },
)
// The OTC retrier sweeps allocations whose buyer mint has not landed yet.
rewardAllocationSchema.index(
  { 'otcPayouts.status': 1, updatedAt: 1 },
  { sparse: true },
)

export default mongoose.model('RewardAllocation', rewardAllocationSchema)
