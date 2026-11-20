// Signing on a phone: an older phone still shows the document (or says in words what to do instead), a tap is not a
// signature, Finish without signal says what happened and tries again by itself, long documents give their memory
// back and Next lands on the field, the page zooms without moving its bars, two fields of one person cannot cover
// each other, and the adopt dialog keeps its buttons on screen in landscape and at large text.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { boot, signUp, simple, samplePdf, upload, mailTo, tokenFor, Client, PNG, type Server } from './helpers.ts';
import { whyNotShown, VIEW_FAILED } from '../src/components/viewFailure.ts';
import { stackedFields, STACK_SHARE } from '../src/lib/stacked.ts';
import { CANNOT_REACH, sameFieldAgain } from '../src/components/sign/stuck.ts';
import { DRAW_SCREENS, RELEASE_SCREENS, MAX_PAGE_PIXELS, nearScreen, pixelRatio, jumpRatherThanGlide } from '../src/components/pdfMemory.ts';
import { SIGNING_BROWSERS, SIGNING_ONLINE, SIGNING_WEAK_SIGNAL, SIGNING_ZOOM, ZOOMS, CANNOT_SHOW_WAYS } from '../src/lib/mobile.ts';
import { isConnectionError, finishNotSent, saveNotSent, keepAnswers, readAnswers, dropAnswers, FINISH_RETRY_MS } from '../src/components/sign/offline.ts';
import { drawnProblem, inkLength, inkShare, pictureProblem, PEN_WIDTH, type Point } from '../src/lib/ink.ts';

let s: Server;
before(async () => {
  s = await boot();
});

let n = 0;
const ip = () => `198.51.104.${++n}`;
const root = path.join(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const signPage = () => read('src/app/sign/[token]/page.tsx');
const requireCjs = createRequire(import.meta.url);
const noDash = (text: string, where: string) => assert.ok(!/\u2014/.test(text), `no em dash in ${where}`);

// ---- A. An older phone ---------------------------------------------------------------------------------

test('the viewer the browser gets is the legacy build, and it opens a document on a phone without Promise.withResolvers', async () => {
  // The files copied to public/pdfjs are the ones every signing page loads. Find where each comes from.
  const script = read('scripts/copy-assets.mjs');
  const from = (target: string) => {
    const m = new RegExp(`cp\\(nm\\('([^']+)'\\), out\\('${target.replace(/\./g, '\\.')}'\\)\\)`).exec(script);
    assert.ok(m, `copy-assets copies ${target}`);
    return path.join(root, 'node_modules', m[1]);
  };
  const viewer = from('public/pdfjs/pdf.min.mjs'), worker = from('public/pdfjs/pdf.worker.min.mjs');
  assert.match(viewer, /legacy[\\/]build/);
  assert.match(worker, /legacy[\\/]build/);
  // iOS before 17.4 and Chrome before 119 have no Promise.withResolvers. The modern build calls it as soon as a
  // document is opened, and the signing page then drew nothing. Take it away and open a real document.
  const kept = Promise.withResolvers;
  try {
    delete (Promise as any).withResolvers;
    const m: any = await import(pathToFileURL(viewer).href);
    m.GlobalWorkerOptions.workerSrc = pathToFileURL(worker).href;
    const doc = await m.getDocument({ data: await samplePdf(2), verbosity: 0, isEvalSupported: false }).promise;
    assert.equal(doc.numPages, 2);
    const text = await (await doc.getPage(2)).getTextContent();
    assert.equal(text.items.map((i: any) => i.str).join(''), 'Agreement page 2');
    await doc.destroy();
  } finally {
    Promise.withResolvers = kept;
  }
});

test('a browser that cannot show the document is told so in words, with a way forward, never the raw error', () => {
  // What went wrong, sorted into what a person can do something about.
  assert.equal(whyNotShown(new TypeError('Promise.withResolvers is not a function'), true), 'browser');
  assert.equal(whyNotShown(new SyntaxError('Unexpected token'), false), 'browser', 'the viewer itself would not run');
  assert.equal(whyNotShown(new TypeError('Failed to fetch dynamically imported module'), false), 'offline');
  assert.equal(whyNotShown(new TypeError('Load failed'), true), 'offline', 'Safari says Load failed');
  assert.equal(whyNotShown(new Error('anything'), true, false), 'offline', 'the device says it is offline');
  assert.equal(whyNotShown(Object.assign(new Error('Unexpected server response (403)'), { name: 'UnexpectedResponseException', status: 403 }), true), 'file');
  assert.equal(whyNotShown(Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }), true), 'file');
  for (const [k, v] of Object.entries(VIEW_FAILED)) {
    assert.ok(!/is not a function|exception|undefined/i.test(v), `${k} is said in plain words`);
    noDash(v, k);
  }
  // The viewer never prints the error's own message, on any page that uses it.
  const viewer = read('src/components/PdfDoc.tsx');
  assert.ok(!/setError\(e\?\.message/.test(viewer) && !/\{error\}/.test(viewer), 'PdfDoc shows no raw error text');
  assert.match(viewer, /whyNotShown\(/);
  // The signing page puts its own notice in the place of the pages: download, another browser, ask the sender.
  // `said`: what the server answered when it refused the stored file (tests/qr-encrypt-repair.test.ts).
  assert.match(signPage(), /failed=\{\(why, retry, said\) => <NoViewer /);
  const notice = read('src/components/sign/NoViewer.tsx');
  for (const way of ['CANNOT_SHOW_WAYS[0]', 'CANNOT_SHOW_WAYS[1]', 'CANNOT_SHOW_WAYS[2]', 'SIGNING_BROWSERS', 'Download PDF', 'Copy this link', "addEventListener('online'"]) assert.ok(notice.includes(way), `the notice has ${way}`);
  assert.ok(notice.includes('You cannot sign in it'), 'it says plainly that signing cannot happen in that browser');
  assert.equal(CANNOT_SHOW_WAYS.length, 3);
  noDash(notice, 'NoViewer.tsx');
  // Next, with no pages to go to, does not promise that waiting will help.
  assert.match(signPage(), /document\.querySelector\('\.sg-noview'\) \? 'The document cannot be shown on this device, so its fields cannot be reached here\./);
});

test('/help names the browsers that can show the document, and no page promises any phone', () => {
  const help = read('src/app/help/page.tsx'), phone = read('src/app/help/phone.tsx');
  assert.match(help, /<SigningOnPhone \/>/);
  for (const w of ['SIGNING_BROWSERS', 'SIGNING_TESTED', 'OLD_IPHONES', 'CANNOT_SHOW_WAYS']) assert.ok(phone.includes(w), `/help prints ${w}`);
  assert.match(SIGNING_BROWSERS, /iOS 16\.4/);
  assert.match(SIGNING_BROWSERS, /111/);
  // The floor named is the app's own: what Next.js builds for. If that moves, the words have to move with it.
  const floor = (requireCjs('next/dist/shared/lib/modern-browserslist-target.js') as string[]).join(' ');
  assert.match(floor, /safari 16\.4/);
  assert.match(floor, /chrome 111/);
  for (const file of ['src/app/page.tsx', 'src/app/help/page.tsx', 'src/app/security/page.tsx', 'src/app/developers/page.tsx', 'README.md'])
    assert.ok(!/\bany phone/i.test(read(file)), `${file} does not promise any phone`);
  assert.match(read('src/app/page.tsx'), /SIGNING_ONLINE/);
  assert.match(SIGNING_ONLINE, /open the document and again to finish/);
});

test('the link in the email opens the signing page by itself: no account, no app, no cookie needed', async () => {
  const c = await signUp('Mo Bile', 'mo@example.com', ip());
  const e = await simple(c, 'phone@example.com');
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const mail = mailTo('phone@example.com').at(-1);
  assert.ok(mail?.link, 'the email has a signing link');
  const url = new URL(mail.link);
  assert.equal(url.origin, process.env.APP_URL, 'it goes straight to this site, not through a tracker or an app store');
  assert.equal(url.pathname, `/sign/${tokenFor(e.id, 'phone@example.com')}`);
  assert.ok(!/apps\.apple|play\.google|download the app|install/i.test(mail.html), 'the email asks for no app');
  // A browser that has never seen this site: no cookie, no login. The link alone opens the document.
  const phone = new Client();
  phone.ip = ip();
  const r = await phone.get(url.pathname);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.envelope.subject, 'Simple agreement');
  assert.equal(r.data.recipient.email, 'phone@example.com');
  assert.deepEqual(Object.keys(phone.cookies), [], 'opening the link sets no cookie');
  // The page at that address is a page of its own, not one behind the app's sign-in.
  assert.ok(fs.existsSync(path.join(root, 'src/app/sign/[token]/page.tsx')));
  assert.ok(!/AppShell|useSession|\/login/.test(signPage()), 'the signing page does not ask anyone to sign in');
});

// ---- B. A tap is not a signature -----------------------------------------------------------------------

// A pad held upright on a phone, as measured: 358 by 320 CSS pixels.
const PAD = { w: 358, h: 320 };
const line = (x0: number, y0: number, x1: number, y1: number, steps = 20): Point[] => Array.from({ length: steps + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }));
// Something shaped like a real signature: a wave across most of the box, and a stroke under it.
const wave = (x0: number, w: number, y: number, amp = 25): Point[] => Array.from({ length: 41 }, (_, i) => ({ x: x0 + (w * i) / 40, y: y + Math.sin(i / 2) * amp }));

test('a tap, a dot, a speck or a scribble over the whole box is refused in words; a real signature is not', () => {
  // The case from the research: one tap on the pad, accepted as an 18 px dot. And a few taps in a row.
  assert.match(drawnProblem([[{ x: 100, y: 100 }]], PAD, 'signature'), /^That looks like a tap, not a signature\. Draw your signature again, or choose Type\.$/);
  assert.match(drawnProblem([[{ x: 100, y: 100 }], [{ x: 140, y: 102 }], [{ x: 180, y: 99 }]], PAD, 'signature'), /looks like a tap/);
  assert.match(drawnProblem([[{ x: 100, y: 100 }, { x: 103, y: 102 }]], PAD, 'initials'), /^That looks like a tap, not your initials\./);
  // Nothing drawn at all says what it always said.
  assert.equal(drawnProblem([], PAD, 'signature'), 'Draw your signature in the box first.');
  // A short tick: too small to stand for a signature, and the message says what to do.
  assert.match(drawnProblem([line(100, 100, 130, 110)], PAD, 'signature'), /^That mark is too small to stand for your signature\. Draw it larger, across more of the box, or choose Type\.$/);
  // Long enough in total, but scribbled into a speck: refused for its size.
  const speck = Array.from({ length: 30 }, (_, i) => ({ x: 100 + (i % 2) * 20, y: 100 + (i % 3) * 3 }));
  assert.ok(inkLength([speck]) > PAD.w / 4, 'the speck has plenty of line');
  assert.match(drawnProblem([speck], PAD, 'signature'), /too small/);
  // A box coloured in, line by line.
  const fill = Array.from({ length: 130 }, (_, i) => line(4, 4 + i * 2.4, 354, 4 + i * 2.4, 2));
  assert.match(drawnProblem(fill, PAD, 'signature'), /^That fills almost the whole box\. Choose Clear and draw your signature again, or choose Type\.$/);
  // What people really draw passes: a signature across the box, a short one, an X mark made by someone who cannot
  // write, a flat scrawl, and initials of one or two letters.
  assert.equal(drawnProblem([wave(30, 280, 160), line(40, 210, 300, 205)], PAD, 'signature'), '');
  assert.equal(drawnProblem([wave(120, 110, 160, 15)], PAD, 'signature'), '');
  assert.equal(drawnProblem([line(140, 120, 200, 180), line(200, 120, 140, 180)], PAD, 'signature'), '', 'an X as a mark');
  assert.equal(drawnProblem([line(40, 160, 260, 164)], PAD, 'signature'), '', 'a flat line is a signature some people use');
  assert.equal(drawnProblem([line(170, 120, 170, 160)], PAD, 'initials'), '', 'the initial I');
  assert.equal(drawnProblem([line(150, 120, 160, 170), line(160, 170, 175, 120), line(150, 150, 170, 150)], PAD, 'initials'), '');
  // The rule follows the size of the box: on its side the pad is wider, and a signature has to be longer to match.
  assert.equal(drawnProblem([wave(100, 70, 80, 20)], PAD, 'signature'), '');
  assert.match(drawnProblem([wave(100, 70, 80, 20)], { w: 1400, h: 170 }, 'signature'), /too small/);
  for (const k of ['signature', 'initials'] as const)
    for (const m of [drawnProblem([[{ x: 1, y: 1 }]], PAD, k), drawnProblem([line(1, 1, 5, 5)], PAD, k), drawnProblem(fill, PAD, k), pictureProblem(0, k), pictureProblem(0.9, k)]) {
      assert.match(m, /choose (Draw or )?Type\.$/, 'every refusal says what to do instead');
      noDash(m, 'the ink rule');
    }
});

// A picture as a canvas gives it: four bytes for each point.
function picture(w: number, h: number, at: (x: number, y: number) => [number, number, number, number]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(at(x, y), (y * w + x) * 4);
  return px;
}

test('an uploaded picture with no ink, or nothing but ink, is refused; a photo of a signature on any paper is not', () => {
  const W = 200, H = 80;
  const sig = (x: number, y: number) => Math.abs(y - 40 - Math.sin(x / 9) * 14) < 2 && x > 20 && x < 180;
  const share = (at: (x: number, y: number) => [number, number, number, number]) => inkShare(picture(W, H, at), W, H);
  // Blank white paper, a black square, a photo of the floor: nothing that reads as a mark on paper.
  assert.equal(pictureProblem(share(() => [250, 250, 248, 255]), 'signature').slice(0, 30), 'We cannot see a signature in t');
  assert.match(pictureProblem(share(() => [8, 8, 8, 255]), 'signature'), /cannot see a signature/);
  assert.match(pictureProblem(share(() => [0, 0, 0, 0]), 'signature'), /cannot see a signature/, 'an empty transparent picture');
  // Half or more of the picture inked over.
  assert.match(pictureProblem(share((x) => (x < 140 ? [10, 10, 10, 255] : [255, 255, 255, 255])), 'signature'), /^That picture is almost all ink/);
  // Dark ink on white, on grey paper in poor light, in blue pen, and a transparent picture with only the ink.
  assert.equal(pictureProblem(share((x, y) => (sig(x, y) ? [20, 20, 30, 255] : [252, 252, 250, 255])), 'signature'), '');
  assert.equal(pictureProblem(share((x, y) => (sig(x, y) ? [40, 40, 45, 255] : [150 + (x % 7), 148, 140, 255])), 'signature'), '', 'grey paper still counts as paper');
  assert.equal(pictureProblem(share((x, y) => (sig(x, y) ? [30, 60, 170, 255] : [245, 245, 245, 255])), 'signature'), '', 'blue ink');
  assert.equal(pictureProblem(share((x, y) => (sig(x, y) ? [16, 36, 58, 255] : [0, 0, 0, 0])), 'initials'), '');
  // The pad is wired to the rule, for drawing and for uploading, and draws with the width the rule assumes.
  const pad = read('src/components/SignaturePad.tsx');
  assert.match(pad, /drawnProblem\(strokes\.current, size\.current, kind\)/);
  assert.match(pad, /pictureProblem\(inkOf\(img\), kind\)/);
  assert.match(pad, /lineWidth = PEN_WIDTH/);
  assert.equal(PEN_WIDTH, 2.6);
});

// ---- C. No signal at the moment of Finish ------------------------------------------------------------------

test('Finish that cannot reach us says that nothing was signed, keeps everything, and goes again by itself', () => {
  // A request that never got an answer, or one that only reached something in between, is a connection problem.
  assert.equal(isConnectionError(new TypeError('Failed to fetch')), true);
  assert.equal(isConnectionError(Object.assign(new Error('Bad gateway'), { status: 502 })), true);
  assert.equal(isConnectionError(Object.assign(new Error('Unavailable'), { status: 503 })), true);
  // A 503 of our own server carries its own sentence and is not a connection problem (tests/mobile-repair.test.ts).
  assert.equal(isConnectionError(Object.assign(new Error('x'), { status: 503, data: { error: 'This form cannot take your signature at the moment.' } })), false);
  for (const status of [400, 409, 410, 429, 500]) assert.equal(isConnectionError(Object.assign(new Error('x'), { status })), false, `${status} came from the server`);
  for (const online of [true, false]) {
    const said = finishNotSent(online);
    assert.match(said, /^Not sent yet\./);
    // Only said when it is known: the device was offline before sending, or the server says so (mobile-repair).
    assert.match(said, online ? /nothing is signed yet/ : /nothing was signed/);
    assert.match(said, /Your answers are safe on this page\./);
    assert.match(said, /by ourselves/);
    assert.ok(!/Failed to fetch|put it right/i.test(said), 'nothing for the signer to put right');
    noDash(said, 'finishNotSent');
    assert.match(saveNotSent(online), /^Not saved yet\..*Your answers are safe on this page/);
  }
  assert.match(finishNotSent(false), /seems to be offline/);
  assert.match(finishNotSent(true, 'Approve and send'), /choose Approve and send to try now\.$/);
  // The page: a connection problem is told apart before anything else, the review stays open with these words, and
  // it is tried again when the device says it is back (and every few seconds while it says it is online).
  const page = signPage();
  const complete = page.slice(page.indexOf('async function complete()'), page.indexOf('async function askForTime()'));
  assert.ok(complete.indexOf('isConnectionError(e)') > 0 && complete.indexOf('isConnectionError(e)') < complete.indexOf("e?.code === 'changed'"));
  assert.match(complete, /const say = \(said: string\) => \(open === 'review' \? setFinishError\(said\) : toast\(said, true\)\)/);
  // Nothing is shown as signed before the server said so: the done screen follows a successful request, or the
  // server's own word that this person's part is done (tests/mobile-repair.test.ts).
  assert.ok(complete.indexOf('const landed') < complete.indexOf('await api(`${base}/complete`'));
  assert.ok(!/Go back, put it right[^']*'\);\s*$/m.test(complete.split('isConnectionError(e)')[0]));
  assert.match(page, /window\.addEventListener\('online', again\)/);
  assert.match(page, /setInterval\(\(\) => navigator\.onLine !== false && again\(\), FINISH_RETRY_MS\)/);
  assert.ok(FINISH_RETRY_MS >= 5000 && FINISH_RETRY_MS <= 30000);
  // The save warning is said once, not from inside a state update that React may run twice.
  assert.ok(!/setSave\(\(s\) => \{\s*if \(s !== 'error'\) toast/.test(page), 'no toast inside a state update');
  assert.match(page, /if \(!warnedSave\.current && !document\.documentElement\.classList\.contains\('sg-locked'\)\) \{\s+toast\(isConnectionError\(e\) \? saveNotSent/);
  // Saving is tried again at once when the device says it is back online.
  assert.match(page, /const back = \(\) => flush\(\);\s+window\.addEventListener\('online', back\)/);
});

test('answers typed without signal survive a reload, for the same person only, and are cleared once saved or finished', () => {
  const box = new Map<string, string>();
  const store = { getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, v: string) => void box.set(k, v), removeItem: (k: string) => void box.delete(k) };
  keepAnswers('tok1', 'Pat Phone', { f1: '120 seedlings', f2: '1', gone: 'x' }, store);
  assert.deepEqual(readAnswers('tok1', 'Pat Phone', ['f1', 'f2', 'f3'], store), { f1: '120 seedlings', f2: '1' }, 'only fields that still exist');
  assert.equal(readAnswers('tok1', 'Someone Else', ['f1'], store), null, 'the sender put another person on the request: nothing comes back');
  assert.equal(readAnswers('tok2', 'Pat Phone', ['f1'], store), null, 'another link has its own');
  assert.equal(readAnswers('tok1', 'Pat Phone', ['f9'], store), null);
  dropAnswers('tok1', store);
  assert.equal(readAnswers('tok1', 'Pat Phone', ['f1'], store), null);
  box.set('sg:answers:tok3', '{broken');
  assert.equal(readAnswers('tok3', 'Pat Phone', ['f1'], store), null, 'a damaged entry is ignored');
  // A store that throws (private mode, full) never breaks the page.
  const angry = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
  keepAnswers('t', 'P', { a: 'b' }, angry);
  assert.equal(readAnswers('t', 'P', ['a'], angry), null);
  dropAnswers('t', angry);
  // The page keeps what has not reached the server, gives it back after a reload, and clears it when it is done.
  const page = signPage();
  assert.match(page, /valuesJson !== lastSaved\.current \? keepAnswers\(token, data\?\.recipient\?\.name, values\) : dropAnswers\(token\)/);
  assert.match(page, /readAnswers\(token, d\.recipient\?\.name, Object\.keys\(server\)\)/);
  assert.match(page, /if \(stage === 'done' \|\| stage === 'closed' \|\| stage === 'handed'\) dropAnswers\(token\)/);
});

test('a Finish sent again after its answer was lost signs once, uses one signature, and the page knows it is done', async () => {
  const c = await signUp('Re Try', 'retry@example.com', ip());
  const e = await simple(c, 'again@example.com');
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = tokenFor(e.id, 'again@example.com');
  const phone = new Client();
  phone.ip = ip();
  await phone.post(`/sign/${tok}/consent`);
  const v = (await phone.get(`/sign/${tok}`)).data;
  const body = { values: { [v.fields[0].id]: '1' }, signature_png: PNG, version: v.version };
  const used = () => s.db.get("SELECT COUNT(*) n FROM recipients WHERE envelope_id=? AND status='completed'", e.id).n;
  const first = await phone.post(`/sign/${tok}/complete`, body);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  // The answer never reached the phone, so it sends Finish again by itself.
  const again = await phone.post(`/sign/${tok}/complete`, body);
  assert.equal(again.status, 409);
  assert.match(again.data.error, /already finished/, 'the words the page reads to show the done screen instead of an error');
  assert.equal(used(), 1);
  assert.equal((await phone.get(`/sign/${tok}`)).data.recipient.status, 'completed');
  // The page reads that answer as "it went through after all", by its code, and no longer as a red toast
  // (changed in tests/mobile-repair.test.ts after a skeptic saw the toast over the done screen).
  assert.equal(again.data.code, 'already_finished');
  assert.match(signPage(), /if \(isAlreadyFinished\(e\)\) \{/);
});

test('the landing page, the in-person notice and /help say that signing needs a connection to open and to finish', () => {
  const page = signPage();
  assert.equal(page.match(/In-person signing[^\n]*now\. \{SIGNING_ONLINE\}<\/div>/g)?.length, 2, 'both in-person notices');
  assert.match(read('src/app/page.tsx'), /\$\{SIGNING_ONLINE\}/);
  const help = read('src/app/help/phone.tsx');
  assert.match(help, /\{SIGNING_ONLINE\} \{SIGNING_WEAK_SIGNAL\}/);
  assert.match(SIGNING_WEAK_SIGNAL, /Nothing counts as signed until the page says you are done\./);
  noDash(SIGNING_WEAK_SIGNAL, 'SIGNING_WEAK_SIGNAL');
});

// ---- D. A hundred pages on a phone ---------------------------------------------------------------------------

test('pages far from view give their picture back, are drawn again when they come back, and stay within a ceiling', () => {
  // Measured with tests/out/gaps-mobile-sign/d-measure.cjs, 100 pages at 390 by 844: 277.3 MB of pictures after
  // scrolling to the end before, 19.4 MB after (43.7 MB at a pixel ratio of 3). The rule behind it:
  assert.ok(DRAW_SCREENS < RELEASE_SCREENS, 'drawn nearer than released, so a page at the edge does not flicker');
  assert.equal(RELEASE_SCREENS, 3);
  const screen = 844;
  assert.equal(nearScreen(0, 488, screen, DRAW_SCREENS), true, 'on screen');
  assert.equal(nearScreen(900, 1388, screen, DRAW_SCREENS), true, 'just below');
  assert.equal(nearScreen(2000, 2488, screen, DRAW_SCREENS), false, 'two screens down is not drawn yet');
  assert.equal(nearScreen(2000, 2488, screen, RELEASE_SCREENS), true, 'but one drawn already is kept');
  assert.equal(nearScreen(-3500, -3012, screen, RELEASE_SCREENS), false, 'far above is given back');
  assert.equal(nearScreen(3400, 3888, screen, RELEASE_SCREENS), false, 'far below is given back');
  // Sharp at the phone's own density, at most 3, and never more than the ceiling for one page.
  assert.equal(pixelRatio(366, 474, 2), 2);
  assert.equal(pixelRatio(366, 474, 3), 3);
  assert.equal(pixelRatio(366, 474, 4), 3, 'never above 3');
  assert.equal(pixelRatio(366, 474, 0), 1, 'a browser that does not say counts as 1');
  const zoomed = pixelRatio(732, 948, 3);
  assert.ok(zoomed < 3 && Math.round(732 * 948 * zoomed * zoomed) <= MAX_PAGE_PIXELS, 'a page at 200 percent stays under the ceiling');
  assert.ok(zoomed * 732 > 366 * 3 * 1.4, 'and is still drawn with more points than at 100 percent');
  // The viewer: pages start with an empty picture, give it back when far, and say so when one cannot be drawn.
  const viewer = read('src/components/PdfDoc.tsx');
  assert.ok(viewer.includes('shown as a picture`} width={0} height={0} />'), 'a page starts with an empty picture');
  assert.match(viewer, /if \(!visible\) \{[^}]*c\.width = 0;\s+c\.height = 0;/);
  assert.match(viewer, /pixelRatio\(width, /);
  assert.ok(!/Math\.min\(window\.devicePixelRatio \|\| 1, 2\)/.test(viewer), 'no fixed cap of 2 any more');
  assert.match(viewer, /This page could not be drawn\. <button[\s\S]{0,200}?>Draw it again<\/button>/);
});

test('Next jumps to a far field instead of gliding past it, and checks where it landed when scrolling stops', () => {
  assert.equal(jumpRatherThanGlide(25_000, 844), true, 'page 51 from page 1');
  assert.equal(jumpRatherThanGlide(-2000, 844), true, 'far back up');
  assert.equal(jumpRatherThanGlide(900, 844), false, 'the next field a screen away still glides');
  const parts = read('src/components/sign/parts.tsx');
  const fn = parts.slice(parts.indexOf('export function bringIntoView'));
  assert.match(fn, /go\(far \|\| prefersLessMotion\(\) \? 'auto' : 'smooth'\)/);
  assert.match(fn, /addEventListener\('scrollend', check\)/);
  assert.ok(!/750\);/.test(fn), 'no longer a fixed check in the middle of a glide');
  // Measured: one tap on Next from page 1 put the field on page 51 at 340 px from the top of an 844 px screen,
  // where before it stopped with the field above the screen.
});

// ---- E. Small print -----------------------------------------------------------------------------------------

test('the signing page offers 100, 150 and 200 percent, sharp at each, in a strip that leaves the bars alone; pinch zoom stays on', () => {
  assert.deepEqual(ZOOMS, [1, 1.5, 2]);
  const page = signPage();
  assert.match(page, /\{view === 'doc' && <ZoomControl zoom=\{zoom\} onZoom=\{setZoom\} \/>\}/, 'only in the document view, where it means something');
  assert.match(page, /<PdfDoc key=\{d\.sha256 \|\| d\.id\} url=\{docUrl\(base, d\)\} zoom=\{zoom\}/);
  assert.match(page, /className=\{`stack sg-doc sg-pan\$\{zoom > 1 \? ' zoomed' : ''\}`\}/);
  const zoom = read('src/components/sign/Zoom.tsx');
  assert.match(zoom, /role="group" aria-label="Size of the pages"/);
  assert.match(zoom, /aria-pressed=\{zoom === z\} aria-label=\{`\$\{Math\.round\(z \* 100\)\} percent`\}/);
  // Sharp: the pages are drawn again at the new width (pixelRatio, tested above), not stretched.
  assert.match(read('src/components/PdfDoc.tsx'), /const width = Math\.round\(Math\.min\(maxWidth, avail \|\| maxWidth\) \* zoom\);/);
  // The strip scrolls sideways by itself, so the page never gets wider than the phone and the bars stay put.
  const css = read('src/app/styles/signphone.css');
  assert.match(css, /\.sg-pan\.zoomed \{ overflow-x: auto;/);
  // Next slides the strip to a field at the edge of a zoomed page.
  assert.match(read('src/components/sign/parts.tsx'), /el\.closest\('\.sg-pan'\)/);
  // Pinch zoom: the viewport sets no ceiling, and nothing on the document view switches touch gestures off. The pad
  // you draw on does, and has to; so do the sender's fields while they are dragged in the editor.
  const layout = read('src/app/layout.tsx');
  assert.ok(!/maximumScale|userScalable|maximum-scale|user-scalable/.test(layout));
  for (const file of ['src/app/styles/sign.css', 'src/app/styles/signphone.css'])
    assert.ok(!/touch-action:\s*none/.test(read(file)), `${file} does not stop pinching`);
  assert.deepEqual(read('src/app/globals.css').match(/^[^\n{]*\{[^}]*touch-action:\s*none/gm)?.map((r) => r.split('{')[0].trim()), ['.field.edit', '.field .grip', '.sigpad']);
  assert.match(SIGNING_ZOOM, /Pinching to zoom works too\./);
  assert.match(read('src/app/help/phone.tsx'), /\{SIGNING_ZOOM\}/);
});

// ---- F. Two fields of one person on top of each other -------------------------------------------------------

const box = (o: any) => ({ document_id: 'd1', page: 0, type: 'signature', x: 0.1, y: 0.5, w: 0.3, h: 0.06, ...o });
const people = [{ id: 'r1', name: 'Pat Phone' }, { id: 'r2', name: 'Sam Other' }];
const oneDoc = [{ id: 'd1', name: 'Agreement' }];

test('two fields of the same person that cover each other are named; anything a finger can still reach is not', () => {
  // The case from the research: two required signatures in the same spot, sent, and the signer stuck at 1 of 2 left.
  assert.deepEqual(stackedFields([box({ recipient_id: 'r1' }), box({ recipient_id: 'r1', x: 0.12 })], people, oneDoc),
    ['Two fields for Pat Phone sit on top of each other on page 1, so one of them cannot be tapped. Move or remove one.']);
  // A tick box inside a text field is drawn on top of it, so both can be tapped (tests/mobile-repair.test.ts). A field
  // under one the sender filled in for them, the same size and in the same spot, cannot.
  assert.equal(stackedFields([box({ recipient_id: 'r1', type: 'text', w: 0.4, h: 0.04 }), box({ recipient_id: 'r1', type: 'checkbox', x: 0.2, y: 0.505, w: 0.02, h: 0.02 })], people, oneDoc).length, 0);
  assert.equal(stackedFields([box({ recipient_id: 'r1', type: 'text' }), box({ recipient_id: 'r1', type: 'text', readonly: 1 })], people, oneDoc).length, 1);
  // Not stacked: two people in the same spot (each sees only their own), another page, a slight touch, two fields
  // filled in for the signer, and the sender's own notes.
  assert.deepEqual(stackedFields([box({ recipient_id: 'r1' }), box({ recipient_id: 'r2' })], people, oneDoc), []);
  assert.deepEqual(stackedFields([box({ recipient_id: 'r1' }), box({ recipient_id: 'r1', page: 1 })], people, oneDoc), []);
  assert.deepEqual(stackedFields([box({ recipient_id: 'r1' }), box({ recipient_id: 'r1', x: 0.25 })], people, oneDoc), [], 'half covered: both can be tapped');
  assert.deepEqual(stackedFields([box({ recipient_id: 'r1', type: 'date_signed' }), box({ recipient_id: 'r1', type: 'full_name' })], people, oneDoc), []);
  assert.deepEqual(stackedFields([box({ recipient_id: 'r1' }), box({ recipient_id: null, type: 'note' }), box({ recipient_id: 'r1', type: 'note' })], people, oneDoc), []);
  // Said once per person and page however many overlap, with the document named when there are several, and a role
  // name for a template's open recipient.
  const three = [box({ recipient_id: 'r1' }), box({ recipient_id: 'r1' }), box({ recipient_id: 'r1', document_id: 'd2', page: 3 }), box({ recipient_id: 'r1', document_id: 'd2', page: 3 })];
  assert.deepEqual(stackedFields(three, [{ id: 'r1', name: '', role_name: 'Client' }], [...oneDoc, { id: 'd2', name: 'Schedule B' }]), [
    'Two fields for Client sit on top of each other on page 1 of Agreement, so one of them cannot be tapped. Move or remove one.',
    'Two fields for Client sit on top of each other on page 4 of Schedule B, so one of them cannot be tapped. Move or remove one.',
  ]);
  assert.equal(STACK_SHARE, 0.6);
  // The editor lists it with the other problems of the review step, which keeps Send switched off.
  const editor = read('src/components/Editor.tsx');
  assert.match(editor, /p\.push\(\.\.\.stackedFields\(fields\.value, rcps, docs\)\);\s+return \[\.\.\.new Set\(p\)\];/);
  // Next coming back to the same empty field points to Text view, from the second time.
  const again = sameFieldAgain();
  assert.deepEqual([again('a'), again('a'), again('a'), again('b'), again('a')], [false, true, true, false, false]);
  assert.match(CANNOT_REACH, /Text view/);
  assert.match(signPage(), /nextAgain\(nextField\.id\) && view === 'doc' && toast\(CANNOT_REACH\)/);
});

test('the server refuses to send or correct into stacked fields, and nothing goes out', async () => {
  const c = await signUp('Stack Sender', 'stack@example.com', ip());
  const file = await upload(c, 2);
  const body = {
    subject: 'Stacked', documents: [{ id: 'd1', file_id: file.id, name: 'Agreement' }],
    recipients: [{ id: 'r1', role: 'signer', name: 'Pat Phone', email: 'stacked@example.com' }],
    fields: [box({ id: 'a', recipient_id: 'r1' }), box({ id: 'b', recipient_id: 'r1', x: 0.11, y: 0.505 })],
  };
  const made = await c.post('/envelopes', body);
  assert.equal(made.status, 200, 'a draft may hold it while the sender works');
  const sent = await c.post(`/envelopes/${made.data.envelope.id}/send`);
  assert.equal(sent.status, 400);
  assert.equal(sent.data.error, 'Two fields for Pat Phone sit on top of each other on page 1, so one of them cannot be tapped. Move or remove one.');
  assert.equal((await c.get(`/envelopes/${made.data.envelope.id}`)).data.envelope.status, 'draft');
  assert.equal(mailTo('stacked@example.com').length, 0, 'nobody was emailed');
  // Moved apart, it sends. Then a correction that stacks them again is refused, and the envelope stays as it was.
  const e = (await c.get(`/envelopes/${made.data.envelope.id}`)).data.envelope;
  const fixed = { ...body, documents: e.documents, recipients: e.recipients, fields: e.fields.map((f: any, i: number) => ({ ...f, y: 0.3 + i * 0.2 })) };
  assert.equal((await c.put(`/envelopes/${e.id}`, fixed)).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const out = (await c.get(`/envelopes/${e.id}`)).data.envelope;
  const again = await c.put(`/envelopes/${e.id}`, { subject: out.subject, documents: out.documents, recipients: out.recipients, fields: out.fields.map((f: any) => ({ ...f, y: 0.5 })) });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /^Two fields for Pat Phone sit on top of each other on page 1/);
  assert.deepEqual((await c.get(`/envelopes/${e.id}`)).data.envelope.fields.map((f: any) => f.y).sort(), [0.3, 0.5]);
});

// ---- G. The adopt dialog on its side, at large text and at 200 percent --------------------------------------

test('the adopt dialog keeps its buttons, the sentence and any problem on screen, and narrow screens keep their bars whole', () => {
  // Measured with tests/out/gaps-mobile-sign/g-adopt.cjs after a tap on the pad: Adopt and sign, Cancel and the
  // problem all on screen without scrolling at 390x844, 844x390, 320x568 and 195x422 (a 390 px phone at 200 percent).
  const pad = read('src/components/SignaturePad.tsx');
  const foot = pad.slice(pad.indexOf('<div className="sg-adopt-foot">'), pad.indexOf('</Dialog>'));
  assert.ok(foot.includes('role="alert">{error}</div>'), 'the problem is read out, and shown next to the buttons');
  assert.ok(foot.includes('sg-siglegal') && foot.includes('Adopt and sign') && foot.includes('>Cancel</button>'));
  assert.ok(!pad.slice(0, pad.indexOf('<div className="sg-adopt-foot">')).includes('role="alert"'), 'only one place for the problem');
  const css = read('src/app/styles/signphone.css');
  assert.match(css, /\.sg-adopt-foot \{ position: sticky; bottom: calc\(-1 \* var\(--sg-dpb\)\);/);
  assert.match(css, /\.sg-adopt-foot > \.sg-siglegal \{ flex: 0 1 auto; min-height: 2\.8em; overflow-y: auto; \}/, 'the sentence gives way before the buttons');
  // The signing page at 195 px: the title on its own line, the bottom bar stacked, pictures inside their card.
  const narrow = css.slice(css.indexOf('@media (max-width: 300px)'));
  for (const rule of ['.sg-bar { flex-wrap: wrap; }', '.sg-bottom { flex-wrap: wrap;', '.sg-bottom .btn.sg-big { flex: 1 1 100%; }', 'white-space: normal;']) assert.ok(narrow.includes(rule), rule);
  assert.match(css, /\.sg-row-sig img \{ max-width: min\(240px, 100%\); \}/);
  // Decline is under Other actions in the top bar: 44 px on any touch screen, also on a phone held sideways.
  assert.match(css, /@media \(pointer: coarse\) \{\s+\.sg-bar \.btn\.sm, \.sg-bar \.btn\.go \{ min-height: 44px; \}/);
  // The new styles are loaded after the ones they extend.
  const layout = read('src/app/layout.tsx');
  assert.ok(layout.indexOf("import './styles/signphone.css';") > layout.indexOf("import './styles/sign.css';"));
  noDash(css, 'signphone.css');
});
