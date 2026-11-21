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
// What came of it is stored on the envelope (pdfa, pdfa_note, pdfa_checker) once the file is stored (archiveStored),
// shown under "Checks on the file" and written in the history.
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

export type Checked = { passed: true } | { passed: false; why: string };

/** veraPDF's verdict on `pdf` as PDF/A-2b, from its machine-readable report. Anything but a clear pass is a "no". */
export async function checkPdfA(pdf: Uint8Array): Promise<Checked> {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'signed.pdf');
    fs.writeFileSync(file, pdf, { mode: 0o600 });
    const ms = checkerTimeoutMs();
    const r = await runChecker(['--flavour', '2b', '--format', 'mrr', file], ms, dir);
    if (r.timedOut) return { passed: false, why: t(ui, 'pdfa.why.slow', { seconds: Math.round(ms / 1000) }) };
    const report = /<validationReport\b[^>]*>/.exec(r.out)?.[0];
    if (!report) {
      console.error(`[pdfa] veraPDF gave no report (${r.failed || `exit ${r.code}`}): ${r.err.trim().slice(0, 300)}`);
      return { passed: false, why: t(ui, 'pdfa.why.checker_down') };
    }
    const profile = /profileName="([^"]*)"/.exec(report)?.[1] || '';
    if (/isCompliant="true"/.test(report) && /2b\b/i.test(profile) && !/jobEndStatus="(?!normal)/.test(report)) return { passed: true };
    const failed = Number(/<details\b[^>]*failedRules="(\d+)"/.exec(r.out)?.[1] || 0);
    const clauses = [...r.out.matchAll(/<rule\b[^>]*clause="([^"]+)"[^>]*status="failed"|<rule\b[^>]*status="failed"[^>]*clause="([^"]+)"/g)].map((m) => m[1] || m[2]);
    console.error(`[pdfa] veraPDF did not pass a completed file as PDF/A-2b (${failed} rules, clauses ${[...new Set(clauses)].slice(0, 12).join(', ') || 'not named'}). It was made again as a normal PDF.`);
    return { passed: false, why: failed ? t(ui, 'pdfa.why.failed', { count: failed }) : t(ui, 'pdfa.why.checker_down') };
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
  const contentCmyk = (s: any) => {
    if (!(s instanceof PDFRawStream) || budget <= 0) return false;
    let text: string;
    try {
      const b = decodePDFRawStream(s).decode();
      budget -= b.length;
      text = Buffer.from(b).toString('latin1');
    } catch {
      return false;
    }
    text = text.replace(/\((?:\\.|[^\\)])*\)/g, ' ').replace(/<[0-9a-fA-F\s]*>/g, ' ');
    return /(?:^|\s)(?:[-+]?(?:\d+\.?\d*|\.\d+)\s+){4}[kK](?=\s|$)/.test(text) || /\/(?:CS|ColorSpace)\s*\/(?:DeviceCMYK|CMYK)\b/.test(text);
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
  const walkResources = (res: any) => {
    res = look(res);
    if (!(res instanceof PDFDict) || seen.has(res) || found) return;
    seen.add(res);
    const fonts = res.lookup(PDFName.of('Font'));
    if (fonts instanceof PDFDict) for (const [, f] of fonts.entries()) {
      const fd = look(f);
      if (fd instanceof PDFDict && !fontEmbedded(fd)) return void (found = 'font');
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
    walkResources(dict.get(PDFName.of('Resources')));
  };
  for (const page of doc.getPages()) {
    if (found) break;
    const node = page.node;
    let res: any = node.get(PDFName.of('Resources'));
    for (let p: any = node; !res && p; p = look(p.get(PDFName.of('Parent')))) res = p.get(PDFName.of('Resources'));
    walkResources(res);
    const contents = look(node.get(PDFName.of('Contents')));
    for (const c of contents instanceof PDFArray ? contents.asArray().map(look) : [contents]) if (!found && contentCmyk(c)) found = 'cmyk';
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

export type ArchivePlan = { checker: string } | { why: string };

/** Null when this envelope's file is made as before: the switch is off, or the server has no checker set up. */
export async function archivePlan(e: any): Promise<ArchivePlan | null> {
  if (!pdfaAvailable() || !accountWantsPdfa(e.account_id)) return null;
  const checker = await checkerVersion();
  if (!checker) return { why: t(ui, 'pdfa.why.checker_down') };
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
    if (p) return { why: s.name ? t(ui, `pdfa.why.${p}`, { name: s.name }) : t(ui, `pdfa.why.${p}_attached`) };
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
type Outcome = { state: 'passed'; checker: string } | { state: 'not'; why: string };
const outcomes = new WeakMap<Uint8Array, Outcome>();

/**
 * Runs `finish` (the seal and what follows it) over the envelope, in the archive format when the account asked for
 * it. With the switch off or no checker: `finish(e, render)` exactly.
 */
export async function inArchiveFormat(e: any, render: Render, finish: Finish): Promise<Uint8Array> {
  const plan = await archivePlan(e);
  if (!plan) return finish(e, render);
  const normal = async (why: string) => {
    const pdf = await finish({ ...e, pdfa_plan: { why } }, render);
    outcomes.set(pdf, { state: 'not', why });
    return pdf;
  };
  if ('why' in plan) return normal(plan.why);
  let broke: any = null;
  const asPdfA: Render = async (x) => {
    const b = await render(x);
    try {
      return await toPdfA(b, x.subject);
    } catch (err) {
      broke = err;
      return b; // never stored: the run is made again below as a normal file
    }
  };
  const made = await finish({ ...e, pdfa_plan: plan }, asPdfA);
  if (broke) {
    console.error('[pdfa] a completed file could not be made PDF/A, so it was made as a normal PDF', e.id, broke?.message);
    return normal(t(ui, 'pdfa.why.convert'));
  }
  const check = await checkPdfA(made);
  if (!check.passed) return normal(check.why);
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
    run('UPDATE envelopes SET pdfa=?, pdfa_note=?, pdfa_checker=NULL WHERE id=?', 'not', o.why, e.id);
    audit(e.id, { name: 'System' }, 'Archive format: not PDF/A', `The signed PDF was made as a normal PDF, not PDF/A, because ${o.why}. Its certificate of completion says so.`);
  }
}

/** For GET /envelopes/:id: { pdfa: true, checker } or { pdfa: false, why }, or null when nothing was asked for. */
export function pdfaFacts(e: any): { pdfa: true; checker: string } | { pdfa: false; why: string } | null {
  if (e?.pdfa === 'passed' && e.pdfa_checker) return { pdfa: true, checker: e.pdfa_checker };
  if (e?.pdfa === 'not') return { pdfa: false, why: e.pdfa_note || '' };
  return null;
}
