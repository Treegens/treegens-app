/**
 * What leaves the server for the dashboard and the co-host page. Everything here is a view of
 * stored data with the secrets left behind: an AdminHost never carries a token hash, a sealed
 * refresh token or a calendar feed address, only the facts the screens need.
 */
import type { AdminBooking, AdminGoogleAccount, AdminHost, Booking, Host, PublicHost, SiteSettings } from '../../../shared/types';
import { manageToken } from '../booking';
import type { Ctx } from '../ctx';
import { extrasOf, mainOf } from '../googleAccounts';
import { assetUrl, getCall } from '../repo';
import { callTranscript } from '../voice';

export function toAdminHost(ctx: Ctx, host: Host): AdminHost {
  const main = mainOf(host);
  const out: AdminHost = {
    id: host.id,
    role: host.role,
    name: host.name,
    email: host.email,
    title: host.title ?? '',
    avatarAssetId: host.avatarAssetId ?? null,
    avatarUrl: assetUrl(ctx, host.avatarAssetId),
    timezone: host.timezone,
    timezoneMode: host.timezoneMode,
    schedules: host.schedules,
    defaultScheduleId: host.defaultScheduleId,
    google: main
      ? {
          id: main.account.id,
          email: main.account.email,
          status: main.account.status,
          busyCalendarIds: [...main.account.busyCalendarIds],
          writeCalendarId: main.account.writeCalendarId,
          gmailSend: main.account.gmailSend === true,
          // A connection made while the consent screen is in "Testing" stops after 7 days: the screens warn ahead.
          ...(main.account.refreshExpiresAt ? { refreshExpiresAt: main.account.refreshExpiresAt } : {}),
          ...(main.account.connectedAt ? { connectedAt: main.account.connectedAt } : {}),
          health: main.account.health ?? null,
        }
      : null,
    // The other accounts: what the screens show, never the token, the scopes or Google's account id.
    googleExtra: extrasOf(host).map(({ account: a }): AdminGoogleAccount => ({
      id: a.id,
      email: a.email,
      status: a.status,
      busyCalendarIds: [...a.busyCalendarIds],
      connectedAt: a.connectedAt,
      ...(a.refreshExpiresAt ? { refreshExpiresAt: a.refreshExpiresAt } : {}),
      health: a.health ?? null,
    })),
    // The label only. The feed address is a secret (it usually contains a private key) and stays sealed.
    icsFeeds: (host.icsFeeds ?? []).map((feed) => ({ id: feed.id, label: feed.label })),
    hasInviteLink: typeof host.inviteTokenHash === 'string' && host.inviteTokenHash !== '',
    notify: { email: host.notify?.email !== false, sms: host.notify?.sms === true },
    calendarHealth: host.calendarHealth ?? null,
  };
  if (host.phone) out.phone = host.phone;
  return out;
}

export function toPublicHost(ctx: Ctx, host: Host): PublicHost {
  const out: PublicHost = { id: host.id, name: host.name, avatarUrl: assetUrl(ctx, host.avatarAssetId) };
  if (host.title) out.title = host.title;
  return out;
}

/** The page where a booking can be viewed, moved or cancelled. Safe for the host to forward to the invitee. */
export function manageUrlOf(ctx: Ctx, bookingId: string): string {
  return `${ctx.env.publicBaseUrl}/booking/${encodeURIComponent(bookingId)}?t=${encodeURIComponent(manageToken(ctx, bookingId))}`;
}

export function toAdminBooking(ctx: Ctx, booking: Booking, hostsById: Map<string, Host>): AdminBooking {
  const hosts = booking.hostIds.map((id) => hostsById.get(id)).filter((h): h is Host => !!h);
  return { ...booking, hosts: hosts.map((h) => toPublicHost(ctx, h)), manageUrl: manageUrlOf(ctx, booking.id) };
}

/** More calls than this on one booking are shown without their transcripts. */
const MAX_TRANSCRIPTS = 20;

/**
 * The view of one booking with the transcript of each reminder call attached to its timeline entry,
 * read from the call record while that record exists. The booking itself only stores the outcome and
 * the call id, so a transcript is gone once the call record is pruned (after 90 days, server/cron.ts).
 * A call record that cannot be read leaves its entry without a transcript.
 */
export async function withCallTranscripts(ctx: Ctx, booking: AdminBooking): Promise<AdminBooking> {
  const ids = [...new Set(booking.timeline.map((e) => e.callId).filter((id): id is string => typeof id === 'string' && id !== ''))].slice(0, MAX_TRANSCRIPTS);
  if (ids.length === 0) return booking;
  const transcripts = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      const call = await getCall(ctx, id).catch(() => null);
      // A record belongs to this booking only: a call id copied onto another booking shows nothing.
      if (!call || call.bookingId !== booking.id) return;
      const text = callTranscript(call);
      if (text) transcripts.set(id, text);
    }),
  );
  if (transcripts.size === 0) return booking;
  return {
    ...booking,
    timeline: booking.timeline.map((e) => {
      const transcript = e.callId ? transcripts.get(e.callId) : undefined;
      return transcript ? { ...e, transcript } : e;
    }),
  };
}

export function hostMap(hosts: Host[]): Map<string, Host> {
  return new Map(hosts.map((h) => [h.id, h]));
}

export function ownerOf(hosts: Host[], site: SiteSettings): Host | null {
  return hosts.find((h) => h.id === site.ownerHostId) ?? hosts.find((h) => h.role === 'owner') ?? null;
}

/** "AC12…cdef": enough to recognise an identifier, never enough to use it. */
export function maskMiddle(value: string, head = 4, tail = 4): string {
  const chars = Array.from(value);
  if (chars.length <= head + tail + 2) return '••••';
  return `${chars.slice(0, head).join('')}…${chars.slice(-tail).join('')}`;
}
