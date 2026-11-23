// Finds the places in a document where a field belongs, so nobody has to drag every one by hand:
//   1. form fields that are already in the PDF,
//   2. labels followed by a blank on the same line ("Signature: ______"),
//   3. explicit tags in the text ({{signature}}, {{text:Some label}}, {{signature2}} for the second signer),
//   4. a signature table: labels down the left ("Signature", "Date"), one column per person, empty cells to fill,
//   5. a bare label with empty space next to it ("Signature:" at the end of a contract, or under a drawn line).
// Everything here works on plain data (text runs with positions, a page size) so it runs the same in the browser
// and in tests. Input positions are in page units with the origin at the top left. Results are fractions of the
// page, like every other field in the editor. Only scanPdf() at the bottom touches a pdf.js document.

export type PageSize = { w: number; h: number };
/** A run of text. x is its left edge, y its baseline measured from the top of the page, w its width, h the font size. */
export type TextItem = { str: string; x: number; y: number; w: number; h: number; mono?: boolean };
/** A form field that is already part of the PDF. x and y are the top left corner. */
export type Widget = { kind: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'signature'; x: number; y: number; w: number; h: number; name?: string; options?: string[]; required?: boolean };
export type Box = { x: number; y: number; w: number; h: number };
/** A straight line drawn on the page, such as the border of a table cell or the line someone signs on. Thin one way. */
export type Rule = Box;
export type PageScan = { size: PageSize; items: TextItem[]; widgets?: Widget[]; rules?: Rule[] };
export type Found = Box & {
  type: string;
  page: number;
  source: 'form' | 'tag' | 'label';
  label?: string;
  /** 1 for the first signer, 2 for the second. Set by numbered tags such as {{signature2}}, and by the column of a
   *  signature table or the place of a signature block when there is one per person. */
  signer?: number;
  /** Words printed next to the place that may name who it is for: the heading of its table column, the heading over
   *  its signature block, a name printed under the line. assignSigners() matches them to the people on the document. */
  who?: string[];
  group?: string;
  options?: string[];
  required?: boolean;
};

// ---- Where a character sits inside a run of text -------------------------------------------------------------

// Helvetica advance widths for printable ASCII (codes 32 to 126), in thousandths of the font size. pdf.js gives the
// width of a whole run but not of each character, so these spread that width over the characters. Any proportional
// font is close enough: what matters is that "i" is narrow, "m" is wide and "_" is in between.
const ADVANCE = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const advance = (ch: string, mono?: boolean) => (mono ? 600 : ADVANCE[ch.charCodeAt(0) - 32] ?? 556);

type Line = {
  y: number; // baseline
  h: number; // font size
  text: string;
  cx: number[]; // x at the start of every character, plus one entry for the end of the line
};

const WIDE_GAP = '\t';

/** Groups runs of text that share a baseline into lines, and works out where each character starts.
 *  `wide` is how big a gap counts as a wide one, in font sizes. `cut` can force a wide gap, for a table border. */
export function toLines(items: TextItem[], wide = 1, cut?: (from: number, to: number, y: number, h: number) => boolean): Line[] {
  const rows: TextItem[][] = [];
  for (const it of [...items].filter((i) => i.str && i.str.trim() && i.w > 0 && i.h > 0).sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r[0].y - it.y) <= 0.35 * Math.min(r[0].h, it.h));
    if (row) row.push(it);
    else rows.push([it]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    const h = Math.max(...row.map((i) => i.h));
    let text = '';
    const cx: number[] = [];
    let end = row[0].x;
    for (const it of row) {
      const gap = it.x - end;
      const forced = !!text && !!cut && cut(end, it.x, it.y - 0.35 * it.h, h);
      if (text && (gap > 0.12 * h || forced)) {
        text += gap >= wide * h || forced ? WIDE_GAP : ' ';
        cx.push(end);
      }
      const total = [...it.str].reduce((n, ch) => n + advance(ch, it.mono), 0) || 1;
      let x = it.x;
      for (const ch of it.str) {
        // One entry per UTF-16 unit keeps cx in step with string indexes used by the regular expressions below.
        for (let k = 0; k < ch.length; k++) cx.push(x);
        text += ch;
        x += (it.w * advance(ch, it.mono)) / total;
      }
      end = Math.max(end, it.x + it.w);
    }
    cx.push(end);
    return { y: row[0].y, h, text, cx };
  });
}

// ---- Labels and tags -----------------------------------------------------------------------------------------

// Default sizes as a fraction of the page width. Heights come from the text size on the line.
const WIDTH: Record<string, number> = { signature: 0.22, initials: 0.08, date_signed: 0.14, full_name: 0.2, email: 0.24, company: 0.2, title: 0.2, text: 0.22 };
// How tall a field is, in multiples of the font size on its line.
const TALL: Record<string, number> = { signature: 2.6, initials: 1.9 };

/** Which field a label asks for, or null if it is not a label we know. `label` is the text in front of a blank. */
export function fieldForLabel(label: string): string | null {
  // "1.", "(a)", "•" and the like in front of a label do not change what it asks for.
  const s = label.replace(/[:\s]+$/, '').replace(/^\s*(?:\(?[0-9a-z]{1,2}[.)]|[•\-*·])\s+/i, '').trim().toLowerCase();
  if (!s || s.length > 60) return null;
  if (/\b(signature|sign here|signed by|signed)\b/.test(s) && !/\bdate\b/.test(s)) return 'signature';
  if (/^initials?$/.test(s)) return 'initials';
  if (/^(date|date signed|date of signing|date of signature|dated)$/.test(s)) return 'date_signed';
  if (/^((full|print|printed|your|legal) )?name$/.test(s)) return 'full_name';
  if (/^(job )?title$|^position$/.test(s)) return 'title';
  if (/^company( name)?$|^organi[sz]ation$/.test(s)) return 'company';
  if (/^e-?mail( address)?$/.test(s)) return 'email';
  return standaloneLabel(s);
}

/** Which field a label that stands alone asks for: the whole of a short line or of a table cell, with nothing after
 *  it. Stricter than fieldForLabel(): "Signature page" and "Date of this agreement" are not labels. */
export function standaloneLabel(text: string): string | null {
  const s = text.replace(/\s+/g, ' ').replace(/^\s*(?:\(?[0-9a-z]{1,2}[.)]|[•\-*·])\s+/i, '').replace(/\s*[:：]\s*$/, '').trim().toLowerCase();
  if (!s || s.length > 40) return null;
  if (/^((authori[sz]ed|your) )?(signature|signatory)$|^sign( here)?$|^signed( by)?$|^by$/.test(s)) return 'signature';
  if (/^initials?$/.test(s)) return 'initials';
  if (/^(date|date signed|date of signing|date of signature|signing date|dated)$/.test(s)) return 'date_signed';
  if (/^((full|print|printed|your|legal) )?name$|^name \(print(ed)?\)$|^name in (block )?capitals$/.test(s)) return 'full_name';
  if (/^(job )?title$|^position$|^title ?\/ ?position$/.test(s)) return 'title';
  if (/^company( name)?$|^organi[sz]ation$/.test(s)) return 'company';
  if (/^e-?mail( address)?( for notices)?$/.test(s)) return 'email';
  return null;
}

// Exported for documents written in the app (src/lib/writedoc.ts), which use the same tags.
export const TAG = /\{\{\s*(signature|initials|date|name|email|title|company|checkbox|text)\s*(\d{1,2})?\s*(?::\s*([^{}]*?))?\s*\}\}/gi;
export const TAG_TYPE: Record<string, string> = { signature: 'signature', initials: 'initials', date: 'date_signed', name: 'full_name', email: 'email', title: 'title', company: 'company', checkbox: 'checkbox', text: 'text' };
// A blank drawn with characters: underscores, a dotted leader, or a run of ellipses.
const BLANK = /_{3,}|\.{5,}|…{2,}/g;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// What the finder keeps about a place while it works. `rank` says which find wins when two want the same spot:
// 1 a tag, 2 a blank drawn after a label, 3 a cell of a signature table, 4 a label that ends in a colon, 5 a bare label.
type Raw = Omit<Found, 'page'> & { rank: number; row?: number; lx?: number };
/** A piece of a line that stands apart: a table cell, or a label with space after it. */
type Cell = { x0: number; x1: number; y: number; h: number; text: string };
type Area = { x0: number; x1: number; top: number; bottom: number };

/** Finds labels with blanks, {{tags}}, signature tables and bare labels on one page. */
export function findInText(page: PageScan): Omit<Found, 'page'>[] {
  const { w: PW, h: PH } = page.size;
  const lines = toLines(page.items);
  const out: Raw[] = [];

  // A field sits on the line like handwriting would: its bottom edge just under the baseline. Tall fields
  // (signatures) grow upwards, but stop short of the text on the line above.
  const box = (line: Line, type: string, x0: number, x1: number): Box => {
    const bottom = line.y + 0.22 * line.h;
    const wanted = type === 'checkbox' ? 1.15 * line.h : Math.max((TALL[type] || 1.5) * line.h, (TALL[type] ? 0.036 : 0.02) * PH);
    let top = bottom - Math.min(wanted, (TALL[type] ? 0.07 : 0.035) * PH);
    for (const other of lines) {
      if (other === line || other.y >= line.y - 0.5 * line.h) continue;
      if (other.cx[other.cx.length - 1] < x0 || other.cx[0] > x1) continue;
      top = Math.max(top, other.y + 0.25 * other.h);
    }
    top = Math.min(top, bottom - (type === 'checkbox' ? 1.15 : 1.25) * line.h);
    const x = clamp(x0, 0, PW);
    const w = clamp(x1 - x0, 0.012 * PW, PW - x);
    const y = clamp(top, 0, PH);
    return { x: x / PW, y: y / PH, w: w / PW, h: clamp(bottom - y, 0.008 * PH, PH - y) / PH };
  };
  // Where the next piece of text starts after position i, or the right margin if the rest of the line is empty.
  const roomUntil = (line: Line, i: number) => {
    const rest = line.text.slice(i).search(/\S/);
    return rest < 0 ? PW * 0.94 : line.cx[i + rest] - 0.4 * line.h;
  };

  lines.forEach((line, row) => {
    // Stretches of the line that are already spoken for, as [start, end) character indexes.
    const used: [number, number][] = [];

    for (const m of line.text.matchAll(TAG)) {
      const start = m.index!, end = start + m[0].length;
      used.push([start, end]);
      const type = TAG_TYPE[m[1].toLowerCase()];
      const x0 = line.cx[start], tagEnd = line.cx[end];
      const x1 = type === 'checkbox' ? x0 + 1.15 * line.h : Math.max(tagEnd, Math.min(x0 + (WIDTH[type] || 0.2) * PW, roomUntil(line, end)));
      out.push({ ...box(line, type, x0, x1), type, source: 'tag', rank: 1, ...(m[2] ? { signer: Number(m[2]) } : {}), ...(m[3]?.trim() ? { label: m[3].trim().slice(0, 120) } : {}) });
    }

    // Blanks drawn as characters, and blanks that are only implied by a colon with nothing after it.
    const blanks: { start: number; end: number; drawn: boolean }[] = [];
    for (const m of line.text.matchAll(BLANK)) {
      // "Signature ............ 12" is a line of a table of contents, not a place to sign.
      if (m[0][0] !== '_' && /^\s*\d{1,4}\s*$/.test(line.text.slice(m.index! + m[0].length))) continue;
      blanks.push({ start: m.index!, end: m.index! + m[0].length, drawn: true });
    }
    for (const m of line.text.matchAll(/:(?=[ \t]*$|[ \t]*\t|\s{3,})/g)) {
      const at = m.index! + 1;
      // Skip a colon that is directly followed by a drawn blank: that blank is already in the list.
      if (/^\s*(_{3,}|\.{5,}|…{2,})/.test(line.text.slice(at))) continue;
      blanks.push({ start: at, end: at, drawn: false });
    }
    blanks.sort((a, b) => a.start - b.start);

    const spots: { type: string; label: string; lx: number; b: (typeof blanks)[number] }[] = [];
    blanks.forEach((b, i) => {
      if (used.some(([s, e]) => b.start < e && b.end > s)) return;
      // The label is whatever sits between this blank and the previous blank, tag or wide gap.
      let from = 0;
      for (const p of blanks.slice(0, i)) from = Math.max(from, p.end);
      for (const [, e] of used) if (e <= b.start) from = Math.max(from, e);
      const before = line.text.slice(from, b.start);
      const gap = [...before.matchAll(/\t|\s{3,}/g)].filter((g) => before.slice(g.index! + g[0].length).trim()).pop();
      const tail = gap ? before.slice(gap.index! + gap[0].length) : before;
      const label = tail.trim();
      const type = fieldForLabel(label);
      if (type) spots.push({ type, label, b, lx: line.cx[b.start - tail.trimStart().length] });
    });

    for (const { type, label, b, lx } of spots) {
      if (b.drawn) {
        out.push({ ...box(line, type, line.cx[b.start], line.cx[b.end]), type, source: 'label', rank: 2, row, lx });
        continue;
      }
      // "Name:" with nothing drawn after it. Only trust a short label at the end of a line, or one followed by
      // another label we recognise ("Name:      Title:"). "Date: 5 March" must not get a field on top of the
      // date, and a sentence that happens to end in a colon is not a signature line.
      if (label.split(/\s+/).length > 6) continue;
      if (line.text.slice(b.start).trim()) {
        const next = spots.find((s) => s.b.start > b.start);
        if (!next || !fieldForLabel(line.text.slice(b.start, next.b.start))) continue;
      }
      const x0 = line.cx[b.start] + 0.4 * line.h;
      const x1 = Math.min(x0 + (WIDTH[type] || 0.2) * PW, roomUntil(line, b.start));
      if (x1 - x0 < 0.05 * PW) continue;
      out.push({ ...box(line, type, x0, x1), type, source: 'label', rank: 4, row, lx });
    }
  });

  // ---- Labels with empty space: signature tables and bare labels ------------------------------------------------

  const items = page.items.filter((i) => i.str && i.str.trim() && i.w > 0 && i.h > 0);
  const rules = page.rules || [];
  const across = rules.filter((r) => r.w >= r.h && r.w >= 6).map((r) => ({ y: r.y + r.h / 2, x0: r.x, x1: r.x + r.w }));
  const down = rules.filter((r) => r.h > r.w && r.h >= 6).map((r) => ({ x: r.x + r.w / 2, y0: r.y, y1: r.y + r.h }));
  // The same lines again, cut into cells: at a gap a little under one font size, at every border of a table, and
  // where text starts exactly under the start of a cell on another row (a column with very little padding).
  const border = (from: number, to: number, y: number) => down.some((v) => v.x > from - 1 && v.x < to + 1 && v.y0 - 1 <= y && v.y1 + 1 >= y);
  const split = (line: Line): Cell[] => {
    const got: Cell[] = [];
    for (const m of line.text.matchAll(/[^\t ](?:[^\t]*?[^\t ])??(?=\t| {3,}|[ \t]*$)/g))
      got.push({ x0: line.cx[m.index!], x1: line.cx[m.index! + m[0].length], y: line.y, h: line.h, text: m[0].replace(/\s+/g, ' ') });
    return got;
  };
  const starts = toLines(page.items, 0.75, border).flatMap((line) => split(line).map((c) => c.x0));
  const cells: Cell[][] = toLines(page.items, 0.75, (from, to, y, h) => border(from, to, y) || (to - from >= 0.3 * h && starts.some((x) => Math.abs(x - to) <= 1))).map(split);
  const Y = (r: number) => lines[r].y;
  const fontSizes = items.map((i) => i.h).sort((a, b) => a - b);
  const bodySize = fontSizes[fontSizes.length >> 1] || 12;
  // Where lines of text end on this page: as far as the longest one, or the left margin mirrored when all are short.
  const rightEdge = Math.min(PW * 0.96, Math.max(PW * 0.6, ...items.map((i) => i.x + i.w), PW - Math.min(PW * 0.2, ...items.map((i) => i.x))));

  /** True when no text sits inside this part of the page. */
  const free = (a: Area) => !items.some((i) => i.x + 0.5 < a.x1 && i.x + i.w - 0.5 > a.x0 && i.y - 0.8 * i.h < a.bottom && i.y + 0.1 * i.h > a.top);
  /** The table cell around a point, when lines are drawn on all four sides of it. */
  const ruledCell = (px: number, py: number): Area | null => {
    if (!down.length || !across.length) return null;
    let l = -Infinity, r = Infinity, t = -Infinity, b = Infinity;
    for (const v of down) if (v.y0 - 1.5 <= py && v.y1 + 1.5 >= py) v.x <= px ? (l = Math.max(l, v.x)) : (r = Math.min(r, v.x));
    for (const a of across) if (a.x0 - 1.5 <= px && a.x1 + 1.5 >= px) a.y <= py ? (t = Math.max(t, a.y)) : (b = Math.min(b, a.y));
    if (![l, r, t, b].every(Number.isFinite)) return null;
    if (r - l < 0.03 * PW || r - l > 0.9 * PW || b - t < 6 || b - t > 0.3 * PH) return null;
    return { x0: l, x1: r, top: t, bottom: b };
  };
  /** A field of this kind inside a cell, or null when the cell is too small for it. `base` is the label's baseline. */
  const inCell = (type: string, c: Area, base: number, h: number): Box | null => {
    const padX = Math.min(3, 0.06 * (c.x1 - c.x0)), padY = Math.min(2, 0.1 * (c.bottom - c.top));
    const iw = c.x1 - c.x0 - 2 * padX, ih = c.bottom - c.top - 2 * padY;
    if (iw < 0.05 * PW || ih < 0.85 * h) return null;
    const w = Math.min(iw, (WIDTH[type] || 0.2) * PW);
    const fh = Math.min(ih, TALL[type] ? 0.06 * PH : 1.5 * h);
    // A signature takes the middle of its cell. One line of writing sits on the label's own line.
    const y = TALL[type] ? c.top + padY + (ih - fh) / 2 : clamp(base + 0.3 * h - fh, c.top + padY, c.bottom - padY - fh);
    return { x: (c.x0 + padX) / PW, y: y / PH, w: w / PW, h: fh / PH };
  };
  const toArea = (b: Box): Area => ({ x0: b.x * PW + 1, x1: (b.x + b.w) * PW - 1, top: b.y * PH + 1, bottom: (b.y + b.h) * PH - 1 });

  // A signature table: a header row with one cell per person, and under it rows that start with a label.
  //            | James Cohen | Marc Diamond |
  //  Signature |             |              |
  //  Date      |             |              |
  // Every empty cell on a label's row gets that label's field. A cell with text in it is left alone.
  const inTable = new Set<number>();
  for (let r = 0; r < cells.length; r++) {
    const lab = cells[r][0];
    if (!lab || inTable.has(r) || !standaloneLabel(lab.text)) continue;
    const h = lab.h;
    const colMin = lab.x1 + 0.5 * h;
    // Upwards to the header: the highest row close by that has cells to the right of the label column.
    let hdr = -1;
    for (let u = r - 1, prev = r; u >= 0; prev = u, u--) {
      if (Y(prev) - Y(u) > 3.6 * h) break;
      const left = cells[u].filter((c) => c.x0 < colMin), right = cells[u].filter((c) => c.x0 >= colMin);
      if (left.length > 1 || (left.length && Math.abs(left[0].x0 - lab.x0) > 1.5 * h)) break;
      if (right.length) hdr = u;
      else if (!left.length || !standaloneLabel(left[0].text)) break;
    }
    if (hdr < 0) continue;
    const cols = cells[hdr].filter((c) => c.x0 >= colMin);
    if (cols.length > 8 || cols.every((c) => standaloneLabel(c.text))) continue;

    // Downwards: the rows of the table. A row with nothing in the label column carries on the row above it.
    const edge = cols[0].x0 - 0.3 * h;
    const bands: { row: number; last: number }[] = [];
    let end = hdr;
    for (let s = hdr + 1; s < cells.length; end = s, s++) {
      if (Y(s) - Y(end) > Math.max(5 * h, 0.075 * PH)) break;
      const left = cells[s].filter((c) => c.x0 < edge);
      if (left.length > 1 || (left.length && (Math.abs(left[0].x0 - lab.x0) > 1.5 * h || left[0].x1 > cols[0].x0))) break;
      if (left.length) bands.push({ row: s, last: s });
      else if (bands.length) bands[bands.length - 1].last = s;
    }
    const top = (k: number) => Y(bands[k].row) - 1.25 * lines[bands[k].row].h;
    bands.forEach((band, k) => {
      const c0 = cells[band.row][0];
      const type = standaloneLabel(c0.text);
      if (!type) return;
      inTable.add(band.row);
      // Without drawn borders the row runs from just above its label to just above the next row's label.
      let bottom: number;
      if (k + 1 < bands.length) bottom = top(k + 1) - 0.1 * h;
      else {
        const before = k > 0 ? top(k) - top(k - 1) : Y(band.row) - Y(hdr);
        bottom = Math.min(top(k) + clamp(before, 1.8 * h, 0.08 * PH), PH * 0.97);
        if (band.last + 1 < lines.length) bottom = Math.min(bottom, Y(band.last + 1) - 1.2 * lines[band.last + 1].h);
      }
      cols.forEach((col, i) => {
        let cell = ruledCell(Math.min(col.x0 + 2, (col.x0 + col.x1) / 2), Y(band.row) - 0.35 * c0.h);
        if (cell && cell.x0 < c0.x1 - 1) cell = null; // that is the label's own cell
        if (!cell) {
          const next = cols[i + 1] ? cols[i + 1].x0 - 0.8 * h : Math.min(rightEdge, col.x0 + (i > 0 ? col.x0 - cols[i - 1].x0 - 0.8 * h : 0.3 * PW));
          cell = { x0: col.x0 - 3, x1: Math.max(next, col.x0), top: top(k), bottom };
        }
        if (!free({ x0: cell.x0 + 1, x1: cell.x1 - 1, top: cell.top + 1, bottom: cell.bottom - 1 })) return;
        const b = inCell(type, cell, Y(band.row), c0.h);
        if (b) out.push({ ...b, type, source: 'label', rank: 3, ...(cols.length > 1 ? { signer: i + 1 } : {}), who: [col.text] });
      });
    });
  }

  // Bare labels: a line that is nothing but labels, with room to write next to it, on a line drawn above it, in the
  // empty cells of a ruled row beside it, or under it.
  const labelOnly = (r: number) => r >= 0 && r < cells.length && !inTable.has(r) && cells[r].length > 0 && cells[r].every((c) => standaloneLabel(c.text));
  for (let r = 0; r < cells.length; r++) {
    if (!labelOnly(r)) continue;
    cells[r].forEach((c, j) => {
      const type = standaloneLabel(c.text)!;
      const h = c.h;
      if (out.some((f) => f.row === r && f.lx !== undefined && Math.abs(f.lx - c.x0) <= 1.5 * h)) return; // already has its field
      const add = (b: Box, more: Partial<Raw> = {}) => out.push({ ...b, type, source: 'label', rank: 5, row: r, lx: c.x0, ...more });
      const wide = (WIDTH[type] || 0.2) * PW;
      const py = c.y - 0.35 * h;

      // 1. A ruled row with no header: the empty cells to the right of the label, one per person when there are more.
      const own = ruledCell(c.x0 + 1, py);
      if (own) {
        const empty: Area[] = [];
        for (let at = own; empty.length < 6; ) {
          const next = ruledCell(at.x1 + 3, py);
          if (!next || next.x0 < at.x1 - 2 || !free({ x0: next.x0 + 1, x1: next.x1 - 1, top: next.top + 1, bottom: next.bottom - 1 })) break;
          empty.push((at = next));
        }
        const made = empty.map((cell) => inCell(type, cell, c.y, h));
        if (made.some(Boolean)) return void made.forEach((b, i) => b && add(b, { rank: 3, lx: undefined, ...(empty.length > 1 ? { signer: i + 1 } : {}) }));
      }

      // 2. A line drawn just above the label is the line to sign on.
      const on = own ? undefined : across
        .filter((a) => a.y > c.y - 2.4 * h && a.y < c.y - 0.75 * h && a.x0 <= c.x0 + 1.5 * h && a.x1 >= c.x0 + 0.08 * PW && !down.some((v) => v.x > a.x0 - 2 && v.x < a.x1 + 2 && v.y0 - 2 <= a.y && v.y1 + 2 >= a.y))
        .sort((a, b) => b.y - a.y)[0];
      if (on) {
        const x1 = Math.min(on.x1, on.x0 + 1.3 * wide);
        const bottom = on.y - 1;
        let up = bottom - (TALL[type] ? Math.max(TALL[type] * h, 0.036 * PH) : 1.5 * h);
        for (const i of items) if (i.x < x1 && i.x + i.w > on.x0 && i.y < bottom && i.y + 0.25 * i.h > up) up = i.y + 0.25 * i.h;
        if (bottom - up >= h) return void add({ x: on.x0 / PW, y: Math.max(0, up) / PH, w: (x1 - on.x0) / PW, h: (bottom - Math.max(0, up)) / PH });
      }

      // A label without a colon could be a heading. It counts when it is one of a set (two on a line with space under
      // them, or stacked with another label), or a lone "Signature" with room under it, in the size of the body text.
      const hasColon = /[:：]\s*$/.test(c.text);
      if (!hasColon) {
        const roomUnder = r + 1 >= cells.length || Y(r + 1) - c.y >= 2.5 * h || labelOnly(r + 1);
        const stacked = [r - 1, r + 1].some((n) => labelOnly(n) && Math.abs(Y(n) - c.y) <= 4.5 * h && cells[n].some((o) => Math.abs(o.x0 - c.x0) <= 1.5 * h));
        if (h > 1.2 * bodySize || !(stacked || (roomUnder && (cells[r].length > 1 || type === 'signature')))) return;
      }

      // 3. To the right of the label, up to the next label or the margin.
      let limit = cells[r][j + 1] ? cells[r][j + 1].x0 - 0.8 * h : PW * 0.94;
      if (own) limit = Math.min(limit, own.x1 - 2);
      const x0 = c.x1 + 0.5 * h;
      if (limit - x0 >= Math.max(0.05 * PW, 0.45 * wide)) {
        const b = box(lines[r], type, x0, Math.min(limit, x0 + wide));
        if (free(toArea(b))) return void add(b);
      }
      // 4. Under the label, when there is no room beside it.
      const w = Math.min(wide, (cells[r][j + 1] || own ? limit : PW * 0.97) - c.x0);
      const fh = TALL[type] ? Math.max(TALL[type] * h, 0.036 * PH) : 1.5 * h;
      const under: Box = { x: c.x0 / PW, y: (c.y + 0.5 * h) / PH, w: w / PW, h: fh / PH };
      if (w >= 0.4 * wide && c.y + 0.5 * h + fh <= Math.min(PH * 0.97, own ? own.bottom - 1 : PH) && free(toArea(under))) add(under);
    });
  }

  // Two places never share a spot. The surer find stays.
  const kept: Raw[] = [];
  for (const f of [...out].sort((a, b) => a.rank - b.rank)) if (!kept.some((k) => overlap(f, k) >= 0.3)) kept.push(f);

  // ---- Who each place is for ------------------------------------------------------------------------------------
  // Two signature blocks side by side are two people, left to right. Blocks under each other are two people when
  // each has its own heading ("For Company A"). The words around a block are kept as hints for matching a name.
  const open = kept.filter((f) => f.source === 'label' && f.rank !== 3 && f.row !== undefined && f.lx !== undefined);
  const findRows = [...new Set(open.map((f) => f.row!))].sort((a, b) => a - b);
  const reach = (r: number) => Math.max(5.5 * lines[r].h, 0.07 * PH);
  const hintIn = (r: number, xa: number, xb: number) => (cells[r] || [])
    .filter((c) => c.x0 >= xa - 0.5 * c.h && c.x0 < xb && !standaloneLabel(c.text) && c.text.length >= 2 && c.text.length <= 60 && c.text.split(' ').length <= 8 && /\p{L}/u.test(c.text) && c.text.search(BLANK) < 0 && c.text.search(TAG) < 0)
    .map((c) => c.text);
  /** Rows of a block of places that belong together, starting from row `r`. */
  const blockAround = (r: number, pool: number[]) => {
    const i = pool.indexOf(r);
    let a = i, b = i;
    while (a > 0 && Y(pool[a]) - Y(pool[a - 1]) <= reach(r)) a--;
    while (b < pool.length - 1 && Y(pool[b + 1]) - Y(pool[b]) <= reach(r)) b++;
    return pool.slice(a, b + 1);
  };
  const done = new Set<Raw>();
  for (const r of findRows) {
    const sigs = open.filter((f) => f.row === r && f.type === 'signature' && !done.has(f)).sort((a, b) => a.lx! - b.lx!);
    if (sigs.length < 2) continue;
    const h = lines[r].h;
    const rowsHere = blockAround(r, findRows);
    const starts = sigs.map((f) => f.lx! - 1.5 * h);
    const hints = starts.map((xa, n) => {
      const got: string[] = [];
      for (let u = rowsHere[0] - 2; u <= rowsHere[rowsHere.length - 1] + 2; u++) {
        if (u < 0 || u >= lines.length || Y(rowsHere[0]) - Y(u) > 4.2 * h || Y(u) - Y(rowsHere[rowsHere.length - 1]) > 3 * h) continue;
        got.push(...hintIn(u, n ? xa : 0, starts[n + 1] ?? PW));
      }
      return got.slice(0, 4);
    });
    for (const f of open) {
      if (done.has(f) || !rowsHere.includes(f.row!)) continue;
      let n = 0;
      starts.forEach((xa, k) => { if (f.lx! >= xa) n = k; });
      f.signer = n + 1;
      if (hints[n].length) f.who = hints[n];
      done.add(f);
    }
  }
  const rest = [...new Set(open.filter((f) => !done.has(f)).map((f) => f.row!))].sort((a, b) => a - b);
  const blocks: { rows: number[]; above: string[]; near: string[] }[] = [];
  for (const r of rest) if (!blocks.some((b) => b.rows.includes(r))) blocks.push({ rows: blockAround(r, rest), above: [], near: [] });
  // A line of words between two blocks is a hint for the block it is nearest to.
  const hintRows = new Map<number, { block: number; far: number; above: boolean }>();
  blocks.forEach((b, n) => {
    const first = b.rows[0], last = b.rows[b.rows.length - 1], h = lines[first].h;
    for (let u = first - 2; u <= last + 2; u++) {
      if (u < 0 || u >= lines.length || b.rows.includes(u)) continue;
      const far = u < first ? Y(first) - Y(u) : u > last ? Y(u) - Y(last) : 0;
      if (far > (u < first ? 4.2 : 3) * h) continue;
      const had = hintRows.get(u);
      if (!had || far < had.far) hintRows.set(u, { block: n, far, above: u < first });
    }
  });
  for (const [u, at] of [...hintRows].sort((a, b) => a[0] - b[0])) {
    const b = blocks[at.block];
    const xa = Math.min(...open.filter((f) => b.rows.includes(f.row!)).map((f) => f.lx!)) - 1.5 * lines[u].h;
    (at.above ? b.above : b.near).push(...hintIn(u, xa, PW));
  }
  const signing = blocks.filter((b) => open.some((f) => b.rows.includes(f.row!) && f.type === 'signature'));
  const headed = signing.filter((b) => b.above.length);
  const numbered = headed.length >= 2 && new Set(headed.map((b) => b.above[b.above.length - 1].toLowerCase())).size === headed.length;
  for (const b of blocks) {
    const who = [...b.above.slice(-2).reverse(), ...b.near].slice(0, 4);
    for (const f of open) {
      if (done.has(f) || !b.rows.includes(f.row!)) continue;
      if (numbered && headed.includes(b)) f.signer = headed.indexOf(b) + 1;
      if (who.length && signing.includes(b)) f.who = who;
    }
  }

  const stays = new Set(kept);
  return out.filter((f) => stays.has(f)).map(({ rank: _rank, row: _row, lx: _lx, ...f }) => f);
}

// ---- Giving each place to the right person ---------------------------------------------------------------------

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'professor', 'sir', 'madam', 'mme', 'jr', 'sr', 'ii', 'iii', 'phd', 'md', 'esq']);
const nameWords = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !TITLES.has(w));

/** True when words printed on the page name this person: their full name, or their first and last name, whatever
 *  the capitals, titles and punctuation. "Mr. James R. Cohen, Director" is James Cohen. "jimi cohen" is not. */
export function namesMatch(printed: string, name: string): boolean {
  const p = nameWords(printed), n = nameWords(name);
  if (!n.length || !p.length) return false;
  if (n.length === 1) return p.length <= 3 && p.includes(n[0]);
  return p.includes(n[0]) && p.includes(n[n.length - 1]);
}

/** Works out who each found place is for. `names` are the signers in their order. A place whose hints (Found.who)
 *  name one of them goes to that person, whatever the order. The other numbered places keep their order (first
 *  column is signer 1) among the people no name pointed at. Tags keep the number that was typed in them. A number
 *  past the end of `names` means nobody on the document fits yet. */
export function assignSigners<T extends Found>(found: T[], names: string[]): T[] {
  const mine = (f: T) => f.source === 'label' && (f.who?.length || f.signer);
  const key = (f: T) => (f.who?.length ? f.who.join('|').toLowerCase() : '') + '#' + (f.signer || 0);
  const byName = new Map<string, number>(); // party -> index into names
  for (const f of found) {
    if (!mine(f) || byName.has(key(f))) continue;
    const at = names.findIndex((n) => (f.who || []).some((w) => namesMatch(w, n)));
    if (at >= 0) byName.set(key(f), at);
  }
  // The people no name pointed at take the remaining places by number.
  const named = new Set(byName.values());
  const numbers = [...new Set(found.filter((f) => mine(f) && f.signer && !byName.has(key(f))).map((f) => f.signer!))].sort((a, b) => a - b);
  const byNumber = new Map<number, number>(); // signer number on the page -> index into names
  const spare = names.map((_, i) => i).filter((i) => !named.has(i));
  for (const n of numbers) if (spare.includes(n - 1)) byNumber.set(n, spare.splice(spare.indexOf(n - 1), 1)[0]);
  let past = names.length;
  for (const n of numbers) if (!byNumber.has(n)) byNumber.set(n, spare.length ? spare.shift()! : past++);
  return found.map((f) => {
    if (!mine(f)) return f;
    const at = byName.get(key(f)) ?? (f.signer ? byNumber.get(f.signer) : undefined);
    const { signer: _signer, ...bare } = f;
    return (at === undefined ? bare : { ...bare, signer: at + 1 }) as T;
  });
}

// ---- Form fields that are already in the PDF -------------------------------------------------------------------

const WIDGET_TYPE: Record<Widget['kind'], string> = { text: 'text', checkbox: 'checkbox', radio: 'radio', dropdown: 'dropdown', signature: 'signature' };

/** Turns a form field name such as "client.full_name" into a label a person can read. Machine names give ''. */
export function readableName(name?: string): string {
  const s = String(name || '').trim();
  if (!s || /[[\]]/.test(s) || s.length > 60) return '';
  return s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function findInWidgets(page: PageScan): Omit<Found, 'page'>[] {
  const { w: PW, h: PH } = page.size;
  return (page.widgets || [])
    .filter((wd) => wd.w > 1 && wd.h > 1)
    .map((wd) => {
      const x = clamp(wd.x, 0, PW), y = clamp(wd.y, 0, PH);
      const label = readableName(wd.name);
      return {
        type: WIDGET_TYPE[wd.kind], source: 'form' as const,
        x: x / PW, y: y / PH, w: clamp(wd.w, 0.012 * PW, PW - x) / PW, h: clamp(wd.h, 0.008 * PH, PH - y) / PH,
        ...(label && wd.kind !== 'radio' ? { label } : {}),
        ...(wd.kind === 'radio' ? { group: label || 'Group 1' } : {}),
        ...(wd.kind === 'dropdown' ? { options: (wd.options || []).filter(Boolean).slice(0, 100) } : {}),
        ...(wd.required ? { required: true } : {}),
      };
    });
}

// ---- Putting it together ---------------------------------------------------------------------------------------

/** How much of the smaller of two boxes is covered by the other, from 0 to 1. */
export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.w * a.h, b.w * b.h);
}

/** Drops every found place that would sit on top of a field that is already there (on the same page). */
export function withoutTaken<T extends Box & { page: number }>(found: T[], taken: (Box & { page: number })[], share = 0.3): T[] {
  return found.filter((f) => !taken.some((t) => t.page === f.page && overlap(f, t) >= share));
}

/** Every place in a document that looks like it wants a field, in reading order, with no two on the same spot. */
export function findFields(pages: PageScan[]): Found[] {
  const out: Found[] = [];
  pages.forEach((p, page) => {
    // Real form fields are the most trustworthy, then tags someone typed on purpose, then labels.
    const order = { form: 0, tag: 1, label: 2 };
    const here = [...findInWidgets(p), ...findInText(p)].map((f) => ({ ...f, page })).sort((a, b) => order[a.source] - order[b.source]);
    const kept: Found[] = [];
    for (const f of here) if (!kept.some((k) => overlap(f, k) >= 0.3)) kept.push(f);
    out.push(...kept.sort((a, b) => a.y - b.y || a.x - b.x));
  });
  return out;
}

// ---- Reading a pdf.js document -----------------------------------------------------------------------------------

type Matrix = number[];
// Same as pdf.js Util.transform: apply m2, then m1.
const mul = (m1: Matrix, m2: Matrix): Matrix => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

/** Converts one pdf.js text item to page units from the top left. Returns null for empty or rotated text. */
export function placeTextItem(raw: { str: string; transform: number[]; width: number; height?: number }, viewport: Matrix, mono = false): TextItem | null {
  if (!raw.str || !raw.str.trim() || !raw.width) return null;
  const t = mul(viewport, raw.transform);
  const along = Math.hypot(t[0], t[1]);
  if (!along || t[0] <= 0 || Math.abs(t[1]) / along > 0.05) return null; // not left to right on the page as displayed
  const scale = Math.hypot(viewport[0], viewport[1]);
  return { str: raw.str, x: t[4], y: t[5], w: raw.width * scale, h: Math.hypot(t[2], t[3]) || (raw.height || 0) * scale, ...(mono ? { mono } : {}) };
}

/** Converts a PDF rectangle [x1, y1, x2, y2] to a box in page units from the top left. */
export function placeRect(rect: number[], viewport: Matrix): Box {
  const ax = viewport[0] * rect[0] + viewport[2] * rect[1] + viewport[4], ay = viewport[1] * rect[0] + viewport[3] * rect[1] + viewport[5];
  const bx = viewport[0] * rect[2] + viewport[2] * rect[3] + viewport[4], by = viewport[1] * rect[2] + viewport[3] * rect[3] + viewport[5];
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/** Maps a pdf.js annotation to a form field we can place, or null for anything that is not a fillable field. */
export function widgetFrom(a: any, viewport: Matrix): Widget | null {
  if (a?.subtype !== 'Widget' || a.hidden || !Array.isArray(a.rect)) return null;
  const kind: Widget['kind'] | null =
    a.fieldType === 'Sig' ? 'signature' : a.fieldType === 'Tx' ? 'text' : a.fieldType === 'Ch' ? 'dropdown'
    : a.fieldType === 'Btn' ? (a.checkBox ? 'checkbox' : a.radioButton ? 'radio' : null) : null;
  if (!kind) return null;
  return {
    kind, ...placeRect(a.rect, viewport), name: a.alternativeText || a.fieldName || '', required: !!a.required,
    ...(kind === 'dropdown' ? { options: (a.options || []).map((o: any) => String(o?.displayValue ?? o?.exportValue ?? '')) } : {}),
  };
}

// pdf.js operator numbers (OPS in pdfjs-dist 4). Only the ones that draw or move straight lines matter here.
const OP = { save: 10, restore: 11, transform: 12, moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17, closePath: 18, rectangle: 19, endPath: 28, formBegin: 74, formEnd: 75, constructPath: 91 };
const PAINTS = new Set([20, 21, 22, 23, 24, 25, 26, 27]); // stroke and fill, in all their forms

/** The straight lines drawn on a page (table borders, lines to sign on), from a pdf.js operator list, in page units
 *  from the top left. Only painted paths count: a path that is only used for clipping draws nothing. */
export function rulesFrom(fnArray: number[], argsArray: any[], viewport: Matrix, size: PageSize): Rule[] {
  const out: Rule[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let pending: [number, number, number, number][] = []; // segments in the units of the path
  let pendingAt: Matrix = ctm;
  const line = (m: Matrix, x1: number, y1: number, x2: number, y2: number) => {
    const ax = m[0] * x1 + m[2] * y1 + m[4], ay = m[1] * x1 + m[3] * y1 + m[5];
    const bx = m[0] * x2 + m[2] * y2 + m[4], by = m[1] * x2 + m[3] * y2 + m[5];
    const w = Math.abs(bx - ax), h = Math.abs(by - ay);
    if (Math.min(w, h) > 0.75 || Math.max(w, h) < 6 || out.length >= 6000) return; // slanted, a speck, or enough
    out.push({ x: Math.min(ax, bx), y: Math.min(ay, by), w, h });
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OP.save) stack.push(ctm);
    else if (fn === OP.restore) ctm = stack.pop() || ctm;
    else if (fn === OP.transform && Array.isArray(args)) ctm = mul(ctm, args);
    else if (fn === OP.formBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = mul(ctm, Array.from(args[0] as number[]));
    } else if (fn === OP.formEnd) ctm = stack.pop() || ctm;
    else if (fn === OP.endPath) pending = [];
    else if (PAINTS.has(fn)) {
      const m = mul(viewport, pendingAt);
      for (const [x1, y1, x2, y2] of pending) line(m, x1, y1, x2, y2);
      pending = [];
    } else if (fn === OP.constructPath && args) {
      const ops: number[] = args[0] || [], c: number[] = args[1] || [];
      pendingAt = ctm;
      let k = 0, sx = 0, sy = 0, x = 0, y = 0;
      for (const op of ops) {
        if (op === OP.moveTo) { x = sx = c[k++]; y = sy = c[k++]; }
        else if (op === OP.lineTo) { const nx = c[k++], ny = c[k++]; pending.push([x, y, nx, ny]); x = nx; y = ny; }
        else if (op === OP.curveTo) { k += 4; x = c[k++]; y = c[k++]; }
        else if (op === OP.curveTo2 || op === OP.curveTo3) { k += 2; x = c[k++]; y = c[k++]; }
        else if (op === OP.closePath) { pending.push([x, y, sx, sy]); x = sx; y = sy; }
        else if (op === OP.rectangle) {
          const rx = c[k++], ry = c[k++], rw = c[k++], rh = c[k++];
          const m = mul(viewport, ctm);
          const pw = Math.abs(m[0] * rw + m[2] * rh), ph = Math.abs(m[1] * rw + m[3] * rh);
          if (pw >= 0.9 * size.w && ph >= 0.9 * size.h) continue; // the page's own background
          if (Math.min(pw, ph) <= 3) {
            // A thin box is a line drawn as a box. Its middle is the line.
            if (pw >= ph) pending.push([rx, ry + rh / 2, rx + rw, ry + rh / 2]);
            else pending.push([rx + rw / 2, ry, rx + rw / 2, ry + rh]);
          } else pending.push([rx, ry, rx + rw, ry], [rx + rw, ry, rx + rw, ry + rh], [rx + rw, ry + rh, rx, ry + rh], [rx, ry + rh, rx, ry]);
        }
      }
    }
  }
  return out;
}

/** Reads every page of a loaded pdf.js document into plain data for findFields(). */
export async function scanPdf(pdf: any, onPage?: (done: number, total: number) => void): Promise<PageScan[]> {
  const pages: PageScan[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const [text, annotations] = await Promise.all([page.getTextContent(), page.getAnnotations().catch(() => [])]);
    const items: TextItem[] = [];
    for (const it of text.items || []) {
      if (typeof it?.str !== 'string') continue;
      const placed = placeTextItem(it, vp.transform, text.styles?.[it.fontName]?.fontFamily === 'monospace');
      if (placed) items.push(placed);
    }
    const widgets = (annotations as any[]).map((a) => widgetFrom(a, vp.transform)).filter(Boolean) as Widget[];
    // Drawn lines are only read on a page that has a label standing alone, where they show the cells of a table.
    let rules: Rule[] = [];
    if (toLines(items, 0.75).some((l) => l.text.split(/\t| {3,}/).some((part) => standaloneLabel(part)))) {
      try {
        const ops = await page.getOperatorList();
        rules = rulesFrom(ops.fnArray, ops.argsArray, vp.transform, { w: vp.width, h: vp.height });
      } catch {
        // Without the lines the text positions still say where the cells are.
      }
    }
    pages.push({ size: { w: vp.width, h: vp.height }, items, widgets, ...(rules.length ? { rules } : {}) });
    onPage?.(n, pdf.numPages);
  }
  return pages;
}
