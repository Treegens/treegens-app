// The owner's sealing spec, line by line, against what the server does (src/server/pdfsealer.ts and the files it
// names): the second names of the settings and PDF_SIGNING_MODE (src/lib/sealenv.ts), the dev certificate
// (scripts/dev-seal-cert.mjs) and its refusal on a production server, the facade and its retry rules, the certificate
// of completion, and the proof that nothing changes a byte of a sealed file after it is stored. A fetch stub stands in
// for the time-stamp service, the revocation list and the CSC signing service; nothing reaches the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { boot, signUp, simple, signAll, tokenFor, Client, type Server } from './helpers.ts';
import { makeCert, tsaAnswer, TIME_STAMPING, ext, type Made } from './sealcerts.ts';
import { seq, tagged, integer, oid, bitString, algorithm, utcTime, read, kids, whole } from '../src/server/der.ts';
import { resolveSealEnv, sealModeProblem, signingMode, SEAL_ALIASES } from '../src/lib/sealenv.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-spec-'));
const has = (bin: string, arg = '-v') => {
  try {
    execFileSync(bin, [arg], { stdio: 'ignore' });
    return true;
  } catch (e: any) {
    return e?.code !== 'ENOENT';
  }
};
const OPENSSL = has('openssl', 'version');
const PDFSIG = has('pdfsig');
const PDFTOTEXT = has('pdftotext');
const NO_OPENSSL = !OPENSSL && 'openssl is not installed';

let s: Server;
let sealkey: typeof import('../src/server/sealkey.ts');
let seal: typeof import('../src/server/seal.ts');
let csc: typeof import('../src/server/sealcsc.ts');
let tsaMod: typeof import('../src/server/tsa.ts');
let sealer: typeof import('../src/server/pdfsealer.ts');
let sealenv: typeof import('../src/lib/sealenv.ts');
let paydns: typeof import('../src/server/paydns.ts');
let colcrypt: typeof import('../src/server/colcrypt.ts');
let realLookup: any;
let tsaRoot: Made, tsa: Made, cscRoot: Made, cscLeaf: Made;
let P12 = '';

const SETTINGS = ['PDF_SIGNING_MODE', 'SEAL_P12', 'SEAL_P12_PASSWORD', 'SEAL_KEY_PEM', 'SEAL_CERT_PEM', 'SEAL_CHAIN_PEM', 'TSA_URL', 'TSA_URLS', 'TSA_USER', 'TSA_PASSWORD', 'TSA_TRUST', 'LTV_WAIT_MS',
  'SEAL_CSC_URL', 'SEAL_CSC_TOKEN_URL', 'SEAL_CSC_CLIENT_ID', 'SEAL_CSC_CLIENT_SECRET', 'SEAL_CSC_USERNAME', 'SEAL_CSC_PASSWORD', 'SEAL_CSC_CREDENTIAL_ID', 'SEAL_CSC_TOTP_SECRET',
  'SEAL_ALLOW_SELF_SIGNED', 'CERTIFICATE_SHOWS_DEVICE', ...SEAL_ALIASES.map(([a]) => a)];
const NODE_ENV = process.env.NODE_ENV;
function settings(env: Record<string, string>) {
  for (const k of SETTINGS) delete process.env[k];
  if (NODE_ENV === undefined) delete (process.env as any).NODE_ENV;
  else (process.env as any).NODE_ENV = NODE_ENV;
  Object.assign(process.env, env);
  sealkey.forgetSealKey();
  csc.forgetCsc();
  tsaMod.tsaForgetRests();
  sealenv.forgetSealEnv();
}
const write = (name: string, data: string | Buffer) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, data);
  return f;
};

// ---- One fetch stub for everything outside --------------------------------------------------------------------

type Call = { url: string; path: string; body: Buffer; json: any };
type Answer = Buffer | number | object | Error | Response;
const refusedConnection = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
function stub(answer: (c: Call, nth: number) => Answer | Promise<Answer>) {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input?.url || input);
    const body = Buffer.from(init?.body || []);
    let json: any = null;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      json = null;
    }
    const c = { url, path: new URL(url).pathname, body, json };
    calls.push(c);
    const a = await answer(c, calls.filter((x) => x.url === url).length);
    if (a instanceof Error) throw a;
    if (a instanceof Response) return a;
    if (typeof a === 'number') return new Response('{"error":"down"}', { status: a });
    if (Buffer.isBuffer(a)) return new Response(new Uint8Array(a), { status: 200 });
    return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

const cdp = (url: string) => ext('2.5.29.31', false, seq(seq(tagged(0, tagged(0, tagged(6, Buffer.from(url), true))))));
const subjectOf = (m: Made) => Buffer.from(whole(kids(kids(read(m.der))[0])[5]));
function crlOf(issuer: Made): Buffer {
  const tbs = seq(integer(1), algorithm('1.2.840.113549.1.1.11', null), subjectOf(issuer), utcTime(new Date(Date.now() - 3600_000)), utcTime(new Date(Date.now() + 864e5)));
  return seq(tbs, algorithm('1.2.840.113549.1.1.11', null), bitString(crypto.sign('sha256', tbs, issuer.key)));
}
/** The time-stamp service and the revocation list of its certificate. */
const tsaWorld = (c: Call): Answer => (c.url.includes('tsa.test') ? tsaAnswer(c.body, tsa, [tsaRoot]) : c.url.includes('crl.test') ? crlOf(tsaRoot) : 404);

// A CSC service as the specification describes it (the same fields in 0.1.7.9 and 1.0.3.0). signHash signs the
// digest it is given, as an HSM does: RSA PKCS#1 v1.5 over the DigestInfo of a SHA-256.
const DIGEST_INFO = Buffer.from('3031300d060960864801650304020105000420', 'hex');
function cscWorld(c: Call, how: { fail?: (path: string, nth: number) => Answer | null } = {}): Answer {
  const p = c.path.replace(/^\/csc\/v[01]\//, '').replace(/^\//, '');
  const nth = cscSeen[p] = (cscSeen[p] || 0) + 1;
  const failed = how.fail?.(p, nth);
  if (failed != null) return failed;
  if (p === 'oauth2/token') return { access_token: 'token-1', expires_in: 3600 };
  if (p === 'credentials/info') return { key: { status: 'enabled', algo: ['1.2.840.113549.1.1.11'], len: 2048 }, cert: { status: 'valid', certificates: [cscLeaf.der.toString('base64'), cscRoot.der.toString('base64')] }, authMode: 'implicit' };
  if (p === 'credentials/authorize') return { SAD: `sad-for-${c.json.hash[0]}`, expiresIn: 60 };
  if (p === 'signatures/signHash') return { signatures: [crypto.privateEncrypt({ key: cscLeaf.key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.concat([DIGEST_INFO, Buffer.from(c.json.hash[0], 'base64')])).toString('base64')] };
  return 404;
}
let cscSeen: Record<string, number> = {};
const cscEnv = (base = 'https://csc.test/csc/v1') => ({ PDF_SIGNING_MODE: 'csc', CSC_API_BASE_URL: base, CSC_TOKEN_URL: 'https://csc.test/oauth2/token', CSC_CLIENT_ID: 'client', CSC_CLIENT_SECRET: 'secret', CSC_USERNAME: 'user', CSC_PASSWORD: 'pass', CSC_CREDENTIAL_ID: 'cred-1' });

let n = 0;
async function complete(ua?: string): Promise<{ id: string; pdf: Buffer; sha: string; c: Client; email: string }> {
  n++;
  const c = await signUp(`Spec ${n}`, `spec${n}@example.com`, `198.51.100.${(n % 200) + 20}`);
  const email = `signer${n}@example.com`;
  const e = await simple(c, email);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  if (ua) {
    // The signer's browser says what it is in every request of theirs.
    const signer = new Client();
    const tok = tokenFor(e.id, email);
    await signer.call('POST', `/sign/${tok}/consent`, {}, { 'user-agent': ua });
    const v = (await signer.call('GET', `/sign/${tok}`, undefined, { 'user-agent': ua })).data;
    const values: Record<string, string> = {};
    for (const f of v.fields || []) values[f.id] = f.type === 'text' ? 'filled in' : f.type === 'date' ? '2026-01-15' : '1';
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    assert.equal((await signer.call('POST', `/sign/${tok}/complete`, { values, signature_png: PNG, initials_png: PNG }, { 'user-agent': ua })).status, 200);
  } else assert.equal((await signAll(e.id, email)).status, 200);
  const row = s.db.get('SELECT status, final_sha256 FROM envelopes WHERE id=?', e.id);
  assert.equal(row.status, 'completed');
  assert.ok(row.final_sha256, 'the signed copy was stored');
  return { id: e.id, pdf: s.db.readBlob(row.final_sha256), sha: row.final_sha256, c, email };
}
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const text = (pdf: Uint8Array) => execFileSync('pdftotext', ['-layout', write(`t-${Math.random()}.pdf`, Buffer.from(pdf)), '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
const pdfsig = (pdf: Uint8Array) => {
  try {
    return execFileSync('pdfsig', [write(`f-${Math.random()}.pdf`, Buffer.from(pdf))], { encoding: 'utf8' });
  } catch (e: any) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
};
const byteRanges = (pdf: Buffer) => [...pdf.toString('latin1').matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)].map((m) => m.slice(1).map(Number));
async function samplePdfBytes(): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const d = await PDFDocument.create();
  d.addPage([300, 300]).drawText('a finished file', { x: 20, y: 150, size: 12 });
  return d.save();
}
const audits = (id: string) => s.db.all('SELECT action, detail FROM audit WHERE envelope_id=? ORDER BY seq', id) as { action: string; detail: string }[];

before(async () => {
  s = await boot();
  seal = await import('../src/server/seal.ts');
  sealkey = await import('../src/server/sealkey.ts');
  csc = await import('../src/server/sealcsc.ts');
  tsaMod = await import('../src/server/tsa.ts');
  sealer = await import('../src/server/pdfsealer.ts');
  sealenv = await import('../src/lib/sealenv.ts');
  colcrypt = await import('../src/server/colcrypt.ts');
  tsaRoot = makeCert({ cn: 'Spec TSA Root', ca: true });
  tsa = makeCert({ cn: 'Spec Time-Stamp Unit', issuer: tsaRoot, ku: 0xc0, eku: [TIME_STAMPING], ekuCritical: true, more: [cdp('http://crl.test/tsa.crl')] });
  cscRoot = makeCert({ cn: 'Spec Cloud Root', ca: true });
  cscLeaf = makeCert({ cn: 'Spec Cloud Seal', issuer: cscRoot });
  paydns = await import('../src/server/paydns.ts');
  realLookup = paydns.resolver.lookup;
  paydns.resolver.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  if (OPENSSL) {
    // The dev certificate, made by the one command the README names, in a folder of its own.
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/dev-seal-cert.mjs')], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH! } });
    assert.equal(r.status, 0, r.stderr);
    P12 = path.join(dir, 'certs/dev-seal.p12');
  }
});
after(() => {
  paydns.resolver.lookup = realLookup;
  settings({});
  delete process.env.FILE_ENCRYPTION_KEY;
  delete process.env.FILE_ENCRYPTION_KEYS_OLD;
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 1. The names of the settings and PDF_SIGNING_MODE -------------------------------------------------------

test('1a: each of the owner\'s names fills the seal\'s own name, and the SEAL_ name wins with one line when the two differ', () => {
  const r = resolveSealEnv({ LOCAL_P12_PATH: './certs/dev-seal.p12', LOCAL_P12_PASSWORD: 'changeit', CSC_API_BASE_URL: 'https://cs.ssl.com/csc/v1', CSC_CLIENT_ID: 'id', CSC_CLIENT_SECRET: 'sec', CSC_CREDENTIAL_ID: 'cred', CSC_USERNAME: 'u', CSC_PASSWORD: 'p' });
  assert.deepEqual(r.set, { SEAL_P12: './certs/dev-seal.p12', SEAL_P12_PASSWORD: 'changeit', SEAL_CSC_URL: 'https://cs.ssl.com/csc/v1', SEAL_CSC_CLIENT_ID: 'id', SEAL_CSC_CLIENT_SECRET: 'sec', SEAL_CSC_CREDENTIAL_ID: 'cred', SEAL_CSC_USERNAME: 'u', SEAL_CSC_PASSWORD: 'p' });
  assert.deepEqual(r.lines, []);
  const both = resolveSealEnv({ LOCAL_P12_PATH: '/a.p12', SEAL_P12: '/b.p12', LOCAL_P12_PASSWORD: 'pw-alpha', SEAL_P12_PASSWORD: 'pw-beta', CSC_CLIENT_ID: 'same', SEAL_CSC_CLIENT_ID: 'same' });
  assert.deepEqual(both.set, {}, 'the existing names are left as they are');
  assert.equal(both.lines.length, 1, 'one line, not one for each pair');
  assert.match(both.lines[0], /^\[config\] Two names of the same seal setting are set to different values\. The SEAL_ name is used: SEAL_P12 \(not LOCAL_P12_PATH\), SEAL_P12_PASSWORD \(not LOCAL_P12_PASSWORD\)\./);
  assert.doesNotMatch(both.lines[0], /a\.p12|b\.p12|pw-alpha|pw-beta/, 'never a value');
});

test('1b: PDF_SIGNING_MODE picks the seal when both are set, says what it leaves unused, and an unknown mode is ignored with a line', () => {
  const env = { SEAL_P12: '/x.p12', CSC_CLIENT_ID: 'id', CSC_USERNAME: 'u', CSC_PASSWORD: 'p' };
  const local = resolveSealEnv({ ...env, PDF_SIGNING_MODE: 'local_p12' });
  assert.deepEqual(local.set, {}, 'the cloud names are not copied in local_p12 mode');
  assert.match(local.lines.join('\n'), /PDF_SIGNING_MODE=local_p12, so the cloud seal settings are not used: CSC_CLIENT_ID, CSC_USERNAME, CSC_PASSWORD\./);
  const cloud = resolveSealEnv({ ...env, PDF_SIGNING_MODE: 'csc' });
  assert.deepEqual(cloud.drop, ['SEAL_P12']);
  assert.deepEqual(Object.keys(cloud.set).sort(), ['SEAL_CSC_CLIENT_ID', 'SEAL_CSC_PASSWORD', 'SEAL_CSC_USERNAME']);
  assert.match(cloud.lines.join('\n'), /PDF_SIGNING_MODE=csc, so the key file settings are not used: SEAL_P12\./);
  assert.deepEqual(signingMode({ PDF_SIGNING_MODE: ' CSC ' }), { mode: 'csc' });
  assert.deepEqual(signingMode({}), { mode: null });
  const odd = resolveSealEnv({ PDF_SIGNING_MODE: 'hsm' });
  assert.match(odd.lines[0], /^\[config\] PDF_SIGNING_MODE is "hsm", which is not a mode\. It is ignored\./);
  // A mode with nothing behind it.
  assert.match(sealModeProblem({ PDF_SIGNING_MODE: 'local_p12' })!, /PDF_SIGNING_MODE=local_p12, but no key file is set\. Set LOCAL_P12_PATH .* npm run seal:dev-cert/);
  assert.match(sealModeProblem({ PDF_SIGNING_MODE: 'csc' })!, /PDF_SIGNING_MODE=csc, but the cloud signing service is not set up: CSC_CLIENT_ID, CSC_USERNAME, CSC_PASSWORD are not set/);
  assert.equal(sealModeProblem({ PDF_SIGNING_MODE: 'csc', CSC_CLIENT_ID: 'x' }), null, 'half a set is said by the cloud seal itself, with the names that are missing');
  assert.equal(sealModeProblem({ PDF_SIGNING_MODE: 'local_p12', LOCAL_P12_PATH: '/x.p12' }), null);
  assert.equal(sealModeProblem({}), null);
});

test('1c: a mode whose settings are missing is refused in plain words, the document still completes without a seal, and the operators are told', async () => {
  settings({ PDF_SIGNING_MODE: 'local_p12' });
  const st = sealkey.sealState();
  assert.equal(st.on, false);
  assert.match((st as any).why, /PDF_SIGNING_MODE=local_p12, but no key file is set/);
  assert.match(sealkey.sealStartLines().join('\n'), /\[config\] PDF_SIGNING_MODE=local_p12, but no key file is set\..* Until then completed PDFs are made without the digital seal\./);
  const { id, pdf } = await complete();
  assert.equal(await seal.checkSeal(pdf), null, 'no seal in the file');
  assert.ok(audits(id).some((a) => a.action === 'Not sealed'), 'the history says so');
  assert.equal(s.db.get('SELECT seal_level FROM envelopes WHERE id=?', id).seal_level, null);
  assert.ok(s.db.get("SELECT COUNT(*) n FROM support_requests WHERE status='open' AND name='GrowSigning (automatic alert)'").n >= 1, 'an alert for the people who run the server');
  // The half-set cloud seal names what is missing by the names the operator wrote.
  settings({ PDF_SIGNING_MODE: 'csc', CSC_CLIENT_ID: 'only-this' });
  const half = sealkey.sealState();
  assert.equal(half.on, false);
  assert.match((half as any).why, /The cloud seal is half set up: CSC_USERNAME, CSC_PASSWORD are not set/);
});

// ---- 2. The dev certificate ----------------------------------------------------------------------------------

test('2a: npm run seal:dev-cert makes ./certs/dev-seal.p12, a self-signed certificate for signing documents, valid a year, and never writes over one without --force', { skip: NO_OPENSSL }, () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['seal:dev-cert'], 'node scripts/dev-seal-cert.mjs');
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^certs$/m);
  const pem = execFileSync('openssl', ['pkcs12', '-in', P12, '-passin', 'pass:changeit', '-nokeys'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const x = new crypto.X509Certificate(pem);
  assert.match(x.subject, /CN=GrowSigning development seal/);
  assert.equal(x.subject, x.issuer, 'self-signed');
  assert.equal(x.ca, false);
  const days = (new Date(x.validTo).getTime() - new Date(x.validFrom).getTime()) / 864e5;
  assert.ok(days > 364 && days < 366, `valid one year (${days} days)`);
  assert.match(execFileSync('openssl', ['x509', '-noout', '-ext', 'keyUsage'], { input: pem, encoding: 'utf8' }), /critical\s+Digital Signature, Non Repudiation\s*$/);
  // A second run leaves the file alone and says how to replace it; --force makes a new one; another password is used.
  const before = fs.readFileSync(P12);
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/dev-seal-cert.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH!, ...env } });
  const again = run([]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /\.\/certs\/dev-seal\.p12 is already there, and it was left as it is\.\nTo make a new one over it: npm run seal:dev-cert -- --force/);
  assert.ok(fs.readFileSync(P12).equals(before));
  const other = run([], { LOCAL_P12_PATH: './certs/other.p12', LOCAL_P12_PASSWORD: 'another one' });
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /PDF_SIGNING_MODE=local_p12\nLOCAL_P12_PATH=\.\/certs\/other\.p12\nLOCAL_P12_PASSWORD=another one\n/);
  assert.match(other.stdout, /Adobe Acrobat will show a yellow bar that says the validity of the signature is unknown, until you trust this\ncertificate by hand on that computer\. That is expected/);
  assert.match(other.stdout, /needs\na certificate from an authority on the Adobe Approved Trust List, which is the csc mode/);
  execFileSync('openssl', ['pkcs12', '-in', path.join(dir, 'certs/other.p12'), '-passin', 'pass:another one', '-nokeys'], { stdio: 'ignore' });
  const forced = run(['--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(!fs.readFileSync(P12).equals(before), '--force made a new one');
  // Without openssl on the PATH: plain words and nothing written.
  const none = spawnSync(process.execPath, [path.join(ROOT, 'scripts/dev-seal-cert.mjs')], { cwd: fs.mkdtempSync(path.join(dir, 'empty-')), encoding: 'utf8', env: { PATH: path.join(dir, 'no-such-folder') } });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /The openssl program was not found, and this script needs it to make the certificate\./);
});

test('2b: a production server refuses the dev certificate with a [config] line, unless SEAL_ALLOW_SELF_SIGNED=1', { skip: NO_OPENSSL }, () => {
  const env = { PDF_SIGNING_MODE: 'local_p12', LOCAL_P12_PATH: P12, LOCAL_P12_PASSWORD: 'changeit' };
  settings(env);
  assert.equal(sealkey.sealState().on, true, 'in development it seals');
  assert.deepEqual(sealkey.sealStartLines(), []);
  settings({ ...env, NODE_ENV: 'production' });
  const st = sealkey.sealState();
  assert.equal(st.on, false);
  assert.match((st as any).why, /The seal certificate \(GrowSigning development seal\) is a self-made test certificate behind the well-known password "changeit", and this is a production server\. It is not used: .* looks worse than no seal\. .* set SEAL_ALLOW_SELF_SIGNED=1 if you mean to seal with this one\./);
  const lines = sealkey.sealStartLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[config\] The seal certificate \(GrowSigning development seal\) is a self-made test certificate/);
  settings({ ...env, NODE_ENV: 'production', SEAL_ALLOW_SELF_SIGNED: '1' });
  assert.equal(sealkey.sealState().on, true, 'the operator said they mean it');
  // It seals, and the startup log says once what customers will see.
  const allowed = sealkey.sealStartLines();
  assert.equal(allowed.length, 1);
  assert.match(allowed[0], /^\[config\] The seal certificate \(GrowSigning development seal\) is self-signed, and this is a production server\. Completed PDFs are sealed with it, and Acrobat shows "validity unknown"/);
  assert.doesNotMatch(allowed[0], /changeit/);
});

test('2c: any other self-signed certificate on a production server seals, with one [config] line at start; one from an authority gets no line', () => {
  const own = makeCert({ cn: 'Acme self made' });
  const p12Free = { SEAL_KEY_PEM: own.key.export({ type: 'pkcs8', format: 'pem' }) as string, SEAL_CERT_PEM: own.pem };
  settings({ ...p12Free, NODE_ENV: 'production' });
  assert.equal(sealkey.sealState().on, true);
  const lines = sealkey.sealStartLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[config\] The seal certificate \(Acme self made\) is self-signed, and this is a production server\./);
  settings({ ...p12Free });
  assert.deepEqual(sealkey.sealStartLines(), [], 'nothing outside production');
  const root = makeCert({ cn: 'Spec Authority', ca: true });
  const leaf = makeCert({ cn: 'Acme issued', issuer: root });
  settings({ SEAL_KEY_PEM: leaf.key.export({ type: 'pkcs8', format: 'pem' }) as string, SEAL_CERT_PEM: leaf.pem, SEAL_CHAIN_PEM: root.pem, NODE_ENV: 'production' });
  assert.equal(sealkey.sealState().on, true);
  assert.deepEqual(sealkey.sealStartLines(), []);
});

// ---- 3. The facade and its retry rules -----------------------------------------------------------------------

test('3a: sealPdf in local_p12 mode returns the sealed bytes, their SHA-256, the mode, the level and the certificate, and a third-party checker accepts the file', { skip: NO_OPENSSL }, async () => {
  settings({ PDF_SIGNING_MODE: 'local_p12', LOCAL_P12_PATH: P12, LOCAL_P12_PASSWORD: 'changeit', TSA_URL: 'https://tsa.test/stamp' });
  const st = stub(tsaWorld);
  try {
    const r = await sealer.sealPdf(await samplePdfBytes());
    assert.deepEqual([r.mode, r.level, r.timestamped, r.sha256], ['local_p12', 'B-LTA', true, sha(r.bytes)]);
    assert.deepEqual(r.ltv, { level: 'B-LTA', docTsHost: 'tsa.test', docTsTime: (r.ltv as any).docTsTime });
    assert.deepEqual([r.certificate.name, r.certificate.issuer, r.certificate.selfSigned], ['GrowSigning development seal', 'GrowSigning development seal', true]);
    const check = (await seal.checkSeal(r.bytes))!;
    assert.deepEqual([check.intact, check.whole_file, check.level, check.long_term], [true, true, 'B-T', 'B-LTA'], JSON.stringify(check));
    if (PDFSIG) assert.match(pdfsig(r.bytes).split('Signature #2')[0], /Signature is Valid/);
    // Without a time stamp, when asked: B-B, and nothing is asked of the service.
    const calls = st.calls.length;
    const bb = await sealer.sealPdf(await samplePdfBytes(), { timestamp: false });
    assert.deepEqual([bb.level, bb.timestamped, bb.ltv, 'timestampFailed' in bb], ['B-B', false, null, false]);
    assert.equal(st.calls.length, calls);
  } finally {
    st.restore();
  }
});

test('3b: the time-stamp service is asked once more after a failure that passes, then the file is sealed at B-B with the reason; an answer that does not check out is not asked again', { skip: NO_OPENSSL }, async () => {
  settings({ PDF_SIGNING_MODE: 'local_p12', LOCAL_P12_PATH: P12, LOCAL_P12_PASSWORD: 'changeit', TSA_URL: 'https://tsa.test/stamp', LTV_WAIT_MS: '0' });
  // Busy once, then fine: one more try, and the seal carries the time stamp.
  let st = stub((c, nth) => (c.url.includes('tsa.test') && nth === 1 ? 503 : tsaWorld(c)));
  try {
    const r = await sealer.sealPdf(await samplePdfBytes());
    assert.deepEqual([r.level, r.timestamped], ['B-T', true]);
    assert.equal(st.calls.filter((c) => c.url.includes('tsa.test')).length, 2);
  } finally {
    st.restore();
  }
  // The connection cannot be opened, twice: asked twice, never a third time, and the file is sealed at B-B.
  st = stub(() => refusedConnection());
  try {
    const t0 = Date.now();
    const r = await sealer.sealPdf(await samplePdfBytes());
    assert.deepEqual([r.level, r.timestamped], ['B-B', false]);
    assert.match(r.timestampFailed!, /tsa\.test: it could not be reached \(ECONNREFUSED\) \(asked twice\)/);
    assert.equal(st.calls.length, 2);
    assert.ok(Date.now() - t0 < tsaMod.TSA_TOTAL_MS, 'inside the seconds a time stamp has');
    assert.equal((await seal.checkSeal(r.bytes))!.intact, true);
  } finally {
    st.restore();
  }
  // HTTP 400 is an answer, not a passing failure: asked once.
  st = stub(() => 400);
  try {
    const r = await sealer.sealPdf(await samplePdfBytes());
    assert.equal(r.level, 'B-B');
    assert.match(r.timestampFailed!, /tsa\.test: it answered HTTP 400$/);
    assert.equal(st.calls.length, 1);
  } finally {
    st.restore();
  }
});

test('3c: every failure is a typed error in plain words: no settings, settings that cannot be used', async () => {
  settings({});
  await assert.rejects(sealer.sealPdf(await samplePdfBytes()), (e: any) => e instanceof sealer.PdfSealError && e.code === 'not_configured' && /No seal is set up\. Set PDF_SIGNING_MODE/.test(e.message));
  settings({ PDF_SIGNING_MODE: 'local_p12', LOCAL_P12_PATH: path.join(dir, 'missing.p12'), LOCAL_P12_PASSWORD: 'x' });
  await assert.rejects(sealer.sealPdf(await samplePdfBytes()), (e: any) => e instanceof sealer.PdfSealError && e.code === 'refused' && /LOCAL_P12_PATH names a file that cannot be read/.test(e.message));
});

test('3d: csc mode over a /csc/v1 address: only a 32-byte digest leaves the server, credentials/authorize then signatures/signHash, and the file verifies', async () => {
  settings({ ...cscEnv(), TSA_URL: 'https://tsa.test/stamp', LTV_WAIT_MS: '0' });
  cscSeen = {};
  const pdf = await samplePdfBytes();
  const st = stub((c) => (c.url.includes('csc.test') ? cscWorld(c) : tsaWorld(c)));
  try {
    const r = await sealer.sealPdf(pdf);
    assert.deepEqual([r.mode, r.level, r.certificate.name, r.certificate.issuer], ['csc', 'B-T', 'Spec Cloud Seal', 'Spec Cloud Root']);
    const check = (await seal.checkSeal(r.bytes))!;
    assert.deepEqual([check.intact, check.whole_file], [true, true], JSON.stringify(check));
    if (PDFSIG) assert.match(pdfsig(r.bytes), /Signature is Valid/);
    const sent = st.calls.filter((c) => c.url.includes('csc.test'));
    assert.deepEqual(sent.map((c) => c.path), ['/oauth2/token', '/csc/v1/credentials/info', '/csc/v1/credentials/authorize', '/csc/v1/signatures/signHash']);
    const [, , authorize, signHash] = sent.map((c) => c.json);
    assert.deepEqual(Object.keys(authorize).sort(), ['credentialID', 'hash', 'numSignatures']);
    assert.deepEqual(Object.keys(signHash).sort(), ['SAD', 'credentialID', 'hash', 'hashAlgo', 'signAlgo']);
    assert.deepEqual([signHash.credentialID, signHash.hashAlgo, signHash.signAlgo, signHash.SAD], ['cred-1', '2.16.840.1.101.3.4.2.1', '1.2.840.113549.1.1.11', `sad-for-${signHash.hash[0]}`]);
    assert.equal(signHash.hash.length, 1);
    assert.equal(Buffer.from(signHash.hash[0], 'base64').length, 32, 'a SHA-256 and nothing else');
    assert.deepEqual(authorize.hash, signHash.hash);
    // Nothing of the document went out: every request to the service is small, and none holds a piece of the PDF.
    const marker = Buffer.from(pdf).subarray(0, 8).toString('latin1');
    for (const c of sent) {
      assert.ok(c.body.length < 600, `${c.path} sent ${c.body.length} bytes`);
      assert.ok(!c.body.toString('latin1').includes(marker) && !c.body.toString('latin1').includes('%PDF'));
    }
    // What the time-stamp service gets is a time-stamp request: a few dozen bytes around another SHA-256.
    for (const c of st.calls.filter((x) => x.url.includes('tsa.test'))) assert.ok(c.body.length < 200);
  } finally {
    st.restore();
  }
});

test('3e: csc retries: a call that the service answers 503 is sent once more; signHash is never sent twice for a fingerprint, and its failure is a typed error', async () => {
  // credentials/authorize answers 503 once: sent again after a short pause, and the seal is made.
  settings({ ...cscEnv('https://csc.test/csc/v0') });
  cscSeen = {};
  let st = stub((c) => cscWorld(c, { fail: (p, nth) => (p === 'credentials/authorize' && nth === 1 ? 503 : null) }));
  try {
    const r = await sealer.sealPdf(await samplePdfBytes());
    assert.deepEqual([r.mode, r.level], ['csc', 'B-B']);
    assert.deepEqual(st.calls.map((c) => c.path).slice(-3), ['/csc/v0/credentials/authorize', '/csc/v0/credentials/authorize', '/csc/v0/signatures/signHash']);
  } finally {
    st.restore();
  }
  // signHash answers 503 (it may have signed, and a signing is paid for): one call, no second, a typed error.
  for (const fail of [503 as Answer, refusedConnection()]) {
    cscSeen = {};
    st = stub((c) => cscWorld(c, { fail: (p) => (p === 'signatures/signHash' ? fail : null) }));
    try {
      await assert.rejects(sealer.sealPdf(await samplePdfBytes()), (e: any) => e instanceof sealer.PdfSealError && e.code === 'signing_service' && /^The signing service did not seal the file: the signing service did not sign: csc\.test /.test(e.message) && !/asked twice/.test(e.message));
      assert.equal(st.calls.filter((c) => c.path.endsWith('/signatures/signHash')).length, 1);
    } finally {
      st.restore();
    }
  }
  assert.equal(csc.cscRetryable({ status: 503 }), true);
  assert.equal(csc.cscRetryable({ status: 400 }), false);
  assert.equal(csc.cscRetryable({ unreached: true }), true);
  assert.equal(csc.cscRetryable(Object.assign(new Error('x'), { name: 'TimeoutError' })), false, 'a timeout used the seconds up');
});

test('3f: when the signing service fails for a real envelope, the document completes without a seal, its history says so, and the operators are told', async () => {
  settings({ ...cscEnv() });
  cscSeen = {};
  const st = stub((c) => cscWorld(c, { fail: (p) => (p === 'signatures/signHash' ? 500 : null) }));
  try {
    const { id, pdf } = await complete();
    assert.equal(await seal.checkSeal(pdf), null);
    assert.ok(audits(id).some((a) => a.action === 'Not sealed' && /the seal could not be applied/.test(a.detail)));
    assert.equal(st.calls.filter((c) => c.path.endsWith('/signatures/signHash')).length, 1);
    if (PDFTOTEXT) assert.doesNotMatch(text(pdf), /DIGITAL SEAL/, 'the certificate says nothing about a seal');
  } finally {
    st.restore();
  }
});

test('3g: a signing service that repeats our request in its error answer puts no secret in the log, the alert, the typed error or the history', async () => {
  const SECRETS = { CSC_CLIENT_SECRET: 'SECRETXYZ-client', CSC_PASSWORD: 'PASSXYZ account', CSC_USERNAME: 'usrNAME77' };
  const TOKEN = 'TOKENSECRET123';
  const leaks = [...Object.values(SECRETS), TOKEN, 'PASSXYZ', 'SECRETXYZ', encodeURIComponent(SECRETS.CSC_PASSWORD)];
  const clean = (what: string, textSeen: string) => {
    for (const x of leaks) assert.ok(!textSeen.includes(x), `${what} holds ${x}: ${textSeen.slice(0, 400)}`);
    assert.doesNotMatch(textSeen, /sad-for-/, `${what} holds the SAD`);
  };
  const echo = (c: Call, status: number, auth = '') => new Response(JSON.stringify({ error: 'invalid_request', error_description: `bad request: ${c.body.toString('utf8')}${auth ? ` {"authorization":"Bearer ${auth}"}` : ''}` }), { status });
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...a: any[]) => void logged.push(a.map(String).join(' '));
  const alerts = () => (s.db.all("SELECT message FROM support_requests WHERE name='GrowSigning (automatic alert)'") as any[]).map((r) => String(colcrypt.openValue(r.message))).join('\n');
  try {
    // 1. The token call is sent back whole, as JSON inside the words: only the short error code is repeated.
    settings({ ...cscEnv(), ...SECRETS });
    cscSeen = {};
    let st = stub((c) => (c.path === '/oauth2/token' ? echo(c, 400) : cscWorld(c)));
    try {
      const err: any = await sealer.sealPdf(await samplePdfBytes()).catch((e) => e);
      assert.ok(err instanceof sealer.PdfSealError && err.code === 'refused', String(err));
      assert.match(err.message, /csc\.test answered HTTP 400: invalid_request\./);
      clean('the typed error', err.message + String(err.cause?.message || ''));
      const { id } = await complete();
      clean('the history', JSON.stringify(audits(id)));
    } finally {
      st.restore();
    }
    // 2. signHash fails with the token and the SAD in the words, and a completed envelope goes out without a seal.
    settings({ ...cscEnv(), ...SECRETS });
    cscSeen = {};
    st = stub((c) => (c.path === '/oauth2/token' ? { access_token: TOKEN, expires_in: 3600 } : c.path.endsWith('/signatures/signHash') ? echo(c, 400, TOKEN) : cscWorld(c)));
    try {
      const err: any = await sealer.sealPdf(await samplePdfBytes()).catch((e) => e);
      assert.ok(err instanceof sealer.PdfSealError && err.code === 'signing_service', String(err));
      clean('the typed error', err.message + String(err.cause?.message || ''));
      const { id } = await complete();
      assert.ok(audits(id).some((a) => a.action === 'Not sealed'));
      clean('the history', JSON.stringify(audits(id)));
      assert.ok(logged.some((l) => new RegExp(`envelope ${id} was completed without a seal \\(signing_service\\): `).test(l)), 'the log line names the kind of failure');
    } finally {
      st.restore();
    }
    // 3. Plain words with a secret in them (no JSON): the words stay, the secret goes.
    settings({ ...cscEnv(), ...SECRETS });
    cscSeen = {};
    st = stub((c) => (c.path.endsWith('/credentials/authorize') ? new Response(JSON.stringify({ error: 'invalid_request', error_description: `user usrNAME77 with secret SECRETXYZ-client and SAD ${'x'} may not sign, Bearer token-1` }), { status: 400 }) : cscWorld(c)));
    try {
      const err: any = await sealer.sealPdf(await samplePdfBytes()).catch((e) => e);
      assert.match(err.message, /user \[removed\] with secret \[removed\] and SAD x may not sign, Bearer \[removed\]/);
      clean('the typed error', err.message);
    } finally {
      st.restore();
    }
  } finally {
    console.error = realError;
  }
  assert.ok(logged.some((l) => /\[seal\]/.test(l)), 'something was logged');
  clean('the log', logged.join('\n'));
  clean('the operators\' alerts', alerts());
  assert.match(alerts(), /answered HTTP 400/);
  // The scrubber on its own: each secret also as it looks inside JSON, a web address and base64.
  settings({ ...cscEnv(), CSC_CLIENT_SECRET: 'a "quoted" secret/1', CSC_PASSWORD: 'p&ss word=9' });
  const out = csc.withoutSecrets(`x a \\"quoted\\" secret/1 y ${encodeURIComponent('p&ss word=9')} z ${Buffer.from('p&ss word=9').toString('base64')} Basic abc123`);
  assert.equal(out, 'x [removed] y [removed] z [removed] Basic [removed]');
});

// ---- 4. The certificate of completion ------------------------------------------------------------------------

test('4: the certificate prints the envelope ID, the SHA-256 of each original, each signer\'s name, email, IP address and UTC times; the browser string only with CERTIFICATE_SHOWS_DEVICE=1', { skip: !PDFTOTEXT && 'pdftotext is not installed' }, async () => {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  settings({});
  const off = await complete(UA);
  const t = text(off.pdf);
  const original = s.db.get('SELECT f.sha256 FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=?', off.id)?.sha256;
  assert.match(t, new RegExp(`Envelope ID ${off.id}`));
  if (original) assert.match(t, new RegExp(`SHA-256 of the original: ${original}`));
  else assert.match(t, /SHA-256 of the original: [0-9a-f]{64}/);
  assert.match(t, new RegExp(`<${off.email}>`));
  assert.match(t, /IP address \d+\.\d+\.\d+\.\d+/);
  assert.match(t, /Viewed \d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d UTC/);
  assert.match(t, /Completed \d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d UTC/);
  assert.doesNotMatch(t, /Browser and device|Mozilla\/5\.0/, 'off unless the operator asks: the certificate goes to everyone on the envelope');
  assert.equal(s.db.get('SELECT user_agent FROM recipients WHERE envelope_id=?', off.id).user_agent, UA, 'it is kept either way');
  settings({ CERTIFICATE_SHOWS_DEVICE: '1' });
  const on = await complete(UA);
  assert.match(text(on.pdf), /Browser and device Chrome on Windows computer, as their browser reported it: Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\)/);
});

// ---- 5. Nothing changes a byte after the seal ----------------------------------------------------------------

test('5: local_p12 with a time-stamp service: what is stored, what every download serves and what /verify accepts are the sealed bytes, and no later step changes one', { skip: NO_OPENSSL }, async () => {
  settings({ PDF_SIGNING_MODE: 'local_p12', LOCAL_P12_PATH: P12, LOCAL_P12_PASSWORD: 'changeit', TSA_URL: 'https://tsa.test/stamp' });
  const st = stub(tsaWorld);
  let done: Awaited<ReturnType<typeof complete>>;
  try {
    done = await complete();
  } finally {
    st.restore();
  }
  const { id, pdf, sha: stored, c, email } = done;
  // The post-seal SHA-256 in the database is of the stored bytes, and the record says what the seal is.
  assert.equal(sha(pdf), stored);
  const row = s.db.get('SELECT seal_level, seal_ltv, final_size FROM envelopes WHERE id=?', id);
  assert.deepEqual([row.seal_level, row.seal_ltv, row.final_size], ['B-T', 'B-LTA', pdf.length]);
  assert.ok(audits(id).some((a) => a.action === 'Sealed by GrowSigning development seal'), JSON.stringify(audits(id).map((a) => a.action)));

  // The seal covers every byte but its own /Contents, and each later revision (the check data, the document time
  // stamp) is appended: the first range starts at 0, each gap is exactly "<hex>", and the last range ends the file.
  const ranges = byteRanges(pdf);
  assert.equal(ranges.length, 2, 'the seal, then the document time stamp');
  for (const r of ranges) {
    assert.equal(r[0], 0);
    const gap = pdf.subarray(r[1], r[2]).toString('latin1');
    assert.match(gap, /^<[0-9a-f]+>$/i, 'nothing but the signature value is left out');
    assert.match(pdf.subarray(r[1] - 10, r[1]).toString('latin1'), /\/Contents ?$/);
  }
  assert.ok(ranges[0][2] + ranges[0][3] < pdf.length, 'the long-term data was appended after the seal');
  assert.equal(ranges[1][2] + ranges[1][3], pdf.length, 'the last time stamp covers the whole file');
  const check = (await seal.checkSeal(pdf))!;
  assert.deepEqual([check.intact, check.whole_file, check.ours, check.level, check.long_term], [true, true, true, 'B-T', 'B-LTA'], JSON.stringify(check));
  if (PDFSIG) {
    const out = pdfsig(pdf);
    assert.match(out.split('Signature #2')[0], /Signature is Valid/, out);
    assert.match(out, /Total document signed/);
  }

  const same = (what: string, got: Uint8Array) => assert.ok(Buffer.from(got).equals(pdf), `${what} serves the sealed bytes (${got.length} against ${pdf.length})`);
  const everyPath = async () => {
    // The sender's download.
    const sender = await c.get(`/envelopes/${id}/download`);
    assert.equal(sender.status, 200);
    same('the sender download', sender.data);
    same('the sender download, shown in the browser', (await c.get(`/envelopes/${id}/download?inline=1`)).data);
    // The signer's download, from their signing link.
    const signer = await new Client().get(`/sign/${tokenFor(id, email)}/download`);
    assert.equal(signer.status, 200);
    same('the signer download', signer.data);
    // The API, with a key.
    const key = (await c.post('/api-keys', { name: 'spec' })).data.key;
    const api = await new Client().call('GET', `/envelopes/${id}/download`, undefined, { authorization: `Bearer ${key}` });
    assert.equal(api.status, 200, JSON.stringify(api.data).slice(0, 200));
    same('the API download', api.data);
    // The evidence pack and the account export: the file is inside, byte for byte.
    const pack = await c.get(`/envelopes/${id}/evidence`);
    assert.equal(pack.status, 200);
    assert.ok(Buffer.from(pack.data).includes(pdf), 'signed.pdf in the evidence pack is the sealed file');
    const all = await c.get(`/export?ids=${id}`);
    assert.equal(all.status, 200);
    assert.ok(Buffer.from(all.data).includes(pdf), 'the account export holds the sealed file');
    // /verify: the uploaded bytes are the stored ones, and the seal holds.
    const f = new FormData();
    f.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'x.pdf');
    const v = new Client();
    v.ip = `192.0.2.${50 + (n++ % 100)}`;
    const r = await v.call('POST', '/public/verify', f);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([r.data.match, r.data.seal.intact, r.data.seal.whole_file], [true, true, true]);
    assert.equal(s.db.get('SELECT final_sha256 FROM envelopes WHERE id=?', id).final_sha256, stored);
    assert.ok(s.db.readBlob(stored).equals(pdf));
  };
  await everyPath();
  // The completion email carries the stored file itself: its attachment is the buffer read back from the store.
  assert.ok(s.env.finalPdf(s.env.loadEnvelope(id))!.equals(pdf));

  // Later steps. A second build (the 15-minute timer) makes no second file and no second seal.
  const stubbed = stub(tsaWorld);
  try {
    assert.equal(await s.env.buildFinal(id), true);
    assert.equal(stubbed.calls.length, 0, 'nothing is sealed or time-stamped again');
  } finally {
    stubbed.restore();
  }
  await everyPath();

  // A legal hold marks the record, never the file.
  const hold = await c.post(`/envelopes/${id}/hold`, { reason: 'held for the spec test' });
  assert.equal(hold.status, 200, JSON.stringify(hold.data));
  await everyPath();

  // Encryption at rest, with the operator's own script: the file on disk changes, what is read back does not.
  const blob = path.join(process.env.DATA_DIR!, 'blobs', stored);
  assert.ok(fs.readFileSync(blob).equals(pdf), 'stored as it is before a key is set');
  const key = () => crypto.randomBytes(32).toString('base64');
  const K1 = key(), K2 = key();
  const script = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/encrypt-files.mjs')], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH!, DATA_DIR: process.env.DATA_DIR!, ...env } });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  };
  script({ FILE_ENCRYPTION_KEY: K1 });
  const onDisk1 = fs.readFileSync(blob);
  assert.ok(!onDisk1.includes(pdf.subarray(0, 64)), 'encrypted on the disk');
  process.env.FILE_ENCRYPTION_KEY = K1;
  await everyPath();
  // The key is changed: the old one moves to FILE_ENCRYPTION_KEYS_OLD, the files move to the new one.
  script({ FILE_ENCRYPTION_KEY: K2, FILE_ENCRYPTION_KEYS_OLD: K1 });
  assert.ok(!fs.readFileSync(blob).equals(onDisk1), 'written again under the new key');
  process.env.FILE_ENCRYPTION_KEY = K2;
  delete process.env.FILE_ENCRYPTION_KEYS_OLD;
  await everyPath();
  const last = (await seal.checkSeal(s.db.readBlob(stored)))!;
  assert.deepEqual([last.intact, last.whole_file], [true, true]);
});

// ---- 6. The documents ----------------------------------------------------------------------------------------

test('6: .env.example lists the eight names with a line each, and the README says the two modes and the order', () => {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const line of ['# PDF_SIGNING_MODE=local_p12', '# TSA_URL=http://ts.ssl.com', '# CSC_API_BASE_URL=https://cs.ssl.com/csc/v1', '# CSC_CLIENT_ID=', '# CSC_CLIENT_SECRET=', '# CSC_CREDENTIAL_ID=', '# LOCAL_P12_PATH=./certs/dev-seal.p12', '# LOCAL_P12_PASSWORD=changeit'])
    assert.ok(example.includes(`\n${line}`), `.env.example has "${line}"`);
  assert.match(example, /# CSC_USERNAME=/);
  assert.match(example, /# CERTIFICATE_SHOWS_DEVICE=1/);
  assert.match(example, /# SEAL_ALLOW_SELF_SIGNED=1/);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /### Sealing in two modes/);
  assert.match(readme, /npm run seal:dev-cert/);
  assert.match(readme, /1\. \*\*Flatten\.\*\*[\s\S]*2\. \*\*Certificate of completion\.\*\*[\s\S]*3\. \*\*Seal\.\*\*/);
  assert.doesNotMatch(readme.slice(readme.indexOf('### Sealing in two modes')).split('\n### ')[1] || '', /\u2014/, 'no em dashes');
});
