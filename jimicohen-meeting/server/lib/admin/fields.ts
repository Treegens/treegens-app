/**
 * Small readers for the dashboard's partial updates. Every reader follows the same rules:
 *   - a key that was not sent (or is undefined) means "leave it as it is" and gives undefined
 *   - a value of the wrong type or outside its limits is recorded in FieldErrors under the
 *     dotted path of the field ("theme.colors.primary") and gives undefined
 *   - text is cleaned (control characters, stray whitespace) but never silently cut: text that
 *     is too long is an error, so nobody loses the end of what they wrote without knowing
 */
import { normalizeHex } from '../../../shared/theme';
import type { Ctx } from '../ctx';
import { isStorageId, KEYS } from '../repo';
import { cleanLine, cleanText, FieldErrors, isHexColor, isPlainObject } from '../validate';

export type Bag = Record<string, unknown>;

/** True when the key was sent with a value. */
export function given(bag: Bag, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(bag, key) && bag[key] !== undefined;
}

export function charCount(text: string): number {
  return Array.from(text).length;
}

/** The value as a plain object, or null (with an error recorded) when it is anything else. */
export function readObject(value: unknown, path: string, errors: FieldErrors): Bag | null {
  if (isPlainObject(value)) return value;
  errors.add(path, 'Expected a group of settings here.');
  return null;
}

export interface TextOptions {
  /** message used when the cleaned text is empty; without it an empty text is fine */
  required?: string;
  /** keep line breaks (descriptions, messages) instead of folding everything onto one line */
  multiline?: boolean;
}

export function readText(bag: Bag, key: string, path: string, max: number, errors: FieldErrors, opts: TextOptions = {}): string | undefined {
  if (!given(bag, key)) return undefined;
  const raw = bag[key];
  if (typeof raw !== 'string') {
    errors.add(path, 'Expected text here.');
    return undefined;
  }
  const clean = opts.multiline ? cleanText(raw, Number.MAX_SAFE_INTEGER) : cleanLine(raw, Number.MAX_SAFE_INTEGER);
  if (charCount(clean) > max) {
    errors.add(path, `Please keep this to ${max} characters or fewer.`);
    return undefined;
  }
  if (opts.required && clean === '') {
    errors.add(path, opts.required);
    return undefined;
  }
  return clean;
}

export function readEnum<T extends string>(bag: Bag, key: string, path: string, allowed: readonly T[], errors: FieldErrors): T | undefined {
  if (!given(bag, key)) return undefined;
  const raw = bag[key];
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
  errors.add(path, `Choose one of: ${allowed.join(', ')}.`);
  return undefined;
}

export function readBool(bag: Bag, key: string, path: string, errors: FieldErrors): boolean | undefined {
  if (!given(bag, key)) return undefined;
  const raw = bag[key];
  if (typeof raw === 'boolean') return raw;
  errors.add(path, 'Expected on or off here.');
  return undefined;
}

/** A whole number inside [min, max]. `what` finishes the sentence "… has to be between". */
export function readInt(bag: Bag, key: string, path: string, min: number, max: number, errors: FieldErrors, message?: string): number | undefined {
  if (!given(bag, key)) return undefined;
  const raw = bag[key];
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max) return raw;
  errors.add(path, message ?? `Enter a whole number from ${min} to ${max}.`);
  return undefined;
}

/** Any finite number inside [min, max], rounded to `decimals` places. */
export function readNumber(bag: Bag, key: string, path: string, min: number, max: number, errors: FieldErrors, decimals = 2): number | undefined {
  if (!given(bag, key)) return undefined;
  const raw = bag[key];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= min - 1e-9 && raw <= max + 1e-9) {
    const factor = 10 ** decimals;
    return Math.min(max, Math.max(min, Math.round(raw * factor) / factor));
  }
  errors.add(path, `Enter a number from ${min} to ${max}.`);
  return undefined;
}

/** "#rgb" or "#rrggbb", stored as lower-case "#rrggbb". */
export function readHex(bag: Bag, key: string, path: string, errors: FieldErrors): string | undefined {
  if (!given(bag, key)) return undefined;
  const raw = bag[key];
  if (isHexColor(raw)) return normalizeHex(raw);
  errors.add(path, 'Use a hex colour like #1b6b43.');
  return undefined;
}

/** A link people can click: http or https, no user name or password inside it. */
export function isWebUrl(value: unknown, max = 500): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\s\u0000-\u001F\u007F]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

// ───────────────────────── uploaded images ─────────────────────────

/** An asset id that a setting points at, remembered so its existence can be checked in one go. */
export interface AssetRef {
  path: string;
  id: string;
}

/**
 * Reads an "…AssetId" setting: null clears it, a string names an uploaded image. Ids that are
 * already in use (`current`) are trusted; new ones are queued in `refs` for verifyAssets().
 * Returns undefined when the key was not sent or the value is unusable.
 */
export function readAssetId(bag: Bag, key: string, path: string, current: string | null | undefined, refs: AssetRef[], errors: FieldErrors): string | null | undefined {
  if (!given(bag, key)) return undefined;
  const raw = bag[key];
  if (raw === null || raw === '') return null;
  if (!isStorageId(raw)) {
    errors.add(path, 'That image is not available. Please upload it again.');
    return undefined;
  }
  if (raw !== current) refs.push({ path, id: raw });
  return raw;
}

export async function assetExists(ctx: Ctx, id: unknown): Promise<boolean> {
  if (!isStorageId(id)) return false;
  const key = `${KEYS.assetPrefix}${id}`;
  // Listing by the exact key is a metadata lookup: the image itself is not downloaded.
  return (await ctx.kv.list(key)).includes(key);
}

/** Records an error for every queued reference whose image does not exist (any more). */
export async function verifyAssets(ctx: Ctx, refs: AssetRef[], errors: FieldErrors): Promise<void> {
  const known = new Map<string, boolean>();
  for (const ref of refs) {
    if (!known.has(ref.id)) known.set(ref.id, await assetExists(ctx, ref.id));
    if (!known.get(ref.id)) errors.add(ref.path, 'That image is not available any more. Please upload it again.');
  }
}

/** Ids that arrive from the browser for list items (questions, reminder rules, schedules). */
export function isClientId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
