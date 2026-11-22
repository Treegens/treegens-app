import type { CSSProperties } from 'react';
import { ChevronRight, Shuffle, User, Users } from 'lucide-react';
import type { AdminHost, EventKind } from '../../../../shared/types';
import { zoneCity } from '../../../lib/tz';
import { Avatar, Badge, ButtonLink, RadioGroup, cx } from '../../../ui';
import type { BadgeTone } from '../../../ui';
import { firstName, namesList } from '../../format';
import { useAdmin } from '../../state';
import { Notice, Section } from '../Page';
import { SharedHoursNotice, useSharedHours } from './SharedHoursNotice';
import type { TabProps } from './shared';

function calendarStatus(host: AdminHost): { label: string; tone: BadgeTone } {
  // Any of their Google accounts: one that needs a reconnect closes their times.
  if (host.google?.status === 'needs_reconnect' || (host.googleExtra ?? []).some((a) => a.status === 'needs_reconnect')) return { label: 'Reconnect Google', tone: 'danger' };
  if (host.google) return { label: 'Google Calendar connected', tone: 'success' };
  // Only other accounts (the main one was removed): their busy times count, but new meetings have no calendar to go to.
  if ((host.googleExtra ?? []).length) return { label: 'Busy times checked, no account for new meetings', tone: 'warning' };
  if (host.icsFeeds.length) return { label: 'Calendar feed', tone: 'neutral' };
  return { label: 'No calendar connected', tone: 'warning' };
}

/**
 * What invitees will see, in one or two sentences. `writes`, per name: whether that host has Google Calendar
 * connected for new meetings. A meeting only goes on a calendar through Google, so the summary says so.
 */
export function hostsSummary(kind: EventKind, names: string[], writes: boolean[] = names.map(() => true)): string {
  const list = namesList(names);
  if (!names.length) return 'Choose who hosts this meeting.';
  if (kind === 'solo' || names.length === 1) {
    return writes[0] ? `People book ${list}. The meeting goes on ${names[0]}'s calendar.` : `People book ${list}. Until ${names[0]} connects Google Calendar, the meeting goes on no calendar.`;
  }
  if (kind === 'collective') {
    const seen = `People only see times when ${list} are ${names.length === 2 ? 'both' : 'all'} free.`;
    return writes.some(Boolean)
      ? `${seen} One booking puts the meeting on ${names.length === 2 ? 'both calendars' : `all ${names.length} calendars`}.`
      : `${seen} Until one of them connects Google Calendar, bookings go on no calendar.`;
  }
  const missing = names.filter((_, i) => !writes[i]);
  return `People see every time when ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]} is free. Each booking goes to one of them, and bookings are shared out evenly.${
    missing.length ? ` Until ${namesList(missing)} ${missing.length === 1 ? 'connects' : 'connect'} Google Calendar, their bookings go on no calendar.` : ''
  }`;
}

type Seg = [number, number];
const A: Seg[] = [
  [0, 0.36],
  [0.5, 1],
];
const B: Seg[] = [[0.14, 0.74]];
const BOTH: Seg[] = [
  [0.14, 0.36],
  [0.5, 0.74],
];
const EITHER: Seg[] = [[0, 1]];

function Track({ label, segs, offered }: { label: string; segs: Seg[]; offered?: boolean }) {
  return (
    <div className={cx('adm-overlap__row', offered && 'is-offered')}>
      <span className="adm-overlap__label u-truncate">{label}</span>
      <span className="adm-overlap__track">
        {segs.map(([from, to], i) => (
          <span key={i} className="adm-overlap__seg" style={{ '--_l': `${from * 100}%`, '--_w': `${(to - from) * 100}%` } as CSSProperties} />
        ))}
      </span>
    </div>
  );
}

/** A tiny picture of one example day: when each host is free, and what the invitee is offered. */
function OverlapDiagram({ kind, names }: { kind: EventKind; names: string[] }) {
  const a = names[0] ?? 'You';
  const b = names[1] ?? 'Co-host';
  const caption =
    kind === 'solo'
      ? 'Example day: people can book any time you are free.'
      : kind === 'collective'
        ? 'Example day: only the overlap is offered.'
        : 'Example day: any time one of you is free is offered.';
  return (
    <figure className="adm-overlap" aria-label={caption}>
      <div className="adm-overlap__rows" aria-hidden="true">
        <Track label={a} segs={A} />
        {kind !== 'solo' ? <Track label={b} segs={B} /> : null}
        <Track label="Offered" segs={kind === 'solo' ? A : kind === 'collective' ? BOTH : EITHER} offered />
      </div>
      <div className="adm-overlap__axis" aria-hidden="true">
        <span>9 AM</span>
        <span>1 PM</span>
        <span>5 PM</span>
      </div>
      <figcaption className="adm-overlap__caption">{caption}</figcaption>
    </figure>
  );
}

export function HostsTab({ draft, update, errors }: TabProps) {
  const { data, ownerHost } = useAdmin();
  const hosts = data.hosts;
  const selected = draft.hostIds.filter((id) => hosts.some((h) => h.id === id));
  const multi = draft.kind !== 'solo';
  const enoughHosts = hosts.length >= 2;
  const names = selected.map((id) => firstName(hosts.find((h) => h.id === id)?.name ?? ''));
  const hours = useSharedHours(draft);

  const setKind = (kind: EventKind) => {
    if (kind === 'solo') {
      update({ kind, hostIds: [selected.includes(ownerHost.id) || !selected.length ? ownerHost.id : selected[0]] });
      return;
    }
    let ids = selected.slice();
    if (ids.length < 2) {
      const pool = [ownerHost.id, ...hosts.filter((h) => h.id !== ownerHost.id).map((h) => h.id)];
      for (const id of pool) {
        if (ids.length >= 2) break;
        if (!ids.includes(id)) ids.push(id);
      }
      ids = hosts.filter((h) => ids.includes(h.id)).map((h) => h.id);
    }
    update({ kind, hostIds: ids });
  };

  const toggleHost = (id: string, on: boolean) => {
    if (!multi) {
      update({ hostIds: [id] });
      return;
    }
    const next = on ? [...selected, id] : selected.filter((x) => x !== id);
    update({ hostIds: hosts.filter((h) => next.includes(h.id)).map((h) => h.id) });
  };

  return (
    <>
      <Section
        title="Who hosts"
        description="Book into one calendar, or into several at once."
        aside={<OverlapDiagram kind={draft.kind} names={names.length ? names : [firstName(ownerHost.name)]} />}
      >
        <RadioGroup<EventKind>
          aria-label="Kind of meeting"
          variant="cards"
          columns={3}
          value={draft.kind}
          onChange={setKind}
          options={[
            { value: 'solo', icon: <User size={18} />, label: 'Just me', description: 'One host. People book into a single calendar.' },
            {
              value: 'collective',
              icon: <Users size={18} />,
              label: 'Together',
              description: 'Everyone must be free. Only times that work for all hosts are offered, and the meeting goes on all your calendars.',
            },
            { value: 'round_robin', icon: <Shuffle size={18} />, label: 'Round robin', description: 'Whoever is free. Each booking goes to one host, shared out evenly.' },
          ]}
        />

        {multi && !enoughHosts ? (
          <Notice
            tone="warning"
            title="This needs at least two hosts"
            action={
              <ButtonLink variant="secondary" size="sm" to="/admin/team" iconRight={<ChevronRight size={15} />}>
                Add a co-host
              </ButtonLink>
            }
          >
            Invite a co-host on the Team page. Once they connect their calendar you can book into both.
          </Notice>
        ) : null}

        <fieldset className={cx('adm-hosts', errors.hostIds && 'is-invalid')}>
          <legend className="adm-hosts__legend">{multi ? 'Hosts on this meeting' : 'Host'}</legend>
          <ul role="list" className="adm-hosts__list">
            {hosts.map((h) => {
              const on = selected.includes(h.id);
              const status = calendarStatus(h);
              const inputId = `evt-host-${h.id}`;
              return (
                <li key={h.id}>
                  <label htmlFor={inputId} className={cx('adm-host', on && 'is-on')}>
                    <input
                      id={inputId}
                      className="adm-host__input"
                      type={multi ? 'checkbox' : 'radio'}
                      name="evt-hosts"
                      checked={on}
                      onChange={(e) => toggleHost(h.id, e.target.checked)}
                    />
                    <Avatar name={h.name} src={h.avatarUrl} size="md" decorative />
                    <span className="adm-host__text">
                      <span className="adm-host__name">
                        <span className="u-truncate">{h.name}</span>
                        {h.id === ownerHost.id ? <span className="adm-host__you">You</span> : null}
                      </span>
                      <span className="adm-host__meta u-truncate">
                        {h.email || 'No email yet'} · {zoneCity(h.timezone)} time
                      </span>
                    </span>
                    <Badge tone={status.tone} size="sm" dot className="adm-host__status">
                      {status.label}
                    </Badge>
                  </label>
                </li>
              );
            })}
          </ul>
          {errors.hostIds ? (
            <p className="adm-fielderror" role="alert">
              {errors.hostIds}
            </p>
          ) : null}
        </fieldset>

        <p className="adm-summary" aria-live="polite">
          {hostsSummary(
            draft.kind,
            names,
            selected.map((id) => hosts.find((x) => x.id === id)?.google?.status === 'ok'),
          )}
        </p>

        <SharedHoursNotice answer={hours} />

        {selected.some((id) => {
          const h = hosts.find((x) => x.id === id);
          return h && !h.google && !(h.googleExtra ?? []).length && h.icsFeeds.length === 0;
        }) ? (
          <Notice tone="info">A host without a connected calendar always looks free. Their own bookings here are still respected.</Notice>
        ) : null}
      </Section>
    </>
  );
}
