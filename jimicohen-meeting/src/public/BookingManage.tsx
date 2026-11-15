/**
 * /booking/:id[/reschedule|/cancel]?t=<manage token>: what an invitee sees when they open the
 * link from their confirmation email. View the meeting, say "I'll be there", move it or cancel it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarClock, CalendarPlus, CircleAlert, CircleCheck, History, ThumbsUp } from 'lucide-react';
import type { CreateBookingResponse, GetBookingResponse, PublicBooking } from '../../shared/types';
import { resolveTheme } from '../../shared/theme';
import { cancelBooking, confirmBooking, getBooking, isApiFailure } from '../lib/api';
import { useTheme } from '../lib/theme';
import { detectLocale, formatDateLong, formatDateMedium, formatRange, formatTime } from '../lib/tz';
import { Badge, Button, ButtonLink, Field, Skeleton, Textarea, useToast } from '../ui';
import { BookingWidget } from './BookingWidget';
import { BookingFacts } from './components/BookingFacts';
import { CalendarButtons } from './components/CalendarButtons';
import { PageMessage, PublicPage, useDocumentTitle } from './components/PublicPage';
import { PublicFooter } from './components/PublicFooter';
import { SuccessMark } from './components/SuccessMark';
import { TimezoneBar } from './components/TimezoneBar';
import { isEmbedSearch, postToParent, withEmbed } from './lib/embed';
import { useVisitorPrefs } from './lib/prefs';
import { deliveryLine, firstName, hostNames } from './lib/text';

export interface BookingManageProps {
  view?: 'details' | 'reschedule' | 'cancel';
}

type State = { status: 'loading' } | { status: 'ready'; data: GetBookingResponse } | { status: 'missing' } | { status: 'error'; offline: boolean };

type Phase = 'upcoming' | 'past' | 'cancelled';

function phaseOf(b: PublicBooking): Phase {
  if (b.status === 'cancelled') return 'cancelled';
  return Date.parse(b.end) <= Date.now() ? 'past' : 'upcoming';
}

interface ViewProps {
  data: GetBookingResponse;
  token: string;
  /** opened from a host's link (`as=host`): a host is acting, so their zone is not the invitee's */
  asHost: boolean;
  embed: boolean;
  view: 'details' | 'reschedule' | 'cancel';
  onUpdated: (booking: PublicBooking) => void;
}

function ManageViews({ data, token, asHost, embed, view, onUpdated }: ViewProps) {
  const { booking, site, eventType } = data;
  const { hour12: themeHour12 } = useTheme();
  const { zone, setZone, hour12, setHour12 } = useVisitorPrefs({ defaultHour12: themeHour12 });
  const locale = useMemo(() => detectLocale(), []);
  const navigate = useNavigate();
  const toast = useToast();
  const phase = phaseOf(booking);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const base = `/booking/${encodeURIComponent(booking.id)}`;
  // A host's link keeps saying so on every page it leads to.
  const tq = `?t=${encodeURIComponent(token)}${asHost ? '&as=host' : ''}`;
  const detailsHref = withEmbed(`${base}${tq}`, embed);
  const rescheduleHref = withEmbed(`${base}/reschedule${tq}`, embed);
  const cancelHref = withEmbed(`${base}/cancel${tq}`, embed);
  const rebookHref = withEmbed(`/${booking.eventSlug}`, embed);

  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState('');
  const routerLocation = useLocation();
  const flash = (routerLocation.state as { flash?: 'moved' | 'cancelled' } | null)?.flash ?? null;

  // Each view starts at its heading for keyboard and screen reader users.
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    setProblem('');
    headingRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [view]);

  // "Jimi knows you will be there" must not linger next to a cancellation or a move.
  const attendToast = useRef<string | null>(null);
  const clearAttendToast = () => {
    if (attendToast.current) toast.dismiss(attendToast.current);
    attendToast.current = null;
  };

  const confirmAttendance = async () => {
    setConfirming(true);
    setProblem('');
    try {
      const next = await confirmBooking(booking.id, token);
      onUpdated(next);
      attendToast.current = toast.success('Thank you', `${firstName(booking.hosts[0]?.name ?? site.profile.name)} knows you will be there.`);
    } catch (e) {
      setProblem(isApiFailure(e) && e.message ? e.message : 'We could not record that. Please try again.');
    } finally {
      setConfirming(false);
    }
  };

  // The "I'll be there" link in a reminder email ends in &confirm=1: opening it is the answer, no second
  // tap needed. The instruction is then taken out of the address, so a reload, a bookmark or a forwarded
  // link does not repeat it. A meeting that is over or cancelled simply shows where it stands.
  const wantsConfirm = useMemo(() => new URLSearchParams(routerLocation.search).get('confirm') === '1', [routerLocation.search]);
  const confirmedFromLink = useRef(false);
  useEffect(() => {
    if (!wantsConfirm || view !== 'details' || confirmedFromLink.current) return;
    confirmedFromLink.current = true;
    const params = new URLSearchParams(routerLocation.search);
    params.delete('confirm');
    navigate({ pathname: routerLocation.pathname, search: `?${params.toString()}` }, { replace: true, state: routerLocation.state });
    if (phase === 'upcoming' && !booking.attendanceConfirmed) void confirmAttendance();
    // Runs once per page load: the ref guards against a second run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsConfirm, view]);

  const doCancel = async () => {
    setCancelling(true);
    setProblem('');
    try {
      const next = await cancelBooking(booking.id, token, reason.trim() || undefined, asHost ? 'host' : undefined);
      clearAttendToast();
      onUpdated(next);
      if (embed) postToParent({ type: 'meeting:cancelled', bookingId: booking.id });
      navigate(detailsHref, { replace: true, state: { flash: 'cancelled' } });
    } catch (e) {
      setProblem(isApiFailure(e) && e.message ? e.message : 'We could not cancel the meeting. Please try again.');
    } finally {
      setCancelling(false);
    }
  };

  const onMoved = useCallback(
    (res: CreateBookingResponse) => {
      if (attendToast.current) toast.dismiss(attendToast.current);
      attendToast.current = null;
      onUpdated(res.booking);
      if (embed) postToParent({ type: 'meeting:rescheduled', bookingId: res.booking.id, start: res.booking.start, end: res.booking.end });
      navigate(detailsHref, { replace: true, state: { flash: 'moved' } });
    },
    [onUpdated, embed, navigate, detailsHref, toast],
  );

  // ───────────── reschedule ─────────────

  if (view === 'reschedule' && booking.canReschedule && eventType) {
    return (
      <BookingWidget
        site={site}
        eventType={eventType}
        mode="live"
        reschedule={{ bookingId: booking.id, token, currentStart: booking.start, durationMin: booking.durationMin, asHost }}
        onBooked={onMoved}
        onCancelReschedule={() => navigate(detailsHref)}
        source={embed ? 'embed' : 'page'}
        hideFooter={embed}
      />
    );
  }

  const title = phase === 'cancelled' ? 'This meeting was cancelled' : phase === 'past' ? 'This meeting has taken place' : booking.eventTitle;
  const who = hostNames(booking.hosts) || site.profile.name;
  // A host's link may be used by any host: only a name the server knows for sure is shown.
  const cancelledBy =
    booking.cancellation?.by === 'invitee'
      ? 'you'
      : booking.cancellation?.by === 'assistant'
        ? 'you, on the reminder call'
        : booking.cancellation?.byName
          ? firstName(booking.cancellation.byName)
          : 'the host';

  // ───────────── cancel ─────────────

  if (view === 'cancel' && booking.canCancel) {
    return (
      <div className="bm">
        <div className="pp-card bm__card">
          <Link to={detailsHref} className="bw-summary__back">
            <ArrowLeft size={16} aria-hidden="true" />
            <span>Back to your booking</span>
          </Link>
          <h1 className="bm__title" ref={headingRef} tabIndex={-1}>
            Cancel this meeting?
          </h1>
          <p className="bm__lead">
            {booking.eventTitle} with {who}, {formatDateMedium(booking.start, zone, locale)} at {formatTime(booking.start, zone, { hour12, locale })}.
          </p>
          <form
            className="bm__form"
            onSubmit={(e) => {
              e.preventDefault();
              void doCancel();
            }}
          >
            <Field label="Anything you would like to say?" optional hint={`${firstName(booking.hosts[0]?.name ?? site.profile.name)} will see this with the cancellation.`}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} autoGrow placeholder="A short reason helps, but it is up to you" />
            </Field>
            {problem ? (
              <div className="bw-notice bw-notice--error" role="alert">
                <CircleAlert size={18} aria-hidden="true" />
                <div className="bw-notice__body">
                  <p className="bw-notice__title">{problem}</p>
                </div>
              </div>
            ) : null}
            <div className="bm__actions bm__actions--end">
              <ButtonLink to={detailsHref} variant="secondary">
                Keep it
              </ButtonLink>
              <Button type="submit" variant="danger" loading={cancelling} loadingLabel="Cancelling">
                Cancel meeting
              </Button>
            </div>
          </form>
          {booking.canReschedule && eventType ? (
            <p className="bm__hint">
              Would another time work instead? <Link to={rescheduleHref}>Reschedule</Link>
            </p>
          ) : null}
        </div>
        {embed ? null : <PublicFooter site={site} />}
      </div>
    );
  }

  // ───────────── details ─────────────

  const blocked = view === 'reschedule' ? 'This meeting can no longer be rescheduled from here.' : view === 'cancel' ? 'This meeting can no longer be cancelled from here.' : '';

  return (
    <div className="bm">
      <div className="pp-card bm__card">
        {flash === 'moved' && phase === 'upcoming' ? (
          <div className="bw-notice bw-notice--success" role="status">
            <CircleCheck size={18} aria-hidden="true" />
            <div className="bw-notice__body">
              <p className="bw-notice__title">Your meeting has moved</p>
              <p className="bw-notice__text">{deliveryLine(booking, true)}</p>
            </div>
          </div>
        ) : null}
        {blocked && phase !== 'cancelled' ? (
          <div className="bw-notice bw-notice--warning" role="status">
            <CircleAlert size={18} aria-hidden="true" />
            <div className="bw-notice__body">
              <p className="bw-notice__title">{blocked}</p>
              <p className="bw-notice__text">{phase === 'past' ? 'It has already taken place.' : `Please contact ${firstName(booking.hosts[0]?.name ?? site.profile.name)} directly.`}</p>
            </div>
          </div>
        ) : null}

        <header className="bm__head">
          {phase === 'cancelled' && flash === 'cancelled' ? <SuccessMark kind="cross" size={56} className="bm__mark" /> : null}
          <div className="bm__status">
            {phase === 'upcoming' ? (
              <Badge tone="success" dot>
                Confirmed
              </Badge>
            ) : phase === 'past' ? (
              <Badge tone="neutral" icon={<History size={13} />}>
                Past meeting
              </Badge>
            ) : (
              <Badge tone="danger" dot>
                Cancelled
              </Badge>
            )}
            {phase === 'upcoming' && booking.attendanceConfirmed ? (
              <Badge tone="primary" icon={<ThumbsUp size={12} />}>
                You said you will be there
              </Badge>
            ) : null}
          </div>
          <h1 className="bm__title" ref={headingRef} tabIndex={-1}>
            {title}
          </h1>
          <p className="bm__lead">
            {phase === 'upcoming' ? (
              <>
                {firstName(booking.invitee.name)}, here is your meeting with {who}.
              </>
            ) : phase === 'past' ? (
              <>
                {booking.eventTitle} with {who}.
              </>
            ) : (
              <>
                {booking.eventTitle} with {who}
                {booking.cancellation ? `, cancelled by ${cancelledBy} on ${formatDateMedium(booking.cancellation.at, zone, locale)}.` : '.'}
              </>
            )}
          </p>
        </header>

        {phase === 'cancelled' && booking.cancellation?.reason ? (
          <blockquote className="bm__reason">
            <p className="bm__reasonlabel">Reason given</p>
            <p>{booking.cancellation.reason}</p>
          </blockquote>
        ) : null}

        <div className="bm__facts">
          <BookingFacts booking={booking} zone={zone} hour12={hour12} locale={locale} struck={phase === 'cancelled'} />
          {booking.rescheduledFromStart && phase !== 'cancelled' ? (
            <p className="bm__moved">
              <CalendarClock size={15} aria-hidden="true" />
              <span>
                Moved from {formatDateLong(booking.rescheduledFromStart, zone, locale)},{' '}
                {formatRange(booking.rescheduledFromStart, Date.parse(booking.rescheduledFromStart) + booking.durationMin * 60000, zone, { hour12, locale })}
              </span>
            </p>
          ) : null}
        </div>

        <TimezoneBar zone={zone} onZoneChange={setZone} hour12={hour12} onHour12Change={setHour12} />

        {problem ? (
          <div className="bw-notice bw-notice--error" role="alert">
            <CircleAlert size={18} aria-hidden="true" />
            <div className="bw-notice__body">
              <p className="bw-notice__title">{problem}</p>
            </div>
          </div>
        ) : null}

        {phase === 'upcoming' ? (
          <>
            {booking.attendanceConfirmed ? null : (
              <div className="bm__attend">
                <div className="bm__attendtext">
                  <p className="bm__attendtitle">Still coming?</p>
                  <p className="bm__attendhint">Let {firstName(booking.hosts[0]?.name ?? site.profile.name)} know with one tap.</p>
                </div>
                <Button variant="primary" iconLeft={<ThumbsUp size={16} />} loading={confirming} loadingLabel="Saving" onClick={confirmAttendance}>
                  I'll be there
                </Button>
              </div>
            )}
            <div className="bm__section">
              <p className="bm__label">Add to your calendar</p>
              <CalendarButtons links={booking.calendarLinks} />
            </div>
            {booking.canReschedule || booking.canCancel ? (
              <div className="bm__section">
                <p className="bm__label">Need to change it?</p>
                <div className="bm__actions">
                  {booking.canReschedule && eventType ? (
                    <ButtonLink to={rescheduleHref} variant="secondary" iconLeft={<CalendarClock size={16} />}>
                      Reschedule
                    </ButtonLink>
                  ) : null}
                  {booking.canCancel ? (
                    <ButtonLink to={cancelHref} variant="danger-soft">
                      Cancel meeting
                    </ButtonLink>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="bm__section">
            <p className="bm__label">{phase === 'cancelled' ? 'Changed your mind?' : 'Want to meet again?'}</p>
            <div className="bm__actions">
              <ButtonLink to={rebookHref} variant="primary" iconLeft={<CalendarPlus size={16} />}>
                {phase === 'cancelled' ? 'Book a new time' : 'Book another time'}
              </ButtonLink>
            </div>
          </div>
        )}
      </div>
      {embed ? null : <PublicFooter site={site} />}
    </div>
  );
}

function ManageSkeleton() {
  return (
    <div className="bm" aria-busy="true">
      <p className="u-vh" role="status">
        Loading your booking
      </p>
      <div className="pp-card bm__card" aria-hidden="true">
        <Skeleton width={96} height={24} radius={999} />
        <Skeleton width="72%" height={38} />
        <Skeleton width="54%" height={16} />
        <Skeleton lines={4} height={18} />
        <Skeleton height={48} />
      </div>
    </div>
  );
}

export default function BookingManage({ view = 'details' }: BookingManageProps) {
  const { id = '' } = useParams();
  const { search } = useLocation();
  const embed = isEmbedSearch(search);
  const token = useMemo(() => new URLSearchParams(search).get('t') ?? '', [search]);
  const asHost = useMemo(() => new URLSearchParams(search).get('as') === 'host', [search]);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token) {
      setState({ status: 'missing' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    // From a host's link the server may recognise the signed-in owner, who may change a meeting that has started.
    getBooking(id, token, { signal: controller.signal, ...(asHost ? { as: 'host' as const } : {}) }).then(
      (data) => setState({ status: 'ready', data }),
      (e: unknown) => {
        if (controller.signal.aborted) return;
        if (isApiFailure(e) && (e.status === 404 || e.status === 403)) setState({ status: 'missing' });
        else setState({ status: 'error', offline: isApiFailure(e) && e.isNetwork });
      },
    );
    return () => controller.abort();
  }, [id, token, asHost, attempt]);

  const onUpdated = useCallback((booking: PublicBooking) => {
    setState((prev) => (prev.status === 'ready' ? { status: 'ready', data: { ...prev.data, booking } } : prev));
  }, []);

  const data = state.status === 'ready' ? state.data : null;
  useDocumentTitle(data ? `${data.booking.eventTitle} · your booking` : null);
  const theme = useMemo(() => (data ? resolveTheme(data.site.theme, data.eventType?.themeOverride, data.eventType?.color) : undefined), [data]);

  if (!data || !theme) {
    return (
      <PublicPage embed={embed} width="narrow">
        {state.status === 'loading' ? (
          <ManageSkeleton />
        ) : state.status === 'missing' ? (
          <PageMessage
            kind="missing"
            title="We could not find that booking"
            description="The link may be incomplete or out of date. Please open it again from your confirmation email."
            homeHref="/"
            embed={embed}
          />
        ) : state.status === 'error' ? (
          <PageMessage
            kind={state.offline ? 'offline' : 'error'}
            title={state.offline ? 'You seem to be offline' : 'Your booking did not load'}
            description={state.offline ? 'Check your connection and try again.' : 'Something went wrong on our side. Please try again in a moment.'}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : null}
      </PublicPage>
    );
  }

  const widgetView = view === 'reschedule' && data.booking.canReschedule && !!data.eventType;

  return (
    <PublicPage theme={theme} assets={data.site.themeAssets} embed={embed} width={widgetView ? 'wide' : 'narrow'}>
      <ManageViews data={data} token={token} asHost={asHost} embed={embed} view={view} onUpdated={onUpdated} />
    </PublicPage>
  );
}
