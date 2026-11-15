/**
 * The dashboard's home screen: what is coming up, a few honest numbers, what is left to set
 * up, and warnings about things that are quietly not working.
 *
 * Links are routes inside the app ("/admin/integrations#google"): the dashboard router adds
 * the mount path itself.
 */
import { DEFAULT_THEME } from '../../../shared/defaults';
import type { AdminOverview, EventType, Host, IntegrationsStatus, SharedHoursCheck, SiteSettings } from '../../../shared/types';
import type { Ctx } from '../ctx';
import { getBookingIndex, getBookings, getSite, listEventTypes, listHosts } from '../repo';
import { computeSlots } from '../slots';
import { firstName, joinNames } from '../templates';
import { formatInZone, type Interval, isValidZone, zonedToUtcMs } from '../time';
import { twilioFeatures } from '../twilio';
import { isEmail } from '../validate';
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
  /** the "Send my booking notices to" field on the Settings page */
  notices: '/admin/settings#notices',
};

// ───────────────────────── joint meetings: do the hours ever line up? ─────────────────────────

/** The hours check walks the bookable days this many at a time and stops at the first time that works. */
const HOURS_CHECK_STEP_DAYS = 14;
/** The longest booking window an event type can have. */
const HOURS_CHECK_MAX_DAYS = 730;
/** A length short enough to fit any shared working time: it tells "never at the same time" from "never for long enough". */
const SHORTEST_PROBE_MIN = 15;

/** "America/Los_Angeles" → "Los Angeles" */
function zoneCity(zone: string): string {
  if (zone === 'UTC' || zone === 'Etc/UTC' || zone === 'GMT') return 'UTC';
  return (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The days an event type can be booked on, from now: its fixed dates when it has them, otherwise its rolling window. */
function bookableSpan(eventType: EventType, ownerTimezone: string, nowMs: number): Interval | null {
  const limit = nowMs + HOURS_CHECK_MAX_DAYS * DAY_MS;
  const dates = eventType.scheduling?.dateRange;
  if (dates) {
    const span = { start: Math.max(nowMs, zonedToUtcMs(dates.start, '00:00', ownerTimezone)), end: Math.min(limit, zonedToUtcMs(dates.end, '24:00', ownerTimezone)) };
    return span.end > span.start ? span : null;
  }
  const maxDays = eventType.scheduling?.maxDaysAhead;
  const days = Number.isFinite(maxDays) ? Math.min(Math.max(1, Math.ceil(maxDays)), HOURS_CHECK_MAX_DAYS) : HOURS_CHECK_MAX_DAYS;
  return { start: nowMs, end: nowMs + days * DAY_MS };
}

/**
 * Whether the slot engine would offer this event type at any moment of `span` if every calendar
 * were empty and nothing were booked. That leaves working hours (each host's schedule for this
 * event, date overrides, the event's own limited hours) as the only thing that can say no.
 */
function hasWorkingTime(eventType: EventType, hosts: Host[], ownerTimezone: string, span: Interval, nowMs: number): boolean {
  if (!Array.isArray(eventType.durations) || eventType.durations.length === 0) return true;
  // The shortest length on offer: when that fits nowhere, nothing does.
  const durationMin = Math.min(...eventType.durations);
  // Notice and the rolling window say when a time can be booked, not whether the hours line up. With
  // fixed dates the window must not hide them either: they may simply not have come into reach yet.
  const probe: EventType = { ...eventType, scheduling: { ...eventType.scheduling, minNoticeMinutes: 0, maxDaysAhead: HOURS_CHECK_MAX_DAYS + 1 } };
  const inputs = hosts.map((host) => ({ host, busy: [] }));
  const stepMs = HOURS_CHECK_STEP_DAYS * DAY_MS;
  for (let start = span.start; start < span.end; start += stepMs) {
    const range = { start, end: Math.min(start + stepMs, span.end) };
    if (computeSlots({ eventType: probe, durationMin, hosts: inputs, ownerTimezone, range, nowMs, index: [] }).length > 0) return true;
  }
  return false;
}

/**
 * For a joint ("together") meeting: is there any time when all of its hosts are working? Two
 * people on the default 9 to 5, eight or more hours apart, never are, and the booking page then
 * has nothing to offer however empty their calendars. Every other kind of meeting passes.
 *
 * The answer comes from the same slot engine the booking page uses, so the hosts' schedules for
 * this event, date overrides and the event's limited hours all count.
 */
export function checkSharedHours(p: { eventType: EventType; hosts: Host[]; owner: Host | null; nowMs: number }): SharedHoursCheck {
  const { eventType, owner, nowMs } = p;
  if (eventType.kind !== 'collective') return { ok: true };
  const byId = hostMap(p.hosts);
  const found = [...new Set(eventType.hostIds ?? [])].map((id) => byId.get(id));
  // Someone who is no longer on the team is another problem, and the editor already reports it.
  if (found.length < 2 || found.some((h) => !h)) return { ok: true };
  const hosts = found as Host[];
  const ownerTimezone = owner && isValidZone(owner.timezone) ? owner.timezone : 'UTC';

  let span: Interval | null;
  let idle: Host[];
  let tooShort = false;
  const shortest = Array.isArray(eventType.durations) && eventType.durations.length > 0 ? Math.min(...eventType.durations) : 0;
  try {
    span = bookableSpan(eventType, ownerTimezone, nowMs);
    // Dates that have passed leave nothing to check.
    if (!span) return { ok: true };
    const days = span;
    if (hasWorkingTime(eventType, hosts, ownerTimezone, days, nowMs)) return { ok: true };
    // Nobody can book it. Is that because the hours never meet, or because someone has none at all?
    idle = hosts.filter((host) => !hasWorkingTime({ ...eventType, kind: 'solo', hostIds: [host.id] }, [host], ownerTimezone, days, nowMs));
    // Or do they meet, only never for as long as the shortest length on offer?
    if (idle.length === 0 && shortest > SHORTEST_PROBE_MIN) {
      tooShort = hasWorkingTime({ ...eventType, durations: [SHORTEST_PROBE_MIN], defaultDuration: SHORTEST_PROBE_MIN }, hosts, ownerTimezone, days, nowMs);
    }
  } catch {
    // A check that cannot run has nothing to say. The booking page reports its own problems.
    return { ok: true };
  }

  const isOwner = (host: Host): boolean => host.id === owner?.id;
  const called = (host: Host): string => (isOwner(host) ? 'you' : firstName(host.name) || host.name || 'a co-host');
  const others = hosts.filter((host) => !isOwner(host));
  const pages = (count: number): string => (count === 1 ? 'private page' : 'private pages');
  // What else on the event narrows the time: its limited hours, and its fixed dates.
  const narrowing = [eventType.scheduling?.restrictHours ? 'limited hours' : '', eventType.scheduling?.dateRange ? 'dates' : ''].filter(Boolean);
  const limited = narrowing.length > 0 ? ` The ${narrowing.join(' and ')} on its Scheduling tab count too.` : '';

  if (idle.length > 0) {
    const mine = idle.some(isOwner);
    const theirs = idle.filter((host) => !isOwner(host));
    const days = Math.round((span.end - span.start) / DAY_MS);
    const when = eventType.scheduling?.dateRange ? 'on the dates it can be booked' : days === 1 ? 'in the next day' : `in the next ${days} days`;
    const fix =
      mine && theirs.length > 0
        ? `Set your hours under Availability, and ask ${joinNames(theirs.map(called))} to set theirs on their ${pages(theirs.length)}.`
        : mine
          ? 'Set your hours under Availability.'
          : `Ask ${joinNames(theirs.map(called))} to set their hours on their ${pages(theirs.length)}.`;
    return {
      ok: false,
      reason: 'no_hours',
      message: `"${eventType.title}" cannot be booked: ${joinNames(idle.map(called))} ${idle.length === 1 && !mine ? 'has' : 'have'} no working hours for it ${when}. ${fix}${limited}`,
      href: mine ? LINK.availability : LINK.team,
    };
  }

  const sameZone = hosts.every((host) => host.timezone === hosts[0].timezone);
  const zones = sameZone ? '' : ` ${capitalised(joinNames(hosts.map((host) => `${isOwner(host) ? 'your' : `${called(host)}'s`} hours are in ${zoneCity(host.timezone)} time`)))}.`;
  const withOwner = hosts.some(isOwner);
  const fix = withOwner
    ? `Change your hours under Availability, or ask ${joinNames(others.map(called))} to change theirs on their ${pages(others.length)}.`
    : `Ask ${joinNames(others.map(called))} to change their hours on their ${pages(others.length)}.`;
  const together = `${joinNames(hosts.map(called))} are ${hosts.length === 2 ? 'both' : 'all'} working`;
  const cause = tooShort
    ? `the times when ${together} are never as long as its shortest length, ${lengthText(shortest)}.`
    : `there is no time when ${together}.`;
  return {
    ok: false,
    reason: 'no_overlap',
    message: `"${eventType.title}" cannot be booked: ${cause}${zones} ${fix}${limited}`,
    href: withOwner ? LINK.availability : LINK.team,
  };
}

/** 90 → "90 minutes", 120 → "2 hours" */
function lengthText(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

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
    // A connection only works while the Google keys it was made with are there.
    { key: 'google', label: 'Connect your Google Calendar', done: owner?.google?.status === 'ok' && integrations.google.configured, href: LINK.google },
    { key: 'availability', label: 'Set your weekly hours', done: hasHours(owner), href: LINK.availability },
    { key: 'event', label: 'Create your first event type', done: eventTypes.some((e) => e.active), href: LINK.events },
    { key: 'email', label: 'Choose how emails are sent', done: integrations.email.resolved !== 'none', href: LINK.email },
    // Texts and calls: a Messaging Service alone sends texts but cannot place a call.
    { key: 'sms', label: 'Add Twilio for texts and reminder calls', done: integrations.twilio.configured && integrations.twilio.calls !== false, href: LINK.twilio },
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

  // Gmail sends through the owner's Google connection: when that is down, so is email.
  const gmailProblem = integrations.email.gmailProblem;
  const noGmail = ' No emails are going out either, because they are sent from your Gmail.';

  // Every Google connection needs the keys it was made with. Without them no calendar can be
  // read, and a calendar that cannot be read closes the times of everyone it belongs to.
  const keysMissing = !integrations.google.configured;
  const cutOff = keysMissing ? hosts.filter((h) => !!h.google) : [];
  if (cutOff.length > 0) {
    const ownerCut = cutOff.some((h) => h.id === owner?.id);
    const others = cutOff.filter((h) => h.id !== owner?.id).map((h) => firstName(h.name) || h.name || 'a co-host');
    const theirs = joinNames(others.map((name) => `${name}'s`));
    const whose = ownerCut
      ? others.length > 0
        ? `your Google Calendar and ${theirs} cannot be read`
        : 'your Google Calendar cannot be read'
      : `${theirs} Google ${others.length === 1 ? 'Calendar' : 'Calendars'} cannot be read`;
    const effect = ownerCut ? 'no times are offered for meetings with you' : `times that include ${joinNames(others)} are not offered`;
    warnings.push({
      key: 'google_keys_missing',
      message: `The Google keys were removed, so ${whose} and ${effect}.${gmailProblem === 'keys_missing' ? noGmail : ''} Add the same client ID and client secret again under Integrations.`,
      href: LINK.google,
    });
  }

  for (const host of hosts) {
    const mine = host.id === owner?.id;
    const first = firstName(host.name) || 'A co-host';
    // Said once, above, for everyone it affects.
    if (keysMissing && host.google) continue;
    if (host.google?.status === 'needs_reconnect') {
      warnings.push(
        mine
          ? {
              key: `google_reconnect_${host.id}`,
              message: `Your Google Calendar needs to be reconnected. Until then, no times are offered for meetings with you and new bookings cannot reach your calendar.${gmailProblem === 'needs_reconnect' ? noGmail : ''}`,
              href: LINK.google,
            }
          : { key: `google_reconnect_${host.id}`, message: `${first}'s Google Calendar needs to be reconnected. Until then, times that include ${first} are not offered. Ask them to open their private link and connect again.`, href: LINK.team },
      );
    } else if (host.calendarHealth && host.calendarHealth.ok === false) {
      const reason = (host.calendarHealth.message ?? '').trim();
      const what = mine ? 'Your calendar could not be read' : `${first}'s calendar could not be read`;
      const effect = mine ? 'so times are not being offered until this is fixed.' : `so times that include ${first} are not being offered until this is fixed.`;
      warnings.push({ key: `calendar_health_${host.id}`, message: `${what}, ${effect}${reason ? ` ${reason}` : ''}`, href: mine ? LINK.google : LINK.team });
    }
    // Made while the consent screen was in "Testing": Google ends the connection after 7 days (google.ts completeGoogleAuth).
    const ends = host.google?.status === 'ok' ? Date.parse(host.google.refreshExpiresAt ?? '') : Number.NaN;
    if (Number.isFinite(ends)) {
      const day = formatInZone(ends, owner?.timezone ?? host.timezone, 'date');
      const when = ends <= ctx.now().getTime() ? `stopped working on ${day}` : `ends on ${day}`;
      const why = 'because the consent screen in Google Cloud is still in Testing';
      warnings.push(
        mine
          ? {
              key: `google_expiry_${host.id}`,
              message: `Your Google connection ${when}, ${why}. After that, no times are offered until you reconnect. Publish the consent screen in Google Cloud, then reconnect.`,
              href: LINK.google,
            }
          : {
              key: `google_expiry_${host.id}`,
              message: `${first}'s Google connection ${when}, ${why}. Publish the consent screen in Google Cloud, then ask ${first} to connect again from their private link.`,
              href: LINK.team,
            },
      );
    }
  }

  // A Gmail that cannot send is said in the Google warning above, with its cause.
  if (integrations.email.resolved === 'none' && site.email.provider !== 'none' && !gmailProblem) {
    warnings.push({ key: 'no_email', message: 'No email provider is set up, so confirmations and reminders are not being emailed.', href: LINK.email });
  }

  // New, moved and cancelled bookings, and alerts about calendar trouble, go to this address.
  if (owner && !isEmail(owner.email) && site.email.provider !== 'none') {
    warnings.push({
      key: 'owner_no_email',
      message: 'You have not said where your booking notices should go, so you are not emailed when someone books, moves or cancels a meeting, or when your calendar has a problem. Add your address under Settings.',
      href: LINK.notices,
    });
  }

  // Without email and without a Google calendar to put it on, a booking reaches nobody: not the invitee, not
  // the hosts. A round robin can land on any of its hosts, so each one needs Google (as in booking.ts).
  if (integrations.email.resolved === 'none') {
    const byHost = hostMap(hosts);
    const googleOk = (host: Host) => host.google?.status === 'ok';
    // A Google Calendar that cannot be read offers no times (booking.ts fails closed). A meeting that
    // needs one cannot be booked at all, and the Google warnings above already say so: telling the
    // owner here that "people can book" it would contradict them. This is also how a Gmail that went
    // down with the owner's Google connection empties `resolved`.
    const unreadable = (host: Host) => !!host.google && (host.google.status !== 'ok' || keysMissing);
    const unheard = active.filter((e) => {
      const assigned = e.hostIds.map((id) => byHost.get(id)).filter((h): h is Host => !!h);
      // A round robin still offers the times of the hosts whose calendars can be read; the others close it.
      const open = e.kind === 'round_robin' ? assigned.filter((h) => !unreadable(h)) : assigned.some(unreadable) ? [] : assigned;
      return open.length > 0 && !(e.kind === 'round_robin' ? open.every(googleOk) : open.some(googleOk));
    });
    if (unheard.length > 0) {
      warnings.push({
        key: 'bookings_reach_nobody',
        message: `People can book ${quoted(unheard.map((e) => e.title))}, but nobody hears about it: no email is sent, and no Google Calendar is connected to put the booking on. Set up email or connect Google Calendar.`,
        href: LINK.email,
      });
    }
  }

  if (!features.sms) {
    const needsTwilio = active.filter((e) => e.reminders.some((r) => r.enabled && (r.channel === 'sms' || r.channel === 'call')));
    if (needsTwilio.length > 0) {
      warnings.push({
        key: 'twilio_missing',
        message: `${quoted(needsTwilio.map((e) => e.title))} ${needsTwilio.length === 1 ? 'has' : 'have'} reminders by text or phone call, but Twilio is not connected, so those reminders are skipped.`,
        href: LINK.twilio,
      });
    }
  } else if (!features.calls) {
    // Texts work (a Messaging Service), calls do not: a call needs a Twilio number of its own.
    const needsNumber = active.filter((e) => e.reminders.some((r) => r.enabled && r.channel === 'call'));
    if (needsNumber.length > 0) {
      warnings.push({
        key: 'twilio_missing',
        message: `${quoted(needsNumber.map((e) => e.title))} ${needsNumber.length === 1 ? 'has' : 'have'} reminder calls, but reminder calls need a Twilio phone number and none is saved, so those calls are skipped. Texts still go out.`,
        href: LINK.twilio,
      });
    }
  }

  const byId = hostMap(hosts);
  const nowMs = ctx.now().getTime();
  for (const event of active) {
    if (event.kind !== 'collective') continue;
    // Hours that never line up close the page for good, whatever the calendars say.
    const hours = checkSharedHours({ eventType: event, hosts, owner, nowMs });
    if (!hours.ok && hours.message) warnings.push({ key: `shared_hours_${event.id}`, message: hours.message, href: hours.href ?? LINK.team });
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
