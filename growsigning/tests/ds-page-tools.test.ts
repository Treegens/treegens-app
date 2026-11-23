// Removing, turning and moving pages of a document before it is sent (research/docusign-gaps.json, batch
// "page-tools"): src/lib/pages.ts (the rules), src/server/pages.ts (the new file, the audit line) and
// src/server/routes-pages.ts (POST /envelopes/:id/documents/:doc/pages).
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import { boot, Client, signUp, upload, draft, simple, signAll } from './helpers.ts';
import { planPages, moveFields, opWords, fieldWords, turnedSize, MAX_PAGE_OPS } from '../src/lib/pages.ts';

let db: Awaited<ReturnType<typeof boot>>['db'];
before(async () => {
  ({ db } = await boot());
});

let n = 0;
const person = async (name = 'Pia Pages') => signUp(name, `pia.${++n}@pages.example`, `10.88.${Math.floor(n / 250)}.${n % 250}`);
const pagesUrl = (e: any, d = e.documents[0].id) => `/envelopes/${e.id}/documents/${d}/pages`;
const audit = (id: string) => db.all("SELECT action, detail FROM audit WHERE envelope_id=? AND action='Pages changed' ORDER BY seq", id) as { action: string; detail: string }[];
const pdfOf = async (fileId: string) => PDFDocument.load(db.readBlob(db.get('SELECT sha256 FROM files WHERE id=?', fileId).sha256));
const textOfPage = async (fileId: string) => {
  const { extractPages } = await import('../src/server/text.ts');
  return extractPages(db.readBlob(db.get('SELECT sha256 FROM files WHERE id=?', fileId).sha256));
};
// A refusal is two sentences or more: what happened, then what to do, starting with a verb (research/ux-charter.md P10).
const plain = (m: string) => {
  assert.ok(!/—/.test(m), `no em dash: ${m}`);
  assert.ok(m.split(/(?<=\.)\s+/).length >= 2, `two sentences: ${m}`);
};

// A draft with three pages and fields on pages 1 and 3 (counted from 1), none on page 2.
async function threePages(c: Client) {
  const file = await upload(c, 3);
  const r = await c.post('/envelopes', {
    subject: 'Three pages',
    documents: [{ id: 'd', file_id: file.id, name: 'Contract' }],
    recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: `sam.${n}@pages.example` }],
    fields: [
      { id: 'f1', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 },
      { id: 'f3', document_id: 'd', recipient_id: 'r', type: 'date_signed', page: 2, x: 0.6, y: 0.1, w: 0.2, h: 0.03 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}

// ---- 1. The rules ----------------------------------------------------------------------------------------------

test('1. each operation: remove, turn, move, in order, each naming the page as it is at that moment', () => {
  const r = planPages(4, [{ op: 'remove', page: 2 }, { op: 'turn', page: 1, by: 90 }, { op: 'move', page: 3, to: 1 }]);
  assert.ok(!('error' in r));
  // After removing page 2: [0, 2, 3]. Turn the first. Then the third (old page 4) goes first.
  assert.deepEqual(r.plan, [{ from: 3, turn: 0 }, { from: 0, turn: 90 }, { from: 2, turn: 0 }]);
  // Two turns add up, and four quarters is upright again.
  const t = planPages(1, [{ op: 'turn', page: 1, by: 270 }, { op: 'turn', page: 1, by: 180 }]);
  assert.ok(!('error' in t) && t.plan[0].turn === 90);
  // ...and said as one turn: a quarter to the left.
  assert.ok(!('error' in t) && t.ops.length === 1 && t.ops[0].op === 'turn' && t.ops[0].by === 90);
  const round = planPages(2, [{ op: 'turn', page: 2, by: 180 }, { op: 'turn', page: 2, by: 180 }]);
  assert.ok(!('error' in round) && round.ops.length === 0);
  assert.equal(opWords({ op: 'remove', page: 3 }), 'Page 3 removed');
  assert.equal(opWords({ op: 'turn', page: 2, by: 90 }), 'Page 2 turned a quarter turn to the right');
  assert.equal(opWords({ op: 'move', page: 4, to: 1 }), 'Page 4 moved to place 1');
  assert.equal(fieldWords({ type: 'date_signed', page: 2 }, 'Ada'), 'Date signed for Ada on page 3');
  assert.deepEqual(turnedSize({ w: 612, h: 792 }, 270), { w: 792, h: 612 });
});

test('1. operations that cannot be done are refused in words, and none is half done', () => {
  const bad = [
    [3, [], 'No change'],
    [3, [{ op: 'remove', page: 4 }], 'page 4'],
    [3, [{ op: 'remove', page: 0 }], 'page 0'],
    [3, [{ op: 'turn', page: 1, by: 45 }], 'by 45'],
    [3, [{ op: 'move', page: 1, to: 9 }], 'place 9'],
    [3, [{ op: 'crop', page: 1 }], '"crop"'],
    [1, [{ op: 'remove', page: 1 }], 'last page'],
    [2, [{ op: 'remove', page: 1 }, { op: 'remove', page: 1 }], 'last page'],
    [3, Array.from({ length: MAX_PAGE_OPS + 1 }, () => ({ op: 'turn', page: 1, by: 90 })), `most is ${MAX_PAGE_OPS}`],
  ] as const;
  for (const [count, ops, says] of bad) {
    const r = planPages(count, ops);
    assert.ok('error' in r, JSON.stringify(ops).slice(0, 80));
    assert.ok(r.error.includes(says), r.error);
  }
});

test('1. fields follow their page, and on a turned page stay on the same words, upright and the same size', () => {
  const fields = [
    { id: 'a', document_id: 'd', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05 },
    { id: 'b', document_id: 'd', page: 1, x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
    { id: 'other', document_id: 'e', page: 1, x: 0.3, y: 0.3, w: 0.1, h: 0.1 },
  ];
  const size = { w: 600, h: 800 };
  const { fields: out, dropped } = moveFields(fields, 'd', [{ from: 1, turn: 0 }, { from: 0, turn: 90 }], [size, size]);
  assert.equal(dropped.length, 0);
  const a = out.find((f) => f.id === 'a')!, b = out.find((f) => f.id === 'b')!, other = out.find((f) => f.id === 'other')!;
  assert.equal(b.page, 0);
  assert.deepEqual([b.x, b.y, b.w, b.h], [0.5, 0.5, 0.1, 0.1]);
  assert.deepEqual(other, fields[2], 'another document is not touched');
  // Page a was 600 x 800 and is now 800 x 600. Its middle was at (120, 100) and is now at (800 - 100, 120) = (700, 120).
  assert.equal(a.page, 1);
  const near = (x: number, y: number) => assert.ok(Math.abs(x - y) < 1e-9, `${x} vs ${y}`);
  near((a.x + a.w / 2) * 800, 700);
  near((a.y + a.h / 2) * 600, 120);
  // Same size in points: 120 x 40, so still a wide box to sign on.
  near(a.w * 800, 120);
  near(a.h * 600, 40);
  // A field on a removed page is dropped, and said.
  const r = moveFields(fields, 'd', [{ from: 1, turn: 0 }]);
  assert.deepEqual(r.dropped.map((f) => f.id), ['a']);
  // Turned upside down: the box stays inside the page.
  const edge = moveFields([{ id: 'e', document_id: 'd', page: 0, x: 0.95, y: 0.95, w: 0.05, h: 0.05 }], 'd', [{ from: 0, turn: 180 }], [size]).fields[0];
  near(edge.x, 0);
  near(edge.y, 0);
});

// ---- 2. The route on a draft -----------------------------------------------------------------------------------

test('2. removing an empty page from a draft: a new file, the fields after it move up, an audit line, a new fingerprint', async () => {
  const c = await person();
  const e = await threePages(c);
  const before = e.documents[0];
  const r = await c.post(pagesUrl(e), { ops: [{ op: 'remove', page: 2 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = r.data.envelope.documents[0];
  assert.notEqual(after.file_id, before.file_id);
  assert.notEqual(after.sha256, before.sha256);
  assert.equal(after.pages, 2);
  assert.equal(after.name, 'Contract');
  const f3 = r.data.envelope.fields.find((f: any) => f.type === 'date_signed');
  assert.equal(f3.page, 1, 'the field of page 3 is now on page 2');
  assert.equal(r.data.envelope.fields.find((f: any) => f.type === 'signature').page, 0);
  // The new file has the words of pages 1 and 3, read again for search.
  assert.deepEqual((await textOfPage(after.file_id)).map((s: string) => s.trim()), ['Agreement page 1', 'Agreement page 3']);
  assert.match(db.get('SELECT text FROM files WHERE id=?', after.file_id).text || '', /Agreement page 3/);
  const lines = audit(e.id);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].detail, `Page 2 removed from "Contract". "Contract" now has 2 pages, SHA-256 ${after.sha256}.`);
  // The old file is still there, untouched: a copy someone already has stays what it was.
  assert.equal(db.get('SELECT pages FROM files WHERE id=?', before.file_id).pages, 3);
});

test('2. turning and moving: the page is turned in the PDF, its size swaps, and fields go with it', async () => {
  const c = await person();
  const e = await threePages(c);
  const r = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 1, by: 90 }, { op: 'move', page: 3, to: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data.envelope.documents[0];
  assert.deepEqual(d.page_sizes, [{ w: 612, h: 792 }, { w: 792, h: 612 }, { w: 612, h: 792 }]);
  const pdf = await pdfOf(d.file_id);
  assert.deepEqual(pdf.getPages().map((p) => p.getRotation().angle), [0, 90, 0]);
  assert.deepEqual((await textOfPage(d.file_id)).map((s: string) => s.trim()), ['Agreement page 3', 'Agreement page 1', 'Agreement page 2']);
  const f1 = r.data.envelope.fields.find((f: any) => f.type === 'signature'), f3 = r.data.envelope.fields.find((f: any) => f.type === 'date_signed');
  assert.equal(f3.page, 0);
  assert.equal(f1.page, 1);
  // The signature was 183.6 x 47.52 points with its middle at (153, 657.36); now at (792 - 657.36, 153) on 792 x 612.
  assert.ok(Math.abs((f1.x + f1.w / 2) * 792 - (792 - 657.36)) < 0.01);
  assert.ok(Math.abs((f1.y + f1.h / 2) * 612 - 153) < 0.01);
  assert.ok(Math.abs(f1.w * 792 - 183.6) < 0.01);
  assert.equal(audit(e.id)[0].detail.split(' "Contract" now')[0], 'Page 1 turned a quarter turn to the right in "Contract". Page 3 moved to place 1 in "Contract".');
});

test('2. a page that was already turned in the uploaded PDF keeps that turn and adds the new one', async () => {
  const c = await person();
  const d = await PDFDocument.create();
  d.addPage([612, 792]).setRotation(degrees(90));
  d.addPage([612, 792]);
  const f = new FormData();
  f.append('file', new Blob([await d.save()], { type: 'application/pdf' }), 'Sideways.pdf');
  const file = (await c.call('POST', '/files', f)).data;
  const e = (await c.post('/envelopes', { documents: [{ id: 'd', file_id: file.id }], recipients: [], fields: [] })).data.envelope;
  const r = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 1, by: 270 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await pdfOf(r.data.envelope.documents[0].file_id)).getPage(0).getRotation().angle, 0);
  assert.deepEqual(r.data.envelope.documents[0].page_sizes[0], { w: 612, h: 792 });
});

test('2. removing a page with fields is refused with the list of fields, unless drop_fields is true', async () => {
  const c = await person();
  const e = await threePages(c);
  const r = await c.post(pagesUrl(e), { ops: [{ op: 'remove', page: 3 }] });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'page_fields');
  assert.deepEqual(r.data.fields.map((f: any) => [f.type, f.page, f.recipient]), [['date_signed', 2, 'Sam Signer']]);
  assert.match(r.data.error, /Date signed for Sam Signer on page 3/);
  plain(r.data.error);
  // Nothing changed: no new document file, no audit line.
  assert.equal((await c.get(`/envelopes/${e.id}`)).data.envelope.documents[0].file_id, e.documents[0].file_id);
  assert.equal(audit(e.id).length, 0);
  const ok = await c.post(pagesUrl(e), { ops: [{ op: 'remove', page: 3 }], drop_fields: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.envelope.fields.map((f: any) => f.type), ['signature']);
  assert.equal(ok.data.removed_fields, 1);
});

test('2. templates can change their pages too', async () => {
  const c = await person();
  const file = await upload(c, 2);
  const t = (await c.post('/envelopes', { kind: 'template', subject: 'Lease', documents: [{ id: 'd', file_id: file.id, name: 'Lease' }], recipients: [{ id: 'r', role: 'signer', role_name: 'Tenant' }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }] })).data.envelope;
  const r = await c.post(pagesUrl(t), { ops: [{ op: 'move', page: 2, to: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.envelope.fields[0].page, 0);
});

// ---- 3. Who may, and when -----------------------------------------------------------------------------------------

test('3. someone else, another document id, a completed envelope: refused, nothing made', async () => {
  const c = await person();
  const e = await simple(c, `sam.${n}@pages.example`);
  const stranger = await person('Sly Stranger');
  const files = db.get('SELECT COUNT(*) n FROM files').n;
  assert.equal((await stranger.post(pagesUrl(e), { ops: [{ op: 'turn', page: 1, by: 90 }] })).status, 404);
  const wrong = await c.post(pagesUrl(e, 'doc_nope'), { ops: [{ op: 'turn', page: 1, by: 90 }] });
  assert.equal(wrong.status, 404);
  plain(wrong.data.error);
  const silly = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 7, by: 90 }] });
  assert.equal(silly.status, 400);
  plain(silly.data.error);
  const none = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 1, by: 90 }, { op: 'turn', page: 1, by: 270 }] });
  assert.equal(none.status, 400);
  plain(none.data.error);
  assert.equal(db.get('SELECT COUNT(*) n FROM files').n, files, 'no file stored for a refused request');
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, `sam.${n - 1}@pages.example`)).status, 200);
  const done = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 1, by: 90 }] });
  assert.equal(done.status, 409);
  assert.match(done.data.error, /completed, so its pages can no longer be changed\. Copy it/);
});

test('3. on an envelope that is out: through the correction, and with the sign-again choice once someone finished', async () => {
  const c = await person();
  const e = await draft(c);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  // Nobody has finished: turning page 2 is a correction like any other, and the audit trail says what was done.
  const r = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 2, by: 180 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.envelope.status, 'sent');
  assert.match(audit(e.id)[0].detail, /^Page 2 turned upside down in "Agreement"\./);
  assert.ok(db.all("SELECT 1 FROM audit WHERE envelope_id=? AND action='Envelope corrected'", e.id).length >= 1);
  // Ada signs. Now changing a page changes what she signed: refused until the sender chooses to ask her again.
  assert.equal((await signAll(e.id, 'ada@example.com')).status, 200);
  const again = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 2, by: 180 }] });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'sign_again');
  assert.deepEqual(again.data.sign_again, ['Ada Signer']);
  assert.equal(audit(e.id).length, 1, 'no line for a change that was not saved');
  const yes = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 2, by: 180 }], resign: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  assert.equal(yes.data.envelope.recipients.find((x: any) => x.email === 'ada@example.com').status, 'sent');
  assert.equal(audit(e.id).length, 2);
});

test('3. after the changes and the signatures, the certificate fingerprints the new file', async () => {
  const c = await person();
  const e = await threePages(c);
  const r = await c.post(pagesUrl(e), { ops: [{ op: 'remove', page: 2 }] });
  const sha = r.data.envelope.documents[0].sha256;
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, `sam.${n}@pages.example`)).status, 200);
  const pdf = await c.get(`/envelopes/${e.id}/download`);
  assert.equal(pdf.status, 200);
  const { extractText } = await import('../src/server/text.ts');
  const text = (await extractText(pdf.data)).replace(/\s+/g, ' ');
  assert.ok(text.includes(sha), 'the certificate names the new file');
  assert.ok(!text.includes(e.documents[0].sha256), 'and not the old one');
  assert.match(text, /Pages changed · Page 2 removed from "Contract"/);
});

// ---- 4. The editor's way: only the file, then the editor saves ------------------------------------------------------

test('4. "save": false makes only the file; the normal save then writes the audit line, also after two rounds', async () => {
  const c = await person();
  const e = await threePages(c);
  const one = await c.post(pagesUrl(e), { ops: [{ op: 'remove', page: 2 }], save: false });
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.equal(one.data.file.pages, 2);
  assert.deepEqual(one.data.plan, [{ from: 0, turn: 0 }, { from: 2, turn: 0 }]);
  assert.deepEqual(one.data.said, ['Page 2 removed']);
  assert.equal((await c.get(`/envelopes/${e.id}`)).data.envelope.documents[0].file_id, e.documents[0].file_id, 'the envelope is as it was');
  assert.equal(audit(e.id).length, 0);
  // A second round on the new file (the editor sends the file it now has as the document's).
  const doc = e.documents[0];
  const put1 = await c.put(`/envelopes/${e.id}`, { documents: [{ id: doc.id, file_id: one.data.file.id, name: 'Contract' }], fields: moveFields(e.fields, doc.id, one.data.plan).fields });
  assert.equal(put1.status, 200, JSON.stringify(put1.data));
  assert.equal(audit(e.id).length, 1);
  // Two rounds before the editor saves: the second starts from the file the first made ("file_id").
  const two = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 1, by: 90 }], save: false });
  assert.equal(two.status, 200);
  const next = await c.post(pagesUrl(e), { ops: [{ op: 'move', page: 2, to: 1 }], save: false, file_id: two.data.file.id });
  assert.equal(next.status, 200, JSON.stringify(next.data));
  // A file it just uploaded with Replace and has not saved is fine; a file of another account is not found.
  const replaced = await c.post(pagesUrl(e), { ops: [{ op: 'move', page: 2, to: 1 }], save: false, file_id: (await upload(c, 2)).id });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.data));
  const someone = await person('Sid Else');
  const foreign = await c.post(pagesUrl(e), { ops: [{ op: 'move', page: 2, to: 1 }], save: false, file_id: (await upload(someone, 2)).id });
  assert.equal(foreign.status, 404);
  plain(foreign.data.error);
  assert.equal((await c.put(`/envelopes/${e.id}`, { documents: [{ id: doc.id, file_id: next.data.file.id, name: 'Contract' }], fields: [] })).status, 200);
  const last = audit(e.id).at(-1)!.detail;
  assert.match(last, /^Page 1 turned a quarter turn to the right in "Contract"\. Page 2 moved to place 1 in "Contract"\. "Contract" now has 2 pages/);
});

test('4. a file that was replaced by another upload is not called a page change', async () => {
  const c = await person();
  const e = await threePages(c);
  const other = await upload(c, 2);
  assert.equal((await c.put(`/envelopes/${e.id}`, { documents: [{ id: e.documents[0].id, file_id: other.id, name: 'Contract' }], fields: [] })).status, 200);
  assert.equal(audit(e.id).length, 0);
});

test('4. a file made from a file of another account cannot be had', async () => {
  const c = await person();
  const e = await threePages(c);
  const { remakeFile } = await import('../src/server/pages.ts');
  const thief = await person('Theo Thief');
  const acc = db.get('SELECT account_id FROM files WHERE id=?', (await upload(thief, 1)).id).account_id;
  await assert.rejects(() => remakeFile(acc, e.documents[0].file_id, [{ op: 'remove', page: 1 }]), /no longer exists/);
});

test('5. the API description lists the route', async () => {
  const c = new Client();
  const doc = (await c.get('/openapi.json')).data;
  assert.ok(doc.paths['/envelopes/{id}/documents/{doc}/pages'].post);
  assert.ok(!JSON.stringify(doc.paths['/envelopes/{id}/documents/{doc}/pages']).includes('—'));
});

test('6. each change that stores a file counts: 120 an hour for one account, then a refusal that says what and how long', async () => {
  const c = await person();
  const e = await threePages(c);
  // Mistakes store nothing and are not counted.
  for (let i = 0; i < 130; i++) assert.equal((await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 9, by: 90 }] })).status, 400);
  let last: any;
  for (let i = 0; i < 120; i++) {
    last = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 1, by: 90 }], save: false });
    assert.equal(last.status, 200, `change ${i + 1}: ${JSON.stringify(last.data)}`);
  }
  const files = db.get('SELECT COUNT(*) n FROM files').n;
  last = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 1, by: 90 }], save: false });
  assert.equal(last.status, 429);
  assert.match(last.data.error, /Pages were changed 120 times in the last hour/);
  assert.match(last.data.error, /Try again in \d+ minutes?\./);
  plain(last.data.error);
  assert.equal(db.get('SELECT COUNT(*) n FROM files').n, files, 'nothing stored once the hour is used up');
});

// ---- 7. Repairs after review -------------------------------------------------------------------------------

test('7. a page number written as text is refused with words that say so', async () => {
  for (const [ops, want] of [
    [[{ op: 'remove', page: '1' }], /names the page as text, "1"\. Write the page as a plain number without quotes/],
    [[{ op: 'move', page: 1, to: '2' }], /names the place as text, "2"/],
    [[{ op: 'turn', page: 1, by: '90' }], /names the turn as text, "90"/],
  ] as const) {
    const r = planPages(2, ops);
    assert.ok('error' in r);
    assert.match(r.error, want);
    plain(r.error);
  }
});

test('7. a converted file keeps its original and its conversion record when its pages change', async () => {
  const was = process.env.CONVERTER;
  process.env.CONVERTER = 'stub';
  try {
    const c = await person('Cora Convert');
    const f = new FormData();
    f.append('file', new Blob([`<html><body><h1>Contract</h1><p>${'Words here. '.repeat(50)}</p></body></html>`], { type: 'text/html' }), 'Contract.html');
    const up = await c.call('POST', '/files', f);
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.ok(up.data.converted, 'the stub converter made a PDF');
    const e = (await c.post('/envelopes', { subject: 'Conv', documents: [{ id: 'd', file_id: up.data.id, name: 'Contract' }],
      recipients: [{ id: 'r', role: 'signer', name: 'Sam S', email: `sam.conv.${n}@pages.example` }],
      fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
    const p = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 1, by: 180 }] });
    assert.equal(p.status, 200, JSON.stringify(p.data));
    assert.equal(p.data.file.converted?.from, 'Contract.html');
    const nf = p.data.file.id;
    assert.notEqual(nf, up.data.id);
    const o = await c.get(`/files/${nf}/original`);
    assert.equal(o.status, 200, JSON.stringify(o.data));
    assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
    const actions = db.all('SELECT action FROM audit WHERE envelope_id=? ORDER BY seq', e.id).map((x: any) => x.action);
    assert.ok(actions.includes('Converted to PDF'), actions.join(' | '));
    assert.ok(actions.includes('Pages changed'), actions.join(' | '));
  } finally {
    if (was === undefined) delete process.env.CONVERTER;
    else process.env.CONVERTER = was;
  }
});

test('7. someone asked to sign again is told which pages changed, not only that the file was replaced', async () => {
  const c = await person();
  const file = await upload(c, 2);
  const ada = `ada.${n}@pages.example`;
  const e = (await c.post('/envelopes', {
    subject: 'Out', documents: [{ id: 'd', file_id: file.id, name: 'Contract' }],
    recipients: [{ id: 'r1', role: 'signer', name: 'Ada One', email: ada }, { id: 'r2', role: 'signer', name: 'Ben Two', email: `ben.${n}@pages.example` }],
    fields: [{ id: 'f1', document_id: 'd', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }, { id: 'f2', document_id: 'd', recipient_id: 'r2', type: 'signature', page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }],
  })).data.envelope;
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  await signAll(e.id, ada);
  const no = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 2, by: 90 }] });
  assert.equal(no.status, 409);
  assert.match(no.data.error, /The pages of document "Contract" were changed: Page 2 turned a quarter turn to the right\./);
  assert.ok(!/was replaced/.test(no.data.error), no.data.error);
  const yes = await c.post(pagesUrl(e), { ops: [{ op: 'turn', page: 2, by: 90 }], resign: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  const mail = db.all('SELECT html FROM emails WHERE to_email=? ORDER BY id', ada).at(-1)?.html || '';
  assert.match(mail, /Page 2 turned a quarter turn to the right/);
});

test('7. a file made from the document by someone else is checked for held-back templates too', async () => {
  // Olive owns the account, Otto is a member. Otto's draft has file F. Olive makes a template with F, holds it back for
  // admins only, and changes its pages: G is made from F. Otto must not get a copy of G by naming it.
  const owner = await person('Olive Owner');
  const email = `otto.${n}@pages.example`;
  assert.equal((await owner.post('/account/invites', { email, role: 'member' })).status, 200);
  const otto = Object.assign(new Client(), { ip: `10.89.${Math.floor(n / 250)}.${n % 250}` });
  const inv = db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY created_at DESC', email).token;
  assert.equal((await otto.post('/auth/signup', { name: 'Otto Other', email, password: 'correct horse battery', invite: inv })).status, 200);
  const mine = await threePages(otto);
  const fileF = mine.documents[0].file_id;
  const t = await owner.post('/envelopes', { kind: 'template', subject: 'Held', documents: [{ id: 'd', file_id: fileF, name: 'Held' }], recipients: [{ id: 'r', role: 'signer', role_name: 'Client' }], fields: [] });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const tpl = t.data.envelope;
  assert.equal((await owner.put(`/envelopes/${tpl.id}/access`, { use: 'admins' })).status, 200);
  const g = await owner.post(pagesUrl(tpl), { ops: [{ op: 'remove', page: 2 }] });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  const fileG = g.data.file.id;
  const before = db.get('SELECT COUNT(*) n FROM files').n;
  const r = await otto.post(pagesUrl(mine), { ops: [{ op: 'turn', page: 1, by: 90 }], save: false, file_id: fileG });
  assert.equal(r.status, 404, JSON.stringify(r.data));
  plain(r.data.error);
  assert.equal(db.get('SELECT COUNT(*) n FROM files').n, before);
  // His own file, and one he made from it a moment ago, still work.
  const own = await otto.post(pagesUrl(mine), { ops: [{ op: 'turn', page: 1, by: 90 }], save: false });
  assert.equal(own.status, 200);
  assert.equal((await otto.post(pagesUrl(mine), { ops: [{ op: 'turn', page: 1, by: 90 }], save: false, file_id: own.data.file.id })).status, 200);
});
