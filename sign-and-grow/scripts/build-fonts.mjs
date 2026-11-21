// Makes the fonts the signed PDF needs for scripts DejaVu Sans cannot print: Chinese, Japanese, Korean, Thai,
// Devanagari (Hindi, Marathi, Nepali) and Khmer. The sources are Noto fonts from the @fontsource packages (SIL Open
// Font License 1.1). They ship as web fonts, which the PDF library cannot embed as they are, so each one is turned
// into a plain TrueType file here, once, when packages are installed:
//
//   - Thai, Devanagari and Khmer come as WOFF files: the same tables, compressed. They are unpacked unchanged, so
//     the rules for joining letters and placing marks stay in the font.
//   - Chinese, Japanese and Korean come as about a hundred small WOFF2 files per language, each holding the
//     characters that tend to be used together, and as "variable" fonts whose built-in weight is Thin. Each file is
//     written out again at the Regular weight. A signed PDF then embeds only the few small files its text needs.
//
// Everything lands in assets/fonts/noto with an index of which file prints which character. If a package is not
// installed, or a file cannot be converted, that font is simply left out: src/server/pdftext.ts then treats its
// characters as ones the PDF cannot print, and the sender and the signer are told before anything is signed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
const i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
function checksum(b) {
  const p = pad4(b);
  let sum = 0;
  for (let i = 0; i < p.length; i += 4) sum = (sum + p.readUInt32BE(i)) >>> 0;
  return sum;
}

// Puts tables together as one TrueType file, with the checksums a strict reader looks at.
export function sfnt(tables, flavor = 0x00010000) {
  const tags = [...tables.keys()].sort();
  const head = Buffer.from(tables.get('head'));
  head.writeUInt32BE(0, 8);
  tables.set('head', head);
  const n = tags.length;
  const pow = 2 ** Math.floor(Math.log2(n));
  const header = Buffer.concat([u32(flavor), u16(n), u16(pow * 16), u16(Math.log2(pow)), u16(n * 16 - pow * 16)]);
  let offset = 12 + n * 16;
  const records = [], bodies = [];
  let headAt = 0;
  for (const tag of tags) {
    const data = tables.get(tag);
    if (tag === 'head') headAt = offset;
    records.push(Buffer.concat([Buffer.from(tag.padEnd(4, ' '), 'latin1'), u32(checksum(data)), u32(offset), u32(data.length)]));
    bodies.push(pad4(data));
    offset += pad4(data).length;
  }
  const out = Buffer.concat([header, ...records, ...bodies]);
  out.writeUInt32BE((0xb1b0afba - checksum(out)) >>> 0, headAt + 8);
  return out;
}

// A WOFF file is a TrueType file with each table compressed on its own.
export function woffToTtf(buf) {
  if (buf.toString('latin1', 0, 4) !== 'wOFF') throw new Error('not a WOFF file');
  const n = buf.readUInt16BE(12);
  const tables = new Map();
  for (let i = 0; i < n; i++) {
    const at = 44 + i * 20;
    const tag = buf.toString('latin1', at, at + 4);
    const offset = buf.readUInt32BE(at + 4), comp = buf.readUInt32BE(at + 8), orig = buf.readUInt32BE(at + 12);
    const raw = buf.subarray(offset, offset + comp);
    tables.set(tag, comp < orig ? zlib.inflateSync(raw) : Buffer.from(raw));
  }
  return sfnt(tables, buf.readUInt32BE(4));
}

// One glyph in the TrueType format, from its points. No hinting instructions: a PDF does not need them.
function encodeGlyph(points) {
  if (!points.length) return { data: Buffer.alloc(0), xMin: 0 };
  const xs = points.map((p) => Math.round(p.x)), ys = points.map((p) => Math.round(p.y));
  const ends = [];
  points.forEach((p, i) => p.endContour && ends.push(i));
  if (ends[ends.length - 1] !== points.length - 1) ends.push(points.length - 1);
  const flags = [], xb = [], yb = [];
  const delta = (d, short, same, bytes) => {
    if (d === 0) return same;
    if (Math.abs(d) < 256) return (bytes.push(Buffer.from([Math.abs(d)])), short | (d > 0 ? same : 0));
    return (bytes.push(i16(d)), 0);
  };
  for (let i = 0; i < points.length; i++) {
    let f = points[i].onCurve ? 1 : 0;
    f |= delta(xs[i] - (i ? xs[i - 1] : 0), 2, 16, xb);
    f |= delta(ys[i] - (i ? ys[i - 1] : 0), 4, 32, yb);
    flags.push(f);
  }
  const xMin = Math.min(...xs);
  const data = Buffer.concat([i16(ends.length), i16(xMin), i16(Math.min(...ys)), i16(Math.max(...xs)), i16(Math.max(...ys)),
    ...ends.map(u16), u16(0), Buffer.from(flags), ...xb, ...yb]);
  return { data: pad4(data), xMin };
}

// One WOFF2 file of a variable font, written out as an ordinary TrueType font at one weight. The outlines are moved
// to that weight by the font library's own variation code. Tables that only matter to a variable font are left out.
export function instance(fontkit, buf, weight = 400) {
  const first = fontkit.create(buf);
  if (!first.fvar || !first.directory.tables.glyf) throw new Error('not a variable TrueType font');
  const font = new first.constructor(new first.stream.constructor(buf), first.fvar.axis.map((a) => (a.axisTag.trim() === 'wght' ? weight : a.defaultValue)));
  const proc = font._variationProcessor;
  const n = font.numGlyphs;
  const glyf = [], loca = [u32(0)], hmtx = [];
  let at = 0;
  for (let id = 0; id < n; id++) {
    const g = font.getGlyph(id);
    const d = g._decode();
    if (d && d.numberOfContours < 0) throw new Error('a glyph built from other glyphs, which this converter does not handle');
    let points = d && d.points ? d.points.map((p) => p.copy()) : [];
    if (points.length) {
      const all = points.concat(g._getPhantomPoints(d));
      proc.transformPoints(id, all);
      points = all.slice(0, points.length);
    }
    const enc = encodeGlyph(points);
    glyf.push(enc.data);
    at += enc.data.length;
    loca.push(u32(at));
    hmtx.push(u16(Math.round(g.advanceWidth)), i16(enc.xMin));
  }
  const raw = (tag) => {
    const t = font.directory.tables[tag];
    if (!t) return null;
    const s = font._getTableStream(tag);
    return Buffer.from(s.buffer.subarray(s.pos, s.pos + t.length));
  };
  const tables = new Map();
  for (const tag of ['OS/2', 'cmap', 'head', 'hhea', 'maxp', 'name', 'post']) {
    const t = raw(tag);
    if (!t) throw new Error(`no ${tag} table`);
    tables.set(tag, t);
  }
  if (tables.get('head').readUInt32BE(12) !== 0x5f0f3cf5) throw new Error('the head table did not come out right');
  tables.get('head').writeInt16BE(1, 50); // long offsets in loca
  tables.get('hhea').writeUInt16BE(n, 34); // one advance width for every glyph
  tables.get('OS/2').writeUInt16BE(weight, 4);
  tables.set('glyf', Buffer.concat(glyf));
  tables.set('loca', Buffer.concat(loca));
  tables.set('hmtx', Buffer.concat(hmtx));
  return { ttf: sfnt(tables), chars: first.characterSet };
}

// Which packages become which fonts. `family` is the name src/server/pdftext.ts chooses a font by.
const WOFF = [
  { family: 'thai', pkg: '@fontsource/noto-sans-thai', file: 'noto-sans-thai-thai-400-normal.woff', name: 'NotoSansThai-Regular' },
  { family: 'deva', pkg: '@fontsource/noto-sans-devanagari', file: 'noto-sans-devanagari-devanagari-400-normal.woff', name: 'NotoSansDevanagari-Regular' },
  { family: 'khmer', pkg: '@fontsource/noto-sans-khmer', file: 'noto-sans-khmer-khmer-400-normal.woff', name: 'NotoSansKhmer-Regular' },
];
const VARIABLE = [
  { family: 'sc', pkg: '@fontsource-variable/noto-sans-sc', name: 'NotoSansSC-Regular' },
  { family: 'jp', pkg: '@fontsource-variable/noto-sans-jp', name: 'NotoSansJP-Regular' },
  { family: 'kr', pkg: '@fontsource-variable/noto-sans-kr', name: 'NotoSansKR-Regular' },
];

export function buildFonts({ modules = path.join(root, 'node_modules'), out = path.join(root, 'assets', 'fonts', 'noto'), log = console.warn } = {}) {
  const fk = require('@pdf-lib/fontkit');
  const fontkit = fk.default || fk;
  const version = (pkg) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(modules, pkg, 'package.json'), 'utf8')).version;
    } catch {
      return null;
    }
  };
  // Converting takes a few seconds, so it is only done again when a package changed.
  const stamp = JSON.stringify([2, ...[...WOFF, ...VARIABLE].map((f) => [f.pkg, version(f.pkg)])]);
  try {
    if (JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8')).stamp === stamp) return { fonts: -1, skipped: [] };
  } catch {
    /* no index yet */
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const fonts = [], skipped = [];
  const chars = (set) => String.fromCodePoint(...[...set].filter((cp) => cp > 0x20).sort((a, b) => a - b));
  for (const f of WOFF) {
    try {
      const ttf = woffToTtf(fs.readFileSync(path.join(modules, f.pkg, 'files', f.file)));
      fs.writeFileSync(path.join(out, `${f.family}.ttf`), ttf);
      fonts.push({ family: f.family, file: `${f.family}.ttf`, name: f.name, chars: chars(fontkit.create(ttf).characterSet) });
    } catch (e) {
      skipped.push(f.family);
      log(`[fonts] ${f.pkg} was not converted (${e.message}). Text in that script will be flagged as not printable.`);
    }
  }
  for (const f of VARIABLE) {
    const dir = path.join(modules, f.pkg, 'files');
    let files = [];
    try {
      // The numbered files hold the language's own characters. The ones named after a script (latin, cyrillic,
      // vietnamese) repeat what DejaVu Sans already prints.
      files = fs.readdirSync(dir).filter((x) => /-\d+-wght-normal\.woff2$/.test(x));
    } catch {
      /* not installed */
    }
    if (!files.length) {
      skipped.push(f.family);
      log(`[fonts] ${f.pkg} is not installed. Text in that script will be flagged as not printable.`);
      continue;
    }
    fs.mkdirSync(path.join(out, f.family), { recursive: true });
    for (const file of files) {
      const part = /-(\d+)-wght-normal\.woff2$/.exec(file)[1];
      try {
        const r = instance(fontkit, fs.readFileSync(path.join(dir, file)));
        fs.writeFileSync(path.join(out, f.family, `${part}.ttf`), r.ttf);
        fonts.push({ family: f.family, file: `${f.family}/${part}.ttf`, name: `${f.name}-${part}`, chars: chars(r.chars) });
      } catch (e) {
        skipped.push(`${f.family}/${part}`);
        log(`[fonts] ${f.pkg} ${file} was not converted (${e.message}). Its characters will be flagged as not printable.`);
      }
    }
  }
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ stamp, licence: 'Noto fonts, SIL Open Font License 1.1', fonts }));
  return { fonts: fonts.length, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFonts();
  console.log(r.fonts < 0 ? '[fonts] up to date' : `[fonts] ${r.fonts} font files written${r.skipped.length ? `, ${r.skipped.length} left out` : ''}`);
}
