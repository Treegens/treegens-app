// Turning a signature into a picture without cutting any of its ink off. Used by the "Your signature" dialog
// (src/components/SignaturePad.tsx) for a typed name, typed initials and a drawn mark. No imports and no side
// effects, so tests/sig-clip.test.ts can run this very file in a real browser.
//
// Why this exists: handwriting fonts reach outside the box a browser reports as the width of the text. The tail of
// a "j", "f", "y" or "g" swings left of where the letter starts, a slanted last letter leans past where the text
// ends, and accents and loops go above and below the line. Text placed by its width alone loses that ink at the
// edge of the canvas. Here the real ink is measured first, the canvas is made big enough for all of it with room
// to spare on every side, and after drawing the pixels are read to make sure nothing reached an edge.

/** Clear space kept around the ink of every signature picture, in pixels of that picture. */
export const SIG_PAD = 6;
/** The widest the ink of a typed signature is drawn, in pixels. A longer name is drawn in smaller letters. */
export const TYPED_MAX_W = 860;
/** The letter size a typed signature starts from, and the smallest a long name is shrunk to. */
export const TYPED_SIZE = 104;
export const TYPED_MIN_SIZE = 10;
/** A name with spaces whose ink at full size is wider than this is written on two lines, so it is not a flat strip. */
export const TYPED_WRAP_OVER = 1200;
/** The distance between the two lines of such a name, as a share of the letter size. */
export const TYPED_LINE = 1.05;
/** The colour of signature ink: a dark blue, as from a pen. */
export const TYPED_INK = '#10243a';
// Pixels fainter than this are not ink (the soft outermost edge of a letter).
const FAINT = 8;

export type InkBox = { x0: number; y0: number; x1: number; y1: number };

/** Where the ink is in RGBA pixels: the smallest box holding every pixel that is not see-through. Null when blank. */
export function inkBox(d: ArrayLike<number>, w: number, h: number, faint = FAINT): InkBox | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (d[(y * w + x) * 4 + 3] > faint) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** True when ink reaches the outermost pixels of the canvas, so some of it may be missing past that edge. */
export const touchesEdge = (b: InkBox, w: number, h: number): boolean => b.x0 <= 0 || b.y0 <= 0 || b.x1 >= w - 1 || b.y1 >= h - 1;

const boxOf = (c: HTMLCanvasElement): InkBox | null => inkBox(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data, c.width, c.height);

function crop(src: HTMLCanvasElement, b: InkBox, doc: Document): string {
  const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
  const out = doc.createElement('canvas');
  out.width = w + SIG_PAD * 2;
  out.height = h + SIG_PAD * 2;
  out.getContext('2d')!.drawImage(src, b.x0, b.y0, w, h, SIG_PAD, SIG_PAD, w, h);
  return out.toDataURL('image/png');
}

/** Cuts the empty space around the ink away and keeps SIG_PAD clear pixels on every side. Null for a blank canvas. */
export function trimInk(src: HTMLCanvasElement, doc: Document = document): string | null {
  const b = boxOf(src);
  return b ? crop(src, b, doc) : null;
}

/**
 * True when a signature picture looks cut off at its left or right: the ink ends there in a straight wall of solid
 * pixels, as when a letter ran off the side of the canvas it was drawn on. Typed signatures made before the ink was
 * measured (see the top of this file) are like that, and so is a line drawn past the side of the pad. Ink that ends
 * by itself fades out over its last pixel, so it has no such wall. Top and bottom are not looked at: letters stand
 * on a line, so a flat bottom is how whole letters look. A photo, with no see-through part at all, is never called
 * cut: its edges are the edges of the photo.
 */
export function looksCut(d: ArrayLike<number>, w: number, h: number): boolean {
  const b = inkBox(d, w, h);
  if (!b) return false;
  const alpha = (x: number, y: number) => (y < 0 || y >= h ? 0 : d[(y * w + x) * 4 + 3]);
  let inked = 0;
  for (let i = 3; i < w * h * 4; i += 4) if (d[i] > FAINT) inked++;
  if (inked > w * h * 0.6) return false;
  // A wall: three or more solid pixels in a row in the outermost column of the ink, ending within two pixels at one
  // end at least. The rounded side of a tall letter can have a few solid pixels there too, but those fade in and
  // out over many pixels.
  const wall = (x: number) => {
    for (let y = 0, run = 0; y <= h; y++) {
      if (alpha(x, y) >= 250) run++;
      else {
        if (run >= 3 && (Math.min(alpha(x, y), alpha(x, y + 1)) < 128 || Math.min(alpha(x, y - run - 1), alpha(x, y - run - 2)) < 128)) return true;
        run = 0;
      }
    }
    return false;
  };
  return wall(b.x0) || wall(b.x1);
}

/** looksCut for a picture given as a data URL or address. False when it cannot be read. */
export async function pictureLooksCut(src: string, doc: Document = document): Promise<boolean> {
  try {
    const img = doc.createElement('img');
    img.src = src;
    await img.decode();
    const c = doc.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    if (!c.width || !c.height) return false;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.drawImage(img, 0, 0);
    return looksCut(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  } catch {
    return false;
  }
}

/**
 * A long name on two lines: the space to break at, chosen so the two lines are as near the same width as can be.
 * `widthOf` measures a piece of text. One line when the name is not wider than `over`, or has no space in it.
 */
export function twoLines(text: string, widthOf: (t: string) => number, over: number = TYPED_WRAP_OVER): string[] {
  if (widthOf(text) <= over) return [text];
  let best: string[] = [text], bestW = Infinity;
  for (const m of text.matchAll(/\s+/g)) {
    const a = text.slice(0, m.index), b = text.slice(m.index! + m[0].length);
    if (!a || !b) continue;
    const wide = Math.max(widthOf(a), widthOf(b));
    if (wide < bestW) (bestW = wide), (best = [a, b]);
  }
  return best;
}

/**
 * Makes the words of a button or label smaller until they fit between its padding, down to `min` pixels, so a long
 * name is shown whole instead of ending in "…". Call it again when the words or the width change.
 */
export function fitLabel(el: HTMLElement, min = 12, doc: Document = document): void {
  el.style.fontSize = '';
  const ruler = doc.createElement('canvas').getContext('2d')!;
  // The padding can depend on the letter size, so measure, set and look again a few times.
  for (let i = 0; i < 4; i++) {
    const s = getComputedStyle(el), size = parseFloat(s.fontSize);
    ruler.font = `${size}px ${s.fontFamily}`;
    const m = ruler.measureText(el.textContent || '');
    // Tails included, and a little air so the last letter does not sit on the "…" limit.
    const need = Math.max(m.width, (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0)) + 2;
    const room = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    if (need <= room || size <= min || room <= 0) return;
    el.style.fontSize = `${Math.max(min, Math.floor(((size * room) / need) * 10) / 10)}px`;
  }
}

const RTL_FIRST = /^[^\p{L}]*[֐-ࣿיִ-﷿ﹰ-﻿]/u;

/**
 * A typed name or typed initials as a picture, in the font family given (a CSS font-family list). The font must be
 * loaded before this is called. All of the ink is in the picture, with SIG_PAD clear pixels around it. Null when
 * the text leaves no ink (only spaces). A very long name with spaces in it is written on two lines.
 */
export function typedMark(text: string, family: string, doc: Document = document): string | null {
  // A name whose first letter is Arabic or Hebrew is laid out as right-to-left text, so a number or a Latin word in
  // it stands on the correct side.
  const direction = RTL_FIRST.test(text) ? 'rtl' : 'ltr';
  const probe = doc.createElement('canvas').getContext('2d')!;
  const set = (ctx: CanvasRenderingContext2D, size: number) => {
    ctx.font = `${size}px ${family}`;
    ctx.direction = direction;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  };
  // The real ink of one line around the point it is drawn from: how far it reaches left, right, up and down.
  const inkOfLine = (line: string, size: number) => {
    const m = probe.measureText(line);
    // A browser without ink measures gets the plain width and a generous guess. The edge check below covers the rest.
    const left = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0;
    const right = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width;
    const up = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : size;
    const down = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : size * 0.5;
    // The ink can start right of the origin (left is then negative) or end before the advance: never count less
    // than the text's own box, so the canvas is always at least as large as what the browser lays out.
    return { left: Math.max(left, 0), right: Math.max(right, m.width, 1), up: Math.max(up, 1), down: Math.max(down, 0) };
  };
  set(probe, TYPED_SIZE);
  const inkWidth = (t: string) => {
    const b = inkOfLine(t, TYPED_SIZE);
    return b.left + b.right;
  };
  // Two lines only for left-to-right names: they start at the same left edge.
  const lines = direction === 'ltr' ? twoLines(text, inkWidth) : [text];
  // The ink of all the lines together, around the point the first line is drawn from.
  const ink = (size: number) => {
    set(probe, size);
    const box = { left: 0, right: 1, up: 1, down: 0 };
    lines.forEach((line, i) => {
      const b = inkOfLine(line, size), dy = i * size * TYPED_LINE;
      box.left = Math.max(box.left, b.left);
      box.right = Math.max(box.right, b.right);
      box.up = Math.max(box.up, b.up - dy);
      box.down = Math.max(box.down, b.down + dy);
    });
    return box;
  };
  let size = TYPED_SIZE;
  let box = ink(size);
  // A long name: smaller letters until the ink itself, tails included, is no wider than the limit.
  for (let i = 0; i < 6 && box.left + box.right > TYPED_MAX_W && size > TYPED_MIN_SIZE; i++) {
    size = Math.max(TYPED_MIN_SIZE, Math.floor((size * TYPED_MAX_W) / (box.left + box.right)));
    box = ink(size);
  }
  // Room to spare on every side. If ink still reaches an edge (a font whose measures are off), draw again with more.
  let room = Math.ceil(size * 0.25) + SIG_PAD;
  // A straight letter whose side lands exactly on a line of pixels would read as a cut edge (looksCut): then the
  // text is drawn again a part of a pixel to the right, where its edge fades out as ink does.
  let nudge = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const c = doc.createElement('canvas');
    c.width = Math.ceil(box.left + box.right) + room * 2;
    c.height = Math.ceil(box.up + box.down) + room * 2;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    set(ctx, size);
    ctx.fillStyle = TYPED_INK;
    lines.forEach((line, i) => ctx.fillText(line, room + box.left + nudge, room + box.up + i * size * TYPED_LINE));
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const b = inkBox(d, c.width, c.height);
    if (!b) return null;
    const last = attempt === 5;
    if (touchesEdge(b, c.width, c.height) && !last) {
      room *= 3;
      continue;
    }
    if (looksCut(d, c.width, c.height) && !last) {
      nudge += 0.37;
      continue;
    }
    return crop(c, b, doc);
  }
  return null;
}
