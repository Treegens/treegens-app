/**
 * What leaves the server for the dashboard and the co-host page. Everything here is a view of
 * stored data with the secrets left behind: an AdminHost never carries a token hash, a sealed
 * refresh token or a calendar feed address, only the facts the screens need.
 */
import type { AdminBooking, AdminHost, Booking, Host, PublicHost, SiteSettings } from '../../../shared/types';
import { manageToken } from '../booking';
import type { Ctx } from '../ctx';
import { assetUrl } from '../repo';

export function toAdminHost(ctx: Ctx, host: Host): AdminHost {
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
    google: host.google
      ? {
          email: host.google.email,
          status: host.google.status,
          busyCalendarIds: [...(host.google.busyCalendarIds ?? [])],
          writeCalendarId: host.google.writeCalendarId,
          gmailSend: host.google.gmailSend === true,
        }
      : null,
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
