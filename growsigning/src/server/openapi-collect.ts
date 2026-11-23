// Ask for a payment, taken by card while signing, as part of /api/openapi.json (routes-collect.ts). openapi.ts
// spreads it into its paths.
import { COLLECT_FOR_MAX } from '../lib/collect.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const str = { type: 'string' };
const bool = { type: 'boolean' };
const tok = { name: 'token', in: 'path', required: true, schema: str };
const idParam = { name: 'id', in: 'path', required: true, schema: str };
const RULE = 'The money goes into the sending account\'s own Stripe account (Stripe Connect, a direct charge on that account). GrowSigning is never the merchant, never sees card details (people pay on Stripe\'s own Checkout page) and takes no fee. A payment is "paid" only after Stripe\'s signed message says so for that connected account and Stripe confirms it again when asked; before that it is "Payment started, not confirmed". Only on a server with STRIPE_CONNECT_CLIENT_ID, STRIPE_CONNECT_SECRET_KEY (or STRIPE_SECRET_KEY) and STRIPE_CONNECT_WEBHOOK_SECRET, and not with BILLING_MODE=deployment; elsewhere these routes answer 404 or { available: false }. Asked only by accounts that may show a payment link (the same trust rule as /envelopes/{id}/pay-link), never of people on the sender\'s own team.';
const setting = { type: 'object', nullable: true, properties: {
  amount: { type: 'integer', nullable: true, description: 'A fixed amount in the currency\'s smallest unit (cents).' }, field_id: { ...str, nullable: true, description: 'Or the number or calculated field that holds the amount.' },
  currency: str, for: str, when: { type: 'string', enum: ['before', 'after'] }, amount_text: { ...str, nullable: true }, field_label: { ...str, nullable: true }, field_gone: bool,
} };

export const collectPaths = () => ({
  '/collect/connection': {
    get: { tags: ['Account'], summary: 'Whether this account connected its own Stripe account', description: RULE, responses: ok({ type: 'object', properties: { available: bool, connected: { type: 'object', nullable: true, properties: { name: str, livemode: bool, connected_at: str } }, may: bool, why: { ...str, nullable: true }, open_asking: { type: 'integer', description: 'Admins: documents out for signing that ask for a payment.' } } }) },
    delete: { tags: ['Account'], summary: 'Disconnect the Stripe account (admins)', description: 'Stripe is told as well. People who sign from now on are not asked to pay; payments already made stay in the Stripe account.', responses: ok({ type: 'object', properties: { disconnected: bool, open_asking: { type: 'integer' } } }) },
  },
  '/collect/connect': {
    post: { tags: ['Account'], summary: 'Start connecting the account\'s own Stripe account (admins)', description: `${RULE} Answers the address of Stripe's connect page. Stripe sends the browser back to /api/collect/callback, which goes on to Settings, Sending.`, responses: ok({ type: 'object', properties: { url: str } }) },
  },
  '/collect/callback': {
    get: { tags: ['Account'], summary: 'Where Stripe sends the browser back after connecting', security: [], description: 'Answers 303 to /app/settings?tab=sending&collect=connected, declined or failed; a browser that is no longer signed in goes to /login first, and back to Settings after. The state is used once, by the person who started it, within 15 minutes.', responses: { 303: { description: 'Back to Settings' } } },
  },
  '/collect/webhook': {
    post: { tags: ['Account'], security: [], summary: 'Stripe Connect events', description: 'Point a Connect webhook endpoint (events on connected accounts) here, with checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, checkout.session.expired, charge.refunded, charge.dispute.created, charge.dispute.updated, charge.dispute.closed and account.application.deauthorized. Checked with the Stripe-Signature header against STRIPE_CONNECT_WEBHOOK_SECRET (at most 5 minutes old) and applied once per event id. An event for another connected account than the payment\'s changes nothing. A payment on an earlier Stripe page of the same person (the amount changed since) still counts, for what was paid; a second payment for the same person answers done "paid_twice", is written in the history and emailed to the sender to refund. After account.application.deauthorized, a payment on a page that was already open is recorded from the signed event alone, since Stripe no longer answers for that account.', responses: ok({ type: 'object', properties: { received: bool, done: { type: 'string', description: 'paid, paid_twice, waiting, expired, refunded, disputed, disconnected, ignored or duplicate.' } } }) },
  },
  '/envelopes/{id}/collect': {
    get: { tags: ['Envelopes'], parameters: [idParam], summary: 'The payment a document or template asks for, and each person\'s state', description: RULE, responses: ok({ type: 'object', properties: { available: bool, setting, pay_link: bool, fields: { type: 'array', items: { type: 'object', properties: { id: str, label: str } } }, people: { type: 'array', items: { type: 'object', properties: { id: str, name: str, state: { ...str, nullable: true, description: 'ready, started, expired, paid, partly_refunded, refunded, disputed or not_asked.' }, line: { ...str, nullable: true }, amount: { ...str, nullable: true } } } } } }) },
    put: {
      tags: ['Envelopes'], parameters: [idParam], summary: 'Ask for a payment, change it or take it off',
      description: `Set and changed on a draft or a template; once sent it can only be taken off ({ "off": true }). Give "amount" ("25.00") or "field_id" (a number or calculated field of the document), "currency" (three letters), "for" (what it is for, ${COLLECT_FOR_MAX} characters at most, no web address) and "when": "before" (the person's part completes only once Stripe confirms the payment; Finish answers 402 with code "pay_first" until then) or "after" (signing never waits). Refused with 409 while the document has a link to the sender's own payment page, unless "replace_link": true: the link is then taken off, only once the payment itself was accepted, and the answer says "pay_link_removed": true.`,
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { amount: str, field_id: str, currency: str, for: str, when: { type: 'string', enum: ['before', 'after'] }, off: bool, replace_link: bool } } } } },
      responses: ok({ type: 'object', properties: { setting, pay_link_removed: bool } }),
    },
  },
  '/sign/{token}/collect': {
    get: { tags: ['Signing'], security: [], parameters: [tok], summary: 'The payment the signing page shows', description: 'null for a document that asks for none, for someone on the sender\'s team, and where it cannot be asked. state: ahead (one line before signing, with amount or field), ready (time to pay), started (Stripe has not confirmed yet), paid, partly_refunded, refunded or disputed.', responses: ok({ type: 'object', properties: { collect: { type: 'object', nullable: true } } }) },
  },
  '/sign/{token}/collect/start': {
    post: { tags: ['Signing'], security: [], parameters: [tok], summary: 'The Stripe page to pay on', description: 'Only after Finish was pressed. Gives the page already open if there is one, so two are never open at once; { waiting: true } when that page was already paid and Stripe\'s confirming message has not arrived yet (it is never counted as paid before that message). An earlier page of the same person, made before the amount changed, is closed at Stripe first; when it turns out to be paid, that payment counts and the answer is { paid: true }. When Stripe cannot be reached to close it, 503 and no new page.', responses: ok({ type: 'object', properties: { url: str, waiting: bool, paid: bool } }) },
  },
});
