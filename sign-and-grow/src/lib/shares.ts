// Working for a colleague (src/server/shares.ts): a member shares their documents with someone else in the same
// account, at one of three levels, for some days. The words the Settings card, the envelope page, the emails, the
// signing page and the certificate all use are here, so the server and the pages cannot disagree. Plain data in,
// words out. Nothing here is about another account: sharing never crosses accounts.

import { dayOf, daysBetween, dayWords } from './delegation.ts';

export type ShareLevel = 'see' | 'manage' | 'send';
export const SHARE_LEVELS: readonly ShareLevel[] = ['see', 'manage', 'send'];
export const isShareLevel = (v: unknown): v is ShareLevel => typeof v === 'string' && (SHARE_LEVELS as readonly string[]).includes(v);
/** A level covers every level before it: "send for me" can also manage and see. */
export const levelCovers = (have: ShareLevel, need: ShareLevel): boolean => SHARE_LEVELS.indexOf(have) >= SHARE_LEVELS.indexOf(need);

/** How far ahead a share can start, in days. */
export const SHARE_AHEAD_DAYS = 365;

/** Each level: its name in the picker and what it lets the colleague do, in one sentence. */
export const LEVEL_WORDS: Record<ShareLevel, { name: string; covers: string }> = {
  see: { name: 'See', covers: 'Follow your documents: who has signed, and their history. They cannot open the files, change, send or download anything.' },
  manage: { name: 'Manage', covers: 'Also remind people, correct a person, give more time, pause, send an email again, cancel, and download.' },
  send: { name: 'Send for me', covers: 'Also make, change and send documents in your name. People see your name and theirs.' },
};

/** The Settings card. */
export const CARD_TITLE = 'Documents I send: a colleague looks after them';
export const CARD_HINT = 'Someone else in this account can then see or look after the documents you send, for example while you are away. Everything they do is recorded with both names. You or an admin can end it at any time.';
export const RECEIVED_TITLE = 'Shared with me';

/** "Ben Okoro (sent by Ana Silva)": how a recipient reads a document someone sent for its owner. */
export const sentByName = (owner: string, by: string): string => `${owner} (sent by ${by})`;
/** The line under the email, and on the certificate. */
export const sentByLine = (owner: string, by: string): string => `${by} sent this for ${owner}.`;
/** "Ana Silva <ana@x> for Ben Okoro": who did something through a share, in the audit trail. */
export const forActor = (actor: string, owner: string): string => `${actor} for ${owner}`;
/** The audit line of a move. */
export const movedLine = (from: string, to: string, by: string): string => `Moved from ${from} to ${to} by ${by}.`;

/** Step 3's choice, only for someone a colleague shared sending with. */
export const sendForLabel = (owner: string): string => `Send for ${owner}`;
/** The envelope page's More line. */
export const MOVE_LABEL = 'Move to a colleague';
export const MOVE_HINT = 'They become the person this document belongs to. The record keeps who sent it first and says who moved it.';

/** What a share's dates say: "from 3 March 2027", "from 3 March 2027 to 14 March 2027". */
export function shareDates(from: string, to?: string | null): string {
  if (!to) return `from ${dayWords(from)}, until it is ended`;
  return from === to ? `on ${dayWords(from)}` : `from ${dayWords(from)} to ${dayWords(to)}`;
}

/**
 * Why these dates cannot be saved, or null. `today` is the owner's own today. The start may be today or later (at
 * most a year ahead); the end is optional, and when given it is on or after the start.
 */
export function shareDatesProblem(from: unknown, to: unknown, today: string): string | null {
  const a = dayOf(from);
  if (!a) return 'Choose a first day from the calendar, or write it year-month-day, like 2027-03-20.';
  if (a < today) return 'The first day is in the past. Choose today or a later day.';
  if (daysBetween(today, a) > SHARE_AHEAD_DAYS) return 'The first day can be at most a year from today. Set it nearer the time.';
  if (to === null || to === undefined || to === '') return null;
  const b = dayOf(to);
  if (!b) return 'Choose a last day from the calendar, write it year-month-day, or leave it empty to share until you end it.';
  if (b < a) return 'The last day is before the first day. Swap them, or choose again.';
  return null;
}

/** Said when a colleague tries something their share does not cover. Two sentences, the second says what to do. */
export function levelRefusal(owner: string, level: ShareLevel, need: ShareLevel): string {
  const what = need === 'send' ? 'send or change drafts' : need === 'manage' ? 'change, remind, cancel or download' : 'open';
  return `${owner} shared their documents with you to ${level === 'send' ? 'send for them' : level}, which does not let you ${what} here. Ask ${owner} or an admin to share them with you at a higher level.`;
}

// What the envelope page offers someone who came through a share: only what the server lets them do, so no button
// they see ends in a refusal. Keys are the page's main button kinds and More lines (src/lib/envelopepage.ts).
const PAGE_ALLOWS: Record<ShareLevel, readonly string[]> = {
  see: [],
  // 'comment': write, answer and settle questions and comments. Nothing gives a colleague a person's signing link
  // (Copy link, QR code, WhatsApp, Text): that stays with the owner and the admins.
  manage: ['remind', 'download', 'reopen', 'open_pdf', 'full_record', 'edit', 'more_time', 'pause', 'resume', 'cancel', 'comment'],
  send: ['remind', 'download', 'reopen', 'open_pdf', 'full_record', 'edit', 'more_time', 'pause', 'resume', 'cancel', 'comment', 'continue', 'send_now', 'change_time', 'keep_draft'],
};
/** Whether the page shows this main button or More line to a colleague at this level. */
export const shareAllows = (level: ShareLevel, key: string): boolean => (PAGE_ALLOWS[level] || []).includes(key);

/** The line at the top of the envelope page for someone who came through a share. */
export function sharedLine(owner: string, level: ShareLevel): string {
  if (level === 'see') return `${owner} shared this with you to see. You can follow who has signed and read its history. ${owner} or an admin does the rest.`;
  if (level === 'manage') return `${owner} shared this with you to manage. What you do here is recorded as done by you for ${owner}.`;
  return `${owner} shared sending with you. What you do here is recorded as done by you for ${owner}.`;
}

/** Under Questions and comments for a colleague who may read them but not write (the 'see' level). */
export const commentsReadOnly = (owner: string): string => `${owner} shared this with you to see, so you can read these but not write here. ${owner} or an admin answers.`;

/** After pressing Send for a colleague: who is emailed at the end, and where to follow it. */
export const sentForAfter = (owner: string, whoFinishes: string): string => `We email ${owner} when ${whoFinishes} finished. You can follow it here and in your Documents list, marked as ${owner}'s.`;

/** The Documents list marks a row that came through a share. */
export const sharedRowLabel = (owner: string): string => `${owner}'s`;
