// The video on the home page: Treegens' AI counting freshly planted mangroves in a planter's video.
//
// One setting, HOME_VIDEO_URL:
//   not set     the video that ships with the product (public/videos/tree-count.mp4 and its poster)
//   none        no video block at all
//   an address  an mp4 or webm file: https://... or a file under public/videos/, written /videos/name.mp4
// Anything else (a page on a video site, a file of another kind, an address that is not one) gives no block, never an
// empty player. HOME_VIDEO_POSTER is the still picture shown before a video of your own plays (https://... or a
// file under public/videos/); without one the browser shows the first frame once it has it.

export type HomeVideo = { src: string; type: 'video/mp4' | 'video/webm'; poster: string | null; preload: 'none' | 'metadata' };

/** What the video shows, in one line. It is the caption, and the start of the text alternative. */
export const HOME_VIDEO_CAPTION = "Treegens' AI counting freshly planted mangroves in a planter's video.";
/** For people who cannot see the video: what happens in it, as text. It has no sound. */
export const HOME_VIDEO_TEXT = 'What the video shows: a planted plot filmed by the planter walking through it. Every seedling gets a box drawn around it and is followed as the camera moves, and a counter climbs with each one. The video has no sound.';

const SHIPPED: HomeVideo = { src: '/videos/tree-count.mp4', type: 'video/mp4', poster: '/videos/tree-count.webp', preload: 'none' };

const kindOf = (path: string): HomeVideo['type'] | null => (/\.mp4$/i.test(path) ? 'video/mp4' : /\.webm$/i.test(path) ? 'video/webm' : null);

/** An address a page may load a file from: https (or http), or a file under public/videos/. Otherwise null. */
function place(value: string, kinds: RegExp): string | null {
  const v = value.trim();
  if (!v || v.length > 500 || /[\s"'<>\\]/.test(v)) return null;
  if (/^\/videos\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) return kinds.test(v) ? v : null;
  try {
    const u = new URL(v);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    return kinds.test(u.pathname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The video of the home page, or null when there is none to show. */
export function homeVideo(env: Record<string, string | undefined> = process.env): HomeVideo | null {
  const raw = String(env.HOME_VIDEO_URL || '').trim();
  if (!raw) return SHIPPED;
  if (raw.toLowerCase() === 'none') return null;
  const src = place(raw, /\.(mp4|webm)$/i);
  if (!src) return null;
  const type = kindOf(new URL(src, 'http://x').pathname);
  if (!type) return null;
  const poster = place(String(env.HOME_VIDEO_POSTER || ''), /\.(webp|jpe?g|png|avif)$/i);
  // With a poster nothing of the video is fetched until someone presses play. Without one, only its first frame.
  return { src, type, poster, preload: poster ? 'none' : 'metadata' };
}
