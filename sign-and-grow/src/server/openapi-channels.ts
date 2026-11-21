// WhatsApp and codes by phone call, as part of /api/openapi.json (routes-whatsapp.ts, whatsapp.ts, voice.ts).
// Kept apart so the main description stays readable; openapi.ts spreads it into its paths.
import { WA_AGREE, CALL_PROVES } from '../lib/channels.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const tok = { name: 'token', in: 'path', required: true, schema: { type: 'string' } };

/** The two recipient fields, spread into the recipient schema. */
export const channelRecipientFields = {
  whatsapp: { type: 'boolean', default: false, description: `Also send the signing link by WhatsApp to "phone": the invitation, reminders (at most one a day), the closing-soon notice and, once complete, a link to the finished document (never the PDF). Only where the operator set WhatsApp up (GET /me says so in "whatsapp"; otherwise 400 with "code": "whatsapp_off"). Only on an envelope, for one person who signs, approves, views or witnesses: refused for a template ("code": "whatsapp_template"), a group, a copy, someone who signs in person, someone whose link you send yourself, a public form's visitor, and together with "text_link". Leaving it out keeps what the person has.` },
  whatsapp_agreed: { type: 'boolean', description: `Your tick "${WA_AGREE}". Holds for the number in "phone" when it is saved, and is written to the audit trail; another number needs it again. Without it the envelope is not sent (400). On read: whether the tick holds for the number on file now.` },
  whatsapp_status: { type: 'object', nullable: true, readOnly: true, description: 'The newest WhatsApp message to this person: "to" (masked), "status" (queued, sent, delivered, failed, outbox), "said" (the words the app shows: Sent, Delivered to the phone, Could not be sent, Not sent: they replied STOP), "error", "stopped". "Read" is never reported.' },
};

export const channelPaths = () => ({
  '/whatsapp/webhook': {
    get: { security: [], summary: 'The check Meta makes when the operator sets up the webhook', description: 'Answers hub.challenge when hub.verify_token equals WHATSAPP_VERIFY_TOKEN. 403 otherwise, and always when that setting is empty.', responses: { 200: { description: 'The challenge, as text' }, default: err } },
    post: {
      security: [],
      summary: 'Replies and delivery reports from WhatsApp',
      description: 'Meta posts JSON signed with WHATSAPP_APP_SECRET (X-Hub-Signature-256); Twilio posts a form signed with TWILIO_AUTH_TOKEN (X-Twilio-Signature, over APP_URL/api/whatsapp/webhook). Anything unsigned or wrongly signed is refused with 403 and changes nothing. A reply STOP (or stop all, unsubscribe, cancel, end, quit) stops WhatsApp messages to that number from every account that wrote to it; START lets them write again. "delivered" and "read" both become "Delivered to the phone"; "failed" and "undelivered" are written to the envelope\'s audit trail.',
      responses: ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
    },
  },
  '/sign/{token}/code/call': {
    post: {
      tags: ['Signing'], security: [], parameters: [tok],
      summary: 'Call me with the code',
      description: `For a recipient checked with a code by text message, on a server with VOICE_ENABLED=1: we call the same number and read a new code out slowly, twice. ${CALL_PROVES} A call counts as one text against SMS_DAILY_PER_ACCOUNT, and is never tried again. 409 for any other check, 503 with "code": "unavailable" when calls are off, 429 with "code": "wait" within a minute of the last code. The answer never holds the code.`,
      responses: ok({ type: 'object', properties: { sent: { type: 'boolean' }, by: { type: 'string', enum: ['call', 'text'] }, to: { type: 'string', description: 'Masked number' }, minutes: { type: 'integer' }, resend_in: { type: 'integer' }, delivery: { type: 'string', enum: ['sent', 'outbox', 'failed'] } } }),
    },
  },
});
