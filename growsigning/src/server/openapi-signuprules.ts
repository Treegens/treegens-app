// What the API description says about making an account (src/server/signuprules.ts, src/lib/signup.ts): no "+" in
// the address, one login per mailbox, and a phone number. Kept apart so the busy openapi.ts needs one reference.
import { PLUS_REFUSAL, PHONE_TAKEN, PHONE_WHY } from '../lib/signup.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: any) => ({ content: { 'application/json': { schema } } });
const s = { type: 'string' }, b = { type: 'boolean' };

const phone = { ...s, description: `The person's own phone number. Best in international form (E.164): a plus sign, the country code and the number, such as "+447400123456". A number as it is written at home ("07400 123456") is read with "phone_country". Spaces, dashes, dots and brackets are forgiven. It is kept in international form. Refused with 400 and the code "phone" when it is not a plausible number for its country (too short, too long, letters, a premium-rate number), and with 409 and the code "phone_taken" when another login has it ("${PHONE_TAKEN}"). ${PHONE_WHY} No verification text is sent at sign-up.` };
const phoneCountry = { ...s, description: 'The country the number is written for, as two letters (ISO 3166-1 alpha-2, such as "GB"). Only needed when "phone" does not start with a plus sign.' };
const state = { type: 'object', properties: {
  number: { ...s, nullable: true, description: 'The number, in groups after the country code ("+44 7400 123 456"). null when none was given yet.' },
  verified: { ...b, description: 'true once the number was checked by a code sent as a text message. Only possible on a server that sends text messages.' },
  needed: { ...b, description: 'true while the login still has to give a number.' },
  ask: { ...s, nullable: true, enum: ['now', 'may_wait', 'before_send', null], description: '"now": the app shows only the screen that asks (a login made with Google or Microsoft since the rule), and the server refuses everything else from the login but reading, giving the number and signing out. "may_wait": a login from before the rule is asked once and may say not now. "before_send": it said not now, and is asked again when it sends something new. null: nothing to ask.' },
  can_verify: { ...b, description: 'true when the number is not checked yet and this server can text a code.' },
} };

export const signupRulesPaths = () => ({
  '/auth/signup': {
    post: {
      summary: 'Make a login with an email address, a password and a phone number',
      description: `Public, and limited to 10 new logins an hour from one connection. Makes the login, a workspace of its own (or joins the team of "invite") and signs this browser in with a cookie. The rules for the address: no "+" before the @ (400 with the code "plus_in_email": "${PLUS_REFUSAL}"), and one login per mailbox: addresses that differ only by capital letters, by dots before the @ at gmail.com and googlemail.com, or by googlemail for gmail are the same mailbox (409, code "same_mailbox"). Signs that look like a + count as one, and an address with quotes before the @ or a dot at the very end is refused (400, code "odd_email"). A login that already has a + keeps working. These rules are about the person who makes a login: a document can still be sent to an address with a +. A phone number is required unless the people who run the server switched that off (SIGNUP_PHONE=off). Signing up with Google or Microsoft follows the same address rules; such a login gives its number with POST /me/phone before the app opens, and until then every call from it except reading, POST /me/phone and signing out is refused (403, code "phone_needed"). One number belongs to one login (409, code "phone_taken"); a login whose email address was never confirmed gives the number up to the next person who gives it.`,
      security: [],
      requestBody: { required: true, ...json({ type: 'object', required: ['name', 'email', 'password', 'phone'], properties: {
        name: { ...s, description: 'The person\'s full name.' },
        email: { ...s, format: 'email', description: 'Without a + part before the @. Kept in small letters.' },
        password: { ...s, description: 'At least 8 characters, and not one from a known leak where that check is on.' },
        phone, phone_country: phoneCountry,
        invite: { ...s, description: 'The token of a team invitation sent to this address. The person joins that team and gives their own phone number.' },
        code: { ...s, description: 'A code that makes the plan free, where one was given.' },
        ref: { ...s, description: 'The code of a friend\'s invite link.' },
      } }) },
      responses: { 200: { description: 'The login was made and this browser is signed in.', ...json({ type: 'object', properties: { user: { type: 'object' } } }) }, 400: err, 403: err, 409: err, 429: err },
    },
  },
  '/me/phone': {
    post: {
      summary: 'Give or change the phone number of your own login',
      description: `For a person signed in to the app, never for an API key (403). The same reading and the same refusals as at sign-up. A changed number is no longer a checked one. Nobody else on a team is ever sent this number: it is in no list of members and in no export but its owner's own ("your-login.json"). It is deleted with the login. ${PHONE_WHY}`,
      requestBody: { required: true, ...json({ type: 'object', required: ['phone'], properties: { phone, phone_country: phoneCountry } }) },
      responses: { 200: { description: 'Saved.', ...json({ type: 'object', properties: { ok: b, phone: state } }) }, 400: err, 403: err, 409: err, 429: err },
    },
  },
  '/me/phone/later': {
    post: {
      summary: 'Say "Not now" to the phone number, once',
      description: 'Only for a login from before the rule that has not been asked yet (409 otherwise). The app then opens as before. The number is needed before the next new document is sent from the app, before a new API key is made and before a new public form is published (403 with the code "phone_needed"). Documents that are already out, keys that already work and forms that are already public are not affected.',
      responses: { 200: { description: 'Noted.', ...json({ type: 'object', properties: { ok: b } }) }, 403: err, 409: err },
    },
  },
  '/me/phone/code': {
    post: {
      summary: 'Text a code to your number, to check it (optional)',
      description: 'Only on a server that sends text messages (404 with the code "no_texts" otherwise). Never required for anything. The code has 6 digits and works for 10 minutes; at most 3 are sent in an hour.',
      responses: { 200: { description: 'Sent.', ...json({ type: 'object', properties: { ok: b, minutes: { type: 'integer' } } }) }, 403: err, 404: err, 409: err, 429: err, 502: err },
    },
  },
  '/me/phone/verify': {
    post: {
      summary: 'Type the code from the text message',
      requestBody: { required: true, ...json({ type: 'object', required: ['code'], properties: { code: s } }) },
      responses: { 200: { description: 'The number is checked.', ...json({ type: 'object', properties: { ok: b, verified: b } }) }, 400: err, 403: err, 410: err },
    },
  },
});
