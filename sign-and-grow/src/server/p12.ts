// Reading a PKCS#12 file (.p12 or .pfx, RFC 7292): the seal key and its certificates, for SEAL_P12. node:crypto
// cannot read these, so this does, with der.ts: the integrity check (the MAC), then each bag. It knows the ways
// files are protected today and the old ones still common in files exported years ago:
//   - PBES2 with PBKDF2 and AES-CBC or triple DES (what OpenSSL 3 and current Windows write),
//   - the PKCS#12 password-based schemes with triple DES or RC2 (what OpenSSL 1.x and older Windows wrote).
// RC2 is no longer in node's OpenSSL, so it is here (RFC 2268), only ever to open the certificates in such a file.
import crypto from 'node:crypto';
import { read, kids, whole, readOid, readInt, readOctets, expect, DerError, type Node } from './der.ts';

const OIDS = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  localKeyId: '1.2.840.113549.1.9.21',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
};
const PKCS12_PBE: Record<string, { cipher: 'des-ede3-cbc' | 'rc2'; keyLen: number }> = {
  '1.2.840.113549.1.12.1.3': { cipher: 'des-ede3-cbc', keyLen: 24 }, // pbeWithSHAAnd3-KeyTripleDES-CBC
  '1.2.840.113549.1.12.1.5': { cipher: 'rc2', keyLen: 16 }, // pbeWithSHAAnd128BitRC2-CBC
  '1.2.840.113549.1.12.1.6': { cipher: 'rc2', keyLen: 5 }, // pbeWithSHAAnd40BitRC2-CBC
};
const HMAC_PRF: Record<string, string> = { '1.2.840.113549.2.7': 'sha1', '1.2.840.113549.2.9': 'sha256', '1.2.840.113549.2.10': 'sha384', '1.2.840.113549.2.11': 'sha512' };
const CIPHERS: Record<string, { name: string; keyLen: number }> = {
  '2.16.840.1.101.3.4.1.2': { name: 'aes-128-cbc', keyLen: 16 },
  '2.16.840.1.101.3.4.1.22': { name: 'aes-192-cbc', keyLen: 24 },
  '2.16.840.1.101.3.4.1.42': { name: 'aes-256-cbc', keyLen: 32 },
  '1.2.840.113549.3.7': { name: 'des-ede3-cbc', keyLen: 24 },
};
const DIGESTS: Record<string, { name: string; u: number; v: number }> = {
  '1.3.14.3.2.26': { name: 'sha1', u: 20, v: 64 },
  '2.16.840.1.101.3.4.2.1': { name: 'sha256', u: 32, v: 64 },
  '2.16.840.1.101.3.4.2.2': { name: 'sha384', u: 48, v: 128 },
  '2.16.840.1.101.3.4.2.3': { name: 'sha512', u: 64, v: 128 },
};

/** A problem with the file or its password, in words for the person who runs the server. */
export class P12Error extends Error {}

/** The password as PKCS#12 wants it for its own schemes: UTF-16, big-endian, with two zero bytes at the end. */
function bmpPassword(pw: string): Buffer {
  const out = Buffer.alloc((pw.length + 1) * 2);
  for (let i = 0; i < pw.length; i++) out.writeUInt16BE(pw.charCodeAt(i), i * 2);
  return out;
}

// RFC 7292 appendix B.2: the PKCS#12 key derivation. id 1 is a key, 2 an IV, 3 a MAC key.
function pkcs12Kdf(hash: { name: string; u: number; v: number }, password: Buffer, salt: Buffer, iterations: number, id: number, n: number): Buffer {
  const { u, v } = hash;
  const D = Buffer.alloc(v, id);
  const fill = (b: Buffer) => {
    if (!b.length) return Buffer.alloc(0);
    const out = Buffer.alloc(v * Math.ceil(b.length / v));
    for (let i = 0; i < out.length; i++) out[i] = b[i % b.length];
    return out;
  };
  const I = Buffer.concat([fill(salt), fill(password)]);
  const out: Buffer[] = [];
  for (let got = 0; got < n; got += u) {
    let A = crypto.createHash(hash.name).update(D).update(I).digest();
    for (let r = 1; r < iterations; r++) A = crypto.createHash(hash.name).update(A).digest();
    out.push(A);
    const B = fill(A).subarray(0, v);
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j + k] + B[k] + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return Buffer.concat(out).subarray(0, n);
}

// ---- RC2 (RFC 2268), decryption only ---------------------------------------------------------

const PITABLE = Buffer.from(
  'd978f9c419ddb5ed28e9fd794aa0d89dc67e37832b76538e624c6488448bfba2179a59f587b34f1361456d8d09817d32' +
  'bd8f40eb86b77b0bf09521225c6b4e8254d66593ce60b21c7356c014a78cf1dc1275ca1f3bbee4d1423dd430a33cb626' +
  '6fbf0eda4669075727f21d9bbc944303f811c7f690ef3ee706c3d52fc8661ed708e8eade8052eef784aa72ac354d6a2a' +
  '961ad2715a1549744b9fd05e0418a4ecc2e0416e0f51cbcc2491af50a1f47039997c3a8523b8b47afc02365b25559731' +
  '2d5dfa98e38a92ae05df2910676cbac9d300e6cfe19ea82c6316013f58e289a90d38341bab33ffb0bb480c5fb9b1cd2e' +
  'c5f3db47e5a59c770aa62068fe7fc1ad', 'hex');

function rc2Keys(key: Buffer, bits: number): Uint16Array {
  const L = Buffer.alloc(128);
  key.copy(L);
  const T = key.length;
  const T8 = Math.ceil(bits / 8);
  const TM = 0xff >> (8 * T8 - bits);
  for (let i = T; i < 128; i++) L[i] = PITABLE[(L[i - 1] + L[i - T]) & 0xff];
  L[128 - T8] = PITABLE[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i--) L[i] = PITABLE[L[i + 1] ^ L[i + T8]];
  const K = new Uint16Array(64);
  for (let i = 0; i < 64; i++) K[i] = L[2 * i] | (L[2 * i + 1] << 8);
  return K;
}

/** One RC2 block decrypted (RFC 2268 section 4). Exported for its test vector only. */
export function rc2DecryptBlock(K: Uint16Array, block: Buffer): Buffer {
  const R = [block.readUInt16LE(0), block.readUInt16LE(2), block.readUInt16LE(4), block.readUInt16LE(6)];
  const S = [1, 2, 3, 5];
  let j = 63;
  const unmix = () => {
    for (let i = 3; i >= 0; i--) {
      R[i] = ((R[i] >>> S[i]) | (R[i] << (16 - S[i]))) & 0xffff;
      R[i] = (R[i] - K[j] - (R[(i + 3) % 4] & R[(i + 2) % 4]) - (~R[(i + 3) % 4] & R[(i + 1) % 4])) & 0xffff;
      j--;
    }
  };
  const unmash = () => {
    for (let i = 3; i >= 0; i--) R[i] = (R[i] - K[R[(i + 3) % 4] & 63]) & 0xffff;
  };
  for (let r = 0; r < 5; r++) unmix();
  unmash();
  for (let r = 0; r < 6; r++) unmix();
  unmash();
  for (let r = 0; r < 5; r++) unmix();
  const out = Buffer.alloc(8);
  R.forEach((w, i) => out.writeUInt16LE(w, i * 2));
  return out;
}
export const rc2Expand = rc2Keys;

function rc2CbcDecrypt(key: Buffer, bits: number, iv: Buffer, data: Buffer): Buffer {
  if (data.length % 8) throw new P12Error('The certificates in the file are damaged.');
  const K = rc2Keys(key, bits);
  const out = Buffer.alloc(data.length);
  let prev = iv;
  for (let i = 0; i < data.length; i += 8) {
    const c = data.subarray(i, i + 8);
    const p = rc2DecryptBlock(K, c);
    for (let k = 0; k < 8; k++) out[i + k] = p[k] ^ prev[k];
    prev = c;
  }
  return unpad(out);
}

function unpad(b: Buffer): Buffer {
  const n = b[b.length - 1];
  if (!n || n > 16 || n > b.length || !b.subarray(b.length - n).every((x) => x === n)) throw new P12Error('The password does not open this file.');
  return b.subarray(0, b.length - n);
}

// ---- Decrypting one protected part -----------------------------------------------------------

function decrypt(alg: Node, data: Buffer, password: string): Buffer {
  const [idNode, params] = kids(alg);
  const id = readOid(idNode);
  try {
    if (id === OIDS.pbes2) {
      const [kdf, scheme] = kids(params);
      const [kdfId, kdfParams] = kids(kdf);
      if (readOid(kdfId) !== OIDS.pbkdf2) throw new P12Error('The file is protected in a way this server cannot open. Export it again with current settings, or use SEAL_KEY_PEM and SEAL_CERT_PEM.');
      const kp = kids(kdfParams);
      const salt = readOctets(kp[0]);
      const iterations = Number(readInt(kp[1]));
      let prf = 'sha1';
      for (const n of kp.slice(2)) if (n.tag === 0x30) prf = HMAC_PRF[readOid(kids(n)[0])] || '';
      const [cipherId, ivNode] = kids(scheme);
      const cipher = CIPHERS[readOid(cipherId)];
      if (!cipher || !prf) throw new P12Error('The file is protected with a cipher this server cannot open. Export it again with AES, or use SEAL_KEY_PEM and SEAL_CERT_PEM.');
      if (iterations > 10_000_000) throw new P12Error('The file asks for more work to open than this server will do.');
      const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, cipher.keyLen, prf);
      const d = crypto.createDecipheriv(cipher.name, key, readOctets(ivNode));
      return Buffer.concat([d.update(data), d.final()]);
    }
    const pbe = PKCS12_PBE[id];
    if (!pbe) throw new P12Error('The file is protected in a way this server cannot open. Export it again with current settings, or use SEAL_KEY_PEM and SEAL_CERT_PEM.');
    const [saltNode, iterNode] = kids(params);
    const salt = readOctets(saltNode);
    const iterations = Number(readInt(iterNode));
    if (iterations > 10_000_000) throw new P12Error('The file asks for more work to open than this server will do.');
    const sha1 = DIGESTS['1.3.14.3.2.26'];
    const pw = bmpPassword(password);
    const key = pkcs12Kdf(sha1, pw, salt, iterations, 1, pbe.keyLen);
    const iv = pkcs12Kdf(sha1, pw, salt, iterations, 2, 8);
    if (pbe.cipher === 'rc2') return rc2CbcDecrypt(key, pbe.keyLen * 8, iv, data);
    const d = crypto.createDecipheriv('des-ede3-cbc', key, iv);
    return Buffer.concat([d.update(data), d.final()]);
  } catch (e) {
    if (e instanceof P12Error) throw e;
    throw new P12Error('The password does not open this file.');
  }
}

// ---- The file --------------------------------------------------------------------------------

export type P12Contents = { key: crypto.KeyObject; certs: Buffer[]; keyCert: Buffer | null };

/** Opens a PKCS#12 file with its password: its private key, every certificate in it, and the one that goes with the key. */
export function openP12(file: Buffer, password: string): P12Contents {
  let pfx: Node[];
  try {
    pfx = kids(read(file));
  } catch {
    throw new P12Error('The file is not a PKCS#12 (.p12 or .pfx) file.');
  }
  try {
    if (Number(readInt(pfx[0])) !== 3) throw new P12Error('The file is not a PKCS#12 file this server knows (version 3).');
    const authSafe = kids(pfx[1]);
    if (readOid(authSafe[0]) !== OIDS.data) throw new P12Error('The file is signed with a public key instead of a password, which this server does not open. Export it again with a password.');
    const safeBytes = readOctets(kids(expect(authSafe[1], 0xa0, 'The contents'))[0]);
    // The MAC: the file was not damaged, and the password is right (RFC 7292 section 5).
    if (pfx[2]) {
      const mac = kids(pfx[2]);
      const digestInfo = kids(mac[0]);
      const alg = DIGESTS[readOid(kids(digestInfo[0])[0])];
      if (!alg) throw new P12Error('The file is checked with a hash this server does not know. Export it again with current settings.');
      const expected = readOctets(digestInfo[1]);
      const salt = readOctets(mac[1]);
      const iterations = mac[2] ? Number(readInt(mac[2])) : 1;
      if (iterations > 10_000_000) throw new P12Error('The file asks for more work to open than this server will do.');
      const tryPw = (pw: Buffer) => crypto.createHmac(alg.name, pkcs12Kdf(alg, pw, salt, iterations, 3, alg.u)).update(safeBytes).digest().equals(expected);
      if (!tryPw(bmpPassword(password)) && !(password === '' && tryPw(Buffer.alloc(0)))) throw new P12Error('The password does not open this file (SEAL_P12_PASSWORD), or the file is damaged.');
    }
    const keys: { key: crypto.KeyObject; id: Buffer | null }[] = [];
    const certs: { der: Buffer; id: Buffer | null }[] = [];
    const bagId = (bag: Node[]) => {
      if (!bag[2]) return null;
      for (const a of kids(bag[2])) {
        const [t, v] = kids(a);
        if (readOid(t) === OIDS.localKeyId) return Buffer.from(readOctets(kids(v)[0]));
      }
      return null;
    };
    for (const ci of kids(read(safeBytes))) {
      const [typeNode, wrapped] = kids(ci);
      const type = readOid(typeNode);
      let contents: Buffer;
      if (type === OIDS.data) contents = readOctets(kids(wrapped)[0]);
      else if (type === OIDS.encryptedData) {
        const ed = kids(kids(wrapped)[0]);
        const eci = kids(ed[1]);
        contents = decrypt(eci[1], readOctets(eci[2], 0x80), password);
      } else continue;
      for (const bagNode of kids(read(contents))) {
        const bag = kids(bagNode);
        const id = readOid(bag[0]);
        const value = kids(bag[1])[0];
        if (id === OIDS.certBag) {
          const cb = kids(value);
          if (readOid(cb[0]) === OIDS.x509Certificate) certs.push({ der: Buffer.from(readOctets(kids(cb[1])[0])), id: bagId(bag) });
        } else if (id === OIDS.shroudedKeyBag) {
          const epki = kids(value);
          const der = decrypt(epki[0], readOctets(epki[1]), password);
          keys.push({ key: crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), id: bagId(bag) });
        } else if (id === OIDS.keyBag) {
          keys.push({ key: crypto.createPrivateKey({ key: Buffer.from(whole(value)), format: 'der', type: 'pkcs8' }), id: bagId(bag) });
        }
      }
    }
    if (keys.length !== 1) throw new P12Error(keys.length ? 'The file holds more than one private key. Put only the seal key in it.' : 'The file holds no private key.');
    const k = keys[0];
    const keyCert = (k.id && certs.find((c) => c.id?.equals(k.id!))?.der) || null;
    return { key: k.key, certs: certs.map((c) => c.der), keyCert };
  } catch (e) {
    if (e instanceof P12Error) throw e;
    if (e instanceof DerError) throw new P12Error('The file is damaged or is not a PKCS#12 file.');
    throw new P12Error(`The file could not be opened: ${(e as Error)?.message || e}`);
  }
}

