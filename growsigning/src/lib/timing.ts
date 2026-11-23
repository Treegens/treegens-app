// Send later, pause and resume, and a wait before a person (research/docusign-gaps.json, batch "timing"). The rules
// and the words that the server and the screens share. Nothing here talks to the server.
import { clockIn } from './dates.ts';

/** How far ahead "Send later" can be set. */
export const SEND_LATER_MAX_DAYS = 30;
/** "Send later" has to be at least this far ahead, so it is not a send now by another name that the timer runs late. */
export const SEND_LATER_MIN_MINUTES = 5;
/** The shortest and the longest wait before a person, in hours: 1 hour to 30 days. */
export const WAIT_MIN_HOURS = 1;
export const WAIT_MAX_HOURS = 30 * 24;
/** The waits the editor offers. The API takes any whole number of hours in between. */
export const WAIT_CHOICES = [1, 4, 24, 48, 72, 168, 336, 720];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "9:00 on 3 December", with the year when it is not this year. In `tz` when given, else where this runs. */
export function atWords(iso: string | Date | null | undefined, tz?: string | null): string {
  if (!iso) return '';
  const c = clockIn(iso, tz || undefined);
  if (!c) return '';
  const year = c.y !== (clockIn(new Date(), tz || undefined)?.y ?? c.y) ? ` ${c.y}` : '';
  return `${c.hh}:${String(c.mm).padStart(2, '0')} on ${c.d} ${MONTHS[c.m]}${year}`;
}

/**
 * The same words for a screen: the time in the viewer's own zone and written their own way ("9:00 PM" or "21:00", as
 * the time box beside it shows it), so the line and the box never disagree. `locale` and `zone` are for tests; a
 * page leaves them out and gets the browser's.
 */
export function atWordsHere(iso: string | Date | null | undefined, locale?: string, zone?: string): string {
  if (!iso) return '';
  const t = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(t.getTime())) return '';
  let tz = zone;
  try {
    tz ||= Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    tz = 'UTC';
  }
  const c = clockIn(t, tz);
  if (!c) return '';
  let time: string;
  let monthFirst = false;
  try {
    // A 24-hour clock is written the way the time box writes it, "02:30"; a 12-hour one as "9:30 PM".
    const twelve = !!new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: c.zone }).resolvedOptions().hour12;
    time = new Intl.DateTimeFormat(locale, { hour: twelve ? 'numeric' : '2-digit', minute: '2-digit', timeZone: c.zone }).format(t);
    // "March 3" where the viewer writes the month first (en-US), "3 March" elsewhere. The month stays in English.
    const parts = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: c.zone }).formatToParts(t).map((p) => p.type);
    monthFirst = parts.indexOf('month') >= 0 && parts.indexOf('month') < parts.indexOf('day');
  } catch {
    time = `${c.hh}:${String(c.mm).padStart(2, '0')}`;
  }
  const thisYear = c.y === (clockIn(new Date(), c.zone)?.y ?? c.y);
  if (monthFirst) return `${time} on ${MONTHS[c.m]} ${c.d}${thisYear ? '' : `, ${c.y}`}`;
  return `${time} on ${c.d} ${MONTHS[c.m]}${thisYear ? '' : ` ${c.y}`}`;
}

/** "2 days", "1 hour", "1 day and 4 hours". */
export function waitWords(hours: number): string {
  const h = Math.round(Number(hours) || 0);
  const d = Math.floor(h / 24);
  const r = h % 24;
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (!d) return part(r, 'hour');
  return r ? `${part(d, 'day')} and ${part(r, 'hour')}` : part(d, 'day');
}

/** The line in the editor and on the review step: "Wait 2 days before this person". */
export const waitLine = (hours: number) => `Wait ${waitWords(hours)} before this person`;

/** How long something lasted, for "The deadline moved on by 3 hours". Rounded to whole minutes. */
export function spanWords(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  return waitWords(h);
}

/** The label of the one Send button once a time is chosen: on a screen, so in the viewer's zone, like the box above it. */
export const sendAtLabel = (iso: string, tz?: string | null) => `Send at ${atWordsHere(iso, undefined, tz || undefined)}`;

/** A chosen time that can still be used: in the future, and no further than the limit. */
export function sendAtProblem(iso: unknown, nowMs = Date.now()): string | null {
  // A day alone, or a time with no zone, would be read in some zone the sender did not pick: refused, not guessed.
  const full = typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(iso.trim());
  const t = full ? Date.parse(iso as string) : NaN;
  if (!Number.isFinite(t)) return 'That is not a time we can read. Pick a day and a time, or send it as a full date and time with its zone, like 2027-03-20T09:00:00Z.';
  if (t <= nowMs) return 'That time has passed. Pick a later time, or send it now.';
  if (t < nowMs + SEND_LATER_MIN_MINUTES * 60_000) return `That time is less than ${SEND_LATER_MIN_MINUTES} minutes from now. Pick a later time, or send it now.`;
  if (t > nowMs + SEND_LATER_MAX_DAYS * 864e5) return `That is more than ${SEND_LATER_MAX_DAYS} days from now. Pick a time within ${SEND_LATER_MAX_DAYS} days.`;
  return null;
}

/** A reminder asked for while the envelope is paused. */
export const PAUSED_NO_REMINDER = 'This document is paused, so no reminders go out. Choose Resume in More when people can sign it again, and they are emailed then.';

/** What the paused signing page says. Never "expired". */
export const pausedLinkText = (by: string, onDay: string) => `Paused by ${by} on ${onDay}. You will get an email when it can be signed again.`;

/** For a datetime-local box: the value for an ISO time, in the time zone of the device. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** And back: what was picked in the box, as an ISO time. Empty when nothing usable was picked. */
export function fromLocalInput(v: string): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * For the sender's screens: a person in a signing order with a wait before them, who has not been asked yet. `at` is
 * when they are asked, once the people before them have all finished; null while those people are still at it.
 * The same rule as waitUntil in src/server/waits.ts. Null when no wait applies to them.
 */
export function waitFact(e: any, r: any): { hours: number; at: number | null } | null {
  const hours = Number(r?.wait_hours) || 0;
  if (!e?.ordered || !hours || r.role === 'witness' || r.status !== 'pending') return null;
  const people = (e.recipients || []).filter((x: any) => x.role !== 'witness');
  const orders = people.map((x: any) => Number(x.routing_order) || 1);
  if (!orders.length || (Number(r.routing_order) || 1) <= Math.min(...orders)) return null;
  const before = people.filter((x: any) => (Number(x.routing_order) || 1) < (Number(r.routing_order) || 1));
  const open = before.filter((x: any) => x.status !== 'completed');
  // Someone before them was left out by a rule: the server asks them without the wait (waitUntil), so none is shown.
  if (open.some((x: any) => x.status === 'skipped')) return null;
  if (open.length) return { hours, at: null };
  const done = Math.max(0, ...before.map((x: any) => Date.parse(x.completed_at || '') || 0));
  return done ? { hours, at: done + hours * 3600_000 } : null;
}

/** The person a wait the sender chose holds back right now, and when they are asked: for the page and the list. */
export function waitRunning(e: any): { name: string; at: number; hours: number } | null {
  if (e?.status !== 'sent' || e.paused_at) return null;
  const list = (e.recipients || []).map((r: any) => ({ r, w: waitFact(e, r) })).filter((x: any) => x.w?.at);
  if (!list.length) return null;
  list.sort((a: any, b: any) => a.w.at - b.w.at);
  return { name: list[0].r.name || list[0].r.role_name || 'The next person', at: list[0].w.at, hours: list[0].w.hours };
}

/**
 * The timer takes a time up within its round (every 15 minutes, or as often as the host calls it), so "soon after".
 * Only screens use it (the page, the list, Home), so the time is the viewer's own (atWordsHere).
 */
export const goesOutWords = (iso: string | number, tz?: string | null) => `soon after ${atWordsHere(new Date(iso).toISOString(), undefined, tz || undefined)}`;

/** What the Documents list says for a draft with a time, a paused envelope, or one held by a wait. Empty otherwise. */
export function timingRow(e: any): string {
  if (e?.status === 'draft' && e.send_at) return e.send_error ? `Not sent at ${atWordsHere(e.send_at)}. Open it to see why` : `Sends at ${atWordsHere(e.send_at)}`;
  if (e?.status !== 'sent') return '';
  if (e.paused_at) return 'Paused. Nobody can sign it until it is resumed';
  if ((e.recipients || []).some((r: any) => r.role !== 'cc' && (r.status === 'sent' || r.status === 'viewed'))) return '';
  const w = waitRunning(e);
  return w ? `${w.name}, asked ${goesOutWords(w.at)} after the wait you chose` : '';
}

/** Home: "1 document goes out soon after 9:00 on 22 November." Drafts with a time, apart from forgotten drafts. */
export const scheduledHome = (n: number, next: string | null) =>
  n === 1 ? `1 document goes out by itself${next ? `, ${goesOutWords(next)}` : ''}.` : `${n} documents go out by themselves${next ? `, the first ${goesOutWords(next)}` : ''}.`;

/** When a person not asked yet is asked, with the wait the sender chose before them (src/lib/timing.ts). */
export function pendingWhen(e: any, r: any, before: any[]): string {
  const w = waitFact(e, r);
  const names = before.map((x: any) => x.name).join(' and ');
  if (w && before.length) return `It goes out ${waitWords(w.hours)} after ${names} ${before.length === 1 ? 'has' : 'have'} finished, as you chose.`;
  if (w?.at) return e.paused_at ? `It goes out once you resume it, and not before ${goesOutWords(w.at).replace(/^soon after /, '')}.` : `It goes out ${goesOutWords(w.at)}, after the wait of ${waitWords(w.hours)} you chose.`;
  return before.length ? `It goes out once ${names} ${before.length === 1 ? 'has' : 'have'} finished.` : 'It goes out when their turn comes.';
}
