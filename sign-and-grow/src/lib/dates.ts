// How dates are written on a document, and how a moment is told to people in different time zones. Shared by the
// server (PDF stamping, emails) and the browser, so a date reads the same on the signing page and on the signed PDF.
//
// A sender chooses one of these formats for an envelope (an account can set which one new envelopes start with).
// It is used for the date of signing and for every date a signer types into a date field.
export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'D MMM YYYY', 'MMM D, YYYY'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
/** The same formats in the order a picker lists them: the ones with the month as a word first, because nobody can misread them. */
export const DATE_FORMAT_CHOICES: DateFormat[] = ['D MMM YYYY', 'MMM D, YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function written(y: number, m: number, day: number, format?: string | null): string {
  switch (format) {
    case 'DD/MM/YYYY': return `${pad(day)}/${pad(m + 1)}/${y}`;
    case 'MM/DD/YYYY': return `${pad(m + 1)}/${pad(day)}/${y}`;
    case 'D MMM YYYY': return `${day} ${MONTHS[m]} ${y}`;
    case 'MMM D, YYYY': return `${MONTHS[m]} ${day}, ${y}`;
    default: return `${y}-${pad(m + 1)}-${pad(day)}`;
  }
}

/** The name of a time zone as devices report it ("Asia/Kolkata"), if this is one. Otherwise null. */
export function validZone(tz: any): string | null {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** The time zone of the device this runs on, as the signing page sends it. Empty when the device will not say. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

export type Clock = { y: number; m: number; d: number; hh: number; mm: number; offset: string; zone: string };

/**
 * What the calendar and the clock say at one moment in one time zone. `m` counts from 0. `offset` is how far that
 * clock is from UTC at that moment ("UTC+05:30"), which follows summer time. Without a zone, or with one that does
 * not exist, the answer is in UTC.
 */
export function clockIn(iso: string | Date, tz?: string | null): Clock | null {
  const t = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(t.getTime())) return null;
  const zone = validZone(tz) || 'UTC';
  const p: Record<string, number> = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(t))
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  const mins = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t.getTime() / 1000) * 1000) / 60000);
  const offset = zone === 'UTC' || mins === 0 ? 'UTC' : `UTC${mins < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(mins) / 60))}:${pad(Math.abs(mins) % 60)}`;
  return { y: p.year, m: p.month - 1, d: p.day, hh: p.hour, mm: p.minute, offset, zone };
}

/**
 * A moment written as a date in the chosen format. The day is the calendar day in `tz`, so someone who signs at
 * five in the morning in Auckland gets that morning's date, not the day before. Without a zone it is the UTC day.
 */
export function formatDate(iso: string | Date, format?: string | null, tz?: string | null): string {
  const c = clockIn(iso, tz);
  return c ? written(c.y, c.m, c.d, format) : '';
}

/**
 * A date typed into a date field, written in the chosen format. The date picker hands over year-month-day
 * (2026-11-20), which is a calendar day with no time zone to it. Anything else is left exactly as it was typed.
 */
export function formatDateValue(value: any, format?: string | null): string {
  const s = String(value ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return s;
  return written(+m[1], +m[2] - 1, +m[3], format);
}

/** A zone the way people read it: "UTC", or "Pacific/Auckland time (UTC+13:00)". */
const zoneWords = (c: Clock): string => (c.zone === 'UTC' ? 'UTC' : `${c.zone.replace(/_/g, ' ')} time (${c.offset})`);

/**
 * A deadline, or any other moment that matters, with its time and its zone: "20 March 2027 at 16:40 UTC", or with
 * a zone "21 March 2027 at 05:40 Pacific/Auckland time (UTC+13:00)". The month is a word, so nobody has to guess
 * which number is the day.
 */
export function momentText(iso: string | Date | null | undefined, tz?: string | null): string {
  const c = iso ? clockIn(iso, tz) : null;
  return c ? `${c.d} ${MONTH_NAMES[c.m]} ${c.y} at ${pad(c.hh)}:${pad(c.mm)} ${zoneWords(c)}` : '';
}

/**
 * The same moment for an email: always in UTC, and in the reader's own zone too once we know it. "20 March 2027 at
 * 16:40 UTC (21 March 2027 at 05:40 Pacific/Auckland time (UTC+13:00))".
 */
export function momentForEmail(iso: string | Date | null | undefined, tz?: string | null): string {
  const utc = momentText(iso);
  const zone = validZone(tz);
  return utc && zone && zone !== 'UTC' ? `${utc}, which is ${momentText(iso, zone)}` : utc;
}

/** For the certificate, next to the UTC time: "2026-11-21 05:40 UTC+13:00, Pacific/Auckland". Empty without a zone. */
export function localStamp(iso: string | null | undefined, tz?: string | null): string {
  const zone = validZone(tz);
  const c = iso && zone ? clockIn(iso, zone) : null;
  return c ? `${c.y}-${pad(c.m + 1)}-${pad(c.d)} ${pad(c.hh)}:${pad(c.mm)} ${c.offset}, ${c.zone}` : '';
}

/** Whether it is daytime in a zone at a moment: from 8:00 up to 20:00. A reminder that falls outside waits. */
export const REMINDER_DAY_START = 8;
export const REMINDER_DAY_END = 20;
export function isDaytime(iso: string | Date, tz?: string | null): boolean {
  const c = clockIn(iso, tz);
  return !c || (c.hh >= REMINDER_DAY_START && c.hh < REMINDER_DAY_END);
}
