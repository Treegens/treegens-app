/**
 * Small text helpers shared by the public screens.
 */
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

/** One sentence on what is on its way to the invitee, from what really goes out. */
export function deliveryLine(booking: PublicBooking, moved: boolean): string {
  const { email, calendarInvite } = deliveryOf(booking);
  const to = booking.invitee.email;
  if (moved) {
    if (calendarInvite) return `An updated invitation is on its way to ${to}.`;
    if (email) return `An email with the new time is on its way to ${to}.`;
    return 'No email is sent about this change, so please update your calendar with the buttons below.';
  }
  if (email && calendarInvite) return `A confirmation email and a calendar invitation are on their way to ${to}.`;
  if (email) return `A confirmation email is on its way to ${to}.`;
  if (calendarInvite) return `A calendar invitation is on its way to ${to}.`;
  return 'No confirmation email is sent for this booking, so please add it to your calendar with the buttons below.';
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
