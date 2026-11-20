// The click-to-agree part of /api/openapi.json (routes-clickwrap.ts), kept apart so the main description stays
// readable. openapi.ts spreads it into its paths; the test that every documented path exists covers it too.
import { clickwrapMonthlyLimit, CLICKWRAP_PER_ADDRESS_HOUR, CLICKWRAP_PER_ADDRESS_AGREEMENT_HOUR, CLICKWRAP_WARN_PERCENT } from '../lib/policy.ts';
import { TERMS_MAX_CHARS, WHO_MAX_DAYS, VIEW_MAX_HOURS, CLICK_LAW } from '../lib/clickwrap.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const body = (schema: any) => ({ required: true, content: { 'application/json': { schema } } });
const pdf = { 200: { description: 'A PDF file', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, default: err };
const s = { type: 'string' };
const b = { type: 'boolean' };
const i = { type: 'integer' };
const idParam = { name: 'id', in: 'path', required: true, schema: s };
const person = { type: 'object', properties: { id: { ...s, nullable: true }, name: { ...s, nullable: true }, email: { ...s, nullable: true } } };
const acceptance = {
  type: 'object', description: 'One acceptance, as it was recorded. It is never changed afterwards.',
  properties: {
    id: s, agreement_id: s, agreement: s, version: i, terms_sha256: { ...s, description: 'SHA-256 of the exact terms shown: of the text as written, or of the PDF file.' }, accepted_at: { ...s, format: 'date-time' },
    identity: { type: 'string', enum: ['website', 'typed', 'api'], description: '"website": the details came in a link the website signed with the key of the agreement. "typed": the visitor typed them and nobody checked them. "api": the website sent them through POST /clickwraps/{id}/acceptances.' },
    person, via: { type: 'string', enum: ['hosted', 'embed', 'api'] }, page_url: { ...s, nullable: true, description: 'The page it came from, as the browser reported it (or as the website said, for "api").' },
    ip: s, user_agent: s, given_ip: { ...s, nullable: true, description: '"api" only: the visitor\'s address as the website gave it.' }, given_user_agent: { ...s, nullable: true },
    seconds_open: { type: 'number', nullable: true, description: 'How long the terms were open before the press, measured by this server.' }, scrolled: { ...b, nullable: true }, button_uncovered: { ...b, nullable: true, description: 'Whether the browser said nothing covered the button (Chrome and Edge can tell); null where it could not tell.' },
    recorded_by: { ...s, nullable: true }, intact: { ...b, description: 'false when the stored record no longer fits the seal it was written with.' },
  },
};
const filters = [
  { name: 'agreement', in: 'query', schema: s, description: 'An agreement id.' }, { name: 'q', in: 'query', schema: s, description: 'Part of a name, an email address or the website\'s id for the person, or a whole acceptance id.' },
  { name: 'version', in: 'query', schema: i }, { name: 'via', in: 'query', schema: { type: 'string', enum: ['hosted', 'embed', 'api'] } }, { name: 'identity', in: 'query', schema: { type: 'string', enum: ['website', 'typed', 'api'] } },
  { name: 'from', in: 'query', schema: s, description: 'A day, YYYY-MM-DD, in UTC.' }, { name: 'to', in: 'query', schema: s, description: 'A day, YYYY-MM-DD, in UTC, counted in.' },
];
const draft = {
  type: 'object', properties: {
    name: { ...s, maxLength: 120 }, format: { type: 'string', enum: ['text', 'pdf'] }, text: { ...s, maxLength: TERMS_MAX_CHARS, description: 'Plain text. A line starting with "# " is a heading ("## " a smaller one), "- " or "* " a list item, "1. " a numbered one, **two stars** make words bold, an empty line starts a paragraph. Nothing else is read: no links, no HTML.' },
    file_id: { ...s, nullable: true, description: 'A PDF uploaded with POST /files.' }, checkbox: { ...s, maxLength: 200, description: 'The words next to the tick box. Empty for the default.' }, button: { ...s, maxLength: 200 },
    scroll: { ...b, description: 'The button works only after the terms were scrolled to the end, checked by the visitor\'s browser.' }, signed_only: { ...b, description: 'Only people the website names in a signed link can accept. Takes effect at once; not a version.' },
  },
};

export function clickwrapPaths() {
  const limit = clickwrapMonthlyLimit();
  return {
    '/clickwraps': {
      get: { summary: 'Click-to-agree terms of the account (owner and admins)', description: `Each with its state ("draft", "live", "closed" by the team, or "stopped" with "why": the account is paused or closing, or the terms read like a fake payment notice while the account has not earned trust), its public page and how often it was accepted. "usage" is the account's count this month against the limit of this server (${limit}), over every agreement. An acceptance is not a signature and costs none.`, responses: ok({ type: 'object' }) },
      post: { summary: 'Start new terms as a draft (owner and admins)', description: 'Nothing is shown to anyone until it is published. Every agreement gets a page at /agree/{slug} and a key of its own for the links its website signs.', requestBody: body({ ...draft, required: ['name'] }), responses: ok({ type: 'object', properties: { id: s, url: s } }) },
    },
    '/clickwraps/{id}': {
      parameters: [idParam],
      get: { summary: 'One agreement: its draft, versions, key, snippets and who has to accept again (owner and admins)', responses: ok({ type: 'object' }) },
      patch: { summary: 'Change the draft or a setting (owner and admins)', description: 'Only what the call names changes. The draft is shown to nobody until it is published. "active": false closes the page (the records stay); true opens it again. Yes and no are true and false, never in quotes.', requestBody: body({ ...draft, properties: { ...draft.properties, active: b } }), responses: ok({ type: 'object' }) },
      delete: { summary: 'Delete terms that nobody has accepted (owner and admins)', description: 'Answers 409 once anyone has accepted them: records are kept for as long as the account exists. Close them instead.', responses: ok({ type: 'object' }) },
    },
    '/clickwraps/{id}/publish': { parameters: [idParam], post: { summary: 'Publish the draft as the next version (owner and admins)', description: 'Any change to the terms, their name, the words of the box or the button, or the scrolling rule is a new version; nothing changed answers 409. From version 2 a "note" of what changed is needed: people asked to accept again are shown it. "ask_again" (default true) makes everyone who accepted an earlier version accept again; false keeps earlier acceptances counting, for a correction that changes no meaning. Answers how many people are asked again, in "asked_again" and in words in "again". 422 when the terms read like a fake payment notice, carry a well-known brand\'s name, or are a PDF of pictures, for an account that has not earned trust. 403 while the account is paused.', requestBody: body({ type: 'object', properties: { note: { ...s, maxLength: 500 }, ask_again: b } }), responses: ok({ type: 'object', properties: { version: i, sha256: s, asked_again: i, again: s } }) } },
    '/clickwraps/{id}/secret': { parameters: [idParam], post: { summary: 'Make a new key for the links the website signs (owner and admins)', description: 'Links signed with the old key stop working at once.', responses: ok({ type: 'object', properties: { secret: s, note: s } }) } },
    '/clickwraps/{id}/acceptances': { parameters: [idParam], post: {
      summary: 'Record an acceptance your website collected itself (any key)',
      description: `For terms the website showed on its own pages. The record says everywhere that the website recorded it through the API and that Sign&Grow did not see a click, with who made the call. "version", when given, must be the version that is live (409 otherwise). The same person (by id, or by email when there is no id) on the same version is one record: the answer is the first one with "already": true. 409 with "code": "closed" when the terms are not taking acceptances, with the reason. 429 with "code": "monthly_limit" when the account has recorded ${limit} acceptances this calendar month (UTC); the admins are emailed at ${CLICKWRAP_WARN_PERCENT} percent and when it is reached.`,
      requestBody: body({ type: 'object', required: ['person'], properties: { person: { ...person, description: 'id (your own) or email is needed.' }, version: i, page_url: s, ip: { ...s, description: 'The visitor\'s address, as you saw it.' }, user_agent: s } }),
      responses: ok({ type: 'object', properties: { acceptance, already: b } }),
    } },
    '/clickwraps/{id}/status': { parameters: [idParam], get: {
      summary: 'Has this person accepted the version that counts? (any key)',
      description: 'By person_id (your own id: only acceptances from your signed links or the API carry one) or by email. "accepted" is true when their newest acceptance is of "counts_from_version" or later. "latest.identity" says how that acceptance came about: a visitor can type anybody\'s email address, so decide which kinds you trust.',
      parameters: [{ name: 'person_id', in: 'query', schema: s }, { name: 'email', in: 'query', schema: s }],
      responses: ok({ type: 'object', properties: { agreement_id: s, current_version: { ...i, nullable: true }, counts_from_version: { ...i, nullable: true }, accepted: b, latest: { ...acceptance, nullable: true }, versions_accepted: { type: 'array', items: i } } }),
    } },
    '/clickwrap-acceptances': { get: { summary: 'Look acceptances up (owner and admins)', description: 'Newest first, 50 at a time (up to 200 with "limit"); "next_before" goes further back. "total" counts every match.', parameters: [...filters, { name: 'limit', in: 'query', schema: i }, { name: 'before', in: 'query', schema: i }], responses: ok({ type: 'object', properties: { total: i, acceptances: { type: 'array', items: acceptance }, next_before: { ...i, nullable: true } } }) } },
    '/clickwrap-acceptances/export': { get: { summary: 'The same as CSV (owner and admins)', description: 'UTF-8 with a byte order mark. A cell that starts with =, +, - or @ gets a \' in front, so a typed name cannot run as a formula in a spreadsheet.', parameters: filters, responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: s } } }, default: err } } },
    '/clickwrap-acceptances/{id}': { parameters: [idParam], get: { summary: 'One acceptance, with what its record shows and does not (owner and admins)', responses: ok({ type: 'object', properties: { acceptance, shows: { type: 'object', properties: { shows: s, not: s } }, law: s } }) } },
    '/clickwrap-acceptances/{id}/certificate': { parameters: [idParam], get: { summary: 'The certificate of one acceptance, as PDF (owner and admins)', description: `The record, what it shows and what it does not, whether it still fits its seal, and the terms as shown (a PDF's pages follow). ${CLICK_LAW}`, responses: pdf } },
    '/public/agree/{slug}': { parameters: [{ name: 'slug', in: 'path', required: true, schema: s }], get: {
      summary: 'What the page /agree/{slug} shows', security: [],
      description: `The live version, what is recorded and what a record shows, and a "view" to accept with. "who" and "sig" in the query name the visitor: "who" is base64url of JSON {id, name, email, exp}, "sig" the HMAC-SHA256 of that exact text with the key of the agreement, in base64url or hex. "exp" (seconds since 1970) is required and at most ${WHO_MAX_DAYS} days ahead. A link that does not check out is refused in words with a "code" (who_not_signed, who_expired, who_exp_ms, who_no_exp, who_exp_far, who_nobody, who_bad_email, who_incomplete, who_unreadable) and never falls back to typed details. Terms that cannot be accepted answer "closed": true with a sentence and nothing else.`,
      parameters: [{ name: 'who', in: 'query', schema: s }, { name: 'sig', in: 'query', schema: s }, { name: 'embed', in: 'query', schema: s }],
      responses: ok({ type: 'object' }),
    } },
    '/public/agree/{slug}/terms': { parameters: [{ name: 'slug', in: 'path', required: true, schema: s }], get: { summary: 'The PDF of the live terms, when they are a PDF', security: [], responses: pdf } },
    '/public/agree/{slug}/accept': { parameters: [{ name: 'slug', in: 'path', required: true, schema: s }], post: {
      summary: 'Accept, from the page or the frame', security: [],
      description: `Needs the "view" of the page: a press always belongs to the version that was on the screen (409 "terms_changed" when a new version came in between, "view_old" after ${VIEW_MAX_HOURS} hours). "agree" must be true. With "scrolled" true when the terms ask for it. Without "who" and "sig", "name" and "email" are needed, unless the agreement takes only people the website names (403 "signed_only"). Answers the acceptance and a "receipt", the visitor's own secret for the copy by email and the certificate; it is kept nowhere but in that answer. ${CLICKWRAP_PER_ADDRESS_HOUR} acceptances an hour from one address, ${CLICKWRAP_PER_ADDRESS_AGREEMENT_HOUR} on one agreement. 429 "monthly_limit" says only that the terms cannot be accepted right now.`,
      requestBody: body({ type: 'object', required: ['view', 'agree'], properties: { view: s, agree: b, scrolled: b, who: s, sig: s, name: s, email: s, embed: b, page_url: s, unobscured: b } }),
      responses: ok({ type: 'object', properties: { acceptance: { type: 'object' }, receipt: s, already: b, email: b } }),
    } },
    '/public/agree/receipt/email': { post: { summary: 'Email the visitor a copy of what they accepted', security: [], description: 'To the address recorded with the acceptance, with the certificate attached. Once an hour for each acceptance; 409 when no address was given.', requestBody: body({ type: 'object', required: ['receipt'], properties: { receipt: s } }), responses: ok({ type: 'object', properties: { sent: b, status: s, to: s } }) } },
    '/public/agree/receipt/{receipt}/certificate': { parameters: [{ name: 'receipt', in: 'path', required: true, schema: s }], get: { summary: 'The visitor\'s certificate, by their receipt', security: [], responses: pdf } },
    '/public/agree/{slug}/report': { parameters: [{ name: 'slug', in: 'path', required: true, schema: s }], post: { summary: 'Report the page as suspicious', security: [], description: 'Goes to the people who review reports. Anyone can open such a page, so a report never counts towards pausing the account by itself.', requestBody: body({ type: 'object', properties: { reason: s, detail: s, email: s } }), responses: ok({ type: 'object', properties: { ok: b, already: b } }) } },
  };
}
