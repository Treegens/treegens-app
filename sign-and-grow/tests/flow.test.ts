// End-to-end tests of the API, run straight against the request handler with a throwaway database.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { boot, Client, PNG, upload, draft, tokenFor, signUp, type Server } from './helpers.ts';

let db: Server['db'];
let acct: Server['billing'];
let env: Server['env'];
before(async () => {
  ({ db, billing: acct, env } = await boot());
});

const sender = new Client();

test('signup, session and CSRF protection', async () => {
  const r = await sender.post('/auth/signup', { name: 'Jo Sender', email: 'jo@example.com', password: 'correct horse' });
  assert.equal(r.status, 200);
  // Nobody can send until they have proved the email address is theirs.
  const early = await draft(sender);
  assert.equal((await sender.post(`/envelopes/${early.id}/send`)).status, 403);
  const vt = db.get("SELECT verify_token t FROM users WHERE email='jo@example.com'").t;
  assert.equal((await new Client().post('/auth/verify', { token: vt })).status, 200);
  assert.equal((await sender.get('/me')).data.user.email, 'jo@example.com');
  assert.equal((await new Client().get('/envelopes')).status, 401);
  assert.equal((await sender.call('POST', '/envelopes', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await new Client().post('/auth/login', { email: 'jo@example.com', password: 'wrong' })).status, 401);
});

test('full signing flow: order, access code, completion, certificate, verification', async () => {
  const e = await draft(sender);
  assert.equal(e.fields.length, 5);
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);

  // Only the first signer has been asked so far.
  let cur = (await sender.get(`/envelopes/${e.id}`)).data.envelope;
  assert.deepEqual(cur.recipients.map((r: any) => r.status), ['sent', 'pending', 'pending']);
  assert.equal(cur.sheets, 6); // 2 pages x 3 parties

  const ada = new Client();
  const adaTok = tokenFor(e.id, 'ada@example.com');
  const view = (await ada.get(`/sign/${adaTok}`)).data;
  assert.equal(view.fields.length, 3);
  assert.equal((await ada.post(`/sign/${adaTok}/complete`, { values: {} })).status, 400, 'consent required');
  await ada.post(`/sign/${adaTok}/consent`);
  const sig = view.fields.find((f: any) => f.type === 'signature').id;
  const txt = view.fields.find((f: any) => f.type === 'text').id;
  assert.equal((await ada.post(`/sign/${adaTok}/complete`, { values: { [sig]: '1' }, signature_png: PNG })).status, 400, 'required text missing');
  assert.equal((await ada.post(`/sign/${adaTok}/complete`, { values: { [sig]: '1', [txt]: '250 mangroves' }, signature_png: PNG })).status, 200);

  // Second signer is locked behind an access code.
  const ben = new Client();
  const benTok = tokenFor(e.id, 'ben@example.com');
  assert.equal((await ben.get(`/sign/${benTok}`)).data.locked, true);
  assert.equal((await ben.get(`/sign/${benTok}/doc/x`)).status, 401);
  assert.equal((await ben.post(`/sign/${benTok}/unlock`, { code: '0000' })).status, 401);
  assert.equal((await ben.post(`/sign/${benTok}/unlock`, { code: '4242' })).status, 200);
  const bview = (await ben.get(`/sign/${benTok}`)).data;
  assert.equal(bview.others.some((f: any) => f.value === '250 mangroves'), true, 'sees what Ada filled in');
  await ben.post(`/sign/${benTok}/consent`);
  const bsig = bview.fields.find((f: any) => f.type === 'signature').id;
  const done = await ben.post(`/sign/${benTok}/complete`, { values: { [bsig]: '1' }, signature_png: PNG });
  assert.equal(done.data.envelope_status, 'completed');

  cur = (await sender.get(`/envelopes/${e.id}`)).data;
  assert.equal(cur.envelope.status, 'completed');
  assert.equal(cur.chain.ok, true);
  assert.deepEqual(cur.envelope.recipients.map((r: any) => r.status), ['completed', 'completed', 'completed']);

  const pdf = (await sender.get(`/envelopes/${e.id}/download`)).data as Uint8Array;
  const parsed = await PDFDocument.load(pdf);
  assert.ok(parsed.getPageCount() >= 3, 'documents plus certificate');

  // The exact file verifies; a changed file does not.
  const f = new FormData();
  f.append('file', new Blob([pdf]), 'signed.pdf');
  const v = (await new Client().call('POST', '/public/verify', f)).data;
  assert.equal(v.match, true);
  assert.equal(v.chain.ok, true);
  const f2 = new FormData();
  f2.append('file', new Blob([pdf, new Uint8Array([32])]), 'tampered.pdf');
  assert.equal((await new Client().call('POST', '/public/verify', f2)).data.match, false);

  // Tampering with the audit log is detected.
  db.run("UPDATE audit SET detail='edited' WHERE envelope_id=? AND action='Signed'", e.id);
  assert.equal(env.verifyChain(e.id).ok, false);

  const mails = db.all('SELECT to_email, subject FROM emails WHERE envelope_id=?', e.id);
  assert.ok(mails.filter((m) => m.subject.startsWith('Completed')).length >= 4, 'everyone gets the completed copy');
});

test('decline, void, reassign and correct', async () => {
  const a = await draft(sender, { ordered: false });
  await sender.post(`/envelopes/${a.id}/send`);
  const tok = tokenFor(a.id, 'ada@example.com');
  assert.equal((await new Client().post(`/sign/${tok}/decline`, { reason: '' })).status, 400);
  assert.equal((await new Client().post(`/sign/${tok}/decline`, { reason: 'Wrong terms' })).status, 200);
  assert.equal((await sender.get(`/envelopes/${a.id}`)).data.envelope.status, 'declined');

  const b = await draft(sender, { ordered: false });
  await sender.post(`/envelopes/${b.id}/send`);
  const t1 = tokenFor(b.id, 'ada@example.com');
  assert.equal((await new Client().post(`/sign/${t1}/reassign`, { name: 'Dee Deputy', email: 'dee@example.com' })).status, 200);
  assert.equal((await new Client().get(`/sign/${t1}`)).status, 410, 'old link is retired');
  assert.ok(tokenFor(b.id, 'dee@example.com'));
  const rid = (await sender.get(`/envelopes/${b.id}`)).data.envelope.recipients.find((r: any) => r.email === 'ben@example.com').id;
  assert.equal((await sender.post(`/envelopes/${b.id}/correct`, { recipient_id: rid, email: 'benjamin@example.com' })).status, 200);
  assert.equal((await sender.post(`/envelopes/${b.id}/remind`)).data.reminded, 2);
  assert.equal((await sender.post(`/envelopes/${b.id}/void`, { reason: 'Sent by mistake' })).status, 200);
  assert.equal((await new Client().post(`/sign/${tokenFor(b.id, 'dee@example.com')}/consent`)).status, 200);
  assert.equal((await new Client().post(`/sign/${tokenFor(b.id, 'dee@example.com')}/complete`, { values: {} })).status, 400);
});

test('approver, viewer and in-person roles; documents stay private until it is your turn', async () => {
  const file = await upload(sender, 1);
  const e = (await sender.post('/envelopes', {
    subject: 'Roles', ordered: true, send: true,
    documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'a', role: 'approver', name: 'App Rover', email: 'approver@example.com', routing_order: 1 },
      { id: 'v', role: 'viewer', name: 'Vi Ewer', email: 'viewer@example.com', routing_order: 2 },
      { id: 'p', role: 'inperson', name: 'Percy Present', email: 'percy@example.com', routing_order: 3 },
    ],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'p', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  })).data.envelope;
  const docId = e.documents[0].id;
  const step = async (email: string, body: any = { values: {} }) => {
    const c = new Client();
    const tok = tokenFor(e.id, email);
    await c.post(`/sign/${tok}/consent`);
    return c.post(`/sign/${tok}/complete`, body);
  };
  // The viewer is second in line: no fields, no document, no completing out of turn.
  const vTok = tokenFor(e.id, 'viewer@example.com');
  assert.equal((await new Client().get(`/sign/${vTok}`)).data.documents, undefined);
  assert.equal((await new Client().get(`/sign/${vTok}/doc/${docId}`)).status, 403);
  assert.equal((await step('viewer@example.com')).status, 400);

  assert.equal((await step('approver@example.com')).status, 200);
  assert.equal((await new Client().get(`/sign/${vTok}/doc/${docId}`)).status, 200);
  assert.equal((await step('viewer@example.com')).status, 200);

  // The in-person link goes to the host (the sender), not to the signer.
  const hostMail = db.get("SELECT to_email FROM emails WHERE envelope_id=? AND subject='Roles' ORDER BY id DESC LIMIT 1", e.id);
  assert.equal(hostMail.to_email, 'jo@example.com');
  const pTok = tokenFor(e.id, 'percy@example.com');
  const pv = (await new Client().get(`/sign/${pTok}`)).data;
  const done = await step('percy@example.com', { values: { [pv.fields[0].id]: '1' }, signature_png: PNG });
  assert.equal(done.data.envelope_status, 'completed');
  const audit = (await sender.get(`/envelopes/${e.id}`)).data.audit.map((a: any) => a.action);
  assert.ok(audit.includes('Approved') && audit.includes('Viewed') && audit.includes('Signed'));

  // Once voided, the document is no longer readable through a signing link.
  const v = await draft(sender, { ordered: false });
  await sender.post(`/envelopes/${v.id}/send`);
  const t = tokenFor(v.id, 'ada@example.com');
  assert.equal((await new Client().get(`/sign/${t}/doc/${v.documents[0].id}`)).status, 200);
  await sender.post(`/envelopes/${v.id}/void`, { reason: 'Wrong version' });
  assert.equal((await new Client().get(`/sign/${t}/doc/${v.documents[0].id}`)).status, 403);
  assert.equal((await new Client().get(`/sign/${t}/download`)).status, 403);
});

test('API callers may leave ids off fields', async () => {
  const file = await upload(sender, 1);
  const r = await sender.post('/envelopes', {
    subject: 'No ids', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'A', email: 'a@example.com' }],
    fields: [
      { document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { document_id: 'd', recipient_id: 'r', type: 'text', page: 0, x: 0.1, y: 0.6, w: 0.3, h: 0.03 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.envelope.fields.length, 2);
});

test('templates, bulk send and PowerForms', async () => {
  const file = await upload(sender, 1);
  const tpl = (await sender.post('/envelopes', {
    kind: 'template', subject: 'Volunteer waiver',
    documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Volunteer' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  })).data.envelope;
  assert.equal(tpl.kind, 'template');

  const used = await sender.post('/envelopes', { template_id: tpl.id, recipients: { Volunteer: { name: 'Vee', email: 'vee@example.com' } }, send: true });
  assert.equal(used.data.envelope.status, 'sent');

  const bulk = await sender.post('/bulk', { template_id: tpl.id, rows: [{ Volunteer: { name: 'A', email: 'a@example.com' } }, { Volunteer: { name: 'B', email: 'b@example.com' } }] });
  assert.equal(bulk.data.sent, 2);
  assert.equal((await sender.post('/bulk', { template_id: tpl.id, rows: [{ Volunteer: { name: 'A', email: 'nope' } }] })).status, 400);

  const pf = await sender.post('/powerforms', { template_id: tpl.id, name: 'Sign the waiver' });
  const slug = (await sender.get('/powerforms')).data.powerforms.find((p: any) => p.id === pf.data.id).slug;
  const anon = new Client();
  assert.equal((await anon.get(`/public/powerforms/${slug}`)).data.role, 'Volunteer');
  const start = await anon.post(`/public/powerforms/${slug}/start`, { name: 'Walk In', email: 'walkin@example.com' });
  assert.match(start.data.url, /\/sign\//);
  const tok = start.data.url.split('/sign/')[1];
  await anon.post(`/sign/${tok}/consent`);
  const v = (await anon.get(`/sign/${tok}`)).data;
  const done = await anon.post(`/sign/${tok}/complete`, { values: { [v.fields[0].id]: '1' }, signature_png: PNG });
  assert.equal(done.data.envelope_status, 'completed');
});

test('accounts are isolated, API keys work, members see only their own envelopes', async () => {
  const e = await draft(sender);
  const other = new Client();
  await other.post('/auth/signup', { name: 'Mal', email: 'mal@example.com', password: 'password123' });
  assert.equal((await other.get(`/envelopes/${e.id}`)).status, 404);
  assert.equal((await other.post(`/envelopes/${e.id}/send`)).status, 404);
  const fileId = e.documents[0].file_id;
  assert.equal((await other.get(`/files/${fileId}/content`)).status, 404);
  assert.equal((await other.post('/envelopes', { documents: [{ id: 'd', file_id: fileId }] })).status, 400, 'cannot attach another account\'s file');

  const key = (await sender.post('/api-keys', { name: 'ci' })).data.key;
  const api = await new Client().call('GET', '/envelopes', undefined, { authorization: `Bearer ${key}` });
  assert.equal(api.status, 200);
  assert.ok(api.data.envelopes.length > 0);

  await sender.post('/account/invites', { email: 'member@example.com' });
  const inv = db.get("SELECT token FROM invites WHERE email='member@example.com'").token;
  const member = new Client();
  assert.equal((await member.post('/auth/signup', { name: 'Mem', email: 'member@example.com', password: 'password123', invite: inv })).status, 200);
  assert.equal((await member.get('/envelopes')).data.envelopes.length, 0);
  assert.equal((await member.get(`/envelopes/${e.id}`)).status, 404);
  assert.equal((await member.call('PATCH', '/account', { name: 'x' })).status, 403);
});

test('expiry and automatic reminders', async () => {
  const e = await draft(sender, { ordered: false, reminder_days: 1 });
  await sender.post(`/envelopes/${e.id}/send`);
  db.run('UPDATE envelopes SET sent_at=? WHERE id=?', new Date(Date.now() - 2 * 864e5).toISOString(), e.id);
  assert.equal((await env.cronTick()).reminded >= 1, true);
  db.run('UPDATE envelopes SET expires_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), e.id);
  assert.equal((await env.cronTick()).expired, 1);
  assert.equal((await sender.get(`/envelopes/${e.id}`)).data.envelope.status, 'expired');
});

test('stripe webhook: signature check and revenue ledger', async () => {
  const secret = 'whsec_test';
  const raw = JSON.stringify({ type: 'invoice.paid', data: { object: { id: 'in_1', customer: 'cus_1', amount_paid: 1200, currency: 'usd' } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  assert.equal(acct.verifyStripeSignature(raw, `t=${t},v1=${sig}`, secret), true);
  assert.equal(acct.verifyStripeSignature(raw + ' ', `t=${t},v1=${sig}`, secret), false);
  assert.equal(acct.verifyStripeSignature(raw, `t=${t - 4000},v1=${sig}`, secret), false);
  await acct.applyStripeEvent(JSON.parse(raw));
  await acct.applyStripeEvent(JSON.parse(raw)); // replays are ignored
  assert.equal(db.get('SELECT SUM(amount_cents) c FROM payments').c, 1200);
});
