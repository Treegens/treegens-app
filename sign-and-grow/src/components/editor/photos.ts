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
