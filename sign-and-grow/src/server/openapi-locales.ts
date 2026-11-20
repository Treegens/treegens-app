// The language part of /api/openapi.json (src/server/locales.ts), kept apart so the main description stays readable.
// openapi.ts puts `localeProp` on a recipient and spreads `localePaths()` into its paths.
import { shippedLocales } from '../lib/i18n.ts';

const s = { type: 'string' };
const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };

const AVAILABLE = () => `Available now: ${shippedLocales().map((t) => `"${t}"`).join(', ')}.`;

/** A recipient's "locale". */
export const localeProp = () => ({
  ...s, nullable: true,
  description: `The language of our screens for this person, as a language code (BCP 47, such as "en"). ${AVAILABLE()} A language that is not available yet answers 400, names the ones that are, and saves nothing. null or "" lets their browser decide, among the available languages, then English. Left out, a recipient keeps the one saved; a new one starts with the account's "default_locale" (PATCH /account). It changes only what Sign&Grow itself shows: the subject, the message, the documents, notes and everything else you write are never translated. Until a language's legal texts (what a signer agrees to, what kind of signature this is) have been checked by a person, those parts are shown in English with one sentence in that language saying why, and the audit line of each person's consent names the language of the words they were shown. Templates keep it, and so do copies. When you use a template through POST /envelopes, a role filled in through "recipients" may carry "locale". A public form uses the visitor's browser.`,
});

/** A bulk row's "language" for a role, beside "name" and "email". */
export const rowLanguageProp = () => ({
  ...s,
  description: `The language for that person, as a language code. ${AVAILABLE()} One that is not available refuses the whole batch with 400 before anything is sent (POST /bulk/check says so in "refusal"). Left out, the template's language for the role is used, else the person's browser decides.`,
});

export function localePaths() {
  return {
    '/account': {
      patch: {
        summary: 'Change the account settings: here, the language new recipients start in',
        description: `For admins. This describes "default_locale"; the other settings of this call are the ones under Settings, Account, and a setting left out stays as it is. "default_locale" is the language the editor and this API give each new recipient that names none. ${AVAILABLE()} null or "" lets each person's browser decide, then English. A language that is not available answers 400 and changes nothing. GET /me returns it under "account".`,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { default_locale: { ...s, nullable: true } } } } } },
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } }, default: err },
      },
    },
  };
}
