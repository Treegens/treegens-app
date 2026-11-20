// A witness for one signer: asked straight after that signer, never charged, a statement of their own, "I was not
// there", marks on the certificate, and what every other part of the product does with the role.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, upload, mailTo, tokenFor, PNG, type Server } from './helpers.ts';

let db: Server['db'];
let env: Server['env'];
before(async () => {
  ({ db, env } = await boot());
});

let n = 0;
const ip = () => `10.${160 + Math.floor(++n / 250)}.${n % 250}.7`;
const person = (name: string, email: string) => signUp(name, email, ip());
const browser = () => Object.assign(new Client(), { ip: ip() });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const auditOf = (id: string) => db.all('SELECT actor, action, detail FROM audit WHERE envelope_id=? ORDER BY seq', id);
const row = (id: string) => db.get('SELECT * FROM recipients WHERE id=?', id);
const rows = (eid: string) => db.all('SELECT * FROM recipients WHERE envelope_id=? ORDER BY position', eid);
const witnessRow = (eid: string) => db.get("SELECT * FROM recipients WHERE envelope_id=? AND role='witness'", eid);
const pdfText = async (bytes: Uint8Array) => (await import('../src/server/text.ts')).extractText(bytes);
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// The block the editor places for a witness: their signature, name, address, occupation and the date.
const block = (rid: string, doc = 'd', y = 0.6) => [
  { document_id: doc, recipient_id: rid, type: 'signature', page: 0, x: 0.1, y, w: 0.22, h: 0.05, label: 'Witness signature' },
  { document_id: doc, recipient_id: rid, type: 'full_name', page: 0, x: 0.1, y: y + 0.06, w: 0.3, h: 0.024, label: 'Witness name' },
  { document_id: doc, recipient_id: rid, type: 'text', page: 0, x: 0.1, y: y + 0.09, w: 0.4, h: 0.045, label: 'Witness address' },
  { document_id: doc, recipient_id: rid, type: 'text', page: 0, x: 0.1, y: y + 0.145, w: 0.3, h: 0.024, label: 'Witness occupation' },
  { document_id: doc, recipient_id: rid, type: 'date_signed', page: 0, x: 0.5, y, w: 0.16, h: 0.024, label: 'Date witnessed' },
];

// A deed: Ann signs with a witness, Ben signs after her in the order. `witness` overrides the witness row.
async function deed(c: Client, witness: any = {}, over: any = {}) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    subject: 'Deed of gift', ordered: true,
    documents: [{ id: 'd', file_id: file.id, name: 'Deed' }],
    recipients: [
      { id: 'ann', role: 'signer', name: 'Ann Signer', email: `ann.${n}@deed.example`, routing_order: 1 },
      { id: 'wit', role: 'witness', witness_for: 'ann', name: 'Will Witness', email: `will.${n}@deed.example`, ...witness },
      { id: 'ben', role: 'signer', name: 'Ben Second', email: `ben.${n}@deed.example`, routing_order: 2 },
    ],
    fields: [
      { document_id: 'd', recipient_id: 'ann', type: 'signature', page: 0, x: 0.1, y: 0.4, w: 0.25, h: 0.06 },
      ...block('wit'),
      { document_id: 'd', recipient_id: 'ben', type: 'signature', page: 0, x: 0.55, y: 0.4, w: 0.25, h: 0.06 },
    ],
    ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
const ids = (e: any) => ({ ann: e.recipients.find((r: any) => r.name === 'Ann Signer').id, wit: e.recipients.find((r: any) => r.role === 'witness').id, ben: e.recipients.find((r: any) => r.name === 'Ben Second').id });

// Signs as whoever holds this token, in `b` (a browser of its own unless given).
async function finish(tok: string, b = browser(), values: Record<string, string> = {}) {
  await b.post(`/sign/${tok}/consent`);
  const v = (await b.get(`/sign/${tok}`)).data;
  const all: Record<string, string> = { ...values };
  for (const f of v.fields || []) if (!(f.id in all)) all[f.id] = f.type === 'text' ? `${f.label || 'answer'} filled` : '1';
  return b.post(`/sign/${tok}/complete`, { values: all, signature_png: PNG, initials_png: PNG, version: v.version });
}
// The witness's own steps: their first screen, the statement as it is shown, then Finish.
async function witness(tok: string, b = browser()) {
  const first = (await b.get(`/sign/${tok}`)).data;
  const said = await b.post(`/sign/${tok}/witness-statement`, { statement: first.recipient.witness_of.statement });
  assert.equal(said.status, 200, JSON.stringify(said.data));
  return finish(tok, b, { });
}

// ---- 1. The role: tied to one signer, asked straight after them, never charged, a block of their own ----------

test('a witness is asked straight after their signer, holds nobody up in the order, and uses no signature', async () => {
  const s = await person('Sara Sender', 'sara@deed.example');
  const account = (await s.get('/me')).data.account.id;
  process.env.STRIPE_SECRET_KEY = 'sk_test_witness';
  try {
    const e = await deed(s);
    const { ann, wit, ben } = ids(e);
    assert.equal(row(wit).witness_for, ann, 'the witness points at the signer by the id the server gave her');
    assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
    // Two signers hold two signatures. The witness holds none: reserved() and isChargeable() count only signer and inperson.
    const { reserved, isChargeable } = await import('../src/server/credits.ts');
    assert.equal(reserved(account), 2);
    assert.equal(isChargeable(row(wit), 'sara@deed.example'), false);
    assert.equal(row(wit).status, 'pending', 'not asked before Ann has signed');
    assert.equal(mailTo(row(wit).email).length, 0);

    assert.equal((await finish(tokenFor(e.id, row(ann).email))).status, 200);
    assert.equal(row(wit).status, 'sent', 'asked straight after Ann');
    assert.equal(row(ben).status, 'sent', 'Ben does not wait for the witness');
    const mail = mailTo(row(wit).email).pop();
    assert.match(mail.subject, /Deed of gift/);
    assert.match(text(mail.html), /Sara Sender asked you to witness the signature of Ann Signer on Deed of gift/);
    assert.match(text(mail.html), /Open the link only if you were physically with Ann Signer and watched them sign/);
    assert.match(text(mail.html), /Open and witness/);

    assert.equal((await witness(tokenFor(e.id, row(wit).email))).status, 200);
    assert.equal(row(wit).status, 'completed');
    assert.equal(db.get("SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature'", account).n, 1, 'Ann used one, the witness none');
    assert.equal((await finish(tokenFor(e.id, row(ben).email))).status, 200);
    assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'completed');
    assert.equal(db.get("SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature'", account).n, 2, 'two signers, two signatures, the witness free');
    const a = auditOf(e.id).map((x: any) => x.action);
    assert.ok(a.includes('Witnessed') && a.includes('Witness statement'), a.join(', '));
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test('a witness is tied to one person who signs: every way that cannot work is said before anything goes out', async () => {
  const s = await person('Rita Rules', 'rita@deed.example');
  const file = await upload(s, 1);
  const base = (recipients: any[], fields: any[] = []) => s.post('/envelopes', { subject: 'Rules', send: true, documents: [{ id: 'd', file_id: file.id }], recipients, fields: [{ document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, ...fields] });
  const ann = { id: 'a', role: 'signer', name: 'Ann Rules', email: 'ann@rules.example' };
  const cases: [any[], any[], RegExp][] = [
    [[ann, { id: 'w', role: 'witness', name: 'Wes', email: 'wes@rules.example' }], block('w'), /Choose whose signature they witness/],
    [[ann, { id: 'w', role: 'witness', witness_for: 'nobody', name: 'Wes', email: 'wes@rules.example' }], block('w'), /no longer on this document/],
    [[ann, { id: 'v', role: 'viewer', name: 'Vic', email: 'vic@rules.example' }, { id: 'w', role: 'witness', witness_for: 'v', name: 'Wes', email: 'wes@rules.example' }], block('w'), /Vic, who does not sign this document/],
    [[ann, { id: 'w', role: 'witness', witness_for: 'a', name: 'Wes', email: 'wes@rules.example' }, { id: 'x', role: 'witness', witness_for: 'a', name: 'Xia', email: 'xia@rules.example' }], [...block('w'), ...block('x', 'd', 0.3)], /Ann Rules has two witnesses here/],
    [[ann, { id: 'w', role: 'witness', witness_for: 'a', name: 'Ann Rules', email: 'ann@rules.example' }], block('w'), /witness of their own signature/],
    [[ann, { id: 'w', role: 'witness', witness_for: 'a', name: 'Wes', email: 'wes@rules.example' }], [], /has no signature field yet\. Place the witness block for them near the signature of Ann Rules/],
    [[ann, { id: 'w', role: 'witness', witness_for: 'a', name: 'Wes', link_by_sender: true }], block('w'), /Untick "I will send the link myself"/],
    [[ann, { id: 'w', role: 'witness', witness_for: 'a', name: 'Wes', email: 'wes@rules.example' }, { id: 'x', role: 'witness', witness_for: 'w', name: 'Xia', email: 'xia@rules.example' }], [...block('w'), ...block('x', 'd', 0.3)], /Wes, who does not sign this document/],
  ];
  for (const [people, fields, said] of cases) {
    const r = await base(people, fields);
    assert.equal(r.status, 400, `${said}: ${JSON.stringify(r.data)}`);
    assert.match(r.data.error, said);
  }
  // A draft may hold a half-made choice, like a half-typed address. Only sending refuses it.
  const d = await s.post('/envelopes', { subject: 'Half made', documents: [{ id: 'd', file_id: file.id }], recipients: [ann, { id: 'w', role: 'witness', name: 'Wes', email: 'wes@rules.example' }] });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  // A witness the signer names has no name or address of the sender's: sending one anyway is refused, never dropped.
  const both = await s.post('/envelopes', { subject: 'Both', documents: [{ id: 'd', file_id: file.id }], recipients: [ann, { id: 'w', role: 'witness', witness_for: 'a', named_by_signer: true, name: 'Wes', email: 'wes@rules.example' }] });
  assert.equal(both.status, 400);
  assert.match(both.data.error, /"named_by_signer": true and also has an email address\. Leave the name and the address out/);
  const word = await s.post('/envelopes', { subject: 'Word', documents: [{ id: 'd', file_id: file.id }], recipients: [ann, { id: 'w', role: 'witness', witness_for: 'a', named_by_signer: 'yes' }] });
  assert.equal(word.status, 400);
  assert.match(word.data.error, /"named_by_signer" of recipient 2 is "yes", and it has to be true or false/);
  // Taking the role away takes the tie with it.
  const tied = await s.post('/envelopes', { subject: 'Tied', documents: [{ id: 'd', file_id: file.id }], recipients: [ann, { id: 'w', role: 'witness', witness_for: 'a', named_by_signer: true }] });
  const wid = tied.data.envelope.recipients.find((r: any) => r.role === 'witness').id;
  assert.equal(row(wid).name, 'Witness for Ann Rules', 'an unnamed witness is called after the signer wherever a name is shown');
  const untied = await s.put(`/envelopes/${tied.data.envelope.id}`, { recipients: [ann, { id: wid, role: 'viewer', name: 'Wes', email: 'wes@rules.example' }] });
  assert.equal(untied.status, 200, JSON.stringify(untied.data));
  assert.equal(row(wid).witness_for, null);
  assert.equal(row(wid).named_by_signer, 0);
});

test('the witness block: their name and address print only once they have witnessed, and the signed PDF carries all of it', async () => {
  const s = await person('Paula Pages', 'paula@deed.example');
  const e = await deed(s);
  const { ann, wit, ben } = ids(e);
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  // Ann sees nothing of the witness's on her page: their name is not wording of the sender's (printedWords).
  const annTok = tokenFor(e.id, row(ann).email);
  const b = browser();
  await b.post(`/sign/${annTok}/consent`);
  const page = (await b.get(`/sign/${annTok}`)).data;
  assert.ok(!page.others.some((f: any) => f.value === 'Will Witness'), 'the witness name is not shown before they witnessed');
  assert.equal(page.recipient.witness.name, 'Will Witness', 'but Ann is told who her witness is');
  assert.equal(page.recipient.witness.state, 'waiting');
  assert.equal((await finish(annTok, b)).status, 200);
  const wtok = tokenFor(e.id, row(wit).email);
  const wb = browser();
  const first = (await wb.get(`/sign/${wtok}`)).data;
  assert.equal(first.recipient.role, 'witness');
  assert.ok(first.fields.length === 5, 'the witness fills in their own block');
  await wb.post(`/sign/${wtok}/witness-statement`, { statement: first.recipient.witness_of.statement });
  assert.equal((await finish(wtok, wb, Object.fromEntries(first.fields.filter((f: any) => f.type === 'text').map((f: any) => [f.id, f.label === 'Witness address' ? '1 Mill Lane, Leeds' : 'Carpenter'])))).status, 200);
  assert.equal((await finish(tokenFor(e.id, row(ben).email))).status, 200);
  const pdf = (await s.get(`/envelopes/${e.id}/download`)).data;
  const words = await pdfText(pdf);
  for (const w of ['Will Witness', '1 Mill Lane, Leeds', 'Carpenter']) assert.ok(words.includes(w), `${w} is on the signed PDF`);
});

// ---- 2. The signer names the witness on their review screen ---------------------------------------------------

test('a witness left open is named by the signer before Finish, with the rules a witness has to meet, and asked after Finish', async () => {
  const s = await person('Nora Names', 'nora@deed.example');
  const e = await deed(s, { named_by_signer: true, name: '', email: '' });
  const { ann, wit, ben } = ids(e);
  assert.equal(row(wit).name, 'Witness for Ann Signer');
  assert.equal(row(wit).email, '');
  const sent = await s.post(`/envelopes/${e.id}/send`);
  assert.equal(sent.status, 200, 'an open witness needs no address to send');
  const tok = tokenFor(e.id, row(ann).email);
  const b = browser();
  await b.post(`/sign/${tok}/consent`);
  const v = (await b.get(`/sign/${tok}`)).data;
  assert.deepEqual({ state: v.recipient.witness.state, may: v.recipient.witness.may_name, name: v.recipient.witness.name }, { state: 'open', may: true, name: null });
  const values = Object.fromEntries(v.fields.map((f: any) => [f.id, '1']));
  const early = await b.post(`/sign/${tok}/complete`, { values, signature_png: PNG, version: v.version });
  assert.equal(early.status, 400);
  assert.equal(early.data.code, 'witness_needed');
  assert.match(early.data.error, /Name your witness before you finish/);
  assert.equal(row(ann).status, 'viewed', 'nothing was signed');

  // Herself, a party to the document, a half-typed address: refused in words, nothing changed.
  const refusals: [any, RegExp][] = [
    [{ name: 'Ann Signer', email: row(ann).email }, /That is your own name/],
    [{ name: 'Ben Second', email: row(ben).email }, /Ben Second is on this document as a person who signs it, so they are a party to it/],
    [{ name: 'Walt', email: 'walt@' }, /Type the full name and the email address of your witness/],
    [{ name: 'W', email: 'w@deed.example' }, /Type the full name/],
  ];
  for (const [body, said] of refusals) {
    const r = await b.post(`/sign/${tok}/witness`, body);
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, said);
  }
  assert.equal(row(wit).email, '');

  const named = await b.post(`/sign/${tok}/witness`, { name: 'Wendy Witness', email: 'wendy@deed.example' });
  assert.equal(named.status, 200, JSON.stringify(named.data));
  assert.deepEqual({ name: named.data.witness.name, state: named.data.witness.state }, { name: 'Wendy Witness', state: 'waiting' });
  assert.equal(mailTo('wendy@deed.example').length, 0, 'nobody is emailed before Ann has signed');
  // She can still change it until she has signed. The person she named first is never emailed.
  const again = await b.post(`/sign/${tok}/witness`, { name: 'Walt Witness', email: 'walt@deed.example' });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(row(wit).witness_names, 2);
  assert.ok(row(wit).signer_named_at);
  assert.ok(auditOf(e.id).some((a: any) => a.action === 'Witness named' && /named Walt Witness <walt@deed\.example> as the witness for their signature, in place of Wendy Witness <wendy@deed\.example>/.test(a.detail)));
  // Naming is a change to the envelope: an editor opened before it cannot undo it.
  const stale = await s.put(`/envelopes/${e.id}`, { edit_version: e.edit_version, subject: 'Deed of gift' });
  assert.equal(stale.status, 409);

  const v2 = (await b.get(`/sign/${tok}`)).data;
  assert.equal((await b.post(`/sign/${tok}/complete`, { values, signature_png: PNG, version: v2.version })).status, 200);
  assert.equal(mailTo('wendy@deed.example').length, 0);
  const asked = mailTo('walt@deed.example').pop();
  assert.match(text(asked.html), /Ann Signer has signed "Deed of gift" and named you as their witness/);
  const late = await b.post(`/sign/${tok}/witness`, { name: 'Wanda', email: 'wanda@deed.example' });
  assert.equal(late.status, 409, 'once the witness is asked, only the sender can change them');
  assert.match(late.data.error, /has already been asked to witness your signature/);
});

test('naming a witness is an email in the sender\'s name: a witness the sender chose stays, a pause stops it, and the count is capped', async () => {
  const s = await person('Cora Cap', 'cora@deed.example');
  const fixed = await deed(s);
  assert.equal((await s.post(`/envelopes/${fixed.id}/send`)).status, 200);
  const ft = tokenFor(fixed.id, row(ids(fixed).ann).email);
  const no = await browser().post(`/sign/${ft}/witness`, { name: 'Someone Else', email: 'else@deed.example' });
  assert.equal(no.status, 409);
  assert.match(no.data.error, /Cora Cap chose your witness: Will Witness\. To have someone else, ask Cora Cap \(cora@deed\.example\)/);

  const e = await deed(s, { named_by_signer: true, name: '', email: '' });
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = tokenFor(e.id, row(ids(e).ann).email);
  const account = (await s.get('/me')).data.account.id;
  db.run('UPDATE accounts SET suspended_at=?, suspended_reason=? WHERE id=?', new Date().toISOString(), 'under review', account);
  const paused = await browser().post(`/sign/${tok}/witness`, { name: 'Pat Paused', email: 'pat@deed.example' });
  assert.equal(paused.status, 403);
  assert.match(paused.data.error, /We cannot email a witness for this document right now\. Reply to the email you got and ask Cora Cap to add your witness/);
  assert.doesNotMatch(paused.data.error, /paused|review/, 'the signer is not told the sender\'s business');
  db.run('UPDATE accounts SET suspended_at=NULL, suspended_reason=NULL WHERE id=?', account);
  const { WITNESS_NAMES_MAX } = await import('../src/lib/witness.ts');
  for (let i = 0; i < WITNESS_NAMES_MAX; i++) assert.equal((await browser().post(`/sign/${tok}/witness`, { name: `Person Number ${i}`, email: `p${i}@cap.example` })).status, 200);
  const capped = await browser().post(`/sign/${tok}/witness`, { name: 'One Too Many', email: 'many@cap.example' });
  assert.equal(capped.status, 429);
  assert.match(capped.data.error, /as many times as it can be done here\. Ask Cora Cap/);
  assert.equal(db.get("SELECT COUNT(*) n FROM reached WHERE account_id=? AND email LIKE '%@cap.example'", account).n, WITNESS_NAMES_MAX, 'each one counts as a person newly emailed');
});

// ---- 3. The witness's first screen: their own statement, or "I was not there" ----------------------------------

test('the witness ticks their own statement before they can sign, and cannot decline or pass it on', async () => {
  const s = await person('Tess Tick', 'tess@deed.example');
  const e = await deed(s);
  const { ann, wit } = ids(e);
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const early = (await browser().get(`/sign/${tokenFor(e.id, row(wit).email)}`)).data;
  assert.equal(early.recipient.status, 'pending');
  assert.equal(early.recipient.witness_of.statement, null, 'nothing to confirm before Ann has signed');
  assert.equal((await finish(tokenFor(e.id, row(ann).email))).status, 200);
  const wtok = tokenFor(e.id, row(wit).email);
  const b = browser();
  const first = (await b.get(`/sign/${wtok}`)).data;
  const date = (await import('../src/lib/dates.ts')).formatDate(row(ann).completed_at, null, null);
  assert.equal(first.recipient.witness_of.statement, `I was physically present and saw Ann Signer sign this document on ${date}.`);
  assert.equal(first.recipient.witness_of.said, false);
  await b.post(`/sign/${wtok}/consent`);
  const v = (await b.get(`/sign/${wtok}`)).data;
  const values = Object.fromEntries(v.fields.map((f: any) => [f.id, f.type === 'text' ? 'x' : '1']));
  const before = await b.post(`/sign/${wtok}/complete`, { values, signature_png: PNG, version: v.version });
  assert.equal(before.status, 400);
  assert.equal(before.data.code, 'statement_needed');
  const declined = await b.post(`/sign/${wtok}/decline`, { reason: 'no' });
  assert.equal(declined.status, 400);
  assert.match(declined.data.error, /A witness cannot decline the document for the people who sign it\. If you did not see Ann Signer sign, choose "I was not there"/);
  const passed = await b.post(`/sign/${wtok}/reassign`, { name: 'Other', email: 'other@deed.example' });
  assert.equal(passed.status, 400);
  assert.match(passed.data.error, /A witness cannot pass this on to someone else/);
  const wrong = await b.post(`/sign/${wtok}/witness-statement`, { statement: 'I was there, more or less.' });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.data.code, 'changed');
  const said = await b.post(`/sign/${wtok}/witness-statement`, { statement: first.recipient.witness_of.statement });
  assert.equal(said.status, 200);
  assert.ok(auditOf(e.id).some((a: any) => a.action === 'Witness statement' && a.detail.includes(`ticked this statement as their own: "${first.recipient.witness_of.statement}" Sign&Grow records the statement and cannot check it.`)));
  assert.equal((await b.post(`/sign/${wtok}/complete`, { values, signature_png: PNG, version: v.version })).status, 200);
  assert.equal(auditOf(e.id).find((a: any) => a.action === 'Witnessed')?.detail, 'Will Witness <' + row(wit).email + '>');
});

test('"I was not there" signs nothing, tells the signer and the sender, and the signer names the person who was', async () => {
  const s = await person('Abe Absent', 'abe@deed.example');
  const e = await deed(s);
  const { ann, wit } = ids(e);
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await finish(tokenFor(e.id, row(ann).email))).status, 200);
  const wtok = tokenFor(e.id, row(wit).email);
  const away = await browser().post(`/sign/${wtok}/not-present`, { note: 'I was in Paris that day.' });
  assert.equal(away.status, 200, JSON.stringify(away.data));
  assert.equal(row(wit).status, 'pending');
  assert.ok(row(wit).witness_absent_at);
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'sent', 'the document stays unwitnessed and open');
  assert.equal((await browser().post(`/sign/${wtok}/not-present`, {})).status, 409);
  const toAnn = mailTo(row(ann).email).pop();
  assert.equal(toAnn.subject, 'Your witness was not there: Deed of gift');
  assert.match(text(toAnn.html), /Will Witness said that they were not physically with you when you signed "Deed of gift", so they did not sign as your witness\. Your own signature is kept/);
  assert.match(text(toAnn.html), /If nobody else saw you sign, ask Abe Absent what to do: a witness has to see the signature being made/);
  assert.match(text(toAnn.html), /They wrote: "I was in Paris that day\."/);
  const toSender = mailTo('abe@deed.example').pop();
  assert.equal(toSender.subject, 'Witness was not there: Deed of gift');
  assert.match(text(toSender.html), /cannot be completed until a witness has signed/);
  assert.match(text(toSender.html), /If nobody else saw Ann Signer sign, a new witness cannot truthfully say they did/);
  assert.ok(auditOf(e.id).some((a: any) => a.action === 'Witness was not there' && /said they were not physically present when Ann Signer signed/.test(a.detail)));
  // The witness's page now says what they did. Ann's page lets her name the person who was there.
  const theirs = (await browser().get(`/sign/${wtok}`)).data.recipient.witness_of;
  assert.ok(theirs.absent_at);
  const tok = tokenFor(e.id, row(ann).email);
  const hers = (await browser().get(`/sign/${tok}`)).data.recipient.witness;
  assert.deepEqual({ state: hers.state, may: hers.may_name, absent: hers.absent_name }, { state: 'absent', may: true, absent: 'Will Witness' });
  const named = await browser().post(`/sign/${tok}/witness`, { name: 'Cara Present', email: 'cara@deed.example' });
  assert.equal(named.status, 200, JSON.stringify(named.data));
  assert.equal(named.data.witness.state, 'asked', 'asked at once, because Ann has signed');
  assert.equal(mailTo('cara@deed.example').length, 1);
  assert.equal((await browser().get(`/sign/${wtok}`)).status, 410, 'the old witness link stops working');
  assert.ok(mailTo('abe@deed.example').some((m: any) => m.subject === 'New witness named: Deed of gift'));
  assert.equal((await witness(tokenFor(e.id, 'cara@deed.example'))).status, 200);
  assert.equal(row(wit).status, 'completed');
});

// ---- 5. The certificate, the audit trail, and what a challenge would look at -----------------------------------

const withUa = (c: Client, ua: string) => {
  const call = c.call.bind(c);
  c.call = (m: string, u: string, b?: any, h: Record<string, string> = {}) => call(m, u, b, { 'user-agent': ua, ...h });
  return c;
};

test('the certificate lists the witness under the signer, with the statement as ticked, its time and the usual details', async () => {
  const s = await person('Cleo Cert', 'cleo@deed.example');
  const e = await deed(s);
  const { ann, wit, ben } = ids(e);
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await finish(tokenFor(e.id, row(ann).email))).status, 200);
  assert.equal((await witness(tokenFor(e.id, row(wit).email))).status, 200);
  assert.equal((await finish(tokenFor(e.id, row(ben).email))).status, 200);
  const words = (await pdfText((await s.get(`/envelopes/${e.id}/download`)).data)).replace(/\s+/g, ' ');
  const at = (w: string) => words.indexOf(w);
  assert.ok(at('Ann Signer <') >= 0 && at('Will Witness <') > at('Ann Signer <') && at('Ben Second <') > at('Will Witness <'), 'Ann, then her witness, then Ben');
  assert.match(words, /Witnessed by Will Witness, listed next/);
  assert.match(words, /Witness for Ann Signer/);
  assert.ok(words.includes(`"${row(wit).witness_statement}"`), 'the statement exactly as ticked');
  assert.match(words, /Statement ticked \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
  assert.match(words, /Sign&Grow recorded what the witness stated\. It cannot check that they were physically present\./);
  assert.match(words, /Role Witness/);
  assert.match(words, /Status Witnessed/);
  assert.doesNotMatch(words, /Marked /, 'nothing to mark here');
  const trail = auditOf(e.id).map((a: any) => a.action);
  assert.ok(trail.indexOf('Witness statement') < trail.indexOf('Witnessed') && trail.indexOf('Witnessed') < trail.indexOf('Envelope completed'));
});

test('a witness at the signer\'s address, in the signer\'s browser, or from the signer\'s internet address and browser is allowed, marked, and the sender is told', async () => {
  const s = await person('Mark Marks', 'mark@deed.example');
  // The same address: a household sharing one inbox.
  const file = await upload(s, 1);
  const shared = await s.post('/envelopes', { subject: 'Shared inbox', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'a', role: 'signer', name: 'Amy Home', email: 'home@deed.example' }, { id: 'w', role: 'witness', witness_for: 'a', name: 'Hal Home', email: 'home@deed.example' }],
    fields: [{ document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, ...block('w')] });
  assert.equal(shared.status, 200, JSON.stringify(shared.data));
  const se = shared.data.envelope;
  const [amy, hal] = [se.recipients.find((r: any) => r.role === 'signer').id, se.recipients.find((r: any) => r.role === 'witness').id];
  assert.equal((await finish(row(amy).token, browser())).status, 200);
  assert.equal((await witness(row(hal).token, browser())).status, 200);
  assert.equal(row(hal).witness_marks, 'address');
  assert.ok(mailTo('mark@deed.example').some((m: any) => m.subject === 'Check the witness: Shared inbox' && /Hal Home signed as the witness of Amy Home with the same email address as the signer\. That is allowed, and the certificate of completion marks it/.test(text(m.html))));
  assert.match((await pdfText((await s.get(`/envelopes/${se.id}/download`)).data)).replace(/\s+/g, ' '), /Marked same email address as the signer\. Allowed, and marked because a challenge would look at it\./);

  // The same browser: the signer's device, handed to the witness.
  const one = await deed(s);
  const o = ids(one);
  assert.equal((await s.post(`/envelopes/${one.id}/send`)).status, 200);
  const device = browser();
  assert.equal((await finish(tokenFor(one.id, row(o.ann).email), device)).status, 200);
  assert.ok(device.cookies.ts_dev, 'a signer with a witness is given the browser cookie');
  assert.equal((await witness(tokenFor(one.id, row(o.wit).email), device)).status, 200);
  assert.equal(row(o.wit).witness_marks, 'device');
  assert.ok(auditOf(one.id).some((a: any) => a.action === 'Witness marked' && /with the same device as the signer/.test(a.detail)));

  // Another browser, from the same internet address with the same browser: said as exactly that.
  const two = await deed(s);
  const t = ids(two);
  assert.equal((await s.post(`/envelopes/${two.id}/send`)).status, 200);
  const where = ip();
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1';
  assert.equal((await finish(tokenFor(two.id, row(t.ann).email), withUa(Object.assign(new Client(), { ip: where }), ua))).status, 200);
  assert.equal((await witness(tokenFor(two.id, row(t.wit).email), withUa(Object.assign(new Client(), { ip: where }), ua))).status, 200);
  assert.equal(row(t.wit).witness_marks, 'network');
  assert.ok(mailTo('mark@deed.example').some((m: any) => /the same internet address and the same kind of browser, which can also be two devices in one place/.test(text(m.html))));

  // Somebody else on another device is not marked, and nobody who signs without a witness is given the cookie.
  const plain = browser();
  const solo = await s.post('/envelopes', { subject: 'No witness', send: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'a', role: 'signer', name: 'Solo Signer', email: 'solo@deed.example' }], fields: [{ document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }] });
  assert.equal((await finish(tokenFor(solo.data.envelope.id, 'solo@deed.example'), plain)).status, 200);
  assert.equal(plain.cookies.ts_dev, undefined);
});

// ---- 6. Everything else, for the new role ---------------------------------------------------------------------

test('reminders, the not-opened alert, find my documents and the completed copy all know the witness', async () => {
  const s = await person('Rhea Remind', 'rhea@deed.example');
  const e = await deed(s);
  const { ann, wit, ben } = ids(e);
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const willEmail = row(wit).email;
  // Before Ann has signed, nobody reminds the witness of something they cannot do yet.
  assert.equal((await s.post(`/envelopes/${e.id}/remind`, { recipient_id: wit })).data.reminded, 0);
  assert.equal(mailTo(willEmail).length, 0);
  assert.equal((await finish(tokenFor(e.id, row(ann).email))).status, 200);
  const r = await s.post(`/envelopes/${e.id}/remind`, { recipient_id: wit });
  assert.equal(r.data.reminded, 1, JSON.stringify(r.data));
  const reminder = mailTo(willEmail).pop();
  assert.equal(reminder.subject, 'Reminder: Deed of gift');
  assert.match(text(reminder.html), /asked you to witness the signature of Ann Signer/);
  // Unopened for two days: the sender is told, like for anyone.
  db.run('UPDATE recipients SET sent_at=? WHERE id=?', new Date(Date.now() - 3 * 864e5).toISOString(), wit);
  await env.cronTick();
  assert.ok(mailTo('rhea@deed.example').some((m: any) => m.subject === 'Not opened yet: Deed of gift' && /Will Witness/.test(text(m.html))));
  // "Find my documents" sends the witness their link, and says what it is.
  await env.emailMyLinks(willEmail);
  assert.match(text(mailTo(willEmail).pop().html), /waiting for you/);
  assert.equal((await witness(tokenFor(e.id, willEmail))).status, 200);
  await env.emailMyLinks(willEmail);
  assert.match(text(mailTo(willEmail).pop().html), /you witnessed it, others have not finished yet/);
  assert.equal((await finish(tokenFor(e.id, row(ben).email))).status, 200);
  assert.ok(mailTo(willEmail).some((m: any) => m.subject === 'Completed: Deed of gift'), 'the witness gets the completed copy like everyone');
});

test('the signer declining closes it for everyone and the witness is never asked; a witness the signer named goes when the signer passes it on', async () => {
  const s = await person('Dina Decline', 'dina@deed.example');
  const e = await deed(s);
  const { ann, wit } = ids(e);
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = tokenFor(e.id, row(ann).email);
  const b = browser();
  await b.get(`/sign/${tok}`);
  assert.equal((await b.post(`/sign/${tok}/decline`, { reason: 'Wrong deed' })).status, 200);
  assert.equal(mailTo(row(wit).email).length, 0, 'a witness who was never asked hears nothing');

  const p = await deed(s, { named_by_signer: true, name: '', email: '' });
  const pi = ids(p);
  assert.equal((await s.post(`/envelopes/${p.id}/send`)).status, 200);
  const ptok = tokenFor(p.id, row(pi.ann).email);
  const pb = browser();
  await pb.get(`/sign/${ptok}`);
  assert.equal((await pb.post(`/sign/${ptok}/witness`, { name: 'Nell Named', email: 'nell@deed.example' })).status, 200);
  assert.equal((await pb.post(`/sign/${ptok}/reassign`, { name: 'Pat Proxy', email: 'pat.proxy@deed.example', reason: 'Pat signs for the firm' })).status, 200);
  assert.equal(row(pi.wit).email, '', 'the witness Ann named was hers, like her answers');
  assert.equal(row(pi.wit).name, 'Witness for Pat Proxy');
  assert.ok(auditOf(p.id).some((a: any) => a.action === 'Witness cleared' && /Nell Named/.test(a.detail)));
  const pat = (await browser().get(`/sign/${tokenFor(p.id, 'pat.proxy@deed.example')}`)).data.recipient.witness;
  assert.equal(pat.state, 'open', 'Pat names their own witness');
  // A witness the sender chose stays with the place.
  const f = await deed(s);
  const fi = ids(f);
  assert.equal((await s.post(`/envelopes/${f.id}/send`)).status, 200);
  const ftok = tokenFor(f.id, row(fi.ann).email);
  await browser().get(`/sign/${ftok}`);
  assert.equal((await browser().post(`/sign/${ftok}/reassign`, { name: 'Pip Proxy', email: 'pip.proxy@deed.example' })).status, 200);
  assert.equal(row(fi.wit).name, 'Will Witness');
});

test('corrections: changing the witness is not a change to what the signer signed, adding one after she signed is', async () => {
  const s = await person('Cory Correct', 'cory@deed.example');
  const e = await deed(s);
  const { ann, wit } = ids(e);
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await finish(tokenFor(e.id, row(ann).email))).status, 200);
  // After "not there", the sender puts the right person in the witness's place with Correct: asked at once.
  assert.equal((await browser().post(`/sign/${tokenFor(e.id, row(wit).email)}/not-present`, {})).status, 200);
  const fixed = await s.post(`/envelopes/${e.id}/correct`, { recipient_id: wit, name: 'Vera Valid', email: 'vera@deed.example' });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
  assert.equal(row(wit).status, 'sent');
  assert.equal(row(wit).witness_absent_at, null);
  assert.equal(mailTo('vera@deed.example').length, 1);
  // Through the editor too, with no "resign": Ann does not have to sign again for another witness.
  const now = (await s.get(`/envelopes/${e.id}`)).data.envelope;
  const body = (over: (r: any) => any) => ({ edit_version: now.edit_version, recipients: now.recipients.map((r: any) => over({ ...r })), fields: now.fields, documents: now.documents });
  const swap = await s.put(`/envelopes/${e.id}`, body((r: any) => (r.id === wit ? { ...r, name: 'Otto Other', email: 'otto@deed.example' } : r)));
  assert.equal(swap.status, 200, JSON.stringify(swap.data));
  assert.equal(row(ann).status, 'completed', 'Ann signed and stays signed');
  assert.equal(mailTo('otto@deed.example').length, 1, 'the new witness is asked at once');

  // A witness added after Ann signed is new wording on her pages: she is asked first whether she should sign again.
  const late = await deed(s, {}, { recipients: [{ id: 'ann', role: 'signer', name: 'Ann Signer', email: `ann.late${n}@deed.example` }], fields: [{ document_id: 'd', recipient_id: 'ann', type: 'signature', page: 0, x: 0.1, y: 0.4, w: 0.25, h: 0.06 }] });
  assert.equal((await s.post(`/envelopes/${late.id}/send`)).status, 200);
  const la = late.recipients[0].id;
  const lb = browser();
  await lb.post(`/sign/${row(la).token}/consent`);
  const lv = (await lb.get(`/sign/${row(la).token}`)).data;
  assert.equal((await lb.post(`/sign/${row(la).token}/complete`, { values: Object.fromEntries(lv.fields.map((f: any) => [f.id, '1'])), signature_png: PNG, version: lv.version })).status, 200);
  // Ann was alone on it, so it completed. Another one, with Ben still to sign, takes the witness later.
  const two = await deed(s, {}, { recipients: [{ id: 'ann', role: 'signer', name: 'Ann Signer', email: `ann.two${n}@deed.example`, routing_order: 1 }, { id: 'ben', role: 'signer', name: 'Ben Second', email: `ben.two${n}@deed.example`, routing_order: 2 }], fields: [{ document_id: 'd', recipient_id: 'ann', type: 'signature', page: 0, x: 0.1, y: 0.4, w: 0.25, h: 0.06 }, { document_id: 'd', recipient_id: 'ben', type: 'signature', page: 0, x: 0.55, y: 0.4, w: 0.25, h: 0.06 }] });
  assert.equal((await s.post(`/envelopes/${two.id}/send`)).status, 200);
  const ta = two.recipients.find((r: any) => r.name === 'Ann Signer').id;
  assert.equal((await finish(row(ta).token)).status, 200);
  const cur = (await s.get(`/envelopes/${two.id}`)).data.envelope;
  const added = { edit_version: cur.edit_version, documents: cur.documents, recipients: [...cur.recipients, { id: 'w2', role: 'witness', witness_for: ta, name: 'Late Witness', email: 'late@deed.example' }], fields: [...cur.fields, ...block('w2', cur.documents[0].id)] };
  const asked = await s.put(`/envelopes/${two.id}`, added);
  assert.equal(asked.status, 409, JSON.stringify(asked.data));
  assert.equal(asked.data.code, 'sign_again');
  const yes = await s.put(`/envelopes/${two.id}`, { ...added, resign: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  const w2 = witnessRow(two.id);
  assert.equal(w2.status, 'pending', 'the witness waits for the signature they have to see');
  assert.equal(row(ta).status, 'pending');
  assert.equal(mailTo('late@deed.example').length, 0);
});

test('a signer asked to sign again takes the witness back with her: their earlier statement no longer stands', async () => {
  const s = await person('Agnes Again', 'agnes@deed.example');
  const e = await deed(s);
  const { ann, wit } = ids(e);
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await finish(tokenFor(e.id, row(ann).email))).status, 200);
  const wtok = tokenFor(e.id, row(wit).email);
  const wb = browser();
  const first = (await wb.get(`/sign/${wtok}`)).data;
  assert.equal((await wb.post(`/sign/${wtok}/witness-statement`, { statement: first.recipient.witness_of.statement })).status, 200);
  // The sender changes the wording before the witness signs, and Ann is asked to sign again.
  const cur = (await s.get(`/envelopes/${e.id}`)).data.envelope;
  const changed = await s.put(`/envelopes/${e.id}`, { edit_version: cur.edit_version, resign: true, documents: cur.documents, recipients: cur.recipients, fields: [...cur.fields, { document_id: cur.documents[0].id, type: 'note', value: 'Clause 4 removed', page: 0, x: 0.6, y: 0.9, w: 0.3, h: 0.03 }] });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(row(ann).status, 'pending');
  assert.equal(row(wit).status, 'pending', 'the witness gives the turn back until Ann has signed again');
  assert.equal((await finish(tokenFor(e.id, row(ann).email))).status, 200);
  assert.equal(row(wit).status, 'sent');
  const again = (await wb.get(`/sign/${wtok}`)).data.recipient.witness_of;
  assert.equal(again.said, false, 'the statement was about a signature that no longer counts');
  assert.equal((await witness(wtok, wb)).status, 200);
});

test('templates, bulk sends and public forms: the witness stays tied to the same role, and a witness the signer names is no column to fill', async () => {
  const s = await person('Tara Template', 'tara@deed.example');
  const file = await upload(s, 1);
  const tpl = await s.post('/envelopes', { kind: 'template', subject: 'Witnessed deed', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'g', role: 'signer', role_name: 'Giver' }, { id: 'w', role: 'witness', role_name: 'Witness', witness_for: 'g', named_by_signer: true }],
    fields: [{ document_id: 'd', recipient_id: 'g', type: 'signature', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, ...block('w')] });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  const t = tpl.data.envelope;
  const used = await s.post('/envelopes', { template_id: t.id, recipients: { Giver: { name: 'Gail Giver', email: 'gail@deed.example' } }, send: true });
  assert.equal(used.status, 200, JSON.stringify(used.data));
  const ue = used.data.envelope;
  const [g, w] = [ue.recipients.find((r: any) => r.role === 'signer'), ue.recipients.find((r: any) => r.role === 'witness')];
  assert.equal(row(w.id).witness_for, g.id, 'tied to the copy of the role, not to the template');
  assert.equal(row(w.id).named_by_signer, 1);
  assert.equal(row(w.id).name, 'Witness for Gail Giver');
  // A bulk row fills in the giver only.
  const bulk = await s.post('/bulk', { template_id: t.id, rows: [{ Giver: { name: 'Bo Bulk', email: 'bo@deed.example' } }, { Giver: { name: 'Cy Bulk', email: 'cy@deed.example' } }] });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  for (const x of bulk.data.results) {
    const wr = witnessRow(x.envelope_id);
    assert.equal(wr.witness_for, db.get("SELECT id FROM recipients WHERE envelope_id=? AND role='signer'", x.envelope_id).id);
    assert.equal(wr.email, '');
  }
  // A witness the sender names each time is a column like any open role.
  const tpl2 = await s.post('/envelopes', { kind: 'template', subject: 'Named witness', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'g', role: 'signer', role_name: 'Giver' }, { id: 'w', role: 'witness', role_name: 'Witness', witness_for: 'g' }],
    fields: [{ document_id: 'd', recipient_id: 'g', type: 'signature', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, ...block('w')] });
  const missing = await s.post('/bulk', { template_id: tpl2.data.envelope.id, rows: [{ Giver: { name: 'Di', email: 'di@deed.example' } }] });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /Row 1: "Witness" needs a name and a valid email/);
  // A public form on the first template has one open role, the giver, whose visitor names their own witness.
  const form = await s.post('/powerforms', { template_id: t.id, name: 'Gift deed' });
  assert.equal(form.status, 200, JSON.stringify(form.data));
});

test('the API describes the role, its two settings and the three routes, and the developers page and the help page say it', async () => {
  const { openapi } = await import('../src/server/openapi.ts');
  const doc: any = openapi();
  const rcp = doc.components.schemas.Recipient.properties;
  assert.ok(rcp.role.enum.includes('witness'));
  for (const k of ['witness_for', 'named_by_signer', 'witness_statement', 'witness_said_at', 'witness_absent_at', 'witness_marks']) assert.ok(rcp[k], `${k} is described`);
  assert.match(rcp.witness_for.description, /never uses a signature/);
  for (const p of ['/sign/{token}/witness', '/sign/{token}/witness-statement', '/sign/{token}/not-present']) assert.ok(doc.paths[p]?.post, `${p} is described`);
  const { listRoutes } = await import('../src/server/router.ts');
  for (const p of ['/sign/:token/witness', '/sign/:token/witness-statement', '/sign/:token/not-present']) assert.ok(listRoutes().some((r) => r.method === 'POST' && r.path === p));
});
