// The digital seal of a completed PDF, in the words the certificate of completion, the Verify page, the security pages
// and the README use, so none of them says more than the code does (src/server/seal.ts and the files it names).
// Plain constants and functions on settings, so a 'use client' file may import them too.

type Env = Record<string, string | undefined>;

/**
 * The settings of a seal made by a cloud signing service through the CSC API (SSL.com eSigner, src/server/sealcsc.ts).
 * The private key stays in that service's hardware; only a SHA-256 fingerprint is sent to it.
 */
export const CSC_SETTINGS = ['SEAL_CSC_URL', 'SEAL_CSC_TOKEN_URL', 'SEAL_CSC_CLIENT_ID', 'SEAL_CSC_CLIENT_SECRET', 'SEAL_CSC_USERNAME', 'SEAL_CSC_PASSWORD', 'SEAL_CSC_CREDENTIAL_ID', 'SEAL_CSC_TOTP_SECRET'] as const;
/** Without these three the service cannot be signed in to. The rest are optional (see .env.example). */
export const CSC_REQUIRED = ['SEAL_CSC_CLIENT_ID', 'SEAL_CSC_USERNAME', 'SEAL_CSC_PASSWORD'] as const;
export const CSC_DEFAULT_URL = 'https://cs.ssl.com/csc/v0';
export const CSC_DEFAULT_TOKEN_URL = 'https://login.ssl.com/oauth2/token';

/**
 * The cloud seal settings as read. `any`: at least one of them that names an account is set (the two addresses alone
 * do not count). `missing`: required ones that are not set, so a half set is refused and logged. `complete`: all set.
 */
export function cscSettings(env: Env = process.env): { any: boolean; missing: string[]; complete: boolean; url: string; tokenUrl: string } {
  const v = (k: string) => (env[k] || '').trim();
  const any = CSC_SETTINGS.filter((k) => k !== 'SEAL_CSC_URL' && k !== 'SEAL_CSC_TOKEN_URL').some((k) => v(k));
  const missing = any ? CSC_REQUIRED.filter((k) => !v(k)) : [];
  return { any, missing, complete: any && !missing.length, url: (v('SEAL_CSC_URL') || CSC_DEFAULT_URL).replace(/\/+$/, ''), tokenUrl: v('SEAL_CSC_TOKEN_URL') || CSC_DEFAULT_TOKEN_URL };
}

/** Whether the operator of this server has set a seal: a key file (SEAL_P12 or SEAL_KEY_PEM) or a cloud signing service (SEAL_CSC_*). It may still be refused. */
export const sealSet = (env: Env = process.env) => !!(env.SEAL_P12 || env.SEAL_KEY_PEM || cscSettings(env).any);
/** Whether a time-stamp service is set (TSA_URL, or TSA_URLS). */
export const timeStampSet = (env: Env = process.env) => /https?:\/\//i.test(`${env.TSA_URL || ''}${env.TSA_URLS || ''}`);

export type SealLevel = 'B-B' | 'B-T';

/**
 * The line the certificate of completion prints about the seal of its own file. `level` is the one the file is
 * sealed at; `tsaTrusted` when the time-stamp service's certificate is checked against the operator's list
 * (TSA_TRUST); `tsaFailed` when a time-stamp service was asked and none gave a time stamp that checks out.
 * It speaks of "the signed PDF this certificate closes", not "this file", because the certificate is also handed out
 * on its own, cut out of the signed PDF (the evidence pack), and that extract carries no seal.
 */
/**
 * `orNone`: the seal is made by a paid cloud signing (src/server/sealcsc.ts), which is not asked to sign a second time
 * when the time stamp then fails, so the certificate (drawn before the seal) says both what was asked and what happens
 * without it. True either way.
 */
export function sealCertificateLine(o: { name: string; issuer: string; level: SealLevel; tsaTrusted?: boolean; tsaFailed?: boolean; orNone?: boolean }): string {
  const time = o.level === 'B-T' && o.orNone
    ? `${o.tsaTrusted
      ? `The seal asks a time-stamp service for a trusted time stamp, so that its time does not rest on this server's clock alone.`
      : `The seal asks a time-stamp service for a time stamp, which this server checks is over this seal and within five minutes of its own clock; it was not set up to check whose service it is.`} When no service answers in time, the seal carries none and its time is this server's clock. A reader shows which it is, and which service.`
    : o.level === 'B-T'
    ? o.tsaTrusted
      ? `The seal carries a trusted time stamp from a time-stamp service, so its time does not rest on this server's clock alone. A reader shows which service.`
      : `The seal carries a time stamp from a time-stamp service. This server checked that it is over this seal and within five minutes of its own clock; it was not set up to check whose service it is. A reader shows which service.`
    : o.tsaFailed
      ? `The time-stamp service could not give a time stamp that checks out when this file was sealed, so the time in the seal is this server's clock.`
      : `The time in the seal is this server's clock: no time-stamp service is used.`;
  return `The signed PDF this certificate closes carries a digital seal applied by ${o.name} (certificate issued by ${o.issuer}) when it was completed. A PDF reader that checks signatures can show whether that file has changed since. The seal does not show who stood behind each signature: it is a seal of the server that made the file, not a signature of the people who signed. ${time}`;
}

/** What the seal is and what it shows, for the security pages and the README. */
export const SEAL_TRUTH = 'A PDF completed while a seal is set up carries a digital seal: a standard PDF signature made with the certificate of whoever runs this server, invisible on the pages. A PDF reader that checks signatures can then show, without asking us, whether the file has changed since it was sealed, and which certificate sealed it. If the seal certificate cannot be used at that moment (it has expired, for example), the file is made without a seal: its certificate of completion then says nothing about one, and its history says "Not sealed". It is a seal of the server, not a signature of the people who signed: it does not show who stood behind each signature, and their signatures stay electronic signatures with the audit trail. We do not claim it is an advanced or a qualified seal.';

/** Why Acrobat may say "validity unknown", for the security pages. */
export const SEAL_TRUST = 'Acrobat shows such a seal as valid only when the certificate comes from an authority on the Adobe Approved Trust List or on an EU trusted list. Getting such a certificate is a purchase the operator of the server makes. With one, Acrobat\'s signature bar reads "Signed and all signatures are valid". With any other certificate Acrobat says the validity is unknown: that means it cannot tell whose certificate it is, not that the file was changed, and it still shows whether the file changed after the seal.';

/**
 * How the seal is made when the operator uses a cloud signing service (SEAL_CSC_*, src/server/sealcsc.ts), for the
 * security pages: said only on a server set up that way.
 */
export const SEAL_CLOUD = 'On this server the seal is made by a cloud signing service of SSL.com (eSigner), which keeps the private key of the seal certificate in its own hardware. For each completed PDF this server sends that service only a fingerprint (a SHA-256 hash) of what the seal signs, never the document, and puts the signature it gets back into the file after checking it. When the service does not answer within a few seconds, the file is made without a seal, as when a certificate cannot be used.';

/**
 * A completed PDF without a seal, on a server with a time-stamp service (finishPdf, src/server/finalpipe.ts), for the
 * security pages. No words about a seal: it is not one.
 */
export const TIME_STAMP_ONLY = 'With a time-stamp service set up, every completed PDF also gets a time stamp from that service over the whole file. A PDF reader shows it as a document time stamp: when the file existed in this form, by that service\'s clock, and whether it changed after. It does not say who made the file. When the service does not answer within a few seconds, the file goes out without it and its history says so.';

/** The time in the seal, with and without a time-stamp service. */
export const SEAL_TIME = 'The time in the seal is our server\'s clock. With a time-stamp service set up, the seal also carries a time stamp from that service, taken only when it is over this seal and within five minutes of our clock. We call it a trusted time stamp only when the operator has also given the server the certificates that service must lead to; otherwise nobody here checked whose service answered. When no service answers within a few seconds, the file is sealed without a time stamp and stays that way; the certificate of completion says which it was. With a cloud seal, the certificate is drawn before the seal and says the seal asks for a time stamp and carries none when no service answers; the history of the document and a PDF reader say which it was.';

/** What it is not, for the "not" lists. */
export const SEAL_LIMITS = 'A seal carries what is needed to check it after its certificate has expired (long-term validation) only when a time-stamp service is set up and the certificates name where to check them; then, right after the seal, the answers of those places are added to the file, and a time stamp over the whole file after them. When one of those places does not answer within a few seconds, the file goes out without them and the page of the document says so. Those additions are made once, at completion, and never renewed over the years, because that would change the file people hold. Files completed before the seal was set up are never sealed afterwards: their fingerprint is in emails people hold, and sealing them would change the file.';

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

// The words on the screens (the envelope page, Settings) are in src/locales/en.json under "seal.".
