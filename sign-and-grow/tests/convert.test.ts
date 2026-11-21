// Turning office files into the PDF people sign (src/server/convert.ts, src/server/converted.ts, src/lib/convert.ts):
// every kind recognised from bytes built here (never from the name), ZIPs that unpack to far more than their size,
// the stub converter through the whole flow (the audit line, the evidence pack, the original kept encrypted and
// deleted with the account), the words next to the converted pages, the real LibreOffice when it is installed, and a
// stand-in for LibreOffice that hangs, sleeps or looks around, to prove the timeout kills the whole job, the queue
// holds, the temporary folder goes, no secret reaches it and it has no network.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { PDFDocument, PDFName } from 'pdf-lib';

// Every stored file in this test is encrypted, so "kept like any file" is checked on the disk.
process.env.FILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
import { boot, Client, PNG, signUp, signAll, samplePdf, tokenFor, type Server } from './helpers.ts';
import { detect, tiffPages, convertTesting, queueState, converterMode, sofficeLevel, convertMemoryMb, UNPACKED_MAX } from '../src/server/convert.ts';
import { safeHtml } from '../src/server/convert-html.ts';
import { boxed } from '../src/server/convert-box.ts';
import { extractPages } from '../src/server/text.ts';
import { acceptList, convertNotes, isConvertible, notTaken, uploadLimits, uploadLimitsShort, converterConfigured, CONVERT_KINDS_TEXT, CONVERT_NOTE, KNOWN_EXT, checkingLabel } from '../src/lib/convert.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});
const ROOT = path.resolve(import.meta.dirname, '..');
const hasSoffice = spawnSync('soffice', ['--version'], { timeout: 30_000 }).status === 0;
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SETTINGS = ['CONVERTER', 'CONVERTER_URL', 'CONVERT_TIMEOUT_MS', 'CONVERT_MAX_JOBS', 'CONVERT_MEMORY_MB'];
const set = (o: Record<string, string | undefined>) => {
  for (const k of SETTINGS) delete process.env[k];
  for (const [k, v] of Object.entries(o)) if (v !== undefined) process.env[k] = v;
};
afterEach(() => {
  set({});
  convertTesting.soffice = 'soffice';
  convertTesting.unshare = 'unshare';
  convertTesting.forget();
});

// ---- Files built here, byte by byte ---------------------------------------------------------------------------------

type Entry = [name: string, data: string | Uint8Array, deflate?: boolean, lieSize?: number];
function zip(entries: Entry[], o: { sameData?: number } = {}): Uint8Array {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  const offsets: number[] = [];
  for (const [name, text, deflate, lie] of entries) {
    const data = Buffer.from(text as any);
    const comp = deflate ? zlib.deflateRawSync(data) : data;
    const nb = Buffer.from(name);
    const crc = zlib.crc32(data) >>> 0;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x0800, 6); l.writeUInt16LE(deflate ? 8 : 0, 8);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(lie ?? data.length, 22); l.writeUInt16LE(nb.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(lie ?? data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    parts.push(l, nb, comp);
    central.push(c, nb);
    offsets.push(off);
    off += 30 + nb.length + comp.length;
  }
  // The same packed entry listed again and again in the directory: a ZIP that unpacks to many times its size
  // without saying so in any one entry.
  for (let i = 0; i < (o.sameData || 0); i++) {
    const c = Buffer.from(central[0]);
    central.push(c, central[1]);
  }
  const cd = Buffer.concat(central);
  const n = entries.length + (o.sameData || 0);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(n, 8); e.writeUInt16LE(n, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, e]));
}

const CT = (main: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${main}</Types>`;
const RELS = (target: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
function docx(body = para('Tree planting contract between Ada and the Grove'), more: Entry[] = []): Uint8Array {
  return zip([
    ['[Content_Types].xml', CT('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'), true],
    ['_rels/.rels', RELS('word/document.xml'), true],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`, true],
    ...more,
  ]);
}
const TRACKED = `${para('Agreed terms.')}<w:p><w:ins w:id="1" w:author="Ben" w:date="2026-01-01T00:00:00Z"><w:r><w:t>Words Ben added</w:t></w:r></w:ins></w:p>`;
function xlsx(): Uint8Array {
  return zip([
    ['[Content_Types].xml', CT('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'), true],
    ['_rels/.rels', RELS('xl/workbook.xml'), true],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Trees" sheetId="1" r:id="rId1"/></sheets></workbook>', true],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>', true],
    ['xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Mangroves</t></is></c><c r="B1"><v>1200</v></c></row></sheetData></worksheet>', true],
  ]);
}
const pptx = () => zip([['[Content_Types].xml', CT(''), true], ['_rels/.rels', RELS('ppt/presentation.xml'), true], ['ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>', true]]);
const odf = (mime: string, content = '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>', more: Entry[] = []) =>
  zip([['mimetype', mime], ['content.xml', content, true], ['META-INF/manifest.xml', '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>', true], ...more]);
// An old Office file: the compound file header, then one directory sector with a root and the named streams.
function ole(...streams: string[]): Uint8Array {
  const b = Buffer.alloc(512 * 3);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(b, 0);
  b.writeUInt16LE(9, 0x1e);
  ['Root Entry', ...streams].forEach((name, i) => {
    const p = 512 + i * 128;
    const n = Buffer.from(`${name}\0`, 'utf16le');
    n.copy(b, p);
    b.writeUInt16LE(n.length, p + 64);
    b[p + 66] = i === 0 ? 5 : 2;
  });
  return new Uint8Array(b);
}
// A TIFF with `pages` image directories, each empty but chained to the next.
function tiff(pages = 1): Uint8Array {
  const b = Buffer.alloc(8 + pages * 6);
  b.write('II', 0, 'latin1');
  b.writeUInt16LE(42, 2);
  b.writeUInt32LE(8, 4);
  for (let i = 0; i < pages; i++) {
    const at = 8 + i * 6;
    b.writeUInt16LE(0, at);
    b.writeUInt32LE(i === pages - 1 ? 0 : at + 6, at + 2);
  }
  return new Uint8Array(b);
}
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
const HTML = '<!doctype html><html><head><title>Lease</title></head><body><h1>Lease of the nursery</h1><p>Rent is due on the first.</p><img src="https://pictures.example.com/tree.png" alt="tree"></body></html>';

let n = 0;
async function person() {
  n++;
  return signUp(`Sender ${n}`, `convert${n}@example.com`, `198.51.100.${n}`);
}
async function put(c: Client, bytes: Uint8Array, name: string, type = 'application/octet-stream') {
  const f = new FormData();
  f.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
  return c.call('POST', '/files', f);
}
const mePlain = (c: Client) => c.get('/me');

// ---- 1. Recognised by its bytes ------------------------------------------------------------------------------------

test('every kind is recognised from its bytes, and the name does not decide', async () => {
  const kinds: [string, Uint8Array, string, string[]?][] = [
    ['docx', docx(), 'docx', []],
    ['docx with tracked changes', docx(TRACKED), 'docx', ['tracked']],
    ['docx with comments', docx(undefined, [['word/comments.xml', '<w:comments/>', true]]), 'docx', ['tracked']],
    ['xlsx', xlsx(), 'xlsx', ['sheet']],
    ['pptx', pptx(), 'pptx', []],
    ['odt', odf('application/vnd.oasis.opendocument.text'), 'odt', []],
    ['ods', odf('application/vnd.oasis.opendocument.spreadsheet'), 'ods', ['sheet']],
    ['odp', odf('application/vnd.oasis.opendocument.presentation'), 'odp', []],
    ['doc', ole('WordDocument', '1Table'), 'doc', []],
    ['xls', ole('Workbook'), 'xls', ['sheet']],
    ['ppt', ole('PowerPoint Document', 'Current User'), 'ppt', []],
    ['rtf', utf8('{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times;}} Hello trees.\\par }'), 'rtf', []],
    ['rtf with a revision', utf8('{\\rtf1\\ansi {\\revised Added words}\\par }'), 'rtf', ['tracked']],
    ['html', utf8(HTML), 'html', ['external']],
    ['html with no outside content', utf8('<html><body><p>Hi</p><a href="https://example.com">a link is not content</a></body></html>'), 'html', []],
    ['text', utf8('Tree planting contract\nሰላም, Grüße, 你好\n'), 'txt', []],
    ['text that starts like a BMP', utf8('BMW lease for the nursery van\n'), 'txt', []],
    ['tiff', tiff(), 'tiff', []],
    ['big-endian tiff', new Uint8Array([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0]), 'tiff', []],
  ];
  for (const [label, bytes, kind, notes] of kinds) {
    const d: any = await detect(bytes);
    assert.equal(d.kind, kind, label);
    if (notes) assert.deepEqual(d.notes, notes, label);
  }
  assert.equal((await detect(await samplePdf(1))).kind, 'pdf');
  assert.equal(tiffPages(tiff(3)), 3);
  // A picture in a ZIP or an unknown kind says what it is and what to do instead.
  const unknown: [Uint8Array, RegExp][] = [
    [utf8('GIF89a........'), /GIF picture/],
    [new Uint8Array([0xff, 0xfe, 0x48, 0, 0x69, 0]), /UTF-16.*UTF-8/],
    [new Uint8Array([0x48, 0xe9, 0x6c, 0x6c, 0x6f, 0x0a]), /not saved as UTF-8/],
    [zip([['photos/one.jpg', 'x'], ['notes.txt', 'y']]), /ZIP archive/],
    [zip([['mimetype', 'application/epub+zip'], ['OEBPS/a.xhtml', 'x']]), /EPUB/],
    [utf8('<?xml version="1.0"?><svg/>'), /XML or SVG/],
    [ole('__substg1.0_0037001F'), /Outlook message/],
    [zip([['index.xml', '<sl/>']]), /Pages, Numbers or Keynote/],
    [new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]), /a program, not a document/],
  ];
  for (const [bytes, why] of unknown) {
    const d: any = await detect(bytes);
    assert.equal(d.kind, 'unknown');
    assert.match(d.why, why);
  }
  // A password: said before any converter sees it.
  await assert.rejects(detect(ole('EncryptionInfo', 'EncryptedPackage')), /protected with a password/);
  await assert.rejects(detect(zip([['mimetype', 'application/vnd.oasis.opendocument.text'], ['content.xml', 'x', true], ['META-INF/manifest.xml', '<manifest:file-entry><manifest:encryption-data/></manifest:file-entry>', true]])), /password/);

  // Through the upload: a Word file called "scan.pdf" is converted, and a PDF called "Contract.docx" stays a PDF.
  set({ CONVERTER: 'stub' });
  const c = await person();
  const asWord = await put(c, docx(), 'scan.pdf', 'application/pdf');
  assert.equal(asWord.status, 200, JSON.stringify(asWord.data));
  assert.equal(asWord.data.converted.kind, 'docx');
  assert.equal(asWord.data.name, 'Scan', 'the name is the file name in words (src/lib/docname.ts)');
  const asPdf = await put(c, await samplePdf(1), 'Contract.docx');
  assert.equal(asPdf.status, 200);
  assert.equal(asPdf.data.converted, null);
  assert.equal(asPdf.data.name, 'Contract');
});

// ---- 1b. A ZIP that unpacks to far more than its size --------------------------------------------------------------

test('a zip bomb is refused before anything opens it, whatever sizes it claims', async () => {
  set({ CONVERTER: 'stub' });
  const c = await person();
  const zeros = new Uint8Array(30_000_000);
  // Honest about its sizes: 30 MB of text from a file of some 30 KB.
  const honest = docx(undefined, [['word/media/padding.xml', zeros, true]]);
  assert.ok(honest.length < 100_000);
  let r = await put(c, honest, 'Contract.docx');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /unpacks to more than 20 times its own size.*was not opened.*Nothing was saved/);
  // Lying: every entry claims to be one byte. The unpacking is counted, so the lie changes nothing.
  r = await put(c, docx(undefined, [['word/media/padding.xml', zeros, true, 1]]), 'Contract.docx');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /more than 20 times its own size/);
  // More than 100 MB in all from a file big enough that 20 times its size is more: one packed entry of 6 MB of
  // zeros listed 18 times, behind 6 MB of noise that does not pack.
  const noise = crypto.randomBytes(6_000_000);
  const many = zip([['word/media/zero.bin', new Uint8Array(6_000_000), true, 1], ['[Content_Types].xml', CT(''), true], ['word/document.xml', `<w:document ${W}/>`, true], ['word/media/noise.bin', noise]], { sameData: 17 });
  assert.ok(many.length * 20 > UNPACKED_MAX && many.length < 25_000_000);
  r = await put(c, many, 'Contract.docx');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /unpacks to more than 100 MB/);
  // Nothing was kept of any of them, and nothing was waiting for a converter.
  assert.equal(db.get("SELECT COUNT(*) n FROM files WHERE account_id=(SELECT account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?)", `convert${n}@example.com`).n, 0);
  assert.deepEqual(queueState(), { running: 0, waiting: 0 });
  // A packing method no office program writes is refused too, rather than handed on unchecked.
  const odd = Buffer.from(docx());
  odd.writeUInt16LE(14, odd.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 10);
  r = await put(c, new Uint8Array(odd), 'Contract.docx');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /could not be read as an office file/);
});

// ---- 2 and 3. The stub converter through the whole flow ------------------------------------------------------------

test('a Word file through the whole flow: the PDF is signed, the original is kept, recorded and in the evidence pack', async () => {
  set({ CONVERTER: 'stub' });
  const c = await person();
  assert.equal((await mePlain(c)).data.converts, true);
  const bytes = docx(TRACKED);
  const original = crypto.createHash('sha256').update(bytes).digest('hex');
  const up = await put(c, bytes, 'Contract.docx');
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.name, 'Contract');
  assert.deepEqual(up.data.converted.notes, ['tracked']);
  assert.equal(up.data.converted.from, 'Contract.docx');
  assert.equal(up.data.converted.sha256, original);
  assert.equal(up.data.converted.tool, 'the test converter');
  // It goes on exactly as a PDF: pages, text for search, no scan flag for a page with words.
  assert.equal(up.data.pages, 1);
  assert.equal(up.data.is_scan, false);
  const row = db.get('SELECT * FROM files WHERE id=?', up.data.id);
  assert.equal(row.original_sha256, original);
  assert.ok(row.text_sealed || /Stub conversion/.test(row.text || ''), 'the text was read for search');
  // The original is stored like any file: encrypted on the disk, read back whole.
  const onDisk = fs.readFileSync(path.join(process.env.DATA_DIR!, 'blobs', original));
  assert.notEqual(onDisk.subarray(0, 2).toString('latin1'), 'PK');
  assert.equal(onDisk.indexOf(Buffer.from('[Content_Types]')), -1);
  assert.deepEqual(new Uint8Array(db.readBlob(original)), bytes);
  // What the signer downloads is the PDF.
  const content = await c.get(`/files/${up.data.id}/content`);
  assert.equal(Buffer.from(content.data).subarray(0, 4).toString(), '%PDF');

  const made = await c.post('/envelopes', {
    subject: 'Contract to sign', documents: [{ id: 'd', file_id: up.data.id, name: 'Contract' }],
    recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: 'sam.convert@example.com' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const eid = made.data.envelope.id;
  // The draft carries what was said at upload, so the words come back when it is opened again.
  const again = (await c.get(`/envelopes/${eid}`)).data;
  assert.deepEqual((again.envelope || again).documents[0].converted.notes, ['tracked']);
  assert.equal((await c.post(`/envelopes/${eid}/send`)).status, 200);
  const line = db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Converted to PDF'", eid);
  assert.ok(line, 'the send says what the document was made from');
  assert.match(line.detail, new RegExp(`^Converted from Contract\\.docx \\(SHA-256 ${original}\\) to PDF by the test converter\\.`));
  assert.match(line.detail, new RegExp(`The PDF is what is signed \\(SHA-256 ${row.sha256}\\)`));
  // The signer sees the PDF and nothing of the original.
  const sign = await new Client().get(`/sign/${tokenFor(eid, 'sam.convert@example.com')}`);
  assert.ok(!JSON.stringify(sign.data).includes('Contract.docx'));
  assert.equal((await signAll(eid, 'sam.convert@example.com')).status, 200);
  const pack = await c.get(`/envelopes/${eid}/evidence`);
  assert.equal(pack.status, 200);
  const files = unzip(pack.data);
  const kept = [...files.keys()].find((k) => k.startsWith('originals/'));
  assert.equal(kept, 'originals/01 Contract.docx');
  assert.deepEqual(files.get(kept!), Buffer.from(bytes));
  const readme = files.get('README.txt')!.toString();
  assert.match(readme, /originals\/ +each file as the sender uploaded it.*These were not signed/);
  assert.match(files.get('audit-trail.txt')!.toString(), /Converted to PDF: Converted from Contract\.docx/);
  // The certificate in the signed PDF carries the line too, as every audit line.
  const text = (await extractPages(new Uint8Array(files.get('signed.pdf')!))).join(' ');
  assert.match(text, /Converted from Contract\.docx/);

  // Deleting the account deletes the original with everything else.
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR!, 'blobs', original)));
  assert.equal((await c.post('/me/delete', { password: 'correct horse battery', now: true })).status, 200);
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR!, 'blobs', original)), 'the stored original goes with the account');
});

// A small reader for the ZIPs the app writes (stored, never packed).
function unzip(data: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(data);
  const out = new Map<string, Buffer>();
  let p = 0;
  while (b.readUInt32LE(p) === 0x04034b50) {
    const size = b.readUInt32LE(p + 18), nl = b.readUInt16LE(p + 26), xl = b.readUInt16LE(p + 28);
    const name = b.subarray(p + 30, p + 30 + nl).toString('utf8');
    out.set(name, b.subarray(p + 30 + nl + xl, p + 30 + nl + xl + size));
    p += 30 + nl + xl + size;
  }
  return out;
}

test('the same original in two accounts stays while either has it, and a correction with a converted file is recorded', async () => {
  set({ CONVERTER: 'stub' });
  const a = await person(), b = await person();
  const bytes = docx(para('Shared wording'));
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const fa = (await put(a, bytes, 'Shared.docx')).data, fb = (await put(b, bytes, 'Shared.docx')).data;
  assert.equal(fa.converted.sha256, sha);
  assert.equal(fb.converted.sha256, sha);
  assert.equal((await a.post('/me/delete', { password: 'correct horse battery', now: true })).status, 200);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR!, 'blobs', sha)), 'the other account still has it');
  assert.deepEqual(new Uint8Array(db.readBlob(sha)), bytes);

  // A correction that replaces a document's file with a converted one says what it was made from.
  const pdf = new FormData();
  pdf.append('file', new Blob([await samplePdf(1)], { type: 'application/pdf' }), 'First.pdf');
  const first = (await b.call('POST', '/files', pdf)).data;
  const made = await b.post('/envelopes', {
    subject: 'Corrected later', documents: [{ id: 'd', file_id: first.id, name: 'First' }],
    recipients: [{ id: 'r', role: 'signer', name: 'Cy Signer', email: 'cy.convert@example.com' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  const eid = made.data.envelope.id;
  assert.equal((await b.post(`/envelopes/${eid}/send`)).status, 200);
  assert.equal(db.get("SELECT COUNT(*) n FROM audit WHERE envelope_id=? AND action='Converted to PDF'", eid).n, 0, 'a PDF says nothing of the kind');
  const out = (await b.get(`/envelopes/${eid}`)).data;
  const doc = (out.envelope || out).documents[0];
  const fixed = await b.put(`/envelopes/${eid}`, { documents: [{ id: doc.id, file_id: fb.id, name: 'First' }] });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
  assert.match(db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Converted to PDF'", eid).detail, /^Converted from Shared\.docx/);
});

// ---- 2. With no converter, and the refusals ------------------------------------------------------------------------

test('with no converter, uploads behave as before and the refusal names what needs one', async () => {
  set({});
  const c = await person();
  assert.equal((await mePlain(c)).data.converts, false);
  const r = await put(c, docx(), 'Contract.docx');
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'needs_converter');
  // One plain thing to do, and nothing about what only the people who run the server can set up: that goes in a
  // field of its own, for them.
  assert.equal(r.data.error, 'This is a Word file. Save it as a PDF and add it again. Nothing was saved.');
  assert.ok(!/converter|server|set up/i.test(r.data.error));
  assert.match(r.data.operator_hint, /^Word, Excel, PowerPoint, OpenDocument, RTF, plain text, web page \(HTML\) and TIFF files are turned into a PDF only on a server with a converter \(CONVERTER or CONVERTER_URL\)\. This server has none set up\.$/);
  // The browser says the same before a byte is sent, by the file's name, and the old sentence for anything else.
  assert.equal(notTaken(false, { name: 'Contract.docx' }), 'This is a Word file. Save it as a PDF and add it again.');
  assert.equal(notTaken(false, { name: 'Trees.xlsx' }), 'This is an Excel file. Save it as a PDF and add it again.');
  assert.equal(notTaken(false, { name: 'x.gif' }), 'Upload a PDF, PNG or JPEG. Export Word or Google Docs files as PDF first.');
  assert.match(read('src/components/editor/upload.ts'), /return notTaken\(converts, file\);/);
  assert.match((await put(c, utf8('GIF89a....'), 'x.gif')).data.error, /GIF picture.*Upload a PDF, PNG or JPEG\. Export Word or Google Docs files as PDF first\./);
  // With nothing to convert, nothing is unpacked: a bomb is refused like any Word file, at no cost.
  const t = Date.now();
  const bomb = await put(c, docx(undefined, [['word/media/padding.xml', new Uint8Array(30_000_000), true, 1]]), 'Contract.docx');
  assert.equal(bomb.data.code, 'needs_converter');
  assert.ok(Date.now() - t < 2000);
  // PDFs and pictures as always, and a production server ignores the test converter.
  assert.equal((await put(c, await samplePdf(1), 'a.pdf')).status, 200);
  set({ CONVERTER: 'stub' });
  const was = process.env.NODE_ENV;
  (process.env as any).NODE_ENV = 'production';
  try {
    assert.equal(converterMode(), null);
  } finally {
    if (was === undefined) delete (process.env as any).NODE_ENV;
    else (process.env as any).NODE_ENV = was;
  }
  set({ CONVERTER: 'something-else' });
  assert.equal((await mePlain(c)).data.converts, false);
  set({ CONVERTER_URL: 'not a url' });
  assert.equal((await mePlain(c)).data.converts, false);
});

test('what is refused with a converter: unknown kinds, several files at once, a signer\'s attachment, a TIFF that loses pages', async () => {
  set({ CONVERTER: 'stub' });
  const c = await person();
  let r = await put(c, utf8('GIF89a....'), 'x.gif');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /^This is a GIF picture\. Save it as PNG or JPEG and upload that\. Upload a PDF, PNG or JPEG, or Word, Excel.*TIFF files, which we turn into a PDF\. Nothing was saved\.$/);
  r = await put(c, ole('EncryptedPackage', 'EncryptionInfo'), 'Locked.docx');
  assert.match(r.data.error, /protected with a password/);
  // Several files in one upload are the photos of one paper document.
  const f = new FormData();
  f.append('file', new Blob([new Uint8Array(docx())]), 'a.docx');
  f.append('file', new Blob([Buffer.from(PNG.split(',')[1], 'base64')]), 'b.png');
  r = await c.call('POST', '/files', f);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /PNG and JPEG pictures only\. Upload PDFs and other files one at a time\. No document was made\./);
  // A TIFF of three pages that the converter makes one page of is refused, so no page goes missing.
  r = await put(c, tiff(3), 'Fax.tif');
  assert.equal(r.status, 422);
  assert.match(r.data.error, /This TIFF has 3 pages, and the converter made 1 of them/);
  assert.equal((await put(c, tiff(1), 'Fax.tif')).data.converted.kind, 'tiff');
  // A signer's attachment is not converted: the converter is for the sender's own documents.
  const pdf = new FormData();
  pdf.append('file', new Blob([await samplePdf(1)], { type: 'application/pdf' }), 'A.pdf');
  const file = (await c.call('POST', '/files', pdf)).data;
  const made = await c.post('/envelopes', {
    subject: 'Attach', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', name: 'Dee Signer', email: 'dee.convert@example.com' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'attachment', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  const eid = made.data.envelope.id;
  assert.equal((await c.post(`/envelopes/${eid}/send`)).status, 200);
  const signer = new Client();
  signer.ip = '198.51.100.250';
  const tok = tokenFor(eid, 'dee.convert@example.com');
  const att = new FormData();
  att.append('file', new Blob([new Uint8Array(docx())]), 'Proof.docx');
  r = await signer.call('POST', `/sign/${tok}/upload`, att);
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'Upload a PDF, PNG or JPEG. Export Word or Google Docs files as PDF first.');
});

test('a name that reads like a payment notice is not repeated on the certificate', async () => {
  set({ CONVERTER: 'stub' });
  const c = await person();
  const up = (await put(c, docx(), 'PayPal invoice $499 charged, call 1-800-555-0199.docx')).data;
  const made = await c.post('/envelopes', {
    subject: 'Contract', documents: [{ id: 'd', file_id: up.id, name: 'Contract' }],
    recipients: [{ id: 'r', role: 'signer', name: 'Eve Signer', email: 'eve.convert@example.com' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  assert.equal((await c.post(`/envelopes/${made.data.envelope.id}/send`)).status, 200);
  const detail = db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Converted to PDF'", made.data.envelope.id).detail;
  // (A fingerprint is random letters and digits and can hold "555" by chance, so it is left out of the check.)
  assert.ok(!/PayPal|555/.test(detail.replace(/[0-9a-f]{64}/g, '')), detail);
  assert.match(detail, /^Converted from a \.docx file \(its name is left out of this record because it reads like a payment notice\)/);
});

// ---- 4. The words next to the converted pages ----------------------------------------------------------------------

test('the words next to the converted pages: always the check, and tracked changes, sheets, outside content, macros', async () => {
  set({ CONVERTER: 'stub' });
  const c = await person();
  const tracked = (await put(c, docx(TRACKED), 'Contract.docx')).data;
  const words = convertNotes(tracked.converted);
  // Most urgent first: what the sender must do before sending, then the line that is always said.
  assert.equal(words[0], 'This file has tracked changes or comments. Accept or remove them first: the PDF shows them as they print.');
  assert.equal(words[1], 'Converted from Contract.docx. Check every page before you send: the PDF is what people sign, and text can move.');
  assert.deepEqual(convertNotes((await put(c, docx(), 'Clean.docx')).data.converted), ['Converted from Clean.docx. Check every page before you send: the PDF is what people sign, and text can move.']);
  assert.ok(convertNotes((await put(c, xlsx(), 'Trees.xlsx')).data.converted).includes('A sheet may be split across pages.'));
  // Outside content: a picture fetched from elsewhere counts, a web link someone clicks does not.
  const outsidePicture = docx(undefined, [['word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://pictures.example.com/a.png" TargetMode="External"/></Relationships>', true]]);
  const link = docx(undefined, [['word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>', true]]);
  assert.ok(convertNotes((await put(c, outsidePicture, 'Pictures.docx')).data.converted).includes('This file links to pictures or content stored elsewhere. They may be missing from the PDF.'));
  assert.deepEqual((await put(c, link, 'Link.docx')).data.converted.notes, []);
  assert.deepEqual((await put(c, utf8(HTML), 'Lease.html')).data.converted.notes, ['external']);
  const macros = docx(undefined, [['word/vbaProject.bin', 'macro bytes', true]]);
  assert.ok(convertNotes((await put(c, macros, 'Macros.docm')).data.converted).includes(CONVERT_NOTE.macros));
  const odt = odf('application/vnd.oasis.opendocument.text', '<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text><text:tracked-changes><text:changed-region text:id="c1"/></text:tracked-changes></office:text></office:body></office:document-content>');
  assert.deepEqual((await put(c, odt, 'Lease.odt')).data.converted.notes, ['tracked']);
  // Never a promise that the layout is the same, and no em dash anywhere.
  const all = [...Object.values(CONVERT_NOTE), words[0], uploadLimits(true, 3), notTaken(true), notTaken(false), CONVERT_KINDS_TEXT, read('src/lib/convert.ts'), read('src/server/convert.ts'), read('src/server/converted.ts')].join('\n');
  assert.ok(!/same layout|looks the same|exactly as|identical|\u2014/i.test(all.replace(/may not look the same/g, '')), 'no promise about the layout and no em dash');
  // The screens show them under each document in the editor and over its pages where fields are placed.
  // (simplify-editor: a file's row and its notes are in FileRow.tsx, which step 1 draws for each file.)
  assert.match(read('src/components/editor/StepAdd.tsx'), /<FileRow key=\{d\.id\} ed=\{ed\} d=\{d\} i=\{i\} \/>/);
  // One note line under a file: every sentence is a note of its own in the row, so the first shows and the rest fold
  // into "1 more note" with the file's other notes; over the pages the same, one line and a fold. Each carries the
  // feature's key (charter P3), and no screen says "conversion" or names the tool.
  const row = read('src/components/editor/FileRow.tsx');
  assert.match(row, /for \(const line of convertNotes\(d\.converted\)\) notes\.push\(<p key=\{line\} className="notice warn small ed-file-note" data-feature="ds-convert">\{line\}<\/p>\);/);
  assert.match(row, /\{notes\[0\]\}\s*\{notes\.length > 1 && \(\s*<details data-fold className="ed-fold">/);
  const over = read('src/components/editor/ConvertNotes.tsx');
  assert.match(over, /data-feature="ds-convert" role="note"/);
  assert.match(over, /<p className="notice warn small" style=\{\{ margin: 0 \}\}>\{lines\[0\]\}<\/p>\s*\{lines\.length > 1 && \(\s*<details data-fold className="ed-fold">\s*<summary>\{plural\(lines\.length - 1, 'more note'\)\}<\/summary>/);
  assert.match(read('src/components/editor/StepFields.tsx'), /<ConvertNotes d=\{d\} \/>/);
  assert.match(read('src/components/editor/StepAdd.tsx'), /data-feature=\{me\.converts \? 'ds-convert' : undefined\}>\{uploadLimitsShort\(!!me\.converts\)\}/);
  const onScreen = [...Object.values(CONVERT_NOTE), ...words, uploadLimitsShort(true), uploadLimitsShort(false), notTaken(false, { name: 'a.docx' }), checkingLabel('a.docx')].join(' ');
  assert.ok(!/conversion|LibreOffice|Gotenberg|MIME|converter|fetched/i.test(onScreen), onScreen);
  assert.equal(uploadLimitsShort(true), 'PDF, Word, Excel, PowerPoint or a picture. Up to 25 MB and 500 pages each.');
  // What the sentence about macros says is what is done: a setting. It does not say a macro cannot run.
  assert.equal(CONVERT_NOTE.macros, 'This file has macros. Macros are switched off when the PDF is made, so check that nothing is missing.');
  assert.match(read('src/server/convert.ts'), /DisableMacrosExecution" oor:op="fuse"><value>true<\/value>/);
  // A file's refusal never sticks out of its card on a phone.
  assert.match(read('src/app/styles/editor.css'), /\.ed-uploads \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
});

// ---- 5. The accept list, the API description, the settings --------------------------------------------------------

test('the file picker offers office files only on a server that converts, and the API and docs say so', async () => {
  assert.equal(acceptList(false), 'application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg');
  for (const e of ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.txt', '.html', '.tif', '.tiff']) assert.ok(acceptList(true).split(',').includes(e), e);
  assert.ok(isConvertible({ name: 'Lease.DOCX' }) && isConvertible({ name: 'x', type: 'application/msword' }) && !isConvertible({ name: 'a.pdf' }));
  assert.equal('Contract.docx'.replace(KNOWN_EXT, ''), 'Contract');
  assert.equal(checkingLabel('Contract.docx'), 'Making a PDF of it');
  assert.equal(checkingLabel('Contract.pdf'), 'Checking the pages');
  assert.match(uploadLimits(false, 3), /^PDF, PNG or JPEG\. Up to 25 MB/);
  assert.match(uploadLimits(true, 3), /Word, Excel.*which we turn into a PDF for you to check before anyone signs/);
  for (const f of ['src/components/editor/StepAdd.tsx']) {
    const s = read(f);
    assert.ok(!s.includes('accept="application/pdf,image/png,image/jpeg'), `${f}: the accept list comes from acceptList()`);
    assert.match(s, /acceptList\(!!me\.converts\)/);
  }
  const c = await person();
  const spec = (await c.get('/openapi.json')).data;
  const files = JSON.stringify(spec.paths['/files']);
  assert.match(files, /CONVERTER/);
  assert.match(files, /converts/);
  assert.ok(spec.components.schemas.File.properties.converted);
  for (const k of ['CONVERTER', 'CONVERTER_URL', 'CONVERT_TIMEOUT_MS', 'CONVERT_MAX_JOBS', 'CONVERT_MEMORY_MB']) {
    assert.match(read('.env.example'), new RegExp(`# ${k}=`), k);
    assert.match(read('README.md'), new RegExp(`\\| \`${k}\``), k);
  }
  assert.match(read('README.md'), /unshare -rn/);
  assert.ok(!/Word or Google Docs upload \(export to PDF first\)/.test(read('README.md')), 'the README no longer says Word files cannot be uploaded');
});

// ---- 2. LibreOffice: a stand-in that hangs, sleeps or looks around, and the real one ------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-fake-soffice-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));
function fakeSoffice(mode: 'ok' | 'hang' | 'slow' | 'nothing') {
  fs.writeFileSync(path.join(work, 'mode'), mode);
  const script = path.join(work, 'soffice');
  fs.writeFileSync(script, `#!/bin/sh
W='${work}'
for a in "$@"; do case "$a" in --version) echo "LibreOffice 9.9.9.9 fake"; exit 0;; esac; done
out=""; prev=""
for a in "$@"; do if [ "$prev" = "--outdir" ]; then out="$a"; fi; prev="$a"; done
echo "start $(date +%s%N)" >> "$W/log"
env > "$W/env.txt"
cat /proc/net/dev > "$W/net.txt"
pwd > "$W/cwd.txt"
MODE=$(cat "$W/mode")
if [ "$MODE" = "hang" ]; then sleep 300 & echo $! > "$W/child.pid"; echo $$ > "$W/parent.pid"; wait; fi
if [ "$MODE" = "slow" ]; then sleep 1; fi
if [ "$MODE" = "nothing" ]; then echo "source file could not be loaded" >&2; exit 1; fi
mkdir -p "$out"; cp "$W/sample.pdf" "$out/document.pdf"
echo "end $(date +%s%N)" >> "$W/log"
`, { mode: 0o755 });
  convertTesting.soffice = script;
  convertTesting.forget();
  fs.rmSync(path.join(work, 'log'), { force: true });
}
// A killed process whose parent is gone waits as a zombie until the first process of the machine collects it: that
// one is dead too.
const alive = (pid: number) => {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z';
  } catch {
    return false;
  }
};
const gone = async (pid: number) => {
  for (let i = 0; i < 30 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
  return !alive(pid);
};
const jobFolders = () => new Set(fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('sg-convert-')));

test('a job that runs too long is killed with everything it started, and its folder goes', async () => {
  fs.writeFileSync(path.join(work, 'sample.pdf'), await samplePdf(1));
  set({ CONVERTER: 'soffice', CONVERT_TIMEOUT_MS: '2000' });
  fakeSoffice('hang');
  const c = await person();
  const before = jobFolders();
  const t = Date.now();
  const r = await put(c, docx(), 'Slow.docx');
  assert.equal(r.status, 422, JSON.stringify(r.data));
  assert.equal(r.data.code, 'convert_timeout');
  assert.equal(r.data.error, 'Turning this file into a PDF took longer than 2 seconds, so it was stopped. Nothing was saved. Save it as a PDF in the program you made it with and upload that, or try a smaller file.');
  assert.ok(Date.now() - t < 8000);
  const parent = Number(fs.readFileSync(path.join(work, 'parent.pid'), 'utf8')), child = Number(fs.readFileSync(path.join(work, 'child.pid'), 'utf8'));
  assert.ok(await gone(parent), 'the job itself was killed');
  assert.ok(await gone(child), 'and what it started in the background');
  assert.deepEqual([...jobFolders()].filter((x) => !before.has(x)), [], 'its temporary folder was removed');
  // The job never sees this server's secrets, and runs in its own folder without a network where unshare works.
  const envSeen = fs.readFileSync(path.join(work, 'env.txt'), 'utf8');
  assert.ok(!/FILE_ENCRYPTION_KEY|APP_SECRET|DATA_DIR|STRIPE/.test(envSeen), envSeen);
  assert.match(fs.readFileSync(path.join(work, 'cwd.txt'), 'utf8'), /sg-convert-/);
  if (spawnSync('unshare', ['-rn', 'true']).status === 0) {
    const nets = fs.readFileSync(path.join(work, 'net.txt'), 'utf8').split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);
    assert.deepEqual(nets, ['lo'], 'only the loopback, which is down: no network at all');
  }
  // A job that makes no PDF says so, and so does one whose program is missing.
  fakeSoffice('nothing');
  const none = await put(c, docx(), 'Broken.docx');
  assert.equal(none.status, 422);
  assert.match(none.data.error, /^This file could not be turned into a PDF: the converter could not open it\./);
  convertTesting.soffice = path.join(work, 'not-there');
  convertTesting.forget();
  const missing = await put(c, docx(), 'Any.docx');
  assert.equal(missing.status, 400);
  assert.equal(missing.data.code, 'needs_converter', 'a LibreOffice that is not there means no converter');
  assert.equal((await mePlain(c)).data.converts, false);
});

test('at most CONVERT_MAX_JOBS run at once, the rest wait their turn, and one account cannot hold everyone up', async () => {
  set({ CONVERTER: 'soffice', CONVERT_MAX_JOBS: '1', CONVERT_TIMEOUT_MS: '20000' });
  fakeSoffice('slow');
  const a = await person(), b = await person();
  const [ra, rb] = await Promise.all([put(a, docx(), 'A.docx'), put(b, docx(), 'B.docx')]);
  assert.equal(ra.status, 200, JSON.stringify(ra.data));
  assert.equal(rb.status, 200, JSON.stringify(rb.data));
  assert.equal(ra.data.converted.tool, 'LibreOffice 9.9.9.9');
  const log = fs.readFileSync(path.join(work, 'log'), 'utf8').trim().split('\n').map((l) => l.split(' ')[0]);
  assert.deepEqual(log, ['start', 'end', 'start', 'end'], 'one after the other, never side by side');
  // A third upload from one account while two of its own are being made is refused in words, at once.
  set({ CONVERTER: 'soffice', CONVERT_MAX_JOBS: '4', CONVERT_TIMEOUT_MS: '20000' });
  const three = await Promise.all([put(a, docx(), '1.docx'), put(a, docx(), '2.docx'), put(a, docx(), '3.docx')]);
  const busy = three.find((r) => r.status === 429);
  assert.ok(busy, JSON.stringify(three.map((r) => r.status)));
  assert.match(busy!.data.error, /^2 of your files are being turned into PDF already\. Wait until one is done, then upload this one again\. Nothing was saved\.$/);
  assert.equal(three.filter((r) => r.status === 200).length, 2);
  assert.deepEqual(queueState(), { running: 0, waiting: 0 });
});

test('one account converts at most 60 files an hour, and is told when it can go on', async () => {
  set({ CONVERTER: 'stub' });
  const c = await person();
  const small = docx(para('One of many'));
  for (let i = 0; i < 60; i++) assert.equal((await put(c, small, `File ${i}.docx`)).status, 200, `upload ${i + 1}`);
  const r = await put(c, small, 'One more.docx');
  assert.equal(r.status, 429);
  assert.equal(r.data.code, 'convert_hourly');
  assert.match(r.data.error, /^This account has had 60 files turned into PDF in the last hour, which is the most we do in an hour\. Nothing was saved\. Try again in \d+ minutes, or upload a PDF, which needs no converting\.$/);
  // A PDF still goes through, and another account is not held up.
  assert.equal((await put(c, await samplePdf(1), 'Ready.pdf')).status, 200);
  assert.equal((await put(await person(), small, 'Other.docx')).status, 200);
});

test('the real LibreOffice turns a Word file, a sheet, a web page and a text into PDFs', { skip: !hasSoffice && 'LibreOffice is not installed here' }, async () => {
  set({ CONVERTER: 'soffice', CONVERT_TIMEOUT_MS: '120000' });
  const c = await person();
  const w = await put(c, docx(`${para('Tree planting contract between Ada and the Grove')}${para('Grüße and café')}`), 'Contract.docx');
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.match(w.data.converted.tool, /^LibreOffice \d+\.\d+/);
  assert.equal(w.data.is_scan, false);
  const pdf = new Uint8Array((await c.get(`/files/${w.data.id}/content`)).data);
  const text = (await extractPages(pdf)).join(' ');
  assert.match(text, /Tree planting contract between Ada and the Grove/);
  assert.match(text, /Grüße and café/);
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), w.data.pages);
  const x = await put(c, xlsx(), 'Trees.xlsx');
  assert.equal(x.status, 200, JSON.stringify(x.data));
  assert.match((await extractPages(new Uint8Array((await c.get(`/files/${x.data.id}/content`)).data))).join(' '), /Mangroves/);
  // A web page that points at a picture on another server converts without waiting for it.
  const t = Date.now();
  const h = await put(c, utf8(HTML), 'Lease.html');
  assert.equal(h.status, 200, JSON.stringify(h.data));
  assert.ok(Date.now() - t < 60_000);
  assert.deepEqual(h.data.converted.notes, ['external']);
  const txt = await put(c, utf8('First line of the note\nZweite Zeile: Größe\n'), 'Note.txt');
  assert.equal(txt.status, 200, JSON.stringify(txt.data));
  assert.match((await extractPages(new Uint8Array((await c.get(`/files/${txt.data.id}/content`)).data))).join(' '), /Größe/);
});

// ---- Repairs: what a file names outside itself, memory, an empty text, the original given back ---------------------

// A picture that can be found again inside a PDF by its size.
function picture(w = 137, h = 91): Buffer {
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = 255;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function picturesIn(pdf: Uint8Array): Promise<string[]> {
  const d = await PDFDocument.load(pdf);
  const out: string[] = [];
  for (const [, o] of d.context.enumerateIndirectObjects()) {
    const dict: any = (o as any).dict;
    if (dict && String(dict.get(PDFName.of('Subtype'))) === '/Image') out.push(`${dict.get(PDFName.of('Width'))}x${dict.get(PDFName.of('Height'))}`);
  }
  return out;
}
const SECRET = '/srv/secret/photo.png';
// Every way found (and a few more) for a web page to name a file on the server's disk or on another server.
const HTML_ATTACKS: Record<string, string> = {
  'body background, a bare path': `<html><body background="${SECRET}"><p>hello</p></body></html>`,
  'body background, file://': `<html><body background="file://${SECRET}"><p>hello</p></body></html>`,
  'body background, no quotes': `<html><body background=${SECRET}><p>hello</p></body></html>`,
  'body background, single quotes and capitals': `<HTML><BODY BACKGROUND='${SECRET}'><p>hello</p></BODY></HTML>`,
  'body background, spelled with entities': `<html><body background="&#102;ile&colon;//${SECRET.replace(/\//g, '&#x2f;')}"><p>hello</p></body></html>`,
  'a style sheet': `<html><head><style>body{background:url(file://${SECRET})}</style></head><body><p>hello</p></body></html>`,
  'a style sheet with an escape': `<html><head><style>body{background:u\\rl(file://${SECRET})}</style></head><body><p>hello</p></body></html>`,
  'a style sheet with a comment inside the word': `<html><head><style>body{background:ur/**/l("${SECRET}")}</style></head><body><p>hello</p></body></html>`,
  'a style sheet that imports another': `<html><head><style>@import "${SECRET}.css";</style></head><body><p>hello</p></body></html>`,
  'a style attribute': `<html><body><p style="background-image:url('${SECRET}')">hello</p></body></html>`,
  'a style attribute with entities': `<html><body><p style="background-image:&#117;rl(${SECRET})">hello</p></body></html>`,
  'a table and a cell': `<html><body><table background="${SECRET}"><tr><td background="${SECRET}">x</td></tr></table></body></html>`,
  'a picture': `<html><body><img src="${SECRET}"><img src="file://${SECRET}"><img src="//10.0.0.1${SECRET}"><img srcset="${SECRET} 2x" lowsrc="${SECRET}" dynsrc="${SECRET}"></body></html>`,
  'a picture on another server': `<html><body><img src="https://pictures.example.com${SECRET}"></body></html>`,
  'a linked style sheet and a base': `<html><head><base href="file:///srv/secret/"><link rel="stylesheet" href="${SECRET}.css"></head><body>x</body></html>`,
  'frames, objects, embeds': `<html><body><iframe src="${SECRET}"></iframe><object data="${SECRET}"></object><embed src="${SECRET}"><frameset><frame src="${SECRET}"></frameset></body></html>`,
  'an input and a list': `<html><body><input type="image" src="${SECRET}"><ul style="list-style-image:url(${SECRET})"><li>x</li></ul></body></html>`,
  'inside a comment and a declaration': `<!DOCTYPE html SYSTEM "file://${SECRET}"><?xml-stylesheet href="${SECRET}"?><html><!--[if gte mso 9]><body background="${SECRET}"><![endif]--><body><p>hello</p></body></html>`,
  'a refresh': `<html><head><meta http-equiv="refresh" content="0;url=file://${SECRET}"></head><body>x</body></html>`,
  'an attribute nobody listed': `<html><body><div madeup="file://${SECRET}" other="${SECRET}" third="../../..${SECRET}">x</div></body></html>`,
  'a tag that never closes': `<html><body><p>hello</p><body background="${SECRET}"`,
  'a link to a file on the disk': `<html><body><a href="file://${SECRET}">open</a></body></html>`,
};
// Taken out without a note: what sat there was never content of the page.
const QUIET = new Set(['inside a comment and a declaration', 'a refresh']);

test('a web page is converted without anything it names outside itself, however it is spelled', () => {
  for (const [name, page] of Object.entries(HTML_ATTACKS)) {
    const r = safeHtml(page);
    assert.ok(!/srv|secret|photo|10\.0\.0\.1|pictures\.example/i.test(r.html.replace(/&#?\w+;/g, '')), `${name}: ${r.html}`);
    assert.ok(!/url\s*\(|@import|background\s*=|src\s*=|<link|<base|<iframe|<object|<embed|<frame|http-equiv/i.test(r.html), `${name}: ${r.html}`);
    // What sat in a comment or a declaration was never going to be loaded, so it goes without a note.
    assert.equal(r.removed > 0, !QUIET.has(name), `${name}: counted, so the sender is told`);
  }
  // What a page carries inside itself stays, and so do its words, its links to click and its plain styles.
  const inline = `data:image/png;base64,${picture(3, 2).toString('base64')}`;
  const good = `<!doctype html><html><head><meta charset="utf-8"><title>Lease</title><style>p{color:red;background:url(${inline})}</style></head><body bgcolor="#ffffff"><h1 align="center">Lease &amp; rent</h1><p style="font-weight:bold">Gr\u00fc\u00dfe, 5 < 7</p><img src="${inline}" alt="a tree" width="3"><a href="https://example.com/a?b=1&amp;c=2">terms</a><a href="mailto:ada@example.com">write</a><table border="1"><tr><td colspan="2">x</td></tr></table></body></html>`;
  const kept = safeHtml(good);
  assert.equal(kept.removed, 0, kept.html);
  for (const part of ['<!DOCTYPE html>', '<meta charset="utf-8">', `background:url(${inline})`, '<body bgcolor="#ffffff">', '<h1 align="center">Lease &amp; rent</h1>', 'Gr\u00fc\u00dfe, 5 &lt; 7', `<img src="${inline}" alt="a tree" width="3">`, '<a href="https://example.com/a?b=1&amp;c=2">terms</a>', '<a href="mailto:ada@example.com">write</a>', '<td colspan="2">x</td>']) assert.ok(kept.html.includes(part), `${part} in ${kept.html}`);
  // A script goes without a note (it names nothing outside), and so does an encoding in which "<" has other spellings.
  const quiet = safeHtml('<html><head><meta charset="utf-7"><script>alert(1)</script></head><body onload="x()"><p onclick="y()">hello</p></body></html>');
  assert.equal(quiet.html, '<html><head></head><body><p>hello</p></body></html>');
  assert.equal(quiet.removed, 0);
});

const hasBox = spawnSync('unshare', ['-rnmpf', 'true']).status === 0;
test('the box a job runs in holds LibreOffice and the job folder, and nothing else of this machine', { skip: !hasBox && 'unshare -rnmpf does not work on this machine' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-convert-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-outside-'));
  try {
    fs.mkdirSync(path.join(dir, 'work'));
    fs.writeFileSync(path.join(dir, 'work', 'mine.txt'), 'the job file');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET ON DISK');
    const look = [
      `cat ${outside}/secret.txt 2>&1`, `ls ${ROOT} 2>&1`, 'ls /home /root /tmp /var/log /etc/passwd /etc/shadow 2>&1', `ls ${process.env.DATA_DIR} 2>&1`,
      'echo "work: $(cat /work/mine.txt)"', 'echo made > /work/out.txt', 'echo "pids: $(ls /proc | grep -c "^[0-9]")"', 'echo "nets: $(ls /sys/class/net 2>/dev/null | tr "\\n" " ")$(cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d " " | tr "\\n" " ")"',
      'touch /usr/x 2>&1 || echo "usr is read-only"', 'echo "old root: $(ls -a / | grep -c "^\\.old$") $(grep -c "/\\.old" /proc/self/mountinfo)"', 'echo "root: $(ls / | tr "\\n" " ")"',
    ].join('; ');
    const c = boxed('box', { unshare: 'unshare', dir, memKb: 1024 * 1024, program: 'sh', args: ['-c', look] });
    const r = spawnSync(c.cmd, c.args, { encoding: 'utf8', cwd: path.join(dir, 'work'), env: { PATH: process.env.PATH } as any });
    const said = r.stdout + r.stderr;
    assert.equal(r.status, 0, said);
    assert.ok(!said.includes('SECRET ON DISK'), said);
    assert.ok(!/package\.json|README\.md|node_modules/.test(said), `the app is not there: ${said}`);
    assert.ok(!/sg-outside|\.sqlite|blobs/.test(said.split('\n').filter((l) => !/No such file or directory$/.test(l)).join('\n')), said);
    assert.match(said, /work: the job file/);
    assert.match(said, /nets: lo $/m, 'only the loopback');
    assert.match(said, /usr is read-only/);
    // The machine's own root was let go (pivot_root, then unmounted), so breaking out of the new root leads nowhere.
    assert.match(said, /old root: 0 0/);
    assert.match(read('src/server/convert-box.ts'), /pivot_root \. \.old\nexec chroot \. sh -c 'umount -l \/\.old && rmdir \/\.old/);
    assert.match(said, /root: (bin )?dev etc (lib\w* )*proc (sbin )?tmp usr (var )?work $/m, said);
    assert.ok(Number(/pids: (\d+)/.exec(said)![1]) < 8, 'it sees its own processes only');
    assert.equal(fs.readFileSync(path.join(dir, 'work', 'out.txt'), 'utf8'), 'made\n', 'what it writes in /work is the job folder');
    // Nothing of the box is left on this machine once the job is over.
    assert.deepEqual(fs.readdirSync(path.join(dir, 'root')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the real LibreOffice: a page cannot pull a picture from the disk into the PDF, boxed or not, and a tiny file cannot take the memory', { skip: !hasSoffice && 'LibreOffice is not installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-outside-'));
  const pic = path.join(dir, 'secret.png');
  fs.writeFileSync(pic, picture());
  fs.chmodSync(dir, 0o755);
  const inline = `data:image/png;base64,${picture().toString('base64')}`;
  const pages = [`<html><body background="${pic}"><p>hello</p></body></html>`, `<html><head><style>body{background:url(file://${pic})}</style></head><body background="file://${pic}"><p>hello</p><img src="${pic}"></body></html>`];
  try {
    // First with every wall this machine allows, then with none of them: the page is cleaned either way.
    for (const walls of [true, false]) {
      set({ CONVERTER: 'soffice', CONVERT_TIMEOUT_MS: '120000' });
      convertTesting.unshare = walls ? 'unshare' : '';
      convertTesting.forget();
      assert.equal(await sofficeLevel(), walls ? (hasBox ? 'box' : (await sofficeLevel())) : 'open');
      const c = await person();
      for (const page of pages) {
        const r = await put(c, utf8(page), 'Page.html');
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.deepEqual(r.data.converted.notes, ['external'], 'the sender is told something is missing');
        const pdf = new Uint8Array((await c.get(`/files/${r.data.id}/content`)).data);
        assert.deepEqual(await picturesIn(pdf), [], `walls ${walls}: ${page}`);
        assert.match((await extractPages(pdf)).join(' '), /hello/);
      }
      // The test can see a picture when there is one: the same picture carried inside the page is in the PDF.
      const own = await put(c, utf8(`<html><body><p>hello</p><img src="${inline}"></body></html>`), 'Own.html');
      assert.deepEqual(own.data.converted.notes, []);
      assert.deepEqual(await picturesIn(new Uint8Array((await c.get(`/files/${own.data.id}/content`)).data)), ['137x91']);
    }
    // A sheet of a thousand million cells in a file of 1 KB: nothing to unpack, so only the memory limit stops it,
    // long before the timeout, and the person is told in words.
    set({ CONVERTER: 'soffice', CONVERT_TIMEOUT_MS: '120000' });
    convertTesting.unshare = 'unshare';
    convertTesting.forget();
    assert.equal(convertMemoryMb(), 1024);
    const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"';
    const huge = odf('application/vnd.oasis.opendocument.spreadsheet', `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.2"><office:body><office:spreadsheet><table:table table:name="A"><table:table-row table:number-rows-repeated="1000000"><table:table-cell table:number-columns-repeated="1000" office:value-type="string"><text:p>x</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`);
    assert.ok(huge.length < 2000);
    const c = await person();
    let peak = 0;
    const watch = setInterval(() => {
      const rss = spawnSync('ps', ['-eo', 'rss,comm'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /soffice/.test(l)).reduce((n, l) => n + Number(l.trim().split(/\s+/)[0] || 0), 0);
      peak = Math.max(peak, rss);
    }, 250);
    const t = Date.now();
    const r = await put(c, huge, 'Huge.ods');
    clearInterval(watch);
    assert.equal(r.status, 422, JSON.stringify(r.data));
    assert.equal(r.data.code, 'convert_failed');
    assert.match(r.data.error, /far larger inside than it looks/);
    assert.ok(Date.now() - t < 60_000, `stopped by memory, not by the clock: ${Date.now() - t} ms`);
    assert.ok(peak < 1100 * 1024, `never more than the limit: ${Math.round(peak / 1024)} MB`);
    // An ordinary file still converts under the same limit.
    assert.equal((await put(c, docx(), 'After.docx')).status, 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a text file with no words is refused, and other files that name outside content are noted', async () => {
  set({ CONVERTER: 'stub' });
  const c = await person();
  const blank = await put(c, utf8('   \n\n\t\n'), 'blank.txt');
  assert.equal(blank.status, 400);
  assert.match(blank.data.error, /^This text file has no words in it, only spaces or empty lines\./);
  assert.match(blank.data.error, /Nothing was saved\.$/);
  assert.equal((await put(c, utf8('One word\n'), 'one.txt')).data.is_scan, false);
  // A bare path counts as outside content too, in an OpenDocument text and in an RTF field.
  const NS = 'xmlns:office="o" xmlns:draw="d" xmlns:xlink="x"';
  const odt = (href: string) => odf('application/vnd.oasis.opendocument.text', `<office:document-content ${NS}><office:body><draw:image xlink:href="${href}"/></office:body></office:document-content>`);
  assert.deepEqual((await put(c, odt('/srv/secret/photo.png'), 'a.odt')).data.converted.notes, ['external']);
  assert.deepEqual((await put(c, odt('../../secret.png'), 'b.odt')).data.converted.notes, ['external']);
  assert.deepEqual((await put(c, odt('Pictures/own.png'), 'c.odt')).data.converted.notes, [], 'a picture inside the file is not outside content');
  assert.deepEqual((await put(c, utf8('{\\rtf1\\ansi hello {\\field{\\*\\fldinst INCLUDEPICTURE "C:\\\\\\\\secret.png" \\\\d}{\\fldrslt old}}}'), 'd.rtf')).data.converted.notes, ['external']);
  for (const [name, page] of Object.entries(HTML_ATTACKS)) assert.deepEqual((await detect(utf8(page)) as any).notes, QUIET.has(name) ? [] : ['external'], name);
});

test('the original can be downloaded again by the account that uploaded it, from a draft too, and by nobody else', async () => {
  set({ CONVERTER: 'stub' });
  const c = await person(), other = await person();
  const bytes = docx(para('The original words'));
  const up = (await put(c, bytes, 'Con"tract\n.docx')).data;
  const got = await c.get(`/files/${up.id}/original`);
  assert.equal(got.status, 200);
  assert.deepEqual(new Uint8Array(got.data), bytes, 'byte for byte what was uploaded');
  const { handle } = await import('../src/server/router.ts');
  const r = await handle(new Request(`http://test.local/api/files/${up.id}/original`, { headers: { cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': c.ip } }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-disposition')!, /^attachment; filename="Con_tract .docx"$/);
  assert.equal((await other.get(`/files/${up.id}/original`)).status, 404);
  assert.equal((await new Client().get(`/files/${up.id}/original`)).status, 401);
  const plain = (await put(c, await samplePdf(1), 'Ready.pdf')).data;
  const none = await c.get(`/files/${plain.id}/original`);
  assert.equal(none.status, 404);
  assert.equal(none.data.code, 'no_original');
  assert.match(none.data.error, /^This file was uploaded as a PDF or a picture, so there is no other original\./);
  // The editor offers it under More, next to the file, only for a file that has one; the API description has it.
  assert.match(read('src/components/editor/FileRow.tsx'), /\{d\.converted\?\.from && <a className="btn sm" data-feature="ds-convert" href=\{`\/api\/files\/\$\{d\.file_id\}\/original`\} download>Download \{d\.converted\.from\}<\/a>\}/);
  assert.ok((await c.get('/openapi.json')).data.paths['/files/{id}/original'].get);
});

test('the help page answers "Can I add a Word file?" for this server, and the docs say what the code does', () => {
  set({});
  assert.equal(converterConfigured(), false);
  set({ CONVERTER: 'soffice' });
  assert.equal(converterConfigured(), true);
  set({ CONVERTER_URL: 'http://gotenberg:3000' });
  assert.equal(converterConfigured(), true);
  set({ CONVERTER_URL: 'nonsense' });
  assert.equal(converterConfigured(), false);
  assert.match(read('src/app/help/page.tsx'), /<WordFilesHelp \/>/);
  const help = read('src/app/help/convert.tsx');
  assert.match(help, /Save it as a PDF first/);
  assert.ok(!/LibreOffice|Gotenberg|\u2014/.test(help));
  const readme = read('README.md');
  assert.match(readme, /CONVERT_MEMORY_MB/);
  assert.match(readme, /unshare -rnmpf/);
  assert.ok(!/a few hundred MB of memory per job/.test(readme), 'the README no longer gives a memory figure the code does not keep');
  assert.ok(!/macros[^.|]*never run|They were not run/i.test(readme + read('src/lib/convert.ts')), 'no promise that a macro cannot run');
  assert.ok(!/\u2014/.test(read('src/server/convert-html.ts') + read('src/server/convert-box.ts') + read('src/server/routes-convert.ts')));
});
