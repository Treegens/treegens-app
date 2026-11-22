// What each role can do, and groups of members, as part of /api/openapi.json (routes-perm.ts, perm.ts). Kept apart
// so the main description stays readable; openapi.ts spreads the paths in.
import { THINGS, THING_WORDS, ROLES_PER_ACCOUNT, ROLE_NAME_MAX, MEMBER_GROUPS_PER_ACCOUNT, MEMBER_GROUP_SIZE_MAX } from '../lib/perm.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const body = (schema: any) => ({ required: true, content: { 'application/json': { schema } } });
const s = { type: 'string' };
const idParam = { name: 'id', in: 'path', required: true, schema: s };
const thing = { type: 'string', enum: [...THINGS], description: THINGS.map((t) => `"${t}": ${THING_WORDS[t].name}. ${THING_WORDS[t].covers}`).join(' ') };

const role = {
  type: 'object',
  properties: {
    id: { ...s, readOnly: true, description: 'Give it as "role" on POST /account/invites or PATCH /account/members/{id}.' },
    name: { ...s, maxLength: ROLE_NAME_MAX, description: 'Unique on the team, whatever the letter case. Not Owner, Admin or Member.' },
    base: { type: 'string', enum: ['admin', 'member'], description: 'The built-in role it starts from. It decides which screens its people see, and cannot change later.' },
    left_out: { type: 'array', items: thing, description: 'What it may not do, of what its base can do. A base of "member" can only leave out what a Member can do.' },
    can: { type: 'array', items: thing, readOnly: true },
    sentence: { ...s, readOnly: true },
    people: { type: 'integer', readOnly: true }, invites: { type: 'integer', readOnly: true }, groups: { type: 'array', items: s, readOnly: true },
  },
};
const group = {
  type: 'object',
  properties: {
    id: { ...s, readOnly: true }, name: { ...s, maxLength: 60 },
    role: { type: 'object', nullable: true, properties: { id: s, name: s }, description: 'The role it gives everyone in it, or null.' },
    people: { type: 'array', items: { type: 'object', properties: { id: s, name: s, email: s } } },
  },
};
const groupInput = {
  type: 'object',
  properties: {
    name: { ...s, maxLength: 60 },
    people: { type: 'array', items: s, maxItems: MEMBER_GROUP_SIZE_MAX, description: 'The whole list: ids of people on the team (GET /account/members).' },
    role: { ...s, nullable: true, description: 'The id of a role the team made, or null for none. Setting it gives the role to everyone in the group now, and to anyone added later; the owner keeps theirs. Refused (403) when the role can do more than yours, or when someone in the group has a role that can do more than yours.' },
  },
};

export const permPaths = () => ({
  '/account/roles': {
    get: {
      summary: 'What each role can do',
      description: `The built-in roles (Owner, Admin, Member, which behave as they always have) and the roles the team made. Every route of this API needs one of the things listed; a role an admin made is refused, with 403 "not_in_role", where it left the thing out, and so is an API key made by a person with that role, whatever the key's scope. The plan and payments are never part of a made role. may_change: whether you can make and change roles.`,
      responses: ok({ type: 'object', properties: { built_in: { type: 'array', items: { type: 'object', properties: { key: s, name: s, can: { type: 'array', items: thing }, sentence: s } } }, roles: { type: 'array', items: role }, things: { type: 'array', items: thing }, max: { type: 'integer' }, may_change: { type: 'boolean' }, yours: { type: 'object', properties: { name: s, can: { type: 'array', items: s } } } } }),
    },
    post: {
      summary: 'Make a role (needs "Team")',
      description: `Up to ${ROLES_PER_ACCOUNT} per team. 403 "role_too_wide" when the role could do something your own role cannot. 400 "same_as_member" for a role from Member that leaves nothing out, which would be Member under a second name (one from Admin that leaves nothing out is allowed: it never has the plan and payments). Written to the security record.`,
      requestBody: body({ type: 'object', required: ['name', 'base'], properties: { name: role.properties.name, base: role.properties.base, left_out: role.properties.left_out } }),
      responses: ok({ type: 'object', properties: { role } }),
    },
  },
  '/account/roles/{id}': {
    patch: {
      summary: 'Change a role\'s name or what it leaves out (needs "Team")',
      description: 'Takes effect at once for everyone with the role, and for the API keys they made. Its base cannot change (400). 403 "role_too_wide" when the role can do more than yours, now or after the change: then you may not rename or narrow it either. 400 "same_as_member" as for making one. You cannot take "team" away from your own role. Written to the security record.',
      parameters: [idParam],
      requestBody: body({ type: 'object', properties: { name: role.properties.name, left_out: role.properties.left_out } }),
      responses: ok({ type: 'object', properties: { role } }),
    },
    delete: {
      summary: 'Delete a role (needs "Team")',
      description: '409 "role_in_use" while someone has it or an open invitation gives it: give them another role first. Groups that gave it give none from then on. Written to the security record.',
      parameters: [idParam], responses: ok({ type: 'object', properties: { ok: { type: 'boolean' } } }),
    },
  },
  '/account/member-groups': {
    get: { summary: 'Groups of members', description: 'Named sets of people on the team. A template\'s "Who can use this" can choose a group as a whole (PUT /envelopes/{id}/access, "groups").', responses: ok({ type: 'object', properties: { groups: { type: 'array', items: group }, max: { type: 'integer' }, max_people: { type: 'integer' }, may_change: { type: 'boolean' } } }) },
    post: { summary: 'Make a group of members (needs "Team")', description: `Up to ${MEMBER_GROUPS_PER_ACCOUNT} per team, ${MEMBER_GROUP_SIZE_MAX} people each. Written to the security record, and so is each role it gives.`, requestBody: body({ ...groupInput, required: ['name'] }), responses: ok({ type: 'object', properties: { group } }) },
  },
  '/account/member-groups/{id}': {
    patch: { summary: 'Change a group of members (needs "Team")', description: 'Whatever the body leaves out stays. Adding people to a group that gives a role is refused (403 "role_too_wide") when that role can do more than yours, also when you add yourself. Someone taken out of the group keeps the role it gave them. Written to the security record.', parameters: [idParam], requestBody: body(groupInput), responses: ok({ type: 'object', properties: { group } }) },
    delete: { summary: 'Delete a group of members (needs "Team")', description: 'Its people keep their roles. Templates chosen for the group are no longer open to them through it.', parameters: [idParam], responses: ok({ type: 'object', properties: { ok: { type: 'boolean' } } }) },
  },
});
