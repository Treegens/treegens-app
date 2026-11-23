// CMS SignedData (RFC 5652) for the digital seal of a completed PDF, and the reading and checking of one: our own seal
// on /verify, and the RFC 3161 time-stamp token a time-stamp service sends back (tsa.ts). Built with der.ts on
// node:crypto, with no library.
//
// What the seal's SignedData holds, checked against ETSI EN 319 142-1 V1.1.1 (PAdES), clause 6.3, Table 1
// ("Requirements on components and services" for the PAdES baseline levels), and the CAdES rules it points to in
// ETSI EN 319 122-1. The ETSI texts could not be opened from the machine this was written on, so the clause numbers
// were checked from memory; the structure itself is checked by pdfsig (poppler) and `openssl cms -verify` in
// tests/seal.test.ts.
//   - SignedData, detached: no eContent; eContentType id-data. EN 319 142-1 clause 6.3, Table 1, row "content-type".
//   - Signed attribute content-type with the value id-data. Same row.
//   - Signed attribute message-digest: SHA-256 of the bytes the ByteRange covers. Table 1, row "message-digest".
//   - Signed attribute signing-certificate-v2 (ESSCertIDv2, RFC 5035), SHA-256 of the seal certificate with its
//     issuer and serial number. Table 1, row "ESS signing-certificate-v2" (shall be present at B-B).
//   - No signing-time signed attribute: the time is the /M entry of the signature dictionary. Table 1, rows
//     "signing-time" (shall not be present) and "M".
//   - The seal certificate and its chain in SignedData.certificates. Table 1, row "signing certificate" (the
//     signing certificate shall be present in the signature).
//   - B-T: the time-stamp token over the signature value as the unsigned attribute signature-time-stamp
//     (id-aa-signatureTimeStampToken). Table 1, row "signature-time-stamp" (B-T: shall be present).
import crypto from 'node:crypto';
import { seq, setOf, tagged, integer, oid, octets, algorithm, read, kids, content, whole, readOid, readInt, readOctets, expect, DerError, type Node } from './der.ts';
import { readCert, type CertInfo } from './x509.ts';

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  signatureTimeStamp: '1.2.840.113549.1.9.16.2.14',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  rsa: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  mgf1: '1.2.840.113549.1.1.8',
  sha1WithRsa: '1.2.840.113549.1.1.5',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  sha384WithRsa: '1.2.840.113549.1.1.12',
  sha512WithRsa: '1.2.840.113549.1.1.13',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ecdsaSha384: '1.2.840.10045.4.3.3',
  ecdsaSha512: '1.2.840.10045.4.3.4',
  ecPublicKey: '1.2.840.10045.2.1',
};

const HASH_OF: Record<string, string> = { [OID.sha1]: 'sha1', [OID.sha256]: 'sha256', [OID.sha384]: 'sha384', [OID.sha512]: 'sha512' };
export const hashName = (o: string) => HASH_OF[o] || null;

/**
 * Whatever makes the signature value. The key never leaves it: a key file read into memory (sealkey.ts), or a cloud
 * signing service that keeps the key in its own hardware (sealcsc.ts, the CSC API of SSL.com eSigner). `sign` is
 * given the SHA-256 digest of the DER of the signed attributes, which is all a cloud service is sent, and the DER
 * itself, for a signer that hashes on its own (node:crypto does). `rsa-pkcs1` is RSA with PKCS #1 v1.5 padding
 * (sha256WithRSAEncryption), which is what SSL.com's service signs with; a key file is signed with RSASSA-PSS.
 */
export interface SealSigner {
  readonly scheme: 'rsa-pss' | 'rsa-pkcs1' | 'ecdsa-p256';
  /** The seal certificate first, then the certificates that issued it, as DER. */
  chain(): Buffer[];
  sign(digest: Buffer, message: Buffer): Promise<Buffer>;
}

// RSASSA-PSS with SHA-256, MGF1 with SHA-256 and a 32-byte salt (RFC 4055 section 3.1), sha256WithRSAEncryption
// (RFC 4055 section 5), or ECDSA with SHA-256.
export function signatureAlgorithm(scheme: SealSigner['scheme']): Buffer {
  if (scheme === 'ecdsa-p256') return algorithm(OID.ecdsaSha256);
  if (scheme === 'rsa-pkcs1') return algorithm(OID.sha256WithRsa, null);
  const sha256 = algorithm(OID.sha256, null);
  return algorithm(OID.rsaPss, seq(tagged(0, sha256), tagged(1, algorithm(OID.mgf1, sha256)), tagged(2, integer(32))));
}

const attribute = (type: string, ...values: Buffer[]) => seq(oid(type), setOf(...values));

/** The three signed attributes PAdES B-B asks for, and nothing else (see the top of this file). */
export function sealAttributes(digest: Buffer, cert: CertInfo): Buffer[] {
  // ESSCertIDv2 with the default hash algorithm (SHA-256) leaves hashAlgorithm out (RFC 5035 section 4, DER).
  const issuerSerial = seq(seq(tagged(4, cert.issuerDer)), integer(cert.serialBytes));
  const essCertIdV2 = seq(octets(crypto.createHash('sha256').update(cert.der).digest()), issuerSerial);
  return [
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octets(digest)),
    attribute(OID.signingCertificateV2, seq(seq(essCertIdV2))),
  ];
}

/**
 * Signs: `digest` is SHA-256 of the bytes the seal covers. `unsigned` is asked for the unsigned attributes once the
 * signature value is known (the time-stamp token over it, for B-T). Returns the DER of the ContentInfo.
 */
/**
 * `bare` is the same SignedData without any unsigned attribute, built from the same signature value: a seal whose time
 * stamp could not be got or does not fit is kept without it, and the signer (a paid cloud signing, sealcsc.ts) is not
 * asked to sign again.
 */
export async function buildSignedData(digest: Buffer, signer: SealSigner, unsigned?: (signature: Buffer) => Promise<Buffer[]>): Promise<{ der: Buffer; signature: Buffer; bare: () => Buffer }> {
  const chain = signer.chain();
  const cert = readCert(chain[0]);
  const attrs = sealAttributes(digest, cert);
  // The signature is over the DER of the attributes as a SET OF (RFC 5652 section 5.4), sorted.
  const toSign = setOf(...attrs);
  const signature = await signer.sign(crypto.createHash('sha256').update(toSign).digest(), toSign);
  const assemble = (extra: Buffer[]) => {
    const signerInfo = seq(
      integer(1),
      seq(cert.issuerDer, integer(cert.serialBytes)),
      algorithm(OID.sha256, null),
      tagged(0, content(read(toSign))), // [0] IMPLICIT SET OF Attribute: the same members, the same order
      signatureAlgorithm(signer.scheme),
      octets(signature),
      ...(extra.length ? [tagged(1, Buffer.concat([...extra].sort(Buffer.compare)))] : []),
    );
    const signedData = seq(
      integer(1),
      setOf(algorithm(OID.sha256, null)),
      seq(oid(OID.data)),
      tagged(0, Buffer.concat(chain)),
      setOf(signerInfo),
    );
    return seq(oid(OID.signedData), tagged(0, signedData));
  };
  const bare = () => assemble([]);
  const extra = unsigned ? await unsigned(signature) : [];
  return { der: assemble(extra), signature, bare };
}

export const signatureTimeStampAttribute = (token: Buffer) => attribute(OID.signatureTimeStamp, token);

// ---- Reading and checking ------------------------------------------------------------------

export type Attr = { type: string; values: Node[] };
export type ParsedSigner = {
  sid: { issuerDer: Buffer; serial: bigint } | { keyId: Buffer };
  digestAlgorithm: string;
  /** The signed attributes as the signer put them, re-tagged as a SET OF: what the signature is over. */
  signedAttrsDer: Buffer | null;
  signedAttrs: Attr[];
  signatureAlgorithm: string;
  signatureParams: Node | null;
  signature: Buffer;
  unsignedAttrs: Attr[];
};
export type ParsedSignedData = { eContentType: string; eContent: Buffer | null; certificates: Buffer[]; signers: ParsedSigner[] };

function attrs(n: Node): Attr[] {
  return kids(n).map((a) => {
    const [t, v] = kids(a);
    return { type: readOid(t), values: kids(v) };
  });
}

/** Reads a ContentInfo holding SignedData. Throws DerError when it is not one. */
export function parseSignedData(der: Uint8Array): ParsedSignedData {
  const ci = kids(read(der));
  if (readOid(ci[0]) !== OID.signedData) throw new DerError('it is not CMS signed data');
  const sd = kids(kids(expect(ci[1], 0xa0, 'The signed data'))[0]);
  let i = 1; // version
  i++; // digestAlgorithms
  const encap = kids(sd[i++]);
  const eContentType = readOid(encap[0]);
  const eContent = encap[1] ? readOctets(kids(expect(encap[1], 0xa0, 'The content'))[0]) : null;
  const certificates: Buffer[] = [];
  if (sd[i]?.tag === 0xa0) {
    for (const c of kids(sd[i])) if (c.tag === 0x30) certificates.push(Buffer.from(whole(c)));
    i++;
  }
  if (sd[i]?.tag === 0xa1) i++; // crls
  const signers = kids(expect(sd[i], 0x31, 'The signer infos')).map((si): ParsedSigner => {
    const f = kids(si);
    let j = 1;
    const sidNode = f[j++];
    const sid = sidNode.tag === 0x80 ? { keyId: Buffer.from(content(sidNode)) } : { issuerDer: Buffer.from(whole(kids(sidNode)[0])), serial: readInt(kids(sidNode)[1]) };
    const digestAlgorithm = readOid(kids(f[j++])[0]);
    let signedAttrsDer: Buffer | null = null;
    let signed: Attr[] = [];
    if (f[j]?.tag === 0xa0) {
      signedAttrsDer = Buffer.concat([Buffer.from([0x31]), whole(f[j]).subarray(1)]);
      signed = attrs(read(signedAttrsDer));
      j++;
    }
    const alg = kids(f[j++]);
    const signature = Buffer.from(readOctets(f[j++]));
    const unsigned = f[j]?.tag === 0xa1 ? attrs(f[j]) : [];
    return { sid, digestAlgorithm, signedAttrsDer, signedAttrs: signed, signatureAlgorithm: readOid(alg[0]), signatureParams: alg[1] || null, signature, unsignedAttrs: unsigned };
  });
  return { eContentType, eContent, certificates, signers };
}

export const attrValue = (list: Attr[], type: string): Node | null => list.find((a) => a.type === type)?.values[0] || null;

/** The certificate a signer info names, from the certificates the SignedData carries. */
export function signerCert(sd: ParsedSignedData, s: ParsedSigner): CertInfo | null {
  for (const der of sd.certificates) {
    let c: CertInfo;
    try {
      c = readCert(der);
    } catch {
      continue;
    }
    if ('keyId' in s.sid ? c.subjectKeyId?.equals(s.sid.keyId) : c.serial === s.sid.serial && c.issuerDer.equals(s.sid.issuerDer)) return c;
  }
  return null;
}

/** Checks a signature value over `data` with the certificate's key, by the algorithm the signer info names. */
export function verifySignatureValue(s: ParsedSigner, data: Buffer, cert: CertInfo): boolean {
  const key = cert.x509.publicKey;
  const alg = s.signatureAlgorithm;
  try {
    if (alg === OID.rsaPss) {
      const p = s.signatureParams ? kids(s.signatureParams) : [];
      let hash = 'sha1';
      let salt = 20;
      for (const n of p) {
        if (n.tag === 0xa0) hash = hashName(readOid(kids(kids(n)[0])[0])) || 'unknown';
        if (n.tag === 0xa2) salt = Number(readInt(kids(n)[0]));
      }
      return crypto.verify(hash, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: salt }, s.signature);
    }
    const byAlg: Record<string, string> = {
      [OID.sha1WithRsa]: 'sha1', [OID.sha256WithRsa]: 'sha256', [OID.sha384WithRsa]: 'sha384', [OID.sha512WithRsa]: 'sha512',
      [OID.ecdsaSha256]: 'sha256', [OID.ecdsaSha384]: 'sha384', [OID.ecdsaSha512]: 'sha512',
    };
    // rsaEncryption and ecPublicKey as the "signature algorithm" mean: the key's own scheme with the digest algorithm.
    const hash = byAlg[alg] || (alg === OID.rsa || alg === OID.ecPublicKey ? hashName(s.digestAlgorithm) : null);
    if (!hash) return false;
    return crypto.verify(hash, data, key, s.signature);
  } catch {
    return false;
  }
}

/**
 * Checks one signer of a SignedData over `contentDigest` (the digest of the detached or encapsulated content, by the
 * signer's digest algorithm): the content-type and message-digest attributes, then the signature over the signed
 * attributes with the certificate the signer names. Says why when it does not hold.
 */
export function checkSigner(sd: ParsedSignedData, s: ParsedSigner, contentOf: (hash: string) => Buffer): { ok: boolean; cert: CertInfo | null; why?: string } {
  const cert = signerCert(sd, s);
  if (!cert) return { ok: false, cert: null, why: 'the certificate that made it is not in the file' };
  const hash = hashName(s.digestAlgorithm);
  if (!hash) return { ok: false, cert, why: 'it uses a digest algorithm this check does not know' };
  if (!s.signedAttrsDer) return { ok: false, cert, why: 'it has no signed attributes' };
  const type = attrValue(s.signedAttrs, OID.contentType);
  if (!type || readOid(type) !== sd.eContentType) return { ok: false, cert, why: 'its content type does not match' };
  const md = attrValue(s.signedAttrs, OID.messageDigest);
  if (!md || !readOctets(md).equals(contentOf(hash))) return { ok: false, cert, why: 'the fingerprint inside it does not match the file' };
  if (!verifySignatureValue(s, s.signedAttrsDer, cert)) return { ok: false, cert, why: 'its signature does not verify with its certificate' };
  return { ok: true, cert };
}

