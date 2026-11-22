// "Only when...": a person asked only when an earlier answer is the one the sender chose, or instead of someone else
// in the same step. Not asked, never emailed, no link and nothing held for them; the record and the signing record
// say why and never show them as having signed. Chains of rules, a rule on a hidden field, a group, corrections
// before the step, templates, bulk, the API, and the ways it is refused.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, upload, mailTo, tokenFor, PNG, type Server } from './helpers.ts';
import { decide, onlyWhenWords, notAskedWhy, fieldsBefore, canHaveRule, answerAfter, notAskedStatus } from '../src/lib/routing.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

let n = 0;
const person = (name: string, email: string) => signUp(name, email, `10.91.${++n}.7`);
const ok = (r: { status: number; data: any }, what = '') => {
  assert.equal(r.status, 200, `${what} ${JSON.stringify(r.data)}`);
  return r.data;
};
const rowOf = (eid: string, email: string) => db.get('SELECT * FROM recipients WHERE envelope_id=? AND email=?', eid, email);
const fid = (eid: string, label: string) => db.get('SELECT id FROM fields WHERE envelope_id=? AND label=?', eid, label).id;
const trail = (eid: string) => db.all('SELECT action, detail FROM audit WHERE envelope_id=? ORDER BY seq', eid);
const pdfText = async (bytes: Uint8Array) => (await import('../src/server/text.ts')).extractText(bytes);

// Signs as this person with these answers (by label), filling every other field of theirs.
async function sign(eid: string, email: string, answers: Record<string, string> = {}) {
  const c = new Client();
  const tok = tokenFor(eid, email);
  assert.ok(tok, `${email} has a link`);
  ok(await c.post(`/sign/${tok}/consent`), 'consent');
  const v = ok(await c.get(`/sign/${tok}`), 'open');
  const values: Record<string, string> = {};
  for (const f of v.fields || []) {
    if (f.label && f.label in answers) values[f.id] = answers[f.label];
    else values[f.id] = f.type === 'text' ? 'filled in' : f.type === 'number' ? '5' : f.type === 'date' ? '2026-01-15' : '1';
  }
  return c.post(`/sign/${tok}/complete`, { values, signature_png: PNG, initials_png: PNG });
}

const sig = (rid: string, y: number) => ({ document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y, w: 0.25, h: 0.05 });
const box = (rid: string, type: string, label: string, y: number, more: any = {}) => ({ id: label.toLowerCase().replace(/\W+/g, '_'), document_id: 'd', recipient_id: rid, type, label, page: 0, x: 0.5, y, w: 0.2, h: 0.03, required: false, ...more });

// Ana asks for an amount. Max (manager) is asked only when it is more than 1000, Olga (officer) otherwise. Cy gets a copy.
async function deal(c: Client, tag: string, over: any = {}) {
  const file = await upload(c, 1);
  const people = { ana: `ana.${tag}@route.example`, max: `max.${tag}@route.example`, olga: `olga.${tag}@route.example`, cy: `cy.${tag}@route.example` };
  const body = {
    subject: `Purchase ${tag}`, ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'ana', role: 'signer', name: 'Ana Asker', email: people.ana, routing_order: 1 },
      { id: 'max', role: 'signer', name: 'Max Manager', email: people.max, routing_order: 2, only_when: { field: 'amount', is: 'more_than', value: '1000' } },
      { id: 'olga', role: 'signer', name: 'Olga Officer', email: people.olga, routing_order: 2, only_when: { otherwise: 'max' } },
      { id: 'cy', role: 'cc', name: 'Cy Copy', email: people.cy, routing_order: 3 },
    ],
    fields: [
      sig('ana', 0.9), box('ana', 'number', 'Amount', 0.1), box('ana', 'checkbox', 'Has a co-signer', 0.15, { w: 0.03, h: 0.02 }),
      box('ana', 'text', 'Co-signer name', 0.2, { show_when: { field: 'has_a_co_signer', is: 'checked' } }),
      sig('max', 0.8), { ...box('max', 'full_name', 'Manager name', 0.3), required: true }, box('max', 'text', 'Approval note', 0.35),
      sig('olga', 0.7),
    ],
    ...over,
  };
  const e = ok(await c.post('/envelopes', body), 'draft').envelope;
  return { e, people, body };
}

// ---- The words and the decision, alone -----------------------------------------------------------------------

test('the rule is decided from stored values: numbers, ticks, empty answers, and a field its own rule hides counts as empty', () => {
  const fields = [
    { id: 'a', type: 'number', label: 'Amount', recipient_id: 'p', value: '800' },
    { id: 't', type: 'checkbox', label: 'Tick', recipient_id: 'p', value: '' },
    { id: 'h', type: 'text', label: 'Hidden', recipient_id: 'p', value: 'left over', show_when: { field: 't', is: 'checked' } },
    { id: 'c', type: 'number', label: 'Total', recipient_id: 'p', value: '1.234', calc_num: 1.234, formula: '{a}' },
  ];
  assert.deepEqual([decide({ field: 'a', is: 'more_than', value: '1000' }, fields).met, decide({ field: 'a', is: 'less_than', value: '1000' }, fields).met], [false, true]);
  assert.equal(decide({ field: 'a', is: 'more_than', value: '1000' }, fields).was, '800');
  assert.equal(decide({ field: 't', is: 'unchecked' }, fields).met, true);
  assert.equal(decide({ field: 't', is: 'checked' }, fields).was, 'not ticked');
  // The hidden field holds words, and still counts as empty: it is not on the page.
  assert.equal(decide({ field: 'h', is: 'empty' }, fields).met, true);
  assert.equal(decide({ field: 'h', is: 'filled' }, fields).met, false);
  assert.equal(decide({ field: 'h', is: 'filled' }, fields).was, 'not shown, so empty');
  // A calculated value counts with the number stored for it, not its text read again.
  assert.equal(decide({ field: 'c', is: 'less_than', value: '2' }, fields).met, true);
  // A field that is gone counts as empty.
  assert.equal(decide({ field: 'gone', is: 'filled' }, fields).met, false);
  assert.equal(notAskedWhy('Ben', 'Amount', '800', { field: 'a', is: 'more_than', value: '1000' }, 'number'), 'Ben, because Amount was 800 (rule: more than 1000).');
  assert.equal(onlyWhenWords({ field: 'a', is: 'more_than', value: '1000' }, { field: fields[0], fieldName: 'Amount' }), 'Only when Amount is more than 1000');
  assert.equal(onlyWhenWords({ otherwise: 'x' }, { insteadName: 'Max Manager' }), 'Only when Max Manager is not asked');
  // What the editor offers: only fields of people earlier in the order, and nothing without an order.
  const people = [{ id: 'p', routing_order: 1, role: 'signer' }, { id: 'q', routing_order: 2, role: 'signer' }];
  assert.equal(fieldsBefore(people[1], people, fields, true).length, 4);
  assert.equal(fieldsBefore(people[0], people, fields, true).length, 0, 'the first person has nobody before them');
  assert.equal(canHaveRule(people[1], people, fields, false), false, 'no order, no rule');
});

// ---- 1-4. Skip, alternative, the record and the signing record ----------------------------------------------

test('Amount 800: Max is not asked, never emailed and has no link; Olga is asked instead; the record and the signing record say why', async () => {
  const s = await person('Sue Sender', 'sue@route.example');
  const { e, people } = await deal(s, 'skip');
  // The API gives the rule back as an object pointing at the envelope's own field.
  const max0 = e.recipients.find((r: any) => r.name === 'Max Manager');
  assert.deepEqual(max0.only_when, { field: fid(e.id, 'Amount'), is: 'more_than', value: '1000' });
  assert.deepEqual(e.recipients.find((r: any) => r.name === 'Olga Officer').only_when, { otherwise: max0.id });
  ok(await s.post(`/envelopes/${e.id}/send`), 'send');
  assert.equal(rowOf(e.id, people.max).status, 'pending', 'nothing is decided before the step is reached');
  ok(await sign(e.id, people.ana, { Amount: '800' }), 'ana signs');

  const max = rowOf(e.id, people.max);
  assert.equal(max.status, 'skipped');
  assert.equal(max.token, null, 'no link at all');
  assert.equal(max.skipped_why, 'Max Manager, because Amount was 800 (rule: more than 1000).');
  assert.equal(mailTo(people.max).length, 0, 'Max is never emailed');
  assert.equal(rowOf(e.id, people.olga).status, 'sent');
  assert.equal(mailTo(people.olga).length, 1, 'Olga is asked');
  const lines = trail(e.id);
  assert.ok(lines.some((a: any) => a.action === 'Not asked' && a.detail.startsWith('Max Manager, because Amount was 800 (rule: more than 1000).')), JSON.stringify(lines));
  assert.ok(lines.some((a: any) => a.action === 'Asked because of a rule' && /^Olga Officer is asked, because Max Manager was not asked/.test(a.detail)));

  // Max cannot be corrected (that would email him), is not someone to comment to, and has nothing in Find my documents.
  const fix = await s.post(`/envelopes/${e.id}/correct`, { recipient_id: max.id, name: 'Max M', email: people.max });
  assert.notEqual(fix.status, 200);
  ok(await sign(e.id, people.olga), 'olga signs');
  const done = db.get('SELECT status FROM envelopes WHERE id=?', e.id);
  assert.equal(done.status, 'completed');
  assert.equal(mailTo(people.max).length, 0, 'no completed copy for someone who was not asked');
  assert.ok(mailTo(people.cy).length >= 1, 'the copy still goes to Cy');

  const pdfBytes = (await s.get(`/envelopes/${e.id}/download`)).data;
  if (process.env.ROUTING_PDF) (await import('node:fs')).writeFileSync(process.env.ROUTING_PDF, pdfBytes);
  const words = (await pdfText(pdfBytes)).replace(/\s+/g, ' ');
  assert.match(words, /Status Not asked: Max Manager, because Amount was 800 \(rule: more than 1000\)\./);
  const maxPart = words.slice(words.indexOf('Max Manager <'), words.indexOf('Olga Officer <'));
  assert.doesNotMatch(maxPart, /Signed|Approved|Viewed 2|Completed 2/, 'never shown as signed or approved');
  // His name field prints nothing on the page, so he does not look like he took part.
  const pages = words.slice(0, words.indexOf('RECIPIENTS'));
  assert.doesNotMatch(pages.replace(/Not asked: Max Manager/g, ''), /Max Manager(?! <)/);
});

test('Amount 1200: Max is asked, Olga is not, and a void later emails nobody who was not asked', async () => {
  const s = await person('Tom Tester', 'tom@route.example');
  const { e, people } = await deal(s, 'alt');
  ok(await s.post(`/envelopes/${e.id}/send`));
  ok(await sign(e.id, people.ana, { Amount: '1200' }));
  assert.equal(rowOf(e.id, people.max).status, 'sent');
  const olga = rowOf(e.id, people.olga);
  assert.equal(olga.status, 'skipped');
  assert.equal(olga.skipped_why, 'Olga Officer, because Max Manager was asked instead (rule: only if Max Manager is not asked).');
  assert.ok(trail(e.id).some((a: any) => a.action === 'Asked because of a rule' && a.detail === 'Max Manager is asked, because Amount was 1200 (rule: more than 1000).'));
  ok(await s.post(`/envelopes/${e.id}/void`, { reason: 'Wrong supplier' }));
  assert.equal(mailTo(people.olga).length, 0, 'Olga hears nothing about a document she was never asked to sign');
  assert.ok(mailTo(people.max).some((m: any) => /Voided/.test(m.subject)));
});

test('a chain of rules: Paul is asked only when Max wrote a note, and Max was not asked, so Paul is not either and the document completes', async () => {
  const s = await person('Cat Chain', 'cat@route.example');
  const file = await upload(s, 1);
  const tag = 'chain';
  const paul = `paul.${tag}@route.example`;
  const { e, people } = await deal(s, tag, {
    recipients: [
      { id: 'ana', role: 'signer', name: 'Ana Asker', email: `ana.${tag}@route.example`, routing_order: 1 },
      { id: 'max', role: 'signer', name: 'Max Manager', email: `max.${tag}@route.example`, routing_order: 2, only_when: { field: 'Amount', is: 'more_than', value: '1000' } },
      { id: 'paul', role: 'approver', name: 'Paul Payroll', email: paul, routing_order: 3, only_when: { field: 'Approval note', is: 'filled' } },
    ],
    documents: [{ id: 'd', file_id: file.id }],
    fields: [sig('ana', 0.9), box('ana', 'number', 'Amount', 0.1), sig('max', 0.8), box('max', 'text', 'Approval note', 0.35)],
  });
  ok(await s.post(`/envelopes/${e.id}/send`));
  ok(await sign(e.id, people.ana, { Amount: '20' }));
  assert.equal(rowOf(e.id, people.max).status, 'skipped');
  assert.equal(rowOf(e.id, paul).status, 'skipped');
  assert.match(rowOf(e.id, paul).skipped_why, /^Paul Payroll, because Approval note was empty \(rule: filled in\)\.$/);
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'completed', 'nobody is left to ask, so it completes');
  assert.equal(mailTo(paul).length, 0);
});

test('a rule on a field its own "Only show when" hides counts it as empty', async () => {
  const s = await person('Hal Hidden', 'hal@route.example');
  const { e, people } = await deal(s, 'hidden', {});
  // Max is asked only when the co-signer name is filled in. Ana does not tick the box, so that field is not shown.
  const cur = ok(await s.get(`/envelopes/${e.id}`)).envelope;
  const body = {
    ordered: true, documents: cur.documents.map((d: any) => ({ id: d.id, file_id: d.file_id, name: d.name })), fields: cur.fields,
    recipients: cur.recipients.map((r: any) => ({ ...r, only_when: r.name === 'Max Manager' ? { field: fid(e.id, 'Co-signer name'), is: 'filled' } : r.only_when })),
  };
  ok(await s.put(`/envelopes/${e.id}`, body), 'save');
  ok(await s.post(`/envelopes/${e.id}/send`));
  ok(await sign(e.id, people.ana, { 'Has a co-signer': '', 'Co-signer name': 'typed anyway' }));
  const max = rowOf(e.id, people.max);
  assert.equal(max.status, 'skipped');
  assert.equal(max.skipped_why, 'Max Manager, because Co-signer name was not shown, so empty (rule: filled in).');
  assert.equal(rowOf(e.id, people.olga).status, 'sent', 'Olga stands in');
});

// ---- 3. The held signature goes back ------------------------------------------------------------------------

test('a signature held for someone who is not asked is let go at once; nothing is used for them', async () => {
  const was = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_routing'; // signatures are counted; nothing here calls the payment provider
  try {
    const credits = await import('../src/server/credits.ts');
    const s = await person('Mia Money', 'mia@route.example');
    const { e, people } = await deal(s, 'money');
    const acct = db.get('SELECT account_id a FROM envelopes WHERE id=?', e.id).a;
    const start = credits.available(acct);
    ok(await s.post(`/envelopes/${e.id}/send`));
    assert.equal(credits.reserved(acct), 3, 'Ana, Max and Olga each have one held');
    ok(await sign(e.id, people.ana, { Amount: '800' }));
    assert.equal(credits.reserved(acct), 1, 'Olga only: the one held for Max went back');
    assert.equal(credits.available(acct), start - 2, 'Ana used one, Olga has one held');
    ok(await sign(e.id, people.olga));
    assert.equal(credits.available(acct), start - 2, 'two signatures used in all, none for Max');
    assert.equal(db.get(`SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature' AND ref LIKE ?`, acct, `${rowOf(e.id, people.max).id}|%`).n, 0);
  } finally {
    if (was === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = was;
  }
});

// ---- 5. Corrections, groups, templates, bulk ----------------------------------------------------------------

test('a correction can change the rule of a step not reached yet, and not of a step that was', async () => {
  const s = await person('Cora Correct', 'cora@route.example');
  const { e, people } = await deal(s, 'fix');
  ok(await s.post(`/envelopes/${e.id}/send`));
  const body = (cur: any, rule: (r: any) => any) => ({
    ordered: true, documents: cur.documents.map((d: any) => ({ id: d.id, file_id: d.file_id, name: d.name })), fields: cur.fields,
    recipients: cur.recipients.map((r: any) => ({ id: r.id, role: r.role, name: r.name, email: r.email, routing_order: r.routing_order, only_when: rule(r) })),
  });
  let cur = ok(await s.get(`/envelopes/${e.id}`)).envelope;
  ok(await s.put(`/envelopes/${e.id}`, body(cur, (r) => (r.name === 'Max Manager' ? { ...r.only_when, value: '500' } : r.only_when))), 'before the step');
  ok(await sign(e.id, people.ana, { Amount: '800' }));
  assert.equal(rowOf(e.id, people.max).status, 'sent', 'the corrected rule (more than 500) was the one decided');
  assert.equal(rowOf(e.id, people.olga).status, 'skipped');
  cur = ok(await s.get(`/envelopes/${e.id}`)).envelope;
  const late = await s.put(`/envelopes/${e.id}`, body(cur, (r) => (r.name === 'Max Manager' ? { ...r.only_when, value: '2000' } : r.only_when)));
  assert.equal(late.status, 400);
  assert.equal(late.data.error, 'Nothing was saved, because Max Manager has already been asked, so the rule for them can no longer change. Change the rules of people who have not been reached yet, or leave this one as it is.');
  const late2 = await s.put(`/envelopes/${e.id}`, body(cur, (r) => (r.name === 'Olga Officer' ? null : r.only_when)));
  assert.match(late2.data.error, /Olga Officer was already not asked, so the rule for them can no longer change/);
  // Leaving "only_when" out keeps each rule as it is.
  const kept = { ...body(cur, () => undefined) };
  for (const r of kept.recipients) delete r.only_when;
  ok(await s.put(`/envelopes/${e.id}`, kept), 'a save that does not mention rules');
  assert.ok(rowOf(e.id, people.max).only_when, 'kept');
});

test('a group can be asked only when: not asked, none of its members is emailed or has a link', async () => {
  const s = await person('Gil Group', 'gil@route.example');
  const members = [1, 2, 3].map((i) => ({ name: `Member ${i}`, email: `m${i}.grp@route.example` }));
  const group = ok(await s.post('/groups', { name: 'Finance team', members })).group;
  const file = await upload(s, 1);
  const ana = 'ana.grp@route.example';
  const e = ok(await s.post('/envelopes', {
    subject: 'Group rule', ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'ana', role: 'signer', name: 'Ana Asker', email: ana, routing_order: 1 },
      { id: 'g', role: 'signer', group_id: group.id, routing_order: 2, only_when: { field: 'Amount', is: 'more_than', value: '1000' } },
    ],
    fields: [sig('ana', 0.9), box('ana', 'number', 'Amount', 0.1), sig('g', 0.6)],
  })).envelope;
  ok(await s.post(`/envelopes/${e.id}/send`));
  ok(await sign(e.id, ana, { Amount: '10' }));
  const g = db.get('SELECT * FROM recipients WHERE envelope_id=? AND group_name IS NOT NULL', e.id);
  assert.equal(g.status, 'skipped');
  assert.match(g.skipped_why, /because Amount was 10 \(rule: more than 1000\)\./);
  for (const m of members) assert.equal(mailTo(m.email).length, 0, `${m.email} is not emailed`);
  assert.equal(db.get('SELECT COUNT(*) n FROM recipient_members WHERE recipient_id=? AND token IS NOT NULL', g.id).n, 0);
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'completed');
});

test('templates, copies and bulk sends carry the rule, pointing at their own fields and people', async () => {
  const s = await person('Tia Template', 'tia@route.example');
  const file = await upload(s, 1);
  const tpl = ok(await s.post('/envelopes', {
    kind: 'template', subject: 'Order form', ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'client', role: 'signer', role_name: 'Client', routing_order: 1 },
      { id: 'boss', role: 'approver', role_name: 'Boss', name: 'Bo Boss', email: 'bo.tpl@route.example', routing_order: 2, only_when: { field: 'Amount', is: 'more_than', value: '1000' } },
      { id: 'clerk', role: 'approver', role_name: 'Clerk', name: 'Cl Clerk', email: 'cl.tpl@route.example', routing_order: 2, only_when: { otherwise: 'boss' } },
    ],
    fields: [sig('client', 0.9), box('client', 'number', 'Amount', 0.1)],
  })).envelope;
  const used = ok(await s.post('/envelopes', { template_id: tpl.id, recipients: { Client: { name: 'Cal Client', email: 'cal.tpl@route.example' } } })).envelope;
  const boss = used.recipients.find((r: any) => r.role_name === 'Boss');
  assert.deepEqual(boss.only_when, { field: fid(used.id, 'Amount'), is: 'more_than', value: '1000' }, 'the copy points at its own field');
  assert.deepEqual(used.recipients.find((r: any) => r.role_name === 'Clerk').only_when, { otherwise: boss.id }, 'and its own person');
  const bulk = ok(await s.post('/bulk', { template_id: tpl.id, rows: [{ Client: { name: 'Bea Bulk', email: 'bea.tpl@route.example' } }] }));
  const sent = bulk.results[0].id;
  ok(await sign(sent, 'bea.tpl@route.example', { Amount: '5000' }));
  assert.equal(rowOf(sent, 'bo.tpl@route.example').status, 'sent');
  assert.equal(rowOf(sent, 'cl.tpl@route.example').status, 'skipped');
});

// ---- Refusals: plain words, what happened and what to do ---------------------------------------------------

test('rules that cannot work are refused in two sentences that say what to do, and nothing is saved', async () => {
  const s = await person('Rae Refuse', 'rae@route.example');
  const file = await upload(s, 1);
  const base = (recipients: any[], over: any = {}) => ({ subject: 'Refused', ordered: true, documents: [{ id: 'd', file_id: file.id }], recipients, fields: [sig('a', 0.9), box('a', 'number', 'Amount', 0.1), sig('b', 0.8), box('b', 'text', 'Later note', 0.4)], ...over });
  const a = { id: 'a', role: 'signer', name: 'Ann A', email: 'a.ref@route.example', routing_order: 1 };
  const b = (w: any, order = 2, more: any = {}) => ({ id: 'b', role: 'signer', name: 'Bob B', email: 'b.ref@route.example', routing_order: order, only_when: w, ...more });
  const before = db.get('SELECT COUNT(*) n FROM envelopes').n;
  const cases: [any, RegExp][] = [
    [base([a, b({ field: 'Amount', is: 'more_than', value: '1' })], { ordered: false }), /no signing order, so nobody signs before Bob B\. Turn on "Set signing order"/],
    [base([{ ...a, only_when: { field: 'Later note', is: 'filled' } }, b(null)]), /reads 'Later note', which Bob B fills in, and Bob B does not sign before Ann A\. Put Bob B earlier/],
    [base([a, b({ field: 'Amount', is: 'more_than', value: '1' }, 1)]), /Ann A does not sign before Bob B/],
    [base([a, b({ field: 'Later note', is: 'filled' })]), /which Bob B fills in, and that answer is not there yet when it is decided/],
    [base([a, b({ field: 'Amount', is: 'more_than', value: 'lots' })]), /"lots" is not a number, so 'Amount' cannot be compared with it\. Write it like 1000/],
    [base([a, b({ field: 'Amount', is: 'ticked' })]), /"is" in the rule for Bob B is "ticked", which cannot be asked of 'Amount'\. Use one of/],
    [base([a, b({ field: 'Nope', is: 'filled' })]), /no field on this document has that id or label/],
    [base([a, b({ otherwise: 'a' })]), /Bob B is asked instead of Ann A, who is at another place in the signing order/],
    [base([a, b({ otherwise: 'b' })]), /Bob B is asked instead of themselves/],
    [base([a, b('yes')]), /"only_when" of Bob B is not an object/],
  ];
  for (const [body, want] of cases) {
    const r = await s.post('/envelopes', body);
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, want);
    // Two sentences: what happened, then what to do (a verb first).
    const parts = r.data.error.split(/(?<=\.)\s+(?=[A-Z"])/);
    assert.ok(parts.length >= 2 && /^Nothing was saved, because/.test(parts[0]), r.data.error);
    assert.match(parts[parts.length - 1], /^(Turn|Put|Use|Choose|Give|Write|Send|Add|Shorten|Take|Change)\b/, r.data.error);
    assert.doesNotMatch(r.data.error, /\u2014/, 'no em dashes');
  }
  // A witness cannot have a rule.
  const w = await s.post('/envelopes', base([a, { ...b(null), id: 'b' }, { id: 'w', role: 'witness', name: 'Wes Witness', email: 'w.ref@route.example', routing_order: 2, witness_for: 'a', only_when: { field: 'Amount', is: 'filled' } }]));
  assert.equal(w.status, 400);
  assert.match(w.data.error, /Wes Witness is a witness, and a witness is asked when their signer has signed/);
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes').n, before, 'no draft was left behind');
});

test('a person who was not asked is not in anyone\'s To sign list and Find my documents sends them nothing', async () => {
  const s = await person('Ian Inbox', 'ian@route.example');
  const { e, people } = await deal(s, 'inbox');
  ok(await s.post(`/envelopes/${e.id}/send`));
  ok(await sign(e.id, people.ana, { Amount: '1' }));
  const max = await person('Max Manager', people.max);
  const inbox = ok(await max.get('/inbox'));
  assert.equal(inbox.items.filter((x: any) => x.id === e.id).length, 0);
  const before = mailTo(people.max).length;
  await Object.assign(new Client(), { ip: '10.92.0.1' }).post('/public/links/find', { email: people.max });
  const mine = mailTo(people.max).slice(before);
  assert.ok(mine.every((m: any) => !String(m.html).includes(e.subject)), 'no link to this document');
});

// ---- Repairs after review (tests/out/verify-ds-routing-if, tests/out/ux-ds-routing-if) --------------------------

test('someone who was emailed and opened it, then is not needed after a correction, is told so, and the record never says they were not emailed', async () => {
  const s = await person('Rae Resend', 'rae.resend@route.example');
  const { e, people } = await deal(s, 'reask');
  ok(await s.post(`/envelopes/${e.id}/send`), 'send');
  ok(await sign(e.id, people.ana, { Amount: '800' }), 'ana says 800');
  assert.equal(rowOf(e.id, people.olga).status, 'sent');
  // Olga opens it.
  const oc = new Client();
  const otok = tokenFor(e.id, people.olga);
  ok(await oc.post(`/sign/${otok}/consent`), 'olga agrees');
  ok(await oc.get(`/sign/${otok}`), 'olga opens');
  // The sender asks Ana to sign again; Olga gives her turn back.
  const cur = ok(await s.get(`/envelopes/${e.id}`)).envelope;
  ok(await s.put(`/envelopes/${e.id}`, {
    ordered: true, documents: cur.documents.map((d: any) => ({ id: d.id, file_id: d.file_id, name: d.name })),
    recipients: cur.recipients.map((r: any) => ({ id: r.id, role: r.role, name: r.name, email: r.email, routing_order: r.routing_order })),
    fields: [...cur.fields, { document_id: cur.documents[0].id, recipient_id: cur.recipients.find((r: any) => r.name === 'Ana Asker').id, type: 'text', label: 'Extra', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.03 }],
    resign: true,
  }), 'correction');
  assert.equal(rowOf(e.id, people.olga).status, 'pending');
  const before = mailTo(people.olga).length;
  ok(await sign(e.id, people.ana, { Amount: '1200' }), 'ana now says 1200');

  const olga = rowOf(e.id, people.olga);
  assert.equal(olga.status, 'skipped');
  assert.equal(olga.token, null);
  assert.ok(olga.skipped_was_asked, 'the row remembers she had been asked');
  const mails = mailTo(people.olga);
  assert.equal(mails.length, before + 1, 'one more email');
  assert.match(mails.at(-1).subject, /^No longer needed: /);
  assert.match(mails.at(-1).html, /no longer needs you/);
  const lines = trail(e.id).filter((a: any) => a.detail?.startsWith('Olga Officer'));
  assert.ok(!lines.some((a: any) => /No email was sent to them|did not sign, approve or see/.test(a.detail)), JSON.stringify(lines));
  assert.ok(lines.some((a: any) => a.action === 'No longer needed' && /had been asked before the document was changed and had opened it/.test(a.detail)), JSON.stringify(lines));
  // No mail server in tests: the record says the email could not go, and the row says the sender should tell her.
  assert.ok(trail(e.id).some((a: any) => a.action.startsWith('No longer needed: ')));
  assert.equal(olga.skipped_was_asked, 2);

  ok(await sign(e.id, people.max), 'max signs');
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'completed');
  const words = (await pdfText((await s.get(`/envelopes/${e.id}/download`)).data)).replace(/\s+/g, ' ');
  assert.match(words, /No longer needed: Olga Officer, because Max Manager was asked instead/);
  assert.doesNotMatch(words, /Not asked: Olga Officer/);
});

test('an answer the sender hid from the others is never written into the reason, the record or the certificate', async () => {
  const s = await person('Hal Hidden', 'hal.hidden@route.example');
  const file = await upload(s, 1);
  const secret = 'SSN 123-45-6789';
  const e = ok(await s.post('/envelopes', {
    subject: 'Hidden answer', ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'ana', role: 'signer', name: 'Ana Asker', email: 'ana.hid@route.example', routing_order: 1 },
      { id: 'max', role: 'signer', name: 'Max Manager', email: 'max.hid@route.example', routing_order: 2, only_when: { field: 'secret', is: 'equals', value: 'nothing' } },
      { id: 'olga', role: 'signer', name: 'Olga Officer', email: 'olga.hid@route.example', routing_order: 2, only_when: { otherwise: 'max' } },
    ],
    fields: [sig('ana', 0.9), box('ana', 'text', 'Secret', 0.1, { validation: { hide: true, hide_in_copy: true } }), sig('max', 0.8), sig('olga', 0.7)],
  }), 'draft').envelope;
  ok(await s.post(`/envelopes/${e.id}/send`), 'send');
  ok(await sign(e.id, 'ana.hid@route.example', { Secret: secret }), 'ana');
  const max = rowOf(e.id, 'max.hid@route.example');
  assert.equal(max.status, 'skipped');
  assert.equal(max.skipped_why, 'Max Manager, because Secret, an answer hidden from the others, did not meet the rule.');
  assert.ok(!JSON.stringify(trail(e.id)).includes('123-45-6789'), 'not in the record');
  assert.ok(!JSON.stringify(trail(e.id)).includes('"nothing"'), 'nor the value the rule compares with');
  ok(await sign(e.id, 'olga.hid@route.example'), 'olga');
  const words = await pdfText((await s.get(`/envelopes/${e.id}/download`)).data);
  assert.ok(!words.includes('123-45-6789'), 'not in the completed copy');
  assert.match(words.replace(/\s+/g, ' '), /an answer hidden from the others, did not meet the rule/);
});

test('a hidden answer that meets the rule says so without the answer', async () => {
  const s = await person('Hope Hidden', 'hope.repair@route.example');
  const file = await upload(s, 1);
  const e = ok(await s.post('/envelopes', {
    subject: 'Hidden met', ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'ana', role: 'signer', name: 'Ana Asker', email: 'ana.met@route.example', routing_order: 1 },
      { id: 'max', role: 'signer', name: 'Max Manager', email: 'max.met@route.example', routing_order: 2, only_when: { field: 'secret', is: 'filled' } },
    ],
    fields: [sig('ana', 0.9), box('ana', 'text', 'Secret', 0.1, { validation: { hide: true } }), sig('max', 0.8)],
  }), 'draft').envelope;
  ok(await s.post(`/envelopes/${e.id}/send`), 'send');
  ok(await sign(e.id, 'ana.met@route.example', { Secret: 'my pin 4321' }), 'ana');
  assert.equal(rowOf(e.id, 'max.met@route.example').status, 'sent');
  const line = trail(e.id).find((a: any) => a.action === 'Asked because of a rule');
  assert.equal(line.detail, 'Max Manager is asked, because Secret, an answer hidden from the others, meets the rule.');
  assert.ok(!JSON.stringify(trail(e.id)).includes('4321'));
});

test('a reminder for someone who was not asked is refused in words, never a quiet 0', async () => {
  const s = await person('Rita Remind', 'rita.repair@route.example');
  const { e, people } = await deal(s, 'remind');
  ok(await s.post(`/envelopes/${e.id}/send`), 'send');
  ok(await sign(e.id, people.ana, { Amount: '800' }), 'ana');
  const max = rowOf(e.id, people.max);
  const r = await s.post(`/envelopes/${e.id}/remind`, { recipient_id: max.id });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'not_asked');
  assert.match(r.data.error, /^Max Manager was not asked, because the rule for them was not met/);
  assert.equal(mailTo(people.max).length, 0);
  // Everyone: Olga is reminded, and Max is nobody to remind.
  ok(await s.post(`/envelopes/${e.id}/remind`, {}), 'remind all');
  assert.equal(mailTo(people.max).length, 0);
});

test('the editor finds "Only when..." without a signing order: it names who to put first, and nothing for a new document', () => {
  const ana = { id: 'a', role: 'signer', routing_order: 1, name: 'Ana' };
  const max = { id: 'm', role: 'signer', routing_order: 1, name: 'Max' };
  const wit = { id: 'w', role: 'witness', routing_order: 1, name: 'Wit' };
  const amount = { id: 'f', type: 'number', recipient_id: 'a' };
  // No signing order: nothing to read yet, but Ana's answer could count once Max signs after her.
  assert.equal(canHaveRule(max, [ana, max], [amount], false), false);
  assert.equal(answerAfter(max, [ana, max], [amount], false)?.id, 'a');
  // Order on, both at step 1: the same.
  assert.equal(answerAfter(max, [ana, max], [amount], true)?.id, 'a');
  // Max after Ana: the rule itself is offered, and no hint.
  assert.equal(answerAfter({ ...max, routing_order: 2 }, [ana, { ...max, routing_order: 2 }], [amount], true), null);
  // Nothing on a new document, nothing for the person who answers, nothing for a witness, nothing for a signature only.
  assert.equal(answerAfter(max, [ana, max], [], false), null);
  assert.equal(answerAfter(ana, [ana, max], [amount], false), null);
  assert.equal(answerAfter(wit, [ana, wit], [amount], false), null);
  assert.equal(answerAfter(max, [ana, max], [{ id: 's', type: 'signature', recipient_id: 'a' }], false), null);
  // The certificate never calls someone who had been asked "Not asked".
  assert.match(notAskedStatus({ skipped_why: 'Olga, because Max was asked instead.', skipped_was_asked: 2 }), /^No longer needed: Olga, because Max was asked instead\. They had been asked before/);
  assert.equal(notAskedStatus({ skipped_why: 'Max, because Amount was 800 (rule: more than 1000).' }), 'Not asked: Max, because Amount was 800 (rule: more than 1000).');
});
