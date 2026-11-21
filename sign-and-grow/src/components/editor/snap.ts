// Snapping for fields being dragged or resized: line the moving field up with the edges and centres of the other
// fields on the page, and say where to draw the guide. Plain numbers in, plain numbers out. Everything is a
// fraction of the page, and the tolerance is given per axis because pages are not square.

export type Box = { x: number; y: number; w: number; h: number };
export type Guide = { axis: 'x' | 'y'; at: number; from: number; to: number };

const EPS = 1e-6;

function nearest(lines: number[], targets: number[], tol: number): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null;
  for (const l of lines)
    for (const t of targets) {
      const d = t - l;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: t };
    }
  return best;
}

/**
 * Moves (or resizes) `box` by at most `tol` so one of its lines meets a line of another box.
 * When moving, the left edge, centre and right edge can all snap. When resizing, only the edge being pulled.
 */
export function snapBox(box: Box, others: Box[], mode: 'move' | 'resize', tol: { x: number; y: number }): { box: Box; guides: Guide[] } {
  const out = { ...box };
  const guides: Guide[] = [];
  if (!others.length) return { box: out, guides };

  const sx = nearest(mode === 'move' ? [box.x, box.x + box.w / 2, box.x + box.w] : [box.x + box.w], others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w]), tol.x);
  if (sx) {
    if (mode === 'move') out.x += sx.delta;
    else out.w += sx.delta;
  }
  const sy = nearest(mode === 'move' ? [box.y, box.y + box.h / 2, box.y + box.h] : [box.y + box.h], others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h]), tol.y);
  if (sy) {
    if (mode === 'move') out.y += sy.delta;
    else out.h += sy.delta;
  }
  // Never let a snap push the field off the page or turn it inside out. If it would, leave that axis alone.
  if (out.x < -EPS || out.x + out.w > 1 + EPS || out.w <= EPS) (out.x = box.x), (out.w = box.w);
  if (out.y < -EPS || out.y + out.h > 1 + EPS || out.h <= EPS) (out.y = box.y), (out.h = box.h);

  // A guide runs through every field that shares the line, so it is obvious what the field lined up with.
  if (sx && (out.x !== box.x || out.w !== box.w || sx.delta === 0)) {
    const on = others.filter((o) => [o.x, o.x + o.w / 2, o.x + o.w].some((v) => Math.abs(v - sx.at) < EPS));
    guides.push({ axis: 'x', at: sx.at, from: Math.min(out.y, ...on.map((o) => o.y)), to: Math.max(out.y + out.h, ...on.map((o) => o.y + o.h)) });
  }
  if (sy && (out.y !== box.y || out.h !== box.h || sy.delta === 0)) {
    const on = others.filter((o) => [o.y, o.y + o.h / 2, o.y + o.h].some((v) => Math.abs(v - sy.at) < EPS));
    guides.push({ axis: 'y', at: sy.at, from: Math.min(out.x, ...on.map((o) => o.x)), to: Math.max(out.x + out.w, ...on.map((o) => o.x + o.w)) });
  }
  return { box: out, guides };
}
