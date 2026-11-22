// What the API description says about fields placed by text, signing inside a website and the sender screen
// (src/server/anchors.ts, src/server/embed.ts, src/server/routes-embed.ts), kept apart so openapi.ts only needs a
// few references to it.
import { ANCHOR_TEXT_MAX, ANCHOR_PLACED_MAX, ANCHOR_OFFSET_MAX, ANCHOR_FIELDS_MAX } from '../lib/anchors.ts';
import { EMBED_ORIGINS_MAX, SENDER_VIEW_MINUTES, SENDER_SESSION_MINUTES } from '../lib/embed.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: any) => ({ content: { 'application/json': { schema } } });
const str = { type: 'string' };
const idParam = { name: 'id', in: 'path', required: true, schema: str };
const origins = json({ type: 'object', properties: { origins: { type: 'array', items: str }, max: { type: 'integer', example: EMBED_ORIGINS_MAX }, not_used: { type: 'array', items: str, description: 'Websites on this computer (http://localhost) listed earlier, or on a copy of the database, that do nothing on a server that is not on localhost: they are not counted and never frame a page. Remove them with DELETE.' } } });

/** Field.anchor: a field placed where a piece of text is written. */
export const anchorProp = () => ({
  type: 'object', required: ['text'],
  description: `Instead of "page", "x" and "y": the field goes where this text is written in the documents, found the way the editor's "Find fields" reads them. Only for POST /envelopes and PUT /envelopes/{id}. The field's top left corner is the top left of the text, moved by offset_x and offset_y points (1/72 inch; right and down are positive). "w" and "h" (fractions of the page) are kept when given, otherwise the field gets a usual size for its type. Letter case and runs of spaces do not matter; the text has to be on one line. With "document_id" only that document is looked in, otherwise all of them, in order. Text that is not found places no field and is named in the answer's "anchors.not_found"; with "send": true nothing is sent then (400, "code": "anchor_not_found"). A scanned page has no text to find. At most ${ANCHOR_PLACED_MAX} fields per request by anchors and tags together, and at most ${ANCHOR_FIELDS_MAX} fields with an anchor (400, "code": "too_many_anchors", before any document is read). Not with "template_id" on POST /envelopes: that is refused with 400, "code": "anchors_with_template"; make the copy, then use PUT /envelopes/{id}.`,
  properties: {
    text: { type: 'string', maxLength: ANCHOR_TEXT_MAX },
    occurrence: { oneOf: [{ type: 'string', enum: ['all'] }, { type: 'integer', minimum: 1 }], default: 'all', description: '"all" places a copy at every place the text is found (their ids get _2, _3 ...), a number only at that place, counted in reading order over the documents.' },
    offset_x: { type: 'number', minimum: -ANCHOR_OFFSET_MAX, maximum: ANCHOR_OFFSET_MAX, default: 0 },
    offset_y: { type: 'number', minimum: -ANCHOR_OFFSET_MAX, maximum: ANCHOR_OFFSET_MAX, default: 0 },
    units: { type: 'string', enum: ['pt'], default: 'pt' },
  },
  example: { text: 'Signature of the client:', offset_x: 0, offset_y: 18 },
});

/** EnvelopeInput.auto_tags. */
export const autoTagsProp = () => ({
  type: 'boolean', default: false,
  description: 'Turns every tag written in the documents into a field: {{signature}}, {{initials}}, {{date}}, {{name}}, {{email}}, {{company}}, {{title}}, {{checkbox}} and {{text:Label}} for the first person who signs (role signer or inperson, in routing_order, then in the order of "recipients"), {{signature2}} and so on for the second. A tag under a field that is already there gets none. The tag text stays in the document under the field: write it in white or very small type if it should not show. Tags for a person the request does not have are named in "anchors.not_found". Only for POST /envelopes and PUT /envelopes/{id}.',
});

/** The answer's "anchors". */
export const anchorsAnswer = () => ({
  type: 'object', description: 'Only when the request used "anchor" or "auto_tags": what was placed and what was not found.',
  properties: {
    placed: { type: 'array', items: { type: 'object', properties: { id: str, type: str, document_id: str, page: { type: 'integer' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, by: { type: 'string', enum: ['anchor', 'tag'] }, text: str, recipient_id: str } } },
    not_found: { type: 'array', items: { type: 'object', properties: { text: str, document_id: str, why: str } } },
  },
});

export const embedPaths = () => ({
  '/account/embed-origins': {
    get: { summary: 'The websites that may show your signing pages and sender screen in a frame', description: `Admins. Up to ${EMBED_ORIGINS_MAX} https websites, written as the browser compares them ("https://portal.example.org").`, responses: { 200: { description: 'The list.', ...origins }, default: err } },
    post: { summary: 'Add a website', description: `Admins. Only https, and only the website itself: no page, no star, no name or password. Without a scheme the address is taken as https://, and a page address is cut to its website. http://localhost and http://127.0.0.1 are taken only when this server itself runs on localhost, for trying it out. Adding one that is listed changes nothing. A sixth is refused with 400. Written to the security record.`, requestBody: { required: true, ...json({ type: 'object', required: ['origin'], properties: { origin: str } }) }, responses: { 200: { description: 'The list.', ...origins }, default: err } },
    delete: { summary: 'Remove a website', description: 'Admins. From that moment no signing page or sender screen can be shown in a frame on it, also for links handed out before.', parameters: [{ name: 'origin', in: 'query', required: true, schema: str }], responses: { 200: { description: 'The list.', ...origins }, default: err } },
  },
  '/envelopes/{id}/sender-view': {
    post: {
      summary: 'A link to the editor of one draft, for a frame in your app',
      description: `The link opens once, within ${SENDER_VIEW_MINUTES} minutes, and shows the editor of this draft without our menus. It acts as the person the draft belongs to. Once open it works for ${SENDER_SESSION_MINUTES} minutes, for this draft alone; it ends on the server when the draft is sent from it or the screen is closed, and its token is refused (401) after that. Besides its draft's own files it reads back only files it uploaded itself. Then the page tells the website around it {source: "growsigning", event: "sent" | "closed", envelope_id} with postMessage, to that website only, and goes to return_url with ?event=sent or ?event=closed. "return_url" has to be on one of the account's websites (GET /account/embed-origins), and only that website may frame the screen. A draft that has gone out answers 409. "Sign now" is not offered on this screen.`,
      parameters: [idParam],
      requestBody: { required: true, ...json({ type: 'object', required: ['return_url'], properties: { return_url: { type: 'string', format: 'uri' }, frame_origin: { ...str, description: 'Optional: the website that shows the screen. It has to be the website of return_url.' } } }) },
      responses: { 200: { description: 'The link.', ...json({ type: 'object', properties: { url: { type: 'string', format: 'uri' }, expires_at: { type: 'string', format: 'date-time' } } }) }, default: err },
    },
  },
  '/embed/sender/open': {
    post: { summary: 'Used by the sender screen itself when it opens', description: 'The page sends the secret of its link once and gets back the token it uses from then on. A second opening, or one after the minutes are over, answers 410 with "code": "sender_view_used". You do not need to call this.', security: [], requestBody: { required: true, ...json({ type: 'object', required: ['ticket'], properties: { ticket: str } }) }, responses: { 200: { description: 'The session of the screen.', ...json({ type: 'object', properties: { session: str, envelope_id: str, origin: str, return_url: str, expires_at: str } }) }, default: err } },
  },
  '/embed/sender/close': {
    post: { summary: 'Used by the sender screen itself when it is closed or the draft was sent', description: 'Ends the screen\'s session. Only with the screen\'s own token.', responses: { 200: { description: 'Where the screen goes back to.', ...json({ type: 'object', properties: { return_url: str, origin: str, event: { type: 'string', enum: ['sent', 'closed'] } } }) }, default: err } },
  },
});
