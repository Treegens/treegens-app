/**
 * Date overrides: pick one or more dates on a month calendar, then either give those dates
 * their own hours or mark them unavailable.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { DateOverride, LocalDate, TimeRange } from '../../../shared/types';
import { addDays, addMonths, formatDayKey, formatMonthYear, monthGrid, parseDayKey, todayKey, weekStartsOn, weekdayNames } from '../../lib/tz';
import { Button, IconButton, Modal, SegmentedControl, cx } from '../../ui';
import { RangeList, nextRange, rangesProblem, sortRanges } from './WeeklyHoursEditor';

export interface OverrideDialogProps {
  open: boolean;
  onClose: () => void;
  /** zone the dates are in (decides what "today" is) */
  timezone: string;
  /** dates that already have an override, marked on the calendar */
  existing: DateOverride[];
  /** when editing: the dates and hours to start from */
  initial?: { dates: LocalDate[]; ranges: TimeRange[] } | null;
  onApply: (dates: LocalDate[], ranges: TimeRange[]) => void;
}

export function OverrideDialog({ open, onClose, timezone, existing, initial, onApply }: OverrideDialogProps) {
  const today = useMemo(() => todayKey(timezone), [timezone, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const weekStart = useMemo(() => weekStartsOn(), []);
  const dayNames = useMemo(() => weekdayNames(weekStart, undefined, 'short'), [weekStart]);
  const [view, setView] = useState(() => ({ year: parseDayKey(today).year, month: parseDayKey(today).month }));
  const [dates, setDates] = useState<LocalDate[]>([]);
  const [mode, setMode] = useState<'off' | 'hours'>('off');
  const [ranges, setRanges] = useState<TimeRange[]>([{ start: '09:00', end: '17:00' }]);
  const [focusKey, setFocusKey] = useState<LocalDate>(today);
  const gridRef = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);

  useEffect(() => {
    if (!open) return;
    const startDates = initial?.dates ?? [];
    const anchor = startDates[0] ?? today;
    setDates(startDates);
    setMode(initial && initial.ranges.length ? 'hours' : 'off');
    setRanges(initial && initial.ranges.length ? initial.ranges.map((r) => ({ ...r })) : [{ start: '09:00', end: '17:00' }]);
    setView({ year: parseDayKey(anchor).year, month: parseDayKey(anchor).month });
    setFocusKey(anchor);
  }, [open, initial, today]);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
  }, [focusKey, view]);

  const weeks = useMemo(() => monthGrid(view.year, view.month, weekStart), [view, weekStart]);
  const marked = useMemo(() => new Set(existing.map((o) => o.date)), [existing]);
  const maxKey = useMemo(() => addDays(today, 730), [today]);
  const atFirstMonth = view.year === parseDayKey(today).year && view.month === parseDayKey(today).month;

  const toggle = (key: LocalDate) => setDates((prev) => (prev.includes(key) ? prev.filter((d) => d !== key) : [...prev, key].sort()));

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -7 : e.key === 'ArrowDown' ? 7 : 0;
    if (!step) return;
    e.preventDefault();
    let next = addDays(focusKey, step);
    if (next < today) next = today;
    if (next > maxKey) next = maxKey;
    const p = parseDayKey(next);
    moveFocus.current = true;
    if (p.year !== view.year || p.month !== view.month) setView({ year: p.year, month: p.month });
    setFocusKey(next);
  };

  const problem = mode === 'hours' ? (ranges.length ? rangesProblem(ranges) : 'Add at least one time range, or mark these dates as unavailable.') : null;
  const addable = nextRange(ranges);
  const count = dates.length;

  // Keep the roving tab stop inside the visible month.
  const visibleKeys = weeks.flat().filter((c) => c.inMonth && c.key >= today && c.key <= maxKey).map((c) => c.key);
  const tabStop = visibleKeys.includes(focusKey) ? focusKey : visibleKeys[0];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={initial ? 'Edit date override' : 'Add a date override'}
      description="Pick the dates, then say when you are available on them."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!count || !!problem}
            onClick={() => {
              onApply(dates, mode === 'off' ? [] : sortRanges(ranges));
              onClose();
            }}
          >
            {count ? `Apply to ${count} ${count === 1 ? 'date' : 'dates'}` : 'Pick a date'}
          </Button>
        </>
      }
    >
      <div className="sch-ovr">
        <div className="sch-ovr__grid">
        <div className="sch-cal">
          <div className="sch-cal__head">
            <IconButton size="sm" label="Previous month" icon={<ChevronLeft />} disabled={atFirstMonth} onClick={() => setView((v) => addMonths(v.year, v.month, -1))} />
            <p className="sch-cal__month" aria-live="polite">
              {formatMonthYear(view.year, view.month)}
            </p>
            <IconButton size="sm" label="Next month" icon={<ChevronRight />} onClick={() => setView((v) => addMonths(v.year, v.month, 1))} />
          </div>
          <div className="sch-cal__names" aria-hidden="true">
            {dayNames.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
          <div className="sch-cal__grid" ref={gridRef} role="group" aria-label="Dates" onKeyDown={onGridKey}>
            {weeks.flat().map((cell) => {
              if (!cell.inMonth) return <span key={cell.key} className="sch-cal__blank" />;
              const disabled = cell.key < today || cell.key > maxKey;
              const selected = dates.includes(cell.key);
              return (
                <button
                  key={cell.key}
                  type="button"
                  data-key={cell.key}
                  className={cx('sch-cal__day', selected && 'is-selected', cell.key === today && 'is-today', marked.has(cell.key) && 'is-marked')}
                  aria-pressed={selected}
                  aria-label={`${formatDayKey(cell.key)}${marked.has(cell.key) ? ', has an override' : ''}`}
                  disabled={disabled}
                  tabIndex={cell.key === tabStop ? 0 : -1}
                  onFocus={() => setFocusKey(cell.key)}
                  onClick={() => toggle(cell.key)}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
        </div>

        <div className="sch-ovr__hours">
          <SegmentedControl
            aria-label="Availability on these dates"
            block
            value={mode}
            onChange={setMode}
            options={[
              { value: 'off', label: 'Unavailable' },
              { value: 'hours', label: 'Custom hours' },
            ]}
          />
          {mode === 'hours' ? (
            <>
              <RangeList ranges={ranges} context="Override" problem={problem} onChange={setRanges} />
              <Button variant="ghost" size="sm" iconLeft={<Plus size={15} />} disabled={!addable} onClick={() => addable && setRanges(sortRanges([...ranges, addable]))}>
                Add a time range
              </Button>
            </>
          ) : (
            <p className="sch-ovr__note">Nobody can book you on the dates you pick, whatever your weekly hours say.</p>
          )}
          <p className="sch-ovr__picked">
            {count === 0 ? 'No dates picked yet.' : count <= 3 ? dates.map((d) => formatDayKey(d, undefined, 'medium')).join(', ') : `${formatDayKey(dates[0], undefined, 'medium')} and ${count - 1} more dates`}
          </p>
        </div>
        </div>
      </div>
    </Modal>
  );
}
