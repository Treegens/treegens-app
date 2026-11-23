// Right-to-left text for the signed PDF. Arabic, Hebrew and Persian are written right to left, but the digits and
// the Latin words inside them still run left to right: house number 42 must not come out as 24, and "ABC 123" in an
// Arabic sentence must stay "ABC 123". A PDF has no notion of direction, so the order on the page is worked out here
// and the text is drawn piece by piece, left to right.
//
// This is a small version of the Unicode bidirectional algorithm (UAX #9), enough for names, addresses and short
// answers typed into a field: first strong character decides the direction of the whole text, numbers and their
// separators stay together, spaces and punctuation go with what surrounds them, and brackets are mirrored inside
// right-to-left text. Of the explicit direction marks only isolates are understood (FSI, LRI, RLI ... PDI): the
// certificate puts a name or a subject between them so that it is ordered by itself, whatever stands around it.
// Embeddings and overrides are dropped. Bracket pairs are not matched up (rule N0).

export type Run = { text: string; rtl: boolean };

export const FSI = '⁨', PDI = '⁩';
const LRI = '⁦', RLI = '⁧';
/** Puts a name or another piece of someone's own words between isolate marks, so it is ordered on its own. */
export const isolate = (s: string): string => `${FSI}${s}${PDI}`;

const RTL_RANGE = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;
/** True when the text holds any right-to-left letter at all. Text without one needs none of this. */
export const hasRtl = (s: string): boolean => RTL_RANGE.test(s);

type T = 'L' | 'R' | 'EN' | 'AN' | 'ES' | 'ET' | 'CS' | 'WS' | 'ON' | 'NSM';

function classOf(ch: string): T {
  const cp = ch.codePointAt(0)!;
  if (/\p{M}/u.test(ch) || cp === 0x200c || cp === 0x200d) return 'NSM';
  if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x6f0 && cp <= 0x6f9) || (cp >= 0xff10 && cp <= 0xff19)) return 'EN';
  if ((cp >= 0x660 && cp <= 0x669) || cp === 0x66b || cp === 0x66c) return 'AN';
  if (/\s/u.test(ch) && cp !== 0xa0) return 'WS';
  if (ch === '+' || ch === '-') return 'ES';
  if (cp === 0x66a || /[#$%°‰′″]|\p{Sc}/u.test(ch)) return 'ET';
  if (cp === 0x60c || cp === 0xa0 || /[,./:]/.test(ch)) return 'CS';
  if (RTL_RANGE.test(ch)) return 'R';
  if (/[\p{L}\p{N}]/u.test(ch)) return 'L';
  return 'ON';
}

/** The direction a text is read in: that of its first letter. Null when it has no letter (only digits or signs). */
export function firstStrong(s: string): 'rtl' | 'ltr' | null {
  let depth = 0;
  for (const ch of s) {
    if (ch === FSI || ch === LRI || ch === RLI) depth++;
    else if (ch === PDI) depth = Math.max(0, depth - 1);
    else if (!depth) {
      const t = classOf(ch);
      if (t === 'R') return 'rtl';
      if (t === 'L') return 'ltr';
    }
  }
  return null;
}

const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«', '‹': '›', '›': '‹' };

type Item = { ch: string; inner?: { text: string; dir?: 'rtl' | 'ltr' } };

// Cuts the text into characters, with everything between a pair of isolate marks as one item.
function itemsOf(text: string): Item[] {
  const out: Item[] = [];
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === FSI || ch === LRI || ch === RLI) {
      let depth = 1, j = i + 1;
      for (; j < chars.length && depth; j++) {
        if (chars[j] === FSI || chars[j] === LRI || chars[j] === RLI) depth++;
        else if (chars[j] === PDI) depth--;
      }
      // A mark that is never closed (the line was cut in two) takes the rest of the line.
      const inner = chars.slice(i + 1, depth ? j : j - 1).join('');
      out.push({ ch: '￼', inner: { text: inner, dir: ch === LRI ? 'ltr' : ch === RLI ? 'rtl' : undefined } });
      i = j - 1;
    } else if (ch === PDI || /[‎‏‪-‮؜]/.test(ch)) continue; // stray or unsupported marks print nothing
    else out.push({ ch });
  }
  return out;
}

/**
 * The text as pieces in the order they stand on the page from left to right. A piece that is `rtl` keeps its
 * letters in the order they were typed: whoever draws it lays them out from the right. `rtl` on the answer is the
 * direction of the text as a whole, which decides the side it is aligned to.
 */
export function visualRuns(text: string, dir?: 'rtl' | 'ltr'): { rtl: boolean; runs: Run[] } {
  const base: 0 | 1 = (dir ?? firstStrong(text)) === 'rtl' ? 1 : 0;
  if (!hasRtl(text) && !base && !/[⁦-⁩‎‏‪-‮]/.test(text)) return { rtl: false, runs: text ? [{ text, rtl: false }] : [] };
  const items = itemsOf(text);
  const n = items.length;
  const first: T[] = items.map((it) => (it.inner ? 'ON' : classOf(it.ch)));
  const t = [...first];
  const E: T = base ? 'R' : 'L';
  // W1: a mark belongs to the letter it sits on.
  for (let i = 0; i < n; i++) if (t[i] === 'NSM') t[i] = i ? t[i - 1] : 'ON';
  // W4: one separator between two numbers is part of the number (12.5, 1,234).
  for (let i = 1; i < n - 1; i++) {
    if (t[i] === 'ES' && t[i - 1] === 'EN' && t[i + 1] === 'EN') t[i] = 'EN';
    if (t[i] === 'CS' && (t[i - 1] === 'EN' || t[i - 1] === 'AN') && t[i - 1] === t[i + 1]) t[i] = t[i - 1];
  }
  // W5: currency and percent signs next to a number go with it. W6: any other separator is plain punctuation.
  for (let i = 0; i < n; i++) {
    if (t[i] !== 'ET') continue;
    let j = i;
    while (j < n && t[j] === 'ET') j++;
    const withNumber = (i > 0 && t[i - 1] === 'EN') || (j < n && t[j] === 'EN');
    for (let k = i; k < j; k++) t[k] = withNumber ? 'EN' : 'ON';
    i = j - 1;
  }
  for (let i = 0; i < n; i++) if (t[i] === 'ES' || t[i] === 'CS') t[i] = 'ON';
  // W7: a number that follows left-to-right letters is part of them.
  for (let i = 0, strong: T = E; i < n; i++) {
    if (t[i] === 'L' || t[i] === 'R') strong = t[i];
    else if (t[i] === 'EN' && strong === 'L') t[i] = 'L';
  }
  // N1, N2: spaces and punctuation between two pieces of the same direction join them. Otherwise they follow the
  // direction of the whole text. A number counts as right-to-left for this.
  const side = (x: T): T => (x === 'L' ? 'L' : 'R');
  for (let i = 0; i < n; i++) {
    if (t[i] !== 'WS' && t[i] !== 'ON') continue;
    let j = i;
    while (j < n && (t[j] === 'WS' || t[j] === 'ON')) j++;
    const before = i ? side(t[i - 1]) : E, after = j < n ? side(t[j]) : E;
    for (let k = i; k < j; k++) t[k] = before === after ? before : E;
    i = j - 1;
  }
  // I1, I2: how deep each character sits. Even is left to right, odd is right to left.
  const level = t.map((x) => (base ? (x === 'R' ? 1 : 2) : x === 'L' ? 0 : x === 'R' ? 1 : 2));
  // L1: spaces at the end of the line stay at the end of the line.
  for (let i = n - 1; i >= 0 && first[i] === 'WS'; i--) level[i] = base;
  // Pieces of one level, with an isolated part always a piece of its own.
  type Piece = { level: number; text: string; inner?: Item['inner'] };
  const pieces: Piece[] = [];
  for (let i = 0; i < n; i++) {
    const it = items[i], last = pieces[pieces.length - 1];
    if (it.inner) pieces.push({ level: level[i], text: '', inner: it.inner });
    else {
      const ch = level[i] % 2 && MIRROR[it.ch] ? MIRROR[it.ch] : it.ch;
      if (last && !last.inner && last.level === level[i]) last.text += ch;
      else pieces.push({ level: level[i], text: ch });
    }
  }
  // L2: from the deepest level up, turn round every stretch of pieces that sit at least that deep.
  const top = Math.max(0, ...pieces.map((p) => p.level));
  for (let l = top; l >= 1; l--) {
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i].level < l) continue;
      let j = i;
      while (j < pieces.length && pieces[j].level >= l) j++;
      pieces.splice(i, j - i, ...pieces.slice(i, j).reverse());
      i = j - 1;
    }
  }
  const runs: Run[] = [];
  for (const p of pieces) {
    if (p.inner) runs.push(...visualRuns(p.inner.text, p.inner.dir).runs);
    else if (p.text) runs.push({ text: p.text, rtl: p.level % 2 === 1 });
  }
  return { rtl: base === 1, runs };
}
