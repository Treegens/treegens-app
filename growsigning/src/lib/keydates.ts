// Key dates (feature ds-ai-repo): the dates and amounts of a completed agreement, found by the AI and checked by the
// sender (src/server/airepo.ts has the server side, src/server/routes-airepo.ts the routes,
// src/components/sender/KeyDates.tsx the envelope page, src/app/app/key-dates/page.tsx the list). The kinds, words,
// limits and the calendar file are here, so the pages and the server cannot disagree. No database in here.
//
// Four switches, all needed: a model on this server, the account's AI switch, "Let the AI read document text", and
// the account's own "Key dates" switch, off until an admin turns it on. Without them nothing is shown and nothing is
// sent anywhere.

export const TERM_KINDS = ['parties', 'start', 'end', 'renewal', 'notice', 'amount'] as const;
export type TermKind = (typeof TERM_KINDS)[number];
/** Kinds that are a day: these take a date in the form 2027-03-03, and can be on the calendar. */
export const DATE_KINDS: TermKind[] = ['start', 'end', 'renewal', 'notice'];
/** Kinds a reminder can be emailed about: the days by which something has to be done. */
export const REMIND_KINDS: TermKind[] = ['end', 'notice', 'renewal'];

/** The name each kind has as a detail of the envelope (a custom field), and on the screens. */
export const TERM_NAMES: Record<TermKind, string> = {
  parties: 'Parties', start: 'Start date', end: 'End date', renewal: 'Renewal date', notice: 'Notice date', amount: 'Amount',
};

/** At most this many amounts are kept from one agreement; one of every other kind. */
export const AMOUNTS_MAX = 5;
/** The longest value and the longest quote of the words it came from, in characters. */
export const TERM_VALUE_MAX = 100;
export const TERM_QUOTE_MAX = 300;
/** The most characters of one agreement the model reads. */
export const KEY_TEXT_MAX = 40_000;
/** Reminders: how many days before the date, from 1 to this. */
export const REMIND_DAYS_MAX = 365;
export const REMIND_DAYS_DEFAULT = 30;
/** The list filter: "ending in the next N days" offers these. */
export const WITHIN_CHOICES = [30, 90, 180, 365] as const;

// ---- Words -----------------------------------------------------------------------------------------------------
export const KEY_DATES = 'Key dates';
export const KEY_SWITCH_HINT = 'Lets the AI read completed documents to find their dates and amounts. You check each one before it is used.';
/** Under the Key dates switch while it is on: what turning it off, or the read switch above it, does. */
export const KEY_OFF_WARNING = 'Turning this off, or turning off "Let the AI read document text", stops Key dates and its reminders. The dates you checked stay with each document.';
/** What the person is told after a value is confirmed, corrected or added: what it is now used for. */
export function usedLine(kind: TermKind, verb: 'Confirmed' | 'Saved' | 'Added'): string {
  if (REMIND_KINDS.includes(kind)) return `${verb}. It is now in the calendar file and can be used for reminders.`;
  if (DATE_KINDS.includes(kind)) return `${verb}. It is now in the calendar file.`;
  return `${verb}. It is now kept with this document.`;
}
/** How the AI reads documents by itself, or that it does not on this server. */
export const autoLine = (auto: boolean, older: boolean) => auto
  ? `The AI reads ${older ? 'all completed documents' : 'documents completed from now on'} by itself, a few at a time, using at most half of the account's AI requests of the day.${older ? '' : ` For an older one, open it and press ${FIND_BUTTON}.`}`
  : `On this server the AI does not read documents by itself. Open a completed document and press ${FIND_BUTTON}.`;
export const FIND_BUTTON = 'Find the dates and amounts';
export const OLDER_BUTTON = 'Look through older documents';
export const REMIND_ME = 'Remind me';
/** Said next to every value the AI found and nobody confirmed yet. */
export const foundLine = (page: number | null) => `Found by AI${page ? ` on page ${page}` : ''}. Check it.`;
export const CHECKED = 'Checked by you';
export const NOT_LEGAL = 'Found by an AI reading the document. It can be wrong or miss something. The document itself is what was agreed.';
export const NOTHING_FOUND = 'The AI found no dates or amounts in this document. Read it to be sure, and add one below if you need it.';
export const KEY_OFF = 'Key dates is not switched on for this account. An admin can turn it on in Settings, Account.';
export const NOT_COMPLETED = 'Key dates are found once a document is completed. Come back when everyone has signed.';

/** A plain sentence for a value: "Ends on 3 March 2027". */
export function termSentence(kind: TermKind, value: string): string {
  const d = DATE_KINDS.includes(kind) ? dayWords(value) : value;
  switch (kind) {
    case 'parties': return `Between ${value}`;
    case 'start': return `Starts on ${d}`;
    case 'end': return `Ends on ${d}`;
    case 'renewal': return `Renews on ${d}`;
    case 'notice': return `Notice due by ${d}`;
    default: return `Amount: ${value}`;
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A real day written 2027-03-03, or null. */
export function readDay(v: unknown): string | null {
  const s = String(v ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? s : null;
}
/** "3 March 2027" for 2027-03-03. */
export function dayWords(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : day;
}
/** The day N days after (or before, with a negative N) a day, as 2027-03-03. */
export function addDays(day: string, n: number): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
/** Whole days from `from` to `to` (both 2027-03-03); negative when `to` is earlier. */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Days for a reminder as the person typed them, or a sentence on what is wrong. */
export function readRemindDays(v: unknown): { days: number } | { problem: string } {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  if (!Number.isInteger(n) || n < 1 || n > REMIND_DAYS_MAX) return { problem: `Choose a number of days from 1 to ${REMIND_DAYS_MAX}. Then press ${REMIND_ME} again.` };
  return { days: n };
}

// ---- The calendar file ---------------------------------------------------------------------------------------------
export type CalendarItem = { uid: string; day: string; title: string; note: string; url: string };

// RFC 5545: text escaped, lines folded at 75 octets, CRLF line ends.
const esc = (s: string) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
/** A calendar file with one all-day event for each item. `stamp` is the time it was made, as an ISO time. */
export function calendarFile(items: CalendarItem[], stamp: string): string {
  const dt = stamp.replace(/[-:]/g, '').replace(/\.\d+/, '').slice(0, 15) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GrowSigning//Key dates//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Key dates'];
  for (const it of items) {
    const d = it.day.replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:${esc(it.uid)}`, `DTSTAMP:${dt}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${addDays(it.day, 1).replace(/-/g, '')}`,
      `SUMMARY:${esc(it.title)}`, `DESCRIPTION:${esc(it.note)}`, `URL:${esc(it.url)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---- Is the value in the words it came from? ------------------------------------------------------------------
// The AI has to point at words that hold the value itself, so the words shown under a value are its evidence and
// not just any words of the document. A date has to be written in them (as 2027-03-03, 3 March 2027, March 3, 2027,
// 03/03/2027, 3.3.2027 and the like, its month in a few languages); an amount has to have its numbers in them; the
// parties have to be named in them. Anything else is dropped. A date the AI worked out from a period ("two months
// before the end") is dropped too: the person can add it by hand.
const tokens = (s: string) => String(s || '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const MONTH_LOCALES = ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'nb', 'pl'];
const monthNames: string[][] = Array.from({ length: 12 }, (_, m) => {
  const names = new Set<string>();
  for (const loc of MONTH_LOCALES) {
    for (const month of ['long', 'short'] as const) {
      try {
        for (const t of tokens(new Intl.DateTimeFormat(loc, { month, timeZone: 'UTC' }).format(new Date(Date.UTC(2000, m, 15))))) if (t.length >= 3) names.add(t);
      } catch {}
    }
  }
  if (m === 8) names.add('sept');
  return [...names];
});
/** Whether the day 2027-03-03 is written in `quote`. */
export function dateInWords(day: string, quote: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return false;
  const [y, mo, d] = [m[1], Number(m[2]), Number(m[3])];
  const t = tokens(quote);
  if (!t.includes(y)) return false;
  const isDay = (x: string) => new RegExp(`^0?${d}(st|nd|rd|th|er|e|º|o)?$`).test(x);
  const isMonth = (x: string) => new RegExp(`^0?${mo}$`).test(x) || monthNames[mo - 1].includes(x);
  // The day and the month next to each other (either order), with the year near: "3 March 2027", "March 3rd, 2027",
  // "2027-03-03", "03/03/2027", "3. März 2027", "le 3 mars 2027".
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== y) continue;
    const near = t.slice(Math.max(0, i - 4), i + 4);
    for (let j = 0; j + 1 < near.length; j++) {
      if ((isDay(near[j]) && isMonth(near[j + 1])) || (isMonth(near[j]) && isDay(near[j + 1]))) return true;
      // "3 de marzo de 2027", "3 of March 2027"
      if (j + 2 < near.length && ['de', 'of', 'van', 'di'].includes(near[j + 1]) && isDay(near[j]) && isMonth(near[j + 2])) return true;
    }
  }
  return false;
}
// The numbers in a text as plain digits: "1,500.00" and "1.500" are both 1500, "900" is 900.
const numbersIn = (s: string): string[] =>
  (String(s || '').match(/\d[\d.,'   ]*\d|\d/g) || []).map((n) => n.trim().replace(/[.,]0{1,2}$/, '').replace(/[^\d]/g, '').replace(/^0+(?=\d)/, ''));
/** Whether every number of the amount `value` is in `quote`. */
export function amountInWords(value: string, quote: string): boolean {
  const want = numbersIn(value);
  if (!want.length) return false;
  const have = numbersIn(quote);
  return want.every((n) => have.includes(n));
}
/** Whether the parties are named in `quote`: every name word of the value, leaving out "and" and the like. */
export function partiesInWords(value: string, quote: string): boolean {
  const skip = new Set(['and', 'the', 'of', 'between', 'et', 'und', 'y', 'e', 'en', 'ltd', 'llc', 'inc', 'gmbh', 'sa', 'bv', 'plc']);
  const want = tokens(value).filter((w) => w.length >= 2 && !skip.has(w));
  if (!want.length) return false;
  const have = new Set(tokens(quote));
  return want.every((w) => have.has(w));
}
/** The fewest characters the words a value came from may have. */
export const QUOTE_MIN = 8;
