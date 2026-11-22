// The part of /api/openapi.json for a public form's questions (src/server/routes-webforms.ts, webforms.ts).
// openapi.ts spreads webformPaths() into its paths.
const s = { type: 'string' };
const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const slug = [{ name: 'slug', in: 'path', required: true, schema: s }];
const answers = { type: 'object', additionalProperties: s, description: 'Answers keyed by the template field id of each question ("1" or "" for a tick box or a radio button).' };
const draft = { type: 'object', nullable: true, properties: { name: s, email: s, answers, updated_at: { type: 'string', format: 'date-time' } } };

export function webformPaths() {
  return {
    '/public/powerforms/{slug}/draft': {
      get: {
        summary: 'The answers this browser keeps for a public form',
        description: 'No sign-in. A form whose open role fills in fields asks them as questions first (GET /public/powerforms/{slug} lists them under "questions"). What a browser typed is kept on the server for that browser only, found by a random id in its cookie, for as long as an unfinished start is kept (POWERFORM_IDLE_HOURS, a day; POWERFORM_SHARED_IDLE_MINUTES on a shared-device form). "draft" is null when there is none. Nothing here makes an envelope, sends an email or uses a signature. 404 for a form that is paused or gone, 503 while it cannot take people.',
        parameters: slug,
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { draft } } } } }, default: err },
      },
      put: {
        summary: 'Keep what this browser typed into a public form so far',
        description: 'Only answers to the form\'s own questions are kept, each at most 4000 characters, at most 64000 characters in all (413). One internet connection keeps at most 20 sets at a time: a new one pushes out its oldest. At most 600 saves an hour from one connection, 3000 on a shared-device form (429). "review" is the key that opens the document with exactly these answers (GET .../review?k=); the next save makes a new one.',
        parameters: slug,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: s, email: s, answers } } } } },
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { saved: { type: 'boolean' }, kept_until: { type: 'string', format: 'date-time' }, review: { type: 'string', description: 'Opens the document with these answers, until the next save.' } } } } } }, default: err },
      },
      delete: { summary: 'Forget what this browser typed into a public form', parameters: slug, responses: { 200: { description: 'OK' }, default: err } },
    },
    '/public/powerforms/{slug}/review': {
      get: {
        summary: 'The whole document with this browser\'s kept answers in it, before signing',
        description: 'A PDF of every page of the document with the answers of this browser\'s latest save (PUT .../draft, whose "review" key is k) drawn in. Without that key, or after a later save, 409 and nothing is drawn: so the next person at a shared device, or someone who typed no details, sees nothing. The foot of every page says the copy has no envelope yet and is not signed. Nothing is stored or made. The person then signs with POST /public/powerforms/{slug}/start, sending "answers": they are checked again with the same rules (a refusal names the question and says what to do, and makes nothing), read by the fake-notice filter, put into the envelope as the person\'s own answers (still theirs to change on the signing page until they finish) and noted on its history ("Form answered"). When the same browser comes back with the same name and address to a start it has not finished, that start is picked up ("resumed": true) and the answers it sends replace the earlier ones ("Form answered again"). At most 60 in 10 minutes from one connection (429).',
        parameters: [...slug, { name: 'k', in: 'query', required: true, schema: s, description: 'The "review" key of the latest save of this browser.' }],
        responses: { 200: { description: 'The PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, default: err },
      },
    },
  };
}
