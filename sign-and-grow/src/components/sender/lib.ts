// Wording and small calculations shared by the sender screens. No React in here, so it can be tested on its own.
import { momentText, deviceZone, screenLocale } from '../../lib/dates.ts';

export const HOUR_MS = 3600_000;
export const DAY_MS = 24 * HOUR_MS;
// After this long without the email being opened, we say so and offer other ways to reach the person.
export const UNOPENED_AFTER_MS = 48 * HOUR_MS;

const valid = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};
const withYear = (d: Date) => (d.getFullYear() === new Date().getFullYear() ? {} : ({ year: 'numeric' } as const));

/** "4 December". The year is added when it is not this year. */
export function longDate(iso?: string | null): string {
  const d = valid(iso);
  return d ? d.toLocaleDateString(screenLocale(), { day: 'numeric', month: 'long', ...withYear(d) }) : '';
}

/** "4 Dec, 14:02". The year is added when it is not this year. */
export function dayTime(iso?: string | null): string {
  const d = valid(iso);
  if (!d) return '';
  return `${d.toLocaleDateString(screenLocale(), { day: 'numeric', month: 'short', ...withYear(d) })}, ${d.toLocaleTimeString(screenLocale(), { hour: '2-digit', minute: '2-digit' })}`;
}

/** "1 December" for a moment that is defined in UTC, like the monthly reset, so it reads the same everywhere. */
export function longDateUtc(iso?: string | null): string {
  const d = valid(iso);
  return d ? d.toLocaleDateString(screenLocale(), { day: 'numeric', month: 'long', timeZone: 'UTC' }) : '';
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : 'Someone');

/** A length of time since then: "3 days", "5 hours", "less than an hour". */
export function howLong(iso?: string | null, now = Date.now()): string {
  const d = valid(iso);
  if (!d) return '';
  const ms = Math.max(0, now - d.getTime());
  if (ms >= DAY_MS) return plural(Math.floor(ms / DAY_MS), 'day');
  if (ms >= HOUR_MS) return plural(Math.floor(ms / HOUR_MS), 'hour');
  return 'less than an hour';
}

/** Time left until then: "in 12 days", "in 5 hours". Empty once it has passed. */
export function timeLeft(iso?: string | null, now = Date.now()): string {
  const d = valid(iso);
  if (!d) return '';
  const ms = d.getTime() - now;
  if (ms <= 0) return '';
  if (ms < HOUR_MS) return 'in less than an hour';
  if (ms < 2 * DAY_MS) return `in ${plural(Math.round(ms / HOUR_MS), 'hour')}`;
  return `in ${plural(Math.round(ms / DAY_MS), 'day')}`;
}

/**
 * "Closes on 4 December 2026 at 16:40 Europe/Berlin time (UTC+01:00), in 12 days", or "Closed on ..." once it has
 * passed. A deadline is a moment, not a day: it is given with its time and the zone the time is in, so the sender
 * and a signer on the other side of the world are told the same moment.
 */
export function deadlineLine(expiresAt?: string | null, now = Date.now()): string {
  const d = valid(expiresAt);
  if (!d) return '';
  const left = timeLeft(expiresAt, now);
  const when = momentText(expiresAt, deviceZone());
  return left ? `Closes on ${when}, ${left}` : `Closed on ${when}`;
}

/** True when the deadline is less than three days away. */
export const closingSoon = (expiresAt?: string | null, now = Date.now()) => {
  const d = valid(expiresAt);
  return !!d && d.getTime() - now < 3 * DAY_MS;
};

/** The date an envelope would close on after giving more time. Mirrors the server: an expired one counts from now. */
export function newDeadline(status: string, expiresAt: string | null | undefined, days: number, now = Date.now()): Date {
  const from = status === 'expired' ? now : Math.max(now, valid(expiresAt)?.getTime() ?? now);
  return new Date(from + days * DAY_MS);
}

/** A deadline is a moment, never a bare day: "4 December 2026 at 17:40 Europe/Berlin time (UTC+01:00)", by this device's clock. */
export const closingText = (iso?: string | null): string => (valid(iso) ? momentText(iso, deviceZone()) : '');

/** "Ada", "Ada and Ben", "Ada, Ben and Cee", "Ada, Ben and 3 others". */
export function joinNames(names: string[]): string {
  const n = names.filter(Boolean);
  if (n.length <= 1) return n[0] || '';
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  if (n.length === 3) return `${n[0]}, ${n[1]} and ${n[2]}`;
  return `${n[0]}, ${n[1]} and ${n.length - 2} others`;
}

export type Person = { name: string; email: string; role: string; role_name?: string | null; status: string; sent_at?: string | null; viewed_at?: string | null };

/** Someone who has the document right now and has not finished. People who only get a copy never hold anything up. */
export const hasTurn = (r: { status: string; role: string }) => (r.status === 'sent' || r.status === 'viewed') && r.role !== 'cc';

export type Waiting = { people: Person[]; label: string; since: string | null; you: boolean };

/** Who an envelope is waiting on, and since when (the person who has had it longest). */
export function waitingOn(recipients: Person[], myEmail = ''): Waiting | null {
  const people = recipients.filter(hasTurn);
  if (!people.length) return null;
  const mine = (r: Person) => !!myEmail && r.role !== 'inperson' && r.email.toLowerCase() === myEmail.toLowerCase();
  const you = people.some(mine);
  const names = [...(you ? ['you'] : []), ...people.filter((r) => !mine(r)).map((r) => r.name || r.role_name || r.email)];
  const times = people.map((r) => r.sent_at).filter(Boolean).sort() as string[];
  return { people, label: joinNames(names), since: times[0] || null, you };
}

/** Sent long enough ago to worry, and never opened. */
export const neverOpened = (r: { status: string; role: string; sent_at?: string | null; viewed_at?: string | null }, now = Date.now()) =>
  r.status === 'sent' && r.role !== 'inperson' && !r.viewed_at && !!r.sent_at && now - Date.parse(r.sent_at) > UNOPENED_AFTER_MS;

export const looksLikeEmail = (s: string) => s.length < 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** The address of the ZIP download for a set of envelopes, or for everything when no ids are given. */
export const exportUrl = (ids?: string[]) => (ids && ids.length ? `/api/export?ids=${ids.map(encodeURIComponent).join(',')}` : '/api/export');

/** Words for something that failed. Server messages already say what to do next; a dropped connection does not. */
export function explain(e: any, reassurance = ''): string {
  const offline = !e || e instanceof TypeError || !e.message;
  const text = offline ? `We could not reach the server.${reassurance ? ` ${reassurance}` : ''} Check your connection and try again.` : `${e.message}${reassurance ? ` ${reassurance}` : ''}`;
  return text;
}
