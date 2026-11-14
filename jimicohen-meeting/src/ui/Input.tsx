import { forwardRef, useRef } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { useFieldControl } from './Field';
import { cx, mergeRefs, useIsoLayoutEffect } from './util';

export type ControlSize = 'sm' | 'md' | 'lg';

// ───────────── Input ─────────────

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  size?: ControlSize;
  /** marks the control invalid without a <Field> */
  invalid?: boolean;
  /** icon or short text inside the left edge */
  leading?: ReactNode;
  /** icon, unit or button inside the right edge */
  trailing?: ReactNode;
  /** class for the outer box (className goes to the <input>) */
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', invalid, leading, trailing, className, wrapperClassName, id, required, disabled, type = 'text', 'aria-describedby': describedBy, ...rest },
  ref,
) {
  const field = useFieldControl({ id, 'aria-describedby': describedBy, invalid, required });
  return (
    <div className={cx('ui-input', size !== 'md' && `ui-input--${size}`, field.invalid && 'is-invalid', disabled && 'is-disabled', wrapperClassName)}>
      {leading ? <span className="ui-input__slot ui-input__slot--lead">{leading}</span> : null}
      <input
        ref={ref}
        id={field.id}
        type={type}
        className={cx('ui-input__el', className)}
        aria-describedby={field['aria-describedby']}
        aria-invalid={field['aria-invalid']}
        required={field.required}
        disabled={disabled}
        {...rest}
      />
      {trailing ? <span className="ui-input__slot ui-input__slot--trail">{trailing}</span> : null}
    </div>
  );
});

// ───────────── Textarea ─────────────

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** grow with the content instead of scrolling (up to maxRows) */
  autoGrow?: boolean;
  maxRows?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, autoGrow = false, maxRows = 12, className, id, required, rows = 3, value, 'aria-describedby': describedBy, ...rest },
  ref,
) {
  const field = useFieldControl({ id, 'aria-describedby': describedBy, invalid, required });
  const local = useRef<HTMLTextAreaElement>(null);

  useIsoLayoutEffect(() => {
    const el = local.current;
    if (!autoGrow || !el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
    const max = line * maxRows + 24;
    el.style.height = `${Math.min(el.scrollHeight + 2, max)}px`;
    el.style.overflowY = el.scrollHeight + 2 > max ? 'auto' : 'hidden';
  }, [autoGrow, maxRows, value]);

  return (
    <textarea
      ref={mergeRefs(ref, local)}
      id={field.id}
      rows={rows}
      value={value}
      className={cx('ui-textarea', field.invalid && 'is-invalid', className)}
      aria-describedby={field['aria-describedby']}
      aria-invalid={field['aria-invalid']}
      required={field.required}
      {...rest}
    />
  );
});

// ───────────── Select (native, styled) ─────────────

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: ControlSize;
  invalid?: boolean;
  /** options to render. Pass children instead for optgroups. */
  options?: SelectOption[];
  /** a disabled first option shown while nothing is chosen */
  placeholder?: string;
  leading?: ReactNode;
  wrapperClassName?: string;
}

/** The platform select: best on phones, fully keyboard accessible, styled to match the kit. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'md', invalid, options, placeholder, leading, className, wrapperClassName, id, required, disabled, children, 'aria-describedby': describedBy, ...rest },
  ref,
) {
  const field = useFieldControl({ id, 'aria-describedby': describedBy, invalid, required });
  const showingPlaceholder = placeholder !== undefined && (rest.value === '' || (rest.value === undefined && rest.defaultValue === ''));
  return (
    <div
      className={cx('ui-input ui-select', size !== 'md' && `ui-input--${size}`, field.invalid && 'is-invalid', disabled && 'is-disabled', showingPlaceholder && 'is-placeholder', wrapperClassName)}
    >
      {leading ? <span className="ui-input__slot ui-input__slot--lead">{leading}</span> : null}
      <select
        ref={ref}
        id={field.id}
        className={cx('ui-input__el ui-select__el', className)}
        aria-describedby={field['aria-describedby']}
        aria-invalid={field['aria-invalid']}
        required={field.required}
        disabled={disabled}
        {...rest}
      >
        {placeholder !== undefined ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <ChevronDown className="ui-select__chevron" size={16} aria-hidden="true" />
    </div>
  );
});
