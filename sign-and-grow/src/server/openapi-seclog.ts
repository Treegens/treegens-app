// The security record part of /api/openapi.json (routes-seclog.ts), kept apart so the main description stays readable.
// openapi.ts spreads it into its paths and puts the SecurityEvent schema with the others.
import { SECURITY_KIND_LIST, SECURITY_ALERT_LIST, SECURITY_PAGE_MAX, securityLogWords } from '../lib/seclog.ts';
import { securityLogDays, ALERT_EVERY_MINUTES, KEY_NEW_ADDRESS_PER_DAY } from '../lib/policy.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const s = { type: 'string' };
const who = { type: 'object', properties: { type: { type: 'string', enum: ['user', 'api_key', 'operator', 'system'] }, id: { ...s, nullable: true }, name: { ...s, description: 'Only when the account shares names and email addresses ("emails": true).' }, email: { ...s, description: 'The same.' } } };
const filters = [
  { name: 'kind', in: 'query', schema: s, description: 'One kind, or several separated by commas. Unknown kinds answer 400.' },
  { name: 'person', in: 'query', schema: s, description: 'A user id: lines this person did or that are about them.' },
  { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Lines at or after this moment.' },
  { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Lines before this moment.' },
];

export const securityEventSchema = {
  type: 'object',
  description: `One line of the account's security record. ${securityLogWords(securityLogDays())} Lines are never changed. Each one carries the SHA-256 of the line before it in the same account (prev_hash) and its own (hash), over [prev_hash, account id, at, actor type, actor id, kind, outcome, about type, about id, details as stored, ip, user agent] as a JSON array. The first line kept points at one that has gone after its days. People, keys, invitations, webhooks and envelopes are named by their id; never a password, token, code, key, an email address (unless the account shares them on the way out) or anything from a document.`,
  properties: {
    seq: { type: 'integer', description: 'Grows with every line written on this server: the cursor of GET /account/security-events.' },
    at: { type: 'string', format: 'date-time' }, kind: { type: 'string', enum: SECURITY_KIND_LIST }, what: { ...s, description: 'The kind in words.' },
    outcome: { type: 'string', enum: ['success', 'failure'] }, actor: who,
    about: { type: 'object', nullable: true, properties: { type: { ...s, description: 'user, api_key, invite, webhook, envelope or template.' }, id: s, name: s, email: s } },
    ip: { ...s, nullable: true, description: 'The internet address of a person or key. Never for an operator or the system.' }, user_agent: { ...s, nullable: true },
    details: { type: 'object', description: 'What else the kind says, as values: the sign-in method, a role from and to, a setting from and to (by name only for a logo), the host of a webhook. Never a secret.' },
    prev_hash: s, hash: s,
  },
};

export const seclogPaths = () => ({
  '/account/security-events': {
    get: {
      summary: 'Pull the security record, oldest first (admins and keys with the "admin" scope)',
      description: `For a security system: every line of the account in the order it was written, after the cursor. Keep next_after and ask again with it; a page with nothing new keeps the same cursor, and lines that went after their days are simply not there any more. Up to ${SECURITY_PAGE_MAX} lines a call. A "send" key and a member answer 403. Lines name people by id; with "emails" switched on (PATCH /account/security) they carry names and email addresses too. Written for: sign-ins that worked or failed (to every account the person belongs to; for a login with two-step login a wrong password or code is one reason, "wrong_password_or_code", as the sign-in screen says), signing out, passwords changed or reset, an email address changed, two-step login on, off or reset, Google or Microsoft connected or removed, members invited, joined, removed, role changed or left, the owner handed over, API keys made or revoked, a key used from a new internet address (at most ${KEY_NEW_ADDRESS_PER_DAY} such lines per key a day), webhooks added or removed, exports, envelopes taken out of the lists, deleted for good or put back, template rules, account settings, closing started or undone, and the GrowSigning team pausing, resuming or trusting the account.`,
      parameters: [
        { name: 'after', in: 'query', schema: s, description: 'The next_after of the page before. Leave out to start at the oldest line kept.' },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: SECURITY_PAGE_MAX, default: 100 } },
      ],
      responses: ok({ type: 'object', properties: { events: { type: 'array', items: { $ref: '#/components/schemas/SecurityEvent' } }, next_after: s, has_more: { type: 'boolean' }, days: { type: 'integer' }, note: s } }),
    },
  },
  '/account/security-events/view': {
    get: { summary: 'The security record newest first, filtered, for the Settings screen (admins)', parameters: [...filters, { name: 'before', in: 'query', schema: { type: 'integer' }, description: 'The next_before of the page before.' }], responses: ok({ type: 'object', properties: { events: { type: 'array', items: { allOf: [{ $ref: '#/components/schemas/SecurityEvent' }, { type: 'object', properties: { actor_name: s, about_name: { ...s, nullable: true } } }] } }, next_before: { type: 'integer', nullable: true } } }) },
  },
  '/account/security-events/csv': {
    get: { summary: 'The same lines as a CSV file, newest first (admins)', description: 'Up to 100,000 lines; more answers 413 and asks for fewer days or one kind. Names and email addresses only when the account shares them.', parameters: filters, responses: { 200: { description: 'A CSV file', content: { 'text/csv': { schema: { type: 'string' } } } }, default: err } },
  },
  '/account/security': {
    get: { summary: 'How the security record is kept and shared, and its alerts (admins)', description: 'days and note: how long lines are kept, in words. chain: whether every line kept still matches its fingerprint. webhooks: the ones that receive "security.event". people: the team, for the filter.', responses: ok({ type: 'object', properties: { days: { type: 'integer' }, note: s, alerts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', enum: SECURITY_ALERT_LIST }, label: s, on: { type: 'boolean' } } } }, emails: { type: 'boolean' }, chain: { type: 'object', properties: { whole: { type: 'boolean' }, lines: { type: 'integer' }, head: { ...s, nullable: true }, broken_at: { type: 'integer', nullable: true } } }, webhooks: { type: 'array', items: { type: 'object', properties: { id: s, host: s, created_at: s } } }, people: { type: 'array', items: { type: 'object', properties: { id: s, name: s } } }, pull_url: s } }) },
    patch: {
      summary: 'Switch alerts on or off, and whether names and email addresses leave with the record (a person signed in; no API key)',
      description: `Each alert emails the admins of the account, at most once every ${ALERT_EVERY_MINUTES} minutes for each alert. Every change is a line of the record itself, and switching an alert off is emailed to the other admins. Nobody at GrowSigning watches the record: the alerts are emails.`,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { alerts: { type: 'object', additionalProperties: { type: 'boolean' }, description: `Alert names (${SECURITY_ALERT_LIST.join(', ')}) and true (on) or false (off). Names left out stay as they are.` }, emails: { type: 'boolean' } } } } } },
      responses: ok({ type: 'object' }),
    },
  },
});
