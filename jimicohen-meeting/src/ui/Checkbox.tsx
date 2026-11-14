import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Check, Minus } from 'lucide-react';
import { cx } from './util';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  /** dash instead of a tick: some, not all, of a group is selected */
  indeterminate?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  name?: string;
  value?: string;
  required?: boolean;
  'aria-label'?: string;
  id?: string;
  className?: string;
}

/** A native checkbox with a custom box. The whole row is the hit target. */
export function Checkbox({ checked, onChange, label, description, indeterminate = false, disabled = false, invalid = false, name, value, required, id, className, 'aria-label': ariaLabel }: CheckboxProps) {
  const auto = useId();
  const inputId = id ?? `cb${auto}`;
  const descId = `${inputId}-desc`;
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);

  return (
    <label className={cx('ui-check', disabled && 'is-disabled', invalid && 'is-invalid', !label && 'ui-check--bare', className)} htmlFor={inputId}>
      <span className="ui-check__control">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className="ui-check__input"
          checked={checked}
          disabled={disabled}
          name={name}
          value={value}
          required={required}
          aria-label={label ? undefined : ariaLabel}
          aria-describedby={description ? descId : undefined}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="ui-check__box" aria-hidden="true">
          {indeterminate && !checked ? <Minus size={13} strokeWidth={3} /> : <Check size={13} strokeWidth={3} />}
        </span>
      </span>
      {label ? (
        <span className="ui-check__text">
          <span className="ui-check__label">{label}</span>
          {description ? (
            <span className="ui-check__desc" id={descId}>
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
}
