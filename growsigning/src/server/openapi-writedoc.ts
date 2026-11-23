// What the API description says about writing a document in the app (src/server/routes-writedoc.ts), kept apart so
// the busy openapi.ts only needs one reference to it.
import { WRITE_TEXT_MAX, WRITE_PROMPT_MAX, WRITE_CHANGE_MAX, WRITE_PAGES_MAX, WRITE_DAILY_DEFAULT, AI_DRAFT_NOTE } from '../lib/writedoc.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: any) => ({ content: { 'application/json': { schema } } });
const MARKS = `The text uses a few marks: a line that starts with "# " is a heading ("## " a smaller one), "- " a list item, "1. " a numbered item, **two stars** bold, an empty line a new paragraph. Nothing else is read: no links, no HTML, no tables, no pictures. {{signature}}, {{initials}}, {{date}}, {{name}}, {{email}}, {{company}}, {{title}}, {{checkbox}} and {{text:Label}} are places where the first signer signs or fills in; {{signature2}}, {{date2}} and so on are for the second signer, and so on. Words in [square brackets] are blanks still to fill in.`;
const STREAM = `The answer is a stream of Server-Sent Events, one JSON object each: {"open": true} first; {"d": "..."} pieces of the text as the AI writes them; {"think": true} while it thinks; then either {"done": true, "text", "title"?, "notes": [...], "cut"?} where "text" is the whole text made safe (no links, HTML, or web or email addresses that are not in what you sent; words that say the document is binding, valid or enforceable, approved by a lawyer or a court, meets the law or will hold up are taken out, and "notes" says so) and replaces what was streamed, or {"error": "sentence", "code"?} when nothing usable came (when the AI sent nothing at all, it does not count against the daily number). The "d" pieces are raw: if you stop early, send what you have to POST /write/tidy. Closing the connection stops the AI. ${AI_DRAFT_NOTE} The text you send, and nothing else of your account, goes to the AI service named by GET /write ("sent"). Only for a confirmed address, on an account whose AI switch is on (PUT /account/policy, "ai_helper"), on a server with an AI model. At most WRITE_AI_DAILY_LIMIT (default ${WRITE_DAILY_DEFAULT}) drafts and changes together for one account in a day (UTC), and the help chat's own per-minute and per-day limits too: 429 with a sentence when one is reached. A request for a document meant to deceive, or to look as if it came from a real company, a bank or a public office, is refused with 400 and "code": "deceptive" before anything is sent.`;

export const writePaths = () => ({
  '/write': {
    get: {
      summary: 'Whether the AI can write here, and to whom the text goes',
      description: 'Writing a document yourself (POST /write/render) always works. "ai" says whether POST /write/draft and /write/change can be used by this account now; only then are "model", "host", "sent" (the sentence the app shows), "left" (drafts and changes left today) and "daily" given.',
      responses: { 200: { description: 'What may be offered.', ...json({ type: 'object', properties: { ai: { type: 'boolean' }, model: { type: 'string' }, host: { type: 'string' }, sent: { type: 'string' }, left: { type: 'integer' }, daily: { type: 'integer' } } }) }, default: err },
    },
  },
  '/write/draft': {
    post: {
      summary: 'Ask the AI for a draft from a description',
      description: `${STREAM} The description is at most ${WRITE_PROMPT_MAX} characters.`,
      requestBody: { required: true, ...json({ type: 'object', required: ['prompt'], properties: { prompt: { type: 'string', maxLength: WRITE_PROMPT_MAX } } }) },
      responses: { 200: { description: 'The stream.', content: { 'text/event-stream': {} } }, default: err },
    },
  },
  '/write/change': {
    post: {
      summary: 'Ask the AI to change a text',
      description: `${STREAM} "text" is the current text (at most ${WRITE_TEXT_MAX} characters), "request" the change in words (at most ${WRITE_CHANGE_MAX}). With "selection" ({start, end} as character positions in "text") only that passage is sent and changed, and "text" in the answer is the whole text with the passage put back where it was selected.`,
      requestBody: { required: true, ...json({ type: 'object', required: ['text', 'request'], properties: { text: { type: 'string', maxLength: WRITE_TEXT_MAX }, request: { type: 'string', maxLength: WRITE_CHANGE_MAX }, selection: { type: 'object', properties: { start: { type: 'integer' }, end: { type: 'integer' } } } } }) },
      responses: { 200: { description: 'The stream.', content: { 'text/event-stream': {} } }, default: err },
    },
  },
  '/write/tidy': {
    post: {
      summary: 'Make safe what came before you stopped the AI',
      description: 'The "d" pieces of a stream are what the AI wrote, as it wrote them. After stopping early, send them here as "text", with "typed" (what you typed: the description, or the text and the request) and "kind" ("draft" or "change"): the answer is the text made safe the way a whole answer is, a "title" for a draft that started with one, and "notes". No AI is asked and nothing is counted.',
      requestBody: { required: true, ...json({ type: 'object', required: ['text'], properties: { text: { type: 'string' }, typed: { type: 'string' }, kind: { type: 'string', enum: ['draft', 'change'] } } }) },
      responses: { 200: { description: 'The text made safe.', ...json({ type: 'object', properties: { text: { type: 'string' }, title: { type: 'string' }, notes: { type: 'array', items: { type: 'string' } } } }) }, default: err },
    },
  },
  '/write/render': {
    post: {
      summary: 'Make a PDF from a written text',
      description: `${MARKS} The PDF is made on A4 or Letter ("paper"), with page numbers and our embedded fonts in every script the signed PDF prints, and stored like an upload: put "file.id" in an envelope's documents as for POST /files. "fields" are the places its tags make, with "signer" counting from 1 without gaps (a text with {{signature}} and {{signature9}} has signers 1 and 2) and x, y, w, h as fractions of the page; give each to the person who signs in that place. A text with [blanks] left is refused with 400, "code": "blanks", "blanks" (how many) and "first" (where the first one starts). "warning" names characters the PDF cannot print, or is empty. At most ${WRITE_PAGES_MAX} pages and ${WRITE_TEXT_MAX} characters; a title that reads like a well-known company is refused. "ai": true only says that part of the text came from the AI, which the sender is told on their own screens; the document and its record never say it. The text is kept with the file (GET /write/source/{file}). What everyone signs is the PDF. Once an envelope with it is sent, a new text is a correction (PUT /envelopes/{id}), with the sign-again rule, and the record says "Wording changed".`,
      requestBody: { required: true, ...json({ type: 'object', required: ['text'], properties: { title: { type: 'string' }, text: { type: 'string', maxLength: WRITE_TEXT_MAX }, paper: { type: 'string', enum: ['a4', 'letter'] }, ai: { type: 'boolean' } } }) },
      responses: { 200: { description: 'The file and its fields.', ...json({ type: 'object', properties: {
        file: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, pages: { type: 'integer' }, size: { type: 'integer' }, written: { type: 'object', properties: { ai: { type: 'boolean' } } } } },
        fields: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, signer: { type: 'integer' }, label: { type: 'string' }, required: { type: 'boolean' }, page: { type: 'integer' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } } },
        warning: { type: 'string' },
      } }) }, default: err },
    },
  },
  '/write/source/{file}': {
    parameters: [{ name: 'file', in: 'path', required: true, schema: { type: 'string' } }],
    get: {
      summary: 'The text a written document was made from',
      description: 'For a file of this account made by POST /write/render: its title, text, paper and whether the AI helped. 404 for any other file.',
      responses: { 200: { description: 'The text.', ...json({ type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' }, paper: { type: 'string' }, ai: { type: 'boolean' } } }) }, default: err },
    },
  },
});
