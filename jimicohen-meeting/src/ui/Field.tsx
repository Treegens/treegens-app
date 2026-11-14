import { createContext, useContext, useId } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { cx } from './util';

interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * Wiring for a control inside <Field>: id, aria-describedby, aria-invalid, required.
 * Input, Textarea and Select call this themselves. Use it for custom controls.
 */
export function useFieldControl(own?: { id?: string; 'aria-describedby'?: string; invalid?: boolean; required?: boolean }) {
  const ctx = useContext(FieldContext);
  const describedBy = [own?.['aria-describedby'], ctx?.describedBy].filter(Boolean).join(' ') || undefined;
  const invalid = own?.invalid ?? ctx?.invalid ?? false;
  return {
    id: own?.id ?? ctx?.id,
    'aria-describedby': describedBy,
    'aria-invalid': invalid ? (true as const) : undefined,
    required: own?.required ?? (ctx?.required || undefined),
    invalid,
  };
}

export interface FieldProps {
  label: ReactNode;
  /** helper text under the control */
  hint?: ReactNode;
  /** validation message. Replaces the hint and marks the control invalid. */
  error?: ReactNode;
  required?: boolean;
  /** shows a quiet "Optional" next to the label */
  optional?: boolean;
  /** right side of the label row (a link, a counter) */
  action?: ReactNode;
  /** keep the label for screen readers only */
  hideLabel?: boolean;
  /** use when the control brings its own id */
  htmlFor?: string;
  className?: string;
  /** one control: Input, Textarea, Select, or a custom control using useFieldControl() */
  children: ReactNode;
}

/** Label + control + hint or error, wired together for assistive tech. */
export function Field({ label, hint, error, required = false, optional = false, action, hideLabel = false, htmlFor, className, children }: FieldProps) {
  const auto = useId();
  const id = htmlFor ?? `f${auto}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const describedBy = hasError ? errorId : hint ? hintId : undefined;

  return (
    <div className={cx('ui-field', hasError && 'is-invalid', className)}>
      <div className={cx('ui-field__top', hideLabel && !action && 'u-vh')}>
        <label className={cx('ui-field__label', hideLabel && 'u-vh')} htmlFor={id}>
          {label}
          {required ? (
            <span className="ui-field__req" aria-hidden="true">
              *
            </span>
          ) : null}
          {optional && !required ? <span className="ui-field__optional">Optional</span> : null}
        </label>
        {action ? <div className="ui-field__action">{action}</div> : null}
      </div>
      <FieldContext.Provider value={{ id, describedBy, invalid: hasError, required }}>{children}</FieldContext.Provider>
      {hasError ? (
        <p className="ui-field__error" id={errorId} role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p className="ui-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
