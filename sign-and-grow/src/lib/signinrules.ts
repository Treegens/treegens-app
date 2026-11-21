// The sign-in rules an account can set for its team (Settings, Security, "Sign-in rules"), and the check of a new
// password against passwords found in leaks. Numbers and words that the server (src/server/secpolicy.ts,
// src/server/pwned.ts) and the screens share. No environment is read here, so a 'use client' file may import it.
//
// What is deliberately not here: a password that expires after some weeks, rules about capitals, digits and signs,
// and security questions. NIST SP 800-63B advises against all three, because they push people towards weaker
// passwords that are written down or made by a pattern. Length, the leak check and two-step login do more.
import { SOURCE_LOCALE, t } from './i18n.ts';

/** The shortest password anyone can choose, with or without a rule. */
export const PASSWORD_MIN = 8;
/** The longest "at least" an account can ask for. A password itself may be up to 200 characters. */
export const PASSWORD_RULE_MAX = 64;
/** Sign out after this many minutes of no use: the limits of the rule. Off unless an admin sets it. */
export const IDLE_MIN_MINUTES = 15;
export const IDLE_MAX_MINUTES = 480;
/** How long before the sign-out the page says so, with "Stay signed in". */
export const IDLE_WARN_SECONDS = 120;
/** The page tells the server "still in use" at most this often while someone is working. */
export const IDLE_PING_SECONDS = 60;
/** How long the leaked-password list is waited for. With no answer in time the password is allowed. */
export const PWNED_TIMEOUT_MS = 3000;
/** Where the list is asked, unless HIBP_RANGE_URL names another copy of it. */
export const PWNED_DEFAULT_URL = 'https://api.pwnedpasswords.com/range/';

/** A request with this header does not count as use: the page's own look at how long is left. */
export const QUIET_HEADER = 'x-quiet';

export type SignInRules = { min_password_length: number; idle_minutes: number | null; one_session: boolean };
export const NO_RULES: SignInRules = { min_password_length: PASSWORD_MIN, idle_minutes: null, one_session: false };

/** The rules as an account row holds them (empty columns mean: no rule). */
export function rulesOf(a: any): SignInRules {
  const len = Number(a?.min_password_length) || 0;
  const idle = Number(a?.idle_minutes) || 0;
  return {
    min_password_length: len > PASSWORD_MIN && len <= PASSWORD_RULE_MAX ? Math.floor(len) : PASSWORD_MIN,
    idle_minutes: idle >= IDLE_MIN_MINUTES && idle <= IDLE_MAX_MINUTES ? Math.floor(idle) : null,
    one_session: !!a?.one_session,
  };
}

/** A whole number inside the limits typed into a box of the card, or null when the box does not hold one. */
export function wholeIn(value: unknown, lo: number, hi: number): number | null {
  const s = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= lo && n <= hi ? n : null;
}

/** Why this browser was signed out, as the sign-in page says it. '' for a reason it does not know. */
export function signedOutWords(why: string | null | undefined, locale: unknown = SOURCE_LOCALE): string {
  return why === 'idle' || why === 'elsewhere' ? t(locale, `rules.out.${why}`) : '';
}

/** "12 minutes", "1 minute", "less than a minute": how long is left, for the line that warns. */
export function leftWords(seconds: number, locale: unknown = SOURCE_LOCALE): string {
  const m = Math.ceil(Math.max(0, seconds) / 60);
  return seconds < 45 ? t(locale, 'rules.left.under_minute') : t(locale, 'rules.left.minutes', { count: m });
}

/** Whether the line that warns is on the screen with this much time left. */
export const warnNow = (secondsLeft: number | null | undefined): boolean => typeof secondsLeft === 'number' && secondsLeft <= IDLE_WARN_SECONDS;

/**
 * The signing page of an account with "Sign out after": whether this action comes after a break longer than the
 * rule, so the link is checked again before anything else happens. Never on a timer, only when the person acts.
 */
export const awayTooLong = (lastActionMs: number, nowMs: number, minutes: number | null | undefined): boolean =>
  !!minutes && minutes > 0 && nowMs - lastActionMs > minutes * 60_000;

/**
 * Where the list of leaked passwords is asked, ending in a slash, from the settings given: null when PWNED_CHECK
 * switches the check off or HIBP_RANGE_URL is not an http(s) address. One reading for the server (src/server/pwned.ts)
 * and for the list of what this server connects to (src/lib/outside.ts).
 */
export function pwnedUrl(env: Record<string, string | undefined>): string | null {
  const off = String(env.PWNED_CHECK ?? '').trim().toLowerCase();
  if (off === '0' || off === 'off' || off === 'false' || off === 'no') return null;
  const raw = String(env.HIBP_RANGE_URL || '').trim() || PWNED_DEFAULT_URL;
  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(raw)) return null;
  return raw.endsWith('/') ? raw : `${raw}/`;
}
