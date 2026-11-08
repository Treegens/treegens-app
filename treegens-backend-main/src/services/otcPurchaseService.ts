import mongoose from 'mongoose'
import OtcPurchase from '../models/OtcPurchase'

function normalizeWallet(w: string): string {
  return String(w || '')
    .trim()
    .toLowerCase()
}

/** One slice of an approved planting funded by an OTC purchase. */
export type OtcCoverage = {
  purchaseId: mongoose.Types.ObjectId
  buyerWallet: string
  trees: number
}

/**
 * Split the planter MGRO pool of an approved planting between OTC buyers and
 * the planter, proportionally to the trees each one covers.
 *
 * The planter pool is `totalMgroWei - verifierPoolWei`; verifiers are paid
 * out of their own 5% regardless of who funded the trees. Integer wei
 * division rounds each buyer's slice down, so any dust stays with the planter
 * share (which may still legitimately be 0 when every tree is covered).
 */
export function splitPlanterPoolForOtc(input: {
  planterPoolWei: bigint
  treesPlanted: number
  coverages: OtcCoverage[]
}): {
  planterWei: bigint
  payouts: Array<OtcCoverage & { amountWei: bigint }>
  treesCovered: number
} {
  const trees = BigInt(Math.max(1, Math.floor(input.treesPlanted)))
  let remaining = input.planterPoolWei
  let treesCovered = 0
  const payouts = input.coverages
    .filter(c => c.trees > 0)
    .map(c => {
      const covered = BigInt(Math.floor(c.trees))
      const amountWei = (input.planterPoolWei * covered) / trees
      remaining -= amountWei
      treesCovered += Number(covered)
      return { ...c, amountWei }
    })
  if (treesCovered > Number(trees)) {
    throw new Error('OTC coverage exceeds trees planted')
  }
  // Every tree pre-sold → the planter has no MGRO claim at all; do not leave
  // rounding dust behind that would open a (pointless) vesting schedule.
  if (treesCovered === Number(trees)) remaining = 0n
  return { planterWei: remaining < 0n ? 0n : remaining, payouts, treesCovered }
}

class OtcPurchaseService {
  /**
   * Record a paid OTC purchase. Idempotent on `paymentRef`: re-posting the
   * same payment returns the existing purchase instead of double-selling.
   */
  async createPurchase(input: {
    buyerWallet: string
    paymentRef: string
    trees: number
    grossUsd?: number
    planterWallet?: string | null
    note?: string
  }): Promise<{ purchase: any; created: boolean }> {
    const buyerWallet = normalizeWallet(input.buyerWallet)
    const paymentRef = String(input.paymentRef || '').trim()
    const trees = Math.floor(Number(input.trees))
    if (!/^0x[0-9a-f]{40}$/.test(buyerWallet)) {
      throw new Error('buyerWallet must be an EVM address')
    }
    if (!paymentRef) throw new Error('paymentRef is required')
    if (!Number.isFinite(trees) || trees < 1) {
      throw new Error('trees must be a positive integer')
    }
    const planterWallet = input.planterWallet
      ? normalizeWallet(input.planterWallet)
      : null
    if (planterWallet && !/^0x[0-9a-f]{40}$/.test(planterWallet)) {
      throw new Error('planterWallet must be an EVM address')
    }

    const existing = await OtcPurchase.findOne({ paymentRef })
    if (existing) return { purchase: existing, created: false }

    try {
      const purchase = await OtcPurchase.create({
        buyerWallet,
        paymentRef,
        treesPurchased: trees,
        treesAllocated: 0,
        grossUsd: Number(input.grossUsd) || 0,
        planterWallet,
        status: 'open',
        note: String(input.note || '').slice(0, 500),
      })
      return { purchase, created: true }
    } catch (e: any) {
      if (e?.code === 11000) {
        const again = await OtcPurchase.findOne({ paymentRef })
        if (again) return { purchase: again, created: false }
      }
      throw e
    }
  }

  /**
   * Match the trees of a newly approved planting against open OTC purchases.
   *
   * Purchases pinned to this planter are drawn first, then unpinned ones,
   * oldest first. Each draw is an atomic compare-and-set on `treesAllocated`
   * so two approvals racing for the last trees of a purchase can never both
   * take them. Returns the coverages taken (possibly none, possibly several).
   */
  async reserveTreesForPlanting(input: {
    submissionId: mongoose.Types.ObjectId
    planterWallet: string
    trees: number
  }): Promise<OtcCoverage[]> {
    const planter = normalizeWallet(input.planterWallet)
    let need = Math.floor(Number(input.trees))
    const taken: OtcCoverage[] = []
    if (!Number.isFinite(need) || need <= 0) return taken

    const candidates = await OtcPurchase.find({
      status: 'open',
      $or: [
        { planterWallet: planter },
        { planterWallet: null },
        { planterWallet: '' },
      ],
      $expr: { $lt: ['$treesAllocated', '$treesPurchased'] },
    })
      .sort({ createdAt: 1 })
      .select('_id buyerWallet planterWallet treesPurchased treesAllocated')
      .lean()

    // Pinned purchases first — the buyer paid for THIS planter's trees.
    const ordered = [
      ...candidates.filter(c => c.planterWallet === planter),
      ...candidates.filter(c => c.planterWallet !== planter),
    ]

    for (const c of ordered) {
      if (need <= 0) break
      const remaining = Number(c.treesPurchased) - Number(c.treesAllocated)
      if (remaining <= 0) continue
      const take = Math.min(remaining, need)
      const nextAllocated = Number(c.treesAllocated) + take
      const updated = await OtcPurchase.findOneAndUpdate(
        {
          _id: c._id,
          status: 'open',
          treesAllocated: c.treesAllocated, // CAS: someone else moved it → skip
        },
        {
          $set: {
            treesAllocated: nextAllocated,
            ...(nextAllocated >= Number(c.treesPurchased)
              ? { status: 'fulfilled' }
              : {}),
          },
          $push: {
            allocations: {
              submissionId: input.submissionId,
              trees: take,
              createdAt: new Date(),
            },
          },
        },
        { new: true },
      )
        .select('_id buyerWallet')
        .lean()
      if (!updated) continue // lost the race on this purchase; try the next
      taken.push({
        purchaseId: updated._id as mongoose.Types.ObjectId,
        buyerWallet: String(updated.buyerWallet),
        trees: take,
      })
      need -= take
    }
    return taken
  }

  /** Undo reserveTreesForPlanting when the allocation could not be written. */
  async releaseReservation(
    submissionId: mongoose.Types.ObjectId,
    coverages: OtcCoverage[],
  ): Promise<void> {
    for (const c of coverages) {
      await OtcPurchase.updateOne(
        { _id: c.purchaseId },
        {
          $inc: { treesAllocated: -c.trees },
          $pull: { allocations: { submissionId } },
          $set: { status: 'open' },
        },
      )
    }
  }

  /** Stop an open purchase from funding further plantings (already funded trees stay). */
  async cancelPurchase(purchaseId: string): Promise<any | null> {
    if (!mongoose.Types.ObjectId.isValid(purchaseId)) return null
    return OtcPurchase.findOneAndUpdate(
      { _id: purchaseId, status: 'open' },
      { $set: { status: 'cancelled', cancelledAt: new Date() } },
      { new: true },
    ).lean()
  }

  async getPurchase(purchaseId: string): Promise<any | null> {
    if (!mongoose.Types.ObjectId.isValid(purchaseId)) return null
    return OtcPurchase.findById(purchaseId).lean()
  }

  async listPurchases(filter: {
    buyerWallet?: string
    status?: string
    limit?: number
  }): Promise<any[]> {
    const q: Record<string, unknown> = {}
    if (filter.buyerWallet) q.buyerWallet = normalizeWallet(filter.buyerWallet)
    if (filter.status) q.status = filter.status
    const limit = Math.min(200, Math.max(1, Number(filter.limit) || 50))
    return OtcPurchase.find(q).sort({ createdAt: -1 }).limit(limit).lean()
  }
}

export default OtcPurchaseService
