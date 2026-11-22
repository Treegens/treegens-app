import type { ReactNode } from 'react';
import { CalendarCheck, ExternalLink, UserPlus, UserRound, UsersRound } from 'lucide-react';
import type { PublicBooking } from '../../../shared/types';
import { formatDateLong, formatRange, zoneLabel } from '../../lib/tz';
import { cx } from '../../ui';
import { deliveryOf, hostNames, isWebUrl } from '../lib/text';
import { LocationIcon } from './LocationIcon';

export interface BookingFactsProps {
  booking: PublicBooking;
  zone: string;
  hour12: boolean;
  locale?: string;
  /** strike the time through (cancelled meetings) */
  struck?: boolean;
  /** open the join link in a new tab */
  className?: string;
}

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="bk-fact">
      <dt className="bk-fact__term">
        <span className="bk-fact__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="u-vh">{label}</span>
      </dt>
      <dd className="bk-fact__body">{children}</dd>
    </div>
  );
}

/** When, where and with whom: the facts of one booking, in the visitor's time zone. */
export function BookingFacts({ booking, zone, hour12, locale, struck = false, className }: BookingFactsProps) {
  const { location } = booking;
  const join = isWebUrl(location.joinUrl) ? location.joinUrl : null;
  const several = booking.hosts.length > 1;
  return (
    <dl className={cx('bk-facts', struck && 'is-struck', className)}>
      <Fact icon={<CalendarCheck size={18} />} label="When">
        <p className="bk-fact__main bk-fact__when">{formatDateLong(booking.start, zone, locale)}</p>
        <p className="bk-fact__main bk-fact__when">{formatRange(booking.start, booking.end, zone, { hour12, locale })}</p>
        <p className="bk-fact__sub">{zoneLabel(zone, booking.start)}</p>
      </Fact>
      <Fact icon={<LocationIcon type={location.type} />} label="Where">
        <p className="bk-fact__main">{location.label}</p>
        {location.value && location.value !== join ? <p className="bk-fact__sub">{location.value}</p> : null}
        {join && !struck ? (
          <a className="bk-fact__link" href={join} target="_blank" rel="noopener noreferrer">
            <span>Open the meeting link</span>
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        ) : null}
        {location.type === 'google_meet' && !join && !struck ? (
          <p className="bk-fact__sub">{deliveryOf(booking).calendarInvite ? 'The link is in your calendar invitation.' : 'The meeting link will be on your booking page once it is ready.'}</p>
        ) : null}
      </Fact>
      {booking.hosts.length ? (
        <Fact icon={several ? <UsersRound size={18} /> : <UserRound size={18} />} label="With">
          <p className="bk-fact__main">{hostNames(booking.hosts)}</p>
        </Fact>
      ) : null}
      {booking.guests.length ? (
        <Fact icon={<UserPlus size={18} />} label="Guests">
          <p className="bk-fact__main">{booking.guests.length === 1 ? '1 guest' : `${booking.guests.length} guests`}</p>
          <p className="bk-fact__sub bk-fact__guests">{booking.guests.join(', ')}</p>
        </Fact>
      ) : null}
    </dl>
  );
}
