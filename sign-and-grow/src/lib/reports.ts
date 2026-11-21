// Reports and saved lists: the rules and words the Reports page, Contacts, Send to many and the server share
// (src/server/reports.ts, src/server/bulklists.ts). No server code in here, so pages can import it.

/** Reports start with this many days, today included. */
export const REPORT_DEFAULT_DAYS = 30;
/** The longest period one report covers, so one request never reads an account's whole history at once. */
export const REPORT_MAX_DAYS = 3660;

/** The status filter of a report, in the API's words, and what a person reads for each. */
export const REPORT_STATUSES = ['sent', 'completed', 'declined', 'voided', 'expired'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const STATUS_WORDS: Record<ReportStatus, string> = { sent: 'Waiting for others', completed: 'Finished', declined: 'Declined', voided: 'Cancelled', expired: 'Ran out of time' };

/** The day `days - 1` days before `today`, and today, as YYYY-MM-DD in UTC: the default period of a report. */
export function defaultPeriod(today = new Date(), days = REPORT_DEFAULT_DAYS): { from: string; to: string } {
  const to = today.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86400_000).toISOString().slice(0, 10);
  return { from, to };
}

/** A real day written YYYY-MM-DD, or null. */
export function readDay(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? s : null;
}

/** The middle value of a list of numbers (the mean of the two middle ones for an even count), or null for none. */
export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** "45 min", "5.5 h", "3.2 days": a time to finish as a person reads it, or "–" when nothing finished. */
export function durationText(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return '–';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

/** "8 of 10 (80%)": how many of those sent are finished. */
export const finishedText = (finished: number, sent: number): string => (sent ? `${finished} of ${sent} (${Math.round((finished / sent) * 100)}%)` : '0');

/** The columns of the CSV download, in order. The page's tables show the same. */
export const REPORT_CSV_HEAD = ['Table', 'Name', 'Sent', 'Finished', 'Finished (%)', 'Median time to finish (hours)', 'Declined', 'Cancelled', 'Ran out of time', 'Waiting'];

// ---- Saved lists (Send to many) ------------------------------------------------------------------------------

/** A list nobody used for this many days is deleted, unless the account set another number in this range. */
export const LIST_DAYS_DEFAULT = 180;
export const LIST_DAYS_MIN = 30;
export const LIST_DAYS_MAX = 730;
/** One list holds at most this many rows (one batch, components/sender/csv.ts MAX_ROWS) and this much text. */
export const LIST_MAX_ROWS = 500;
export const LIST_MAX_BYTES = 1_000_000;
export const LIST_NAME_MAX = 80;
/** An account keeps at most this many lists. */
export const LISTS_PER_ACCOUNT = 200;

/** Said wherever a list is saved or shown: what a saved list is and who can see it. */
export const LIST_PERSONAL_DATA = 'A saved list holds personal data: the names and email addresses in it, and anything else in its columns. Everyone on your team can see and use it. Save only what your team may keep, and delete a list when it is no longer needed.';
export const listDeleteRule = (days: number) => `A list nobody uses for ${days} days is deleted by itself.`;

/** The number of lines with something in them, the header row included (a line break inside quotes does not count). */
export function countListLines(text: string): number {
  let rows = 0, quoted = false, filled = false;
  for (const ch of String(text ?? '').replace(/^﻿/, '')) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === '\n' || ch === '\r')) {
      if (filled) rows++;
      filled = false;
    } else if (!/[\s,;]/.test(ch)) filled = true;
  }
  if (filled) rows++;
  return rows;
}
