// Turning the file a sender has into the PDF people will sign (src/lib/convert.ts has the words).
//
// 1. A file is recognised by its bytes, never by its name: OOXML (a ZIP with [Content_Types].xml and word/, xl/ or
//    ppt/), OpenDocument (a ZIP whose first entry is "mimetype"), old Office files (D0 CF 11 E0, the stream names
//    inside tell Word, Excel and PowerPoint apart), RTF ("{\rtf"), HTML, plain text (valid UTF-8 with no NUL) and
//    TIFF. A ZIP is unpacked in memory before anything else reads it, counting every byte: one that unpacks to more
//    than 100 MB, or to more than 20 times its own size, is refused and never opened.
// 2. What a file holds that the PDF cannot show the way the sender expects is noted (tracked changes and comments,
//    a sheet split across pages, pictures and files it points at outside itself, macros), for the words next to the
//    converted pages.
// 3. Two converters, chosen by settings. CONVERTER=soffice runs LibreOffice headless on this machine: a fresh profile
//    folder per job (-env:UserInstallation) set not to run macros, a minimal environment (no secret of this server
//    reaches it), a memory limit (CONVERT_MEMORY_MB), its own process group killed whole after CONVERT_TIMEOUT_MS,
//    at most CONVERT_MAX_JOBS at once in a queue, and its temporary folder removed afterwards. Where the machine
//    allows it the job runs with no network and a file system of its own that holds LibreOffice and the job's
//    folder and nothing else (convert-box.ts); where it does not, the server log says at the first job how far it
//    got and the README says what to do. A web page is cleaned of everything it names outside itself first
//    (convert-html.ts), whatever the machine allows. CONVERTER_URL points at a Gotenberg service (MIT) instead, which the operator keeps
//    in a network of its own with no way out. CONVERTER=stub is for tests only and refused on a production server.
//    With none of them the feature is absent: uploads behave as before and the refusal names what needs a converter.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { bad, HttpError, rateLimit, rateWait } from './util.ts';
import { CONVERT_KINDS_TEXT, needsConverter, OPERATOR_HINT, type ConvertNote } from '../lib/convert.ts';
import { boxed, type BoxLevel } from './convert-box.ts';
import { safeHtmlBytes } from './convert-html.ts';

export const UNPACKED_MAX = 100_000_000;
export const UNPACKED_RATIO = 20;
export const OUTPUT_MAX = 25_000_000;
// One account converts at most this many files at the same moment, and this many in an hour: a converter is the
// heaviest thing this server runs, and one account must not hold everybody else's uploads up.
export const PER_ACCOUNT_AT_ONCE = 2;
export const PER_ACCOUNT_HOUR = 60;

export type ConvertKind = 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'doc' | 'xls' | 'ppt' | 'rtf' | 'html' | 'txt' | 'tiff';
export type Family = 'word' | 'sheet' | 'slides' | 'rtf' | 'text' | 'html' | 'tiff';

export const KINDS: Record<ConvertKind, { family: Family; what: string; ext: string }> = {
  docx: { family: 'word', what: 'a Word file', ext: '.docx' },
  xlsx: { family: 'sheet', what: 'an Excel file', ext: '.xlsx' },
  pptx: { family: 'slides', what: 'a PowerPoint file', ext: '.pptx' },
  odt: { family: 'word', what: 'an OpenDocument text', ext: '.odt' },
  ods: { family: 'sheet', what: 'an OpenDocument spreadsheet', ext: '.ods' },
  odp: { family: 'slides', what: 'an OpenDocument presentation', ext: '.odp' },
  doc: { family: 'word', what: 'a Word file in the old .doc format', ext: '.doc' },
  xls: { family: 'sheet', what: 'an Excel file in the old .xls format', ext: '.xls' },
  ppt: { family: 'slides', what: 'a PowerPoint file in the old .ppt format', ext: '.ppt' },
  rtf: { family: 'rtf', what: 'an RTF file', ext: '.rtf' },
  html: { family: 'html', what: 'a web page (HTML)', ext: '.html' },
  txt: { family: 'text', what: 'a plain text file', ext: '.txt' },
  tiff: { family: 'tiff', what: 'a TIFF picture', ext: '.tiff' },
};

export type Detected =
  | { kind: 'pdf' | 'png' | 'jpeg' }
  | { kind: ConvertKind; notes: ConvertNote[]; tiffPages?: number }
  | { kind: 'unknown'; why: string };

// ---- Reading a ZIP ------------------------------------------------------------------------------------------------

type ZipItem = { name: string; method: number; flags: number; csize: number; usize: number; offset: number };

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');

const NOT_OFFICE = 'This file could not be read as an office file: it looks damaged or cut short. Open it in the program you made it with, save it again (or save it as a PDF) and upload the new file. Nothing was saved.';

/** The entries of a ZIP, from its central directory. Throws words for a person when it cannot be read. */
function zipItems(b: Uint8Array): ZipItem[] {
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { end = i; break; }
  if (end < 0) throw bad(NOT_OFFICE);
  const count = u16(b, end + 10), size = u32(b, end + 12), at = u32(b, end + 16);
  // ZIP64 (more than 65,535 entries or 4 GB) is never needed by a document under 25 MB.
  if (count === 0xffff || size === 0xffffffff || at === 0xffffffff || count > 20_000 || at + size > end) throw bad(NOT_OFFICE);
  const out: ZipItem[] = [];
  let p = at;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw bad(NOT_OFFICE);
    const n = u16(b, p + 28), x = u16(b, p + 30), k = u16(b, p + 32);
    const flags = u16(b, p + 8);
    const raw = b.subarray(p + 46, p + 46 + n);
    const name = flags & 0x800 ? Buffer.from(raw).toString('utf8') : latin1(raw);
    out.push({ name, method: u16(b, p + 10), flags, csize: u32(b, p + 20), usize: u32(b, p + 24), offset: u32(b, p + 42) });
    p += 46 + n + x + k;
  }
  return out;
}

/** The packed bytes of one entry, from its local header. */
function packed(b: Uint8Array, e: ZipItem): Uint8Array {
  const o = e.offset;
  if (o + 30 > b.length || u32(b, o) !== 0x04034b50) throw bad(NOT_OFFICE);
  const start = o + 30 + u16(b, o + 26) + u16(b, o + 28);
  if (start + e.csize > b.length) throw bad(NOT_OFFICE);
  return b.subarray(start, start + e.csize);
}

const PROTECTED = 'This file is protected with a password, so it cannot be turned into a PDF. Open it, remove the password (or save a copy without one, or save it as a PDF), and upload that. Nothing was saved.';

/** How many bytes one entry unpacks to, counted as it is unpacked and given up as soon as it passes `budget`. */
function unpackedLength(data: Uint8Array, budget: number): Promise<number> {
  return new Promise((resolve) => {
    const z = zlib.createInflateRaw();
    let n = 0, done = false;
    const finish = (v: number) => (done ? undefined : ((done = true), resolve(v)));
    z.on('data', (c: Buffer) => {
      n += c.length;
      if (n > budget) (z.destroy(), finish(n));
    });
    z.on('end', () => finish(n));
    // A stream that cannot be unpacked is a damaged file; the converter would fail on it too.
    z.on('error', () => finish(-1));
    z.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  });
}

/** Refuses a ZIP whose contents are far larger than the file: every entry is really unpacked and counted, so a size
 *  the file claims for itself does not decide. Returns nothing when it is fine. */
export async function assertNoBomb(b: Uint8Array, items: ZipItem[]) {
  const limit = Math.min(UNPACKED_MAX, UNPACKED_RATIO * b.length);
  const said = (n: number) => `This file unpacks to more than ${n >= UNPACKED_MAX ? `${UNPACKED_MAX / 1e6} MB` : `${UNPACKED_RATIO} times its own size`}, which an ordinary document does not do, so it was not opened. Nothing was saved. If it is a real document (a very large spreadsheet, say), save it as a PDF in the program you made it with and upload that.`;
  if (items.reduce((n, e) => n + e.usize, 0) > limit) throw bad(said(limit));
  let total = 0;
  for (const e of items) {
    if (e.flags & 1) throw bad(PROTECTED);
    if (e.method === 0) total += e.csize;
    else if (e.method === 8) {
      const n = await unpackedLength(packed(b, e), limit - total);
      if (n < 0) throw bad(NOT_OFFICE);
      total += n;
    } else throw bad(NOT_OFFICE); // deflate64, bzip2, LZMA and AES are not what office programs write
    if (total > limit) throw bad(said(limit));
  }
}

/** One entry as text, or '' when it is missing or too large to look into (looking is best effort). */
function entryText(b: Uint8Array, items: ZipItem[], name: string, max = 30_000_000): string {
  const e = items.find((x) => x.name === name);
  if (!e || e.usize > max) return '';
  try {
    const data = e.method === 0 ? packed(b, e) : zlib.inflateRawSync(packed(b, e), { maxOutputLength: max });
    return Buffer.from(data).toString('utf8');
  } catch {
    return '';
  }
}

// ---- Old Office files (OLE compound files) -------------------------------------------------------------------------

/** The names of the streams in a compound file, read from its directory entries wherever they sit. */
function oleNames(b: Uint8Array): Set<string> {
  const names = new Set<string>();
  const sector = 1 << Math.min(16, Math.max(7, u16(b, 0x1e)));
  for (let p = sector; p + 128 <= b.length && names.size < 5000; p += 128) {
    const len = u16(b, p + 64), type = b[p + 66];
    if (len < 4 || len > 64 || len % 2 || (type !== 1 && type !== 2 && type !== 5) || u16(b, p + len - 2) !== 0) continue;
    let s = '';
    for (let i = 0; i < len - 2; i += 2) s += String.fromCharCode(u16(b, p + i));
    if (/^[\x01-\x05]?[\x20-\x7e]+$/.test(s)) names.add(s.replace(/^[\x01-\x05]/, ''));
  }
  return names;
}

// ---- TIFF ----------------------------------------------------------------------------------------------------------

/** How many pages (image directories) a TIFF holds. */
export function tiffPages(b: Uint8Array): number {
  const le = b[0] === 0x49;
  const r16 = (o: number) => (le ? u16(b, o) : (b[o] << 8) | b[o + 1]);
  const r32 = (o: number) => (le ? u32(b, o) : b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
  const seen = new Set<number>();
  let at = r32(4), pages = 0;
  while (at > 0 && at + 2 <= b.length && !seen.has(at) && pages < 10_000) {
    seen.add(at);
    pages++;
    const next = at + 2 + r16(at) * 12;
    if (next + 4 > b.length) break;
    at = r32(next);
  }
  return pages;
}

// ---- Recognising a file --------------------------------------------------------------------------------------------

const starts = (b: Uint8Array, ...sig: number[]) => sig.every((v, i) => b[i] === v);
const HTML_START = /^(?:\s|<!--[\s\S]*?-->)*(?:<!doctype\s+html|<html[\s>])/i;

/** What an unknown file looks like, for the refusal. */
function looksLike(b: Uint8Array): string {
  const head = latin1(b.subarray(0, 64));
  if (starts(b, 0x47, 0x49, 0x46, 0x38)) return 'This is a GIF picture. Save it as PNG or JPEG and upload that.';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'This is a WebP picture. Save it as PNG or JPEG and upload that.';
  if (/^....ftyp(heic|heix|hevc|mif1|msf1)/s.test(head)) return 'This is a HEIC photo. Choose it again from your phone\'s photos (most phones then hand over a JPEG), or save it as JPEG, and upload that.';
  if (starts(b, 0x42, 0x4d)) return 'This is a BMP picture. Save it as PNG or JPEG and upload that.';
  if (starts(b, 0x4d, 0x5a) || starts(b, 0x7f, 0x45, 0x4c, 0x46)) return 'This is a program, not a document.';
  if (/^\s*<\?xml|^\s*<svg/i.test(head)) return 'This is an XML or SVG file, not a document we can turn into a PDF.';
  return '';
}

/** What a file is, from its bytes alone. `deep` (a converter is set up) unpacks a ZIP to count it and looks inside
 *  for what the notes need. Without it nothing is unpacked: the kind is told from the names in the file. */
export async function detect(b: Uint8Array, deep = true): Promise<Detected> {
  if (starts(b, 0x25, 0x50, 0x44, 0x46)) return { kind: 'pdf' };
  if (starts(b, 0x89, 0x50)) return { kind: 'png' };
  if (starts(b, 0xff, 0xd8)) return { kind: 'jpeg' };
  if (starts(b, 0x50, 0x4b, 0x03, 0x04) || starts(b, 0x50, 0x4b, 0x05, 0x06)) return detectZip(b, deep);
  if (starts(b, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    const names = oleNames(b);
    if (names.has('EncryptedPackage') || names.has('EncryptionInfo')) {
      if (deep) throw bad(PROTECTED);
      return { kind: 'unknown', why: 'This is a Microsoft Office file protected with a password. Save it as a PDF in the program you made it with and upload that.' };
    }
    if (names.has('WordDocument')) return { kind: 'doc', notes: [] };
    if (names.has('Workbook') || names.has('Book')) return { kind: 'xls', notes: ['sheet'] };
    if (names.has('PowerPoint Document')) return { kind: 'ppt', notes: [] };
    return { kind: 'unknown', why: [...names].some((n) => n.startsWith('__substg1.0_')) ? 'This is an Outlook message. Save the document attached to it and upload that.' : 'This is an old Microsoft Office file of a kind we cannot turn into a PDF.' };
  }
  if (starts(b, 0x7b, 0x5c, 0x72, 0x74, 0x66)) {
    const t = latin1(b);
    const notes: ConvertNote[] = [];
    if (/\\(revised|deleted|annotation|atnid|atrfstart)(?![a-z])/.test(t)) notes.push('tracked');
    // These fields always name a file or an address outside the document, with or without a scheme.
    if (/\b(INCLUDEPICTURE|INCLUDETEXT|IMPORT)\s+\S/i.test(t)) notes.push('external');
    return { kind: 'rtf', notes };
  }
  if (starts(b, 0x49, 0x49, 0x2a, 0x00) || starts(b, 0x4d, 0x4d, 0x00, 0x2a)) return { kind: 'tiff', notes: [], tiffPages: tiffPages(b) };
  if (starts(b, 0xff, 0xfe) || starts(b, 0xfe, 0xff)) return { kind: 'unknown', why: 'This text file is saved as UTF-16. Save it again as UTF-8 (in Notepad: File, Save as, Encoding: UTF-8) and upload that.' };
  // Pictures whose signature is long enough to be sure of, before anything is read as text.
  const head4 = latin1(b.subarray(0, 16));
  if (/^GIF8[79]a/.test(head4) || /^RIFF....WEBP/s.test(head4) || /^....ftyp(heic|heix|hevc|mif1|msf1)/s.test(head4)) return { kind: 'unknown', why: looksLike(b) };
  const body = starts(b, 0xef, 0xbb, 0xbf) ? b.subarray(3) : b;
  if (body.length && !body.includes(0)) {
    const head = latin1(body.subarray(0, 4096));
    if (HTML_START.test(head) || (/^\s*</.test(head) && /<(head|body)[\s>]/i.test(head))) {
      // Whatever the page names outside itself (a picture, a style sheet, a frame, on another server or on this
      // machine's disk) is taken out before it is converted (convert-html.ts); the sender is told when anything was.
      return { kind: 'html', notes: safeHtmlBytes(body).removed ? ['external'] : [] };
    }
    // Only markup is told apart here: a letter that starts with "BM" or "MZ" is still a letter.
    if (/^\s*<\?xml|^\s*<svg/i.test(head)) return { kind: 'unknown', why: 'This is an XML or SVG file, not a document we can turn into a PDF.' };
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      // A page with nothing on it is not a document anyone can sign, and would be taken for a scan.
      if (!/\S/u.test(text)) return { kind: 'unknown', why: 'This text file has no words in it, only spaces or empty lines.' };
      return { kind: 'txt', notes: [] };
    } catch {
      return { kind: 'unknown', why: 'This text file is not saved as UTF-8, so its letters could come out wrong. Save it again as UTF-8 (in Notepad: File, Save as, Encoding: UTF-8) and upload that.' };
    }
  }
  return { kind: 'unknown', why: looksLike(b) };
}

const ODF: Record<string, ConvertKind> = {
  'application/vnd.oasis.opendocument.text': 'odt', 'application/vnd.oasis.opendocument.text-template': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods', 'application/vnd.oasis.opendocument.spreadsheet-template': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp', 'application/vnd.oasis.opendocument.presentation-template': 'odp',
};

async function detectZip(b: Uint8Array, deep: boolean): Promise<Detected> {
  const items = zipItems(b);
  // Nothing in it is read before the whole of it has been counted.
  if (deep) await assertNoBomb(b, items);
  const names = new Set(items.map((e) => e.name));
  const first = b[0] === 0x50 && u32(b, 0) === 0x04034b50 ? latin1(b.subarray(30, 30 + u16(b, 26))) : '';
  if (first === 'mimetype') {
    const mime = entryText(b, items, 'mimetype', 200).trim();
    const kind = ODF[mime];
    if (!kind) return { kind: 'unknown', why: mime === 'application/epub+zip' ? 'This is an e-book (EPUB), not a document we can turn into a PDF.' : 'This is an OpenDocument file of a kind we do not turn into a PDF (only texts, spreadsheets and presentations).' };
    if (!deep) return { kind, notes: [] };
    if (/encryption-data/.test(entryText(b, items, 'META-INF/manifest.xml'))) throw bad(PROTECTED);
    const content = entryText(b, items, 'content.xml') + entryText(b, items, 'styles.xml');
    const notes: ConvertNote[] = [];
    if (kind === 'odt' && /<text:tracked-changes\b[^>]*>\s*<text:changed-region|<office:annotation\b/.test(content)) notes.push('tracked');
    if (kind === 'ods') notes.push('sheet');
    if (/<(draw:image|draw:object|draw:object-ole|draw:plugin|draw:floating-frame|text:section-source|table:table-source)\b[^>]*xlink:href="\s*([a-z][a-z0-9+.-]*:|\/|\\|\.\.\/)/i.test(content)) notes.push('external');
    if ([...names].some((n) => n.startsWith('Basic/') || n.startsWith('Scripts/'))) notes.push('macros');
    return { kind, notes };
  }
  if (names.has('[Content_Types].xml')) {
    const has = (prefix: string) => [...names].some((n) => n.startsWith(prefix));
    const kind: ConvertKind | null = has('word/') ? 'docx' : has('xl/') ? 'xlsx' : has('ppt/') ? 'pptx' : null;
    if (kind && !deep) return { kind, notes: [] };
    if (kind) {
      const notes: ConvertNote[] = [];
      if (kind === 'docx') {
        const parts = [...names].filter((n) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n));
        if (names.has('word/comments.xml') || parts.some((n) => /<w:(ins|del|moveFrom|moveTo)\b/.test(entryText(b, items, n)))) notes.push('tracked');
      }
      if (kind === 'xlsx') notes.push('sheet');
      // A relationship to something outside the file. A web link someone can click is not content, so it does not
      // count; a picture, a template, an embedded object or another workbook it fetches from elsewhere does.
      const rels = [...names].filter((n) => n.endsWith('.rels'));
      const external = has('xl/externalLinks/') || rels.some((n) => [...entryText(b, items, n).matchAll(/<Relationship\b[^>]*>/g)].some((m) => /TargetMode\s*=\s*"External"/i.test(m[0]) && !/Type\s*=\s*"[^"]*\/hyperlink"/i.test(m[0])));
      if (external) notes.push('external');
      if ([...names].some((n) => /^(word|xl|ppt)\/vbaProject\.bin$/i.test(n))) notes.push('macros');
      return { kind, notes };
    }
  }
  if (names.has('index.xml') || [...names].some((n) => n.startsWith('Index/'))) return { kind: 'unknown', why: 'This is a Pages, Numbers or Keynote file. Export it as a PDF (File, Export To, PDF) and upload that.' };
  return { kind: 'unknown', why: 'This is a ZIP archive. Take the documents out of it and upload them one by one.' };
}

// ---- Settings ------------------------------------------------------------------------------------------------------

const g = globalThis as any;
const logOnce = (key: string, line: string) => {
  const told: Set<string> = (g.__sgconvertlog ??= new Set());
  if (!told.has(key)) (told.add(key), console.error(line));
};

export type Mode = 'soffice' | 'gotenberg' | 'stub';

/** Which converter the settings choose, or null when there is none. */
export function converterMode(): { mode: Mode; url?: string } | null {
  const c = (process.env.CONVERTER || '').trim().toLowerCase();
  const raw = (process.env.CONVERTER_URL || '').trim().replace(/\/+$/, '');
  if (c === 'stub') {
    if (process.env.NODE_ENV === 'production') return (logOnce('stub', '[convert] CONVERTER=stub is for tests only and is ignored on a production server. Office files are not converted.'), null);
    return { mode: 'stub' };
  }
  if (c === 'soffice' || c === 'libreoffice') return { mode: 'soffice' };
  if (c === 'gotenberg' || (!c && raw)) {
    if (!/^https?:\/\/[^\s/]+/i.test(raw)) return (logOnce(`url:${raw}`, `[convert] CONVERTER_URL must be the http(s) address of a Gotenberg service, for example http://gotenberg:3000. It is "${raw}", so office files are not converted.`), null);
    return { mode: 'gotenberg', url: raw };
  }
  if (c) logOnce(`mode:${c}`, `[convert] CONVERTER is "${c}", which is not soffice or gotenberg, so office files are not converted.`);
  return null;
}

const intSetting = (name: string, def: number, min: number, max: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? Math.min(max, Math.floor(v)) : def;
};
export const convertTimeoutMs = () => intSetting('CONVERT_TIMEOUT_MS', 60_000, 1000, 600_000);
export const convertMaxJobs = () => intSetting('CONVERT_MAX_JOBS', 2, 1, 32);
// The most memory one LibreOffice job may ask for. A tiny file can describe a sheet of a billion cells; without a
// limit the job would take the machine's memory before the timeout stops it. 0 switches the limit off.
export const convertMemoryMb = () => (String(process.env.CONVERT_MEMORY_MB ?? '').trim() === '0' ? 0 : intSetting('CONVERT_MEMORY_MB', 1024, 256, 65_536));

/** Whether this server turns office files into PDF. False when nothing is set up, or when the converter it was told
 *  to use was found missing. */
export function converterOn(): boolean {
  const m = converterMode();
  if (!m) return false;
  if (m.mode !== 'soffice') return true;
  // The first time it is asked, LibreOffice is looked for in the background: until that answers, it counts as there.
  if (!g.__sgsoffice && !g.__sgsofficeprobe) void soffice();
  return g.__sgsoffice?.missing !== true;
}

// Test hooks: which program stands for LibreOffice, and whether `unshare` may be tried.
export const convertTesting = { soffice: 'soffice', unshare: 'unshare', forget() { delete g.__sgsoffice; delete g.__sgsofficeprobe; delete g.__sggotenberg; } };

// ---- Running a program in a process group of its own --------------------------------------------------------------

type Ran = { code: number | null; signal: string | null; out: string; err: string; timedOut: boolean; failed?: string };

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Removes a job's folder. A failure is logged and never fails the job: the next start sweeps what is left. */
function removeFolder(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (e: any) {
    console.error(`[convert] could not remove ${dir}: ${e?.message}`);
  }
}

function runGroup(cmd: string, args: string[], ms: number, cwd: string, home = cwd): Promise<Ran> {
  return new Promise((resolve) => {
    // Only what LibreOffice needs: none of this server's settings (keys, mail and payment secrets) are handed on.
    const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', SAL_USE_VCLPLUGIN: 'svp' } as unknown as NodeJS.ProcessEnv;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      return resolve({ code: null, signal: null, out: '', err: '', timedOut: false, failed: e?.code || String(e?.message) });
    }
    let out = '', err = '', timedOut = false, settled = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* the group is gone already */
      }
    };
    const timer = setTimeout(() => ((timedOut = true), killGroup()), ms);
    child.stdout.on('data', (c: Buffer) => (out = (out + c).slice(-4000)));
    child.stderr.on('data', (c: Buffer) => (err = (err + c).slice(-4000)));
    const done = async (r: Ran) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Whatever it started and left behind goes with it, and is gone before its folder is removed, so nothing of it
      // can still be writing there. A killed process that only waits to be collected counts as gone after 2 seconds.
      killGroup();
      for (let i = 0; i < 40 && child.pid && groupAlive(child.pid); i++) await new Promise((w) => setTimeout(w, 50));
      resolve(r);
    };
    child.on('error', (e: any) => done({ code: null, signal: null, out, err, timedOut, failed: e?.code || String(e?.message) }));
    child.on('exit', (code, signal) => done({ code, signal, out, err, timedOut }));
  });
}

// ---- The converters ------------------------------------------------------------------------------------------------

const TEMP_PREFIX = 'sg-convert-';

// A job the server was stopped in the middle of leaves its folder behind; the next job clears folders older than an
// hour, once per process.
function sweepTemp() {
  if (g.__sgconvertswept) return;
  g.__sgconvertswept = true;
  try {
    for (const n of fs.readdirSync(os.tmpdir())) {
      if (!n.startsWith(TEMP_PREFIX)) continue;
      const p = path.join(os.tmpdir(), n);
      if (Date.now() - fs.statSync(p).mtimeMs > 3600_000) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {
    /* nothing to sweep */
  }
}

// LibreOffice is told not to run macros and to refuse links that lead out of the file, in the fresh profile of
// every job. These are its own settings; the box around the job (convert-box.ts) is what does not depend on them.
const PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
`;

/** A job's folder: work/ holds the file, a fresh LibreOffice profile and the PDF; in the box it is all the job sees. */
function jobFolder(): { dir: string; work: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  fs.chmodSync(dir, 0o700);
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(work, 'profile', 'user'), { recursive: true });
  fs.writeFileSync(path.join(work, 'profile', 'user', 'registrymodifications.xcu'), PROFILE);
  return { dir, work };
}

/** Runs LibreOffice for one job at one level of isolation (convert-box.ts). `args` gets the folder as the job sees it. */
function runSoffice(level: BoxLevel, job: { dir: string; work: string }, ms: number, args: (base: string) => string[]): Promise<Ran> {
  const base = level === 'box' ? '/work' : job.work;
  const c = boxed(level, { unshare: convertTesting.unshare, dir: job.dir, memKb: convertMemoryMb() * 1024, program: convertTesting.soffice, args: [`-env:UserInstallation=${pathToFileURL(path.join(base, 'profile')).href}`, ...args(base)] });
  return runGroup(c.cmd, c.args, ms, job.work, base);
}

type Soffice = { level: BoxLevel; version: string; missing?: boolean };

/** Finds out once whether LibreOffice is there, which version it is, and how far it can be shut in: with no network
 *  and a file system of its own, with no network only, or not at all. */
async function soffice(): Promise<Soffice> {
  if (g.__sgsoffice) return g.__sgsoffice;
  g.__sgsofficeprobe ??= (async () => {
    try {
      const word = (r: Ran) => (/LibreOffice\s+[\d.]+/i.exec(r.out)?.[0] || '').replace(/^libreoffice/i, 'LibreOffice');
      let last: Ran | null = null;
      for (const level of (convertTesting.unshare ? ['box', 'net', 'open'] : ['open']) as BoxLevel[]) {
        const job = jobFolder();
        try {
          const r = (last = await runSoffice(level, job, 30_000, () => ['--version']));
          if (r.code !== 0 || (level !== 'open' && !word(r))) continue;
          if (level === 'net') logOnce('net', '\n[convert] LibreOffice runs without a network, but it can see the files of this machine: a file system of its own ("unshare -rnmpf" with mount and pivot_root) does not work here. Web pages are cleaned of everything they name outside themselves before they are converted, and LibreOffice is set to refuse links out of a document; to be sure, run the server as a user that can read nothing but the app, or use Gotenberg in a container (README, "Turning office files into PDF").\n');
          if (level === 'open') logOnce('open', '\n[convert] LibreOffice runs WITH network access and can see the files of this machine: "unshare -rn" does not work here. A document can point at pictures on other servers, and LibreOffice may fetch them. Run the server as a user whose outbound traffic is blocked, or use Gotenberg in a container with no network (README, "Turning office files into PDF").\n');
          return (g.__sgsoffice = { level, version: word(r) || 'LibreOffice' });
        } finally {
          removeFolder(job.dir);
        }
      }
      logOnce('missing', `\n[convert] CONVERTER=soffice, but LibreOffice could not be started (${last?.failed || last?.err.trim().slice(0, 200) || `exit ${last?.code}`}). Office files are not converted until it is installed and the server is restarted.\n`);
      return (g.__sgsoffice = { level: 'open', version: '', missing: true });
    } finally {
      delete g.__sgsofficeprobe;
    }
  })();
  return g.__sgsofficeprobe;
}

/** How far LibreOffice is shut in on this machine (for tests and the operator's log): 'box', 'net' or 'open'. */
export const sofficeLevel = async (): Promise<BoxLevel | null> => (converterMode()?.mode === 'soffice' ? (await soffice()).missing ? null : (await soffice()).level : null);

const DOWN = 'The converter on this server is not working right now, so this file could not be turned into a PDF. Nothing was saved. The reason is written in the server log for the people who run it. Upload a PDF instead, or try again later.';
const tooSlow = () => `Turning this file into a PDF took longer than ${Math.round(convertTimeoutMs() / 1000)} seconds, so it was stopped. Nothing was saved. Save it as a PDF in the program you made it with and upload that, or try a smaller file.`;
const COULD_NOT = 'This file could not be turned into a PDF: the converter could not open it. It may be damaged, protected with a password, far larger inside than it looks, or from a program the converter does not know. Nothing was saved. Open it in the program you made it with, save it as a PDF and upload that.';

async function bySoffice(input: Uint8Array, ext: string): Promise<{ pdf: Uint8Array; tool: string }> {
  const lo = await soffice();
  if (lo.missing) throw new HttpError(503, DOWN);
  sweepTemp();
  const job = jobFolder();
  try {
    fs.writeFileSync(path.join(job.work, `document${ext}`), input, { mode: 0o600 });
    const r = await runSoffice(lo.level, job, convertTimeoutMs(), (base) => ['--headless', '--invisible', '--norestore', '--nolockcheck', '--nodefault', '--nologo', '--nofirststartwizard', '--convert-to', 'pdf', '--outdir', path.join(base, 'out'), path.join(base, `document${ext}`)]);
    if (r.timedOut) throw bad(tooSlow(), 422, { code: 'convert_timeout' });
    if (r.failed) {
      console.error(`[convert] LibreOffice could not be started: ${r.failed}`);
      throw new HttpError(503, DOWN, { code: 'converter_down' });
    }
    const out = path.join(job.work, 'out', 'document.pdf');
    // What the job leaves is read as a plain file only: a link it put there instead leads nowhere we follow.
    if (!fs.existsSync(out) || !fs.lstatSync(out).isFile()) {
      console.error(`[convert] LibreOffice made no PDF (exit ${r.code}${r.signal ? `, ${r.signal}` : ''}): ${r.err.trim().slice(0, 300)}`);
      throw bad(COULD_NOT, 422, { code: 'convert_failed' });
    }
    if (fs.statSync(out).size > OUTPUT_MAX) throw bad(bigger(), 422);
    return { pdf: new Uint8Array(fs.readFileSync(out)), tool: lo.version };
  } finally {
    removeFolder(job.dir);
  }
}

const bigger = () => `The PDF made from this file is larger than ${OUTPUT_MAX / 1e6} MB, which is the most a document can be. Nothing was saved. Make the pictures in it smaller, or split it into parts, and upload again.`;

async function byGotenberg(url: string, input: Uint8Array, ext: string): Promise<{ pdf: Uint8Array; tool: string }> {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(input)]), `document${ext}`);
  let res: Response;
  try {
    res = await fetch(`${url}/forms/libreoffice/convert`, { method: 'POST', body: form, signal: AbortSignal.timeout(convertTimeoutMs()) });
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw bad(tooSlow(), 422, { code: 'convert_timeout' });
    console.error(`[convert] Gotenberg at ${url} could not be reached: ${e?.message}`);
    throw new HttpError(503, DOWN, { code: 'converter_down' });
  }
  if (res.status === 400 || res.status === 422) throw bad(COULD_NOT, 422, { code: 'convert_failed' });
  if (!res.ok) {
    console.error(`[convert] Gotenberg at ${url} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    throw new HttpError(503, DOWN, { code: 'converter_down' });
  }
  const pdf = new Uint8Array(await res.arrayBuffer());
  if (pdf.length > OUTPUT_MAX) throw bad(bigger(), 422);
  // Which LibreOffice made it, as the PDF itself says, and which Gotenberg, as it says when asked.
  g.__sggotenberg ??= fetch(`${url}/version`, { signal: AbortSignal.timeout(3000) }).then(async (r) => (r.ok ? (await r.text()).trim().slice(0, 40) : '')).catch(() => '');
  const version = /^[\w.+-]+$/.test(await g.__sggotenberg) ? ` ${await g.__sggotenberg}` : '';
  const producer = await PDFDocument.load(pdf, { updateMetadata: false }).then((d) => d.getProducer() || '').catch(() => '');
  const lo = /LibreOffice[\s/]*[\d.]+/i.exec(producer)?.[0].replace(/\//, ' ');
  return { pdf, tool: lo ? `${lo} in Gotenberg${version}` : `Gotenberg${version}` };
}

// The stub stands in for a converter in tests: a page that names what it was given, quickly, with no program.
async function byStub(input: Uint8Array, kind: ConvertKind): Promise<{ pdf: Uint8Array; tool: string }> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const page = d.addPage([595, 842]);
  page.drawText(`Stub conversion of ${KINDS[kind].what}`, { x: 72, y: 760, size: 14, font });
  if (kind === 'txt') page.drawText(Buffer.from(input).toString('utf8').split('\n')[0].replace(/[^\x20-\x7e]/g, '?').slice(0, 80), { x: 72, y: 730, size: 11, font });
  return { pdf: await d.save(), tool: 'the test converter' };
}

// ---- The queue -----------------------------------------------------------------------------------------------------

const queue: { running: number; waiting: (() => void)[]; mine: Map<string, number> } = (g.__sgconvertqueue ??= { running: 0, waiting: [], mine: new Map() });

/** Runs `work` when a place among CONVERT_MAX_JOBS is free. A place passes straight to the next in line. */
async function inLine<T>(accountId: string, work: () => Promise<T>): Promise<T> {
  const mine = queue.mine.get(accountId) || 0;
  if (mine >= PER_ACCOUNT_AT_ONCE) throw bad(`${PER_ACCOUNT_AT_ONCE} of your files are being turned into PDF already. Wait until one is done, then upload this one again. Nothing was saved.`, 429, { code: 'convert_busy' });
  if (queue.waiting.length >= convertMaxJobs() * 10) throw new HttpError(503, 'Many files are being turned into PDF on this server right now. Nothing was saved. Try again in a minute.', { code: 'convert_queue_full' });
  const key = `convert:${accountId}`;
  const wait = rateWait(key, PER_ACCOUNT_HOUR);
  if (wait) throw bad(`This account has had ${PER_ACCOUNT_HOUR} files turned into PDF in the last hour, which is the most we do in an hour. Nothing was saved. Try again in ${Math.max(1, Math.ceil(wait / 60_000))} minutes, or upload a PDF, which needs no converting.`, 429, { code: 'convert_hourly' });
  rateLimit(key, Infinity, 3600_000);
  queue.mine.set(accountId, mine + 1);
  try {
    if (queue.running >= convertMaxJobs()) await new Promise<void>((r) => queue.waiting.push(r));
    else queue.running++;
    try {
      return await work();
    } finally {
      const next = queue.waiting.shift();
      if (next) next();
      else queue.running--;
    }
  } finally {
    const n = (queue.mine.get(accountId) || 1) - 1;
    if (n) queue.mine.set(accountId, n);
    else queue.mine.delete(accountId);
  }
}

/** How many jobs run and wait now (for tests). */
export const queueState = () => ({ running: queue.running, waiting: queue.waiting.length });

// ---- From an upload to a PDF ---------------------------------------------------------------------------------------

export type Conversion = { pdf: Uint8Array; kind: ConvertKind; notes: ConvertNote[]; tool: string };

/** Makes a PDF of an uploaded file the server recognised as one it converts. Null for a PDF, PNG or JPEG, which go
 *  on as before. Throws words for a person when the file cannot be used. */
export async function toPdf(bytes: Uint8Array, accountId: string): Promise<Conversion | null> {
  // The LibreOffice check runs before the first job, so a server whose LibreOffice is missing says so in words.
  if (converterMode()?.mode === 'soffice') await soffice();
  const on = converterOn() ? converterMode() : null;
  const d = await detect(bytes, !!on);
  if (d.kind === 'pdf' || d.kind === 'png' || d.kind === 'jpeg') return null;
  if (d.kind === 'unknown') throw bad(`${d.why ? `${d.why} ` : ''}${on ? `Upload a PDF, PNG or JPEG, or ${CONVERT_KINDS_TEXT}, which we turn into a PDF.` : 'Upload a PDF, PNG or JPEG. Export Word or Google Docs files as PDF first.'} Nothing was saved.`, 400, { code: 'file_type' });
  const k = KINDS[d.kind];
  if (!on) throw bad(needsConverter(k.what), 400, { code: 'needs_converter', operator_hint: OPERATOR_HINT });
  // Plain text gets a byte order mark, so every converter reads it as UTF-8 whatever its own default is.
  // A web page is converted without anything it names outside itself (convert-html.ts). The original is kept as it was.
  const input = d.kind === 'txt' && !starts(bytes, 0xef, 0xbb, 0xbf) ? new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])) : d.kind === 'html' ? safeHtmlBytes(bytes).bytes : bytes;
  const made = await inLine(accountId, () => (on.mode === 'stub' ? byStub(input, d.kind as ConvertKind) : on.mode === 'gotenberg' ? byGotenberg(on.url!, input, k.ext) : bySoffice(input, k.ext)));
  if (!starts(made.pdf, 0x25, 0x50, 0x44, 0x46)) throw bad(COULD_NOT, 422, { code: 'convert_failed' });
  // A TIFF with several pages must not lose any on the way: some converters read the first page only.
  if (d.kind === 'tiff' && (d as any).tiffPages > 1) {
    const got = await PDFDocument.load(made.pdf, { updateMetadata: false }).then((x) => x.getPageCount()).catch(() => 0);
    if (got < (d as any).tiffPages) throw bad(`This TIFF has ${(d as any).tiffPages} pages, and the converter made ${got} of them. So that no page goes missing, nothing was saved. Save the pages as one PDF (or as separate PNG or JPEG pictures, chosen together) and upload that.`, 422, { code: 'convert_pages' });
  }
  return { pdf: made.pdf, kind: d.kind, notes: (d as any).notes || [], tool: made.tool };
}
