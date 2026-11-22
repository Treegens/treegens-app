'use client';
import { fitWithin } from '@/lib/phone';

// Photos as documents. A phone camera makes pictures of 12 million pixels and more, several megabytes each, and
// every signer would download all of it to read one page. So a large picture is made smaller here, in the browser,
// before it leaves the phone. The browser turns the picture upright while it does that. A picture that is small
// enough already is sent as it is, and the server turns it upright (src/server/exif.ts).

export const isPicture = (f: File) => /\.(png|jpe?g)$/i.test(f.name) || f.type === 'image/png' || f.type === 'image/jpeg';

function load(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    // An <img> is shown the way the camera's note says, and so is what a canvas draws from it.
    img.onload = () => (URL.revokeObjectURL(url), resolve(img));
    img.onerror = () => (URL.revokeObjectURL(url), reject(new Error('not a picture this browser can read')));
    img.src = url;
  });
}

/**
 * The picture, made smaller when it is larger than a page needs. Gives back the file unchanged when it is small
 * enough, is not a picture, or cannot be read here: then the server deals with it, and says so if it cannot.
 */
export async function shrinkPhoto(file: File): Promise<File> {
  if (!isPicture(file)) return file;
  try {
    const img = await load(file);
    const to = fitWithin(img.naturalWidth, img.naturalHeight);
    if (to.w === img.naturalWidth && to.h === img.naturalHeight) return file;
    const canvas = document.createElement('canvas');
    canvas.width = to.w;
    canvas.height = to.h;
    const g = canvas.getContext('2d');
    if (!g) return file;
    // White under a see-through picture, because a JPEG has no see-through.
    g.fillStyle = '#fff';
    g.fillRect(0, 0, to.w, to.h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, to.w, to.h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    canvas.width = canvas.height = 0; // hand the memory back at once, a phone has little of it
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.(png|jpe?g)$/i, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

// ---- Cleaner scans (scan.ts) ---------------------------------------------------------------------------------------

/**
 * A photo of a page, cleaned: the page found, straightened and made easier to read (scan.ts), at most as large as a
 * page needs. null when the page cannot be found clearly, or the picture cannot be read here: then it goes as it was.
 */
async function cleanPhoto(file: File): Promise<File | null> {
  if (!isPicture(file)) return null;
  try {
    const { cleanPage } = await import('./scan');
    const img = await load(file);
    const to = fitWithin(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = to.w;
    canvas.height = to.h;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, to.w, to.h);
    g.drawImage(img, 0, 0, to.w, to.h);
    const done = cleanPage(g.getImageData(0, 0, to.w, to.h));
    if (!done) return (canvas.width = canvas.height = 0), null;
    canvas.width = done.page.width;
    canvas.height = done.page.height;
    g.putImageData(new ImageData(new Uint8ClampedArray(done.page.data), done.page.width, done.page.height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    canvas.width = canvas.height = 0;
    return blob ? new File([blob], file.name.replace(/\.(png|jpe?g)$/i, '') + '.jpg', { type: 'image/jpeg' }) : null;
  } catch {
    return null;
  }
}

/**
 * The pictures of one upload, ready to go: each photo of a page cleaned where its page is found, made smaller
 * otherwise. When any was cleaned, `extra` carries the photos before cleanup (made smaller the same way, so not the camera's own files) and
 * which ones were cleaned, so the server keeps them and "Undo cleanup" can put them back. Not pictures: as they are.
 */
export async function preparePhotos(files: File[]): Promise<{ ready: File[]; extra?: Record<string, File | string>; cleaned: number }> {
  const small: File[] = [];
  for (const f of files) small.push(await shrinkPhoto(f));
  if (!files.every(isPicture)) return { ready: small, cleaned: 0 };
  const ready: File[] = [];
  const cleaned: number[] = [];
  for (const [i, f] of files.entries()) {
    const clean = await cleanPhoto(f);
    if (clean) cleaned.push(i);
    ready.push(clean || small[i]);
  }
  if (!cleaned.length) return { ready, cleaned: 0 };
  const extra: Record<string, File | string> = { scan_cleaned: cleaned.join(',') };
  small.forEach((o, i) => (extra[`scan_original_${i}`] = o));
  return { ready, extra, cleaned: cleaned.length };
}
