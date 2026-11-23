// How words get onto the signed PDF: which font prints which character, in what order the pieces of a line stand
// (right-to-left scripts), and where each glyph goes (scripts whose letters join or stack).
//
// DejaVu Sans prints Latin, Greek, Cyrillic, Arabic, Hebrew, Armenian and Georgian. Chinese, Japanese, Korean, Thai,
// Devanagari and Khmer come from Noto fonts that scripts/build-fonts.mjs prepares when packages are installed, and
// only the files a document needs are embedded in it. A character that no font here can print is never left as an
// empty box: it is printed as the mark below, remembered in `missing` so the certificate can list it by its code,
// and unprintable() lets the sender and the signer be told before anything is signed. A Noto file that is absent
// or unreadable simply counts as "cannot print", so a broken install shows as warnings, not as a failed PDF.
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFFont, PDFPage, PDFName, PDFNumber, PDFHexString, PDFOperator, PDFOperatorNames as Op, CustomFontSubsetEmbedder,
  pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix, setTextRise, setFillingColor, toRadians, type Color, type Rotation } from 'pdf-lib';
import fontkitMod from '@pdf-lib/fontkit';
import { visualRuns, firstStrong, hasRtl } from './bidi.ts';
import { PRINT_MARK } from '../lib/scripts.ts';

const fontkit: any = (fontkitMod as any).default || fontkitMod;
const g = globalThis as any;

// @pdf-lib/fontkit was built to find a helper for generator functions as a global called regeneratorRuntime, and it
// ships without one. It uses it in exactly one place: finding the syllables of Devanagari, Khmer and the other
// scripts whose letters are rearranged. Without the helper a Hindi name fails the whole PDF with "regeneratorRuntime
// is not defined". This is the part of the helper that one function needs (it only yields values and stops). A real
// helper that is already there is left alone.
g.regeneratorRuntime ??= {
  mark: (fn: any) => fn,
  wrap: (step: (ctx: any) => any) => {
    const ctx = { prev: 0, next: 0, done: false, stop() { this.done = true; } };
    const it = {
      next() {
        if (ctx.done) return { value: undefined, done: true };
        const value = step(ctx);
        return ctx.done ? { value: undefined, done: true } : { value, done: false };
      },
      [Symbol.iterator]: () => it,
    };
    return it;
  },
};

// Strip control characters the PDF library cannot lay out.
const clean = (s: any) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\t/g, ' ');

type Face = { family: string; file: string; name: string; fk?: any; bytes?: Buffer; broken?: boolean };
type Registry = { dir: string; base: Face; faces: Face[]; byChar: Map<number, Face[]> };

/** Where the fonts are read from. Tests point this at a folder without the Noto files to see what happens then. */
export function fontsFrom(dir: string | null) {
  g.__sgfontdir = dir;
  g.__sgfonts = null;
}
const fontDir = (): string => g.__sgfontdir || path.join(/* turbopackIgnore: true */ process.cwd(), 'assets', 'fonts');

function registry(): Registry {
  if (g.__sgfonts) return g.__sgfonts;
  const dir = fontDir();
  const faces: Face[] = [];
  const byChar = new Map<number, Face[]>();
  try {
    for (const f of JSON.parse(fs.readFileSync(path.join(dir, 'noto', 'index.json'), 'utf8')).fonts) {
      const face: Face = { family: f.family, file: path.join('noto', f.file), name: f.name };
      faces.push(face);
      for (const ch of f.chars as string) {
        const cp = ch.codePointAt(0)!;
        const l = byChar.get(cp);
        if (l) l.push(face);
        else byChar.set(cp, [face]);
      }
    }
  } catch {
    /* no extra fonts here: their characters count as not printable */
  }
  return (g.__sgfonts = { dir, base: { family: 'base', file: 'DejaVuSans.ttf', name: 'DejaVuSans' }, faces, byChar });
}

// The font file, read and parsed once for the life of the process. Null when it is not there or cannot be read.
function load(face: Face): any | null {
  if (face.broken) return null;
  if (!face.fk) {
    try {
      face.bytes = fs.readFileSync(path.join(registry().dir, face.file));
      face.fk = fontkit.create(face.bytes);
    } catch {
      face.broken = true;
      return null;
    }
  }
  return face.fk;
}

// Characters that take no room and print nothing by themselves: joiners, variation selectors, soft hyphen, the
// byte order mark and direction marks. Missing from a font, they are left out without a word.
const ignorable = (cp: number) => cp === 0xad || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff
  || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x200e && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x61c;
const isMark = (ch: string) => /\p{M}/u.test(ch);

// Chinese characters are drawn a little differently in Japan, Korea and China. Kana in the same text says it is
// Japanese and Hangul says it is Korean. Otherwise the Chinese forms are used.
const cjkOrder = (text: string): string[] => (/[぀-ヿㇰ-ㇿｦ-ﾟ]/.test(text) ? ['jp', 'sc', 'kr']
  : /[ᄀ-ᇿ㄰-㆏가-힣]/.test(text) ? ['kr', 'sc', 'jp'] : ['sc', 'jp', 'kr']);
const rank = (order: string[], f: Face) => (order.indexOf(f.family) + 1 || 9);

/**
 * The characters of a text that the signed PDF cannot print, each once, in the order they appear. Empty when all of
 * it can be printed. Asked before sending and before signing, so nobody finds out from the finished document.
 */
export function unprintable(text: any): string {
  const s = clean(text).normalize('NFC');
  if (/^[ -~\n]*$/.test(s)) return '';
  const R = registry();
  const base = load(R.base);
  const out: string[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\n' || ignorable(cp) || base?.hasGlyphForCodePoint(cp) || (R.byChar.get(cp) || []).some((f) => load(f))) continue;
    if (!out.includes(ch)) out.push(ch);
  }
  return out.join('');
}

/** Everything on an envelope that ends up on the signed PDF or its certificate, checked for characters that cannot be printed. */
export function printProblems(e: any, sender?: any): { where: string; chars: string }[] {
  const out: { where: string; chars: string }[] = [];
  const check = (where: string, text: any) => {
    const chars = unprintable(text);
    if (chars) out.push({ where, chars });
  };
  check('The subject', e.subject);
  if (sender) check('Your own name', sender.name);
  for (const d of e.documents || []) check(`The name of the document "${d.name}"`, d.name);
  for (const r of e.recipients || []) check(`The name ${r.name}`, r.name);
  const names = new Map<string, string>((e.recipients || []).map((r: any) => [r.id, r.name]));
  for (const f of e.fields || []) {
    if (['signature', 'initials', 'attachment', 'checkbox', 'radio', 'full_name', 'email', 'date_signed'].includes(f.type)) continue;
    const what = f.label ? `"${f.label}"` : f.type === 'note' ? 'Your text' : f.type === 'text' ? 'A fill in field' : `A ${f.type} field`;
    check(`${what} on page ${f.page + 1}${f.recipient_id && names.get(f.recipient_id) ? `, in the part for ${names.get(f.recipient_id)}` : ''}`, f.value);
  }
  return out;
}

// In this version of fontkit a mark whose font gives no attachment point for the letter under it crashes the layout
// of the whole line ("Cannot read properties of null"). A font is allowed to leave that point out, and the Noto
// fonts for Thai and Devanagari do. Such a pair is left where the font's own widths put it. The class is not
// exported, so it is reached through the first font that has positioning rules, and mended once.
function mend(fk: any) {
  if (g.__sgmended) return;
  const proto = fk?._layoutEngine?.engine?.GPOSProcessor && Object.getPrototypeOf(fk._layoutEngine.engine.GPOSProcessor);
  if (!proto?.applyAnchor) return;
  const apply = proto.applyAnchor;
  proto.applyAnchor = function (mark: any, base: any, index: number) {
    if (mark?.markAnchor && base) apply.call(this, mark, base, index);
  };
  g.__sgmended = true;
}

type Glyph = { hex: string; adv: number; dx: number; dy: number; w: number };
type Seg = { font: PDFFont; glyphs: Glyph[] };
/** One line ready to draw. `width` is in thousandths of the font size. `rtl` says which side it is aligned to. */
export type Line = { segs: Seg[]; width: number; rtl: boolean; text: string; plain: boolean };

export class Typesetter {
  /** Characters that could not be printed in this document and were replaced by the mark. */
  readonly missing = new Set<string>();
  private extra = new Map<Face, PDFFont | null>();
  private keys = new WeakMap<PDFPage, Map<PDFFont, PDFName>>();
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont) {
    this.doc = doc;
    this.font = font;
    this.bold = bold;
  }

  // A Noto font, embedded in this document the first time one of its characters is drawn. These are the same three
  // steps PDFDocument.embedFont takes, done here without its "await", because lines are measured and drawn in one
  // go. It leans on how pdf-lib 1.17 keeps its fonts (a list on the document, an embedder on each font): if a later
  // version changes that, the font counts as missing and its characters are marked, which the tests would show.
  private faceFont(face: Face): PDFFont | null {
    if (this.extra.has(face)) return this.extra.get(face)!;
    let font: PDFFont | null = null;
    try {
      const fk = load(face);
      const fonts = (this.doc as any).fonts;
      if (fk && Array.isArray(fonts)) {
        font = PDFFont.of(this.doc.context.nextRef(), this.doc, new (CustomFontSubsetEmbedder as any)(fk, face.bytes, face.name));
        fonts.push(font);
      }
    } catch {
      font = null;
    }
    this.extra.set(face, font);
    return font;
  }

  private has(font: PDFFont, cp: number): boolean {
    return !!(font as any).embedder?.font?.hasGlyphForCodePoint(cp);
  }

  // Cuts a piece of text into stretches that one font can print. DejaVu comes first for everything it covers.
  private split(text: string, base: PDFFont, order: string[]): { font: PDFFont; text: string }[] {
    const out: { font: PDFFont; text: string }[] = [];
    const add = (font: PDFFont, ch: string) => {
      const last = out[out.length - 1];
      if (last && last.font === font) last.text += ch;
      else out.push({ font, text: ch });
    };
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const last = out[out.length - 1];
      // A mark or a joiner stays in the font of the letter it belongs to, when that font has it.
      if (last && (isMark(ch) || ignorable(cp)) && this.has(last.font, cp)) {
        last.text += ch;
        continue;
      }
      if (this.has(base, cp)) {
        add(base, ch);
        continue;
      }
      const faces = [...(registry().byChar.get(cp) || [])].sort((a, b) => rank(order, a) - rank(order, b));
      let font: PDFFont | null = null;
      for (const f of faces) if ((font = this.faceFont(f))) break;
      if (font) add(font, ch);
      else if (!ignorable(cp)) {
        this.missing.add(ch);
        // A mark that cannot be printed says so in the list. It gets no mark of its own beside the letter.
        if (!isMark(ch)) add(base, PRINT_MARK);
      }
    }
    return out;
  }

  // Shapes one stretch with its font: which glyphs, joined how, and where each one sits. The glyphs are noted on
  // the font's embedder the way pdf-lib's own encodeText does, so they are in the file and can be read back as text.
  private shape(font: PDFFont, text: string, rtl: boolean): Glyph[] {
    const em = (font as any).embedder;
    const scale = 1000 / em.font.unitsPerEm;
    mend(em.font);
    let run: { glyphs: any[]; positions: any[] };
    try {
      run = em.font.layout(text, undefined, undefined, undefined, rtl ? 'rtl' : 'ltr');
    } catch (err: any) {
      // The font library could not work out how these letters join. Rather than fail the signed PDF, they are
      // printed one by one, unjoined, in reading order, and the server log says so.
      console.error('[pdf] could not shape a piece of text, printing it letter by letter:', err?.message);
      const glyphs = em.font.glyphsForString(text);
      if (rtl) glyphs.reverse();
      run = { glyphs, positions: glyphs.map((x: any) => ({ xAdvance: x.advanceWidth, xOffset: 0, yOffset: 0 })) };
    }
    const out: Glyph[] = [];
    for (let i = 0; i < run.glyphs.length; i++) {
      const gl = run.glyphs[i], p = run.positions[i];
      const id = em.subset.includeGlyph(gl);
      // The first use of a glyph says which characters it stands for when the text is copied out of the PDF.
      if (!em.glyphs[id - 1]) em.glyphs[id - 1] = gl;
      em.glyphIdMap.set(gl.id, id);
      out.push({ hex: id.toString(16).padStart(4, '0'), adv: p.xAdvance * scale, dx: p.xOffset * scale, dy: p.yOffset * scale, w: gl.advanceWidth * scale });
    }
    em.glyphCache.invalidate();
    (font as any).modified = true;
    return out;
  }

  /** One line of text, measured and ready to draw. `dir` fixes the direction of the line; left out, the first letter decides. */
  layout(text: any, o: { bold?: boolean; dir?: 'ltr' | 'rtl' } = {}): Line {
    const s = clean(text).normalize('NFC').replace(/\n/g, ' ');
    const base = o.bold ? this.bold : this.font;
    const order = cjkOrder(s);
    const { rtl, runs } = visualRuns(s, o.dir);
    const segs: Seg[] = [];
    let width = 0;
    for (const run of runs) {
      const parts = this.split(run.text, base, order);
      // Inside a right-to-left piece the stretches stand from right to left as well.
      for (const part of run.rtl ? parts.reverse() : parts) {
        const glyphs = this.shape(part.font, part.text, run.rtl);
        width += glyphs.reduce((n, x) => n + x.adv, 0);
        const last = segs[segs.length - 1];
        if (last && last.font === part.font) last.glyphs.push(...glyphs);
        else segs.push({ font: part.font, glyphs });
      }
    }
    return { segs, width, rtl, text: s.replace(/[⁦-⁩]/g, ''), plain: segs.length <= 1 && runs.length <= 1 && !rtl && (!segs.length || segs[0].font === base) };
  }

  /** The text broken into lines no wider than `maxW` at this size. A word that is too long by itself is cut between characters. */
  wrap(text: any, size: number, maxW: number, o: { bold?: boolean; dir?: 'ltr' | 'rtl' } = {}): Line[] {
    const out: Line[] = [];
    const fits = (l: Line) => (l.width * size) / 1000 <= maxW;
    for (const para of clean(text).split('\n')) {
      // Every line of a paragraph is aligned to the same side: the one its first letter says.
      const dir = o.dir ?? firstStrong(para) ?? 'ltr';
      const opts = { bold: o.bold, dir };
      let line = '', made = this.layout('', opts);
      const push = () => {
        out.push(made);
        line = '';
        made = this.layout('', opts);
      };
      for (const word of para.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        const l = this.layout(next, opts);
        if (!line || fits(l)) {
          line = next;
          made = l;
        } else {
          push();
          line = word;
          made = this.layout(word, opts);
        }
        // Text with no spaces in it (Chinese, Japanese, Thai, a long code) is cut where the line is full.
        while (!fits(made) && [...line].length > 1) {
          const chars = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].map((x) => x.segment);
          let n = chars.length - 1;
          while (n > 1 && !fits(this.layout(chars.slice(0, n).join(''), opts))) n--;
          out.push(this.layout(chars.slice(0, n).join(''), opts));
          line = chars.slice(n).join('');
          made = this.layout(line, opts);
        }
      }
      push();
    }
    return out;
  }

  private key(page: PDFPage, font: PDFFont): PDFName {
    let m = this.keys.get(page);
    if (!m) this.keys.set(page, (m = new Map()));
    let k = m.get(font);
    if (!k) m.set(font, (k = page.node.newFontDictionary(font.name, font.ref)));
    return k;
  }

  /** Draws a line with its left end on (x, y). `rotate` turns it round that point, as for a page that is stored rotated. */
  draw(page: PDFPage, line: Line, o: { x: number; y: number; size: number; color: Color; rotate?: Rotation }) {
    if (!line.segs.length) return;
    const a = o.rotate ? toRadians(o.rotate) : 0;
    const ops: PDFOperator[] = [];
    // The words as they were typed, for programs that copy or search text in the PDF: on the page the glyphs of a
    // right-to-left or a joined script do not stand in typing order.
    if (!line.plain) ops.push(PDFOperator.of(Op.BeginMarkedContentSequence, [PDFName.of('Span'), this.doc.context.obj({ ActualText: PDFHexString.fromText(line.text) }) as any]));
    ops.push(pushGraphicsState(), beginText(), setFillingColor(o.color), setTextMatrix(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), o.x, o.y));
    const num = (n: number) => PDFNumber.of(Math.round(n * 100) / 100);
    for (const seg of line.segs) {
      ops.push(setFontAndSize(this.key(page, seg.font), o.size));
      let arr: (PDFHexString | PDFNumber)[] = [], hex = '', pending = 0, rise = 0;
      const text = () => {
        if (hex) arr.push(PDFHexString.of(hex));
        hex = '';
      };
      // In a TJ list a number moves the pen to the left by that many thousandths of the font size.
      const move = () => {
        if (Math.abs(pending) < 0.01) return;
        text();
        arr.push(num(-pending));
        pending = 0;
      };
      const show = () => {
        text();
        if (arr.length) ops.push(PDFOperator.of(Op.ShowTextAdjusted, [this.doc.context.obj(arr)]));
        arr = [];
      };
      for (const gl of seg.glyphs) {
        pending += gl.dx;
        if (gl.dy !== rise) {
          move();
          show();
          ops.push(setTextRise((gl.dy * o.size) / 1000));
          rise = gl.dy;
        }
        move();
        hex += gl.hex;
        // The reader moves on by the glyph's own width. Where the font asks for something else (a mark that sits on
        // the letter before it, a pair that is set closer together), the difference is made up before the next glyph.
        pending = gl.adv - gl.dx - gl.w;
      }
      move();
      show();
      if (rise) ops.push(setTextRise(0));
    }
    ops.push(endText(), popGraphicsState());
    if (!line.plain) ops.push(PDFOperator.of(Op.EndMarkedContent));
    page.pushOperators(...ops);
  }
}

/** Whether a text reads from right to left, so a field can align it to the right side of its box. */
export const readsRtl = (text: any): boolean => hasRtl(String(text ?? '')) && firstStrong(String(text ?? '')) === 'rtl';

// One typesetter for each PDF that is being built, shared by the pages and the certificate, so the list of
// characters that could not be printed covers the whole file.
const setters = new WeakMap<PDFDocument, Typesetter>();
export function typesetterFor(doc: PDFDocument, font: PDFFont, bold: PDFFont): Typesetter {
  let t = setters.get(doc);
  if (!t) setters.set(doc, (t = new Typesetter(doc, font, bold)));
  return t;
}
