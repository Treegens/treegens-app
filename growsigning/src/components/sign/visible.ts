// Words in a PDF's text that cannot be seen on its pages: white text on a white page, text drawn see-through, text
// covered by a shape drawn over it, or text placed off the page. Easy reading and the screen-reader text are made from
// the text pdf.js reads, so without this a sender could put terms there that the pages (what is signed) do not show.
//
// How: the page is drawn to a picture once, and the box of each run of text is looked at. Where the box is all one
// colour, nothing of that run shows, so it is left out (and the page says so). Text over a picture (the invisible text
// a scanner adds over the picture of a scan) is kept, because the box has ink in it: it is the picture's own words.
// No React and no pdf.js here, so it can be tested with plain pixels (tests/ds-reading-view.test.ts).

/** A picture of a page as a canvas gives it: RGBA, 4 bytes a pixel. */
export type Pixels = { data: Uint8ClampedArray | Uint8Array; width: number; height: number };

/** A run of text in the page's coordinates at scale 1 (x from the left, y of the baseline from the top, h the size). `flat`: not turned. */
export type InkRun = { x: number; y: number; w: number; h: number; flat: boolean };

/** How far a pixel must differ from the box's own background (sum over R, G and B) to count as ink. */
const INK = 48;

/** True when something is drawn in this box (x0, y0 to x1, y1 in pixels): some pixels clearly differ from the most common colour in it. */
export function inkIn(px: Pixels, x0: number, y0: number, x1: number, y1: number): boolean {
  const ax = Math.max(0, Math.floor(x0)), ay = Math.max(0, Math.floor(y0));
  const bx = Math.min(px.width, Math.ceil(x1)), by = Math.min(px.height, Math.ceil(y1));
  // Nothing of the box is on the page: nobody can see it.
  if (bx <= ax || by <= ay) return false;
  // At most about 4000 pixels are looked at in a box, evenly spread.
  const area = (bx - ax) * (by - ay);
  const step = Math.max(1, Math.floor(Math.sqrt(area / 4000)));
  const at = (x: number, y: number) => (y * px.width + x) * 4;
  // The background: the most common colour, in coarse steps.
  const counts = new Map<number, number>();
  for (let y = ay; y < by; y += step)
    for (let x = ax; x < bx; x += step) {
      const i = at(x, y);
      const k = ((px.data[i] >> 4) << 8) | ((px.data[i + 1] >> 4) << 4) | (px.data[i + 2] >> 4);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const br = ((bg >> 8) & 15) * 16 + 8, bgG = ((bg >> 4) & 15) * 16 + 8, bb = (bg & 15) * 16 + 8;
  let ink = 0;
  for (let y = ay; y < by; y += step)
    for (let x = ax; x < bx; x += step) {
      const i = at(x, y);
      if (Math.abs(px.data[i] - br) + Math.abs(px.data[i + 1] - bgG) + Math.abs(px.data[i + 2] - bb) > INK) ink++;
      // Two pixels of ink are enough: real letters always leave some, at any size.
      if (ink >= 2) return true;
    }
  return false;
}

/**
 * Which runs cannot be seen (true) on the picture of the page, drawn at `scale` times the size of the runs. A run that
 * is turned (not `flat`) or has no width is always kept: its box cannot be told reliably.
 */
export function hiddenRuns(runs: InkRun[], px: Pixels, scale: number): boolean[] {
  return runs.map((r) => {
    if (!r.flat || !(r.w > 0) || !(r.h > 0)) return false;
    // The box of the letters: from the top of capitals to just under the line (for g, p, y).
    return !inkIn(px, r.x * scale, (r.y - r.h) * scale, (r.x + r.w) * scale, (r.y + r.h * 0.3) * scale);
  });
}
