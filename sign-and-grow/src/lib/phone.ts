// What a phone changes for the person who sends: photos of paper, staying signed in, documents that are heavy for
// a phone, fields that are announced only by their type. Plain functions with no imports beyond the numbers in
// policy.ts and no side effects, so pages, the server and tests can all use them.
import { PHOTO_MAX_SIDE } from './policy.ts';

// ---- Photos ----------------------------------------------------------------------------------------

/** The size a picture is made smaller to before upload: the long side at most `max`, the shape kept. Never enlarges. */
export function fitWithin(w: number, h: number, max = PHOTO_MAX_SIDE): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
