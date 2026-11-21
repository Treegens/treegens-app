// Seals that can be checked for years (src/server/ltv.ts) and the time stamp of the audit trail at completion
// (src/server/auditstamp.ts). A stub OCSP responder, a stub revocation list and a stub time-stamp service are made
// here and answer through a fetch stub; nothing reaches the network. poppler's pdfsig and `openssl ts`, which share
// no code with ours, check the results (each check is skipped when the tool is not installed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { boot, signUp, simple, signAll, Client, type Server } from './helpers.ts';
import { makeCert, tsaAnswer, stubTsa, TIME_STAMPING, ext, type Made } from './sealcerts.ts';
import { seq, setOf, tagged, integer, oid, octets, bitString, algorithm, generalizedTime, utcTime, tlv, read, kids, whole, content } from '../src/server/der.ts';

let s: Server;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-ltv-'));
const has = (bin: string, arg = '-v') => {
  try {
    execFileSync(bin, [arg], { stdio: 'ignore' });
    return true;
  } catch (e: any) {
    return e?.code !== 'ENOENT';
  }
};
const PDFSIG = has('pdfsig');
const OPENSSL = has('openssl', 'version');
const PDFTOTEXT = has('pdftotext');
const SETTINGS = ['SEAL_P12', 'SEAL_P12_PASSWORD', 'SEAL_KEY_PEM', 'SEAL_CERT_PEM', 'SEAL_CHAIN_PEM', 'TSA_URL', 'TSA_URLS', 'TSA_USER', 'TSA_PASSWORD', 'TSA_TRUST', 'LTV_WAIT_MS'];
let sealkey: typeof import('../src/server/sealkey.ts');
let seal: typeof import('../src/server/seal.ts');
let tsaMod: typeof import('../src/server/tsa.ts');
let root: Made, inter: Made, leaf: Made, tsaRoot: Made, tsa: Made, plainLeaf: Made;
let paydns: typeof import('../src/server/paydns.ts');
let realLookup: any;

const write = (name: string, data: string | Buffer) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, data);
  return f;
};
function settings(env: Record<string, string>) {
  for (const k of SETTINGS) delete process.env[k];
  Object.assign(process.env, env);
  sealkey.forgetSealKey();
  tsaMod.tsaForgetRests();
}
const pemSettings = (cert: Made = leaf, chain: Made[] = [inter, root]) => ({ SEAL_KEY_PEM: write(`key-${Math.random()}.pem`, cert.keyPem), SEAL_CERT_PEM: write(`cert-${Math.random()}.pem`, cert.pem), SEAL_CHAIN_PEM: write(`chain-${Math.random()}.pem`, chain.map((c) => c.pem).join('')) });

// Where each certificate says it can be checked: an OCSP address (AIA), or a revocation list (CDP).
const aia = (url: string) => ext('1.3.6.1.5.5.7.1.1', false, seq(seq(oid('1.3.6.1.5.5.7.48.1'), tagged(6, Buffer.from(url), true))));
const cdp = (url: string) => ext('2.5.29.31', false, seq(seq(tagged(0, tagged(0, tagged(6, Buffer.from(url), true))))));

// ---- A stub OCSP responder (RFC 6960) and a stub revocation list -------------------------------------------

type OcspHow = { status?: 'good' | 'revoked'; signer?: Made; nonce?: Buffer | null; thisUpdate?: Date; refuse?: number };
const certSerial = (m: Made) => content(kids(kids(read(m.der))[0])[1]);
const subjectOf = (m: Made) => Buffer.from(whole(kids(kids(read(m.der))[0])[5]));

function ocspAnswer(req: Buffer, signer: Made, how: OcspHow = {}): Buffer {
  if (how.refuse) return seq(tlv(0x0a, Buffer.from([how.refuse])));
  const tbsReq = kids(kids(read(req))[0]);
  const certId = Buffer.from(whole(kids(kids(tbsReq[0])[0])[0]));
  let nonce: Buffer | null = null;
  if (tbsReq[1]?.tag === 0xa2) nonce = Buffer.from(content(read(content(kids(kids(kids(tbsReq[1])[0])[0])[1]))));
  if (how.nonce !== undefined) nonce = how.nonce;
  const status = how.status === 'revoked' ? tagged(1, generalizedTime(new Date(Date.now() - 3600_000))) : tagged(0, Buffer.alloc(0), true);
  const at = how.thisUpdate || new Date();
  const single = seq(certId, status, generalizedTime(at), tagged(0, generalizedTime(new Date(at.getTime() + 3600_000))));
  const exts = nonce ? [tagged(1, seq(seq(oid('1.3.6.1.5.5.7.48.1.2'), octets(octets(nonce)))))] : [];
  const signerKeyBits = content(kids(read(crypto.createPublicKey(signer.key).export({ type: 'spki', format: 'der' }) as Buffer))[1]).subarray(1);
  const data = seq(tagged(2, octets(crypto.createHash('sha1').update(signerKeyBits).digest())), generalizedTime(new Date()), seq(single), ...exts);
  const basic = seq(data, algorithm('1.2.840.113549.1.1.11', null), bitString(crypto.sign('sha256', data, how.signer?.key || signer.key)), tagged(0, seq(signer.der)));
  return seq(tlv(0x0a, Buffer.from([0])), tagged(0, seq(oid('1.3.6.1.5.5.7.48.1.1'), octets(basic))));
}

function crlOf(issuer: Made, revoked: Made[] = []): Buffer {
  const tbs = seq(integer(1), algorithm('1.2.840.113549.1.1.11', null), subjectOf(issuer), utcTime(new Date(Date.now() - 3600_000)), utcTime(new Date(Date.now() + 864e5)),
    ...(revoked.length ? [seq(...revoked.map((r) => seq(integer(certSerial(r)), utcTime(new Date(Date.now() - 7200_000)))))] : []));
  return seq(tbs, algorithm('1.2.840.113549.1.1.11', null), bitString(crypto.sign('sha256', tbs, issuer.key)));
}

type World = { ocsp?: (req: Buffer, url: string) => Buffer | number | 'hang'; crl?: (url: string) => Buffer | number | 'hang' };
/** One fetch stub for the time-stamp service, the OCSP responders and the revocation list. */
function stubAll(w: World = {}) {
  return stubTsa((req, url) => {
    if (url.includes('tsa.test')) return tsaAnswer(req, tsa, [tsaRoot]);
    if (url.includes('ocsp.test')) return w.ocsp ? w.ocsp(req, url) : ocspAnswer(req, url.includes('/root') ? root : inter);
    if (url.includes('crl.test')) return w.crl ? w.crl(url) : crlOf(tsaRoot);
    return 404;
  });
}

let n = 0;
async function complete(): Promise<{ id: string; pdf: Buffer; c: Client }> {
  n++;
  const c = await signUp(`Keeper ${n}`, `keeper${n}@example.com`, `198.51.100.${(n % 200) + 20}`);
  const e = await simple(c, `kept${n}@example.com`);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, `kept${n}@example.com`)).status, 200);
  const row = s.db.get('SELECT status, final_sha256 FROM envelopes WHERE id=?', e.id);
  assert.equal(row.status, 'completed');
  return { id: e.id, pdf: s.db.readBlob(row.final_sha256), c };
}
const pdfsig = (pdf: Buffer) => {
  try {
    return execFileSync('pdfsig', [write(`f-${Math.random()}.pdf`, pdf)], { encoding: 'utf8' });
  } catch (e: any) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
};
const text = (pdf: Buffer) => execFileSync('pdftotext', ['-layout', write(`t-${Math.random()}.pdf`, pdf), '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
function unzip(z: Uint8Array): Record<string, Buffer> {
  const b = Buffer.from(z);
  const out: Record<string, Buffer> = {};
  for (let i = 0; b.readUInt32LE(i) === 0x04034b50;) {
    const size = b.readUInt32LE(i + 18), nameLen = b.readUInt16LE(i + 26), extra = b.readUInt16LE(i + 28);
    out[b.subarray(i + 30, i + 30 + nameLen).toString('utf8')] = b.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    i += 30 + nameLen + extra + size;
  }
  return out;
}
const verify = async (pdf: Uint8Array) => {
  const c = new Client();
  c.ip = `192.0.2.${100 + (n++ % 100)}`;
  const f = new FormData();
  f.append('file', new Blob([pdf], { type: 'application/pdf' }), 'x.pdf');
  const r = await c.call('POST', '/public/verify', f);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

before(async () => {
  s = await boot();
  seal = await import('../src/server/seal.ts');
  sealkey = await import('../src/server/sealkey.ts');
  tsaMod = await import('../src/server/tsa.ts');
  root = makeCert({ cn: 'LTV Root CA', ca: true });
  inter = makeCert({ cn: 'LTV Issuing CA', ca: true, issuer: root, more: [aia('http://ocsp.test/root')] });
  leaf = makeCert({ cn: 'LTV Operator Seal', issuer: inter, more: [aia('http://ocsp.test/inter')] });
  plainLeaf = makeCert({ cn: 'Plain Operator Seal', issuer: inter });
  tsaRoot = makeCert({ cn: 'LTV TSA Root', ca: true });
  tsa = makeCert({ cn: 'LTV Time-Stamp Unit', issuer: tsaRoot, ku: 0xc0, eku: [TIME_STAMPING], ekuCritical: true, more: [cdp('http://crl.test/tsa.crl')] });
  // Names in certificates are asked of the DNS before anything is fetched: answered here, never by the network.
  // Names under .evil lead into a private network.
  paydns = await import('../src/server/paydns.ts');
  realLookup = paydns.resolver.lookup;
  paydns.resolver.lookup = async (h: string) => (h.replace(/\.$/, '').endsWith('.evil') ? [{ address: '10.1.2.3', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
});
after(() => {
  paydns.resolver.lookup = realLookup;
  settings({});
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 1. B-LT and B-LTA ---------------------------------------------------------------------------------------

test('1: with a time-stamp service and certificates that name where to check them, the signed PDF is B-LTA: a /DSS with the answers, then a document time stamp, and pdfsig still says the seal holds', async () => {
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp' });
  const stub = stubAll();
  try {
    const { id, pdf, c } = await complete();
    const row = s.db.get('SELECT seal_level, seal_ltv, seal_ltv_note FROM envelopes WHERE id=?', id);
    assert.deepEqual([row.seal_level, row.seal_ltv, row.seal_ltv_note], ['B-T', 'B-LTA', null]);
    const raw = pdf.toString('latin1');
    assert.match(raw, /\/Type \/DSS/);
    assert.match(raw, /\/OCSPs \[\d+ 0 R \d+ 0 R\]/, 'an answer for the seal certificate and one for the issuing authority');
    assert.match(raw, /\/CRLs \[\d+ 0 R\]/, 'the time-stamp unit is checked with its revocation list');
    assert.match(raw, /\/Type \/DocTimeStamp\n\/Filter \/Adobe\.PPKLite\n\/SubFilter \/ETSI\.RFC3161/);
    // Who was asked: the record's time stamp, the seal's, both OCSP responders, the list, the document time stamp.
    const hosts = stub.calls.map((x) => new URL(x.url).host);
    assert.equal(hosts.filter((h) => h === 'tsa.test').length, 3);
    assert.equal(hosts.filter((h) => h === 'ocsp.test').length, 2);
    assert.equal(hosts.filter((h) => h === 'crl.test').length, 1);
    const check = (await seal.checkSeal(pdf))!;
    assert.deepEqual([check.intact, check.whole_file, check.level, check.long_term], [true, true, 'B-T', 'B-LTA'], JSON.stringify(check));
    // Without TSA_TRUST nobody checked whose service made the document time stamp: its time and name are not given.
    assert.deepEqual([check.doc_timestamp_at, check.doc_timestamp_by, check.doc_timestamp_unchecked], [null, null, true]);
    if (PDFSIG) {
      const out = pdfsig(pdf);
      assert.match(out.split('Signature #2')[0], /Signature is Valid/, out);
    }
    // /verify: byte for byte the stored file, and the seal holds over everything but the check data.
    const v = await verify(pdf);
    assert.equal(v.match, true);
    assert.equal(v.seal.intact, true);
    assert.equal(v.seal.long_term, 'B-LTA');
    const page = (await c.get(`/envelopes/${id}`)).data;
    assert.deepEqual([page.seal.long_term, page.seal.long_term_missing], ['B-LTA', null]);
    assert.match(s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action LIKE 'Sealed by %'", id).detail, /also carries what is needed to check the seal after its certificate has expired\. After that, a time stamp over the whole file was added by tsa\.test at \d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d UTC\./);
    // The document time stamp is over the whole file: openssl agrees.
    if (OPENSSL) {
      const m = [...raw.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)].pop()!;
      const r = m.slice(1).map(Number);
      assert.equal(r[2] + r[3], pdf.length);
      const hex = pdf.subarray(r[1] + 1, r[2] - 1).toString('latin1');
      const der = Buffer.from(hex, 'hex');
      const token = der.subarray(0, read(der).end);
      const covered = Buffer.concat([pdf.subarray(0, r[1]), pdf.subarray(r[2], r[2] + r[3])]);
      const out = execFileSync('openssl', ['ts', '-verify', '-in', write('doc.tsr', token), '-token_in', '-data', write('covered.bin', covered), '-CAfile', write('tsaroot.pem', tsaRoot.pem)], { encoding: 'utf8', stdio: 'pipe' });
      assert.match(out, /Verification: OK/);
    }
  } finally {
    stub.restore();
  }
});

test('1: without a document time stamp service answering, the file is B-LT and the record says why there is no time stamp over the whole file', async () => {
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp' });
  let tsaCalls = 0;
  const stub = stubTsa((req, url) => {
    if (url.includes('tsa.test')) return ++tsaCalls <= 2 ? tsaAnswer(req, tsa, [tsaRoot]) : 503;
    if (url.includes('ocsp.test')) return ocspAnswer(req, url.includes('/root') ? root : inter);
    return crlOf(tsaRoot);
  });
  try {
    const { id, pdf } = await complete();
    assert.equal(s.db.get('SELECT seal_ltv FROM envelopes WHERE id=?', id).seal_ltv, 'B-LT');
    const check = (await seal.checkSeal(pdf))!;
    assert.deepEqual([check.intact, check.whole_file, check.long_term], [true, true, 'B-LT']);
    assert.match(s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action LIKE 'Sealed by %'", id).detail, /No time stamp over the whole file was added: tsa\.test: it answered HTTP 503/);
    if (PDFSIG) assert.match(pdfsig(pdf), /Signature is Valid/);
  } finally {
    stub.restore();
  }
});

// ---- 1. When the answers are missing ----------------------------------------------------------------------------

test('1: a responder that does not answer within LTV_WAIT_MS leaves the file at B-T, and the envelope page and the record say so', async () => {
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp', LTV_WAIT_MS: '400' });
  const stub = stubAll({ ocsp: () => 'hang' });
  try {
    const t0 = Date.now();
    const { id, pdf, c } = await complete();
    assert.ok(Date.now() - t0 < 8000);
    const row = s.db.get('SELECT seal_level, seal_ltv, seal_ltv_note FROM envelopes WHERE id=?', id);
    assert.deepEqual([row.seal_level, row.seal_ltv], ['B-T', 'missing']);
    assert.match(row.seal_ltv_note, /ocsp\.test: it did not answer within 0\.4 seconds/);
    assert.doesNotMatch(pdf.toString('latin1'), /\/DSS|DocTimeStamp/, 'nothing half done is in the file');
    const check = (await seal.checkSeal(pdf))!;
    assert.deepEqual([check.intact, check.whole_file, check.level, check.long_term], [true, true, 'B-T', null]);
    const page = (await c.get(`/envelopes/${id}`)).data;
    assert.equal(page.seal.long_term, null);
    assert.match(page.seal.long_term_missing, /did not answer/);
    assert.match(s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action LIKE 'Sealed by %'", id).detail, /could not be added, so the file can be checked only while that certificate is valid/);
    if (PDFSIG) assert.match(pdfsig(pdf), /Signature is Valid/);
  } finally {
    stub.restore();
  }
});

test('1: answers that do not check out are never put in the file: revoked, signed by a stranger, an old nonce, a refusal, a listed serial', async () => {
  const stranger = makeCert({ cn: 'Stranger', ca: true });
  const cases: [string, World, RegExp][] = [
    ['revoked', { ocsp: (req, url) => ocspAnswer(req, url.includes('/root') ? root : inter, { status: url.includes('/inter') ? 'revoked' : 'good' }) }, /was revoked/],
    ['stranger', { ocsp: (req) => ocspAnswer(req, stranger) }, /not signed by the authority that issued the certificate/],
    ['old nonce', { ocsp: (req, url) => ocspAnswer(req, url.includes('/root') ? root : inter, { nonce: crypto.randomBytes(16) }) }, /another nonce/],
    ['refused', { ocsp: (req) => ocspAnswer(req, inter, { refuse: 2 }) }, /refused \(OCSP status 2\)/],
    ['old answer', { ocsp: (req, url) => ocspAnswer(req, url.includes('/root') ? root : inter, { thisUpdate: new Date(Date.now() - 30 * 864e5) }) }, /out of date/],
    ['listed', { crl: () => crlOf(tsaRoot, [tsa]) }, /revocation list says the certificate "LTV Time-Stamp Unit" was revoked/],
    ['crl by stranger', { crl: () => crlOf(stranger) }, /not signed by the authority/],
  ];
  for (const [what, w, why] of cases) {
    settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp' });
    const stub = stubAll(w);
    try {
      const { id, pdf } = await complete();
      const row = s.db.get('SELECT seal_ltv, seal_ltv_note FROM envelopes WHERE id=?', id);
      assert.equal(row.seal_ltv, 'missing', what);
      assert.match(row.seal_ltv_note, why, what);
      assert.doesNotMatch(pdf.toString('latin1'), /\/DSS/, what);
    } finally {
      stub.restore();
    }
  }
});

test('1: a certificate that points inside (this machine, a private network) is never asked, nor followed there by a redirect, and an endless answer is cut off', async () => {
  const ltv = await import('../src/server/ltv.ts');
  const x509 = await import('../src/server/x509.ts');
  const inside = makeCert({ cn: 'Inside Seal', issuer: inter, more: [aia('http://127.0.0.1:8080/ocsp')] });
  const viaRedirect = makeCert({ cn: 'Redirected Seal', issuer: inter, more: [aia('http://ocsp.test/redirect')] });
  const huge = makeCert({ cn: 'Huge Seal', issuer: inter, more: [aia('http://ocsp.test/huge')] });
  const stub = stubTsa((req, url) => {
    if (url.includes('/redirect')) return 302;
    if (url.includes('/huge')) return Buffer.alloc(300 * 1024, 1);
    return ocspAnswer(req, inter);
  });
  // The stub answers 302 without a Location header for /redirect: replace that one with a redirect inside.
  const stubbed = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => String(input).includes('/redirect') ? new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/ocsp' } }) : stubbed(input, init)) as any;
  try {
    const chain = (m: Made) => [x509.readCert(m.der), x509.readCert(inter.der), x509.readCert(root.der)];
    await assert.rejects(ltv.gather([chain(inside)], 2000), /127\.0\.0\.1:8080: it is an address on this machine or a private network/);
    await assert.rejects(ltv.gather([chain(viaRedirect)], 2000), /it sent us on to an address that is not asked/);
    await assert.rejects(ltv.gather([chain(huge)], 2000), /its answer is far too large/);
    assert.ok(!stub.calls.some((c) => /127\.0\.0\.1|10\.0\.0\.5/.test(c.url)), 'nothing inside was asked');
  } finally {
    globalThis.fetch = stubbed;
    stub.restore();
  }
});

test('1: certificates that name no place to check them get nothing added and no note; without a time-stamp service nothing is tried', async () => {
  settings({ ...pemSettings(makeCert({ cn: 'Self Seal', issuer: root }), [root]), TSA_URL: 'https://tsa.test/stamp' });
  const noAddressTsa = makeCert({ cn: 'Bare TSA', issuer: tsaRoot, ku: 0xc0, eku: [TIME_STAMPING], ekuCritical: true });
  let stub = stubTsa((req, url) => (url.includes('tsa.test') ? tsaAnswer(req, noAddressTsa, [tsaRoot]) : 404));
  try {
    const { id, pdf } = await complete();
    assert.deepEqual(Object.values(s.db.get('SELECT seal_level, seal_ltv FROM envelopes WHERE id=?', id)), ['B-T', null]);
    assert.doesNotMatch(pdf.toString('latin1'), /\/DSS/);
    assert.equal(stub.calls.filter((x) => !x.url.includes('tsa.test')).length, 0);
  } finally {
    stub.restore();
  }
  // The seal certificate names an address but the time-stamp unit's does not: nobody could check that one, and it
  // does not keep the seal's own certificates from being checked.
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp' });
  stub = stubTsa((req, url) => (url.includes('tsa.test') ? tsaAnswer(req, noAddressTsa, [tsaRoot]) : ocspAnswer(req, url.includes('/root') ? root : inter)));
  try {
    const { id, pdf } = await complete();
    const row = s.db.get('SELECT seal_ltv, seal_ltv_note FROM envelopes WHERE id=?', id);
    assert.deepEqual([row.seal_ltv, row.seal_ltv_note], ['B-LTA', null]);
    assert.equal((await seal.checkSeal(pdf))!.long_term, 'B-LTA');
  } finally {
    stub.restore();
  }
  // The seal's own certificate naming no place to check it still says so.
  settings({ ...pemSettings(plainLeaf), TSA_URL: 'https://tsa.test/stamp' });
  stub = stubAll();
  try {
    const { id } = await complete();
    const row = s.db.get('SELECT seal_ltv, seal_ltv_note FROM envelopes WHERE id=?', id);
    assert.equal(row.seal_ltv, 'missing');
    assert.match(row.seal_ltv_note, /the certificate "Plain Operator Seal" names no place to check it/);
  } finally {
    stub.restore();
  }
  // No time-stamp service: B-B, nothing fetched, no record time stamp.
  settings({ ...pemSettings() });
  stub = stubAll();
  try {
    const { id } = await complete();
    assert.equal(stub.calls.length, 0);
    assert.deepEqual(Object.values(s.db.get('SELECT seal_level, seal_ltv FROM envelopes WHERE id=?', id)), ['B-B', null]);
    assert.ok(!s.db.get('SELECT 1 x FROM audit_stamps WHERE envelope_id=?', id));
  } finally {
    stub.restore();
  }
});

// ---- 1. /verify does not accept anything else after a seal ------------------------------------------------------

test('1: anything saved after the seal other than check data is still reported as saved after it: a changed page, an extra annotation, a forged document time stamp', async () => {
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp' });
  const stub = stubAll();
  let pdf: Buffer;
  try {
    pdf = (await complete()).pdf;
  } finally {
    stub.restore();
  }
  const { PDFDocument, PDFName, PDFRef } = await import('pdf-lib');
  const ltv = await import('../src/server/ltv.ts');
  // A page changed in an update of its own after the time stamp.
  const doc = await PDFDocument.load(pdf);
  const page = doc.getPages()[0];
  const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(pdf.subarray(pdf.length - 200).toString('latin1'))![1]);
  const size = doc.context.largestObjectNumber + 1;
  const pageDict = page.node.clone();
  pageDict.set(PDFName.of('Rotate'), doc.context.obj(90));
  const body = `${page.ref.objectNumber} 0 obj\n${pageDict.toString()}\nendobj\n`;
  const at = pdf.length;
  const xrefAt = at + body.length;
  const isStream = !/^\s*xref/.test(pdf.subarray(startxref, startxref + 10).toString('latin1'));
  let tail: string;
  if (isStream) {
    const row = Buffer.alloc(7);
    row[0] = 1;
    row.writeUInt32BE(at, 1);
    tail = `${size} 0 obj\n<<\n/Type /XRef\n/Size ${size + 1}\n/Index [${page.ref.objectNumber} 1 ${size} 1]\n/W [1 4 2]\n/Root ${(doc.context.trailerInfo.Root as any).toString()}\n/Prev ${startxref}\n/Length 14\n>>\nstream\n`;
    const row2 = Buffer.alloc(7);
    row2[0] = 1;
    row2.writeUInt32BE(xrefAt, 1);
    const changed = Buffer.concat([pdf, Buffer.from(body + tail, 'latin1'), row, row2, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1')]);
    const c = (await seal.checkSeal(changed))!;
    assert.equal(c.whole_file, false, 'a turned page is not check data');
    assert.equal(c.long_term, null);
  } else {
    tail = `xref\n${page.ref.objectNumber} 1\n${String(at).padStart(10, '0')} 00000 n\r\ntrailer\n<<\n/Size ${size}\n/Root ${(doc.context.trailerInfo.Root as any).toString()}\n/Prev ${startxref}\n>>\nstartxref\n${xrefAt}\n%%EOF\n`;
    const c = (await seal.checkSeal(Buffer.concat([pdf, Buffer.from(body + tail, 'latin1')])))!;
    assert.equal(c.whole_file, false, 'a turned page is not check data');
  }
  // The check data alone is accepted; the same file with one byte of a page changed before it is not.
  assert.ok(await ltv.ltvTail(pdf, sealEnd(pdf)));
  const flipped = Buffer.from(pdf);
  const i = flipped.indexOf('/MediaBox');
  flipped[i + 1] = 'm'.charCodeAt(0);
  assert.notEqual((await seal.checkSeal(flipped))!.intact, true);
  // A document time stamp whose token is over something else.
  const ts = pdf.lastIndexOf('/Type /DocTimeStamp');
  const hexAt = pdf.indexOf('/Contents <', ts) + '/Contents <'.length;
  const forged = Buffer.from(pdf);
  // Change one byte inside the token's time-stamp info (the imprint): its signature no longer holds.
  const tokHex = forged.subarray(hexAt, hexAt + 4000).toString('latin1');
  const pos = tokHex.indexOf('0420') + 8; // the first OCTET STRING of 32 bytes: the message imprint
  forged[hexAt + pos] = forged[hexAt + pos] === 0x30 ? 0x31 : 0x30;
  assert.equal(await ltv.ltvTail(forged, sealEnd(forged)), null);
  void PDFRef;
});

function sealEnd(pdf: Buffer): number {
  const text = pdf.toString('latin1');
  const m = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)][0];
  return Number(m[3]) + Number(m[4]);
}

// ---- 2. The time stamp of the audit trail --------------------------------------------------------------------------

test('2: at completion the chain head is time-stamped: the certificate says so in one line, the token verifies with openssl over the head and fails for another, and the evidence pack carries it with the command', async () => {
  settings({ TSA_URL: 'https://tsa.test/stamp' });
  const stub = stubAll();
  try {
    const { id, pdf, c } = await complete();
    const row = s.db.get('SELECT * FROM audit_stamps WHERE envelope_id=?', id);
    assert.ok(row?.token, 'kept, also without a seal');
    const head = row.head;
    assert.match(head, /^[0-9a-f]{64}$/);
    // The head is the line the certificate prints: the last line before the file was made.
    const lines = s.db.all('SELECT hash FROM audit WHERE envelope_id=? ORDER BY seq', id).map((x: any) => x.hash);
    assert.ok(lines.includes(head));
    if (PDFTOTEXT) {
      const words = text(pdf);
      assert.match(words, new RegExp(`Chain head ${head}`));
      assert.match(words, /The last value of this record was time-stamped by LTV Time-Stamp Unit at \d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d UTC\./);
      assert.doesNotMatch(words, /qualified/i);
    }
    const page = (await c.get(`/envelopes/${id}`)).data;
    assert.equal(page.record_stamp.holds, true);
    assert.equal(page.record_stamp.by, 'LTV Time-Stamp Unit');
    const zip = unzip((await c.get(`/envelopes/${id}/evidence`)).data);
    assert.equal(zip['audit-trail-head.txt'].toString(), head);
    assert.ok(zip['audit-trail-timestamp.tsr']);
    assert.match(zip['audit-trail-timestamp-certificates.pem'].toString(), /BEGIN CERTIFICATE/);
    const readme = zip['README.txt'].toString();
    assert.match(readme, /openssl ts -verify -in audit-trail-timestamp\.tsr -token_in -data audit-trail-head\.txt -CAfile <the root certificate of LTV Time-Stamp Unit>/);
    assert.match(readme, /before completion the chain is only ours to vouch for/i);
    if (OPENSSL) {
      const tsr = write(`chain-${id}.tsr`, zip['audit-trail-timestamp.tsr']);
      const ca = write('chain-root.pem', tsaRoot.pem);
      const ok = execFileSync('openssl', ['ts', '-verify', '-in', tsr, '-token_in', '-data', write(`head-${id}.txt`, zip['audit-trail-head.txt']), '-CAfile', ca], { encoding: 'utf8', stdio: 'pipe' });
      assert.match(ok, /Verification: OK/);
      const other = head.slice(0, 63) + (head[63] === '0' ? '1' : '0');
      assert.throws(() => execFileSync('openssl', ['ts', '-verify', '-in', tsr, '-token_in', '-data', write(`other-${id}.txt`, other), '-CAfile', ca], { stdio: 'pipe' }), 'a changed head does not verify');
    }
  } finally {
    stub.restore();
  }
});

test('2: a rewrite of the record up to completion, even with the chain recomputed, shows against the time stamp', async () => {
  settings({ TSA_URL: 'https://tsa.test/stamp' });
  const stub = stubAll();
  let id: string, c: Client;
  try {
    ({ id, c } = await complete());
  } finally {
    stub.restore();
  }
  // Whoever can write the database rewrites the first line and recomputes every hash after it.
  const rows = s.db.all('SELECT seq, at, actor, action, detail, ip FROM audit WHERE envelope_id=? ORDER BY seq', id);
  rows[0].detail = `${rows[0].detail} (rewritten)`;
  let prev = '';
  for (const a of rows) {
    const h = crypto.createHash('sha256').update(JSON.stringify([prev, id, a.at, a.actor, a.action, a.detail, a.ip || ''])).digest('hex');
    s.db.run('UPDATE audit SET detail=?, prev_hash=?, hash=? WHERE seq=?', a.detail, prev, h, a.seq);
    prev = h;
  }
  const page = (await c.get(`/envelopes/${id}`)).data;
  assert.equal(page.chain.ok, true, 'the chain alone cannot tell');
  assert.equal(page.record_stamp.holds, false, 'the time stamp is over a head the stored record no longer has');
});

test('2: when no service gives a time stamp for the record, the certificate prints no such line, the reason is kept, and the seal still gets its own when the service comes back', async () => {
  settings({ TSA_URL: 'https://tsa.test/stamp' });
  const stub = stubTsa(() => 503);
  try {
    const { id, pdf, c } = await complete();
    const row = s.db.get('SELECT token, why FROM audit_stamps WHERE envelope_id=?', id);
    assert.equal(row.token, null);
    assert.match(row.why, /HTTP 503/);
    if (PDFTOTEXT) assert.doesNotMatch(text(pdf), /time-stamped by/);
    assert.match((await c.get(`/envelopes/${id}`)).data.record_stamp.missing, /HTTP 503/);
    assert.equal(unzip((await c.get(`/envelopes/${id}/evidence`)).data)['audit-trail-timestamp.tsr'], undefined);
  } finally {
    stub.restore();
  }
});

test('2: with no time-stamp service, nothing is asked and the certificate and evidence pack are as before', async () => {
  settings({});
  const stub = stubAll();
  try {
    const { id, pdf } = await complete();
    assert.equal(stub.calls.length, 0);
    assert.ok(!s.db.get('SELECT 1 x FROM audit_stamps WHERE envelope_id=?', id));
    if (PDFTOTEXT) assert.doesNotMatch(text(pdf), /time-stamped/);
  } finally {
    stub.restore();
  }
});

// ---- 3. Words ------------------------------------------------------------------------------------------------------

test('3: no word calls a time stamp or a seal qualified, and CHAIN_TRUTH says what the time stamp changes', async () => {
  const ev = await import('../src/lib/evidence.ts');
  assert.match(ev.CHAIN_TRUTH, /Before completion the chain is only ours to vouch for/);
  assert.match(ev.CHAIN_TRUTH, /after it, rewriting shows against the time stamp/i);
  for (const f of ['src/server/ltv.ts', 'src/server/auditstamp.ts', 'src/lib/evidence.ts', 'src/components/sender/FileChecks.tsx']) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t.replace(/nothing here calls it qualified|never says qualified|not.{0,40}qualified/gi, ''), /\bqualified\b/i, f);
    assert.doesNotMatch(t, /\u2014/, `${f} has no em dash`);
  }
  void setOf;
});

// ---- Repairs: what the skeptic and the simplicity reviewer found ------------------------------------------------

/** A sealed file at B-T with nothing after the seal: LTV_WAIT_MS=0 turns the long-term step off. */
async function btFile(): Promise<{ id: string; pdf: Buffer; c: Client }> {
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp', LTV_WAIT_MS: '0' });
  const stub = stubAll();
  try {
    const r = await complete();
    assert.equal(stub.calls.filter((x) => !x.url.includes('tsa.test')).length, 0, 'LTV_WAIT_MS=0: no certificate service is asked');
    assert.deepEqual(Object.values(s.db.get('SELECT seal_level, seal_ltv, seal_ltv_note FROM envelopes WHERE id=?', r.id)), ['B-T', null, null], 'and no note that something failed');
    return r;
  } finally {
    stub.restore();
  }
}

/** A sealed file at B-LT (check data, no document time stamp), made by the real pipeline. */
async function bltFile(): Promise<Buffer> {
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp' });
  let tsaCalls = 0;
  const stub = stubTsa((req, url) => {
    if (url.includes('tsa.test')) return ++tsaCalls <= 2 ? tsaAnswer(req, tsa, [tsaRoot]) : 503;
    if (url.includes('ocsp.test')) return ocspAnswer(req, url.includes('/root') ? root : inter);
    return crlOf(tsaRoot);
  });
  try {
    const { pdf } = await complete();
    assert.equal((await seal.checkSeal(pdf))!.long_term, 'B-LT');
    return pdf;
  } finally {
    stub.restore();
  }
}

test('repair: a /DSS that is empty, holds bytes that are not check data, or is about other certificates is "saved after the seal", on checkSeal and on /verify', async () => {
  const ltv = await import('../src/server/ltv.ts');
  const x509 = await import('../src/server/x509.ts');
  const { pdf } = await btFile();
  assert.equal((await seal.checkSeal(pdf))!.whole_file, true);
  const payload = Buffer.from('%%ANYTHING AT ALL, a hidden file say\n'.repeat(500));
  const forged: [string, Buffer][] = [
    ['empty', await ltv.writeDss(pdf, { certs: [], ocsps: [], crls: [] })],
    ['garbage certificate', await ltv.writeDss(pdf, { certs: [{ der: payload } as any], ocsps: [], crls: [] })],
    ['garbage answer', await ltv.writeDss(pdf, { certs: [x509.readCert(leaf.der)], ocsps: [payload], crls: [] })],
    ['someone else', await ltv.writeDss(pdf, { certs: [x509.readCert(root.der), x509.readCert(tsaRoot.der)], ocsps: [], crls: [] })],
    ['the chain but no answer', await ltv.writeDss(pdf, { certs: [x509.readCert(leaf.der), x509.readCert(inter.der), x509.readCert(root.der)], ocsps: [], crls: [crlOf(tsaRoot)] })],
  ];
  for (const [what, f] of forged) {
    const c = (await seal.checkSeal(f))!;
    assert.deepEqual([c.intact, c.whole_file, c.long_term], [true, false, null], what);
    const v = await verify(f);
    assert.deepEqual([v.seal.whole_file, v.seal.long_term], [false, null], what);
  }
});

test('repair: a document time stamp whose widget carries an action is not accepted; one from a service nobody listed holds but its name and time are not given', async () => {
  const ltv = await import('../src/server/ltv.ts');
  const sp = await import('../src/server/sealpdf.ts');
  const lt = await bltFile();
  const sr = makeCert({ cn: 'Mallory Root', ca: true });
  const mallory = makeCert({ cn: 'Mallory Time Service', issuer: sr, ku: 0xc0, eku: [TIME_STAMPING], ekuCritical: true });
  const stamp = async (edit?: (b: Buffer) => void) => {
    const prepared = await sp.prepareSeal(lt, new Date(), undefined, 'timestamp');
    if (edit) edit(prepared.bytes);
    const covered = sp.coveredBytes(prepared.bytes, prepared.byteRange);
    const stub = stubTsa((req) => tsaAnswer(req, mallory, [sr]));
    try {
      return sp.fillSeal(prepared, (await tsaMod.timeStamp(covered, ['https://mallory.test/'])).token);
    } finally {
      stub.restore();
    }
  };
  // The same number of bytes, so every offset in the file stays right: /T (Time stamp) becomes an action entry.
  const withAction = await stamp((b) => {
    const i = b.lastIndexOf('/T (Time stamp)');
    assert.ok(i > 0);
    b.write('/AA <</PO 7>>  ', i, 'latin1');
  });
  assert.match(withAction.toString('latin1'), /\/AA <<\/PO 7>>/);
  let c = (await seal.checkSeal(withAction))!;
  assert.deepEqual([c.whole_file, c.long_term], [false, null], 'an action on the time stamp field is not check data');
  // A clean document time stamp from a service of one's own: it holds over the file, so the file is whole, but its
  // name and time are not shown, without TSA_TRUST and with one that does not list it.
  const clean = await stamp();
  for (const trust of [undefined, tsaRoot.pem]) {
    settings({ ...pemSettings(), ...(trust ? { TSA_TRUST: trust } : {}) });
    c = (await seal.checkSeal(clean))!;
    assert.deepEqual([c.whole_file, c.long_term, c.doc_timestamp_by, c.doc_timestamp_at, c.doc_timestamp_unchecked], [true, 'B-LTA', null, null, true], String(!!trust));
  }
  // Our own service, listed in TSA_TRUST: then its name and time are given.
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp', TSA_TRUST: tsaRoot.pem });
  const stub = stubAll();
  try {
    const { pdf } = await complete();
    c = (await seal.checkSeal(pdf))!;
    assert.deepEqual([c.long_term, c.doc_timestamp_by, c.doc_timestamp_unchecked], ['B-LTA', 'LTV Time-Stamp Unit', false]);
    assert.ok(c.doc_timestamp_at);
  } finally {
    stub.restore();
  }
  void ltv;
});

test('repair: certificate addresses with a dot at the end, or names that lead into a private network, are never asked', async () => {
  const ltv = await import('../src/server/ltv.ts');
  const x509 = await import('../src/server/x509.ts');
  const stub = stubTsa(() => 404);
  try {
    for (const u of ['http://localhost./ocsp', 'http://metadata.google.internal./x', 'http://printer.local./x', 'http://ocsp.evil/x', 'http://ocsp.evil./x']) {
      const m = makeCert({ cn: 'Odd Seal', issuer: inter, more: [aia(u)] });
      await assert.rejects(ltv.gather([[x509.readCert(m.der), x509.readCert(inter.der), x509.readCert(root.der)]], 2000), /it is an address on this machine or a private network/, u);
    }
    assert.ok(!stub.calls.some((x) => /localhost|internal|\.local|\.evil/.test(x.url)), JSON.stringify(stub.calls.map((x) => x.url)));
  } finally {
    stub.restore();
  }
});

test('repair: the document time stamp shares LTV_WAIT_MS with the answers, so a hanging service does not add its own seconds', async () => {
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp', LTV_WAIT_MS: '600' });
  let tsaCalls = 0;
  const stub = stubTsa((req, url) => {
    if (url.includes('tsa.test')) return ++tsaCalls <= 2 ? tsaAnswer(req, tsa, [tsaRoot]) : 'hang';
    if (url.includes('ocsp.test')) return new Promise<Buffer>((ok) => setTimeout(() => ok(ocspAnswer(req, url.includes('/root') ? root : inter)), 300));
    return crlOf(tsaRoot);
  });
  try {
    const t0 = Date.now();
    const { id } = await complete();
    const took = Date.now() - t0;
    assert.equal(s.db.get('SELECT seal_ltv FROM envelopes WHERE id=?', id).seal_ltv, 'B-LT');
    // Before the repair the document time stamp got a fresh 3 seconds of its own after the answers.
    assert.ok(took < 2800, `took ${took} ms`);
  } finally {
    stub.restore();
  }
});

test('repair: with the outside-connections guard refusing a certificate service, the note tells the operator what to add', async () => {
  settings({ ...pemSettings(), TSA_URL: 'https://tsa.test/stamp' });
  const stub = stubAll();
  const stubbed = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    if (String(input).includes('ocsp.test')) throw Object.assign(new Error('This server does not connect to ocsp.test.'), { name: 'OutsideRefused' });
    return stubbed(input, init);
  }) as any;
  try {
    const { id } = await complete();
    const row = s.db.get('SELECT seal_ltv, seal_ltv_note FROM envelopes WHERE id=?', id);
    assert.equal(row.seal_ltv, 'missing');
    assert.match(row.seal_ltv_note, /add ocsp\.test to OUTBOUND_ALLOW/);
  } finally {
    globalThis.fetch = stubbed;
    stub.restore();
  }
});

test('repair: someone who writes the database and puts in a token from a service of their own: the page names that service from the token, says it was not checked, and with TSA_TRUST the record no longer holds', async () => {
  settings({ TSA_URL: 'https://tsa.test/stamp' });
  let stub = stubAll();
  let id: string, c: Client;
  try {
    ({ id, c } = await complete());
  } finally {
    stub.restore();
  }
  assert.deepEqual((({ holds, trusted, by }) => ({ holds, trusted, by }))((await c.get(`/envelopes/${id}`)).data.record_stamp), { holds: true, trusted: false, by: 'LTV Time-Stamp Unit' });
  const rows = s.db.all('SELECT seq, at, actor, action, detail, ip FROM audit WHERE envelope_id=? ORDER BY seq', id);
  rows[0].detail = `${rows[0].detail} (rewritten)`;
  let prev = '';
  for (const a of rows) {
    const h = crypto.createHash('sha256').update(JSON.stringify([prev, id, a.at, a.actor, a.action, a.detail, a.ip || ''])).digest('hex');
    s.db.run('UPDATE audit SET detail=?, prev_hash=?, hash=? WHERE seq=?', a.detail, prev, h, a.seq);
    prev = h;
  }
  const stamped = s.db.get('SELECT * FROM audit_stamps WHERE envelope_id=?', id);
  const sr = makeCert({ cn: 'Mallory Root', ca: true });
  const mallory = makeCert({ cn: 'Mallory Time Service', issuer: sr, ku: 0xc0, eku: [TIME_STAMPING], ekuCritical: true, from: new Date(Date.now() - 864e5) });
  stub = stubTsa((req) => tsaAnswer(req, mallory, [sr], { time: new Date(stamped.stamped_at) }));
  let tok: Buffer;
  try {
    // checkAnswer refuses a time far from now, so the token is taken from the stub's answer directly.
    const ts = await import('../src/server/tsa.ts');
    const nonce = crypto.randomBytes(8);
    nonce[0] &= 0x7f;
    const answer = tsaAnswer(ts.timeStampRequest(crypto.createHash('sha256').update(prev).digest(), nonce), mallory, [sr], { time: new Date(stamped.stamped_at) });
    tok = Buffer.from(whole(kids(read(answer))[1]));
  } finally {
    stub.restore();
  }
  s.db.run('UPDATE audit_stamps SET head=?, token=?, tsa_name=?, stamped_at=? WHERE envelope_id=?', prev, tok.toString('base64'), 'LTV Time-Stamp Unit', stamped.stamped_at, id);
  let r = (await c.get(`/envelopes/${id}`)).data.record_stamp;
  assert.equal(r.by, 'Mallory Time Service', 'the name comes from the token, not the row');
  assert.equal(r.trusted, false, 'and the page says that service was not checked');
  // With TSA_TRUST listing the real service, the swapped token does not hold.
  settings({ TSA_URL: 'https://tsa.test/stamp', TSA_TRUST: tsaRoot.pem });
  r = (await c.get(`/envelopes/${id}`)).data.record_stamp;
  assert.equal(r.holds, false);
  settings({});
});

test('repair: the envelope page shows no technical failure text, says "Can be checked for years", and the record line and its warning live in History', async () => {
  const en = JSON.parse(fs.readFileSync('src/locales/en.json', 'utf8'));
  assert.match(en['seal.ltv.on'], /^Can be checked for years/);
  for (const k of ['seal.ltv.on', 'seal.ltv.missing', 'seal.record.holds', 'seal.record.unchecked', 'seal.record.missing', 'seal.record.changed', 'seal.record.badge']) {
    assert.ok(en[k], k);
    assert.doesNotMatch(en[k], /\b(LTV|B-LTA?|OCSP|CRL|chain head)\b|What happened|\u2014/, k);
  }
  const fc = fs.readFileSync('src/components/sender/FileChecks.tsx', 'utf8');
  assert.doesNotMatch(fc, /\{seal\.long_term_missing\}|record\.missing|seal\.record/, 'no reason text and no record line under Checks on the file');
  const h = fs.readFileSync('src/components/sender/History.tsx', 'utf8');
  assert.match(h, /seal\.record\.badge/);
  assert.match(h, /seal\.record\.changed/);
  assert.match(h, /fmtDate\(record\.at, true\)/, 'the page\'s own local date format');
});
