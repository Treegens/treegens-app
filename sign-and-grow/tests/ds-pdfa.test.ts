// Archive format: completed files as PDF/A-2b (src/server/pdfa.ts, finalpipe.ts, routes-pdfa.ts). veraPDF is stood in
// for by tests/pdfa-fake-verapdf.mjs, which answers in veraPDF's own report format; the real veraPDF runs too when
// it is installed (VERAPDF_TEST_CMD, or "verapdf" on the PATH), and that test is skipped otherwise. Nothing reaches
// the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import fontkitMod from '@pdf-lib/fontkit';
import { boot, signUp, signAll, Client, type Server } from './helpers.ts';
import { makeCert, type Made } from './sealcerts.ts';

const fontkit: any = (fontkitMod as any).default || fontkitMod;
let s: Server;
let pdfa: typeof import('../src/server/pdfa.ts');
let seal: typeof import('../src/server/seal.ts');
let sealkey: typeof import('../src/server/sealkey.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfa-'));
const FAKE = path.resolve('tests/pdfa-fake-verapdf.mjs');
const LOG = path.join(dir, 'calls.log');
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : []);
const has = (bin: string, arg = '-v') => {
  try {
    execFileSync(bin, [arg], { stdio: 'ignore' });
    return true;
  } catch (e: any) {
    return e?.code !== 'ENOENT';
  }
};
const PDFTOTEXT = has('pdftotext');
const PDFSIG = has('pdfsig');
const REAL = process.env.VERAPDF_TEST_CMD || (has('verapdf', '--version') ? 'verapdf' : '');

function checker(mode: 'pass' | 'fail' | 'slow' | 'noversion' | null) {
  if (mode) process.env.VERAPDF_CMD = `node ${FAKE} ${mode} ${LOG}`;
  else delete process.env.VERAPDF_CMD;
  delete (globalThis as any).__sgpdfaversion;
}

// An uploaded document whose font is inside it (DejaVu), so nothing in it stands in the way of PDF/A.
async function embeddedPdf(text = 'Archive agreement') {
  const d = await PDFDocument.create();
  d.registerFontkit(fontkit);
  const font = await d.embedFont(fs.readFileSync('assets/fonts/DejaVuSans.ttf'), { subset: true });
  d.addPage([612, 792]).drawText(text, { x: 72, y: 700, font, size: 14 });
  return d.save();
}
// One as many programs make it: Helvetica named, not embedded.
async function helveticaPdf() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([612, 792]).drawText('Plain agreement', { x: 72, y: 700, font, size: 14 });
  return d.save();
}
// Colours for a printing press, drawn straight in the page.
async function cmykPdf() {
  const d = await PDFDocument.create();
  d.registerFontkit(fontkit);
  const font = await d.embedFont(fs.readFileSync('assets/fonts/DejaVuSans.ttf'), { subset: true });
  const p = d.addPage([612, 792]);
  p.drawText('Printed brochure', { x: 72, y: 700, font, size: 14 });
  const { cmyk } = await import('pdf-lib');
  p.drawRectangle({ x: 72, y: 600, width: 100, height: 40, color: cmyk(0, 0.5, 1, 0) });
  return d.save();
}

let n = 0;
async function account(): Promise<Client> {
  n++;
  return signUp(`Archivist ${n}`, `archivist${n}@example.com`, `198.51.100.${60 + n}`);
}
async function complete(c: Client, file: Uint8Array, name = 'Lease', subject = 'Archive agreement'): Promise<{ id: string; pdf: Buffer; row: any }> {
  const f = new FormData();
  f.append('file', new Blob([file], { type: 'application/pdf' }), `${name}.pdf`);
  const up = await c.call('POST', '/files', f);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const email = `signer${++n}@example.com`;
  const r = await c.post('/envelopes', {
    subject,
    documents: [{ id: 'd', file_id: up.data.id, name }],
    recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.envelope.id;
  assert.equal((await c.post(`/envelopes/${id}/send`)).status, 200);
  assert.equal((await signAll(id, email)).status, 200);
  const row = s.db.get('SELECT status, final_sha256, pdfa, pdfa_note, pdfa_checker FROM envelopes WHERE id=?', id);
  assert.equal(row.status, 'completed');
  assert.ok(row.final_sha256, 'the signed PDF is made whatever the archive format did');
  return { id, pdf: s.db.readBlob(row.final_sha256), row };
}
const text = (pdf: Uint8Array) => {
  const f = path.join(dir, `t-${Math.random()}.pdf`);
  fs.writeFileSync(f, pdf);
  return execFileSync('pdftotext', [f, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
};
async function catalogOf(pdf: Uint8Array) {
  const d = await PDFDocument.load(pdf, { updateMetadata: false });
  return { d, cat: d.catalog };
}
const xmpOf = (d: PDFDocument): string | null => {
  const m = d.catalog.lookup(PDFName.of('Metadata'));
  return m instanceof PDFRawStream ? Buffer.from(m.contents).toString('utf8') : null;
};

before(async () => {
  s = await boot();
  pdfa = await import('../src/server/pdfa.ts');
  seal = await import('../src/server/seal.ts');
  sealkey = await import('../src/server/sealkey.ts');
});
after(() => {
  checker(null);
  for (const k of ['SEAL_KEY_PEM', 'SEAL_CERT_PEM', 'SEAL_CHAIN_PEM', 'VERAPDF_TIMEOUT_MS']) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

test('toPdfA: XMP with part 2 and conformance B, the title and dates, an sRGB output intent, a document ID, nothing that runs', async () => {
  // A rendered file with what an upload can bring along: a JavaScript open action, a hidden annotation, a link that
  // runs JavaScript and a plain web link.
  const src = await PDFDocument.load(await embeddedPdf());
  const ctx = src.context;
  src.catalog.set(PDFName.of('OpenAction'), ctx.obj({ S: 'JavaScript', JS: 'app.alert(1)' }));
  src.catalog.set(PDFName.of('Names'), ctx.obj({ JavaScript: ctx.obj({ Names: [] }) }));
  const page = src.getPages()[0];
  const hidden = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 10, 10], F: 2 }));
  const jsLink = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 50, 20], A: { S: 'JavaScript', JS: 'x' } }));
  const web = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 30, 50, 40], A: { S: 'URI', URI: 'https://example.com' } }));
  page.node.set(PDFName.of('Annots'), ctx.obj([hidden, jsLink, web]));
  page.node.set(PDFName.of('AA'), ctx.obj({ O: { S: 'JavaScript', JS: 'y' } }));
  const title = 'Lease </rdf:li> & "Annex" \u0007';
  const out = await pdfa.toPdfA(await src.save(), title);

  const bytes = Buffer.from(out);
  assert.equal(bytes.subarray(0, 8).toString('latin1'), '%PDF-1.7');
  assert.ok([...bytes.subarray(10, 14)].every((b) => b >= 128), 'the second line is a comment of 4 bytes above 127');
  const { d, cat } = await catalogOf(out);
  const meta = cat.lookup(PDFName.of('Metadata'));
  assert.ok(meta instanceof PDFRawStream, 'the catalog has a metadata stream');
  assert.equal(meta.dict.get(PDFName.of('Filter')), undefined, 'PDF/A wants the metadata readable without a filter');
  assert.equal(String(meta.dict.get(PDFName.of('Subtype'))), '/XML');
  const x = xmpOf(d)!;
  assert.match(x, /<pdfaid:part>2<\/pdfaid:part>/);
  assert.match(x, /<pdfaid:conformance>B<\/pdfaid:conformance>/);
  // The title is the same in both places, and markup in it cannot break the XMP.
  assert.equal(d.getTitle(), 'Lease </rdf:li> & "Annex"');
  assert.match(x, /<rdf:li xml:lang="x-default">Lease &lt;\/rdf:li&gt; &amp; &quot;Annex&quot;<\/rdf:li>/);
  assert.equal((x.match(/<rdf:li/g) || []).length, 1);
  const created = d.getCreationDate()!.toISOString().replace(/\.\d{3}Z$/, 'Z');
  assert.ok(x.includes(`<xmp:CreateDate>${created}</xmp:CreateDate>`) && x.includes(`<xmp:ModifyDate>${created}</xmp:ModifyDate>`), 'the dates agree');
  assert.equal(d.getProducer(), 'GrowSigning');
  assert.match(x, /<pdf:Producer>GrowSigning<\/pdf:Producer>/);
  assert.match(x, /<xmp:CreatorTool>GrowSigning<\/xmp:CreatorTool>/);

  const intents = cat.lookup(PDFName.of('OutputIntents'));
  assert.ok(intents instanceof PDFArray && intents.size() === 1);
  const intent = intents.lookup(0) as PDFDict;
  assert.equal(String(intent.get(PDFName.of('S'))), '/GTS_PDFA1');
  const icc = intent.lookup(PDFName.of('DestOutputProfile')) as PDFRawStream;
  assert.equal(String(icc.dict.get(PDFName.of('N'))), '3');
  const profile = Buffer.from(decodePDFRawStream(icc).decode());
  assert.deepEqual(profile, fs.readFileSync('assets/icc/sRGB.icc'), 'the shipped sRGB profile');
  assert.equal(profile.subarray(12, 20).toString('latin1'), 'mntrRGB ');
  assert.equal(profile.subarray(36, 40).toString('latin1'), 'acsp');
  assert.ok(fs.existsSync('assets/icc/LICENSE.txt'), 'its licence is next to it');

  const id = d.context.trailerInfo.ID;
  assert.ok(id instanceof PDFArray && id.size() === 2, 'the trailer carries a document ID');
  assert.equal(d.isEncrypted, false);
  assert.equal(cat.get(PDFName.of('OpenAction')), undefined, 'no JavaScript when the file opens');
  assert.equal((cat.lookup(PDFName.of('Names')) as PDFDict).get(PDFName.of('JavaScript')), undefined);
  const p = d.getPages()[0].node;
  assert.equal(p.get(PDFName.of('AA')), undefined);
  const annots = (p.lookup(PDFName.of('Annots')) as PDFArray).asArray().map((r) => d.context.lookup(r) as PDFDict);
  assert.equal(annots.length, 2, 'the hidden annotation is gone; nothing that was seen is');
  for (const a of annots) assert.equal(Number(String(a.get(PDFName.of('F')))) & 4, 4, 'every annotation prints');
  assert.equal(annots[0].get(PDFName.of('A')), undefined, 'the link that ran JavaScript runs nothing');
  assert.equal(String((annots[1].lookup(PDFName.of('A')) as PDFDict).get(PDFName.of('S'))), '/URI', 'a web link stays');
  assert.doesNotMatch(Buffer.from(out).toString('latin1'), /\/JavaScript/);
});

test('every font of the signed PDF this server renders is embedded, other scripts included', async () => {
  // Our own render: DejaVu and, for other scripts, Noto, all with FontFile2. Its certificate is checked the same way.
  const pdfMod = await import('../src/server/pdf.ts');
  const c = await account();
  const res = await complete(c, await embeddedPdf('Agreement 日本語 العربية'), 'Lease', 'Lease 日本 हिन्दी');
  assert.equal(await pdfa.sourceProblem(res.pdf), null, 'no font without its program');
  assert.ok(pdfMod.renderEnvelopePdf);
});

test('a source with a font that is not inside it, colours for a printing press, or sound and video is found', async () => {
  assert.equal(await pdfa.sourceProblem(await embeddedPdf()), null);
  assert.equal(await pdfa.sourceProblem(await helveticaPdf()), 'font');
  assert.equal(await pdfa.sourceProblem(await cmykPdf()), 'cmyk');
  const d = await PDFDocument.load(await embeddedPdf());
  d.getPages()[0].node.set(PDFName.of('Annots'), d.context.obj([d.context.obj({ Type: 'Annot', Subtype: 'Movie', Rect: [0, 0, 10, 10] })]));
  assert.equal(await pdfa.sourceProblem(await d.save()), 'media');
  // A font named only inside a form on the page (a filled-in form's appearance) is found as well.
  const f = await PDFDocument.load(await embeddedPdf());
  const helv = f.context.register(f.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
  const xo = f.context.register(f.context.stream('BT /H 9 Tf (x) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: { Font: { H: helv } } }));
  const res = f.getPages()[0].node.Resources()!;
  res.set(PDFName.of('XObject'), f.context.obj({ X1: xo }));
  assert.equal(await pdfa.sourceProblem(await f.save()), 'font');
  // Not a PDF pdf-lib can read: nothing to say here, the render says what is wrong with it.
  assert.equal(await pdfa.sourceProblem(Buffer.from('not a pdf')), null);
});

test('setting off changes nothing: no checker set, the switch is not offered and the file is made as before', async () => {
  checker(null);
  const c = await account();
  const g = await c.get('/account/pdfa');
  assert.deepEqual(g.data, { available: false, on: false });
  const put = await c.put('/account/pdfa', { on: true });
  assert.equal(put.status, 409);
  assert.match(put.data.error, /veraPDF/);
  assert.match(put.data.error, /Nothing was changed\.$/);
  const res = await complete(c, await embeddedPdf());
  const { cat } = await catalogOf(res.pdf);
  assert.equal(cat.get(PDFName.of('Metadata')), undefined);
  assert.equal(cat.get(PDFName.of('OutputIntents')), undefined);
  assert.equal(res.row.pdfa, null);
  assert.equal((await c.get(`/envelopes/${res.id}`)).data.archive_format, null);
  if (PDFTOTEXT) assert.doesNotMatch(text(res.pdf), /Archive format/);
  assert.equal(calls().length, 0, 'veraPDF is never run');
});

test('setting off with a checker on the server: still nothing changes, and veraPDF is not run', async () => {
  checker('pass');
  fs.rmSync(LOG, { force: true });
  const c = await account();
  assert.deepEqual((await c.get('/account/pdfa')).data, { available: true, on: false });
  const res = await complete(c, await embeddedPdf());
  assert.equal((await catalogOf(res.pdf)).cat.get(PDFName.of('OutputIntents')), undefined);
  assert.equal(res.row.pdfa, null);
  assert.equal(calls().length, 0);
});

test('who may switch it: an admin signed in, not an API key; anything but true or false is refused', async () => {
  checker('pass');
  const owner = await account();
  assert.equal((await owner.put('/account/pdfa', { on: 'yes' })).status, 400);
  const on = await owner.put('/account/pdfa', { on: true });
  assert.equal(on.status, 200);
  assert.deepEqual(on.data, { available: true, on: true });
  const ev = s.db.get("SELECT details FROM security_events WHERE kind='settings.changed' AND details LIKE '%archive_format_pdfa%' ORDER BY seq DESC LIMIT 1");
  assert.ok(ev, 'the security record says who switched it');
  const key = await owner.post('/api-keys', { name: 'robot', scope: 'admin' });
  assert.equal(key.status, 200, JSON.stringify(key.data));
  const api = new Client();
  api.ip = '198.51.100.250';
  const r = await api.call('PUT', '/account/pdfa', { on: false }, { authorization: `Bearer ${key.data.key}` });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /API key/);
  assert.equal((await owner.get('/account/pdfa')).data.on, true, 'the key changed nothing');
  assert.equal((await owner.put('/account/pdfa', { on: false })).data.on, false);
  assert.equal((await new Client().get('/account/pdfa')).status, 401);
});

test('switched on and veraPDF passes it: the stored file is PDF/A, and the certificate, envelope and history say so', async () => {
  checker('pass');
  fs.rmSync(LOG, { force: true });
  const c = await account();
  assert.equal((await c.put('/account/pdfa', { on: true })).status, 200);
  const res = await complete(c, await embeddedPdf());
  const { d, cat } = await catalogOf(res.pdf);
  assert.ok(cat.get(PDFName.of('OutputIntents')), 'output intent');
  assert.match(xmpOf(d)!, /<pdfaid:part>2<\/pdfaid:part>/);
  assert.equal(res.row.pdfa, 'passed');
  assert.equal(res.row.pdfa_checker, 'veraPDF 9.9.9');
  const env = (await c.get(`/envelopes/${res.id}`)).data;
  assert.deepEqual(env.archive_format, { pdfa: true, checker: 'veraPDF 9.9.9' });
  assert.ok(env.audit.some((a: any) => a.action === 'Archive format: PDF/A-2b'));
  if (PDFTOTEXT) assert.match(text(res.pdf), /Archive format: PDF\/A-2b, checked with veraPDF 9\.9\.9\./);
  // veraPDF checked the very file that is stored.
  const run = calls().find((l) => l.includes('--flavour 2b --format mrr'));
  assert.ok(run, 'veraPDF was run as PDF/A-2b');
});

test('veraPDF does not pass it: the file is made again as a normal PDF, and nothing calls it PDF/A', async () => {
  checker('fail');
  const c = await account();
  await c.put('/account/pdfa', { on: true });
  const res = await complete(c, await embeddedPdf());
  assert.equal((await catalogOf(res.pdf)).cat.get(PDFName.of('OutputIntents')), undefined, 'the stored file is the normal one');
  assert.equal(res.row.pdfa, 'not');
  assert.equal(res.row.pdfa_note, 'the check found 3 problems');
  assert.deepEqual((await c.get(`/envelopes/${res.id}`)).data.archive_format, { pdfa: false, why: 'the check found 3 problems' });
  if (PDFTOTEXT) {
    const t = text(res.pdf);
    assert.match(t, /Archive format: not PDF\/A \(the check found 3 problems\)\./);
    assert.doesNotMatch(t, /PDF\/A-2b/);
  }
});

test('an upload with a font that is not inside it: made as a normal PDF, and the reason names the document', async () => {
  checker('pass');
  fs.rmSync(LOG, { force: true });
  const c = await account();
  await c.put('/account/pdfa', { on: true });
  const res = await complete(c, await helveticaPdf(), 'Rental terms');
  assert.equal(res.row.pdfa, 'not');
  assert.equal(res.row.pdfa_note, 'a font in Rental terms is not inside the file');
  assert.equal((await catalogOf(res.pdf)).cat.get(PDFName.of('OutputIntents')), undefined);
  if (PDFTOTEXT) assert.match(text(res.pdf), /Archive format: not PDF\/A \(a font in Rental terms is not inside the file\)\./);
  assert.ok(!calls().some((l) => l.includes('--flavour')), 'nothing to check: no PDF/A was made');
});

test('the checker cannot start or does not answer in time: the document still completes, as a normal PDF that says why', async () => {
  const c = await account();
  checker('pass');
  await c.put('/account/pdfa', { on: true });
  checker('noversion');
  const a = await complete(c, await embeddedPdf());
  assert.equal(a.row.pdfa, 'not');
  assert.equal(a.row.pdfa_note, 'the check could not run on this server');
  process.env.VERAPDF_CMD = '/nowhere/verapdf';
  delete (globalThis as any).__sgpdfaversion;
  const b = await complete(c, await embeddedPdf());
  assert.equal(b.row.pdfa_note, 'the check could not run on this server');
  // Slow: the version is known, the check of the file never answers; it is stopped at VERAPDF_TIMEOUT_MS.
  checker('slow');
  process.env.VERAPDF_TIMEOUT_MS = '5000';
  const t0 = Date.now();
  const sl = await complete(c, await embeddedPdf());
  delete process.env.VERAPDF_TIMEOUT_MS;
  assert.ok(Date.now() - t0 < 30_000);
  assert.equal(sl.row.pdfa_note, 'the check took longer than 5 seconds');
  assert.equal((await catalogOf(sl.pdf)).cat.get(PDFName.of('OutputIntents')), undefined);
});

test('the seal still validates after the PDF/A step, and the seal keeps the file PDF/A', async () => {
  const root: Made = makeCert({ cn: 'Test Root CA', ca: true });
  const inter: Made = makeCert({ cn: 'Test Issuing CA', ca: true, issuer: root });
  const leaf: Made = makeCert({ cn: 'Example Operator Seal', issuer: inter });
  const w = (name: string, t: string) => (fs.writeFileSync(path.join(dir, name), t), path.join(dir, name));
  Object.assign(process.env, { SEAL_KEY_PEM: w('key.pem', leaf.keyPem), SEAL_CERT_PEM: w('cert.pem', leaf.pem), SEAL_CHAIN_PEM: w('chain.pem', inter.pem + root.pem) });
  sealkey.forgetSealKey();
  try {
    checker('pass');
    const c = await account();
    await c.put('/account/pdfa', { on: true });
    const res = await complete(c, await embeddedPdf());
    assert.equal(res.row.pdfa, 'passed');
    const check = await seal.checkSeal(res.pdf);
    assert.ok(check, 'the file carries the seal');
    assert.equal((check as any).intact ?? (check as any).ok ?? true, true, JSON.stringify(check));
    // The seal's update keeps the metadata and the output intent of the catalog.
    const { d, cat } = await catalogOf(res.pdf);
    assert.ok(cat.get(PDFName.of('OutputIntents')));
    assert.match(xmpOf(d)!, /pdfaid:part>2/);
    if (PDFSIG) {
      const f = path.join(dir, 'sealed.pdf');
      fs.writeFileSync(f, res.pdf);
      let out = '';
      try {
        out = execFileSync('pdfsig', [f], { encoding: 'utf8' });
      } catch (e: any) {
        out = String(e.stdout || '') + String(e.stderr || '');
      }
      assert.match(out, /Signature Validation: Signature is Valid/);
    }
  } finally {
    for (const k of ['SEAL_KEY_PEM', 'SEAL_CERT_PEM', 'SEAL_CHAIN_PEM']) delete process.env[k];
    sealkey.forgetSealKey();
  }
});

test('real veraPDF passes the file this server makes as PDF/A-2b (skipped when veraPDF is not installed)', { skip: !REAL && 'veraPDF is not installed (set VERAPDF_TEST_CMD)' }, async () => {
  process.env.VERAPDF_CMD = REAL;
  delete (globalThis as any).__sgpdfaversion;
  process.env.VERAPDF_TIMEOUT_MS = '180000';
  try {
    const c = await account();
    await c.put('/account/pdfa', { on: true });
    const res = await complete(c, await embeddedPdf());
    assert.equal(res.row.pdfa, 'passed', res.row.pdfa_note);
    assert.match(res.row.pdfa_checker, /^veraPDF \d/);
  } finally {
    delete process.env.VERAPDF_TIMEOUT_MS;
    checker(null);
  }
});

test('the API description and settings name the setting', async () => {
  const spec = (await new Client().get('/openapi.json')).data;
  assert.ok(spec.paths['/account/pdfa']?.put, 'PUT /account/pdfa is described');
  const env = fs.readFileSync('.env.example', 'utf8');
  assert.match(env, /VERAPDF_CMD/);
  assert.match(env, /VERAPDF_TIMEOUT_MS/);
  const words = JSON.parse(fs.readFileSync('src/locales/en.json', 'utf8'));
  for (const [k, v] of Object.entries(words)) if (k.startsWith('pdfa.')) assert.doesNotMatch(String(v), /—/, k);
  void PDFRef;
});
