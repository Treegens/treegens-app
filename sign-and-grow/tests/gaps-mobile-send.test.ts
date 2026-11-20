// Sending from a phone: a photo of a paper page is upright on screen and in the signed PDF, several photos become
// one document, the browser stays signed in while it is used, Settings shows where a person is signed in, and the
// editor says what is true for a phone.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { boot, signUp, upload, signAll, simple, samplePdf, mailTo, Client, PNG, type Server } from './helpers.ts';
import { jpegOrientation, markUpright, pictureSize, pictureLimit } from '../src/server/exif.ts';
import { sha256 } from '../src/server/util.ts';
import { imagesToPdf } from '../src/server/pdf.ts';
import { fitWithin, deviceName, IN_PERSON_LIMITS, IN_PERSON_LOCK, HEARD_AS, unlabelled, phoneWeight, phoneWait } from '../src/lib/phone.ts';
import { PDFDocument } from 'pdf-lib';
import { MAX_PHOTOS_PER_DOCUMENT, PHOTO_MAX_SIDE, SESSION_DAYS, SESSION_TOUCH_MINUTES, HAND_OVER_TRIES, PHONE_SLOW_BYTES, PHONE_SECONDS_PER_MB, PNG_MAX_PIXELS, JPEG_MAX_PIXELS } from '../src/lib/policy.ts';

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
  // The page the sender placed the field on (its size came back from the upload) is the page of the signed PDF, and
  // the signature sits inside the box that was drawn on it: 10% from the left, 85% down, 30% wide, 6% tall.
  assert.deepEqual(up.data.page_sizes[0], { w: d.page[2], h: d.page[3] });
  const sig = await drawn(signed, 1, (img) => img.width === 1 && img.height === 1);
  const [W, H] = [d.page[2], d.page[3]];
  assert.ok(sig.box.x0 >= 0.1 * W - 0.5 && sig.box.x1 <= 0.4 * W + 0.5, `signature across: ${sig.box.x0} to ${sig.box.x1}`);
  assert.ok(sig.box.y1 <= H * (1 - 0.85) + 0.5 && sig.box.y0 >= H * (1 - 0.91) - 0.5, `signature down: ${sig.box.y0} to ${sig.box.y1}`);
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

// ---- Staying signed in -------------------------------------------------------------------------------

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const DAY = 864e5;
const iso = (ms: number) => new Date(ms).toISOString();
// One call through the router with everything a browser sends, and the cookies it was sent back, attributes and all.
async function raw(c: Client, method: string, url: string, ua = IPHONE, body?: any) {
  const { handle } = await import('../src/server/router.ts');
  const res = await handle(new Request(`http://test.local/api${url}`, {
    method, headers: { cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': c.ip, 'user-agent': ua, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, data: await res.json(), set: res.headers.getSetCookie() };
}
// The test client sends no browser name, and a use is noted at most once an hour. This forgets the note that
// signing up left, so the next call is the one that is written down, as a real browser's first page load is.
const unnoted = (c: Client) => s.db.run('UPDATE sessions SET last_used_at=NULL, ua=NULL WHERE id=?', sha256(c.cookies.ts_session));
const sessionRow = (email: string) => s.db.get('SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email=? ORDER BY s.created_at DESC', email);
// Moves a session back in time, as if `days` had passed since it was last touched.
const age = (id: string, days: number) => {
  const r = s.db.get('SELECT * FROM sessions WHERE id=?', id);
  s.db.run('UPDATE sessions SET expires_at=?, last_used_at=?, created_at=? WHERE id=?', iso(Date.parse(r.expires_at) - days * DAY), r.last_used_at ? iso(Date.parse(r.last_used_at) - days * DAY) : null, iso(Date.parse(r.created_at) - days * DAY), id);
};

test('a browser that is used stays signed in until 30 days after it signed in, and one that is not used is signed out after 30 days', async () => {
  assert.equal(SESSION_DAYS, 30);
  const c = await signUp('Lea Weekly', 'lea@example.com', ip());
  unnoted(c);
  const first = await raw(c, 'GET', '/me');
  assert.equal(first.data.user.email, 'lea@example.com');
  const made = sessionRow('lea@example.com');
  assert.ok(made.created_at, 'when the browser signed in is kept');
  assert.equal(made.ua, IPHONE, 'what the browser called itself is kept');
  assert.ok(Date.parse(made.expires_at) - Date.now() > 29.9 * DAY);
  // Nothing is written and no cookie is sent again while the last note is under an hour old.
  assert.deepEqual(first.set.filter((x) => x.startsWith('ts_session=')), []);
  const again = await raw(c, 'GET', '/me');
  assert.deepEqual(again.set, []);
  assert.equal(sessionRow('lea@example.com').last_used_at, made.last_used_at);

  // She opens the app once a week. It stays signed in, but only until 30 days after she signed in, however often
  // she comes (SESSION_MAX_DAYS, the owner's decision after a copied cookie stayed alive for three years): from
  // then she signs in again. The end never moves past that, so no cookie is sent again on the way.
  for (let week = 1; week <= 4; week++) {
    age(made.id, 7);
    const r = await raw(c, 'GET', '/envelopes');
    assert.equal(r.status, 200, `week ${week}: ${JSON.stringify(r.data)}`);
    assert.equal(r.set.find((x) => x.startsWith('ts_session=')), undefined, `week ${week}: the end does not move`);
    const row = s.db.get('SELECT * FROM sessions WHERE id=?', made.id);
    assert.ok(Math.abs(Date.parse(row.expires_at) - (Date.parse(row.created_at) + 30 * DAY)) < 60_000, `week ${week}: still 30 days from signing in`);
    assert.ok(Date.now() - Date.parse(row.last_used_at) < 60_000);
  }
  age(made.id, 7);
  assert.equal((await raw(c, 'GET', '/envelopes')).status, 401, 'week five: 35 days after signing in, she signs in again');
  assert.equal(s.db.get('SELECT COUNT(*) n FROM sessions WHERE user_id=?', made.user_id).n, 1, 'one session, never a second one made behind her back');

  // A session that is not used is signed out the same way. (Back to a fresh sign-in for the rest of this test.)
  {
    const fresh = new Client();
    fresh.ip = c.ip;
    assert.equal((await fresh.post('/auth/login', { email: 'lea@example.com', password: 'correct horse battery' })).status, 200);
    c.cookies = fresh.cookies;
  }
  const made2 = sessionRow('lea@example.com');
  made.id = made2.id;
  made.user_id = made2.user_id;
  // Thirty-one days without a visit: signed out, and a late visit does not bring the session back.
  age(made.id, 31);
  const late = await raw(c, 'GET', '/envelopes');
  assert.equal(late.status, 401);
  assert.equal((await raw(c, 'GET', '/me')).data.user, null);
  assert.ok(Date.parse(s.db.get('SELECT expires_at t FROM sessions WHERE id=?', made.id).t) < Date.now());
  // Signing in again clears the row that ran out.
  const back = new Client();
  back.ip = c.ip;
  assert.equal((await back.post('/auth/login', { email: 'lea@example.com', password: 'correct horse battery' })).status, 200);
  assert.equal(s.db.get('SELECT COUNT(*) n FROM sessions WHERE id=?', made.id).n, 0);

  // Signing out sends the cookie away for good, also on a request that would have moved the end forward.
  const row = sessionRow('lea@example.com');
  await raw(back, 'GET', '/me');
  age(row.id, 5);
  const out = await raw(back, 'POST', '/auth/logout');
  assert.match(out.set.at(-1)!, /^ts_session=; .*Max-Age=0/);
  assert.equal(s.db.get('SELECT COUNT(*) n FROM sessions WHERE id=?', row.id).n, 0);
});

test('signing in on a new device does not sign the others out, and Settings shows each one', async () => {
  const phone = await signUp('Moe Mobile', 'moe@example.com', ip());
  unnoted(phone);
  await raw(phone, 'GET', '/me', IPHONE);
  const desk = new Client();
  desk.ip = ip();
  assert.equal((await raw(desk, 'POST', '/auth/login', WINDOWS, { email: 'moe@example.com', password: 'correct horse battery' })).status, 200);
  // raw() does not keep cookies, so sign in once more the ordinary way and use that browser from here on.
  assert.equal((await desk.post('/auth/login', { email: 'moe@example.com', password: 'correct horse battery' })).status, 200);
  await raw(desk, 'GET', '/me', WINDOWS);
  assert.equal((await raw(phone, 'GET', '/envelopes', IPHONE)).status, 200, 'the phone is still signed in');
  assert.equal((await raw(desk, 'GET', '/envelopes', WINDOWS)).status, 200);

  const list = (await raw(desk, 'GET', '/me/sessions', WINDOWS)).data;
  assert.equal(list.days, 30);
  assert.equal(list.noted_every_minutes, SESSION_TOUCH_MINUTES);
  // Three sessions: the phone, this browser, and the sign-in whose cookie was thrown away above (never used).
  assert.equal(list.sessions.length, 3);
  assert.deepEqual(list.sessions.map((x: any) => x.current), [true, false, false], 'this browser comes first');
  assert.deepEqual([list.sessions[0].device, list.sessions[0].browser], ['Windows computer', 'Chrome']);
  const onPhone = list.sessions.find((x: any) => x.device === 'iPhone');
  assert.equal(onPhone.browser, 'Safari');
  assert.ok(onPhone.signed_in_at && onPhone.last_used_at);
  const unused = list.sessions.find((x: any) => x.device === 'Unknown device');
  assert.equal(unused.last_used_at, null);
  // What names a session to the page is not the cookie and not the hash it is looked up by.
  const hashes: string[] = s.db.all('SELECT id FROM sessions').map((r: any) => r.id);
  for (const x of list.sessions) {
    assert.match(x.id, /^[0-9a-f]{16}$/);
    assert.ok(!hashes.some((h) => h.startsWith(x.id)) && !JSON.stringify(x).includes(desk.cookies.ts_session));
  }

  // One browser can be signed out by itself.
  const one = await desk.call('DELETE', `/me/sessions/${unused.id}`);
  assert.deepEqual(one.data, { ok: true, current: false });
  const gone = await desk.call('DELETE', `/me/sessions/${unused.id}`);
  assert.equal(gone.status, 404);
  assert.match(gone.data.error, /is not signed in any more, so there was nothing to sign out/);
  // Not somebody else's: a handle from another login finds nothing.
  const other = await signUp('Nan Other', 'nan@example.com', ip());
  const theirs = (await other.get('/me/sessions')).data.sessions[0].id;
  assert.equal((await desk.call('DELETE', `/me/sessions/${theirs}`)).status, 404);
  assert.equal((await other.get('/me')).data.user.email, 'nan@example.com');

  // "Sign out everywhere else" ends every other browser and keeps this one.
  const all = await desk.post('/me/sessions/sign-out-others');
  assert.deepEqual(all.data, { ok: true, signed_out: 1 });
  assert.equal((await raw(phone, 'GET', '/envelopes', IPHONE)).status, 401, 'the phone has to sign in again');
  assert.equal((await desk.get('/envelopes')).status, 200);
  assert.equal((await desk.get('/me/sessions')).data.sessions.length, 1);
  assert.deepEqual((await desk.post('/me/sessions/sign-out-others')).data, { ok: true, signed_out: 0 });
  // Signing this browser out through the list also takes its cookie away.
  const me = (await desk.get('/me/sessions')).data.sessions[0];
  const self = await raw(desk, 'DELETE', `/me/sessions/${me.id}`, WINDOWS);
  assert.equal(self.data.current, true);
  assert.match(self.set.at(-1)!, /^ts_session=; .*Max-Age=0/);
  assert.equal((await raw(desk, 'GET', '/me', WINDOWS)).data.user, null);

  // No API key sees or ends where a person is signed in.
  const owner = await signUp('Ona Owner', 'ona@example.com', ip());
  const key = (await owner.post('/api-keys', { name: 'Integration', scope: 'admin' })).data.key as string;
  const k = new Client();
  for (const [method, url] of [['GET', '/me/sessions'], ['POST', '/me/sessions/sign-out-others'], ['DELETE', '/me/sessions/abc']] as const) {
    const r = await k.call(method, url, method === 'GET' ? undefined : {}, { authorization: `Bearer ${key}` });
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.match(r.data.error, /An API key cannot see or end where a person is signed in\. That needs a person signed in to the app\./);
  }
  assert.equal((await owner.get('/me/sessions')).data.sessions.length, 1);
});

test('the device and browser shown are what the browser said, and nothing is guessed', () => {
  const cases: [string, string, string][] = [
    [IPHONE, 'iPhone', 'Safari'],
    [WINDOWS, 'Windows computer', 'Chrome'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'Android phone', 'Chrome'],
    ['Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Android tablet', 'Chrome'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 'Android phone', 'Samsung Internet'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1', 'iPhone', 'Chrome'],
    ['Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15', 'iPad', 'Firefox'],
    // Safari on an iPad says it is a Mac. We cannot tell them apart, so we say so.
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Mac or iPad', 'Safari'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Mac', 'Chrome'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Windows computer', 'Edge'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Linux computer', 'Firefox'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chromebook', 'Chrome'],
    ['curl/8.5.0', 'Unknown device', 'unknown browser'],
    ['', 'Unknown device', 'unknown browser'],
  ];
  for (const [ua, device, browser] of cases) assert.deepEqual(deviceName(ua), { device, browser }, ua);
  assert.deepEqual(deviceName(null), { device: 'Unknown device', browser: 'unknown browser' });
  // Settings shows the list with the button, under Profile.
  const page = read('src/app/app/settings/SignedIn.tsx');
  assert.match(page, /Where you are signed in/);
  assert.match(page, /Sign out everywhere else/);
  assert.match(read('src/app/app/settings/page.tsx'), /<SignedIn \/>/);
});

// ---- The switch after sending ------------------------------------------------------------------------

const twoSigners = (c: Client, tag: string) => simple(c, `${tag}1@example.com`, {
  recipients: [{ id: 'r', role: 'signer', name: 'First Signer', email: `${tag}1@example.com` }, { id: 'r2', role: 'signer', name: 'Second Signer', email: `${tag}2@example.com` }],
  fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'f2', document_id: 'd', recipient_id: 'r2', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }],
  send: true,
});

test('the switch on the page after sending turns on one email per signature, and only that', async () => {
  const c = await signUp('Pia Waiting', 'pia@example.com', ip());
  const subjects = () => mailTo('pia@example.com').map((m: any) => m.subject as string);
  // As it comes: nothing until the end.
  const quiet = await twoSigners(c, 'quiet');
  assert.equal((await signAll(quiet.id, 'quiet1@example.com')).status, 200);
  assert.deepEqual(subjects().filter((x) => /^Signed:/.test(x)), []);
  assert.equal((await signAll(quiet.id, 'quiet2@example.com')).status, 200);
  assert.equal(subjects().filter((x) => /^Completed:/.test(x)).length, 1);

  // The switch sends exactly this, and the other choices stay as they were.
  const before = (await c.get('/me')).data.user.notify;
  assert.deepEqual(before, { viewed: false, signed: false, completed: true, problems: true });
  const flipped = await c.call('PATCH', '/me', { notify: { signed: true } });
  assert.deepEqual(flipped.data.user.notify, { ...before, signed: true });
  const loud = await twoSigners(c, 'loud');
  assert.equal((await signAll(loud.id, 'loud1@example.com')).status, 200);
  assert.equal(subjects().filter((x) => /^Signed:/.test(x)).length, 1, 'one email when the first of two has signed');
  assert.equal(subjects().filter((x) => /^Opened:/.test(x)).length, 0, 'the email for each opening stays off');
  assert.equal((await signAll(loud.id, 'loud2@example.com')).status, 200);
  // The last signature is the completion email, not one more "Signed".
  assert.equal(subjects().filter((x) => /^Signed:/.test(x)).length, 1);
  assert.equal(subjects().filter((x) => /^Completed:/.test(x)).length, 2);
  // And off again.
  assert.equal((await c.call('PATCH', '/me', { notify: { signed: false } })).data.user.notify.signed, false);

  // The page: the editor sends the sender to ?sent=1, the envelope page draws the card there, and the switch on
  // it sets this preference and no other.
  assert.match(read('src/components/Editor.tsx'), /leave\(`\/app\/envelopes\/\$\{id\}\?sent=1`\)/);
  assert.match(read('src/app/app/envelopes/[id]/page.tsx'), /\{out && <AfterSend envelope=\{e\} \/>\}/);
  const card = read('src/components/sender/AfterSend.tsx');
  assert.match(card, /q\.get\('sent'\) !== '1'/);
  assert.match(card, /api\('\/me', \{ method: 'PATCH', body: \{ notify: \{ signed: next \} \} \}\)/);
  assert.match(card, /role="switch"/);
  assert.match(card, /Email me each time someone signs/);
});

// ---- Signing in person: the host's account is not left open ------------------------------------------

async function inPerson(c: Client, hostEmail: string, tag: string) {
  const e = await simple(c, hostEmail, {
    recipients: [{ id: 'r', role: 'inperson', name: 'Pat Present', email: `${tag}-pat@example.com` }, { id: 'r2', role: 'inperson', name: 'Quin Present', email: `${tag}-quin@example.com` }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'f2', document_id: 'd', recipient_id: 'r2', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }],
    send: true,
  });
  const tokens: string[] = s.db.all('SELECT token FROM recipients WHERE envelope_id=? ORDER BY position', e.id).map((r: any) => r.token);
  return { e, pat: tokens[0], quin: tokens[1] };
}
const PASSWORD = 'correct horse battery';

test('hosting an in-person signing locks the host\'s account in that browser until the host types their password', async () => {
  const host = await signUp('Rae Host', 'rae@example.com', ip());
  const other = new Client(); // the host's laptop at home, signed in to the same login
  other.ip = ip();
  assert.equal((await other.post('/auth/login', { email: 'rae@example.com', password: PASSWORD })).status, 200);
  const { e, pat } = await inPerson(host, 'rae@example.com', 'rae');
  assert.equal((await host.get(`/envelopes/${e.id}`)).status, 200);

  // The host taps "Host signing now": the signing page opens in the host's browser.
  const opened = await host.get(`/sign/${pat}`);
  assert.equal(opened.status, 200);
  assert.equal(opened.data.recipient.role, 'inperson');
  assert.equal(opened.data.envelope.sender.name, 'Rae Host');
  assert.equal(opened.data.envelope.id, e.id, 'the done screen can lead back to this envelope');

  // From here the browser opens nothing of the account. Every call that needs signing in says why.
  for (const [method, url] of [['GET', '/envelopes'], ['GET', `/envelopes/${e.id}`], ['GET', '/contacts'], ['GET', `/files/${e.documents[0].file_id}/content`], ['PATCH', '/me'], ['GET', '/me/sessions'], ['POST', '/me/sessions/sign-out-others'], ['GET', '/export']] as const) {
    const r = await host.call(method, url, method === 'GET' ? undefined : {});
    assert.equal(r.status, 401, `${method} ${url}`);
    assert.equal(r.data.code, 'handed_over');
    assert.match(r.data.error, /handed to someone to sign in person, so your account is locked in this browser\. Open Sign&Grow here and type your password to come back\./);
  }
  // The app is told what to show: not the sign-in page, the screen that asks for the owner's password.
  const me = (await host.get('/me')).data;
  assert.equal(me.user, null);
  assert.deepEqual(me.handed_over, { name: 'Rae Host', has_password: true, signer: 'Pat Present', envelope_id: e.id, tries_left: HAND_OVER_TRIES });
  assert.equal(JSON.stringify(me).includes('rae@example.com'), false, 'nothing more than the name');

  // The signer signs: the link needs no account, locked or not.
  assert.equal((await host.post(`/sign/${pat}/consent`)).status, 200);
  const view = (await host.get(`/sign/${pat}`)).data;
  assert.equal((await host.post(`/sign/${pat}/complete`, { values: { [view.fields[0].id]: '1' }, signature_png: PNG, initials_png: PNG })).status, 200);
  assert.equal((await host.get(`/sign/${pat}`)).data.recipient.status, 'completed');
  assert.equal((await host.get('/envelopes')).status, 401, 'still locked after the signer has finished');

  // Nothing was signed out anywhere else, and the other browser sees which one is locked.
  assert.equal((await other.get('/envelopes')).status, 200);
  const listed = (await other.get('/me/sessions')).data.sessions;
  assert.deepEqual(listed.map((x: any) => [x.current, x.handed_over]).sort(), [[false, true], [true, false]]);

  // "I am Rae Host": a wrong password leaves it locked and says how many tries are left.
  const wrong = await host.post('/auth/unlock', { password: 'not the password' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.code, 'wrong_password');
  assert.match(wrong.data.error, /That password is not right, so the account stays locked on this device\. 4 more tries, then this browser is signed out\./);
  assert.equal((await host.get('/envelopes')).status, 401);
  assert.equal((await host.post('/auth/unlock', {})).status, 400);
  assert.equal((await host.get('/me')).data.handed_over.tries_left, HAND_OVER_TRIES - 1, 'an empty box is not a guess');
  // The right one takes the lock off, in the same session, and says where to go back to.
  const cookieBefore = host.cookies.ts_session;
  const back = await host.post('/auth/unlock', { password: PASSWORD });
  assert.deepEqual(back.data, { ok: true, envelope_id: e.id });
  assert.equal(host.cookies.ts_session, cookieBefore);
  assert.equal((await host.get('/me')).data.user.email, 'rae@example.com');
  assert.equal((await host.get(`/envelopes/${e.id}`)).status, 200);
  assert.equal((await host.post('/auth/unlock', { password: PASSWORD })).data.code, 'not_locked');
  // Looking at the page of the signer who has finished does not lock the browser again.
  await host.get(`/sign/${pat}`);
  assert.equal((await host.get('/envelopes')).status, 200);
});

test('five wrong passwords on a handed-over device sign that browser out, and a login without a password is told what to do', async () => {
  const host = await signUp('Sol Host', 'sol@example.com', ip());
  const { quin } = await inPerson(host, 'sol@example.com', 'sol');
  await host.get(`/sign/${quin}`);
  const sid = sha256(host.cookies.ts_session);
  for (let i = 1; i < HAND_OVER_TRIES; i++) assert.equal((await host.post('/auth/unlock', { password: `guess ${i}` })).data.code, 'wrong_password');
  const last = await raw(host, 'POST', '/auth/unlock', IPHONE, { password: 'guess 5' });
  assert.equal(last.status, 401);
  assert.equal(last.data.code, 'signed_out');
  assert.match(last.data.error, /That was 5 wrong passwords, so this browser has been signed out\. Sign in again from the sign-in page\. Nothing in the account was changed\./);
  assert.match(last.set.at(-1)!, /^ts_session=; .*Max-Age=0/);
  assert.equal(s.db.get('SELECT COUNT(*) n FROM sessions WHERE id=?', sid).n, 0);
  // Even the right password does nothing now: the session is gone, and the sign-in page is the way back.
  assert.equal((await host.post('/auth/unlock', { password: PASSWORD })).data.code, 'not_locked');
  assert.equal((await host.get('/me')).data.handed_over, undefined);
  const again = new Client();
  again.ip = host.ip;
  assert.equal((await again.post('/auth/login', { email: 'sol@example.com', password: PASSWORD })).status, 200);

  // Someone who signs in with Google or Microsoft has no password to type. The lock screen is told, and so are they.
  await again.get(`/sign/${quin}`);
  s.db.run("UPDATE users SET password_hash='!' WHERE email='sol@example.com'");
  assert.equal((await again.get('/me')).data.handed_over.has_password, false);
  const none = await again.post('/auth/unlock', { password: PASSWORD });
  assert.equal(none.status, 400);
  assert.equal(none.data.code, 'no_password');
  assert.match(none.data.error, /This login has no password, because you sign in with Google or Microsoft\. Sign in again that way/);
});

test('only the host\'s own browser is locked, and only by a signing page that someone still has to sign in person', async () => {
  // An ordinary signer who has an account of their own, opening their link while signed in: left alone.
  const sender = await signUp('Tia Sender', 'tia@example.com', ip());
  const signer = await signUp('Uma Signer', 'uma@example.com', ip());
  const plain = await simple(sender, 'uma@example.com', { send: true });
  const link = s.db.get('SELECT token FROM recipients WHERE envelope_id=?', plain.id).token;
  assert.equal((await signer.get(`/sign/${link}`)).status, 200);
  assert.equal((await signer.get('/envelopes')).status, 200);
  // The sender signing their own document ("Sign now") is not in person either.
  const own = await simple(sender, 'tia@example.com', { send: true });
  await sender.get(`/sign/${s.db.get('SELECT token FROM recipients WHERE envelope_id=?', own.id).token}`);
  assert.equal((await sender.get('/envelopes')).status, 200);

  // An in-person link opened in a browser that is signed in to somebody else's account: that account is not the host's.
  const { e, pat, quin } = await inPerson(sender, 'tia@example.com', 'tia');
  await signer.get(`/sign/${pat}`);
  assert.equal((await signer.get('/envelopes')).status, 200);
  // A colleague on the host's team who hosts the signing is locked like the host.
  const invite = await sender.post('/account/invites', { email: 'vic@example.com', role: 'admin' });
  assert.equal(invite.status, 200, JSON.stringify(invite.data));
  const mate = new Client();
  mate.ip = ip();
  const joined = await mate.post('/auth/signup', { name: 'Vic Mate', email: 'vic@example.com', password: PASSWORD, invite: s.db.get("SELECT token FROM invites WHERE email='vic@example.com'").token });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  await mate.get(`/sign/${pat}`);
  assert.equal((await mate.get('/envelopes')).data.code, 'handed_over');
  assert.equal((await mate.get('/me')).data.handed_over.name, 'Vic Mate');
  assert.equal((await sender.get('/envelopes')).status, 200, 'the sender, on another device, is not');

  // A voided envelope has nobody left to sign in person: opening the old link locks nothing.
  assert.equal((await sender.post(`/envelopes/${e.id}/void`, { reason: 'Signed on paper instead' })).status, 200);
  await sender.get(`/sign/${quin}`);
  assert.equal((await sender.get('/envelopes')).status, 200);
  // A locked browser is not noted as used, so one that is never unlocked runs out like any other.
  const row = s.db.get('SELECT * FROM sessions WHERE id=?', sha256(mate.cookies.ts_session));
  s.db.run('UPDATE sessions SET last_used_at=?, expires_at=? WHERE id=?', iso(Date.now() - 5 * DAY), iso(Date.now() + 2 * DAY), row.id);
  const r = await raw(mate, 'GET', '/me');
  assert.deepEqual(r.set, []);
  assert.ok(Date.parse(s.db.get('SELECT expires_at t FROM sessions WHERE id=?', row.id).t) < Date.now() + 3 * DAY);
});

test('the screens of in-person signing say to hand the device back and what the lock does not cover', () => {
  // The done screen of the signing page, for the in-person role only, starts with the hand-back card.
  const signPage = read('src/app/sign/[token]/page.tsx');
  assert.match(signPage, /\{inPerson && <HandBack signer=\{me\.name\} sender=\{sender\.name\} envelopeId=\{env\.id\} \/>\}/);
  const card = read('src/components/HandBack.tsx');
  assert.match(card, /Thank you, \{signer\}\. Please hand this device back to \{sender\}\./);
  assert.match(card, /I am \{sender\}/);
  assert.match(card, /href=\{`\/app\/envelopes\/\$\{encodeURIComponent\(envelopeId\)\}`\}/);
  // The signing page has no way into the account of its own: no link to the app besides that button.
  assert.equal(/href=["'{`]+\/app/.test(signPage), false);
  // The app draws the lock screen in place of every page, puts the account away before leaving for the signing
  // page, and looks again when a tab comes back to the front.
  const shell = read('src/components/AppShell.tsx');
  assert.match(shell, /if \(m\.handed_over\) return setLocked\(m\.handed_over\);/);
  assert.match(shell, /if \(locked\) return <HandedOver info=\{locked\} onUnlocked=\{reload\} \/>;\s+if \(!me\)/);
  assert.match(shell, /addEventListener\('sg-handed-over', handed\)/);
  assert.match(shell, /addEventListener\('visibilitychange', look\)/);
  assert.match(read('src/components/sender/Recipients.tsx'), /if \(r\.role === 'inperson'\) window\.dispatchEvent\(new CustomEvent\('sg-handed-over'/);
  const lock = read('src/components/HandedOver.tsx');
  assert.match(lock, /This device was handed to \{info\.signer \|\| 'someone'\} to sign/);
  assert.match(lock, /autoComplete="one-time-code"/);
  // What the lock does not cover is said in the same words wherever in-person signing is offered.
  assert.equal(IN_PERSON_LIMITS.length, 4);
  assert.match(IN_PERSON_LIMITS.join(' '), /your email .*password reset.*saved and offers to fill in.*Google or Microsoft.*another tab/s);
  assert.match(IN_PERSON_LOCK, /locks your account in that browser\. To come back you type your password, or sign in again if your login has none\./);
  for (const file of ['src/components/HandedOver.tsx', 'src/app/security/page.tsx']) assert.match(read(file), /IN_PERSON_LIMITS\.map/, file);
  for (const file of ['src/components/sender/Recipients.tsx', 'src/app/security/page.tsx']) assert.match(read(file), /\{IN_PERSON_LOCK\}/, file);
});

// ---- Fields a thumb can hold in the editor -------------------------------------------------------------

// The rules a touch screen gets in the editor, read from the stylesheet the page loads. The sizes are worked out
// the way the browser does: every box is border-box (globals.css), so a child that is placed absolutely is measured
// from inside its parent's border.
test('in the editor on a touch screen every field and its resize corner answer a thumb over at least 44 px', () => {
  const css = read('src/app/styles/editor.css');
  const base = read('src/app/globals.css');
  assert.match(base, /\* \{ box-sizing: border-box; \}/);
  const at = css.indexOf('@media (pointer: coarse) {\n  .field.edit .grip');
  assert.ok(at > 0, 'the touch rules for fields are in editor.css');
  const block = css.slice(at, css.indexOf('\n}\n', at));
  const rule = (sel: string) => {
    const body = new RegExp(`\\n  ${sel.replace(/[.:()]/g, '\\$&')} \\{([^}]*)\\}`).exec(block)?.[1];
    assert.ok(body, `${sel} under (pointer: coarse)`);
    return body!;
  };
  const px = (body: string, prop: string) => Number(new RegExp(`(?:^|[ ;])${prop}: (-?\\d+)px`).exec(body)?.[1]);
  const border = Number(/\.field \.grip \{[^}]*border: (\d+)px/.exec(base)?.[1]);
  const grip = rule('.field.edit .grip');
  const [w, h] = [px(grip, 'width'), px(grip, 'height')];
  const inset = /inset: (-?\d+)px (-?\d+)px (-?\d+)px (-?\d+)px/.exec(rule('.field.edit .grip::after'))!.slice(1).map(Number);
  const [top, right, bottom, left] = inset;
  // Across: from the area's left edge to its right edge. Down: the same from top to bottom.
  assert.ok(w - 2 * border - left - right >= 44, `the resize corner is ${w - 2 * border - left - right} px across`);
  assert.ok(h - 2 * border - top - bottom >= 44, `the resize corner is ${h - 2 * border - top - bottom} px down`);
  // It starts at the dot's own outer edge, so pressing the dot itself is inside it, and grows away from the field.
  assert.deepEqual([top, left], [-border, -border]);
  assert.ok(right < 0 && bottom < 0);
  // Every field, however small (a tick box is about 9 px at phone width), has an area of 44 px around its middle.
  const field = rule('.field.edit::before');
  assert.match(field, /width: max\(100%, 44px\); height: max\(100%, 44px\); transform: translate\(-50%, -50%\)/);
  assert.match(field, /z-index: -1/);
  assert.match(rule('.field.edit'), /overflow: visible/);
  // Only on a touch screen: with a mouse, a click next to a small field places a new field there, as before.
  assert.equal(css.slice(0, at).includes('.field.edit::before'), false);
  // Every button of the editor on a phone is at least 44 px tall (it was 40), and the later rule wins over earlier ones.
  const phone = css.slice(css.indexOf('@media (max-width: 900px) {\n  .ed-only-sm'));
  assert.match(phone, /\n  \.ed \.btn, \.ed \.palette button, \.ed \.steps button \{ min-height: 44px; \}/);
  assert.match(phone, /\n  \.ed \.btn\.sm \{ min-width: 44px; \}/);
});

// ---- Fields without a label, before sending ------------------------------------------------------------

test('fields a screen reader can only call by their type are listed before sending, with a way to each', async () => {
  const f = (type: string, more: Record<string, any> = {}) => ({ id: type, type, label: '', readonly: false, ...more });
  const all = ['text', 'number', 'date', 'dropdown', 'attachment', 'checkbox', 'radio', 'signature', 'initials', 'full_name', 'email', 'company', 'title', 'date_signed'].map((t) => f(t));
  // The ones whose type does not say what belongs in them. A signature, a name, an email address, a company and a
  // job title explain themselves.
  assert.deepEqual(unlabelled(all).map((x) => x.type), ['text', 'number', 'date', 'dropdown', 'attachment', 'checkbox', 'radio']);
  // A label of spaces is no label. A label, a note or a strike-out of the sender, or a read-only prefilled value is not listed.
  assert.deepEqual(unlabelled([f('text', { label: '   ' }), f('text', { label: 'Seedlings pledged' }), f('note', { readonly: true, value: 'Note' }), f('strike', { readonly: true }), f('text', { readonly: true, value: 'Mangrove Trust' })]).map((x) => x.label), ['   ']);
  // What the list says a signer hears is what the signing page says for a field with no label.
  const { LABEL } = await import('../src/components/sign/fields.ts');
  for (const t of Object.keys(HEARD_AS)) if (t !== 'radio') assert.equal(HEARD_AS[t], LABEL[t], t);
  const signPage = read('src/app/sign/[token]/page.tsx');
  assert.match(signPage, /const name = fieldName\(f\);/);
  assert.match(signPage, /aria-label=\{f\.label \|\| `Option \$\{group\.indexOf\(f\) \+ 1\} of \$\{group\.length\}`\}/);
  // A field that is not required is read out as optional, and the example in the list says so too.
  assert.match(signPage, /const need = f\.required \? ', required' : ', optional';/);
  assert.match(read('src/components/editor/LabelCheck.tsx'), /list\[0\]\.type === 'radio' \? '' : list\[0\]\.required \? ', required' : ', optional'/);

  // The review step shows the list unless the envelope is closed, and only fields that can still be changed.
  assert.match(read('src/components/editor/StepReview.tsx'), /\{!closed && <LabelCheck ed=\{ed\} \/>\}/);
  const check = read('src/components/editor/LabelCheck.tsx');
  assert.match(check, /unlabelled\(ed\.fields\.value\)\.filter\(\(f\) => !ed\.isLockedField\(f\)\)/);
  assert.match(check, /Someone who signs with a screen reader cannot see where a field sits on the page\. They hear its label\./);
  assert.match(check, /You can send without, but then tell that signer yourself what each field is for\./);
  // Each one has a button that says which field it opens, and opens it in step 2 with the cursor in the Label box.
  assert.match(check, /onClick=\{\(\) => ed\.showField\(f\.id\)\} aria-label=\{`Add a label to the \$\{where\(f\)\}`\}/);
  assert.match(read('src/components/Editor.tsx'), /showField: \(fid\) => \(setJump\(fid\), void go\(2\)\), jump, clearJump: \(\) => setJump\(null\)/);
  const fieldsStep = read('src/components/editor/StepFields.tsx');
  assert.match(fieldsStep, /const id = ed\.jump;[\s\S]{0,120}setSel\(id\);\s+setSheet\(true\);[\s\S]{0,900}document\.getElementById\('ed-label'\)\?\.focus/);
  assert.match(fieldsStep, /<input id="ed-label" /);
  // On a phone the settings sheet covers the lower half, and the field is moved above it, not left under it.
  assert.match(fieldsStep, /el\?\.scrollIntoView\(\{ block: 'center', inline: 'nearest' \}\);\s+\/\/[^\n]*\n\s+const panel = document\.querySelector\('\.ed-settings\.has'\);[\s\S]{0,260}window\.scrollBy\(\{ top: r\.bottom - top \+ 24 \}\);/);
  // The rows have room for a thumb.
  assert.match(read('src/app/styles/editor.css'), /\.ed-nolabel \.btn \{ min-height: 44px; \}/);
});

// ---- Documents that are slow on a phone -----------------------------------------------------------------

test('a document large enough to be slow on a phone is pointed out with the time it took, and the upload hint says what is true', async () => {
  assert.equal(PHONE_SLOW_BYTES, 5_000_000);
  // Nothing to say about a file under the line, or one whose size is not known.
  for (const d of [{ size: PHONE_SLOW_BYTES - 1 }, { size: 0 }, { size: null }, {}]) assert.equal(phoneWeight(d), '', JSON.stringify(d));
  // The wait is the measured rate times the size, in seconds, and in minutes from a minute and a half.
  assert.equal(phoneWait(5_000_000), `about ${Math.round(5 * PHONE_SECONDS_PER_MB)} seconds`);
  assert.equal(phoneWait(25_000_000), `about ${Math.round((25 * PHONE_SECONDS_PER_MB) / 60)} minutes`);
  const said = phoneWeight({ size: 12_340_000 });
  assert.equal(said, `This file is 12.3 MB. Every signer's phone downloads all of it, which takes ${phoneWait(12_340_000)} on a slow mobile connection and longer where the signal is weak. If people will sign on a phone, save it with smaller pictures (many PDF programs have "reduce file size") or split it into parts. Under 5 MB is best.`);
  // It says what the sender can do, never that the document will not open or must be changed.
  assert.doesNotMatch(said, /will not open|cannot be opened|must|\u2014/);

  // The size it needs comes from the server: with the upload, and with the envelope when a draft is opened again.
  const c = await signUp('Wren Weighty', 'wren@example.com', ip());
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]).drawText('A scanned lease, heavy as scans are', { x: 60, y: 780 });
  await doc.attach(crypto.randomBytes(6_000_000), 'scan.bin', { mimeType: 'application/octet-stream' });
  const heavy = await uploadFiles(c, [{ bytes: await doc.save(), name: 'Lease.pdf', type: 'application/pdf' }]);
  assert.equal(heavy.status, 200, JSON.stringify(heavy.data));
  assert.ok(heavy.data.size >= PHONE_SLOW_BYTES, `stored ${heavy.data.size} bytes`);
  assert.equal(heavy.data.size, (await content(c, heavy.data.id)).length);
  assert.match(phoneWeight(heavy.data), /^This file is 6\.\d MB\./);
  const light = await upload(c, 3);
  assert.equal(phoneWeight(light), '');
  const made = await c.post('/envelopes', { subject: 'Lease', documents: [{ id: 'a', file_id: heavy.data.id }, { id: 'b', file_id: light.id }], recipients: [] });
  const again = (await c.get(`/envelopes/${made.data.envelope.id}`)).data;
  const docs = (again.envelope || again).documents;
  assert.deepEqual(docs.map((d: any) => !!phoneWeight(d)), [true, false]);

  // The editor says it under the document in step 1 and again before sending, and the hint under the upload box
  // gives the same measured rate next to the limits of the server.
  assert.match(read('src/components/editor/StepAdd.tsx'), /\{phoneWeight\(d\) && <p className="notice warn small" style=\{\{ margin: '6px 0 0' \}\}>\{phoneWeight\(d\)\}<\/p>\}/);
  assert.match(read('src/components/editor/StepReview.tsx'), /\{!closed && docs\.filter\(\(d\) => phoneWeight\(d\)\)\.map\(/);
  const { LIMITS } = await import('../src/components/editor/upload.ts');
  assert.equal(LIMITS, `PDF, PNG or JPEG. Up to 25 MB and 500 pages each. A signer on a phone waits about ${Math.round(PHONE_SECONDS_PER_MB)} seconds for each MB on a slow connection.`);
  // On a touch screen the box does not say "drop" or "click": a phone can do neither.
  const add = read('src/components/editor/StepAdd.tsx');
  assert.match(add, /<span className="ed-fine">Drop files here or click to choose them<\/span><span className="ed-touch">Tap to choose files or take a photo<\/span>/);
  assert.match(read('src/app/styles/editor.css'), /@media \(pointer: coarse\) \{ \.ed-fine \{ display: none; \} \.ed-touch \{ display: revert; \} \}/);
  // The API says the same about the size it returns.
  assert.match(read('src/server/openapi.ts'), /size: \{ type: 'integer', description: `Bytes of the stored PDF\. Every signer downloads all of it\. From \$\{PHONE_SLOW_BYTES \/ 1e6\} MB the app's editor tells the sender that it is slow to open on a phone\.` \}/);
});

// ---- A picture that claims to be enormous ---------------------------------------------------------------

// A PNG header that claims w by h pixels: the signature and an IHDR chunk, followed by a little data that is never
// unpacked because the claim is refused first.
const pngClaiming = (w: number, h: number) => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ihdr, Buffer.alloc(300_000)]);
};
// The real JPEG with its frame header changed to claim w by h pixels.
const jpegClaiming = (w: number, h: number) => {
  const b = Buffer.from(BASE);
  const sof = b.indexOf(Buffer.from([0xff, 0xc0]));
  b.writeUInt16BE(h, sof + 5);
  b.writeUInt16BE(w, sof + 7);
  return b;
};

test('a picture that claims more pixels than a page could use is refused in words before it costs the server memory', async () => {
  assert.equal(PNG_MAX_PIXELS, 25_000_000);
  assert.equal(JPEG_MAX_PIXELS, 50_000_000);
  // The header is read as it is written: the real JPEG says 48 by 32, a PNG says what its IHDR says.
  assert.deepEqual(pictureSize(BASE, false), { w: 48, h: 32 });
  assert.deepEqual(pictureSize(photo(6, true), false), { w: 48, h: 32 }, 'past the camera note');
  assert.deepEqual(pictureSize(Buffer.from(PNG.split(',')[1], 'base64'), true), { w: 1, h: 1 });
  assert.deepEqual(pictureSize(pngClaiming(5000, 5000), true), { w: 5000, h: 5000 });
  for (const bad of [new Uint8Array(0), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('not a picture at all, just words')]) {
    assert.equal(pictureSize(bad, false), null);
    assert.equal(pictureSize(bad, true), null);
  }
  for (let cut = 0; cut < BASE.length; cut += 7) assert.doesNotThrow(() => pictureSize(BASE.subarray(0, cut), false));
  // Up to the limit is fine, one pixel more is not.
  assert.equal(pictureLimit(pngClaiming(5000, 5000), true), '');
  assert.equal(pictureLimit(pngClaiming(5000, 5001), true), 'This picture is 5,000 by 5,001 pixels, which is 25 million. A PNG can have up to 25 million, far more than a page needs. Make it smaller or save it as a JPEG, then upload it again.');
  assert.equal(pictureLimit(jpegClaiming(8160, 6120), false), '', 'a 50 megapixel phone photo');
  assert.match(pictureLimit(jpegClaiming(16320, 12240), false), /^This picture is 16,320 by 12,240 pixels, which is 200 million\. A JPEG can have up to 50 million, far more than a page needs\. Make it smaller, then upload it again\.$/);

  // Through the upload: refused at once with that sentence, and nothing kept.
  const c = await signUp('Zed Bomb', 'zed@example.com', ip());
  const before = s.db.get('SELECT COUNT(*) n FROM files').n;
  const t = Date.now();
  const one = await uploadFiles(c, [{ bytes: pngClaiming(30000, 30000), name: 'tiny.png', type: 'image/png' }]);
  assert.equal(one.status, 400);
  assert.match(one.data.error, /^This picture is 30,000 by 30,000 pixels, which is 900 million\. A PNG can have up to 25 million/);
  assert.ok(Date.now() - t < 3000, 'refused before anything was unpacked');
  // Among several pictures it is named, so the sender knows which one to leave out.
  const many = await uploadFiles(c, [{ bytes: photo(1), name: 'page 1.jpg' }, { bytes: jpegClaiming(20000, 20000), name: 'page 2.jpg' }]);
  assert.equal(many.status, 400);
  assert.match(many.data.error, /^"page 2\.jpg" is 20,000 by 20,000 pixels, .* No document was made\.$/);
  assert.equal(s.db.get('SELECT COUNT(*) n FROM files').n, before);
  // Each picture is packed into the PDF before the next one is read, so its unpacked pixels are let go at once.
  assert.match(read('src/server/pdf.ts'), /drawObject\(page\.node\.newXObject\('Image', img\.ref\)\), popGraphicsState\(\)\);\n\s+\/\/[^\n]*\n\s+await img\.embed\(\);/);
  // The API description and the developers page give both limits.
  assert.match(read('src/server/openapi.ts'), /A PNG can have up to \$\{PNG_MAX_PIXELS \/ 1e6\} million pixels and a JPEG up to \$\{JPEG_MAX_PIXELS \/ 1e6\} million/);
  assert.match(read('src/app/developers/page.tsx'), /A PNG can have up to \$\{PNG_MAX_PIXELS \/ 1e6\} million pixels and a JPEG up to \$\{JPEG_MAX_PIXELS \/ 1e6\} million\./);
});
