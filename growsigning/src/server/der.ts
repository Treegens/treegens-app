// A small DER writer and a BER-tolerant reader, on nothing but Buffer. Enough ASN.1 for the digital seal of a
// completed PDF (seal.ts, sealcms.ts), the RFC 3161 time-stamp (tsa.ts) and reading the seal key (sealkey.ts, p12.ts).
// It is not a general ASN.1 library: it writes the few types those need, in DER (X.690 clause 10), and reads what
// certificates, PKCS#12 files and time-stamp answers contain, including BER's indefinite lengths and constructed
// OCTET STRINGs, which some PKCS#12 files use.

// ---- Writing -------------------------------------------------------------------------------

function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Buffer.from([0x80 | out.length, ...out]);
}

/** One tag-length-value. `tag` is the whole identifier octet (0x30 for SEQUENCE, 0xa0 for [0] constructed, ...). */
export const tlv = (tag: number, content: Uint8Array): Buffer => Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);

export const seq = (...parts: Uint8Array[]): Buffer => tlv(0x30, Buffer.concat(parts));

/** A SET OF, its members sorted as DER asks (X.690 clause 11.6): by their encodings, shorter first when one is a prefix. */
export const setOf = (...parts: Uint8Array[]): Buffer => tlv(0x31, Buffer.concat([...parts].map((p) => Buffer.from(p)).sort(Buffer.compare)));

/** A context-specific tag. Constructed (EXPLICIT, or IMPLICIT over a constructed type) unless `primitive`. */
export const tagged = (n: number, content: Uint8Array, primitive = false): Buffer => tlv((primitive ? 0x80 : 0xa0) | n, content);

export function integer(v: number | bigint | Uint8Array): Buffer {
  let b: Buffer;
  if (v instanceof Uint8Array) {
    b = Buffer.from(v);
    let i = 0;
    while (i < b.length - 1 && b[i] === 0 && b[i + 1] < 0x80) i++;
    b = b.subarray(i);
    if (b.length === 0) b = Buffer.from([0]);
    if (b[0] >= 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  } else {
    let n = BigInt(v);
    if (n < 0n) throw new Error('negative integers are not needed here');
    const bytes: number[] = [];
    do {
      bytes.unshift(Number(n & 0xffn));
      n >>= 8n;
    } while (n > 0n);
    if (bytes[0] >= 0x80) bytes.unshift(0);
    b = Buffer.from(bytes);
  }
  return tlv(0x02, b);
}

export function oid(dotted: string): Buffer {
  const p = dotted.split('.').map((x) => BigInt(x));
  if (p.length < 2) throw new Error(`bad object identifier ${dotted}`);
  const out: number[] = [];
  const push = (n: bigint) => {
    const g: number[] = [Number(n & 0x7fn)];
    for (n >>= 7n; n > 0n; n >>= 7n) g.unshift(Number(n & 0x7fn) | 0x80);
    out.push(...g);
  };
  push(p[0] * 40n + p[1]);
  for (const n of p.slice(2)) push(n);
  return tlv(0x06, Buffer.from(out));
}

export const octets = (b: Uint8Array): Buffer => tlv(0x04, b);
export const bitString = (b: Uint8Array, unused = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
export const nul = (): Buffer => Buffer.from([0x05, 0x00]);
export const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
export const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
export const printable = (s: string): Buffer => tlv(0x13, Buffer.from(s, 'latin1'));

const two = (n: number) => String(n).padStart(2, '0');
/** GeneralizedTime in UTC, whole seconds (X.690 clause 11.7). */
export const generalizedTime = (d: Date): Buffer =>
  tlv(0x18, Buffer.from(`${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`, 'latin1'));
/** UTCTime, for certificate validity before 2050 (RFC 5280 section 4.1.2.5). */
export const utcTime = (d: Date): Buffer =>
  tlv(0x17, Buffer.from(`${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`, 'latin1'));
export const certTime = (d: Date): Buffer => (d.getUTCFullYear() < 2050 ? utcTime(d) : generalizedTime(d));

/** AlgorithmIdentifier: an OID, with parameters when given. */
export const algorithm = (dotted: string, params?: Uint8Array | null): Buffer => (params === undefined ? seq(oid(dotted)) : seq(oid(dotted), params ?? nul()));

// ---- Reading -------------------------------------------------------------------------------

export type Node = {
  /** The identifier octet (high tag numbers are not used by anything read here). */
  tag: number;
  constructed: boolean;
  /** Where the TLV starts and ends in `buf`, and where its content starts and ends. */
  start: number;
  end: number;
  cStart: number;
  cEnd: number;
  buf: Buffer;
};

export class DerError extends Error {}

function readHeader(buf: Buffer, at: number): { tag: number; len: number | null; cStart: number } {
  if (at + 2 > buf.length) throw new DerError('the data ends too early');
  const tag = buf[at];
  if ((tag & 0x1f) === 0x1f) throw new DerError('a tag this reader does not know');
  const first = buf[at + 1];
  if (first < 0x80) return { tag, len: first, cStart: at + 2 };
  if (first === 0x80) {
    if (!(tag & 0x20)) throw new DerError('an indefinite length on a primitive value');
    return { tag, len: null, cStart: at + 2 };
  }
  const n = first & 0x7f;
  if (n > 4 || at + 2 + n > buf.length) throw new DerError('a length that does not fit');
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i];
  return { tag, len, cStart: at + 2 + n };
}

/** Reads one TLV at `at`. Indefinite lengths are followed to their end-of-contents octets. */
export function read(input: Uint8Array, at = 0, depth = 0): Node {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (depth > 64) throw new DerError('nested too deep');
  const h = readHeader(buf, at);
  const constructed = !!(h.tag & 0x20);
  if (h.len !== null) {
    const cEnd = h.cStart + h.len;
    if (cEnd > buf.length) throw new DerError('a value runs past the end of the data');
    return { tag: h.tag, constructed, start: at, end: cEnd, cStart: h.cStart, cEnd, buf };
  }
  let p = h.cStart;
  for (;;) {
    if (p + 2 > buf.length) throw new DerError('an indefinite length that never ends');
    if (buf[p] === 0 && buf[p + 1] === 0) return { tag: h.tag, constructed, start: at, end: p + 2, cStart: h.cStart, cEnd: p, buf };
    p = read(buf, p, depth + 1).end;
  }
}

/** The members of a constructed value. */
export function kids(n: Node): Node[] {
  if (!n.constructed) throw new DerError('expected a constructed value');
  const out: Node[] = [];
  for (let p = n.cStart; p < n.cEnd; ) {
    const k = read(n.buf, p);
    out.push(k);
    p = k.end;
  }
  return out;
}

export const content = (n: Node): Buffer => n.buf.subarray(n.cStart, n.cEnd);
export const whole = (n: Node): Buffer => n.buf.subarray(n.start, n.end);

export function expect(n: Node | undefined, tag: number, what: string): Node {
  if (!n || n.tag !== tag) throw new DerError(`${what} is missing or not what it should be`);
  return n;
}

export function readOid(n: Node): string {
  expect(n, 0x06, 'an object identifier');
  const b = content(n);
  const out: bigint[] = [];
  let v = 0n;
  for (const byte of b) {
    v = (v << 7n) | BigInt(byte & 0x7f);
    if (!(byte & 0x80)) {
      if (!out.length) out.push(v < 80n ? v / 40n : 2n, v < 80n ? v % 40n : v - 80n);
      else out.push(v);
      v = 0n;
    }
  }
  return out.join('.');
}

export function readInt(n: Node): bigint {
  expect(n, 0x02, 'a number');
  const b = content(n);
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  if (b.length && b[0] & 0x80) v -= 1n << BigInt(8 * b.length);
  return v;
}

/** The bytes of an OCTET STRING, also one in BER's constructed form (pieces joined). `tag` for IMPLICIT ones. */
export function readOctets(n: Node, tag = 0x04): Buffer {
  if (n.tag === tag && !n.constructed) return content(n);
  if (n.tag === (tag | 0x20)) return Buffer.concat(kids(n).map((k) => readOctets(k, 0x04)));
  throw new DerError('expected an octet string');
}

export function readTime(n: Node): Date {
  const s = content(n).toString('latin1');
  const m = n.tag === 0x17 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s) : n.tag === 0x18 ? /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:[.,](\d+))?Z$/.exec(s) : null;
  if (!m) throw new DerError('a time this reader does not know');
  const year = n.tag === 0x17 ? (Number(m[1]) >= 50 ? 1900 : 2000) + Number(m[1]) : Number(m[1]);
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms));
}

/** The text of a string type in a name (UTF8String, PrintableString, IA5String, BMPString, TeletexString read as Latin-1). */
export function readText(n: Node): string {
  const b = content(n);
  if (n.tag === 0x1e) {
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  return n.tag === 0x0c ? b.toString('utf8') : b.toString('latin1');
}
