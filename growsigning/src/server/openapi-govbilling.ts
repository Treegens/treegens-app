// Government billing (routes-govbilling.ts, billingmode.ts), as part of /api/openapi.json. openapi.ts spreads it in.
const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any = { type: 'object' }) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const body = (schema: any) => ({ required: true, content: { 'application/json': { schema } } });
const str = { type: 'string' };
const day = { type: 'string', format: 'date' };
const int = { type: 'integer' };
const p = (...names: string[]) => names.map((name) => ({ name, in: 'path', required: true, schema: str }));
const OP = 'Only for a confirmed login listed in OPERATOR_EMAILS; anyone else gets 404, an API key 403.';
const statement = { type: 'object', properties: { year: int, sites: str, planted_from: day, planted_to: day, species: str, trees: int, evidence: { type: 'array', items: str, description: 'https links to the evidence Treegens provided.' } } };
const commitment = { type: 'object', properties: { holder: str, agreement_ref: str, band: str, share_pct: { type: 'number' }, trees_per_year: int, starts_on: day, ends_on: { ...day, nullable: true }, signed_on: day, statements: { type: 'array', items: statement } } };

export const BILLING_MODE_NOTE = 'On a server with BILLING_MODE=deployment (a public body paying one fixed fee a year under a contract), nothing is counted, held or expires, sending never answers 402 and has no daily limit on people (429 for that limit never comes; the fake-notice filter still answers 422), the payment provider is never called, and every route of the plan (/billing, /billing/*, /public/billing/*, /stripe/webhook, /operator/billing/*) answers 404 with a sentence saying so.';

export const govBillingPaths = () => ({
  '/billing-mode': {
    get: {
      tags: ['Account'], summary: 'How this server is paid for', description: `${BILLING_MODE_NOTE} "signatures" is the default, the consumer product. In "deployment", "line" is the sentence Settings, Plan shows in place of the plan, built from LICENSE_HOLDER, AGREEMENT_REF and AGREEMENT_UNTIL; a part not set is left out, and a date that has passed is said as passed (nothing stops on it).`,
      responses: ok({ type: 'object', properties: { mode: { type: 'string', enum: ['signatures', 'deployment'] }, holder: { ...str, nullable: true }, ref: { ...str, nullable: true }, until: { ...day, nullable: true }, ended: { type: 'boolean' }, line: str } }),
    },
  },
  '/public/billing-mode': {
    get: { tags: ['Public'], security: [], summary: 'Which billing mode this server is in, for public pages', description: 'Only the mode, never the agreement: public pages leave out consumer prices, top-ups and per-signature trees when it is "deployment". The holder, reference and dates are for people signed in (GET /billing-mode).', responses: ok({ type: 'object', properties: { mode: { type: 'string', enum: ['signatures', 'deployment'] } } }) },
  },
  '/public/tree-commitments': {
    get: { tags: ['Public'], security: [], summary: 'Tree commitments of signed government contracts, with their yearly planting statements', description: 'Per contract, never per signature: share_pct of the contract fee funds trees_per_year mangroves, whether or not the service is used. Only contracts the operator marked as signed are listed; drafts never are.', responses: ok({ type: 'object', properties: { commitments: { type: 'array', items: commitment } } }) },
  },
  '/operator/tree-commitments': {
    get: { summary: 'Every tree commitment, drafts too (operator)', description: OP, responses: ok() },
    post: { summary: 'Add a tree commitment of a government contract, as a draft (operator)', description: `${OP} 400 with what to change for a missing holder or reference, an unknown band (b100k, b1m, b10m, more), a share outside 0 to 100, trees a year that are not a whole number, or dates that are not YYYY-MM-DD or are in the wrong order.`, requestBody: body({ type: 'object', required: ['holder', 'agreement_ref', 'band', 'share_pct', 'trees_per_year', 'starts_on'], properties: { holder: str, agreement_ref: str, band: str, share_pct: { type: 'number' }, trees_per_year: int, starts_on: day, ends_on: day } }), responses: ok() },
  },
  '/operator/tree-commitments/{id}/signed': { parameters: p('id'), post: { summary: 'Mark a commitment as a signed contract, or back to a draft (operator)', description: `${OP} signed must be the boolean true or false (anything else is refused with 400). Signed needs signed_on, a day that has come. Only signed ones are public.`, requestBody: body({ type: 'object', required: ['signed'], properties: { signed: { type: 'boolean' }, signed_on: day } }), responses: ok() } },
  '/operator/tree-commitments/{id}/statements': { parameters: p('id'), post: { summary: 'Add the planting statement of a year (operator)', description: `${OP} Every field is required; evidence is one or more https links (at most 20). A year or a planting day that has not come yet is refused, and so are planting days outside the year the statement covers or outside the contract's dates, and a second statement for the same year (409).`, requestBody: body({ type: 'object', required: ['year', 'sites', 'planted_from', 'planted_to', 'species', 'trees', 'evidence'], properties: { year: int, sites: str, planted_from: day, planted_to: day, species: str, trees: int, evidence: { oneOf: [str, { type: 'array', items: str }] } } }), responses: ok() } },
  '/operator/tree-commitments/{id}/statements/{sid}': { parameters: p('id', 'sid'), delete: { summary: 'Remove a planting statement (operator)', description: OP, responses: ok() } },
});
