/**
 * The dashboard's view of bookings: the list behind the Upcoming / Past / Cancelled tabs, with
 * search and paging, and the CSV export of the same selection.
 *
 * Tabs:  upcoming  = confirmed and not over yet (soonest first)
 *        past      = confirmed and over (latest first)
 *        cancelled = cancelled, whenever it was meant to happen (latest first)
 * Filtering and counting run on the compact booking index. Only the bookings on the requested
 * page are loaded in full.
 */
import { DateTime, IANAZone } from 'luxon';
import { calendarEventLeft } from '../../../shared/calendar';
import type { AdminBookingsResponse, Booking, BookingIndexEntry, Host, Job } from '../../../shared/types';
import { calendarEventIdFor } from '../booking';
import { forgetHostBusy } from '../busy';
import type { Ctx } from '../ctx';
import { googleDeleteEvent } from '../google';
import { HttpError } from '../http';
import {
  deleteBooking,
  deleteCallsOfBooking,
  deleteJob,
  getBooking,
  getBookingIndex,
  getBookings,
  getHost,
  getSite,
  isStorageId,
  listHosts,
  listJobs,
  mutateBookingIndex,
} from '../repo';
import { clampInt, cleanLine } from '../validate';
import { hostMap, ownerOf, toAdminBooking } from './view';

export type BookingScope = 'upcoming' | 'past' | 'cancelled';
export type ExportScope = BookingScope | 'all';
export type ScopeCounts = Record<BookingScope, number>;

const SCOPES: BookingScope[] = ['upcoming', 'past', 'cancelled'];
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_EXPORT_ROWS = 5000;
const MAX_SEARCH_TERMS = 8;

export function scopeOf(entry: Pick<BookingIndexEntry, 'status' | 'end'>, nowMs: number): BookingScope {
  if (entry.status === 'cancelled') return 'cancelled';
  return Date.parse(entry.end) > nowMs ? 'upcoming' : 'past';
}

export function parseScope(raw: string | null): BookingScope | null {
  return SCOPES.includes(raw as BookingScope) ? (raw as BookingScope) : null;
}

/** Lower-case words of a search. Every word has to appear in the name, the email address or the event title. */
export function searchTerms(raw: string | null): string[] {
  return cleanLine(raw ?? '', 200).toLowerCase().split(' ').filter(Boolean).slice(0, MAX_SEARCH_TERMS);
}

function matches(entry: BookingIndexEntry, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${entry.inviteeName} ${entry.inviteeEmail} ${entry.eventTitle}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** The index entries of one tab (or of everything), searched and in display order. */
export function selectEntries(index: BookingIndexEntry[], scope: ExportScope, terms: string[], nowMs: number): BookingIndexEntry[] {
  const picked = index.filter((entry) => (scope === 'all' || scopeOf(entry, nowMs) === scope) && matches(entry, terms));
  const soonestFirst = (a: BookingIndexEntry, b: BookingIndexEntry): number => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id);
  return scope === 'upcoming' ? picked.sort(soonestFirst) : picked.sort((a, b) => soonestFirst(b, a));
}

export function countScopes(index: BookingIndexEntry[], nowMs: number): ScopeCounts {
  const counts: ScopeCounts = { upcoming: 0, past: 0, cancelled: 0 };
  for (const entry of index) counts[scopeOf(entry, nowMs)]++;
  return counts;
}

/** GET /admin/bookings?scope=&q=&limit=&offset= */
export async function listAdminBookings(ctx: Ctx, params: URLSearchParams): Promise<AdminBookingsResponse & { counts: ScopeCounts }> {
  const nowMs = ctx.now().getTime();
  const scope = parseScope(params.get('scope')) ?? 'upcoming';
  const limit = clampInt(params.get('limit'), 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const offset = clampInt(params.get('offset'), 0, 1_000_000, 0);
  const [index, hosts] = await Promise.all([getBookingIndex(ctx), listHosts(ctx)]);
  const selected = selectEntries(index, scope, searchTerms(params.get('q')), nowMs);
  const page = await getBookings(ctx, selected.slice(offset, offset + limit).map((entry) => entry.id));
  const byId = hostMap(hosts);
  return {
    bookings: page.map((booking) => toAdminBooking(ctx, booking, byId)),
    total: selected.length,
    // Per tab, without the search: what the tab badges show.
    counts: countScopes(index, nowMs),
  };
}

// ───────────────────────── delete ─────────────────────────

export interface EraseResult {
  /** false when there was no booking record any more (an earlier delete got cut off, or it never existed) */
  found: boolean;
  jobs: number;
  calls: number;
}

/** How long a delete waits for Google to take a left-behind event off the calendar. Slower than that, the delete answers without it. */
const REMOVE_EVENT_BUDGET_MS = 6000;

const TIMED_OUT = Symbol('timed out');

async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why a booking may not be deleted yet, or null when it may. Only a meeting that is over or cancelled
 * can go: an upcoming one holds a time and a calendar event, so it is cancelled first. A cancelled
 * meeting that is still ahead also waits until the cancellation is finished (time given back, people
 * told), or that work would be left half done with nothing to finish it.
 *
 * Its calendar event is different: Google may stay out of reach for as long as nobody reconnects it, and a
 * request to delete someone's data cannot wait for that. So an event that could not be removed is refused
 * with `calendar_event_left`, which eraseBooking lets the owner pass once they have said the event may stay.
 */
export function eraseRefusal(b: Booking, pendingJobs: Job[], nowMs: number): HttpError | null {
  const ahead = Date.parse(b.end) > nowMs;
  if (b.status === 'confirmed') {
    if (!ahead) return null;
    return Date.parse(b.start) > nowMs
      ? new HttpError(409, 'upcoming', 'This meeting has not happened yet. Cancel it first, then you can delete it.')
      : new HttpError(409, 'in_progress', 'This meeting is happening now. You can delete it once it is over.');
  }
  if (!ahead) return null;
  const left = calendarEventLeft(b);
  const telling = pendingJobs.some((j) => j.type === 'message' && j.kind === 'cancelled');
  // A calendar retry still queued for an event that could not be removed is that same trouble, not work in progress.
  const calendarBusy = !left && pendingJobs.some((j) => j.type === 'gcal_sync');
  if (b.followUp?.kind === 'cancelled' || telling || calendarBusy) {
    return new HttpError(
      409,
      'still_cancelling',
      'This cancellation is not finished yet: the calendar event and the messages about it are still being taken care of. Please try again in a little while.',
    );
  }
  if (left) {
    return new HttpError(
      409,
      'calendar_event_left',
      `The event for this meeting is still on Google Calendar, because it could not be removed. ${/[.!?]$/.test(left) ? left : `${left}.`} If you delete the booking anyway, the event stays on the calendar until someone removes it by hand.`,
    );
  }
  return null;
}

/**
 * One more try at taking a left-behind event off Google Calendar, for a delete. Only when the host whose
 * calendar has it is connected and in order now. True when the event is gone (removed now, or Google no
 * longer had it). Never throws. A Google that is slow carries on in the background.
 */
async function removeLeftEvent(ctx: Ctx, b: Booking): Promise<boolean> {
  const g = b.google;
  if (!g) return false;
  const holder = await getHost(ctx, g.hostId);
  if (!holder?.google || holder.google.status !== 'ok') return false;
  const work = googleDeleteEvent(ctx, holder, g.calendarId || holder.google.writeCalendarId || 'primary', g.eventId || calendarEventIdFor(b.id), true).then(
    async () => {
      // The meeting's time was given back when it was cancelled: what is remembered of the busy time should say so too.
      await forgetHostBusy(ctx, [...new Set([g.hostId, ...b.hostIds])]).catch(() => undefined);
      return true;
    },
    (err: unknown) => {
      ctx.log('warn', 'bookings: the calendar event could still not be removed', { bookingId: b.id, hostId: g.hostId, error: err instanceof Error ? err.message : String(err) });
      return false;
    },
  );
  const removed = await withinBudget(work, REMOVE_EVENT_BUDGET_MS);
  if (removed === TIMED_OUT) {
    ctx.waitUntil(work);
    return false;
  }
  return removed;
}

export interface EraseOptions {
  /** the owner has been told that the event of this cancelled meeting stays on Google Calendar, and deletes anyway */
  leaveCalendarEvent?: boolean;
}

/**
 * DELETE /admin/bookings/:id : erases one booking for good. The record (name, email, phone, answers,
 * consent, timeline), its entry in the index, its pending jobs and its call records with their
 * transcripts. Calendar events and messages that were already sent are not touched.
 *
 * A cancelled meeting still ahead whose event could not be taken off Google Calendar gets one more try
 * first. When that does not work either, the delete is refused with `calendar_event_left`, unless
 * `leaveCalendarEvent` says the owner knows the event stays there.
 *
 * Order: jobs and calls first, the record next, the index entry last. A delete cut off before the
 * record went leaves the booking in the dashboard, to be deleted again. One cut off after it is
 * finished by asking again (the drawer is still open): a delete of a record that is already gone
 * still clears its index entry, jobs and calls.
 */
export async function eraseBooking(ctx: Ctx, id: string, opts: EraseOptions = {}): Promise<EraseResult & { calendarEventLeft?: boolean }> {
  if (!isStorageId(id)) throw new HttpError(404, 'not_found', 'That booking no longer exists.');
  const nowMs = ctx.now().getTime();
  const [booking, allJobs] = await Promise.all([getBooking(ctx, id), listJobs(ctx)]);
  const jobs = allJobs.filter((j) => j.bookingId === id);
  let eventLeft = false;
  if (booking) {
    let refusal = eraseRefusal(booking, jobs, nowMs);
    if (refusal?.code === 'calendar_event_left') {
      if (await removeLeftEvent(ctx, booking)) refusal = null;
      else if (opts.leaveCalendarEvent) {
        refusal = null;
        eventLeft = true;
      }
    }
    if (refusal) throw refusal;
  }

  await Promise.all(jobs.map((j) => deleteJob(ctx, j.key)));
  const calls = await deleteCallsOfBooking(ctx, id);
  if (booking) await deleteBooking(ctx, id);
  const unlisted = await mutateBookingIndex(ctx, (entries) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return { abort: 'not_listed' };
    // Without a record, an entry for a meeting that is still ahead may be a booking being made this very
    // moment (the index is written before the record). That one is left for reconcileBookings to judge.
    if (!booking && entry.status === 'confirmed' && Date.parse(entry.end) > nowMs) return { abort: 'not_ours' };
    return entries.filter((e) => e.id !== id);
  });
  if (!unlisted.ok && unlisted.reason === 'contention') throw new HttpError(503, 'busy', 'The booking was deleted, but the list could not be updated. Please try again.');
  if (eventLeft) {
    ctx.log('warn', 'bookings: booking deleted, its Google Calendar event was left in place as the owner chose', { bookingId: id, hostId: booking?.google?.hostId, jobs: jobs.length, calls });
    return { found: !!booking, jobs: jobs.length, calls, calendarEventLeft: true };
  }
  ctx.log('info', 'bookings: booking deleted', { bookingId: id, found: !!booking, jobs: jobs.length, calls });
  return { found: !!booking, jobs: jobs.length, calls };
}

// ───────────────────────── CSV ─────────────────────────

/**
 * One CSV cell (RFC 4180): quoted when it holds a comma, a quote or a line break, quotes doubled.
 * Text that a spreadsheet would run as a formula (it starts with = + - @, a tab or a carriage
 * return) gets a leading apostrophe, which spreadsheets show as plain text.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function localStamp(iso: string | undefined | null, zone: string): string {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return '';
  return DateTime.fromMillis(ms, { zone }).toFormat('yyyy-LL-dd HH:mm');
}

// The manage link is left out on purpose: an export gets passed around, and that link can cancel the meeting.
function bookingRow(b: Booking, hosts: Map<string, Host>, zone: string): unknown[] {
  const hostNames = b.hostIds.map((id) => hosts.get(id)?.name).filter(Boolean).join(', ');
  const where = [b.location?.label, b.location?.value].filter(Boolean).join(': ');
  const answers = (b.answers ?? []).map((a) => `${a.label}: ${a.value}`).join('\n');
  return [
    b.id,
    b.status,
    b.eventTitle,
    b.start,
    b.end,
    localStamp(b.start, zone),
    b.durationMin,
    b.invitee.name,
    b.invitee.email,
    b.invitee.phone ?? '',
    b.invitee.timezone,
    (b.guests ?? []).join(', '),
    hostNames,
    where,
    b.location?.joinUrl ?? '',
    b.attendance?.confirmedAt ? `yes (${b.attendance.confirmedVia ?? 'link'})` : 'no',
    b.attendance?.noShow ? 'yes' : 'no',
    b.rescheduledFromStart ?? '',
    b.cancellation?.at ?? '',
    b.cancellation?.by ?? '',
    b.cancellation?.reason ?? '',
    answers,
    b.createdAt,
    b.source,
  ];
}

/** GET /admin/bookings.csv?scope=&q= : the same selection as the list. Without a scope, every booking. */
export async function exportBookingsCsv(ctx: Ctx, params: URLSearchParams): Promise<{ filename: string; body: string }> {
  const nowMs = ctx.now().getTime();
  const scope: ExportScope = parseScope(params.get('scope')) ?? 'all';
  const [index, hosts, site] = await Promise.all([getBookingIndex(ctx), listHosts(ctx), getSite(ctx)]);
  const selected = selectEntries(index, scope, searchTerms(params.get('q')), nowMs);
  if (selected.length > MAX_EXPORT_ROWS) ctx.log('warn', 'bookings export: more rows than one export holds', { rows: selected.length, kept: MAX_EXPORT_ROWS });
  const bookings = await getBookings(ctx, selected.slice(0, MAX_EXPORT_ROWS).map((entry) => entry.id));

  const ownerZone = ownerOf(hosts, site)?.timezone ?? 'UTC';
  const zone = IANAZone.isValidZone(ownerZone) ? ownerZone : 'UTC';
  const byId = hostMap(hosts);
  const header = [
    'Booking ID',
    'Status',
    'Event',
    'Start (UTC)',
    'End (UTC)',
    `Local start (${zone})`,
    'Minutes',
    'Invitee',
    'Email',
    'Phone',
    'Invitee time zone',
    'Guests',
    'Hosts',
    'Location',
    'Join link',
    'Attendance confirmed',
    'No-show',
    'Moved from (UTC)',
    'Cancelled at (UTC)',
    'Cancelled by',
    'Cancellation reason',
    'Answers',
    'Booked at (UTC)',
    'Source',
  ];
  const rows = [header, ...bookings.map((b) => bookingRow(b, byId, zone))];
  const day = DateTime.fromMillis(nowMs, { zone }).toFormat('yyyy-LL-dd');
  // The byte order mark makes spreadsheet apps read the file as UTF-8, so names with accents survive.
  return { filename: `bookings-${scope}-${day}.csv`, body: `\uFEFF${toCsv(rows)}` };
}
