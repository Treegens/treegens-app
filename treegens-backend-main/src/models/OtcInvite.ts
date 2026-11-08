import mongoose from 'mongoose'

/**
 * An invite link the OTC buyer hands to planters. Opening
 * /otc/join/<code> and entering an M-Pesa number enrols the planter under
 * this buyer at this rate.
 */
const otcInviteSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true },
    buyerWallet: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    label: { type: String, required: false, trim: true, maxlength: 120 },
    /** Kenyan shillings paid per counted tree. */
    ratePerTreeKes: { type: Number, required: true, min: 0 },
    /** null = unlimited. */
    maxUses: { type: Number, required: false, default: null, min: 1 },
    uses: { type: Number, required: true, default: 0, min: 0 },
    expiresAt: { type: Date, required: false, default: null },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
)

otcInviteSchema.index({ buyerWallet: 1, createdAt: -1 })

export default mongoose.model('OtcInvite', otcInviteSchema)
