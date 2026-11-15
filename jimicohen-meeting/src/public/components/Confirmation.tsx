import { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { PublicBooking, PublicSite } from '../../../shared/types';
import { appUrl } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { formatDateLong, formatDuration, formatRange, zoneLabel } from '../../lib/tz';
import { withEmbed } from '../lib/embed';
import { deliveryLine, deliveryOf, fillTemplate, firstName, hostNames, hostnameOf, isHttpsUrl, paragraphs } from '../lib/text';
import { BookingFacts } from './BookingFacts';
import { CalendarButtons } from './CalendarButtons';
import { Confetti } from './Confetti';
import { SuccessMark } from './SuccessMark';

export interface ConfirmationProps {
  site: PublicSite;
  booking: PublicBooking;
  manageToken: string;
  zone: string;
  hour12: boolean;
  locale: string;
  /** booked = a new booking. rescheduled = an existing one was moved. */
  variant?: 'booked' | 'rescheduled';
  /** design editor: links go nowhere, no redirect */
  preview?: boolean;
  embed?: boolean;
  headingRef?: RefObject<HTMLHeadingElement>;
}

/** Values for {{variables}} in the owner's confirmation texts. Same names as the email templates. */
export function confirmationVars(site: PublicSite, booking: PublicBooking, manageToken: string, zone: string, hour12: boolean, locale?: string): Record<string, string> {
  const hosts = booking.hosts;
  const manage = `/booking/${encodeURIComponent(booking.id)}`;
  const t = `?t=${encodeURIComponent(manageToken)}`;
  const date = formatDateLong(booking.start, zone, locale);
  const time = formatRange(booking.start, booking.end, zone, { hour12, locale });
  const tz = zoneLabel(zone, booking.start);
  return {
    invitee_name: booking.invitee.name,
    invitee_first_name: firstName(booking.invitee.name),
    invitee_email: booking.invitee.email,
    host_name: hosts[0]?.name ?? site.profile.name,
    host_first_name: firstName(hosts[0]?.name ?? site.profile.name),
    host_names: hostNames(hosts) || site.profile.name,
    event_name: booking.eventTitle,
    duration: formatDuration(booking.durationMin),
    date,
    time,
    timezone: tz,
    datetime: `${date}, ${time} (${tz})`,
    location: booking.location.value || booking.location.label,
    join_url: booking.location.joinUrl ?? '',
    manage_url: appUrl(manage) + t,
    reschedule_url: appUrl(`${manage}/reschedule`) + t,
    cancel_url: appUrl(`${manage}/cancel`) + t,
    confirm_url: appUrl(manage) + t,
    answers: '',
    site_name: site.profile.name,
    assistant_name: site.assistantName,
  };
}

const REDIRECT_SECONDS = 6;

/** Counts down, then sends the visitor to the owner's "after booking" page. Can be stopped. */
function RedirectNotice({ url, embed }: { url: string; embed: boolean }) {
  const [left, setLeft] = useState(REDIRECT_SECONDS);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    if (stopped) return;
    if (left <= 0) {
      try {
        if (embed && window.top && window.top !== window) window.top.location.href = url;
        else window.location.assign(url);
      } catch {
        // The host page does not let the frame navigate it: the link below still works.
        setStopped(true);
      }
      return;
    }
    const timer = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [left, stopped, url, embed]);

  return (
    <div className="bw-redirect" role="status">
      <p className="bw-redirect__text">{stopped ? `Continue to ${hostnameOf(url)} whenever you are ready.` : `Taking you to ${hostnameOf(url)} in ${Math.max(left, 0)} s.`}</p>
      <div className="bw-redirect__actions">
        <a className="ui-btn ui-btn--link" href={url} target={embed ? '_top' : undefined} rel="noopener">
          <span>Go now</span>
          <ArrowRight size={14} aria-hidden="true" />
        </a>
        {stopped ? null : (
          <button type="button" className="ui-btn ui-btn--link bw-redirect__stay" onClick={() => setStopped(true)}>
            Stay here
          </button>
        )}
      </div>
    </div>
  );
}

/** The last step: what was booked, in the visitor's zone, and what they can do next. */
export function Confirmation({ site, booking, manageToken, zone, hour12, locale, variant = 'booked', preview = false, embed = false, headingRef }: ConfirmationProps) {
  const { theme, motion } = useTheme();
  const vars = useMemo(() => confirmationVars(site, booking, manageToken, zone, hour12, locale), [site, booking, manageToken, zone, hour12, locale]);

  const title = variant === 'rescheduled' ? 'Your meeting has moved' : fillTemplate(theme.texts.confirmationTitle, vars) || "You're booked";
  // The owner's words, then what is really on its way: an email, an invitation from Google, both or neither.
  const body = variant === 'rescheduled' ? [] : paragraphs(fillTemplate(theme.texts.confirmationBody, vars));
  const delivery = deliveryLine(booking, variant === 'rescheduled');
  const emailed = deliveryOf(booking).email;
  const note = booking.confirmationMessage ? paragraphs(fillTemplate(booking.confirmationMessage, vars)) : [];

  const manageBase = `/booking/${encodeURIComponent(booking.id)}`;
  const tokenQuery = `?t=${encodeURIComponent(manageToken)}`;
  const redirect = !preview && variant === 'booked' && isHttpsUrl(booking.redirectUrl) ? booking.redirectUrl : null;
  const showConfetti = theme.confetti && motion && variant === 'booked';

  return (
    <div className="bw-done">
      {showConfetti ? <Confetti colors={[theme.colors.primary, theme.colors.accent, theme.colors.text, theme.colors.primary]} lively={theme.animations === 'lively'} /> : null}

      <SuccessMark />
      <h2 className="bw-done__title" ref={headingRef} tabIndex={-1}>
        {title}
      </h2>
      {body.map((p, i) => (
        <p key={i} className="bw-done__body">
          {p}
        </p>
      ))}
      <p className="bw-done__body bw-done__delivery">{delivery}</p>

      <div className="bw-done__card">
        <p className="bw-done__event">{booking.eventTitle}</p>
        <BookingFacts booking={booking} zone={zone} hour12={hour12} locale={locale} />
      </div>

      {note.length ? (
        <div className="bw-done__note">
          <p className="bw-done__notelabel">A note from {firstName(booking.hosts[0]?.name ?? site.profile.name)}</p>
          {note.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : null}

      <div className="bw-done__section">
        <p className="bw-done__label">Add to your calendar</p>
        <CalendarButtons links={booking.calendarLinks} inert={preview} />
      </div>

      <p className="bw-done__manage">
        Plans changed?{' '}
        {preview ? (
          <>
            <span className="bw-done__link">Reschedule</span> or <span className="bw-done__link">cancel</span>
          </>
        ) : (
          <>
            <Link className="bw-done__link" to={withEmbed(`${manageBase}/reschedule${tokenQuery}`, embed)}>
              Reschedule
            </Link>{' '}
            or{' '}
            <Link className="bw-done__link" to={withEmbed(`${manageBase}/cancel${tokenQuery}`, embed)}>
              cancel
            </Link>
          </>
        )}{' '}
        any time before the meeting.{emailed ? ' The same links are in your email.' : ' These links are not emailed to you, so keep one of them to find your booking again.'}
      </p>

      {redirect ? <RedirectNotice url={redirect} embed={embed} /> : null}
    </div>
  );
}
