// How dates are written on a document, and how a moment is told to people in different time zones. Shared by the
// server (PDF stamping, emails) and the browser, so a date reads the same on the signing page and on the signed PDF.
//
// A sender chooses one of these formats for an envelope (an account can set which one new envelopes start with).
// It is used for the date of signing and for every date a signer types into a date field.
export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'D MMM YYYY', 'MMM D, YYYY'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
/** What a new account and a new document start with: 20 Nov 2026. The month is a word, so nobody can misread it. */
export const DEFAULT_DATE_FORMAT: DateFormat = 'D MMM YYYY';
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
    const resolved = new Intl.DateTimeFormat('en-GB', { timeZone: tz }).resolvedOptions().timeZone;
    // Kept as the device spelled it ("Asia/Kolkata", "Europe/Kyiv"), which is what people know, unless its capitals
    // are plainly wrong ("ASIA/KOLKATA", "asia/kolkata" from an API caller): that is printed on certificates and in
    // emails, so it is put right, with the spelling of the clock library (which may be an older name of the zone).
    const caps = tz.includes('/') && (!/[a-z]/.test(tz) || !/[A-Z]/.test(tz));
    return caps ? resolved : tz;
  } catch {
    return null;
  }
}

/** A zone named after an offset ("Etc/GMT-14" is UTC+14:00, the sign reads backwards) is written as its offset. */
const byOffset = (zone: string): boolean => /^(Etc\/|GMT|UTC|UCT|Universal|Zulu|Greenwich)/i.test(zone);

/** A zone for the certificate: its name as reported, or for one named after an offset, the offset ("UTC+14:00"). */
export const zoneLabel = (zone: string, at: string | Date = new Date()): string => (byOffset(zone) ? clockIn(at, zone)?.offset || 'UTC' : zone);

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
  // A day that does not exist (31 February) is not turned into one that looks real: it stays as typed.
  if (!m || !isDateValue(s)) return s;
  return written(+m[1], +m[2] - 1, +m[3], format);
}

/**
 * Whether a typed date is a real calendar day written year-month-day, which is what the date picker sends and the
 * only form the server takes for a date field: "2026-02-31", "03/04/2026" (which day is that?) and "next Tuesday"
 * are not. The page says so before Finish, and the server refuses it with the same words.
 */
export function isDateValue(value: any): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m || +m[1] < 1000) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
export const DATE_PROBLEM = 'This is not a date we can read. Pick it from the calendar, or type it as year-month-day, like 2027-03-20. It is printed on the document in the format the sender chose.';

/** A zone the way people read it: "UTC", or "Pacific/Auckland time (UTC+13:00)". */
const zoneWords = (c: Clock): string => (c.zone === 'UTC' || byOffset(c.zone) ? c.offset : `${c.zone.replace(/_/g, ' ')} time (${c.offset})`);

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
 * A moment on a signer's own screen, by the clock of their own device: "20 March 2027 at 22:33, your time". Only for
 * the zone the device itself reports (deviceZone): anywhere else the zone is named, with momentText.
 */
export function yourMoment(iso: string | Date | null | undefined, deviceTz?: string | null): string {
  const c = iso ? clockIn(iso, deviceTz) : null;
  return c ? `${c.d} ${MONTH_NAMES[c.m]} ${c.y} at ${pad(c.hh)}:${pad(c.mm)}, your time` : '';
}

/**
 * The same moment for an email: always in UTC, and in the reader's own zone too once we know it. "20 March 2027 at
 * 16:40 UTC, which is 21 March 2027 at 05:40 Pacific/Auckland time (UTC+13:00)".
 */
export function momentForEmail(iso: string | Date | null | undefined, tz?: string | null): string {
  const utc = momentText(iso);
  const zone = validZone(tz);
  // "Etc/UTC" or "GMT0" is UTC itself: no "16:40 UTC, which is 16:40 UTC".
  return utc && zone && zone !== 'UTC' && !(byOffset(zone) && clockIn(iso!, zone)?.offset === 'UTC') ? `${utc}, which is ${momentText(iso, zone)}` : utc;
}

/**
 * A deadline in an email to the person who has to meet it: in their own time, with the zone named, once their device
 * has told us which that is ("20 March 2027 at 22:10 Asia/Kolkata time (UTC+05:30)"). Until then we do not know it,
 * and the email says the moment in UTC and says that it is UTC.
 */
export function momentForReader(iso: string | Date | null | undefined, tz?: string | null): string {
  const zone = validZone(tz);
  return iso && zone ? momentText(iso, zone) : momentText(iso);
}

/** For the certificate, next to the UTC time: "2026-11-21 05:40 UTC+13:00, Pacific/Auckland". Empty without a zone. */
export function localStamp(iso: string | null | undefined, tz?: string | null): string {
  const zone = validZone(tz);
  const c = iso && zone ? clockIn(iso, zone) : null;
  return c ? `${c.y}-${pad(c.m + 1)}-${pad(c.d)} ${pad(c.hh)}:${pad(c.mm)} ${c.offset}${byOffset(c.zone) ? '' : `, ${c.zone}`}` : '';
}

/** Whether it is daytime in a zone at a moment: from 8:00 up to 20:00. A reminder that falls outside waits. */
export const REMINDER_DAY_START = 8;
export const REMINDER_DAY_END = 20;
export function isDaytime(iso: string | Date, tz?: string | null): boolean {
  const c = clockIn(iso, tz);
  return !c || (c.hh >= REMINDER_DAY_START && c.hh < REMINDER_DAY_END);
}

// ---- Dates on a screen, in the reader's language ----------------------------------------------------------------
// For screens only. The signed PDF, the certificate, the audit trail and the formats a sender picks above stay as
// they are, whatever the reader's language: they are part of the record. English is written exactly as momentText
// writes it, so no English screen changes; any other language is written by the browser's own rules for it (Intl).
// A calendar other than the Gregorian one ("ethiopic" for the Ethiopian calendar, for example) is asked for here and
// nowhere else, so a language that needs one gets it in one place.

/** The calendars a screen may write a date in: the ones this runtime knows (Intl.supportedValuesOf). */
export function validCalendar(c: unknown): string | null {
  if (typeof c !== 'string' || !/^[a-z0-9-]{3,20}$/.test(c)) return null;
  try {
    return (Intl as any).supportedValuesOf?.('calendar')?.includes(c) ? c : null;
  } catch {
    return null;
  }
}
const screenTag = (locale: unknown, calendar?: string | null): string => {
  const tag = typeof locale === 'string' && locale.trim() ? locale.trim().replace(/_/g, '-') : 'en';
  let base = 'en';
  try {
    base = Intl.getCanonicalLocales(tag)[0]?.split(/-u-/)[0] || 'en';
  } catch {
    /* not a language tag: English */
  }
  const cal = validCalendar(calendar);
  return cal && cal !== 'gregory' ? `${base}-u-ca-${cal}` : base;
};
const plainEnglish = (tag: string) => /^en(-|$)/.test(tag) && !tag.includes('-u-');

/** A day on a screen: "20 November 2026" in English, "20 novembre 2026" in French, by `calendar` when one is given. */
export function dateOnScreen(iso: string | Date | null | undefined, locale?: unknown, tz?: string | null, calendar?: string | null): string {
  const c = iso ? clockIn(iso, tz) : null;
  if (!c) return '';
  const tag = screenTag(locale, calendar);
  if (plainEnglish(tag)) return `${c.d} ${MONTH_NAMES[c.m]} ${c.y}`;
  return new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeZone: validZone(tz) || 'UTC' }).format(typeof iso === 'string' ? new Date(iso) : iso!);
}

/** A moment on a screen with its time and zone: momentText in English, the language's own way otherwise. */
export function momentOnScreen(iso: string | Date | null | undefined, locale?: unknown, tz?: string | null, calendar?: string | null): string {
  const c = iso ? clockIn(iso, tz) : null;
  if (!c) return '';
  const tag = screenTag(locale, calendar);
  if (plainEnglish(tag)) return momentText(iso, tz);
  const when = new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeStyle: 'short', hourCycle: 'h23', timeZone: c.zone }).format(typeof iso === 'string' ? new Date(iso) : iso!);
  return `${when} ${c.zone === 'UTC' ? 'UTC' : `${c.zone.replace(/_/g, ' ')} (${c.offset})`}`;
}

/**
 * A day for a person to read, in a sentence on a screen or in an email: "20 Nov 2026". The day is the UTC day of the
 * moment, as the dates in file names, the API and CSV exports are (those stay 2026-11-20). Empty for no moment.
 */
export function dayText(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const text = typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso;
  return formatDate(text, DEFAULT_DATE_FORMAT, 'UTC');
}
