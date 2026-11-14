import { useId } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from './util';

export interface RadioOption<T extends string = string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  /** icon shown in card style */
  icon?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<T extends string = string> {
  value: T | null;
  onChange: (value: T) => void;
  options: RadioOption<T>[];
  /** visible group label (rendered as the fieldset legend) */
  label?: ReactNode;
  /** use when there is no visible label */
  'aria-label'?: string;
  /** plain = classic radio list. cards = bordered, selectable tiles for richer choices. */
  variant?: 'plain' | 'cards';
  orientation?: 'vertical' | 'horizontal';
  /** number of columns for the cards variant on wide screens */
  columns?: 1 | 2 | 3;
  name?: string;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  className?: string;
}

/** One choice out of a few. Native radios, so arrow keys and forms just work. */
export function RadioGroup<T extends string = string>({
  value,
  onChange,
  options,
  label,
  variant = 'plain',
  orientation = 'vertical',
  columns = 1,
  name,
  disabled = false,
  invalid = false,
  required,
  className,
  'aria-label': ariaLabel,
}: RadioGroupProps<T>) {
  const auto = useId();
  const groupName = name ?? `rg${auto}`;
  return (
    <fieldset
      className={cx('ui-radio-group', `ui-radio-group--${variant}`, `ui-radio-group--${orientation}`, className)}
      aria-label={label ? undefined : ariaLabel}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      style={variant === 'cards' ? ({ '--_cols': columns } as CSSProperties) : undefined}
    >
      {label ? <legend className="ui-radio-group__legend">{label}</legend> : null}
      <div className="ui-radio-group__items">
        {options.map((o, i) => {
          const id = `${groupName}-${i}`;
          const checked = value === o.value;
          return (
            <label key={o.value} htmlFor={id} className={cx('ui-radio', checked && 'is-checked', (disabled || o.disabled) && 'is-disabled', !!o.icon && 'has-icon')}>
              <span className="ui-radio__control">
                <input
                  id={id}
                  type="radio"
                  className="ui-radio__input"
                  name={groupName}
                  value={o.value}
                  checked={checked}
                  disabled={disabled || o.disabled}
                  required={required}
                  aria-describedby={o.description ? `${id}-d` : undefined}
                  onChange={() => onChange(o.value)}
                />
                <span className="ui-radio__dot" aria-hidden="true" />
              </span>
              {o.icon ? (
                <span className="ui-radio__icon" aria-hidden="true">
                  {o.icon}
                </span>
              ) : null}
              <span className="ui-radio__text">
                <span className="ui-radio__label">{o.label}</span>
                {o.description ? (
                  <span className="ui-radio__desc" id={`${id}-d`}>
                    {o.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
