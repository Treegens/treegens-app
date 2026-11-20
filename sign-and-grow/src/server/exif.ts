// Which way up a photo is. A phone camera stores the picture the way the sensor saw it and writes a small note
// beside it (EXIF tag 0x0112, "orientation") that says how to turn it for viewing. A browser reads the note, the
// PDF format does not. If the note is ignored, a photo taken with the phone upright sits sideways in the signed PDF
// while it looked upright on screen, and a field placed on a line on screen is not on that line in the PDF. So the
// note is read here, the picture is drawn the way the note says, and the note in the stored bytes is then set to
// "already upright" so no viewer turns it a second time (see imagesToPdf() in pdf.ts).
//
// The eight values, as the EXIF standard names them: 1 upright, 2 mirrored left to right, 3 upside down, 4 mirrored
// top to bottom, 5 mirrored and turned, 6 needs a quarter turn clockwise, 7 mirrored and turned the other way,
// 8 needs a quarter turn anticlockwise. Phones write 1, 3, 6 and 8.

import { PNG_MAX_PIXELS, JPEG_MAX_PIXELS } from '../lib/policy.ts';

export type Orientation = { value: number; at: number; little: boolean };

const u16 = (b: Uint8Array, at: number, little: boolean) => (little ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1]);
const u32 = (b: Uint8Array, at: number, little: boolean) => (little ? u16(b, at, true) + u16(b, at + 2, true) * 65536 : u16(b, at, false) * 65536 + u16(b, at + 2, false));

// The orientation written into a JPEG, with the place in the file where it is written, or null when the file says
// nothing (then it is upright as stored). Reads nothing past the end of the file, whatever the file claims.
export function jpegOrientation(b: Uint8Array): Orientation | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1];
    if (marker === 0xff) { p++; continue; } // a fill byte before a marker
    // The picture data starts here. The note always comes before it.
    if (marker === 0xda || marker === 0xd9) return null;
    const len = u16(b, p + 2, false);
    if (len < 2 || p + 2 + len > b.length) return null;
    // APP1 that starts with "Exif\0\0" holds a small TIFF file: a byte order mark, then a list of 12 byte entries.
    if (marker === 0xe1 && len >= 16 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66 && b[p + 8] === 0 && b[p + 9] === 0) {
      const tiff = p + 10;
      const end = p + 2 + len;
      const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
      if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return null;
      if (u16(b, tiff + 2, little) !== 42) return null;
      const dir = tiff + u32(b, tiff + 4, little);
      if (dir + 2 > end) return null;
      const count = u16(b, dir, little);
      for (let i = 0; i < count; i++) {
        const e = dir + 2 + i * 12;
        if (e + 12 > end) return null;
        if (u16(b, e, little) !== 0x0112) continue;
        // A SHORT, as the standard says. Anything else is not a note we know how to read or to rewrite.
        if (u16(b, e + 2, little) !== 3 || u32(b, e + 4, little) !== 1) return null;
        const value = u16(b, e + 8, little);
        return value >= 1 && value <= 8 ? { value, at: e + 8, little } : null;
      }
      return null;
    }
    p += 2 + len;
  }
  return null;
}

// A copy of the JPEG whose note says "upright as stored". The picture data is not touched.
export function markUpright(b: Uint8Array, o: Orientation): Uint8Array {
  const out = new Uint8Array(b);
  out[o.at] = o.little ? 1 : 0;
  out[o.at + 1] = o.little ? 0 : 1;
  return out;
}

// Where the stored picture goes on the page so that it is seen upright: the PDF matrix [a b c d e f] that maps the
// unit square of the stored picture onto the box x, y (bottom left), w, h (the size of the upright picture). For 5
// to 8 the stored picture lies on its side, so its width runs along the height of the box.
export function uprightMatrix(value: number, x: number, y: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (value) {
    case 2: return [-w, 0, 0, h, x + w, y];
    case 3: return [-w, 0, 0, -h, x + w, y + h];
    case 4: return [w, 0, 0, -h, x, y + h];
    case 5: return [0, -h, -w, 0, x + w, y + h];
    case 6: return [0, -h, w, 0, x, y + h];
    case 7: return [0, h, w, 0, x, y];
    case 8: return [0, h, -w, 0, x + w, y];
    default: return [w, 0, 0, h, x, y];
  }
}
export const liesOnItsSide = (value: number) => value >= 5 && value <= 8;

// ---- How many pixels a picture says it has ------------------------------------------------------------
// Read from the header, before a pixel is unpacked. A PNG is unpacked in full on the server to go into a PDF (and
// a small file can claim to be enormous), a JPEG on every signer's phone. So an absurd picture is refused in words
// before it costs anyone memory. pdf-lib reads the same header fields.

/** The width and height a PNG or JPEG gives in its header, or null when the header cannot be read. */
export function pictureSize(b: Uint8Array, png: boolean): { w: number; h: number } | null {
  if (png) {
    // The signature, then the IHDR chunk: its length, "IHDR", the width and the height.
    if (b.length < 24 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
    return { w: u32(b, 16, false), h: u32(b, 20, false) };
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 <= b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    // A start-of-frame marker (C0 to CF, except C4, C8 and CC, which are tables) gives the height, then the width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: u16(b, p + 5, false), w: u16(b, p + 7, false) };
    const len = u16(b, p + 2, false);
    if (len < 2) return null;
    p += 2 + len;
  }
  return null;
}

/** Why this picture is refused for its number of pixels, or '' when it is fine (or its header cannot be read). */
export function pictureLimit(b: Uint8Array, png: boolean, name?: string): string {
  const size = pictureSize(b, png);
  const max = png ? PNG_MAX_PIXELS : JPEG_MAX_PIXELS;
  if (!size || size.w * size.h <= max) return '';
  const n = (x: number) => x.toLocaleString('en');
  const what = name ? `"${name}" is` : 'This picture is';
  return `${what} ${n(size.w)} by ${n(size.h)} pixels, which is ${n(Math.round((size.w * size.h) / 1e6))} million. A ${png ? 'PNG' : 'JPEG'} can have up to ${n(max / 1e6)} million, far more than a page needs. Make it smaller${png ? ' or save it as a JPEG' : ''}, then upload it again.${name ? ' No document was made.' : ''}`;
}
