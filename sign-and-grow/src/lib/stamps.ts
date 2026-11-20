// Stamps: a company stamp or seal next to a signature, put on the page like ink from a rubber stamp. What the
// browser, the server and the tests share: the limits, the sizes and the honest words. How a picture becomes an
// impression is in stampink.ts. The server side is src/server/stamps.ts. Plain data and functions, no side effects.

/** What a stamp is here, and what it is not, said wherever one is offered or recorded. Never more than this. */
export const STAMP_IS = 'A stamp here is a picture of a stamp that this person put on the document. GrowSigning does not check that they may use it, and it is not a certified electronic seal.';
/** The same, to the person putting it on. */
export const STAMP_IS_YOU = 'A stamp here is a picture of a stamp that you put on the document. GrowSigning does not check that you may use it, and it is not a certified electronic seal.';
/** The same, to the admins who keep the account's stamps. */
export const STAMP_IS_TEAM = 'A stamp here is a picture of a stamp that someone on your team puts on a document. GrowSigning does not check that they may use it, and it is not a certified electronic seal.';

/** A picture of a stamp as it is chosen: up to this many bytes. */
export const STAMP_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
/** And up to this many pixels, so a phone does not run out of memory reading it. */
export const STAMP_UPLOAD_MAX_PIXELS = 50_000_000;
/** The browser works on the picture at this many pixels on its longer side at most. */
export const STAMP_WORK_SIDE = 1600;
/** The finished impression has at most this many pixels on its longer side: over 500 dots per inch for a 45 mm seal. */
export const STAMP_OUT_MAX_SIDE = 1000;
/** The smallest impression the server takes, on its longer side. */
export const STAMP_OUT_MIN_SIDE = 24;
/** The stored impression (a PNG) is at most this many bytes. */
export const STAMP_PNG_MAX_BYTES = 2_500_000;
/** How many stamps an account keeps under Settings. */
export const STAMPS_PER_ACCOUNT = 10;
/** Stamp pictures one signing link may put on in an hour, and one internet address in an hour over all links. */
export const STAMP_UPLOADS_PER_LINK_HOUR = 20;
export const STAMP_UPLOADS_PER_ADDRESS_HOUR = 120;

/** A round company seal is about 38 to 45 mm across. That is the size a stamp field starts at, and a saved stamp. */
export const STAMP_DEFAULT_MM = 40;
export const STAMP_MIN_MM = 8;
export const STAMP_MAX_MM = 120;
/**
 * Printed at nearly full strength: the multiply blend already lets the printed words show through, as they do under
 * real ink, so the strongest parts of a stamp reach the full colour of stamp pad ink and the rest of its unevenness
 * comes from the impression itself (src/lib/stampink.ts), not from a fade over all of it.
 */
export const STAMP_OPACITY = 0.97;
/** The page turns a stamp by up to this many degrees each way: its natural tilt, never drawn into the picture. */
export const STAMP_TURN_MAX = 4;
/**
 * How far the page turns a stamp, in degrees clockwise as it is looked at: the "turn" kept with it (a number, or the
 * stamp_meta of a field as JSON). 0 for a stamp whose picture was made before the tilt moved onto the page: its tilt
 * is in its picture.
 */
export function stampTurn(v: any): number {
  let t: any = v;
  if (typeof v === 'string') {
    try {
      t = JSON.parse(v)?.turn;
    } catch {
      t = 0;
    }
  } else if (v && typeof v === 'object') t = v.turn;
  const n = Number(t);
  return Number.isFinite(n) ? Math.max(-STAMP_TURN_MAX, Math.min(STAMP_TURN_MAX, Math.round(n * 10) / 10)) : 0;
}
/** The same turn as a style for the picture of a stamp on a page: it turns about its middle, as in the signed PDF. */
export const turnStyle = (turn: number): { transform?: string } => (turn ? { transform: `rotate(${turn}deg)` } : {});
/** A stamp name, as typed under Settings. */
export const STAMP_NAME_MAX = 60;

export const MM_PER_PT = 25.4 / 72;
/** A field of `mm` millimetres square on a page of `pageW` by `pageH` points, as fractions of the page. */
export const stampBox = (mm: number, pageW: number, pageH: number) => ({ w: Math.min(1, mm / MM_PER_PT / (pageW || 612)), h: Math.min(1, mm / MM_PER_PT / (pageH || 792)) });
/** How large a field is on the page, in whole millimetres. */
export const fieldMm = (f: { w: number; h: number }, pageW: number, pageH: number) => ({ w: Math.round(f.w * (pageW || 612) * MM_PER_PT), h: Math.round(f.h * (pageH || 792) * MM_PER_PT) });

/**
 * Why a chosen file cannot be used as a stamp, in words, or null when it can. PNG and JPEG always; WebP when this
 * browser can read it (`webp`). Never SVG (a drawing that can carry script and has no ink to read) or PDF.
 */
export function stampFileProblem(file: { name?: string; type?: string; size?: number }, webp = true): string | null {
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  const said = file.name ? `"${String(file.name).slice(0, 80)}"` : 'That file';
  if (type === 'image/svg+xml' || name.endsWith('.svg')) return `${said} is an SVG drawing. A stamp has to be a picture: a PNG or JPEG${webp ? ' or WebP' : ''}. Export the design as a PNG, or take a photo of the stamp, and choose that.`;
  if (type === 'application/pdf' || name.endsWith('.pdf')) return `${said} is a PDF. A stamp has to be a picture: a PNG or JPEG${webp ? ' or WebP' : ''}. Take a photo of the stamp, or export the design as a PNG, and choose that.`;
  const ok = type === 'image/png' || type === 'image/jpeg' || (webp && type === 'image/webp');
  if (!ok) {
    if (type === 'image/webp') return `${said} is a WebP picture, and this browser cannot read WebP. Choose a PNG or JPEG instead.`;
    if (type === 'image/heic' || type === 'image/heif' || /\.hei[cf]$/.test(name)) return `${said} is a HEIC photo, which browsers cannot read yet. On an iPhone, choose Take a photo here instead, or set the camera to "Most compatible" so it saves JPEG.`;
    return `${said} is not a PNG or JPEG${webp ? ' or WebP' : ''} picture, so it cannot be used as a stamp. Choose a picture of the stamp, or take a photo of it.`;
  }
  if ((file.size || 0) > STAMP_UPLOAD_MAX_BYTES) return `${said} is ${((file.size || 0) / 1048576).toFixed(1)} MB, and a stamp picture can be up to 8 MB. Choose a smaller picture, or take the photo again at a lower size.`;
  if (file.size === 0) return `${said} is empty. Choose the picture again.`;
  return null;
}

/** Said when a picture has more pixels than a phone can safely read. */
export const tooManyPixels = (w: number, h: number) =>
  `That picture is ${w} by ${h} pixels, which is more than we can work with safely on this device (up to ${STAMP_UPLOAD_MAX_PIXELS / 1e6} million). Crop it or take the photo at a lower resolution, and choose it again.`;

/** Where a stamp came from, in words for the audit trail and the certificate. */
export const STAMP_FROM: Record<string, string> = {
  account: 'a saved stamp of their account',
  upload: 'a picture they uploaded',
  camera: 'a photo they took',
  sender: 'a saved stamp of the account, put on by the sender',
};
