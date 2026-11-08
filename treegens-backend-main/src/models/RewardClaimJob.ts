import mongoose from 'mongoose'

const claimJobStatus = ['queued', 'processing', 'completed', 'failed'] as const

const rewardClaimJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Submission',
      required: true,
      index: true,
    },
    walletAddress: {
      type: String,
      required: true,
      lowercase: true,
    },
    claimType: {
      type: String,
      enum: ['planter', 'verifier', 'both', 'otc'],
      required: true,
    },
    status: {
      type: String,
      enum: claimJobStatus,
      required: true,
      default: 'queued',
      index: true,
    },
    attempts: { type: Number, required: true, default: 0 },
    txHashes: { type: [String], default: [] },
    result: { type: mongoose.Schema.Types.Mixed, required: false },
    lastError: { type: String, required: false },
    queuedAt: { type: Date, required: true, default: Date.now },
    startedAt: { type: Date, required: false },
    completedAt: { type: Date, required: false },
  },
  { timestamps: true },
)

rewardClaimJobSchema.index({ walletAddress: 1, createdAt: -1 })
rewardClaimJobSchema.index({ status: 1, createdAt: -1 })
rewardClaimJobSchema.index({ submissionId: 1, walletAddress: 1 })

export default mongoose.model('RewardClaimJob', rewardClaimJobSchema)
