/**
 * Small text helpers shared by the public screens.
 */
import { UNKNOWN_SENDER_HINT } from '../../../shared/calendar';
import type { PublicBooking, PublicEventType, PublicHost } from '../../../shared/types';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
}

/**
 * The first host's first name, for "a note from Jimi". Without a host the page's own name stands in: cut to
 * its first word for the owner ("Jimi"), but whole for a brand, which is not a person ("Eco Champions", never "Eco").
 */
export function hostFirstName(hosts: { name: string }[], site: { profile: { name: string }; brand?: unknown }): string {
  if (hosts[0]?.name) return firstName(hosts[0].name);
  return site.brand ? site.profile.name.trim() : firstName(site.profile.name);
}

/**
 * Everyone the meeting is with, by first name, for "Let Jimi and Ian know": "Jimi", "Jimi and Ian", "Jimi, Ian
 * and Kim". A booking lists the hosts who join it (a round robin booking only the host it went to), and with one
 * host, or none, this is hostFirstName.
 */
export function hostsFirstNames(hosts: { name: string }[], site: { profile: { name: string }; brand?: unknown }): string {
  const names = hosts.map((h) => firstName(h.name)).filter(Boolean);
  return names.length > 1 ? joinNames(names) : hostFirstName(hosts, site);
}

/** "Jimi", "Jimi and Alex", "Jimi, Alex and Sam". */
export function joinNames(names: string[], conjunction: 'and' | 'or' = 'and'): string {
  const list = names.map((n) => n.trim()).filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  if (list.length === 2) return `${list[0]} ${conjunction} ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} ${conjunction} ${list[list.length - 1]}`;
}

/** Who the visitor meets: full names for one or two hosts, first names beyond that. */
export function hostNames(hosts: PublicHost[], kind: PublicEventType['kind'] = 'solo'): string {
  if (!hosts.length) return '';
  const conj = kind === 'round_robin' ? 'or' : 'and';
  if (hosts.length <= 2) return joinNames(hosts.map((h) => h.name), conj);
  return joinNames(hosts.map((h) => firstName(h.name)), conj);
}

/** Replaces {{variable}} placeholders. Unknown variables render empty, like the server does. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const p = new URL(value).protocol;
    return p === 'https:' || p === 'http:';
  } catch {
    return false;
  }
}

/** "example.com" from a URL, for "Taking you to example.com". */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Splits owner-written text into paragraphs on blank lines. Single line breaks are kept by CSS. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** "1 time", "3 times" */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What reaches the invitee. An answer without the flags (an older server, the design preview) promises both, as before. */
export function deliveryOf(booking: PublicBooking): { email: boolean; calendarInvite: boolean } {
  return booking.delivery ?? { email: true, calendarInvite: true };
}

/**
 * What is on its way to the invitee, from what really goes out: how the meeting gets into their calendar
 * (Google's invitation, or the one in our email), and the confirmation email.
 */
export function deliveryLine(booking: PublicBooking, moved: boolean): string {
  const { email, calendarInvite } = deliveryOf(booking);
  const to = booking.invitee.email;
  if (moved) {
    if (calendarInvite) return `Google Calendar is sending an updated invitation to ${to}, which moves the meeting in your calendar.`;
    if (email) return `An email with the new time and an updated calendar invitation is on its way to ${to}.`;
    return 'No email is sent about this change, so please update your calendar with the buttons below.';
  }
  if (calendarInvite) {
    const line = `This meeting is being added to your calendar with a Google Calendar invitation sent to ${to}.`;
    return email ? `${line} Your confirmation email is on its way there too.` : line;
  }
  if (email) return `A confirmation email with a calendar invitation is on its way to ${to}. Open the invitation to add the meeting to your calendar.`;
  return 'No confirmation email is sent for this booking, so please add it to your calendar with the buttons below.';
}

/** The one tap Google may ask for, shown only while Google is the one inviting them. */
export function calendarHint(booking: PublicBooking): string | null {
  return deliveryOf(booking).calendarInvite ? UNKNOWN_SENDER_HINT : null;
}

/**
 * The "add to calendar" buttons, and what they are for. While Google invites them, only the calendar file
 * (it has Google's UID, so it merges with the invitation) for people who do not use Google Calendar: "Add to
 * Google" or an Outlook link would make a second copy that never moves or goes away with the meeting. While
 * our email carries the invitation, the buttons are a second way. With neither, they are the way.
 */
export function calendarBlock(booking: PublicBooking): { label: string; fileOnly: boolean } {
  const { email, calendarInvite } = deliveryOf(booking);
  if (calendarInvite) return { label: 'Not using Google Calendar?', fileOnly: true };
  return { label: email ? 'Or add it yourself' : 'Add to your calendar', fileOnly: false };
}

/** On the booking page later: where the invitation went, when one did. */
export function calendarNote(booking: PublicBooking): string | null {
  const { email, calendarInvite } = deliveryOf(booking);
  const to = booking.invitee.email;
  if (calendarInvite) return `Google Calendar sent the invitation for this meeting to ${to}.`;
  if (email) return `The calendar invitation is in your confirmation email to ${to}.`;
  return null;
}

/** Stable 32 bit hash for deterministic preview data. */
export function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
