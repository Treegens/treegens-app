// Ready-made templates ("starters"): a sensible starting point for a small organisation's first real document.
// One file per starter in this folder. The server renders one to a PDF and makes a normal template of it
// (src/server/starters.ts, POST /api/starters/:id/use); the Templates page lists them (components/templates/Starters.tsx).
//
// What they are not: legal advice, or written for any one country. Each says so, in the list and in the editor
// (starterNote). Nothing here is a will, a deed or a power of attorney, and nothing is country-specific.
// No environment and no side effects: pages and the server import this file alike.
import { PRODUCT } from '../site.ts';
import type { Starter, StarterAsk } from './types.ts';
import { volunteer } from './volunteer.ts';
import { photos } from './photos.ts';
import { sharedata } from './sharedata.ts';
import { gift } from './gift.ts';
import { planting } from './planting.ts';
import { event } from './event.ts';
import { parental } from './parental.ts';
import { confidential } from './confidential.ts';
import { grant } from './grant.ts';
import { equipment } from './equipment.ts';

export type { Starter, StarterAsk, StarterField, StarterRole, Block } from './types.ts';

export const STARTERS: readonly Starter[] = [volunteer, photos, sharedata, gift, planting, event, parental, confidential, grant, equipment];

export const starterById = (id: unknown): Starter | null => STARTERS.find((s) => s.id === id) ?? null;

/** Asked of everyone who picks a starter: printed wherever {organisation} stands. */
export const ORGANISATION_ASK: StarterAsk = { key: 'organisation', label: "Your organisation's name", max: 100, example: 'Green Roots Community Group' };

/** Every box shown when a starter is picked, the organisation's name first. */
export const asksOf = (s: Starter): StarterAsk[] => [ORGANISATION_ASK, ...(s.asks || [])];

/** Who reviewed it, in one sentence, or that nobody has. */
export const reviewLine = (s: { reviewedBy: string; place: string }): string =>
  s.reviewedBy ? `Reviewed by ${s.reviewedBy} for ${s.place}.` : 'Not reviewed by a lawyer.';

/** The note shown in the list and in the editor. */
export const starterNote = (s: { reviewedBy: string; place: string }): string => `A starting point written by ${PRODUCT}, not legal advice. ${reviewLine(s)}`;

/** Text with nothing a printed page cannot hold: control characters and line breaks become spaces, and runs of spaces one. */
export const cleanAsk = (v: unknown): string => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();

/** The text with every {key} replaced by what was written in. A key nobody wrote stays as it is. */
export const fillText = (text: string, values: Record<string, string>): string => text.replace(/\{([a-z]+)\}/g, (m, k) => (values[k] ? values[k] : m));

/** What the sender has to fix before a starter can be used, or '' when nothing. */
export function askProblem(s: Starter, values: Record<string, unknown>): string {
  for (const a of asksOf(s)) {
    const v = cleanAsk(values[a.key]);
    if (!v) return `Write ${a.label.charAt(0).toLowerCase()}${a.label.slice(1)}. It is printed in the document.`;
    if (v.length > a.max) return `${a.label} is ${v.length} characters long, and the most that fits is ${a.max}. Shorten it.`;
  }
  return '';
}
