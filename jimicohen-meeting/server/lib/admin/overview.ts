/**
 * The dashboard's home screen: what is coming up, a few honest numbers, what is left to set
 * up, and warnings about things that are quietly not working.
 *
 * Links are routes inside the app ("/admin/integrations#google"): the dashboard router adds
 * the mount path itself.
 */
import { DEFAULT_THEME } from '../../../shared/defaults';
import type { AdminOverview, EventType, Host, IntegrationsStatus, SiteSettings } from '../../../shared/types';
import type { Ctx } from '../ctx';
import { getBookingIndex, getBookings, getSite, listEventTypes, listHosts } from '../repo';
import { firstName, joinNames } from '../templates';
import { twilioFeatures } from '../twilio';
import { integrationsStatus } from './integrations';
import { hostMap, ownerOf, toAdminBooking } from './view';

const DAY_MS = 86_400_000;
const UPCOMING_SHOWN = 8;
/** Bookings read in full for the numbers. Far more than one person's month of meetings. */
const MAX_BOOKINGS_FOR_STATS = 400;

const LINK = {
  google: '/admin/integrations#google',
  email: '/admin/integrations#email',
  twilio: '/admin/integrations#twilio',
  assistant: '/admin/integrations#assistant',
  availability: '/admin/availability',
  events: '/admin/event-types',
  design: '/admin/design',
  team: '/admin/team',
};

function hasHours(host: Host | null): boolean {
  if (!host) return false;
  const schedule = host.schedules.find((s) => s.id === host.defaultScheduleId) ?? host.schedules[0];
  return !!schedule && Object.values(schedule.weekly ?? {}).some((ranges) => Array.isArray(ranges) && ranges.length > 0);
}

function hasCalendar(host: Host): boolean {
  return !!host.google || (host.icsFeeds ?? []).length > 0;
}

function madeTheirOwn(site: SiteSettings): boolean {
  const theme = site.theme;
  return (
    theme.preset !== DEFAULT_THEME.preset ||
    theme.colors?.primary?.toLowerCase() !== DEFAULT_THEME.colors.primary.toLowerCase() ||
    !!theme.logoAssetId ||
    !!theme.coverAssetId ||
    !!site.profile.avatarAssetId
  );
}

function quoted(titles: string[]): string {
  const shown = titles.slice(0, 3).map((t) => `"${t}"`);
  const rest = titles.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : joinNames(shown);
}

export function buildChecklist(p: { site: SiteSettings; owner: Host | null; eventTypes: EventType[]; integrations: IntegrationsStatus }): AdminOverview['checklist'] {
  const { site, owner, eventTypes, integrations } = p;
  return [
    { key: 'google', label: 'Connect your Google Calendar', done: owner?.google?.status === 'ok', href: LINK.google },
    { key: 'availability', label: 'Set your weekly hours', done: hasHours(owner), href: LINK.availability },
    { key: 'event', label: 'Create your first event type', done: eventTypes.some((e) => e.active), href: LINK.events },
    { key: 'email', label: 'Choose how emails are sent', done: integrations.email.resolved !== 'none', href: LINK.email },
    { key: 'sms', label: 'Add Twilio for texts and reminder calls', done: integrations.twilio.configured, href: LINK.twilio },
    { key: 'assistant', label: 'Add an Anthropic key for the voice assistant', done: integrations.anthropic.configured, href: LINK.assistant },
    { key: 'design', label: 'Make the booking page yours', done: madeTheirOwn(site), href: LINK.design },
  ];
}

export function buildWarnings(
  ctx: Ctx,
  p: { site: SiteSettings; hosts: Host[]; owner: Host | null; eventTypes: EventType[]; integrations: IntegrationsStatus; features: { sms: boolean; calls: boolean } },
): AdminOverview['warnings'] {
  const { site, hosts, owner, eventTypes, integrations, features } = p;
  const warnings: AdminOverview['warnings'] = [];
  const active = eventTypes.filter((e) => e.active);

  // The address every link in an email or a text is built from.
  const base = ctx.env.publicBaseUrl ?? '';
  let baseHost = '';
  try {
    baseHost = new URL(base).hostname;
  } catch {
    baseHost = '';
  }
  if (baseHost === '' || (!ctx.env.mockProviders && !base.startsWith('https://'))) {
    warnings.push({ key: 'public_base_url', message: 'This site does not know its public address, so links in emails and texts may not work. Set PUBLIC_BASE_URL in the deployment settings.' });
  } else if (baseHost.endsWith('.netlify.app')) {
    warnings.push({
      key: 'public_base_url',
      message: `Links in emails and texts point to ${baseHost}. If people reach your booking page through your own domain, set PUBLIC_BASE_URL to that address in the deployment settings.`,
    });
  }

  if (owner && !hasCalendar(owner)) {
    warnings.push({ key: 'google_not_connected', message: 'Your calendar is not connected yet, so your busy times are not checked and bookings are not added to it.', href: LINK.google });
  }

  for (const host of hosts) {
    const mine = host.id === owner?.id;
    const first = firstName(host.name) || 'A co-host';
    if (host.google?.status === 'needs_reconnect') {
      warnings.push(
        mine
          ? { key: `google_reconnect_${host.id}`, message: 'Your Google Calendar needs to be reconnected. Until then, new bookings are not reaching it.', href: LINK.google }
          : { key: `google_reconnect_${host.id}`, message: `${first}'s Google Calendar needs to be reconnected. Ask them to open their private link and connect again.`, href: LINK.team },
      );
    } else if (host.calendarHealth && host.calendarHealth.ok === false) {
      const reason = (host.calendarHealth.message ?? '').trim();
      const what = mine ? 'Your calendar could not be read' : `${first}'s calendar could not be read`;
      const effect = mine ? 'so times are not being offered until this is fixed.' : `so times that include ${first} are not being offered until this is fixed.`;
      warnings.push({ key: `calendar_health_${host.id}`, message: `${what}, ${effect}${reason ? ` ${reason}` : ''}`, href: mine ? LINK.google : LINK.team });
    }
  }

  if (integrations.email.resolved === 'none' && site.email.provider !== 'none') {
    warnings.push({ key: 'no_email', message: 'No email provider is set up, so confirmations and reminders are not being emailed.', href: LINK.email });
  }

  const needsTwilio = active.filter((e) => e.reminders.some((r) => r.enabled && ((r.channel === 'sms' && !features.sms) || (r.channel === 'call' && !features.calls))));
  if (needsTwilio.length > 0) {
    warnings.push({
      key: 'twilio_missing',
      message: `${quoted(needsTwilio.map((e) => e.title))} ${needsTwilio.length === 1 ? 'has' : 'have'} reminders by text or phone call, but Twilio is not connected, so those reminders are skipped.`,
      href: LINK.twilio,
    });
  }

  const byId = hostMap(hosts);
  for (const event of active) {
    if (event.kind !== 'collective') continue;
    const waiting = event.hostIds
      .map((id) => byId.get(id))
      .filter((h): h is Host => !!h && h.id !== owner?.id && !hasCalendar(h));
    if (waiting.length === 0) continue;
    const names = joinNames(waiting.map((h) => firstName(h.name) || h.name));
    warnings.push({
      key: `cohost_calendar_${event.id}`,
      message: `"${event.title}" books ${names} too, but ${names} ${waiting.length === 1 ? 'has' : 'have'} not connected a calendar yet. Only their weekly hours are checked until they do.`,
      href: LINK.team,
    });
  }
  return warnings;
}

/** GET /admin/overview */
export async function buildOverview(ctx: Ctx): Promise<AdminOverview> {
  const nowMs = ctx.now().getTime();
  const monthAgo = nowMs - 30 * DAY_MS;
  const [site, hosts, eventTypes, index, features] = await Promise.all([getSite(ctx), listHosts(ctx), listEventTypes(ctx), getBookingIndex(ctx), twilioFeatures(ctx)]);
  const integrations = await integrationsStatus(ctx, { site, hosts });
  const owner = ownerOf(hosts, site);
  const byId = hostMap(hosts);

  const upcoming = index
    .filter((entry) => entry.status === 'confirmed' && Date.parse(entry.end) > nowMs)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));

  // Anything booked or cancelled in the last 30 days starts after that point, so these are the only records worth reading.
  const recentIds = index
    .filter((entry) => Date.parse(entry.start) >= monthAgo)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, MAX_BOOKINGS_FOR_STATS)
    .map((entry) => entry.id);
  const recent = await getBookings(ctx, recentIds);
  const recentById = new Map(recent.map((b) => [b.id, b]));
  const nextUp = upcoming.slice(0, UPCOMING_SHOWN).map((entry) => entry.id);
  const missing = nextUp.filter((id) => !recentById.has(id));
  for (const booking of missing.length > 0 ? await getBookings(ctx, missing) : []) recentById.set(booking.id, booking);

  return {
    upcoming: nextUp
      .map((id) => recentById.get(id))
      .filter((b): b is NonNullable<typeof b> => !!b)
      .map((b) => toAdminBooking(ctx, b, byId)),
    stats: {
      upcomingCount: upcoming.length,
      last30Count: recent.filter((b) => Date.parse(b.createdAt) >= monthAgo).length,
      cancelledLast30: recent.filter((b) => b.status === 'cancelled' && Date.parse(b.cancellation?.at ?? '') >= monthAgo).length,
      confirmedByAssistant: recent.filter((b) => b.attendance?.confirmedVia === 'call').length,
    },
    checklist: buildChecklist({ site, owner, eventTypes, integrations }),
    warnings: buildWarnings(ctx, { site, hosts, owner, eventTypes, integrations, features }),
    publicUrl: ctx.env.publicBaseUrl,
  };
}
