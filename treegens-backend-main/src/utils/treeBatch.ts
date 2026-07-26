const MANGROVE_TREE_TYPE = 'mangrove'

/**
 * Jimi's ruling (2026-07-24): inventory is created in batches of 100 trees.
 *
 * This is not cosmetic. Both downstream rails — the voucher retirement wrapper
 * and burn.treegens.app — reject counts that are not a whole multiple of 100,
 * so approving 143 trees produces a verified submission that can never be
 * funded: dead inventory that looks fine in the app and silently never pays
 * the planter.
 */
export const TREE_BATCH_SIZE = 100

/** Enforcement can be switched off if it ever strands real plantings. */
export function batchEnforcementEnabled(): boolean {
  return process.env.ENFORCE_TREE_BATCHES !== 'false'
}

/**
 * The count that actually goes on-chain. For mangroves that is the AI count,
 * not the planter's declared number — the declared figure is a claim, the AI
 * count is the measurement the reward is computed from.
 */
export function approvedTreeCount(submission: {
  treeType?: string | null
  treesPlanted?: number | null
  aiVerification?: { countedMangroves?: number | null } | null
}): number {
  const isMangrove =
    String(submission.treeType ?? '')
      .trim()
      .toLowerCase() === MANGROVE_TREE_TYPE
  const raw = isMangrove
    ? submission.aiVerification?.countedMangroves
    : submission.treesPlanted
  return Math.max(0, Math.floor(Number(raw ?? 0)))
}

export function isFullBatch(count: number): boolean {
  return (
    Number.isFinite(count) &&
    count >= TREE_BATCH_SIZE &&
    count % TREE_BATCH_SIZE === 0
  )
}

/** Null when the count is fine; otherwise a sentence a verifier can act on. */
export function batchRejectionReason(count: number): string | null {
  if (isFullBatch(count)) return null
  if (count < TREE_BATCH_SIZE) {
    return `${count} trees is under the ${TREE_BATCH_SIZE}-tree batch minimum`
  }
  const short = TREE_BATCH_SIZE - (count % TREE_BATCH_SIZE)
  return (
    `${count} trees is not a whole multiple of ${TREE_BATCH_SIZE} ` +
    `(${short} short of ${count + short})`
  )
}
