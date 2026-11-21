// Where the stamp and the envelope ID line go on a page of somebody's document, so that they never stand on the
// document's own words or pictures.
//
// We print one strip, 17 pt deep, at the foot of each page (brandpdf.ts). Before printing we look at what the page
// already has in that strip: its text (read with pdf.js, the reader the search uses), its pictures (every image the
// page paints, found by walking the page's drawing commands without unpacking a single pixel), and the fields we
// filled in ourselves. Then:
//   1. the strip goes at the foot on the left when that is clear,
//   2. or at the foot on the right, or in the widest clear stretch of the foot,
//   3. and when the foot has no clear stretch wide enough (a scan that is one picture to its edges, a footer that
//      runs the whole width), or the page could not be read, the page is made 17 pt taller and the strip is printed
//      on that new margin. The document's own content keeps its place and its size.
// So the strip is always at the foot, where every screen says the envelope ID is, and never over anything.
//
// Lines and filled shapes count as well (a ruled line, a page border, a coloured band, words drawn as outlines), with
// two exceptions: anything painted white, and a filled shape over most of the page, which is the sheet behind
// everything (nearly every page made by a word processor or a browser starts with one). What is not looked at: colour
// gradients ("sh"), what a clipping path hides (a picture counts whole), and comments or stamps a PDF reader shows on
// top of the page.
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, rgb, type PDFPage, type PDFFont, type Color, type Rotation } from 'pdf-lib';
import { drawPageFoot, PAGE_STAMP_PT, PAGE_STAMP_UP, PAGE_STAMP_W } from './brandpdf.ts';

/** How deep the strip is: the stamp (12 pt) and the room under it (5 pt). */
export const STRIP_PT = PAGE_STAMP_PT + PAGE_STAMP_UP;
/** How far the strip stays from the left and right edges, and from anything of the document's beside it. */
export const EDGE = 12;
const CLEAR = 4;
/** The zone looked at reaches this far above the strip, so a line of text just over it is not touched either. */
const ABOVE = 2.5;

/** A box on the page as it is shown: points from the top left corner, y down. */
export type Box = { x0: number; y0: number; x1: number; y1: number };
/** What one page has near its foot. `known` is false when the page could not be read: then nothing is assumed clear. */
export type FootInk = { W: number; H: number; boxes: Box[]; known: boolean };

type Mapper = { W: number; H: number; pt: (x: number, y: number) => { x: number; y: number }; rotate: Rotation };

// ---- the pictures a page paints -------------------------------------------------------------------------------------

type Mx = [number, number, number, number, number, number];
const mul = (m: Mx, n: Mx): Mx => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const at = (m: Mx, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const MAX_STREAM = 24 * 1024 * 1024;
const MAX_OPS = 400_000;

/** The drawing commands of a page or a form, as bytes. Throws when one cannot be unpacked. */
function streamBytes(s: unknown): Uint8Array {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  // A stream pdf-lib built itself (never on a page as it comes from flatPages).
  if (s instanceof PDFStream && typeof (s as any).getUnencodedContents === 'function') return (s as any).getUnencodedContents();
  throw new Error('unreadable stream');
}

function pageStreams(page: PDFPage): Uint8Array[] {
  const c = page.node.lookup(PDFName.of('Contents'));
  if (!c) return [];
  if (c instanceof PDFArray) return c.asArray().map((x) => streamBytes(x instanceof PDFRef ? page.doc.context.lookup(x) : x));
  return [streamBytes(c)];
}

type Pt = { x: number; y: number };
/** What a page paints, in the page's own coordinates: pictures as their four corners, and drawn shapes. */
type Painted = { pics: Pt[][]; shapes: { pts: Pt[]; pad: number; fill: boolean }[] };
/** The state q saves and Q puts back: where things land, and whether filling and stroking paint white. */
type Gs = { ctm: Mx; fillWhite: boolean; strokeWhite: boolean; lw: number };

/** Gray, RGB or CMYK numbers that paint white (or as good as), told apart by how many there are. */
const whiteOf = (v: number[]) => (v.length === 1 ? v[0] >= 0.98 : v.length === 3 ? v.every((c) => c >= 0.98) : v.length === 4 ? v.every((c) => c <= 0.02) : false);

/**
 * Walks drawing commands and reports every picture painted, as the four corners of where it lands in the page's own
 * coordinates, and every line or shape stroked or filled in a colour other than white (text drawn as outlines, a
 * ruled line, a page border, a coloured band). What moves the coordinate system is followed (q, Q, cm), the colour
 * and width of lines, the path commands, Do (a picture, or a form that is walked in turn) and inline pictures.
 * Throws when the commands are too many to follow.
 */
function walk(bytes: Uint8Array, start: Gs, resources: PDFDict | undefined, look: (o: unknown) => unknown, out: Painted, budget: { ops: number }, depth: number) {
  const stack: Gs[] = [];
  let gs: Gs = { ...start };
  let ctm = gs.ctm;
  const nums: number[] = [];
  let name = '';
  let i = 0;
  const n = bytes.length;
  const paint = () => out.pics.push([at(ctm, 0, 0), at(ctm, 1, 0), at(ctm, 0, 1), at(ctm, 1, 1)]);
  // The path being built: every point, for a fill, and its pieces one by one, for a stroke (a frame round the page is
  // four thin lines, not the whole page).
  let pathPts: Pt[] = [];
  let pieces: Pt[][] = [];
  let first: Pt | null = null, last: Pt | null = null;
  const to = (x: number, y: number) => at(ctm, x, y);
  const scale = () => Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
  const paintPath = (fill: boolean, stroke: boolean) => {
    if (fill && !gs.fillWhite && pathPts.length) out.shapes.push({ pts: pathPts, pad: 0, fill: true });
    if (stroke && !gs.strokeWhite) {
      const pad = Math.max(0.5, (gs.lw || 1) * scale() / 2);
      for (const p of pieces) out.shapes.push({ pts: p, pad, fill: false });
    }
    pathPts = []; pieces = []; first = last = null;
  };
  while (i < n) {
    const c = bytes[i];
    if (WHITE.has(c)) { i++; continue; }
    if (c === 37) { while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++; continue; } // a comment
    if (c === 40) { // a string, with brackets inside it
      let deep = 1;
      i++;
      while (i < n && deep > 0) {
        if (bytes[i] === 92) i++;
        else if (bytes[i] === 40) deep++;
        else if (bytes[i] === 41) deep--;
        i++;
      }
      continue;
    }
    if (c === 60 && bytes[i + 1] !== 60) { while (i < n && bytes[i] !== 62) i++; i++; continue; } // a hex string
    if (c === 60 || c === 62) { i += 2; continue; } // << and >>
    if (c === 91 || c === 93 || c === 123 || c === 125 || c === 41) { i++; continue; }
    if (c === 47) { // a name
      let j = i + 1;
      while (j < n && !WHITE.has(bytes[j]) && !DELIM.has(bytes[j])) j++;
      name = Buffer.from(bytes.subarray(i + 1, j)).toString('latin1').replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !WHITE.has(bytes[j]) && !DELIM.has(bytes[j])) j++;
    if (j === i) { i++; continue; }
    const word = Buffer.from(bytes.subarray(i, j)).toString('latin1');
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { nums.push(Number(word)); if (nums.length > 6) nums.shift(); continue; }
    if (++budget.ops > MAX_OPS) throw new Error('too many commands');
    const k2 = nums.slice(-2), k4 = nums.slice(-4), k6 = nums.slice(-6);
    if (word === 'q') stack.push({ ...gs, ctm });
    else if (word === 'Q') { const back = stack.pop(); if (back) { gs = back; ctm = back.ctm; } }
    else if (word === 'cm' && nums.length === 6) ctm = mul(nums as Mx, ctm);
    // Colours and line width.
    else if (word === 'g' || word === 'rg' || word === 'k') gs.fillWhite = whiteOf(nums.slice(-(word === 'g' ? 1 : word === 'rg' ? 3 : 4)));
    else if (word === 'G' || word === 'RG' || word === 'K') gs.strokeWhite = whiteOf(nums.slice(-(word === 'G' ? 1 : word === 'RG' ? 3 : 4)));
    else if (word === 'sc' || word === 'scn') gs.fillWhite = !name && whiteOf(nums); // a pattern (a name) is ink
    else if (word === 'SC' || word === 'SCN') gs.strokeWhite = !name && whiteOf(nums);
    else if (word === 'cs') gs.fillWhite = false; // a new colour space starts black
    else if (word === 'CS') gs.strokeWhite = false;
    else if (word === 'w' && nums.length) gs.lw = nums[nums.length - 1];
    // Building a path.
    else if (word === 'm' && k2.length === 2) { const p = to(k2[0], k2[1]); pathPts.push(p); first = last = p; }
    else if (word === 'l' && k2.length === 2) { const p = to(k2[0], k2[1]); pathPts.push(p); pieces.push([last || p, p]); last = p; }
    else if ((word === 'c' && k6.length === 6) || ((word === 'v' || word === 'y') && k4.length === 4)) {
      const v = word === 'c' ? k6 : k4;
      const ps: Pt[] = [];
      for (let q = 0; q < v.length; q += 2) ps.push(to(v[q], v[q + 1]));
      pathPts.push(...ps); pieces.push([last || ps[0], ...ps]); last = ps[ps.length - 1];
    } else if (word === 'h') { if (first && last) pieces.push([last, first]); last = first; }
    else if (word === 're' && k4.length === 4) {
      const [x, y, w, h] = k4;
      const c = [to(x, y), to(x + w, y), to(x + w, y + h), to(x, y + h)];
      pathPts.push(...c);
      for (let q = 0; q < 4; q++) pieces.push([c[q], c[(q + 1) % 4]]);
      first = last = c[0];
    }
    // Painting it, or not (n ends a path used only to cut out what follows).
    else if (word === 'S' || word === 's') paintPath(false, true);
    else if (word === 'f' || word === 'F' || word === 'f*') paintPath(true, false);
    else if (word === 'B' || word === 'B*' || word === 'b' || word === 'b*') paintPath(true, true);
    else if (word === 'n') paintPath(false, false);
    else if (word === 'BI') {
      // An inline picture: its bytes follow ID and end at EI standing alone.
      paint();
      let k = i;
      while (k < n && !(bytes[k] === 73 && bytes[k + 1] === 68 && WHITE.has(bytes[k + 2]))) k++;
      k += 3;
      while (k < n && !(WHITE.has(bytes[k - 1]) && bytes[k] === 69 && bytes[k + 1] === 73 && (k + 2 >= n || WHITE.has(bytes[k + 2]) || DELIM.has(bytes[k + 2])))) k++;
      i = k + 2;
    } else if (word === 'Do' && name) {
      const xo = look(resources ? (look(resources.get(PDFName.of('XObject'))) as PDFDict | undefined)?.get?.(PDFName.of(name)) : undefined);
      if (xo instanceof PDFStream) {
        const sub = look(xo.dict.get(PDFName.of('Subtype')));
        if (sub === PDFName.of('Image')) paint();
        else if (sub === PDFName.of('Form')) {
          if (depth >= 12) throw new Error('forms too deep');
          const mx = look(xo.dict.get(PDFName.of('Matrix')));
          const inner = mx instanceof PDFArray && mx.size() === 6 ? (mx.asArray().map((v) => (look(v) as PDFNumber).asNumber()) as Mx) : ([1, 0, 0, 1, 0, 0] as Mx);
          const res = look(xo.dict.get(PDFName.of('Resources')));
          walk(streamBytes(xo), { ...gs, ctm: mul(inner, ctm) }, res instanceof PDFDict ? res : resources, look, out, budget, depth + 1);
        }
      }
    }
    nums.length = 0;
    name = '';
  }
}

/** The mapper of pdf.ts turned round: a point of the page's own coordinates as the page is shown. */
function shownPoint(page: PDFPage) {
  const b = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  return (p: { x: number; y: number }) =>
    rot === 0 ? { x: p.x - b.x, y: b.y + b.height - p.y }
    : rot === 90 ? { x: p.y - b.y, y: p.x - b.x }
    : rot === 180 ? { x: b.x + b.width - p.x, y: p.y - b.y }
    : { x: b.y + b.height - p.y, y: b.x + b.width - p.x };
}

const boxOf = (pts: { x: number; y: number }[]): Box => ({ x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) });

/** A shape filled over most of the page is the page's ground (a white or coloured sheet behind everything). */
const GROUND = 0.85;

/**
 * Every picture a page paints, and every line and shape it draws in ink, as boxes on the page as shown. Null when the
 * page's commands could not be followed. A filled shape that covers most of the page is its ground, not its content,
 * and is left out, as is anything filled or stroked in white.
 */
export function paintedBoxes(page: PDFPage): { pictures: Box[]; shapes: Box[] } | null {
  try {
    const look = (o: unknown) => (o instanceof PDFRef ? page.doc.context.lookup(o) : o);
    const out: Painted = { pics: [], shapes: [] };
    const budget = { ops: 0 };
    const streams = pageStreams(page);
    if (streams.reduce((a, s) => a + s.length, 0) > MAX_STREAM) return null;
    // The streams of a page are one run of commands: a q in one may be closed in the next.
    const all = Buffer.concat(streams.map((s) => Buffer.concat([Buffer.from(s), Buffer.from('\n')])));
    // A page starts with black ink for filling and stroking, lines 1 unit wide.
    walk(all, { ctm: [1, 0, 0, 1, 0, 0], fillWhite: false, strokeWhite: false, lw: 1 }, page.node.Resources(), look, out, budget, 0);
    const shown = shownPoint(page);
    const b = page.getCropBox();
    const area = b.width * b.height;
    const shapes: Box[] = [];
    for (const s of out.shapes) {
      const x = boxOf(s.pts.map(shown));
      if (s.fill && (x.x1 - x.x0) * (x.y1 - x.y0) >= GROUND * area) continue;
      shapes.push({ x0: x.x0 - s.pad, y0: x.y0 - s.pad, x1: x.x1 + s.pad, y1: x.y1 + s.pad });
    }
    return { pictures: out.pics.map((corners) => boxOf(corners.map(shown))), shapes };
  } catch {
    return null;
  }
}

/** Every picture a page paints, as boxes on the page as shown. Null when the page's commands could not be followed. */
export const pictureBoxes = (page: PDFPage): Box[] | null => paintedBoxes(page)?.pictures ?? null;

// ---- the text of a page ---------------------------------------------------------------------------------------------

/**
 * Where each run of text stands on each page of a PDF, as boxes on the page as shown. A page that could not be read,
 * or was not reached in time, is null. A box is a little generous: from under the letters' tails to above their tops.
 */
export async function textBoxes(bytes: Uint8Array, ms = 15_000): Promise<(Box[] | null)[]> {
  const out: (Box[] | null)[] = [];
  let late = false;
  const work = async () => {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
    try {
      for (let i = 1; i <= doc.numPages && !late; i++) {
        let boxes: Box[] | null = null;
        try {
          const page = await doc.getPage(i);
          const view = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          boxes = [];
          for (const item of content.items as any[]) {
            if (!item.str || !String(item.str).trim() || !Array.isArray(item.transform)) continue;
            const t = pdfjs.Util.transform(view.transform, item.transform) as number[];
            const dl = Math.hypot(t[0], t[1]) || 1, ul = Math.hypot(t[2], t[3]) || 1;
            const h = item.height || ul, w = item.width || h;
            const d = { x: (t[0] / dl) * w, y: (t[1] / dl) * w }, u = { x: t[2] / ul, y: t[3] / ul };
            const lo = { x: t[4] - u.x * h * 0.3, y: t[5] - u.y * h * 0.3 }, hi = { x: t[4] + u.x * h, y: t[5] + u.y * h };
            boxes.push(boxOf([lo, hi, { x: lo.x + d.x, y: lo.y + d.y }, { x: hi.x + d.x, y: hi.y + d.y }]));
          }
          page.cleanup();
        } catch {
          boxes = null;
        }
        if (!late) out.push(boxes);
      }
    } finally {
      await doc.destroy().catch(() => {});
    }
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work(), new Promise<void>((resolve) => { timer = setTimeout(() => { late = true; resolve(); }, ms); })]);
  } catch {
    /* an unreadable file: every page not read yet stays unknown */
  }
  clearTimeout(timer);
  return out.slice();
}

// ---- what is near the foot of each page, remembered per stored file -------------------------------------------------

const zoneTop = (H: number) => H - STRIP_PT - ABOVE;

const cache = new Map<string, FootInk[]>();
const noted = new WeakMap<PDFPage, FootInk>();

/**
 * Looks at the pages of one stored PDF as they were copied into the signed file (pdf.ts, flatPages) and remembers what
 * each has near its foot. `key` names the stored file, so the same file is read once and not again for every copy.
 */
export async function notePages(pages: PDFPage[], bytes: Uint8Array, key: string): Promise<void> {
  let inks = cache.get(key);
  if (!inks || inks.length !== pages.length) {
    const text = await textBoxes(bytes);
    inks = pages.map((page, i) => {
      const b = page.getCropBox();
      const side = page.getRotation().angle % 180 !== 0;
      const W = side ? b.height : b.width, H = side ? b.width : b.height;
      const painted = paintedBoxes(page);
      const words = text[i] ?? null;
      const known = !!painted && !!words;
      const near = (x: Box) => x.y1 > zoneTop(H) && x.y0 < H && x.x1 > 0 && x.x0 < W;
      return { W, H, known, boxes: known ? [...painted!.pictures, ...painted!.shapes, ...words!].filter(near) : [] };
    });
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, inks);
  }
  pages.forEach((p, i) => noted.set(p, inks![i]));
}

/** What was noted for a page, or "nothing known" for a page nobody looked at. */
export const inkOf = (page: PDFPage, m: { W: number; H: number }): FootInk => noted.get(page) || { W: m.W, H: m.H, boxes: [], known: false };

// ---- choosing the place ---------------------------------------------------------------------------------------------

export type FootPlan = {
  /** Where the strip starts, from the left edge of the page as shown. */
  left: number;
  /** The size of the envelope ID line. */
  size: number;
  /** False on a page too narrow for the stamp beside the line: the line alone is printed, whole. */
  stamp: boolean;
  /** True when the foot had no clear stretch: the page gets a new margin of STRIP_PT under it for the strip. */
  grow: boolean;
  /** 'left', 'right' or 'gap' at the foot of the page as it is, 'margin' on the added margin. */
  where: 'left' | 'right' | 'gap' | 'margin';
};

/**
 * Chooses where the strip goes. `lineWidth(size)` is how wide the envelope ID line is at a size; `taken` are boxes
 * that must stay clear (the page's text and pictures and our own fields), on the page as shown.
 */
export function planFoot(W: number, H: number, taken: Box[], known: boolean, lineWidth: (size: number) => number): FootPlan {
  // The line's size and whether the stamp fits beside it, from the page's width alone.
  const room = W - 2 * EDGE;
  let size = 6.5, stamp = true;
  const need = () => (stamp ? PAGE_STAMP_W + 6 : 0) + lineWidth(size);
  while (size > 4 && need() > room) size -= 0.25;
  if (need() > room) { stamp = false; size = 6.5; while (size > 4 && need() > room) size -= 0.25; }
  while (size > 0.5 && need() > room) size -= 0.25;
  const width = need();
  const margin: FootPlan = { left: EDGE, size, stamp, grow: true, where: 'margin' };
  if (!known) return margin;

  // The stretches of the foot that something already uses, left to right.
  const used = taken.filter((b) => b.y1 > zoneTop(H) && b.y0 < H).map((b) => [b.x0 - CLEAR, b.x1 + CLEAR] as [number, number]).sort((a, b) => a[0] - b[0]);
  const gaps: [number, number][] = [];
  let x = EDGE;
  for (const [a, b] of used) {
    if (a > x) gaps.push([x, Math.min(a, W - EDGE)]);
    x = Math.max(x, b);
    if (x >= W - EDGE) break;
  }
  if (x < W - EDGE) gaps.push([x, W - EDGE]);
  const fits = gaps.filter(([a, b]) => b - a >= width - 0.01);
  if (!fits.length) return margin;
  if (fits[0][0] <= EDGE + 0.01) return { left: EDGE, size, stamp, grow: false, where: 'left' };
  const last = fits[fits.length - 1];
  if (last[1] >= W - EDGE - 0.01) return { left: W - EDGE - width, size, stamp, grow: false, where: 'right' };
  const widest = fits.reduce((p, c) => (c[1] - c[0] > p[1] - p[0] ? c : p));
  return { left: (widest[0] + widest[1] - width) / 2, size, stamp, grow: false, where: 'gap' };
}

/** Adds a margin of STRIP_PT under the page as it is shown, whichever way the page is turned. The content stays put. */
export function growFoot(page: PDFPage) {
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const taller = (b: { x: number; y: number; width: number; height: number }) =>
    rot === 0 ? { x: b.x, y: b.y - STRIP_PT, width: b.width, height: b.height + STRIP_PT }
    : rot === 90 ? { x: b.x, y: b.y, width: b.width + STRIP_PT, height: b.height }
    : rot === 180 ? { x: b.x, y: b.y, width: b.width, height: b.height + STRIP_PT }
    : { x: b.x - STRIP_PT, y: b.y, width: b.width + STRIP_PT, height: b.height };
  const crop = taller(page.getCropBox());
  const media = page.getMediaBox();
  // The sheet must hold the page that is shown: it grows to take the new margin in.
  const x0 = Math.min(media.x, crop.x), y0 = Math.min(media.y, crop.y);
  const x1 = Math.max(media.x + media.width, crop.x + crop.width), y1 = Math.max(media.y + media.height, crop.y + crop.height);
  page.setMediaBox(x0, y0, x1 - x0, y1 - y0);
  page.setCropBox(crop.x, crop.y, crop.width, crop.height);
  // Boxes a printer uses that the page did not have fall back to the page shown, so they need nothing.
}

/**
 * Prints the stamp and the envelope ID line at the foot of one page of a signed copy, where they cover nothing.
 * `m` is pdf.ts's mapper() for the page; `fields` are the boxes of the fields printed on this page, as shown.
 * Returns what was decided, for the tests.
 */
export function drawFootClear(page: PDFPage, m: Mapper, fields: Box[], o: { line: string; font: PDFFont; color: Color }): FootPlan {
  const ink = inkOf(page, m);
  const plan = planFoot(m.W, m.H, [...ink.boxes, ...fields], ink.known, (size) => o.font.widthOfTextAtSize(o.line, size));
  let mm = m;
  if (plan.grow) {
    growFoot(page);
    mm = { ...m, H: m.H + STRIP_PT }; // the same places as before, with the new margin under them
    // The new margin is white whatever lay outside the page before (a sheet larger than the page shown).
    const c = [mm.pt(0, m.H), mm.pt(m.W, m.H), mm.pt(0, mm.H), mm.pt(m.W, mm.H)];
    const x0 = Math.min(...c.map((p) => p.x)), y0 = Math.min(...c.map((p) => p.y));
    page.drawRectangle({ x: x0, y: y0, width: Math.max(...c.map((p) => p.x)) - x0, height: Math.max(...c.map((p) => p.y)) - y0, color: rgb(1, 1, 1) });
  }
  drawPageFoot(page, mm, { ...o, left: plan.left, size: plan.size, stamp: plan.stamp });
  return plan;
}

/** The box of a field on the page as shown, from its stored fractions of the page. */
export const fieldBox = (f: { x: number; y: number; w: number; h: number }, m: { W: number; H: number }): Box => ({ x0: f.x * m.W, y0: f.y * m.H, x1: (f.x + f.w) * m.W, y1: (f.y + f.h) * m.H });
