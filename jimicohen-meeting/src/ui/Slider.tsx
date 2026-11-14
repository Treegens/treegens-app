import { useId } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from './util';

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** visible label on the left of the header row */
  label?: ReactNode;
  /** how the current value is written, e.g. (v) => `${v}px` */
  formatValue?: (value: number) => string;
  /** hide the value read-out on the right */
  hideValue?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  id?: string;
  className?: string;
}

/** A native range input with a filled track. */
export function Slider({ value, onChange, min, max, step = 1, label, formatValue, hideValue = false, disabled = false, id, className, 'aria-label': ariaLabel }: SliderProps) {
  const auto = useId();
  const inputId = id ?? `sl${auto}`;
  const span = max - min || 1;
  const pct = Math.max(0, Math.min(100, ((value - min) / span) * 100));
  const text = formatValue ? formatValue(value) : String(value);
  return (
    <div className={cx('ui-slider', disabled && 'is-disabled', className)}>
      {label || !hideValue ? (
        <div className="ui-slider__top">
          {label ? (
            <label className="ui-slider__label" htmlFor={inputId}>
              {label}
            </label>
          ) : (
            <span />
          )}
          {!hideValue ? (
            <output className="ui-slider__value" htmlFor={inputId}>
              {text}
            </output>
          ) : null}
        </div>
      ) : null}
      <input
        id={inputId}
        type="range"
        className="ui-slider__input"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label ? undefined : ariaLabel}
        aria-valuetext={text}
        style={{ '--_p': `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
