// What the API description says about working for a colleague (src/server/routes-shares.ts and shares.ts): shares,
// moving, and sending for someone. Kept apart so the busy openapi.ts only needs one reference to it.
import { LEVEL_WORDS } from '../lib/shares.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: any) => ({ content: { 'application/json': { schema } } });
const obj = (properties: any, required?: string[]) => ({ type: 'object', ...(required ? { required } : {}), properties });
const s = { type: 'string' }, b = { type: 'boolean' };
const day = { type: 'string', format: 'date', description: 'A day, year-month-day.' };
const person = obj({ id: s, name: s, email: s });
const share = obj({ id: s, owner: person, grantee: person, level: { type: 'string', enum: ['see', 'manage', 'send'] }, starts_on: day, ends_on: { ...day, nullable: true }, created_at: s, active: b, waiting: b });
const idParam = { name: 'id', in: 'path', required: true, schema: s };
const levels = `"see": ${LEVEL_WORDS.see.covers} "manage": ${LEVEL_WORDS.manage.covers} "send": ${LEVEL_WORDS.send.covers}`;

export const sharesPaths = () => ({
  '/me/shares': {
    get: {
      summary: 'Shares you gave and received in this account',
      description: 'Shares not ended yet, also those that start later ("waiting") or whose people are no longer both in the account ("active": false). An admin of the team also gets "all": every share in the account. "colleagues": the other members, to choose from.',
      responses: { 200: { description: 'The shares.', ...json(obj({ given: { type: 'array', items: share }, received: { type: 'array', items: share }, all: { type: 'array', items: share }, colleagues: { type: 'array', items: person } })) }, default: err },
    },
    post: {
      summary: 'Share the envelopes you send with a colleague in the same account',
      description: `Levels: ${levels} "grantee": the id or the address of a member of this account (never another account). "starts_on" today or later (at most a year ahead; empty: today); "ends_on" empty shares until someone ends it. Days are in your own time zone. Your address must be confirmed. One open share per colleague: a new one replaces the one before. While it is in force, everything the colleague does through it is recorded as "<colleague> for <you>" in each audit trail, with a "for" detail in the security record. What a level does not cover answers 403 "share_level"; what no share covers (deleting, signing links, copies) answers 403 "not_in_share". Written to the security record as "share.given".`,
      requestBody: { required: true, ...json(obj({ grantee: s, level: { type: 'string', enum: ['see', 'manage', 'send'] }, starts_on: day, ends_on: day }, ['grantee', 'level'])) },
      responses: { 200: { description: 'The share.', ...json(obj({ share })) }, default: err },
    },
  },
  '/me/shares/{id}': {
    delete: {
      summary: 'End a share now',
      description: 'For the person who shared, the colleague who received it, and admins of the team. It stops for the very next request. Drafts the colleague made and handed over with Send for, not sent and not set to go later, go back to them. A share also ends by itself, for good, when either person leaves the account: being invited back does not bring it back. Written to the security record as "share.ended".',
      parameters: [idParam],
      responses: { 200: { description: 'Ended.', ...json(obj({ ok: b, ended_at: s })) }, default: err },
    },
  },
  '/me/sends-for': {
    get: { summary: 'The colleagues who share sending with you today', responses: { 200: { description: 'Whom you may send for.', ...json(obj({ people: { type: 'array', items: obj({ id: s, name: s }) } })) }, default: err } },
  },
  '/envelopes/{id}/send-for': {
    post: {
      summary: 'Make a draft of yours a colleague\'s, to send in their name',
      description: 'Only on a draft, only by whoever made it, and only for a colleague who shares sending with you ("send"), or with an admin-scope API key for any member. "on_behalf_of" empty makes it yours again. Recipients then read "<owner> (sent by <you>)" in the From line and at the foot of every email, in the From line of the signing page (GET /sign/{token} gives sender.name and sender.sent_by) and on the certificate ("Sent by").',
      parameters: [idParam],
      requestBody: { required: true, ...json(obj({ on_behalf_of: s })) },
      responses: { 200: { description: 'Whose it is now.', ...json(obj({ sender_id: s })) }, default: err },
    },
  },
  '/envelopes/{id}/move': {
    post: {
      summary: 'Move an envelope or a template to another member',
      description: 'By the person it belongs to, or an admin who sees every document (for a template: who may change any template). An envelope its sender deleted after somebody signed moves only by an admin. "to": the id or the address of a member. The audit trail says "Moved from <A> to <B> by <who>", the security record has "envelope.moved", and the certificate keeps naming whoever sent it first.',
      parameters: [idParam],
      requestBody: { required: true, ...json(obj({ to: s }, ['to'])) },
      responses: { 200: { description: 'How many moved.', ...json(obj({ moved: { type: 'integer' } })) }, default: err },
    },
  },
  '/envelopes/move': {
    post: {
      summary: 'Move several envelopes or templates to another member',
      description: 'As POST /envelopes/{id}/move, for up to 500 ids at once, all or none: one that may not be moved stops the whole call, and nothing moves.',
      requestBody: { required: true, ...json(obj({ ids: { type: 'array', items: s }, to: s }, ['ids', 'to'])) },
      responses: { 200: { description: 'How many moved.', ...json(obj({ moved: { type: 'integer' } })) }, default: err },
    },
  },
  '/account/members/{id}/move-documents': {
    get: {
      summary: 'Count what moving a member\'s documents would move',
      description: 'Admins of the team. Moves nothing: Settings asks with these numbers before POST.',
      parameters: [idParam],
      responses: { 200: { description: 'How many.', ...json(obj({ documents: { type: 'integer' }, templates: { type: 'integer' } })) }, default: err },
    },
    post: {
      summary: 'Move every envelope and template of one member to another',
      description: 'Admins of the team (Settings, Team). The same record as a move of each one.',
      parameters: [idParam],
      requestBody: { required: true, ...json(obj({ to: s }, ['to'])) },
      responses: { 200: { description: 'How many moved.', ...json(obj({ moved: { type: 'integer' } })) }, default: err },
    },
  },
});

/** For POST /envelopes: the field that sends in a colleague's name. */
export const ON_BEHALF_OF = 'on_behalf_of: the id or the address of a member of this account. The envelope or template is theirs, and who made it is kept: with a "Send for me" share from them, or from an API key with the admin scope for any member (403 "not_shared" otherwise). Recipients read "<owner> (sent by <you>)" in emails, on the signing page and on the certificate; the audit trail says "<you> for <owner>".';
