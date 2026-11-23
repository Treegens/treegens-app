// The signing page inside a frame on the sender's own website (src/server/embed.ts). The link then ends in
// ?embed=1&origin=<website>; the server only lets that website frame the page, so posting to it reaches the website
// around the page and nobody else. A page that is not in a frame says nothing to anyone.
import { FRAME_EVENTS, readOrigin, type FrameEvent } from '../../lib/embed.ts';

/** The website around this page, or null when it is not in a frame made for one. */
export function frameOrigin(): string | null {
  if (typeof window === 'undefined' || window.parent === window) return null;
  const q = new URLSearchParams(window.location.search);
  if (q.get('embed') !== '1') return null;
  const o = readOrigin(q.get('origin'));
  return 'origin' in o ? o.origin : null;
}

/** For the body of Finish: the server writes "Signed inside a frame on <website>" when the link was made for it. */
export const frameBody = (): { frame_origin?: string } => {
  const o = frameOrigin();
  return o ? { frame_origin: o } : {};
};

/** Tells the website around the page what happened: {source: "growsigning", event}. Only ever to that website. */
export function tellFrame(event: FrameEvent) {
  const o = frameOrigin();
  if (!o || !FRAME_EVENTS.includes(event)) return;
  try {
    window.parent.postMessage({ source: 'growsigning', event }, o);
  } catch {
    // A website that went away in the meantime hears nothing; the page carries on as usual.
  }
}
