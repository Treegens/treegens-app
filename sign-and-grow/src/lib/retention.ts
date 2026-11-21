// Keep and delete: how long finished documents are kept, what a deletion removes, what stays, and what a hold does.
// The numbers and the words that the server (src/server/records.ts) and the pages share. Plain constants and
// functions with no environment in them, so a 'use client' file may import this as well as the server.
//
// Before changing a sentence here, find the code in src/server/records.ts that makes it true. Nothing here may say
// "deleted everywhere": copies that people were emailed or downloaded, and backups, are out of this server's reach.
//
// Words (research/ux-charter.md, section 4): Delete after, Keep it, Hold, Deletion record. The API keeps its own
// names (retention, purge, level), which a person never sees on a screen or in an email.

/** The shortest and the longest time an account or a template can keep finished documents for, in days. */
export const RETENTION_MIN_DAYS = 30;
export const RETENTION_MAX_DAYS = 9999;
/** Days between the email that lists what is due and the deletion itself. Also the wait after someone asks for one. */
export const RETENTION_NOTICE_DAYS = 14;
/** The email about the schedule goes at most this often to an account, and lists what is due this many days further ahead. */
export const RETENTION_MAIL_EVERY_DAYS = 7;
/** The states a document can be deleted in. One that is still out for signature is never deleted by any of this. */
export const RETENTION_CLOSED = ['completed', 'voided', 'declined', 'expired'];

export type PurgeLevel = 'documents' | 'values' | 'personal';
export const PURGE_LEVELS: PurgeLevel[] = ['documents', 'values', 'personal'];
export const isPurgeLevel = (v: any): v is PurgeLevel => (PURGE_LEVELS as any[]).includes(v);
/** The two outcomes the screens offer. The third, in between, is for the API ("values"). */
export const SCREEN_LEVELS: PurgeLevel[] = ['documents', 'personal'];

/** The name of each level, as a choice in a list. */
export const LEVEL_NAME: Record<PurgeLevel, string> = {
  documents: 'Delete the files',
  values: 'Delete the files and the answers',
  personal: 'Also remove names and answers, keep the record',
};

/** What each level does, as the end of a sentence that starts with a day: "On 5 December 2026, its files are deleted." */
export const LEVEL_DOES: Record<PurgeLevel, string> = {
  documents: 'its files are deleted',
  values: 'its files and the answers people gave are deleted',
  personal: 'its files are deleted, and names and answers are removed from its record',
};

/** What each level removes, in full. Each level removes everything the one before it does. */
export const LEVEL_REMOVES: Record<PurgeLevel, string[]> = {
  documents: [
    'The pages of its files. A file that a template or another document still uses stays with that one.',
    'The signed PDF with its signing record, and the copies kept of what people signed before a correction.',
    'Files that signers attached, and the pictures of stamps put on it.',
    'The attachments of our stored copies of the emails about it.',
  ],
  values: [
    'Every answer typed, ticked or chosen in its fields, also the ones kept from before a correction.',
    'The pictures of each signature and initials.',
    'The words of its questions and comments.',
    'The reasons given for declining or cancelling it.',
    'The words of our stored copies of the emails about it. Who each went to, its subject line, when it went and whether it arrived stay.',
  ],
  personal: [
    'Names, email addresses, phone numbers, internet addresses and browsers, on the document and in its history. Each is replaced by "Removed on" and the day.',
    'The message to the people it was sent to, names in its title, and the details your account keeps on it, such as a case number.',
    'Our stored copies of the emails about it, the record of its text messages, and the log of what was sent about it to systems you connected.',
    'The name and the words of a person who disputed it, in your account. The mark that it is disputed stays.',
  ],
};

/** Everything a level removes, its own lines after those of the levels before it. */
export const removesAt = (level: PurgeLevel): string[] => PURGE_LEVELS.slice(0, PURGE_LEVELS.indexOf(level) + 1).flatMap((l) => LEVEL_REMOVES[l]);

/** What a level leaves in the record that a higher level would take. */
export const KEPT_AT: Record<PurgeLevel, string> = {
  documents: 'The answers people gave, their signature pictures, and the names, addresses and internet addresses in the record stay.',
  values: 'The names, addresses and internet addresses in the record stay.',
  personal: 'The record stays with the personal details taken out.',
};

/**
 * What stays after any deletion, in the order Settings, the document page and /security/processing print it.
 * `backups` is DATA_BACKUPS (src/lib/dataplace.ts): the operator's own words, or null when they said nothing.
 */
export function retentionStays(backups: string | null): string[] {
  return [
    'The record of the document: its number, its title, how it ended, the days it was sent and ended, and its history, with whatever was deleted taken out.',
    'The fingerprint (SHA-256) of its signed PDF, with its number and the day it was completed. Whoever still has that exact file can check it at Verify a document, and is told it was completed here and deleted since. This stays with the record, and for one year after the account is deleted.',
    'Copies already emailed to people, and PDFs, full records and exports that someone already downloaded. This server cannot reach those.',
    backups
      ? `Backups, until the backup cycle of the people who run this server ends. They say: "${backups}"`
      : 'Backups, if the people who run this server keep any. They have not said whether they do, or for how long. Ask them.',
    'Your address book: the people you sent to stay under Contacts until you remove them there.',
    'A dispute: the mark that someone disputes the document stays, also at Verify a document. Reports and help requests that name it stay with the people who run this server. A document is not deleted while a dispute about it is open.',
  ];
}

/** The same in one sentence, for the email. The full list is on /security/processing. */
export const STAYS_SHORT = 'What stays: the record of the document without what was deleted, the fingerprint of its signed PDF, copies people already have, and backups until they are replaced.';

/** The line that takes the place of a personal detail. `day` is YYYY-MM-DD. */
export const removedOn = (day: string) => `Removed on ${day}`;
/** Whether a stored value is such a line, and its day. The screens then say it once, with the day written out. */
export const removedDay = (v: any): string | null => /^Removed on (\d{4}-\d{2}-\d{2})$/.exec(String(v ?? ''))?.[1] || null;

/** A day as an email or a line of the history writes it: "5 December 2026". Screens use the reader's own format. */
export const plainDay = (iso: string | null | undefined): string => {
  const t = Date.parse(String(iso || ''));
  return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** What the document page says about a history some of whose lines had details removed. */
export const redactedNote = (day: string) => `Some details were removed on ${day}. The record can no longer be recomputed for those lines.`;

/** What a recipient's link says once the files of its document were deleted. */
export const PURGED_LINK = 'The sender deleted this document. It is no longer kept here, so this link cannot open it. If you need a copy, use the one you were emailed or downloaded, or ask the sender.';

/**
 * What the people on a document keep when its sender deletes it from their account, said with the day their link
 * stops when one is set (`until`: that day as the reader writes it; the deletion schedule's day, or the day someone
 * asked for).
 */
export const copiesKept = (until?: string | null) => (until
  ? `Everyone who was on it keeps their link and their download until ${until}. On that day its files are deleted here, and they are not told. Copies they already saved stay with them.`
  : 'Everyone who was on it keeps their copy: their link and their download keep working unless its files are deleted later. It is removed for everyone when this account is closed.');

/**
 * What a hold does, in the words every screen uses. It is a rule of this software, not a lock on the disk: someone
 * with access to the database, the files or the backups can still delete, and a court order or the operator's own
 * legal duty can require a hold to give way (two people who run the server have to agree to end one).
 */
export const HOLD_SHORT = 'It cannot be deleted until an admin ends the hold. Copies people already have, and backups, are not covered.';
export const HOLD_TRUTH = 'While a hold is on, the software refuses to delete what it covers, or its files: for the sender, for the admins, for the deletion schedule and when the account is closed. Each refused attempt is recorded. It cannot stop someone with access to the server\'s database, disk or backups, and it does not reach copies people already have.';
export const HOLD_BACKUPS = 'A hold does not reach the backups of the people who run this server: they are kept and replaced on the operator\'s own cycle. If held documents must also be kept in a backup, ask them to set one aside.';
export const HOLD_OVERRIDE = 'An admin of the account ends a hold, with a reason. When a court order or their own legal duty requires it, the people who run this server can end one too: that needs two of them, one to ask and another to confirm, and both are written to the deletion record.';

/** Whether a number of days is one a period may be: a whole number from RETENTION_MIN_DAYS to RETENTION_MAX_DAYS. */
export const validDays = (n: any): boolean => Number.isInteger(n) && n >= RETENTION_MIN_DAYS && n <= RETENTION_MAX_DAYS;

/** What to say under a box when its number of days cannot be used, or '' when it can. Empty means "never". */
export function daysProblem(typed: string): string {
  const s = String(typed ?? '').trim();
  if (!s) return '';
  const n = Number(s);
  const range = `Type a whole number from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS.toLocaleString('en-US')}, or leave it empty to keep them.`;
  if (!Number.isInteger(n)) return `"${s.slice(0, 20)}" is not a whole number of days. ${range}`;
  if (n < RETENTION_MIN_DAYS) return `${daysText(n)} is too short. ${range}`;
  if (n > RETENTION_MAX_DAYS) return `${daysText(n)} is too long. ${range}`;
  return '';
}

/** The moment a document that ended at `closedAt` reaches the end of a period of `days`, as an ISO time. */
export const dueAt = (closedAt: string, days: number): string => new Date(Date.parse(closedAt) + days * 864e5).toISOString();

/** "30 days", "1 day". */
export const daysText = (n: number) => `${n.toLocaleString('en-US')} day${n === 1 ? '' : 's'}`;
