import { DateTime, IANAZone } from 'luxon';
import type { HHMM, IanaZone, LocalDate, Weekday } from '../../shared/types';

/** epoch ms, half-open [start, end) */
export interface Interval {
  start: number;
  end: number;
}

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/*
 * "Wall ms" is used throughout this file: a wall-clock reading (date + time of day in some zone)
 * encoded as the epoch ms it would have if that zone were UTC. Converting between wall ms and real
 * instants is then plain arithmetic with the zone's UTC offset, which luxon supplies.
 *
 * Luxon's own local-time constructors resolve an ambiguous wall time (the repeated hour when clocks
 * go back) using the offset in force "now", so the answer changes with the season the code runs in.
 * Bookings need one fixed answer, so wall times are resolved here against luxon's offset data with
 * explicit rules: a repeated wall time is its first occurrence, a skipped wall time is the instant
 * the clocks jump.
 */

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** Verdicts already reached. Asking the runtime builds an Intl formatter each time, which is far too slow for hot paths. */
const zoneVerdicts = new Map<string, boolean>();
const MAX_ZONE_VERDICTS = 2048;

/** A named IANA zone the runtime knows ("Africa/Nairobi", "UTC"). Bare UTC offsets are not zones. */
export function isValidZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64 || !ZONE_NAME.test(tz)) return false;
  let verdict = zoneVerdicts.get(tz);
  if (verdict === undefined) {
    verdict = IANAZone.isValidZone(tz);
    if (zoneVerdicts.size >= MAX_ZONE_VERDICTS) zoneVerdicts.clear();
    zoneVerdicts.set(tz, verdict);
  }
  return verdict;
}

function zoneOf(tz: IanaZone): IANAZone {
  if (!isValidZone(tz)) throw new RangeError(`Unknown time zone: ${String(tz)}`);
  return IANAZone.create(tz);
}

function offsetMsAt(zone: IANAZone, ms: number): number {
  const minutes = zone.offset(ms);
  // Beyond the range of Date there is no offset. Failing here also keeps the searches below from spinning on NaN.
  if (Number.isNaN(minutes)) throw new RangeError('Time out of range');
  return Math.round(minutes * MINUTE_MS);
}

/** Wall ms of 00:00 on a calendar date. Throws on anything that is not a real "YYYY-MM-DD" date. */
export function wallDayStart(date: LocalDate): number {
  const m = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) throw new RangeError(`Invalid date: ${String(date)}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    throw new RangeError(`Invalid date: ${date}`);
  }
  return ms;
}

/** The calendar date ("YYYY-MM-DD") a wall ms value falls on. */
export function wallDate(wallMs: number): LocalDate {
  if (!Number.isFinite(wallMs)) throw new RangeError('Invalid time value');
  return new Date(Math.floor(wallMs / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** Minutes since midnight for "HH:MM" (0..1439) or 1440 for "24:00". null when the text is not a time. */
export function parseHHMM(time: unknown): number | null {
  const m = typeof time === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(time) : null;
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours === 24 && minutes === 0) return 1440;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** A stretch of time during which a zone keeps one UTC offset. */
export interface OffsetSegment {
  start: number;
  end: number;
  offsetMs: number;
}

/** Smallest t in (lo, hi] whose offset differs from the offset at lo. The caller guarantees the offset at hi differs. */
function firstOffsetChange(zone: IANAZone, lo: number, hi: number, loOffset: number): number {
  let a = lo;
  let b = hi;
  while (b - a > 1) {
    const mid = Math.floor((a + b) / 2);
    if (offsetMsAt(zone, mid) === loOffset) a = mid;
    else b = mid;
  }
  return b;
}

interface OffsetChange {
  at: number;
  offsetMs: number;
}

/**
 * What we have learned about a zone, per UTC day number: the offset at the start of the day, and the
 * clock changes inside the days that have any. Asking Intl for an offset costs about 10 microseconds
 * and zone rules do not change while the process runs, so every answer is kept. Bounded, see below.
 */
interface ZoneDays {
  atDayStart: Map<number, number>;
  changes: Map<number, OffsetChange[]>;
}

const MAX_CACHED_ZONES = 64;
const MAX_CACHED_DAYS_PER_ZONE = 4096;
const zoneDays = new Map<string, ZoneDays>();

function daysOf(zone: IANAZone): ZoneDays {
  let days = zoneDays.get(zone.name);
  if (!days) {
    if (zoneDays.size >= MAX_CACHED_ZONES) zoneDays.clear();
    days = { atDayStart: new Map(), changes: new Map() };
    zoneDays.set(zone.name, days);
  }
  return days;
}

function offsetAtDayStart(zone: IANAZone, days: ZoneDays, day: number): number {
  let offset = days.atDayStart.get(day);
  if (offset === undefined) {
    if (days.atDayStart.size >= MAX_CACHED_DAYS_PER_ZONE) {
      days.atDayStart.clear();
      days.changes.clear();
    }
    offset = offsetMsAt(zone, day * DAY_MS);
    days.atDayStart.set(day, offset);
  }
  return offset;
}

/** Clock changes in (day start, next day start], given the differing offsets at both ends. */
function changesWithin(zone: IANAZone, days: ZoneDays, day: number, startOffset: number, endOffset: number): OffsetChange[] {
  let found = days.changes.get(day);
  if (!found) {
    found = [];
    const dayEnd = (day + 1) * DAY_MS;
    let lo = day * DAY_MS;
    let loOffset = startOffset;
    while (loOffset !== endOffset) {
      lo = firstOffsetChange(zone, lo, dayEnd, loOffset);
      loOffset = offsetMsAt(zone, lo);
      found.push({ at: lo, offsetMs: loOffset });
    }
    days.changes.set(day, found);
  }
  return found;
}

/**
 * Constant-offset segments covering [from, to). Offsets are sampled at the start of each UTC day and
 * every change is then pinned to the exact millisecond, so a zone would need two opposite clock changes
 * inside one day to be misread, which no zone has.
 */
function buildSegments(zone: IANAZone, from: number, to: number): OffsetSegment[] {
  const days = daysOf(zone);
  const firstDay = Math.floor(from / DAY_MS);
  const lastDay = Math.floor(to / DAY_MS);
  const segments: OffsetSegment[] = [];
  const push = (start: number, end: number, offsetMs: number): void => {
    const clippedStart = Math.max(start, from);
    const clippedEnd = Math.min(end, to);
    if (clippedEnd > clippedStart) segments.push({ start: clippedStart, end: clippedEnd, offsetMs });
  };
  let segmentStart = firstDay * DAY_MS;
  let offset = offsetAtDayStart(zone, days, firstDay);
  for (let day = firstDay; day <= lastDay; day++) {
    const next = offsetAtDayStart(zone, days, day + 1);
    if (next === offset) continue;
    for (const change of changesWithin(zone, days, day, offset, next)) {
      push(segmentStart, change.at, offset);
      segmentStart = change.at;
      offset = change.offsetMs;
    }
  }
  push(segmentStart, (lastDay + 1) * DAY_MS, offset);
  return segments;
}

/** The instant a wall time denotes, or null when these segments do not cover it. */
function resolveWall(segments: OffsetSegment[], wallMs: number): number | null {
  // Segments are in time order, so the first hit is the earliest instant: the first occurrence of a repeated wall time.
  for (const segment of segments) {
    const instant = wallMs - segment.offsetMs;
    if (instant >= segment.start && instant < segment.end) return instant;
  }
  // No instant shows this wall time: it sits in the hole left by clocks jumping forward. Use the jump itself.
  for (let i = 1; i < segments.length; i++) {
    const jump = segments[i].start;
    if (wallMs >= jump + segments[i - 1].offsetMs && wallMs < jump + segments[i].offsetMs) return jump;
  }
  return null;
}

function resolveWallAlone(zone: IANAZone, wallMs: number): number {
  // Offsets lie between -12h and +14h, so the answer and any clock change that affects it are within a day of wallMs.
  const resolved = resolveWall(buildSegments(zone, wallMs - DAY_MS, wallMs + DAY_MS), wallMs);
  if (resolved !== null) return resolved;
  return DateTime.fromMillis(wallMs, { zone: 'utc' }).setZone(zone, { keepLocalTime: true }).toMillis();
}

/**
 * Offset lookups and wall-time conversion for one zone, with the zone's clock changes over `cover`
 * worked out once. Converting hundreds of schedule ranges then costs arithmetic instead of an Intl
 * call each. Requests outside the cover still work: they are resolved one at a time.
 */
export class ZoneClock {
  readonly tz: IanaZone;
  private readonly zone: IANAZone;
  private readonly from: number;
  private readonly to: number;
  private readonly segments: OffsetSegment[];

  constructor(tz: IanaZone, cover: Interval) {
    this.zone = zoneOf(tz);
    this.tz = tz;
    if (!Number.isFinite(cover.start) || !Number.isFinite(cover.end) || cover.end < cover.start) {
      throw new RangeError('ZoneClock needs a finite cover');
    }
    this.from = Math.floor(cover.start);
    this.to = Math.max(Math.ceil(cover.end), this.from + 1);
    this.segments = buildSegments(this.zone, this.from, this.to);
  }

  /** UTC offset in ms at an instant (positive east of Greenwich). */
  offsetAt(ms: number): number {
    if (ms >= this.from && ms < this.to) {
      for (const segment of this.segments) {
        if (ms < segment.end) return segment.offsetMs;
      }
    }
    return offsetMsAt(this.zone, ms);
  }

  /** The wall clock reading at an instant, as wall ms. */
  wallOf(ms: number): number {
    return ms + this.offsetAt(ms);
  }

  /** The instant a wall clock reading denotes. Same rules as zonedToUtcMs. */
  wallToUtc(wallMs: number): number {
    if (wallMs - DAY_MS >= this.from && wallMs + DAY_MS <= this.to) {
      const resolved = resolveWall(this.segments, wallMs);
      if (resolved !== null) return resolved;
    }
    return resolveWallAlone(this.zone, wallMs);
  }

  /** Constant-offset segments clipped to a range, in time order. */
  segmentsIn(range: Interval): OffsetSegment[] {
    if (!(range.end > range.start)) return [];
    const source =
      range.start >= this.from && range.end <= this.to
        ? this.segments
        : buildSegments(this.zone, Math.floor(range.start), Math.ceil(range.end));
    const out: OffsetSegment[] = [];
    for (const segment of source) {
      const start = Math.max(segment.start, range.start);
      const end = Math.min(segment.end, range.end);
      if (end > start) out.push({ start, end, offsetMs: segment.offsetMs });
    }
    return out;
  }
}

/**
 * The instant at which a wall clock in `tz` reads `date` `time`. "24:00" is the next local midnight.
 * A wall time skipped by a clock change moves forward to the first instant after the jump; a wall
 * time that happens twice is its first occurrence.
 */
export function zonedToUtcMs(date: LocalDate, time: HHMM, tz: IanaZone): number {
  const zone = zoneOf(tz);
  const minutes = parseHHMM(time);
  if (minutes === null) throw new RangeError(`Invalid time: ${String(time)}`);
  return resolveWallAlone(zone, wallDayStart(date) + minutes * MINUTE_MS);
}

/** The calendar date in `tz` at an instant. */
export function localDateOf(ms: number, tz: IanaZone): LocalDate {
  const zone = zoneOf(tz);
  if (!Number.isFinite(ms)) throw new RangeError('Invalid time value');
  return wallDate(ms + offsetMsAt(zone, ms));
}

export function addDays(date: LocalDate, n: number): LocalDate {
  if (!Number.isInteger(n)) throw new RangeError(`addDays needs a whole number of days, got ${String(n)}`);
  return wallDate(wallDayStart(date) + n * DAY_MS);
}

/** 0 = Sunday */
export function weekdayOf(date: LocalDate): Weekday {
  return new Date(wallDayStart(date)).getUTCDay() as Weekday;
}

/** Sorted, non-overlapping union. Touching intervals are joined; empty or malformed ones are dropped. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((iv) => iv.start < iv.end).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

/** Everything in `base` that is not in `remove`, as a sorted, non-overlapping list. */
export function subtractIntervals(base: Interval[], remove: Interval[]): Interval[] {
  const kept = mergeIntervals(base);
  const cuts = mergeIntervals(remove);
  const out: Interval[] = [];
  let first = 0;
  for (const iv of kept) {
    while (first < cuts.length && cuts[first].end <= iv.start) first++;
    let cursor = iv.start;
    for (let i = first; i < cuts.length && cuts[i].start < iv.end && cursor < iv.end; i++) {
      if (cuts[i].start > cursor) out.push({ start: cursor, end: cuts[i].start });
      cursor = cuts[i].end;
    }
    if (cursor < iv.end) out.push({ start: cursor, end: iv.end });
  }
  return out;
}

/** The time covered by both lists, as a sorted, non-overlapping list. */
export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i].start, right[j].start);
    const end = Math.min(left[i].end, right[j].end);
    if (end > start) out.push({ start, end });
    if (left[i].end < right[j].end) i++;
    else j++;
  }
  return out;
}

const FORMATS: Record<'full' | 'date' | 'time' | 'short', Intl.DateTimeFormatOptions> = {
  full: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' },
  date: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
  time: { hour: 'numeric', minute: '2-digit' },
  short: { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
};

function usableLocale(locale: string | undefined): string {
  if (typeof locale !== 'string' || locale.length === 0) return 'en-US';
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale.replace(/_/g, '-')])[0] ?? 'en-US';
  } catch {
    return 'en-US';
  }
}

/** Intl separates "3:30" from "PM" with a narrow no-break space, which breaks plain-text matching and forces SMS into UCS-2. */
function plainSpaces(text: string): string {
  return text.replace(/[\u00a0\u2007\u2009\u202f]/g, ' ');
}

function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
}

/**
 * Human-readable time in a zone. With the default en-US locale:
 *   full   "Tuesday, November 17, 2026 at 3:30 PM EST"
 *   date   "Tuesday, November 17, 2026"
 *   time   "3:30 PM"
 *   short  "Tue, Nov 17, 3:30 PM"
 *   spoken "Tuesday, November 17th at 3:30 PM" (for the voice assistant: no year, no zone, 12 hour clock in English)
 * Output only ever contains ordinary spaces. An unknown zone falls back to UTC and an unusable locale to en-US,
 * so a message can still be rendered.
 */
export function formatInZone(ms: number, tz: IanaZone, style: 'full' | 'date' | 'time' | 'short' | 'spoken', locale?: string): string {
  if (!Number.isFinite(ms)) throw new RangeError('formatInZone needs a valid time');
  const lang = usableLocale(locale);
  const dt = DateTime.fromMillis(ms, { zone: isValidZone(tz) ? tz : 'UTC' }).setLocale(lang);
  if (!dt.isValid) throw new RangeError('formatInZone needs a valid time');
  if (style === 'spoken') {
    if (/^en(?:-|$)/i.test(lang)) {
      const en = dt.setLocale('en-US');
      const time = en.toLocaleString({ hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
      return plainSpaces(`${en.toFormat('cccc, LLLL')} ${ordinal(en.day)} at ${time}`);
    }
    return plainSpaces(dt.toLocaleString({ weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  }
  const options = FORMATS[style];
  if (!options) throw new RangeError(`Unknown format style: ${String(style)}`);
  return plainSpaces(dt.toLocaleString(options));
}
