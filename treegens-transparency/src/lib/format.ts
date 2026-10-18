const WEI = 10n ** 18n

/** Wei string → human token amount, compact and honest (never a float on the way). */
export function formatWei(
  wei: string | bigint | null | undefined,
  opts: { decimals?: number; compact?: boolean; maxFraction?: number } = {},
): string {
  if (wei === null || wei === undefined || wei === '') return '0'
  let v: bigint
  try {
    v = typeof wei === 'bigint' ? wei : BigInt(String(wei))
  } catch {
    return '0'
  }
  const negative = v < 0n
  if (negative) v = -v
  const whole = v / WEI
  const frac = v % WEI
  const maxFraction = opts.maxFraction ?? 2
  if (opts.compact !== false && whole >= 1000n) {
    return (negative ? '-' : '') + compactNumber(Number(whole) + Number(frac) / 1e18)
  }
  const wholeStr = whole.toLocaleString('en-US')
  if (maxFraction === 0 || frac === 0n) return (negative ? '-' : '') + wholeStr
  const fracStr = frac.toString().padStart(18, '0').slice(0, maxFraction).replace(/0+$/, '')
  return (negative ? '-' : '') + (fracStr ? `${wholeStr}.${fracStr}` : wholeStr)
}

export function weiToNumber(wei: string | null | undefined): number {
  if (!wei) return 0
  try {
    const v = BigInt(wei)
    return Number(v / WEI) + Number(v % WEI) / 1e18
  } catch {
    return 0
  }
}

export function compactNumber(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  if (abs < 1000) return n % 1 === 0 ? n.toLocaleString('en-US') : n.toFixed(abs < 10 ? 2 : 1)
  const units = [
    { v: 1e9, s: 'B' },
    { v: 1e6, s: 'M' },
    { v: 1e3, s: 'K' },
  ]
  for (const u of units) {
    if (abs >= u.v) {
      const val = n / u.v
      return `${val.toFixed(val >= 100 ? 0 : digits)}${u.s}`
    }
  }
  return n.toLocaleString('en-US')
}

export function formatUsd(value: number | null | undefined, opts: { compact?: boolean } = {}): string {
  const n = Number(value) || 0
  if (opts.compact && Math.abs(n) >= 10000) return `$${compactNumber(n)}`
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 === 0 ? 0 : 2 })
}

export function formatInt(n: number | null | undefined): string {
  return (Number(n) || 0).toLocaleString('en-US')
}

export function shortAddress(address: string | null | undefined, chars = 4): string {
  const a = String(address || '')
  if (!/^0x[a-fA-F0-9]{40}$/.test(a)) return a
  return `${a.slice(0, 2 + chars)}…${a.slice(-chars)}`
}

export function shortHash(hash: string | null | undefined): string {
  const h = String(hash || '')
  if (!/^0x[a-fA-F0-9]{64}$/.test(h)) return h
  return `${h.slice(0, 10)}…${h.slice(-6)}`
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Math.max(0, now - t)
  const s = Math.floor(diff / 1000)
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo} mo ago`
  return `${Math.floor(mo / 12)} y ago`
}

export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' } : {}),
  })
}

export function pct(part: number, whole: number): number {
  if (!whole) return 0
  return Math.max(0, Math.min(100, (part / whole) * 100))
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export function titleCase(s: string): string {
  return String(s || '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}
