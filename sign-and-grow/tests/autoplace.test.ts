// Tests for the editor's own logic, all of it plain functions:
//   - "Find fields for me": spotting form fields, labels with blanks and {{tags}} in a document,
//   - snapping fields into line while dragging,
//   - what the review step says will happen to each person when a sent envelope is corrected. That one is checked
//     against the real server, so the editor never promises something the server does not do.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { findFields, findInText, findInWidgets, fieldForLabel, overlap, withoutTaken, placeTextItem, placeRect, widgetFrom, scanPdf, readableName, type TextItem, type PageScan } from '../src/lib/autoplace.ts';
import { snapBox } from '../src/components/editor/snap.ts';
import { outcomes, rebase, restoreLocked, touchesLocked, fingerprint } from '../src/components/editor/changes.ts';
import { boot, Client, draft, signUp, signAll, tokenFor, mailTo } from './helpers.ts';

const LETTER = { w: 612, h: 792 };
let helv: PDFFont;
before(async () => {
  helv = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
});

// A line of 12pt Helvetica, measured with the real font so the positions are the ones a PDF would have.
// `top` is the distance from the top of the page to the baseline.
const line = (str: string, top: number, x = 72, size = 12): TextItem => ({ str, x, y: top, w: helv.widthOfTextAtSize(str, size), h: size });
const widthOf = (s: string, size = 12) => helv.widthOfTextAtSize(s, size);
const page = (...items: TextItem[]): PageScan => ({ size: LETTER, items });
const near = (actual: number, expected: number, tolerance: number, what: string) => assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

test('labels followed by a blank get the matching field over the blank', () => {
  const found = findInText(page(
    line('Signatures', 92, 72, 22),
    line('Signature: ______________________', 142),
    line('Name: ______________________', 198),
    line('Date: ______________________', 254),
    line('Initials: ______', 310),
  ));
  assert.deepEqual(found.map((f) => f.type), ['signature', 'full_name', 'date_signed', 'initials']);
  const [sig, name, , initials] = found;

  // The field starts where the underscores start and is as wide as they are, to within a point or two.
  near(sig.x * 612, 72 + widthOf('Signature: '), 2, 'signature left edge');
  near(sig.w * 612, widthOf('______________________'), 3, 'signature width');
  near(name.x * 612, 72 + widthOf('Name: '), 2, 'name left edge');
  near(initials.w * 612, widthOf('______'), 2, 'initials width');

  // It sits on the line: the bottom edge is just under the baseline, and a signature is taller than a name.
  near((sig.y + sig.h) * 792, 142 + 2.6, 1, 'signature bottom');
  near((name.y + name.h) * 792, 198 + 2.6, 1, 'name bottom');
  assert.ok(sig.h > name.h * 1.5, 'signature fields are taller');
  assert.ok(sig.y * 792 > 92 + 5, 'and stay clear of the heading above');
  for (const f of found) assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.w <= 1 && f.y + f.h <= 1, 'every field is on the page');
});

test('two labels on one line each get their own blank', () => {
  const found = findInText(page(line('Full name: ______________________     Date: ______________', 300)));
  assert.deepEqual(found.map((f) => f.type), ['full_name', 'date_signed']);
  const [name, date] = found;
  near(name.x * 612, 72 + widthOf('Full name: '), 2, 'name left edge');
  near(date.x * 612, 72 + widthOf('Full name: ______________________     Date: '), 3, 'date left edge');
  assert.ok(name.x + name.w < date.x, 'the two fields do not touch');

  // pdf.js hands the same line over as separate runs. The result is the same.
  const first = 'Full name: ______________________';
  const gap = widthOf('     ');
  const split = findInText(page(line(first, 300), line('Date: ______________', 300, 72 + widthOf(first) + gap)));
  assert.deepEqual(split.map((f) => f.type), ['full_name', 'date_signed']);
  near(split[1].x, date.x, 0.01, 'date left edge when split');

  // A label and its underline can be separate runs too.
  const apart = findInText(page(line('Signature:', 300), line('________________', 300, 72 + widthOf('Signature: '))));
  assert.deepEqual(apart.map((f) => f.type), ['signature']);
  near(apart[0].x * 612, 72 + widthOf('Signature: '), 1, 'signature left edge when split');
});

test('only labels we know are matched, and only when a blank follows', () => {
  const none = findInText(page(
    line('Number of seedlings pledged: ______________________', 100),
    line('Bank name: ______________________', 130),
    line('Start date: ____________', 160),
    line('Date: 5 March 2026', 190),
    line('The name of the game is patience.', 220),
    line('This document must be signed by both parties in the presence of a witness as follows:', 250),
    line('Chapter 1 ........................................ 4', 280),
  ));
  assert.deepEqual(none, []);

  const some = findInText(page(
    line('1. Signature of the Sponsor: ______________', 100),
    line('Print name ______________', 130),
    line('E-mail: ......................', 160),
    line('Job title: ____________   Company: ____________', 190),
  ));
  assert.deepEqual(some.map((f) => f.type), ['signature', 'full_name', 'email', 'title', 'company']);

  for (const [label, type] of [['Signature', 'signature'], ['Sign here', 'signature'], ['Signed by', 'signature'], ['Initials', 'initials'], ['Date', 'date_signed'], ['Name', 'full_name'],
    ['Full name', 'full_name'], ['Print name', 'full_name'], ['Title', 'title'], ['Company', 'company'], ['Email', 'email'], ['Amount', null], ['Date of birth', null]] as const)
    assert.equal(fieldForLabel(`${label}:`), type, label);
});

test('a label with only a colon counts at the end of a line or before another label', () => {
  const found = findInText(page(
    line('Signed by the Sponsor:', 100),
    line('Date:', 196),
    line('Name:', 260), line('Title:', 260, 320),
  ));
  assert.deepEqual(found.map((f) => f.type), ['signature', 'date_signed', 'full_name', 'title']);
  const [sig, , name, title] = found;
  assert.ok(sig.x * 612 > 72 + widthOf('Signed by the Sponsor:'), 'the field starts after the colon');
  assert.ok((name.x + name.w) * 612 < 320, 'and stops before the next label');
  assert.ok(title.x * 612 > 320 + widthOf('Title:'));
});

test('tags in the text become fields, with a signer number and a label when given', () => {
  const found = findInText(page(
    line('{{signature}}', 100),
    line('{{initials}}   {{date}}', 160),
    line('{{name}} {{email}}', 200),
    line('{{text:Some label}}', 240),
    line('{{signature2}} {{ Date2 }}', 300),
    line('{{checkbox}} I agree. {{unknown}} {{signature', 340),
  ));
  assert.deepEqual(found.map((f) => [f.type, f.signer ?? null, f.label ?? null]), [
    ['signature', null, null], ['initials', null, null], ['date_signed', null, null], ['full_name', null, null], ['email', null, null],
    ['text', null, 'Some label'], ['signature', 2, null], ['date_signed', 2, null], ['checkbox', null, null],
  ]);
  assert.ok(found.every((f) => f.source === 'tag'));
  near(found[0].x * 612, 72, 0.5, 'a tag field starts where the tag starts');
  near(found[0].w, 0.22, 0.005, 'and has the usual width for its type');
  const [name, email] = [found[3], found[4]];
  assert.ok(name.x + name.w <= email.x + 0.001, 'neighbouring tags do not overlap');
  assert.ok(name.w * 612 >= widthOf('{{name}}') - 1, 'a tag is always fully covered');
  const box = found[8];
  near(box.w * 612, box.h * 792, 1, 'a checkbox is square');
});

test('form fields in the PDF become fields of the same kind', () => {
  const upright = [1, 0, 0, -1, 0, 792];
  const widgets = [
    { subtype: 'Widget', fieldType: 'Tx', fieldName: 'client.full_name', rect: [72, 300, 272, 320] },
    { subtype: 'Widget', fieldType: 'Btn', checkBox: true, fieldName: 'agree', rect: [72, 250, 86, 264], required: true },
    { subtype: 'Widget', fieldType: 'Sig', fieldName: 'Signature1', rect: [72, 100, 272, 150] },
    { subtype: 'Widget', fieldType: 'Ch', fieldName: 'colour', rect: [72, 200, 192, 220], options: [{ exportValue: 'r', displayValue: 'Red' }, { exportValue: 'g', displayValue: 'Green' }] },
    { subtype: 'Widget', fieldType: 'Btn', pushButton: true, fieldName: 'submit', rect: [300, 100, 380, 120] },
    { subtype: 'Widget', fieldType: 'Tx', fieldName: 'hidden', rect: [72, 400, 272, 420], hidden: true },
    { subtype: 'Link', rect: [0, 0, 10, 10] },
  ].map((a) => widgetFrom(a, upright)).filter(Boolean) as any[];
  assert.deepEqual(widgets.map((w) => w.kind), ['text', 'checkbox', 'signature', 'dropdown']);

  const found = findInWidgets({ size: LETTER, items: [], widgets });
  assert.deepEqual(found.map((f) => f.type), ['text', 'checkbox', 'signature', 'dropdown']);
  const [text, check, , drop] = found;
  // PDF rectangles count from the bottom left; fields count from the top left.
  near(text.x, 72 / 612, 1e-6, 'x');
  near(text.y, (792 - 320) / 792, 1e-6, 'y');
  near(text.w, 200 / 612, 1e-6, 'w');
  near(text.h, 20 / 792, 1e-6, 'h');
  assert.equal(text.label, 'client full name');
  assert.equal(check.required, true);
  assert.deepEqual(drop.options, ['Red', 'Green']);
  assert.equal(readableName('topmostSubform[0].Page1[0].f1_01[0]'), '', 'machine names are not shown to signers');

  // A page turned on its side still maps to where the field is drawn.
  const turned = placeRect([72, 300, 272, 320], [0, 1, 1, 0, 0, 0]);
  assert.deepEqual(turned, { x: 300, y: 72, w: 20, h: 200 });
});

test('nothing is ever stacked on a field that is already there', () => {
  const pages = [page(line('Signature: ______________________', 142), line('Date: ______________________', 254))];
  const found = findFields(pages);
  assert.equal(found.length, 2);
  assert.equal(found[0].page, 0);

  // Same spot found twice (a form field and a label for the same blank): the form field wins, the label is dropped.
  const sig = found[0];
  const both = findFields([{ ...pages[0], widgets: [{ kind: 'signature', x: sig.x * 612, y: sig.y * 792, w: sig.w * 612, h: sig.h * 792 }] }]);
  assert.deepEqual(both.map((f) => [f.type, f.source]), [['signature', 'form'], ['date_signed', 'label']]);

  // Fields the sender already placed are left alone; only the free spots are offered.
  const existing = [{ page: 0, x: sig.x + 0.01, y: sig.y, w: sig.w, h: sig.h }];
  assert.deepEqual(withoutTaken(found, existing).map((f) => f.type), ['date_signed']);
  assert.deepEqual(withoutTaken(found, [{ ...existing[0], page: 1 }]).length, 2, 'a field on another page is not in the way');
  assert.equal(withoutTaken(found, found).length, 0, 'running it twice adds nothing the second time');
  assert.equal(overlap({ x: 0, y: 0, w: 0.2, h: 0.1 }, { x: 0.1, y: 0, w: 0.2, h: 0.1 }), 0.5);
  assert.equal(overlap({ x: 0, y: 0, w: 0.2, h: 0.1 }, { x: 0.2, y: 0, w: 0.2, h: 0.1 }), 0);
});

test('text positions from pdf.js are turned the right way up, and sideways text is ignored', () => {
  const upright = [1, 0, 0, -1, 0, 792];
  assert.deepEqual(placeTextItem({ str: 'Name:', transform: [12, 0, 0, 12, 72, 650], width: 33, height: 12 }, upright), { str: 'Name:', x: 72, y: 142, w: 33, h: 12 });
  assert.equal(placeTextItem({ str: 'Name:', transform: [0, 12, -12, 0, 72, 650], width: 33, height: 12 }, upright), null, 'text running up the page');
  assert.equal(placeTextItem({ str: '   ', transform: [12, 0, 0, 12, 72, 650], width: 10, height: 0 }, upright), null, 'whitespace');
});

test('a real PDF read with pdf.js gives fields in the right places', async () => {
  // The same pages the dev seed script makes, plus a tag line and two form fields.
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const p1 = d.addPage([612, 792]);
  ['This agreement is made between the Planting Partner and the Sponsor.', '', 'Number of seedlings pledged: ______________________', '', 'Full name: ______________________     Date: ______________']
    .forEach((l, i) => p1.drawText(l, { x: 72, y: 650 - i * 28, size: 12, font }));
  const p2 = d.addPage([612, 792]);
  ['Signature: ______________________', '', 'Name: ______________________', '', 'Date: ______________________', '', 'Initials: ______', '', '{{signature2}}']
    .forEach((l, i) => p2.drawText(l, { x: 72, y: 650 - i * 28, size: 12, font }));
  const form = d.getForm();
  form.createTextField('company').addToPage(p2, { x: 72, y: 200, width: 200, height: 20 });
  form.createCheckBox('agree').addToPage(p2, { x: 72, y: 150, width: 14, height: 14 });

  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await d.save()), verbosity: 0 }).promise;
  const seen: number[] = [];
  const found = findFields(await scanPdf(doc, (n) => seen.push(n)));
  await doc.destroy();
  assert.deepEqual(seen, [1, 2], 'progress is reported page by page');

  assert.deepEqual(found.filter((f) => f.page === 0).map((f) => f.type), ['full_name', 'date_signed']);
  assert.deepEqual(found.filter((f) => f.page === 1).map((f) => [f.type, f.source, f.signer ?? null]), [
    ['signature', 'label', null], ['full_name', 'label', null], ['date_signed', 'label', null], ['initials', 'label', null], ['signature', 'tag', 2], ['text', 'form', null], ['checkbox', 'form', null],
  ]);
  const sig = found.find((f) => f.page === 1 && f.type === 'signature')!;
  near(sig.x * 612, 72 + font.widthOfTextAtSize('Signature: ', 12), 2, 'signature left edge');
  near((sig.y + sig.h) * 792, 792 - 650 + 2.6, 1.5, 'signature bottom edge');
  const company = found.find((f) => f.source === 'form' && f.type === 'text')!;
  near(company.y * 792, 792 - 220, 1.5, 'form field top edge');
  assert.equal(company.label, 'company');
});

// ---- Snapping ----------------------------------------------------------------------------------------------------

test('a dragged field snaps to the edges and centres of its neighbours and reports the guide', () => {
  const other = { x: 0.2, y: 0.5, w: 0.2, h: 0.04 };
  const tol = { x: 0.006, y: 0.006 };

  // Left edge to left edge.
  let s = snapBox({ x: 0.203, y: 0.3, w: 0.1, h: 0.03 }, [other], 'move', tol);
  near(s.box.x, 0.2, 1e-9, 'left edges line up');
  assert.equal(s.box.y, 0.3, 'the other axis is left alone');
  assert.deepEqual(s.guides.map((g) => g.axis), ['x']);
  near(s.guides[0].at, 0.2, 1e-9, 'guide position');
  near(s.guides[0].from, 0.3, 1e-9, 'the guide runs from the moving field');
  near(s.guides[0].to, 0.54, 1e-9, 'to the far side of the field it lined up with');

  // Centre to centre, on both axes at once.
  s = snapBox({ x: 0.252, y: 0.503, w: 0.1, h: 0.03 }, [other], 'move', tol);
  near(s.box.x + s.box.w / 2, 0.3, 1e-9, 'centres line up');
  near(s.box.y + s.box.h / 2, 0.52, 1e-9, 'middles line up');
  assert.equal(s.guides.length, 2);

  // Too far away: nothing moves and there is no guide.
  s = snapBox({ x: 0.22, y: 0.3, w: 0.1, h: 0.03 }, [other], 'move', tol);
  assert.deepEqual([s.box.x, s.box.y, s.guides.length], [0.22, 0.3, 0]);

  // Resizing only moves the edge being pulled.
  s = snapBox({ x: 0.1, y: 0.3, w: 0.297, h: 0.03 }, [other], 'resize', tol);
  near(s.box.w, 0.3, 1e-9, 'right edge meets the other right edge');
  assert.equal(s.box.x, 0.1);

  // The nearest line wins, and a field is never pushed off the page.
  s = snapBox({ x: 0.196, y: 0.1, w: 0.1, h: 0.03 }, [other, { x: 0.199, y: 0.7, w: 0.3, h: 0.03 }], 'move', tol);
  near(s.box.x, 0.199, 1e-9, 'nearest wins');
  s = snapBox({ x: 0.001, y: 0.1, w: 0.1, h: 0.03 }, [{ x: -0.004, y: 0.4, w: 0.1, h: 0.03 }], 'move', tol);
  assert.ok(s.box.x >= 0, 'stays on the page');
  assert.deepEqual(snapBox({ x: 0.5, y: 0.5, w: 0.1, h: 0.03 }, [], 'move', tol).guides, []);
});

// ---- Correcting an envelope that is already out -------------------------------------------------------------------

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const asBody = (e: any) => ({ subject: e.subject, message: e.message, ordered: e.ordered, documents: e.documents, recipients: e.recipients, fields: e.fields });
const kinds = (r: { people: any[] }) => Object.fromEntries(r.people.map((p) => [p.name, p.kind]));

test('the review step says what really happens to each person', async () => {
  await boot();
  const jo = await signUp('Jo Sender', 'jo@example.com');
  const full = async () => (await jo.get(`/envelopes/${e0.id}`)).data.envelope;
  const e0 = await draft(jo, { ordered: false });
  await jo.post(`/envelopes/${e0.id}/send`);
  let e = await full();
  const adaToken = tokenFor(e.id, 'ada@example.com');
  const benToken = tokenFor(e.id, 'ben@example.com');

  // Move one of Ada's fields, fix Ben's email, drop the copy recipient, add a new signer.
  const body = clone(asBody(e));
  body.fields.find((f: any) => f.type === 'text').x = 0.5;
  body.recipients.find((r: any) => r.email === 'ben@example.com').email = 'benjamin@example.com';
  body.recipients = body.recipients.filter((r: any) => r.role !== 'cc');
  body.recipients.push({ id: 'rcp_AAAAAAAAAAAAAAAA', role: 'signer', name: 'Dee New', email: 'dee@example.com', routing_order: 1 });
  body.fields.push({ id: 'fld_AAAAAAAAAAAAAAAA', document_id: e.documents[0].id, recipient_id: 'rcp_AAAAAAAAAAAAAAAA', type: 'signature', page: 0, x: 0.6, y: 0.2, w: 0.2, h: 0.05 });

  const said = outcomes(e, body);
  assert.deepEqual(kinds(said), { 'Ada Signer': 'updated', 'Ben Signer': 'new_link', 'Dee New': 'invited', 'Cee Copy': 'removed' });
  assert.equal(said.completes, false);
  assert.match(said.people.find((p) => p.name === 'Ben Signer')!.text, /new link by email now/);
  assert.notEqual(fingerprint(body, body), fingerprint(e, e), 'the editor knows something changed');
  assert.equal(touchesLocked(e, body), false, 'nobody has finished, so nothing is locked');

  const adaMails = mailTo('ada@example.com').length;
  assert.equal((await jo.put(`/envelopes/${e.id}`, body)).status, 200);
  // ...and that is what the server did.
  assert.equal(tokenFor(e.id, 'ada@example.com'), adaToken, 'Ada keeps her link');
  assert.equal(mailTo('ada@example.com').length, adaMails + 1);
  assert.ok(mailTo('ada@example.com').at(-1)!.subject.startsWith('Updated:'), 'and is told it changed');
  assert.equal((await new Client().get(`/sign/${benToken}`)).status, 410, "Ben's old link stopped working");
  assert.equal(mailTo('benjamin@example.com').length, 1, 'and a new one went to the new address');
  assert.equal(mailTo('dee@example.com').length, 1, 'the new signer is invited');
  assert.ok(!mailTo('cee@example.com').some((m) => m.subject.startsWith('No longer needed')), 'someone who only had a copy is not emailed again');

  // Nothing changed: nobody notices anything.
  e = await full();
  assert.deepEqual([...new Set(outcomes(e, clone(asBody(e))).people.map((p) => p.kind))], ['unchanged']);
  assert.equal(fingerprint(e, e), fingerprint(asBody(e), clone(asBody(e))));

  // ---- A signer finishes while the sender still has the editor open ----
  const base = e; // what the editor loaded
  assert.equal((await signAll(e.id, 'ada@example.com')).status, 200);
  const ada = base.recipients.find((r: any) => r.email === 'ada@example.com').id;
  const ben = base.recipients.find((r: any) => r.email === 'benjamin@example.com').id;

  // The sender only moved one of Ben's fields. The editor's copy is out of date and has Ada's answer blank, but the
  // server keeps whatever a signer entered, so even this save cannot wipe it.
  const mine = clone(asBody(base));
  mine.fields.find((f: any) => f.recipient_id === ben && f.type === 'signature').x = 0.55;
  assert.equal((await jo.put(`/envelopes/${e.id}`, mine)).status, 200);
  assert.equal((await full()).fields.find((f: any) => f.recipient_id === ada && f.type === 'text').value, 'filled in', 'a stale editor cannot blank what Ada typed');

  // Catching up first folds in what Ada did, finds no clash, and the same change goes through.
  let fresh = await full();
  let merged = rebase(base, fresh, mine);
  assert.deepEqual(merged.conflict, []);
  assert.equal(merged.fields.find((f: any) => f.recipient_id === ada && f.type === 'text').value, 'filled in');
  assert.equal(merged.recipients.find((r: any) => r.id === ada).status, 'completed');
  const caughtUp = { ...mine, recipients: merged.recipients, fields: merged.fields };
  assert.equal(outcomes(fresh, caughtUp).people.find((p) => p.name === 'Ada Signer')!.kind, 'finished');
  // The move already went through with the first save, so relative to the server nothing is left to change for Ben.
  assert.equal(outcomes(fresh, caughtUp).people.find((p) => p.name === 'Ben Signer')!.kind, 'unchanged');
  assert.equal((await jo.put(`/envelopes/${e.id}`, caughtUp)).status, 200);
  fresh = await full();
  assert.equal(fresh.fields.find((f: any) => f.recipient_id === ada && f.type === 'text').value, 'filled in', "Ada's answer survived");
  assert.equal(fresh.fields.find((f: any) => f.recipient_id === ben && f.type === 'signature').x, 0.55);

  // If the sender did change Ada's part, the editor sees the clash before the server has to say no...
  const clash = clone(asBody(base));
  clash.fields.find((f: any) => f.recipient_id === ada && f.type === 'signature').y = 0.6;
  clash.recipients.find((r: any) => r.id === ben).name = 'Benjamin Signer';
  merged = rebase(base, fresh, clash);
  assert.deepEqual(merged.conflict, ['Ada Signer']);
  const stillClashing = { ...clash, recipients: merged.recipients, fields: merged.fields };
  assert.equal(touchesLocked(fresh, stillClashing), true);
  assert.equal((await jo.put(`/envelopes/${e.id}`, stillClashing)).status, 409, 'and the server agrees');

  // ...and can put her part back while keeping the rest of the sender's changes.
  const fixed = { ...clash, ...restoreLocked(fresh, stillClashing) };
  assert.equal(touchesLocked(fresh, fixed), false);
  assert.equal(fixed.recipients.find((r: any) => r.id === ben).name, 'Benjamin Signer');
  assert.equal((await jo.put(`/envelopes/${e.id}`, fixed)).status, 200);
  assert.equal((await full()).recipients.find((r: any) => r.id === ben).name, 'Benjamin Signer');
});

test('with a signing order, people are only told when it is their turn', () => {
  const doc = { id: 'd', file_id: 'f', name: 'Agreement' };
  const field = (id: string, rid: string) => ({ id, document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05, required: 1 });
  const before = {
    ordered: 1, documents: [doc],
    recipients: [
      { id: 'a', role: 'signer', name: 'Ada', email: 'ada@example.com', routing_order: 1, status: 'sent' },
      { id: 'b', role: 'signer', name: 'Ben', email: 'ben@example.com', routing_order: 2, status: 'pending' },
      { id: 'c', role: 'cc', name: 'Cee', email: 'cee@example.com', routing_order: 3, status: 'pending' },
    ],
    fields: [field('f1', 'a'), field('f2', 'b')],
  };

  // Ben is renamed and someone is added at the end: nothing goes out to either yet.
  let after: any = clone(before);
  after.recipients[1].name = 'Benjamin';
  after.recipients.push({ id: 'n', role: 'signer', name: 'New', email: 'new@example.com', routing_order: 4 });
  after.fields.push(field('f3', 'n'));
  let said = outcomes(before, after);
  assert.deepEqual(kinds(said), { Ada: 'unchanged', Benjamin: 'waiting', Cee: 'waiting', New: 'invited' });
  assert.match(said.people[1].text, /Nothing is sent until it is their turn/);
  assert.match(said.people[3].text, /invited when it is their turn/);

  // Ada is taken off: she is told, and it becomes Ben's turn.
  after = clone(before);
  after.recipients.shift();
  after.fields.shift();
  said = outcomes(before, after);
  assert.deepEqual(kinds(said), { Ben: 'waiting', Cee: 'waiting', Ada: 'removed' });
  assert.match(said.people[0].text, /now their turn/);
  assert.match(said.people[1].text, /Nothing is sent/);
  assert.match(said.people[2].text, /no longer needed/);

  // Ada's email changes and someone new goes in front of her: her old link dies and the new one waits its turn.
  after = clone(before);
  after.recipients[0].email = 'ada@new.example.com';
  after.recipients[0].routing_order = 2;
  after.recipients.push({ id: 'n', role: 'approver', name: 'New', email: 'new@example.com', routing_order: 1 });
  said = outcomes(before, after);
  assert.equal(said.people[0].kind, 'new_link');
  assert.match(said.people[0].text, /when it is their turn/);
  assert.match(said.people[3].text, /invited by email now/);

  // Once the only person left to act is removed, saving finishes the envelope.
  const done = clone(before);
  done.recipients[0].status = 'completed';
  done.recipients[2].status = 'completed';
  after = clone(done);
  after.recipients.splice(1, 1);
  after.fields.pop();
  assert.equal(outcomes(done, after).completes, true);
  assert.equal(outcomes(done, clone(done)).completes, false);
});
