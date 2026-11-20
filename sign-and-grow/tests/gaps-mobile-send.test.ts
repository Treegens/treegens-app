// Sending from a phone: a photo of a paper page is upright on screen and in the signed PDF, several photos become
// one document, the browser stays signed in while it is used, Settings shows where a person is signed in, and the
// editor says what is true for a phone.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, signUp, upload, signAll, simple, samplePdf, Client, PNG, type Server } from './helpers.ts';
import { jpegOrientation, markUpright } from '../src/server/exif.ts';
import { imagesToPdf } from '../src/server/pdf.ts';
import { fitWithin } from '../src/lib/phone.ts';
import { MAX_PHOTOS_PER_DOCUMENT, PHOTO_MAX_SIDE } from '../src/lib/policy.ts';

let s: Server;
before(async () => {
  s = await boot();
});

let n = 0;
const ip = () => `198.51.103.${++n}`;
const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');

// ---- A photo with a note that says which way up it is ------------------------------------------------

// A real JPEG, 48 by 32 pixels as stored: the top left quarter red, the top right green, the bottom left blue, the
// bottom right white. No camera note in it.
const BASE = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAgADADAREAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAcKCP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAYAQEBAQEBAAAAAAAAAAAAAAAACQYHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AOWnHFJQAFKZVCcABNWqXYAAUplUJwAHI62T0GAA0zJtNgAAzMqSseAA0zJtNgAA/9k=', 'base64');
const STORED = { w: 48, h: 32 };

// The note a camera writes (EXIF, in an APP1 segment right after the start of the file), built here byte by byte:
// "Exif", a tiny TIFF with the byte order a phone uses (iPhones big-endian "MM", most Android phones little-endian
// "II"), and a list of entries. The orientation is entry 0x0112. A second entry stands before it, as in real files.
function exif(orientation: number, little: boolean, type = 3): Buffer {
  const u16 = (v: number) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) => (little ? [...u16(v & 65535), ...u16(v >>> 16)] : [...u16(v >>> 16), ...u16(v & 65535)]);
  const entry = (tag: number, kind: number, value: number[]) => [...u16(tag), ...u16(kind), ...u32(1), ...value, ...Array(4 - value.length).fill(0)];
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(2), ...entry(0x0128, 3, u16(2)), ...entry(0x0112, type, type === 3 ? u16(orientation) : u32(orientation)), ...u32(0)];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body]);
}
const photo = (orientation: number, little = false) => Buffer.concat([BASE.subarray(0, 2), exif(orientation, little), BASE.subarray(2)]);

// Where each stored corner must be seen once the picture is the right way up, for each value of the note.
// From the EXIF standard: 6 means "row 0 is the right-hand side, column 0 is the top", and so on.
const SEEN: Record<number, { red: string; green: string; blue: string }> = {
  1: { red: 'TL', green: 'TR', blue: 'BL' }, 2: { red: 'TR', green: 'TL', blue: 'BR' }, 3: { red: 'BR', green: 'BL', blue: 'TR' }, 4: { red: 'BL', green: 'BR', blue: 'TL' },
  5: { red: 'TL', green: 'BL', blue: 'TR' }, 6: { red: 'TR', green: 'BR', blue: 'TL' }, 7: { red: 'BR', green: 'TR', blue: 'BL' }, 8: { red: 'BL', green: 'TL', blue: 'BR' },
};

// Draws one page of a PDF the way a PDF viewer does, far enough to look at the photo on it: pdf.js reads the page,
// decodes the JPEG with its own decoder (which knows nothing about camera notes, like the viewers people download
// the signed PDF with) and hands over where the picture is put. The colour at a point of the page is then looked
// up by going back from the page to the picture. Returns the box the picture covers and a function for a colour.
async function drawn(pdf: Uint8Array, pageNo = 1, want = (img: any) => img.width > 8) {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const page = await doc.getPage(pageNo);
    const ops = await page.getOperatorList();
    const mul = (m: number[], t: number[]) => [m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1], m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3], m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5]];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === pdfjs.OPS.save) stack.push(ctm);
      else if (fn === pdfjs.OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === pdfjs.OPS.transform) ctm = mul(ctm, ops.argsArray[i]);
      else if (fn === pdfjs.OPS.paintImageXObject) {
        const img: any = await new Promise((res) => page.objs.get(ops.argsArray[i][0], res));
        if (!want(img)) continue;
        const [a, b, c, d, e, f] = ctm;
        const det = a * d - b * c;
        const per = img.data.length / (img.width * img.height);
        const colour = (x: number, y: number) => {
          const u = (d * (x - e) - c * (y - f)) / det, v = (-b * (x - e) + a * (y - f)) / det;
          if (u < 0 || u > 1 || v < 0 || v > 1) return 'paper';
          const col = Math.min(img.width - 1, Math.floor(u * img.width)), row = Math.min(img.height - 1, Math.floor((1 - v) * img.height));
          const [r, g, bl] = img.data.subarray((row * img.width + col) * per);
          return r > 180 && g < 80 && bl < 80 ? 'red' : g > 110 && r < 80 && bl < 80 ? 'green' : bl > 180 && r < 80 && g < 80 ? 'blue' : r > 200 && g > 200 && bl > 200 ? 'white' : `rgb(${r},${g},${bl})`;
        };
        const xs = [e, e + a, e + c, e + a + c], ys = [f, f + b, f + d, f + b + d];
        const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
        // A point well inside each quarter of the picture as it is seen. PDF y runs upwards, so "top" is the larger y.
        const at = (fx: number, fy: number) => colour(box.x0 + (box.x1 - box.x0) * fx, box.y0 + (box.y1 - box.y0) * fy);
        return { page: page.view as number[], box, stored: { w: img.width, h: img.height }, corners: { TL: at(0.2, 0.8), TR: at(0.8, 0.8), BL: at(0.2, 0.2), BR: at(0.8, 0.2) } };
      }
    }
    throw new Error('no picture on this page');
  } finally {
    await doc.destroy().catch(() => {});
  }
}
const whereIs = (corners: Record<string, string>, colour: string) => Object.keys(corners).filter((k) => corners[k] === colour).join('+');

async function uploadFiles(c: Client, files: { bytes: Uint8Array; name: string; type?: string }[]) {
  const f = new FormData();
  for (const x of files) f.append('file', new Blob([x.bytes], { type: x.type || 'image/jpeg' }), x.name);
  return c.call('POST', '/files', f);
}
const content = async (c: Client, id: string) => (await c.get(`/files/${id}/content`)).data as Uint8Array;
// The JPEG as it is kept inside a PDF we made: the bytes from its start-of-image mark to its end mark.
const jpegInside = (pdf: Uint8Array) => {
  const b = Buffer.from(pdf);
  const from = b.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  return from < 0 ? null : new Uint8Array(b.subarray(from, b.lastIndexOf(Buffer.from([0xff, 0xd9])) + 2));
};

test('the camera note in a JPEG is read in both byte orders, and nothing else is mistaken for one', () => {
  for (const little of [false, true])
    for (let o = 1; o <= 8; o++) {
      const got = jpegOrientation(photo(o, little));
      assert.equal(got?.value, o, `orientation ${o}, ${little ? 'II' : 'MM'}`);
      assert.equal(got?.little, little);
      // Setting it to "upright" changes those two bytes and nothing else.
      const fixed = markUpright(photo(o, little), got!);
      assert.equal(jpegOrientation(fixed)?.value, 1);
      assert.equal(fixed.length, photo(o, little).length);
      assert.equal(Buffer.from(fixed).equals(photo(o, little)), o === 1);
    }
  assert.equal(jpegOrientation(BASE), null, 'a JPEG with no note is upright as stored');
  assert.equal(jpegOrientation(Buffer.from(PNG.split(',')[1], 'base64')), null);
  assert.equal(jpegOrientation(new Uint8Array(0)), null);
  // Values outside 1 to 8 and a note stored as something else than a short number are not guessed at.
  assert.equal(jpegOrientation(photo(0)), null);
  assert.equal(jpegOrientation(photo(9)), null);
  assert.equal(jpegOrientation(Buffer.concat([BASE.subarray(0, 2), exif(6, false, 4), BASE.subarray(2)])), null);
  // A file cut off anywhere inside the note, or a note that points outside itself, gives no answer and no crash.
  const whole = photo(6, true);
  for (let cut = 2; cut < 60; cut++) assert.doesNotThrow(() => jpegOrientation(whole.subarray(0, cut)));
  const lying = Buffer.from(whole);
  lying.writeUInt32LE(0x7fffffff, 2 + 4 + 6 + 4); // the offset of the list
  assert.equal(jpegOrientation(lying), null);
});

test('a phone photo is upright in the document, whichever way the camera stored it', async () => {
  const c = await signUp('Fay Photo', 'fay@example.com', ip());
  for (let o = 1; o <= 8; o++) {
    const up = await uploadFiles(c, [{ bytes: photo(o, o % 2 === 0), name: `IMG_${o}.jpg` }]);
    assert.equal(up.status, 200, JSON.stringify(up.data));
    const side = o >= 5;
    // The page suits the picture as it is looked at: a photo taken with the phone upright gets an upright page.
    const size = up.data.page_sizes[0];
    assert.equal(size.w < size.h, side, `orientation ${o}: the page is ${side ? 'upright' : 'on its side'}`);
    const pdf = await content(c, up.data.id);
    const d = await drawn(pdf);
    // The picture is as wide and as tall on the page as it is when looked at upright, not squeezed into the other shape.
    const seen = side ? { w: STORED.h, h: STORED.w } : STORED;
    assert.ok(Math.abs((d.box.x1 - d.box.x0) / (d.box.y1 - d.box.y0) - seen.w / seen.h) < 0.01, `orientation ${o}: shape`);
    assert.ok(d.box.x0 >= 24 && d.box.y0 >= 24 && d.box.x1 <= d.page[2] - 24 && d.box.y1 <= d.page[3] - 24, `orientation ${o}: inside the page`);
    for (const colour of ['red', 'green', 'blue'] as const) assert.equal(whereIs(d.corners, colour), SEEN[o][colour], `orientation ${o}: ${colour}`);
    // The note in the bytes we keep says "upright", so a viewer that reads notes (a browser) does not turn it again.
    const kept = jpegInside(pdf)!;
    assert.equal(jpegOrientation(kept)?.value, 1, `orientation ${o}: the kept note`);
  }
  // A photo with no note is left exactly as it is.
  const plain = await uploadFiles(c, [{ bytes: BASE, name: 'plain.jpg' }]);
  const d = await drawn(await content(c, plain.data.id));
  assert.deepEqual([whereIs(d.corners, 'red'), whereIs(d.corners, 'green'), whereIs(d.corners, 'blue')], ['TL', 'TR', 'BL']);
  assert.equal(Buffer.from(jpegInside(await content(c, plain.data.id))!).equals(BASE), true);
});

test('what people sign is what they saw: the photo is upright in the signed PDF and the field is where it was placed', async () => {
  const c = await signUp('Gus Sender', 'gus@example.com', ip());
  const up = await uploadFiles(c, [{ bytes: photo(6), name: 'Lease page.jpg' }]);
  const made = await c.post('/envelopes', {
    subject: 'A photographed lease', documents: [{ id: 'd', file_id: up.data.id }],
    recipients: [{ id: 'r', role: 'signer', name: 'Hal Tenant', email: 'hal@example.com' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.85, w: 0.3, h: 0.06 }],
    send: true,
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const e = made.data.envelope;
  // The signer is shown the same stored file the sender placed the field on.
  const signer = new Client();
  const tok = s.db.get('SELECT token FROM recipients WHERE envelope_id=?', e.id).token;
  const view = (await signer.get(`/sign/${tok}`)).data;
  assert.equal(view.documents?.[0]?.pages ?? 1, 1);
  assert.equal((await signAll(e.id, 'hal@example.com')).status, 200);
  const signed = (await c.get(`/envelopes/${e.id}/download`)).data as Uint8Array;
  assert.equal(Buffer.from(signed.subarray(0, 4)).toString(), '%PDF');
  const d = await drawn(signed, 1, (img) => img.width === STORED.w && img.height === STORED.h);
  assert.equal(d.page[2] < d.page[3], true, 'the page of the signed PDF is upright');
  for (const colour of ['red', 'green', 'blue'] as const) assert.equal(whereIs(d.corners, colour), SEEN[6][colour], `signed PDF: ${colour}`);
  assert.equal(jpegOrientation(jpegInside(signed)!)?.value, 1);
});

test('several pictures sent together become one document, a page for each, in the order chosen', async () => {
  const c = await signUp('Ida Pages', 'ida@example.com', ip());
  const png = Buffer.from(PNG.split(',')[1], 'base64');
  // Upright photo, photo taken with the phone turned, a PNG: three pages, in this order.
  const up = await uploadFiles(c, [{ bytes: photo(6), name: 'IMG_4021.jpg' }, { bytes: photo(1), name: 'IMG_4022.JPG' }, { bytes: png, name: 'IMG_4023.png', type: 'image/png' }]);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.pages, 3);
  assert.equal(up.data.name, 'IMG_4021');
  assert.deepEqual(up.data.page_sizes.map((p: any) => (p.w < p.h ? 'upright' : 'on its side')), ['upright', 'on its side', 'upright']);
  assert.deepEqual(up.data.scan_pages, [1, 2, 3], 'every page is a picture, and the sender is told so');
  assert.ok(up.data.size > 0 && up.data.size === (await content(c, up.data.id)).length);
  const pdf = await content(c, up.data.id);
  assert.equal(whereIs((await drawn(pdf, 1)).corners, 'red'), 'TR');
  assert.equal(whereIs((await drawn(pdf, 2)).corners, 'red'), 'TL');
  // The other order gives the other document.
  const back = await uploadFiles(c, [{ bytes: photo(1), name: 'b.jpg' }, { bytes: photo(6), name: 'a.jpg' }]);
  assert.deepEqual(back.data.page_sizes.map((p: any) => (p.w < p.h ? 'upright' : 'on its side')), ['on its side', 'upright']);
  assert.equal(back.data.name, 'b');

  // It can be sent and signed like any document.
  const made = await c.post('/envelopes', {
    subject: 'Three photos', documents: [{ id: 'd', file_id: up.data.id }],
    recipients: [{ id: 'r', role: 'signer', name: 'Jo Signer', email: 'jo@example.com' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 2, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }], send: true,
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal((await signAll(made.data.envelope.id, 'jo@example.com')).status, 200);

  // Only pictures can be joined. A PDF among them is refused in words, and nothing is kept.
  const before = s.db.get('SELECT COUNT(*) n FROM files').n;
  const mixed = await uploadFiles(c, [{ bytes: photo(1), name: 'page.jpg' }, { bytes: await samplePdf(1), name: 'Contract.pdf', type: 'application/pdf' }]);
  assert.equal(mixed.status, 400);
  assert.match(mixed.data.error, /"Contract\.pdf" is not one\. Upload PDFs one at a time\. No document was made\./);
  // A picture that cannot be read is named, so the sender knows which one to leave out.
  const broken = await uploadFiles(c, [{ bytes: photo(1), name: 'good.jpg' }, { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), name: 'torn.jpg' }]);
  assert.equal(broken.status, 400);
  assert.match(broken.data.error, /"torn\.jpg" could not be read, so no document was made/);
  const many = await uploadFiles(c, Array.from({ length: MAX_PHOTOS_PER_DOCUMENT + 1 }, (_, i) => ({ bytes: BASE, name: `p${i}.jpg` })));
  assert.equal(many.status, 400);
  assert.match(many.data.error, new RegExp(`up to ${MAX_PHOTOS_PER_DOCUMENT} pictures, and this upload has ${MAX_PHOTOS_PER_DOCUMENT + 1}`));
  assert.equal(s.db.get('SELECT COUNT(*) n FROM files').n, before);
  // The most that is allowed works.
  const full = await uploadFiles(c, Array.from({ length: MAX_PHOTOS_PER_DOCUMENT }, (_, i) => ({ bytes: photo((i % 8) + 1), name: `p${i}.jpg` })));
  assert.equal(full.data.pages, MAX_PHOTOS_PER_DOCUMENT);
});

test('one upload of one file is what it always was, and a picture that is wider than tall gets a page on its side', async () => {
  const c = await signUp('Kim Single', 'kim@example.com', ip());
  const pdf = await upload(c, 2);
  assert.equal(pdf.pages, 2);
  assert.ok(pdf.size > 0);
  const wide = await uploadFiles(c, [{ bytes: BASE, name: 'Screenshot.jpeg' }]);
  assert.equal(wide.data.name, 'Screenshot');
  assert.deepEqual(wide.data.page_sizes, [{ w: 841.89, h: 595.28 }]);
  const square = await uploadFiles(c, [{ bytes: Buffer.from(PNG.split(',')[1], 'base64'), name: 'dot.png', type: 'image/png' }]);
  assert.deepEqual(square.data.page_sizes, [{ w: 595.28, h: 841.89 }]);
  // imagesToPdf says which picture it could not read only when there are several: one file needs no name.
  await assert.rejects(imagesToPdf([{ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), png: false }]), /That image could not be read\. Use a PNG or JPEG\./);
});

test('a photo is made smaller to a size a page needs, never larger, and keeps its shape', () => {
  assert.equal(PHOTO_MAX_SIDE, 2000);
  assert.deepEqual(fitWithin(4032, 3024), { w: 2000, h: 1500 }); // a 12 megapixel phone photo
  assert.deepEqual(fitWithin(3024, 4032), { w: 1500, h: 2000 });
  assert.deepEqual(fitWithin(8064, 6048), { w: 2000, h: 1500 }); // 48 megapixels
  assert.deepEqual(fitWithin(1200, 900), { w: 1200, h: 900 }, 'a small picture is left alone');
  assert.deepEqual(fitWithin(2000, 2000), { w: 2000, h: 2000 });
  assert.deepEqual(fitWithin(10000, 10), { w: 2000, h: 2 });
  assert.deepEqual(fitWithin(0, 0), { w: 1, h: 1 });
  // The editor uses this rule and asks before joining: the code that does it is where the pages say it is.
  const editor = read('src/components/Editor.tsx');
  assert.match(editor, /shrinkPhoto\(/);
  assert.match(editor, /<PhotoAsk /);
  assert.match(read('src/components/editor/photos.ts'), /fitWithin\(img\.naturalWidth, img\.naturalHeight\)/);
});
