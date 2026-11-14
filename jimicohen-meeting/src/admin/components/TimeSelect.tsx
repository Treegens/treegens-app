import { useMemo } from 'react';
import type { HHMM, TimeRange } from '../../../shared/types';
import { formatTime, uses12h } from '../../lib/tz';
import { Select } from '../../ui';

const pad = (n: number) => String(n).padStart(2, '0');

export function toMinutes(t: HHMM): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function fromMinutes(total: number): HHMM {
  const clamped = Math.max(0, Math.min(1440, Math.round(total)));
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

/** "9:00 AM" or "09:00" for a wall time. "24:00" reads as midnight at the end of the day. */
export function formatWallTime(t: HHMM, hour12: boolean = uses12h()): string {
  if (t === '24:00') return hour12 ? 'midnight' : '24:00';
  const [h, m] = t.split(':').map(Number);
  return formatTime(Date.UTC(2023, 0, 1, h || 0, m || 0), 'UTC', { hour12 });
}

export function formatWallRange(r: TimeRange, hour12: boolean = uses12h()): string {
  return `${formatWallTime(r.start, hour12)} to ${formatWallTime(r.end, hour12)}`;
}

export interface TimeSelectProps {
  value: HHMM;
  onChange: (value: HHMM) => void;
  'aria-label': string;
  /** offer 24:00 (end of day) as the last option, for range ends */
  end?: boolean;
  /** minutes between options, default 15 */
  step?: number;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
}

/** A wall-clock time picker: the platform select with a time every 15 minutes. Fast with a mouse, keyboard or thumb. */
export function TimeSelect({ value, onChange, end = false, step = 15, invalid, disabled, className, 'aria-label': ariaLabel }: TimeSelectProps) {
  const hour12 = useMemo(() => uses12h(), []);
  const options = useMemo(() => {
    const values: HHMM[] = [];
    for (let m = end ? step : 0; m < 1440; m += step) values.push(fromMinutes(m));
    if (end) values.push('24:00');
    if (!values.includes(value)) {
      values.push(value);
      values.sort((a, b) => toMinutes(a) - toMinutes(b));
    }
    return values.map((v) => ({ value: v, label: v === '24:00' ? (hour12 ? 'Midnight' : '24:00') : formatWallTime(v, hour12) }));
  }, [end, step, value, hour12]);

  return (
    <Select
      size="sm"
      aria-label={ariaLabel}
      value={value}
      options={options}
      invalid={invalid}
      disabled={disabled}
      wrapperClassName={className}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
