// What the API description says about Send later, pause and resume, and the wait before a person (timing.ts,
// waits.ts, routes-timing.ts), kept apart so the busy openapi.ts only needs a few references to it.
import { SEND_LATER_MAX_DAYS, SEND_LATER_MIN_MINUTES, WAIT_MAX_HOURS } from '../lib/timing.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const envOk = (extra: Record<string, any> = {}) => ({ 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { envelope: { $ref: '#/components/schemas/Envelope' }, ...extra } } } } }, default: err });
const sendAt = { type: 'string', format: 'date-time', description: `A moment at least ${SEND_LATER_MIN_MINUTES} minutes and at most ${SEND_LATER_MAX_DAYS} days from now, like 2027-03-20T09:00:00Z, with its zone (Z or an offset such as +02:00). A day alone, or a time with no zone, is refused with 400 rather than guessed. Our timer takes it up on its next round after that moment (every 15 minutes, or as often as the host calls POST /cron), so it goes out soon after, never before.` };

/** "send_at" on POST /envelopes/{id}/send. */
export const SEND_AT_PROP = { ...sendAt, description: `Send it later instead of now: ${sendAt.description} The envelope stays a draft until then (see POST /envelopes/{id}/send-later). Nothing is held or emailed before that time.` };

/** Fields of an envelope. */
export const TIMING_ENVELOPE_PROPS = {
  send_at: { type: 'string', format: 'date-time', nullable: true, readOnly: true, description: 'A draft that goes out by itself at this moment (Send later). Null otherwise, and once it has gone out.' },
  send_error: { type: 'string', nullable: true, readOnly: true, description: 'Why a draft with "send_at" did not go out at that time, in words. It stays a draft; a new time or a send by hand clears it.' },
  paused_at: { type: 'string', format: 'date-time', nullable: true, readOnly: true, description: 'Set while the sender has paused this envelope.' },
  paused_by: { type: 'string', nullable: true, readOnly: true },
  paused_ms: { type: 'integer', readOnly: true, description: 'How long it was paused in all, in milliseconds. The deadline moved on by the same time.' },
};

/** "wait_hours" of a recipient. */
export const WAIT_HOURS_PROP = { type: 'integer', minimum: 0, maximum: WAIT_MAX_HOURS, default: 0, description: `With "ordered": true, ask this person this many hours (1 to ${WAIT_MAX_HOURS}, which is 30 days) after everyone before them in the order has finished. 0 for no wait. Ignored for the first place in the order, for a witness and without an order. Copied into everything made from a template. Sending is refused with 400, "code": "waits_too_long", when the waits add up to the deadline ("expire_days") or more, and a correction (PUT /envelopes/{id}) that changes a wait is refused the same way, with "Nothing was changed", when the waits still to come (and what is left of one running) would reach the deadline. The deadline keeps running during a wait. The audit trail says once that the person waits, and until when.` };

export const TIMING_PATHS = {
  '/envelopes/{id}/send-later': { parameters: [idParam],
    post: { summary: 'Send a draft later, or change when', description: `The draft stays a draft (status "draft") with "send_at" set, and can still be changed. At that time our timer sends it with every check a send has: a confirmed address, signatures in the balance, the daily limit, a pause on the account, an address that bounced before. Nothing is held while it waits. If anything stops it, it is not sent, "send_error" says why, the audit trail says so, and the sender is emailed; it is not tried again by itself. A new time clears that. Refused with 400 for a time less than ${SEND_LATER_MIN_MINUTES} minutes or more than ${SEND_LATER_MAX_DAYS} days ahead (or one that cannot be read), with 400 for a draft that has no document or nobody on it, with 403 and "code": "confirm_email" while the sender's address is not confirmed, and with 409 for an envelope that is not a draft. Repeating schedules are not offered.`, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['send_at'], properties: { send_at: sendAt } } } } }, responses: envOk({ send_at: { type: 'string', format: 'date-time' } }) },
    delete: { summary: 'Take the time off a draft', description: 'It stays a draft and nothing is sent. 409 when no time is set.', responses: envOk() },
  },
  '/envelopes/{id}/pause': { parameters: [idParam],
    post: { summary: 'Pause an envelope that is out', description: 'Until it is resumed nobody can fill it in, sign, finish or decline it: those calls on a signing link answer 409 with "code": "paused" and the words the signing page shows ("Paused by <sender> on <day>. You will get an email when it can be signed again."). Nobody further down the order is asked, no reminders go out (POST /envelopes/{id}/remind answers 409), and it does not expire. The document, its questions and comments stay readable. The "envelope.paused" webhook fires. 409 when it is not out, or is paused already.', responses: envOk() } },
  '/envelopes/{id}/resume': { parameters: [idParam],
    post: { summary: 'Resume a paused envelope', description: 'The deadline moves on by the time it was paused ("paused_for_ms", and the new "expires_at"), and the audit trail says so. Whoever\'s turn it is is emailed that it can be signed again, and anyone whose turn came or whose wait ended meanwhile is asked. The "envelope.resumed" webhook fires. 409 when it is not paused.', responses: envOk({ paused_for_ms: { type: 'integer' }, expires_at: { type: 'string', format: 'date-time', nullable: true } }) } },
};
