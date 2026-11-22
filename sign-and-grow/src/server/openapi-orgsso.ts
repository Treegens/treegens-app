// Single sign-on for an organisation, as part of /api/openapi.json (routes-orgsso.ts, orgsso.ts, oidc.ts). Kept
// apart so the main description stays readable; openapi.ts spreads it into its paths.
import { DOMAINS_MAX, DOMAIN_CHECK_HOURS, SSO_CALLBACK_PATH, SSO_ERRORS, SSO_NAME_MAX, SSO_SESSION_HOURS_DEFAULT, TXT_PREFIX, TXT_VALUE_PREFIX } from '../lib/orgsso.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const bool = { type: 'boolean' };
const str = { type: 'string' };
const int = { type: 'integer' };
const idParam = { name: 'id', in: 'path', required: true, schema: str };
const code = { ...str, description: 'The code from the authenticator app (or a recovery code) of the person changing it, when they have two-step login.' };
const PERSON = 'Owner or admin, signed in to the app: an API key gets 403. Without FILE_ENCRYPTION_KEY on the server every change answers 409 with code "sso_unavailable", because the client secret could not be kept safely.';
const domain = {
  type: 'object',
  properties: {
    id: str, domain: str, use_sso: { ...bool, description: 'People at this domain go to the account\'s sign-in service.' },
    state: { ...str, enum: ['waiting', 'claimed', 'lost'], description: `waiting: the TXT record was never found. claimed: found; the domain is this account's and no other account can claim it. lost: the daily check (every ${DOMAIN_CHECK_HOURS} hours) did not find it any more; single sign-on is paused for the domain until it is back, and the admins were emailed.` },
    verified_at: { ...str, nullable: true }, checked_at: { ...str, nullable: true }, lost_at: { ...str, nullable: true }, created_at: str,
    record: { type: 'object', description: `The TXT record to add: name ${TXT_PREFIX}.<domain>, value ${TXT_VALUE_PREFIX}<random>.`, properties: { type: str, name: str, value: str } },
  },
};
const service = {
  type: 'object', nullable: true,
  properties: {
    name: str, issuer: str, client_id: str, has_secret: bool,
    enforce: { ...bool, description: 'Everyone at the claimed domains that use it signs in through it: password, sign-up, Google and Microsoft are refused for those addresses (403, code "sso_required"), except the owner\'s way back in.' },
    join_new: { ...bool, description: 'People from the domains become members of this account on their first sign-in through it. Off by default.' },
    tested_at: { ...str, nullable: true, description: 'When an admin last signed in through it with success. Until then the sign-in page does not offer it, and enforce cannot be switched on.' },
    tested_by: { ...str, nullable: true }, updated_at: str,
  },
};

export const orgSsoPaths = () => ({
  '/account/sso': {
    get: {
      tags: ['Account'], summary: 'Single sign-on of the account: its email domains and its sign-in service (owner and admins)',
      description: `OpenID Connect, authorization code flow with PKCE (S256), state and nonce. The service's addresses come from <issuer>/.well-known/openid-configuration (kept for an hour, https only, its "issuer" must equal the one set). The issuer, token and key-list hosts must lead to public addresses, checked each time the document is fetched and on every sign-in. ID tokens must be signed with RS256 or ES256 by a key in the service's key list (fetched again when a token names a key it does not hold), and their iss, aud, exp, iat and nonce are checked. Answers {"available": false} and nothing else when the server has no FILE_ENCRYPTION_KEY. Not here: SAML, SCIM, sub-domains.`,
      responses: ok({ type: 'object', properties: { available: bool, domains: { type: 'array', items: domain }, service, redirect_uri: { ...str, description: `APP_URL + ${SSO_CALLBACK_PATH}: register it at the service.` }, session_hours: { ...int, description: `SSO_SESSION_HOURS (default ${SSO_SESSION_HOURS_DEFAULT}): how long a browser of someone at an enforced domain stays signed in.` }, owner_two_step: bool, code_needed: bool } }),
    },
    put: {
      tags: ['Account'], summary: 'Add or change the sign-in service',
      description: `${PERSON} Creating needs name (1 to ${SSO_NAME_MAX} characters, shown on the button "Continue with <name> sign-in"), issuer (https), client_id and client_secret; afterwards any of them, and no client_secret keeps the saved one. A new issuer is checked at once: it must lead to a public host and answer a discovery document as described above (400 with "why" otherwise). A new issuer or client id clears tested_at, removes every login's connection to the old one (each person is connected again by their address the next time they sign in), and is refused with 409 code "enforced" while enforce is on. The secret is kept encrypted and never sent back.`,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: str, issuer: str, client_id: str, client_secret: str, code } } } } },
      responses: ok({ type: 'object', properties: { service } }),
    },
    delete: { tags: ['Account'], summary: 'Remove single sign-on', description: `${PERSON} People at the domains sign in the usual way again. The domains stay; every login's connection to the service goes.`, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { code } } } } }, responses: ok({ type: 'object', properties: { ok: bool } }) },
  },
  '/account/sso/rules': {
    patch: {
      tags: ['Account'], summary: 'Switch "everyone signs in through it" and "add people as members" on or off',
      description: `${PERSON} Switching enforce on needs a successful try (409 "try_first"), at least one claimed domain that uses it (409 "no_domain"), and the owner's two-step login (409 "owner_two_step"): the owner's password with two-step login is the way back in if the service breaks (POST /auth/login with "way_back": true), and each use is a line "sso.way_back" in the security record. Asked for by anyone but the owner, way_back is answered 403 "sso_required" before the password is looked at. While enforce is on, POST /me/two-step/off is refused for the owner and POST /account/transfer-owner to someone without two-step login, both with 409 "sso_way_back". Switching it on gives every signed-in browser at those domains an end within session_hours.`,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { enforce: bool, join_new: bool, code } } } } },
      responses: ok({ type: 'object', properties: { service } }),
    },
  },
  '/account/sso/domains': {
    post: { tags: ['Account'], summary: 'Claim an email domain', description: `${PERSON} At most ${DOMAINS_MAX} per account. 409 "domain_taken" when another account holds it and its record still stands.`, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { domain: str } } } } }, responses: ok({ type: 'object', properties: { domain } }) },
  },
  '/account/sso/domains/{id}/check': {
    post: { tags: ['Account'], summary: 'Look the TXT record up now', description: `${PERSON} "found" is found, missing or unknown (the DNS did not answer; nothing changed).`, parameters: [idParam], responses: ok({ type: 'object', properties: { domain, found: { ...str, enum: ['found', 'missing', 'unknown'] } } }) },
  },
  '/account/sso/domains/{id}': {
    patch: { tags: ['Account'], summary: 'Use the service for this domain, or not', description: `${PERSON} While enforce is on, needs the two-step code like the switch itself (403 "code_needed").`, parameters: [idParam], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { use_sso: bool, code } } } } }, responses: ok({ type: 'object', properties: { domain } }) },
    delete: { tags: ['Account'], summary: 'Remove a domain', description: `${PERSON} While enforce is on, needs the two-step code (403 "code_needed").`, parameters: [idParam], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { code } } } } }, responses: ok({ type: 'object', properties: { ok: bool } }) },
  },
  '/account/sso/try': {
    post: { tags: ['Account'], summary: '"Try a sign-in": the admin goes through the service once', description: `${PERSON} Answers the service's address to send the browser to. It comes back to ${SSO_CALLBACK_PATH} and then to /app/settings?tab=security with sso=tried, or sso_error=<code>.`, responses: ok({ type: 'object', properties: { url: str } }) },
  },
  '/sso/lookup': {
    get: {
      tags: ['Auth'], security: [], summary: 'Whether an email address signs in through its organisation\'s service',
      description: 'Asked by the sign-in page as the person leaves the email box. Only the domain is looked at, never whether a login exists. "password" is "allowed" or, when everyone at the domain signs in through the service, "owner_only".',
      parameters: [{ name: 'email', in: 'query', required: true, schema: str }],
      responses: ok({ type: 'object', properties: { sso: { type: 'object', nullable: true, properties: { name: str, password: { ...str, enum: ['allowed', 'owner_only'] } } } } }),
    },
  },
  '/sso/start': {
    get: { tags: ['Auth'], security: [], summary: 'Start a sign-in through the organisation\'s service', description: `Redirects to the service (302), or back to /login with sso_error=<code> (${SSO_ERRORS.join(', ')}).`, parameters: [{ name: 'email', in: 'query', required: true, schema: str }, { name: 'next', in: 'query', schema: str }, { name: 'invite', in: 'query', schema: str }], responses: { 302: { description: 'To the service, or back to the sign-in page' } } },
  },
  '/sso/callback': {
    get: { tags: ['Auth'], security: [], summary: 'Where the service sends the browser back to', description: 'Works once, only in the browser that started, within 10 minutes. The address in the token must be at a claimed domain of the account that uses the service, and not marked unconfirmed. An existing login with that address is connected and its owner emailed; a new one is made otherwise (a member of the account when join_new is on). Two-step login of the login is still asked for.', responses: { 302: { description: 'Signed in, or back to the sign-in page with sso_error' } } },
  },
});
