// The consent wording is named by the day it was first shown, kept as "2026-11-21" in the record, the API and the CSV
// (that is how the line is stored, and the stored line is part of the hash chain, so it never changes). Where a
// person reads it, on the signed PDF, in the History on screen and on /help, it is written day first: "21 Nov 2026".
import { dayText } from './dates.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-21" as "21 Nov 2026", "2026-11" as "Nov 2026". Anything else is returned as it is. */
export function versionText(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return dayText(v) || v;
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${MONTHS[+m[2] - 1]} ${m[1]}`;
  return v;
}

/**
 * An audit line as a person reads it: "Wording 2026-11-21, in English" becomes "Wording of 21 Nov 2026, in English".
 * Only the words consentAuditNote writes are touched, so nothing else in a line changes.
 */
export function readableWording(detail: string | null | undefined): string {
  if (!detail) return detail || '';
  return detail
    .replace(/\bWording (\d{4}-\d{2}(?:-\d{2})?)(?=,)/g, (_, v) => `Wording of ${versionText(v)}`)
    .replace(/\bThe wording in use was (\d{4}-\d{2}(?:-\d{2})?)(?=,)/g, (_, v) => `The wording in use was the one of ${versionText(v)}`);
}
