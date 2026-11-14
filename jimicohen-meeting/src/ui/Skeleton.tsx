import type { CSSProperties } from 'react';
import { cx } from './util';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  /** corner radius. Defaults to the scope's small radius. */
  radius?: number | string;
  circle?: boolean;
  /** render this many text lines instead of one block (the last line is shorter) */
  lines?: number;
  className?: string;
  style?: CSSProperties;
}

const size = (v: number | string | undefined) => (typeof v === 'number' ? `${v}px` : v);

/**
 * Placeholder with the shape of the content that is loading. Purely visual:
 * wrap a group of skeletons in an element with aria-busy="true" and a status label.
 */
export function Skeleton({ width, height, radius, circle = false, lines, className, style }: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <span className={cx('ui-skeleton-lines', className)} aria-hidden="true" style={{ width: size(width), ...style }}>
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="ui-skeleton" style={{ height: size(height) ?? '0.8em', width: i === lines - 1 ? '62%' : '100%' }} />
        ))}
      </span>
    );
  }
  return (
    <span
      className={cx('ui-skeleton', circle && 'ui-skeleton--circle', className)}
      aria-hidden="true"
      style={{ width: size(width), height: size(height), borderRadius: circle ? '50%' : size(radius), ...style }}
    />
  );
}
