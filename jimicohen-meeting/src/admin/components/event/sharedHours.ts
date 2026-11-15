/**
 * The shared-hours check of the event type editor, without React: for a joint ("together") meeting, do
 * the hosts' working hours ever line up? The Hosts and the Scheduling tab both ask it (see
 * SharedHoursNotice.tsx), through POST /admin/event-types-check.
 */
import type { AdminHost, EventType, SharedHoursCheck } from '../../../../shared/types';

/** What the server said, or 'failed' when the check could not run. */
export type SharedHoursAnswer = SharedHoursCheck | 'failed';

/** An answer, with the key of what was on screen when it was asked. */
export interface HeldAnswer {
  key: string;
  answer: SharedHoursAnswer;
}

type Draft = Pick<EventType, 'id' | 'title' | 'kind' | 'hostIds' | 'durations' | 'scheduling'>;

/**
 * Everything that decides the answer, as one string: the hosts, the lengths, the whole Scheduling tab, and
 * the chosen hosts' own hours and zones (they change on other pages, or with a refresh). Empty when there is
 * nothing to check: only a joint meeting of two or more hosts can have hours that never meet.
 */
export function sharedHoursKey(draft: Draft, hosts: AdminHost[]): string {
  if (draft.kind !== 'collective' || draft.hostIds.length < 2) return '';
  const theirs = hosts.filter((h) => draft.hostIds.includes(h.id)).map((h) => [h.id, h.timezone, h.schedules, h.defaultScheduleId]);
  return JSON.stringify([draft.id, draft.kind, draft.hostIds, draft.durations, draft.scheduling, theirs]);
}

/**
 * The answer to show for what is on screen now. An answer about the draft as it was before an edit says
 * nothing about the draft as it is, so it is dropped as soon as the key moves on: null until the new
 * answer is in, and null when there is nothing to check.
 */
export function currentAnswer(key: string, held: HeldAnswer | null): SharedHoursAnswer | null {
  if (!key || !held || held.key !== key) return null;
  return held.answer;
}

/**
 * Asks once. Resolves with the server's answer, with 'failed' when the check could not run (offline, a
 * server error), or with null when it was called off because the draft changed again in the meantime.
 */
export async function askSharedHours(
  draft: Draft,
  ask: (body: Partial<EventType>, opts: { signal: AbortSignal }) => Promise<SharedHoursCheck>,
  signal: AbortSignal,
): Promise<SharedHoursAnswer | null> {
  try {
    const answer = await ask({ id: draft.id, title: draft.title, kind: draft.kind, hostIds: draft.hostIds, durations: draft.durations, scheduling: draft.scheduling }, { signal });
    return signal.aborted ? null : answer;
  } catch {
    return signal.aborted ? null : 'failed';
  }
}
