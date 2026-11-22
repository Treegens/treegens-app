// Several templates in one document ("Add another template", "template_ids"), and "This looks like your template
// ... Use it?" after an upload (src/server/tplcombine.ts, src/server/tplmatch.ts).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { boot, Client, upload, signUp, tokenFor, samplePdf, type Server } from './helpers.ts';
import { differenceLines, matchLine, useLabel, useMeans } from '../src/lib/tplcombine.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

const PW = 'correct horse battery';
let n = 0;
const ip = () => `10.81.${Math.floor(++n / 250)}.${n % 250}`;
const inviteFor = (email: string) => db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY created_at DESC', email)?.token;
async function join(owner: Client, name: string, email: string, role = 'member') {
  assert.equal((await owner.post('/account/invites', { email, role })).status, 200);
  const c = Object.assign(new Client(), { ip: ip() });
  const r = await c.post('/auth/signup', { name, email, password: PW, invite: inviteFor(email) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}
let teams = 0;
async function team() {
  const t = ++teams;
  const owner = await signUp('Olive Owner', `olive.${t}@combine.example.com`, ip());
  const maya = await join(owner, 'Maya Lopez', `maya.${t}@combine.example.com`);
  const otto = await join(owner, 'Otto Other', `otto.${t}@combine.example.com`);
  return { t, owner, maya, otto };
}
const asBody = (e: any) => ({ subject: e.subject, message: e.message, ordered: e.ordered, documents: e.documents, recipients: e.recipients, fields: e.fields, edit_version: e.edit_version });
const envelopes = () => db.get("SELECT COUNT(*) n FROM envelopes WHERE kind='envelope'").n as number;
const twoSentences = (s: string) => {
  const parts = s.split(/(?<=\.)\s+(?=[A-Z])/);
  assert.ok(parts.length >= 2, `"${s}" says what happened and what to do`);
  assert.ok(!/—/.test(s), 'no em dashes');
};

// A volunteer agreement: the Volunteer signs and the Coordinator approves.
async function volunteer(c: Client, subject = 'Volunteer agreement', file?: any) {
  const f = file || (await upload(c, 1));
  const r = await c.post('/envelopes', {
    kind: 'template', subject, message: 'Please sign the volunteer agreement.', documents: [{ id: 'd', file_id: f.id, name: subject }],
    recipients: [{ id: 'v', role: 'signer', role_name: 'Volunteer' }, { id: 'k', role: 'approver', role_name: 'Coordinator', name: 'Cora Coord', email: 'cora@combine.example.com', routing_order: 2 }],
    fields: [
      { id: 'vs', document_id: 'd', recipient_id: 'v', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 },
      { id: 'vn', document_id: 'd', type: 'note', value: 'Volunteers plant at their own pace.', page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.03 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
// A photo release: the same Volunteer signs again, and a Parent signs too.
async function release(c: Client, subject = 'Photo release', role = 'signer') {
  const f = await upload(c, 1);
  const r = await c.post('/envelopes', {
    kind: 'template', subject, message: 'Please sign the photo release.', documents: [{ id: 'd', file_id: f.id, name: subject }],
    recipients: [{ id: 'v', role, role_name: ' volunteer ' }, { id: 'p', role: 'signer', role_name: 'Parent' }],
    fields: [
      { id: 'rs', document_id: 'd', recipient_id: 'v', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 },
      { id: 'ps', document_id: 'd', recipient_id: 'p', type: 'signature', page: 0, x: 0.5, y: 0.7, w: 0.3, h: 0.06 },
      { id: 'rn', document_id: 'd', type: 'note', value: 'Photos are used on our website only.', page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.03 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}

// ---- 1. Combine ---------------------------------------------------------------------------------------------------

test('two templates make one document: files one after the other, a role with the same name is one person, fields carried over', async () => {
  const { maya } = await team();
  const a = await volunteer(maya);
  const b = await release(maya);
  const r = await maya.post('/envelopes', { template_ids: [a.id, b.id], recipients: { Volunteer: { name: 'Vic Volunteer', email: 'vic@combine.example.com' }, Parent: { name: 'Pat Parent', email: 'pat@combine.example.com' } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = (await maya.get(`/envelopes/${r.data.envelope.id}`)).data.envelope;
  assert.equal(e.subject, 'Volunteer agreement and Photo release');
  assert.equal(e.message, 'Please sign the volunteer agreement.');
  assert.deepEqual(e.documents.map((d: any) => d.name), ['Volunteer agreement', 'Photo release']);
  // Volunteer (from both), Coordinator, Parent: three people, the volunteer once.
  assert.deepEqual(e.recipients.map((x: any) => [x.role_name.trim(), x.email]).sort(), [['Coordinator', 'cora@combine.example.com'], ['Parent', 'pat@combine.example.com'], ['Volunteer', 'vic@combine.example.com']]);
  const vic = e.recipients.find((x: any) => x.email === 'vic@combine.example.com');
  const sigs = e.fields.filter((f: any) => f.type === 'signature' && f.recipient_id === vic.id);
  assert.deepEqual(sigs.map((f: any) => e.documents.find((d: any) => d.id === f.document_id).name).sort(), ['Photo release', 'Volunteer agreement'], 'Vic signs on both files');
  assert.equal(e.fields.length, 5, 'every field of both templates came');
  assert.ok(e.fields.every((f: any) => !f.recipient_id || e.recipients.some((x: any) => x.id === f.recipient_id)), 'no field points at someone who is not on it');
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id LIKE ? AND kind=?', 'env_%', 'envelope').n >= 1, true);
  assert.match(db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Started from templates'", e.id).detail, /^Started from 2 templates, one after the other: "Volunteer agreement", "Photo release"\. Roles with the same name are one person\.$/);
  // It sends like any other document: Vic gets one invitation for both files.
  const sent = await maya.post(`/envelopes/${e.id}/send`, {});
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  // Nothing of the temporary copy is left behind.
  assert.equal(db.get("SELECT COUNT(*) n FROM documents d LEFT JOIN envelopes e ON e.id=d.envelope_id WHERE e.id IS NULL").n, 0);
});

test('combining is refused, with nothing made, when one role has two jobs, for one template, the same one twice, or with template_id too', async () => {
  const { maya } = await team();
  const a = await volunteer(maya);
  const copyRole = await release(maya, 'Copy for the volunteer', 'cc');
  const before = envelopes();
  const clash = await maya.post('/envelopes', { template_ids: [a.id, copyRole.id] });
  assert.equal(clash.status, 400);
  assert.equal(clash.data.code, 'roles_differ');
  assert.match(clash.data.error, /^Both "Volunteer agreement" and "Copy for the volunteer" have a role called Volunteer, and a role is one person\. In "Volunteer agreement" Volunteer signs and in "Copy for the volunteer" Volunteer gets a copy\. Give the role/);
  twoSentences(clash.data.error);
  for (const [body, words] of [
    [{ template_ids: [a.id] }, /needs two templates or more/],
    [{ template_ids: [a.id, a.id] }, /names the same template twice/],
    [{ template_ids: 'x' }, /must be a list of template ids/],
    [{ template_ids: [a.id, copyRole.id], template_id: a.id }, /not both/],
    [{ template_ids: [a.id, copyRole.id], kind: 'template' }, /not a new template/],
    [{ template_ids: [a.id, 'tpl_nothere'] }, /not found/],
  ] as [any, RegExp][]) {
    const r = await maya.post('/envelopes', body);
    assert.ok(r.status === 400 || r.status === 404, JSON.stringify(r.data));
    assert.match(r.data.error, words);
    if (r.status === 400) twoSentences(r.data.error);
  }
  // Two templates naming different people for the same role.
  const named1 = await maya.post('/envelopes', { kind: 'template', subject: 'Named one', documents: [{ id: 'd', file_id: (await upload(maya, 1)).id, name: 'One' }], recipients: [{ id: 'r', role: 'signer', role_name: 'Client', name: 'Ann', email: 'ann@combine.example.com' }] });
  const named2 = await maya.post('/envelopes', { kind: 'template', subject: 'Named two', documents: [{ id: 'd', file_id: (await upload(maya, 1)).id, name: 'Two' }], recipients: [{ id: 'r', role: 'signer', role_name: 'Client', name: 'Bo', email: 'bo@combine.example.com' }] });
  const two = await maya.post('/envelopes', { template_ids: [named1.data.envelope.id, named2.data.envelope.id] });
  assert.equal(two.status, 400);
  assert.match(two.data.error, /each template names a different person for it/);
  // Filling the role in for both is fine: then it is one person.
  assert.equal((await maya.post('/envelopes', { template_ids: [named1.data.envelope.id, named2.data.envelope.id], recipients: { Client: { name: 'Cy', email: 'cy@combine.example.com' } } })).status, 200);
  assert.equal(envelopes(), before + 1, 'only the last one was made');
});

test('who can use each template still holds: one that is not for this person stops the whole document', async () => {
  const { maya, otto } = await team();
  const a = await volunteer(otto);
  const b = await release(maya);
  assert.equal((await maya.put(`/envelopes/${b.id}/access`, { use: 'admins' })).status, 200);
  const before = envelopes();
  const r = await otto.post('/envelopes', { template_ids: [a.id, b.id] });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'template_not_for_you');
  assert.equal(envelopes(), before, 'nothing was made');
});

test('a locked template keeps its own part locked, and the other part stays open', async () => {
  const { owner, maya, otto } = await team();
  const open = await volunteer(otto);
  const locked = await release(maya);
  assert.equal((await maya.put(`/envelopes/${locked.id}/access`, { locked: true })).status, 200);
  // A message of his own is refused: the locked template's wording includes its message.
  const own = await otto.post('/envelopes', { template_ids: [open.id, locked.id], message: 'Hi' });
  assert.equal(own.status, 403);
  assert.equal(own.data.code, 'wording_locked');
  const r = await otto.post('/envelopes', { template_ids: [open.id, locked.id], recipients: { Volunteer: { name: 'Vic', email: 'vic@combine.example.com' }, Parent: { name: 'Pat', email: 'pat@combine.example.com' } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  const read = async (c: Client = otto) => (await c.get(`/envelopes/${eid}`)).data.envelope;
  const e = await read();
  assert.equal(e.message, 'Please sign the photo release.', 'the locked part\'s message is the one sent');
  assert.equal(e.wording_lock.template, 'Photo release');
  const [docA, docB] = e.documents;
  const noteOf = (x: any, d: any) => x.fields.find((f: any) => f.type === 'note' && f.document_id === d.id);

  // The open part: its note can be changed, and a field added to its file.
  const b1 = asBody(e);
  b1.fields = b1.fields.map((f: any) => (f.id === noteOf(e, docA).id ? { ...f, value: 'Volunteers plant at their own pace, with a partner.' } : f));
  b1.fields.push({ id: 'extra', document_id: docA.id, type: 'note', value: 'Bring gloves.', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.03 });
  const ok = await otto.put(`/envelopes/${eid}`, b1);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const after = await read();
  assert.equal(noteOf(after, docA).value, 'Volunteers plant at their own pace, with a partner.');

  // The locked part: its note, its file, its people and the message stay.
  const cur = asBody(after);
  const tries: [string, any, RegExp][] = [
    ['its note', { ...cur, fields: cur.fields.map((f: any) => (f.id === noteOf(after, docB).id ? { ...f, value: 'Photos are used anywhere.' } : f)) }, /holds wording from the template/],
    ['its file', { ...cur, documents: cur.documents.filter((d: any) => d.id !== docB.id), fields: cur.fields.filter((f: any) => f.document_id !== docB.id) }, /^The documents cannot be changed/],
    ['a field added to its file', { ...cur, fields: [...cur.fields, { document_id: docB.id, type: 'note', value: 'Extra', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.03 }] }, /^Fields cannot be added or removed/],
    ['its parent', { ...cur, recipients: cur.recipients.filter((x: any) => x.role_name !== 'Parent'), fields: cur.fields.filter((f: any) => f.recipient_id !== cur.recipients.find((x: any) => x.role_name === 'Parent').id) }, /^People cannot be added or taken off/],
    ['the message', { ...cur, message: 'Changed' }, /^The message cannot be changed/],
  ];
  for (const [what, body, words] of tries) {
    const r2 = await otto.put(`/envelopes/${eid}`, body);
    assert.equal(r2.status, 403, `${what}: ${JSON.stringify(r2.data)}`);
    assert.match(r2.data.error, words, what);
    assert.match(r2.data.error, /This envelope was started from the template "Photo release", whose wording is locked\./);
  }
  // The open part's file can go: what is left is the locked part, as the template has it.
  const without = await otto.put(`/envelopes/${eid}`, { ...cur, documents: cur.documents.filter((d: any) => d.id !== docA.id), fields: cur.fields.filter((f: any) => f.document_id !== docA.id) });
  assert.equal(without.status, 200, JSON.stringify(without.data));
  // An admin is not held to the lock at all.
  assert.equal((await read(owner)).wording_lock, null);
  // A copy of it is no way round the lock: the copy is locked as a whole.
  const copy = await otto.post(`/envelopes/${eid}/clone`);
  assert.equal(copy.status, 200, JSON.stringify(copy.data));
  const c2 = (await otto.get(`/envelopes/${copy.data.id}`)).data.envelope;
  assert.equal(c2.wording_lock?.template, 'Photo release');
  assert.equal((await otto.put(`/envelopes/${c2.id}`, { ...asBody(c2), message: 'Changed' })).status, 403);
});

test('a document made from two templates whose second is locked stays locked after the template is deleted', async () => {
  const { maya, otto } = await team();
  const open = await volunteer(otto);
  const locked = await release(maya);
  assert.equal((await maya.put(`/envelopes/${locked.id}/access`, { locked: true })).status, 200);
  const eid = (await otto.post('/envelopes', { template_ids: [open.id, locked.id] })).data.envelope.id;
  assert.equal((await maya.call('DELETE', `/envelopes/${locked.id}`)).status, 200);
  const e = (await otto.get(`/envelopes/${eid}`)).data.envelope;
  assert.ok(e.wording_lock, 'still locked for Otto');
  const cur = asBody(e);
  const r = await otto.put(`/envelopes/${eid}`, { ...cur, message: 'Changed' });
  assert.equal(r.status, 403);
});

// ---- 1b. The lock of each part on a copy, a template made from it, and someone who changes it on their turn ------

const lockIt = async (c: Client, id: string) => assert.equal((await c.put(`/envelopes/${id}/access`, { locked: true })).status, 200);

test('a template made from a combined document is refused when a later part is locked or not for everyone, so no lock or rule is lost', async () => {
  const { owner, maya, otto } = await team();
  const open = await volunteer(otto);
  const locked = await release(maya);
  await lockIt(maya, locked.id);
  const eid = (await otto.post('/envelopes', { template_ids: [open.id, locked.id] })).data.envelope.id;
  const tpls = () => db.get("SELECT COUNT(*) n FROM envelopes WHERE kind='template'").n as number;
  const before = tpls();
  const r = await otto.post(`/envelopes/${eid}/clone`, { kind: 'template' });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.equal(r.data.code, 'wording_locked');
  assert.match(r.data.error, /"Photo release" has locked wording/);
  assert.match(r.data.error, /Add another template/);
  twoSentences(r.data.error);
  assert.equal(tpls(), before, 'no template was made');

  // A later part that is only for chosen people: the same, so a copy is no way to give it to the whole team.
  const hr = await release(maya, 'HR form');
  assert.equal((await maya.put(`/envelopes/${hr.id}/access`, { use: 'chosen', members: [db.get('SELECT id FROM users WHERE email=?', `otto.${teams}@combine.example.com`).id] })).status, 200);
  const e2 = (await otto.post('/envelopes', { template_ids: [open.id, hr.id] })).data.envelope.id;
  const r2 = await otto.post(`/envelopes/${e2}/clone`, { kind: 'template' });
  assert.equal(r2.status, 403, JSON.stringify(r2.data));
  assert.match(r2.data.error, /"HR form" is not for everyone on the team/);

  // Whoever may set the rules of every part (an admin) can make it, and it comes out locked.
  const e3 = (await owner.post('/envelopes', { template_ids: [open.id, locked.id] })).data.envelope.id;
  const ok = await owner.post(`/envelopes/${e3}/clone`, { kind: 'template' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(db.get('SELECT tpl_locked FROM envelopes WHERE id=?', ok.data.id).tpl_locked, 1);
  // Two open templates: nothing is held back, so anyone may make one template of them, as before.
  const open2 = await release(otto, 'Open release');
  const e4 = (await maya.post('/envelopes', { template_ids: [open.id, open2.id] })).data.envelope.id;
  assert.equal((await maya.post(`/envelopes/${e4}/clone`, { kind: 'template' })).status, 200);
});

test('a copy of a combined document keeps every locked part locked, also the second one for someone who may change the first', async () => {
  const { maya, otto } = await team();
  const a = await volunteer(maya, 'Maya locked');
  const b = await release(otto, 'Otto locked');
  await lockIt(maya, a.id);
  await lockIt(otto, b.id);
  const eid = (await maya.post('/envelopes', { template_ids: [a.id, b.id] })).data.envelope.id;
  const copy = await maya.post(`/envelopes/${eid}/clone`, {});
  assert.equal(copy.status, 200, JSON.stringify(copy.data));
  const e = (await maya.get(`/envelopes/${copy.data.id}`)).data.envelope;
  assert.equal(e.wording_lock?.template, 'Otto locked', 'Otto\'s part is locked for Maya on the copy');
  const cur = asBody(e);
  const ottoNote = e.fields.find((f: any) => f.type === 'note' && f.value === 'Photos are used on our website only.');
  const put = await maya.put(`/envelopes/${e.id}`, { ...cur, fields: cur.fields.map((f: any) => (f.id === ottoNote.id ? { ...f, value: 'Photos are used anywhere.' } : f)) });
  assert.equal(put.status, 403, JSON.stringify(put.data));
  assert.match(put.data.error, /holds wording from the template/);
  // Her own part is still hers to change on the copy.
  const mayaNote = e.fields.find((f: any) => f.type === 'note' && f.value === 'Volunteers plant at their own pace.');
  const mine = await maya.put(`/envelopes/${e.id}`, { ...cur, fields: cur.fields.map((f: any) => (f.id === mayaNote.id ? { ...f, value: 'Plant with a partner.' } : f)) });
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  // A copy of the copy: still locked.
  const again = await maya.post(`/envelopes/${e.id}/clone`, {});
  assert.equal((await maya.get(`/envelopes/${again.data.id}`)).data.envelope.wording_lock?.template, 'Otto locked');
});

test('a part locked after the document was made is not locked, and then no copy is made for whoever the lock is for', async () => {
  const { maya, otto } = await team();
  const open = await volunteer(otto);
  const later = await release(maya);
  const eid = (await otto.post('/envelopes', { template_ids: [open.id, later.id] })).data.envelope.id;
  await lockIt(maya, later.id);
  assert.equal((await otto.get(`/envelopes/${eid}`)).data.envelope.wording_lock, null, 'started before the lock, as with one template');
  const r = await otto.post(`/envelopes/${eid}/clone`, {});
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.equal(r.data.code, 'wording_locked');
  twoSentences(r.data.error);
  // Once the template is unlocked again, the copy is made.
  assert.equal((await maya.put(`/envelopes/${later.id}/access`, { locked: false })).status, 200);
  assert.equal((await otto.post(`/envelopes/${eid}/clone`, {})).status, 200);
});

test('someone who can change the document on their turn cannot replace or change a locked part of another template', async () => {
  const { maya, otto } = await team();
  const open = await volunteer(otto);
  const lf = await upload(maya, 1);
  const locked = (await maya.post('/envelopes', {
    kind: 'template', subject: 'Locked form', ordered: true, documents: [{ id: 'd', file_id: lf.id, name: 'Locked form' }], recipients: [{ id: 'p', role: 'signer', role_name: 'Parent', routing_order: 3 }],
    fields: [{ id: 's', document_id: 'd', recipient_id: 'p', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }, { id: 'n', document_id: 'd', type: 'note', value: 'LOCKED FORM', page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.03 }],
  })).data.envelope;
  await lockIt(maya, locked.id);
  const r = await otto.post('/envelopes', { template_ids: [open.id, locked.id], recipients: { Volunteer: { name: 'Vic Vol', email: 'vic.ed@combine.example.com' }, Parent: { name: 'Pat Par', email: 'pat.ed@combine.example.com' } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = (await otto.get(`/envelopes/${r.data.envelope.id}`)).data.envelope;
  // Otto adds someone to his own part who can change the document, first in the order.
  const b = asBody(e);
  b.recipients = [...b.recipients.map((x: any) => (x.role_name === 'Volunteer' ? { ...x, routing_order: 4 } : x)), { id: 'ed', role: 'editor', name: 'Eddie Ed', email: 'eddie.ed@combine.example.com', routing_order: 1 }];
  const put = await otto.put(`/envelopes/${e.id}`, b);
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal((await otto.post(`/envelopes/${e.id}/send`, {})).status, 200);
  const tok = tokenFor(e.id, 'eddie.ed@combine.example.com');
  const ed = Object.assign(new Client(), { ip: ip() });
  await ed.post(`/sign/${tok}/consent`);
  const f = new FormData();
  f.append('file', new Blob([await samplePdf(1)], { type: 'application/pdf' }), 'other.pdf');
  const up = await ed.call('POST', `/sign/${tok}/step/files`, f);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const now = (await otto.get(`/envelopes/${e.id}`)).data.envelope;
  const lockedDoc = now.documents.find((d: any) => d.name === 'Locked form');
  const openDoc = now.documents.find((d: any) => d.name !== 'Locked form');
  const swapTo = (id: string) => now.documents.map((d: any) => ({ id: d.id, file_id: d.id === id ? up.data.file.id : d.file_id }));
  const no = await ed.post(`/sign/${tok}/step/change`, { documents: swapTo(lockedDoc.id) });
  assert.equal(no.status, 403, JSON.stringify(no.data));
  assert.equal(no.data.code, 'wording_locked');
  assert.match(no.data.error, /^"Locked form" cannot be replaced, renamed or taken off\. It comes from the template "Locked form", whose wording is locked/);
  twoSentences(no.data.error);
  // Nor its later person taken off, nor its fields changed.
  const parent = now.recipients.find((x: any) => x.role_name === 'Parent');
  const vol = now.recipients.find((x: any) => x.role_name === 'Volunteer');
  const gone = await ed.post(`/sign/${tok}/step/change`, { people: [{ id: vol.id }] });
  assert.equal(gone.status, 403, JSON.stringify(gone.data));
  const fieldsNow = now.fields.filter((x: any) => x.recipient_id !== now.recipients.find((y: any) => y.role === 'editor').id).map((x: any) => (x.type === 'note' && x.value === 'LOCKED FORM' ? { ...x, value: 'CHANGED' } : x));
  assert.equal((await ed.post(`/sign/${tok}/step/change`, { fields: fieldsNow })).status, 403);
  const after = (await otto.get(`/envelopes/${e.id}`)).data.envelope;
  assert.equal(after.documents.find((d: any) => d.id === lockedDoc.id).file_id, lockedDoc.file_id, 'the locked file stays');
  assert.ok(after.recipients.some((x: any) => x.id === parent.id));
  // His own part's file can still be replaced: that is what the role is for.
  const yes = await ed.post(`/sign/${tok}/step/change`, { documents: swapTo(openDoc.id) });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
});

// ---- 2. "This looks like your template ... Use it?" ----------------------------------------------------------------

// A text of `n` words, the same every time, and the same text with some words swapped for others.
const VOCAB = 'tree planting partner agrees to plant mangrove seedlings along the coast each season and report survival rates monthly while the volunteer keeps records of every site visit with photos and notes for the coordinator who reviews them'.split(' ');
function words(n: number, seed = 7) {
  let x = seed;
  return Array.from({ length: n }, () => VOCAB[(x = (x * 1103515245 + 12345) % 2147483648) % VOCAB.length]);
}
const swap = (w: string[], at: number[]) => w.map((v, i) => (at.includes(i) ? `changed${i}` : v));
async function textPdf(pages: string[][]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([612, 792]);
    page.drawText(p.join(' '), { x: 40, y: 750, size: 7, font, maxWidth: 530, lineHeight: 9 });
  }
  return doc.save();
}
async function uploadText(c: Client, pages: string[][], name = 'Volunteer agreement.pdf') {
  const f = new FormData();
  f.append('file', new Blob([await textPdf(pages)], { type: 'application/pdf' }), name);
  const r = await c.call('POST', '/files', f);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const BASE = words(600);
async function textTemplate(c: Client, pages = [BASE], subject = 'Volunteer agreement') {
  return volunteer(c, subject, await uploadText(c, pages));
}
const matchOf = async (c: Client, fileId: string) => {
  const r = await c.get(`/files/${fileId}/template-match`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.match;
};

test('an upload alike a template is offered at the account level, and not below it', async () => {
  const { owner, maya } = await team();
  const tpl = await textTemplate(maya);
  // Two words changed out of 600: about 98 percent alike.
  const near = await uploadText(maya, [swap(BASE, [100, 400])]);
  const m = await matchOf(maya, near.id);
  assert.ok(m, 'offered');
  assert.equal(m.template_id, tpl.id);
  assert.equal(m.template, 'Volunteer agreement');
  assert.ok(m.percent >= 95 && m.percent < 100, String(m.percent));
  assert.equal(m.locked, false);
  // The line has no number in it (research/ux-notes.json); the number is in "What is different".
  assert.equal(matchLine(m), 'This looks like your template Volunteer agreement. Use it?');
  assert.equal(useLabel(m), 'Use it');
  // What differs: how much is the same, the page, and the words on each side.
  assert.deepEqual(m.differences.pages, { upload: 1, template: 1 });
  assert.deepEqual(m.differences.changed_pages, [1]);
  assert.deepEqual(m.differences.only_in_upload, ['changed100', 'changed400']);
  assert.deepEqual(differenceLines(m), [`${m.percent} percent of the words are the same.`, 'The words are not the same on page 1.', 'Only in your file: changed100, changed400.', ...(m.differences.only_in_template.length ? [`Only in the template: ${m.differences.only_in_template.join(', ')}.`] : [])]);
  // The same file again: 100 percent, nothing differs.
  const same = await matchOf(maya, (await uploadText(maya, [BASE])).id);
  assert.equal(same.percent, 100);
  assert.deepEqual(differenceLines(same), ['All of the words are the same.']);

  // 22 words changed: a little over 80 percent. Offered as the account has it (80), not once an admin asks for 90.
  const at = (k: number) => Array.from({ length: k }, (_, i) => 13 + i * Math.floor(580 / k));
  const far = await uploadText(maya, [swap(BASE, at(22))]);
  const at80 = await matchOf(maya, far.id);
  assert.ok(at80 && at80.percent >= 80 && at80.percent < 90, JSON.stringify(at80));
  // 45 words changed: well under 80, never offered.
  assert.equal(await matchOf(maya, (await uploadText(maya, [swap(BASE, at(45))])).id), null);
  assert.equal((await owner.get('/account/template-match')).data.percent, 80, 'the usual level');
  assert.equal((await maya.put('/account/template-match', { percent: 90 })).status, 403, 'only admins choose the level');
  const set = await owner.put('/account/template-match', { percent: 90 });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.deepEqual(set.data, { percent: 90, choices: [80, 90, 95] });
  assert.equal(await matchOf(maya, far.id), null);
  // 95: the near one (98) still, the far one not.
  assert.equal((await owner.put('/account/template-match', { percent: 95 })).status, 200);
  assert.equal(await matchOf(maya, far.id), null);
  assert.ok(await matchOf(maya, near.id));
  for (const percent of [85, '90', null, 100]) {
    const r = await owner.put('/account/template-match', { percent });
    assert.equal(r.status, 400, String(percent));
    twoSentences(r.data.error);
  }
  assert.equal((await owner.get('/account/template-match')).data.percent, 95, 'a refused level changes nothing');
});

test('a short one-page form with a word changed, or a name and a date written in, is still offered', async () => {
  const { maya } = await team();
  const form = words(95, 11);
  await textTemplate(maya, [form], 'Photo consent');
  const oneWord = await matchOf(maya, (await uploadText(maya, [swap(form, [40])])).id);
  assert.ok(oneWord, 'one word changed on a 95-word form is offered');
  assert.equal(oneWord.template, 'Photo consent');
  const filled = [...form.slice(0, 20), 'maria', 'santos', ...form.slice(20, 70), 'march', '3', ...form.slice(70)];
  assert.ok(await matchOf(maya, (await uploadText(maya, [filled])).id), 'a name and a date written in');
  // A short template inside a long, different file is not "alike": the share is of the longer one.
  const long = await uploadText(maya, [[...words(500, 99), ...form, ...words(500, 98)]]);
  assert.equal(await matchOf(maya, long.id), null);
});

test('a different page count is said, a file with no words is never matched, and an unrelated file is not offered', async () => {
  const { maya } = await team();
  await textTemplate(maya, [BASE.slice(0, 300), BASE.slice(300)]);
  const one = await uploadText(maya, [BASE]);
  const m = await matchOf(maya, one.id);
  assert.ok(m, 'the same words on one page instead of two');
  assert.deepEqual(m.differences.pages, { upload: 1, template: 2 });
  assert.match(differenceLines(m)[1], /^Your file has 1 page and the template has 2\.$/);
  // A picture of a page has no words to compare: nothing is offered (and nothing is guessed).
  assert.equal(await matchOf(maya, (await upload(maya, 1)).id), null);
  assert.equal(await matchOf(maya, (await uploadText(maya, [words(600, 99)])).id), null, 'other words');
  // Someone else's file id is not found.
  const { maya: stranger } = await team();
  assert.equal((await stranger.get(`/files/${one.id}/template-match`)).status, 404);
});

test('no match is offered from a template this person may not use', async () => {
  const { owner, maya, otto } = await team();
  const tpl = await textTemplate(maya, [BASE], 'HR letter');
  assert.equal((await maya.put(`/envelopes/${tpl.id}/access`, { use: 'admins' })).status, 200);
  const f = await uploadText(otto, [BASE]);
  assert.equal(await matchOf(otto, f.id), null, 'Otto may not use it, so it is not offered, and its name is not said');
  assert.equal((await otto.post(`/files/${f.id}/template-match/use`, { template_id: tpl.id, document_id: 'd1' })).status, 404, 'nor can its fields be had by naming it');
  const g = await uploadText(owner, [BASE]);
  assert.equal((await matchOf(owner, g.id))?.template_id, tpl.id, 'an admin may use it');
});

test('Use it gives the template\'s people and fields for the file, never applies anything itself, and a locked template is offered as itself', async () => {
  const { maya, otto } = await team();
  const tpl = await textTemplate(maya);
  const f = await uploadText(otto, [swap(BASE, [10])]);
  // A draft with the file and nobody on it yet.
  const draft = (await otto.post('/envelopes', { subject: 'Please sign', documents: [{ id: 'dx', file_id: f.id, name: 'Volunteer agreement' }] })).data.envelope;
  const docId = draft.documents[0].id;
  const before = JSON.stringify((await otto.get(`/envelopes/${draft.id}`)).data.envelope.fields);
  assert.ok(await matchOf(otto, f.id));
  assert.equal(JSON.stringify((await otto.get(`/envelopes/${draft.id}`)).data.envelope.fields), before, 'asking changes nothing');
  const r = await otto.post(`/files/${f.id}/template-match/use`, { template_id: tpl.id, document_id: docId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.template, 'Volunteer agreement');
  assert.deepEqual(r.data.people.map((p: any) => [p.role, p.role_name, p.email]), [['signer', 'Volunteer', ''], ['approver', 'Coordinator', 'cora@combine.example.com']]);
  assert.equal(r.data.fields.length, 2);
  assert.ok(r.data.fields.every((x: any) => x.document_id === docId));
  const vol = r.data.people.find((p: any) => p.role_name === 'Volunteer');
  assert.equal(r.data.fields.find((x: any) => x.type === 'signature').recipient_id, vol.id);
  assert.equal(r.data.fields.find((x: any) => x.type === 'note').value, 'Volunteers plant at their own pace.');
  assert.equal(r.data.left_out, 0);
  assert.equal(JSON.stringify((await otto.get(`/envelopes/${draft.id}`)).data.envelope.fields), before, 'the draft only changes when the editor saves');
  // The editor saves what it was given: a normal draft with the template's fields on Otto's file.
  const saved = await otto.put(`/envelopes/${draft.id}`, { documents: draft.documents, recipients: r.data.people.map((p: any) => (p.role_name === 'Volunteer' ? { ...p, name: 'Vic', email: 'vic@combine.example.com' } : p)), fields: r.data.fields });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  for (const [body, words] of [[{ document_id: docId }, /"template_id"/], [{ template_id: tpl.id }, /"document_id"/]] as [any, RegExp][]) {
    const bad = await otto.post(`/files/${f.id}/template-match/use`, body);
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, words);
    twoSentences(bad.data.error);
  }

  // Locked: offered, said as locked, and its fields are not handed out for another file.
  assert.equal((await maya.put(`/envelopes/${tpl.id}/access`, { locked: true })).status, 200);
  const m = await matchOf(otto, f.id);
  assert.equal(m.locked, true);
  assert.match(useMeans(m), /^Its wording is locked, so its fields cannot go on another file\./);
  // Its button says what it does, and the line says the file stays in Drafts, before anything is pressed.
  assert.equal(useLabel(m), `Start from ${m.template}`);
  assert.match(matchLine(m), /Its wording is locked, so this starts a new document from the template\. Your file stays in Drafts\.$/);
  const no = await otto.post(`/files/${f.id}/template-match/use`, { template_id: tpl.id, document_id: docId });
  assert.equal(no.status, 403);
  assert.equal(no.data.code, 'wording_locked');
  twoSentences(no.data.error);
  // Maya, whose template it is, may put its fields on her own file.
  const mine = await uploadText(maya, [BASE]);
  assert.equal((await matchOf(maya, mine.id)).locked, false);
  assert.equal((await maya.post(`/files/${mine.id}/template-match/use`, { template_id: tpl.id, document_id: 'd' })).status, 200);
});

test('fields on pages the upload does not have are left out and counted', async () => {
  const { maya } = await team();
  const f2 = await uploadText(maya, [BASE.slice(0, 300), BASE.slice(300)]);
  const t = await maya.post('/envelopes', {
    kind: 'template', subject: 'Two pages', documents: [{ id: 'd', file_id: f2.id, name: 'Two pages' }], recipients: [{ id: 'r', role: 'signer', role_name: 'Client' }],
    fields: [{ id: 'a', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }, { id: 'b', document_id: 'd', recipient_id: 'r', type: 'signature', page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }],
  });
  const one = await uploadText(maya, [BASE.slice(0, 300)]);
  const r = await maya.post(`/files/${one.id}/template-match/use`, { template_id: t.data.envelope.id, document_id: 'dz' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.fields.length, r.data.left_out], [1, 1]);
});
