/**
 * Builds the public view of the site from the dashboard bootstrap, so the design editor can
 * render the real booking widget with a draft theme without asking the server.
 */
import type { ThemeAssets } from '../../../../shared/theme';
import type { AdminBootstrap, AdminHost, EventType, LocationConfig, PublicEventType, PublicHost, PublicSite, Theme } from '../../../../shared/types';
import { assetUrl } from '../../../lib/api';

const LOCATION_LABELS: Record<LocationConfig['type'], string> = {
  google_meet: 'Google Meet',
  phone_host_calls: 'Phone call',
  phone_invitee_calls: 'Phone call',
  in_person: 'In person',
  custom_link: 'Video call',
  ask_invitee: 'Your choice',
};

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function toPublicHost(h: AdminHost): PublicHost {
  return { id: h.id, name: h.name, title: h.title || undefined, avatarUrl: h.avatarUrl };
}

function locationDetail(l: LocationConfig, lead: string): string | undefined {
  switch (l.type) {
    case 'google_meet':
      return 'You get the link when you book';
    case 'phone_host_calls':
      return `${lead} calls you`;
    case 'phone_invitee_calls':
      return l.value ? `You call ${l.value}` : `You call ${lead}`;
    case 'ask_invitee':
      return 'Tell us where suits you';
    default:
      return l.value || undefined;
  }
}

/** The invitee-facing shape of an event type, the same fields the API sends to the booking page. */
export function toPublicEventType(et: EventType, hosts: AdminHost[]): PublicEventType {
  const assigned = et.hostIds.map((id) => hosts.find((h) => h.id === id)).filter((h): h is AdminHost => !!h);
  const lead = firstNameOf(assigned[0]?.name ?? 'The host');
  return {
    id: et.id,
    slug: et.slug,
    title: et.title,
    description: et.description,
    emoji: et.emoji || undefined,
    color: et.color || undefined,
    coverUrl: assetUrl(et.coverAssetId),
    kind: et.kind,
    hosts: assigned.map(toPublicHost),
    durations: et.durations.slice(),
    defaultDuration: et.defaultDuration,
    locations: et.locations.map((l) => ({ type: l.type, label: l.label || LOCATION_LABELS[l.type] || 'Meeting', detail: locationDetail(l, lead) })),
    questions: et.questions,
    allowGuests: et.allowGuests,
    maxGuests: et.maxGuests,
    phone: et.phone,
    minNoticeMinutes: et.scheduling.minNoticeMinutes,
    maxDaysAhead: et.scheduling.maxDaysAhead,
    themeOverride: et.themeOverride ?? null,
  };
}

/** A stand-in event for accounts that have no event types yet, so the preview is never empty. */
export function sampleEventType(owner: AdminHost): PublicEventType {
  return {
    id: 'preview',
    slug: 'meeting',
    title: 'Meeting',
    description: 'This is a sample. Create an event type and it will show up here.',
    coverUrl: null,
    kind: 'solo',
    hosts: [toPublicHost(owner)],
    durations: [30, 45],
    defaultDuration: 30,
    locations: [{ type: 'google_meet', label: 'Google Meet', detail: 'You get the link when you book' }],
    questions: [{ id: 'q_topic', label: 'What would you like to talk about?', type: 'textarea', required: false }],
    allowGuests: true,
    maxGuests: 3,
    phone: 'optional',
    minNoticeMinutes: 240,
    maxDaysAhead: 60,
    themeOverride: null,
  };
}

/** Event types a visitor could open, listed ones first. */
export function previewEventTypes(data: AdminBootstrap, owner: AdminHost): PublicEventType[] {
  const active = data.eventTypes.filter((e) => e.active);
  const ordered = [...active.filter((e) => e.visibility === 'public'), ...active.filter((e) => e.visibility !== 'public')];
  const list = ordered.map((e) => toPublicEventType(e, data.hosts));
  return list.length ? list : [sampleEventType(owner)];
}

/** PublicSite as the booking page would receive it, with `theme` swapped for the draft. */
export function toPreviewSite(data: AdminBootstrap, owner: AdminHost, theme: Theme, assets: ThemeAssets, eventTypes: PublicEventType[]): PublicSite {
  const { site, integrations } = data;
  return {
    profile: {
      name: site.profile.name,
      headline: site.profile.headline,
      welcome: site.profile.welcome,
      avatarUrl: owner.avatarUrl,
      links: site.profile.links,
    },
    theme,
    themeAssets: assets,
    eventTypes: eventTypes.filter((e) => e.id !== 'preview'),
    booking: site.booking,
    assistantName: site.assistant.name,
    features: { sms: integrations.twilio.configured, calls: integrations.twilio.configured },
    ownerTimezone: owner.timezone,
  };
}
