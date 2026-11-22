// QR codes, drawn by the product itself. No dependency and no network: a signing link or a form link never leaves
// the browser to be turned into a picture. Pages and tests import this file. It imports nothing.
//
// What is built is QR Code Model 2 as described in ISO/IEC 18004: byte mode, error correction level M (the code
// still reads with about 15% of it damaged or covered), versions 1 to 40, and the mask with the lowest penalty out
// of all eight. Text goes in as UTF-8 with no ECI header, which is what phone cameras expect.
//
// A wrong QR code looks exactly like a right one and does not scan. So tests/qr.test.ts reads every version back
// with a reader written apart from this file, and holds matrices that outside decoders have read.

export type Qr = { version: number; size: number; mask: number; modules: boolean[][] };

/** The light margin a reader needs around a code, in modules. The standard asks for four. */
export const QR_QUIET = 4;
/** The most bytes one code holds at level M (version 40). A link of plain letters and digits is one byte a character. */
export const QR_MAX_BYTES = 2331;

export class QrTooLong extends Error {
  bytes: number;
  constructor(bytes: number) {
    super(`This is too long for a QR code: it is ${bytes} bytes and a code holds ${QR_MAX_BYTES} at most.`);
    this.name = 'QrTooLong';
    this.bytes = bytes;
  }
}

// Level M, for versions 1 to 40 (place 0 is not used): error correction codewords in each block, and how many
// blocks the codewords are split into. From table 9 of the standard.
const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

/** Modules along one side: 21 for version 1, four more for each version after. */
export const qrSize = (version: number) => 17 + 4 * version;

/** Where the centres of the small alignment squares sit, along either axis. Version 1 has none. */
export function qrAlignment(version: number): number[] {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  // The squares are spread evenly from the far edge inwards, an even number of modules apart. The first always
  // sits on the timing line, at 6. Version 32 is the one place where the table of the standard is not this sum.
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const at = [6];
  for (let i = n - 2; i >= 0; i--) at.push(qrSize(version) - 7 - i * step);
  return at;
}

// Modules that carry data or error correction: everything that is not a finder, separator, timing line, alignment
// square, format or version information, or the one dark module.
function rawModules(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const a = Math.floor(version / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (version: number) => (rawModules(version) >>> 3) - EC_PER_BLOCK[version] * BLOCKS[version];
// Byte mode spends 4 bits on saying so and 8 bits (16 from version 10) on the length.
const lengthBits = (version: number) => (version < 10 ? 8 : 16);

/** How many bytes a code of this version holds at level M. */
export const qrCapacity = (version: number) => Math.floor((dataCodewords(version) * 8 - 4 - lengthBits(version)) / 8);

// ---- Reed-Solomon over GF(256), with the field polynomial of the standard: x^8 + x^4 + x^3 + x^2 + 1 --------------

const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = EXP[i + 255] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

// The generator: (x - 2^0)(x - 2^1)...(x - 2^(degree-1)), highest power first, without its leading 1.
function generator(degree: number): Uint8Array {
  const g = new Uint8Array(degree);
  g[degree - 1] = 1;
  for (let i = 0, root = 1; i < degree; i++, root = mul(root, 2))
    for (let j = 0; j < degree; j++) g[j] = mul(g[j], root) ^ (j + 1 < degree ? g[j + 1] : 0);
  return g;
}
// What is left over when the data, followed by as many zeros as there are error correction codewords, is divided
// by the generator. Those leftovers are the error correction codewords.
function remainder(data: Uint8Array, g: Uint8Array): Uint8Array {
  const r = new Uint8Array(g.length);
  for (const b of data) {
    const f = b ^ r[0];
    r.copyWithin(0, 1);
    r[r.length - 1] = 0;
    for (let i = 0; i < r.length; i++) r[i] ^= mul(g[i], f);
  }
  return r;
}

// ---- From text to the codewords in the order they are drawn -------------------------------------------------------

function codewords(data: Uint8Array, version: number): Uint8Array {
  const room = dataCodewords(version);
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(data.length, lengthBits(version));
  for (const b of data) put(b, 8);
  // The end mark is four zeros, or fewer when there is no room left. Then zeros up to a whole byte, then the two
  // filler bytes of the standard in turn until the room is used up.
  put(0, Math.min(4, room * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let fill = 0xec; bits.length < room * 8; fill ^= 0xec ^ 0x11) put(fill, 8);
  const plain = new Uint8Array(room);
  bits.forEach((bit, i) => (plain[i >>> 3] |= bit << (7 - (i & 7))));

  // Split into blocks, the shorter ones first, each with its own error correction. Then deal them out like cards:
  // the first codeword of every block, the second of every block, and so on. A scratch then harms a little of
  // each block and not all of one.
  const blocks = BLOCKS[version];
  const ec = EC_PER_BLOCK[version];
  const all = rawModules(version) >>> 3;
  const short = blocks - (all % blocks);
  const len = Math.floor(all / blocks) - ec;
  const g = generator(ec);
  const parts: { d: Uint8Array; e: Uint8Array }[] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const d = plain.subarray(k, (k += len + (i < short ? 0 : 1)));
    parts.push({ d, e: remainder(d, g) });
  }
  const out = new Uint8Array(all);
  let o = 0;
  for (let i = 0; i <= len; i++) for (const p of parts) if (i < p.d.length) out[o++] = p.d[i];
  for (let i = 0; i < ec; i++) for (const p of parts) out[o++] = p.e[i];
  return out;
}

// ---- The fixed parts of the picture --------------------------------------------------------------------------------

type Grid = { size: number; dark: boolean[][]; fixed: boolean[][] };

function frame(version: number): Grid {
  const size = qrSize(version);
  const dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, on: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    dark[y][x] = on;
    fixed[y][x] = true;
  };
  // Timing lines: every second module dark, along row 6 and column 6.
  for (let i = 0; i < size; i++) (set(6, i, i % 2 === 0), set(i, 6, i % 2 === 0));
  // Three finders, each a 7 by 7 square with a light ring inside it and a light separator around it.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, ring !== 2 && ring !== 4);
    }
  // Alignment squares, 5 by 5, wherever two centres cross, except where a finder already is.
  const at = qrAlignment(version);
  const last = at.length - 1;
  at.forEach((cy, i) => at.forEach((cx, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  // From version 7 the code says which version it is, twice, 18 bits each: 6 for the number and 12 to repair it.
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }
  // The format places are kept free here and filled in for each mask.
  format({ size, dark, fixed }, 0);
  return { size, dark, fixed };
}

// The 15 format bits say which error correction level and which mask were used: 5 bits of data, 10 to repair them,
// and a fixed pattern laid over all of it so that the result is never all light. They are drawn twice.
function format(g: Grid, mask: number) {
  const data = (0b00 << 3) | mask; // 00 is level M
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const set = (x: number, y: number, i: number) => {
    g.dark[y][x] = ((bits >>> i) & 1) === 1;
    g.fixed[y][x] = true;
  };
  for (let i = 0; i <= 5; i++) set(8, i, i);
  set(8, 7, 6);
  set(8, 8, 7);
  set(7, 8, 8);
  for (let i = 9; i < 15; i++) set(14 - i, 8, i);
  for (let i = 0; i < 8; i++) set(g.size - 1 - i, 8, i);
  for (let i = 8; i < 15; i++) set(8, g.size - 15 + i, i);
  // One module next to the lower left finder is always dark.
  g.dark[g.size - 8][8] = true;
  g.fixed[g.size - 8][8] = true;
}

// The eight masks of the standard. x is the column and y the row, both counted from the top left.
const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// ---- How hard a finished picture is to read: the four rules of the standard (7.8.3) -------------------------------

const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;

/**
 * The penalty of a finished code. Lower reads better. The four rules:
 * 1. five or more modules of one colour in a row or column: 3, and 1 more for each module beyond five;
 * 2. every 2 by 2 block of one colour: 3;
 * 3. dark, light, dark, light, dark in the widths 1:1:3:1:1 (what a finder looks like) with a light stretch four
 *    widths long before or after it: 40 for each side that has one. The margin around the code counts as light;
 * 4. 10 for every full 5% that the share of dark modules is away from half.
 */
export function qrPenalty(m: boolean[][]): number {
  const size = m.length;
  let points = 0;
  let dark = 0;
  for (let across = 0; across < 2; across++) for (let a = 0; a < size; a++) {
    // The line as runs of one colour, starting and ending with a light run (which may be empty). The margin is
    // added to both ends afterwards, for rule 3 only.
    const runs = [0];
    let colour = false;
    for (let b = 0; b < size; b++) {
      const on = across ? m[b][a] : m[a][b];
      if (on !== colour) (runs.push(0), (colour = on));
      const run = ++runs[runs.length - 1];
      if (run === 5) points += N1;
      else if (run > 5) points++;
      if (on && !across) dark++;
    }
    if (colour) runs.push(0);
    runs[0] += size;
    runs[runs.length - 1] += size;
    // Dark runs are at the odd places. i is the wide one in the middle.
    for (let i = 3; i + 3 < runs.length; i += 2) {
      const w = runs[i - 1];
      if (runs[i] !== 3 * w || runs[i - 2] !== w || runs[i + 1] !== w || runs[i + 2] !== w) continue;
      const before = runs[i - 3];
      const after = runs[i + 3];
      if (before >= 4 * w && after >= w) points += N3;
      if (after >= 4 * w && before >= w) points += N3;
    }
  }
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++)
    if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) points += N2;
  const total = size * size;
  points += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * N4;
  return points;
}

// ---- Putting it together -------------------------------------------------------------------------------------------

/**
 * Makes the code for a text. `mask` forces one of the eight masks (0 to 7), which only tests need: left out, all
 * eight are tried and the one with the lowest penalty is kept (the lowest number wins a tie).
 * Throws QrTooLong when the text does not fit in the largest code.
 */
export function qrEncode(text: string, opts: { mask?: number } = {}): Qr {
  const data = new TextEncoder().encode(String(text));
  let version = 1;
  while (version <= 40 && qrCapacity(version) < data.length) version++;
  if (version > 40) throw new QrTooLong(data.length);
  const g = frame(version);
  const { size } = g;

  // The codewords snake up and down through columns two modules wide, from the lower right corner to the left,
  // stepping over column 6 (the timing line) and over every fixed module. Places left at the end stay light.
  const cw = codewords(data, version);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const up = ((right + 1) & 2) === 0; // the first pair of columns goes up, the next down, and so on
    for (let step = 0; step < size; step++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = up ? size - 1 - step : step;
      if (g.fixed[y][x] || i >= cw.length * 8) continue;
      g.dark[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
      i++;
    }
  }

  const masked = (mask: number): boolean[][] => {
    format(g, mask);
    return g.dark.map((row, y) => row.map((on, x) => (g.fixed[y][x] ? on : on !== MASKS[mask](x, y))));
  };
  const forced = opts.mask;
  if (forced !== undefined) {
    if (!Number.isInteger(forced) || forced < 0 || forced > 7) throw new RangeError('A mask is a whole number from 0 to 7.');
    return { version, size, mask: forced, modules: masked(forced) };
  }
  let best: Qr | null = null;
  let least = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const modules = masked(mask);
    const p = qrPenalty(modules);
    if (p < least) (least = p), (best = { version, size, mask, modules });
  }
  return best!;
}

/**
 * The code as an SVG picture: a white square with the margin a reader needs, and the dark modules as one path.
 * Nothing of the text is written into the picture, only where the dark modules are, so no text can break out of it.
 * `quiet` is the margin in modules and is never less than four. `px` sets a width and height for a file that is
 * saved; left out, the picture takes the size of whatever holds it.
 */
export function qrSvg(text: string | Qr, opts: { quiet?: number; px?: number; mask?: number } = {}): string {
  const q = typeof text === 'string' ? qrEncode(text, { mask: opts.mask }) : text;
  const quiet = Math.max(QR_QUIET, Math.floor(Number(opts.quiet) || 0));
  const side = q.size + 2 * quiet;
  let d = '';
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) {
    if (!q.modules[y][x]) continue;
    let w = 1;
    while (x + w < q.size && q.modules[y][x + w]) w++;
    d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
    x += w - 1;
  }
  const px = Math.floor(Number(opts.px) || 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"${px > 0 ? ` width="${px}" height="${px}"` : ''} shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
