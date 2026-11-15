/**
 * Calendar files (RFC 5545) and "add to calendar" links for a booking. Pure functions: no
 * clock, no network. Times are always written in UTC, so no VTIMEZONE block is needed.
 */
import type { Booking, Host, SiteSettings } from '../../shared/types';
import { joinNames } from './templates';
import { isEmail } from './validate';

type IcsMethod = 'REQUEST' | 'CANCEL' | 'PUBLISH';

// ───────────────────────── formatting primitives ─────────────────────────

/** 20261117T203000Z */
function utcStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid date in booking: ${String(iso)}`);
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** TEXT value escaping (RFC 5545 3.3.11): backslash, semicolon, comma and line breaks. */
export function escapeIcsText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n|\r|\n/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Parameter value (CN=...): always quoted, so it must not contain quotes, control characters or line breaks. */
function quotedParam(value: unknown): string {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return `"${cleaned}"`;
}

/** Folds one content line at 75 octets without splitting a UTF-8 character; continuation lines start with a space. */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > 75) {
      out.push(current);
      current = ` ${ch}`;
      bytes = 1 + size;
    } else {
      current += ch;
      bytes += size;
    }
  }
  out.push(current);
  return out.join('\r\n');
}

function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || 'meeting.invalid';
  } catch {
    return 'meeting.invalid';
  }
}

function webUrl(value: unknown): string | null {
  if (typeof value !== 'string' || /[\s\u0000-\u001F\u007F]/.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

// ───────────────────────── what the event says ─────────────────────────

function assigned(booking: Booking, hosts: Host[]): Host[] {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const list = booking.hostIds.map((id) => byId.get(id)).filter((h): h is Host => !!h);
  return list.length > 0 ? list : hosts.slice(0, 1);
}

function summaryOf(booking: Booking, hosts: Host[]): string {
  const people = joinNames([booking.invitee.name, ...hosts.map((h) => h.name)]);
  return people ? `${booking.eventTitle}: ${people}` : booking.eventTitle;
}

function joinUrlOf(booking: Booking): string | null {
  return webUrl(booking.location?.joinUrl) ?? webUrl(booking.google?.meetUrl);
}

function locationOf(booking: Booking): string {
  const join = joinUrlOf(booking);
  if (join) return join;
  const label = (booking.location?.label ?? '').trim();
  const value = (booking.location?.value ?? '').trim();
  if (booking.location?.type === 'in_person' && value) return value;
  return value && value !== label ? [label, value].filter(Boolean).join(': ') : label;
}

/** `brandLine`: "Booked through Eco Champions: https://jimicohen.com/pod" for a booking made under a brand, last. */
function descriptionOf(booking: Booking, hosts: Host[], manageUrl: string | null, cancelled: boolean, brandLine?: string | null): string {
  const withHosts = joinNames(hosts.map((h) => h.name));
  const lines = [cancelled ? 'This meeting was cancelled.' : `${booking.eventTitle}${withHosts ? ` with ${withHosts}` : ''}.`];
  const join = joinUrlOf(booking);
  if (!cancelled && join) lines.push(`Join: ${join}`);
  if (!cancelled && manageUrl) lines.push(`Reschedule or cancel: ${manageUrl}`);
  if (brandLine) lines.push(brandLine);
  return lines.join('\n');
}

// ───────────────────────── calendar file ─────────────────────────

/**
 * One VEVENT for the booking.
 *   REQUEST  an invitation the mail client offers to add (organizer + attendees)
 *   PUBLISH  a plain event file with no attendees, used when Google already sent the real invitation
 *   CANCEL   withdraws an earlier REQUEST with the same UID
 * A REQUEST needs an organizer address; when no host has one the file is written as PUBLISH instead.
 */
export function buildBookingIcs(p: {
  booking: Booking;
  hosts: Host[];
  site: SiteSettings;
  method: IcsMethod;
  baseUrl: string;
  /** manage link written into the description and used as the event URL when there is no video link */
  manageUrl?: string | null;
  /** the brand line of a booking made under a brand (booking.ts brandLineFor), written last in the description */
  brandLine?: string | null;
}): string {
  const { booking, site } = p;
  const hosts = assigned(booking, p.hosts ?? []);
  const organizerHost = hosts.find((h) => isEmail(h.email)) ?? null;
  const organizerEmail = organizerHost?.email ?? [site.email?.replyTo, site.email?.fromEmail].find((e) => isEmail(e)) ?? null;
  const organizerName = organizerHost?.name ?? site.email?.fromName ?? site.profile?.name ?? '';

  let method: IcsMethod = p.method === 'REQUEST' || p.method === 'CANCEL' ? p.method : 'PUBLISH';
  if (method === 'REQUEST' && !organizerEmail) method = 'PUBLISH';
  const cancelled = method === 'CANCEL' || booking.status === 'cancelled';
  const manageUrl = webUrl(p.manageUrl);
  const domain = hostnameOf(p.baseUrl);
  const location = locationOf(booking);
  const eventUrl = joinUrlOf(booking) ?? manageUrl;
  // DTSTAMP is when this version of the event came about: the booking, its last move or its cancellation.
  // Not `updatedAt`, which every timeline note changes: the file has to stay byte-identical across
  // retries of one email, or the provider refuses the repeat as a different message.
  const changes = (booking.timeline ?? []).filter((t) => (t.type === 'created' || t.type === 'rescheduled' || t.type === 'cancelled') && Number.isFinite(Date.parse(t.at)));
  const stampedAt = changes.length > 0 ? changes[changes.length - 1].at : booking.createdAt || booking.start;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${escapeIcsText(domain)}//Meeting scheduler//EN`,
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(booking.id)}@${escapeIcsText(domain)}`,
    `DTSTAMP:${utcStamp(Number.isFinite(Date.parse(stampedAt)) ? stampedAt : booking.start)}`,
    `DTSTART:${utcStamp(booking.start)}`,
    `DTEND:${utcStamp(booking.end)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(Number(booking.rescheduleCount) || 0))}`,
    `SUMMARY:${escapeIcsText(summaryOf(booking, hosts))}`,
    `DESCRIPTION:${escapeIcsText(descriptionOf(booking, hosts, manageUrl, cancelled, p.brandLine))}`,
  ];
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
  if (eventUrl) lines.push(`URL:${eventUrl}`);
  lines.push(`STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:OPAQUE');
  if (organizerEmail) lines.push(`ORGANIZER;CN=${quotedParam(organizerName)}:mailto:${organizerEmail}`);

  if (method !== 'PUBLISH') {
    const seen = new Set<string>();
    const attendee = (name: string, email: string, accepted: boolean) => {
      const key = email.toLowerCase();
      if (!isEmail(email) || seen.has(key)) return;
      seen.add(key);
      const status = accepted ? 'PARTSTAT=ACCEPTED;RSVP=FALSE' : 'PARTSTAT=NEEDS-ACTION;RSVP=TRUE';
      lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;${status};CN=${quotedParam(name || email)}:mailto:${email}`);
    };
    attendee(booking.invitee.name, booking.invitee.email, true);
    for (const host of hosts) attendee(host.name, host.email, true);
    for (const guest of booking.guests ?? []) attendee(guest, guest, false);
  }
  if (!cancelled) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeIcsText(booking.eventTitle)}`, 'TRIGGER:-PT15M', 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

// ───────────────────────── add-to-calendar links ─────────────────────────

/**
 * "Add to calendar" links. `outlook` is Outlook.com (personal Microsoft accounts); `office365` is the
 * same compose link on Microsoft 365, for work and school calendars, which outlook.live.com sends to
 * a personal sign-in page instead.
 */
export function calendarLinks(p: { booking: Booking; hosts: Host[]; baseUrl: string; manageToken: string; brandLine?: string | null }): {
  google: string;
  outlook: string;
  office365: string;
  ics: string;
} {
  const { booking } = p;
  const base = p.baseUrl.replace(/\/+$/, '');
  const id = encodeURIComponent(booking.id);
  const token = encodeURIComponent(p.manageToken);
  const hosts = assigned(booking, p.hosts ?? []);
  const title = summaryOf(booking, hosts);
  const details = descriptionOf(booking, hosts, `${base}/booking/${id}?t=${token}`, false, p.brandLine);
  const location = locationOf(booking);

  const google = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${utcStamp(booking.start)}/${utcStamp(booking.end)}`,
    details,
  });
  if (location) google.set('location', location);

  const outlook = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: title,
    startdt: new Date(Date.parse(booking.start)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    enddt: new Date(Date.parse(booking.end)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    body: details,
  });
  if (location) outlook.set('location', location);

  // Outlook reads "+" as a literal plus sign, so spaces are written as %20 (a real "+" is already %2B).
  const query = (params: URLSearchParams) => params.toString().replace(/\+/g, '%20');
  return {
    google: `https://calendar.google.com/calendar/render?${query(google)}`,
    outlook: `https://outlook.live.com/calendar/0/action/compose?${query(outlook)}`,
    office365: `https://outlook.office.com/calendar/0/action/compose?${query(outlook)}`,
    ics: `${base}/api/public/bookings/${id}/ics?t=${token}`,
  };
}
