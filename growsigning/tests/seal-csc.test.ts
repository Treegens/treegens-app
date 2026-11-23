// The digital seal made by a cloud signing service through the CSC API (src/server/sealcsc.ts, as SSL.com eSigner
// serves it), against a fake service on this machine with a throwaway authority, so it runs offline: the happy path,
// the token kept and fetched again, a wrong one-time code, a service that is down or slow (the file completes without
// a seal, and why is logged), half-set settings, only a fingerprint leaves the server, and the whole chain goes into
// the seal. Also part B: a document time stamp over a completed PDF without a seal, and the bundled roots of the two
// public time-stamp services (TSA_TRUST=bundled). The real SSL.com sandbox is tried in tests/seal-csc-sandbox.test.ts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { boot, signUp, simple, signAll, Client, type Server } from './helpers.ts';
import { makeCert, tsaAnswer, TIME_STAMPING, type Made } from './sealcerts.ts';

let s: Server;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-csc-'));
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
const write = (name: string, data: string | Buffer) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, data);
  return f;
};

const SETTINGS = ['SEAL_P12', 'SEAL_P12_PASSWORD', 'SEAL_KEY_PEM', 'SEAL_CERT_PEM', 'SEAL_CHAIN_PEM', 'TSA_URL', 'TSA_URLS', 'TSA_USER', 'TSA_PASSWORD', 'TSA_TRUST',
  'SEAL_CSC_URL', 'SEAL_CSC_TOKEN_URL', 'SEAL_CSC_CLIENT_ID', 'SEAL_CSC_CLIENT_SECRET', 'SEAL_CSC_USERNAME', 'SEAL_CSC_PASSWORD', 'SEAL_CSC_CREDENTIAL_ID', 'SEAL_CSC_TOTP_SECRET'];
let sealkey: typeof import('../src/server/sealkey.ts');
let csc: typeof import('../src/server/sealcsc.ts');
let seal: typeof import('../src/server/seal.ts');
let sealcms: typeof import('../src/server/sealcms.ts');
let der: typeof import('../src/server/der.ts');
let root: Made, inter: Made, leaf: Made, tsaRoot: Made, tsa: Made;

function settings(env: Record<string, string>) {
  for (const k of SETTINGS) delete process.env[k];
  Object.assign(process.env, env);
  sealkey.forgetSealKey();
  csc.forgetCsc();
}

// ---- The fake CSC service ---------------------------------------------------------------------

type Call = { path: string; body: any; raw: string; auth: string | null };
const fake = {
  calls: [] as Call[],
  tokens: new Set<string>(),
  expiresIn: 3600,
  authMode: 'implicit',
  totpSecret: '',
  delayMs: 0,
  down: false,
  badSignature: false,
  /** The certificate behind the credential, when the service changed it (a renewed key); the first one otherwise. */
  leaf: null as Made | null,
  /** An ECDSA credential that answers the raw form (IEEE P1363) of a signature whose first byte is 0x30. */
  ec30: false,
};
let server: http.Server;
let base = '';
const TOTP = Buffer.from('a throwaway secret for the fake service').toString('base64');

function totp(secret: string, at = Date.now()) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = crypto.createHmac('sha1', Buffer.from(secret, 'base64')).update(c).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// ECDSA on P-256 over a digest the fake service is given (as an HSM signs a hash), in the raw form r || s. Node signs
// only messages, so it is done here by hand; only the tests use it.
const P256 = { p: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn, n: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
  g: [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n] as [bigint, bigint] };
const md = (a: bigint, m: bigint) => ((a % m) + m) % m;
const inv = (a: bigint, m: bigint) => {
  let [r0, r1, s0, s1] = [md(a, m), m, 1n, 0n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
  }
  return md(s0, m);
};
type Pt = [bigint, bigint] | null;
const padd = (a: Pt, b: Pt): Pt => {
  if (!a) return b;
  if (!b) return a;
  const { p } = P256;
  if (a[0] === b[0] && md(a[1] + b[1], p) === 0n) return null;
  const l = a[0] === b[0] ? md((3n * a[0] * a[0] - 3n) * inv(2n * a[1], p), p) : md((b[1] - a[1]) * inv(b[0] - a[0], p), p);
  const x = md(l * l - a[0] - b[0], p);
  return [x, md(l * (a[0] - x) - a[1], p)];
};
const pmul = (k: bigint, pt: Pt): Pt => {
  let r: Pt = null;
  for (; k; k >>= 1n, pt = padd(pt, pt)) if (k & 1n) r = padd(r, pt);
  return r;
};
const bigOf = (b: Buffer) => BigInt('0x' + b.toString('hex'));
const be32 = (x: bigint) => Buffer.from(x.toString(16).padStart(64, '0'), 'hex');
// r depends only on k, so one fixed k whose r starts with byte 0x30 gives such a signature over any digest (never do
// that with a real key: it gives the key away; this one is thrown away with the test). Found once with a random search.
const K30 = 0x47f757e29e14792f85437a51a75f64c4da02da313882c992bad085ccf8fa581bn;
const R30 = md(pmul(K30, P256.g)![0], P256.n);
function ecdsaDigest(key: crypto.KeyObject, digest: Buffer): Buffer {
  const d = bigOf(Buffer.from(key.export({ format: 'jwk' }).d!, 'base64url'));
  const sv = md(inv(K30, P256.n) * (bigOf(digest) + R30 * d), P256.n);
  return Buffer.concat([be32(R30), be32(sv)]);
}

function answer(res: http.ServerResponse, status: number, body: any) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', async () => {
    if (fake.down) return req.socket.destroy();
    const p = new URL(req.url || '/', base).pathname;
    let body: any = null;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return answer(res, 400, { error: 'invalid_request' });
    }
    fake.calls.push({ path: p, body, raw, auth: req.headers.authorization || null });
    if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
    if (p === '/oauth2/token') {
      if (body.grant_type !== 'password' || body.client_id !== 'test-client' || body.username !== 'operator' || body.password !== 'right password') return answer(res, 401, { error: 'invalid_grant', error_description: 'Invalid username or password' });
      const t = crypto.randomBytes(12).toString('hex');
      fake.tokens.add(t);
      return answer(res, 200, { access_token: t, token_type: 'Bearer', expires_in: fake.expiresIn });
    }
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!fake.tokens.has(t)) return answer(res, 401, { error: 'invalid_token' });
    if (p === '/csc/v0/credentials/list') return answer(res, 200, { credentialIDs: body.clientData === 'DS_ESEAL' ? ['cred-eseal-1'] : [] });
    if (p === '/csc/v0/credentials/info') {
      if (body.credentialID !== 'cred-eseal-1') return answer(res, 400, { error: 'invalid_request', error_description: 'unknown credential' });
      return answer(res, 200, { key: { status: 'enabled', algo: fake.ec30 ? ['1.2.840.10045.4.3.2'] : ['1.2.840.113549.1.1.11'], len: 2048 }, cert: { status: 'valid', certificates: [fake.leaf || leaf, inter, root].map((c) => c.der.toString('base64')) }, authMode: fake.authMode, SCAL: '1', multisign: true });
    }
    if (p === '/csc/v0/credentials/authorize') {
      if (fake.authMode === 'explicit' && body.OTP !== totp(fake.totpSecret)) return answer(res, 400, { error: 'invalid_otp', error_description: 'The OTP is invalid' });
      return answer(res, 200, { SAD: Buffer.from(JSON.stringify({ hash: body.hash })).toString('base64') });
    }
    if (p === '/csc/v0/signatures/signHash') {
      const sad = JSON.parse(Buffer.from(body.SAD, 'base64').toString());
      if (JSON.stringify(sad.hash) !== JSON.stringify(body.hash)) return answer(res, 400, { error: 'invalid_request', error_description: 'hash not authorized' });
      // RSA PKCS #1 v1.5 over the digest it was sent: the DigestInfo is made here, as an HSM does.
      const digest = Buffer.from(body.hash[0], 'base64');
      if (fake.ec30) return answer(res, 200, { signatures: [ecdsaDigest((fake.leaf || leaf).key, digest).toString('base64')] });
      const info = Buffer.concat([Buffer.from('3031300d060960864801650304020105000420', 'hex'), digest]);
      let sig = crypto.privateEncrypt({ key: (fake.leaf || leaf).key, padding: crypto.constants.RSA_PKCS1_PADDING }, info);
      if (fake.badSignature) sig = Buffer.from(sig.map((b, i) => (i === 10 ? b ^ 1 : b)));
      return answer(res, 200, { signatures: [sig.toString('base64')] });
    }
    answer(res, 404, { error: 'not found' });
  });
}

const cscEnv = (more: Record<string, string> = {}) => ({
  SEAL_CSC_URL: `${base}/csc/v0`, SEAL_CSC_TOKEN_URL: `${base}/oauth2/token`, SEAL_CSC_CLIENT_ID: 'test-client', SEAL_CSC_CLIENT_SECRET: 'test-secret',
  SEAL_CSC_USERNAME: 'operator', SEAL_CSC_PASSWORD: 'right password', ...more,
});
const reset = () => {
  fake.calls = [];
  fake.tokens.clear();
  Object.assign(fake, { expiresIn: 3600, authMode: 'implicit', totpSecret: '', delayMs: 0, down: false, badSignature: false, leaf: null, ec30: false });
};
const calls = (p: string) => fake.calls.filter((c) => c.path.endsWith(p));

let n = 0;
async function complete(): Promise<{ id: string; pdf: Buffer; c: Client }> {
  n++;
  const c = await signUp(`Cloud Sealer ${n}`, `cloudsealer${n}@example.com`, `198.51.100.${100 + n}`);
  const e = await simple(c, `cloudsigner${n}@example.com`);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, `cloudsigner${n}@example.com`)).status, 200);
  const row = s.db.get('SELECT status, final_sha256 FROM envelopes WHERE id=?', e.id);
  assert.equal(row.status, 'completed');
  return { id: e.id, pdf: s.db.readBlob(row.final_sha256), c };
}
const cmsOf = (pdf: Buffer) => {
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(pdf.toString('latin1'))!;
  const r = m.slice(1).map(Number);
  const d = Buffer.from(pdf.subarray(r[1] + 1, r[2] - 1).toString('latin1'), 'hex');
  return { cms: d.subarray(0, der.read(d).end), covered: Buffer.concat([pdf.subarray(0, r[1]), pdf.subarray(r[2], r[2] + r[3])]) };
};
const pdfsig = (file: string) => {
  try {
    return execFileSync('pdfsig', [file], { encoding: 'utf8' });
  } catch (e: any) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
};
const auditOf = (id: string) => s.db.all('SELECT action, detail FROM audit WHERE envelope_id=? ORDER BY seq', id) as { action: string; detail: string }[];

// Captures what the server says to its operators (console.error) while `fn` runs.
async function told<T>(fn: () => Promise<T>): Promise<{ out: T; said: string }> {
  const real = console.error;
  let said = '';
  console.error = (...a: any[]) => void (said += a.join(' ') + '\n');
  try {
    return { out: await fn(), said };
  } finally {
    console.error = real;
  }
}

before(async () => {
  s = await boot();
  sealkey = await import('../src/server/sealkey.ts');
  csc = await import('../src/server/sealcsc.ts');
  seal = await import('../src/server/seal.ts');
  sealcms = await import('../src/server/sealcms.ts');
  der = await import('../src/server/der.ts');
  root = makeCert({ cn: 'Throwaway Cloud Root CA', ca: true });
  inter = makeCert({ cn: 'Throwaway Document Signing CA', ca: true, issuer: root });
  leaf = makeCert({ cn: 'Example Operator Cloud Seal', issuer: inter, ku: 0xc0 });
  tsaRoot = makeCert({ cn: 'Throwaway TSA Root', ca: true });
  tsa = makeCert({ cn: 'Throwaway Time-Stamp Unit', issuer: tsaRoot, ku: 0xc0, eku: [TIME_STAMPING], ekuCritical: true });
  server = http.createServer(handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  settings({});
  await new Promise((r) => server.close(r));
  server.closeAllConnections?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- A: the cloud seal --------------------------------------------------------------------------

test('a completed PDF is sealed by the cloud service: pdfsig and openssl say it holds, the whole chain is in it, and the screens name its certificate', async () => {
  reset();
  settings(cscEnv());
  const { id, pdf, c } = await complete();
  const row = s.db.get('SELECT seal_level, seal_cert FROM envelopes WHERE id=?', id);
  assert.equal(row.seal_level, 'B-B');
  assert.equal(row.seal_cert, crypto.createHash('sha256').update(leaf.der).digest('hex'));
  // Signed in once, the credential found by listing eSealing ones first, the chain fetched once, one seal.
  assert.equal(calls('/oauth2/token').length, 1);
  assert.deepEqual(calls('/credentials/list').map((x) => x.body), [{ clientData: 'DS_ESEAL' }]);
  assert.equal(calls('/credentials/info').length, 1);
  assert.equal(calls('/credentials/authorize').length, 1);
  assert.equal(calls('/signatures/signHash').length, 1);
  assert.equal(calls('/oauth2/token')[0].body.client_secret, 'test-secret');
  // The CMS: our signed attributes, signed with sha256WithRSAEncryption, and the seal certificate with its whole chain.
  const { cms, covered } = cmsOf(pdf);
  const sd = sealcms.parseSignedData(cms);
  assert.equal(sd.signers[0].signatureAlgorithm, '1.2.840.113549.1.1.11');
  assert.deepEqual(sd.certificates.map((d) => d.toString('base64')), [leaf, inter, root].map((x) => x.der.toString('base64')));
  const chk = (await seal.checkSeal(pdf))!;
  assert.equal(chk.intact, true);
  assert.equal(chk.whole_file, true);
  assert.equal(chk.ours, true);
  assert.equal(chk.name, 'Example Operator Cloud Seal');
  assert.equal(chk.issuer, 'Throwaway Document Signing CA');
  if (PDFSIG) {
    const out = pdfsig(write('cloud.pdf', pdf));
    assert.match(out, /Signature Validation: Signature is Valid\./);
    assert.match(out, /Example Operator Cloud Seal/);
    assert.match(out, /Total document signed/);
  }
  if (OPENSSL) execFileSync('openssl', ['cms', '-verify', '-inform', 'DER', '-in', write('cloud.der', cms), '-binary', '-content', write('cloud.bin', covered), '-CAfile', write('cloudroot.pem', root.pem), '-purpose', 'any', '-out', os.devNull], { stdio: 'pipe' });
  // The record and the admins' status line (GET /seal) name the certificate and issuer from the service's chain.
  const line = auditOf(id).find((a) => /^Sealed by /.test(a.action))!;
  assert.equal(line.action, 'Sealed by Example Operator Cloud Seal');
  assert.match(line.detail, /issued by Throwaway Document Signing CA/);
  const st = (await c.get('/seal')).data;
  assert.equal(st.on, true);
  assert.equal(st.by, 'Example Operator Cloud Seal');
  assert.equal(st.issuer, 'Throwaway Document Signing CA');
});

test('only the fingerprint leaves the server: the two signing calls carry the SHA-256 of the seal\'s signed attributes and nothing of the document', async () => {
  reset();
  settings(cscEnv({ SEAL_CSC_CREDENTIAL_ID: 'cred-eseal-1' }));
  const { pdf } = await complete();
  // With the credential set, nothing is listed.
  assert.equal(calls('/credentials/list').length, 0);
  const sd = sealcms.parseSignedData(cmsOf(pdf).cms);
  const fingerprint = crypto.createHash('sha256').update(sd.signers[0].signedAttrsDer!).digest('base64');
  for (const k of ['/credentials/authorize', '/signatures/signHash']) {
    const [call] = calls(k);
    assert.deepEqual(call.body.hash, [fingerprint], `${k} is sent the fingerprint`);
    assert.equal(call.body.credentialID, 'cred-eseal-1');
    assert.deepEqual(Object.keys(call.body).sort(), k.endsWith('authorize') ? ['credentialID', 'hash', 'numSignatures'] : ['SAD', 'credentialID', 'hash', 'hashAlgo', 'signAlgo']);
    assert.ok(call.raw.length < 2000, `${k}: a small request (${call.raw.length} bytes)`);
  }
  assert.equal(calls('/signatures/signHash')[0].body.hashAlgo, '2.16.840.1.101.3.4.2.1');
  assert.equal(calls('/signatures/signHash')[0].body.signAlgo, '1.2.840.113549.1.1.11');
  assert.equal(calls('/credentials/authorize')[0].body.numSignatures, 1);
  // No request to the service carries any part of the PDF, or its own fingerprint.
  const fileHash = crypto.createHash('sha256').update(cmsOf(pdf).covered).digest();
  for (const call of fake.calls) {
    assert.ok(!call.raw.includes('%PDF') && !call.raw.includes(fileHash.toString('base64')) && !call.raw.includes(fileHash.toString('hex')), call.path);
    assert.ok(!/JVBER/.test(call.raw), 'no PDF in base64');
  }
});

test('the access token is kept until it expires and fetched again then, and again when the service stops taking it', async () => {
  reset();
  settings(cscEnv());
  await complete();
  await complete();
  assert.equal(calls('/oauth2/token').length, 1, 'one token for two seals');
  assert.equal(calls('/credentials/info').length, 1, 'the chain is fetched once');
  // A token that lives 2 seconds is used for one second, then fetched again.
  fake.expiresIn = 2;
  csc.forgetCsc();
  sealkey.forgetSealKey();
  fake.calls = [];
  await complete();
  await new Promise((r) => setTimeout(r, 1200));
  await complete();
  assert.equal(calls('/oauth2/token').length, 2, 'fetched again after it expired');
  // The service forgets every token (a restart on its side): the next call answers 401, a new one is fetched, the seal holds.
  fake.expiresIn = 3600;
  await complete();
  fake.tokens.clear();
  fake.calls = [];
  const { id, pdf } = await complete();
  assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, 'B-B');
  assert.equal((await seal.checkSeal(pdf))!.intact, true);
  assert.equal(calls('/oauth2/token').length, 1);
  assert.ok(fake.calls.some((x) => x.path.endsWith('/authorize')));
});

test('the chain is fetched again after a day; meanwhile the one from before keeps sealing', async () => {
  reset();
  settings(cscEnv());
  await complete();
  assert.equal(calls('/credentials/info').length, 1);
  const g = (globalThis as any).__sgCsc;
  g.material.fetchedAt -= csc.CSC_CHAIN_REFRESH_MS + 1000;
  await complete();
  // The refresh may still be under way when the second seal is made; wait for it.
  await (globalThis as any).__sgCsc.loading;
  assert.equal(calls('/credentials/info').length, 2);
});

test('a credential that needs a one-time code: the right code seals, a wrong secret completes without a seal and says why', async () => {
  reset();
  fake.authMode = 'explicit';
  fake.totpSecret = TOTP;
  // No secret: refused before anyone signs, with words the operator can act on.
  settings(cscEnv());
  await csc.cscReady();
  const st = sealkey.sealState();
  assert.equal(st.on, false);
  assert.match((st as any).why, /needs a one-time code[\s\S]*SEAL_CSC_TOTP_SECRET/);
  // The right secret.
  settings(cscEnv({ SEAL_CSC_TOTP_SECRET: TOTP }));
  const ok = await complete();
  assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', ok.id).seal_level, 'B-B');
  assert.equal(calls('/credentials/authorize').at(-1)!.body.OTP, totp(TOTP));
  assert.equal(csc.totpCode(TOTP), totp(TOTP));
  // A wrong one: the document completes exactly as "Not sealed", and the reason goes to the operators.
  settings(cscEnv({ SEAL_CSC_TOTP_SECRET: Buffer.from('the wrong secret').toString('base64') }));
  const { out, said } = await told(() => complete());
  const row = s.db.get('SELECT seal_level, final_sha256 FROM envelopes WHERE id=?', out.id);
  assert.equal(row.seal_level, null);
  assert.ok(!out.pdf.toString('latin1').includes('/ByteRange'), 'no seal in the file');
  assert.ok(auditOf(out.id).some((a) => a.action === 'Not sealed'));
  assert.match(said, /one-time code may be wrong[\s\S]*SEAL_CSC_TOTP_SECRET/);
  // RFC 6238 test vector (SHA-1, 8 digits there; the last 6 here): secret "12345678901234567890" at 59 seconds.
  assert.equal(csc.totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');
});

test('a service that is down, slow, or answers a signature that does not hold: the file completes without a seal, at once, and the reason is logged', async () => {
  for (const [what, set, want] of [
    ['down', () => (fake.down = true), /could not be reached|did not answer/],
    ['slow', () => (fake.delayMs = 6000), /did not answer within 4 seconds/],
    ['a bad signature', () => (fake.badSignature = true), /does not verify with the seal certificate/],
  ] as const) {
    reset();
    settings(cscEnv());
    await csc.cscReady(); // the chain was fetched while the service was well
    set();
    const t0 = Date.now();
    const { out, said } = await told(() => complete());
    const took = Date.now() - t0;
    assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', out.id).seal_level, null, what);
    assert.ok(!out.pdf.toString('latin1').includes('/ByteRange'), `${what}: the file has no seal`);
    assert.ok(auditOf(out.id).some((a) => a.action === 'Not sealed' && /the seal could not be applied/.test(a.detail)), what);
    assert.match(said, want, what);
    assert.match(said, /Completed PDFs are not being sealed|could not be sealed/, what);
    assert.ok(took < 20_000, `${what}: the last signer waited ${took} ms`);
  }
  // Down before the chain was ever fetched: refused, said, and the file still completes.
  reset();
  fake.down = true;
  settings(cscEnv());
  const { out, said } = await told(() => complete());
  assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', out.id).seal_level, null);
  assert.ok(auditOf(out.id).some((a) => a.action === 'Not sealed'));
  assert.match(said, /could not be fetched from the signing service/);
  reset();
});

test('half-set settings are refused and said once at startup by name; a key file and a cloud seal together are refused; the outside list follows the settings', async () => {
  const lib = await import('../src/lib/seal.ts');
  const outside = await import('../src/lib/outside.ts');
  settings({ SEAL_CSC_CLIENT_ID: 'test-client' });
  const lines = csc.cscStartLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[config\] The cloud seal is half set up: SEAL_CSC_USERNAME, SEAL_CSC_PASSWORD are not set\./);
  assert.ok(!/test-client/.test(lines[0]), 'no value is repeated');
  assert.equal(sealkey.sealState().on, false);
  assert.deepEqual(lib.cscSettings().missing, ['SEAL_CSC_USERNAME', 'SEAL_CSC_PASSWORD']);
  const off = outside.outsideServices(process.env).find((x) => x.id === 'seal')!;
  assert.equal(off.on, false);
  assert.deepEqual(off.hosts, []);
  // A half set completes the file without a seal, and the record says so.
  const { out } = await told(() => complete());
  assert.ok(auditOf(out.id).some((a) => a.action === 'Not sealed'));
  // Both kinds at once.
  settings({ ...cscEnv(), SEAL_KEY_PEM: leaf.keyPem, SEAL_CERT_PEM: leaf.pem });
  assert.match(csc.cscStartLines()[0], /Both a seal key file .* and a cloud seal .* are set\. Set one of the two\./);
  // Plain http is refused for any host but this machine.
  settings(cscEnv({ SEAL_CSC_URL: 'http://cs.example.com/csc/v0' }));
  assert.match(csc.cscStartLines()[0], /SEAL_CSC_URL must be an https address/);
  // Complete: the two hosts are listed, as /security and the [outside] line show them.
  const on = outside.outsideServices({ SEAL_CSC_CLIENT_ID: 'a', SEAL_CSC_USERNAME: 'b', SEAL_CSC_PASSWORD: 'c' }).find((x) => x.id === 'seal')!;
  assert.equal(on.on, true);
  assert.deepEqual(on.hosts, ['cs.ssl.com', 'login.ssl.com']);
  assert.match(outside.outsideStartLines({ SEAL_CSC_CLIENT_ID: 'a', SEAL_CSC_USERNAME: 'b', SEAL_CSC_PASSWORD: 'c' })[0], /cs\.ssl\.com, login\.ssl\.com \(cloud signing service/);
  assert.match(on.purpose, /never the document/);
  // OUTSIDE_CALLS=none takes every cloud seal setting away, so none is left half set.
  const env: any = { OUTSIDE_CALLS: 'none', SEAL_CSC_CLIENT_ID: 'a', SEAL_CSC_USERNAME: 'b', SEAL_CSC_PASSWORD: 'c', SEAL_CSC_TOTP_SECRET: 'd', SEAL_CSC_CREDENTIAL_ID: 'e' };
  outside.applyOutsideCalls(env);
  assert.equal(lib.cscSettings(env).any, false);
  settings({});
  assert.deepEqual(csc.cscStartLines(), []);
});

// ---- B: time stamps -----------------------------------------------------------------------------

// A fetch that sends the fake CSC service's calls on and answers time-stamp requests from the throwaway TSA.
function withTsa(answer: (req: Buffer) => Buffer | number) {
  const real = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input?.url || input);
    if (url.startsWith(base)) return real(input, init);
    asked++;
    const a = answer(Buffer.from(init?.body || []));
    if (typeof a === 'number') return new Response('no', { status: a });
    return new Response(new Uint8Array(a), { status: 200, headers: { 'content-type': 'application/timestamp-reply' } });
  }) as any;
  return { asked: () => asked, restore: () => void (globalThis.fetch = real) };
}

test('without a seal, a time-stamp service puts a document time stamp over the whole completed PDF; when it fails the file goes out as before and the record says why', async () => {
  reset();
  settings({ TSA_URL: 'https://tsa.test/stamp', TSA_TRUST: write('tsa-trust.pem', tsaRoot.pem) });
  const stub = withTsa((req) => tsaAnswer(req, tsa, [tsaRoot]));
  try {
    const { id, pdf } = await complete();
    const t = pdf.toString('latin1');
    assert.match(t, /\/Type \/DocTimeStamp/);
    assert.match(t, /\/SubFilter \/ETSI\.RFC3161/);
    const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(t)!;
    assert.equal(Number(m[3]) + Number(m[4]), pdf.length, 'it covers the whole file');
    const line = auditOf(id).find((a) => a.action === 'Time-stamped')!;
    assert.match(line.detail, /Throwaway Time-Stamp Unit \(tsa\.test\)/);
    assert.match(line.detail, /leads to one this server was set up to trust/);
    assert.match(line.detail, /It is not a seal/);
    assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, null, 'it is not called a seal');
    if (PDFSIG) {
      const out = pdfsig(write('ts-only.pdf', pdf));
      // poppler lists a document time stamp without checking it (it says "unknown"); openssl checks it below.
      assert.match(out, /Signature Field Name: Time stamp/);
      assert.match(out, /Total document signed/);
    }
    if (OPENSSL) {
      const { cms, covered } = cmsOf(pdf);
      const digest = crypto.createHash('sha256').update(covered).digest('hex');
      assert.match(execFileSync('openssl', ['ts', '-verify', '-in', write('doc-ts.der', cms), '-token_in', '-digest', digest, '-CAfile', write('tsaroot.pem', tsaRoot.pem)], { encoding: 'utf8', stdio: 'pipe' }), /Verification: OK/);
    }
  } finally {
    stub.restore();
  }
  const down = withTsa(() => 503);
  try {
    const { id, pdf } = await complete();
    assert.ok(!pdf.toString('latin1').includes('/ByteRange'), 'the file as it was rendered');
    assert.match(auditOf(id).find((a) => a.action === 'Not time-stamped')!.detail, /answered HTTP 503/);
  } finally {
    down.restore();
  }
});

test('a cloud seal with a time-stamp service is B-T, and its time stamp is over the signature the service made', async () => {
  reset();
  settings(cscEnv({ TSA_URL: 'https://tsa.test/stamp', TSA_TRUST: write('tsa-trust2.pem', tsaRoot.pem) }));
  const stub = withTsa((req) => tsaAnswer(req, tsa, [tsaRoot]));
  try {
    const { id, pdf } = await complete();
    assert.equal(s.db.get('SELECT seal_level, seal_tsa FROM envelopes WHERE id=?', id).seal_level, 'B-T');
    const chk = (await seal.checkSeal(pdf))!;
    assert.equal(chk.intact, true);
    assert.equal(chk.level, 'B-T');
    assert.ok(chk.timestamp_at);
    if (PDFSIG) assert.match(pdfsig(write('cloud-bt.pdf', pdf)), /Signature is Valid/);
  } finally {
    stub.restore();
  }
});

test('TSA_TRUST=bundled: the built-in roots are the ones in deploy/tsa-roots.pem, with the fingerprints DigiCert and SSL.com publish, and a copy of a root issued by an older root still leads to it', async () => {
  const { BUNDLED_TSA_ROOTS, BUNDLED_TSA_FINGERPRINTS } = await import('../src/server/tsaroots.ts');
  const tsaMod = await import('../src/server/tsa.ts');
  const blocks = (t: string) => [...t.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map((m) => m[0].replace(/\s+/g, ''));
  const file = fs.readFileSync(path.join(import.meta.dirname, '..', 'deploy', 'tsa-roots.pem'), 'utf8');
  assert.deepEqual(blocks(file), blocks(BUNDLED_TSA_ROOTS));
  const fps = blocks(BUNDLED_TSA_ROOTS).map((b) => new crypto.X509Certificate(b.replace('-----BEGINCERTIFICATE-----', '-----BEGIN CERTIFICATE-----\n').replace('-----ENDCERTIFICATE-----', '\n-----END CERTIFICATE-----')).fingerprint256.replace(/:/g, ''));
  assert.deepEqual(fps, BUNDLED_TSA_FINGERPRINTS);
  for (const fp of BUNDLED_TSA_FINGERPRINTS) assert.ok(file.includes(fp.match(/../g)!.join(':')), `the file names ${fp}`);
  settings({ TSA_TRUST: 'bundled' });
  assert.deepEqual(tsaMod.trustCerts()!.map((c) => c.name), ['DigiCert Trusted Root G4', 'DigiCert Assured ID Root CA', 'SSL.com Root Certification Authority RSA']);
  settings({ TSA_TRUST: ' Bundled ' });
  assert.equal(tsaMod.trustCerts()!.length, 3);
  // DigiCert's service sends its root as a copy issued by an older root. With only the new root listed, it still leads there.
  const oldRoot = makeCert({ cn: 'Old Root', ca: true });
  const newRoot = makeCert({ cn: 'New Root', ca: true });
  const cross = makeCert({ cn: 'New Root', ca: true, key: newRoot.key, issuer: oldRoot });
  const issuing = makeCert({ cn: 'Issuing TSA CA', ca: true, issuer: newRoot });
  const unit = makeCert({ cn: 'Unit', issuer: issuing, ku: 0xc0, eku: [TIME_STAMPING], ekuCritical: true });
  const imprint = crypto.createHash('sha256').update('x').digest();
  const nonce = Buffer.from('0102030405060708', 'hex');
  const ans = tsaAnswer(tsaMod.timeStampRequest(imprint, nonce), unit, [issuing, cross]);
  const x509 = await import('../src/server/x509.ts');
  assert.equal(tsaMod.checkAnswer(ans, imprint, nonce, [x509.readCert(newRoot.der)]).trusted, true);
  assert.throws(() => tsaMod.checkAnswer(ans, imprint, nonce, [x509.readCert(makeCert({ cn: 'Stranger', ca: true }).der)]), /does not lead to one in TSA_TRUST/);
  settings({});
});

// ---- After review: paid signings, time-stamp seconds, alerts, a renewed key, the token, codes ---------------------

const signs = () => calls('/signatures/signHash').length;

test('a slow but working signing service does not use up the seconds for the seal\'s time stamp: B-T with one signing', async () => {
  reset();
  settings(cscEnv({ TSA_URL: 'https://tsa.test/stamp', TSA_TRUST: write('tsa-trust3.pem', tsaRoot.pem) }));
  const stub = withTsa((req) => tsaAnswer(req, tsa, [tsaRoot]));
  try {
    await complete(); // warm: token and chain kept
    fake.calls = [];
    // 2.5 seconds for each of authorize and signHash: 5 seconds at the service, more than the 4 for time stamps.
    fake.delayMs = 2500;
    const { id } = await complete();
    const row = s.db.get('SELECT seal_level, seal_tsa FROM envelopes WHERE id=?', id);
    assert.equal(row.seal_level, 'B-T');
    assert.equal(row.seal_tsa, 'trusted');
    assert.equal(signs(), 1, 'signed once');
    assert.equal(calls('/credentials/authorize').length, 1);
  } finally {
    stub.restore();
    reset();
  }
});

test('when the time stamp fails after a cloud signature, the same signature is kept at B-B with the reason: never a second paid signing, and the certificate said so beforehand', async () => {
  reset();
  settings(cscEnv({ TSA_URL: 'https://tsa.test/stamp', TSA_TRUST: write('tsa-trust4.pem', tsaRoot.pem) }));
  await csc.cscReady();
  // What the certificate of completion says for a cloud seal that asks for a time stamp: true with it and without.
  const plan = seal.sealPlan()!;
  assert.equal(plan.level, 'B-T');
  const line = seal.sealLineFor({ seal_plan: plan })!;
  assert.match(line, /asks a time-stamp service for a trusted time stamp/);
  assert.match(line, /When no service answers in time, the seal carries none and its time is this server's clock/);
  assert.doesNotMatch(line, /carries a trusted time stamp/);
  const down = withTsa(() => 503);
  try {
    fake.calls = [];
    const { id, pdf } = await complete();
    const row = s.db.get('SELECT seal_level, seal_tsa FROM envelopes WHERE id=?', id);
    assert.equal(row.seal_level, 'B-B');
    assert.equal(row.seal_tsa, null);
    assert.equal(signs(), 1, 'one signing, not two');
    const chk = (await seal.checkSeal(pdf))!;
    assert.equal(chk.intact, true);
    assert.equal(chk.whole_file, true);
    assert.equal(chk.level, 'B-B');
    const sealed = auditOf(id).find((a) => /^Sealed by /.test(a.action))!;
    assert.match(sealed.detail, /The time in the seal is this server's clock\. The time-stamp service could not give a time stamp: .*answered HTTP 503/);
    if (PDFSIG) assert.match(pdfsig(write('cloud-bb.pdf', pdf)), /Signature is Valid/);
  } finally {
    down.restore();
  }
  // A key file (free to sign with) keeps the old way: sealed again at B-B under a certificate that says so.
  settings({ SEAL_KEY_PEM: leaf.keyPem, SEAL_CERT_PEM: leaf.pem, SEAL_CHAIN_PEM: inter.pem + root.pem, TSA_URL: 'https://tsa.test/stamp', TSA_TRUST: write('tsa-trust5.pem', tsaRoot.pem) });
  const p2 = seal.sealPlan()!;
  assert.doesNotMatch(seal.sealLineFor({ seal_plan: p2 })!, /asks a time-stamp service/);
  settings({});
});

test('two builds of the same completed file wait for each other (the timer and the last Finish): one signing', async () => {
  reset();
  settings(cscEnv());
  const { id } = await complete();
  const env = await import('../src/server/envelopes.ts');
  s.db.run('UPDATE envelopes SET final_sha256=NULL, final_size=NULL WHERE id=?', id);
  fake.calls = [];
  fake.delayMs = 300;
  const [a, b] = await Promise.all([env.buildFinal(id), env.buildFinal(id)]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(signs(), 1);
  assert.ok(s.db.get('SELECT final_sha256 FROM envelopes WHERE id=?', id).final_sha256);
  reset();
});

test('a render that is thrown away (it could not be made PDF/A) is not sealed or time-stamped', async () => {
  reset();
  settings(cscEnv({ TSA_URL: 'https://tsa.test/stamp' }));
  const stub = withTsa((req) => tsaAnswer(req, tsa, [tsaRoot]));
  try {
    const { id } = await complete();
    const fp = await import('../src/server/finalpipe.ts');
    const pdfa = await import('../src/server/pdfa.ts');
    fake.calls = [];
    const asked = stub.asked();
    const page = new Uint8Array(Buffer.from('%PDF-1.7 thrown away'));
    pdfa.discarded.add(page);
    const e = s.db.get('SELECT * FROM envelopes WHERE id=?', id);
    const out = await fp.finishPdf({ ...e, id: 'env_none_' + id }, async () => page);
    assert.equal(out, page);
    assert.equal(signs(), 0);
    assert.equal(stub.asked(), asked, 'no time stamp asked for');
  } finally {
    stub.restore();
    settings({});
  }
});

test('while the service is down, the operators are told once for the reason, not once per document; the log names each document', async () => {
  reset();
  settings(cscEnv());
  await csc.cscReady();
  fake.down = true;
  s.db.run("UPDATE support_requests SET status='closed' WHERE message LIKE 'Completed PDFs are not being sealed%'");
  const before = s.db.get("SELECT COUNT(*) n FROM support_requests WHERE message LIKE 'Completed PDFs are not being sealed%'").n;
  const { out: a, said: sa } = await told(() => complete());
  const { out: b, said: sb } = await told(() => complete());
  const { out: c, said: sc } = await told(() => complete());
  assert.equal(s.db.get("SELECT COUNT(*) n FROM support_requests WHERE message LIKE 'Completed PDFs are not being sealed%'").n, before + 1, 'one alert');
  for (const [x, said] of [[a, sa], [b, sb], [c, sc]] as const) assert.match(said, new RegExp(`envelope ${x.id} was completed without a seal`));
  assert.doesNotMatch(sb + sc, /\[seal\] Completed PDFs are not being sealed/, 'the alert is not repeated');
  reset();
});

test('a key renewed behind the same credential: the first seal fails the check and the chain is fetched again, so the next one seals with the new certificate', async () => {
  reset();
  settings(cscEnv());
  await complete();
  assert.equal(calls('/credentials/info').length, 1);
  // SSL.com renews the key: it now signs with a new one, and its chain names the new certificate.
  fake.leaf = makeCert({ cn: 'Example Operator Cloud Seal 2027', issuer: inter, ku: 0xc0 });
  const { out: first, said } = await told(() => complete());
  assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', first.id).seal_level, null, 'the one signature that did not verify is not used');
  assert.match(said, /does not verify with the seal certificate[\s\S]*fetched again/);
  const { id, pdf } = await complete();
  assert.equal(calls('/credentials/info').length, 2, 'fetched again before the next seal, not a day later');
  assert.equal(s.db.get('SELECT seal_cert FROM envelopes WHERE id=?', id).seal_cert, crypto.createHash('sha256').update(fake.leaf.der).digest('hex'));
  assert.equal((await seal.checkSeal(pdf))!.name, 'Example Operator Cloud Seal 2027');
  reset();
});

test('seals that start together share one password grant; a token refused once is fetched again only once', async () => {
  reset();
  settings(cscEnv());
  await csc.cscReady();
  const key = (sealkey.sealState() as any).key;
  const msg = (i: number) => Buffer.from(`attributes ${i}`);
  const go = () => Promise.all([0, 1, 2, 3].map((i) => key.signer.sign(crypto.createHash('sha256').update(msg(i)).digest(), msg(i))));
  (globalThis as any).__sgCsc.token = undefined;
  fake.calls = [];
  await go();
  assert.equal(calls('/oauth2/token').length, 1, 'one grant for four seals');
  // The service forgets the token: four 401s, one new grant.
  fake.tokens.clear();
  fake.calls = [];
  await go();
  assert.equal(calls('/oauth2/token').length, 1);
  assert.equal(signs(), 4);
  reset();
});

test('an ECDSA credential that answers the raw form of a signature starting with byte 0x30 still seals', async () => {
  reset();
  fake.ec30 = true;
  fake.leaf = makeCert({ cn: 'Example Operator EC Seal', issuer: inter, ku: 0xc0, ec: true });
  assert.equal(ecdsaDigest(fake.leaf.key, Buffer.alloc(32))[0], 0x30);
  settings(cscEnv());
  for (let i = 0; i < 2; i++) {
    const { out: { id, pdf }, said } = await told(() => complete());
    assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, 'B-B', said);
    const sd = sealcms.parseSignedData(cmsOf(pdf).cms);
    assert.equal(sd.signers[0].signatureAlgorithm, '1.2.840.10045.4.3.2');
    assert.equal((await seal.checkSeal(pdf))!.intact, true);
  }
  assert.equal(calls('/signatures/signHash')[0].body.signAlgo, '1.2.840.10045.4.3.2');
  reset();
});

test('with one-time codes, a code refused just as its 30 seconds end is tried once more with the next one', async () => {
  reset();
  fake.authMode = 'explicit';
  fake.totpSecret = TOTP;
  settings(cscEnv({ SEAL_CSC_TOTP_SECRET: TOTP }));
  await csc.cscReady();
  const key = (sealkey.sealState() as any).key;
  const msg = Buffer.from('attributes at the edge');
  const real = Date.now;
  // The clock starts just before a 30-second step ends and moves 10 ms each time it is read: the first code is read
  // in the old step, and the service (same clock) checks it in the new one.
  const end = (Math.floor(real() / 30_000) + 1) * 30_000;
  let t = end - 25;
  Date.now = () => (t += 10);
  try {
    fake.calls = [];
    await key.signer.sign(crypto.createHash('sha256').update(msg).digest(), msg);
  } finally {
    Date.now = real;
  }
  const otps = calls('/credentials/authorize').map((c) => c.body.OTP);
  assert.equal(otps.length, 2);
  assert.notEqual(otps[0], otps[1]);
  assert.equal(signs(), 1);
  reset();
});

test('the outside list names every setting the cloud seal sends, the client secret included', async () => {
  const outside = await import('../src/lib/outside.ts');
  const on = outside.outsideServices({ SEAL_CSC_CLIENT_ID: 'a', SEAL_CSC_USERNAME: 'b', SEAL_CSC_PASSWORD: 'c' }).find((x) => x.id === 'seal')!;
  assert.match(on.purpose, /client secret/);
  for (const k of ['SEAL_CSC_CLIENT_SECRET', 'SEAL_CSC_CREDENTIAL_ID', 'SEAL_CSC_TOTP_SECRET', 'SEAL_CSC_CLIENT_ID', 'SEAL_CSC_USERNAME', 'SEAL_CSC_PASSWORD']) assert.ok(on.settings.includes(k), k);
});
