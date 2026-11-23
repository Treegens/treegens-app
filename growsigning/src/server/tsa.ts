// An RFC 3161 time-stamp over the seal's signature value, which turns a PAdES B-B seal into B-T (ETSI EN 319 142-1
// clause 6.3, Table 1, row "signature-time-stamp"). Settings:
//   TSA_URL      the time-stamp service; several, separated by commas, are tried in order (TSA_URLS is read too)
//   TSA_USER     and TSA_PASSWORD, when the service wants HTTP Basic credentials
//   TSA_TRUST    optional: a PEM file of the certificates the service's own certificate must lead to, the PEM text
//                itself, or "bundled": the roots of DigiCert and SSL.com built into the server (tsaroots.ts, the
//                same as deploy/tsa-roots.pem), for http://timestamp.digicert.com and http://ts.ssl.com
// Each service gets 3 seconds and all of them together 4, because the last signer's Finish waits for the seal. A
// service that did not answer in time is left alone for 10 minutes (TSA_REST_MS), so nobody who finishes after that
// waits for it (signers who finish at the same moment wait together, never longer than the first one does). An
// answer counts only when it verifies: granted, over the SHA-256 of our signature value, with our nonce, signed by a
// certificate meant for time-stamping that was valid at the time it gives, a time within 5 minutes of this server's
// clock (a service that lies about the time, or a server whose clock is wrong, is caught there), and, with TSA_TRUST,
// issued under one of those certificates. Otherwise the next service is asked, and when none answers the seal goes
// out at B-B (seal.ts); the PDF is never held back for it, and a file sealed at B-B is never changed afterwards.
// Only with TSA_TRUST does anything call the time stamp "trusted": without it nobody checked whose service answered.
// TSA_USER and TSA_PASSWORD are only ever sent to https addresses; with them set, a plain http address is not asked.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { seq, integer, octets, algorithm, bool, read, kids, whole, readOid, readInt, readOctets, readTime, readText, DerError } from './der.ts';
import { parseSignedData, checkSigner, hashName, OID } from './sealcms.ts';
import { readCert, issued, selfSigned, type CertInfo } from './x509.ts';
import { BUNDLED_TSA_ROOTS } from './tsaroots.ts';

export const TSA_TIMEOUT_MS = 3_000;
/** All services together: the last signer's Finish waits for the seal, so never longer than this for time-stamps. */
export const TSA_TOTAL_MS = 4_000;
/**
 * A service that did not answer in time is not asked again for this long. Without it, every last signer would wait
 * the full TSA_TOTAL_MS for as long as a service hangs; with it, the signers who finish after that wait get their
 * file at once, sealed without a time-stamp and saying so. Signers who finish at the same moment, while the first
 * request is still out, do not each wait their own 3 seconds one after another: their requests end when the first
 * one's 3 seconds are up (`asking`). The rest is kept in this server process's memory, so after a restart, or on a
 * second server process, the next signer waits once more. A service that answers with an error did not make anybody
 * wait, so it is asked every time.
 */
export const TSA_REST_MS = 10 * 60_000;
const resting = new Map<string, number>();
/** For each service, when each request to it that has not been answered yet was sent. */
const asking = new Map<string, Set<{ at: number }>>();
/** For tests: forget which services are resting. */
export const tsaForgetRests = () => (resting.clear(), asking.clear());
/** How far the time in a time-stamp may be from this server's clock. */
export const TSA_CLOCK_MS = 5 * 60_000;
const MAX_ANSWER = 256 * 1024;
const TIME_STAMPING = '1.3.6.1.5.5.7.3.8';

/** The services to ask, in order. Empty when none is set. */
export function tsaUrls(): string[] {
  const all = `${process.env.TSA_URL || ''},${process.env.TSA_URLS || ''}`.split(',').map((s) => s.trim()).filter(Boolean);
  const ok = [...new Set(all.filter((s) => /^https?:\/\/[^\s]+$/i.test(s)))];
  const g = globalThis as any;
  if (ok.length < all.length && !g.__tsaWarned) {
    g.__tsaWarned = true;
    console.error(`[seal] TSA_URL holds ${all.length - ok.length === 1 ? 'an entry that is' : 'entries that are'} not an http or https address, and ${all.length - ok.length === 1 ? 'it is' : 'they are'} not asked.`);
  }
  return ok;
}

export class TsaError extends Error {}

export type TimeStamp = { token: Buffer; time: Date; url: string; host: string; tsaName: string; trusted: boolean };

/** Whether TSA_TRUST is set: only then is a time-stamp service's certificate checked against a list, and called trusted. */
export const tsaTrustSet = () => !!process.env.TSA_TRUST;

export function trustCerts(): CertInfo[] | null {
  const f = process.env.TSA_TRUST;
  if (!f) return null;
  let text: string;
  try {
    text = f.trim().toLowerCase() === 'bundled' ? BUNDLED_TSA_ROOTS : /-----BEGIN /.test(f) ? f.replace(/\\n/g, '\n') : fs.readFileSync(f, 'utf8');
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

/**
 * Checks a time-stamp token (RFC 3161 section 2.4.2) on its own: it is over `imprintFor(hash)`, signed by exactly one
 * certificate meant for time-stamping that was valid at the time it gives, and, with `trust`, issued under one of
 * those certificates. Throws TsaError saying why not. Used for a service's answer and for a token found in a file.
 */
export function checkToken(token: Buffer, imprintFor: (hash: string) => Buffer | null, trust: CertInfo[] | null): { time: Date; tsaName: string; trusted: boolean; nonce: bigint | null } {
  try {
    const sd = parseSignedData(token);
    if (sd.eContentType !== OID.tstInfo || !sd.eContent) throw new TsaError('the answer is not a time-stamp');
    const info = kids(read(sd.eContent));
    const mi = kids(info[2]);
    const hash = hashName(readOid(kids(mi[0])[0]));
    const want = hash && hash !== 'sha1' ? imprintFor(hash) : null;
    if (!want || !readOctets(mi[1]).equals(want)) throw new TsaError('the time-stamp is not over our signature');
    const time = readTime(info[4]);
    let nonce: bigint | null = null;
    for (const n of info.slice(5)) if (n.tag === 0x02) nonce = readInt(n);
    if (sd.signers.length !== 1) throw new TsaError('the time-stamp has more or fewer than one signer');
    const s = sd.signers[0];
    const eContent = sd.eContent;
    const c = checkSigner(sd, s, (h) => crypto.createHash(h).update(eContent).digest());
    if (!c.ok || !c.cert) throw new TsaError(`the time-stamp's own signature does not hold: ${c.why}`);
    if (!c.cert.extKeyUsage?.includes(TIME_STAMPING)) throw new TsaError('the certificate that signed the time-stamp is not meant for time-stamping');
    if (time < c.cert.notBefore || time > c.cert.notAfter) throw new TsaError('the certificate that signed the time-stamp was not valid at the time it gives');
    let trusted = false;
    if (trust) {
      // The listed certificates first: a service may send a copy of its root issued by an older root (DigiCert sends
      // Trusted Root G4 issued by Assured ID Root CA), and the walk must stop at the listed one, not climb past it.
      const pool = [...trust, ...sd.certificates.map((d) => readCert(d))];
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
    return { time, tsaName: c.cert.name, trusted, nonce };
  } catch (e) {
    if (e instanceof TsaError) throw e;
    if (e instanceof DerError) throw new TsaError('the answer is not a time-stamp this server can read');
    throw new TsaError(`the answer could not be checked: ${(e as Error)?.message || e}`);
  }
}

/** Checks a service's answer and returns its token and time: checkToken, our nonce, and a time near our clock (`at`). */
export function checkAnswer(answer: Buffer, imprint: Buffer, nonce: Buffer, trust = trustCerts(), at = new Date()): { token: Buffer; time: Date; tsaName: string; trusted: boolean } {
  let token: Buffer;
  try {
    const top = kids(read(answer));
    const status = kids(top[0]);
    const code = Number(readInt(status[0]));
    if (code !== 0 && code !== 1) {
      const said = status[1] && status[1].tag === 0x30 ? kids(status[1]).map(readText).join(' ') : '';
      throw new TsaError(`the service refused (status ${code}${said ? `: ${said.slice(0, 200)}` : ''})`);
    }
    if (!top[1]) throw new TsaError('the service sent no time-stamp');
    token = Buffer.from(whole(top[1]));
  } catch (e) {
    if (e instanceof TsaError) throw e;
    throw new TsaError('the answer is not a time-stamp this server can read');
  }
  const r = checkToken(token, (h) => (h === 'sha256' ? imprint : null), trust);
  if (r.nonce !== BigInt(`0x${nonce.toString('hex')}`)) throw new TsaError('the time-stamp does not carry our nonce, so it may be an old answer');
  // A service that gives a time far from ours is lying or broken, or our own clock is wrong: either way the time is not used.
  if (Math.abs(r.time.getTime() - at.getTime()) > TSA_CLOCK_MS)
    throw new TsaError(`the time it gives (${r.time.toISOString()}) is more than ${TSA_CLOCK_MS / 60_000} minutes from this server's clock, so one of the two clocks is wrong`);
  return { token, time: r.time, tsaName: r.tsaName, trusted: r.trusted };
}

/**
 * Asks each service in turn for a time-stamp over `signature`. Throws TsaError naming what each one did. `until`: when
 * the time for time-stamps ends, so several asked for one Finish (the record's chain head and the seal, finishPdf in
 * finalpipe.ts) share the same TSA_TOTAL_MS between them.
 */
export async function timeStamp(signature: Buffer, urls = tsaUrls(), until = Date.now() + TSA_TOTAL_MS): Promise<TimeStamp> {
  if (!urls.length) throw new TsaError('no time-stamp service is set');
  const imprint = crypto.createHash('sha256').update(signature).digest();
  const failures: string[] = [];
  const trust = trustCerts();
  const user = process.env.TSA_USER;
  for (const url of urls) {
    // Only the host is ever repeated: an address can carry a key in its path, and this ends up in the audit trail.
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return 'a service whose address cannot be read';
      }
    })();
    const rest = (resting.get(url) || 0) - Date.now();
    if (rest > 0) {
      failures.push(`${host}: not asked, because it did not answer a short while ago and is left alone for ${Math.ceil(rest / 60_000)} more minute${Math.ceil(rest / 60_000) === 1 ? '' : 's'}`);
      continue;
    }
    const left = until - Date.now();
    if (left < 500) {
      failures.push(`${host}: not asked, because the ${TSA_TOTAL_MS / 1000} seconds for time-stamps were used up`);
      continue;
    }
    // Another signer's request to this service is still out: this one ends when that one's time is up, so signers
    // who finish together wait together, and nobody waits longer than the first one does.
    const out = asking.get(url) || new Set<{ at: number }>();
    const first = out.size ? Math.min(...[...out].map((o) => o.at)) : 0;
    const shared = first ? first + TSA_TIMEOUT_MS - Date.now() : Infinity;
    if (shared < 250) {
      failures.push(`${host}: not asked, because a request sent to it ${Math.round((Date.now() - first) / 1000)} seconds ago has had no answer`);
      continue;
    }
    const wait = Math.min(TSA_TIMEOUT_MS, left, shared);
    const nonce = crypto.randomBytes(8);
    nonce[0] &= 0x7f;
    // The user name and password go out with the request, so never over a connection anyone on the way can read.
    if (user && !/^https:/i.test(url)) {
      failures.push(`${host}: not asked, because its address is plain http and the user name and password are only sent over https`);
      continue;
    }
    const sent = { at: Date.now() };
    out.add(sent);
    asking.set(url, out);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/timestamp-query',
          accept: 'application/timestamp-reply',
          ...(user ? { authorization: `Basic ${Buffer.from(`${user}:${process.env.TSA_PASSWORD || ''}`).toString('base64')}` } : {}),
        },
        body: new Uint8Array(timeStampRequest(imprint, nonce)),
        signal: AbortSignal.timeout(wait),
        redirect: 'error',
      });
      if (!res.ok) throw new TsaError(`it answered HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_ANSWER) throw new TsaError('its answer is far too large for a time-stamp');
      const r = checkAnswer(body, imprint, nonce, trust);
      return { ...r, url, host };
    } catch (e: any) {
      const together = wait === shared && shared < Math.min(TSA_TIMEOUT_MS, left);
      const why = e instanceof TsaError ? e.message
        : e?.name === 'TimeoutError' ? together ? `it did not answer, nor had it answered within ${TSA_TIMEOUT_MS / 1000} seconds a request sent to it moments earlier` : `it did not answer within ${Math.round(wait / 1000)} seconds`
        : `it could not be reached (${String(e?.cause?.code || e?.message || e).slice(0, 120)})`;
      failures.push(`${host}: ${why}`);
      if (!(e instanceof TsaError) && e?.name === 'TimeoutError') resting.set(url, Date.now() + TSA_REST_MS);
    } finally {
      out.delete(sent);
      if (!out.size) asking.delete(url);
    }
  }
  throw new TsaError(failures.join('; '));
}
