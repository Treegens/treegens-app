import { cx } from '../../ui';

export interface SuccessMarkProps {
  /** check = booked or confirmed. cross = cancelled. */
  kind?: 'check' | 'cross';
  size?: number;
  className?: string;
}

/** The big animated tick on the confirmation screen: a ring that draws itself, then the mark. */
export function SuccessMark({ kind = 'check', size = 72, className }: SuccessMarkProps) {
  return (
    <span className={cx('bw-mark', `bw-mark--${kind}`, className)} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 72 72" width={size} height={size} fill="none">
        <circle className="bw-mark__disc" cx="36" cy="36" r="34" />
        <circle className="bw-mark__ring" cx="36" cy="36" r="34" pathLength={100} />
        {kind === 'check' ? (
          <path className="bw-mark__stroke" d="M22.5 37.5l9.5 9.5 18-20" pathLength={100} />
        ) : (
          <path className="bw-mark__stroke" d="M26 26l20 20M46 26L26 46" pathLength={100} />
        )}
      </svg>
    </span>
  );
}
