/**
 * /:slug: the booking page of one meeting type. Also the whole page of a short link (jimicohen.com/meet,
 * /pod): with `shortName` it shows whatever event the link opens now, in that event's brand, or the link's
 * closed page.
 *
 * Query parameters:
 *   embed=1                        chrome-free, for iframes (see lib/embed.ts)
 *   name, email, phone             prefill the details form
 *   duration=30                    preselect a meeting length
 *   month=2026-12, date=2026-12-03 open a month or preselect a day
 *   utm_*                          passed along with the booking
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { BUILTIN_BRANDS, isBrandId, pageTitle } from '../../shared/brands';
import type { ShortName } from '../../shared/shortLinks';
import type { CreateBookingResponse, PublicEventResponse, PublicSite } from '../../shared/types';
import { resolveTheme } from '../../shared/theme';
import { getPublicEvent, getShortLink, isApiFailure } from '../lib/api';
import { shortBootTheme } from '../lib/theme';
import { BookingWidget } from './BookingWidget';
import type { BookingWidgetPrefill } from './BookingWidget';
import { PageMessage, PublicPage, WidgetSkeleton, useBrandIcon, useDocumentTitle } from './components/PublicPage';
import { isEmbedSearch, postToParent } from './lib/embed';

type State =
  | { status: 'loading' }
  | { status: 'ready'; data: PublicEventResponse }
  | { status: 'closed'; site: PublicSite }
  | { status: 'missing'; message: string }
  | { status: 'error'; offline: boolean; message: string };

/** The page a closed short link shows: in its brand's words, or in the owner's look with the way to the other meetings. */
function closedWords(site: PublicSite): { title: string; description: string; home: boolean } {
  const id = site.brand?.id;
  if (isBrandId(id)) return { title: BUILTIN_BRANDS[id].closed.title, description: BUILTIN_BRANDS[id].closed.text, home: false };
  return { title: 'This link is not open right now', description: 'You can still pick from the meetings on offer.', home: true };
}

function readPrefill(search: string): BookingWidgetPrefill {
  const params = new URLSearchParams(search);
  const text = (key: string, max: number) => {
    const v = params.get(key)?.trim();
    return v ? v.slice(0, max) : undefined;
  };
  const duration = Number(params.get('duration'));
  const utm: Record<string, string> = {};
  params.forEach((value, key) => {
    if (/^utm_[a-z0-9_]{1,40}$/i.test(key) && value && Object.keys(utm).length < 8) utm[key.toLowerCase()] = value.slice(0, 200);
  });
  return {
    name: text('name', 120),
    email: text('email', 254),
    phone: text('phone', 32),
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    month: text('month', 7),
    date: text('date', 10),
    utm,
  };
}

export default function BookingPage({ shortName }: { shortName?: ShortName } = {}) {
  const { slug = '' } = useParams();
  const { search } = useLocation();
  // A short link's page is never framed (its headers forbid it), so ?embed=1 means nothing there.
  const embed = !shortName && isEmbedSearch(search);
  const prefill = useMemo(() => readPrefill(search), [search]);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // The look before the data arrives: on /pod the Eco Champions look, never the owner's forest.
  const boot = useMemo(() => (shortName ? shortBootTheme(shortName) : null), [shortName]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    const failed = (e: unknown) => {
      if (controller.signal.aborted) return;
      if (isApiFailure(e) && e.status === 404) setState({ status: 'missing', message: e.message });
      else setState({ status: 'error', offline: isApiFailure(e) && e.isNetwork, message: isApiFailure(e) ? e.message : '' });
    };
    if (shortName) {
      getShortLink(shortName, { signal: controller.signal }).then(
        (link) => setState(link.state === 'open' ? { status: 'ready', data: { site: link.site, eventType: link.eventType } } : { status: 'closed', site: link.site }),
        failed,
      );
    } else {
      getPublicEvent(slug, { signal: controller.signal }).then((data) => setState({ status: 'ready', data }), failed);
    }
    return () => controller.abort();
  }, [slug, shortName, attempt]);

  const data = state.status === 'ready' ? state.data : null;
  const shownSite = data?.site ?? (state.status === 'closed' ? state.site : null);
  useDocumentTitle(data ? pageTitle(data.eventType.title, data.site.profile.name) : state.status === 'closed' ? closedWords(state.site).title : null);
  useBrandIcon(shownSite?.brand);

  const theme = useMemo(() => (data ? resolveTheme(data.site.theme, data.eventType.themeOverride, data.eventType.color) : undefined), [data]);

  const onBooked = useCallback(
    (res: CreateBookingResponse) => {
      if (embed) postToParent({ type: 'meeting:booked', bookingId: res.booking.id, start: res.booking.start, end: res.booking.end, redirectUrl: res.booking.redirectUrl });
    },
    [embed],
  );

  if (state.status === 'closed') {
    const words = closedWords(state.site);
    return (
      <PublicPage theme={resolveTheme(state.site.theme)} assets={state.site.themeAssets} brandId={state.site.brand?.id ?? null}>
        <PageMessage kind="missing" title={words.title} description={words.description} homeHref={words.home ? '/' : undefined} />
      </PublicPage>
    );
  }

  if (!data || !theme) {
    return (
      <PublicPage embed={embed} boot={boot}>
        {state.status === 'loading' ? (
          <WidgetSkeleton />
        ) : state.status === 'missing' ? (
          <PageMessage
            kind="missing"
            title="This meeting type is not available"
            description="It may have been renamed or switched off. You can still pick from the meetings on offer."
            homeHref="/"
            embed={embed}
          />
        ) : state.status === 'error' ? (
          <PageMessage
            kind={state.offline ? 'offline' : 'error'}
            title={state.offline ? 'You seem to be offline' : 'This page did not load'}
            description={state.offline ? 'Check your connection and try again.' : 'Something went wrong on our side. Please try again in a moment.'}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : null}
      </PublicPage>
    );
  }

  const { site, eventType } = data;
  const listed = site.eventTypes.some((e) => e.slug === eventType.slug);
  // A short link opens one meeting and nothing else; a brand's page does not lead to the owner's list either.
  const showBack = !embed && !shortName && !site.brand && listed && site.eventTypes.length > 1;

  return (
    <PublicPage theme={theme} assets={site.themeAssets} embed={embed} brandId={site.brand?.id ?? null}>
      <BookingWidget
        key={eventType.id}
        site={site}
        eventType={eventType}
        mode="live"
        prefill={prefill}
        onBooked={onBooked}
        backHref={showBack ? '/' : undefined}
        source={embed ? 'embed' : 'page'}
        hideFooter={embed}
      />
    </PublicPage>
  );
}
