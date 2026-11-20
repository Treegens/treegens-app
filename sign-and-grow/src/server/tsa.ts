// An RFC 3161 time-stamp over the seal's signature value, which turns a PAdES B-B seal into B-T (ETSI EN 319 142-1
// clause 6.3, Table 1, row "signature-time-stamp"). Settings:
//   TSA_URL      the time-stamp service; several, separated by commas, are tried in order (TSA_URLS is read too)
//   TSA_USER     and TSA_PASSWORD, when the service wants HTTP Basic credentials
//   TSA_TRUST    optional: a PEM file of the certificates the service's own certificate must lead to
// Each service gets 10 seconds. An answer counts only when it verifies: granted, over the SHA-256 of our signature
// value, with our nonce, signed by a certificate meant for time-stamping that was valid at the time it gives, and,
// with TSA_TRUST, issued under one of those certificates. Otherwise the next service is asked, and when none
// answers the seal goes out at B-B (seal.ts); the PDF is never held back for it.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { seq, integer, octets, algorithm, bool, read, kids, whole, readOid, readInt, readOctets, readTime, readText, DerError } from './der.ts';
import { parseSignedData, checkSigner, OID } from './sealcms.ts';
import { readCert, issued, selfSigned, type CertInfo } from './x509.ts';

export const TSA_TIMEOUT_MS = 10_000;
const MAX_ANSWER = 256 * 1024;
const TIME_STAMPING = '1.3.6.1.5.5.7.3.8';

/** The services to ask, in order. Empty when none is set. */
export function tsaUrls(): string[] {
  return [...new Set(`${process.env.TSA_URL || ''},${process.env.TSA_URLS || ''}`.split(',').map((s) => s.trim()).filter((s) => /^https?:\/\/[^\s]+$/i.test(s)))];
}

export class TsaError extends Error {}

export type TimeStamp = { token: Buffer; time: Date; url: string; host: string; tsaName: string; trusted: boolean };

function trustCerts(): CertInfo[] | null {
  const f = process.env.TSA_TRUST;
  if (!f) return null;
  let text: string;
  try {
    text = /-----BEGIN /.test(f) ? f : fs.readFileSync(f, 'utf8');
  } catch {
    throw new TsaError(`TSA_TRUST names a file that cannot be read: ${f}.`);
  }
  const out = [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) => readCert(Buffer.from(m[1].replace(/\s+/g, ''), 'base64')));
  if (!out.length) throw new TsaError('TSA_TRUST holds no certificate.');
  return out;
}

/** The request (RFC 3161 section 2.4.1): SHA-256 of the signature value, a nonce, and the service's certificate asked for. */
export function timeStampRequest(imprint: Buffer, nonce: Buffer): Buffer {
  return seq(integer(1), seq(algorithm(OID.sha256, null), octets(imprint)), integer(nonce), bool(true));
}

/** Checks an answer (RFC 3161 section 2.4.2) and returns its token and time. Throws TsaError saying why not. */
export function checkAnswer(answer: Buffer, imprint: Buffer, nonce: Buffer, trust = trustCerts()): { token: Buffer; time: Date; tsaName: string; trusted: boolean } {
  try {
    const top = kids(read(answer));
    const status = kids(top[0]);
    const code = Number(readInt(status[0]));
    if (code !== 0 && code !== 1) {
      const said = status[1] && status[1].tag === 0x30 ? kids(status[1]).map(readText).join(' ') : '';
      throw new TsaError(`the service refused (status ${code}${said ? `: ${said.slice(0, 200)}` : ''})`);
    }
    if (!top[1]) throw new TsaError('the service sent no time-stamp');
    const token = Buffer.from(whole(top[1]));
    const sd = parseSignedData(token);
    if (sd.eContentType !== OID.tstInfo || !sd.eContent) throw new TsaError('the answer is not a time-stamp');
    const info = kids(read(sd.eContent));
    const mi = kids(info[2]);
    if (readOid(kids(mi[0])[0]) !== OID.sha256 || !readOctets(mi[1]).equals(imprint)) throw new TsaError('the time-stamp is not over our signature');
    const time = readTime(info[4]);
    let got: bigint | null = null;
    for (const n of info.slice(5)) if (n.tag === 0x02) got = readInt(n);
    const want = BigInt(`0x${nonce.toString('hex')}`);
    if (got !== want) throw new TsaError('the time-stamp does not carry our nonce, so it may be an old answer');
    if (sd.signers.length !== 1) throw new TsaError('the time-stamp has more or fewer than one signer');
    const s = sd.signers[0];
    const eContent = sd.eContent;
    const c = checkSigner(sd, s, (h) => crypto.createHash(h).update(eContent).digest());
    if (!c.ok || !c.cert) throw new TsaError(`the time-stamp's own signature does not hold: ${c.why}`);
    if (!c.cert.extKeyUsage?.includes(TIME_STAMPING)) throw new TsaError('the certificate that signed the time-stamp is not meant for time-stamping');
    if (time < c.cert.notBefore || time > c.cert.notAfter) throw new TsaError('the certificate that signed the time-stamp was not valid at the time it gives');
    let trusted = false;
    if (trust) {
      const pool = [...sd.certificates.map((d) => readCert(d)), ...trust];
      const anchored = (x: CertInfo) => trust.some((t) => t.der.equals(x.der));
      let at: CertInfo = c.cert;
      for (let hops = 0; hops < 8 && !anchored(at); hops++) {
        const up = pool.find((p) => p !== at && issued(p, at));
        if (!up || selfSigned(at)) break;
        at = up;
      }
      if (!anchored(at)) throw new TsaError('the time-stamp service\'s certificate does not lead to one in TSA_TRUST');
      trusted = true;
    }
    return { token, time, tsaName: c.cert.name, trusted };
  } catch (e) {
    if (e instanceof TsaError) throw e;
    if (e instanceof DerError) throw new TsaError('the answer is not a time-stamp this server can read');
    throw new TsaError(`the answer could not be checked: ${(e as Error)?.message || e}`);
  }
}

/** Asks each service in turn for a time-stamp over `signature`. Throws TsaError naming what each one did. */
export async function timeStamp(signature: Buffer, urls = tsaUrls()): Promise<TimeStamp> {
  if (!urls.length) throw new TsaError('no time-stamp service is set');
  const imprint = crypto.createHash('sha256').update(signature).digest();
  const failures: string[] = [];
  const trust = trustCerts();
  const user = process.env.TSA_USER;
  for (const url of urls) {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    const nonce = crypto.randomBytes(8);
    nonce[0] &= 0x7f;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/timestamp-query',
          accept: 'application/timestamp-reply',
          ...(user ? { authorization: `Basic ${Buffer.from(`${user}:${process.env.TSA_PASSWORD || ''}`).toString('base64')}` } : {}),
        },
        body: new Uint8Array(timeStampRequest(imprint, nonce)),
        signal: AbortSignal.timeout(TSA_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!res.ok) throw new TsaError(`it answered HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_ANSWER) throw new TsaError('its answer is far too large for a time-stamp');
      const r = checkAnswer(body, imprint, nonce, trust);
      return { ...r, url, host };
    } catch (e: any) {
      const why = e instanceof TsaError ? e.message : e?.name === 'TimeoutError' ? `it did not answer within ${TSA_TIMEOUT_MS / 1000} seconds` : `it could not be reached (${String(e?.cause?.code || e?.message || e).slice(0, 120)})`;
      failures.push(`${host}: ${why}`);
    }
  }
  throw new TsaError(failures.join('; '));
}
