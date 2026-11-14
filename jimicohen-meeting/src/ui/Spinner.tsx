import { cx } from './util';

export interface SpinnerProps {
  /** diameter in px */
  size?: number;
  /** accessible status text. Pass "" when a visible label sits next to the spinner. */
  label?: string;
  className?: string;
}

/** Indeterminate progress ring. Inherits the current text colour. */
export function Spinner({ size = 20, label = 'Loading', className }: SpinnerProps) {
  return (
    <span className={cx('ui-spinner', className)} role={label ? 'status' : undefined} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.5" />
        <path d="M21.25 12a9.25 9.25 0 0 0-9.25-9.25" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      {label ? <span className="u-vh">{label}</span> : null}
    </span>
  );
}

export interface LoadingBlockProps {
  /** shown under the spinner */
  label?: string;
  /** minimum height so the layout does not jump when content arrives */
  minHeight?: number | string;
}

/** Centered spinner with a caption, for a whole panel that is waiting on data. */
export function LoadingBlock({ label = 'Loading', minHeight = 180 }: LoadingBlockProps) {
  return (
    <div className="ui-loading-block" style={{ minHeight }} role="status">
      <Spinner size={22} label="" />
      <span>{label}</span>
    </div>
  );
}
