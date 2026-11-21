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
import { PDFDocument, PDFSignature, PDFName, PDFDict, PDFArray, PDFNumber } from 'pdf-lib';
import { sealState, type SealKey } from './sealkey.ts';
import { tsaUrls, timeStamp, TsaError, checkToken, trustCerts, tsaTrustSet } from './tsa.ts';
import { prepareSeal, coveredBytes, fillSeal } from './sealpdf.ts';
import { buildSignedData, signatureTimeStampAttribute, parseSignedData, checkSigner, attrValue, OID } from './sealcms.ts';
import { read, whole } from './der.ts';
import { certHash } from './x509.ts';
import { get, run } from './db.ts';
import { now } from './util.ts';
import { sealCertificateLine, type SealLevel } from '../lib/seal.ts';

/** `tsaTrusted`: TSA_TRUST is set, so a time stamp is only taken from a service whose certificate leads to it. */
export type SealPlan = { key: SealKey; level: SealLevel; tsa: string[]; tsaTrusted?: boolean; tsaFailed?: string };
export type SealDone = { level: SealLevel; certHash: string; name: string; issuer: string; at: string; tsaHost?: string; tsaTime?: string; tsaTrusted?: boolean; tsaFailed?: string };

/** What the next seal is, from the settings. `noTsa` (why) seals at B-B even with a time-stamp service set. */
export function sealPlan(noTsa?: string): SealPlan | null {
  const s = sealState();
  if (!s.on) return null;
  const tsa = noTsa ? [] : tsaUrls();
  return { key: s.key, level: tsa.length ? 'B-T' : 'B-B', tsa, ...(tsa.length ? { tsaTrusted: tsaTrustSet() } : {}), ...(noTsa ? { tsaFailed: noTsa } : {}) };
}

/** The certificate's line about the seal of its own file: null unless finishPdf is sealing this one. */
export function sealLineFor(e: any): string | null {
  const p: SealPlan | undefined = e?.seal_plan;
  if (!p) return null;
  return sealCertificateLine({ name: p.key.cert.name, issuer: p.key.cert.issuerName, level: p.level, tsaTrusted: !!p.tsaTrusted, tsaFailed: !!p.tsaFailed });
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
      // The certificate was drawn saying whether the service is checked against TSA_TRUST: never seal with less.
      if (plan.tsaTrusted && !stamp.trusted) throw new TsaError('the setting TSA_TRUST was taken away while the file was being sealed');
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
      ...(st ? { tsaHost: st.host, tsaTime: st.time.toISOString(), tsaTrusted: st.trusted } : {}), ...(plan.tsaFailed ? { tsaFailed: plan.tsaFailed } : {}),
    },
  };
}

/** Writes down a certificate this server sealed with, so /verify still knows it after the key is changed. */
export function rememberSealCert(done: SealDone) {
  run('INSERT OR IGNORE INTO seal_certs (sha256, name, issuer, first_at) VALUES (?,?,?,?)', done.certHash, done.name, done.issuer, now());
}

// ---- Checking a file (/verify) ---------------------------------------------------------------
//
// A seal is only ever reported as holding when all of this is true, so a file put together by hand around a real seal
// is not vouched for (tests/seal.test.ts, "forged"):
//   - the /ByteRange is written in the same object as the /Contents value it leaves out, in bytes the seal covers;
//   - "/Contents" stands directly before the left-out part, which is nothing but "<", hex digits and ">": no other
//     byte can hide there, and after the seal's own data there are only zeros;
//   - the fingerprint in the seal is of every other byte up to the end of the range, and its signature verifies;
//   - when it claims the whole file: a PDF library reading the file finds a signature field with this very range, as
//     a PDF reader would. A seal no reader would find is not said to hold.
// Every byte outside the left-out part is then a byte that was sealed.

export type SealCheck = {
  /** The seal holds: its fingerprint matches the bytes it covers and its signature verifies with its certificate. */
  intact: boolean;
  /** It covers the whole file: nothing was saved into the file after it. */
  whole_file: boolean;
  /** It was made with a certificate this server seals with, or sealed with before. */
  ours: boolean;
  name: string | null;
  issuer: string | null;
  /** B-T when the seal carries a time-stamp token over its signature made by a time-stamping certificate. */
  level: SealLevel | null;
  /** The /M time in the seal (the clock of the server that made it; covered by the seal). */
  sealed_at: string | null;
  /**
   * The time of the seal's time stamp, only when its service's certificate leads to one in TSA_TRUST. A time stamp
   * sits outside what the seal covers, so anyone can add one to a file: one that nothing vouches for is never shown.
   */
  timestamp_at: string | null;
  /** The seal carries a time stamp this server has no way to check (no TSA_TRUST, or it does not lead there). */
  timestamp_unchecked: boolean;
  /** Why it does not hold, in words, when it does not. */
  why: string | null;
  /** SHA-256 of the part of the file the seal covers, when that is not the whole file (it is the file as sealed). */
  sealed_part_sha256: string | null;
};

type Range = [number, number, number, number];
type Found = { range: Range; m: string | null; broken: string | null };
const HEX = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

/** Finds the PAdES seals a file names (see the rules above); `broken` says why one cannot be the seal of this file. */
function findSeals(bytes: Buffer): Found[] {
  const text = bytes.toString('latin1');
  const out: Found[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text)) && out.length < 20; ) {
    const r = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as Range;
    // The object it is written in: from the "endobj" before it to the one after it, a few kilobytes on each side.
    const head = text.slice(Math.max(0, m.index - 4096), m.index);
    const from = m.index - head.length + (head.lastIndexOf('endobj') >= 0 ? head.lastIndexOf('endobj') + 6 : 0);
    const near = text.slice(from, Math.min(text.length, m.index + 4096));
    const sig = /\/SubFilter\s*\/ETSI\.CAdES\.detached/.test(near.split('endobj')[0]);
    const lined = r[0] === 0 && r[1] > 0 && r[2] > r[1] + 2 && r[2] + r[3] <= bytes.length;
    // The same object holds the left-out part: no object ends between the two, and the range itself is covered.
    const between = lined ? (m.index < r[1] ? text.slice(m.index, r[1]) : m.index >= r[2] && m.index < r[2] + r[3] ? text.slice(r[2], m.index) : null) : null;
    const same = between !== null && between.length < 8192 && !between.includes('endobj');
    // Not a seal's dictionary at all (the words in a page's text, say): nothing is said about it.
    if (!sig && !(same && /\/SubFilter\s*\/ETSI\.CAdES\.detached/.test(text.slice(r[2], Math.min(text.length, r[2] + 4096)).split('endobj')[0]))) continue;
    let broken: string | null = null;
    if (!lined || !same || bytes[r[1]] !== 0x3c || bytes[r[2] - 1] !== 0x3e || !/\/Contents\s*$/.test(text.slice(Math.max(0, r[1] - 32), r[1])))
      broken = 'the place the seal names for itself in the file is not where it is';
    else for (let i = r[1] + 1; i < r[2] - 1; i++) if (!HEX(bytes[i])) {
      broken = 'something that is not part of the seal sits in its place in the file';
      break;
    }
    const dict = lined && same ? text.slice(Math.max(from, r[1] - 4096), r[1]) + text.slice(r[2], Math.min(text.length, r[2] + 4096)).split('endobj')[0] : near;
    out.push({ range: r, m: /\/M\s*\((D:[^)]*)\)/.exec(dict)?.[1] || null, broken });
  }
  // The last one that can be a seal of this file; when none can, the last one named.
  return [...out.filter((f) => !f.broken).reverse(), ...out.filter((f) => f.broken).reverse()];
}

const fromPdfDate = (s: string | null): string | null => {
  const m = s && /^D:(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
};

// Whether a PDF library reading the file finds a signed signature field with exactly this byte range.
async function readerFinds(bytes: Buffer, r: Range): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    for (const f of doc.getForm().getFields()) {
      if (!(f instanceof PDFSignature)) continue;
      const v = f.acroField.dict.lookup(PDFName.of('V'));
      const br = v instanceof PDFDict ? v.lookup(PDFName.of('ByteRange')) : null;
      if (!(br instanceof PDFArray) || br.size() !== 4) continue;
      if (br.asArray().every((x, i) => x instanceof PDFNumber && x.asNumber() === r[i])) return true;
    }
  } catch {
    // a file the library cannot read is one a reader would not show a seal for
  }
  return false;
}

/** Checks the last PAdES seal in a file. Null when the file carries none. Never throws for a strange file. */
export async function checkSeal(input: Uint8Array): Promise<SealCheck | null> {
  const bytes = Buffer.from(input);
  const found = findSeals(bytes)[0];
  if (!found) return null;
  const r = found.range;
  const base: SealCheck = { intact: false, whole_file: !found.broken && r[2] + r[3] === bytes.length, ours: false, name: null, issuer: null, level: null, sealed_at: found.broken ? null : fromPdfDate(found.m), timestamp_at: null, timestamp_unchecked: false, why: null, sealed_part_sha256: null };
  if (found.broken) return { ...base, why: found.broken };
  try {
    const der = Buffer.from(bytes.subarray(r[1] + 1, r[2] - 1).toString('latin1'), 'hex');
    const end = read(der).end;
    if (der.subarray(end).some((b) => b !== 0)) return { ...base, why: 'something that is not part of the seal sits in its place in the file' };
    const sd = parseSignedData(der.subarray(0, end));
    const s = sd.signers[0];
    if (!s || sd.signers.length !== 1) return { ...base, why: 'the seal is empty' };
    const covered = coveredBytes(bytes, r);
    const c = checkSigner(sd, s, (h) => crypto.createHash(h).update(covered).digest());
    const sha = c.cert ? certHash(c.cert.der) : null;
    const state = sealState();
    const ours = !!sha && ((state.on && state.key.hash === sha) || !!get('SELECT 1 x FROM seal_certs WHERE sha256=?', sha));
    const out: SealCheck = { ...base, intact: c.ok, ours, name: c.cert?.name || null, issuer: c.cert?.issuerName || null, why: c.ok ? null : c.why || 'it does not hold' };
    if (!c.ok) return out;
    if (out.whole_file && !(await readerFinds(bytes, r))) return { ...out, intact: false, why: 'a PDF reader would not find this seal in the file, so the file is not the one that was sealed' };
    if (!out.whole_file) out.sealed_part_sha256 = crypto.createHash('sha256').update(bytes.subarray(0, r[2] + r[3])).digest('hex');
    out.level = 'B-B';
    const ts = attrValue(s.unsignedAttrs, OID.signatureTimeStamp);
    if (ts) {
      const t = timeStampOf(Buffer.from(whole(ts)), s.signature);
      if (t) (out.level = 'B-T'), (out.timestamp_at = t.trusted ? t.time : null), (out.timestamp_unchecked = !t.trusted);
      else out.timestamp_unchecked = true;
    }
    return out;
  } catch {
    return { ...base, why: 'the seal is damaged and cannot be read' };
  }
}

// The time stamp in a seal: over this signature value, made by a time-stamping certificate that was valid at its
// time. `trusted` only when TSA_TRUST is set and the certificate leads to it; nothing else vouches for a token that
// anyone could have added to the file.
function timeStampOf(token: Buffer, signature: Buffer): { time: string; trusted: boolean } | null {
  const over = (h: string) => crypto.createHash(h).update(signature).digest();
  let trust: ReturnType<typeof trustCerts> = null;
  try {
    trust = trustCerts();
  } catch {
    trust = null;
  }
  if (trust) {
    try {
      return { time: checkToken(token, over, trust).time.toISOString(), trusted: true };
    } catch {
      // not under TSA_TRUST: looked at below as one nobody vouches for
    }
  }
  try {
    return { time: checkToken(token, over, null).time.toISOString(), trusted: false };
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
export async function sealForVerify(bytes: Uint8Array): Promise<(SealCheck & { sealed_part: { envelope_id: string; completed_at: string | null } | null }) | null> {
  const c = await checkSeal(bytes);
  if (!c) return null;
  const e = c.intact && c.sealed_part_sha256 ? get("SELECT id, completed_at FROM envelopes WHERE final_sha256=? AND status='completed'", c.sealed_part_sha256) : null;
  return { ...c, sealed_part: e ? { envelope_id: e.id, completed_at: e.completed_at } : null };
}

// ---- What the screens say (the envelope page, Settings) ---------------------------------------

/** The seal of a completed envelope's stored file, for the envelope page. Null for a file without one. */
export function sealFacts(e: any): { by: string; issuer: string | null; time_stamp: boolean; time_stamp_trusted: boolean } | null {
  if (!e?.seal_level || !e.seal_cert || !e.final_sha256) return null;
  const c = get('SELECT name, issuer FROM seal_certs WHERE sha256=?', e.seal_cert);
  if (!c?.name) return null;
  return { by: c.name, issuer: c.issuer || null, time_stamp: e.seal_level === 'B-T', time_stamp_trusted: e.seal_level === 'B-T' && e.seal_tsa === 'trusted' };
}

/**
 * The status line for an account's admins (Settings, Records and data). `set` false: this server has no seal
 * settings, and the screen shows nothing. `on` false with `set`: the seal is not being applied right now; the reason
 * goes to the people who run the server (sealkey.ts), not to every account, because it can name files on the server.
 */
export function sealStatus(): { set: false } | { set: true; on: false } | { set: true; on: true; by: string; issuer: string; time_stamp: boolean; time_stamp_trusted: boolean; until: string } {
  const s = sealState();
  if (!s.on) return s.configured ? { set: true, on: false } : { set: false };
  const c = s.key.cert;
  return { set: true, on: true, by: c.name, issuer: c.issuerName, time_stamp: tsaUrls().length > 0, time_stamp_trusted: tsaUrls().length > 0 && tsaTrustSet(), until: c.notAfter.toISOString() };
}
