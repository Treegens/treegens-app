/**
 * Everything about one booking: who, when (in your zone and theirs), where, their answers,
 * what was sent and what happened on reminder calls, plus the actions a host can take.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowUpRight,
  CalendarCheck2,
  CalendarClock,
  CalendarX2,
  Check,
  CircleAlert,
  CircleDot,
  Mail,
  MessageSquareText,
  PhoneCall,
  RefreshCw,
  Trash2,
  UserX,
} from 'lucide-react';
import { calendarEventLeft } from '../../../shared/calendar';
import type { AdminBooking, TimelineEntry } from '../../../shared/types';
import { APP_BASE, adminCancelBooking, deleteAdminBooking, errorMessage, getAdminBooking, isApiFailure, setNoShow } from '../../lib/api';
import { formatDateLong, formatDateMedium, formatRange, formatTime, zoneCity, zoneLabel } from '../../lib/tz';
import { Avatar, Badge, Button, ButtonLink, ConfirmDialog, CopyButton, Drawer, EmptyState, Field, Skeleton, Textarea, cx, useToast } from '../../ui';
import { describeTimeline, describeTimelineDetail, namesList, rescheduleUrlOf } from '../format';
import type { TimelineIcon } from '../format';
import { useAdmin } from '../state';
import { locationIcon } from './BookingRow';

const ICONS: Record<TimelineIcon, ReactNode> = {
  calendar: <CalendarCheck2 size={14} />,
  mail: <Mail size={14} />,
  sms: <MessageSquareText size={14} />,
  call: <PhoneCall size={14} />,
  check: <Check size={14} strokeWidth={3} />,
  cancel: <CalendarX2 size={14} />,
  move: <RefreshCw size={14} />,
  alert: <CircleAlert size={14} />,
  noshow: <UserX size={14} />,
  dot: <CircleDot size={14} />,
};

/**
 * The manage link as a host opens it: the booking page then keeps the host's zone off the invitee and records
 * changes as a host's. It opens on the address this dashboard runs on (the public one or the app's own), so the
 * owner's session goes along and the page gives the owner the dashboard's rights instead of the invitee's limits.
 */
function asHostUrl(manageUrl: string): string {
  const marked = /[?&]as=host(?:&|$)/.test(manageUrl) ? manageUrl : `${manageUrl}${manageUrl.includes('?') ? '&' : '?'}as=host`;
  try {
    const target = new URL(marked);
    if (target.origin === window.location.origin || !target.pathname.startsWith(`${APP_BASE}/booking/`)) return marked;
    return `${window.location.origin}${target.pathname}${target.search}`;
  } catch {
    return marked;
  }
}

export interface BookingDrawerProps {
  /** id of the booking to show; null closes the drawer */
  bookingId: string | null;
  /** a copy from the list, shown at once while the full record loads */
  preview?: AdminBooking | null;
  /** the owner's zone: times are shown in it first */
  zone: string;
  onClose: () => void;
  /** called with the fresh record after cancel / no-show so the list can update */
  onChanged: (booking: AdminBooking) => void;
  /** called after the booking was deleted for good: close the drawer and drop it from the list */
  onDeleted?: (id: string) => void;
}

export function BookingDrawer({ bookingId, preview, zone, onClose, onChanged, onDeleted }: BookingDrawerProps) {
  const toast = useToast();
  const { data, ownerHost } = useAdmin();
  const [booking, setBooking] = useState<AdminBooking | null>(preview ?? null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The second question: the event could not be taken off Google Calendar, delete anyway?
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bookingId) return;
    const ctrl = new AbortController();
    setError(null);
    setBooking(preview && preview.id === bookingId ? preview : null);
    getAdminBooking(bookingId, { signal: ctrl.signal })
      .then((b) => setBooking(b))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(errorMessage(e, 'We could not load this booking.'));
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, attempt]);

  const now = Date.now();
  const b = booking && booking.id === bookingId ? booking : null;
  const upcoming = !!b && b.status === 'confirmed' && Date.parse(b.start) > now;
  const past = !!b && b.status === 'confirmed' && Date.parse(b.end) <= now;
  // Only what is over or cancelled can be erased. An upcoming meeting is cancelled first (the server says so too).
  const deletable = !!b && (b.status === 'cancelled' || past);

  // Whose Google Calendar the event of this booking is on, for the question about leaving it there.
  const holder = b?.google ? data.hosts.find((h) => h.id === b.google?.hostId) : undefined;
  const whose = !holder ? "the host's" : holder.id === ownerHost.id ? 'your' : `${holder.name}'s`;

  const remove = async (leaveCalendarEvent = false) => {
    if (!b) return;
    try {
      await deleteAdminBooking(b.id, leaveCalendarEvent ? { leaveCalendarEvent: true } : undefined);
      toast.success('Booking deleted', `${b.invitee.name}'s details, answers and call records are gone from this app.`);
      onDeleted?.(b.id);
    } catch (e) {
      // Google could not take the event off the calendar, even on a fresh try. Deleting is still the
      // owner's call: ask once more, saying plainly that the event stays.
      if (!leaveCalendarEvent && isApiFailure(e, 'calendar_event_left')) {
        setDeleteOpen(false);
        setLeaveOpen(true);
        return;
      }
      toast.error('Could not delete the booking', errorMessage(e));
      throw e;
    }
  };

  const deleteButton = (
    <Button variant="ghost" className="adm-bk__delete" iconLeft={<Trash2 size={16} />} onClick={() => setDeleteOpen(true)}>
      Delete booking
    </Button>
  );

  const cancel = async () => {
    if (!b) return;
    try {
      const next = await adminCancelBooking(b.id, reason.trim() || undefined);
      setBooking(next);
      onChanged(next);
      setReason('');
      toast.success('Meeting cancelled', `${b.invitee.name} gets an email, and it is removed from the calendar.`);
    } catch (e) {
      toast.error('Could not cancel the meeting', errorMessage(e));
      throw e;
    }
  };

  const toggleNoShow = async () => {
    if (!b || busy) return;
    setBusy(true);
    try {
      const next = await setNoShow(b.id, !b.attendance.noShow);
      setBooking(next);
      onChanged(next);
      toast.success(next.attendance.noShow ? 'Marked as a no-show' : 'No-show cleared');
    } catch (e) {
      toast.error('That did not save', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Drawer
        open={bookingId !== null}
        onClose={onClose}
        width={520}
        title={b ? b.invitee.name : 'Booking'}
        description={b ? b.eventTitle : undefined}
        className="adm-bk"
        footer={
          b && b.status === 'confirmed' ? (
            <div className="adm-bk__footer">
              {upcoming ? (
                <>
                  <Button variant="danger-soft" onClick={() => setCancelOpen(true)}>
                    Cancel meeting
                  </Button>
                  <ButtonLink variant="secondary" href={rescheduleUrlOf(asHostUrl(b.manageUrl))} external iconRight={<ArrowUpRight size={16} />}>
                    Reschedule
                  </ButtonLink>
                </>
              ) : past ? (
                <>
                  <Button variant="secondary" loading={busy} iconLeft={<UserX size={16} />} onClick={() => void toggleNoShow()}>
                    {b.attendance.noShow ? 'Clear no-show' : 'Mark as a no-show'}
                  </Button>
                  {deleteButton}
                </>
              ) : (
                <span className="adm-quiet">This meeting is happening now.</span>
              )}
            </div>
          ) : b && deletable ? (
            <div className="adm-bk__footer">
              <span className="adm-quiet">This meeting was cancelled.</span>
              {deleteButton}
            </div>
          ) : undefined
        }
      >
        {error ? (
          <EmptyState
            tone="danger"
            compact
            title="This booking did not load"
            description={error}
            action={
              <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            }
          />
        ) : !b ? (
          <div className="adm-bk__loading" aria-busy="true">
            <span className="u-vh" role="status">
              Loading the booking
            </span>
            <Skeleton height={88} radius={12} style={{ display: 'block' }} />
            <Skeleton lines={4} />
            <Skeleton lines={3} />
          </div>
        ) : (
          <Details booking={b} zone={zone} />
        )}
      </Drawer>

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={cancel}
        tone="danger"
        title="Cancel this meeting?"
        description={b ? `${b.invitee.name} is told by email, and the event is removed from every calendar it is on.` : undefined}
        confirmLabel="Cancel meeting"
        cancelLabel="Keep it"
      >
        <Field label="Reason" optional hint="Included in the email to the invitee.">
          <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Something came up, sorry. Please pick another time." />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteOpen && deletable}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => remove()}
        tone="danger"
        title="Delete this booking for good?"
        description={
          b
            ? `Everything this app keeps about ${b.invitee.name}'s booking goes: their details, answers and consent, the timeline, and any reminder call records. This cannot be undone. Calendar events and messages that were already sent are not changed.`
            : undefined
        }
        confirmLabel="Delete booking"
        cancelLabel="Keep it"
      />

      <ConfirmDialog
        open={leaveOpen && deletable}
        onClose={() => setLeaveOpen(false)}
        onConfirm={() => remove(true)}
        tone="danger"
        title="The calendar event could not be removed"
        description={`The event is still on ${whose} Google Calendar and will stay there. Remove it by hand. Delete the booking anyway?`}
        confirmLabel="Delete anyway"
        cancelLabel="Cancel"
      />
    </>
  );
}

function StatusBadges({ booking }: { booking: AdminBooking }) {
  const now = Date.now();
  if (booking.status === 'cancelled') return <Badge tone="danger">Cancelled</Badge>;
  return (
    <>
      {booking.attendance.noShow ? <Badge tone="warning">No-show</Badge> : Date.parse(booking.end) <= now ? <Badge>Finished</Badge> : <Badge tone="primary">Upcoming</Badge>}
      {booking.attendance.confirmedAt ? (
        <Badge tone="success" icon={<Check size={12} />}>
          {booking.attendance.confirmedVia === 'call' ? 'Confirmed on a call' : booking.attendance.confirmedVia === 'sms' ? 'Confirmed by text' : 'Confirmed'}
        </Badge>
      ) : null}
    </>
  );
}

function Details({ booking: b, zone }: { booking: AdminBooking; zone: string }) {
  const sameZone = b.invitee.timezone === zone;
  const timeline = b.timeline.slice().sort((x, y) => y.at.localeCompare(x.at));
  const leftOnCalendar = calendarEventLeft(b);

  return (
    <div className="adm-bk__body">
      <div className="adm-bk__when">
        <div className="adm-bk__badges">
          <StatusBadges booking={b} />
        </div>
        <p className="adm-bk__date">{formatDateLong(b.start, zone)}</p>
        <p className="adm-bk__time">
          {formatRange(b.start, b.end, zone)} <span className="adm-bk__zone">{zoneCity(zone)} time</span>
        </p>
        {!sameZone ? (
          <p className="adm-bk__theirs">
            {formatTime(b.start, b.invitee.timezone)} on {formatDateMedium(b.start, b.invitee.timezone)} for {b.invitee.name.split(' ')[0]}, who is in {zoneLabel(b.invitee.timezone, b.start)}
          </p>
        ) : null}
        {b.rescheduledFromStart ? <p className="adm-bk__theirs">Moved from {formatDateMedium(b.rescheduledFromStart, zone)} at {formatTime(b.rescheduledFromStart, zone)}</p> : null}
        {b.cancellation ? (
          <p className="adm-bk__cancel">
            Cancelled by{' '}
            {b.cancellation.by === 'host'
              ? b.cancellation.via === 'host_link'
                ? 'a host, from the booking page'
                : 'you'
              : b.cancellation.by === 'assistant'
                ? 'the invitee, on a reminder call'
                : 'the invitee'}{' '}
            on {formatDateMedium(b.cancellation.at, zone)}
            {b.cancellation.reason ? `: "${b.cancellation.reason}"` : '.'}
          </p>
        ) : null}
      </div>

      <dl className="adm-bk__facts">
        <div>
          <dt>Where</dt>
          <dd>
            <span className="adm-bk__loc">
              {locationIcon(b.location.type)}
              <span>{b.location.label}</span>
            </span>
            {b.location.joinUrl ? (
              <a className="adm-textlink" href={b.location.joinUrl} target="_blank" rel="noopener noreferrer">
                Join link
              </a>
            ) : b.location.value ? (
              <span className="adm-bk__sub">{b.location.value}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{b.hosts.length > 1 ? 'Hosts' : 'Host'}</dt>
          <dd>
            <span className="adm-bk__people">
              {b.hosts.map((h) => (
                <Avatar key={h.id} name={h.name} src={h.avatarUrl} size="xs" decorative />
              ))}
              <span>{namesList(b.hosts.map((h) => h.name))}</span>
            </span>
          </dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>
            <a className="adm-textlink" href={`mailto:${b.invitee.email}`}>
              {b.invitee.email}
            </a>
          </dd>
        </div>
        {b.invitee.phone ? (
          <div>
            <dt>Phone</dt>
            <dd>
              <a className="adm-textlink" href={`tel:${b.invitee.phone}`}>
                {b.invitee.phone}
              </a>
              <span className="adm-bk__sub">
                {b.consent.sms && b.consent.call ? 'Agreed to texts and reminder calls' : b.consent.sms ? 'Agreed to texts only' : b.consent.call ? 'Agreed to reminder calls only' : 'Did not agree to texts or calls'}
              </span>
            </dd>
          </div>
        ) : null}
        {b.guests.length ? (
          <div>
            <dt>Guests</dt>
            <dd>
              {b.guests.map((g) => (
                <span key={g} className="adm-bk__line">
                  {g}
                </span>
              ))}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Calendar</dt>
          <dd>
            {b.status === 'cancelled' ? (
              // A cancelled meeting's event should be gone: say so when it is still there.
              leftOnCalendar ? (
                <span className="adm-bk__warn">
                  <CircleAlert size={14} aria-hidden="true" /> Still on Google Calendar: {leftOnCalendar}
                </span>
              ) : (
                <span className="adm-quiet">Removed</span>
              )
            ) : b.google?.error ? (
              <span className="adm-bk__warn">
                <CircleAlert size={14} aria-hidden="true" /> Not on Google Calendar yet: {b.google.error}
              </span>
            ) : b.google?.eventId ? (
              b.google.htmlLink ? (
                <a className="adm-textlink" href={b.google.htmlLink} target="_blank" rel="noopener noreferrer">
                  On Google Calendar
                </a>
              ) : (
                <span>On Google Calendar</span>
              )
            ) : (
              <span className="adm-quiet">Not connected</span>
            )}
          </dd>
        </div>
      </dl>

      {b.answers.length ? (
        <section className="adm-bk__section" aria-label="Answers">
          <h3 className="adm-bk__heading">Their answers</h3>
          <dl className="adm-bk__answers">
            {b.answers.map((a) => (
              <div key={a.questionId}>
                <dt>{a.label}</dt>
                <dd>{a.value || <span className="adm-quiet">No answer</span>}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section className="adm-bk__section" aria-label="Timeline">
        <h3 className="adm-bk__heading">What happened</h3>
        <ol className="adm-timeline" role="list">
          {timeline.map((entry, i) => (
            <TimelineRow key={`${entry.at}-${entry.type}-${i}`} entry={entry} zone={zone} />
          ))}
        </ol>
      </section>

      <section className="adm-bk__section adm-bk__manage" aria-label="Manage link">
        <div>
          <h3 className="adm-bk__heading">Manage link</h3>
          <p className="adm-bk__sub">The page the invitee uses to reschedule or cancel. Safe to forward to them.</p>
        </div>
        <div className="adm-bk__manageactions">
          <CopyButton value={b.manageUrl} label="Copy" size="sm" />
          {/* Opened from here, the page knows a host is acting. The copied link is for the invitee, so it stays plain. */}
          <ButtonLink variant="ghost" size="sm" href={asHostUrl(b.manageUrl)} external iconRight={<ArrowUpRight size={15} />}>
            Open
          </ButtonLink>
        </div>
      </section>
    </div>
  );
}

function TimelineRow({ entry, zone }: { entry: TimelineEntry; zone: string }) {
  const view = describeTimeline(entry);
  const future = Date.parse(entry.at) > Date.now();
  return (
    <li className={cx('adm-timeline__item', `is-${view.tone}`)}>
      <span className="adm-timeline__icon" aria-hidden="true">
        {future ? <CalendarClock size={14} /> : ICONS[view.icon]}
      </span>
      <div className="adm-timeline__text">
        <p className="adm-timeline__label">{view.label}</p>
        {entry.detail && entry.detail.trim().toLowerCase() !== view.label.toLowerCase() ? <p className="adm-timeline__detail">{describeTimelineDetail(entry.detail)}</p> : null}
        {/* Read from the call record while it is kept (90 days). The booking stores only the outcome. */}
        {entry.transcript ? <p className="adm-timeline__detail">Transcript: {entry.transcript}</p> : null}
      </div>
      <time className="adm-timeline__time" dateTime={entry.at}>
        {formatDateMedium(entry.at, zone)}, {formatTime(entry.at, zone)}
      </time>
    </li>
  );
}
