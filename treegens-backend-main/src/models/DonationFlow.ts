import mongoose from 'mongoose'

/**
 * One donation on its way from the foundation's bank account to $MGRO.
 *
 *   detected   a credit on the Mercury donations account (treegensfoundation.org)
 *   held       waiting for an admin release (TREASURY_REQUIRE_APPROVAL, or a hold)
 *   swept      Mercury sent the USD to the Stripe financial account (ACH)
 *   onramped   Stripe paid the USD out as USDC to the treasury wallet on Base
 *   bought     the treasury wallet swapped that USDC for $MGRO
 *   settled    the $MGRO reached the Safe (or was retired through MangroveRetirement)
 *   failed     a stage errored past its retries; an admin re-releases it
 *
 * Each stage keeps what it sent and what came back, so the public ledger can
 * show the donation as a chain: $ in → USDC tx → swap tx → settle tx. Nothing
 * about the donor is ever exposed: the counterparty is stored only as a hash,
 * for de-duplication and support.
 *
 * ⛔ Amounts are integers (cents, USDC micro-units, MGRO wei as strings).
 * Never a float on the way to a payment.
 */
export const DONATION_FLOW_STATUSES = [
  'detected',
  'held',
  'swept',
  'onramped',
  'bought',
  'settled',
  'failed',
] as const
export type DonationFlowStatus = (typeof DONATION_FLOW_STATUSES)[number]

export const STAGE_STATUSES = [
  'pending',
  'sent',
  'settled',
  'failed',
  'skipped',
] as const
export type StageStatus = (typeof STAGE_STATUSES)[number]

const stageBase = {
  status: { type: String, enum: STAGE_STATUSES, default: 'pending' },
  sentAt: { type: Date, required: false },
  settledAt: { type: Date, required: false },
  attempts: { type: Number, default: 0 },
  error: { type: String, default: '' },
  /** What a dry run WOULD have sent, verbatim, so an operator can check it. */
  dryRun: { type: mongoose.Schema.Types.Mixed, required: false },
}

const donationFlowSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: DONATION_FLOW_STATUSES,
      default: 'detected',
      index: true,
    },
    mode: { type: String, enum: ['dry_run', 'live'], required: true },
    amountCents: { type: Number, required: true, min: 1 },
    currency: { type: String, default: 'usd' },
    holdReason: { type: String, default: '' },
    /** Times an admin restarted a stage; makes the next idempotency key new. */
    releases: { type: Number, default: 0 },
    mercury: {
      txId: { type: String, required: true },
      accountId: { type: String, required: true },
      kind: { type: String, default: '' },
      postedAt: { type: Date, required: false },
      /** sha256 of the counterparty name; never the name itself. */
      counterpartyHash: { type: String, default: '' },
      memo: { type: String, default: '' },
    },
    sweep: new mongoose.Schema(
      {
        ...stageBase,
        mercuryPaymentId: { type: String, default: '' },
        amountCents: { type: Number, default: 0 },
        idempotencyKey: { type: String, default: '' },
        /** Flows swept in the same Mercury payment share a batch id. */
        batchId: { type: String, default: '' },
      },
      { _id: false },
    ),
    onramp: new mongoose.Schema(
      {
        ...stageBase,
        stripeOutboundPaymentId: { type: String, default: '' },
        amountCents: { type: Number, default: 0 },
        /** USDC base units (6 decimals) that reached the wallet. */
        usdcMicro: { type: String, default: '0' },
        txHash: { type: String, default: '' },
        idempotencyKey: { type: String, default: '' },
      },
      { _id: false },
    ),
    swap: new mongoose.Schema(
      {
        ...stageBase,
        usdcMicro: { type: String, default: '0' },
        mgroWei: { type: String, default: '0' },
        /** What the route quoted before the send; mgroWei is what arrived. */
        quoteMgroWei: { type: String, default: '0' },
        txHash: { type: String, default: '' },
        route: { type: String, default: '' },
        /** Flows swapped together in one transaction share a batch id. */
        batchId: { type: String, default: '' },
      },
      { _id: false },
    ),
    settle: new mongoose.Schema(
      {
        ...stageBase,
        mgroWei: { type: String, default: '0' },
        to: { type: String, default: '' },
        txHash: { type: String, default: '' },
        /** dead | retire | burn | forward (see TREASURY_LOCK_METHOD). */
        method: { type: String, default: '' },
        retired: { type: Boolean, default: false },
        tokenId: { type: Number, required: false },
        batchId: { type: String, default: '' },
      },
      { _id: false },
    ),
    /** Bounded audit trail; the newest entries win. */
    events: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, default: Date.now },
            stage: { type: String, default: '' },
            message: { type: String, default: '' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
)

donationFlowSchema.index({ 'mercury.txId': 1 }, { unique: true })
donationFlowSchema.index({ status: 1, updatedAt: 1 })
donationFlowSchema.index({ createdAt: -1 })

export default mongoose.model('DonationFlow', donationFlowSchema)
