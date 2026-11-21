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
  assert.equal(s.db.get("SELECT COUNT(*) n FROM audit WHERE envelope_id=? AND (action LIKE 'Sealed by %' OR action='Not sealed')", id).n, 0);
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
  assert.equal(s.db.get("SELECT COUNT(*) n FROM audit WHERE envelope_id=? AND action LIKE 'Sealed by %'", id).n, 1);
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
    assert.match(words, /The signed PDF this certificate closes carries a digital seal applied by Example Operator Seal/);
    assert.doesNotMatch(words, /PAdES|B-B|B-T/, 'no technical names on the certificate');
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
  const check = (await seal.checkSeal(changed))!;
  assert.equal(check.intact, false);
  assert.match(check.why!, /does not match the file/);
  const appended = Buffer.concat([pdf, Buffer.from('\n% one more line\n')]);
  const a = (await seal.checkSeal(appended))!;
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
    assert.ok((await seal.checkSeal(pdf))!.intact);
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
  assert.ok((await seal.checkSeal(pdf))!.intact);
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
    const check = (await seal.checkSeal(pdf))!;
    assert.equal(check.intact, true);
    assert.equal(check.level, 'B-T');
    assert.ok(check.timestamp_at);
    const { token, signature } = await tokenOf(pdf);
    assert.ok(token, 'the token is in the unsigned attributes');
    assert.match(s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action LIKE 'Sealed by %'", id).detail, /trusted time stamp from tsa\.test/);
    if (PDFTOTEXT) assert.match(text(pdf), /The seal carries a trusted time stamp from a time-stamp service/);
    assert.equal(s.db.get('SELECT seal_tsa FROM envelopes WHERE id=?', id).seal_tsa, 'trusted');
    assert.ok(check.timestamp_at, 'with TSA_TRUST the time of the time stamp is shown');
    assert.equal(check.timestamp_unchecked, false);
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
  // A service of its own making that lies about the time: its certificate has the right purpose and covers 2011.
  const liar = makeCert({ cn: 'Liar TSA', ku: 0xc0, eku: [TIME_STAMPING], ekuCritical: true, from: new Date('2000-01-01'), to: new Date('2040-01-01') });
  const bad: [string, (req: Buffer) => Buffer | number, Record<string, string>, RegExp][] = [
    ['refused', (req) => tsaAnswer(req, tsa, [tsaRoot], { status: 2 }), {}, /refused \(status 2\)/],
    ['old answer', (req) => tsaAnswer(req, tsa, [tsaRoot], { nonce: 12345n }), {}, /nonce/],
    ['other imprint', (req) => tsaAnswer(req, tsa, [tsaRoot], { imprint: crypto.randomBytes(32) }), {}, /not over our signature/],
    ['server error', () => 503, {}, /HTTP 503/],
    ['garbage', () => Buffer.from('<html>hello</html>'), {}, /not a time-stamp this server can read|could not be checked/],
    ['a time years off', (req) => tsaAnswer(req, liar, [], { time: new Date('2011-01-01T00:00:00Z') }), {}, /the time it gives \(2011-01-01T00:00:00\.000Z\) is more than 5 minutes from this server's clock/],
    ['a time ten minutes ahead', (req) => tsaAnswer(req, tsa, [tsaRoot], { time: new Date(Date.now() + 10 * 60_000) }), { TSA_TRUST: write('trust-ahead.pem', tsaRoot.pem) }, /more than 5 minutes from this server's clock/],
    ['not a TSA certificate', (req) => tsaAnswer(req, noEku, [tsaRoot]), {}, /not meant for time-stamping/],
    ['outside the trust list', (req) => tsaAnswer(req, tsa, [tsaRoot]), { TSA_TRUST: write('other-trust.pem', otherRoot.pem) }, /does not lead to one in TSA_TRUST/],
  ];
  for (const [what, answer, extra, why] of bad) {
    settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp', ...extra });
    const stub = stubTsa(answer);
    try {
      const { id, pdf } = await complete();
      assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, 'B-B', what);
      const check = (await seal.checkSeal(pdf))!;
      assert.equal(check.intact, true, what);
      assert.equal(check.level, 'B-B', what);
      assert.equal((await tokenOf(pdf)).token, null, `${what}: no token in the file`);
      const line = s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action LIKE 'Sealed by %'", id).detail;
      assert.match(line, /The time in the seal is this server's clock/, what);
      assert.match(line, why, what);
      if (PDFTOTEXT) assert.match(text(pdf), /time-stamp service could not give a time stamp|did not answer/, what);
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

test('a service that never answers is given up after 3 seconds, and all of them together after 4, so the last signer never waits long: the seal goes out at B-B', async () => {
  settings({ ...pemSettings(), TSA_URL: 'https://slow.test/ts,https://slower.test/ts,https://never.test/ts' });
  const stub = stubTsa(() => 'hang');
  try {
    const t0 = Date.now();
    const { id } = await complete();
    const took = Date.now() - t0;
    assert.ok(took >= 3_500 && took < 9_000, `the last Finish waited ${took} ms for time-stamps`);
    assert.deepEqual(stub.calls.map((c) => new URL(c.url).host), ['slow.test', 'slower.test'], 'the third is not asked once the 4 seconds are used up');
    assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, 'B-B');
    const line = s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action LIKE 'Sealed by %'", id).detail;
    assert.match(line, /slow\.test: it did not answer within 3 seconds/);
    assert.match(line, /never\.test: not asked, because the 4 seconds for time-stamps were used up/);
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
  assert.equal(await seal.checkSeal(copy), null);
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
  assert.match(v.seal.why, /damaged|does not|not part of the seal/);
  // A ByteRange that points outside the file: the seal is said not to hold.
  const wild = Buffer.from(pdf.toString('latin1').replace(/\/ByteRange \[[^\]]*\]/, (m) => '/ByteRange [0 10 99999999 5]'.padEnd(m.length, ' ')), 'latin1');
  const w = (await seal.checkSeal(wild))!;
  assert.equal(w.intact, false, 'a seal whose range does not fit the file is never said to hold');
  assert.equal(w.whole_file, false);
  assert.match(w.why!, /not where it is/);
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
    assert.equal((await seal.checkSeal(bytes))!.intact, true);
    if (PDFSIG) {
      const out = pdfsig(write(`form-${objectStreams}.pdf`, bytes));
      assert.match(out, /Total document signed/);
      assert.match(out, /Signature is Valid/);
    }
  }
});

test('the screens: the history line says "Sealed by <name>" in plain words, the page of the document and the admins\' status line say the same, and nothing shows without settings', async () => {
  // No settings: no status line, no "seal" on the page of a completed document.
  settings({});
  const plain = await complete();
  assert.deepEqual((await plain.c.get('/seal')).data, { set: false });
  assert.equal((await plain.c.get(`/envelopes/${plain.id}`)).data.seal, null);

  settings(pemSettings());
  const { id, c } = await complete();
  const page = (await c.get(`/envelopes/${id}`)).data;
  assert.deepEqual(page.seal, { by: 'Example Operator Seal', issuer: 'Test Issuing CA', time_stamp: false, time_stamp_trusted: false });
  const line = page.audit.find((a: any) => a.action === 'Sealed by Example Operator Seal');
  assert.ok(line, 'one history line, in the words of the charter');
  assert.equal(page.audit.filter((a: any) => /^Sealed by /.test(a.action)).length, 1);
  // The sender's daily path carries no technical names (charter P6).
  assert.doesNotMatch(`${line.action} ${line.detail}`, /PAdES|PKI|CMS|RFC ?3161|B-B|B-T/);
  assert.match(line.detail, /A PDF reader shows if the file changed after this/);
  assert.equal(page.chain.ok, true, 'the line is part of the chained record');
  // The earlier, unsealed one still says nothing, also now that a seal is set.
  assert.equal((await plain.c.get(`/envelopes/${plain.id}`)).data.seal, null);

  // The status line: for admins only, and never the reason a key is refused (it can name files on the server).
  const st = (await c.get('/seal')).data;
  assert.equal(st.set, true);
  assert.equal(st.on, true);
  assert.equal(st.by, 'Example Operator Seal');
  assert.equal(st.issuer, 'Test Issuing CA');
  assert.equal(st.time_stamp, false);
  assert.ok(Date.parse(st.until) > Date.now());
  const router = await import('../src/server/router.ts');
  assert.equal((await router.handle(new Request('http://test.local/api/seal'))).status, 401);
  const lv = router.listRoutes().find((r: any) => r.path === '/seal');
  assert.equal(lv?.level, 'admin');
  settings({ SEAL_KEY_PEM: '/nowhere/secret-place/key.pem', SEAL_CERT_PEM: '/nowhere/cert.pem' });
  const off = (await c.get('/seal')).data;
  assert.deepEqual(off, { set: true, on: false });
  assert.ok(!JSON.stringify(off).includes('nowhere'));
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/key-in-the-path' });
  assert.equal((await c.get('/seal')).data.time_stamp, true);
  assert.ok(!JSON.stringify((await c.get('/seal')).data).includes('key-in-the-path'));
});

// ---- Repairs: forged files, time stamps nobody checked, the certificate on its own -----------------------------

/** The seal's own bytes in a sealed file: [start of "<", end after ">"], the hex of the CMS without its padding. */
const parts = (pdf: Buffer) => {
  const [, a, b] = byteRange(pdf);
  return { a, b, P: pdf.subarray(0, a), S: pdf.subarray(b), cmsHex: pdf.subarray(a + 1, b - 1).toString('latin1').replace(/(00)+$/, '') };
};
const EVIL = (() => {
  const st = 'BT /F1 26 Tf 40 700 Td (FORGED: pay 1,000,000 to Mallory) Tj ET';
  return `\n9990 0 obj\n<< /Length ${st.length} >>\nstream\n${st}\nendstream\nendobj\n9992 0 obj\n<< /Type /Page /Parent 9993 0 R /MediaBox [0 0 612 792] /Contents 9990 0 R >>\nendobj\n9993 0 obj\n<< /Type /Pages /Kids [9992 0 R] /Count 1 >>\nendobj\n9994 0 obj\n<< /Type /Catalog /Pages 9993 0 R >>\nendobj\ntrailer\n<< /Root 9994 0 R /Size 9995 >>\n`;
})();

test('forged: a file put together around a real seal (the seal moved, other pages put in its place) is never said to hold', async () => {
  settings(pemSettings());
  const { pdf } = await complete();
  const { a, b, P, S, cmsHex } = parts(pdf);
  const PS = Buffer.concat([P, S]);
  // 1. The seal cut out and put back near the end with other objects and a second /ByteRange that names the new place.
  const x = PS.lastIndexOf('startxref');
  let gap = '';
  for (let i = 0; i < 6; i++) {
    const g = `<${cmsHex}>${EVIL}<< /SubFilter /ETSI.CAdES.detached /ByteRange [0 ${x} ${String(x + gap.length).padStart(12, ' ')} ${PS.length - x}] >`;
    if (g.length === gap.length) {
      gap = g;
      break;
    }
    gap = g;
  }
  const moved = Buffer.concat([PS.subarray(0, x), Buffer.from(gap, 'latin1'), PS.subarray(x)]);
  // What the seal covers is, byte for byte, what it covered: the old check said "holds, whole file, ours".
  assert.equal(crypto.createHash('sha256').update(Buffer.concat([moved.subarray(0, x), moved.subarray(x + gap.length)])).digest('hex'), crypto.createHash('sha256').update(PS).digest('hex'));
  const m = (await seal.checkSeal(moved))!;
  assert.ok(m, 'the file is said to name a seal');
  assert.equal(m.intact, false);
  assert.equal(m.whole_file, false);
  assert.match(m.why!, /not where it is|not part of the seal/);
  const v = await verify(moved, '192.0.2.90');
  assert.equal(v.match, false);
  assert.equal(v.seal.intact, false, '/verify never vouches for it');

  // 2. Other bytes hidden in the seal's own place, after the seal's data (same length as before).
  const junk = `>${EVIL}`.padEnd(b - a - 2 - cmsHex.length, ' ');
  const inplace = Buffer.concat([pdf.subarray(0, a + 1), Buffer.from(cmsHex + junk, 'latin1'), pdf.subarray(b - 1)]);
  assert.equal(inplace.length, pdf.length);
  const i2 = (await seal.checkSeal(inplace))!;
  assert.equal(i2.intact, false);
  assert.match(i2.why!, /not part of the seal/);
  // 3. Hex digits that are not zeros after the seal's data: still nothing but the seal may sit there.
  const tail = 'ab'.repeat((b - a - 2 - cmsHex.length) / 2);
  const padded = Buffer.concat([pdf.subarray(0, a + 1), Buffer.from(cmsHex + tail, 'latin1'), pdf.subarray(b - 1)]);
  assert.equal((await seal.checkSeal(padded))!.intact, false);
  // 4. Whitespace in the hex (a PDF reader would skip it, and so could hide a shift): refused as well.
  const spaced = Buffer.from(pdf);
  spaced[b - 3] = 0x20;
  assert.equal((await seal.checkSeal(spaced))!.intact, false);
  // 5. A real seal lifted into another file, whose own bytes it does not cover.
  const other = await PDFDocument.create();
  other.addPage().drawText('Another agreement altogether', { x: 50, y: 700 });
  const lifted = Buffer.concat([Buffer.from(await other.save()), Buffer.from(`\n77 0 obj\n<< /Type /Sig /SubFilter /ETSI.CAdES.detached /ByteRange [0 ${a} ${b} ${pdf.length - b}] /Contents <${cmsHex}> >>\nendobj\n`, 'latin1')]);
  const l = (await seal.checkSeal(lifted))!;
  assert.equal(l.intact, false);
  // 6. The words "/ByteRange [..]" in a file with no seal dictionary at all say nothing about a seal.
  const words = await PDFDocument.create();
  words.addPage();
  words.setTitle('/ByteRange [0 10 20 30]');
  assert.equal(await seal.checkSeal(Buffer.concat([Buffer.from(await words.save({ useObjectStreams: false })), Buffer.from('\n% /ByteRange [0 10 20 30]\n')])), null);
  // And the true file still holds, also for poppler.
  const t = (await seal.checkSeal(pdf))!;
  assert.deepEqual([t.intact, t.whole_file, t.ours], [true, true, true]);
  if (PDFSIG) assert.doesNotMatch(pdfsig(write('moved.pdf', moved)), /Signature is Valid/);
});

test('a seal a PDF reader would not find is not said to hold over the whole file', async () => {
  settings(pemSettings());
  const { pdf } = await complete();
  // The field is taken out of the form and off the page by turning the two names into others of the same length
  // INSIDE the seal's range would break the fingerprint, so this can only be done by changing covered bytes: it must fail.
  const text = pdf.toString('latin1');
  const hidden = Buffer.from(text.replace('/FT /Sig', '/FT /Btn'), 'latin1');
  assert.equal(hidden.length, pdf.length);
  const h = (await seal.checkSeal(hidden))!;
  assert.equal(h.intact, false);
});

/** Puts a time-stamp token into the unsigned attributes of the seal of `pdf`, as a stranger with a hex editor could. */
function addToken(pdf: Buffer, tokenAnswer: (req: Buffer) => Buffer, tsaMod: typeof import('../src/server/tsa.ts'), cms: typeof import('../src/server/sealcms.ts')): Buffer {
  const { a, b } = parts(pdf);
  const raw = Buffer.from(pdf.subarray(a + 1, b - 1).toString('latin1'), 'hex');
  const ci = derMod.read(raw);
  const sd = cms.parseSignedData(raw.subarray(0, ci.end));
  const imprint = crypto.createHash('sha256').update(sd.signers[0].signature).digest();
  const ans = tokenAnswer(tsaMod.timeStampRequest(imprint, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])));
  const token = Buffer.from(derMod.whole(derMod.kids(derMod.read(ans))[1]));
  const top = derMod.kids(ci);
  const sdNode = derMod.kids(derMod.kids(top[1])[0]);
  const si = derMod.kids(sdNode[sdNode.length - 1])[0];
  const newSi = derMod.seq(derMod.content(si), derMod.tagged(1, cms.signatureTimeStampAttribute(token)));
  const newSd = derMod.seq(...sdNode.slice(0, -1).map((k) => derMod.whole(k)), derMod.tlv(0x31, newSi));
  const hex = derMod.seq(derMod.whole(top[0]), derMod.tagged(0, newSd)).toString('hex').padEnd(b - a - 2, '0');
  assert.equal(hex.length, b - a - 2);
  return Buffer.concat([pdf.subarray(0, a + 1), Buffer.from(hex, 'latin1'), pdf.subarray(b - 1)]);
}

test('a time stamp a stranger adds to our seal afterwards is never shown as a time, and never called trusted', async () => {
  const tsaMod = await import('../src/server/tsa.ts');
  const cms = await import('../src/server/sealcms.ts');
  settings(pemSettings());
  const { pdf } = await complete();
  const anybody = makeCert({ cn: 'Anybody Time', ku: 0xc0, eku: [TIME_STAMPING], ekuCritical: true, from: new Date('2000-01-01'), to: new Date('2040-01-01') });
  const forged = addToken(pdf, (req) => tsaAnswer(req, anybody, [], { time: new Date('2019-03-01T12:00:00Z') }), tsaMod, cms);
  if (PDFSIG) assert.match(pdfsig(write('forged-time.pdf', forged)), /Signature is Valid/, 'the seal itself still holds: unsigned attributes are outside it');
  // Without TSA_TRUST nothing can vouch for a time stamp: no time from it, only the seal's own (covered) time.
  const v = await verify(forged, '192.0.2.91');
  assert.equal(v.seal.intact, true);
  assert.equal(v.seal.timestamp_at, null);
  assert.equal(v.seal.timestamp_unchecked, true);
  assert.ok(v.seal.sealed_at && !v.seal.sealed_at.startsWith('2019'));
  assert.doesNotMatch(JSON.stringify(v.seal), /2019-03-01/);
  // With TSA_TRUST set to the real service, the stranger's is still not under it.
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp', TSA_TRUST: write('trust-b.pem', tsaRoot.pem) });
  const v2 = await verify(forged, '192.0.2.92');
  assert.equal(v2.seal.timestamp_at, null);
  assert.equal(v2.seal.timestamp_unchecked, true);
  // A token that is not over this seal's signature, or made by a certificate not meant for time-stamping: the same.
  const notTsa = makeCert({ cn: 'No Purpose' });
  for (const bad of [addToken(pdf, (req) => tsaAnswer(req, anybody, [], { imprint: crypto.randomBytes(32) }), tsaMod, cms), addToken(pdf, (req) => tsaAnswer(req, notTsa, []), tsaMod, cms)]) {
    const c = (await seal.checkSeal(bad))!;
    assert.equal(c.intact, true);
    assert.equal(c.level, 'B-B');
    assert.equal(c.timestamp_at, null);
    assert.equal(c.timestamp_unchecked, true);
  }
  // The page says so in words, and never "trusted" for it.
  const page = fs.readFileSync('src/app/verify/SealResult.tsx', 'utf8');
  assert.match(page, /seal\.timestamp_at\s*\?[^:]*trusted time stamp/);
  assert.match(page, /timestamp_unchecked \? <> It also carries a time stamp that this page has no way to check/);
});

test('without TSA_TRUST a time stamp is taken only near our clock and nothing calls it trusted: the record, the certificate, the screens and /verify', async () => {
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp' });
  const stub = stubTsa((req) => tsaAnswer(req, tsa, [tsaRoot]));
  try {
    const { id, pdf, c } = await complete();
    const row = s.db.get('SELECT seal_level, seal_tsa FROM envelopes WHERE id=?', id);
    assert.deepEqual([row.seal_level, row.seal_tsa], ['B-T', 'unchecked']);
    const line = s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action LIKE 'Sealed by %'", id).detail;
    assert.match(line, /carries a time stamp from tsa\.test at /);
    assert.match(line, /was not set up to check whose service that is, so nothing here calls the time stamp trusted/);
    assert.doesNotMatch(line, /a trusted time stamp/);
    if (PDFTOTEXT) {
      const words = text(pdf);
      assert.match(words, /carries a time stamp from a time-stamp service\. This server checked that it is over this seal and within five minutes of its own clock; it was not set up to check whose service it is/);
      assert.doesNotMatch(words, /trusted time stamp/);
    }
    const page = (await c.get(`/envelopes/${id}`)).data;
    assert.deepEqual([page.seal.time_stamp, page.seal.time_stamp_trusted], [true, false]);
    const st = (await c.get('/seal')).data;
    assert.deepEqual([st.time_stamp, st.time_stamp_trusted], [true, false]);
    const v = await verify(pdf, '192.0.2.93');
    assert.equal(v.match, true);
    assert.equal(v.seal.level, 'B-T');
    assert.equal(v.seal.timestamp_at, null, 'no time from a time stamp nobody checked');
    assert.equal(v.seal.timestamp_unchecked, true);
    // The words on the screens.
    const en = JSON.parse(fs.readFileSync('src/locales/en.json', 'utf8'));
    assert.doesNotMatch(en['seal.time.stamp_unchecked'], /trusted/);
    for (const f of ['src/components/sender/FileChecks.tsx', 'src/components/settings/SealStatus.tsx']) assert.match(fs.readFileSync(f, 'utf8'), /time_stamp_trusted \? 'seal\.time\.stamp' : 'seal\.time\.stamp_unchecked'/, f);
    // With TSA_TRUST the status line and a new envelope say trusted.
    settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp', TSA_TRUST: write('trust-c.pem', tsaRoot.pem) });
    assert.equal((await c.get('/seal')).data.time_stamp_trusted, true);
  } finally {
    stub.restore();
  }
});

test('the user name and password of the time-stamp service are never sent over plain http', async () => {
  settings({ ...pemSettings(), TSA_URL: 'http://plain.test/ts,https://tsa.test/stamp', TSA_USER: 'seal-user', TSA_PASSWORD: 'tsa pass' });
  const stub = stubTsa((req) => tsaAnswer(req, tsa, [tsaRoot]));
  try {
    const { id } = await complete();
    assert.deepEqual(stub.calls.map((c) => new URL(c.url).host), ['tsa.test'], 'the http address is not asked at all');
    assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, 'B-T');
    stub.calls.length = 0;
    // Without credentials a plain http service is asked: its answer is signed, and nothing secret goes out.
    settings({ ...pemSettings(), TSA_URL: 'http://plain.test/ts' });
    await complete();
    assert.deepEqual(stub.calls.map((c) => [new URL(c.url).host, c.auth]), [['plain.test', null]]);
    // Only http: with credentials nothing is asked, and the record says why.
    settings({ ...pemSettings(), TSA_URL: 'http://plain.test/ts', TSA_USER: 'seal-user', TSA_PASSWORD: 'tsa pass' });
    stub.calls.length = 0;
    const only = await complete();
    assert.equal(stub.calls.length, 0);
    assert.match(s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action LIKE 'Sealed by %'", only.id).detail, /plain\.test: not asked, because its address is plain http/);
  } finally {
    stub.restore();
  }
});

test('the certificate on its own in an evidence pack carries no seal field and says nothing false; signed.pdf is the sealed file', async () => {
  settings(pemSettings());
  const { id, pdf, c } = await complete();
  const ev = await import('../src/server/evidence.ts');
  const env = await import('../src/server/envelopes.ts');
  const pack = await ev.evidencePack(env.loadEnvelope(id), 'the test');
  const file = (name: string) => Buffer.from(pack.entries.find((e) => e.name === name)!.data);
  assert.ok(file('signed.pdf').equals(pdf));
  const cert = file('certificate.pdf');
  assert.doesNotMatch(cert.toString('latin1'), /\/ByteRange|ETSI\.CAdES|\/FT\s*\/Sig/, 'nothing of the seal is copied into the extract');
  assert.equal(await seal.checkSeal(cert), null, '/verify says nothing about a seal for it');
  if (PDFSIG) assert.doesNotMatch(pdfsig(write('certificate.pdf', cert)), /Signature #|not yet been verified|Not total document signed/);
  if (PDFTOTEXT) {
    const words = text(cert);
    assert.match(words, /The signed PDF this certificate closes carries a digital seal/);
    assert.doesNotMatch(words, /This file carries a digital seal/);
  }
  const readme = file('README.txt').toString();
  assert.match(readme, /certificate\.pdf\s+the certificate of completion on its own, to read: an extract/);
  assert.match(readme, /The digital seal is in signed\.pdf, not in this extract/);
  // Without a seal the pack says nothing about one.
  settings({});
  const plain = await complete();
  const p2 = await ev.evidencePack(env.loadEnvelope(plain.id), 'the test');
  assert.doesNotMatch(Buffer.from(p2.entries.find((e) => e.name === 'README.txt')!.data).toString(), /digital seal/i);
  void c;
});

test('with no seal key the public pages say nothing about a seal, and with one they never promise more than the code does', async () => {
  const lib = await import('../src/lib/seal.ts');
  const cert = fs.readFileSync('src/app/security/certificate/page.tsx', 'utf8');
  // Every mention of the seal on the certificate page sits behind sealSet(), and the page is read on each request.
  assert.match(cert, /export const dynamic = 'force-dynamic'/);
  const outside = cert.replace(/\{sealSet\(\) && <>[\s\S]*?\n {8}<\/>\}/g, '').replace(/\{sealSet\(\) && <li>[\s\S]*?<\/li>\}/g, '').replace(/^import .*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\/\/.*$/gm, '');
  assert.doesNotMatch(outside, /digital seal|time.stamp|SEAL_/i, 'nothing about the digital seal outside the gated parts');
  // The table of outside services leaves the time-stamp row out without a seal key.
  assert.match(fs.readFileSync('src/app/security/Outside.tsx', 'utf8'), /filter\(\(s\) => s\.id !== 'tsa' \|\| sealSet\(\)\)/);
  assert.equal(lib.sealSet({}), false);
  assert.equal(lib.sealSet({ TSA_URL: 'https://tsa.test' }), false, 'a time-stamp service alone is no seal');
  // The public words: no technical names, the unsealed case is said, and "trusted" only with the operator's list.
  for (const w of [lib.SEAL_TRUTH, lib.SEAL_TIME, lib.SEAL_TRUST, lib.SEAL_LIMITS, lib.sealCertificateLine({ name: 'A', issuer: 'B', level: 'B-T' }), lib.sealCertificateLine({ name: 'A', issuer: 'B', level: 'B-B' })])
    assert.doesNotMatch(w, /PAdES|PKI|CMS|RFC ?3161|B-B|B-T|—/);
  assert.match(lib.SEAL_TRUTH, /If the seal certificate cannot be used at that moment .* the file is made without a seal/);
  assert.doesNotMatch(lib.SEAL_TRUTH, /Every PDF/);
  assert.doesNotMatch(lib.sealCertificateLine({ name: 'A', issuer: 'B', level: 'B-T' }), /trusted/);
  assert.match(lib.sealCertificateLine({ name: 'A', issuer: 'B', level: 'B-T', tsaTrusted: true }), /trusted time stamp/);
  assert.match(lib.SEAL_TIME, /trusted time stamp only when the operator has also given the server the certificates/);
  assert.doesNotMatch(JSON.stringify((await import('../src/lib/outside.ts')).outsideServices({}).find((x) => x.id === 'tsa')), /trusted/);
});
