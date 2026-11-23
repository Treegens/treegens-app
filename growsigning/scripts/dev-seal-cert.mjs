// npm run seal:dev-cert
//
// Makes a self-signed test certificate for the digital seal and writes it to ./certs/dev-seal.p12 (or the path in
// LOCAL_P12_PATH), protected with LOCAL_P12_PASSWORD or "changeit". For trying the seal on your own computer before
// you buy a certificate. Never for real customers: a production server refuses it (src/server/sealkey.ts).
//
//   npm run seal:dev-cert             make it; stops if the file is already there
//   npm run seal:dev-cert -- --force  make a new one over the old one
//
// It uses the openssl program, which Linux, macOS and Git for Windows bring along. Nothing is sent anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const NAME = 'GrowSigning development seal';
const force = process.argv.includes('--force');
const out = path.resolve(process.env.LOCAL_P12_PATH || './certs/dev-seal.p12');
const shown = process.env.LOCAL_P12_PATH || './certs/dev-seal.p12';
const password = process.env.LOCAL_P12_PASSWORD || 'changeit';

const stop = (lines) => {
  console.error(`\n${lines.join('\n')}\n`);
  process.exit(1);
};

if (fs.existsSync(out) && !force) stop([`${shown} is already there, and it was left as it is.`, 'To make a new one over it: npm run seal:dev-cert -- --force']);

const openssl = (args, env = {}) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
try {
  openssl(['version']);
} catch (e) {
  stop(e?.code === 'ENOENT'
    ? ['The openssl program was not found, and this script needs it to make the certificate.',
      'Install it and run this again: on Debian or Ubuntu "sudo apt install openssl", on macOS "brew install openssl",',
      'on Windows install Git for Windows and run this from Git Bash (it brings openssl).',
      'Or make a .p12 file any other way and set LOCAL_P12_PATH and LOCAL_P12_PASSWORD to it.']
    : [`The openssl program could not be run: ${String(e?.message || e).slice(0, 200)}`]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-seal-'));
try {
  const key = path.join(tmp, 'key.pem');
  const cert = path.join(tmp, 'cert.pem');
  const conf = path.join(tmp, 'openssl.cnf');
  // A certificate for signing documents and nothing else: digitalSignature and nonRepudiation, not an authority.
  fs.writeFileSync(conf, ['[req]', 'distinguished_name = dn', 'x509_extensions = ext', 'prompt = no', '[dn]', 'O = GrowSigning (development)', `CN = ${NAME}`,
    '[ext]', 'basicConstraints = critical, CA:FALSE', 'keyUsage = critical, digitalSignature, nonRepudiation', 'subjectKeyIdentifier = hash', ''].join('\n'));
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '365', '-keyout', key, '-out', cert, '-config', conf]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const made = path.join(tmp, 'seal.p12');
  // The password goes to openssl in an environment variable, never on the command line where other users could read it.
  openssl(['pkcs12', '-export', '-inkey', key, '-in', cert, '-name', NAME, '-out', made, '-passout', 'env:DEV_SEAL_P12_PASSWORD'], { DEV_SEAL_P12_PASSWORD: password });
  fs.copyFileSync(made, out);
  try {
    fs.chmodSync(out, 0o600);
  } catch {
    // Windows has no such permissions.
  }
} catch (e) {
  stop(['The certificate could not be made.', String(e?.stderr || e?.message || e).trim().slice(0, 600)]);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const until = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
console.log(`
Made ${shown}: a self-signed certificate "${NAME}", for signing documents, valid until ${until}.

Put these lines in .env.local (or .env), then start the app and complete a document:

PDF_SIGNING_MODE=local_p12
LOCAL_P12_PATH=${shown}
LOCAL_P12_PASSWORD=${password}

Adobe Acrobat will show a yellow bar that says the validity of the signature is unknown, until you trust this
certificate by hand on that computer. That is expected for a certificate you made yourself: it means Acrobat cannot
tell whose certificate it is, not that the file was changed. The blue bar "Signed and all signatures are valid" needs
a certificate from an authority on the Adobe Approved Trust List, which is the csc mode (see README, "Sealing in two modes").
Keep this file out of git (certs/ is in .gitignore), and do not use it on a production server.
`);
