// The digital seal of a completed PDF: an invisible PAdES signature (an electronic seal of whoever runs this server)
// over the whole file, so anyone can open the file in Acrobat or another reader and see that it has not changed
// since it was completed, without asking us. It is the server's seal, not a signature of the people who signed.
//
//   sealPlan()      what the next seal will be, from the settings (sealkey.ts, tsa.ts); null when files are not sealed
//   sealLineFor(e)  the line drawCertificate prints about it, for the plan finishPdf put on the envelope
//   sealPdf()       appends the seal (sealpdf.ts) and fills it with the CMS (sealcms.ts), at B-T when a time-stamp
//                   service gives a time-stamp that checks out (tsa.ts), else at B-B
//   checkSeal()     for /verify: whether a file carries a seal, whether it holds, and whether it is ours
//   existingSignatures()  how many signed signature fields an uploaded PDF has (they do not survive in the signed copy)
//
// finishPdf in finalpipe.ts decides the plan once, renders the certificate with it and seals; the stored SHA-256 is
// of the sealed file. With no seal settings nothing here runs and the file is byte for byte what it was before.
import crypto from 'node:crypto';
import { PDFDocument, PDFSignature, PDFName } from 'pdf-lib';
import { sealState, type SealKey } from './sealkey.ts';
import { tsaUrls, timeStamp, TsaError } from './tsa.ts';
import { prepareSeal, coveredBytes, fillSeal } from './sealpdf.ts';
import { buildSignedData, signatureTimeStampAttribute, parseSignedData, checkSigner, attrValue, hashName, OID } from './sealcms.ts';
import { read, kids, whole, readOid, readOctets, readTime } from './der.ts';
import { certHash } from './x509.ts';
import { get, run } from './db.ts';
import { now } from './util.ts';
import { sealCertificateLine, type SealLevel } from '../lib/seal.ts';

export type SealPlan = { key: SealKey; level: SealLevel; tsa: string[]; tsaFailed?: string };
export type SealDone = { level: SealLevel; certHash: string; name: string; issuer: string; at: string; tsaHost?: string; tsaTime?: string; tsaFailed?: string };

/** What the next seal is, from the settings. `noTsa` (why) seals at B-B even with a time-stamp service set. */
export function sealPlan(noTsa?: string): SealPlan | null {
  const s = sealState();
  if (!s.on) return null;
  const tsa = noTsa ? [] : tsaUrls();
  return { key: s.key, level: tsa.length ? 'B-T' : 'B-B', tsa, ...(noTsa ? { tsaFailed: noTsa } : {}) };
}

/** The certificate's line about the seal of its own file: null unless finishPdf is sealing this one. */
export function sealLineFor(e: any): string | null {
  const p: SealPlan | undefined = e?.seal_plan;
  if (!p) return null;
  return sealCertificateLine({ name: p.key.cert.name, issuer: p.key.cert.issuerName, level: p.level, tsaFailed: !!p.tsaFailed });
}

/** The seal could not be got from any time-stamp service: the caller seals again at B-B. */
export class TimeStampMissing extends Error {}

/** Seals `pdf` with the plan's key; with time-stamp services in the plan, B-T or a TimeStampMissing. */
export async function sealPdf(pdf: Uint8Array, plan: SealPlan, when = new Date()): Promise<{ bytes: Buffer; done: SealDone }> {
  const prepared = await prepareSeal(pdf, when);
  const digest = crypto.createHash('sha256').update(coveredBytes(prepared.bytes, prepared.byteRange)).digest();
  let stamp: Awaited<ReturnType<typeof timeStamp>> | null = null;
  const { der } = await buildSignedData(digest, plan.key.signer, plan.tsa.length ? async (signature) => {
    try {
      stamp = await timeStamp(signature, plan.tsa);
    } catch (e) {
      throw new TimeStampMissing(e instanceof TsaError ? e.message : String((e as Error)?.message || e));
    }
    return [signatureTimeStampAttribute(stamp.token)];
  } : undefined);
  let bytes: Buffer;
  try {
    bytes = fillSeal(prepared, der);
  } catch (e) {
    // A time-stamp token with a long chain can be more than the room kept for it: the seal without it fits.
    if (stamp) throw new TimeStampMissing(`the time-stamp is too large to fit in the seal (${(e as Error).message})`);
    throw e;
  }
  const st = stamp as Awaited<ReturnType<typeof timeStamp>> | null;
  return {
    bytes,
    done: {
      level: st ? 'B-T' : 'B-B', certHash: plan.key.hash, name: plan.key.cert.name, issuer: plan.key.cert.issuerName, at: when.toISOString(),
      ...(st ? { tsaHost: st.host, tsaTime: st.time.toISOString() } : {}), ...(plan.tsaFailed ? { tsaFailed: plan.tsaFailed } : {}),
    },
  };
}

/** Writes down a certificate this server sealed with, so /verify still knows it after the key is changed. */
export function rememberSealCert(done: SealDone) {
  run('INSERT OR IGNORE INTO seal_certs (sha256, name, issuer, first_at) VALUES (?,?,?,?)', done.certHash, done.name, done.issuer, now());
}

// ---- Checking a file (/verify) ---------------------------------------------------------------

export type SealCheck = {
  /** The seal holds: its fingerprint matches the bytes it covers and its signature verifies with its certificate. */
  intact: boolean;
  /** It covers the whole file: nothing was saved into the file after it. */
  whole_file: boolean;
  /** It was made with a certificate this server seals with, or sealed with before. */
  ours: boolean;
  name: string | null;
  issuer: string | null;
  level: SealLevel | null;
  /** The /M time in the seal (the server's clock), and the time-stamp's time at B-T. */
  sealed_at: string | null;
  timestamp_at: string | null;
  /** Why it does not hold, in words, when it does not. */
  why: string | null;
  /** SHA-256 of the part of the file the seal covers, when that is not the whole file (it is the file as sealed). */
  sealed_part_sha256: string | null;
};

/** Finds the PAdES seals in a file (their byte ranges), last one first. */
function findSeals(bytes: Buffer): { range: [number, number, number, number]; m: string | null }[] {
  const text = bytes.toString('latin1');
  const out: { range: [number, number, number, number]; m: string | null }[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text)) && out.length < 20; ) {
    const r = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
    // The dictionary around it: from the "<<" before it to the end of its /Contents.
    const start = text.lastIndexOf('<<', m.index);
    const dict = text.slice(Math.max(0, start), Math.min(text.length, m.index + 400));
    // The dictionary runs past its /Contents (at most a few hundred kilobytes); a stranger's file is never scanned further.
    if (start < 0 || r[2] - start > 600_000 || !/\/SubFilter\s*\/ETSI\.CAdES\.detached/.test(text.slice(start, Math.min(text.length, r[2] + 400)))) continue;
    if (r[0] !== 0 || r[1] <= 0 || r[2] <= r[1] || r[2] + r[3] > bytes.length || bytes[r[1]] !== 0x3c || bytes[r[2] - 1] !== 0x3e) continue;
    out.push({ range: r, m: /\/M\s*\((D:[^)]*)\)/.exec(dict)?.[1] || null });
  }
  return out.reverse();
}

const fromPdfDate = (s: string | null): string | null => {
  const m = s && /^D:(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
};

/** Checks the last PAdES seal in a file. Null when the file carries none. Never throws for a strange file. */
export function checkSeal(input: Uint8Array): SealCheck | null {
  const bytes = Buffer.from(input);
  const found = findSeals(bytes)[0];
  if (!found) return null;
  const r = found.range;
  const base: SealCheck = { intact: false, whole_file: r[2] + r[3] === bytes.length, ours: false, name: null, issuer: null, level: null, sealed_at: fromPdfDate(found.m), timestamp_at: null, why: null, sealed_part_sha256: null };
  if (!base.whole_file) base.sealed_part_sha256 = crypto.createHash('sha256').update(bytes.subarray(0, r[2] + r[3])).digest('hex');
  try {
    const hex = bytes.subarray(r[1] + 1, r[2] - 1).toString('latin1');
    const der = Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ''), 'hex');
    const sd = parseSignedData(der.subarray(0, read(der).end));
    const s = sd.signers[0];
    if (!s) return { ...base, why: 'the seal is empty' };
    const covered = coveredBytes(bytes, r);
    const c = checkSigner(sd, s, (h) => crypto.createHash(h).update(covered).digest());
    const sha = c.cert ? certHash(c.cert.der) : null;
    const state = sealState();
    const ours = !!sha && ((state.on && state.key.hash === sha) || !!get('SELECT 1 x FROM seal_certs WHERE sha256=?', sha));
    const out: SealCheck = { ...base, intact: c.ok, ours, name: c.cert?.name || null, issuer: c.cert?.issuerName || null, why: c.ok ? null : c.why || 'it does not hold' };
    const ts = attrValue(s.unsignedAttrs, OID.signatureTimeStamp);
    out.level = c.ok ? 'B-B' : null;
    if (ts && c.ok) {
      const t = timeStampTime(Buffer.from(whole(ts)), s.signature);
      if (t) (out.level = 'B-T'), (out.timestamp_at = t);
    }
    return out;
  } catch {
    return { ...base, why: 'the seal is damaged and cannot be read' };
  }
}

// The time of a time-stamp token, when it is over this signature value and its own signature holds.
function timeStampTime(token: Buffer, signature: Buffer): string | null {
  try {
    const sd = parseSignedData(token);
    if (sd.eContentType !== OID.tstInfo || !sd.eContent || sd.signers.length !== 1) return null;
    const info = kids(read(sd.eContent));
    const mi = kids(info[2]);
    const h = hashName(readOid(kids(mi[0])[0]));
    if (!h || !readOctets(mi[1]).equals(crypto.createHash(h).update(signature).digest())) return null;
    const eContent = sd.eContent;
    if (!checkSigner(sd, sd.signers[0], (x) => crypto.createHash(x).update(eContent).digest()).ok) return null;
    return readTime(info[4]).toISOString();
  } catch {
    return null;
  }
}

// ---- Signatures already in an uploaded PDF ---------------------------------------------------

/**
 * How many signed signature fields a PDF has. The signed copy is built from flattened pages (flatPages in pdf.ts),
 * so none of those signatures survives in it: the editor and the API say so when such a file is uploaded.
 */
export async function existingSignatures(pdf: Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true });
    return doc.getForm().getFields().filter((f) => f instanceof PDFSignature && f.acroField.dict.get(PDFName.of('V'))).length;
  } catch {
    return 0;
  }
}


/**
 * What /verify says about the seal in a dropped file. When the seal holds but more was saved into the file after it,
 * `sealed_part` names the completed envelope whose signed PDF the sealed part is, byte for byte (only its ID and day,
 * as for a deleted one): whoever holds this file holds that one inside it.
 */
export function sealForVerify(bytes: Uint8Array): (SealCheck & { sealed_part: { envelope_id: string; completed_at: string | null } | null }) | null {
  const c = checkSeal(bytes);
  if (!c) return null;
  const e = c.intact && c.sealed_part_sha256 ? get("SELECT id, completed_at FROM envelopes WHERE final_sha256=? AND status='completed'", c.sealed_part_sha256) : null;
  return { ...c, sealed_part: e ? { envelope_id: e.id, completed_at: e.completed_at } : null };
}
