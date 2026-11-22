// What the digital seal needs to read out of an X.509 certificate (RFC 5280) that node:crypto's X509Certificate does
// not give: the issuer and subject as DER (for IssuerAndSerialNumber and ESSCertIDv2), the key usage bits, the
// extended key usages, and the key identifiers. Everything else comes from X509Certificate itself.
import crypto from 'node:crypto';
import { read, kids, content, whole, readOid, readInt, readOctets, readText, readTime, expect, type Node } from './der.ts';

export type CertInfo = {
  der: Buffer;
  x509: crypto.X509Certificate;
  issuerDer: Buffer;
  subjectDer: Buffer;
  serial: bigint;
  /** The serial number as its INTEGER content bytes, so it is written back exactly as the certificate has it. */
  serialBytes: Buffer;
  notBefore: Date;
  notAfter: Date;
  /** null when the certificate has no key usage extension (then it does not restrict the key). */
  keyUsage: { digitalSignature: boolean; nonRepudiation: boolean; keyCertSign: boolean } | null;
  extKeyUsage: string[] | null;
  subjectKeyId: Buffer | null;
  isCA: boolean;
  /** A short name for people: the common name, else the organisation, else the whole subject. */
  name: string;
  issuerName: string;
};

const OID_CN = '2.5.4.3';
const OID_O = '2.5.4.10';

/** The attributes of a Name, in order, as [oid, text]. */
export function nameParts(name: Node): [string, string][] {
  const out: [string, string][] = [];
  for (const rdn of kids(name)) for (const atv of kids(rdn)) {
    const [t, v] = kids(atv);
    try {
      out.push([readOid(t), readText(v)]);
    } catch {
      /* an attribute this reader cannot show is left out of the short name only */
    }
  }
  return out;
}

const shortName = (parts: [string, string][], fallback: string) =>
  parts.find(([o]) => o === OID_CN)?.[1] || parts.find(([o]) => o === OID_O)?.[1] || fallback;

export function readCert(der: Uint8Array): CertInfo {
  const buf = Buffer.from(der);
  const x509 = new crypto.X509Certificate(buf);
  const cert = read(buf);
  const [tbs] = kids(cert);
  const t = kids(tbs);
  let i = 0;
  if (t[0].tag === 0xa0) i++; // version
  const serialNode = expect(t[i++], 0x02, 'The serial number');
  i++; // signature algorithm
  const issuer = t[i++];
  const validity = kids(t[i++]);
  const subject = t[i++];
  i++; // subject public key info
  let keyUsage: CertInfo['keyUsage'] = null;
  let extKeyUsage: string[] | null = null;
  let subjectKeyId: Buffer | null = null;
  let isCA = false;
  const exts = t.slice(i).find((n) => n.tag === 0xa3);
  if (exts) {
    for (const ext of kids(kids(exts)[0])) {
      const parts = kids(ext);
      const id = readOid(parts[0]);
      const value = readOctets(parts[parts.length - 1]);
      const inner = read(value);
      if (id === '2.5.29.15') {
        const bits = content(inner);
        const b0 = bits.length > 1 ? bits[1] : 0;
        keyUsage = { digitalSignature: !!(b0 & 0x80), nonRepudiation: !!(b0 & 0x40), keyCertSign: !!(b0 & 0x04) };
      } else if (id === '2.5.29.37') extKeyUsage = kids(inner).map(readOid);
      else if (id === '2.5.29.14') subjectKeyId = readOctets(inner);
      else if (id === '2.5.29.19') {
        const k = kids(inner);
        isCA = !!(k[0] && k[0].tag === 0x01 && content(k[0])[0] !== 0);
      }
    }
  }
  const subj = nameParts(subject);
  const iss = nameParts(issuer);
  return {
    der: buf, x509, issuerDer: Buffer.from(whole(issuer)), subjectDer: Buffer.from(whole(subject)),
    serial: readInt(serialNode), serialBytes: Buffer.from(content(serialNode)),
    notBefore: readTime(validity[0]), notAfter: readTime(validity[1]),
    keyUsage, extKeyUsage, subjectKeyId, isCA,
    name: shortName(subj, x509.subject.replace(/\n/g, ', ')),
    issuerName: shortName(iss, x509.issuer.replace(/\n/g, ', ')),
  };
}

/** True when `issuer` signed `child` (names match and the signature verifies). */
export function issued(issuer: CertInfo, child: CertInfo): boolean {
  if (!issuer.subjectDer.equals(child.issuerDer)) return false;
  try {
    return child.x509.verify(issuer.x509.publicKey);
  } catch {
    return false;
  }
}

/** A self-signed certificate: its own issuer, and its own key checks its signature. */
export const selfSigned = (c: CertInfo) => issued(c, c);

/** SHA-256 of a certificate, as hex: how this server recognises the certificates it sealed with. */
export const certHash = (der: Uint8Array) => crypto.createHash('sha256').update(der).digest('hex');
