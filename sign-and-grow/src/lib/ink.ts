// What counts as a drawn or an uploaded signature. A finger that only touched the pad leaves a dot, and a dot went
// onto signed documents as the signature. So a tap, a mark too small to stand for a signature, a box filled with ink,
// a blank photo and a solid block are refused in words, before anything goes on the page, and the person can draw
// again or choose Type. The rule runs in the browser (SignaturePad) on what was drawn or chosen, and there is nothing
// for a sender to set. It only judges the size of a mark, never whether it looks like anyone's real signature.
// Plain functions with no imports, so the tests check the rule itself.

export type Point = { x: number; y: number };
type Kind = 'signature' | 'initials';
const word = (k: Kind) => (k === 'signature' ? 'signature' : 'initials');

/** How wide the line on the pad is drawn, in CSS pixels. SignaturePad draws with it. */
export const PEN_WIDTH = 2.6;

/** The length of all lines drawn, in CSS pixels. A tap is a stroke of one point and adds nothing. */
export function inkLength(strokes: Point[][]): number {
  let n = 0;
  for (const s of strokes) for (let i = 1; i < s.length; i++) n += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
  return n;
}

/** The size of the box every point drawn fits in, with the width of the pen around it. */
export function inkBox(strokes: Point[][]): { w: number; h: number } {
  const pts = strokes.flat();
  if (!pts.length) return { w: 0, h: 0 };
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs) + PEN_WIDTH, h: Math.max(...ys) - Math.min(...ys) + PEN_WIDTH };
}

/**
 * Why a drawing cannot be used, in words for the person, or '' when it can. `pad` is the size of the drawing box in
 * CSS pixels. A signature needs lines at least a quarter as long as the box is wide (90 px on a phone held upright),
 * initials a twelfth. Neither may fit in a box of 40 by 12 px (16 by 12 for initials). Lines that would fill nearly
 * half the box are a scribble over it, not a signature.
 */
export function drawnProblem(strokes: Point[][], pad: { w: number; h: number }, kind: Kind): string {
  const w = word(kind);
  if (!strokes.some((s) => s.length)) return `Draw your ${w} in the box first.`;
  const len = inkLength(strokes), box = inkBox(strokes);
  if (len < 12) return `That looks like a tap, not ${kind === 'signature' ? 'a signature' : 'your initials'}. Draw your ${w} again, or choose Type.`;
  const least = kind === 'signature' ? Math.max(40, pad.w / 4) : Math.max(20, pad.w / 12);
  const tiny = kind === 'signature' ? box.w < 40 && box.h < 12 : box.w < 16 && box.h < 12;
  if (len < least || tiny) return `That mark is too small to stand for your ${w}. Draw ${kind === 'signature' ? 'it' : 'them'} larger, across more of the box, or choose Type.`;
  if (pad.w > 0 && pad.h > 0 && (len * PEN_WIDTH) / (pad.w * pad.h) > 0.45) return `That fills almost the whole box. Choose Clear and draw your ${w} again, or choose Type.`;
  return '';
}

/**
 * How much of a picture is ink: marks clearly darker than the paper. The paper is how light the picture is at nine
 * points in ten, so a grey photo of white paper still counts as paper and a black square has no ink on it at all.
 * Transparent counts as paper. `rgba` is four bytes per point, as a canvas gives them.
 */
export function inkShare(rgba: ArrayLike<number>, width: number, height: number): number {
  const total = width * height;
  if (!total) return 0;
  const light = new Uint32Array(256);
  const lum = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const a = rgba[i * 4 + 3];
    const l = a <= 8 ? 255 : Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
    lum[i] = l;
    light[l]++;
  }
  let paper = 0;
  for (let seen = 0; paper < 255 && (seen += light[paper]) < total * 0.9; paper++);
  let ink = 0;
  for (let i = 0; i < total; i++) if (lum[i] < paper - 60) ink++;
  return ink / total;
}

/** Why an uploaded picture cannot be used as a signature, or '' when it can. `share` comes from inkShare. */
export function pictureProblem(share: number, kind: Kind): string {
  const w = word(kind);
  if (share < 0.002) return `We cannot see ${kind === 'signature' ? 'a signature' : 'any initials'} in that picture. Choose a photo of your ${w} in dark ink on light paper, or choose Draw or Type.`;
  if (share > 0.5) return `That picture is almost all ink, so your ${w} would not show. Choose a photo of your ${w} in dark ink on light paper, or choose Draw or Type.`;
  return '';
}

/** Said when a second finger lands on the pad while one is drawing. */
export const twoFingers = (kind: Kind): string => `That was two fingers at once, so it was not kept. Draw your ${word(kind)} with one finger, or choose Type.`;

/**
 * One finger at a time on the pad. Every finger is a pointer of its own, and the pad used to add the moves of all
 * of them to one line, so two fingers spread apart (a pinch) drew a long zigzag that passed as a signature. Here
 * only the pointer that started the line draws. A second finger while one draws takes the line under way away
 * ('drop'), and nothing draws again until every finger is off. A touch while a pen draws is a resting palm and is
 * ignored. `primary` is the browser's word that no other pointer of this kind (touch, pen) is down, which also
 * clears a finger whose lifting was never reported.
 */
export function onePen() {
  const downs = new Map<number, string>();
  let pen: number | null = null;
  let spoiled = false;
  return {
    down(id: number, type: string, primary: boolean): 'draw' | 'ignore' | 'drop' {
      if (primary) {
        for (const [k, t] of downs) if (t === type) downs.delete(k);
        if (pen !== null && !downs.has(pen)) pen = null;
        if (!downs.size) spoiled = false;
      }
      downs.set(id, type);
      if (pen === null) return !spoiled && downs.size === 1 ? ((pen = id), 'draw') : 'ignore';
      if (downs.get(pen) === 'pen' && type !== 'pen') return 'ignore';
      pen = null;
      spoiled = true;
      return 'drop';
    },
    move: (id: number): boolean => id === pen,
    /** Whether this ends the line being drawn. */
    up(id: number): boolean {
      downs.delete(id);
      if (!downs.size) spoiled = false;
      return id === pen ? ((pen = null), true) : false;
    },
  };
}
