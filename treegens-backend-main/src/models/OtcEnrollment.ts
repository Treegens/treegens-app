import mongoose from 'mongoose'

/**
 * A planter who chose to be paid in KES over M-Pesa instead of MGRO. One
 * enrollment per planter wallet; the buyer who invited them receives the
 * MGRO for every planting they film while enrolled.
 */
const otcEnrollmentSchema = new mongoose.Schema(
  {
    planterWallet: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    buyerWallet: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    inviteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OtcInvite',
      required: false,
    },
    inviteCode: { type: String, required: false, trim: true },
    /** E.164, e.g. +2547XXXXXXXX. */
    mpesaNumber: { type: String, required: true, trim: true },
    /** Name as registered on M-Pesa, so the buyer can check the recipient. */
    mpesaName: { type: String, required: true, trim: true, maxlength: 120 },
    /** Snapshot of the invite rate; the buyer may change it later. */
    ratePerTreeKes: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['active', 'paused'],
      default: 'active',
      index: true,
    },
    joinedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
)

otcEnrollmentSchema.index({ buyerWallet: 1, joinedAt: -1 })

export default mongoose.model('OtcEnrollment', otcEnrollmentSchema)
