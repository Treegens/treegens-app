// People who change the envelope on their turn and do not sign (src/server/agents.ts, src/lib/recipienttypes.ts):
// "Chooses who comes next" fills in the places the sender left open and changes the people after them; "Can change
// the document" replaces files and changes the people after them through the sender's Edit rules, including signing
// again. What each may and may not change, the record and the certificate lines, templates, and where they are refused.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, upload, mailTo, tokenFor, PNG, type Server } from './helpers.ts';
import { stepRoleProblem, isOpenPlace, namedLine } from '../src/lib/recipienttypes.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

let n = 0;
const person = (name: string, email: string) => signUp(name, email, `10.93.${++n}.7`);
const ok = (r: { status: number; data: any }, what = '') => {
  assert.equal(r.status, 200, `${what} ${JSON.stringify(r.data)}`);
  return r.data;
};
const trail = (eid: string) => db.all('SELECT actor, action, detail FROM audit WHERE envelope_id=? ORDER BY seq', eid);
const row = (eid: string, rid: string) => db.get('SELECT * FROM recipients WHERE envelope_id=? AND id LIKE ?', eid, `%${rid}%`) || db.get('SELECT * FROM recipients WHERE envelope_id=? AND id=?', eid, rid);
const pdfText = async (bytes: Uint8Array) => (await import('../src/server/text.ts')).extractText(bytes);
const sig = (rid: string, y: number) => ({ document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y, w: 0.25, h: 0.05 });

async function sign(eid: string, email: string) {
  const c = new Client();
  const tok = tokenFor(eid, email);
  assert.ok(tok, `${email} has a link`);
  ok(await c.post(`/sign/${tok}/consent`), 'consent');
  const v = ok(await c.get(`/sign/${tok}`), 'open');
  const values: Record<string, string> = {};
  for (const f of v.fields || []) values[f.id] = f.type === 'text' ? 'filled in' : '1';
  return c.post(`/sign/${tok}/complete`, { values, signature_png: PNG, initials_png: PNG });
}
async function stepLink(eid: string, email: string) {
  const c = new Client();
  const tok = tokenFor(eid, email);
  assert.ok(tok, `${email} has a link`);
  ok(await c.post(`/sign/${tok}/consent`), 'consent');
  return { c, tok, base: `/sign/${tok}` };
}
const ids = (eid: string) => Object.fromEntries(db.all('SELECT id, email, name, role FROM recipients WHERE envelope_id=?', eid).map((r: any) => [r.email || r.name, r.id]));

// Ana signs, Mia chooses who comes next, the landowner's place is left open, Ben is named by the sender.
async function chooserDeal(c: Client, tag: string, over: any = {}) {
  const file = await upload(c, 1);
  const body = {
    subject: `Lease ${tag}`, ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'ana', role: 'signer', name: 'Ana Asker', email: `ana.${tag}@rt.example`, routing_order: 1 },
      { id: 'mia', role: 'agent', name: 'Mia Chen', email: `mia.${tag}@rt.example`, routing_order: 2 },
      { id: 'land', role: 'signer', role_name: 'Landowner', name: '', email: '', routing_order: 3 },
      { id: 'ben', role: 'signer', name: 'Ben Ode', email: `ben.${tag}@rt.example`, routing_order: 4 },
    ],
    fields: [sig('ana', 0.9), sig('land', 0.8), sig('ben', 0.7)],
    ...over,
  };
  return ok(await c.post('/envelopes', body), 'draft').envelope;
}

// ---- The rules alone -------------------------------------------------------------------------------------------

test('the rules: a signing order, someone after them, no fields of their own, never a form or Send to many', () => {
  const ppl = [{ id: 'a', role: 'agent', name: 'Mia', routing_order: 1 }, { id: 'b', role: 'signer', name: '', email: '', routing_order: 2 }];
  assert.equal(stepRoleProblem(ppl, [], true), null);
  assert.match(stepRoleProblem(ppl, [], false)!, /Turn on Set signing order/);
  assert.match(stepRoleProblem([ppl[0]], [], true)!, /nobody comes after them/);
  assert.match(stepRoleProblem(ppl, [{ recipient_id: 'a' }], true)!, /does not sign, so they cannot have fields/);
  assert.match(stepRoleProblem(ppl, [], true, { form: true })!, /public form/);
  assert.match(stepRoleProblem(ppl, [], true, { bulk: true })!, /Send to many/);
  assert.equal(isOpenPlace(ppl[1], ppl, true), true);
  assert.equal(isOpenPlace(ppl[1], ppl, false), false, 'no order, no open place');
  assert.equal(isOpenPlace({ ...ppl[1], role: 'cc' }, ppl, true), false, 'a copy is never left open');
  assert.equal(namedLine('Mia Chen', { name: 'Paul Ade', email: 'p@x.example' }, { role: 'signer', role_name: 'Landowner' }), 'Mia Chen named Paul Ade <p@x.example> as the signer for Landowner.');
  for (const s of [stepRoleProblem(ppl, [], false), stepRoleProblem(ppl, [], true, { bulk: true })]) assert.ok(!/\u2014/.test(s!), 'no em dashes');
});

// ---- Chooses who comes next --------------------------------------------------------------------------------------

test('chooses who comes next: names the open place, changes a later person, cannot touch earlier people, then finishes', async () => {
  const c = await person('Rosa Sender', 'rosa.rt1@rt.example');
  const e = await chooserDeal(c, 'a');
  ok(await c.post(`/envelopes/${e.id}/send`), 'send with an open place');
  const id = ids(e.id);
  const land = db.get("SELECT * FROM recipients WHERE envelope_id=? AND role_name='Landowner'", e.id);
  assert.equal(land.name, 'Landowner', 'the open place is listed under its role');
  assert.equal(land.place_open, 1);
  assert.equal(land.status, 'pending');
  ok(await sign(e.id, 'ana.a@rt.example'), 'Ana signs');
  // Mia is asked, in words that say what she does.
  const invite = mailTo('mia.a@rt.example').pop();
  assert.match(invite.html, /asked you to choose who signs next/);
  assert.match(invite.html, /Choose who signs/);
  const m = await stepLink(e.id, 'mia.a@rt.example');
  const view = ok(await m.c.get(`${m.base}/step`), 'step view');
  assert.equal(view.role, 'agent');
  assert.equal(view.open_left, 1);
  assert.deepEqual(view.people.map((p: any) => [p.place || p.name, p.open]), [['Landowner', true], ['Ben Ode', false]]);
  assert.ok(!view.people.some((p: any) => p.id === id['ana.a@rt.example']), 'Ana, before her, is not listed');
  // Refused: someone before her, a link that is not hers to use, a half address, finishing with a place still open.
  assert.equal((await m.c.post(`${m.base}/step/people`, { people: [{ id: id['ana.a@rt.example'], name: 'Eve Evil', email: 'eve@rt.example' }] })).status, 403);
  assert.equal((await m.c.post(`${m.base}/step/people`, { people: [{ id: land.id, name: 'Paul Ade', email: 'not-an-address' }] })).status, 400);
  assert.equal((await m.c.post(`${m.base}/step/people`, { people: [{ id: id['mia.a@rt.example'], name: 'Mia Other', email: 'mia2@rt.example' }] })).status, 403, 'not herself');
  // The ordinary Finish of a signer is not a way round the open place.
  const sideways = await m.c.post(`${m.base}/complete`, { values: {} });
  assert.equal(sideways.status, 409);
  assert.equal(sideways.data.code, 'step_role');
  const early = await m.c.post(`${m.base}/step/finish`);
  assert.equal(early.status, 409);
  assert.match(early.data.error || early.data.message || JSON.stringify(early.data), /Landowner/);
  assert.equal(db.get('SELECT name FROM recipients WHERE id=?', id['ana.a@rt.example']).name, 'Ana Asker');
  // Names the landowner and changes Ben, in one go.
  const after = ok(await m.c.post(`${m.base}/step/people`, { people: [{ id: land.id, name: 'Paul Ade', email: 'paul.a@rt.example' }, { id: id['ben.a@rt.example'], name: 'Bea Ode', email: 'bea.a@rt.example' }] }), 'name them');
  assert.equal(after.open_left, 0);
  const lines = trail(e.id).filter((a: any) => a.action === 'Person chosen');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].detail, 'Mia Chen named Paul Ade <paul.a@rt.example> as the signer for Landowner.');
  assert.equal(lines[1].detail, 'Mia Chen named Bea Ode <bea.a@rt.example> as the signer, in place of Ben Ode <ben.a@rt.example>.');
  assert.match(lines[0].actor, /Mia Chen/);
  assert.equal(mailTo('paul.a@rt.example').length, 0, 'nobody is emailed before their turn');
  // Ben's old link no longer opens anything.
  assert.ok(!db.get('SELECT 1 x FROM recipients WHERE envelope_id=? AND email=?', e.id, 'ben.a@rt.example'));
  ok(await m.c.post(`${m.base}/step/finish`), 'finish');
  assert.equal((await m.c.post(`${m.base}/step/finish`)).status, 409, 'a second finish');
  assert.equal((await m.c.post(`${m.base}/step/people`, { people: [{ id: land.id, name: 'Late Change', email: 'late@rt.example' }] })).status, 409, 'nothing after finishing');
  assert.ok(trail(e.id).some((a: any) => a.action === 'Finished their step' && /Mia Chen/.test(a.detail)));
  assert.equal(mailTo('paul.a@rt.example').length, 1, 'Paul is asked now');
  ok(await sign(e.id, 'paul.a@rt.example'), 'Paul signs');
  ok(await sign(e.id, 'bea.a@rt.example'), 'Bea signs');
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'completed');
  const env = (await import('../src/server/envelopes.ts'));
  const text = await pdfText(await env.buildPdf(env.loadEnvelope(e.id), true));
  assert.match(text, /Chooses who comes next/);
  assert.match(text, /Finished their step/);
  assert.match(text, /Named by/);
  assert.match(text, /Mia Chen named Paul Ade/);
  assert.ok(!/Mia Chen[\s\S]{0,80}Signed\b/.test(text.split('Recipients')[1]?.split('Paul Ade')[0] || ''), 'Mia is never shown as having signed');
});

test('chooses who comes next: the fake-notice guard and the daily limit apply to the names, and nothing half saves', async () => {
  const c = await person('Rosa Sender', 'rosa.rt2@rt.example');
  const e = await chooserDeal(c, 'b');
  ok(await c.post(`/envelopes/${e.id}/send`), 'send');
  ok(await sign(e.id, 'ana.b@rt.example'), 'Ana signs');
  const land = db.get("SELECT * FROM recipients WHERE envelope_id=? AND role_name='Landowner'", e.id);
  const m = await stepLink(e.id, 'mia.b@rt.example');
  // A second line that is wrong stops the first one too.
  const r = await m.c.post(`${m.base}/step/people`, { people: [{ id: land.id, name: 'Paul Ade', email: 'paul.b@rt.example' }, { id: 'rcp_nope', name: 'X Y', email: 'x@rt.example' }] });
  assert.equal(r.status, 404);
  assert.equal(db.get('SELECT email FROM recipients WHERE id=?', land.id).email, '', 'nothing was saved');
  // A name that reads like a payment notice is turned down by the same filter as the sender's.
  const lure = await m.c.post(`${m.base}/step/people`, { people: [{ id: land.id, name: 'PayPal Billing call +1 800 555 0199 re $499 charge', email: 'paul.b@rt.example' }] });
  assert.equal(lure.status, 422, JSON.stringify(lure.data));
  assert.match(lure.data.error, /^We cannot add these people to the document right now\. Nothing was changed\. Reply to the email you got and ask Rosa Sender to add them\.$/);
  assert.equal(db.get('SELECT email FROM recipients WHERE id=?', land.id).email, '');
  // Paused account: nobody new.
  db.run('UPDATE accounts SET suspended_at=? WHERE id=?', new Date().toISOString(), e.account_id);
  const paused = await m.c.post(`${m.base}/step/people`, { people: [{ id: land.id, name: 'Paul Ade', email: 'paul.b@rt.example' }] });
  assert.notEqual(paused.status, 200);
  db.run('UPDATE accounts SET suspended_at=NULL WHERE id=?', e.account_id);
});

test('a signer, a copy and someone whose turn has not come cannot use the step routes', async () => {
  const c = await person('Rosa Sender', 'rosa.rt3@rt.example');
  const e = await chooserDeal(c, 'c');
  ok(await c.post(`/envelopes/${e.id}/send`), 'send');
  const a = await stepLink(e.id, 'ana.c@rt.example');
  assert.equal((await a.c.get(`${a.base}/step`)).status, 403, 'a signer has no step');
  assert.equal((await a.c.post(`${a.base}/step/finish`)).status, 403);
  // Mia before her turn.
  const m = new Client();
  const tok = tokenFor(e.id, 'mia.c@rt.example');
  const early = await m.post(`/sign/${tok}/step/people`, { people: [] });
  assert.notEqual(early.status, 200);
  assert.notEqual((await m.post(`/sign/${tok}/step/finish`)).status, 200);
});

test('refused at sending: no signing order, nobody after them, fields of their own; an open place needs a chooser before it', async () => {
  const c = await person('Rosa Sender', 'rosa.rt4@rt.example');
  const noOrder = await chooserDeal(c, 'd', { ordered: false });
  const r1 = await c.post(`/envelopes/${noOrder.id}/send`);
  assert.equal(r1.status, 400);
  assert.match(JSON.stringify(r1.data), /Turn on Set signing order/);
  const theirFields = await chooserDeal(c, 'e', { fields: [sig('ana', 0.9), sig('land', 0.8), sig('ben', 0.7), sig('mia', 0.5)] });
  const r2 = await c.post(`/envelopes/${theirFields.id}/send`);
  assert.equal(r2.status, 400);
  assert.match(JSON.stringify(r2.data), /does not sign, so they cannot have fields/);
  const file = await upload(c, 1);
  const last = ok(await c.post('/envelopes', { subject: 'Last', ordered: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'ana', role: 'signer', name: 'Ana A', email: 'ana.f@rt.example', routing_order: 1 }, { id: 'mia', role: 'agent', name: 'Mia C', email: 'mia.f@rt.example', routing_order: 2 }], fields: [sig('ana', 0.9)] })).envelope;
  const r3 = await c.post(`/envelopes/${last.id}/send`);
  assert.equal(r3.status, 400);
  assert.match(JSON.stringify(r3.data), /nobody comes after them/);
  // An empty person with no chooser before them is still refused, as before.
  const plain = ok(await c.post('/envelopes', { subject: 'Plain', ordered: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'x', role: 'signer', name: 'Xu Y', email: '', routing_order: 1 }], fields: [sig('x', 0.9)] })).envelope;
  assert.equal((await c.post(`/envelopes/${plain.id}/send`)).status, 400);
});

// ---- Can change the document -------------------------------------------------------------------------------------

async function editorDeal(c: Client, tag: string) {
  const file = await upload(c, 1);
  const body = {
    subject: `Contract ${tag}`, message: 'Please look.', ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'ana', role: 'signer', name: 'Ana Asker', email: `ana.${tag}@ed.example`, routing_order: 1 },
      { id: 'ed', role: 'editor', name: 'Ed Lawyer', email: `ed.${tag}@ed.example`, routing_order: 2 },
      { id: 'ben', role: 'signer', name: 'Ben Ode', email: `ben.${tag}@ed.example`, routing_order: 3 },
    ],
    fields: [sig('ana', 0.9), sig('ben', 0.7)],
  };
  const e = ok(await c.post('/envelopes', body), 'draft').envelope;
  ok(await c.post(`/envelopes/${e.id}/send`), 'send');
  return e;
}

test('can change the document: changes the people after them, never the ones before, the subject or the message', async () => {
  const c = await person('Rosa Sender', 'rosa.ed1@ed.example');
  const e = await editorDeal(c, 'a');
  ok(await sign(e.id, 'ana.a@ed.example'), 'Ana signs');
  assert.match(mailTo('ed.a@ed.example').pop().html, /asked you to check and, if needed, change/);
  const d = await stepLink(e.id, 'ed.a@ed.example');
  const view = ok(await d.c.get(`${d.base}/step`), 'view');
  assert.equal(view.documents.length, 1);
  const id = ids(e.id);
  // Refused: someone before him, a role that is not on the short list, a place at or before his own.
  assert.equal((await d.c.post(`${d.base}/step/change`, { people: [{ id: id['ana.a@ed.example'], name: 'Ana X', email: 'x@ed.example' }] })).status, 403);
  assert.equal((await d.c.post(`${d.base}/step/change`, { people: [{ id: id['ben.a@ed.example'], role: 'inperson' }] })).status, 400);
  assert.equal((await d.c.post(`${d.base}/step/change`, { people: [{ id: id['ben.a@ed.example'], routing_order: 1 }] })).status, 400);
  assert.equal((await d.c.post(`${d.base}/step/change`, { people: [{ id: id['ben.a@ed.example'], role: 'agent' }] })).status, 400, 'no chains of people changing it');
  // Allowed: Ben becomes Bo, and a copy for Cy is added.
  const subjectBefore = db.get('SELECT subject, message FROM envelopes WHERE id=?', e.id);
  ok(await d.c.post(`${d.base}/step/change`, { subject: 'Hacked', message: 'Pay here', people: [{ id: id['ben.a@ed.example'], name: 'Bo Ode', email: 'bo.a@ed.example' }, { name: 'Cy Copy', email: 'cy.a@ed.example', role: 'cc' }] }), 'change');
  assert.deepEqual(db.get('SELECT subject, message FROM envelopes WHERE id=?', e.id), subjectBefore, 'subject and message stay');
  assert.equal(db.get('SELECT status FROM recipients WHERE id=?', id['ana.a@ed.example']).status, 'completed', 'Ana stays signed: nothing she signed changed');
  const t = trail(e.id);
  const fixed = t.filter((a: any) => a.action === 'Envelope corrected').pop();
  assert.match(fixed.actor, /Ed Lawyer/);
  assert.ok(t.some((a: any) => a.action === 'Changed on their turn' && /Ed Lawyer/.test(a.detail) && /were not changed/.test(a.detail)));
  ok(await d.c.post(`${d.base}/step/finish`), 'finish');
  assert.equal(mailTo('bo.a@ed.example').length, 1, 'Bo is asked next');
  assert.equal(mailTo('ben.a@ed.example').filter((m: any) => /sign/i.test(m.subject)).length, 0, 'Ben was never asked');
});

test('can change the document: replacing a file someone signed asks them to sign again, only with resign, and says who changed it', async () => {
  const c = await person('Rosa Sender', 'rosa.ed2@ed.example');
  const e = await editorDeal(c, 'b');
  ok(await sign(e.id, 'ana.b@ed.example'), 'Ana signs');
  const d = await stepLink(e.id, 'ed.b@ed.example');
  // Another document of the account cannot be slipped in by its id.
  const other = await upload(c, 1);
  const doc = db.get('SELECT id FROM documents WHERE envelope_id=?', e.id).id;
  assert.equal((await d.c.post(`${d.base}/step/change`, { documents: [{ id: doc, file_id: other.id }] })).status, 400);
  // A file uploaded through his own link can.
  const f = new FormData();
  const { samplePdf } = await import('./helpers.ts');
  f.append('file', new Blob([await samplePdf(1)], { type: 'application/pdf' }), 'Contract v2.pdf');
  const up = await d.c.call('POST', `${d.base}/step/files`, f);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const again = await d.c.post(`${d.base}/step/change`, { documents: [{ id: doc, file_id: up.data.file.id }] });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'sign_again');
  assert.equal(db.get('SELECT status FROM recipients WHERE envelope_id=? AND email=?', e.id, 'ana.b@ed.example').status, 'completed', 'nothing saved without resign');
  ok(await d.c.post(`${d.base}/step/change`, { documents: [{ id: doc, file_id: up.data.file.id }], resign: true }), 'with resign');
  const ana = db.get('SELECT * FROM recipients WHERE envelope_id=? AND email=?', e.id, 'ana.b@ed.example');
  assert.equal(ana.status, 'sent', 'Ana is asked to sign again');
  const aside = trail(e.id).find((a: any) => a.action === 'Asked to sign again');
  assert.match(aside.detail, /Ed Lawyer <ed\.b@ed\.example> changed the envelope after that/);
  assert.match(mailTo('ana.b@ed.example').pop().subject, /.+/);
  // Ed waits again behind Ana, and gets his turn back after she signs again.
  assert.equal(db.get('SELECT status FROM recipients WHERE envelope_id=? AND email=?', e.id, 'ed.b@ed.example').status, 'pending');
  ok(await sign(e.id, 'ana.b@ed.example'), 'Ana signs again');
  const d2 = await stepLink(e.id, 'ed.b@ed.example');
  ok(await d2.c.post(`${d2.base}/step/finish`), 'Ed finishes');
  ok(await sign(e.id, 'ben.b@ed.example'), 'Ben signs');
  const env = (await import('../src/server/envelopes.ts'));
  const text = await pdfText(await env.buildPdf(env.loadEnvelope(e.id), true));
  assert.match(text, /Can change the document/);
  assert.match(text, /Changed on their turn/);
});

test('can change the document: a file someone before them has fields on cannot be taken off, only replaced', async () => {
  const c = await person('Rosa Sender', 'rosa.ed3@ed.example');
  const e = await editorDeal(c, 'c');
  ok(await sign(e.id, 'ana.c@ed.example'), 'Ana signs');
  const d = await stepLink(e.id, 'ed.c@ed.example');
  const f = new FormData();
  const { samplePdf } = await import('./helpers.ts');
  f.append('file', new Blob([await samplePdf(1)], { type: 'application/pdf' }), 'Extra.pdf');
  const up = ok(await d.c.call('POST', `${d.base}/step/files`, f), 'upload');
  const r = await d.c.post(`${d.base}/step/change`, { documents: [{ file_id: up.file.id }] });
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.data), /cannot be taken off/);
  // A signer cannot upload through their link.
  const a = await stepLink(e.id, 'ben.c@ed.example');
  assert.equal((await a.c.call('POST', `${a.base}/step/files`, f)).status, 403);
});

// ---- Templates, forms, Send to many ------------------------------------------------------------------------------

test('templates may have these roles; public forms and Send to many may not', async () => {
  const c = await person('Rosa Sender', 'rosa.tp@rt.example');
  const file = await upload(c, 1);
  const tpl = ok(await c.post('/envelopes', {
    kind: 'template', subject: 'Lease template', ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'agent', role: 'agent', role_name: 'Agent', name: '', email: '', routing_order: 1 },
      { id: 'owner', role: 'signer', role_name: 'Landowner', name: '', email: '', routing_order: 2 },
    ],
    fields: [sig('owner', 0.8)],
  }), 'template').envelope;
  const made = ok(await c.post('/envelopes', { template_id: tpl.id, recipients: { Agent: { name: 'Mia Chen', email: 'mia.tp@rt.example' } } }), 'use').envelope;
  ok(await c.post(`/envelopes/${made.id}/send`), 'send with the landowner left to Mia');
  const m = await stepLink(made.id, 'mia.tp@rt.example');
  const owner = db.get("SELECT id FROM recipients WHERE envelope_id=? AND role_name='Landowner'", made.id).id;
  ok(await m.c.post(`${m.base}/step/people`, { people: [{ id: owner, name: 'Paul Ade', email: 'paul.tp@rt.example' }] }), 'name');
  assert.ok(trail(made.id).some((a: any) => a.detail === 'Mia Chen named Paul Ade <paul.tp@rt.example> as the signer for Landowner.'));
  const form = await c.post('/powerforms', { template_id: tpl.id, name: 'Lease form' });
  assert.equal(form.status, 400);
  assert.match(JSON.stringify(form.data), /public form/);
  const bulk = await c.post('/bulk', { template_id: tpl.id, rows: [{ Agent: { name: 'A B', email: 'ab@rt.example' } }] });
  assert.equal(bulk.status, 400);
  assert.match(JSON.stringify(bulk.data), /Send to many/);
});

test('the API description lists the two roles and the step routes', async () => {
  const { openapi } = await import('../src/server/openapi.ts');
  const doc: any = openapi();
  for (const p of ['/sign/{token}/step', '/sign/{token}/step/people', '/sign/{token}/step/files', '/sign/{token}/step/change', '/sign/{token}/step/finish']) assert.ok(doc.paths[p], p);
  assert.match(JSON.stringify(doc), /Chooses who comes next/);
  assert.match(JSON.stringify(doc), /"editor"/);
  assert.ok(!/\u2014/.test(JSON.stringify(doc.paths['/sign/{token}/step/change'])));
});

test('the sender can still fill an open place with Correct, and the person who chooses then sees it filled', async () => {
  const c = await person('Rosa Sender', 'rosa.rt5@rt.example');
  const e = await chooserDeal(c, 'g');
  ok(await c.post(`/envelopes/${e.id}/send`), 'send');
  const land = db.get("SELECT * FROM recipients WHERE envelope_id=? AND role_name='Landowner'", e.id);
  ok(await c.post(`/envelopes/${e.id}/correct`, { recipient_id: land.id, name: 'Paula Owner', email: 'paula.g@rt.example' }), 'correct');
  ok(await sign(e.id, 'ana.g@rt.example'), 'Ana signs');
  const m = await stepLink(e.id, 'mia.g@rt.example');
  const view = ok(await m.c.get(`${m.base}/step`), 'view');
  assert.equal(view.open_left, 0);
  assert.equal(view.people[0].name, 'Paula Owner');
  ok(await m.c.post(`${m.base}/step/finish`), 'finish without changes');
  assert.ok(trail(e.id).some((a: any) => a.action === 'Finished their step' && /without changing anything/.test(a.detail)));
  assert.equal(mailTo('paula.g@rt.example').length, 1);
});

// ---- After the skeptic and the simplicity review ---------------------------------------------------------------------

test('a chooser with an "Only when" rule is refused at sending, and a place nobody filled is never counted as reminded', async () => {
  const c = await person('Rosa Sender', 'rosa.rt6@rt.example');
  const amount = { id: 'amount', document_id: 'd', recipient_id: 'ana', type: 'number', label: 'Amount', page: 0, x: 0.5, y: 0.1, w: 0.2, h: 0.03, required: false };
  const e = await chooserDeal(c, 'h', {
    recipients: [
      { id: 'ana', role: 'signer', name: 'Ana Asker', email: 'ana.h@rt.example', routing_order: 1 },
      { id: 'mia', role: 'agent', name: 'Mia Chen', email: 'mia.h@rt.example', routing_order: 2, only_when: { field: 'amount', is: 'more_than', value: '1000' } },
      { id: 'land', role: 'signer', role_name: 'Landowner', name: '', email: '', routing_order: 3 },
    ],
    fields: [sig('ana', 0.9), amount, sig('land', 0.8)],
  });
  const r = await c.post(`/envelopes/${e.id}/send`);
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /Mia Chen chooses who comes next, so they are always asked\. Take off their "Only when" rule/);
  assert.equal(stepRoleProblem([{ id: 'm', role: 'agent', name: 'Mia', routing_order: 1, only_when: '{"otherwise":"x"}' }, { id: 'b', role: 'signer', routing_order: 2 }], [], true)?.includes('Only when'), true, 'a stored rule as text too');
  // An envelope that went out before this rule existed: the open place reached with no address is not "reminded".
  const old = await chooserDeal(c, 'i');
  ok(await c.post(`/envelopes/${old.id}/send`), 'send');
  db.run("UPDATE recipients SET status='skipped' WHERE envelope_id=? AND role='agent'", old.id);
  db.run("UPDATE recipients SET status='completed' WHERE envelope_id=? AND email=?", old.id, 'ana.i@rt.example');
  db.run("UPDATE recipients SET status='sent' WHERE envelope_id=? AND role_name='Landowner'", old.id);
  db.run("UPDATE recipients SET status='pending' WHERE envelope_id=? AND email=?", old.id, 'ben.i@rt.example');
  const rem = ok(await c.post(`/envelopes/${old.id}/remind`, {}), 'remind');
  assert.equal(rem.reminded, 0);
  assert.deepEqual(rem.not_reminded.map((x: any) => x.why), ['not_named_yet']);
  // The envelope page says why in words (src/components/sender/MailNews.tsx remindedText).
  const news = (await import('node:fs')).readFileSync(new URL('../src/components/sender/MailNews.tsx', import.meta.url), 'utf8');
  assert.match(news, /k === 'not_named_yet' \? 'nobody is named there yet, so choose Correct to name them'/);
});

test('nobody passes on the power to change the document or to choose: later choosers and editors are locked', async () => {
  const c = await person('Rosa Sender', 'rosa.rt7@rt.example');
  const file = await upload(c, 1);
  const e = ok(await c.post('/envelopes', {
    subject: 'Chain', ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'mia', role: 'agent', name: 'Mia Chen', email: 'mia.j@rt.example', routing_order: 1 },
      { id: 'ed', role: 'editor', name: 'Ed Trusted', email: 'ed.j@rt.example', routing_order: 2 },
      { id: 'cy', role: 'cc', name: 'Cy Copy', email: 'cy.j@rt.example', routing_order: 3 },
      { id: 'ben', role: 'signer', name: 'Ben Ode', email: 'ben.j@rt.example', routing_order: 3 },
    ],
    fields: [sig('ben', 0.7)],
  }), 'draft').envelope;
  ok(await c.post(`/envelopes/${e.id}/send`), 'send');
  db.run('UPDATE users SET notify=? WHERE email=?', JSON.stringify({ signed: true }), 'rosa.rt7@rt.example');
  const id = ids(e.id);
  const m = await stepLink(e.id, 'mia.j@rt.example');
  const view = ok(await m.c.get(`${m.base}/step`), 'view');
  assert.match(view.people.find((p: any) => p.id === id['ed.j@rt.example']).why_not, /^Ed Trusted can change the document, and only Rosa Sender changes who that is\.$/);
  const p8 = await m.c.post(`${m.base}/step/people`, { people: [{ id: id['ed.j@rt.example'], name: 'Mallory', email: 'mal.j@evil.example' }] });
  assert.equal(p8.status, 409, JSON.stringify(p8.data));
  assert.equal(db.get('SELECT email FROM recipients WHERE id=?', id['ed.j@rt.example']).email, 'ed.j@rt.example');
  // A copy recipient the chooser changes is named in the sender's own email when she finishes, not only in the history.
  ok(await m.c.post(`${m.base}/step/people`, { people: [{ id: id['cy.j@rt.example'], name: 'Cy Other', email: 'cy2.j@rt.example' }] }), 'change the copy');
  ok(await m.c.post(`${m.base}/step/finish`), 'finish');
  const told = mailTo('rosa.rt7@rt.example').filter((x: any) => /Step finished/.test(x.subject)).pop();
  assert.match(told.html, /Mia Chen named Cy Other &lt;cy2\.j@rt\.example&gt;|Mia Chen named Cy Other <cy2\.j@rt\.example>/);
  assert.match(told.html, /in place of Cy Copy/);
  // An editor cannot hand the role on either: a later editor is kept as they are.
  const f2 = ok(await c.post('/envelopes', {
    subject: 'Two editors', ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'e1', role: 'editor', name: 'Ed One', email: 'e1.j@rt.example', routing_order: 1 },
      { id: 'e2', role: 'editor', name: 'Ed Two', email: 'e2.j@rt.example', routing_order: 2 },
      { id: 'ben', role: 'signer', name: 'Ben Ode', email: 'ben2.j@rt.example', routing_order: 3 },
    ],
    fields: [sig('ben', 0.7)],
  }), 'draft 2').envelope;
  ok(await c.post(`/envelopes/${f2.id}/send`), 'send 2');
  const i2 = ids(f2.id);
  const d = await stepLink(f2.id, 'e1.j@rt.example');
  const swap = await d.c.post(`${d.base}/step/change`, { people: [{ id: i2['e2.j@rt.example'], name: 'Mallory', email: 'mal2.j@evil.example' }, { id: i2['ben2.j@rt.example'] }] });
  assert.equal(swap.status, 409, JSON.stringify(swap.data));
  assert.match(swap.data.error, /Ed Two can change the document, and only Rosa Sender changes who that is/);
});

test('an editor\'s change: signers are told who changed it, the editor is not emailed about it, and their page says who signs first', async () => {
  const c = await person('Rosa Sender', 'rosa.ed4@ed.example');
  const e = await editorDeal(c, 'd');
  ok(await sign(e.id, 'ana.d@ed.example'), 'Ana signs');
  const d = await stepLink(e.id, 'ed.d@ed.example');
  const doc = db.get('SELECT id, name FROM documents WHERE envelope_id=?', e.id);
  const f = new FormData();
  const { samplePdf } = await import('./helpers.ts');
  f.append('file', new Blob([await samplePdf(1)], { type: 'application/pdf' }), 'Contract v2.pdf');
  const up = ok(await d.c.call('POST', `${d.base}/step/files`, f), 'upload');
  const edMailsBefore = mailTo('ed.d@ed.example').length;
  ok(await d.c.post(`${d.base}/step/change`, { documents: [{ id: doc.id, file_id: up.file.id }], resign: true }), 'replace with resign');
  // The document keeps its name: nobody asked for a rename.
  assert.equal(db.get('SELECT name FROM documents WHERE id=?', doc.id).name, doc.name);
  const again = mailTo('ana.d@ed.example').pop();
  assert.match(again.html, /Ed Lawyer changed this document after you/);
  assert.match(again.html, /After that, Ed Lawyer, who Rosa Sender asked to check it, changed the document/);
  assert.ok(!/Rosa Sender changed/.test(again.html), 'the sender is not blamed for the editor\'s change');
  assert.ok(!/renamed/i.test(again.html), 'no rename is reported');
  assert.equal(mailTo('ed.d@ed.example').length, edMailsBefore, 'the editor is not emailed "Not your turn yet" about their own change');
  // Ed's page says who signs first and why; Ana's page names Ed.
  const edPage = ok(await d.c.get(d.base), 'Ed page');
  assert.deepEqual(edPage.recipient.step_wait, { again: ['Ana Asker'] });
  const a = new Client();
  const anaPage = ok(await a.get(`/sign/${tokenFor(e.id, 'ana.d@ed.example')}`), 'Ana page');
  assert.equal(anaPage.recipient.changed_by, 'Ed Lawyer');
  // Her copy of what she signed says who changed it.
  const env = await import('../src/server/envelopes.ts');
  const copy = await env.earlierCopy(env.loadEnvelope(e.id), db.get('SELECT * FROM recipients WHERE envelope_id=? AND email=?', e.id, 'ana.d@ed.example'), false);
  assert.ok(copy, "a copy of what she signed was kept");
  assert.match((await pdfText(copy!)).replace(/\s+/g, ' '), /Ed Lawyer, who Rosa Sender asked to check it, changed the document/);
});

test('an editor cannot take off the last person after them, and is told in words for them', async () => {
  const c = await person('Rosa Sender', 'rosa.ed5@ed.example');
  const e = await editorDeal(c, 'e');
  ok(await sign(e.id, 'ana.e@ed.example'), 'Ana signs');
  const d = await stepLink(e.id, 'ed.e@ed.example');
  const r = await d.c.post(`${d.base}/step/change`, { people: [] });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, 'nobody_after');
  assert.equal(r.data.error, 'Someone has to sign after you, so Ben Ode cannot be taken off. Press Keep, or ask Rosa Sender in Questions and comments. Nothing was changed.');
  assert.ok(!/Ed Lawyer can change the document/.test(r.data.error), 'not the sender\'s message about them');
});

test('screens: the words the sender and the person on the link read', async () => {
  const { waitingSentence } = await import('../src/lib/envelopepage.ts');
  const { noAddressWords } = await import('../src/lib/editorux.ts');
  const { STEP_ROLE_LINE, stepLaterWords, changerWords } = await import('../src/lib/recipienttypes.ts');
  const { otherActions } = await import('../src/components/sign/actions.ts');
  const p = (o: any) => ({ id: 'm', name: 'Mia Chen', role: 'signer', status: 'sent', turn: true, ...o });
  assert.equal(waitingSentence([p({ role: 'agent' })] as any), 'Waiting for Mia Chen to choose who comes next.');
  assert.equal(waitingSentence([p({ role: 'editor', name: 'Ed Lawyer' })] as any), 'Waiting for Ed Lawyer to check the document.');
  assert.equal(noAddressWords({}, false, 'Yan Bo'), 'Yan Bo names this person on their turn.');
  assert.equal(noAddressWords({}, false), 'No email address yet. Add it in step 1.', 'unchanged without a chooser');
  for (const k of ['agent', 'editor'] as const) {
    assert.equal(STEP_ROLE_LINE[k].split(/\.\s/).length, 1, `one sentence for ${k}`);
    const acts = otherActions({ role: k }, { stage: 'sign', deadline: true, paper: true });
    assert.deepEqual(acts, ['later', 'time', 'ask', 'decline'], `${k} has the same way out as a signer, without paper`);
  }
  assert.match(stepLaterWords(false), /saved only when you press Finish/);
  assert.equal(changerWords(null, 'Rosa'), 'Rosa');
  for (const s of [STEP_ROLE_LINE.agent, STEP_ROLE_LINE.editor, stepLaterWords(true), changerWords('Ed', 'Rosa')]) assert.ok(!/—/.test(s));
  // The signing page shows Other actions on this screen, and the boxes take their direction from what is typed.
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../src/app/sign/[token]/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /stepFirst\(data, stage\)\)\s*return \(\s*<Shell data=\{data\} bar=\{other\}/);
  const nn = fs.readFileSync(new URL('../src/components/sign/NameNext.tsx', import.meta.url), 'utf8');
  assert.equal((nn.match(/<input value=\{p\.(name|email)\}[^>]*dir="auto"/g) || []).length, 2);
  assert.match(nn, /minHeight: 44, display: 'inline-flex'[^>]*href=\{`\$\{downloadUrl\}\?inline=1`\}/);
  assert.match(nn, /Check the email address for \$\{label\(m\)\}\. It should look like paul@example\.com\./);
});
