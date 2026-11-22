// What the API description says about "See what each person sees" (preview.ts, routes-preview.ts), kept apart so the
// busy openapi.ts only needs one reference to it.
import { PREVIEW_MINUTES, PREVIEW_NOTHING } from '../lib/preview.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const body = { required: true, content: { 'application/json': { schema: { type: 'object', required: ['recipient_id'], properties: { recipient_id: { type: 'string', description: 'The id of one person (recipients[].id) on it.' } } } } } };
const ok = { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: {
  url: { type: 'string', format: 'uri', description: 'The signing page as this person sees it, for a browser. Not a signing link: it opens only for the login that asked for it, signed in (for a key, the person who made the key), in the browser it was asked from when it was asked from one.' },
  expires_at: { type: 'string', format: 'date-time', description: `${PREVIEW_MINUTES} minutes from now. The person switch on the page does not extend it.` },
  recipient_id: { type: 'string' },
} } } } }, default: err };
const what = `Nothing is recorded or sent while it is open: no line in the audit trail, no "viewed", no consent, no signature held or used (and a signature or initials a person adopted but has not put on the document are not returned), no email or text, no webhook, and no row of the database changes. Consent and "save as you go" answer on the page and write nothing; every button that would change something answers 403 with "code": "preview" and "${PREVIEW_NOTHING}". The page shows that person's documents, fields, notes and the consent text in their language. A check before the document opens (an access code, a one-time code) is described in the page's band, not asked. Refused with 400 without "recipient_id", 404 for a person who is not on it (or a document this login may not open), and 409 for one that is completed, declined, voided or expired. The link answers 403 with "code": "preview_not_yours" in any other browser or login, 410 with "code": "preview_expired" after ${PREVIEW_MINUTES} minutes, and 404 with "code": "preview_gone" when the person was taken off. Previewing emails is not offered.`;

export const PREVIEW_PATHS = {
  '/envelopes/{id}/recipient-preview': { parameters: [idParam],
    post: { summary: 'See what one person sees, on a draft or an envelope that is out', description: `A link to the signing page in preview, for one person on a draft or on an envelope that is out. ${what}`, requestBody: body, responses: ok } },
  '/templates/{id}/recipient-preview': { parameters: [idParam],
    post: { summary: 'See what one role sees on a template', description: `The same for a template, by its role: for anyone who may use the template. ${what}`, requestBody: body, responses: ok } },
};
