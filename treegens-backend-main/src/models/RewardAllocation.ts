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
  },
  { timestamps: true },
)

rewardAllocationSchema.index({ planterWallet: 1, submissionId: 1 })
rewardAllocationSchema.index({
  'verifierClaims.wallet': 1,
  submissionId: 1,
})

export default mongoose.model('RewardAllocation', rewardAllocationSchema)
