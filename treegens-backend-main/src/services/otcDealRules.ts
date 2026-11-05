import crypto from 'crypto'
import env from '../config/environment'
import {
  batchEnforcementEnabled,
  batchRejectionReason,
} from '../utils/treeBatch'

/**
 * Pure rules for the OTC (M-Pesa) desk. No database access here so every
 * rule can be unit-tested without Mongo.
 *
 * The desk lets a buyer (Jimi) pay a planter in Kenyan shillings over
 * M-Pesa for the trees the AI counted, and receive the planter's MGRO for
 * that planting once the planter confirms the money arrived.
 */

export const OTC_DEAL_STATUSES = [
  'awaiting_count',
  'awaiting_payment',
  'payment_sent',
  'confirmed',
  'disputed',
  'cancelled',
] as const

export type OtcDealStatus = (typeof OTC_DEAL_STATUSES)[number]

/** Every legal transition. Anything not listed is refused. */
const TRANSITIONS: Record<OtcDealStatus, readonly OtcDealStatus[]> = {
  awaiting_count: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['payment_sent', 'cancelled'],
  // Re-uploading proof keeps the deal in payment_sent.
  payment_sent: ['payment_sent', 'confirmed', 'disputed', 'cancelled'],
  // `confirmed` from disputed is the buyer's `resolve` (release_to_buyer),
  // recorded with written evidence.
  disputed: ['payment_sent', 'confirmed', 'cancelled'],
  confirmed: [],
  cancelled: [],
}

export function canTransition(from: string, to: string): boolean {
  const allowed = TRANSITIONS[from as OtcDealStatus]
  if (!allowed) return false
  return allowed.includes(to as OtcDealStatus)
}

/** Statuses a buyer may upload payment proof from. */
export const PAYMENT_UPLOAD_FROM: readonly OtcDealStatus[] = [
  'awaiting_payment',
  'payment_sent',
  'disputed',
]

/** Statuses a buyer may cancel from (never after the planter confirmed). */
export const CANCEL_FROM: readonly OtcDealStatus[] = [
  'awaiting_count',
  'awaiting_payment',
  'payment_sent',
  'disputed',
]

/** Statuses that still bind the planter's MGRO to the deal. */
export const OPEN_STATUSES: readonly OtcDealStatus[] = [
  'awaiting_count',
  'awaiting_payment',
  'payment_sent',
  'disputed',
]

export function isTerminalStatus(status: string): boolean {
  return status === 'confirmed' || status === 'cancelled'
}

/**
 * Normalise an M-Pesa number to E.164.
 *
 * Kenyan planters type their number the way Safaricom shows it:
 * 07XX XXX XXX, 01XX XXX XXX, 7XXXXXXXX, 2547..., +2547... All of those become
 * +254XXXXXXXXX. Anything else is accepted only if it already looks like an
 * international number (M-Pesa also runs in Tanzania, Ghana, Mozambique...).
 * Returns null when the input cannot be a phone number.
 */
export function normalizeMpesaNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const compact = raw.replace(/[\s\-().]/g, '')
  if (!compact) return null
  if (!/^\+?\d+$/.test(compact)) return null

  const digits = compact.startsWith('+') ? compact.slice(1) : compact

  // Kenyan local formats.
  if (/^0[17]\d{8}$/.test(digits)) return `+254${digits.slice(1)}`
  if (/^[17]\d{8}$/.test(digits)) return `+254${digits}`
  if (/^254[17]\d{8}$/.test(digits)) return `+${digits}`

  // Generic E.164: 10 to 15 digits, no leading zero.
  if (/^[1-9]\d{9,14}$/.test(digits)) return `+${digits}`

  return null
}

/** Whole shillings: M-Pesa cannot send cents. */
export function computeDealAmountKes(
  trees: number,
  ratePerTreeKes: number,
): number {
  const t = Number(trees)
  const r = Number(ratePerTreeKes)
  if (!Number.isFinite(t) || !Number.isFinite(r) || t <= 0 || r <= 0) return 0
  return Math.round(t * r)
}

/**
 * MGRO total for a planting: trees * 10^decimals. Kept byte-identical to
 * rewardService.computeTotalMgroWei so the number shown to the buyer is the
 * number the allocation will carry.
 */
export function totalMgroWeiForTrees(trees: number): bigint {
  const t = BigInt(Math.floor(Math.max(0, Number(trees) || 0)))
  return t * 10n ** BigInt(env.MGRO_DECIMALS)
}

/** Planter share = total minus the 5% verifier pool (same split as rewards). */
export function expectedPlanterMgroWei(trees: number): string {
  const total = totalMgroWeiForTrees(trees)
  const verifierPool = (total * 5n) / 100n
  return (total - verifierPool).toString()
}

/** No 0/O/1/I so a code read over the phone cannot be misheard. */
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const INVITE_CODE_LENGTH = 10

export function generateInviteCode(): string {
  const bytes = crypto.randomBytes(INVITE_CODE_LENGTH)
  let out = ''
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length]
  }
  return out
}

export function isValidInviteCode(code: unknown): code is string {
  return (
    typeof code === 'string' &&
    new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`).test(code)
  )
}

export function normalizeWallet(w: unknown): string {
  return String(w ?? '')
    .trim()
    .toLowerCase()
}

export function isOtcBuyerWallet(
  wallet: unknown,
  allowlist: readonly string[],
): boolean {
  const w = normalizeWallet(wallet)
  if (!w) return false
  return allowlist.some(a => normalizeWallet(a) === w)
}

/**
 * The tree count a deal pays for. For mangroves the AI count is the
 * measurement; the planter's declared figure is only a claim. Returns null
 * when no usable count exists yet (AI skipped or failed).
 */
export function dealTreeCountFromAi(submission: {
  treeType?: string | null
  aiVerification?: {
    status?: string | null
    countedMangroves?: number | null
  } | null
}): number | null {
  const ai = submission.aiVerification
  if (!ai || ai.status !== 'completed') return null
  const n = Number(ai.countedMangroves)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.floor(n)
}

export function buildInviteUrl(code: string): string {
  return `${env.OTC_PUBLIC_APP_URL}/otc/join/${encodeURIComponent(code)}`
}

export function formatKes(amount: number): string {
  const n = Math.round(Number(amount) || 0)
  return `KES ${n.toLocaleString('en-KE')}`
}

/**
 * Whether a count can ever mint. Paying KES for a count the 100-tree batch
 * gate will refuse buys MGRO that never exists, so such a deal must stay in
 * `awaiting_count` with the batch reason as its note.
 */
export function isFundableCount(count: number): {
  ok: boolean
  reason: string | null
} {
  const n = Math.floor(Number(count) || 0)
  if (n <= 0) return { ok: false, reason: 'No trees counted yet' }
  if (!batchEnforcementEnabled()) return { ok: true, reason: null }
  const reason = batchRejectionReason(n)
  return { ok: reason === null, reason }
}

/** M-Pesa transaction codes are 10 upper-case alphanumerics (e.g. QHX7K2M9PL). */
export function normalizeMpesaRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const ref = raw.trim().toUpperCase()
  return /^[A-Z0-9]{10}$/.test(ref) ? ref : null
}

export function mpesaRefMatches(a: unknown, b: unknown): boolean {
  const x = normalizeMpesaRef(a)
  const y = normalizeMpesaRef(b)
  return x !== null && y !== null && x === y
}
