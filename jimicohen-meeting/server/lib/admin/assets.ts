/**
 * Image uploads for the dashboard (profile photo, logo, cover, background).
 *
 * The browser sends a data: URL. We accept PNG, JPEG, WebP and GIF only, and only when the
 * bytes really are what the URL claims: the declared type is checked against the file's magic
 * bytes. SVG is refused outright, because an SVG is a document that can carry script.
 */
import { HttpError } from '../http';

export const MAX_ASSET_BYTES = 3 * 1024 * 1024;
/** 3 MB of image is 4 MB of base64, plus the JSON around it. */
export const MAX_ASSET_REQUEST_BYTES = Math.floor(4.5 * 1024 * 1024);

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
const NAMES: Record<ImageType, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF' };

function invalid(message: string): HttpError {
  return new HttpError(422, 'invalid', message, { dataUrl: message });
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/** The image type the bytes themselves announce, or null when they are none of the four we accept. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/**
 * Decodes and checks an uploaded data: URL. Throws HttpError(422) for anything that is not an
 * acceptable image and HttpError(413) when it is larger than 3 MB.
 */
export function parseImageDataUrl(dataUrl: unknown): { contentType: ImageType; data: Uint8Array } {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) throw invalid('Please upload a PNG, JPEG, WebP or GIF image.');
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw invalid('Please upload a PNG, JPEG, WebP or GIF image.');
  const header = dataUrl.slice(5, comma).toLowerCase();
  const payload = dataUrl.slice(comma + 1);
  const [mime, ...params] = header.split(';').map((part) => part.trim());

  if (mime.includes('svg')) throw invalid('SVG files are not supported. Please upload a PNG, JPEG, WebP or GIF image.');
  const declared = (mime === 'image/jpg' ? 'image/jpeg' : mime) as ImageType;
  if (!(declared in NAMES)) throw invalid('Please upload a PNG, JPEG, WebP or GIF image.');
  if (!params.includes('base64')) throw invalid('That image could not be read. Please try uploading it again.');
  // Checked before decoding, so an oversized upload is refused without being held in memory twice.
  if (payload.length > Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 4) throw new HttpError(413, 'too_large', 'That image is larger than 3 MB. Please choose a smaller one.');
  if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw invalid('That image could not be read. Please try uploading it again.');

  const data = new Uint8Array(Buffer.from(payload, 'base64'));
  if (data.byteLength === 0) throw invalid('That image is empty. Please choose another one.');
  if (data.byteLength > MAX_ASSET_BYTES) throw new HttpError(413, 'too_large', 'That image is larger than 3 MB. Please choose a smaller one.');

  const actual = sniffImageType(data);
  if (actual !== declared) {
    throw invalid(
      actual
        ? `That file is a ${NAMES[actual]} image, not a ${NAMES[declared]} one. Please upload it again.`
        : `That file does not look like a ${NAMES[declared]} image. Please upload a PNG, JPEG, WebP or GIF image.`,
    );
  }
  return { contentType: declared, data };
}

/** A short tag stored next to the image: what it was uploaded for. */
export function cleanPurpose(purpose: unknown): string {
  return typeof purpose === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(purpose) ? purpose : 'image';
}
