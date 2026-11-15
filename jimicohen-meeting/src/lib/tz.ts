/**
 * Time zone and date helpers for the browser. Everything goes through `Intl`, with the zone
 * always passed explicitly: never rely on the device zone except in detectZone().
 *
 * Vocabulary: an "instant" is a UTC point in time (epoch ms, ISO string or Date). A "day key"
 * is a calendar date `YYYY-MM-DD` in some zone. A "wall time" is `HH:MM` on such a day.
 */
import type { Weekday } from '../../shared/types';

export type Instant = number | string | Date;

export function toMs(t: Instant): number {
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t);
}

// ───────────── formatter cache ─────────────

const cache = new Map<string, Intl.DateTimeFormat>();

function dtf(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, options);
    } catch {
      // Unknown zone or locale: fall back to UTC in the default locale rather than crash a render.
      f = new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' });
    }
    cache.set(key, f);
  }
  return f;
}

// ───────────── detection ─────────────

export function isValidZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The device's IANA zone, e.g. "Africa/Nairobi". "UTC" when the browser will not say. */
export function detectZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isValidZone(zone)) return zone;
  } catch {
    // ignore
  }
  return 'UTC';
}

/** The visitor's preferred locale, e.g. "en-GB". */
export function detectLocale(): string {
  if (typeof navigator !== 'undefined') {
    const first = navigator.languages?.[0] ?? navigator.language;
    if (first) return first;
  }
  return 'en-US';
}

/** Does this locale write times with AM / PM? */
export function uses12h(locale?: string): boolean {
  try {
    const resolved = new Intl.DateTimeFormat(locale ?? detectLocale(), { hour: 'numeric' }).resolvedOptions() as Intl.ResolvedDateTimeFormatOptions & {
      hourCycle?: string;
    };
    if (resolved.hourCycle) return resolved.hourCycle === 'h12' || resolved.hourCycle === 'h11';
    return resolved.hour12 === true;
  } catch {
    return true;
  }
}

const SUNDAY_FIRST = new Set([
  'US', 'CA', 'MX', 'BR', 'AR', 'CO', 'PE', 'VE', 'CL', 'JP', 'KR', 'TW', 'HK', 'PH', 'IN', 'PK', 'BD', 'TH', 'ID', 'IL', 'SA', 'ZA', 'KE', 'ZW', 'AU',
]);
const SATURDAY_FIRST = new Set(['EG', 'AE', 'AF', 'IR', 'DZ', 'BH', 'IQ', 'JO', 'KW', 'LY', 'OM', 'QA', 'SY']);

/** First day of the week for a locale: 0 Sunday, 1 Monday, 6 Saturday. */
export function weekStartsOn(locale?: string): Weekday {
  const tag = locale ?? detectLocale();
  try {
    const loc = new Intl.Locale(tag) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    if (info && typeof info.firstDay === 'number') return (info.firstDay % 7) as Weekday;
    const region = loc.maximize().region;
    if (region) return SATURDAY_FIRST.has(region) ? 6 : SUNDAY_FIRST.has(region) ? 0 : 1;
  } catch {
    // ignore
  }
  return /-(US|CA)$/i.test(tag) || tag === 'en' ? 0 : 1;
}

// ───────────── zoned arithmetic ─────────────

export interface ZonedParts {
  year: number;
  /** 1..12 */
  month: number;
  day: number;
  /** 0..23 */
  hour: number;
  minute: number;
  second: number;
  weekday: Weekday;
}

const WEEKDAYS: Record<string, Weekday> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Calendar fields of an instant as seen on a wall clock in `zone`. */
export function zonedParts(t: Instant, zone: string): ZonedParts {
  const parts = dtf('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(toMs(t));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** Minutes east of UTC at that instant (Nairobi → 180, New York in winter → -300). */
export function zoneOffsetMinutes(zone: string, t: Instant = Date.now()): number {
  const ms = Math.floor(toMs(t) / 1000) * 1000;
  const p = zonedParts(ms, zone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms) / 60000);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function makeDayKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

export function parseDayKey(key: string): { year: number; month: number; day: number } {
  const [y, m, d] = key.split('-').map(Number);
  return { year: y, month: m, day: d };
}

/** The calendar date (`YYYY-MM-DD`) an instant falls on in `zone`. */
export function dayKey(t: Instant, zone: string): string {
  const p = zonedParts(t, zone);
  return makeDayKey(p.year, p.month, p.day);
}

/** Today's date in `zone`. */
export function todayKey(zone: string, now: Instant = Date.now()): string {
  return dayKey(now, zone);
}

/** Pure calendar math on a day key. */
export function addDays(key: string, n: number): string {
  const { year, month, day } = parseDayKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return makeDayKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function weekdayOfKey(key: string): Weekday {
  const { year, month, day } = parseDayKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() as Weekday;
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  const pa = parseDayKey(a);
  const pb = parseDayKey(b);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86400000);
}

/**
 * The instant at which a wall clock in `zone` shows `key` `time`.
 * A time skipped by a DST jump moves forward to the first valid instant. A repeated time
 * (clocks going back) resolves to its first occurrence.
 */
export function zonedToMs(key: string, time: string, zone: string): number {
  const { year, month, day } = parseDayKey(key);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hh || 0, mm || 0);
  const matches = (ms: number) => {
    const p = zonedParts(ms, zone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === guess;
  };
  const a = guess - zoneOffsetMinutes(zone, guess) * 60000;
  const b = guess - zoneOffsetMinutes(zone, a) * 60000;
  if (a === b) {
    // A repeated hour may have an earlier occurrence one hour (or 30 min) before.
    for (const back of [3600000, 1800000]) {
      if (matches(a - back)) return a - back;
    }
    return a;
  }
  const valid = [a, b].filter(matches);
  if (valid.length) return Math.min(...valid);
  return Math.max(a, b);
}

/** Midnight at the start of a day in `zone`. */
export function startOfDay(key: string, zone: string): number {
  return zonedToMs(key, '00:00', zone);
}

/** [from, to) covering one calendar month in `zone`. `month` is 1..12. */
export function monthRange(year: number, month: number, zone: string): { from: number; to: number } {
  const next = month === 12 ? makeDayKey(year + 1, 1, 1) : makeDayKey(year, month + 1, 1);
  return { from: startOfDay(makeDayKey(year, month, 1), zone), to: startOfDay(next, zone) };
}

export interface MonthCell {
  key: string;
  day: number;
  /** false for the leading / trailing days that belong to the neighbouring months */
  inMonth: boolean;
  weekday: Weekday;
}

/** Weeks of a month as rows of seven cells, starting on `weekStart`. `month` is 1..12. */
export function monthGrid(year: number, month: number, weekStart: Weekday = 0): MonthCell[][] {
  const first = makeDayKey(year, month, 1);
  const lead = (weekdayOfKey(first) - weekStart + 7) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows = Math.ceil((lead + daysInMonth) / 7);
  const weeks: MonthCell[][] = [];
  for (let r = 0; r < rows; r++) {
    const week: MonthCell[] = [];
    for (let c = 0; c < 7; c++) {
      const key = addDays(first, r * 7 + c - lead);
      const p = parseDayKey(key);
      week.push({ key, day: p.day, inMonth: p.month === month && p.year === year, weekday: ((weekStart + c) % 7) as Weekday });
    }
    weeks.push(week);
  }
  return weeks;
}

/** Shifts a year / month pair by `delta` months. `month` is 1..12. */
export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 };
}

// ───────────── formatting ─────────────

export interface TimeFormatOptions {
  /** true = 2:30 PM, false = 14:30, undefined = whatever the locale prefers */
  hour12?: boolean;
  locale?: string;
  /** compact writes "2:30pm" */
  style?: 'default' | 'compact';
}

function tidy(text: string): string {
  // ICU puts a narrow no-break space before AM/PM. A plain no-break space renders in every font.
  return text.replace(/ /g, ' ');
}

function timeOptions(zone: string, hour12: boolean | undefined): Intl.DateTimeFormatOptions {
  if (hour12 === undefined) return { timeZone: zone, hour: 'numeric', minute: '2-digit' };
  return hour12 ? { timeZone: zone, hour: 'numeric', minute: '2-digit', hourCycle: 'h12' } : { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
}

/** "2:30 PM" or "14:30", in `zone`. */
export function formatTime(t: Instant, zone: string, opts: TimeFormatOptions = {}): string {
  const text = tidy(dtf(opts.locale, timeOptions(zone, opts.hour12)).format(toMs(t)));
  return opts.style === 'compact' ? text.replace(/[\s ]+(?=[AaPp]\.?[Mm]\.?$)/, '').replace(/[AP]M$/, (m) => m.toLowerCase()) : text;
}

/** "2:30 – 3:00 PM" (same day) in `zone`. Uses an en dash, as time ranges should. */
export function formatRange(start: Instant, end: Instant, zone: string, opts: TimeFormatOptions = {}): string {
  const a = toMs(start);
  const b = toMs(end);
  const f = dtf(opts.locale, timeOptions(zone, opts.hour12)) as Intl.DateTimeFormat & { formatRange?: (a: number, b: number) => string };
  if (opts.style !== 'compact' && typeof f.formatRange === 'function' && dayKey(a, zone) === dayKey(b, zone)) {
    try {
      return tidy(f.formatRange(a, b)).replace(/ /g, ' ');
    } catch {
      // fall through
    }
  }
  return `${formatTime(a, zone, opts)} – ${formatTime(b, zone, opts)}`;
}

/** "Tuesday, November 17, 2026" */
export function formatDateLong(t: Instant, zone: string, locale?: string): string {
  return dtf(locale, { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(toMs(t));
}

/** "Tue, Nov 17" */
export function formatDateMedium(t: Instant, zone: string, locale?: string): string {
  return dtf(locale, { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(toMs(t));
}

/** "Nov 17, 2026" */
export function formatDateShort(t: Instant, zone: string, locale?: string): string {
  return dtf(locale, { timeZone: zone, month: 'short', day: 'numeric', year: 'numeric' }).format(toMs(t));
}

/** "Tuesday, November 17" for a day key (no zone involved). */
export function formatDayKey(key: string, locale?: string, style: 'long' | 'medium' | 'short' = 'long'): string {
  const { year, month, day } = parseDayKey(key);
  const ms = Date.UTC(year, month - 1, day, 12);
  if (style === 'short') return dtf(locale, { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(ms);
  if (style === 'medium') return dtf(locale, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(ms);
  return dtf(locale, { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(ms);
}

/** "November 2026". `month` is 1..12. */
export function formatMonthYear(year: number, month: number, locale?: string): string {
  return dtf(locale, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(Date.UTC(year, month - 1, 1, 12));
}

/** Seven weekday names starting on `weekStart`: ["Sun", "Mon", ...]. */
export function weekdayNames(weekStart: Weekday = 0, locale?: string, width: 'narrow' | 'short' | 'long' = 'short'): string[] {
  const f = dtf(locale, { timeZone: 'UTC', weekday: width });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => f.format(Date.UTC(2023, 0, 1 + ((weekStart + i) % 7), 12)));
}

/** "Today", "Tomorrow", "Yesterday", or a medium date. */
export function formatRelativeDay(t: Instant, zone: string, now: Instant = Date.now(), locale?: string): string {
  const diff = daysBetween(todayKey(zone, now), dayKey(t, zone));
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return formatDateMedium(t, zone, locale);
}

/** "30 min", "1 hr", "1 hr 30 min" */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  if (!m) return `${h} hr`;
  return `${h} hr ${m} min`;
}

// ───────────── zone names ─────────────

const CITY_RENAMES: Record<string, string> = {
  Calcutta: 'Kolkata',
  Saigon: 'Ho Chi Minh City',
  Ho_Chi_Minh: 'Ho Chi Minh City',
  Katmandu: 'Kathmandu',
  Rangoon: 'Yangon',
  Kiev: 'Kyiv',
  Asmera: 'Asmara',
  Godthab: 'Nuuk',
  Faeroe: 'Faroe',
  Truk: 'Chuuk',
  Ponape: 'Pohnpei',
};

/** "Nairobi" from "Africa/Nairobi". */
export function zoneCity(zone: string): string {
  if (zone === 'UTC' || zone === 'Etc/UTC' || zone === 'GMT') return 'UTC';
  const last = zone.split('/').pop() ?? zone;
  return CITY_RENAMES[last] ?? last.replace(/_/g, ' ');
}

/** "GMT+3", "GMT-3:30", "GMT" */
export function formatOffset(minutes: number): string {
  if (!minutes) return 'GMT';
  const sign = minutes > 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `GMT${sign}${h}${m ? `:${pad(m)}` : ''}`;
}

/** "East Africa Time". Falls back to the GMT offset when the browser has no name. */
export function zoneName(zone: string, t: Instant = Date.now(), locale?: string): string {
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'Coordinated Universal Time';
  for (const style of ['longGeneric', 'long'] as const) {
    try {
      const part = dtf(locale ?? 'en-US', { timeZone: zone, timeZoneName: style })
        .formatToParts(toMs(t))
        .find((p) => p.type === 'timeZoneName')?.value;
      if (part && !/^(GMT|UTC)/.test(part)) return part;
    } catch {
      // older engines do not know longGeneric
    }
  }
  return formatOffset(zoneOffsetMinutes(zone, t));
}

/** "East Africa Time (Nairobi)": the label shown under the calendar. */
export function zoneLabel(zone: string, t: Instant = Date.now(), locale?: string): string {
  const name = zoneName(zone, t, locale);
  const city = zoneCity(zone);
  if (city === 'UTC') return 'Coordinated Universal Time (UTC)';
  return name.toLowerCase().includes(city.toLowerCase()) ? name : `${name} (${city})`;
}

// ───────────── zone list ─────────────

export interface ZoneInfo {
  /** IANA id */
  id: string;
  city: string;
  /** display group: "Africa", "Americas", ... */
  region: string;
  /** minutes east of UTC right now */
  offsetMin: number;
  /** "GMT+3" */
  offset: string;
  /** "East Africa Time" */
  name: string;
  /** lowercase text to match queries against */
  search: string;
}

export interface ZoneGroup {
  region: string;
  zones: ZoneInfo[];
}

const REGION_LABELS: Record<string, string> = {
  Africa: 'Africa',
  America: 'Americas',
  Antarctica: 'Antarctica',
  Arctic: 'Arctic',
  Asia: 'Asia',
  Atlantic: 'Atlantic',
  Australia: 'Australia',
  Europe: 'Europe',
  Indian: 'Indian Ocean',
  Pacific: 'Pacific',
  UTC: 'UTC',
};

const REGION_ORDER = ['Africa', 'Americas', 'Asia', 'Atlantic', 'Australia', 'Europe', 'Indian Ocean', 'Pacific', 'Antarctica', 'Arctic', 'UTC'];

/** Countries, regions and big cities people type that are not part of the zone id. */
const ALIASES: Record<string, string> = {
  'Africa/Nairobi': 'kenya east africa eat mombasa',
  'Africa/Kampala': 'uganda',
  'Africa/Dar_es_Salaam': 'tanzania',
  'Africa/Addis_Ababa': 'ethiopia',
  'Africa/Kigali': 'rwanda',
  'Africa/Lagos': 'nigeria west africa abuja',
  'Africa/Accra': 'ghana',
  'Africa/Johannesburg': 'south africa cape town pretoria durban sast',
  'Africa/Cairo': 'egypt',
  'Africa/Casablanca': 'morocco',
  'America/New_York': 'usa united states eastern est edt boston washington dc miami atlanta philadelphia',
  'America/Chicago': 'usa united states central cst cdt dallas houston austin minneapolis',
  'America/Denver': 'usa united states mountain mst mdt salt lake city',
  'America/Phoenix': 'usa united states arizona',
  'America/Los_Angeles': 'usa united states pacific pst pdt california san francisco seattle portland las vegas san diego',
  'America/Anchorage': 'usa united states alaska',
  'Pacific/Honolulu': 'usa united states hawaii',
  'America/Toronto': 'canada ontario ottawa eastern',
  'America/Vancouver': 'canada british columbia pacific',
  'America/Edmonton': 'canada alberta calgary mountain',
  'America/Winnipeg': 'canada manitoba central',
  'America/Halifax': 'canada nova scotia atlantic',
  'America/Mexico_City': 'mexico cdmx',
  'America/Bogota': 'colombia',
  'America/Lima': 'peru',
  'America/Santiago': 'chile',
  'America/Sao_Paulo': 'brazil brasil rio de janeiro',
  'America/Argentina/Buenos_Aires': 'argentina',
  'America/Buenos_Aires': 'argentina',
  'Europe/London': 'uk united kingdom england britain scotland wales gmt bst manchester edinburgh',
  'Europe/Dublin': 'ireland',
  'Europe/Lisbon': 'portugal',
  'Europe/Madrid': 'spain barcelona',
  'Europe/Paris': 'france cet',
  'Europe/Brussels': 'belgium',
  'Europe/Amsterdam': 'netherlands holland',
  'Europe/Berlin': 'germany munich frankfurt hamburg cet',
  'Europe/Zurich': 'switzerland geneva',
  'Europe/Rome': 'italy milan',
  'Europe/Vienna': 'austria',
  'Europe/Stockholm': 'sweden',
  'Europe/Oslo': 'norway',
  'Europe/Copenhagen': 'denmark',
  'Europe/Helsinki': 'finland',
  'Europe/Warsaw': 'poland',
  'Europe/Prague': 'czech czechia',
  'Europe/Athens': 'greece',
  'Europe/Istanbul': 'turkey turkiye',
  'Europe/Kiev': 'ukraine kyiv',
  'Europe/Kyiv': 'ukraine kiev',
  'Europe/Moscow': 'russia',
  'Asia/Jerusalem': 'israel tel aviv',
  'Asia/Dubai': 'uae united arab emirates abu dhabi gulf',
  'Asia/Riyadh': 'saudi arabia',
  'Asia/Karachi': 'pakistan lahore islamabad',
  'Asia/Calcutta': 'india kolkata mumbai delhi bangalore bengaluru chennai hyderabad ist',
  'Asia/Kolkata': 'india calcutta mumbai delhi bangalore bengaluru chennai hyderabad ist',
  'Asia/Dhaka': 'bangladesh',
  'Asia/Bangkok': 'thailand',
  'Asia/Jakarta': 'indonesia',
  'Asia/Singapore': 'singapore sgt',
  'Asia/Kuala_Lumpur': 'malaysia',
  'Asia/Manila': 'philippines',
  'Asia/Hong_Kong': 'hong kong hk',
  'Asia/Shanghai': 'china beijing shenzhen guangzhou cst',
  'Asia/Taipei': 'taiwan',
  'Asia/Seoul': 'south korea kst',
  'Asia/Tokyo': 'japan osaka jst',
  'Australia/Sydney': 'new south wales nsw canberra aest aedt',
  'Australia/Melbourne': 'victoria aest aedt',
  'Australia/Brisbane': 'queensland aest',
  'Australia/Perth': 'western australia awst',
  'Australia/Adelaide': 'south australia acst',
  'Pacific/Auckland': 'new zealand nz wellington',
  UTC: 'utc gmt zulu coordinated universal time',
};

const FALLBACK_ZONES = [
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi', 'America/Anchorage', 'America/Bogota', 'America/Chicago',
  'America/Denver', 'America/Halifax', 'America/Los_Angeles', 'America/Mexico_City', 'America/New_York', 'America/Phoenix', 'America/Sao_Paulo',
  'America/Toronto', 'America/Vancouver', 'Asia/Bangkok', 'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Jakarta', 'Asia/Jerusalem', 'Asia/Karachi',
  'Asia/Kolkata', 'Asia/Manila', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Brisbane', 'Australia/Melbourne',
  'Australia/Perth', 'Australia/Sydney', 'Europe/Amsterdam', 'Europe/Athens', 'Europe/Berlin', 'Europe/Dublin', 'Europe/Istanbul', 'Europe/Lisbon',
  'Europe/London', 'Europe/Madrid', 'Europe/Moscow', 'Europe/Paris', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Zurich', 'Pacific/Auckland',
  'Pacific/Honolulu',
];

function zoneIds(): string[] {
  let ids: string[] = [];
  try {
    const supported = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof supported === 'function') ids = supported('timeZone');
  } catch {
    ids = [];
  }
  if (!ids.length) ids = FALLBACK_ZONES;
  const set = new Set(ids.filter((id) => id.includes('/') && !id.startsWith('Etc/')));
  set.add('UTC');
  return Array.from(set);
}

/** The words for a zone's offset in its search text: "gmt-10 utc-10". */
function offsetWords(offset: string): string {
  return `${offset} ${offset.replace('GMT', 'UTC')}`.toLowerCase();
}

/** Display data for one zone at an instant. Works for ids that are not in the list too. */
export function zoneInfo(zone: string, now: Instant = Date.now(), locale?: string): ZoneInfo {
  const offsetMin = zoneOffsetMinutes(zone, now);
  const city = zoneCity(zone);
  const top = zone.includes('/') ? zone.split('/')[0] : 'UTC';
  const region = REGION_LABELS[top] ?? top;
  const name = zoneName(zone, now, locale);
  const offset = formatOffset(offsetMin);
  // The offset goes last: searchZones tells a match on the zone's own words from one on its offset alone.
  const search = [city, zone.replace(/[_/]/g, ' '), region, name, ALIASES[zone] ?? '', offsetWords(offset)].join(' ').toLowerCase();
  return { id: zone, city, region, offsetMin, offset, name, search };
}

let listCache: { stamp: string; zones: ZoneInfo[] } | null = null;

/** Every zone the browser knows, sorted by current offset, then city. Cached for the current hour. */
export function allZones(now: Instant = Date.now(), locale?: string): ZoneInfo[] {
  const ms = toMs(now);
  const stamp = `${Math.floor(ms / 3600000)}|${locale ?? ''}`;
  if (listCache && listCache.stamp === stamp) return listCache.zones;
  const zones = zoneIds()
    .map((id) => zoneInfo(id, ms, locale))
    .sort((a, b) => a.offsetMin - b.offsetMin || a.city.localeCompare(b.city));
  listCache = { stamp, zones };
  return zones;
}

/** Zones grouped by part of the world, for a picker. Each zone carries its current offset and name. */
export function listZones(now: Instant = Date.now(), locale?: string): ZoneGroup[] {
  const groups = new Map<string, ZoneInfo[]>();
  for (const z of allZones(now, locale)) {
    const list = groups.get(z.region);
    if (list) list.push(z);
    else groups.set(z.region, [z]);
  }
  return Array.from(groups.entries())
    .sort((a, b) => {
      const ia = REGION_ORDER.indexOf(a[0]);
      const ib = REGION_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .map(([region, zones]) => ({ region, zones: zones.slice().sort((a, b) => a.city.localeCompare(b.city)) }));
}

const MAJOR_ZONES = new Set(FALLBACK_ZONES);

/** How well `q` matches inside `text`: 0 as whole words, 1 at the start of a word, 2 inside a word, null not at all. */
function matchQuality(text: string, q: string): 0 | 1 | 2 | null {
  const at = text.indexOf(q);
  if (at === -1) return null;
  const isWordChar = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}]/u.test(ch);
  let best: 0 | 1 | 2 = 2;
  for (let i = at; i !== -1 && best > 0; i = text.indexOf(q, i + 1)) {
    if (isWordChar(text[i - 1])) continue;
    best = isWordChar(text[i + q.length]) ? 1 : 0;
  }
  return best;
}

/**
 * Zones matching a query (city, country, zone name, "GMT+3", "pst", ...), best matches first.
 * Every word of the query has to match somewhere. An empty query returns everything.
 *
 * Order: the city itself; then by how well the query matches (whole words, then the start of a
 * word, then inside a word), and at each of those a match on the city name before one elsewhere.
 * So "new" lists New York before Sydney ("new south wales"), and "india" finds Kolkata (the whole
 * word "india") before Indianapolis (only the start of a word). Ties: big cities first.
 */
export function searchZones(query: string, now: Instant = Date.now(), locale?: string): ZoneInfo[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const zones = allZones(now, locale);
  if (!q) return zones;
  const words = q.split(' ');
  const scored: { z: ZoneInfo; score: number; major: number }[] = [];
  for (const z of zones) {
    if (!words.every((w) => z.search.includes(w))) continue;
    const city = z.city.toLowerCase();
    const inCity = matchQuality(city, q);
    // Every zone's search words hold its offset ("gmt-10", "utc-10"), so "gmt" alone would be a whole-word
    // match for all of them. A match only there ranks after a match on the zone's own words.
    const tail = ` ${offsetWords(z.offset)}`;
    const own = matchQuality(z.search.endsWith(tail) ? z.search.slice(0, -tail.length) : z.search, q);
    const anywhere = matchQuality(z.search, q);
    const score =
      city === q
        ? 0
        : inCity !== null && (own === null || inCity <= own)
          ? 1 + inCity * 2
          : own !== null
            ? 2 + own * 2
            : anywhere !== null
              ? 7 + anywhere
              : 10;
    // Big cities: the short list, and every zone that has search words of its own (some browsers use old ids, like Asia/Calcutta).
    scored.push({ z, score, major: MAJOR_ZONES.has(z.id) || ALIASES[z.id] !== undefined ? 0 : 1 });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.major - b.major || a.z.offsetMin - b.z.offsetMin || a.z.city.localeCompare(b.z.city))
    .map((s) => s.z);
}
