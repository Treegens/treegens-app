import type { Booking } from './types';

/**
 * On a booking whose calendar work has not reached Google yet: put there by a cancellation until the event is
 * gone, and when Google is too slow to answer within a request (the work then finishes in the background).
 */
export const CALENDAR_PENDING = 'Google Calendar did not answer in time. Trying again shortly.';

/**
 * Why the Google event of a cancelled booking is still on a calendar, or null when it is not there any
 * more (or there never was one). Either the last try to remove it failed (the problem is on the record,
 * and a retry may be queued), or the calendar could not be reached any more (Google was disconnected:
 * the timeline says the event was left there). The server and the dashboard read it the same way.
 */
export function calendarEventLeft(b: Pick<Booking, 'status' | 'google' | 'timeline'>): string | null {
  if (b.status !== 'cancelled' || !b.google) return null;
  if (b.google.error) return b.google.error.trim() || 'Google Calendar could not be updated.';
  const last = [...(b.timeline ?? [])].reverse().find((t) => t.type === 'calendar_event_removed' || t.type === 'calendar_event_left');
  return last?.type === 'calendar_event_left' ? last.detail?.trim() || 'Google Calendar could not be reached.' : null;
}
