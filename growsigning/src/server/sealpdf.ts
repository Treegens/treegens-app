// The PDF side of the digital seal: an invisible approval signature appended to a finished PDF as an incremental
// update (ISO 32000-1 clause 7.5.6), so not one byte of the file as it was rendered changes. pdf-lib is used only to
// read the file and to write out the two dictionaries the update must repeat (the catalog or form, and the page the
// invisible field sits on); the update itself is written here.
//
// What the update holds, checked against ETSI EN 319 142-1 V1.1.1 clause 6.3, Table 1, and ISO 32000-1 clause 12.8:
//   - A signature dictionary with /Filter /Adobe.PPKLite and /SubFilter /ETSI.CAdES.detached (Table 1, row
//     "SubFilter"), /M with the time of sealing (Table 1, row "M"; the signing-time attribute is not used), no /Cert
//     entry (Table 1: shall not be present), /ByteRange and /Contents.
//   - /ByteRange covering the whole file except the /Contents value, including its angle brackets (ISO 32000-1
//     clause 12.8.1; Table 1 asks for the whole document to be covered).
//   - /Contents: a fixed-size hex placeholder, filled with the DER of the CMS SignedData and zeros after it.
//   - An invisible signature field (a widget with an empty /Rect, flags Print and Locked) on the last page, in the
//     form's /Fields, with /SigFlags 3 (signatures exist, append only).
//   - A new cross-reference section in the same form as the file's last one (a stream after a stream, a table after a
//     table), with /Prev pointing at it.
import crypto from 'node:crypto';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } from 'pdf-lib';

/** Room for the CMS: 32 KB, enough for a chain of four certificates and a time-stamp token with its own chain. */
export const CONTENTS_BYTES = 32 * 1024;
const BYTE_RANGE_SLOT = 46; // "[0 1234567890 1234567890 1234567890]" fits, padded with spaces
export const SEAL_FIELD = 'Seal';
/** What a reader shows as the reason of the seal, so nobody takes it for a person's signature. Plain ASCII. */
export const SEAL_REASON = 'Sealed by the server when the document was completed. Not a signature of a person who signed.';

export type Prepared = {
  /** The whole file with the update, /Contents still zeros. */
  bytes: Buffer;
  byteRange: [number, number, number, number];
  /** Where the hex digits of /Contents start, and how many there are. */
  hexAt: number;
  hexLength: number;
};

/** The PDF date of a moment, in UTC (ISO 32000-1 clause 7.9.4). */
export function pdfDate(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
}

export function lastStartXref(buf: Buffer): number {
  const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1');
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!m) throw new Error('the PDF has no cross-reference position at its end');
  return Number(m[1]);
}

// What the file's last cross-reference section says: its kind, the number of objects and its trailer entries.
export function lastSection(buf: Buffer, at: number): { stream: boolean; size: number } {
  const head = buf.subarray(at, Math.min(buf.length, at + 64)).toString('latin1');
  const stream = !/^\s*xref\b/.test(head);
  let from = at;
  if (!stream) {
    const t = buf.indexOf('trailer', at, 'latin1');
    if (t < 0) throw new Error('the PDF has a cross-reference table without a trailer');
    from = t;
  }
  const dict = buf.subarray(from, Math.min(buf.length, from + 4096)).toString('latin1');
  const size = /\/Size\s+(\d+)/.exec(dict);
  if (!size) throw new Error('the PDF does not say how many objects it has');
  return { stream, size: Number(size[1]) };
}

const obj = (n: number, body: string) => `${n} 0 obj\n${body}\nendobj\n`;

/**
 * Appends an empty seal to `pdf`: the field, the signature dictionary with a zeroed /Contents, and the new
 * cross-reference section. `pdf` must be a PDF this server rendered (not encrypted). `kind` 'timestamp': a document
 * time stamp instead (ETSI EN 319 142-1 clause 5.5: /Type /DocTimeStamp, /SubFilter /ETSI.RFC3161, no /M), in a
 * field of its own, for the long-term step in ltv.ts.
 */
export async function prepareSeal(pdf: Uint8Array, when: Date, contentsBytes = CONTENTS_BYTES, kind: 'seal' | 'timestamp' = 'seal'): Promise<Prepared> {
  const prefix = Buffer.from(pdf);
  const doc = await PDFDocument.load(prefix, { updateMetadata: false });
  if (doc.isEncrypted) throw new Error('an encrypted PDF cannot be sealed here');
  const prevXref = lastStartXref(prefix);
  const prev = lastSection(prefix, prevXref);
  const trailer = doc.context.trailerInfo;
  const root = trailer.Root as PDFRef;
  if (!(root instanceof PDFRef)) throw new Error('the PDF has no catalog');

  let next = Math.max(prev.size, doc.context.largestObjectNumber + 1);
  const sigNum = next++;
  const widgetNum = next++;
  const widgetRef = PDFRef.of(widgetNum, 0);

  // The page the invisible field belongs to: the last one, the end of the certificate of completion.
  const pages = doc.getPages();
  const page = pages[pages.length - 1];
  const pageDict = page.node.clone() as PDFDict;
  const annots = page.node.lookup(PDFName.of('Annots'));
  const list = annots instanceof PDFArray ? annots.asArray() : [];
  pageDict.set(PDFName.of('Annots'), doc.context.obj([...list, widgetRef]));

  // The form: a new one in the catalog, or the one there with this field added.
  const rewrites: [number, string][] = [[page.ref.objectNumber, pageDict.toString()]];
  const catalog = doc.catalog.clone() as PDFDict;
  const formValue = doc.catalog.get(PDFName.of('AcroForm'));
  const form = (formValue instanceof PDFRef ? doc.context.lookup(formValue) : formValue) as PDFDict | undefined;
  const newForm = form instanceof PDFDict ? (form.clone() as PDFDict) : doc.context.obj({}) as PDFDict;
  const fields = newForm.lookup(PDFName.of('Fields'));
  newForm.set(PDFName.of('Fields'), doc.context.obj([...(fields instanceof PDFArray ? fields.asArray() : []), widgetRef]));
  newForm.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  if (formValue instanceof PDFRef) rewrites.push([formValue.objectNumber, newForm.toString()]);
  else {
    catalog.set(PDFName.of('AcroForm'), newForm);
    rewrites.push([root.objectNumber, catalog.toString()]);
  }

  const placeholderHex = '0'.repeat(contentsBytes * 2);
  const sigBody = kind === 'timestamp'
    ? `<<\n/Type /DocTimeStamp\n/Filter /Adobe.PPKLite\n/SubFilter /ETSI.RFC3161\n/ByteRange ${' '.repeat(BYTE_RANGE_SLOT)}\n/Contents <${placeholderHex}>\n>>`
    : `<<\n/Type /Sig\n/Filter /Adobe.PPKLite\n/SubFilter /ETSI.CAdES.detached\n/M (${pdfDate(when)})\n/Reason (${SEAL_REASON})\n/ByteRange ${' '.repeat(BYTE_RANGE_SLOT)}\n/Contents <${placeholderHex}>\n>>`;
  const widgetBody = `<<\n/Type /Annot\n/Subtype /Widget\n/FT /Sig\n/T (${kind === 'timestamp' ? 'Time stamp' : SEAL_FIELD})\n/F 132\n/Rect [0 0 0 0]\n/P ${page.ref.toString()}\n/V ${sigNum} 0 R\n>>`;

  const parts: Buffer[] = [prefix];
  let length = prefix.length;
  const add = (s: string | Buffer) => {
    const b = typeof s === 'string' ? Buffer.from(s, 'latin1') : s;
    parts.push(b);
    length += b.length;
  };
  if (prefix[prefix.length - 1] !== 0x0a && prefix[prefix.length - 1] !== 0x0d) add('\n');
  const offsets = new Map<number, number>();
  const put = (n: number, body: string) => {
    offsets.set(n, length);
    add(obj(n, body));
  };
  const sigAt = length;
  put(sigNum, sigBody);
  put(widgetNum, widgetBody);
  for (const [n, body] of rewrites) put(n, body);

  // A file identifier: the one the file had, or a new one from its bytes (ISO 32000-1 clause 14.4).
  const idOld = trailer.ID instanceof PDFArray ? trailer.ID.asArray().map((x) => x.toString()) : null;
  const fresh = `<${crypto.createHash('sha256').update(prefix).digest('hex').slice(0, 32)}>`;
  const id = `[${idOld?.[0] || fresh} ${fresh}]`;
  const info = trailer.Info instanceof PDFRef ? `/Info ${trailer.Info.toString()}\n` : '';

  if (prev.stream) {
    const xrefNum = next++;
    offsets.set(xrefNum, length);
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const index: number[] = [];
    const rows: Buffer[] = [];
    for (let i = 0; i < nums.length; ) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      index.push(nums[i], j - i + 1);
      for (let k = i; k <= j; k++) {
        const row = Buffer.alloc(7);
        row[0] = 1;
        row.writeUInt32BE(offsets.get(nums[k])!, 1);
        row.writeUInt16BE(0, 5);
        rows.push(row);
      }
      i = j + 1;
    }
    const data = Buffer.concat(rows);
    add(`${xrefNum} 0 obj\n<<\n/Type /XRef\n/Size ${next}\n/Index [${index.join(' ')}]\n/W [1 4 2]\n/Root ${root.toString()}\n${info}/ID ${id}\n/Prev ${prevXref}\n/Length ${data.length}\n>>\nstream\n`);
    add(data);
    add(`\nendstream\nendobj\nstartxref\n${offsets.get(xrefNum)}\n%%EOF\n`);
  } else {
    const xrefAt = length;
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    let table = 'xref\n';
    for (let i = 0; i < nums.length; ) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      table += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) table += `${String(offsets.get(nums[k])).padStart(10, '0')} 00000 n\r\n`;
      i = j + 1;
    }
    add(`${table}trailer\n<<\n/Size ${next}\n/Root ${root.toString()}\n${info}/ID ${id}\n/Prev ${prevXref}\n>>\nstartxref\n${xrefAt}\n%%EOF\n`);
  }

  const bytes = Buffer.concat(parts);
  const sigText = sigBody;
  const hexStart = sigAt + `${sigNum} 0 obj\n`.length + sigText.indexOf('/Contents <') + '/Contents <'.length;
  const open = hexStart - 1;
  const close = hexStart + placeholderHex.length + 1;
  const byteRange: Prepared['byteRange'] = [0, open, close, bytes.length - close];
  const slot = `[${byteRange.join(' ')}]`;
  if (slot.length > BYTE_RANGE_SLOT) throw new Error('the PDF is too large to seal');
  const slotAt = sigAt + `${sigNum} 0 obj\n`.length + sigText.indexOf('/ByteRange ') + '/ByteRange '.length;
  bytes.write(slot.padEnd(BYTE_RANGE_SLOT, ' '), slotAt, 'latin1');
  return { bytes, byteRange, hexAt: hexStart, hexLength: placeholderHex.length };
}

/**
 * Takes the signature fields off the pages of a loaded PDF, before pages are copied out of it into another file (the
 * certificate on its own in an evidence pack). A copied page would otherwise carry the seal's field along, pointing
 * at byte ranges of the file it was cut from, and a reader would show a broken signature on the extract.
 */
export function dropSignatureFields(doc: PDFDocument) {
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    const keep = annots.asArray().filter((a) => {
      const d = a instanceof PDFRef ? doc.context.lookup(a) : a;
      return !(d instanceof PDFDict && d.get(PDFName.of('FT')) === PDFName.of('Sig'));
    });
    if (keep.length !== annots.size()) page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
  }
}

/** The bytes the seal covers: everything but the /Contents value. */
export const coveredBytes = (bytes: Buffer, r: [number, number, number, number]) => Buffer.concat([bytes.subarray(r[0], r[0] + r[1]), bytes.subarray(r[2], r[2] + r[3])]);

/** Puts the CMS into the placeholder. Throws when it does not fit. */
export function fillSeal(p: Prepared, cms: Buffer): Buffer {
  const hex = cms.toString('hex');
  if (hex.length > p.hexLength) throw new Error(`the seal needs ${cms.length} bytes and only ${p.hexLength / 2} are reserved`);
  const out = Buffer.from(p.bytes);
  out.write(hex, p.hexAt, 'latin1');
  return out;
}
