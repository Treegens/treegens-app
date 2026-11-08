/**
 * Kenyan phone normalisation for M-Pesa numbers and SMS sign-in.
 * Mirrors `normalizeMpesaNumber` in the backend so the planter sees the same
 * acceptance rules before submitting:
 *   07XX XXX XXX / 01XX XXX XXX -> +2547XX… / +2541XX…
 *   7XXXXXXXX / 1XXXXXXXX         -> +254…
 *   2547XXXXXXXX / +2547XXXXXXXX  -> +254…
 *   any other E.164 (10-15 digits, no leading zero) -> +<digits>
 * Returns null when the input cannot be a phone number.
 */
export function normalizeKenyanPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const compact = raw.replace(/[\s\-().]/g, '')
  if (!compact) return null
  if (!/^\+?\d+$/.test(compact)) return null

  const digits = compact.startsWith('+') ? compact.slice(1) : compact

  if (/^0[17]\d{8}$/.test(digits)) return `+254${digits.slice(1)}`
  if (/^[17]\d{8}$/.test(digits)) return `+254${digits}`
  if (/^254[17]\d{8}$/.test(digits)) return `+${digits}`

  if (/^[1-9]\d{9,14}$/.test(digits)) return `+${digits}`

  return null
}

/** `+254712345678` -> `0712 345 678` for display; other numbers unchanged. */
export function formatPhoneForDisplay(e164?: string | null): string {
  if (!e164) return ''
  const m = /^\+254([17]\d{8})$/.exec(e164)
  if (!m) return e164
  const local = `0${m[1]}`
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`
}

/** M-Pesa transaction codes are 10 upper-case letters/digits (e.g. QGH7X2K9LM). */
export function normalizeMpesaRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toUpperCase()
  return /^[A-Z0-9]{10}$/.test(v) ? v : null
}
