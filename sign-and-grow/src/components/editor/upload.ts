'use client';
import { PHONE_SECONDS_PER_MB } from '../../lib/policy.ts';

// is_scan and scan_pages: the pages that are pictures with no text, counted from 1. See src/lib/scans.ts.
// size: the bytes of the stored PDF, which is what every signer downloads. See src/lib/phone.ts.
export type Uploaded = { id: string; name: string; pages: number; page_sizes: { w: number; h: number }[]; is_scan?: boolean; scan_pages?: number[]; size?: number };

export const MAX_BYTES = 25_000_000;
// What the server takes, and what that costs a signer on a phone (measured, see src/lib/phone.ts): both are true.
export const LIMITS = `PDF, PNG or JPEG. Up to 25 MB and 500 pages each. A signer on a phone waits about ${Math.round(PHONE_SECONDS_PER_MB)} seconds for each MB on a slow connection.`;
// Shown on touch screens only. A phone's own scanner straightens and cleans the page, which a plain photo does not.
export const PAPER_HINT = 'Starting from paper? Most phones can scan it to a PDF (on an iPhone in Notes or Files, on Android in Google Drive), and that gives the cleanest pages. Plain photos work too: choose all the pages at once and we make one document from them.';

const mb = (n: number) => `${(n / 1_000_000).toFixed(n < 100_000_000 ? 1 : 0)} MB`;
export const fmtSize = (n: number) => (n < 1_000_000 ? `${Math.max(1, Math.round(n / 1000))} KB` : mb(n));

/**
 * Problems we can see before sending a single byte. Returns '' when the file looks fine. `shrinksFirst` is for a
 * picture that is made smaller before it is uploaded (photos.ts): its size is judged after that, not before.
 */
export function precheck(file: File, shrinksFirst = false): string {
  if (file.size > MAX_BYTES && !shrinksFirst) return `This file is ${mb(file.size)}. Files can be up to 25 MB. Try compressing it, or split it into smaller documents.`;
  if (file.size === 0) return 'This file is empty. Choose a different file.';
  const known = /\.(pdf|png|jpe?g)$/i.test(file.name) || ['application/pdf', 'image/png', 'image/jpeg'].includes(file.type);
  if (!known) return 'Upload a PDF, PNG or JPEG. Export Word or Google Docs files as PDF first.';
  return '';
}

/**
 * Uploads one file and reports progress from 0 to 1 as the bytes leave the browser. fetch() cannot report upload
 * progress, so this uses XMLHttpRequest. Rejects with the message the server wrote, which is meant for people.
 * Several pictures given together are sent as one upload, and the server makes one document from them, a page
 * for each, in the order given.
 */
export function uploadFile(file: File | File[], onProgress: (fraction: number) => void): Promise<Uploaded> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.upload.onload = () => onProgress(1);
    xhr.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data.id) return resolve(data);
      if (data.error) return reject(new Error(data.error));
      if (xhr.status === 413) return reject(new Error('This file is too large to upload. Files can be up to 25 MB. Try compressing it, or split it into smaller documents.'));
      if (xhr.status === 401) return reject(new Error('You have been signed out. Sign in again in another tab, then try the upload once more.'));
      reject(new Error('The upload did not go through. Please try again in a moment.'));
    };
    xhr.onerror = () => reject(new Error('The upload did not go through. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('The upload was stopped. Try again when you are ready.'));
    const form = new FormData();
    for (const f of [file].flat()) form.append('file', f);
    xhr.send(form);
  });
}
