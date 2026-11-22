// What each role can do (src/server/perm.ts, src/lib/perm.ts, src/server/routes-perm.ts): the table of every route,
// the built-in roles exactly as before, roles an admin makes from Admin or Member, groups of members in template
// sharing and giving a role, API keys capped by their maker's role, and the security record of every change.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, simple, type Server } from './helpers.ts';
import { MEMBER_THINGS, THINGS, roleThings, mayDo } from '../src/lib/perm.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

let n = 0;
const ip = () => `10.77.${Math.floor(++n / 250)}.${n % 250}`;
const person = (name: string, email: string) => signUp(name, email, ip());
const browser = () => Object.assign(new Client(), { ip: ip() });
const PW = 'correct horse battery';
const inviteFor = (email: string) => db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY created_at DESC', email)?.token;
async function join(owner: Client, name: string, email: string, role = 'member') {
  const r0 = await owner.post('/account/invites', { email, role });
  assert.equal(r0.status, 200, JSON.stringify(r0.data));
  const c = browser();
  const r = await c.post('/auth/signup', { name, email, password: PW, invite: inviteFor(email) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  db.run('UPDATE users SET email_verified=1 WHERE email=?', email);
  return c;
}
const del = (c: Client, url: string) => c.call('DELETE', url);
const patch = (c: Client, url: string, b: any) => c.call('PATCH', url, b);
const uid = (email: string) => db.get('SELECT id FROM users WHERE email=?', email).id;
const withKey = (key: string) => {
  const c = browser();
  const call = c.call.bind(c);
  c.call = (method: string, url: string, body?: any, headers: Record<string, string> = {}) => call(method, url, body, { authorization: `Bearer ${key}`, ...headers });
  return c;
};
const kinds = (accountId: string) => db.all('SELECT kind, details FROM security_events WHERE account_id=? ORDER BY seq', accountId);

test('every route that needs a person has a line in the table, and the table says what the built-in roles always did', async () => {
  const { listRoutes } = await import('../src/server/router.ts');
  const { routeNeed, ROUTE_NEEDS } = await import('../src/server/perm.ts');
  const routes = listRoutes().filter((r) => r.level !== 'public');
  const missing = routes.filter((r) => !routeNeed(r.method, r.path)).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(missing, [], `Give each of these routes what it needs in src/server/perm.ts (NEEDS): ${missing.join(', ')}`);
  const member = new Set<string>([...MEMBER_THINGS, 'always', 'by_kind', 'drafting', 'reading']);
  for (const r of routes) {
    const need = routeNeed(r.method, r.path)!;
    // A route of the admins needs a thing a Member does not have; a route for everyone needs nothing a Member lacks.
    if (r.level === 'admin') assert.ok(!member.has(need), `${r.method} ${r.path} is for admins but its need "${need}" is a Member's`);
    else assert.ok(member.has(need), `${r.method} ${r.path} is for everyone but its need "${need}" is not a Member's`);
  }
  // No line for a route that does not exist (a typo would leave the real route without one).
  const known = new Set(listRoutes().map((r) => `${r.method} ${r.path}`));
  const stale = Object.values(ROUTE_NEEDS).flat().filter((k) => !known.has(k));
  assert.deepEqual(stale, []);
});

test('built-in roles: the owner, an admin and a member behave as before, and /me says what each can do', async () => {
  const owner = await person('Olga Owner', 'olga@perm.example');
  const adam = await join(owner, 'Adam Admin', 'adam@perm.example', 'admin');
  const mia = await join(owner, 'Mia Member', 'mia@perm.example');
  const me = (await mia.get('/me')).data;
  assert.equal(me.role, 'member');
  assert.deepEqual(me.my_role, { name: 'Member', base: 'member', can: [...MEMBER_THINGS], custom: false });
  assert.equal((await owner.get('/me')).data.my_role.can.includes('billing'), true);
  // The same refusal, word for word, as before roles could be made.
  const r = await mia.post('/stamps', {});
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'Only account admins can do that.');
  assert.equal((await adam.get('/account/security')).status, 200);
  assert.equal((await mia.get('/account/roles')).data.may_change, false);
  assert.equal((await adam.get('/account/roles')).data.may_change, true);
  // The page helper reads my_role, and falls back to the role for an older answer.
  assert.equal(mayDo(me, 'settings'), false);
  assert.equal(mayDo({ role: 'admin' }, 'settings'), true);
});

test('a role from Admin that leaves out "see every document" and the plan: exactly those are refused', async () => {
  const owner = await person('Rhea Owner', 'rhea@perm.example');
  const r = await owner.post('/account/roles', { name: 'Office manager', base: 'admin', left_out: ['see_all'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const role = r.data.role;
  assert.deepEqual(role.can, roleThings('admin', ['see_all']));
  assert.match(role.sentence, /except: see every document\. The plan and payments stay with the owner/);
  const otto = await join(owner, 'Otto Office', 'otto@perm.example', role.id);
  const me = (await otto.get('/me')).data;
  assert.equal(me.role, 'admin');
  assert.equal(me.my_role.name, 'Office manager');
  assert.equal(me.my_role.custom, true);
  // The owner's envelope: an admin would see it, this role does not.
  const env = await simple(owner, 'sam@perm.example');
  assert.equal((await otto.get(`/envelopes/${env.id}`)).status, 404);
  assert.ok(!(await otto.get('/envelopes')).data.envelopes.some((e: any) => e.id === env.id));
  assert.deepEqual((await owner.get('/envelopes')).data.envelopes.map((e: any) => e.id), [env.id]);
  // Settings: yes. The plan and payments: never, for any role an admin makes.
  assert.equal((await otto.get('/account/security')).status, 200);
  const pay = await otto.post('/billing/checkout', {});
  assert.equal(pay.status, 403);
  assert.match(pay.data.error, /Only the owner and the admins of this account can change the plan/);
  // Reports: their own only.
  assert.equal((await otto.get('/reports')).data.may_see_senders, false);
});

test('a role from Member that leaves out sending: templates yes, sending no, said in words', async () => {
  const owner = await person('Tess Owner', 'tess@perm.example');
  const role = (await owner.post('/account/roles', { name: 'Template writer', base: 'member', left_out: ['send', 'bulk', 'reports'] })).data.role;
  const wes = await join(owner, 'Wes Writer', 'wes@perm.example', role.id);
  // A template: allowed.
  const t = await wes.post('/envelopes', { kind: 'template', subject: 'Lease' });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  // An envelope: refused, by name of the role and the thing.
  const e = await wes.post('/envelopes', { subject: 'Not allowed' });
  assert.equal(e.status, 403);
  assert.equal(e.data.code, 'not_in_role');
  assert.match(e.data.error, /Your role on this team \(Template writer\) does not include "Send documents"\. Nothing was changed\./);
  assert.equal((await wes.get('/reports')).status, 403);
  assert.equal((await wes.get('/bulk')).status, 403);
  // What it still has.
  assert.equal((await wes.get('/contacts')).status, 200);
  assert.equal((await wes.get('/envelopes?kind=template')).status, 200);
  // A Member-based role can never reach the admins' routes, whatever it says.
  assert.equal((await wes.get('/account/security')).status, 403);
  // Leaving out what Member never had is refused, and so is the name of a built-in role.
  assert.equal((await owner.post('/account/roles', { name: 'X', base: 'member', left_out: ['settings'] })).status, 400);
  assert.equal((await owner.post('/account/roles', { name: 'Admin', base: 'admin' })).status, 400);
  assert.equal((await owner.post('/account/roles', { name: 'Template writer', base: 'admin' })).status, 400);
  assert.equal((await owner.post('/account/roles', { name: 'Y', base: 'member', left_out: ['nonsense'] })).status, 400);
});

test('nobody gives a role wider than their own, or changes someone whose role can do more', async () => {
  const owner = await person('Uma Owner', 'uma@perm.example');
  const boss = (await owner.post('/account/roles', { name: 'Team lead', base: 'admin', left_out: ['settings'] })).data.role;
  const lead = await join(owner, 'Lee Lead', 'lee@perm.example', boss.id);
  const adam = await join(owner, 'Ann Admin', 'ann@perm.example', 'admin');
  // An Admin can do the plan and settings: a Team lead cannot give that.
  const a = await lead.post('/account/invites', { email: 'new-admin@perm.example', role: 'admin' });
  assert.equal(a.status, 403);
  assert.equal(a.data.code, 'role_too_wide');
  // Nor change, or remove, the admin.
  assert.equal((await patch(lead, `/account/members/${uid('ann@perm.example')}`, { role: 'member' })).status, 403);
  assert.equal((await del(lead, `/account/members/${uid('ann@perm.example')}`)).status, 403);
  // Nor make a role that can change settings.
  assert.equal((await lead.post('/account/roles', { name: 'Wider', base: 'admin' })).status, 403);
  // What they may give, they may give.
  assert.equal((await lead.post('/account/invites', { email: 'helper@perm.example', role: 'member' })).status, 200);
  assert.equal((await lead.post('/account/invites', { email: 'lead2@perm.example', role: boss.id })).status, 200);
  // Their own role: taking Team away from it would lock them out, so it is refused.
  assert.equal((await patch(lead, `/account/roles/${boss.id}`, { left_out: ['settings', 'team'] })).status, 400);
  void adam;
});

test('an API key never does what the role of its maker leaves out', async () => {
  const owner = await person('Vera Owner', 'vera@perm.example');
  const role = (await owner.post('/account/roles', { name: 'No contacts', base: 'member', left_out: ['contacts'] })).data.role;
  const kim = await join(owner, 'Kim Keys', 'kim@perm.example', role.id);
  const k = await kim.post('/api-keys', { name: 'Script' });
  assert.equal(k.status, 200, JSON.stringify(k.data));
  const key = withKey(k.data.key);
  assert.equal((await key.get('/contacts')).status, 403);
  assert.equal((await key.get('/envelopes')).status, 200);
  // Taking a thing away later reaches the key at once.
  assert.equal((await patch(owner, `/account/roles/${role.id}`, { left_out: ['contacts', 'send'] })).status, 200);
  assert.equal((await key.get('/envelopes')).status, 403);
});

test('groups of members: a template for one group, a group that gives its role, and the security record', async () => {
  const owner = await person('Wynn Owner', 'wynn@perm.example');
  const hana = await join(owner, 'Hana HR', 'hana@perm.example');
  const ivo = await join(owner, 'Ivo Ops', 'ivo@perm.example');
  const g = await owner.post('/account/member-groups', { name: 'HR', people: [uid('hana@perm.example')] });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  const gid = g.data.group.id;
  assert.deepEqual(g.data.group.people.map((p: any) => p.name), ['Hana HR']);
  // A template only the HR group may use.
  const t = (await owner.post('/envelopes', { kind: 'template', subject: 'Offer letter' })).data.envelope;
  const set = await owner.put(`/envelopes/${t.id}/access`, { use: 'chosen', groups: [{ id: gid }] });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.match(set.data.access.chosen_use.join(','), /everyone in HR/);
  assert.equal((await hana.get(`/envelopes/${t.id}`)).status, 200);
  assert.equal((await ivo.get(`/envelopes/${t.id}`)).status, 403);
  assert.ok((await hana.get('/envelopes?kind=template')).data.envelopes.some((e: any) => e.id === t.id));
  assert.ok(!(await ivo.get('/envelopes?kind=template')).data.envelopes.some((e: any) => e.id === t.id));
  // Out of the group, out of the template.
  assert.equal((await patch(owner, `/account/member-groups/${gid}`, { people: [] })).status, 200);
  assert.equal((await hana.get(`/envelopes/${t.id}`)).status, 403);
  // A group from another team is refused.
  const other = await person('Xan Other', 'xan@perm.example');
  const og = (await other.post('/account/member-groups', { name: 'Theirs' })).data.group;
  assert.equal((await owner.put(`/envelopes/${t.id}/access`, { groups: [{ id: og.id }] })).status, 400);
  // A group that gives a role: everyone in it gets it, and the record names the group.
  const role = (await owner.post('/account/roles', { name: 'Reader', base: 'member', left_out: ['send'] })).data.role;
  assert.equal((await patch(owner, `/account/member-groups/${gid}`, { people: [uid('ivo@perm.example')], role: role.id })).status, 200);
  assert.equal((await ivo.get('/me')).data.my_role.name, 'Reader');
  // The role cannot be deleted while someone has it.
  const d = await del(owner, `/account/roles/${role.id}`);
  assert.equal(d.status, 409);
  assert.match(d.data.error, /Ivo Ops has the role Reader/);
  assert.equal((await patch(owner, `/account/members/${uid('ivo@perm.example')}`, { role: 'member' })).status, 200);
  assert.equal((await del(owner, `/account/roles/${role.id}`)).status, 200);
  assert.equal(db.get('SELECT profile_id FROM member_groups WHERE id=?', gid).profile_id, null);
  assert.equal((await del(owner, `/account/member-groups/${gid}`)).status, 200);
  const acc = db.get("SELECT account_id FROM memberships WHERE role='owner' AND user_id=?", uid('wynn@perm.example')).account_id;
  const lines = kinds(acc).map((l) => l.kind);
  for (const k of ['member_group.created', 'member_group.changed', 'role.created', 'role.deleted', 'member_group.deleted', 'member.role_changed']) assert.ok(lines.includes(k), `${k} is in the record`);
  const given = kinds(acc).find((l) => l.kind === 'member.role_changed' && JSON.parse(l.details).group === 'HR');
  assert.ok(given, 'the role a group gave names the group');
  void hana;
});

test('every thing on the list has words, and the built-in Member is unchanged', async () => {
  const { THING_WORDS } = await import('../src/lib/perm.ts');
  for (const t of THINGS) assert.ok(THING_WORDS[t].name && THING_WORDS[t].covers && !/—/.test(THING_WORDS[t].covers));
  assert.deepEqual([...MEMBER_THINGS], ['send', 'use_templates', 'make_templates', 'bulk', 'forms', 'contacts', 'reports', 'api_keys']);
});

// ---- Repairs after the skeptic and the simplicity review ------------------------------------------------------

test('a group never hands out a role wider than the giver: adding yourself to it is refused (P1)', async () => {
  const owner = await person('Pia Owner', 'pia@perm.example');
  const lead = (await owner.post('/account/roles', { name: 'Lead', base: 'admin', left_out: ['settings', 'webhooks'] })).data.role;
  const wide = (await owner.post('/account/roles', { name: 'Ops', base: 'admin', left_out: ['see_all'] })).data.role;
  const lee = await join(owner, 'Lee Group', 'lee-g@perm.example', lead.id);
  const g = (await owner.post('/account/member-groups', { name: 'Ops people', people: [], role: wide.id })).data.group;
  assert.equal((await lee.get('/account/security')).status, 403);
  const r = await patch(lee, `/account/member-groups/${g.id}`, { people: [uid('lee-g@perm.example')] });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'role_too_wide');
  assert.match(r.data.error, /You cannot give the role Ops/);
  // Nothing was written: not in the group, the same role, still no settings.
  assert.deepEqual((await owner.get('/account/member-groups')).data.groups.find((x: any) => x.id === g.id).people, []);
  assert.equal((await lee.get('/me')).data.my_role.name, 'Lead');
  assert.equal((await lee.get('/account/security')).status, 403);
  // Making a group with that role and themselves in it: refused the same way.
  assert.equal((await lee.post('/account/member-groups', { name: 'Mine', people: [uid('lee-g@perm.example')], role: wide.id })).status, 403);
  // A group with a role they may give: allowed.
  const small = (await owner.post('/account/roles', { name: 'Helper', base: 'member', left_out: ['bulk'] })).data.role;
  const g2 = (await owner.post('/account/member-groups', { name: 'Helpers', people: [], role: small.id })).data.group;
  await join(owner, 'Hal Helper', 'hal@perm.example');
  assert.equal((await patch(lee, `/account/member-groups/${g2.id}`, { people: [uid('hal@perm.example')] })).status, 200);
  // Taking someone out of a group leaves their role as it is (the dialog says so), never quietly narrowed or widened.
  assert.equal((await patch(owner, `/account/member-groups/${g2.id}`, { people: [] })).status, 200);
  assert.equal(db.get('SELECT profile_id FROM memberships WHERE user_id=?', uid('hal@perm.example')).profile_id, small.id);
});

test('nobody narrows or renames a role that can do more than their own (P2)', async () => {
  const owner = await person('Qin Owner', 'qin@perm.example');
  const lead = (await owner.post('/account/roles', { name: 'Lead', base: 'admin', left_out: ['settings'] })).data.role;
  const big = (await owner.post('/account/roles', { name: 'Big', base: 'admin', left_out: ['stamps'] })).data.role;
  const lee = await join(owner, 'Lee Narrow', 'lee-n@perm.example', lead.id);
  await join(owner, 'Bo Big', 'bo@perm.example', big.id);
  const r = await patch(lee, `/account/roles/${big.id}`, { left_out: ['settings', 'see_all', 'team'] });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'role_too_wide');
  assert.equal((await patch(lee, `/account/roles/${big.id}`, { name: 'Renamed by lead' })).status, 403);
  const now = (await owner.get('/account/roles')).data.roles.find((x: any) => x.id === big.id);
  assert.equal(now.name, 'Big');
  assert.deepEqual(now.left_out, ['stamps']);
  // Nor delete one, even when nobody has it.
  const unused = (await owner.post('/account/roles', { name: 'Unused wide', base: 'admin', left_out: [] })).data.role;
  assert.equal((await del(lee, `/account/roles/${unused.id}`)).status, 403);
  // A role within their own they may still change.
  const narrow = (await owner.post('/account/roles', { name: 'Narrow', base: 'member', left_out: ['bulk'] })).data.role;
  assert.equal((await patch(lee, `/account/roles/${narrow.id}`, { name: 'Narrower', left_out: ['bulk', 'forms'] })).status, 200);
});

test('"See every document" cannot be got round through the full export or documents brought in (P9)', async () => {
  const owner = await person('Ria Owner', 'ria@perm.example');
  const role = (await owner.post('/account/roles', { name: 'Office', base: 'admin', left_out: ['see_all'] })).data.role;
  const otto = await join(owner, 'Otto Export', 'otto-x@perm.example', role.id);
  await simple(owner, 'sam-x@perm.example');
  for (const [m, u] of [['GET', '/export/full'], ['GET', '/export/full/jobs'], ['POST', '/export/full/jobs'], ['GET', '/imported'], ['GET', '/imported/count']] as const) {
    const r = await otto.call(m, u, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 403, `${m} ${u}`);
    assert.equal(r.data.code, 'not_in_role');
    assert.match(r.data.error, /does not include "See every document"/);
  }
  // The same through an admin key that person makes.
  const k = await otto.post('/api-keys', { name: 'Script', scope: 'admin' });
  assert.equal(k.status, 200, JSON.stringify(k.data));
  assert.equal((await withKey(k.data.key).get('/export/full')).status, 403);
  // Settings without see_all still opens the settings themselves.
  assert.equal((await otto.get('/account/security')).status, 200);
  // A role with see_all but without settings: refused for settings.
  const r2 = (await owner.post('/account/roles', { name: 'Reader all', base: 'admin', left_out: ['settings'] })).data.role;
  const rex = await join(owner, 'Rex Reader', 'rex@perm.example', r2.id);
  const x = await rex.get('/export/full');
  assert.equal(x.status, 403);
  assert.match(x.data.error, /does not include "Account settings"/);
  // The built-in admin: as before.
  const ada = await join(owner, 'Ada Admin', 'ada-x@perm.example', 'admin');
  assert.equal((await ada.get('/export/full/jobs')).status, 200);
});

test('a role from Member with nothing left out is refused as the same as Member; unknown roles on invite are refused', async () => {
  const owner = await person('Sol Owner', 'sol@perm.example');
  const r = await owner.post('/account/roles', { name: 'Front desk', base: 'member', left_out: [] });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'same_as_member');
  assert.match(r.data.error, /same as Member\. Untick what it should not do/);
  // From Admin, nothing left out still differs (never the plan): allowed.
  assert.equal((await owner.post('/account/roles', { name: 'Admin without the plan', base: 'admin', left_out: [] })).status, 200);
  const m = (await owner.post('/account/roles', { name: 'Desk', base: 'member', left_out: ['bulk'] })).data.role;
  assert.equal((await patch(owner, `/account/roles/${m.id}`, { left_out: [] })).status, 400);
  // Invitations: a role that is not one of the team is refused, never quietly a Member. No role: a Member.
  for (const role of ['superuser', 'owner', 'role_nope']) {
    const i = await owner.post('/account/invites', { email: `x-${role}@perm.example`, role });
    assert.equal(i.status, 400, role);
    assert.match(i.data.error, /not a role of this team/);
  }
  assert.equal((await owner.post('/account/invites', { email: 'plain@perm.example' })).status, 200);
  assert.equal(db.get('SELECT role FROM invites WHERE email=?', 'plain@perm.example').role, 'member');
});

test('the Team page facts: each member says what their role can do, and only real admins count as a second admin', async () => {
  const owner = await person('Tia Owner', 'tia@perm.example');
  const office = (await owner.post('/account/roles', { name: 'Office manager', base: 'admin', left_out: ['settings', 'see_all'] })).data.role;
  await join(owner, 'Oli Office', 'oli@perm.example', office.id);
  const me = (await owner.get('/me')).data;
  assert.equal(me.admins, 1, 'an Office manager without settings is not a second admin');
  const list = (await owner.get('/account/members')).data.members;
  const oli = list.find((x: any) => x.email === 'oli@perm.example');
  assert.ok(!oli.can.includes('settings') && oli.can.includes('team'));
  await join(owner, 'Ari Admin', 'ari@perm.example', 'admin');
  assert.equal((await owner.get('/me')).data.admins, 2);
});

test('the words of the role list are the plain words of the charter', async () => {
  const { THING_WORDS, notInRole } = await import('../src/lib/perm.ts');
  const all = Object.values(THING_WORDS).map((w) => `${w.name} ${w.covers}`).join(' ');
  for (const bad of [/envelope/i, /\bvoid/i, /Bulk send/, /Public forms/, /Click-to-agree/, /Signing groups/, /admin keys/]) assert.ok(!bad.test(all), String(bad));
  assert.equal(THING_WORDS.groups.name, 'Contact groups');
  assert.match(notInRole('Reader', 'see_all'), /"See every document"/);
  const owner = await person('Uli Owner', 'uli@perm.example');
  const built = (await owner.get('/account/roles')).data.built_in;
  assert.ok(!built.some((b: any) => /envelope|bulk send|public forms/i.test(b.sentence)));
});
