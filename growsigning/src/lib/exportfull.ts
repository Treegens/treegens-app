import { dayText } from './dates.ts';

// The full export and bringing documents in (src/server/exportfull.ts, importer.ts, importer-docusign.ts). The
// numbers and words that the Settings card, the record page, /verify and the server share.

/** The version of docs/schema/growsigning-export-v1.schema.json that a full export is written in. */
export const EXPORT_SCHEMA_VERSION = 1;
/** Where the schema is served, under the app's own address. */
export const EXPORT_SCHEMA_PATH = '/api/public/export-schema/v1';
/** How long the link to an export made in the background works. */
export const EXPORT_LINK_DAYS = 7;
/** Above this many envelopes, or this many bytes of files, GET /export/full answers 202 and emails a link instead. */
export const EXPORT_DIRECT_MAX_ENVELOPES = 300;
export const EXPORT_DIRECT_MAX_BYTES = 200_000_000;
/** The largest upload that can be brought in at once, in bytes. */
export const IMPORT_MAX_BYTES = 300_000_000;
/** At most this many full exports an account can download straight away in an hour (each one builds every record for disputes again). */
export const EXPORTS_DIRECT_PER_HOUR = 10;
/** At most this many imports of each kind an account can start in an hour. */
export const IMPORTS_PER_HOUR = 10;

const dayWords = (iso: string | null | undefined): string => dayText(iso);

/** The banner on a record brought in from DocuSign, word for word as the brief has it. */
export const docusignBanner = (at: string): string =>
  `Imported from DocuSign on ${dayWords(at)}. Signed there, not here. Its evidence is DocuSign's certificate inside the file.`;

/**
 * The mark on anything brought in from a GrowSigning export. Where the export came from is only what the file says:
 * its data.json names the server, and nothing in the file proves it (anyone with the file can change it and work the
 * chain out again), so the mark says "says".
 */
export const exportBanner = (from: string, at: string, chainOk: boolean | null): string =>
  `Imported on ${dayWords(at)} from an export that says it was made on ${from}; chain ${chainOk ? 'verified' : 'not verified'}.`;

/**
 * The mark on a record that the exporting account had itself brought in (from DocuSign, or from another export) and
 * that now moves here with its export. Made here from a fixed form: no word of the banner it had comes along, because
 * the file could say anything.
 */
export const carriedBanner = (source: 'growsigning' | 'docusign', from: string, at: string, chainOk: boolean | null): string =>
  source === 'docusign'
    ? `Imported on ${dayWords(at)} from an export that says it was made on ${from}, where it had been brought in from DocuSign. It was not signed here. Its evidence, if any, is DocuSign's certificate inside the file.`
    : `Imported on ${dayWords(at)} from an export that says it was made on ${from}, where it had been brought in from another export; chain ${chainOk ? 'verified' : 'not verified'}.`;

/** What "chain verified" means, and what it does not, for the record page and the README of an export. */
export const CHAIN_MEANS = 'Chain verified means the history and the files inside the export agree with each other: each line of the history leads to the next, and the signed PDF is the one the export names for it. It does not show where the export came from or that it is genuine: anyone who had the file could change it and work the chain out again. This server did not see the document being signed. To check the signed PDF itself, use the check page of the server it was signed on.';

/** What a record brought in is and is not, said under the banner. */
export const IMPORTED_IS_NOT = 'It is kept here as an archived record you can open and download. It was not signed on this server: nobody can sign it again here, it is not counted in reports or plans, and this server\'s check page never calls it completed here.';

/**
 * What /verify says about a file that matches nothing completed here but that an account uploaded as a record. Only
 * that it was uploaded, what the upload said it was, and when: nothing in it was checked by this server.
 */
export function verifyImportedWords(imp: { source: string; from: string | null; imported_at: string }): { title: string; text: string } {
  if (imp.source === 'docusign')
    return { title: 'Uploaded here as a document from DocuSign', text: `An account here uploaded this exact file on ${dayWords(imp.imported_at)} as a document signed on DocuSign. It was not signed on this server, and this server did not check whether or how it was signed. The only evidence is DocuSign's certificate inside the file, if it has one: check it with DocuSign.` };
  return { title: 'Uploaded here inside an export', text: `An account here uploaded this exact file on ${dayWords(imp.imported_at)}, inside an export that says it was made on ${imp.from || 'another GrowSigning server'}. It was not signed on this server, and this server cannot tell whether that export is genuine. To check the file, use the check page of the server it was signed on.` };
}

/** What a person reads first after bringing something in (Settings, Records and data). */
export type ImportReport = { imported: Record<string, number>; not_imported: { what: string; name: string; why: string }[]; refused_out_for_signature: { subject: string }[] };
const WORDS: Record<string, [string, string]> = {
  archived_records: ['archived document', 'archived documents'], templates: ['template', 'templates'], drafts: ['draft', 'drafts'],
  contacts: ['contact', 'contacts'], signing_groups: ['signing group', 'signing groups'],
};
/** Whether every thing that was not brought in was left out only because it is here already. */
export const onlyRepeats = (r: ImportReport) => r.not_imported.every((n) => /here already|brought in before/.test(n.why));
export const importSaid = (r: ImportReport) => {
  const parts = Object.entries(r.imported).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${(WORDS[k] || [k, k])[n === 1 ? 0 : 1]}`);
  if (parts.length) return `Brought in: ${parts.join(', ')}.`;
  if (r.refused_out_for_signature.length || !onlyRepeats(r)) return 'Nothing was brought in. The list below says why for each file.';
  return 'Nothing new was brought in: everything in it is here already.';
};
