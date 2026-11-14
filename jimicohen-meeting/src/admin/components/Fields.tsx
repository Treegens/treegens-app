/** Small form controls the dashboard forms share: whole numbers, and "N minutes / hours / days". */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Input, Select } from '../../ui';
import type { ControlSize } from '../../ui';
import { UNIT_MINUTES, splitOffset } from '../format';
import type { OffsetUnit } from '../format';

export interface NumberFieldProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** unit shown inside the right edge: "days", "min" */
  suffix?: ReactNode;
  size?: ControlSize;
  invalid?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  id?: string;
  className?: string;
}

/** Whole-number input that lets you clear the box while typing and tidies up on blur. */
export function NumberField({ value, onChange, min = 0, max = 99999, suffix, size, invalid, disabled, id, className, 'aria-label': ariaLabel }: NumberFieldProps) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));

  return (
    <Input
      id={id}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      size={size}
      invalid={invalid}
      disabled={disabled}
      aria-label={ariaLabel}
      value={text}
      trailing={suffix ? <span className="adm-suffix">{suffix}</span> : undefined}
      wrapperClassName={className}
      onFocus={(e) => {
        setFocused(true);
        e.target.select();
      }}
      onBlur={() => {
        setFocused(false);
        const n = Number(text);
        const next = text.trim() === '' || !Number.isFinite(n) ? value : clamp(n);
        setText(String(next));
        if (next !== value) onChange(next);
      }}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9]/g, '');
        setText(raw);
        if (raw !== '') {
          const n = Number(raw);
          if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
        }
      }}
    />
  );
}

export interface OffsetInputProps {
  /** minutes */
  value: number;
  onChange: (minutes: number) => void;
  /** largest allowed value in minutes */
  maxMinutes?: number;
  units?: OffsetUnit[];
  invalid?: boolean;
  /** names the pair for screen readers: "Minimum notice" */
  label: string;
}

const UNIT_LABEL: Record<OffsetUnit, string> = { minutes: 'minutes', hours: 'hours', days: 'days' };

/** An amount of time as a number plus a unit. The value is always whole minutes. */
export function OffsetInput({ value, onChange, maxMinutes = 43200, units = ['minutes', 'hours', 'days'], invalid, label }: OffsetInputProps) {
  const [unit, setUnit] = useState<OffsetUnit>(() => {
    const u = splitOffset(value).unit;
    return units.includes(u) ? u : units[0];
  });

  // Follow outside changes (reset, discard) when the value no longer fits the chosen unit.
  useEffect(() => {
    if (value % UNIT_MINUTES[unit] !== 0) setUnit('minutes');
  }, [value, unit]);

  const amount = Math.round(value / UNIT_MINUTES[unit]);

  return (
    <div className="adm-offset" role="group" aria-label={label}>
      <NumberField aria-label={`${label}, amount`} value={amount} min={0} max={Math.floor(maxMinutes / UNIT_MINUTES[unit])} invalid={invalid} onChange={(n) => onChange(n * UNIT_MINUTES[unit])} className="adm-offset__num" />
      <Select
        aria-label={`${label}, unit`}
        value={unit}
        invalid={invalid}
        wrapperClassName="adm-offset__unit"
        options={units.map((u) => ({ value: u, label: UNIT_LABEL[u] }))}
        onChange={(e) => {
          const next = e.target.value as OffsetUnit;
          setUnit(next);
          onChange(Math.min(maxMinutes, amount * UNIT_MINUTES[next]));
        }}
      />
    </div>
  );
}
