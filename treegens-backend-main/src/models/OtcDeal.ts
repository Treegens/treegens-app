import mongoose from 'mongoose'
import { OTC_DEAL_STATUSES } from '../services/otcDealRules'

/**
 * One M-Pesa payout for one planting.
 *
 * Created the moment an enrolled planter's plant clip is uploaded and the AI
 * has counted it. The buyer pays KES outside the app, uploads the M-Pesa
 * screenshot here, the planter confirms, and the planter's MGRO for the
 * submission is released to the buyer (see RewardAllocation.otc).
 */
const paymentSchema = new mongoose.Schema(
  {
    screenshotUrl: { type: String, required: false },
    screenshotPath: { type: String, required: false },
    mimeType: { type: String, required: false },
    /** M-Pesa transaction code, stored upper-case; the planter must type it to confirm. */
    mpesaRef: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 40,
    },
    amountKes: { type: Number, required: false, min: 0 },
    /** Buyer sent a different amount than the deal and said so explicitly (D10). */
    partial: { type: Boolean, required: false },
    note: { type: String, required: false, trim: true, maxlength: 500 },
    sentAt: { type: Date, required: false },
  },
  { _id: false },
)

const resolutionSchema = new mongoose.Schema(
  {
    outcome: {
      type: String,
      enum: ['release_to_buyer', 'return_to_planter'],
      required: true,
    },
    /** The buyer's written evidence; shown on the deal timeline. */
    evidence: { type: String, required: true, trim: true, maxlength: 1000 },
    by: { type: String, required: true, lowercase: true, trim: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
)

const releaseSchema = new mongoose.Schema(
  {
    /**
     * held      planter MGRO is on hold on the allocation
     * released  allocation reassigned to the buyer
     * returned  hold lifted back to the planter (deal cancelled)
     * n/a       no allocation exists yet (submission not approved)
     * unfundable submission rejected after KES went out: no MGRO will mint
     */
    status: {
      type: String,
      enum: ['held', 'released', 'returned', 'n/a', 'unfundable'],
      default: 'n/a',
    },
    allocationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RewardAllocation',
      required: false,
    },
    releasedAt: { type: Date, required: false },
    returnedAt: { type: Date, required: false },
    claimJobId: { type: String, required: false },
  },
  { _id: false },
)

const eventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true, maxlength: 64 },
    at: { type: Date, required: true, default: Date.now },
    /** Wallet of the actor, or 'system'. */
    by: { type: String, required: true, trim: true, lowercase: true },
    note: { type: String, required: false, trim: true, maxlength: 500 },
  },
  { _id: false },
)

const otcDealSchema = new mongoose.Schema(
  {
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Submission',
      required: true,
      unique: true,
    },
    planterWallet: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    buyerWallet: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    enrollmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OtcEnrollment',
      required: false,
    },
    /** Snapshots: what the buyer was told to pay, to whom. */
    mpesaNumber: { type: String, required: true, trim: true },
    mpesaName: { type: String, required: true, trim: true, maxlength: 120 },
    trees: { type: Number, required: true, min: 0, default: 0 },
    countSource: {
      type: String,
      enum: ['ai', 'approved', 'manual', 'none'],
      default: 'none',
    },
    /** Why the deal is not payable yet (batch reason, AI failure, awaiting approval). */
    countNote: { type: String, required: false, trim: true, maxlength: 300 },
    /** Submission approved, or AI decision auto_approved. */
    verified: { type: Boolean, required: true, default: false },
    /** Denormalised Submission.status, refreshed on every read/transition. */
    submissionStatus: { type: String, required: false, trim: true },
    ratePerTreeKes: { type: Number, required: true, min: 0 },
    /** Whole shillings. */
    amountKes: { type: Number, required: true, min: 0, default: 0 },
    /** Planter share (95%) in wei, informational. */
    expectedMgroWei: { type: String, required: true, default: '0' },
    status: {
      type: String,
      enum: OTC_DEAL_STATUSES,
      required: true,
      default: 'awaiting_count',
      index: true,
    },
    payment: { type: paymentSchema, required: false },
    confirmedAt: { type: Date, required: false },
    disputedAt: { type: Date, required: false },
    disputeReason: {
      type: String,
      required: false,
      trim: true,
      maxlength: 500,
    },
    cancelledAt: { type: Date, required: false },
    cancelReason: { type: String, required: false, trim: true, maxlength: 500 },
    cancelledBy: { type: String, required: false, lowercase: true, trim: true },
    cancelledFromStatus: { type: String, required: false, trim: true },
    resolution: { type: resolutionSchema, required: false },
    /** Planter re-nudge for payment_sent deals (once, after 2h). */
    reminderSentAt: { type: Date, required: false },
    release: { type: releaseSchema, default: () => ({ status: 'n/a' }) },
    events: { type: [eventSchema], default: [] },
  },
  { timestamps: true },
)

otcDealSchema.index({ buyerWallet: 1, status: 1, createdAt: -1 })
otcDealSchema.index({ planterWallet: 1, createdAt: -1 })

export default mongoose.model('OtcDeal', otcDealSchema)
