// The digital seal of a completed PDF (src/server/seal.ts, finalpipe.ts, sealpdf.ts, sealcms.ts, sealkey.ts, p12.ts,
// tsa.ts, der.ts): an invisible PAdES signature of the server over the whole file, checked here by poppler's pdfsig
// and by `openssl cms` and `openssl ts`, which share no code with ours (each test that needs one is skipped when
// it is not installed), and by pdf.js. Certificates and a time-stamp service are made in the test; nothing reaches
// the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { boot, signUp, simple, signAll, Client, type Server } from './helpers.ts';
import { makeCert, tsaAnswer, stubTsa, TIME_STAMPING, type Made } from './sealcerts.ts';

let s: Server;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-'));
const has = (bin: string) => {
  try {
    execFileSync(bin, ['-v'], { stdio: 'ignore' });
    return true;
  } catch (e: any) {
    return e?.code !== 'ENOENT';
  }
};
const PDFSIG = has('pdfsig');
const OPENSSL = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const PDFTOTEXT = has('pdftotext');

const SETTINGS = ['SEAL_P12', 'SEAL_P12_PASSWORD', 'SEAL_KEY_PEM', 'SEAL_CERT_PEM', 'SEAL_CHAIN_PEM', 'TSA_URL', 'TSA_URLS', 'TSA_USER', 'TSA_PASSWORD', 'TSA_TRUST'];
let seal: typeof import('../src/server/seal.ts');
let sealkey: typeof import('../src/server/sealkey.ts');
let pipe: typeof import('../src/server/finalpipe.ts');
let derMod: typeof import('../src/server/der.ts');
let root: Made, inter: Made, leaf: Made, tsaRoot: Made, tsa: Made;

function settings(env: Record<string, string>) {
  for (const k of SETTINGS) delete process.env[k];
  Object.assign(process.env, env);
  sealkey.forgetSealKey();
}
const write = (name: string, text: string | Buffer) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  return f;
};
const pemSettings = (cert: Made = leaf, chain: Made[] = [inter, root]) => ({ SEAL_KEY_PEM: write(`key-${cert.der.length}-${Math.random()}.pem`, cert.keyPem), SEAL_CERT_PEM: write(`cert-${Math.random()}.pem`, cert.pem), SEAL_CHAIN_PEM: write(`chain-${Math.random()}.pem`, chain.map((c) => c.pem).join('')) });

let n = 0;
/** One envelope, sent and signed by one person, so it completes. Returns its id and the stored signed PDF. */
async function complete(): Promise<{ id: string; pdf: Buffer; c: Client }> {
  n++;
  const c = await signUp(`Sealer ${n}`, `sealer${n}@example.com`, `198.51.100.${n}`);
  const e = await simple(c, `signer${n}@example.com`);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, `signer${n}@example.com`)).status, 200);
  const row = s.db.get('SELECT status, final_sha256 FROM envelopes WHERE id=?', e.id);
  assert.equal(row.status, 'completed');
  assert.ok(row.final_sha256, 'the signed PDF is made');
  return { id: e.id, pdf: s.db.readBlob(row.final_sha256), c };
}
const pdfsig = (file: string) => {
  try {
    return execFileSync('pdfsig', [file], { encoding: 'utf8' });
  } catch (e: any) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
};
const byteRange = (pdf: Buffer) => {
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(pdf.toString('latin1'));
  assert.ok(m, 'the file has a ByteRange');
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
};
const cmsOf = (pdf: Buffer) => {
  const r = byteRange(pdf);
  const der = Buffer.from(pdf.subarray(r[1] + 1, r[2] - 1).toString('latin1'), 'hex');
  return der.subarray(0, derMod.read(der).end);
};
const covered = (pdf: Buffer) => {
  const r = byteRange(pdf);
  return Buffer.concat([pdf.subarray(0, r[1]), pdf.subarray(r[2], r[2] + r[3])]);
};
const text = (pdf: Buffer) => {
  const f = write(`t-${Math.random()}.pdf`, pdf);
  return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
};

before(async () => {
  s = await boot();
  seal = await import('../src/server/seal.ts');
  sealkey = await import('../src/server/sealkey.ts');
  pipe = await import('../src/server/finalpipe.ts');
  derMod = await import('../src/server/der.ts');
  root = makeCert({ cn: 'Test Root CA', ca: true });
  inter = makeCert({ cn: 'Test Issuing CA', ca: true, issuer: root });
  leaf = makeCert({ cn: 'Example Operator Seal', issuer: inter });
  tsaRoot = makeCert({ cn: 'Test TSA Root', ca: true });
  tsa = makeCert({ cn: 'Test Time-Stamp Unit', issuer: tsaRoot, ku: 0xc0, eku: [TIME_STAMPING], ekuCritical: true });
});
after(() => {
  settings({});
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- With no settings, nothing changes -------------------------------------------------------

test('with no seal settings the signed PDF is byte for byte what the renderer made, and nothing is written down', async () => {
  settings({});
  const { id, pdf } = await complete();
  assert.ok(!pdf.toString('latin1').includes('/ByteRange'), 'no signature in the file');
  assert.ok(!pdf.toString('latin1').includes('/AcroForm'), 'no form added to the file');
  assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, null);
  assert.equal(s.db.get("SELECT COUNT(*) n FROM audit WHERE envelope_id=? AND action IN ('Digital seal applied', 'Not sealed')", id).n, 0);
  // finishPdf hands back exactly what the renderer made: the same bytes, untouched.
  const e = s.env.loadEnvelope(id);
  const fixed = await s.env.buildPdf(e, true);
  const out = await pipe.finishPdf(e, async () => fixed);
  assert.equal(out, fixed);
  if (PDFTOTEXT) assert.ok(!text(pdf).includes('Digital seal'), 'the certificate says nothing about a seal');
});

// ---- The seal --------------------------------------------------------------------------------

test('a completed PDF is sealed over the whole file: pdfsig and openssl both say it holds', async () => {
  settings(pemSettings());
  const { id, pdf } = await complete();
  const row = s.db.get('SELECT final_sha256, final_size, seal_level, seal_cert FROM envelopes WHERE id=?', id);
  // The stored fingerprint is of the sealed file, and the size too.
  assert.equal(crypto.createHash('sha256').update(pdf).digest('hex'), row.final_sha256);
  assert.equal(row.final_size, pdf.length);
  assert.equal(row.seal_level, 'B-B');
  assert.equal(row.seal_cert, crypto.createHash('sha256').update(leaf.der).digest('hex'));
  const r = byteRange(pdf);
  assert.equal(r[0], 0);
  assert.equal(r[2] + r[3], pdf.length, 'the ByteRange runs to the end of the file');
  assert.equal(pdf[r[1]], 0x3c);
  assert.equal(pdf[r[2] - 1], 0x3e, 'only the Contents value is left out');
  const t = pdf.toString('latin1');
  assert.match(t, /\/SubFilter \/ETSI\.CAdES\.detached/);
  assert.match(t, /\/M \(D:\d{14}Z\)/);
  assert.ok(!/\/Cert\b/.test(t), 'no Cert entry (PAdES)');
  assert.equal(s.db.get("SELECT COUNT(*) n FROM audit WHERE envelope_id=? AND action='Digital seal applied'", id).n, 1);
  if (PDFSIG) {
    const out = pdfsig(write('sealed.pdf', pdf));
    assert.match(out, /Signature Type: ETSI\.CAdES\.detached/);
    assert.match(out, /Total document signed/);
    assert.match(out, /Signature Validation: Signature is Valid\./);
    assert.match(out, /Example Operator Seal/);
  }
  if (OPENSSL) {
    const cms = write('seal.der', cmsOf(pdf));
    const content = write('covered.bin', covered(pdf));
    const ca = write('root.pem', root.pem);
    execFileSync('openssl', ['cms', '-verify', '-inform', 'DER', '-in', cms, '-binary', '-content', content, '-CAfile', ca, '-purpose', 'any', '-out', os.devNull], { stdio: 'pipe' });
    const printed = execFileSync('openssl', ['cms', '-cmsout', '-print', '-inform', 'DER', '-in', cms], { encoding: 'utf8' });
    assert.match(printed, /contentType \(1\.2\.840\.113549\.1\.9\.3\)|object: contentType/);
    assert.match(printed, /messageDigest/);
    assert.match(printed, /id-smime-aa-signingCertificateV2|1\.2\.840\.113549\.1\.9\.16\.2\.47/);
    assert.ok(!/signingTime/.test(printed), 'no signing-time attribute: the time is in /M');
    assert.match(printed, /eContent: <ABSENT>/, 'detached');
    assert.match(printed, /rsassaPss|RSASSA-PSS|1\.2\.840\.113549\.1\.1\.10/);
  }
  // pdf.js opens it and sees every page.
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise;
  assert.equal(doc.numPages, (await PDFDocument.load(pdf)).getPageCount());
  await doc.destroy();
  // The certificate of completion says what the seal is, in the file it seals.
  if (PDFTOTEXT) {
    const words = text(pdf);
    assert.match(words, /Digital seal/i);
    assert.match(words, /This file carries a digital seal applied by Example Operator Seal/);
    assert.match(words, /not a signature of the people who signed/);
    assert.match(words, /this server's clock/);
  }
});

test('one changed byte inside the sealed part breaks the seal; a byte added after it shows the seal no longer covers the file', async () => {
  settings(pemSettings());
  const { pdf } = await complete();
  const r = byteRange(pdf);
  const changed = Buffer.from(pdf);
  changed[Math.floor(r[1] / 2)] ^= 0x01;
  const check = seal.checkSeal(changed)!;
  assert.equal(check.intact, false);
  assert.match(check.why!, /does not match the file/);
  const appended = Buffer.concat([pdf, Buffer.from('\n% one more line\n')]);
  const a = seal.checkSeal(appended)!;
  assert.equal(a.intact, true, 'what the seal covers is unchanged');
  assert.equal(a.whole_file, false);
  assert.equal(a.sealed_part_sha256, crypto.createHash('sha256').update(pdf).digest('hex'));
  if (PDFSIG) {
    assert.doesNotMatch(pdfsig(write('changed.pdf', changed)), /Signature is Valid/);
    assert.match(pdfsig(write('appended.pdf', appended)), /Not total document signed/);
  }
  if (OPENSSL) {
    const cms = write('seal2.der', cmsOf(changed));
    const content = write('covered2.bin', covered(changed));
    assert.throws(() => execFileSync('openssl', ['cms', '-verify', '-inform', 'DER', '-in', cms, '-binary', '-content', content, '-CAfile', write('root2.pem', root.pem), '-purpose', 'any', '-out', os.devNull], { stdio: 'pipe' }));
  }
});

// ---- The key -----------------------------------------------------------------------------------

test('the key can come from a .p12 file, as OpenSSL 3 writes it and as older software wrote it (triple DES and RC2)', { skip: !OPENSSL && 'openssl is not installed' }, async () => {
  const k = write('p12-key.pem', leaf.keyPem);
  const c = write('p12-cert.pem', leaf.pem);
  const ch = write('p12-chain.pem', inter.pem + root.pem);
  for (const legacy of [false, true]) {
    const out = path.join(dir, `seal-${legacy}.p12`);
    execFileSync('openssl', ['pkcs12', '-export', ...(legacy ? ['-legacy'] : []), '-inkey', k, '-in', c, '-certfile', ch, '-out', out, '-passout', 'pass:p12 secret'], { stdio: 'pipe' });
    settings({ SEAL_P12: out, SEAL_P12_PASSWORD: 'p12 secret' });
    const st = sealkey.sealState();
    assert.ok(st.on, `the ${legacy ? 'legacy' : 'modern'} .p12 opens: ${(st as any).why}`);
    assert.equal(st.key.cert.name, 'Example Operator Seal');
    assert.deepEqual(st.key.chain.map((x) => x.name), ['Example Operator Seal', 'Test Issuing CA', 'Test Root CA']);
    const { pdf } = await complete();
    assert.ok(seal.checkSeal(pdf)!.intact);
    if (PDFSIG) assert.match(pdfsig(write(`p12-${legacy}.pdf`, pdf)), /Signature is Valid/);
    // A wrong password is said in words, and the file is made without a seal.
    settings({ SEAL_P12: out, SEAL_P12_PASSWORD: 'not it' });
    const bad = sealkey.sealState();
    assert.equal(bad.on, false);
    assert.match((bad as any).why, /password does not open this file/);
  }
});

test('an ECDSA P-256 key seals too, and pdfsig and openssl accept it', async () => {
  const ecRoot = makeCert({ cn: 'EC Root', ca: true, ec: true });
  const ecLeaf = makeCert({ cn: 'EC Operator Seal', issuer: ecRoot, ec: true });
  settings(pemSettings(ecLeaf, [ecRoot]));
  const st = sealkey.sealState();
  assert.ok(st.on);
  assert.equal(st.key.signer.scheme, 'ecdsa-p256');
  const { pdf } = await complete();
  assert.ok(seal.checkSeal(pdf)!.intact);
  if (PDFSIG) assert.match(pdfsig(write('ec.pdf', pdf)), /Signature is Valid/);
  if (OPENSSL) execFileSync('openssl', ['cms', '-verify', '-inform', 'DER', '-in', write('ec.der', cmsOf(pdf)), '-binary', '-content', write('ec.bin', covered(pdf)), '-CAfile', write('ecroot.pem', ecRoot.pem), '-purpose', 'any', '-out', os.devNull], { stdio: 'pipe' });
});

test('a key the seal must not use is refused: the file is made as before, the record says so, and the operators are told once', async () => {
  const other = makeCert({ cn: 'Someone Else', issuer: inter });
  const cases: [string, Record<string, string>, RegExp][] = [
    ['expired', pemSettings(makeCert({ cn: 'Old Seal', issuer: inter, from: new Date(Date.now() - 400 * 864e5), to: new Date(Date.now() - 864e5) })), /expired on/],
    ['not valid yet', pemSettings(makeCert({ cn: 'Future Seal', issuer: inter, from: new Date(Date.now() + 864e5) })), /not valid yet/],
    ['key usage', pemSettings(makeCert({ cn: 'CA Only Seal', issuer: inter, ku: 0x04 })), /neither digitalSignature nor nonRepudiation/],
    ['key and certificate', { ...pemSettings(), SEAL_KEY_PEM: write('other-key.pem', other.keyPem) }, /does not belong to the seal certificate/],
    ['chain missing', { ...pemSettings(), SEAL_CHAIN_PEM: write('no-chain.pem', root.pem) }, /is not given/],
    ['small RSA', pemSettings(makeCert({ cn: 'Small Seal', issuer: inter, key: crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey })), /2048 bits or more/],
    ['both kinds', { ...pemSettings(), SEAL_P12: write('x.p12', 'x') }, /Set one of the two/],
    ['unreadable file', { SEAL_KEY_PEM: path.join(dir, 'missing.pem'), SEAL_CERT_PEM: leaf.pem }, /cannot be read/],
  ];
  for (const [what, env, why] of cases) {
    settings(env);
    const st = sealkey.sealState();
    assert.equal(st.on, false, what);
    assert.match((st as any).why, why, what);
    const { id, pdf } = await complete();
    assert.ok(!pdf.toString('latin1').includes('/ByteRange'), `${what}: no seal`);
    if (PDFTOTEXT) assert.ok(!text(pdf).includes('Digital seal'), `${what}: the certificate does not speak of a seal`);
    const line = s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Not sealed'", id);
    assert.match(line.detail, /seal certificate cannot be used right now/, what);
    const alerts = s.db.all("SELECT message FROM support_requests WHERE message LIKE 'Completed PDFs are not being sealed%' AND message LIKE ?", `%${(st as any).why.slice(0, 40)}%`);
    assert.equal(alerts.length, 1, `${what}: one alert`);
  }
  // The same reason again files no second alert.
  settings(cases[0][1]);
  const before = s.db.get("SELECT COUNT(*) n FROM support_requests WHERE message LIKE 'Completed PDFs are not being sealed%'").n;
  sealkey.sealState();
  await complete();
  assert.equal(s.db.get("SELECT COUNT(*) n FROM support_requests WHERE message LIKE 'Completed PDFs are not being sealed%'").n, before);
});

// ---- The time-stamp (B-T) --------------------------------------------------------------------

const tokenOf = async (pdf: Buffer) => {
  const cms = await import('../src/server/sealcms.ts');
  const sd = cms.parseSignedData(cmsOf(pdf));
  const v = cms.attrValue(sd.signers[0].unsignedAttrs, cms.OID.signatureTimeStamp);
  return { token: v ? Buffer.from(derMod.whole(v)) : null, signature: sd.signers[0].signature };
};

test('with a time-stamp service the seal is B-T: the token is over the signature value and openssl verifies it', async () => {
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp', TSA_USER: 'seal-user', TSA_PASSWORD: 'tsa pass', TSA_TRUST: write('tsa-trust.pem', tsaRoot.pem) });
  const stub = stubTsa((req) => tsaAnswer(req, tsa, [tsaRoot]));
  try {
    const { id, pdf } = await complete();
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].auth, `Basic ${Buffer.from('seal-user:tsa pass').toString('base64')}`);
    assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, 'B-T');
    const check = seal.checkSeal(pdf)!;
    assert.equal(check.intact, true);
    assert.equal(check.level, 'B-T');
    assert.ok(check.timestamp_at);
    const { token, signature } = await tokenOf(pdf);
    assert.ok(token, 'the token is in the unsigned attributes');
    assert.match(s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Digital seal applied'", id).detail, /PAdES B-T, with a time-stamp from tsa\.test/);
    if (PDFTOTEXT) assert.match(text(pdf), /at level PAdES B-T.*carries a time-stamp from a time-stamp service/);
    if (PDFSIG) assert.match(pdfsig(write('bt.pdf', pdf)), /Signature is Valid/);
    if (OPENSSL) {
      const digest = crypto.createHash('sha256').update(signature).digest('hex');
      const out = execFileSync('openssl', ['ts', '-verify', '-in', write('token.der', token!), '-token_in', '-digest', digest, '-CAfile', write('tsaroot.pem', tsaRoot.pem)], { encoding: 'utf8', stdio: 'pipe' });
      assert.match(out, /Verification: OK/);
      // and it is not over anything else
      const other = crypto.createHash('sha256').update('another signature').digest('hex');
      assert.throws(() => execFileSync('openssl', ['ts', '-verify', '-in', write('token2.der', token!), '-token_in', '-digest', other, '-CAfile', write('tsaroot2.pem', tsaRoot.pem)], { stdio: 'pipe' }));
    }
  } finally {
    stub.restore();
  }
});

test('a time-stamp that does not check out is never used: the seal goes out at B-B at once, and the certificate and the record say so', async () => {
  const otherRoot = makeCert({ cn: 'Unrelated Root', ca: true });
  const noEku = makeCert({ cn: 'Not A TSA', issuer: tsaRoot });
  const bad: [string, (req: Buffer) => Buffer | number, Record<string, string>, RegExp][] = [
    ['refused', (req) => tsaAnswer(req, tsa, [tsaRoot], { status: 2 }), {}, /refused \(status 2\)/],
    ['old answer', (req) => tsaAnswer(req, tsa, [tsaRoot], { nonce: 12345n }), {}, /nonce/],
    ['other imprint', (req) => tsaAnswer(req, tsa, [tsaRoot], { imprint: crypto.randomBytes(32) }), {}, /not over our signature/],
    ['server error', () => 503, {}, /HTTP 503/],
    ['garbage', () => Buffer.from('<html>hello</html>'), {}, /not a time-stamp this server can read|could not be checked/],
    ['not a TSA certificate', (req) => tsaAnswer(req, noEku, [tsaRoot]), {}, /not meant for time-stamping/],
    ['outside the trust list', (req) => tsaAnswer(req, tsa, [tsaRoot]), { TSA_TRUST: write('other-trust.pem', otherRoot.pem) }, /does not lead to one in TSA_TRUST/],
  ];
  for (const [what, answer, extra, why] of bad) {
    settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp', ...extra });
    const stub = stubTsa(answer);
    try {
      const { id, pdf } = await complete();
      assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, 'B-B', what);
      const check = seal.checkSeal(pdf)!;
      assert.equal(check.intact, true, what);
      assert.equal(check.level, 'B-B', what);
      assert.equal((await tokenOf(pdf)).token, null, `${what}: no token in the file`);
      const line = s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Digital seal applied'", id).detail;
      assert.match(line, /B-B/, what);
      assert.match(line, why, what);
      if (PDFTOTEXT) assert.match(text(pdf), /time-stamp service could not give a time-stamp|did not answer/, what);
      // Nobody waits: the signed PDF was there when the envelope completed.
      assert.ok(s.db.get('SELECT final_sha256 FROM envelopes WHERE id=?', id).final_sha256);
    } finally {
      stub.restore();
    }
  }
});

test('several services are tried in order; the first that answers well gives the time-stamp', async () => {
  settings({ ...pemSettings(), TSA_URL: 'https://down.test/ts, https://tsa.test/stamp' });
  const stub = stubTsa((req, url) => (url.includes('down.test') ? 500 : tsaAnswer(req, tsa, [tsaRoot])));
  try {
    const { id } = await complete();
    assert.deepEqual(stub.calls.map((c) => new URL(c.url).host), ['down.test', 'tsa.test']);
    assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, 'B-T');
  } finally {
    stub.restore();
  }
});

test('a service that never answers is given up after 10 seconds, and all of them together after 20: the seal goes out at B-B', async () => {
  settings({ ...pemSettings(), TSA_URL: 'https://slow.test/ts,https://slower.test/ts,https://never.test/ts' });
  const stub = stubTsa(() => 'hang');
  try {
    const t0 = Date.now();
    const { id } = await complete();
    const took = Date.now() - t0;
    assert.ok(took >= 19_000 && took < 30_000, `the last Finish waited ${took} ms for time-stamps`);
    assert.deepEqual(stub.calls.map((c) => new URL(c.url).host), ['slow.test', 'slower.test'], 'the third is not asked once the 20 seconds are used up');
    assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, 'B-B');
    const line = s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Digital seal applied'", id).detail;
    assert.match(line, /slow\.test: it did not answer within 10 seconds/);
    assert.match(line, /never\.test\/ts: not asked, because the 20 seconds for time-stamps were used up/);
  } finally {
    stub.restore();
  }
});

// ---- /verify ---------------------------------------------------------------------------------

const verify = async (pdf: Uint8Array, ip = '192.0.2.77') => {
  const c = new Client();
  c.ip = ip;
  const f = new FormData();
  f.append('file', new Blob([pdf], { type: 'application/pdf' }), 'x.pdf');
  const r = await c.call('POST', '/public/verify', f);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

test('/verify matches the sealed file byte for byte and also says its seal holds; a changed or added-to file is told apart', async () => {
  settings(pemSettings());
  const { id, pdf } = await complete();
  const ok = await verify(pdf);
  assert.equal(ok.match, true, 'the stored SHA-256 is of the sealed file');
  assert.equal(ok.envelope.id, id);
  assert.equal(ok.hash, crypto.createHash('sha256').update(pdf).digest('hex'));
  assert.deepEqual({ intact: ok.seal.intact, whole: ok.seal.whole_file, ours: ok.seal.ours, level: ok.seal.level, name: ok.seal.name }, { intact: true, whole: true, ours: true, level: 'B-B', name: 'Example Operator Seal' });
  assert.ok(ok.seal.sealed_at);
  // A PDF reader saved something into it afterwards: no byte-for-byte match, but the sealed part is that document.
  const added = Buffer.concat([pdf, Buffer.from('\n9999 0 obj\n<< /Note (added later) >>\nendobj\n')]);
  const a = await verify(added);
  assert.equal(a.match, false);
  assert.equal(a.seal.intact, true);
  assert.equal(a.seal.whole_file, false);
  assert.equal(a.seal.sealed_part.envelope_id, id);
  // One byte changed inside: no match, and the seal does not hold.
  const r = byteRange(pdf);
  const changed = Buffer.from(pdf);
  changed[r[1] - 20] ^= 0x20;
  const b = await verify(changed);
  assert.equal(b.match, false);
  assert.equal(b.seal.intact, false);
  assert.equal(b.seal.sealed_part, null);
  assert.match(b.seal.why, /does not match the file/);
  // A file with no seal: "seal" is null, and the answer is as it always was.
  settings({});
  const plain = await complete();
  const p = await verify(plain.pdf);
  assert.equal(p.match, true);
  assert.equal(p.seal, null);
});

test('a seal made with another certificate is not called ours; one made with an earlier key of this server still is', async () => {
  const stranger = makeCert({ cn: 'Stranger Seal', issuer: inter });
  settings(pemSettings(stranger));
  const plan = seal.sealPlan()!;
  const d = await PDFDocument.create();
  d.addPage().drawText('Sealed somewhere else', { x: 50, y: 700 });
  const theirs = await seal.sealPdf(await d.save(), plan);
  // An earlier key of ours: an envelope sealed with it, then the key is changed.
  const earlier = makeCert({ cn: 'Earlier Operator Seal', issuer: inter });
  settings(pemSettings(earlier));
  const old = await complete();
  settings(pemSettings());
  const v1 = await verify(theirs.bytes);
  assert.equal(v1.match, false);
  assert.equal(v1.seal.intact, true);
  assert.equal(v1.seal.ours, false);
  const v2 = await verify(old.pdf);
  assert.equal(v2.match, true);
  assert.equal(v2.seal.ours, true);
  assert.equal(v2.seal.name, 'Earlier Operator Seal');
});

// ---- What is never sealed ------------------------------------------------------------------

test('an envelope completed before the seal was set up is never sealed afterwards: its fingerprint stays the one people were emailed', async () => {
  settings({});
  const { id, pdf } = await complete();
  const sha = s.db.get('SELECT final_sha256 FROM envelopes WHERE id=?', id).final_sha256;
  const mailed = s.db.all("SELECT html FROM emails WHERE subject LIKE 'Completed:%' AND html LIKE ?", `%${sha}%`);
  assert.ok(mailed.length >= 1, 'the fingerprint went out in the completion email');
  settings(pemSettings());
  assert.equal(await s.env.buildFinal(id), true);
  assert.equal(s.db.get('SELECT final_sha256 FROM envelopes WHERE id=?', id).final_sha256, sha);
  assert.deepEqual(s.env.finalPdf(s.env.loadEnvelope(id)), pdf);
  await s.cron.tick?.();
  assert.equal(s.db.get('SELECT final_sha256, seal_level FROM envelopes WHERE id=?', id).final_sha256, sha);
  assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, null);
});

test('a voided envelope is not an agreement: a signer\'s copy of it carries no seal, and its first page says so', async () => {
  settings(pemSettings());
  n++;
  const c = await signUp(`Voider ${n}`, `voider${n}@example.com`, `198.51.100.${n}`);
  const file = await (await import('./helpers.ts')).upload(c, 1);
  const r = await c.post('/envelopes', {
    subject: 'Two people',
    documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'a', role: 'signer', name: 'Ann First', email: `ann${n}@example.com`, routing_order: 1 }, { id: 'b', role: 'signer', name: 'Bo Second', email: `bo${n}@example.com`, routing_order: 2 }],
    fields: [{ id: 'f1', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'f2', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }],
    ordered: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.envelope.id;
  assert.equal((await c.post(`/envelopes/${id}/send`)).status, 200);
  assert.equal((await signAll(id, `ann${n}@example.com`)).status, 200);
  assert.equal((await c.post(`/envelopes/${id}/void`, { reason: 'Wrong terms' })).status, 200);
  const tok = s.db.get('SELECT token FROM recipients WHERE envelope_id=? AND email=?', id, `ann${n}@example.com`).token;
  const dl = await new Client().get(`/sign/${tok}/download`);
  assert.equal(dl.status, 200);
  const copy = Buffer.from(dl.data);
  assert.ok(!copy.toString('latin1').includes('/ByteRange'), 'no seal on a voided copy');
  assert.equal(seal.checkSeal(copy), null);
  if (PDFTOTEXT) assert.match(text(copy), /carries no digital seal/);
});

test('an uploaded PDF that already carries signatures is said to lose them in the signed copy, by the API and the editor', async () => {
  settings(pemSettings());
  const { pdf } = await complete();
  n++;
  const c = await signUp(`Uploader ${n}`, `uploader${n}@example.com`, `198.51.100.${n}`);
  const up = async (bytes: Uint8Array) => {
    const f = new FormData();
    f.append('file', new Blob([bytes], { type: 'application/pdf' }), 'Signed elsewhere.pdf');
    const r = await c.call('POST', '/files', f);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const signed = await up(pdf);
  assert.equal(signed.existing_signatures, 1);
  assert.match(signed.existing_signatures_note, /already carries a digital signature\. It does not survive here/);
  const plain = await up(await (await import('./helpers.ts')).samplePdf(1));
  assert.equal(plain.existing_signatures, undefined);
  assert.equal(plain.existing_signatures_note, undefined);
  // The signed copy made from it indeed has no signature of its own left, only ours.
  assert.equal(await seal.existingSignatures(await s.env.buildPdf({ ...s.env.loadEnvelope((await simple(c, `x${n}@example.com`, { documents: [{ id: 'd', file_id: signed.id }] })).id) }, false)), 0);
});

// ---- Attacks -----------------------------------------------------------------------------------

test('a crafted file never trips /verify: a fake seal is "damaged", a stranger with our certificate\'s name is not ours, and the reason says it is no person\'s signature', async () => {
  settings(pemSettings());
  const { pdf } = await complete();
  assert.match(pdf.toString('latin1'), /\/Reason \(Sealed by the server when the document was completed\. Not a signature of a person who signed\.\)/);
  // The Contents replaced by noise of the same length.
  const r = byteRange(pdf);
  const noise = Buffer.from(pdf);
  noise.write(crypto.randomBytes((r[2] - r[1] - 2) / 2).toString('hex'), r[1] + 1, 'latin1');
  const v = await verify(noise, '192.0.2.88');
  assert.equal(v.match, false);
  assert.equal(v.seal.intact, false);
  assert.match(v.seal.why, /damaged|does not/);
  // A ByteRange that points outside the file is not taken for a seal at all.
  const wild = Buffer.from(pdf.toString('latin1').replace(/\/ByteRange \[[^\]]*\]/, (m) => '/ByteRange [0 10 99999999 5]'.padEnd(m.length, ' ')), 'latin1');
  assert.equal(seal.checkSeal(wild), null);
  // The same name on a certificate of someone else's (self-signed here) is not ours.
  const self = makeCert({ cn: 'Example Operator Seal' });
  settings({ SEAL_KEY_PEM: write('self-key.pem', self.keyPem), SEAL_CERT_PEM: write('self-cert.pem', self.pem) });
  const plan = seal.sealPlan()!;
  assert.ok(plan, 'a self-signed certificate is accepted for sealing (Acrobat then says the validity is unknown)');
  const d = await PDFDocument.create();
  d.addPage().drawText('Not from us', { x: 50, y: 700 });
  const fake = await seal.sealPdf(await d.save(), plan);
  settings(pemSettings());
  const f = await verify(fake.bytes, '192.0.2.89');
  assert.equal(f.seal.intact, true);
  assert.equal(f.seal.name, 'Example Operator Seal');
  assert.equal(f.seal.ours, false, 'the name alone does not make a seal ours');
});

test('key material pasted into a setting is never repeated in a log line, the record or the operators\' alert', async () => {
  const secretish = leaf.keyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  settings({ SEAL_KEY_PEM: secretish, SEAL_CERT_PEM: leaf.pem });
  const st = sealkey.sealState();
  assert.equal(st.on, false);
  assert.match((st as any).why, /neither a path to a file nor PEM text/);
  assert.ok(!(st as any).why.includes(secretish.slice(0, 40)));
  assert.equal(s.db.get('SELECT COUNT(*) n FROM support_requests WHERE message LIKE ?', `%${secretish.slice(0, 40)}%`).n, 0);
});

test('the seal is appended to any file the renderer may make: a form already in it, a classic cross-reference table, several pages', async () => {
  settings(pemSettings());
  const plan = seal.sealPlan()!;
  for (const objectStreams of [true, false]) {
    const d = await PDFDocument.create();
    for (let i = 0; i < 3; i++) d.addPage().drawText(`Page ${i + 1}`, { x: 50, y: 700 });
    d.getForm().createTextField('kept.field').addToPage(d.getPage(0), { x: 50, y: 600, width: 200, height: 20 });
    const before = Buffer.from(await d.save({ useObjectStreams: objectStreams }));
    const { bytes } = await seal.sealPdf(before, plan);
    assert.ok(bytes.subarray(0, before.length).equals(before), 'not one byte of the rendered file changes: the seal is appended');
    const back = await PDFDocument.load(bytes);
    assert.equal(back.getPageCount(), 3);
    const names = back.getForm().getFields().map((f) => f.getName()).sort();
    assert.deepEqual(names, ['Seal', 'kept.field'], 'the form keeps its field and gains the seal');
    assert.equal(seal.checkSeal(bytes)!.intact, true);
    if (PDFSIG) {
      const out = pdfsig(write(`form-${objectStreams}.pdf`, bytes));
      assert.match(out, /Total document signed/);
      assert.match(out, /Signature is Valid/);
    }
  }
});
