// STUB
import type { BookingIndexEntry, EventType, Host, IanaZone, Schedule } from '../../shared/types';
import type { Interval } from './time';

/** busy = EXTERNAL calendar busy (not our own bookings) */
export interface HostAvailabilityInput {
  host: Host;
  busy: Interval[];
}

export interface SlotQuery {
  eventType: EventType;
  durationMin: number;
  hosts: HostAvailabilityInput[];
  ownerTimezone: IanaZone;
  range: Interval;
  nowMs: number;
  index: BookingIndexEntry[];
  ignoreBookingId?: string;
}

/** hostIds: all for collective; the free ones for round robin */
export interface Slot {
  startMs: number;
  endMs: number;
  hostIds: string[];
}

export type SlotRejection = 'invalid_duration' | 'not_on_grid' | 'too_soon' | 'too_far' | 'outside_hours' | 'busy' | 'daily_limit';

export function scheduleWindows(schedule: Schedule, tz: IanaZone, range: Interval): Interval[] {
  throw new Error('not implemented');
}

export function computeSlots(q: SlotQuery): Slot[] {
  throw new Error('not implemented');
}

export function checkSlot(q: SlotQuery, startMs: number): { ok: true; hostIds: string[] } | { ok: false; reason: SlotRejection } {
  throw new Error('not implemented');
}

export function pickRoundRobinHost(candidateHostIds: string[], index: BookingIndexEntry[], nowMs: number): string {
  throw new Error('not implemented');
}
