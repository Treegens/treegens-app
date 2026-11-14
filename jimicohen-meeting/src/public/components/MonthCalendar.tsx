import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Weekday } from '../../../shared/types';
import { addDays, addMonths, formatDayKey, formatMonthYear, makeDayKey, monthGrid, parseDayKey, weekdayNames } from '../../lib/tz';
import type { MonthCell } from '../../lib/tz';
import { cx } from '../../ui';
import { plural } from '../lib/text';

export interface MonthCalendarProps {
  year: number;
  /** 1..12 */
  month: number;
  weekStart: Weekday;
  /** today's date in the visitor's zone */
  today: string;
  /** first and last day that can ever be booked: days outside are disabled */
  minDay: string;
  maxDay: string;
  /** day key → number of open times */
  availability: Map<string, number>;
  /** true while the month's times are loading: days are shown neutral, none can be picked */
  loading: boolean;
  selectedDay: string | null;
  onSelectDay: (day: string) => void;
  /** show another month */
  onMonthChange: (year: number, month: number) => void;
  locale?: string;
  /** the visitor's current booking when rescheduling: marked in the grid */
  markedDay?: string | null;
}

const WEEK_ROWS = 6;

/** Always six rows, so the calendar never changes height between months. */
function sixWeeks(year: number, month: number, weekStart: Weekday): MonthCell[][] {
  const weeks = monthGrid(year, month, weekStart);
  while (weeks.length < WEEK_ROWS) {
    const lastKey = weeks[weeks.length - 1][6].key;
    weeks.push(
      Array.from({ length: 7 }, (_, i) => {
        const key = addDays(lastKey, i + 1);
        return { key, day: parseDayKey(key).day, inMonth: false, weekday: ((weekStart + i) % 7) as Weekday };
      }),
    );
  }
  return weeks;
}

const monthOf = (key: string) => key.slice(0, 7);

/**
 * Month grid. A real grid for assistive tech: one tab stop, arrow keys move by day and week,
 * Home / End jump to the ends of the week, Page Up / Page Down change month.
 */
export function MonthCalendar({ year, month, weekStart, today, minDay, maxDay, availability, loading, selectedDay, onSelectDay, onMonthChange, locale, markedDay }: MonthCalendarProps) {
  const headingId = useId();
  const gridRef = useRef<HTMLTableElement>(null);
  const moveFocus = useRef(false);
  const viewKey = makeDayKey(year, month, 1).slice(0, 7);

  const weeks = useMemo(() => sixWeeks(year, month, weekStart), [year, month, weekStart]);
  const names = useMemo(() => weekdayNames(weekStart, locale, 'short'), [weekStart, locale]);
  const longNames = useMemo(() => weekdayNames(weekStart, locale, 'long'), [weekStart, locale]);

  const canPrev = viewKey > monthOf(minDay);
  const canNext = viewKey < monthOf(maxDay);

  const inRange = (key: string) => key >= minDay && key <= maxDay;

  /** The day that holds the grid's single tab stop. */
  const defaultFocus = (): string => {
    if (selectedDay && monthOf(selectedDay) === viewKey) return selectedDay;
    const firstOpen = Array.from(availability.keys())
      .filter((k) => monthOf(k) === viewKey)
      .sort()[0];
    if (firstOpen) return firstOpen;
    if (monthOf(today) === viewKey) return today;
    const first = makeDayKey(year, month, 1);
    return first < minDay ? minDay : first > maxDay ? maxDay : first;
  };

  const [focusDay, setFocusDay] = useState<string>(defaultFocus);
  const tabStop = monthOf(focusDay) === viewKey && inRange(focusDay) ? focusDay : defaultFocus();

  // When the month, the selection or the loaded days change, re-anchor the tab stop
  // unless the keyboard is in the middle of moving through the grid.
  useEffect(() => {
    if (moveFocus.current) return;
    setFocusDay(defaultFocus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, selectedDay, loading]);

  useEffect(() => {
    if (!moveFocus.current) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`);
    if (el) {
      el.focus();
      moveFocus.current = false;
    }
  }, [focusDay, viewKey, weeks]);

  const goTo = (target: string) => {
    const clamped = target < minDay ? minDay : target > maxDay ? maxDay : target;
    moveFocus.current = true;
    setFocusDay(clamped);
    if (monthOf(clamped) !== viewKey) {
      const p = parseDayKey(clamped);
      onMonthChange(p.year, p.month);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    const from = tabStop;
    let target: string | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        target = addDays(from, -1);
        break;
      case 'ArrowRight':
        target = addDays(from, 1);
        break;
      case 'ArrowUp':
        target = addDays(from, -7);
        break;
      case 'ArrowDown':
        target = addDays(from, 7);
        break;
      case 'Home': {
        const p = parseDayKey(from);
        const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
        target = addDays(from, -((wd - weekStart + 7) % 7));
        break;
      }
      case 'End': {
        const p = parseDayKey(from);
        const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
        target = addDays(from, 6 - ((wd - weekStart + 7) % 7));
        break;
      }
      case 'PageUp':
      case 'PageDown': {
        const p = parseDayKey(from);
        const next = addMonths(p.year, p.month, e.key === 'PageUp' ? -1 : 1);
        const days = new Date(Date.UTC(next.year, next.month, 0)).getUTCDate();
        target = makeDayKey(next.year, next.month, Math.min(p.day, days));
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    if (target) goTo(target);
  };

  const step = (delta: -1 | 1) => {
    const next = addMonths(year, month, delta);
    onMonthChange(next.year, next.month);
  };

  const monthLabel = formatMonthYear(year, month, locale);

  return (
    <div className={cx('bw-cal', loading && 'is-loading')}>
      <div className="bw-cal__head">
        <h3 className="bw-cal__month" id={headingId} aria-live="polite">
          {monthLabel}
        </h3>
        <div className="bw-cal__nav">
          <button type="button" className="bw-cal__navbtn" onClick={() => step(-1)} disabled={!canPrev} aria-label="Previous month">
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
          <button type="button" className="bw-cal__navbtn" onClick={() => step(1)} disabled={!canNext} aria-label="Next month">
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        </div>
      </div>

      <table ref={gridRef} className="bw-cal__grid" role="grid" aria-labelledby={headingId} aria-busy={loading || undefined} onKeyDown={onKeyDown}>
        <thead>
          <tr>
            {names.map((name, i) => (
              <th key={i} scope="col" abbr={longNames[i]} className="bw-cal__weekday">
                <span aria-hidden="true">{name}</span>
                <span className="u-vh">{longNames[i]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, r) => (
            <tr key={r}>
              {week.map((cell) => {
                if (!cell.inMonth) {
                  return (
                    <td key={cell.key} className="bw-cal__cell is-outside" aria-hidden="true">
                      <span className="bw-day bw-day--outside">
                        <span className="bw-day__face">{cell.day}</span>
                      </span>
                    </td>
                  );
                }
                const count = availability.get(cell.key) ?? 0;
                const reachable = inRange(cell.key);
                const open = reachable && !loading && count > 0;
                const selected = selectedDay === cell.key;
                const isToday = cell.key === today;
                const marked = markedDay === cell.key;
                const label = [
                  formatDayKey(cell.key, locale, 'long'),
                  isToday ? 'today' : '',
                  marked ? 'your current booking' : '',
                  loading && reachable ? '' : open ? `${plural(count, 'time', 'times')} available` : 'no times available',
                ]
                  .filter(Boolean)
                  .join(', ');
                return (
                  <td key={cell.key} role="gridcell" className="bw-cal__cell" aria-selected={selected}>
                    <button
                      type="button"
                      data-day={cell.key}
                      className={cx('bw-day', open && 'is-open', selected && 'is-selected', isToday && 'is-today', marked && 'is-marked', !reachable && 'is-past')}
                      tabIndex={cell.key === tabStop ? 0 : -1}
                      disabled={!reachable}
                      aria-disabled={reachable && !open ? true : undefined}
                      aria-pressed={selected}
                      aria-current={isToday ? 'date' : undefined}
                      aria-label={label}
                      onClick={() => {
                        setFocusDay(cell.key);
                        if (open) onSelectDay(cell.key);
                      }}
                      onFocus={() => {
                        if (cell.key !== focusDay) setFocusDay(cell.key);
                      }}
                    >
                      <span className="bw-day__face">{cell.day}</span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
