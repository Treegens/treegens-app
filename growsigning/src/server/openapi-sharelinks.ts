// What the API description says about share links (src/server/routes-sharelinks.ts and sharelinks.ts). Kept apart so
// the busy openapi.ts only needs one reference to it.
import { SHARE_NAME_MIN, SHARE_NAME_MAX } from '../lib/sharename.ts';
import { SHARE_LOOKUPS_PER_MINUTE, SHARE_CODE_ASKS_PER_HOUR, SHARE_CODE_TRIES_PER_TEN_MINUTES, SIGNER_CODE_MINUTES, SIGNER_CODE_TRIES, SHARE_CLOSED_NAMED_DAYS } from '../lib/policy.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: any) => ({ content: { 'application/json': { schema } } });
const obj = (properties: any, required?: string[]) => ({ type: 'object', ...(required ? { required } : {}), properties });
const s = { type: 'string' }, b = { type: 'boolean' }, n = { type: 'integer' };
const idParam = { name: 'id', in: 'path', required: true, schema: s };
const nameParam = { name: 'name', in: 'path', required: true, schema: s, description: 'The name in the address: small letters, digits and hyphens.' };

const NAME_RULES = `A name is ${SHARE_NAME_MIN} to ${SHARE_NAME_MAX} small letters, digits and single hyphens, and holds at least one letter. What you send is tidied first: accents are taken off, capitals made small and spaces turned into hyphens. Refused with 422 "share_name": the address of a page the site has or may get, the name of this service or a look-alike of it, "official" or "verified", the name of another signing service, bank or mail service, a name made only of the words of a notice such as "billing", "support" and "account-suspended", and a name that reads as a well-known brand. A name another document or form has, or that another account ever had, is refused with 409 "share_name_taken". Both carry "suggestion": a name that is free right now, or null.`;

/** The share link of an envelope or a form, as GET /envelopes/{id} and GET /powerforms carry it. */
export const SHARE_LINK_PROP = {
  ...obj({ name: { ...s, description: 'The name in the address.' }, url: { type: 'string', format: 'uri', description: 'The whole address, built from APP_URL.' }, active: { ...b, description: 'false while its sender has it switched off.' } }),
  nullable: true, readOnly: true,
  description: 'The readable address of this document or form, such as https://growsigning.com/garden-agreement, or null when it has none. Set it with PUT .../share-link.',
};
const answer = obj({ share_link: SHARE_LINK_PROP, suggestion: { ...s, nullable: true, description: 'When there is no link yet: the name it would get, free right now.' }, can_share: { ...b, description: 'false for a draft and for a closed document.' } });
const change = obj({ name: { ...s, description: 'The name to give it. Leave out to keep the name it has, or to take the suggestion when it has none.' }, active: { ...b, description: 'false switches the link off, true on again.' } });

export const sharelinksPaths = () => ({
  '/envelopes/{id}/share-link': {
    get: {
      summary: 'The share link of a document',
      description: 'A share link is a readable address for a document that is out for signing, for a chat, a poster or a QR code. Whoever opens it sees the name of the document, the name of its sender and the names of the people whose turn it is, picks their own name, and proves it with a 6-digit code sent to the address you gave for that name. Only then do they reach their own signing page. Addresses are never shown, and the emailed invitations work as before. A document has no share link until its sender makes one (or the server runs with SHARE_LINKS_AUTO=1).',
      parameters: [idParam], responses: { 200: { description: 'The link, or the name it would get.', ...json(answer) }, default: err },
    },
    put: {
      summary: 'Make, rename, switch off or switch on the share link of a document',
      description: `An empty body makes the link under the suggested name. ${NAME_RULES} Renaming stops the old address: whoever opens it is told that the link was changed, and the old name stays kept for this same document, so nobody else can take it over. Only for a document that is out for signing (409 otherwise), except {"active": false}, which also switches off the link of a closed document. When the document is completed, voided, declined or has run out, the address says so in a sentence and lets nobody in. Each change is a line in the document's history.`,
      parameters: [idParam], requestBody: { required: true, ...json(change) }, responses: { 200: { description: 'The link as it now stands.', ...json(answer) }, default: err },
    },
  },
  '/powerforms/{id}/share-link': {
    get: { summary: 'The share link of a public form', description: 'A form gets a readable address when it is made, when a free name comes out of its name. The address with the slug (/f/...) keeps working beside it, also while the share link is switched off.', parameters: [idParam], responses: { 200: { description: 'The link, or the name it would get.', ...json(answer) }, default: err } },
    put: { summary: 'Make, rename, switch off or switch on the share link of a public form', description: `For whoever may change the form. ${NAME_RULES}`, parameters: [idParam], requestBody: { required: true, ...json(change) }, responses: { 200: { description: 'The link as it now stands.', ...json(answer) }, default: err } },
  },
  '/public/share/{name}': {
    get: {
      summary: 'What the page at a share link shows',
      description: `No sign-in. "state" is "open" (with "title", "sender", "people": a name and a key for each person whose turn it is, "later": how many sign after them, "plants": trees a signature here plants, 0 when nothing is said), "form" (with "slug" and "title": the public form at /f/{slug}), "off" (also for a form that is switched off) or "renamed" (nothing else is said), "completed", "voided", "declined", "expired" or "paused" (nobody to pick; "title" and "sender" for ${SHARE_CLOSED_NAMED_DAYS} days after closing, null after that), or "unavailable". A name nobody has, a name that is not written like one and the address of a page all answer 404 in the same words. Never an email address, an id or a signing link. At most ${SHARE_LOOKUPS_PER_MINUTE} lookups a minute from one internet address.`,
      security: [], parameters: [nameParam],
      responses: { 200: { description: 'The page.', ...json(obj({ state: s, title: { ...s, nullable: true }, sender: { ...s, nullable: true }, people: { type: 'array', items: obj({ key: s, name: s }) }, later: n, plants: n, slug: s })) }, default: err },
    },
  },
  '/public/share/{name}/code': {
    post: {
      summary: 'Send the picked person their code',
      description: `No sign-in. "person": the key of a name from GET /public/share/{name}. A 6-digit code goes to the address the sender gave for that name. The answer holds neither the code nor the address. The code works for ${SIGNER_CODE_MINUTES} minutes. Limits: one code a minute and five an hour for a person, a daily limit for each mailbox, and ${SHARE_CODE_ASKS_PER_HOUR} requests an hour from one internet address (429, with "resend_in" seconds when a short wait is enough). 409 "share_closed" when the link is not open, 409 "share_person" when the key is nobody whose turn it is.`,
      security: [], parameters: [nameParam], requestBody: { required: true, ...json(obj({ person: s }, ['person'])) },
      responses: { 200: { description: 'Sent.', ...json(obj({ sent: b, digits: n, minutes: n, resend_in: n })) }, default: err },
    },
  },
  '/public/share/{name}/code/check': {
    post: {
      summary: 'Check the code and get the signing page',
      description: `No sign-in. With the right code the answer is "url": the path of that person's own signing page, the same one their emailed invitation opens. An access code the sender set is still asked for there. ${SIGNER_CODE_TRIES} wrong tries end a code (423), and one internet address can try ${SHARE_CODE_TRIES_PER_TEN_MINUTES} codes in ten minutes. The document's history records that the person came in through the share link.`,
      security: [], parameters: [nameParam], requestBody: { required: true, ...json(obj({ person: s, code: s }, ['person', 'code'])) },
      responses: { 200: { description: 'Right.', ...json(obj({ ok: b, url: s })) }, default: err },
    },
  },
});
