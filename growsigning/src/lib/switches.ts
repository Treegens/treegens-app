// Small switches for senders and admins (research/docusign-gaps.json, batch "switches"; designer's note ds-switches in
// research/ux-notes.json). The rules and words that the pages and the server share. The server's side is
// src/server/switches.ts.
//
// Every switch keeps today's behaviour until an admin changes it: a person may pass a document on, questions and
// comments are allowed, all three ways of making a signature are offered, members may place stamps, and a copy of a
// document that is still out is marked with the words it always had.

import { formatDate } from './dates.ts';

/** The ways of making a signature or initials the signing page offers. */
export const SIGN_WAYS = ['type', 'draw', 'upload'] as const;
export type SignWay = (typeof SIGN_WAYS)[number];
export const WAY_LABELS: Record<SignWay, string> = { type: 'Type', draw: 'Draw', upload: 'Upload a picture' };

/** Said beside the setting, because people often think a drawn signature counts for more. */
export const WAYS_NOTE = 'Drawing does not make a signature stronger in law.';

/** The ways stored for an account ("type,draw"), in their fixed order. Nothing stored, or nothing valid: all three. */
export function waysOf(stored: string | null | undefined): SignWay[] {
  const got = String(stored || '').split(',').map((s) => s.trim());
  const ways = SIGN_WAYS.filter((w) => got.includes(w));
  return ways.length ? ways : [...SIGN_WAYS];
}

/** Whether the ways are fewer than all three: then a saved signature (made we cannot say how) is not offered. */
export const waysLimited = (ways: readonly string[]): boolean => SIGN_WAYS.some((w) => !ways.includes(w));

/**
 * How one signature or initials was made, as the signing page reports it: "type:<style>", "draw", "upload" or
 * "saved". Anything else is no answer (null). The style is a name of one of the handwriting styles, or "plain".
 */
export function howOf(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (s === 'draw' || s === 'upload' || s === 'saved') return s;
  const m = /^type:([A-Za-z ]{1,40})$/.exec(s);
  return m ? `type:${m[1].trim()}` : null;
}

/** The way a "how" was made, for checking it against the ways allowed. A saved signature has none of its own. */
export const wayOfHow = (how: string | null): SignWay | 'saved' | null =>
  !how ? null : how === 'saved' ? 'saved' : how.startsWith('type:') ? 'type' : (how as SignWay);

/** The words on the certificate: "typed, style Dancing", "drawn", "uploaded picture". */
export function howText(how: string | null | undefined): string | null {
  if (!how) return null;
  if (how === 'draw') return 'drawn';
  if (how === 'upload') return 'uploaded picture';
  if (how === 'saved') return 'a signature they had saved before';
  if (how.startsWith('type:')) {
    const style = how.slice(5).replace(/^Sig\s+/i, '').trim();
    return style && style.toLowerCase() !== 'plain' ? `typed, style ${style}` : 'typed, in plain letters';
  }
  return null;
}

/** The words across the pages of a copy made while a document is still out, unless an admin chose others. */
export const MARK_WORDS_DEFAULT = 'NOT COMPLETED YET';
export const MARK_WORDS_MAX = 28;

/** The words the mark may start with: each says the copy is not finished. */
export const MARK_STARTS = ['NOT', 'UNSIGNED', 'DRAFT', 'PENDING', 'UNFINISHED', 'INCOMPLETE', 'AWAITING', 'WAITING', 'IN PROGRESS', 'STILL OUT', 'COPY ONLY', 'FOR REVIEW'];

/**
 * Why words cannot be the mark, or null when they can. The mark is there so a copy never passes for a signed
 * document, so the words must start by saying it is not finished (MARK_STARTS), may hold only letters, numbers,
 * spaces and hyphens (no comma or colon to begin a second sentence), and only after a starting NOT may they name
 * signing, completing or the like ("NOT SIGNED YET"). The small line under them and the line at the foot of each
 * page always say that not everyone has signed.
 */
export function markWordsProblem(words: string): string | null {
  const w = String(words ?? '').trim();
  if (!w) return null; // empty goes back to the usual words
  if (w.length > MARK_WORDS_MAX) return `Use at most ${MARK_WORDS_MAX} letters, so the words fit across a page. Nothing was changed.`;
  // Letters with accents are read without them ("SIGNÉ" is "SIGNE"); anything else but A to Z, digits, spaces and
  // hyphens is refused.
  const plain = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ');
  if (!/^[A-Z0-9 -]+$/.test(plain)) return 'Use letters, numbers, spaces and hyphens only. Nothing was changed.';
  const starts = MARK_STARTS.find((x) => plain === x || plain.startsWith(`${x} `) || plain.startsWith(`${x}-`));
  const looksDone = /SIGN(?!ATUR)|EXECUT|COMPLET|FINAL|DONE|AGREED|APPROV|VALID|OFFICIAL|BINDING|ORIGINAL|CERTIF|ACCEPT|CONFIRM/.test(plain.replace(/UNSIGNED/g, '').replace(/[ -]/g, ''));
  if (!starts || (looksDone && starts !== 'NOT')) return 'These words could make an unfinished copy look signed. Start with words that say it is not finished, such as NOT SIGNED YET or DRAFT. Nothing was changed.';
  return null;
}

/** The words as they are drawn: in capitals, single spaces. */
export const markWords = (stored: string | null | undefined): string => {
  const w = String(stored || '').replace(/\s+/g, ' ').trim();
  return w && !markWordsProblem(w) ? w.toUpperCase() : MARK_WORDS_DEFAULT;
};

/**
 * Said under a Help answer on the signing page that names Questions and comments when this person's list does not
 * have it: the sender turned it off for this document (designer's note: the reason lives only in Help).
 */
export const ASK_OFF_IN_HELP = 'Questions and comments is turned off for this document, so it is not in your list. To ask the sender something, reply to the email you got about this document.';

/** The facts about the switches that the signing page is given for one document. */
export type SigningSwitches = { pass_on: boolean; comments: boolean; ways: SignWay[] };
export const SWITCHES_AS_TODAY: SigningSwitches = { pass_on: true, comments: true, ways: [...SIGN_WAYS] };

// Public forms: the most people who may sign, and the day it closes.
export const FORM_LIMIT_MAX = 1_000_000;

/** The last day a form takes signatures, as the admin chose it ("2026-11-20"). */
export const formLastDay = (p: { closes_at?: string | null; closes_day?: string | null }): string | null => p.closes_day || (p.closes_at ? String(p.closes_at).slice(0, 10) : null);

/** "2026-11-20" as "20 Nov 2026": the same in every time zone, since it is the day the admin chose. */
export function dayWords(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return String(day || '');
  return formatDate(`${day}T12:00:00Z`, 'D MMM YYYY', 'UTC');
}

/** The line under a form's name on the Forms page when it has a limit or a closing day. Nothing when it has neither. */
export function formLimitLine(p: { max_signed?: number | null; closes_at?: string | null; closes_day?: string | null }, at = Date.now()): string {
  if (p.closes_at && Date.parse(p.closes_at) <= at) return `Closed on ${dayWords(formLastDay(p))}: it takes no more signatures.`;
  const parts: string[] = [];
  if (p.max_signed) parts.push(`takes up to ${p.max_signed} signature${p.max_signed === 1 ? '' : 's'}`);
  if (p.closes_at) parts.push(`closes after ${dayWords(formLastDay(p))}`);
  return parts.length ? `${parts.join(', ')}.`.replace(/^./, (c) => c.toUpperCase()) : '';
}
