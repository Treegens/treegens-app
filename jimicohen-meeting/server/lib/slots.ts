import type { BookingIndexEntry, DateOverride, EventType, Host, IanaZone, Schedule, TimeRange, Weekday, WeeklyHours } from '../../shared/types';
import {
  DAY_MS,
  MINUTE_MS,
  ZoneClock,
  intersectIntervals,
  isValidZone,
  mergeIntervals,
  parseHHMM,
  subtractIntervals,
  wallDate,
  zonedToUtcMs,
  type Interval,
} from './time';

/** busy = EXTERNAL calendar busy (not our own bookings) */
export interface HostAvailabilityInput {
  host: Host;
  busy: Interval[];
}

export interface SlotQuery {
  eventType: EventType;
  durationMin: number;
  hosts: HostAvailabilityInput[];
  ownerTimezone: IanaZone;
  range: Interval;
  nowMs: number;
  index: BookingIndexEntry[];
  ignoreBookingId?: string;
  /**
   * Opt-in. Buffers of our own bookings, keyed by event type id. When given, each confirmed booking in
   * `index` blocks [start - beforeMin, end + afterMin) instead of just [start, end), so a booking keeps
   * its own buffer no matter which of two neighbouring meetings was booked first. Without it only the
   * candidate meeting is padded.
   */
  ownBookingBuffers?: Record<string, { beforeMin: number; afterMin: number }>;
}

/** hostIds: all for collective; the free ones for round robin */
export interface Slot {
  startMs: number;
  endMs: number;
  hostIds: string[];
}

export type SlotRejection = 'invalid_duration' | 'not_on_grid' | 'too_soon' | 'too_far' | 'outside_hours' | 'busy' | 'daily_limit';

/*
 * Everything below works on sets of START TIMES rather than on candidates one by one. For a host,
 * "the meeting fits in a working window", "the padded meeting hits something busy" and "the day is
 * full" each turn into a short sorted list of intervals of start times. Availability is then set
 * algebra on those lists (subtract, intersect across hosts for collective, union for round robin),
 * and only the grid points inside the final set are ever generated. checkSlot asks the same sets
 * about a single start time, which is what keeps it in step with computeSlots.
 */

/** Days of clock-change data loaded around the times being examined, so nearby lookups stay on the fast path. */
const CLOCK_MARGIN_MS = 7 * DAY_MS;
/** A booking can only share a local calendar day with times at most this far away (the longest local day is 48h). */
const SAME_DAY_REACH_MS = 3 * DAY_MS;
/** Start times further from 1970 than this are refused outright: Date ends at 8.64e15 ms and zone data with it. */
const INSTANT_LIMIT = 8.64e15 - 366 * DAY_MS;
/** computeSlots refuses to enumerate more than this in one call. Callers page by month; this only stops runaways. */
const MAX_SPAN_MS = 3660 * DAY_MS;

function minutesOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function weekdayOfWall(wallMs: number): Weekday {
  return new Date(wallMs).getUTCDay() as Weekday;
}

function floorDay(wallMs: number): number {
  return Math.floor(wallMs / DAY_MS) * DAY_MS;
}

function contains(list: Interval[], ms: number): boolean {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ms < list[mid].start) hi = mid - 1;
    else if (ms >= list[mid].end) lo = mid + 1;
    else return true;
  }
  return false;
}

function assertRange(range: Interval): void {
  if (!range || Number.isNaN(range.start) || Number.isNaN(range.end) || typeof range.start !== 'number' || typeof range.end !== 'number') {
    throw new RangeError('A slot range needs numeric start and end times');
  }
}

/**
 * Working windows of weekly hours (plus date overrides) inside `range`, as instants. Dates and times
 * are read on `clock`'s wall clock. A date override replaces that date's weekly ranges.
 */
function weeklyWindows(clock: ZoneClock, weekly: WeeklyHours | null | undefined, overrides: DateOverride[] | null | undefined, range: Interval): Interval[] {
  if (!(range.end > range.start)) return [];
  const byDate = new Map<string, TimeRange[]>();
  for (const override of overrides ?? []) {
    if (override && typeof override.date === 'string') byDate.set(override.date, Array.isArray(override.ranges) ? override.ranges : []);
  }
  // Every instant in the range falls on one of the local dates between its two ends. The extra day on each
  // side is slack that costs nothing.
  const firstDay = floorDay(clock.wallOf(range.start)) - DAY_MS;
  const lastDay = floorDay(clock.wallOf(range.end)) + DAY_MS;
  const found: Interval[] = [];
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    const ranges = byDate.get(wallDate(day)) ?? weekly?.[weekdayOfWall(day)] ?? [];
    if (!Array.isArray(ranges)) continue;
    for (const r of ranges) {
      const from = parseHHMM(r?.start);
      const to = parseHHMM(r?.end);
      if (from === null || to === null || to <= from) continue;
      const start = clock.wallToUtc(day + from * MINUTE_MS);
      const end = clock.wallToUtc(day + to * MINUTE_MS);
      // A range swallowed whole by a clock change collapses to nothing.
      if (end > start) found.push({ start, end });
    }
  }
  return intersectIntervals(found, [range]);
}

/**
 * The instants inside `range` when a schedule is open, read in `tz`. Sorted, merged (ranges that touch
 * become one window) and clipped to `range`.
 */
export function scheduleWindows(schedule: Schedule, tz: IanaZone, range: Interval): Interval[] {
  assertRange(range);
  if (!(range.end > range.start)) return [];
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) throw new RangeError('scheduleWindows needs a finite range');
  const clock = new ZoneClock(tz, { start: range.start - CLOCK_MARGIN_MS, end: range.end + CLOCK_MARGIN_MS });
  return weeklyWindows(clock, schedule.weekly, schedule.overrides, range);
}

interface OwnBooking {
  start: number;
  end: number;
  hostIds: string[];
  eventTypeId: string;
}

interface Prepared {
  eventType: EventType;
  hostIds: string[];
  inputs: Map<string, HostAvailabilityInput>;
  ownerTimezone: IanaZone;
  durationMs: number;
  stepMs: number;
  bufferBeforeMs: number;
  bufferAfterMs: number;
  maxPerDay: number | null;
  restrictHours: WeeklyHours | null;
  /** confirmed bookings that count, without the one being rescheduled */
  bookings: OwnBooking[];
  /** the booking being rescheduled: its time is handed back to its hosts */
  released: OwnBooking[];
  ownBuffers: Record<string, { beforeMin: number; afterMin: number }> | null;
  /** a start must be >= lowerBound and < upperBound */
  lowerBound: number;
  upperBound: number;
}

function hardWindow(dateRange: EventType['scheduling']['dateRange'], ownerTimezone: IanaZone): Interval | null {
  if (!dateRange) return null;
  try {
    return {
      start: zonedToUtcMs(dateRange.start, '00:00', ownerTimezone),
      end: zonedToUtcMs(dateRange.end, '24:00', ownerTimezone),
    };
  } catch {
    // A hard window we cannot read must not turn into "always open".
    return { start: Number.POSITIVE_INFINITY, end: Number.NEGATIVE_INFINITY };
  }
}

/** Shared front half of computeSlots and checkSlot. null means the duration is not offered by this event type. */
function prepare(q: SlotQuery): Prepared | null {
  assertRange(q.range);
  if (!Number.isFinite(q.nowMs)) throw new RangeError('nowMs must be a real time');
  if (!isValidZone(q.ownerTimezone)) throw new RangeError(`Unknown owner time zone: ${String(q.ownerTimezone)}`);

  const eventType = q.eventType;
  const durations = Array.isArray(eventType.durations) ? eventType.durations : [];
  if (!Number.isFinite(q.durationMin) || q.durationMin <= 0 || !durations.includes(q.durationMin)) return null;
  const scheduling = eventType.scheduling;

  const increment = scheduling.slotIncrementMin;
  const stepMin = Number.isFinite(increment) ? Math.min(1440, Math.max(1, Math.round(increment))) : 30;
  const cap = scheduling.maxPerDay;
  const maxDays = scheduling.maxDaysAhead;

  const bookings: OwnBooking[] = [];
  const released: OwnBooking[] = [];
  for (const entry of q.index ?? []) {
    if (!entry || entry.status !== 'confirmed') continue;
    const start = Date.parse(entry.start);
    const end = Date.parse(entry.end);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const own: OwnBooking = { start, end, hostIds: Array.isArray(entry.hostIds) ? entry.hostIds : [], eventTypeId: entry.eventTypeId };
    if (q.ignoreBookingId !== undefined && entry.id === q.ignoreBookingId) released.push(own);
    else bookings.push(own);
  }

  const lower = [q.range.start, q.nowMs + minutesOrZero(scheduling.minNoticeMinutes) * MINUTE_MS];
  const upper = [q.range.end, Number.isFinite(maxDays) ? q.nowMs + Math.max(0, maxDays) * DAY_MS : Number.POSITIVE_INFINITY];
  const window = hardWindow(scheduling.dateRange, q.ownerTimezone);
  if (window) {
    lower.push(window.start);
    upper.push(window.end);
  }

  const inputs = new Map<string, HostAvailabilityInput>();
  for (const input of q.hosts ?? []) {
    if (input?.host && !inputs.has(input.host.id)) inputs.set(input.host.id, input);
  }

  return {
    eventType,
    hostIds: [...new Set(eventType.hostIds ?? [])],
    inputs,
    ownerTimezone: q.ownerTimezone,
    durationMs: Math.round(q.durationMin * MINUTE_MS),
    stepMs: stepMin * MINUTE_MS,
    bufferBeforeMs: Math.round(minutesOrZero(scheduling.bufferBeforeMin) * MINUTE_MS),
    bufferAfterMs: Math.round(minutesOrZero(scheduling.bufferAfterMin) * MINUTE_MS),
    maxPerDay: typeof cap === 'number' && Number.isFinite(cap) && cap >= 1 ? cap : null,
    restrictHours: scheduling.restrictHours ?? null,
    bookings,
    released,
    ownBuffers: q.ownBookingBuffers ?? null,
    lowerBound: Math.max(...lower),
    upperBound: Math.min(...upper),
  };
}

/** Clocks and shared windows for one stretch of start times. */
interface Scope {
  /** the start times being examined, whole ms, half-open */
  bounds: Interval;
  /** bounds stretched by one meeting length: the time a meeting starting in bounds can occupy */
  span: Interval;
  clock(tz: IanaZone): ZoneClock;
  /** restrictHours as instants in the owner's zone, null when the event type has none */
  restrictWindows: Interval[] | null;
}

function makeScope(p: Prepared, bounds: Interval): Scope {
  const span = { start: bounds.start, end: bounds.end + p.durationMs };
  const cover = { start: bounds.start - CLOCK_MARGIN_MS, end: span.end + CLOCK_MARGIN_MS };
  const clocks = new Map<string, ZoneClock>();
  const clock = (tz: IanaZone): ZoneClock => {
    let found = clocks.get(tz);
    if (!found) {
      found = new ZoneClock(tz, cover);
      clocks.set(tz, found);
    }
    return found;
  };
  const restrictWindows = p.restrictHours ? weeklyWindows(clock(p.ownerTimezone), p.restrictHours, null, span) : null;
  return { bounds, span, clock, restrictWindows };
}

function scheduleFor(eventType: EventType, host: Host): Schedule | null {
  const schedules = Array.isArray(host.schedules) ? host.schedules : [];
  const chosen = eventType.scheduling.scheduleIds?.[host.id];
  return (
    (chosen ? schedules.find((s) => s.id === chosen) : undefined) ??
    schedules.find((s) => s.id === host.defaultScheduleId) ??
    schedules[0] ??
    null
  );
}

/** For one host: start times that fit their hours, start times ruled out by something busy, start times on a full day. */
interface HostPlan {
  hostId: string;
  inHours: Interval[];
  busyBlocked: Interval[];
  capBlocked: Interval[];
}

function planHost(p: Prepared, hostId: string, scope: Scope): HostPlan {
  const plan: HostPlan = { hostId, inHours: [], busyBlocked: [], capBlocked: [] };
  const input = p.inputs.get(hostId);
  // A host we know nothing about, or whose zone we cannot read, is never free. For collective events that closes the slot.
  if (!input || !isValidZone(input.host.timezone)) return plan;
  const host = input.host;
  const schedule = scheduleFor(p.eventType, host);
  if (!schedule) return plan;
  const { bounds } = scope;
  const hostClock = scope.clock(host.timezone);

  let windows = weeklyWindows(hostClock, schedule.weekly, schedule.overrides, scope.span);
  if (scope.restrictWindows) windows = intersectIntervals(windows, scope.restrictWindows);
  for (const w of windows) {
    // [s, s + duration) fits in [w.start, w.end) exactly when w.start <= s <= w.end - duration.
    const start = Math.max(w.start, bounds.start);
    const end = Math.min(w.end - p.durationMs + 1, bounds.end);
    if (end > start) plan.inHours.push({ start, end });
  }

  // The padded meeting [s - before, s + duration + after) overlaps busy [x, y) exactly when
  // x - duration - after < s < y + before.
  const blockedBy = (busy: Interval): Interval => ({
    start: Math.floor(busy.start - p.durationMs - p.bufferAfterMs) + 1,
    end: Math.ceil(busy.end + p.bufferBeforeMs),
  });
  const matters = (busy: Interval): boolean => {
    const blocked = blockedBy(busy);
    return blocked.start < bounds.end && blocked.end > bounds.start;
  };

  let external = mergeIntervals((input.busy ?? []).filter((b) => b && b.start < b.end && matters(b)));
  const handedBack = p.released.filter((b) => b.hostIds.includes(hostId)).map((b) => ({ start: b.start, end: b.end }));
  if (handedBack.length > 0) external = subtractIntervals(external, handedBack);

  const own: Interval[] = [];
  for (const booking of p.bookings) {
    if (!booking.hostIds.includes(hostId)) continue;
    const pad = p.ownBuffers?.[booking.eventTypeId];
    const taken = {
      start: booking.start - minutesOrZero(pad?.beforeMin) * MINUTE_MS,
      end: booking.end + minutesOrZero(pad?.afterMin) * MINUTE_MS,
    };
    if (taken.start < taken.end && matters(taken)) own.push(taken);
  }
  plan.busyBlocked = mergeIntervals([...external, ...own].map(blockedBy));

  if (p.maxPerDay !== null) {
    // Count this event type's bookings per calendar day on the host's own wall clock.
    const perDay = new Map<number, number>();
    for (const booking of p.bookings) {
      if (booking.eventTypeId !== p.eventType.id || !booking.hostIds.includes(hostId)) continue;
      if (booking.start < bounds.start - SAME_DAY_REACH_MS || booking.start >= bounds.end + SAME_DAY_REACH_MS) continue;
      const day = floorDay(hostClock.wallOf(booking.start));
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    const full: Interval[] = [];
    for (const [day, count] of perDay) {
      if (count >= p.maxPerDay) full.push({ start: hostClock.wallToUtc(day), end: hostClock.wallToUtc(day + DAY_MS) });
    }
    plan.capBlocked = mergeIntervals(full);
  }
  return plan;
}

function freeStarts(plan: HostPlan): Interval[] {
  return subtractIntervals(subtractIntervals(plan.inHours, plan.busyBlocked), plan.capBlocked);
}

/** Whether an instant reads as a whole number of steps after midnight on the clock's wall. */
function isOnGrid(clock: ZoneClock, stepMs: number, ms: number): boolean {
  const wall = clock.wallOf(ms);
  return (wall - floorDay(wall)) % stepMs === 0;
}

/**
 * Grid points inside `allowed`, ascending. The grid is every wall-clock time in the owner's zone that is a
 * whole number of steps after local midnight, so slots stay on the same clock times on days when the clocks
 * change: a skipped wall time simply has no slot, and a repeated one has a slot for each occurrence.
 */
function gridStarts(allowed: Interval[], clock: ZoneClock, stepMs: number, bounds: Interval): number[] {
  const segments = clock.segmentsIn(bounds);
  const out: number[] = [];
  let first = 0;
  for (const iv of allowed) {
    while (first < segments.length && segments[first].end <= iv.start) first++;
    for (let i = first; i < segments.length && segments[i].start < iv.end; i++) {
      const offset = segments[i].offsetMs;
      const wallFrom = Math.max(iv.start, segments[i].start) + offset;
      const wallTo = Math.min(iv.end, segments[i].end) + offset;
      for (let day = floorDay(wallFrom); day < wallTo; day += DAY_MS) {
        const dayEnd = Math.min(day + DAY_MS, wallTo);
        const k = Math.max(0, Math.ceil((wallFrom - day) / stepMs));
        for (let wall = day + k * stepMs; wall < dayEnd; wall += stepMs) out.push(wall - offset);
      }
    }
  }
  return out;
}

/** Whole-ms bounds on start times from the notice period, the rolling window, the hard date window and the query range. */
function startBounds(p: Prepared): Interval {
  return { start: Math.ceil(p.lowerBound), end: Math.ceil(p.upperBound) };
}

/**
 * Every bookable start time in `q.range`, ascending. Throws RangeError when the range is unbounded or
 * longer than ten years after the event type's own limits are applied, and when the owner zone is unknown.
 */
export function computeSlots(q: SlotQuery): Slot[] {
  const p = prepare(q);
  if (!p || p.hostIds.length === 0) return [];
  const bounds = startBounds(p);
  if (!(bounds.end > bounds.start)) return [];
  if (!Number.isFinite(bounds.start) || !Number.isFinite(bounds.end)) throw new RangeError('computeSlots needs a finite range');
  bounds.start = Math.max(bounds.start, -INSTANT_LIMIT);
  bounds.end = Math.min(bounds.end, INSTANT_LIMIT + 1);
  if (!(bounds.end > bounds.start)) return [];
  if (bounds.end - bounds.start > MAX_SPAN_MS) throw new RangeError('computeSlots range is too long');

  const scope = makeScope(p, bounds);
  const free = p.hostIds.map((hostId) => ({ hostId, starts: freeStarts(planHost(p, hostId, scope)) }));
  const roundRobin = p.eventType.kind === 'round_robin';

  let allowed: Interval[];
  if (roundRobin) {
    allowed = mergeIntervals(free.flatMap((f) => f.starts));
  } else {
    allowed = free[0].starts;
    for (let i = 1; i < free.length && allowed.length > 0; i++) allowed = intersectIntervals(allowed, free[i].starts);
  }
  if (allowed.length === 0) return [];

  const starts = gridStarts(allowed, scope.clock(p.ownerTimezone), p.stepMs, bounds);
  if (!roundRobin) return starts.map((startMs) => ({ startMs, endMs: startMs + p.durationMs, hostIds: [...p.hostIds] }));

  // Starts ascend, so each host's interval list is walked once.
  const cursors = free.map(() => 0);
  return starts.map((startMs) => {
    const hostIds: string[] = [];
    free.forEach((f, i) => {
      while (cursors[i] < f.starts.length && f.starts[cursors[i]].end <= startMs) cursors[i]++;
      const at = f.starts[cursors[i]];
      if (at && at.start <= startMs) hostIds.push(f.hostId);
    });
    return { startMs, endMs: startMs + p.durationMs, hostIds };
  });
}

/**
 * Whether one start time is bookable, with the same answer computeSlots gives for the same query: a start
 * outside `q.range` is rejected too (too_soon before it, too_far at or after its end). When the answer is no,
 * `reason` is the first check that failed, in the order the SlotRejection type lists them. With several hosts:
 * collective reports the strongest objection any host has (outside_hours, then busy, then daily_limit);
 * round robin reports the mildest one (busy, then daily_limit, then outside_hours), since every host failed.
 */
export function checkSlot(q: SlotQuery, startMs: number): { ok: true; hostIds: string[] } | { ok: false; reason: SlotRejection } {
  const p = prepare(q);
  if (!p) return { ok: false, reason: 'invalid_duration' };
  if (!Number.isInteger(startMs)) return { ok: false, reason: 'not_on_grid' };
  if (Math.abs(startMs) > INSTANT_LIMIT) return { ok: false, reason: startMs < 0 ? 'too_soon' : 'too_far' };

  const scope = makeScope(p, { start: startMs, end: startMs + 1 });
  if (!isOnGrid(scope.clock(p.ownerTimezone), p.stepMs, startMs)) return { ok: false, reason: 'not_on_grid' };
  if (startMs < p.lowerBound) return { ok: false, reason: 'too_soon' };
  if (!(startMs < p.upperBound)) return { ok: false, reason: 'too_far' };

  const freeHostIds: string[] = [];
  const objections = new Set<SlotRejection>();
  for (const hostId of p.hostIds) {
    const plan = planHost(p, hostId, scope);
    if (!contains(plan.inHours, startMs)) objections.add('outside_hours');
    else if (contains(plan.busyBlocked, startMs)) objections.add('busy');
    else if (contains(plan.capBlocked, startMs)) objections.add('daily_limit');
    else freeHostIds.push(hostId);
  }

  if (p.eventType.kind === 'round_robin') {
    if (freeHostIds.length > 0) return { ok: true, hostIds: freeHostIds };
    const reason = (['busy', 'daily_limit'] as const).find((r) => objections.has(r)) ?? 'outside_hours';
    return { ok: false, reason };
  }
  if (p.hostIds.length > 0 && objections.size === 0) return { ok: true, hostIds: [...p.hostIds] };
  const reason = (['outside_hours', 'busy'] as const).find((r) => objections.has(r)) ?? (objections.has('daily_limit') ? 'daily_limit' : 'outside_hours');
  return { ok: false, reason };
}

/**
 * Who gets the next round robin booking: the candidate with the fewest confirmed upcoming bookings; on a tie
 * the one whose most recent confirmed booking starts earliest (never booked wins); then the smallest id.
 */
export function pickRoundRobinHost(candidateHostIds: string[], index: BookingIndexEntry[], nowMs: number): string {
  const candidates = [...new Set(candidateHostIds)];
  if (candidates.length === 0) throw new RangeError('pickRoundRobinHost needs at least one candidate');
  const load = new Map(candidates.map((id) => [id, { upcoming: 0, latest: Number.NEGATIVE_INFINITY }]));
  for (const entry of index ?? []) {
    if (!entry || entry.status !== 'confirmed') continue;
    const start = Date.parse(entry.start);
    if (Number.isNaN(start)) continue;
    for (const hostId of new Set(entry.hostIds ?? [])) {
      const stats = load.get(hostId);
      if (!stats) continue;
      if (start > nowMs) stats.upcoming++;
      if (start > stats.latest) stats.latest = start;
    }
  }
  let best = candidates[0];
  for (const id of candidates.slice(1)) {
    const a = load.get(id)!;
    const b = load.get(best)!;
    if (a.upcoming !== b.upcoming ? a.upcoming < b.upcoming : a.latest !== b.latest ? a.latest < b.latest : id < best) best = id;
  }
  return best;
}
