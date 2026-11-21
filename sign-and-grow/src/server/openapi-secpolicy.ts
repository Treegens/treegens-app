// The sign-in rules of an account, as part of /api/openapi.json (routes-secpolicy.ts, secpolicy.ts, pwned.ts). Kept
// apart so the main description stays readable; openapi.ts spreads it into its paths.
import { PASSWORD_MIN, PASSWORD_RULE_MAX, IDLE_MIN_MINUTES, IDLE_MAX_MINUTES, IDLE_WARN_SECONDS, PWNED_TIMEOUT_MS, QUIET_HEADER } from '../lib/signinrules.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const str = { type: 'string' };
const tok = { name: 'token', in: 'path', required: true, schema: str };

const LEAK = `Every new password (sign-up, the emailed link, Settings) is also looked up in the Pwned Passwords list of passwords from data leaks, and refused with code "password_leaked" when it is there. Only the first 5 characters of the password's SHA-1 leave the server; the rest is compared here. When the list does not answer within ${PWNED_TIMEOUT_MS / 1000} seconds, or answers something that is not the list, the password is allowed and nothing says it was checked. PWNED_CHECK=0 switches the check off; HIBP_RANGE_URL names another copy of the list.`;
const rules = {
  type: 'object',
  properties: {
    min_password_length: { ...int, description: `Members choose a password of at least this many characters (${PASSWORD_MIN} to ${PASSWORD_RULE_MAX}; ${PASSWORD_MIN} is no rule). It applies when a password is chosen, also when someone joins. A member whose password is shorter is asked for a longer one the next time they sign in with it, and until then the API answers 403 with code "password_too_short" to everything of the account but their own login. Lowering it holds a member who was shorter than the old rule until their password is next typed (signing in, or the current password when changing it), since its length is never kept. The owner is never held by it.` },
    idle_minutes: { ...int, nullable: true, description: `A browser not used for this long (${IDLE_MIN_MINUTES} to ${IDLE_MAX_MINUTES} minutes) is signed out; null: never. The card offers 15, 30, 60, 120, 240 and 480; any whole number inside the limits is kept. Requests with the header "${QUIET_HEADER}: 1" (the page's own looks: the time left, and waiting for an email to be confirmed) do not count as use. The app says so ${IDLE_WARN_SECONDS / 60} minutes before and offers "Stay signed in".` },
    one_session: { ...bool, description: 'Each person is signed in to this account in one browser at a time: arriving in another signs the earlier one out. Switching it on signs extra browsers out at once.' },
    limits: { type: 'object', properties: { password: { type: 'array', items: int }, idle_minutes: { type: 'array', items: int }, warn_seconds: int } },
    leak_check: { ...bool, description: 'Whether new passwords are looked up in the leaked-password list on this server.' },
    two_step_required: { ...bool, description: 'Everyone must use two-step login (changed with POST /account/two-step).' },
    code_needed: { ...bool, description: 'Changing the rules needs the code from the authenticator app of the person changing them.' },
  },
};
const left = { type: 'object', properties: { minutes: { ...int, nullable: true, description: 'The rule of the account this browser is in; null without one.' }, seconds_left: { ...int, nullable: true, description: 'Before this browser is signed out for no use.' } } };

export const secPolicyPaths = () => ({
  '/account/rules': {
    get: {
      tags: ['Account'], summary: 'The sign-in rules of the account (owner and admins)',
      description: `Three rules, all off until someone sets them. A rule applies to a browser while it works in this account; for a person on several teams, the one their browser is in decides. API keys are not affected by any of them. ${LEAK} There is deliberately no rule for passwords that expire, for capitals or digits, or for security questions: NIST SP 800-63B advises against them.`,
      responses: ok(rules),
    },
    patch: {
      tags: ['Account'], summary: 'Change the sign-in rules',
      description: 'Only a person signed in to the app (an API key gets 403), owner or admin. Send any of the three; a number outside its limits is refused with 400 and "field", and nothing is changed. Someone with two-step login sends "code" too. Each change is a line of the security record (settings.changed), and every browser a rule signs out is one too (session.ended). A browser that a rule signed out gets 401 with code "signed_out" and "why": "idle" or "elsewhere".',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { min_password_length: int, idle_minutes: { ...int, nullable: true, description: 'null, 0 or false switches it off.' }, one_session: bool, code: str } } } } },
      responses: ok({ ...rules, properties: { ...rules.properties, ok: bool, signed_out: { ...int, description: 'Browsers signed out at once by switching "one_session" on.' } } }),
    },
  },
  '/me/idle': {
    get: { tags: ['Account'], summary: 'How long this browser has before the idle rule signs it out', description: `Send the header "${QUIET_HEADER}: 1" and asking does not count as use. Past the limit the answer is 401 with "why": "idle".`, responses: ok(left) },
  },
  '/me/idle/stay': {
    post: { tags: ['Account'], summary: '"Stay signed in": this browser is in use', description: 'The clock of the idle rule starts again. The app sends it at most once a minute while someone types or taps.', responses: ok(left) },
  },
  '/operator/leak-check': {
    get: {
      tags: ['Operator'], summary: 'Whether this server looks new passwords up in the leaked-password list',
      description: 'Only for the addresses in OPERATOR_EMAILS (anyone else gets 404). "why" is "outside_calls" when OUTSIDE_CALLS=none switched the check off, "setting" when PWNED_CHECK or HIBP_RANGE_URL did, and null while it is on.',
      responses: ok({ type: 'object', properties: { on: bool, why: { ...str, nullable: true, enum: ['outside_calls', 'setting'] } } }),
    },
  },
  '/sign/{token}/away': {
    get: {
      tags: ['Signing'], security: [], parameters: [tok],
      summary: 'The signing page checks its link again after a break',
      description: 'Only asked by the signing page of an account with "Sign out after N minutes", on the first action after a break longer than that (GET /sign/{token} then carries "away_minutes"). The link is looked up exactly as when the page is opened, and refused in the same words when it no longer opens. Nothing is changed and nothing is lost.',
      responses: ok({ type: 'object', properties: { ok: bool, minutes: { ...int, nullable: true }, status: { ...str, description: 'The envelope status now.' }, version: { ...int, nullable: true }, done: { ...bool, description: 'This person has finished.' } } }),
    },
  },
});
