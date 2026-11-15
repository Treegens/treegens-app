/**
 * Team: adding a co-host to the meeting behind jimicohen.com/pod in the same step, and saying afterwards
 * what that changed (DESIGN 6.5, as settled by the lead): only the /pod meeting is ticked; any other meeting
 * in a brand's look is offered unticked. After the add, the shared-hours check runs and says what it finds.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EventType, HostInviteResponse, SharedHoursCheck } from '../../../shared/types';
import { checkSharedHours } from '../../lib/api';
import { Checkbox } from '../../ui';
import { brandIdOf, shortLinkRows } from '../brands';
import { firstName } from '../format';
import { useAdmin } from '../state';
import { Notice } from './Page';
import '../../styles/adminbrands.css';

export interface PodChoice {
  eventType: EventType;
  /** the short link that opens it ("jimicohen.com/pod"), for the /pod meeting */
  linkLabel: string | null;
  ticked: boolean;
}

/** The meetings offered when a co-host is added: the /pod one ticked, other branded ones unticked. */
export function usePodChoices(): PodChoice[] {
  const { data } = useAdmin();
  return useMemo(() => {
    const pod = shortLinkRows(data)?.find((r) => r.name === 'pod');
    const podEvent = pod?.eventType && pod.eventType.active ? pod.eventType : null;
    const out: PodChoice[] = podEvent ? [{ eventType: podEvent, linkLabel: pod!.label, ticked: true }] : [];
    for (const et of data.eventTypes) {
      if (et.id === podEvent?.id || !et.active || !brandIdOf(et)) continue;
      out.push({ eventType: et, linkLabel: null, ticked: false });
    }
    return out;
  }, [data]);
}

function offerText(choice: PodChoice, who: string, named: boolean): string {
  const et = choice.eventType;
  if (et.kind === 'round_robin') return `${choice.linkLabel ?? et.title} can then book ${who} too.`;
  const people = et.hostIds.length <= 1 ? 'both' : 'all';
  const where = choice.linkLabel ?? et.title;
  return `Once ${who} ${named ? 'connects' : 'connect'} a calendar, ${where} only offers times when you are ${people} free.`;
}

/** The checkboxes under the email field of "Add a co-host". */
export function PodOfferChoices({ name, choices, value, onChange }: { name: string; choices: PodChoice[]; value: string[]; onChange: (ids: string[]) => void }) {
  if (!choices.length) return null;
  const first = firstName(name.trim());
  const who = first || 'they';
  return (
    <div className="tm-podoffer" role="group" aria-label="Meetings to add them to">
      {choices.map((choice) => {
        const on = value.includes(choice.eventType.id);
        return (
          <Checkbox
            key={choice.eventType.id}
            checked={on}
            onChange={(next) => onChange(next ? [...value, choice.eventType.id] : value.filter((id) => id !== choice.eventType.id))}
            label={`Add ${first || 'them'} to ${choice.eventType.title}`}
            description={offerText(choice, who, !!first)}
          />
        );
      })}
    </div>
  );
}

/** After the add: which meetings they joined, which could not be changed, and what the shared-hours check says. */
export function AddedToMeetings({ answer }: { answer: HostInviteResponse }) {
  const first = firstName(answer.host.name);
  const joined = answer.eventTypes ?? [];
  const missed = answer.notAddedTo ?? [];
  const { data } = useAdmin();
  const [checks, setChecks] = useState<Record<string, SharedHoursCheck>>({});

  useEffect(() => {
    const ctrl = new AbortController();
    for (const et of joined.filter((e) => e.kind === 'collective')) {
      checkSharedHours(et, { signal: ctrl.signal })
        .then((result) => setChecks((prev) => ({ ...prev, [et.id]: result })))
        .catch(() => undefined);
    }
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer]);

  if (!joined.length && !missed.length) return null;
  const title = (id: string) => data.eventTypes.find((e) => e.id === id)?.title ?? 'that meeting';
  return (
    <div className="tm-added">
      {joined.map((et) => (
        <p key={et.id} className="tm-added__text">
          {first} is part of {et.title} now. Until {first} connects a calendar, only {first}'s weekly hours are checked.
        </p>
      ))}
      {joined
        .filter((et) => checks[et.id] && !checks[et.id].ok)
        .map((et) => (
          <Notice key={`hours-${et.id}`} tone="warning">
            {checks[et.id].message}
          </Notice>
        ))}
      {missed.map((m) => (
        <Notice key={`missed-${m.id}`} tone="warning">
          {first} is on the team, but was not added to {title(m.id)}: {m.message.replace(/\.$/, '')}. You can add {first} on its{' '}
          <Link className="adm-textlink" to={`/admin/event-types/${m.id}?tab=hosts`}>
            Hosts tab
          </Link>
          .
        </Notice>
      ))}
    </div>
  );
}
