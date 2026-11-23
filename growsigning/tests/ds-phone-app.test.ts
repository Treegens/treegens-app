// GrowSigning on a phone's home screen (research/docusign-gaps.json, batch "phone-app"): the manifest, the service
// worker that never keeps a page with a token, the share target for a signed-in person only, cleaner scans, and the
// photo a page was cleaned from kept with the document and in the evidence pack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { boot, signUp, Client, samplePdf, simple, tokenFor } from './helpers.ts';

const root = path.resolve(import.meta.dirname, '..');
const OUT = path.join(root, 'tests/out/build-ds-phone-app');
fs.mkdirSync(OUT, { recursive: true });
const S = await boot();
const { webManifest } = await import('../src/lib/site.ts');
const lib = await import('../src/lib/phoneapp.ts');
const scan = await import('../src/components/editor/scan.ts');

// ---- A small PNG writer and sample photos --------------------------------------------------------------------------

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(p: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }): Buffer {
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(p.width, 0); ihdr.writeUInt32BE(p.height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((p.width * 4 + 1) * p.height);
  for (let y = 0; y < p.height; y++) { raw[y * (p.width * 4 + 1)] = 0; Buffer.from(p.data.buffer, p.data.byteOffset + y * p.width * 4, p.width * 4).copy(raw, y * (p.width * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

type Pt = { x: number; y: number };
// A seeded random, so the samples are the same every run.
const rnd = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
/** Where the text lines of a sample page are, in parts of the page (u across, v down). */
const LINES = Array.from({ length: 18 }, (_, i) => ({ v: 0.12 + i * 0.042, end: 0.55 + ((i * 37) % 35) / 100 }));
const inkAt = (u: number, v: number) => u > 0.1 && LINES.some((l) => Math.abs(v - l.v) < 0.006 && u < l.end && Math.floor(u * 40) % 7 !== 0);

/** A photo of a page on a table: the page's corners, the table's colour, and a shadow from one side. */
function photo(o: { w: number; h: number; corners: Pt[]; table: [number, number, number]; shadow?: boolean; seed?: number }) {
  const r = rnd(o.seed ?? 7);
  const data = new Uint8ClampedArray(o.w * o.h * 4);
  for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) {
    const i = (y * o.w + x) * 4, n = (r() - 0.5) * 30, grain = Math.sin(x / 9 + Math.sin(y / 40) * 3) * 10;
    data[i] = o.table[0] + n + grain; data[i + 1] = o.table[1] + n + grain; data[i + 2] = o.table[2] + n; data[i + 3] = 255;
  }
  const [p0, p1, p2, p3] = o.corners;
  // A flat page seen by a camera: the unit square taken onto the four corners in perspective (Heckbert's mapping).
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1, g = (dx3 * dy2 - dx2 * dy3) / den, hh = (dx1 * dy3 - dx3 * dy1) / den;
  const at = (u: number, v: number) => {
    const z = g * u + hh * v + 1;
    return { x: ((p1.x - p0.x + g * p1.x) * u + (p3.x - p0.x + hh * p3.x) * v + p0.x) / z, y: ((p1.y - p0.y + g * p1.y) * u + (p3.y - p0.y + hh * p3.y) * v + p0.y) / z };
  };
  const steps = Math.max(o.w, o.h) * 2;
  for (let a = 0; a < steps; a++) for (let b = 0; b < steps; b++) {
    const u = a / steps, v = b / steps, q = at(u, v);
    const x = Math.round(q.x), y = Math.round(q.y);
    if (x < 0 || y < 0 || x >= o.w || y >= o.h) continue;
    const i = (y * o.w + x) * 4;
    const light = o.shadow ? 0.62 + 0.38 * u : 0.95;
    const ink = inkAt(u, v);
    data[i] = (ink ? 60 : 238) * light; data[i + 1] = (ink ? 60 : 234) * light; data[i + 2] = (ink ? 85 : 224) * light;
  }
  return { width: o.w, height: o.h, data };
}

const SAMPLES = {
  tilted: { w: 900, h: 1200, corners: [{ x: 150, y: 170 }, { x: 760, y: 120 }, { x: 820, y: 1080 }, { x: 95, y: 1110 }], table: [120, 82, 50] as [number, number, number], shadow: true },
  turned: { w: 1100, h: 1000, corners: [{ x: 330, y: 80 }, { x: 980, y: 380 }, { x: 760, y: 900 }, { x: 110, y: 600 }], table: [60, 64, 70] as [number, number, number] },
};

test('5. scan cleanup finds the page on sample photos, straightens it and makes the paper white and the writing dark', () => {
  for (const [name, s] of Object.entries(SAMPLES)) {
    const p = photo(s);
    fs.writeFileSync(path.join(OUT, `scan-${name}-before.png`), png(p));
    const found = scan.findPage(p);
    assert.ok(found, `${name}: a page is found`);
    // Each corner within 3% of the photo's size of where the page's corner really is.
    const tol = Math.max(s.w, s.h) * 0.03;
    for (const truth of s.corners) assert.ok(found!.some((c) => Math.hypot(c.x - truth.x, c.y - truth.y) < tol), `${name}: a corner near ${JSON.stringify(truth)}, found ${JSON.stringify(found)}`);
    const done = scan.cleanPage(p, 1000)!;
    fs.writeFileSync(path.join(OUT, `scan-${name}-after.png`), png(done.page));
    const { width: w, height: h, data } = done.page;
    assert.ok(Math.max(w, h) <= 1000);
    // In the cleaned page, paper is near white and the writing is dark, wherever the shadow was.
    let paper = 0, np = 0, ink = 0, ni = 0;
    for (let y = 2; y < h - 2; y += 3) for (let x = 2; x < w - 2; x += 3) {
      const u = (x + 0.5) / w, v = (y + 0.5) / h, i = (y * w + x) * 4, l = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const near = [-0.012, 0, 0.012].some((dv) => inkAt(u, v + dv)) || [-0.012, 0.012].some((du) => inkAt(u + du, v));
      if (inkAt(u, v) && inkAt(u, v - 0.003) && inkAt(u, v + 0.003)) (ink += l), ni++;
      else if (!near) (paper += l), np++;
    }
    assert.ok(paper / np > 235, `${name}: paper ${paper / np}`);
    assert.ok(ink / ni < 110, `${name}: ink ${ink / ni}`);
  }
});

test('5. a photo with no clear page, or a page that fills the whole picture, is left as it was', () => {
  const r = rnd(3);
  const noise = { width: 400, height: 300, data: new Uint8ClampedArray(400 * 300 * 4).map((_, i) => (i % 4 === 3 ? 255 : r() * 255)) };
  assert.equal(scan.cleanPage(noise), null);
  // A screenshot of a document: white all over with writing on it.
  const full = photo({ w: 600, h: 800, corners: [{ x: -5, y: -5 }, { x: 605, y: -5 }, { x: 605, y: 805 }, { x: -5, y: 805 }], table: [255, 255, 255] });
  assert.equal(scan.cleanPage(full), null);
  // A plain grey picture.
  assert.equal(scan.cleanPage({ width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4).fill(128) }), null);
  // A round bright plate on a table is no page.
  const plate = { width: 500, height: 500, data: new Uint8ClampedArray(500 * 500 * 4) };
  for (let y = 0; y < 500; y++) for (let x = 0; x < 500; x++) { const i = (y * 500 + x) * 4, on = Math.hypot(x - 250, y - 250) < 180; plate.data.set(on ? [240, 240, 240, 255] : [90, 60, 40, 255], i); }
  assert.equal(scan.findPage(plate), null);
});

// ---- 1. The manifest -----------------------------------------------------------------------------------------------

test('1. the manifest: name, short name, the brand icons with a maskable one, start at /app, brand colours, share target', () => {
  const m: any = webManifest();
  assert.equal(m.name, 'GrowSigning');
  assert.equal(m.short_name, 'GrowSigning');
  assert.equal(m.start_url, '/app');
  assert.equal(m.display, 'standalone');
  assert.deepEqual(m.icons.map((i: any) => i.sizes), ['192x192', '512x512', '512x512']);
  assert.ok(m.icons.some((i: any) => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(root, 'public', i.src)), i.src);
  assert.equal(m.share_target.action, '/share-target');
  assert.equal(m.share_target.method, 'POST');
  assert.equal(m.share_target.enctype, 'multipart/form-data');
  assert.equal(m.share_target.params.files[0].name, 'file');
  assert.ok(m.share_target.params.files[0].accept.includes('application/pdf'));
  // The iPhone tags come from the layout's metadata.
  const layout = fs.readFileSync(path.join(root, 'src/app/layout.tsx'), 'utf8');
  assert.match(layout, /appleWebApp: \{ capable: true, title: 'GrowSigning'/);
  // The words say what it is, and never "PWA" or "install app".
  const en = JSON.parse(fs.readFileSync(path.join(root, 'src/locales/en.json'), 'utf8'));
  for (const s of [en['home.add_to_home_screen'], lib.NOT_IN_STORES, lib.WHAT_IT_DOES, ...lib.CANNOT, ...lib.IPHONE_STEPS]) {
    assert.doesNotMatch(s, /PWA|\u2014/);
  }
  assert.equal(lib.NOT_IN_STORES, 'This is the website saved as an app. It is not in the app stores.');
});

// ---- 2. The service worker -----------------------------------------------------------------------------------------

type Fake = { put: string[]; handlers: Record<string, any>; store: Map<string, Map<string, any>>; net: (url: string) => any };
function worker(): Fake {
  const code = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
  const f: Fake = { put: [], handlers: {}, store: new Map(), net: () => ({ ok: true, status: 200, type: 'basic', headers: new Headers(), clone() { return this; } }) };
  const open = async (k: string) => {
    if (!f.store.has(k)) f.store.set(k, new Map());
    const m = f.store.get(k)!;
    return {
      match: async (r: any) => m.get(typeof r === 'string' ? new URL(r, 'https://growsigning.com').href : r.url),
      put: async (r: any, res: any) => (f.put.push(r.url), m.set(r.url, res)),
      addAll: async (urls: string[]) => urls.forEach((u) => m.set(new URL(u, 'https://growsigning.com').href, { offline: u })),
      keys: async () => [...m.keys()],
      delete: async (k2: string) => m.delete(k2),
    };
  };
  const ctx: any = {
    self: { addEventListener: (t: string, h: any) => (f.handlers[t] = h), location: { origin: 'https://growsigning.com' }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open, keys: async () => [...f.store.keys()], delete: async (k: string) => f.store.delete(k) },
    fetch: async (r: any) => f.net(r.url),
    URL, Headers, Promise, console,
  };
  vm.runInNewContext(code, ctx);
  return f;
}
async function fetchEvent(f: Fake, url: string, o: { method?: string; mode?: string } = {}) {
  let answered: Promise<any> | null = null;
  f.handlers.fetch({ request: { url, method: o.method || 'GET', mode: o.mode || 'no-cors' }, respondWith: (p: Promise<any>) => (answered = p) });
  return answered ? await answered : undefined;
}

test('2. the service worker never answers or keeps a signing page, a document, the API, a form, a website agreement or any address with a token', async () => {
  const f = worker();
  const never = [
    '/sign/AbCdEf123456', '/sign/AbCdEf123456/document.pdf', '/api/envelopes', '/api/envelopes/env_1/download', '/api/sign/tok/pdf', '/f/my-form', '/agree/terms',
    '/app/envelopes/env_1', '/app?token=abc', '/_next/static/chunks/main.js?token=abc', '/fonts/lora-500.woff2?x=1', '/brand/icon-192.png#t',
    '/check/abcdef', '/verify', '/login', '/embed/sender/xyz', '/share-target', '/_next/static/token-abc.js', '/brand/secret.png',
    'https://elsewhere.example/_next/static/a.js', '/', '/help',
  ];
  for (const p of never) {
    const url = p.startsWith('http') ? p : `https://growsigning.com${p}`;
    assert.equal(await fetchEvent(f, url), undefined, `${p} is left to the browser`);
    assert.equal(await fetchEvent(f, url, { method: 'POST' }), undefined, `POST ${p} is left to the browser`);
  }
  // Navigations outside /app are left alone too: a signing link opened in the app's window is never under it.
  for (const p of ['/sign/AbCdEf123456', '/f/my-form', '/agree/terms', '/', '/login']) assert.equal(await fetchEvent(f, `https://growsigning.com${p}`, { mode: 'navigate' }), undefined, p);
  assert.deepEqual(f.put, []);
  // What it keeps: built files, fonts, brand icons, the offline page.
  for (const p of ['/_next/static/chunks/app-1a2b.js', '/_next/static/css/9f.css', '/fonts/lora-500.woff2', '/brand/icon-192.png']) await fetchEvent(f, `https://growsigning.com${p}`);
  assert.equal(f.put.length, 4);
  // An answer marked as not to be stored, an error or a redirect is never kept.
  const g = worker();
  for (const res of [{ ok: true, status: 200, type: 'basic', headers: new Headers({ 'cache-control': 'private, no-store' }), clone() { return this; } }, { ok: false, status: 404, type: 'basic', headers: new Headers() }, { ok: true, status: 200, type: 'opaqueredirect', headers: new Headers() }]) {
    g.net = () => res;
    await fetchEvent(g, 'https://growsigning.com/_next/static/x.js');
  }
  assert.deepEqual(g.put, []);
});

test('2. the app pages get the offline page when there is no connection, never a kept copy of themselves', async () => {
  const f = worker();
  let done: any;
  f.handlers.install({ waitUntil: (p: Promise<any>) => (done = p) });
  await done;
  f.net = () => { throw new TypeError('offline'); };
  const res = await fetchEvent(f, 'https://growsigning.com/app/envelopes', { mode: 'navigate' });
  assert.deepEqual(res, { offline: '/offline.html' });
  // Online, the page comes from the network and is not kept.
  f.net = () => ({ ok: true, status: 200, type: 'basic', headers: new Headers(), page: true, clone() { return this; } });
  assert.equal((await fetchEvent(f, 'https://growsigning.com/app', { mode: 'navigate' })).page, true);
  assert.deepEqual(f.put, []);
  const offline = fs.readFileSync(path.join(root, 'public/offline.html'), 'utf8');
  assert.match(offline, /No internet connection/);
  assert.doesNotMatch(offline, /\u2014/);
});

test('2. a new version replaces the old cache, and the version follows the offline page', async () => {
  const code = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
  const version = /const VERSION = '([^']+)'/.exec(code)![1];
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'public/offline.html'))).digest('hex').slice(0, 8);
  assert.ok(version.endsWith(sha), `public/offline.html changed: give VERSION in public/sw.js a new number and end it with ${sha}`);
  const f = worker();
  f.store.set('growsigning-shell-0-old', new Map([['x', 1]]));
  f.store.set('someone-elses-cache', new Map());
  f.store.set(version, new Map());
  let done: any;
  f.handlers.activate({ waitUntil: (p: Promise<any>) => (done = p) });
  await done;
  assert.deepEqual([...f.store.keys()].sort(), [version, 'someone-elses-cache'].sort());
  // It is registered by the app's pages only, for /app.
  const reg = fs.readFileSync(path.join(root, 'src/components/ShellWorker.tsx'), 'utf8');
  assert.match(reg, /register\('\/sw\.js', \{ scope: '\/app' \}\)/);
  assert.match(fs.readFileSync(path.join(root, 'src/app/app/layout.tsx'), 'utf8'), /<ShellWorker \/>/);
  for (const f2 of ['src/app/sign', 'src/app/f', 'src/app/agree']) {
    const dir = path.join(root, f2);
    if (!fs.existsSync(dir)) continue;
    const all = fs.readdirSync(dir, { recursive: true }).map(String).filter((n) => /\.tsx?$/.test(n));
    for (const n of all) assert.doesNotMatch(fs.readFileSync(path.join(dir, n), 'utf8'), /ShellWorker|serviceWorker/, `${f2}/${n}`);
  }
});

// ---- 4. Sharing into GrowSigning -----------------------------------------------------------------------------------

const PAGE_PHOTO = (seed = 7) => png(photo({ ...SAMPLES.tilted, seed, w: 300, h: 400, corners: SAMPLES.tilted.corners.map((c) => ({ x: c.x / 3, y: c.y / 3 })) }));
function shareForm(files: [string, Uint8Array | Buffer, string][]) {
  const f = new FormData();
  f.append('title', 'Shared');
  for (const [name, data, type] of files) f.append('file', new Blob([new Uint8Array(data)], { type }), name);
  return f;
}

test('4. the share target refuses without a session and keeps nothing', async () => {
  const before = S.db.get('SELECT COUNT(*) n FROM files').n;
  const r = await new Client().call('POST', '/share-target', shareForm([['Lease.pdf', await samplePdf(1), 'application/pdf']]));
  assert.equal(r.status, 401);
  assert.equal(S.db.get('SELECT COUNT(*) n FROM files').n, before);
});

test('4. a signed-in person sharing a PDF and two photos gets one new draft with the PDF and the photos as one document', async () => {
  const c = await signUp('Paula Phone', 'paula@phone.example', '198.51.100.31');
  const r = await c.call('POST', '/share-target', shareForm([['page 1.png', PAGE_PHOTO(), 'image/png'], ['Lease.pdf', await samplePdf(2), 'application/pdf'], ['page 2.png', PAGE_PHOTO(), 'image/png']]), { 'sec-fetch-site': 'none' });
  assert.equal(r.status, 303);
  const e = (await c.get('/envelopes')).data.envelopes.find((x: any) => x.status === 'draft');
  assert.ok(e, 'a draft was made');
  const full = (await c.get(`/envelopes/${e.id}`)).data.envelope;
  assert.deepEqual(full.documents.map((d: any) => d.pages), [2, 2]);
  assert.equal(full.subject, 'Please sign: Lease');
  assert.equal(full.recipients.length, 0);
});

test('4. a share from another website, an empty share and a file that is not a PDF or picture are refused, and nothing is made', async () => {
  const c = await signUp('Sam Share', 'sam@phone.example', '198.51.100.32');
  const drafts = () => S.db.get("SELECT COUNT(*) n FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE u.email='sam@phone.example'").n;
  const pdf = await samplePdf(1);
  let r = await c.call('POST', '/share-target', shareForm([['Lease.pdf', pdf, 'application/pdf']]), { 'sec-fetch-site': 'cross-site' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /another website.*To add a file, share it from your phone or upload it/);
  r = await c.call('POST', '/share-target', shareForm([['Lease.pdf', pdf, 'application/pdf']]), { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  r = await c.call('POST', '/share-target', shareForm([]));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /^Nothing that GrowSigning can use was shared\. Share a PDF/);
  r = await c.call('POST', '/share-target', shareForm([['notes.txt', Buffer.from('hello'), 'text/plain']]));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /^"notes\.txt" could not be added\. /);
  r = await c.call('POST', '/share-target', shareForm(Array.from({ length: 11 }, (_, i) => [`d${i}.pdf`, pdf, 'application/pdf'] as [string, Uint8Array, string])));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Up to 10 files can be shared at once.*Share fewer at a time\./);
  assert.equal(drafts(), 0);
});

// ---- 5. The original photo kept --------------------------------------------------------------------------------------

async function cleanedUpload(c: Client, n = 1, seed = 7) {
  const f = new FormData();
  const raw = PAGE_PHOTO(seed);
  for (let i = 0; i < n; i++) {
    const p = photo({ ...SAMPLES.tilted, w: 300, h: 400, corners: SAMPLES.tilted.corners.map((q) => ({ x: q.x / 3, y: q.y / 3 })) });
    const done = scan.cleanPage(p, 400)!;
    f.append('file', new Blob([new Uint8Array(png(done.page))], { type: 'image/png' }), `page ${i + 1}.png`);
    f.append(`scan_original_${i}`, new Blob([new Uint8Array(raw)], { type: 'image/png' }), `page ${i + 1}.png`);
  }
  f.append('scan_cleaned', Array.from({ length: n }, (_, i) => i).join(','));
  const r = await c.call('POST', '/files', f);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { file: r.data, raw };
}

test('5. the photo a page was cleaned from is kept with the document, listed in the evidence pack, and Undo cleanup makes it again from the photo', async () => {
  const c = await signUp('Carla Clean', 'carla@phone.example', '198.51.100.33');
  const { file, raw } = await cleanedUpload(c, 2);
  assert.deepEqual(file.cleaned_pages, [1, 2]);
  const e = (await c.post('/envelopes', { documents: [{ file_id: file.id, name: 'Lease' }] })).data.envelope;
  const env = (await c.get(`/envelopes/${e.id}`)).data.envelope;
  assert.deepEqual(env.documents[0].cleaned_pages, [1, 2]);
  // Evidence pack: the photos as taken, with an index and the README line.
  const { evidencePack } = await import('../src/server/evidence.ts');
  const zip = await evidencePack(S.env.loadEnvelope(e.id), 'test');
  const names = zip.entries.map((x) => x.name);
  assert.ok(names.includes('scan-photos/01 Lease page 1.png'), names.join());
  assert.ok(names.includes('scan-photos/index.csv'));
  assert.deepEqual(Buffer.from(zip.entries.find((x) => x.name === 'scan-photos/01 Lease page 2.png')!.data), raw);
  const readme = Buffer.from(zip.entries.find((x) => x.name === 'README.txt')!.data).toString();
  // It says what the server knows: the sender's browser sent this photo; nobody checked the page came from it.
  assert.match(readme, /the photo the sender's browser sent as the one it cleaned the page from, before cleanup\./);
  assert.match(readme, /does not check that the page was made from it\./);
  assert.doesNotMatch(readme, /as they were taken|The page was cleaned from this photo/);
  // Undo cleanup: a new file made from the photos, with no cleaned pages.
  const u = await c.post(`/files/${file.id}/undo-cleanup`);
  assert.equal(u.status, 200, JSON.stringify(u.data));
  assert.equal(u.data.file.pages, 2);
  assert.equal(u.data.file.cleaned_pages, undefined);
  assert.notEqual(u.data.file.id, file.id);
  // Pressed again (or called in a loop): the same new file, and no other file is made.
  const files = () => S.db.get('SELECT COUNT(*) n FROM files WHERE account_id=?', S.db.get('SELECT account_id a FROM files WHERE id=?', file.id).a).n;
  const had = files();
  for (let i = 0; i < 3; i++) {
    const again = await c.post(`/files/${file.id}/undo-cleanup`);
    assert.equal(again.status, 200);
    assert.equal(again.data.file.id, u.data.file.id);
    assert.equal(again.data.file.pages, 2);
  }
  assert.equal(files(), had);
  // Once that new file is gone, undo makes one again rather than answering a file that no longer exists.
  S.db.run('DELETE FROM files WHERE id=?', u.data.file.id);
  const fresh = await c.post(`/files/${file.id}/undo-cleanup`);
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.data.file.id, u.data.file.id);
  assert.ok(S.db.get('SELECT 1 x FROM files WHERE id=?', fresh.data.file.id));
  // Another account cannot read the first one's answer through it.
  assert.equal((await (await signUp('Uma Undo', 'uma@phone.example', '198.51.100.36')).post(`/files/${file.id}/undo-cleanup`)).status, 404);
  // Someone else's file, and a file with no photos, are refused in plain words.
  const other = await signUp('Olga Other', 'olga@phone.example', '198.51.100.34');
  assert.equal((await other.post(`/files/${file.id}/undo-cleanup`)).status, 404);
  const none = await c.post(`/files/${fresh.data.file.id}/undo-cleanup`);
  assert.equal(none.status, 409);
  assert.match(none.data.error, /cannot be undone here\. Use Replace file/);
});

test('5. a signer cannot see the photos, a photo that is not a picture is not kept, and the photos leave the disk with their file', async () => {
  const c = await signUp('Dina Delete', 'dina@phone.example', '198.51.100.35');
  // Not a picture: nothing is kept and the page is not called cleaned.
  const f = new FormData();
  f.append('file', new Blob([new Uint8Array(PAGE_PHOTO())], { type: 'image/png' }), 'page.png');
  f.append('scan_original_0', new Blob([Buffer.from('<script>alert(1)</script>')], { type: 'image/png' }), 'page.png');
  f.append('scan_cleaned', '0');
  const bad = await c.call('POST', '/files', f);
  assert.equal(bad.status, 200);
  assert.equal(bad.data.cleaned_pages, undefined);
  // Sent: the signer's page says nothing of the photos, and the cleanup can no longer be undone.
  const sent = await cleanedUpload(c, 1, 55);
  const e = await simple(c, 'sig@phone.example', { documents: [{ id: 'd', file_id: sent.file.id }] });
  const go = await c.post(`/envelopes/${e.id}/send`);
  assert.equal(go.status, 200, JSON.stringify(go.data));
  const view = await new Client().get(`/sign/${tokenFor(e.id, 'sig@phone.example')}`);
  assert.equal(view.status, 200);
  assert.doesNotMatch(JSON.stringify(view.data), /cleaned|scan_original|scan-photos/);
  const late = await c.post(`/files/${sent.file.id}/undo-cleanup`);
  assert.equal(late.status, 409);
  assert.match(late.data.error, /^This document has been sent, so its pages can no longer be changed\. Correct the envelope/);
  // A cleaned file, then deleted: the photo goes from the disk at the next tick.
  const { file } = await cleanedUpload(c, 1, 99);
  const sha = S.db.get('SELECT sha256 FROM scan_photos WHERE file_id=?', file.id).sha256;
  const blob = path.join(process.env.DATA_DIR!, 'blobs', sha);
  assert.ok(fs.existsSync(blob));
  S.db.run('DELETE FROM files WHERE id=?', file.id);
  assert.equal(S.db.get('SELECT COUNT(*) n FROM scan_photos WHERE file_id=?', file.id).n, 0);
  const { sweepScanPhotos } = await import('../src/server/scanphotos.ts');
  assert.equal(sweepScanPhotos(), 1);
  assert.ok(!fs.existsSync(blob));
});

// ---- Repairs after the skeptic's and the simplicity reviewer's rounds ------------------------------------------------

test('repair: "Origin: null" is let through only for a share from the phone itself', () => {
  assert.equal(lib.shareOrigin(null, null), 'keep');
  assert.equal(lib.shareOrigin('https://growsigning.com', 'same-origin'), 'keep');
  assert.equal(lib.shareOrigin('null', 'none'), 'drop');
  assert.equal(lib.shareOrigin('null', 'NONE'), 'drop');
  // A sandboxed frame or data: page of another site, or an older browser that sends no Sec-Fetch-Site.
  assert.equal(lib.shareOrigin('null', null), 'refuse');
  assert.equal(lib.shareOrigin('null', ''), 'refuse');
  assert.equal(lib.shareOrigin('null', 'cross-site'), 'refuse');
  assert.equal(lib.shareOrigin('null', 'same-origin'), 'refuse');
  const page = fs.readFileSync(path.join(root, 'src/app/share-target/route.ts'), 'utf8');
  assert.match(page, /shareOrigin\(headers\.get\('origin'\), headers\.get\('sec-fetch-site'\)\)/);
  assert.doesNotMatch(page, /if \(headers\.get\('origin'\) === 'null'\) headers\.delete/);
  assert.match(lib.SHARE_FROM_ELSEWHERE, /was not added\. To add a file, share it from your phone or upload it in GrowSigning\.$/);
});

test('repair: the words promise only what the code keeps, and go through the translation layer', async () => {
  const en = JSON.parse(fs.readFileSync(path.join(root, 'src/locales/en.json'), 'utf8'));
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
  // An iPhone's saved app has its own sign-in: Help does not say "you stay signed in" for every phone.
  assert.doesNotMatch(lib.WHAT_IT_DOES, /^.*You stay signed in as you are in the browser/);
  assert.match(lib.WHAT_IT_DOES, /On an iPhone the saved app keeps its own sign-in, apart from Safari, so you sign in once more inside it\./);
  // A kept photo was made smaller when large: nothing says "as you took it" or "as taken".
  const said = [lib.CLEANED_EVIDENCE, lib.CLEANUP_HELP, en['editor.undo_done'], read('src/app/help/homescreen.tsx'), read('src/components/editor/CleanedLine.tsx'), read('src/server/openapi-phoneapp.ts')].join('\n');
  assert.doesNotMatch(said, /as you took|as they were taken|as it was taken|as taken/i);
  assert.match(lib.CLEANUP_HELP, /made smaller first/);
  // README: three visits, not "once".
  const readme = read('README.md');
  assert.doesNotMatch(readme, /offers once to add GrowSigning/);
  assert.match(readme, /offers, on the first three visits, to add GrowSigning/);
  assert.equal(lib.INSTALL_VISITS, 3);
  // The line on Home and the cleanup line read their words with T(), and every key they use is in en.json.
  for (const f of ['src/components/InstallHint.tsx', 'src/components/editor/CleanedLine.tsx']) {
    const src = read(f);
    assert.match(src, /useST\(\)/, f);
    const keys = [...src.matchAll(/T\('([a-z_.]+)'/g)].map((m) => m[1]);
    assert.ok(keys.length >= 3, f);
    for (const k of keys) assert.ok(en[k], `${k} is in en.json`);
    assert.doesNotMatch(src, /'Add GrowSigning to your home screen'|'Undo cleanup'|"Dismiss: do not show this again"/, f);
  }
  const { senderT } = await import('../src/lib/senderlang.ts');
  assert.equal(senderT('en', 'editor.cleaned', { count: 1 }), 'We found the page in your photo, straightened it and made the writing darker.');
  assert.equal(senderT('en', 'editor.cleaned', { count: 3 }), 'We found the page in 3 of your photos, straightened them and made the writing darker.');
  for (const k of Object.keys(en).filter((k) => k.startsWith('home.add_') || k.startsWith('editor.undo') || k === 'editor.cleaned')) assert.doesNotMatch(en[k], /—/, k);
  // Cleanup has its own Help answer, apart from the home-screen one.
  const help = read('src/app/help/homescreen.tsx');
  assert.match(help, /export function PhotoCleanupHelp/);
  assert.match(read('src/app/help/page.tsx'), /<PhotoCleanupHelp \/>/);
  assert.equal(lib.CLEANUP_HELP_ID, 'photo-cleanup');
  const home = help.slice(help.indexOf('export function HomeScreenHelp'), help.indexOf('export function PhotoCleanupHelp'));
  assert.doesNotMatch(home, /Undo cleanup|Photos of paper/);
});

test('repair: dismissing the line on Home moves focus to the page heading and says so', () => {
  const src = fs.readFileSync(path.join(root, 'src/components/InstallHint.tsx'), 'utf8');
  const dismiss = src.slice(src.indexOf('const dismiss = () => {'), src.indexOf('const add = async'));
  assert.match(dismiss, /querySelector<HTMLElement>\('main h1'\)/);
  assert.match(dismiss, /setAttribute\('tabindex', '-1'\)/);
  assert.match(dismiss, /\.focus\(\)/);
  assert.match(dismiss, /toast\(T\('home\.add_dismissed'\)\)/);
});

test('repair: the paper hint in step 1 points to photos, the one way that is cleaned', async () => {
  const { PAPER_HINT } = await import('../src/components/editor/upload.ts');
  assert.doesNotMatch(PAPER_HINT, /scan it to a PDF|Google Drive|Notes|cleanest/);
  assert.match(PAPER_HINT, /^Starting from paper\? Take a photo of each page and choose them all at once\./);
  assert.ok(PAPER_HINT.split(/\s+/).length <= 30, PAPER_HINT);
});
