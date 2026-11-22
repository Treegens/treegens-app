// The GrowSigning brand wired into the app (brand/README.md, "Wiring it in"): the logo where the product names itself,
// the page head and its link preview, the web app manifest, the email header, the certificate and the stamp on signed
// copies; then the old name nowhere, and how long a browser stays signed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PDFDocument, degrees } from 'pdf-lib';
import { boot, signUp, Client, PNG, tokenFor } from './helpers.ts';

const server = await boot();
const { renderMail } = await import('../src/server/mail.ts');
const { readPng, decodePng } = await import('../src/server/png.ts');
const { siteBase, webManifest, OG_ALT, PRODUCT, SITE_TITLE } = await import('../src/lib/site.ts');
const { LOGO, COLORS } = await import('../src/lib/brandMark.ts');
const { PAGE_STAMP_W } = await import('../src/server/brandpdf.ts');
const manifest = (await import('../src/app/manifest.ts')).default;

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const bytes = (p: string) => fs.readFileSync(path.join(root, p));
let ipN = 0;
const newIp = () => `198.51.100.${++ipN}`;
const havePoppler = spawnSync('which', ['pdftotext']).status === 0 && spawnSync('which', ['pdftoppm']).status === 0;

// ---- 1. The page head: styles, icons, link preview -------------------------------------------------------------

test('the layout loads the brand styles last, has no data URI icon, and takes its preview address from APP_URL', () => {
  const layout = read('src/app/layout.tsx');
  const styles = [...layout.matchAll(/^import '\.\/(?:globals|styles\/[\w-]+)\.css';/gm)].map((m) => m[0]);
  assert.ok(styles.length > 2);
  assert.equal(styles[0], "import './globals.css';");
  assert.equal(styles.at(-1), "import './styles/brand.css';", 'brand.css comes after globals.css and every other style, so its --serif wins');
  assert.doesNotMatch(layout, /icons:\s*\{/, 'the icons are files in src/app, not a data URI leaf');
  assert.doesNotMatch(layout, /data:image\/svg/);
  assert.match(layout, /metadataBase:\s*siteBase\(\)/);
  assert.match(layout, /twitter:\s*\{\s*card:\s*'summary_large_image'\s*\}/);
  assert.match(layout, /themeColor:\s*'#134a2c'/, 'the theme colour stays the deep green');
  // Lora is there to be loaded.
  for (const w of [500, 600]) assert.ok(fs.statSync(path.join(root, `public/fonts/lora-${w}.woff2`)).size > 10_000, `lora-${w}.woff2 was copied by scripts/copy-assets.mjs`);
  assert.match(read('src/app/styles/brand.css'), /--serif:\s*'Lora'/);
});

test('the preview address is APP_URL when it is an http or https address, else this machine, and never takes a page down', () => {
  assert.equal(siteBase('https://growsigning.com').href, 'https://growsigning.com/');
  assert.equal(siteBase('https://growsigning.com/some/path?x=1').href, 'https://growsigning.com/', 'only the origin');
  assert.equal(siteBase('  http://localhost:3700/ ').href, 'http://localhost:3700/');
  // A mistyped or hostile APP_URL gives previews a harmless address instead of a page that will not render.
  assert.equal(siteBase(undefined).href, 'http://test.local/', 'no argument: APP_URL itself');
  for (const bad of ['', 'growsigning.com', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://growsigning.com', 'http://'])
    assert.equal(siteBase(bad).href, 'http://localhost:3000/', String(bad));
});

test('the four icon files and the preview picture in src/app are the brand kit files, with the preview alt text', () => {
  for (const [from, to] of [['public/brand/favicon.ico', 'src/app/favicon.ico'], ['brand/icon.svg', 'src/app/icon.svg'], ['public/brand/apple-touch-icon.png', 'src/app/apple-icon.png'], ['public/brand/og-image.png', 'src/app/opengraph-image.png']])
    assert.ok(bytes(from).equals(bytes(to)), `${to} is a copy of ${from} (node scripts/build-brand.mjs refreshes it)`);
  const og = readPng(bytes('src/app/opengraph-image.png'))!;
  assert.deepEqual([og.width, og.height], [1200, 630]);
  const apple = readPng(bytes('src/app/apple-icon.png'))!;
  assert.deepEqual([apple.width, apple.height], [180, 180]);
  assert.equal(read('src/app/opengraph-image.alt.txt').trim(), OG_ALT);
  assert.equal(OG_ALT, 'GrowSigning: sign on screen. Every dollar plants mangroves.');
  assert.match(read('src/app/icon.svg'), /<title>growsigning<\/title>/);
  // An icon of the old shape left behind would be served next to the new one.
  for (const f of fs.readdirSync(path.join(root, 'src/app'))) assert.doesNotMatch(f, /^(icon|apple-icon|favicon)\d|^twitter-image/, f);
});

test('there is one web app manifest, with the name, colours and the three brand icons at their real sizes', () => {
  const m = manifest();
  assert.deepEqual(m, webManifest());
  assert.equal(m.name, 'GrowSigning');
  assert.equal(m.short_name, 'GrowSigning');
  assert.equal(m.start_url, '/app');
  assert.equal(m.display, 'standalone');
  assert.equal(m.background_color, COLORS.paper);
  assert.equal(m.theme_color, '#134a2c');
  assert.equal(m.icons!.length, 3);
  for (const icon of m.icons!) {
    const png = readPng(bytes(path.join('public', icon.src)))!;
    assert.ok(png, `${icon.src} is a PNG`);
    assert.equal(`${png.width}x${png.height}`, icon.sizes, `${icon.src} is the size it says`);
    assert.equal(icon.type, 'image/png');
  }
  assert.equal(m.icons!.filter((i) => i.purpose === 'maskable').map((i) => i.src).join(), '/brand/icon-maskable-512.png');
  // Next serves src/app/manifest.ts at /manifest.webmanifest. A second one in public/ would compete with it.
  for (const f of ['manifest.webmanifest', 'manifest.json', 'site.webmanifest']) assert.ok(!fs.existsSync(path.join(root, 'public', f)), `no public/${f}`);
  for (const f of ['manifest.json', 'manifest.webmanifest']) assert.ok(!fs.existsSync(path.join(root, 'src/app', f)), `no src/app/${f}`);
  assert.equal(PRODUCT, 'GrowSigning');
});

// ---- 1. The logo in the app ----------------------------------------------------------------------------------------

// Each place the product names itself, and the logo it shows there (brand/README.md, step 5).
const LOGO_PLACES: [string, RegExp][] = [
  ['src/components/AppShell.tsx', /className="row mobilebar-logo"><Logo height=\{20\} tone="dark" \/>/],
  ['src/components/AppShell.tsx', /className="brand"><Logo height=\{24\} tone="dark" \/>/],
  ['src/components/AuthForm.tsx', /className="logo"[^>]*><Logo height=\{26\} \/>/],
  ['src/app/login/two-step/TwoStepForm.tsx', /className="logo"[^>]*><Logo height=\{26\} \/>/],
  ['src/components/Public.tsx', /className="logo"><Logo height=\{26\} \/>/],
  ['src/components/Public.tsx', /className="logo"><Logo height=\{22\} \/>/],
  ['src/components/HandedOver.tsx', /<Logo height=\{22\} \/>/],
  ['src/components/sign/parts.tsx', /<Mark size=\{24\} tone=\{brand\?\.brand_color \? 'mono' : 'dark'\} \/>/],
  ['src/components/sign/parts.tsx', /className="sg-foot-by"><SentWith height=\{16\} \/>/],
  ['src/app/f/[slug]/page.tsx', /<Mark size=\{28\} label="" \/>/],
  ['src/app/agree/[slug]/page.tsx', /<Mark size=\{24\} label="" \/>/],
];

test('every place that shows the leaf with the product name shows the drawn logo instead', () => {
  for (const [file, want] of LOGO_PLACES) assert.match(read(file), want, file);
  // Nowhere does a leaf stand next to the typed name any more, which is what the drawn logo replaces.
  const offenders: string[] = [];
  walk('src', (f, text) => {
    if (!/\.tsx?$/.test(f)) return;
    for (const m of text.matchAll(/<(Leaf|Mark)\b[^>]*\/>\s*(Powered by\s+)?(GrowSigning|growsigning)\b/g)) offenders.push(`${f}: ${m[0]}`);
  });
  assert.deepEqual(offenders, [], 'the name is never typed next to the mark (brand/README.md, "Things not to do")');
  // The old leaf's drawing is gone: Leaf, kept for files not yet moved to Mark, draws the new mark in one colour.
  const ui = read('src/components/ui.tsx');
  assert.doesNotMatch(ui, /M2 22C2 9 10 2 22 2c0 12-7 20-20 20Z/);
  assert.match(ui, /export const Leaf = [^]*?<Mark size=\{size\} tone="mono" label="" style=\{\{ color \}\} \/>/);
  const leaves: string[] = [];
  walk('src', (f, text) => { if (/\.tsx$/.test(f) && f !== 'src/components/ui.tsx' && /<Leaf\b/.test(text)) leaves.push(f); });
  // The one left is in the Billing() part of Settings, which another brief owns; it now draws the new mark.
  assert.deepEqual(leaves, ['src/app/app/settings/page.tsx']);
});

test('the logo keeps its proportions and is never squeezed: it is drawn at a fixed width and does not shrink', () => {
  const brand = read('src/components/Brand.tsx');
  assert.match(brand, /const width = Math\.round\(\(\(height \* LOGO\.width\) \/ LOGO\.height\) \* 100\) \/ 100;/);
  assert.equal((brand.match(/style=\{\{ flex: 'none', \.\.\.style \}\}/g) || []).length, 2, 'Mark and Logo never shrink in a row of other things');
  // Screen readers hear the name as a sentence writes it.
  assert.match(brand, /export function Logo\(\{[^}]*label = 'GrowSigning'/);
  assert.match(brand, /export function Mark\(\{[^}]*label = 'GrowSigning'/);
  // At 20 px, on the narrowest phone bar, the logo is 131 px wide: room is left for Help and Menu at 320 px.
  assert.ok(Math.round((20 * LOGO.width) / LOGO.height) <= 131);
  // The logo links are 44 px targets, the logo shrinks to 20 px (never below 16) on a 320 px phone so the menu button is
  // not pushed off the screen, and the keyboard's focus ring shows on the deep green bars (light leaf, 6.2 to 1).
  const css = read('src/app/styles/brand.css');
  assert.match(css, /\.logo, \.side \.brand, \.mobilebar-logo \{ min-height: 44px;/);
  assert.match(css, /@media \(max-width: 359px\) \{\s*\.pub-head \.logo svg \{ height: 20px; width: auto; \}/);
  assert.match(css, /\.side :focus-visible, \.mobilebar :focus-visible \{ outline-color: #9ed88f; \}/);
  // A signing link that did not open has no subject: the bar then shows the drawn logo, not the mark and typed name.
  const parts = read('src/components/sign/parts.tsx');
  // (simplify-signing: also on the consent screen, whose own heading is the subject, so it is not said twice.)
  // Only what matters is pinned here, so a tidy-up of the signing bar does not fail this test: the bar can draw the
  // whole logo at 20 px and the mark at 24 px, and never types the product's name beside a leaf.
  assert.match(parts, /<Logo height=\{20\}/);
  assert.match(parts, /<Mark size=\{24\}/);
  assert.doesNotMatch(parts, /<(?:Mark|Leaf)\b[^>]*\/>\s*(?:\{' '\})?\s*GrowSigning/);
});

test('pages a person reaches from an email, and an address that does not exist, show whose site it is', () => {
  // A confirmation or reset link is where people check that the page is the real one: the same logo as on sign in.
  for (const f of ['src/app/verify-email/page.tsx', 'src/app/change-email/page.tsx', 'src/app/two-step-reset/ResetView.tsx', 'src/app/login/two-step/TwoStepForm.tsx', 'src/components/AuthForm.tsx']) {
    const text = read(f);
    const boxes = (text.match(/<div className="authbox">/g) || []).length;
    assert.ok(boxes > 0, f);
    assert.equal((text.match(/<div className="authbox">\s*(?:\{\/\*[^]*?\*\/\}\s*)?<Link href="\/" className="logo"[^>]*><Logo height=\{26\} \/><\/Link>/g) || []).length, boxes, `${f}: every card on it has the logo above it`);
  }
  // A mistyped address gets our own page with the public header (logo, Help, Sign in) and ways on, not the framework's.
  const nf = read('src/app/not-found.tsx');
  assert.match(nf, /<PublicNav \/>/);
  assert.match(nf, /<PublicFooter \/>/);
  for (const href of ['/', '/login', '/help', '/help#find-documents']) assert.ok(nf.includes(`href="${href}"`), href);
  assert.doesNotMatch(nf, /404|error/i, 'plain words, no code numbers');
  // It never prints the address that was asked for, so a made-up address cannot put words of a stranger's choosing on our page.
  assert.doesNotMatch(nf, /usePathname|useSearchParams|location\.|headers\(/);
});

test('the title of every page and link preview says what the price list says, not that signing plants trees', () => {
  // Trees come from dollars paid; a free account's signatures plant none (brand/README.md, "Never promise").
  assert.match(SITE_TITLE, /^GrowSigning · /);
  assert.match(SITE_TITLE, /every dollar plants mangroves/);
  assert.match(read('src/app/layout.tsx'), /title: \{ default: SITE_TITLE, template: '%s · GrowSigning' \}/);
  for (const f of ['src/app/layout.tsx', 'src/lib/site.ts', 'README.md', 'package.json', 'public/security/sbom.json', 'src/app/opengraph-image.alt.txt'])
    assert.doesNotMatch(read(f), /signatures that plant trees|every signature (plants|saves)/i, f);
});

// ---- 1. The email header ---------------------------------------------------------------------------------------------

test('an email without a sender brand shows the GrowSigning logo picture from APP_URL, with its alt text', () => {
  const html = renderMail({ to: 'x@example.com', subject: 's', heading: 'Hello', lines: ['A line'] });
  assert.match(html, /<img src="http:\/\/test\.local\/brand\/email-logo\.png" width="156" height="32" alt="GrowSigning" style="display:block;border:0;width:156px;height:32px;/);
  const logo = decodePng(bytes('public/brand/email-logo.png'), 1_000_000)!;
  assert.deepEqual([logo.width, logo.height], [312, 64], 'drawn at twice the size it is shown, so it is sharp on a phone');
  // The picture stands on a tile of the email's own ground colour. On the light email the tile cannot be seen; where a
  // mail program darkens the ground and leaves pictures alone, the dark word "signing" still has light under it.
  const ground = /<body style="margin:0;background:(#[0-9a-f]{6});/.exec(html)![1];
  assert.equal(ground, '#f4f1ea');
  const at = (x: number, y: number) => [...logo.data.slice((y * logo.width + x) * 4, (y * logo.width + x) * 4 + 4)];
  for (const [x, y] of [[20, 6], [156, 4], [300, 32], [156, 60]]) assert.deepEqual(at(x, y), [0xf4, 0xf1, 0xea, 255], `the tile at ${x},${y} is the email's ground, not see-through`);
  assert.equal(at(0, 0)[3], 0, 'its corners are rounded');
  let dark = 0;
  for (let x = 150; x < 300; x++) for (let y = 10; y < 54; y++) { const [r, g, b] = at(x, y); if (r + g + b < 200) dark++; }
  assert.ok(dark > 500, `the word "signing" is drawn in ink on the tile: ${dark} pixels`);
  // No email has a dark header, so the logo for dark grounds is never put on the light one.
  assert.doesNotMatch(html, /email-logo-dark/);
  // The picture's address is the same in every email, with nothing about the reader in it, so loading it cannot tell
  // anyone who opened which email (it is not a read receipt).
  const other = renderMail({ to: 'someone.else@example.com', subject: 'Other', heading: 'Other', lines: [], envelopeId: 'env_x', recipientId: 'rec_y', code: 'ABCD2345' });
  const srcs = [html, other].map((h) => [...h.matchAll(/<img src="([^"]*email-logo[^"]*)"/g)].map((m) => m[1]));
  assert.deepEqual(srcs, [['http://test.local/brand/email-logo.png'], ['http://test.local/brand/email-logo.png']]);
});

test("a sender's own logo or name still comes first in the header, escaped, and ours is then not shown", () => {
  const named = renderMail({ to: 'x@example.com', subject: 's', heading: 'h', lines: [], brand: { name: 'Acme <script>alert(1)</script>', color: '#123456' } });
  assert.match(named, /<span style="font-size:18px;font-weight:700;color:#123456">Acme &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span>/);
  assert.doesNotMatch(named, /email-logo\.png/);
  assert.doesNotMatch(named, /<script>/);
  const withLogo = renderMail({ to: 'x@example.com', subject: 's', heading: 'h', lines: [], brand: { name: 'Acme "Ltd"', logo: PNG } });
  assert.ok(withLogo.includes(`<img src="${PNG}" alt="Acme &quot;Ltd&quot;"`));
  assert.doesNotMatch(withLogo, /email-logo\.png/);
  // A logo that is not a picture is never put in an img tag; the name is used instead.
  const notImage = renderMail({ to: 'x@example.com', subject: 's', heading: 'h', lines: [], brand: { name: 'Acme', logo: 'javascript:alert(1)' } });
  assert.doesNotMatch(notImage, /javascript:/);
  assert.match(notImage, />Acme<\/span>/);
});

// ---- 1. The certificate and the stamp on signed copies -------------------------------------------------------------

async function pdfWithRotations(rotations: number[]) {
  const d = await PDFDocument.create();
  for (const [i, r] of rotations.entries()) {
    const p = d.addPage([612, 792]);
    p.drawText(`Agreement page ${i + 1}`, { x: 72, y: 700 });
    p.setRotation(degrees(r));
  }
  return d.save();
}

async function signedCopy(owner: Client, source: Uint8Array, email: string) {
  const f = new FormData();
  f.append('file', new Blob([source], { type: 'application/pdf' }), 'Turned.pdf');
  const up = await owner.call('POST', '/files', f);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const made = await owner.post('/envelopes', {
    subject: 'Brand check', send: true, documents: [{ id: 'd', file_id: up.data.id }], recipients: [{ id: 'r', role: 'signer', name: 'Bree Signer', email }],
    fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.4, y: 0.4, w: 0.3, h: 0.08 }],
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

/** Each page of a PDF drawn at 144 dpi (2 pixels to a point), as the page is shown, turned as its /Rotate says. */
function drawPages(pdf: Uint8Array) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growsigning-brand-'));
  fs.writeFileSync(path.join(dir, 'a.pdf'), pdf);
  const r = spawnSync('pdftoppm', ['-r', '144', '-png', path.join(dir, 'a.pdf'), path.join(dir, 'p')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const text = spawnSync('pdftotext', ['-layout', path.join(dir, 'a.pdf'), '-'], { encoding: 'utf8' }).stdout;
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => decodePng(fs.readFileSync(path.join(dir, f)), 10_000_000)!);
  fs.rmSync(dir, { recursive: true, force: true });
  return { pages, text };
}

/** How many pixels in a box (x, y from the top left, in points) are not white, or are near one colour. */
function inked(img: { width: number; height: number; data: Uint8Array }, x0: number, y0: number, x1: number, y1: number, near?: [number, number, number]) {
  let n = 0;
  for (let y = Math.max(0, Math.floor(y0 * 2)); y < Math.min(img.height, y1 * 2); y++)
    for (let x = Math.max(0, Math.floor(x0 * 2)); x < Math.min(img.width, x1 * 2); x++) {
      const i = (y * img.width + x) * 4;
      const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (near ? Math.abs(r - near[0]) + Math.abs(g - near[1]) + Math.abs(b - near[2]) < 60 : r + g + b < 690) n++;
    }
  return n;
}

test('every page of a signed copy carries the stamp at its foot, on the left, whichever way the page is turned', { skip: !havePoppler && 'pdftoppm is not installed' }, async () => {
  const owner = await signUp('Rae Rotate', 'rae.rotate@example.com', newIp());
  const { id, pdf } = await signedCopy(owner, await pdfWithRotations([0, 90, 180, 270]), 'bree@example.com');
  const { pages, text } = drawPages(pdf);
  assert.ok(pages.length >= 5, 'four pages and the certificate');
  for (const [i, img] of pages.slice(0, 4).entries()) {
    const H = img.height / 2, W = img.width / 2;
    // The stamp: 12 pt tall, about 76 pt wide, 12 pt from the left and 5 pt above the bottom, in muted ink.
    const foot = inked(img, 12, H - 17, 12 + PAGE_STAMP_W, H - 5);
    assert.ok(foot > 450, `page ${i + 1} (turned ${[0, 90, 180, 270][i]}) has the stamp at its foot: ${foot} pixels`);
    // The envelope ID line stands beside it, where every page that speaks of it says it is: at the foot.
    const line = inked(img, 12 + PAGE_STAMP_W + 4, H - 17, 12 + PAGE_STAMP_W + 200, H - 5);
    assert.ok(line > 150, `page ${i + 1}: the envelope ID line is beside the stamp: ${line} pixels`);
    // Everything we print on a page of somebody's document stays in its lowest 17 pt, the strip desk printers leave
    // blank: nothing above it at the left (where a document's own footer would be), nothing at the top any more.
    assert.equal(inked(img, 0, H - 40, 300, H - 18.5), 0, `page ${i + 1}: nothing of ours above the lowest strip`);
    assert.equal(inked(img, 0, 0, W, 30), 0, `page ${i + 1}: nothing of ours at the top`);
    assert.equal(inked(img, W - 102, H - 22, W - 12, H - 2), 0, `page ${i + 1}: nothing in the bottom right corner`);
  }
  // A stamp is drawn, not written: the words a program pulls out of the page are what they were.
  assert.doesNotMatch(text, /Signed with growsigning|growsigning/, 'no words were added');
  assert.equal((text.match(new RegExp(`GrowSigning Envelope ID: ${id}`, 'g')) || []).length, 4, 'the envelope ID line is on every page, as words a program can read');
});

test('on a narrow page the envelope ID line is made smaller, so it is whole and inside the page', { skip: !havePoppler && 'pdftoppm is not installed' }, async () => {
  const d = await PDFDocument.create();
  d.addPage([230, 320]).drawText('A narrow slip', { x: 20, y: 250, size: 10 });
  const owner = await signUp('Nia Narrow', 'nia.narrow@example.com', newIp());
  const { id, pdf } = await signedCopy(owner, await d.save(), 'narrow.signer@example.com');
  const { pages, text } = drawPages(pdf);
  const img = pages[0], H = img.height / 2, W = img.width / 2;
  assert.equal(Math.round(W), 230);
  assert.ok(inked(img, 12 + PAGE_STAMP_W + 4, H - 17, W - 12, H - 5) > 80, 'the line is there, beside the stamp');
  assert.equal(inked(img, W - 11, H - 20, W, H), 0, 'and ends before the right edge of the page');
  assert.ok(text.includes(`GrowSigning Envelope ID: ${id}`), 'the whole ID is on the page');
});

test('the certificate has the deep green band with the logo, its title, and the stamp at the foot of each of its pages', { skip: !havePoppler && 'pdftoppm is not installed' }, async () => {
  const owner = await signUp('Cass Cert', 'cass.cert@example.com', newIp());
  const { id, pdf } = await signedCopy(owner, await pdfWithRotations([0]), 'cert.signer@example.com');
  const { pages, text } = drawPages(pdf);
  const cert = pages.at(-1)!;
  assert.ok(Math.abs(cert.width / 2 - 595.28) < 1, 'an A4 sheet');
  // The band: 92 pt of deep green across the top.
  const deep = [0x13, 0x4a, 0x2c] as [number, number, number];
  assert.ok(inked(cert, 0, 0, 595, 92, deep) > 595 * 92 * 4 * 0.8, 'the band is deep green');
  // The logo for dark grounds, 24 pt tall at the left margin, from 22 pt down: paper and light leaf on the band.
  const paper = inked(cert, 48, 22, 48 + 157, 46, [0xf6, 0xf3, 0xec]), leaf = inked(cert, 48, 22, 48 + 157, 46, [0x9e, 0xd8, 0x8f]);
  assert.ok(paper > 1200 && leaf > 1200, `the logo is drawn in paper (${paper}) and light leaf (${leaf})`);
  assert.equal(inked(cert, 48 + 165, 22, 590, 46, [0xf6, 0xf3, 0xec]), 0, 'nothing beside the logo');
  // On a sheet the stamp's top is 36 pt above the bottom, its foot 22 pt, with the footer line beside it.
  assert.ok(inked(cert, 48, cert.height / 2 - 36, 138, cert.height / 2 - 22) > 600, 'the stamp at the foot of the certificate');
  assert.match(text, /Certificate of Completion/);
  assert.match(text, new RegExp(`Certificate of Completion · Envelope ${id}`), 'the footer line beside the stamp');
  assert.doesNotMatch(text, /e-signatures that plant trees/, 'the old line under the title is gone');
  assert.doesNotMatch(text, /GrowSigning · Certificate/, 'the stamp says the name, so the footer does not');
  assert.match(text, /Signed via GrowSigning/, 'the words under each signature stay');
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  assert.equal(doc.getProducer(), 'GrowSigning');
  assert.equal(doc.getCreator(), 'GrowSigning');
});

// ---- 2. The old name, nowhere -------------------------------------------------------------------------------------

// Built from pieces so this file does not find itself.
const OLD_NAME = new RegExp(['Sign ?(&|&amp;|and) ?Grow', 'Sign' + 'AndGrow', 'sign' + 'grow', 'Sign-and-Grow'].join('|'), 'i');
// The address is growsigning.com (the owner attached it on 2026-11-21). The one used before it is the wrong one now.
const WRONG_ADDRESS = new RegExp('grow' + 'signer\\.(com|app|io|net|org)\\b', 'i');

test('the old name and a wrong web address appear nowhere a person or a program reads them', () => {
  // The patterns find what they are for.
  for (const old of ['Sign' + '&Grow', 'Sign &amp; ' + 'Grow', 'Sign and ' + 'Grow', 'Sign' + 'AndGrow', 'sign' + 'grow-help', 'www.grow' + 'signer.com', 'https://Grow' + 'Signer.app/x']) assert.ok(OLD_NAME.test(old) || WRONG_ADDRESS.test(old), old);
  for (const fine of ['GrowSigning', 'growsigning.com', 'www.growsigning.com', 'growsigning.apps.google.test', 'sg_restored']) assert.ok(!OLD_NAME.test(fine) && !WRONG_ADDRESS.test(fine), fine);
  const found: string[] = [];
  const look = (f: string, text: string) => {
    for (const [i, line] of text.split('\n').entries()) {
      // The folder this checkout lives in keeps its name; a path to it is not the product's name.
      const l = line.replace(/\/sign-and-grow\b|sign-and-grow\//g, '');
      if (OLD_NAME.test(l) || WRONG_ADDRESS.test(l)) found.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  };
  for (const dir of ['src', 'public', 'scripts', 'tests', 'brand']) walk(dir, (f, text) => f !== 'tests/brand.test.ts' && look(f, text));
  for (const f of ['README.md', '.env.example', 'package.json', 'next.config.mjs', 'AGENTS.md']) if (fs.existsSync(path.join(root, f))) look(f, read(f));
  assert.deepEqual(found, []);
  assert.equal(JSON.parse(read('package.json')).name, 'growsigning');
});

test('what is stored under the sg_ and ts_ prefixes keeps its name, so nothing saved before the rename breaks', () => {
  // Browser storage and cookies written before the rename are still read under the same names.
  assert.match(read('src/server/auth.ts'), /SESSION_COOKIE = 'ts_session'/);
  assert.match(read('src/components/AppShell.tsx'), /sessionStorage\.getItem\('sg_restored'\)/);
  assert.match(read('src/components/AppShell.tsx'), /'sg-handed-over'/);
});

// ---- 3. How long a browser stays signed in -------------------------------------------------------------------------

test('a browser is signed out after 30 days without use or 90 days after signing in, and every page says both rules', async () => {
  const { SESSION_DAYS, SESSION_MAX_DAYS, sessionWords } = await import('../src/lib/policy.ts');
  assert.equal(SESSION_DAYS, 30);
  assert.equal(SESSION_MAX_DAYS, 90);
  const words = sessionWords();
  assert.match(words, /30 days without using GrowSigning in it, or 90 days after you signed in on it/);
  assert.match(words, /whichever comes first/);
  assert.match(read('src/app/security/page.tsx'), /title=\{`A browser is signed out after \$\{SESSION_DAYS\} days without use, or \$\{SESSION_MAX_DAYS\} days after you signed in on it/);
  assert.match(read('src/app/app/settings/SignedIn.tsx'), /\{sessionWords\(d\.days, d\.max_days\)\}/);
  const readme = read('README.md');
  assert.match(readme, /\| My phone keeps asking me to sign in\. \|[^\n]*30 days without use \(`SESSION_DAYS`\), or 90 days after it signed in/);
  assert.doesNotMatch(readme, /signed out 30 days after it signed in/);
  // What Settings is told comes from the same two numbers.
  const c = await signUp('Sid Session', 'sid.session@example.com', newIp());
  const list = (await c.get('/me/sessions')).data;
  assert.deepEqual([list.days, list.max_days], [30, 90]);
  // A copied cookie used every 20 days is alive at 80 and gone at 100: the 90 days from the sign-in hold.
  const sid = server.db.get("SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='sid.session@example.com'").id;
  const back = (days: number) => {
    const r = server.db.get('SELECT * FROM sessions WHERE id=?', sid);
    const shift = (v: string | null) => (v ? new Date(Date.parse(v) - days * 864e5).toISOString() : null);
    server.db.run('UPDATE sessions SET expires_at=?, last_used_at=?, created_at=? WHERE id=?', shift(r.expires_at), shift(r.last_used_at), shift(r.created_at), sid);
  };
  const alive: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    back(20);
    alive.push((await c.get('/envelopes')).status === 200);
  }
  assert.deepEqual(alive, [true, true, true, true, false], 'alive at 20, 40, 60 and 80 days, signed out at 100');
});

// ---- helpers ---------------------------------------------------------------------------------------------------------

function walk(dir: string, fn: (file: string, text: string) => void) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'out', 'fonts', 'pdfjs'].includes(e.name) || e.name.startsWith('.')) continue;
      walk(rel, fn);
    } else if (/\.(tsx?|mjs|js|json|css|md|txt|svg|html|example)$/.test(e.name)) fn(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
  }
}
void server;
