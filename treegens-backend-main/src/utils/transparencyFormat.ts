/**
 * Pure helpers for the public transparency ledger — no I/O, unit-tested.
 */

export type FlowKind =
  | 'funding'
  | 'payout'
  | 'reward'
  | 'retire'
  | 'verified'
  | 'update'
  | 'proposal'
  | 'donation'

export const FLOW_KINDS: FlowKind[] = [
  'funding',
  'payout',
  'reward',
  'retire',
  'verified',
  'update',
  'proposal',
  'donation',
]

export type FlowParty = { address: string; label: string; name?: string }

export type FlowItem = {
  /** Stable, unique across sources: `<kind>:<source id>`. */
  id: string
  kind: FlowKind
  at: string
  title: string
  detail?: string
  amount?: {
    token: 'USD' | 'TGN' | 'MGRO' | 'USDC'
    wei?: string
    value?: number
  }
  from?: FlowParty
  to?: FlowParty
  txHash?: string
  explorerUrl?: string
  /** True when the amount was read from the chain (log or receipt). */
  verified: boolean
  submissionId?: string
  planting?: {
    trees: number
    species: string
    location: string
    videoUrl: string | null
  }
  video?: { url: string; kind: 'plant' | 'land' | 'health_check' }
  meta?: Record<string, unknown>
}

export type Cursor = { at: number; id: string }

export function encodeCursor(item: Pick<FlowItem, 'at' | 'id'>): string {
  return Buffer.from(
    JSON.stringify({ at: new Date(item.at).getTime(), id: item.id }),
    'utf8',
  ).toString('base64url')
}

export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(
      Buffer.from(String(raw), 'base64url').toString('utf8'),
    )
    const at = Number(parsed?.at)
    const id = String(parsed?.id || '')
    if (!Number.isFinite(at) || !id) return null
    return { at, id }
  } catch {
    return null
  }
}

/** Newest first; ties broken by id so pagination is total and stable. */
export function compareFlowDesc(
  a: Pick<FlowItem, 'at' | 'id'>,
  b: Pick<FlowItem, 'at' | 'id'>,
): number {
  const ta = new Date(a.at).getTime()
  const tb = new Date(b.at).getTime()
  if (ta !== tb) return tb - ta
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** Items strictly after the cursor in the newest-first order. */
export function afterCursor<T extends Pick<FlowItem, 'at' | 'id'>>(
  items: T[],
  cursor: Cursor | null,
): T[] {
  if (!cursor) return items
  const probe = { at: new Date(cursor.at).toISOString(), id: cursor.id }
  return items.filter(item => compareFlowDesc(item, probe) > 0)
}

export function parseKinds(raw: unknown): FlowKind[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const wanted = raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter((s): s is FlowKind => (FLOW_KINDS as string[]).includes(s))
  return wanted.length ? [...new Set(wanted)] : null
}

export function clampInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = parseInt(String(raw ?? ''), 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function sumWei(values: Array<string | null | undefined>): string {
  let total = 0n
  for (const v of values) {
    const s = String(v ?? '0').trim()
    if (/^\d+$/.test(s)) total += BigInt(s)
  }
  return total.toString()
}

export function shortAddress(address: string): string {
  const a = String(address || '')
  if (!/^0x[a-fA-F0-9]{40}$/.test(a)) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function isTxHash(value: unknown): boolean {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value)
}

export function explorerTxUrl(
  base: string,
  txHash: string,
): string | undefined {
  return isTxHash(txHash) ? `${base}/tx/${txHash}` : undefined
}

export function explorerAddressUrl(base: string, address: string): string {
  return `${base}/address/${address}`
}

export function explorerTokenUrl(base: string, address: string): string {
  return `${base}/token/${address}`
}

/** Mangrove plantings are counted by the AI, everything else by the planter. */
export function isMangrove(treeType: unknown): boolean {
  return /mangrove/i.test(String(treeType || ''))
}

export type KnownAddresses = {
  mgro: string
  tgn: string
  tgnVault: string
  verifierMinter: string
  delegationRegistry: string
  treasurySafe: string
  minters: string[]
}

/**
 * Human label for an address. System contracts get their name; wallets get
 * their role from the sets the caller assembled for the current response.
 */
export function labelAddress(
  address: string,
  known: KnownAddresses,
  roles: {
    planters?: Set<string>
    verifiers?: Set<string>
    funders?: Set<string>
  } = {},
): string {
  const a = String(address || '').toLowerCase()
  if (!a) return ''
  if (a === '0x0000000000000000000000000000000000000000')
    return 'Mint / burn (0x0)'
  if (a === known.mgro.toLowerCase()) return '$MGRO token'
  if (a === known.tgn.toLowerCase()) return '$TGN token'
  if (a === known.tgnVault.toLowerCase()) return 'TGN vault (staking)'
  if (a === known.treasurySafe.toLowerCase())
    return 'Treegens treasury (Safe 2-of-4)'
  if (a === known.delegationRegistry.toLowerCase()) return 'Delegation registry'
  if (known.minters.some(m => m.toLowerCase() === a)) return 'VerifierMinter'
  if (roles.planters?.has(a)) return 'Planter'
  if (roles.verifiers?.has(a)) return 'Verifier'
  if (roles.funders?.has(a)) return 'Funder'
  return 'Wallet'
}

/** Public GPS: 4 decimals (~11 m) is plenty to find a planting site. */
export function publicGps(
  gps: { latitude?: number; longitude?: number } | null | undefined,
): { lat: number; lng: number } | null {
  if (!gps) return null
  const lat = Number(gps.latitude)
  const lng = Number(gps.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4 }
}

/**
 * Mongo `$sum: { $toDecimal }` returns a Decimal128 whose string form may be
 * scientific ("1.5E+21"). Turn any such value into an integer wei string.
 */
export function decimalToWeiString(value: unknown): string {
  if (value === null || value === undefined) return '0'
  const raw = String(
    typeof value === 'object' && value && 'toString' in value
      ? (value as { toString(): string }).toString()
      : value,
  ).trim()
  const m = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/)
  if (!m) return /^-?\d+$/.test(raw) ? raw : '0'
  const sign = m[1] === '-' ? '-' : ''
  const intPart = m[2]
  const frac = m[3] || ''
  const exp = Number(m[4] || 0)
  let digits = intPart + frac
  const pointPos = intPart.length + exp
  if (pointPos <= 0) return '0'
  if (pointPos > digits.length)
    digits = digits + '0'.repeat(pointPos - digits.length)
  const integer = digits.slice(0, pointPos).replace(/^0+(?=\d)/, '')
  return integer === '' || integer === '0' ? '0' : sign + integer
}
