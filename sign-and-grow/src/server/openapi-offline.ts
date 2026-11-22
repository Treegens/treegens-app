// What the API description says about signing in person without signal (src/server/routes-offline.ts), kept apart
// so the busy openapi.ts needs one reference.
import { OFFLINE_DAYS } from '../lib/offlinesign.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const id = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });

export const offlinePaths = () => ({
  '/envelopes/{id}/offline': {
    parameters: [id('id')],
    post: {
      summary: 'Get one in-person signer\'s part ready on this device, to sign without signal',
      description: `For the app on the host's own device only: a browser session of the envelope's sender (or an admin who sees the whole account), never an API key (403, code "session_only"). Body: {"recipient_id"}. Only for someone who signs in person, whose turn it is, on an envelope that is out. Refused with 409 and code "needs_signal" when their part needs GrowSigning to answer: an access code or a code we send, a group, a witness, files to read, fields other than signature, initials, text, number, date, company, title, names, tick boxes, choices and dropdowns, or fields that change with other answers. Answers what the device keeps: prep_id, created_at, expires_at (${OFFLINE_DAYS} days later), token (the signing link's), host, view (what GET /sign/{token} would answer, looked at quietly: nothing is marked viewed and the account is not locked) and files (each PDF in base64). The device encrypts all of it under a PIN the host chooses. One envelope per device: an earlier copy from the same browser session ends, and so does a copy for the same person on another device. Recorded in the audit trail.`,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { recipient_id: { type: 'string' } }, required: ['recipient_id'] } } } },
      responses: { 200: { description: 'The copy for the device.' }, default: err },
    },
    get: {
      summary: 'Copies of this envelope still waiting on a device',
      responses: { 200: { description: '{ waiting: [{ id, recipient_id, created_at, expires_at, host }] }' }, default: err },
    },
  },
  '/envelopes/{id}/offline/{prep}': {
    parameters: [id('id'), id('prep')],
    delete: { summary: 'End a copy waiting on a device (a lost phone)', description: 'A result sent from that device later signs nothing. Recorded in the audit trail.', responses: { 200: { description: '{ ok: true }' }, default: err } },
  },
  '/offline/{prep}/hand-over': {
    parameters: [id('prep')],
    post: { summary: 'Lock the account in this browser before the device is handed over', description: 'The same lock as opening the signing page of someone who signs in person: every call that needs signing in is refused until the owner types their password (POST /auth/unlock). Only for the browser session the copy was got ready in.', responses: { 200: { description: '{ ok: true }' }, default: err } },
  },
  '/sign/{token}/offline-finish': {
    parameters: [id('token')],
    post: {
      summary: 'Send back what was signed on the host\'s device without signal',
      description: `Public, authorised by the signing link. Body: prep_id, device_at (the device's clock when the person finished, recorded and never checked), values, signature_png, initials_png, consent ({ wording, language, page_language, tz, own }). Accepted only while that copy is the one got ready, at most ${OFFLINE_DAYS} days old, and only if the envelope's content version is the one it was got ready from: otherwise nothing is signed and the answer is 409 with code "offline_changed", "offline_too_old", "offline_closed" or "offline_ended", or 404 "offline_unknown". On success the person has agreed and finished at the moment the server received it, the audit trail and the certificate say "Signed in person on the host's device without a connection. The device's clock said <time>; this was not checked. The server received it at <time>.", and the answer is { ok, envelope_status, received_at }. Sent again after it went through: { ok: true, already: true }, nothing signed twice.`,
      responses: { 200: { description: 'Signed.' }, default: err },
    },
  },
});
