import mongoose from 'mongoose'

export const OTC_PURCHASE_STATUSES = ['open', 'fulfilled', 'cancelled'] as const
export type OtcPurchaseStatus = (typeof OTC_PURCHASE_STATUSES)[number]

/**
 * An over-the-counter (OTC) pre-purchase of $MGRO.
 *
 * A buyer pays Treegens up front (fiat / stables, settled off-chain by the
 * OTC desk on world.treegens.app) for the MGRO of `treesPurchased` trees that
 * have NOT been planted yet. MGRO is only ever minted for verified plantings,
 * so the purchase is fulfilled over time: each time a planting is approved,
 * its planter MGRO share is routed to the buyer instead of the planter, tree
 * by tree, until `treesAllocated` reaches `treesPurchased`.
 *
 * The planter was already paid for those trees through the OTC proceeds, so
 * they never get a claim on that MGRO. Verifiers keep their 5% as usual.
 *
 * `planterWallet` (optional) pins the purchase to one planter: only that
 * planter's approvals draw from it. Without it any approved planting can be
 * funded by the purchase (oldest purchase first).
 */
const otcAllocationSchema = new mongoose.Schema(
  {
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Submission',
      required: true,
    },
    trees: { type: Number, required: true, min: 1 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
)

const otcPurchaseSchema = new mongoose.Schema(
  {
    buyerWallet: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    /** Payment reference from the OTC desk (Stripe PaymentIntent, invoice id…). */
    paymentRef: { type: String, required: true, unique: true, trim: true },
    treesPurchased: { type: Number, required: true, min: 1 },
    /** Trees already matched to approved plantings (never exceeds treesPurchased). */
    treesAllocated: { type: Number, required: true, default: 0, min: 0 },
    grossUsd: { type: Number, default: 0 },
    /** When set, only this planter's approvals are funded by the purchase. */
    planterWallet: { type: String, lowercase: true, trim: true, default: null },
    status: {
      type: String,
      enum: OTC_PURCHASE_STATUSES,
      default: 'open',
      index: true,
    },
    note: { type: String, default: '' },
    allocations: { type: [otcAllocationSchema], default: [] },
    cancelledAt: { type: Date, required: false },
  },
  { timestamps: true },
)

// The matcher walks open purchases oldest-first, planter-pinned ones first.
otcPurchaseSchema.index({ status: 1, planterWallet: 1, createdAt: 1 })
otcPurchaseSchema.index({ 'allocations.submissionId': 1 })

export default mongoose.model('OtcPurchase', otcPurchaseSchema)
