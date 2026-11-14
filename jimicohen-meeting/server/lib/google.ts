// STUB
import type { GoogleCalendarListItem, Host, IanaZone } from '../../shared/types';
import type { Ctx } from './ctx';
import type { Interval } from './time';

export const GOOGLE_CALENDAR_SCOPES: string[] = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];
export const GMAIL_SEND_SCOPE: string = 'https://www.googleapis.com/auth/gmail.send';

/** reconnect needed */
export class GoogleAuthError extends Error {}

export function googleRedirectUri(ctx: Ctx): string {
  throw new Error('not implemented');
}

export async function buildGoogleAuthUrl(ctx: Ctx, p: { hostId: string; returnTo: string; gmail?: boolean; loginHint?: string }): Promise<string> {
  throw new Error('not implemented');
}

export async function completeGoogleAuth(
  ctx: Ctx,
  params: URLSearchParams,
): Promise<{ ok: boolean; hostId?: string; returnTo: string; error?: string }> {
  throw new Error('not implemented');
}

export async function getGoogleAccessToken(ctx: Ctx, host: Host): Promise<string> {
  throw new Error('not implemented');
}

export async function googleFreeBusy(ctx: Ctx, host: Host, range: Interval): Promise<Interval[]> {
  throw new Error('not implemented');
}

export async function googleListCalendars(ctx: Ctx, host: Host): Promise<GoogleCalendarListItem[]> {
  throw new Error('not implemented');
}

export async function googleGetTimezone(ctx: Ctx, host: Host): Promise<IanaZone | null> {
  throw new Error('not implemented');
}

export interface CalendarEventInput {
  summary: string;
  description: string;
  startIso: string;
  endIso: string;
  timezone: IanaZone;
  attendees: { email: string; name?: string; accepted?: boolean }[];
  location?: string;
  createMeet: boolean;
  bookingId: string;
  notifyAttendees: boolean;
}

export async function googleCreateEvent(
  ctx: Ctx,
  host: Host,
  input: CalendarEventInput,
): Promise<{ eventId: string; calendarId: string; htmlLink?: string; meetUrl?: string }> {
  throw new Error('not implemented');
}

export async function googleUpdateEvent(ctx: Ctx, host: Host, calendarId: string, eventId: string, patch: Partial<CalendarEventInput>): Promise<void> {
  throw new Error('not implemented');
}

export async function googleDeleteEvent(ctx: Ctx, host: Host, calendarId: string, eventId: string, notifyAttendees: boolean): Promise<void> {
  throw new Error('not implemented');
}

export async function gmailSendRaw(ctx: Ctx, host: Host, rawMime: string): Promise<{ id: string }> {
  throw new Error('not implemented');
}

export async function disconnectGoogle(ctx: Ctx, hostId: string): Promise<void> {
  throw new Error('not implemented');
}
