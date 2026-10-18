import mongoose from 'mongoose'

/**
 * One row per on-chain event the public transparency ledger shows.
 *
 * Every amount on the transparency page traces back to one of these rows, and
 * every row carries the transaction hash a reader can open on Basescan. The
 * indexer writes them from Base logs and receipts; nothing here is typed in
 * by hand.
 */
export const ONCHAIN_EVENT_KINDS = [
  /** $MGRO Transfer from 0x0 — a reward minted to a planter or verifier. */
  'mgro_mint',
  /** $MGRO Transfer to 0x0 — a funder retired MGRO against verified trees. */
  'mgro_burn',
  /** VerifierMinter.MintProposed — carries the evidenceURI naming the planting. */
  'mint_proposed',
  /** VerifierMinter.MintExecuted — the verifier majority released the mint. */
  'mint_executed',
  /** $TGN Transfer inside a distribution tx — planter (95%) or verifier (5%) payout. */
  'tgn_payout',
] as const

export type OnchainEventKind = (typeof ONCHAIN_EVENT_KINDS)[number]

export type OnchainEventMeta = {
  /** Submission the event pays for, when the chain or the ledger names one. */
  submissionId?: string
  /** 'planter' | 'verifier' | 'funder' | 'other' */
  role?: string
  /** Planter reward tranche index (0-based) for vested MGRO mints. */
  trancheIndex?: number
  /** VerifierMinter proposal id. */
  proposalId?: number
  /** VerifierMinter evidence URI, e.g. treegens://submission/<id>/planter/tranche/0 */
  evidenceURI?: string
  /** Approving stake weight recorded by MintExecuted. */
  approvals?: string
  /** USD the funder paid, copied from the distribution record for tgn_payout rows. */
  grossUsd?: number
}

const onchainEventSchema = new mongoose.Schema(
  {
    chainId: { type: Number, required: true, default: 8453 },
    txHash: { type: String, required: true, lowercase: true, trim: true },
    logIndex: { type: Number, required: true, min: 0 },
    blockNumber: { type: Number, required: true, min: 0, index: true },
    blockTime: { type: Date, required: true, index: true },
    /** Emitting contract (lowercase). */
    contract: { type: String, required: true, lowercase: true, trim: true },
    kind: { type: String, enum: ONCHAIN_EVENT_KINDS, required: true },
    token: { type: String, enum: ['MGRO', 'TGN', ''], default: '' },
    from: { type: String, default: '', lowercase: true, trim: true },
    to: { type: String, default: '', lowercase: true, trim: true, index: true },
    /** Decimal wei string — never a float. */
    amountWei: { type: String, required: true, default: '0' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
)

onchainEventSchema.index({ txHash: 1, logIndex: 1 }, { unique: true })
onchainEventSchema.index({ kind: 1, blockTime: -1 })
onchainEventSchema.index({ blockTime: -1, logIndex: -1 })
onchainEventSchema.index({ 'meta.submissionId': 1 }, { sparse: true })
onchainEventSchema.index({ 'meta.proposalId': 1 }, { sparse: true })

export default mongoose.model('OnchainEvent', onchainEventSchema)
