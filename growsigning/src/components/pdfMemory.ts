// How the PDF viewer keeps a long document light on a phone, and how Next gets to a field far away. A drawn page is
// a picture held in memory: at phone size about 2.8 MB each, so a hundred pages kept after scrolling to the end came
// to 277 MB, around where a phone browser starts blanking pictures or reloads the tab. Pages are drawn when they come
// near the screen and give their picture back when they are far from it. No React here, so tests can read it.

/** A page is drawn once it is within this many screens of the visible part. */
export const DRAW_SCREENS = 1;
/** A drawn page gives its picture back once it is more than this many screens away. */
export const RELEASE_SCREENS = 3;
/** The most picture points one page is drawn with. Six million is about 24 MB, and well under a phone's limit per picture. */
export const MAX_PAGE_PIXELS = 6_000_000;

/**
 * How many picture points to draw per CSS pixel of a page shown `w` by `h` CSS pixels: the screen's own density, up
 * to 3, so text is sharp on any phone and at any zoom, but never more than MAX_PAGE_PIXELS in all.
 */
export function pixelRatio(w: number, h: number, dpr: number, max = MAX_PAGE_PIXELS): number {
  const want = Math.min(Math.max(dpr || 1, 1), 3);
  if (!(w > 0 && h > 0)) return want;
  return Math.min(want, Math.sqrt(max / (w * h)));
}

/** Whether a page whose top and bottom are at these points of the screen (as getBoundingClientRect gives) is near enough to keep. */
export const nearScreen = (top: number, bottom: number, screen: number, screens: number) => bottom > -screens * screen && top < screen + screens * screen;

/** Whether a move of `distance` pixels is long enough to jump instead of gliding: more than two screens. */
export const jumpRatherThanGlide = (distance: number, screen: number) => Math.abs(distance) > 2 * screen;
