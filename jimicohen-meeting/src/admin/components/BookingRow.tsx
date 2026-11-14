import { Check, ChevronRight, MapPin, Phone, RefreshCw, Video } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { To } from 'react-router-dom';
import type { AdminBooking, LocationType } from '../../../shared/types';
import { dayKey, daysBetween, formatDateMedium, formatTime, todayKey } from '../../lib/tz';
import { AvatarGroup, Badge } from '../../ui';

export function locationIcon(type: LocationType) {
  if (type === 'google_meet' || type === 'custom_link') return <Video size={14} aria-hidden="true" />;
  if (type === 'phone_host_calls' || type === 'phone_invitee_calls') return <Phone size={14} aria-hidden="true" />;
  return <MapPin size={14} aria-hidden="true" />;
}

/** "Today, Tue, Nov 17", "Tomorrow, ...", "Yesterday, ...", or the date. */
export function dayHeading(key: string, today: string, ms: number, zone: string): string {
  const diff = daysBetween(today, key);
  const date = formatDateMedium(ms, zone);
  if (diff === 0) return `Today, ${date}`;
  if (diff === 1) return `Tomorrow, ${date}`;
  if (diff === -1) return `Yesterday, ${date}`;
  return date;
}

export interface DayGroup {
  key: string;
  heading: string;
  items: AdminBooking[];
}

/** Groups a sorted list by calendar day in `zone`, keeping the list's order. */
export function groupByDay(bookings: AdminBooking[], zone: string, now: number = Date.now()): DayGroup[] {
  const today = todayKey(zone, now);
  const groups: DayGroup[] = [];
  for (const b of bookings) {
    const key = dayKey(b.start, zone);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(b);
    else groups.push({ key, heading: dayHeading(key, today, Date.parse(b.start), zone), items: [b] });
  }
  return groups;
}

export interface BookingRowProps {
  booking: AdminBooking;
  zone: string;
  to: To;
  /** show the invitee's email after their name (wide lists) */
  showEmail?: boolean;
}

/** One meeting in an agenda list. The whole row is a link to its details. */
export function BookingRow({ booking: b, zone, to, showEmail = false }: BookingRowProps) {
  const cancelled = b.status === 'cancelled';
  return (
    <Link to={to} className="adm-agenda__row">
      <span className="adm-agenda__time">
        <span className="adm-agenda__start">{formatTime(b.start, zone)}</span>
        <span className="adm-agenda__dur">{b.durationMin} min</span>
      </span>
      <span className="adm-agenda__main">
        <span className="adm-agenda__who">
          <span className="u-truncate">{b.invitee.name}</span>
          {showEmail ? <span className="adm-agenda__email u-truncate">{b.invitee.email}</span> : null}
        </span>
        <span className="adm-agenda__what">
          <span className="u-truncate">{b.eventTitle}</span>
          <span className="adm-agenda__loc">
            {locationIcon(b.location.type)}
            <span className="u-truncate">{b.location.label}</span>
          </span>
        </span>
      </span>
      <span className="adm-agenda__side">
        {cancelled ? (
          <Badge tone="danger" size="sm">
            Cancelled
          </Badge>
        ) : b.attendance.noShow ? (
          <Badge tone="warning" size="sm">
            No-show
          </Badge>
        ) : b.attendance.confirmedAt ? (
          <Badge tone="success" size="sm" icon={<Check size={12} />}>
            Confirmed
          </Badge>
        ) : b.rescheduleCount > 0 ? (
          <Badge size="sm" icon={<RefreshCw size={11} />}>
            Moved
          </Badge>
        ) : null}
        {b.hosts.length > 1 ? <AvatarGroup people={b.hosts} size="xs" max={3} /> : null}
        <ChevronRight size={16} aria-hidden="true" className="adm-agenda__chev" />
      </span>
    </Link>
  );
}
