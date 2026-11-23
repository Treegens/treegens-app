// pdfSealer: the one way in to sealing a finished PDF. It makes nothing of its own; it calls the parts that exist:
//
//   sealkey.ts   which key seals: a local key file (mode local_p12: a .p12 or .pfx, or PEM files) or a cloud signing
//                service (mode csc, sealcsc.ts). Names and PDF_SIGNING_MODE: src/lib/sealenv.ts.
//   seal.ts      the PAdES signature over the whole file (sealpdf.ts writes the /ByteRange and the room for the
//                signature, sealcms.ts builds the CMS). Only a SHA-256 leaves this server in csc mode.
//   tsa.ts       the RFC 3161 time stamp over the signature value (B-T).
//   ltv.ts       the /DSS with OCSP answers and revocation lists (B-LT) and the document time stamp (B-LTA).
//
// Why not @signpdf/signpdf with @signpdf/placeholder-pdf-lib: the code named above does the same job (a placeholder,
// a /ByteRange, a detached CMS put into /Contents) and three validators that share no code with it accept its files
// (openssl, poppler's pdfsig and pyHanko, and Adobe Acrobat Reader for the time stamps). It also writes the
// long-term data (the /DSS and the document time stamp), which @signpdf does not do.
//
// The order, which nothing may change (finishPdf in finalpipe.ts runs it for every completed envelope):
//   1. the pages are flattened: signatures, form fields and text become page content (pdf.ts);
//   2. the certificate of completion is added as the last pages (pdf.ts, drawCertificate);
//   3. the file is sealed, time-stamped and given its long-term data, here.
// After step 3 the bytes are stored and never written again: every later step in ltv.ts appends to the file (an
// incremental update), which a signature allows, and nothing else touches it. tests/seal-spec.test.ts holds this.
//
// Trying again, all inside the seconds each step already has (nobody waits longer for a retry):
//   - the services in TSA_URL are asked in order; when none gave a time stamp, those that failed at once in a way
//     that passes (no connection, HTTP 429/500/502/503/504) are asked once more after 250 ms (tsa.ts);
//   - a call to the signing service is sent once more after 300 ms when it never arrived or was answered 429, 502,
//     503 or 504; a refused access token is fetched again once (sealcsc.ts);
//   - signatures/signHash, the paid step, is never sent again for the same fingerprint. When its time stamp then
//     fails, the same signature is kept and the file is sealed at B-B (seal.ts).
// Two ways in. sealPdf(buffer, context) is the whole job for one finished file (scripts, tests, any other caller) and
// throws a PdfSealError. A completed envelope goes through sealWithPlan instead, because finishPdf must draw the
// certificate page from the same plan before the file is sealed; when that fails, finishPdf names the failure with
// sealFailure (the same codes) in its log line, makes the file without a seal and tells the operators.
// One completed document is one signing, with two exceptions that are not retries: an account that asked for PDF/A
// whose file veraPDF does not pass is made and sealed again as a normal PDF, and each person's limited-view copy is a
// file of its own with a seal of its own. With a cloud seal each of those is one more paid signing.
// What happens when something still fails:
//   - no time stamp: the file is sealed at B-B, and the result says so (`timestamped` false, `timestampFailed`);
//     for a completed envelope finishPdf draws the certificate again first, so it says the same;
//   - no seal: sealPdf throws a PdfSealError. finishPdf then stores the file without a seal ("Not sealed" in the
//     history), the document still completes, and the people who run the server are told (sealkey.ts, tellOperators).
import { sealPlan, sealPdf as sealOnce, TimeStampMissing, type SealPlan, type SealDone } from './seal.ts';
import { sealState } from './sealkey.ts';
import { cscReady, cscConfigured, CscError, withoutSecrets } from './sealcsc.ts';
import { TsaError, TSA_TOTAL_MS } from './tsa.ts';
import { withLongTerm, type LongTerm } from './ltv.ts';
import { applySealEnv } from '../lib/sealenv.ts';
import { sha256 } from './util.ts';

/** Where the seal's key is: a .p12 or .pfx file, PEM files, or a cloud signing service. */
export type PdfSealMode = 'local_p12' | 'local_pem' | 'csc';
/**
 * Why a PDF was not sealed. `code`: not_configured (no seal settings), refused (settings that cannot be used: an
 * expired certificate, a missing file, a mode with nothing behind it), signing_service (the cloud service failed or
 * did not answer), failed (anything else). `message` is in plain words and never holds a secret.
 */
export class PdfSealError extends Error {
  code: 'not_configured' | 'refused' | 'signing_service' | 'failed';
  constructor(code: PdfSealError['code'], message: string, cause?: unknown) {
    super(message);
    this.name = 'PdfSealError';
    this.code = code;
    if (cause !== undefined) (this as any).cause = cause;
  }
}

/**
 * Any failure of the signing as a PdfSealError: signing_service when the cloud service failed, failed otherwise. The
 * words pass through withoutSecrets (sealcsc.ts), so no secret of the signing service is in them. sealPdf throws
 * these, and finishPdf (finalpipe.ts) names a completed envelope's failure the same way in its log line and alert.
 */
export function sealFailure(e: any): PdfSealError {
  if (e instanceof PdfSealError) return e;
  const why = withoutSecrets(String(e?.message || e)).slice(0, 300);
  return e instanceof CscError ? new PdfSealError('signing_service', `The signing service did not seal the file: ${why}`, e) : new PdfSealError('failed', `The file could not be sealed: ${why}`, e);
}

export type SealedPdf = {
  /** The sealed file. Store and serve these bytes exactly as they are. */
  bytes: Buffer;
  /** The SHA-256 of `bytes`, in hex: the post-seal fingerprint (envelopes.final_sha256 for a completed envelope). */
  sha256: string;
  mode: PdfSealMode;
  /** B-B: sealed. B-T: with a time stamp. B-LT: with the data to check it later. B-LTA: and a document time stamp. */
  level: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
  timestamped: boolean;
  /** Why no time stamp could be got, when one was asked for. */
  timestampFailed?: string;
  /** The long-term step: its level, or why it added nothing; null when there was nothing to add or it is switched off. */
  ltv: LongTerm | null;
  certificate: { name: string; issuer: string; sha256: string; selfSigned: boolean; notAfter: string };
  /** Everything the seal recorded, as finishPdf writes it to the envelope and its history. */
  done: SealDone;
};

/** Which seal the settings ask for, or null when files are not sealed. */
export function sealMode(): PdfSealMode | null {
  applySealEnv();
  if (cscConfigured()) return 'csc';
  if (process.env.SEAL_P12) return 'local_p12';
  if (process.env.SEAL_KEY_PEM || process.env.SEAL_CERT_PEM) return 'local_pem';
  return null;
}

/**
 * Seals a rendered file with a plan that was already decided, and adds the long-term data when the seal carries a
 * time stamp. finishPdf calls this, because it draws the certificate of completion from the same plan first. Throws
 * TimeStampMissing when a key file's seal could not be time-stamped (the caller draws the certificate again and seals
 * at B-B), and whatever the signing failed with otherwise. The long-term step never throws and never holds the file back.
 */
export async function sealWithPlan(pdf: Uint8Array, plan: SealPlan, when = new Date()): Promise<{ bytes: Buffer; done: SealDone }> {
  const r = await sealOnce(pdf, plan, when);
  if (r.done.level !== 'B-T') return r;
  const l = await withLongTerm(r.bytes, [plan.key.cert, ...plan.key.chain], r.done.tsaToken || null);
  return { bytes: l.bytes, done: { ...r.done, ltv: l.ltv } };
}

/**
 * Seals `pdf` as the settings say and returns the sealed bytes with their SHA-256. `pdf` must be the finished file:
 * flattened, with its certificate page. Nothing may be written into the bytes returned.
 * `context.when`: the time written into the seal (the server's clock by default). `context.timestamp` false: seal at
 * B-B without asking a time-stamp service. `context.longTerm` false: no /DSS and no document time stamp.
 */
export async function sealPdf(pdf: Uint8Array, context: { when?: Date; timestamp?: boolean; longTerm?: boolean } = {}): Promise<SealedPdf> {
  applySealEnv();
  // The certificate chain of a cloud seal is fetched first when it is not there or more than a day old.
  await cscReady();
  const mode = sealMode();
  const state = sealState();
  if (!state.on) throw new PdfSealError(state.configured ? 'refused' : 'not_configured', state.configured ? state.why || 'The seal cannot be used right now.' : 'No seal is set up. Set PDF_SIGNING_MODE and the settings of that mode (see .env.example, "PDF sealing").');
  const until = Date.now() + TSA_TOTAL_MS;
  const planFor = (noTsa?: string) => Object.assign(sealPlan(noTsa) as SealPlan, { until, tsaMs: TSA_TOTAL_MS });
  const when = context.when || new Date();
  const run = (plan: SealPlan) => (context.longTerm === false ? sealOnce(pdf, plan, when) : sealWithPlan(pdf, plan, when));
  let r: { bytes: Buffer; done: SealDone };
  try {
    try {
      r = await run(context.timestamp === false ? planFor('no time stamp was asked for') : planFor());
    } catch (e) {
      // A key file signs again for nothing: the same file sealed at B-B, with the reason kept.
      if (!(e instanceof TimeStampMissing)) throw e;
      r = await run(planFor(e.message));
    }
  } catch (e: any) {
    throw sealFailure(e);
  }
  const d = r.done;
  const key = state.key;
  const ltv = d.ltv ?? null;
  const asked = context.timestamp !== false && d.tsaFailed;
  return {
    bytes: r.bytes,
    sha256: sha256(r.bytes),
    mode: mode as PdfSealMode,
    level: ltv && 'level' in ltv ? ltv.level : d.level,
    timestamped: d.level === 'B-T',
    ...(asked ? { timestampFailed: d.tsaFailed } : {}),
    ltv,
    certificate: { name: key.cert.name, issuer: key.cert.issuerName, sha256: key.hash, selfSigned: key.chain.length === 1 && key.cert.subjectDer.equals(key.cert.issuerDer), notAfter: key.cert.notAfter.toISOString() },
    done: d,
  };
}

export { TsaError, CscError, TimeStampMissing };
