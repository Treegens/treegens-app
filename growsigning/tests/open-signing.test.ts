// What earlier rounds reported as not finished (research/continue.json: simplify-signing, expiry, impact, ds-seal,
// ds-convert), finished here. The payment part is in tests/billing10.test.ts, because it needs the payment stand-in
// and a clock that moves.
//   - /impact says about Treegens' checking only what Treegens' own pages say, as Treegens' account, with the day
//     they were read, and where the rate of ten trees for a dollar comes from.
//   - The account's export holds the originals of converted files.
//   - A signature in an uploaded PDF is found also when it is not listed in the form, or the PDF cannot be opened.
//   - The help page answers "Yes" to Word files only where LibreOffice is really installed.
//   - A time-stamp service that hung is left alone for ten minutes, so signers who finish later do not wait for it,
//     and signers who finish at the same moment wait together, never longer than the first.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { boot, signUp, simple, signAll, samplePdf, mailTo, tokenFor, Client, type Server } from './helpers.ts';
import { momentText } from '../src/lib/dates.ts';
import { groupTakeOn, groupInvite } from '../src/lib/groups.ts';
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
  // Plain words for a busy reader: no "DAO", no unclear "its app"; who the verifiers are is what treegens.org says.
  assert.match(checking, /a planter films the land and then the planting in the Treegens app, the phone records where the clips were filmed, and verifiers watch both videos and vote to approve or reject\. The verifiers are members of the Treegens community who stake its token to take part\./);
  assert.doesNotMatch(checking, /\bDAO\b|in its app/);
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
  // Each outside sentence carries a note of the words it rests on, as they were read, so the next reader can compare.
  assert.match(view, /Record the land, then record the planting\s+\/\/\s+in the app\. The phone stores a GPS fix with the clips\./);
  assert.match(view, /"Ten cents is the average planting cost across a run, not a named-tree invoice\."/);
  assert.match(view, /"stake to become a verifier", "DAO verifiers confirm the count"/);
  // The note to ourselves about sheets a tree makes is now a plain sentence.
  assert.match(view, /We never show saved paper as a share of a tree\. For scale only: one tree makes about/);
  assert.doesNotMatch(view, /is used nowhere as a claim/);
  // The outside references open: the water report is linked, and Conservatree by the address that does not fail on
  // a certificate error. The figures on the page are the figures those pages give.
  assert.match(view, /href="https:\/\/www\.waterfootprint\.org\/resources\/Report46-WaterFootprintPaper\.pdf"/);
  assert.match(view, /href="http:\/\/conservatree\.org\/learn\/EnviroIssues\/TreeStats\.shtml"/);
  assert.match(view, /from 2 to 13 litres a sheet/);
  assert.match(read('src/lib/impact.ts'), /sheetsPerTree: 8333,/);
});

test('no page says that 100% or everything customers pay goes to Treegens: card fees are named, in one line', async () => {
  const { MONEY_LINE, MONEY_SHORT } = await import('../src/lib/impactwords.ts');
  assert.equal(MONEY_LINE, 'What customers pay GrowSigning, less card fees, goes to Treegens to plant mangroves.');
  assert.equal(MONEY_SHORT, 'What you pay, less card fees, goes to Treegens tree planting.');
  const people = ['src/components/Public.tsx', 'src/components/ImpactView.tsx', 'src/app/page.tsx', 'src/app/impact/page.tsx', 'src/app/app/impact/page.tsx', 'src/app/pricing/page.tsx', 'src/server/chatkb.ts', 'README.md'];
  for (const f of people) {
    const text = read(f);
    assert.doesNotMatch(text, /100% of what (?:you|customers) pay|[Ee]verything (?:customers pay|you pay|paid to GrowSigning)|[Aa]ll of what you pay|all of it sent to Treegens/, f);
  }
  // The footer of every public page and the helper's instructions use the one line.
  assert.match(read('src/components/Public.tsx'), /<p>\{MONEY_SHORT\}<\/p>/);
  assert.match(read('src/server/chatkb.ts'), /and from people who send documents\. \$\{MONEY_LINE\}/);
  // Since the 5 trees rule (23 November 2026) the trees total counts finished signatures, not dollars, and the page
  // says where the trees of a free signature come from. (Before: "It counts each whole dollar, before card fees".)
  assert.match(read('src/components/ImpactView.tsx'), /Free signatures are paid for from what plans earn\./);
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
    // Each of the two signers asked it, and each asked once more a quarter of a second later (TSA_RETRY_STATUS in
    // tsa.ts, held by tests/seal-spec.test.ts 3b): two tries each, never a third, and no rest in between.
    assert.equal(calls.filter((u) => u.includes('error.test')).length, 4);
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
  assert.match(read('README.md'), /wait together and never longer than the first one\. The 10 minutes are kept in the\n  memory of each server process/);
  assert.doesNotMatch(read('README.md') + read('src/server/tsa.ts'), /one signer in ten minutes/);
});

test('signers who finish at the same moment while a time-stamp service hangs wait together, not one after another', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((url: any, init: any) => {
    calls++;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  }) as any;
  tsaForgetRests();
  try {
    const t0 = Date.now();
    // Three last signers: two at once, the third a second later. Each would have waited 3 seconds of its own.
    const one = (delay: number) => new Promise<{ ended: number; why: string }>((done) => setTimeout(() => timeStamp(crypto.randomBytes(32), ['https://hangs.test/ts']).catch((e) => done({ ended: Date.now() - t0, why: e.message })), delay));
    const [a, b, c] = await Promise.all([one(0), one(0), one(1000)]);
    // Everyone is done when the first request's 3 seconds are up, not 4 seconds in for the one who came later.
    for (const r of [a, b, c]) assert.ok(r.ended < 3_600, `ended after ${r.ended} ms`);
    assert.ok(Date.now() - t0 < 3_600);
    assert.match(a.why, /^hangs\.test: it did not answer within 3 seconds$/);
    assert.match(c.why, /^hangs\.test: it did not answer, nor had it answered within 3 seconds a request sent to it moments earlier$/);
    // And afterwards it rests: the next signer is not made to wait, and no request is sent.
    const before = calls;
    const t1 = Date.now();
    await assert.rejects(timeStamp(crypto.randomBytes(32), ['https://hangs.test/ts']), /not asked, because it did not answer a short while ago/);
    assert.ok(Date.now() - t1 < 300);
    assert.equal(calls, before);
  } finally {
    globalThis.fetch = realFetch;
    tsaForgetRests();
  }
  // A service that answers is still asked by everyone who finishes together: nothing is skipped while it is healthy.
  let asked = 0;
  globalThis.fetch = (async () => (asked++, await new Promise((r) => setTimeout(r, 50)), new Response('no', { status: 500 }))) as any;
  try {
    const all = await Promise.all([1, 2, 3].map(() => timeStamp(crypto.randomBytes(32), ['https://slowok.test/ts']).catch((e) => e.message)));
    // Three signers, and each asks once more after HTTP 500 (the retry in tsa.ts): two tries each, nobody skipped.
    assert.equal(asked, 6);
    for (const m of all) assert.match(m, /slowok\.test: it answered HTTP 500/);
  } finally {
    globalThis.fetch = realFetch;
    tsaForgetRests();
  }
  assert.match(read('.env.example'), /A service that did not answer in time is not asked again for\n# 10 minutes/);
});

// ---- 6. The consent screen of a group's member, a witness, an approver and someone asked to read ------------------

test('the consent screen stays at 120 words before the tick for a group, a witness, an approver and a reader', () => {
  const page = read('src/app/sign/[token]/page.tsx');
  const consent = page.slice(page.indexOf("if (stage === 'consent') {"), page.indexOf('</Shell>', page.indexOf("if (stage === 'consent') {")));
  // Who it is for when it is not a signature: three words at most (they come before the tick).
  const ask = consent.match(/const ask = (.*);/)![1];
  // The words are in the catalogue, said in the signer's language (src/locales/en.json).
  const words = JSON.parse(read('src/locales/en.json'));
  const kickers = [...ask.matchAll(/T\('([^']+)'\)/g)].map((m) => words[m[1]]);
  assert.deepEqual(kickers, ['Asked to approve', 'Asked to read', 'Asked to witness']);
  // The witness's own statement screen, just before, uses the same words (one name for one thing).
  assert.match(read('src/components/sign/Witness.tsx'), /<p className="sg-kicker">Asked to witness<\/p>/);
  // Measured in a browser at 390 x 844 (tests/out/finish-open-signing/screens.cjs): a group's member 113 words, 118
  // with a message; a witness 116, 118 with the message folded; an approver or a reader 99, 104; a one-time code 114,
  // 119; in person 117, 119 folded. Before: a group's member read 201 words before the tick, a witness 122.
  // A group: the "For" line names the group, and what agreeing does for the group comes after the tick, right above
  // Continue. The long explanation of how a group works stays in the email (groupInvite), not before the tick.
  // Since the 5 trees rule the top also carries the tree line, which is counted with the rest (ConsentTop.tsx).
  assert.match(consent, /<ConsentTop data=\{data\} ask=\{ask\} myEmail=\{myEmail\} trees=\{!ask \? <OpenTreesLine trees=\{env\.plants\} \/> : null\} \/>/);
  assert.match(read('src/components/sign/ConsentTop.tsx'), /\{group \|\| \(me\.link_by_sender/);
  const tick = consent.indexOf('<label className="check sg-agree">');
  const note = consent.indexOf('<GroupConsentNote data={data} />');
  const cont = consent.indexOf('sg-continue');
  assert.ok(tick > 0 && note > tick && cont > note, 'the group note sits between the tick and Continue');
  const group = read('src/components/sign/GroupNotice.tsx');
  assert.match(group, /export const groupFor = \(data: any\): string \| null => \{[\s\S]*?`For \$\{g\.name\}\.`/);
  const consentNote = group.slice(group.indexOf('export function GroupConsentNote'), group.indexOf('export const groupFor'));
  assert.doesNotMatch(consentNote, /groupInvite/, 'no paragraph about how groups work before the tick');
  assert.match(consentNote, /groupTakeOn\(g\.name, data\.recipient\.role\)/);
  // The words kept: each sentence is 20 words or fewer, and the email still explains the group in full.
  for (const s of groupTakeOn('Human Resources and Payroll', 'approver').split(/(?<=\.)\s+/)) assert.ok(s.split(/\s+/).length <= 20, s);
  assert.match(groupInvite('HR team', 3, 'signer'), /any one of you can sign it/);
  // The fold of the sender's message counts the screen up to the tick, so the group note after it no longer pushes
  // a message behind "Read the message" (SenderWords.tsx).
  assert.match(read('src/components/sign/SenderWords.tsx'), /range\.setEndBefore\(tick\.closest\('label'\) \|\| tick\)/);
});

test('a long subject, a long name or a message: the least useful words go first, and only as far as needed', async () => {
  const { consentFit, headingFor, splitAsk, FOLD_LINE_WORDS } = await import('../src/lib/consentfit.ts');
  // What the reviewer measured at 390 px: a 15-word subject and a 7-word name gave 128 words, 130 with a folded message.
  const long = { email: 1, words: 0, prefix: 2, forLine: 8 };
  assert.equal(consentFit(118, 120, long), 0, 'under the cap nothing goes');
  assert.equal(consentFit(120, 120, long), 0, 'at the cap nothing goes');
  assert.equal(consentFit(121, 120, long), 1, 'one over: only the address goes');
  assert.equal(consentFit(123, 120, long), 3, 'no message to fold: then "Please sign: "');
  assert.equal(consentFit(128, 120, long), 4, 'and then the For line');
  // The witness the reviewer saw: 122 with a 6-word message. The address alone does not do it; folding does, and the
  // heading and the For line stay.
  assert.equal(consentFit(122, 120, { email: 1, words: 6, prefix: 0, forLine: 4 }), 2);
  // A message that fits once the address is gone is not folded: dropping the address comes first.
  assert.equal(consentFit(121, 120, { email: 1, words: 30, prefix: 2, forLine: 4 }), 1);
  // Folding saves the message less the three words that stand for it.
  assert.equal(FOLD_LINE_WORDS, 3);
  assert.equal(consentFit(124, 120, { email: 1, words: 6, prefix: 0, forLine: 4 }), 2);
  assert.equal(consentFit(125, 120, { email: 1, words: 3, prefix: 2, forLine: 4 }), 4);
  // Nothing past step 4, however long the sender made it: our own legal text always stays.
  assert.equal(consentFit(500, 120, long), 4);

  // The heading: someone who approves, reads or witnesses never reads "Please sign:" under "Asked to approve".
  assert.equal(headingFor('Please sign: Planting partnership', true), 'Planting partnership');
  assert.equal(headingFor('please sign:   Planting partnership', true), 'Planting partnership');
  assert.equal(headingFor('Please sign: Planting partnership', false), 'Please sign: Planting partnership');
  assert.equal(headingFor('Please review the lease', true), 'Please review the lease', 'the sender\'s own words stay');
  assert.equal(headingFor('Please sign:', true), 'Please sign:', 'never an empty heading');
  assert.deepEqual(splitAsk('Please sign: Lease'), { prefix: 'Please sign: ', rest: 'Lease' });
  assert.deepEqual(splitAsk('Please sign the lease'), { prefix: '', rest: 'Please sign the lease' });
  assert.deepEqual(splitAsk('Please sign: '), { prefix: '', rest: 'Please sign: ' });

  // Where each rule is used: the consent screen, the witness's own screen and the bar over the document.
  const top = read('src/components/sign/ConsentTop.tsx');
  assert.match(top, /const heading = headingFor\(env\.subject, !!ask\);/);
  assert.match(top, /level < 1 \? <span data-fit="email">, \{myEmail\}<\/span> : null/);
  assert.match(top, /fold=\{level >= 2\}/);
  assert.match(top, /const plainFor = !group && !me\.link_by_sender;/, 'a group\'s For line and the handed-over note always stay');
  assert.match(read('src/components/sign/Witness.tsx'), /\{headingFor\(env\.subject, true\)\}/);
  // The bar over the document names it for everyone, never with "Please sign: " (build-simplicity-r6, barTitle).
  assert.match(read('src/components/sign/parts.tsx'), /const title = data\?\.envelope\?\.subject \? barTitle\(data\.envelope\.subject\) : 'GrowSigning';/);
});

test('the group note is tied to Continue for a screen reader, and the witness screen leaves out the default account name', async () => {
  const { orgOf } = await import('../src/lib/sendername.ts');
  // The witness's "Sent by" box follows the rule the consent screen and the email follow.
  assert.equal(orgOf("Rosa Gardener's workspace", 'Rosa Gardener'), '');
  assert.equal(orgOf('Acme Ltd', 'Rosa Gardener'), 'Acme Ltd');
  const parts = read('src/components/sign/parts.tsx');
  assert.match(parts, /\{orgOf\(brand\?\.name, s\.name\) && <div><dt>Account<\/dt><dd>\{orgOf\(brand\?\.name, s\.name\)\}<\/dd><\/div>\}/);
  assert.doesNotMatch(parts, /\{brand\?\.name && <div><dt>Account/);
  // Continue is described by the group's note exactly while the note is on the screen.
  const g = read('src/components/sign/GroupNotice.tsx');
  assert.match(g, /role="note" id=\{GROUP_NOTE_ID\}/);
  const page = read('src/app/sign/[token]/page.tsx');
  assert.match(page, /className="btn primary lg sg-continue" disabled=\{busy\} aria-describedby=\{groupNoteId\(data\)( \|\| delegateNoteId\(data\))?\}/);
});

// ---- 7. A deadline in the first invitation -------------------------------------------------------------------------

test('the first invitation names the deadline in the zone this address told the same sender before, and in UTC otherwise', async () => {
  const c = await signUp('Zoe Zones', 'zoe.zones@example.com', '198.51.130.10');
  const first = await simple(c, 'ravi.zone@example.com', { expire_days: 30 });
  assert.equal((await c.post(`/envelopes/${first.id}/send`)).status, 200);
  // Nobody has told us anything: UTC, and the email points to the signing page for the person's own time.
  const closes1 = (await c.get(`/envelopes/${first.id}`)).data.envelope.expires_at;
  assert.ok(mailTo('ravi.zone@example.com').at(-1)!.html.includes(`Open until ${momentText(closes1)}. The signing page shows your own time.`));
  // Ravi opens it in India.
  const rc = new Client();
  rc.ip = '198.51.130.11';
  assert.equal((await rc.post(`/sign/${tokenFor(first.id, 'ravi.zone@example.com')}/consent`, { tz: 'Asia/Kolkata' })).status, 200);

  // The next document from Zoe to the same address, written another way: his own time, the zone named, and still the
  // pointer to the signing page, because this document has not been told his zone yet.
  const second = await simple(c, 'Ravi.Zone@Example.com', { expire_days: 30 });
  assert.equal((await c.post(`/envelopes/${second.id}/send`)).status, 200);
  const closes2 = (await c.get(`/envelopes/${second.id}`)).data.envelope.expires_at;
  const inv = mailTo('Ravi.Zone@Example.com').at(-1) || mailTo('ravi.zone@example.com').at(-1)!;
  assert.ok(inv.html.includes(`Open until ${momentText(closes2, 'Asia/Kolkata')}. The signing page shows your own time.`), inv.html.slice(-900));
  assert.notEqual(momentText(closes2, 'Asia/Kolkata'), momentText(closes2), 'a different clock, the same moment');
  // The second document's own record is not given the zone: only his device sets it there.
  assert.equal(db.get('SELECT tz FROM recipients WHERE envelope_id=?', second.id).tz ?? null, null);

  // Another sender in the same account: when the document he opened was someone else's, Zoe's email is in UTC.
  const zoeId = db.get('SELECT sender_id FROM envelopes WHERE id=?', first.id).sender_id;
  db.run('UPDATE envelopes SET sender_id=? WHERE id=?', 'usr_a_colleague', first.id);
  const third = await simple(c, 'ravi.zone@example.com', { expire_days: 30 });
  assert.equal((await c.post(`/envelopes/${third.id}/send`)).status, 200);
  const closes3 = (await c.get(`/envelopes/${third.id}`)).data.envelope.expires_at;
  assert.ok(mailTo('ravi.zone@example.com').at(-1)!.html.includes(`Open until ${momentText(closes3)}. The signing page shows your own time.`), 'a colleague\'s record is not used');
  db.run('UPDATE envelopes SET sender_id=? WHERE id=?', zoeId, first.id);
  // And another account learns nothing either.
  const otherAcct = await signUp('Olu Other', 'olu.other@example.com', '198.51.130.12');
  const fourth = await simple(otherAcct, 'ravi.zone@example.com', { expire_days: 30 });
  assert.equal((await otherAcct.post(`/envelopes/${fourth.id}/send`)).status, 200);
  const closes4 = (await otherAcct.get(`/envelopes/${fourth.id}`)).data.envelope.expires_at;
  assert.ok(mailTo('ravi.zone@example.com').at(-1)!.html.includes(`Open until ${momentText(closes4)}. The signing page shows your own time.`), 'another account learns nothing');

  // In person the email goes to the host, so the signer's zone is never used for it.
  const walkIn = await simple(c, 'ravi.zone@example.com', { expire_days: 30, recipients: [{ id: 'r', role: 'inperson', name: 'Ravi Zone', email: 'ravi.zone@example.com' }] });
  assert.equal((await c.post(`/envelopes/${walkIn.id}/send`)).status, 200);
  const host = mailTo('zoe.zones@example.com').at(-1)!;
  assert.doesNotMatch(host.html, /Asia\/Kolkata|India/);
});

// ---- 8. The Settings section buttons --------------------------------------------------------------------------------

test('the tab buttons (Settings sections, Documents) are 44 px tall on every screen, not 43', () => {
  const css = read('src/app/globals.css');
  const rule = css.split('\n').find((l) => l.startsWith('.tabs button, .tabs a {'))!;
  assert.match(rule, /min-height: 44px;/);
  // The tab bar is a flex row, so the links in it take the height as well (measured at 1440, 390 and 320 in
  // tests/out/finish-open-signing/tabs.cjs: every Settings section and every Documents tab 44 px tall).
  assert.match(css, /\.tabs \{ display: flex;/);
});
