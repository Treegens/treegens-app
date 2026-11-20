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
 * STAMP_OPACITY over white they land on blue-violet about (40,44,128), carmine (170,30,48), violet (80,40,120),
 * blue-black (35,36,48) and a dull green.
 */
export const INK_RGB: Record<Ink, [number, number, number]> = {
  blue: [33, 37, 124],
  red: [167, 23, 42],
  purple: [75, 33, 116],
  black: [29, 30, 42],
  green: [24, 88, 56],
};
/** The same inks where they are thin or short of ink: a little lighter and cooler, as real pad ink is. */
const THIN_RGB: Record<Ink, [number, number, number]> = {
  blue: [62, 74, 160],
  red: [186, 52, 84],
  purple: [104, 70, 156],
  black: [58, 62, 84],
  green: [44, 112, 96],
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
  /** Keep only marks in the colour of the ink that was found (only when that ink is not black). */
  onlyInk: boolean;
  /** Edges taken off before anything else, as shares of the width and height. */
  crop?: { left: number; top: number; right: number; bottom: number };
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
/** The natural tilt for a seed: between -4 and 4 degrees, in tenths, never quite straight. */
export function tiltFor(seed: number): number {
  const r = rng(seed ^ 0x5bd1e995);
  r();
  const t = Math.round((r() * 2 - 1) * TILT_MAX * 10) / 10;
  return Math.abs(t) < 0.6 ? (t < 0 ? -0.6 : 0.6) * (1 + Math.round(r() * 4)) : t;
}
export const lookFor = (seed: number, ink: Ink = 'blue'): Look => ({ ink, seed, tilt: tiltFor(seed), texture: DEFAULT_TEXTURE, paper: DEFAULT_PAPER, onlyInk: true });

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
  // How bright the paper is where it is brightest: the upper quarter of the blocks that look like paper.
  const papery = [...L.keys()].filter((k) => sat(col[k * 3], col[k * 3 + 1], col[k * 3 + 2]) < 0.3 && L[k] > 60).map((k) => L[k]).sort((a, b) => a - b);
  const top = papery.length ? papery[Math.floor(papery.length * 0.75)] : 255;
  // A block is paper when its brightest part has little colour, and it is either not much darker than the paper
  // where it is brightest, or about as bright as the blocks right next to it: a shadow or dim light changes
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
      const greyish = sat(col[k * 3], col[k * 3 + 1], col[k * 3 + 2]) < 0.3;
      known[k] = greyish && L[k] > top * 0.3 && (L[k] >= top * 0.55 || L[k] >= near * 0.85) ? 1 : 0;
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

/** The cut between paper and ink for a "paper" setting from 0 to 1: below lo is paper, above hi is full ink. */
export const paperCut = (paper: number) => {
  const lo = 0.11 + clamp01(paper) * 0.2;
  return { lo, hi: lo + 0.3 };
};

/** Ink strength per pixel from its distance to the paper. */
export function strengthOf(dist: Float32Array, width: number, height: number, paper = DEFAULT_PAPER): Plane {
  const { lo, hi } = paperCut(paper);
  const v = new Float32Array(dist.length);
  for (let i = 0; i < dist.length; i++) v[i] = smooth(lo, hi, dist[i]);
  return { width, height, v };
}

/**
 * Leaves out solid dark areas that touch the edge of the picture: in a photo that is the table, the edge of the paper
 * or a shadow, not the stamp. A mark made of lines (the ring of a seal cropped so tightly that it touches the edge)
 * stays, and so does everything when the solid area is nearly all the ink there is (a seal that fills the picture).
 * Worked out on a smaller copy (at most 400 pixels across), joined the way a mark is: pixel to neighbouring pixel.
 */
export function dropEdgeMarks(pl: Plane): Plane {
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
    let x0 = sw, x1 = 0, y0 = sh, y1 = 0, ink = 0;
    while (stack.length) {
      const j = stack.pop()!;
      cells.push(j);
      const x = j % sw, y = (j - x) / sw;
      x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y);
      ink += weight[j];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          const n = ny * sw + nx;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < sw && ny < sh && on[n] && !seen[n]) (seen[n] = 1, stack.push(n));
        }
    }
    // Solid: it fills much of its own box. A ring, a line of letters, a frame of lines does not.
    const solid = cells.length / ((x1 - x0 + 1) * (y1 - y0 + 1)) > 0.45 && cells.length > 12;
    if (!solid) continue;
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

/** The colour of a pixel as if its paper were pure white (each channel divided by the paper's): hue and saturation. */
function inkHue(d: ArrayLike<number>, i: number, paper: Uint8ClampedArray, j: number): { hue: number; s: number } {
  const r = Math.min(1, d[i] / Math.max(1, paper[j])), g = Math.min(1, d[i + 1] / Math.max(1, paper[j + 1])), b = Math.min(1, d[i + 2] / Math.max(1, paper[j + 2]));
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const c = mx - mn;
  // Saturation against the paper's white, not against the pixel itself: a faint grey edge is not "fully coloured".
  const s = c / Math.max(0.35, mx);
  let hue = 0;
  if (c > 1e-6) hue = mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return { hue: hue * 60, s };
}
const inkOfHue = (hue: number): Ink => (hue < 45 || hue >= 335 ? 'red' : hue < 75 ? 'red' : hue < 165 ? 'green' : hue < 250 ? 'blue' : 'purple');
const COLOURED = 0.22;

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
};

/** Which ink the marks are in, weighed by how strong each mark is. */
export function findInk(img: Rgba, paper: Uint8ClampedArray, strength: Plane): InkFound {
  const d = img.data, v = strength.v;
  const weight: Record<Ink, number> = { blue: 0, red: 0, purple: 0, black: 0, green: 0 };
  const hx: Record<Ink, number> = { blue: 0, red: 0, purple: 0, black: 0, green: 0 }, hy: Record<Ink, number> = { blue: 0, red: 0, purple: 0, black: 0, green: 0 };
  let total = 0;
  for (let p = 0; p < v.length; p++) {
    if (v[p] < 0.5) continue;
    const { hue, s } = inkHue(d, p * 4, paper, p * 3);
    const ink = s < COLOURED ? 'black' : inkOfHue(hue);
    weight[ink] += v[p];
    hx[ink] += v[p] * Math.cos((hue * Math.PI) / 180);
    hy[ink] += v[p] * Math.sin((hue * Math.PI) / 180);
    total += v[p];
  }
  if (total < Math.max(12, v.length * 0.0004)) return { ink: 'blue', empty: true, several: false, share: 0, hue: null };
  const order = [...INKS].sort((a, b) => weight[b] - weight[a]);
  const main = order[0];
  const share = weight[main] / total;
  const second = weight[order[1]] / total;
  const hue = main === 'black' ? null : ((Math.atan2(hy[main], hx[main]) * 180) / Math.PI + 360) % 360;
  return { ink: main, empty: false, several: share < 0.75 && second > 0.15, share, hue };
}

/**
 * Leaves out marks that are not in the ink's own colour: printed black text next to a blue stamp in a photo, a red
 * margin line. Only for an ink that has a colour (`found.hue`): black ink cannot be told apart from black text.
 */
export function onlyInk(img: Rgba, paper: Uint8ClampedArray, strength: Plane, found: InkFound): Plane {
  if (found.hue == null) return strength;
  const d = img.data, v = new Float32Array(strength.v);
  for (let p = 0; p < v.length; p++) {
    if (v[p] <= 0) continue;
    const { hue, s } = inkHue(d, p * 4, paper, p * 3);
    let dh = Math.abs(hue - found.hue) % 360;
    if (dh > 180) dh = 360 - dh;
    v[p] *= smooth(0.06, 0.16, s) * smooth(70, 40, dh);
  }
  return { width: strength.width, height: strength.height, v };
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

/**
 * The box around the ink, with a small margin. Rows and columns with almost no ink at the edges are left out, so a
 * speck of dust in a corner does not keep a whole empty strip. Null when there is no ink.
 */
export function inkBox(pl: Plane, threshold = 0.08): { x: number; y: number; w: number; h: number } | null {
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

/** Smooth noise from 0 to 1 over cells of `cell` pixels, from a seed. */
function valueNoise(w: number, h: number, cell: number, r: () => number): Float32Array {
  const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = y / cell, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < w; x++) {
      const fx = x / cell, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
      const a = g[y0 * gw + x0] * (1 - sx) + g[y0 * gw + x0 + 1] * sx;
      const b = g[(y0 + 1) * gw + x0] * (1 - sx) + g[(y0 + 1) * gw + x0 + 1] * sx;
      out[y * w + x] = a * (1 - sy) + b * sy;
    }
  }
  return out;
}

/**
 * A rubber stamp's texture, from the seed, by `amount` from 0 (none) to 1. Uneven density across the stamp (pressed
 * harder on one side), fine grain, small specks where the ink did not take, rougher edges. The strongest setting
 * still keeps four fifths of the ink in the lightest parts, so the words stay readable.
 */
export function rubber(pl: Plane, seed: number, amount: number): Plane {
  const t = clamp01(amount);
  const { width: w, height: h } = pl;
  const v = new Float32Array(pl.v);
  if (t <= 0) return { width: w, height: h, v };
  const r = rng(seed);
  const side = Math.max(w, h);
  const coarse = valueNoise(w, h, Math.max(8, side / 4.5), r);
  const middle = valueNoise(w, h, Math.max(4, side / 14), r);
  const fine = valueNoise(w, h, Math.max(1.5, side / 260), r);
  // Pressed a little harder on one side.
  const ang = r() * Math.PI * 2, cx = Math.cos(ang), cy = Math.sin(ang);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (v[p] <= 0) continue;
      const lean = ((x / w - 0.5) * cx + (y / h - 0.5) * cy + 0.71) / 1.42;
      let k = 1 - t * (0.2 * coarse[p] + 0.1 * middle[p] + 0.1 * lean);
      // The edges of a mark are where rubber leaves it ragged.
      if (v[p] < 0.92) k *= 1 - t * 0.5 * fine[p] * (1 - v[p]);
      v[p] *= k * (1 - t * 0.08 * r());
    }
  // Specks: small spots where the ink did not take. About one for every 2,500 pixels at full strength.
  const scale = side / 600;
  const specks = Math.round((t * w * h) / 2500);
  for (let n = 0; n < specks; n++) {
    const sx = r() * w, sy = r() * h, rad = (0.6 + r() * 1.6) * Math.max(0.6, scale), depth = 0.45 + r() * 0.45;
    const x0 = Math.max(0, Math.floor(sx - rad)), x1 = Math.min(w - 1, Math.ceil(sx + rad));
    const y0 = Math.max(0, Math.floor(sy - rad)), y1 = Math.min(h - 1, Math.ceil(sy + rad));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const dd = Math.hypot(x + 0.5 - sx, y + 0.5 - sy) / rad;
        if (dd < 1) v[y * w + x] *= 1 - depth * (1 - dd * dd);
      }
  }
  return { width: w, height: h, v };
}

/** A very slight softening: ink spreads into paper a little. `amount` 0 leaves the plane as it is. */
export function soften(pl: Plane, amount: number): Plane {
  const { width: w, height: h } = pl;
  const k = clamp01(amount);
  if (k <= 0) return pl;
  const v = new Float32Array(pl.v.length);
  const at = (x: number, y: number) => pl.v[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const blur = (4 * at(x, y) + 2 * (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) + at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 16;
      v[y * w + x] = at(x, y) * (1 - k) + blur * k;
    }
  return { width: w, height: h, v };
}

// ---- 5. Tilt -------------------------------------------------------------------------------------------------

/** Turned by `deg` degrees (clockwise, as on screen) about its centre, on a canvas large enough to hold all of it. */
export function rotatePlane(pl: Plane, deg: number): Plane {
  if (!deg) return pl;
  const { width: w, height: h } = pl;
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const nw = Math.ceil(Math.abs(w * c) + Math.abs(h * s)), nh = Math.ceil(Math.abs(w * s) + Math.abs(h * c));
  const v = new Float32Array(nw * nh);
  const cx = w / 2, cy = h / 2, ncx = nw / 2, ncy = nh / 2;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : pl.v[y * w + x]);
  for (let y = 0; y < nh; y++)
    for (let x = 0; x < nw; x++) {
      // Where this pixel comes from: turned back by the same angle.
      const dx = x + 0.5 - ncx, dy = y + 0.5 - ncy;
      const sx = dx * c + dy * s + cx - 0.5, sy = -dx * s + dy * c + cy - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
      v[y * nw + x] = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
    }
  return { width: nw, height: nh, v };
}

// ---- 6. Colour -----------------------------------------------------------------------------------------------

/** The impression as pixels: every pixel the ink's colour, as see-through as the ink is faint. */
export function colourise(pl: Plane, ink: Ink): Rgba {
  const [r, g, b] = INK_RGB[ink];
  const data = new Uint8ClampedArray(pl.width * pl.height * 4);
  for (let p = 0; p < pl.v.length; p++) {
    data[p * 4] = r;
    data[p * 4 + 1] = g;
    data[p * 4 + 2] = b;
    data[p * 4 + 3] = Math.round(clamp01(pl.v[p]) * 255);
  }
  return { width: pl.width, height: pl.height, data };
}

// ---- All of it -----------------------------------------------------------------------------------------------

/** What is worked out once for a picture, so moving a slider only does the steps after it. */
export type Prepared = { img: Rgba; paper: Uint8ClampedArray; dist: Float32Array; found: InkFound };

export function prepare(picture: Rgba): Prepared {
  const img = onWhite(picture);
  const paper = paperOf(img);
  const dist = inkDistance(img, paper);
  const found = findInk(img, paper, dropEdgeMarks(strengthOf(dist, img.width, img.height)));
  return { img, paper, dist, found };
}

export type Impression = {
  image: Rgba;
  /** No ink was left: the picture is blank paper, or the settings took everything away. */
  empty: boolean;
  found: InkFound;
};

/** The finished impression for these settings. The same picture and the same settings give the same pixels. */
export function impression(p: Prepared, look: Look, maxSide = STAMP_OUT_MAX_SIDE): Impression {
  const { img } = p;
  let pl = strengthOf(p.dist, img.width, img.height, look.paper);
  if (look.onlyInk) pl = onlyInk(img, p.paper, pl, p.found);
  if (look.crop) {
    const c = look.crop;
    const x0 = Math.round(img.width * clamp01(c.left)), y0 = Math.round(img.height * clamp01(c.top));
    const x1 = Math.round(img.width * (1 - clamp01(c.right))), y1 = Math.round(img.height * (1 - clamp01(c.bottom)));
    pl = cropPlane(pl, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  }
  pl = dropEdgeMarks(pl);
  // A faint stamp is brought up to full strength, so it reads like ink and not like a ghost. Never more than half
  // again, and only upwards: strong ink stays as it was.
  const strong: number[] = [];
  for (let i = 0; i < pl.v.length; i += 3) if (pl.v[i] > 0.2) strong.push(pl.v[i]);
  if (strong.length > 20) {
    strong.sort((a, b) => a - b);
    const top = strong[Math.floor(strong.length * 0.96)];
    const k = Math.min(1.5, 1 / Math.max(0.01, top));
    if (k > 1.02) for (let i = 0; i < pl.v.length; i++) pl.v[i] = Math.min(1, pl.v[i] * k);
  }
  let box = inkBox(pl);
  if (!box) return { image: colourise({ width: 1, height: 1, v: new Float32Array(1) }, look.ink), empty: true, found: p.found };
  pl = cropPlane(pl, box.x, box.y, box.w, box.h);
  // Texture and softening at the size it will be stored, so a speck is the same size whatever the photo was.
  pl = shrinkPlane(pl, maxSide * 0.94);
  pl = rubber(pl, look.seed, look.texture);
  pl = soften(pl, 0.2 + 0.25 * clamp01(look.texture));
  pl = rotatePlane(pl, Math.max(-TILT_MAX, Math.min(TILT_MAX, look.tilt || 0)));
  box = inkBox(pl, 0.02);
  if (box) pl = cropPlane(pl, box.x, box.y, box.w, box.h);
  pl = shrinkPlane(pl, maxSide);
  return { image: colourise(pl, look.ink), empty: false, found: p.found };
}
