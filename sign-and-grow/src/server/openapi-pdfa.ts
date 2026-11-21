// Archive format (PDF/A), as part of /api/openapi.json (routes-pdfa.ts, pdfa.ts). openapi.ts spreads it into its paths.
const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const state = { type: 'object', properties: { available: { type: 'boolean', description: 'Whether this server can make PDF/A files: true once its operator set VERAPDF_CMD (veraPDF, which needs Java). The Settings card is shown only then.' }, on: { type: 'boolean', description: 'The account\'s switch "Make completed files PDF/A". Off by default.' } } };

export const PDFA_WHAT = 'With the switch on, every document the account completes from then on is made as PDF/A-2b (an archive format some archives require): XMP metadata with pdfaid:part 2 and conformance B, an sRGB output intent, a document ID, no JavaScript and no actions that PDF/A forbids, every annotation printable, then sealed when the server seals. veraPDF then checks the stored file itself. Only when it passes is the file called PDF/A: the certificate of completion says "Archive format: PDF/A-2b, checked with veraPDF <version>". Otherwise the document is made as a normal PDF and the certificate says "Archive format: not PDF/A (<why>)": an uploaded file with a font that is not inside it, colours for a printing press, sound, video, 3D or an attached file, or a check that failed, took longer than VERAPDF_TIMEOUT_MS or could not run. The document always completes. Documents completed earlier stay as they are. GET /envelopes/{id} answers with "archive_format".';

export function pdfaPaths() {
  return {
    '/account/pdfa': {
      get: { summary: 'Archive format (PDF/A): whether the server can make it, and the account\'s switch (admins)', description: PDFA_WHAT, responses: ok(state) },
      put: {
        summary: 'Switch the archive format (PDF/A) on or off (admins signed in to the app)',
        description: `${PDFA_WHAT} An API key cannot change it (403). Switching it on is refused with 409 while the server has no checker set up.`,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['on'], properties: { on: { type: 'boolean' } } } } } },
        responses: ok(state),
      },
    },
  };
}

/** The "archive_format" of GET /envelopes/{id}. */
export const archiveFormatSchema = {
  type: 'object',
  nullable: true,
  description: 'null unless the account had "Archive format (PDF/A)" on when the document completed. { pdfa: true, checker: "veraPDF 1.28.2" }: veraPDF passed the stored file as PDF/A-2b. { pdfa: false, why }: the file was made as a normal PDF, and "why" says why in a few words, as the certificate of completion does.',
  properties: { pdfa: { type: 'boolean' }, checker: { type: 'string' }, why: { type: 'string' } },
};
