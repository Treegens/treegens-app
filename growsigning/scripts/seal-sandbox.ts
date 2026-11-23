// Seals a real envelope with SSL.com's eSigner SANDBOX through the app's own code path, and checks the result with
// tools that share no code with ours (openssl, poppler's pdfsig and pdftoppm, and pyHanko when it is installed).
//
//   node --experimental-strip-types --no-warnings scripts/seal-sandbox.ts [out-dir]
//
// out-dir defaults to research/: it gets sealed-sandbox-sample.pdf and sealed-sandbox-verify.txt. The last line
// printed is a JSON summary (tests/seal-csc-sandbox.test.ts reads it). Exit code 0 when every check that could run
// passed, 2 when the sandbox could not be reached (nothing was checked), 1 when a check failed.
//
// The sandbox CA is SSL.com's development root, which is on no trust list: Acrobat says "validity unknown" for this
// file. That is expected; a production eSealing certificate chains to an authority on the Adobe Approved Trust List.
//
// SANDBOX TEST VALUES ONLY. The account below is SSL.com's public demo account for the eSigner sandbox, published by
// SSL.com for exactly this purpose at https://www.ssl.com/guide/esigner-demo-credentials-and-certificates/ . It works
// only against cs-try.ssl.com and oauth-sandbox.ssl.com, and seals nothing anyone should trust. Any SEAL_CSC_* already
// in the environment wins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const SANDBOX = {
  SEAL_CSC_URL: 'https://cs-try.ssl.com/csc/v0',
  SEAL_CSC_TOKEN_URL: 'https://oauth-sandbox.ssl.com/oauth2/token',
  SEAL_CSC_CLIENT_ID: 'qOUeZCCzSqgA93acB3LYq6lBNjgZdiOxQc-KayC3UMw', // SSL.com public sandbox demo client
  SEAL_CSC_USERNAME: 'esigner_demo', // SSL.com public sandbox demo account
  SEAL_CSC_PASSWORD: 'esignerDemo#1', // SSL.com public sandbox demo password
};
for (const [k, v] of Object.entries(SANDBOX)) process.env[k] ||= v;
process.env.TSA_URL ||= 'http://ts.ssl.com';
process.env.TSA_TRUST ||= 'bundled';
process.env.LTV_WAIT_MS ||= '20000';

const ROOT = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(process.argv[2] || path.join(ROOT, 'research'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-sandbox-'));
const lines: string[] = [];
const say = (s = '') => (lines.push(s), console.log(s));
const checks: { name: string; ok: boolean | null; note: string }[] = [];
const check = (name: string, ok: boolean | null, note = '') => {
  checks.push({ name, ok, note });
  say(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'NOT DONE'}  ${name}${note ? `: ${note}` : ''}`);
};
const file = (name: string, data: Buffer | string) => (fs.writeFileSync(path.join(work, name), data), path.join(work, name));
const run = (bin: string, args: string[]): { ok: boolean; out: string } => {
  try {
    return { ok: true, out: execFileSync(bin, args, { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e: any) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.code === 'ENOENT' ? `${bin} is not installed` : ''}` };
  }
};
const finish = (code: number) => {
  console.log(JSON.stringify({ code, checks }));
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(code);
};

const { useProxyForFetch } = await import('../tests/netproxy.ts');
useProxyForFetch();

// Can the sandbox be reached at all? Otherwise nothing is checked, and the caller is told so.
try {
  const r = await fetch(`${process.env.SEAL_CSC_URL}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e: any) {
  console.error(`The SSL.com sandbox could not be reached (${e?.message || e}), so nothing was checked.`);
  finish(2);
}

say(`GrowSigning seal against the SSL.com eSigner sandbox, ${new Date().toISOString()}`);
say(`CSC API ${process.env.SEAL_CSC_URL}, token ${process.env.SEAL_CSC_TOKEN_URL}, time stamps ${process.env.TSA_URL}, TSA_TRUST=${process.env.TSA_TRUST}`);
say('');

const { boot, signUp, simple, signAll } = await import('../tests/helpers.ts');
const s = await boot();
const csc = await import('../src/server/sealcsc.ts');
const sealkey = await import('../src/server/sealkey.ts');
const seal = await import('../src/server/seal.ts');
const cms = await import('../src/server/sealcms.ts');
const der = await import('../src/server/der.ts');

await csc.cscReady();
const st = sealkey.sealState();
if (!st.on) {
  say(`The seal could not be set up: ${(st as any).why}`);
  check('the sandbox credential can be used', false, String((st as any).why));
  finish(1);
}
const key = (st as any).key;
say(`Seal certificate from credentials/info: ${key.cert.name}, issued by ${key.cert.issuerName}, valid to ${key.cert.notAfter.toISOString()}`);
say(`Chain: ${key.chain.map((c: any) => c.name).join(' > ')}`);
say('');

// One real envelope, sent and signed, completed by the app.
const c = await signUp('Sandbox Sealer', 'sandbox-sealer@example.com', '198.51.100.250');
const env = await simple(c, 'sandbox-signer@example.com');
if ((await c.post(`/envelopes/${env.id}/send`)).status !== 200) throw new Error('send failed');
if ((await signAll(env.id, 'sandbox-signer@example.com')).status !== 200) throw new Error('signing failed');
const row = s.db.get('SELECT status, final_sha256, seal_level, seal_tsa, seal_ltv, seal_ltv_note FROM envelopes WHERE id=?', env.id);
const pdf: Buffer = s.db.readBlob(row.final_sha256);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'sealed-sandbox-sample.pdf'), pdf);
say(`Envelope ${env.id}: ${row.status}, seal level ${row.seal_level}, time stamp ${row.seal_tsa}, long-term ${row.seal_ltv || 'none'}${row.seal_ltv_note ? ` (${row.seal_ltv_note})` : ''}`);
for (const a of s.db.all("SELECT action, detail FROM audit WHERE envelope_id=? AND (action LIKE 'Sealed by %' OR action IN ('Not sealed','Time-stamped','Not time-stamped'))", env.id)) say(`Record: ${a.action}. ${a.detail}`);
say('');

// ---- The checks --------------------------------------------------------------------------------
const text = pdf.toString('latin1');
const ranges = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)].map((m) => m.slice(1, 5).map(Number));
const r = ranges[0];
check('the file carries a seal', !!r && /ETSI\.CAdES\.detached/.test(text));
const hex = pdf.subarray(r[1] + 1, r[2] - 1).toString('latin1');
const d = Buffer.from(hex, 'hex');
const sigDer = d.subarray(0, der.read(d).end);
const covered = Buffer.concat([pdf.subarray(0, r[1]), pdf.subarray(r[2], r[2] + r[3])]);
const sd = cms.parseSignedData(sigDer);

// 1. openssl verifies the CMS over the ByteRange, up to the sandbox root the service gave.
const sandboxRoot = key.chain[key.chain.length - 1];
const pem = (b: Buffer) => `-----BEGIN CERTIFICATE-----\n${b.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
const v = run('openssl', ['cms', '-verify', '-inform', 'DER', '-in', file('seal.der', sigDer), '-binary', '-content', file('covered.bin', covered), '-CAfile', file('sandbox-root.pem', pem(sandboxRoot.der)), '-purpose', 'any', '-out', os.devNull]);
check('openssl cms -verify: the seal holds over the bytes its ByteRange covers, to the sandbox root', v.ok, v.out.trim().split('\n').pop());

// 2. The signer certificate is the sandbox credential's (fetched again here, apart from the app).
const tok = await (await fetch(process.env.SEAL_CSC_TOKEN_URL!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: process.env.SEAL_CSC_CLIENT_ID, grant_type: 'password', username: process.env.SEAL_CSC_USERNAME, password: process.env.SEAL_CSC_PASSWORD }) })).json();
const list = await (await fetch(`${process.env.SEAL_CSC_URL}/credentials/list`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ clientData: 'DS_ESEAL' }) })).json();
const info = await (await fetch(`${process.env.SEAL_CSC_URL}/credentials/info`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ credentialID: process.env.SEAL_CSC_CREDENTIAL_ID || list.credentialIDs[0], certificates: 'chain' }) })).json();
const credLeaf = Buffer.from(info.cert.certificates[0], 'base64');
const signer = cms.signerCert(sd, sd.signers[0]);
check('the signer certificate is the sandbox credential\'s', !!signer && signer.der.equals(credLeaf), `${signer?.name} (SHA-256 ${crypto.createHash('sha256').update(credLeaf).digest('hex')})`);
check('the whole chain the service gave is in the seal', info.cert.certificates.every((b: string) => sd.certificates.some((x) => x.equals(Buffer.from(b, 'base64')))), `${sd.certificates.length} certificates`);
check('the seal is signed with sha256WithRSAEncryption, as SSL.com signs', sd.signers[0].signatureAlgorithm === '1.2.840.113549.1.1.11');

// 3. The signature time stamp, checked by openssl ts against the bundled roots (deploy/tsa-roots.pem).
const tsAttr = cms.attrValue(sd.signers[0].unsignedAttrs, cms.OID.signatureTimeStamp);
if (tsAttr) {
  const token = Buffer.from(der.whole(tsAttr));
  const digest = crypto.createHash('sha256').update(sd.signers[0].signature).digest('hex');
  const t = run('openssl', ['ts', '-verify', '-in', file('sig-ts.der', token), '-token_in', '-digest', digest, '-CAfile', path.join(ROOT, 'deploy/tsa-roots.pem')]);
  check('openssl ts -verify: the signature time stamp is over the seal\'s signature and leads to a bundled root', t.ok && /Verification: OK/.test(t.out), t.out.trim().split('\n').pop());
  const p = run('openssl', ['ts', '-reply', '-in', file('sig-ts2.der', token), '-token_in', '-text']);
  const at = /Time stamp: (.*)/.exec(p.out)?.[1];
  const by = /TSA: (.*)/.exec(p.out)?.[1];
  say(`      time ${at || '?'}${by ? `, ${by.trim()}` : ''}`);
} else check('the seal carries a signature time stamp', false, 'none in the seal');

// 4. The DSS (long-term validation data) and 5. the document time stamp over the whole file (B-LTA).
const dss = /\/DSS\b/.test(text);
const ocsps = /\/OCSPs\s*\[/.test(text), crls = /\/CRLs\s*\[/.test(text);
// The sandbox certificates name SSL.com's development OCSP and CRL hosts (ocsp-dev.ssl.com, crl-dev.ssl.com). When the
// network this runs on does not let us reach them, the step cannot be done here: that is said, not counted as a fault.
const devBlocked = !dss && /(ocsp|crl)-dev\.ssl\.com: (it answered HTTP 403|this server is set to connect only|it could not be reached)/.test(row.seal_ltv_note || '');
check('the file carries a DSS with OCSP or CRL answers (PAdES B-LT)', dss && (ocsps || crls) ? true : devBlocked ? null : false, dss ? `OCSPs ${ocsps ? 'yes' : 'no'}, CRLs ${crls ? 'yes' : 'no'}` : `${devBlocked ? 'the sandbox certificates can only be checked at ocsp-dev.ssl.com and crl-dev.ssl.com, which this network refused: ' : ''}${row.seal_ltv_note || 'no DSS'}`);
const stamps = ranges.filter((x) => x[2] + x[3] === pdf.length && x !== r);
const docTs = /\/Type\s*\/DocTimeStamp/.test(text) && stamps.length > 0;
if (docTs) {
  const x = stamps[stamps.length - 1];
  const dd = Buffer.from(pdf.subarray(x[1] + 1, x[2] - 1).toString('latin1'), 'hex');
  const token = dd.subarray(0, der.read(dd).end);
  const digest = crypto.createHash('sha256').update(Buffer.concat([pdf.subarray(0, x[1]), pdf.subarray(x[2])])).digest('hex');
  const t = run('openssl', ['ts', '-verify', '-in', file('doc-ts.der', token), '-token_in', '-digest', digest, '-CAfile', path.join(ROOT, 'deploy/tsa-roots.pem')]);
  check('a document time stamp covers the whole file and openssl verifies it (PAdES B-LTA)', t.ok && /Verification: OK/.test(t.out), t.out.trim().split('\n').pop());
} else check('a document time stamp covers the whole file (PAdES B-LTA)', devBlocked ? null : false, 'none was added, because the long-term step did not complete (see the DSS line); the same step is shown on its own below');

// 6. Our own check, for comparison.
const ours = await seal.checkSeal(pdf);
say(`      GrowSigning's own check: intact ${ours?.intact}, whole file ${ours?.whole_file}, level ${ours?.level}, long term ${ours?.long_term}, time stamp ${ours?.timestamp_at}`);

// 7. poppler's pdfsig and, when installed, pyHanko.
const ps = run('pdfsig', [file('sealed.pdf', pdf)]);
check('pdfsig: the signature is valid and covers the document', /Signature is Valid/.test(ps.out) && /Total document signed|ranges cover/i.test(ps.out), ps.out.includes('not installed') ? 'pdfsig is not installed' : '');
say(ps.out.replace(/^/gm, '      | ').trimEnd());
const hanko = process.env.PYHANKO || 'pyhanko';
const roots = [...fs.readFileSync(path.join(ROOT, 'deploy/tsa-roots.pem'), 'utf8').matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n/g)].map((m, i) => ['--trust', file(`tsa-root-${i}.pem`, m[0])]).flat();
const ph = run(hanko, ['sign', 'validate', '--pretty-print', '--no-revocation-check', '--trust', file('sandbox-root2.pem', pem(sandboxRoot.der)), ...roots, '--trust-replace', file('sealed2.pdf', pdf)]);
if (/not installed/.test(ph.out)) check('pyHanko validates the seal', null, 'pyHanko is not installed (set PYHANKO to its path)');
else {
  check('pyHanko: the seal is intact and trusted up to the sandbox root, with nothing else changed after it', /INTACT:TRUSTED/.test(ph.out) || /The signature is judged VALID|judged to be valid/i.test(ph.out), '');
  say(ph.out.replace(/^/gm, '      | ').trimEnd());
}

// 8. The file is not otherwise changed: page 1 of the stored file and of the same envelope rendered again without
// any seal look the same pixel for pixel (pdftoppm, 100 dpi).
const plain: Buffer = Buffer.from(await s.env.buildPdf(s.env.loadEnvelope(env.id), true));
const png = (name: string, data: Buffer) => {
  const f = file(name, data);
  const outBase = path.join(work, `${name}-p1`);
  const r2 = run('pdftoppm', ['-r', '100', '-f', '1', '-l', '1', '-png', '-singlefile', f, outBase]);
  return r2.ok ? fs.readFileSync(`${outBase}.png`) : null;
};
const a = png('before.pdf', plain), b = png('after.pdf', pdf);
if (!a || !b) check('page 1 looks the same before and after the seal', null, 'pdftoppm is not installed');
else check('page 1 looks the same before and after the seal (pdftoppm, 100 dpi, byte-identical PNG)', a.equals(b), `SHA-256 ${crypto.createHash('sha256').update(a).digest('hex').slice(0, 16)}... and ${crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)}...`);

// 9. A completed PDF without a seal still gets a document time stamp over the whole file, from each real service.
for (const url of ['http://timestamp.digicert.com', 'http://ts.ssl.com']) {
  const keep = Object.fromEntries(Object.keys(SANDBOX).map((k) => [k, process.env[k]]));
  for (const k of Object.keys(SANDBOX)) delete process.env[k];
  process.env.TSA_URL = url;
  sealkey.forgetSealKey();
  try {
    const host = new URL(url).host;
    const c2 = await signUp(`Stamp Only ${host}`, `stamp-only-${host}@example.com`, '198.51.100.251');
    const e2 = await simple(c2, `stamp-signer-${host}@example.com`);
    await c2.post(`/envelopes/${e2.id}/send`);
    await signAll(e2.id, `stamp-signer-${host}@example.com`);
    const f2: Buffer = s.db.readBlob(s.db.get('SELECT final_sha256 FROM envelopes WHERE id=?', e2.id).final_sha256);
    const m = [...f2.toString('latin1').matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)].map((x) => x.slice(1, 5).map(Number)).pop();
    if (!m || m[2] + m[3] !== f2.length || !/\/Type\s*\/DocTimeStamp/.test(f2.toString('latin1'))) {
      check(`without a seal, ${host} puts a document time stamp over the whole completed PDF`, false, s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Not time-stamped'", e2.id)?.detail || 'none in the file');
      continue;
    }
    const dd = Buffer.from(f2.subarray(m[1] + 1, m[2] - 1).toString('latin1'), 'hex');
    const token = dd.subarray(0, der.read(dd).end);
    const digest = crypto.createHash('sha256').update(Buffer.concat([f2.subarray(0, m[1]), f2.subarray(m[2])])).digest('hex');
    const t = run('openssl', ['ts', '-verify', '-in', file(`only-${host}.der`, token), '-token_in', '-digest', digest, '-CAfile', path.join(ROOT, 'deploy/tsa-roots.pem')]);
    const p = run('openssl', ['ts', '-reply', '-in', file(`only2-${host}.der`, token), '-token_in', '-text']);
    check(`without a seal, ${host} puts a document time stamp over the whole completed PDF, and openssl verifies it to a bundled root`, t.ok && /Verification: OK/.test(t.out), `time ${(/Time stamp: (.*)/.exec(p.out)?.[1] || '').trim()}`);
  } finally {
    Object.assign(process.env, keep);
    sealkey.forgetSealKey();
  }
}
say('');
say('The sandbox CA is "SSL.com Root Certification Authority RSA - Development", which is on no trust list. Acrobat will say');
say('"validity unknown" for this file, and that is expected. A production eSealing certificate chains to an authority on the');
say('Adobe Approved Trust List, and Acrobat then shows "Signed and all signatures are valid".');

fs.writeFileSync(path.join(outDir, 'sealed-sandbox-verify.txt'), lines.join('\n') + '\n');
finish(checks.some((x) => x.ok === false) ? 1 : 0);
