import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';
import type { Side } from './overlay';
import { cx } from './util';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** required: the accessible name, also shown as a tooltip */
  label: string;
  /** a lucide icon element, e.g. <Trash2 /> */
  icon: ReactNode;
  variant?: 'ghost' | 'secondary' | 'primary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** set false to skip the hover tooltip (the label is still announced) */
  tooltip?: boolean;
  tooltipSide?: Side;
  loading?: boolean;
  /** marks a toggle button as on */
  pressed?: boolean;
}

/** Square, icon-only button. Always at least 44px on touch screens. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'md', tooltip = true, tooltipSide = 'top', loading = false, pressed, className, type, disabled, onClick, ...rest },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      disabled={disabled}
      className={cx('ui-iconbtn', `ui-iconbtn--${variant}`, size !== 'md' && `ui-iconbtn--${size}`, pressed && 'is-pressed', className)}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {loading ? <Spinner size={16} label="" /> : icon}
    </button>
  );
  if (!tooltip || disabled) return button;
  return (
    <Tooltip content={label} side={tooltipSide} labelled>
      {button}
    </Tooltip>
  );
});
