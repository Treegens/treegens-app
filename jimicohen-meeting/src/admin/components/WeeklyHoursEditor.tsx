/**
 * Weekly hours: one row per weekday with an on/off switch, any number of time ranges,
 * "add a range" and "copy these hours to other days". Used by ScheduleEditor and by the
 * event type editor (restricted hours). Styled with --c-* variables only, so it works in the
 * dashboard and on themed pages.
 */
import { useMemo, useState } from 'react';
import { Copy, Plus, X } from 'lucide-react';
import type { TimeRange, Weekday, WeeklyHours } from '../../../shared/types';
import { weekStartsOn, weekdayNames } from '../../lib/tz';
import { Button, Checkbox, IconButton, Switch, cx } from '../../ui';
import { Popover } from './Popover';
import { TimeSelect, fromMinutes, toMinutes } from './TimeSelect';
import './schedule-editor.css';

export const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

export function sortRanges(ranges: TimeRange[]): TimeRange[] {
  return ranges.slice().sort((a, b) => toMinutes(a.start) - toMinutes(b.start) || toMinutes(a.end) - toMinutes(b.end));
}

/** What is wrong with a day's ranges, in words, or null when they are fine. */
export function rangesProblem(ranges: TimeRange[]): string | null {
  const sorted = sortRanges(ranges);
  for (let i = 0; i < sorted.length; i++) {
    if (toMinutes(sorted[i].end) <= toMinutes(sorted[i].start)) return 'Each range has to end after it starts.';
    if (i > 0 && toMinutes(sorted[i].start) < toMinutes(sorted[i - 1].end)) return 'These times overlap.';
  }
  if (ranges.length > 12) return 'A day can have at most 12 ranges.';
  return null;
}

/** The next sensible range to add after the existing ones, or null when the day is full. */
export function nextRange(ranges: TimeRange[]): TimeRange | null {
  if (!ranges.length) return { start: '09:00', end: '17:00' };
  const lastEnd = Math.max(...ranges.map((r) => toMinutes(r.end)));
  const start = Math.min(lastEnd + 60, 1380);
  if (lastEnd >= 1380 || start >= 1440) return null;
  return { start: fromMinutes(start), end: fromMinutes(Math.min(start + 60, 1440)) };
}

export interface RangeListProps {
  ranges: TimeRange[];
  onChange: (next: TimeRange[]) => void;
  /** used in accessible names: "Monday" */
  context: string;
  problem?: string | null;
}

export function isSorted(ranges: TimeRange[]): boolean {
  const sorted = sortRanges(ranges);
  return ranges.every((r, i) => r.start === sorted[i].start && r.end === sorted[i].end);
}

/**
 * The start/end pickers for one day (or one set of override dates). The ranges are put in order
 * once the person is done with them (the focus leaves the list), not on every change: a row that
 * jumped while it was being edited would move away from under the pointer.
 */
export function RangeList({ ranges, onChange, context, problem }: RangeListProps) {
  return (
    <div
      className="sch-ranges"
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        if (!isSorted(ranges)) onChange(sortRanges(ranges));
      }}
    >
      {ranges.map((range, i) => (
        <div className="sch-range" key={i}>
          <TimeSelect
            className="sch-range__time"
            aria-label={`${context}, range ${i + 1}, start`}
            value={range.start}
            invalid={!!problem}
            onChange={(start) => onChange(ranges.map((r, j) => (j === i ? { ...r, start } : r)))}
          />
          <span className="sch-range__dash" aria-hidden="true">
            to
          </span>
          <TimeSelect
            className="sch-range__time"
            end
            aria-label={`${context}, range ${i + 1}, end`}
            value={range.end}
            invalid={!!problem}
            onChange={(end) => onChange(ranges.map((r, j) => (j === i ? { ...r, end } : r)))}
          />
          <IconButton size="sm" label={`Remove this range from ${context}`} icon={<X />} onClick={() => onChange(ranges.filter((_, j) => j !== i))} />
        </div>
      ))}
      {problem ? (
        <p className="sch-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

export interface WeeklyHoursEditorProps {
  value: WeeklyHours;
  onChange: (next: WeeklyHours) => void;
  /** first day shown; defaults to the locale's habit */
  weekStart?: Weekday;
  className?: string;
}

export function WeeklyHoursEditor({ value, onChange, weekStart, className }: WeeklyHoursEditorProps) {
  const first = useMemo<Weekday>(() => weekStart ?? weekStartsOn(), [weekStart]);
  const names = useMemo(() => weekdayNames(0, undefined, 'long'), []);
  const order = useMemo(() => WEEKDAYS.map((_, i) => ((first + i) % 7) as Weekday), [first]);

  const setDay = (day: Weekday, ranges: TimeRange[]) => onChange({ ...value, [day]: ranges });

  return (
    <div className={cx('sch-week', className)} role="group" aria-label="Weekly hours">
      {order.map((day) => {
        const ranges = value[day] ?? [];
        const on = ranges.length > 0;
        const name = names[day];
        const addable = nextRange(ranges);
        return (
          <div className={cx('sch-day', !on && 'is-off')} key={day}>
            <div className="sch-day__toggle">
              <Switch size="sm" checked={on} onChange={(next) => setDay(day, next ? [{ start: '09:00', end: '17:00' }] : [])} label={name} />
            </div>
            <div className="sch-day__body">
              {on ? <RangeList ranges={ranges} context={name} problem={rangesProblem(ranges)} onChange={(next) => setDay(day, next)} /> : <p className="sch-day__off">Unavailable</p>}
            </div>
            <div className="sch-day__actions">
              <IconButton
                size="sm"
                label={`Add a time range on ${name}`}
                icon={<Plus />}
                disabled={!addable}
                onClick={() => addable && setDay(day, sortRanges([...ranges, addable]))}
              />
              <CopyDays day={day} names={names} order={order} onCopy={(targets) => onChange({ ...value, ...Object.fromEntries(targets.map((d) => [d, ranges.map((r) => ({ ...r }))])) })} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CopyDays({ day, names, order, onCopy }: { day: Weekday; names: string[]; order: Weekday[]; onCopy: (targets: Weekday[]) => void }) {
  const [picked, setPicked] = useState<Weekday[]>([]);
  const others = order.filter((d) => d !== day);
  const weekdays = others.filter((d) => d >= 1 && d <= 5);
  return (
    <Popover
      label={`Copy ${names[day]}'s hours to other days`}
      className="sch-copy"
      trigger={<IconButton size="sm" label={`Copy ${names[day]}'s hours to other days`} icon={<Copy />} onClick={() => setPicked([])} />}
    >
      {(close) => (
        <>
          <p className="sch-copy__title">Copy {names[day]}'s hours to</p>
          <div className="sch-copy__quick">
            <button type="button" className="sch-copy__link" onClick={() => setPicked(weekdays)}>
              Weekdays
            </button>
            <button type="button" className="sch-copy__link" onClick={() => setPicked(others)}>
              Every day
            </button>
          </div>
          <div className="sch-copy__list">
            {others.map((d) => (
              <Checkbox key={d} label={names[d]} checked={picked.includes(d)} onChange={(on) => setPicked((prev) => (on ? [...prev, d] : prev.filter((x) => x !== d)))} />
            ))}
          </div>
          <Button
            variant="primary"
            size="sm"
            block
            disabled={!picked.length}
            onClick={() => {
              onCopy(picked);
              close();
            }}
          >
            {picked.length ? `Copy to ${picked.length} ${picked.length === 1 ? 'day' : 'days'}` : 'Choose days'}
          </Button>
        </>
      )}
    </Popover>
  );
}
