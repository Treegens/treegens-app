// What is kept about an uploaded file that was turned into a PDF (src/server/convert.ts makes the PDF): the original
// itself, stored like any other file (encrypted when FILE_ENCRYPTION_KEY is set) and linked to the PDF's row in
// `files` (original_sha256, and `converted` with its name, fingerprint, the tool and the notes); the audit line when
// a document made from it is sent or put on by a correction; and the original in the evidence pack. The PDF is what
// is signed. The original is what the sender gave us, kept so anyone can see what the PDF was made from.
import { all, get, run, saveBlob, readBlob } from './db.ts';
import { now, sha256, str, bad, HttpError } from './util.ts';
import { audit, type Actor } from './envelopes.ts';
import { lureIn } from './fakenotice.ts';
import { safeName, type ZipEntry } from './zip.ts';
import { toPdf, converterOn, KINDS, type Conversion } from './convert.ts';
import { convertedOf, type Converted } from '../lib/convert.ts';

/** Turns an upload into a PDF when it is a file this server converts. Null when it is a PDF, PNG or JPEG (and for a
 *  signer's attachment, or several pictures in one upload, which go on as before). */
export async function convertUpload(bytes: Uint8Array, fileName: string, accountId: string | null, parts: number): Promise<(Conversion & { from: string; original: Uint8Array }) | null> {
  // A file a signer attaches is not converted: the converter is for the sender's own documents.
  if (!accountId) return null;
  if (parts > 1) {
    // Several files in one upload are the photos of one paper document. Anything else is uploaded one at a time.
    const picture = (bytes[0] === 0x89 && bytes[1] === 0x50) || (bytes[0] === 0xff && bytes[1] === 0xd8);
    if (!picture && converterOn()) throw bad('Several files in one upload are joined into one document, a page for each picture. That works for PNG and JPEG pictures only. Upload PDFs and other files one at a time. No document was made.');
    return null;
  }
  const made = await toPdf(bytes, accountId);
  return made ? { ...made, from: str(fileName, 200).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || `document${KINDS[made.kind].ext}`, original: bytes } : null;
}

/** Keeps the original with the PDF's row and answers what is said about it. */
export function keepOriginal(fileId: string, c: Conversion & { from: string; original: Uint8Array }): Converted {
  const sha = saveBlob(c.original);
  const kept: Converted = { from: c.from, kind: c.kind, family: KINDS[c.kind].family, sha256: sha, size: c.original.length, tool: c.tool, notes: c.notes, at: now() };
  run('UPDATE files SET original_sha256=?, converted=? WHERE id=?', sha, JSON.stringify(kept), fileId);
  return kept;
}

/** The original's name as the record prints it. A name that reads like a payment notice with a phone number is the
 *  one thing the record does not repeat (the certificate goes to every signer): the kind of file is said instead. */
function nameForRecord(c: Converted): string {
  return lureIn([c.from]) ? `a ${KINDS[c.kind as keyof typeof KINDS]?.ext || 'file'} file (its name is left out of this record because it reads like a payment notice)` : c.from;
}

const line = (c: Converted, d: { name: string; sha256: string }) =>
  `Converted from ${nameForRecord(c)} (SHA-256 ${c.sha256}) to PDF by ${c.tool}. The PDF is what is signed (SHA-256 ${d.sha256}), as the document "${str(d.name, 200)}". The original is kept with the envelope and is in its evidence pack.`;

/** Every document of an envelope that was made from a converted file, with what is kept about it. */
function convertedDocs(e: any): { d: any; c: Converted }[] {
  return (e.documents || []).flatMap((d: any) => {
    const c = convertedOf(get('SELECT converted FROM files WHERE id=?', d.file_id)?.converted);
    return c ? [{ d, c }] : [];
  });
}

/** The audit lines when an envelope goes out: one for each document made from a converted file. Inside the send. */
export function convertedSent(e: any, actor: Actor) {
  for (const { d, c } of convertedDocs(e)) audit(e.id, actor, 'Converted to PDF', line(c, d));
}

/** The same for a correction: documents that are new, or whose file was replaced by one made from a converted file. */
export function convertedAdded(before: any, after: any, actor: Actor) {
  const had = new Map<string, string>((before.documents || []).map((d: any) => [d.id, d.file_id]));
  for (const { d, c } of convertedDocs(after)) if (had.get(d.id) !== d.file_id) audit(after.id, actor, 'Converted to PDF', line(c, d));
}

/** The originals for the evidence pack, under originals/, with what could not be read said in `notes`. */
export function originalsEvidence(e: any, notes: string[]): ZipEntry[] {
  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  convertedDocs(e).forEach(({ d, c }, i) => {
    if (seen.has(c.sha256)) return;
    seen.add(c.sha256);
    const sha = get('SELECT original_sha256 s FROM files WHERE id=?', d.file_id)?.s;
    try {
      const data = readBlob(sha);
      if (sha256(data) !== c.sha256) throw new HttpError(500, 'changed');
      out.push({ name: `originals/${String(i + 1).padStart(2, '0')} ${safeName(c.from)}`, data });
    } catch (err) {
      if (!(err instanceof HttpError) && !(err instanceof Error)) throw err;
      notes.push(`The original of the document "${str(d.name, 200)}" (${nameForRecord(c)}, SHA-256 ${c.sha256}) could not be read from storage, so it is not in this pack. The PDF made from it is.`);
    }
  });
  return out;
}

/** The stored originals of an account's files, so deleting the account deletes them too. */
export const originalShas = (accountId: string): string[] => all('SELECT original_sha256 s FROM files WHERE account_id=? AND original_sha256 IS NOT NULL', accountId).map((r) => r.s);
