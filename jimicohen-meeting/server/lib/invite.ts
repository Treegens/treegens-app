/**
 * How the invitee's own calendar gets a meeting, decided once per booking and kept on it (Booking.inviteVia),
 * so that whatever happens later (Google connected, the event type's setting changed, a move, a cancellation)
 * the invitee keeps exactly one copy of the meeting:
 *
 *   google  Google Calendar invites them: they are an attendee on the Google event, Google sends the
 *           invitation, the updates and the cancellation. Our own emails then carry no calendar file, and a
 *           file we serve (the "calendar file" link) has Google's UID, so a calendar that takes both keeps one.
 *   file    Our own emails invite them (a REQUEST, later updates with the same UID, a CANCEL). The Google
 *           event, when there is one, holds the hosts only, so Google never sends them a second invitation.
 *
 * Whoever acts first decides, with a compare-and-swap on the booking: the calendar write just before it adds
 * the invitee to a new Google event, the invitee's first email that carries a calendar file just before it is
 * written. A booking that nothing has reached yet (no Google, and no email could go out) is not decided: when
 * Google is connected later, Google invites them.
 */
import type { Booking, EventType } from '../../shared/types';
import { sha256Hex } from './crypto';
import type { Ctx } from './ctx';
import { getBooking, updateBooking } from './repo';

export type InviteVia = NonNullable<Booking['inviteVia']>;

/**
 * Id of the Google event of a booking. The same as eventIdForBooking in google.ts: it lets a cancellation
 * remove an event whose creation timed out before its id could be stored, and gives our files Google's UID.
 */
export function calendarEventIdFor(bookingId: string): string {
  return `mtg${sha256Hex(bookingId).slice(0, 40)}`;
}

/** The UID (iCalUID) Google gives the event of a booking. A calendar file with it is the same meeting as Google's invitation. */
export function googleUidFor(bookingId: string): string {
  return `${calendarEventIdFor(bookingId)}@google.com`;
}

/**
 * Whether Google Calendar invites the invitee to this booking. A booking without a record (made before it
 * was kept, or not decided yet) reads the way it always did: the event type asks for Google's invitation
 * and the booking has, or is getting, a Google event.
 */
export function invitedByGoogle(b: Pick<Booking, 'inviteVia' | 'google'>, eventType: Pick<EventType, 'googleInvite'> | null): boolean {
  if (b.inviteVia === 'google' || b.inviteVia === 'file') return b.inviteVia === 'google';
  return eventType?.googleInvite !== false && !!b.google;
}

/**
 * Records how the invitee is invited, unless that is already recorded, and returns the booking as saved.
 * `decide` sees the booking as it is at that instant. A record already there always wins: the caller then
 * goes by it, whatever it would have chosen itself.
 */
export async function settleInvite(ctx: Ctx, bookingId: string, decide: (b: Booking) => InviteVia): Promise<Booking | null> {
  const current = await getBooking(ctx, bookingId);
  if (!current || current.inviteVia) return current;
  return updateBooking(ctx, bookingId, (b) => (b.inviteVia ? b : { ...b, inviteVia: decide(b) }));
}
