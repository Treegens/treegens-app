// Organisations above accounts (routes-orgs.ts), as part of /api/openapi.json. Kept apart so the main description
// stays readable; openapi.ts spreads it into its paths. None of these routes take an API key.
import { ORG_POLICY_KEYS, ORG_MAX_DEPTH } from '../lib/orgs.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any = { type: 'object' }) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const body = (schema: any) => ({ required: true, content: { 'application/json': { schema } } });
const str = { type: 'string' };
const p = (...names: string[]) => names.map((name) => ({ name, in: 'path', required: true, schema: str }));
const ADMIN = 'Only for a person signed in to the app who is an admin of this organisation or of one above it; anyone else gets 404, an API key 403.';
const OP = 'Only for a confirmed login listed in OPERATOR_EMAILS; anyone else gets 404.';
const policy = {
  type: 'object',
  description: `The rules an organisation passes down. Each is a floor: every account below is brought up to it at once and can ask for more, never for less (409 with code "set_by_organisation" otherwise). A rule sent as null is taken out, which loosens nothing anyone has. Keys: ${ORG_POLICY_KEYS.join(', ')}.`,
  properties: {
    two_step_required: { type: 'boolean', enum: [true], nullable: true }, one_session: { type: 'boolean', enum: [true], nullable: true },
    min_password_length: { type: 'integer', minimum: 9, maximum: 64, nullable: true }, idle_minutes: { type: 'integer', minimum: 15, maximum: 480, nullable: true },
    impact_display: { type: 'string', enum: ['off'], nullable: true }, ai_helper: { type: 'string', enum: ['off'], nullable: true },
  },
};

export const orgPaths = () => ({
  '/operator/orgs': {
    get: { summary: 'Every organisation (operator)', description: OP, responses: ok() },
    post: { summary: 'Make an organisation and name its first admin (operator)', description: `${OP} The admin needs a login with a confirmed address (409 "no_login" otherwise). "parent_id" puts it below another; organisations nest at most ${ORG_MAX_DEPTH} deep.`, requestBody: body({ type: 'object', required: ['name', 'admin_email'], properties: { name: str, admin_email: str, parent_id: str } }), responses: ok() },
  },
  '/operator/orgs/{id}/break-glass': { parameters: p('id'), put: { summary: 'Allow or stop emergency access to documents for the admins of an organisation (operator)', description: `${OP} Every account below gets a line in its security record.`, requestBody: body({ type: 'object', required: ['allowed'], properties: { allowed: { type: 'boolean' } } }), responses: ok() } },
  '/operator/accounts/{id}/org': { parameters: p('id'), put: { summary: 'Move an account to another organisation, or out of all (operator)', description: `${OP} The account is brought up to the rules of its new organisation at once.`, requestBody: body({ type: 'object', required: ['org_id'], properties: { org_id: { type: 'string', nullable: true } } }), responses: ok() } },
  '/orgs': { get: { summary: 'The organisations I am an admin of', description: 'Empty for everyone else, and for an API key.', responses: ok() } },
  '/orgs/{id}': { parameters: p('id'), get: { summary: 'An organisation: its rules and where each comes from, organisations and agencies below, admins', description: `${ADMIN} No document, title or field value of any agency. "reach" counts the agencies and people below (for the question before a rule that can lock people out); "ai_available" says whether a model answers the help chat on this server at all.`, responses: ok() } },
  '/orgs/{id}/orgs': { parameters: p('id'), post: { summary: 'Make an organisation below this one', description: ADMIN, requestBody: body({ type: 'object', required: ['name'], properties: { name: str } }), responses: ok() } },
  '/orgs/{id}/policy': { parameters: p('id'), put: { summary: 'Change the rules this organisation passes down', description: `${ADMIN} 409 when a rule asks for less than an organisation above already asks. A rule sent as null is taken away: each agency below gets back what it had before the rule, unless it changed that setting itself since ("accounts_given_back" counts them).`, requestBody: body(policy), responses: ok() } },
  '/orgs/{id}/admins': { parameters: p('id'), post: { summary: 'Add an admin', description: `${ADMIN} They need a login with a confirmed address, and must not be an owner or admin of an agency below (409).`, requestBody: body({ type: 'object', required: ['email'], properties: { email: str } }), responses: ok() } },
  '/orgs/{id}/admins/{user}': { parameters: p('id', 'user'), delete: { summary: 'Take an admin off', description: `${ADMIN} The last admin of a top organisation cannot be taken off (409).`, responses: ok() } },
  '/orgs/{id}/agencies': { parameters: p('id'), post: { summary: 'Make an agency (an account) and invite its first owner', description: `${ADMIN} The owner is always invited by email and joins by accepting; the answer ({ emailed: true, joined: false }) is the same whether a login exists for the address. An admin of an organisation above cannot be named (409 "org_admin").`, requestBody: body({ type: 'object', required: ['name', 'owner_email'], properties: { name: str, owner_email: str, owner_name: str } }), responses: ok() } },
  '/orgs/{id}/agencies/{aid}/members': { parameters: p('id', 'aid'), get: { summary: "An agency's people: names, addresses, roles, two-step login on or off", description: ADMIN, responses: ok() } },
  '/orgs/{id}/agencies/{aid}/people': { parameters: p('id', 'aid'), post: { summary: 'Name another owner or admin of an agency', description: `${ADMIN} Someone already on the agency's team with a confirmed address gets the role at once ("joined": true); anyone else is invited by email. Never an admin of this organisation or one above (409 "org_admin").`, requestBody: body({ type: 'object', required: ['email', 'role'], properties: { email: str, role: { type: 'string', enum: ['owner', 'admin'] } } }), responses: ok() } },
  '/orgs/{id}/agencies/{aid}/members/{uid}': { parameters: p('id', 'aid', 'uid'), patch: { summary: 'Make a member an admin, or an admin a member', description: `${ADMIN} An owner's role is not changed here (409). An admin of this organisation or one above is never made admin (409 "org_admin"), also not of themselves.`, requestBody: body({ type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['admin', 'member'] } } }), responses: ok() } },
  '/orgs/{id}/agencies/{aid}/members/{uid}/two-step/reset': { parameters: p('id', 'aid', 'uid'), post: { summary: "Switch off a member's two-step login so they set it up again", description: `${ADMIN} The same rules as POST /account/members/{id}/two-step/reset: never an owner, only someone this agency speaks for alone, with the admin's own code when they have two-step login. The person is emailed.`, requestBody: body({ type: 'object', properties: { code: str } }), responses: ok() } },
  '/orgs/{id}/agencies/{aid}/sending': { parameters: p('id', 'aid'), put: { summary: 'Switch sending off or on for an agency', description: `${ADMIN} Off: nothing new is emailed from the agency (as a pause does); its owners and admins are emailed.`, requestBody: body({ type: 'object', required: ['on'], properties: { on: { type: 'boolean' } } }), responses: ok() } },
  '/orgs/{id}/agencies/{aid}/break-glass': { parameters: p('id', 'aid'), post: { summary: 'Emergency access to one document of an agency', description: `${ADMIN} Only where the operator allowed it for this organisation or one above it (403 "break_glass_off" otherwise). A reason of at least 15 characters; the agency's owners and admins are emailed at once and its security record gets a line. Answers the PDF. At most 5 a day per admin.`, requestBody: body({ type: 'object', required: ['envelope_id', 'reason'], properties: { envelope_id: str, reason: str } }), responses: { 200: { description: 'The PDF', content: { 'application/pdf': {} } }, default: err } } },
  '/orgs/{id}/report': { parameters: p('id'), get: { summary: 'Counts per agency: sent, completed, average days to complete', description: `${ADMIN} "from" and "to" (YYYY-MM-DD, default the last 90 days). No titles and no names.`, responses: ok() } },
  '/orgs/{id}/events': { parameters: p('id'), get: { summary: 'What was done at the level of this organisation and those below it', description: `${ADMIN} The newest 200. Never the title of a document opened with emergency access: that is in the agency's own security record only.`, responses: ok() } },
});
