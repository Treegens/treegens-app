/**
 * Small hand-rolled validators. The `is*` functions are pure predicates; `invalid()` and
 * `FieldErrors` turn failures into HttpError(422, 'invalid', …, fields) for the API layer.
 */
import { IANAZone } from 'luxon';
import { HttpError } from './http';

// ───────────────────────── predicates ─────────────────────────

const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** A deliverable-looking address: ASCII local part, dotted domain with an alphabetic TLD, sane lengths. */
export function isEmail(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 6 || s.length > 254) return false;
  const at = s.lastIndexOf('@');
  if (at < 1 || at !== s.indexOf('@')) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64 || !EMAIL_LOCAL.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => DOMAIN_LABEL.test(l))) return false;
  // The top-level label is alphabetic, or punycode for internationalised TLDs.
  return /^(?:[A-Za-z]{2,63}|[Xx][Nn]--[A-Za-z0-9-]{1,59})$/.test(labels[labels.length - 1]);
}

/** Lower case letters, digits and single hyphens between them, 1 to 64 characters. */
export function isSlug(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
}

// C0 controls except TAB and LF, DEL, C1 controls, and the bidirectional overrides/isolates that
// can make text read differently from what it is (spoofed names in emails and the dashboard).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩﻿]/g;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s; // code points never outnumber UTF-16 units
  return Array.from(s).slice(0, Math.max(0, max)).join('');
}

/**
 * Turns untrusted input into safe stored text: non-strings become '', line endings become \n,
 * control characters go, the result is trimmed and cut to `max` characters. Line breaks are
 * kept (descriptions, long answers); use `cleanLine` for single-line values.
 */
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  const normalized = s
    .normalize('NFC')
    .replace(/\r\n?| | /g, '\n')
    .replace(CONTROL_CHARS, '')
    .trim();
  return truncate(normalized, max).trimEnd();
}

/** Like cleanText, but every run of whitespace (line breaks included) collapses to one space. For names, titles, subjects. */
export function cleanLine(s: unknown, max: number): string {
  return truncate(cleanText(s, Number.MAX_SAFE_INTEGER).replace(/\s+/g, ' '), max).trimEnd();
}

/** "#rgb" or "#rrggbb". */
export function isHexColor(s: unknown): boolean {
  return typeof s === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s);
}

/** A named IANA zone ("Africa/Nairobi", "UTC"). Bare UTC offsets are not zones. */
export function isZone(s: unknown): boolean {
  if (typeof s !== 'string' || s.length === 0 || s.length > 64) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(s)) return false;
  return IANAZone.isValidZone(s);
}

/** An absolute https URL without embedded credentials. */
export function isHttpsUrl(s: unknown): boolean {
  if (typeof s !== 'string' || s.length === 0 || s.length > 2048 || /[\s\u0000-\u001F\u007F]/.test(s)) return false;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname.length > 0 && url.username === '' && url.password === '';
}

/** Rounds numbers and numeric strings to an integer inside [min, max]; anything else gives `dflt`. */
export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  else return dflt;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** "YYYY-MM-DD" naming a real calendar day. */
export function isLocalDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** "HH:MM" from 00:00 to 23:59; "24:00" too when `allow24` (a range end at midnight). */
export function isHHMM(s: unknown, allow24 = false): s is string {
  if (typeof s !== 'string') return false;
  if (allow24 && s === '24:00') return true;
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** An ISO-8601 instant with an explicit offset or Z. */
export function isIsoInstant(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > 40) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) return false;
  return Number.isFinite(Date.parse(s));
}

export function isOneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v);
}

// ───────────────────────── throwing helpers ─────────────────────────

const DEFAULT_INVALID_MESSAGE = 'Please check the highlighted fields.';

/** Throws the standard validation error. */
export function invalid(fields: Record<string, string>, message: string = DEFAULT_INVALID_MESSAGE): never {
  throw new HttpError(422, 'invalid', message, fields);
}

/**
 * Collects every problem in a request so the client can highlight them all at once:
 *   const errors = new FieldErrors();
 *   if (!isEmail(body.email)) errors.add('email', 'Enter a valid email address.');
 *   errors.throwIfAny();
 */
export class FieldErrors {
  private readonly fields: Record<string, string> = {};

  /** The first message per field wins. */
  add(field: string, message: string): this {
    if (!(field in this.fields)) this.fields[field] = message;
    return this;
  }

  /** Records `message` for `field` unless `ok` holds. Returns `ok` so it can guard follow-up checks. */
  check(ok: boolean, field: string, message: string): boolean {
    if (!ok) this.add(field, message);
    return ok;
  }

  has(field?: string): boolean {
    return field === undefined ? Object.keys(this.fields).length > 0 : field in this.fields;
  }

  toJSON(): Record<string, string> {
    return { ...this.fields };
  }

  throwIfAny(message: string = DEFAULT_INVALID_MESSAGE): void {
    if (this.has()) invalid(this.toJSON(), message);
  }
}

/** The body as a plain object, or a 422 when it is anything else. */
export function requireObject(v: unknown, field = 'body'): Record<string, unknown> {
  if (!isPlainObject(v)) invalid({ [field]: 'Expected an object.' });
  return v;
}
