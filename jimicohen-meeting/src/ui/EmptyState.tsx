import type { ReactNode } from 'react';
import { cx } from './util';

export interface EmptyStateProps {
  /** a lucide icon element */
  icon?: ReactNode;
  title: ReactNode;
  /** what this place is for, or what to do next */
  description?: ReactNode;
  /** usually one Button */
  action?: ReactNode;
  /** danger tints the icon for "could not load" states */
  tone?: 'neutral' | 'danger';
  /** start = left aligned, for empty lists inside wide panels */
  align?: 'center' | 'start';
  /** tighter spacing for small containers */
  compact?: boolean;
  /** heading level for the title */
  as?: 'h2' | 'h3' | 'h4' | 'p';
  className?: string;
}

/** What people see when there is nothing to show yet, or when loading failed. */
export function EmptyState({ icon, title, description, action, tone = 'neutral', align = 'center', compact = false, as: Title = 'h3', className }: EmptyStateProps) {
  return (
    <div className={cx('ui-empty', `ui-empty--${align}`, compact && 'ui-empty--compact', tone === 'danger' && 'ui-empty--danger', className)}>
      {icon ? (
        <span className="ui-empty__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <Title className="ui-empty__title">{title}</Title>
      {description ? <p className="ui-empty__desc">{description}</p> : null}
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  );
}
