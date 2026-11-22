// Easy reading on the signing page: the words of one page of a PDF, put back together as something that reads like a
// web page on a small phone. Paragraphs (lines joined across small gaps), headings (larger type, or a short line in a
// type of its own), lists (lines that start with a bullet or a number), simple tables (said row by row), and two
// columns read left column first. It is a reading aid: what is signed is always the pages themselves.
//
// No React and no pdf.js here, so the rules can be tested with plain numbers (tests/ds-reading-view.test.ts).
// src/components/sign/pdfText.ts feeds it the text of each page as pdf.js reads it.

/** One run of text as pdf.js gives it, in the page's own picture coordinates: x from the left, y of the baseline from the top, h the size of the type. */
export type RItem = { str: string; x: number; y: number; w: number; h: number; font?: string; eol?: boolean };

/** A part of the page, in reading order. Positions are fractions of the page (0 to 1, from the top left). */
export type RBlock = {
  kind: 'heading' | 'para' | 'list' | 'table';
  /** heading and para: the words. A line break stands where a short line ended (an address, a signature block). */
  text?: string;
  /** list: one entry per item, with its bullet or number. */
  items?: string[];
  /** table: each row as its cells. */
  rows?: string[][];
  top: number;
  bottom: number;
  /** 0: across the page, 1: left column, 2: right column. */
  col: 0 | 1 | 2;
  /** Which band of the page it is in (see RPage.bands), so fields can be put in the same reading order. */
  band: number;
};

/** A band of the page from top to bottom: across the whole width, or two columns with the gutter at `gutter`. */
export type RBand = { top: number; bottom: number; gutter: number | null };
export type RPage = { blocks: RBlock[]; bands: RBand[] };

type Seg = { x0: number; x1: number; y: number; h: number; text: string; font: string };
type Line = { y: number; h: number; segs: Seg[] };
type RLine = { x0: number; x1: number; y: number; h: number; text: string; font: string; col: 0 | 1 | 2; band: number; width: number };

const BULLET = /^(?:[•●○◦▪■□‣⁃·∙✓✔➢►*]|[-–—](?=\s)|\(?(?:\d{1,3}(?:\.\d{1,3})*|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)])\s*(?=\S)/;

/** The runs of one page grouped into printed lines, and each line cut into pieces wherever a wide gap stands. */
function linesOf(items: RItem[]): Line[] {
  const runs = items.filter((i) => typeof i.str === 'string' && i.str.trim()).map((i) => ({ ...i, h: i.h || 10 }));
  runs.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  const rows: (typeof runs)[] = [];
  for (const r of runs) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(r.y - row[0].y) <= Math.max(r.h, row[0].h) * 0.5) row.push(r);
    else rows.push([r]);
  }
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const segs: Seg[] = [];
    let cur: Seg | null = null;
    const fontChars = new Map<string, Map<string, number>>();
    for (const r of row) {
      const gap = cur ? r.x - cur.x1 : 0;
      if (!cur || gap > Math.max(r.h, cur.h) * 1.5) {
        cur = { x0: r.x, x1: r.x + r.w, y: r.y, h: r.h, text: r.str, font: '' };
        segs.push(cur);
        fontChars.set(String(segs.length - 1), new Map());
      } else {
        if (gap > r.h * 0.2 && !/\s$/.test(cur.text) && !/^\s/.test(r.str)) cur.text += ' ';
        cur.text += r.str;
        cur.x1 = Math.max(cur.x1, r.x + r.w);
        cur.h = Math.max(cur.h, r.h);
      }
      const fc = fontChars.get(String(segs.length - 1))!;
      fc.set(r.font || '', (fc.get(r.font || '') || 0) + r.str.length);
    }
    segs.forEach((s, i) => {
      s.text = s.text.replace(/\s+/g, ' ').replace(/_{4,}/g, '____').replace(/\.{6,}/g, '.....').trim();
      s.font = [...fontChars.get(String(i))!.entries()].sort((a, b) => b[1] - a[1])[0][0];
    });
    const kept = segs.filter((s) => s.text);
    if (kept.length) lines.push({ y: row[0].y, h: Math.max(...kept.map((s) => s.h)), segs: kept });
  }
  return lines;
}

/** Where two columns of text stand side by side: the gutter between them, or null for a page read straight down. */
function findGutter(lines: Line[], W: number): number | null {
  const segs = lines.flatMap((l) => l.segs);
  if (segs.length < 6) return null;
  let best: { x: number; score: number } | null = null;
  for (let x = W * 0.3; x <= W * 0.7; x += W * 0.01) {
    const left = segs.filter((s) => s.x1 <= x);
    const right = segs.filter((s) => s.x0 >= x);
    const across = segs.length - left.length - right.length;
    // Lines of real columns are wide; the cells of a form or a table are short.
    const wide = (ss: Seg[]) => ss.length >= 3 && median(ss.map((s) => s.x1 - s.x0)) >= W * 0.22;
    // And the two columns stand side by side: some line on the left shares its height with one on the right.
    const sideBySide = lines.filter((l) => l.segs.some((s) => s.x1 <= x) && l.segs.some((s) => s.x0 >= x)).length;
    if (!wide(left) || !wide(right) || sideBySide < 2 || across > segs.length * 0.25) continue;
    const score = Math.min(left.length, right.length) - across * 2;
    if (!best || score > best.score) best = { x, score };
  }
  return best ? best.x : null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Rows of a table: two or more lines in a row, each cut into the same number of cells that start at the same places. */
function tableRuns(lines: Line[], W: number, gutter: number | null): Set<number>[] {
  const runs: Set<number>[] = [];
  let run: number[] = [];
  const fits = (a: Line, b: Line) =>
    a.segs.length === b.segs.length && a.segs.every((s, k) => Math.abs(s.x0 - b.segs[k].x0) < Math.max(W * 0.03, s.h * 2)) && b.y - a.y < Math.max(a.h, b.h) * 3;
  const cells = (l: Line) => l.segs.length >= 2 && !(gutter != null && l.segs.length === 2 && l.segs[0].x1 <= gutter && l.segs[1].x0 >= gutter);
  const close = () => {
    if (run.length >= 2) runs.push(new Set(run));
    run = [];
  };
  lines.forEach((l, i) => {
    if (!cells(l)) return close();
    if (run.length && !fits(lines[run[run.length - 1]], l)) close();
    run.push(i);
  });
  close();
  return runs;
}

/**
 * The page in reading order. `W` and `H` are the size of the page in the same units as the runs.
 */
export function reflowPage(items: RItem[], W: number, H: number): RPage {
  const lines = linesOf(items);
  if (!lines.length) return { blocks: [], bands: [] };
  const gutter = findGutter(lines, W);
  const tables = tableRuns(lines, W, gutter);
  const inTable = (i: number) => tables.find((t) => t.has(i));

  // Bands: a line that runs across the gutter (a title, say) is a band of its own; the lines between such lines are
  // a band in two columns. Each band is read in turn, and in a band of two columns the left one comes first.
  type Unit = { line?: Line; table?: Line[]; top: number };
  const bands: { gutter: number | null; units: Unit[]; top: number; bottom: number }[] = [];
  const crosses = (l: Line) => gutter == null || l.segs.some((s) => s.x0 < gutter && s.x1 > gutter);
  const done = new Set<number>();
  lines.forEach((l, i) => {
    if (done.has(i)) return;
    const t = inTable(i);
    const unit: Unit = t ? { table: [...t].map((k) => lines[k]), top: l.y - l.h } : { line: l, top: l.y - l.h };
    if (t) t.forEach((k) => done.add(k));
    const end = t ? lines[Math.max(...t)] : l;
    const two = !t && !crosses(l);
    const last = bands[bands.length - 1];
    if (last && (last.gutter != null) === two) last.units.push(unit), (last.bottom = end.y);
    else bands.push({ gutter: two ? gutter : null, units: [unit], top: l.y - l.h, bottom: end.y });
  });

  const rlines: (RLine | { table: Line[]; band: number; col: 0 | 1 | 2 })[] = [];
  bands.forEach((b, bi) => {
    const flat = (l: Line, col: 0 | 1 | 2, segs = l.segs): RLine => ({
      x0: segs[0].x0, x1: segs[segs.length - 1].x1, y: l.y, h: l.h, col, band: bi,
      // A form line such as "Name: ____    Date: ____" keeps its parts apart with a wide space.
      text: segs.map((s) => s.text).join('   '),
      font: segs.map((s) => s.font).sort((a, c) => segs.filter((s) => s.font === c).length - segs.filter((s) => s.font === a).length)[0],
      width: b.gutter == null ? W : b.gutter,
    });
    if (b.gutter == null) {
      for (const u of b.units) u.table ? rlines.push({ table: u.table, band: bi, col: 0 }) : rlines.push(flat(u.line!, 0));
      return;
    }
    const g = b.gutter;
    for (const side of [1, 2] as const)
      for (const u of b.units) {
        const segs = u.line!.segs.filter((s) => (side === 1 ? s.x1 <= g : s.x0 >= g));
        if (segs.length) rlines.push({ ...flat(u.line!, side, segs), width: side === 1 ? g : W - g });
      }
  });

  // The size and the type of ordinary text: whichever carries the most letters.
  const weight = new Map<number, number>();
  const fonts = new Map<string, number>();
  for (const l of rlines) if ('text' in l) {
    weight.set(Math.round(l.h), (weight.get(Math.round(l.h)) || 0) + l.text.length);
    fonts.set(l.font, (fonts.get(l.font) || 0) + l.text.length);
  }
  const body = weight.size ? [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0] : 10;
  const bodyFont = fonts.size ? [...fonts.entries()].sort((a, b) => b[1] - a[1])[0][0] : '';
  const isHeading = (l: RLine) =>
    l.text.length < 140 && (l.h >= body * 1.2 || (fonts.size > 1 && l.font !== bodyFont && l.text.length <= 90 && !/[.,;]$/.test(l.text) && !/_{3,}/.test(l.text)));

  // How wide the widest line of each column of each band is: a line nearly that wide was wrapped.
  const widest = new Map<string, number>();
  for (const l of rlines) if ('text' in l) widest.set(`${l.band}:${l.col}`, Math.max(widest.get(`${l.band}:${l.col}`) || 0, l.x1 - l.x0));

  const out: RBlock[] = [];
  let prev: RLine | null = null;
  let item: { x0: number } | null = null;
  const f = (v: number) => Math.min(1, Math.max(0, v / H));
  for (const l of rlines) {
    if (!('text' in l)) {
      const rows = l.table.map((r) => r.segs.map((s) => s.text));
      const first = l.table[0], last = l.table[l.table.length - 1];
      out.push({ kind: 'table', rows, top: f(first.y - first.h), bottom: f(last.y), col: l.col, band: l.band });
      prev = null;
      item = null;
      continue;
    }
    const last = out[out.length - 1];
    const gap = prev ? l.y - prev.y : Infinity;
    const near = !!prev && prev.col === l.col && prev.band === l.band && gap > 0 && gap < Math.max(prev.h, l.h) * 1.75;
    const heading = isHeading(l);
    const bullet = BULLET.test(l.text) && !heading;
    if (heading) {
      // Two heading lines are one heading only when the second carries on the first: the same size and type, and the
      // first ran most of the way across its column (it was wrapped). A title with a section heading under it stays two.
      const goesOn = near && last?.kind === 'heading' && Math.round(prev!.h) === Math.round(l.h) && prev!.font === l.font
        && prev!.x1 - prev!.x0 > (widest.get(`${prev!.band}:${prev!.col}`) || prev!.width) * 0.6;
      if (goesOn) last.text += ` ${l.text}`, (last.bottom = f(l.y));
      else out.push({ kind: 'heading', text: l.text, top: f(l.y - l.h), bottom: f(l.y), col: l.col, band: l.band });
      item = null;
    } else if (bullet) {
      if (near && last?.kind === 'list') last.items!.push(l.text), (last.bottom = f(l.y));
      else out.push({ kind: 'list', items: [l.text], top: f(l.y - l.h), bottom: f(l.y), col: l.col, band: l.band });
      item = { x0: l.x0 };
    } else if (near && last?.kind === 'list' && item && l.x0 > item.x0 + l.h * 0.5) {
      // The second line of a list item, indented under its words.
      const items = last.items!;
      items[items.length - 1] = joinLines(items[items.length - 1], l.text, ' ');
      last.bottom = f(l.y);
    } else if (near && last?.kind === 'para') {
      // A line that ran to the edge of its column was wrapped, so the next one carries on the sentence. A short line
      // ended on purpose (an address, a name under a signature line): the break stays.
      const wrapped = prev!.x1 - prev!.x0 > (widest.get(`${prev!.band}:${prev!.col}`) || prev!.width) * 0.8;
      last.text = joinLines(last.text!, l.text, wrapped ? ' ' : '\n');
      last.bottom = f(l.y);
    } else {
      out.push({ kind: 'para', text: l.text, top: f(l.y - l.h), bottom: f(l.y), col: l.col, band: l.band });
      item = null;
    }
    prev = l;
  }
  return { blocks: out, bands: bands.map((b) => ({ top: f(b.top), bottom: f(b.bottom), gutter: b.gutter == null ? null : b.gutter / W })) };
}

function joinLines(a: string, b: string, sep: ' ' | '\n'): string {
  // "agree-" at the end of a line and "ment" on the next is one word.
  if (sep === ' ' && /[a-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  return a + sep + b;
}

/** A field on the page, in fractions from the top left (as fields are stored). */
export type RField = { id: string; x: number; y: number; w: number; h: number };

/** Where a spot of the page falls in reading order: its band, its column, and how far down. */
function placeOf(page: RPage, x: number, y: number): [number, number, number] {
  let band = page.bands.findIndex((b) => y <= b.bottom + 0.005);
  if (band < 0) band = page.bands.length - 1;
  const b = page.bands[band];
  if (y < b.top - 0.005 && band > 0) {
    // Between two bands, nearer the end of the band above: it is read with that one.
    const above = page.bands[band - 1];
    if (y - above.bottom < b.top - y) band -= 1;
  }
  const g = page.bands[band]?.gutter;
  return [band, g == null ? 0 : x < g ? 1 : 2, y];
}

const before = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Each field of the page next to the part of the text it sits in: `after[i]` are the fields read after block i, and
 * `start` those that come before any text. The order inside a group is the order the fields are given in.
 */
export function placeFields<F extends RField>(page: RPage, fields: F[]): { start: F[]; after: F[][] } {
  const after = page.blocks.map(() => [] as F[]);
  const start: F[] = [];
  if (!page.blocks.length) return { start: [...fields], after };
  const keys = page.blocks.map((b) => [b.band, b.col, b.top] as [number, number, number]);
  for (const fl of fields) {
    // A field is read where its middle is, so a blank inside a sentence goes with that sentence.
    const k = placeOf(page, fl.x + fl.w / 2, fl.y + fl.h / 2);
    let at = -1;
    keys.forEach((b, i) => {
      if (before(b, k) <= 0) at = i;
    });
    (at < 0 ? start : after[at]).push(fl);
  }
  return { start, after };
}

/** A part of a page from one heading to the next. The part before the first heading has no heading. */
export type RSection = { heading: RBlock | null; blocks: RBlock[]; first: number; top: number; chars: number };

export function sectionsOf(page: RPage): RSection[] {
  const out: RSection[] = [];
  page.blocks.forEach((b, i) => {
    if (b.kind === 'heading' || !out.length) out.push({ heading: b.kind === 'heading' ? b : null, blocks: [], first: i, top: b.top, chars: 0 });
    const s = out[out.length - 1];
    if (b.kind !== 'heading') {
      s.blocks.push(b);
      s.chars += (b.text || '').length + (b.items || []).join(' ').length + (b.rows || []).flat().join(' ').length;
    }
  });
  return out;
}

/** A section this long can be folded away (Easy reading only). Nothing is ever folded when the page opens. */
export const FOLD_FROM = 1500;

/** The plain text of a block, for a screen reader or a search: what Easy reading shows, in the same order. */
export function blockText(b: RBlock): string {
  if (b.kind === 'list') return (b.items || []).join('\n');
  if (b.kind === 'table') return (b.rows || []).map((r) => r.join(' | ')).join('\n');
  return b.text || '';
}
