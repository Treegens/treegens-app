import mongoose from 'mongoose'

/**
 * Cursor for each ledger indexer stream (log scan per contract set, payout
 * receipt ingestion). Separate from BurnIndexerState so the two indexers can
 * run and be reset independently.
 */
const onchainIndexerStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    lastProcessedBlock: { type: Number, required: true, min: 0, default: 0 },
    /** Free-form progress info surfaced on /api/transparency/status. */
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
)

export default mongoose.model('OnchainIndexerState', onchainIndexerStateSchema)
