// Tests for the things built in answer to common complaints about e-signature tools:
// fixing a sent envelope, lost links, deadlines, fake emails, noisy notifications, data ownership, team continuity.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, PNG, draft, simple, tokenFor, signUp, signAll, mailTo, type Server } from './helpers.ts';

let db: Server['db'];
let env: Server['env'];
let cron: Server['cron'];
let jo: Client;
before(async () => {
  ({ db, env, cron } = await boot());
  jo = await signUp('Jo Sender', 'jo@example.com');
});

const full = async (c: Client, id: string) => (await c.get(`/envelopes/${id}`)).data;
// The editor sends back the whole envelope; this builds that body from what the server returns.
const asBody = (e: any) => ({ subject: e.subject, message: e.message, ordered: e.ordered, documents: e.documents, recipients: e.recipients, fields: e.fields });

test('a sent envelope can be corrected without voiding it', async () => {
  const e0 = await draft(jo, { ordered: false });
  await jo.post(`/envelopes/${e0.id}/send`);
  let e = (await full(jo, e0.id)).envelope;
  const adaToken = tokenFor(e.id, 'ada@example.com');
  const benToken = tokenFor(e.id, 'ben@example.com');

  // Nobody has signed: move a field, fix Ben's email, drop the copy recipient, add a new signer.
  const body = asBody(e);
  body.fields.find((f: any) => f.type === 'text').x = 0.5;
  body.recipients.find((r: any) => r.email === 'ben@example.com').email = 'benjamin@example.com';
  body.recipients = body.recipients.filter((r: any) => r.role !== 'cc');
  body.recipients.push({ id: 'new1', role: 'signer', name: 'Dee New', email: 'dee@example.com', routing_order: 1 });
  body.fields.push({ id: 'nf', document_id: e.documents[0].id, recipient_id: 'new1', type: 'signature', page: 0, x: 0.6, y: 0.2, w: 0.2, h: 0.05 });
  const r = await jo.put(`/envelopes/${e.id}`, body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  e = r.data.envelope;
  assert.equal(e.status, 'sent');
  assert.equal(e.recipients.length, 3);
  assert.equal(tokenFor(e.id, 'ada@example.com'), adaToken, 'an untouched signer keeps the same link');
  assert.ok(mailTo('ada@example.com').some((m) => m.subject.startsWith('Updated:')), 'and is told the document changed');
  assert.equal((await new Client().get(`/sign/${benToken}`)).status, 410, 'the replaced address has a retired link');
  assert.ok(tokenFor(e.id, 'benjamin@example.com'));
  assert.ok(mailTo('dee@example.com').length === 1, 'the new signer is invited');
  assert.equal((await full(jo, e.id)).audit.some((a: any) => a.action === 'Envelope corrected'), true);

  // Ada signs. Now what she signed is locked, but the others can still be changed.
  assert.equal((await signAll(e.id, 'ada@example.com')).status, 200);
  e = (await full(jo, e.id)).envelope;
  const adaId = e.recipients.find((x: any) => x.email === 'ada@example.com').id;
  const rewrite = asBody(e);
  rewrite.fields.find((f: any) => f.recipient_id === adaId && f.type === 'text').value = 'tampered';
  assert.equal((await jo.put(`/envelopes/${e.id}`, rewrite)).status, 200);
  assert.equal(((await full(jo, e.id)).envelope.fields.find((f: any) => f.type === 'text').value), 'filled in', 'what a finished signer wrote cannot be rewritten');
  e = (await full(jo, e.id)).envelope;
  const moved = asBody(e);
  moved.fields.find((f: any) => f.recipient_id === adaId && f.type === 'signature').y = 0.1;
  assert.equal((await jo.put(`/envelopes/${e.id}`, moved)).status, 409, 'and their signature cannot be moved somewhere else on the page');
  e = (await full(jo, e.id)).envelope;
  const swapDoc = asBody(e);
  swapDoc.documents = [];
  assert.notEqual((await jo.put(`/envelopes/${e.id}`, swapDoc)).status, 200, 'cannot pull the document out from under a signature');
  assert.equal(((await full(jo, e.id)).envelope.fields.find((f: any) => f.type === 'text').value), 'filled in', 'a rejected correction changes nothing');

  // Taking Dee and her field off the pages Ada signed changes what is printed on them. That is refused, unless the
  // sender chooses to ask Ada to sign again. What does not touch the pages can still change for the others.
  e = (await full(jo, e.id)).envelope;
  const ok = asBody(e);
  ok.recipients = ok.recipients.filter((x: any) => x.email !== 'dee@example.com');
  ok.fields = ok.fields.filter((f: any) => ok.recipients.some((x: any) => x.id === f.recipient_id));
  const asked = await jo.put(`/envelopes/${e.id}`, ok);
  assert.equal(asked.status, 409);
  assert.equal(asked.data.code, 'sign_again');
  const renamed = asBody(e);
  renamed.recipients = renamed.recipients.map((x: any) => (x.email === 'dee@example.com' ? { ...x, name: 'Dee Newer' } : x));
  assert.equal((await jo.put(`/envelopes/${e.id}`, renamed)).status, 200, 'the remaining recipients can still be changed');
  assert.equal((await jo.put(`/envelopes/${e.id}`, { ...ok, resign: true })).status, 200, 'and the pages too, once the sender asks Ada to sign again');
  assert.ok(mailTo('dee@example.com').some((m) => m.subject.startsWith('No longer needed')));
  assert.ok(mailTo('ada@example.com').at(-1)!.subject.startsWith('Changed after you finished:'));
  assert.equal((await signAll(e.id, 'ada@example.com')).status, 200, 'Ada signs again');

  // Ben (now benjamin) signs and the corrected envelope completes normally.
  const ben = new Client();
  const bt = tokenFor(e.id, 'benjamin@example.com');
  await ben.post(`/sign/${bt}/unlock`, { code: '4242' });
  await ben.post(`/sign/${bt}/consent`);
  const v = (await ben.get(`/sign/${bt}`)).data;
  const done = await ben.post(`/sign/${bt}/complete`, { values: { [v.fields.find((f: any) => f.type === 'signature').id]: '1' }, signature_png: PNG });
  assert.equal(done.data.envelope_status, 'completed');
  assert.equal((await full(jo, e.id)).chain.ok, true);
});

test('lost and replaced links are recoverable without the sender', async () => {
  const e = await simple(jo, 'lost@example.com');
  await jo.post(`/envelopes/${e.id}/send`);
  const old = tokenFor(e.id, 'lost@example.com');
  const rid = (await full(jo, e.id)).envelope.recipients[0].id;
  await jo.post(`/envelopes/${e.id}/correct`, { recipient_id: rid, name: 'Sam Signer', email: 'found@example.com' });

  const anon = new Client();
  assert.equal((await anon.get(`/sign/${old}`)).status, 410);
  assert.equal((await anon.post('/public/links/resend', { token: old })).status, 200);
  const fresh = mailTo('found@example.com').at(-1)!;
  assert.match(fresh.html, /You asked for a fresh link/);
  assert.equal((await anon.get(fresh.link.replace('http://test.local', '').replace('/sign/', '/sign/'))).status, 200);

  // "I cannot find the email": the links go to that inbox and nowhere else.
  const before = mailTo('found@example.com').length;
  assert.equal((await anon.post('/public/links/find', { email: 'found@example.com' })).status, 200);
  const list = mailTo('found@example.com');
  assert.equal(list.length, before + 1);
  assert.match(list.at(-1)!.html, /Simple agreement/);
  assert.equal((await anon.post('/public/links/find', { email: 'nobody@example.com' })).status, 200, 'same answer when nothing is found');
  assert.equal(mailTo('nobody@example.com').length, 0);
  assert.equal((await anon.get('/sign/not-a-real-token')).status, 404);
});

test('deadlines: a warning first, then more time on request, and reopening instead of starting over', async () => {
  const e = await draft(jo, { ordered: false, expire_days: 10 });
  await jo.post(`/envelopes/${e.id}/send`);
  await signAll(e.id, 'ada@example.com');

  // Three days out: one warning to whoever is still waiting, and to the sender.
  db.run('UPDATE envelopes SET expires_at=?, sent_at=? WHERE id=?', new Date(Date.now() + 2 * 864e5).toISOString(), new Date(Date.now() - 8 * 864e5).toISOString(), e.id);
  assert.equal((await cron.tick()).warned, 1);
  assert.equal((await cron.tick()).warned, 0, 'only warned once');
  assert.ok(mailTo('ben@example.com').some((m) => m.subject.startsWith('Expires soon:')));

  db.run('UPDATE envelopes SET expires_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), e.id);
  assert.equal((await cron.tick()).expired, 1);
  const ben = new Client();
  const bt = tokenFor(e.id, 'ben@example.com');
  assert.equal((await ben.get(`/sign/${bt}`)).data.envelope.status, 'expired');
  assert.equal((await ben.post(`/sign/${bt}/request-extension`)).status, 200);
  assert.ok(mailTo('jo@example.com').some((m) => m.subject.startsWith('More time needed:')));

  // Reopen: same links, and Ada does not have to sign again.
  assert.equal((await jo.post(`/envelopes/${e.id}/extend`, { days: 14 })).status, 200);
  const cur = (await full(jo, e.id)).envelope;
  assert.equal(cur.status, 'sent');
  assert.equal(cur.recipients.find((r: any) => r.email === 'ada@example.com').status, 'completed');
  assert.equal(tokenFor(e.id, 'ben@example.com'), bt);
  assert.ok(mailTo('ben@example.com').some((m) => m.subject.startsWith('Reopened:')));
});

test('recipients can check that an email is genuine, stop reminders, and report a suspicious request', async () => {
  const e = await simple(jo, 'wary@example.com');
  await jo.post(`/envelopes/${e.id}/send`);
  const mail = mailTo('wary@example.com').at(-1)!;
  const code = /letter-spacing:1px[^>]*>([A-Z0-9-]{14})</.exec(mail.html)?.[1];
  assert.ok(code, 'the email carries a security code');
  assert.match(mail.html, /Jo Sender \(jo@example\.com\)/, 'and says plainly who sent it');

  const anon = new Client();
  const ok = (await anon.post('/public/check', { code: code!.toLowerCase() })).data;
  assert.equal(ok.genuine, true);
  assert.equal(ok.sender.email, 'jo@example.com');
  assert.match(ok.url, /\/sign\//);
  assert.equal((await anon.post('/public/check', { code: 'AAAA-BBBB-CCCC' })).data.genuine, false);
  assert.equal((await anon.post('/public/check', { code: 'short' })).status, 400);

  const tok = tokenFor(e.id, 'wary@example.com');
  assert.equal((await anon.post(`/sign/${tok}/mute`)).status, 200);
  assert.equal((await jo.post(`/envelopes/${e.id}/remind`)).data.reminded, 0, 'muted recipients are not reminded');

  // Three different recipients report this sender: sending pauses until a person reviews it.
  const bad = await signUp('Mallory', 'mallory@example.com');
  for (const victim of ['v1@example.com', 'v2@example.com', 'v3@example.com']) {
    const x = await simple(bad, victim, { subject: 'Invoice overdue' });
    assert.equal((await bad.post(`/envelopes/${x.id}/send`)).status, 200);
    const t = tokenFor(x.id, victim);
    assert.equal((await new Client().post(`/sign/${t}/report`, { reason: 'phishing', detail: 'I never ordered this' })).status, 200);
    await new Client().post(`/sign/${t}/report`, { reason: 'phishing' }); // reporting twice counts once
  }
  assert.equal((await bad.get('/me')).data.account.paused != null, true);
  const blocked = await simple(bad, 'v4@example.com');
  assert.equal((await bad.post(`/envelopes/${blocked.id}/send`)).status, 403, 'paused accounts cannot send');
  assert.equal((await bad.get('/export')).status, 200, 'but they keep access to their documents');

  // The review queue is only visible to the people running the service.
  assert.equal((await jo.get('/operator/queue')).status, 404);
  process.env.OPERATOR_EMAILS = 'jo@example.com';
  const q = (await jo.get('/operator/queue')).data;
  assert.equal(q.reports.length, 3);
  assert.equal(q.paused.length, 1);
  assert.equal((await jo.post(`/operator/accounts/${q.paused[0].id}`, { paused: false })).status, 200);
  assert.equal((await bad.post(`/envelopes/${blocked.id}/send`)).status, 200);
  delete process.env.OPERATOR_EMAILS;
});

test('notifications are quiet by default and adjustable', async () => {
  const e = await draft(jo, { ordered: false, subject: 'Quiet one' });
  await jo.post(`/envelopes/${e.id}/send`);
  await signAll(e.id, 'ada@example.com');
  assert.equal(mailTo('jo@example.com').filter((m) => m.subject.includes('Quiet one')).length, 0, 'no email per signature by default');

  assert.equal((await jo.call('PATCH', '/me', { notify: { signed: true, viewed: true, bogus: true } })).status, 200);
  assert.deepEqual((await jo.get('/me')).data.user.notify, { viewed: true, signed: true, completed: true, problems: true });
  const e2 = await draft(jo, { ordered: false, subject: 'Chatty one' });
  await jo.post(`/envelopes/${e2.id}/send`);
  await signAll(e2.id, 'ada@example.com');
  const got = mailTo('jo@example.com').filter((m) => m.subject.includes('Chatty one')).map((m) => m.subject);
  assert.ok(got.some((s) => s.startsWith('Opened:')) && got.some((s) => s.startsWith('Signed:')));
  await jo.call('PATCH', '/me', { notify: { signed: false, viewed: false } });
});

test('everything can be exported, and the sender sees whether emails went out', async () => {
  const e = await simple(jo, 'zip@example.com', { subject: 'Zip me: a/b?' });
  await jo.post(`/envelopes/${e.id}/send`);
  await signAll(e.id, 'zip@example.com');
  const detail = await full(jo, e.id);
  assert.ok(detail.deliveries.some((d: any) => d.to_email === 'zip@example.com' && d.status === 'outbox'));

  const zip = (await jo.get('/export')).data as Uint8Array;
  const buf = Buffer.from(zip);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'starts with a ZIP local header');
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50, 'ends with a ZIP end record');
  const names: string[] = [];
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const n = buf.readUInt16LE(p + 28);
    names.push(buf.subarray(p + 46, p + 46 + n).toString('utf8'));
    p += 46 + n;
  }
  assert.ok(names.includes('envelopes.csv') && names.includes('README.txt'));
  assert.ok(names.some((n) => n.startsWith('signed/') && n.endsWith('.pdf') && !/[?]/.test(n) && n.split('/').length === 2), names.join(', '));
  assert.ok(names.some((n) => n.startsWith('audit/')));
});

test('a team never loses documents when someone leaves, and ownership can move', async () => {
  await jo.post('/account/invites', { email: 'pat@example.com', role: 'admin' });
  const inv = db.get("SELECT token FROM invites WHERE email='pat@example.com'").token;
  const pat = new Client();
  await pat.post('/auth/signup', { name: 'Pat Member', email: 'pat@example.com', password: 'password123', invite: inv });
  const e = await simple(pat, 'client@example.com', { subject: 'Pat sent this' });
  assert.equal((await pat.post(`/envelopes/${e.id}/send`)).status, 200);
  const patId = (await pat.get('/me')).data.user.id;

  assert.equal((await pat.post('/account/transfer-owner', { user_id: patId })).status, 403, 'only the owner can hand over');
  assert.equal((await jo.post('/account/transfer-owner', { user_id: patId })).status, 200);
  assert.equal((await pat.get('/me')).data.role, 'owner');
  assert.equal((await jo.get('/me')).data.role, 'admin');
  assert.equal((await pat.post('/account/transfer-owner', { user_id: (await jo.get('/me')).data.user.id })).status, 200);

  assert.equal((await jo.call('DELETE', `/account/members/${patId}`)).status, 200);
  const moved = db.get('SELECT sender_id FROM envelopes WHERE id=?', e.id).sender_id;
  assert.equal(moved, (await jo.get('/me')).data.user.id, 'their envelopes pass to the admin who removed them');
  assert.equal((await pat.get('/envelopes')).status, 401);
});

test('support is open to anyone, and an account can be closed for good', async () => {
  const anon = new Client();
  assert.equal((await anon.post('/public/support', { email: 'nope', message: 'help me please' })).status, 400);
  const r = await anon.post('/public/support', { email: 'stuck@example.com', name: 'Stuck', topic: 'cannot-log-in', message: 'I cannot get into my account and I am being charged.' });
  assert.equal(r.status, 200);
  assert.match(r.data.reference, /^[A-Z0-9_-]{8}$/i);
  assert.ok(mailTo('stuck@example.com').some((m) => m.subject.includes(r.data.reference)));
  assert.equal(db.get('SELECT COUNT(*) n FROM support_requests').n, 1);

  // Closing keeps everything for 30 days, and signing in again undoes it.
  const gone = await signUp('Gone Soon', 'gone@example.com');
  const e = await simple(gone, 'x@example.com');
  await gone.post(`/envelopes/${e.id}/send`);
  assert.equal((await gone.get('/me/delete')).data.owned[0].in_flight, 1);
  assert.equal((await gone.post('/me/delete', { password: 'wrong' })).status, 400);
  const closing = await gone.post('/me/delete', { password: 'correct horse battery' });
  assert.equal(closing.data.closed, 'scheduled');
  assert.equal((await gone.get('/envelopes')).status, 401, 'signed out');
  assert.equal((await cron.tick()).purged, 0, 'nothing is removed during the grace period');
  const back = await gone.post('/auth/login', { email: 'gone@example.com', password: 'correct horse battery' });
  assert.equal(back.data.restored, true);
  assert.equal((await gone.get(`/envelopes/${e.id}`)).status, 200, 'everything is still there');

  // Past the grace period (or with "now"), it is really gone.
  await gone.post('/me/delete', { password: 'correct horse battery' });
  db.run("UPDATE users SET closing_at=? WHERE email='gone@example.com'", new Date(Date.now() - 1000).toISOString());
  assert.equal((await cron.tick()).purged, 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM users WHERE email='gone@example.com'").n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', e.id).n, 0);
  const quick = await signUp('Quick Exit', 'quick@example.com');
  assert.equal((await quick.post('/me/delete', { password: 'correct horse battery', now: true })).data.closed, 'now');
  assert.equal(db.get("SELECT COUNT(*) n FROM users WHERE email='quick@example.com'").n, 0);
});

test('signers can ask the sender a question; one recipient can be nudged; batches act as one', async () => {
  const e = await draft(jo, { ordered: false, subject: 'Ask me' });
  await jo.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'ada@example.com');
  assert.equal((await new Client().post(`/sign/${tok}/ask`, { message: 'Is clause 4 still right?' })).status, 200);
  const q = mailTo('jo@example.com').at(-1)!;
  assert.match(q.subject, /^Question about:/);
  assert.match(q.html, /clause 4/);

  const rid = (await full(jo, e.id)).envelope.recipients.find((r: any) => r.email === 'ben@example.com').id;
  assert.equal((await jo.post(`/envelopes/${e.id}/remind`, { recipient_id: rid })).data.reminded, 1);

  const tpl = await simple(jo, '', { kind: 'template', subject: 'Batch form', recipients: [{ id: 'r', role: 'signer', role_name: 'Member' }] });
  const bulk = await jo.post('/bulk', { template_id: tpl.id, rows: [{ Member: { name: 'M One', email: 'm1@example.com' } }, { Member: { name: 'M Two', email: 'm2@example.com' } }] });
  assert.equal(bulk.data.sent, 2);
  await signAll(bulk.data.results[0].id, 'm1@example.com');
  const view = (await jo.get(`/bulk/${bulk.data.id}`)).data;
  assert.deepEqual(view.envelopes.map((x: any) => x.status).sort(), ['completed', 'sent']);
  assert.equal((await jo.post(`/bulk/${bulk.data.id}/remind`)).data.reminded, 1);
  assert.equal((await jo.post(`/bulk/${bulk.data.id}/void`, { reason: 'Wrong form' })).data.voided, 1);
  assert.equal((await new Client().get(`/bulk/${bulk.data.id}`)).status, 401);
});

test('new free accounts cannot send fake payment notices; signing your own document is always free', async () => {
  const scam = await signUp('Scam Mer', 'scam@example.com');
  const s = await simple(scam, 'victim@example.com', { subject: 'PayPal invoice #4471', message: 'Your payment of $499 was charged. To cancel call +1 (888) 555-0142 now.' });
  const blocked = await scam.post(`/envelopes/${s.id}/send`);
  assert.equal(blocked.status, 422);
  assert.match(blocked.data.error, /contact form/);
  const fine = await simple(scam, 'client@example.com', { subject: 'Invoice 12 for garden work', message: 'Thanks for your business.' });
  assert.equal((await scam.post(`/envelopes/${fine.id}/send`)).status, 200, 'ordinary invoices are not caught');

  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const solo = await signUp('Solo Signer', 'solo@example.com');
  for (let i = 0; i < 7; i++) {
    const x = await simple(solo, 'solo@example.com');
    assert.equal((await solo.post(`/envelopes/${x.id}/send`)).status, 200, `self-signed document ${i + 1}`);
    assert.equal((await signAll(x.id, 'solo@example.com')).status, 200);
  }
  assert.deepEqual((await solo.get('/billing')).data.signatures, { balance: 3, held: 0, available: 3 }, 'none of the free signatures were touched');
  delete process.env.STRIPE_SECRET_KEY;
});

test('public forms do not multiply envelopes, and dates follow the chosen format', async () => {
  const tplE = await simple(jo, '', { kind: 'template', subject: 'Waiver', date_format: 'DD/MM/YYYY',
    recipients: [{ id: 'r', role: 'signer', role_name: 'Volunteer' }],
  });
  const body = asBody((await full(jo, tplE.id)).envelope);
  body.fields.push({ id: 'd8', document_id: body.documents[0].id, recipient_id: body.recipients[0].id, type: 'date_signed', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.03 });
  assert.equal((await jo.put(`/envelopes/${tplE.id}`, { ...body, date_format: 'DD/MM/YYYY' })).status, 200);
  await jo.post('/powerforms', { template_id: tplE.id, name: 'Sign the waiver' });
  const slug = (await jo.get('/powerforms')).data.powerforms[0].slug;
  // The same person is whoever comes back in the same browser. An email address alone proves nothing, so someone
  // else typing it gets a document of their own (tests/abuse.test.ts covers that).
  const walkIn = new Client();
  const a = await walkIn.post(`/public/powerforms/${slug}/start`, { name: 'Walk In', email: 'walk@example.com' });
  const b = await walkIn.post(`/public/powerforms/${slug}/start`, { name: 'Walk In', email: 'walk@example.com' });
  assert.equal(a.data.url, b.data.url, 'the same person gets the same envelope back');
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE powerform_id IS NOT NULL').n, 1);

  const tok = a.data.url.split('/sign/')[1];
  const c = new Client();
  assert.equal((await c.get(`/sign/${tok}`)).data.envelope.date_format, 'DD/MM/YYYY');
  const id = db.get('SELECT envelope_id e FROM recipients WHERE token=?', tok).e;
  await signAll(id, 'walk@example.com');
  const done = env.loadEnvelope(id);
  const { fieldDisplayValue } = await import('../src/server/pdf.ts');
  assert.match(fieldDisplayValue(done.fields.find((f: any) => f.type === 'date_signed'), done.recipients[0], done.date_format), /^\d\d\/\d\d\/\d{4}$/);
});

test('envelopes can be found by the words inside their documents', async () => {
  const e = await simple(jo, 'search@example.com', { subject: 'Nothing to do with the contents' });
  const hit = (await jo.get('/envelopes?q=' + encodeURIComponent('Agreement page 1'))).data.envelopes;
  assert.ok(hit.some((x: any) => x.id === e.id), 'found by document text');
  assert.equal((await jo.get('/envelopes?q=zebra-crossing-xyz')).data.envelopes.length, 0);
  const other = await signUp('Other Team', 'otherteam@example.com');
  assert.equal((await other.get('/envelopes?q=' + encodeURIComponent('Agreement page 1'))).data.envelopes.length, 0, 'never across accounts');
});

test('small things that stop people getting stuck', async () => {
  const e = await draft(jo, { ordered: false, subject: 'Stuck test' });
  await jo.post(`/envelopes/${e.id}/send`);
  const info = async () => (await full(jo, e.id));
  const ada = (await info()).envelope.recipients.find((r: any) => r.email === 'ada@example.com');
  const tok = tokenFor(e.id, 'ada@example.com');

  // Fixing only a name keeps the same link (so embedded and already-emailed links keep working).
  assert.equal((await jo.post(`/envelopes/${e.id}/correct`, { recipient_id: ada.id, name: 'Ada S. Signer', email: 'ada@example.com' })).status, 200);
  assert.equal(tokenFor(e.id, 'ada@example.com'), tok);
  assert.equal((await new Client().get(`/sign/${tok}`)).data.recipient.name, 'Ada S. Signer');

  // A link opened fifty times still works.
  const many = new Client();
  for (let i = 0; i < 50; i++) await many.get(`/sign/${tok}`);
  assert.equal((await many.get(`/sign/${tok}`)).status, 200);

  // The signer fixes the spelling of their own name: logged, and the sender is told.
  assert.equal((await many.post(`/sign/${tok}/name`, { name: 'Ada Signer-Lovelace' })).status, 200);
  assert.ok((await info()).audit.some((a: any) => a.action === 'Signer corrected their name'));
  assert.ok(mailTo('jo@example.com').some((m) => m.subject.startsWith('Name corrected:')));

  // The sender sees how far each signer has got, without being able to sign for them.
  await many.post(`/sign/${tok}/consent`);
  const v = (await many.get(`/sign/${tok}`)).data;
  await many.post(`/sign/${tok}/save`, { values: { [v.fields.find((f: any) => f.type === 'text').id]: 'half way' } });
  const prog = (await info()).envelope.recipients.find((r: any) => r.email === 'ada@example.com').progress;
  assert.deepEqual(prog, { fields: 2, filled: 1, required_left: 1 });
  assert.equal((await many.get(`/sign/${tok}`)).data.fields.find((f: any) => f.type === 'text').value, 'half way', 'saved values come back');

  // Three wrong access codes: the signer is told who to ask, and the sender hears about it once.
  const ben = new Client();
  const bt = tokenFor(e.id, 'ben@example.com');
  let last: any;
  for (let i = 0; i < 3; i++) last = await ben.post(`/sign/${bt}/unlock`, { code: 'nope' });
  assert.match(last.data.error, /jo@example\.com/);
  assert.equal(mailTo('jo@example.com').filter((m) => m.subject === 'Could not open: Stuck test').length, 1);

  // Nobody opened it for two days: the sender is told once, with ways around email.
  db.run("UPDATE recipients SET sent_at=?, status='sent' WHERE envelope_id=? AND email='ben@example.com'", new Date(Date.now() - 3 * 864e5).toISOString(), e.id);
  assert.equal((await cron.tick()).unopened, 1);
  assert.equal((await cron.tick()).unopened, 0);
  assert.ok(mailTo('jo@example.com').some((m) => m.subject.startsWith('Not opened yet:')));

  // Admins can narrow the list to one sender; a scan is flagged at upload.
  const meId = (await jo.get('/me')).data.user.id;
  const list = (await jo.get(`/envelopes?sender=${meId}`)).data;
  assert.ok(list.envelopes.length > 0 && list.senders.some((x: any) => x.id === meId));
  const { PDFDocument } = await import('pdf-lib');
  const blank = await PDFDocument.create();
  blank.addPage([300, 300]);
  const f = new FormData();
  f.append('file', new Blob([await blank.save()], { type: 'application/pdf' }), 'scan.pdf');
  assert.equal((await jo.call('POST', '/files', f)).data.is_scan, true);
});

test('an editor opened earlier can never undo what a signer did', async () => {
  const e0 = await draft(jo, { ordered: false, subject: 'Stale editor' });
  await jo.post(`/envelopes/${e0.id}/send`);
  // The sender opens the editor now...
  const stale = asBody((await full(jo, e0.id)).envelope);
  // ...and meanwhile Ada types an answer and saves, and then finishes.
  const tok = tokenFor(e0.id, 'ada@example.com');
  const ada = new Client();
  await ada.post(`/sign/${tok}/consent`);
  const v = (await ada.get(`/sign/${tok}`)).data;
  const textId = v.fields.find((f: any) => f.type === 'text').id;
  await ada.post(`/sign/${tok}/save`, { values: { [textId]: '400 seedlings' }, signature_png: PNG });
  assert.ok((await new Client().get(`/sign/${tok}`)).data.recipient.signature_png, 'the chosen signature is kept for another device');

  // The sender saves the old editor state (which has that field empty) after moving one of Ben's fields.
  stale.fields.find((f: any) => f.type === 'checkbox').x = 0.6;
  assert.equal((await jo.put(`/envelopes/${e0.id}`, stale)).status, 200);
  assert.equal((await full(jo, e0.id)).envelope.fields.find((f: any) => f.id === textId).value, '400 seedlings', 'what Ada typed is still there');

  // Ada's page loads the corrected document and she finishes. The same old editor state is saved again: it must not
  // be refused just for being out of date, and it must not change what Ada entered.
  await ada.get(`/sign/${tok}`);
  assert.equal((await ada.post(`/sign/${tok}/complete`, { values: { [textId]: '400 seedlings', [v.fields.find((f: any) => f.type === 'signature').id]: '1' }, signature_png: PNG })).status, 200);
  assert.equal((await jo.put(`/envelopes/${e0.id}`, stale)).status, 200);
  // A change to Ada herself, or to how dates are printed, is another matter now that she has signed. It is refused
  // out loud, never ignored, and changes nothing.
  const adaRow = stale.recipients.find((r: any) => r.email === 'ada@example.com');
  adaRow.name = 'Someone Else';
  assert.equal((await jo.put(`/envelopes/${e0.id}`, stale)).status, 409);
  adaRow.name = 'Ada Signer';
  assert.equal((await jo.put(`/envelopes/${e0.id}`, { ...stale, date_format: 'DD/MM/YYYY' })).status, 409);
  const now = (await full(jo, e0.id)).envelope;
  assert.equal(now.recipients.find((r: any) => r.email === 'ada@example.com').name, 'Ada Signer');
  assert.equal(now.fields.find((f: any) => f.id === textId).value, '400 seedlings');
  assert.notEqual(now.date_format, 'DD/MM/YYYY', 'the date format is fixed once somebody has signed');

  // A copy recipient whose address is corrected gets their copy at the new address.
  const cur = asBody(now);
  cur.recipients.find((r: any) => r.role === 'cc').email = 'cee.new@example.com';
  db.run("UPDATE recipients SET status='completed' WHERE envelope_id=? AND role='cc'", e0.id);
  assert.equal((await jo.put(`/envelopes/${e0.id}`, asBody((await full(jo, e0.id)).envelope).recipients.length ? cur : cur)).status, 200);
  assert.ok(mailTo('cee.new@example.com').length >= 1);

  // Limits are stated, never applied silently, and a draft can be saved with a half-typed address.
  const d = await simple(jo, 'x@example.com');
  const body = asBody((await full(jo, d.id)).envelope);
  body.recipients[0].email = 'half-typed@';
  assert.equal((await jo.put(`/envelopes/${d.id}`, body)).status, 200);
  assert.equal((await jo.post(`/envelopes/${d.id}/send`)).status, 400, 'and it is checked before sending');
  body.recipients = Array.from({ length: 51 }, (_, i) => ({ id: `x${i}`, role: 'cc', name: `P${i}`, email: `p${i}@example.com` }));
  const tooMany = await jo.put(`/envelopes/${d.id}`, body);
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /up to 50 recipients/);
});
