// The account's own consent text, as part of /api/openapi.json (routes-disclosure.ts). Kept apart so the main
// description stays readable; openapi.ts spreads it into its paths.
import { OWN_TEXT_KEYS, OWN_TEXT_MAX, OWN_TEXT_LABEL, DEFAULT_NEEDS, ESIGN_NOTE, WITHDREW_REASON, NEVER_AGREED_REASON } from '../lib/disclosure.ts';
import { AGREED_AGAIN_MAX, SAVES_PER_HOUR } from './disclosure.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const str = { type: 'string' };
const bool = { type: 'boolean' };
const tok = { name: 'token', in: 'path', required: true, schema: str };

const parts = Object.fromEntries(OWN_TEXT_KEYS.map((k) => [k, { ...str, maxLength: OWN_TEXT_MAX[k], description: `${OWN_TEXT_LABEL[k]}.${k === 'needs' ? ` Left empty, signers read: "${DEFAULT_NEEDS}"` : ''}` }]));
const TEXT = { type: 'object', description: 'The parts of the text for one language. Plain text only: nothing in it becomes a link. The organisation name, one way to reach it (email, phone or postal address), how to ask for a paper copy and how to stop are needed.', required: ['org', 'paper', 'withdraw'], properties: parts };
const VERSION = {
  type: 'object', properties: {
    id: str, language: str, version: { type: 'integer', description: 'Counts up from 1 for each language.' }, ...parts,
    sections: { type: 'array', description: 'The text as a signer reads it: our short headings with the account\'s words under them, kept as they were when the version was saved.', items: { type: 'object', properties: { h: str, lines: { type: 'array', items: str } } } },
    sha256: { ...str, description: 'SHA-256 of the words as the evidence pack prints them. The consent line in the audit trail names it.' }, saved_at: { ...str, format: 'date-time' }, saved_by: { ...str, nullable: true },
  },
};
const WHAT = `An account can put its own words on the screen where a person agrees to electronic records and signatures, under GrowSigning's own sentence on what kind of signature this is, which always stays. With no text saved, nothing about any screen, audit line or file changes. GrowSigning shows the words as written and does not check them against any law. ${ESIGN_NOTE}`;
const STATE = { type: 'object', properties: {
  each_visit: { ...bool, description: 'true: the consent screen is shown every time the link is opened. false (the default): once for each document.' },
  languages: { type: 'array', items: str, description: 'The languages that are switched on. A text can be saved for each.' },
  texts: { type: 'object', description: 'By language: the version shown today, or null.', additionalProperties: { ...VERSION, nullable: true } },
  default_needs: str, limits: { type: 'object', additionalProperties: { type: 'integer' } }, note: str, has_versions: bool,
} };

/** What POST /sign/{token}/consent takes and writes when the account has a text of its own. */
const CONSENT_OWN_NOTE = `When the account has its own consent text for this person's language, GET /sign/{token} carries it as "own_terms" ({id, version, language, org, sections, note, each_visit}) and the call that agrees must send its id back as "own". An id that is not the version in use answers 409 with code "terms", and the page shows the current text first. The audit line then also says "Also shown the sender's own consent text, version N in <language>, SHA-256 ...", and the evidence pack holds those words in consent-own-text.txt. With "each_visit" on, the page asks again every time the link is opened, and each time is a line "Agreed again to electronic records and signatures" (at most ${AGREED_AGAIN_MAX} for one person on one document).`;

export const disclosurePaths = () => ({
  '/account/disclosure': {
    get: { tags: ['Account'], summary: 'The account\'s own consent text: what signers are shown today, by language (admins)', description: WHAT, responses: ok(STATE) },
    put: {
      tags: ['Account'], summary: 'Save the account\'s own consent text, stop showing it, or change how often it is shown (admins)',
      description: `${WHAT} Every save that changes a word makes a new version; a saved version is never changed, and it is kept for as long as a document refers to it. Saving the same words again makes no version ("unchanged": true). "text": null stops showing the text in that language and keeps its versions. A person whose language has no text is shown the English one with one sentence saying why, and only GrowSigning's words when there is no English one. At most ${SAVES_PER_HOUR} new versions an hour. An account that has not paid yet is refused a text that reads like a payment notice from a well-known company (422). Refusals are in words and change nothing. The change is written to the security record, without the words.`,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
        language: { ...str, description: 'The language of "text", as a code that is switched on. English when left out.' },
        text: { ...TEXT, nullable: true },
        each_visit: bool,
      } } } } },
      responses: ok({ allOf: [STATE, { type: 'object', properties: { saved: { type: 'object', nullable: true, properties: { language: str, version: { type: 'integer' }, id: str } }, unchanged: bool } }] }),
    },
  },
  '/account/disclosure/versions': {
    get: {
      tags: ['Account'], summary: 'Every version of the account\'s own consent text, newest first (admins)',
      parameters: [{ name: 'language', in: 'query', schema: str, description: 'Only this language.' }],
      description: 'Each with "shown_now" (it is the one signers see today) and "documents" (how many documents have someone on record as shown it). There is no call that changes or deletes a version.',
      responses: ok({ type: 'object', properties: { versions: { type: 'array', items: { allOf: [VERSION, { type: 'object', properties: { shown_now: bool, documents: { type: 'integer' } } }] } } } }),
    },
  },
  '/sign/{token}/consent': {
    post: {
      tags: ['Signing'], security: [], parameters: [tok],
      summary: 'A signer agrees to electronic records and signatures',
      description: `Written to the audit trail once for each person, with the wording of GrowSigning's own text the screen showed ("wording") and its language ("language"). ${CONSENT_OWN_NOTE}`,
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { wording: str, language: str, own: { ...str, description: 'The id of the account\'s own text the screen showed ("own_terms.id"), when there is one.' }, tz: { ...str, description: 'The time zone the device reports.' } } } } } },
      responses: ok({ type: 'object', properties: { ok: bool, version: { type: 'integer' }, wording: str } }),
    },
  },
  '/sign/{token}/decline/paper': {
    post: {
      tags: ['Signing'], security: [], parameters: [tok],
      summary: 'A signer asks for the document on paper instead, which stops signing on screen',
      description: `What "Sign on paper instead" on the signing page does, shown there when the account has its own consent text. The person's part closes like a decline, so the document is closed for everyone, with the reason "${WITHDREW_REASON}" for someone who had agreed and "${NEVER_AGREED_REASON}" for someone who had not. The audit trail gets "Declined" and a line with that reason as its action. The sender is emailed whatever their notification choices are, because only they can send the paper: GrowSigning prints and posts nothing. Refused for someone who was only asked to read, for a witness, and once the document is no longer open (409).`,
      responses: ok({ type: 'object', properties: { ok: bool, reason: str } }),
    },
  },
});
