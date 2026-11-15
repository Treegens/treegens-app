/**
 * Read-only ICS (iCalendar) feeds: fetch a subscription URL safely and turn its events into busy
 * intervals. Three jobs, kept apart:
 *   assertSafeFeedUrl : decides which URLs we are willing to fetch at all (SSRF guard)
 *   parseIcsBusy      : text in, busy intervals out; never throws, whatever the feed looks like
 *   fetchIcsBusy      : guarded download (https only, every redirect hop re-checked, size and time
 *                       limits) followed by the parser; downloadIcsFeed and busyFromIcsText are
 *                       its two halves, for callers that keep the downloaded text for a while
 */
import { isIP } from 'node:net';
import ICAL from 'ical.js';
import { DateTime, IANAZone } from 'luxon';
import type { IanaZone } from '../../shared/types';
import type { Ctx } from './ctx';
import { HttpError } from './http';
import type { Interval } from './time';

type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalDuration = InstanceType<typeof ICAL.Duration>;
type IcalComponent = InstanceType<typeof ICAL.Component>;
type IcalTimezone = InstanceType<typeof ICAL.Timezone>;

const DAY_MS = 86_400_000;

// ───────────────────────── intervals ─────────────────────────

/** Sorted union of the given intervals. Empty, reversed and non-finite ones are dropped; touching ones are joined. */
export function mergeBusy(list: Interval[]): Interval[] {
  const sorted = list
    .filter((iv) => Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end > iv.start)
    .map((iv) => ({ start: iv.start, end: iv.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push(iv);
  }
  return out;
}

// ───────────────────────── URL guard ─────────────────────────

const MAX_URL_LENGTH = 2048;

/** Names that never belong to a public calendar host: special-use TLDs, private suffixes, loopback helpers. */
const BLOCKED_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'arpa',
  'test',
  'invalid',
  'example',
  'onion',
  // public DNS names that resolve to whatever address is written into them
  'nip.io',
  'sslip.io',
  'xip.io',
  'localtest.me',
  'lvh.me',
  'vcap.me',
];

function unsafeUrl(message: string): HttpError {
  return new HttpError(422, 'invalid_feed_url', message, { url: message });
}

/**
 * Validates a calendar feed address and returns it as a URL (`webcal://` becomes `https://`).
 * Allowed: https on the default port, a public-looking DNS name, no credentials.
 * Refused: every other scheme, IP literals in any notation, single-label hosts, localhost,
 * .local / .internal style names. We cannot pin DNS from here, so the https requirement carries
 * the rest: an internal address behind a crafted DNS name would still have to present a
 * certificate that is valid for that name.
 */
export function assertSafeFeedUrl(url: string): URL {
  if (typeof url !== 'string') throw unsafeUrl('Enter the address of a calendar feed.');
  let raw = url.trim();
  if (raw === '' || raw.length > MAX_URL_LENGTH) throw unsafeUrl('Enter the address of a calendar feed.');
  if (/[\s\u0000-\u001F\u007F\\]/.test(raw)) throw unsafeUrl('That calendar address contains characters that are not allowed.');
  raw = raw.replace(/^webcals?:\/\//i, 'https://');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw unsafeUrl('That does not look like a calendar address.');
  }
  if (parsed.protocol !== 'https:') throw unsafeUrl('Calendar feeds must use a secure https address.');
  if (parsed.username !== '' || parsed.password !== '') throw unsafeUrl('Calendar addresses with a user name or password in them are not supported.');
  if (parsed.port !== '' && parsed.port !== '443') throw unsafeUrl('Calendar feeds must use the standard https port.');

  // The URL parser has already lower-cased the name and rewritten every numeric spelling
  // (decimal, hex, octal, short forms) into a plain dotted address, so isIP sees them all.
  const host = parsed.hostname.replace(/\.$/, '');
  if (host === '' || host.length > 253) throw unsafeUrl('That does not look like a calendar address.');
  if (host.startsWith('[') || isIP(host) !== 0) throw unsafeUrl('Calendar feeds must use a domain name, not an IP address.');
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => l.length === 0 || l.length > 63)) throw unsafeUrl('Calendar feeds must use a public domain name.');
  if (!/^(?:xn--[a-z0-9-]+|[a-z]{2,63})$/.test(labels[labels.length - 1])) throw unsafeUrl('Calendar feeds must use a public domain name.');
  if (BLOCKED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) throw unsafeUrl('Calendar feeds must use a public domain name.');

  parsed.hash = '';
  return parsed;
}

// ───────────────────────── parsing ─────────────────────────

export interface IcsParseOptions {
  /**
   * The host's zone. All-day events block "the whole day" in it, and times without a usable zone
   * (floating, or a TZID nobody can place) are read in it when the feed names no zone of its own
   * (X-WR-TIMEZONE). Default UTC.
   */
  timezone?: IanaZone;
}

export interface IcsParseResult {
  busy: Interval[];
  /** VEVENT components seen */
  events: number;
  /** events (or parts of events) that could not be read and were left out */
  skipped: number;
  /** true when the feed was too large or too dense to expand completely: `busy` is then incomplete */
  truncated: boolean;
  /**
   * true when a repeating event that blocks time could not be expanded (its rule is unreadable, or
   * expanding it failed): its later occurrences are unknown, so `busy` is incomplete
   */
  incomplete: boolean;
}

/** Above this the text is not parsed at all (fetchIcsBusy never hands over more than 5 MB). */
const MAX_ICS_CHARS = 6_000_000;
/** Recurrence steps we are willing to walk, per event and per feed (one step costs roughly 15 µs). */
const MAX_STEPS_PER_EVENT = 20_000;
const MAX_STEPS_PER_FEED = 120_000;
/** Wall-clock values are compared without their zone first; no zone is further than this from UTC. */
const ZONE_SLACK_MS = 2 * DAY_MS;

interface ParseState {
  range: Interval;
  /** the host's zone */
  allDayZone: string;
  /** where floating and unplaceable times are read: the calendar's X-WR-TIMEZONE, else the host's zone */
  floatingZone: string;
  out: Interval[];
  steps: number;
  events: number;
  skipped: number;
  truncated: boolean;
  incomplete: boolean;
  usableZones: WeakMap<object, boolean>;
  ianaNames: Map<string, string | null>;
  /** jCal of events the salvage parser could only keep without their RRULE / RDATE lines */
  lostSeries: WeakSet<object>;
}

/**
 * Windows time zone names (what Outlook and Exchange write as TZID) to IANA zones, after the CLDR
 * windowsZones table ("001" territory). Only used when the feed carries no usable VTIMEZONE.
 */
const WINDOWS_ZONES: Record<string, string> = {
  'dateline standard time': 'Etc/GMT+12',
  'utc-11': 'Etc/GMT+11',
  'aleutian standard time': 'America/Adak',
  'hawaiian standard time': 'Pacific/Honolulu',
  'marquesas standard time': 'Pacific/Marquesas',
  'alaskan standard time': 'America/Anchorage',
  'utc-09': 'Etc/GMT+9',
  'pacific standard time (mexico)': 'America/Tijuana',
  'utc-08': 'Etc/GMT+8',
  'pacific standard time': 'America/Los_Angeles',
  'us mountain standard time': 'America/Phoenix',
  'mountain standard time (mexico)': 'America/Mazatlan',
  'mountain standard time': 'America/Denver',
  'yukon standard time': 'America/Whitehorse',
  'central america standard time': 'America/Guatemala',
  'central standard time': 'America/Chicago',
  'easter island standard time': 'Pacific/Easter',
  'central standard time (mexico)': 'America/Mexico_City',
  'canada central standard time': 'America/Regina',
  'sa pacific standard time': 'America/Bogota',
  'eastern standard time (mexico)': 'America/Cancun',
  'eastern standard time': 'America/New_York',
  'haiti standard time': 'America/Port-au-Prince',
  'cuba standard time': 'America/Havana',
  'us eastern standard time': 'America/Indiana/Indianapolis',
  'turks and caicos standard time': 'America/Grand_Turk',
  'paraguay standard time': 'America/Asuncion',
  'atlantic standard time': 'America/Halifax',
  'venezuela standard time': 'America/Caracas',
  'central brazilian standard time': 'America/Cuiaba',
  'sa western standard time': 'America/La_Paz',
  'pacific sa standard time': 'America/Santiago',
  'newfoundland standard time': 'America/St_Johns',
  'tocantins standard time': 'America/Araguaina',
  'e. south america standard time': 'America/Sao_Paulo',
  'sa eastern standard time': 'America/Cayenne',
  'argentina standard time': 'America/Argentina/Buenos_Aires',
  'montevideo standard time': 'America/Montevideo',
  'magallanes standard time': 'America/Punta_Arenas',
  'saint pierre standard time': 'America/Miquelon',
  'bahia standard time': 'America/Bahia',
  'utc-02': 'Etc/GMT+2',
  'azores standard time': 'Atlantic/Azores',
  'cape verde standard time': 'Atlantic/Cape_Verde',
  utc: 'UTC',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'sao tome standard time': 'Africa/Sao_Tome',
  'morocco standard time': 'Africa/Casablanca',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'romance standard time': 'Europe/Paris',
  'central european standard time': 'Europe/Warsaw',
  'w. central africa standard time': 'Africa/Lagos',
  'jordan standard time': 'Asia/Amman',
  'gtb standard time': 'Europe/Bucharest',
  'middle east standard time': 'Asia/Beirut',
  'egypt standard time': 'Africa/Cairo',
  'e. europe standard time': 'Europe/Chisinau',
  'syria standard time': 'Asia/Damascus',
  'west bank standard time': 'Asia/Hebron',
  'south africa standard time': 'Africa/Johannesburg',
  'fle standard time': 'Europe/Kiev',
  'israel standard time': 'Asia/Jerusalem',
  'south sudan standard time': 'Africa/Juba',
  'kaliningrad standard time': 'Europe/Kaliningrad',
  'sudan standard time': 'Africa/Khartoum',
  'libya standard time': 'Africa/Tripoli',
  'namibia standard time': 'Africa/Windhoek',
  'arabic standard time': 'Asia/Baghdad',
  'turkey standard time': 'Europe/Istanbul',
  'arab standard time': 'Asia/Riyadh',
  'belarus standard time': 'Europe/Minsk',
  'russian standard time': 'Europe/Moscow',
  'e. africa standard time': 'Africa/Nairobi',
  'volgograd standard time': 'Europe/Volgograd',
  'iran standard time': 'Asia/Tehran',
  'arabian standard time': 'Asia/Dubai',
  'astrakhan standard time': 'Europe/Astrakhan',
  'azerbaijan standard time': 'Asia/Baku',
  'russia time zone 3': 'Europe/Samara',
  'mauritius standard time': 'Indian/Mauritius',
  'saratov standard time': 'Europe/Saratov',
  'georgian standard time': 'Asia/Tbilisi',
  'caucasus standard time': 'Asia/Yerevan',
  'afghanistan standard time': 'Asia/Kabul',
  'west asia standard time': 'Asia/Tashkent',
  'ekaterinburg standard time': 'Asia/Yekaterinburg',
  'pakistan standard time': 'Asia/Karachi',
  'india standard time': 'Asia/Kolkata',
  'sri lanka standard time': 'Asia/Colombo',
  'nepal standard time': 'Asia/Kathmandu',
  'bangladesh standard time': 'Asia/Dhaka',
  'omsk standard time': 'Asia/Omsk',
  'myanmar standard time': 'Asia/Yangon',
  'se asia standard time': 'Asia/Bangkok',
  'altai standard time': 'Asia/Barnaul',
  'w. mongolia standard time': 'Asia/Hovd',
  'north asia standard time': 'Asia/Krasnoyarsk',
  'n. central asia standard time': 'Asia/Novosibirsk',
  'tomsk standard time': 'Asia/Tomsk',
  'china standard time': 'Asia/Shanghai',
  'north asia east standard time': 'Asia/Irkutsk',
  'singapore standard time': 'Asia/Singapore',
  'w. australia standard time': 'Australia/Perth',
  'taipei standard time': 'Asia/Taipei',
  'ulaanbaatar standard time': 'Asia/Ulaanbaatar',
  'aus central w. standard time': 'Australia/Eucla',
  'transbaikal standard time': 'Asia/Chita',
  'tokyo standard time': 'Asia/Tokyo',
  'north korea standard time': 'Asia/Pyongyang',
  'korea standard time': 'Asia/Seoul',
  'yakutsk standard time': 'Asia/Yakutsk',
  'cen. australia standard time': 'Australia/Adelaide',
  'aus central standard time': 'Australia/Darwin',
  'e. australia standard time': 'Australia/Brisbane',
  'aus eastern standard time': 'Australia/Sydney',
  'west pacific standard time': 'Pacific/Port_Moresby',
  'tasmania standard time': 'Australia/Hobart',
  'vladivostok standard time': 'Asia/Vladivostok',
  'lord howe standard time': 'Australia/Lord_Howe',
  'bougainville standard time': 'Pacific/Bougainville',
  'russia time zone 10': 'Asia/Srednekolymsk',
  'magadan standard time': 'Asia/Magadan',
  'norfolk standard time': 'Pacific/Norfolk',
  'sakhalin standard time': 'Asia/Sakhalin',
  'central pacific standard time': 'Pacific/Guadalcanal',
  'russia time zone 11': 'Asia/Kamchatka',
  'new zealand standard time': 'Pacific/Auckland',
  'utc+12': 'Etc/GMT-12',
  'fiji standard time': 'Pacific/Fiji',
  'chatham islands standard time': 'Pacific/Chatham',
  'utc+13': 'Etc/GMT-13',
  'tonga standard time': 'Pacific/Tongatapu',
  'samoa standard time': 'Pacific/Apia',
  'line islands standard time': 'Pacific/Kiritimati',
};

/** The IANA zone a Windows zone name stands for, or null. Exported for tests. */
export function windowsZoneToIana(name: string): string | null {
  const key = String(name ?? '')
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const iana = Object.prototype.hasOwnProperty.call(WINDOWS_ZONES, key) ? WINDOWS_ZONES[key] : null;
  return iana && IANAZone.isValidZone(iana) ? iana : null;
}

interface TimeValue {
  time: IcalTime;
  /** TZID parameter of the property the value came from */
  tzid: string | null;
}

function utcFieldsMs(t: IcalTime): number {
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
}

/** A VTIMEZONE is only worth trusting when it actually defines an offset. */
function vtimezoneUsable(zone: IcalTimezone, st: ParseState): boolean {
  const known = st.usableZones.get(zone);
  if (known !== undefined) return known;
  let usable = false;
  try {
    const comp = zone.component;
    usable = !!comp && comp.getAllSubcomponents('standard').length + comp.getAllSubcomponents('daylight').length > 0;
  } catch {
    usable = false;
  }
  st.usableZones.set(zone, usable);
  return usable;
}

/**
 * Maps a TZID to an IANA zone name luxon knows, including prefixed forms such as
 * "/mozilla.org/20050126_1/Europe/Berlin" and Windows names such as "Pacific Standard Time".
 */
function ianaNameOf(tzid: string, st: ParseState): string | null {
  const cached = st.ianaNames.get(tzid);
  if (cached !== undefined) return cached;
  const cleaned = tzid.trim().replace(/^"+|"+$/g, '');
  const candidates = [cleaned];
  const segments = cleaned.split('/').filter((s) => s !== '');
  for (const n of [3, 2, 1]) {
    if (segments.length > n) candidates.push(segments.slice(-n).join('/'));
  }
  let found: string | null = null;
  for (const c of candidates) {
    if (c !== '' && c.length <= 64 && IANAZone.isValidZone(c)) {
      found = c;
      break;
    }
  }
  if (!found && cleaned.length <= 64) found = windowsZoneToIana(cleaned);
  st.ianaNames.set(tzid, found);
  return found;
}

/** The time a wall-clock value names in `zone`, or null when the zone cannot be used. */
function wallClockIn(t: IcalTime, zone: string): number | null {
  const dt = DateTime.fromObject({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }, { zone });
  return dt.isValid ? dt.toMillis() : null;
}

/** The zone a calendar says its times are in (X-WR-TIMEZONE), when it names one we can place. */
function calendarZone(calendar: IcalComponent, st: ParseState): string | null {
  try {
    const value = calendar.getFirstPropertyValue('x-wr-timezone');
    return typeof value === 'string' && value.trim() !== '' ? ianaNameOf(value, st) : null;
  } catch {
    return null;
  }
}

function dayStartMs(year: number, month: number, day: number, zone: string): number {
  const dt = DateTime.fromObject({ year, month, day }, { zone });
  return dt.isValid ? dt.toMillis() : Date.UTC(year, month - 1, day);
}

/**
 * Absolute instant of an iCalendar time.
 *   DATE value            : start of that day in the all-day zone (the host's)
 *   UTC ("Z")             : as written
 *   TZID with VTIMEZONE   : the feed's own definition
 *   TZID without one      : luxon, when the name is an IANA zone or a Windows zone name
 *   anything else         : floating (RFC 5545: the local time of whoever reads it), and TZIDs
 *                           nobody can place: the calendar's X-WR-TIMEZONE when it names a zone,
 *                           else the host's zone. Reading them as UTC would put them hours off.
 */
function toMs(t: IcalTime, tzid: string | null, st: ParseState): number {
  if (t.isDate) return dayStartMs(t.year, t.month, t.day, st.allDayZone);
  const wall = utcFieldsMs(t);
  const zone = t.zone;
  if (zone === ICAL.Timezone.utcTimezone) return wall;
  if (zone && zone !== ICAL.Timezone.localTimezone && vtimezoneUsable(zone, st)) {
    try {
      const offsetSec = zone.utcOffset(t);
      if (Number.isFinite(offsetSec)) return wall - offsetSec * 1000;
    } catch {
      // fall through to the name-based lookup
    }
  }
  const name = tzid ?? (zone && zone !== ICAL.Timezone.localTimezone ? zone.tzid : null);
  const iana = name ? ianaNameOf(name, st) : null;
  if (iana) {
    const placed = wallClockIn(t, iana);
    if (placed !== null) return placed;
  }
  return wallClockIn(t, st.floatingZone) ?? wall;
}

function readTime(comp: IcalComponent, name: string): TimeValue | null {
  const prop = comp.getFirstProperty(name);
  if (!prop) return null;
  const value = prop.getFirstValue();
  if (!(value instanceof ICAL.Time)) return null;
  const tzid = prop.getFirstParameter('tzid');
  return { time: value, tzid: typeof tzid === 'string' && tzid !== '' ? tzid : null };
}

/**
 * Some producers write DTEND, EXDATE or RECURRENCE-ID without the TZID that DTSTART carries.
 * Such a value means "same zone as the start", not "floating".
 */
function inContextOf(v: TimeValue, start: TimeValue): TimeValue {
  if (v.time.isDate || v.tzid !== null || v.time.zone !== ICAL.Timezone.localTimezone) return v;
  if (start.time.isDate || (start.tzid === null && start.time.zone === ICAL.Timezone.localTimezone)) return v;
  const time = v.time.clone();
  time.zone = start.time.zone;
  return { time, tzid: start.tzid };
}

function upperValue(comp: IcalComponent, name: string): string {
  const v = comp.getFirstPropertyValue(name);
  return typeof v === 'string' ? v.trim().toUpperCase() : '';
}

/** Cancelled events and events marked "free" do not block time. */
function isBlocking(comp: IcalComponent): boolean {
  if (upperValue(comp, 'status') === 'CANCELLED') return false;
  if (upperValue(comp, 'transp') === 'TRANSPARENT') return false;
  if (upperValue(comp, 'x-microsoft-cdo-busystatus') === 'FREE') return false;
  return true;
}

interface EventSpan {
  start: TimeValue;
  startMs: number;
  endMs: number;
  /** added to each occurrence's wall-clock start to get its end */
  duration: IcalDuration;
}

function spanOf(comp: IcalComponent, st: ParseState): EventSpan | null {
  const start = readTime(comp, 'dtstart');
  if (!start) return null;
  const startMs = toMs(start.time, start.tzid, st);
  if (!Number.isFinite(startMs)) return null;

  const rawEnd = readTime(comp, 'dtend');
  const durationValue = comp.getFirstPropertyValue('duration');
  const explicit = durationValue instanceof ICAL.Duration && !durationValue.isNegative ? durationValue : null;

  let endMs = startMs;
  // Length on the clock face, when start and end are written in the same zone. Repeating that
  // (rather than the elapsed time) keeps "09:00 to 10:00" intact when the first instance of a
  // series happens to sit on a daylight-saving change.
  let wallSeconds = 0;
  if (rawEnd) {
    const end = inContextOf(rawEnd, start);
    endMs = toMs(end.time, end.tzid, st);
    if (!start.time.isDate && !end.time.isDate && end.time.zone === start.time.zone && end.tzid === start.tzid) {
      wallSeconds = Math.round((utcFieldsMs(end.time) - utcFieldsMs(start.time)) / 1000);
    }
  } else if (explicit) {
    const end = start.time.clone();
    end.addDuration(explicit);
    endMs = toMs(end, start.tzid, st);
  }

  if (start.time.isDate) {
    // All-day: whole days, at least one (a missing or broken DTEND means "that day").
    let days = 1;
    if (rawEnd && rawEnd.time.isDate) days = Math.round((utcFieldsMs(rawEnd.time) - utcFieldsMs(start.time)) / DAY_MS);
    else if (explicit) days = Math.ceil(explicit.toSeconds() / 86_400);
    if (!Number.isFinite(days) || days < 1) days = 1;
    const end = start.time.clone();
    end.adjust(days, 0, 0, 0);
    return { start, startMs, endMs: toMs(end, null, st), duration: ICAL.Duration.fromSeconds(days * 86_400) };
  }

  if (!Number.isFinite(endMs) || endMs < startMs) endMs = startMs;
  const seconds = wallSeconds > 0 ? wallSeconds : Math.round((endMs - startMs) / 1000);
  return { start, startMs, endMs, duration: explicit ?? ICAL.Duration.fromSeconds(seconds) };
}

function addBusy(st: ParseState, start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  if (end <= st.range.start || start >= st.range.end) return;
  st.out.push({ start: Math.max(start, st.range.start), end: Math.min(end, st.range.end) });
}

function dateKey(t: IcalTime): string {
  return `${t.year}-${t.month}-${t.day}`;
}

/**
 * Keys under which an excluded or replaced occurrence can be recognised: the exact instant for
 * timed values, the calendar date for DATE values, and the written date as a last resort
 * (producers do mix DATE and DATE-TIME between DTSTART and EXDATE).
 */
function exclusionKeys(v: TimeValue, st: ParseState): (string | number)[] {
  if (v.time.isDate) return [`d:${dateKey(v.time)}`];
  return [toMs(v.time, v.tzid, st), `w:${dateKey(v.time)}`];
}

function isExcluded(occ: IcalTime, occMs: number, excluded: Set<string | number>): boolean {
  if (excluded.size === 0) return false;
  if (occ.isDate) return excluded.has(`d:${dateKey(occ)}`) || excluded.has(`w:${dateKey(occ)}`);
  return excluded.has(occMs) || excluded.has(`d:${dateKey(occ)}`);
}

interface RangeOverride {
  fromMs: number;
  shiftMs: number;
  durationMs: number;
  blocking: boolean;
}

/**
 * Decides where to start walking a recurrence. Walking from DTSTART is always correct but slow
 * for old series, so two shortcuts are taken when they are provably safe:
 *   'none'  : the rule ended (UNTIL) before the window, nothing to walk
 *   a Time  : for plain DAILY / WEEKLY rules without COUNT, a start moved forward by a whole
 *             number of periods (7 x INTERVAL days keeps weekday, week phase and wall time)
 *   null    : walk from DTSTART
 */
function walkStart(master: IcalComponent, span: EventSpan, horizonWallMs: number): IcalTime | 'none' | null {
  if (master.hasProperty('rdate')) return null;
  const rules = master.getAllProperties('rrule');
  if (rules.length !== 1) return null;
  const rule = rules[0].getFirstValue();
  if (!(rule instanceof ICAL.Recur)) return null;
  if (rule.until && utcFieldsMs(rule.until) + DAY_MS < horizonWallMs) return 'none';
  if (rule.count) return null;
  if (rule.freq !== 'DAILY' && rule.freq !== 'WEEKLY') return null;
  for (const [part, values] of Object.entries(rule.parts ?? {})) {
    if (part !== 'BYDAY') return null;
    if (!Array.isArray(values) || values.some((d) => !/^(?:SU|MO|TU|WE|TH|FR|SA)$/.test(String(d)))) return null;
  }
  const interval = Number.isInteger(rule.interval) && rule.interval >= 1 ? rule.interval : 1;
  const periodDays = 7 * interval;
  const periods = Math.floor((horizonWallMs - utcFieldsMs(span.start.time)) / (periodDays * DAY_MS));
  if (periods < 1) return null;
  const shifted = span.start.time.clone();
  shifted.adjust(periods * periodDays, 0, 0, 0);
  return shifted;
}

/** Whether occurrences of a series that starts here can fall inside the window at all. */
function mayReachWindow(span: EventSpan, st: ParseState): boolean {
  return span.startMs < st.range.end + ZONE_SLACK_MS;
}

interface PeriodValue {
  start: TimeValue;
  end: TimeValue;
}

/**
 * RDATE;VALUE=PERIOD values carry their own end (or length), which the recurrence expander cannot
 * handle. They are taken off the event here and placed on their own.
 */
function takeRdatePeriods(master: IcalComponent, start: TimeValue): PeriodValue[] {
  const out: PeriodValue[] = [];
  for (const prop of master.getAllProperties('rdate')) {
    const values = prop.getValues();
    if (!values.some((v) => v instanceof ICAL.Period)) continue;
    const raw = prop.getFirstParameter('tzid');
    const tzid = typeof raw === 'string' && raw !== '' ? raw : null;
    for (const v of values) {
      if (!(v instanceof ICAL.Period)) continue;
      out.push({ start: inContextOf({ time: v.start, tzid }, start), end: inContextOf({ time: v.getEnd(), tzid }, start) });
    }
    master.removeProperty(prop);
  }
  return out;
}

function expandMaster(master: IcalComponent, overrides: IcalComponent[], st: ParseState): void {
  const span = spanOf(master, st);
  if (!span) {
    st.skipped++;
    return;
  }
  const blocking = isBlocking(master);
  // The salvage parser could only keep the first instance: the rest of the series is unknown.
  if (st.lostSeries.has(master.jCal) && blocking && mayReachWindow(span, st)) st.incomplete = true;
  let periods: PeriodValue[];
  try {
    periods = takeRdatePeriods(master, span.start);
  } catch (err) {
    if (blocking && mayReachWindow(span, st)) st.incomplete = true;
    throw err;
  }
  if (!master.hasProperty('rrule') && !master.hasProperty('rdate') && periods.length === 0) {
    if (blocking) addBusy(st, span.startMs, span.endMs);
    return;
  }

  // Replaced instances are added on their own (see collectBusy); here they only need to be left out.
  const excluded = new Set<string | number>();
  const rangeOverrides: RangeOverride[] = [];
  for (const ov of overrides) {
    try {
      const rawId = readTime(ov, 'recurrence-id');
      if (!rawId) continue;
      const id = inContextOf(rawId, span.start);
      for (const key of exclusionKeys(id, st)) excluded.add(key);
      const rangeParam = ov.getFirstProperty('recurrence-id')?.getFirstParameter('range');
      if (typeof rangeParam === 'string' && rangeParam.toUpperCase() === 'THISANDFUTURE') {
        const ovSpan = spanOf(ov, st);
        const fromMs = toMs(id.time, id.tzid, st);
        if (ovSpan) rangeOverrides.push({ fromMs, shiftMs: ovSpan.startMs - fromMs, durationMs: ovSpan.endMs - ovSpan.startMs, blocking: isBlocking(ov) });
      }
    } catch {
      st.skipped++;
    }
  }
  rangeOverrides.sort((a, b) => a.fromMs - b.fromMs);
  if (!blocking && !rangeOverrides.some((r) => r.blocking)) return;

  for (const prop of master.getAllProperties('exdate')) {
    try {
      const tzid = prop.getFirstParameter('tzid');
      for (const value of prop.getValues()) {
        if (!(value instanceof ICAL.Time)) continue;
        const v = inContextOf({ time: value, tzid: typeof tzid === 'string' && tzid !== '' ? tzid : null }, span.start);
        for (const key of exclusionKeys(v, st)) excluded.add(key);
      }
    } catch {
      // An unreadable exclusion list leaves its dates blocked, which errs on the safe side. It is
      // taken off the event, or the expander below would trip over it and lose the whole series.
      st.skipped++;
      master.removeProperty(prop);
    }
  }

  /** One occurrence starting at occ (occMs), unless it was excluded, replaced or moved by THISANDFUTURE. */
  const place = (occ: IcalTime, occMs: number, endMs: () => number): void => {
    if (isExcluded(occ, occMs, excluded)) return;
    let moved: RangeOverride | null = null;
    for (const r of rangeOverrides) {
      if (r.fromMs <= occMs) moved = r;
      else break;
    }
    if (moved) {
      if (moved.blocking) addBusy(st, occMs + moved.shiftMs, occMs + moved.shiftMs + moved.durationMs);
      return;
    }
    if (blocking) addBusy(st, occMs, endMs());
  };
  const emit = (occ: IcalTime): void => {
    place(occ, toMs(occ, span.start.tzid, st), () => {
      const end = occ.clone();
      end.addDuration(span.duration);
      return toMs(end, span.start.tzid, st);
    });
  };

  // DTSTART is the first instance of the set even when a rule or the RDATE list does not repeat it.
  emit(span.start.time);
  for (const p of periods) place(p.start.time, toMs(p.start.time, p.start.tzid, st), () => toMs(p.end.time, p.end.tzid, st));
  if (!master.hasProperty('rrule') && !master.hasProperty('rdate')) return;

  let longestMs = Math.max(0, span.endMs - span.startMs);
  let latestShift = 0;
  let earliestShift = 0;
  for (const r of rangeOverrides) {
    longestMs = Math.max(longestMs, r.durationMs);
    latestShift = Math.max(latestShift, r.shiftMs);
    earliestShift = Math.min(earliestShift, r.shiftMs);
  }
  // Compared against wall-clock values read as UTC, hence the slack on both sides.
  const notBefore = st.range.start - longestMs - latestShift - ZONE_SLACK_MS;
  const notAfter = st.range.end - earliestShift + ZONE_SLACK_MS;

  try {
    const from = walkStart(master, span, notBefore - DAY_MS);
    if (from === 'none') return;
    const expansion = new ICAL.RecurExpansion({ component: master, dtstart: from ?? span.start.time });
    for (let steps = 0; ; steps++) {
      if (steps >= MAX_STEPS_PER_EVENT || st.steps >= MAX_STEPS_PER_FEED) {
        st.truncated = true;
        return;
      }
      const next = expansion.next();
      if (!next) return;
      st.steps++;
      const wall = utcFieldsMs(next);
      if (wall > notAfter) return;
      if (wall < notBefore) continue;
      emit(next);
    }
  } catch (err) {
    // A series that blocks time and could not be walked: its later occurrences are unknown, and
    // reading them as free would offer times the host is busy. An event that blocks nothing costs nothing.
    if ((blocking || rangeOverrides.some((r) => r.blocking)) && mayReachWindow(span, st)) st.incomplete = true;
    throw err;
  }
}

function uidOf(comp: IcalComponent, fallback: string): string {
  try {
    const uid = comp.getFirstPropertyValue('uid');
    return typeof uid === 'string' && uid !== '' ? uid : fallback;
  } catch {
    return fallback;
  }
}

function collectBusy(calendar: IcalComponent, st: ParseState): void {
  st.floatingZone = calendarZone(calendar, st) ?? st.allDayZone;
  const groups = new Map<string, { masters: IcalComponent[]; overrides: IcalComponent[] }>();
  calendar.getAllSubcomponents('vevent').forEach((ev, i) => {
    st.events++;
    const uid = uidOf(ev, `\u0000no-uid-${i}`);
    let group = groups.get(uid);
    if (!group) {
      group = { masters: [], overrides: [] };
      groups.set(uid, group);
    }
    (ev.hasProperty('recurrence-id') ? group.overrides : group.masters).push(ev);
  });

  for (const group of groups.values()) {
    for (const master of group.masters) {
      try {
        expandMaster(master, group.overrides, st);
      } catch {
        // A broken rule or value costs this one event, not the feed.
        st.skipped++;
      }
    }
    // A replaced instance is a complete event of its own. Feeds may also carry one without its
    // series (an invitation to a single occurrence), which is handled the same way.
    for (const ov of group.overrides) {
      try {
        if (!isBlocking(ov)) continue;
        const span = spanOf(ov, st);
        if (span) addBusy(st, span.startMs, span.endMs);
        else st.skipped++;
      } catch {
        st.skipped++;
      }
    }
  }
}

/** Joins folded lines (RFC 5545 §3.1) and splits on any line ending. */
function unfoldLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

const TIMING_LINE = /^(?:BEGIN|END|UID|DTSTART|DTEND|DURATION|STATUS|TRANSP|RECURRENCE-ID|RRULE|RDATE|EXDATE|X-MICROSOFT-CDO-BUSYSTATUS)[;:]/i;
const RECURRENCE_LINE = /^(?:RRULE|RDATE|EXDATE)[;:]/i;
const SERIES_LINE = /^(?:RRULE|RDATE)[;:]/i;
const EXDATE_LINE = /^EXDATE[;:]/i;

/** Parses one component on its own and returns it as jCal, or null when the strict parser refuses it. */
function parseBlock(lines: string[]): unknown[] | null {
  try {
    const jcal: unknown = ICAL.parse(`BEGIN:VCALENDAR\r\n${lines.join('\r\n')}\r\nEND:VCALENDAR\r\n`);
    return Array.isArray(jcal) && jcal[0] === 'vcalendar' && Array.isArray(jcal[2]) ? (jcal[2] as unknown[]) : null;
  } catch {
    return null;
  }
}

/**
 * Fallback for feeds the strict parser rejects as a whole: cut out every VTIMEZONE and VEVENT block,
 * drop lines that are not content lines and nested components (alarms), and parse each block
 * alone, so one broken event cannot take the others with it.
 */
function salvage(text: string, st: ParseState): IcalComponent[] {
  const blocks: string[][] = [];
  let current: { kind: string; lines: string[]; depth: number; skipDepth: number } | null = null;
  // The calendar's own zone is a property of VCALENDAR itself, outside every block.
  let calendarZoneName = '';
  for (const line of unfoldLines(text)) {
    const marker = /^(BEGIN|END):\s*([A-Za-z0-9-]+)\s*$/i.exec(line);
    const name = marker ? marker[2].toUpperCase() : '';
    const isBegin = !!marker && marker[1].toUpperCase() === 'BEGIN';
    if (!current) {
      if (isBegin && (name === 'VEVENT' || name === 'VTIMEZONE')) current = { kind: name, lines: [`BEGIN:${name}`], depth: 0, skipDepth: 0 };
      else if (calendarZoneName === '' && /^X-WR-TIMEZONE[;:]/i.test(line)) calendarZoneName = line.slice(line.indexOf(':') + 1).trim().slice(0, 64);
      continue;
    }
    if (marker && isBegin) {
      if (name === current.kind) {
        // the previous block never ended: give it up and start over with this one
        st.skipped++;
        current = { kind: name, lines: [`BEGIN:${name}`], depth: 0, skipDepth: 0 };
      } else if (current.kind === 'VEVENT' || current.skipDepth > 0) {
        current.skipDepth++;
      } else {
        current.depth++;
        current.lines.push(`BEGIN:${name}`);
      }
      continue;
    }
    if (marker) {
      if (current.skipDepth > 0) {
        current.skipDepth--;
      } else if (current.depth > 0) {
        current.depth--;
        current.lines.push(`END:${name}`);
      } else if (name === current.kind) {
        current.lines.push(`END:${name}`);
        blocks.push(current.lines);
        current = null;
      } else {
        st.skipped++;
        current = null;
      }
      continue;
    }
    if (current.skipDepth === 0 && /^[A-Za-z0-9-]+[;:]/.test(line)) current.lines.push(line);
  }
  if (current) st.skipped++;

  const subcomponents: unknown[] = [];
  for (const lines of blocks) {
    let parsed = parseBlock(lines);
    if (!parsed && lines[0] === 'BEGIN:VEVENT') {
      // Second try with only the lines that decide busy time. Third try without the exclusions,
      // which only ever adds busy time. Last try without the recurrence: that keeps the first
      // instance of a series whose rule is unreadable, and the series is marked as lost.
      const timing = lines.filter((l) => TIMING_LINE.test(l));
      parsed = parseBlock(timing);
      if (!parsed && timing.some((l) => EXDATE_LINE.test(l))) {
        parsed = parseBlock(timing.filter((l) => !EXDATE_LINE.test(l)));
        if (parsed) st.skipped++;
      }
      if (!parsed) {
        parsed = parseBlock(timing.filter((l) => !RECURRENCE_LINE.test(l)));
        if (parsed) {
          st.skipped++;
          if (timing.some((l) => SERIES_LINE.test(l))) for (const c of parsed) if (typeof c === 'object' && c !== null) st.lostSeries.add(c);
        }
      }
    }
    if (parsed) subcomponents.push(...parsed);
    else st.skipped++;
  }
  const properties = calendarZoneName === '' ? [] : [['x-wr-timezone', {}, 'text', calendarZoneName]];
  return subcomponents.length > 0 ? [new ICAL.Component(['vcalendar', properties, subcomponents])] : [];
}

function loadCalendars(text: string, st: ParseState): IcalComponent[] {
  let parsed: unknown;
  try {
    parsed = ICAL.parse(text);
  } catch {
    return salvage(text, st);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return [];
  const roots: unknown[] = typeof parsed[0] === 'string' ? [parsed] : parsed;
  const calendars: IcalComponent[] = [];
  const loose: unknown[] = [];
  for (const root of roots) {
    if (!Array.isArray(root) || typeof root[0] !== 'string') continue;
    if (root[0] === 'vcalendar') calendars.push(new ICAL.Component(root));
    else if (root[0] === 'vevent' || root[0] === 'vtimezone') loose.push(root);
  }
  // events that were published without the VCALENDAR wrapper
  if (loose.length > 0) calendars.push(new ICAL.Component(['vcalendar', [], loose]));
  return calendars;
}

/**
 * Like parseIcsBusy, with a report of what was left out. Does not throw for bad input:
 * unreadable events are counted in `skipped`, and `truncated` says the result is incomplete.
 */
export function parseIcsDetailed(icsText: string, range: Interval, opts?: IcsParseOptions): IcsParseResult {
  const zone = opts?.timezone;
  const hostZone = typeof zone === 'string' && zone.length <= 64 && IANAZone.isValidZone(zone) ? zone : 'UTC';
  const st: ParseState = {
    range: { start: Number(range?.start), end: Number(range?.end) },
    allDayZone: hostZone,
    floatingZone: hostZone,
    out: [],
    steps: 0,
    events: 0,
    skipped: 0,
    truncated: false,
    incomplete: false,
    usableZones: new WeakMap(),
    ianaNames: new Map(),
    lostSeries: new WeakSet(),
  };
  const result = (): IcsParseResult => ({ busy: mergeBusy(st.out), events: st.events, skipped: st.skipped, truncated: st.truncated, incomplete: st.incomplete });

  if (typeof icsText !== 'string' || !Number.isFinite(st.range.start) || !Number.isFinite(st.range.end) || st.range.end <= st.range.start) return result();
  if (icsText.length > MAX_ICS_CHARS) {
    st.truncated = true;
    return result();
  }
  try {
    const text = icsText.replace(/^﻿/, '').replace(/\u0000/g, '');
    for (const calendar of loadCalendars(text, st)) {
      try {
        collectBusy(calendar, st);
      } catch {
        st.skipped++;
      }
    }
  } catch {
    st.skipped++;
  }
  return result();
}

/**
 * Busy intervals (epoch ms, merged, clipped to `range`) of every event in an iCalendar text.
 * Recurrences, exclusions and replaced instances are expanded inside the range; cancelled and
 * "free" events are ignored. Never throws: whatever cannot be read is left out.
 */
export function parseIcsBusy(icsText: string, range: Interval, opts?: IcsParseOptions): Interval[] {
  try {
    return parseIcsDetailed(icsText, range, opts).busy;
  } catch {
    return [];
  }
}

// ───────────────────────── fetching ─────────────────────────

export interface IcsFetchOptions extends IcsParseOptions {
  /** total time for all redirect hops and the download; default 8 s */
  timeoutMs?: number;
  /** largest accepted body (after decompression); default 5 MB */
  maxBytes?: number;
}

/** A feed could not be loaded. The message is safe to show and never contains the feed address. */
export class IcsFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcsFeedError';
  }
}

const FETCH_TIMEOUT_MS = 8_000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // nothing to release
  }
}

async function readLimited(res: Response, maxBytes: number, guard: <T>(p: Promise<T>) => Promise<T>): Promise<string> {
  const tooLarge = (): IcsFeedError => new IcsFeedError(`The calendar feed is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(res);
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await guard(reader.read());
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) throw tooLarge();
        chunks.push(value);
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      throw err;
    }
  } else {
    const all = new Uint8Array(await guard(res.arrayBuffer()));
    if (all.byteLength > maxBytes) throw tooLarge();
    chunks.push(all);
    total = all.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * The text of a calendar feed: guarded download (https only, every redirect hop re-checked, size
 * and time limits). Throws HttpError (422) for an address that is not allowed and IcsFeedError when
 * the feed cannot be loaded. Callers that cache the text use this with busyFromIcsText.
 */
export async function downloadIcsFeed(ctx: Ctx, url: string, opts?: IcsFetchOptions): Promise<string> {
  const timeoutMs = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : FETCH_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : MAX_FEED_BYTES;
  let current = assertSafeFeedUrl(url);

  // One deadline for everything. Each wait is raced against it as well, so a transport that
  // ignores the abort signal still cannot hold the request open.
  const controller = new AbortController();
  const slow = new IcsFeedError('The calendar feed took too long to respond.');
  let expire: () => void = () => undefined;
  const expired = new Promise<never>((_, reject) => {
    expire = () => reject(slow);
  });
  expired.catch(() => undefined);
  const timer = setTimeout(() => {
    expire();
    controller.abort();
  }, timeoutMs);
  const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, expired]);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res: Response;
      try {
        res = await guard(
          ctx.fetch(current.href, {
            method: 'GET',
            redirect: 'manual',
            headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5', 'User-Agent': 'calendar-feed-reader/1.0' },
            signal: controller.signal,
          }),
        );
      } catch (err) {
        if (err === slow || controller.signal.aborted) throw slow;
        throw new IcsFeedError('The calendar feed could not be reached.');
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        await discardBody(res);
        if (!location) throw new IcsFeedError('The calendar feed redirected without saying where to.');
        try {
          // every hop goes through the same guard as the first address
          current = assertSafeFeedUrl(new URL(location, current).href);
        } catch {
          throw new IcsFeedError('The calendar feed redirected to an address that is not allowed.');
        }
        continue;
      }
      if (res.status !== 200) {
        await discardBody(res);
        throw new IcsFeedError(
          res.status === 401 || res.status === 403 || res.status === 404
            ? 'The calendar feed address is no longer valid or access was removed.'
            : `The calendar feed answered with an error (HTTP ${res.status || 'unknown'}).`,
        );
      }

      let text: string;
      try {
        text = await readLimited(res, maxBytes, guard);
      } catch (err) {
        if (err instanceof IcsFeedError) throw err;
        throw controller.signal.aborted ? slow : new IcsFeedError('The calendar feed could not be downloaded completely.');
      }
      // A sign-in page or an error page answered with 200 must not be mistaken for "no events".
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new IcsFeedError('That address did not return a calendar feed.');
      return text;
    }
    throw new IcsFeedError('The calendar feed redirected too many times.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads a feed and returns its busy intervals inside `range`. Throws HttpError (422) for an
 * address that is not allowed and IcsFeedError when the feed cannot be loaded or is too large to
 * expand completely: callers must treat that as "availability unknown", not as "free".
 */
export async function fetchIcsBusy(ctx: Ctx, url: string, range: Interval, opts?: IcsFetchOptions): Promise<Interval[]> {
  return busyFromIcsText(ctx, await downloadIcsFeed(ctx, url, opts), range, opts);
}

/**
 * Busy intervals of a downloaded feed inside `range`. Throws IcsFeedError when the answer would be
 * incomplete in a way that hides busy time: the feed is too large or too dense to expand, or a
 * repeating event that blocks time could not be expanded. Other unreadable events (no start, say)
 * are left out and logged, so one stray entry does not close the whole booking page.
 */
export function busyFromIcsText(ctx: Ctx, text: string, range: Interval, opts?: IcsParseOptions): Interval[] {
  const parsed = parseIcsDetailed(text, range, opts);
  if (parsed.truncated) throw new IcsFeedError('The calendar feed is too large to read completely.');
  if (parsed.incomplete) throw new IcsFeedError('The calendar feed has a repeating event that could not be read.');
  if (parsed.skipped > 0) ctx.log('warn', 'calendar feed: some events could not be read', { skipped: parsed.skipped, events: parsed.events });
  return parsed.busy;
}
