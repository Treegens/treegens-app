import { useId } from 'react';
import type { ReactNode } from 'react';
import { cx } from './util';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** visible label. Without it, pass aria-label. */
  label?: ReactNode;
  /** quiet second line under the label */
  description?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** which side the label sits on. "start" puts the text first and the switch at the far edge (settings rows). */
  labelSide?: 'start' | 'end';
  'aria-label'?: string;
  id?: string;
  className?: string;
}

/** On / off for a setting that applies immediately. */
export function Switch({ checked, onChange, label, description, disabled = false, size = 'md', labelSide = 'end', id, className, 'aria-label': ariaLabel }: SwitchProps) {
  const auto = useId();
  const switchId = id ?? `sw${auto}`;
  const labelId = `${switchId}-label`;
  const descId = `${switchId}-desc`;

  const control = (
    <button
      type="button"
      role="switch"
      id={switchId}
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={label ? labelId : undefined}
      aria-describedby={description ? descId : undefined}
      disabled={disabled}
      className={cx('ui-switch', size === 'sm' && 'ui-switch--sm', !label && className)}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch__thumb" aria-hidden="true" />
    </button>
  );

  if (!label) return control;

  return (
    <div className={cx('ui-toggle-row', labelSide === 'start' && 'ui-toggle-row--start', disabled && 'is-disabled', className)}>
      {control}
      <label className="ui-toggle-row__text" htmlFor={switchId}>
        <span className="ui-toggle-row__label" id={labelId}>
          {label}
        </span>
        {description ? (
          <span className="ui-toggle-row__desc" id={descId}>
            {description}
          </span>
        ) : null}
      </label>
    </div>
  );
}
