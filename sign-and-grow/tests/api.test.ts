// API robustness: an Idempotency-Key that belongs to one person and never points at nothing, bulk sends that can be
// repeated and finished after a crash, one audit line a day for an embedded signing link, two requests arriving at
// the same moment, and signed PDFs made from fillable forms.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { PDFDocument, PDFDict, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import { boot, Client, PNG, upload, simple, draft, signUp, signAll, mailTo, tokenFor, type Server } from './helpers.ts';

let db: Server['db'];
let env: Server['env'];

// Sign-ups are limited per address, so everybody here arrives from an address of their own.
let people = 0;
const newIp = () => `198.51.100.${++people}`;
const join = async (owner: Client, name: string, email: string) => {
  assert.equal((await owner.post('/account/invites', { email, role: 'member' })).status, 200);
  const invite = db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL', email).token;
  const c = Object.assign(new Client(), { ip: newIp() });
  assert.equal((await c.post('/auth/signup', { name, email, password: 'correct horse battery', invite })).status, 200);
  return c;
};
const withKey = (key: string) => {
  const c = new Client();
  const call = c.call.bind(c);
  c.call = (m: string, u: string, b?: any, h: Record<string, string> = {}) => call(m, u, b, { authorization: `Bearer ${key}`, ...h });
  return c;
};
const keyed = (c: Client, url: string, body: any, key: string) => c.call('POST', url, body, { 'idempotency-key': key });
const auditOf = (envelopeId: string, ...actions: string[]) =>
  db.all('SELECT action FROM audit WHERE envelope_id=? ORDER BY seq', envelopeId).map((a: any) => a.action).filter((a: string) => !actions.length || actions.includes(a));
const hooksFor = (envelopeId: string) => db.all('SELECT event FROM webhook_deliveries WHERE envelope_id=? ORDER BY id', envelopeId).map((d: any) => d.event);
const statusOf = (envelopeId: string) => db.get('SELECT status FROM envelopes WHERE id=?', envelopeId).status;

// A stand-in for a customer's webhook endpoint, so every event that is fired has somewhere to go.
const hookServer = http.createServer((req, res) => (req.resume(), req.on('end', () => res.end('ok'))));
let hookUrl = '';

// A stand-in for the mail server that can be made to stall on one address. That is what a slow or dead mail server
// looks like to a bulk send: the call hangs half way through its list. Only the first email to that address
// stalls, so a second copy of it (which is what these tests are there to catch) goes through and gets counted.
const smtp = { stallOn: '', release: () => {} };
function stallMailTo(email: string): Promise<void> {
  smtp.stallOn = email;
  process.env.SMTP_URL = 'smtp://stand-in.invalid';
  return new Promise<void>((reached) => {
    (globalThis as any).__tsmail = {
      sendMail: (m: any) => {
        if (m.to !== smtp.stallOn) return Promise.resolve();
        smtp.stallOn = '';
        return new Promise<void>((done) => ((smtp.release = done), reached()));
      },
    };
  });
}
function mailBackToNormal() {
  delete process.env.SMTP_URL;
  delete (globalThis as any).__tsmail;
  smtp.stallOn = '';
}

// A request whose body only arrives when the test says so. By then the handler has already looked at the link or
// the envelope once, and that wait is the gap a second request can slip into. Lets a test put two requests that
// cross each other in a known order.
let handle: (req: Request) => Promise<Response>;
function held(c: Client, method: string, url: string, body: any) {
  let arrive = () => {};
  const stream = new ReadableStream<Uint8Array>({ start: (ctrl) => void (arrive = () => (ctrl.enqueue(new TextEncoder().encode(JSON.stringify(body))), ctrl.close())) });
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': c.ip, cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
  const answer = handle(new Request(`http://test.local/api${url}`, { method, body: stream, duplex: 'half', headers } as any)).then(async (res) => ({ status: res.status, data: await res.json() }));
  return { arrive, answer };
}

before(async () => {
  ({ db, env } = await boot());
  handle = (await import('../src/server/router.ts')).handle;
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hookServer.address() as any).port}/hook`;
});
after(() => {
  mailBackToNormal();
  hookServer.closeAllConnections();
  hookServer.close();
});

// ---- 1. Idempotency-Key on POST /envelopes -------------------------------------------------------------------

test('an Idempotency-Key belongs to the person who used it, and a different request under it is refused', async () => {
  const owner = await signUp('Olga Owner', 'olga@example.com', newIp());
  const member = await join(owner, 'Mem Ber', 'member@example.com');
  const file = await upload(owner, 1);
  const secret = { subject: 'Owner secret deal', documents: [{ id: 'd1', file_id: file.id }], recipients: [{ id: 'r1', name: 'Confidential Person', email: 'secret@example.com' }] };

  const mine = await keyed(owner, '/envelopes', secret, 'contract-4471');
  assert.equal(mine.status, 200);
  assert.equal((await member.get(`/envelopes/${mine.data.envelope.id}`)).status, 404, 'a member cannot open the owner\'s envelope');

  // The same text, used by another member of the team, is that member's own key.
  const theirs = await keyed(member, '/envelopes', { subject: 'Member thing' }, 'contract-4471');
  assert.equal(theirs.status, 200);
  assert.notEqual(theirs.data.envelope.id, mine.data.envelope.id, 'the member does not get the owner\'s envelope back');
  assert.equal(theirs.data.envelope.subject, 'Member thing');
  assert.deepEqual(theirs.data.envelope.recipients, []);

  // Each of them gets their own envelope again on a repeat.
  assert.equal((await keyed(member, '/envelopes', { subject: 'Member thing' }, 'contract-4471')).data.envelope.id, theirs.data.envelope.id);
  assert.equal((await keyed(owner, '/envelopes', secret, 'contract-4471')).data.envelope.id, mine.data.envelope.id);
  // An API key acts as the person who made it, so their key and their browser share keys.
  const api = withKey((await owner.post('/api-keys', { name: 'integration' })).data.key);
  assert.equal((await keyed(api, '/envelopes', secret, 'contract-4471')).data.envelope.id, mine.data.envelope.id);

  // A different request under a used key is told so. Answering with the first envelope would hide that the new
  // one was never made.
  const before = db.get('SELECT COUNT(*) n FROM envelopes').n;
  const other = await keyed(owner, '/envelopes', { subject: 'A totally different envelope' }, 'contract-4471');
  assert.equal(other.status, 409);
  assert.match(other.data.error, /already used for a different request/);
  assert.ok(other.data.error.includes(mine.data.envelope.id), 'and it names the envelope the key made');
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes').n, before, 'nothing was created');
  assert.equal((await keyed(owner, '/envelopes', {}, 'k'.repeat(201))).status, 400, 'a key that is too long is refused, not cut short');
});

test('a key goes when its envelope goes, so the next call with it is protected again', async () => {
  const owner = await signUp('Ida Sender', 'ida.sender@example.com', newIp());
  const file = await upload(owner, 1);
  const body = { subject: 'Contract 4471', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Ida', email: 'ida2@example.com' }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] };

  const first = await keyed(owner, '/envelopes', body, 'contract-4471');
  assert.equal((await owner.call('DELETE', `/envelopes/${first.data.envelope.id}`)).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM idempotency_keys WHERE envelope_id=?', first.data.envelope.id).n, 0, 'the key row is removed with its envelope');

  // The key is free, and from here on it protects the new envelope.
  const a = await keyed(owner, '/envelopes', { ...body, send: true }, 'contract-4471');
  const b = await keyed(owner, '/envelopes', { ...body, send: true }, 'contract-4471');
  assert.equal(a.status, 200);
  assert.equal(a.data.envelope.status, 'sent');
  assert.equal(b.data.envelope.id, a.data.envelope.id, 'the retry returns the envelope that was sent');
  assert.equal(mailTo('ida2@example.com').length, 1, 'and the signer is emailed once');

  // A create-and-send that is refused leaves nothing behind, so the same key can be used for the corrected call.
  const refused = await keyed(owner, '/envelopes', { ...body, fields: [], send: true }, 'contract-4472');
  assert.equal(refused.status, 400);
  assert.equal(db.get("SELECT COUNT(*) n FROM idempotency_keys WHERE key='contract-4472'").n, 0);
  assert.equal((await keyed(owner, '/envelopes', { ...body, send: true, recipients: [{ id: 'r', role: 'signer', name: 'Ida', email: 'ida3@example.com' }] }, 'contract-4472')).status, 200);
});

test('a database from before this change keeps its live keys and drops the ones that pointed at nothing', () => {
  // Runs in a process of its own, with a database of its own, because it rebuilds a table.
  const script = `
    import { db, run, get, all } from './src/server/db.ts';
    db().exec("DROP TABLE idempotency_keys; CREATE TABLE idempotency_keys (account_id TEXT NOT NULL, key TEXT NOT NULL, envelope_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (account_id, key));");
    run("INSERT INTO accounts (id, name, created_at) VALUES ('acc_1','A','2026-01-01')");
    run("INSERT INTO envelopes (id, account_id, sender_id, created_at, updated_at) VALUES ('env_live','acc_1','usr_1','2026-01-01','2026-01-01')");
    run("INSERT INTO idempotency_keys VALUES ('acc_1','live','env_live','2026-01-01'), ('acc_1','dead','env_gone','2026-01-01')");
    globalThis.__tsdb.close();
    globalThis.__tsdb = undefined;
    const keys = all('SELECT account_id, user_id, key, envelope_id FROM idempotency_keys');
    run("DELETE FROM envelopes WHERE id='env_live'");
    console.log(JSON.stringify({ keys, left: get('SELECT COUNT(*) n FROM idempotency_keys').n, tables: all("SELECT name FROM sqlite_master WHERE name LIKE 'idempotency_keys%' ORDER BY name").map((t) => t.name) }));
  `;
  const out = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
    { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'growsigning-old-')) }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const seen = JSON.parse(out.stdout.trim().split('\n').at(-1)!);
  assert.deepEqual(seen.keys, [{ account_id: 'acc_1', user_id: 'usr_1', key: 'live', envelope_id: 'env_live' }], 'the live key now belongs to the envelope\'s sender');
  assert.equal(seen.left, 0, 'and it goes when that envelope is deleted');
  assert.deepEqual(seen.tables, ['idempotency_keys', 'idempotency_keys_env'], 'the old table is gone and the new one has its index');
});

// ---- 2. Bulk send --------------------------------------------------------------------------------------------

async function template(c: Client) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', { kind: 'template', subject: 'Waiver', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Volunteer' }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
const list = (tag: string, n: number) => Array.from({ length: n }, (_, i) => ({ Volunteer: { name: `${tag} ${i + 1}`, email: `${tag}${i + 1}@example.com` } }));
const emailsOf = (rows: any[]) => rows.map((r) => r.Volunteer.email);
const mailCounts = (rows: any[]) => emailsOf(rows).map((e) => mailTo(e).length);

test('a bulk send repeated with the same Idempotency-Key is the same batch and nobody is sent a second copy', async () => {
  const owner = await signUp('Bea Bulk', 'bea@example.com', newIp());
  const member = await join(owner, 'Max Member', 'max@example.com');
  const tpl = await template(owner);
  const rows = list('seq', 3);

  const first = await keyed(owner, '/bulk', { template_id: tpl.id, rows }, 'bulk-1');
  const again = await keyed(owner, '/bulk', { template_id: tpl.id, rows }, 'bulk-1');
  assert.equal(first.status, 200);
  assert.equal(first.data.sent, 3);
  assert.equal(again.status, 200);
  assert.equal(again.data.id, first.data.id, 'the repeat returns the first batch');
  assert.deepEqual(again.data, first.data, 'with the same result for every row');
  assert.deepEqual(mailCounts(rows), [1, 1, 1], 'and each person was emailed once');
  assert.equal(db.get('SELECT COUNT(*) n FROM bulk_batches WHERE account_id=(SELECT account_id FROM bulk_batches WHERE id=?)', first.data.id).n, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE bulk_id=?', first.data.id).n, 3);

  // The batch record says what happened to every row, and does not hand the key to whoever reads it.
  const record = (await owner.get(`/bulk/${first.data.id}`)).data;
  assert.deepEqual(record.rows.map((r: any) => [r.position, r.status, r.envelope_id]), first.data.results.map((r: any, i: number) => [i, 'sent', r.id]));
  assert.equal(record.sending, false);
  assert.equal('idem_key' in record.batch, false);

  // A different list under the same key is refused instead of being quietly dropped.
  const other = await keyed(owner, '/bulk', { template_id: tpl.id, rows: list('other', 2) }, 'bulk-1');
  assert.equal(other.status, 409);
  assert.match(other.data.error, /already used for a different bulk send/);
  assert.deepEqual(mailCounts(list('other', 2)), [0, 0]);

  // The key belongs to the person: a team member using the same text gets a batch of their own.
  const theirs = await keyed(member, '/bulk', { template_id: tpl.id, rows: list('team', 1) }, 'bulk-1');
  assert.equal(theirs.status, 200);
  assert.notEqual(theirs.data.id, first.data.id);
  assert.equal(theirs.data.sent, 1);
});

test('a repeat that arrives while the first call is still sending gets the same batch at once and sends nothing', async () => {
  const owner = await signUp('Flo Flight', 'flo@example.com', newIp());
  const tpl = await template(owner);
  const rows = list('fly', 4);
  const body = { template_id: tpl.id, rows };
  try {
    const stalled = stallMailTo('fly2@example.com');
    const firstCall = keyed(owner, '/bulk', body, 'bulk-fly');
    await stalled; // the first call is now waiting for the mail server, on the second row of four

    const during = await keyed(owner, '/bulk', body, 'bulk-fly');
    assert.equal(during.status, 202, 'the repeat is answered while the first call is still at work');
    const bid = db.get("SELECT id FROM bulk_batches WHERE idem_key='bulk-fly'").id;
    assert.equal(during.data.id, bid);
    assert.equal(during.data.sent, 1);
    assert.equal(during.data.pending, 3);
    const record = (await owner.get(`/bulk/${bid}`)).data;
    assert.equal(record.sending, true);
    assert.deepEqual(record.rows.map((r: any) => r.status), ['sent', 'pending', 'pending', 'pending']);
    assert.deepEqual(record.rows[3].row, rows[3], 'a row that has not gone out yet is shown as it was submitted');

    smtp.release();
    const first = await firstCall;
    assert.equal(first.status, 200);
    assert.equal(first.data.id, bid);
    assert.equal(first.data.sent, 4);
    assert.equal(first.data.pending, 0);
    assert.deepEqual((await keyed(owner, '/bulk', body, 'bulk-fly')).data, first.data, 'a repeat after it finished gets the full result');
    assert.deepEqual(mailCounts(rows), [1, 1, 1, 1], 'each person was emailed once');
    assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE bulk_id=?', bid).n, 4);
    assert.equal(db.get('SELECT COUNT(*) n FROM bulk_rows WHERE bulk_id=? AND fill IS NOT NULL', bid).n, 0, 'the names and emails of sent rows are not kept a second time');
  } finally {
    mailBackToNormal();
  }
});

test('a batch whose process died half way is finished by a repeat with the same key, not started over', async () => {
  const owner = await signUp('Dee Died', 'dee.died@example.com', newIp());
  const me = (await owner.get('/me')).data;
  const tpl = await template(owner);
  const rows = list('gone', 5);
  const body = { template_id: tpl.id, rows };
  let bid = '';
  try {
    const stalled = stallMailTo('gone3@example.com');
    void keyed(owner, '/bulk', body, 'bulk-gone'); // this call never answers: it is the process that dies
    await stalled;
    bid = db.get('SELECT id FROM bulk_batches WHERE account_id=?', me.account.id).id;
  } finally {
    mailBackToNormal();
  }
  // The process is gone, and with it the memory of which batches were being sent.
  (globalThis as any).__tsbulk.clear();
  // Two more things a process can leave behind when it stops between two writes: a copy that no row points at, and
  // a copy that was written down for its row but never sent.
  const copy = () => env.copyEnvelope(env.loadEnvelope(tpl.id), { accountId: me.account.id, senderId: me.user.id, kind: 'envelope', fill: rows[3], extra: { bulk_id: bid } });
  const stray = copy();
  const unsent = copy();
  db.run('UPDATE bulk_rows SET envelope_id=? WHERE bulk_id=? AND position=3', unsent, bid);

  // The record shows how far it got: two out, the third caught mid-send, two not started.
  const record = (await owner.get(`/bulk/${bid}`)).data;
  assert.equal(record.sending, false);
  assert.deepEqual(record.rows.map((r: any) => r.status), ['sent', 'sent', 'pending', 'pending', 'pending']);
  assert.deepEqual(mailCounts(rows), [1, 1, 1, 0, 0]);

  const retry = await keyed(owner, '/bulk', body, 'bulk-gone');
  assert.equal(retry.status, 200);
  assert.equal(retry.data.id, bid, 'the same batch, not a new one');
  assert.equal(retry.data.sent, 5);
  assert.equal(retry.data.pending, 0);
  assert.deepEqual(mailCounts(rows), [1, 1, 1, 1, 1], 'the rest went out, and nobody who had been emailed was emailed again');
  assert.equal(retry.data.results[3].id, unsent, 'the copy that was waiting is the one that was sent');
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', stray).n, 0, 'the stray copy is cleared away');
  assert.deepEqual(db.all('SELECT status FROM envelopes WHERE bulk_id=?', bid).map((e: any) => e.status), ['sent', 'sent', 'sent', 'sent', 'sent']);
  assert.equal(db.get('SELECT COUNT(*) n FROM bulk_batches WHERE account_id=?', me.account.id).n, 1);
  assert.deepEqual((await keyed(owner, '/bulk', body, 'bulk-gone')).data, retry.data);
  assert.deepEqual(mailCounts(rows), [1, 1, 1, 1, 1]);
});

// ---- 3. Embedded signing links -------------------------------------------------------------------------------

test('asking for an embedded signing link is recorded once a day for each link, however often it is asked', async () => {
  const owner = await signUp('Emma Embed', 'emma@example.com', newIp());
  const e = await draft(owner, { subject: 'Embedded' });
  await owner.post(`/envelopes/${e.id}/send`);
  const rid = (email: string) => db.get('SELECT id FROM recipients WHERE envelope_id=? AND email=?', e.id, email).id;
  const ask = (recipient: string) => owner.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: recipient });
  const issued = () => db.all("SELECT detail FROM audit WHERE envelope_id=? AND action='Signing link issued' ORDER BY seq", e.id).map((a: any) => a.detail);
  const ada = rid('ada@example.com');

  // An integration that asks on every page view, some of them at the same moment.
  const urls = new Set<string>();
  for (let i = 0; i < 20; i++) urls.add((await ask(ada)).data.url);
  for (const r of await Promise.all(Array.from({ length: 8 }, () => ask(ada)))) urls.add(r.data.url);
  assert.equal(urls.size, 1, 'the link is the same every time');
  assert.deepEqual(issued(), ['Ada Signer <ada@example.com>'], '28 requests leave one line in the audit trail');

  // Each recipient has a line of their own.
  await Promise.all([ask(rid('ben@example.com')), ask(rid('ben@example.com'))]);
  assert.deepEqual(issued(), ['Ada Signer <ada@example.com>', 'Ben Signer <ben@example.com>']);

  // A day later it is recorded again, once.
  db.run('UPDATE recipients SET link_issued_at=? WHERE id=?', new Date(Date.now() - 25 * 3600_000).toISOString(), ada);
  await ask(ada);
  await ask(ada);
  assert.equal(issued().filter((d: string) => d.startsWith('Ada')).length, 2);

  // A corrected address replaces the link. The new link is a new thing to record, also on the same day.
  assert.equal((await owner.post(`/envelopes/${e.id}/correct`, { recipient_id: ada, email: 'ada.new@example.com' })).status, 200);
  const fresh = await ask(ada);
  await ask(ada);
  assert.equal(urls.has(fresh.data.url), false);
  assert.deepEqual(issued().slice(-1), ['Ada Signer <ada.new@example.com>']);
  assert.equal(issued().length, 4);
  assert.equal((await owner.get(`/envelopes/${e.id}`)).data.chain.ok, true);
});

// ---- 4. Two requests at the same moment ----------------------------------------------------------------------

// One signer with a signature and a text field, sent and with consent given. Returns what a Finish needs.
async function ready(owner: Client, email: string, subject: string) {
  const file = await upload(owner, 1);
  const made = await owner.post('/envelopes', {
    subject, send: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email }],
    fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { document_id: 'd', recipient_id: 'r', type: 'text', label: 'Trees', page: 0, x: 0.1, y: 0.6, w: 0.3, h: 0.03 }],
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.envelope.id as string;
  const tok = tokenFor(id, email);
  const signer = new Client();
  await signer.post(`/sign/${tok}/consent`);
  const fields = (await signer.get(`/sign/${tok}`)).data.fields;
  const text = fields.find((f: any) => f.type === 'text').id as string;
  const finish = (trees = '250') => ({ values: { [fields.find((f: any) => f.type === 'signature').id]: '1', [text]: trees }, signature_png: PNG });
  return { id, tok, signer, text, finish };
}

let racer: Client;
let racerId = '';
test('two Finish requests at the same moment: one is accepted, the other is told it is already done', async () => {
  racer = await signUp('Race Owner', 'race@example.com', newIp());
  racerId = (await racer.get('/me')).data.account.id;
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  assert.equal((await racer.post('/webhooks', { url: hookUrl })).status, 200);
  // Paying is switched on for this one, so a signature used twice would show in the ledger.
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  try {
    const e = await ready(racer, 'double@example.com', 'Double tap');
    const [a, b] = await Promise.all([e.signer.post(`/sign/${e.tok}/complete`, e.finish()), e.signer.post(`/sign/${e.tok}/complete`, e.finish())]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.match([a, b].find((r) => r.status === 409)!.data.error, /already finished/);
    assert.equal([a, b].find((r) => r.status === 200)!.data.envelope_status, 'completed');
    assert.deepEqual(auditOf(e.id, 'Signed', 'Envelope completed'), ['Signed', 'Envelope completed'], 'one line each, and nothing after the certificate was made');
    assert.deepEqual(hooksFor(e.id).filter((h: string) => h !== 'envelope.sent' && h !== 'recipient.viewed'), ['recipient.completed', 'envelope.completed']);
    assert.equal(db.get("SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature'", racerId).n, 1, 'one signature used');
    assert.equal(mailTo('double@example.com').filter((m: any) => m.subject.startsWith('Completed')).length, 1);
    assert.equal((await racer.get(`/envelopes/${e.id}`)).data.chain.ok, true);
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test('finishing and declining claim the recipient in one step, also for a caller holding an out-of-date copy', async () => {
  const actor = { name: 'Sam Signer <stale@example.com>', ip: '203.0.113.9' };
  // Both calls are handed the same copy, read before either of them ran. Only the first may get through.
  const one = await ready(racer, 'stale1@example.com', 'Stale finish');
  const copy = env.loadEnvelope(one.id);
  const twice = await Promise.allSettled([env.completeRecipient(copy, copy.recipients[0], one.finish(), actor), env.completeRecipient(copy, copy.recipients[0], one.finish(), actor)]);
  assert.deepEqual(twice.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal((twice[1] as PromiseRejectedResult).reason.status, 409);
  assert.deepEqual(auditOf(one.id, 'Signed', 'Envelope completed'), ['Signed', 'Envelope completed']);

  // A decline and a Finish that cross: whichever is first wins, and the other writes nothing.
  const two = await ready(racer, 'stale2@example.com', 'Decline crosses finish');
  const old = env.loadEnvelope(two.id);
  const crossed = await Promise.allSettled([env.declineRecipient(old, old.recipients[0], 'Wrong terms', actor), env.completeRecipient(old, old.recipients[0], two.finish('changed my mind'), actor)]);
  assert.deepEqual(crossed.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal((crossed[1] as PromiseRejectedResult).reason.status, 409);
  assert.equal(statusOf(two.id), 'declined');
  assert.deepEqual(auditOf(two.id, 'Signed', 'Declined', 'Envelope completed'), ['Declined']);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', two.text).value, null, 'the refused Finish left no values behind');

  // A value that fails its check still undoes the claim, so the signer can put it right and finish.
  const three = await ready(racer, 'stale3@example.com', 'Missing value');
  assert.equal((await three.signer.post(`/sign/${three.tok}/complete`, three.finish(''))).status, 400);
  assert.equal(db.get('SELECT status FROM recipients WHERE token=?', three.tok).status, 'viewed');
  assert.equal((await three.signer.post(`/sign/${three.tok}/complete`, three.finish())).status, 200);
});

test('an approval sent twice is recorded once, whichever way the two requests cross', async () => {
  const file = await upload(racer, 1);
  const made = await racer.post('/envelopes', { subject: 'Budget approval', send: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'approver', name: 'April Approver', email: 'april@example.com' }] });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.envelope.id;
  const tok = tokenFor(id, 'april@example.com');
  const april = new Client();
  await april.post(`/sign/${tok}/consent`);
  // The second request has been let in and is waiting for its body when the first one goes through.
  const second = held(april, 'POST', `/sign/${tok}/complete`, {});
  assert.equal((await april.post(`/sign/${tok}/complete`, {})).status, 200);
  second.arrive();
  const refused = await second.answer;
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /already finished/);
  assert.deepEqual(auditOf(id, 'Approved', 'Envelope completed'), ['Approved', 'Envelope completed']);
  assert.deepEqual(hooksFor(id).filter((h: string) => h.endsWith('completed')), ['recipient.completed', 'envelope.completed']);
  assert.equal(mailTo('april@example.com').filter((m: any) => m.subject.startsWith('Completed')).length, 1);
});

test('two Decline requests at the same moment close the envelope once', async () => {
  const e = await ready(racer, 'decl@example.com', 'Double decline');
  const [a, b] = await Promise.all([new Client().post(`/sign/${e.tok}/decline`, { reason: 'no' }), new Client().post(`/sign/${e.tok}/decline`, { reason: 'no' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.deepEqual(auditOf(e.id, 'Declined'), ['Declined']);
  assert.deepEqual(hooksFor(e.id).filter((h: string) => h === 'envelope.declined'), ['envelope.declined']);
  assert.equal(mailTo('race@example.com').filter((m: any) => m.subject === 'Declined: Double decline').length, 1, 'the sender is told once');
});

test('a save that crosses Finish cannot change what was just signed', async () => {
  const e = await ready(racer, 'late@example.com', 'Late save');
  // "Finish later" is on its way when Finish is pressed, and its body lands after the signing is done.
  const late = held(e.signer, 'POST', `/sign/${e.tok}/save`, { values: { [e.text]: '9999' } });
  assert.equal((await e.signer.post(`/sign/${e.tok}/complete`, e.finish('250'))).status, 200);
  late.arrive();
  assert.equal((await late.answer).status, 400);
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', e.text).value, '250');
});

test('the same request passed on twice at the same moment: the first wins, the second finds the link replaced', async () => {
  const e = await ready(racer, 'pass@example.com', 'Double reassign');
  const second = held(new Client(), 'POST', `/sign/${e.tok}/reassign`, { name: 'Eve Other', email: 'eve.other@example.com' });
  assert.equal((await new Client().post(`/sign/${e.tok}/reassign`, { name: 'Dee Deputy', email: 'dee.deputy@example.com' })).status, 200);
  second.arrive();
  const refused = await second.answer;
  assert.equal(refused.status, 410);
  assert.match(refused.data.error, /replaced by a newer one/);
  assert.equal(db.get('SELECT email FROM recipients WHERE envelope_id=?', e.id).email, 'dee.deputy@example.com');
  assert.deepEqual(auditOf(e.id, 'Reassigned'), ['Reassigned']);
  assert.equal(mailTo('eve.other@example.com').length, 0, 'nobody is emailed about a request that was not passed to them');
  assert.equal((await new Client().get(`/sign/${tokenFor(e.id, 'dee.deputy@example.com')}`)).status, 200, 'and the link that was emailed works');
});

test('two Void requests at the same moment void once, and a void that crosses the last signature does not undo it', async () => {
  const e = await ready(racer, 'void@example.com', 'Double void');
  const [a, b] = await Promise.all([racer.post(`/envelopes/${e.id}/void`, { reason: 'Sent by mistake' }), racer.post(`/envelopes/${e.id}/void`, { reason: 'Sent by mistake' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  assert.deepEqual(auditOf(e.id, 'Envelope voided'), ['Envelope voided']);
  assert.deepEqual(hooksFor(e.id).filter((h: string) => h === 'envelope.voided'), ['envelope.voided']);
  assert.equal(mailTo('void@example.com').filter((m: any) => m.subject === 'Voided: Double void').length, 1);

  // The sender presses Void while the last signer presses Finish, and the signature gets there first.
  const x = await ready(racer, 'cross@example.com', 'Void crosses finish');
  const tooLate = held(racer, 'POST', `/envelopes/${x.id}/void`, { reason: 'Changed my mind' });
  assert.equal((await x.signer.post(`/sign/${x.tok}/complete`, x.finish())).data.envelope_status, 'completed');
  tooLate.arrive();
  assert.equal((await tooLate.answer).status, 400, 'a completed envelope cannot be voided');
  assert.equal(statusOf(x.id), 'completed');
  assert.deepEqual(auditOf(x.id, 'Envelope completed', 'Envelope voided'), ['Envelope completed']);
  assert.equal(mailTo('cross@example.com').filter((m: any) => m.subject.startsWith('Voided')).length, 0);

  // The same for more time: a deadline pushed back as the last person signs must not reopen what is complete.
  const y = await ready(racer, 'extend@example.com', 'Extend crosses finish');
  const moreTime = held(racer, 'POST', `/envelopes/${y.id}/extend`, { days: 5 });
  assert.equal((await y.signer.post(`/sign/${y.tok}/complete`, y.finish())).status, 200);
  moreTime.arrive();
  assert.equal((await moreTime.answer).status, 400);
  assert.equal(statusOf(y.id), 'completed');
});

test('reminding or voiding a whole batch finishes its list when someone signs while it is at work', async () => {
  const owner = await signUp('Vera Batch', 'vera.batch@example.com', newIp());
  const tpl = await template(owner);
  const rows = list('bv', 5);
  const sent = await owner.post('/bulk', { template_id: tpl.id, rows });
  assert.equal(sent.data.sent, 5, JSON.stringify(sent.data));
  const bid = sent.data.id;
  // The envelopes in the order the batch routes go through them, and the person each one went to.
  const order: string[] = db.all("SELECT id FROM envelopes WHERE bulk_id=? AND status='sent'", bid).map((e: any) => e.id);
  const who = order.map((id) => db.get('SELECT email FROM recipients WHERE envelope_id=?', id).email as string);
  const got = (subject: string) => who.map((email) => mailTo(email).filter((m: any) => m.subject === subject).length);
  try {
    // The reminder for the first person is with the mail server when the second person finishes signing.
    let stalled = stallMailTo(who[0]);
    const reminding = owner.post(`/bulk/${bid}/remind`);
    await stalled;
    assert.equal((await signAll(order[1], who[1])).status, 200);
    smtp.release();
    const reminded = await reminding;
    assert.equal(reminded.status, 200, JSON.stringify(reminded.data));
    assert.equal(reminded.data.reminded, 4, 'everyone still waiting was reminded');
    assert.deepEqual(got('Reminder: Waiver'), [1, 0, 1, 1, 1], 'and the person who had just finished was not');

    // The same for a void: the first envelope is voided and its email is on its way when the third person signs.
    stalled = stallMailTo(who[0]);
    const voiding = owner.post(`/bulk/${bid}/void`, { reason: 'Wrong list' });
    await stalled;
    assert.equal((await signAll(order[2], who[2])).status, 200);
    smtp.release();
    const voided = await voiding;
    assert.equal(voided.status, 200, JSON.stringify(voided.data));
    assert.deepEqual(voided.data, { voided: 3, skipped: 1 }, 'the answer says how many were voided and how many had closed by their turn');
    assert.deepEqual(order.map(statusOf), ['voided', 'completed', 'completed', 'voided', 'voided'], 'nothing is left out for signature');
    assert.deepEqual(order.map((id) => auditOf(id, 'Envelope voided').length), [1, 0, 0, 1, 1]);
    assert.deepEqual(got('Voided: Waiver'), [1, 0, 0, 1, 1], 'only the people whose envelope was voided are told so');
  } finally {
    mailBackToNormal();
  }

  // Void pressed twice on a batch: the two calls go through the same list, and each envelope is voided by one of them.
  const more = list('bw', 3);
  const second = (await owner.post('/bulk', { template_id: tpl.id, rows: more })).data;
  const [a, b] = await Promise.all([owner.post(`/bulk/${second.id}/void`, { reason: 'Sent twice' }), owner.post(`/bulk/${second.id}/void`, { reason: 'Sent twice' })]);
  assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.data, b.data]));
  assert.equal(a.data.voided + b.data.voided, 3);
  assert.deepEqual(second.results.map((r: any) => [statusOf(r.id), auditOf(r.id, 'Envelope voided').length]), [['voided', 1], ['voided', 1], ['voided', 1]]);
  assert.deepEqual(emailsOf(more).map((email) => mailTo(email).filter((m: any) => m.subject === 'Voided: Waiver').length), [1, 1, 1]);
});

test('a save from the editor that crosses Send is recorded as a correction, not written over a sent envelope unseen', async () => {
  const e = await simple(racer, 'autosave@example.com', { subject: 'Before send' });
  const cur = (await racer.get(`/envelopes/${e.id}`)).data.envelope;
  const state = {
    subject: 'Changed while sending',
    documents: cur.documents.map((d: any) => ({ id: d.id, file_id: d.file_id, name: d.name })),
    recipients: cur.recipients.map((r: any) => ({ id: r.id, role: r.role, name: r.name, email: r.email, routing_order: r.routing_order })),
    fields: cur.fields.map((f: any) => ({ id: f.id, document_id: f.document_id, recipient_id: f.recipient_id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h })),
  };
  // The editor's save is on its way when Send is pressed, and its body lands after the envelope has gone out.
  const save = held(racer, 'PUT', `/envelopes/${e.id}`, state);
  assert.equal((await racer.post(`/envelopes/${e.id}/send`)).status, 200);
  save.arrive();
  assert.equal((await save.answer).status, 200);
  assert.equal(statusOf(e.id), 'sent');
  assert.deepEqual(auditOf(e.id, 'Envelope sent', 'Envelope corrected'), ['Envelope sent', 'Envelope corrected']);
  assert.equal(mailTo('autosave@example.com').length, 1, 'the signer keeps the one link they were sent');
  assert.equal((await new Client().get(`/sign/${tokenFor(e.id, 'autosave@example.com')}`)).status, 200);
});

// ---- 5. Signed PDFs made from fillable forms -----------------------------------------------------------------

const N = (s: string) => PDFName.of(s);
// A form with a filled text field, a ticked box and an empty digital-signature field, in either order.
async function formPdf(signatureFirst: boolean) {
  const d = await PDFDocument.create();
  const page = d.addPage([612, 792]);
  page.drawText('Form with fillable fields', { x: 72, y: 720 });
  const form = d.getForm();
  const emptySignature = () => {
    const ref = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'), Rect: [72, 500, 272, 560], P: page.ref, F: 4 }));
    page.node.addAnnot(ref);
    form.acroForm.addField(ref);
  };
  if (signatureFirst) emptySignature();
  const name = form.createTextField('client.name');
  name.setText('Prefilled Client Name');
  name.addToPage(page, { x: 72, y: 640, width: 220, height: 22 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 72, y: 600, width: 14, height: 14 });
  agree.check();
  if (!signatureFirst) emptySignature();
  return d.save();
}
// Uploads the source, sends it to one signer and signs it. With `attach`, the signer is also asked for a file and
// uploads that one. Returns the signed PDF as the sender downloads it.
async function signedPdfOf(owner: Client, source: Uint8Array, email: string, attach?: Uint8Array) {
  const pdfForm = (bytes: Uint8Array, name: string) => {
    const f = new FormData();
    f.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
    return f;
  };
  const up = await owner.call('POST', '/files', pdfForm(source, 'Form.pdf'));
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const made = await owner.post('/envelopes', {
    subject: 'Flatten check', send: true, documents: [{ id: 'd', file_id: up.data.id }], recipients: [{ id: 'r', role: 'signer', name: 'Flat Signer', email }],
    fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.08 }, ...(attach ? [{ document_id: 'd', recipient_id: 'r', type: 'attachment', page: 0, x: 0.5, y: 0.7, w: 0.3, h: 0.04 }] : [])],
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const tok = tokenFor(made.data.envelope.id, email);
  const signer = new Client();
  await signer.post(`/sign/${tok}/consent`);
  const fields = (await signer.get(`/sign/${tok}`)).data.fields;
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.type !== 'attachment') values[field.id] = '1';
    else {
      const sent = await signer.call('POST', `/sign/${tok}/upload`, pdfForm(attach!, 'Attachment.pdf'));
      assert.equal(sent.status, 200, JSON.stringify(sent.data));
      values[field.id] = sent.data.id;
    }
  }
  assert.equal((await signer.post(`/sign/${tok}/complete`, { values, signature_png: PNG })).status, 200);
  const pdf = (await owner.get(`/envelopes/${made.data.envelope.id}/download`)).data as Uint8Array;
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), '%PDF-');
  return pdf;
}
// Every entry in a page's annotation list, looked up. An entry that points at a missing object comes back undefined.
async function annotations(pdf: Uint8Array) {
  const d = await PDFDocument.load(pdf);
  return d.getPages().flatMap((p) => {
    const annots = p.node.Annots();
    return Array.from({ length: annots?.size() ?? 0 }, (_, i) => annots!.lookup(i));
  });
}
const havePoppler = spawnSync('which', ['pdftotext']).status === 0 && spawnSync('which', ['pdftoppm']).status === 0;

test('a signed PDF made from a fillable form has no broken annotation entries and no field left to fill or sign', async () => {
  const owner = await signUp('Pat Forms', 'pat.forms@example.com', newIp());
  for (const signatureFirst of [false, true]) {
    const pdf = await signedPdfOf(owner, await formPdf(signatureFirst), `flat${signatureFirst ? 1 : 2}@example.com`);
    const found = await annotations(pdf);
    assert.ok(found.every((a) => a instanceof PDFDict), 'every /Annots entry points at an object that exists');
    assert.equal(found.filter((a) => a instanceof PDFDict && a.lookup(N('Subtype')) === N('Widget')).length, 0, 'no form field is left, the empty signature box included');
    assert.equal(found.length, 0, 'the form had nothing but fields on its page');

    // The same file read by another PDF library. A broken entry shows up there as "Syntax Error: Invalid XRef entry".
    if (!havePoppler) continue;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'growsigning-pdf-')), 'signed.pdf');
    fs.writeFileSync(file, pdf);
    const text = spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' });
    assert.equal(text.status, 0, text.stderr);
    assert.equal(text.stderr, '', 'pdftotext reads it without a complaint');
    assert.match(text.stdout, /Form with fillable fields/);
    assert.match(text.stdout, /Prefilled Client Name/, 'what was filled in is now part of the page');
    const image = spawnSync('pdftoppm', ['-r', '30', '-png', file, file.replace(/\.pdf$/, '')], { encoding: 'utf8' });
    assert.equal(image.status, 0, image.stderr);
    assert.equal(image.stderr, '', 'pdftoppm draws it without a complaint');
  }
});

test('a fillable form that the signer attaches is made flat in the signed PDF, like the documents that were sent', async () => {
  const owner = await signUp('Ann Attach', 'ann.attach@example.com', newIp());
  const plain = await PDFDocument.create();
  plain.addPage([612, 792]).drawText('Please attach your form', { x: 72, y: 720 });
  // What signers attach is very often a form: a tax or bank form with their details typed in and a box to sign.
  const pdf = await signedPdfOf(owner, await plain.save(), 'attach@example.com', await formPdf(false));
  const pages = (await PDFDocument.load(pdf)).getPages();
  assert.ok(pages.length >= 3, 'the document, the attachment and the certificate are all there');
  assert.equal(pages[1].node.Annots()?.size() ?? 0, 0, 'the attached page has no field left to fill in or sign, the empty signature box included');
  const found = await annotations(pdf);
  assert.ok(found.every((a) => a instanceof PDFDict), 'every /Annots entry points at an object that exists');
  assert.equal(found.filter((a) => a instanceof PDFDict && a.lookup(N('Subtype')) === N('Widget')).length, 0);

  if (!havePoppler) return;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'growsigning-pdf-')), 'signed.pdf');
  fs.writeFileSync(file, pdf);
  const text = spawnSync('pdftotext', ['-f', '2', '-l', '2', file, '-'], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stderr, '', 'pdftotext reads it without a complaint');
  assert.match(text.stdout, /Form with fillable fields/);
  assert.match(text.stdout, /Prefilled Client Name/, 'what the signer typed into the form is now part of the page');
  // pdfsig lists digital-signature fields. A box left waiting would show as a signature field that is not signed.
  if (spawnSync('which', ['pdfsig']).status !== 0) return;
  const sig = spawnSync('pdfsig', [file], { encoding: 'utf8' });
  assert.doesNotMatch(sig.stdout + sig.stderr, /is not signed|Signature Field Name/);
});

test('a page whose annotation list cannot be read does not stop the signing, and a signer does not lose an attachment over it', async () => {
  const owner = await signUp('Mal Formed', 'mal.formed@example.com', newIp());
  // Some tools write /Annots as something that is not a list. No reader shows anything from it.
  const odd = async (label: string) => {
    const d = await PDFDocument.create();
    const page = d.addPage([612, 792]);
    page.drawText(label, { x: 72, y: 720 });
    page.node.set(N('Annots'), d.context.obj({ Broken: 1 }));
    return d.save();
  };
  // As the document that is sent: Finish works and the signed PDF can be downloaded (signedPdfOf checks both).
  const asDocument = await signedPdfOf(owner, await odd('Odd document'), 'odd1@example.com');
  // As a file the signer attaches: its page is in the signed PDF, after the document and before the certificate.
  const asAttachment = await signedPdfOf(owner, await odd('Odd document'), 'odd2@example.com', await odd('Odd attachment'));
  const pagesIn = async (pdf: Uint8Array) => (await PDFDocument.load(pdf)).getPageCount();
  assert.equal(await pagesIn(asAttachment), (await pagesIn(asDocument)) + 1, 'the attached page was not left out');
  // annotations() reads every page's list, which it could not do if the unreadable entry had been carried over.
  assert.deepEqual(await annotations(asDocument), []);
  assert.deepEqual(await annotations(asAttachment), []);
  if (!havePoppler) return;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'growsigning-pdf-')), 'signed.pdf');
  fs.writeFileSync(file, asAttachment);
  const text = spawnSync('pdftotext', ['-f', '2', '-l', '2', file, '-'], { encoding: 'utf8' });
  assert.equal(text.stderr, '', 'pdftotext reads it without a complaint');
  assert.match(text.stdout, /Odd attachment/);
});

test('a filled field that cannot be drawn stays in the signed PDF as it was, so what it says is not lost', async () => {
  const owner = await signUp('Una Code', 'una@example.com', newIp());
  const d = await PDFDocument.create();
  const page = d.addPage([612, 792]);
  page.drawText('A form filled in by a tool that drew no pictures', { x: 72, y: 720 });
  // Text the built-in font cannot write, in a field that came without a picture of itself.
  const place = d.getForm().createTextField('place');
  place.addToPage(page, { x: 72, y: 640, width: 220, height: 22 });
  place.acroField.dict.set(N('V'), PDFHexString.fromText('Ωmega Ωmega'));
  for (const w of place.acroField.getWidgets()) w.dict.delete(N('AP'));
  const found = await annotations(await signedPdfOf(owner, await d.save({ updateFieldAppearances: false }), 'omega@example.com'));
  assert.equal(found.length, 1);
  assert.ok(found[0] instanceof PDFDict, 'it still points at a real object');
  // The value sits on the field, which is the box on the page itself or its parent.
  const field = found[0].lookup(N('V')) ? found[0] : (found[0].lookup(N('Parent')) as PDFDict);
  assert.equal((field.lookup(N('V')) as PDFHexString).decodeText(), 'Ωmega Ωmega');
});
