import { useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { cx, useIsoLayoutEffect } from './util';

export interface SegmentOption<T extends string = string> {
  value: T;
  label: ReactNode;
  /** icon before the label, or alone when `iconOnly` */
  icon?: ReactNode;
  /** accessible name when the label is not plain text or the segment is icon-only */
  ariaLabel?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  /** names the group for screen readers */
  'aria-label': string;
  size?: 'sm' | 'md';
  /** segments share the full width equally */
  block?: boolean;
  /** hide labels visually and show only icons */
  iconOnly?: boolean;
  disabled?: boolean;
  className?: string;
}

/** A compact switch between two to five views or modes. Arrow keys move the selection. */
export function SegmentedControl<T extends string = string>({
  value,
  onChange,
  options,
  size = 'md',
  block = false,
  iconOnly = false,
  disabled = false,
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const index = options.findIndex((o) => o.value === value);

  useIsoLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const el = root.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!el) {
        setThumb(null);
        return;
      }
      setThumb((prev) => (prev && prev.left === el.offsetLeft && prev.width === el.offsetWidth ? prev : { left: el.offsetLeft, width: el.offsetWidth }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [value, options.length, size, block, iconOnly]);

  const move = (from: number, dir: 1 | -1) => {
    const n = options.length;
    for (let step = 1; step <= n; step++) {
      const i = (from + dir * step + n * step) % n;
      if (!options[i].disabled) {
        onChange(options[i].value);
        rootRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[i]?.focus();
        return;
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      move(i, 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(i, -1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(-1, 1);
    } else if (e.key === 'End') {
      e.preventDefault();
      move(options.length, -1);
    }
  };

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cx('ui-seg', size === 'sm' && 'ui-seg--sm', block && 'ui-seg--block', iconOnly && 'ui-seg--icons', className)}
    >
      {thumb ? <span className="ui-seg__thumb" aria-hidden="true" style={{ '--_x': `${thumb.left}px`, '--_w': `${thumb.width}px` } as CSSProperties} /> : null}
      {options.map((o, i) => {
        const checked = i === index;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o.ariaLabel ?? (iconOnly && typeof o.label === 'string' ? o.label : undefined)}
            tabIndex={checked || (index === -1 && i === 0) ? 0 : -1}
            disabled={disabled || o.disabled}
            className="ui-seg__item"
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.icon ? (
              <span className="ui-seg__icon" aria-hidden="true">
                {o.icon}
              </span>
            ) : null}
            {iconOnly && o.icon ? null : <span className="ui-seg__label">{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
