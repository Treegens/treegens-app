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
import { boot, signUp, Client, PNG, tokenFor, upload } from './helpers.ts';
import { englishIf } from './words.ts';

const server = await boot();
const { decodePng } = await import('../src/server/png.ts');
const { planFoot, pictureBoxes, textBoxes, growFoot, STRIP_PT, EDGE } = await import('../src/server/footplace.ts');
const { PAGE_STAMP_W } = await import('../src/server/brandpdf.ts');

const root = path.resolve(import.meta.dirname, '..');
// Screens moved into the catalogue are read with their English put back (lang-sender-rest, tests/words.ts).
const read = (p: string) => englishIf(p, fs.readFileSync(path.join(root, p), 'utf8'));
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

test('1. drawn lines and shapes count as content (a ruled line, a frame, words drawn as outlines), white and the sheet behind everything do not', async () => {
  const { paintedBoxes } = await import('../src/server/footplace.ts');
  const { PDFName } = await import('pdf-lib');
  const d = await PDFDocument.create();
  const W = 612, H = 792;
  // 1: a white sheet and a cream sheet behind everything, and a white line at the foot: nothing of the document.
  const p1 = d.addPage([W, H]);
  p1.drawRectangle({ x: 0, y: 0, width: W, height: H, color: (await import('pdf-lib')).rgb(1, 1, 1) });
  p1.drawRectangle({ x: 0, y: 0, width: W, height: H, color: (await import('pdf-lib')).rgb(0.98, 0.95, 0.88) });
  p1.drawLine({ start: { x: 20, y: 8 }, end: { x: 590, y: 8 }, thickness: 1, color: (await import('pdf-lib')).rgb(1, 1, 1) });
  // 2: a ruled line under a footer, 9 pt above the bottom, 1 pt thick.
  const p2 = d.addPage([W, H]);
  p2.drawLine({ start: { x: 30, y: 9 }, end: { x: 580, y: 9 }, thickness: 1 });
  // 3: words drawn as outlines in the lower left corner (a logo, a signature drawn as shapes).
  const p3 = d.addPage([W, H]);
  p3.drawSvgPath('M 0 0 C 10 -10 30 -10 40 0 L 80 0 L 80 8 Z', { x: 20, y: 14, color: (await import('pdf-lib')).rgb(0.1, 0.1, 0.1) });
  // 4: a frame round the page, 8 pt in, written by hand with re and an ICC colour given as one number (gray).
  const p4 = d.addPage([W, H]);
  p4.node.set(PDFName.of('Contents'), d.context.register(d.context.stream('q /CS0 CS 0 SC 0.5 w 8 8 596 776 re S Q q 0 0 0 0 k 0 0 612 30 re f Q')));
  const back = await PDFDocument.load(await d.save());
  const [a, b, c, e] = back.getPages().map((p) => paintedBoxes(p)!);
  assert.deepEqual(a.shapes, [], 'white, and the sheets behind everything, are not the document');
  assert.equal(b.shapes.length, 1);
  assert.ok(b.shapes[0].y1 > H - 10 && b.shapes[0].y0 < H - 8 && b.shapes[0].x0 < 31 && b.shapes[0].x1 > 579, JSON.stringify(b.shapes[0]));
  assert.ok(c.shapes.length >= 1 && c.shapes.every((s) => s.x0 >= 19 && s.x1 <= 101 && s.y1 > H - 25), JSON.stringify(c.shapes));
  // The frame is four thin lines, not one box over the whole page; the white band (CMYK 0 0 0 0) is nothing.
  assert.equal(e.shapes.length, 4, JSON.stringify(e.shapes));
  assert.ok(e.shapes.every((s) => s.x1 - s.x0 < 2 || s.y1 - s.y0 < 2));

  // What that means for the strip.
  const plan = (boxes: any[]) => planFoot(W, H, boxes.filter((x) => x.y1 > H - STRIP_PT - 2.5), true, lineW).where;
  assert.equal(plan(a.shapes), 'left');
  assert.equal(plan(b.shapes), 'margin', 'a ruled line across the foot: the strip goes on a new margin, not across the line');
  assert.equal(plan(c.shapes), 'right', 'beside the outlines, not on them');
  assert.equal(plan(e.shapes), 'margin', 'the bottom of the frame is in the strip');
});

test('1. on a signed copy the strip keeps off a ruled line, a frame and outlined words too', { skip: !havePoppler && 'pdftoppm is not installed' }, async () => {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const { rgb } = await import('pdf-lib');
  const body = (p: any) => p.drawText('This agreement is made between the parties.', { x: 72, y: 700, size: 11, font });
  const p1 = d.addPage([612, 792]); body(p1); p1.drawLine({ start: { x: 30, y: 9 }, end: { x: 580, y: 9 }, thickness: 1 });
  const p2 = d.addPage([612, 792]); body(p2); p2.drawSvgPath('M 0 0 C 10 -10 30 -10 40 0 L 80 0 L 80 8 Z', { x: 20, y: 14, color: rgb(0.1, 0.1, 0.1) });
  const p3 = d.addPage([612, 792]); body(p3); p3.drawRectangle({ x: 8, y: 8, width: 596, height: 776, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  const source = await d.save();
  const owner = await signUp('Rae Rule', 'rae.rule@example.com', newIp());
  const { pdf } = await signedCopy(owner, source, 'bree.rule@example.com');
  const before = drawPages(source).pages;
  const after = drawPages(pdf).pages;
  assert.deepEqual(after.slice(0, 3).map((p, i) => p.height - before[i].height), [17, 0, 17], 'the ruled line and the frame get a margin, the outlines a place beside them');
  const dark = (img: any, x: number, y: number) => { const i = (y * img.width + x) * 4; return img.data[i] + img.data[i + 1] + img.data[i + 2] < 700; };
  for (let n = 0; n < 3; n++) {
    const a = before[n], b = after[n];
    for (let y = 0; y < a.height; y++)
      for (let x = 0; x < a.width; x++) {
        if (n === 0 && x >= 0.4 * a.width - 2 && x <= 0.7 * a.width + 2 && y >= 0.4 * a.height - 2 && y <= 0.48 * a.height + 2) continue; // the signature
        const i = (y * b.width + x) * 4, j = (y * a.width + x) * 4;
        const changed = Math.abs(b.data[i] - a.data[j]) + Math.abs(b.data[i + 1] - a.data[j + 1]) + Math.abs(b.data[i + 2] - a.data[j + 2]) >= 24;
        if (changed) assert.ok(!dark(a, x, y), `page ${n + 1}: we printed at ${x},${y}, where the document had ink`);
      }
  }
});

test('4. an install that skipped its scripts still gets the heading font, the PDF viewer and the PDF fonts when it builds or starts the dev server', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.match(scripts.prebuild, /^node scripts\/copy-assets\.mjs && /, 'npm run build copies the assets first');
  assert.match(scripts.prebuild, /scripts\/sbom\.mjs/);
  assert.equal(scripts.predev, 'node scripts/copy-assets.mjs');
  // Run the copy as such an install would: the packages are there, nothing was copied out of them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growsigning-assets-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const f of ['copy-assets.mjs', 'build-fonts.mjs']) fs.copyFileSync(path.join(root, 'scripts', f), path.join(dir, 'scripts', f));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'copy-assets.mjs')], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['public/fonts/lora-500.woff2', 'public/fonts/lora-600.woff2', 'public/pdfjs/pdf.min.mjs', 'public/fonts/caveat.woff2', 'assets/fonts/DejaVuSans.ttf'])
      assert.ok(fs.statSync(path.join(dir, f)).size > 1000, f);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.match(read('README.md'), /--ignore-scripts/);
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

// ---- 3, 5. Pages people reach from an email, and the developer outbox on a phone ------------------------------------

test('3. a long link in the developer outbox wraps on a phone instead of running off the screen', () => {
  assert.match(read('src/app/dev/outbox/page.tsx'), /data-outbox-link style=\{\{ overflowWrap: 'anywhere' \}\}/);
});

test('5. the pages reached from an email have a tab title of their own', async () => {
  for (const [dir, title] of [['verify-email', 'Confirm your email address'], ['change-email', 'Change your email address']]) {
    const layout = read(`src/app/${dir}/layout.tsx`);
    assert.ok(layout.includes(`title: '${title}'`), dir);
    assert.doesNotMatch(read(`src/app/${dir}/page.tsx`), /export const metadata/, 'a page that runs in the browser cannot carry it itself');
  }
  // The root layout adds " · GrowSigning" to every title.
  assert.match(read('src/app/layout.tsx'), /template: '%s · GrowSigning'/);
});

// ---- 7, 8. Details on each document ----------------------------------------------------------------------------------

test('7. the details card is on Settings, Sending (not Account), and says only what exists', () => {
  const page = read('src/app/app/settings/page.tsx');
  const sending = page.split('\n').find((l) => l.includes("tab === 'sending'"))!;
  assert.match(sending, /<CustomFieldSettings \/>/);
  assert.equal(page.split('\n').filter((l) => /<CustomFieldSettings/.test(l)).length, 1, 'one place only');
  // There are no saved fields to list yet, so the card is not called "Details and saved fields".
  const en = JSON.parse(read('src/locales/en.json'));
  assert.equal(en['customfields.title'], 'Details on each document');
  assert.doesNotMatch(read('src/components/settings/CustomFieldSettings.tsx'), /saved fields/i);
});

test('8. /help says what Details are, and why a send can be refused for one', async () => {
  const owner = await signUp('Hal Help', 'hal.help@example.com', newIp());
  const help = read('src/app/help/page.tsx');
  const entry = help.slice(help.indexOf('id="details"'), help.indexOf('</QA>', help.indexOf('id="details"')));
  for (const words of ['Settings, Sending', 'last step of the editor', 'Signers do not see them while signing', 'print on the signing record', 'filter Documents', 'export of everything', 'required is not sent', 'Details on its page'])
    assert.ok(entry.includes(words), words);
  assert.match(help, /<b>A required detail is empty\.<\/b> Fill it in under Details on the last step of the editor\. See <a href="#details">Details<\/a>\./);
  // What the entry says is what the server does: a send without a required detail is refused and names the place.
  const fields = await owner.post('/custom-fields', { name: 'Case number', kind: 'text', required: true });
  assert.equal(fields.status, 200, JSON.stringify(fields.data));
  const up = await upload(owner, 1);
  const sent = await owner.post('/envelopes', { subject: 'Needs a case', send: true, documents: [{ id: 'd', file_id: up.id }], recipients: [{ id: 'r', role: 'signer', name: 'Ann Other', email: 'ann.other@example.com' }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }] });
  assert.equal(sent.status, 400);
  assert.equal(sent.data.code, 'details_missing');
  assert.match(sent.data.error, /under Details, on the last step of the editor/);
  for (const w of [/\bmetadata\b/i, /custom field/i]) assert.doesNotMatch(entry, w);
});

// ---- 18. A sign-up with Microsoft that did not vouch for the address, driven end to end ------------------------------

test('18. a sign-up through Microsoft that did not vouch for the address is confirmed with the 6-digit code in its own session', async () => {
  const crypto = await import('node:crypto');
  const { handle } = await import('../src/server/router.ts');
  const { mailTo } = await import('./helpers.ts');
  const ID = '0f0f0f0f-aaaa-4bbb-8ccc-343434343434', SECRET = 'microsoft-secret', TENANT = '11111111-2222-4333-8444-666666666666';
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64 = (v: any) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const jwt = (claims: any) => {
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'open-public-1' });
    const body = b64(claims);
    return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.privateKey).toString('base64url')}`;
  };
  const codes = new Map<string, { challenge: string; redirect: string; token: string }>();
  const realFetch = globalThis.fetch;
  const saved = { id: process.env.MICROSOFT_CLIENT_ID, secret: process.env.MICROSOFT_CLIENT_SECRET, tenant: process.env.MICROSOFT_TENANT };
  Object.assign(process.env, { MICROSOFT_CLIENT_ID: ID, MICROSOFT_CLIENT_SECRET: SECRET });
  delete process.env.MICROSOFT_TENANT;
  // The provider's key list and token endpoint; nothing else is reached.
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (u.host !== 'login.microsoftonline.com') throw new Error(`no network in tests: ${u.host}`);
    if (u.pathname.endsWith('/discovery/v2.0/keys')) return json({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'open-public-1', use: 'sig', alg: 'RS256' }] });
    const p = Object.fromEntries(new URLSearchParams(String(init.body)));
    const c = codes.get(p.code);
    codes.delete(p.code);
    if (!c || p.client_secret !== SECRET || p.redirect_uri !== c.redirect || crypto.createHash('sha256').update(p.code_verifier || '').digest('base64url') !== c.challenge) return json({ error: 'invalid_grant' }, 400);
    return json({ access_token: 'x', token_type: 'Bearer', id_token: c.token });
  }) as any;
  try {
    const b = new Client();
    b.ip = newIp();
    const go = async (url: string) => {
      const res = await handle(new Request(`http://test.local/api${url}`, { headers: { cookie: Object.entries(b.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': b.ip } }));
      for (const ck of res.headers.getSetCookie()) { const [kv] = ck.split(';'); b.cookies[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1); }
      return { status: res.status, location: res.headers.get('location') || '' };
    };
    const start = await go('/auth/microsoft/start?mode=signup');
    assert.equal(start.status, 302);
    const auth = new URL(start.location);
    const email = 'mika.unvouched@example.com';
    const t = Math.floor(Date.now() / 1000);
    const code = `code-${crypto.randomBytes(6).toString('hex')}`;
    // A Microsoft account of an organization: its address is not one Microsoft vouches for to us.
    codes.set(code, { challenge: auth.searchParams.get('code_challenge')!, redirect: auth.searchParams.get('redirect_uri')!, token: jwt({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, ver: '2.0', tid: TENANT, aud: ID, nonce: auth.searchParams.get('nonce'), iat: t, exp: t + 3600, oid: 'oid-mika', sub: 'pairwise-mika', email, preferred_username: email, name: 'Mika Unvouched' }) });
    const back = await go(`/auth/microsoft/callback?${new URLSearchParams({ code, state: auth.searchParams.get('state')! })}`);
    assert.equal(back.status, 302);
    assert.match(back.location, /\/signin\/done\?next=/, 'signed up and signed in');
    const me = (await b.get('/me')).data.user;
    assert.equal(me.email, email);
    assert.equal(!!me.email_verified, false, 'Microsoft did not vouch, so the address is not confirmed yet');
    assert.equal(me.has_password, false);
    // The code we emailed confirms it, in this same session, with no password to type.
    const mail = mailTo(email).filter((m: any) => m.subject === 'Confirm your email for GrowSigning').at(-1)!;
    const m = /Your code is (\d{3}) (\d{3})\./.exec(mail.html)!;
    assert.ok(m, 'the email carries the code');
    const wrong = await b.post('/auth/verify-code', { code: m[1] === '000' ? '111111' : '000000' });
    assert.equal(wrong.status, 400);
    assert.equal((await b.post('/auth/verify-code', { code: m[1] + m[2] })).status, 200);
    assert.equal(!!(await b.get('/me')).data.user.email_verified, true);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [['MICROSOFT_CLIENT_ID', saved.id], ['MICROSOFT_CLIENT_SECRET', saved.secret], ['MICROSOFT_TENANT', saved.tenant]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

// ---- 12. Removing a person can be undone ------------------------------------------------------------------------------

test('12. a person removed with the cross (no fields, so nothing was asked) can be brought back with Undo, and the keyboard lands on it', () => {
  const line = read('src/components/editor/RemovedLine.tsx');
  assert.match(line, /role="status"/, 'said to a screen reader');
  assert.match(line, /Removed \{personInSentence\(gone\.r\)\}\./);
  assert.match(line, /if \(gone\) undo\.current\?\.focus\(\)/, 'the cross that had the keyboard is gone, so Undo gets it');
  assert.match(line, /minHeight: 44/);
  assert.match(line, /ed\.rcps\.length >= MAX_RECIPIENTS\) return null/, 'never past the most people one document can have');
  const editor = read('src/components/Editor.tsx');
  assert.match(editor, /else \(go\(\), setRemoved\(r && !isIdle\(r\) \? \{ r, at: rcps\.indexOf\(r\) \} : null\)\)/, 'only someone typed in is worth an Undo; a person with fields is asked first');
  assert.match(editor, /\[\.\.\.l\.slice\(0, removed\.at\), removed\.r, \.\.\.l\.slice\(removed\.at\)\]/, 'back in the same place');
  assert.match(editor, /useEffect\(\(\) => setRemoved\(null\), \[step\]\)/, 'gone when the step is left');
  assert.match(read('src/components/editor/StepAdd.tsx'), /<RemovedLine ed=\{ed\} \/>/);
});

// ---- 19. Pages inside More and Documents use the words the menu uses ---------------------------------------------------

test('19. Send to many, its batches, Documents, Reports, Contacts and Home say document and cancelled, as the document page does', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const batch = strip(read('src/components/sender/BatchView.tsx'));
  for (const old of ['Void everything', "'Voided'", "'envelope')", 'under Envelopes', 'Back to bulk send', '← Bulk send', 'nothing to void', 'voided, declined', 'the envelope for', '<th>Recipient</th>'])
    assert.ok(!batch.includes(old), `BatchView still says ${old}`);
  assert.match(batch, /Cancel everything still open/);
  const bulk = strip(read('src/app/app/bulk/page.tsx'));
  for (const old of ["'envelope')", 'per envelope', 'each envelope', 'that envelope', 'Every envelope', 'every envelope']) assert.ok(!bulk.includes(old), `Send to many still says ${old}`);
  // The page of a document says "Cancel the request", so nothing on the sender's side says void any more.
  assert.match(read('src/lib/envelopepage.ts'), /add\('cancel', 'Cancel the request', true\)/);
  const list = strip(read('src/app/app/envelopes/page.tsx'));
  for (const old of ['It was voided', 'Open the envelope', 'These envelopes', 'sent envelopes in this list']) assert.ok(!list.includes(old), old);
  const reports = strip(read('src/app/app/reports/page.tsx'));
  assert.ok(!reports.includes('Envelopes sent') && !reports.includes('Envelopes per month'));
  // The status names are in the catalogue since lang-sender-rest (reports.status.*).
  assert.match(reports, /T\(`reports\.status\.\$\{s\}`\)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'src/locales/en.json'), 'utf8'))['reports.status.voided'], 'cancelled');
  assert.ok(!strip(read('src/app/app/contacts/page.tsx')).includes('Envelopes already sent'));
  assert.ok(!strip(read('src/app/app/page.tsx')).includes('Open the envelope'));
});

// ---- 26. Dates read day month year wherever a person sees one --------------------------------------------------------

test('26. a moment in a message, an email or a record reads "21 Nov 2026 05:40:12 UTC", and screens write the day first in every English browser', async () => {
  const { stampText, screenLocale, dayText, dateOnScreen } = await import('../src/lib/dates.ts');
  assert.equal(stampText('2026-11-21T05:40:12.345Z'), '21 Nov 2026 05:40:12 UTC');
  assert.equal(stampText('2026-11-21T05:40:12.345Z', false), '21 Nov 2026 05:40 UTC');
  assert.equal(stampText(new Date('2027-03-01T23:59:59Z')), '1 Mar 2027 23:59:59 UTC');
  assert.equal(stampText(null), '');
  assert.equal(stampText('not a time'), 'not a time');
  assert.equal(dayText('2026-11-21T23:30:00Z'), '21 Nov 2026');
  // Without a browser (a page drawn on the server) the day comes first.
  assert.equal(screenLocale(), 'en-GB');
  assert.equal(new Date('2026-11-21T12:00:00Z').toLocaleDateString(screenLocale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }), '21 November 2026');
  // A US English browser on the page of a deleted document: day first too. French keeps its own way.
  assert.equal(dateOnScreen('2026-11-21T00:00:00Z', 'en-US', 'UTC'), '21 November 2026');
  assert.equal(dateOnScreen('2026-11-21T00:00:00Z', 'fr-FR', 'UTC'), '21 novembre 2026');
});

test('26. no screen writes a date in the browser\'s region order, and no message or record writes 2026-11-21 05:40 UTC', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const p = `${d}/${f.name}`;
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f.name)) files.push(p);
    }
  };
  walk('src');
  const region: string[] = [], iso: string[] = [], monthFirst: string[] = [];
  for (const f of files) {
    const s = read(f);
    if (/toLocale(Date|Time)?String\(undefined, \{[^}]*(day|month|year)/.test(s)) region.push(f);
    if (/\.replace\('T', ' '\)\.replace\(\/\\\.\\d\+Z\$\/, ' UTC'\)/.test(s) || /slice\(0, 16\)\.replace\('T', ' '\)\} UTC/.test(s)) iso.push(f);
    if (/toLocaleDateString\('en(-US)?', \{/.test(s)) monthFirst.push(f);
  }
  assert.deepEqual(region, [], 'these write the month first in a US browser');
  assert.deepEqual(iso, [], 'these write a moment year first');
  // Left for the payment owner (their files and their tests, billing2 and billing7, pin "March 7, 2031"): the plan
  // emails' days in src/server/routes-billing.ts and priceChangeDay in src/lib/policy.ts. Only those two may still
  // write the month first; when the payment owner switches them to day first, this stays green.
  for (const f of monthFirst) assert.ok(['src/lib/policy.ts', 'src/server/routes-billing.ts'].includes(f), `${f} writes the month first`);
});

// ---- 27. /pricing and /features are short and plain ------------------------------------------------------------------

test('27. /pricing shows the two plans there are, three rules and closed folds; /features the list and one closed fold', async () => {
  const { PLANS } = await import('../src/lib/impact.ts');
  const pricing = read('src/app/pricing/page.tsx'), features = read('src/app/features/page.tsx');
  // Exactly the plans that exist, each card with three lines.
  assert.deepEqual(Object.keys(PLANS), ['seedling', 'grove']);
  const cards = pricing.split('<div className="card pub-plan').slice(1).map((c) => c.slice(0, c.indexOf('</ul>')));
  assert.equal(cards.length, Object.keys(PLANS).length);
  for (const c of cards) assert.equal((c.match(/<li>/g) || []).length, 3);
  // The comparison is folded and closed; a link to #compare opens it (OpenOnHash).
  assert.match(pricing, /<details className="pub-fold" id="compare" data-fold="">\s*<summary id="compare-h">How it compares with other e-signature tools<\/summary>/);
  assert.doesNotMatch(pricing, /Hash chained/);
  // /features: the twelve features, the nine promises behind one closed fold, one button.
  assert.match(features, /<details className="pub-fold" data-fold="">\s*<summary id="promises-h">Nine things that go wrong elsewhere, and what we do instead<\/summary>/);
  assert.doesNotMatch(features, /<details[^>]* open/);
  assert.doesNotMatch(features, /hash-chained/);
  // Measured at 390 by 844 (tests/out/finish-open-public/measure.cjs): /pricing 3.1 screens and 312 words (was 5.8
  // and 617), /features 4.0 and 540 (was 7.3 and 1,111).
});

// ---- 34. /help and /verify say document; "Envelope ID" stays, because that is the label printed on every page -------

test('34. /help and /verify say document, cancel and Edit as the app does, and keep "Envelope ID" as the PDF prints it', () => {
  const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const help = strip(read('src/app/help/page.tsx'));
  assert.doesNotMatch(help, /\benvelopes?\b/i);
  assert.doesNotMatch(help, /\ban document\b|Edit document|void it\b/);
  for (const f of ['src/app/verify/page.tsx', 'src/app/verify/ById.tsx']) {
    const text = strip(read(f)).replace(/res\.(deleted\.)?envelope(_id)?|envelope ID|Envelope ID|envelope_id|\.envelope\b/g, '');
    assert.doesNotMatch(text.replace(/[A-Za-z]*[eE]nvelope[A-Za-z]*\(|['"`]\/api\/[^'"`]*/g, ''), />[^<{]*\benvelopes?\b[^<{]*</i, f);
  }
  assert.match(read('src/server/brandpdf.ts') + read('src/server/pdf.ts'), /GrowSigning Envelope ID: /);
});

// ---- repair-open-public: what the skeptic and the simplicity reviewer found ----------------------------------------

// Every file /help or /verify draws text from: the page, its parts and the lib files they import (not server files).
function shownFrom(page: string): string[] {
  const seen = new Set<string>();
  const resolve = (from: string, spec: string): string | null => {
    const p = spec.startsWith('@/') ? path.join(root, 'src', spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
    if (!p) return null;
    for (const c of [p, `${p}.ts`, `${p}.tsx`]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    return null;
  };
  const visit = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const r = resolve(f, m[1]);
      if (r && !r.includes(`${path.sep}server${path.sep}`)) visit(r);
    }
  };
  visit(path.join(root, page));
  return [...seen];
}
// The words a person can read in a file: its strings and the text between JSX tags, without comments.
function readable(file: string): string[] {
  const s = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  return [...s.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|>[^<>{}]+</g)].map((m) => m[0])
    .filter((t) => /\s/.test(t) && /[a-z]{3}/.test(t))
    // Code that only looks like text to this reader: ") : envelope ? (" between two tags, or a run across a type.
    .filter((t) => !/\)\s*:\s*\w+\s*\?|=>|^\s*(export|const|type) /m.test(t));
}

test('34. nothing /help or /verify prints, from the page or any file it takes text from, says envelope or void', () => {
  const bad: string[] = [];
  // Kept for the payment owner: HELD_EXPIRY_TEXT is pinned word for word by tests/billing9.test.ts (see the report).
  const keptFor = /A signature held for an envelope that is out/;
  for (const page of ['src/app/help/page.tsx', 'src/app/verify/page.tsx']) {
    for (const f of shownFrom(page)) {
      for (const t of readable(f)) {
        if (keptFor.test(t)) continue;
        const clean = t.replace(/[Ee]nvelope ID/g, '').replace(/\/api\/[^\s'"`]*/g, '').replace(/\$\{[^}]*\}/g, '');
        if (/\benvelopes?\b|\bvoid(ed|ing)?\b/i.test(clean)) bad.push(`${path.relative(root, f)}: ${t.slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
  // The scan really reads the parts: /help takes text from outside.tsx, stamps.tsx, bysender.ts and policy.ts.
  const parts = shownFrom('src/app/help/page.tsx').map((f) => path.relative(root, f));
  for (const f of ['src/app/help/outside.tsx', 'src/app/help/stamps.tsx', 'src/lib/bysender.ts', 'src/lib/policy.ts']) assert.ok(parts.includes(f), f);
});

test('18. the badge on a cancelled document says Cancelled, as its page does, and /verify says cancelled too', () => {
  assert.match(read('src/components/ui.tsx'), /voided: 'Cancelled'/);
  assert.doesNotMatch(read('src/components/ui.tsx'), /voided: 'Voided'/);
  const byId = read('src/app/verify/ById.tsx');
  assert.match(byId, /title: `Cancelled\$\{r\.closed_at/);
  assert.match(byId, /voided: 'cancelled'/);
});

test('22. the wording version reads day first where a person sees it, and stays as stored in the record', async () => {
  const { versionText, readableWording } = await import('../src/lib/wordingday.ts');
  const { consentAuditNote, consentVersionOf, CONSENT_VERSION } = await import('../src/lib/policy.ts');
  assert.equal(versionText('2026-11-21'), '21 Nov 2026');
  assert.equal(versionText('2026-11'), 'Nov 2026');
  assert.equal(versionText('2026-13'), '2026-13', 'not a month: left as it is');
  assert.equal(versionText('v2'), 'v2');
  const stated = `Sam. ${consentAuditNote('2026-11-21')}`;
  assert.equal(readableWording(stated), 'Sam. Wording of 21 Nov 2026, in English (en), as printed on the help page under "What do I agree to before I sign?".');
  const unstated = `Sam. ${consentAuditNote('2026-11-21', false)}`;
  assert.match(readableWording(unstated), /The wording in use was the one of 21 Nov 2026, in English/);
  // The record itself is unchanged, and the version is still read from it.
  assert.equal(consentVersionOf(stated), '2026-11-21');
  assert.equal(readableWording('Moved to 2026-11-21 by Ada.'), 'Moved to 2026-11-21 by Ada.', 'nothing else in a line changes');
  assert.equal(readableWording(null), '');
  // /help says it the same way, and the PDF and the History on screen print through readableWording.
  assert.match(read('src/app/help/outside.tsx'), /This is the wording of \{versionText\(w\.version\)\}, the one in use now/);
  assert.match(read('src/server/pdf.ts'), /readableWording\(payLineForPrint\(a\.action, a\.detail\)\)/);
  assert.match(read('src/components/sender/History.tsx'), /readableWording\(removedInWords\(l\.detail, dayText\)\)/);
  // The wording in use moved to 2026-11-23 (one sentence, the rest behind a link: tests/consent-short.test.ts), and reads the same way.
  assert.equal(CONSENT_VERSION, '2026-11-23');
  assert.equal(versionText(CONSENT_VERSION), '23 Nov 2026');
  assert.equal(readableWording(`Sam. ${consentAuditNote(CONSENT_VERSION)}`), 'Sam. Wording of 23 Nov 2026, in English (en), as printed on the help page under "What do I agree to before I sign?".');
});

test('22. on a signed PDF the consent line names the wording day first, never as 2026-11-21', { skip: !havePoppler && 'pdftotext is not installed' }, async () => {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([612, 792]).drawText('A short agreement.', { x: 72, y: 700, size: 11, font });
  const owner = await signUp('Wes Wording', 'wes.wording@example.com', newIp());
  const { pdf } = await signedCopy(owner, await d.save(), 'wren.wording@example.com');
  const { text } = drawPages(pdf);
  const flat = text.replace(/\s+/g, ' ');
  assert.match(flat, /wording in use was the one of \d{1,2} [A-Z][a-z]{2} \d{4}, in English/);
  assert.doesNotMatch(flat, /[Ww]ording (in use was )?\d{4}-\d{2}/);
});

test('/verify has a tab title of its own', () => {
  assert.match(read('src/app/verify/layout.tsx'), /export const metadata = \{ title: 'Verify a signed document' \}/);
});

test('server refusals name the button the document page has (Edit), not "Edit envelope"', () => {
  for (const f of ['src/server/envelopes.ts', 'src/server/groups.ts']) assert.doesNotMatch(read(f), /Edit envelope/, f);
  assert.match(read('src/lib/envelopepage.ts'), /add\('edit', 'Edit'\)/);
});

test('27. /features: twelve short cards in the words of the charter, the API as one card with a link', () => {
  const features = read('src/app/features/page.tsx');
  const list = features.slice(features.indexOf('const FEATURES'), features.indexOf('];', features.indexOf('const FEATURES')));
  const cards = [...list.matchAll(/^  \['([^']+)', ['`](.*?)['`](?:, \[|\],?$)/gm)];
  assert.equal(cards.length, 12);
  assert.doesNotMatch(list, /Recipients|certificate of completion|The certificate says|embed signing|validated|webhooks/);
  assert.match(list, /\['\/developers', 'See the API'\]/);
  // Each card's own words (not counting the shared sentences it quotes) stay short.
  for (const [, t, d] of cards) assert.ok(d.replace(/\$\{[A-Z_]+\}/g, '').split(/\s+/).filter(Boolean).length <= 40, `${t} is short`);
});
