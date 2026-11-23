// Test certificates for the digital seal (tests/seal.test.ts), made here with src/server/der.ts and node:crypto: a
// test authority, seal certificates (good, expired, wrong key usage) and a time-stamp authority, and a stub
// time-stamp service that answers through a fetch stub. Nothing reaches the network.
import crypto from 'node:crypto';
import { seq, setOf, tagged, integer, oid, octets, bitString, bool, utf8, algorithm, certTime, generalizedTime, read, kids, content, readOctets, readInt, whole } from '../src/server/der.ts';

export type Made = { key: crypto.KeyObject; der: Buffer; pem: string; keyPem: string };

const name = (cn: string, o = 'Test Operator') => seq(setOf(seq(oid('2.5.4.10'), utf8(o))), setOf(seq(oid('2.5.4.3'), utf8(cn))));
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const pem = (der: Buffer, label = 'CERTIFICATE') => `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END ${label}-----\n`;

let serial = 1000;

/**
 * A certificate for `key`'s public half, signed by `issuer` (or itself). `ku` the key usage bits as a byte
 * (0x80 digitalSignature, 0x40 nonRepudiation, 0x04 keyCertSign, 0x02 cRLSign); `eku` extended key usages.
 */
export function makeCert(o: { cn: string; key?: crypto.KeyObject; issuer?: Made; ca?: boolean; ku?: number | null; eku?: string[]; ekuCritical?: boolean; from?: Date; to?: Date; ec?: boolean; more?: Buffer[] }): Made {
  const key = o.key || (o.ec ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }) as Buffer;
  const signKey = o.issuer ? o.issuer.key : key;
  const ecSign = signKey.asymmetricKeyType === 'ec';
  const sigAlg = ecSign ? algorithm('1.2.840.10045.4.3.2') : algorithm('1.2.840.113549.1.1.11', null);
  const issuerName = o.issuer ? Buffer.from(whole(kids(kids(read(o.issuer.der))[0])[5])) : name(o.cn); // the issuer's subject
  const exts: Buffer[] = [];
  if (o.ca) exts.push(ext('2.5.29.19', true, seq(bool(true))));
  const ku = o.ku === undefined ? (o.ca ? 0x06 : 0xc0) : o.ku;
  if (ku !== null) exts.push(ext('2.5.29.15', true, bitString(Buffer.from([ku]), 1)));
  if (o.eku) exts.push(ext('2.5.29.37', !!o.ekuCritical, seq(...o.eku.map(oid))));
  exts.push(ext('2.5.29.14', false, octets(crypto.createHash('sha1').update(pub).digest())));
  // More extensions as made by ext() (tests/seal-ltv.test.ts: where to ask about the certificate).
  if (o.more) exts.push(...o.more);
  const from = o.from || new Date(Date.now() - 3600_000);
  const to = o.to || new Date(Date.now() + 365 * 864e5);
  const tbs = seq(tagged(0, integer(2)), integer(serial++), sigAlg, issuerName, seq(certTime(from), certTime(to)), name(o.cn), pub, tagged(3, seq(...exts)));
  const sig = crypto.sign('sha256', tbs, ecSign ? { key: signKey, dsaEncoding: 'der' } : signKey);
  const der = seq(tbs, sigAlg, bitString(sig));
  return { key, der, pem: pem(der), keyPem: key.export({ type: 'pkcs8', format: 'pem' }) as string };
}

// ---- A stub time-stamp service (RFC 3161) ---------------------------------------------------

export const TIME_STAMPING = '1.3.6.1.5.5.7.3.8';

/** Builds a time-stamp answer to a request, signed by `tsa`. `mutate` changes what goes in, for the bad cases. */
export function tsaAnswer(request: Buffer, tsa: Made, chain: Made[], mutate: { status?: number; nonce?: bigint; imprint?: Buffer; time?: Date; noToken?: boolean } = {}): Buffer {
  const req = kids(read(request));
  const imprint = mutate.imprint || readOctets(kids(req[1])[1]);
  const nonce = mutate.nonce ?? readInt(req[2]);
  const status = seq(integer(mutate.status ?? 0));
  if (mutate.status && mutate.status > 1) return seq(status);
  if (mutate.noToken) return seq(status);
  const tst = seq(integer(1), oid('1.2.3.4.1'), seq(algorithm('2.16.840.1.101.3.4.2.1', null), octets(imprint)), integer(crypto.randomBytes(8)), generalizedTime(mutate.time || new Date()), integer(nonce));
  const cert = read(tsa.der);
  const tbs = kids(kids(cert)[0]);
  const issuerDer = whole(tbs[3]);
  const serialBytes = content(tbs[1]);
  const essV2 = seq(seq(seq(octets(crypto.createHash('sha256').update(tsa.der).digest()))));
  const attrs = [
    seq(oid('1.2.840.113549.1.9.3'), setOf(oid('1.2.840.113549.1.9.16.1.4'))),
    seq(oid('1.2.840.113549.1.9.4'), setOf(octets(crypto.createHash('sha256').update(tst).digest()))),
    seq(oid('1.2.840.113549.1.9.16.2.47'), setOf(essV2)),
  ];
  const signed = setOf(...attrs);
  const sig = crypto.sign('sha256', signed, tsa.key);
  const si = seq(integer(1), seq(issuerDer, integer(serialBytes)), algorithm('2.16.840.1.101.3.4.2.1', null), tagged(0, signed.subarray(read(signed).cStart)), algorithm('1.2.840.113549.1.1.11', null), octets(sig));
  const sd = seq(integer(3), setOf(algorithm('2.16.840.1.101.3.4.2.1', null)), seq(oid('1.2.840.113549.1.9.16.1.4'), tagged(0, octets(tst))), tagged(0, Buffer.concat([tsa.der, ...chain.map((c) => c.der)])), setOf(si));
  return seq(status, seq(oid('1.2.840.113549.1.7.2'), tagged(0, sd)));
}

export type Stub = { calls: { url: string; auth: string | null }[]; restore: () => void };

/**
 * Replaces fetch: requests to `urls` get `answer(request, url)` (a Buffer, an HTTP status number, or 'hang' to never
 * answer), anything else fails. `restore` puts the real fetch back.
 */
export function stubTsa(answer: (req: Buffer, url: string) => Buffer | number | 'hang' | Promise<Buffer>): Stub {
  const real = globalThis.fetch;
  const calls: Stub['calls'] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input?.url || input);
    calls.push({ url, auth: init?.headers?.authorization || null });
    const body = Buffer.from(init?.body || []);
    const a = await answer(body, url);
    if (a === 'hang') {
      // AbortSignal.timeout does not keep a process alive by itself; a real server's open socket does. This stands in for it.
      const alive = setInterval(() => {}, 1000);
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => (clearInterval(alive), reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })))));
    }
    if (typeof a === 'number') return new Response('no', { status: a });
    return new Response(new Uint8Array(a), { status: 200, headers: { 'content-type': 'application/timestamp-reply' } });
  }) as any;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

export { pem, ext, name };
