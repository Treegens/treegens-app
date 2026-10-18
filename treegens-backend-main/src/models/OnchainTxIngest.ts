import mongoose from 'mongoose'

/**
 * Tracks which payout transactions (from TgnDistribution records) have had
 * their receipts read into OnchainEvent rows. Keeps receipt fetching
 * idempotent and lets a missing or failed receipt be retried a bounded
 * number of times instead of forever.
 */
const onchainTxIngestSchema = new mongoose.Schema(
  {
    txHash: { type: String, required: true, unique: true, lowercase: true },
    source: { type: String, required: true, default: 'tgn_distribution' },
    submissionId: { type: String, default: '' },
    status: {
      type: String,
      enum: ['ingested', 'not_found', 'failed', 'invalid'],
      required: true,
    },
    attempts: { type: Number, default: 0 },
    eventsWritten: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
  },
  { timestamps: true },
)

onchainTxIngestSchema.index({ status: 1, updatedAt: 1 })

export default mongoose.model('OnchainTxIngest', onchainTxIngestSchema)
