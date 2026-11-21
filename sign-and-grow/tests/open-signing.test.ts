// What earlier rounds reported as not finished (research/continue.json: simplify-signing, expiry, impact, ds-seal,
// ds-convert), finished here. The payment part is in tests/billing10.test.ts, because it needs the payment stand-in
// and a clock that moves.
//   - /impact says about Treegens' checking only what Treegens' own pages say, as Treegens' account, with the day
//     they were read, and where the rate of ten trees for a dollar comes from.
//   - The account's export holds the originals of converted files.
//   - A signature in an uploaded PDF is found also when it is not listed in the form, or the PDF cannot be opened.
//   - The help page answers "Yes" to Word files only where LibreOffice is really installed.
//   - A time-stamp service that hung is left alone for ten minutes, so only one signer waits for it.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { boot, signUp, simple, signAll, samplePdf, type Server } from './helpers.ts';
import { existingSignatures, signaturesInBytes } from '../src/server/seal.ts';
import { converterConfigured, ORIGINALS_EXPORT_README } from '../src/lib/convert.ts';
import { onPath } from '../src/lib/onpath.ts';
import { timeStamp, tsaForgetRests, TsaError, TSA_REST_MS } from '../src/server/tsa.ts';
import { TREEGENS_URL, TREEGENS_ORG_URL, TREEGENS_READ_ON } from '../src/lib/impactwords.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});
const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, '..', f), 'utf8');

function unzip(data: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(data);
  const out = new Map<string, Buffer>();
  let p = 0;
  while (b.readUInt32LE(p) === 0x04034b50) {
    const size = b.readUInt32LE(p + 18), nl = b.readUInt16LE(p + 26), xl = b.readUInt16LE(p + 28);
    out.set(b.subarray(p + 30, p + 30 + nl).toString('utf8'), b.subarray(p + 30 + nl + xl, p + 30 + nl + xl + size));
    p += 30 + nl + xl + size;
  }
  return out;
}

// ---- 1. Green claims --------------------------------------------------------------------------------------------

test('/impact repeats about Treegens only what its own pages say, as its account and not ours, with the day it was read', () => {
  const view = read('src/components/ImpactView.tsx');
  const li = view.split('\n').filter((l) => /Treegens/.test(l) && /<li>/.test(l));
  const checking = li.find((l) => /verifiers/.test(l))!;
  assert.ok(checking, 'the sentence about checking is there');
  // What the page at treegens.app said on the day it was read: filmed in the app, a GPS fix, verifiers in the DAO vote.
  assert.match(checking, /Treegens describes its own checking on <a href=\{TREEGENS_URL\}/);
  assert.match(checking, /a planter films the land and then the planting in its app, the phone stores a GPS fix with the clips, and verifiers in the Treegens DAO watch both videos and vote to approve or reject/);
  assert.match(checking, /That is what Treegens says about its own work, as we read it there on \{TREEGENS_READ_ON\}\. It is not our finding: we have not checked plantings ourselves\./);
  // Words that would make it our claim, or a claim about anyone outside Treegens, are not used.
  for (const l of li) assert.doesNotMatch(l, /independent|audited|certified|guarantee|proven|every tree is/i, l.slice(0, 80));
  // The rate is given with where it comes from, and as an average, not a price for each tree.
  const rate = li.find((l) => /ten cents/.test(l))!;
  assert.match(rate, /<a href=\{TREEGENS_ORG_URL\}[^>]*>treegens\.org<\/a> says ten cents is the average cost of planting a tree across a run, not an invoice for a named tree/);
  assert.match(rate, /It is an average Treegens states, not a price we can show for each tree\./);
  assert.match(view, /we do not publish receipts for the money sent to Treegens/);
  assert.equal(TREEGENS_URL, 'https://treegens.app');
  assert.equal(TREEGENS_ORG_URL, 'https://treegens.org');
  assert.match(TREEGENS_READ_ON, /^\d{1,2} [A-Z][a-z]+ \d{4}$/);
  // Nowhere else in what people read is Treegens' checking described at all.
  for (const f of ['src/app/page.tsx', 'src/app/pricing/page.tsx', 'src/components/Public.tsx', 'src/lib/impactwords.ts', 'src/server/chatkb.ts', 'src/server/mail.ts'])
    assert.doesNotMatch(read(f), /verified by|independently verified|audited planting|checked before they count/i, f);
  assert.doesNotMatch(view, /—/, 'no em dash');
});

// ---- 2. Originals in the account's export ------------------------------------------------------------------------

test('the export under Settings holds the file as it was uploaded for a document made from a Word file, and says so', async () => {
  const c = await signUp('Olga Original', 'olga.original@example.com', '198.51.130.1');
  const e = await simple(c, 'sig.original@example.com');
  // The document's file was made from a Word file: the original is kept with it, as keepOriginal does after a conversion.
  const original = Buffer.from('PK\u0003\u0004 the words of the contract as typed in Word');
  const sha = db.saveBlob(original);
  const fileId = db.get('SELECT file_id FROM documents WHERE envelope_id=?', e.id).file_id;
  db.run('UPDATE files SET original_sha256=?, converted=? WHERE id=?', sha, JSON.stringify({ from: 'Contract of sale.docx', kind: 'docx', family: 'word', sha256: sha, size: original.length, tool: 'the test converter', notes: [], at: new Date().toISOString() }), fileId);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, 'sig.original@example.com')).status, 200);
  // A second envelope with an ordinary PDF: nothing of it under originals/.
  const plain = await simple(c, 'sig.plain@example.com');
  assert.equal((await c.post(`/envelopes/${plain.id}/send`)).status, 200);

  const zip = await c.get('/export');
  assert.equal(zip.status, 200);
  const files = unzip(zip.data);
  const kept = [...files.keys()].filter((k) => k.startsWith('originals/'));
  assert.equal(kept.length, 1, kept.join(', '));
  assert.match(kept[0], new RegExp(`^originals/\\d{4}-\\d\\d-\\d\\d Simple agreement ${e.id.slice(-6)}/01 Contract of sale\\.docx$`));
  assert.deepEqual(files.get(kept[0]), original);
  const readme = files.get('README.txt')!.toString();
  assert.ok(readme.includes(ORIGINALS_EXPORT_README));
  assert.match(ORIGINALS_EXPORT_README, /These were not signed: the PDF made from each is what people saw and signed/);

  // An original that cannot be read is left out and named with what to do, and the rest of the ZIP is whole.
  db.run('UPDATE files SET original_sha256=? WHERE id=?', 'f'.repeat(64), fileId);
  const again = unzip((await c.get('/export')).data);
  assert.equal([...again.keys()].filter((k) => k.startsWith('originals/')).length, 0);
  assert.ok([...again.keys()].some((k) => k.startsWith('signed/')), 'the signed PDF is still there');
  const said = again.get('README.txt')!.toString();
  assert.match(said, /1 file\(s\) that were turned into a PDF are not in this file as they were uploaded\. The PDFs made from them, which are what people signed, are not affected\./);
  assert.match(said, /Contract of sale\.docx, the original of "[^"]+" \(envelope [^)]+\): it could not be read from storage/);
  assert.ok(!said.includes(ORIGINALS_EXPORT_README), 'no line for a folder that is not there');
  db.run('UPDATE files SET original_sha256=? WHERE id=?', sha, fileId);

  // Somebody else's export never holds it: another account, and a member of this one who did not send it.
  const other = await signUp('Stranger Person', 'stranger.original@example.com', '198.51.130.2');
  const oe = await simple(other, 'sig.stranger@example.com');
  assert.equal((await other.post(`/envelopes/${oe.id}/send`)).status, 200);
  const theirs = unzip((await other.get('/export')).data);
  assert.equal([...theirs.keys()].filter((k) => k.startsWith('originals/')).length, 0);
  assert.ok(![...theirs.values()].some((v) => v.includes(original)));
  // An export of chosen envelopes holds only their originals.
  const only = unzip((await c.get(`/export?ids=${plain.id}`)).data);
  assert.equal([...only.keys()].filter((k) => k.startsWith('originals/')).length, 0);
  // A name that tries to leave its folder stays inside it.
  db.run('UPDATE files SET converted=? WHERE id=?', JSON.stringify({ from: '../../signed/evil.pdf', kind: 'docx', family: 'word', sha256: sha, size: original.length, tool: 't', notes: [], at: '' }), fileId);
  const safe = [...unzip((await c.get('/export')).data).keys()].filter((k) => k.startsWith('originals/'));
  assert.equal(safe.length, 1);
  assert.doesNotMatch(safe[0], /\.\.\//);
  assert.equal(safe[0].split('/').length, 3, safe[0]);
  assert.match(read('README.md'), /export under Settings holds the originals of converted files for envelopes that were sent/);
  assert.match(read('src/server/openapi.ts'), /the file as it was uploaded is in originals\//);
});

// ---- 3. Signatures already in an uploaded PDF --------------------------------------------------------------------

const SIG = '\n9 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 120 4218 310] /Contents <3082' + '00'.repeat(2000) + '> >>\nendobj\n';

test('a signature that is not listed in the form, or sits in a PDF that cannot be opened, is still found and said', async () => {
  const plain = Buffer.from(await samplePdf(1));
  assert.equal(signaturesInBytes(plain), 0);
  assert.equal(await existingSignatures(plain), 0, 'an ordinary PDF carries none');
  // A signature dictionary that no form field points to (the form's own list finds nothing).
  const loose = Buffer.concat([plain, Buffer.from(SIG, 'latin1')]);
  assert.equal((await PDFDocument.load(loose, { updateMetadata: false })).getForm().getFields().length, 0);
  assert.equal(await existingSignatures(loose), 1);
  // Two of them, and a document time stamp counts as well.
  assert.equal(await existingSignatures(Buffer.concat([loose, Buffer.from(SIG.replace('9 0 obj', '10 0 obj').replace('/Type /Sig', '/Type /DocTimeStamp'), 'latin1')])), 2);
  // A file the PDF library cannot open.
  const broken = Buffer.from('%PDF-1.7\n1 0 obj\n<< this is not a document' + SIG, 'latin1');
  await assert.rejects(PDFDocument.load(broken, { updateMetadata: false }).then((d) => d.getPageCount()));
  assert.equal(await existingSignatures(broken), 1);
  // Not fooled by the words alone: a page that only talks about a ByteRange, or a range with no signature in its object.
  assert.equal(signaturesInBytes(Buffer.from('%PDF-1.7\n(the /ByteRange of a signature names four numbers)\n')), 0);
  assert.equal(signaturesInBytes(Buffer.from('%PDF-1.7\n3 0 obj\n<< /ByteRange [0 1 2 3] >>\nendobj\n4 0 obj\n<< /Contents 5 0 R >>\nendobj\n')), 0);
  // A view into a larger buffer is read as the view, not the whole buffer.
  const padded = Buffer.concat([Buffer.from(SIG, 'latin1'), plain]);
  assert.equal(signaturesInBytes(new Uint8Array(padded.buffer, padded.byteOffset + Buffer.byteLength(SIG, 'latin1'), plain.length)), 0);

  // Through the upload: the sender is told before anything is sent.
  const c = await signUp('Una Upload', 'una.upload@example.com', '198.51.130.3');
  const f = new FormData();
  f.append('file', new Blob([loose], { type: 'application/pdf' }), 'Signed elsewhere.pdf');
  const up = await c.call('POST', '/files', f);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.existing_signatures, 1);
  assert.match(up.data.existing_signatures_note, /^This PDF already carries a digital signature\. It does not survive here/);
  const g = new FormData();
  g.append('file', new Blob([plain], { type: 'application/pdf' }), 'Plain.pdf');
  assert.equal((await c.call('POST', '/files', g)).data.existing_signatures, undefined);
});

// ---- 4. "Can I add a Word file?" on /help ------------------------------------------------------------------------

test('the help page says Yes to Word files only where LibreOffice is really installed', () => {
  const keep = { CONVERTER: process.env.CONVERTER, CONVERTER_URL: process.env.CONVERTER_URL };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-onpath-'));
  try {
    delete process.env.CONVERTER_URL;
    process.env.CONVERTER = 'soffice';
    // Set to LibreOffice, and it is not there: every Word file would be refused, so the answer is not Yes.
    assert.equal(converterConfigured((p) => onPath(p, { PATH: dir })), false);
    fs.writeFileSync(path.join(dir, 'soffice'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(converterConfigured((p) => onPath(p, { PATH: `/nowhere-at-all${path.delimiter}${dir}` })), true);
    // A file that may not be run, a folder of that name, and a name with a path in it are not the program.
    fs.chmodSync(path.join(dir, 'soffice'), 0o644);
    assert.equal(onPath('soffice', { PATH: dir }), process.getuid?.() === 0 ? onPath('soffice', { PATH: dir }) : false);
    fs.rmSync(path.join(dir, 'soffice'));
    fs.mkdirSync(path.join(dir, 'soffice'));
    assert.equal(onPath('soffice', { PATH: dir }), false);
    assert.equal(onPath('../soffice', { PATH: dir }), false);
    assert.equal(onPath('soffice', { PATH: '' }), false);
    // Without a look at the disk only the settings are read, as before; Gotenberg is a service, not a program here.
    assert.equal(converterConfigured(), true);
    process.env.CONVERTER = 'gotenberg';
    process.env.CONVERTER_URL = 'http://gotenberg:3000';
    assert.equal(converterConfigured(() => false), true);
    delete process.env.CONVERTER;
    delete process.env.CONVERTER_URL;
    assert.equal(converterConfigured(() => true), false, 'no setting, no converter, whatever is installed');
    assert.match(read('src/app/help/convert.tsx'), /\{converterConfigured\(onPath\) \? \(/);
    assert.doesNotMatch(read('src/app/help/convert.tsx'), /src\/server|@\/server/);
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 5. A time-stamp service that hangs ---------------------------------------------------------------------------

test('a time-stamp service that did not answer is left alone for ten minutes, so the next signer does not wait for it', async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((url: any, init: any) => {
    calls.push(String(url));
    if (String(url).includes('error.test')) return Promise.resolve(new Response('no', { status: 503 }));
    // Never answers; gives up when the caller's own time limit says so, as a real connection does.
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  }) as any;
  tsaForgetRests();
  const sig = crypto.randomBytes(64);
  try {
    const t0 = Date.now();
    await assert.rejects(timeStamp(sig, ['https://hangs.test/ts']), (e: any) => e instanceof TsaError && /hangs\.test: it did not answer within 3 seconds/.test(e.message));
    assert.ok(Date.now() - t0 >= 2_500, 'the first one waited');
    // The next signer: not asked, no wait, and the record says why in words.
    const t1 = Date.now();
    await assert.rejects(timeStamp(sig, ['https://hangs.test/ts']), (e: any) => e instanceof TsaError && /^hangs\.test: not asked, because it did not answer a short while ago and is left alone for 10 more minutes$/.test(e.message));
    assert.ok(Date.now() - t1 < 500, `the second one waited ${Date.now() - t1} ms`);
    assert.deepEqual(calls, ['https://hangs.test/ts']);
    // A service that answers with an error made nobody wait, so it is asked every time.
    await assert.rejects(timeStamp(sig, ['https://error.test/ts']), /error\.test: it answered HTTP 503/);
    await assert.rejects(timeStamp(sig, ['https://error.test/ts']), /error\.test: it answered HTTP 503/);
    assert.equal(calls.filter((u) => u.includes('error.test')).length, 2);
    // Another service in the list is still asked while the first one rests.
    await assert.rejects(timeStamp(sig, ['https://hangs.test/ts', 'https://error.test/ts']), /hangs\.test: not asked.*; error\.test: it answered HTTP 503/);
    // After the rest it is asked again (the clock is moved, not waited for).
    const realNow = Date.now;
    Date.now = () => realNow() + TSA_REST_MS + 1000;
    try {
      await assert.rejects(timeStamp(sig, ['https://hangs.test/ts']), /hangs\.test: it did not answer within 3 seconds/);
    } finally {
      Date.now = realNow;
    }
    assert.equal(calls.filter((u) => u.includes('hangs.test')).length, 2);
    // Only the host is ever repeated, never the address with what may be a key in its path.
    await assert.rejects(timeStamp(sig, ['https://hangs.test/ts']), (e: any) => !/\/ts/.test(e.message));
  } finally {
    globalThis.fetch = realFetch;
    tsaForgetRests();
  }
  assert.match(read('README.md'), /A service that did not answer in time is not asked again for 10 minutes/);
  assert.match(read('.env.example'), /A service that did not answer in time is not asked again for\n# 10 minutes/);
});
