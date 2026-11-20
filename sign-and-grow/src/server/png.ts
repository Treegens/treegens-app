import { inflateSync, deflateSync } from 'node:zlib';

// Reading and writing PNG files, enough for stamps (src/server/stamps.ts): the size and kind from the header, the
// file again without anything but its pixels (no text, no dates, no camera notes), and the pixels themselves for an
// 8-bit file. node:zlib does the compression. Nothing here trusts the file: every length is checked.

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type PngInfo = { width: number; height: number; bitDepth: number; colorType: number; interlace: number; chunks: { type: string; start: number; end: number; data: Buffer }[] };

/** The header and the chunks of a PNG, or null when the bytes are not a whole PNG file. */
export function readPng(bytes: Uint8Array): PngInfo | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 45 || !b.subarray(0, 8).equals(SIGNATURE)) return null;
  const chunks: PngInfo['chunks'] = [];
  let at = 8, ended = false;
  while (at + 12 <= b.length) {
    const len = b.readUInt32BE(at);
    const type = b.toString('latin1', at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || at + 12 + len > b.length) return null;
    chunks.push({ type, start: at, end: at + 12 + len, data: b.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || chunks[0]?.type !== 'IHDR' || chunks[0].data.length !== 13 || !chunks.some((c) => c.type === 'IDAT')) return null;
  const h = chunks[0].data;
  return { width: h.readUInt32BE(0), height: h.readUInt32BE(4), bitDepth: h[8], colorType: h[9], interlace: h[12], chunks };
}

/** The same picture with only what draws it: the header, the palette and its transparency, the pixels, the end. */
export function cleanPng(info: PngInfo, bytes: Uint8Array): Buffer {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keep = info.chunks.filter((c) => ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(c.type));
  return Buffer.concat([SIGNATURE, ...keep.map((c) => b.subarray(c.start, c.end))]);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * The pixels of an 8-bit PNG without a palette and not interlaced, as RGBA. Null for any other kind, or when the
 * pixel data does not add up. `maxPixels` stops a small file from unpacking into something huge.
 */
export function decodePng(bytes: Uint8Array, maxPixels = 4_000_000): { width: number; height: number; data: Uint8Array } | null {
  const info = readPng(bytes);
  if (!info || info.bitDepth !== 8 || info.interlace !== 0 || !(info.colorType in CHANNELS)) return null;
  const { width: w, height: h } = info;
  if (!w || !h || w * h > maxPixels) return null;
  const ch = CHANNELS[info.colorType];
  const stride = w * ch;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(info.chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)), { maxOutputLength: (stride + 1) * h + 1 });
  } catch {
    return null;
  }
  if (raw.length < (stride + 1) * h) return null;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0, up = y ? px[dst - stride + x] : 0, c = x >= ch && y ? px[dst - stride + x - ch] : 0;
      const v = raw[src + x];
      px[dst + x] = f === 0 ? v : f === 1 ? v + a : f === 2 ? v + up : f === 3 ? v + ((a + up) >> 1) : f === 4 ? v + paeth(a, up, c) : -1;
      if (f > 4) return null;
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const s = p * ch, d = p * 4;
    if (ch === 4) data.set(px.subarray(s, s + 4), d);
    else if (ch === 3) (data[d] = px[s], data[d + 1] = px[s + 1], data[d + 2] = px[s + 2], data[d + 3] = 255);
    else if (ch === 2) (data[d] = data[d + 1] = data[d + 2] = px[s], data[d + 3] = px[s + 1]);
    else (data[d] = data[d + 1] = data[d + 2] = px[s], data[d + 3] = 255);
  }
  return { width: w, height: h, data };
}
function paeth(a: number, b: number, c: number) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** RGBA pixels as an 8-bit PNG. `extra` chunks (a text chunk, say) go before the pixels, for tests of cleanPng. */
export function encodePng(img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, extra: { type: string; data: Buffer }[] = []): Buffer {
  const { width: w, height: h } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(img.data.buffer, img.data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), ...extra.map((c) => chunk(c.type, c.data)), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
