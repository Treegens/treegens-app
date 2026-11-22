// Settings, Team, More options: "What each role can do" and "Groups of members". What a role is, and the check on
// every request, are in perm.ts; the list of things and the words in src/lib/perm.ts.
//
// Every change here is a line in the account's security record (seclog.ts): a role made, changed or deleted, a group
// made, changed or deleted, and every person whose role a group set (member.role_changed, with the group's name).
import { route, type Ctx } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { bad, id, now, str } from './util.ts';
import { record } from './seclog.ts';
import { refuseOrgAdminRole } from './orgs.ts';
import {
  can, roleOf, roleIn, profileView, roleChoice, assertMayGive, assertMayManage, roleName,
} from './perm.ts';
import {
  THINGS, MEMBER_THINGS, isThing, baseThings, roleSentence, ROLES_PER_ACCOUNT, MEMBER_GROUPS_PER_ACCOUNT, MEMBER_GROUP_SIZE_MAX,
  type Base, type Thing,
} from '../lib/perm.ts';

// ---- Roles -----------------------------------------------------------------------------------------------------

const rolesOf = (accountId: string) => all('SELECT * FROM perm_profiles WHERE account_id=? ORDER BY lower(name)', accountId);
const holders = (accountId: string, profileId: string) => all('SELECT u.id, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.profile_id=? ORDER BY u.name', accountId, profileId);

function roleOut(accountId: string, p: any) {
  const v = profileView(p);
  const people = holders(accountId, p.id);
  return { ...v, sentence: roleSentence(v.name, v.base, v.can), people: people.length, names: people.slice(0, 20).map((x) => x.name),
    invites: get('SELECT COUNT(*) n FROM invites WHERE account_id=? AND profile_id=? AND accepted_at IS NULL', accountId, p.id).n,
    groups: all('SELECT name FROM member_groups WHERE account_id=? AND profile_id=? ORDER BY name', accountId, p.id).map((g) => g.name) };
}

/** The list a made role leaves out, from a body: only things of its base, each once. */
function leftOutFrom(v: unknown, base: Base): Thing[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw bad('"left_out" must be a list of things the role may not do, such as ["send", "bulk"]. Nothing was saved.');
  const has = baseThings(base);
  const out: Thing[] = [];
  for (const x of v) {
    if (!isThing(x)) throw bad(`"${str(typeof x === 'string' ? x : JSON.stringify(x), 40)}" is not one of the things a role can do. Use these: ${THINGS.join(', ')}. Nothing was saved.`);
    if (!has.includes(x)) throw bad(`A role that starts from Member cannot do "${x}" in the first place, so it cannot leave it out. A role that starts from Admin can. Nothing was saved.`);
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

// A role from Member that leaves nothing out would be Member under a second name. (One from Admin that leaves
// nothing out still differs: it never has the plan and payments.)
function sameAsMember(base: Base, leftOut: readonly string[]) {
  if (base === 'member' && !leftOut.length) throw bad('This role can do everything a Member can, so it is the same as Member. Untick what it should not do, or give people the Member role. Nothing was saved.', 400, { code: 'same_as_member' });
}

route('GET', '/account/roles', (c) => ({
  built_in: [
    { key: 'owner', name: 'Owner', can: [...THINGS], sentence: 'The owner can do everything, and is the only one who can hand the account over or close it.' },
    { key: 'admin', name: 'Admin', can: [...THINGS], sentence: 'Admins can do everything except hand the account over or close it.' },
    { key: 'member', name: 'Member', can: [...MEMBER_THINGS], sentence: 'Members send documents, use Send to many and Forms, use and make templates, and keep their own contacts and API keys. They see what they sent themselves.' },
  ],
  roles: rolesOf(c.account.id).map((p) => roleOut(c.account.id, p)),
  things: THINGS,
  max: ROLES_PER_ACCOUNT,
  // Whether this person can make and change roles (Team), and so what the page offers.
  may_change: can(c, 'team') && c.admin,
  yours: { name: roleOf(c).name, can: [...roleOf(c).things] },
}));

route('POST', '/account/roles', async (c) => {
  const b = await c.body();
  if (b.base !== 'admin' && b.base !== 'member') throw bad('Say which role the new one starts from: "base": "admin" or "base": "member". Nothing was saved.');
  const base: Base = b.base;
  const name = roleName(c.account.id, b.name, null);
  const leftOut = leftOutFrom(b.left_out, base);
  if (get('SELECT COUNT(*) n FROM perm_profiles WHERE account_id=?', c.account.id).n >= ROLES_PER_ACCOUNT) throw bad(`A team can have up to ${ROLES_PER_ACCOUNT} roles of its own. Delete one you no longer use first. Nothing was saved.`);
  const choice = { role: base, profile_id: null, name, things: new Set(baseThings(base).filter((t) => !leftOut.includes(t))) } as const;
  // Nobody makes a role that can do more than they can: a role is a way to give it to someone.
  assertMayGive(c, choice);
  sameAsMember(base, leftOut);
  const pid = id('role');
  run('INSERT INTO perm_profiles (id, account_id, name, base, left_out, created_at, created_by) VALUES (?,?,?,?,?,?,?)', pid, c.account.id, name, base, JSON.stringify(leftOut), now(), c.user.id);
  record('role.created', { c, about: ['role', pid], details: { name, base, left_out: leftOut } });
  return { role: roleOut(c.account.id, get('SELECT * FROM perm_profiles WHERE id=?', pid)) };
}, 'admin');

const mineRole = (c: Ctx, rid: string) => {
  const p = get('SELECT * FROM perm_profiles WHERE id=? AND account_id=?', rid, c.account.id);
  if (!p) throw bad('Role not found.', 404);
  return p;
};

route('PATCH', '/account/roles/:id', async (c) => {
  const b = await c.body();
  const p = mineRole(c, c.params.id);
  const was = profileView(p);
  // A role that can do more than yours now is not yours to change at all: narrowing or renaming it changes people
  // whose role can do more than yours, which you may not do one by one either (assertMayManage).
  assertMayGive(c, { role: was.base, profile_id: p.id, name: p.name, things: new Set(was.can) });
  if (b.base != null && b.base !== was.base) throw bad(`A role keeps the role it started from (${was.base === 'admin' ? 'Admin' : 'Member'}), because that decides which screens its people see. To start from the other one, make a new role. Nothing was saved.`);
  const name = b.name === undefined ? p.name : roleName(c.account.id, b.name, p.id);
  const leftOut = b.left_out === undefined ? was.left_out : leftOutFrom(b.left_out, was.base);
  const things = new Set(baseThings(was.base).filter((t) => !leftOut.includes(t)));
  assertMayGive(c, { role: was.base, profile_id: p.id, name, things });
  sameAsMember(was.base, leftOut);
  // Taking Team away from your own role would leave you unable to give it back.
  if (roleOf(c).profile?.id === p.id && !things.has('team')) throw bad('This is your own role. Taking "Team" away from it would mean you could no longer change roles, even to undo this. Ask the owner or an admin of your team to do it. Nothing was saved.');
  run('UPDATE perm_profiles SET name=?, left_out=? WHERE id=?', name, JSON.stringify(leftOut), p.id);
  const added = was.left_out.filter((t) => !leftOut.includes(t));
  const taken = leftOut.filter((t) => !was.left_out.includes(t));
  if (name !== p.name || added.length || taken.length)
    record('role.changed', { c, about: ['role', p.id], details: { name, ...(name !== p.name ? { was_called: p.name } : {}), ...(added.length ? { may_now: added } : {}), ...(taken.length ? { may_no_longer: taken } : {}), people: holders(c.account.id, p.id).length } });
  return { role: roleOut(c.account.id, get('SELECT * FROM perm_profiles WHERE id=?', p.id)) };
}, 'admin');

route('DELETE', '/account/roles/:id', (c) => {
  const p = mineRole(c, c.params.id);
  // Like changing it: a role that can do more than yours is left to someone who has as much.
  const v = profileView(p);
  assertMayGive(c, { role: v.base, profile_id: p.id, name: p.name, things: new Set(v.can) });
  const people = holders(c.account.id, p.id);
  // Never quietly widened or narrowed: whoever has the role gets another one from a person who chooses it.
  if (people.length) throw bad(`${people.length === 1 ? `${people[0].name} has` : `${people.length} people have`} the role ${p.name}. Give ${people.length === 1 ? 'them' : 'each of them'} another role on the Team list first, then delete it. Nothing was deleted.`, 409, { code: 'role_in_use' });
  const inv = get('SELECT COUNT(*) n FROM invites WHERE account_id=? AND profile_id=? AND accepted_at IS NULL', c.account.id, p.id).n;
  if (inv) throw bad(`${inv === 1 ? 'An invitation that is still open gives' : `${inv} invitations that are still open give`} the role ${p.name}. Withdraw ${inv === 1 ? 'it' : 'them'} first, or wait until ${inv === 1 ? 'it is' : 'they are'} accepted and give those people another role. Nothing was deleted.`, 409, { code: 'role_in_use' });
  tx(() => {
    const groups = all('SELECT name FROM member_groups WHERE account_id=? AND profile_id=?', c.account.id, p.id).map((g) => g.name);
    run('UPDATE member_groups SET profile_id=NULL WHERE account_id=? AND profile_id=?', c.account.id, p.id);
    run('DELETE FROM perm_profiles WHERE id=?', p.id);
    record('role.deleted', { c, about: ['role', p.id], details: { name: p.name, ...(groups.length ? { groups_no_longer_give_it: groups } : {}) } });
  });
}, 'admin');

// ---- Groups of members ---------------------------------------------------------------------------------------

function groupOut(g: any) {
  const people = all('SELECT u.id, u.name, u.email FROM member_group_people gp JOIN users u ON u.id=gp.user_id JOIN memberships m ON m.user_id=gp.user_id AND m.account_id=? WHERE gp.group_id=? ORDER BY u.name', g.account_id, g.id);
  const role = g.profile_id ? get('SELECT id, name FROM perm_profiles WHERE id=? AND account_id=?', g.profile_id, g.account_id) : null;
  return { id: g.id, name: g.name, role: role ? { id: role.id, name: role.name } : null, people };
}
export const listMemberGroups = (accountId: string) => all('SELECT * FROM member_groups WHERE account_id=? ORDER BY lower(name)', accountId).map(groupOut);

route('GET', '/account/member-groups', (c) => ({ groups: listMemberGroups(c.account.id), max: MEMBER_GROUPS_PER_ACCOUNT, max_people: MEMBER_GROUP_SIZE_MAX, may_change: can(c, 'team') && c.admin }));

/** The people of a body: ids of people on the team, each once. */
function peopleFrom(c: Ctx, v: unknown): string[] {
  if (!Array.isArray(v)) throw bad('"people" must be a list of the ids of people on the team, from GET /account/members. Nothing was saved.');
  if (v.length > MEMBER_GROUP_SIZE_MAX) throw bad(`A group can have up to ${MEMBER_GROUP_SIZE_MAX} people. Nothing was saved.`);
  const team = new Set(all('SELECT user_id FROM memberships WHERE account_id=?', c.account.id).map((m) => m.user_id as string));
  const out: string[] = [];
  v.forEach((x: any, i: number) => {
    const uid = str(typeof x === 'string' ? x : x?.id, 80);
    if (!team.has(uid)) throw bad(`Person ${i + 1} ("${uid}") is not on your team. Use the ids from GET /account/members. Nothing was saved.`);
    if (!out.includes(uid)) out.push(uid);
  });
  return out;
}

/** The role a body gives the group: null for none, or a role the account made. */
function groupRole(c: Ctx, v: unknown): string | null {
  if (v == null || v === '') return null;
  const choice = roleChoice(c.account.id, v);
  if (!choice.profile_id) throw bad('A group can give its people a role the team made, or none. To make someone an Admin or a Member, change their role on the Team list. Nothing was saved.');
  assertMayGive(c, choice);
  return choice.profile_id;
}

/**
 * Gives every person of the group its role (not the owner, who keeps theirs). Each one the caller may not change
 * stops the whole change, in words, before anything is written.
 */
function giveGroupRole(c: Ctx, groupName: string, profileId: string, people: string[]) {
  const choice = roleChoice(c.account.id, profileId);
  // Every time, not only when the group's role is set: adding people (yourself too) to a group that carries a role
  // wider than your own would hand that role out.
  if (people.length) assertMayGive(c, choice);
  const change = people.map((uid) => ({ uid, now: roleIn(c.account.id, uid), m: get('SELECT role, profile_id FROM memberships WHERE account_id=? AND user_id=?', c.account.id, uid) }))
    .filter((x) => x.now.base !== 'owner' && x.m && x.m.profile_id !== profileId);
  for (const x of change) {
    assertMayManage(c, x.uid, 'changed');
    if (c.account.org_id) refuseOrgAdminRole(c.account.id, x.uid, choice.role);
  }
  for (const x of change) {
    run('UPDATE memberships SET role=?, profile_id=? WHERE account_id=? AND user_id=?', choice.role, profileId, c.account.id, x.uid);
    record('member.role_changed', { c, about: ['user', x.uid], details: { from: x.m.role, to: choice.role, from_name: x.now.name, to_name: choice.name, group: groupName } });
  }
}

route('POST', '/account/member-groups', async (c) => {
  const b = await c.body();
  const name = roleName(c.account.id, b.name, null, 60, 'group');
  if (get('SELECT COUNT(*) n FROM member_groups WHERE account_id=?', c.account.id).n >= MEMBER_GROUPS_PER_ACCOUNT) throw bad(`A team can have up to ${MEMBER_GROUPS_PER_ACCOUNT} groups of members. Delete one you no longer use first. Nothing was saved.`);
  const people = b.people === undefined ? [] : peopleFrom(c, b.people);
  const profileId = groupRole(c, b.role);
  const gid = id('mgr');
  tx(() => {
    run('INSERT INTO member_groups (id, account_id, name, profile_id, created_at, created_by) VALUES (?,?,?,?,?,?)', gid, c.account.id, name, profileId, now(), c.user.id);
    for (const uid of people) run('INSERT INTO member_group_people (group_id, user_id, added_at) VALUES (?,?,?)', gid, uid, now());
    if (profileId) giveGroupRole(c, name, profileId, people);
    record('member_group.created', { c, about: ['member_group', gid], details: { name, people: people.length, ...(profileId ? { gives_role: roleChoice(c.account.id, profileId).name } : {}) } });
  });
  return { group: groupOut(get('SELECT * FROM member_groups WHERE id=?', gid)) };
}, 'admin');

const mineGroup = (c: Ctx, gid: string) => {
  const g = get('SELECT * FROM member_groups WHERE id=? AND account_id=?', gid, c.account.id);
  if (!g) throw bad('Group not found.', 404);
  return g;
};

route('PATCH', '/account/member-groups/:id', async (c) => {
  const b = await c.body();
  const g = mineGroup(c, c.params.id);
  const name = b.name === undefined ? g.name : roleName(c.account.id, b.name, g.id, 60, 'group');
  const before: string[] = all('SELECT user_id FROM member_group_people WHERE group_id=?', g.id).map((r) => r.user_id);
  const people = b.people === undefined ? before : peopleFrom(c, b.people);
  const profileId = b.role === undefined ? g.profile_id : groupRole(c, b.role);
  const added = people.filter((u) => !before.includes(u));
  const removed = before.filter((u) => !people.includes(u));
  tx(() => {
    run('UPDATE member_groups SET name=?, profile_id=? WHERE id=?', name, profileId, g.id);
    for (const uid of removed) run('DELETE FROM member_group_people WHERE group_id=? AND user_id=?', g.id, uid);
    for (const uid of added) run('INSERT OR IGNORE INTO member_group_people (group_id, user_id, added_at) VALUES (?,?,?)', g.id, uid, now());
    // A role newly set reaches everyone in the group; an unchanged one reaches the people just added.
    if (profileId) giveGroupRole(c, name, profileId, profileId !== g.profile_id ? people : added);
    if (name !== g.name || added.length || removed.length || profileId !== g.profile_id)
      record('member_group.changed', { c, about: ['member_group', g.id], details: { name, ...(name !== g.name ? { was_called: g.name } : {}), ...(added.length ? { people_added: added.length } : {}), ...(removed.length ? { people_removed: removed.length } : {}), ...(profileId !== g.profile_id ? { gives_role: profileId ? roleChoice(c.account.id, profileId).name : 'none' } : {}) } });
  });
  return { group: groupOut(get('SELECT * FROM member_groups WHERE id=?', g.id)) };
}, 'admin');

route('DELETE', '/account/member-groups/:id', (c) => {
  const g = mineGroup(c, c.params.id);
  tx(() => {
    const templates = get('SELECT COUNT(*) n FROM template_member_groups WHERE group_id=?', g.id).n;
    run('DELETE FROM member_groups WHERE id=?', g.id);
    record('member_group.deleted', { c, about: ['member_group', g.id], details: { name: g.name, ...(templates ? { templates_it_was_chosen_for: templates } : {}) } });
  });
}, 'admin');
