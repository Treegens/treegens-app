// What the API description says about signing on paper (src/server/routes-paper.ts), kept apart so the busy openapi.ts
// needs one reference.
import { PAPER_REASON_MAX } from '../lib/paper.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const id = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const json = (schema: any) => ({ required: true, content: { 'application/json': { schema } } });

/** The two recipient properties, for the recipient schema of PUT /envelopes/{id}. */
export const paperRecipientProps = {
  allow_paper: { type: 'boolean', description: 'Whether this person may print the document, sign it by hand and send back a photo or a scan through their link (POST /sign/{token}/paper). Only while the account\'s switch "People may sign on paper" is on (GET /account/paper), and only for a signer or an approver who is not a group, not someone who signs in person, and has no witness. Left out it is true, so with the switch on such a person may. false means on screen only. In answers it reads null (the default) or 0 (on screen only).' },
  require_paper: { type: 'boolean', default: false, description: 'This person signs on paper only: their signing page offers the print and the upload and no electronic signing, and POST /sign/{token}/complete is refused (409, code "paper_only"). Refused with 400 and code "paper_off" while the account\'s switch is off, and with code "not_for_paper" for anyone who cannot sign on paper (see allow_paper). In answers it reads 0 or 1. One already set stays when an admin later switches paper off, and then does nothing.' },
  paper_state: { type: 'string', nullable: true, enum: ['waiting', 'asked_again', 'accepted'], readOnly: true, description: 'Where this person\'s latest scan signed on paper stands: waiting for the sender, asked again, or accepted (they then have status "completed").' },
};

export const paperPaths = () => ({
  '/account/paper': {
    get: { summary: 'Whether people may sign on paper (admins)', description: 'Settings, Sending, "People may sign on paper". Off for every account until an admin switches it on. Off, nobody is offered paper and nothing about it shows anywhere. Switching it off later takes the offer away from documents already out; a scan already waiting can still be looked at.', responses: { 200: { description: '{ on: boolean }' }, default: err } },
    put: { summary: 'Switch signing on paper on or off (admins, signed in to the app)', description: 'Body {"on": true|false}. Refused for an API key (403). Recorded in the security record as settings.changed.', requestBody: json({ type: 'object', required: ['on'], properties: { on: { type: 'boolean' } } }), responses: { 200: { description: '{ on: boolean }' }, default: err } },
  },
  '/sign/{token}/paper/print': {
    parameters: [id('token')],
    get: { summary: 'The print to sign on paper', description: 'A PDF: a cover page that says how to send it back, then the document as this person\'s screen shows it, with their places marked ("Sign here", "Initial here", a box to write in). Every page carries the envelope ID, "Page x of y", the person\'s name and a security code that changes whenever the document changes. Refused (409, code "paper_not_offered") when paper is not offered to this person, and for a delegate\'s link.', security: [], responses: { 200: { description: 'application/pdf' }, default: err } },
  },
  '/sign/{token}/paper': {
    parameters: [id('token')],
    post: {
      summary: 'Send back the pages signed on paper',
      description: 'multipart/form-data with one or more "file" parts: one PDF, or up to 50 PNG or JPEG photos that become one document in the order sent, up to 25 MB together (the same rules as POST /files). The person then shows as "Signed on paper, waiting for the sender to check": nobody after them in the order is asked, no reminder goes to them, and Finish on screen is refused (409, code "paper_waiting"). The audit trail gets "Sent back a scan signed on paper" with the pages, the SHA-256 and the security code, and the sender is emailed whatever their notification choices are. GrowSigning does not read the scan. Refused while another scan from them waits (409, code "paper_waiting").',
      security: [],
      responses: { 200: { description: '{ ok: true, state: "waiting", pages }' }, default: err },
    },
  },
  '/envelopes/{id}/paper': {
    parameters: [id('id')],
    get: { summary: 'The scans signed on paper on this document', description: 'Newest first: { scans: [{ id, recipient_id, name, state ("waiting", "accepted", "asked_again" or "set_aside"), at, pages, code, current, decided_at, decided_by, reason }] }. "current" is false for a scan made from the print of an older version of the document. "set_aside": it no longer counts and is kept on record, because the request is now for another person (a correction to another address, or another name at the same one) or because the person was asked to sign again after it was accepted.', responses: { 200: { description: 'The scans.' }, default: err } },
  },
  '/envelopes/{id}/recipients/{rid}/paper/scan': {
    parameters: [id('id'), id('rid')],
    get: { summary: 'The scan itself, as a PDF', description: 'The latest scan of this person, or the one named by ?scan=<id>.', responses: { 200: { description: 'application/pdf' }, default: err } },
  },
  '/envelopes/{id}/recipients/{rid}/paper/accept': {
    parameters: [id('id'), id('rid')],
    post: { summary: 'Accept the waiting scan as signed by this person', description: 'Only a scan sent by the person the request is for now: 409 "no_scan" otherwise. The person finishes the way anyone finishes, as of now and from the address the scan came from: it uses a signature like any finished signer, the next person is asked, and when everyone has finished the signed PDF has the scan after a page "Signed on paper by <name>", their places read "Signed on paper: see page N", and the certificate says when and from where the scan came, who accepted it and when, and that GrowSigning did not check the handwriting. Refused (409) with code "no_scan" when nothing waits, "paper_old_version" when the document changed after the print was made, and "not_open" once the document is closed. The sender, an admin who sees the whole account, or a colleague the sender shared their documents with at "manage" may do this.', responses: { 200: { description: '{ ok: true, envelope_status }' }, default: err } },
  },
  '/envelopes/{id}/recipients/{rid}/paper/reject': {
    parameters: [id('id'), id('rid')],
    post: { summary: 'Ask again for the scan, with a reason', description: `Body {"reason"}: required, up to ${PAPER_REASON_MAX} characters. The scan is set aside (state "asked_again"), the person is emailed the reason in quotes, and their signing page shows it and lets them send a new scan. The reason goes through the same checks as every email the sender causes (422 for words that read like a fake notice, 403 while sending is paused), and nothing is changed when it is refused.`, requestBody: json({ type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: PAPER_REASON_MAX } } }), responses: { 200: { description: '{ ok: true, emailed }' }, default: err } },
  },
});
