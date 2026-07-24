import mongoose from 'mongoose'

/**
 * Record of an automated $TGN payout for one purchased submission.
 *
 * Written by the world.treegens.app distribution engine after a fiat buyer
 * purchases a verified planting video: the relayer swaps USDC → $TGN and
 * sends 95% to the planter's wallet and 5% split across the verifiers who
 * approved the submission. One record per submission (unique index) makes
 * the distribution idempotent end-to-end.
 */
const tgnDistributionSchema = new mongoose.Schema(
  {
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Submission',
      required: true,
      unique: true,
    },
    /** Stripe PaymentIntent that funded this distribution */
    paymentRef: { type: String, required: true, index: true },
    grossUsd: { type: Number, required: true },
    planterWallet: { type: String, default: '', lowercase: true },
    planterTgnWei: { type: String, default: '0' },
    planterTx: { type: String, default: '' }, // '' while reserved, set on completion
    /**
     * Flight-booking hold. A record with planterTx === '' is a RESERVATION,
     * not a completed distribution. It only blocks other buyers while
     * holdExpiresAt is in the future — so an abandoned checkout frees the video
     * automatically instead of locking it forever. Completed records
     * (planterTx set) are permanent regardless of this field.
     */
    holdExpiresAt: { type: Date, default: null },
    /** Which rail placed the hold: 'card' (fiat) or 'mgro' (direct MGRO burn). */
    rail: { type: String, default: '' },
    verifiers: {
      type: [
        new mongoose.Schema(
          {
            wallet: { type: String, required: true, lowercase: true },
            tgnWei: { type: String, required: true },
            tx: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    distributedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
)

export default mongoose.model('TgnDistribution', tgnDistributionSchema)
