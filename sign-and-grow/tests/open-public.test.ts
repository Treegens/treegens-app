// What earlier engineers reported as not finished (research/continue.json: the repair reports of brand-wire,
// ds-custom-fields, simplify-editor, simplify-start, simplify-envelope and simplify-public), finished here. The
// numbers in the test names are the numbers of the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { boot, signUp, Client, PNG, tokenFor } from './helpers.ts';

const server = await boot();
const { decodePng } = await import('../src/server/png.ts');
const { planFoot, pictureBoxes, textBoxes, growFoot, STRIP_PT, EDGE } = await import('../src/server/footplace.ts');
const { PAGE_STAMP_W } = await import('../src/server/brandpdf.ts');

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
let ipN = 0;
const newIp = () => `203.0.113.${++ipN}`;
const havePoppler = spawnSync('which', ['pdftotext']).status === 0 && spawnSync('which', ['pdftoppm']).status === 0;

// ---- 1. The stamp never stands on the document ----------------------------------------------------------------------

const lineW = (size: number) => 34 * size; // about what the envelope ID line measures

test('1. the strip goes left when the foot is clear there, right when it is not, into a gap, and onto a new margin when the foot is in use', () => {
  const W = 612, H = 792;
  const foot = (x0: number, x1: number) => ({ x0, y0: H - 12, x1, y1: H - 4 });
  assert.deepEqual(planFoot(W, H, [], true, lineW), { left: EDGE, size: 6.5, stamp: true, grow: false, where: 'left' });
  // Text higher up the page is not in the way.
  assert.equal(planFoot(W, H, [{ x0: 0, y0: 100, x1: W, y1: H - 30 }], true, lineW).where, 'left');
  // A page number in the lower left corner: the strip goes to the right, flush with the margin.
  const right = planFoot(W, H, [foot(20, 80)], true, lineW);
  assert.equal(right.where, 'right');
  const width = PAGE_STAMP_W + 6 + lineW(6.5);
  assert.ok(Math.abs(right.left + width - (W - EDGE)) < 0.01);
  // Both corners in use, the middle free.
  const gap = planFoot(W, H, [foot(20, 80), foot(540, 600)], true, lineW);
  assert.equal(gap.where, 'gap');
  assert.ok(gap.left > 84 && gap.left + width < 536, 'inside the free stretch, 4 pt clear of both neighbours');
  // A footer the whole width, or one picture to the edges: nothing is covered, the page gets a margin.
  assert.deepEqual(planFoot(W, H, [foot(30, 580)], true, lineW), { left: EDGE, size: 6.5, stamp: true, grow: true, where: 'margin' });
  assert.equal(planFoot(W, H, [{ x0: 0, y0: 0, x1: W, y1: H }], true, lineW).where, 'margin');
  // A page nobody could read is never taken for clear.
  assert.equal(planFoot(W, H, [], false, lineW).grow, true);
  // Something that only just reaches into the strip from above counts; something 3 pt above it does not.
  assert.equal(planFoot(W, H, [{ x0: 0, y0: H - 40, x1: W, y1: H - STRIP_PT - 1 }], true, lineW).where, 'margin');
  assert.equal(planFoot(W, H, [{ x0: 0, y0: H - 40, x1: W, y1: H - STRIP_PT - 3 }], true, lineW).where, 'left');
});

test('1. on a narrow page the line is made smaller, then printed without the stamp, and always fits between the margins', () => {
  for (const W of [612, 300, 230, 170, 120, 60]) {
    const p = planFoot(W, 400, [], true, lineW);
    const width = (p.stamp ? PAGE_STAMP_W + 6 : 0) + lineW(p.size);
    assert.ok(width <= W - 2 * EDGE + 0.01, `${W} pt wide: the strip is ${width.toFixed(1)} pt and fits`);
    if (W >= 400) assert.equal(p.size, 6.5);
    if (W === 120) assert.equal(p.stamp, false, 'no room for the stamp beside the line: the line alone');
  }
});

async function pictureDoc() {
  const d = await PDFDocument.create();
  const png = await d.embedPng(Buffer.from(PNG.split(',')[1], 'base64'));
  const a = d.addPage([612, 792]);
  a.drawImage(png, { x: 100, y: 0, width: 200, height: 50 }); // reaches the foot
  const b = d.addPage([612, 792]);
  b.drawImage(png, { x: 100, y: 400, width: 200, height: 50 }); // does not
  return PDFDocument.load(await d.save());
}

test('1. the pictures of a page are found where they are painted, also on a turned page, without unpacking them', async () => {
  const d = await pictureDoc();
  const [a, b] = d.getPages();
  const near = (x: number, y: number) => Math.abs(x - y) < 0.01;
  const [pa] = pictureBoxes(a)!;
  assert.ok(near(pa.x0, 100) && near(pa.x1, 300) && near(pa.y0, 742) && near(pa.y1, 792), JSON.stringify(pa));
  const [pb] = pictureBoxes(b)!;
  assert.ok(near(pb.y0, 342) && near(pb.y1, 392));
  // Turned a quarter: the picture that touched the bottom edge now touches the left edge of the page as shown.
  a.setRotation(degrees(90));
  const [turned] = pictureBoxes(a)!;
  assert.ok(near(turned.x0, 0) && near(turned.x1, 50) && near(turned.y0, 100) && near(turned.y1, 300), JSON.stringify(turned));
});

test('1. a picture inside a form inside the page, and an inline picture, are found too; commands that cannot be followed give "unknown"', async () => {
  const d = await PDFDocument.create();
  const inner = await PDFDocument.create();
  const png = await inner.embedPng(Buffer.from(PNG.split(',')[1], 'base64'));
  inner.addPage([200, 100]).drawImage(png, { x: 0, y: 0, width: 200, height: 100 });
  const [form] = await d.embedPdf(await inner.save());
  d.addPage([612, 792]).drawPage(form, { x: 300, y: 10, width: 100, height: 50 });
  const back = await PDFDocument.load(await d.save());
  const [box] = pictureBoxes(back.getPage(0))!;
  assert.ok(Math.abs(box.x0 - 300) < 0.01 && Math.abs(box.x1 - 400) < 0.01 && Math.abs(box.y1 - 782) < 0.01 && Math.abs(box.y0 - 732) < 0.01, JSON.stringify(box));

  // An inline picture, written by hand, with brackets in a string before it that must not confuse the reader.
  const raw = await PDFDocument.create();
  const page = raw.addPage([612, 792]);
  const stream = raw.context.stream('q (a \\( string ) Tj Q q 50 0 0 20 500 3 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \u0000 EI Q');
  page.node.set((await import('pdf-lib')).PDFName.of('Contents'), raw.context.register(stream));
  const loaded = await PDFDocument.load(await raw.save());
  const [inl] = pictureBoxes(loaded.getPage(0))!;
  assert.ok(Math.abs(inl.x0 - 500) < 0.01 && Math.abs(inl.x1 - 550) < 0.01 && Math.abs(inl.y1 - 789) < 0.01, JSON.stringify(inl));
});

test('1. the text of a page is found where it stands, and a file that is not a PDF gives nothing to trust', async () => {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([612, 792]).drawText('Page 1 of 3', { x: 30, y: 8, size: 9, font });
  const [boxes] = await textBoxes(await d.save());
  assert.equal(boxes!.length, 1);
  const b = boxes![0];
  assert.ok(b.x0 > 28 && b.x0 < 32 && b.x1 > 60 && b.x1 < 90, JSON.stringify(b));
  assert.ok(b.y0 < 778 && b.y1 > 784 && b.y1 < 790, 'from above the letters to under their tails');
  assert.deepEqual(await textBoxes(new TextEncoder().encode('not a pdf')), []);
});

test('1. a page made taller keeps its content where it was, whichever way it is turned', async () => {
  for (const rot of [0, 90, 180, 270]) {
    const d = await PDFDocument.create();
    const p = d.addPage([612, 792]);
    p.setRotation(degrees(rot));
    growFoot(p);
    const crop = p.getCropBox(), media = p.getMediaBox();
    assert.deepEqual(crop, media);
    const side = rot % 180 !== 0;
    assert.equal(side ? crop.width : crop.height, (side ? 612 : 792) + STRIP_PT, `turned ${rot}: the page as shown is 17 pt taller`);
    assert.equal(side ? crop.height : crop.width, side ? 792 : 612, 'and as wide as before');
    // The old page is still inside the new one.
    assert.ok(crop.x <= 0 && crop.y <= 0 && crop.x + crop.width >= 612 && crop.y + crop.height >= 792);
  }
});

/** Each page of a PDF drawn at 72 dpi (1 pixel to a point), as shown. */
function drawPages(pdf: Uint8Array) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growsigning-open-'));
  fs.writeFileSync(path.join(dir, 'a.pdf'), pdf);
  const r = spawnSync('pdftoppm', ['-r', '72', '-png', path.join(dir, 'a.pdf'), path.join(dir, 'p')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const text = spawnSync('pdftotext', ['-layout', path.join(dir, 'a.pdf'), '-'], { encoding: 'utf8' }).stdout;
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => decodePng(fs.readFileSync(path.join(dir, f)), 10_000_000)!);
  fs.rmSync(dir, { recursive: true, force: true });
  return { pages, text };
}

async function trickyPdf() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const png = await d.embedPng(Buffer.from(PNG.split(',')[1], 'base64'));
  const body = (p: any) => p.drawText('This agreement is made between the parties.', { x: 72, y: 700, size: 11, font });
  // 1: an ordinary page. 2: a page number low in the left corner. 3: a footer the whole width, in the lowest strip.
  const p1 = d.addPage([612, 792]); body(p1);
  const p2 = d.addPage([612, 792]); body(p2); p2.drawText('Page 2 of 6 · Contract 4471', { x: 14, y: 7, size: 8, font });
  const p3 = d.addPage([612, 792]); body(p3); p3.drawText('Confidential. Do not copy. '.repeat(5), { x: 14, y: 7, size: 8, font });
  // 4: a scan, one picture to the edges. 5: the same, turned a quarter. 6: a page number in each lower corner.
  const p4 = d.addPage([612, 792]); p4.drawImage(png, { x: 0, y: 0, width: 612, height: 792 });
  const p5 = d.addPage([612, 792]); p5.drawImage(png, { x: 0, y: 0, width: 612, height: 792 }); p5.setRotation(degrees(90));
  const p6 = d.addPage([612, 792]); body(p6); p6.drawText('left corner', { x: 14, y: 7, size: 8, font }); p6.drawText('right corner', { x: 550, y: 7, size: 8, font });
  return d.save();
}

async function signedCopy(owner: Client, source: Uint8Array, email: string, field: any = { page: 0, x: 0.4, y: 0.4, w: 0.3, h: 0.08 }) {
  const f = new FormData();
  f.append('file', new Blob([source], { type: 'application/pdf' }), 'Tricky.pdf');
  const up = await owner.call('POST', '/files', f);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const made = await owner.post('/envelopes', {
    subject: 'Foot check', send: true, documents: [{ id: 'd', file_id: up.data.id }], recipients: [{ id: 'r', role: 'signer', name: 'Bree Signer', email }],
    fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', ...field }],
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.envelope.id;
  const signer = new Client();
  signer.ip = newIp();
  const tok = tokenFor(id, email);
  await signer.post(`/sign/${tok}/consent`);
  const fields = (await signer.get(`/sign/${tok}`)).data.fields;
  const r = await signer.post(`/sign/${tok}/complete`, { values: Object.fromEntries(fields.map((x: any) => [x.id, '1'])), signature_png: PNG });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const pdf = (await owner.get(`/envelopes/${id}/download`)).data as Uint8Array;
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), '%PDF-');
  return { id, pdf };
}

test('1. on a signed copy the stamp and the envelope ID never touch a pixel the document had used', { skip: !havePoppler && 'pdftoppm is not installed' }, async () => {
  const source = await trickyPdf();
  const owner = await signUp('Fay Foot', 'fay.foot@example.com', newIp());
  const { id, pdf } = await signedCopy(owner, source, 'bree.foot@example.com');
  if (process.env.KEEP_PDF) fs.writeFileSync(process.env.KEEP_PDF, pdf);
  const before = drawPages(source).pages;
  const { pages: after, text } = drawPages(pdf);
  // Pages 3, 4 and 5 had no clear stretch at the foot: they are 17 pt taller as shown. The others kept their size.
  assert.deepEqual(after.slice(0, 6).map((p, i) => [p.width - before[i].width, p.height - before[i].height]), [[0, 0], [0, 0], [0, 17], [0, 17], [0, 17], [0, 0]]);
  const dark = (img: any, x: number, y: number) => { const i = (y * img.width + x) * 4; return img.data[i] + img.data[i + 1] + img.data[i + 2] < 700; };
  const where: string[] = [];
  for (let n = 0; n < 6; n++) {
    const a = before[n], b = after[n];
    let ours = 0, minX = 1e9, maxX = 0, minY = 1e9;
    for (let y = 0; y < b.height; y++)
      for (let x = 0; x < b.width; x++) {
        const inOld = y < a.height;
        const i = (y * b.width + x) * 4, j = (y * a.width + x) * 4;
        const same = inOld && Math.abs(b.data[i] - a.data[j]) + Math.abs(b.data[i + 1] - a.data[j + 1]) + Math.abs(b.data[i + 2] - a.data[j + 2]) < 24;
        if (same) continue;
        if (!inOld && !dark(b, x, y)) continue; // the new margin's white
        // The signature field on page 1 is the only thing of ours away from the foot.
        if (n === 0 && x >= 0.4 * a.width - 2 && x <= 0.7 * a.width + 2 && y >= 0.4 * a.height - 2 && y <= 0.48 * a.height + 2) continue;
        ours++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y);
        // Where we printed, the document had nothing: not a letter, not a picture.
        if (inOld) assert.ok(!dark(a, x, y), `page ${n + 1}: we printed at ${x},${y}, where the document had ink`);
        // And never within 2 points of its ink either.
        if (inOld) for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && xx < a.width && yy >= 0 && yy < a.height) assert.ok(!dark(a, xx, yy), `page ${n + 1}: our ink at ${x},${y} touches the document's`);
        }
      }
    assert.ok(ours > 300, `page ${n + 1} carries the stamp and the line (${ours} pixels)`);
    assert.ok(minY >= b.height - STRIP_PT - 1, `page ${n + 1}: everything of ours is in the lowest 17 pt (from ${minY} of ${b.height})`);
    where.push(minX < 20 ? 'left' : maxX > b.width - 20 ? 'right' : 'gap');
  }
  // Left when clear, right beside a page number in the left corner, between two page numbers, left on a new margin.
  assert.deepEqual(where, ['left', 'right', 'left', 'left', 'left', 'gap']);
  assert.equal((text.match(new RegExp(`GrowSigning Envelope ID: ${id}`, 'g')) || []).length, 6, 'the envelope ID is on every page, once');
});

test('1. a field of ours at the foot is not printed over either, and a file a signer attached carries the stamp and the ID', { skip: !havePoppler && 'pdftoppm is not installed' }, async () => {
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawText('Sign in the lower left corner.', { x: 72, y: 700, size: 11 });
  const owner = await signUp('Lou Low', 'lou.low@example.com', newIp());
  // The signature field sits in the lower left corner, down to the edge of the page.
  const { id, pdf } = await signedCopy(owner, await d.save(), 'bree.low@example.com', { page: 0, x: 0.02, y: 0.93, w: 0.3, h: 0.07 });
  const { pages, text } = drawPages(pdf);
  const img = pages[0];
  let left = 0, right = 0;
  for (let y = img.height - 17; y < img.height - 4; y++)
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] + img.data[i + 1] + img.data[i + 2] < 700) x < img.width - 200 ? left++ : right++;
    }
  assert.ok(right > 200, `the strip went to the right of the field (${right} pixels there, ${left} in the field's own corner)`);
  assert.ok(text.includes(`GrowSigning Envelope ID: ${id}`));

  const pdfTs = read('src/server/pdf.ts');
  assert.match(pdfTs, /flatPages\(doc, file\.sha256\)\)\.forEach\(\(p\) => \(doc\.addPage\(p\), drawFootClear\(p, mapper\(p\), \[\], \{ line: footLine/, 'pages a signer attached get the foot too');
  assert.doesNotMatch(pdfTs, /drawPageFoot\(/, 'no page of a document is printed on without looking at it first');
});
