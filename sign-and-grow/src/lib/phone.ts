// What a phone changes for the person who sends: photos of paper, staying signed in, documents that are heavy for
// a phone, fields that are announced only by their type. Plain functions with no imports beyond the numbers in
// policy.ts and no side effects, so pages, the server and tests can all use them.
import { PHOTO_MAX_SIDE, PHONE_SLOW_BYTES, PHONE_SECONDS_PER_MB } from './policy.ts';

// ---- Where a person is signed in -------------------------------------------------------------------

/**
 * "iPhone" and "Safari" from what a browser calls itself. It is the browser's own word, good enough to tell one's
 * phone from one's laptop and nothing more: it is not a check of anything. Safari on an iPad says it is a Mac, so
 * that pair is named as either. Something we cannot read is called unknown, not guessed.
 */
export function deviceName(ua: string | null | undefined): { device: string; browser: string } {
  const s = ua || '';
  const browser = /Edg(e|A|iOS)?\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /Firefox\/|FxiOS/.test(s) ? 'Firefox'
    : /Chrome\/|CriOS|Chromium/.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'unknown browser';
  const device = /iPhone|iPod/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? (/Mobile/.test(s) ? 'Android phone' : 'Android tablet') : /Windows/.test(s) ? 'Windows computer'
    : /CrOS/.test(s) ? 'Chromebook' : /Macintosh|Mac OS X/.test(s) ? (browser === 'Safari' ? 'Mac or iPad' : 'Mac') : /Linux|X11/.test(s) ? 'Linux computer' : 'Unknown device';
  return { device, browser };
}

// ---- Fields that are read out by their type only ---------------------------------------------------
// Someone who signs with a screen reader cannot see where a field sits on the page. They hear its label. A field
// the sender gave no label is announced by its type alone ("Text, required"), which does not say what to type.

/** What a signer hears for a field of this type when it has no label. The same words as LABEL in src/components/sign/fields.ts. */
export const HEARD_AS: Record<string, string> = { text: 'Text', number: 'Number', date: 'Date', dropdown: 'Choice', attachment: 'Attachment', checkbox: 'Checkbox', radio: 'Option' };
/**
 * The fields that need a label to mean anything when read out: the ones a signer fills in whose type does not say
 * what belongs in them. A signature, a name or an email address explains itself. So does wording the sender wrote.
 */
export const unlabelled = <F extends { type: string; label?: string | null; readonly?: any }>(fields: F[]): F[] =>
  fields.filter((f) => Object.hasOwn(HEARD_AS, f.type) && !f.readonly && !String(f.label || '').trim());

// ---- Signing in person -----------------------------------------------------------------------------
// The host hands their own device to the signer. src/server/handover.ts locks the host's account in that browser
// while the signer holds it. These are the words for it, used next to "Host signing now", on the lock screen, on
// the landing page and on /security, so that none of them promises more than the lock does.

/** What happens to the host's account, in one sentence. */
export const IN_PERSON_LOCK = 'When the signing page opens for someone who signs in person, GrowSigning locks your account in that browser. To come back you type your password, or sign in again if your login has none.';
/** The same in a few words, for the landing page. */
export const IN_PERSON_SHORT = 'Your account locks in that browser while they hold the device, and their last screen asks them to hand it back. The lock covers GrowSigning only, not the rest of your device.';
/** What the signer could still reach while holding the device. The lock is for GrowSigning in one browser, no more. */
export const IN_PERSON_LIMITS: string[] = [
  'Everything else on the device: your email (signing links and password reset emails arrive there), other apps, other websites.',
  'A password that your browser or password manager has saved and offers to fill in on the lock screen.',
  'A Google or Microsoft account that is signed in on the device, if that is how you sign in to GrowSigning. Signing in again is then one tap.',
  'A page of your account that is open in another tab stays on screen until that tab is brought to the front. Then it locks too.',
];

// ---- Documents that are slow on a phone ------------------------------------------------------------
// A signer's phone downloads the whole stored file (pdf.js in src/components/PdfDoc.tsx fetches all of it, also
// where it could start with a part), so the size of the file is the wait. The seconds are measured, not assumed:
// see PHONE_SECONDS_PER_MB in policy.ts and tests/out/gaps-mobile-send/g-measure.cjs.

/** About how long a phone took to download a file of this many bytes on a slow mobile connection, in words. */
export function phoneWait(bytes: number): string {
  const s = Math.max(1, Math.round((bytes / 1e6) * PHONE_SECONDS_PER_MB));
  return s < 90 ? `about ${s} seconds` : `about ${Math.round(s / 60)} minutes`;
}

/**
 * What the sender is told about a document that is large enough to be slow on a phone, or '' when it is not. Said
 * under the document in step 1 and again before sending. It warns and never blocks: a long scanned contract may have
 * to be what it is, and a signer at a desk does not mind.
 */
export function phoneWeight(d: { size?: number | null }): string {
  const bytes = Number(d?.size) || 0;
  if (bytes < PHONE_SLOW_BYTES) return '';
  return `This file is ${(bytes / 1e6).toFixed(1)} MB. Every signer's phone downloads all of it, which takes ${phoneWait(bytes)} on a slow mobile connection and longer where the signal is weak. If people will sign on a phone, save it with smaller pictures (many PDF programs have "reduce file size") or split it into parts. Under ${PHONE_SLOW_BYTES / 1e6} MB is best.`;
}

// ---- Photos ----------------------------------------------------------------------------------------

/** The size a picture is made smaller to before upload: the long side at most `max`, the shape kept. Never enlarges. */
export function fitWithin(w: number, h: number, max = PHOTO_MAX_SIDE): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
