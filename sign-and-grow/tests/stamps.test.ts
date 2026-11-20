// Stamps: a company stamp or seal next to a signature, printed like ink. The processing steps as pure functions
// (paper removed under uneven light, one ink, the strength of each mark kept, the same result for the same seed,
// trimmed to the ink), the account's stamps and who may change them, a stamp field for a recipient and for the
// sender, the signed PDF (multiplied in, slightly see-through, the words under it still in the file), the record and
// the certificate, Finish later, signing again after a change, templates, bulk sends, public forms, signing groups,
// the limits and who may see a picture, money, the evidence pack and the export, and the honest words.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument, PDFName, PDFDict, PDFNumber } from 'pdf-lib';
import { boot, Client, signUp, upload, PNG, type Server } from './helpers.ts';
import * as ink from '../src/lib/stampink.ts';
import { encodePng, decodePng, readPng } from '../src/server/png.ts';
import { STAMP_IS, stampFileProblem, stampBox, STAMP_DEFAULT_MM, STAMPS_PER_ACCOUNT, STAMP_UPLOADS_PER_LINK_HOUR } from '../src/lib/stamps.ts';

let s: Server;
let db: Server['db'];
before(async () => {
  s = await boot();
  db = s.db;
});

let n = 0;
const ip = () => `10.91.${Math.floor(++n / 250)}.${n % 250}`;
const from = () => Object.assign(new Client(), { ip: ip() });
const person = (name: string, email: string) => signUp(name, email, ip());
const ok = (r: { status: number; data: any }, what = '') => (assert.equal(r.status, 200, `${what} ${JSON.stringify(r.data)}`), r.data);
const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const trail = (envelopeId: string) => db.all('SELECT actor, action, detail FROM audit WHERE envelope_id=? ORDER BY seq', envelopeId);

// ---- Pictures made here --------------------------------------------------------------------------------------

type Px = { width: number; height: number; data: Uint8ClampedArray };
/**
 * A photo-like picture of a round stamp: paper of a colour, light that falls off towards the right, a ring of ink,
 * a thick bar and a thin faint line inside it, and optionally a black line of printed text above it.
 */
function picture(o: { w?: number; h?: number; paper?: number[]; dark?: number; ink?: number[]; text?: boolean; faint?: number } = {}): Px {
  const w = o.w ?? 300, h = o.h ?? 260, paper = o.paper ?? [244, 241, 232], dark = o.dark ?? 0, colour = o.ink ?? [40, 60, 160], faint = o.faint ?? 0.5;
  const data = new Uint8ClampedArray(w * h * 4);
  const cx = w / 2, cy = h / 2 + 10, R = 90;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const light = 1 - dark * (x / w);
      const d = Math.hypot(x - cx, y - cy);
      let s = 0;
      if (d > R - 9 && d < R) s = 1; // the ring
      if (Math.abs(y - cy) < 6 && Math.abs(x - cx) < 40) s = 1; // a thick bar
      if (x === Math.round(cx) && Math.abs(y - cy) > 12 && Math.abs(y - cy) < 50) s = faint; // a thin, fainter line
      let px = paper.map((v, c) => v * (1 - s + (s * colour[c]) / 255));
      if (o.text && y > 8 && y < 14 && x > 20 && x < w - 20 && (x >> 3) % 2) px = [30, 30, 30];
      const i = (y * w + x) * 4;
      data[i] = px[0] * light;
      data[i + 1] = px[1] * light;
      data[i + 2] = px[2] * light;
      data[i + 3] = 255;
    }
  return { width: w, height: h, data };
}
const plain = (look: Partial<ink.Look> = {}): ink.Look => ({ ink: 'blue', seed: 7, tilt: 0, texture: 0, paper: 0.5, onlyInk: true, ...look });
const alphaAt = (img: ink.Rgba, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];

/** A finished impression as the stamp screen sends it: a transparent PNG data URL. */
function stampPng(seed = 7, colour: ink.Ink = 'blue', o: { w?: number } = {}): string {
  const r = ink.impression(ink.prepare(picture({ w: o.w })), { ...plain({ ink: colour, seed, texture: 0.5, tilt: ink.tiltFor(seed) }) });
  return `data:image/png;base64,${encodePng(r.image).toString('base64')}`;
}

// ---- 1. Turning a picture into an impression -----------------------------------------------------------------

test('paper goes, also where the light is uneven and the paper is grey or coloured; the ink stays', () => {
  for (const [what, pic] of [['white paper', picture()], ['light falling off by half', picture({ dark: 0.5 })], ['grey paper', picture({ paper: [170, 170, 165] })], ['yellow paper', picture({ paper: [246, 228, 160] })]] as const) {
    const r = ink.impression(ink.prepare(pic), plain());
    assert.equal(r.empty, false, what);
    const img = r.image;
    // The corners of the box around a ring are paper: nothing is left there.
    for (const [x, y] of [[1, 1], [img.width - 2, 1], [1, img.height - 2], [img.width - 2, img.height - 2]]) assert.equal(alphaAt(img, x, y), 0, `${what}: corner ${x},${y} is see-through`);
    // The middle of the ring, outside the bar and the line, is paper too.
    let paperLeft = 0, inkPx = 0;
    for (let i = 3; i < img.data.length; i += 4) (img.data[i] > 200 ? inkPx++ : img.data[i] > 25 && paperLeft++);
    assert.ok(inkPx > 3000, `${what}: the ring and the bar are ink (${inkPx})`);
    assert.ok(paperLeft < inkPx * 0.25, `${what}: almost nothing in between (${paperLeft} against ${inkPx})`);
  }
  // One global cut would have lost this: on the dark side the paper is darker than the ink is on the bright side.
  const pic = picture({ dark: 0.55 });
  const r = ink.impression(ink.prepare(pic), plain());
  const right = Array.from({ length: r.image.height }, (_, y) => alphaAt(r.image, r.image.width - 8, y)).filter((a) => a > 200).length;
  assert.ok(right > 10, 'the ring on the dark side is still ink');
});

test('one ink: every pixel is the ink colour, and how strong each mark was is kept, so a thin faint line stays thin and faint', () => {
  const r = ink.impression(ink.prepare(picture({ faint: 0.45 })), plain({ ink: 'red' }));
  const [R, G, B] = ink.INK_RGB.red;
  for (let i = 0; i < r.image.data.length; i += 4) if (r.image.data[i + 3]) assert.deepEqual([r.image.data[i], r.image.data[i + 1], r.image.data[i + 2]], [R, G, B]);
  // The thin line: in a row through it, the ink is one or two pixels wide and weaker than the ring.
  const img = r.image;
  const cx = Math.round(img.width / 2);
  const y = Math.round(img.height / 2) + 35;
  const row = Array.from({ length: img.width }, (_, x) => alphaAt(img, x, y));
  const lineAt = row.map((a, x) => [a, x]).filter(([a, x]) => a > 20 && Math.abs(x - cx) < 20);
  assert.ok(lineAt.length >= 1 && lineAt.length <= 3, `the thin line is still thin: ${lineAt.length} pixels`);
  const ring = Math.max(...row.slice(0, 20));
  const line = Math.max(...lineAt.map(([a]) => a));
  assert.ok(line < ring * 0.85, `the faint line stays fainter than the ring (${line} against ${ring})`);
});

test('the likely ink is found and offered first; marks in another colour are left out; a logo is said to have several colours', () => {
  assert.equal(ink.prepare(picture({ ink: [190, 30, 40] })).found.ink, 'red');
  assert.equal(ink.prepare(picture({ ink: [40, 60, 160] })).found.ink, 'blue');
  assert.equal(ink.prepare(picture({ ink: [90, 40, 140] })).found.ink, 'purple');
  assert.equal(ink.prepare(picture({ ink: [30, 30, 30] })).found.ink, 'black');
  assert.equal(ink.prepare(picture({ ink: [30, 120, 60] })).found.ink, 'green');
  assert.equal(ink.prepare(picture({ ink: [255, 255, 255] })).found.empty, true, 'blank paper has no ink');
  // A blue stamp with a line of black printed text above it: the text is left out unless asked for.
  const p = ink.prepare(picture({ text: true }));
  assert.equal(p.found.ink, 'blue');
  const only = ink.impression(p, plain());
  const all = ink.impression(p, plain({ onlyInk: false }));
  assert.ok(all.image.height > only.image.height + 30, `the black text is kept only when asked (${all.image.height} against ${only.image.height})`);
  // Two colours of the same weight: several.
  const two = picture({ ink: [190, 30, 40] });
  for (let y = 0; y < two.height; y++) for (let x = 0; x < two.width / 2; x++) {
    const i = (y * two.width + x) * 4;
    if (two.data[i] < 200) (two.data[i] = 30, two.data[i + 1] = 120, two.data[i + 2] = 60);
  }
  assert.equal(ink.prepare(two).found.several, true);
});

test('the same picture and seed give the same impression; another seed another; trimmed to the ink with a small margin; a tilt from -4 to 4', () => {
  const p = ink.prepare(picture());
  const look = plain({ texture: 0.6, seed: 4242, tilt: ink.tiltFor(4242) });
  const a = ink.impression(p, look), b = ink.impression(ink.prepare(picture()), look);
  assert.equal(Buffer.compare(Buffer.from(a.image.data), Buffer.from(b.image.data)), 0, 'pixel for pixel the same');
  const c = ink.impression(p, { ...look, seed: 4243 });
  assert.notEqual(Buffer.compare(Buffer.from(a.image.data), Buffer.from(c.image.data)), 0);
  // Trimmed: the ring is 180 pixels across; with the margin the picture is a little more, never the whole photo.
  const flat = ink.impression(p, plain());
  assert.ok(flat.image.width >= 180 && flat.image.width <= 200, `width ${flat.image.width}`);
  assert.ok(flat.image.height >= 180 && flat.image.height <= 200, `height ${flat.image.height}`);
  // Something touches every edge of the margin? No: the margin is empty, the ink comes close to it.
  assert.equal(alphaAt(flat.image, 0, Math.round(flat.image.height / 2)), 0);
  assert.ok(Array.from({ length: 10 }, (_, x) => alphaAt(flat.image, x, Math.round(flat.image.height / 2))).some((v) => v > 100), 'the ink starts within a few pixels');
  for (let seed = 1; seed < 2000; seed += 37) {
    const t = ink.tiltFor(seed);
    assert.ok(Math.abs(t) <= ink.TILT_MAX && Math.abs(t) >= 0.5, `tilt ${t}`);
  }
  // A tilt makes the box larger; 0 leaves it straight.
  const tilted = ink.impression(p, plain({ tilt: 4 }));
  assert.ok(tilted.image.width > flat.image.width);
});

test('rubber texture: uneven, with specks, deterministic, and never so much that the ink stops reading', () => {
  const p = ink.prepare(picture());
  const flat = ink.impression(p, plain());
  const worn = ink.impression(p, plain({ texture: 1, seed: 99 }));
  const strong = (img: ink.Rgba) => { const v: number[] = []; for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) v.push(img.data[i]); return v; };
  const fv = strong(flat.image), wv = strong(worn.image);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  assert.ok(mean(wv) < mean(fv), 'a worn stamp is a little lighter');
  assert.ok(mean(wv) > mean(fv) * 0.7, `but most of the ink is there (${mean(wv).toFixed(0)} against ${mean(fv).toFixed(0)})`);
  // Uneven: the solid bar is no longer one value.
  const bar = (img: ink.Rgba) => { const y = Math.round(img.height / 2) + 1, out: number[] = []; for (let x = Math.round(img.width / 2) - 30; x < img.width / 2 + 30; x++) out.push(alphaAt(img, x, y)); return out; };
  assert.equal(new Set(bar(flat.image)).size <= 3, true, 'even ink is even');
  assert.ok(new Set(bar(worn.image)).size > 8, 'worn ink is not');
});

test('a design saved with a see-through background, a stamp that fills the whole picture, a dark table at the edge of a photo', () => {
  // See-through background: laid on white first.
  const clear = picture();
  for (let i = 0; i < clear.data.length; i += 4) if (clear.data[i] > 200) clear.data[i + 3] = 0;
  assert.equal(ink.impression(ink.prepare(clear), plain()).empty, false);
  // A red seal that fills the picture with white characters: the red is ink, not paper.
  const seal: Px = { width: 120, height: 120, data: new Uint8ClampedArray(120 * 120 * 4) };
  for (let p = 0; p < 120 * 120; p++) {
    const x = p % 120, y = Math.floor(p / 120);
    const white = (x > 30 && x < 50 && y > 20 && y < 100) || (x > 70 && x < 90 && y > 20 && y < 100);
    seal.data.set(white ? [250, 248, 244, 255] : [196, 30, 40, 255], p * 4);
  }
  const s1 = ink.impression(ink.prepare(seal), plain({ ink: 'red' }));
  assert.equal(ink.prepare(seal).found.ink, 'red');
  assert.ok(alphaAt(s1.image, 10, 10) > 200, 'the red is kept');
  // A dark band along the edge (the table under a phone photo) is not part of the stamp.
  const photo = picture();
  for (let y = 0; y < photo.height; y++) for (let x = photo.width - 25; x < photo.width; x++) photo.data.set([60, 58, 55, 255], (y * photo.width + x) * 4);
  const r = ink.impression(ink.prepare(photo), plain({ onlyInk: false }));
  assert.ok(r.image.width < 205, `the table is left out (${r.image.width})`);
});

test('which files can be a stamp: PNG, JPEG and WebP where the browser reads it; SVG, PDF and the rest are refused in words', () => {
  assert.equal(stampFileProblem({ name: 'seal.png', type: 'image/png', size: 1000 }), null);
  assert.equal(stampFileProblem({ name: 'seal.jpg', type: 'image/jpeg', size: 1000 }), null);
  assert.equal(stampFileProblem({ name: 'seal.webp', type: 'image/webp', size: 1000 }), null);
  assert.match(stampFileProblem({ name: 'seal.webp', type: 'image/webp', size: 1000 }, false)!, /this browser cannot read WebP/);
  assert.match(stampFileProblem({ name: 'seal.svg', type: 'image/svg+xml', size: 1000 })!, /is an SVG drawing\. A stamp has to be a picture/);
  assert.match(stampFileProblem({ name: 'seal.pdf', type: 'application/pdf', size: 1000 })!, /is a PDF\. A stamp has to be a picture/);
  assert.match(stampFileProblem({ name: 'seal.gif', type: 'image/gif', size: 1000 })!, /is not a PNG or JPEG/);
  assert.match(stampFileProblem({ name: 'IMG_1.HEIC', type: 'image/heic', size: 1000 })!, /HEIC/);
  assert.match(stampFileProblem({ name: 'big.jpg', type: 'image/jpeg', size: 9 * 1024 * 1024 })!, /can be up to 8 MB/);
  // The default size of a stamp field: a 40 mm seal, square on the page.
  const box = stampBox(STAMP_DEFAULT_MM, 612, 792);
  assert.ok(Math.abs(box.w * 612 - 113.4) < 0.5 && Math.abs(box.h * 792 - 113.4) < 0.5);
});

// ---- 2. The account's stamps ---------------------------------------------------------------------------------

test('admins keep up to ten stamps; members use them; names are checked; anything but a see-through PNG is refused in words', async () => {
  const owner = await person('Olu Owner', 'olu@stamps.example');
  const r = ok(await owner.post('/stamps', { name: 'Company stamp', image: stampPng(11), ink: 'blue', seed: 11, tilt: ink.tiltFor(11), texture: 0.5, size_mm: 42 }), 'create');
  assert.equal(r.stamp.name, 'Company stamp');
  assert.equal(r.stamp.size_mm, 42);
  assert.match(r.stamp.image_url, /^\/api\/stamps\/stp_/);
  const img = await owner.get(r.stamp.image_url.replace(/^\/api/, ''));
  assert.equal(img.status, 200);
  assert.ok(readPng(img.data), 'the picture is a PNG');
  // The same name twice is refused; so is no name.
  assert.equal((await owner.post('/stamps', { name: 'company STAMP', image: stampPng(12) })).status, 409);
  assert.match((await owner.post('/stamps', { name: ' ', image: stampPng(12) })).data.error, /Give the stamp a name/);
  // Pictures that are not a see-through PNG.
  assert.match((await owner.post('/stamps', { name: 'Svg', image: 'data:image/svg+xml;base64,PHN2Zz4=' })).data.error, /is an SVG drawing/);
  assert.match((await owner.post('/stamps', { name: 'Pdf', image: 'data:application/pdf;base64,JVBERi0=' })).data.error, /is a PDF/);
  assert.match((await owner.post('/stamps', { name: 'Jpeg', image: 'data:image/jpeg;base64,/9j/4AAQ' })).data.error, /is a JPEG picture\. A stamp is kept as a PNG whose paper is see-through/);
  const opaque = encodePng({ width: 60, height: 60, data: new Uint8Array(60 * 60 * 4).fill(255) });
  assert.match((await owner.post('/stamps', { name: 'Box', image: `data:image/png;base64,${opaque.toString('base64')}` })).data.error, /has no see-through background, so it would print as a box/);
  const empty = encodePng({ width: 60, height: 60, data: new Uint8Array(60 * 60 * 4) });
  assert.match((await owner.post('/stamps', { name: 'Empty', image: `data:image/png;base64,${empty.toString('base64')}` })).data.error, /no ink in it/);
  assert.match((await owner.post('/stamps', { name: 'Huge', image: stampPng(5, 'blue', { w: 300 }), size_mm: 500 })).data.error, /from 8 to 120/);
  assert.match((await owner.post('/stamps', { name: 'Pink', image: stampPng(5), ink: 'pink' })).data.error, /the ink "pink" is not one we have/);
  const big = encodePng({ width: 1200, height: 40, data: new Uint8Array(1200 * 40 * 4).map((_, i) => (i % 4 === 3 ? (i % 8 === 3 ? 255 : 0) : 30)) });
  assert.match((await owner.post('/stamps', { name: 'Wide', image: `data:image/png;base64,${big.toString('base64')}` })).data.error, /1200 by 40 pixels, and a stamp can be up to 1000/);

  // Text, dates and camera notes inside the file are not kept: only what draws it.
  const pix = decodePng(Buffer.from(stampPng(13).split(',')[1], 'base64'))!;
  const tagged = encodePng(pix, [{ type: 'tEXt', data: Buffer.from('Author\0Somebody at 12 Home Street') }, { type: 'eXIf', data: Buffer.from('MM\0*GPS') }]);
  const kept = ok(await owner.post('/stamps', { name: 'Received', image: `data:image/png;base64,${tagged.toString('base64')}`, ink: 'red' })).stamp;
  const stored = db.get('SELECT png FROM stamp_images WHERE sha256=?', kept.image_sha256).png;
  assert.ok(!Buffer.from(stored).includes('Somebody'), 'the text chunk is gone');
  assert.ok(!Buffer.from(stored).includes('GPS'), 'the camera notes are gone');
  assert.deepEqual(decodePng(stored)!.data, pix.data, 'the pixels are exactly the same');

  // A member sees and uses them, but cannot change them.
  const acct = db.get('SELECT account_id a FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?', 'olu@stamps.example').a;
  const inv = ok(await owner.post('/account/invites', { email: 'mem@stamps.example', role: 'member' }));
  const mem = await person('Mem Member', 'mem@stamps.example');
  const token = db.get('SELECT token FROM invites WHERE email=? AND account_id=?', 'mem@stamps.example', acct).token;
  ok(await mem.post('/invites/accept', { token }), `accept ${JSON.stringify(inv)}`);
  const seen = ok(await mem.get('/stamps'));
  assert.equal(seen.stamps.length, 2);
  assert.equal(seen.may_change, false);
  assert.match(seen.what_a_stamp_is, /is a picture of a stamp that someone on your team puts on a document\. Sign&Grow does not check that they may use it, and it is not a certified electronic seal\./);
  assert.equal((await mem.post('/stamps', { name: 'Mine', image: stampPng(14) })).status, 403);
  assert.equal((await mem.put(`/stamps/${kept.id}`, { name: 'Mine' })).status, 403);
  assert.equal((await mem.call('DELETE', `/stamps/${kept.id}`)).status, 403);
  // Another account cannot see the picture.
  const other = await person('Ot Other', 'ot@stamps-other.example');
  assert.equal((await other.get(`/stamps/${kept.id}/image`)).status, 404);

  // Ten at most.
  for (let i = 0; i < STAMPS_PER_ACCOUNT - 2; i++) ok(await owner.post('/stamps', { name: `Stamp ${i}`, image: stampPng(20 + i) }));
  const eleventh = await owner.post('/stamps', { name: 'One too many', image: stampPng(40) });
  assert.equal(eleventh.status, 409);
  assert.match(eleventh.data.error, /as many as an account can keep\. Delete one you no longer use under Settings, Stamps/);
});

test('a stamp name typed by an account that has not paid is checked like any other name; pictures are not read for words', async () => {
  const c = await person('Nia New', 'nia@stamps-unpaid.example');
  const lure = await c.post('/stamps', { name: 'PayPal billing', image: stampPng(3) });
  assert.equal(lure.status, 422);
  assert.match(lure.data.error, /reads like PayPal/);
  ok(await c.post('/stamps', { name: 'Accounts department', image: stampPng(3) }));
});

// ---- 3. On an envelope ---------------------------------------------------------------------------------------

async function stampedDraft(c: Client, o: { senderStamp?: string | null; mine?: boolean; required?: boolean; extra?: any[]; email?: string } = {}) {
  const file = await upload(c, 1);
  const fields: any[] = [
    { id: 'sig', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.75, w: 0.25, h: 0.06 },
    ...(o.mine === false ? [] : [{ id: 'st', document_id: 'd', recipient_id: 'r', type: 'stamp', label: 'Company stamp', page: 0, x: 0.07, y: 0.07, ...stampBox(40, 612, 792), required: o.required ?? true }]),
    ...(o.senderStamp ? [{ id: 'ss', document_id: 'd', type: 'stamp', stamp_id: o.senderStamp, page: 0, x: 0.55, y: 0.07, ...stampBox(40, 612, 792) }] : []),
    ...(o.extra || []),
  ];
  return ok(await c.post('/envelopes', {
    subject: 'Delivery note', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', name: 'Rita Receiver', email: o.email || `rita.${++n}@buyer.example` }], fields,
  }), 'draft').envelope;
}
const tokenOf = (eid: string) => db.get("SELECT token FROM recipients WHERE envelope_id=? AND role='signer'", eid).token;
async function opened(eid: string, c = from()) {
  const tok = tokenOf(eid);
  ok(await c.post(`/sign/${tok}/consent`), 'consent');
  const v = ok(await c.get(`/sign/${tok}`), 'view');
  return { c, tok, v };
}
const stampField = (eid: string, fid = 'st') => db.get('SELECT * FROM fields WHERE envelope_id=? AND type=? AND (label=? OR ? = ?)', eid, 'stamp', 'Company stamp', fid, 'any');
async function finish(tok: string, c: Client) {
  const v = ok(await c.get(`/sign/${tok}`));
  const values: Record<string, string> = {};
  for (const f of v.fields) if (f.type === 'signature') values[f.id] = '1';
  return c.post(`/sign/${tok}/complete`, { values, signature_png: PNG });
}
async function pdfText(pdf: Uint8Array): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const out: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) out.push(...(await (await doc.getPage(i)).getTextContent()).items.map((x: any) => x.str));
    return out.join('\n');
  } finally {
    await doc.destroy().catch(() => {});
  }
}
/** How the stamps are drawn on the first page: each graphics state with its blend mode and opacity. */
async function inkStates(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf);
  const res = doc.getPage(0).node.Resources()!;
  const gs = res.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  const xo = res.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const states = gs ? gs.keys().map((k) => gs.lookup(k, PDFDict)).map((d) => ({ bm: String(d.get(PDFName.of('BM')) ?? ''), ca: (d.get(PDFName.of('ca')) as PDFNumber | undefined)?.asNumber() })) : [];
  return { states, images: xo ? xo.keys().length : 0 };
}

test('a signer puts on their own stamp: kept by Finish later, never set by the answers, required before Finish, recorded with its fingerprint', async () => {
  const c = await person('Sam Sender', 'sam@stamps-send.example');
  const e = await stampedDraft(c);
  ok(await c.post(`/envelopes/${e.id}/send`), 'send');
  const { c: rita, tok, v } = await opened(e.id);
  const f = v.fields.find((x: any) => x.type === 'stamp');
  assert.equal(f.value, null);
  // The answers cannot put a picture on the page, and Finish without the stamp says what is missing.
  ok(await rita.post(`/sign/${tok}/save`, { values: { [f.id]: 'a'.repeat(64) } }));
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', f.id).value, null);
  const early = await finish(tok, rita);
  assert.equal(early.status, 400);
  assert.match(early.data.error, /A required field is still empty: Company stamp/);
  // Put on from a picture.
  const put = ok(await rita.post(`/sign/${tok}/stamp`, { field_id: f.id, image: stampPng(21, 'red'), ink: 'red', seed: 21, tilt: ink.tiltFor(21), texture: 0.5, from: 'camera' }), 'stamp');
  assert.match(put.value, /^[0-9a-f]{64}$/);
  assert.match(put.what_a_stamp_is, /a picture of a stamp that you put on the document\. Sign&Grow does not check that you may use it, and it is not a certified electronic seal\./);
  // Finish later, on another device: it is still there.
  ok(await rita.post(`/sign/${tok}/save`, { values: {} }));
  const again = ok(await from().get(`/sign/${tok}`));
  assert.equal(again.fields.find((x: any) => x.id === f.id).value, put.value);
  const pic = await rita.get(`/sign/${tok}/stamp-image/${put.value}`);
  assert.equal(pic.status, 200);
  // Taking it off, and on again.
  ok(await rita.call('DELETE', `/sign/${tok}/stamp/${f.id}`));
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', f.id).value, null);
  ok(await rita.post(`/sign/${tok}/stamp`, { field_id: f.id, image: stampPng(21, 'red'), ink: 'red', seed: 21, from: 'upload' }));
  ok(await finish(tok, rita), 'finish');
  const line = trail(e.id).find((a: any) => a.action === 'Stamp put on');
  assert.ok(line, 'the audit trail has the stamp');
  assert.match(line.detail, new RegExp(`Rita Receiver <rita\\.\\d+@buyer\\.example> put a stamp \\(a picture they uploaded, red ink\\) on page 1, in the field "Company stamp", at \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d UTC\\. Fingerprint of the picture \\(SHA-256\\): ${put.value}\\.`));
  assert.ok(trail(e.id).findIndex((a: any) => a.action === 'Stamp put on') < trail(e.id).findIndex((a: any) => a.action === 'Signed'));
  // After Finish it cannot be changed.
  assert.equal((await rita.call('DELETE', `/sign/${tok}/stamp/${f.id}`)).status, 400);
});

test('the signed PDF prints the stamp like ink: multiplied in, slightly see-through, no box, the words under it still in the file; the certificate lists it', async () => {
  const c = await person('Pia Printer', 'pia@stamps-pdf.example');
  const mine = ok(await c.post('/stamps', { name: 'Pia Trading Ltd', image: stampPng(31), ink: 'blue', seed: 31 })).stamp;
  const e = await stampedDraft(c, { senderStamp: mine.id });
  ok(await c.post(`/envelopes/${e.id}/send`));
  const sent = trail(e.id).find((a: any) => a.action === 'Stamp put on by the sender');
  assert.match(sent.detail, new RegExp(`The sender put the stamp "Pia Trading Ltd" \\(a saved stamp of the account, put on by the sender, blue ink\\) on page 1\\. Fingerprint of the picture \\(SHA-256\\): ${mine.image_sha256}\\.`));
  const { c: rita, tok, v } = await opened(e.id);
  // The sender's stamp is on the signer's page from the first look, as a picture by the signing link.
  const theirs = v.others.find((x: any) => x.type === 'stamp');
  assert.equal(theirs.image, `/api/sign/${tok}/stamp-image/${mine.image_sha256}`);
  assert.equal(theirs.stamp.name, 'Pia Trading Ltd');
  assert.equal(theirs.value, '', 'never its fingerprint as words');
  assert.equal((await rita.get(theirs.image.replace(/^\/api/, ''))).status, 200);
  const f = v.fields.find((x: any) => x.type === 'stamp');
  ok(await rita.post(`/sign/${tok}/stamp`, { field_id: f.id, image: stampPng(32, 'purple'), ink: 'purple', seed: 32 }));
  ok(await finish(tok, rita));
  const pdf = (await c.get(`/envelopes/${e.id}/download`)).data as Uint8Array;
  const { states, images } = await inkStates(pdf);
  const inked = states.filter((x) => x.bm === '/Multiply');
  assert.equal(inked.length >= 1, true, `multiplied in: ${JSON.stringify(states)}`);
  for (const x of inked) assert.equal(x.ca, 0.9, 'slightly less than full opacity');
  assert.ok(images >= 3, 'the two stamps and the signature are pictures on the page');
  const text = await pdfText(pdf);
  assert.match(text, /Agreement page 1/, 'the words under the stamp are still in the file');
  assert.match(text, /Sender's stamp/);
  assert.match(text, /"Pia Trading Ltd", a saved stamp of the account, on page 1\. Picture SHA-256/);
  assert.match(text, /A stamp, a picture they uploaded, on page 1, put on \d{4}-/);
  assert.match(text.replace(/\s+/g, ' '), /A stamp here is a picture of a stamp that this person put on the document\. Sign&Grow does not check that they may use it, and it is not a certified electronic seal\./);
  assert.doesNotMatch(text, /verified seal|certified stamp|legally binding seal|authenticated stamp/i, 'nothing claims more');
});

test('changing or deleting a stamp under Settings never changes a document it is on; a draft keeps its picture until asked', async () => {
  const c = await person('Cara Change', 'cara@stamps-change.example');
  const st = ok(await c.post('/stamps', { name: 'Old look', image: stampPng(41) })).stamp;
  const e = await stampedDraft(c, { senderStamp: st.id, mine: false });
  const ss = () => db.get("SELECT value, stamp_id, stamp_meta FROM fields WHERE envelope_id=? AND type='stamp' AND recipient_id IS NULL", e.id);
  assert.equal(ss().value, st.image_sha256);
  const changed = ok(await c.put(`/stamps/${st.id}`, { name: 'New look', image: stampPng(42), seed: 42 }));
  assert.notEqual(changed.stamp.image_sha256, st.image_sha256);
  assert.equal(changed.kept_on_documents, 1);
  assert.equal(ss().value, st.image_sha256, 'the draft keeps the picture it was put on with');
  // Saving the draft as it is keeps it too; asking for the stamp as it is now takes the new picture.
  const body = (await c.get(`/envelopes/${e.id}`)).data.envelope;
  ok(await c.put(`/envelopes/${e.id}`, { fields: body.fields }));
  assert.equal(ss().value, st.image_sha256);
  ok(await c.put(`/envelopes/${e.id}`, { fields: body.fields.map((f: any) => (f.type === 'stamp' ? { ...f, stamp_refresh: true } : f)) }));
  assert.equal(ss().value, changed.stamp.image_sha256);
  ok(await c.post(`/envelopes/${e.id}/send`));
  // Deleted under Settings: the envelope that went out still has its picture, and it still prints.
  ok(await c.call('DELETE', `/stamps/${st.id}`));
  assert.ok(db.get('SELECT 1 x FROM stamp_images WHERE sha256=?', changed.stamp.image_sha256), 'the picture stays while a document holds it');
  assert.equal(db.get('SELECT 1 x FROM stamp_images WHERE sha256=?', st.image_sha256), null, 'the picture nothing holds any more is gone');
  // A draft cannot be sent with an empty stamp of the sender, or a stamp that is not the account's.
  const e2 = await stampedDraft(c, { senderStamp: null, mine: false, extra: [{ document_id: 'd', type: 'stamp', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.15 }] });
  const no = await c.post(`/envelopes/${e2.id}/send`);
  assert.equal(no.status, 400);
  assert.match(no.data.error, /The stamp on page 1 has no stamp chosen yet\. Select it in the editor and choose one of your team's stamps, or remove it\./);
  const other = await person('Ot Other', 'ot2@stamps-other.example');
  const foreign = ok(await other.post('/stamps', { name: 'Not yours', image: stampPng(43) })).stamp;
  const f = await upload(c, 1);
  const bad = await c.post('/envelopes', { documents: [{ id: 'd', file_id: f.id }], recipients: [{ id: 'r', name: 'R', email: 'r@x.example' }], fields: [{ document_id: 'd', type: 'stamp', stamp_id: foreign.id, page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.15 }] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /names the stamp "stp_[^"]+", which this account does not have/);
  // A value sent for a stamp is refused in words.
  const val = await c.post('/envelopes', { documents: [{ id: 'd', file_id: f.id }], recipients: [{ id: 'r', name: 'R', email: 'r@x.example' }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'stamp', value: 'x', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.15 }] });
  assert.match(val.data.error, /A stamp field holds a stamp picture: a recipient puts their own on when they sign/);
});

test('a signed-in signer chooses a saved stamp of their own account; another address, a key or a device handed over in person cannot', async () => {
  const c = await person('Sol Sender', 'sol@stamps-saved.example');
  const buyer = await person('Bea Buyer', 'bea@buyer-co.example');
  const theirs = ok(await buyer.post('/stamps', { name: 'Buyer Co stamp', image: stampPng(51, 'green'), ink: 'green' })).stamp;
  const e = await stampedDraft(c, { email: 'bea@buyer-co.example' });
  ok(await c.post(`/envelopes/${e.id}/send`));
  const tok = tokenOf(e.id);
  ok(await buyer.post(`/sign/${tok}/consent`));
  const list = ok(await buyer.get(`/sign/${tok}/stamps`));
  assert.deepEqual(list.stamps.map((x: any) => x.name), ['Buyer Co stamp']);
  const f = ok(await buyer.get(`/sign/${tok}`)).fields.find((x: any) => x.type === 'stamp');
  const put = ok(await buyer.post(`/sign/${tok}/stamp`, { field_id: f.id, stamp_id: theirs.id }));
  assert.equal(put.value, theirs.image_sha256);
  assert.equal(JSON.parse(db.get('SELECT stamp_meta m FROM fields WHERE id=?', f.id).m).from, 'account');
  // The sender's own browser, signed in at another address, is offered nothing and cannot use one.
  ok(await c.post(`/sign/${tok}/consent`));
  assert.deepEqual(ok(await c.get(`/sign/${tok}/stamps`)).stamps, []);
  const mineToo = ok(await c.post('/stamps', { name: 'Sol stamp', image: stampPng(52) })).stamp;
  const no = await c.post(`/sign/${tok}/stamp`, { field_id: f.id, stamp_id: mineToo.id });
  assert.equal(no.status, 403);
  assert.match(no.data.error, /only when it is signed in with the address this document was sent to/);
  // A stamp id of another account is not found, whoever asks.
  const other = await buyer.post(`/sign/${tok}/stamp`, { field_id: f.id, stamp_id: mineToo.id });
  assert.equal(other.status, 404);
  // In person: the host's device. Saved stamps are never offered there.
  const file = await upload(c, 1);
  const ip2 = ok(await c.post('/envelopes', { send: true, subject: 'In person', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'inperson', name: 'Sol Sender', email: 'sol@stamps-saved.example' }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'stamp', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.15 }] })).envelope;
  const tip = db.get('SELECT token FROM recipients WHERE envelope_id=?', ip2.id).token;
  ok(await c.post(`/sign/${tip}/consent`));
  assert.equal(ok(await c.get(`/sign/${tip}/stamps`)).why_none, 'in person');
});

test('pictures from a signing link: a limit per hour, one per field, and shown to nobody outside that envelope', async () => {
  const c = await person('Lim Limits', 'lim@stamps-limits.example');
  const e = await stampedDraft(c);
  ok(await c.post(`/envelopes/${e.id}/send`));
  const { c: rita, tok, v } = await opened(e.id);
  const f = v.fields.find((x: any) => x.type === 'stamp');
  for (let i = 0; i < STAMP_UPLOADS_PER_LINK_HOUR; i++) ok(await rita.post(`/sign/${tok}/stamp`, { field_id: f.id, image: stampPng(100 + i), seed: 100 + i }), `upload ${i}`);
  const over = await rita.post(`/sign/${tok}/stamp`, { field_id: f.id, image: stampPng(200), seed: 200 });
  assert.equal(over.status, 429);
  assert.match(over.data.error, /That is a lot of stamp pictures in one hour, so this one was not taken\. Wait \d+ minutes and try again\. A stamp that is already on the page stays there\./);
  // One field holds one picture: the last one.
  assert.equal(db.all("SELECT value FROM fields WHERE envelope_id=? AND type='stamp' AND value IS NOT NULL", e.id).length, 1);
  // Anything but a stamp field of this person is refused.
  const sig = v.fields.find((x: any) => x.type === 'signature');
  assert.equal((await rita.post(`/sign/${tok}/stamp`, { field_id: sig.id, image: stampPng(1) })).status, 404);
  // The picture of this envelope by the link of another envelope: not found, even with the right fingerprint.
  const e2 = await stampedDraft(c);
  ok(await c.post(`/envelopes/${e2.id}/send`));
  const other = await opened(e2.id);
  const sha = db.get('SELECT value FROM fields WHERE id=?', f.id).value;
  assert.equal((await other.c.get(`/sign/${other.tok}/stamp-image/${sha}`)).status, 404);
  // And by the sender in the app, who can open the envelope: yes. Another account: no.
  assert.equal((await c.get(`/envelopes/${e.id}/stamp-image/${sha}`)).status, 200);
  const stranger = await person('Str Anger', 'str@stamps-stranger.example');
  assert.equal((await stranger.get(`/envelopes/${e.id}/stamp-image/${sha}`)).status, 404);
  // A second signer cannot see a stamp of the first before that person has finished.
  const file = await upload(c, 1);
  const two = ok(await c.post('/envelopes', { send: true, subject: 'Two', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'a', name: 'Ann A', email: 'ann@two.example' }, { id: 'b', name: 'Bo B', email: 'bo@two.example' }], fields: [
    { document_id: 'd', recipient_id: 'a', type: 'stamp', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.15 }, { document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.2, h: 0.06 }] })).envelope;
  const ta = db.get('SELECT token FROM recipients WHERE envelope_id=? AND email=?', two.id, 'ann@two.example').token;
  const tb = db.get('SELECT token FROM recipients WHERE envelope_id=? AND email=?', two.id, 'bo@two.example').token;
  const ann = from();
  ok(await ann.post(`/sign/${ta}/consent`));
  const fa = ok(await ann.get(`/sign/${ta}`)).fields[0];
  const annSha = ok(await ann.post(`/sign/${ta}/stamp`, { field_id: fa.id, image: stampPng(61) })).value;
  const bo = from();
  ok(await bo.post(`/sign/${tb}/consent`));
  assert.equal((await bo.get(`/sign/${tb}/stamp-image/${annSha}`)).status, 404, 'not before Ann finishes');
  assert.equal(ok(await bo.get(`/sign/${tb}`)).others.filter((x: any) => x.type === 'stamp').length, 0);
  ok(await ann.post(`/sign/${ta}/complete`, { values: {} }));
  assert.equal((await bo.get(`/sign/${tb}/stamp-image/${annSha}`)).status, 200, 'once she has');
});

test('money: a stamp is not a signature; a recipient who only stamps uses one signature when they finish, like any signer', async () => {
  const was = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_stamps';
  try {
    const credits = await import('../src/server/credits.ts');
    const c = await person('Mo Money', 'mo@stamps-money.example');
    const acct = db.get('SELECT account_id a FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?', 'mo@stamps-money.example').a;
    const before = credits.available(acct);
    // Only a stamp field: it can be sent, holds one signature and uses one.
    const e = await stampedDraft(c, { extra: [] });
    const body = (await c.get(`/envelopes/${e.id}`)).data.envelope;
    ok(await c.put(`/envelopes/${e.id}`, { fields: body.fields.filter((f: any) => f.type === 'stamp') }));
    ok(await c.post(`/envelopes/${e.id}/send`));
    assert.equal(credits.reserved(acct), 1);
    const { c: rita, tok, v } = await opened(e.id);
    ok(await rita.post(`/sign/${tok}/stamp`, { field_id: v.fields[0].id, image: stampPng(71) }));
    ok(await rita.post(`/sign/${tok}/complete`, { values: {} }), 'finish with only a stamp');
    assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'completed');
    assert.equal(credits.reserved(acct), 0);
    assert.equal(credits.available(acct), before - 1, 'one signature, as for any signer who finishes');
    // A signature and a stamp from one person: still one.
    const e2 = await stampedDraft(c);
    ok(await c.post(`/envelopes/${e2.id}/send`));
    const o2 = await opened(e2.id);
    ok(await o2.c.post(`/sign/${o2.tok}/stamp`, { field_id: o2.v.fields.find((x: any) => x.type === 'stamp').id, image: stampPng(72) }));
    ok(await finish(o2.tok, o2.c));
    assert.equal(credits.available(acct), before - 2);
    // The sender's own stamp holds and uses nothing.
    const st = ok(await c.post('/stamps', { name: 'Mo Ltd', image: stampPng(73) })).stamp;
    const e3 = await stampedDraft(c, { senderStamp: st.id, mine: false });
    ok(await c.post(`/envelopes/${e3.id}/send`));
    assert.equal(credits.reserved(acct), 1, 'one signer, one signature held: the sender\'s stamp holds none');
  } finally {
    if (was === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = was;
  }
});

test('a change after someone stamped: they put their stamp on again, as with a signature; a change to the sender\'s stamp needs the sign-again choice', async () => {
  const c = await person('Cor Rector', 'cor@stamps-correct.example');
  const a = ok(await c.post('/stamps', { name: 'Cor Ltd', image: stampPng(81) })).stamp;
  const b = ok(await c.post('/stamps', { name: 'Cor Ltd (new)', image: stampPng(82) })).stamp;
  const file = await upload(c, 1);
  const e = ok(await c.post('/envelopes', { send: true, subject: 'Two signers', ordered: false, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', name: 'Rita Receiver', email: 'rita@stamps-correct.example' }, { id: 'q', name: 'Quinn Q', email: 'quinn@stamps-correct.example' }],
    fields: [{ id: 'st', document_id: 'd', recipient_id: 'r', type: 'stamp', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.15 }, { id: 'ss', document_id: 'd', type: 'stamp', stamp_id: a.id, page: 0, x: 0.6, y: 0.1, w: 0.2, h: 0.15 },
      { document_id: 'd', recipient_id: 'q', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.2, h: 0.06 }] })).envelope;
  const tok = db.get('SELECT token FROM recipients WHERE envelope_id=? AND email=?', e.id, 'rita@stamps-correct.example').token;
  const rita = from();
  ok(await rita.post(`/sign/${tok}/consent`));
  const f = ok(await rita.get(`/sign/${tok}`)).fields[0];
  const first = ok(await rita.post(`/sign/${tok}/stamp`, { field_id: f.id, image: stampPng(83) })).value;
  ok(await rita.post(`/sign/${tok}/complete`, { values: {} }));
  // The sender's stamp changes: that is a change to what Rita signed.
  const cur = (await c.get(`/envelopes/${e.id}`)).data.envelope;
  const body = { fields: cur.fields.map((x: any) => (x.type === 'stamp' && !x.recipient_id ? { ...x, stamp_id: b.id, value: '' } : x)) };
  const refused = await c.put(`/envelopes/${e.id}`, body);
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'sign_again');
  assert.match(refused.data.error, /The sender's stamp on page 1 changed from "Cor Ltd" to "Cor Ltd \(new\)"\./);
  ok(await c.put(`/envelopes/${e.id}`, { ...body, resign: true }), 'with resign');
  assert.equal(db.get('SELECT value FROM fields WHERE id=?', f.id).value, null, 'her stamp is put on again, like a signature');
  const aside = db.get('SELECT answers FROM earlier_signatures WHERE envelope_id=?', e.id);
  assert.ok(JSON.parse(aside.answers).some((x: any) => x.type === 'stamp' && x.value === first), 'the first stamp is on record');
  assert.match(trail(e.id).find((x: any) => x.action === 'Asked to sign again').detail, new RegExp(`a stamp, whose picture has the SHA-256 ${first}`));
  // Her screen shows the new stamp of the sender, and she stamps and signs again.
  const v = ok(await rita.get(`/sign/${tok}`));
  assert.equal(v.others.find((x: any) => x.type === 'stamp').stamp.name, 'Cor Ltd (new)');
  ok(await rita.post(`/sign/${tok}/stamp`, { field_id: f.id, image: stampPng(84), version: v.version }));
  ok(await rita.post(`/sign/${tok}/complete`, { values: {}, version: v.version }));
  assert.ok(trail(e.id).some((x: any) => x.action === 'Signed again'));
  // Moving her stamp field after she finished needs the choice too; a correction before anyone finished keeps a stamp.
  const later = (await c.get(`/envelopes/${e.id}`)).data.envelope;
  const moved = await c.put(`/envelopes/${e.id}`, { fields: later.fields.map((x: any) => (x.id === f.id ? { ...x, x: 0.2 } : x)) });
  assert.equal(moved.status, 409);
});

test('templates, bulk sends, public forms and signing groups carry stamp fields; the sender\'s stamp goes with every copy', async () => {
  const c = await person('Tia Template', 'tia@stamps-tpl.example');
  const st = ok(await c.post('/stamps', { name: 'Tia Co', image: stampPng(91) })).stamp;
  const f = await upload(c, 1);
  const tpl = ok(await c.post('/envelopes', { kind: 'template', subject: 'Supplier form', documents: [{ id: 'd', file_id: f.id }],
    recipients: [{ id: 's', role: 'signer', role_name: 'Supplier' }],
    fields: [{ document_id: 'd', recipient_id: 's', type: 'stamp', label: 'Supplier stamp', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.15 }, { document_id: 'd', type: 'stamp', stamp_id: st.id, page: 0, x: 0.6, y: 0.1, w: 0.2, h: 0.15 }] })).envelope;
  const used = ok(await c.post('/envelopes', { template_id: tpl.id, send: true, recipients: { Supplier: { name: 'Sue Supplier', email: 'sue@stamps-tpl.example' } } })).envelope;
  const stamps = (eid: string) => db.all("SELECT recipient_id, value, stamp_id FROM fields WHERE envelope_id=? AND type='stamp' ORDER BY recipient_id IS NULL", eid);
  assert.deepEqual(stamps(used.id).map((x: any) => [!!x.recipient_id, x.value]), [[true, null], [false, st.image_sha256]]);
  assert.ok(trail(used.id).some((a: any) => a.action === 'Stamp put on by the sender'));
  // Bulk: every envelope has both.
  const bulk = ok(await c.post('/bulk', { template_id: tpl.id, rows: [1, 2].map((i) => ({ Supplier: { name: `Sup ${i}`, email: `sup${i}@stamps-tpl.example` } })) }));
  assert.equal(bulk.sent, 2, JSON.stringify(bulk));
  const batch = db.all('SELECT id FROM envelopes WHERE bulk_id IS NOT NULL AND account_id=(SELECT account_id FROM envelopes WHERE id=?)', tpl.id);
  for (const b of batch) assert.deepEqual(stamps(b.id).map((x: any) => x.value), [null, st.image_sha256]);
  // A public form: the visitor puts their own stamp on.
  const form = ok(await c.post('/powerforms', { template_id: tpl.id, name: 'Suppliers' }));
  const slug = db.get('SELECT slug FROM powerforms WHERE id=?', form.id).slug;
  ok(await Object.assign(new Client(), { ip: ip() }).post(`/public/powerforms/${slug}/start`, { name: 'Vic Visitor', email: 'vic@stamps-form.example' }), 'form start');
  const visit = db.get("SELECT e.id FROM envelopes e JOIN recipients r ON r.envelope_id=e.id WHERE r.email='vic@stamps-form.example'").id;
  const vt = db.get('SELECT token FROM recipients WHERE envelope_id=? AND email=?', visit, 'vic@stamps-form.example').token;
  const vic = from();
  ok(await vic.post(`/sign/${vt}/consent`));
  const vf = ok(await vic.get(`/sign/${vt}`)).fields.find((x: any) => x.type === 'stamp');
  ok(await vic.post(`/sign/${vt}/stamp`, { field_id: vf.id, image: stampPng(92, 'black'), ink: 'black' }));
  ok(await vic.post(`/sign/${vt}/complete`, { values: {} }), 'visitor finishes');
  assert.ok(trail(visit).some((a: any) => a.action === 'Stamp put on' && /Vic Visitor <vic@stamps-form\.example> put a stamp/.test(a.detail)));
  // A signing group: the member who takes it on puts the stamp on, recorded under their own name for the group.
  const grp = ok(await c.post('/groups', { name: 'Stores', members: [{ name: 'Gus Group', email: 'gus@stamps-grp.example' }, { name: 'Hal Group', email: 'hal@stamps-grp.example' }] })).group;
  const f2 = await upload(c, 1);
  const ge = ok(await c.post('/envelopes', { send: true, subject: 'Goods in', documents: [{ id: 'd', file_id: f2.id }], recipients: [{ id: 'g', role: 'signer', group_id: grp.id }], fields: [{ document_id: 'd', recipient_id: 'g', type: 'stamp', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.15 }] })).envelope;
  const link = db.get('SELECT token FROM recipient_members WHERE envelope_id=? AND email=?', ge.id, 'gus@stamps-grp.example').token;
  const gus = from();
  ok(await gus.post(`/sign/${link}/consent`));
  const gf = ok(await gus.get(`/sign/${link}`)).fields[0];
  ok(await gus.post(`/sign/${link}/stamp`, { field_id: gf.id, image: stampPng(93) }));
  ok(await gus.post(`/sign/${link}/complete`, { values: {} }));
  assert.match(trail(ge.id).find((a: any) => a.action === 'Stamp put on').detail, /^Gus Group <gus@stamps-grp\.example>, for Stores put a stamp|^Gus Group, for Stores/);
  // A stamp field for someone who does not sign is refused before sending.
  const f3 = await upload(c, 1);
  const cc = await c.post('/envelopes', { send: true, documents: [{ id: 'd', file_id: f3.id }], recipients: [{ id: 'a', role: 'approver', name: 'Ap Prover', email: 'ap@stamps-tpl.example' }], fields: [{ document_id: 'd', recipient_id: 'a', type: 'stamp', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.15 }] });
  assert.equal(cc.status, 400);
  assert.match(cc.data.error, /only someone who signs can put a stamp on the page/);
});

test('the evidence pack and the export carry the stamps; deleting an envelope takes its stamp pictures with it', async () => {
  const c = await person('Eva Evidence', 'eva@stamps-ev.example');
  const st = ok(await c.post('/stamps', { name: 'Eva Ltd', image: stampPng(95) })).stamp;
  const e = await stampedDraft(c, { senderStamp: st.id });
  ok(await c.post(`/envelopes/${e.id}/send`));
  const { c: rita, tok, v } = await opened(e.id);
  const mine = ok(await rita.post(`/sign/${tok}/stamp`, { field_id: v.fields.find((x: any) => x.type === 'stamp').id, image: stampPng(96) })).value;
  ok(await finish(tok, rita));
  const zip = Buffer.from((await c.get(`/envelopes/${e.id}/evidence`)).data as Uint8Array);
  assert.ok(zip.includes(`stamps/${mine.slice(0, 16)}.png`), 'the signer\'s stamp');
  assert.ok(zip.includes(`stamps/${st.image_sha256.slice(0, 16)}.png`), 'the sender\'s stamp');
  assert.ok(zip.includes('stamps/index.csv'));
  assert.ok(zip.includes('it is not a certified electronic seal'), 'the README says what a stamp is');
  const exp = Buffer.from((await c.get('/export')).data as Uint8Array);
  assert.ok(exp.includes('stamps/Eva Ltd'), 'the team\'s stamps are in the export');
  // A draft with a picture nobody else holds: deleting it takes the picture away.
  const d2 = await stampedDraft(c, { mine: false });
  ok(await c.post(`/envelopes/${d2.id}/send`));
  const o2 = await opened(d2.id);
  const f2 = ok(await o2.c.get(`/sign/${o2.tok}`)).fields;
  assert.equal(f2.length, 1);
  const file = await upload(c, 1);
  const lone = ok(await c.post('/envelopes', { send: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', name: 'Lo Ne', email: 'lone@stamps-ev.example' }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'stamp', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.15 }] })).envelope;
  const lt = db.get('SELECT token FROM recipients WHERE envelope_id=?', lone.id).token;
  const lo = from();
  ok(await lo.post(`/sign/${lt}/consent`));
  const sha = ok(await lo.post(`/sign/${lt}/stamp`, { field_id: ok(await lo.get(`/sign/${lt}`)).fields[0].id, image: stampPng(97, 'green') })).value;
  ok(await c.post(`/envelopes/${lone.id}/void`, { reason: 'Wrong file' }));
  ok(await c.call('DELETE', `/envelopes/${lone.id}`));
  assert.equal(db.get('SELECT 1 x FROM stamp_images WHERE sha256=?', sha), null);
});

test('the API description has the stamp field and the stamp routes; the words never claim more than a picture', async () => {
  const { openapi } = await import('../src/server/openapi.ts');
  const spec: any = openapi();
  assert.ok(spec.components.schemas.Field.properties.type.enum.includes('stamp'));
  assert.ok(spec.components.schemas.Field.properties.stamp_id);
  for (const p of ['/stamps', '/stamps/{id}', '/stamps/{id}/image', '/envelopes/{id}/stamp-image/{sha}', '/sign/{token}/stamp', '/sign/{token}/stamps']) assert.ok(spec.paths[p], `documented: ${p}`);
  assert.match(JSON.stringify(spec.paths['/stamps']), /not a certified electronic seal/);
  assert.match(STAMP_IS, /^A stamp here is a picture of a stamp that this person put on the document\. Sign&Grow does not check that they may use it, and it is not a certified electronic seal\.$/);
  for (const f of ['src/lib/stamps.ts', 'src/lib/stampink.ts', 'src/server/stamps.ts', 'src/server/routes-stamps.ts', 'src/server/png.ts', 'tests/stamps.test.ts'])
    assert.ok(!read(f).includes(String.fromCharCode(0x2014)), `no em dash in ${f}`);
});
