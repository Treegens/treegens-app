// Archive copies of emails: the rules and the words that the server (src/server/archivemail.ts, routes-archive.ts),
// Settings (src/components/settings/ArchiveSettings.tsx), /security and the README share. Plain constants and
// functions, no environment, so a page may import this file.
//
// An admin names up to ARCHIVE_MAX_ADDRESSES email addresses, a records office or a freedom-of-information team, say.
// Each is confirmed from its own inbox before it gets anything. Then every email the account sends about one of its
// documents also goes to each of them, as an email of its own (never a Bcc), with what would open or sign the
// document taken out.

/** How many archive addresses one account can have, confirmed or waiting. */
export const ARCHIVE_MAX_ADDRESSES = 5;
/** Copies that come back for good from one address, with none arriving in between, before copies to it are paused. */
export const ARCHIVE_BOUNCES_TO_PAUSE = 3;
/** How long the link that confirms an address works. */
export const ARCHIVE_CONFIRM_DAYS = 7;
/** Emails asking an address to confirm that one account may send in 24 hours, over all its addresses. */
export const ARCHIVE_ASKS_PER_DAY = 10;
/** The same for one address: the first email and "send the link again" together. */
export const ARCHIVE_ASKS_PER_ADDRESS_DAY = 3;
/** After the reader of an address said "this was not me", that account cannot ask it again for this many days. */
export const ARCHIVE_REFUSED_DAYS = 30;
/** How long "this was not me" can be undone from the same page. */
export const ARCHIVE_UNDO_MINUTES = 60;

/** What stands in a copy where a link was. */
export const ARCHIVE_LINK_REMOVED = '[link removed in the archive copy]';
/** What stands in a copy where a security code or a one-time code was. */
export const ARCHIVE_CODE_REMOVED = '[code removed in the archive copy]';
/** The start of the subject of every copy, so a mailbox rule can file them. */
export const ARCHIVE_SUBJECT = 'Archive copy: ';

/** A moment as every copy and Settings write it: "20 November 2026 at 14:05 UTC". */
export const archiveMoment = (iso: string): string => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} at ${d.toISOString().slice(11, 16)} UTC`;
};

/** The first line of every copy. */
export const archiveFirstLine = (to: string, at: string): string => `Archive copy of an email sent to ${to} on ${archiveMoment(at)}.`;

/** The second line of every copy: what was taken out and why. */
export const ARCHIVE_WHY = 'Signing links, security codes and one-time codes are taken out of this copy, so nobody can open or sign the document from it. Everything else is as it was sent, with the same attachments.';

/** What an archive address gets, said the same way in Settings, in the email that asks it to confirm, on /security and in the README. */
export const ARCHIVE_WHAT = `A copy of every email the account sends about its documents: requests to sign, reminders, deadline warnings, the completed copy with its signed PDF, declines, voided and corrected documents, comments, and the emails to witnesses and to the members of signing groups. Each copy is an email of its own, not a hidden copy of the original. Signing links, security codes and one-time codes are taken out, so nobody can open or sign a document from a copy. Everything else stays, the names, addresses and messages in the email and the attached signed PDF included. Emails about the plan, payments and help requests are not copied.`;

/** What a confirmed address does not do, for the same places. */
export const ARCHIVE_LIMITS = 'A copy goes once the email it copies has left our server. An email that never left is not copied. Copies wait while sending is paused on the account and go out when it is lifted. They never count towards the daily sending limits.';
