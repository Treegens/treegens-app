/**
 * /:slug: the booking page of one meeting type.
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
import type { CreateBookingResponse, PublicEventResponse } from '../../shared/types';
import { resolveTheme } from '../../shared/theme';
import { getPublicEvent, isApiFailure } from '../lib/api';
import { BookingWidget } from './BookingWidget';
import type { BookingWidgetPrefill } from './BookingWidget';
import { PageMessage, PublicPage, WidgetSkeleton, useDocumentTitle } from './components/PublicPage';
import { isEmbedSearch, postToParent } from './lib/embed';

type State =
  | { status: 'loading' }
  | { status: 'ready'; data: PublicEventResponse }
  | { status: 'missing'; message: string }
  | { status: 'error'; offline: boolean; message: string };

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

export default function BookingPage() {
  const { slug = '' } = useParams();
  const { search } = useLocation();
  const embed = isEmbedSearch(search);
  const prefill = useMemo(() => readPrefill(search), [search]);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    getPublicEvent(slug, { signal: controller.signal }).then(
      (data) => setState({ status: 'ready', data }),
      (e: unknown) => {
        if (controller.signal.aborted) return;
        if (isApiFailure(e) && e.status === 404) setState({ status: 'missing', message: e.message });
        else setState({ status: 'error', offline: isApiFailure(e) && e.isNetwork, message: isApiFailure(e) ? e.message : '' });
      },
    );
    return () => controller.abort();
  }, [slug, attempt]);

  const data = state.status === 'ready' ? state.data : null;
  useDocumentTitle(data ? `${data.eventType.title} with ${data.site.profile.name}` : null);

  const theme = useMemo(() => (data ? resolveTheme(data.site.theme, data.eventType.themeOverride, data.eventType.color) : undefined), [data]);

  const onBooked = useCallback(
    (res: CreateBookingResponse) => {
      if (embed) postToParent({ type: 'meeting:booked', bookingId: res.booking.id, start: res.booking.start, end: res.booking.end, redirectUrl: res.booking.redirectUrl });
    },
    [embed],
  );

  if (!data || !theme) {
    return (
      <PublicPage embed={embed}>
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
  const showBack = !embed && listed && site.eventTypes.length > 1;

  return (
    <PublicPage theme={theme} assets={site.themeAssets} embed={embed}>
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
