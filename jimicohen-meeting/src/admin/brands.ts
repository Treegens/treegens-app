/**
 * Brands and short links as the dashboard shows them: which link opens which event, in which look, and
 * the plain words for who it books. Pure helpers over the bootstrap data.
 */
import { BRAND_IDS, BUILTIN_BRANDS, isBrandId } from '../../shared/brands';
import { SHORT_LINKS, SHORT_LINK_NAMES, shortLabelOf, type ShortName } from '../../shared/shortLinks';
import type { AdminBootstrap, AdminHost, BrandId, EventType } from '../../shared/types';
import { APP_BASE } from '../lib/api';
import { firstName } from './format';

export interface ShortLinkRow {
  name: ShortName;
  /** "https://jimicohen.com/pod" */
  url: string;
  /** "jimicohen.com/pod" */
  label: string;
  /** what it opens now; null when it opens nothing (never set, turned off, its event deleted) */
  eventType: EventType | null;
  /** the look the link itself stands for (its preview): Eco Champions for /pod, null (the owner's own) for /meet */
  brandId: BrandId | null;
}

/** Every short link with what it opens, or null while the one-time setup has not filled them in yet. */
export function shortLinkRows(data: Pick<AdminBootstrap, 'shortLinks' | 'eventTypes' | 'publicUrl'>): ShortLinkRow[] | null {
  if (!data.shortLinks) return null;
  return SHORT_LINK_NAMES.map((name) => {
    const entry = data.shortLinks?.find((l) => l.name === name);
    const eventType = entry?.eventTypeId ? (data.eventTypes.find((e) => e.id === entry.eventTypeId) ?? null) : null;
    return { name, url: entry?.url ?? '', label: shortLabelOf(data.publicUrl, name), eventType, brandId: SHORT_LINKS[name].brandId };
  });
}

/** The short link that opens this event type, if any. */
export function shortLinkOf(data: Pick<AdminBootstrap, 'shortLinks' | 'eventTypes' | 'publicUrl'>, eventTypeId: string | null | undefined): ShortLinkRow | null {
  if (!eventTypeId) return null;
  return shortLinkRows(data)?.find((row) => row.eventType?.id === eventTypeId) ?? null;
}

/** The brand an event type shows, or null for the owner's own look. */
export function brandIdOf(et: Pick<EventType, 'brandId'> | null | undefined): BrandId | null {
  return isBrandId(et?.brandId) ? et.brandId : null;
}

export function brandName(id: string | null | undefined): string | null {
  return isBrandId(id) ? BUILTIN_BRANDS[id].name : null;
}

/** The brand's small built-in icon, a same-origin file. */
export function brandIconUrl(id: BrandId): string {
  return `${APP_BASE}/${BUILTIN_BRANDS[id].art.favicon}`;
}

export const BRAND_CHOICES = BRAND_IDS.map((id) => ({ id, name: BUILTIN_BRANDS[id].name }));

/** "Just you.", "You and Ian.", "You, Ian and Sam.": who a meeting books, as the owner reads it. */
export function whoItBooks(et: Pick<EventType, 'hostIds' | 'kind'>, hosts: AdminHost[], ownerId: string): string {
  const others = et.hostIds.filter((id) => id !== ownerId).map((id) => firstName(hosts.find((h) => h.id === id)?.name ?? 'someone'));
  const withOwner = et.hostIds.includes(ownerId);
  const names = [...(withOwner ? ['You'] : []), ...others];
  if (names.length === 1) return withOwner ? 'Just you.' : `Just ${names[0]}.`;
  const list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return et.kind === 'round_robin' ? `${list}, taking turns.` : `${list}.`;
}

/** Co-hosts on the team who are not on this meeting, in the order they joined. */
export function coHostsMissing(et: Pick<EventType, 'hostIds'>, hosts: AdminHost[]): AdminHost[] {
  return hosts.filter((h) => h.role === 'member' && !et.hostIds.includes(h.id));
}

/**
 * A joint meeting the owner made that /pod could open instead of the one the setup made (DESIGN 5.5): active,
 * joint, two or more hosts with the owner, no brand. The one with the most hosts, then the newest.
 */
export function podOffer(data: Pick<AdminBootstrap, 'shortLinks' | 'eventTypes' | 'publicUrl' | 'site'>): EventType | null {
  const pod = shortLinkRows(data)?.find((r) => r.name === 'pod');
  if (!pod?.eventType || pod.eventType.id !== 'evt_eco_champions') return null;
  const owner = data.site.ownerHostId;
  const candidates = data.eventTypes
    .filter((e) => e.id !== pod.eventType!.id && e.active && e.kind === 'collective' && e.hostIds.length >= 2 && e.hostIds.includes(owner) && !brandIdOf(e))
    .sort((a, b) => b.hostIds.length - a.hostIds.length || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

/** The delete dialog's words, with what happens to a short link that opens the event. */
export function deleteText(shortLabel: string | undefined): string {
  const base = 'Its link stops working straight away. Meetings that are already booked stay on your calendar.';
  return shortLabel ? `${base} ${shortLabel} will stop opening a meeting. You can point it at another one under Short links.` : base;
}
