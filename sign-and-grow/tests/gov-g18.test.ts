// Signing at a service counter (research/government.json, G18): the counter permission and the queue, the person's
// own screen connected by a one-use code, each way an official records who is in front of them, each kind of help
// and its lines on the certificate, the witness rule, the receipt, the lock between people, and a pen on the pad.
import { readEnglish } from './words.ts';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, Client, signUp, upload, PNG, type Server } from './helpers.ts';

let db: Server['db'];
let cron: Server['cron'];
before(async () => {
  ({ db, cron } = await boot());
});

let n = 0;
const ip = () => `10.118.${Math.floor(++n / 200)}.${(n % 200) + 1}`;
const browser = () => Object.assign(new Client(), { ip: ip() });
const auditOf = (eid: string) => db.all('SELECT actor, action, detail FROM audit WHERE envelope_id=? ORDER BY seq', eid);
const pdfText = async (bytes: Uint8Array) => (await import('../src/server/text.ts')).extractText(bytes);
const flat = (s: string) => s.replace(/\s+/g, ' ');

async function join(owner: Client, name: string, email: string) {
  assert.equal((await owner.post('/account/invites', { email, role: 'member' })).status, 200);
  const invite = db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL', email).token;
  const c = browser();
  assert.equal((await c.post('/auth/signup', { name, email, password: 'correct horse battery', invite })).status, 200);
  return c;
}

// An agency: an admin, two officials with the counter permission, a counter template whose applicant signs in
// person with a witness (for a mark), and one without a witness.
async function agency(tag: string) {
  const admin = await signUp('Ada Admin', `ada.${tag}@agency.example`, ip());
  const off = await join(admin, 'Olu Official', `olu.${tag}@agency.example`);
  const two = await join(admin, 'Tess Second', `tess.${tag}@agency.example`);
  const uid = (email: string) => db.get('SELECT id FROM users WHERE email=?', email).id;
  const file = await upload(admin, 1);
  const tpl = async (subject: string, witness: boolean) => {
    const r = await admin.post('/envelopes', {
      kind: 'template', subject,
      documents: [{ id: 'd', file_id: file.id, name: subject }],
      recipients: [
        { id: 'p', role: 'inperson', role_name: 'Applicant', name: '', email: '' },
        ...(witness ? [{ id: 'w', role: 'witness', witness_for: 'p', name: 'Wanda Witness', email: `wanda.${tag}@agency.example` }] : []),
      ],
      fields: [
        { id: 'fs', document_id: 'd', recipient_id: 'p', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
        { id: 'ft', document_id: 'd', recipient_id: 'p', type: 'text', label: 'Home address', page: 0, x: 0.1, y: 0.4, w: 0.3, h: 0.03 },
        ...(witness ? [{ id: 'fw', document_id: 'd', recipient_id: 'w', type: 'signature', page: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.06 }] : []),
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.envelope.id as string;
  };
  const withWitness = await tpl('Benefit claim', true);
  const plain = await tpl('Address change', false);
  return { admin, off, two, withWitness, plain, offId: uid(`olu.${tag}@agency.example`), twoId: uid(`tess.${tag}@agency.example`), adminId: uid(`ada.${tag}@agency.example`) };
}
async function setUp(tag: string) {
  const a = await agency(tag);
  for (const t of [a.withWitness, a.plain]) assert.equal((await a.admin.put(`/counter/templates/${t}`, { counter: true })).status, 200);
  for (const u of [a.offId, a.twoId]) assert.equal((await a.admin.put(`/counter/staff/${u}`, { counter: true })).status, 200);
  return a;
}
async function start(c: Client, template: string, name = 'Pat Citizen', email = `pat.${++n}@home.example`) {
  const r = await c.post('/counter/start', { template_id: template, name, email });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const token = db.get("SELECT token FROM recipients WHERE envelope_id=? AND role='inperson'", r.data.envelope_id).token;
  return { eid: r.data.envelope_id as string, vid: r.data.visit_id as string, token: token as string };
}
const knownId = { method: 'known', attest: true };
async function sign(b: Client, token: string) {
  assert.equal((await b.post(`/sign/${token}/consent`)).status, 200);
  const v = (await b.get(`/sign/${token}`)).data;
  const values: Record<string, string> = {};
  for (const f of v.fields || []) values[f.id] = f.type === 'text' ? '1 Main Street' : '1';
  return b.post(`/sign/${token}/complete`, { values, signature_png: PNG, version: v.version });
}

// ---- 1. The permission and the queue ----------------------------------------------------------------------------

test('with zero setup nobody sees the counter; an admin gives the permission person by person', async () => {
  const a = await agency('zero');
  // Nobody has it, the admin and owner included, and /me says nothing about it.
  assert.equal((await a.admin.get('/me')).data.counter, undefined);
  assert.equal((await a.off.get('/me')).data.counter, undefined);
  const no = await a.admin.get('/counter');
  assert.equal(no.status, 403);
  assert.equal(no.data.code, 'not_counter_staff');
  // A member cannot give it or change the counter's rules.
  assert.equal((await a.off.put(`/counter/staff/${a.offId}`, { counter: true })).status, 403);
  assert.equal((await a.off.get('/counter/settings')).status, 403);
  // A template with nobody who signs in person cannot be a counter template.
  const file = await upload(a.admin, 1);
  const bare = (await a.admin.post('/envelopes', { kind: 'template', subject: 'Letter', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 's', role: 'signer', role_name: 'Client' }], fields: [] })).data.envelope.id;
  const refused = await a.admin.put(`/counter/templates/${bare}`, { counter: true });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /nobody who signs in person/);
  const settings = (await a.admin.get('/counter/settings')).data;
  assert.ok(!settings.templates.some((t: any) => t.id === bare), 'only templates with an in-person signer are offered');
  // Given to one official: they see the Counter, the other member does not.
  assert.equal((await a.admin.put(`/counter/templates/${a.plain}`, { counter: true })).status, 200);
  assert.equal((await a.admin.put(`/counter/staff/${a.offId}`, { counter: true })).status, 200);
  assert.equal((await a.off.get('/me')).data.counter, true);
  assert.equal((await a.two.get('/me')).data.counter, undefined);
  const q = (await a.off.get('/counter')).data;
  assert.deepEqual(q.templates.map((t: any) => t.subject), ['Address change']);
  assert.match(q.note, /cannot check an identity document/);
  // An API key never works the counter, whoever made it.
  const key = (await a.admin.post('/api-keys', { name: 'k', scope: 'admin' })).data;
  if (key?.key) {
    const k = new Client();
    const r = await k.call('GET', '/counter', undefined, { authorization: `Bearer ${key.key}` });
    assert.equal(r.status, 403);
  }
  // Taking it away hides it again.
  assert.equal((await a.admin.put(`/counter/staff/${a.offId}`, { counter: false })).status, 200);
  assert.equal((await a.off.get('/counter')).status, 403);
});

test('the queue lists people waiting on counter documents, and Start makes and sends one', async () => {
  const a = await setUp('queue');
  const bad = await a.off.post('/counter/start', { template_id: a.plain, name: 'Pat Citizen', email: 'not an address' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /email address for their copy/);
  const noName = await a.off.post('/counter/start', { template_id: a.plain, name: ' ', email: 'pat@home.example' });
  assert.equal(noName.status, 400);
  const s = await start(a.off, a.plain, 'Pat Queue');
  const e = db.get('SELECT status, template_id FROM envelopes WHERE id=?', s.eid);
  assert.equal(e.status, 'sent');
  assert.equal(e.template_id, a.plain);
  // A document sent from a counter template by someone else, for later, is in the queue too.
  const back = await a.admin.post('/envelopes', { template_id: a.plain, send: true, recipients: { Applicant: { name: 'Quinn Later', email: 'quinn@home.example' } } });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  const q = (await a.two.get('/counter')).data;
  const names = q.waiting.map((x: any) => x.name);
  assert.ok(names.includes('Pat Queue') && names.includes('Quinn Later'), JSON.stringify(names));
  assert.equal(q.waiting.find((x: any) => x.name === 'Pat Queue').with, 'Olu Official');
  // Tess takes Quinn: a visit of her own. Then she takes Pat over from Olu, and the trail says so.
  const quinn = q.waiting.find((x: any) => x.name === 'Quinn Later');
  assert.equal((await a.two.post('/counter/visits', { envelope_id: quinn.envelope_id })).status, 200);
  const over = await a.two.post('/counter/visits', { envelope_id: s.eid });
  assert.equal(over.status, 200);
  assert.notEqual(over.data.visit_id, s.vid);
  assert.ok(auditOf(s.eid).some((l: any) => l.action === 'Counter visit taken over'));
  // Olu's old visit is closed: nothing more can be recorded on it.
  const late = await a.off.post(`/counter/visits/${s.vid}/identity`, knownId);
  assert.equal(late.status, 409);
  assert.equal(late.data.code, 'visit_closed');
  // Another account's official sees none of it.
  const other = await setUp('queue-other');
  assert.equal((await other.off.get(`/counter/visits/${s.vid}`)).status, 404);
  assert.equal((await other.off.post('/counter/visits', { envelope_id: s.eid })).status, 404);
  assert.ok(!(await other.off.get('/counter')).data.waiting.some((x: any) => x.envelope_id === s.eid));
});

// ---- 2. The identity check ----------------------------------------------------------------------------------------

test('nothing opens until the official has recorded who this is, and each way is checked', async () => {
  const a = await setUp('id');
  const s = await start(a.off, a.plain, 'Ida Person');
  const b = browser();
  const shut = await b.get(`/sign/${s.token}`);
  assert.equal(shut.status, 423);
  assert.equal(shut.data.code, 'counter_id_first');
  assert.equal((await b.post(`/sign/${s.token}/consent`)).status, 423);
  // The official's own device: no link before the check either.
  assert.equal((await a.off.post(`/counter/visits/${s.vid}/link`)).data.code, 'counter_id_first');
  const say = async (body: any) => a.off.post(`/counter/visits/${s.vid}/identity`, body);
  assert.match((await say({ method: 'known' })).data.error, /Tick "I checked this person's identity as recorded above\."/);
  assert.match((await say({ method: 'document', attest: true, doc_type: 'Passport', last4: '12', country: 'Ruritania' })).data.error, /last 4 letters or digits/);
  assert.match((await say({ method: 'document', attest: true, doc_type: 'Passport', last4: '1234567', country: 'Ruritania' })).data.error, /last 4/);
  assert.match((await say({ method: 'document', attest: true, doc_type: 'Passport', last4: 'AB12', country: '' })).data.error, /country or authority/);
  assert.match((await say({ method: 'document', attest: true, doc_type: 'Other', doc_other: '', last4: 'AB12', country: 'Ruritania' })).data.error, /which kind of document/);
  const eid = await say({ method: 'eid', attest: true });
  assert.equal(eid.status, 400);
  assert.match(eid.data.error, /not set up on this server/);
  assert.equal((await say({ method: 'fingerprint', attest: true })).status, 400);
  // Only the official with the person may record it.
  assert.equal((await a.two.post(`/counter/visits/${s.vid}/identity`, knownId)).data.code, 'not_your_visit');
  const ok = await say({ method: 'document', attest: true, doc_type: 'Other', doc_other: 'Refugee travel document', last4: 'x9 7k', country: 'Ruritania' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const v = db.get('SELECT * FROM counter_visits WHERE id=?', s.vid);
  assert.equal(v.id_last4, 'X97K', 'only the last 4 characters, written as capitals');
  assert.equal(v.id_doc_type, 'Refugee travel document');
  const line = auditOf(s.eid).find((l: any) => l.action === 'Identity checked at the counter');
  assert.match(line.actor, /Olu Official/);
  assert.match(line.detail, /Olu Official stated: "I checked this person's identity as recorded above\."/);
  assert.match(line.detail, /cannot check an identity document/);
  // Now the page opens, and the official's view shows what was recorded.
  assert.equal((await b.get(`/sign/${s.token}`)).status, 200);
  const view = (await a.off.get(`/counter/visits/${s.vid}`)).data;
  assert.match(view.identity.words, /Refugee travel document issued by Ruritania, number ending X97K/);
  // A mistake is corrected before the person finishes: the new record counts, and the trail keeps both.
  assert.equal((await say({ method: 'document', attest: true, doc_type: 'Passport', last4: 'AB12', country: 'Ruritania' })).status, 200);
  assert.match((await a.off.get(`/counter/visits/${s.vid}`)).data.identity.words, /Passport issued by Ruritania, number ending AB12/);
  assert.equal(auditOf(s.eid).filter((l: any) => l.action === 'Identity checked at the counter').length, 2);
  // "Known to me" is the other way, and reads as such.
  const t = await start(a.off, a.plain, 'Kim Known');
  assert.equal((await a.off.post(`/counter/visits/${t.vid}/identity`, knownId)).status, 200);
  assert.match((await a.off.get(`/counter/visits/${t.vid}`)).data.identity.words, /Known to the official personally/);
});

test('what the person types is not on the official screen unless the template allows it', async () => {
  const a = await setUp('values');
  const s = await start(a.off, a.plain, 'Val Private');
  await a.off.post(`/counter/visits/${s.vid}/identity`, knownId);
  const b = browser();
  await b.post(`/sign/${s.token}/consent`);
  const v = (await b.get(`/sign/${s.token}`)).data;
  const text = v.fields.find((f: any) => f.type === 'text');
  assert.equal((await b.post(`/sign/${s.token}/save`, { values: { [text.id]: '7 Secret Lane' }, version: v.version })).status, 200);
  const hidden = (await a.off.get(`/counter/visits/${s.vid}`)).data;
  assert.equal(hidden.progress.filled, 1);
  assert.equal(hidden.progress.values, undefined);
  assert.ok(!JSON.stringify(hidden).includes('Secret Lane'));
  assert.equal((await a.admin.put(`/counter/templates/${a.plain}`, { counter: true, show_values: true })).status, 200);
  const shown = (await a.off.get(`/counter/visits/${s.vid}`)).data;
  assert.ok(shown.progress.values.some((x: any) => x.value === '7 Secret Lane'));
});

// ---- 3. Help with signing, the witness rule, and the certificate ---------------------------------------------------

test('a mark needs a witness, and the official is not the witness unless the account allows it', async () => {
  const a = await setUp('mark');
  const s = await start(a.off, a.plain, 'Mo Mark');
  await a.off.post(`/counter/visits/${s.vid}/identity`, knownId);
  const none = await a.off.post(`/counter/visits/${s.vid}/helps`, { kind: 'mark', attest: true });
  assert.equal(none.status, 409);
  assert.equal(none.data.code, 'no_witness');
  // A template whose witness is the official herself.
  const file = await upload(a.admin, 1);
  const own = (await a.admin.post('/envelopes', {
    kind: 'template', subject: 'Own witness',
    documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'p', role: 'inperson', role_name: 'Applicant' }, { id: 'w', role: 'witness', witness_for: 'p', name: 'Olu Official', email: 'olu.mark@agency.example' }],
    fields: [{ document_id: 'd', recipient_id: 'p', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { document_id: 'd', recipient_id: 'w', type: 'signature', page: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.06 }],
  })).data.envelope.id;
  await a.admin.put(`/counter/templates/${own}`, { counter: true });
  const t = await start(a.off, own, 'Mia Mark');
  await a.off.post(`/counter/visits/${t.vid}/identity`, knownId);
  const self = await a.off.post(`/counter/visits/${t.vid}/helps`, { kind: 'mark', attest: true });
  assert.equal(self.data.code, 'official_is_witness');
  assert.equal((await a.admin.put('/counter/settings', { official_may_witness: true })).status, 200);
  assert.equal((await a.off.post(`/counter/visits/${t.vid}/helps`, { kind: 'mark', attest: true })).status, 200);
  assert.equal((await a.admin.put('/counter/settings', { official_may_witness: false })).status, 200);
  // Finish asks again: the rule changed back before the person finished.
  const b = browser();
  const fin = await sign(b, t.token);
  assert.equal(fin.status, 409);
  assert.equal(fin.data.code, 'official_is_witness');
  // With another witness the mark is recorded, and the person finishes.
  const u = await start(a.off, a.withWitness, 'Max Mark');
  await a.off.post(`/counter/visits/${u.vid}/identity`, knownId);
  const mark = await a.off.post(`/counter/visits/${u.vid}/helps`, { kind: 'mark', attest: true });
  assert.equal(mark.status, 200, JSON.stringify(mark.data));
  // A mark and someone signing for them do not go together.
  assert.equal((await a.off.post(`/counter/visits/${u.vid}/helps`, { kind: 'behalf', attest: true })).status, 409);
  assert.equal((await sign(browser(), u.token)).status, 200);
});

test('someone signs for the person only once a second official confirms it with their own login', async () => {
  const a = await setUp('behalf');
  const s = await start(a.off, a.plain, 'Bea Behalf');
  await a.off.post(`/counter/visits/${s.vid}/identity`, { method: 'document', attest: true, doc_type: 'Passport', last4: 'ZZ01', country: 'Ruritania' });
  assert.match((await a.off.post(`/counter/visits/${s.vid}/helps`, { kind: 'behalf' })).data.error, /Tick the statement/);
  const h = await a.off.post(`/counter/visits/${s.vid}/helps`, { kind: 'behalf', attest: true });
  assert.equal(h.status, 200);
  assert.equal((await a.off.post(`/counter/visits/${s.vid}/helps`, { kind: 'behalf', attest: true })).status, 409, 'once');
  const b = browser();
  const early = await sign(b, s.token);
  assert.equal(early.status, 409);
  assert.equal(early.data.code, 'counter_second_official');
  // The same official cannot be the second; a member without the permission cannot either.
  assert.equal((await a.off.post(`/counter/visits/${s.vid}/helps/${h.data.id}/confirm`, { attest: true })).data.code, 'same_official');
  const plainMember = await join(a.admin, 'Nell Nobody', 'nell.behalf@agency.example');
  assert.equal((await plainMember.post(`/counter/visits/${s.vid}/helps/${h.data.id}/confirm`, { attest: true })).status, 403);
  assert.match((await a.two.post(`/counter/visits/${s.vid}/helps/${h.data.id}/confirm`, {})).data.error, /Tick the statement/);
  assert.equal((await a.two.post(`/counter/visits/${s.vid}/helps/${h.data.id}/confirm`, { attest: true })).status, 200);
  assert.equal((await a.two.post(`/counter/visits/${s.vid}/helps/${h.data.id}/confirm`, { attest: true })).status, 409, 'confirmed once');
  // Read aloud and an interpreter, each with what the certificate needs.
  assert.match((await a.off.post(`/counter/visits/${s.vid}/helps`, { kind: 'read_aloud', attest: true })).data.error, /Type the language/);
  assert.equal((await a.off.post(`/counter/visits/${s.vid}/helps`, { kind: 'read_aloud', attest: true, language: 'Welsh' })).status, 200);
  assert.match((await a.off.post(`/counter/visits/${s.vid}/helps`, { kind: 'interpreter', attest: true, language: 'Polish' })).data.error, /interpreter's full name/);
  const interp = await a.off.post(`/counter/visits/${s.vid}/helps`, { kind: 'interpreter', attest: true, language: 'Polish', interpreter: 'Ian Interpreter' });
  assert.equal(interp.status, 200);
  // One taken back by mistake stays in the trail and leaves the certificate.
  const extra = await a.off.post(`/counter/visits/${s.vid}/helps`, { kind: 'mark', attest: true });
  assert.equal(extra.status, 409, 'a mark next to someone signing for them is refused');
  assert.equal((await a.off.call('DELETE', `/counter/visits/${s.vid}/helps/${interp.data.id}`)).status, 200);
  assert.equal((await a.off.post(`/counter/visits/${s.vid}/helps`, { kind: 'interpreter', attest: true, language: 'Polish', interpreter: 'Ina Interpreter' })).status, 200);
  assert.equal((await sign(b, s.token)).status, 200);
  // The certificate prints each statement as the official's.
  const pdf = (await a.off.get(`/envelopes/${s.eid}/download`)).data;
  const text = flat(await pdfText(pdf));
  assert.match(text, /At the counter/);
  assert.match(text, /Passport issued by Ruritania, number ending ZZ01/);
  assert.match(text, /Stated by Olu Official/);
  assert.match(text, /cannot check an identity document/);
  assert.match(text, /Signed by Olu Official for Bea Behalf/);
  assert.match(text, /Tess Second stated: "I heard Bea Behalf ask out loud for Olu Official to sign for them\."/);
  assert.match(text, /read the whole document aloud to Bea Behalf in Welsh/);
  assert.match(text, /Ina Interpreter interpreted between Bea Behalf and me in Polish/);
  // What was taken back is not among the counter lines; the audit trail on the certificate keeps both.
  const { counterCertLines } = await import('../src/server/counter.ts');
  const r = db.get("SELECT * FROM recipients WHERE envelope_id=? AND role='inperson'", s.eid);
  const lines = JSON.stringify(counterCertLines({ id: s.eid }, r, (x: any) => String(x)));
  assert.match(lines, /Ina Interpreter/);
  assert.ok(!/Ian Interpreter/.test(lines), 'what was taken back is not on the certificate');
  assert.ok(auditOf(s.eid).some((l: any) => l.action === 'Counter: help taken back'));
  // Nothing more is recorded after Finish.
  assert.equal((await a.off.post(`/counter/visits/${s.vid}/helps`, { kind: 'read_aloud', attest: true, language: 'Welsh' })).data.code, 'finished');
  // The evidence pack has the statements in words.
  const { readZip } = await import('../src/server/zip.ts');
  const pack = readZip((await a.off.get(`/envelopes/${s.eid}/evidence`)).data, { damaged: () => new Error('zip'), maxUnpacked: 1e8 });
  const counter = pack.find((f) => f.name === 'counter.txt');
  assert.ok(counter, pack.map((f) => f.name).join(', '));
  assert.match(counter!.data.toString(), /Confirmed by Tess Second/);
  assert.match(pack.find((f) => f.name === 'README.txt')!.data.toString(), /counter\.txt/);
});

// ---- 4. The person's own screen: one-use code, ten minutes, and the lock between people ------------------------------

test('the person screen connects with a code once, opens after the check, and is cleared for the next person', async () => {
  const a = await setUp('screen');
  const s = await start(a.off, a.plain, 'Sam Screen');
  const code = (await a.off.post(`/counter/visits/${s.vid}/code`)).data;
  assert.match(code.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.match(code.url, /\/counter\/screen\?code=/);
  const tablet = browser();
  assert.equal((await tablet.get('/counter/screen')).data.state, 'none');
  assert.equal((await tablet.post('/counter/screen', { code: 'ABC' })).status, 400);
  assert.equal((await tablet.post('/counter/screen', { code: 'AAAAAA' })).data.code, 'bad_code');
  // Typed with a space and small letters, as people do.
  const paired = await tablet.post('/counter/screen', { code: `${code.code.slice(0, 3).toLowerCase()} ${code.code.slice(3)}` });
  assert.equal(paired.status, 200, JSON.stringify(paired.data));
  assert.equal(paired.data.state, 'waiting', 'before the check the screen waits and is given no link');
  assert.equal(paired.data.url, undefined);
  // One use: a second screen with the same code gets nothing.
  assert.equal((await browser().post('/counter/screen', { code: code.code })).data.code, 'bad_code');
  assert.equal((await a.off.get(`/counter/visits/${s.vid}`)).data.screen, true);
  await a.off.post(`/counter/visits/${s.vid}/identity`, knownId);
  const ready = (await tablet.get('/counter/screen')).data;
  assert.equal(ready.state, 'ready');
  assert.match(ready.url, new RegExp(`/sign/${s.token}$`));
  // The signing page knows it is on the counter screen, for "Next person" on the done screen.
  const page = (await tablet.get(`/sign/${s.token}`)).data;
  assert.equal(page.envelope.counter.screen, true);
  assert.equal((await browser().get(`/sign/${s.token}`)).data.envelope.counter.screen, false, 'another browser is not the counter screen');
  assert.equal((await sign(tablet, s.token)).status, 200);
  // Finished: the screen is never given that link again.
  const done = (await tablet.get('/counter/screen')).data;
  assert.equal(done.state, 'done');
  assert.equal(done.url, undefined);
  // Next person: the screen forgets its visit, and a new code is needed.
  const next = await tablet.post('/counter/screen/next');
  assert.equal(next.status, 200);
  assert.equal(tablet.cookies.ts_counter, '');
  assert.equal((await tablet.get('/counter/screen')).data.state, 'none');
  // A code older than ten minutes no longer works.
  const t = await start(a.off, a.plain, 'Tia Late');
  const old = (await a.off.post(`/counter/visits/${t.vid}/code`)).data;
  db.run('UPDATE counter_codes SET expires_at=? WHERE visit_id=?', new Date(Date.now() - 1000).toISOString(), t.vid);
  assert.equal((await browser().post('/counter/screen', { code: old.code })).data.code, 'bad_code');
  // A new code replaces an unused one.
  const first = (await a.off.post(`/counter/visits/${t.vid}/code`)).data;
  const second = (await a.off.post(`/counter/visits/${t.vid}/code`)).data;
  assert.equal((await browser().post('/counter/screen', { code: first.code })).data.code, 'bad_code');
  assert.equal((await browser().post('/counter/screen', { code: second.code })).status, 200);
  // Guessing is limited per address.
  const guesser = browser();
  let last = 0;
  for (let i = 0; i < 105; i++) last = (await guesser.post('/counter/screen', { code: 'ZZZZZZ' })).status;
  assert.equal(last, 429);
  // On the timer, old codes go.
  db.run('UPDATE counter_codes SET expires_at=? WHERE visit_id=?', new Date(Date.now() - 2 * 864e5).toISOString(), t.vid);
  await cron.tick();
  assert.equal(db.get('SELECT COUNT(*) n FROM counter_codes WHERE visit_id=?', t.vid).n, 0);
});

test("on the official's own device the existing hand-over lock applies", async () => {
  const a = await setUp('lock');
  const s = await start(a.off, a.plain, 'Lou Lock');
  await a.off.post(`/counter/visits/${s.vid}/identity`, knownId);
  const link = (await a.off.post(`/counter/visits/${s.vid}/link`)).data.url;
  assert.match(link, /\/sign\//);
  // The official's browser opens the page: their account locks in that browser until their password.
  assert.equal((await a.off.get(new URL(link).pathname.replace(/^\/sign/, '/sign'))).status, 200);
  assert.equal((await a.off.get('/counter')).status, 401);
  assert.ok((await a.off.get('/me')).data.handed_over);
  assert.equal((await a.off.post('/auth/unlock', { password: 'correct horse battery' })).status, 200);
  assert.equal((await a.off.get('/counter')).status, 200);
});

// ---- 5. The receipt --------------------------------------------------------------------------------------------------

test('the receipt says the ID, the fingerprint, where the copy goes and the agency contact', async () => {
  const a = await setUp('receipt');
  assert.equal((await a.admin.put('/counter/settings', { contact: 'Civic Centre, desk 3, 01234 567890' })).status, 200);
  const s = await start(a.off, a.plain, 'Rae Receipt', 'rae@home.example');
  assert.equal((await a.off.get(`/counter/visits/${s.vid}/receipt`)).status, 409, 'none before Finish');
  await a.off.post(`/counter/visits/${s.vid}/identity`, knownId);
  assert.equal((await sign(browser(), s.token)).status, 200);
  const r = (await a.off.get(`/counter/visits/${s.vid}/receipt`)).data;
  assert.equal(r.envelope_id, s.eid);
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(r.fingerprint, db.get('SELECT final_sha256 x FROM envelopes WHERE id=?', s.eid).x);
  assert.match(r.copy, /emailed to rae@home\.example/);
  assert.match(r.check, new RegExp(`/verify and type ${s.eid}`));
  assert.equal(r.contact, 'Civic Centre, desk 3, 01234 567890');
  assert.match(r.note, /cannot check an identity document/);
  // Finished today stays in the queue for a reprint.
  assert.ok((await a.off.get('/counter')).data.finished.some((x: any) => x.envelope_id === s.eid));
});

// ---- Repairs after the skeptic and the simplicity review (repair-g18) ------------------------------------------------

test('after Finish the link used at the counter opens nothing, and the emailed copy carries a new link', async () => {
  const a = await setUp('oldlink');
  const email = `pat.old.${++n}@home.example`;
  const s = await start(a.off, a.plain, 'Pat Old', email);
  const code = (await a.off.post(`/counter/visits/${s.vid}/code`)).data;
  const tablet = browser();
  await tablet.post('/counter/screen', { code: code.code });
  await a.off.post(`/counter/visits/${s.vid}/identity`, knownId);
  assert.equal((await sign(tablet, s.token)).status, 200);
  // The next person at the tablet, from its history, and anyone else: nothing of the document.
  for (const who of [tablet, browser()]) {
    assert.equal((await who.get(`/sign/${s.token}`)).status, 404);
    assert.equal((await who.get(`/sign/${s.token}/download`)).status, 404);
  }
  await tablet.post('/counter/screen/next');
  assert.equal((await tablet.get(`/sign/${s.token}/download`)).status, 404);
  // The person's own email has a link only they have, and it opens their completed copy.
  const fresh = db.get("SELECT token FROM recipients WHERE envelope_id=? AND role='inperson'", s.eid).token;
  assert.notEqual(fresh, s.token);
  const mail = (await import('./helpers.ts')).mailTo(email).find((m: any) => /^Completed:/.test(m.subject));
  assert.ok(mail, 'the completed email went to the person');
  assert.ok(String(mail.link || mail.html).includes(`/sign/${fresh}`), 'the completed email carries the new link');
  assert.ok(!String(mail.html).includes(s.token), 'and never the old one');
  const home = browser();
  assert.equal((await home.get(`/sign/${fresh}`)).status, 200);
  assert.equal((await home.get(`/sign/${fresh}/download`)).status, 200);
  assert.ok(auditOf(s.eid).some((x: any) => x.action === 'Counter link closed'));
  // The done screen offers no download of the closed link: the page knows this is a counter signer.
  assert.equal((await home.get(`/sign/${fresh}`)).data.envelope.counter.screen, false);
});

test('a counter document with no visit opens nowhere until an official presses Start and records the check', async () => {
  const a = await setUp('novisit');
  // Sent the ordinary way, from the counter template.
  const who = (tpl: string) => db.get("SELECT id FROM recipients WHERE envelope_id=? AND role='inperson'", tpl).id;
  const r = await a.admin.post('/envelopes', { template_id: a.plain, send: true, recipients: { [who(a.plain)]: { name: 'Nia Novisit', email: `nia.${++n}@home.example` } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const eid = r.data.envelope.id;
  const token = db.get("SELECT token FROM recipients WHERE envelope_id=? AND role='inperson'", eid).token;
  const b = browser();
  const first = await b.get(`/sign/${token}`);
  assert.equal(first.status, 423);
  assert.equal(first.data.code, 'counter_id_first');
  assert.match(first.data.error || first.data.message || '', /Start on the Counter/);
  assert.equal((await b.post(`/sign/${token}/consent`)).status, 423);
  assert.equal((await b.post(`/sign/${token}/complete`, { values: {}, signature_png: PNG })).status, 423);
  assert.equal((await b.get(`/sign/${token}/download`)).status, 423);
  // It is on the queue; Start, then the check, and it opens.
  const line = (await a.off.get('/counter')).data.waiting.find((x: any) => x.envelope_id === eid);
  assert.ok(line);
  const vid = (await a.off.post('/counter/visits', { envelope_id: eid })).data.visit_id;
  assert.equal((await b.get(`/sign/${token}`)).status, 423);
  await a.off.post(`/counter/visits/${vid}/identity`, knownId);
  assert.equal((await b.get(`/sign/${token}`)).status, 200);
  // A template no longer used at the counter: a document that never had a visit opens as any signing in person.
  const other = await a.admin.post('/envelopes', { template_id: a.withWitness, send: true, recipients: { [who(a.withWitness)]: { name: 'Ola Ordinary', email: `ola.${++n}@home.example` } } });
  assert.equal(other.status, 200, JSON.stringify(other.data));
  await a.admin.put(`/counter/templates/${a.withWitness}`, { counter: false });
  const t2 = db.get("SELECT token FROM recipients WHERE envelope_id=? AND role='inperson'", other.data.envelope.id).token;
  assert.equal((await browser().get(`/sign/${t2}`)).status, 200);
});

test('signing in person outside the counter is unchanged: it opens at once and keeps its download', async () => {
  const admin = await signUp('Ivy Inperson', `ivy.${++n}@shop.example`, ip());
  const file = await upload(admin, 1);
  const r = await admin.post('/envelopes', {
    subject: 'Shop form', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'p', role: 'inperson', name: 'Walk In', email: `walk.${n}@home.example` }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'p', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const token = db.get("SELECT token FROM recipients WHERE envelope_id=? AND role='inperson'", r.data.envelope.id).token;
  const b = browser();
  const page = await b.get(`/sign/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.envelope.counter, undefined, 'nothing of the counter outside it');
  assert.equal((await sign(b, token)).status, 200);
  assert.equal(db.get("SELECT token FROM recipients WHERE envelope_id=? AND role='inperson'", r.data.envelope.id).token, token, 'the link is not changed');
  assert.equal((await b.get(`/sign/${token}/download`)).status, 200);
});

test('a declined document tells the screen that signing stopped, not that the person finished', async () => {
  const a = await setUp('declined');
  const s = await start(a.off, a.plain, 'Dee Decline');
  const code = (await a.off.post(`/counter/visits/${s.vid}/code`)).data;
  const tablet = browser();
  await tablet.post('/counter/screen', { code: code.code });
  await a.off.post(`/counter/visits/${s.vid}/identity`, knownId);
  assert.equal((await tablet.post(`/sign/${s.token}/decline`, { reason: 'I do not want to sign this today.' })).status, 200);
  const st = (await tablet.get('/counter/screen')).data;
  assert.equal(st.state, 'closed');
  assert.equal(st.url, undefined);
  assert.equal((await a.off.get(`/counter/visits/${s.vid}/receipt`)).status, 409);
});

test('the official can connect another screen while one is connected; the new one replaces it', async () => {
  const a = await setUp('reconnect');
  const s = await start(a.off, a.plain, 'Rex Reconnect');
  await a.off.post(`/counter/visits/${s.vid}/identity`, knownId);
  const one = browser();
  await one.post('/counter/screen', { code: (await a.off.post(`/counter/visits/${s.vid}/code`)).data.code });
  const v1 = (await a.off.get(`/counter/visits/${s.vid}`)).data;
  assert.equal(v1.screen, true);
  assert.ok(v1.screen_at);
  // The tablet died: a new code while the first screen is still connected.
  const code = (await a.off.post(`/counter/visits/${s.vid}/code`)).data;
  assert.ok(code.created_at >= v1.screen_at);
  const two = browser();
  assert.equal((await two.post('/counter/screen', { code: code.code })).data.state, 'ready');
  const v2 = (await a.off.get(`/counter/visits/${s.vid}`)).data;
  assert.ok(v2.screen_at >= code.created_at, 'the screen the new code connected is the one shown');
  assert.equal((await one.get('/counter/screen')).data.state, 'none', 'the old screen is disconnected');
});

test('the Counter tells an admin where to set up a document, and an office behind one address can pair', async () => {
  const a = await agency(`setup${++n}`);
  for (const u of [a.offId, a.adminId]) await a.admin.put(`/counter/staff/${u}`, { counter: true });
  const asAdmin = (await a.admin.get('/counter')).data;
  assert.equal(asAdmin.templates.length, 0);
  assert.equal(asAdmin.can_set_up, true);
  assert.equal((await a.off.get('/counter')).data.can_set_up, false);
  // Twenty typos from one office address do not lock its tablets out.
  await a.admin.put(`/counter/templates/${a.plain}`, { counter: true });
  const s = await start(a.off, a.plain, 'Oda Office');
  const office = ip();
  for (let i = 0; i < 25; i++) await Object.assign(new Client(), { ip: office }).post('/counter/screen', { code: 'ZZZZZZ' });
  const code = (await a.off.post(`/counter/visits/${s.vid}/code`)).data.code;
  assert.equal((await Object.assign(new Client(), { ip: office }).post('/counter/screen', { code })).status, 200);
});

test('the receipt prints at 80 mm with a page size the browser accepts, and the counter words stay plain', async () => {
  const fs = await import('node:fs');
  const receipt = fs.readFileSync(new URL('../src/components/counter/Receipt.tsx', import.meta.url), 'utf8');
  assert.ok(!receipt.includes("'80mm auto'"), '"80mm auto" is not valid CSS');
  assert.match(receipt, /80mm \d+mm/);
  const words = ['../src/components/counter/SignParts.tsx', '../src/components/counter/Visit.tsx', '../src/app/counter/screen/page.tsx', '../src/app/app/counter/page.tsx', '../src/components/settings/CounterSettings.tsx', '../src/server/counter.ts']
    .map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  assert.ok(!words.includes('—'), 'no em dashes');
  assert.ok(!/is valid|will hold up|legally binding/i.test(words));
  // The visit screen says the cannot-check line once, where the question is, and one name for the screen.
  const visit = fs.readFileSync(new URL('../src/components/counter/Visit.tsx', import.meta.url), 'utf8');
  assert.ok(!visit.includes("person&apos;s screen is connected"));
  assert.ok(!/ct-note">\{CANNOT_CHECK_ID\}/.test(visit));
  // The setting says what it does: only the Counter screen.
  // Read with its English put back: the card asks the catalogue for its words since lang-sender-rest (tests/words.ts).
  const set = readEnglish('src/components/settings/CounterSettings.tsx');
  assert.ok(!set.includes('Officials may see what the person types'));
  assert.match(set, /on the Counter screen/);
});

// ---- 6. A picture of the ID document: only encrypted, only when switched on, in the evidence pack -------------------

test('an ID picture is kept only with encrypted files, encrypted in the database, and listed in the evidence pack', async () => {
  const a = await setUp('picture');
  const s = await start(a.off, a.plain, 'Pia Picture');
  const form = () => {
    const f = new FormData();
    f.append('file', new Blob([Buffer.from('PICTURE-OF-A-PASSPORT')], { type: 'image/png' }), 'id.png');
    return f;
  };
  const before = process.env.FILE_ENCRYPTION_KEY;
  try {
    delete process.env.FILE_ENCRYPTION_KEY;
    assert.equal((await a.admin.get('/counter/settings')).data.pictures_possible, false);
    assert.equal((await a.admin.put('/counter/settings', { id_pictures: true })).status, 409);
    assert.equal((await a.off.call('POST', `/counter/visits/${s.vid}/picture`, form())).status, 403);
    process.env.FILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    assert.equal((await a.admin.put('/counter/settings', { id_pictures: true })).status, 200);
    const kept = await a.off.call('POST', `/counter/visits/${s.vid}/picture`, form());
    assert.equal(kept.status, 200, JSON.stringify(kept.data));
    const row = db.get('SELECT id_scan FROM counter_visits WHERE id=?', s.vid);
    assert.ok(!Buffer.from(row.id_scan).includes(Buffer.from('PASSPORT')), 'stored encrypted');
    await a.off.post(`/counter/visits/${s.vid}/identity`, knownId);
    assert.equal((await sign(browser(), s.token)).status, 200);
    const { readZip } = await import('../src/server/zip.ts');
    const pack = readZip((await a.off.get(`/envelopes/${s.eid}/evidence`)).data, { damaged: () => new Error('zip'), maxUnpacked: 1e8 });
    const pic = pack.find((f) => f.name.startsWith('counter/id-document-'));
    assert.ok(pic, pack.map((f) => f.name).join(', '));
    assert.equal(pic!.data.toString(), 'PICTURE-OF-A-PASSPORT');
    // A purged document takes its ID picture with it on the next run of the timer.
    db.run('UPDATE envelopes SET purged_at=? WHERE id=?', new Date().toISOString(), s.eid);
    await cron.tick();
    assert.equal(db.get('SELECT id_scan FROM counter_visits WHERE id=?', s.vid).id_scan, null);
  } finally {
    if (before === undefined) delete process.env.FILE_ENCRYPTION_KEY;
    else process.env.FILE_ENCRYPTION_KEY = before;
  }
});

// ---- 7. A pen on the signature pad ---------------------------------------------------------------------------------

test('a USB signature pad that reports pointer type "pen" draws on the pad, and a resting palm does not spoil it', async () => {
  const { onePen } = await import('../src/lib/ink.ts');
  const pens = onePen();
  assert.equal(pens.down(1, 'pen', true), 'draw');
  assert.equal(pens.move(1), true);
  // The hand resting on a touch screen next to the pen is ignored while the pen draws.
  assert.equal(pens.down(2, 'touch', true), 'ignore');
  assert.equal(pens.move(2), false);
  assert.equal(pens.up(2), false);
  assert.equal(pens.up(1), true, 'lifting the pen ends the line');
  // The next stroke draws again.
  assert.equal(pens.down(3, 'pen', true), 'draw');
  assert.equal(pens.up(3), true);
  // The page says what is kept.
  const { PAD_LINE } = await import('../src/lib/counter.ts');
  assert.match(PAD_LINE, /drawn picture only, not pressure or speed/);
});

// ---- Words --------------------------------------------------------------------------------------------------------

test('the counter words: no em dashes, no claims, refusals say what to do', async () => {
  const fs = await import('node:fs');
  const files = ['src/lib/counter.ts', 'src/server/counter.ts', 'src/server/routes-counter.ts'];
  for (const f of files) {
    const s = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!s.includes('—'), `${f} has an em dash`);
    assert.ok(!/\b(certified|compliant|legally valid|will hold up)\b/i.test(s), `${f} makes a claim`);
    // Every refusal is at least two sentences: what happened, then what to do.
    for (const m of s.matchAll(/bad\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g)) {
      const said = m[1] || m[2] || m[3];
      if (said.includes('${')) continue;
      assert.ok(said.split(/(?<=\.)\s+/).length >= 2 || /^(Tick|Type|Choose|Say|Record|Keep|Take)/.test(said), `${f}: "${said}"`);
    }
  }
});

