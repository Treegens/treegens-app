// STUB
import type { HHMM, IanaZone, LocalDate, Weekday } from '../../shared/types';

/** epoch ms, half-open [start, end) */
export interface Interval {
  start: number;
  end: number;
}

export function isValidZone(tz: string): boolean {
  throw new Error('not implemented');
}

export function zonedToUtcMs(date: LocalDate, time: HHMM, tz: IanaZone): number {
  throw new Error('not implemented');
}

export function localDateOf(ms: number, tz: IanaZone): LocalDate {
  throw new Error('not implemented');
}

export function addDays(date: LocalDate, n: number): LocalDate {
  throw new Error('not implemented');
}

export function weekdayOf(date: LocalDate): Weekday {
  throw new Error('not implemented');
}

export function mergeIntervals(list: Interval[]): Interval[] {
  throw new Error('not implemented');
}

export function subtractIntervals(base: Interval[], remove: Interval[]): Interval[] {
  throw new Error('not implemented');
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  throw new Error('not implemented');
}

export function formatInZone(ms: number, tz: IanaZone, style: 'full' | 'date' | 'time' | 'short' | 'spoken', locale?: string): string {
  throw new Error('not implemented');
}
