// The digital seal made by a cloud signing service through the Cloud Signature Consortium (CSC) API, version 0 as
// SSL.com eSigner serves it (https://cs.ssl.com/csc/v0). A certificate on the Adobe Approved Trust List must keep its
// private key in certified hardware, so a hosted server can only seal with one this way: the key stays with the
// service, and this server sends it nothing but the SHA-256 fingerprint of what the seal signs (the CMS signed
// attributes, which hold the fingerprint of the PDF). The document itself never leaves the server.
//
// Settings (src/lib/seal.ts reads which are set):
//   SEAL_CSC_URL            the CSC API, default https://cs.ssl.com/csc/v0 (SSL.com's sandbox: https://cs-try.ssl.com/csc/v0)
//   SEAL_CSC_TOKEN_URL      where the access token comes from, default https://login.ssl.com/oauth2/token
//                           (sandbox: https://oauth-sandbox.ssl.com/oauth2/token)
//   SEAL_CSC_CLIENT_ID      required: the client id (SSL.com calls it the application id)
//   SEAL_CSC_CLIENT_SECRET  the client secret, when the client has one
//   SEAL_CSC_USERNAME       required: the SSL.com account the certificate is enrolled under
//   SEAL_CSC_PASSWORD       required: its password
//   SEAL_CSC_CREDENTIAL_ID  optional: the credential (the certificate) to seal with; the first one listed when unset
//   SEAL_CSC_TOTP_SECRET    optional: the secret behind the one-time codes, as SSL.com shows it (base64). Only needed
//                           when the credential asks for a code; an eSealing credential does not ("authMode":"implicit")
//
// The calls: POST oauth2/token (password grant), credentials/list (only without SEAL_CSC_CREDENTIAL_ID; first with
// "clientData":"DS_ESEAL", which is how SSL.com lists eSealing certificates, then without), credentials/info (the
// certificate chain, fetched once and again every day), and for each seal credentials/authorize (numSignatures 1, the
// fingerprint, the one-time code when one is needed) then signatures/signHash (the fingerprint, hashAlgo SHA-256,
// signAlgo sha256WithRSAEncryption or ecdsa-with-SHA256), which answers the signature value. The access token is kept
// until shortly before it expires. Every call gets 4 seconds and one seal 10 in all. When the service fails, the seal
// throws, and finishPdf (finalpipe.ts) makes the file without a seal exactly as it does when a key file fails ("Not
// sealed"), and the people who run the server are told why.
import crypto from 'node:crypto';
import { cscSettings } from '../lib/seal.ts';
import { readCert, type CertInfo } from './x509.ts';
import type { SealSigner } from './sealcms.ts';

export const CSC_TIMEOUT_MS = 4_000;
export const CSC_SIGN_TOTAL_MS = 10_000;
/** The certificate chain is fetched again after this long. */
export const CSC_CHAIN_REFRESH_MS = 24 * 3600_000;
/** After a failed fetch of the chain, the next try waits this long (a seal does not wait for a service that is down). */
export const CSC_RETRY_MS = 60_000;

const SHA256 = '2.16.840.1.101.3.4.2.1';
const SIGN_ALGO = { rsa: '1.2.840.113549.1.1.11', rsaEncryption: '1.2.840.113549.1.1.1', ecdsa: '1.2.840.10045.4.3.2' };

export class CscError extends Error {}

type Config = { url: string; tokenUrl: string; clientId: string; clientSecret: string; username: string; password: string; credentialId: string; totp: string };
/** What the service gave about the credential, kept between seals. */
export type CscMaterial = { credentialId: string; certs: Buffer[]; authMode: string; signAlgo: string; fetchedAt: number; sig: string };

const g = globalThis as any;
type State = { sig?: string; token?: { value: string; until: number }; tokenLoading?: Promise<string> | null; material?: CscMaterial; loading?: Promise<void> | null; why?: string; failedAt?: number; otpLine?: Promise<unknown> };
const st = (): State => (g.__sgCsc ??= {});

const v = (k: string) => (process.env[k] || '').trim();
const settingsSig = () => ['SEAL_CSC_URL', 'SEAL_CSC_TOKEN_URL', 'SEAL_CSC_CLIENT_ID', 'SEAL_CSC_CLIENT_SECRET', 'SEAL_CSC_USERNAME', 'SEAL_CSC_PASSWORD', 'SEAL_CSC_CREDENTIAL_ID', 'SEAL_CSC_TOTP_SECRET'].map((k) => `${k}=${v(k)}`).join('\n');

/** Whether any cloud seal setting is set (it may still be half set). */
export const cscConfigured = () => cscSettings().any;

/** Why the cloud seal settings cannot be used as they are, or null. Never repeats a secret. */
export function cscSettingsProblem(): string | null {
  const s = cscSettings();
  if (!s.any) return null;
  if (s.missing.length) return `The cloud seal is half set up: ${s.missing.join(', ')} ${s.missing.length === 1 ? 'is' : 'are'} not set. Set ${s.missing.length === 1 ? 'it' : 'them'}, or take the other SEAL_CSC_ settings away.`;
  if (process.env.SEAL_P12 || process.env.SEAL_KEY_PEM || process.env.SEAL_CERT_PEM) return 'Both a seal key file (SEAL_P12 or SEAL_KEY_PEM) and a cloud seal (SEAL_CSC_) are set. Set one of the two.';
  for (const [k, u] of [['SEAL_CSC_URL', s.url], ['SEAL_CSC_TOKEN_URL', s.tokenUrl]] as const) {
    let p: URL;
    try {
      p = new URL(u);
    } catch {
      return `${k} is not an address.`;
    }
    // The password and the token only ever go over https; plain http only to this machine itself (for tests).
    if (p.protocol !== 'https:' && !(p.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(p.hostname))) return `${k} must be an https address.`;
  }
  return null;
}

function config(): Config {
  const s = cscSettings();
  return { url: s.url, tokenUrl: s.tokenUrl, clientId: v('SEAL_CSC_CLIENT_ID'), clientSecret: v('SEAL_CSC_CLIENT_SECRET'), username: v('SEAL_CSC_USERNAME'), password: v('SEAL_CSC_PASSWORD'), credentialId: v('SEAL_CSC_CREDENTIAL_ID'), totp: v('SEAL_CSC_TOTP_SECRET') };
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return 'the signing service';
  }
};

// One call: JSON in, JSON out, a short timeout, and the service's own error words (never our secrets) when it fails.
async function call(url: string, body: any, token: string | null, until: number): Promise<any> {
  const wait = Math.min(CSC_TIMEOUT_MS, until - Date.now());
  if (wait < 200) throw new CscError(`the ${CSC_SIGN_TOTAL_MS / 1000} seconds for the signing service were used up`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(wait),
      redirect: 'error',
    });
  } catch (e: any) {
    throw new CscError(e?.name === 'TimeoutError' ? `${hostOf(url)} did not answer within ${Math.round(wait / 100) / 10} seconds` : `${hostOf(url)} could not be reached (${String(e?.cause?.code || e?.message || e).slice(0, 120)})`);
  }
  const text = (await res.text().catch(() => '')).slice(0, 2_000_000);
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const said = json && (json.error_description || json.error || json.message);
    throw Object.assign(new CscError(`${hostOf(url)} answered HTTP ${res.status}${said ? `: ${String(said).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`), { status: res.status, code: json?.error || '' });
  }
  if (!json || typeof json !== 'object') throw new CscError(`${hostOf(url)} did not answer with JSON`);
  return json;
}

/**
 * The access token: kept until shortly before it expires, and fetched once for all the seals that need it at the same
 * moment (one password grant, not one per document). `stale`: the token the service just refused; a new one is
 * fetched only if that is still the one kept.
 */
async function accessToken(c: Config, until: number, stale?: string): Promise<string> {
  const s = st();
  if (stale && s.token?.value === stale) s.token = undefined;
  if (s.token && s.token.until > Date.now()) return s.token.value;
  if (s.tokenLoading) return s.tokenLoading;
  const p = fetchToken(c, until, s);
  s.tokenLoading = p;
  try {
    return await p;
  } finally {
    if (s.tokenLoading === p) s.tokenLoading = null;
  }
}

async function fetchToken(c: Config, until: number, s: State): Promise<string> {
  const j = await call(c.tokenUrl, { client_id: c.clientId, ...(c.clientSecret ? { client_secret: c.clientSecret } : {}), grant_type: 'password', username: c.username, password: c.password }, null, until)
    .catch((e) => {
      throw new CscError(`signing in to the signing service failed: ${e.message}. Check SEAL_CSC_CLIENT_ID, SEAL_CSC_CLIENT_SECRET, SEAL_CSC_USERNAME and SEAL_CSC_PASSWORD.`);
    });
  if (typeof j.access_token !== 'string' || !j.access_token) throw new CscError('the signing service gave no access token');
  const life = Number(j.expires_in) > 0 ? Number(j.expires_in) * 1000 : 3600_000;
  // Kept until a minute before it expires (half its life when it is short), so it never runs out during a seal.
  if (st() === s) s.token = { value: j.access_token, until: Date.now() + Math.max(life - 60_000, life / 2) };
  return j.access_token;
}

/** A call with the access token; a token the service no longer takes is fetched again once. */
async function withToken(c: Config, path: string, body: any, until: number): Promise<any> {
  const url = `${c.url}/${path}`;
  const token = await accessToken(c, until);
  try {
    return await call(url, body, token, until);
  } catch (e: any) {
    if (e?.status !== 401) throw e;
    return call(url, body, await accessToken(c, until, token), until);
  }
}

/** RFC 6238: the 6-digit code for now, from the secret as SSL.com shows it (base64), or base32 as most apps show it. */
export function totpCode(secret: string, at = Date.now(), step = 30): string {
  const s = secret.replace(/\s+/g, '');
  const key = /^[A-Z2-7]+=*$/.test(s) ? base32(s) : Buffer.from(s, 'base64');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function base32(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '')) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) || []).map((b) => parseInt(b, 2)));
}

// ---- The certificate chain ---------------------------------------------------------------------

async function fetchMaterial(c: Config): Promise<CscMaterial> {
  const until = Date.now() + CSC_SIGN_TOTAL_MS;
  let credentialId = c.credentialId;
  if (!credentialId) {
    for (const body of [{ clientData: 'DS_ESEAL' }, {}]) {
      const j = await withToken(c, 'credentials/list', body, until);
      const ids = Array.isArray(j.credentialIDs) ? j.credentialIDs.filter((x: any) => typeof x === 'string' && x) : [];
      if (ids.length) {
        credentialId = ids[0];
        break;
      }
    }
    if (!credentialId) throw new CscError('the signing service lists no certificate for this account. Enrol the certificate in eSigner (eSealing), or set SEAL_CSC_CREDENTIAL_ID.');
  }
  const j = await withToken(c, 'credentials/info', { credentialID: credentialId, certificates: 'chain', certInfo: true, authInfo: true }, until);
  const list: any[] = Array.isArray(j?.cert?.certificates) ? j.cert.certificates : [];
  const certs = list.filter((x) => typeof x === 'string').map((b64) => Buffer.from(b64, 'base64'));
  if (!certs.length) throw new CscError('the signing service gave no certificate for the credential');
  try {
    certs.forEach(readCert);
  } catch {
    throw new CscError('a certificate the signing service gave cannot be read');
  }
  if (j?.key?.status && j.key.status !== 'enabled') throw new CscError(`the signing service says the key of this credential is ${String(j.key.status).slice(0, 40)}`);
  if (j?.cert?.status && j.cert.status !== 'valid') throw new CscError(`the signing service says the certificate of this credential is ${String(j.cert.status).slice(0, 40)}`);
  const authMode = String(j.authMode || '');
  if (authMode && authMode !== 'implicit' && !c.totp) throw new CscError('this certificate needs a one-time code for every seal, and SEAL_CSC_TOTP_SECRET is not set. Set it, or convert the certificate to eSealing in the SSL.com dashboard (Remove 2FA), which needs no code.');
  const leaf = readCert(certs[0]);
  const algos: string[] = Array.isArray(j?.key?.algo) ? j.key.algo.map(String) : [];
  const ec = leaf.x509.publicKey.asymmetricKeyType === 'ec';
  const signAlgo = ec ? SIGN_ALGO.ecdsa : !algos.length || algos.includes(SIGN_ALGO.rsa) ? SIGN_ALGO.rsa : algos.includes(SIGN_ALGO.rsaEncryption) ? SIGN_ALGO.rsaEncryption : SIGN_ALGO.rsa;
  return { credentialId, certs, authMode, signAlgo, fetchedAt: Date.now(), sig: settingsSig() };
}

/**
 * Makes sure the chain is there and less than a day old, waiting for it at most a few seconds. Never throws: why it
 * could not be fetched is kept for cscMaterial(). Called before every seal (finishPdf) and when the server starts.
 */
export async function cscReady(): Promise<void> {
  if (!cscConfigured() || cscSettingsProblem()) return;
  const s = st();
  const sig = settingsSig();
  if (s.sig !== sig) {
    // New settings: nothing kept from the old ones is used.
    g.__sgCsc = { sig };
    return cscReady();
  }
  const fresh = s.material && Date.now() - s.material.fetchedAt < CSC_CHAIN_REFRESH_MS;
  if (fresh) return;
  if (!s.loading && !(s.failedAt && Date.now() - s.failedAt < CSC_RETRY_MS)) {
    s.loading = fetchMaterial(config()).then(
      (m) => {
        if (st() !== s) return;
        s.material = m;
        s.why = undefined;
        s.failedAt = undefined;
      },
      (e) => {
        if (st() !== s) return;
        s.why = `The seal certificate could not be fetched from the signing service: ${e?.message || e}`;
        s.failedAt = Date.now();
      },
    ).finally(() => {
      if (st() === s) s.loading = null;
    });
  }
  // A chain fetched before (under a day ago or not) keeps being used while a new one is fetched; none: wait for it.
  if (!s.material && s.loading) await s.loading;
}

/** The chain as last fetched (possibly more than a day old while a new one is being fetched), or why there is none. */
export function cscMaterial(): { material: CscMaterial } | { why: string | null } {
  const s = st();
  if (s.sig === settingsSig() && s.material) {
    if (Date.now() - s.material.fetchedAt >= CSC_CHAIN_REFRESH_MS) void cscReady();
    return { material: s.material };
  }
  if (s.sig !== settingsSig() || (!s.loading && !s.why)) void cscReady();
  return { why: s.sig === settingsSig() ? s.why || null : null };
}

// ---- Signing ------------------------------------------------------------------------------------

/**
 * The signer for a credential: sends the SHA-256 digest it is given (and nothing else) and checks the signature value
 * the service answers with the certificate's own key before it goes into the seal.
 */
export function cscSigner(m: CscMaterial, cert: CertInfo, chain: () => Buffer[]): SealSigner {
  const ec = cert.x509.publicKey.asymmetricKeyType === 'ec';
  return {
    scheme: ec ? 'ecdsa-p256' : 'rsa-pkcs1',
    chain,
    async sign(digest: Buffer, message: Buffer) {
      if (!crypto.createHash('sha256').update(message).digest().equals(digest)) throw new Error('the seal was asked to sign a digest that does not belong to its message');
      const c = config();
      const until = Date.now() + CSC_SIGN_TOTAL_MS;
      const hash = digest.toString('base64');
      const sad = c.totp && m.authMode !== 'implicit' ? await withOtp(c, m, hash, until) : await authorize(c, m, hash, {}, until);
      let j: any;
      try {
        j = await withToken(c, 'signatures/signHash', { credentialID: m.credentialId, SAD: sad, hash: [hash], hashAlgo: SHA256, signAlgo: m.signAlgo }, until);
      } catch (e: any) {
        if (pointsAtCredential(e)) staleMaterial(m);
        throw new CscError(`the signing service did not sign: ${e?.message || e}`);
      }
      const b64 = Array.isArray(j.signatures) ? j.signatures[0] : null;
      if (typeof b64 !== 'string' || !b64) throw new CscError('the signing service answered without a signature');
      let sig: Buffer = Buffer.from(b64, 'base64');
      // ECDSA may come back as the two numbers side by side (IEEE P1363); the seal holds the DER form.
      // A DER signature on P-256 is never 64 bytes long, so a 64-byte one is always the raw form, whatever its first byte.
      if (ec && sig.length === 64) sig = p1363ToDer(sig);
      const ok = ec ? crypto.verify('sha256', message, { key: cert.x509.publicKey, dsaEncoding: 'der' }, sig) : crypto.verify('sha256', message, cert.x509.publicKey, sig);
      if (!ok) {
        // The key behind the credential may have been renewed or changed: the chain is fetched again before the next seal.
        staleMaterial(m);
        throw new CscError('the signature the signing service gave does not verify with the seal certificate, so it was not used. The certificate is fetched again from the service before the next seal');
      }
      return sig;
    },
  };
}

async function authorize(c: Config, m: CscMaterial, hash: string, otp: { OTP?: string }, until: number): Promise<string> {
  let sad: string;
  try {
    const a = await withToken(c, 'credentials/authorize', { credentialID: m.credentialId, numSignatures: 1, hash: [hash], ...otp }, until);
    sad = typeof a.SAD === 'string' ? a.SAD : '';
  } catch (e: any) {
    if ('OTP' in otp && e?.status && e.status < 500) throw Object.assign(new CscError(`the signing service refused to authorize the seal (${e.message}). The one-time code may be wrong: check SEAL_CSC_TOTP_SECRET and that this server's clock is right.`), { otpRefused: true });
    if (pointsAtCredential(e)) staleMaterial(m);
    throw new CscError(`the signing service did not authorize the seal: ${e?.message || e}`);
  }
  if (!sad) throw new CscError('the signing service gave no signature activation data');
  return sad;
}

/**
 * With one-time codes (a credential not converted to eSealing): one authorize at a time, so two seals never send the
 * same code, and a code that was refused is tried once more with the next one when the 30 seconds turned over in
 * between (the code can be read just before the step ends). This mode is meant for few seals; eSealing needs no code.
 */
async function withOtp(c: Config, m: CscMaterial, hash: string, until: number): Promise<string> {
  const s = st();
  const before = s.otpLine || Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => (done = r));
  s.otpLine = before.then(() => mine);
  try {
    await before;
    const first = totpCode(c.totp);
    try {
      return await authorize(c, m, hash, { OTP: first }, until);
    } catch (e: any) {
      const next = totpCode(c.totp);
      if (!e?.otpRefused || next === first) throw e;
      return await authorize(c, m, hash, { OTP: next }, until);
    }
  } finally {
    done();
  }
}

// A refusal that says something about the credential itself (not the token, not too many requests, not the service).
const pointsAtCredential = (e: any) => typeof e?.status === 'number' && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429;

/** The chain kept is not used again: the next seal waits for credentials/info (with the usual pause after a failure). */
function staleMaterial(m: CscMaterial) {
  const s = st();
  if (s.material === m) s.material = undefined;
}

function p1363ToDer(raw: Buffer): Buffer {
  const int = (b: Buffer) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let x = b.subarray(i);
    if (x[0] & 0x80) x = Buffer.concat([Buffer.from([0]), x]);
    return Buffer.concat([Buffer.from([0x02, x.length]), x]);
  };
  const body = Buffer.concat([int(raw.subarray(0, 32)), int(raw.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/** The lines the server logs once when it starts, when the cloud seal settings cannot be used as they are. */
export function cscStartLines(): string[] {
  const p = cscSettingsProblem();
  return p ? [`[config] ${p} Until then completed PDFs are made without the digital seal.`] : [];
}

/** For tests: forget the token, the chain and why they failed. */
export function forgetCsc() {
  g.__sgCsc = {};
}
