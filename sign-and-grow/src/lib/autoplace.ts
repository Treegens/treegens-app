// Finds the places in a document where a field belongs, so nobody has to drag every one by hand:
//   1. form fields that are already in the PDF,
//   2. labels followed by a blank on the same line ("Signature: ______"),
//   3. explicit tags in the text ({{signature}}, {{text:Some label}}, {{signature2}} for the second signer).
// Everything here works on plain data (text runs with positions, a page size) so it runs the same in the browser
// and in tests. Input positions are in page units with the origin at the top left. Results are fractions of the
// page, like every other field in the editor. Only scanPdf() at the bottom touches a pdf.js document.

export type PageSize = { w: number; h: number };
/** A run of text. x is its left edge, y its baseline measured from the top of the page, w its width, h the font size. */
export type TextItem = { str: string; x: number; y: number; w: number; h: number; mono?: boolean };
/** A form field that is already part of the PDF. x and y are the top left corner. */
export type Widget = { kind: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'signature'; x: number; y: number; w: number; h: number; name?: string; options?: string[]; required?: boolean };
export type PageScan = { size: PageSize; items: TextItem[]; widgets?: Widget[] };
export type Box = { x: number; y: number; w: number; h: number };
export type Found = Box & {
  type: string;
  page: number;
  source: 'form' | 'tag' | 'label';
  label?: string;
  /** 1 for the first signer, 2 for the second. Only set by numbered tags such as {{signature2}}. */
  signer?: number;
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

/** Groups runs of text that share a baseline into lines, and works out where each character starts. */
export function toLines(items: TextItem[]): Line[] {
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
      if (text && gap > 0.12 * h) {
        text += gap >= h ? WIDE_GAP : ' ';
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
  return null;
}

const TAG = /\{\{\s*(signature|initials|date|name|email|title|company|checkbox|text)\s*(\d{1,2})?\s*(?::\s*([^{}]*?))?\s*\}\}/gi;
const TAG_TYPE: Record<string, string> = { signature: 'signature', initials: 'initials', date: 'date_signed', name: 'full_name', email: 'email', title: 'title', company: 'company', checkbox: 'checkbox', text: 'text' };
// A blank drawn with characters: underscores, a dotted leader, or a run of ellipses.
const BLANK = /_{3,}|\.{5,}|…{2,}/g;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Finds labels with blanks and {{tags}} on one page. */
export function findInText(page: PageScan): Omit<Found, 'page'>[] {
  const { w: PW, h: PH } = page.size;
  const lines = toLines(page.items);
  const out: Omit<Found, 'page'>[] = [];

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
    top = Math.min(top, bottom - 1.25 * line.h);
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

  for (const line of lines) {
    // Stretches of the line that are already spoken for, as [start, end) character indexes.
    const used: [number, number][] = [];

    for (const m of line.text.matchAll(TAG)) {
      const start = m.index!, end = start + m[0].length;
      used.push([start, end]);
      const type = TAG_TYPE[m[1].toLowerCase()];
      const x0 = line.cx[start], tagEnd = line.cx[end];
      const x1 = type === 'checkbox' ? x0 + 1.15 * line.h : Math.max(tagEnd, Math.min(x0 + (WIDTH[type] || 0.2) * PW, roomUntil(line, end)));
      out.push({ ...box(line, type, x0, x1), type, source: 'tag', ...(m[2] ? { signer: Number(m[2]) } : {}), ...(m[3]?.trim() ? { label: m[3].trim().slice(0, 120) } : {}) });
    }

    // Blanks drawn as characters, and blanks that are only implied by a colon with nothing after it.
    const blanks: { start: number; end: number; drawn: boolean }[] = [];
    for (const m of line.text.matchAll(BLANK)) blanks.push({ start: m.index!, end: m.index! + m[0].length, drawn: true });
    for (const m of line.text.matchAll(/:(?=[ \t]*$|[ \t]*\t|\s{3,})/g)) {
      const at = m.index! + 1;
      // Skip a colon that is directly followed by a drawn blank: that blank is already in the list.
      if (/^\s*(_{3,}|\.{5,}|…{2,})/.test(line.text.slice(at))) continue;
      blanks.push({ start: at, end: at, drawn: false });
    }
    blanks.sort((a, b) => a.start - b.start);

    const spots: { type: string; label: string; b: (typeof blanks)[number] }[] = [];
    blanks.forEach((b, i) => {
      if (used.some(([s, e]) => b.start < e && b.end > s)) return;
      // The label is whatever sits between this blank and the previous blank, tag or wide gap.
      let from = 0;
      for (const p of blanks.slice(0, i)) from = Math.max(from, p.end);
      for (const [, e] of used) if (e <= b.start) from = Math.max(from, e);
      const before = line.text.slice(from, b.start);
      const gap = [...before.matchAll(/\t|\s{3,}/g)].filter((g) => before.slice(g.index! + g[0].length).trim()).pop();
      const label = (gap ? before.slice(gap.index! + gap[0].length) : before).trim();
      const type = fieldForLabel(label);
      if (type) spots.push({ type, label, b });
    });

    for (const { type, label, b } of spots) {
      if (b.drawn) {
        out.push({ ...box(line, type, line.cx[b.start], line.cx[b.end]), type, source: 'label' });
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
      out.push({ ...box(line, type, x0, x1), type, source: 'label' });
    }
  }
  return out;
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
    pages.push({ size: { w: vp.width, h: vp.height }, items, widgets });
    onPage?.(n, pdf.numPages);
  }
  return pages;
}
