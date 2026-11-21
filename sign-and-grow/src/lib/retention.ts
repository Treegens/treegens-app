// How long closed envelopes are kept, what a purge removes, what stays, and what a legal hold does: the numbers and
// the words that the server (src/server/records.ts) and the pages share. Plain constants and functions with no
// environment in them, so a 'use client' file may import this as well as the server.
//
// Before changing a sentence here, find the code in src/server/records.ts that makes it true. Nothing here may say
// "deleted everywhere": copies that people were emailed or downloaded, and backups, are out of this server's reach.

/** The shortest and the longest period an account or a template can keep closed envelopes for, in days. */
export const RETENTION_MIN_DAYS = 30;
export const RETENTION_MAX_DAYS = 9999;
/** Days between the one email that lists what is due and the purge itself. Also the wait after "Purge now". */
export const RETENTION_NOTICE_DAYS = 14;
/** The states an envelope can be purged in. One that is still out for signature is never purged. */
export const RETENTION_CLOSED = ['completed', 'voided', 'declined', 'expired'];

export type PurgeLevel = 'documents' | 'values' | 'personal';
export const PURGE_LEVELS: PurgeLevel[] = ['documents', 'values', 'personal'];
export const isPurgeLevel = (v: any): v is PurgeLevel => (PURGE_LEVELS as any[]).includes(v);

/** The name of each level, as a choice in a list. */
export const LEVEL_NAME: Record<PurgeLevel, string> = {
  documents: 'The documents',
  values: 'The documents and what people filled in',
  personal: 'The documents, what people filled in, and the personal details in the record',
};

/** What each level removes, in full. Each level removes everything the one before it does. */
export const LEVEL_REMOVES: Record<PurgeLevel, string[]> = {
  documents: [
    'The pages of its documents. A file that a template or another envelope still uses stays with that template or envelope.',
    'The signed PDF with its certificate of completion, and the copies kept of what people signed before a correction.',
    'Files that signers attached, and the pictures of stamps put on it.',
    'The attachments of our stored copies of the emails about it.',
  ],
  values: [
    'Every value typed, ticked or chosen in its fields, also the ones kept from before a correction.',
    'The pictures of each signature and initials.',
    'The words of its questions and comments.',
    'The reasons given for declining or voiding it.',
  ],
  personal: [
    'Names, email addresses, phone numbers, internet addresses and browsers, on the envelope and in its audit trail. Each is replaced by "Removed on" and the day.',
    'The message to its recipients, names in its subject, and the details your account keeps on it, such as a case number.',
    'Our stored copies of the emails about it, the record of its text messages and its webhook log.',
  ],
};

/** Everything a level removes, its own lines after those of the levels before it. */
export const removesAt = (level: PurgeLevel): string[] => PURGE_LEVELS.slice(0, PURGE_LEVELS.indexOf(level) + 1).flatMap((l) => LEVEL_REMOVES[l]);

/** What a level leaves in the record that a higher level would take. */
export const KEPT_AT: Record<PurgeLevel, string> = {
  documents: 'What people filled in, their signature pictures, and the names, addresses and internet addresses in the record stay.',
  values: 'The names, addresses and internet addresses in the record stay.',
  personal: 'The record stays with the personal details taken out.',
};

/**
 * What stays after any purge, in the order the setting, the email, the envelope page and /security/processing print
 * it. `backups` is DATA_BACKUPS (src/lib/dataplace.ts): the operator's own words, or null when they said nothing.
 */
export function retentionStays(backups: string | null): string[] {
  return [
    'The record of the envelope: its ID, its subject, its state, the days it was sent and closed, and its audit trail with the chain values, with the details the level removes taken out of it.',
    'The SHA-256 fingerprint of its signed PDF, its envelope ID and the day it was completed, so that Verify a document can still tell whoever holds that exact file that it was completed here and deleted since. That stays with the record, and for one year after the account is deleted.',
    'Copies already emailed to people, and PDFs, evidence packs and exports that someone already downloaded. Those are out of this server\'s reach.',
    backups
      ? `Backups, until the backup cycle of the people who run this server ends. They say: "${backups}"`
      : 'Backups, if the people who run this server keep any. They have not said whether they do, or for how long. Ask them.',
    'Reports about it, help requests that name it, and the record of disputes, with the people who handle them. A document someone disputes is not purged while that dispute is open.',
  ];
}

/** The line that takes the place of a personal detail. `day` is YYYY-MM-DD. */
export const removedOn = (day: string) => `Removed on ${day}`;

/** What the envelope page says about an audit trail some of whose lines had details removed. */
export const redactedNote = (day: string) => `Some details were removed on ${day}. The record can no longer be recomputed for those lines.`;

/** What a recipient's link says once its envelope was purged. */
export const PURGED_LINK = 'The sender deleted this document. It is no longer kept here, so this link cannot open it. If you need a copy, use the one you were emailed or downloaded, or ask the sender.';

/**
 * What a legal hold does, in the words every screen uses. It is a rule of this software, not a lock on the disk:
 * someone with access to the database, the files or the backups can still delete, and a court order or the operator's
 * own legal duty can require a hold to give way (two people who run the server have to agree to lift one).
 */
export const HOLD_TRUTH = 'While a hold is on, the software refuses every way of deleting or purging what it covers: the sender, the admins, closing the account and the retention rule. Each refused attempt is recorded. It cannot stop someone with access to the server\'s database, disk or backups, and it does not reach copies people already have.';
export const HOLD_BACKUPS = 'A hold does not reach the backups of the people who run this server: they are kept and replaced on the operator\'s own cycle. If held documents must also be kept in a backup, ask them to set one aside.';
export const HOLD_OVERRIDE = 'An admin of the account lifts a hold, with a reason. When a court order or their own legal duty requires it, the people who run this server can lift one too: that needs two of them, one to ask and another to confirm, and both are written to the record.';

/** Whether a number of days is one a period may be: a whole number from RETENTION_MIN_DAYS to RETENTION_MAX_DAYS. */
export const validDays = (n: any): boolean => Number.isInteger(n) && n >= RETENTION_MIN_DAYS && n <= RETENTION_MAX_DAYS;

/** The moment an envelope that closed at `closedAt` reaches the end of a period of `days`, as an ISO time. */
export const dueAt = (closedAt: string, days: number): string => new Date(Date.parse(closedAt) + days * 864e5).toISOString();

/** "30 days", "1 day". */
export const daysText = (n: number) => `${n.toLocaleString('en-US')} day${n === 1 ? '' : 's'}`;
