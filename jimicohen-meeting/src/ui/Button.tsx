import { forwardRef } from 'react';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Spinner } from './Spinner';
import { cx } from './util';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonLook {
  /** primary = the themed call to action. One per view. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** stretch to the container width */
  block?: boolean;
  /** icon before the label (a lucide icon element) */
  iconLeft?: ReactNode;
  /** icon after the label */
  iconRight?: ReactNode;
}

export function buttonClass({ variant = 'secondary', size = 'md', block }: ButtonLook, extra?: string): string {
  return cx('ui-btn', `ui-btn--${variant}`, size !== 'md' && `ui-btn--${size}`, block && 'ui-btn--block', extra);
}

function Content({ iconLeft, iconRight, children }: { iconLeft?: ReactNode; iconRight?: ReactNode; children?: ReactNode }) {
  return (
    <>
      {iconLeft ? (
        <span className="ui-btn__icon" aria-hidden="true">
          {iconLeft}
        </span>
      ) : null}
      {children !== undefined && children !== null && children !== false ? <span className="ui-btn__label">{children}</span> : null}
      {iconRight ? (
        <span className="ui-btn__icon" aria-hidden="true">
          {iconRight}
        </span>
      ) : null}
    </>
  );
}

export interface ButtonProps extends ButtonLook, ButtonHTMLAttributes<HTMLButtonElement> {
  /** shows a spinner, keeps the width, and blocks clicks */
  loading?: boolean;
  /** announced to screen readers while loading */
  loadingLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, block, iconLeft, iconRight, loading = false, loadingLabel = 'Working', className, children, disabled, type, onClick, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={buttonClass({ variant, size, block }, cx(loading && 'is-loading', className))}
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      <Content iconLeft={iconLeft} iconRight={iconRight}>
        {children}
      </Content>
      {loading ? (
        <span className="ui-btn__spinner">
          <Spinner size={size === 'sm' ? 14 : 18} label={loadingLabel} />
        </span>
      ) : null}
    </button>
  );
});

export interface ButtonLinkProps extends ButtonLook, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** in-app route (react-router, relative to the /meeting base) */
  to?: string;
  /** plain URL: external sites, downloads, OAuth redirects */
  href?: string;
  /** opens in a new tab with rel="noopener noreferrer" */
  external?: boolean;
}

/** A link that looks like a button. Use `to` for app routes and `href` for everything else. */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { variant, size, block, iconLeft, iconRight, className, children, to, href, external, ...rest },
  ref,
) {
  const cls = buttonClass({ variant, size, block }, className);
  const content = (
    <Content iconLeft={iconLeft} iconRight={iconRight}>
      {children}
    </Content>
  );
  if (to !== undefined) {
    return (
      <Link ref={ref} to={to} className={cls} {...rest}>
        {content}
      </Link>
    );
  }
  return (
    <a ref={ref} href={href} className={cls} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : null)} {...rest}>
      {content}
    </a>
  );
});
