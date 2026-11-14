import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from '../../ui';

export interface ChoiceOption<T extends string | number> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export interface ChoiceChipsProps<T extends string | number> {
  /** names the group for screen readers */
  label: string;
  options: ChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * A small single-choice group shown as chips (meeting length, where to meet).
 * One tab stop. Arrow keys move and select, like radio buttons.
 */
export function ChoiceChips<T extends string | number>({ label, options, value, onChange, disabled = false, className }: ChoiceChipsProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const index = options.findIndex((o) => o.value === value);

  const move = (to: number) => {
    const n = options.length;
    const i = ((to % n) + n) % n;
    onChange(options[i].value);
    ref.current?.querySelectorAll<HTMLElement>('[role="radio"]')[i]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      move(i + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(i - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      move(options.length - 1);
    }
  };

  return (
    <div ref={ref} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={cx('bw-chips', className)}>
      {options.map((o, i) => {
        const checked = i === index;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (index === -1 && i === 0) ? 0 : -1}
            disabled={disabled}
            className={cx('bw-chip', checked && 'is-checked')}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.icon ? (
              <span className="bw-chip__icon" aria-hidden="true">
                {o.icon}
              </span>
            ) : null}
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
