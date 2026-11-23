// Removing, turning and moving the pages of one document before it is sent (research/docusign-gaps.json, batch
// "page-tools"). A sender fixes a sideways scan or drops a blank page without making a new file themselves.
//
// The document's file is never changed: a new file is made from it (pdf-lib copyPages and setRotation), stored like an
// upload (a converted file keeps its original and its conversion record), and read again for search. The new file
// remembers which file it was made from and what was done (files.page_ops), so when the document is saved with it,
// the audit trail says so in words: "Page 3 removed from "Contract"". The certificate's fingerprint of the document is then the new file's, as for any file.
// The rules for which page goes where, and where a field goes with it, are in src/lib/pages.ts.
import { PDFDocument, degrees } from 'pdf-lib';
import { all, get, run, readBlob, saveBlob } from './db.ts';
import { bad, id, now } from './util.ts';
import { inspectPdf } from './pdf.ts';
import { extractPages, textOf } from './text.ts';
import { keepText } from './searchtext.ts';
import { audit, type Actor } from './envelopes.ts';
import { planPages, opWords, unchanged, type PagePlan } from '../lib/pages.ts';
import { chainOf } from './pagechain.ts';
import { queueOcr } from './ocr.ts';
import { convertedOf } from '../lib/convert.ts';
import { copyScanPhotos } from './scanphotos.ts';

export const PAGES_AUDIT = 'Pages changed';

/**
 * A new file made from `fileId` with the operations applied, stored for `accountId`. The answer has the file as an
 * upload gives it, the plan (which old page each new page is, and how far it was turned) and the changes in words.
 * Refused, with what to do, when the operations cannot be applied; nothing is stored then.
 */
export async function remakeFile(accountId: string, fileId: string, ops: any) {
  const src = get('SELECT * FROM files WHERE id=? AND account_id=?', fileId, accountId);
  if (!src) throw bad('The file of this document no longer exists. Upload it again, then change its pages.', 404);
  const planned = planPages(src.pages, ops);
  if ('error' in planned) throw bad(`${planned.error} Nothing was changed.`);
  if (unchanged(planned.plan, src.pages)) throw bad('These changes leave every page as it was, so nothing was changed. Remove, turn or move a page and try again.');
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(readBlob(src.sha256), { updateMetadata: false });
  } catch {
    throw bad('The file of this document could not be read again, so its pages were not changed. Replace the file with a fresh copy and try again.');
  }
  const out = await PDFDocument.create();
  const copied = await out.copyPages(doc, planned.plan.map((p) => p.from));
  copied.forEach((page, i) => {
    const turn = planned.plan[i].turn;
    if (turn) page.setRotation(degrees((((page.getRotation().angle + turn) % 360) + 360) % 360));
    out.addPage(page);
  });
  const bytes = await out.save();
  const info = await inspectPdf(bytes);
  const fid = id('fil');
  // Read again for search, and which pages are pictures, exactly as for an upload (storeUpload in routes-envelopes.ts).
  const read = await extractPages(bytes);
  const scanPages = !read.some((p) => p.trim()) ? Array.from({ length: info.pages }, (_, i) => i + 1) : read.flatMap((p, i) => (p.trim() ? [] : [i + 1]));
  const kept = keepText(fid, textOf(read));
  const sha = saveBlob(bytes);
  // A file made from a Word file or the like stays one: the original and what was said about the conversion go with it
  // (src/server/converted.ts), so the record still says what the PDF was made from and /files/:id/original works.
  run('INSERT INTO files (id, account_id, sha256, name, size, pages, page_sizes, created_at, text, scan_pages, text_sealed, text_key, page_ops, original_sha256, converted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    fid, accountId, sha, src.name, bytes.length, info.pages, JSON.stringify(info.sizes), now(), kept.text, scanPages.length ? JSON.stringify(scanPages) : null, kept.sealed, kept.key,
    JSON.stringify({ from: src.id, ops: planned.ops }), src.original_sha256 || null, src.converted || null);
  // The photos that its pages were cleaned from go with the pages they belong to (scanphotos.ts).
  copyScanPhotos(src.id, fid, planned.plan.map((p) => p.from + 1));
  // A new file is read again for its pictures of pages, like any upload (ocr.ts).
  if (accountId) queueOcr(fid, scanPages);
  return {
    file: { id: fid, name: src.name, pages: info.pages, page_sizes: info.sizes, size: bytes.length, sha256: sha, is_scan: scanPages.length > 0, scan_pages: scanPages, converted: convertedOf(src.converted) },
    plan: planned.plan as PagePlan,
    said: planned.ops.map(opWords),
  };
}

export { madeFrom } from './pagechain.ts';

/**
 * Called where a document's file is saved (writeContent in envelopes.ts), after the documents are written: each
 * document whose new file was made from its old one by changing pages gets one audit line, with what was done, how
 * many pages it has now and the fingerprint of the new file.
 */
export function notePageChanges(e: any, by?: Actor) {
  const before = new Map<string, any>((e.documents || []).map((d: any) => [d.id, d]));
  for (const d of all('SELECT d.id, d.file_id, d.name, f.pages, f.sha256 FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=? ORDER BY d.position', e.id)) {
    const old = before.get(d.id);
    if (!old || old.file_id === d.file_id) continue;
    const ops = chainOf(old.file_id, d.file_id);
    if (!ops?.length) continue;
    const name = `"${String(d.name).slice(0, 120)}"`;
    const words = ops.map((o) => `${opWords(o)} ${o.op === 'remove' ? 'from' : 'in'} ${name}.`);
    audit(e.id, by || { name: 'The sender' }, PAGES_AUDIT, `${words.join(' ')} ${name} now has ${d.pages} page${d.pages === 1 ? '' : 's'}, SHA-256 ${d.sha256}.`.slice(0, 4000));
  }
}
