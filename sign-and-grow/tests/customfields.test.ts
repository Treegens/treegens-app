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
import { MAX_CUSTOM_FIELDS, CUSTOM_VALUE_MAX, CERT_HEADING, customKey, readValue } from '../src/lib/customfields.ts';

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
