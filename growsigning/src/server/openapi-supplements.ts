// What the API description says about files given to read with a document, not signed (supplements.ts,
// routes-supplements.ts), kept apart so the busy openapi.ts only needs two references to it.
import { SUPPLEMENT_RULES } from '../lib/supplements.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const params = [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }, { name: 'doc', in: 'path', required: true, schema: { type: 'string' } }];

/** "supplemental" of a document. */
export const SUPPLEMENTAL_PROP = {
  type: 'object', nullable: true,
  description: `null (the default): a file people sign. An object: a file given to read with the document, not signed, such as a privacy notice or terms. "rule" is what Finish waits for: "none", "open" (each person must open it) or "acknowledge" (each person must tick "I have been given <name>"); the string "open" is short for {"rule": "open"}. "in_copy" (default true) puts it after the signed pages of the completed copy, behind a page "Given with this document, not signed"; false leaves it out. Either way the certificate lists it with its SHA-256 and who opened and acknowledged it, when. No field can be placed on it (400), and an envelope of such files only cannot be sent (400). Leaving it out keeps what the document has. On an envelope that is out a file cannot change between to sign and to read (400): remove it and add it again. Opened means the person's link opened or downloaded the file; it never means read. A witness has no rule to meet. A rule may change while the envelope is out: the audit trail says so, it applies to whoever has not finished, and the certificate says who finished before it was set. Copied into everything made from a template, bulk sends included.`,
  properties: { rule: { type: 'string', enum: [...SUPPLEMENT_RULES], default: 'none' }, in_copy: { type: 'boolean', default: true } },
};

export const SUPPLEMENT_PATHS = {
  '/sign/{token}/supplements/{doc}': { parameters: params,
    get: { summary: 'A file given to read (signing page)', security: [], description: 'The PDF of a file given to read with the document, for whoever holds the signing link (and its access code and one-time code, when there are any). "?download=1" sends it as a download. The first time it is fetched after the person agreed to electronic records and while they still have to finish, the audit trail gets "Opened <name>" (fetching it through GET /sign/{token}/doc/{doc} counts the same). 404 for a file to sign or one that is not on this envelope.',
      responses: { 200: { description: 'A PDF file', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, default: err } },
  },
  '/sign/{token}/supplements/{doc}/acknowledge': { parameters: params,
    post: { summary: "Tick 'I have been given' (signing page)", security: [], description: 'For a file whose rule is "acknowledge": the audit trail gets "Acknowledged receiving <name>", once. 400 before the person agreed to electronic records or for a file whose rule is not "acknowledge"; refused once the person has finished. "missing" is what Finish still waits for.',
      responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, missing: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, rule: { type: 'string' } } } } } } } } }, default: err } },
  },
};
