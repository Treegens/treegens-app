import type { Booking } from './types';

/**
 * The one tap Google may ask for before its invitation shows in someone's calendar. Whether an invitation is
 * added by itself is their own "Add invitations to my calendar" setting, and the usual one holds back an
 * invitation from someone they have not been in touch with ("Unknown sender") until they say they know them.
 */
export const UNKNOWN_SENDER_HINT = 'Don\'t see it in your calendar? If the invitation says it is from an unknown sender, tap "I know the sender", then Yes.';

/**
 * Google said when a connection was made that it ends on a set day (refreshExpiresAt), and that day has come.
 * Google ends connections like that while the consent screen is still in "Testing" (after 7 days), or when a
 * time limit was picked on its screen.
 */
export function endedOnItsDay(account: { refreshExpiresAt?: string } | null | undefined, nowMs: number): boolean {
  const ends = Date.parse(account?.refreshExpiresAt ?? '');
  return Number.isFinite(ends) && ends <= nowMs;
}

/**
 * What to do about a connection Google ended on its day (`day` already written out), for the owner, or about
 * a co-host (`first`). The owner publishes the app either way: it is the owner's Google Cloud project.
 */
export function testingEndedAdvice(day: string, who: { first?: string } = {}): string {
  const connected = who.first ? `${who.first} connected` : 'you connected';
  const then = who.first ? `then ask ${who.first} to connect again from their private link` : 'then reconnect';
  return `Google ended it on ${day}, as it said it would when ${connected}. That usually means your Google Cloud app is still in Testing, where a connection lasts 7 days: publish it (Audience, then Publish app, so it reads In production), ${then}. Reconnecting without publishing only lasts another 7 days.`;
}

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
  // Its event is in a Google account that is gone: nothing can take it off that calendar any more.
  if (b.google.detached) return b.google.eventId ? detachedReason(b) : null;
  if (b.google.error) return b.google.error.trim() || 'Google Calendar could not be updated.';
  const last = [...(b.timeline ?? [])].reverse().find((t) => t.type === 'calendar_event_removed' || t.type === 'calendar_event_left');
  return last?.type === 'calendar_event_left' ? last.detail?.trim() || 'Google Calendar could not be reached.' : null;
}

/** What the dashboard says about a booking whose event is in a Google account that is no longer connected. */
export function detachedReason(b: Pick<Booking, 'google' | 'timeline'>): string {
  const email = b.google?.accountEmail;
  return email
    ? `The event was in ${email}, which is no longer connected. Change or delete it in Google Calendar.`
    : 'The event is in a Google account that is no longer connected. Change or delete it in Google Calendar.';
}
