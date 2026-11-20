// Accounts, teams, deleting and support, from the second audit: someone removed from a team can still sign in and
// be invited again, nobody removes themselves, a hand-over takes bulk sends along and leaves a trace, a deleted
// account leaves nothing personal behind, a closing account takes on nothing new and warns its owner a week ahead,
// members cannot rewrite each other's templates or see each other's folders and batches, a completed envelope its
// sender deleted stays with its recipients, help references can be read out loud, sign-in opens the workspace used
// last, and a signer's cry for help reaches the sender.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { boot, Client, PNG, simple, upload, tokenFor, signUp, signAll, mailTo, type Server } from './helpers.ts';
import { PRICING } from '../src/lib/impact.ts';
import { supportWarning, CLOSING_REMINDER_DAYS, CLOSE_GRACE_DAYS } from '../src/lib/policy.ts';

let db: Server['db'];
let cron: Server['cron'];
before(async () => {
  ({ db, cron } = await boot());
});

const PW = 'correct horse battery';
// Sign-ups, sign-ins and the help form are limited per address, so everybody here arrives from an address of their own.
let n = 0;
const ip = () => `10.${Math.floor(++n / 250)}.${n % 250}.7`;
const from = () => Object.assign(new Client(), { ip: ip() });
const person = (name: string, email: string) => signUp(name, email, ip());
const me = async (c: Client) => (await c.get('/me')).data;
const idOf = async (c: Client) => (await me(c)).user.id;
const inviteFor = (email: string) => db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY created_at DESC', email)?.token;
// A team member who joined through an invitation and has no workspace of their own.
async function join(owner: Client, name: string, email: string, role = 'member') {
  assert.equal((await owner.post('/account/invites', { email, role })).status, 200);
  const c = from();
  const r = await c.post('/auth/signup', { name, email, password: PW, invite: inviteFor(email) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}
async function signIn(email: string, extra: any = {}) {
  const c = from();
  const r = await c.post('/auth/login', { email, password: PW, ...extra });
  return { c, r };
}
const welcome = (email: string) => db.get("SELECT COALESCE(SUM(c.delta),0) n FROM credits c WHERE c.reason='welcome' AND c.account_id IN (SELECT m.account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=? AND m.role='owner')", email).n;
const blob = (sha: string) => fs.existsSync(path.join(process.env.DATA_DIR!, 'blobs', sha));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const auditOf = (envelopeId: string) => db.all('SELECT actor, action, detail FROM audit WHERE envelope_id=? ORDER BY seq', envelopeId);
// A template with one open role, which is what a bulk send and a public form need.
async function template(c: Client, subject: string) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    kind: 'template', subject, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Member' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
const asBody = (e: any) => ({ subject: e.subject, message: e.message, documents: e.documents, recipients: e.recipients, fields: e.fields });

// ---- 1. Removed from a team ----------------------------------------------------------------------------------

test('someone removed from their only team can sign in, gets a workspace with the welcome signatures once, and can be invited again', async () => {
  const owner = await person('Olga Owner', 'olga@example.com');
  const team = (await me(owner)).account;
  const pat = await join(owner, 'Pat Member', 'pat@example.com');
  const patId = await idOf(pat);
  assert.equal(welcome('pat@example.com'), 0, 'someone who joined a team was not given signatures of their own');
  assert.equal((await owner.call('DELETE', `/account/members/${patId}`)).status, 200);
  assert.equal((await pat.get('/envelopes')).status, 401, 'out of the team at once');

  // Their login is not a dead end: signing in works and opens an empty workspace of their own.
  const back = await signIn('pat@example.com');
  assert.equal(back.r.status, 200, JSON.stringify(back.r.data));
  assert.equal(back.r.data.fresh, true);
  const mine = await me(back.c);
  assert.equal(mine.account.name, "Pat's workspace");
  assert.equal(mine.role, 'owner');
  assert.notEqual(mine.account.id, team.id);
  assert.equal((await back.c.get('/envelopes')).data.envelopes.length, 0);
  assert.equal((await back.c.get('/inbox')).status, 200, 'and their inbox of documents sent to them is reachable again');
  assert.equal(welcome('pat@example.com'), PRICING.welcomeSignatures, 'with the signatures every new person gets');

  // Signing up a second time is still refused, with the way in.
  const again = await from().post('/auth/signup', { name: 'Pat Again', email: 'pat@example.com', password: PW });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /Sign in/);

  // Invited again: someone who has a login is sent to sign in, not to sign up, and accepts while signed in.
  assert.equal((await owner.post('/account/invites', { email: 'pat@example.com' })).status, 200);
  const mail = mailTo('pat@example.com').at(-1)!;
  assert.match(mail.link, /\/login\?invite=/);
  assert.match(text(mail.html), /already have a Sign&Grow login/);
  const withInvite = await from().post('/auth/signup', { name: 'Pat', email: 'pat@example.com', password: PW, invite: inviteFor('pat@example.com') });
  assert.equal(withInvite.status, 409);
  assert.match(withInvite.data.error, /Sign in with it and the invitation is accepted/);
  const accepted = await back.c.post('/invites/accept', { token: inviteFor('pat@example.com') });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal((await me(back.c)).account.id, team.id, 'and is in the team straight away');
  assert.equal((await me(back.c)).accounts.length, 2);

  // Removed once more: the workspace they already have is opened. No second workspace, no second set of signatures.
  assert.equal((await owner.call('DELETE', `/account/members/${patId}`)).status, 200);
  const third = await signIn('pat@example.com');
  assert.equal(third.r.data.fresh, false);
  assert.equal((await me(third.c)).account.id, mine.account.id);
  assert.equal(db.get('SELECT COUNT(*) n FROM memberships WHERE user_id=?', patId).n, 1);
  assert.equal(welcome('pat@example.com'), PRICING.welcomeSignatures);

  // Invited a third time, and this time accepted by signing in from the invitation link.
  assert.equal((await owner.post('/account/invites', { email: 'pat@example.com', role: 'admin' })).status, 200);
  const viaLink = await signIn('pat@example.com', { invite: inviteFor('pat@example.com') });
  assert.equal(viaLink.r.status, 200);
  assert.equal(viaLink.r.data.joined, team.name);
  assert.equal((await me(viaLink.c)).account.id, team.id);
  assert.equal((await me(viaLink.c)).role, 'admin');
  assert.equal(inviteFor('pat@example.com'), undefined, 'the invitation is used up');

  // An invitation that is not theirs never stops the sign-in. They are in, and told why they did not join.
  assert.equal((await owner.post('/account/invites', { email: 'someone.else@example.com' })).status, 200);
  const wrong = await signIn('pat@example.com', { invite: inviteFor('someone.else@example.com') });
  assert.equal(wrong.r.status, 200);
  assert.match(wrong.r.data.invite_error, /cannot be used with pat@example\.com.*Ask the person who invited you/);
  assert.ok(inviteFor('someone.else@example.com'), 'and the invitation is still there for the person it was meant for');
});

test('the welcome signatures go to a person once, also when a second workspace is made for them', async () => {
  const sol = await person('Sol Self', 'sol@example.com');
  const first = (await me(sol)).account.id;
  assert.equal(db.get("SELECT SUM(delta) n FROM credits WHERE account_id=? AND reason='welcome'", first).n, PRICING.welcomeSignatures);
  // Sol hands the workspace to a colleague, who then removes Sol.
  const mate = await join(sol, 'Mate Next', 'mate.next@example.com', 'admin');
  assert.equal((await sol.post('/account/transfer-owner', { user_id: await idOf(mate) })).status, 200);
  assert.equal((await mate.call('DELETE', `/account/members/${await idOf(sol)}`)).status, 200);
  const back = await signIn('sol@example.com');
  assert.equal(back.r.data.fresh, true);
  const second = (await me(back.c)).account.id;
  assert.notEqual(second, first);
  assert.equal(db.get("SELECT COALESCE(SUM(delta),0) n FROM credits WHERE account_id=? AND reason='welcome'", second).n, 0, 'no second helping');
});

// ---- 2. Removing a member ------------------------------------------------------------------------------------

test('nobody removes themselves, the successor is a member who stays, and bulk sends are handed over with a trace', async () => {
  const owner = await person('Tia Lead', 'tia@example.com');
  const adm = await join(owner, 'Adm In', 'adm@example.com', 'admin');
  const sam = await join(owner, 'Sam Successor', 'sam@example.com');
  const pat = await join(owner, 'Pia Leaver', 'pia@example.com');
  const [admId, samId, patId] = [await idOf(adm), await idOf(sam), await idOf(pat)];

  // An admin cannot take themselves off the team through the API and stay the sender of what they sent.
  const own = await simple(adm, 'client.adm@example.com', { subject: 'Adm in flight' });
  assert.equal((await adm.post(`/envelopes/${own.id}/send`)).status, 200);
  const self = await adm.call('DELETE', `/account/members/${admId}`);
  assert.equal(self.status, 400);
  assert.match(self.data.error, /cannot remove yourself.*use "Leave this team" on the Team tab/);
  assert.equal((await adm.get('/envelopes')).status, 200, 'still on the team');
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', own.id).sender_id, admId);

  // Pia has a draft, a template, an envelope out for signature and a bulk send.
  const draft = await simple(pat, 'draftee@example.com', { subject: 'Pia draft' });
  const tpl = await template(pat, 'Pia template');
  const out = await simple(pat, 'client.pia@example.com', { subject: 'Pia in flight' });
  assert.equal((await pat.post(`/envelopes/${out.id}/send`)).status, 200);
  const bulk = await pat.call('POST', '/bulk', { template_id: tpl.id, rows: [{ Member: { name: 'B One', email: 'b1@example.com' } }] }, { 'idempotency-key': 'pia-batch-1' });
  assert.equal(bulk.data.sent, 1, JSON.stringify(bulk.data));
  assert.equal((await sam.get(`/bulk/${bulk.data.id}`)).status, 404, 'a member cannot open a colleague\'s batch');

  // A successor we do not know, or the person who is leaving, is refused. Nothing is handed to anyone by default.
  for (const to of ['usr_nobody', patId, await idOf(await person('Out Sider', 'outsider@example.com'))]) {
    const r = await owner.call('DELETE', `/account/members/${patId}?to=${to}`);
    assert.equal(r.status, 400, to);
    assert.match(r.data.error, /Choose another member.*Nothing was changed/);
  }
  assert.equal((await pat.get('/envelopes')).status, 200, 'Pia is still on the team');
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', out.id).sender_id, patId);

  const removed = await owner.call('DELETE', `/account/members/${patId}?to=${samId}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(removed.data.handed_to, samId);
  assert.equal(removed.data.handed_over, 4, 'the draft, the template, the envelope that is out and the one the bulk send made');
  for (const id of [draft.id, tpl.id, out.id]) assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', id).sender_id, samId);

  // The batch went too: the successor can open it and act on it as one.
  assert.equal(db.get('SELECT sender_id FROM bulk_batches WHERE id=?', bulk.data.id).sender_id, samId);
  assert.equal((await sam.get(`/bulk/${bulk.data.id}`)).status, 200);
  assert.deepEqual((await sam.get('/bulk')).data.batches.map((b: any) => b.id), [bulk.data.id]);
  assert.equal((await sam.post(`/bulk/${bulk.data.id}/remind`)).status, 200);

  // And every envelope says in its own record who handed it to whom, and why.
  const line = auditOf(out.id).find((a: any) => a.action === 'Handed over');
  assert.ok(line, 'no trace of the hand-over');
  assert.equal(line.detail, 'From Pia Leaver <pia@example.com> to Sam Successor <sam@example.com>: Pia Leaver was removed from the team');
  assert.match(line.actor, /Tia Lead/);
  assert.ok(auditOf(draft.id).some((a: any) => a.action === 'Handed over'));
  assert.equal((await sam.get(`/envelopes/${out.id}`)).data.chain.ok, true, 'the chain of the audit trail still holds');

  // What is signed afterwards goes to the successor, not to the person who left.
  const seen = mailTo('pia@example.com').length;
  assert.equal((await signAll(out.id, 'client.pia@example.com')).status, 200);
  assert.ok(mailTo('sam@example.com').some((m) => m.subject === 'Completed: Pia in flight'));
  assert.equal(mailTo('pia@example.com').length, seen);

  // With no successor named, it all goes to whoever removed them.
  const second = await simple(sam, 'client.sam@example.com', { subject: 'Sam draft' });
  assert.equal((await owner.call('DELETE', `/account/members/${samId}`)).data.handed_to, await idOf(owner));
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', second.id).sender_id, await idOf(owner));
  assert.equal(db.get('SELECT sender_id FROM bulk_batches WHERE id=?', bulk.data.id).sender_id, await idOf(owner));
});

// ---- 3. Deleted for good -------------------------------------------------------------------------------------

async function pdfFile(words: string, name: string) {
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawText(`${words} ${Math.random()}`, { x: 72, y: 700 });
  const f = new FormData();
  f.append('file', new Blob([await d.save()], { type: 'application/pdf' }), name);
  return f;
}
// One completed envelope whose signer attached a file of their own, as the audit did.
async function withAttachment(c: Client, signer: string) {
  const file = (await c.call('POST', '/files', await pdfFile('Unique contract', 'Unique.pdf'))).data;
  const e = (await c.post('/envelopes', {
    subject: 'With attachment', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sig Ner', email: signer }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'a', document_id: 'd', recipient_id: 'r', type: 'attachment', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.06, required: false }],
  })).data.envelope;
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = tokenFor(e.id, signer);
  const s = from();
  await s.post(`/sign/${tok}/consent`);
  const v = (await s.get(`/sign/${tok}`)).data;
  const up = (await s.call('POST', `/sign/${tok}/upload`, await pdfFile('Passport scan', 'passport.pdf'))).data;
  const values: any = {};
  for (const x of v.fields) values[x.id] = x.type === 'attachment' ? up.id : '1';
  assert.equal((await s.post(`/sign/${tok}/complete`, { values, signature_png: PNG })).data.envelope_status, 'completed');
  return {
    id: e.id, tok, attachmentId: up.id,
    src: db.get('SELECT sha256 s FROM files WHERE id=?', file.id).s, att: db.get('SELECT sha256 s FROM files WHERE id=?', up.id).s, fin: db.get('SELECT final_sha256 s FROM envelopes WHERE id=?', e.id).s,
  };
}
// Everything that could still say who was on an envelope after it is gone.
const leftOf = (envelopeId: string) => ({
  envelope: db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', envelopeId).n,
  audit: db.get('SELECT COUNT(*) n FROM audit WHERE envelope_id=?', envelopeId).n,
  emails: db.get('SELECT COUNT(*) n FROM emails WHERE envelope_id=?', envelopeId).n,
  replaced_links: db.get('SELECT COUNT(*) n FROM retired_tokens WHERE envelope_id=?', envelopeId).n,
  reports: db.get('SELECT COUNT(*) n FROM abuse_reports WHERE envelope_id=?', envelopeId).n,
});
const NOTHING = { envelope: 0, audit: 0, emails: 0, replaced_links: 0, reports: 0 };

test('deleting an account at once leaves no name, address, email copy or signer file behind, and keeps the money records without names', async () => {
  const g = await person('Gone Gal', 'gone.gal@example.com');
  const gid = (await me(g)).account.id;
  const uid = await idOf(g);
  const done = await withAttachment(g, 'gx@example.com');
  // A second envelope that was corrected (a replaced link) and reported, and a batch.
  const other = await simple(g, 'first.address@example.com', { subject: 'Corrected and reported' });
  await g.post(`/envelopes/${other.id}/send`);
  const rid = db.get('SELECT id FROM recipients WHERE envelope_id=?', other.id).id;
  assert.equal((await g.post(`/envelopes/${other.id}/correct`, { recipient_id: rid, email: 'second.address@example.com' })).status, 200);
  assert.equal((await from().post(`/sign/${tokenFor(other.id, 'second.address@example.com')}/report`, { reason: 'spam' })).status, 200);
  const tpl = await template(g, 'Gone template');
  const bulk = await g.post('/bulk', { template_id: tpl.id, rows: [{ Member: { name: 'B', email: 'gone.b@example.com' } }] });
  assert.equal(bulk.data.sent, 1);
  // Records that do not hang on the account in the database: a webhook log, a payment, the plan history.
  const t = new Date().toISOString();
  db.run("INSERT INTO webhooks (id, account_id, url, secret, created_at) VALUES ('whk_gone', ?, 'https://example.com/hook', 's', ?)", gid, t);
  db.run("INSERT INTO webhook_deliveries (webhook_id, event, envelope_id, at, body) VALUES ('whk_gone', 'envelope.completed', ?, ?, ?)", done.id, t, '{"envelope":{"subject":"With attachment"}}');
  db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, receipt_url, kind, credits) VALUES ('in_gone', ?, 900, 'usd', ?, 'https://pay.example/receipt/gone', 'plan', 9)", gid, t);
  db.run("INSERT INTO billing_log (account_id, at, what, ref, detail) VALUES (?, ?, 'cancelled', 'SG-REF', 'Cancelled in the app by Gone Gal.')", gid, t);
  // Two messages to the help form from her confirmed address: one answered, one still open.
  process.env.OPERATOR_EMAILS = 'olga@example.com';
  const olga = (await signIn('olga@example.com')).c;
  const answered = await from().post('/public/support', { email: 'gone.gal@example.com', name: 'Gone Gal', message: 'An old question that was answered.' });
  const open = await from().post('/public/support', { email: 'gone.gal@example.com', name: 'Gone Gal', topic: 'billing', message: 'Please refund my last payment before I go.' });
  const reqId = (ref: string) => db.get('SELECT id FROM support_requests WHERE ref=?', ref)?.id;
  assert.equal((await olga.post(`/operator/support/${reqId(answered.data.reference)}`, { status: 'closed' })).status, 200);
  assert.ok(mailTo('gone.gal@example.com').length > 1 && blob(done.src) && blob(done.att) && blob(done.fin));

  assert.equal((await g.post('/me/delete', { password: PW, now: true })).data.closed, 'now');

  assert.equal(db.get('SELECT COUNT(*) n FROM users WHERE id=?', uid).n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM accounts WHERE id=?', gid).n, 0);
  for (const id of [done.id, other.id, bulk.data.results[0].id]) assert.deepEqual(leftOf(id), NOTHING, id);
  assert.equal(db.get('SELECT COUNT(*) n FROM files WHERE id=?', done.attachmentId).n, 0, 'the file the signer attached');
  assert.deepEqual([blob(done.src), blob(done.att), blob(done.fin)], [false, false, false], 'uploaded, attached and signed files are off the disk');
  assert.equal(db.get("SELECT COUNT(*) n FROM webhook_deliveries WHERE webhook_id='whk_gone'").n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM bulk_batches WHERE account_id=?', gid).n, 0);
  // Nothing we stored still names her, apart from the email that says it is done (which goes once it has left).
  const naming = db.all("SELECT subject FROM emails WHERE lower(to_email)='gone.gal@example.com' OR html LIKE '%gone.gal@example.com%' OR html LIKE '%Gone Gal%'").map((m: any) => m.subject);
  assert.deepEqual(naming, ['Your Sign&Grow account is closed']);
  const said = text(mailTo('gone.gal@example.com').at(-1)!.html);
  assert.match(said, /files signers attached, audit trails/);
  assert.match(said, /What we keep.*payments, refunds and of signatures bought and used, without your name/);
  db.run("UPDATE emails SET status='sent' WHERE lower(to_email)='gone.gal@example.com'");
  await cron.tick();
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE lower(to_email)='gone.gal@example.com'").n, 0, 'and that copy goes once the mail server has taken it');

  // The money records stay, and say nothing about who she was.
  const pay = db.get("SELECT amount_cents, receipt_url FROM payments WHERE id='in_gone'");
  assert.deepEqual([pay.amount_cents, pay.receipt_url], [900, null]);
  assert.deepEqual(db.all('SELECT what, ref, detail FROM billing_log WHERE account_id=?', gid).map((r: any) => ({ ...r })), [{ what: 'cancelled', ref: 'SG-REF', detail: '' }]);
  assert.ok(db.get('SELECT COUNT(*) n FROM credits WHERE account_id=?', gid).n >= 1, 'the signature ledger is kept');

  // The answered help request is gone. The open one waits for its answer, and goes with it.
  assert.equal(reqId(answered.data.reference), undefined);
  const waiting = db.get('SELECT status, forget, user_id, account_id FROM support_requests WHERE ref=?', open.data.reference);
  assert.deepEqual({ ...waiting }, { status: 'open', forget: 1, user_id: null, account_id: null });
  assert.ok((await olga.get('/operator/queue')).data.support.some((s: any) => s.ref === open.data.reference), 'still in the queue of the people who answer');
  assert.equal((await olga.post(`/operator/support/${reqId(open.data.reference)}`, { status: 'closed' })).data.deleted, true);
  assert.equal(reqId(open.data.reference), undefined);
  delete process.env.OPERATOR_EMAILS;

  // The signer's link is gone with the account, as the completion email said it would be.
  assert.equal((await from().get(`/sign/${done.tok}`)).status, 404);
  // The address is free again and starts with nothing.
  const anew = await person('Gone Again', 'gone.gal@example.com');
  assert.equal((await anew.get('/support/mine')).data.requests.length, 0);
});

test('an account deleted after the grace period leaves as little behind, and so does a single envelope that is deleted', async () => {
  const g = await person('Late Leaver', 'late.leaver@example.com');
  const done = await withAttachment(g, 'lx@example.com');

  // One envelope deleted on its own, after voiding: its audit trail and the copies of its emails go with it.
  const v = await simple(g, 'voided@example.com', { subject: 'Voided then deleted' });
  await g.post(`/envelopes/${v.id}/send`);
  assert.equal((await from().post(`/sign/${tokenFor(v.id, 'voided@example.com')}/report`, { reason: 'phishing' })).status, 200);
  await g.post(`/envelopes/${v.id}/void`, { reason: 'Sent by mistake' });
  assert.ok(leftOf(v.id).audit > 0 && leftOf(v.id).emails > 0);
  // The notice that it was voided is still waiting for the mail server when the sender deletes the envelope.
  const notice = db.get("SELECT id FROM emails WHERE envelope_id=? AND subject LIKE 'Voided:%'", v.id).id;
  db.run("UPDATE emails SET status='failed', next_try_at=? WHERE id=?", new Date(Date.now() + 3600_000).toISOString(), notice);
  assert.equal((await g.call('DELETE', `/envelopes/${v.id}`)).status, 200);
  // Gone, but for two things: that notice is still delivered, and the report still counts against the sender.
  assert.deepEqual(leftOf(v.id), { ...NOTHING, emails: 1, reports: 1 });
  db.run("UPDATE emails SET status='sent', next_try_at=NULL WHERE id=?", notice);
  await cron.tick();
  assert.deepEqual(leftOf(v.id), { ...NOTHING, reports: 1 }, 'once it has left, its copy goes too');

  assert.equal((await g.post('/me/delete', { password: PW })).data.closed, 'scheduled');
  assert.equal((await cron.tick()).purged, 0);
  assert.equal(leftOf(done.id).envelope, 1, 'nothing goes during the grace period');
  db.run("UPDATE users SET closing_at=? WHERE email='late.leaver@example.com'", new Date(Date.now() - 1000).toISOString());
  assert.equal((await cron.tick()).purged, 1);
  assert.deepEqual(leftOf(done.id), NOTHING);
  assert.deepEqual(leftOf(v.id), NOTHING, 'with the account, the report goes as well');
  assert.deepEqual([blob(done.src), blob(done.att), blob(done.fin)], [false, false, false]);
  assert.equal(db.get('SELECT COUNT(*) n FROM files WHERE id=?', done.attachmentId).n, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE lower(to_email)='late.leaver@example.com' OR html LIKE '%late.leaver@example.com%'").n, 0);
});

test('a file a signer uploaded and never attached is removed after a while, and one that is attached never is', async () => {
  const jo = await person('Jo Files', 'jo.files@example.com');
  const kept = await withAttachment(jo, 'attach@example.com');
  const e = await simple(jo, 'loose@example.com');
  await jo.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'loose@example.com');
  const s = from();
  await s.post(`/sign/${tok}/consent`);
  const loose = (await s.call('POST', `/sign/${tok}/upload`, await pdfFile('Never attached', 'loose.pdf'))).data;
  const sha = db.get('SELECT sha256 s FROM files WHERE id=?', loose.id).s;
  await cron.tick();
  assert.ok(blob(sha), 'a fresh upload is left alone: the signer may still attach it');
  const old = new Date(Date.now() - 31 * 864e5).toISOString();
  db.run('UPDATE files SET created_at=? WHERE id IN (?,?)', old, loose.id, kept.attachmentId);
  await cron.tick();
  assert.equal(db.get('SELECT COUNT(*) n FROM files WHERE id=?', loose.id).n, 0);
  assert.equal(blob(sha), false);
  assert.equal(db.get('SELECT COUNT(*) n FROM files WHERE id=?', kept.attachmentId).n, 1);
  assert.ok(blob(kept.att));
});

test('closing an account ends billing whatever the provider answers, and only deletes at once when the provider has confirmed', async () => {
  const p = await person('Pay Er', 'pay.er@example.com');
  const pid = (await me(p)).account.id;
  const uid = await idOf(p);
  const calls: string[] = [];
  let down = true;
  const realFetch = globalThis.fetch;
  process.env.STRIPE_SECRET_KEY = 'sk_test_lifecycle';
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    if (u.host !== 'api.stripe.com') return realFetch(url, init);
    calls.push(`${init.method || 'GET'} ${u.pathname.replace('/v1/', '')}`);
    const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (down) return (init.method || 'GET') === 'GET' ? json({ id: 'sub_life', status: 'active' }) : json({ error: { message: 'The payment provider is having trouble.' } }, 500);
    return json({ id: 'sub_life', status: 'canceled', latest_invoice: null });
  }) as any;
  try {
    // A plan on hold after a failed payment: not "grove and active", which is all the old code looked at.
    db.run("UPDATE accounts SET plan='grove', stripe_customer_id='cus_life', stripe_subscription_id='sub_life', subscription_status='unpaid' WHERE id=?", pid);

    // The provider is down. Deleting on the spot waits, and says so. The plan is ended on our side and the end is queued.
    const now = await p.post('/me/delete', { password: PW, now: true });
    assert.equal(now.status, 502);
    assert.match(now.data.error, /did not confirm.*nothing was deleted.*we keep trying/);
    assert.equal(db.get('SELECT COUNT(*) n FROM users WHERE id=?', uid).n, 1);
    assert.ok(calls.includes('DELETE subscriptions/sub_life'));
    assert.equal(db.get('SELECT subscription_status s FROM accounts WHERE id=?', pid).s, 'canceled');
    assert.equal(db.get("SELECT COUNT(*) n FROM billing_todo WHERE kind='cancel' AND ref='sub_life' AND done_at IS NULL").n, 1, 'the cancellation is tried again by the timer');

    // Closing with the days in between does not have to wait, and the email does not claim what is not known yet.
    db.run("UPDATE accounts SET plan='grove', subscription_status='unpaid' WHERE id=?", pid);
    assert.equal((await p.post('/me/delete', { password: PW })).data.closed, 'scheduled');
    const said = text(mailTo('pay.er@example.com').at(-1)!.html);
    assert.match(said, /cancelled on our side\. The payment provider did not confirm it straight away, so we keep trying/);
    assert.doesNotMatch(said, /you will not be charged again/);

    // With the provider answering, deleting at once goes through.
    down = false;
    const back = (await signIn('pay.er@example.com')).c;
    db.run("UPDATE accounts SET plan='grove', subscription_status='active' WHERE id=?", pid);
    calls.length = 0;
    assert.equal((await back.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
    assert.ok(calls.includes('DELETE subscriptions/sub_life'));
    assert.equal(db.get('SELECT COUNT(*) n FROM users WHERE id=?', uid).n, 0);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.STRIPE_SECRET_KEY;
    db.run("UPDATE billing_todo SET done_at=? WHERE ref='sub_life'", new Date().toISOString());
  }
});

// ---- 4. While an account is closing --------------------------------------------------------------------------

test('nobody is invited into, joins or sends from an account that is being closed, and the owner is told a week before it goes', async () => {
  const owner = await person('Clo Sing', 'clo.sing@example.com');
  const acc = (await me(owner)).account;
  const fresh = await person('Has Login', 'has.login@example.com');
  const e = await simple(owner, 'afterclose@example.com');
  const tpl = await template(owner, 'Closing form');
  await owner.post('/powerforms', { template_id: tpl.id, name: 'Closing form' });
  const slug = (await owner.get('/powerforms')).data.powerforms[0].slug;
  // Two invitations go out before the account is closed: one to a new person, one to someone with a login.
  await owner.post('/account/invites', { email: 'late.joiner@example.com' });
  await owner.post('/account/invites', { email: 'has.login@example.com' });
  const [lateInvite, knownInvite] = [inviteFor('late.joiner@example.com'), inviteFor('has.login@example.com')];

  const closed = (await owner.post('/me/delete', { password: PW })).data;
  assert.equal(closed.closed, 'scheduled');
  const day = closed.deletes_at.slice(0, 10);
  const refusal = new RegExp(`Clo's workspace is being closed and will be deleted on ${day}\\..*If its owner signs in before that day, the account is restored`);

  // Joining: by signing up from the invitation, by accepting it signed in, or by signing in from it.
  const late = await from().post('/auth/signup', { name: 'Late Joiner', email: 'late.joiner@example.com', password: PW, invite: lateInvite });
  assert.equal(late.status, 403);
  assert.match(late.data.error, refusal);
  assert.match(late.data.error, /Nobody can join it now/);
  assert.equal(db.get("SELECT COUNT(*) n FROM users WHERE email='late.joiner@example.com'").n, 0, 'no login is made for an account that is going away');
  const accept = await fresh.post('/invites/accept', { token: knownInvite });
  assert.equal(accept.status, 403);
  assert.match(accept.data.error, refusal);
  const viaLink = await signIn('has.login@example.com', { invite: knownInvite });
  assert.equal(viaLink.r.status, 200);
  assert.match(viaLink.r.data.invite_error, refusal);
  assert.equal(db.get('SELECT COUNT(*) n FROM memberships WHERE account_id=?', acc.id).n, 1);

  // A public form of the account takes no new signatures either, and nothing of the visitor's is kept.
  const walkIn = await from().post(`/public/powerforms/${slug}/start`, { name: 'Walk In', email: 'walkin.closing@example.com' });
  assert.equal(walkIn.status, 503);
  assert.equal(mailTo('walkin.closing@example.com').length, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE powerform_id IS NOT NULL AND account_id=?', acc.id).n, 0);

  // No session of the owner survives closing. Should one ever, inviting and sending are refused all the same.
  const stale = from();
  const { createSession } = await import('../src/server/auth.ts');
  const [name, value] = createSession(await db.get("SELECT id FROM users WHERE email='clo.sing@example.com'").id, acc.id, false).split(';')[0].split('=');
  stale.cookies[name] = value;
  const invite = await stale.post('/account/invites', { email: 'another@example.com' });
  assert.equal(invite.status, 403);
  assert.match(invite.data.error, /Nobody can be invited to it now/);
  assert.equal(mailTo('another@example.com').length, 0);
  const send = await stale.post(`/envelopes/${e.id}/send`);
  assert.equal(send.status, 403);
  assert.match(send.data.error, refusal);
  assert.match(send.data.error, /Nothing new can be sent from it/);
  assert.equal(mailTo('afterclose@example.com').length, 0);
  db.run('DELETE FROM sessions WHERE account_id=?', acc.id);

  // More than a week to go: no reminder yet.
  const reminders = () => mailTo('clo.sing@example.com').filter((m) => /will be deleted on/.test(m.subject));
  await cron.tick();
  assert.equal(reminders().length, 0);
  // A week before the day, one email: the day, how to keep the account, and how to take everything along first.
  const soon = new Date(Date.now() + (CLOSING_REMINDER_DAYS - 1) * 864e5).toISOString();
  db.run('UPDATE users SET closing_at=? WHERE email=?', soon, 'clo.sing@example.com');
  db.run('UPDATE accounts SET closing_at=? WHERE id=?', soon, acc.id);
  assert.equal((await cron.tick()).purged, 0);
  assert.equal(reminders().length, 1);
  const m = reminders()[0];
  assert.equal(m.subject, `Your Sign&Grow account will be deleted on ${soon.slice(0, 10)}`);
  assert.match(m.link, /\/login$/);
  const said = text(m.html);
  assert.match(said, new RegExp(`${CLOSING_REMINDER_DAYS - 1} days left`));
  assert.match(said, /To keep the account: sign in before that day/);
  assert.match(said, /To take a copy of everything first: sign in, go to Settings, then Your data, and choose Export everything/);
  assert.match(said, new RegExp(`close it again afterwards.*new ${CLOSE_GRACE_DAYS} days`));
  await cron.tick();
  assert.equal(reminders().length, 1, 'said once');

  // Signing in restores everything: the invitation works again, and so does sending.
  const back = await signIn('clo.sing@example.com');
  assert.equal(back.r.data.restored, true);
  assert.equal((await fresh.post('/invites/accept', { token: knownInvite })).status, 200);
  assert.equal((await back.c.post(`/envelopes/${e.id}/send`)).status, 200);
});

test('an account that still has other people in it is never deleted over their heads', async () => {
  // Closing is refused while others use an account, and nobody can join one that is closing. Should a member be
  // there all the same when the days run out, the account passes to them and what the owner sent goes with it.
  const owner = await person('Gone Owner', 'gone.owner@example.com');
  const acc = (await me(owner)).account.id;
  const e = await simple(owner, 'kept.client@example.com', { subject: 'Owner sent this' });
  assert.equal((await owner.post('/me/delete', { password: PW })).data.closed, 'scheduled');
  const stay = await person('Stay Er', 'stay.er@example.com');
  const stayId = await idOf(stay);
  db.run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'member',?)", acc, stayId, new Date().toISOString());
  db.run("UPDATE users SET closing_at=? WHERE email='gone.owner@example.com'", new Date(Date.now() - 1000).toISOString());
  assert.equal((await cron.tick()).purged, 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM users WHERE email='gone.owner@example.com'").n, 0, 'the login is gone');
  assert.deepEqual({ ...db.get('SELECT closing_at FROM accounts WHERE id=?', acc) }, { closing_at: null }, 'the account is not, and is no longer closing');
  assert.equal(db.get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', acc, stayId).role, 'owner');
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', e.id).sender_id, stayId);
  assert.ok(auditOf(e.id).some((a: any) => a.action === 'Handed over' && /Gone Owner closed their login/.test(a.detail)));
  assert.equal((await stay.post('/auth/switch', { account_id: acc })).status, 200);
  assert.equal((await stay.get(`/envelopes/${e.id}`)).status, 200);
});

// ---- 5. Templates, folders and batches in a team ---------------------------------------------------------------

test('members use every template but change only their own, and see only the folders and batches of what they can see', async () => {
  const owner = await person('Tem Owner', 'tem.owner@example.com');
  const ann = await join(owner, 'Ann Member', 'ann.member@example.com');
  const bob = await join(owner, 'Bob Member', 'bob.member@example.com');
  const shared = await template(owner, 'Owner template');
  const anns = await template(ann, 'Ann template');

  // Bob can read, copy and send from a template that is not his.
  const read = await bob.get(`/envelopes/${shared.id}`);
  assert.equal(read.status, 200);
  assert.equal((await bob.post(`/envelopes/${shared.id}/clone`)).status, 200);
  const used = await bob.post('/envelopes', { template_id: shared.id, recipients: { Member: { name: 'Vee', email: 'vee.tem@example.com' } }, send: true });
  assert.equal(used.data.envelope.status, 'sent', JSON.stringify(used.data));
  assert.equal((await bob.post('/bulk', { template_id: anns.id, rows: [{ Member: { name: 'B', email: 'b.tem@example.com' } }] })).data.sent, 1);

  // He cannot rewrite, move or delete it. The refusal says whose it is and what he can do instead.
  for (const r of [await bob.put(`/envelopes/${shared.id}`, { ...asBody(read.data.envelope), subject: 'Rewritten by Bob' }), await bob.call('PATCH', `/envelopes/${shared.id}`, { folder: 'Bob' }), await bob.call('DELETE', `/envelopes/${shared.id}`), await bob.call('DELETE', `/envelopes/${anns.id}`)]) {
    assert.equal(r.status, 403);
    assert.match(r.data.error, /This template belongs to (Tem Owner|Ann Member)\. You can use it and copy it, but only .* or an admin of your team can change or delete it\. To make your own version, copy it/);
  }
  const still = db.get('SELECT subject, folder FROM envelopes WHERE id=?', shared.id);
  assert.deepEqual({ ...still }, { subject: 'Owner template', folder: null });
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', anns.id).n, 1);

  // Ann changes her own. An admin can change anybody's.
  const annsNow = (await ann.get(`/envelopes/${anns.id}`)).data.envelope;
  assert.equal((await ann.put(`/envelopes/${anns.id}`, { ...asBody(annsNow), subject: 'Ann template v2' })).status, 200);
  assert.equal((await ann.call('PATCH', `/envelopes/${anns.id}`, { folder: 'HR forms' })).status, 200);
  const forAdmin = (await owner.get(`/envelopes/${anns.id}`)).data.envelope;
  assert.equal((await owner.put(`/envelopes/${anns.id}`, { ...asBody(forAdmin), subject: 'Ann template v3', edit_version: forAdmin.edit_version })).status, 200);
  // The list says which ones a person may change, so the page can leave the buttons out.
  const may = async (c: Client) => Object.fromEntries((await c.get('/envelopes?kind=template')).data.envelopes.filter((t: any) => t.id === shared.id || t.id === anns.id).map((t: any) => [t.subject, t.may_change]));
  assert.deepEqual(await may(bob), { 'Owner template': false, 'Ann template v3': false });
  assert.deepEqual(await may(ann), { 'Owner template': false, 'Ann template v3': true });
  assert.deepEqual(await may(owner), { 'Owner template': true, 'Ann template v3': true });

  // Folder names: only of what a person can see. Template folders belong to the team, like the templates.
  const mine = await simple(ann, 'client.ann@example.com', { subject: 'Ann client' });
  assert.equal((await ann.call('PATCH', `/envelopes/${mine.id}`, { folder: 'Layoffs 2026' })).status, 200);
  assert.deepEqual((await bob.get('/envelopes')).data.folders, []);
  assert.deepEqual((await ann.get('/envelopes')).data.folders, ['Layoffs 2026']);
  assert.deepEqual((await owner.get('/envelopes')).data.folders, ['Layoffs 2026']);
  assert.deepEqual((await bob.get('/envelopes?kind=template')).data.folders, ['HR forms']);

  // Batches: only one's own, and every batch for an admin.
  const annBatch = await ann.post('/bulk', { template_id: anns.id, name: 'Redundancy letters', rows: [{ Member: { name: 'C', email: 'c.tem@example.com' } }] });
  assert.equal(annBatch.data.sent, 1);
  const names = async (c: Client) => (await c.get('/bulk')).data.batches.map((b: any) => b.name).sort();
  assert.deepEqual(await names(ann), ['Redundancy letters']);
  assert.deepEqual(await names(bob), ['Ann template']);
  assert.deepEqual(await names(owner), ['Ann template', 'Redundancy letters']);
});

// ---- 6. Deleting a completed envelope ------------------------------------------------------------------------

test('a completed envelope its sender deletes leaves the sender\'s lists, and every recipient keeps their link and their copy', async () => {
  const jo = await person('Jo Deleter', 'jo.deleter@example.com');
  const keeper = await person('Kee Per', 'keeper@example.com');
  const stays = await simple(jo, 'other.client@example.com', { subject: 'This one stays' });
  await jo.post(`/envelopes/${stays.id}/send`);
  await signAll(stays.id, 'other.client@example.com');
  const e = (await jo.call('POST', '/envelopes', { ...(await simpleBody(jo, 'keeper@example.com', 'Keep me')), send: true }, { 'idempotency-key': 'order-77' })).data.envelope;
  assert.equal((await signAll(e.id, 'keeper@example.com')).status, 200);
  const tok = tokenFor(e.id, 'keeper@example.com');
  const sha = db.get('SELECT final_sha256 s FROM envelopes WHERE id=?', e.id).s;
  assert.match(text(mailTo('keeper@example.com').find((m) => m.subject === 'Completed: Keep me')!.html), /keeps working for as long as Jo Deleter keeps their Sign&Grow account/);
  const summary = async () => (await jo.get('/reports/summary')).data;
  assert.equal((await summary()).completed, 2);
  const paper = (await jo.get('/impact')).data.account.sheets;

  const del = await jo.call('DELETE', `/envelopes/${e.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.kept_for_recipients, true);

  // Gone for the sender: the list, search, the envelope itself, the export and the reports.
  assert.deepEqual((await jo.get('/envelopes')).data.envelopes.map((x: any) => x.subject), ['This one stays']);
  assert.equal((await jo.get('/envelopes?q=keeper')).data.envelopes.length, 0);
  assert.equal((await jo.get(`/envelopes/${e.id}`)).status, 404);
  assert.equal((await jo.get(`/envelopes/${e.id}/download`)).status, 404);
  assert.equal((await jo.call('DELETE', `/envelopes/${e.id}`)).status, 404);
  assert.equal((await jo.get(`/export?ids=${e.id}`)).status, 400, 'not in the export either');
  assert.equal(zipNames((await jo.get('/export')).data).filter((x) => x.startsWith('signed/')).length, 1);
  assert.equal((await summary()).completed, 1);
  assert.equal((await summary()).byStatus.completed, 1);
  assert.equal((await jo.get('/impact')).data.account.sheets, paper, 'the paper it saved was saved all the same');
  // A repeat of the call that made it does not answer with an envelope the sender deleted: the key is free again.
  const repeat = await jo.call('POST', '/envelopes', await simpleBody(jo, 'keeper@example.com', 'Keep me'), { 'idempotency-key': 'order-77' });
  assert.equal(repeat.status, 200);
  assert.notEqual(repeat.data.envelope.id, e.id);

  // Kept for the recipient: the link, the download, "documents sent to me", "find my documents" and the check of the PDF.
  const anyone = from();
  assert.equal((await anyone.get(`/sign/${tok}`)).data.envelope.status, 'completed');
  const pdf = await anyone.get(`/sign/${tok}/download`);
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(pdf.data).subarray(0, 4).toString(), '%PDF');
  assert.ok((await keeper.get('/inbox')).data.items.some((i: any) => i.id === e.id), 'still in the recipient\'s own list');
  const before = mailTo('keeper@example.com').length;
  assert.equal((await from().post('/public/links/find', { email: 'keeper@example.com' })).status, 200);
  const found = mailTo('keeper@example.com').slice(before);
  assert.equal(found.length, 1);
  assert.ok(found[0].html.includes(`/sign/${tok}`));
  const f = new FormData();
  f.append('file', new Blob([pdf.data], { type: 'application/pdf' }), 'signed.pdf');
  const verified = (await from().call('POST', '/public/verify', f)).data;
  assert.equal(verified.match, true);
  assert.equal(verified.chain.ok, true);
  assert.ok(blob(sha));
  // The record says what happened, and the envelope was not taken apart.
  assert.ok(auditOf(e.id).some((a: any) => a.action === 'Removed from the sender\'s lists' && /Jo Deleter/.test(a.actor)));
  assert.equal(db.get('SELECT COUNT(*) n FROM recipients WHERE envelope_id=?', e.id).n, 1);

  // A draft or a closed envelope is deleted for good, as before.
  const d = await simple(jo, 'draft.only@example.com');
  assert.equal((await jo.call('DELETE', `/envelopes/${d.id}`)).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE id=?', d.id).n, 0);

  // It is removed for good with the account.
  assert.equal((await jo.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
  assert.equal((await from().get(`/sign/${tok}`)).status, 404);
  assert.equal(blob(sha), false);
  assert.deepEqual(leftOf(e.id), NOTHING);
});

async function simpleBody(c: Client, email: string, subject: string) {
  const file = await upload(c, 1);
  return { subject, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Kee Per', email }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] };
}
function zipNames(data: Uint8Array): string[] {
  const buf = Buffer.from(data);
  const end = buf.length - 22;
  const names: string[] = [];
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const len = buf.readUInt16LE(p + 28);
    names.push(buf.subarray(p + 46, p + 46 + len).toString('utf8'));
    p += 46 + len + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return names;
}

// ---- 7 and 8. Help requests, workspaces, the second admin -----------------------------------------------------

test('a help reference is eight characters nobody can misread, and the same one everywhere', async () => {
  const user = await person('Ref Reader', 'ref.reader@example.com');
  const refs: string[] = [];
  for (let i = 0; i < 40; i++) {
    const r = await from().post('/public/support', { email: `asker${i}@example.com`, message: 'A question that is long enough to send.' });
    assert.equal(r.status, 200);
    refs.push(r.data.reference);
  }
  for (const ref of refs) assert.match(ref, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/, ref);
  assert.equal(new Set(refs).size, refs.length);
  assert.ok(mailTo('asker0@example.com').some((m) => m.subject === `We got your message (${refs[0]})`));

  // Signed in: "Your requests" shows the same reference and whether it was answered. So does the operators' queue.
  const mine = await user.post('/public/support', { topic: 'billing', message: 'Please check my last payment, thank you.' });
  const listed = (await user.get('/support/mine')).data.requests;
  assert.deepEqual(listed.map((r: any) => [r.reference, r.topic, r.status]), [[mine.data.reference, 'billing', 'open']]);
  process.env.OPERATOR_EMAILS = 'ref.reader@example.com';
  const row = (await user.get('/operator/queue')).data.support.find((s: any) => s.email === 'ref.reader@example.com');
  assert.equal(row.ref, mine.data.reference);
  assert.equal((await user.post(`/operator/support/${row.id}`, { status: 'closed' })).status, 200);
  delete process.env.OPERATOR_EMAILS;
  assert.equal((await user.get('/support/mine')).data.requests[0].status, 'closed');
  // A request from before references were stored keeps the one it was answered with then.
  db.run('UPDATE support_requests SET ref=NULL WHERE id=?', row.id);
  assert.equal((await user.get('/support/mine')).data.requests[0].reference, row.id.slice(-8).toUpperCase());
});

test('a signer who writes to the help form about a document reaches its sender too, and the form gives nothing away', async () => {
  const jo = await person('Jo Helped', 'jo.helped@example.com');
  const e = await simple(jo, 'stuck.signer@example.com', { subject: 'Signing problem doc' });
  await jo.post(`/envelopes/${e.id}/send`);
  const told = () => mailTo('jo.helped@example.com').filter((m) => m.subject === 'Problem signing: Signing problem doc');
  const asked = () => auditOf(e.id).filter((a: any) => a.action === 'Help requested');
  const ask = (c: Client, body: any) => c.post('/public/support', { topic: 'signing', message: 'The signature box will not accept my signature. SECRET-WORDS', envelope_id: e.id, ...body });

  // An address that is not on the envelope, or another topic: stored for support, and the sender hears nothing.
  const stranger = await ask(from(), { email: 'not.on.it@example.com' });
  assert.equal((await ask(from(), { email: 'stuck.signer@example.com', topic: 'billing' })).status, 200);
  assert.deepEqual([told().length, asked().length], [0, 0]);

  // The recipient's address: the sender is emailed and the envelope's record says so.
  const signer = await ask(from(), { email: 'Stuck.Signer@example.com' });
  assert.deepEqual(Object.keys(signer.data), Object.keys(stranger.data), 'the answer is the same whether or not it matched');
  assert.equal(told().length, 1);
  const said = text(told()[0].html);
  assert.match(said, /Someone writing from stuck\.signer@example\.com, the address of Sam Signer on this envelope/);
  assert.match(said, /copy their signing link, send it again, correct a name or an address, or give more time/);
  assert.doesNotMatch(said, /SECRET-WORDS/, 'anyone can type any address, so a stranger\'s words are not passed on');
  assert.deepEqual(asked().map((a: any) => [a.actor, a.detail]), [['Sign&Grow help form', 'A message from stuck.signer@example.com to the Sign&Grow help form said there is a problem with signing']]);
  assert.equal((await jo.get(`/envelopes/${e.id}`)).data.chain.ok, true);

  // Asking again the same day does not email the sender again.
  await ask(from(), { email: 'stuck.signer@example.com' });
  assert.deepEqual([told().length, asked().length], [1, 1]);

  // A recipient who is signed in with a confirmed address is known, so their words are passed on.
  const known = await person('Known Signer', 'known.signer@example.com');
  const e2 = await simple(jo, 'known.signer@example.com', { subject: 'Second doc' });
  await jo.post(`/envelopes/${e2.id}/send`);
  await known.post('/public/support', { topic: 'signing', message: 'It says my turn has not come. WORDS-TO-PASS-ON', envelope_id: e2.id });
  const second = mailTo('jo.helped@example.com').find((m) => m.subject === 'Problem signing: Second doc')!;
  assert.match(text(second.html), /They wrote: It says my turn has not come\. WORDS-TO-PASS-ON/);

  // A sender who switched off "when something needs you" is not emailed. The record is written all the same.
  await jo.call('PATCH', '/me', { notify: { problems: false } });
  const e3 = await simple(jo, 'quiet.signer@example.com', { subject: 'Quiet doc' });
  await jo.post(`/envelopes/${e3.id}/send`);
  await from().post('/public/support', { email: 'quiet.signer@example.com', topic: 'signing', message: 'I cannot open the document at all.', envelope_id: e3.id });
  assert.equal(mailTo('jo.helped@example.com').filter((m) => m.subject === 'Problem signing: Quiet doc').length, 0);
  assert.equal(auditOf(e3.id).filter((a: any) => a.action === 'Help requested').length, 1);
  // A draft has reached nobody, so nobody can be stuck on it.
  const d = await simple(jo, 'draft.signer@example.com');
  await from().post('/public/support', { email: 'draft.signer@example.com', topic: 'signing', message: 'Something about a draft.', envelope_id: d.id });
  assert.equal(auditOf(d.id).length, 0);
});

test('signing in opens the workspace used last, not the oldest', async () => {
  const boss = await person('Boss Team', 'boss.team@example.com');
  const team = (await me(boss)).account.id;
  const kim = await person('Kim Two', 'kim.two@example.com');
  const home = (await me(kim)).account.id;
  const kimId = await idOf(kim);
  assert.equal((await boss.post('/account/invites', { email: 'kim.two@example.com' })).status, 200);
  assert.equal((await kim.post('/invites/accept', { token: inviteFor('kim.two@example.com') })).status, 200);
  await kim.post('/auth/logout');
  // Kim joined the team last, so that is where the next sign-in lands. The empty workspace from sign-up is older.
  assert.equal((await me((await signIn('kim.two@example.com')).c)).account.id, team);
  const again = (await signIn('kim.two@example.com')).c;
  assert.equal((await again.post('/auth/switch', { account_id: home })).status, 200);
  assert.equal((await me((await signIn('kim.two@example.com')).c)).account.id, home, 'after switching, the choice is remembered');
  // A workspace the person is no longer in is never opened: the oldest one they still have is.
  await again.post('/auth/switch', { account_id: team });
  assert.equal((await boss.call('DELETE', `/account/members/${kimId}`)).status, 200);
  assert.equal((await me((await signIn('kim.two@example.com')).c)).account.id, home);
});

test('the app knows when a workspace hangs on one admin, and a production server without a support address says so at start', async () => {
  const solo = await person('So Lo', 'so.lo@example.com');
  assert.deepEqual([(await me(solo)).admins, (await me(solo)).members], [1, 1]);
  const member = await join(solo, 'Mem Ber', 'mem.ber@example.com');
  assert.deepEqual([(await me(solo)).admins, (await me(solo)).members], [1, 2], 'two people, one admin: the home page asks for a second');
  assert.equal((await solo.call('PATCH', `/account/members/${await idOf(member)}`, { role: 'admin' })).status, 200);
  assert.deepEqual([(await me(solo)).admins, (await me(solo)).members], [2, 2]);

  assert.equal(supportWarning({ NODE_ENV: 'development' }), null);
  assert.equal(supportWarning({ NODE_ENV: 'production', SUPPORT_EMAIL: 'help@example.com' }), null);
  assert.match(supportWarning({ NODE_ENV: 'production' })!, /SUPPORT_EMAIL IS NOT SET.*nobody is emailed when a help request arrives.*OPERATOR_EMAILS is empty as well/s);
  assert.match(supportWarning({ NODE_ENV: 'production', SUPPORT_EMAIL: ' ', OPERATOR_EMAILS: 'ops@example.com' })!, /shown in the operator queue/);
  // With an address set, the app and the public pages are given it to print.
  process.env.SUPPORT_EMAIL = 'help@example.com';
  assert.equal((await me(solo)).support_email, 'help@example.com');
  assert.equal((await from().get('/public/support')).data.email, 'help@example.com');
  delete process.env.SUPPORT_EMAIL;
});
