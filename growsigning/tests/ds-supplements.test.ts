// Files given to read with a document, not signed (research/docusign-gaps.json, batch "supplements"):
// src/lib/supplements.ts (the words), src/server/supplements.ts (the rules, the copy, the certificate) and
// src/server/routes-supplements.ts (opening and ticking on the signing page).
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { boot, Client, signUp, upload, tokenFor, PNG } from './helpers.ts';
import { supplementCert } from '../src/server/supplements.ts';
import { nameList, ruleSummary, DIVIDER_TITLE, RULE_LABEL } from '../src/lib/supplements.ts';

let db: Awaited<ReturnType<typeof boot>>['db'];
before(async () => {
  ({ db } = await boot());
});

let n = 0;
const person = async (name = 'Sue Sender') => signUp(name, `sue.${++n}@supp.example`, `10.91.${Math.floor(n / 250)}.${n % 250}`);
// A refusal is what happened, then what to do, starting with a verb (research/ux-charter.md P10), without a long dash.
const plain = (m: string) => {
  assert.ok(!/\u2014/.test(m), `no long dash: ${m}`);
  const s = m.split(/(?<=\.)\s+/);
  assert.ok(s.length >= 2, `two sentences: ${m}`);
  assert.match(s[1], /^(Open|Load|Move|Remove|Mark|Send|Use|Add|Please|Nothing)\b/, `the second sentence says what to do: ${m}`);
};
const audit = (id: string) => db.all('SELECT action, detail, actor FROM audit WHERE envelope_id=? ORDER BY seq', id) as any[];
const textOf = async (pdf: Uint8Array) => {
  const { extractPages } = await import('../src/server/text.ts');
  return (await extractPages(pdf)).map((p: any) => (typeof p === 'string' ? p : p.text ?? JSON.stringify(p))).join('\n').replace(/\s+/g, ' ');
};

// One agreement to sign (one page) and a privacy notice (two pages) with the rule given, for Ada and Ben.
async function envelope(c: Client, rule: any = 'open', over: any = {}) {
  const sign = await upload(c, 1);
  const notice = await upload(c, 2);
  const r = await c.post('/envelopes', {
    subject: 'Lease',
    documents: [{ id: 'd1', file_id: sign.id, name: 'Lease' }, { id: 'd2', file_id: notice.id, name: 'Privacy notice', supplemental: rule }],
    recipients: [{ id: 'r1', role: 'signer', name: 'Ada Signer', email: `ada.${n}@supp.example` }, { id: 'r2', role: 'signer', name: 'Ben Signer', email: `ben.${n}@supp.example` }],
    fields: [
      { id: 'f1', document_id: 'd1', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'f2', document_id: 'd1', recipient_id: 'r2', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 },
    ],
    ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
const send = async (c: Client, e: any) => {
  const r = await c.post(`/envelopes/${e.id}/send`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
};
const signer = async (e: any, who: 'ada' | 'ben') => {
  const s = new Client();
  s.ip = who === 'ada' ? '198.51.100.11' : '198.51.100.12';
  const tok = tokenFor(e.id, `${who}.${n}@supp.example`);
  assert.equal((await s.post(`/sign/${tok}/consent`)).status, 200);
  return { s, tok, view: async () => (await s.get(`/sign/${tok}`)).data };
};
const finish = (x: { s: Client; tok: string; view: () => Promise<any> }) => x.view().then((v) => x.s.post(`/sign/${x.tok}/complete`, { values: Object.fromEntries(v.fields.map((f: any) => [f.id, '1'])), signature_png: PNG }));

test('1. a file can be marked to read, with a rule, and no field can be placed on it', async () => {
  const c = await person();
  const e = await envelope(c, { rule: 'acknowledge', in_copy: false });
  assert.deepEqual(e.documents.map((d: any) => d.supplemental), [null, { rule: 'acknowledge', in_copy: false }]);
  // A plain string is short for the rule; leaving it out keeps what the file had.
  const again = await c.put(`/envelopes/${e.id}`, { documents: e.documents.map((d: any) => ({ id: d.id, file_id: d.file_id, name: d.name })) });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.deepEqual(again.data.envelope.documents[1].supplemental, { rule: 'acknowledge', in_copy: false }, 'left out: kept');
  const off = await c.put(`/envelopes/${e.id}`, { documents: [e.documents[0], { ...e.documents[1], supplemental: null }] });
  assert.equal(off.data.envelope.documents[1].supplemental, null, 'null: a file to sign again');
  // A rule we do not have, or a wrong shape, is said and nothing is saved.
  for (const bad of ['must_read', { rule: 'open', in_copy: 'yes' }, [1]]) {
    const r = await c.put(`/envelopes/${e.id}`, { documents: [e.documents[0], { ...e.documents[1], supplemental: bad }] });
    assert.equal(r.status, 400, JSON.stringify(bad));
    plain(r.data.error);
  }
  // A field on a file to read is refused by name.
  const f = await c.put(`/envelopes/${e.id}`, {
    documents: [e.documents[0], { ...e.documents[1], supplemental: 'open' }],
    fields: [...e.fields, { id: 'f9', document_id: e.documents[1].id, recipient_id: 'r1', type: 'text', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.03 }],
  });
  assert.equal(f.status, 400);
  assert.match(f.data.error, /Privacy notice.*to read, not sign/);
  plain(f.data.error);
  // Files to read alone cannot be sent: there is nothing to sign.
  const only = await upload(c, 1);
  const lone = await c.post('/envelopes', { subject: 'Only a notice', documents: [{ file_id: only.id, name: 'Notice', supplemental: 'none' }], recipients: [{ role: 'viewer', name: 'Vi', email: 'vi@supp.example' }] });
  const s = await c.post(`/envelopes/${lone.data.envelope.id}/send`);
  assert.equal(s.status, 400);
  plain(s.data.error);
  // The editor's words for each rule.
  assert.equal(ruleSummary('open', true), 'To read, not sign. Each person must open it before they finish.');
  assert.match(ruleSummary('none', false), /Not in the signed copy\.$/);
  // The choices read as whole phrases, never a bare 'None' or a cut-off quote (simplicity review).
  assert.deepEqual(Object.values(RULE_LABEL), ['Nothing, it is there to read', 'Must open it', "Must tick 'I have been given it'"]);
});

test('1b. on an envelope that is out, a file cannot change between to sign and to read', async () => {
  const c = await person();
  const e = await envelope(c, 'none');
  await send(c, e);
  const cur = (await c.get(`/envelopes/${e.id}`)).data.envelope;
  const r = await c.put(`/envelopes/${e.id}`, { documents: [{ ...cur.documents[0], supplemental: 'open' }, cur.documents[1]], recipients: cur.recipients, fields: cur.fields });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /cannot change on a document that is out/);
  plain(r.data.error);
  // A rule may change while it stays a file to read.
  const ok = await c.put(`/envelopes/${e.id}`, { documents: [cur.documents[0], { ...cur.documents[1], supplemental: 'open' }], recipients: cur.recipients, fields: cur.fields });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.envelope.documents[1].supplemental.rule, 'open');
});

test('2. signing page: the list, Finish checks the rules, opening and ticking go in the audit trail', async () => {
  const c = await person();
  const e = await envelope(c, 'open');
  await send(c, e);
  const ada = await signer(e, 'ada');
  const v = await ada.view();
  assert.deepEqual(v.documents.map((d: any) => d.name), ['Lease'], 'the file to read is not among the pages to sign');
  assert.deepEqual(v.supplements.map((d: any) => [d.name, d.rule, d.opened, d.acknowledged]), [['Privacy notice', 'open', false, false]]);
  // Finish says what is missing and how to put it right.
  const early = await finish(ada);
  assert.equal(early.status, 400);
  assert.equal(early.data.code, 'supplements_missing');
  assert.match(early.data.error, /Privacy notice/);
  plain(early.data.error);
  // Ticking a file that asks to be opened is refused; opening it is recorded once.
  const tick = await ada.s.post(`/sign/${ada.tok}/supplements/${e.documents[1].id}/acknowledge`);
  assert.equal(tick.status, 400);
  plain(tick.data.error);
  const file = await ada.s.get(`/sign/${ada.tok}/supplements/${e.documents[1].id}`);
  assert.equal(file.status, 200);
  assert.equal((await PDFDocument.load(file.data)).getPageCount(), 2);
  await ada.s.get(`/sign/${ada.tok}/supplements/${e.documents[1].id}?download=1`);
  assert.equal(audit(e.id).filter((a) => a.action === 'Opened Privacy notice').length, 1, 'opening again is not written again');
  assert.ok(!audit(e.id).some((a) => /\bread\b/i.test(a.action)), 'never "read" in an action');
  assert.equal((await ada.view()).supplements[0].opened, true);
  assert.equal((await finish(ada)).status, 200);
  // Ben opening it does not count for Ada and Ada's does not count for Ben.
  const ben = await signer(e, 'ben');
  assert.equal((await ben.view()).supplements[0].opened, false);
  assert.equal((await finish(ben)).status, 400);
  // A file to sign, or another envelope's file, is not opened through this route.
  assert.equal((await ben.s.get(`/sign/${ben.tok}/supplements/${e.documents[0].id}`)).status, 404);
  assert.equal((await ben.s.get(`/sign/${ben.tok}/supplements/nope`)).status, 404);
});

test('2b. must acknowledge: the tick, once, and only while the person has to finish', async () => {
  const c = await person();
  const e = await envelope(c, 'acknowledge');
  await send(c, e);
  const ada = await signer(e, 'ada');
  assert.equal((await finish(ada)).status, 400);
  // Opening is not ticking.
  await ada.s.get(`/sign/${ada.tok}/supplements/${e.documents[1].id}`);
  assert.equal((await finish(ada)).status, 400);
  const t = await ada.s.post(`/sign/${ada.tok}/supplements/${e.documents[1].id}/acknowledge`);
  assert.equal(t.status, 200);
  assert.deepEqual(t.data.missing, []);
  await ada.s.post(`/sign/${ada.tok}/supplements/${e.documents[1].id}/acknowledge`);
  const lines = audit(e.id).filter((a) => a.action === 'Acknowledged receiving Privacy notice');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].actor.includes('ada.'), true);
  assert.equal((await finish(ada)).status, 200);
  // After finishing there is nothing more to tick.
  assert.equal((await ada.s.post(`/sign/${ada.tok}/supplements/${e.documents[1].id}/acknowledge`)).status >= 400, true);
  // Before agreeing to electronic records, no tick.
  const ben = new Client();
  const tok = tokenFor(e.id, `ben.${n}@supp.example`);
  const early = await ben.post(`/sign/${tok}/supplements/${e.documents[1].id}/acknowledge`);
  assert.equal(early.status, 400);
});

test('2c. whoever takes someone\'s place starts again; a replaced file is opened afresh', async () => {
  const c = await person();
  const e = await envelope(c, 'open');
  await send(c, e);
  const ada = await signer(e, 'ada');
  await ada.s.get(`/sign/${ada.tok}/supplements/${e.documents[1].id}`);
  assert.equal((await ada.view()).supplements[0].opened, true);
  // Agreement taken away (as a correction or a new person does): the earlier open no longer counts.
  db.run("UPDATE recipients SET consent_at=? WHERE envelope_id=? AND name='Ada Signer'", new Date(Date.now() + 1000).toISOString(), e.id);
  assert.equal((await ada.view()).supplements[0].opened, false);
  // A mark for another file under the same document id does not count either.
  db.run("UPDATE supplement_marks SET at='2000-01-01T00:00:00.000Z' WHERE envelope_id=?", e.id);
  db.run("UPDATE recipients SET consent_at=? WHERE envelope_id=? AND name='Ada Signer'", '2001-01-01T00:00:00.000Z', e.id);
  db.run("INSERT INTO supplement_marks (envelope_id, document_id, file_id, recipient_id, kind, at) VALUES (?, ?, 'file_other', ?, 'opened', ?)", e.id, e.documents[1].id, e.recipients.find((r: any) => r.name === 'Ada Signer').id, new Date().toISOString());
  assert.equal((await ada.view()).supplements[0].opened, false);
});

test('3. completed copy: the files to read after a divider, unless left out; the certificate lines', async () => {
  const pages: Record<string, number> = {};
  for (const inCopy of [true, false]) {
    const c = await person();
    const e = await envelope(c, { rule: 'open', in_copy: inCopy });
    await send(c, e);
    for (const who of ['ada', 'ben'] as const) {
      const x = await signer(e, who);
      await x.s.get(`/sign/${x.tok}/supplements/${e.documents[1].id}`);
      assert.equal((await finish(x)).status, 200);
    }
    const pdf = await c.get(`/envelopes/${e.id}/download`);
    assert.equal(pdf.status, 200);
    const doc = await PDFDocument.load(pdf.data);
    const text = await textOf(pdf.data);
    if (inCopy) {
      assert.ok(text.includes(DIVIDER_TITLE), 'the divider');
      // 1 signed page, the divider, 2 pages of the notice, then the certificate.
      pages.with = doc.getPageCount();
    } else {
      assert.ok(!text.includes(DIVIDER_TITLE), 'left out');
      pages.without = doc.getPageCount();
    }
    assert.ok(text.includes('GIVEN TO READ, NOT SIGNED'), 'the certificate always lists it');
    assert.ok(text.includes('Opened means'), 'and says what opened means');
    const sha = db.get("SELECT f.sha256 FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=? AND d.name='Privacy notice'", e.id).sha256;
    assert.ok(text.replace(/\s/g, '').includes(sha), 'with its SHA-256');
  }
  // The divider and the notice's 2 pages, and nothing else, come and go with the choice.
  assert.equal(pages.with - pages.without, 3);
  // The lines themselves, with a sheet that writes them down.
  const out: string[] = [];
  const s = { h2: (t: string) => out.push(`# ${t}`), text: (t: string) => out.push(t), kv: (k: string, v: string) => out.push(`${k}: ${v}`) };
  const e = { id: 'env_x', documents: [{ id: 'd', file_id: 'f', name: 'Terms', pages: 1, sha256: 'abc', supplemental: { rule: 'acknowledge', in_copy: true } }],
    recipients: [{ id: 'r', role: 'signer', name: 'Ada', status: 'completed', consent_at: null }, { id: 'w', role: 'witness', name: 'Wes', status: 'completed' }] };
  supplementCert(e, s, (x) => String(x), (x) => String(x));
  assert.ok(out.includes('# Given to read, not signed'));
  assert.ok(out.includes('SHA-256 of the file: abc'));
  assert.ok(out.includes('Ada: Not opened'));
  assert.ok(!out.some((l) => l.startsWith('Wes')), 'a witness has no rule to meet');
  assert.ok(!out.some((l) => /\bread\b/.test(l.replace('Given to read', '').replace('was read or understood', ''))), 'never says read');
  assert.equal(nameList(['A', 'B', 'C']), 'A, B and C');
});

test('4. templates and bulk carry the rule; the API lists it', async () => {
  const c = await person();
  const sign = await upload(c, 1);
  const notice = await upload(c, 1);
  const tpl = await c.post('/envelopes', {
    kind: 'template', subject: 'Lease template',
    documents: [{ id: 'd1', file_id: sign.id, name: 'Lease' }, { id: 'd2', file_id: notice.id, name: 'House rules', supplemental: { rule: 'open', in_copy: false } }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Tenant' }],
    fields: [{ id: 'f', document_id: 'd1', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  const used = await c.post('/envelopes', { template_id: tpl.data.envelope.id, subject: 'Lease for Tia' });
  assert.equal(used.status, 200, JSON.stringify(used.data));
  assert.deepEqual(used.data.envelope.documents.map((d: any) => d.supplemental), [null, { rule: 'open', in_copy: false }]);
  const bulk = await c.post('/bulk', { template_id: tpl.data.envelope.id, rows: [{ Tenant: { name: 'Tia', email: 'tia@supp.example' } }] });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  const made = db.get("SELECT d.supplemental, d.supplemental_copy FROM documents d JOIN envelopes e ON e.id=d.envelope_id WHERE e.bulk_id IS NOT NULL AND d.name='House rules'");
  assert.deepEqual({ ...made }, { supplemental: 'open', supplemental_copy: 0 });
  const { openapi: spec } = await import('../src/server/openapi.ts');
  assert.match(JSON.stringify(spec()), /supplemental/);
  assert.match(JSON.stringify(spec()), /supplements\/\{doc\}\/acknowledge/);
});

test('5. a rule changed after someone finished: on the record, and the certificate says they finished before it', async () => {
  const c = await person();
  const e = await envelope(c, 'none');
  await send(c, e);
  const ada = await signer(e, 'ada');
  assert.equal((await finish(ada)).status, 200);
  const cur = (await c.get(`/envelopes/${e.id}`)).data.envelope;
  const r = await c.put(`/envelopes/${e.id}`, { documents: [cur.documents[0], { ...cur.documents[1], supplemental: 'acknowledge' }], recipients: cur.recipients, fields: cur.fields });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // The audit trail says what changed and for whom.
  const said = audit(e.id).map((a) => `${a.action} ${a.detail}`).join('\n');
  assert.match(said, /The rule for "Privacy notice" changed from "None" to "Had to be acknowledged/);
  assert.ok(!/—/.test(said));
  // Ben, who has not finished, now has to tick it.
  const ben = await signer(e, 'ben');
  assert.equal((await finish(ben)).status, 400);
  assert.equal((await ben.s.post(`/sign/${ben.tok}/supplements/${e.documents[1].id}/acknowledge`)).status, 200);
  assert.equal((await finish(ben)).status, 200);
  // The certificate does not read as if Ada skipped a rule that was not there when she finished.
  const out: string[] = [];
  const s = { h2: (t: string) => out.push(`# ${t}`), text: (t: string) => out.push(t), kv: (k: string, v: string) => out.push(`${k}: ${v}`) };
  const { loadEnvelope } = await import('../src/server/envelopes.ts');
  supplementCert(loadEnvelope(e.id), s, (x) => String(x), (x) => String(x));
  const ada1 = out.find((l) => l.startsWith('Ada Signer:'))!;
  assert.match(ada1, /^Ada Signer: Not opened\. Finished .+, before the rule was changed; the rule then: "None"$/);
  const ben1 = out.find((l) => l.startsWith('Ben Signer:'))!;
  assert.match(ben1, /acknowledged receiving it/);
  assert.ok(!ben1.includes('before the rule was changed'), 'Ben finished under the rule as it is now');
  assert.ok(out.some((l) => /^Rule changed: .+, from "None" to "Had to be acknowledged/.test(l)));
  const pdf = await c.get(`/envelopes/${e.id}/download`);
  assert.match(await textOf(pdf.data), /before the rule was changed/);
});

test('6. a file to read fetched through the document route counts as opened, once', async () => {
  const c = await person();
  const e = await envelope(c, 'open');
  await send(c, e);
  const ada = await signer(e, 'ada');
  const r = await ada.s.get(`/sign/${ada.tok}/doc/${e.documents[1].id}`);
  assert.equal(r.status, 200);
  await ada.s.get(`/sign/${ada.tok}/supplements/${e.documents[1].id}`);
  assert.equal(audit(e.id).filter((a) => a.action === 'Opened Privacy notice').length, 1);
  assert.equal((await ada.view()).supplements[0].opened, true);
  // The file to sign fetched the same way is not a mark.
  await ada.s.get(`/sign/${ada.tok}/doc/${e.documents[0].id}`);
  assert.equal(db.get('SELECT COUNT(*) n FROM supplement_marks WHERE envelope_id=?', e.id).n, 1);
});
