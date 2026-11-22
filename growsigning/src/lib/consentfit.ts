// How the top of the consent screen keeps to 120 words before the tick (research/ux-charter.md P7) when the sender's
// own words make it long: which words go first, and how far to go. Used by src/components/sign/ConsentTop.tsx, and
// tested in tests/open-signing.test.ts. Our legal sentences never go: they are versioned text (src/lib/policy.ts).
import { ASK_PREFIX, listName } from './docname.ts';

/** The words "Read the message" (or "Read the note") that stand in for the sender's words once they are folded. */
export const FOLD_LINE_WORDS = 3;

/**
 * The step the screen needs, from one count of every word before the tick (`total`) and the words of each part that
 * may go: 0 nothing goes, 1 the person's own address in the "For" line, 2 also the sender's message is folded, 3 also
 * "Please sign: " in the heading, 4 also the "For" line. A part that is not on the screen counts 0. Past step 4 nothing
 * more goes, whatever the count: what is left is the subject and name the sender chose, and our own legal text.
 */
export function consentFit(total: number, cap: number, part: { email: number; words: number; prefix: number; forLine: number }): number {
  let w = total;
  if (w <= cap) return 0;
  w -= part.email;
  if (w <= cap) return 1;
  if (part.words) w = w - part.words + FOLD_LINE_WORDS;
  if (w <= cap) return 2;
  w -= part.prefix;
  if (w <= cap) return 3;
  return 4;
}

/**
 * The heading of the consent screen. Someone asked to approve, read or witness is not asked to sign, so a subject
 * that starts with the app's own "Please sign: " is shown without it ("Planting partnership"). A subject the sender
 * wrote in their own words is shown as written, for everyone.
 */
export const headingFor = (subject: unknown, notSigner: boolean): string => (notSigner ? listName(subject) : String(subject ?? ''));

/** "Please sign: Planting partnership" as its two parts, so the first can be left out when the screen is long. */
export function splitAsk(heading: string): { prefix: string; rest: string } {
  const m = /^(please sign:\s*)(\S[\s\S]*)$/i.exec(heading);
  return m && ASK_PREFIX.trim().toLowerCase() === m[1].trim().toLowerCase() ? { prefix: m[1], rest: m[2] } : { prefix: '', rest: heading };
}
