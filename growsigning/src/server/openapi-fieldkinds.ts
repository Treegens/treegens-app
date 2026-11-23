// More kinds of field, as part of /api/openapi.json (fieldkinds.ts, routes-fieldlib.ts): the properties a Field gets
// and the paths for saved fields. Kept apart so the main description stays readable; openapi.ts spreads them in.
import { SIZE_MIN, SIZE_MAX, DATE_ADD_MAX, LINK_MAX, SAVED_MAX, SAVED_NAME_MAX, DATE_FROM_NOTE, DRAWING_IS } from '../lib/fieldkinds.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const body = (schema: any) => ({ required: true, content: { 'application/json': { schema } } });
const s = { type: 'string' };

const look = {
  type: 'object', nullable: true,
  description: `How the field's filled-in text prints, for text, number, date, company, job title, the name fields, email, date signed, dropdown and note fields (on any other kind it is not kept). "font": "sans" (the usual one, with every script's own font), "serif" or "mono" (Typewriter); Serif and Typewriter are the standard PDF fonts and have Latin letters only, so a text with any other character prints in Sans, and a character no font of ours has gets the visible mark, as everywhere. "size": ${SIZE_MIN} to ${SIZE_MAX} points, made smaller only when the text would not fit its box; left out, it fits the box as usual. "color": "black", "blue" (dark blue) or "brand" (the account's brand colour, black when none is set). "bold": true. Left out on a new field, it starts with the account's own style (PUT /saved-fields/look); left out on a field that is already there, it keeps the style it has; null means as usual. A font, size or colour we do not have answers 400 and nothing is saved.`,
  properties: { font: { type: 'string', enum: ['sans', 'serif', 'mono'] }, size: { type: 'number', minimum: SIZE_MIN, maximum: SIZE_MAX }, color: { type: 'string', enum: ['black', 'blue', 'brand'] }, bold: { type: 'boolean' } },
};

/** The properties the newer kinds add to Field. */
export const fieldKindProps = () => ({
  link: {
    ...s, nullable: true, maxLength: LINK_MAX,
    description: 'Same answer as: fields of one recipient with the same "link" and of the same kind hold one answer. When the signer types in one, the others fill in, and the server gives every one of them the same value when the signer saves and finishes, whatever the browser sends (the one that changed wins). For text, number, date, company, job title, first and last name, checkbox and dropdown fields; on another kind, and between fields of different kinds, it answers 400. Fields of different recipients never share an answer, whatever their link.',
  },
  date_from: {
    type: 'object', nullable: true, required: ['from'],
    description: `For a field of type "date": a date worked out from another date of the same recipient, and nobody types it. "from" names a "date" field (by the id given in the same request or its stored id) or a "date_signed" field, which counts from the calendar day that person signs on (in the time zone their device reports, failing that the sender's, then UTC, as the date signed prints). "add" (-${DATE_ADD_MAX} to ${DATE_ADD_MAX}, below 0 for before) "unit" (days, weeks or months) on the Gregorian calendar; months keep the day of the month and take the month's last day when it is shorter (31 January plus 1 month is 28 or 29 February). It is never required, holds none of the sender's wording, and a value sent for it is not taken: the server works it out when the signer saves and finishes. ${DATE_FROM_NOTE} On a draft "from" may be empty or point at a field that is gone, and sending answers 400 saying which date has nothing to count from; a field of another recipient, or a date that is itself worked out, answers 400 at send too. It cannot also have a "link": that answers 400. Given back with "from" as the stored id.`,
    properties: { from: s, add: { type: 'integer', minimum: -DATE_ADD_MAX, maximum: DATE_ADD_MAX, default: 0 }, unit: { type: 'string', enum: ['days', 'weeks', 'months'], default: 'days' } },
    example: { from: 'start_date', add: 30, unit: 'days' },
  },
  look,
});

/** What the newer values of "type" mean, said once under Field. */
export const FIELD_KINDS_NOTE = `"first_name" and "last_name": filled in with the first word or the last word of the recipient's name; the signer sees it and can change it, which changes that field only, never their name. "drawing": a box the signer draws in; its value is the picture (a PNG data URL of at most 700,000 characters, anything else is not kept), printed as a picture and listed on the certificate as a drawing. ${DRAWING_IS.replace('your', 'their')} "approve" and "decline": buttons on the page for someone who signs or approves (another role answers 400); Approve does what Finish (or Approve) does, Decline opens the decline. They are never required and hold no value. A sender cannot send a value for any of these.`;

const saved = {
  type: 'object',
  properties: {
    id: { ...s, readOnly: true }, name: { ...s, maxLength: SAVED_NAME_MAX },
    field: { type: 'object', description: 'What is kept of the field: "type", "label", "required", "validation", "options", "group_name", "w", "h" and "look". Never a value, a recipient, a document or a place on a page: anything else sent is left out. "label" is text; "validation" is a string or an object of at most 2000 characters as JSON, refused with 400 when longer. A note, a strike-out, a stamp, an Approve or a Decline button cannot be saved.' },
    made_by: { ...s, readOnly: true }, made_at: { ...s, format: 'date-time', readOnly: true },
  },
};

export const fieldKindPaths = () => ({
  '/saved-fields': {
    get: { summary: 'The team\'s saved fields, and the text style new fields start with', description: `Everyone on the team, because the editor lists them under More fields. At most ${SAVED_MAX} per account.`, responses: ok({ type: 'object', properties: { saved_fields: { type: 'array', items: saved }, field_look: look, limit: { type: 'integer' }, brand_color: { ...s, nullable: true, description: 'The account\'s brand colour as #rrggbb, or null when none is set. The editor offers "Your brand colour" only when there is one.' } } }) },
    post: { summary: 'Save a field for the team (admins)', description: 'The same name again, whatever the letter case and spaces, replaces the field saved under it.', requestBody: body({ type: 'object', required: ['name', 'field'], properties: { name: { ...s, maxLength: SAVED_NAME_MAX }, field: { type: 'object' } } }), responses: ok({ type: 'object', properties: { saved_field: saved } }) },
  },
  '/saved-fields/{id}': {
    delete: { summary: 'Delete a saved field (admins)', description: 'Documents that used it keep their field. Another account\'s saved field, or one deleted already, answers 404.', parameters: [{ name: 'id', in: 'path', required: true, schema: s }], responses: ok({ type: 'object', properties: { ok: { type: 'boolean' } } }) },
  },
  '/saved-fields/look': {
    put: { summary: 'Set the text style new fields start with (admins)', description: 'Fields already placed keep theirs, so nothing that was sent changes. null: as usual.', requestBody: body({ type: 'object', properties: { field_look: look } }), responses: ok({ type: 'object', properties: { field_look: look } }) },
  },
});
