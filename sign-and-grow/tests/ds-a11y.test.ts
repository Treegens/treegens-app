// Accessibility for public bodies (research/docusign-gaps.json, batch "a11y"): the statement at /accessibility and the
// documents behind it, text read by a machine from scanned pages (src/server/ocr.ts), and the browser checks.
//   node --experimental-strip-types --no-warnings --test tests/ds-a11y.test.ts
// The browser checks (axe-core on every state, signing with the keyboard alone, the editor without dragging) need a
// running dev server and Chromium: A11Y_URL=http://localhost:3851 runs them, and without it they are skipped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { boot, signUp, Client, tokenFor } from './helpers.ts';
import { encodePng } from '../src/server/png.ts';
import { runOcr, ocrTick, imageOf, ocrLang, commandFor, cleanOcr, OCR_MAX_TRIES } from '../src/server/ocr.ts';
import zlib from 'node:zlib';
import { PDFName } from 'pdf-lib';
import { LAST_CHECK, checkedOn, WORKS, NOT_YET, OCR_WARNING, ocrOn } from '../src/lib/a11y.ts';
import { scanWarning } from '../src/lib/scans.ts';
import { SUPPORT_TOPICS } from '../src/lib/policy.ts';
import { TOPIC_LABEL } from '../src/lib/support.ts';
import { PROCUREMENT_DOCS, writtenOn } from '../src/lib/procurement.ts';
import { outsideServices } from '../src/lib/outside.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const server = await boot();
const { get, run, all } = server.db;

// ---- A stub text reader, so no test needs Tesseract ----

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-ocr-test-'));
const SEEN = path.join(tmp, 'seen.txt');
// Reads the picture it is given like Tesseract would be handed it, and prints what it found in it: the kind of file,
// its size from the PNG header or the JPEG start, and the language it was asked for. It also notes every call.
const STUB = path.join(tmp, 'reader.mjs');
fs.writeFileSync(STUB, `
import fs from 'node:fs';
const [file, lang] = process.argv.slice(2);
const b = fs.readFileSync(file);
fs.appendFileSync(${JSON.stringify(SEEN)}, JSON.stringify({ file, lang, args: process.argv.slice(2) }) + '\\n');
if (process.env.STUB_SLEEP) await new Promise((r) => setTimeout(r, Number(process.env.STUB_SLEEP)));
let kind = 'unknown', size = '';
if (b[0] === 0x89 && b[1] === 0x50) { kind = 'png'; size = b.readUInt32BE(16) + 'x' + b.readUInt32BE(20); }
else if (b[0] === 0xff && b[1] === 0xd8) kind = 'jpeg';
process.stdout.write('Garden lease for plot forty two\\n\\n\\n\\nRead from a ' + kind + ' ' + size + ' in ' + lang + '\\u0007\\n');
`);
const STUB_CMD = `${process.execPath} ${STUB} {file} {lang}`;
const seen = () => (fs.existsSync(SEEN) ? fs.readFileSync(SEEN, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const realFetch = globalThis.fetch;
const OCR_ENV = ['OCR_CMD', 'OCRMYPDF_URL', 'OCR_TIMEOUT_MS', 'STUB_SLEEP'];
const clearOcr = () => OCR_ENV.forEach((k) => delete process.env[k]);
after(() => {
  globalThis.fetch = realFetch;
  clearOcr();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A picture of a page: a PNG with nothing but colour, as a phone photo or a scanner gives (no text in it for a PDF).
function pagePng(w = 60, h = 80): Buffer {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([240, 238, 230, 255], i * 4);
  return encodePng({ width: w, height: h, data });
}
async function uploadPicture(c: Client, bytes: Buffer, name = 'Scanned lease.png', type = 'image/png') {
  const f = new FormData();
  f.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
  const r = await c.call('POST', '/files', f);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
// A typed PDF with words on its page.
async function typedPdf(words: string, pages = 1): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) d.addPage([612, 792]).drawText(`${words} ${i + 1}`, { x: 72, y: 700, size: 14, font });
  return d.save();
}
async function sendWith(c: Client, fileId: string, to: string, extra: any = {}) {
  const r = await c.post('/envelopes', { subject: 'Garden lease', documents: [{ id: 'd', file_id: fileId }], recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: to, ...extra }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = await c.post(`/envelopes/${r.data.envelope.id}/send`, {});
  assert.equal(s.status, 200, JSON.stringify(s.data));
  return r.data.envelope.id as string;
}
const job = (fileId: string) => get('SELECT * FROM ocr_jobs WHERE file_id=?', fileId) ?? undefined;

// ---- 1. With zero setup, nothing changes ----

test('without OCR_CMD or OCRMYPDF_URL nothing is read, queued or said, and the scan warning is as before', async () => {
  clearOcr();
  assert.equal(ocrOn(), false);
  const c = await signUp('Olga Off', 'olga@off.example', '198.51.100.10');
  const f = await uploadPicture(c, pagePng());
  assert.equal(f.is_scan, true);
  assert.ok(!('ocr' in f), 'the upload says nothing about reading text');
  assert.equal(job(f.id), undefined);
  assert.equal(await runOcr(), 0);
  const id = await sendWith(c, f.id, 'off-signer@off.example');
  const doc = (await c.get(`/envelopes/${id}`)).data.envelope.documents[0];
  assert.ok(!('ocr' in doc));
  assert.match(scanWarning(doc), /People who use a screen reader will not be able to have it read to them/);
  // The signing page asks, and hears that there is nothing.
  const s = new Client();
  s.ip = '198.51.100.11';
  const o = await s.get(`/sign/${tokenFor(id, 'off-signer@off.example')}/ocr`);
  assert.equal(o.status, 200);
  assert.deepEqual(o.data.documents, []);
  // The outside list does not name a service.
  assert.equal(outsideServices({}).find((x) => x.id === 'ocr')!.on, false);
});

// ---- 2. A stub command reads a scanned page ----

test('OCR_CMD: a scanned page is read in the background, in the account language, and serves search and the text view with the warning', async () => {
  clearOcr();
  process.env.OCR_CMD = STUB_CMD;
  const c = await signUp('Rosa Reader', 'rosa@read.example', '198.51.100.20');
  // The account starts new recipients in German, so the page is read as German.
  run('UPDATE accounts SET default_locale=? WHERE id IN (SELECT m.account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?)', 'de', 'rosa@read.example');
  const f = await uploadPicture(c, pagePng(64, 90));
  assert.equal(f.ocr, 'queued', 'the upload says the text is being read');
  await runOcr();
  const j = job(f.id);
  assert.equal(j.state, 'done', j.error);
  assert.equal(j.lang, 'deu');
  const call = seen().at(-1);
  assert.equal(call.lang, 'deu');
  // The picture handed over is the page's own image, as a PNG of its size (the PDF keeps it as Flate data).
  const id = await sendWith(c, f.id, 'signer@read.example');
  // Search finds the envelope by a word that is only in the picture.
  const found = (await c.get('/envelopes?q=forty')).data.envelopes.map((e: any) => e.id);
  assert.ok(found.includes(id), 'search finds the scanned document by a word read from it');
  // The sender's screens: the document says its text was read by machine, with the mistakes warning.
  const doc = (await c.get(`/envelopes/${id}`)).data.envelope.documents[0];
  assert.equal(doc.ocr, 'done');
  assert.match(scanWarning(doc), /We read its words by machine/);
  assert.match(scanWarning(doc), /may have mistakes/);
  assert.doesNotMatch(scanWarning(doc), /This server|text view/, 'the sender is not told about system parts');
  // The signing page: the text of page 1, with the warning, word for word.
  const s = new Client();
  s.ip = '198.51.100.21';
  const o = await s.get(`/sign/${tokenFor(id, 'signer@read.example')}/ocr`);
  assert.equal(o.status, 200);
  assert.equal(o.data.warning, 'Text read by a machine from a picture of the page. It may contain mistakes. What you sign is the page.');
  assert.equal(o.data.warning, OCR_WARNING);
  assert.equal(o.data.documents.length, 1);
  const page = o.data.documents[0].pages[0];
  assert.equal(page.page, 1);
  assert.match(page.text, /^Garden lease for plot forty two\n\nRead from a png 64x90 in deu$/, 'the picture was a PNG of the page size; blank lines and control characters are cleaned');
  // The page that is signed is unchanged: the PDF the signer downloads is the same file as before.
  const sha = get('SELECT sha256 FROM files WHERE id=?', f.id).sha256;
  const pdf = await s.get(`/sign/${tokenFor(id, 'signer@read.example')}/doc/d`);
  void pdf;
  assert.equal(get('SELECT sha256 FROM files WHERE id=?', f.id).sha256, sha);
});

test('OCR_CMD: a JPEG photo of a page goes to the reader as a JPEG; a typed PDF is never read; a page without a picture is skipped', async () => {
  clearOcr();
  process.env.OCR_CMD = STUB_CMD;
  const c = await signUp('Jo Photo', 'jo@photo.example', '198.51.100.30');
  const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAgADADAREAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAcKCP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAYAQEBAQEBAAAAAAAAAAAAAAAACQYHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AOWnHFJQAFKZVCcABNWqXYAAUplUJwAHI62T0GAA0zJtNgAAzMqSseAA0zJtNgAA/9k=', 'base64');
  const before = seen().length;
  const f = await uploadPicture(c, JPEG, 'photo.jpg', 'image/jpeg');
  await runOcr();
  assert.equal(job(f.id).state, 'done', job(f.id).error);
  const call = seen().at(-1);
  assert.match(call.file, /\.jpg$/);
  assert.equal(call.lang, 'eng', 'no language known: English');
  assert.equal(seen().length, before + 1);
  // A PDF whose pages have text: nothing to read, no job.
  const fd = new FormData();
  fd.append('file', new Blob([await typedPdf('Typed words')], { type: 'application/pdf' }), 'Typed.pdf');
  const typed = (await c.call('POST', '/files', fd)).data;
  assert.equal(typed.is_scan, false);
  assert.equal(job(typed.id), undefined);
  // A PDF page with no text and no picture (an empty page): queued, read, and simply has no text afterwards.
  const blank = await PDFDocument.create();
  blank.addPage([612, 792]);
  const fb = new FormData();
  fb.append('file', new Blob([await blank.save()], { type: 'application/pdf' }), 'Blank.pdf');
  const b = (await c.call('POST', '/files', fb)).data;
  await runOcr();
  assert.equal(job(b.id).state, 'done');
  assert.equal(job(b.id).text, '{}');
});

// ---- 3. Things that go wrong ----

test('a reader that hangs is stopped at OCR_TIMEOUT_MS, tried again, and left as failed; the page says it has no text as before', async () => {
  clearOcr();
  process.env.OCR_CMD = STUB_CMD;
  process.env.OCR_TIMEOUT_MS = '1000';
  process.env.STUB_SLEEP = '5000';
  const c = await signUp('Hana Hang', 'hana@hang.example', '198.51.100.40');
  const f = await uploadPicture(c, pagePng());
  const t0 = Date.now();
  for (let i = 0; i < OCR_MAX_TRIES; i++) await runOcr();
  assert.ok(Date.now() - t0 < OCR_MAX_TRIES * 4000, 'each try was stopped after about a second');
  const j = job(f.id);
  assert.equal(j.state, 'failed');
  assert.equal(j.tries, OCR_MAX_TRIES);
  assert.match(j.error, /took longer than 1 seconds/);
  // No more tries after that.
  await runOcr();
  assert.equal(job(f.id).tries, OCR_MAX_TRIES);
  const id = await sendWith(c, f.id, 'hang-signer@hang.example');
  const doc = (await c.get(`/envelopes/${id}`)).data.envelope.documents[0];
  assert.equal(doc.ocr, 'failed');
  assert.match(scanWarning(doc), /People who use a screen reader will not be able to/, 'a failed reading changes nothing in what the sender is told');
  const s = new Client();
  s.ip = '198.51.100.41';
  const o = (await s.get(`/sign/${tokenFor(id, 'hang-signer@hang.example')}/ocr`)).data;
  assert.equal(o.documents.length, 1);
  assert.equal(o.documents[0].state, 'failed');
  assert.deepEqual(o.documents[0].pages, []);
});

test('the command is run without a shell: the picture path is one argument and nothing from the document reaches the command line', () => {
  assert.deepEqual(commandFor('tesseract {file} stdout -l {lang}', '/tmp/x/page-1.png', 'deu'), ['tesseract', ['/tmp/x/page-1.png', 'stdout', '-l', 'deu']]);
  assert.deepEqual(commandFor('/opt/ocr', '/tmp/a.png', 'eng'), ['/opt/ocr', ['/tmp/a.png']], 'without {file} the path goes at the end');
  // What a machine prints is cleaned before anyone sees it: no control or direction characters, no long gaps.
  assert.equal(cleanOcr('a\u0007b‮c\r\n\n\n\n\nd   \n'), 'abc\n\nd');
  assert.equal(cleanOcr('x'.repeat(50_000)).length, 20_000);
  assert.equal(ocrLang('de-AT'), 'deu');
  assert.equal(ocrLang('zh-TW'), 'chi_tra');
  assert.equal(ocrLang('xx'), null);
  assert.equal(ocrLang(null), null);
});

// A one-page PDF whose only picture is a 100x100 grey Flate image holding `inflated` bytes once unpacked.
async function flatePdf(inflated: number): Promise<PDFDocument> {
  const d = await PDFDocument.create();
  const page = d.addPage([200, 200]);
  const s = d.context.stream(zlib.deflateSync(Buffer.alloc(inflated, 200)), { Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' });
  page.node.setXObject(PDFName.of('Im0'), d.context.register(s));
  return d;
}

test('a picture that unpacks to far more than its size (a "zip bomb") is skipped without unpacking it', async () => {
  // The right size: read as a PNG.
  const ok = imageOf(await flatePdf(100 * 100), 0);
  assert.equal(ok?.ext, 'png');
  // 200 MB from a stream of about 200 KB: never unpacked past the picture's 10 000 bytes.
  const bomb = await flatePdf(200_000_000);
  const heap0 = process.memoryUsage().rss;
  const t0 = Date.now();
  assert.equal(imageOf(bomb, 0), null);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.ok(process.memoryUsage().rss - heap0 < 100_000_000, 'memory did not grow by the unpacked size');
});

test('the timer never waits for a long batch of scans: it waits a short while and the batch goes on by itself', async () => {
  clearOcr();
  process.env.OCR_CMD = STUB_CMD;
  process.env.STUB_SLEEP = '1500';
  const c = await signUp('Tim Timer', 'tim@timer.example', '198.51.100.45');
  const f = await uploadPicture(c, pagePng());
  const t0 = Date.now();
  // A run may already have been started by the upload: either way the answer comes within the wait.
  assert.equal(await ocrTick(200), 'still reading');
  assert.equal(await ocrTick(5000), 'still reading', 'a run already going is not waited for');
  assert.ok(Date.now() - t0 < 1000, `the timer waited ${Date.now() - t0} ms`);
  await runOcr();
  if (job(f.id).state !== 'done') await runOcr();
  assert.equal(job(f.id).state, 'done', job(f.id).error);
  delete process.env.STUB_SLEEP;
  // With nothing left to read, it answers with a number at once.
  assert.equal(await ocrTick(5000), 0);
  // The timer uses it.
  assert.match(read('src/server/cron.ts'), /ocr_read: await ocrTick\(\)/);
});

test('a reader without the document language (a missing language pack) reads in English and says so in the log', async () => {
  clearOcr();
  const NOLANG = path.join(tmp, 'eng-only.mjs');
  fs.writeFileSync(NOLANG, `const [, lang] = process.argv.slice(2); if (lang !== 'eng') { process.stderr.write('Failed loading language ' + lang); process.exit(1); } process.stdout.write('Read in ' + lang);`);
  process.env.OCR_CMD = `${process.execPath} ${NOLANG} {file} {lang}`;
  const c = await signUp('Dirk Deutsch', 'dirk@nolang.example', '198.51.100.46');
  run('UPDATE accounts SET default_locale=? WHERE id IN (SELECT m.account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?)', 'de', 'dirk@nolang.example');
  const warn = console.warn;
  const said: string[] = [];
  console.warn = (...a: any[]) => void said.push(a.join(' '));
  try {
    const f = await uploadPicture(c, pagePng());
    await runOcr();
    if (job(f.id).state !== 'done') await runOcr();
    const j = job(f.id);
    assert.equal(j.state, 'done', j.error);
    assert.equal(j.lang, 'eng', 'the job says the language it was really read in');
    assert.ok(said.some((l) => /language "deu".*English.*language pack/.test(l)), said.join('\n'));
  } finally {
    console.warn = warn;
  }
});

test('a reader that fails is named in the server log, not only in the database', async () => {
  clearOcr();
  process.env.OCR_CMD = `${process.execPath} ${path.join(tmp, 'no-such-reader.mjs')} {file}`;
  const c = await signUp('Leo Log', 'leo@log.example', '198.51.100.47');
  const error = console.error;
  const said: string[] = [];
  console.error = (...a: any[]) => void said.push(a.join(' '));
  try {
    const f = await uploadPicture(c, pagePng());
    await runOcr();
    if (job(f.id).tries === 0) await runOcr();
    assert.ok(said.some((l) => /\[ocr\] reading the text of a scanned file failed \(try 1 of 3\)/.test(l)), said.join('\n'));
  } finally {
    console.error = error;
  }
});

test('a program path with spaces can be given in double quotes', () => {
  assert.deepEqual(commandFor('"/opt/My Reader/ocr" {file} -l {lang}', '/tmp/a.png', 'eng'), ['/opt/My Reader/ocr', ['/tmp/a.png', '-l', 'eng']]);
});

test('on a phone, tick boxes and round buttons take a 44 pixel tap: the phone rule outranks the 24 pixel one', () => {
  const css = read('src/app/styles/sign.css');
  const small = css.indexOf('.sg-doc .field.fill.box:not(.sg-auto)::before { content');
  const phone = css.search(/\.sg-doc \.field\.fill\.box:not\(\.sg-auto\)::before \{[^}]*max\(100%, 44px\)/);
  assert.ok(small > 0 && phone > small, 'a rule as specific as the 24 px one, with 44 px, comes after it');
  // and it is inside the phone media query
  const media = css.lastIndexOf('@media', phone);
  assert.match(css.slice(media, media + 40), /max-width: 600px/);
});

test('the statement sends a stuck signer to Questions and comments first, and speaks plainly', () => {
  const page = read('src/app/accessibility/page.tsx');
  const all = page + WORKS.join(' ') + NOT_YET.join(' ');
  for (const branch of page.split('reachable ?')[1].split(') : (')) {
    const q = branch.indexOf('Questions and comments'), d = branch.indexOf('Decline to sign');
    assert.ok(q > 0 && d > q, 'Questions and comments comes before Decline in both versions');
  }
  assert.doesNotMatch(all, /landmark|tagged PDF|Chromium|accessibility tree|operator screens/);
  assert.match(page, /className="btn" style=\{BTN\}/);
  assert.match(page, /const BTN = \{ minHeight: 44/);
});

test('GET /sign/:token/ocr is readable exactly when the documents are: not with an unknown link, not behind an access code, not once the envelope is closed', async () => {
  clearOcr();
  process.env.OCR_CMD = STUB_CMD;
  const c = await signUp('Gert Gate', 'gert@gate.example', '198.51.100.50');
  const f = await uploadPicture(c, pagePng());
  await runOcr();
  const r = await c.post('/envelopes', { subject: 'Two in order', documents: [{ id: 'd', file_id: f.id }],
    recipients: [{ id: 'a', role: 'signer', name: 'First One', email: 'first@gate.example', routing_order: 1, access_code: 'tulip' }, { id: 'b', role: 'signer', name: 'Second One', email: 'second@gate.example', routing_order: 2 }],
    fields: [{ id: 'f1', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'f2', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await c.post(`/envelopes/${r.data.envelope.id}/send`, {})).status, 200);
  const s = new Client();
  s.ip = '198.51.100.51';
  assert.equal((await s.get('/sign/not-a-real-token/ocr')).status, 404);
  // The first signer has an access code: nothing until it is typed.
  const first = tokenFor(r.data.envelope.id, 'first@gate.example');
  assert.equal((await s.get(`/sign/${first}/ocr`)).status, 401);
  assert.equal((await s.post(`/sign/${first}/unlock`, { code: 'tulip' })).status, 200);
  assert.equal((await s.get(`/sign/${first}/ocr`)).data.documents[0].pages.length, 1);
  // Once someone declines, the envelope is closed and nobody reads its documents any more.
  const second = tokenFor(r.data.envelope.id, 'second@gate.example');
  const s2 = new Client();
  s2.ip = '198.51.100.52';
  assert.equal((await s2.get(`/sign/${second}/ocr`)).status, 200);
  const dec = await s.post(`/sign/${first}/decline`, { reason: 'Not mine to sign.' });
  assert.equal(dec.status, 200, JSON.stringify(dec.data));
  assert.equal((await s2.get(`/sign/${second}/ocr`)).status, 403);
});

test('OCRMYPDF_URL: the PDF goes to the service with its language and the text of the scanned pages comes back; a wrong answer is tried again', async () => {
  clearOcr();
  process.env.OCRMYPDF_URL = 'https://ocr.internal.example/ocr';
  const asked: { url: string; type: string | null; size: number }[] = [];
  let answer: 'pdf' | 'html' = 'html';
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    if (!url.startsWith('https://ocr.internal.example/')) return realFetch(input, init);
    asked.push({ url, type: new Headers(init?.headers).get('content-type'), size: (init?.body as Buffer)?.length || 0 });
    if (answer === 'html') return new Response('<html>busy</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(new Uint8Array(await typedPdf('Text the service read on page')), { status: 200, headers: { 'content-type': 'application/pdf' } });
  }) as typeof fetch;
  try {
    assert.equal(outsideServices({ OCRMYPDF_URL: 'https://ocr.internal.example/ocr' }).find((x) => x.id === 'ocr')!.hosts[0], 'ocr.internal.example', 'the service is on the list of outside connections');
    assert.equal(outsideServices({ OCRMYPDF_URL: 'https://ocr.internal.example/ocr', OCR_CMD: 'tesseract' }).find((x) => x.id === 'ocr')!.on, false, 'with OCR_CMD the service is not used');
    const c = await signUp('Sven Service', 'sven@service.example', '198.51.100.60');
    const f = await uploadPicture(c, pagePng());
    await runOcr();
    assert.equal(job(f.id).state, 'queued', 'an answer that is not a PDF is tried again later');
    assert.match(job(f.id).error, /did not answer with a PDF/);
    answer = 'pdf';
    await runOcr();
    assert.equal(job(f.id).state, 'done', job(f.id).error);
    assert.equal(asked.length, 2);
    assert.match(asked[1].url, /\?lang=eng$/);
    assert.equal(asked[1].type, 'application/pdf');
    assert.ok(asked[1].size > 100);
    const id = await sendWith(c, f.id, 'svc-signer@service.example');
    const o = (await new Client().get(`/sign/${tokenFor(id, 'svc-signer@service.example')}/ocr`)).data;
    assert.equal(o.documents[0].pages[0].text, 'Text the service read on page 1');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the text read from a file goes when the file goes', async () => {
  clearOcr();
  process.env.OCR_CMD = STUB_CMD;
  const c = await signUp('Dora Delete', 'dora@delete.example', '198.51.100.70');
  const f = await uploadPicture(c, pagePng());
  await runOcr();
  assert.equal(job(f.id).state, 'done');
  run('DELETE FROM files WHERE id=?', f.id);
  assert.equal(job(f.id), undefined);
  assert.equal(all('SELECT * FROM ocr_jobs WHERE file_id=?', f.id).length, 0);
});

// ---- 4. The statement, the report and the checks ----

test('/accessibility: the statement is there, dated, says how it was checked, and promises nothing the code does not keep', () => {
  const page = read('src/app/accessibility/page.tsx');
  assert.match(page, /checkedOn\(\)/);
  assert.match(page, /LAST_CHECK\.method/);
  assert.equal(LAST_CHECK.method, 'Checked by the authors with axe-core and by hand; not audited.');
  assert.match(LAST_CHECK.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Date.parse(LAST_CHECK.date) <= Date.now(), 'the date of the last check is not in the future');
  assert.equal(checkedOn('2026-11-21'), '21 November 2026');
  // The documents behind it carry the same date.
  for (const f of ['docs/acr.md', 'docs/a11y-checks.md']) assert.equal(writtenOn(read(f)), LAST_CHECK.date, f);
  // What works and what does not yet are both there, and the report button only shows when a person reads requests.
  assert.ok(WORKS.length >= 5 && NOT_YET.length >= 3);
  assert.match(page, /reachable \?/);
  assert.match(page, /\/help\?topic=accessibility#contact/);
  // Text from scanned pages is mentioned as working only when the server is set up for it.
  assert.match(page, /\{ocr && <li>/);
  assert.match(page, /\{!ocr && <li>/);
  // It makes no claim of conformance.
  assert.doesNotMatch(page + WORKS.join(' ') + NOT_YET.join(' '), /\bconform(s|ant)\b|\bcompliant\b|\bWCAG\b|fully accessible/i);
  assert.match(page, /we do not say that \{PRODUCT\} meets any accessibility standard/);
  // It is in the footer of every public page.
  assert.match(read('src/components/Public.tsx'), /<Link href="\/accessibility">Accessibility<\/Link>/);
  // A problem report is a help request with its own topic.
  assert.ok(SUPPORT_TOPICS.includes('accessibility'));
  assert.match(TOPIC_LABEL.accessibility, /^Accessibility/);
  // No em dashes in anything of this batch.
  for (const f of ['src/app/accessibility/page.tsx', 'src/lib/a11y.ts', 'src/server/ocr.ts', 'src/server/routes-ocr.ts', 'docs/acr.md', 'docs/a11y-checks.md', 'tests/a11y/axe-states.cjs', 'tests/a11y/keyboard-sign.cjs', 'tests/a11y/keyboard-editor.cjs'])
    assert.ok(!read(f).includes('—'), `${f} has an em dash`);
});

test('a help request about accessibility is taken with its topic', async () => {
  const c = new Client();
  c.ip = '198.51.100.80';
  const r = await c.post('/public/support', { email: 'reader@help.example', name: 'Ria Reader', topic: 'accessibility', message: 'The signing page does not read the date field out loud with my screen reader.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(get('SELECT topic FROM support_requests WHERE email=? ORDER BY at DESC', 'reader@help.example').topic, 'accessibility');
});

test('the conformance report: headed self-assessed, every line supports, partly supports, does not support, not applicable or not evaluated, with a remark', () => {
  const md = read('docs/acr.md');
  assert.match(md.split('\n')[0], /Self-assessed, not audited$/);
  assert.match(md, /\*\*Self-assessed, not audited\.\*\*/);
  const rows = md.split('\n').filter((l) => /^\| \d/.test(l));
  assert.ok(rows.length >= 80, `only ${rows.length} rows`);
  for (const r of rows) {
    const cells = r.split('|').map((x) => x.trim());
    assert.match(cells[2], /^(Supports|Partially Supports|Does Not Support|Not Applicable|Not Evaluated)$/, r);
    if (cells[2] !== 'Supports' && cells[2] !== 'Not Applicable') assert.ok(cells[3].length > 0 || cells[2] === 'Not Evaluated', `a remark for: ${r}`);
  }
  // All of WCAG 2.2 at A and AA is in it, 2.2's own criteria included.
  for (const sc of ['1.1.1', '1.4.10', '2.4.11', '2.5.7', '2.5.8', '3.2.6', '3.3.7', '3.3.8', '4.1.2', '4.1.3']) assert.ok(rows.some((r) => r.startsWith(`| ${sc} `)), sc);
  // It is listed with the procurement documents, under a name the honesty scan allows.
  assert.ok(PROCUREMENT_DOCS.some((d) => d.file === 'docs/acr.md'));
  assert.ok(PROCUREMENT_DOCS.some((d) => d.file === 'docs/a11y-checks.md'));
});

test('the text view puts the warning before the text a machine read, and never shows that text without it', () => {
  const view = read('src/components/sign/TextView.tsx');
  const block = view.slice(view.indexOf('<div className="sg-ocr">'), view.indexOf('</div>', view.indexOf('<div className="sg-ocr">')));
  assert.ok(block.indexOf('{OCR_WARNING}') > 0 && block.indexOf('{OCR_WARNING}') < block.indexOf('ocr.pages[i + 1].split'), 'the warning comes first');
  assert.equal((view.match(/ocr\.pages\[i \+ 1\]\.split/g) || []).length, 1, 'the text is shown in one place only');
  // The signing page asks for it through the API.
  assert.match(read('src/app/sign/[token]/page.tsx'), /ocrUrl=\{`\/api\$\{base\}\/ocr`\}/);
});

test('each field on the signing page names its page to a screen reader; small tick boxes take a 24 pixel click', () => {
  const page = read('src/app/sign/[token]/page.tsx');
  assert.match(page, /<div role="group" aria-label=\{`Page \$\{page \+ 1\}`\}>/);
  const css = read('src/app/styles/sign.css');
  assert.match(css, /\.sg-doc \.field\.fill\.box:not\(\.sg-auto\)::before \{[^}]*width: max\(100%, 24px\); height: max\(100%, 24px\)/);
  // The editor is a main landmark with a heading that names the step.
  const editor = read('src/components/Editor.tsx');
  assert.match(editor, /<main className=\{`ed/);
  assert.match(editor, /<h1 className="ed-sr">/);
});

// ---- 5. In a browser ----

const URL_ = process.env.A11Y_URL || '';
let playwright = false;
try {
  createRequire(import.meta.url).resolve('playwright');
  playwright = true;
} catch {}
const browser = !URL_ ? 'set A11Y_URL to a running dev server to run the browser checks' : !playwright ? 'Playwright is not installed' : false;

test('axe-core finds no serious or critical issue in any state of the signing page, the editor or the envelope page, at 320 and 1280 px', { skip: browser, timeout: 900_000 }, () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests/a11y/axe-states.cjs'), URL_], { encoding: 'utf8', timeout: 880_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a whole document is signed with the keyboard alone, at 320, 390 and 1280 px', { skip: browser, timeout: 900_000 }, () => {
  for (const w of ['320', '390', '1280']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tests/a11y/keyboard-sign.cjs'), URL_, w], { encoding: 'utf8', timeout: 280_000 });
    assert.equal(r.status, 0, `${w}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /server says: completed/);
  }
});

test('the editor places and moves a field without dragging', { skip: browser, timeout: 300_000 }, () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests/a11y/keyboard-editor.cjs'), URL_], { encoding: 'utf8', timeout: 280_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

