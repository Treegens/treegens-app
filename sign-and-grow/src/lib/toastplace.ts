// Where a toast sits: at the bottom of the screen, and never over something a person can press (charter P11).
// Given the box the toast would take at its usual place and the boxes of the controls on screen, this says how many
// pixels to lift it so that it covers none of them. src/components/ui.tsx (Toasts) applies the answer.
export type Box = { top: number; bottom: number; left: number; right: number };

/** The most a toast is lifted: past this it would sit in the middle of the screen, so it stays where it was. */
export const TOAST_MAX_LIFT = 0.45;

const hits = (a: Box, b: Box) => a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;

/** Pixels to lift the toast above its usual place. 0 when nothing is under it, or when no free band is near. */
export function toastLift(toast: Box, controls: Box[], viewportHeight: number, gap = 8): number {
  let lift = 0;
  for (let i = 0; i < 12; i++) {
    const now = { ...toast, top: toast.top - lift, bottom: toast.bottom - lift };
    const under = controls.filter((c) => hits(now, c));
    if (!under.length) return lift;
    lift = toast.bottom - Math.min(...under.map((c) => c.top)) + gap;
    if (lift > viewportHeight * TOAST_MAX_LIFT || toast.top - lift < 0) return 0;
  }
  return 0;
}
