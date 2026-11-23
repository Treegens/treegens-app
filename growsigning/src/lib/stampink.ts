// How a picture of a stamp becomes an impression that looks like ink from a rubber stamp, not a picture pasted on
// top. The browser runs this on a canvas when a stamp is chosen (src/components/stamps/StampMaker.tsx) and stores the
// result as a transparent PNG. The tests run the same functions on pixels they make (tests/stamps.test.ts).
//
// The steps, in order:
//  1. Paper goes. The paper's colour is worked out for every part of the picture on its own (paperOf), so uneven
//     light, a hard shadow, grey or coloured paper (brown kraft, yellow copy paper) count as paper too. One cut for
//     the whole picture would take the ink out where the light is bright and leave the paper in where it is dark.
//     A desk around the sheet, a table at the edge, the ruled lines of lined paper and sensor noise go as well.
//  2. What is left is ink. A design prints solid, as rubber does: a tinted fill becomes full ink. A photo keeps the
//     unevenness of the real impression it shows, and a faint stamp is brought up part by part, so small print in it
//     stays. A thin line stays thin.
//  3. One ink colour, as a real stamp has. The likely ink is read from the picture (findInk) and offered first.
//     Marks in another colour (printed black text beside a blue stamp in a photo) can be left out (onlyInk). In a
//     design with several colours (a logo) every mark is kept, with a thin gap of paper where two colours meet, so
//     the shapes stay apart in one ink (colourGaps).
//  4. A rubber stamp's impression, sized in millimetres at the size it prints, so it still shows at 150 pixels on a
//     screen and in a PDF: one side pressed harder than the other, a few patches short of ink, paper grain, small
//     voids, rough edges with a little ink spread, ink squeezed to the edges of each stroke so the rims are darker,
//     and a colour that varies a little, as stamp pad ink does. Never so much that the words in it stop being
//     readable at the size it is printed.
//  5. Trimmed to the ink, with a small margin. A round seal photographed at a slant can be made round again.
// The small natural tilt is not drawn into the picture: the page turns the picture when it prints it, on screen and
// in the signed PDF (the stamp's "turn"), so the stamp keeps the exact size the sender gave its field.
// Everything that varies comes from one seed, which is stored with the stamp: the same seed and settings give the
// same impression every time. Nothing here uses Math.random.

import { STAMP_OUT_MAX_SIDE, STAMP_DEFAULT_MM } from './stamps.ts';

export type Rgba = { width: number; height: number; data: Uint8ClampedArray | Uint8Array };
/** One number from 0 to 1 per pixel: how much ink is there. */
export type Plane = { width: number; height: number; v: Float32Array };

export const INKS = ['blue', 'red', 'purple', 'black', 'green'] as const;
export type Ink = (typeof INKS)[number];
/**
 * Stamp pad inks at full strength: dull, dark colours, as a pad prints them, not screen colours. Printed at
 * STAMP_OPACITY over white they land on blue-violet about (40,44,128), a warm dull red towards vermilion (about
 * 188,46,40, as seal paste and red pad ink print, not a pink carmine), a dull red-violet (85,40,110), blue-black
 * (35,36,48) and a dull green. One colour per ink: where a stamp is short of ink it prints less of it (the paper
 * shows through), never a paler or cooler tint of it.
 */
export const INK_RGB: Record<Ink, [number, number, number]> = {
  blue: [33, 37, 124],
  red: [182, 40, 34],
  purple: [80, 34, 104],
  black: [29, 30, 42],
  green: [24, 88, 56],
};
export const INK_WORD: Record<Ink, string> = { blue: 'Blue', red: 'Red', purple: 'Purple', black: 'Black', green: 'Green' };
export const isInk = (s: any): s is Ink => (INKS as readonly string[]).includes(s);

export type Look = {
  ink: Ink;
  /** Decides the texture and the tilt. A whole number from 1 to 2147483646. */
  seed: number;
  /** Degrees, from -TILT_MAX to TILT_MAX. 0 is straight. */
  tilt: number;
  /** 0 is perfectly even ink, 1 is a well-worn stamp. */
  texture: number;
  /** How much counts as paper: 0 keeps faint marks, 1 takes more away. */
  paper: number;
  /** Keep only marks in the colour of the chosen ink, or of the ink that was found (only when that is not black). */
  onlyInk: boolean;
  /** Edges taken off before anything else, as shares of the width and height. */
  crop?: { left: number; top: number; right: number; bottom: number };
  /** A thin gap of paper where two colours of a design meet, so a logo's shapes stay apart in one ink. */
  gaps?: boolean;
  /** A round seal that came out as an oval (a photo taken at a slant) is made round again. */
  round?: boolean;
};
export const TILT_MAX = 4;
export const DEFAULT_TEXTURE = 0.5;
export const DEFAULT_PAPER = 0.5;

// ---- Numbers from a seed -------------------------------------------------------------------------------------

/** mulberry32: a small generator that gives the same numbers for the same seed everywhere. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const validSeed = (n: any): boolean => Number.isInteger(n) && n >= 1 && n <= 2147483646;
/** The smallest natural tilt a seed gives: a hand never sets a stamp down quite straight. */
export const TILT_MIN = 1.5;
/** The natural tilt for a seed: between 1.5 and 4 degrees either way, in tenths. */
export function tiltFor(seed: number): number {
  const r = rng(seed ^ 0x5bd1e995);
  r();
  const t = Math.round((TILT_MIN + r() * (TILT_MAX - TILT_MIN)) * 10) / 10;
  return r() < 0.5 ? -t : t;
}
/**
 * The settings a new impression starts with. Given what was found in the picture: a photo leaves out marks in other
 * colours (printed text around the stamp) and makes an oval seal round again; a design keeps every mark, and a
 * design in several colours (a logo) gets a thin gap where two colours meet. Nothing of a design is left out unasked.
 */
export function lookFor(seed: number, ink: Ink = 'blue', p?: { photo: boolean; found: InkFound }): Look {
  const photo = p ? p.photo : true;
  return { ink, seed, tilt: tiltFor(seed), texture: DEFAULT_TEXTURE, paper: DEFAULT_PAPER, onlyInk: photo, gaps: !!p && !photo && p.found.several, round: photo };
}

// ---- 1. Paper ------------------------------------------------------------------------------------------------

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const smooth = (lo: number, hi: number, x: number) => {
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};
const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const sat = (r: number, g: number, b: number) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx <= 0 ? 0 : (mx - mn) / mx;
};
/** Where a colour sits apart from how light it is: red and green as shares of the whole. */
const chroma = (r: number, g: number, b: number): [number, number] => {
  const s = r + g + b + 1e-6;
  return [r / s, g / s];
};

// ---- Tools on planes of numbers ------------------------------------------------------------------------------

/** A running box average along rows (horizontal) or columns, radius r, edges repeated. */
function boxPass(src: Float32Array, w: number, h: number, r: number, horizontal: boolean): Float32Array {
  const out = new Float32Array(src.length);
  const n = horizontal ? w : h, lines = horizontal ? h : w;
  const at = (line: number, i: number) => src[horizontal ? line * w + Math.min(n - 1, Math.max(0, i)) : Math.min(n - 1, Math.max(0, i)) * w + line];
  const d = 2 * r + 1;
  for (let line = 0; line < lines; line++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += at(line, i);
    for (let i = 0; i < n; i++) {
      out[horizontal ? line * w + i : i * w + line] = s / d;
      s += at(line, i + r + 1) - at(line, i - r);
    }
  }
  return out;
}
/** A soft blur close to a gaussian of `sigma` pixels: three box averages each way. */
export function blurPlane(v: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return new Float32Array(v);
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
  let out = v;
  for (let k = 0; k < 3; k++) out = boxPass(boxPass(out, w, h, r, true), w, h, r, false);
  return out;
}
/** The largest (or smallest) value within r pixels along rows, then along columns: a square window. */
function extremePlane(v: Float32Array, w: number, h: number, r: number, largest: boolean): Float32Array {
  const pick = largest ? Math.max : Math.min;
  const pass = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(src.length);
    const n = horizontal ? w : h, lines = horizontal ? h : w;
    const idx = (line: number, i: number) => (horizontal ? line * w + i : i * w + line);
    // van Herk / Gil-Werman: blocks of 2r+1, a running extreme from each side of a block.
    const k = 2 * r + 1;
    const fw = new Float32Array(n + 2 * r), bw = new Float32Array(n + 2 * r);
    const pad = largest ? -Infinity : Infinity;
    for (let line = 0; line < lines; line++) {
      const m = n + 2 * r;
      for (let i = 0; i < m; i++) {
        const j = i - r;
        const x = j < 0 || j >= n ? pad : src[idx(line, j)];
        fw[i] = i % k === 0 ? x : pick(fw[i - 1], x);
      }
      for (let i = m - 1; i >= 0; i--) {
        const j = i - r;
        const x = j < 0 || j >= n ? pad : src[idx(line, j)];
        bw[i] = i === m - 1 || (i + 1) % k === 0 ? x : pick(bw[i + 1], x);
      }
      for (let i = 0; i < n; i++) out[idx(line, i)] = pick(bw[i], fw[i + 2 * r]);
    }
    return out;
  };
  return pass(pass(v, true), false);
}
/** How far each pixel of a mark is from the nearest pixel that is not, in pixels (3-4 chamfer, close to round). */
function insideDistance(on: Uint8Array, w: number, h: number): Float32Array {
  const BIG = 1e9;
  const d = new Float32Array(w * h);
  for (let p = 0; p < d.length; p++) d[p] = on[p] ? BIG : 0;
  const get = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!d[p]) continue;
      d[p] = Math.min(d[p], get(x - 1, y) + 3, get(x, y - 1) + 3, get(x - 1, y - 1) + 4, get(x + 1, y - 1) + 4);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      if (!d[p]) continue;
      d[p] = Math.min(d[p], get(x + 1, y) + 3, get(x, y + 1) + 3, get(x + 1, y + 1) + 4, get(x - 1, y + 1) + 4);
    }
  for (let p = 0; p < d.length; p++) d[p] /= 3;
  return d;
}
/** The middle value of each pixel and its eight neighbours: takes out the speckle of a noisy photo, keeps edges. */
function median3(v: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(v.length);
  const a = new Float32Array(9);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) a[k++] = v[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
      a.sort();
      out[y * w + x] = a[4];
    }
  return out;
}
/** The pieces of a mark, joined pixel to neighbouring pixel: a number for each pixel (0 is none) and each piece's size. */
function pieces(on: Uint8Array, w: number, h: number): { label: Int32Array; size: number[] } {
  const label = new Int32Array(w * h);
  const size = [0];
  const stack: number[] = [];
  for (let s = 0; s < on.length; s++) {
    if (!on[s] || label[s]) continue;
    const id = size.length;
    let n = 0;
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      n++;
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (on[q] && !label[q]) (label[q] = id, stack.push(q));
        }
    }
    size.push(n);
  }
  return { label, size };
}

/** A picture with any transparency laid on white first: a design saved with a see-through background has white paper. */
export function onWhite(img: Rgba): Rgba {
  const d = img.data;
  let any = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { any = true; break; }
  if (!any) return img;
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = d[i] * a + 255 * (1 - a);
    out[i + 1] = d[i + 1] * a + 255 * (1 - a);
    out[i + 2] = d[i + 2] * a + 255 * (1 - a);
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

/**
 * The colour of the paper at every pixel, as RGB. The picture is cut into blocks. In each block the brightest pixels
 * are taken as its paper. A block whose "paper" is coloured or much darker than the paper elsewhere is mostly ink
 * (the inside of a solid seal), so its paper is filled in from the blocks around it. Then the blocks are blended
 * smoothly into each other, so light that changes across the picture is followed.
 */
export function paperOf(img: Rgba): Uint8ClampedArray {
  const { width: w, height: h, data: d } = img;
  const B = Math.max(8, Math.min(64, Math.round(Math.max(w, h) / 20)));
  const gw = Math.ceil(w / B), gh = Math.ceil(h / B);
  const col = new Float32Array(gw * gh * 3);
  const L = new Float32Array(gw * gh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < gh; by++)
    for (let bx = 0; bx < gw; bx++) {
      hist.fill(0);
      const x0 = bx * B, y0 = by * B, x1 = Math.min(w, x0 + B), y1 = Math.min(h, y0 + B);
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          hist[Math.round(lum(d[i], d[i + 1], d[i + 2]))]++;
          n++;
        }
      // The brightest 15 percent of the block is its paper.
      let want = Math.max(1, Math.round(n * 0.15)), cut = 255;
      for (; cut > 0; cut--) if ((want -= hist[cut]) <= 0) break;
      let r = 0, g = 0, b = 0, m = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          if (lum(d[i], d[i + 1], d[i + 2]) >= cut - 0.5) (r += d[i], g += d[i + 1], b += d[i + 2], m++);
        }
      const k = by * gw + bx;
      col[k * 3] = r / m;
      col[k * 3 + 1] = g / m;
      col[k * 3 + 2] = b / m;
      L[k] = lum(r / m, g / m, b / m);
    }
  // The paper's own colour, apart from how much light falls on it: the colour most blocks have, among blocks that
  // are not strongly coloured. White, grey, brown kraft and yellow copy paper all count; the saturated colour of
  // ink does not. A shadow or dim light makes paper darker but leaves this colour as it is.
  const cand = [...L.keys()].filter((k) => sat(col[k * 3], col[k * 3 + 1], col[k * 3 + 2]) < 0.62 && L[k] > 40);
  const bins = new Float32Array(50 * 50);
  for (const k of cand) {
    const [cr, cg] = chroma(col[k * 3], col[k * 3 + 1], col[k * 3 + 2]);
    bins[Math.min(49, Math.floor(cr * 50)) * 50 + Math.min(49, Math.floor(cg * 50))] += 0.5 + L[k] / 255;
  }
  let best = -1, bestAt = 0;
  for (let i = 0; i < 50; i++)
    for (let j = 0; j < 50; j++) {
      let s = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (i + di >= 0 && j + dj >= 0 && i + di < 50 && j + dj < 50) s += bins[(i + di) * 50 + j + dj];
      if (s > best) (best = s, bestAt = i * 50 + j);
    }
  const pc: [number, number] = [(Math.floor(bestAt / 50) + 0.5) / 50, ((bestAt % 50) + 0.5) / 50];
  const neutralPaper = Math.hypot(pc[0] - 1 / 3, pc[1] - 1 / 3) < 0.04;
  const paperColoured = (k: number) => {
    const [cr, cg] = chroma(col[k * 3], col[k * 3 + 1], col[k * 3 + 2]);
    if (Math.hypot(cr - pc[0], cg - pc[1]) < 0.05) return true;
    // Light of another colour on part of the sheet (warm on one side, cool on the other) still leaves white or grey
    // paper with little colour.
    return neutralPaper && sat(col[k * 3], col[k * 3 + 1], col[k * 3 + 2]) < 0.3;
  };
  // How bright the paper is where it is brightest: the upper quarter of the blocks that look like paper.
  const papery = cand.filter(paperColoured).map((k) => L[k]).sort((a, b) => a - b);
  const top = papery.length ? papery[Math.floor(papery.length * 0.75)] : 255;
  // A block is paper when its brightest part has the paper's colour, and it is either not much darker than the
  // paper where it is brightest, or about as bright as the blocks right next to it: a shadow or dim light changes
  // smoothly from block to block, while the inside of a solid stamp is much darker than the paper beside it.
  // Nothing very dark is paper, however smooth.
  const known = new Uint8Array(gw * gh);
  for (let by = 0; by < gh; by++)
    for (let bx = 0; bx < gw; bx++) {
      const k = by * gw + bx;
      let near = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = bx + dx, y = by + dy;
          if ((dx || dy) && x >= 0 && y >= 0 && x < gw && y < gh) near = Math.max(near, L[y * gw + x]);
        }
      known[k] = paperColoured(k) && L[k] > top * 0.3 && (L[k] >= top * 0.55 || L[k] >= near * 0.85) ? 1 : 0;
    }
  if (!known.some((x) => x)) {
    // No block looks like paper at all (the stamp fills the picture): white.
    col.fill(255);
    known.fill(1);
  }
  // Blocks that are mostly ink take the paper of their neighbours, one ring at a time.
  for (let pass = 0; pass < gw + gh && known.some((x) => !x); pass++) {
    const next = known.slice();
    for (let by = 0; by < gh; by++)
      for (let bx = 0; bx < gw; bx++) {
        const k = by * gw + bx;
        if (known[k]) continue;
        let r = 0, g = 0, b = 0, m = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = bx + dx, y = by + dy;
            if (x < 0 || y < 0 || x >= gw || y >= gh || !known[y * gw + x]) continue;
            const j = y * gw + x;
            r += col[j * 3], g += col[j * 3 + 1], b += col[j * 3 + 2], m++;
          }
        if (m) (col[k * 3] = r / m, col[k * 3 + 1] = g / m, col[k * 3 + 2] = b / m, next[k] = 1);
      }
    known.set(next);
  }
  // Each block blended with the blocks around it, so no edge between blocks shows.
  const soft = new Float32Array(col.length);
  for (let by = 0; by < gh; by++)
    for (let bx = 0; bx < gw; bx++)
      for (let c = 0; c < 3; c++) {
        let s = 0, m = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = bx + dx, y = by + dy;
            if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
            const wgt = dx === 0 && dy === 0 ? 2 : 1;
            s += col[(y * gw + x) * 3 + c] * wgt;
            m += wgt;
          }
        soft[(by * gw + bx) * 3 + c] = s / m;
      }
  // Every pixel between the centres of the four blocks around it.
  const out = new Uint8ClampedArray(w * h * 3);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / B - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const a = soft[(y0 * gw + x0) * 3 + c] * (1 - tx) + soft[(y0 * gw + x1) * 3 + c] * tx;
        const b = soft[(y1 * gw + x0) * 3 + c] * (1 - tx) + soft[(y1 * gw + x1) * 3 + c] * tx;
        out[(y * w + x) * 3 + c] = a * (1 - ty) + b * ty;
      }
    }
  }
  return followShadows(img, out);
}

/**
 * Blocks blended smoothly into each other cannot follow the sharp edge of a shadow: next to the edge the paper in
 * the shadow would count as ink (a dark streak) and ink under the shadow would fade. So the paper is also worked out
 * from the picture itself, on a smaller copy: each colour at its lightest within a window wider than any stroke
 * (which takes the strokes away), then at its darkest within the same window (which puts the edge of a shadow back
 * where it was). Where that comes out with the paper's colour and not much darker than the paper from the blocks,
 * it is the paper; inside a solid area of ink (a different colour, or much darker) the blocks are kept.
 */
function followShadows(img: Rgba, block: Uint8ClampedArray): Uint8ClampedArray {
  const { width: w, height: h, data: d } = img;
  const k = Math.min(1, 480 / Math.max(w, h));
  if (k >= 1 && Math.max(w, h) < 120) return block;
  const sw = Math.max(1, Math.round(w * k)), sh = Math.max(1, Math.round(h * k));
  const fx = w / sw, fy = h / sh;
  const ch: Float32Array[] = [0, 1, 2].map(() => new Float32Array(sw * sh));
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx)), y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          (r += d[i]), (g += d[i + 1]), (b += d[i + 2]), n++;
        }
      ch[0][y * sw + x] = r / n;
      ch[1][y * sw + x] = g / n;
      ch[2][y * sw + x] = b / n;
    }
  const R = Math.max(2, Math.round(Math.max(sw, sh) * 0.03));
  const closed = ch.map((c) => extremePlane(extremePlane(c, sw, sh, R, true), sw, sh, R, false));
  const out = new Uint8ClampedArray(block.length);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(sh - 1, Math.max(0, (y + 0.5) / fy - 0.5));
    const y0 = Math.floor(gy), y1 = Math.min(sh - 1, y0 + 1), ty = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(sw - 1, Math.max(0, (x + 0.5) / fx - 0.5));
      const x0 = Math.floor(gx), x1 = Math.min(sw - 1, x0 + 1), tx = gx - x0;
      const at = (c: number) => (closed[c][y0 * sw + x0] * (1 - tx) + closed[c][y0 * sw + x1] * tx) * (1 - ty) + (closed[c][y1 * sw + x0] * (1 - tx) + closed[c][y1 * sw + x1] * tx) * ty;
      const j = (y * w + x) * 3;
      const r = at(0), g = at(1), b = at(2);
      const lb = lum(block[j], block[j + 1], block[j + 2]), lf = lum(r, g, b);
      const [c1, c2] = chroma(r, g, b), [b1, b2] = chroma(block[j], block[j + 1], block[j + 2]);
      const paperLike = lf >= lb * 0.42 && lf <= lb * 1.2 && Math.hypot(c1 - b1, c2 - b2) < 0.045;
      if (paperLike) (out[j] = r, out[j + 1] = g, out[j + 2] = b);
      else (out[j] = block[j], out[j + 1] = block[j + 1], out[j + 2] = block[j + 2]);
    }
  }
  return out;
}

/**
 * How far each pixel is from its paper, from 0 (paper) to 1: the share of the paper's own light the ink takes away,
 * by channel, weighted the way the eye weighs them. A share, not an amount: where the light is dim, the paper and
 * the ink are both darker, and the ink still takes the same share. Lighter than the paper (a glare) counts as paper.
 */
export function inkDistance(img: Rgba, paper: Uint8ClampedArray): Float32Array {
  const { width: w, height: h, data: d } = img;
  const out = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4, j = p * 3;
    const take = (c: number) => Math.max(0, 1 - d[i + c] / Math.max(24, paper[j + c]));
    const r = take(0), g = take(1), b = take(2);
    out[p] = Math.sqrt(0.3 * r * r + 0.59 * g * g + 0.11 * b * b);
  }
  return out;
}

/**
 * Where paper ends and ink starts, read from the picture: `base` is the cut that best splits the picture into two
 * groups (paper and ink, by Otsu's method), so a faint stamp gets a lower cut than a dark one; `floor` is just above
 * the paper's own grain and noise, so they never count as ink. `design`: a clean design, printed solid like rubber.
 */
export type Cut = { base: number; floor: number; design: boolean };
export const DEFAULT_CUT: Cut = { base: 0.26, floor: 0.06, design: false };

export function cutOf(dist: Float32Array, photo: boolean): Cut {
  const N = 200;
  const hist = new Float64Array(N);
  for (let i = 0; i < dist.length; i++) hist[Math.min(N - 1, Math.floor(dist[i] * N))]++;
  let total = 0, sum = 0;
  for (let i = 0; i < N; i++) (total += hist[i], sum += i * hist[i]);
  let wB = 0, sB = 0, best = -1, t = 0.26 * N;
  for (let i = 0; i < N; i++) {
    wB += hist[i];
    if (!wB || wB === total) continue;
    sB += i * hist[i];
    const mB = sB / wB, mF = (sum - sB) / (total - wB);
    const between = wB * (total - wB) * (mB - mF) * (mB - mF);
    if (between > best) (best = between, t = i + 1);
  }
  const base = Math.min(0.4, Math.max(0.08, t / N));
  // The paper's own grain: what the lighter half below the cut reaches, at its 98th percentile.
  let n = 0, k = 0;
  for (let i = 0; i < Math.floor(base * 0.5 * N); i++) n += hist[i];
  let f = 0;
  for (let i = 0; i < N; i++) {
    k += hist[i];
    if (k >= n * 0.98) {
      f = (i + 1) / N;
      break;
    }
  }
  return { base, floor: Math.min(base * 0.8, Math.max(0.035, f + 0.025)), design: !photo };
}

/** The cut between paper and ink for a "paper" setting from 0 to 1: below lo is paper, above hi is full ink. */
export const paperCut = (paper: number, cut: Cut = DEFAULT_CUT) => {
  const lo = Math.max(cut.floor, cut.base * (0.55 + clamp01(paper) * 0.6));
  // Rubber prints a mark or does not: in a design, anything clearly a mark is full ink and only the soft edges of
  // shapes stay partial. A photo keeps the unevenness of the impression it shows.
  return { lo, hi: lo + (cut.design ? 0.1 : 0.3) };
};

/**
 * Ink strength per pixel from its distance to the paper. In a photo (`cut.design` false) the cut is also set for each
 * small part of the picture (about a hundredth of it each way, a millimetre or so of the stamp) from the strongest
 * ink in it: a lightly inked corner, or small print that the camera blurred to a faint line, is cut lower than the
 * heavy ring, so it is kept, even right under a line of large letters. Never below the paper's own grain
 * (`cut.floor`).
 */
export function strengthOf(dist: Float32Array, width: number, height: number, paper = DEFAULT_PAPER, cut: Cut = DEFAULT_CUT): Plane {
  const { lo, hi } = paperCut(paper, cut);
  const v = new Float32Array(dist.length);
  if (cut.design) {
    for (let i = 0; i < dist.length; i++) v[i] = smooth(lo, hi, dist[i]);
    return { width, height, v };
  }
  const w = width, h = height;
  const B = Math.max(6, Math.round(Math.max(w, h) * 0.011));
  const gw = Math.ceil(w / B), gh = Math.ceil(h / B);
  const top = new Float32Array(gw * gh);
  const hist = new Uint32Array(100);
  for (let by = 0; by < gh; by++)
    for (let bx = 0; bx < gw; bx++) {
      hist.fill(0);
      let n = 0;
      for (let y = by * B; y < Math.min(h, by * B + B); y++)
        for (let x = bx * B; x < Math.min(w, bx * B + B); x++) (hist[Math.min(99, Math.floor(dist[y * w + x] * 100))]++, n++);
      let want = Math.max(1, Math.round(n * 0.03)), i = 99;
      for (; i > 0; i--) if ((want -= hist[i]) <= 0) break;
      top[by * gw + bx] = (i + 0.5) / 100;
    }
  const near = new Float32Array(gw * gh);
  for (let by = 0; by < gh; by++)
    for (let bx = 0; bx < gw; bx++) {
      // A part with only paper in it takes some of the ink beside it, so the soft edge of a stroke is not cut lower.
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (by + dy >= 0 && bx + dx >= 0 && by + dy < gh && bx + dx < gw) m = Math.max(m, top[(by + dy) * gw + bx + dx]);
      near[by * gw + bx] = Math.max(top[by * gw + bx], 0.35 * m);
    }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / B - 0.5)), y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / B - 0.5)), x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      const t = (near[y0 * gw + x0] * (1 - tx) + near[y0 * gw + x1] * tx) * (1 - ty) + (near[y1 * gw + x0] * (1 - tx) + near[y1 * gw + x1] * tx) * ty;
      const l = Math.max(cut.floor, Math.min(lo, 0.4 * t));
      v[y * w + x] = smooth(l, Math.max(l + 0.04, Math.min(hi, 0.8 * t)), dist[y * w + x]);
    }
  }
  return { width, height, v };
}

/**
 * What is around the sheet in a photo (a desk, a table, the floor) is set to paper. It is found by flooding in from
 * the edges of the picture over smooth areas that are not paper, cell by cell on a smaller copy. The strokes of a
 * stamp are never smooth at that scale, so the flood stops at them. Only when an open sheet is left inside: a seal
 * that fills the picture to its edges is not taken for a desk.
 */
export function offSheet(dist: Float32Array, w: number, h: number, floor: number): Float32Array {
  const k = Math.min(1, 400 / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * k)), sh = Math.max(1, Math.round(h * k));
  const sum = new Float32Array(sw * sh), sq = new Float32Array(sw * sh), cnt = new Float32Array(sw * sh);
  const cellOf = (x: number, y: number) => Math.min(sh - 1, Math.floor(y * k)) * sw + Math.min(sw - 1, Math.floor(x * k));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = cellOf(x, y), d = dist[y * w + x];
      (sum[c] += d), (sq[c] += d * d), cnt[c]++;
    }
  const cand = new Uint8Array(sw * sh);
  for (let c = 0; c < cand.length; c++) {
    if (!cnt[c]) continue;
    const m = sum[c] / cnt[c], sd = Math.sqrt(Math.max(0, sq[c] / cnt[c] - m * m));
    cand[c] = m > Math.max(0.08, floor * 1.5) && sd < 0.06 ? 1 : 0;
  }
  const flood = new Uint8Array(sw * sh);
  const stack: number[] = [];
  const start = (c: number) => cand[c] && !flood[c] && (flood[c] = 1, stack.push(c));
  for (let x = 0; x < sw; x++) (start(x), start((sh - 1) * sw + x));
  for (let y = 0; y < sh; y++) (start(y * sw), start(y * sw + sw - 1));
  while (stack.length) {
    const c = stack.pop()!;
    const x = c % sw, y = (c - x) / sw;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < sw && ny < sh) start(ny * sw + nx);
      }
  }
  if (!flood.some((f) => f)) return dist;
  const open = new Uint8Array(sw * sh);
  for (let c = 0; c < open.length; c++) open[c] = flood[c] ? 0 : 1;
  const room = insideDistance(open, sw, sh);
  let most = 0;
  for (let c = 0; c < room.length; c++) most = Math.max(most, room[c]);
  if (most < 0.12 * Math.min(sw, sh)) return dist;
  // One cell more all round, for the shadow along the edge of the sheet.
  const wide = extremePlane(Float32Array.from(flood), sw, sh, 1, true);
  const out = new Float32Array(dist);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (wide[cellOf(x, y)]) out[y * w + x] = 0;
  return out;
}

/**
 * A photo, not a clean design: the paper has grain or noise, or the light on it changes across the picture, or it is
 * simply not of one flat colour. A design exported from a program has paper of exactly one colour almost everywhere;
 * even a clean photo of glossy or smooth paper, with little grain, has paper that varies by a few steps, and a glare
 * or a shadow across it.
 */
export function isPhoto(img: Rgba, paper: Uint8ClampedArray, dist: Float32Array): boolean {
  const { width: w, height: h, data: d } = img;
  let n = 0, s = 0;
  const hist = new Uint32Array(256);
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w - 1; x += 2) {
      const p = y * w + x;
      if (dist[p] >= 0.04 || dist[p + 1] >= 0.04) continue;
      const l = lum(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]);
      hist[Math.round(l)]++;
      s += Math.abs(l - lum(d[p * 4 + 4], d[p * 4 + 5], d[p * 4 + 6]));
      n++;
    }
  // How much of the paper is within a step or two of its most common shade.
  let mode = 0;
  for (let i = 1; i < 256; i++) if (hist[i] > hist[mode]) mode = i;
  let flat = 0;
  for (let i = Math.max(0, mode - 2); i <= Math.min(255, mode + 2); i++) flat += hist[i];
  if (n > 200 && flat < n * 0.6) return true;
  const L: number[] = [];
  for (let p = 0; p < w * h; p += 97) L.push(lum(paper[p * 3], paper[p * 3 + 1], paper[p * 3 + 2]));
  L.sort((a, b) => a - b);
  const range = L.length ? L[Math.floor(L.length * 0.95)] - L[Math.floor(L.length * 0.05)] : 0;
  return (n > 50 && s / n > 0.8) || range > 14;
}

/** A long thin straight line across a photo, as the rows of lined paper are: where it runs, and how thick it is. */
export type Rule = { cos: number; sin: number; rho: number; half: number };

/**
 * The ruled lines of lined paper in a photo: four or more long, thin, parallel lines at an even spacing, nearly level,
 * each running across at least two fifths of the picture. Found by voting: every thin dark line pixel votes for the
 * lines through it at each angle from -12 to 12 degrees, and the angle whose votes pile up the most is the paper's.
 * One long line on its own (the frame of a box stamp, a line of a form) is never taken for ruling.
 */
export function ruledLines(dist: Float32Array, w: number, h: number): Rule[] {
  const r = Math.max(2, Math.round(Math.max(w, h) / 320));
  const pts: number[] = [];
  for (let y = r; y < h - r; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x, v = dist[p];
      if (v < 0.035) continue;
      if (dist[p - r * w] < v * 0.5 && dist[p + r * w] < v * 0.5) pts.push(x, y);
    }
  if (pts.length < w) return [];
  const angles: number[] = [];
  for (let a = -12; a <= 12.001; a += 0.25) angles.push((a * Math.PI) / 180);
  const off = Math.ceil(w * Math.sin((12 * Math.PI) / 180)) + 2;
  const size = h + 2 * off;
  let bestScore = -1, bestA = 0, bestAcc: Float32Array | null = null;
  for (const a of angles) {
    const c = Math.cos(a), s = Math.sin(a);
    const acc = new Float32Array(size);
    for (let i = 0; i < pts.length; i += 2) {
      const b = Math.round(pts[i + 1] * c - pts[i] * s) + off;
      if (b >= 0 && b < size) acc[b]++;
    }
    let score = 0;
    for (let b = 0; b < size; b++) score += acc[b] * acc[b];
    if (score > bestScore) (bestScore = score, bestA = a, bestAcc = acc);
  }
  if (!bestAcc) return [];
  const need = w * 0.4;
  const lines: { rho: number; half: number }[] = [];
  for (let b = 0; b < size; ) {
    // A line: a few neighbouring rows of votes, together long enough.
    if (bestAcc[b] < need * 0.15) {
      b++;
      continue;
    }
    let e = b, votes = 0, mid = 0;
    while (e < size && e - b < 3 * r && bestAcc[e] >= need * 0.15) (votes += bestAcc[e], mid += e * bestAcc[e], e++);
    if (votes >= need && e - b <= 3 * r) lines.push({ rho: mid / votes - off, half: (e - b) / 2 + 0.5 });
    b = e;
  }
  if (lines.length < 4) return [];
  const gaps = lines.slice(1).map((l, i) => l.rho - lines[i].rho).sort((a, b) => a - b);
  const m = gaps[Math.floor(gaps.length / 2)];
  const even = gaps.filter((g) => [1, 2, 3].some((k) => Math.abs(g - k * m) < m * 0.2)).length;
  if (m < 4 * r || even < gaps.length * 0.7) return [];
  return lines.map((l) => ({ cos: Math.cos(bestA), sin: Math.sin(bestA), rho: l.rho, half: l.half }));
}

/** Every pixel within `T` of a line (in normal form, bent by `off` along it): its place along the line and across it. */
function alongLine(l: Rule, w: number, h: number, T: number, off: (s: number) => number, fn: (x: number, y: number, s: number, t: number) => void) {
  const nx = -l.sin, ny = l.cos, ux = l.cos, uy = l.sin;
  if (Math.abs(ny) >= Math.abs(nx)) {
    for (let x = 0; x < w; x++) {
      // y where the line crosses this column, then the rows within T across it.
      const s0 = x * ux + ((l.rho - x * nx) / ny) * uy;
      const yc = (l.rho + off(s0) - x * nx) / ny;
      const reach = T / Math.abs(ny) + 1;
      for (let y = Math.max(0, Math.floor(yc - reach)); y <= Math.min(h - 1, Math.ceil(yc + reach)); y++) {
        const s = x * ux + y * uy, t = x * nx + y * ny - l.rho - off(s);
        if (Math.abs(t) <= T) fn(x, y, s, t);
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const s0 = ((l.rho - y * ny) / nx) * ux + y * uy;
      const xc = (l.rho + off(s0) - y * ny) / nx;
      const reach = T / Math.abs(nx) + 1;
      for (let x = Math.max(0, Math.floor(xc - reach)); x <= Math.min(w - 1, Math.ceil(xc + reach)); x++) {
        const s = x * ux + y * uy, t = x * nx + y * ny - l.rho - off(s);
        if (Math.abs(t) <= T) fn(x, y, s, t);
      }
    }
  }
}

/**
 * The picture with long thin lines painted out (the ruled lines of lined paper, the crease of a fold) without taking
 * any of the stamp's ink with them. Each line's own profile across it is measured where it runs over paper: how much
 * light it takes away (or adds, on the bright side of a crease) at each distance from its middle, in each colour,
 * following the line where it runs a little off straight. Every pixel on the line is then divided by that profile.
 * Paper under a line comes back as paper. Ink that crosses a line, runs along it or touches it comes back as ink,
 * because only the line's own share of the light is given back: the bar of an E lying on a rule and a ring running
 * along one stay whole, and a stroke crossing it has no gap.
 */
export function unrule(img: Rgba, rules: Rule[]): Rgba {
  const { width: w, height: h } = img;
  const src = img.data;
  const d = new Uint8ClampedArray(src);
  const at = (x: number, y: number, c: number) => {
    const x0 = Math.max(0, Math.min(w - 2, Math.floor(x))), y0 = Math.max(0, Math.min(h - 2, Math.floor(y)));
    const tx = Math.max(0, Math.min(1, x - x0)), ty = Math.max(0, Math.min(1, y - y0));
    const i = (y0 * w + x0) * 4 + c;
    return (src[i] * (1 - tx) + src[i + 4] * tx) * (1 - ty) + (src[i + w * 4] * (1 - tx) + src[i + w * 4 + 4] * tx) * ty;
  };
  for (const l of rules) {
    const nx = -l.sin, ny = l.cos, ux = l.cos, uy = l.sin;
    const T = Math.ceil(l.half) + 3;
    const ss = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => x * ux + y * uy);
    const s0 = Math.floor(Math.min(...ss)), s1 = Math.ceil(Math.max(...ss)), ns = s1 - s0 + 1;
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1;
    // The paper on either side at each point along the line, and whether both sides are paper alike.
    const ref = new Float32Array(ns * 3), ok = new Uint8Array(ns);
    const refAt = (k: number, off: number) => {
      const s = s0 + k, cx = (l.rho + off) * nx + s * ux, cy = (l.rho + off) * ny + s * uy;
      const ax = cx + T * nx, ay = cy + T * ny, bx = cx - T * nx, by = cy - T * ny;
      if (!inside(ax, ay) || !inside(bx, by)) return false;
      const A = [0, 1, 2].map((c) => at(ax, ay, c)), B = [0, 1, 2].map((c) => at(bx, by, c));
      const la = lum(A[0], A[1], A[2]), lb = lum(B[0], B[1], B[2]);
      for (let c = 0; c < 3; c++) ref[k * 3 + c] = (A[c] + B[c]) / 2;
      return Math.abs(la - lb) < 0.07 * Math.max(la, lb) && Math.min(la, lb) > 30;
    };
    for (let k = 0; k < ns; k++) ok[k] = refAt(k, 0) ? 1 : 0;
    // Following the line: in stretches of 32 pixels, where its darkness is centred, then one straight fit.
    const xs: number[] = [], ys: number[] = [], ws: number[] = [];
    for (let k0 = 0; k0 < ns; k0 += 32) {
      let sum = 0, mid = 0;
      for (let k = k0; k < Math.min(ns, k0 + 32); k++) {
        if (!ok[k]) continue;
        const s = s0 + k, lr = lum(ref[k * 3], ref[k * 3 + 1], ref[k * 3 + 2]);
        for (let t = -T + 1; t <= T - 1; t += 0.5) {
          const x = (l.rho + t) * nx + s * ux, y = (l.rho + t) * ny + s * uy;
          if (!inside(x, y)) continue;
          const dk = Math.max(0, 1 - lum(at(x, y, 0), at(x, y, 1), at(x, y, 2)) / lr);
          (sum += dk), (mid += dk * t);
        }
      }
      if (sum > 0.5) (xs.push(s0 + k0 + 16), ys.push(mid / sum), ws.push(sum));
    }
    let fa = 0, fb = 0;
    for (let pass = 0; pass < 2 && xs.length >= 3; pass++) {
      let W = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
      xs.forEach((x, i) => {
        if (pass && Math.abs(ys[i] - (fa + fb * x)) > 1) return;
        (W += ws[i]), (Sx += ws[i] * x), (Sy += ws[i] * ys[i]), (Sxx += ws[i] * x * x), (Sxy += ws[i] * x * ys[i]);
      });
      const den = W * Sxx - Sx * Sx;
      if (W <= 0 || Math.abs(den) < 1e-9) break;
      fb = (W * Sxy - Sx * Sy) / den;
      fa = (Sy - fb * Sx) / W;
    }
    const off = (s: number) => Math.max(-T, Math.min(T, fa + fb * s));
    for (let k = 0; k < ns; k++) ok[k] = refAt(k, off(s0 + k)) ? 1 : 0;
    // The line's profile: the share of the paper's light at each quarter pixel across it, in each colour, the middle
    // value over the whole length where it runs over paper.
    const BIN = 4, nb = 2 * T * BIN + 1;
    const vals: number[][][] = [0, 1, 2].map(() => Array.from({ length: nb }, () => []));
    alongLine(l, w, h, T, off, (x, y, s, t) => {
      const k = Math.round(s - s0);
      if (k < 0 || k >= ns || !ok[k]) return;
      const b = Math.round((t + T) * BIN), i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) vals[c][b].push(src[i + c] / Math.max(1, ref[k * 3 + c]));
    });
    const prof = vals.map((ch) => ch.map((a) => (a.length >= 12 ? a.sort((p, q) => p - q)[a.length >> 1] : 1)));
    const f = (c: number, t: number) => {
      const x = Math.max(0, Math.min(nb - 1, (t + T) * BIN)), i = Math.min(nb - 2, Math.floor(x)), u = x - i;
      return prof[c][i] * (1 - u) + prof[c][i + 1] * u;
    };
    alongLine(l, w, h, T, off, (x, y, s, t) => {
      if (Math.abs(t) > T - 0.5) return;
      const fs = [f(0, t), f(1, t), f(2, t)];
      if (fs.every((v) => Math.abs(v - 1) < 0.015)) return;
      const i = (y * w + x) * 4, k = Math.round(s - s0);
      const o = fs.map((v, c) => Math.min(255, src[i + c] / Math.max(0.05, v)));
      // What is left that is as light as the paper beside it is paper: the paper itself, not a faint trace.
      if (k >= 0 && k < ns && ok[k]) {
        const lr = lum(ref[k * 3], ref[k * 3 + 1], ref[k * 3 + 2]), lo = lum(o[0], o[1], o[2]);
        if (Math.abs(1 - lo / Math.max(1, lr)) < 0.07) for (let c = 0; c < 3; c++) o[c] = ref[k * 3 + c];
      }
      for (let c = 0; c < 3; c++) d[i + c] = o[c];
    });
  }
  return { width: w, height: h, data: d };
}

/**
 * The crease of a folded sheet in a photo: a long, thin, straight line at any angle that is not ink. It is grey (paper
 * in shadow takes light away from every colour alike), thin across its own direction, lighter than print, nearly
 * unbroken, and runs across most of the picture, often with a bright line beside it. A line of the stamp (the frame of
 * a box stamp) ends where the stamp does, and a row of printed text is as tall as its letters, so neither is taken for
 * one. Painted out with the ruled lines (unrule).
 */
export function creases(img: Rgba, paper: Uint8ClampedArray, dist: Float32Array): Rule[] {
  const { width: w, height: h, data: d } = img;
  const r = Math.max(3, Math.round(Math.max(w, h) / 400));
  const cand = new Uint8Array(w * h);
  const pts: number[] = [];
  const dirs = [[r, 0], [0, r], [r, r], [r, -r]];
  for (let y = r; y < h - r; y++)
    for (let x = r; x < w - r; x++) {
      const p = y * w + x, v = dist[p];
      if (v < 0.05 || v > 0.6) continue;
      let mx = 0, mn = 1;
      for (let c = 0; c < 3; c++) {
        const tk = Math.max(0, 1 - d[p * 4 + c] / Math.max(24, paper[p * 3 + c]));
        (mx = Math.max(mx, tk)), (mn = Math.min(mn, tk));
      }
      if (mx - mn > 0.3 * mx + 0.02) continue;
      if (!dirs.some(([dx, dy]) => dist[p + dy * w + dx] < v * 0.5 && dist[p - dy * w - dx] < v * 0.5)) continue;
      cand[p] = 1;
      pts.push(x, y);
    }
  const big = Math.max(w, h);
  if (pts.length < big * 0.4) return [];
  const step = Math.max(1, Math.floor(pts.length / 2 / 60000));
  const NA = 360, diag = Math.ceil(Math.hypot(w, h)), R = 2 * diag + 1;
  const acc = new Int32Array(NA * R);
  const cs = Array.from({ length: NA }, (_, a) => Math.cos((a * Math.PI) / NA)), sn = Array.from({ length: NA }, (_, a) => Math.sin((a * Math.PI) / NA));
  for (let i = 0; i < pts.length; i += 2 * step) {
    const x = pts[i], y = pts[i + 1];
    for (let a = 0; a < NA; a++) acc[a * R + Math.round(y * cs[a] - x * sn[a]) + diag]++;
  }
  // The strongest lines, one at a time, each checked along its whole length.
  const found: Rule[] = [];
  const need = (big * 0.35) / step;
  for (let round = 0; round < 8; round++) {
    let best = 0, at = -1;
    for (let i = 0; i < acc.length; i++) if (acc[i] > best) (best = acc[i], at = i);
    if (best < need) break;
    const a = Math.floor(at / R), rho = (at % R) - diag;
    // Votes near this line are used up, whatever the check says.
    for (let da = -6; da <= 6; da++)
      for (let dr = -8; dr <= 8; dr++) {
        const aa = (a + da + NA) % NA, rr = (da + a < 0 || da + a >= NA ? -rho : rho) + dr + diag;
        if (rr >= 0 && rr < R) acc[aa * R + rr] = 0;
      }
    const l: Rule = { cos: cs[a], sin: sn[a], rho, half: 2 };
    const nx = -l.sin, ny = l.cos, ux = l.cos, uy = l.sin;
    const ss = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => x * ux + y * uy);
    let first = Infinity, last = -Infinity, hits = 0;
    const thinHere = (x: number, y: number) => {
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 6 || yi < 6 || xi >= w - 6 || yi >= h - 6) return false;
      const v = dist[yi * w + xi];
      if (v < 0.05 || v > 0.6) return false;
      const o1 = dist[Math.round(y + 5 * ny) * w + Math.round(x + 5 * nx)], o2 = dist[Math.round(y - 5 * ny) * w + Math.round(x - 5 * nx)];
      return o1 < v * 0.5 && o2 < v * 0.5;
    };
    for (let s = Math.floor(Math.min(...ss)); s <= Math.max(...ss); s++) {
      let hit = false;
      for (let t = -2; t <= 2 && !hit; t++) hit = thinHere(rho * nx + s * ux + t * nx, rho * ny + s * uy + t * ny);
      if (hit) (hits++, (first = Math.min(first, s)), (last = Math.max(last, s)));
    }
    if (last - first >= big * 0.55 && hits >= (last - first) * 0.6) found.push(l);
  }
  return found;
}

/**
 * Leaves out solid dark areas that touch the edge of the picture: in a photo that is the table, the edge of the paper
 * or a shadow, not the stamp. A mark made of lines (the ring of a seal cropped so tightly that it touches the edge)
 * stays, and so does everything when the solid area is nearly all the ink there is (a seal that fills the picture).
 * Small scraps at the edge (the corner of the sheet) go too. Worked out on a smaller copy (at most 400 pixels
 * across), joined the way a mark is: pixel to neighbouring pixel. Only in a photo: a design has nothing around it,
 * so a logo cropped tightly keeps the letter or the disc that touches its edge.
 */
export function dropEdgeMarks(pl: Plane, photo = true): Plane {
  if (!photo) return pl;
  const { width: w, height: h, v } = pl;
  const k = Math.min(1, 400 / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * k)), sh = Math.max(1, Math.round(h * k));
  const on = new Uint8Array(sw * sh);
  const weight = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = v[y * w + x];
      if (s <= 0) continue;
      const j = Math.min(sh - 1, Math.floor(y * k)) * sw + Math.min(sw - 1, Math.floor(x * k));
      weight[j] += s;
      if (s > 0.35) on[j] = 1;
    }
  let total = 0;
  for (let j = 0; j < weight.length; j++) total += weight[j];
  if (total <= 0) return pl;
  // How deep inside a mark each cell is: a desk showing all round the sheet is a frame, which does not fill its box,
  // but it is many times thicker than any stroke of a stamp.
  const depth = insideDistance(on, sw, sh);
  const thick = Math.max(5, Math.min(sw, sh) * 0.035);
  // Each mark that touches the edge, one at a time: its cells, its box, how much ink it holds.
  const seen = new Uint8Array(sw * sh);
  const drop = new Uint8Array(sw * sh);
  let dropped = 0;
  const starts: number[] = [];
  for (let x = 0; x < sw; x++) starts.push(x, (sh - 1) * sw + x);
  for (let y = 0; y < sh; y++) starts.push(y * sw, y * sw + sw - 1);
  for (const s0 of starts) {
    if (!on[s0] || seen[s0]) continue;
    const cells: number[] = [];
    const stack = [s0];
    seen[s0] = 1;
    let x0 = sw, x1 = 0, y0 = sh, y1 = 0, ink = 0, deepest = 0;
    while (stack.length) {
      const j = stack.pop()!;
      cells.push(j);
      const x = j % sw, y = (j - x) / sw;
      x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y);
      ink += weight[j];
      deepest = Math.max(deepest, depth[j]);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          const n = ny * sw + nx;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < sw && ny < sh && on[n] && !seen[n]) (seen[n] = 1, stack.push(n));
        }
    }
    // Solid: it fills much of its own box, or it is far thicker than a stroke (a desk round the sheet). A ring, a
    // line of letters, a frame of lines is neither.
    const solid = (cells.length / ((x1 - x0 + 1) * (y1 - y0 + 1)) > 0.45 && cells.length > 12) || deepest >= thick;
    // A small scrap at the edge (the corner of the sheet, a crumb on the desk) is never the stamp either.
    if (!solid && ink >= total * 0.02) continue;
    for (const j of cells) drop[j] = 1;
    dropped += ink;
  }
  if (!dropped || total - dropped < total * 0.15) return pl;
  const out = new Float32Array(v);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (drop[Math.min(sh - 1, Math.floor(y * k)) * sw + Math.min(sw - 1, Math.floor(x * k))]) out[y * w + x] = 0;
  return { width: w, height: h, v: out };
}

// ---- 3. One ink ----------------------------------------------------------------------------------------------

/**
 * The colour of a pixel as if its paper were pure white (each channel divided by the paper's): its hue, and how much
 * of the light it takes away is colour rather than grey. Measured against how dark the pixel is, not against white:
 * faint violet ink is nearly white, yet what little it takes away is clearly violet, while black ink and printed
 * text take light away evenly.
 */
function inkHue(d: ArrayLike<number>, i: number, paper: Uint8ClampedArray, j: number): { hue: number; s: number } {
  const r = Math.min(1, d[i] / Math.max(1, paper[j])), g = Math.min(1, d[i + 1] / Math.max(1, paper[j + 1])), b = Math.min(1, d[i + 2] / Math.max(1, paper[j + 2]));
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const c = mx - mn;
  const s = c / Math.max(0.08, 1 - mn);
  let hue = 0;
  if (c > 1e-6) hue = mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return { hue: hue * 60, s };
}
/**
 * The pad ink nearest to a hue. Orange and brown have no ink of their own, so they come closest to red, but in a
 * picture they are a colour of their own (findInk keeps them apart from red). Blue-violet pad ink sits at 235 to 255
 * degrees, so blue reaches to 258.
 */
const inkOfHue = (hue: number): Ink => (hue < 60 || hue >= 330 ? 'red' : hue < 170 ? 'green' : hue < 258 ? 'blue' : 'purple');
const COLOURED = 0.2;

/** One colour the marks of a picture are in: its nearest ink, its hue (null for black and grey), its share. */
export type InkColour = { ink: Ink; hue: number | null; share: number };
export type InkFound = {
  /** The ink most of the marks are in. Blue when no ink was found. */
  ink: Ink;
  /** No marks at all: the picture looks like blank paper. */
  empty: boolean;
  /** The marks are in more than one colour (a logo, say): a stamp prints them all in one. */
  several: boolean;
  /** How much of the ink is in the main colour, from 0 to 1. */
  share: number;
  /** The hue of the main colour in degrees, when it is not black. */
  hue: number | null;
  /** Every colour the marks are in, the main one first. Hues within 25 degrees of each other are one colour. */
  colours: InkColour[];
};

/**
 * Which ink the marks are in, weighed by how strong each mark is. Lines and letters count eight times more than the
 * inside of a large fill: the words of a design say what its ink is, not the disc behind its logo. In a photo, black
 * and grey marks are mostly the print of the document the stamp was pressed on, so a colour that holds a fair share
 * of the marks is taken as the stamp's ink even when there is more print.
 */
export function findInk(img: Rgba, paper: Uint8ClampedArray, strength: Plane, photo = false): InkFound {
  const { width: w, height: h } = strength;
  const d = img.data, v = strength.v;
  const r = Math.max(2, Math.round(Math.max(w, h) * 0.008));
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && v[y * w + x] >= 0.5;
  const hist = new Float64Array(72), hx = new Float64Array(72), hy = new Float64Array(72);
  let total = 0, grey = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (v[p] < 0.5) continue;
      const wt = v[p] * (on(x - r, y) && on(x + r, y) && on(x, y - r) && on(x, y + r) ? 0.12 : 1);
      const { hue, s } = inkHue(d, p * 4, paper, p * 3);
      total += wt;
      if (s < COLOURED) {
        grey += wt;
        continue;
      }
      const b = Math.floor(hue / 5) % 72;
      hist[b] += wt;
      hx[b] += wt * Math.cos((hue * Math.PI) / 180);
      hy[b] += wt * Math.sin((hue * Math.PI) / 180);
    }
  if (total < Math.max(12, v.length * 0.0004)) return { ink: 'blue', empty: true, several: false, share: 0, hue: null, colours: [] };
  // Colours one at a time: the strongest hue, with everything within 25 degrees of it, then the next strongest
  // among what is left. A peak first, so orange at 36 degrees and red at 358 stay two colours.
  const used = new Uint8Array(72);
  const colours: InkColour[] = [];
  for (;;) {
    let best = -1, peak = 0;
    for (let b = 0; b < 72; b++) {
      if (used[b]) continue;
      let s = 0;
      for (let k = -1; k <= 1; k++) {
        const j = (b + k + 72) % 72;
        if (!used[j]) s += hist[j];
      }
      if (s > peak) (peak = s, best = b);
    }
    if (best < 0) break;
    let cx = 0, cy = 0, most = 0;
    for (let k = -5; k <= 5; k++) {
      const j = (best + k + 72) % 72;
      if (used[j]) continue;
      (cx += hx[j]), (cy += hy[j]), (most += hist[j]), (used[j] = 1);
    }
    if (most < total * 0.03) continue;
    const hue = ((Math.atan2(cy, cx) * 180) / Math.PI + 360) % 360;
    colours.push({ ink: inkOfHue(hue), hue, share: most / total });
  }
  if (grey > total * 0.03) colours.push({ ink: 'black', hue: null, share: grey / total });
  colours.sort((a, b) => b.share - a.share);
  if (photo && colours[0]?.hue == null) {
    const k = colours.findIndex((c) => c.hue != null && c.share >= 0.12);
    if (k > 0) colours.unshift(...colours.splice(k, 1));
  }
  const main = colours[0] || { ink: 'black' as Ink, hue: null, share: 1 };
  const second = colours[1]?.share ?? 0;
  return { ink: main.ink, empty: false, several: main.share < 0.75 && second > 0.12, share: main.share, hue: main.hue, colours };
}

/**
 * Leaves out marks that are not in the colour of the stamp: printed black text next to a blue stamp in a photo, a
 * red margin line. The colour kept is that of the ink chosen, when the picture has marks in it (a blue stamp on a
 * brown desk keeps the blue even if the desk's brown is the larger colour), or else the main colour found. Never for
 * black: black ink cannot be told apart from black print.
 * Two repairs after that. A light, nearly colourless pixel right beside kept ink (within about half a millimetre) is
 * faint ink of the stamp (thin faint strokes lose their colour in a photo), so it stays; print is dark, so it does not
 * come back that way, and neither does the grey edge of a printed letter. And where printed text crossed a stroke of
 * the stamp, the stroke is drawn on through it: along the direction of the stroke (a row, a column or a diagonal),
 * only across print, never across paper, and only where the stroke is as wide on both sides of the print, so the I
 * of RECEIVED stays an I and two letters beside each other are never joined.
 */
export function onlyInk(img: Rgba, paper: Uint8ClampedArray, strength: Plane, found: InkFound, ink?: Ink): Plane {
  const chosen = ink ? found.colours?.find((c) => c.ink === ink && c.hue != null && c.share >= 0.06) : null;
  const target = chosen ? chosen.hue : found.hue;
  if (target == null) return strength;
  const { width: w, height: h } = strength;
  const d = img.data, before = strength.v, v = new Float32Array(before);
  const keep = new Float32Array(v.length);
  const pale = new Uint8Array(v.length);
  for (let p = 0; p < v.length; p++) {
    if (before[p] <= 0) continue;
    const { hue, s } = inkHue(d, p * 4, paper, p * 3);
    let dh = Math.abs(hue - target) % 360;
    if (dh > 180) dh = 360 - dh;
    keep[p] = smooth(0.12, 0.24, s) * smooth(45, 25, dh);
    pale[p] = s < 0.24 ? 1 : 0;
    v[p] = before[p] * keep[p];
  }
  const kept = new Float32Array(v.length);
  for (let p = 0; p < v.length; p++) kept[p] = v[p] > 0.3 && !pale[p] ? 1 : 0;
  const near = extremePlane(kept, w, h, Math.max(2, Math.round(Math.max(w, h) * 0.005)), true);
  // Print left out: a strong mark that is not the ink. A pale pixel right beside print is the edge of a letter.
  const takeOf = (p: number) => {
    let take = 0;
    for (let c = 0; c < 3; c++) take = Math.max(take, 1 - d[p * 4 + c] / Math.max(24, paper[p * 3 + c]));
    return take;
  };
  const print = new Float32Array(v.length);
  for (let p = 0; p < v.length; p++) print[p] = before[p] >= 0.5 && keep[p] < 0.3 ? 1 : 0;
  const byPrint = extremePlane(print, w, h, 2, true);
  for (let p = 0; p < v.length; p++) {
    if (!pale[p] || !near[p] || byPrint[p]) continue;
    // How dark the pixel is against its paper, whatever the cut: print is dark, faint ink is not.
    if (takeOf(p) < 0.45) v[p] = Math.max(v[p], before[p]);
  }
  // The stroke drawn on through print that crossed it.
  // Print up to R pixels thick is crossed; the stroke itself may be wider than that (a heavy ring), up to `widest`.
  const R = Math.max(4, Math.round(Math.max(w, h) * 0.012)), widest = Math.max(12, Math.round(Math.max(w, h) * 0.035));
  const isKept = (q: number) => keep[q] >= 0.5 && v[q] >= 0.5;
  const filled = new Float32Array(v);
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  // Only print within reach of kept ink can lie across a stroke: the rest of a page of text is skipped.
  const inkMask = new Float32Array(v.length);
  for (let p = 0; p < v.length; p++) inkMask[p] = isKept(p) ? 1 : 0;
  const byInk = extremePlane(inkMask, w, h, R, true);
  // How far the kept ink at (x, y) runs across the direction (dx, dy), each way.
  const across = (x: number, y: number, dx: number, dy: number) => {
    const run = (sx: number, sy: number) => {
      let k = 0;
      for (; k < widest; k++) {
        const nx = x + sx * (k + 1), ny = y + sy * (k + 1);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !isKept(ny * w + nx)) break;
      }
      return k;
    };
    return [run(-dy, dx), run(dy, -dx)];
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!print[p] || !byInk[p]) continue;
      for (const [dx, dy] of dirs) {
        // The nearest kept ink each way along the direction, reached across print only.
        const side = (sx: number, sy: number): [number, number, number] | null => {
          for (let k = 1; k <= R; k++) {
            const nx = x + sx * k, ny = y + sy * k;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) return null;
            const q = ny * w + nx;
            if (isKept(q)) return [nx, ny, k];
            if (!print[q] && before[q] < 0.3) return null;
          }
          return null;
        };
        const A = side(dx, dy), B = side(-dx, -dy);
        if (!A || !B || A[2] + B[2] > R + 1) continue;
        const [a1, a2] = across(A[0], A[1], dx, dy), [b1, b2] = across(B[0], B[1], dx, dy);
        const wa = a1 + a2 + 1, wb = b1 + b2 + 1;
        if (wa >= widest || wb >= widest || Math.abs(wa - wb) > 0.5 * Math.max(wa, wb) + 2) continue;
        // The stroke lies the same way across the line on both sides: it is one stroke going on, not two.
        const tol = 0.35 * Math.max(wa, wb) + 2;
        if (Math.abs(a1 - b1) > tol || Math.abs(a2 - b2) > tol) continue;
        filled[p] = Math.max(filled[p], Math.min(before[p], (v[A[1] * w + A[0]] + v[B[1] * w + B[0]]) / 2));
        break;
      }
    }
  return { width: w, height: h, v: filled };
}

/**
 * A thin gap of paper where two colours of a design meet, `gap` pixels wide, cut out of the lighter of the two. A
 * logo's green leaf on an orange disc would vanish into one solid shape printed in one ink; with the gap it stays a
 * leaf, and its darker vein stays a vein. The soft edge of a shape against the paper is never taken for a colour.
 */
export function colourGaps(img: Rgba, paper: Uint8ClampedArray, strength: Plane, gap: number): Plane {
  const { width: w, height: h } = strength;
  const d = img.data, v = strength.v;
  const n = w * h;
  const A = new Float32Array(n * 3), mag = new Float32Array(n), L = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    let m = 0;
    for (let c = 0; c < 3; c++) {
      const a = Math.max(0, 1 - d[p * 4 + c] / Math.max(24, paper[p * 3 + c]));
      A[p * 3 + c] = a;
      m += a * a;
    }
    mag[p] = Math.sqrt(m);
    L[p] = lum(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]);
  }
  const paperish = new Float32Array(n);
  for (let p = 0; p < n; p++) paperish[p] = v[p] < 0.15 ? 1 : 0;
  const nearPaper = extremePlane(paperish, w, h, 2, true);
  const solid = (p: number) => v[p] >= 0.5 && !nearPaper[p] && mag[p] > 0.05;
  const differ = (p: number, q: number) => {
    const dot = A[p * 3] * A[q * 3] + A[p * 3 + 1] * A[q * 3 + 1] + A[p * 3 + 2] * A[q * 3 + 2];
    return dot / (mag[p] * mag[q] + 1e-9) < 0.966 || Math.abs(Math.log((mag[p] + 1e-6) / (mag[q] + 1e-6))) > 0.12;
  };
  const cut = new Uint8Array(n);
  const from = new Int32Array(n).fill(-1);
  let queue: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!solid(p)) continue;
      for (const [dx, dy] of [[2, 0], [0, 2], [2, 2], [-2, 2]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!solid(q) || !differ(p, q)) continue;
        const light = L[p] >= L[q] ? p : q;
        if (!cut[light]) (cut[light] = 1, (from[light] = light), queue.push(light));
      }
    }
  // Grown into the lighter colour only, as far as the gap is wide.
  for (let step = 0; step < gap && queue.length; step++) {
    const next: number[] = [];
    for (const p of queue) {
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (cut[q] || v[q] < 0.3 || differ(from[p], q)) continue;
          cut[q] = 1;
          from[q] = from[p];
          next.push(q);
        }
    }
    queue = next;
  }
  const out = new Float32Array(v);
  for (let p = 0; p < n; p++) if (cut[p]) out[p] = 0;
  return { width: w, height: h, v: out };
}

// ---- Cropping, trimming, sizing ------------------------------------------------------------------------------

export function cropPlane(pl: Plane, x: number, y: number, w: number, h: number): Plane {
  const v = new Float32Array(w * h);
  for (let yy = 0; yy < h; yy++)
    for (let xx = 0; xx < w; xx++) {
      const sx = x + xx, sy = y + yy;
      if (sx >= 0 && sy >= 0 && sx < pl.width && sy < pl.height) v[yy * w + xx] = pl.v[sy * pl.width + sx];
    }
  return { width: w, height: h, v };
}
/** The same part of a picture (4 numbers a pixel) or of a paper map (3 numbers a pixel). */
function cropPixels<T extends Uint8ClampedArray | Uint8Array>(src: T, sw: number, per: number, x: number, y: number, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * per);
  for (let yy = 0; yy < h; yy++) out.set(src.subarray(((y + yy) * sw + x) * per, ((y + yy) * sw + x + w) * per), yy * w * per);
  return out;
}

/** Leaves out specks of ink smaller than `least` pixels: the grain a noisy photo leaves along every edge. */
export function despeckle(pl: Plane, least: number): Plane {
  const { width: w, height: h, v } = pl;
  const on = new Uint8Array(w * h);
  for (let p = 0; p < on.length; p++) on[p] = v[p] > 0.3 ? 1 : 0;
  const { label, size } = pieces(on, w, h);
  const kept = new Float32Array(v.length);
  for (let p = 0; p < v.length; p++) kept[p] = label[p] && size[label[p]] >= least ? 1 : 0;
  // Weak ink stays only as the soft edge of a mark that stays.
  const near = extremePlane(kept, w, h, 2, true);
  const out = new Float32Array(v.length);
  for (let p = 0; p < v.length; p++) out[p] = kept[p] || (!label[p] && near[p]) ? v[p] : 0;
  return { width: w, height: h, v: out };
}

/**
 * In a photo, only the stamp: its marks lie close together (letters, rings, a star, each within a few millimetres of
 * the next), so marks are grouped with everything within about 3 percent of the picture, and a group is kept when it
 * holds at least a sixth of the ink of the largest. Stray lines far from the stamp (the edge of the sheet, a fold, a
 * crumb on the desk) go, so the stamp keeps its size in its field.
 */
export function mainMarks(pl: Plane): Plane {
  const { width: w, height: h, v } = pl;
  const k = Math.min(1, 300 / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * k)), sh = Math.max(1, Math.round(h * k));
  const cellOf = (x: number, y: number) => Math.min(sh - 1, Math.floor(y * k)) * sw + Math.min(sw - 1, Math.floor(x * k));
  const mass = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (v[y * w + x] > 0.3) mass[cellOf(x, y)] += v[y * w + x];
  const has = new Float32Array(sw * sh);
  for (let c = 0; c < has.length; c++) has[c] = mass[c] > 0 ? 1 : 0;
  const near = extremePlane(has, sw, sh, Math.max(1, Math.round(Math.max(sw, sh) * 0.03)), true);
  const on = new Uint8Array(sw * sh);
  for (let c = 0; c < on.length; c++) on[c] = near[c] > 0 ? 1 : 0;
  const { label, size } = pieces(on, sw, sh);
  const ink = new Float64Array(size.length);
  for (let c = 0; c < on.length; c++) if (label[c]) ink[label[c]] += mass[c];
  let most = 0;
  for (let i = 1; i < ink.length; i++) most = Math.max(most, ink[i]);
  if (ink.length <= 2 || most <= 0) return pl;
  const out = new Float32Array(v);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const l = label[cellOf(x, y)];
      if (!l || ink[l] < most / 6) out[y * w + x] = 0;
    }
  return { width: w, height: h, v: out };
}

/**
 * In a photo, what has the stamp's colour but is not the stamp: specks under about 0.2 mm across (dust, the coloured
 * edge of a printed letter that was left out) and thin flecks (the fibres of recycled paper), under about 0.16 mm wide
 * and 3 mm long, that do not touch the stamp's larger marks. Fibres of grey paper would otherwise print as dashes of
 * ink all round the seal.
 */
export function dropFlecks(pl: Plane, pxmm: number): Plane {
  const { width: w, height: h, v } = pl;
  const on = new Uint8Array(w * h);
  for (let p = 0; p < on.length; p++) on[p] = v[p] > 0.3 ? 1 : 0;
  const { label, size } = pieces(on, w, h);
  const deep = insideDistance(on, w, h);
  const L = size.length;
  const thick = new Float32Array(L), x0 = new Int32Array(L).fill(w), x1 = new Int32Array(L).fill(-1), y0 = new Int32Array(L).fill(h), y1 = new Int32Array(L).fill(-1);
  for (let p = 0; p < on.length; p++) {
    const l = label[p];
    if (!l) continue;
    const x = p % w, y = (p - x) / w;
    thick[l] = Math.max(thick[l], deep[p]);
    (x0[l] = Math.min(x0[l], x)), (x1[l] = Math.max(x1[l], x)), (y0[l] = Math.min(y0[l], y)), (y1[l] = Math.max(y1[l], y));
  }
  const area = (mm: number) => mm * mm * pxmm * pxmm;
  const big = new Float32Array(w * h);
  for (let p = 0; p < on.length; p++) if (label[p] && size[label[p]] >= area(1)) big[p] = 1;
  const nearBig = extremePlane(big, w, h, Math.max(1, Math.round(0.3 * pxmm)), true);
  const touches = new Uint8Array(L);
  for (let p = 0; p < on.length; p++) if (label[p] && nearBig[p] && !big[p]) touches[label[p]] = 1;
  const drop = new Uint8Array(L);
  for (let l = 1; l < L; l++) {
    if (size[l] >= area(1) || touches[l]) continue;
    const long = Math.hypot(x1[l] - x0[l] + 1, y1[l] - y0[l] + 1);
    if (size[l] < area(0.2) || (2 * thick[l] < 0.16 * pxmm + 1 && long < 3 * pxmm)) drop[l] = 1;
  }
  if (!drop.some((x) => x)) return pl;
  const gone = new Float32Array(w * h);
  for (let p = 0; p < on.length; p++) if (drop[label[p]]) gone[p] = 1;
  const around = extremePlane(gone, w, h, 1, true);
  const out = new Float32Array(v);
  for (let p = 0; p < on.length; p++) if (gone[p] || (around[p] && !label[p])) out[p] = 0;
  return { width: w, height: h, v: out };
}

/**
 * Gaps of a pixel or two across a stroke closed: where the edge of a hard shadow crossed a ring, or a crossing line
 * was painted out, a hairline cut would be left.
 */
export function closeGaps(pl: Plane): Plane {
  const { width: w, height: h, v } = pl;
  const closed = extremePlane(extremePlane(v, w, h, 1, true), w, h, 1, false);
  const out = new Float32Array(v.length);
  for (let p = 0; p < v.length; p++) out[p] = Math.max(v[p], closed[p]);
  return { width: w, height: h, v: out };
}

/**
 * How faint the ink of a photo is, from 0 (an ordinary impression) to 1 (very faint): from how far the strongest of
 * its strokes are from their paper. A faint stamp stays somewhat faint, rather than being brought up to full ink.
 */
export function faintness(dist: Float32Array, pl: Plane): number {
  const vals: number[] = [];
  for (let p = 0; p < pl.v.length; p += 3) if (pl.v[p] > 0.5) vals.push(dist[p]);
  if (vals.length < 50) return 0;
  vals.sort((a, b) => a - b);
  return smooth(0.42, 0.2, vals[Math.floor(vals.length * 0.9)]);
}

/**
 * Whether the outline of the ink is an oval, as a round seal is in a photo taken at a slant: from the middle of the
 * box, the outermost ink in every direction lies on one ellipse. Gives how much wider than tall it is, or null for
 * any other shape (a box stamp, a logo, a seal that is already round).
 */
export function ovalOf(pl: Plane): { ratio: number } | null {
  const { width: w, height: h, v } = pl;
  const cx = w / 2, cy = h / 2;
  const reach: number[] = [];
  for (let k = 0; k < 180; k++) {
    const a = (k * Math.PI) / 90, c = Math.cos(a), s = Math.sin(a);
    let r = Math.hypot(w, h) / 2;
    for (; r > 1; r -= 0.5) {
      const x = Math.round(cx + c * r), y = Math.round(cy + s * r);
      if (x >= 0 && y >= 0 && x < w && y < h && v[y * w + x] > 0.5) break;
    }
    reach.push(r);
  }
  const axis = (ks: number[]) => ks.map((k) => reach[k]).sort((a, b) => a - b)[Math.floor(ks.length / 2)];
  const a = axis([178, 179, 0, 1, 2, 88, 89, 90, 91, 92]), b = axis([43, 44, 45, 46, 47, 133, 134, 135, 136, 137]);
  if (a < 8 || b < 8) return null;
  const off = reach.map((r, k) => {
    const t = (k * Math.PI) / 90;
    const e = (a * b) / Math.hypot(b * Math.cos(t), a * Math.sin(t));
    return Math.abs(r - e) / e;
  }).sort((x, y) => x - y);
  if (off[Math.floor(off.length / 2)] > 0.03 || off[Math.floor(off.length * 0.9)] > 0.07) return null;
  return { ratio: a / b };
}

/** Stretched along its shorter side until it is as wide as it is tall: an oval seal made round again. */
export function makeRound(pl: Plane, ratio: number): Plane {
  const { width: w, height: h, v } = pl;
  const nw = ratio < 1 ? Math.round(w / ratio) : w, nh = ratio > 1 ? Math.round(h * ratio) : h;
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / nh - 0.5)), y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / nw - 0.5)), x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), tx = sx - x0;
      out[y * nw + x] = (v[y0 * w + x0] * (1 - tx) + v[y0 * w + x1] * tx) * (1 - ty) + (v[y1 * w + x0] * (1 - tx) + v[y1 * w + x1] * tx) * ty;
    }
  }
  return { width: nw, height: nh, v: out };
}

/**
 * The box around the ink, with a small margin. Rows and columns with almost no ink at the edges are left out, so a
 * speck of dust in a corner does not keep a whole empty strip. Null when there is no ink.
 */
export function inkBox(pl: Plane, threshold = 0.08, within = true): { x: number; y: number; w: number; h: number } | null {
  const { width: w, height: h, v } = pl;
  const rows = new Float32Array(h), cols = new Float32Array(w);
  let total = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = v[y * w + x];
      if (s <= threshold) continue;
      rows[y] += s;
      cols[x] += s;
      total += s;
    }
  if (total <= 0) return null;
  // An edge row counts once it holds a share of the ink: a lone speck far away is not part of the stamp.
  const least = Math.max(0.5, total * 0.0004);
  let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
  while (x0 < x1 && cols[x0] < least) x0++;
  while (x1 > x0 && cols[x1] < least) x1--;
  while (y0 < y1 && rows[y0] < least) y0++;
  while (y1 > y0 && rows[y1] < least) y1--;
  const m = Math.max(3, Math.round(Math.max(x1 - x0 + 1, y1 - y0 + 1) * 0.025));
  // `within` false: the whole margin on every side, also where the picture ends sooner (cropPlane fills what lies
  // outside the picture with empty paper), so a design saved with its ink right at its border still gets its margin.
  if (!within) {
    const M = Math.max(4, Math.round(Math.max(x1 - x0 + 1, y1 - y0 + 1) * 0.032));
    return { x: x0 - M, y: y0 - M, w: x1 - x0 + 1 + 2 * M, h: y1 - y0 + 1 + 2 * M };
  }
  const bx = Math.max(0, x0 - m), by = Math.max(0, y0 - m);
  return { x: bx, y: by, w: Math.min(w, x1 + m + 1) - bx, h: Math.min(h, y1 + m + 1) - by };
}

/** Area averaging to a smaller size, so thin lines keep their weight instead of breaking up. */
export function shrinkPlane(pl: Plane, maxSide: number): Plane {
  const { width: w, height: h } = pl;
  const k = maxSide / Math.max(w, h);
  if (k >= 1) return pl;
  const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
  // Columns first, then rows: each target pixel takes the source pixels it covers, part pixels in part.
  const pass = (src: Float32Array, sw: number, sh: number, tw: number, horizontal: boolean): Float32Array => {
    const n = horizontal ? sw : sh, tn = tw;
    const out = new Float32Array(horizontal ? tw * sh : sw * tw);
    const step = n / tn;
    for (let t = 0; t < tn; t++) {
      const a = t * step, b = a + step;
      const i0 = Math.floor(a), i1 = Math.min(n - 1, Math.ceil(b) - 1);
      for (let o = 0; o < (horizontal ? sh : sw); o++) {
        let s = 0;
        for (let i = i0; i <= i1; i++) {
          const wgt = Math.min(b, i + 1) - Math.max(a, i);
          s += (horizontal ? src[o * sw + i] : src[i * sw + o]) * wgt;
        }
        if (horizontal) out[o * tw + t] = s / step;
        else out[t * sw + o] = s / step;
      }
    }
    return out;
  };
  const h1 = pass(pl.v, w, h, nw, true);
  const v = pass(h1, nw, h, nh, false);
  return { width: nw, height: nh, v };
}

// ---- 4. Rubber -----------------------------------------------------------------------------------------------

/**
 * Smooth noise from 0 to 1 over cells of `cell` pixels, from a seed. With `across` the cells are that many pixels the
 * other way, turned by `angle` radians, so the noise runs along a direction, as the fibres of paper do.
 */
function valueNoise(w: number, h: number, cell: number, r: () => number, across = cell, angle = 0): Float32Array {
  const c = Math.cos(angle), s = Math.sin(angle);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const u = (x * c + y * s) / cell, v = (-x * s + y * c) / across;
    (u0 = Math.min(u0, u)), (u1 = Math.max(u1, u)), (v0 = Math.min(v0, v)), (v1 = Math.max(v1, v));
  }
  const ou = Math.floor(u0), ov = Math.floor(v0);
  const gw = Math.floor(u1) - ou + 3, gh = Math.floor(v1) - ov + 3;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const fu = (x * c + y * s) / cell - ou, fv = (-x * s + y * c) / across - ov;
      const iu = Math.floor(fu), iv = Math.floor(fv), tu = fu - iu, tv = fv - iv;
      const su = tu * tu * (3 - 2 * tu), sv = tv * tv * (3 - 2 * tv);
      const k = iv * gw + iu;
      const a = g[k] * (1 - su) + g[k + 1] * su, b = g[k + gw] * (1 - su) + g[k + gw + 1] * su;
      out[y * w + x] = a * (1 - sv) + b * sv;
    }
  return out;
}

/**
 * The same field with its values spread evenly from 0 to 1 by rank, over the pixels where `on` is set: a cut at `s`
 * then leaves out a share `s` of them, whatever the noise looked like.
 */
function evenOut(f: Float32Array, on: Uint8Array): Float32Array {
  const B = 4096;
  let lo = Infinity, hi = -Infinity;
  for (let p = 0; p < f.length; p++) if (on[p]) (lo = Math.min(lo, f[p])), (hi = Math.max(hi, f[p]));
  const out = new Float32Array(f.length);
  if (!(hi > lo)) return out.fill(0.5);
  const at = (x: number) => Math.min(B - 1e-3, Math.max(0, ((x - lo) / (hi - lo)) * B));
  const below = new Float64Array(B + 1);
  let total = 0;
  for (let p = 0; p < f.length; p++) if (on[p]) (below[Math.floor(at(f[p])) + 1]++, total++);
  for (let i = 1; i <= B; i++) below[i] += below[i - 1];
  for (let p = 0; p < f.length; p++) {
    const x = at(f[p]), i = Math.floor(x);
    out[p] = (below[i] + (below[i + 1] - below[i]) * (x - i)) / total;
  }
  return out;
}

/** A value from a plane between its pixels, 0 outside it. */
function sample(v: Float32Array, w: number, h: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : v[yy * w + xx]);
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

/** 1-D smooth noise round a circle: `cells` values, read at an angle in radians. */
function ringNoise(cells: number, r: () => number): (a: number) => number {
  const n = Math.max(3, Math.round(cells));
  const g = Array.from({ length: n }, () => r());
  return (a: number) => {
    const f = (((a / (2 * Math.PI)) % 1) + 1) % 1 * n, i = Math.floor(f) % n, t = f - Math.floor(f), s = t * t * (3 - 2 * t);
    return g[i] * (1 - s) + g[(i + 1) % n] * s;
  };
}

/**
 * A rubber stamp's impression: how much ink each pixel holds (v, the coverage), and how much darker than the ink's
 * own colour it prints there (dark, from 0: ink squeezed to the rims of strokes, and pad ink that varies a little).
 */
export type Inked = Plane & { dark: Float32Array };

/**
 * The texture of ink from a hand-pressed rubber stamp, from the seed, by `amount` from 0 (even ink) to 1 (a
 * well-worn stamp). Everything is sized in millimetres at the size the stamp prints (`mm` across its longer side),
 * not in pixels of the stored picture. Ink short of the pad is lost coverage, not a paler tint: wherever a stamp is
 * short of ink, the paper shows through in grain and specks with hard edges, and the ink that does land stays near
 * full strength, so no light area fades smoothly. At the default setting (0.5):
 *  - The rubber is not the design: its edges are warped by a few hundredths of a millimetre over 1 to 3 mm (no
 *    perfect circle or straight frame survives), edges wander by about 0.05 to 0.1 mm, a design spreads a faint
 *    0.05 to 0.1 mm of ink outwards, and a few nicks 0.2 to 0.5 mm across bite into the edges.
 *  - One side pressed harder: about 15 percent darker than the other side, not more. On the light side the outer
 *    ring or frame (never the words) prints thinner, broken into grain, with a few short stretches of its outer edge
 *    that did not print, with crisp ends.
 *  - Two or three patches 4 to 9 mm across where the pad ran short, and paper grain everywhere: both lose coverage
 *    through a fine fibre-like noise (0.07 to 0.4 mm), so they break up into speckle.
 *  - Salt-like voids 0.1 to 0.3 mm across, more of them in wide solids (a star, a filled disc) than in thin strokes,
 *    and a narrow darker rim about 0.1 mm wide on every stroke, where ink squeezes to the edge.
 *  - Words keep at least about 70 percent of their ink in every part of them. Thin strokes (under about 0.4 mm) and
 *    small stamps (under 20 mm) get less of all of it, so a hairline stays whole and complex characters stay dense.
 * A photo's own unevenness (the real impression it shows) is kept as grain and as a slightly lighter tone, a faint
 * photo (`faint` from 0 to 1) stays somewhat faint, and a photo's strokes are not spread again: they already are.
 */
export function rubber(pl: Plane, seed: number, amount: number, o: { mm?: number; photo?: boolean; faint?: number } = {}): Inked {
  const t = clamp01(amount);
  const { width: w, height: h } = pl;
  const n = w * h;
  const dark = new Float32Array(n);
  if (t <= 0) return { width: w, height: h, v: new Float32Array(pl.v), dark };
  const r = rng(seed);
  const size = o.mm || STAMP_DEFAULT_MM;
  const pxmm = Math.max(w, h) / size;
  const mm = (x: number) => x * pxmm;
  const A = t / DEFAULT_TEXTURE, A1 = Math.min(1, A), A2 = Math.min(1.6, A);
  const photo = !!o.photo, faint = clamp01(o.faint || 0);
  const noise = (cellMm: number, alongMm = cellMm, angle = 0) => valueNoise(w, h, Math.max(1.2, mm(alongMm)), r, Math.max(1.2, mm(cellMm)), angle);

  // The rubber is not the design: the picture is read through a gentle warp, long waves of about 2 mm and short
  // ones of about 0.35 mm, so a ring is never a perfect circle and a frame never perfectly straight.
  const wa = noise(2.2), wb = noise(2.2), wc = noise(0.35), wd = noise(0.35);
  const amp1 = mm(0.07 * A2), amp2 = mm(0.03 * A2);
  const warped = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      warped[p] = sample(pl.v, w, h, x + (wa[p] - 0.5) * 2 * amp1 + (wc[p] - 0.5) * 2 * amp2, y + (wb[p] - 0.5) * 2 * amp1 + (wd[p] - 0.5) * 2 * amp2);
    }
  // Rough edges: softened a little, then cut again where a field of noise says, so the edge wanders. A design's
  // cut sits a little outside the middle of its edge (ink spreads into the paper); a photo's sits in the middle, as
  // its strokes already spread when they were pressed. A hairline is never broken by it: the cut stays below its
  // own peak.
  const b = blurPlane(warped, w, h, Math.max(0.6, mm(photo ? 0.05 : 0.07)));
  const peak = extremePlane(b, w, h, Math.max(1, Math.round(mm(0.12))), true);
  const e1 = noise(0.09), e2 = noise(0.3);
  const cut0 = photo ? 0.5 : 0.44 - 0.04 * A1;
  const shape = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    if (b[p] <= 0.01) continue;
    const thr = Math.min(0.62 * peak[p], Math.max(0.18, cut0 + (0.6 * e1[p] + 0.4 * e2[p] - 0.5) * 0.45 * A2));
    shape[p] = smooth(thr - 0.06, thr + 0.06, b[p]) * smooth(0.08, 0.25, peak[p]);
  }

  // Where each pixel is in its stroke: how far from the edge, and how wide the stroke around it is.
  const on = new Uint8Array(n);
  let inkPx = 0, cx = 0, cy = 0;
  for (let p = 0; p < n; p++)
    if (shape[p] > 0.5) {
      on[p] = 1;
      inkPx++;
      cx += p % w;
      cy += Math.floor(p / w);
    }
  if (!inkPx) return { width: w, height: h, v: shape, dark };
  cx /= inkPx;
  cy /= inkPx;
  const deep = insideDistance(on, w, h);
  const half = extremePlane(deep, w, h, Math.max(1, Math.round(mm(0.3))), true);
  // The ring or frame round a stamp (a mark that reaches across much of it) against everything else: the words, a
  // star, a logo. Only a border may print broken; the words never lose more than about 30 percent of their ink.
  const { label, size: pieceSize } = pieces(on, w, h);
  const bx0 = new Int32Array(pieceSize.length).fill(w), bx1 = new Int32Array(pieceSize.length).fill(-1);
  const by0 = new Int32Array(pieceSize.length).fill(h), by1 = new Int32Array(pieceSize.length).fill(-1);
  for (let p = 0; p < n; p++) {
    const l = label[p];
    if (!l) continue;
    const x = p % w, y = (p - x) / w;
    (bx0[l] = Math.min(bx0[l], x)), (bx1[l] = Math.max(bx1[l], x)), (by0[l] = Math.min(by0[l], y)), (by1[l] = Math.max(by1[l], y));
  }
  const isBorder = pieceSize.map((_, l) => l > 0 && Math.max(bx1[l] - bx0[l], by1[l] - by0[l]) >= 0.45 * Math.max(w, h));
  // How far the outer edge of the border reaches from the middle, in every direction.
  const BINS = 720;
  const binOf = (x: number, y: number) => Math.floor(((Math.atan2(y - cy, x - cx) + Math.PI) / (2 * Math.PI)) * BINS) % BINS;
  const reach = new Float32Array(BINS);
  const anyBorder = isBorder.some((x) => x);
  for (let p = 0; p < n; p++)
    if (on[p] && (!anyBorder || isBorder[label[p]])) {
      const x = p % w, y = (p - x) / w;
      const k = binOf(x, y);
      reach[k] = Math.max(reach[k], Math.hypot(x - cx, y - cy));
    }

  // Pressed harder on one side. The tone falls by about 15 percent towards the far side, along a direction bent
  // by broad noise, so it is no straight ramp; the rest of the lighter side is in its outer few millimetres.
  const ang = r() * Math.PI * 2, dx = Math.cos(ang), dy = Math.sin(ang);
  let lo = Infinity, hi = -Infinity;
  for (let p = 0; p < n; p++)
    if (on[p]) {
      const q = (p % w) * dx + Math.floor(p / w) * dy;
      (lo = Math.min(lo, q)), (hi = Math.max(hi, q));
    }
  const bend = noise(7), mottle = noise(3);
  // Patches where the pad ran short: two or three, 4 to 9 mm across, centred on ink, with ragged outlines.
  const patches: { x: number; y: number; rad: number; depth: number }[] = [];
  const count = 2 + (r() < 0.5 ? 1 : 0);
  for (let k = 0, tries = 0; k < count && tries < 300; tries++) {
    const x = Math.floor(r() * w), y = Math.floor(r() * h);
    if (!on[y * w + x]) continue;
    patches.push({ x, y, rad: mm(2 + r() * 2.5), depth: (0.2 + 0.2 * r()) * A1 });
    k++;
  }
  const ragged = noise(1.1);
  // The light side's outer edge: how much of the border's width did not print, round the stamp. Mostly a thinner
  // stroke; on most seeds also a few short stretches where none of it printed, with crisp ends.
  const thinAt = ringNoise((2 * Math.PI * Math.max(...reach)) / mm(3.5), r);
  const gapAt = ringNoise((2 * Math.PI * Math.max(...reach)) / mm(2.2), r);
  const gaps = r() < 0.65;
  // Paper grain and ink short of the pad: a fine noise that runs a little along the paper's fibres. Voids: a
  // coarser one, its brightest few percent, in clusters.
  const fa = r() * Math.PI;
  const f1 = noise(0.07, 0.14, fa), f2 = noise(0.16, 0.26, fa), f3 = noise(0.4);
  const fib = new Float32Array(n);
  for (let p = 0; p < n; p++) fib[p] = 0.45 * f1[p] + 0.33 * f2[p] + 0.22 * f3[p];
  const N = evenOut(fib, on);
  const v1 = noise(0.12), v2 = noise(0.3), clump = noise(2);
  const vf = new Float32Array(n);
  for (let p = 0; p < n; p++) vf[p] = 0.6 * v1[p] + 0.4 * v2[p];
  const NV = evenOut(vf, on);
  // A photo's own unevenness: how strong the ink is, on average, around each pixel of a stroke, against its best.
  let own: Float32Array | null = null;
  if (photo) {
    const inkOn = new Float32Array(n);
    for (let p = 0; p < n; p++) inkOn[p] = pl.v[p] > 0.3 ? 1 : 0;
    const m1 = blurPlane(pl.v, w, h, mm(0.25)), m2 = blurPlane(inkOn, w, h, mm(0.25));
    own = new Float32Array(n);
    for (let p = 0; p < n; p++) own[p] = smooth(0.3, 0.92, m1[p] / Math.max(0.05, m2[p]));
  }
  // Small stamps and thin strokes get less of everything, so a 15 mm seal keeps dense characters.
  const small = 0.3 + 0.7 * smooth(12, 30, size);
  const drift = valueNoise(w, h, Math.max(4, Math.max(w, h) / 3), r);
  const pressure = photo ? 0.4 : 1;

  const v = new Float32Array(n);
  // What of each stroke printed at all, before grain and voids: the edge of the ink, where a design spreads a little.
  const kept = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    if (shape[p] <= 0) continue;
    const x = p % w, y = (p - x) / w;
    const lean = clamp01(((x * dx + y * dy) - lo) / Math.max(1, hi - lo) + 0.35 * (bend[p] - 0.5));
    const light = smooth(0.3, 1, lean) * pressure;
    const dmm = deep[p] / pxmm, wmm = (2 * half[p]) / pxmm;
    const border = on[p] && isBorder[label[p]];
    const thin = 0.3 + 0.7 * smooth(0.12, 0.45, wmm);
    // Wide solids (a star, a filled disc) print dense, with salt-like voids rather than grain.
    const solid = smooth(0.25, 0.6, dmm);
    // How short of ink this part of the stamp is, as a share of its coverage lost.
    let s = 0.035 * A2 + 0.18 * A1 * light * light + 0.1 * A2 * Math.max(0, (mottle[p] - 0.55) / 0.45);
    for (const pt of patches) {
      const dd = (Math.hypot(x - pt.x, y - pt.y) / pt.rad) * (0.7 + 0.6 * ragged[p]);
      if (dd < 1) s += pt.depth * smooth(1, 0.45, dd);
    }
    const k = binOf(x, y);
    const fromEdge = (reach[k] - Math.hypot(x - cx, y - cy)) / pxmm;
    if (border) s += 0.3 * A1 * smooth(2.5, 0.2, fromEdge) * smooth(0.45, 1, light);
    if (own) s += 0.5 * (1 - own[p]) + 0.12 * faint;
    // Ink squeezed to the rims keeps them inked longest; thin strokes and small stamps lose less.
    s *= (0.5 + 0.5 * smooth(0.04, 0.16, dmm)) * (1 - 0.85 * solid) * thin * small;
    s = Math.min(s, border ? 0.42 : 0.26);
    let cov = smooth(s - 0.04, s + 0.04, N[p]);
    // Salt: voids 0.1 to 0.3 mm, more in wide solids, in clusters.
    const pv = Math.min(0.055, (0.012 + 0.022 * solid) * A2 * (0.35 + 1.3 * clump[p]) * thin * small);
    cov *= 1 - smooth(1 - pv - 0.015, 1 - pv + 0.015, NV[p]);
    // The outer edge of the border on the light side: a thinner stroke, here and there not printed at all.
    let edge = 1;
    if (border && fromEdge < wmm * 1.2 && light > 0.3) {
      const a = Math.atan2(y - cy, x - cx);
      let frac = smooth(0.3, 1, light) * (0.05 + 0.25 * thinAt(a)) * A1 * small;
      if (gaps && wmm >= 0.3 && light > 0.6) frac = Math.max(frac, 1.25 * smooth(0.86, 0.88, gapAt(a)));
      edge = smooth(-0.5, 0.5, (fromEdge - frac * wmm) * pxmm);
    }
    kept[p] = shape[p] * edge;
    cov *= edge;
    const tone = Math.min(1, 1 - (0.14 * A1 * light + 0.06 * A2 * (mottle[p] - 0.5)) * small) * (own ? 0.85 + 0.15 * own[p] : 1) * (1 - 0.15 * faint);
    v[p] = shape[p] * cov * tone;
    // A narrow darker rim, about 0.1 mm, where ink squeezes to the edge; pad ink a little darker or lighter here
    // and there; the heavy side a touch fuller.
    dark[p] = clamp01((0.16 * A1 * (1 - smooth(0.03, 0.13, dmm)) + 0.05 * (1 - light) + 0.06 * (drift[p] - 0.5)) * (on[p] ? 1 : 0.5));
  }
  // Nicks: a few bites 0.2 to 0.5 mm across out of the edges, never more than two fifths of a thin stroke.
  const nicks = Math.round((3 + 5 * r()) * A1 * (inkPx / (pxmm * pxmm)) / 250);
  const nickShape = noise(0.12);
  for (let k = 0, tries = 0; k < nicks && tries < nicks * 60 + 60; tries++) {
    const sx = Math.floor(r() * w), sy = Math.floor(r() * h), c = sy * w + sx;
    if (!on[c] || deep[c] > 1.5) continue;
    const wpx = 2 * half[c];
    if (wpx < mm(0.25)) continue;
    k++;
    const rad = Math.min(mm(0.1 + 0.15 * r()), (isBorder[label[c]] ? 0.6 : 0.4) * wpx);
    const reachPx = Math.ceil(rad * 1.5);
    for (let yy = Math.max(0, sy - reachPx); yy <= Math.min(h - 1, sy + reachPx); yy++)
      for (let xx = Math.max(0, sx - reachPx); xx <= Math.min(w - 1, sx + reachPx); xx++) {
        const q = yy * w + xx;
        const dd = (Math.hypot(xx - sx, yy - sy) / rad) * (0.75 + 0.5 * nickShape[q]);
        if (dd < 1.1) (v[q] *= smooth(0.9, 1.1, dd)), (kept[q] *= smooth(0.9, 1.1, dd));
      }
  }
  // A design's ink spreads a little into the paper: a faint fringe 0.05 to 0.1 mm wide. A photo already has its own.
  if (!photo) {
    const spread = blurPlane(kept, w, h, Math.max(0.5, mm(0.06)));
    for (let p = 0; p < n; p++) if (shape[p] < 0.5) v[p] = Math.max(v[p], 0.3 * A1 * smooth(0.04, 0.45, spread[p]));
  }
  return { width: w, height: h, v, dark };
}

// ---- 6. Colour -----------------------------------------------------------------------------------------------

/**
 * The impression as pixels, as see-through as the ink is thin. One colour, the ink's, as a stamp pad has: darker at
 * the rims of strokes, where ink squeezes out, and varying a little in how dark it prints, never in its hue. One flat
 * colour with only its strength changing would look like a picture; a paler or cooler tint would look like a screen.
 */
export function colourise(pl: Plane | Inked, ink: Ink, _seed = 1): Rgba {
  const { width: w, height: h, v } = pl;
  const full = INK_RGB[ink];
  const dark = 'dark' in pl ? pl.dark : null;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < v.length; p++) {
    const a = clamp01(v[p]);
    if (a <= 0) continue;
    const d = dark ? dark[p] : 0;
    for (let c = 0; c < 3; c++) data[p * 4 + c] = full[c] * (1 - d);
    data[p * 4 + 3] = Math.round(a * 255);
  }
  return { width: w, height: h, data };
}

// ---- All of it -----------------------------------------------------------------------------------------------

/** What is worked out once for a picture, so moving a slider only does the steps after it. */
export type Prepared = {
  img: Rgba;
  paper: Uint8ClampedArray;
  dist: Float32Array;
  found: InkFound;
  /** A photo of a stamp on paper, not a clean design (isPhoto). */
  photo: boolean;
  /** Where paper ends and ink starts in this picture (cutOf). */
  cut: Cut;
  /** How many ruled lines of lined paper were painted out. */
  ruled: number;
  /** How many creases of a folded sheet were painted out. */
  creased: number;
};

export function prepare(picture: Rgba): Prepared {
  let img = onWhite(picture);
  const paper = paperOf(img);
  let dist = inkDistance(img, paper);
  const photo = isPhoto(img, paper, dist);
  let ruled = 0, creased = 0;
  if (photo) {
    const rules = ruledLines(dist, img.width, img.height);
    const folds = creases(img, paper, dist);
    if (rules.length || folds.length) {
      img = unrule(img, [...rules, ...folds]);
      dist = inkDistance(img, paper);
      ruled = rules.length;
      creased = folds.length;
    }
    // Sensor noise would turn into grain along every edge: each pixel takes the middle value of its neighbours.
    dist = median3(dist, img.width, img.height);
  }
  let cut = cutOf(dist, photo);
  if (photo) {
    dist = offSheet(dist, img.width, img.height, cut.floor);
    cut = cutOf(dist, photo);
  }
  // A design prints every mark that is clearly there, however light its colour.
  if (!photo) cut.base = Math.min(cut.base, 0.22);
  const found = findInk(img, paper, dropEdgeMarks(strengthOf(dist, img.width, img.height, DEFAULT_PAPER, cut), photo), photo);
  return { img, paper, dist, found, photo, cut, ruled, creased };
}

export type Impression = {
  image: Rgba;
  /** No ink was left: the picture is blank paper, or the settings took everything away. */
  empty: boolean;
  /** What was found in the part of the picture that is used (after "Cut off the edges"). */
  found: InkFound;
  /** The outline is an oval (a round seal photographed at a slant): how much wider than tall. Null otherwise. */
  oval: { ratio: number } | null;
  /** The share of the stamp's lines, by length, thinner than FINE_LINE_MM at the size it prints at (fineShare). */
  fine?: number;
};

/** A line thinner than this, in mm on the page, can break up under the rubber texture. */
export const FINE_LINE_MM = 0.15;
/** From this share of thin lines on, the stamp maker says so and how to keep them whole (StampMaker.tsx). */
export const FINE_WARN_SHARE = 0.3;
/** The texture from which that is said: below it the ink is even enough to keep thin lines whole. */
export const FINE_WARN_TEXTURE = 0.25;

/**
 * How much of a stamp's line work is thin: along the middle of every line (where the distance to the paper is
 * greatest), the share of points where the line is narrower than `under` mm. `pxmm`: pixels to a millimetre at the
 * size it prints at. 0 when there is no ink. A design with small type and hairline rings scores high; a bold seal low.
 */
export function fineShare(pl: Plane, pxmm: number, under = FINE_LINE_MM): number {
  const { width: w, height: h, v } = pl;
  if (w < 3 || h < 3 || !(pxmm > 0)) return 0;
  // Distance from each ink pixel to the nearest paper, in pixels (two passes, steps of 1 and the square root of 2).
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = v[i] > 0.45 ? 1e9 : 0;
  const R2 = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let m = x > 0 ? Math.min(d[i], d[i - 1] + 1) : 1;
      if (y > 0) m = Math.min(m, d[i - w] + 1, x > 0 ? d[i - w - 1] + R2 : 1, x < w - 1 ? d[i - w + 1] + R2 : 1);
      else m = 1;
      d[i] = m;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let m = x < w - 1 ? Math.min(d[i], d[i + 1] + 1) : 1;
      if (y < h - 1) m = Math.min(m, d[i + w] + 1, x < w - 1 ? d[i + w + 1] + R2 : 1, x > 0 ? d[i + w - 1] + R2 : 1);
      else m = 1;
      d[i] = m;
    }
  // The middle of a line: no neighbour is further from the paper. Its width there is about twice that distance.
  let all = 0, thin = 0;
  const limit = under * pxmm;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, here = d[i];
      if (!here) continue;
      if (d[i - 1] > here || d[i + 1] > here || d[i - w] > here || d[i + w] > here || d[i - w - 1] > here || d[i - w + 1] > here || d[i + w - 1] > here || d[i + w + 1] > here) continue;
      all++;
      if (2 * here - 1 < limit) thin++;
    }
  return all ? thin / all : 0;
}

/**
 * The finished impression for these settings. The same picture and the same settings give the same pixels. `mm`: the
 * size the stamp prints at, across its longer side, which sets the size of its texture.
 */
export function impression(p: Prepared, look: Look, maxSide = STAMP_OUT_MAX_SIDE, mm = STAMP_DEFAULT_MM): Impression {
  let { img, paper, dist } = p;
  let w = img.width, h = img.height;
  const nothing = (found: InkFound): Impression => ({ image: colourise({ width: 1, height: 1, v: new Float32Array(1) }, look.ink), empty: true, found, oval: null });
  if (look.crop) {
    // Cut off first, and everything after works on what is left: the ink found, the desk at the new edges.
    const c = look.crop;
    const x0 = Math.min(w - 1, Math.round(w * clamp01(c.left))), y0 = Math.min(h - 1, Math.round(h * clamp01(c.top)));
    const x1 = Math.max(x0 + 1, Math.round(w * (1 - clamp01(c.right)))), y1 = Math.max(y0 + 1, Math.round(h * (1 - clamp01(c.bottom))));
    const cw = x1 - x0, ch = y1 - y0;
    img = { width: cw, height: ch, data: cropPixels(img.data as Uint8ClampedArray, w, 4, x0, y0, cw, ch) };
    paper = cropPixels(paper, w, 3, x0, y0, cw, ch);
    dist = cropPlane({ width: w, height: h, v: dist }, x0, y0, cw, ch).v;
    (w = cw), (h = ch);
  }
  let pl = dropEdgeMarks(strengthOf(dist, w, h, look.paper, p.cut), p.photo);
  const found = look.crop ? findInk(img, paper, pl, p.photo) : p.found;
  if (look.onlyInk) pl = onlyInk(img, paper, pl, found, look.ink);
  let box = inkBox(pl);
  if (!box) return nothing(found);
  // Pixels to a millimetre in the picture as it was taken: the stamp is `mm` across its longer side.
  let pxmm = Math.max(box.w, box.h) / mm;
  if (look.gaps && !p.photo && found.several) pl = colourGaps(img, paper, pl, Math.max(2, Math.round(0.22 * pxmm)));
  let faint = 0;
  if (p.photo) {
    pl = mainMarks(despeckle(pl, Math.max(4, (0.15 * pxmm) ** 2)));
    // Specks and fibres over the whole sheet made the box too large: measured again on what is left, twice.
    for (let k = 0; k < 2; k++) {
      const b = inkBox(pl);
      if (!b) return nothing(found);
      pxmm = Math.max(b.w, b.h) / mm;
      pl = mainMarks(dropFlecks(pl, pxmm));
    }
    pl = closeGaps(pl);
    faint = faintness(dist, pl);
  }
  // The margin is the same on every side whatever the picture came with: a design cropped right at its outer ring
  // would otherwise be cut flat along the edge of its picture once the ink is moved and spread below.
  box = inkBox(pl, undefined, false);
  if (!box) return nothing(found);
  // A hand never sets a stamp down in the exact middle of where it aims: the ink sits a little off the middle of its
  // picture, by the seed, within the margin.
  const off = rng(look.seed ^ 0x6a09e667), side = Math.max(box.w, box.h);
  pl = cropPlane(pl, box.x + Math.round((off() * 2 - 1) * 0.014 * side), box.y + Math.round((off() * 2 - 1) * 0.014 * side), box.w, box.h);
  const oval = ovalOf(pl);
  if (look.round && oval && Math.abs(Math.log(oval.ratio)) > 0.025 && Math.abs(Math.log(oval.ratio)) < 0.35) pl = makeRound(pl, oval.ratio);
  // How much of it is hairline at the size it prints at, measured before the texture (fineShare).
  const fine = fineShare(pl, Math.max(pl.width, pl.height) / mm);
  pl = shrinkPlane(pl, maxSide);
  const inked = rubber(pl, look.seed, look.texture, { mm, photo: p.photo, faint });
  return { image: colourise(inked, look.ink, look.seed), empty: false, found, oval, fine };
}
