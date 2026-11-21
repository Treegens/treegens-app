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
/** After the reader of an address said no (or marked the asking email as spam), that account cannot ask it again for this many days. */
export const ARCHIVE_REFUSED_DAYS = 30;
/** How long that "no" can be taken back from the same page. */
export const ARCHIVE_UNDO_MINUTES = 60;

/** What stands in a copy where a link was (the designer's words, research/ux-notes.json, "ds-mail-records"). */
export const ARCHIVE_LINK_REMOVED = '(link removed in this copy)';
/** What stands in a copy where a security code or a one-time code was. */
export const ARCHIVE_CODE_REMOVED = '(code removed in this copy)';
/** The start of the subject of every copy, so a mailbox rule can file them. */
export const ARCHIVE_SUBJECT = 'Archive copy: ';

/** A moment as every copy and Settings write it: "20 November 2026 at 14:05 UTC". */
export const archiveMoment = (iso: string): string => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} at ${d.toISOString().slice(11, 16)} UTC`;
};

/** The one line of the card in Settings about what a copy leaves out. */
export const ARCHIVE_ONE_LINE = 'Each copy has the signing link taken out.';
/** What an admin reads after adding an address. */
export const ARCHIVE_ADDED = 'We sent a link to confirm it. Copies start once it is confirmed.';

/** The first line of every copy. */
export const archiveFirstLine = (to: string, at: string): string => `Archive copy of an email sent to ${to} on ${archiveMoment(at)}.`;

/** The second line of every copy: what was taken out and why. */
export const ARCHIVE_WHY = 'Signing links, security codes and one-time codes are taken out of this copy, so nobody can open or sign the document from it. Everything else is as it was sent, with the same attachments.';

/** What an archive address gets, said the same way in Settings, in the email that asks it to confirm, on /security and in the README. */
export const ARCHIVE_WHAT = `A copy of every email the account sends about its documents: requests to sign, reminders, deadline warnings, the completed copy with its signed PDF, declines, voided and corrected documents, comments, and the emails to witnesses and to the members of signing groups. Each copy is an email of its own, not a hidden copy of the original. Signing links, security codes and one-time codes are taken out, so nobody can open or sign a document from a copy. Everything else stays, the names, addresses and messages in the email and the attached signed PDF included. Emails about the plan, payments and help requests are not copied.`;

/** What a confirmed address does not do, for the same places. */
export const ARCHIVE_LIMITS = 'A copy goes once the email it copies has left our server. An email that never left is not copied. Copies wait while sending is paused on the account and go out when it is lifted. A copy that is still waiting when its document is deleted or purged is not sent. Copies never count towards the daily sending limits.';

/** The button that says no on the page the email opens, and how the email and Settings name it. */
export const ARCHIVE_NO = 'No, do not send copies';
/** What an admin reads under the field when what they typed is not one plain email address. */
export const ARCHIVE_BAD_ADDRESS = 'That does not look like an email address. Check it and try again. Nothing was sent.';
/** What an admin reads when the address belongs to someone on the account. */
export const ARCHIVE_TEAM_MEMBER = 'This is the address of someone on your team. They will get each copy as well as their own emails.';

/**
 * The one plain address in what was typed, in lower case, or null. Plain means the address alone: no name in front,
 * no angle brackets, quotes, commas or spaces, and no full stop at either end of a part, because a mail program
 * reads all of those as another spelling of the same inbox. Letters of any script are fine.
 */
export function archiveAddress(typed: unknown): string | null {
  const s = String(typed ?? '').trim().normalize('NFKC').toLowerCase();
  if (s.length > 254 || !/^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(s)) return null;
  const [local, domain] = s.split('@');
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..') || domain.split('.').some((l) => l.startsWith('-') || l.endsWith('-'))) return null;
  return s;
}

/** Mail hosts known to ignore full stops before the @, and the one name each is filed under. */
const DOTLESS_HOSTS: Record<string, string> = { 'gmail.com': 'gmail.com', 'googlemail.com': 'gmail.com' };

/**
 * The inbox an address reaches, as far as its spelling says: the address without a "+tag", and at Gmail (gmail.com
 * and googlemail.com are one mailbox, and full stops before the @ mean nothing there) without the full stops. The
 * daily limits, and a "no" from whoever reads the inbox, hold for every address with the same key. Other providers'
 * aliases, and a second address that forwards to the same mailbox, cannot be told from the spelling.
 */
export function archiveKey(email: string): string {
  const s = String(email ?? '').trim().normalize('NFKC').toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1) return s;
  const local = s.slice(0, at).split('+')[0];
  const host = s.slice(at + 1);
  return DOTLESS_HOSTS[host] ? `${local.replace(/\./g, '')}@${DOTLESS_HOSTS[host]}` : `${local}@${host}`;
}
