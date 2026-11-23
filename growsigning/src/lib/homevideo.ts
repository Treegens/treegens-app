// The video on the home page: Treegens' AI counting freshly planted mangroves in a planter's video.
//
// One setting, HOME_VIDEO_URL:
//   not set     the video that ships with the product (public/videos/tree-count.mp4 and its poster)
//   none        no video block at all
//   an address  an mp4 or webm file: https://... or a file under public/videos/, written /videos/name.mp4
// Anything else (a page on a video site, a file of another kind, an address that is not one, a file name under
// public/videos/ that is not there, an http:// address on a site that runs on https) gives no block, never an
// empty player. A file at another address is not fetched to check it: if that address stops answering, the player
// shows its poster and does not play. HOME_VIDEO_POSTER is the still picture shown before a video of your own plays (https://... or a
// file under public/videos/); without one the browser shows the first frame once it has it.

export type HomeVideo = { src: string; type: 'video/mp4' | 'video/webm'; poster: string | null; preload: 'none' | 'metadata' };

/** What the video shows, in one line. It is the caption, and the start of the text alternative. */
export const HOME_VIDEO_CAPTION = "Treegens' AI counting freshly planted mangroves in a planter's video.";
/** For people who cannot see the video: what happens in it, as text. It has no sound. */
export const HOME_VIDEO_TEXT = 'What the video shows: a planted plot filmed by the planter walking through it. Every seedling gets a box drawn around it and is followed as the camera moves, so each one is counted once. The video has no sound.';

const SHIPPED: HomeVideo = { src: '/videos/tree-count.mp4', type: 'video/mp4', poster: '/videos/tree-count.webp', preload: 'none' };

const kindOf = (path: string): HomeVideo['type'] | null => (/\.mp4$/i.test(path) ? 'video/mp4' : /\.webm$/i.test(path) ? 'video/webm' : null);

/** Says whether a file under public/ is there, given its address on the site ("/videos/name.mp4"). The home page passes one that looks on disk. */
export type FileThere = (sitePath: string) => boolean;

/**
 * An address a page may load a file from: https, or a file under public/videos/ that is really there. Otherwise null.
 * http is taken only when the site itself runs on http (a server on localhost): a page served over https does not
 * play a video from http, and the player would stay empty.
 */
function place(value: string, kinds: RegExp, plainHttp: boolean, there?: FileThere): string | null {
  const v = value.trim();
  if (!v || v.length > 500 || /[\s"'<>\\]/.test(v)) return null;
  if (/^\/videos\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) return kinds.test(v) && (!there || there(v)) ? v : null;
  try {
    const u = new URL(v);
    if ((u.protocol !== 'https:' && !(plainHttp && u.protocol === 'http:')) || u.username || u.password) return null;
    return kinds.test(u.pathname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The video of the home page, or null when there is none to show. */
export function homeVideo(env: Record<string, string | undefined> = process.env, there?: FileThere): HomeVideo | null {
  const raw = String(env.HOME_VIDEO_URL || '').trim();
  if (!raw) {
    if (there && !there(SHIPPED.src)) return null;
    return !there || there(SHIPPED.poster!) ? SHIPPED : { ...SHIPPED, poster: null, preload: 'metadata' };
  }
  if (raw.toLowerCase() === 'none') return null;
  const plainHttp = /^http:\/\//i.test(String(env.APP_URL || '').trim());
  const src = place(raw, /\.(mp4|webm)$/i, plainHttp, there);
  if (!src) return null;
  const type = kindOf(new URL(src, 'http://x').pathname);
  if (!type) return null;
  const poster = place(String(env.HOME_VIDEO_POSTER || ''), /\.(webp|jpe?g|png|avif)$/i, plainHttp, there);
  // preload is what the markup starts with. The home page starts the video itself once it is on screen (HomeVideo.tsx),
  // except for reduced motion, save-data and slow connections: there nothing of it is fetched until someone presses play.
  return { src, type, poster, preload: poster ? 'none' : 'metadata' };
}
