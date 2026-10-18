import mongoose, { Schema } from 'mongoose'

/**
 * One row per background loop that must never run twice at once (the V6
 * keeper, the verifier registrar, gas top-ups, the verifier refresh cron).
 *
 * `_id` is the loop's name, so there is exactly one row per loop and a second
 * process trying to insert it hits the unique `_id` index. See
 * utils/mongoLease.ts for the protocol.
 */
export interface ILease {
  _id: string
  /** Process that holds it: host, pid and a per-process random id. */
  owner: string
  /** Past this instant anyone may take it over. */
  expiresAt: Date
  /** Bumped on every takeover — the fencing token. */
  fence: number
}

const LeaseSchema = new Schema<ILease>(
  {
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    fence: { type: Number, required: true },
  },
  { versionKey: false },
)

export default mongoose.model<ILease>('Lease', LeaseSchema)
