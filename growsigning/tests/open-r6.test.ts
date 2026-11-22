// Round 6: what the last repair rounds reported as not finished (research/continue.json). One test block per numbered item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, signUp, simple, draft, upload, tokenFor, mailTo, signAll, Client, PNG } from './helpers.ts';
import { englishIf } from './words.ts';

const srv = await boot();
// Screens moved into the catalogue are read with their English put back (lang-sender-rest, tests/words.ts).
const read = (p: string) => englishIf(p, fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8'));

test('1. every button, box and fold in every Settings section is at least 44 px tall, not only in .set-card', () => {
  const css = read('src/app/styles/settings.css');
  const rule = css.split('\n').find((l) => l.startsWith('.set-card .btn,')) || '';
  assert.match(rule, /min-height:\s*44px/);
  assert.match(rule, /\.set-card select/);
  assert.match(rule, /\.set-card input:not\(\[type='checkbox'\]\)/);
  // Team (service counter), Records and data (Close my account), Developers (keys, webhooks) and Plan (the code box)
  // are cards of their own, inside the one Settings panel.
  const all = css.split('\n').find((l) => l.startsWith('#set-panel .btn,')) || '';
  for (const part of ['#set-panel .btn', '#set-panel select', "#set-panel input:not([type='checkbox'])", '#set-panel details > summary']) assert.ok(all.includes(part), part);
  assert.match(all, /\{ min-height: 44px; \}$/, 'only a minimum: nothing is made smaller');
  assert.match(read('src/app/app/settings/page.tsx'), /<div id="set-panel" role="tabpanel"/);
});

let ipN = 0;
const person = (name: string, email: string) => signUp(name, email, `10.206.${++ipN}.9`);
const ok = (r: { status: number; data: any }, what = '') => {
  assert.equal(r.status, 200, `${what} ${JSON.stringify(r.data)}`);
  return r.data;
};

// Ana types an amount; Max is asked only when it is more than 1000, Olga otherwise.
async function routed(tag: string, over = '1000') {
  const s = await person('Rita Router', `rita.${tag}@r6.example`);
  const file = await upload(s, 1);
  const sig = (rid: string, y: number) => ({ document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y, w: 0.25, h: 0.05 });
  const e = ok(await s.post('/envelopes', {
    subject: `Purchase ${tag}`, ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'ana', role: 'signer', name: 'Ana Asker', email: `ana.${tag}@r6.example`, routing_order: 1 },
      { id: 'max', role: 'signer', name: 'Max Manager', email: `max.${tag}@r6.example`, routing_order: 2, only_when: { field: 'amount', is: 'more_than', value: over } },
      { id: 'olga', role: 'signer', name: 'Olga Officer', email: `olga.${tag}@r6.example`, routing_order: 2, only_when: { otherwise: 'max' } },
    ],
    fields: [sig('ana', 0.9), { id: 'amount', document_id: 'd', recipient_id: 'ana', type: 'number', label: 'Amount', page: 0, x: 0.5, y: 0.1, w: 0.2, h: 0.03, required: true }, sig('max', 0.8), sig('olga', 0.7)],
  }), 'draft').envelope;
  ok(await s.post(`/envelopes/${e.id}/send`), 'send');
  return { s, e, ana: `ana.${tag}@r6.example`, max: `max.${tag}@r6.example`, olga: `olga.${tag}@r6.example` };
}
async function finishAs(eid: string, email: string, amount: string) {
  const c = new Client();
  const tok = tokenFor(eid, email);
  ok(await c.post(`/sign/${tok}/consent`));
  const v = ok(await c.get(`/sign/${tok}`));
  const values: Record<string, string> = {};
  for (const f of v.fields) values[f.id] = f.label === 'Amount' ? amount : '1';
  return c.post(`/sign/${tok}/complete`, { values, signature_png: PNG, initials_png: PNG });
}

test('2. a number that reads two ways and would ask different people is asked again; a clear one or one that changes nothing is taken', async () => {
  const a = await routed('two');
  const r = await finishAs(a.e.id, a.ana, '1.200');
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'number_two_ways');
  // About the signer's answer only: nothing about who the sender's rule asks next (P7), and no repeated sentence.
  assert.equal(r.data.error, '"1.200" in Amount could mean 1200 or 1.2. Type the one you mean: 1200 or 1.2. Nothing was signed yet.');
  assert.doesNotMatch(r.data.error, /different people|next|\u2014/);
  assert.equal(r.data.field_id, srv.db.get("SELECT id FROM fields WHERE envelope_id=? AND label='Amount'", a.e.id).id, 'the page is told which field to open');
  assert.equal(srv.db.get('SELECT status FROM recipients WHERE envelope_id=? AND email=?', a.e.id, a.ana).status !== 'completed', true);
  assert.equal(srv.db.get('SELECT token FROM recipients WHERE envelope_id=? AND email=?', a.e.id, a.max).token == null || mailTo(a.max).length === 0, true, 'Max was not asked');
  // Typed plainly, it goes on, and Max is asked.
  ok(await finishAs(a.e.id, a.ana, '1200'), 'plain');
  assert.ok(mailTo(a.max).length > 0);
  assert.equal(mailTo(a.olga).length, 0);
  // "1.500,00" can be read only one way.
  const b = await routed('one');
  ok(await finishAs(b.e.id, b.ana, '1.500,00'), 'two marks');
  // "1.200" read as 1200 or as 1.2, against a rule of more than 10000: both readings ask Olga, so it is taken as it is.
  const { readNumber } = await import('../src/lib/logic.ts');
  assert.notEqual(readNumber('1.200', '.')!.value, readNumber('1.200', ',')!.value, 'it really reads two ways');
  const c = await routed('same', '10000');
  ok(await finishAs(c.e.id, c.ana, '1.200'), 'same people either way');
  assert.equal(mailTo(c.max).length, 0);
  assert.ok(mailTo(c.olga).length > 0);
  const d = await routed('far');
  assert.equal((await finishAs(d.e.id, d.ana, '5,000')).data.code, 'number_two_ways', 'a comma reads two ways too');
});

// Ana signs, Ed may change the document, Ben signs last.
async function editorDeal(tag: string) {
  const c = await person('Rosa Sender', `rosa.${tag}@r6.example`);
  const file = await upload(c, 1);
  const sig = (rid: string, y: number) => ({ document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y, w: 0.25, h: 0.05 });
  const e = ok(await c.post('/envelopes', {
    subject: `Contract ${tag}`, ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'ana', role: 'signer', name: 'Ana Asker', email: `ana.${tag}@r6.example`, routing_order: 1 },
      { id: 'ed', role: 'editor', name: 'Ed Lawyer', email: `ed.${tag}@r6.example`, routing_order: 2 },
      { id: 'ben', role: 'signer', name: 'Ben Ode', email: `ben.${tag}@r6.example`, routing_order: 3 },
    ],
    fields: [sig('ana', 0.9), sig('ben', 0.7)],
  }), 'draft').envelope;
  ok(await c.post(`/envelopes/${e.id}/send`), 'send');
  ok(await signAll(e.id, `ana.${tag}@r6.example`), 'Ana signs');
  const ed = new Client();
  const tok = tokenFor(e.id, `ed.${tag}@r6.example`);
  ok(await ed.post(`/sign/${tok}/consent`));
  return { c, e, ed, base: `/sign/${tok}`, ben: `ben.${tag}@r6.example` };
}
async function pdfWith(lines: string[]) {
  const { PDFDocument } = await import('pdf-lib');
  const d = await PDFDocument.create();
  const p = d.addPage([612, 792]);
  lines.forEach((l, i) => p.drawText(l, { x: 72, y: 700 - i * 20, size: 12 }));
  return d.save();
}
async function stepUpload(ed: Client, base: string, bytes: Uint8Array, name: string) {
  const f = new FormData();
  f.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
  return ok(await ed.call('POST', `${base}/step/files`, f), 'upload').file;
}

test('3. a file an editor brings in is read by the fake-notice filter; an ordinary one goes through', async () => {
  const a = await editorDeal('lure');
  const doc = srv.db.get('SELECT id FROM documents WHERE envelope_id=?', a.e.id).id;
  const bad = await stepUpload(a.ed, a.base, await pdfWith(['PayPal invoice', 'Your account was charged $499.99 for this order.', 'To cancel and get a refund call +1 (808) 555-0199 now.']), 'Contract v2.pdf');
  const r = await a.ed.post(`${a.base}/step/change`, { documents: [{ id: doc, file_id: bad.id }], resign: true });
  assert.equal(r.status, 422, JSON.stringify(r.data));
  assert.equal(r.data.code, 'reads_like_scam');
  assert.match(r.data.error, /PayPal/);
  assert.match(r.data.error, /Nothing was changed\. If the file is genuine, ask Rosa Sender to add it\./);
  assert.equal(srv.db.get('SELECT file_id FROM documents WHERE id=?', doc).file_id !== bad.id, true, 'the document is unchanged');
  // An ordinary revised contract is taken.
  const fine = await stepUpload(a.ed, a.base, await pdfWith(['Contract, second version', 'The price is 499 dollars. Questions: call 808 555 0199.']), 'Contract v2.pdf');
  ok(await a.ed.post(`${a.base}/step/change`, { documents: [{ id: doc, file_id: fine.id }], resign: true }), 'ordinary file');
});

test('4. the "updated" and "again" emails name the editor who changed it, in our words and in requestMail', async () => {
  const { requestMail } = await import('../src/server/requestmail.ts');
  const base = { role: 'signer', name: 'Ben Ode', sender: { name: 'Rosa Sender', email: 'r@x.example' }, subject: 'Contract', accessCode: false, shared: false, done: false, complete: false, deadline: '', zoneKnown: false, ready: false, trees: 0, url: 'http://x' };
  const up = requestMail('en', { ...base, kind: 'updated', changer: 'Ed Lawyer' } as any);
  assert.ok(up.lines.some((l: string) => l === 'Ed Lawyer, who Rosa Sender asked to check it, changed this document. Please look at it again before you sign.'), up.lines.join('|'));
  const plain = requestMail('en', { ...base, kind: 'updated' } as any);
  assert.ok(plain.lines.some((l: string) => /^Rosa Sender changed this document after sending it\./.test(l)));
  const again = requestMail('en', { ...base, kind: 'again', changer: 'Ed Lawyer', before: '2026-11-01T10:00:00.000Z' } as any);
  assert.match(again.heading, /^Ed Lawyer changed this document after you signed it/);
  assert.ok(again.lines.some((l: string) => /After that, Ed Lawyer, who Rosa Sender asked to check it, changed the document/.test(l)));

  // On a real envelope: Ben signs at the same step as Ed and is told Ed changed it, not Rosa.
  const c = await person('Rosa Sender', 'rosa.upd@r6.example');
  const file = await upload(c, 1);
  const sig = (rid: string, y: number) => ({ document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y, w: 0.25, h: 0.05 });
  const e = ok(await c.post('/envelopes', {
    subject: 'Contract upd', ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'ed', role: 'editor', name: 'Ed Lawyer', email: 'ed.upd@r6.example', routing_order: 1 },
      { id: 'ben', role: 'signer', name: 'Ben Ode', email: 'ben.upd@r6.example', routing_order: 1 },
      { id: 'cy', role: 'signer', name: 'Cy Later', email: 'cy.upd@r6.example', routing_order: 2 },
    ],
    fields: [sig('ben', 0.9), sig('cy', 0.7)],
  }), 'draft').envelope;
  ok(await c.post(`/envelopes/${e.id}/send`), 'send');
  const ed = new Client();
  const tok = tokenFor(e.id, 'ed.upd@r6.example');
  ok(await ed.post(`/sign/${tok}/consent`));
  const doc = srv.db.get('SELECT id FROM documents WHERE envelope_id=?', e.id).id;
  const fine = await stepUpload(ed, `/sign/${tok}`, await pdfWith(['Contract, second version']), 'Contract v2.pdf');
  const before = mailTo('ben.upd@r6.example').length;
  ok(await ed.post(`/sign/${tok}/step/change`, { documents: [{ id: doc, file_id: fine.id }], resign: true }), 'change');
  const news = mailTo('ben.upd@r6.example').slice(before);
  assert.ok(news.length >= 1, 'Ben is told');
  const last = news.pop();
  assert.match(last.html, /Ed Lawyer, who Rosa Sender asked to check it, changed this document/);
  assert.doesNotMatch(last.html, /Rosa Sender changed this document after sending it/);
});

test('5. the sender sees who was shown which files; no WhatsApp message goes, even with the dev outbox set', async () => {
  // This used to check that a WhatsApp message never names a file the person was not shown. The owner decided no
  // account gets WhatsApp, so it now checks that none is sent at all, with WHATSAPP_DEV_OUTBOX=1 set.
  const saved = { a: process.env.WHATSAPP_DEV_OUTBOX };
  process.env.WHATSAPP_DEV_OUTBOX = '1';
  try {
    const c = await person('Vera Vis', 'vera.vis@r6.example');
    srv.db.run("UPDATE accounts SET trusted_at=? WHERE id=(SELECT m.account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?)", new Date().toISOString(), 'vera.vis@r6.example');
    const contract = await upload(c, 1);
    const salary = await upload(c, 1);
    const sig = (doc: string, rid: string) => ({ document_id: doc, recipient_id: rid, type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 });
    const body = (wa: boolean) => ({
      subject: 'Salary sheet 2027', own_docs: true,
      documents: [{ id: 'dc', file_id: contract.id, name: 'Employment contract' }, { id: 'ds', file_id: salary.id, name: 'Salary sheet 2027' }],
      recipients: [
        { id: 'emma', role: 'signer', name: 'Emma Worker', email: 'emma.vis@r6.example', phone: '+44 7700 900124', ...(wa ? { whatsapp: true, whatsapp_agreed: true } : {}) },
        { id: 'hugo', role: 'signer', name: 'Hugo Payroll', email: 'hugo.vis@r6.example' },
      ],
      fields: [sig('dc', 'emma'), sig('ds', 'hugo')],
    });
    const refused = await c.post('/envelopes', body(true));
    assert.equal(refused.status, 400);
    assert.equal(refused.data.code, 'whatsapp_off');
    const e = ok(await c.post('/envelopes', body(false)), 'draft').envelope;
    ok(await c.post(`/envelopes/${e.id}/send`), 'send');
    const g = ok(await c.get(`/envelopes/${e.id}`)).envelope;
    assert.deepEqual(g.limited_people.map((p: any) => `${p.name}: ${p.sees.join(', ')}`).sort(), ['Emma Worker: Employment contract', 'Hugo Payroll: Salary sheet 2027']);
    ok(await signAll(e.id, 'emma.vis@r6.example'));
    ok(await signAll(e.id, 'hugo.vis@r6.example'));
    assert.equal(srv.db.get('SELECT COUNT(*) n FROM wa_messages WHERE envelope_id=?', e.id).n, 0, 'no WhatsApp message was written');
    // Without own_docs there is nobody to list.
    const plain = await simple(c, 'pat.vis@r6.example');
    assert.deepEqual(ok(await c.get(`/envelopes/${plain.id}`)).envelope.limited_people, []);
  } finally {
    saved.a === undefined ? delete process.env.WHATSAPP_DEV_OUTBOX : (process.env.WHATSAPP_DEV_OUTBOX = saved.a);
  }
});

test('6. a delegation never reaches a witness request or a public form, sent end to end', async () => {
  const day = (o: number) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
  const owner = await person('Olivia Dlg', 'olivia.dlg@r6.example');
  ok(await owner.post('/account/invites', { email: 'ana.dlg@r6.example', role: 'member' }));
  const ana = new Client();
  ana.ip = `10.206.${++ipN}.9`;
  ok(await ana.post('/auth/signup', { name: 'Ana Silva', email: 'ana.dlg@r6.example', password: 'correct horse battery', invite: srv.db.get('SELECT token FROM invites WHERE email=?', 'ana.dlg@r6.example').token }));
  const u = srv.db.get('SELECT * FROM users WHERE email=?', 'ana.dlg@r6.example');
  if (!u.email_verified) ok(await ana.post('/auth/verify', { token: u.verify_token }));
  ok(await owner.put('/account/delegation', { on: true }));
  ok(await ana.put('/me/delegate', { name: 'Bob Reyes', email: 'bob.dlg@r6.example', starts_on: day(0), ends_on: day(4) }));
  const toBob = () => mailTo('bob.dlg@r6.example').length;
  // A plain request to Ana does go to Bob too (the gate is open).
  const file = await upload(owner, 1);
  const plain = ok(await owner.post('/envelopes', { subject: 'Plain', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Ana Silva', email: 'ana.dlg@r6.example' }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }], send: true })).envelope;
  if (plain.status === 'draft') ok(await owner.post(`/envelopes/${plain.id}/send`));
  assert.equal(srv.db.all('SELECT * FROM delegate_links WHERE envelope_id=?', plain.id).length, 1, 'the delegation is active');
  // Ana as a witness: asked after Sam signs, and never handed to Bob.
  const before = toBob();
  const deedFile = await upload(owner, 1);
  const block = (rid: string, y = 0.6) => [
    { document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y, w: 0.22, h: 0.05, label: 'Witness signature' },
    { document_id: 'd', recipient_id: rid, type: 'full_name', page: 0, x: 0.1, y: y + 0.06, w: 0.3, h: 0.024, label: 'Witness name' },
    { document_id: 'd', recipient_id: rid, type: 'text', page: 0, x: 0.1, y: y + 0.09, w: 0.4, h: 0.045, label: 'Witness address' },
    { document_id: 'd', recipient_id: rid, type: 'text', page: 0, x: 0.1, y: y + 0.145, w: 0.3, h: 0.024, label: 'Witness occupation' },
    { document_id: 'd', recipient_id: rid, type: 'date_signed', page: 0, x: 0.5, y, w: 0.16, h: 0.024, label: 'Date witnessed' },
  ];
  const deed = ok(await owner.post('/envelopes', {
    subject: 'Deed', documents: [{ id: 'd', file_id: deedFile.id, name: 'Deed' }],
    recipients: [{ id: 'sam', role: 'signer', name: 'Sam Signer', email: 'sam.dlg@r6.example' }, { id: 'w', role: 'witness', witness_for: 'sam', name: 'Ana Silva', email: 'ana.dlg@r6.example' }],
    fields: [{ document_id: 'd', recipient_id: 'sam', type: 'signature', page: 0, x: 0.1, y: 0.3, w: 0.25, h: 0.06 }, ...block('w')],
  }), 'deed').envelope;
  ok(await owner.post(`/envelopes/${deed.id}/send`), 'send deed');
  ok(await signAll(deed.id, 'sam.dlg@r6.example'), 'Sam signs');
  assert.ok(mailTo('ana.dlg@r6.example').some((m: any) => /Deed/.test(m.subject)), 'Ana is asked to witness');
  assert.equal(srv.db.all('SELECT * FROM delegate_links WHERE envelope_id=?', deed.id).length, 0, 'no delegate link for a witness');
  assert.equal(toBob(), before, 'Bob is not emailed about the witness request');
  // A public form that a visitor fills in with Ana's address goes to that visitor only.
  const tpl = await simple(owner, '', { kind: 'template', subject: 'Visitor form', recipients: [{ id: 'r', role: 'signer', role_name: 'Visitor' }] });
  ok(await owner.post('/powerforms', { template_id: tpl.id, name: 'Visitor form' }), 'form');
  const slug = ok(await owner.get('/powerforms')).powerforms[0].slug;
  const v = new Client();
  v.ip = `10.206.${++ipN}.9`;
  const start = await v.post(`/public/powerforms/${slug}/start`, { name: 'Ana Silva', email: 'ana.dlg@r6.example' });
  assert.ok(start.status === 200, JSON.stringify(start.data));
  const made = srv.db.get('SELECT id FROM envelopes WHERE powerform_id IS NOT NULL ORDER BY created_at DESC LIMIT 1');
  assert.ok(made, 'the form made an envelope');
  assert.equal(srv.db.all('SELECT * FROM delegate_links WHERE envelope_id=?', made.id).length, 0, 'no delegate link on a public form');
  assert.equal(toBob(), before, 'Bob is not emailed about the public form');
});

test('7. someone who finished while the others still sign is not shown the summary, is told why, and gets no record line', async () => {
  const lib = await import('../src/lib/aiassist.ts');
  const c = await person('Sia Summary', 'sia.sum@r6.example');
  const file = await upload(c, 1);
  const sig = (rid: string, y: number) => ({ document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y, w: 0.25, h: 0.05 });
  const e = ok(await c.post('/envelopes', { subject: 'Lease', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'a', role: 'signer', name: 'Al One', email: 'al.sum@r6.example' }, { id: 'b', role: 'signer', name: 'Bea Two', email: 'bea.sum@r6.example' }], fields: [sig('a', 0.9), sig('b', 0.7)] })).envelope;
  ok(await c.post(`/envelopes/${e.id}/send`));
  ok(await signAll(e.id, 'al.sum@r6.example'));
  assert.equal(srv.db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'sent', 'Bea still has it');
  const before = srv.db.all('SELECT 1 FROM audit WHERE envelope_id=?', e.id).length;
  const r = await new Client().post(`/sign/${tokenFor(e.id, 'al.sum@r6.example')}/summary`);
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'finished');
  assert.equal(r.data.error, lib.SUMMARY_AFTER_YOU);
  assert.doesNotMatch(lib.SUMMARY_AFTER_YOU, /—/);
  // Approvers and people who only had to open it finish too, and they signed nothing.
  assert.doesNotMatch(lib.SUMMARY_AFTER_YOU, /signed/);
  assert.equal(srv.db.all('SELECT 1 FROM audit WHERE envelope_id=?', e.id).length, before, 'no line after the signature');
});

test('8. a time on a screen is said in the viewer\'s zone and their way of writing it, the way the time box shows it', async () => {
  const { atWordsHere, atWords } = await import('../src/lib/timing.ts');
  const at = '2027-03-04T02:30:00.000Z';
  // The month first where the viewer writes it first, and the hour with its zero where their time box shows one.
  assert.equal(atWordsHere(at, 'en-US', 'America/New_York'), '9:30 PM on March 3, 2027');
  assert.equal(atWordsHere(at, 'en-GB', 'Europe/London'), '02:30 on 4 March 2027');
  assert.equal(atWordsHere(at, 'en-GB', 'America/New_York'), '21:30 on 3 March 2027');
  assert.equal(atWordsHere('not a date'), '');
  assert.equal(atWordsHere(null), '');
  // The server's words (emails, the record) are unchanged.
  assert.equal(atWords(at, 'UTC'), '2:30 on 4 March 2027');
  for (const f of ['src/components/editor/SendLater.tsx', 'src/components/sender/Timing.tsx', 'src/components/Editor.tsx']) assert.doesNotMatch(read(f), /\batWords\(/, `${f} uses the screen words`);
  // The Send button, the Documents row, Home and the envelope page's "goes out" lines say the same time as the box.
  const L = await import('../src/lib/timing.ts');
  const here = atWordsHere(at);
  assert.equal(L.sendAtLabel(at), `Send at ${here}`);
  assert.equal(L.timingRow({ status: 'draft', send_at: at }), `Sends at ${here}`);
  assert.equal(L.goesOutWords(at), `soon after ${here}`);
  assert.ok(L.scheduledHome(1, at).endsWith(`soon after ${here}.`), L.scheduledHome(1, at));
  assert.equal(L.sendAtLabel(at, 'America/New_York'), `Send at ${atWordsHere(at, undefined, 'America/New_York')}`, 'a zone given is the zone used');
  const lib = read('src/lib/timing.ts');
  for (const fn of ['export const sendAtLabel', 'export const goesOutWords', 'export function timingRow', 'export const scheduledHome', 'export function pendingWhen']) {
    const from = lib.indexOf(fn);
    assert.ok(from > 0, fn);
    assert.doesNotMatch(lib.slice(from, lib.indexOf('\n\n', from)), /\batWords\(/, `${fn} says screen words`);
  }
});

test('9. the certificate keeps who a colleague sent it for, after it is moved to someone else', async () => {
  const owner = await person('Olive Owner', 'olive.mv@r6.example');
  const join = async (name: string, email: string) => {
    ok(await owner.post('/account/invites', { email, role: 'member' }));
    const c = Object.assign(new Client(), { ip: `10.206.${++ipN}.9` });
    ok(await c.post('/auth/signup', { name, email, password: 'correct horse battery', invite: srv.db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL', email).token }));
    return c;
  };
  const ben = await join('Ben Okoro', 'ben.mv@r6.example');
  const ana = await join('Ana Silva', 'ana.mv@r6.example');
  const carl = await join('Carl Other', 'carl.mv@r6.example');
  const id = async (c: Client) => (await c.get('/me')).data.user.id as string;
  const [benId, carlId] = [await id(ben), await id(carl)];
  ok(await ben.post('/me/shares', { grantee: await id(ana), level: 'send' }));
  const file = await upload(ana, 1);
  const made = ok(await ana.post('/envelopes', { subject: 'Depot lease', on_behalf_of: benId, send: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Rita Renter', email: 'rita.mv@r6.example' }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).envelope;
  assert.equal(srv.db.get('SELECT sent_for_id FROM envelopes WHERE id=?', made.id).sent_for_id, benId);
  ok(await owner.post(`/envelopes/${made.id}/move`, { to: carlId }), 'moved to Carl');
  ok(await signAll(made.id, 'rita.mv@r6.example'));
  const pdf = await carl.get(`/envelopes/${made.id}/download`);
  assert.equal(pdf.status, 200);
  const { extractPages } = await import('../src/server/text.ts');
  const text = (await extractPages(pdf.data)).join('\n').replace(/\s+/g, ' ');
  assert.match(text, /Ana Silva <ana\.mv@r6\.example>, for Ben Okoro/);
  assert.doesNotMatch(text, /, for Carl Other/);
  // Sent by the person it belongs to: no "for" at all, and nothing kept.
  const own = await simple(ben, 'sam.mv@r6.example', { send: true });
  assert.equal(srv.db.get('SELECT sent_for_id FROM envelopes WHERE id=?', own.id).sent_for_id, null);
});

test('10. a colleague whose share cannot copy a link is not told to send the link themselves', async () => {
  const { shareAllows } = await import('../src/lib/shares.ts');
  for (const level of ['see', 'manage', 'send'] as const) assert.equal(shareAllows(level, 'links'), false, `${level} gives no signing link`);
  const hint = read('src/components/sender/MailNews.tsx');
  assert.match(hint, /export function MailStopHint\(\{ r, links = true \}/);
  assert.match(hint, /\{links \? ' You can also send them the link yourself\.' : own\}/);
  assert.match(hint, /\{links \? ' You can still send them their link yourself\.' : own\}/);
  assert.match(read('src/components/sender/Recipients.tsx'), /<MailStopHint r=\{r\} links=\{may\('links'\)\} \/>/);
});

test('11. "Move to a colleague" is offered by the same permission the server checks, also for a custom role', async () => {
  const { mayMove } = await import('../src/lib/shares.ts');
  const me = (can: string[] | null, id = 'u1', members = 3, role = 'member') => ({ members, role, user: { id }, ...(can ? { my_role: { can } } : {}) });
  const tpl = { kind: 'template', sender_id: 'u2' }, env = { kind: 'envelope', sender_id: 'u2' };
  assert.equal(mayMove(me(['edit_any_template']), tpl), true, 'a custom role that may change every template');
  assert.equal(mayMove(me(['edit_any_template']), env), false, 'but not someone else\'s envelope');
  assert.equal(mayMove(me(['see_all']), env), true);
  assert.equal(mayMove(me([], 'u1', 3, 'admin'), tpl), false, 'a role named admin without the permission is not enough');
  assert.equal(mayMove(me([]), { kind: 'template', sender_id: 'u1' }), true, 'your own');
  assert.equal(mayMove(me(['edit_any_template', 'see_all'], 'u1', 1), tpl), false, 'nobody to move it to');
  assert.equal(mayMove(me(null, 'u1', 3, 'owner'), tpl), true, 'an older /me without my_role falls back to the role');
  // The owner's /me carries both permissions, and a plain member's neither.
  const o = await person('Mo Owner', 'mo.move@r6.example');
  const can = (await o.get('/me')).data.my_role.can;
  assert.ok(can.includes('edit_any_template') && can.includes('see_all'), JSON.stringify(can));
  assert.match(read('src/app/app/templates/page.tsx'), /const mayHand = \(t: any\) => mayMove\(me, \{ kind: 'template', sender_id: t\.sender_id \}\);/);
  assert.match(read('src/components/sender/Colleagues.tsx'), /mayMove\(me, e\)/);
});

test('12. a localhost website listed before the rule never shows, counts or frames a page on a live server', async () => {
  const c = await person('Lou Local', 'lou.local@r6.example');
  const acct = srv.db.get("SELECT m.account_id id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='lou.local@r6.example'").id;
  ok(await c.post('/account/embed-origins', { origin: 'https://shop.example.com' }));
  // Written straight to the database, the way an older server or a copied database left it.
  srv.db.run('INSERT INTO embed_origins (account_id, origin, added_by, added_at) VALUES (?,?,?,?)', acct, 'http://localhost:3000', 'Lou Local', new Date().toISOString());
  assert.deepEqual(ok(await c.get('/account/embed-origins')).origins, ['https://shop.example.com']);
  const e = await simple(c, 'sid.local@r6.example', { send: true });
  const r = await c.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: e.recipients[0].id, frame_origin: 'http://localhost:3000' });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.equal(r.data.code, 'origin_not_listed');
  const { frameAncestors } = await import('../src/server/embed.ts');
  const tok = tokenFor(e.id, 'sid.local@r6.example');
  srv.db.run('INSERT OR IGNORE INTO embed_views (recipient_id, origin, at) VALUES (?,?,?)', e.recipients[0].id, 'http://localhost:3000', new Date().toISOString());
  assert.equal(frameAncestors(`/sign/${tok}`, new URLSearchParams({ embed: '1', origin: 'http://localhost:3000' })), "frame-ancestors 'self'");
  // The listed https website still works. The hidden row is shown apart, as doing nothing here, so it can be removed.
  ok(await c.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: e.recipients[0].id, frame_origin: 'https://shop.example.com' }), 'https');
  assert.deepEqual(ok(await c.get('/account/embed-origins')).not_used, ['http://localhost:3000']);
  const src = read('src/components/settings/EmbedSites.tsx') + read('src/locales/en.json'); // words moved to the language file
  assert.match(src, /setUnused\(r\.not_used \|\| \[\]\)/);
  assert.match(src, /does nothing on this server, because it is on your own computer\./);
  const after = ok(await c.call('DELETE', `/account/embed-origins?origin=${encodeURIComponent('http://localhost:3000')}`));
  assert.deepEqual(after.not_used, []);
  assert.deepEqual(after.origins, ['https://shop.example.com']);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM embed_origins WHERE account_id=? AND origin=?', acct, 'http://localhost:3000').n, 0);
});

test('13. the help chat says the daily limits only where they apply, and says a deployment server charges nothing', async () => {
  const { systemPrompt } = await import('../src/server/chatkb.ts');
  const consumer = systemPrompt('public', {});
  assert.match(consumer, /An account that has not paid can newly email \d+ people a day/);
  assert.doesNotMatch(consumer, /provided under an agreement/);
  const deployed = systemPrompt('public', { BILLING_MODE: 'deployment' });
  assert.doesNotMatch(deployed, /An account that has not paid can newly email/);
  assert.doesNotMatch(deployed, /A team can invite \d+ people a day/);
  assert.match(deployed, /no daily limit on how many people an account emails and no limit on team invitations/);
  assert.match(deployed, /different recipients report one account, its sending is paused/);
  assert.match(deployed, /nothing is counted or charged on it/);
  assert.doesNotMatch(deployed, /—/);
});

test('14. a file to read that must be acknowledged carries its own tag beside its button until it is ticked, also once opened', () => {
  const en = JSON.parse(read('src/locales/en.json'));
  assert.equal(en['sign.supplements.must_tick_tag'], 'Tick below that you were given it');
  const src = read('src/components/sign/Supplements.tsx');
  // Its own expression, not the last branch after "Opened": opening the file does not take the tag away.
  assert.match(src, /\n\s*\{s\.rule === 'acknowledge' && canTick && !s\.acknowledged \? <span className="muted small" aria-hidden="true">\{T\('sign\.supplements\.must_tick_tag'\)\}<\/span> : null\}/);
  assert.doesNotMatch(src, /:\s*s\.rule === 'acknowledge' && canTick && !s\.acknowledged \?/);
});

test('15. a colleague a document is shared with finds it by the words inside it, also when those words are kept encrypted', async () => {
  const owner = await person('Olive Seal', 'olive.seal@r6.example');
  const join = async (name: string, email: string) => {
    ok(await owner.post('/account/invites', { email, role: 'member' }));
    const c = Object.assign(new Client(), { ip: `10.206.${++ipN}.9` });
    ok(await c.post('/auth/signup', { name, email, password: 'correct horse battery', invite: srv.db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL', email).token }));
    return c;
  };
  const ben = await join('Ben Seal', 'ben.seal@r6.example');
  const ana = await join('Ana Seal', 'ana.seal@r6.example');
  const carl = await join('Carl Seal', 'carl.seal@r6.example');
  ok(await ben.post('/me/shares', { grantee: (await ana.get('/me')).data.user.id, level: 'see' }));
  const e = await simple(ben, 'sam.seal@r6.example', { subject: 'Depot', send: true });
  const fileId = srv.db.get('SELECT file_id FROM documents WHERE envelope_id=?', e.id).file_id;
  const saved = process.env.FILE_ENCRYPTION_KEY;
  process.env.FILE_ENCRYPTION_KEY = (await import('node:crypto')).randomBytes(32).toString('base64');
  try {
    const { sealText } = await import('../src/server/searchtext.ts');
    const { keys } = await import('../src/server/filestore.ts');
    srv.db.run('UPDATE files SET text=NULL, text_sealed=?, text_key=? WHERE id=?', sealText('Lease of the mangrove nursery', fileId, keys().current!), keys().current!.id, fileId);
    const found = (c: Client) => c.get('/envelopes?q=mangrove').then((r) => (r.data.envelopes || []).map((x: any) => x.id));
    assert.ok((await found(ben)).includes(e.id), 'Ben finds his own');
    assert.ok((await found(ana)).includes(e.id), 'Ana finds the shared one by its words');
    assert.ok(!(await found(carl)).includes(e.id), 'Carl, with no share, does not');
  } finally {
    saved === undefined ? delete process.env.FILE_ENCRYPTION_KEY : (process.env.FILE_ENCRYPTION_KEY = saved);
  }
});

test('16. a scanned file an editor brings in is not taken while its pictures are still being read, and is read once they are', async () => {
  const a = await editorDeal('scan');
  const doc = srv.db.get('SELECT id FROM documents WHERE envelope_id=?', a.e.id).id;
  // A page with no words, the way a scan arrives: the server reads it in the background when OCR is set up.
  const scan = await stepUpload(a.ed, a.base, await pdfWith([]), 'Contract v2.pdf');
  srv.db.run("INSERT OR REPLACE INTO ocr_jobs (file_id, state, pages, created_at) VALUES (?, 'queued', '[1]', ?)", scan.id, new Date().toISOString());
  const wait = await a.ed.post(`${a.base}/step/change`, { documents: [{ id: doc, file_id: scan.id }], resign: true });
  assert.equal(wait.status, 409, JSON.stringify(wait.data));
  assert.equal(wait.data.code, 'still_reading');
  assert.match(wait.data.error, /Try again in a minute or two\. Nothing was changed\./);
  assert.notEqual(srv.db.get('SELECT file_id FROM documents WHERE id=?', doc).file_id, scan.id);
  // Read: the words of a fake PayPal notice are now in the file's text, and the filter refuses it.
  srv.db.run("UPDATE ocr_jobs SET state='done' WHERE file_id=?", scan.id);
  srv.db.run('UPDATE files SET text=?, text_sealed=NULL WHERE id=?', 'PayPal invoice. Your account was charged $499.99. To cancel and get a refund call +1 (808) 555-0199 now.', scan.id);
  const r = await a.ed.post(`${a.base}/step/change`, { documents: [{ id: doc, file_id: scan.id }], resign: true });
  assert.equal(r.status, 422, JSON.stringify(r.data));
  assert.equal(r.data.code, 'reads_like_scam');
  // A reading that failed is not a reason to hold an honest editor forever: the file is taken as it is.
  const other = await stepUpload(a.ed, a.base, await pdfWith([]), 'Contract v3.pdf');
  srv.db.run("INSERT OR REPLACE INTO ocr_jobs (file_id, state, pages, created_at) VALUES (?, 'failed', '[1]', ?)", other.id, new Date().toISOString());
  ok(await a.ed.post(`${a.base}/step/change`, { documents: [{ id: doc, file_id: other.id }], resign: true }), 'failed reading');
});

test('17. the Settings section for keys and webhooks is called Developers, as the charter names it, and every message says so', () => {
  const nav = read('src/lib/settingsnav.ts');
  assert.match(nav, /\{ key: 'developers', label: 'Developers' \}/);
  assert.match(read('research/ux-charter.md'), /\| Developers \| admins \| API keys, webhooks/);
  for (const f of ['src/server/auth.ts', 'src/server/router.ts', 'src/server/embed.ts', 'src/server/webhooks.ts', 'src/server/importer.ts', 'src/server/seclog.ts', 'src/server/routes-trust.ts', 'src/server/routes-clickwrap.ts', 'src/server/openapi.ts', 'src/server/chatscreens.ts', 'src/lib/policy.ts', 'src/app/developers/page.tsx', 'src/app/app/settings/page.tsx', 'src/app/app/agreements/[id]/page.tsx', 'src/components/settings/EmbedSites.tsx'])
    assert.doesNotMatch(read(f), /Settings, (then )?API and webhooks|API and webhooks tab|and API and webhooks\./, f);
});

test('18. the sender reads who sees which files, that everyone else sees every file, and never "sees only: no file"', async () => {
  const { seesLine, SEES_REST } = await import('../src/lib/owndocs.ts');
  assert.equal(seesLine({ name: 'Emma Worker', sees: ['Employment contract'] }), 'Emma Worker sees only: Employment contract');
  assert.equal(seesLine({ name: 'Hugo Payroll', sees: [] }), 'Hugo Payroll is shown no file.');
  assert.equal(SEES_REST, 'Everyone else sees every file.');
  const page = read('src/app/app/envelopes/[id]/page.tsx');
  assert.match(page, /\{seesLine\(p\)\}/);
  // The "everyone else" line only when someone on the document is not in the list.
  assert.match(page, /\(e\.recipients \|\| \[\]\)\.some\(\(r: any\) => !e\.limited_people\.some\(\(p: any\) => p\.id === r\.id\)\) && <p[^>]*>\{SEES_REST\}<\/p>/);
  assert.doesNotMatch(page, /'no file'/);
});

test('19. the signing page shows a two-ways number under its own field, opens that field, and keeps it there until it is retyped', async () => {
  const { twoWaysUnderField, twoWaysWords } = await import('../src/lib/twoways.ts');
  const said = twoWaysWords('1.200', 'Amount', 1200, 1.2);
  assert.equal(twoWaysUnderField(said), '"1.200" in Amount could mean 1200 or 1.2. Type the one you mean: 1200 or 1.2.');
  const page = read('src/app/sign/[token]/page.tsx');
  assert.match(page, /e\?\.code === 'number_two_ways' && fields\.some\(\(f: any\) => f\.id === e\?\.data\?\.field_id\)/);
  assert.match(page, /afterClose\.current = f;\n\s*setOpen\(''\);/, 'review closes and the field is gone to');
  assert.match(page, /const again = askAgain && askAgain\.id === f\.id && askAgain\.value === value \? askAgain\.text : '';/, 'gone once the answer changes');
  assert.match(page, /'aria-invalid': wrong \|\| !!again/);
  assert.match(page, /again && `f-\$\{f\.id\}-again`/);
  assert.match(page, /<span id=\{`f-\$\{f\.id\}-again`\} className="sg-doc-again" role="alert">\{again\}<\/span>/);
  assert.match(page, /<FieldSheet [^\n]*again=\{askAgain && askAgain\.id === sheetField\.id/);
  assert.match(read('src/components/sign/dialogs.tsx'), /const problem = problemWith\(field, value, dateFormat\) \|\| again \|\| '';/);
  assert.match(read('src/app/styles/sign.css'), /\.sg-doc \.field \.sg-doc-again \{ display: block;/);
});
