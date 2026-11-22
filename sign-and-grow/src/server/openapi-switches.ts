// Switches for senders and admins, as part of /api/openapi.json (routes-switches.ts, switches.ts). Kept apart so the
// main description stays readable; openapi.ts spreads it into its paths.
import { WAYS_NOTE, MARK_WORDS_DEFAULT, MARK_WORDS_MAX, FORM_LIMIT_MAX } from '../lib/switches.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const bool = { type: 'boolean' };
const str = { type: 'string' };
const id = { name: 'id', in: 'path', required: true, schema: str };

const account = {
  type: 'object',
  properties: {
    pass_on: { ...bool, description: 'People may pass a document to someone else (POST /sign/{token}/reassign). Off: that call is refused with 403, code "pass_on_off", and the signing page has no Pass to someone else. On for a new account.' },
    pass_on_copy: { ...bool, description: 'Someone who passes it on stays on the envelope as someone who gets a copy ("cc", already done), and gets the signed copy when everyone has finished. Both are in the audit trail ("Reassigned", "Kept as a copy"). Not when the new person has the same email address. Their old signing link then answers 410 with code "kept_copy" and words that say they get the signed copy. Passed back to them later, they sign again and their copy row is taken off ("No longer kept as a copy"). Off for a new account.' },
    comments: { ...bool, description: 'Questions and comments on the signing page. On for a new account.' },
    sign_ways: { type: 'array', items: { type: 'string', enum: ['type', 'draw', 'upload'] }, description: `The ways of making a signature or initials the signing page offers, at least one (an empty list is refused with 400). All three for a new account. With fewer than three, a signature saved earlier is not offered, since nobody can say how it was made. The signing page sends how each was made with Finish and with its saves ("signature_how", "initials_how": "type:<style>", "draw", "upload" or "saved"); an envelope takes the ways when it is sent and keeps them. A way the envelope does not offer is refused with 400, code "sign_way_off", with "ways" (the ways it offers); with fewer than three, Finish also refuses a new signature or initials sent without "signature_how" or "initials_how" (unless an earlier save said how). The certificate prints it with "as their signing page reported": it is not proof. ${WAYS_NOTE}` },
    members_stamps: { ...bool, description: 'Members may add Stamp fields. Off: a request from a member that adds a new stamp field is refused with 403, code "stamps_off"; owners and admins are not affected, and stamp fields already on a draft or a sent envelope stay. GET /me then carries "no_stamps": true for a member. On for a new account.' },
    mark_words: { ...str, description: `The large words across every page of a copy made while an envelope is still out, in capitals, at most ${MARK_WORDS_MAX} characters. "${MARK_WORDS_DEFAULT}" until changed; an empty string goes back to it. Words that would make the copy look signed ("FULLY SIGNED", "FINAL") are refused with 400. The small line under them ("NOT EVERYONE HAS SIGNED") and the line at the foot of each page do not change.` },
  },
};
const envelope = {
  type: 'object',
  properties: {
    pass_on: account.properties.pass_on,
    pass_on_copy: account.properties.pass_on_copy,
    comments: { ...bool, description: 'Off: a signer\'s new comment or reply is refused with 403, code "comments_off", with words that say to reply to the email instead; the sender can still answer a conversation that was there and cannot start a new one. What was written before stays readable (GET /sign/{token}/comments says "may_write": false, "comments_off": true; GET /envelopes/{id}/comments says "comments_off": true, and the sender\'s page shows no form for a new comment), and "Questions and comments" leaves the signing page\'s menu.' },
  },
};

export const switchesPaths = () => ({
  '/account/switches': {
    get: {
      tags: ['Account'], summary: 'Switches for how people sign (owner and admins)',
      description: 'Every switch starts the way the product always worked. A new envelope takes "pass_on", "pass_on_copy" and "comments" from here when it is sent, and keeps them: changing the account later never changes an envelope that is out. "sign_ways", "members_stamps" and "mark_words" apply from the moment they change. "sign_ways_note" is the sentence shown beside the setting.',
      responses: ok({ ...account, properties: { ...account.properties, sign_ways_note: str } }),
    },
    put: {
      tags: ['Account'], summary: 'Change the switches',
      description: 'Only a person signed in to the app (an API key gets 403), owner or admin. Send any of them; a value of the wrong kind or a name that is not one of them is refused with 400 and "field", and nothing is changed. Each change is a line of the security record (settings.changed).',
      requestBody: { required: true, content: { 'application/json': { schema: account } } },
      responses: ok(account),
    },
  },
  '/envelopes/{id}/switches': {
    get: { tags: ['Envelopes'], summary: 'One envelope\'s own switches', description: 'A draft shows the account\'s until it is sent. An envelope sent before these switches existed shows them on.', parameters: [id], responses: ok(envelope) },
    put: {
      tags: ['Envelopes'], summary: 'Change one envelope\'s switches',
      description: 'For a draft, or an envelope that is out (from now on; a line goes in its audit trail, "Settings changed"). Only true or false; 409 for a template or an envelope that is closed.',
      parameters: [id],
      requestBody: { required: true, content: { 'application/json': { schema: envelope } } },
      responses: ok(envelope),
    },
  },
  '/powerforms/{id}': {
    patch: {
      tags: ['Forms'], summary: 'Pause, resume or change a public form',
      description: `Only what the call names is changed. "max_signed": the most people who may sign it (1 to ${FORM_LIMIT_MAX}), or null for no limit; people filling it in right now count, so the limit is never passed. "closes_at": the last day it takes signatures ("2026-12-31"), or null; with "tz" (a time zone such as "Europe/Berlin", which the Forms page sends) that day ends at midnight there, without it at midnight UTC. A full moment ("2026-12-31T17:00:00Z") is taken as it is. Both are checked before either is saved, so a 400 changes nothing. After either, GET /public/powerforms/{slug} says "closed": true with "closed_why" in words that say who to write to (the template's sender) and, when people filling it in take the last places, that it is full for now, and a start is refused with 403, code "form_closed". Whoever started before can still finish. GET /powerforms lists both for each form.`,
      parameters: [id],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { active: bool, shared_device: bool, max_signed: { type: 'integer', nullable: true }, closes_at: { ...str, nullable: true }, tz: { ...str, nullable: true } } } } } },
      responses: ok({ type: 'object' }),
    },
    delete: { tags: ['Forms'], summary: 'Delete a public form', description: 'The link stops working for good.', parameters: [id], responses: ok({ type: 'object' }) },
  },
});
