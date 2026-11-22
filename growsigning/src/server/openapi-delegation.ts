// What the API description says about someone who signs for a person while they are away
// (src/server/routes-delegation.ts), kept apart so the busy openapi.ts only needs one reference to it.
import { DELEGATION_MAX_DAYS, ONLY_NAMED } from '../lib/delegation.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: any) => ({ content: { 'application/json': { schema } } });
const obj = (properties: any, required?: string[]) => ({ type: 'object', ...(required ? { required } : {}), properties });
const s = { type: 'string' }, b = { type: 'boolean' };
const day = { type: 'string', format: 'date', description: 'A day, year-month-day.' };
const mine = obj({ allowed: b, confirmed: b, today: day, active: b, delegate: { ...obj({ id: s, name: s, email: s, starts_on: day, ends_on: day, created_at: s, dates: s }), nullable: true } });

export const delegationPaths = () => ({
  '/account/delegation': {
    get: { summary: 'Whether people in this account may name someone to sign for them while they are away', description: 'Owners and admins. Off by default.', responses: { 200: { description: 'The switch.', ...json(obj({ on: b })) }, default: err } },
    put: {
      summary: 'Allow delegates, or stop them',
      description: 'Owners and admins signed in to the app; an API key gets 403. Written to the security record as "settings.changed" ("delegation"). Turning it off ends every delegation in the account at once, and every delegate link nobody has acted on stops working. A request a delegate already took on stays theirs.',
      requestBody: { required: true, ...json(obj({ on: b }, ['on'])) },
      responses: { 200: { description: 'What it is now.', ...json(obj({ on: b })) }, default: err },
    },
  },
  '/me/delegate': {
    get: { summary: 'Your own delegate, if you named one', description: 'Only in an account that allows delegates ("allowed"). "active": the first day has come. A delegation whose last day is over (in your own time zone) stops by itself: from the next day its links nobody acted on stop working and no reminder goes to the delegate, and it is closed here when it is read.', responses: { 200: { description: 'Your delegate.', ...json(mine) }, default: err } },
    put: {
      summary: 'Name someone who signs for you on some days',
      description: `Signed in to the app with a confirmed address (403 "confirm_email" otherwise; 403 "delegation_off" when the account does not allow it; an API key gets 403). One delegate at a time: a new one replaces the one before, whose links nobody acted on stop working. Both days are included; the last day not before today, the first at most a year ahead, at most ${DELEGATION_MAX_DAYS} days in all. Not your own address. The name is cleaned of characters nobody sees, and refused (400) with < or >, letters of two alphabets in one word, the name of a well-known company, your own name, or the name of someone else in this account at another address. The delegate is emailed at once that you named them. At most 6 saves a day (429). Only requests (signer or approver) sent from this account to your address on those days go to the delegate too: never in person, never a witness, a group, a public form, a document you send yourself, one where the delegate is already a recipient or the sender, or one whose sender ticked "${ONLY_NAMED}". The delegate always types a one-time code sent to their own address. Whoever agrees first takes it on; a delegate signs with their own name and signature, the certificate says "Signed by <delegate> for <you>, under a delegation <you> set on <date> for <days>. GrowSigning does not know whether <delegate> has the authority to sign for <you>.", and you are emailed when they take it on, finish or decline. A delegate cannot pass a request on or change their name on it.`,
      requestBody: { required: true, ...json(obj({ name: s, email: s, starts_on: day, ends_on: day }, ['name', 'email', 'starts_on', 'ends_on'])) },
      responses: { 200: { description: 'Your delegate now.', ...json(mine) }, default: err },
    },
    delete: { summary: 'Stop your delegation now', description: 'Links your delegate has not acted on stop working. 404 when there is none.', responses: { 200: { description: 'Your delegate now (none).', ...json(mine) }, default: err } },
  },
  '/envelopes/{id}/away': {
    post: {
      summary: 'Who on this envelope is away today',
      description: 'For the last step of the editor, by the envelope\'s sender or an admin who sees every document (404 otherwise). "people" are the people as the editor has them now ({ name, email, role, group_id }); without it, the envelope as saved. Answers each signer or approver who named someone to sign for them on today\'s date, in an account that allows it, with the name of that person and never their address. Empty when the account does not allow delegates, on a public form, and for anyone the request would not go to a delegate for (in person, a witness, a group, the sender, a delegate already on it). The editor shows "' + ONLY_NAMED + '" only when this is not empty, or when it is already ticked.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: s }],
      requestBody: { required: false, ...json(obj({ people: { type: 'array', items: obj({ name: s, email: s, role: s, group_id: s }) } })) },
      responses: { 200: { description: 'Who is away.', ...json(obj({ away: { type: 'array', items: obj({ email: s, name: s, delegate: s, role: s }) } })) }, default: err },
    },
  },
  '/envelopes/{id}/only-named': {
    put: {
      summary: `"${ONLY_NAMED}"`,
      description: 'On a draft or an envelope that is out, by its sender or an admin who sees every document. "on": true sends it to the people named only; on an envelope that is out, a delegate who has not acted yet loses their link ("links_stopped" says how many) and it is written to the record. A delegate who already took a request on keeps it, until the sender corrects that recipient to another address (POST /envelopes/{id}/correct): then the request is no longer the delegate\'s, the check the sender chose for the person comes back, and it does not go to the same delegate again. Not on templates. The envelope carries it as "delegate_off" (1 or 0), and each recipient a delegate is involved with carries "delegation": {name, email, for_name, dates, state: open, took or stopped, at}.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: s }],
      requestBody: { required: true, ...json(obj({ on: b }, ['on'])) },
      responses: { 200: { description: 'What it is now.', ...json(obj({ only_named: b, links_stopped: { type: 'integer' } })) }, default: err },
    },
  },
});
