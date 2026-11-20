import { route, json } from './router.ts';
import { ROLES, FIELD_TYPES } from './envelopes.ts';
import { WEBHOOK_EVENTS, MAX_WEBHOOKS, KEEP_BODIES } from './webhooks.ts';
import { DATE_FORMATS } from '../lib/dates.ts';
import { baseUrl } from './util.ts';

// A machine-readable description of the developer API, served at /api/openapi.json.
// It is written by hand and kept honest by a test: every path here must exist in the router.

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const body = (schema: any) => ({ required: true, content: { 'application/json': { schema } } });
const ok = (schema: any, description = 'OK') => ({ 200: { description, content: { 'application/json': { schema } } }, default: { description: 'Error', content: { 'application/json': { schema: ref('Error') } } } });
const pdf = { 200: { description: 'A PDF file', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, default: { description: 'Error', content: { 'application/json': { schema: ref('Error') } } } };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const str = { type: 'string' };
const time = { type: 'string', format: 'date-time', nullable: true };
const frac = { type: 'number', minimum: 0, maximum: 1 };

export function openapi() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Sign&Grow API',
      version: '1.0.0',
      description: 'Everything the Sign&Grow app does goes through this API. It is the same on every plan, keys work immediately, and there is no separate test environment or go-live review. All times are ISO 8601 in UTC. Errors are JSON: {"error": "what went wrong and what to do"}. Sending answers 402 when the account has too few signatures left: one is held for each person who signs, it is only used when they sign, and nothing is ever charged automatically.',
    },
    servers: [{ url: `${baseUrl()}/api` }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'An API key from Settings, API and webhooks. Send it as "Authorization: Bearer tsk_...". Every key has a scope. "send", the default, covers envelopes, templates, files, contacts, bulk sends, export and reports, and can read the webhook list and delivery log without the signing secrets. "admin" is chosen on purpose when the key is created and also covers account settings, invitations and webhooks; it only works while its creator is an admin. No key of either scope can create or revoke keys, remove a team member, hand over or close the account, or change the plan, pay or refund. Those answer 403 and need a person signed in to the app. A key that cannot be used answers 401 and says which it is: the header could not be read, the key is unknown or revoked, or the person who created it has left the account. While an account is being closed its keys answer 403 until someone signs in again.' } },
      schemas: {
        Error: { type: 'object', required: ['error'], properties: { error: { ...str, description: 'What went wrong and what to do about it, written for people.' }, request_id: { ...str, description: 'Also sent as the X-Request-Id header. Quote it when asking for help.' } } },
        File: { type: 'object', properties: { id: str, name: str, pages: { type: 'integer' }, page_sizes: { type: 'array', items: { type: 'object', properties: { w: { type: 'number' }, h: { type: 'number' } } } } } },
        Document: { type: 'object', required: ['file_id'], properties: { id: { ...str, description: 'Your own id, used by fields to point at this document. Optional.' }, file_id: str, name: str, pages: { type: 'integer', readOnly: true } } },
        Recipient: {
          type: 'object', required: ['name', 'email'],
          properties: {
            id: { ...str, description: 'Your own id, used by fields to point at this recipient.' },
            role: { type: 'string', enum: ROLES, default: 'signer' }, role_name: { ...str, description: 'Templates only: the name of the role, such as "Client".' },
            name: str, email: { type: 'string', format: 'email' }, routing_order: { type: 'integer', minimum: 1, default: 1 },
            access_code: { ...str, nullable: true }, note: { ...str, nullable: true },
            status: { type: 'string', enum: ['pending', 'sent', 'viewed', 'completed', 'declined'], readOnly: true },
            sent_at: { ...time, readOnly: true }, viewed_at: { ...time, readOnly: true }, completed_at: { ...time, readOnly: true }, muted: { type: 'integer', readOnly: true, description: '1 when the recipient turned reminders off.' },
          },
        },
        Field: {
          type: 'object', required: ['document_id', 'type', 'page', 'x', 'y', 'w', 'h'],
          description: 'Positions and sizes are fractions of the page, measured from its top left corner.',
          properties: {
            id: { ...str, description: 'Optional.' }, document_id: str, recipient_id: { ...str, description: 'Not needed for type "note".' },
            type: { type: 'string', enum: FIELD_TYPES }, page: { type: 'integer', minimum: 0, description: 'First page is 0.' },
            x: frac, y: frac, w: frac, h: frac, required: { type: 'boolean', default: true }, label: str, value: { ...str, nullable: true },
            options: { type: 'array', items: str, description: 'For dropdowns.' }, group_name: { ...str, description: 'Radio buttons with the same group are one choice.' },
            validation: { ...str, description: 'email, number, phone, or a regular expression.' }, readonly: { type: 'boolean' },
          },
        },
        EnvelopeInput: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['envelope', 'template'], default: 'envelope' }, subject: str, message: str,
            ordered: { type: 'boolean', description: 'Sign in routing_order instead of all at once.' }, reminder_days: { type: 'integer', minimum: 0, maximum: 60 }, expire_days: { type: 'integer', minimum: 1, maximum: 365 },
            date_format: { type: 'string', enum: [...DATE_FORMATS] },
            documents: { type: 'array', items: ref('Document') }, recipients: { type: 'array', items: ref('Recipient') }, fields: { type: 'array', items: ref('Field') },
          },
        },
        Envelope: {
          allOf: [ref('EnvelopeInput'), { type: 'object', properties: { id: str, status: { type: 'string', enum: ['draft', 'sent', 'completed', 'declined', 'voided', 'expired'] }, created_at: time, sent_at: time, completed_at: time, expires_at: time, final_sha256: { ...str, nullable: true, description: 'SHA-256 of the signed PDF, once completed.' }, sheets: { type: 'integer', description: 'Sheets of paper this envelope saved.' } } }],
        },
        AuditEvent: { type: 'object', properties: { seq: { type: 'integer' }, at: time, actor: str, action: str, detail: str, ip: { ...str, nullable: true }, prev_hash: str, hash: str } },
        ApiKey: { type: 'object', properties: { id: str, name: str, prefix: { ...str, description: 'The first characters of the key. The key itself is shown once, when it is created, and never again.' }, scope: { type: 'string', enum: ['send', 'admin'] }, created_at: time, last_used_at: time, stopped_at: { ...time, description: 'Set when the key stopped working because the person who created it was removed from the account.' }, owner_name: str, owner_email: str, mine: { type: 'boolean' } } },
        WebhookDelivery: { type: 'object', properties: { id: { type: 'integer' }, webhook_id: str, url: str, event: str, envelope_id: str, state: { type: 'string', enum: ['pending', 'delivered', 'failed'], description: 'A delivery is listed as pending from before the first try.' }, status: { type: 'integer', nullable: true, description: 'The HTTP status your server answered with, if it answered.' }, error: { ...str, nullable: true }, attempts: { type: 'integer' }, at: time, can_redeliver: { type: 'boolean', description: `The content of the latest ${KEEP_BODIES} deliveries of each webhook is kept for sending again.` } } },
        WebhookEvent: {
          type: 'object', description: 'POSTed to your webhook URL. Verify the X-SignAndGrow-Signature header: "sha256=" + HMAC-SHA256(secret, X-SignAndGrow-Timestamp + "." + raw body).',
          properties: { id: { ...str, description: 'Unique per event. A delivery that is sent again keeps the same id, so repeats can be ignored.' }, event: { type: 'string', enum: WEBHOOK_EVENTS }, created_at: time, text: { ...str, description: 'A one-line summary.' }, recipient_id: str, envelope: { type: 'object', properties: { id: str, status: str, subject: str, sent_at: time, completed_at: time } } },
        },
      },
    },
    paths: {
      '/files': { post: { summary: 'Upload a PDF, PNG or JPEG (up to 25 MB, 500 pages)', requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } } } }, responses: ok(ref('File')) } },
      '/envelopes': {
        get: { summary: 'List envelopes or templates', parameters: [{ name: 'kind', in: 'query', schema: { type: 'string', enum: ['envelope', 'template'] } }, { name: 'box', in: 'query', schema: { type: 'string', enum: ['all', 'drafts', 'sent', 'waiting', 'completed', 'closed'] } }, { name: 'q', in: 'query', schema: str }, { name: 'folder', in: 'query', schema: str }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } }, { name: 'offset', in: 'query', schema: { type: 'integer' } }], responses: ok({ type: 'object', properties: { envelopes: { type: 'array', items: ref('Envelope') }, folders: { type: 'array', items: str } } }) },
        post: { summary: 'Create a draft, or create from a template; add "send": true to send it at once', parameters: [{ name: 'Idempotency-Key', in: 'header', description: 'Any unique string. Repeating a call with the same key returns the first envelope instead of creating another.', schema: str }], requestBody: body({ allOf: [ref('EnvelopeInput'), { type: 'object', properties: { send: { type: 'boolean' }, template_id: str, recipients: { description: 'With template_id: an object from role name to {name, email}. Otherwise an array of recipients.' } } }] }), responses: ok({ type: 'object', properties: { envelope: ref('Envelope') } }) },
      },
      '/envelopes/{id}': {
        parameters: [idParam],
        get: { summary: 'One envelope with its audit trail and email delivery log', responses: ok({ type: 'object', properties: { envelope: ref('Envelope'), audit: { type: 'array', items: ref('AuditEvent') }, chain: { type: 'object', properties: { ok: { type: 'boolean' }, events: { type: 'integer' }, head: str } }, deliveries: { type: 'array', items: { type: 'object', properties: { to_email: str, subject: str, status: { type: 'string', enum: ['queued', 'sent', 'outbox', 'failed'] }, error: { ...str, nullable: true }, at: time } } } } }) },
        put: { summary: 'Replace a draft, or correct an envelope that is already out', description: 'For a sent envelope this is a correction: no void, no resend, no extra count. Anything can change until a signer, approver or viewer has finished. After that the documents, those people and their fields are locked (409), and the remaining recipients can still change.', requestBody: body(ref('EnvelopeInput')), responses: ok({ type: 'object', properties: { envelope: ref('Envelope') } }) },
        patch: { summary: 'Move to a folder', requestBody: body({ type: 'object', properties: { folder: str } }), responses: ok({ type: 'object' }) },
        delete: { summary: 'Delete a draft, template or closed envelope', responses: ok({ type: 'object' }) },
      },
      '/envelopes/{id}/send': { parameters: [idParam], post: { summary: 'Send a draft', responses: ok({ type: 'object', properties: { envelope: ref('Envelope') } }) } },
      '/envelopes/{id}/void': { parameters: [idParam], post: { summary: 'Void an envelope that is out', requestBody: body({ type: 'object', required: ['reason'], properties: { reason: str } }), responses: ok({ type: 'object' }) } },
      '/envelopes/{id}/remind': { parameters: [idParam], post: { summary: 'Remind everyone whose turn it is, or one recipient', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { recipient_id: str } } } } }, responses: ok({ type: 'object', properties: { reminded: { type: 'integer' } } }) } },
      '/envelopes/{id}/correct': { parameters: [idParam], post: { summary: 'Fix one recipient\'s name, email or access code', requestBody: body({ type: 'object', required: ['recipient_id'], properties: { recipient_id: str, name: str, email: str, access_code: str } }), responses: ok({ type: 'object' }) } },
      '/envelopes/{id}/extend': { parameters: [idParam], post: { summary: 'Push the deadline out, or reopen an expired envelope', requestBody: body({ type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } } }), responses: ok({ type: 'object', properties: { expires_at: time } }) } },
      '/envelopes/{id}/clone': { parameters: [idParam], post: { summary: 'Copy as a new draft or template', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { kind: { type: 'string', enum: ['envelope', 'template'] } } } } } }, responses: ok({ type: 'object', properties: { id: str } }) } },
      '/envelopes/{id}/recipient-view': { parameters: [idParam], post: { summary: 'Get one recipient\'s signing link, for embedded signing', description: 'Send the person to this URL in a new tab or by redirect. It cannot be shown inside an iframe. Treat it like a password.', requestBody: body({ type: 'object', required: ['recipient_id'], properties: { recipient_id: str } }), responses: ok({ type: 'object', properties: { url: { type: 'string', format: 'uri' } } }) } },
      '/envelopes/{id}/download': { parameters: [idParam], get: { summary: 'The signed PDF with its certificate, or a preview while in progress', responses: pdf } },
      '/bulk': {
        get: { summary: 'List bulk send batches', responses: ok({ type: 'object', properties: { batches: { type: 'array', items: { type: 'object' } } } }) },
        post: { summary: 'Send a template to many people (up to 500 rows)', requestBody: body({ type: 'object', required: ['template_id', 'rows'], properties: { template_id: str, name: str, rows: { type: 'array', items: { type: 'object', description: 'From role name to {name, email}.', additionalProperties: { type: 'object', properties: { name: str, email: str } } } } } }), responses: ok({ type: 'object', properties: { id: str, sent: { type: 'integer' }, failed: { type: 'array', items: { type: 'object' } } } }) },
      },
      '/bulk/{id}': { parameters: [idParam], get: { summary: 'One batch with every envelope and recipient status', responses: ok({ type: 'object', properties: { batch: { type: 'object' }, envelopes: { type: 'array', items: ref('Envelope') } } }) } },
      '/bulk/{id}/remind': { parameters: [idParam], post: { summary: 'Remind everyone in the batch who has not finished', responses: ok({ type: 'object', properties: { reminded: { type: 'integer' } } }) } },
      '/bulk/{id}/void': { parameters: [idParam], post: { summary: 'Void everything in the batch that is still open', requestBody: body({ type: 'object', required: ['reason'], properties: { reason: str } }), responses: ok({ type: 'object', properties: { voided: { type: 'integer' } } }) } },
      '/export': { get: { summary: 'A ZIP of signed PDFs, audit trails and a CSV index', parameters: [{ name: 'ids', in: 'query', description: 'Comma separated envelope ids. Leave out for everything.', schema: str }, { name: 'bulk', in: 'query', description: 'A bulk batch id, to export just that batch.', schema: str }], responses: { 200: { description: 'A ZIP file', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } } } } },
      '/reports/summary': { get: { summary: 'Counts, completion time and paper saved', responses: ok({ type: 'object' }) } },
      '/api-keys': { get: { summary: 'List API keys: your own, or every key in the account for an admin', description: 'Shows the name, scope, owner and last use of each key, never the key itself. Creating and revoking keys is done by a person in Settings, not with a key.', responses: ok({ type: 'object', properties: { keys: { type: 'array', items: ref('ApiKey') } } }) } },
      '/webhooks': {
        get: { summary: 'Webhooks and their delivery log (account admins)', description: 'Deliveries come newest first, 30 at a time. A key with the "send" scope gets "secret": null.', parameters: [{ name: 'webhook', in: 'query', description: 'A webhook id, to list the deliveries of that webhook only.', schema: str }, { name: 'before', in: 'query', description: 'The next_before of the page before, to go further back.', schema: { type: 'integer' } }], responses: ok({ type: 'object', properties: { events: { type: 'array', items: str }, webhooks: { type: 'array', items: { type: 'object', properties: { id: str, url: str, events: str, active: { type: 'integer' }, secret: { ...str, nullable: true }, created_at: time } } }, deliveries: { type: 'array', items: ref('WebhookDelivery') }, next_before: { type: 'integer', nullable: true, description: 'null when there is nothing older.' } } }) },
        post: { summary: `Add a webhook (needs a key with the "admin" scope; up to ${MAX_WEBHOOKS} per account)`, description: 'The address must use https and be on the public internet. Deliveries go to the address the name pointed to when it was checked, time out after 10 seconds, and do not follow redirects.', requestBody: body({ type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string', enum: WEBHOOK_EVENTS }, description: 'Leave out to get every event.' } } }), responses: ok({ type: 'object' }) },
      },
      '/webhooks/{id}': { parameters: [idParam], delete: { summary: 'Remove a webhook (needs a key with the "admin" scope)', responses: ok({ type: 'object' }) } },
      '/webhooks/deliveries/{id}/redeliver': { parameters: [idParam], post: { summary: 'Send a past delivery again, exactly as it was (needs a key with the "admin" scope)', description: `Works for the latest ${KEEP_BODIES} deliveries of each webhook. Answers 409 while the delivery is still being tried.`, responses: ok({ type: 'object' }) } },
      '/public/verify': { post: { summary: 'Check whether a PDF is an unmodified completed document', security: [], requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } } } }, responses: ok({ type: 'object', properties: { match: { type: 'boolean' }, hash: str } }) } },
      '/public/check': { post: { summary: 'Check the security code from a signing email', security: [], requestBody: body({ type: 'object', required: ['code'], properties: { code: str } }), responses: ok({ type: 'object', properties: { genuine: { type: 'boolean' } } }) } },
    },
  };
}

route('GET', '/openapi.json', () => json(openapi(), 200, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' }), 'public');
