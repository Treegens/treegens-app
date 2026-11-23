// Long-term validation of the digital seal (PAdES B-LT and B-LTA, ETSI EN 319 142-1 clauses 5.4 and 5.5): after the
// seal (seal.ts) is applied with a time stamp, this asks each certificate's own addresses whether it was still good
// (OCSP, else the authority's revocation list), and adds the answers and the certificates to the file in a Document
// Security Store (the /DSS dictionary of ISO 32000-2 clause 12.8.4.3), as an incremental update. A PDF reader can then
// check the seal years later, after its certificate has expired, without asking anyone. When a time-stamp service is
// set, one document time stamp over the whole file follows (B-LTA at completion).
//
//   withLongTerm()  the step finishPdf (finalpipe.ts) runs after a seal at B-T; never throws, never holds the file back
//   ltvTail()       for /verify (checkSeal in seal.ts): whether what follows a seal in a file is only such an update
//
// Settings: LTV_WAIT_MS, how long the answers may take all together (default 20000), because the last signer's
// Finish waits for the stored file, which is the one that is emailed. When a certificate's service does not answer in
// time, or its answer does not check out, the file stays at B-T and the envelope page says so. Certificates that name
// no address at all (a certificate the operator made themselves, say) give nothing to fetch: then nothing is added.
// Left out on purpose: renewing the archive time stamp over the years, because it changes the file people hold.
import crypto from 'node:crypto';
import net from 'node:net';
import { specialAddress, resolver } from './paydns.ts';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, PDFNumber } from 'pdf-lib';
import { seq, integer, octets, algorithm, oid, tagged, read, kids, content, whole, readOid, readInt, readOctets, readTime, type Node } from './der.ts';
import { readCert, issued, selfSigned, type CertInfo } from './x509.ts';
import { parseSignedData, signerCert } from './sealcms.ts';
import { prepareSeal, coveredBytes, fillSeal, lastStartXref, lastSection } from './sealpdf.ts';
import { timeStamp, tsaUrls, checkToken, trustCerts, TsaError, TSA_TOTAL_MS, TSA_CLOCK_MS } from './tsa.ts';

export const LTV_WAIT_DEFAULT_MS = 20_000;
/** How long all the answers together may take: LTV_WAIT_MS, else 20 seconds; at most two minutes. 0 turns the step off. */
export function ltvWaitMs(): number {
  const v = process.env.LTV_WAIT_MS;
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 120_000) : LTV_WAIT_DEFAULT_MS;
}

const OID_AIA = '1.3.6.1.5.5.7.1.1';
const OID_CDP = '2.5.29.31';
const OID_OCSP = '1.3.6.1.5.5.7.48.1';
const OID_CA_ISSUERS = '1.3.6.1.5.5.7.48.2';
const OID_OCSP_BASIC = '1.3.6.1.5.5.7.48.1.1';
const OID_OCSP_NONCE = '1.3.6.1.5.5.7.48.1.2';
const OID_OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';
const OID_SHA1 = '1.3.14.3.2.26';
/** How far an answer's time may be ahead of this server's clock, and how old one without a next update may be. */
const CLOCK_MS = 5 * 60_000;
const OLDEST_MS = 7 * 864e5;
const MAX_OCSP = 256 * 1024;
const MAX_CRL = 8 * 1024 * 1024;
const MAX_CERT = 64 * 1024;

// ---- What a certificate says about itself ------------------------------------------------------

function extension(cert: CertInfo, id: string): Node | null {
  try {
    const t = kids(kids(read(cert.der))[0]);
    const exts = t.find((n) => n.tag === 0xa3);
    if (!exts) return null;
    for (const ext of kids(kids(exts)[0])) {
      const p = kids(ext);
      if (readOid(p[0]) === id) return read(readOctets(p[p.length - 1]));
    }
  } catch {
    /* a certificate whose extensions cannot be read names no address */
  }
  return null;
}

const web = (s: string) => /^https?:\/\/[^\s]+$/i.test(s);

/** The addresses a certificate names: its OCSP service, where its issuer's certificate is, its revocation lists. */
export function addressesOf(cert: CertInfo): { ocsp: string[]; caIssuers: string[]; crl: string[] } {
  const out = { ocsp: [] as string[], caIssuers: [] as string[], crl: [] as string[] };
  try {
    const aia = extension(cert, OID_AIA);
    if (aia) for (const ad of kids(aia)) {
      const [m, loc] = kids(ad);
      if (loc?.tag !== 0x86) continue;
      const url = content(loc).toString('latin1');
      if (!web(url)) continue;
      if (readOid(m) === OID_OCSP) out.ocsp.push(url);
      else if (readOid(m) === OID_CA_ISSUERS) out.caIssuers.push(url);
    }
    const cdp = extension(cert, OID_CDP);
    if (cdp) for (const dp of kids(cdp)) {
      const name = kids(dp).find((n) => n.tag === 0xa0);
      const full = name ? kids(name).find((n) => n.tag === 0xa0) : null;
      if (full) for (const g of kids(full)) if (g.tag === 0x86 && web(content(g).toString('latin1'))) out.crl.push(content(g).toString('latin1'));
    }
  } catch {
    /* what could be read is kept */
  }
  return out;
}

const named = (c: CertInfo) => `"${c.name}"`;
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'an address that cannot be read';
  }
};

// ---- Signatures on answers -----------------------------------------------------------------------

const SIG_HASH: Record<string, string> = {
  '1.2.840.113549.1.1.5': 'sha1', '1.2.840.113549.1.1.11': 'sha256', '1.2.840.113549.1.1.12': 'sha384', '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.10045.4.3.2': 'sha256', '1.2.840.10045.4.3.3': 'sha384', '1.2.840.10045.4.3.4': 'sha512',
};

function signedBy(alg: Node, data: Buffer, sig: Node, key: crypto.KeyObject): boolean {
  try {
    const o = readOid(kids(alg)[0]);
    const h = SIG_HASH[o];
    if (!h) return false;
    const value = content(sig).subarray(1);
    return crypto.verify(h, data, o.startsWith('1.2.840.10045.') ? { key, dsaEncoding: 'der' } : key, value);
  } catch {
    return false;
  }
}

/** The public key of a certificate as its BIT STRING bytes (for the OCSP issuer key hash, RFC 6960 section 4.1.1). */
function keyBits(c: CertInfo): Buffer {
  const spki = c.x509.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return content(kids(read(spki))[1]).subarray(1);
}

// ---- OCSP (RFC 6960) -------------------------------------------------------------------------------

/** The request for one certificate, with a nonce. SHA-1 in the CertID, as every responder understands it. */
export function ocspRequest(cert: CertInfo, issuer: CertInfo, nonce: Buffer): Buffer {
  const certId = seq(algorithm(OID_SHA1, null), octets(crypto.createHash('sha1').update(cert.issuerDer).digest()), octets(crypto.createHash('sha1').update(keyBits(issuer)).digest()), integer(cert.serialBytes));
  const ext = seq(seq(oid(OID_OCSP_NONCE), octets(octets(nonce))));
  return seq(seq(seq(seq(certId)), tagged(2, ext)));
}

/**
 * Checks an OCSP answer about `cert`: successful, signed by its issuer or by a responder certificate the issuer gave
 * for it, saying "good" for this very certificate, made now (not ahead of our clock, not out of date), with our nonce
 * when it carries one. Returns the responder's certificates to keep beside it; throws an Error saying why not.
 */
export function checkOcsp(answer: Buffer, cert: CertInfo, issuer: CertInfo, nonce: Buffer | null, at = new Date()): CertInfo[] {
  let top: Node[];
  try {
    top = kids(read(answer));
  } catch {
    throw new Error('its answer is not an OCSP answer');
  }
  const status = Number(readInt(Object.assign({}, top[0], { tag: 0x02 })));
  if (status !== 0) throw new Error(`it refused (OCSP status ${status})`);
  const bytes = top[1] && top[1].tag === 0xa0 ? kids(kids(top[1])[0]) : null;
  if (!bytes || readOid(bytes[0]) !== OID_OCSP_BASIC) throw new Error('its answer is of a kind this server does not read');
  const basic = kids(read(readOctets(bytes[1])));
  const [tbs, alg, sig] = basic;
  const certs = basic[3] && basic[3].tag === 0xa0 ? kids(kids(basic[3])[0]).map((n) => readCert(whole(n))) : [];
  const t = kids(tbs);
  let i = t[0].tag === 0xa0 ? 1 : 0;
  i++; // responder id: the signature below decides who signed
  i++; // producedAt
  const responses = kids(t[i++]);
  const exts = t[i] && t[i].tag === 0xa1 ? kids(kids(t[i])[0]) : [];
  // Who signed it: the issuer itself, or a certificate the issuer made for answering about its certificates.
  const data = Buffer.from(whole(tbs));
  let signer: CertInfo | null = signedBy(alg, data, sig, issuer.x509.publicKey) ? issuer : null;
  if (!signer) for (const c of certs) {
    if (!issued(issuer, c) || !c.extKeyUsage?.includes(OID_OCSP_SIGNING) || at < c.notBefore || at > c.notAfter) continue;
    if (signedBy(alg, data, sig, c.x509.publicKey)) signer = c;
  }
  if (!signer) throw new Error('its answer is not signed by the authority that issued the certificate, nor by a responder that authority named');
  for (const e of exts) {
    const p = kids(e);
    if (readOid(p[0]) !== OID_OCSP_NONCE || !nonce) continue;
    const v = readOctets(p[p.length - 1]);
    let n: Buffer = v;
    try {
      n = readOctets(read(v));
    } catch {
      /* some responders put the nonce in without the inner octet string */
    }
    if (!n.equals(nonce)) throw new Error('its answer carries another nonce, so it may be an old answer');
  }
  const nameHash = crypto.createHash('sha1').update(cert.issuerDer).digest();
  const keyHash = crypto.createHash('sha1').update(keyBits(issuer)).digest();
  for (const r of responses) {
    const k = kids(r);
    const id = kids(k[0]);
    if (readOid(kids(id[0])[0]) !== OID_SHA1) continue;
    if (!readOctets(id[1]).equals(nameHash) || !readOctets(id[2]).equals(keyHash) || readInt(id[3]) !== cert.serial) continue;
    const s = k[1];
    const thisUpdate = readTime(k[2]);
    const next = k[3] && k[3].tag === 0xa0 ? readTime(kids(k[3])[0]) : null;
    if (s.tag === 0xa1) throw new Error(`it says the certificate ${named(cert)} was revoked`);
    if (s.tag !== 0x80) throw new Error(`it does not know the certificate ${named(cert)}`);
    if (thisUpdate.getTime() > at.getTime() + CLOCK_MS) throw new Error('its answer is dated in the future, so one of the two clocks is wrong');
    if (next ? next.getTime() < at.getTime() - CLOCK_MS : thisUpdate.getTime() < at.getTime() - OLDEST_MS) throw new Error('its answer is out of date');
    return signer === issuer ? [] : [signer];
  }
  throw new Error(`its answer is not about the certificate ${named(cert)}`);
}

// ---- Revocation lists (RFC 5280 section 5) ---------------------------------------------------------------

/** Checks a revocation list for `cert`: signed by its issuer, current, and not listing it. Throws saying why not. */
export function checkCrl(crl: Buffer, cert: CertInfo, issuer: CertInfo, at = new Date()) {
  let parts: Node[];
  try {
    parts = kids(read(crl));
  } catch {
    throw new Error('it is not a revocation list');
  }
  const [tbs, alg, sig] = parts;
  if (!signedBy(alg, Buffer.from(whole(tbs)), sig, issuer.x509.publicKey)) throw new Error('the revocation list is not signed by the authority that issued the certificate');
  const t = kids(tbs);
  let i = t[0].tag === 0x02 ? 1 : 0;
  i++; // signature algorithm
  if (!Buffer.from(whole(t[i++])).equals(cert.issuerDer)) throw new Error('the revocation list is of another authority');
  const thisUpdate = readTime(t[i++]);
  const next = t[i] && (t[i].tag === 0x17 || t[i].tag === 0x18) ? readTime(t[i++]) : null;
  if (thisUpdate.getTime() > at.getTime() + CLOCK_MS) throw new Error('the revocation list is dated in the future, so one of the two clocks is wrong');
  if (next ? next.getTime() < at.getTime() - CLOCK_MS : thisUpdate.getTime() < at.getTime() - OLDEST_MS) throw new Error('the revocation list is out of date');
  if (t[i] && t[i].tag === 0x30) for (const r of kids(t[i])) if (readInt(kids(r)[0]) === cert.serial) throw new Error(`the revocation list says the certificate ${named(cert)} was revoked`);
}

// ---- Fetching ---------------------------------------------------------------------------------------------

// The addresses come from certificates (the operator's own, and the chain a time-stamp service sends), never from a
// person using the app. Still, an address on this machine or its private network is never asked, and no redirect is
// followed to one: a certificate is no reason to reach inside.
// A name with a dot at its end ("localhost.") is the same name, so the dots go before it is compared.
function inside(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
    return !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || (net.isIP(h) > 0 && specialAddress(h));
  } catch {
    return true;
  }
}

// A public-looking name can still lead inside: it is asked of the DNS first (the same lookup as payment links,
// src/server/paydns.ts), and refused when any address it gives is private or special. A lookup that fails says
// nothing either way: fetch then fails on its own, or is refused by the outside-connections guard.
async function leadsInside(url: string, until: number): Promise<boolean> {
  if (inside(url)) return true;
  const h = new URL(url).hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (net.isIP(h)) return false;
  let timer: any;
  try {
    const answers = await Promise.race([resolver.lookup(h), new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error('timeout')), Math.max(0, until - Date.now()))))]);
    return answers.some((a) => specialAddress(a.address));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBytes(url: string, init: RequestInit, until: number, max: number, hops = 0): Promise<Buffer> {
  const left = until - Date.now();
  if (left < 50) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  if (await leadsInside(url, until)) throw new Error('it is an address on this machine or a private network, which is not asked');
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(left), redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location');
    if (!to || hops >= 3 || !web(new URL(to, url).href) || (await leadsInside(new URL(to, url).href, until))) throw new Error(`it sent us on to ${to && hops < 3 ? 'an address that is not asked' : 'nowhere we follow'}`);
    return fetchBytes(new URL(to, url).href, init, until, max, hops + 1);
  }
  if (!res.ok) throw new Error(`it answered HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') || 0) > max) throw new Error('its answer is far too large');
  // Read with a limit, so an answer that never ends cannot fill the memory.
  const parts: Buffer[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error('its answer is far too large');
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

// With OUTSIDE_CALLS set to listed or none (src/server/outside.ts), these hosts come from certificates and are not on
// any list the server builds: the operator has to add them to OUTBOUND_ALLOW, and the note says so.
const said = (e: any, url: string, wait: number) => `${hostOf(url)}: ${e?.name === 'OutsideRefused' ? `this server is set to connect only to listed hosts, and this one is not listed (add ${hostOf(url).replace(/:\d+$/, '')} to OUTBOUND_ALLOW to allow it)` : e?.name === 'TimeoutError' ? `it did not answer within ${Math.round(wait / 100) / 10} seconds` : e?.message?.startsWith('it') ? e.message : `it could not be reached (${String(e?.cause?.code || e?.message || e).slice(0, 120)})`}`;

type Proof = { ocsp?: Buffer; crl?: Buffer; certs: CertInfo[] };

/** OCSP first, at each address the certificate names; then each revocation list. Throws with what each one did. */
async function proofFor(cert: CertInfo, issuer: CertInfo, a: ReturnType<typeof addressesOf>, until: number, wait: number): Promise<Proof> {
  const failures: string[] = [];
  for (const url of a.ocsp) {
    const nonce = crypto.randomBytes(16);
    try {
      const body = await fetchBytes(url, { method: 'POST', headers: { 'content-type': 'application/ocsp-request', accept: 'application/ocsp-response' }, body: new Uint8Array(ocspRequest(cert, issuer, nonce)) }, until, MAX_OCSP);
      return { ocsp: body, certs: checkOcsp(body, cert, issuer, nonce) };
    } catch (e) {
      failures.push(said(e, url, wait));
    }
  }
  for (const url of a.crl) {
    try {
      const body = await fetchBytes(url, { method: 'GET' }, until, MAX_CRL);
      checkCrl(body, cert, issuer);
      return { crl: body, certs: [] };
    } catch (e) {
      failures.push(said(e, url, wait));
    }
  }
  throw new Error(`for the certificate ${named(cert)}, ${failures.join('; ')}`);
}

function readAnyCert(body: Buffer): CertInfo | null {
  try {
    const m = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(body.toString('latin1'));
    return readCert(m ? Buffer.from(m[1].replace(/\s+/g, ''), 'base64') : body);
  } catch {
    return null;
  }
}

export type Gathered = { certs: CertInfo[]; ocsps: Buffer[]; crls: Buffer[] };

/**
 * Asks for proof that every certificate in `chains` (each one starting with the certificate that signed) was good
 * now. Null when no certificate in them names an address: nothing to fetch. Throws an Error naming what is missing.
 * The first chain is the seal's: each of its certificates must be checked. In the others (the time-stamp service's),
 * a certificate that names no place to check it, or whose issuer is not there, is left as it is: nobody could check
 * it, and it is no reason to leave the seal's own certificates unchecked. One whose service fails still counts.
 */
export async function gather(chains: CertInfo[][], wait = ltvWaitMs(), until = Date.now() + wait): Promise<Gathered | null> {
  const pool: CertInfo[] = [];
  const add = (c: CertInfo) => (pool.some((p) => p.der.equals(c.der)) ? null : pool.push(c));
  for (const ch of chains) ch.forEach(add);
  const any = pool.some((c) => !selfSigned(c) && Object.values(addressesOf(c)).some((l) => l.length));
  if (!any) return null;
  const out: Gathered = { certs: [], ocsps: [], crls: [] };
  const missing: string[] = [];
  const seen = new Set<string>();
  // Each chain is walked from the certificate that signed up to one that signs itself; issuers are fetched when the
  // chain does not carry them and the certificate says where they are.
  const jobs: Promise<void>[] = [];
  for (const [ci, ch] of chains.entries()) {
    const firm = ci === 0;
    let at: CertInfo | undefined = ch[0];
    for (let hops = 0; at && hops < 8; hops++) {
      const c: CertInfo = at;
      const key = c.der.toString('base64');
      if (seen.has(key)) break;
      seen.add(key);
      add(c);
      if (selfSigned(c)) break;
      const a = addressesOf(c);
      let issuer = pool.find((p) => p !== c && issued(p, c));
      if (!issuer) for (const url of a.caIssuers) {
        try {
          const got = readAnyCert(await fetchBytes(url, { method: 'GET' }, until, MAX_CERT));
          if (got && issued(got, c)) (issuer = got), add(got);
          if (issuer) break;
        } catch {
          /* said below, as a missing issuer */
        }
      }
      if (!issuer) {
        if (firm) missing.push(`the certificate that issued ${named(c)} is not in the chain`);
        break;
      }
      if (!a.ocsp.length && !a.crl.length) {
        if (firm) missing.push(`the certificate ${named(c)} names no place to check it`);
      }
      else jobs.push(proofFor(c, issuer, a, until, wait).then((p) => {
        if (p.ocsp) out.ocsps.push(p.ocsp);
        if (p.crl && !out.crls.some((x) => x.equals(p.crl!))) out.crls.push(p.crl);
        p.certs.forEach(add);
      }, (e) => void missing.push(String(e?.message || e))));
      at = issuer;
    }
  }
  await Promise.all(jobs);
  if (missing.length) throw new Error(missing.join('; '));
  out.certs = pool;
  return out;
}

// ---- Writing the Document Security Store --------------------------------------------------------------------

/** Appends a /DSS with these certificates and answers to `pdf` as an incremental update; nothing before it changes. */
export async function writeDss(pdf: Uint8Array, g: Gathered): Promise<Buffer> {
  const prefix = Buffer.from(pdf);
  const doc = await PDFDocument.load(prefix, { updateMetadata: false });
  const prevXref = lastStartXref(prefix);
  const prev = lastSection(prefix, prevXref);
  const trailer = doc.context.trailerInfo;
  const root = trailer.Root as PDFRef;
  let next = Math.max(prev.size, doc.context.largestObjectNumber + 1);
  const parts: Buffer[] = [prefix];
  let length = prefix.length;
  const addBytes = (b: Buffer) => (parts.push(b), (length += b.length));
  const addText = (s: string) => addBytes(Buffer.from(s, 'latin1'));
  if (prefix[prefix.length - 1] !== 0x0a && prefix[prefix.length - 1] !== 0x0d) addText('\n');
  const offsets = new Map<number, number>();
  const stream = (data: Buffer) => {
    const n = next++;
    offsets.set(n, length);
    addText(`${n} 0 obj\n<<\n/Length ${data.length}\n>>\nstream\n`);
    addBytes(data);
    addText('\nendstream\nendobj\n');
    return `${n} 0 R`;
  };
  const certs = g.certs.map((c) => stream(c.der));
  const ocsps = g.ocsps.map(stream);
  const crls = g.crls.map(stream);
  const dssNum = next++;
  offsets.set(dssNum, length);
  addText(`${dssNum} 0 obj\n<<\n/Type /DSS\n${certs.length ? `/Certs [${certs.join(' ')}]\n` : ''}${ocsps.length ? `/OCSPs [${ocsps.join(' ')}]\n` : ''}${crls.length ? `/CRLs [${crls.join(' ')}]\n` : ''}>>\nendobj\n`);
  const catalog = doc.catalog.clone() as PDFDict;
  catalog.set(PDFName.of('DSS'), PDFRef.of(dssNum, 0));
  offsets.set(root.objectNumber, length);
  addText(`${root.objectNumber} 0 obj\n${catalog.toString()}\nendobj\n`);
  const id = trailer.ID instanceof PDFArray ? `/ID [${trailer.ID.asArray().map((x) => x.toString()).join(' ')}]\n` : '';
  const info = trailer.Info instanceof PDFRef ? `/Info ${trailer.Info.toString()}\n` : '';
  const nums = (extra?: number) => [...offsets.keys(), ...(extra ? [extra] : [])].sort((a, b) => a - b);
  const runs = (list: number[]) => {
    const out: [number, number[]][] = [];
    for (let i = 0; i < list.length; ) {
      let j = i;
      while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
      out.push([list[i], list.slice(i, j + 1)]);
      i = j + 1;
    }
    return out;
  };
  if (prev.stream) {
    const xrefNum = next++;
    offsets.set(xrefNum, length);
    const index: number[] = [];
    const rows: Buffer[] = [];
    for (const [first, list] of runs(nums())) {
      index.push(first, list.length);
      for (const n of list) {
        const row = Buffer.alloc(7);
        row[0] = 1;
        row.writeUInt32BE(offsets.get(n)!, 1);
        rows.push(row);
      }
    }
    const data = Buffer.concat(rows);
    addText(`${xrefNum} 0 obj\n<<\n/Type /XRef\n/Size ${next}\n/Index [${index.join(' ')}]\n/W [1 4 2]\n/Root ${root.toString()}\n${info}${id}/Prev ${prevXref}\n/Length ${data.length}\n>>\nstream\n`);
    addBytes(data);
    addText(`\nendstream\nendobj\nstartxref\n${offsets.get(xrefNum)}\n%%EOF\n`);
  } else {
    const xrefAt = length;
    let table = 'xref\n';
    for (const [first, list] of runs(nums())) {
      table += `${first} ${list.length}\n`;
      for (const n of list) table += `${String(offsets.get(n)).padStart(10, '0')} 00000 n\r\n`;
    }
    addText(`${table}trailer\n<<\n/Size ${next}\n/Root ${root.toString()}\n${info}${id}/Prev ${prevXref}\n>>\nstartxref\n${xrefAt}\n%%EOF\n`);
  }
  return Buffer.concat(parts);
}

/** One document time stamp over the whole file (ETSI EN 319 142-1 clause 5.5): a second, invisible field. */
export async function addDocTimeStamp(pdf: Buffer, urls = tsaUrls(), until = Date.now() + TSA_TOTAL_MS): Promise<{ bytes: Buffer; host: string; time: string; tsaName: string; trusted: boolean }> {
  const prepared = await prepareSeal(pdf, new Date(), undefined, 'timestamp');
  const covered = coveredBytes(prepared.bytes, prepared.byteRange);
  // timeStamp asks for a time stamp over the SHA-256 of what it is given: here, every byte the time stamp covers.
  // It shares LTV_WAIT_MS with the answers before it, and never gets more than the 4 seconds of any time stamp.
  if (until - Date.now() < 500) throw new TsaError('it was not asked, because the time for long-term checking (LTV_WAIT_MS) was used up');
  const st = await timeStamp(covered, urls, Math.min(until, Date.now() + TSA_TOTAL_MS));
  return { bytes: fillSeal(prepared, st.token), host: st.host, time: st.time.toISOString(), tsaName: st.tsaName, trusted: st.trusted };
}

// ---- The step after the seal ---------------------------------------------------------------------------------

export type LongTerm = { level: 'B-LT' | 'B-LTA'; docTsHost?: string; docTsTime?: string; docTsFailed?: string } | { missing: string };

/** The certificates in a time-stamp token, the one that signed it first. */
export function tokenChain(token: Buffer): CertInfo[] {
  try {
    const sd = parseSignedData(token);
    const certs = sd.certificates.map((d) => readCert(d));
    const found = sd.signers[0] ? signerCert(sd, sd.signers[0]) : null;
    const signer = (found && certs.find((c) => c.der.equals(found.der))) || certs[0];
    return signer ? [signer, ...certs.filter((c) => c !== signer)] : certs;
  } catch {
    return [];
  }
}

/**
 * After a seal at B-T: the file with its validation data (B-LT) and, with a time-stamp service, the document time
 * stamp (B-LTA). With nothing to fetch, the file as it was and no note. When proof is missing, the file as it was
 * and why. Never throws.
 */
export async function withLongTerm(sealed: Buffer, sealChain: CertInfo[], tsaToken: Buffer | null): Promise<{ bytes: Buffer; ltv: LongTerm | null }> {
  // LTV_WAIT_MS=0: the step is off, and nothing is asked.
  const wait = ltvWaitMs();
  if (wait === 0) return { bytes: sealed, ltv: null };
  const until = Date.now() + wait;
  let g: Gathered | null;
  try {
    g = await gather([sealChain, ...(tsaToken ? [tokenChain(tsaToken)] : [])], wait, until);
  } catch (e: any) {
    return { bytes: sealed, ltv: { missing: String(e?.message || e).slice(0, 600) } };
  }
  if (!g) return { bytes: sealed, ltv: null };
  let lt: Buffer;
  try {
    lt = await writeDss(sealed, g);
  } catch (e: any) {
    return { bytes: sealed, ltv: { missing: `the check data could not be written into the file (${String(e?.message || e).slice(0, 200)})` } };
  }
  if (!tsaUrls().length) return { bytes: lt, ltv: { level: 'B-LT' } };
  try {
    const d = await addDocTimeStamp(lt, tsaUrls(), until);
    return { bytes: d.bytes, ltv: { level: 'B-LTA', docTsHost: d.host, docTsTime: d.time } };
  } catch (e: any) {
    return { bytes: lt, ltv: { level: 'B-LT', docTsFailed: e instanceof TsaError ? e.message : String(e?.message || e).slice(0, 300) } };
  }
}

// ---- Checking what follows a seal (/verify) ---------------------------------------------------------------------
//
// A seal that does not cover the whole file is normally reported as such: something was saved after it. The one
// exception is what withLongTerm adds, and only when every object after the seal is one of these, checked one by one:
//   - the catalog again, the same in every entry but /DSS (and /AcroForm, checked below);
//   - the /DSS and streams it lists, each one read for what it says it is: a certificate, an OCSP answer or a
//     revocation list, with no other entry in its dictionary (so no filter, nothing a reader shows on a page);
//   - and that data must be about this seal: its certificate and each certificate above it to one that signs itself,
//     each with an OCSP answer or a revocation list in the /DSS that checks out for the time of the seal. An empty
//     /DSS, or one about someone else's certificates, is not check data for this seal;
//   - for a document time stamp: one new invisible field whose value is a /DocTimeStamp, with exactly the entries
//     withLongTerm writes and no other (no action, no appearance), the form's /Fields and the page's /Annots again
//     with only that field added; the time stamp must cover the whole file and be over it. Its time and service are
//     given only when its certificate leads to one in TSA_TRUST; otherwise it is said to be unchecked;
//   - the cross-reference sections, each pointing back at the one before, with no object freed.
// Anything else (a changed page, a new annotation, a free entry, compressed objects) and the tail is not accepted.

type Entry = { num: number; at: number };

function sections(bytes: Buffer, from: number, sealXref: number): { entries: Entry[]; xrefs: Set<number> } | null {
  const text = bytes.toString('latin1');
  const tail = text.slice(from);
  const ends = [...tail.matchAll(/startxref\s+(\d+)\s+%%EOF\s*/g)];
  if (!ends.length || ends.length > 3) return null;
  if (from + ends[ends.length - 1].index! + ends[ends.length - 1][0].length !== bytes.length) return null;
  const entries: Entry[] = [];
  const xrefs = new Set<number>();
  let prev = sealXref;
  for (const m of ends) {
    const x = Number(m[1]);
    if (x < from || x >= bytes.length) return null;
    if (/^xref\b/.test(text.slice(x, x + 4))) {
      const tr = text.indexOf('trailer', x);
      if (tr < 0) return null;
      const body = text.slice(x + 4, tr);
      const rows = body.trim().split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
      for (let i = 0; i < rows.length; ) {
        const h = /^(\d+) (\d+)$/.exec(rows[i++]);
        if (!h) return null;
        for (let k = 0; k < Number(h[2]); k++) {
          const r = /^(\d{10}) (\d{5}) ([nf])$/.exec(rows[i++] || '');
          if (!r || r[3] !== 'n' || r[2] !== '00000') return null;
          entries.push({ num: Number(h[1]) + k, at: Number(r[1]) });
        }
      }
      const dict = text.slice(tr, text.indexOf('startxref', tr));
      if (Number(/\/Prev\s+(\d+)/.exec(dict)?.[1]) !== prev || /\/Encrypt\b/.test(dict)) return null;
    } else {
      const head = /^(\d+) 0 obj\s*<<([\s\S]*?)>>\s*stream\r?\n/.exec(text.slice(x, x + 4096));
      if (!head || !/\/Type\s*\/XRef\b/.test(head[2]) || /\/Filter\b|\/Encrypt\b/.test(head[2]) || !/\/W\s*\[\s*1\s+4\s+2\s*\]/.test(head[2])) return null;
      if (Number(/\/Prev\s+(\d+)/.exec(head[2])?.[1]) !== prev) return null;
      xrefs.add(Number(head[1]));
      const len = Number(/\/Length\s+(\d+)/.exec(head[2])?.[1]);
      const index = (/\/Index\s*\[([\d\s]+)\]/.exec(head[2])?.[1] || '').trim().split(/\s+/).map(Number);
      if (!len || index.length % 2) return null;
      const data = bytes.subarray(x + head[0].length, x + head[0].length + len);
      let row = 0;
      for (let k = 0; k < index.length; k += 2) for (let j = 0; j < index[k + 1]; j++, row++) {
        if (row * 7 + 7 > data.length || data[row * 7] !== 1 || data.readUInt16BE(row * 7 + 5) !== 0) return null;
        entries.push({ num: index[k] + j, at: data.readUInt32BE(row * 7 + 1) });
      }
      if (row * 7 !== data.length) return null;
    }
    prev = x;
  }
  for (const e of entries) if (e.at < from || !text.startsWith(`${e.num} 0 obj`, e.at)) return null;
  // Every object written after the seal is one the cross-references name, so a reader and this check see the same.
  const listed = new Set(entries.map((e) => e.at));
  for (const m of tail.matchAll(/(^|[\r\n])(\d+) (\d+) obj\b/g)) if (!listed.has(from + m.index! + m[1].length)) return null;
  return { entries, xrefs };
}

const same = (a: any, b: any) => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.toString() === b.toString());

function sameExcept(before: PDFDict, after: PDFDict, skip: string[]): boolean {
  const keys = new Set([...before.keys(), ...after.keys()].map((k) => k.toString()));
  for (const k of keys) {
    if (skip.includes(k)) continue;
    if (!same(before.get(PDFName.of(k.slice(1))), after.get(PDFName.of(k.slice(1))))) return false;
  }
  return true;
}

/** The refs `after` adds at the end of `before`'s array, or null when anything else changed. */
function addedAtEnd(before: PDFArray | undefined, after: PDFArray | undefined): PDFRef[] | null {
  const b = before ? before.asArray() : [];
  const a = after ? after.asArray() : [];
  if (a.length < b.length || b.some((x, i) => !same(x, a[i]))) return null;
  const extra = a.slice(b.length);
  return extra.every((x) => x instanceof PDFRef) ? (extra as PDFRef[]) : null;
}

export type Tail = { level: 'B-LT' | 'B-LTA'; doc_timestamp_at: string | null; doc_timestamp_by: string | null; doc_timestamp_unchecked: boolean };

const onlyKeys = (d: PDFDict, keys: string[]) => d.keys().every((k) => keys.includes(k.toString()));

// What one stream in the /DSS holds: exactly one DER object of the kind its array says, nothing before or after it.
function dssItem(kind: string, data: Buffer): CertInfo | Buffer | null {
  try {
    if (read(data).end !== data.length) return null;
    if (kind === '/Certs') return readCert(data);
    const top = kids(read(data));
    if (kind === '/OCSPs') {
      if (Number(readInt(Object.assign({}, top[0], { tag: 0x02 }))) !== 0 || top[1]?.tag !== 0xa0 || readOid(kids(kids(top[1])[0])[0]) !== OID_OCSP_BASIC) return null;
      return data;
    }
    if (kind === '/CRLs') return top.length === 3 && top[0].tag === 0x30 ? data : null;
  } catch {
    /* not what it says it is */
  }
  return null;
}

// The seal's own certificate, the certificates its signature carries, and its time (/M), from the sealed part.
function sealOf(sealedPart: Buffer): { signer: CertInfo; certs: CertInfo[]; at: Date } | null {
  const text = sealedPart.toString('latin1');
  const m = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)].reverse().find((x) => Number(x[3]) + Number(x[4]) === sealedPart.length);
  if (!m) return null;
  const [b, c] = [Number(m[2]), Number(m[3])];
  const der = Buffer.from(text.slice(b + 1, c - 1), 'hex');
  const sd = parseSignedData(der.subarray(0, read(der).end));
  const certs = sd.certificates.map((d) => readCert(d));
  const found = sd.signers[0] ? signerCert(sd, sd.signers[0]) : null;
  const signer = found && certs.find((x) => x.der.equals(found.der));
  const when = /\/M\s*\(D:(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(text.slice(Math.max(0, m.index! - 4096), Math.min(text.length, c + 4096)));
  if (!signer || !when) return null;
  return { signer, certs, at: new Date(`${when[1]}-${when[2]}-${when[3]}T${when[4]}:${when[5]}:${when[6]}Z`) };
}

// Whether the /DSS checks the seal's whole chain: each certificate up to one that signs itself has an answer or a
// revocation list in it that checks out for the time of the seal.
function coversSeal(seal: NonNullable<ReturnType<typeof sealOf>>, certs: CertInfo[], ocsps: Buffer[], crls: Buffer[]): boolean {
  if (!certs.some((x) => x.der.equals(seal.signer.der))) return false;
  const pool = [...certs, ...seal.certs];
  let c = seal.signer;
  for (let hops = 0; hops < 8; hops++) {
    if (selfSigned(c)) return true;
    const issuer = pool.find((p) => !p.der.equals(c.der) && issued(p, c));
    if (!issuer) return false;
    const cc = c;
    const ok = ocsps.some((o) => { try { checkOcsp(o, cc, issuer, null, seal.at); return true; } catch { return false; } })
      || crls.some((l) => { try { checkCrl(l, cc, issuer, seal.at); return true; } catch { return false; } });
    if (!ok) return false;
    c = issuer;
  }
  return false;
}

/**
 * Whether everything after `sealEnd` in `bytes` is the validation data and document time stamp withLongTerm adds,
 * and nothing else. Null when it is not, or cannot be shown to be.
 */
export async function ltvTail(input: Uint8Array, sealEnd: number): Promise<Tail | null> {
  try {
    const bytes = Buffer.from(input);
    const sealedPart = bytes.subarray(0, sealEnd);
    const found = sections(bytes, sealEnd, lastStartXref(sealedPart));
    if (!found) return null;
    const { entries, xrefs } = found;
    const before = await PDFDocument.load(sealedPart, { updateMetadata: false });
    const after = await PDFDocument.load(bytes, { updateMetadata: false });
    const root = after.context.trailerInfo.Root;
    if (!(root instanceof PDFRef) || !same(root, before.context.trailerInfo.Root)) return null;
    const look = (d: PDFDocument, n: number) => d.context.lookup(PDFRef.of(n, 0));
    // What the new catalog may add: a /DSS whose arrays list streams.
    const cat = after.catalog;
    const dssValue = cat.get(PDFName.of('DSS'));
    const dss = dssValue instanceof PDFRef ? after.context.lookup(dssValue) : dssValue;
    if (!(dss instanceof PDFDict)) return null;
    const allowed = new Set<number>();
    if (dssValue instanceof PDFRef) allowed.add(dssValue.objectNumber);
    const got = { certs: [] as CertInfo[], ocsps: [] as Buffer[], crls: [] as Buffer[] };
    for (const k of dss.keys()) {
      const key = k.toString();
      if (key === '/Type') {
        if (dss.get(k) !== PDFName.of('DSS')) return null;
        continue;
      }
      if (!['/Certs', '/OCSPs', '/CRLs'].includes(key)) return null;
      const arr = dss.lookup(k);
      if (!(arr instanceof PDFArray)) return null;
      for (const x of arr.asArray()) {
        const st = x instanceof PDFRef ? after.context.lookup(x) : null;
        if (!(x instanceof PDFRef) || !(st instanceof PDFRawStream) || !onlyKeys(st.dict, ['/Length'])) return null;
        const item = dssItem(key, Buffer.from(st.contents));
        if (!item) return null;
        if (key === '/Certs') got.certs.push(item as CertInfo);
        else (key === '/OCSPs' ? got.ocsps : got.crls).push(item as Buffer);
        allowed.add(x.objectNumber);
      }
    }
    const sealInfo = sealOf(sealedPart);
    if (!sealInfo || !coversSeal(sealInfo, got.certs, got.ocsps, got.crls)) return null;
    // A document time stamp field: new, invisible, its value a /DocTimeStamp.
    const stampFields = new Set<number>();
    const isStampField = (r: PDFRef) => {
      if (look(before, r.objectNumber)) return false;
      const w = after.context.lookup(r);
      if (!(w instanceof PDFDict) || w.get(PDFName.of('FT')) !== PDFName.of('Sig') || w.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) return false;
      // Exactly what prepareSeal writes for a time stamp: no action, no appearance, nothing a reader would run or show.
      if (!onlyKeys(w, ['/Type', '/Subtype', '/FT', '/T', '/F', '/Rect', '/P', '/V']) || (w.has(PDFName.of('Type')) && w.get(PDFName.of('Type')) !== PDFName.of('Annot'))) return false;
      const rect = w.lookup(PDFName.of('Rect'));
      if (!(rect instanceof PDFArray) || rect.asArray().some((n) => !(n instanceof PDFNumber) || n.asNumber() !== 0)) return false;
      const v = w.get(PDFName.of('V'));
      const sig = v instanceof PDFRef ? after.context.lookup(v) : null;
      if (!(sig instanceof PDFDict) || sig.get(PDFName.of('Type')) !== PDFName.of('DocTimeStamp') || sig.get(PDFName.of('SubFilter')) !== PDFName.of('ETSI.RFC3161')) return false;
      if (!onlyKeys(sig, ['/Type', '/Filter', '/SubFilter', '/ByteRange', '/Contents']) || sig.get(PDFName.of('Filter')) !== PDFName.of('Adobe.PPKLite')) return false;
      stampFields.add(r.objectNumber);
      allowed.add(r.objectNumber);
      allowed.add((v as PDFRef).objectNumber);
      return true;
    };
    const formOf = (d: PDFDocument) => {
      const f = d.catalog.get(PDFName.of('AcroForm'));
      return { ref: f instanceof PDFRef ? f : null, dict: (f instanceof PDFRef ? d.context.lookup(f) : f) as PDFDict | undefined };
    };
    const fb = formOf(before), fa = formOf(after);
    const formOk = () => {
      if (!(fb.dict instanceof PDFDict) || !(fa.dict instanceof PDFDict) || !sameExcept(fb.dict, fa.dict, ['/Fields'])) return false;
      const extra = addedAtEnd(fb.dict.lookup(PDFName.of('Fields')) as PDFArray, fa.dict.lookup(PDFName.of('Fields')) as PDFArray);
      return !!extra && extra.every(isStampField);
    };
    // First the objects that were there before (the catalog, the form, a page): they say which new fields are
    // allowed. Then every new object must be one of those, or the /DSS and what it lists.
    const fresh: number[] = [];
    for (const num of new Set(entries.map((e) => e.num))) {
      const now = look(after, num);
      const was = look(before, num);
      // A cross-reference stream (pdf-lib does not keep those as objects): checked by sections() above.
      if (xrefs.has(num) && !was) continue;
      if (!was) {
        fresh.push(num);
        continue;
      }
      if (num === root.objectNumber) {
        if (!(was instanceof PDFDict) || !(now instanceof PDFDict) || !sameExcept(was, now, ['/DSS', '/AcroForm'])) return null;
        if (fb.ref || fa.ref ? !same(fb.ref, fa.ref) : !same(fb.dict, fa.dict) && !formOk()) return null;
        continue;
      }
      if (fa.ref && num === fa.ref.objectNumber && same(fa.ref, fb.ref)) {
        if (!formOk()) return null;
        continue;
      }
      if (was instanceof PDFDict && now instanceof PDFDict && was.get(PDFName.of('Type')) === PDFName.of('Page')) {
        if (!sameExcept(was, now, ['/Annots'])) return null;
        const extra = addedAtEnd(was.lookup(PDFName.of('Annots')) as PDFArray, now.lookup(PDFName.of('Annots')) as PDFArray);
        if (!extra || !extra.every(isStampField)) return null;
        continue;
      }
      return null;
    }
    for (const num of fresh) if (!allowed.has(num)) return null;
    if (stampFields.size > 1) return null;
    let at: string | null = null, by: string | null = null, unchecked = false;
    if (stampFields.size) {
      const w = after.context.lookup(PDFRef.of([...stampFields][0], 0)) as PDFDict;
      const sig = after.context.lookup(w.get(PDFName.of('V')) as PDFRef) as PDFDict;
      const br = sig.lookup(PDFName.of('ByteRange'));
      if (!(br instanceof PDFArray) || br.size() !== 4) return null;
      const r = br.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : -1)) as [number, number, number, number];
      if (r[0] !== 0 || r[2] + r[3] !== bytes.length || bytes[r[1]] !== 0x3c || bytes[r[2] - 1] !== 0x3e) return null;
      const hex = bytes.subarray(r[1] + 1, r[2] - 1).toString('latin1');
      if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
      const der = Buffer.from(hex, 'hex');
      const end = read(der).end;
      if (der.subarray(end).some((b) => b !== 0)) return null;
      const covered = coveredBytes(bytes, r);
      const over = (h: string) => crypto.createHash(h).update(covered).digest();
      // It must hold over these bytes whoever made it (it throws otherwise), and be no earlier than the seal.
      const t = checkToken(der.subarray(0, end), over, null);
      if (t.time.getTime() < sealInfo.at.getTime() - TSA_CLOCK_MS) return null;
      let trust: CertInfo[] | null = null;
      try {
        trust = trustCerts();
      } catch {
        trust = null;
      }
      let trusted = false;
      if (trust) {
        try {
          trusted = checkToken(der.subarray(0, end), over, trust).trusted;
        } catch {
          trusted = false;
        }
      }
      // Anyone can make a time-stamp service of their own: its name and time are given only when it leads to TSA_TRUST.
      if (trusted) (at = t.time.toISOString()), (by = t.tsaName);
      else unchecked = true;
    }
    return { level: stampFields.size ? 'B-LTA' : 'B-LT', doc_timestamp_at: at, doc_timestamp_by: by, doc_timestamp_unchecked: unchecked };
  } catch {
    return null;
  }
}
