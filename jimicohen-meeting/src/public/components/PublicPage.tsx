import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { CloudOff, Compass, RefreshCw, WifiOff } from 'lucide-react';
import type { Theme } from '../../../shared/types';
import type { ThemeAssets } from '../../../shared/theme';
import { ThemeScope, cachedTheme } from '../../lib/theme';
import { Button, ButtonLink, Skeleton, cx } from '../../ui';
import '../../styles/public.css';
import { useEmbedAutoHeight, useEmbedEscape, withEmbed } from '../lib/embed';

export interface PublicPageProps {
  /** the theme to render with. Leave out while loading: the theme seen on the last visit is used. */
  theme?: Theme;
  assets?: ThemeAssets | null;
  /** `?embed=1`: no backdrop, no page chrome, height reported to the parent window */
  embed?: boolean;
  /** how wide the content may get */
  width?: 'wide' | 'medium' | 'narrow';
  className?: string;
  children: ReactNode;
}

/** The frame every public screen sits in: theme scope, page gutters, embed behaviour. */
export function PublicPage({ theme, assets, embed = false, width = 'wide', className, children }: PublicPageProps) {
  const ref = useRef<HTMLElement>(null);
  useEmbedAutoHeight(embed, ref);
  useEmbedEscape(embed);
  const boot = theme ? null : cachedTheme();

  // Embedded: browsers paint an opaque canvas behind an iframe whose root color scheme differs
  // from the host page's, which hides the host background we promised to let through. ThemeScope
  // sets the root scheme from the theme (dark for the default look), so in embed mode put the root
  // back to the neutral scheme almost every host page has. The widget keeps its own scheme: it is
  // set on the scope element, so form controls and scrollbars inside the card are unaffected.
  // This effect runs after ThemeScope's (child effects first) and again whenever the theme changes.
  useEffect(() => {
    if (!embed) return;
    document.documentElement.style.colorScheme = 'normal';
  }, [embed, theme]);
  return (
    <ThemeScope theme={theme ?? boot!.theme} assets={theme ? assets : boot!.assets} backdrop={!embed}>
      <main ref={ref} className={cx('pp', `pp--${width}`, embed && 'pp--embed', className)}>
        {children}
      </main>
    </ThemeScope>
  );
}

/** Sets the tab title while the screen is mounted. */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

export interface PageMessageProps {
  kind: 'missing' | 'error' | 'offline';
  title: string;
  description: string;
  onRetry?: () => void;
  /** where "See all meeting types" goes. Leave out to hide the link. */
  homeHref?: string;
  embed?: boolean;
}

/** A whole-page state: not found, failed to load, offline. */
export function PageMessage({ kind, title, description, onRetry, homeHref, embed = false }: PageMessageProps) {
  return (
    <div className="pp-card pp-message" role={kind === 'missing' ? undefined : 'alert'}>
      {/* Same look as the kit's EmptyState, with a page-level heading. */}
      <div className={cx('ui-empty ui-empty--center', kind !== 'missing' && 'ui-empty--danger')}>
        <span className="ui-empty__icon" aria-hidden="true">
          {kind === 'missing' ? <Compass /> : kind === 'offline' ? <WifiOff /> : <CloudOff />}
        </span>
        <h1 className="ui-empty__title">{title}</h1>
        <p className="ui-empty__desc">{description}</p>
        <div className="ui-empty__action">
          {onRetry ? (
            <Button variant="primary" iconLeft={<RefreshCw size={16} />} onClick={onRetry}>
              Try again
            </Button>
          ) : null}
          {homeHref ? (
            <ButtonLink to={withEmbed(homeHref, embed)} variant={onRetry ? 'secondary' : 'primary'}>
              See all meeting types
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Placeholder with the outline of the booking card, shown while the event loads. */
export function WidgetSkeleton() {
  return (
    <div className="bw bw--skeleton" aria-busy="true">
      <p className="u-vh" role="status">
        Loading the booking page
      </p>
      <div className="bw__card" aria-hidden="true">
        <div className="bw__body">
          <div className="bw__summary">
            <div className="bw-summary">
              <Skeleton circle width={52} height={52} />
              <Skeleton width="46%" height={14} />
              <Skeleton width="78%" height={34} />
              <Skeleton lines={3} height={14} />
            </div>
          </div>
          <div className="bw__main">
            <div className="bw-pick">
              <div className="bw-pick__cal">
                <Skeleton width={140} height={26} />
                <div className="bw-skelgrid">
                  {Array.from({ length: 42 }, (_, i) => (
                    <Skeleton key={i} className="bw-skelgrid__cell" />
                  ))}
                </div>
              </div>
              <div className="bw-pick__slots">
                <div className="bw-slots">
                  <div className="bw-slots__head">
                    <Skeleton width="62%" height={20} />
                  </div>
                  <ul role="list" className="bw-slots__list">
                    {Array.from({ length: 6 }, (_, i) => (
                      <li key={i}>
                        <Skeleton className="bw-slot-skel" />
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
