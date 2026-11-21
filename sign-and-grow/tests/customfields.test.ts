// Custom fields (src/server/customfields.ts): an account's own references on its envelopes. Admins define up to 20
// (text or a list of choices, required or not, on the certificate or not); the sender fills them on the last step,
// a template carries default values, a bulk column named like a field fills it, a public form uses the template's;
// required ones are checked at send. The API takes custom_fields on envelopes and templates, and name and value
// pairs per document. The list filters by them, shows one as a column, the export's CSV and webhook payloads carry
// them, and the certificate has a short block in the sender's words, read by the fake-notice filter. Changing or
// deleting a field never changes an envelope that was sent.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, Client, signUp, simple, upload, tokenFor, signAll, type Server } from './helpers.ts';
import { MAX_CUSTOM_FIELDS, CUSTOM_VALUE_MAX, CERT_HEADING, CERT_NOTE, customKey, readValue } from '../src/lib/customfields.ts';

let db: Server['db'];
let env: Server['env'];
before(async () => {
  ({ db, env } = await boot());
});

let n = 0;
const ip = () => `10.91.${Math.floor(++n / 250)}.${n % 250}`;
const person = (name: string, email: string) => signUp(name, email, ip());
const browser = () => Object.assign(new Client(), { ip: ip() });
const PW = 'correct horse battery';
const inviteFor = (email: string) => db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY created_at DESC', email)?.token;
async function join(owner: Client, name: string, email: string, role = 'member') {
  assert.equal((await owner.post('/account/invites', { email, role })).status, 200);
  const c = browser();
  const r = await c.post('/auth/signup', { name, email, password: PW, invite: inviteFor(email) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  db.run('UPDATE users SET email_verified=1 WHERE email=?', email);
  return c;
}
const withKey = (key: string) => {
  const c = browser();
  const call = c.call.bind(c);
  c.call = (method: string, url: string, body?: any, headers: Record<string, string> = {}) => call(method, url, body, { authorization: `Bearer ${key}`, ...headers });
  return c;
};
const del = (c: Client, url: string) => c.call('DELETE', url);
const patch = (c: Client, url: string, b: any) => c.call('PATCH', url, b);
// A paid account is not read by the fake-notice filter (hasNotPaid in envelopes.ts); a trusted mark does the same.
const trust = (email: string) => db.run('UPDATE accounts SET trusted_at=? WHERE id=(SELECT account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?)', new Date().toISOString(), email);
const auditOf = (eid: string) => db.all('SELECT action, detail FROM audit WHERE envelope_id=? ORDER BY seq', eid);

// One signer, one signature, with the body's own extra parts.
async function draftWith(c: Client, email: string, over: any = {}) {
  const file = await upload(c, 1);
  return c.post('/envelopes', {
    subject: 'Grant agreement', documents: [{ id: 'd', file_id: file.id, name: 'Grant' }],
    recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
    ...over,
  });
}

// ---- 1. Admins define the fields ---------------------------------------------------------------------------------

test('admins define up to 20 fields: text or a list, required or not, on the certificate by default', async () => {
  const own = await person('Ann Owner', 'ann@cf1.example');
  const a = await own.post('/custom-fields', { name: '  Case number ' });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.deepEqual({ ...a.data.field, id: undefined }, { id: undefined, name: 'Case number', kind: 'text', choices: [], required: false, on_certificate: true });
  const w = await own.post('/custom-fields', { name: 'Ward', kind: 'list', choices: ['North', ' South ', '', 'East'], required: true, on_certificate: false });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.deepEqual(w.data.field.choices, ['North', 'South', 'East']);
  // A name that is there already, whatever its letter case, width or spaces, is refused and says which.
  const twice = await own.post('/custom-fields', { name: 'CASE  NUMBER' });
  assert.equal(twice.status, 409);
  assert.match(twice.data.error, /already a custom field called "Case number"/);
  // Names in any script are kept as typed and told apart.
  assert.equal((await own.post('/custom-fields', { name: 'رقم الملف' })).status, 200);
  assert.equal((await own.post('/custom-fields', { name: 'የጉዳይ ቁጥር' })).status, 200);
  for (const [b, re] of [
    [{ name: '' }, /Give the field a name/],
    [{ name: 'x'.repeat(51) }, /51 characters long, and the most is 50/],
    [{ name: 'Two\nlines' }, /one line/],
    [{ name: 'Turned \u202eround' }, /cannot be seen or that turns text around/],
    [{ name: 42 }, /has to be text/],
    [{ name: 'Grant', kind: 'date' }, /"text" or "list"/],
    [{ name: 'Grant', kind: 'list' }, /at least one choice/],
    [{ name: 'Grant', kind: 'list', choices: 'A, B' }, /list of words/],
    [{ name: 'Grant', kind: 'list', choices: ['A', 'a'] }, /in the list twice/],
    [{ name: 'Grant', kind: 'list', choices: Array.from({ length: 51 }, (_, i) => `c${i}`) }, /up to 50 choices/],
    [{ name: 'Grant', choices: ['A'] }, /only for a field of the kind "list"/],
    [{ name: 'Grant', required: 'yes' }, /true or false/],
  ] as [any, RegExp][]) {
    const r = await own.post('/custom-fields', b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.match(r.data.error, re);
    assert.match(r.data.error, /Nothing was saved/);
  }
  const list = (await own.get('/custom-fields')).data;
  assert.deepEqual(list.fields.map((f: any) => f.name), ['Case number', 'Ward', 'رقم الملف', 'የጉዳይ ቁጥር']);
  assert.equal(list.limits.fields, MAX_CUSTOM_FIELDS);
  // Up to 20, and the 21st says how to make room.
  for (let i = list.fields.length; i < MAX_CUSTOM_FIELDS; i++) assert.equal((await own.post('/custom-fields', { name: `Code ${i}` })).status, 200);
  const over = await own.post('/custom-fields', { name: 'One too many' });
  assert.equal(over.status, 400);
  assert.match(over.data.error, /up to 20 custom fields.*Delete one you no longer use/);
  // A change keeps what it does not name; a field that is gone says so.
  const ward = w.data.field.id;
  const ch = await patch(own, `/custom-fields/${ward}`, { required: false });
  assert.equal(ch.status, 200, JSON.stringify(ch.data));
  assert.deepEqual([ch.data.field.name, ch.data.field.kind, ch.data.field.choices, ch.data.field.required, ch.data.field.on_certificate], ['Ward', 'list', ['North', 'South', 'East'], false, false]);
  assert.equal((await patch(own, `/custom-fields/${ward}`, { name: 'Case number' })).status, 409);
  assert.equal((await patch(own, `/custom-fields/${ward}`, { name: 'ward' })).status, 200, 'its own name in other letters is fine');
  assert.equal((await del(own, `/custom-fields/${ward}`)).status, 200);
  assert.equal((await patch(own, `/custom-fields/${ward}`, { name: 'Back' })).status, 404);
  assert.equal((await del(own, `/custom-fields/${ward}`)).status, 404);
  // The changes are in the security record, by id and never with values.
  const lines = db.all("SELECT details FROM security_events WHERE kind='settings.changed' AND about_type='custom_field' AND about_id=?", ward);
  assert.deepEqual(lines.map((l) => JSON.parse(l.details).custom_field), ['added', 'changed', 'changed', 'deleted']);
});

test('members and a "send" key read the fields and cannot change them; another account sees none of them', async () => {
  const own = await person('Bea Owner', 'bea@cf1.example');
  const mem = await join(own, 'Mo Member', 'mo@cf1.example');
  const f = (await own.post('/custom-fields', { name: 'Cost centre' })).data.field;
  assert.deepEqual((await mem.get('/custom-fields')).data.fields.map((x: any) => x.name), ['Cost centre']);
  const no = await mem.post('/custom-fields', { name: 'Mine' });
  assert.equal(no.status, 403);
  assert.equal((await patch(mem, `/custom-fields/${f.id}`, { name: 'Mine' })).status, 403);
  assert.equal((await del(mem, `/custom-fields/${f.id}`)).status, 403);
  const key = withKey((await own.post('/api-keys', { name: 'crm' })).data.key);
  assert.equal((await key.get('/custom-fields')).data.fields.length, 1);
  assert.equal((await key.post('/custom-fields', { name: 'By key' })).status, 403);
  const admin = withKey((await own.post('/api-keys', { name: 'setup', scope: 'admin' })).data.key);
  assert.equal((await admin.post('/custom-fields', { name: 'By admin key' })).status, 200);
  const stranger = await person('Sid Else', 'sid@cf1.example');
  assert.deepEqual((await stranger.get('/custom-fields')).data.fields, []);
  assert.equal((await patch(stranger, `/custom-fields/${f.id}`, { name: 'Taken' })).status, 404);
  assert.equal((await del(stranger, `/custom-fields/${f.id}`)).status, 404);
});

test('the shared rules: one key for a name, values checked against their field', () => {
  assert.equal(customKey('  Case   Number '), customKey('case number'));
  assert.equal(customKey('ＣＡＳＥ'), customKey('case'));
  assert.notEqual(customKey('رقم'), customKey('رقمٌ'));
  const list = { name: 'Ward', kind: 'list' as const, choices: ['North', 'South'] };
  assert.deepEqual(readValue(list, ' north '), { value: 'North' });
  assert.match((readValue(list, 'West') as any).problem, /not one of the choices for "Ward". Pick one of: North, South/);
  assert.deepEqual(readValue(list, ''), { value: '' });
  const text = { name: 'Case', kind: 'text' as const, choices: [] };
  assert.deepEqual(readValue(text, 2026), { value: '2026' });
  assert.match((readValue(text, 'x'.repeat(CUSTOM_VALUE_MAX + 1)) as any).problem, /101 characters long, and the most is 100/);
  assert.match((readValue(text, ['a']) as any).problem, /a list/);
  assert.match((readValue(text, true) as any).problem, /has to be text/);
  assert.match((readValue(text, 'a\u2066b') as any).problem, /cannot be seen/);
  // Joiners stay: Persian and the scripts of South Asia need them.
  assert.deepEqual(readValue(text, 'می\u200cخواهم'), { value: 'می\u200cخواهم' });
});

// ---- 2. The sender fills them; templates, bulk columns, public forms and the API ---------------------------------

// An account with a required case number (on the certificate) and an optional ward (a list, not on the certificate).
async function account(tag: string) {
  const own = await person(`Owner ${tag}`, `owner@${tag}.example`);
  const cn = (await own.post('/custom-fields', { name: 'Case number', required: true })).data.field;
  const ward = (await own.post('/custom-fields', { name: 'Ward', kind: 'list', choices: ['North', 'South'], on_certificate: false })).data.field;
  return { own, cn, ward };
}
const envCount = (email: string) => db.get('SELECT COUNT(*) n FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE u.email=?', email).n;
const valuesOf = (e: any) => e.custom_fields.map((x: any) => `${x.name}=${x.value}`);
async function template(c: Client, over: any = {}) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    kind: 'template', subject: 'Grant agreement', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Grantee' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
    ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}

test('the sender gives values on a draft; a required one is checked when sending, and a refused create leaves nothing behind', async () => {
  const { own } = await account('cf2a');
  const before = envCount('owner@cf2a.example');
  for (const [cf, re] of [
    [[{ name: 'Ward', value: 'West' }], /"West" is not one of the choices for "Ward". Pick one of: North, South/],
    [[{ name: 'Grant code', value: 'G1' }], /no custom field called "Grant code"/],
    [[{ name: 'Case number', value: 'x'.repeat(101) }], /101 characters long, and the most is 100/],
    [[{ name: 'Case number', value: '1' }, { name: 'case  NUMBER', value: '2' }], /names "case {2}NUMBER" twice/],
    [{ name: 'Case number' }, /item 1 has to be an object|has to be a list/],
    ['2026/114', /has to be a list/],
    [[{ name: 'Case number', value: { x: 1 } }], /has to be text/],
  ] as [any, RegExp][]) {
    const r = await draftWith(own, 'sam@cf2a.example', { custom_fields: cf });
    assert.equal(r.status, 400, JSON.stringify(cf));
    assert.match(r.data.error, re);
    assert.match(r.data.error, /Nothing was saved/);
  }
  assert.equal(envCount('owner@cf2a.example'), before, 'no draft was left behind');
  // Create and send, without the required one: refused in words that say where to fill it in, and nothing is left.
  const noValue = await draftWith(own, 'sam@cf2a.example', { send: true, custom_fields: [{ name: 'Ward', value: 'north' }] });
  assert.equal(noValue.status, 400);
  assert.match(noValue.data.error, /asks for the custom field "Case number" on every envelope, and it has no value here. Fill it in on the last step of the editor, under Details for your records \(in the API: "custom_fields"\)/);
  assert.equal(envCount('owner@cf2a.example'), before);
  // A draft keeps its values; a choice is kept in the spelling of the list.
  const d = (await draftWith(own, 'sam@cf2a.example', { custom_fields: [{ name: 'Ward', value: ' north ' }] })).data.envelope;
  assert.deepEqual(valuesOf(d), ['Ward=North']);
  const send = await own.post(`/envelopes/${d.id}/send`);
  assert.equal(send.status, 400);
  assert.match(send.data.error, /"Case number"/);
  // The editor sends its whole state back: the list replaces what there was.
  const put = await own.put(`/envelopes/${d.id}`, { custom_fields: [{ name: 'Case number', value: ' 2026/114 ' }] });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(valuesOf(put.data.envelope), ['Case number=2026/114']);
  // A save that leaves custom_fields out keeps them.
  assert.deepEqual(valuesOf((await own.put(`/envelopes/${d.id}`, { subject: 'Grant 114' })).data.envelope), ['Case number=2026/114']);
  assert.equal((await own.post(`/envelopes/${d.id}/send`)).status, 200);
  // Never on the signing page: not in what the signing link answers, whatever is asked.
  const tok = tokenFor(d.id, 'sam@cf2a.example');
  const signer = browser();
  await signer.post(`/sign/${tok}/consent`);
  const view = await signer.get(`/sign/${tok}`);
  assert.equal(view.status, 200);
  assert.ok(!JSON.stringify(view.data).includes('2026/114') && !JSON.stringify(view.data).includes('Case number'), 'the signer is never sent them');
});

test('a value that no longer fits its field: a draft still saves, sending says what to change', async () => {
  const { own, ward } = await account('cf2b');
  const d = (await draftWith(own, 'sam@cf2b.example', { custom_fields: [{ name: 'Case number', value: 'C-1' }, { name: 'Ward', value: 'South' }] })).data.envelope;
  assert.equal((await patch(own, `/custom-fields/${ward.id}`, { choices: ['North', 'East'] })).data.notes.join(' ').match(/One draft or template holds a value for "Ward" that is not one of its choices now/)?.length, 1);
  // The editor sends what it loaded: kept, because it is what the draft holds.
  const again = await own.put(`/envelopes/${d.id}`, { custom_fields: [{ name: 'Case number', value: 'C-1' }, { name: 'Ward', value: 'South' }] });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  const send = await own.post(`/envelopes/${d.id}/send`);
  assert.equal(send.status, 400);
  assert.match(send.data.error, /"South" is not one of the choices for "Ward". Pick one of: North, East/);
  assert.equal((await own.put(`/envelopes/${d.id}`, { custom_fields: [{ name: 'Case number', value: 'C-1' }, { name: 'Ward', value: 'East' }] })).status, 200);
  assert.equal((await own.post(`/envelopes/${d.id}/send`)).status, 200);
});

test('a template carries default values; what is made from it starts with them and can change or empty them', async () => {
  const { own } = await account('cf2c');
  const tpl = await template(own, { custom_fields: [{ name: 'Case number', value: 'TPL-1' }, { name: 'Ward', value: 'North' }] });
  assert.deepEqual(valuesOf(tpl), ['Case number=TPL-1', 'Ward=North']);
  // A template is never checked for a required value: the sender fills it in when using it.
  const bare = await template(own);
  assert.deepEqual(bare.custom_fields, []);
  const used = await own.post('/envelopes', { template_id: tpl.id, recipients: { Grantee: { name: 'Gia Grant', email: 'gia@cf2c.example' } }, custom_fields: [{ name: 'Ward', value: 'South' }] });
  assert.equal(used.status, 200, JSON.stringify(used.data));
  assert.deepEqual(valuesOf(used.data.envelope), ['Case number=TPL-1', 'Ward=South']);
  const emptied = await own.post('/envelopes', { template_id: tpl.id, recipients: { Grantee: { name: 'Gia Grant', email: 'gia@cf2c.example' } }, custom_fields: [{ name: 'Ward', value: '' }], send: true });
  assert.equal(emptied.status, 200, JSON.stringify(emptied.data));
  assert.deepEqual(valuesOf(emptied.data.envelope), ['Case number=TPL-1']);
  // From a template without a value, sending without one is refused and leaves nothing behind.
  const before = envCount('owner@cf2c.example');
  const refused = await own.post('/envelopes', { template_id: bare.id, recipients: { Grantee: { name: 'Gia Grant', email: 'gia@cf2c.example' } }, send: true });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /"Case number"/);
  assert.equal(envCount('owner@cf2c.example'), before);
  // A copy of the template, and a clone of a sent envelope, keep the values.
  const copy = await own.post(`/envelopes/${tpl.id}/clone`, {});
  assert.equal(copy.status, 200, JSON.stringify(copy.data));
  const copied = (await own.get(`/envelopes/${copy.data.envelope?.id || copy.data.id}`)).data.envelope;
  assert.deepEqual(valuesOf(copied), ['Case number=TPL-1', 'Ward=North']);
});

test('the API: custom_fields on envelopes and templates, and name and value pairs for each document', async () => {
  const { own } = await account('cf2d');
  const key = withKey((await own.post('/api-keys', { name: 'case system' })).data.key);
  const file = await upload(own, 1);
  const file2 = await upload(own, 1);
  const body = (docs: any[]) => ({
    subject: 'Two documents', custom_fields: [{ name: 'Case number', value: 'API-7' }],
    documents: docs, recipients: [{ id: 'r', name: 'Ray Ray', email: 'ray@cf2d.example' }],
    fields: [{ id: 'f', document_id: 'a', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  const made = await key.post('/envelopes', body([{ id: 'a', file_id: file.id, name: 'Lease', fields: [{ name: 'Grant ref', value: 'G-7' }, { name: 'Page count', value: 3 }] }, { id: 'b', file_id: file2.id, name: 'Annex' }]));
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const e = made.data.envelope;
  assert.deepEqual(e.documents.map((d: any) => d.fields), [[{ name: 'Grant ref', value: 'G-7' }, { name: 'Page count', value: '3' }], []]);
  assert.deepEqual(valuesOf(e), ['Case number=API-7']);
  // A save that leaves a document's "fields" out keeps them while the document keeps its id; [] empties them.
  const ids = e.documents.map((d: any) => d.id);
  const kept = await key.put(`/envelopes/${e.id}`, { documents: [{ id: ids[0], file_id: file.id, name: 'Lease' }, { id: ids[1], file_id: file2.id, name: 'Annex', fields: [{ name: 'Ref', value: 'X' }] }] });
  assert.equal(kept.status, 200, JSON.stringify(kept.data));
  assert.deepEqual(kept.data.envelope.documents.map((d: any) => d.fields.map((f: any) => f.value)), [['G-7', '3'], ['X']]);
  const dropped = await key.put(`/envelopes/${e.id}`, { documents: [{ id: ids[1], file_id: file2.id, name: 'Annex', fields: [] }], fields: [{ id: 'f', document_id: ids[1], recipient_id: e.recipients[0].id, type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.data));
  assert.deepEqual(dropped.data.envelope.documents.map((d: any) => d.fields), [[]]);
  assert.equal(db.get("SELECT COUNT(*) n FROM custom_values WHERE envelope_id=? AND document_id!=''", e.id).n, 0, 'a document that is gone takes its pairs with it');
  for (const [docs, re] of [
    [[{ id: 'a', file_id: file.id, fields: [{ name: 'A', value: '1' }, { name: 'a', value: '2' }] }], /names "a" twice/],
    [[{ id: 'a', file_id: file.id, fields: Array.from({ length: 21 }, (_, i) => ({ name: `N${i}`, value: 'v' })) }], /21 name and value pairs.*the most is 20/],
    [[{ id: 'a', file_id: file.id, fields: [{ name: '', value: '1' }] }], /Give the field a name/],
    [[{ id: 'a', file_id: file.id, fields: [{ name: 'Ref', value: 'x'.repeat(101) }] }], /the most is 100/],
    [[{ id: 'a', file_id: file.id, fields: 'Ref=1' }], /has to be a list/],
  ] as [any, RegExp][]) {
    const r = await key.post('/envelopes', body(docs));
    assert.equal(r.status, 400, JSON.stringify(docs).slice(0, 80));
    assert.match(r.data.error, re);
  }
  // Templates take them the same way, and another account's key sees none of this.
  const tpl = await key.post('/envelopes', { ...body([{ id: 'a', file_id: file.id, fields: [{ name: 'Grant ref', value: 'T-1' }] }]), kind: 'template', recipients: [{ id: 'r', role_name: 'Client' }] });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  assert.deepEqual(valuesOf(tpl.data.envelope), ['Case number=API-7']);
  const used = await key.post('/envelopes', { template_id: tpl.data.envelope.id, recipients: { Client: { name: 'Cy Client', email: 'cy@cf2d.example' } } });
  assert.deepEqual(used.data.envelope.documents.map((d: any) => d.fields), [[{ name: 'Grant ref', value: 'T-1' }]], 'a document keeps its pairs in what is made from the template');
  const other = await person('Oz Other', 'oz@cf2d-other.example');
  assert.equal((await other.get(`/envelopes/${e.id}`)).status, 404);
  assert.equal((await other.put(`/envelopes/${e.id}/custom-fields`, { custom_fields: [] })).status, 404);
});

test('an envelope that is out: a value can be put right, with a line in its audit trail; once completed it is fixed', async () => {
  const { own } = await account('cf2e');
  const e = (await draftWith(own, 'sam@cf2e.example', { custom_fields: [{ name: 'Case number', value: '2026/113' }, { name: 'Ward', value: 'North' }], send: true })).data.envelope;
  assert.equal(e.status, 'sent');
  assert.equal((await own.put(`/envelopes/${e.id}/custom-fields`, {})).status, 400);
  const fix = await own.put(`/envelopes/${e.id}/custom-fields`, { custom_fields: [{ name: 'Case number', value: '2026/114' }, { name: 'Ward', value: 'South' }] });
  assert.equal(fix.status, 200, JSON.stringify(fix.data));
  assert.deepEqual(fix.data.custom_fields.map((x: any) => x.value), ['2026/114', 'South']);
  const line = auditOf(e.id).find((a) => a.action === 'Custom fields changed');
  assert.ok(line, 'written to the audit trail');
  assert.match(line.detail, /Case number: "2026\/113" became "2026\/114"\./);
  // A field that is not printed on the certificate is named without its values: the trail is printed on it.
  assert.match(line.detail, /The value of "Ward" \(not printed on the certificate\) was changed\./);
  assert.ok(!line.detail.includes('South'));
  // The same list again is no change and no line.
  assert.equal((await own.put(`/envelopes/${e.id}/custom-fields`, { custom_fields: fix.data.custom_fields })).status, 200);
  assert.equal(auditOf(e.id).filter((a) => a.action === 'Custom fields changed').length, 1);
  // A required one can be changed and not emptied: the account asks for it on every envelope.
  const empty = await own.put(`/envelopes/${e.id}/custom-fields`, { custom_fields: [{ name: 'Ward', value: 'South' }] });
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /asks for "Case number" on every envelope, so it can be changed and not emptied/);
  assert.equal((await signAll(e.id, 'sam@cf2e.example')).status, 200);
  const late = await own.put(`/envelopes/${e.id}/custom-fields`, { custom_fields: [{ name: 'Case number', value: '2026/999' }] });
  assert.equal(late.status, 409);
  assert.match(late.data.error, /completed, so its custom fields are fixed/);
  // Sending the values it has is fine (an integration that sends what it read).
  assert.equal((await own.put(`/envelopes/${e.id}/custom-fields`, { custom_fields: fix.data.custom_fields })).status, 200);
});

test('bulk send: a column named like a field fills it for each row; a row without a required one stops the batch before anything is sent', async () => {
  const { own } = await account('cf2f');
  const tpl = await template(own, { custom_fields: [{ name: 'Ward', value: 'North' }] });
  const rows = [
    { Grantee: { name: 'Ana One', email: 'ana@cf2f.example' }, custom_fields: { 'Case number': 'B-1', Ward: 'south' } },
    { Grantee: { name: 'Bo Two', email: 'bo@cf2f.example' }, custom_fields: { 'case number': 'B-2' } },
  ];
  const check = await own.post('/bulk/check', { template_id: tpl.id, rows: [...rows, { Grantee: { name: 'Cy Three', email: 'cy@cf2f.example' } }] });
  assert.equal(check.status, 200);
  assert.match(check.data.refusal.message, /^Row 3: Your account asks for the custom field "Case number" on every envelope.*Add a column named like the field to the list, or give the template a value for it/);
  const before = envCount('owner@cf2f.example');
  const refused = await own.post('/bulk', { template_id: tpl.id, rows: [...rows, { Grantee: { name: 'Cy Three', email: 'cy@cf2f.example' } }] });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /^Row 3: .*Nothing was sent\.$/);
  assert.equal(envCount('owner@cf2f.example'), before, 'not one envelope was made');
  const wrong = await own.post('/bulk', { template_id: tpl.id, rows: [{ Grantee: { name: 'Di Four', email: 'di@cf2f.example' }, custom_fields: { 'Case number': 'B-4', Ward: 'West' } }] });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /^Row 1: "West" is not one of the choices for "Ward"/);
  const unknown = await own.post('/bulk', { template_id: tpl.id, rows: [{ Grantee: { name: 'Di Four', email: 'di@cf2f.example' }, custom_fields: { 'Case number': 'B-4', Colour: 'Red' } }] });
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.error, /^Row 1: There is no custom field called "Colour"/);
  const sent = await own.post('/bulk', { template_id: tpl.id, rows });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.sent, 2);
  const made = await Promise.all(sent.data.results.map(async (r: any) => valuesOf((await own.get(`/envelopes/${r.id}`)).data.envelope)));
  assert.deepEqual(made, [['Case number=B-1', 'Ward=South'], ['Case number=B-2', 'Ward=North']], 'the template stands for a column the row leaves empty');
});

test('a public form uses the template\'s values; a required one the template lacks keeps the form closed and its owner is told', async () => {
  const { own, cn } = await account('cf2g');
  const bare = await template(own);
  const no = await own.post('/powerforms', { template_id: bare.id, name: 'Apply for a grant' });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /A visitor of a public form cannot fill custom fields in, so the template needs a value for each.*The form was not made\./);
  const tpl = await template(own, { custom_fields: [{ name: 'Case number', value: 'FORM-2026' }] });
  const pf = await own.post('/powerforms', { template_id: tpl.id, name: 'Apply for a grant' });
  assert.equal(pf.status, 200, JSON.stringify(pf.data));
  const slug = (await own.get('/powerforms')).data.powerforms.find((p: any) => p.id === pf.data.id).slug;
  const visitor = browser();
  assert.equal((await visitor.get(`/public/powerforms/${slug}`)).data.closed, false);
  const start = await visitor.post(`/public/powerforms/${slug}/start`, { name: 'Walk In', email: 'walkin@cf2g.example' });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const eid = db.get("SELECT id FROM envelopes WHERE powerform_id=? ORDER BY created_at DESC", pf.data.id).id;
  assert.deepEqual(db.all("SELECT name, value FROM custom_values WHERE envelope_id=? AND document_id=''", eid), [{ name: 'Case number', value: 'FORM-2026' }]);
  // A field made required later, which the template has no value for: the admin is told which forms, and the form
  // closes before anyone types, with its owner told why.
  const extra = await own.post('/custom-fields', { name: 'Grant round', required: true });
  assert.match(extra.data.notes.join(' '), /The public form "Apply for a grant" has no value for "Grant round" in its template, so it takes nobody until one is filled in there/);
  const page = await browser().get(`/public/powerforms/${slug}`);
  assert.equal(page.data.closed, true);
  const told = db.all("SELECT subject, html FROM emails WHERE to_email='owner@cf2g.example' AND subject LIKE '%could not take a signature%'");
  assert.equal(told.length, 1);
  assert.match(told[0].html, /Grant round/);
  const late = await browser().post(`/public/powerforms/${slug}/start`, { name: 'Late Comer', email: 'late@cf2g.example' });
  assert.equal(late.status, 503, 'the visitor hears only that the form is closed for now');
  assert.ok(!JSON.stringify(late.data).includes('Grant round'));
  assert.ok(cn.id);
});

// ---- 3. The list, the export and webhooks ------------------------------------------------------------------------

function unzip(z: Uint8Array): Record<string, Buffer> {
  const b = Buffer.from(z);
  const out: Record<string, Buffer> = {};
  for (let i = 0; b.readUInt32LE(i) === 0x04034b50;) {
    const size = b.readUInt32LE(i + 18), nameLen = b.readUInt16LE(i + 26), extra = b.readUInt16LE(i + 28);
    out[b.subarray(i + 30, i + 30 + nameLen).toString('utf8')] = b.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    i += 30 + nameLen + extra + size;
  }
  return out;
}
const ids = (r: any) => r.data.envelopes.map((e: any) => e.id).sort();

test('the list filters by a custom field and its value, gives each row its values for a column, and members see only theirs', async () => {
  const { own, ward } = await account('cf3a');
  const mem = await join(own, 'Mia Member', 'mia@cf3a.example');
  const a = (await draftWith(own, 's1@cf3a.example', { custom_fields: [{ name: 'Case number', value: '2026/114' }, { name: 'Ward', value: 'North' }], send: true })).data.envelope;
  const b = (await draftWith(own, 's2@cf3a.example', { custom_fields: [{ name: 'Case number', value: '2026/115' }], send: true })).data.envelope;
  const c = (await draftWith(mem, 's3@cf3a.example', { custom_fields: [{ name: 'Case number', value: 'Ref 2026/114' }] })).data.envelope;
  const m = (await draftWith(mem, 's4@cf3a.example', { custom_fields: [{ name: 'Case number', value: '2026/114' }] })).data.envelope;
  const q = (field: string, value = '') => `/envelopes?field=${encodeURIComponent(field)}&value=${encodeURIComponent(value)}`;
  // The whole value, in capitals or not and with spaces around it: "Ref 2026/114" is another case.
  assert.deepEqual(ids(await own.get(q('case NUMBER', ' 2026/114 '))), [a.id, m.id].sort());
  assert.deepEqual(ids(await own.get(q('Case number'))), [a.id, b.id, c.id, m.id].sort(), 'no value: every envelope that has one');
  assert.deepEqual(ids(await own.get(q('Ward', 'north'))), [a.id]);
  assert.deepEqual(ids(await own.get(q('Ward', 'South'))), []);
  assert.deepEqual(ids(await own.get(q('No such field', 'x'))), []);
  // With the other filters: a box and the search.
  assert.deepEqual(ids(await own.get(`${q('Case number', '2026/114')}&box=sent`)), [a.id]);
  // A member sees their own, as everywhere in the list.
  assert.deepEqual(ids(await mem.get(q('Case number', '2026/114'))), [m.id]);
  // Each row carries its values, for the column the list shows.
  const row = (await own.get(q('Ward', 'North'))).data.envelopes[0];
  assert.deepEqual(row.custom_fields, [{ name: 'Case number', value: '2026/114' }, { name: 'Ward', value: 'North' }]);
  // A field that was deleted: what was sent keeps its value, and the list can still be filtered by it.
  assert.equal((await del(own, `/custom-fields/${ward.id}`)).status, 200);
  assert.deepEqual((await own.get('/custom-fields')).data.past_names, ['Ward']);
  assert.deepEqual(ids(await own.get(q('Ward', 'North'))), [a.id]);
});

test('the export: envelopes.csv has a column for each custom field, and a value cannot run as a spreadsheet formula', async () => {
  const { own } = await account('cf3b');
  const a = (await draftWith(own, 's1@cf3b.example', { custom_fields: [{ name: 'Case number', value: '=HYPERLINK("http://x.example")' }, { name: 'Ward', value: 'South' }], send: true })).data.envelope;
  const b = (await draftWith(own, 's2@cf3b.example', { custom_fields: [{ name: 'Case number', value: '2026/7' }], send: true })).data.envelope;
  const zip = unzip((await own.get('/export')).data);
  const lines = zip['envelopes.csv'].toString('utf8').replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], '"envelope_id","subject","status","sent_at","completed_at","recipients","signed_pdf_sha256","file","Case number","Ward"');
  const rowOf = (eid: string) => lines.find((l) => l.startsWith(`"${eid}"`))!;
  assert.ok(rowOf(a.id).endsWith(`"'=HYPERLINK(""http://x.example"")","South"`), rowOf(a.id));
  assert.ok(rowOf(b.id).endsWith('"2026/7",""'));
  assert.match(zip['README.txt'].toString('utf8'), /envelopes\.csv  one row per envelope, with a column for each custom field/);
  // The selected envelopes only, with the columns they have.
  const one = unzip((await own.get(`/export?ids=${b.id}`)).data)['envelopes.csv'].toString('utf8').split('\r\n');
  assert.ok(one[0].endsWith('"file","Case number"'));
  // A field named like one of the export's own columns is told apart.
  assert.equal((await own.post('/custom-fields', { name: 'Status' })).status, 200);
  assert.equal((await draftWith(own, 's3@cf3b.example', { custom_fields: [{ name: 'Case number', value: 'C' }, { name: 'Status', value: 'Open' }], send: true })).status, 200);
  assert.match(unzip((await own.get('/export')).data)['envelopes.csv'].toString('utf8').split('\r\n')[0], /"Case number","Ward","custom: Status"$/);
});

test('webhook payloads carry the custom fields and each document\'s name and value pairs', async () => {
  const hits: any[] = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => (hits.push(JSON.parse(b)), res.end('ok')));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    const { own } = await account('cf3c');
    assert.equal((await own.post('/webhooks', { url: `http://127.0.0.1:${(server.address() as any).port}/hook`, events: ['envelope.sent', 'envelope.completed'] })).status, 200);
    const file = await upload(own, 1);
    const e = (await own.post('/envelopes', {
      subject: 'Hooked', send: true, custom_fields: [{ name: 'Case number', value: 'W-1' }, { name: 'Ward', value: 'North' }],
      documents: [{ id: 'd', file_id: file.id, name: 'Lease', fields: [{ name: 'Grant ref', value: 'G-9' }] }],
      recipients: [{ id: 'r', name: 'Hal Hook', email: 'hal@cf3c.example' }],
      fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
    })).data.envelope;
    assert.equal((await signAll(e.id, 'hal@cf3c.example')).status, 200);
    for (let i = 0; i < 150 && hits.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(hits.map((h) => h.event).sort(), ['envelope.completed', 'envelope.sent']);
    for (const h of hits) {
      assert.deepEqual(h.envelope.custom_fields, [{ name: 'Case number', value: 'W-1' }, { name: 'Ward', value: 'North' }]);
      assert.deepEqual(h.envelope.document_fields, [{ document_id: e.documents[0].id, name: 'Grant ref', value: 'G-9' }]);
    }
  } finally {
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    server.close();
  }
});

test('a bulk list: a column named like a custom field fills it, in any letter case; empty cells fill nothing', async () => {
  const { readCustomColumns } = await import('../src/components/sender/customColumns.ts');
  const csv = 'Grantee name,Grantee email,CASE NUMBER,Ward,Notes\nAna,ana@x.example,B-1,South,hi\nBo,bo@x.example,,North,\nCy,cy@x.example,,,';
  const r = readCustomColumns(csv, ['Case number', 'Ward'], true);
  assert.deepEqual(r.names, ['CASE NUMBER', 'Ward']);
  assert.deepEqual([...r.byRow.entries()], [[2, { 'Case number': 'B-1', Ward: 'South' }], [3, { Ward: 'North' }]]);
  assert.deepEqual(readCustomColumns(csv, ['Case number'], false).names, [], 'only a list with a header row names columns');
  assert.deepEqual(readCustomColumns(csv, [], true).names, []);
});

// ---- 4. The certificate, and the fake-notice filter --------------------------------------------------------------

const pdfText = async (bytes: Uint8Array) => (await (await import('../src/server/text.ts')).extractPages(bytes)).join('\n');

test('the certificate has a short block in the sender\'s words, with only the fields marked for it', async () => {
  const { own } = await account('cf4a');
  trust('owner@cf4a.example');
  assert.equal((await own.post('/custom-fields', { name: 'رقم الملف' })).status, 200);
  const e = (await draftWith(own, 'sam@cf4a.example', { custom_fields: [{ name: 'Case number', value: '2026/114' }, { name: 'Ward', value: 'North' }, { name: 'رقم الملف', value: 'ملف ٤٢' }], send: true })).data.envelope;
  assert.equal((await signAll(e.id, 'sam@cf4a.example')).status, 200);
  const text = await pdfText((await own.get(`/envelopes/${e.id}/download`)).data);
  assert.ok(text.includes(CERT_HEADING.toUpperCase()), 'the heading, as the certificate writes its headings');
  assert.match(text, /Case number: 2026\/114/);
  assert.ok(text.includes(CERT_NOTE), 'what these lines are and are not');
  assert.ok(!text.includes('Ward') && !text.includes('North'), 'a field not marked for the certificate is not on it');
  assert.ok(text.includes('ملف'), 'a value in another script is printed');
  // An envelope without values has no such block.
  const plain = (await draftWith(own, 'sam@cf4a.example', { custom_fields: [{ name: 'Case number', value: 'X' }], send: true })).data.envelope;
  assert.equal((await own.put(`/envelopes/${plain.id}/custom-fields`, { custom_fields: [{ name: 'Case number', value: 'X' }] })).status, 200);
  const none = await account('cf4b');
  await none.own.call('DELETE', `/custom-fields/${none.cn.id}`);
  const bare = await simple(none.own, 'sam@cf4b.example', { send: true });
  assert.equal((await signAll(bare.id, 'sam@cf4b.example')).status, 200);
  assert.ok(!(await pdfText((await none.own.get(`/envelopes/${bare.id}/download`)).data)).includes(CERT_HEADING.toUpperCase()));
});

test('values pass the fake-notice filter like any sender words, for the accounts it reads, and only those printed for recipients', async () => {
  const { own } = await account('cf4c');
  const lure = 'PayPal invoice, call 1-888-555-0142';
  // An account that has not paid: a value on the certificate is read with everything else that goes out.
  const no = await draftWith(own, 'sam@cf4c.example', { custom_fields: [{ name: 'Case number', value: lure }], send: true });
  assert.equal(no.status, 422, JSON.stringify(no.data));
  assert.match(no.data.error, /reads like a payment notice from a well-known brand/);
  // A field that is never printed for a recipient is not what they are sent.
  const quiet = await draftWith(own, 'sam@cf4c.example', { custom_fields: [{ name: 'Case number', value: 'C-1' }, { name: 'Ward', value: 'North' }], send: true });
  assert.equal(quiet.status, 200, JSON.stringify(quiet.data));
  // Putting a value right on an envelope that is out is read too, and nothing is changed.
  const later = await own.put(`/envelopes/${quiet.data.envelope.id}/custom-fields`, { custom_fields: [{ name: 'Case number', value: lure }] });
  assert.equal(later.status, 422);
  assert.match(later.data.error, /Nothing was changed\.$/);
  assert.deepEqual(valuesOf((await own.get(`/envelopes/${quiet.data.envelope.id}`)).data.envelope), ['Case number=C-1', 'Ward=North']);
  // The name of a field is printed with its value, so it is read as well.
  const named = (await own.post('/custom-fields', { name: 'PayPal billing' })).data.field;
  const byName = await draftWith(own, 'sam@cf4c.example', { custom_fields: [{ name: 'Case number', value: 'Call 1-888-555-0142' }, { name: 'PayPal billing', value: 'invoice 7' }], send: true });
  assert.equal(byName.status, 422);
  await del(own, `/custom-fields/${named.id}`);
  // An account the filter does not read (paid, or trusted by a person) sends it.
  trust('owner@cf4c.example');
  assert.equal((await draftWith(own, 'sam@cf4c.example', { custom_fields: [{ name: 'Case number', value: lure }], send: true })).status, 200);
});

// ---- 5. Changing or deleting a field never changes what was sent -------------------------------------------------

test('changing a field follows into drafts and templates and never into envelopes that were sent; deleting one keeps their values', async () => {
  const { own, cn } = await account('cf5a');
  trust('owner@cf5a.example');
  const done = (await draftWith(own, 'd1@cf5a.example', { custom_fields: [{ name: 'Case number', value: 'DONE-1' }], send: true })).data.envelope;
  assert.equal((await signAll(done.id, 'd1@cf5a.example')).status, 200);
  const signedBefore = db.get('SELECT final_sha256 s FROM envelopes WHERE id=?', done.id).s;
  const out = (await draftWith(own, 'o1@cf5a.example', { custom_fields: [{ name: 'Case number', value: 'OUT-1' }], send: true })).data.envelope;
  const draft = (await draftWith(own, 'r1@cf5a.example', { custom_fields: [{ name: 'Case number', value: 'DRAFT-1' }] })).data.envelope;
  const tpl = await template(own, { custom_fields: [{ name: 'Case number', value: 'TPL-1' }] });
  // Renamed, taken off the certificate and made a list of choices.
  const ch = await patch(own, `/custom-fields/${cn.id}`, { name: 'File reference', on_certificate: false, kind: 'list', choices: ['A', 'B'] });
  assert.equal(ch.status, 200, JSON.stringify(ch.data));
  const read = async (id: string) => (await own.get(`/envelopes/${id}`)).data.envelope.custom_fields;
  assert.deepEqual(await read(done.id), [{ name: 'Case number', value: 'DONE-1', on_certificate: true }]);
  assert.deepEqual(await read(out.id), [{ name: 'Case number', value: 'OUT-1', on_certificate: true }]);
  assert.deepEqual(await read(draft.id), [{ name: 'File reference', value: 'DRAFT-1', on_certificate: false }]);
  assert.deepEqual(await read(tpl.id), [{ name: 'File reference', value: 'TPL-1', on_certificate: false }]);
  // The signed copy that was made is untouched, and the one still out is completed with what it was sent with.
  assert.equal(db.get('SELECT final_sha256 s FROM envelopes WHERE id=?', done.id).s, signedBefore);
  // Its value can be put right under either name, and keeps the name it went out with.
  const fix = await own.put(`/envelopes/${out.id}/custom-fields`, { custom_fields: [{ name: 'File reference', value: 'B' }] });
  assert.equal(fix.status, 200, JSON.stringify(fix.data));
  assert.deepEqual(fix.data.custom_fields, [{ name: 'Case number', value: 'B', on_certificate: true }]);
  assert.equal((await signAll(out.id, 'o1@cf5a.example')).status, 200);
  const text = await pdfText((await own.get(`/envelopes/${out.id}/download`)).data);
  assert.match(text, /Case number: B/);
  assert.ok(!text.includes('File reference'));
  // A draft is held to the field as it is now when it is sent.
  const send = await own.post(`/envelopes/${draft.id}/send`);
  assert.equal(send.status, 400);
  assert.match(send.data.error, /"DRAFT-1" is not one of the choices for "File reference"/);
  // Deleting it: drafts and templates lose the value, what was sent keeps it, also in the list and the export.
  const gone = await del(own, `/custom-fields/${cn.id}`);
  assert.deepEqual(gone.data, { ok: true, name: 'File reference', drafts_cleared: 2, sent_kept: 2 });
  assert.deepEqual(await read(draft.id), []);
  assert.deepEqual(await read(tpl.id), []);
  assert.deepEqual((await read(done.id)).map((x: any) => x.value), ['DONE-1']);
  assert.deepEqual(ids(await own.get('/envelopes?field=Case%20number')), [done.id, out.id].sort());
  const csv = unzip((await own.get('/export')).data)['envelopes.csv'].toString('utf8');
  assert.match(csv.split('\r\n')[0], /"Case number"/);
  // The draft can be sent now: the field it lacked is no longer there to ask for.
  assert.equal((await own.post(`/envelopes/${draft.id}/send`)).status, 200);
  // A copy of an envelope that was sent does not bring back a field that is gone.
  const copy = await own.post(`/envelopes/${done.id}/clone`, {});
  assert.equal(copy.status, 200, JSON.stringify(copy.data));
  assert.deepEqual(await read(copy.data.envelope?.id || copy.data.id), []);
});

test('the API description has the custom fields: their routes, the envelope\'s and documents\' properties, the list filter, webhooks', async () => {
  const { openapi } = await import('../src/server/openapi.ts');
  const spec: any = openapi();
  assert.ok(spec.paths['/custom-fields'].get && spec.paths['/custom-fields'].post);
  assert.ok(spec.paths['/custom-fields/{id}'].patch && spec.paths['/custom-fields/{id}'].delete);
  assert.ok(spec.paths['/envelopes/{id}/custom-fields'].put);
  assert.equal(spec.components.schemas.EnvelopeInput.properties.custom_fields.type, 'array');
  assert.equal(spec.components.schemas.Document.properties.fields.maxItems, 20);
  assert.ok(spec.components.schemas.WebhookEvent.properties.envelope.properties.custom_fields);
  assert.deepEqual(spec.paths['/envelopes'].get.parameters.map((p: any) => p.name).filter((n: string) => n === 'field' || n === 'value'), ['field', 'value']);
  const { listRoutes } = await import('../src/server/router.ts');
  const ours = listRoutes().filter((r) => r.path.includes('custom-fields')).map((r) => `${r.method} ${r.path} ${r.level}`).sort();
  assert.deepEqual(ours, ['DELETE /custom-fields/:id admin', 'GET /custom-fields user', 'PATCH /custom-fields/:id admin', 'POST /custom-fields admin', 'PUT /envelopes/:id/custom-fields user']);
});
