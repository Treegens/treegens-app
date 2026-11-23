// Text for pages that are pictures (a scan, a photo, a PNG or JPEG upload): read by a machine in the background, when
// the people who run the server set it up. Off by default: with neither setting, nothing here runs and nothing changes.
//
//   OCR_CMD        A command on this machine that reads one picture of a page and prints its text, such as Tesseract:
//                  OCR_CMD="tesseract {file} stdout -l {lang}". {file} is the picture (PNG or JPEG), {lang} the
//                  language code Tesseract uses (eng, deu, fra...). Without {file} the picture's path is added at the end.
//                  It is started without a shell, with nothing from the document on its command line but that path.
//   OCRMYPDF_URL   A service that takes the whole PDF (POST, body application/pdf, ?lang=<code>) and answers with the same
//                  PDF with a text layer, such as OCRmyPDF behind a small web wrapper. The document leaves this server
//                  for it (src/lib/outside.ts lists it). Used when OCR_CMD is not set.
//   OCR_TIMEOUT_MS How long one page may take, 60 000 by default. A service gets that for each page it is asked for.
//
// The text never replaces anything: the page that is signed stays the picture it was. It is used for three things:
// the sender's search (it is added to the file's kept text, files.text), the text view of the signing page (GET
// /sign/:token/ocr, src/server/routes-ocr.ts) and so screen readers, always with OCR_WARNING beside it. The rows are in
// ocr_jobs, deleted with their file by a trigger (src/server/db.ts).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFNumber, PDFArray } from 'pdf-lib';
import { all, get, run, readBlob } from './db.ts';
import { extractPages } from './text.ts';
import { keepText, keptText, sealText } from './searchtext.ts';
import { keys } from './filestore.ts';
import { crc32 } from './png.ts';
import { ocrOn } from '../lib/a11y.ts';

export const OCR_MAX_TRIES = 3;
const PAGE_CHARS = 20_000;
const FILE_CHARS = 300_000;
const ANSWER_BYTES = 200_000_000;
const nowIso = () => new Date().toISOString();

/** How long one page may take, in milliseconds (OCR_TIMEOUT_MS, 1 second to 30 minutes, 60 seconds by default). */
export function ocrTimeout(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.OCR_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 30 * 60_000) : 60_000;
}

// The language codes Tesseract and OCRmyPDF use, for the languages people sign in. Anything else reads as English.
const CODES: Record<string, string> = {
  en: 'eng', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', pl: 'pol', sv: 'swe', da: 'dan', nb: 'nor', nn: 'nor', no: 'nor',
  fi: 'fin', cs: 'ces', sk: 'slk', ro: 'ron', hu: 'hun', el: 'ell', tr: 'tur', ru: 'rus', uk: 'ukr', bg: 'bul', hr: 'hrv', sl: 'slv', sr: 'srp',
  et: 'est', lv: 'lav', lt: 'lit', ar: 'ara', he: 'heb', fa: 'fas', hi: 'hin', bn: 'ben', ja: 'jpn', zh: 'chi_sim', 'zh-tw': 'chi_tra',
  'zh-hant': 'chi_tra', ko: 'kor', th: 'tha', vi: 'vie', id: 'ind', ms: 'msa', sw: 'swa',
};
/** The OCR language code for a language tag ("de-AT" is deu), or null when it is not known. */
export function ocrLang(locale?: string | null): string | null {
  if (!locale) return null;
  const l = String(locale).toLowerCase();
  return CODES[l] || CODES[l.split('-').slice(0, 2).join('-')] || CODES[l.split('-')[0]] || null;
}
/**
 * The document's language when it is known: the language set for a person on an envelope that already uses the file,
 * else the account's default language for new recipients, else English. A file is usually read right after it is
 * uploaded, before anyone is on it, so the account's language is what decides most of the time.
 */
export function langFor(fileId: string): string {
  const person = get('SELECT r.locale FROM documents d JOIN recipients r ON r.envelope_id=d.envelope_id WHERE d.file_id=? AND r.locale IS NOT NULL LIMIT 1', fileId);
  const acc = get('SELECT a.default_locale FROM files f JOIN accounts a ON a.id=f.account_id WHERE f.id=?', fileId);
  return ocrLang(person?.locale) || ocrLang(acc?.default_locale) || 'eng';
}

/** Puts a file's pages without text in the queue, when this server reads text from pictures. Answers whether it did. */
export function queueOcr(fileId: string, scanPages: number[]): boolean {
  if (!ocrOn() || !scanPages.length) return false;
  run('INSERT OR IGNORE INTO ocr_jobs (file_id, state, pages, created_at) VALUES (?,?,?,?)', fileId, 'queued', JSON.stringify(scanPages.slice(0, 500)), nowIso());
  // In the background: the upload answers at once, and the text arrives when it is ready.
  setTimeout(() => void runOcr().catch((e) => console.error('[ocr]', e?.message)), 0);
  return true;
}

/** Where a file's text reading stands, for the sender's screens: null when nothing was asked. */
export function ocrState(fileId: string): 'queued' | 'running' | 'done' | 'failed' | null {
  return get('SELECT state FROM ocr_jobs WHERE file_id=?', fileId)?.state ?? null;
}

/** { ocr: state } for a document whose file has pages without text and a reading job, else nothing at all. */
export function ocrField(fileId: string, scanPages: string | null): { ocr?: string } {
  if (!scanPages) return {};
  const s = ocrState(fileId);
  return s ? { ocr: s } : {};
}

/** The text read from each page of a file, by page number from 1. Empty until the job is done. */
export function ocrText(fileId: string): Record<string, string> {
  const row = get('SELECT file_id, text, text_sealed, state FROM ocr_jobs WHERE file_id=?', fileId);
  if (!row || row.state !== 'done') return {};
  try {
    const out = JSON.parse(keptText({ id: `${fileId}#ocr`, text: row.text, text_sealed: row.text_sealed }) || '{}');
    return out && typeof out === 'object' ? out : {};
  } catch {
    return {};
  }
}

// ---- Pictures of pages ----

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(w: number, h: number, colors: number, bpc: number, idat: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = bpc;
  ihdr[9] = colors === 3 ? 2 : 0;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const nameOf = (v: any): string => (v instanceof PDFName ? v.asString().replace(/^\//, '') : '');
const numOf = (d: PDFDict, key: string): number | null => {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
};

/** The colour components of an image's colour space: 1 for grey, 3 for RGB, null for anything else. */
function colorsOf(doc: PDFDocument, d: PDFDict): number | null {
  const cs = d.lookup(PDFName.of('ColorSpace'));
  const n = nameOf(cs);
  if (n === 'DeviceGray' || n === 'CalGray') return 1;
  if (n === 'DeviceRGB' || n === 'CalRGB') return 3;
  if (cs instanceof PDFArray && nameOf(cs.lookup(0)) === 'ICCBased') {
    const s = doc.context.lookup(cs.get(1));
    const k = s instanceof PDFRawStream ? numOf(s.dict, 'N') : null;
    return k === 1 || k === 3 ? k : null;
  }
  return null;
}

/** The picture a scanned page is: its largest image, as a file Tesseract reads (JPEG as it is, Flate as PNG). */
export function imageOf(doc: PDFDocument, pageIndex: number): { ext: 'jpg' | 'png' | 'jp2'; data: Buffer } | null {
  const page = doc.getPage(pageIndex);
  const xo = page.node.Resources()?.lookup(PDFName.of('XObject'));
  if (!(xo instanceof PDFDict)) return null;
  let best: PDFRawStream | null = null;
  let area = 0;
  for (const [, ref] of xo.entries()) {
    const s = doc.context.lookup(ref);
    if (!(s instanceof PDFRawStream) || nameOf(s.dict.lookup(PDFName.of('Subtype'))) !== 'Image') continue;
    const a = (numOf(s.dict, 'Width') || 0) * (numOf(s.dict, 'Height') || 0);
    if (a > area) (best = s), (area = a);
  }
  if (!best) return null;
  const d = best.dict;
  const f = d.lookup(PDFName.of('Filter'));
  const filters = f instanceof PDFArray ? f.asArray().map(nameOf) : f ? [nameOf(f)] : [];
  const bytes = Buffer.from(best.contents);
  if (filters.length === 1 && filters[0] === 'DCTDecode') return { ext: 'jpg', data: bytes };
  if (filters.length === 1 && filters[0] === 'JPXDecode') return { ext: 'jp2', data: bytes };
  if (filters.length !== 1 || filters[0] !== 'FlateDecode') return null;
  const w = numOf(d, 'Width') || 0, h = numOf(d, 'Height') || 0;
  const bpc = numOf(d, 'BitsPerComponent') || 8;
  const colors = colorsOf(doc, d);
  if (!w || !h || !colors || ![1, 8].includes(bpc) || (bpc === 1 && colors !== 1) || w * h > 60_000_000) return null;
  const parms = d.lookup(PDFName.of('DecodeParms'));
  const predictor = parms instanceof PDFDict ? numOf(parms, 'Predictor') || 1 : 1;
  // PNG predictors: the stream already is what a PNG holds (rows that each start with their filter byte).
  if (predictor >= 10) return { ext: 'png', data: png(w, h, colors, bpc, bytes) };
  if (predictor !== 1) return null;
  const row = Math.ceil((w * colors * bpc) / 8);
  // Never inflate more than the picture can hold: a small stream can unpack to gigabytes (a "zip bomb").
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(bytes, { maxOutputLength: row * h + 1 });
  } catch {
    return null; // broken data, or more than the picture's size: no text for this page
  }
  if (raw.length < row * h) return null;
  const out = Buffer.alloc((row + 1) * h);
  for (let y = 0; y < h; y++) raw.copy(out, y * (row + 1) + 1, y * row, y * row + row);
  return { ext: 'png', data: png(w, h, colors, bpc, zlib.deflateSync(out)) };
}

/** What a machine read, as text a person can be shown: printable characters, at most a few blank lines, capped. */
export function cleanOcr(s: string): string {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, PAGE_CHARS);
}

/** The command of OCR_CMD as a program and its arguments, with {file} and {lang} filled in. No shell is used. */
export function commandFor(cmd: string, file: string, lang: string): [string, string[]] {
  // A part in double quotes keeps its spaces, for a program path such as "/opt/My Reader/ocr".
  const parts = (cmd.trim().match(/"[^"]*"|\S+/g) || []).map((p) => (p.length > 1 && p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p)).filter(Boolean);
  let named = false;
  const args = parts.map((p) => {
    if (p.includes('{file}')) named = true;
    return p.replaceAll('{file}', file).replaceAll('{lang}', lang);
  });
  if (!named) args.push(file);
  return [args[0], args.slice(1)];
}

function runCommand(cmd: string, file: string, lang: string, timeout: number): Promise<string> {
  const [prog, args] = commandFor(cmd, file, lang);
  return new Promise((resolve, reject) => {
    execFile(prog, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 4_000_000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(new Error((err as any).killed ? `the text reader took longer than ${Math.round(timeout / 1000)} seconds` : `the text reader stopped: ${String(err.message).split('\n')[0].slice(0, 200)}`));
      else resolve(String(stdout));
    });
  });
}

/**
 * `used.lang` says the language the pages were read in. When the reader fails in the document's language (often: its
 * language pack is not installed) but not by running out of time, the page is tried once in English and the rest of
 * the file is read in English too, with a line in the server log saying so.
 */
async function readWithCommand(cmd: string, bytes: Uint8Array, pages: number[], lang: string, used = { lang }): Promise<Record<string, string>> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-ocr-'));
  const out: Record<string, string> = {};
  try {
    for (const p of pages) {
      if (p < 1 || p > doc.getPageCount()) continue;
      const img = imageOf(doc, p - 1);
      if (!img) continue; // A page that is not one picture we can hand over (a drawing, a fax encoding): no text for it.
      const file = path.join(dir, `page-${p}.${img.ext}`);
      fs.writeFileSync(file, img.data, { mode: 0o600 });
      try {
        let said: string;
        try {
          said = await runCommand(cmd, file, used.lang, ocrTimeout());
        } catch (e: any) {
          if (used.lang === 'eng' || /took longer/.test(String(e?.message))) throw e;
          console.warn(`[ocr] the text reader failed in language "${used.lang}" (${String(e?.message).slice(0, 160)}); reading in English instead. Is its language pack installed?`);
          used.lang = 'eng';
          said = await runCommand(cmd, file, used.lang, ocrTimeout());
        }
        const t = cleanOcr(said);
        if (t) out[String(p)] = t;
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

async function readWithService(url: string, bytes: Uint8Array, pages: number[], lang: string): Promise<Record<string, string>> {
  const u = new URL(url);
  u.searchParams.set('lang', lang);
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: Buffer.from(bytes), signal: AbortSignal.timeout(Math.min(ocrTimeout() * Math.max(1, pages.length), 60 * 60_000)), redirect: 'error' });
  if (!r.ok) throw new Error(`the text reading service answered ${r.status}`);
  const got = new Uint8Array(await r.arrayBuffer());
  if (got.length > ANSWER_BYTES || !(got[0] === 0x25 && got[1] === 0x50 && got[2] === 0x44 && got[3] === 0x46)) throw new Error('the text reading service did not answer with a PDF');
  const read = await extractPages(got);
  const out: Record<string, string> = {};
  for (const p of pages) {
    const t = cleanOcr(read[p - 1] || '');
    if (t) out[String(p)] = t;
  }
  return out;
}

/** Reads one queued file. Writes the text, adds it to the file's kept text for search, and marks the job done. */
async function readOne(job: any): Promise<void> {
  const f = get('SELECT id, sha256, text, text_sealed FROM files WHERE id=?', job.file_id);
  if (!f) return void run('DELETE FROM ocr_jobs WHERE file_id=?', job.file_id);
  const pages: number[] = JSON.parse(job.pages || '[]');
  const lang = langFor(f.id);
  run('UPDATE ocr_jobs SET state=?, started_at=?, tries=tries+1, lang=? WHERE file_id=?', 'running', nowIso(), lang, f.id);
  const bytes = readBlob(f.sha256);
  const cmd = (process.env.OCR_CMD || '').trim();
  const url = (process.env.OCRMYPDF_URL || '').trim();
  const used = { lang };
  const text = cmd ? await readWithCommand(cmd, bytes, pages, lang, used) : await readWithService(url, bytes, pages, lang);
  if (used.lang !== lang) run('UPDATE ocr_jobs SET lang=? WHERE file_id=?', used.lang, f.id);
  const kept = keepText(`${f.id}#ocr`, JSON.stringify(text));
  run("UPDATE ocr_jobs SET state='done', done_at=?, error=NULL, text=?, text_sealed=?, text_key=? WHERE file_id=?", nowIso(), kept.text ?? (kept.sealed ? null : '{}'), kept.sealed, kept.key, f.id);
  // For the sender's search: the words are added to what the file already keeps (never instead of it).
  const words = Object.keys(text).sort((a, b) => Number(a) - Number(b)).map((k) => text[k]).join('\n');
  if (!words) return;
  const old = keptText(f);
  if (f.text_sealed && !old) return; // kept under a key this server does not hold: leave it as it is
  const both = keepText(f.id, `${old}${old ? '\n' : ''}${words}`.slice(0, FILE_CHARS));
  run('UPDATE files SET text=?, text_sealed=?, text_key=? WHERE id=?', both.text, both.sealed, both.key, f.id);
}

/** Text read before FILE_ENCRYPTION_KEY was set, or under an old key, is sealed with the current one. */
export function sealOcrTexts(): number {
  const k = keys().current;
  if (!k) return 0;
  const rows = all("SELECT file_id, text, text_sealed, text_key FROM ocr_jobs WHERE state='done' AND (text IS NOT NULL OR (text_sealed IS NOT NULL AND (text_key IS NULL OR text_key != ?)))", k.id);
  for (const r of rows) {
    const t = keptText({ id: `${r.file_id}#ocr`, text: r.text, text_sealed: r.text_sealed });
    if (r.text_sealed && !t) continue;
    run('UPDATE ocr_jobs SET text=NULL, text_sealed=?, text_key=? WHERE file_id=?', sealText(t || '{}', `${r.file_id}#ocr`, k), k.id, r.file_id);
  }
  return rows.length;
}

let current: Promise<number> | null = null;
/**
 * Reads what is queued, one file at a time, and answers how many files it finished. Called after an upload and by
 * the timer (src/server/cron.ts). A job that was running when the server stopped is picked up again once its time is
 * over. A job that fails is tried again on the next run, up to OCR_MAX_TRIES times, and then left as failed: the
 * pages keep saying they have no text, as they did before.
 */
/**
 * For the timer: starts a run and waits for it at most `waitMs`. A batch of large scans can take hours, and the timer
 * (and an outside scheduler calling POST /cron) must not wait that long: the run goes on by itself, and the answer
 * says "still reading". A run already going is never waited for.
 */
export async function ocrTick(waitMs = 20_000): Promise<number | 'still reading'> {
  if (current) return 'still reading';
  const p = runOcr().catch((e) => (console.error('[ocr]', e?.message), 0));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'still reading'>((r) => (timer = setTimeout(() => r('still reading'), waitMs)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function runOcr(limit = 5): Promise<number> {
  if (current) return current;
  current = (async () => {
    if (!ocrOn()) return 0;
    sealOcrTexts();
    // A running job is taken again once it has had its pages' time and a minute more: the server stopped under it.
    const over = (j: any) => j.state === 'queued' || Date.parse(j.started_at || '') < Date.now() - ocrTimeout() * Math.max(1, JSON.parse(j.pages || '[]').length) - 60_000;
    const jobs = all("SELECT * FROM ocr_jobs WHERE state IN ('queued','running') ORDER BY created_at").filter(over).slice(0, limit);
    let n = 0;
    for (const job of jobs) {
      try {
        await readOne(job);
        n++;
      } catch (e: any) {
        const tries = (get('SELECT tries FROM ocr_jobs WHERE file_id=?', job.file_id)?.tries || 0) as number;
        run('UPDATE ocr_jobs SET state=?, error=? WHERE file_id=?', tries >= OCR_MAX_TRIES ? 'failed' : 'queued', String(e?.message || e).slice(0, 300), job.file_id);
        // Said in the server log too, so whoever runs the server learns that the reader is missing or broken.
        console.error(`[ocr] reading the text of a scanned file failed (try ${tries} of ${OCR_MAX_TRIES}): ${String(e?.message || e).slice(0, 200)}`);
      }
    }
    return n;
  })().finally(() => {
    current = null;
  });
  return current;
}

