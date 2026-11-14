import type { ReactNode } from 'react';
import { cx } from './util';

export type BadgeTone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  tone?: BadgeTone;
  /** soft = tinted fill (default). outline = border only. solid = strongest. */
  variant?: 'soft' | 'outline' | 'solid';
  size?: 'sm' | 'md';
  /** small status dot before the text */
  dot?: boolean;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** A short status or category label. Not interactive. */
export function Badge({ tone = 'neutral', variant = 'soft', size = 'md', dot = false, icon, className, children }: BadgeProps) {
  return (
    <span className={cx('ui-badge', `ui-badge--${tone}`, `ui-badge--${variant}`, size === 'sm' && 'ui-badge--sm', className)}>
      {dot ? <span className="ui-badge__dot" aria-hidden="true" /> : null}
      {icon ? (
        <span className="ui-badge__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
