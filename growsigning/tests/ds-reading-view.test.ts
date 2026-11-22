// Easy reading (research/docusign-gaps.json, plan.batches "reading-view"): the document reflowed for a small phone,
// with the person's fields in place, while the pages stay what is signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { reflowPage, placeFields, sectionsOf, blockText, FOLD_FROM, type RItem } from '../src/components/sign/reflow.ts';

// ---- Sample PDFs, read with the same pdf.js the signing page uses ------------------------------------------------

async function itemsOf(bytes: Uint8Array): Promise<{ items: RItem[]; W: number; H: number }[]> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    out.push({
      W: vp.width, H: vp.height,
      items: tc.items.filter((it: any) => typeof it.str === 'string').map((it: any) => {
        const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        return { str: it.str, x, y, w: it.width, h: it.height || Math.abs(it.transform[3]), font: it.fontName, eol: it.hasEOL };
      }),
    });
  }
  await doc.destroy();
  return out;
}

type Pen = { page: PDFPage; font: PDFFont; bold: PDFFont; y: number };
function write(p: Pen, text: string, o: { x?: number; size?: number; bold?: boolean; gap?: number } = {}) {
  const size = o.size || 11;
  p.page.drawText(text, { x: o.x ?? 72, y: p.y, size, font: o.bold ? p.bold : p.font });
  p.y -= o.gap ?? size * 1.3;
}
async function sample(draw: (p: Pen) => void): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const page = d.addPage([612, 792]);
  const pen = { page, font: await d.embedFont(StandardFonts.Helvetica), bold: await d.embedFont(StandardFonts.HelveticaBold), y: 720 };
  draw(pen);
  return d.save();
}

const LEFT = ['The tenant rents the flat at number 4 from', 'the first of May for twelve months, and pays', 'the rent on the fifth day of each month, by', 'bank transfer to the account named here.'];
const RIGHT = ['The landlord keeps the roof and the pipes', 'in good repair, and fixes anything that', 'breaks within fourteen days of being told', 'about it by the tenant, in writing or by phone.'];

test('one column: headings by size or a type of their own, paragraphs joined across lines, a short line keeps its break', async () => {
  const [{ items, W, H }] = await itemsOf(await sample((p) => {
    write(p, 'Lease of a flat', { size: 20, gap: 34 });
    write(p, 'This lease is made between Ana Silva, who owns the flat, and Ben Okafor, who rents it from the');
    write(p, 'first of May. Both of them agree to everything below, and both keep a copy.', { gap: 28 });
    write(p, 'Payment', { bold: true, gap: 20 });
    write(p, 'The rent is 900 euros a month, paid by the fifth day of each month into the account the landlord');
    write(p, 'names in writing. A late payment costs nothing extra in the first seven days.', { gap: 28 });
    write(p, 'Ana Silva');
    write(p, '12 Harbour Road');
    write(p, 'Lisbon');
  }));
  const page = reflowPage(items, W, H);
  assert.deepEqual(page.blocks.map((b) => b.kind), ['heading', 'para', 'heading', 'para', 'para']);
  assert.equal(page.blocks[0].text, 'Lease of a flat');
  assert.equal(page.blocks[1].text, 'This lease is made between Ana Silva, who owns the flat, and Ben Okafor, who rents it from the first of May. Both of them agree to everything below, and both keep a copy.');
  assert.equal(page.blocks[2].text, 'Payment', 'a short line in bold type is a heading even at the size of the text');
  assert.equal(page.blocks[4].text, 'Ana Silva\n12 Harbour Road\nLisbon', 'an address keeps its lines');
  assert.ok(page.blocks.every((b) => b.col === 0) && page.bands.every((b) => b.gutter == null));
  const s = sectionsOf(page);
  assert.deepEqual(s.map((x) => x.heading?.text), ['Lease of a flat', 'Payment']);
});

test('two columns read the left column first, under a title across the page', async () => {
  const [{ items, W, H }] = await itemsOf(await sample((p) => {
    write(p, 'House rules for the building, agreed by the tenant and the landlord', { gap: 30 });
    const top = p.y;
    LEFT.forEach((t, i) => p.page.drawText(t, { x: 72, y: top - i * 14, size: 11, font: p.font }));
    RIGHT.forEach((t, i) => p.page.drawText(t, { x: 320, y: top - i * 14, size: 11, font: p.font }));
    p.y = top - LEFT.length * 14 - 20;
    write(p, 'Signed in Lisbon by both of them on the day written below their names at the end of this page.');
  }));
  const page = reflowPage(items, W, H);
  assert.deepEqual(page.blocks.map((b) => [b.kind, b.col]), [['para', 0], ['para', 1], ['para', 2], ['para', 0]]);
  assert.equal(page.blocks[1].text, LEFT.join(' '));
  assert.equal(page.blocks[2].text, RIGHT.join(' '));
  assert.equal(page.bands.length, 3);
  assert.ok(Math.abs(page.bands[1].gutter! - 0.5) < 0.12, 'the gutter is near the middle');
});

test('lists: bullets and numbers, a wrapped item stays one item', async () => {
  const [{ items, W, H }] = await itemsOf(await sample((p) => {
    write(p, 'The tenant agrees to:', { gap: 18 });
    write(p, '1. pay the rent on time,');
    write(p, '2. keep the flat clean and tell the landlord about any damage within a week of seeing it,');
    write(p, 'including damage done by visitors,', { x: 86 });
    write(p, '3. not keep pets without asking first.', { gap: 26 });
    write(p, '- Keys: two sets.');
    write(p, '- Parking: one space.');
  }));
  const page = reflowPage(items, W, H);
  // A wider gap starts a new list.
  assert.deepEqual(page.blocks.map((b) => b.kind), ['para', 'list', 'list']);
  assert.deepEqual([...page.blocks[1].items!, ...page.blocks[2].items!], [
    '1. pay the rent on time,',
    '2. keep the flat clean and tell the landlord about any damage within a week of seeing it, including damage done by visitors,',
    '3. not keep pets without asking first.',
    '- Keys: two sets.',
    '- Parking: one space.',
  ]);
});

test('a simple table is said row by row, a form line is not a table', async () => {
  const [{ items, W, H }] = await itemsOf(await sample((p) => {
    write(p, 'What is paid', { size: 16, gap: 26 });
    for (const [a, b, c] of [['Item', 'When', 'Amount'], ['Rent', 'Monthly', '900 euros'], ['Deposit', 'Once', '1800 euros']]) {
      p.page.drawText(a, { x: 72, y: p.y, size: 11, font: p.font });
      p.page.drawText(b, { x: 260, y: p.y, size: 11, font: p.font });
      p.page.drawText(c, { x: 420, y: p.y, size: 11, font: p.font });
      p.y -= 16;
    }
    p.y -= 20;
    p.page.drawText('Signature: ______________', { x: 72, y: p.y, size: 11, font: p.font });
    p.page.drawText('Date: __________', { x: 360, y: p.y, size: 11, font: p.font });
  }));
  const page = reflowPage(items, W, H);
  assert.deepEqual(page.blocks.map((b) => b.kind), ['heading', 'table', 'para']);
  assert.deepEqual(page.blocks[1].rows, [['Item', 'When', 'Amount'], ['Rent', 'Monthly', '900 euros'], ['Deposit', 'Once', '1800 euros']]);
  assert.equal(page.blocks[2].text, 'Signature: ____   Date: ____');
  assert.match(blockText(page.blocks[1]), /^Item \| When \| Amount\nRent/);
});

test('fields go where they sit in reading order, also in two columns', async () => {
  const [{ items, W, H }] = await itemsOf(await sample((p) => {
    write(p, 'House rules for the building, agreed by the tenant and the landlord', { gap: 30 });
    const top = p.y;
    LEFT.forEach((t, i) => p.page.drawText(t, { x: 72, y: top - i * 14, size: 11, font: p.font }));
    RIGHT.forEach((t, i) => p.page.drawText(t, { x: 320, y: top - i * 14, size: 11, font: p.font }));
    p.y = top - LEFT.length * 14 - 20;
    write(p, 'Signed in Lisbon by both of them on the day written below their names at the end of this page.');
  }));
  const page = reflowPage(items, W, H);
  const at = (x: number, yPt: number) => ({ x: x / W, y: (792 - yPt) / H, w: 0.15, h: 0.02 });
  const fields = [
    { id: 'end', ...at(72, 560) }, // under everything
    { id: 'right', ...at(320, 650) }, // beside the right column, near its end
    { id: 'left', ...at(72, 650) }, // beside the left column, near its end
    { id: 'top', ...at(72, 770) }, // above all text
  ];
  const { start, after } = placeFields(page, fields);
  const order = [...start.map((f) => f.id), ...page.blocks.flatMap((_, i) => after[i].map((f) => f.id))];
  assert.deepEqual(order, ['top', 'left', 'right', 'end']);
  assert.deepEqual(after[1].map((f) => f.id), ['left'], 'read after the left column, before the right one');
});

test('a page with no text has no blocks, and every field is still listed', () => {
  const page = reflowPage([], 612, 792);
  assert.deepEqual(page.blocks, []);
  const { start } = placeFields(page, [{ id: 'a', x: 0.1, y: 0.5, w: 0.2, h: 0.03 }]);
  assert.deepEqual(start.map((f) => f.id), ['a']);
});

test('long sections can be folded, short ones never offer it', () => {
  const long = Array.from({ length: 26 }, (_, i) => ({ str: `Line ${i} of a long clause about what each person agrees to do here.`, x: 72, y: 100 + i * 14, w: 450, h: 11, font: 'a' }));
  const page = reflowPage([{ str: 'Duties', x: 72, y: 80, w: 60, h: 18, font: 'a' }, ...long, { str: 'Ending', x: 72, y: 500, w: 60, h: 18, font: 'a' }, { str: 'Short.', x: 72, y: 530, w: 40, h: 11, font: 'a' }], 612, 792);
  const s = sectionsOf(page);
  assert.equal(s.length, 2);
  assert.ok(s[0].chars >= FOLD_FROM && s[1].chars < FOLD_FROM);
  // About 250 words before folding is offered: a part of a phone screen or two never gets the button.
  assert.ok(FOLD_FROM >= 1500);
});

// ---- The view each person used: the audit trail and the certificate ---------------------------------------------

import { before } from 'node:test';
import { boot, Client, simple, signUp, signAll, tokenFor, type Server } from './helpers.ts';
import { viewsLine, viewsOf } from '../src/lib/readview.ts';

let db: Server['db'];
let ada: Client;
before(async () => {
  ({ db } = await boot());
  ada = await signUp('Ada Sender', 'ada.readview@example.com', '198.51.100.81');
});
const sent = async (email: string, over: any = {}) => {
  const e = await simple(ada, email, over);
  assert.equal((await ada.post(`/envelopes/${e.id}/send`)).status, 200);
  return e;
};
const auditOf = (id: string, action: string) => db.all('SELECT actor, detail FROM audit WHERE envelope_id=? AND action=? ORDER BY seq', id, action).map((x: any) => x.detail as string);

test('the first use of each view is written to the audit trail once, and the certificate says which views were used', async () => {
  const email = 'rv.both@example.com';
  const e = await sent(email);
  const tok = tokenFor(e.id, email);
  const c = new Client();
  c.ip = '198.51.100.82';
  assert.equal((await c.post(`/sign/${tok}/consent`, {})).status, 200);
  let r = await c.post(`/sign/${tok}/view`, { view: 'page' });
  assert.deepEqual(r.data, { ok: true, saved: true, first: true });
  // Switching back and forth writes nothing more.
  for (let i = 0; i < 3; i++) {
    r = await c.post(`/sign/${tok}/view`, { view: 'page' });
    assert.equal(r.data.first, false);
  }
  r = await c.post(`/sign/${tok}/view`, { view: 'easy' });
  assert.equal(r.data.first, true);
  await c.post(`/sign/${tok}/view`, { view: 'easy' });
  assert.deepEqual(auditOf(e.id, 'Opened the document as pages'), ['Sam Signer first had the pages of the document on their screen.']);
  assert.deepEqual(auditOf(e.id, 'Opened the document in Easy reading'), ['Sam Signer first had Easy reading on their screen, a reading aid that shows the words in one column. What is signed is the pages.']);
  assert.equal(auditOf(e.id, 'Read the document as pages').length, 0, 'the audit line never says the document was read');
  assert.equal(db.get('SELECT views_used v FROM recipients WHERE token=?', tok).v, 'page,easy');
  assert.equal((await signAll(e.id, email)).status, 200);
  // After finishing nothing is added: the certificate keeps the views used up to signing.
  r = await c.post(`/sign/${tok}/view`, { view: 'easy' });
  assert.deepEqual(r.data, { ok: true, saved: false, why: 'finished' });
  const { extractPages } = await import('../src/server/text.ts');
  const text = (await extractPages((await ada.get(`/envelopes/${e.id}/download`)).data)).join('\n').replace(/\s+/g, ' ');
  assert.match(text, /Read as:? Pages and Easy reading/);
  assert.equal((text.match(/Read as/g) || []).length, 1, 'one line for the one signer');
});

test('views: only the two names, only behind the link checks, never after the envelope closes, a person from before has no line', async () => {
  const email = 'rv.rules@example.com';
  const e = await sent(email, { recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email, access_code: '5151' }] });
  const tok = tokenFor(e.id, email);
  const c = new Client();
  c.ip = '198.51.100.83';
  // Behind the access code: refused, nothing written.
  let r = await c.post(`/sign/${tok}/view`, { view: 'easy' });
  assert.equal(r.status, 401);
  assert.equal(db.get('SELECT views_used v FROM recipients WHERE token=?', tok).v, null);
  assert.equal((await c.post(`/sign/${tok}/unlock`, { code: '5151' })).status, 200);
  for (const view of ['text', 'Easy', '', null, ['easy'], 'page,easy']) {
    r = await c.post(`/sign/${tok}/view`, { view });
    assert.equal(r.status, 400, String(view));
    assert.match(r.data.error, /"view" is one of "page" or "easy"\. Nothing was recorded\./);
  }
  assert.equal(db.get('SELECT views_used v FROM recipients WHERE token=?', tok).v, null);
  // A made-up link.
  assert.equal((await c.post('/sign/not-a-real-link/view', { view: 'page' })).status, 404);
  // Voided: the record is closed.
  assert.equal((await ada.post(`/envelopes/${e.id}/void`, { reason: 'Sent by mistake' })).status, 200);
  r = await c.post(`/sign/${tok}/view`, { view: 'page' });
  assert.ok(r.status === 200 ? r.data.saved === false : r.status >= 400, JSON.stringify(r.data));
  assert.equal(auditOf(e.id, 'Opened the document as pages').length, 0);
  // The certificate line.
  assert.equal(viewsLine(null), null, 'nothing recorded: no line rather than a guess');
  // The names the signer chose from under More: "Page" and "Easy reading".
  assert.equal(viewsLine('page'), 'Pages only');
  assert.equal(viewsLine('easy'), 'Easy reading only');
  assert.equal(viewsLine('easy,page'), 'Pages and Easy reading');
  assert.deepEqual(viewsOf('page,<script>,easy'), ['page', 'easy']);
});

test('views: someone whose turn has not come records nothing, and a burst from one connection is limited', async () => {
  const first = 'rv.first@example.com', second = 'rv.second@example.com';
  const e = await sent(first, {
    ordered: true,
    recipients: [
      { id: 'a', role: 'signer', name: 'Ana First', email: first, routing_order: 1 },
      { id: 'b', role: 'signer', name: 'Ben Second', email: second, routing_order: 2 },
    ],
    fields: [
      { id: 'fa', document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'fb', document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 },
    ],
  });
  const c = new Client();
  c.ip = '198.51.100.84';
  const tb = tokenFor(e.id, second);
  const r = await c.post(`/sign/${tb}/view`, { view: 'easy' });
  assert.ok(r.status === 200 ? r.data.saved === false : r.status === 403, JSON.stringify(r.data));
  assert.equal(db.get('SELECT views_used v FROM recipients WHERE token=?', tb).v, null);
  // One connection asking again and again is told to wait; the record still has one line.
  const ta = tokenFor(e.id, first);
  let last = 200;
  for (let i = 0; i < 70; i++) last = (await c.post(`/sign/${ta}/view`, { view: 'page' })).status;
  assert.equal(last, 429);
  assert.equal(auditOf(e.id, 'Opened the document as pages').length, 1);
});

// ---- The screen: what the code keeps (looked at in the browser at 390 and 320, tests/out/build-ds-reading-view/) ----

import fs from 'node:fs';
import path from 'node:path';
const src = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, '..', f), 'utf8');

test('every field of a page is placed exactly once, wherever it sits, also on pages with odd layouts', () => {
  const items: RItem[] = [];
  for (let i = 0; i < 30; i++) items.push({ str: `Line ${i} of the text that goes on and on across the page width here.`, x: i % 3 === 0 ? 320 : 72, y: 80 + i * 20, w: 230, h: 11, font: 'a' });
  const page = reflowPage(items, 612, 792);
  const fields = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, x: (i * 37 % 100) / 100, y: (i * 53 % 100) / 100, w: 0.1, h: 0.02 }));
  const { start, after } = placeFields(page, fields);
  const ids = [...start, ...after.flat()].map((f) => f.id).sort();
  assert.deepEqual(ids, fields.map((f) => f.id).sort());
});

test('Easy reading: one way in under More, the banner, folding hides words and never fields, words through en.json', () => {
  const more = src('src/components/sign/More.tsx');
  assert.match(more, />\{T\('sign\.read\.page'\)\}<\/button>/);
  assert.match(more, />\{T\('sign\.read\.easy'\)\}<\/button>/);
  const en = JSON.parse(src('src/locales/en.json'));
  assert.equal(en['sign.read.easy'], 'Easy reading');
  assert.equal(en['sign.read.banner'], 'A reading aid. What you sign is the pages of the document.');
  for (const [k, v] of Object.entries(en)) if (k.startsWith('sign.read.')) assert.doesNotMatch(String(v), /—|valid|hold up/i, k);
  const easy = src('src/components/sign/EasyReading.tsx');
  // The words of a folded part are not drawn; the fields after them always are.
  assert.match(easy, /\{!isFolded && <Block b=\{b\} k=\{`\$\{i\}`\} \/>\}\n\s*\{chunk\(after\[i\], `a-\$\{i\}`\)\}/);
  // Nothing folded when the page opens: the only folds kept are the ones made in this tab (module memory, never storage).
  assert.match(easy, /const keptFolds = new Map<string, Set<number>>\(\);/);
  assert.match(easy, /useState<Set<number>>\(\(\) => new Set\(keptFolds\.get\(foldKey\) \|\| \[\]\)\)/);
  assert.doesNotMatch(easy, /localStorage|sessionStorage/);
  const page = src('src/app/sign/[token]/page.tsx');
  assert.match(page, /mine=\{\(docId, page\) => ctx\.ordered\.filter/);
  assert.match(page, /onSee=\{\(docId, page, y, part\) => \(setBack\(\{ doc: docId, id: partId\(docId, page, part\) \}\), chooseView\('doc'\), showOnPage\(docId, page, y\)\)\}/);
  assert.match(src('src/components/sign/readview.ts'), /if \(!base\.startsWith\('\/sign\/'\)\) return;/, 'a preview records nothing');
});

// ---- Repairs after the skeptic's and the simplicity reviewer's look (tests/out/verify-ds-reading-view/, ux-ds-reading-view/)

test('a title with a section heading close under it stays two headings; a heading wrapped over two lines stays one', async () => {
  const [{ items, W, H }] = await itemsOf(await sample((p) => {
    write(p, 'Service agreement', { size: 20, gap: 30 });
    write(p, '1. Payment terms', { bold: true, gap: 18 });
    write(p, 'The client pays each invoice within thirty days of the date written on it, by bank transfer to the');
    write(p, 'account named on the invoice. Nothing extra is charged for the first seven days of a late payment.', { gap: 30 });
    write(p, 'A heading long enough to run across the column and', { size: 16, gap: 19 });
    write(p, 'so goes on over a second line', { size: 16, gap: 26 });
    write(p, 'Some words under it, to close the part with an ordinary paragraph of text.');
  }));
  const page = reflowPage(items, W, H);
  const heads = page.blocks.filter((b) => b.kind === 'heading').map((b) => b.text);
  assert.deepEqual(heads, ['Service agreement', '1. Payment terms', 'A heading long enough to run across the column and so goes on over a second line']);
  assert.deepEqual(sectionsOf(page).map((s) => s.heading?.text?.slice(0, 17)), ['Service agreement', '1. Payment terms', 'A heading long en']);
});

import { inkIn, hiddenRuns, type Pixels } from '../src/components/sign/visible.ts';

function blankPage(w: number, h: number, rgb = [255, 255, 255]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return { data, width: w, height: h };
}
const paint = (px: Pixels, x0: number, y0: number, x1: number, y1: number, rgb: number[], every = 1) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x += every) px.data.set([rgb[0], rgb[1], rgb[2], 255], (y * px.width + x) * 4);
};

test('words the page does not show: an empty box, a box off the page and a box covered over are hidden; letters, a picture under the words and turned text are kept', () => {
  const px = blankPage(200, 200);
  paint(px, 10, 10, 90, 20, [20, 20, 20], 3); // strokes of dark letters
  paint(px, 10, 60, 90, 80, [200, 30, 30]); // a red box covers this place completely
  for (let y = 120; y < 160; y++) for (let x = 10; x < 190; x++) px.data.set([(x * 7) % 255, (y * 13) % 255, 90, 255], (y * px.width + x) * 4); // a picture
  paint(px, 120, 10, 160, 20, [235, 235, 235], 2); // very faint grey text, nearly white
  assert.equal(inkIn(px, 10, 8, 90, 22), true, 'letters');
  assert.equal(inkIn(px, 10, 30, 90, 45), false, 'white on white');
  assert.equal(inkIn(px, 10, 62, 90, 78), false, 'inside a box drawn over the words: all one colour');
  assert.equal(inkIn(px, 10, 125, 90, 150), true, 'over a picture (the text a scanner lays over a scan) is kept');
  assert.equal(inkIn(px, 10, 300, 90, 320), false, 'below the page');
  assert.equal(inkIn(px, -90, 10, -10, 20), false, 'left of the page');
  assert.equal(inkIn(px, 120, 8, 160, 22), false, 'so faint it cannot be told from the page');
  const runs = [
    { x: 10, y: 20, w: 80, h: 10, flat: true },
    { x: 10, y: 45, w: 80, h: 10, flat: true },
    { x: 10, y: 45, w: 80, h: 10, flat: false },
    { x: 10, y: 45, w: 0, h: 10, flat: true },
  ];
  assert.deepEqual(hiddenRuns(runs, px, 1), [false, true, false, false], 'turned text and runs without a width are kept, never guessed at');
  // At another scale the boxes are scaled with the picture.
  const big = blankPage(400, 400);
  paint(big, 20, 22, 180, 40, [0, 0, 0], 4);
  assert.deepEqual(hiddenRuns([{ x: 10, y: 20, w: 80, h: 10, flat: true }, { x: 10, y: 60, w: 80, h: 10, flat: true }], big, 2), [false, true]);
});

let napi: any = null;
try {
  napi = await import('@napi-rs/canvas');
} catch {
  /* no canvas in this install: the end-to-end check below is skipped, the pixel rules above still run */
}
test('a PDF with white text, see-through text and text off the page: Easy reading keeps only the words the page shows', { skip: !napi && 'no @napi-rs/canvas here' }, async () => {
  const { rgb } = await import('pdf-lib');
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const pg = d.addPage([612, 792]);
  pg.drawText('The rent is 900 euros a month.', { x: 72, y: 700, size: 11, font });
  pg.drawText('The rent is 500 euros a month.', { x: 72, y: 680, size: 11, font, color: rgb(1, 1, 1) });
  pg.drawText('Off the page: the tenant gives up every right.', { x: 72, y: 900, size: 11, font });
  pg.drawText('A see-through clause.', { x: 72, y: 660, size: 11, font, opacity: 0 });
  pg.drawText('Covered: the deposit is kept in full.', { x: 72, y: 640, size: 11, font });
  pg.drawRectangle({ x: 66, y: 634, width: 300, height: 18, color: rgb(1, 1, 1) });
  pg.drawText('Signed in Lisbon.', { x: 72, y: 600, size: 11, font });
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fonts = path.resolve(import.meta.dirname, '..', 'node_modules/pdfjs-dist/standard_fonts') + '/';
  const doc = await pdfjs.getDocument({ data: await d.save(), verbosity: 0, standardFontDataUrl: fonts }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const scale = 1.25;
  const v2 = page.getViewport({ scale });
  const canvas = napi.createCanvas(Math.ceil(v2.width), Math.ceil(v2.height));
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: v2, canvas }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // The same steps as src/components/sign/pdfText.ts pageTexts.
  const all = tc.items.filter((it: any) => typeof it.str === 'string');
  const runs = all.map((it: any) => {
    const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
    const t = it.transform;
    return { it, x, y, w: it.width || 0, h: it.height || Math.abs(t[3]) || 10, flat: !t[1] && !t[2] && t[0] > 0 && t[3] > 0 };
  });
  const hide = hiddenRuns(runs, { data: img.data, width: img.width, height: img.height }, scale);
  const kept = runs.filter((_: any, k: number) => !hide[k]);
  const flow = reflowPage(kept.map((r: any) => ({ str: r.it.str, x: r.x, y: r.y, w: r.w, h: r.h, font: r.it.fontName })), vp.width, vp.height);
  const words = flow.blocks.map(blockText).join('\n');
  assert.match(words, /900 euros/);
  assert.match(words, /Signed in Lisbon/);
  for (const gone of [/500 euros/, /gives up every right/, /see-through/, /deposit is kept/]) assert.doesNotMatch(words, gone);
  await doc.destroy();
  // And the page wires it in: the words are filtered before both readings, and the page says some were left out.
  const pt = src('src/components/sign/pdfText.ts');
  assert.match(pt, /const kept = runs\.filter\(\(_: any, k: number\) => !hide\[k\]\);/);
  assert.match(pt, /const lines = linesOf\(kept\.map/);
  assert.match(src('src/components/sign/TextView.tsx'), /!!pages\?\.\[i\]\?\.hidden && <p className="notice warn">\{T\('sign\.read\.hidden'/);
});

test('the way into Easy reading and back: focus lands on it, See names its part and returns to it, recorded once really shown, remembered per link', () => {
  const page = src('src/app/sign/[token]/page.tsx');
  const rv = src('src/components/sign/readview.ts');
  // Into Easy reading (the skip button and More both use chooseView): the focus goes to the banner, or back to the part.
  assert.match(page, /if \(v === 'text'\) \{\n\s*if \(back\) backToPart\(back\.id\);\n\s*else focusEasy\(\);\n\s*setBack\(null\);/);
  assert.match(page, /className="sg-skip sg-skip-text" onClick=\{\(\) => chooseView\('text'\)\}/);
  assert.match(page, /onView=\{chooseView\}/);
  assert.match(src('src/components/sign/TextView.tsx'), /className="notice sg-flow-banner" id="sg-flow-banner" tabIndex=\{-1\}/);
  assert.match(rv, /document\.getElementById\('sg-flow-banner'\)/);
  // "Back to Easy reading" above the document that was shown, only after See.
  assert.match(page, /\{back\?\.doc === d\.id && <p className="sg-flow-back"><button type="button" className="btn sm" onClick=\{\(\) => chooseView\('text'\)\}>\{T\('sign\.read\.back'\)\}<\/button><\/p>\}/);
  assert.match(rv, /export const partId = \(docId: string, page: number, part: number\) => `sg-flow-\$\{docId\}-\$\{page\}-\$\{part\}`;/);
  const easy = src('src/components/sign/EasyReading.tsx');
  assert.match(easy, /id=\{`\$\{id\}-sec`\}/);
  assert.match(easy, /const id = partId\(docId, page, si\);/);
  // See names the part, and a part that is only a heading has none.
  assert.match(easy, /onSee && s\.blocks\.length > 0 &&/);
  assert.match(easy, /T\('sign\.read\.see_part', \{ part: short\(s\.heading\.text \|\| ''\), page: page \+ 1 \}\)/);
  const en = JSON.parse(src('src/locales/en.json'));
  assert.equal(en['sign.read.see_part'], 'See {part} on page {page}');
  assert.equal(en['sign.read.back'], 'Back to Easy reading');
  // Recorded only once the view was on the screen.
  assert.match(page, /onShown=\{\(\) => \(markShown\(d\), sawIn\('page'\)\)\}/);
  assert.match(page, /onShown=\{\(d\) => \(markShown\(d\), sawIn\('easy'\)\)\}/);
  assert.match(page, /if \(seenIn\.page\) noteView\(base, 'page'\);\n\s*if \(seenIn\.easy\) noteView\(base, 'easy'\);/);
  assert.doesNotMatch(page, /noteView\(base, view === 'text'/);
  // Per signing link, not for the whole browser.
  assert.doesNotMatch(page, /'sg:view'/);
  assert.match(page, /localStorage\.getItem\(`sg:view:\$\{base\}`\)/);
  assert.match(page, /localStorage\.setItem\(`sg:view:\$\{base\}`, v\)/);
  // In Easy reading the field already stands after its line: no "Next to: ____" (a choice button keeps it).
  assert.match(page, /near=\{ids \? \(f: any\) => \(f\.type === 'radio' \? near\(f\) : ''\) : near\}/);
  // The banner lines up with the document card.
  assert.match(src('src/app/styles/readview.css'), /\.sg-flow-banner \{[^}]*max-width: 760px/);
  // No old name where a person reads it.
  assert.doesNotMatch(src('src/server/openapi-ocr.ts'), /text view/i);
  assert.doesNotMatch(src('README.md'), /Text view/);
});
