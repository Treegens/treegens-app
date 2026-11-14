/**
 * Wording helpers shared by the dashboard pages: how event kinds, locations, reminder rules
 * and timeline entries are written out for people.
 */
import type { EventKind, EventType, LocationConfig, LocationType, ReminderChannel, ReminderRule, TimelineEntry } from '../../shared/types';

export function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** "https://jimicohen.com/meeting/" → "jimicohen.com/meeting" */
export function displayUrl(url: string): string {
  return trimUrl(url).replace(/^https?:\/\//, '');
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "Jimi", "Jimi and Alex", "Jimi, Alex and Sam" */
export function namesList(names: string[]): string {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export const KIND_LABEL: Record<EventKind, string> = {
  solo: 'Just me',
  collective: 'Together',
  round_robin: 'Round robin',
};

export const LOCATION_LABEL: Record<LocationType, string> = {
  google_meet: 'Google Meet',
  phone_host_calls: 'Phone call, you call them',
  phone_invitee_calls: 'Phone call, they call you',
  in_person: 'In person',
  custom_link: 'Video link',
  ask_invitee: 'Invitee chooses',
};

export const LOCATION_SHORT: Record<LocationType, string> = {
  google_meet: 'Google Meet',
  phone_host_calls: 'Phone call',
  phone_invitee_calls: 'Phone call',
  in_person: 'In person',
  custom_link: 'Video link',
  ask_invitee: 'Invitee chooses',
};

export function locationSummary(locations: LocationConfig[]): string {
  if (!locations.length) return 'No location';
  const first = locations[0].label || LOCATION_SHORT[locations[0].type];
  return locations.length === 1 ? first : `${first} +${locations.length - 1}`;
}

/** "15 min", "30, 45 or 60 min" */
export function durationsSummary(durations: number[]): string {
  if (durations.length <= 1) return `${durations[0] ?? 30} min`;
  return `${durations.slice(0, -1).join(', ')} or ${durations[durations.length - 1]} min`;
}

// ───────────── offsets ─────────────

export type OffsetUnit = 'minutes' | 'hours' | 'days';
export const UNIT_MINUTES: Record<OffsetUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** Splits minutes into the friendliest amount + unit: 1440 → 24 hours, 2880 → 2 days, 90 → 90 minutes. */
export function splitOffset(minutes: number): { amount: number; unit: OffsetUnit } {
  if (minutes >= 2880 && minutes % 1440 === 0) return { amount: minutes / 1440, unit: 'days' };
  if (minutes >= 60 && minutes % 60 === 0) return { amount: minutes / 60, unit: 'hours' };
  return { amount: minutes, unit: 'minutes' };
}

export function offsetText(minutes: number): string {
  const { amount, unit } = splitOffset(minutes);
  const word = unit === 'minutes' ? 'minute' : unit === 'hours' ? 'hour' : 'day';
  return `${amount} ${word}${amount === 1 ? '' : 's'}`;
}

// ───────────── reminders ─────────────

export const CHANNEL_LABEL: Record<ReminderChannel, string> = { email: 'Email', sms: 'Text message', call: 'AI phone call' };

/** "Email the invitee 24 hours before", "AI assistant calls the invitee 2 hours before" */
export function reminderSentence(rule: Pick<ReminderRule, 'channel' | 'audience' | 'trigger' | 'offsetMinutes'>, hostCount = 1): string {
  const who = rule.audience === 'invitee' ? 'the invitee' : hostCount > 1 ? 'the hosts' : 'you';
  const lead = rule.channel === 'email' ? `Email ${who}` : rule.channel === 'sms' ? `Text ${who}` : `AI assistant calls ${who}`;
  if (rule.trigger === 'after_end') return rule.offsetMinutes === 0 ? `${lead} right after it ends` : `${lead} ${offsetText(rule.offsetMinutes)} after it ends`;
  return rule.offsetMinutes === 0 ? `${lead} when it starts` : `${lead} ${offsetText(rule.offsetMinutes)} before`;
}

/**
 * Variables people can use in custom wording. A local copy of TEMPLATE_VARIABLES in
 * server/lib/templates.ts (spec 4.3), used when the bootstrap does not carry `templateVariables`.
 */
export const TEMPLATE_VARIABLES_FALLBACK: { key: string; description: string }[] = [
  { key: 'invitee_name', description: 'Full name of the person who booked' },
  { key: 'invitee_first_name', description: 'Their first name' },
  { key: 'invitee_email', description: 'Their email address' },
  { key: 'invitee_phone', description: 'Their phone number, when they gave one' },
  { key: 'invitee_timezone', description: 'Their time zone, for example East Africa Time' },
  { key: 'host_name', description: 'Name of the host (in a host message: the host reading it)' },
  { key: 'host_first_name', description: "The host's first name" },
  { key: 'host_names', description: 'Everyone hosting, for example "Jimi and Alex"' },
  { key: 'event_name', description: 'Name of the event type' },
  { key: 'duration', description: 'Length of the meeting, for example 30 minutes' },
  { key: 'date', description: "Date of the meeting in the reader's time zone" },
  { key: 'time', description: "Start time in the reader's time zone" },
  { key: 'end_time', description: "End time in the reader's time zone" },
  { key: 'timezone', description: "The reader's time zone, for example Eastern Standard Time" },
  { key: 'timezone_short', description: 'Short form of the time zone, for example EST' },
  { key: 'datetime', description: 'Date, time and zone together' },
  { key: 'datetime_short', description: 'Compact date and time, for example Tue, Nov 17, 3:30 PM' },
  { key: 'relative_day', description: '"today", "tomorrow" or "on Tuesday, November 17"' },
  { key: 'starts_in', description: 'Time left until the start, for example "in 1 hour"' },
  { key: 'previous_datetime', description: 'The old date and time after a reschedule' },
  { key: 'location', description: 'Where the meeting happens' },
  { key: 'join_url', description: 'Video link, when the meeting has one' },
  { key: 'manage_url', description: 'Page where the booking can be viewed, moved or cancelled' },
  { key: 'reschedule_url', description: 'Link straight to picking a new time' },
  { key: 'cancel_url', description: 'Link straight to cancelling' },
  { key: 'confirm_url', description: 'Link that confirms the invitee is coming' },
  { key: 'book_url', description: 'Booking page of this event type' },
  { key: 'answers', description: 'Answers to your booking questions, one per line' },
  { key: 'guests', description: 'Email addresses of invited guests' },
  { key: 'cancel_reason', description: 'Reason given when the meeting was cancelled' },
  { key: 'cancelled_by', description: 'Who cancelled the meeting' },
  { key: 'site_name', description: 'Name shown on your booking page' },
  { key: 'assistant_name', description: 'Name of your AI assistant' },
];

// ───────────── event types ─────────────

/** One line under an event type's title in lists. */
export function eventMeta(et: EventType, hostName: (id: string) => string): string {
  const parts = [durationsSummary(et.durations), locationSummary(et.locations)];
  if (et.kind === 'collective') parts.push(`Together: ${namesList(et.hostIds.map((id) => firstName(hostName(id))))}`);
  else if (et.kind === 'round_robin') parts.push(`Round robin: ${namesList(et.hostIds.map((id) => firstName(hostName(id))))}`);
  return parts.join(' · ');
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ───────────── booking timeline ─────────────

export type TimelineIcon = 'calendar' | 'mail' | 'sms' | 'call' | 'check' | 'cancel' | 'move' | 'alert' | 'noshow' | 'dot';
export type TimelineTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface TimelineView {
  label: string;
  icon: TimelineIcon;
  tone: TimelineTone;
}

const EXACT: Record<string, TimelineView> = {
  created: { label: 'Booked', icon: 'calendar', tone: 'neutral' },
  rescheduled: { label: 'Rescheduled', icon: 'move', tone: 'neutral' },
  cancelled: { label: 'Cancelled', icon: 'cancel', tone: 'danger' },
  attendance_confirmed: { label: 'Attendance confirmed', icon: 'check', tone: 'success' },
  marked_no_show: { label: 'Marked as a no-show', icon: 'noshow', tone: 'warning' },
  no_show_cleared: { label: 'No-show cleared', icon: 'noshow', tone: 'neutral' },
  sms_opt_out: { label: 'Opted out of texts and calls', icon: 'sms', tone: 'warning' },
  calendar_event_created: { label: 'Added to Google Calendar', icon: 'calendar', tone: 'success' },
  calendar_event_updated: { label: 'Google Calendar event updated', icon: 'calendar', tone: 'neutral' },
  calendar_event_deleted: { label: 'Removed from Google Calendar', icon: 'calendar', tone: 'neutral' },
  calendar_sync_failed: { label: 'Google Calendar sync failed', icon: 'alert', tone: 'danger' },
  gcal_sync_sent: { label: 'Added to Google Calendar', icon: 'calendar', tone: 'success' },
  gcal_sync_failed: { label: 'Google Calendar sync failed', icon: 'alert', tone: 'danger' },
  call_started: { label: 'Reminder call started', icon: 'call', tone: 'neutral' },
  call_completed: { label: 'Reminder call completed', icon: 'call', tone: 'success' },
  call_voicemail: { label: 'Reminder call left a voicemail', icon: 'call', tone: 'neutral' },
  call_no_answer: { label: 'Reminder call was not answered', icon: 'call', tone: 'warning' },
  call_failed: { label: 'Reminder call failed', icon: 'call', tone: 'danger' },
};

const KIND_WORDS: Record<string, string> = {
  confirmation: 'Confirmation',
  host_new: 'Host notification',
  rescheduled: 'Reschedule notice',
  cancelled: 'Cancellation notice',
  reminder: 'Reminder',
  followup: 'Follow-up',
  manage_link: 'Manage link',
  host_alert: 'Alert to you',
};

/** Turns a raw timeline entry type ("reminder_call_sent") into words, an icon and a tone. */
export function describeTimeline(entry: Pick<TimelineEntry, 'type'>): TimelineView {
  const exact = EXACT[entry.type];
  if (exact) return exact;
  const m = /^([a-z_]+?)_(email|sms|call)_(sent|failed|skipped)$/.exec(entry.type);
  if (m) {
    const kind = KIND_WORDS[m[1]] ?? sentenceCase(m[1]);
    const channel = m[2] === 'email' ? 'email' : m[2] === 'sms' ? 'text' : 'call';
    const status = m[3] === 'sent' ? (m[2] === 'call' ? 'placed' : 'sent') : m[3] === 'failed' ? 'failed' : 'skipped';
    return {
      label: `${kind} ${channel} ${status}`,
      icon: m[2] === 'email' ? 'mail' : m[2] === 'sms' ? 'sms' : 'call',
      tone: m[3] === 'failed' ? 'danger' : m[3] === 'skipped' ? 'warning' : 'neutral',
    };
  }
  const icon: TimelineIcon = /call/.test(entry.type) ? 'call' : /sms|text/.test(entry.type) ? 'sms' : /email|mail/.test(entry.type) ? 'mail' : /calendar|gcal/.test(entry.type) ? 'calendar' : 'dot';
  return { label: sentenceCase(entry.type), icon, tone: /fail|error/.test(entry.type) ? 'danger' : 'neutral' };
}

function sentenceCase(raw: string): string {
  const words = raw.replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : raw;
}

/** `${manageUrl}` → its reschedule variant: /booking/<id>?t= → /booking/<id>/reschedule?t= */
export function rescheduleUrlOf(manageUrl: string): string {
  const [path, query] = manageUrl.split('?');
  return `${path.replace(/\/+$/, '')}/reschedule${query ? `?${query}` : ''}`;
}

/** Stable id for new list items (questions, reminder rules, schedules). */
export function localId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** Structural equality for plain JSON data (drafts vs saved). */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
