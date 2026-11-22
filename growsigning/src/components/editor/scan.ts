// Cleaner scans, in the browser: find the page in a photo (the largest four-sided bright shape), straighten it, and
// raise its contrast so the writing reads as on a scan. Plain numbers in, plain numbers out: an RGBA picture as a
// canvas gives it (ImageData), so tests/ds-phone-app.test.ts runs it under Node on sample photos. No library: the
// steps are small enough to write here, and nothing is sent anywhere to do them.
//
// It only acts when it is sure: a page that fills the whole photo, a photo with no clear page in it, or a shape that
// is not close to four-sided is left as it is (cleanPage gives back null). The sender can always undo it.

export type Pixels = { width: number; height: number; data: Uint8ClampedArray | Uint8Array };
export type Point = { x: number; y: number };

/** How large the picture is looked at to find the page. Small is fast and ignores the writing on the page. */
const LOOK = 480;

/** The picture made smaller, as brightness (0 to 255) minus a part of its colour: paper is bright and grey. */
function paperness(p: Pixels, scale: number): { w: number; h: number; v: Float32Array } {
  const w = Math.max(8, Math.round(p.width * scale)), h = Math.max(8, Math.round(p.height * scale));
  const v = new Float32Array(w * h);
  const n = new Float32Array(w * h);
  for (let y = 0; y < p.height; y++) {
    const ty = Math.min(h - 1, Math.floor(y * scale));
    for (let x = 0; x < p.width; x++) {
      const i = (y * p.width + x) * 4;
      const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const t = ty * w + Math.min(w - 1, Math.floor(x * scale));
      v[t] += 0.299 * r + 0.587 * g + 0.114 * b - 0.6 * (max - min);
      n[t]++;
    }
  }
  for (let i = 0; i < v.length; i++) v[i] = n[i] ? v[i] / n[i] : 0;
  return { w, h, v };
}

/** Otsu's threshold: the value that best splits the values into two groups. */
function otsu(v: Float32Array): number {
  const hist = new Array(256).fill(0);
  for (const x of v) hist[Math.max(0, Math.min(255, Math.round(x)))]++;
  const total = v.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, at = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) (best = between), (at = t);
  }
  return at;
}

/** The largest group of touching bright cells, with its holes (the writing) filled in. */
function largestBlob(mask: Uint8Array, w: number, h: number): Uint8Array | null {
  const label = new Int32Array(w * h).fill(-1);
  let bestId = -1, bestSize = 0;
  const stack: number[] = [];
  let id = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    let size = 0;
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % w, y = (i - x) / w;
      if (x > 0 && mask[i - 1] && label[i - 1] < 0) (label[i - 1] = id), stack.push(i - 1);
      if (x < w - 1 && mask[i + 1] && label[i + 1] < 0) (label[i + 1] = id), stack.push(i + 1);
      if (y > 0 && mask[i - w] && label[i - w] < 0) (label[i - w] = id), stack.push(i - w);
      if (y < h - 1 && mask[i + w] && label[i + w] < 0) (label[i + w] = id), stack.push(i + w);
    }
    if (size > bestSize) (bestSize = size), (bestId = id);
    id++;
  }
  if (bestId < 0) return null;
  // Fill the holes: everything outside the blob that the border cannot reach is inside the page.
  const out = new Uint8Array(w * h);
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = label[i] === bestId ? 1 : 0;
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) if (!out[y * w + x] && !outside[y * w + x]) (outside[y * w + x] = 1), stack.push(y * w + x);
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) if (!out[y * w + x] && !outside[y * w + x]) (outside[y * w + x] = 1), stack.push(y * w + x);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !out[j] && !outside[j]) (outside[j] = 1), stack.push(j);
  }
  for (let i = 0; i < w * h; i++) if (!outside[i]) out[i] = 1;
  return out;
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const area = (q: Point[]) => Math.abs(q.reduce((s, p, i) => s + p.x * q[(i + 1) % q.length].y - q[(i + 1) % q.length].x * p.y, 0)) / 2;

/** The convex hull of the points (Andrew's monotone chain), going round one way. */
function hull(points: Point[]): Point[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const lower: Point[] = [], upper: Point[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The hull cut down to four corners, each time dropping the corner whose loss costs the least area. */
function toQuad(h: Point[]): Point[] | null {
  const q = [...h];
  while (q.length > 4) {
    let least = Infinity, at = -1;
    for (let i = 0; i < q.length; i++) {
      const a = q[(i - 1 + q.length) % q.length], b = q[i], c = q[(i + 1) % q.length];
      const lost = Math.abs(cross(a, b, c)) / 2;
      if (lost < least) (least = lost), (at = i);
    }
    q.splice(at, 1);
  }
  return q.length === 4 ? q : null;
}

/**
 * Sharper corners: a straight line is fitted through the edge points along each side (leaving out the parts near
 * the corners, which are round after making the picture small), and the corners are where those lines meet.
 */
function refine(q: Point[], edge: Point[]): Point[] {
  const lines: { p: Point; d: Point }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const near = edge.filter((p) => {
      const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / len;
      const off = Math.abs((p.x - a.x) * d.y - (p.y - a.y) * d.x);
      return t > 0.12 && t < 0.88 && off < 4;
    });
    if (near.length < 8) return q;
    // The line through their middle along their main direction (least squares across the line).
    const mx = near.reduce((s, p) => s + p.x, 0) / near.length, my = near.reduce((s, p) => s + p.y, 0) / near.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of near) (sxx += (p.x - mx) ** 2), (sxy += (p.x - mx) * (p.y - my)), (syy += (p.y - my) ** 2);
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    lines.push({ p: { x: mx, y: my }, d: { x: Math.cos(angle), y: Math.sin(angle) } });
  }
  const out: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const l1 = lines[(i + 3) % 4], l2 = lines[i];
    const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
    if (Math.abs(den) < 1e-6) return q;
    const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
    const c = { x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t };
    // A corner that moved far is a fit gone wrong: keep the first one.
    out.push(Math.hypot(c.x - q[i].x, c.y - q[i].y) > 12 ? q[i] : c);
  }
  return out;
}

/** The four corners in the order top left, top right, bottom right, bottom left. */
export function orderCorners(q: Point[]): Point[] {
  const cx = q.reduce((s, p) => s + p.x, 0) / 4, cy = q.reduce((s, p) => s + p.y, 0) / 4;
  const round = [...q].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // Going round with y down, atan2 order is clockwise on screen. Start at the corner nearest the top left.
  let start = 0;
  round.forEach((p, i) => { if (p.x + p.y < round[start].x + round[start].y) start = i; });
  return [...round.slice(start), ...round.slice(0, start)];
}

/**
 * Where the page is in the photo, as four corners in the photo's pixels, or null when there is no clear page: none
 * found, it fills (nearly) the whole photo, it is small, or its shape is not close to four-sided with square-ish
 * corners.
 */
export function findPage(p: Pixels): Point[] | null {
  const scale = Math.min(1, LOOK / Math.max(p.width, p.height));
  const { w, h, v } = paperness(p, scale);
  const t = otsu(v);
  // Too little difference between page and background to tell them apart.
  let lo = 0, hi = 0, nlo = 0, nhi = 0;
  for (const x of v) if (x > t) (hi += x), nhi++; else (lo += x), nlo++;
  if (!nlo || !nhi || hi / nhi - lo / nlo < 40) return null;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < v.length; i++) mask[i] = v[i] > t ? 1 : 0;
  const blob = largestBlob(mask, w, h);
  if (!blob) return null;
  let count = 0;
  const edge: Point[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!blob[i]) continue;
      count++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !blob[i - 1] || !blob[i + 1] || !blob[i - w] || !blob[i + w]) edge.push({ x: x + 0.5, y: y + 0.5 });
    }
  const share = count / (w * h);
  if (share < 0.15 || share > 0.92) return null;
  const quad = toQuad(hull(edge));
  if (!quad) return null;
  // The blob must be close to its four-sided outline, or it is not a page (a hand, a round plate, two pages).
  const fit = count / area(quad);
  if (fit < 0.9 || fit > 1.12) return null;
  const q = refine(orderCorners(quad), edge);
  // Every corner between 50 and 130 degrees, and no side very short: a page seen from an angle, not a sliver.
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
    if (l1 < Math.min(w, h) * 0.15 || l2 < Math.min(w, h) * 0.15) return null;
    const deg = (Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)))) * 180) / Math.PI;
    if (deg < 50 || deg > 130) return null;
  }
  return q.map((pt) => ({ x: pt.x / scale, y: pt.y / scale }));
}

/** Solves the 8 numbers that map the unit square's corners onto the four corners given. */
function squareToQuad(q: Point[]): number[] {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = den ? (dx3 * dy2 - dx2 * dy3) / den : 0;
  const hh = den ? (dx1 * dy3 - dx3 * dy1) / den : 0;
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + hh * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + hh * p3.y, p0.y, g, hh];
}

/** The size of the straightened page: its longest sides, kept within `max` pixels. */
export function pageSize(q: Point[], max: number): { w: number; h: number } {
  const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = Math.max(d(q[0], q[1]), d(q[3], q[2])), h = Math.max(d(q[0], q[3]), d(q[1], q[2]));
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** The page cut out of the photo and made straight and upright, `w` by `h` pixels. */
export function straighten(p: Pixels, q: Point[], w: number, h: number): Pixels {
  const [a, b, c, d, e, f, g, hh] = squareToQuad(q);
  const out = new Uint8ClampedArray(w * h * 4);
  const W = p.width, H = p.height, src = p.data;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const z = g * u + hh * v + 1;
      const sx = Math.max(0, Math.min(W - 1.001, (a * u + b * v + c) / z - 0.5));
      const sy = Math.max(0, Math.min(H - 1.001, (d * u + e * v + f) / z - 0.5));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++)
        out[o + k] = (src[i00 + k] * (1 - fx) + src[i10 + k] * fx) * (1 - fy) + (src[i01 + k] * (1 - fx) + src[i11 + k] * fx) * fy;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Makes the paper white and the writing dark, keeping its colour: each part of the page is divided by how bright the
 * paper is around it (so a shadow across the page goes too), then the darkest few in a hundred become black.
 */
export function brighten(p: Pixels): Pixels {
  const { width: w, height: h, data } = p;
  const B = Math.max(8, Math.round(Math.max(w, h) / 24));
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  // The paper's brightness in each block: a high value among its pixels, so writing does not count.
  const paper = new Float32Array(bw * bh);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const vals: number[] = [];
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y += 2) for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x += 2) vals.push(lum[y * w + x]);
      vals.sort((s, t) => s - t);
      paper[by * bw + bx] = Math.max(40, vals[Math.floor(vals.length * 0.9)] || 255);
    }
  const out = new Uint8ClampedArray(w * h * 4);
  const flat = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.max(0, Math.min(bh - 1.001, (y + 0.5) / B - 0.5)), y0 = Math.floor(gy), fy = gy - y0, y1 = Math.min(bh - 1, y0 + 1);
    for (let x = 0; x < w; x++) {
      const gx = Math.max(0, Math.min(bw - 1.001, (x + 0.5) / B - 0.5)), x0 = Math.floor(gx), fx = gx - x0, x1 = Math.min(bw - 1, x0 + 1);
      const bg = (paper[y0 * bw + x0] * (1 - fx) + paper[y0 * bw + x1] * fx) * (1 - fy) + (paper[y1 * bw + x0] * (1 - fx) + paper[y1 * bw + x1] * fx) * fy;
      flat[y * w + x] = Math.min(1, lum[y * w + x] / bg);
    }
  }
  // Black point: where the darkest 2% begin, but never above 0.6 of the paper, so a page with little writing keeps it.
  const sorted = Array.from(flat.filter((_, i) => i % 7 === 0)).sort((s, t) => s - t);
  const black = Math.min(0.6, sorted[Math.floor(sorted.length * 0.02)] ?? 0);
  for (let i = 0; i < w * h; i++) {
    const f = flat[i];
    // Near-white becomes white; the rest is stretched from the black point and darkened a little.
    const t = f > 0.92 ? 1 : Math.pow(Math.max(0, (f - black) / (0.92 - black)), 1.4);
    const gain = lum[i] > 0 ? (t * 255) / lum[i] : 0;
    for (let k = 0; k < 3; k++) {
      // Colour is kept but pulled towards grey, so blue ink stays blue and paper tints go.
      const c = data[i * 4 + k] * gain;
      out[i * 4 + k] = t * 255 + (c - t * 255) * 0.6;
    }
    out[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/** The whole cleanup: the page found, straightened to at most `max` pixels on its long side, and brightened. */
export function cleanPage(p: Pixels, max = 2000): { page: Pixels; corners: Point[] } | null {
  const corners = findPage(p);
  if (!corners) return null;
  const size = pageSize(corners, max);
  return { page: brighten(straighten(p, corners, size.w, size.h)), corners };
}
