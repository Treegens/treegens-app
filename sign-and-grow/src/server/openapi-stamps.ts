// The stamps part of /api/openapi.json (routes-stamps.ts), kept apart so the main description stays readable.
// openapi.ts spreads it into its paths and puts the Stamp schema with the others.
import { STAMP_IS, STAMP_PNG_MAX_BYTES, STAMP_OUT_MAX_SIDE, STAMP_OUT_MIN_SIDE, STAMPS_PER_ACCOUNT, STAMP_MIN_MM, STAMP_MAX_MM, STAMP_DEFAULT_MM, STAMP_UPLOADS_PER_LINK_HOUR, STAMP_UPLOADS_PER_ADDRESS_HOUR, STAMP_OPACITY, STAMP_NAME_MAX } from '../lib/stamps.ts';
import { INKS, TILT_MAX } from '../lib/stampink.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const png = { 200: { description: 'The stamp picture, a PNG whose paper is see-through', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } }, default: err };
const body = (schema: any) => ({ required: true, content: { 'application/json': { schema } } });
const s = { type: 'string' };
const idParam = { name: 'id', in: 'path', required: true, schema: s };
const token = { name: 'token', in: 'path', required: true, schema: s };
const sha = { name: 'sha', in: 'path', required: true, schema: s, description: 'The SHA-256 of the picture, as a stamp field holds it in "value".' };

const IMAGE = `A data URL of a PNG (data:image/png;base64,...): the finished impression, 8 bits per channel with a see-through background (RGBA), at least ${STAMP_OUT_MIN_SIDE} and at most ${STAMP_OUT_MAX_SIDE} pixels on each side, up to ${STAMP_PNG_MAX_BYTES / 1e6} MB. The stamp screen in the app makes it from a photo or a design: paper taken away, one ink, a rubber texture and a small tilt. A picture with no see-through parts would print as a box and is refused, as is anything else (SVG, PDF, JPEG, WebP), in words. Only what draws the picture is kept: text, dates and camera notes inside the file are left out.`;
const look = {
  ink: { type: 'string', enum: [...INKS], description: 'The ink the impression is in. Kept with it.' },
  seed: { type: 'integer', minimum: 1, maximum: 2147483646, description: 'The number its texture and tilt were made from, so it can be made again exactly. Given one when left out.' },
  tilt: { type: 'number', minimum: -TILT_MAX, maximum: TILT_MAX, description: 'Degrees it was turned by.' },
  texture: { type: 'number', minimum: 0, maximum: 1, description: '0 is even ink, 1 a well-worn stamp.' },
};

export const stampSchema = {
  type: 'object', description: `A stamp of the account (Settings, Stamps). ${STAMP_IS}`,
  properties: {
    id: { ...s, readOnly: true }, name: { ...s, maxLength: STAMP_NAME_MAX, description: 'Unique in the account, whatever the case. For an account the checks still apply to, a name that reads like a well-known brand or a payment notice is refused (422), as for any other name it types.' },
    ...look, size_mm: { type: 'number', minimum: STAMP_MIN_MM, maximum: STAMP_MAX_MM, default: STAMP_DEFAULT_MM, description: 'Its real size across, in millimetres: the size a stamp field for it starts at. A round company seal is about 38 to 45.' },
    image_sha256: { ...s, readOnly: true }, width: { type: 'integer', readOnly: true }, height: { type: 'integer', readOnly: true }, image_url: { ...s, readOnly: true, description: 'Where the picture is, with the same session or key.' },
    created_by: { ...s, readOnly: true }, created_at: { ...s, readOnly: true }, updated_by: { ...s, readOnly: true }, updated_at: { ...s, readOnly: true },
  },
};

export function stampPaths() {
  return {
    '/stamps': {
      get: { summary: 'The stamps of the account', description: `Everyone on the team can read them and use them: a stamp of the sender on an envelope ("stamp_id" on a stamp field with no recipient_id), or when they sign a document sent to their own address while signed in. "may_change" says whether you can change them: that is for admins. ${STAMP_IS}`, responses: ok({ type: 'object', properties: { stamps: { type: 'array', items: { $ref: '#/components/schemas/Stamp' } }, max: { type: 'integer' }, may_change: { type: 'boolean' }, what_a_stamp_is: s } }) },
      post: { summary: 'Add a stamp (admins)', description: `Up to ${STAMPS_PER_ACCOUNT} for an account (409 after that, and for a name it already has). "image": ${IMAGE}`, requestBody: body({ type: 'object', required: ['name', 'image'], properties: { name: s, image: s, ...look, size_mm: { type: 'number' } } }), responses: ok({ type: 'object', properties: { stamp: { $ref: '#/components/schemas/Stamp' } } }) },
    },
    '/stamps/{id}': { parameters: [idParam],
      put: { summary: 'Rename a stamp, set its real size, or give it a new picture (admins)', description: 'Documents that already carry the stamp keep the picture they have: "kept_on_documents" says on how many envelopes and drafts. A draft or template takes the new picture when its stamp field is saved with "stamp_refresh": true.', requestBody: body({ type: 'object', properties: { name: s, image: s, ...look, size_mm: { type: 'number' } } }), responses: ok({ type: 'object', properties: { stamp: { $ref: '#/components/schemas/Stamp' }, kept_on_documents: { type: 'integer' } } }) },
      delete: { summary: 'Delete a stamp (admins)', description: 'Documents that carry it keep their picture. A draft or template that names it keeps the picture it has and can still be sent.', responses: ok({ type: 'object', properties: { kept_on_documents: { type: 'integer' } } }) },
    },
    '/stamps/{id}/image': { parameters: [idParam], get: { summary: 'The picture of a stamp of the account', responses: png } },
    '/envelopes/{id}/stamp-image/{sha}': { parameters: [idParam, sha], get: { summary: 'The picture of a stamp on an envelope', description: 'For whoever can open the envelope: its sender and the admins of the account. A picture a signer uploaded is shown to nobody outside the envelope.', responses: png } },
    '/sign/{token}/stamps': { parameters: [token], get: { summary: 'The saved stamps a signer may use', description: 'With the signing link, from a browser signed in to the app at the address the document was sent to: the stamps of that account. Otherwise an empty list and "why_none": "signed out", "another address" or "in person" (a device handed over to sign in person never offers the host\'s stamps).', security: [], responses: ok({ type: 'object', properties: { stamps: { type: 'array', items: { $ref: '#/components/schemas/Stamp' } }, account: { ...s, nullable: true }, why_none: { ...s, nullable: true }, what_a_stamp_is: s } }) } },
    '/sign/{token}/stamp': { parameters: [token], post: {
      summary: 'Put a stamp on one of your stamp fields', security: [],
      description: `With the signing link, after agreeing to electronic records, while it is your turn. Either "image" (${IMAGE}) with the settings it was made with and "from": "upload" or "camera", or "stamp_id" of a saved stamp (see GET /sign/{token}/stamps). One picture per field: a new one takes the old one's place. It is kept like an answer, so Finish later keeps it, and it is recorded in the audit trail when you finish, with the fingerprint of the picture. Up to ${STAMP_UPLOADS_PER_LINK_HOUR} pictures an hour for one link and ${STAMP_UPLOADS_PER_ADDRESS_HOUR} for one internet address (429 in words after that). On the page and in the signed PDF it is printed like ink: multiplied into the page at ${STAMP_OPACITY * 100} percent, so the printed words under it show through. A stamp uses no signature of the sender's. ${STAMP_IS}`,
      requestBody: body({ type: 'object', required: ['field_id'], properties: { field_id: s, image: s, stamp_id: s, from: { type: 'string', enum: ['upload', 'camera'] }, ...look, version: { type: 'integer', description: 'The content version your screen shows. A stamp on an older version is refused with "code": "changed".' } } }),
      responses: ok({ type: 'object', properties: { field_id: s, value: { ...s, description: 'The SHA-256 of the picture, which the field now holds.' }, image_url: s, size: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } } }, stamp: { type: 'object' }, what_a_stamp_is: s } }),
    } },
    '/sign/{token}/stamp/{field}': { parameters: [token, { name: 'field', in: 'path', required: true, schema: s }], delete: { summary: 'Take your stamp off a field again, before you finish', security: [], responses: ok({ type: 'object' }) } },
    '/sign/{token}/stamp-image/{sha}': { parameters: [token, sha], get: { summary: 'The picture of a stamp on this envelope', description: 'Your own, the sender\'s, or that of someone who has finished. Never a picture of another envelope.', security: [], responses: png } },
  };
}
