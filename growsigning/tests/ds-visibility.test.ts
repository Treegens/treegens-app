// "Each person sees only their files" (research/docusign-gaps.json, batch "visibility"): src/lib/owndocs.ts (the rule
// and the words) and src/server/visibility.ts (the signing link, the copy made for one person, its completed copy).
import { readEnglish } from './words.ts';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, upload, tokenFor, PNG } from './helpers.ts';
import { shownDocIds, OTHER_DOC_LINE, OWN_DOCS_NOTE, OWN_DOCS_LABEL } from '../src/lib/owndocs.ts';

let db: Awaited<ReturnType<typeof boot>>['db'];
before(async () => {
  ({ db } = await boot());
});

let n = 0;
const person = async (name = 'Hana Sender') => signUp(name, `hana.${++n}@vis.example`, `10.93.${Math.floor(n / 250)}.${n % 250}`);
const textOf = async (pdf: Uint8Array) => {
  const { extractPages } = await import('../src/server/text.ts');
  return (await extractPages(pdf)).map((p: any) => (typeof p === 'string' ? p : p.text ?? JSON.stringify(p))).join('\n').replace(/\s+/g, ' ');
};
const ok = (r: { status: number; data: any }, what = '') => {
  assert.equal(r.status, 200, `${what} ${JSON.stringify(r.data)}`);
  return r.data;
};

// A contract for Emma (the employee) and a salary sheet for Hugo (HR), and Cleo who gets a copy.
async function envelope(c: Client, over: any = {}) {
  const contract = await upload(c, 1);
  const salary = await upload(c, 2);
  const k = n;
  const body = {
    subject: 'New starter', own_docs: true,
    documents: [{ id: 'dc', file_id: contract.id, name: 'Employment contract' }, { id: 'ds', file_id: salary.id, name: 'Salary sheet 2027' }],
    recipients: [
      { id: 'emma', role: 'signer', name: 'Emma Worker', email: `emma.${k}@vis.example` },
      { id: 'hugo', role: 'signer', name: 'Hugo Payroll', email: `hugo.${k}@vis.example` },
      { id: 'cleo', role: 'cc', name: 'Cleo Copy', email: `cleo.${k}@vis.example` },
    ],
    fields: [
      { id: 'fe', document_id: 'dc', recipient_id: 'emma', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'fh', document_id: 'ds', recipient_id: 'hugo', type: 'signature', page: 1, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'fn', document_id: 'ds', recipient_id: null, type: 'note', value: 'Base pay 91000', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.04 },
      { id: 'fs', document_id: 'ds', recipient_id: 'hugo', type: 'stamp', required: false, page: 0, x: 0.5, y: 0.2, w: 0.2, h: 0.1 },
    ].filter((f) => f.type !== 'stamp'),
    ...over,
  };
  const e = ok(await c.post('/envelopes', body), 'draft').envelope;
  return { e, k, emma: `emma.${k}@vis.example`, hugo: `hugo.${k}@vis.example`, cleo: `cleo.${k}@vis.example` };
}
const send = async (c: Client, id: string) => ok(await c.post(`/envelopes/${id}/send`), 'send');
const link = async (envelopeId: string, email: string, ip: string) => {
  const s = new Client();
  s.ip = ip;
  const tok = tokenFor(envelopeId, email);
  assert.equal((await s.post(`/sign/${tok}/consent`)).status, 200);
  return { s, tok, view: async () => ok(await s.get(`/sign/${tok}`), 'view') };
};
const finish = async (x: { s: Client; tok: string; view: () => Promise<any> }) => {
  const v = await x.view();
  return ok(await x.s.post(`/sign/${x.tok}/complete`, { values: Object.fromEntries(v.fields.map((f: any) => [f.id, '1'])), signature_png: PNG }), 'finish');
};
const verifyFile = async (bytes: Uint8Array) => {
  const f = new FormData();
  f.append('file', new Blob([bytes], { type: 'application/pdf' }), 'x.pdf');
  return ok(await new Client().call('POST', '/public/verify', f), 'verify');
};

test('the rule: fields, ticks, witnesses, people without fields, roles that see all, and off', () => {
  const docs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const people = [{ id: 'p', role: 'signer' }, { id: 'q', role: 'signer', also_sees: ['c'] }, { id: 'w', role: 'witness', witness_for: 'p' }, { id: 'v', role: 'cc' }, { id: 'x', role: 'editor' }];
  const fields = [{ document_id: 'a', recipient_id: 'p' }, { document_id: 'b', recipient_id: 'q' }];
  assert.deepEqual([...shownDocIds(true, docs, people, fields, 'p')!], ['a']);
  assert.deepEqual([...shownDocIds(true, docs, people, fields, 'q')!].sort(), ['b', 'c']);
  assert.deepEqual([...shownDocIds(true, docs, people, fields, 'w')!], ['a']);
  assert.equal(shownDocIds(true, docs, people, fields, 'v'), null, 'no fields and nothing ticked: every file');
  assert.equal(shownDocIds(true, docs, people, fields, 'x'), null, 'can change the document: every file');
  assert.equal(shownDocIds(false, docs, people, fields, 'p'), null, 'off: every file');
  assert.equal(shownDocIds(true, [{ id: 'a' }], people, fields, 'p'), null, 'one file: nothing to hide');
  // Ticks that name files of another envelope count for nothing.
  assert.equal(shownDocIds(true, docs, [{ id: 'z', also_sees: ['nope'] }], [], 'z'), null);
  // The words never say private, and no long dash.
  for (const s of [OWN_DOCS_LABEL, OWN_DOCS_NOTE, OTHER_DOC_LINE]) (assert.ok(!/private|—/i.test(s), s));
});

test('a file not shown to someone is absent from every answer of their link and refused by URL', async () => {
  const c = await person();
  const { e, emma, hugo } = await envelope(c);
  await send(c, e.id);
  const full = db.get('SELECT * FROM envelopes WHERE id=?', e.id);
  assert.equal(full.own_docs, 1);
  const ds = e.documents.find((d: any) => d.name === 'Salary sheet 2027');
  const dc = e.documents.find((d: any) => d.name === 'Employment contract');
  const me = await link(e.id, emma, '198.51.100.31');
  const v = await me.view();
  const text = JSON.stringify(v);
  assert.deepEqual(v.documents.map((d: any) => d.name), ['Employment contract']);
  assert.ok(!text.includes('Salary sheet'), 'no name');
  assert.ok(!text.includes(ds.id) && !text.includes(ds.sha256), 'no id, no fingerprint');
  assert.ok(!text.includes('Base pay 91000'), 'no note or field from that file');
  assert.ok(v.others.every((f: any) => f.document_id === dc.id));
  // By URL: exactly like a file that does not exist.
  const byUrl = await me.s.get(`/sign/${me.tok}/doc/${ds.id}`);
  const none = await me.s.get(`/sign/${me.tok}/doc/doc_nothing_at_all_here`);
  assert.equal(byUrl.status, 404);
  const bare = (d: any) => ({ ...d, request_id: undefined });
  assert.deepEqual(bare(byUrl.data), bare(none.data));
  assert.equal((await me.s.get(`/sign/${me.tok}/doc/${dc.id}`)).status, 200);
  // The text a machine read and the files to read know only theirs too.
  const ocr = await me.s.get(`/sign/${me.tok}/ocr`);
  assert.ok(!JSON.stringify(ocr.data).includes(ds.id));
  // Hugo sees his own file and nothing of Emma's.
  const hr = await link(e.id, hugo, '198.51.100.32');
  const hv = await hr.view();
  assert.deepEqual(hv.documents.map((d: any) => d.name), ['Salary sheet 2027']);
  assert.ok(hv.others.some((f: any) => f.value === 'Base pay 91000'));
  assert.equal((await hr.s.get(`/sign/${hr.tok}/doc/${dc.id}`)).status, 404);
  // The sender's side always sees everything.
  const mineNow = ok(await c.get(`/envelopes/${e.id}`)).envelope;
  assert.equal(mineNow.documents.length, 2);
});

test('comments pinned to a file someone is not shown are not theirs to read or answer', async () => {
  const c = await person();
  const { e, emma, hugo } = await envelope(c);
  await send(c, e.id);
  const ds = e.documents.find((d: any) => d.name === 'Salary sheet 2027');
  const dc = e.documents.find((d: any) => d.name === 'Employment contract');
  const hr = await link(e.id, hugo, '198.51.100.33');
  await hr.view();
  ok(await hr.s.post(`/sign/${hr.tok}/comments`, { text: 'Is the bonus included in this figure?', for: 'everyone', pin: { document_id: ds.id, page: 0 } }), 'hr comment');
  ok(await c.post(`/envelopes/${e.id}/comments`, { text: 'Please read clause 4 before you sign.', for: 'everyone', pin: { document_id: dc.id, page: 0 } }), 'sender comment');
  const me = await link(e.id, emma, '198.51.100.34');
  await me.view();
  const mine = ok(await me.s.get(`/sign/${me.tok}/comments`));
  assert.equal(mine.threads.length, 1);
  assert.match(mine.threads[0].comments[0].body, /clause 4/);
  assert.ok(!JSON.stringify(mine).includes('bonus') && !JSON.stringify(mine).includes('Salary'));
  const hidden = db.get('SELECT thread_id FROM comments WHERE body LIKE ?', '%bonus%').thread_id;
  assert.equal((await me.s.post(`/sign/${me.tok}/comments`, { text: 'Me too', thread_id: hidden })).status, 404);
  // Pinning one of her own to that file is refused the same way as a file that is not there.
  assert.equal((await me.s.post(`/sign/${me.tok}/comments`, { text: 'What is this?', pin: { document_id: ds.id, page: 0 } })).status, 400);
  // Hugo reads both: the thread on his file, and the one for everyone on the contract? Only his file's is shown.
  const his = ok(await hr.s.get(`/sign/${hr.tok}/comments`));
  assert.ok(JSON.stringify(his).includes('bonus'));
  assert.ok(!JSON.stringify(his).includes('clause 4'), 'the contract is not Hugo\'s file');
});

test('each person whose view is limited gets their own completed copy, and each one verifies', async () => {
  const c = await person();
  const { e, emma, hugo, cleo } = await envelope(c);
  await send(c, e.id);
  const ds = e.documents.find((d: any) => d.name === 'Salary sheet 2027');
  await finish(await link(e.id, emma, '198.51.100.35'));
  await finish(await link(e.id, hugo, '198.51.100.36'));
  const done = db.get('SELECT * FROM envelopes WHERE id=?', e.id);
  assert.equal(done.status, 'completed');
  assert.ok(done.final_sha256);
  const copies = db.all('SELECT * FROM final_copies WHERE envelope_id=? ORDER BY recipient_id', e.id);
  assert.equal(copies.length, 2, 'Emma and Hugo; Cleo has no fields and sees everything');
  assert.notEqual(copies[0].sha256, copies[1].sha256);
  assert.ok(copies.every((x: any) => x.sha256 !== done.final_sha256));

  const emmaId = db.get('SELECT id FROM recipients WHERE envelope_id=? AND email=?', e.id, emma).id;
  const own = copies.find((x: any) => x.recipient_id === emmaId);
  // Her link gives her own copy, never the full one.
  const s = new Client();
  s.ip = '198.51.100.37';
  const dl = await s.get(`/sign/${tokenFor(e.id, emma)}/download`);
  assert.equal(dl.status, 200);
  const { sha256 } = await import('../src/server/util.ts');
  assert.equal(sha256(dl.data), own.sha256);
  const words = await textOf(dl.data);
  assert.match(words, new RegExp(OTHER_DOC_LINE));
  assert.ok(words.includes(ds.sha256), 'the other file by its fingerprint');
  assert.ok(!words.includes('Salary sheet'), 'never by its name');
  assert.ok(!words.includes('Base pay 91000'));
  // The sender's copy holds everything.
  const fullText = await textOf(db.readBlob(done.final_sha256));
  assert.ok(fullText.includes('Salary sheet 2027') && fullText.includes('Employment contract'));
  assert.ok(!fullText.includes(OTHER_DOC_LINE));
  // Cleo sees everything, so she gets the sender's copy.
  const cl = await new Client().get(`/sign/${tokenFor(e.id, cleo)}/download`);
  assert.equal(sha256(cl.data), done.final_sha256);
  // /verify by file knows every copy, and says which kind it is.
  for (const x of copies) {
    const v = await verifyFile(db.readBlob(x.sha256));
    assert.equal(v.match, true);
    assert.equal(v.own_copy, true);
    assert.equal(v.envelope.id, e.id);
  }
  const vf = await verifyFile(db.readBlob(done.final_sha256));
  assert.equal(vf.match, true);
  assert.equal(vf.own_copy, undefined);
  // By ID: the fingerprints of the own copies are said beside the sender's.
  const look = ok(await new Client().get(`/public/verify/${e.id}`));
  assert.equal(look.sha256, done.final_sha256);
  assert.deepEqual([...look.own_copies].sort(), copies.map((x: any) => x.sha256).sort());
  // The completed email to Emma carries her copy's fingerprint, not the full one.
  const mail = db.all("SELECT html, payload FROM emails WHERE to_email=? AND subject LIKE 'Completed:%'", emma).pop();
  assert.ok(mail.html.includes(own.sha256));
  assert.ok(!mail.html.includes(done.final_sha256));
  assert.ok(!mail.html.includes('Salary'));
  // The evidence pack holds everything, the own copies included.
  const pack = await c.get(`/envelopes/${e.id}/evidence`);
  assert.equal(pack.status, 200);
  const zip = Buffer.from(pack.data).toString('latin1');
  assert.ok(zip.includes('signed.pdf') && zip.includes('own-copies/'));
});

test('ticks add files, and a person with all files ticked sees everything and gets the full copy', async () => {
  const c = await person();
  const { e, emma } = await envelope(c, {});
  const body = { ...e, own_docs: true, documents: e.documents.map((d: any) => ({ id: d.id, file_id: d.file_id, name: d.name })), recipients: e.recipients.map((r: any) => ({ id: r.id, role: r.role, name: r.name, email: r.email, also_sees: r.email === emma ? e.documents.map((d: any) => d.id) : undefined })), fields: e.fields };
  // Not a list: said, not saved.
  const bad = await c.put(`/envelopes/${e.id}`, { ...body, recipients: [{ ...body.recipients[0], also_sees: 'all' }] });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  const saved = ok(await c.put(`/envelopes/${e.id}`, body)).envelope;
  assert.deepEqual(saved.recipients.find((r: any) => r.email === emma).also_sees.sort(), e.documents.map((d: any) => d.id).sort());
  await send(c, e.id);
  const me = await link(e.id, emma, '198.51.100.38');
  assert.equal((await me.view()).documents.length, 2);
  // A tick naming something else is dropped, not saved.
  const odd = ok(await c.post('/envelopes', { ...body, recipients: body.recipients.map((r: any) => ({ ...r, id: undefined, also_sees: ['doc_from_somewhere_else'] })), fields: [] })).envelope;
  assert.ok(odd.recipients.every((r: any) => !r.also_sees));
});

test('off by default, and with zero setup everyone sees every file as before', async () => {
  const c = await person();
  const { e, emma } = await envelope(c, { own_docs: undefined });
  assert.equal(db.get('SELECT own_docs FROM envelopes WHERE id=?', e.id).own_docs, 0);
  await send(c, e.id);
  const me = await link(e.id, emma, '198.51.100.39');
  assert.equal((await me.view()).documents.length, 2);
  const r = await c.post('/envelopes', { subject: 'x', own_docs: 'yes', documents: [], recipients: [], fields: [] });
  assert.equal(r.status, 400);
});

test('the account default starts new envelopes and templates with it on; only a yes or a no', async () => {
  const c = await person();
  assert.equal(ok(await c.get('/me')).account.own_docs_default, false);
  assert.equal((await c.call('PATCH', '/account', { own_docs_default: 'on' })).status, 400);
  ok(await c.call('PATCH', '/account', { own_docs_default: true }));
  assert.equal(ok(await c.get('/me')).account.own_docs_default, true);
  const file = await upload(c, 1);
  const e = ok(await c.post('/envelopes', { subject: 'x', documents: [{ id: 'd', file_id: file.id }], recipients: [], fields: [] })).envelope;
  assert.equal(e.own_docs, 1);
  ok(await c.call('PATCH', '/account', { own_docs_default: false }));
});

test('a witness sees what the person they witness sees', async () => {
  const c = await person();
  const k = ++n;
  const a = await upload(c, 1);
  const b = await upload(c, 1);
  const e = ok(await c.post('/envelopes', {
    subject: 'Deed', own_docs: true,
    documents: [{ id: 'da', file_id: a.id, name: 'Deed' }, { id: 'db', file_id: b.id, name: 'Valuation' }],
    recipients: [
      { id: 'p', role: 'signer', name: 'Pia Owner', email: `pia.${k}@vis.example` },
      { id: 'w', role: 'witness', name: 'Wil Witness', email: `wil.${k}@vis.example`, witness_for: 'p' },
      { id: 'v', role: 'signer', name: 'Val Valuer', email: `val.${k}@vis.example` },
    ],
    fields: [
      { id: 'f1', document_id: 'da', recipient_id: 'p', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'f2', document_id: 'da', recipient_id: 'w', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 },
      { id: 'f3', document_id: 'db', recipient_id: 'v', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
    ],
  })).envelope;
  const env = (await import('../src/server/envelopes.ts')).loadEnvelope(e.id);
  const { shownFor } = await import('../src/server/visibility.ts');
  const wid = env.recipients.find((r: any) => r.role === 'witness').id;
  assert.deepEqual([...shownFor(env, wid)!].map((d) => env.documents.find((x: any) => x.id === d).name), ['Deed']);
});

test('a group sees the files with the group\'s fields; members share one own copy', async () => {
  const c = await person();
  const k = ++n;
  const members = [{ name: 'Maya Lopez', email: `maya.${k}@vis.example` }, { name: 'Ben Ortiz', email: `ben.${k}@vis.example` }];
  const group = ok(await c.post('/groups', { name: 'HR team', members })).group;
  const a = await upload(c, 1);
  const b = await upload(c, 1);
  const e = ok(await c.post('/envelopes', {
    subject: 'Offer', own_docs: true,
    documents: [{ id: 'da', file_id: a.id, name: 'Offer letter' }, { id: 'db', file_id: b.id, name: 'Pay band' }],
    recipients: [{ id: 'emp', role: 'signer', name: 'Ella New', email: `ella.${k}@vis.example` }, { id: 'g', role: 'signer', group_id: group.id }],
    fields: [
      { id: 'f1', document_id: 'da', recipient_id: 'emp', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'f2', document_id: 'db', recipient_id: 'g', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
    ],
  })).envelope;
  await send(c, e.id);
  const tok = db.get('SELECT token FROM recipient_members WHERE envelope_id=? AND email=?', e.id, members[0].email).token;
  const s = new Client();
  s.ip = '198.51.100.40';
  ok(await s.post(`/sign/${tok}/consent`));
  const v = ok(await s.get(`/sign/${tok}`));
  assert.deepEqual(v.documents.map((d: any) => d.name), ['Pay band']);
  const offer = e.documents.find((d: any) => d.name === 'Offer letter');
  assert.equal((await s.get(`/sign/${tok}/doc/${offer.id}`)).status, 404);
});

test('a person who has finished keeps exactly the files they were shown through a correction', async () => {
  const c = await person();
  const { e, emma, hugo } = await envelope(c);
  await send(c, e.id);
  await finish(await link(e.id, emma, '198.51.100.41'));
  const cur = ok(await c.get(`/envelopes/${e.id}`)).envelope;
  const body = { subject: cur.subject, own_docs: true, documents: cur.documents.map((d: any) => ({ id: d.id, file_id: d.file_id, name: d.name })), recipients: cur.recipients.map((r: any) => ({ id: r.id, role: r.role, name: r.name, email: r.email, routing_order: r.routing_order, also_sees: r.email === emma ? cur.documents.map((d: any) => d.id) : r.also_sees })), fields: cur.fields };
  const r = await c.put(`/envelopes/${e.id}`, body);
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, 'own_docs_locked');
  assert.ok(!/—/.test(r.data.error || r.data.message || ''));
  // Switching it off is the same change for her, and is refused too.
  assert.equal((await c.put(`/envelopes/${e.id}`, { ...body, own_docs: false, recipients: body.recipients.map((x: any) => ({ ...x, also_sees: undefined })) })).status, 409);
  // A change for someone who has not finished goes through.
  const cleo = cur.recipients.find((x: any) => x.role === 'cc');
  const fine = await c.put(`/envelopes/${e.id}`, { ...body, recipients: body.recipients.map((x: any) => ({ ...x, also_sees: x.id === cleo.id ? [cur.documents[0].id] : x.email === emma ? undefined : x.also_sees })) });
  assert.equal(fine.status, 200, JSON.stringify(fine.data));
  const hr = await link(e.id, hugo, '198.51.100.42');
  assert.deepEqual((await hr.view()).documents.map((d: any) => d.name), ['Salary sheet 2027']);
});

test('sign again and templates keep the option and the ticks, pointing at the copy\'s own files', async () => {
  const c = await person();
  const { e, emma } = await envelope(c);
  const salary = e.documents.find((d: any) => d.name === 'Salary sheet 2027');
  const body = { subject: e.subject, documents: e.documents.map((d: any) => ({ id: d.id, file_id: d.file_id, name: d.name })), recipients: e.recipients.map((r: any) => ({ id: r.id, role: r.role, name: r.name, email: r.email, also_sees: r.email === emma ? [salary.id] : undefined })), fields: e.fields };
  ok(await c.put(`/envelopes/${e.id}`, body));
  const copy = ok(await c.post(`/envelopes/${e.id}/clone`, { kind: 'template' }));
  const tid = copy.envelope?.id || copy.template?.id || copy.id;
  const t = db.get('SELECT own_docs FROM envelopes WHERE id=?', tid);
  assert.equal(t.own_docs, 1);
  const ticks = JSON.parse(db.get("SELECT own_docs_extra x FROM recipients WHERE envelope_id=? AND name='Emma Worker'", tid).x);
  const newSalary = db.get("SELECT id FROM documents WHERE envelope_id=? AND name='Salary sheet 2027'", tid).id;
  assert.deepEqual(ticks, [newSalary]);
  assert.notEqual(newSalary, salary.id);
});

test('the sender\'s preview of one person shows only their files', async () => {
  const c = await person();
  const { e, emma } = await envelope(c);
  const emmaId = e.recipients.find((r: any) => r.email === emma).id;
  const p = ok(await c.post(`/envelopes/${e.id}/recipient-preview`, { recipient_id: emmaId }), 'preview');
  const token = String(p.url).split('/sign/')[1];
  const v = ok(await c.get(`/preview/${token}`));
  assert.deepEqual(v.documents.map((d: any) => d.name), ['Employment contract']);
});

test('names of a file someone was not shown are taken out of their copy\'s trail and their screen', async () => {
  const c = await person();
  const { e, emma, hugo } = await envelope(c);
  await send(c, e.id);
  const env = await import('../src/server/envelopes.ts');
  env.audit(e.id, { name: 'System' }, 'Wording struck out', 'The sender struck out wording on page 1 of "Salary sheet 2027".');
  db.run('UPDATE envelopes SET last_change=? WHERE id=?', 'Replaced Salary sheet 2027 with a new version.', e.id);
  const me = await link(e.id, emma, '198.51.100.43');
  const v = await me.view();
  assert.ok(!JSON.stringify(v).includes('Salary'), JSON.stringify(v.changed));
  // A change to a file she is not shown is not hers to hear about (changeFor).
  assert.equal(v.changed, null);
  await finish(me);
  await finish(await link(e.id, hugo, '198.51.100.44'));
  const emmaId = db.get('SELECT id FROM recipients WHERE envelope_id=? AND email=?', e.id, emma).id;
  const own = db.get('SELECT sha256 FROM final_copies WHERE envelope_id=? AND recipient_id=?', e.id, emmaId);
  const words = await textOf(db.readBlob(own.sha256));
  assert.ok(!words.includes('Salary'), 'no name anywhere in her copy');
  assert.match(words, /a document you were not shown/);
  // The record itself is untouched.
  assert.ok(db.all('SELECT detail FROM audit WHERE envelope_id=?', e.id).some((a: any) => String(a.detail).includes('Salary sheet 2027')));
});

test('a missing own copy is made again when its person opens it, never replaced by the full one', async () => {
  const c = await person();
  const { e, emma, hugo } = await envelope(c);
  await send(c, e.id);
  await finish(await link(e.id, emma, '198.51.100.45'));
  await finish(await link(e.id, hugo, '198.51.100.46'));
  const done = db.get('SELECT final_sha256 FROM envelopes WHERE id=?', e.id);
  db.run('DELETE FROM final_copies WHERE envelope_id=?', e.id);
  const { sha256 } = await import('../src/server/util.ts');
  const dl = await new Client().get(`/sign/${tokenFor(e.id, emma)}/download`);
  assert.equal(dl.status, 200);
  assert.notEqual(sha256(dl.data), done.final_sha256);
  const emmaId = db.get('SELECT id FROM recipients WHERE envelope_id=? AND email=?', e.id, emma).id;
  assert.equal(db.get('SELECT sha256 FROM final_copies WHERE envelope_id=? AND recipient_id=?', e.id, emmaId).sha256, sha256(dl.data));
});

test('a file to read that someone is not shown is refused by its own URL too', async () => {
  const c = await person();
  const k = ++n;
  const a = await upload(c, 1);
  const b = await upload(c, 1);
  const r = await upload(c, 1);
  const e = ok(await c.post('/envelopes', {
    subject: 'Lease', own_docs: true,
    documents: [{ id: 'da', file_id: a.id, name: 'Lease' }, { id: 'db', file_id: b.id, name: 'Guarantee' }, { id: 'dr', file_id: r.id, name: 'Notice for the guarantor', supplemental: 'open' }],
    recipients: [{ id: 't', role: 'signer', name: 'Tia Tenant', email: `tia.${k}@vis.example` }, { id: 'g', role: 'signer', name: 'Gus Guarantor', email: `gus.${k}@vis.example`, also_sees: ['dr'] }],
    fields: [
      { id: 'f1', document_id: 'da', recipient_id: 't', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'f2', document_id: 'db', recipient_id: 'g', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
    ],
  })).envelope;
  await send(c, e.id);
  const notice = e.documents.find((d: any) => d.name === 'Notice for the guarantor');
  const tia = await link(e.id, `tia.${k}@vis.example`, '198.51.100.47');
  const tv = await tia.view();
  assert.ok(!JSON.stringify(tv).includes('Notice for the guarantor'));
  assert.equal((await tia.s.get(`/sign/${tia.tok}/supplements/${notice.id}`)).status, 404);
  // Tia need not open a file she was never shown before she finishes.
  await finish(tia);
  const gus = await link(e.id, `gus.${k}@vis.example`, '198.51.100.48');
  const gv = await gus.view();
  assert.ok(JSON.stringify(gv).includes('Notice for the guarantor'));
});

// ---- Repairs after the skeptic's probes and the simplicity review (tests/out/verify-ds-visibility, ux-ds-visibility).

test('words: whole names only, a subject per person, and what changed per person', async () => {
  const { namesFile, subjectFor, changeFor } = await import('../src/lib/owndocs.ts');
  assert.ok(namesFile('Please sign: Pay', 'Pay'));
  assert.ok(!namesFile('Payment received', 'Pay'), 'part of a longer word is not the name');
  assert.ok(namesFile('the "salary sheet" here', 'Salary sheet'), 'capitals do not hide a name');
  const docs = [{ id: 'c', name: 'Employment contract' }, { id: 's', name: 'Salary sheet' }];
  assert.equal(subjectFor('Please sign: Employment contract', docs, new Set(['s'])), 'Please sign: Salary sheet', 'the automatic subject names a file they are not shown');
  assert.equal(subjectFor('', docs, new Set(['c'])), 'Please sign: Employment contract');
  assert.equal(subjectFor('New starter', docs, new Set(['c'])), 'New starter', 'a subject that names no other file stays as typed');
  assert.equal(subjectFor('Contract and Salary sheet', docs, new Set(['c'])), 'Please sign: Employment contract');
  assert.equal(subjectFor('Please sign: Salary sheet', docs, null), 'Please sign: Salary sheet', 'someone who sees every file gets the subject as it is');
  assert.equal(changeFor('The file of document "Salary sheet" was replaced. Before: 2 pages. Now: 3 pages. Signing in order turned on.', ['Salary sheet']), 'Signing in order turned on.');
  assert.equal(changeFor('The file of document "Salary sheet" was replaced. Signing in order turned on.', ['Salary sheet']), 'Signing in order turned on.');
  assert.equal(changeFor('Document "Salary sheet" renamed to "Salary sheet 2".', ['Salary sheet']), '');
});

test('P1: with an empty or automatic subject, a limited person\'s link and emails name only their own file', async () => {
  for (const subject of ['', 'Please sign: Salary sheet 2027']) {
    const c = await person();
    const a = await upload(c, 1);
    const b = await upload(c, 2);
    const k = ++n;
    const e = ok(await c.post('/envelopes', {
      subject, own_docs: true,
      documents: [{ id: 'ds', file_id: b.id, name: 'Salary sheet 2027' }, { id: 'dc', file_id: a.id, name: 'Employment contract' }],
      recipients: [{ id: 'emma', role: 'signer', name: 'Emma Worker', email: `emma.p1${k}@vis.example` }, { id: 'hugo', role: 'signer', name: 'Hugo Payroll', email: `hugo.p1${k}@vis.example` }],
      fields: [
        { id: 'fe', document_id: 'dc', recipient_id: 'emma', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
        { id: 'fh', document_id: 'ds', recipient_id: 'hugo', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      ],
    })).envelope;
    await send(c, e.id);
    const emma = `emma.p1${k}@vis.example`;
    const me = await link(e.id, emma, `198.51.101.${k % 250}`);
    const v = await me.view();
    assert.equal(v.envelope.subject, 'Please sign: Employment contract');
    assert.ok(!JSON.stringify(v).includes('Salary'), 'nothing in her view names the salary sheet');
    const mails = db.all('SELECT subject, html FROM emails WHERE to_email=?', emma);
    assert.ok(mails.length > 0);
    assert.ok(!mails.some((m: any) => /Salary/.test(m.subject + m.html)), mails.map((m: any) => m.subject).join(' | '));
    // Her early download is named after her own subject, and the sender still reads their own subject when she opens it.
    const d = await me.s.get(`/sign/${me.tok}/download`);
    assert.ok(!/Salary/.test(String(d.headers?.get?.('content-disposition') || '')));
    const sender = db.get('SELECT u.email FROM users u JOIN envelopes e ON e.sender_id=u.id WHERE e.id=?', e.id).email;
    const toSender = db.all("SELECT subject FROM emails WHERE to_email=? AND envelope_id=?", sender, e.id).map((m: any) => m.subject);
    assert.ok(!toSender.some((s: string) => s.includes('Please sign: Employment contract') && subject), toSender.join(' | '));
    // Hugo, who is shown the salary sheet, gets a subject that names it.
    const hv = await (await link(e.id, `hugo.p1${k}@vis.example`, `198.51.102.${k % 250}`)).view();
    assert.equal(hv.envelope.subject, 'Please sign: Salary sheet 2027');
  }
});

test('P2: a correction to a file someone is not shown is not emailed to them and not named anywhere', async () => {
  const c = await person();
  const { e, emma } = await envelope(c);
  await send(c, e.id);
  const me = await link(e.id, emma, '198.51.100.81');
  await me.view();
  const cur = ok(await c.get(`/envelopes/${e.id}`)).envelope;
  const other = await upload(c, 3);
  const docs = cur.documents.map((d: any) => ({ id: d.id, file_id: d.name === 'Salary sheet 2027' ? other.id : d.file_id, name: d.name === 'Salary sheet 2027' ? 'Salary sheet 2027 with bonus' : d.name }));
  const before = db.all('SELECT id FROM emails WHERE to_email=?', emma).length;
  ok(await c.put(`/envelopes/${e.id}`, { subject: cur.subject, own_docs: true, documents: docs, recipients: cur.recipients.map((x: any) => ({ id: x.id, role: x.role, name: x.name, email: x.email, routing_order: x.routing_order })), fields: cur.fields }), 'correct');
  const mails = db.all('SELECT subject, html FROM emails WHERE to_email=?', emma);
  assert.equal(mails.length, before, 'her files did not change, so she is not emailed "Updated"');
  assert.ok(!mails.some((m: any) => /Salary/.test(m.subject + m.html)));
  const v = await me.view();
  assert.ok(!JSON.stringify(v).includes('Salary'));
  assert.equal(v.changed, null, 'nothing about another person\'s file, not even its page counts');
  // Hugo, whose file it is, is told what changed, with the name.
  const hugoMail = db.all("SELECT html FROM emails WHERE to_email=? AND subject LIKE 'Updated:%'", e.recipients.find((r: any) => r.name === 'Hugo Payroll').email).pop();
  assert.match(hugoMail?.html || '', /Salary sheet 2027 with bonus/);
});

test('P3: a file named with an ordinary word leaves the other lines of her copy\'s trail alone', async () => {
  const c2 = await person();
  const a = await upload(c2, 1);
  const b = await upload(c2, 2);
  const k = ++n;
  const env = ok(await c2.post('/envelopes', {
    subject: 'New starter', own_docs: true,
    documents: [{ id: 'dc', file_id: a.id, name: 'Employment contract' }, { id: 'ds', file_id: b.id, name: 'Signed' }],
    recipients: [{ id: 'emma', role: 'signer', name: 'Emma Worker', email: `emma.p3${k}@vis.example` }, { id: 'hugo', role: 'signer', name: 'Hugo Payroll', email: `hugo.p3${k}@vis.example` }],
    fields: [
      { id: 'fe', document_id: 'dc', recipient_id: 'emma', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'fh', document_id: 'ds', recipient_id: 'hugo', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
    ],
  })).envelope;
  await send(c2, env.id);
  const lib = await import('../src/server/envelopes.ts');
  lib.audit(env.id, { name: 'System' }, 'Wording struck out', 'The sender struck out wording on page 1 of "Signed".');
  await finish(await link(env.id, `emma.p3${k}@vis.example`, '198.51.100.82'));
  await finish(await link(env.id, `hugo.p3${k}@vis.example`, '198.51.100.83'));
  const emmaId = db.get('SELECT id FROM recipients WHERE envelope_id=? AND email=?', env.id, `emma.p3${k}@vis.example`).id;
  const own = db.get('SELECT sha256 FROM final_copies WHERE envelope_id=? AND recipient_id=?', env.id, emmaId);
  const words = await textOf(db.readBlob(own.sha256));
  assert.match(words, /Signed/, 'her signature event still says Signed');
  assert.match(words, /page 1 of a document you were not shown/, 'the quoted name is replaced');
  assert.ok(!/recipients, \d+ pages/.test(words), 'the line about sending leaves out the page count of the whole envelope');
  // The scrub itself, on lines of ours.
  const { scrubNames } = await import('../src/server/visibility.ts');
  const x = { documents: [{ name: 'Employment contract' }], hidden_documents: [{ name: 'Pay' }] };
  assert.equal(scrubNames(x, 'Payment made. Document "Pay" added.'), 'Payment made. Document a document you were not shown added.');
  assert.equal(scrubNames(x, 'Subject changed from "Please sign: Pay" to "New".'), 'Subject changed from "Please sign: a document you were not shown" to "New".');
});

test('P4: /verify of a person\'s own copy names their subject and says it holds only their files', async () => {
  const c = await person();
  const { e, emma, hugo } = await envelope(c, { subject: 'Please sign: Salary sheet 2027' });
  await send(c, e.id);
  const me = await link(e.id, emma, '198.51.100.84');
  await finish(me);
  await finish(await link(e.id, hugo, '198.51.100.85'));
  const d = await me.s.get(`/sign/${me.tok}/download`);
  const res = await verifyFile(d.data);
  assert.equal(res.match, true);
  assert.equal(res.own_copy, true);
  assert.equal(res.envelope.subject, 'Please sign: Employment contract');
  const { OWN_COPY_VERIFY } = await import('../src/lib/owndocs.ts');
  assert.ok(!/private|—/i.test(OWN_COPY_VERIFY));
  const fs = await import('node:fs');
  for (const f of ['src/app/verify/page.tsx', 'src/app/verify/ById.tsx']) assert.match(fs.readFileSync(f, 'utf8'), /OWN_COPY_VERIFY/, `${f} says what an own copy is`);
  assert.match(fs.readFileSync('src/app/verify/ById.tsx', 'utf8'), /own_copies \|\| \[\]\)\.includes\(same\.hash\)/, 'lookup by ID compares with every own copy too');
});

test('P5: a file to read that nobody ticked goes to everyone, so its rule is never skipped', async () => {
  const docs = [{ id: 'c' }, { id: 's' }, { id: 'h', supplemental: { rule: 'acknowledge' } }];
  const fields = [{ document_id: 'c', recipient_id: 'p' }, { document_id: 's', recipient_id: 'q' }];
  assert.deepEqual([...shownDocIds(true, docs, [{ id: 'p' }, { id: 'q' }, { id: 'v', role: 'cc' }], fields, 'p')!].sort(), ['c', 'h']);
  assert.equal(shownDocIds(true, docs, [{ id: 'p' }, { id: 'q' }, { id: 'v', role: 'cc' }], fields, 'v'), null, 'no fields, nothing ticked: every file');
  // Ticked for someone, it is only theirs (the guarantor's notice).
  assert.deepEqual([...shownDocIds(true, docs, [{ id: 'p' }, { id: 'q', also_sees: ['h'] }], fields, 'p')!], ['c']);
  const c = await person();
  const a = await upload(c, 1);
  const b = await upload(c, 2);
  const h = await upload(c, 1);
  const k = ++n;
  const e = ok(await c.post('/envelopes', {
    subject: 'New starter', own_docs: true,
    documents: [{ id: 'dc', file_id: a.id, name: 'Employment contract' }, { id: 'ds', file_id: b.id, name: 'Salary sheet' }, { id: 'dh', file_id: h.id, name: 'Staff handbook', supplemental: { rule: 'acknowledge' } }],
    recipients: [{ id: 'emma', role: 'signer', name: 'Emma Worker', email: `emma.p5${k}@vis.example` }, { id: 'hugo', role: 'signer', name: 'Hugo Payroll', email: `hugo.p5${k}@vis.example` }],
    fields: [
      { id: 'fe', document_id: 'dc', recipient_id: 'emma', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'fh', document_id: 'ds', recipient_id: 'hugo', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
    ],
  })).envelope;
  await send(c, e.id);
  const me = await link(e.id, `emma.p5${k}@vis.example`, '198.51.100.86');
  const v = await me.view();
  assert.ok(JSON.stringify(v).includes('Staff handbook'), 'she is given the handbook');
  assert.ok(!JSON.stringify(v).includes('Salary'));
  const f = await me.s.post(`/sign/${me.tok}/complete`, { values: Object.fromEntries(v.fields.map((x: any) => [x.id, '1'])), signature_png: PNG });
  assert.notEqual(f.status, 200, 'she cannot finish without acknowledging it');
});

test('screens: the Settings card is open in Sending, with ids of its own; the editor never springs a cleared tick back', async () => {
  const fs = await import('node:fs');
  const card = readEnglish('src/components/settings/OwnDocsDefault.tsx');
  assert.ok(!/"set-own-h"|"set-own-hint"/.test(card), 'not the ids of the consent text card');
  assert.match(card, /data-item="card"/);
  const page = fs.readFileSync('src/app/app/settings/page.tsx', 'utf8');
  const line = page.split('\n').find((l) => l.includes("tab === 'sending'"))!;
  assert.ok(line.indexOf('<OwnDocsDefault />') < line.indexOf('<MoreOptions>'), 'the default is in an open card, not in More options');
  const choice = fs.readFileSync('src/components/editor/OwnDocsChoice.tsx', 'utf8');
  assert.match(choice, /Everyone gets at least one file\./);
  assert.ok(!/With no fields and nothing ticked/.test(choice));
});
