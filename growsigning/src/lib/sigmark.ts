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
export const TYPED_MIN_SIZE = 24;
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

const RTL_FIRST = /^[^\p{L}]*[֐-ࣿיִ-﷿ﹰ-﻿]/u;

/**
 * A typed name or typed initials as a picture, in the font family given (a CSS font-family list). The font must be
 * loaded before this is called. All of the ink is in the picture, with SIG_PAD clear pixels around it. Null when
 * the text leaves no ink (only spaces).
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
  // The real ink around the point the text is drawn from: how far it reaches left, right, up and down.
  const ink = (size: number) => {
    set(probe, size);
    const m = probe.measureText(text);
    // A browser without ink measures gets the plain width and a generous guess. The edge check below covers the rest.
    const left = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0;
    const right = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width;
    const up = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : size;
    const down = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : size * 0.5;
    // The ink can start right of the origin (left is then negative) or end before the advance: never count less
    // than the text's own box, so the canvas is always at least as large as what the browser lays out.
    return { left: Math.max(left, 0), right: Math.max(right, m.width, 1), up: Math.max(up, 1), down: Math.max(down, 0) };
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
  for (let attempt = 0; attempt < 4; attempt++, room *= 3) {
    const c = doc.createElement('canvas');
    c.width = Math.ceil(box.left + box.right) + room * 2;
    c.height = Math.ceil(box.up + box.down) + room * 2;
    const ctx = c.getContext('2d')!;
    set(ctx, size);
    ctx.fillStyle = TYPED_INK;
    ctx.fillText(text, room + box.left, room + box.up);
    const b = boxOf(c);
    if (!b) return null;
    if (!touchesEdge(b, c.width, c.height) || attempt === 3) return crop(c, b, doc);
  }
  return null;
}
