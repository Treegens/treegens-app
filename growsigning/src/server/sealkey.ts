// The key and certificate the digital seal is made with, behind a signer (SealSigner in sealcms.ts), so a key file and
// a cloud signing service are used the same way by everything else. Read from the settings:
//   SEAL_P12 (path to a .p12 or .pfx file) with SEAL_P12_PASSWORD, or
//   SEAL_KEY_PEM, SEAL_CERT_PEM and SEAL_CHAIN_PEM (each a path to a PEM file, or the PEM text itself), or
//   SEAL_CSC_* (sealcsc.ts): a cloud signing service (SSL.com eSigner) that keeps the key and signs a fingerprint.
//     The certificate chain is the one the service gives; the key usage, the chain and the dates are checked here the
//     same way, and every signature value it answers is checked with the certificate before it is used.
// RSA of 2048 bits or more (signed with RSASSA-PSS) or ECDSA on P-256. Sealing is refused, and completed PDFs are
// made without a seal exactly as before, when the key cannot be read, does not belong to the certificate, the
// certificate has expired or is not yet valid, its key usage allows neither digitalSignature nor nonRepudiation, or the
// certificates that issued it are not given. Each refusal is logged and filed for the people who run the server once.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { readCert, issued, selfSigned, certHash, type CertInfo } from './x509.ts';
import { openP12, P12Error } from './p12.ts';
import type { SealSigner } from './sealcms.ts';
import { sealSet } from '../lib/seal.ts';
import { get, run } from './db.ts';
import { id, now, isEmail, baseUrl } from './util.ts';
import { sendMail } from './mail.ts';
import { seal } from './colcrypt.ts';
import { dayText } from '../lib/dates.ts';
import { cscConfigured, cscSettingsProblem, cscMaterial, cscSigner, type CscMaterial } from './sealcsc.ts';

/** `metered`: each signature is a paid signing of a cloud service (sealcsc.ts), so a seal is never signed twice for a time stamp. */
export type SealKey = { signer: SealSigner; cert: CertInfo; chain: CertInfo[]; hash: string; metered?: boolean };
export type SealState = { on: true; key: SealKey } | { on: false; configured: boolean; why?: string };

const SETTINGS = ['SEAL_P12', 'SEAL_P12_PASSWORD', 'SEAL_KEY_PEM', 'SEAL_CERT_PEM', 'SEAL_CHAIN_PEM'];

/** Whether the person who runs the server has set a seal key at all (it may still be refused). */
export const sealConfigured = () => sealSet() || !!process.env.SEAL_CERT_PEM;

class Refused extends Error {}

const pemOrFile = (v: string, what: string): string => {
  if (/-----BEGIN /.test(v)) return v.replace(/\\n/g, '\n');
  try {
    return fs.readFileSync(v, 'utf8');
  } catch {
    // A value that is not a short path may be key material pasted without its BEGIN line: it is never repeated.
    throw new Refused(v.length <= 300 && !/\s/.test(v) ? `${what} names a file that cannot be read: ${v}.` : `${what} is neither a path to a file nor PEM text (PEM starts with "-----BEGIN").`);
  }
};

const pemBlocks = (text: string, label: string): Buffer[] =>
  [...text.matchAll(new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`, 'g'))].map((m) => Buffer.from(m[1].replace(/\s+/g, ''), 'base64'));

function load(): { key: crypto.KeyObject; certs: Buffer[]; mine: Buffer | null } {
  const p12 = process.env.SEAL_P12;
  const pem = process.env.SEAL_KEY_PEM;
  if (p12 && (pem || process.env.SEAL_CERT_PEM)) throw new Refused('Both SEAL_P12 and SEAL_KEY_PEM/SEAL_CERT_PEM are set. Set one of the two.');
  if (p12) {
    let file: Buffer;
    try {
      file = fs.readFileSync(p12);
    } catch {
      throw new Refused(`SEAL_P12 names a file that cannot be read: ${p12}.`);
    }
    try {
      const r = openP12(file, process.env.SEAL_P12_PASSWORD || '');
      return { key: r.key, certs: r.certs, mine: r.keyCert };
    } catch (e) {
      throw new Refused(e instanceof P12Error ? `SEAL_P12: ${e.message}` : `SEAL_P12 could not be opened: ${(e as Error).message}`);
    }
  }
  if (!pem || !process.env.SEAL_CERT_PEM) throw new Refused('SEAL_KEY_PEM and SEAL_CERT_PEM must both be set.');
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(pemOrFile(pem, 'SEAL_KEY_PEM'));
  } catch (e) {
    if (e instanceof Refused) throw e;
    throw new Refused('SEAL_KEY_PEM is not a private key this server can read. It must be an unencrypted PEM key (PKCS#8, or the RSA or EC form).');
  }
  const mine = pemBlocks(pemOrFile(process.env.SEAL_CERT_PEM, 'SEAL_CERT_PEM'), 'CERTIFICATE');
  if (!mine.length) throw new Refused('SEAL_CERT_PEM holds no certificate.');
  const chain = process.env.SEAL_CHAIN_PEM ? pemBlocks(pemOrFile(process.env.SEAL_CHAIN_PEM, 'SEAL_CHAIN_PEM'), 'CERTIFICATE') : [];
  if (process.env.SEAL_CHAIN_PEM && !chain.length) throw new Refused('SEAL_CHAIN_PEM holds no certificate.');
  return { key, certs: [...mine, ...chain], mine: mine[0] };
}

const spki = (k: crypto.KeyObject) => k.export({ type: 'spki', format: 'der' }) as Buffer;

function check(at = new Date()): SealKey {
  const { key, certs, mine } = load();
  let infos: CertInfo[];
  try {
    infos = certs.map(readCert);
  } catch {
    throw new Refused('One of the seal certificates cannot be read.');
  }
  const pub = spki(crypto.createPublicKey(key));
  const cert = infos.find((c) => mine && c.der.equals(mine) && spki(c.x509.publicKey).equals(pub)) || infos.find((c) => spki(c.x509.publicKey).equals(pub));
  if (!cert) throw new Refused('The seal key does not belong to the seal certificate. Check that the key and the certificate are a pair.');
  let scheme: SealSigner['scheme'];
  const d = key.asymmetricKeyDetails || {};
  if (key.asymmetricKeyType === 'rsa' && (d.modulusLength || 0) >= 2048) scheme = 'rsa-pss';
  else if (key.asymmetricKeyType === 'ec' && d.namedCurve === 'prime256v1') scheme = 'ecdsa-p256';
  else throw new Refused('The seal key must be RSA of 2048 bits or more, or ECDSA on the P-256 curve.');
  const chain = chainOf(cert, infos, process.env.SEAL_P12 ? 'Put it in the .p12 file.' : 'Put it in SEAL_CHAIN_PEM.', at);
  const signer: SealSigner = {
    scheme,
    chain: () => chain.map((c) => c.der),
    async sign(digest: Buffer, message: Buffer) {
      if (!crypto.createHash('sha256').update(message).digest().equals(digest)) throw new Error('the seal was asked to sign a digest that does not belong to its message');
      return scheme === 'rsa-pss'
        ? crypto.sign('sha256', message, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })
        : crypto.sign('sha256', message, { key, dsaEncoding: 'der' });
    },
  };
  return { signer, cert, chain, hash: certHash(cert.der) };
}

// The key usage, and the chain from the seal certificate up as far as the given certificates go, with their dates.
function chainOf(cert: CertInfo, infos: CertInfo[], where: string, at: Date): CertInfo[] {
  if (cert.keyUsage && !cert.keyUsage.digitalSignature && !cert.keyUsage.nonRepudiation) throw new Refused(`The seal certificate (${cert.name}) does not allow its key to sign documents: its key usage has neither digitalSignature nor nonRepudiation.`);
  const chain: CertInfo[] = [cert];
  const rest = infos.filter((c) => c !== cert);
  for (let c = cert; !selfSigned(c); ) {
    const up = rest.find((x) => !chain.includes(x) && issued(x, c));
    if (!up) {
      if (c === cert) throw new Refused(`The certificate that issued the seal certificate (${cert.issuerName}) is not given. ${where}`);
      break;
    }
    chain.push(up);
    c = up;
  }
  checkDates(chain, at);
  return chain;
}

// The seal of a cloud signing service: the certificate and chain it gave (sealcsc.ts), checked as a key file's are.
function cscCheck(m: CscMaterial, at: Date): SealKey {
  let infos: CertInfo[];
  try {
    infos = m.certs.map(readCert);
  } catch {
    throw new Refused('One of the certificates the signing service gave cannot be read.');
  }
  const cert = infos[0];
  const k = cert.x509.publicKey;
  const d = k.asymmetricKeyDetails || {};
  if (!((k.asymmetricKeyType === 'rsa' && (d.modulusLength || 0) >= 2048) || (k.asymmetricKeyType === 'ec' && d.namedCurve === 'prime256v1')))
    throw new Refused('The certificate of the signing service must have an RSA key of 2048 bits or more, or an ECDSA key on the P-256 curve.');
  const chain = chainOf(cert, infos, 'The signing service did not give it with the certificate.', at);
  return { signer: cscSigner(m, cert, () => chain.map((c) => c.der)), cert, chain, hash: certHash(cert.der), metered: true };
}

function checkDates(chain: CertInfo[], at: Date) {
  for (const c of chain) {
    const which = c === chain[0] ? 'The seal certificate' : `The certificate ${c.name}, which issued it,`;
    if (at < c.notBefore) throw new Refused(`${which} is not valid yet: it starts on ${dayText(c.notBefore)}.`);
    if (at > c.notAfter) throw new Refused(`${which} expired on ${dayText(c.notAfter)}. Renew it with the authority that issued it and set the new one.`);
  }
}

// Read once for each set of settings; the dates are checked again every time, so a certificate that expires while
// the server runs stops sealing that day.
const g = globalThis as any;
const signature = () => SETTINGS.map((k) => `${k}=${process.env[k] || ''}`).join('\n');

/** The seal key as it is now, or why there is none. */
export function sealState(at = new Date()): SealState {
  if (!sealConfigured()) return { on: false, configured: false };
  if (cscConfigured()) return cscState(at);
  const sig = signature();
  if (g.__sealKey?.sig !== sig) {
    try {
      g.__sealKey = { sig, key: check(at) };
    } catch (e) {
      g.__sealKey = { sig, why: e instanceof Refused ? e.message : `The seal key could not be read: ${(e as Error)?.message || e}` };
    }
  }
  const s = g.__sealKey;
  if (s.why) return refused(s.why);
  try {
    checkDates(s.key.chain, at);
  } catch (e) {
    return refused((e as Error).message);
  }
  return { on: true, key: s.key };
}

// The cloud seal: from the chain the service gave last (fetched before each seal by cscReady, finalpipe.ts).
function cscState(at: Date): SealState {
  const problem = cscSettingsProblem();
  if (problem) return refused(problem);
  const got = cscMaterial();
  // Not fetched yet and nothing failed: the seal is not used for this file, but nobody is alarmed.
  if (!('material' in got)) return got.why ? refused(got.why) : { on: false, configured: true, why: 'The seal certificate is still being fetched from the signing service.' };
  const m = got.material;
  const sig = `csc\n${m.sig}\n${m.fetchedAt}`;
  if (g.__sealKey?.sig !== sig) {
    try {
      g.__sealKey = { sig, key: cscCheck(m, at) };
    } catch (e) {
      g.__sealKey = { sig, why: e instanceof Refused ? e.message : `The seal certificate of the signing service could not be read: ${(e as Error)?.message || e}` };
    }
  }
  const s = g.__sealKey;
  if (s.why) return refused(s.why);
  try {
    checkDates(s.key.chain, at);
  } catch (e) {
    return refused((e as Error).message);
  }
  return { on: true, key: s.key };
}

function refused(why: string): SealState {
  tellOperators(why);
  return { on: false, configured: true, why };
}

// Logged and filed once for each reason (and again after a restart only if no open alert says the same).
/** `key`: what makes two alerts the same one (the reason without what differs per document); the words by default. */
export function tellOperators(why: string, key = why) {
  g.__sealTold ??= new Set<string>();
  if (g.__sealTold.has(key)) return;
  g.__sealTold.add(key);
  const subject = 'Completed PDFs are not being sealed';
  const lines = [why, 'Until this is fixed, completed PDFs are made exactly as before, without the digital seal, and their certificate of completion says nothing about a seal. Nothing else stops. Documents completed in the meantime are not sealed afterwards.'];
  console.error(`\n[seal] ${subject}\n[seal] ${lines.join('\n[seal] ')}\n`);
  try {
    const text = `${subject}\n\n${lines.join('\n')}`.slice(0, 5000);
    if (get("SELECT 1 x FROM support_requests WHERE status='open' AND col_find(message)=?", text)) return;
    const to = [...new Set([process.env.SUPPORT_EMAIL || '', ...(process.env.OPERATOR_EMAILS || '').split(',')].map((s) => s.trim().toLowerCase()).filter(isEmail))];
    run("INSERT INTO support_requests (id, email, name, topic, message, status, at) VALUES (?,?,?,'other',?,'open',?)", id('sup'), to[0] || 'files-alert@localhost', 'GrowSigning (automatic alert)', seal('support_requests.message', text), now());
    for (const t of to) sendMail({ to: t, subject, heading: subject, lines, cta: { label: 'Open the queue', url: `${baseUrl()}/app/operator` } }).catch((x: any) => console.error('[seal] could not email the operators', x?.message));
  } catch (x: any) {
    console.error('[seal] could not file the alert', x?.message);
  }
}

/** For tests: forget the key read from the settings, so changed settings are read again. */
export function forgetSealKey() {
  g.__sealKey = undefined;
  g.__sealTold = undefined;
}
