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
    ['garbage', () => Buffer.from('<html>hello</html>'), {}, /cannot read|could not be checked/],
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

test('a service that never answers is given up after 10 seconds, and the seal goes out at B-B', async () => {
  settings({ ...pemSettings(), TSA_URL: 'https://slow.test/ts' });
  const stub = stubTsa(() => 'hang');
  try {
    const t0 = Date.now();
    const { id } = await complete();
    assert.ok(Date.now() - t0 >= 9_500, 'it waited for the timeout');
    assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, 'B-B');
    assert.match(s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Digital seal applied'", id).detail, /did not answer within 10 seconds/);
  } finally {
    stub.restore();
  }
});
