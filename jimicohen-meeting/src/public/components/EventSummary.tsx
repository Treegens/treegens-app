import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarCheck, CalendarClock, Clock, Shuffle, UsersRound } from 'lucide-react';
import type { PublicEventType, PublicSite } from '../../../shared/types';
import { useTheme } from '../../lib/theme';
import { dayKey, formatDayKey, formatDuration, formatRange } from '../../lib/tz';
import { Avatar, AvatarGroup, Badge } from '../../ui';
import { firstName, hostNames, joinNames, paragraphs } from '../lib/text';
import { ChoiceChips } from './ChoiceChips';
import { LocationIcon } from './LocationIcon';

export interface EventSummaryProps {
  site: PublicSite;
  eventType: PublicEventType;
  duration: number;
  onDurationChange?: (minutes: number) => void;
  locationIndex: number;
  onLocationChange?: (index: number) => void;
  zone: string;
  hour12: boolean;
  /** the chosen start, shown once a time has been picked */
  selectedStart: number | null;
  /** set when moving an existing booking: its current start */
  rescheduleFrom?: number | null;
  /** lock the pickers (details step shows what was chosen, rescheduling keeps the length) */
  locked?: boolean;
  /** link back to the list of meeting types */
  backHref?: string;
  locale?: string;
}

function Row({ icon, children, below }: { icon: ReactNode; children: ReactNode; below?: ReactNode }) {
  return (
    <li className="bw-meta__row">
      <span className="bw-meta__icon" aria-hidden="true">
        {icon}
      </span>
      <div className="bw-meta__body">{children}</div>
      {below ? <div className="bw-meta__below">{below}</div> : null}
    </li>
  );
}

/** Who, what, how long and where: the left (or top) part of the booking card. */
export function EventSummary({ site, eventType, duration, onDurationChange, locationIndex, onLocationChange, zone, hour12, selectedStart, rescheduleFrom, locked = false, backHref, locale }: EventSummaryProps) {
  const { theme, assets } = useTheme();
  const [logoFailed, setLogoFailed] = useState(false);
  const hosts = eventType.hosts;
  const location = eventType.locations[locationIndex] ?? eventType.locations[0];
  const several = hosts.length > 1;
  const names = hostNames(hosts, eventType.kind);
  const firstNames = joinNames(hosts.map((h) => firstName(h.name)), eventType.kind === 'round_robin' ? 'or' : 'and');
  const description = paragraphs(eventType.description);
  const showDurationPicker = eventType.durations.length > 1 && !locked && !!onDurationChange;
  const showLocationPicker = eventType.locations.length > 1 && !locked && !!onLocationChange;

  // How many blocks sit beside the facts when the summary turns into a two-column band (stacked layout).
  const logoShown = !!assets.logoUrl && !logoFailed;
  const sideRows = (backHref ? 1 : 0) + (logoShown ? 1 : 0) + 2 + (description.length ? 1 : 0);

  return (
    <div className="bw-summary" style={{ '--bw-side-rows': sideRows } as CSSProperties}>
      {backHref ? (
        <Link to={backHref} className="bw-summary__back">
          <ArrowLeft size={16} aria-hidden="true" />
          <span>All meeting types</span>
        </Link>
      ) : null}

      {logoShown && assets.logoUrl ? <img className="bw-summary__logo" src={assets.logoUrl} alt={`${site.profile.name} logo`} onError={() => setLogoFailed(true)} /> : null}

      <div className="bw-summary__hosts">
        {theme.showAvatar && hosts.length ? (
          several ? (
            <AvatarGroup people={hosts} size={44} max={4} />
          ) : (
            <Avatar name={hosts[0].name} src={hosts[0].avatarUrl} size={52} decorative />
          )
        ) : null}
        <div className="bw-summary__who">
          <p className="bw-summary__names">{names || site.profile.name}</p>
          {!several && hosts[0]?.title ? <p className="bw-summary__role">{hosts[0].title}</p> : null}
          {several ? <p className="bw-summary__role">{eventType.kind === 'round_robin' ? 'One of them will meet you' : hosts.length === 2 ? 'Both will join' : 'Everyone will join'}</p> : null}
        </div>
      </div>

      <div className="bw-summary__title">
        {rescheduleFrom ? (
          <Badge tone="accent" icon={<CalendarClock size={13} />}>
            Rescheduling
          </Badge>
        ) : null}
        <h1 className="bw-summary__name">{eventType.title}</h1>
      </div>

      <ul role="list" className="bw-meta">
        {selectedStart ? (
          <Row icon={<CalendarCheck size={18} />}>
            <p className="bw-meta__strong">{formatDayKey(dayKey(selectedStart, zone), locale, 'long')}</p>
            <p className="bw-meta__sub bw-meta__time">{formatRange(selectedStart, selectedStart + duration * 60000, zone, { hour12, locale })}</p>
          </Row>
        ) : null}

        {rescheduleFrom ? (
          <Row icon={<CalendarClock size={18} />}>
            <p className="bw-meta__label">Currently booked for</p>
            <p className={selectedStart ? 'bw-meta__was' : 'bw-meta__sub'}>
              {formatDayKey(dayKey(rescheduleFrom, zone), locale, 'long')}, {formatRange(rescheduleFrom, rescheduleFrom + duration * 60000, zone, { hour12, locale })}
            </p>
          </Row>
        ) : null}

        <Row
          icon={<Clock size={18} />}
          below={
            showDurationPicker ? (
              <ChoiceChips
                label="Meeting length"
                value={duration}
                onChange={(v) => onDurationChange?.(v)}
                options={eventType.durations.map((d) => ({ value: d, label: formatDuration(d) }))}
              />
            ) : undefined
          }
        >
          {showDurationPicker ? <p className="bw-meta__label">How long?</p> : <p className="bw-meta__strong">{formatDuration(duration)}</p>}
        </Row>

        {location ? (
          <Row
            icon={<LocationIcon type={location.type} />}
            below={
              showLocationPicker ? (
                <>
                  <ChoiceChips
                    label="Where to meet"
                    value={locationIndex}
                    onChange={(v) => onLocationChange?.(v)}
                    options={eventType.locations.map((l, i) => ({ value: i, label: l.label, icon: <LocationIcon type={l.type} size={15} /> }))}
                  />
                  {location.detail ? <p className="bw-meta__sub bw-meta__detail">{location.detail}</p> : null}
                </>
              ) : undefined
            }
          >
            {showLocationPicker ? (
              <p className="bw-meta__label">Where?</p>
            ) : (
              <>
                <p className="bw-meta__strong">{location.label}</p>
                {location.detail ? <p className="bw-meta__sub">{location.detail}</p> : null}
              </>
            )}
          </Row>
        ) : null}

        {several && eventType.kind === 'collective' ? (
          <Row icon={<UsersRound size={18} />}>
            <p className="bw-meta__sub">You only see times when {firstNames} are {hosts.length === 2 ? 'both' : 'all'} free.</p>
          </Row>
        ) : null}
        {several && eventType.kind === 'round_robin' ? (
          <Row icon={<Shuffle size={18} />}>
            <p className="bw-meta__sub">You meet with {firstNames}, whoever is free at the time you pick.</p>
          </Row>
        ) : null}
      </ul>

      {description.length ? (
        <div className="bw-summary__desc">
          {description.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
