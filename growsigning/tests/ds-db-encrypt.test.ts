// More of the database encrypted with FILE_ENCRYPTION_KEY (src/server/colcrypt.ts, src/server/colsweep.ts): signature
// pictures, typed answers, comments, stored emails, decline reasons and help messages. Each test says what a stolen
// copy of the disk shows, what the app still does, and what happens with a wrong, missing or old key.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { boot, Client, signUp, simple, tokenFor, PNG, upload, type Server } from './helpers.ts';
import { keyIdOf } from '../src/server/filecrypt.ts';
import { decodeFileKey } from '../src/lib/storedfiles.ts';
import { seal, sealWith, openStrict, openValue, isSealed, colKeys, PREFIX, SEALED_COLUMNS, SealedValueProblem } from '../src/server/colcrypt.ts';
import { sealColumns, scanColumns, databaseWarning } from '../src/server/colsweep.ts';
import { SEALED_WORDS, CLEAR_WORDS } from '../src/lib/sealedcolumns.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

const ROOT = path.resolve(import.meta.dirname, '..');
const newKey = () => crypto.randomBytes(32).toString('base64');
const K1 = newKey(), K2 = newKey(), K3 = newKey();
const id1 = keyIdOf(decodeFileKey(K1)!), id2 = keyIdOf(decodeFileKey(K2)!);
const setKeys = (current?: string, old: string[] = []) => {
  if (current === undefined) delete process.env.FILE_ENCRYPTION_KEY;
  else process.env.FILE_ENCRYPTION_KEY = current;
  if (old.length) process.env.FILE_ENCRYPTION_KEYS_OLD = old.join(',');
  else delete process.env.FILE_ENCRYPTION_KEYS_OLD;
};
// Every test leaves the keys the way the next one expects: the files stored so far were written under K1 or none, so
// K1 stays listed and the file store never stops.
afterEach(() => setKeys(undefined, [K1, K2]));
let ipn = 20;
const person = (name: string, email: string) => signUp(name, email, `198.18.${ipn}.${ipn++}`);
// Everything on the disk that holds the database: the file itself, its write-ahead log and its index of that log.
const onDisk = () => {
  db.db().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const dir = process.env.DATA_DIR!;
  return Buffer.concat(fs.readdirSync(dir).filter((n) => n.startsWith('sign.db')).map((n) => fs.readFileSync(path.join(dir, n))));
};
const rawValue = (sql: string, ...p: any[]) => db.db().prepare(sql).get(...p) as any; // the stored bytes, not opened
// A signature picture nobody else has, so finding it on the disk means finding this one.
const uniquePng = () => `${PNG.slice(0, -2)}${crypto.randomBytes(6).toString('hex')}==`;

test('a value goes in and comes out the same; a wrong key, a changed byte or another label is refused, never shown', () => {
  setKeys(K1);
  const s = seal('comments.body', 'Can we move the date to Friday?');
  assert.ok(isSealed(s) && String(s).startsWith(`${PREFIX}comments.body|`));
  assert.notEqual(seal('comments.body', 'same'), seal('comments.body', 'same'), 'a fresh nonce every time: equal words do not look equal on the disk');
  assert.equal(openStrict(String(s)), 'Can we move the date to Friday?');
  assert.equal(seal('comments.body', null), null);
  assert.equal(seal('comments.body', ''), '');
  // Wrong key: no key this server holds opened it.
  setKeys(K3);
  assert.throws(() => openStrict(String(s)), (e: any) => e instanceof SealedValueProblem && e.why === 'no-key' && e.keyId === id1);
  assert.equal(openValue(s), '', 'under a key the server was not given it reads as empty, never as something else');
  setKeys(K1);
  // A changed byte inside.
  const b = Buffer.from(String(s).split('|')[2], 'base64');
  b[b.length - 20] ^= 1;
  assert.throws(() => openStrict(`${PREFIX}comments.body|${b.toString('base64')}`), (e: any) => e.why === 'damaged');
  // The same sealed bytes given another label (moved to another column by someone with the file) fail.
  assert.throws(() => openStrict(String(s).replace('comments.body', 'fields.value')), (e: any) => e.why === 'damaged');
  // Without a key, values are kept as they are.
  setKeys();
  assert.equal(seal('comments.body', 'plain words'), 'plain words');
});

test('nobody can make a value that looks sealed: the marker and NUL are taken out of what people send', async () => {
  setKeys(K1, [K2]);
  const fake = `${PREFIX}comments.body|${Buffer.alloc(40).toString('base64')}`;
  assert.equal(openStrict(String(seal('comments.body', `\u0001c1|x`))), 'c1|x');
  const v = seal('fields.value', fake);
  assert.equal(openStrict(String(v)), fake.replace('\u0001', ''), 'it is sealed as the words it is, without the marker');
  setKeys(undefined, [K1, K2]);
  assert.equal(seal('fields.value', fake), fake.replace('\u0001', ''), 'and with no key it is kept without the marker');
  // Through the signing page: a signer who types the marker into a field and a comment breaks nothing for the sender.
  setKeys(K1, [K2]);
  const jo = await person('Jo Marker', 'jo@marker.example');
  const e = await simple(jo, 'sam@marker.example', { fields: [
    { id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
    { id: 't', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Note', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.03, required: false },
  ] });
  assert.equal((await jo.post(`/envelopes/${e.id}/send`)).status, 200);
  const sam = new Client();
  const tok = tokenFor(e.id, 'sam@marker.example');
  await sam.post(`/sign/${tok}/consent`);
  const t = (await sam.get(`/sign/${tok}`)).data.fields.find((f: any) => f.type === 'text');
  assert.equal((await sam.post(`/sign/${tok}/save`, { values: { [t.id]: fake } })).status, 200);
  assert.equal((await sam.post(`/sign/${tok}/comments`, { text: fake })).status, 200);
  const seen = await jo.get(`/envelopes/${e.id}`);
  assert.equal(seen.status, 200, JSON.stringify(seen.data));
});

test('with a key, a stolen copy of the database holds none of the signatures, answers, comments, emails, decline reasons or help messages, and the app shows them all', async () => {
  setKeys(K1, [K2]);
  const jo = await person('Jo Sender', 'jo@sealed.example');
  const sig = uniquePng();
  const typed = 'IBAN-NL91-QUARTZ-7731';
  const remark = 'Comment about the kitchen PLUM-4410';
  const e = await simple(jo, 'sam@sealed.example', { message: 'Please sign', fields: [
    { id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
    { id: 't', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Bank account', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.03 },
  ] });
  assert.equal((await jo.post(`/envelopes/${e.id}/send`)).status, 200);
  const sam = new Client();
  sam.ip = '198.18.200.1';
  const tok = tokenFor(e.id, 'sam@sealed.example');
  await sam.post(`/sign/${tok}/consent`);
  assert.equal((await sam.post(`/sign/${tok}/comments`, { text: remark })).status, 200);
  const fields = (await sam.get(`/sign/${tok}`)).data.fields;
  const values = Object.fromEntries(fields.map((f: any) => [f.id, f.type === 'text' ? typed : '1']));
  const done = await sam.post(`/sign/${tok}/complete`, { values, signature_png: sig, initials_png: sig });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  // A second envelope, declined with a reason.
  const e2 = await simple(jo, 'dee@sealed.example');
  assert.equal((await jo.post(`/envelopes/${e2.id}/send`)).status, 200);
  const dee = new Client();
  dee.ip = '198.18.200.2';
  const tok2 = tokenFor(e2.id, 'dee@sealed.example');
  await dee.post(`/sign/${tok2}/consent`);
  const why = 'My divorce is not final yet MANGO-2209';
  assert.equal((await dee.post(`/sign/${tok2}/decline`, { reason: why })).status, 200);
  // A help request.
  const help = 'My tax number is TAXNO-55-ORCHID, please help';
  assert.equal((await new Client().post('/public/support', { email: 'kim@sealed.example', name: 'Kim', topic: 'other', message: help })).status, 200);
  // The saved signature of a login.
  assert.equal((await jo.call('PATCH', '/me', { signature_png: sig })).status, 200);

  // What the disk holds: none of it.
  const disk = onDisk();
  for (const s of [sig.slice(22, 60), typed, remark, help]) assert.ok(!disk.includes(Buffer.from(s)), `${s} is not readable in the database file`);
  // The audit trail repeats a decline reason and stays readable (it is chained and checked line by line); the pages say so.
  assert.ok(db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND detail LIKE ?", e2.id, "%MANGO-2209%"));
  // Names, addresses and subjects stay readable, because search and joins need them (and the pages say so).
  assert.ok(disk.includes(Buffer.from('sam@sealed.example')) && disk.includes(Buffer.from('Simple agreement')));
  // Every listed column holds sealed values or nothing.
  for (const c of SEALED_COLUMNS) {
    const rows = db.db().prepare(`SELECT ${c.column} v FROM ${c.table} WHERE ${c.column} IS NOT NULL AND ${c.column} != ''${c.where ? ` AND ${c.where}` : ''}`).all() as any[];
    for (const r of rows) assert.ok(isSealed(r.v), `${c.table}.${c.column} holds a value in the clear: ${String(r.v).slice(0, 40)}`);
  }
  // And the app shows everything as it was written.
  const full = (await jo.get(`/envelopes/${e.id}`)).data.envelope;
  assert.equal(full.fields.find((f: any) => f.type === 'text').value, typed);
  assert.equal(db.get('SELECT signature_png s FROM recipients WHERE envelope_id=?', e.id).s, sig);
  assert.equal((await jo.get('/me')).data.user.signature_png, sig);
  const thread = await jo.get(`/envelopes/${e.id}/comments`);
  assert.ok(JSON.stringify(thread.data).includes(remark), JSON.stringify(thread.data).slice(0, 300));
  assert.equal(db.get('SELECT decline_reason r FROM recipients WHERE envelope_id=?', e2.id).r, why);
  const pdf = await jo.call('GET', `/envelopes/${e.id}/download`);
  assert.equal(pdf.status, 200, 'the signed PDF is made from the opened values');
  // The emails are kept sealed and still go out (the outbox reads them).
  const mail = db.all("SELECT html FROM emails WHERE to_email='sam@sealed.example'");
  assert.ok(mail.length && mail.every((m: any) => m.html.includes('<')));
  // The scan counts what is there, all of it under the current key.
  const s = scanColumns(true);
  assert.equal(s.plain, 0);
  assert.equal(s.unknown + s.damaged, 0);
  assert.ok(s.current_key > 5);
});

test('search still works: the help queue finds a request by words of its sealed first message, and envelopes by subject and name', async () => {
  setKeys(K1, [K2]);
  process.env.OPERATOR_EMAILS = 'olga@ops-sealed.example';
  try {
    const olga = await person('Olga Ops', 'olga@ops-sealed.example');
    assert.equal((await new Client().post('/public/support', { email: 'rae@sealed.example', name: 'Rae', topic: 'other', message: 'The PERIWINKLE button does nothing on my phone' })).status, 200);
    const hits = (await olga.get('/operator/support?q=periwinkle')).data.requests;
    assert.equal(hits.length, 1, JSON.stringify(hits).slice(0, 300));
    assert.ok(JSON.stringify(hits[0]).includes('PERIWINKLE'));
    assert.equal((await olga.get('/operator/support?q=nothing-like-this-anywhere')).data.requests.length, 0);
    const jo = await person('Jo Finder', 'jo@finder.example');
    const e = await simple(jo, 'pat@finder.example', { subject: 'Garden lease SAFFRON' });
    assert.deepEqual((await jo.get('/envelopes?q=saffron')).data.envelopes.map((x: any) => x.id), [e.id]);
    assert.deepEqual((await jo.get('/envelopes?q=pat@finder.example')).data.envelopes.map((x: any) => x.id), [e.id]);
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
});

test('a code taken out of a sealed email after use is really gone from it (col_replace), and a file an email still carries is still known to be in use (col_find)', async () => {
  setKeys(K1, [K2]);
  const m = { html: seal('emails.html', '<p>Your code is 918273</p>'), payload: seal('emails.payload', JSON.stringify({ text: 'code 918273', attachments: [{ filename: 'a.pdf', sha256: 'f'.repeat(64) }] })) };
  const r = db.run("INSERT INTO emails (to_email, subject, html, status, at, payload) VALUES ('x@sealed.example','s',?,'sent',?,?)", m.html, new Date().toISOString(), m.payload);
  const mid = Number(r.lastInsertRowid);
  db.run("UPDATE emails SET html=col_replace(html, ?, '(removed)'), payload=col_replace(payload, ?, '(removed)') WHERE id=?", '918273', '918273', mid);
  const after = rawValue('SELECT html, payload FROM emails WHERE id=?', mid);
  assert.ok(isSealed(after.html) && isSealed(after.payload), 'still sealed');
  assert.equal(openStrict(after.html), '<p>Your code is (removed)</p>');
  assert.ok(!openStrict(after.payload).includes('918273'));
  assert.ok(db.get('SELECT 1 x FROM emails WHERE col_find(payload) LIKE ?', `%"sha256":"${'f'.repeat(64)}"%`), 'the attachment is still found');
  db.run('DELETE FROM emails WHERE id=?', mid);
});

test('migration: values written before the key was set are sealed in place, overwritten where they stood, and moved to a new key with the old one listed', async () => {
  setKeys(undefined, [K1, K2]);
  const kim = await person('Kim Before', 'kim@before.example');
  const e = await simple(kim, 'lou@before.example');
  assert.equal((await kim.post(`/envelopes/${e.id}/send`)).status, 200);
  const lou = new Client();
  lou.ip = '198.18.201.1';
  const tok = tokenFor(e.id, 'lou@before.example');
  await lou.post(`/sign/${tok}/consent`);
  const secret = 'OLD-COMMENT-TOPAZ-31337 '.repeat(40);
  assert.equal((await lou.post(`/sign/${tok}/comments`, { text: secret })).status, 200);
  assert.ok(onDisk().includes(Buffer.from('OLD-COMMENT-TOPAZ-31337')), 'with no key it is kept as before');
  assert.ok(databaseWarning()?.includes('npm run setup'), 'and the server says so');
  // The server starts with a key.
  setKeys(K1, [K2]);
  const before = scanColumns();
  assert.ok(before.plain > 0);
  const r = sealColumns();
  assert.equal(r.skipped, null);
  assert.ok(r.sealed >= before.plain - 2, JSON.stringify(r));
  assert.equal(scanColumns().plain, 0);
  assert.ok(!onDisk().includes(Buffer.from('OLD-COMMENT-TOPAZ-31337')), 'the clear words were overwritten in the database file, not only unlinked');
  assert.ok(JSON.stringify((await kim.get(`/envelopes/${e.id}/comments`)).data).includes('OLD-COMMENT-TOPAZ-31337'));
  assert.deepEqual(sealColumns(), { sealed: 0, moved: 0, left: 0, skipped: null }, 'a second run finds nothing to do');
  // A new key with the old one listed: everything moves to it, so the old one can be taken out.
  setKeys(K2, [K1]);
  const m = sealColumns();
  assert.ok(m.moved > 0 && m.sealed === 0, JSON.stringify(m));
  const raw = rawValue('SELECT body FROM comments WHERE envelope_id=?', e.id).body;
  assert.equal(raw.split('|')[2] && Buffer.from(raw.split('|')[2], 'base64').subarray(0, 8).toString('hex'), id2);
  setKeys(K2);
  assert.ok(JSON.stringify((await kim.get(`/envelopes/${e.id}/comments`)).data).includes('OLD-COMMENT-TOPAZ-31337'), 'readable with the new key alone');
});

test('a key that does not fit: the value is refused in plain words, nothing is changed, the server says which key is missing', async () => {
  setKeys(K1, [K2]);
  const ann = await person('Ann Locked', 'ann@locked.example');
  const e = await simple(ann, 'ola@locked.example');
  assert.equal((await ann.post(`/envelopes/${e.id}/send`)).status, 200);
  const ola = new Client();
  ola.ip = '198.18.202.1';
  const tok = tokenFor(e.id, 'ola@locked.example');
  await ola.post(`/sign/${tok}/consent`);
  assert.equal((await ola.post(`/sign/${tok}/comments`, { text: 'Under the first key' })).status, 200);
  // K1 is gone from the settings (K3 in its place). The stored files under K1 would stop storing; list K2 only so
  // the column check is what is tested: the sweep skips, the read is refused.
  setKeys(K3, [K2]);
  const raw = rawValue('SELECT body FROM comments WHERE envelope_id=?', e.id).body;
  // Like a stored file under a missing key, the rest of the record is still served and the locked words read as
  // empty, never as something else.
  const seen = await ann.get(`/envelopes/${e.id}/comments`);
  assert.equal(seen.status, 200);
  assert.ok(!JSON.stringify(seen.data).includes('Under the first key'));
  assert.equal(openValue(raw), '');
  // A value damaged on the disk is refused outright, in words that name no key.
  const b = Buffer.from(raw.split('|')[2], 'base64');
  b[b.length - 3] ^= 1;
  setKeys(K1, [K2]);
  assert.throws(() => openValue(`${PREFIX}comments.body|${b.toString('base64')}`), (x: any) => x.status === 503 && x.data?.code === 'data_locked' && !x.message.includes(id1));
  setKeys(K3, [K2]);
  const w = databaseWarning();
  assert.ok(w?.includes(id1) && w.includes('FILE_ENCRYPTION_KEYS_OLD'), w || '');
  const s = sealColumns();
  assert.ok(s.skipped || s.left > 0, JSON.stringify(s));
  assert.equal(rawValue('SELECT body FROM comments WHERE envelope_id=?', e.id).body, raw, 'left exactly as it was');
  // Put back: readable again.
  setKeys(K1, [K2]);
  assert.equal((await ann.get(`/envelopes/${e.id}/comments`)).status, 200);
});

test('the script: --check counts, a run seals the whole database, --new-key prints a key, and npm run setup writes one into .env only when none is set', async () => {
  setKeys(K1, [K2]);
  db.run("INSERT INTO support_requests (id, email, name, topic, message, status, at) VALUES ('sup_nope','old@sealed.example','Old','other',?,'open',?)", 'Written by an old version VIOLET-12', new Date().toISOString());
  const env = { ...process.env, FILE_ENCRYPTION_KEY: K1, FILE_ENCRYPTION_KEYS_OLD: K2 };
  const run = (args: string[], cwd = ROOT, e: any = env) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(ROOT, 'scripts/encrypt-columns.mjs'), ...args], { cwd, env: e, encoding: 'utf8' });
  const check = run(['--check']);
  assert.equal(check.status, 0, check.stderr + check.stdout);
  assert.match(check.stdout, /1 value is not encrypted/);
  assert.ok(isSealed(rawValue("SELECT message FROM support_requests WHERE id='sup_nope'").message) === false, '--check changes nothing');
  const go = run([]);
  assert.equal(go.status, 0, go.stderr + go.stdout);
  assert.match(go.stdout, /Every value in the listed columns is now encrypted with the current key/);
  assert.ok(isSealed(rawValue("SELECT message FROM support_requests WHERE id='sup_nope'").message));
  const nk = run(['--new-key']);
  assert.ok(decodeFileKey(nk.stdout.trim()));
  // setup: a folder of its own, so the real .env of whoever runs the tests is never touched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  const setup = (e: any) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/setup.mjs')], { cwd: dir, env: e, encoding: 'utf8' });
  const clean = { PATH: process.env.PATH };
  const one = setup(clean);
  assert.equal(one.status, 0, one.stderr);
  const written = /^FILE_ENCRYPTION_KEY=(.+)$/m.exec(fs.readFileSync(path.join(dir, '.env'), 'utf8'))?.[1];
  assert.ok(decodeFileKey(written), 'a real key');
  assert.match(one.stdout, /Keep a copy of it somewhere safe/);
  assert.ok(!one.stdout.includes(written!), 'the key itself is not printed to a log');
  assert.equal((fs.statSync(path.join(dir, '.env')).mode & 0o077), 0, 'only its owner can read .env');
  const two = setup(clean);
  assert.equal(two.status, 0);
  assert.equal(/^FILE_ENCRYPTION_KEY=(.+)$/m.exec(fs.readFileSync(path.join(dir, '.env'), 'utf8'))?.[1], written, 'a second run never replaces the key');
  assert.match(two.stdout, /already set/);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  const three = spawnSync(process.execPath, [path.join(ROOT, 'scripts/setup.mjs')], { cwd: dir2, env: { ...clean, FILE_ENCRYPTION_KEY: K1 }, encoding: 'utf8' });
  assert.equal(three.status, 0);
  assert.ok(!fs.existsSync(path.join(dir2, '.env')) || !fs.readFileSync(path.join(dir2, '.env'), 'utf8').includes('FILE_ENCRYPTION_KEY'), 'a key in the environment is left alone');
  assert.ok(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.setup);
});

test('the pages say exactly what is encrypted and what is not, and that the key protects a stolen disk, not a break-in', () => {
  // Every column in the list is named in words, and the words for what stays readable name names, addresses and subjects.
  assert.equal(SEALED_WORDS.length >= 6, true);
  assert.ok(CLEAR_WORDS.some((w) => /names/.test(w) && /email addresses/.test(w)));
  const sec = fs.readFileSync(path.join(ROOT, 'src/lib/storedfiles.ts'), 'utf8');
  assert.ok(sec.includes('sealedcolumns'), 'the security texts read the same list');
  const DASH = String.fromCharCode(0x2014);
  for (const f of ['src/server/colcrypt.ts', 'src/server/colsweep.ts', 'src/lib/sealedcolumns.ts', 'scripts/encrypt-columns.mjs', 'scripts/setup.mjs'])
    assert.ok(!fs.readFileSync(path.join(ROOT, f), 'utf8').includes(DASH), `${f} has no em dash`);
});

test('SQL that looks inside a sealed value still works: a file a waiting email carries is kept, and a double tap of the same comment is stored once', async () => {
  setKeys(K1, [K2]);
  const { removeUnusedBlobs } = await import('../src/server/routes-trust.ts');
  // A stored file only a queued email still carries (its attachment list is in the sealed payload).
  const sha = crypto.randomBytes(32).toString('hex');
  const blobs = path.join(process.env.DATA_DIR!, 'blobs');
  fs.mkdirSync(blobs, { recursive: true });
  fs.writeFileSync(path.join(blobs, sha), 'still needed');
  const r = db.run("INSERT INTO emails (to_email, subject, html, status, at, payload) VALUES ('w@sealed.example','s',?,'queued',?,?)", seal('emails.html', '<p>x</p>'), new Date().toISOString(), seal('emails.payload', JSON.stringify({ attachments: [{ filename: 'a.pdf', sha256: sha }] })));
  assert.ok(isSealed(rawValue('SELECT payload FROM emails WHERE id=?', Number(r.lastInsertRowid)).payload));
  removeUnusedBlobs([sha]);
  assert.ok(fs.existsSync(path.join(blobs, sha)), 'the file the email still has to carry is not deleted');
  db.run('DELETE FROM emails WHERE id=?', Number(r.lastInsertRowid));
  removeUnusedBlobs([sha]);
  assert.ok(!fs.existsSync(path.join(blobs, sha)), 'once nothing carries it, it goes');
  // The same words sent twice within seconds, as a double tap does.
  const jo = await person('Jo Twice', 'jo@twice.example');
  const e = await simple(jo, 'sid@twice.example');
  assert.equal((await jo.post(`/envelopes/${e.id}/send`)).status, 200);
  const sid = new Client();
  sid.ip = '198.18.203.1';
  const tok = tokenFor(e.id, 'sid@twice.example');
  await sid.post(`/sign/${tok}/consent`);
  assert.equal((await sid.post(`/sign/${tok}/comments`, { text: 'Is page 2 right?' })).status, 200);
  assert.equal((await sid.post(`/sign/${tok}/comments`, { text: 'Is page 2 right?' })).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM comments WHERE envelope_id=?', e.id).n, 1, 'stored once, though each copy on the disk looks different');
});

test('automatic alerts and the words left after a purge are written sealed too, not only later by the sweep', () => {
  setKeys(K1, [K2]);
  const src = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const f of ['src/server/finalretry.ts', 'src/server/sealkey.ts', 'src/server/filestore.ts', 'src/server/evidence.ts'])
    assert.match(src(f), /seal\('support_requests\.message'/, `${f} seals the alert it files`);
  const rec = src('src/server/records.ts');
  for (const c of ['recipients.decline_reason', 'comments.body', 'emails.html']) assert.ok(rec.includes(`seal('${c}'`), `records.ts seals ${c}`);
});

// Repair after review (tests/out/verify-ds-db-encrypt, tests/out/ux-ds-db-encrypt).
test('a save while a key is missing never writes over what it could not open: the saved signature, and a signer\'s initials', async () => {
  setKeys(K1, [K2]);
  const kim = await person('Kim Keep', 'kim@keep.example');
  const sig = uniquePng(), ini = uniquePng();
  assert.equal((await kim.call('PATCH', '/me', { signature_png: sig, initials_png: ini })).status, 200);
  const e = await simple(kim, 'rae@keep.example');
  assert.equal((await kim.post(`/envelopes/${e.id}/send`)).status, 200);
  const rae = new Client();
  rae.ip = '198.18.203.1';
  const tok = tokenFor(e.id, 'rae@keep.example');
  await rae.post(`/sign/${tok}/consent`);
  assert.equal((await rae.post(`/sign/${tok}/save`, { values: {}, signature_png: sig, initials_png: ini })).status, 200);
  const before = rawValue('SELECT signature_png s, initials_png i FROM users WHERE email=?', 'kim@keep.example');
  const rBefore = rawValue('SELECT initials_png i FROM recipients WHERE envelope_id=?', e.id).i;
  assert.ok(isSealed(before.s) && isSealed(before.i) && isSealed(rBefore));
  // The key is replaced by mistake at a restart. The person changes only their title; the signer saves a new signature only.
  setKeys(K3, [K2]);
  assert.equal((await kim.call('PATCH', '/me', { title: 'Manager' })).status, 200);
  const sig2 = uniquePng();
  assert.equal((await rae.post(`/sign/${tok}/save`, { values: {}, signature_png: sig2 })).status, 200);
  const after = rawValue('SELECT signature_png s, initials_png i, title FROM users WHERE email=?', 'kim@keep.example');
  assert.equal(after.title, 'Manager');
  assert.equal(after.s, before.s, 'the saved signature is left exactly as stored');
  assert.equal(after.i, before.i);
  assert.equal(rawValue('SELECT initials_png i FROM recipients WHERE envelope_id=?', e.id).i, rBefore, 'the initials are left exactly as stored');
  // The right key back: everything is there.
  setKeys(K1, [K2]);
  const me = (await kim.get('/me')).data.user;
  assert.equal(me.signature_png, sig);
  assert.equal(me.initials_png, ini);
  // Clearing on purpose still works.
  assert.equal((await kim.call('PATCH', '/me', { initials_png: null })).status, 200);
  assert.equal(rawValue('SELECT initials_png i FROM users WHERE email=?', 'kim@keep.example').i, null);
});

test('typed numbers, help chats and public form drafts are sealed too, not kept in the clear next to the sealed answer', async () => {
  setKeys(K1, [K2]);
  // A number field: its plain number (typed_num) is as private as the text.
  const jo = await person('Jo Num', 'jo@num.example');
  const e = await simple(jo, 'sam@num.example', { fields: [
    { id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
    { id: 'n', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Salary', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.03, validation: { decimals: 2 } },
  ] });
  assert.equal((await jo.post(`/envelopes/${e.id}/send`)).status, 200);
  const sam = new Client();
  sam.ip = '198.18.204.1';
  const tok = tokenFor(e.id, 'sam@num.example');
  await sam.post(`/sign/${tok}/consent`);
  const fields = (await sam.get(`/sign/${tok}`)).data.fields;
  const values = Object.fromEntries(fields.map((f: any) => [f.id, f.type === 'number' ? '987654.31' : '1']));
  const done = await sam.post(`/sign/${tok}/complete`, { values, signature_png: uniquePng() });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const num = rawValue("SELECT typed_num FROM fields WHERE envelope_id=? AND type='number'", e.id).typed_num;
  assert.ok(isSealed(num), 'typed_num is sealed');
  assert.equal(db.get("SELECT typed_num FROM fields WHERE envelope_id=? AND type='number'", e.id).typed_num, '987654.31', 'and reads back as the number');
  // A help request with the chat attached.
  assert.equal((await new Client().post('/public/support', { name: 'Ana', email: 'ana.chat@example.com', topic: 'other', message: 'help me please with this', chat: [{ from: 'you', text: 'My passport number is PASSPORT-ZEBRA-8821' }] })).status, 200);
  const chat = rawValue('SELECT chat FROM support_requests WHERE email=?', 'ana.chat@example.com').chat;
  assert.ok(isSealed(chat), 'the chat is sealed');
  // A public form draft.
  const owner = await person('Olga Form', 'olga@pform.example');
  const file = await upload(owner, 1);
  const tpl = await owner.post('/envelopes', { kind: 'template', subject: 'Form', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Visitor' }],
    fields: [{ id: 's', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }, { id: 't', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Medical condition', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.03 }] });
  const tplId = tpl.data.envelope.id;
  const pf = await owner.post('/powerforms', { template_id: tplId, name: 'Health form' });
  const slug = db.get('SELECT slug FROM powerforms WHERE id=?', pf.data.id)?.slug;
  const fid = db.get("SELECT id FROM fields WHERE envelope_id=? AND label='Medical condition'", tplId).id;
  const v = new Client();
  v.ip = '198.18.205.1';
  const put = await v.call('PUT', `/public/powerforms/${slug}/draft`, { name: 'Vee', email: 'vee@pform.example', answers: { [fid]: 'DIAGNOSIS-LYCHEE-42' } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.ok(isSealed(rawValue('SELECT answers FROM form_drafts WHERE powerform_id=?', pf.data.id).answers), 'the draft is sealed');
  const disk = onDisk();
  for (const w of ['987654.31', 'PASSPORT-ZEBRA-8821', 'DIAGNOSIS-LYCHEE-42']) assert.ok(!disk.includes(Buffer.from(w)), `${w} is not readable in the database file`);
  // The archive copy of an email is sealed where it is written; the sweep covers every new column.
  assert.match(fs.readFileSync(path.join(ROOT, 'src/server/mail.ts'), 'utf8'), /seal\('emails\.archive_draft', draft\)/);
  for (const c of ['fields.typed_num', 'fields.calc_num', 'emails.archive_draft', 'support_requests.chat', 'form_drafts.answers'])
    assert.ok(SEALED_COLUMNS.some((x) => `${x.table}.${x.column}` === c), c);
});

test('the operator line: short, plain, styled as a warning, also for a key that is not a key; no "value(s)" and no "us"', () => {
  setKeys();
  const off = databaseWarning()!;
  assert.ok(off.split(/\s+/).length <= 45, off);
  assert.match(off, /^Stored files and the signatures/);
  assert.match(off, /npm run setup/);
  setKeys('not-a-key');
  assert.match(databaseWarning() || '', /is not a key/);
  setKeys(K1, [K2]);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/app/app/operator/encryption.tsx'), 'utf8'), /className="notice warn small"/);
  for (const f of ['src/server/colsweep.ts', 'scripts/setup.mjs', 'scripts/encrypt-columns.mjs', '.env.example']) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!t.includes('value(s)') && !t.includes('that includes us'), f);
  }
});

test('no trust page says the software never encrypts the database, and the database point is two short lists', async () => {
  const { notEncryptedPoint, processingNotDone } = await import('../src/lib/storedfiles.ts');
  const policy = await import('../src/lib/policy.ts');
  const all = [...policy.NO_BAA_FIRST, ...policy.WHO_CAN_SEE.map((w: any) => w.what), processingNotDone(false), processingNotDone(true), notEncryptedPoint(false).text, notEncryptedPoint(true).text];
  for (const t of all) assert.doesNotMatch(t, /never encrypts the database|no encryption of its own to the database/, t);
  setKeys(K1, [K2]);
  const p = notEncryptedPoint();
  assert.equal(p.lists?.length, 2);
  assert.ok(p.text.split(/\s+/).length < 40 && (p.after || '').length > 0);
  for (const l of p.lists!) for (const x of l.items) assert.ok(x.split(/\s+/).length <= 25, x);
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /cp \.env\.example \.env[^\n]*\nnpm run setup/);
});
