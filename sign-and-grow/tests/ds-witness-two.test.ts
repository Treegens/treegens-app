// Up to two witnesses for one person who signs (src/lib/witness.ts WITNESSES_MAX): named by the sender or by the
// signer, both asked at once straight after the signer, each with their own statement or "I was not there", each set
// aside with the signature they saw, never the same person twice, never charged, both on the certificate.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, upload, mailTo, tokenFor, PNG, type Server } from './helpers.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

let n = 0;
const ip = () => `10.${200 + Math.floor(++n / 250)}.${n % 250}.9`;
const person = (name: string, email: string) => signUp(name, email, ip());
const browser = () => Object.assign(new Client(), { ip: ip() });
const row = (id: string) => db.get('SELECT * FROM recipients WHERE id=?', id);
const auditOf = (id: string) => db.all('SELECT actor, action, detail FROM audit WHERE envelope_id=? ORDER BY seq', id);
const pdfText = async (bytes: Uint8Array) => (await import('../src/server/text.ts')).extractText(bytes);
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const block = (rid: string, y = 0.6) => [
  { document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y, w: 0.22, h: 0.05, label: 'Witness signature' },
  { document_id: 'd', recipient_id: rid, type: 'full_name', page: 0, x: 0.1, y: y + 0.06, w: 0.3, h: 0.024, label: 'Witness name' },
  { document_id: 'd', recipient_id: rid, type: 'text', page: 0, x: 0.1, y: y + 0.09, w: 0.4, h: 0.045, label: 'Witness address' },
  { document_id: 'd', recipient_id: rid, type: 'text', page: 0, x: 0.1, y: y + 0.145, w: 0.3, h: 0.024, label: 'Witness occupation' },
  { document_id: 'd', recipient_id: rid, type: 'date_signed', page: 0, x: 0.5, y, w: 0.16, h: 0.024, label: 'Date witnessed' },
];

// A deed: Ann signs with two witnesses, Ben signs after her. `w1`/`w2` override the witness rows.
async function deed(c: Client, w1: any = {}, w2: any = {}, send = false) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    subject: 'Two witness deed', ordered: true, send,
    documents: [{ id: 'd', file_id: file.id, name: 'Deed' }],
    recipients: [
      { id: 'ann', role: 'signer', name: 'Ann Signer', email: `ann.${n}@two.example`, routing_order: 1 },
      { id: 'w1', role: 'witness', witness_for: 'ann', name: 'Will First', email: `will.${n}@two.example`, ...w1 },
      { id: 'w2', role: 'witness', witness_for: 'ann', name: 'Wanda Second', email: `wanda.${n}@two.example`, ...w2 },
      { id: 'ben', role: 'signer', name: 'Ben Party', email: `ben.${n}@two.example`, routing_order: 2 },
    ],
    fields: [
      { document_id: 'd', recipient_id: 'ann', type: 'signature', page: 0, x: 0.1, y: 0.3, w: 0.25, h: 0.06 },
      ...block('w1', 0.45), ...block('w2', 0.7),
      { document_id: 'd', recipient_id: 'ben', type: 'signature', page: 0, x: 0.55, y: 0.3, w: 0.25, h: 0.06 },
    ],
  });
  return r;
}
const ids = (e: any) => {
  const ws = e.recipients.filter((r: any) => r.role === 'witness');
  return { ann: e.recipients.find((r: any) => r.name === 'Ann Signer').id, w1: ws[0].id, w2: ws[1].id, ben: e.recipients.find((r: any) => r.name === 'Ben Party').id };
};

async function finish(tok: string, b = browser()) {
  await b.post(`/sign/${tok}/consent`);
  const v = (await b.get(`/sign/${tok}`)).data;
  const all: Record<string, string> = {};
  for (const f of v.fields || []) all[f.id] = f.type === 'text' ? `${f.label || 'answer'} filled` : '1';
  return b.post(`/sign/${tok}/complete`, { values: all, signature_png: PNG, initials_png: PNG, version: v.version });
}
async function witness(tok: string, b = browser()) {
  const first = (await b.get(`/sign/${tok}`)).data;
  const said = await b.post(`/sign/${tok}/witness-statement`, { statement: first.recipient.witness_of.statement });
  assert.equal(said.status, 200, JSON.stringify(said.data));
  return finish(tok, b);
}

test('two witnesses named by the sender: both asked at once after the signer, nobody waits for them, never charged, both on the certificate', async () => {
  const s = await person('Sam Sender', 'sam@two.example');
  const account = (await s.get('/me')).data.account.id;
  process.env.STRIPE_SECRET_KEY = 'sk_test_witness_two';
  try {
    const made = await deed(s);
    assert.equal(made.status, 200, JSON.stringify(made.data));
    const e = made.data.envelope;
    const { ann, w1, w2, ben } = ids(e);
    assert.equal(row(w1).witness_for, ann);
    assert.equal(row(w2).witness_for, ann);
    assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
    const { reserved } = await import('../src/server/credits.ts');
    assert.equal(reserved(account), 2, 'two signers hold two signatures, the two witnesses none');
    assert.equal(row(w1).status, 'pending');
    assert.equal(row(w2).status, 'pending');

    // Ann sees both of her witnesses.
    const b = browser();
    await b.post(`/sign/${row(ann).token}/consent`);
    const page = (await b.get(`/sign/${row(ann).token}`)).data;
    assert.deepEqual(page.recipient.witnesses.map((w: any) => [w.name, w.state]), [['Will First', 'waiting'], ['Wanda Second', 'waiting']]);
    assert.equal((await finish(row(ann).token, b)).status, 200);
    assert.equal(row(w1).status, 'sent', 'asked straight after Ann');
    assert.equal(row(w2).status, 'sent', 'at the same time');
    assert.equal(row(ben).status, 'sent', 'Ben waits for neither');
    assert.equal(mailTo(row(w1).email).length, 1);
    assert.equal(mailTo(row(w2).email).length, 1);

    // Each makes their own statement: one statement does not count for the other.
    const b1 = browser();
    const f1 = (await b1.get(`/sign/${row(w1).token}`)).data;
    assert.equal((await b1.post(`/sign/${row(w1).token}/witness-statement`, { statement: f1.recipient.witness_of.statement })).status, 200);
    const early = await finish(row(w2).token);
    assert.equal(early.status, 400);
    assert.equal(early.data.code, 'statement_needed', 'the second witness has not ticked their own statement');
    assert.equal((await finish(row(w1).token, b1)).status, 200);
    assert.equal((await witness(row(w2).token)).status, 200);
    assert.equal((await finish(row(ben).token)).status, 200);
    assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'completed');
    assert.equal(db.get("SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature'", account).n, 2, 'two signers, two signatures, both witnesses free');

    const words = (await pdfText((await s.get(`/envelopes/${e.id}/download`)).data)).replace(/\s+/g, ' ');
    const at = (w: string) => words.indexOf(w);
    assert.ok(at('Ann Signer <') >= 0 && at('Will First <') > at('Ann Signer <') && at('Wanda Second <') > at('Will First <') && at('Ben Party <') > at('Wanda Second <'), 'Ann, her two witnesses, then Ben');
    assert.match(words, /Witnessed by Will First and Wanda Second, listed next/);
    assert.equal(words.match(/Witness for Ann Signer/g)?.length, 2, 'each witness is listed under Ann');
    assert.ok(words.includes(`"${row(w1).witness_statement}"`) && words.includes(`"${row(w2).witness_statement}"`), 'each statement as ticked');
    assert.equal(words.match(/GrowSigning recorded what the witness stated\. It cannot check that they were physically present\./g)?.length, 2);
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test('more than two is refused, and the same person cannot be both witnesses or a party', async () => {
  const s = await person('Rhea Rules', 'rhea@two.example');
  // A third witness.
  const file = await upload(s, 1);
  const three = await s.post('/envelopes', {
    subject: 'Three', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'a', role: 'signer', name: 'Ann Rules', email: 'ann@rules2.example' },
      { id: 'w1', role: 'witness', witness_for: 'a', name: 'Wes One', email: 'wes1@rules2.example' },
      { id: 'w2', role: 'witness', witness_for: 'a', name: 'Wes Two', email: 'wes2@rules2.example' },
      { id: 'w3', role: 'witness', witness_for: 'a', name: 'Wes Three', email: 'wes3@rules2.example' }],
    fields: [{ document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, ...block('w1', 0.2), ...block('w2', 0.4), ...block('w3', 0.6)],
  });
  assert.equal(three.status, 400);
  assert.match(three.data.error, /Ann Rules has 3 witnesses here\. A person who signs can have one or two witnesses on GrowSigning\. Remove one of them\./);

  const cases: [any, RegExp][] = [
    [{ email: 'will@same.example' }, /two witnesses with the same email address \(Will First\)/],
    [{ name: 'will first' }, /two witnesses with the same name \(Will First\)/],
    [{ name: 'W. First' }, /two witnesses who look like one person \(Will First and W\. First\)/],
    [{ name: 'Ben Party', email: `ben.${n}@two.example` }, /party to it/],
  ];
  for (const [w2, said] of cases) {
    const r = await deed(s, { email: 'will@same.example' }, w2, true);
    assert.equal(r.status, 400, `${said}: ${JSON.stringify(r.data)}`);
    assert.match(r.data.error, said);
  }
  // The rule the editor shows before Send is the same one.
  const { witnessProblem } = await import('../src/lib/witness.ts');
  const people = [{ id: 'a', role: 'signer', name: 'Ann', email: 'a@x.example' }, { id: 'w1', role: 'witness', witness_for: 'a', name: 'Wes', email: 'w@x.example' }, { id: 'w2', role: 'witness', witness_for: 'a', name: 'Xia', email: 'W@x.example ' }];
  const fields = [...block('w1'), ...block('w2')];
  assert.equal(witnessProblem(people[1], { recipients: people, fields }), null, 'said once, on the second');
  assert.match(String(witnessProblem(people[2], { recipients: people, fields })), /same email address/);
});

test('two witnesses named by the signer on the review screen: both before Finish, each in their own place, never the same person', async () => {
  const s = await person('Nell Names', 'nell@two.example');
  const made = await deed(s, { named_by_signer: true, name: '', email: '' }, { named_by_signer: true, name: '', email: '' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const e = made.data.envelope;
  const { ann, w1, w2 } = ids(e);
  assert.equal(row(w1).name, 'Witness for Ann Signer');
  assert.equal(row(w2).name, 'Witness for Ann Signer');
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = row(ann).token;
  const b = browser();
  await b.post(`/sign/${tok}/consent`);
  const v = (await b.get(`/sign/${tok}`)).data;
  assert.deepEqual(v.recipient.witnesses.map((w: any) => [w.state, w.may_name, w.name]), [['open', true, null], ['open', true, null]]);
  const values = Object.fromEntries(v.fields.map((f: any) => [f.id, '1']));
  const early = await b.post(`/sign/${tok}/complete`, { values, signature_png: PNG, version: v.version });
  assert.equal(early.status, 400);
  assert.equal(early.data.code, 'witness_needed');
  assert.match(early.data.error, /Name your two witnesses before you finish/);

  // Without witness_id, the first open place is filled.
  const one = await b.post(`/sign/${tok}/witness`, { name: 'Olga One', email: 'olga@two.example' });
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.equal(row(w1).name, 'Olga One');
  assert.equal(one.data.witnesses.length, 2);
  const half = (await b.get(`/sign/${tok}`)).data;
  const late = await b.post(`/sign/${tok}/complete`, { values, signature_png: PNG, version: half.version });
  assert.equal(late.status, 400);
  assert.match(late.data.error, /Name your other witness before you finish/);

  // Not the same person in the second place, under any spelling or at the same address; not a place of someone else's.
  const refusals: [any, RegExp, number][] = [
    [{ witness_id: w2, name: 'olga one', email: 'olga2@two.example' }, /Olga One is already your other witness\. Your two witnesses have to be two different people/, 400],
    [{ witness_id: w2, name: 'Otto Other', email: 'OLGA@two.example' }, /Olga One is already your other witness at that email address/, 400],
    [{ witness_id: 'nobody', name: 'Otto Other', email: 'otto@two.example' }, /not one of yours/, 404],
  ];
  for (const [body, said, code] of refusals) {
    const r = await b.post(`/sign/${tok}/witness`, body);
    assert.equal(r.status, code, JSON.stringify(r.data));
    assert.match(r.data.error, said);
  }
  const two = await b.post(`/sign/${tok}/witness`, { witness_id: w2, name: 'Pia Two', email: 'pia@two.example' });
  assert.equal(two.status, 200, JSON.stringify(two.data));
  assert.equal(row(w2).name, 'Pia Two');
  assert.equal(row(w1).name, 'Olga One', 'the first place is untouched');
  // Changing one of them by its id leaves the other alone.
  assert.equal((await b.post(`/sign/${tok}/witness`, { witness_id: w1, name: 'Olga Again', email: 'olga.again@two.example' })).status, 200);
  assert.equal(row(w2).email, 'pia@two.example');
  const ready = (await b.get(`/sign/${tok}`)).data;
  assert.equal((await b.post(`/sign/${tok}/complete`, { values, signature_png: PNG, version: ready.version })).status, 200);
  assert.equal(row(w1).status, 'sent');
  assert.equal(row(w2).status, 'sent');
  assert.equal(mailTo('olga@two.example').length, 0, 'the name she replaced is never emailed');
  assert.equal(mailTo('olga.again@two.example').length, 1);
  assert.equal(mailTo('pia@two.example').length, 1);
});

test('one of two says "I was not there": the other stays, the document waits, and the signer names someone in that place only', async () => {
  const s = await person('Abby Absent', 'abby@two.example');
  const e = (await deed(s)).data.envelope;
  const { ann, w1, w2, ben } = ids(e);
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await finish(row(ann).token)).status, 200);
  assert.equal((await witness(row(w1).token)).status, 200);
  const away = await browser().post(`/sign/${row(w2).token}/not-present`, { note: 'Abroad.' });
  assert.equal(away.status, 200, JSON.stringify(away.data));
  assert.equal(row(w1).status, 'completed', 'the witness who was there keeps their statement');
  assert.ok(row(w1).witness_statement);
  assert.ok(row(w2).witness_absent_at);
  assert.ok(auditOf(e.id).some((a: any) => a.action === 'Witness was not there' && /missing one of its two witnesses/.test(a.detail)));
  assert.match(mailTo(row(ann).email).pop().html, /still needs one more witness/);
  assert.equal((await finish(row(ben).token)).status, 200);
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'sent', 'it cannot complete on one witness of two');

  const tok = row(ann).token;
  const hers = (await browser().get(`/sign/${tok}`)).data.recipient;
  assert.equal(hers.witness.id, w2, 'the place that needs her comes first');
  assert.deepEqual(hers.witnesses.map((w: any) => w.state), ['done', 'absent']);
  // The first witness's place cannot be changed: they were asked and witnessed.
  const wrong = await browser().post(`/sign/${tok}/witness`, { witness_id: w1, name: 'Carl Swap', email: 'carl@two.example' });
  assert.equal(wrong.status, 409, JSON.stringify(wrong.data));
  assert.match(wrong.data.error, /chose your witness: Will First/);
  assert.equal(row(w1).name, 'Will First');
  // Without an id, the place of the one who was not there is the one named.
  const named = await browser().post(`/sign/${tok}/witness`, { name: 'Cara Present', email: 'cara@two.example' });
  assert.equal(named.status, 200, JSON.stringify(named.data));
  assert.equal(row(w2).email, 'cara@two.example');
  assert.equal(row(w2).status, 'sent', 'asked at once, because Ann has signed');
  assert.equal((await witness(row(w2).token)).status, 200);
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'completed');
});

test('a change that sets the signature aside sets both witnesses aside, each on the record, and both are asked again', async () => {
  const s = await person('Fay Fresh', 'fay@two.example');
  const e = (await deed(s)).data.envelope;
  const { ann, w1, w2 } = ids(e);
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await finish(row(ann).token)).status, 200);
  assert.equal((await witness(row(w1).token)).status, 200);
  assert.equal((await witness(row(w2).token)).status, 200);
  const cur = (await s.get(`/envelopes/${e.id}`)).data.envelope;
  const swap = cur.recipients.map((r: any) => (r.id === ann ? { ...r, name: 'Alice Other', email: `alice.${n}@two.example` } : r));
  const ask = await s.put(`/envelopes/${e.id}`, { edit_version: cur.edit_version, documents: cur.documents, fields: cur.fields, recipients: swap });
  assert.equal(ask.status, 409);
  assert.deepEqual(ask.data.sign_again, ['Ann Signer', 'Will First', 'Wanda Second']);
  assert.match(ask.data.error, /Will First and Wanda Second witnessed their signature and are asked to witness again too\./);
  assert.equal((await s.put(`/envelopes/${e.id}`, { edit_version: cur.edit_version, documents: cur.documents, fields: cur.fields, recipients: swap, resign: true })).status, 200);
  for (const w of [w1, w2]) {
    assert.equal(row(w).status, 'pending');
    assert.equal(row(w).witness_statement, null);
  }
  assert.equal(auditOf(e.id).filter((a: any) => a.action === 'Witness statement set aside').length, 2, 'each statement is set aside on the record');
  assert.equal((await finish(row(ann).token)).status, 200);
  assert.equal(row(w1).status, 'sent');
  assert.equal(row(w2).status, 'sent');
});

test('the same device is marked per witness, and the sender page and the screens offer and show the second witness', async () => {
  const s = await person('Dee Device', 'dee@two.example');
  const e = (await deed(s)).data.envelope;
  const { ann, w1, w2 } = ids(e);
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const shared = browser();
  assert.equal((await finish(row(ann).token, shared)).status, 200);
  // Will finishes in Ann's own browser, Wanda in her own.
  assert.equal((await witness(row(w1).token, shared)).status, 200);
  assert.equal((await witness(row(w2).token)).status, 200);
  const { sameDevice } = await import('../src/lib/witness.ts');
  assert.equal(sameDevice(row(w1)), true);
  assert.equal(sameDevice(row(w2)), false);

  // Words on the screens: the editor offers a second block, the signing page names each place, nothing promises it holds.
  const choice = read('src/components/editor/WitnessChoice.tsx');
  assert.match(choice, /Add a second witness/);
  const sign = read('src/components/sign/Witness.tsx');
  assert.match(sign, /witness_id/);
  assert.match(sign, /Your second witness/);
  for (const f of ['src/components/editor/WitnessChoice.tsx', 'src/components/sign/Witness.tsx', 'src/lib/witness.ts', 'src/server/witness.ts']) {
    const t = read(f);
    assert.doesNotMatch(t, /—/, `${f} has no em dash`);
    assert.doesNotMatch(t, /meets the (law|legal)|legally valid|will hold up/i, `${f} promises nothing about the law`);
  }
});

// ---- Repairs after review (repair-ds-witness-two) -------------------------------------------------------------------

test('at a counter, the official may not be either of two witnesses, and the official screen lists both', async () => {
  const admin = await person('Ada Counter', 'ada@counter-two.example');
  assert.equal((await admin.post('/account/invites', { email: 'olu@counter-two.example', role: 'member' })).status, 200);
  const invite = db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL', 'olu@counter-two.example').token;
  const off = browser();
  assert.equal((await off.post('/auth/signup', { name: 'Olu Official', email: 'olu@counter-two.example', password: 'correct horse battery', invite })).status, 200);
  const offId = db.get('SELECT id FROM users WHERE email=?', 'olu@counter-two.example').id;
  const file = await upload(admin, 1);
  const tpl = await admin.post('/envelopes', {
    kind: 'template', subject: 'Two witness claim',
    documents: [{ id: 'd', file_id: file.id, name: 'Claim' }],
    recipients: [
      { id: 'p', role: 'inperson', role_name: 'Applicant', name: '', email: '' },
      { id: 'w1', role: 'witness', witness_for: 'p', name: 'Wanda Witness', email: 'wanda@counter-two.example' },
      { id: 'w2', role: 'witness', witness_for: 'p', name: 'Olu Official', email: 'olu@counter-two.example' },
    ],
    fields: [
      { document_id: 'd', recipient_id: 'p', type: 'signature', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.06 },
      { document_id: 'd', recipient_id: 'w1', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { document_id: 'd', recipient_id: 'w2', type: 'signature', page: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.06 },
    ],
  });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  const tid = tpl.data.envelope.id;
  assert.equal((await admin.put(`/counter/templates/${tid}`, { counter: true })).status, 200);
  assert.equal((await admin.put(`/counter/staff/${offId}`, { counter: true })).status, 200);
  const started = await off.post('/counter/start', { template_id: tid, name: 'Pat Citizen', email: 'pat@home-two.example' });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const vid = started.data.visit_id;
  assert.equal((await off.post(`/counter/visits/${vid}/identity`, { method: 'known', attest: true })).status, 200);
  const mark = await off.post(`/counter/visits/${vid}/helps`, { kind: 'mark', attest: true });
  assert.equal(mark.status, 409, 'the official is the second witness: refused, not only when first');
  assert.equal(mark.data.code, 'official_is_witness');
  assert.match(mark.data.error, /one of the witnesses on this document is you/);
  const view = (await off.get(`/counter/visits/${vid}`)).data;
  assert.deepEqual(view.witnesses.map((w: any) => w.name), ['Wanda Witness', 'Olu Official']);
  assert.equal(view.witness.name, 'Wanda Witness and Olu Official');
  // Allowed by the account's rules: the mark is recorded.
  assert.equal((await admin.put('/counter/settings', { official_may_witness: true })).status, 200);
  assert.equal((await off.post(`/counter/visits/${vid}/helps`, { kind: 'mark', attest: true })).status, 200);
});

test('a witness who said "not there" is not called "your other witness", and the refusal says which place to use', async () => {
  const s = await person('Tia Twice', 'tia@two.example');
  const e = (await deed(s)).data.envelope;
  const { ann, w1, w2 } = ids(e);
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await finish(row(ann).token)).status, 200);
  const wandaEmail = row(w2).email;
  assert.equal((await browser().post(`/sign/${row(w1).token}/not-present`, {})).status, 200);
  assert.equal((await browser().post(`/sign/${row(w2).token}/not-present`, {})).status, 200);
  const tok = row(ann).token;
  const into1 = await browser().post(`/sign/${tok}/witness`, { witness_id: w1, name: 'Wanda Second', email: wandaEmail });
  assert.equal(into1.status, 400, JSON.stringify(into1.data));
  assert.doesNotMatch(into1.data.error, /already your other witness/);
  assert.match(into1.data.error, /Wanda Second is in the place of your other witness and said they were not there\. To name them again, use that place, not this one\./);
  assert.equal(row(w1).witness_absent_at != null, true, 'nothing was changed');
  // In her own place she may be named again (pressed "not there" by mistake, tests/witness.test.ts), and the sender hears.
  const back = await browser().post(`/sign/${tok}/witness`, { witness_id: w2, name: 'Wanda Second', email: wandaEmail });
  assert.equal(back.status, 200, JSON.stringify(back.data));
});

test('the review title counts the witness places, and the two boxes say who may witness once, with one main button', async () => {
  const { reviewTitle, witnessPlaces } = await import('../src/components/sign/actions.ts');
  const open = { may_name: true, name: null, state: 'open' };
  const named = { may_name: true, name: 'Olga One', state: 'waiting' };
  assert.equal(reviewTitle(['witness'], false, witnessPlaces({ witnesses: [open] })), 'Name your witness');
  assert.equal(reviewTitle(['witness'], false, witnessPlaces({ witnesses: [open, open] })), 'Name your two witnesses');
  assert.equal(reviewTitle(['witness'], false, witnessPlaces({ witnesses: [named, open] })), 'Name your other witness');
  assert.equal(reviewTitle(['witness'], false, witnessPlaces({ witnesses: [open, named] })), 'Name your other witness');
  assert.equal(reviewTitle(['witness']), 'Name your witness', 'callers that pass no count are unchanged');
  assert.match(read('src/app/sign/[token]/page.tsx'), /me\.role === 'approver', witnessPlaces\(me\)\)/);

  const w = read('src/components/sign/Witness.tsx');
  assert.equal(w.match(/\{WHO_MAY_WITNESS\}/g)?.length, 2, 'once above two boxes, or in the one box');
  assert.match(w, /\{once && <p className="muted small wt-note" id=\{whoId\}>\{WHO_MAY_WITNESS\}<\/p>\}/);
  assert.match(w, /\{!whoId && <p className="muted small wt-note" id=\{`\$\{ids\}-who`\}>\{WHO_MAY_WITNESS\}<\/p>\}/);
  assert.match(w, /className=\{many \? 'btn' : 'btn primary'\}/);
  assert.match(w, /\{otherOk \? 'So your signature still needs one more witness\.' : 'So the document is not witnessed yet\.'\}/);

  // The editor: the second witness goes right under the first, and the keyboard goes on in the new row.
  const c = read('src/components/editor/WitnessChoice.tsx');
  assert.match(c, /onAdd\(\{ after_id: r\.id, role: 'witness'/);
  assert.match(c, /toast\(`Second witness added for \$\{who\(target\)\}\.`\)/);
  assert.match(c, /querySelector\(`\[data-second-for="\$\{target\.id\}"\]`\)\?\.closest\('\.rcpt'\)/);
  assert.match(c, /data-second-for=\{second \? target\.id : undefined\}/);
  assert.match(read('src/components/Editor.tsx'), /if \(at >= 0\) return \[\.\.\.l\.slice\(0, at \+ 1\), newRcp\(l, isTpl, p\), \.\.\.l\.slice\(at \+ 1\)\];/);
});
