// Builds the growsigner logo kit.
//
//   node scripts/build-brand.mjs            Rebuilds every export from the SVG files in brand/: the PNG icons, favicon.ico,
//                                           the email logos and the social preview in public/brand/, and brand/guide.png
//                                           from brand/guide.html.
//   node scripts/build-brand.mjs --masters  First redraws the SVG files in brand/ and src/lib/brandMark.ts from the
//                                           drawing below (the nib leaf) and the Lora outlines, then rebuilds the exports.
//                                           Only needed when the drawing itself changes. It overwrites brand/*.svg, so a
//                                           file someone edited by hand in a design tool is replaced.
//
// Needs Playwright (Chromium) for the exports, and @fontsource/lora (a dependency) for --masters.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const at = (...p) => path.join(root, ...p);

// ---- Colours ---------------------------------------------------------------------------------

export const COLORS = {
  forest: '#1f6f43', // lit half of the mark, "grow"
  deep: '#134a2c', // shaded half of the mark, the icon tile, dark backgrounds
  ink: '#17241c', // "signer", text
  paper: '#f6f3ec', // the page
  lightLeaf: '#9ed88f', // the mark and "grow" on dark backgrounds
  leaf: '#6fb35f', // illustration only, never text
  yellow: '#ffd24a', // the main button only, with ink text
};
const TONES = {
  light: { lit: COLORS.forest, shade: COLORS.deep, grow: COLORS.forest, signer: COLORS.ink },
  dark: { lit: COLORS.paper, shade: COLORS.lightLeaf, grow: COLORS.lightLeaf, signer: COLORS.paper },
};

// ---- The mark --------------------------------------------------------------------------------
//
// Drawn in leaf coordinates: u runs along the leaf from the nib's point (0, 0) to the leaf's apex (LEN, 0), v across it.
// +v is the shaded half (lower right once the leaf leans at 45 degrees), -v the lit half. The outline is the concept's,
// unchanged: two mirrored pairs of cubic curves, widest at 54% of the length.

const LEN = 77.654;
const HALF = [[0, 0], [14.609, 6.972], [23.25, 19.742], [42.115, 19.742], [56.583, 19.742], [70.018, 12.275], [LEN, 0]];

// The nib: a round hole on the midrib and a tapering slit from the hole towards the point. The slit closes a little
// before the point so the point stays solid. `holeU` and `holeR` are the hole's centre (along the midrib) and radius;
// the slit closes at `start`, bends at `knee` (u and half width) and is `half` wide each side where it meets the hole.
export const NIB = {
  // The concept, unchanged. For the mark at 24 px and up, and every logo.
  regular: { holeU: 48.71, holeR: 5.4, start: 4.47, knee: [12.51, 1.054], half: 1.97 },
  // The small drawing: the hole 31% wider and the slit 57% wider, so both still show as a gap at 16 px. Used by the
  // app icon (a browser shows it at 16 px) and by MARK_SMALL. Same outline.
  small: { holeU: 48.1, holeR: 7.1, start: 3.4, knee: [11.8, 1.9], half: 3.1 },
};
const SEAM = 0.5; // the lit half runs this far under the shaded half, so no hairline of background shows between them

const SQ2 = Math.SQRT2;
const bez = (p, t) => {
  const s = 1 - t;
  return [0, 1].map((i) => s * s * s * p[0][i] + 3 * s * s * t * p[1][i] + 3 * s * t * t * p[2][i] + t * t * t * p[3][i]);
};
const flip = (pts) => pts.map(([u, v]) => [u, -v]);

// A circular arc as cubic curves (no arc commands, so every consumer, pdf-lib included, draws it the same).
function arc(cu, cv, r, a0, a1) {
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const b0 = a0 + ((a1 - a0) * i) / n, b1 = a0 + ((a1 - a0) * (i + 1)) / n;
    const k = (4 / 3) * Math.tan((b1 - b0) / 4);
    const p0 = [cu + r * Math.cos(b0), cv + r * Math.sin(b0)], p3 = [cu + r * Math.cos(b1), cv + r * Math.sin(b1)];
    out.push(['C', [p0[0] - k * r * Math.sin(b0), p0[1] + k * r * Math.cos(b0)], [p3[0] + k * r * Math.sin(b1), p3[1] - k * r * Math.cos(b1)], p3]);
  }
  return out;
}

// Returns the three contours of the mark in leaf coordinates, as lists of ['M'|'L'|'C', ...points] commands.
function markContours(nib) {
  const shadeA = [HALF[0], HALF[1], HALF[2], HALF[3]], shadeB = [HALF[3], HALF[4], HALF[5], HALF[6]];
  const litA = flip(shadeA), litB = flip(shadeB);
  const { holeU: cu, holeR: r, start: s0, knee: [ku, kh], half: hs } = nib;
  const us = cu - Math.sqrt(r * r - hs * hs); // where the slit meets the hole
  const aSlit = Math.PI - Math.asin(hs / r); // angle of that point on the shaded side
  // The point on the shaded outline near the apex where v = SEAM.
  let lo = 0.5, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (bez(shadeB, m)[1] > SEAM) lo = m; else hi = m; }
  const nearApex = bez(shadeB, (lo + hi) / 2);

  const lit = [['M', [0, 0]], ['C', litA[1], litA[2], litA[3]], ['C', litB[1], litB[2], litB[3]], ['L', nearApex],
    ['L', [cu + Math.sqrt(r * r - SEAM * SEAM), SEAM]], ...arc(cu, 0, r, Math.asin(SEAM / r), -aSlit),
    ['L', [ku, -kh]], ['L', [s0, 0]], ['L', [s0, SEAM]], ['Z']];
  const shade = [['M', [0, 0]], ['C', shadeA[1], shadeA[2], shadeA[3]], ['C', shadeB[1], shadeB[2], shadeB[3]],
    ['L', [cu + r, 0]], ...arc(cu, 0, r, 0, aSlit), ['L', [ku, kh]], ['L', [s0, 0]], ['Z']];
  // One colour: the whole leaf, and the slit with the hole as a second contour running the other way, so it is cut
  // out under the nonzero rule (pdf-lib, and SVG's default) as well as evenodd.
  const outline = [['M', [0, 0]], ['C', shadeA[1], shadeA[2], shadeA[3]], ['C', shadeB[1], shadeB[2], shadeB[3]],
    ['C', litB[2], litB[1], litB[0]], ['C', litA[2], litA[1], litA[0]], ['Z']];
  const keyhole = [['M', [s0, 0]], ['L', [ku, -kh]], ['L', [us, -hs]], ...arc(cu, 0, r, -aSlit, aSlit), ['L', [ku, kh]], ['Z']];
  return { lit, shade, mono: [...outline, ...keyhole] };
}

// ---- Paths -----------------------------------------------------------------------------------

const num = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};
const pt = ([x, y]) => `${num(x)} ${num(y)}`;
function toD(cmds, map) {
  let d = '';
  for (const [c, ...p] of cmds) d += c === 'Z' ? 'Z' : c + p.map((q) => pt(map(q))).join(' ');
  return d;
}

// Rewrites an absolute path (M, L, Q, C, Z, numbers rounded to 0.01) with relative commands and no spare characters,
// which makes the lettering about a third smaller. Offsets are taken between rounded points, so nothing drifts.
export function compact(d) {
  const toks = d.match(/[MLQCZ]|-?\d*\.?\d+/g);
  const count = { M: 1, L: 1, Q: 2, C: 3 };
  const f = (v) => {
    const s = String(Math.round(v * 100) / 100);
    return s === '-0' ? '0' : s.replace(/^(-?)0\./, '$1.');
  };
  let out = '', last = '', cx = 0, cy = 0, sx = 0, sy = 0, prev = '', i = 0;
  const put = (s) => {
    // A number needs a space before it unless it starts with '-', or starts with '.' after a number that has one.
    if (/^[\d.]/.test(s) && /[\d.]$/.test(out) && !(s[0] === '.' && /\.\d*$/.test(out))) out += ' ';
    out += s;
  };
  while (i < toks.length) {
    const c = toks[i++];
    if (c === 'Z') { out += 'z'; cx = sx; cy = sy; last = 'z'; continue; }
    const pts = [];
    for (let k = 0; k < count[c]; k++) pts.push([+toks[i++], +toks[i++]]);
    const cmd = out === '' ? 'M' : c.toLowerCase();
    if (cmd !== last || cmd === 'm' || cmd === 'M') out += cmd;
    for (const [x, y] of pts) { put(f(cmd === 'M' ? x : x - cx)); put(f(cmd === 'M' ? y : y - cy)); }
    [cx, cy] = pts[pts.length - 1];
    if (c === 'M') [sx, sy] = [cx, cy];
    last = cmd;
    prev = c;
  }
  return out;
}

// Places the mark so that its 56-unit drawing area (the leaf touches all four sides of it) is a `box` square at (x, y).
export function placeMark(x, y, box) {
  const k = box / 56;
  return ([u, v]) => [x + (k * (u + v)) / SQ2, y + k * (56 + (v - u) / SQ2)];
}
export function markPaths(x, y, box, nib = NIB.regular) {
  const m = placeMark(x, y, box), c = markContours(nib);
  return { lit: toD(c.lit, m), shade: toD(c.shade, m), mono: toD(c.mono, m) };
}

// ---- Lettering -------------------------------------------------------------------------------

let fontkit;
const fonts = {};
function font(file) {
  fontkit ??= require('@pdf-lib/fontkit');
  return (fonts[file] ??= fontkit.create(fs.readFileSync(at('node_modules/@fontsource/lora/files', file))));
}
const LORA_600 = 'lora-latin-600-normal.woff2';
const LORA_500_ITALIC = 'lora-latin-500-italic.woff2';
// Tightenings on top of Lora's own kerning, in thousandths of an em. r and o, and w and s, are the concept designer's
// and carry over unchanged (the letters around them are the same in "growsigner"). e and r is new with "signer":
// Lora sets it 7 to 8 units looser than its neighbours n-e, i-g and s-i (white area between the letters over the
// x-height), and at 200 px it shows as a gap before the last letter.
const EXTRA_KERN = { ro: -6, ws: -10, er: -8 };

// Sets `text` with its left side bearing at x0 (so the ink starts at x0) and the baseline at y. Returns one path per
// group of letters (`groups` are lengths, e.g. [4, 6] for grow + signer), plus the ink box.
export function setText(file, text, size, x0, y, groups = [text.length], kern = EXTRA_KERN) {
  const f = font(file), s = size / f.unitsPerEm, run = f.layout(text);
  let pen = 0;
  const firstBearing = run.glyphs[0].bbox.minX;
  const ds = groups.map(() => ''), box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let gi = 0, left = groups[0];
  run.glyphs.forEach((g, i) => {
    if (left === 0) left = groups[++gi];
    const ox = x0 + (pen - firstBearing) * s;
    const map = ([gx, gy]) => [ox + gx * s, y - gy * s];
    for (const c of g.path.commands) {
      const a = c.args;
      if (c.command === 'moveTo') ds[gi] += 'M' + pt(map([a[0], a[1]]));
      else if (c.command === 'lineTo') ds[gi] += 'L' + pt(map([a[0], a[1]]));
      else if (c.command === 'quadraticCurveTo') ds[gi] += 'Q' + pt(map([a[0], a[1]])) + ' ' + pt(map([a[2], a[3]]));
      else if (c.command === 'bezierCurveTo') ds[gi] += 'C' + [0, 2, 4].map((j) => pt(map([a[j], a[j + 1]]))).join(' ');
      else if (c.command === 'closePath') ds[gi] += 'Z';
    }
    const b = g.bbox;
    if (b.maxX > b.minX) {
      box.minX = Math.min(box.minX, ox + b.minX * s); box.maxX = Math.max(box.maxX, ox + b.maxX * s);
      box.minY = Math.min(box.minY, y - b.maxY * s); box.maxY = Math.max(box.maxY, y - b.minY * s);
    }
    pen += run.positions[i].xAdvance + (kern[text[i] + (text[i + 1] || '')] || 0);
    left--;
  });
  return { ds, box };
}

// ---- The lockups -----------------------------------------------------------------------------
//
// Measured from the concept: Lora SemiBold at 44 units, the mark's square 48 units, its top level with the dots of
// the i, the word's ink starting 9.24 units after the square. Every file's viewBox is the ink and nothing else, so
// a logo set 22 px tall is 22 px of logo; the clear space is kept by whoever places it (see brand/README.md).

// The word, and where it splits into its two colours: "grow" and "signer".
const WORD = 'growsigner';
const SPLIT = [4, 6];

export function buildMasters() {
  const markBox = 48, size = 44, baseline = 32.8;
  const word = setText(LORA_600, WORD, size, markBox + 9.24, baseline, SPLIT);
  const mark = markPaths(0, 0, markBox);
  const logo = { w: word.box.maxX, h: markBox, baseline, mark, grow: word.ds[0], signer: word.ds[1] };

  // Stacked: the same word under a mark twice the size, centred on the word's ink.
  const sBox = 96, sGap = 14;
  const sWord = setText(LORA_600, WORD, size, 0, 0, SPLIT);
  const wordW = sWord.box.maxX - sWord.box.minX;
  const sBase = sBox + sGap - sWord.box.minY; // minY is the top of the dots, negative
  const sw = setText(LORA_600, WORD, size, 0, sBase, SPLIT);
  const stacked = { w: wordW, h: sw.box.maxY, mark: markPaths((wordW - sBox) / 2, 0, sBox), grow: sw.ds[0], signer: sw.ds[1] };

  // The stamp: a ruled box with the mark, "Signed with" in Lora Medium Italic and the wordmark, all one colour.
  const H = 40, rule = 1.6, rad = 9, padL = 11, mBox = 22, gap1 = 8, tSize = 17, wSize = 18, base = 26.4, padR = 13;
  const sMark = markPaths(padL, (H - mBox) / 2, mBox);
  const signed = setText(LORA_500_ITALIC, 'Signed with', tSize, padL + mBox + gap1, base, undefined, {});
  const sWord2 = setText(LORA_600, WORD, wSize, signed.box.maxX + wSize * 0.3, base);
  const W = sWord2.box.maxX + padR;
  const ring = roundRect(0, 0, W, H, rad, false) + roundRect(rule, rule, W - 2 * rule, H - 2 * rule, rad - rule, true);
  const stamp = { w: W, h: H, d: ring + sMark.mono + signed.ds[0] + sWord2.ds[0] };

  // The app icon: the small drawing on a deep green rounded square, the leaf's square 50 of 64 (the concept's was 44)
  // so the leaf has more pixels at 16 px. It still clears the rounded corners by 5 units.
  const iBox = 50, icon = markPaths((64 - iBox) / 2, (64 - iBox) / 2, iBox, NIB.small);
  return { mark: markPaths(4, 4, 56), markSmall: markPaths(4, 4, 56, NIB.small), logo, stacked, stamp, icon };
}

// A rounded rectangle as one contour, clockwise on screen, or the other way round when `reverse` (for a cut-out).
function roundRect(x, y, w, h, r, reverse) {
  const k = 0.5523 * r;
  const p = [
    ['M', [x + r, y]], ['L', [x + w - r, y]], ['C', [x + w - r + k, y], [x + w, y + r - k], [x + w, y + r]],
    ['L', [x + w, y + h - r]], ['C', [x + w, y + h - r + k], [x + w - r + k, y + h], [x + w - r, y + h]],
    ['L', [x + r, y + h]], ['C', [x + r - k, y + h], [x, y + h - r + k], [x, y + h - r]],
    ['L', [x, y + r]], ['C', [x, y + r - k], [x + r - k, y], [x + r, y]], ['Z'],
  ];
  return toD(reverse ? reverseContour(p) : p, (q) => q);
}
function reverseContour(cmds) {
  // cmds: M, then L/C segments, then Z. Rebuild the same contour walking the other way.
  const segs = [];
  let cur = cmds[0][1];
  for (const [c, ...p] of cmds.slice(1)) {
    if (c === 'Z') break;
    segs.push({ c, from: cur, p });
    cur = p[p.length - 1];
  }
  const out = [['M', cur]];
  for (const s of segs.reverse()) out.push(s.c === 'L' ? ['L', s.from] : ['C', s.p[1], s.p[0], s.from]);
  out.push(['Z']);
  return out;
}

// ---- Writing the masters ---------------------------------------------------------------------

const vb = (w, h) => `0 0 ${num(w)} ${num(h)}`;
function svg(w, h, title, note, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb(w, h)}" width="${num(w)}" height="${num(h)}" role="img" aria-label="${title}">
  <title>${title}</title>
  <!-- ${note} -->
${body}
</svg>
`;
}
const pathEl = (fill, d) => `  <path fill="${fill}" d="${compact(d)}"/>`;
const LORA_NOTE = 'Lettering: Lora (Cyreal, SIL Open Font License 1.1), outlined.';

export function writeMasters() {
  const m = buildMasters();
  const out = (f, s) => fs.writeFileSync(at('brand', f), s);
  const twoTone = (p, t) => [pathEl(t.lit, p.lit), pathEl(t.shade, p.shade)].join('\n');
  const word = (l, t) => [pathEl(t.grow, l.grow), pathEl(t.signer, l.signer)].join('\n');

  out('mark.svg', svg(64, 64, WORD, 'The mark: a leaf that is also the nib of a fountain pen. Lit half, then shaded half.', twoTone(m.mark, TONES.light)));
  out('mark-mono.svg', svg(64, 64, WORD, 'The mark in one colour. It takes the CSS colour of its parent when inlined; as an image it is black.', pathEl('currentColor', m.mark.mono)));
  out('mark-small.svg', svg(64, 64, WORD, 'The mark for 16 to 23 px: the same leaf with the hole and slit opened wider, as on the app icon.', twoTone(m.markSmall, TONES.light)));
  out('logo.svg', svg(m.logo.w, m.logo.h, WORD, `For light backgrounds. ${LORA_NOTE}`, twoTone(m.logo.mark, TONES.light) + '\n' + word(m.logo, TONES.light)));
  out('logo-dark.svg', svg(m.logo.w, m.logo.h, WORD, `For dark backgrounds such as ${COLORS.deep}. ${LORA_NOTE}`, twoTone(m.logo.mark, TONES.dark) + '\n' + word(m.logo, TONES.dark)));
  out('logo-mono.svg', svg(m.logo.w, m.logo.h, WORD, `One colour (currentColor). ${LORA_NOTE}`, pathEl('currentColor', m.logo.mark.mono + m.logo.grow + m.logo.signer)));
  out('logo-stacked.svg', svg(m.stacked.w, m.stacked.h, WORD, `Mark above the word, for square spaces. For light backgrounds. ${LORA_NOTE}`, twoTone(m.stacked.mark, TONES.light) + '\n' + word(m.stacked, TONES.light)));
  out('icon.svg', svg(64, 64, WORD, 'The app icon. The nib is opened a little wider than in mark.svg so it still shows at 16 px.',
    `  <rect width="64" height="64" rx="14" fill="${COLORS.deep}"/>\n` + twoTone(m.icon, TONES.dark)));
  out('stamp.svg', svg(m.stamp.w, m.stamp.h, `Signed with ${WORD}`, `For the certificate and the foot of signed copies. One colour (currentColor). ${LORA_NOTE}`, pathEl('currentColor', m.stamp.d)));
  writeBrandMarkTs(m);
  console.log('[build-brand] SVG files and src/lib/brandMark.ts written');
}

function writeBrandMarkTs(m) {
  const q = (s) => JSON.stringify(compact(s));
  const ts = `// The growsigner logo as path data, so it can be drawn without loading a file: inline in the browser (see
// src/components/Brand.tsx) and into a PDF with pdf-lib (page.drawSvgPath). Written by scripts/build-brand.mjs --masters
// from the same drawing as brand/*.svg. Do not edit by hand: change the drawing there and run it again.
//
// Every path is in its own viewBox, y down, top left corner at 0,0, which is what drawSvgPath expects. In a PDF, x and y
// place that corner (y counts up from the bottom of the page) and scale sets the size:
//
//   import { rgb } from 'pdf-lib';
//   const s = 18 / LOGO.height; // 18 pt tall
//   const parts = [[LOGO.mark.lit, 'lit'], [LOGO.mark.shade, 'shade'], [LOGO.grow, 'grow'], [LOGO.signer, 'signer']] as const;
//   for (const [d, part] of parts) page.drawSvgPath(d, { x, y: top, scale: s, color: rgb(...rgb01(TONES.dark[part])) });
//
// Every path fills correctly under the nonzero rule (pdf-lib's) and under evenodd.

export const COLORS = ${JSON.stringify(COLORS, null, 2).replace(/"(\w+)":/g, '$1:')} as const;

/** A colour as three numbers from 0 to 1, for pdf-lib's rgb(). */
export const rgb01 = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** Which colour each part takes on a light background (paper or white) and on a dark one (deep green or ink). */
export const TONES = {
  light: { lit: COLORS.forest, shade: COLORS.deep, grow: COLORS.forest, signer: COLORS.ink },
  dark: { lit: COLORS.paper, shade: COLORS.lightLeaf, grow: COLORS.lightLeaf, signer: COLORS.paper },
} as const;

/** The mark alone, on the 64 unit icon grid (the leaf fills the middle 56). \`lit\` and \`shade\` are the two halves; \`mono\` is the whole leaf with the nib cut out. */
export const MARK = {
  viewBox: "0 0 64 64",
  width: 64,
  height: 64,
  lit: ${q(m.mark.lit)},
  shade: ${q(m.mark.shade)},
  mono: ${q(m.mark.mono)},
} as const;

/** The same leaf with the nib opened wider, as on the app icon, so the hole and slit still show. For a mark drawn smaller than 24 px. */
export const MARK_SMALL = {
  viewBox: "0 0 64 64",
  width: 64,
  height: 64,
  lit: ${q(m.markSmall.lit)},
  shade: ${q(m.markSmall.shade)},
  mono: ${q(m.markSmall.mono)},
} as const;

/** The horizontal logo: mark, then the word. "grow" and "signer" are separate so they can take two colours. */
export const LOGO = {
  viewBox: ${JSON.stringify(vb(m.logo.w, m.logo.h))},
  width: ${num(m.logo.w)},
  height: ${num(m.logo.h)},
  /** Where the word's baseline sits, from the top, in the same units: to line the logo up with text beside it. */
  baseline: ${num(m.logo.baseline)},
  mark: { lit: ${q(m.logo.mark.lit)}, shade: ${q(m.logo.mark.shade)}, mono: ${q(m.logo.mark.mono)} },
  grow: ${q(m.logo.grow)},
  signer: ${q(m.logo.signer)},
} as const;

/** "Signed with growsigner" in a ruled box, one colour, for the certificate and the foot of signed copies. */
export const STAMP = {
  viewBox: ${JSON.stringify(vb(m.stamp.w, m.stamp.h))},
  width: ${num(m.stamp.w)},
  height: ${num(m.stamp.h)},
  d: ${q(m.stamp.d)},
} as const;
`;
  fs.writeFileSync(at('src/lib/brandMark.ts'), ts);
}

// ---- Exports ---------------------------------------------------------------------------------

const OUT = at('public/brand');
const read = (f) => fs.readFileSync(at('brand', f), 'utf8');
const dataUrl = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;
const sizeOf = (s) => s.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).slice(1).map(Number);

// favicon.ico: an ICONDIR header, one 16-byte entry per image, then the PNG files as they are (allowed since Vista,
// read by every browser).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}

// The fonts and files the HTML pages ask for are served from the repository under this made-up origin, so a page
// can load them (Chromium does not load fonts from file:// pages).
const ORIGIN = 'http://brand.local';
const TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.html': 'text/html', '.css': 'text/css', '.ico': 'image/x-icon' };

async function buildExports() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('[build-brand] Playwright is not installed. Install it (npm i -g playwright, then npx playwright install chromium) and run this again.');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = async (w, h, dsf = 1) => {
    const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
    await p.route(`${ORIGIN}/**`, (r) => {
      const rel = decodeURIComponent(new URL(r.request().url()).pathname);
      if (rel === '/') return r.fulfill({ status: 200, body: '<!doctype html><title>blank</title>', contentType: 'text/html' });
      const file = path.join(root, rel);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return r.fulfill({ status: 404, body: 'not found' });
      r.fulfill({ status: 200, body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
    });
    return p;
  };
  const shoot = async (w, h, body, { transparent = true, dsf = 1 } = {}) => {
    const p = await page(w, h, dsf);
    await p.goto(`${ORIGIN}/`);
    await p.setContent(`<!doctype html><html><head><style>
      @font-face { font-family: 'Lora'; font-weight: 500; src: url('${ORIGIN}/node_modules/@fontsource/lora/files/lora-latin-500-normal.woff2') format('woff2'); }
      html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; background: transparent; }
      img { display: block; }
    </style></head><body>${body}</body></html>`, { waitUntil: 'load' });
    await p.evaluate(() => document.fonts.ready);
    const png = await p.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
    await p.close();
    return png;
  };
  const save = (f, buf) => { fs.writeFileSync(path.join(OUT, f), buf); console.log(`[build-brand] public/brand/${f}  ${buf.length} bytes`); };

  const icon = dataUrl(read('icon.svg'));
  const img = (src, w, h, style = '') => `<img src="${src}" width="${w}" height="${h}" style="${style}">`;

  // Browser and home screen icons: the rounded tile on transparency.
  const tiles = {};
  for (const s of [16, 32, 48, 192, 512]) {
    tiles[s] = await shoot(s, s, img(icon, s, s));
    save(`icon-${s}.png`, tiles[s]);
  }
  save('favicon.ico', ico([16, 32, 48].map((size) => ({ size, png: tiles[size] }))));
  // Apple rounds the corners itself and wants no transparency: the tile's own green fills the square.
  save('apple-touch-icon.png', await shoot(180, 180, `<div style="width:180px;height:180px;background:${COLORS.deep}">${img(icon, 180, 180)}</div>`, { transparent: false }));
  // Maskable (Android): the launcher may crop to a circle 80% as wide as the image. The tile is drawn 360 of 512, which
  // keeps the point of the nib, the leaf's farthest point from the centre, 199 px out: inside that 205 px circle.
  save('icon-maskable-512.png', await shoot(512, 512, `<div style="width:512px;height:512px;background:${COLORS.deep};display:grid;place-items:center">${img(icon, 360, 360)}</div>`, { transparent: false }));

  // Email headers: the horizontal logo 22 px tall, drawn at 2x.
  const [lw, lh] = sizeOf(read('logo.svg'));
  const ew = Math.round((44 * lw) / lh);
  save('email-logo.png', await shoot(ew, 44, img(dataUrl(read('logo.svg')), ew, 44)));
  save('email-logo-dark.png', await shoot(ew, 44, img(dataUrl(read('logo-dark.svg')), ew, 44)));

  // Social preview: quiet, on paper.
  const ow = 520, oh = Math.round((ow * lh) / lw);
  save('og-image.png', await shoot(1200, 630, `<div style="width:1200px;height:630px;background:${COLORS.paper};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:44px">
    ${img(dataUrl(read('logo.svg')), ow, oh, 'margin-top:-10px')}
    <div style="font:500 40px/1.2 Lora, Georgia, serif;color:#45524a;letter-spacing:-0.005em">Sign on screen. Every dollar plants mangroves.</div>
  </div>`, { transparent: false }));

  // The guide.
  const gp = await page(1600, 1000, 2);
  await gp.goto(`${ORIGIN}/brand/guide.html`, { waitUntil: 'load' });
  await gp.evaluate(() => Promise.all([document.fonts.ready, window.__ready]));
  const guide = await gp.screenshot({ fullPage: true });
  fs.writeFileSync(at('brand', 'guide.png'), guide);
  console.log(`[build-brand] brand/guide.png  ${guide.length} bytes`);
  await browser.close();

  // Copies that Next serves from src/app by its file conventions (brand/README.md, "Wiring it in"). Refreshed only
  // when they are already there: this script never wires anything into the app by itself.
  for (const [from, to] of [['brand/icon.svg', 'src/app/icon.svg'], ['public/brand/favicon.ico', 'src/app/favicon.ico'],
    ['public/brand/apple-touch-icon.png', 'src/app/apple-icon.png'], ['public/brand/og-image.png', 'src/app/opengraph-image.png']]) {
    if (fs.existsSync(at(to))) { fs.copyFileSync(at(from), at(to)); console.log(`[build-brand] ${to} refreshed`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--masters')) writeMasters();
  await buildExports();
}
