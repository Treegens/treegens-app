/**
 * Validation of weekly hours and date overrides, shared by the host schedules and the
 * "only during certain hours" limit of an event type.
 *
 * Rules: times are "HH:MM" ("24:00" may end a range), every range ends after it starts, the
 * ranges of one day do not overlap once sorted, a day has at most 12 ranges, and a schedule
 * has at most 366 date overrides. Messages name the schedule and the day, because the
 * screens show the first message as it is.
 */
import type { DateOverride, Schedule, TimeRange, WeeklyHours, Weekday } from '../../../shared/types';
import { parseHHMM } from '../time';
import { cleanLine, FieldErrors, isHHMM, isLocalDate, isPlainObject } from '../validate';
import { charCount, isClientId } from './fields';

export const MAX_RANGES_PER_DAY = 12;
export const MAX_OVERRIDES = 366;
export const MAX_SCHEDULES = 20;
const MAX_SCHEDULE_NAME = 60;

const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The ranges of one day, sorted by start, or null when something is wrong with them (recorded under `path`). */
export function parseRanges(value: unknown, path: string, where: string, errors: FieldErrors): TimeRange[] | null {
  if (!Array.isArray(value)) {
    errors.add(path, `${where}: the hours are missing.`);
    return null;
  }
  if (value.length > MAX_RANGES_PER_DAY) {
    errors.add(path, `${where}: a day can have at most ${MAX_RANGES_PER_DAY} time ranges.`);
    return null;
  }
  const ranges: { start: string; end: string; from: number; to: number }[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || !isHHMM(item.start) || !isHHMM(item.end, true)) {
      errors.add(path, `${where}: write times like 09:00 and 17:30.`);
      return null;
    }
    const from = parseHHMM(item.start);
    const to = parseHHMM(item.end);
    if (from === null || to === null || to <= from) {
      errors.add(path, `${where}: each range has to end after it starts.`);
      return null;
    }
    ranges.push({ start: item.start, end: item.end, from, to });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].from < ranges[i - 1].to) {
      errors.add(path, `${where}: these times overlap.`);
      return null;
    }
  }
  return ranges.map((r) => ({ start: r.start, end: r.end }));
}

/** Weekly hours with every weekday present. A missing day means "not available that day". */
export function parseWeekly(value: unknown, path: string, label: string, errors: FieldErrors): WeeklyHours | null {
  if (!isPlainObject(value) && !Array.isArray(value)) {
    errors.add(path, `${label}: the weekly hours are missing.`);
    return null;
  }
  const source = value as Record<string, unknown>;
  const weekly = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] } as WeeklyHours;
  let ok = true;
  for (const day of WEEKDAYS) {
    const raw = source[String(day)];
    if (raw === undefined || raw === null) continue;
    const ranges = parseRanges(raw, `${path}.${day}`, `${label}, ${DAY_NAMES[day]}`, errors);
    if (ranges) weekly[day] = ranges;
    else ok = false;
  }
  return ok ? weekly : null;
}

function parseOverrides(value: unknown, path: string, label: string, errors: FieldErrors): DateOverride[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.add(path, `${label}: the date overrides are not readable.`);
    return null;
  }
  if (value.length > MAX_OVERRIDES) {
    errors.add(path, `${label}: a schedule can have at most ${MAX_OVERRIDES} date overrides. Remove some that are in the past.`);
    return null;
  }
  const seen = new Set<string>();
  const out: DateOverride[] = [];
  let ok = true;
  value.forEach((item, j) => {
    if (!isPlainObject(item) || !isLocalDate(item.date)) {
      errors.add(`${path}.${j}.date`, `${label}: one of the date overrides has no valid date.`);
      ok = false;
      return;
    }
    if (seen.has(item.date)) {
      errors.add(`${path}.${j}.date`, `${label}: ${item.date} is listed twice.`);
      ok = false;
      return;
    }
    seen.add(item.date);
    const ranges = parseRanges(item.ranges ?? [], `${path}.${j}.ranges`, `${label}, ${item.date}`, errors);
    if (!ranges) {
      ok = false;
      return;
    }
    out.push({ date: item.date, ranges });
  });
  return ok ? out.sort((a, b) => a.date.localeCompare(b.date)) : null;
}

/** A host's complete list of schedules, or null when any of them is invalid. */
export function parseSchedules(value: unknown, errors: FieldErrors): Schedule[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.add('schedules', 'Keep at least one schedule.');
    return null;
  }
  if (value.length > MAX_SCHEDULES) {
    errors.add('schedules', `You can have up to ${MAX_SCHEDULES} schedules.`);
    return null;
  }
  const ids = new Set<string>();
  const out: Schedule[] = [];
  let ok = true;
  value.forEach((item, i) => {
    const path = `schedules.${i}`;
    if (!isPlainObject(item)) {
      errors.add(path, 'One of the schedules is not readable.');
      ok = false;
      return;
    }
    const name = cleanLine(item.name, Number.MAX_SAFE_INTEGER);
    if (name === '') {
      errors.add(`${path}.name`, 'Give every schedule a name.');
      ok = false;
      return;
    }
    if (charCount(name) > MAX_SCHEDULE_NAME) {
      errors.add(`${path}.name`, `Keep schedule names to ${MAX_SCHEDULE_NAME} characters or fewer.`);
      ok = false;
      return;
    }
    if (!isClientId(item.id) || ids.has(item.id)) {
      errors.add(`${path}.id`, `${name}: this schedule could not be identified. Reload the page and try again.`);
      ok = false;
      return;
    }
    ids.add(item.id);
    const weekly = parseWeekly(item.weekly, `${path}.weekly`, name, errors);
    const overrides = parseOverrides(item.overrides, `${path}.overrides`, name, errors);
    if (!weekly || !overrides) {
      ok = false;
      return;
    }
    out.push({ id: item.id, name, weekly, overrides });
  });
  return ok ? out : null;
}
