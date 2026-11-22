// The photos that pages were cleaned from. When the sender's browser finds the page in a photo, straightens it and
// raises its contrast (src/components/editor/scan.ts), it uploads the cleaned picture as the page and the photo
// before cleanup next to it, in a part named scan_original_<n> (n: the picture's place in the upload, from 0). The
// photo is kept with the file, said under the document in the editor, and put in the evidence pack. It is never
// shown to signers and was not signed. "Undo cleanup" makes the document again from the photos (POST
// /files/:id/undo-cleanup). Rows go with their file (the trigger in db.ts); sweepScanPhotos takes the photos off
// the disk afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, saveBlob, readBlob, dataDir } from './db.ts';
import { now, sha256, str } from './util.ts';
import { safeName, type ZipEntry } from './zip.ts';
import { CLEANED_EVIDENCE } from '../lib/phoneapp.ts';

/** One photo can be up to this large, and the photos of one upload together up to SCAN_PHOTOS_MAX_TOTAL. */
export const SCAN_PHOTO_MAX = 12_000_000;
export const SCAN_PHOTOS_MAX_TOTAL = 40_000_000;

const isPicture = (b: Uint8Array) => (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff);

/**
 * Keeps the photos that came with an upload. Called by storeUpload once the file is stored. When the browser cleaned
 * any picture of an upload it sends the photo of every picture (so "Undo cleanup" can make the whole document again)
 * and "scan_cleaned": the places of the cleaned ones, from 0, with commas. A part that is not a PNG or JPEG or is too
 * large is left out, and then nothing of this upload is kept: a document that cannot be made again whole is not
 * offered to be. Files that signers attach have none.
 */
export async function keepScanPhotos(fileId: string, form: FormData | null, accountId: string | null, pictures: number): Promise<number[]> {
  if (!form || !accountId) return [];
  const said = String(form.get('scan_cleaned') || '');
  const cleaned = new Set(said.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n < pictures));
  if (!cleaned.size) return [];
  const photos: { bytes: Uint8Array; name: string }[] = [];
  let total = 0;
  for (let n = 0; n < pictures; n++) {
    const part = form.get(`scan_original_${n}`);
    if (!part || typeof part === 'string' || part.size > SCAN_PHOTO_MAX || (total += part.size) > SCAN_PHOTOS_MAX_TOTAL) return [];
    const bytes = new Uint8Array(await part.arrayBuffer());
    if (!isPicture(bytes)) return [];
    photos.push({ bytes, name: str(part.name, 200) });
  }
  photos.forEach((p, n) => run('INSERT OR REPLACE INTO scan_photos (file_id, page, sha256, size, name, cleaned, created_at) VALUES (?,?,?,?,?,?,?)', fileId, n + 1, saveBlob(p.bytes), p.bytes.length, p.name || null, cleaned.has(n) ? 1 : 0, now()));
  return [...cleaned].sort((a, b) => a - b).map((n) => n + 1);
}

/** The pages of a file that were cleaned from a photo, counted from 1. */
export const cleanedPages = (fileId: string): number[] => all('SELECT page FROM scan_photos WHERE file_id=? AND cleaned=1 ORDER BY page', fileId).map((r: any) => r.page);

/** For a document as the sender's screens read it: cleaned_pages, only when some page was cleaned. */
export function cleanedField(fileId: string): { cleaned_pages?: number[] } {
  const pages = cleanedPages(fileId);
  return pages.length ? { cleaned_pages: pages } : {};
}

/** A file made from another by removing, turning or moving pages keeps the photos of the pages it kept (pages.ts). */
export function copyScanPhotos(fromFileId: string, toFileId: string, fromPages: number[]) {
  const had = new Map(all('SELECT page, sha256, size, name, cleaned, created_at FROM scan_photos WHERE file_id=?', fromFileId).map((r: any) => [r.page, r]));
  fromPages.forEach((p, i) => {
    const r = had.get(p);
    if (r) run('INSERT OR REPLACE INTO scan_photos (file_id, page, sha256, size, name, cleaned, created_at) VALUES (?,?,?,?,?,?,?)', toFileId, i + 1, r.sha256, r.size, r.name, r.cleaned, r.created_at);
  });
  // Undo cleanup needs a photo for every page: a file that kept only some of them offers it no more.
  // The photos of cleaned pages stay all the same, for the evidence pack.
  if (all('SELECT 1 x FROM scan_photos WHERE file_id=?', toFileId).length !== fromPages.length) run('DELETE FROM scan_photos WHERE file_id=? AND cleaned=0', toFileId);
}

/** The photos of every page of a file in page order, for "Undo cleanup"; null when some page has none. */
export function scanPhotosOf(fileId: string, pages: number): { page: number; name: string | null; data: Buffer }[] | null {
  const rows = all('SELECT page, sha256, name FROM scan_photos WHERE file_id=? ORDER BY page', fileId);
  if (rows.length !== pages || rows.some((r: any, i: number) => r.page !== i + 1)) return null;
  return rows.map((r: any) => ({ page: r.page, name: r.name, data: readBlob(r.sha256) }));
}

/** Every photo of the envelope's documents, for the evidence pack, with index.csv and the README line. */
export function scanPhotosEvidence(e: any, notes: string[]): { files: ZipEntry[]; readme: string[] } {
  const files: ZipEntry[] = [];
  const index = ['"file","document","page","sha256"'];
  (e.documents || []).forEach((d: any, i: number) => {
    for (const r of all('SELECT page, sha256, name FROM scan_photos WHERE file_id=? AND cleaned=1 ORDER BY page', d.file_id)) {
      try {
        const data = readBlob(r.sha256);
        if (sha256(data) !== r.sha256) throw new Error('changed');
        const ext = data[0] === 0x89 ? 'png' : 'jpg';
        const name = `scan-photos/${String(i + 1).padStart(2, '0')} ${safeName(d.name)} page ${r.page}.${ext}`;
        files.push({ name, data });
        index.push([name, d.name, r.page, r.sha256].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
      } catch {
        notes.push(`The photo that page ${r.page} of "${str(d.name, 200)}" was cleaned from (SHA-256 ${r.sha256}) could not be read from storage, so it is not in this pack. The cleaned page is in the PDF.`);
      }
    }
  });
  if (!files.length) return { files, readme: [] };
  files.push({ name: 'scan-photos/index.csv', data: Buffer.from('﻿' + index.join('\r\n')) });
  return { files, readme: [CLEANED_EVIDENCE] };
}

/** Takes the photos of deleted files off the disk, once no file, signed copy or other photo row still uses them. */
export function sweepScanPhotos(): number {
  let gone = 0;
  for (const { sha256: sha } of all('SELECT sha256 FROM scan_photos_gone LIMIT 500')) {
    run('DELETE FROM scan_photos_gone WHERE sha256=?', sha);
    if (!/^[0-9a-f]{64}$/.test(sha)) continue;
    if (get('SELECT 1 x FROM scan_photos WHERE sha256=?', sha) || get('SELECT 1 x FROM files WHERE sha256=? OR original_sha256=?', sha, sha) || get('SELECT 1 x FROM envelopes WHERE final_sha256=?', sha)) continue;
    fs.rmSync(path.join(dataDir(), 'blobs', sha), { force: true });
    gone++;
  }
  return gone;
}
