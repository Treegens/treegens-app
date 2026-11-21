// Custom fields, as part of /api/openapi.json (routes-customfields.ts, customfields.ts). Kept apart so the main
// description stays readable; openapi.ts spreads the paths in and puts the properties on Envelope, Document, the
// list and WebhookEvent.
import { MAX_CUSTOM_FIELDS, CUSTOM_NAME_MAX, CUSTOM_VALUE_MAX, CUSTOM_CHOICES_MAX, DOC_FIELDS_MAX, CERT_HEADING } from '../lib/customfields.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const body = (schema: any) => ({ required: true, content: { 'application/json': { schema } } });
const s = { type: 'string' };
const idParam = { name: 'id', in: 'path', required: true, schema: s };

const def = {
  type: 'object',
  properties: {
    id: { ...s, readOnly: true }, name: { ...s, maxLength: CUSTOM_NAME_MAX, description: 'One line. Unique in the account, whatever the letter case, the width of its characters and the spaces around it.' },
    kind: { type: 'string', enum: ['text', 'list'], default: 'text', description: `"text": any one line of up to ${CUSTOM_VALUE_MAX} characters. "list": one of "choices".` },
    choices: { type: 'array', items: { ...s, maxLength: CUSTOM_VALUE_MAX }, maxItems: CUSTOM_CHOICES_MAX, description: 'For a list only. Each once, whatever the letter case.' },
    required: { type: 'boolean', default: false, description: 'An envelope without a value is not sent (400, saying which). A public form needs the value in its template, and a bulk send in each row or the template, before anything is sent.' },
    on_certificate: { type: 'boolean', default: true, description: `Printed on the certificate of completion under "${CERT_HEADING}". Everyone on the envelope gets the certificate with their copy. Never shown on the signing page either way.` },
  },
};
const answer = { type: 'object', properties: { field: def, notes: { type: 'array', items: s, description: 'What the change means for public forms and drafts, in words: a form whose template has no value for a field that is now required, drafts whose value is not one of the choices now.' } } };

/** "custom_fields" on EnvelopeInput: the account's own fields with their values. */
export const customFieldsProp = () => ({
  type: 'array',
  description: `The account's custom fields (GET /custom-fields) with their values. On POST and PUT the list replaces what there was, like "recipients"; left out, the values stay. With "template_id" the template's values are the start, and the names given here are set or emptied. A name the account has no field for, a value over ${CUSTOM_VALUE_MAX} characters, more than one line, or not one of a list's choices answers 400 and nothing is saved. A value a draft already holds is kept as it is when its field changed since. On an envelope that is out use PUT /envelopes/{id}/custom-fields. Never shown on the signing page.`,
  items: { type: 'object', required: ['name'], properties: { name: s, value: { ...s, maxLength: CUSTOM_VALUE_MAX, description: 'Empty or null: no value.' }, on_certificate: { type: 'boolean', readOnly: true, description: 'Whether it is printed on the certificate. On an envelope that was sent, as it was sent.' } } },
});

/** "fields" on Document: name and value pairs of the document's own, for an integration. */
export const documentFieldsProp = () => ({
  type: 'array', maxItems: DOC_FIELDS_MAX,
  description: `Name and value pairs of this document's own, for your systems (API only): names up to ${CUSTOM_NAME_MAX} characters, values up to ${CUSTOM_VALUE_MAX}, each name once. Not defined in the account, not on the certificate, never shown to anyone who signs, and not a filter of the list. Left out on PUT, they stay while the document keeps its id; [] empties them. A copy from a template keeps them. Webhook payloads carry them as "document_fields".`,
  items: { type: 'object', required: ['name', 'value'], properties: { name: s, value: s } },
});

/** The list's filter by a custom field. */
export const customListParams = () => [
  { name: 'field', in: 'query', schema: s, description: 'The name of a custom field: only envelopes with a value for it. Also a name that only older envelopes carry, because its field was deleted since.' },
  { name: 'value', in: 'query', schema: s, description: 'With "field": only that value, as a whole, in capitals or not. Each envelope in the answer carries "custom_fields".' },
];

/** What a webhook delivery's "envelope" carries besides its id, status, subject and times. */
export const webhookCustomProps = () => ({
  custom_fields: { type: 'array', items: { type: 'object', properties: { name: s, value: s } }, description: 'The envelope\'s custom fields.' },
  document_fields: { type: 'array', items: { type: 'object', properties: { document_id: s, name: s, value: s } }, description: 'Each document\'s own name and value pairs.' },
});

export const customFieldPaths = () => ({
  '/custom-fields': {
    get: { summary: 'The account\'s custom fields', description: `Everyone on the team and a "send" key. "past_names": names that only envelopes sent before their field was deleted still carry; the list can be filtered by them. Up to ${MAX_CUSTOM_FIELDS} fields.`, responses: ok({ type: 'object', properties: { fields: { type: 'array', items: def }, past_names: { type: 'array', items: s }, limits: { type: 'object' } } }) },
    post: { summary: 'Add a custom field (admins)', description: `Up to ${MAX_CUSTOM_FIELDS} for an account; the next one answers 400. A name that is there already answers 409. It is in the account's security record.`, requestBody: body(def), responses: ok(answer) },
  },
  '/custom-fields/{id}': {
    parameters: [idParam],
    patch: { summary: 'Change a custom field (admins)', description: 'Only what the body names. Drafts and templates follow the change (their values carry the new name and certificate choice, and are checked against it when sent). An envelope that was sent never changes: it keeps the name and certificate choice it went out with.', requestBody: body(def), responses: ok(answer) },
    delete: { summary: 'Delete a custom field (admins)', description: 'Drafts and templates lose their value for it. Envelopes that were sent keep theirs, under the name they were sent with: their certificate is unchanged, and they can still be filtered and exported by it.', responses: ok({ type: 'object', properties: { ok: { type: 'boolean' }, name: s, drafts_cleared: { type: 'integer' }, sent_kept: { type: 'integer' } } }) },
  },
  '/envelopes/{id}/custom-fields': {
    parameters: [idParam],
    put: {
      summary: 'Set the custom fields of one envelope or template',
      description: 'The whole list as it should be, like "custom_fields" in PUT /envelopes/{id}. On an envelope that is out this puts a mistyped reference right: each change is a line in its audit trail (a field not printed on the certificate is named without its values), a required one can be changed and not emptied, new words for the certificate pass the same fake-notice filter as anything else the sender adds, and nobody is asked to sign again. Once it is completed the values are fixed (409); a declined, voided or expired one too.',
      requestBody: body({ type: 'object', required: ['custom_fields'], properties: { custom_fields: customFieldsProp() } }),
      responses: ok({ type: 'object', properties: { custom_fields: customFieldsProp() } }),
    },
  },
});
