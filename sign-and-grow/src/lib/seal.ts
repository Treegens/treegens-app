// The digital seal of a completed PDF, in the words the certificate of completion, the Verify page, the security pages
// and the README use, so none of them says more than the code does (src/server/seal.ts and the files it names).
// Plain constants and functions on settings, so a 'use client' file may import them too.

type Env = Record<string, string | undefined>;

/** Whether the operator of this server has set a seal key (SEAL_P12 or SEAL_KEY_PEM). It may still be refused. */
export const sealSet = (env: Env = process.env) => !!(env.SEAL_P12 || env.SEAL_KEY_PEM);
/** Whether a time-stamp service is set (TSA_URL, or TSA_URLS). */
export const timeStampSet = (env: Env = process.env) => /https?:\/\//i.test(`${env.TSA_URL || ''}${env.TSA_URLS || ''}`);

export type SealLevel = 'B-B' | 'B-T';

/**
 * The line the certificate of completion prints about the seal of its own file. `level` is the one the file is
 * sealed at; `tsaFailed` when a time-stamp service was asked and none gave a time-stamp that checks out.
 */
export function sealCertificateLine(o: { name: string; issuer: string; level: SealLevel; tsaFailed?: boolean }): string {
  const time = o.level === 'B-T'
    ? `The seal carries a time-stamp from a time-stamp service, so its time does not rest on this server's clock alone. A reader shows which service.`
    : o.tsaFailed
      ? `The time-stamp service could not give a time-stamp that checks out when this file was sealed, so the time in the seal is this server's clock.`
      : `The time in the seal is this server's clock: no time-stamp service is used.`;
  return `This file carries a digital seal applied by ${o.name} (certificate issued by ${o.issuer}) when it was completed, at level PAdES ${o.level}. A reader such as Acrobat can check that the file has not changed since. It does not show who stood behind each signature: it is a seal of the server that made the file, not a signature of the people who signed. ${time}`;
}

/** What the seal is and what it shows, for the security pages and the README. */
export const SEAL_TRUTH = 'Every PDF completed from the day a seal is set up carries a digital seal: a standard PDF signature (PAdES) made with the certificate of whoever runs this server, invisible on the pages. Any PDF reader that checks signatures, such as Acrobat, can then show without asking us that not one byte of the file has changed since it was sealed, and which certificate sealed it. It is a seal of the server, not a signature of the people who signed: it does not show who stood behind each signature, and their signatures stay electronic signatures with the audit trail. We do not claim it is an advanced or a qualified seal.';

/** Why Acrobat may say "validity unknown", for the security pages. */
export const SEAL_TRUST = 'Acrobat shows such a seal as valid only when the certificate comes from an authority on the Adobe Approved Trust List or on an EU trusted list. Getting such a certificate is a purchase the operator of the server makes. With any other certificate Acrobat says the validity is unknown: that means it cannot tell whose certificate it is, not that the file was changed, and it still shows whether the file changed after the seal.';

/** The time in the seal, B-B and B-T. */
export const SEAL_TIME = 'With a time-stamp service set up, the seal also carries a time-stamp from that service (PAdES B-T), so its time does not rest on our clock alone. Without one, or when the service does not answer, the seal is PAdES B-B and its time is our server\'s clock; the certificate of completion says which.';

/** What it is not, for the "not" lists. */
export const SEAL_LIMITS = 'The seal does not carry what is needed to check it after its certificate has expired or been revoked (long-term validation), and files completed before the seal was set up are never sealed afterwards: their fingerprint is in emails people hold, and sealing them would change the file.';

/** On the first page of a copy that is not a finished agreement (voided, declined, expired, signed before a change). */
export const NOT_SEALED_LINE = 'This copy carries no digital seal: only a document everyone completed is sealed, so a PDF reader shows no seal for it.';
export const notSealedLines = (env: Env = process.env): string[] => (sealSet(env) ? [NOT_SEALED_LINE] : []);

/**
 * Said when an uploaded PDF already carries signed signature fields (existingSignatures in src/server/seal.ts). The
 * signed copy is built from the pages as they look (flatPages in src/server/pdf.ts), so those signatures do not
 * survive in it. Shown by the editor and returned by POST /files.
 */
export const signaturesLost = (n: number) =>
  `This PDF already carries ${n === 1 ? 'a digital signature' : `${n} digital signatures`}. ${n === 1 ? 'It does' : 'They do'} not survive here: the signed copy is made from the pages as they look, so in it ${n === 1 ? 'that signature is' : 'those signatures are'} only a picture and can no longer be checked. If ${n === 1 ? 'it' : 'they'} must stay checkable, keep the file as it is and do not send it for signing here.`;
