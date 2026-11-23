// Archive format: completed files as PDF/A-2b, for archives that require it, and called PDF/A only when veraPDF
// passed the very file that is stored.
//
// It is there only when the people who run the server set VERAPDF_CMD (veraPDF needs Java) and an admin switched on
// "Archive format (PDF/A)" under Settings, Records and data (routes-pdfa.ts). With either missing, nothing here runs
// and completed files are made exactly as before. Documents completed before the switch stay as they are.
//
// finishPdf (finalpipe.ts) hands its whole finishing run to inArchiveFormat:
//   1. archivePlan: the uploaded documents and the files signers attached are read first. A font that is not inside
//      the file, colours for a printing press (CMYK, which an sRGB output intent cannot describe) or sound, video, 3D
//      or an attached file make PDF/A impossible without changing how the pages look, so the file is made as before
//      and the certificate of completion says why, in a few words.
//   2. Otherwise the certificate is drawn saying "PDF/A-2b, checked with veraPDF <version>", the rendered file is
//      turned into PDF/A (toPdfA: XMP metadata with pdfaid:part 2 and conformance B, the title and the dates, an
//      output intent with the sRGB profile in assets/icc, a document ID in the trailer, no JavaScript and no actions
//      PDF/A forbids, every annotation printable, no encryption), and only then sealed: a seal added as an incremental
//      update keeps a PDF/A-2b file PDF/A-2b.
//   3. veraPDF checks the finished file, seal and long-term data included. When it does not pass it, or cannot say,
//      the whole run is made again as a normal file whose certificate says "not PDF/A (<why>)". A file is never
//      called PDF/A that veraPDF did not pass.
//      At most CHECKS_AT_ONCE checks run at a time (checkInLine), and the last signer never waits for one
//      (completesLater): the file and the "completed" emails follow in the background.
// What came of it is stored on the envelope (pdfa, pdfa_note, pdfa_code, pdfa_checker) once the file is stored
// (archiveStored), shown under "Checks on the file" with a next step (nextStep) and written in the history.
//
// Left out: PDF/A-1 and PDF/A-3, converting documents completed earlier, and re-rendering an uploaded file through
// the office converter to make it PDF/A (that would change how the pages people signed look).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFRawStream, PDFHexString, PDFString, PDFNumber, PDFBool, PDFObject, decodePDFRawStream } from 'pdf-lib';
import { get, run, readBlob } from './db.ts';
import { audit } from './envelopes.ts';
import { t, SOURCE_LOCALE } from '../lib/i18n.ts';

const ui = SOURCE_LOCALE;
const g = globalThis as any;

// ---- Settings -------------------------------------------------------------------------------------------------------

/** VERAPDF_CMD as a program and its arguments (split at spaces), or null when it is not set. */
export function checkerCommand(): string[] | null {
  const raw = String(process.env.VERAPDF_CMD || '').trim();
  return raw ? raw.split(/\s+/) : null;
}

/** How long one veraPDF check may take: VERAPDF_TIMEOUT_MS, 60 seconds by default, between 5 seconds and 10 minutes. */
export function checkerTimeoutMs(): number {
  const v = Number(process.env.VERAPDF_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(600_000, Math.max(5_000, Math.floor(v))) : 60_000;
}

/** Whether an admin can switch PDF/A on: only once the people who run the server set up the checker. */
export const pdfaAvailable = () => !!checkerCommand();

export function accountWantsPdfa(accountId: string | null | undefined): boolean {
  if (!accountId) return false;
  return !!get('SELECT pdfa_on FROM accounts WHERE id=?', accountId)?.pdfa_on;
}

// ---- Running veraPDF -------------------------------------------------------------------------------------------------

type Ran = { code: number | null; out: string; err: string; timedOut: boolean; failed?: string };

/** Runs the checker in a process group of its own, killed whole at the timeout. Only PATH, JAVA_HOME and a language
 *  are handed on: none of this server's secrets reach it. */
function runChecker(args: string[], ms: number, cwd: string): Promise<Ran> {
  const cmd = checkerCommand()!;
  return new Promise((resolve) => {
    const env: Record<string, string> = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8' };
    if (process.env.JAVA_HOME) env.JAVA_HOME = process.env.JAVA_HOME;
    let child;
    try {
      child = spawn(cmd[0], [...cmd.slice(1), ...args], { cwd, env: env as unknown as NodeJS.ProcessEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      return resolve({ code: null, out: '', err: '', timedOut: false, failed: e?.code || String(e?.message) });
    }
    let out = '', err = '', timedOut = false, settled = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone already */
      }
    };
    const timer = setTimeout(() => ((timedOut = true), kill()), ms);
    // The report of one file is small; a runaway one is cut, never held in memory whole.
    child.stdout.on('data', (c: Buffer) => (out.length < 4_000_000 ? (out += c) : null));
    child.stderr.on('data', (c: Buffer) => (err = (err + c).slice(-4000)));
    const done = (r: Ran) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      resolve(r);
    };
    child.on('error', (e: any) => done({ code: null, out, err, timedOut, failed: e?.code || String(e?.message) }));
    child.on('close', (code) => done({ code, out, err, timedOut }));
  });
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-pdfa-'));
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** "veraPDF 1.28.2", asked once per setting; null when the checker cannot be started (asked again after a minute). */
export async function checkerVersion(): Promise<string | null> {
  const cmd = String(process.env.VERAPDF_CMD || '').trim();
  const c = g.__sgpdfaversion;
  if (c && c.cmd === cmd && (c.version || Date.now() - c.at < 60_000)) return c.version;
  // Many documents completing at once ask once: one Java start, not one each.
  const asking = g.__sgpdfaasking;
  if (asking && asking.cmd === cmd) return asking.p;
  const p = askVersion(cmd).finally(() => (g.__sgpdfaasking = null));
  g.__sgpdfaasking = { cmd, p };
  return p;
}

async function askVersion(cmd: string): Promise<string | null> {
  const dir = tempDir();
  try {
    const r = await runChecker(['--version'], Math.min(checkerTimeoutMs(), 60_000), dir);
    const v = /verapdf\D{0,20}?(\d+(?:\.\d+)+)/i.exec(r.out + '\n' + r.err)?.[1];
    if (!v) console.error(`[pdfa] VERAPDF_CMD is set, but "${cmd} --version" did not name a veraPDF version (${r.failed || (r.timedOut ? 'it took too long' : `exit ${r.code}`)}): ${r.err.trim().slice(0, 200)}. Completed files are made as normal PDFs until it works.`);
    g.__sgpdfaversion = { cmd, version: v ? `veraPDF ${v}` : null, at: Date.now() };
    return v ? `veraPDF ${v}` : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export type Checked = { passed: true } | { passed: false; why: string; code: WhyCode };

/** Why a file is not PDF/A, as a code: it picks the next step the page shows under the reason (nextStep). */
export type WhyCode = 'font' | 'cmyk' | 'media' | 'attached' | 'failed' | 'convert' | 'slow' | 'checker_down' | 'busy';

/** One plain sentence on what to do so the next file can be PDF/A. */
export function nextStep(code: WhyCode | string | null | undefined): string {
  const k = code === 'font' || code === 'cmyk' || code === 'media' || code === 'attached' ? code : code === 'failed' || code === 'convert' ? 'failed' : 'server';
  return t(ui, `pdfa.next.${k}`);
}

/** veraPDF's verdict on `pdf` as PDF/A-2b, from its machine-readable report. Anything but a clear pass is a "no". */
export async function checkPdfA(pdf: Uint8Array): Promise<Checked> {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'signed.pdf');
    fs.writeFileSync(file, pdf, { mode: 0o600 });
    const ms = checkerTimeoutMs();
    const r = await runChecker(['--flavour', '2b', '--format', 'mrr', file], ms, dir);
    if (r.timedOut) return { passed: false, why: t(ui, 'pdfa.why.slow', { seconds: Math.round(ms / 1000) }), code: 'slow' };
    const report = /<validationReport\b[^>]*>/.exec(r.out)?.[0];
    if (!report) {
      console.error(`[pdfa] veraPDF gave no report (${r.failed || `exit ${r.code}`}): ${r.err.trim().slice(0, 300)}`);
      return { passed: false, why: t(ui, 'pdfa.why.checker_down'), code: 'checker_down' };
    }
    const profile = /profileName="([^"]*)"/.exec(report)?.[1] || '';
    if (/isCompliant="true"/.test(report) && /2b\b/i.test(profile) && !/jobEndStatus="(?!normal)/.test(report)) return { passed: true };
    const failed = Number(/<details\b[^>]*failedRules="(\d+)"/.exec(r.out)?.[1] || 0);
    const clauses = [...r.out.matchAll(/<rule\b[^>]*clause="([^"]+)"[^>]*status="failed"|<rule\b[^>]*status="failed"[^>]*clause="([^"]+)"/g)].map((m) => m[1] || m[2]);
    console.error(`[pdfa] veraPDF did not pass a completed file as PDF/A-2b (${failed} rules, clauses ${[...new Set(clauses)].slice(0, 12).join(', ') || 'not named'}). It was made again as a normal PDF.`);
    return failed ? { passed: false, why: t(ui, 'pdfa.why.failed', { count: failed }), code: 'failed' } : { passed: false, why: t(ui, 'pdfa.why.checker_down'), code: 'checker_down' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- What an uploaded file holds that PDF/A cannot keep -----------------------------------------------------------

const MEDIA = new Set(['Sound', 'Movie', 'Screen', '3D', 'RichMedia', 'FileAttachment']);
const nameOf = (o: PDFObject | undefined) => (o instanceof PDFName ? o.decodeText() : '');

export type SourceProblem = 'font' | 'cmyk' | 'media';

/** The first thing in `bytes` (an uploaded document) that stops its pages from being PDF/A as they are, or null. */
export async function sourceProblem(bytes: Uint8Array): Promise<SourceProblem | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  } catch {
    return null; // the render reads it the same way and says what is wrong with it
  }
  const ctx = doc.context;
  const look = (o: any) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const seen = new Set<any>();
  let budget = 20_000_000; // bytes of page content read for colours: enough for any real document
  let found: SourceProblem | null = null;

  const cmykIn = (o: any) => /\/(?:DeviceCMYK)\b/.test(String(look(o)?.toString?.() || ''));
  // The operators of a content stream, strings and hex strings blanked out; null when it cannot be read (or the
  // reading budget is spent), and then every font its resources name is counted as used.
  const texts = new Map<any, string | null>();
  const textOf = (s: any): string | null => {
    if (!(s instanceof PDFRawStream)) return null;
    if (texts.has(s)) return texts.get(s)!;
    let text: string | null = null;
    if (budget > 0) try {
      const b = decodePDFRawStream(s).decode();
      budget -= b.length;
      text = Buffer.from(b).toString('latin1').replace(/\((?:\\.|[^\\)])*\)/g, ' ').replace(/<[0-9a-fA-F\s]*>/g, ' ');
    } catch {
      text = null;
    }
    texts.set(s, text);
    return text;
  };
  const contentCmyk = (s: any) => {
    const text = textOf(s);
    return text != null && (/(?:^|\s)(?:[-+]?(?:\d+\.?\d*|\.\d+)\s+){4}[kK](?=\s|$)/.test(text) || /\/(?:CS|ColorSpace)\s*\/(?:DeviceCMYK|CMYK)\b/.test(text));
  };
  // PDF/A asks for the fonts that draw something: the names a Tf operator selects. A font a file only lists, and
  // never draws with, does not stop it from being PDF/A. Null (every listed font counts) when a stream cannot be read.
  const fontsUsed = (streams: any[]): Set<string> | null => {
    const used = new Set<string>();
    for (const st of streams) {
      const text = textOf(st);
      if (text == null) return null;
      for (const m of text.matchAll(/\/([^\s\/\[\]()<>{}%]+)\s+[-+]?(?:\d+\.?\d*|\.\d+)\s+Tf(?![^\s\/\[\]()<>{}%])/g)) used.add(m[1].replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
    }
    return used;
  };
  const fontEmbedded = (f: PDFDict): boolean => {
    const sub = nameOf(f.lookup(PDFName.of('Subtype')));
    if (sub === 'Type3') return true; // its glyphs are drawn in the file itself
    let d = f;
    if (sub === 'Type0') {
      const kids = f.lookup(PDFName.of('DescendantFonts'));
      const kid = kids instanceof PDFArray ? look(kids.get(0)) : null;
      if (!(kid instanceof PDFDict)) return false;
      d = kid;
    }
    const fd = d.lookup(PDFName.of('FontDescriptor'));
    if (!(fd instanceof PDFDict)) return false;
    return ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
  };
  const walkResources = (res: any, used: Set<string> | null = null) => {
    res = look(res);
    if (!(res instanceof PDFDict) || found) return;
    const fonts = res.lookup(PDFName.of('Font'));
    // A graphics state can select a font too (gs with /Font): then every listed font counts.
    const states = res.lookup(PDFName.of('ExtGState'));
    if (states instanceof PDFDict && states.entries().some(([, st]) => { const d = look(st); return d instanceof PDFDict && d.has(PDFName.of('Font')); })) used = null;
    // Asked again for every content stream that shares these resources: another page may draw with another font.
    if (fonts instanceof PDFDict) for (const [key, f] of fonts.entries()) {
      const fd = look(f);
      if (used && !used.has(key.decodeText())) continue;
      if (fd instanceof PDFDict && !fontEmbedded(fd)) return void (found = 'font');
    }
    if (seen.has(res)) return;
    seen.add(res);
    if (fonts instanceof PDFDict) for (const [, f] of fonts.entries()) {
      const fd = look(f);
      if (fd instanceof PDFDict && nameOf(fd.lookup(PDFName.of('Subtype'))) === 'Type3') walkResources(fd.get(PDFName.of('Resources')));
    }
    const spaces = res.lookup(PDFName.of('ColorSpace'));
    if (spaces instanceof PDFDict) for (const [, cs] of spaces.entries()) if (cmykIn(cs)) return void (found = 'cmyk');
    for (const key of ['XObject', 'Pattern']) {
      const list = res.lookup(PDFName.of(key));
      if (!(list instanceof PDFDict)) continue;
      for (const [, x] of list.entries()) walkObject(look(x));
    }
  };
  const walkObject = (x: any) => {
    if (found || !x || seen.has(x)) return;
    seen.add(x);
    const dict: PDFDict | null = x instanceof PDFStream ? x.dict : x instanceof PDFDict ? x : null;
    if (!dict) return;
    const sub = nameOf(dict.lookup(PDFName.of('Subtype')));
    if (sub === 'Image') {
      if (cmykIn(dict.get(PDFName.of('ColorSpace')))) found = 'cmyk';
      return;
    }
    if (x instanceof PDFStream && contentCmyk(x)) return void (found = 'cmyk');
    walkResources(dict.get(PDFName.of('Resources')), x instanceof PDFStream ? fontsUsed([x]) : null);
  };
  for (const page of doc.getPages()) {
    if (found) break;
    const node = page.node;
    let res: any = node.get(PDFName.of('Resources'));
    for (let p: any = node; !res && p; p = look(p.get(PDFName.of('Parent')))) res = p.get(PDFName.of('Resources'));
    const contents = look(node.get(PDFName.of('Contents')));
    const streams = contents instanceof PDFArray ? contents.asArray().map(look) : contents ? [contents] : [];
    walkResources(res, fontsUsed(streams));
    for (const c of streams) if (!found && contentCmyk(c)) found = 'cmyk';
    const annots = look(node.get(PDFName.of('Annots')));
    if (annots instanceof PDFArray) for (const a of annots.asArray().map(look)) {
      if (found || !(a instanceof PDFDict)) continue;
      if (MEDIA.has(nameOf(a.lookup(PDFName.of('Subtype'))))) found = 'media';
      const ap = look(a.get(PDFName.of('AP')));
      if (ap instanceof PDFDict) for (const k of ['N', 'R', 'D']) {
        const v = look(ap.get(PDFName.of(k)));
        if (v instanceof PDFStream) walkObject(v);
        else if (v instanceof PDFDict) for (const [, s] of v.entries()) walkObject(look(s));
      }
    }
  }
  return found;
}

// ---- The plan, decided before rendering ---------------------------------------------------------------------------

export type ArchivePlan = { checker: string } | { why: string; code: WhyCode };

/** Null when this envelope's file is made as before: the switch is off, or the server has no checker set up. */
export async function archivePlan(e: any): Promise<ArchivePlan | null> {
  if (!pdfaAvailable() || !accountWantsPdfa(e.account_id)) return null;
  const checker = await checkerVersion();
  if (!checker) return { why: t(ui, 'pdfa.why.checker_down'), code: 'checker_down' };
  const sources: { sha: string; name: string | null }[] = (e.documents || []).map((d: any) => ({ sha: d.sha256, name: d.name || null }));
  for (const f of (e.fields || []).filter((f: any) => f.type === 'attachment' && f.value)) {
    const file = get('SELECT sha256 FROM files WHERE id=?', f.value);
    if (file) sources.push({ sha: file.sha256, name: null });
  }
  for (const s of sources) {
    let bytes: Buffer;
    try {
      bytes = readBlob(s.sha);
    } catch {
      continue; // the render meets the same file and fails or leaves it out as it always does
    }
    const p = await sourceProblem(bytes);
    if (p) return s.name ? { why: t(ui, `pdfa.why.${p}`, { name: s.name }), code: p } : { why: t(ui, `pdfa.why.${p}_attached`), code: 'attached' };
  }
  return { checker };
}

/** The certificate's line about the archive format of its own file: null unless the switch is on. */
export function pdfaLineFor(e: any): string | null {
  const p: ArchivePlan | undefined = e?.pdfa_plan;
  if (!p) return null;
  return 'checker' in p ? t(ui, 'pdfa.line.passed', { checker: p.checker }) : t(ui, 'pdfa.line.not', { why: p.why });
}

// ---- Turning a rendered file into PDF/A-2b ------------------------------------------------------------------------

const SRGB = 'sRGB IEC61966-2.1';
const FORBIDDEN_ACTIONS = new Set(['Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'Hide', 'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView', 'JavaScript']);
const NAMED_OK = new Set(['NextPage', 'PrevPage', 'FirstPage', 'LastPage']);

function srgbProfile(): Buffer {
  return (g.__sgsrgb ??= fs.readFileSync(path.join(/* turbopackIgnore: true */ process.cwd(), 'assets', 'icc', 'sRGB.icc')));
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function xmp(o: { title: string; at: Date; id: string }): string {
  const when = isoSeconds(o.at);
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(o.title)}</rdf:li></rdf:Alt></dc:title>
   <xmp:CreateDate>${when}</xmp:CreateDate>
   <xmp:ModifyDate>${when}</xmp:ModifyDate>
   <xmp:MetadataDate>${when}</xmp:MetadataDate>
   <xmp:CreatorTool>GrowSigning</xmp:CreatorTool>
   <pdf:Producer>GrowSigning</pdf:Producer>
   <xmpMM:DocumentID>uuid:${o.id}</xmpMM:DocumentID>
   <xmpMM:InstanceID>uuid:${o.id}</xmpMM:InstanceID>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** `pdf` (as renderEnvelopePdf made it) as PDF/A-2b: the pages are not changed, only what describes the file. */
export async function toPdfA(pdf: Uint8Array, title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  if (doc.isEncrypted) throw new Error('an encrypted PDF cannot be made PDF/A');
  const ctx = doc.context;
  const look = (o: any) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const cat = doc.catalog;

  const badAction = (a: any, depth = 0): boolean => {
    a = look(a);
    if (a instanceof PDFArray) return depth < 20 && a.asArray().some((x) => badAction(x, depth + 1));
    if (!(a instanceof PDFDict) || depth > 20) return false;
    const s = nameOf(a.lookup(PDFName.of('S')));
    if (FORBIDDEN_ACTIONS.has(s) || (s === 'Named' && !NAMED_OK.has(nameOf(a.lookup(PDFName.of('N')))))) return true;
    return badAction(a.get(PDFName.of('Next')), depth + 1);
  };

  // No JavaScript and no actions that run anything, at the level of the document.
  cat.delete(PDFName.of('AA'));
  cat.delete(PDFName.of('Perms'));
  if (badAction(cat.get(PDFName.of('OpenAction')))) cat.delete(PDFName.of('OpenAction'));
  const names = look(cat.get(PDFName.of('Names')));
  if (names instanceof PDFDict) names.delete(PDFName.of('JavaScript'));
  const form = look(cat.get(PDFName.of('AcroForm')));
  if (form instanceof PDFDict) {
    form.delete(PDFName.of('XFA'));
    form.delete(PDFName.of('NeedAppearances'));
  }

  // Every page: no actions of its own; annotations that cannot be seen are taken away (nothing on the page changes),
  // the rest are printable, and none runs an action PDF/A forbids.
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of('AA'));
    const annots = look(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    const keep: PDFObject[] = [];
    for (const ref of annots.asArray()) {
      const a = look(ref);
      if (!(a instanceof PDFDict)) continue;
      const flags = (a.lookup(PDFName.of('F')) as PDFNumber | undefined)?.asNumber?.() ?? 0;
      const popup = nameOf(a.lookup(PDFName.of('Subtype'))) === 'Popup';
      if (!popup && flags & (1 | 2 | 32)) continue;
      if (!popup) a.set(PDFName.of('F'), PDFNumber.of((flags | 4) & ~(1 | 2 | 32 | 256)));
      a.delete(PDFName.of('AA'));
      if (badAction(a.get(PDFName.of('A')))) a.delete(PDFName.of('A'));
      keep.push(ref);
    }
    page.node.set(PDFName.of('Annots'), ctx.obj(keep));
  }

  // Pictures and graphics states: what PDF/A forbids and changes nothing that is seen.
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    const d: PDFDict | null = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (!d) continue;
    const sub = nameOf(d.lookup(PDFName.of('Subtype')));
    if (sub === 'Image') {
      if (d.has(PDFName.of('Interpolate'))) d.set(PDFName.of('Interpolate'), PDFBool.False);
      d.delete(PDFName.of('Alternates'));
      d.delete(PDFName.of('OPI'));
    } else if (sub === 'Form') d.delete(PDFName.of('OPI'));
    if (nameOf(d.lookup(PDFName.of('Type'))) === 'ExtGState' || d.has(PDFName.of('TR'))) {
      d.delete(PDFName.of('TR'));
      if (d.has(PDFName.of('TR2'))) d.set(PDFName.of('TR2'), PDFName.of('Default'));
    }
  }

  // The description of the file: the same title, tool and dates in the information dictionary and in the XMP.
  const at = new Date(Math.floor(Date.now() / 1000) * 1000);
  const clean = String(title || 'Signed document').replace(/[\u0000-\u001f\u007f￾￿]/g, ' ').trim() || 'Signed document';
  const info = look(ctx.trailerInfo.Info);
  if (info instanceof PDFDict) for (const k of ['Author', 'Subject', 'Keywords', 'Trapped']) info.delete(PDFName.of(k));
  doc.setTitle(clean);
  doc.setProducer('GrowSigning');
  doc.setCreator('GrowSigning');
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  const id = crypto.randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
  const meta = ctx.stream(Buffer.from(xmp({ title: clean, at, id }), 'utf8'), { Type: 'Metadata', Subtype: 'XML' });
  cat.set(PDFName.of('Metadata'), ctx.register(meta));
  const icc = ctx.flateStream(srgbProfile(), { N: 3 });
  cat.set(PDFName.of('OutputIntents'), ctx.obj([ctx.obj({ Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of(SRGB), Info: PDFString.of(SRGB), RegistryName: PDFString.of('http://www.color.org'), DestOutputProfile: ctx.register(icc) })]));
  const hex = PDFHexString.of(id.replace(/-/g, ''));
  ctx.trailerInfo.ID = ctx.obj([hex, hex]);
  return doc.save();
}

// ---- The run, and what came of it ---------------------------------------------------------------------------------

type Render = (e: any) => Promise<Uint8Array>;
type Finish = (e: any, render: Render) => Promise<Uint8Array>;
type Outcome = { state: 'passed'; checker: string } | { state: 'not'; why: string; code: WhyCode };
const outcomes = new WeakMap<Uint8Array, Outcome>();

// ---- One check at a time, or two ------------------------------------------------------------------------------------
// Each veraPDF check is a Java program of a few hundred MB. At most CHECKS_AT_ONCE run at once; the rest wait in line,
// at most CHECKS_WAITING in all and PER_ACCOUNT_IN_LINE for one account (running and waiting). A file that finds the
// line full is made as a normal PDF that says "the check was busy": the document completes either way, and one
// account completing many documents at once never fills the server's memory or holds up everyone else's checks.
export const CHECKS_AT_ONCE = 2;
export const CHECKS_WAITING = 20;
export const PER_ACCOUNT_IN_LINE = 4;
const line: { running: number; waiting: (() => void)[]; mine: Map<string, number>; most: number } = (g.__sgpdfaline ??= { running: 0, waiting: [], mine: new Map(), most: 0 });

async function checkInLine(accountId: string, pdf: Uint8Array): Promise<Checked> {
  const mine = line.mine.get(accountId) || 0;
  if (mine >= PER_ACCOUNT_IN_LINE || line.waiting.length >= CHECKS_WAITING) return { passed: false, why: t(ui, 'pdfa.why.busy'), code: 'busy' };
  line.mine.set(accountId, mine + 1);
  try {
    if (line.running >= CHECKS_AT_ONCE) await new Promise<void>((r) => line.waiting.push(r));
    else line.running++;
    line.most = Math.max(line.most, line.running);
    try {
      return await checkPdfA(pdf);
    } finally {
      const next = line.waiting.shift();
      if (next) next();
      else line.running--;
    }
  } finally {
    const n = (line.mine.get(accountId) || 1) - 1;
    if (n) line.mine.set(accountId, n);
    else line.mine.delete(accountId);
  }
}

/** For tests: how many checks ran at once at most since the last call, and how many run and wait now. */
export function checkLine(reset = false) {
  const r = { most: line.most, running: line.running, waiting: line.waiting.length };
  if (reset) line.most = line.running;
  return r;
}

// ---- The signer is not kept waiting ---------------------------------------------------------------------------------
// With the switch on, the last person's Finish would otherwise wait for the check (Java starts in seconds, and a
// check may take up to VERAPDF_TIMEOUT_MS). advance (envelopes.ts) asks completesLater first: when it says yes, the
// envelope is marked completed at once and the signed file, the history lines and the "completed" emails follow as
// soon as the check is done, in the background (later). The emails still carry the finished file.
export const completesLater = (e: any) => pdfaAvailable() && accountWantsPdfa(e?.account_id);

const pending = new Set<Promise<unknown>>();
export function later(what: string, work: () => Promise<unknown>) {
  // Started at once, so what the work does before its first wait (marking the envelope completed) is done on return.
  const p = (async () => work())().catch((err) => console.error(`[pdfa] ${what} failed in the background`, err?.message));
  pending.add(p);
  p.finally(() => pending.delete(p));
}
/** For tests and a clean stop: resolves once nothing runs in the background any more. */
export async function idle() {
  while (pending.size) await Promise.allSettled([...pending]);
}

// The timer may try to build the same envelope's file while the first build waits for its check. It then waits for
// that same run instead of starting a second check, and gets a copy of its bytes: the copy is the same file, so
// storing it changes nothing, and the history is written once, by the first build.
const running = new Map<string, Promise<Uint8Array>>();

/**
 * A render that is thrown away (it could not be made PDF/A, so the run is made again as a normal file). finishSealed
 * (finalpipe.ts) neither seals nor time-stamps it: with a cloud seal each seal is a paid signing.
 */
export const discarded = new WeakSet<Uint8Array>();

/**
 * Runs `finish` (the seal and what follows it) over the envelope, in the archive format when the account asked for
 * it. With the switch off or no checker: `finish(e, render)` exactly.
 */
export async function inArchiveFormat(e: any, render: Render, finish: Finish): Promise<Uint8Array> {
  const plan = await archivePlan(e);
  if (!plan) return finish(e, render);
  const already = running.get(e.id);
  if (already) return new Uint8Array(await already);
  const job = archiveRun(e, plan, render, finish);
  running.set(e.id, job);
  try {
    return await job;
  } finally {
    running.delete(e.id);
  }
}

async function archiveRun(e: any, plan: ArchivePlan, render: Render, finish: Finish): Promise<Uint8Array> {
  const normal = async (why: string, code: WhyCode) => {
    const pdf = await finish({ ...e, pdfa_plan: { why, code } }, render);
    outcomes.set(pdf, { state: 'not', why, code });
    return pdf;
  };
  if ('why' in plan) return normal(plan.why, plan.code);
  let broke: any = null;
  const asPdfA: Render = async (x) => {
    const b = await render(x);
    try {
      return await toPdfA(b, x.subject);
    } catch (err) {
      broke = err;
      discarded.add(b); // never stored: the run is made again below as a normal file, so it is not sealed (finalpipe.ts)
      return b;
    }
  };
  const made = await finish({ ...e, pdfa_plan: plan }, asPdfA);
  if (broke) {
    console.error('[pdfa] a completed file could not be made PDF/A, so it was made as a normal PDF', e.id, broke?.message);
    return normal(t(ui, 'pdfa.why.convert'), 'convert');
  }
  const check = await checkInLine(String(e.account_id || ''), made);
  if (!check.passed) return normal(check.why, check.code);
  outcomes.set(made, { state: 'passed', checker: plan.checker });
  return made;
}

/** After buildFinal stored `pdf` for `e`: what came of the archive format, on the envelope and in its history. */
export function archiveStored(e: any, pdf: Uint8Array, sha: string) {
  const o = outcomes.get(pdf);
  if (!o) return;
  if (!get('SELECT 1 x FROM envelopes WHERE id=? AND final_sha256=?', e.id, sha)) return;
  if (o.state === 'passed') {
    run('UPDATE envelopes SET pdfa=?, pdfa_note=NULL, pdfa_checker=? WHERE id=?', 'passed', o.checker, e.id);
    audit(e.id, { name: 'System' }, 'Archive format: PDF/A-2b', `${o.checker} checked the signed PDF, seal included, and passed it as PDF/A-2b, an archive format some archives require.`);
  } else {
    run('UPDATE envelopes SET pdfa=?, pdfa_note=?, pdfa_code=?, pdfa_checker=NULL WHERE id=?', 'not', o.why, o.code, e.id);
    audit(e.id, { name: 'System' }, 'Archive format: not PDF/A', `The signed PDF was made as a normal PDF, not PDF/A, because ${o.why}. Its signing record says so. ${nextStep(o.code)}`);
  }
}

/** For GET /envelopes/:id: { pdfa: true, checker } or { pdfa: false, why }, or null when nothing was asked for. */
export function pdfaFacts(e: any): { pdfa: true; checker: string } | { pdfa: false; why: string; next: string } | null {
  if (e?.pdfa === 'passed' && e.pdfa_checker) return { pdfa: true, checker: e.pdfa_checker };
  if (e?.pdfa === 'not') return { pdfa: false, why: e.pdfa_note || '', next: nextStep(e.pdfa_code) };
  return null;
}
