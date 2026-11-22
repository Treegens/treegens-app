// What the API description says about AI help when sending and signing (src/server/routes-aiassist.ts), kept apart so
// the busy openapi.ts only needs one reference to it.
import { AI_ASSIST_DAILY_DEFAULT, SUGGEST_TYPES, SUGGEST_PAGES_MAX, SUGGEST_CHARS_MAX, GRID, SUMMARY_WARNING, READ_SWITCH } from '../lib/aiassist.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: any) => ({ content: { 'application/json': { schema } } });
const obj = (properties: any, required?: string[]) => ({ type: 'object', ...(required ? { required } : {}), properties });
const s = { type: 'string' }, b = { type: 'boolean' }, i = { type: 'integer' }, n = { type: 'number' };
const GATE = `Only on a server with an AI model (the help chat's), on an account whose AI switch is on (PUT /account/policy, "ai_helper"); 403 with "code": "ai_off" otherwise, and nothing is sent anywhere. At most AI_ASSIST_DAILY_LIMIT (default ${AI_ASSIST_DAILY_DEFAULT}) suggestions, drafts and summaries together for one account in a day (UTC), and the help chat's own limits too: 429 with a sentence. When the model does not answer: 503 with "code": "model_down" and a sentence, and the ask is not counted.`;

export const aiAssistPaths = () => ({
  '/ai/assist': {
    get: {
      summary: 'What AI help this account has, and where the text goes',
      description: `"available": a model answers for this account. "read": "${READ_SWITCH}" is on. "draft" needs "available"; "fields" and "summary" need "read" too. Only with "available" are "model", "host", "provider", "country" (null when the operator did not say), "where" (the sentence Settings shows), "left" and "daily" given.`,
      responses: { 200: { description: 'What may be offered.', ...json(obj({ available: b, read: b, draft: b, fields: b, summary: b, model: s, host: s, provider: s, country: { type: 'string', nullable: true }, where: s, left: i, daily: i })) }, default: err },
    },
  },
  '/account/ai-read': {
    put: {
      summary: `Switch "${READ_SWITCH}" on or off`,
      description: 'Owners and admins, signed in to the app; an API key gets 403. Off by default. 409 for "on" when no model answers for this account. A change is written to the security record as "settings.changed" ("ai_reads_document_text"). Turning it off also turns Key dates off ("ai_key_dates" in the same record line, and "key_dates_stopped": true in the answer), so its reminders stop; turning it on again never brings Key dates back by itself. Answers like GET /ai/assist.',
      requestBody: { required: true, ...json(obj({ read: { type: 'string', enum: ['on', 'off'] } }, ['read'])) },
      responses: { 200: { description: 'What it is now.', ...json({ type: 'object' }) }, default: err },
    },
  },
  '/ai/fields': {
    post: {
      summary: 'Fields suggested for pages where nothing was found',
      description: `Needs "read". Send the text of each page with where each piece sits (never a picture): "pages" is a list of {doc, page (from 0), w, h (the page size in its own units), items: [{str, x, y (the baseline from the top), w, h}], taken?: [{x, y, w, h} as fractions of the page: fields already there]}. At most ${SUGGEST_PAGES_MAX} pages and ${SUGGEST_CHARS_MAX} characters are read. The model sees each line with its box in units of 0 to ${GRID}. Every suggestion is checked before it is answered: one of ${SUGGEST_TYPES.join(', ')}, on a page that was sent, inside it, a sensible size, a signer from 1 to "signers", and not on top of a field in "taken" or another suggestion; the rest are dropped. Nothing is placed: the answer is a list for the sender to add from. ${GATE}`,
      requestBody: { required: true, ...json(obj({ signers: i, pages: { type: 'array', items: { type: 'object' } } }, ['pages'])) },
      responses: { 200: { description: 'The suggestions, as fractions of the page.', ...json(obj({ pages: i, suggestions: { type: 'array', items: obj({ doc: s, page: i, type: { type: 'string', enum: [...SUGGEST_TYPES] }, x: n, y: n, w: n, h: n, signer: i, label: s }) } })) }, default: err },
    },
  },
  '/ai/draft': {
    post: {
      summary: 'A subject and a message to edit before sending',
      description: `Written from "documents" (their names) and "people" ({name, role}), and, only with "read" on and an "envelope_id" you may open, the start of its text ("read": true in the answer says it was used). No links, no claims that the document is binding or valid, and no sentence with a phone number, an email address or a request for payment or account details. A draft that looks like a fake bill or notice from a company (a brand, money and a phone number) is refused with 422 and "code": "fake_notice", and the ask is not counted. Nothing is sent or saved: the app puts it in the boxes for the sender to change. ${GATE}`,
      requestBody: { required: true, ...json(obj({ envelope_id: s, documents: { type: 'array', items: s }, people: { type: 'array', items: obj({ name: s, role: s }) } }, ['documents'])) },
      responses: { 200: { description: 'The draft.', ...json(obj({ subject: s, message: s, read: b })) }, default: err },
    },
  },
  '/envelopes/{id}/ai-summary': {
    get: {
      summary: 'Whether signers of this envelope are offered a plain summary',
      parameters: [{ name: 'id', in: 'path', required: true, schema: s }],
      responses: { 200: { description: '"on": the sender switched it on; "may": the account lets the AI read document text.', ...json(obj({ on: b, may: b })) }, default: err },
    },
    put: {
      summary: 'Offer signers a plain summary, or stop offering it',
      description: 'Needs "read" to switch on (403, "code": "read_off"). Not for templates, and not once the envelope is closed (409). Signers then see a link above the document; the summary is written the first time someone opens it.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: s }],
      requestBody: { required: true, ...json(obj({ on: b }, ['on'])) },
      responses: { 200: { description: 'What it is now.', ...json(obj({ on: b, may: b })) }, default: err },
    },
  },
  '/sign/{token}/summary': {
    post: {
      summary: 'The plain summary of each file, for the person signing',
      description: `Readable exactly when the documents are (the same link, access code, one-time code and turn as GET /sign/{token}/doc/{doc}); 404 when the sender did not switch it on or the account no longer lets the AI read; 409 with "code": "finished" once this person finished or the envelope is completed, so the audit line always comes before a signature. Lines with a phone number, an email address or a request for payment or account details are left out. Written once per file and kept with it; a second person or a second look costs nothing. "warning" is always "${SUMMARY_WARNING}" and goes with the text on every screen. "text" is null for a file with no readable text ("none": true) or when it could not be written now ("note" says so). The first time a person is shown one, the audit trail says a summary the sender offered was shown and that it is not part of what was signed. It never changes what is signed.`,
      security: [],
      parameters: [{ name: 'token', in: 'path', required: true, schema: s }],
      responses: { 200: { description: 'The summaries.', ...json(obj({ warning: s, note: s, documents: { type: 'array', items: obj({ id: s, name: s, text: { type: 'string', nullable: true }, none: b }) } })) }, default: err },
    },
  },
});
