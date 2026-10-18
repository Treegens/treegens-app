import { createHash } from 'crypto'
import { ethers } from 'ethers'

/**
 * Pure helpers for the donation pipeline
 * (Mercury → Stripe → USDC on Base → $MGRO → locked for good).
 *
 * Everything that decides an amount lives here, in integers, so it can be
 * unit-tested without a bank, a card network or a chain.
 *
 * Units: USD in cents (number), USDC in base units of 6 decimals (bigint,
 * "micro"), $MGRO in wei (bigint, 18 decimals). Never a float on the way to
 * a payment; floats appear only in log lines and dashboards.
 */

export const USDC_DECIMALS = 6
export const MGRO_DECIMALS = 18
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD'

export const PIPELINE_MODES = ['dry_run', 'live'] as const
export type PipelineMode = (typeof PIPELINE_MODES)[number]

export const SWAP_ROUTES = ['auto', 'uniswap_v3', 'openocean'] as const
export type SwapRoute = (typeof SWAP_ROUTES)[number]

/**
 * How the bought $MGRO is taken out of circulation.
 *   dead     transfer to 0x…dEaD: irrecoverable, needs no role (default)
 *   retire   MangroveRetirement.retire(): the same burn address plus a
 *            soulbound proof NFT to the Safe. The wallet needs RETIRER_ROLE
 *            and the contract must retire the canonical $MGRO.
 *   burn     ERC20Burnable burn(): lowers totalSupply; only if the token has it
 *   forward  plain transfer to TREASURY_FORWARD_TO (the Safe). Not a lock.
 */
export const LOCK_METHODS = ['dead', 'retire', 'burn', 'forward'] as const
export type LockMethod = (typeof LOCK_METHODS)[number]

export const MERCURY_SEND_MODES = ['direct', 'request'] as const
export type MercurySendMode = (typeof MERCURY_SEND_MODES)[number]

export function parseEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback
}

export function numberFromEnv(raw: unknown, fallback: number, min = 0): number {
  const s = String(raw ?? '').trim()
  if (s === '') return fallback
  const n = Number(s)
  return Number.isFinite(n) && n >= min ? n : fallback
}

export function boolFromEnv(raw: unknown, fallback = false): boolean {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (s === '') return fallback
  return s === 'true' || s === '1' || s === 'yes'
}

export function listFromEnv(raw: unknown, fallback: string[]): string[] {
  const s = String(raw ?? '').trim()
  if (s === '') return fallback
  return s
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
}

// ------------------------------------------------------------------ amounts --

export function usdToCents(usd: number): number {
  return Math.round((Number(usd) || 0) * 100)
}

export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100
}

/** $1.00 = 100 cents = 1_000_000 USDC base units. */
export function centsToUsdcMicro(cents: number): bigint {
  return BigInt(Math.round(cents)) * 10_000n
}

export function usdcMicroToCents(micro: bigint): number {
  return Number(micro / 10_000n)
}

/** Stripe expresses USDC amounts in minor units of two decimals, like USD. */
export function stripeMinorToUsdcMicro(minor: number): bigint {
  return BigInt(Math.round(minor)) * 10_000n
}

export function applySlippage(amount: bigint, slippagePct: number): bigint {
  const pct = Math.min(50, Math.max(0, Number(slippagePct) || 0))
  const bps = BigInt(Math.round(pct * 100))
  return (amount * (10_000n - bps)) / 10_000n
}

/**
 * How much of a donation leaves Mercury: the donation less the reserve kept
 * at the bank, never more than one payment may move.
 */
export function sweepAmountCents(
  amountCents: number,
  reservePct: number,
  maxSweepCents: number,
): number {
  const pct = Math.min(100, Math.max(0, Number(reservePct) || 0))
  const kept = Math.floor((Math.round(amountCents) * (100 - pct)) / 100)
  return Math.max(0, Math.min(kept, Math.round(maxSweepCents)))
}

export function formatUnitsFixed(
  amount: bigint,
  decimals: number,
  places = 4,
): string {
  return Number(ethers.formatUnits(amount, decimals)).toFixed(places)
}

// ---------------------------------------------------------------- detection --

export interface MercuryCreditLike {
  id: string
  amount: number
  status?: string
  kind?: string
  counterpartyId?: string | null
  counterpartyName?: string | null
  postedAt?: string | null
  createdAt?: string | null
}

export interface DonationFilter {
  /** Mercury transaction kinds that count; empty means any kind. */
  kinds: Set<string>
  minCents: number
  /** Counterparties whose credits are never donations (the Stripe recipient: an ACH return). */
  excludeCounterpartyIds: Set<string>
}

/** A posted credit of a donation kind, large enough, not our own money coming back. */
export function isDonationCredit(
  tx: MercuryCreditLike,
  f: DonationFilter,
): boolean {
  const cents = usdToCents(Number(tx.amount) || 0)
  if (cents <= 0 || cents < f.minCents) return false
  if (String(tx.status || '').toLowerCase() !== 'sent') return false
  if (f.kinds.size > 0 && !f.kinds.has(String(tx.kind || ''))) return false
  if (tx.counterpartyId && f.excludeCounterpartyIds.has(tx.counterpartyId))
    return false
  return true
}

export function postedTime(tx: MercuryCreditLike): number {
  const t = Date.parse(String(tx.postedAt || tx.createdAt || ''))
  return Number.isNaN(t) ? 0 : t
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** One key per flow and stage: a retry can never create a second payment. */
export function idempotencyKey(flowId: string, stage: string): string {
  return `tg-donation-${flowId}-${stage}`
}

/** The batch key is a function of its members, so a re-formed batch of the same flows reuses it. */
export function batchKey(flowIds: string[]): string {
  return `tg-sweep-${sha256Hex([...flowIds].sort().join(',')).slice(0, 24)}`
}

/** FIFO within a per-run cap: the items that fit go, the rest wait for the next run. */
export function pickWithinCap<T>(
  items: T[],
  amountOf: (item: T) => number,
  capCents: number,
): { picked: T[]; deferred: T[] } {
  const picked: T[] = []
  const deferred: T[] = []
  let used = 0
  for (const item of items) {
    const a = amountOf(item)
    if (a > 0 && used + a <= capCents) {
      picked.push(item)
      used += a
    } else {
      deferred.push(item)
    }
  }
  return { picked, deferred }
}

// ------------------------------------------------------------------ stages --

export const STAGES = ['sweep', 'onramp', 'swap', 'settle'] as const
export type StageName = (typeof STAGES)[number]

/** The stage a flow in `status` is waiting on; null when it is done or parked. */
export function stageForStatus(status: string): StageName | null {
  switch (status) {
    case 'detected':
      return 'sweep'
    case 'swept':
      return 'onramp'
    case 'onramped':
      return 'swap'
    case 'bought':
      return 'settle'
    default:
      return null
  }
}

/** Where a released flow re-enters, from the stage that parked it. */
export function releaseTargetStatus(
  stage: string,
): 'detected' | 'swept' | 'onramped' | 'bought' {
  switch (stage) {
    case 'onramp':
      return 'swept'
    case 'swap':
      return 'onramped'
    case 'settle':
      return 'bought'
    default:
      return 'detected'
  }
}

/** `holdReason` is written as "<stage>: <why>"; this reads the stage back. */
export function stageFromHoldReason(reason: string): StageName | null {
  const m = /^(sweep|onramp|swap|settle):/.exec(String(reason || ''))
  return m ? (m[1] as StageName) : null
}

// ------------------------------------------------------------------- chain --

export interface UsdcArrival {
  txHash: string
  value: bigint
  blockNumber: number
  logIndex?: number
}

/**
 * The earliest unclaimed USDC transfer whose size matches what Stripe sent.
 * Fees may shave a little off, so the window is asymmetric around the amount.
 */
export function matchUsdcArrival(
  expectedMicro: bigint,
  candidates: UsdcArrival[],
  claimedTxHashes: Set<string>,
  lowPct = 90,
  highPct = 102,
): UsdcArrival | null {
  if (expectedMicro <= 0n) return null
  const low = (expectedMicro * BigInt(lowPct)) / 100n
  const high = (expectedMicro * BigInt(highPct)) / 100n
  const fits = candidates.filter(
    c =>
      !claimedTxHashes.has(c.txHash.toLowerCase()) &&
      c.value >= low &&
      c.value <= high,
  )
  fits.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber || (a.logIndex ?? 0) - (b.logIndex ?? 0),
  )
  return fits[0] || null
}

/** Uniswap V3 path: token, fee (uint24), token, fee, token … packed. */
export function encodeV3Path(tokens: string[], fees: number[]): string {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error('encodeV3Path: need n tokens and n-1 fees')
  }
  const types: string[] = []
  const values: (string | number)[] = []
  tokens.forEach((token, i) => {
    types.push('address')
    values.push(token)
    if (i < fees.length) {
      types.push('uint24')
      values.push(fees[i])
    }
  })
  return ethers.solidityPacked(types, values)
}

export function describePath(symbols: string[], fees: number[]): string {
  const parts: string[] = []
  symbols.forEach((s, i) => {
    parts.push(s)
    if (i < fees.length) parts.push(String(fees[i]))
  })
  return parts.join('-')
}

export function isAddress(a: unknown): boolean {
  return typeof a === 'string' && ethers.isAddress(a)
}

export function sameAddress(a: unknown, b: unknown): boolean {
  return (
    isAddress(a) &&
    isAddress(b) &&
    String(a).toLowerCase() === String(b).toLowerCase()
  )
}

export function isTxHash(s: unknown): boolean {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s)
}

export function why(error: unknown): string {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error)
  return String(msg || 'unknown error').slice(0, 300)
}
