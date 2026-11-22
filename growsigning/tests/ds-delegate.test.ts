// Someone who signs for a person while they are away (src/server/delegation.ts): the admins' switch, a person's
// delegate and their dates, the sender's "Only the person named may sign", whoever agrees first, the person told,
// the certificate line, the saved signature never offered, and one signature used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, PNG, upload, signUp } from './helpers.ts';
import { certLine, datesProblem, todayIn, DELEGATION_MAX_DAYS } from '../src/lib/delegation.ts';

const { db, env } = await boot();
const ok = (r: { status: number; data: any }, status = 200) => (assert.equal(r.status, status, JSON.stringify(r.data)), r.data);
let n = 0;
const ip = () => `198.51.100.${++n}`;
const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const emailCode = (to: string) => /(\d{6}) is your code/.exec(db.get("SELECT html FROM emails WHERE to_email=? AND subject LIKE 'Your code to open%' ORDER BY id DESC LIMIT 1", to)?.html || '')?.[1] as string;
const mails = (to: string) => db.all('SELECT subject, html, link FROM emails WHERE to_email=? ORDER BY id', to);
const linkIn = (html: string) => /\/sign\/([A-Za-z0-9_-]{20,})/.exec(html)?.[1] as string;

// An owner, and Ana, a member of the same account with a confirmed address.
async function team(tag: string) {
  const owner = await signUp(`Olivia ${tag}`, `olivia.${tag}@dlg.example`, ip());
  ok(await owner.post('/account/invites', { email: `ana.${tag}@dlg.example`, role: 'member' }));
  const ana = new Client();
  ana.ip = ip();
  ok(await ana.post('/auth/signup', { name: 'Ana Silva', email: `ana.${tag}@dlg.example`, password: 'correct horse battery', invite: db.get('SELECT token FROM invites WHERE email=?', `ana.${tag}@dlg.example`).token }));
  const u = db.get('SELECT * FROM users WHERE email=?', `ana.${tag}@dlg.example`);
  if (!u.email_verified) ok(await ana.post('/auth/verify', { token: u.verify_token }));
  return { owner, ana, anaEmail: `ana.${tag}@dlg.example`, bob: `bob.${tag}@dlg.example` };
}

async function sendTo(c: Client, email: string, over: any = {}) {
  const file = await upload(c, 1);
  const r = ok(await c.post('/envelopes', {
    subject: 'Supplier contract', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', name: 'Ana Silva', email }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
    send: true, ...over,
  }));
  const e = r.envelope;
  if (e.status === 'draft') ok(await c.post(`/envelopes/${e.id}/send`));
  return env.loadEnvelope(e.id);
}

// The delegate opens their link, gets the code by email, types it.
async function delegateIn(tok: string, email: string) {
  const d = new Client();
  d.ip = ip();
  const locked = ok(await d.get(`/sign/${tok}`));
  assert.equal(locked.needs, 'code', 'a delegate always types a one-time code first');
  ok(await d.post(`/sign/${tok}/code`));
  ok(await d.post(`/sign/${tok}/code/check`, { code: emailCode(email) }));
  return d;
}

test('the rules for dates, and the certificate line, are plain', () => {
  const today = todayIn(null);
  assert.equal(datesProblem(day(0), day(5), today), null);
  assert.match(datesProblem(day(5), day(1), today)!, /before the first day/);
  assert.match(datesProblem(day(-10), day(-2), today)!, /over already/);
  assert.match(datesProblem(day(0), day(DELEGATION_MAX_DAYS + 3), today)!, /up to 92 days/);
  assert.match(datesProblem('2027-02-30', '2027-03-02', today)!, /year-month-day/);
  const line = certLine({ delegate: 'Bob Reyes', person: 'Ana Silva', setOn: '2027-03-01T10:00:00Z', from: '2027-03-03', to: '2027-03-14' });
  assert.equal(line, 'Signed by Bob Reyes for Ana Silva, under a delegation Ana Silva set on 1 March 2027 for 3 March 2027 to 14 March 2027. GrowSigning does not know whether Bob Reyes has the authority to sign for Ana Silva.');
  assert.ok(!/\u2014/.test(line), 'no em dash');
});

test('off by default: nobody can name a delegate, and nothing changes for senders or signers', async () => {
  const t = await team('off');
  const mine = ok(await t.ana.get('/me/delegate'));
  assert.equal(mine.allowed, false);
  const no = await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(3) });
  assert.equal(no.status, 403);
  assert.match(no.data.error || no.data.message || '', /have not allowed delegates/);
  assert.equal((await t.owner.get('/me')).data.delegation, undefined, 'the app is told nothing while it is off');
  // A member cannot switch it on.
  assert.equal((await t.ana.put('/account/delegation', { on: true })).status, 403);
  const e = await sendTo(t.owner, t.anaEmail);
  assert.equal(db.all('SELECT * FROM delegate_links WHERE envelope_id=?', e.id).length, 0);
});

test('a delegate for dates: before the first day nothing goes to them, on the days the request goes to both', async () => {
  const t = await team('dates');
  ok(await t.owner.put('/account/delegation', { on: true }));
  assert.equal((await t.owner.get('/me')).data.delegation, true);
  // Your own address is refused, and so is an address that is not one.
  assert.equal((await t.ana.put('/me/delegate', { name: 'Me', email: t.anaEmail, starts_on: day(0), ends_on: day(2) })).status, 400);
  assert.equal((await t.ana.put('/me/delegate', { name: 'Bob', email: 'nope', starts_on: day(0), ends_on: day(2) })).status, 400);
  // Later days: saved, the delegate is told at once, and a document today goes to Ana only.
  const later = ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(5), ends_on: day(9) }));
  assert.equal(later.delegate.name, 'Bob Reyes');
  assert.equal(later.active, false);
  assert.match(mails(t.bob).at(-1).subject, /named you to sign for them/);
  const before = await sendTo(t.owner, t.anaEmail);
  assert.equal(db.all('SELECT * FROM delegate_links WHERE envelope_id=?', before.id).length, 0, 'not before the first day');
  // From today: the next document goes to both, and Ana's own email says so.
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(4) }));
  const e = await sendTo(t.owner, t.anaEmail);
  const links = db.all('SELECT * FROM delegate_links WHERE envelope_id=?', e.id);
  assert.equal(links.length, 1);
  const toAna = mails(t.anaEmail).filter((m: any) => /Supplier contract/.test(m.subject)).at(-1);
  assert.match(toAna.html, /Bob Reyes can also sign this for you/);
  const toBob = mails(t.bob).at(-1);
  assert.match(toBob.subject, /For Ana Silva: Supplier contract/);
  assert.equal(linkIn(toBob.link || toBob.html), links[0].token);
  // The sender sees who else has it, never a link.
  const seen = ok(await t.owner.get(`/envelopes/${e.id}`)).envelope;
  const r = seen.recipients[0];
  assert.equal(r.delegation.name, 'Bob Reyes');
  assert.equal(r.delegation.state, 'open');
  assert.ok(!JSON.stringify(seen).includes(links[0].token));
  // A document from another account still goes to Ana only.
  const stranger = await signUp('Sol Outside', 'sol@outside.example', ip());
  const out = await sendTo(stranger, t.anaEmail);
  assert.equal(db.all('SELECT * FROM delegate_links WHERE envelope_id=?', out.id).length, 0, 'only documents from the account that allowed it');
  // Stopping it early: links nobody acted on stop working.
  ok(await t.ana.call('DELETE', '/me/delegate'));
  const gone = await new Client().get(`/sign/${links[0].token}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.data.recipient.delegate.state, 'removed');
  assert.equal(gone.data.documents, undefined, 'a stopped link shows no document');
});

test('the sender forbids it: "Only the person named may sign"', async () => {
  const t = await team('forbid');
  ok(await t.owner.put('/account/delegation', { on: true }));
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(3) }));
  // Ticked on the draft: nothing goes to the delegate.
  const file = await upload(t.owner, 1);
  const draft = ok(await t.owner.post('/envelopes', { subject: 'Only Ana', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Ana Silva', email: t.anaEmail }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).envelope;
  ok(await t.owner.put(`/envelopes/${draft.id}/only-named`, { on: true }));
  ok(await t.owner.post(`/envelopes/${draft.id}/send`));
  assert.equal(db.all('SELECT * FROM delegate_links WHERE envelope_id=?', draft.id).length, 0);
  // Ticked after sending: the delegate's link stops, before they acted.
  const e = await sendTo(t.owner, t.anaEmail);
  const l = db.get('SELECT * FROM delegate_links WHERE envelope_id=?', e.id);
  ok(await t.owner.put(`/envelopes/${e.id}/only-named`, { on: true }));
  const view = ok(await new Client().get(`/sign/${l.token}`));
  assert.equal(view.recipient.delegate.state, 'removed');
  assert.equal((await new Client().post(`/sign/${l.token}/consent`)).status, 403);
  // Someone else's envelope cannot be changed by a member who cannot open it.
  assert.equal((await t.ana.put(`/envelopes/${e.id}/only-named`, { on: false })).status, 404);
});

test('first one takes it: the delegate signs with their own name for Ana, Ana is told, the certificate says so, one signature', async () => {
  const t = await team('first');
  ok(await t.owner.put('/account/delegation', { on: true }));
  // Ana saved a signature on her account. It is never offered to Bob.
  ok(await t.ana.call('PATCH', '/me', { signature_png: PNG }));
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(3) }));
  const e = await sendTo(t.owner, t.anaEmail);
  const l = db.get('SELECT * FROM delegate_links WHERE envelope_id=?', e.id);
  const anaTok = e.recipients[0].token;
  const bob = await delegateIn(l.token, t.bob);
  // Before agreeing: Bob is the recipient on his own page, signing for Ana, with nothing of Ana's.
  const v = ok(await bob.get(`/sign/${l.token}`));
  assert.equal(v.recipient.name, 'Bob Reyes');
  assert.equal(v.recipient.email, t.bob);
  assert.equal(v.recipient.signature_png ?? null, null);
  assert.deepEqual([v.recipient.delegate.as, v.recipient.delegate.state, v.recipient.delegate.for_name], ['delegate', 'open', 'Ana Silva']);
  // Nothing can be saved before agreeing.
  assert.equal((await bob.post(`/sign/${l.token}/save`, { values: {} })).status, 409);
  // Ana's own page meanwhile says Bob could take it.
  const anaView = ok(await new Client().get(`/sign/${anaTok}`));
  assert.equal(anaView.recipient.delegate.state, 'open');
  assert.equal(anaView.recipient.delegate.by_name, 'Bob Reyes');
  const held = db.get("SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature'", e.account_id).n;
  // Bob agrees first: it is his.
  ok(await bob.post(`/sign/${l.token}/consent`));
  const row = db.get('SELECT * FROM recipients WHERE id=?', e.recipients[0].id);
  assert.equal(row.name, 'Bob Reyes');
  assert.equal(row.delegate_for, 'Ana Silva');
  assert.equal(row.token, l.token);
  assert.match(mails(t.anaEmail).at(-1).subject, /Bob Reyes is signing for you/);
  // Ana's own link now says who has it, and opens nothing.
  const anaNow = ok(await new Client().get(`/sign/${anaTok}`));
  assert.equal(anaNow.recipient.delegate.state, 'by_delegate');
  assert.equal(anaNow.documents, undefined);
  assert.equal((await new Client().post(`/sign/${anaTok}/consent`)).status, 409);
  // Bob cannot pass it on (no chain of delegates) or rename himself to Ana.
  assert.equal((await bob.post(`/sign/${l.token}/reassign`, { name: 'Cleo Third', email: 'cleo@dlg.example', reason: 'busy' })).status, 409);
  assert.equal((await bob.post(`/sign/${l.token}/name`, { name: 'Ana Silva' })).status, 409);
  // He signs with his own signature.
  const mineNow = ok(await bob.get(`/sign/${l.token}`));
  assert.equal(mineNow.recipient.signature_png ?? null, null, 'Ana saved signature is never on his page');
  const values: Record<string, string> = {};
  for (const f of mineNow.fields) values[f.id] = '1';
  ok(await bob.post(`/sign/${l.token}/complete`, { values, signature_png: PNG }));
  const done = env.loadEnvelope(e.id);
  assert.equal(done.status, 'completed');
  assert.match(mails(t.anaEmail).at(-1).subject, /Bob Reyes signed for you/);
  // One signature: the one request Ana had, signed once, by Bob. No second recipient was made for him.
  assert.equal(db.get("SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature'", e.account_id).n, held);
  assert.equal(done.recipients.length, 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM fields WHERE envelope_id=? AND type='signature' AND value IS NOT NULL AND value != ''", e.id).n, 1);
  assert.equal(db.get('SELECT signature_png s FROM recipients WHERE id=?', done.recipients[0].id).s, PNG);
  // The signed PDF's certificate carries the line.
  const pdf = await t.owner.get(`/envelopes/${e.id}/download`);
  assert.equal(pdf.status, 200);
  const { extractText } = await import('../src/server/text.ts');
  const text = (await extractText(pdf.data)).replace(/\s+/g, ' ');
  assert.match(text, /Signed by Bob Reyes for Ana Silva, under a delegation Ana Silva set on/);
  assert.match(text, /does not know whether Bob Reyes has the authority to sign for Ana Silva/);
  // The record and the certificate.
  const trail = db.all('SELECT actor, action, detail FROM audit WHERE envelope_id=? ORDER BY seq', e.id);
  assert.ok(trail.some((a: any) => a.action === 'Taken on for someone away' && /Bob Reyes <bob\.first@dlg\.example> took this on for Ana Silva/.test(a.detail)));
  assert.ok(trail.some((a: any) => /^Bob Reyes, for Ana Silva/.test(a.actor) && /Signed|Completed/i.test(a.action)), JSON.stringify(trail.map((a: any) => [a.actor, a.action])));
  const { delegateCertLines } = await import('../src/server/delegation.ts');
  const lines = delegateCertLines(done, done.recipients[0]);
  assert.equal(lines.length, 1);
  assert.match(lines[0][1], /^Signed by Bob Reyes for Ana Silva, under a delegation Ana Silva set on .* GrowSigning does not know whether Bob Reyes has the authority to sign for Ana Silva\.$/);
  // The certificate's identity check is the code Bob typed at his own address.
  const { withCheckLines } = await import('../src/server/signercode.ts');
  assert.match(withCheckLines(done).recipients[0].check_line, /One-time code sent by email to b/);
});

test('the person agrees first: the delegate link says so and can do nothing', async () => {
  const t = await team('person');
  ok(await t.owner.put('/account/delegation', { on: true }));
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(3) }));
  const e = await sendTo(t.owner, t.anaEmail);
  const l = db.get('SELECT * FROM delegate_links WHERE envelope_id=?', e.id);
  const bob = await delegateIn(l.token, t.bob);
  ok(await new Client().post(`/sign/${e.recipients[0].token}/consent`));
  const v = ok(await bob.get(`/sign/${l.token}`));
  assert.equal(v.recipient.delegate.state, 'taken');
  const no = await bob.post(`/sign/${l.token}/consent`);
  assert.equal(no.status, 409);
  assert.equal(db.get('SELECT name FROM recipients WHERE id=?', e.recipients[0].id).name, 'Ana Silva');
});

test('not for in-person signing, a document Ana sends herself, or a delegate already on it; reminders reach the delegate', async () => {
  const t = await team('never');
  ok(await t.owner.put('/account/delegation', { on: true }));
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(3) }));
  const file = await upload(t.owner, 1);
  const inPerson = ok(await t.owner.post('/envelopes', { subject: 'At the desk', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'inperson', name: 'Ana Silva', email: t.anaEmail }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).envelope;
  await t.owner.post(`/envelopes/${inPerson.id}/send`);
  assert.equal(db.all('SELECT * FROM delegate_links WHERE envelope_id=?', inPerson.id).length, 0);
  // Ana sending to herself: hers to sign.
  const self = await sendTo(t.ana, t.anaEmail);
  assert.equal(db.all('SELECT * FROM delegate_links WHERE envelope_id=?', self.id).length, 0);
  // The delegate already on the envelope does not sign twice.
  const both = await sendTo(t.owner, t.anaEmail, { recipients: [{ id: 'r', role: 'signer', name: 'Ana Silva', email: t.anaEmail }, { id: 'b', role: 'signer', name: 'Bob Reyes', email: t.bob }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'g', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }] });
  assert.equal(db.all('SELECT * FROM delegate_links WHERE envelope_id=?', both.id).length, 0);
  // A reminder goes to the delegate too while nobody has acted.
  const e = await sendTo(t.owner, t.anaEmail);
  const count = mails(t.bob).length;
  ok(await t.owner.post(`/envelopes/${e.id}/remind`, {}));
  assert.equal(mails(t.bob).length, count + 1);
  assert.match(mails(t.bob).at(-1).subject, /^Reminder: For Ana Silva/);
});

test('a delegate who declines declines for the person, on record as themselves, and the person is told', async () => {
  const t = await team('decline');
  ok(await t.owner.put('/account/delegation', { on: true }));
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(3) }));
  const e = await sendTo(t.owner, t.anaEmail);
  const l = db.get('SELECT * FROM delegate_links WHERE envelope_id=?', e.id);
  const bob = await delegateIn(l.token, t.bob);
  assert.equal((await bob.post(`/sign/${l.token}/decline`, { reason: '' })).status, 400, 'an empty reason takes nothing on');
  assert.equal(db.get('SELECT delegate_link_id FROM recipients WHERE id=?', e.recipients[0].id).delegate_link_id, null);
  ok(await bob.post(`/sign/${l.token}/decline`, { reason: 'Ana should read the price list first.' }));
  assert.equal(env.loadEnvelope(e.id).status, 'declined');
  assert.match(mails(t.anaEmail).at(-1).subject, /Bob Reyes declined for you/);
  // An admin switching it off stops nothing that is done, and every open link.
  ok(await t.owner.put('/account/delegation', { on: false }));
  assert.equal(ok(await t.ana.get('/me/delegate')).delegate, null);
});

test('abuse: the sender as delegate gets nothing extra, a delegate cannot pass it on before agreeing, saves are limited', async () => {
  const t = await team('abuse');
  ok(await t.owner.put('/account/delegation', { on: true }));
  // Ana names the owner, who then sends to Ana: the owner never signs in Ana's name on their own document.
  ok(await t.ana.put('/me/delegate', { name: 'Olivia abuse', email: 'olivia.abuse@dlg.example', starts_on: day(0), ends_on: day(2) }));
  const e = await sendTo(t.owner, t.anaEmail);
  assert.equal(db.all('SELECT * FROM delegate_links WHERE envelope_id=?', e.id).length, 0);
  // Before agreeing, a delegate's link cannot pass the document on.
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(2) }));
  const e2 = await sendTo(t.owner, t.anaEmail);
  const l = db.get('SELECT * FROM delegate_links WHERE envelope_id=?', e2.id);
  const bob = await delegateIn(l.token, t.bob);
  assert.equal((await bob.post(`/sign/${l.token}/reassign`, { name: 'Cleo Third', email: 'cleo@dlg.example', reason: 'busy' })).status, 409);
  // A link without the code opens nothing.
  const stranger = await new Client().get(`/sign/${l.token}/doc/${e2.documents[0].id}`);
  assert.equal(stranger.status, 401);
  // Every save emails the delegate, so they are limited: nobody fills an inbox with "you were named".
  let last = 200;
  for (let i = 0; i < 8 && last === 200; i++) last = (await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(2) })).status;
  assert.equal(last, 429);
});

// ---- After the skeptic's and the simplicity reviewer's reports (repair-ds-delegate) ----------------------------

test('a delegation whose last day is over ends by itself: no reminder, no taking on, without anyone opening Settings', async () => {
  const t = await team('over');
  ok(await t.owner.put('/account/delegation', { on: true }));
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(1) }));
  const e = await sendTo(t.owner, t.anaEmail);
  const l = db.get('SELECT * FROM delegate_links WHERE envelope_id=?', e.id);
  const bob = await delegateIn(l.token, t.bob);
  // The days pass. Nobody opens Settings.
  db.run('UPDATE delegations SET starts_on=?, ends_on=? WHERE id=?', day(-10), day(-5), l.delegation_id);
  db.run('UPDATE delegate_links SET starts_on=?, ends_on=? WHERE id=?', day(-10), day(-5), l.id);
  const v = ok(await bob.get(`/sign/${l.token}`));
  assert.equal(v.recipient.delegate.state, 'removed');
  assert.equal(v.documents, undefined);
  assert.equal((await bob.post(`/sign/${l.token}/consent`)).status, 403, 'an ended delegation takes nothing on');
  const count = mails(t.bob).length;
  ok(await t.owner.post(`/envelopes/${e.id}/remind`, {}));
  assert.equal(mails(t.bob).length, count, 'no reminder to a delegate whose days are over');
  // Ana's own page no longer says Bob could take it, and the sender sees it stopped.
  assert.equal(ok(await new Client().get(`/sign/${e.recipients[0].token}`)).recipient.delegate ?? null, null);
  assert.equal(ok(await t.owner.get(`/envelopes/${e.id}`)).envelope.recipients[0].delegation.state, 'stopped');
});

test('the delegate asking for a code never ends the code the person is about to type', async () => {
  const t = await team('codes');
  ok(await t.owner.put('/account/delegation', { on: true }));
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(3) }));
  const e = await sendTo(t.owner, t.anaEmail, { recipients: [{ id: 'r', role: 'signer', name: 'Ana Silva', email: t.anaEmail, verify: 'email_code' }] });
  const l = db.get('SELECT * FROM delegate_links WHERE envelope_id=?', e.id);
  const ana = new Client();
  ana.ip = ip();
  const bob = new Client();
  bob.ip = ip();
  ok(await ana.post(`/sign/${e.recipients[0].token}/code`));
  const anaCode = emailCode(t.anaEmail);
  // Bob asks for his, several times over (each a minute apart): Ana's still works, and she is not made to wait.
  for (let i = 0; i < 3; i++) {
    ok(await bob.post(`/sign/${l.token}/code`));
    db.run("UPDATE signer_codes SET at=datetime(at, '-2 minutes') WHERE recipient_id=?", e.recipients[0].id);
  }
  ok(await ana.post(`/sign/${e.recipients[0].token}/code/check`, { code: anaCode }));
  ok(await bob.post(`/sign/${l.token}/code/check`, { code: emailCode(t.bob) }));
  assert.ok(ok(await ana.get(`/sign/${e.recipients[0].token}`)).documents, 'Ana is in');
});

test('the name of a delegate follows the rules of a name on a certificate', async () => {
  const t = await team('names');
  ok(await t.owner.put('/account/delegation', { on: true }));
  const put = (name: string, email = t.bob) => t.ana.put('/me/delegate', { name, email, starts_on: day(0), ends_on: day(2) });
  const own = await put('Ana Silva');
  assert.equal(own.status, 400);
  assert.match(own.data.error, /That is your own name/);
  assert.equal((await put('ana silva')).status, 400);
  // Someone else in the account, at another address.
  const owner = await put('Olivia names');
  assert.equal(owner.status, 400);
  assert.match(owner.data.error, /Olivia names is in this account with another address \(olivia\.names@dlg\.example\)/);
  assert.equal((await put('Bob<script>Reyes')).status, 400);
  assert.equal((await put('Bоb Reyes')).status, 400, 'a Cyrillic o inside a Latin word');
  // Marks that turn text around are dropped, and a name that is right is kept as typed.
  const fine = ok(await put('Bob‮Reyes'));
  assert.equal(fine.delegate.name, 'Bob Reyes');
  assert.ok(!/[‪-‮]/.test(db.get('SELECT name FROM delegations WHERE id=?', fine.delegate.id).name));
});

test('before agreeing, the page side calls that write nothing of the person work; the person questions stay theirs', async () => {
  const t = await team('side');
  ok(await t.owner.put('/account/delegation', { on: true }));
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(3) }));
  const e = await sendTo(t.owner, t.anaEmail);
  const l = db.get('SELECT * FROM delegate_links WHERE envelope_id=?', e.id);
  const bob = await delegateIn(l.token, t.bob);
  for (const p of ['away', 'impact', 'stamps']) assert.equal((await bob.get(`/sign/${l.token}/${p}`)).status, 200, p);
  assert.equal((await bob.get(`/sign/${l.token}/comments`)).status, 409, 'Ana private thread with the sender is not his to read');
  assert.equal((await bob.post(`/sign/${l.token}/mute`, {})).status, 409, 'Ana reminders are not his to stop');
  assert.equal((await bob.post(`/sign/${l.token}/locale`, { locale: null })).status, 409, 'Ana language is not his to save');
  assert.equal(db.get('SELECT delegate_link_id FROM recipients WHERE id=?', e.recipients[0].id).delegate_link_id, null, 'nothing was taken on');
  // The code screen says why there is a check: Ana named him, not that the sender asked.
  const locked = ok(await new Client().get(`/sign/${l.token}`));
  assert.equal(locked.check.delegate_for, 'Ana Silva');
  assert.equal(locked.check.delegate_verb, 'sign');
});

test('a sender who corrects a request back to the person gives them the check the sender chose, and the delegate gets nothing again', async () => {
  const t = await team('back');
  ok(await t.owner.put('/account/delegation', { on: true }));
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(3) }));
  const e = await sendTo(t.owner, t.anaEmail);
  const l = db.get('SELECT * FROM delegate_links WHERE envelope_id=?', e.id);
  const bob = await delegateIn(l.token, t.bob);
  ok(await bob.post(`/sign/${l.token}/consent`));
  const rid = e.recipients[0].id;
  assert.equal(db.get('SELECT verify FROM recipients WHERE id=?', rid).verify, 'email_code');
  const toBob = mails(t.bob).length;
  ok(await t.owner.post(`/envelopes/${e.id}/correct`, { recipient_id: rid, name: 'Ana Silva', email: t.anaEmail }));
  const row = db.get('SELECT * FROM recipients WHERE id=?', rid);
  assert.deepEqual([row.verify ?? null, row.delegate_link_id, row.delegate_for, row.delegate_verify_was], [null, null, null, null]);
  assert.equal(db.all('SELECT * FROM delegate_links WHERE envelope_id=?', e.id).length, 1, 'no second link for Bob');
  assert.equal(mails(t.bob).length, toBob, 'Bob is not sent it again');
  const v = ok(await new Client().get(`/sign/${row.token}`));
  assert.notEqual(v.needs, 'code', 'Ana is not asked for a code nobody asked for');
  assert.ok(v.documents);
  assert.equal(v.recipient.delegate ?? null, null);
  const { delegateCertLines } = await import('../src/server/delegation.ts');
  assert.deepEqual(delegateCertLines(env.loadEnvelope(e.id), row), []);
});

test('step 3 is told who is away and who signs for them, only then, and never a delegate address', async () => {
  const t = await team('step3');
  const file = await upload(t.owner, 1);
  const draft = ok(await t.owner.post('/envelopes', { subject: 'Draft', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Ana Silva', email: t.anaEmail }], fields: [] })).envelope;
  const ask = (people: any[]) => t.owner.post(`/envelopes/${draft.id}/away`, { people });
  const anaRow = { name: 'Ana Silva', email: t.anaEmail, role: 'signer' };
  // Off: nothing, even with a delegate set before.
  assert.deepEqual(ok(await ask([anaRow])).away, []);
  ok(await t.owner.put('/account/delegation', { on: true }));
  assert.deepEqual(ok(await ask([anaRow])).away, [], 'on, but Ana named nobody');
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(2), ends_on: day(4) }));
  assert.deepEqual(ok(await ask([anaRow])).away, [], 'not yet her days');
  ok(await t.ana.put('/me/delegate', { name: 'Bob Reyes', email: t.bob, starts_on: day(0), ends_on: day(4) }));
  const r = ok(await ask([anaRow, { name: 'Sam', email: 'sam.step3@dlg.example', role: 'signer' }]));
  assert.deepEqual(r.away, [{ email: t.anaEmail, name: 'Ana Silva', delegate: 'Bob Reyes', role: 'signer' }]);
  assert.ok(!JSON.stringify(r).includes(t.bob), 'never the delegate address');
  // Never for a witness, someone in person, a group, or a delegate already on it; without people, the draft as saved.
  for (const role of ['witness', 'inperson', 'viewer', 'cc']) assert.deepEqual(ok(await ask([{ ...anaRow, role }])).away, [], role);
  assert.deepEqual(ok(await ask([anaRow, { name: 'Bob Reyes', email: t.bob, role: 'signer' }])).away, []);
  assert.deepEqual(ok(await ask([{ ...anaRow, group_id: 'grp_x' }])).away, []);
  assert.equal(ok(await t.owner.post(`/envelopes/${draft.id}/away`, {})).away.length, 1);
  // A public form never goes to a delegate.
  const { awayFor } = await import('../src/server/delegation.ts');
  assert.deepEqual(awayFor({ ...env.loadEnvelope(draft.id), powerform_id: 'pf_x' }, [anaRow]), []);
  // Someone who cannot open the draft learns nothing.
  assert.equal((await t.ana.post(`/envelopes/${draft.id}/away`, { people: [anaRow] })).status, 404);
});

test('the words: short dates, the step 3 line, no "delegate" on the cards, full stops', async () => {
  const { datesShort, awayLine, senderLine, SWITCH_HINT, CARD_TITLE, CARD_HINT } = await import('../src/lib/delegation.ts');
  assert.equal(datesShort('2026-11-22', '2026-11-27'), 'from 22 to 27 November 2026');
  assert.equal(datesShort('2026-11-28', '2026-12-03'), 'from 28 November to 3 December 2026');
  assert.equal(datesShort('2026-12-30', '2027-01-02'), 'from 30 December 2026 to 2 January 2027');
  assert.equal(awayLine({ name: 'Ana Silva', delegate: 'Bob Reyes', role: 'signer' }), 'Ana Silva is away and named Bob Reyes to sign for them. Tick the box so only Ana Silva may sign.');
  assert.match(senderLine({ state: 'open', for_name: 'Ana', name: 'Bob', email: 'b@x', dates: 'on 1 May 2027' }, 'signer'), /takes it on\.$/);
  assert.match(CARD_TITLE, /^Documents sent to me: /);
  for (const w of [SWITCH_HINT, CARD_TITLE, CARD_HINT('Acme'), datesProblem(day(0), day(DELEGATION_MAX_DAYS + 3), todayIn(null))!]) {
    assert.ok(!/delegat/i.test(w), w);
    assert.ok(!/—/.test(w), w);
  }
  const en = JSON.parse((await import('node:fs')).readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));
  for (const k of ['sign.delegate.take_on', 'sign.delegate.person_note'])
    for (const sentence of en[k].replace(/\{name\}/g, 'Ana Silva').split(/(?<=\.)\s+/)) assert.ok(sentence.split(/\s+/).length <= 20, sentence);
});
