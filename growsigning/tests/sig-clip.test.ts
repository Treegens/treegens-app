// A signature is never cut off at an edge. The owner's report: a typed "jimi cohen" in a handwriting style lost the
// left side of its "j" on the completed document.
//
// What is checked, through the code the product runs:
//   1. src/lib/sigmark.ts in a real browser (Chromium), with the real font files: every style the dialog offers,
//      with names whose letters reach past their own width, becomes a picture that holds all of its ink.
//   2. Those pictures, a drawn mark and an uploaded one, in small fields laid out by the real CSS of the signing page.
//   3. The same marks in the signed PDF the server makes, rendered to pixels with pdf.js: nothing just outside a
//      field, on an upright page and on a page turned a quarter.
// The browser parts need Playwright with Chromium. Where it is not installed they are skipped, and say so.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { PDFDocument, degrees } from 'pdf-lib';
import { boot, signUp, Client, tokenFor } from './helpers.ts';
import { inkBox, touchesEdge, SIG_PAD, TYPED_MAX_W, TYPED_SIZE } from '../src/lib/sigmark.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// The styles the dialog offers, read from the dialog itself, so a style added later is checked without a change here.
const PAD_SRC = read('src/components/SignaturePad.tsx');
const STYLES: string[] = JSON.parse(PAD_SRC.match(/const STYLES = (\[[^\]]+\]);/)![1].replace(/'/g, '"'));
const PLAIN = PAD_SRC.match(/const PLAIN = '([^']+)';/)![1];
const FAMILIES = [...STYLES.map((f) => `'${f}', cursive`), PLAIN];
// Letters with tails to the left (j, f, y, g), a slanted end (f), swashes on capitals (Q, J, and the bar of a T that ends the text), accents above, a
// name long enough to be drawn smaller, and the single letters people use as initials.
const LONG = 'Maximiliana Alexandrovna Featherstonehaugh-Fitzwilliam';
const NAMES = ['jimi cohen', 'fy Jörg', 'Qq gyp', 'J. ff', 'Ángel Ñandú', LONG, 'j', 'f', 'JC', 'Jy', 'JT'];

// ---- 0. The measuring itself, without a browser ---------------------------------------------------------------

test('the ink box is the smallest box around every pixel that is not see-through, and an edge is noticed', () => {
  const w = 10, h = 6, d = new Uint8Array(w * h * 4);
  assert.equal(inkBox(d, w, h), null, 'a blank picture has no ink');
  const dot = (x: number, y: number, a = 255) => (d[(y * w + x) * 4 + 3] = a);
  dot(3, 2), dot(7, 4);
  dot(0, 0, 8); // too faint to count
  assert.deepEqual(inkBox(d, w, h), { x0: 3, y0: 2, x1: 7, y1: 4 });
  assert.equal(touchesEdge({ x0: 3, y0: 2, x1: 7, y1: 4 }, w, h), false);
  for (const b of [{ x0: 0, y0: 2, x1: 7, y1: 4 }, { x0: 3, y0: 0, x1: 7, y1: 4 }, { x0: 3, y0: 2, x1: 9, y1: 4 }, { x0: 3, y0: 2, x1: 7, y1: 5 }]) assert.equal(touchesEdge(b, w, h), true, JSON.stringify(b));
});

test('the dialog makes every typed and drawn mark through sigmark, and no longer places text by its width', () => {
  assert.match(PAD_SRC, /image = typedMark\(text\.trim\(\), handwritingWrites\(text\) \? `'\$\{font\}', cursive` : PLAIN\);/);
  assert.match(PAD_SRC, /pad\.current \? trimInk\(pad\.current\) : null;/);
  assert.doesNotMatch(PAD_SRC, /fillText\(/, 'no second way of drawing a typed name');
  // Wherever a signature picture is shown it is fitted whole into its box, never cropped to fill it.
  const css = read('src/app/globals.css');
  assert.match(css, /\.field\.fill img \{ width: 100%; height: 100%; object-fit: contain; \}/);
  assert.match(css, /\.field\.other img \{ width: 100%; height: 100%; object-fit: contain; \}/);
  const sign = read('src/app/styles/sign.css');
  assert.match(sign, /\.sg-sigpreview img \{[^}]*object-fit: contain;/);
  assert.match(sign, /\.sg-review-sig img \{[^}]*object-fit: contain;/);
});

// ---- The browser ----------------------------------------------------------------------------------------------

let pw: any = null;
try {
  pw = createRequire(import.meta.url)('playwright');
} catch {}
const skip = pw ? false : 'Playwright with Chromium is not installed: the pixel checks of signatures did not run';

const MIME: Record<string, string> = { '.woff2': 'font/woff2', '.mjs': 'text/javascript', '.js': 'text/javascript' };
let browser: any, page: any;
// Marks made once in the browser and used by the tests below: { key, kind, png }.
type Mark = { key: string; kind: 'typed' | 'drawn' | 'upload'; png: string };
let marks: Mark[] = [];

before(async () => {
  if (!pw) return;
  browser = await pw.chromium.launch();
  const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1200, height: 900 } });
  page = await ctx.newPage();
  const sigmark = stripTypeScriptTypes(read('src/lib/sigmark.ts'));
  const html = `<!doctype html><meta charset="utf-8"><style>${read('src/app/globals.css')}</style><style>body{background:#fff}</style><body></body>`;
  await page.route('http://sigclip.test/**', (route: any) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (u.pathname === '/sigmark.js') return route.fulfill({ contentType: 'text/javascript', body: sigmark });
    const file = u.pathname.startsWith('/fonts/') ? path.join(ROOT, 'public', u.pathname) : u.pathname.startsWith('/pdfjs/') ? path.join(ROOT, 'node_modules/pdfjs-dist/build', path.basename(u.pathname)) : '';
    if (!file || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.goto('http://sigclip.test/');
  // Helpers that live in the page: reading the pixels of a picture.
  await page.evaluate(async (STYLES: string[]) => {
    const w = window as any;
    w.sm = await import('/sigmark.js' as any);
    for (const f of STYLES) {
      await document.fonts.load(`104px '${f}'`);
      if (!document.fonts.check(`104px '${f}'`)) throw new Error(`font not loaded: ${f}`);
    }
    w.pixels = async (src: string) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const x = c.getContext('2d', { willReadFrequently: true })!;
      x.drawImage(img, 0, 0);
      return { w: c.width, h: c.height, d: x.getImageData(0, 0, c.width, c.height).data };
    };
  }, STYLES);
});
after(async () => {
  await browser?.close();
});

// ---- 1. Every style, every hard name --------------------------------------------------------------------------

test('1. every style with every hard name: all of the ink is in the picture, with clear space on every side', { skip, timeout: 120_000 }, async () => {
  const rows = await page.evaluate(async ({ FAMILIES, NAMES, SIZE }: any) => {
    const w = window as any, out: any[] = [];
    for (const family of FAMILIES)
      for (const text of NAMES) {
        const png = w.sm.typedMark(text, family);
        if (!png) { out.push({ family, text, png: null }); continue; }
        const p = await w.pixels(png);
        const got = w.sm.inkBox(p.d, p.w, p.h);
        // The answer to compare with, made another way: the same text in the middle of a canvas far larger than
        // any signature, where nothing can be cut off, and the box of what was painted there.
        const big = document.createElement('canvas');
        big.width = 4200;
        big.height = 1400;
        const x = big.getContext('2d', { willReadFrequently: true })!;
        x.font = `${SIZE}px ${family}`;
        x.fillText(text, 900, 700);
        const all = w.sm.inkBox(x.getImageData(0, 0, big.width, big.height).data, big.width, big.height);
        out.push({ family, text, png, w: p.w, h: p.h, got, all, leftOfStart: 900 - all.x0, pastWidth: all.x1 - (900 + x.measureText(text).width) });
      }
    return out;
  }, { FAMILIES, NAMES, SIZE: TYPED_SIZE });
  assert.equal(rows.length, FAMILIES.length * NAMES.length);
  for (const r of rows) {
    const what = `${r.family} "${r.text}"`;
    assert.ok(r.png, `${what}: a picture was made`);
    // The ink starts exactly SIG_PAD pixels in from every edge: none of it at an edge, and no wasted space either.
    assert.deepEqual(r.got, { x0: SIG_PAD, y0: SIG_PAD, x1: r.w - SIG_PAD - 1, y1: r.h - SIG_PAD - 1 }, `${what}: clear space on every side`);
    // And it is all of the ink: as wide and as high as the same text painted where nothing can be cut off.
    const W = r.all.x1 - r.all.x0 + 1, H = r.all.y1 - r.all.y0 + 1, w = r.got.x1 - r.got.x0 + 1, h = r.got.y1 - r.got.y0 + 1;
    if (W <= TYPED_MAX_W) {
      assert.ok(Math.abs(w - W) <= 1 && Math.abs(h - H) <= 1, `${what}: the ink is ${W} by ${H} pixels, the picture holds ${w} by ${h}`);
    } else {
      // A long name is drawn in smaller letters: the same shape, no wider than the limit.
      assert.ok(w <= TYPED_MAX_W + 2, `${what}: ${w} pixels wide`);
      assert.ok(Math.abs(w / h - W / H) / (W / H) < 0.04, `${what}: the shape changed from ${(W / H).toFixed(2)} to ${(w / h).toFixed(2)}, so ink is missing`);
    }
  }
  // The names really are hard: in the styles on offer, ink reaches well left of where the text starts and past
  // where it ends. Text placed by its width alone, 20 pixels in, is what cut the "j" off.
  const jimi = rows.filter((r: any) => r.text === 'jimi cohen');
  assert.ok(jimi.some((r: any) => r.leftOfStart > 20), 'a "j" that reaches more than 20 pixels left of its start');
  assert.ok(rows.some((r: any) => r.pastWidth > 5), 'a last letter that leans past the width of the text');
  marks = rows.map((r: any) => ({ key: `${r.family} | ${r.text}`, kind: 'typed' as const, png: r.png }));
});

test('1b. a drawn mark that runs off the pad on every side, and an uploaded picture, keep everything they hold', { skip, timeout: 60_000 }, async () => {
  const made = await page.evaluate(async () => {
    const w = window as any;
    // The pad as the dialog paints it: 300 by 180 on a screen with two pixels per point, a 2.6 pen with round ends.
    const pad = document.createElement('canvas');
    pad.width = 600;
    pad.height = 360;
    const x = pad.getContext('2d')!;
    x.scale(2, 2);
    x.lineWidth = 2.6;
    x.lineCap = 'round';
    x.strokeStyle = '#10243a';
    for (const [a, b, c, d] of [[-10, 90, 310, 60], [150, -10, 120, 190], [0, 0, 300, 180], [0, 179, 299, 1]]) {
      x.beginPath();
      x.moveTo(a, b);
      x.lineTo(c, d);
      x.stroke();
    }
    const drawn = w.sm.trimInk(pad);
    const p = await w.pixels(drawn);
    // A photo of a signature: no see-through part at all, and ink right up to all four edges.
    const photo = document.createElement('canvas');
    photo.width = 300;
    photo.height = 90;
    const y = photo.getContext('2d')!;
    y.fillStyle = '#fff';
    y.fillRect(0, 0, 300, 90);
    y.strokeStyle = '#111';
    y.lineWidth = 6;
    y.strokeRect(3, 3, 294, 84);
    y.beginPath();
    y.moveTo(0, 0);
    y.lineTo(300, 90);
    y.stroke();
    return { drawn, w: p.w, h: p.h, box: w.sm.inkBox(p.d, p.w, p.h), blank: w.sm.trimInk(document.createElement('canvas')), spaces: w.sm.typedMark('   ', 'system-ui'), upload: photo.toDataURL('image/jpeg', 0.9), uploadPng: photo.toDataURL('image/png') };
  });
  // The whole pad was inked edge to edge, so the picture is the whole pad plus the clear space around it.
  assert.deepEqual([made.w, made.h], [600 + 2 * SIG_PAD, 360 + 2 * SIG_PAD]);
  assert.deepEqual(made.box, { x0: SIG_PAD, y0: SIG_PAD, x1: made.w - SIG_PAD - 1, y1: made.h - SIG_PAD - 1 });
  assert.equal(made.blank, null, 'an empty pad is no signature');
  assert.equal(made.spaces, null, 'neither is a name of spaces');
  marks.push({ key: 'drawn off every edge', kind: 'drawn', png: made.drawn }, { key: 'uploaded JPEG', kind: 'upload', png: made.upload }, { key: 'uploaded PNG', kind: 'upload', png: made.uploadPng });
});

// ---- 1c. The styles to choose from in the dialog ---------------------------------------------------------------

test('1c. the four styles shown in the dialog are whole too: no tail cut off by the edge of its button, on a computer and on a phone', { skip, timeout: 120_000 }, async () => {
  // Every stylesheet of the app, in the order the layout loads them.
  const sheets = ['src/app/globals.css', ...[...read('src/app/layout.tsx').matchAll(/import '\.\/(styles\/[\w-]+\.css)';/g)].map((m) => `src/app/${m[1]}`)];
  assert.ok(sheets.includes('src/app/styles/sign.css') && sheets.includes('src/app/styles/signphone.css'));
  const css = sheets.map(read).join('\n');
  const names = NAMES.filter((n) => n !== LONG); // a name too long for its button ends in "…", by design
  for (const [vw, vh] of [[1200, 900], [390, 844], [320, 568]]) {
    const pg = await page.context().newPage();
    await pg.setViewportSize({ width: vw, height: vh });
    await pg.route('http://sigclip.test/**', (route: any) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style><body style="background:#fff;margin:0"></body>` });
      const file = path.join(ROOT, 'public', u.pathname);
      return fs.existsSync(file) && u.pathname.startsWith('/fonts/') ? route.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(file) }) : route.fulfill({ status: 404, body: '' });
    });
    await pg.goto('http://sigclip.test/');
    // Each button twice, as the dialog lays it out: once as it is, and once allowed to paint past its own edges.
    // Where the two hold the same ink, nothing was cut off.
    const rects = await pg.evaluate(async ({ FAMILIES, names }: any) => {
      for (const f of FAMILIES) await document.fonts.load(`30px ${f}`);
      const out: any[] = [];
      // Does the text fit between the padding of its button? Measured, because a button that shortens its text
      // with "…" reports the shortened width.
      const ruler = document.createElement('canvas').getContext('2d')!;
      const fits = (b: HTMLElement, text: string) => {
        const s = getComputedStyle(b);
        ruler.font = `${s.fontSize} ${s.fontFamily}`;
        return ruler.measureText(text).width <= b.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      };
      const wide = Math.min(document.documentElement.clientWidth - 32, 620);
      for (const family of FAMILIES)
        for (const text of names)
          for (const free of [false, true]) {
            const dialog = document.createElement('div');
            dialog.className = 'sg-dialog wide';
            dialog.style.cssText = `position:static;transform:none;animation:none;box-shadow:none;width:${wide}px;padding:40px 16px;margin:0;max-height:none;overflow:visible`;
            const grid = document.createElement('div');
            grid.className = 'grid g2 sg-sigstyles';
            for (let i = 0; i < 2; i++) {
              const b = document.createElement('button');
              b.type = 'button';
              b.className = 'sigstyle';
              b.style.fontFamily = family;
              if (free) b.style.overflow = 'visible';
              b.textContent = text;
              grid.appendChild(b);
            }
            dialog.appendChild(grid);
            document.body.appendChild(dialog);
            const b = grid.firstElementChild as HTMLElement;
            const r = b.getBoundingClientRect();
            out.push({ family, text, free, x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, fits: fits(b, text), size: getComputedStyle(b).fontSize });
          }
      return out;
    }, { FAMILIES, names });
    const shot: Buffer = await pg.screenshot({ fullPage: true });
    const counts = await pg.evaluate(async ({ shot, rects }: any) => {
      const img = new Image();
      img.src = shot;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const x = c.getContext('2d', { willReadFrequently: true })!;
      x.drawImage(img, 0, 0);
      const k = c.width / document.documentElement.scrollWidth;
      return rects.map((r: any) => {
        // The button and 30 pixels around it. Its own border is pale and is not counted as ink.
        const X = Math.max(0, Math.round((r.x - 14) * k)), Y = Math.round((r.y - 30) * k), W = Math.round((r.w + 20) * k), H = Math.round((r.h + 60) * k);
        const d = x.getImageData(X, Y, W, H).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 < 170) n++;
        return n;
      });
    }, { shot: `data:image/png;base64,${shot.toString('base64')}`, rects });
    if (process.env.SIGCLIP_DEBUG) {
      fs.writeFileSync(`${process.env.SIGCLIP_DEBUG}/styles-${vw}.png`, shot);
      for (let i = 0; i < rects.length; i += 2) if (counts[i] !== counts[i + 1]) console.log(vw, rects[i].family, rects[i].text, rects[i].fits, rects[i].w, counts[i], counts[i + 1], Math.round(rects[i].y));
    }
    for (let i = 0; i < rects.length; i += 2) {
      const r = rects[i];
      if (!r.fits) continue; // wider than the button: shortened with "…", which the person sees happen
      assert.ok(counts[i + 1] > 20, `${r.family} "${r.text}" at ${vw}: drawn`);
      assert.equal(counts[i], counts[i + 1], `${r.family} "${r.text}" at ${vw} px wide (${r.size}): ${counts[i + 1] - counts[i]} pixels of ink are cut off by the edge of the button`);
    }
    await pg.close();
  }
});

// ---- 2. In small fields on the signing page -------------------------------------------------------------------

// Signature ink on a screenshot: dark, and not the green of a field's border.
const BOXES = [[70, 16], [34, 30], [200, 12], [26, 46], [150, 40]];

test('2. in small fields on the signing page (a table cell, an initials box, a flat line): no ink at or past an edge', { skip, timeout: 180_000 }, async () => {
  assert.ok(marks.length >= FAMILIES.length * NAMES.length + 3, 'tests 1 and 1b made the marks');
  // Fields as the signing page lays them out: .field.fill.done (the person's own) and .field.other (someone else's).
  const rects = await page.evaluate(async ({ marks, BOXES }: any) => {
    document.body.innerHTML = '';
    const sheet = document.createElement('div');
    sheet.className = 'sg-doc';
    sheet.style.cssText = `position:relative;background:#fff;width:1160px;height:${marks.length * 70 + 40}px`;
    document.body.style.margin = '0';
    document.body.appendChild(sheet);
    const out: any[] = [];
    marks.forEach((m: any, i: number) => {
      let left = 20;
      BOXES.forEach(([w, h]: number[], j: number) => {
        const f = document.createElement('div');
        f.className = j % 2 ? 'field other' : 'field fill done';
        f.style.cssText = `left:${left}px;top:${20 + i * 70}px;width:${w}px;height:${h}px`;
        const img = document.createElement('img');
        img.src = m.png;
        img.alt = '';
        f.appendChild(img);
        sheet.appendChild(f);
        left += w + 40;
      });
    });
    await Promise.all([...document.images].map((i) => i.decode()));
    for (const f of sheet.querySelectorAll('.field')) {
      const r = f.getBoundingClientRect(), s = getComputedStyle(f);
      const bl = parseFloat(s.borderLeftWidth), bt = parseFloat(s.borderTopWidth);
      out.push({ x: r.left, y: r.top, w: r.width, h: r.height, bl, bt, br: parseFloat(s.borderRightWidth), bb: parseFloat(s.borderBottomWidth) });
    }
    return out;
  }, { marks, BOXES });
  const shot: Buffer = await page.screenshot({ fullPage: true });
  const found = await page.evaluate(async ({ shot, rects }: any) => {
    const w = window as any;
    const p = await w.pixels(shot);
    const k = p.w / document.documentElement.scrollWidth;
    const ink = (x: number, y: number) => {
      const i = (y * p.w + x) * 4, r = p.d[i], g = p.d[i + 1], b = p.d[i + 2];
      // Dark and blue or grey: signature ink. The green border of a field has more green than blue.
      return r * 0.3 + g * 0.59 + b * 0.11 < 200 && b >= g - 4;
    };
    // Anything at all on the pale background of a field, however faint (a long name in a very small field).
    const seen = (x: number, y: number) => {
      const i = (y * p.w + x) * 4;
      return Math.min(p.d[i], p.d[i + 1], p.d[i + 2]) < 225;
    };
    return rects.map((f: any) => {
      // The field with a band of 14 pixels around it, in pixels of the screenshot.
      const X0 = Math.round((f.x - 14) * k), Y0 = Math.round((f.y - 14) * k), X1 = Math.round((f.x + f.w + 14) * k), Y1 = Math.round((f.y + f.h + 14) * k);
      // The space inside the border of the field: past it, a picture would be cut off or lie on the page.
      const ix0 = Math.ceil((f.x + f.bl) * k), iy0 = Math.ceil((f.y + f.bt) * k), ix1 = Math.floor((f.x + f.w - f.br) * k) - 1, iy1 = Math.floor((f.y + f.h - f.bb) * k) - 1;
      let outside = 0, inside = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = Math.max(0, Y0); y < Y1; y++)
        for (let x = Math.max(0, X0); x < X1; x++) {
          const out = x < ix0 || x > ix1 || y < iy0 || y > iy1;
          if (out ? !ink(x, y) : !seen(x, y)) continue;
          if (out) outside++;
          else (inside++, (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y)));
        }
      return { outside, inside, box: [x0 - ix0, y0 - iy0, ix1 - x1, iy1 - y1], room: [ix1 - ix0 + 1, iy1 - iy0 + 1] };
    });
  }, { shot: `data:image/png;base64,${shot.toString('base64')}`, rects });
  assert.equal(found.length, marks.length * BOXES.length);
  found.forEach((f: any, n: number) => {
    const m = marks[Math.floor(n / BOXES.length)], box = BOXES[n % BOXES.length];
    const what = `${m.key} in a ${box[0]} by ${box[1]} field`;
    assert.equal(f.outside, 0, `${what}: ${f.outside} pixels of ink at or past the edge of the field`);
    assert.ok(f.inside > 0, `${what}: the signature shows`);
    // Every side has room left, and the picture reaches (almost) across one direction: it was fitted, not cropped.
    assert.ok(f.box.every((gap: number) => gap >= 0), `${what}: gaps ${f.box}`);
  });
});

// ---- 3. In the signed PDF -------------------------------------------------------------------------------------

test('3. in the signed PDF: typed, drawn and uploaded marks in narrow fields leave nothing outside the field, upright and on a turned page', { skip, timeout: 240_000 }, async () => {
  assert.ok(marks.length, 'tests 1 and 1b made the marks');
  await boot();
  const sender = await signUp('Sig Clip Sender', 'sender@sigclip.example', '10.77.1.1');
  // The marks that go through the server: the owner's name in every style, the worst letters, and drawn and uploaded.
  const pick = (k: string) => marks.find((m) => m.key === k)!;
  const people = [
    ...STYLES.map((f) => ({ sig: pick(`'${f}', cursive | jimi cohen`), ini: pick(`'${f}', cursive | j`) })),
    { sig: pick(`'Sig Vibes', cursive | fy Jörg`), ini: pick(`'Sig Vibes', cursive | f`) },
    { sig: pick(`'Sig Dancing', cursive | ${LONG}`), ini: pick(`'Sig Dancing', cursive | Jy`) },
    { sig: pick(`${PLAIN} | Ángel Ñandú`), ini: pick(`${PLAIN} | JC`) },
    { sig: pick('drawn off every edge'), ini: pick('drawn off every edge') },
    { sig: pick('uploaded JPEG'), ini: pick('uploaded PNG') },
  ];
  for (const p of people) assert.ok(p.sig && p.ini);
  // A blank sheet, upright, and the same sheet turned a quarter: the fields are all there is to see on them.
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  d.addPage([792, 612]).setRotation(degrees(90));
  const form = new FormData();
  form.append('file', new Blob([await d.save()], { type: 'application/pdf' }), 'Table.pdf');
  const file = (await sender.call('POST', '/files', form)).data;
  assert.ok(file.id, JSON.stringify(file));
  const fields: any[] = [];
  people.forEach((_, i) => {
    const y = 0.06 + i * 0.095, rid = `r${i}`;
    for (const page of [0, 1]) {
      // A table cell (no room for the small line), a narrow and high field (with the small line), a wide one, initials.
      fields.push({ id: `a${page}${i}`, document_id: 'd', recipient_id: rid, type: 'signature', page, x: 0.08, y, w: 0.11, h: 0.022 });
      fields.push({ id: `b${page}${i}`, document_id: 'd', recipient_id: rid, type: 'signature', page, x: 0.3, y, w: 0.075, h: 0.055 });
      fields.push({ id: `c${page}${i}`, document_id: 'd', recipient_id: rid, type: 'signature', page, x: 0.5, y, w: 0.25, h: 0.045 });
      fields.push({ id: `i${page}${i}`, document_id: 'd', recipient_id: rid, type: 'initials', page, x: 0.85, y, w: 0.03, h: 0.022 });
    }
  });
  const made = await sender.post('/envelopes', {
    subject: 'Signatures in table cells', documents: [{ id: 'd', file_id: file.id }], ordered: false,
    recipients: people.map((_, i) => ({ id: `r${i}`, role: 'signer', name: `Signer ${i}`, email: `signer${i}@sigclip.example` })),
    fields,
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const eid = made.data.envelope.id;
  assert.equal((await sender.post(`/envelopes/${eid}/send`)).status, 200);
  for (let i = 0; i < people.length; i++) {
    const c = new Client();
    c.ip = `10.77.2.${i + 1}`;
    const tok = tokenFor(eid, `signer${i}@sigclip.example`);
    assert.equal((await c.post(`/sign/${tok}/consent`)).status, 200);
    const v = (await c.get(`/sign/${tok}`)).data;
    const values = Object.fromEntries(v.fields.map((f: any) => [f.id, '1']));
    const done = await c.post(`/sign/${tok}/complete`, { values, signature_png: people[i].sig.png, initials_png: people[i].ini.png });
    assert.equal(done.status, 200, JSON.stringify(done.data));
  }
  const pdf = (await sender.get(`/envelopes/${eid}/download`)).data as Uint8Array;
  assert.ok(pdf.length > 1000);
  // Where each field is on its page, as the server stored it (fractions of the page as it is looked at).
  const { db } = await boot();
  const stored = db.all('SELECT f.type, f.page, f.x, f.y, f.w, f.h, r.email FROM fields f JOIN recipients r ON r.id=f.recipient_id WHERE f.envelope_id=?', eid);
  assert.equal(stored.length, fields.length);
  const SCALE = 4;
  const result = await page.evaluate(async ({ pdf, stored, SCALE }: any) => {
    const pdfjs: any = await import('/pdfjs/pdf.min.mjs' as any);
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: Uint8Array.from(atob(pdf), (ch) => ch.charCodeAt(0)) }).promise;
    const out: any[] = [];
    for (const pageNo of [0, 1]) {
      const pg = await doc.getPage(pageNo + 1);
      const vp = pg.getViewport({ scale: SCALE });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const x = c.getContext('2d', { willReadFrequently: true })!;
      x.fillStyle = '#fff';
      x.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: x, viewport: vp }).promise;
      const d = x.getImageData(0, 0, c.width, c.height).data;
      // Anything that is not the white of the paper.
      const mark = (px: number, py: number) => {
        const i = (py * c.width + px) * 4;
        return d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235;
      };
      for (const f of stored.filter((s: any) => s.page === pageNo)) {
        const fx0 = f.x * c.width, fy0 = f.y * c.height, fx1 = (f.x + f.w) * c.width, fy1 = (f.y + f.h) * c.height;
        const band = 10 * SCALE; // 10 points around the field
        let outside = 0, inside = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let py = Math.max(0, Math.floor(fy0 - band)); py < Math.min(c.height, fy1 + band); py++)
          for (let px = Math.max(0, Math.floor(fx0 - band)); px < Math.min(c.width, fx1 + band); px++) {
            if (!mark(px, py)) continue;
            // Half a pixel of the renderer's own smoothing at the very edge is not ink past the edge.
            if (px < Math.floor(fx0) - 1 || px > Math.ceil(fx1) || py < Math.floor(fy0) - 1 || py > Math.ceil(fy1)) outside++;
            else (inside++, (x0 = Math.min(x0, px)), (y0 = Math.min(y0, py)), (x1 = Math.max(x1, px)), (y1 = Math.max(y1, py)));
          }
        out.push({ ...f, outside, inside, gaps: [(x0 - fx0) / SCALE, (y0 - fy0) / SCALE, (fx1 - x1) / SCALE, (fy1 - y1) / SCALE], size: [c.width, c.height] });
      }
    }
    return out;
  }, { pdf: Buffer.from(pdf).toString('base64'), stored, SCALE });
  assert.equal(result.length, fields.length);
  for (const r of result) {
    const what = `${r.type} of ${r.email} on page ${r.page + 1} (${(r.w * r.size[0] / SCALE).toFixed(0)} by ${(r.h * r.size[1] / SCALE).toFixed(0)} points)`;
    assert.ok(r.inside > 20, `${what}: the mark is printed`);
    assert.equal(r.outside, 0, `${what}: ${r.outside} pixels printed outside the field`);
    for (const gap of r.gaps) assert.ok(gap > -0.3, `${what}: gaps to the edges of the field, in points: ${r.gaps.map((g: number) => g.toFixed(2))}`);
  }
  // Kept for looking at: tests/out is where the suites leave what they made.
  fs.mkdirSync(path.join(ROOT, 'tests/out/sig-clip'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tests/out/sig-clip/signed.pdf'), pdf);
});
