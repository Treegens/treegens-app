import { randomUUID } from 'crypto'
import { hostname } from 'os'
import Lease from '../models/Lease'

/** One id per process, so two processes can never both think they own a lease. */
const PROCESS_OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`

export class LeaseLostError extends Error {
  constructor(name: string) {
    super(`lease "${name}" is no longer held by this process`)
  }
}

/**
 * Single-owner lease on a Mongo row — for loops that send transactions.
 *
 * Why: Render starts the new instance before it stops the old one, and more
 * than one replica may run, so an in-memory "am I running" flag lets two
 * processes sign from the same key at once. They collide on nonces, burn gas
 * on reverts, and can double-act on one row.
 *
 * Protocol:
 *  - `acquire()` at the top of every tick. Takes the lease if it is free or
 *    expired (bumping `fence`), renews it if we already hold it, and returns
 *    false when someone else holds it — the tick then does nothing.
 *  - `assertHeld()` immediately before EVERY transaction: one conditional
 *    write that both proves we still own it (same owner, same fence, not
 *    about to expire) and extends it. Throws LeaseLostError otherwise, so a
 *    process that stalled past its TTL and was taken over never sends.
 *  - A lease is never released on a timer; a stopped process simply lets it
 *    expire, so a deploy overlap hands over after at most one TTL.
 *
 * ponytail: relies on host clocks agreeing to within `marginMs`; Render's are
 * NTP-synced. If that ever stops holding, compare against Mongo's $$NOW.
 */
export class MongoLease {
  private heldFence: number | null = null

  constructor(
    readonly name: string,
    private ttlMs: number,
    /** assertHeld refuses when less than this is left on the lease. */
    private marginMs = Math.min(10_000, Math.floor(ttlMs / 4)),
    readonly owner = PROCESS_OWNER,
  ) {}

  /** The fencing token of our current hold, or null when not held. */
  get fence(): number | null {
    return this.heldFence
  }

  async acquire(): Promise<boolean> {
    if (this.heldFence !== null) {
      try {
        await this.assertHeld()
        return true
      } catch (error) {
        if (!(error instanceof LeaseLostError)) throw error
      }
    }
    const now = new Date()
    try {
      const doc = await Lease.findOneAndUpdate(
        { _id: this.name, expiresAt: { $lt: now } },
        {
          $set: {
            owner: this.owner,
            expiresAt: new Date(now.getTime() + this.ttlMs),
          },
          $inc: { fence: 1 },
        },
        { upsert: true, new: true },
      ).lean()
      this.heldFence = doc && doc.owner === this.owner ? doc.fence : null
    } catch (error) {
      // The row exists and is live: the upsert tried to insert a second row
      // with the same _id. That is simply "someone else holds it".
      if ((error as { code?: number })?.code !== 11000) throw error
      this.heldFence = null
    }
    return this.heldFence !== null
  }

  /** Fencing check before a transaction. Extends the lease when it passes. */
  async assertHeld(): Promise<void> {
    if (this.heldFence === null) throw new LeaseLostError(this.name)
    const now = Date.now()
    const result = await Lease.updateOne(
      {
        _id: this.name,
        owner: this.owner,
        fence: this.heldFence,
        expiresAt: { $gt: new Date(now + this.marginMs) },
      },
      { $set: { expiresAt: new Date(now + this.ttlMs) } },
    )
    if (result.matchedCount !== 1) {
      this.heldFence = null
      throw new LeaseLostError(this.name)
    }
  }

  /** Give it up early (tests, graceful shutdown). Safe if not held. */
  async release(): Promise<void> {
    if (this.heldFence === null) return
    await Lease.updateOne(
      { _id: this.name, owner: this.owner, fence: this.heldFence },
      { $set: { expiresAt: new Date(0) } },
    )
    this.heldFence = null
  }
}

/**
 * Run `fn` only in the process that holds `lease`. The common case for a
 * cron-style job: every process fires the timer, one does the work.
 */
export async function runUnderLease<T>(
  lease: MongoLease,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  if (!(await lease.acquire())) return { ran: false }
  return { ran: true, result: await fn() }
}
