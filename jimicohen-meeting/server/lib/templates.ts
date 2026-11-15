/**
 * Message wording: the variables a message can use, the tiny template language that fills them in,
 * and the built-in text for every kind of message on every channel.
 *
 * Template language:
 *   {{name}}                      the value, or nothing when it is unknown or empty
 *   {{#name}} ... {{/name}}       the part in between only when the value is not empty
 *   {{^name}} ... {{/name}}       the part in between only when the value IS empty
 * Values are inserted as they are and never scanned again, so a booking name that contains
 * "{{manage_url}}" stays plain text.
 */
import { DateTime, IANAZone } from 'luxon';
import { bookUrlFor, isSiteView } from '../../shared/brands';
import type { Booking, EventType, Host, IanaZone, LocationType, MessageKind, ReminderChannel, SiteSettings } from '../../shared/types';
import { hmacHex } from './crypto';
import type { Ctx } from './ctx';
import { formatInZone } from './time';

export type TemplateVars = Record<string, string>;

export const TEMPLATE_VARIABLES: { key: string; description: string }[] = [
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
  { key: 'book_url', description: 'Booking page of this event type (its short link, such as jimicohen.com/pod, when one opens it)' },
  { key: 'answers', description: 'Answers to your booking questions, one per line' },
  { key: 'guests', description: 'Email addresses of invited guests' },
  { key: 'cancel_reason', description: 'Reason given when the meeting was cancelled' },
  { key: 'cancelled_by', description: 'Who cancelled the meeting' },
  { key: 'site_name', description: 'The name of the brand this meeting uses: your own name, or a brand such as Eco Champions' },
  { key: 'assistant_name', description: 'Name of your AI assistant' },
];

// ───────────────────────── rendering ─────────────────────────

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

const SECTION = /\{\{\s*([#^])\s*([A-Za-z_]\w*)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\2\s*\}\}/g;
const VARIABLE = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;
const STRAY_TAG = /\{\{\s*[#^/][^{}]*\}\}/g;
const MAX_SECTION_DEPTH = 8;

function lookup(vars: TemplateVars, key: string): string {
  if (!Object.prototype.hasOwnProperty.call(vars, key)) return '';
  const value = vars[key];
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function resolveSections(tpl: string, vars: TemplateVars, depth: number): string {
  if (depth > MAX_SECTION_DEPTH) return tpl;
  return tpl.replace(SECTION, (_all, mode: string, key: string, inner: string) => {
    const filled = lookup(vars, key).trim() !== '';
    return (mode === '#') === filled ? resolveSections(inner, vars, depth + 1) : '';
  });
}

/** {{var}}; unknown vars render empty; html=true escapes values (the template text itself is trusted and left alone). */
export function renderTemplate(tpl: string, vars: TemplateVars, opts?: { html?: boolean }): string {
  if (typeof tpl !== 'string' || tpl === '') return '';
  const safeVars = vars ?? {};
  return resolveSections(sayEventWith(tpl, safeVars), safeVars, 0)
    .replace(STRAY_TAG, '')
    .replace(VARIABLE, (_all, key: string) => {
      const value = lookup(safeVars, key);
      return opts?.html ? escapeHtml(value) : value;
    });
}

/**
 * True when a meeting's name already says it is with these people: "Meeting with Jimi" names "Jimi Cohen", and
 * "Coffee with Jimi and Ian" names "Jimi and Ian". `names` is a name or a list ("Jimi, Ian and Sam").
 */
export function eventNamesEveryone(eventName: string, names: string): boolean {
  const words = String(eventName ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u);
  if (!words.includes('with')) return false;
  const firsts = String(names ?? '')
    .split(/,\s*|\s+and\s+/)
    .map((n) => firstName(n).toLowerCase())
    .filter(Boolean);
  return firsts.length > 0 && firsts.every((first) => words.includes(first));
}

/**
 * The wording "{{event_name}} with {{host_names}}" (or with {{invitee_name}}) for a meeting whose name already
 * says "with" ("Meeting with Jimi", the meeting behind jimicohen.com/meet) would read "Meeting with Jimi with
 * Jimi Cohen". Such a name is said alone when it already names the hosts, else with the people in brackets:
 * "Meeting with Jimi (Ann Lee)". Every other name reads exactly as before.
 */
function sayEventWith(tpl: string, vars: TemplateVars): string {
  if (!tpl.includes('{{event_name}} with {{')) return tpl;
  const name = String(vars.event_name ?? '');
  if (!name.toLowerCase().split(/[^\p{L}\p{N}]+/u).includes('with')) return tpl;
  return tpl.replace(/\{\{event_name\}\} with \{\{(host_names|invitee_name)\}\}/g, (_all, key: string) =>
    key === 'host_names' && eventNamesEveryone(name, String(vars.host_names ?? '')) ? '{{event_name}}' : `{{event_name}} ({{${key}}})`,
  );
}

// ───────────────────────── small wording helpers ─────────────────────────

export function firstName(name: string): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

// Endings that make a word read as a web address. A short list on purpose: a generic "word.word"
// test would also catch real names such as "J.R.R." or "Anne-Marie.S".
const LINK_ENDINGS =
  'com|net|org|info|biz|io|co|app|dev|ai|me|ly|to|gg|so|sh|cc|tv|ws|xyz|top|link|click|online|site|website|shop|store|live|club|vip|win|work|page|email|zip|mov|ru|cn|tk|ml|ga|cf|gq|us|uk|de|in|ng|ke';
const LINKISH = new RegExp(`(?::\\/\\/|www\\.|[\\/\\\\@]|[\\p{L}\\p{N}-]{2,}\\.(?:${LINK_ENDINGS})(?![\\p{L}\\p{N}]))`, 'iu');

/**
 * Visitor text the way phones, browsers and mail programs read it when they look for an address: wide
 * and other compatibility forms folded (NFKC turns "ｅｖｉｌ．ｃｏｍ" into "evil.com"), and the ideographic
 * full stops, which browsers also take as dots, made dots. The booking form's check uses it too.
 */
export function linkCheckText(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[。．｡]/g, '.');
}

/** True when a piece of visitor-typed text would show up as a link or an address on a phone or in a mail program. */
export function looksLikeLink(text: string): boolean {
  return LINKISH.test(linkCheckText(text));
}

/** "Jimi", "Jimi and Alex", "Jimi, Alex and Sam" */
export function joinNames(names: string[]): string {
  const list = names.map((n) => n.trim()).filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** "45 minutes", "1 hour", "1 hour 30 minutes" */
export function humanDuration(minutes: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(minutes) ? minutes : 0));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (rest > 0 || hours === 0) parts.push(`${rest} ${rest === 1 ? 'minute' : 'minutes'}`);
  return parts.join(' ');
}

/** "in 15 minutes", "in 1 hour 30 minutes", "in 5 hours", "in 3 days"; "now" once the start has passed. */
export function startsIn(nowMs: number, startMs: number): string {
  const diff = startMs - nowMs;
  if (!(diff > 0)) return 'now';
  let minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'in less than a minute';
  if (minutes >= 10) minutes = Math.round(minutes / 5) * 5;
  if (minutes < 180) return `in ${humanDuration(minutes)}`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 36) return `in ${hours} hours`;
  return `in ${Math.round(hours / 24)} days`;
}

function usesTwentyFourHours(locale: string): boolean | null {
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 === false;
  } catch {
    return null;
  }
}

/**
 * The wording is English, so dates are always written in English too, but the clock follows the
 * reader: the site's fixed 12h/24h choice when there is one, else what their own locale uses.
 */
export function messageLocale(locale: string | undefined, timeFormat: 'auto' | '12h' | '24h' = 'auto'): string {
  const own = typeof locale === 'string' ? locale.replace(/_/g, '-') : '';
  const ownClock = own ? usesTwentyFourHours(own) : null;
  const want24 = timeFormat === '24h' ? true : timeFormat === '12h' ? false : (ownClock ?? false);
  if (/^en(?:-|$)/i.test(own) && ownClock === want24) return own;
  return want24 ? 'en-GB' : 'en-US';
}

function validZone(tz: unknown): tz is string {
  return typeof tz === 'string' && tz !== '' && tz.length <= 64 && IANAZone.isValidZone(tz);
}

function zoneNames(ms: number, tz: IanaZone): { long: string; short: string } {
  const dt = DateTime.fromMillis(ms, { zone: tz }).setLocale('en-US');
  return { long: dt.offsetNameLong ?? tz, short: dt.offsetNameShort ?? tz };
}

function relativeDay(nowMs: number, startMs: number, tz: IanaZone, locale: string): string {
  const start = DateTime.fromMillis(startMs, { zone: tz });
  const days = Math.round(start.startOf('day').diff(DateTime.fromMillis(nowMs, { zone: tz }).startOf('day'), 'days').days);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  const text = start.setLocale(locale).toLocaleString({ weekday: 'long', month: 'long', day: 'numeric' });
  return `on ${text.replace(/[\u00A0\u2009\u202F]/g, ' ')}`;
}

const LOCATION_LABELS: Record<LocationType, string> = {
  google_meet: 'Google Meet',
  phone_host_calls: 'Phone call',
  phone_invitee_calls: 'Phone call',
  in_person: 'In person',
  custom_link: 'Video call',
  ask_invitee: 'Location',
};

function describeLocation(booking: Booking, audience: 'invitee' | 'host', hostFirst: string, inviteeFirst: string): string {
  const loc = booking.location ?? { type: 'ask_invitee' as LocationType, label: '' };
  const label = (loc.label ?? '').trim() || LOCATION_LABELS[loc.type] || 'Meeting';
  const value = (loc.value ?? '').trim();
  const phone = (booking.invitee.phone ?? '').trim() || value;
  switch (loc.type) {
    case 'phone_host_calls':
      if (audience === 'invitee') return `${label}. ${hostFirst || 'Your host'} will call you${phone ? ` on ${phone}` : ''}`;
      return `${label}. Call ${inviteeFirst || 'the invitee'}${phone ? ` on ${phone}` : ''}`;
    case 'phone_invitee_calls':
      if (!value) return label;
      return audience === 'invitee' ? `${label}. Call ${value}` : `${label}. ${inviteeFirst || 'The invitee'} will call ${value}`;
    case 'google_meet':
    case 'custom_link':
      return label;
    default:
      return value && value !== label ? `${label}: ${value}` : label;
  }
}

/** Same value as manageToken() in booking.ts; computed here so messages do not depend on that module. */
function manageTokenFor(ctx: Ctx, bookingId: string): string {
  return hmacHex(ctx, 'manage', bookingId);
}

/** The hosts assigned to the booking, in the booking's order. Falls back to the owner, then to whoever was passed in. */
export function assignedHosts(booking: Booking, hosts: Host[], site: SiteSettings): Host[] {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const assigned = booking.hostIds.map((id) => byId.get(id)).filter((h): h is Host => !!h);
  if (assigned.length > 0) return assigned;
  const owner = byId.get(site.ownerHostId) ?? hosts.find((h) => h.role === 'owner');
  return owner ? [owner] : hosts.slice(0, 1);
}

/** A cancellation the owner made, with the session checked: the dashboard, or the booking page while signed in. */
function ownersReason(booking: Booking): boolean {
  return booking.cancellation?.by === 'host' && booking.cancellation.via !== 'host_link';
}

function cancelledBy(booking: Booking, site: SiteSettings): string {
  const by = booking.cancellation?.by;
  if (by === 'invitee') return booking.invitee.name;
  if (by === 'host') return 'the host';
  if (by === 'assistant') return `${site.assistant.name}, the AI assistant, at ${firstName(booking.invitee.name) || 'the invitee'}'s request`;
  return '';
}

// ───────────────────────── variables ─────────────────────────

/**
 * Everything a message can mention. Dates and times are written in the READER's zone: the
 * invitee's zone for invitee messages, and for host messages the zone of `recipientHost`
 * (the first assigned host when none is given).
 */
export function buildVars(
  ctx: Ctx,
  p: {
    booking: Booking;
    eventType: EventType | null;
    hosts: Host[];
    site: SiteSettings;
    audience: 'invitee' | 'host';
    /** host messages: the host this copy is for */
    recipientHost?: Host | null;
  },
): TemplateVars {
  const { booking, site, audience } = p;
  const hosts = assignedHosts(booking, p.hosts ?? [], site);
  const primaryHost = hosts[0] ?? null;
  const reader = audience === 'host' ? (p.recipientHost ?? primaryHost) : null;

  const fallbackZone = validZone(primaryHost?.timezone) ? primaryHost!.timezone : 'UTC';
  const inviteeZone = validZone(booking.invitee.timezone) ? booking.invitee.timezone : fallbackZone;
  const zone = audience === 'host' ? (validZone(reader?.timezone) ? reader!.timezone : fallbackZone) : inviteeZone;
  const locale = messageLocale(audience === 'invitee' ? booking.invitee.locale : undefined, site.theme?.timeFormat ?? 'auto');

  const startMs = Date.parse(booking.start);
  const endMs = Date.parse(booking.end);
  const nowMs = ctx.now().getTime();
  const names = zoneNames(startMs, zone);
  // The greeting is the one piece of the visitor's own typing that every message repeats. A "name"
  // that reads as a web address would arrive as a link from the owner's address and number, so
  // those messages greet "there" instead (and a host reads "the invitee").
  const typedFirst = firstName(booking.invitee.name);
  const inviteeFirst = typedFirst && !looksLikeLink(typedFirst) ? typedFirst : audience === 'host' ? 'the invitee' : 'there';
  const namedHost = audience === 'host' ? reader : primaryHost;
  const hostName = namedHost?.name?.trim() || site.profile.name;
  // Without a host the name comes from the site, which under a brand is the brand: never cut "Eco Champions" to "Eco".
  const hostFirst = !namedHost?.name?.trim() && isSiteView(site) ? hostName : firstName(hostName);
  const hostNames = hosts.length > 1 ? joinNames(hosts.map((h) => firstName(h.name))) : hostName;

  const base = ctx.env.publicBaseUrl.replace(/\/+$/, '');
  const id = encodeURIComponent(booking.id);
  const token = manageTokenFor(ctx, booking.id);
  // Host copies of the manage links say so: the booking page then keeps the host's zone off the invitee
  // and records a change as made by a host. It grants nothing (the invitee holds the same token).
  const asHost = audience === 'host' ? '&as=host' : '';
  const previousMs = booking.rescheduledFromStart ? Date.parse(booking.rescheduledFromStart) : NaN;

  return {
    invitee_name: booking.invitee.name,
    invitee_first_name: inviteeFirst,
    invitee_email: booking.invitee.email,
    invitee_phone: booking.invitee.phone ?? '',
    invitee_timezone: zoneNames(startMs, inviteeZone).long,
    host_name: hostName,
    host_first_name: hostFirst,
    host_names: hostNames,
    host_email: namedHost?.email ?? '',
    event_name: booking.eventTitle || p.eventType?.title || 'Meeting',
    duration: humanDuration(booking.durationMin),
    date: formatInZone(startMs, zone, 'date', locale),
    time: formatInZone(startMs, zone, 'time', locale),
    end_time: formatInZone(endMs, zone, 'time', locale),
    timezone: names.long,
    timezone_short: names.short,
    datetime: formatInZone(startMs, zone, 'full', locale),
    datetime_short: formatInZone(startMs, zone, 'short', locale),
    datetime_spoken: formatInZone(startMs, zone, 'spoken', locale),
    relative_day: relativeDay(nowMs, startMs, zone, locale),
    starts_in: startsIn(nowMs, startMs),
    previous_datetime: Number.isFinite(previousMs) ? formatInZone(previousMs, zone, 'full', locale) : '',
    location: describeLocation(booking, audience, firstName(primaryHost?.name ?? ''), firstName(booking.invitee.name)),
    join_url: booking.location?.joinUrl || booking.google?.meetUrl || '',
    manage_url: `${base}/booking/${id}?t=${token}${asHost}`,
    reschedule_url: `${base}/booking/${id}/reschedule?t=${token}${asHost}`,
    cancel_url: `${base}/booking/${id}/cancel?t=${token}${asHost}`,
    confirm_url: `${base}/booking/${id}?t=${token}&confirm=1`,
    // The short address when a link opens the event now in the look the booking was made in, else the event's page.
    book_url: bookUrlFor(base, site, booking),
    admin_url: `${base}/admin/bookings`,
    answers: booking.answers
      .filter((a) => a.value.trim() !== '')
      .map((a) => `${a.label.trim()}${/[?!.:]$/.test(a.label.trim()) ? '' : ':'} ${a.value.trim()}`)
      .join('\n'),
    guests: booking.guests.join(', '),
    // Hosts always read the reason. The invitee only reads one the owner wrote (the dashboard, or the booking
    // page while signed in): a reason typed on the booking page (by the invitee, or through a host's link,
    // which the invitee holds too) would go, from the owner's own address, to an address nobody has checked.
    cancel_reason: audience === 'host' || ownersReason(booking) ? (booking.cancellation?.reason?.trim() ?? '') : '',
    cancelled_by: cancelledBy(booking, site),
    site_name: site.profile.name,
    assistant_name: site.assistant.name,
  };
}

// ───────────────────────── built-in wording ─────────────────────────

export interface DefaultMessage {
  subject: string;
  body: string;
  /** headline inside the email; empty for text messages and calls */
  heading: string;
}

type Wording = Record<MessageKind, DefaultMessage>;

const WHEN_SMS = '{{datetime_short}} {{timezone_short}}';
const CALL_INTRO_INVITEE = 'Hi {{invitee_first_name}}, this is {{assistant_name}}, an AI assistant calling for {{host_name}}.';
const CALL_INTRO_HOST = 'Hi {{host_first_name}}, this is {{assistant_name}}, your AI assistant.';

function text(body: string): DefaultMessage {
  return { subject: '', body, heading: '' };
}

const INVITEE_EMAIL: Wording = {
  confirmation: {
    subject: 'Confirmed: {{event_name}} with {{host_names}}, {{datetime_short}} {{timezone_short}}',
    heading: "You're booked",
    body: [
      'Hi {{invitee_first_name}},',
      "You're all set. Your {{event_name}} with {{host_names}} is confirmed for {{datetime}}.",
      'Everything you need is below. If something comes up, you can reschedule or cancel using the links in this email.',
    ].join('\n\n'),
  },
  host_new: { subject: '', heading: '', body: '' }, // filled from `confirmation` below
  rescheduled: {
    subject: 'New time: {{event_name}} with {{host_names}}, {{datetime_short}} {{timezone_short}}',
    heading: 'Your meeting has a new time',
    body: [
      'Hi {{invitee_first_name}},',
      'Your {{event_name}} with {{host_names}} has moved. The new time is {{datetime}}.{{#previous_datetime}} The old time was {{previous_datetime}}.{{/previous_datetime}}',
      "If the new time doesn't work for you, you can pick another one or cancel using the links in this email.",
    ].join('\n\n'),
  },
  cancelled: {
    subject: 'Cancelled: {{event_name}} with {{host_names}}, {{datetime_short}} {{timezone_short}}',
    heading: 'This meeting is cancelled',
    body: [
      'Hi {{invitee_first_name}},',
      'Your {{event_name}} with {{host_names}} on {{datetime}} has been cancelled, so you can take it off your calendar.{{#cancel_reason}}\n\nReason given: {{cancel_reason}}{{/cancel_reason}}',
      "If you'd still like to meet, you're welcome to book a new time.",
    ].join('\n\n'),
  },
  reminder: {
    subject: 'Reminder: {{event_name}} with {{host_names}} is {{relative_day}} at {{time}} {{timezone_short}}',
    heading: 'Your meeting is {{relative_day}}',
    body: [
      'Hi {{invitee_first_name}},',
      'A quick reminder that your {{event_name}} with {{host_names}} is {{relative_day}} at {{time}} ({{timezone}}).',
      "Can't make it after all? Please reschedule or cancel using the links in this email so nobody is left waiting.",
    ].join('\n\n'),
  },
  followup: {
    subject: 'Thanks for meeting with {{host_names}}',
    heading: 'Thanks for your time',
    body: [
      'Hi {{invitee_first_name}},',
      'Thank you for making time for your {{event_name}} with {{host_names}}.',
      "If you'd like to pick the conversation back up, you can book another time whenever it suits you.",
    ].join('\n\n'),
  },
  manage_link: {
    subject: 'Your link to change {{event_name}} with {{host_names}}',
    heading: 'Change your booking',
    body: [
      'Hi {{invitee_first_name}},',
      'As promised, here are your links to reschedule or cancel your {{event_name}} with {{host_names}} on {{datetime}}.',
      'If you do nothing, the meeting stays exactly as planned.',
    ].join('\n\n'),
  },
  host_alert: {
    subject: 'An update about {{event_name}} with {{host_names}}',
    heading: 'An update about your meeting',
    body: [
      'Hi {{invitee_first_name}},',
      'There is an update about your {{event_name}} with {{host_names}} on {{datetime}}. You can see the latest details using the link in this email.',
    ].join('\n\n'),
  },
};
INVITEE_EMAIL.host_new = INVITEE_EMAIL.confirmation;

const HOST_EMAIL: Wording = {
  host_new: {
    subject: 'New booking: {{invitee_name}} for {{event_name}}, {{datetime_short}} {{timezone_short}}',
    heading: 'New booking',
    body: [
      'Hi {{host_first_name}},',
      '{{invitee_name}} just booked time with you: {{event_name}}, {{datetime}}.',
      'Their details and answers are below. Reply to this email to write to {{invitee_first_name}} directly.',
    ].join('\n\n'),
  },
  confirmation: { subject: '', heading: '', body: '' }, // filled from `host_new` below
  rescheduled: {
    subject: 'Rescheduled: {{invitee_name}} for {{event_name}}, now {{datetime_short}} {{timezone_short}}',
    heading: 'A meeting has moved',
    body: [
      'Hi {{host_first_name}},',
      'Your {{event_name}} with {{invitee_name}} has moved to {{datetime}}.{{#previous_datetime}} The old time was {{previous_datetime}}.{{/previous_datetime}}',
    ].join('\n\n'),
  },
  cancelled: {
    subject: 'Cancelled: {{invitee_name}} for {{event_name}}, {{datetime_short}} {{timezone_short}}',
    heading: 'A meeting was cancelled',
    body: [
      'Hi {{host_first_name}},',
      'Your {{event_name}} with {{invitee_name}} on {{datetime}} was cancelled{{#cancelled_by}} by {{cancelled_by}}{{/cancelled_by}}.{{#cancel_reason}}\n\nReason given: {{cancel_reason}}{{/cancel_reason}}',
      'That time is open for booking again.',
    ].join('\n\n'),
  },
  reminder: {
    subject: 'Reminder: {{event_name}} with {{invitee_name}} is {{relative_day}} at {{time}} {{timezone_short}}',
    heading: 'Coming up {{relative_day}}',
    body: ['Hi {{host_first_name}},', 'Your {{event_name}} with {{invitee_name}} is {{relative_day}} at {{time}} ({{timezone}}).'].join('\n\n'),
  },
  followup: {
    subject: 'Wrapped up: {{event_name}} with {{invitee_name}}',
    heading: 'Meeting wrapped up',
    body: [
      'Hi {{host_first_name}},',
      'Your {{event_name}} with {{invitee_name}} has ended. Their details are below in case you want to follow up.',
    ].join('\n\n'),
  },
  manage_link: {
    subject: 'Manage {{event_name}} with {{invitee_name}}',
    heading: 'Manage this booking',
    body: [
      'Hi {{host_first_name}},',
      'Here is the link to reschedule or cancel your {{event_name}} with {{invitee_name}} on {{datetime}}. You can also forward it to {{invitee_first_name}}.',
    ].join('\n\n'),
  },
  host_alert: {
    subject: 'Your booking page needs attention',
    heading: 'Something needs your attention',
    body: [
      'Hi {{host_first_name}},',
      'Something on the {{site_name}} booking page needs a look. Open your dashboard to see what is going on.',
    ].join('\n\n'),
  },
};
HOST_EMAIL.confirmation = HOST_EMAIL.host_new;

// Text messages carry the facts only. The join and manage links are added by the sender, which
// also keeps the whole message under the length limit without ever cutting a link.
const INVITEE_SMS: Wording = {
  confirmation: text(`Hi {{invitee_first_name}}, you're booked: {{event_name}} with {{host_names}} on ${WHEN_SMS}.`),
  host_new: text(`Hi {{invitee_first_name}}, you're booked: {{event_name}} with {{host_names}} on ${WHEN_SMS}.`),
  rescheduled: text(`Hi {{invitee_first_name}}, your {{event_name}} with {{host_names}} has moved to ${WHEN_SMS}.`),
  cancelled: text(`Hi {{invitee_first_name}}, your {{event_name}} with {{host_names}} on ${WHEN_SMS} is cancelled. Book a new time: {{book_url}}`),
  reminder: text('Hi {{invitee_first_name}}, a reminder: {{event_name}} with {{host_names}} is {{relative_day}} at {{time}} {{timezone_short}}.'),
  followup: text('Hi {{invitee_first_name}}, thanks for making time for your {{event_name}} with {{host_names}}. Want to meet again? {{book_url}}'),
  manage_link: text(
    `Hi {{invitee_first_name}}, here is your link to reschedule or cancel your {{event_name}} with {{host_names}} on ${WHEN_SMS}: {{manage_url}}`,
  ),
  host_alert: text('Hi {{invitee_first_name}}, there is an update about your {{event_name}} with {{host_names}}: {{manage_url}}'),
};

const HOST_SMS: Wording = {
  host_new: text(`New booking: {{invitee_name}} for {{event_name}}, ${WHEN_SMS}.`),
  confirmation: text(`New booking: {{invitee_name}} for {{event_name}}, ${WHEN_SMS}.`),
  rescheduled: text(`Rescheduled: {{event_name}} with {{invitee_name}} is now ${WHEN_SMS}.`),
  cancelled: text(`Cancelled: {{event_name}} with {{invitee_name}}, ${WHEN_SMS}.{{#cancel_reason}} Reason: {{cancel_reason}}{{/cancel_reason}}`),
  reminder: text('Reminder: {{event_name}} with {{invitee_name}} is {{relative_day}} at {{time}} {{timezone_short}}.'),
  followup: text('{{event_name}} with {{invitee_name}} has wrapped up.'),
  manage_link: text('Manage {{event_name}} with {{invitee_name}}: {{manage_url}}'),
  host_alert: text('{{site_name}} booking page: something needs your attention. Please check your email or dashboard.'),
};

// Spoken lines. The voice assistant opens with the reminder line and takes the conversation from there.
const INVITEE_CALL: Wording = {
  confirmation: text(`${CALL_INTRO_INVITEE} Your {{event_name}} is booked for {{datetime_spoken}} your time.`),
  host_new: text(`${CALL_INTRO_INVITEE} Your {{event_name}} is booked for {{datetime_spoken}} your time.`),
  rescheduled: text(`${CALL_INTRO_INVITEE} Your {{event_name}} has moved to {{datetime_spoken}} your time.`),
  cancelled: text(`${CALL_INTRO_INVITEE} Your {{event_name}} on {{datetime_spoken}} has been cancelled.`),
  reminder: text(
    `${CALL_INTRO_INVITEE} A quick reminder about your {{event_name}} {{relative_day}} at {{time}} your time. Are you still able to make it?`,
  ),
  followup: text(`${CALL_INTRO_INVITEE} Thank you for making time for your {{event_name}}.`),
  manage_link: text(`${CALL_INTRO_INVITEE} I am sending you a link to reschedule or cancel your {{event_name}}.`),
  host_alert: text(`${CALL_INTRO_INVITEE} There is an update about your {{event_name}}.`),
};

const HOST_CALL: Wording = {
  host_new: text(`${CALL_INTRO_HOST} You have a new booking: {{event_name}} with {{invitee_name}}, {{datetime_spoken}}.`),
  confirmation: text(`${CALL_INTRO_HOST} You have a new booking: {{event_name}} with {{invitee_name}}, {{datetime_spoken}}.`),
  rescheduled: text(`${CALL_INTRO_HOST} Your {{event_name}} with {{invitee_name}} has moved to {{datetime_spoken}}.`),
  cancelled: text(`${CALL_INTRO_HOST} Your {{event_name}} with {{invitee_name}} on {{datetime_spoken}} was cancelled.`),
  reminder: text(`${CALL_INTRO_HOST} A reminder that your {{event_name}} with {{invitee_name}} is {{relative_day}} at {{time}}.`),
  followup: text(`${CALL_INTRO_HOST} Your {{event_name}} with {{invitee_name}} has wrapped up.`),
  manage_link: text(`${CALL_INTRO_HOST} I sent you the link to manage your {{event_name}} with {{invitee_name}}.`),
  host_alert: text(`${CALL_INTRO_HOST} Something on your booking page needs your attention. Please check your email.`),
};

const WORDING: Record<ReminderChannel, Record<'invitee' | 'host', Wording>> = {
  email: { invitee: INVITEE_EMAIL, host: HOST_EMAIL },
  sms: { invitee: INVITEE_SMS, host: HOST_SMS },
  call: { invitee: INVITEE_CALL, host: HOST_CALL },
};

/** Built-in wording for one kind of message. Unknown input falls back to the invitee reminder rather than throwing. */
export function defaultMessage(kind: MessageKind, channel: ReminderChannel, audience: 'invitee' | 'host'): DefaultMessage {
  const byAudience = WORDING[channel] ?? WORDING.email;
  const wording = byAudience[audience] ?? byAudience.invitee;
  const found = wording[kind] ?? wording.reminder;
  return { subject: found.subject, body: found.body, heading: found.heading };
}
