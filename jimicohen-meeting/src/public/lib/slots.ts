/**
 * Slot loading for the booking widget.
 *
 * Slots are instants (UTC). Which calendar day a slot belongs to depends on the zone the
 * visitor is looking in, so the store keeps a zone-free pool of start times plus the UTC
 * ranges it has already asked for, and views (one month in one zone) are cut out of it:
 * switching zone re-renders instantly from the pool and only fetches the missing edges.
 *
 * In preview mode nothing is fetched: slots are generated deterministically.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { getSlots, isApiFailure } from '../../lib/api';
import { addDays, dayKey, monthRange, weekdayOfKey, zonedToMs } from '../../lib/tz';
import { hash32 } from './text';

export type SlotProblem = 'calendar_error' | 'inactive' | 'network' | 'error';

export type RangeStatus = { state: 'loading' } | { state: 'ready' } | { state: 'error'; problem: SlotProblem; message: string };

type Interval = [number, number];

interface Pool {
  /** sorted, unique start times in epoch ms */
  starts: number[];
  covered: Interval[];
}

export interface SlotStoreOptions {
  slug: string;
  /** generate fake slots, never call the API */
  preview: boolean;
  /** zone the fake working hours are laid out in */
  previewZone?: string;
  reschedule?: { bookingId: string; token: string };
}

const READY: RangeStatus = { state: 'ready' };
const LOADING: RangeStatus = { state: 'loading' };

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i[1] > i[0]).sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push([cur[0], cur[1]]);
  }
  return out;
}

function mergeStarts(a: number[], b: number[], from: number, to: number): number[] {
  // Fresh data replaces whatever the pool held for the same range.
  const kept = a.filter((s) => s < from || s >= to);
  const set = new Set<number>(kept);
  for (const s of b) set.add(s);
  return Array.from(set).sort((x, y) => x - y);
}

/** Believable fake availability: weekdays, working hours in the host zone, some gaps, some full days. */
export function previewStarts(durationMin: number, from: number, to: number, hostZone: string, now: number = Date.now()): number[] {
  const out: number[] = [];
  const step = Math.max(15, Math.min(durationMin, 60)) * 60000;
  const earliest = now + 3 * 3600000;
  let key = addDays(dayKey(from, hostZone), -1);
  const last = addDays(dayKey(to, hostZone), 1);
  for (let guard = 0; guard < 70 && key <= last; guard++, key = addDays(key, 1)) {
    const weekday = weekdayOfKey(key);
    if (weekday === 0 || weekday === 6) continue;
    if (hash32(`${key}|off`) % 7 === 0) continue;
    const open = zonedToMs(key, '09:00', hostZone);
    const close = zonedToMs(key, '17:00', hostZone);
    for (let s = open; s + durationMin * 60000 <= close; s += step) {
      if (s < from || s >= to || s < earliest) continue;
      if (hash32(`${key}|${s}`) % 100 < 38) continue;
      out.push(s);
    }
  }
  return out;
}

export class SlotStore {
  private readonly pools = new Map<number, Pool>();
  private readonly errors = new Map<string, { problem: SlotProblem; message: string }>();
  private readonly inflight = new Map<string, Promise<RangeStatus>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private generation = 0;

  constructor(private readonly options: SlotStoreOptions) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version += 1;
    for (const listener of Array.from(this.listeners)) listener();
  }

  private pool(duration: number): Pool {
    let p = this.pools.get(duration);
    if (!p) {
      p = { starts: [], covered: [] };
      this.pools.set(duration, p);
    }
    return p;
  }

  private isCovered(duration: number, from: number, to: number): boolean {
    return this.pool(duration).covered.some(([a, b]) => a <= from && b >= to);
  }

  private fill(duration: number, from: number, to: number, starts: number[]): void {
    const p = this.pool(duration);
    p.starts = mergeStarts(p.starts, starts, from, to);
    p.covered = mergeIntervals([...p.covered, [from, to]]);
  }

  private fillPreview(duration: number, from: number, to: number): void {
    this.fill(duration, from, to, previewStarts(duration, from, to, this.options.previewZone ?? 'UTC'));
  }

  status(duration: number, from: number, to: number): RangeStatus {
    if (this.options.preview) {
      if (!this.isCovered(duration, from, to)) this.fillPreview(duration, from, to);
      return READY;
    }
    if (this.isCovered(duration, from, to)) return READY;
    const err = this.errors.get(`${duration}|${from}|${to}`);
    if (err) return { state: 'error', ...err };
    return LOADING;
  }

  /** Start times inside [from, to), ascending. Past times are left out. */
  slots(duration: number, from: number, to: number, now: number = Date.now()): number[] {
    if (this.options.preview && !this.isCovered(duration, from, to)) this.fillPreview(duration, from, to);
    return this.pool(duration).starts.filter((s) => s >= from && s < to && s > now);
  }

  /** Makes sure [from, to) has been loaded. Resolves with the final status, never rejects. */
  ensure(duration: number, from: number, to: number): Promise<RangeStatus> {
    const current = this.status(duration, from, to);
    if (current.state !== 'loading') return Promise.resolve(current);
    const key = `${duration}|${from}|${to}`;
    const running = this.inflight.get(key);
    if (running) return running;

    const generation = this.generation;
    const { slug, reschedule } = this.options;
    const task = getSlots({ slug, durationMin: duration, from, to, rescheduleBookingId: reschedule?.bookingId, token: reschedule?.token })
      .then((res): RangeStatus => {
        if (generation !== this.generation) return this.status(duration, from, to);
        if (res.unavailableReason) {
          const problem: SlotProblem = res.unavailableReason === 'inactive' ? 'inactive' : 'calendar_error';
          const message =
            problem === 'inactive'
              ? 'This meeting type is not taking bookings right now.'
              : 'We could not check the calendar just now, so no times are shown. Please try again in a minute.';
          this.errors.set(key, { problem, message });
          return { state: 'error', problem, message };
        }
        const starts = res.slots.map((s) => Date.parse(s.start)).filter((n) => Number.isFinite(n));
        this.fill(duration, from, to, starts);
        return READY;
      })
      .catch((e: unknown): RangeStatus => {
        if (generation !== this.generation) return this.status(duration, from, to);
        const network = isApiFailure(e) && e.isNetwork;
        const message = isApiFailure(e) && e.message ? e.message : 'We could not load the available times. Please try again.';
        const problem: SlotProblem = network ? 'network' : 'error';
        this.errors.set(key, { problem, message });
        return { state: 'error', problem, message };
      })
      .finally(() => {
        if (this.inflight.get(key) === task) this.inflight.delete(key);
        this.emit();
      });
    this.inflight.set(key, task);
    return task;
  }

  /** Forgets a failed range so the next ensure() tries again. */
  retry(duration: number, from: number, to: number): Promise<RangeStatus> {
    this.errors.delete(`${duration}|${from}|${to}`);
    this.emit();
    return this.ensure(duration, from, to);
  }

  /** Drops everything, e.g. after the server says a slot was taken. */
  invalidate(): void {
    this.generation += 1;
    this.pools.clear();
    this.errors.clear();
    this.inflight.clear();
    this.emit();
  }

  /** Removes one start time straight away (it was just taken) without waiting for a refetch. */
  remove(duration: number, start: number): void {
    const p = this.pool(duration);
    p.starts = p.starts.filter((s) => s !== start);
    this.emit();
  }
}

export interface MonthSlots {
  status: RangeStatus;
  /** [from, to) of this month in the zone, epoch ms */
  range: { from: number; to: number };
  /** day key (in the zone) → start times, ascending */
  byDay: Map<string, number[]>;
  /** day keys that have at least one time, ascending */
  days: string[];
  total: number;
  retry: () => void;
}

/**
 * One calendar month as seen from `zone`. Asks the store for the UTC range that covers the
 * month in that zone and groups the slots by the day they fall on in that zone.
 */
export function useMonthSlots(store: SlotStore, duration: number, zone: string, year: number, month: number, enabled = true): MonthSlots {
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  const range = useMemo(() => monthRange(year, month, zone), [year, month, zone]);
  const status = store.status(duration, range.from, range.to);

  useEffect(() => {
    if (enabled && status.state === 'loading') void store.ensure(duration, range.from, range.to);
  }, [enabled, store, duration, range.from, range.to, status.state]);

  return useMemo(() => {
    const byDay = new Map<string, number[]>();
    const starts = store.slots(duration, range.from, range.to);
    for (const s of starts) {
      const key = dayKey(s, zone);
      const list = byDay.get(key);
      if (list) list.push(s);
      else byDay.set(key, [s]);
    }
    return {
      status,
      range,
      byDay,
      days: Array.from(byDay.keys()).sort(),
      total: starts.length,
      retry: () => void store.retry(duration, range.from, range.to),
    };
    // `version` invalidates the memo whenever the store changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, duration, zone, range, status.state, version]);
}
