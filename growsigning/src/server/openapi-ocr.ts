// Text read by a machine from pages that are pictures (src/server/ocr.ts, src/server/routes-ocr.ts), as part of
// /api/openapi.json. Kept apart so the busy openapi.ts only needs one reference to it.
import { OCR_WARNING } from '../lib/a11y.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const str = { type: 'string' };

/** What `ocr` on a File or Document means. Absent when this server does not read text from pictures. */
export const OCR_PROP = { type: 'string', enum: ['queued', 'running', 'done', 'failed'], description: 'Only on a file with pages that have no text, on a server that reads text from pictures (OCR_CMD or OCRMYPDF_URL): where reading the text of those pages stands. When done, the words can be found by search (GET /envelopes?q=) and are shown to signers in Easy reading. The file itself is never changed. failed: tried 3 times; the pages stay without text.' };

export function ocrPaths() {
  return {
    '/sign/{token}/ocr': {
      parameters: [{ name: 'token', in: 'path', required: true, schema: str }],
      get: {
        summary: 'Text read by a machine from the pages of this signer\'s documents that are pictures',
        description: `Readable exactly when the documents are (the same link, access code, one-time code and turn as GET /sign/{token}/doc/{doc}). Lists the documents whose files have a reading job, with the text of each page that had no text of its own, by page number from 1. An empty list when this server does not read text from pictures. "warning" must be shown with the text: "${OCR_WARNING}"`,
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: {
            warning: str,
            documents: { type: 'array', items: { type: 'object', properties: { id: str, state: { type: 'string', enum: ['queued', 'running', 'done', 'failed'] }, pages: { type: 'array', items: { type: 'object', properties: { page: { type: 'integer' }, text: str } } } } } },
          } } } } },
          default: err,
        },
      },
    },
  };
}
