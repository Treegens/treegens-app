// G19: the full export with a published schema, the round trip into another account, and bringing in DocuSign's
// downloads (research/government.json). The DocuSign files here are FIXTURES made from DocuSign's documented
// layouts (tests/fixtures/docusign/README.md), not real exports, until the owner provides real samples.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { boot, Client, draft, simple, signUp, signAll, upload, mailTo, type Server } from './helpers.ts';
import { readZip, zipStream } from '../src/server/zip.ts';
import { checkSchema } from '../src/server/jsonschema.ts';
import { sha256 } from '../src/server/util.ts';

let db: Server['db'];
let cron: Server['cron'];
let ana: Client;
let anaAcct: string;
before(async () => {
  ({ db, cron } = await boot());
  ana = await signUp('Ana Archive', 'ana@g19.example', '198.51.100.1');
  anaAcct = (await ana.get('/me')).data.account.id;
});

const schema = JSON.parse(fs.readFileSync(path.resolve('docs/schema/growsigning-export-v1.schema.json'), 'utf8'));
const open = (bytes: Uint8Array) => new Map(readZip(bytes, { damaged: () => new Error('damaged'), maxUnpacked: 1e9 }).map((z) => [z.name, z.data]));
const zipOf = async (entries: { name: string; data: Uint8Array }[]) => {
  const chunks: Uint8Array[] = [];
  const r = zipStream(entries).getReader();
  for (let x = await r.read(); !x.done; x = await r.read()) chunks.push(x.value);
  return Buffer.concat(chunks);
};
const sendZip = (c: Client, url: string, bytes: Uint8Array, name = 'export.zip') => {
  const f = new FormData();
  f.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), name);
  return c.call('POST', url, f);
};

// An account with one of everything: a completed, a declined and an out-for-signature envelope, a draft, a template
// with a rule and a lock, a contact, a signing group, a webhook, settings.
async function fill(c: Client) {
  const done = await simple(c, 'sam@g19.example', { subject: 'Lease, completed' });
  await c.post(`/envelopes/${done.id}/send`);
  assert.equal((await signAll(done.id, 'sam@g19.example')).status, 200);
  const out = await simple(c, 'olu@g19.example', { subject: 'Still out' });
  await c.post(`/envelopes/${out.id}/send`);
  const no = await simple(c, 'dee@g19.example', { subject: 'Declined one' });
  await c.post(`/envelopes/${no.id}/send`);
  const tok = db.get('SELECT token FROM recipients WHERE envelope_id=?', no.id).token;
  const dc = new Client();
  await dc.post(`/sign/${tok}/consent`);
  assert.equal((await dc.post(`/sign/${tok}/decline`, { reason: 'Wrong address on page 2' })).status, 200);
  const d = await draft(c, { subject: 'Half-made draft' });
  const file = await upload(c, 1);
  const t = await c.post('/envelopes', {
    kind: 'template', subject: 'Volunteer form', message: 'Please fill in.',
    documents: [{ id: 'd', file_id: file.id, name: 'Volunteer form' }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Volunteer', name: '', email: '' }],
    fields: [{ id: 'f1', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.6, w: 0.3, h: 0.06 },
      { id: 'f2', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Phone', page: 0, x: 0.1, y: 0.4, w: 0.3, h: 0.03 }],
  });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const tid = t.data.envelope.id;
  db.run("UPDATE envelopes SET tpl_use='admins', tpl_locked=1, folder='HR' WHERE id=?", tid);
  assert.equal((await c.post('/contacts', { name: 'Kim Contact', email: 'kim@g19.example', company: 'Parks' })).status, 200);
  assert.equal((await c.post('/groups', { name: 'Front desk', members: [{ name: 'Lee One', email: 'lee1@g19.example' }, { name: 'Lee Two', email: 'lee2@g19.example' }] })).status, 200);
  db.run("INSERT INTO webhooks (id, account_id, url, secret, events, active, created_at) VALUES ('wh_g19test', (SELECT account_id FROM envelopes WHERE id=?), 'https://hooks.example/g19', 'whsec_SECRET_SHOULD_NOT_LEAK', '*', 1, ?)", done.id, new Date().toISOString());
  db.run("UPDATE accounts SET brand_color='#1f6f4a', default_reminder_days=3, retention_days=400 WHERE id=(SELECT account_id FROM envelopes WHERE id=?)", done.id);
  return { done, out, no, draft: d, template: tid };
}

let made: Awaited<ReturnType<typeof fill>>;
let exportBytes: Uint8Array;

test('1-2. the full export is a ZIP whose data.json matches the published schema, with every file, a manifest and no secrets', async () => {
  made = await fill(ana);
  const r = await ana.get('/export/full');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  exportBytes = r.data;
  const z = open(r.data);
  for (const n of ['data.json', 'README.txt', 'manifest-sha256.txt', 'schema/growsigning-export-v1.schema.json']) assert.ok(z.has(n), n);
  const data = JSON.parse(z.get('data.json')!.toString());
  assert.deepEqual(checkSchema(schema, data, 50), [], 'validates against docs/schema');
  assert.equal(data.schema_version, 1);
  // Everything the brief names is there.
  assert.equal(data.envelopes.length, 4);
  assert.ok(data.templates.some((t: any) => t.subject === 'Volunteer form' && t.rules.locked && t.rules.use === 'admins' && t.folder === 'HR'));
  assert.ok(data.contacts.some((c: any) => c.email === 'kim@g19.example'));
  assert.ok(data.signing_groups.some((g: any) => g.name === 'Front desk' && g.members.length === 2));
  assert.deepEqual(data.folders, ['HR']);
  assert.equal(data.members[0].email, 'ana@g19.example');
  assert.equal(data.account.settings.brand_color, '#1f6f4a');
  assert.equal(data.retention.schedule.days, 400);
  const done = data.envelopes.find((e: any) => e.id === made.done.id);
  assert.equal(done.status, 'completed');
  assert.ok(done.audit.chain.ok && done.audit.events.length > 3);
  assert.ok(done.signed_pdf.in_export && z.has(`files/${done.signed_pdf.sha256}`));
  assert.equal(done.evidence_pack, `evidence/${done.id}.zip`);
  assert.ok(z.has(done.evidence_pack) && open(z.get(done.evidence_pack)!).has('audit-trail.json'), 'the evidence pack is a ZIP of its own');
  // Every file is named by its SHA-256, and the manifest lists every other entry with its true SHA-256.
  for (const f of data.files) assert.equal(sha256(z.get(f.path)!), f.sha256);
  const lines = z.get('manifest-sha256.txt')!.toString().trim().split('\n');
  assert.equal(lines.length, z.size - 1);
  for (const l of lines) {
    const [sum, name] = l.split('  ');
    assert.equal(sha256(z.get(name)!), sum, name);
  }
  // No secrets: no webhook secret, no signing link, no security or access code, no password hash.
  const text = z.get('data.json')!.toString();
  assert.ok(!text.includes('whsec_SECRET_SHOULD_NOT_LEAK'));
  for (const r2 of db.all('SELECT token, check_code FROM recipients WHERE envelope_id IN (SELECT id FROM envelopes WHERE account_id=?)', anaAcct)) {
    if (r2.token) assert.ok(!text.includes(r2.token), 'no signing link');
    if (r2.check_code) assert.ok(!text.includes(r2.check_code), 'no security code');
  }
  assert.ok(!text.includes('4242'), 'no access code');
  assert.ok(!/password_hash|two_step_secret|verify_token|key_hash/.test(text), 'no column of a login or a key');
  assert.ok(!text.includes(db.get('SELECT password_hash h FROM users WHERE email=?', 'ana@g19.example').h));
  assert.ok(data.webhooks[0].url === 'https://hooks.example/g19' && !('secret' in data.webhooks[0]));
  assert.match(z.get('README.txt')!.toString(), /JSON Schema 2020-12/);
});

test('2. only owners and admins, an admin key yes and a send key no; free while paused or unpaid', async () => {
  const inv = await ana.post('/account/invites', { email: 'mo@g19.example', role: 'member' });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  const mo = new Client();
  mo.ip = '198.51.100.2';
  assert.equal((await mo.post('/auth/signup', { name: 'Mo Member', email: 'mo@g19.example', password: 'correct horse battery', invite: db.get('SELECT token FROM invites WHERE email=?', 'mo@g19.example').token })).status, 200);
  assert.equal((await mo.get('/export/full')).status, 403, 'a member is refused');
  const admin = await ana.post('/api-keys', { name: 'Backups', scope: 'admin' });
  const send = await ana.post('/api-keys', { name: 'Sending', scope: 'send' });
  assert.equal(admin.status, 200, JSON.stringify(admin.data));
  const key = (k: any) => ({ authorization: `Bearer ${k.data.key}` });
  assert.equal((await new Client().call('GET', '/export/full', undefined, key(admin))).status, 200, 'an admin key may');
  assert.equal((await new Client().call('GET', '/export/full', undefined, key(send))).status, 403, 'a send key may not');
  db.run("UPDATE accounts SET suspended_at=?, suspended_reason='test', plan='seedling', subscription_status='past_due' WHERE id=?", new Date().toISOString(), anaAcct);
  assert.equal((await ana.get('/export/full')).status, 200, 'paused and unpaid');
  db.run('UPDATE accounts SET suspended_at=NULL, suspended_reason=NULL, subscription_status=NULL WHERE id=?', anaAcct);
});

test('2. a large account, or one that asks, is exported in the background: email, export.ready webhook, 7 days, then gone', async () => {
  const { exportDone } = await import('../src/server/exportfull.ts');
  const before = mailTo('ana@g19.example').length;
  const r = await ana.get('/export/full?background=1');
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.match(r.data.message, /email/);
  await exportDone(r.data.job.id);
  const jobs = (await ana.get('/export/full/jobs')).data.jobs;
  const j = jobs.find((x: any) => x.id === r.data.job.id);
  assert.equal(j.status, 'ready');
  const days = (Date.parse(j.expires_at) - Date.now()) / 864e5;
  assert.ok(days > 6.9 && days <= 7, 'valid 7 days');
  const mail = mailTo('ana@g19.example').slice(before).find((m: any) => m.subject === 'Your GrowSigning export is ready');
  assert.ok(mail, 'emailed');
  assert.ok(!mail.html.includes('/download'), 'the email links to the signed-in page, never to the file');
  assert.ok(db.get("SELECT 1 x FROM webhook_deliveries WHERE webhook_id='wh_g19test' AND event='export.ready'"), 'export.ready fired');
  const dl = await ana.get(j.download_url.replace(/^\/api/, ''));
  assert.equal(dl.status, 200);
  assert.ok(open(dl.data).has('data.json'));
  // Someone from another account cannot download it, even with its id.
  const eve = await signUp('Eve Else', 'eve@g19.example', '198.51.100.3');
  assert.equal((await eve.get(j.download_url.replace(/^\/api/, ''))).status, 404);
  // After 7 days the timer deletes the file, and the page says so in words.
  db.run('UPDATE full_exports SET expires_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), j.id);
  await cron.tick();
  const gone = await ana.get(j.download_url.replace(/^\/api/, ''));
  assert.equal(gone.status, 410);
  assert.match(gone.data.error, /deleted from the server 7 days after/);
  assert.ok(!fs.readdirSync(path.join(process.env.DATA_DIR!, 'exports')).some((f) => f.startsWith(j.id)));
});

test('1. the schema is published and the webhook is documented', async () => {
  const r = await new Client().get('/public/export-schema/v1');
  assert.equal(r.status, 200);
  assert.equal(r.data.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const { WEBHOOK_EVENTS } = await import('../src/server/webhooks.ts');
  assert.ok(WEBHOOK_EVENTS.includes('export.ready'));
});

// ---- 3. Our own export into a fresh account on another server ----------------------------------------------------

let ben: Client;
let report: any;
test('3. a round trip into a fresh account brings equal data in, with the ids mapped and listed', async () => {
  // Another server: the export says it came from there. (One test database plays both servers.)
  const data = JSON.parse(open(exportBytes).get('data.json')!.toString());
  ben = await signUp('Ben Newhome', 'ben@g19.example', '198.51.100.4');
  const r = await sendZip(ben, '/import/full', exportBytes);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  report = r.data;
  const benAcct = (await ben.get('/me')).data.account.id;
  // Templates, drafts, contacts, groups and plain settings are working things here.
  assert.equal(report.imported.templates, 1, JSON.stringify(report.ids) + JSON.stringify(data.templates.map((t: any) => t.subject)));
  assert.equal(report.imported.drafts, 1);
  assert.equal(report.imported.contacts, data.contacts.length, 'every contact (people sent to become contacts too)');
  assert.equal(report.imported.signing_groups, 1);
  assert.deepEqual(report.settings.sort(), ['Brand colour', 'Deadline', 'Reminders']);
  const acct = db.get('SELECT brand_color, default_reminder_days, retention_days FROM accounts WHERE id=?', benAcct);
  assert.equal(acct.brand_color, '#1f6f4a');
  assert.equal(acct.retention_days ?? null, null, 'a deletion schedule is never switched on by an import');
  assert.ok(report.not_imported.some((n: any) => n.name === 'Deletion schedule'));
  // The template: same subject, documents with the same bytes, the same people and fields, its lock and folder.
  const tMap = report.ids.find((x: any) => x.kind === 'template');
  assert.equal(tMap.from, made.template);
  const was = data.templates[0];
  const now = (await ben.get(`/envelopes/${tMap.to}`)).data.envelope;
  assert.equal(now.kind, 'template');
  assert.equal(now.subject, was.subject);
  assert.equal(now.documents[0].sha256, was.documents[0].file_sha256);
  assert.deepEqual(now.recipients.map((r: any) => [r.role, r.role_name]), was.recipients.map((r: any) => [r.role, r.role_name]));
  const shape = (fs: any[]) => fs.map((f) => [f.type, f.label ?? null, f.page, f.x, f.y, f.w, f.h]).sort();
  assert.deepEqual(shape(now.fields), shape(was.fields));
  const row = db.get('SELECT tpl_use, tpl_locked, folder FROM envelopes WHERE id=?', tMap.to);
  assert.deepEqual({ ...row }, { tpl_use: 'admins', tpl_locked: 1, folder: 'HR' });
  assert.ok(db.get("SELECT note FROM import_marks WHERE local_id=? AND kind='template'", tMap.to).note.startsWith('Imported from test.local'));
  // Groups and contacts.
  assert.deepEqual((await ben.get('/groups')).data.groups.map((g: any) => [g.name, g.members.map((m: any) => m.email)]), [['Front desk', ['lee1@g19.example', 'lee2@g19.example']]]);
  assert.ok(db.get('SELECT 1 x FROM contacts WHERE account_id=? AND email=?', benAcct, 'kim@g19.example'));
  // The completed and the declined envelopes are archived records with their data as it was exported.
  const recs = (await ben.get('/imported')).data.records;
  assert.equal(recs.length, 2);
  for (const id of [made.done.id, made.no.id]) {
    const rec = recs.find((x: any) => x.source_id === id);
    const one = (await ben.get(`/imported/${rec.id}`)).data.record;
    const src = data.envelopes.find((e: any) => e.id === id);
    const { chain_check, ...kept } = one.data;
    assert.deepEqual(kept, src, 'the record holds exactly what was exported');
    assert.equal(chain_check.ok, true);
    assert.equal(one.chain_ok, true);
    assert.match(one.banner, /^Imported on \d+ \w+ \d{4} from an export that says it was made on test\.local; chain verified\.$/);
  }
  const doneRec = recs.find((x: any) => x.source_id === made.done.id);
  const pdf = doneRec.files.find((f: any) => f.kind === 'signed');
  assert.equal(pdf.sha256, data.envelopes.find((e: any) => e.id === made.done.id).signed_pdf.sha256);
  const got = await ben.get(`/imported/${doneRec.id}/files/${pdf.sha256}`);
  assert.equal(sha256(got.data), pdf.sha256, 'the signed PDF comes back byte for byte');
  // They are not envelopes here: nothing counted, nothing listed as sent.
  assert.equal(db.get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND status!='draft'", benAcct).n, 0);
  // Every id is listed with what it became.
  for (const k of ['template', 'draft', 'contact', 'signing_group', 'envelope']) assert.ok(report.ids.some((x: any) => x.kind === k), k);
  // What does not come in is named: members, the webhook, and why.
  assert.ok(report.not_imported.some((n: any) => n.what === 'Webhook' && /new signing secret/.test(n.why)));
  assert.ok(report.not_imported.some((n: any) => n.what === 'Team member' && n.name.includes('ana@g19.example') && /Invite them/.test(n.why)));
});

test('3. out-for-signature envelopes are refused with a list, and bringing the same file in again adds nothing', async () => {
  assert.deepEqual(report.refused_out_for_signature.map((x: any) => [x.id, x.subject]), [[made.out.id, 'Still out']]);
  const again = await sendZip(ben, '/import/full', exportBytes);
  assert.equal(again.status, 200);
  assert.deepEqual(again.data.imported, { }, 'nothing twice');
  assert.equal((await ben.get('/imported')).data.records.length, 2);
  // Once it is finished where it started, a new export brings just that one.
  assert.equal((await signAll(made.out.id, 'olu@g19.example')).status, 200);
  const later = (await ana.get('/export/full')).data;
  const third = await sendZip(ben, '/import/full', later);
  assert.equal(third.status, 200, JSON.stringify(third.data));
  assert.equal(third.data.imported.archived_records, 1);
  assert.deepEqual(third.data.refused_out_for_signature, []);
});

test('3. every chain is worked out again on the way in: a changed line is "not verified", a changed file refuses the import', async () => {
  const z = open(exportBytes);
  const data = JSON.parse(z.get('data.json')!.toString());
  const e = data.envelopes.find((x: any) => x.id === made.done.id);
  e.audit.events[1].detail = `${e.audit.events[1].detail} (changed)`;
  // The forger also rewrites the manifest, so only the chain can tell.
  const entries = [...z].filter(([n]) => n !== 'manifest-sha256.txt' && n !== 'data.json').map(([name, data]) => ({ name, data }));
  entries.push({ name: 'data.json', data: Buffer.from(JSON.stringify(data)) });
  entries.push({ name: 'manifest-sha256.txt', data: Buffer.from(entries.map((x) => `${sha256(x.data)}  ${x.name}`).join('\n')) });
  const cara = await signUp('Cara Check', 'cara@g19.example', '198.51.100.5');
  const r = await sendZip(cara, '/import/full', await zipOf(entries));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rec = r.data.records.find((x: any) => x.chain_ok === false);
  assert.ok(rec, 'the changed one is marked');
  assert.match(rec.banner, /chain not verified\.$/);
  const one = (await cara.get(`/imported/${rec.id}`)).data.record;
  assert.match(one.data.chain_check.why, /Line \d+ .* was changed after it was written/);
  // A file changed after the export, without touching the manifest: the whole import is refused, nothing changed.
  const bad = [...z].map(([name, data]) => ({ name, data: name === 'data.json' ? Buffer.from(z.get('data.json')!.toString().replace('Lease, completed', 'Lease, completed!')) : data }));
  const dan = await signUp('Dan Damaged', 'dan@g19.example', '198.51.100.6');
  const r2 = await sendZip(dan, '/import/full', await zipOf(bad));
  assert.equal(r2.status, 400);
  assert.match(r2.data.error, /data\.json has changed since the export was made/);
  assert.equal((await dan.get('/imported')).data.records.length, 0);
  // Not a ZIP, a ZIP without data.json, a schema mismatch: each refused in words.
  assert.match((await sendZip(dan, '/import/full', Buffer.from('hello'))).data.error, /Choose the one ZIP file/);
  assert.match((await sendZip(dan, '/import/full', await zipOf([{ name: 'x.txt', data: Buffer.from('x') }]))).data.error, /no data\.json/);
  const wrong = await zipOf([{ name: 'data.json', data: Buffer.from('{"schema":"growsigning-export","schema_version":2}') }]);
  assert.match((await sendZip(dan, '/import/full', wrong)).data.error, /does not match the published schema/);
});

test('3. attacks: a forged export cannot open up a template, switch on deletion, add people, or bring in its own account', async () => {
  const z = open(exportBytes);
  const data = JSON.parse(z.get('data.json')!.toString());
  data.templates[0].rules = { use: 'team', change: 'team', locked: false, chosen: [] };
  data.account.settings = { ...data.account.settings, retention_days: 30, retention_level: 'everything', min_password_length: 4, plan: 'business', trusted_at: '2026-01-01T00:00:00Z' };
  data.templates[0].recipients[0].access_code = '9999';
  const entries = [...z].filter(([n]) => n !== 'manifest-sha256.txt' && n !== 'data.json').map(([name, d]) => ({ name, data: d }));
  entries.push({ name: 'data.json', data: Buffer.from(JSON.stringify(data)) });
  entries.push({ name: 'manifest-sha256.txt', data: Buffer.from(entries.map((x) => `${sha256(x.data)}  ${x.name}`).join('\n')) });
  const fay = await signUp('Fay Forged', 'fay@g19.example', '198.51.100.7');
  const fayAcct = (await fay.get('/me')).data.account.id;
  const r = await sendZip(fay, '/import/full', await zipOf(entries));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = db.get('SELECT plan, trusted_at, retention_days, min_password_length FROM accounts WHERE id=?', fayAcct);
  assert.equal(a.retention_days ?? null, null);
  assert.equal(a.trusted_at ?? null, null);
  assert.notEqual(a.plan, 'business');
  assert.ok(!a.min_password_length || a.min_password_length >= 8);
  assert.equal(db.get('SELECT COUNT(*) n FROM memberships WHERE account_id=?', fayAcct).n, 1, 'nobody was added to the team');
  const t = r.data.ids.find((x: any) => x.kind === 'template').to;
  assert.equal(db.get('SELECT access_code FROM recipients WHERE envelope_id=?', t).access_code ?? null, null);
  // The same account's own export is refused.
  const own = await sendZip(ana, '/import/full', exportBytes);
  assert.equal(own.status, 400);
  assert.match(own.data.error, /same account/);
  // A member cannot import at all.
  const gus = new Client();
  gus.ip = '198.51.100.8';
  await ana.post('/account/invites', { email: 'gus@g19.example', role: 'member' });
  await gus.post('/auth/signup', { name: 'Gus Member', email: 'gus@g19.example', password: 'correct horse battery', invite: db.get('SELECT token FROM invites WHERE email=?', 'gus@g19.example').token });
  assert.equal((await sendZip(gus, '/import/full', exportBytes)).status, 403);
  // Records of another account are not readable by id.
  const rec = (await ben.get('/imported')).data.records[0];
  assert.equal((await fay.get(`/imported/${rec.id}`)).status, 404);
  assert.equal((await fay.get(`/imported/${rec.id}/files/${rec.files[0].sha256}`)).status, 404);
});

// ---- 4. DocuSign's downloads (FIXTURES from the documented layouts, tests/fixtures/docusign) ------------------------

const FIX = path.resolve('tests/fixtures/docusign');
async function combinedPdf(guid: string, subject: string, status = 'Completed', certificate = true) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p1 = d.addPage([612, 792]);
  p1.drawText(`Docusign Envelope ID: ${guid}`, { x: 36, y: 770, size: 9, font: f });
  p1.drawText(subject, { x: 72, y: 700, size: 16, font: f });
  if (certificate) {
    const c = d.addPage([612, 792]);
    c.drawText('Certificate Of Completion', { x: 36, y: 740, size: 14, font: f });
    c.drawText(`Envelope Id: ${guid.replace(/-/g, '')}`, { x: 36, y: 710, size: 10, font: f });
    c.drawText(`Subject: ${subject}`, { x: 36, y: 695, size: 10, font: f });
    c.drawText(`Status: ${status}`, { x: 36, y: 680, size: 10, font: f });
  }
  return Buffer.from(await d.save());
}
const sendFiles = (c: Client, files: { name: string; data: Uint8Array; type?: string }[]) => {
  const f = new FormData();
  for (const x of files) f.append('file', new Blob([new Uint8Array(x.data)], { type: x.type || 'application/octet-stream' }), x.name);
  return c.call('POST', '/import/docusign', f);
};

let dora: Client;
let doraRecs: any[];
test('4. DocuSign PDFs and the envelope CSV come in as archived records with the banner, matched by envelope ID', async () => {
  dora = await signUp('Dora Docusign', 'dora@g19.example', '198.51.100.9');
  const lease = await combinedPdf('3F2504E0-4F89-11D3-9A0C-0305E82C3301', 'Lease for Unit 4');
  const out = await combinedPdf('7C9E6679-7425-40DE-944B-E07FC1F90AE7', 'Contractor agreement, still out', 'Sent');
  const bare = await combinedPdf('11111111-2222-4333-8444-555555555555', 'Signed elsewhere, no certificate', 'Completed', false);
  const csv = fs.readFileSync(path.join(FIX, 'envelopes.csv'));
  const r = await sendFiles(dora, [{ name: 'Lease for Unit 4.pdf', data: lease }, { name: 'Contractor.pdf', data: out }, { name: 'bare.pdf', data: bare }, { name: 'envelopes.csv', data: csv }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.imported.archived_records, 2);
  doraRecs = (await dora.get('/imported')).data.records;
  const rec = doraRecs.find((x: any) => x.subject === 'Lease for Unit 4');
  const one = (await dora.get(`/imported/${rec.id}`)).data.record;
  assert.match(one.banner, /^Imported from DocuSign on \d+ \w+ \d{4}\. Signed there, not here\. Its evidence is DocuSign's certificate inside the file\.$/);
  assert.equal(one.source, 'docusign');
  assert.equal(one.chain_ok, null, 'no chain is claimed for it');
  assert.equal(one.data.docusign_envelope_id, '3F2504E0-4F89-11D3-9A0C-0305E82C3301');
  assert.deepEqual(one.data.recipients.map((p: any) => p.email), ['tom@fixture.example', 'lia@fixture.example']);
  assert.deepEqual(one.data.sender, { name: 'Rosa Sender', email: 'rosa@fixture.example' });
  assert.equal(one.data.certificate_in_file, true);
  assert.equal(sha256((await dora.get(`/imported/${rec.id}/files/${one.files[0].sha256}`)).data), sha256(lease), 'the PDF is kept exactly as it came');
  // Without DocuSign's certificate in the file, the banner does not point at one.
  const nb = (await dora.get(`/imported/${doraRecs.find((x: any) => x.subject === 'bare').id}`)).data.record;
  assert.match(nb.banner, /No DocuSign certificate was found inside this file/);
  // Not completed there: not brought in. A CSV row with no PDF: listed.
  assert.ok(r.data.not_imported.some((n: any) => /still out/.test(n.name) && /not completed/.test(n.why)));
  assert.ok(r.data.not_imported.some((n: any) => n.name === 'Form with no PDF downloaded' && /its PDF was not among the files/.test(n.why)));
  // Never counted as signed here: no envelope, nothing on reports.
  const acct = (await dora.get('/me')).data.account.id;
  assert.equal(db.get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope'", acct).n, 0);
  // The same PDF again adds nothing.
  const again = await sendFiles(dora, [{ name: 'Lease.pdf', data: lease }]);
  assert.ok(again.data.not_imported.some((n: any) => /brought in before/.test(n.why)));
  assert.equal((await dora.get('/imported')).data.records.length, 2);
});

test('4. /verify on an imported file: never "completed here", says where it was signed', async () => {
  const lease = await combinedPdf('3F2504E0-4F89-11D3-9A0C-0305E82C3301', 'Lease for Unit 4');
  const f = new FormData();
  f.append('file', new Blob([new Uint8Array(lease)], { type: 'application/pdf' }), 'x.pdf');
  const v = (await new Client().call('POST', '/public/verify', f)).data;
  assert.equal(v.match, false, 'not a document completed here');
  assert.equal(v.imported.source, 'docusign');
  assert.ok(!JSON.stringify(v).includes('Dora') && !JSON.stringify(v).includes('dora@'), 'nothing about the account that holds it');
  // Our own export's signed PDF, brought in elsewhere, still matches the original envelope where it was completed.
  const data = JSON.parse(open(exportBytes).get('data.json')!.toString());
  const sha = data.envelopes.find((e: any) => e.id === made.done.id).signed_pdf.sha256;
  const g = new FormData();
  g.append('file', new Blob([new Uint8Array(open(exportBytes).get(`files/${sha}`)!)], { type: 'application/pdf' }), 'y.pdf');
  assert.equal((await new Client().call('POST', '/public/verify', g)).data.match, true, 'it was completed on this server, so it is its own match');
});

test('4. a DocuSign template is mapped to our fields where they match, and the rest is listed as not imported', async () => {
  const tpl = fs.readFileSync(path.join(FIX, 'template-volunteer.json'));
  const r = await sendFiles(dora, [{ name: 'template-volunteer.json', data: tpl, type: 'application/json' }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.imported.templates, 1, JSON.stringify(r.data.not_imported));
  const t = (await dora.get(`/envelopes/${r.data.ids.find((x: any) => x.kind === 'template').to}`)).data.envelope;
  assert.equal(t.kind, 'template');
  assert.equal(t.subject, 'Please sign the volunteer agreement');
  assert.deepEqual(t.recipients.map((x: any) => [x.role, x.role_name]), [['signer', 'Volunteer'], ['cc', 'Coordinator']]);
  assert.deepEqual(t.fields.map((f: any) => f.type).sort(), ['checkbox', 'date_signed', 'dropdown', 'signature', 'text']);
  const sig = t.fields.find((f: any) => f.type === 'signature');
  assert.ok(Math.abs(sig.x - 150 / 612) < 1e-6 && Math.abs(sig.y - 180 / 792) < 1e-6, 'placed where DocuSign had it, as a share of the page');
  assert.equal(t.fields.find((f: any) => f.type === 'text').required, 0, 'an optional tab stays optional');
  assert.deepEqual(t.fields.find((f: any) => f.type === 'dropdown').options, ['S', 'M', 'L']);
  const why = r.data.not_imported.map((n: any) => n.why).join(' | ');
  assert.match(why, /1 formula field:/);
  assert.match(why, /1 approval field:/);
  assert.match(why, /1 person who can change the document:/);
  assert.ok(!/1 \w+ fields|recipients of the kind/.test(why), 'one is said as one, in plain words');
  assert.ok(db.get("SELECT note FROM import_marks WHERE local_id=? AND source='docusign'", t.id).note.startsWith('Imported from DocuSign on'));
  // A file that is none of these is refused in words; a template without its PDF is listed.
  const nodoc = JSON.parse(tpl.toString());
  nodoc.envelopeTemplateId = 'other';
  delete nodoc.documents[0].documentBase64;
  const r2 = await sendFiles(dora, [{ name: 'nodoc.json', data: Buffer.from(JSON.stringify(nodoc)) }, { name: 'notes.txt', data: Buffer.from('hello') }]);
  assert.equal(r2.status, 200);
  assert.ok(r2.data.not_imported.some((n: any) => n.what === 'Template document' && /holds no PDF/.test(n.why)));
  assert.ok(r2.data.not_imported.some((n: any) => n.name === 'notes.txt'));
  // The same template again adds nothing.
  const r3 = await sendFiles(dora, [{ name: 'template-volunteer.json', data: tpl }]);
  assert.equal(r3.data.imported.templates ?? 0, 0);
});

test('4. a ZIP of DocuSign downloads works the same; a damaged one, an empty upload and a stray file are refused in words', async () => {
  const eli = await signUp('Eli Zip', 'eli@g19.example', '198.51.100.10');
  const z = await zipOf([{ name: 'downloads/Lease.pdf', data: await combinedPdf('3F2504E0-4F89-11D3-9A0C-0305E82C3301', 'Lease for Unit 4') }, { name: 'downloads/envelopes.csv', data: fs.readFileSync(path.join(FIX, 'envelopes.csv')) }]);
  const r = await sendFiles(eli, [{ name: 'docusign.zip', data: z, type: 'application/zip' }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.imported.archived_records, 1);
  const broken = Buffer.from(z.subarray(0, z.length - 30));
  const b = await sendFiles(eli, [{ name: 'broken.zip', data: broken }]);
  assert.equal(b.status, 400);
  assert.match(b.data.error, /could not be opened as a ZIP file/);
  assert.match((await eli.call('POST', '/import/docusign', new FormData())).data.error, /Choose the file/);
  const nothing = await sendFiles(eli, [{ name: 'x.bin', data: Buffer.from([1, 2, 3]) }]);
  assert.equal(nothing.status, 200);
  assert.ok(nothing.data.not_imported.some((n: any) => n.name === 'x.bin'));
});

test('3-4. records brought in are in the next full export, can be deleted, and their files leave the disk', async () => {
  const data = JSON.parse(open((await dora.get('/export/full')).data).get('data.json')!.toString());
  assert.deepEqual(checkSchema(schema, data, 50), []);
  assert.equal(data.imported.length, 2);
  assert.ok(data.imported.every((r: any) => r.banner.startsWith('Imported from DocuSign')));
  // Into a fourth account: they keep their banner and say where they moved from.
  const fin = await signUp('Fin Fourth', 'fin@g19.example', '198.51.100.11');
  const moved = await sendZip(fin, '/import/full', (await dora.get('/export/full')).data);
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const recs = (await fin.get('/imported')).data.records;
  assert.ok(recs.every((r: any) => /^Imported on .* from an export that says it was made on test\.local, where it had been brought in from DocuSign\. It was not signed here\./.test(r.banner)), JSON.stringify(recs.map((r: any) => r.banner)));
  assert.ok(recs.every((r: any) => r.chain_ok === null));
  // Deleting a record takes its file off the disk once nothing else holds it.
  const rec = recs[0];
  const sha = rec.files[0].sha256;
  assert.equal((await fin.call('DELETE', `/imported/${rec.id}`)).status, 200);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR!, 'blobs', sha)), 'Dora still holds the same file');
  for (const x of (await dora.get('/imported')).data.records.filter((x: any) => x.files[0].sha256 === sha)) await dora.call('DELETE', `/imported/${x.id}`);
  await cron.tick();
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR!, 'blobs', sha)), 'gone once nobody holds it');
});

// ---- Repair (tests/out/verify-g19, tests/out/ux-g19): what an uploaded file says is never this server's own mark ----

/** A forged export: another server's name, a new signed PDF, rewritten names, the chain worked out again by the public formula. */
async function forgedExport(opts: { url: string; carried?: any[] }) {
  const z = open(exportBytes);
  const data = JSON.parse(z.get('data.json')!.toString());
  data.deployment.url = opts.url;
  data.account.id = 'acc_forged';
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawText('The mayor agrees to pay 1,000,000', { x: 72, y: 700 });
  const fake = Buffer.from(await d.save());
  const env = data.envelopes.find((x: any) => x.status === 'completed');
  env.id = `env_forged_${Math.random().toString(36).slice(2, 8)}`;
  env.signed_pdf.sha256 = sha256(fake);
  env.evidence_pack = null;
  let prev = '';
  for (const a of env.audit.events) {
    a.actor = String(a.actor).replace(/Sam[^,<]*/g, 'Jane Doe, Mayor');
    a.prev_hash = prev;
    a.hash = sha256(JSON.stringify([prev, env.id, a.at, a.actor, a.action, a.detail, a.ip || '']));
    prev = a.hash;
  }
  env.audit.chain.head = prev;
  const out = new Map<string, Uint8Array>();
  for (const [k, v] of z) if (k !== 'manifest-sha256.txt' && !k.startsWith('evidence/')) out.set(k, v);
  out.set(`files/${sha256(fake)}`, fake);
  const extra: Buffer[] = [];
  data.imported = (opts.carried || []).map((r) => {
    if (r.file) (out.set(`files/${sha256(r.file)}`, r.file), extra.push(r.file));
    const { file, ...rest } = r;
    return { ...rest, files: file ? [{ sha256: sha256(file), name: 'board.pdf', kind: 'signed' }] : [] };
  });
  out.set('data.json', Buffer.from(JSON.stringify(data)));
  const entries = [...out].map(([name, x]) => ({ name, data: x }));
  entries.push({ name: 'manifest-sha256.txt', data: Buffer.from(entries.map((x) => `${sha256(x.data)}  ${x.name}`).join('\n')) });
  return { zip: await zipOf(entries), fake, subject: env.subject };
}
const verifyFile = (bytes: Uint8Array) => {
  const f = new FormData();
  f.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'v.pdf');
  return new Client().call('POST', '/public/verify', f);
};

test('repair: a forged export naming growsigning.com is marked only as what the file says, and /verify vouches for nothing', async () => {
  const gus = await signUp('Gus Forger', 'forger@g19-repair.example', '198.51.100.20');
  const { zip, fake, subject } = await forgedExport({ url: 'https://growsigning.com' });
  const r = await sendZip(gus, '/import/full', zip);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rec = (await gus.get('/imported')).data.records.find((x: any) => x.subject === subject && x.files.some((f: any) => f.sha256 === sha256(fake)));
  assert.ok(rec);
  assert.ok(!/^Imported from growsigning\.com/.test(rec.banner), rec.banner);
  assert.match(rec.banner, /from an export that says it was made on growsigning\.com/);
  // What chain verified means is said where it is shown: agreement inside the file, not origin.
  const { CHAIN_MEANS } = await import('../src/lib/exportfull.ts');
  assert.match(CHAIN_MEANS, /does not show where the export came from or that it is genuine/);
  // /verify: the forged PDF is "uploaded here", with no chain mark and no claim it is genuine.
  const v = (await verifyFile(fake)).data;
  assert.equal(v.match, false);
  assert.equal(v.imported.source, 'growsigning');
  assert.ok(!('chain_ok' in v.imported), 'no chain mark goes to the public');
  const { verifyImportedWords } = await import('../src/lib/exportfull.ts');
  const w = verifyImportedWords(v.imported);
  assert.match(w.text, /cannot tell whether that export is genuine/);
  assert.ok(!/history was checked|chain|verified/i.test(w.title + w.text), w.text);
  // A deployment that is not a web address is not repeated as if it were one.
  const hal = await signUp('Hal Words', 'hal@g19-repair.example', '198.51.100.21');
  const odd = await forgedExport({ url: 'growsigning.com, checked by the State' });
  assert.equal((await sendZip(hal, '/import/full', odd.zip)).status, 200);
  const b = (await hal.get('/imported')).data.records.map((x: any) => x.banner).join(' ');
  assert.ok(!/checked by the State/.test(b), b);
  assert.match(b, /a server it does not name/);
});

test('repair: a record carried over in an export never keeps its own banner or chain mark', async () => {
  const ida = await signUp('Ida Carried', 'ida@g19-repair.example', '198.51.100.22');
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawText('Board resolution', { x: 72, y: 700 });
  const file = Buffer.from(await d.save());
  const { zip } = await forgedExport({ url: 'https://other.example', carried: [
    { id: 'imp_x', source: 'docusign', source_deployment: null, source_id: 'X1', imported_at: new Date().toISOString(), subject: 'Board resolution', status: 'completed', chain_ok: true,
      banner: 'Signed on GrowSigning and verified by GrowSigning. This signature is legally valid.', data: {}, file },
    { id: 'imp_y', source: 'growsigning', source_deployment: 'https://third.example', source_id: 'Y1', imported_at: new Date().toISOString(), subject: 'No history', status: 'completed', chain_ok: true,
      banner: 'Verified.', data: {}, file },
  ] });
  const r = await sendZip(ida, '/import/full', zip);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const recs = (await ida.get('/imported')).data.records;
  const ds = recs.find((x: any) => x.subject === 'Board resolution');
  assert.ok(!/legally valid|verified by GrowSigning/.test(ds.banner), ds.banner);
  assert.match(ds.banner, /^Imported on .* from an export that says it was made on other\.example, where it had been brought in from DocuSign\./);
  assert.equal(ds.chain_ok, null, 'a DocuSign record never has a chain');
  const gs = recs.find((x: any) => x.subject === 'No history');
  assert.equal(gs.chain_ok, false, 'a chain is only verified when it is worked out here');
  assert.match(gs.banner, /chain not verified\.$/);
});

test('repair: a PDF with nothing of DocuSign in it is not brought in, and /verify knows nothing of it', async () => {
  const jo = await signUp('Jo Holiday', 'jo@g19-repair.example', '198.51.100.23');
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawText('Holiday photo scan', { x: 72, y: 700 });
  const plain = Buffer.from(await d.save());
  const r = await sendFiles(jo, [{ name: 'Holiday photo scan.pdf', data: plain }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.imported, {});
  assert.ok(r.data.not_imported.some((n: any) => n.name === 'Holiday photo scan.pdf' && /no DocuSign envelope ID and no DocuSign certificate/.test(n.why)));
  assert.equal((await jo.get('/imported')).data.records.length, 0);
  assert.equal((await verifyFile(plain)).data.imported, null);
  // One with an envelope ID but no certificate and no CSV: in, without a status and without "signed there".
  const bare = await combinedPdf('22222222-3333-4444-8555-666666666666', 'Unknown state', 'Completed', false);
  const b = await sendFiles(jo, [{ name: 'bare.pdf', data: bare }]);
  assert.equal(b.data.imported.archived_records, 1);
  const rec = (await jo.get('/imported')).data.records[0];
  assert.equal(rec.status, null);
  assert.ok(!/Signed there/.test(rec.banner), rec.banner);
  assert.match(rec.banner, /nothing here shows whether or how it was signed/);
  // The public words for a DocuSign upload say nothing was checked.
  const { verifyImportedWords } = await import('../src/lib/exportfull.ts');
  assert.match(verifyImportedWords({ source: 'docusign', from: null, imported_at: new Date().toISOString() }).text, /did not check whether or how it was signed/);
  // The screen's plain words for this case: nothing came in, and the list says why.
  const { importSaid } = await import('../src/lib/exportfull.ts');
  assert.match(importSaid(r.data), /^Nothing was brought in\. The list below says why/);
  const again = await sendFiles(jo, [{ name: 'bare.pdf', data: bare }]);
  assert.match(importSaid(again.data), /everything in it is here already/);
});

test('repair: a CSV row still out on DocuSign is told to wait, not to download its PDF', async () => {
  const kai = await signUp('Kai Csv', 'kai@g19-repair.example', '198.51.100.24');
  const r = await sendFiles(kai, [{ name: 'envelopes.csv', data: fs.readFileSync(path.join(FIX, 'envelopes.csv')) }]);
  const out = r.data.not_imported.find((n: any) => /still out/.test(n.name));
  assert.match(out.why, /It is still "Sent" on DocuSign, not completed\. Bring it in once it is completed there\./);
  assert.ok(r.data.not_imported.some((n: any) => n.name === 'Form with no PDF downloaded' && /its PDF was not among the files/.test(n.why)));
});

test('repair: a redacted line is passed over only when it really shows the removal', async () => {
  const { chainHolds } = await import('../src/server/importer.ts');
  const forged = { id: 'e', purged_at: 'X', audit: { events: [{ seq: 1, at: 'a', actor: 'x', action: 'signed', detail: 'anything', prev_hash: '', hash: 'h1', redacted_at: 'X' }], chain: { head: 'h1' } } };
  assert.equal(chainHolds(forged).ok, false);
  const real = { id: 'e', purged_at: 'X', audit: { events: [{ seq: 1, at: 'a', actor: 'x', action: 'signed', detail: 'Removed on 2026-11-21', prev_hash: '', hash: 'h1', redacted_at: 'X' }], chain: { head: 'h1' } } };
  assert.equal(chainHolds(real).ok, true);
});

test('repair: an upload without a Content-Length is stopped as soon as it is too large', async () => {
  const { readCapped } = await import('../src/server/importer.ts');
  let sent = 0;
  const body = new ReadableStream({ pull(c) {
    sent += 1000;
    if (sent > 50_000) return c.close();
    c.enqueue(new Uint8Array(1000));
  } });
  const req = new Request('http://x/import', { method: 'POST', body, duplex: 'half' } as any);
  await assert.rejects(readCapped(req, 5000), (e: any) => e.status === 413 && /larger than/.test(e.message));
  assert.ok(sent < 20_000, `stopped early, after ${sent} bytes`);
});

test('repair: direct full exports are limited per hour, with words; the count of records is for admins', async () => {
  const lu = await signUp('Lu Limit', 'lu@g19-repair.example', '198.51.100.25');
  const { EXPORTS_DIRECT_PER_HOUR } = await import('../src/lib/exportfull.ts');
  for (let i = 0; i < EXPORTS_DIRECT_PER_HOUR; i++) assert.equal((await lu.get('/export/full')).status, 200);
  const over = await lu.get('/export/full');
  assert.equal(over.status, 429);
  assert.match(over.data.error, /Nothing was changed\. Try again in an hour, or press Export everything/);
  assert.deepEqual((await lu.get('/imported/count')).data, { count: 0 });
  assert.equal((await dora.get('/imported/count')).data.count >= 1, true);
  assert.equal((await new Client().get('/imported/count')).status, 401);
});

test('repair: a page of documents brought in counts as Documents in the menu', async () => {
  const { navOn } = await import('../src/lib/nav.ts');
  assert.equal(navOn('/app/envelopes', '/app/imported'), true);
  assert.equal(navOn('/app/envelopes', '/app/envelopes/new'), false);
});
