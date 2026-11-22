// SAML 2.0 sign-in and members from a directory (SCIM 2.0), as part of /api/openapi.json (routes-saml.ts,
// routes-scim.ts, saml.ts, scim.ts). Kept apart so the main description stays readable; openapi.ts spreads it in.
import { SAML_ACS_PATH, SAML_SP_PATH, SAML_METADATA_MAX, SAML_REQUEST_MINUTES, SAML_CLOCK_SECONDS, SCIM_BASE_PATH, SCIM_TOKEN_PREFIX, SCIM_PAGE_MAX, SCIM_CALLS_PER_MINUTE } from '../lib/samlscim.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const bool = { type: 'boolean' };
const str = { type: 'string' };
const int = { type: 'integer' };
const code = { ...str, description: 'The code from the authenticator app (or a recovery code) of the person changing it, when they have two-step login.' };
const PERSON = 'Owner or admin, signed in to the app: an API key gets 403. Without FILE_ENCRYPTION_KEY on the server every change answers 409 with code "sso_unavailable".';
const scimErr = { description: 'A SCIM error: {"schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"], "status": "<code>", "scimType": "...", "detail": "what happened and what to do"}. 401 for a wrong, missing or replaced token; 403 while the account is closing or its single sign-on is not working; 429 after ' + SCIM_CALLS_PER_MINUTE + ' calls in a minute.', content: { 'application/scim+json': { schema: { type: 'object' } } } };
const scimOk = (description: string, status = 200) => ({ [status]: { description, content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimUser' } } } }, default: scimErr });
const bearer = [{ scimToken: [] }];
const DIR_PERSON = `${PERSON} Only the owner or someone with the built-in Admin role: a role an admin made (even one based on Admin) gets 403 with code "role_too_narrow", because the directory can remove admins.`;
const idParam = { name: 'id', in: 'path', required: true, schema: str };
const userBody = { required: true, content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimUser' } } } };
const directory = {
  type: 'object',
  properties: {
    offered: { ...bool, description: 'Single sign-on was tried with success: only then can a token be made.' },
    base_url: { ...str, description: `APP_URL + ${SCIM_BASE_PATH}: give it to the directory.` },
    token: { type: 'object', nullable: true, properties: { prefix: str, made_at: str, made_by: { ...str, nullable: true }, last_used_at: { ...str, nullable: true } } },
    managed: { ...bool, description: 'Members are managed by the directory: POST /account/invites answers 409 "managed_by_directory".' },
    heir: { type: 'object', nullable: true, description: 'Who takes over what a member removed by the directory sent. null: the owner.', properties: { id: str, name: str } },
    people: { ...int, description: 'People the directory has switched on.' },
    may_change: { ...bool, description: 'This person may make the token and change the card (the owner or the built-in Admin role).' },
  },
};

/** The ScimUser schema for components.schemas. */
export const scimSchemas = () => ({
  ScimUser: {
    type: 'object', description: 'A person as SCIM 2.0 (RFC 7643) shows them. Only these attributes are kept; others are accepted and not stored.',
    properties: {
      schemas: { type: 'array', items: str }, id: { ...str, readOnly: true }, externalId: str,
      userName: { ...str, description: 'The person\'s email address, at one of the account\'s claimed domains. It cannot change afterwards (400 "mutability").' },
      name: { type: 'object', properties: { givenName: str, familyName: str, formatted: { ...str, readOnly: true } } }, displayName: str,
      emails: { type: 'array', items: { type: 'object', properties: { value: str, primary: bool, type: str } } },
      active: { ...bool, description: 'false removes the person from the team, like an admin removing them; true adds them again. Also accepted as the strings "True" and "False".' },
      meta: { type: 'object', readOnly: true, properties: { resourceType: str, created: str, lastModified: str, location: str } },
    },
  },
});

export const samlScimPaths = () => ({
  '/account/sso/saml': {
    put: {
      tags: ['Account'], summary: 'Use SAML 2.0 for the account\'s sign-in service: a name and the identity provider\'s metadata',
      description: `${PERSON} metadata: the identity provider's metadata XML (at most ${SAML_METADATA_MAX} characters, one IDPSSODescriptor, no DOCTYPE), with a SingleSignOnService for the HTTP-Redirect binding at an https address and at least one signing certificate that has not ended. Left out, the saved metadata is kept. Each problem answers 400 with what to do. A new entity id (or a move from OpenID Connect) clears tested_at, removes every login's connection to the old service, and is refused with 409 "enforced" while enforce is on; new certificates or a new sign-in address of the same entity id keep it tried (a key rollover). Give the identity provider saml.entity_id and saml.acs_url from GET /account/sso. Checking answers: the assertion must be signed by a certificate in the metadata (a signed Response alone is not enough), its Issuer is the metadata's entity id, its Audience our entity id, a bearer SubjectConfirmation names ${SAML_ACS_PATH} as Recipient with a NotOnOrAfter still ahead (${SAML_CLOCK_SECONDS} seconds allowed for clocks) and the id of the request this browser's sign-in sent (valid ${SAML_REQUEST_MINUTES} minutes, used once) as InResponseTo, and an assertion id is accepted only once. The signature is checked by @node-saml/node-saml. Not supported: signed AuthnRequests, encrypted assertions, sign-ins the identity provider starts by itself, single logout.`,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: str, metadata: str, code } } } } },
      responses: ok({ type: 'object', properties: { ok: bool } }),
    },
  },
  [`${SAML_SP_PATH.replace(/^\/api/, '')}{sp}`]: {
    get: { tags: ['Auth'], security: [], summary: 'Our SAML metadata for one account (also its entity id)', parameters: [{ name: 'sp', in: 'path', required: true, schema: str }], responses: { 200: { description: 'application/samlmetadata+xml' }, 404: err } },
  },
  [SAML_ACS_PATH.replace(/^\/api/, '')]: {
    post: { tags: ['Auth'], security: [], summary: 'Where the identity provider posts its answer (HTTP-POST binding)', description: 'Form fields SAMLResponse and RelayState. The answer is checked as described under PUT /account/sso/saml and answered 303: to /sso/saml/finish, or back to the sign-in page (or Settings, for "Try a sign-in") with sso_error. For "Try a sign-in" only, a refused answer also carries sso_why: unsigned, issuer, recipient, audience, no_email, clock, refused or other, which the Settings card turns into what to change at the identity provider.', requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { SAMLResponse: str, RelayState: str } } } } }, responses: { 303: { description: 'On to the finish, or back with sso_error' } } },
  },
  '/sso/saml/finish': {
    get: { tags: ['Auth'], security: [], summary: 'Ends a SAML sign-in in the browser that started it', description: 'Needs the cookie set when the sign-in started, within 2 minutes of the answer, once. Then the same as /sso/callback.', parameters: [{ name: 'state', in: 'query', required: true, schema: str }], responses: { 302: { description: 'Signed in, or back with sso_error' } } },
  },
  '/account/directory': {
    get: { tags: ['Account'], summary: 'Members from your directory (SCIM): the card', description: 'Owner or admin, signed in. {"available": false} without FILE_ENCRYPTION_KEY.', responses: ok({ type: 'object', properties: { available: bool, ...directory.properties } }) },
    patch: { tags: ['Account'], summary: 'Switch "Members are managed by your directory", choose who takes over', description: `${DIR_PERSON} managed has effect only while single sign-on works: once it is removed or stops working, the directory is paused and invitations by hand work again. heir_id: a member of the team who is not closing their login, or null for the owner. 404 when no token was made.`, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { managed: bool, heir_id: { ...str, nullable: true } } } } } }, responses: ok({ type: 'object', properties: { directory } }) },
  },
  '/account/directory/token': {
    post: { tags: ['Account'], summary: 'Make the directory\'s bearer token', description: `${DIR_PERSON} Needs single sign-on tried with success first (409 "sso_first"). The token starts with "${SCIM_TOKEN_PREFIX}", is in this answer only, and replaces any earlier token at once. Only its SHA-256 is kept.`, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { code } } } } }, responses: ok({ type: 'object', properties: { token: str, directory } }) },
    delete: { tags: ['Account'], summary: 'Stop the directory', description: `${DIR_PERSON} The token stops working and "managed" goes off. Everyone stays on the team.`, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { code } } } } }, responses: ok({ type: 'object', properties: { ok: bool } }) },
  },
  '/scim/v2/ServiceProviderConfig': { get: { tags: ['SCIM'], security: bearer, summary: 'What this SCIM service supports', responses: { 200: { description: 'OK' }, default: scimErr } } },
  '/scim/v2/Users': {
    get: {
      tags: ['SCIM'], security: bearer, summary: 'List people from the directory',
      description: `filter: only userName eq "<address>" and externalId eq "<id>" (400 "invalidFilter" for any other). startIndex from 1, count at most ${SCIM_PAGE_MAX}.`,
      parameters: [{ name: 'filter', in: 'query', schema: str }, { name: 'startIndex', in: 'query', schema: int }, { name: 'count', in: 'query', schema: int }],
      responses: { 200: { description: 'A ListResponse', content: { 'application/scim+json': { schema: { type: 'object', properties: { totalResults: int, startIndex: int, itemsPerPage: int, Resources: { type: 'array', items: { $ref: '#/components/schemas/ScimUser' } } } } } } }, default: scimErr },
    },
    post: { tags: ['SCIM'], security: bearer, summary: 'Add a person', description: 'userName (or a primary email) must be at a claimed domain of the account (400 otherwise; 409 "uniqueness" when known already). Someone with a login there becomes a Member at once and is emailed; someone without one becomes a Member the first time they sign in through the account\'s service. Nobody is made an admin, and roles are never changed.', requestBody: userBody, responses: scimOk('Added', 201) },
  },
  '/scim/v2/Users/{id}': {
    get: { tags: ['SCIM'], security: bearer, summary: 'One person', parameters: [idParam], responses: scimOk('OK') },
    put: { tags: ['SCIM'], security: bearer, summary: 'Replace a person', description: 'Names, displayName and externalId are replaced; active left out stays as it is. active false removes the person from the team as DELETE does with the membership: what they sent passes to the chosen member or the owner, their API keys stop, their browsers in the account are signed out, they and the admins are emailed. The owner is never removed (409).', parameters: [idParam], requestBody: userBody, responses: scimOk('OK') },
    patch: { tags: ['SCIM'], security: bearer, summary: 'Change a person (PatchOp)', description: 'add, replace and remove on active, displayName, externalId, name.givenName and name.familyName, with or without a path. Other attributes are accepted and not kept.', parameters: [idParam], requestBody: { required: true, content: { 'application/scim+json': { schema: { type: 'object', properties: { schemas: { type: 'array', items: str }, Operations: { type: 'array', items: { type: 'object', properties: { op: str, path: str, value: {} } } } } } } } }, responses: scimOk('OK') },
    delete: { tags: ['SCIM'], security: bearer, summary: 'Remove a person', description: 'Removes them from the team (as active false) and forgets them. Their GrowSigning login itself stays. The owner is never removed (409).', parameters: [idParam], responses: { 204: { description: 'Removed' }, default: scimErr } },
  },
  '/scim/v2/Groups': { get: { tags: ['SCIM'], security: bearer, summary: 'Groups are not supported (404)', responses: { 404: scimErr } } },
});
