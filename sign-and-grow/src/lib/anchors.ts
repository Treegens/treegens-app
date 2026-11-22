// Placing fields by the words in a document, for the API: a field with "anchor" goes where a piece of text is, and
// "auto_tags" turns every {{signature}} style tag into a field. The tag rules are the editor's own (autoplace.ts),
// so a document that works with "Find fields" in the editor works the same way here. Plain data only: the server
// reads the PDF (src/server/anchors.ts) and hands the pages to these functions.
import { toLines, findInText, type PageScan } from './autoplace.ts';

export const ANCHOR_TEXT_MAX = 100;
/** The most fields one request may place by anchors and tags together. */
export const ANCHOR_PLACED_MAX = 500;
/** The most fields one request may give with an "anchor". Refused before any document is read, so one request
 *  cannot keep the server busy for everyone else. */
export const ANCHOR_FIELDS_MAX = 200;
/** How far a field may be moved from its anchor, in points (a point is 1/72 inch). */
export const ANCHOR_OFFSET_MAX = 2000;

export type Anchor = { text: string; occurrence: 'all' | number; offset_x: number; offset_y: number };
/** Where a piece of text is on a page, in points from the top left of the page. */
export type Spot = { x: number; y: number; w: number; h: number };

const num = (v: any, name: string): number => {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n) || Math.abs(n) > ANCHOR_OFFSET_MAX) throw new Error(`"${name}" is a number of points from -${ANCHOR_OFFSET_MAX} to ${ANCHOR_OFFSET_MAX}. Send a plain number, such as 10.`);
  return n;
};

/** Reads the "anchor" of one field. Throws an Error whose message says what is wrong and what to send instead. */
export function readAnchor(raw: any): Anchor {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('"anchor" is an object such as {"text": "Signed:"}. Send it in that form.');
  const text = typeof raw.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new Error('"anchor.text" is empty. Send the words the field should be placed at.');
  if (text.length > ANCHOR_TEXT_MAX) throw new Error(`"anchor.text" is longer than ${ANCHOR_TEXT_MAX} characters. Send a shorter piece of the text.`);
  if (raw.units != null && raw.units !== 'pt') throw new Error('"anchor.units" can only be "pt" (points, 1/72 inch). Send "pt" or leave it out.');
  const o = raw.occurrence;
  let occurrence: Anchor['occurrence'] = 'all';
  if (o != null && o !== 'all') {
    const n = typeof o === 'number' ? o : /^\d+$/.test(String(o)) ? Number(o) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('"anchor.occurrence" is "all" or a whole number from 1, for the first place the text is found. Send one of those.');
    occurrence = n;
  }
  return { text, occurrence, offset_x: num(raw.offset_x, 'anchor.offset_x'), offset_y: num(raw.offset_y, 'anchor.offset_y') };
}

const fold = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

// The lines of a page are worked out once per page, not once per anchor: a request with many anchors over a long
// document would otherwise redo the same work for every one of them.
type Hay = { line: ReturnType<typeof toLines>[number]; hay: string };
const LINES = new WeakMap<PageScan, Hay[]>();
function linesOf(page: PageScan): Hay[] {
  let got = LINES.get(page);
  if (!got) {
    // toLines puts a tab for a wide gap. For finding words it is a space like any other.
    got = toLines(page.items).map((line) => ({ line, hay: line.text.replace(/\t/g, ' ').toLowerCase() }));
    LINES.set(page, got);
  }
  return got;
}

/**
 * Every place on one page where `text` is written, in reading order. Letter case and runs of spaces do not matter.
 * The text has to be on one line: words that wrap onto the next line are not found.
 */
export function findText(page: PageScan, text: string): Spot[] {
  const want = fold(text.trim());
  if (!want) return [];
  const out: Spot[] = [];
  // One character of the line for one character of the folded text: fold() only shortens runs of spaces, so the
  // positions are worked out on the line as it is, with each run of spaces matching any run of spaces.
  const re = new RegExp(want.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
  const first = want.split(' ')[0];
  for (const { line, hay } of linesOf(page)) {
    // A quick look for the first word skips the lines the text cannot be on.
    if (!hay.includes(first)) continue;
    for (const m of hay.matchAll(re)) {
      const a = m.index!, b = a + m[0].length;
      const x0 = line.cx[a], x1 = line.cx[b];
      // From a little above the letters to the baseline: the box a reader would draw around the words.
      out.push({ x: x0, y: line.y - 0.8 * line.h, w: Math.max(0, x1 - x0), h: 0.8 * line.h });
    }
  }
  return out.sort((p, q) => p.y - q.y || p.x - q.x);
}

/** Which of the places found are used: all of them, or the one the anchor names (none when there are fewer). */
export function pick<T>(found: T[], occurrence: Anchor['occurrence']): T[] {
  if (occurrence === 'all') return found;
  return found.length >= occurrence ? [found[occurrence - 1]] : [];
}

/** A field's box as fractions of the page, from its anchor's spot moved by the offsets, kept on the page. */
export function boxAt(spot: Spot, size: { w: number; h: number }, a: Anchor, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const fw = Math.min(1, Math.max(0.005, w)), fh = Math.min(1, Math.max(0.005, h));
  const x = (spot.x + a.offset_x) / size.w, y = (spot.y + a.offset_y) / size.h;
  return { x: Math.min(1 - fw, Math.max(0, x)), y: Math.min(1 - fh, Math.max(0, y)), w: fw, h: fh };
}

/** The {{tags}} on one page, as the editor's "Find fields" finds them (fractions of the page). */
export const tagsOn = (page: PageScan) => findInText(page).filter((f) => f.source === 'tag');
