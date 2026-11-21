// Permissions per template: who can use it (everyone, admins only, chosen members), who can change it (its owner
// and admins, chosen members as well, everyone), and a lock on its wording, so an envelope started from it by
// someone who may not change it keeps its documents, fields, fixed wording and message. Every route that reads,
// uses or changes a template, for a browser and for an API key of each kind of person; copies, bulk sends, public
// forms, leaving and being removed, and a database from before this.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, upload, signUp, type Server } from './helpers.ts';
import { accessSentence, lockedBanner, LOCK_MEANS } from '../src/lib/tplroles.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

const PW = 'correct horse battery';
let n = 0;
const ip = () => `10.77.${Math.floor(++n / 250)}.${n % 250}`;
const inviteFor = (email: string) => db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY created_at DESC', email)?.token;
const withKey = (key: string) => {
  const c = Object.assign(new Client(), { ip: ip() });
  const call = c.call.bind(c);
  c.call = (m: string, u: string, b?: any, h: Record<string, string> = {}) => call(m, u, b, { authorization: `Bearer ${key}`, ...h });
  return c;
};
async function join(owner: Client, name: string, email: string, role = 'member') {
  assert.equal((await owner.post('/account/invites', { email, role })).status, 200);
  const c = Object.assign(new Client(), { ip: ip() });
  const r = await c.post('/auth/signup', { name, email, password: PW, invite: inviteFor(email) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}
const idOf = async (c: Client) => (await c.get('/me')).data.user.id as string;

// A team: the owner of the account, an admin, Maya (a member whose template it is), Chad (a member who will be
// chosen) and Otto (another member), each with a browser and an API key of their own. Addresses are new every time.
let teams = 0;
async function team() {
  const t = ++teams;
  const owner = await signUp('Olive Owner', `olive.${t}@tpl.example.com`, ip());
  const admin = await join(owner, 'Adam Admin', `adam.${t}@tpl.example.com`, 'admin');
  const maya = await join(owner, 'Maya Lopez', `maya.${t}@tpl.example.com`);
  const chad = await join(owner, 'Chad Chosen', `chad.${t}@tpl.example.com`);
  const otto = await join(owner, 'Otto Other', `otto.${t}@tpl.example.com`);
  const key = async (c: Client) => withKey((await c.post('/api-keys', { name: 'script' })).data.key);
  const ids = { owner: await idOf(owner), admin: await idOf(admin), maya: await idOf(maya), chad: await idOf(chad), otto: await idOf(otto) };
  return { t, owner, admin, maya, chad, otto, ids, keys: { owner: await key(owner), admin: await key(admin), maya: await key(maya), chad: await key(chad), otto: await key(otto) } };
}

// An NDA with one open role, a note and a fee the template writes, a start date left empty for the sender, and a
// signature. The message is part of the wording.
async function nda(c: Client, subject = 'NDA') {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    kind: 'template', subject, message: 'Please sign the NDA.', documents: [{ id: 'd', file_id: file.id, name: 'NDA' }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Client' }],
    fields: [
      { id: 'sig', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 },
      { id: 'law', document_id: 'd', type: 'note', value: 'Governed by the laws of Kenya.', page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.03 },
      { id: 'fee', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Fee', value: 'USD 500', readonly: true, page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.03 },
      { id: 'start', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Start date', readonly: true, page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.03 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
const setRule = async (c: Client, tplId: string, body: any) => {
  const r = await c.put(`/envelopes/${tplId}/access`, body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.access;
};
const listed = async (c: Client, tplId: string) => (await c.get('/envelopes?kind=template')).data.envelopes.some((e: any) => e.id === tplId);
const use = (c: Client, tplId: string, email = 'client@tpl.example.com') => c.post('/envelopes', { template_id: tplId, recipients: { Client: { name: 'Cleo Client', email } } });
const asBody = (e: any) => ({ subject: e.subject, message: e.message, ordered: e.ordered, documents: e.documents, recipients: e.recipients, fields: e.fields, edit_version: e.edit_version });
const historyOf = (id: string) => db.all("SELECT actor, detail FROM audit WHERE envelope_id=? AND action='Who can use and change it' ORDER BY seq", id);

// ---- 1. Who can use it ----------------------------------------------------------------------------------------

test('who can use a template: everyone by default, admins only, or chosen members, for a browser and for an API key of each', async () => {
  const { maya, chad, otto, owner, admin, keys, ids } = await team();
  const tpl = await nda(maya);
  const everyone = { owner, admin, maya, chad, otto, ...Object.fromEntries(Object.entries(keys).map(([k, v]) => [`${k} key`, v])) } as Record<string, Client>;

  // By default it is the team's, as before: listed for everyone, and everyone can open and use it.
  for (const [who, c] of Object.entries(everyone)) {
    assert.equal(await listed(c, tpl.id), true, who);
    assert.equal((await c.get(`/envelopes/${tpl.id}`)).status, 200, who);
  }
  const plain = (await otto.get(`/envelopes/${tpl.id}/access`)).data.access;
  assert.deepEqual([plain.use, plain.change, plain.locked, plain.may_use, plain.may_change, plain.may_set, plain.members], ['team', 'owner', false, true, false, false, undefined], 'a member who may not set the rule is not shown who else is on the team');
  assert.match(accessSentence(plain), /^Everyone on the team can use it\. Only Maya Lopez and admins can change it\./);

  // Admins only. Otto and Chad no longer see it in the list, nor its folder, and every way in is refused with who to ask.
  assert.equal((await maya.call('PATCH', `/envelopes/${tpl.id}`, { folder: 'HR only' })).status, 200);
  const rule = await setRule(maya, tpl.id, { use: 'admins' });
  assert.equal(rule.use, 'admins');
  assert.match(accessSentence(rule), /^Only admins and Maya Lopez can use it\./);
  const file = await upload(otto, 1);
  for (const [who, c] of Object.entries({ chad, otto, 'chad key': keys.chad, 'otto key': keys.otto })) {
    assert.equal(await listed(c, tpl.id), false, who);
    assert.equal((await c.get('/envelopes?kind=template')).data.folders.includes('HR only'), false, `${who}: a folder name says something by itself`);
    const calls = [
      await c.get(`/envelopes/${tpl.id}`), await c.get(`/envelopes/${tpl.id}/access`), await c.get(`/envelopes/${tpl.id}/download`), await c.get(`/envelopes/${tpl.id}/warnings`),
      await use(c, tpl.id), await c.post(`/envelopes/${tpl.id}/clone`), await c.post(`/envelopes/${tpl.id}/clone`, { kind: 'envelope' }),
      await c.post('/bulk/check', { template_id: tpl.id, rows: [{ Client: { name: 'B', email: 'b@tpl.example.com' } }] }),
      await c.post('/bulk', { template_id: tpl.id, rows: [{ Client: { name: 'B', email: 'b@tpl.example.com' } }] }),
      await c.post('/powerforms', { template_id: tpl.id, name: 'Form' }),
      await c.put(`/envelopes/${tpl.id}`, { subject: 'Rewritten', documents: [{ id: 'd', file_id: file.id }] }), await c.call('PATCH', `/envelopes/${tpl.id}`, { folder: 'Mine' }),
      await c.call('DELETE', `/envelopes/${tpl.id}`), await c.put(`/envelopes/${tpl.id}/access`, { use: 'team' }), await c.put(`/envelopes/${tpl.id}/pay-link`, { url: '' }),
    ];
    for (const r of calls) {
      assert.equal(r.status, 403, `${who}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.code, 'template_not_for_you');
      assert.match(r.data.error, /^This template is for the admins of your team only, so you cannot open or use it\. Ask Maya Lopez or an admin of your team if you need it\.$/);
    }
  }
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE template_id=?', tpl.id).n, 0, 'nothing was made from it');
  assert.deepEqual({ ...db.get('SELECT subject, folder, tpl_use FROM envelopes WHERE id=?', tpl.id) }, { subject: 'NDA', folder: 'HR only', tpl_use: 'admins' });
  // The owner of the account, an admin and Maya herself, and their keys, still can. Nothing is locked away from them.
  for (const [who, c] of Object.entries({ owner, admin, maya, 'owner key': keys.owner, 'admin key': keys.admin, 'maya key': keys.maya })) {
    assert.equal(await listed(c, tpl.id), true, who);
    assert.equal((await use(c, tpl.id)).status, 200, who);
  }
  const mark = (await admin.get('/envelopes?kind=template')).data.envelopes.find((e: any) => e.id === tpl.id);
  assert.deepEqual([mark.access.use, mark.access.locked, mark.may_change, mark.access.may_delete], ['admins', false, true, true], 'the list carries the rule, for the "Admins only" mark');

  // Chosen members: Chad is chosen, Otto is not.
  const chosen = await setRule(maya, tpl.id, { use: 'chosen', members: [{ id: ids.chad }] });
  assert.deepEqual(chosen.chosen_use, ['Chad Chosen']);
  assert.match(accessSentence(chosen), /^Only admins, Maya Lopez and Chad Chosen can use it\./);
  for (const c of [chad, keys.chad]) {
    assert.equal(await listed(c, tpl.id), true);
    assert.equal((await use(c, tpl.id)).status, 200);
    assert.equal((await c.get('/envelopes?kind=template')).data.folders.includes('HR only'), true);
  }
  for (const c of [otto, keys.otto]) {
    assert.equal(await listed(c, tpl.id), false);
    const r = await use(c, tpl.id);
    assert.equal(r.status, 403);
    assert.match(r.data.error, /^This template is for chosen members of your team, and you are not one of them, so you cannot open or use it\. Ask Maya Lopez or an admin of your team to add you if you need it\.$/);
  }
  // Nobody chosen at all: the sentence says why only admins and Maya can.
  assert.match(accessSentence(await setRule(maya, tpl.id, { members: [] })), /^Only admins and Maya Lopez can use it, because nobody else has been chosen yet\./);
  assert.equal((await use(chad, tpl.id)).status, 403);
  // Each change is in the template's history, with the rule before and after.
  const history = historyOf(tpl.id);
  assert.equal(history.length, 3);
  assert.match(history[0].actor, /Maya Lopez/);
  assert.match(history[0].detail, /^Only admins and Maya Lopez can use it\..* Before: Everyone on the team can use it\./);
});

// ---- 2. Who can change it ----------------------------------------------------------------------------------------

test('who can change a template: its owner and admins, chosen members as well, or everyone, and only its owner and admins set the rule or delete it', async () => {
  const { maya, chad, otto, owner, admin, keys, ids } = await team();
  const tpl = await nda(maya);
  const now = async (c: Client) => (await c.get(`/envelopes/${tpl.id}`)).data.envelope;
  const rename = async (c: Client, subject: string) => c.put(`/envelopes/${tpl.id}`, { ...asBody(await now(maya)), subject, edit_version: undefined });

  // The usual rule, with the usual words.
  const no = await rename(chad, 'By Chad');
  assert.equal(no.status, 403);
  assert.match(no.data.error, /^This template belongs to Maya Lopez\. You can use it and copy it, but only Maya Lopez or an admin of your team can change or delete it\. To make your own version, copy it and change the copy\.$/);

  // Chosen members as well: Chad may change it, Otto may not, and neither may delete it or change the rule.
  const rule = await setRule(maya, tpl.id, { change: 'chosen', members: [{ id: ids.chad, can_change: true }, { id: ids.otto, can_change: false }] });
  assert.deepEqual([rule.use, rule.change, rule.chosen_use, rule.chosen_change], ['team', 'chosen', [], ['Chad Chosen']]);
  assert.match(accessSentence(rule), /Maya Lopez, admins and Chad Chosen can change it\./);
  for (const c of [chad, keys.chad]) {
    assert.equal((await rename(c, 'By Chad')).status, 200);
    assert.equal((await c.call('PATCH', `/envelopes/${tpl.id}`, { folder: 'Contracts' })).status, 200);
    const del = await c.call('DELETE', `/envelopes/${tpl.id}`);
    assert.equal(del.status, 403);
    assert.match(del.data.error, /^You may change this template, but only Maya Lopez or an admin of your team can delete it, because deleting takes it away from everyone on the team for good\. Nothing was deleted\. Ask Maya Lopez or an admin of your team\.$/);
    const set = await c.put(`/envelopes/${tpl.id}/access`, { use: 'admins' });
    assert.equal(set.status, 403);
    assert.match(set.data.error, /^Only Maya Lopez or an admin of your team can change who can use and change this template, or lock its wording\. Nothing was changed\./);
  }
  for (const c of [otto, keys.otto]) {
    const r = await rename(c, 'By Otto');
    assert.equal(r.status, 403);
    assert.match(r.data.error, /^This template belongs to Maya Lopez\. You can use it, but only Maya Lopez, an admin of your team or a member they chose can change it, and only Maya Lopez or an admin can delete it\. Ask Maya Lopez or an admin of your team if it needs a change\./);
  }
  assert.equal(db.get('SELECT subject FROM envelopes WHERE id=?', tpl.id).subject, 'By Chad');
  assert.equal((await chad.get(`/envelopes/${tpl.id}/access`)).data.access.may_change, true);
  const marks = async (c: Client) => (await c.get('/envelopes?kind=template')).data.envelopes.find((e: any) => e.id === tpl.id);
  assert.deepEqual([(await marks(chad)).may_change, (await marks(chad)).access.may_delete, (await marks(otto)).may_change], [true, false, false]);
  // Everyone on the team, which only makes sense for a template everyone may use.
  const odd = await maya.put(`/envelopes/${tpl.id}/access`, { use: 'admins', change: 'team' });
  assert.equal(odd.status, 400);
  assert.match(odd.data.error, /^A template that everyone on the team may change is one that everyone may use\./);
  await setRule(maya, tpl.id, { change: 'team' });
  assert.equal((await rename(otto, 'By Otto')).status, 200);
  assert.equal((await otto.call('DELETE', `/envelopes/${tpl.id}`)).status, 403, 'deleting stays with Maya and admins');

  // What the rule call takes is checked, and nothing is changed by a mistake in it.
  const before = db.get('SELECT tpl_use, tpl_change, tpl_locked FROM envelopes WHERE id=?', tpl.id);
  for (const [body, says] of [[{ use: 'hr' }, /"use" is "hr", which does not exist\. Use one of: team, admins, chosen\./], [{ locked: 'yes' }, /"locked" is "yes", and it has to be true or false/],
    [{ members: [{ id: 'usr_nobody' }] }, /Member 1 \("usr_nobody"\) is not on your team\./], [{ members: 'everyone' }, /"members" must be a list/],
    [{ members: [{ id: ids.chad, can_change: 'true' }] }, /"can_change" of member 1 has to be true or false/]] as const) {
    const r = await maya.put(`/envelopes/${tpl.id}/access`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, says);
  }
  assert.deepEqual({ ...db.get('SELECT tpl_use, tpl_change, tpl_locked FROM envelopes WHERE id=?', tpl.id) }, { ...before });
  // A member of another team is not on this one.
  const stranger = await signUp('Sam Stranger', `sam.${n}@tpl.example.com`, ip());
  assert.equal((await maya.put(`/envelopes/${tpl.id}/access`, { members: [{ id: await idOf(stranger) }] })).status, 400);
  // An admin and the owner of the account set the rule of anybody's template. The person it belongs to sees the team.
  assert.equal((await admin.put(`/envelopes/${tpl.id}/access`, { change: 'owner' })).status, 200);
  assert.equal((await keys.owner.put(`/envelopes/${tpl.id}/access`, { locked: true })).status, 200);
  const full = (await maya.get(`/envelopes/${tpl.id}/access`)).data.access;
  assert.deepEqual(full.members.map((m: any) => [m.name, m.always, m.chosen, m.can_change]),
    [['Adam Admin', true, false, false], ['Chad Chosen', false, true, true], ['Maya Lopez', true, false, false], ['Olive Owner', true, false, false], ['Otto Other', false, true, false]]);
  // The same rule saved twice is written down once.
  const lines = historyOf(tpl.id).length;
  await setRule(maya, tpl.id, { change: 'owner', locked: true });
  assert.equal(historyOf(tpl.id).length, lines);
  assert.equal((await admin.get(`/envelopes/${tpl.id}`)).data.audit.filter((a: any) => a.action === 'Who can use and change it').length, lines, 'the history is the template\'s audit list');
  // An envelope is not a template.
  const env = (await use(maya, tpl.id)).data.envelope;
  assert.equal((await maya.get(`/envelopes/${env.id}/access`)).status, 404);
});

// ---- 3. The lock on the wording ---------------------------------------------------------------------------------

test('a locked wording: names, addresses and the empty fields can be filled in, the rest stays, through the editor\'s save and the plain API', async () => {
  const { maya, chad, otto, admin, keys, ids } = await team();
  const tpl = await nda(maya);
  const locked = await setRule(maya, tpl.id, { locked: true });
  assert.match(accessSentence(locked), new RegExp(`Its wording is locked\\. ${LOCK_MEANS.replace(/[.]/g, '\\.')}`));
  const made = await use(otto, tpl.id);
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const eid = made.data.envelope.id;
  const read = async (c: Client = otto) => (await c.get(`/envelopes/${eid}`)).data.envelope;
  const e = await read();
  // The editor is told what is locked and who can unlock it.
  const byLabel = (x: any, label: string) => x.fields.find((f: any) => f.label === label || f.value === label);
  assert.deepEqual({ ...e.wording_lock, fixed: [...e.wording_lock.fixed].sort() }, { template_id: tpl.id, template: 'NDA', ask: 'Maya Lopez or an admin of your team', fixed: [byLabel(e, 'Fee').id, byLabel(e, 'Governed by the laws of Kenya.').id].sort(), people: {} }, 'the template gives its one person no note and no check');
  assert.match(lockedBanner(e.wording_lock.template, e.wording_lock.ask), /^It was started from the template "NDA", whose wording is locked\. .* To change them, ask Maya Lopez or an admin of your team to change the template\.$/);

  // What the editor saves: the whole envelope, with the client's name and address and the empty start date filled in.
  const body = asBody(e);
  body.recipients = body.recipients.map((r: any) => ({ ...r, name: 'Cleo Changed', email: 'cleo.changed@tpl.example.com' }));
  body.fields = body.fields.map((f: any) => (f.label === 'Start date' ? { ...f, value: '1 March 2027' } : f));
  body.subject = 'NDA for Cleo';
  const ok = await otto.put(`/envelopes/${eid}`, body);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const saved = await read();
  assert.deepEqual([saved.subject, saved.recipients[0].email, byLabel(saved, 'Start date').value], ['NDA for Cleo', 'cleo.changed@tpl.example.com', '1 March 2027']);
  // And a typo in what was filled in can be put right.
  assert.equal((await otto.put(`/envelopes/${eid}`, { ...asBody(saved), fields: asBody(saved).fields.map((f: any) => (f.label === 'Start date' ? { ...f, value: '2 March 2027' } : f)) })).status, 200);

  // Everything else is refused, says what and who to ask, and nothing is saved.
  const cur = asBody(await read());
  const second = await upload(otto, 1);
  const tries: [string, any, RegExp][] = [
    ['the message', { ...cur, message: 'Please sign. The fee is now USD 5,000.' }, /^The message cannot be changed\./],
    ['the order', { ...cur, ordered: true }, /^Whether people sign in order cannot be changed\./],
    ['a document renamed', { ...cur, documents: cur.documents.map((d: any) => ({ ...d, name: 'NDA v2' })) }, /^Document 1 \("NDA"\) cannot be changed, renamed or moved\./],
    ['a document swapped', { ...cur, documents: cur.documents.map((d: any) => ({ ...d, file_id: second.id })) }, /^Document 1 \("NDA"\) cannot be changed/],
    ['a document added', { ...cur, documents: [...cur.documents, { id: 'doc_extra', file_id: second.id, name: 'Side letter' }] }, /^The documents cannot be changed: it has 1 and the request has 2\./],
    ['a person added', { ...cur, recipients: [...cur.recipients, { id: 'rcp_extra', role: 'cc', name: 'Eve', email: 'eve@tpl.example.com' }] }, /^People cannot be added or taken off/],
    ['a role changed', { ...cur, recipients: cur.recipients.map((r: any) => ({ ...r, role: 'approver' })) }, /cannot be changed\. Their name and address can\./],
    ['a field moved', { ...cur, fields: cur.fields.map((f: any) => (f.type === 'signature' ? { ...f, x: f.x + 0.1 } : f)) }, /^Field \d+ cannot be moved, resized or changed\./],
    ['a field made optional', { ...cur, fields: cur.fields.map((f: any) => (f.type === 'signature' ? { ...f, required: false } : f)) }, /cannot be moved, resized or changed/],
    ['a field removed', { ...cur, fields: cur.fields.filter((f: any) => f.type !== 'note') }, /^Fields cannot be added or removed: it has 4 and the request has 3\./],
    ['a field added', { ...cur, fields: [...cur.fields, { document_id: cur.documents[0].id, type: 'note', value: 'Extra', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.03 }] }, /^Fields cannot be added or removed/],
    ['the note', { ...cur, fields: cur.fields.map((f: any) => (f.type === 'note' ? { ...f, value: 'Governed by the laws of nowhere.' } : f)) }, /holds wording from the template, and it cannot be changed\./],
    ['the fee', { ...cur, fields: cur.fields.map((f: any) => (f.label === 'Fee' ? { ...f, value: 'USD 5,000' } : f)) }, /^Field \d+ \("Fee"\) holds wording from the template/],
    ['every value left out', { ...cur, fields: cur.fields.map(({ value: _v, ...f }: any) => f) }, /^The note "Governed by the laws of Kenya\." on page 1 holds wording from the template, and it cannot be changed\./],
    ['the fee left out', { ...cur, fields: cur.fields.map(({ value: _v, ...f }: any) => (f.label === 'Fee' ? f : { ...f, value: _v })) }, /^Field \d+ \("Fee"\) holds wording from the template/],
  ];
  const version = (await read()).edit_version;
  for (const c of [otto, keys.otto]) {
    for (const [what, b, says] of tries) {
      const r = await c.put(`/envelopes/${eid}`, b);
      assert.equal(r.status, 403, `${what}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.code, 'wording_locked');
      assert.match(r.data.error, says, what);
      assert.match(r.data.error, /This envelope was started from the template "NDA", whose wording is locked\. .* Nothing was saved\. If it needs to change, ask Maya Lopez or an admin of your team to change the template\.$/, what);
    }
  }
  const after = await read();
  assert.equal(after.edit_version, version, 'nothing was saved');
  assert.deepEqual([after.message, byLabel(after, 'Fee').value, after.documents[0].name, after.fields.length], ['Please sign the NDA.', 'USD 500', 'NDA', 4]);
  // The plain API: a body with only the people in it is a fill-in, and works. A message of its own does not.
  assert.equal((await keys.otto.put(`/envelopes/${eid}`, { recipients: cur.recipients.map((r: any) => ({ id: r.id, role: r.role, role_name: r.role_name, routing_order: r.routing_order, name: 'Cleo Client', email: 'cleo@tpl.example.com' })) })).status, 200);
  assert.equal((await keys.otto.put(`/envelopes/${eid}`, { message: 'Different' })).status, 403);
  const count = db.get('SELECT COUNT(*) n FROM envelopes').n;
  const own = await otto.post('/envelopes', { template_id: tpl.id, message: 'My own words', recipients: { Client: { name: 'Cleo', email: 'cleo@tpl.example.com' } } });
  assert.equal(own.status, 403);
  assert.match(own.data.error, /^The message cannot be changed: the wording of this template is locked\..* Nothing was created\. Leave "message" out, or ask Maya Lopez or an admin of your team to change the template\.$/);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes').n, count, 'nothing was created');
  assert.equal((await otto.post('/envelopes', { template_id: tpl.id, message: 'Please sign the NDA.', recipients: { Client: { name: 'Cleo', email: 'cleo@tpl.example.com' } } })).status, 200, 'the same message is no change');
  // The payment link comes with the wording.
  const pay = await otto.put(`/envelopes/${eid}/pay-link`, { url: 'https://pay.example.com/me' });
  assert.equal(pay.status, 403);
  assert.equal(pay.data.code, 'wording_locked');

  // Once it is out, a correction is held to the same, and a name can still be put right.
  assert.equal((await otto.post(`/envelopes/${eid}/send`)).status, 200);
  const out = asBody(await read());
  assert.equal((await otto.put(`/envelopes/${eid}`, { ...out, message: 'Changed after sending' })).status, 403);
  assert.equal((await otto.put(`/envelopes/${eid}`, { ...out, recipients: out.recipients.map((r: any) => ({ ...r, name: 'Cleo M. Client' })) })).status, 200);

  // Nobody responsible is locked out: an admin, Maya, and a member chosen to change it.
  const mayaOwn = (await use(maya, tpl.id)).data.envelope;
  assert.equal((await maya.get(`/envelopes/${mayaOwn.id}`)).data.envelope.wording_lock, null);
  assert.equal((await maya.put(`/envelopes/${mayaOwn.id}`, { message: 'Maya may' })).status, 200);
  const draft = (await use(otto, tpl.id, 'second@tpl.example.com')).data.envelope;
  assert.equal((await admin.get(`/envelopes/${draft.id}`)).data.envelope.wording_lock, null);
  assert.equal((await keys.admin.put(`/envelopes/${draft.id}`, { message: 'An admin may' })).status, 200);
  await setRule(maya, tpl.id, { change: 'chosen', members: [{ id: ids.chad, can_change: true }] });
  const chads = (await use(chad, tpl.id)).data.envelope;
  assert.equal((await chad.put(`/envelopes/${chads.id}`, { message: 'Chad may' })).status, 200);
  // Unlocking the template frees the envelopes already started from it.
  assert.notEqual((await read()).wording_lock, null);
  await setRule(maya, tpl.id, { locked: false });
  const open = (await otto.get(`/envelopes/${draft.id}`)).data.envelope;
  assert.equal(open.wording_lock, null);
  assert.equal((await otto.put(`/envelopes/${draft.id}`, { message: 'Free again' })).status, 200);
  // Locked again, and then deleted: what was started from it stays locked, and only Maya, whose template it was, or
  // an admin can help (the refusal used to name only an admin, and locked Maya out of her own envelopes too).
  await setRule(maya, tpl.id, { locked: true });
  assert.equal((await otto.put(`/envelopes/${draft.id}`, { message: 'Not now' })).status, 403);
  assert.equal((await maya.call('DELETE', `/envelopes/${tpl.id}`)).status, 200);
  const orphan = (await otto.get(`/envelopes/${draft.id}`)).data.envelope.wording_lock;
  assert.deepEqual([orphan.template, orphan.ask], [null, 'Maya Lopez or an admin of your team']);
  const gone = await otto.put(`/envelopes/${draft.id}`, { message: 'Still not' });
  assert.equal(gone.status, 403);
  assert.match(gone.data.error, /started from a template whose wording was locked\..* ask Maya Lopez or an admin of your team to change this envelope for you\.$/);
  assert.equal((await admin.put(`/envelopes/${draft.id}`, { message: 'The admin decides' })).status, 200);
});

// ---- 4. Copies -------------------------------------------------------------------------------------------------

test('a copy of a template keeps its rule and its people, and a copy of a locked one is no way round the lock', async () => {
  const { maya, chad, otto, ids, keys } = await team();
  const tpl = await nda(maya);
  await setRule(maya, tpl.id, { use: 'chosen', locked: true, members: [{ id: ids.otto }] });
  // Otto may use it, not change it. His copy keeps the lock and the people, and stays with Maya.
  const copy = await otto.post(`/envelopes/${tpl.id}/clone`);
  assert.equal(copy.status, 200, JSON.stringify(copy.data));
  assert.deepEqual([copy.data.belongs_to, copy.data.locked], ['Maya Lopez', true]);
  const row = db.get('SELECT sender_id, kind, tpl_use, tpl_change, tpl_locked FROM envelopes WHERE id=?', copy.data.id);
  assert.deepEqual({ ...row }, { sender_id: ids.maya, kind: 'template', tpl_use: 'chosen', tpl_change: 'owner', tpl_locked: 1 });
  assert.deepEqual(db.all('SELECT user_id, can_change FROM template_members WHERE template_id=?', copy.data.id).map((l) => ({ ...l })), [{ user_id: ids.otto, can_change: 0 }]);
  const change = await otto.put(`/envelopes/${copy.data.id}`, { message: 'My version' });
  assert.equal(change.status, 403);
  assert.match(change.data.error, /^This template belongs to Maya Lopez\. .* Its wording is locked, and a copy of it is locked in the same way\.$/);
  assert.equal(await listed(chad, copy.data.id), false, 'the copy reaches nobody new');
  assert.equal((await chad.post(`/envelopes/${tpl.id}/clone`)).status, 403);
  // The same copy made with POST /envelopes, "kind": "template" and the template_id, is held to the same rule.
  const viaCreate = await keys.otto.post('/envelopes', { kind: 'template', template_id: tpl.id, subject: 'NDA, my version' });
  assert.equal(viaCreate.status, 200, JSON.stringify(viaCreate.data));
  assert.deepEqual({ ...db.get('SELECT sender_id, tpl_locked FROM envelopes WHERE id=?', viaCreate.data.envelope.id) }, { sender_id: ids.maya, tpl_locked: 1 });
  assert.equal((await keys.otto.put(`/envelopes/${viaCreate.data.envelope.id}/access`, { locked: false })).status, 403, 'and its lock cannot be lifted by Otto');

  // An envelope Otto started from it, copied as an envelope, is locked in the same way, on the copy's own fields.
  const env = (await use(otto, tpl.id)).data.envelope;
  const twin = await otto.post(`/envelopes/${env.id}/clone`);
  const t2 = (await otto.get(`/envelopes/${twin.data.id}`)).data.envelope;
  assert.equal(t2.wording_lock.template, 'NDA');
  assert.deepEqual(t2.fields.filter((f: any) => t2.wording_lock.fixed.includes(f.id)).map((f: any) => f.value).sort(), ['Governed by the laws of Kenya.', 'USD 500']);
  const b = asBody(t2);
  assert.equal((await otto.put(`/envelopes/${t2.id}`, { ...b, fields: b.fields.map((f: any) => (f.type === 'note' ? { ...f, value: 'Mine' } : f)) })).status, 403);
  // And saved as a template, it is Maya's and locked, like a copy of the template.
  const asTpl = await otto.post(`/envelopes/${env.id}/clone`, { kind: 'template' });
  assert.equal(asTpl.data.belongs_to, 'Maya Lopez');
  assert.deepEqual({ ...db.get('SELECT sender_id, tpl_use, tpl_locked FROM envelopes WHERE id=?', asTpl.data.id) }, { sender_id: ids.maya, tpl_use: 'chosen', tpl_locked: 1 });

  // Not locked, but still only for the people chosen: the copy stays Maya's too (owner's decision: copying is never a
  // way round who can use it). It used to be Otto's, who could then open it to the whole team.
  await setRule(maya, tpl.id, { locked: false });
  const mine = await otto.post(`/envelopes/${tpl.id}/clone`);
  assert.deepEqual([mine.data.belongs_to, mine.data.locked], ['Maya Lopez', false]);
  assert.deepEqual({ ...db.get('SELECT sender_id, tpl_use FROM envelopes WHERE id=?', mine.data.id) }, { sender_id: ids.maya, tpl_use: 'chosen' });
  assert.equal((await otto.put(`/envelopes/${mine.data.id}/access`, { use: 'team' })).status, 403);
  assert.equal(await listed(chad, mine.data.id), false);
  // Open to the whole team and unlocked, a copy is the copier's to change, as before.
  await setRule(maya, tpl.id, { use: 'team' });
  const free = await otto.post(`/envelopes/${tpl.id}/clone`);
  assert.equal(free.data.belongs_to, undefined);
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', free.data.id).sender_id, ids.otto);
  assert.equal((await otto.put(`/envelopes/${free.data.id}`, { message: 'My version' })).status, 200);
  await setRule(maya, tpl.id, { use: 'chosen' });
  // Maya's own copy of her locked template is hers.
  await setRule(maya, tpl.id, { locked: true });
  assert.equal((await maya.post(`/envelopes/${tpl.id}/clone`)).data.belongs_to, undefined);
  // A locked envelope whose template is gone cannot become a template of Otto's, which would end the lock.
  const left = (await use(otto, tpl.id)).data.envelope;
  db.run('DELETE FROM envelopes WHERE id=?', tpl.id);
  const end = await otto.post(`/envelopes/${left.id}/clone`, { kind: 'template' });
  assert.equal(end.status, 403);
  assert.match(end.data.error, /A template made from it would no longer be locked, so it was not made\. Ask an admin of your team\.$/);
});

// ---- 5. Bulk sends and public forms ----------------------------------------------------------------------------

test('a bulk send and a public form follow the rule: using it for a batch, publishing it to strangers only for those who may change it', async () => {
  const { maya, chad, otto, admin, keys, ids } = await team();
  const tpl = await nda(maya);
  const rows = [{ Client: { name: 'Row One', email: 'row.one@tpl.example.com' } }, { Client: { name: 'Row Two', email: 'row.two@tpl.example.com' } }];

  // A locked template sent in bulk by Otto: every envelope of the batch is locked for him.
  await setRule(maya, tpl.id, { locked: true });
  const batch = await otto.post('/bulk', { template_id: tpl.id, rows });
  assert.equal(batch.status, 200, JSON.stringify(batch.data));
  assert.equal(batch.data.sent, 2);
  const one = (await otto.get(`/envelopes/${batch.data.results[0].id}`)).data.envelope;
  assert.equal(one.wording_lock.template, 'NDA');
  assert.equal((await otto.put(`/envelopes/${one.id}`, { ...asBody(one), message: 'Changed in bulk' })).status, 403);

  // Admins only: no batch for Otto, by browser or key, and none checked either. An admin can.
  await setRule(maya, tpl.id, { use: 'admins' });
  for (const c of [otto, keys.otto]) {
    assert.equal((await c.post('/bulk/check', { template_id: tpl.id, rows })).status, 403);
    assert.equal((await c.post('/bulk', { template_id: tpl.id, rows })).status, 403);
  }
  assert.equal((await admin.post('/bulk', { template_id: tpl.id, rows: [rows[0]] })).data.sent, 1);

  // A public form: only for those who may change the template. Chad is chosen to change it, Otto is not.
  await setRule(maya, tpl.id, { use: 'team', locked: false, change: 'chosen', members: [{ id: ids.chad, can_change: true }] });
  const ottoForm = await otto.post('/powerforms', { template_id: tpl.id, name: 'Otto form' });
  assert.equal(ottoForm.status, 403);
  assert.match(ottoForm.data.error, /^This template belongs to Maya Lopez, so only Maya Lopez, an admin of your team or a member they chose can publish it as a PowerForm\. Nothing was changed\. To have a PowerForm of your own, copy the template/);
  const form = await keys.chad.post('/powerforms', { template_id: tpl.id, name: 'NDA online' });
  assert.equal(form.status, 200, JSON.stringify(form.data));
  assert.equal((await chad.call('PATCH', `/powerforms/${form.data.id}`, { active: false })).status, 200);
  assert.equal((await otto.call('PATCH', `/powerforms/${form.data.id}`, { active: true })).status, 403);
  assert.equal((await keys.otto.call('DELETE', `/powerforms/${form.data.id}`)).status, 403);
  const forms = async (c: Client) => (await c.get('/powerforms')).data.powerforms.map((p: any) => [p.name, p.may_change]);
  assert.deepEqual(await forms(otto), [['NDA online', false]]);
  assert.deepEqual(await forms(chad), [['NDA online', true]]);
  // Locked, Otto is not told to copy it: a copy would be Maya's and locked too.
  await setRule(maya, tpl.id, { locked: true });
  const locked = await otto.post('/powerforms', { template_id: tpl.id, name: 'Otto form' });
  assert.match(locked.data.error, /Nothing was changed\. Its wording is locked, so a copy would be locked in the same way\. Ask Maya Lopez or an admin of your team\.$/);
  // Admins only: the form is not even listed for Otto, like the template.
  await setRule(maya, tpl.id, { use: 'admins', change: 'owner' });
  assert.deepEqual(await forms(otto), []);
  assert.deepEqual(await forms(admin), [['NDA online', true]]);
});

// ---- 6. Leaving and being removed -------------------------------------------------------------------------------

test('a member who leaves or is removed is no longer chosen, and their templates pass to the successor with their rules', async () => {
  const { owner, admin, maya, chad, otto, ids } = await team();
  const tpl = await nda(maya);
  await setRule(maya, tpl.id, { use: 'chosen', change: 'chosen', members: [{ id: ids.chad, can_change: true }, { id: ids.otto }] });
  const theirs = await nda(owner, 'Owner NDA');
  await setRule(owner, theirs.id, { use: 'chosen', members: [{ id: ids.maya }, { id: ids.otto }] });
  const lines = () => db.all('SELECT template_id, user_id FROM template_members ORDER BY template_id, user_id').filter((l) => [tpl.id, theirs.id].includes(l.template_id)).map((l) => `${l.template_id === tpl.id ? 'maya' : 'owner'}:${Object.entries(ids).find(([, v]) => v === l.user_id)?.[0]}`);
  assert.deepEqual(lines().sort(), ['maya:chad', 'maya:otto', 'owner:maya', 'owner:otto']);

  // Chad leaves by himself: his lines go.
  const left = await chad.post('/account/leave', { to: ids.owner });
  assert.equal(left.status, 200, JSON.stringify(left.data));
  assert.deepEqual(lines().sort(), ['maya:otto', 'owner:maya', 'owner:otto']);
  // Maya is removed by an admin and her template passes to the admin, rule and chosen people as they were. Her own
  // line on the owner's template goes.
  const gone = await admin.call('DELETE', `/account/members/${ids.maya}?to=${ids.admin}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.data));
  assert.deepEqual(lines().sort(), ['maya:otto', 'owner:otto']);
  assert.deepEqual({ ...db.get('SELECT sender_id, tpl_use, tpl_change FROM envelopes WHERE id=?', tpl.id) }, { sender_id: ids.admin, tpl_use: 'chosen', tpl_change: 'chosen' });
  assert.equal(await listed(otto, tpl.id), true, 'Otto still may use it');
  const r = await otto.post('/envelopes', { template_id: tpl.id, recipients: { Client: { name: 'C', email: 'c@tpl.example.com' } } });
  assert.equal(r.status, 200);
  // Refusals now name the person it passed to.
  assert.match((await otto.put(`/envelopes/${tpl.id}`, { message: 'x' })).data.error, /^This template belongs to Adam Admin\./);
});

// ---- 7. A database from before this -----------------------------------------------------------------------------

test('templates in a database from before this have the usual rule: everyone uses them, their owner and admins change them', async () => {
  const { maya, otto, admin } = await team();
  const tpl = await nda(maya);
  const before = await nda(maya, 'Old NDA');
  // Make the database look like one from before: none of the new columns, no table of chosen members. Then open it
  // again, which adds them the way it does when the new version starts on an existing database.
  const g = globalThis as any;
  for (const col of ['tpl_use', 'tpl_change', 'tpl_locked', 'wording_from', 'wording_fixed']) db.run(`ALTER TABLE envelopes DROP COLUMN ${col}`);
  db.run('DROP TABLE template_members');
  g.__tsdb.close();
  g.__tsdb = undefined;
  const cols = db.all('PRAGMA table_info(envelopes)').map((c: any) => c.name);
  for (const col of ['tpl_use', 'tpl_change', 'tpl_locked', 'wording_from', 'wording_fixed']) assert.ok(cols.includes(col), col);
  assert.equal(db.get("SELECT COUNT(*) n FROM sqlite_master WHERE name='template_members'").n, 1);
  assert.deepEqual({ ...db.get('SELECT tpl_use, tpl_change, tpl_locked, wording_from FROM envelopes WHERE id=?', before.id) }, { tpl_use: null, tpl_change: null, tpl_locked: 0, wording_from: null });
  // The usual rule, said in a sentence.
  const a = (await otto.get(`/envelopes/${before.id}/access`)).data.access;
  assert.deepEqual([a.use, a.change, a.locked, a.may_use, a.may_change], ['team', 'owner', false, true, false]);
  assert.equal(await listed(otto, before.id), true);
  assert.equal((await use(otto, before.id)).status, 200);
  assert.equal((await otto.put(`/envelopes/${before.id}`, { message: 'x' })).status, 403);
  assert.equal((await admin.put(`/envelopes/${before.id}`, { message: 'Admins still can' })).status, 200);
  assert.equal((await maya.put(`/envelopes/${tpl.id}/access`, { use: 'admins' })).status, 200, 'and a rule can be set on it');
  assert.equal(await listed(otto, tpl.id), false);
});

// ---- 8. Screens and what the pages promise ------------------------------------------------------------------------

const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the screens show the rule and the lock before anyone types, and the pages promise only what the code keeps', async () => {
  const list = read('src/app/app/templates/page.tsx');
  assert.match(list, /<AccessMarks access=\{t\.access\} \/>/, 'the list marks "Admins only", "Chosen members" and "Wording locked"');
  assert.equal(list.match(/onClick=\{\(\) => setRules\(t\)\} aria-label=\{`Who can use \$\{name\}`\}>Who can use this<\/button>/g)?.length, 2, 'on a phone and on a desktop, for everyone who sees the template');
  assert.equal(list.match(/\(t\.access\?\.may_delete \?\? t\.may_change\) !== false && <button className="btn sm ghost danger"/g)?.length, 2, 'Delete only for its owner and admins');
  assert.doesNotMatch(list, /Everyone on your team can use every template/);
  const who = read('src/components/templates/WhoCanUse.tsx');
  assert.match(who, /<legend>Who can use it<\/legend>/);
  assert.match(who, /<legend>Who can change it<\/legend>/);
  assert.match(who, /Lock the wording/);
  assert.match(who, /aria-describedby=\{off \? 'tr-team-why' : undefined\}/, 'a choice that is switched off says why');
  assert.match(who, /querySelector<HTMLElement>\('\[data-autofocus\]'\)\?\.focus\(\)/, 'focus moves into the dialog once the rule has loaded');
  assert.match(read('src/app/styles/tplroles.css'), /\.tr-tap \{ min-height: 44px; \}/);
  // The editor: the banner, and the locked parts drawn as locked.
  const editor = read('src/components/Editor.tsx');
  assert.match(editor, /\{wording && <WordingBanner lock=\{wording\} \/>\}/);
  assert.match(editor, /const isLockedField = useCallback\(\(f: any\) => signedFields\.has\(f\.id\) \|\| !!wording/);
  const add = read('src/components/editor/StepAdd.tsx');
  for (const part of [/\{!wording && \(\s*<label className=\{`drop ed-drop/,
    /\{!wording && <button type="button" className="btn sm ghost danger" onClick=\{\(\) => ed\.removeRcp/, /\{!wording && <div className="row wrap"/, /\{isTpl && <WhoCanUse templateId=\{env\.id\}/])
    assert.match(add, part);
  // (simplify-editor: the file's name, the role and the message are drawn by FileRow.tsx, PersonMore.tsx and ReviewParts.tsx.)
  assert.match(read('src/components/editor/FileRow.tsx'), /aria-label="File name" maxLength=\{200\} readOnly=\{!!ed\.wording\}/);
  assert.match(read('src/components/editor/PersonMore.tsx'), /aria-label="Role" disabled=\{!!wording\}/);
  assert.match(read('src/components/editor/ReviewParts.tsx'), /maxLength=\{5000\} readOnly=\{!!wording\}/);
  const fieldsStep = read('src/components/editor/StepFields.tsx');
  assert.match(fieldsStep, /title=\{again\} disabled=\{!!ed\.wording\}/, 'no field is added');
  assert.match(fieldsStep, /disabled=\{!ready \|\| !!finding \|\| !active \|\| !!ed\.wording\}/, 'none is found and added');
  assert.match(fieldsStep, /<WordingField field=\{selected\} lock=\{ed\.wording\}/, 'a field left empty can be filled in, and the rest says why it stays');
  assert.match(read('src/components/editor/ReviewParts.tsx'), /\{!ed\.wording && <PayLinkChoice/);
  // The words the screens use say what the server does.
  assert.match(LOCK_MEANS, /cannot change the documents, the fixed wording, the fields, the message, who signs in what order, or the private note and the checks the template gives each person\. The subject stays theirs to set\.$/);
  assert.equal(accessSentence({ use: 'team', change: 'owner', locked: false, owner: 'Maya Lopez' }), 'Everyone on the team can use it. Only Maya Lopez and admins can change it. Its wording is not locked: whoever uses it can change the envelope they make from it before sending. Only Maya Lopez and admins can change these rules or delete it.');
  // The pages that described templates.
  assert.doesNotMatch(read('src/app/security/page.tsx'), /Everyone on a team can use every template\./);
  assert.match(read('src/app/security/page.tsx'), /unless it is set to admins only or to chosen members/);
  const help = read('src/app/help/page.tsx');
  assert.match(help, /<QA id="template-access" q="Who can use and change a template, and what does a locked wording mean\?">/);
  assert.match(help, /the rules differ by country and by kind of document, so check what yours needs/);
  assert.match(read('src/app/developers/page.tsx'), /\['PUT', '\/api\/envelopes\/:id\/access'/);
  const { openapi } = await import('../src/server/openapi.ts');
  const spec: any = openapi();
  assert.ok(spec.paths['/envelopes/{id}/access'].get && spec.paths['/envelopes/{id}/access'].put);
  assert.deepEqual(spec.components.schemas.TemplateAccess.properties.use.enum, ['team', 'admins', 'chosen']);
  const readme = read('README.md');
  assert.match(readme, /\| `tests\/templates\.test\.ts` \|/);
  assert.match(readme, /the table `template_members`/);
  assert.match(readme, /\| Anyone on the team could open our HR letters, and a salesperson sent the contract with the liability clause changed\. \|/);
  for (const f of ['src/server/tplroles.ts', 'src/server/routes-templates.ts', 'src/lib/tplroles.ts', 'src/components/templates/WhoCanUse.tsx', 'tests/templates.test.ts']) assert.doesNotMatch(read(f), /\u2014/, `${f}: no em dashes`);
});

// ---- 9. Repairs after the skeptic's report (research/verify-new.json "verify:tplroles") ----------------------------

test('a copy of a template not for everyone, or of a locked one, stays with its owner and its rules: no copy opens it to the team, unlocks it or puts it on a public form', async () => {
  const { maya, chad, otto, admin, ids, keys } = await team();
  // (a) Unlocked, chosen members only, Otto chosen to use it. His copy, by browser or key, through /clone, through
  // POST /envelopes kind template, or through Save as template on an envelope he started, is Maya's with the same rule.
  const hr = await nda(maya, 'HR warning letter');
  await setRule(maya, hr.id, { use: 'chosen', members: [{ id: ids.otto }] });
  const env = (await use(otto, hr.id)).data.envelope;
  const copies = [
    (await otto.post(`/envelopes/${hr.id}/clone`)).data.id,
    (await keys.otto.post('/envelopes', { kind: 'template', template_id: hr.id, subject: 'Mine now' })).data.envelope.id,
    (await otto.post(`/envelopes/${env.id}/clone`, { kind: 'template' })).data.id,
  ];
  for (const id of copies) {
    assert.deepEqual({ ...db.get('SELECT sender_id, kind, tpl_use FROM envelopes WHERE id=?', id) }, { sender_id: ids.maya, kind: 'template', tpl_use: 'chosen' }, id);
    const widen = await otto.put(`/envelopes/${id}/access`, { use: 'team' });
    assert.equal(widen.status, 403, JSON.stringify(widen.data));
    assert.equal(await listed(chad, id), false);
    assert.equal((await use(chad, id)).status, 403, 'Chad was never chosen');
    assert.equal((await use(otto, id)).status, 200, 'Otto can use the copy, as he can use the template');
    // Its history says who made it, since it is in Maya's list with her name on it.
    assert.match(db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Copied'", id).detail, /^Made by Otto Other as a copy of the (template "HR warning letter"|envelope "HR warning letter", which was started from a template)\. It belongs to Maya Lopez, like that template, and keeps who can use and change it, so a copy is no way round them\.$/);
  }
  const answer = await otto.post(`/envelopes/${hr.id}/clone`);
  assert.deepEqual([answer.data.belongs_to, answer.data.locked], ['Maya Lopez', false], 'the answer says whose it is, and that it is not locked');
  // A refusal no longer tells Otto to make his own version by copying it.
  const change = await otto.put(`/envelopes/${hr.id}`, { message: 'x' });
  assert.match(change.data.error, /A copy of it would belong to Maya Lopez too, with the same rules, because the template is not for everyone\.$/);
  assert.doesNotMatch(change.data.error, /copy it and change the copy/);
  assert.equal((await otto.get(`/envelopes/${hr.id}/access`)).data.access.copy_is_yours, false);
  const form = await otto.post('/powerforms', { template_id: hr.id, name: 'HR to the world' });
  assert.match(form.data.error, /It is not for everyone on the team, so a copy would belong to Maya Lopez too\. Ask Maya Lopez or an admin of your team\.$/);

  // (b) Locked, chosen members only, Chad chosen to change it but not to set its rules. Every copy of his is Maya's,
  // locked, for the same people. He can still change its wording, as he can the template's, and nothing more.
  const locked = await nda(maya, 'Locked HR contract');
  await setRule(maya, locked.id, { use: 'chosen', change: 'chosen', locked: true, members: [{ id: ids.chad, can_change: true }] });
  for (const made of [await chad.post(`/envelopes/${locked.id}/clone`), await keys.chad.post('/envelopes', { kind: 'template', template_id: locked.id, subject: 'Mine now' })]) {
    const id = made.data.id || made.data.envelope.id;
    assert.deepEqual({ ...db.get('SELECT sender_id, tpl_use, tpl_change, tpl_locked FROM envelopes WHERE id=?', id) }, { sender_id: ids.maya, tpl_use: 'chosen', tpl_change: 'chosen', tpl_locked: 1 });
    assert.equal((await chad.put(`/envelopes/${id}/access`, { use: 'team', locked: false })).status, 403);
    assert.equal((await keys.chad.put(`/envelopes/${id}/access`, { use: 'team' })).status, 403);
    assert.equal((await chad.put(`/envelopes/${id}`, { message: 'Chad may change the wording' })).status, 200);
    assert.equal((await use(otto, id)).status, 403, 'Otto was never chosen');
    assert.equal((await chad.call('DELETE', `/envelopes/${id}`)).status, 403, 'and only Maya or an admin deletes it');
  }
  // The people responsible still make copies of their own: Maya and an admin, who may set the rules.
  const adminCopy = await admin.post(`/envelopes/${locked.id}/clone`);
  assert.equal(adminCopy.data.belongs_to, undefined);
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', adminCopy.data.id).sender_id, ids.admin);
  assert.equal((await maya.post(`/envelopes/${locked.id}/clone`)).data.belongs_to, undefined);

  // (c) A template made from an envelope whose template Otto may no longer use is not made at all.
  await setRule(maya, hr.id, { use: 'admins' });
  const late = await otto.post(`/envelopes/${env.id}/clone`, { kind: 'template' });
  assert.equal(late.status, 403);
  assert.equal(late.data.code, 'template_not_for_you');
  assert.match(late.data.error, /^This envelope was started from the template "HR warning letter", which you can no longer use, so a template made from it was not made\. Ask Maya Lopez or an admin of your team if you need it\.$/);
});

// A locked NDA whose one role the template gives a private note, a one-time code by email and an access code.
async function guarded(c: Client, subject = 'Guarded NDA') {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    kind: 'template', subject, message: 'Please sign the NDA.', documents: [{ id: 'd', file_id: file.id, name: 'NDA' }],
    recipients: [
      { id: 'r', role: 'signer', role_name: 'Client', note: 'Read clause 4 on liability before you sign.', access_code: '7788', verify: 'email_code' },
      { id: 'w', role: 'signer', role_name: 'Guarantor' },
    ],
    fields: [
      { id: 'sig', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 },
      { id: 'sig2', document_id: 'd', recipient_id: 'w', type: 'signature', page: 0, x: 0.5, y: 0.8, w: 0.3, h: 0.06 },
      { id: 'plan', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Plan', value: 'Gold', page: 0, x: 0.1, y: 0.25, w: 0.3, h: 0.03 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
const fill = { Client: { name: 'Cleo Client', email: 'cleo@tpl.example.com' }, Guarantor: { name: 'Gus Guarantor', email: 'gus@tpl.example.com' } };

test('a locked wording keeps what the template gave each person, and who signs: the note, the code check, the access code, no group in a person\'s place, also through a correction', async () => {
  const { owner, maya, otto, keys } = await team();
  const tpl = await guarded(maya);
  await setRule(maya, tpl.id, { locked: true });
  const e = (await otto.post('/envelopes', { template_id: tpl.id, recipients: fill })).data.envelope;
  const got = async () => (await otto.get(`/envelopes/${e.id}`)).data.envelope;
  const g = await got();
  const client = g.recipients.find((r: any) => r.role_name === 'Client');
  assert.deepEqual(g.wording_lock.people[client.id], { note: 1, verify: 'email_code', code: 1 }, 'the editor is told what stays for whom');
  const put = (over: (r: any) => any, c: Client = keys.otto) => got().then((x) => c.put(`/envelopes/${e.id}`, { ...asBody(x), recipients: x.recipients.map((r: any) => (r.role_name === 'Client' ? over(r) : r)) }));
  const refused: [string, (r: any) => any, RegExp][] = [
    ['a new note', (r) => ({ ...r, note: 'IGNORE CLAUSE 4. The fee is now USD 5,000, sign anyway.' }), /^The private note for Cleo Client comes from the template, and it cannot be changed or taken off\./],
    ['the note taken off', (r) => ({ ...r, note: '' }), /private note/],
    ['the note left out', ({ note: _n, ...r }) => r, /private note/],
    ['the code check taken off', (r) => ({ ...r, verify: 'none' }), /^The template asks Cleo Client for a one-time code before the document opens, and that check cannot be taken off\./],
    ['the access code taken off', (r) => ({ ...r, access_code: '' }), /^The template gives Cleo Client an access code, and it cannot be taken off\. It can be changed\./],
    ['the access code left out', ({ access_code: _a, ...r }) => r, /access code/],
  ];
  for (const [what, over, msg] of refused) {
    const r = await put(over);
    assert.equal(r.status, 403, `${what}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, 'wording_locked');
    assert.match(r.data.error, msg, what);
    assert.match(r.data.error, /Nothing was saved\./);
  }
  // A signing group in the place of the person: any member of it could then sign.
  const grp = await owner.post('/groups', { name: 'Sales', members: [{ name: 'S One', email: 's1@tpl.example.com' }, { name: 'S Two', email: 's2@tpl.example.com' }] });
  assert.equal(grp.status, 200, JSON.stringify(grp.data));
  const asGroup = await put((r) => ({ ...r, group_id: grp.data.group.id }));
  assert.equal(asGroup.status, 403);
  assert.match(asGroup.data.error, /^Cleo Client cannot be turned into a signing group, or a group into one person: who signs is part of the template\./);
  const after = await got();
  const c2 = after.recipients.find((r: any) => r.role_name === 'Client');
  assert.deepEqual([c2.note, c2.access_code, c2.verify, c2.group_id ?? null], ['Read clause 4 on liability before you sign.', '7788', 'email_code', null], 'nothing was saved');
  // What stays open: another access code, the name and address, a note for the person the template gave none, the subject.
  assert.equal((await put((r) => ({ ...r, access_code: '9911', name: 'Cleo M. Client' }))).status, 200);
  const free = await got().then((x) => keys.otto.put(`/envelopes/${e.id}`, { ...asBody(x), recipients: x.recipients.map((r: any) => (r.role_name === 'Guarantor' ? { ...r, note: 'Call me if anything is unclear.' } : r)) }));
  assert.equal(free.status, 200, JSON.stringify(free.data));
  assert.equal((await otto.put(`/envelopes/${e.id}`, { subject: 'NDA, Cleo Client' })).status, 200);
  // Once it is out, a correction is held to the same.
  assert.equal((await otto.post(`/envelopes/${e.id}/send`)).status, 200);
  for (const [patch, msg] of [[{ verify: 'none' }, /one-time code/], [{ access_code: '' }, /access code, and it cannot be taken off/]] as const) {
    const r = await keys.otto.post(`/envelopes/${e.id}/correct`, { recipient_id: client.id, ...patch });
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.match(r.data.error, msg);
    assert.match(r.data.error, /Nothing was changed\. If it needs to change, ask Maya Lopez or an admin of your team\.$/);
  }
  assert.equal((await keys.otto.post(`/envelopes/${e.id}/correct`, { recipient_id: client.id, name: 'Cleo Maria Client' })).status, 200, 'a name can still be put right');
  // The template's owner is not held to it on her own envelope.
  const hers = (await maya.post('/envelopes', { template_id: tpl.id, recipients: fill })).data.envelope;
  const h = (await maya.get(`/envelopes/${hers.id}`)).data.envelope;
  assert.equal(h.wording_lock, null);
  assert.equal((await maya.put(`/envelopes/${hers.id}`, { ...asBody(h), recipients: h.recipients.map((r: any) => ({ ...r, note: '', verify: 'none', access_code: '' })) })).status, 200);
});

test('an envelope from before the lock cannot be cloned into a new unlocked one; the owner of a deleted template keeps her envelopes; bulk columns for the people responsible; replay after the template was taken away; files by id', async () => {
  const { maya, otto, admin, keys } = await team();
  // (a) Started before the lock, cloned after it.
  const tpl = await nda(maya);
  const early = (await use(otto, tpl.id)).data.envelope;
  const mayasEarly = (await use(maya, tpl.id)).data.envelope;
  await setRule(maya, tpl.id, { locked: true });
  for (const c of [otto, keys.otto]) {
    const r = await c.post(`/envelopes/${early.id}/clone`);
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.equal(r.data.code, 'wording_locked');
    assert.match(r.data.error, /^This envelope was started from the template "NDA" before its wording was locked, so it is not locked itself, and a copy made now would not be either\. So no copy was made\. To send it again, use the template: /);
  }
  assert.equal((await maya.post(`/envelopes/${mayasEarly.id}/clone`)).status, 200, 'Maya may change the template, so her copy is fine');
  assert.equal((await admin.post(`/envelopes/${early.id}/clone`)).status, 200, 'and an admin can');
  assert.equal((await otto.put(`/envelopes/${early.id}`, { message: 'The early draft itself stays as it was: not locked' })).status, 200);

  // (b) Maya deletes her own locked template: she keeps changing the envelope she started from it, Otto does not,
  // and his refusal now names her.
  const mine = (await use(maya, tpl.id)).data.envelope;
  const his = (await use(otto, tpl.id, 'later@tpl.example.com')).data.envelope;
  assert.equal((await maya.call('DELETE', `/envelopes/${tpl.id}`)).status, 200);
  assert.equal((await maya.get(`/envelopes/${mine.id}`)).data.envelope.wording_lock, null);
  assert.equal((await maya.put(`/envelopes/${mine.id}`, { message: 'Maya wording 2' })).status, 200);
  assert.equal((await maya.post(`/envelopes/${mine.id}/clone`, { kind: 'template' })).status, 200, 'and may make a template of it again');
  const no = await otto.put(`/envelopes/${his.id}`, { message: 'Otto wording' });
  assert.equal(no.status, 403);
  assert.match(no.data.error, /ask Maya Lopez or an admin of your team to change this envelope for you\.$/);
  assert.equal((await otto.get(`/envelopes/${his.id}`)).data.envelope.wording_lock.ask, 'Maya Lopez or an admin of your team');

  // (c) A bulk column for a value the template filled in: refused for Otto once it is locked, never for Maya or an admin.
  const g = await guarded(maya, 'Bulk NDA');
  await setRule(maya, g.id, { locked: true });
  const row = (n: string) => [{ Client: { name: `Row ${n}`, email: `row.${n}@tpl.example.com` }, Guarantor: { name: 'Gus', email: `gus.${n}@tpl.example.com` }, fields: { Plan: 'Silver' } }];
  for (const [who, c, n] of [['maya', maya, 'm'], ['admin', admin, 'a'], ['maya key', keys.maya, 'k']] as const) {
    const r = await c.post('/bulk', { template_id: g.id, rows: row(n) });
    assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.sent, 1, `${who}: ${JSON.stringify(r.data.failed)}`);
    const plan = (await c.get(`/envelopes/${r.data.results[0].id}`)).data.envelope.fields.find((f: any) => f.label === 'Plan');
    assert.equal(plan.prefill ?? plan.value, 'Silver', who);
  }
  const ottoRow = await otto.post('/bulk', { template_id: g.id, rows: row('o') });
  assert.equal(ottoRow.status, 400);
  assert.match(ottoRow.data.error, /holds the template's own wording and cannot be changed by a row/);

  // (d) The same bulk call repeated with its key after Otto lost the template: what is left is not sent, and says why.
  const k = { 'idempotency-key': 'order-1' };
  const two = [{ ...fill, Client: { name: 'R1', email: 'r1@tpl.example.com' } }, { ...fill, Client: { name: 'R2', email: 'r2@tpl.example.com' } }];
  const first = await otto.call('POST', '/bulk', { template_id: g.id, rows: two }, k);
  assert.equal(first.data.sent, 2, JSON.stringify(first.data));
  await setRule(maya, g.id, { use: 'admins' });
  const second = db.get('SELECT envelope_id FROM bulk_rows WHERE bulk_id=? AND position=1', first.data.id).envelope_id;
  db.run('DELETE FROM envelopes WHERE id=?', second);
  db.run('UPDATE bulk_rows SET sent_at=NULL, envelope_id=NULL, fill=? WHERE bulk_id=? AND position=1', JSON.stringify(two[1]), first.data.id);
  const again = await otto.call('POST', '/bulk', { template_id: g.id, rows: two }, k);
  assert.equal(again.data.sent, 1, JSON.stringify(again.data));
  assert.match(again.data.failed[0].error, /^Not sent\. The template "Bulk NDA" is no longer one the person who started this bulk send may use\. Ask Maya Lopez or an admin of your team\.$/);

  // (e) The template's document by its file id: not for Otto once it is admins only, still for those who may use it
  // and for Otto through an envelope of his own that holds it. A file he just uploaded is his to read as before.
  const hrOnly = await nda(maya, 'Layoffs 2026 letter');
  await setRule(maya, hrOnly.id, { use: 'admins' });
  const fileId = db.get('SELECT file_id FROM documents WHERE envelope_id=?', hrOnly.id).file_id;
  const ownFile = await upload(otto, 1);
  for (const c of [otto, keys.otto]) {
    const r = await c.get(`/files/${fileId}/content`);
    assert.equal(r.status, 404, JSON.stringify(r.data));
    assert.equal((await c.get(`/files/${ownFile.id}/content`)).status, 200);
  }
  for (const c of [maya, admin]) assert.equal((await c.get(`/files/${fileId}/content`)).status, 200);
  const hrFile = db.get('SELECT file_id FROM documents WHERE envelope_id=?', early.id).file_id;
  assert.equal((await otto.get(`/files/${hrFile}/content`)).status, 200, 'through his own envelope started before');
});

test('the smaller things: a history line when a chosen member leaves or is removed, the sentence with several people, plain words for odd input, a radio that is never squeezed', async () => {
  const { maya, chad, otto, admin, ids } = await team();
  const tpl = await nda(maya);
  await setRule(maya, tpl.id, { use: 'chosen', change: 'chosen', members: [{ id: ids.chad, can_change: true }, { id: ids.otto }] });
  const sentence = accessSentence((await maya.get(`/envelopes/${tpl.id}/access`)).data.access);
  assert.match(sentence, /^Only admins, Maya Lopez, Chad Chosen and Otto Other can use it\. Maya Lopez, admins and Chad Chosen can change it\./);
  assert.equal(accessSentence({ use: 'admins', change: 'chosen', locked: false, owner: 'Maya Lopez', chosen_change: ['Chad Chosen', 'Otto Other'] }).split('. ').slice(0, 2).join('. '),
    'Only admins, Maya Lopez, Chad Chosen and Otto Other can use it. Maya Lopez, admins, Chad Chosen and Otto Other can change it');
  // Chad leaves by himself, Otto is removed by an admin: each is a line in the template's history, with who did it.
  const lines = () => historyOf(tpl.id);
  assert.equal(lines().length, 1);
  assert.equal((await chad.post('/account/leave', { to: ids.owner })).status, 200);
  assert.equal(lines().length, 2);
  assert.match(lines()[1].detail, /^Chad Chosen is no longer on the team, so they are no longer chosen\. Only admins, Maya Lopez and Otto Other can use it\. Only Maya Lopez and admins can change it, because nobody else has been chosen yet\. .* Before: Only admins, Maya Lopez, Chad Chosen and Otto Other can use it\./);
  assert.equal((await admin.call('DELETE', `/account/members/${ids.otto}?to=${ids.admin}`)).status, 200);
  assert.equal(lines().length, 3);
  assert.match(lines()[2].actor, /^Adam Admin\b/, 'written by the admin who removed him');
  assert.match(lines()[2].detail, /^Otto Other is no longer on the team, so they are no longer chosen\. Only admins and Maya Lopez can use it, because nobody else has been chosen yet\./);
  // A list or an object where a choice belongs is said as it was sent.
  const list = await maya.put(`/envelopes/${tpl.id}/access`, { use: ['team'] });
  assert.equal(list.status, 400);
  assert.equal(list.data.error, '"use" is ["team"], and it has to be one of team, admins, chosen, written as text in quotes. Nothing was changed.');
  const obj = await maya.put(`/envelopes/${tpl.id}/access`, { change: { a: 1 } });
  assert.equal(obj.data.error, '"change" is {"a":1}, and it has to be one of owner, chosen, team, written as text in quotes. Nothing was changed.');
  assert.equal(db.get('SELECT tpl_use FROM envelopes WHERE id=?', tpl.id).tpl_use, 'chosen', 'nothing was changed');
  assert.match(read('src/app/styles/sender.css'), /\.sn-choice input \{[^}]*flex-shrink: 0;/, 'a radio next to a long name that wraps keeps its size');
});

test('the pages promise what the repaired code keeps: copies, the lock on notes and checks, the subject, files, and the editor shows it before anyone types', async () => {
  const help = read('src/app/help/page.tsx');
  assert.doesNotMatch(help, /A copy of a template keeps who can use it, and a copy of a locked one stays with its owner, so a copy is no way round the lock\./, 'the old claim, false for restricted templates');
  assert.match(help, /A copy of a template that is not for everyone, or that is locked, made by someone who may not set its rules, belongs to the person the template belongs to/);
  assert.match(help, /it cannot be copied into a new unlocked one, so to send it again you use the template/);
  assert.match(help, /The subject stays theirs to set/);
  assert.match(help, /a one-time code it asks for can go by email or by text but not be taken off/);
  const { openapi } = await import('../src/server/openapi.ts');
  const spec: any = openapi();
  const clone = spec.paths['/envelopes/{id}/clone'].post.description;
  assert.match(clone, /not for everyone on the team or whose wording is locked, made by someone who may not set its rules/);
  assert.match(clone, /cannot be copied by someone the lock is for \(403, "code": "wording_locked"\)/);
  assert.ok(spec.components.schemas.TemplateAccess.properties.copy_is_yours);
  assert.match(spec.paths['/envelopes/{id}'].put.description, /what the template gave each person: their private note, a one-time code check/);
  assert.match(read('src/app/developers/page.tsx'), /A copy of one that is locked or not for everyone, made by someone who may not set its rules, stays with its owner/);
  // The template page does not invite a copy that would not be theirs, and the toast says whose a copy is.
  const page = read('src/app/app/envelopes/[id]/page.tsx');
  assert.match(page, /const tplHeld = isTpl && !mayChange && e\.access\?\.copy_is_yours === false;/);
  assert.match(page, /: tplLocked \|\| tplHeld \? <div className="sn-now-actions"><button className="btn primary" disabled=\{busy\} onClick=\{\(\) => clone\('envelope'\)\}>Use<\/button><\/div>/);
  assert.match(page, /It keeps the rules of the template it came from\$\{r\.locked \? ', and its wording stays locked' : ''\}, so it belongs to \$\{r\.belongs_to\}\./);
  // The editor: the note from the template is read-only, "no check" is not offered, and a line says why.
  // (simplify-editor: a person's note and check are in their More, PersonMore.tsx, where `kept` is wording.people[r.id].)
  const add = read('src/components/editor/PersonMore.tsx');
  assert.match(add, /const kept = wording\?\.people\?\.\[r\.id\];/);
  assert.match(add, /readOnly=\{!!kept\?\.note\}/);
  assert.match(add, /keepCode=\{!!kept\?\.verify\}/);
  assert.match(add, /\{kept && <LockedLine>\{keptLine\(kept, wording!\.ask\)\}<\/LockedLine>\}/);
  assert.match(read('src/components/sender/CheckFields.tsx'), /\{\(!keepCode \|\| verify === 'none'\) && <option value="none">/);
  const { keptLine } = await import('../src/lib/tplroles.ts');
  assert.equal(keptLine({ note: 1, verify: 'email_code', code: 1 }, 'Maya Lopez or an admin of your team'), 'From the template, and it stays: the private note, a one-time code before the document opens (by email or by text message, but not none) and an access code (you can change it, not take it off). To change them, ask Maya Lopez or an admin of your team.');
  assert.match(lockedBanner('NDA', 'Maya Lopez or an admin of your team'), /and choose the subject\. .*the notes and checks it gives each person stay as the template has them\./);
  for (const f of ['src/server/tplroles.ts', 'src/server/routes-templates.ts', 'src/lib/tplroles.ts', 'tests/templates.test.ts', 'src/app/help/page.tsx', 'src/components/editor/StepAdd.tsx', 'src/components/editor/PersonMore.tsx', 'src/components/sender/CheckFields.tsx']) assert.doesNotMatch(read(f), /\u2014/, `${f}: no em dashes`);
});
