// The part of /api/openapi.json for POST /sign/{token}/view (src/server/routes-readview.ts). openapi.ts spreads
// readViewPaths() into its paths.
const s = { type: 'string' };
const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };

export function readViewPaths() {
  return {
    '/sign/{token}/view': {
      post: {
        summary: 'The signing page says which way the document is shown: the pages, or Easy reading',
        description: 'For the signing page. Authorised by the signing link, after the access code and the one-time code when the sender set them (401 until then, and nothing is recorded). "view" is "page" (the pages of the document, which is what is signed) or "easy" (Easy reading: the words in one column with the person\'s fields in place, a reading aid on the screen only). Anything else answers 400 and records nothing. The signing page sends it once that view is on the screen (the pages drawn, or the words of Easy reading read). The first time each view is used it is kept on the person and written to the audit trail ("Opened the document as pages", "Opened the document in Easy reading"); asking again records nothing more ("first": false). The certificate has one line, "Read as", saying which views the person used. Nothing is recorded ("saved": false, with "why") for the member of a signing group ("group"), for someone who has finished ("finished": the certificate keeps what they used up to signing), for someone whose turn has not come ("not_yet"), or on a document that is no longer out for signing ("closed"). At most 60 requests an hour for one person from one connection (429).',
        parameters: [{ name: 'token', in: 'path', required: true, schema: s }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['view'], properties: { view: { type: 'string', enum: ['page', 'easy'] } } } } } },
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, saved: { type: 'boolean' }, first: { type: 'boolean' }, why: { type: 'string', enum: ['group', 'finished', 'not_yet', 'closed'] } } } } } }, default: err },
      },
    },
  };
}
