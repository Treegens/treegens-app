import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFPage, PDFFont, PDFName, PDFDict, PDFRef, PDFArray, PDFNumber, PDFStream, rgb, degrees, pushGraphicsState, popGraphicsState, translate, drawObject } from 'pdf-lib';
import fontkitMod from '@pdf-lib/fontkit';
import { readBlob, get } from './db.ts';
import { bad } from './util.ts';
import { impactOf, fmtTrees, fmtNum, PRICING } from '../lib/impact.ts';
import { formatDate } from '../lib/dates.ts';

const fontkit: any = (fontkitMod as any).default || fontkitMod;
const GREEN = rgb(0.12, 0.44, 0.26);
const INK = rgb(0.11, 0.16, 0.13);
const MUTED = rgb(0.42, 0.47, 0.44);
const RULE = rgb(0.86, 0.87, 0.84);

const g = globalThis as any;
function fontBytes(name: string): Buffer {
  g.__tsfonts ??= {};
  return (g.__tsfonts[name] ??= fs.readFileSync(path.join(/* turbopackIgnore: true */ process.cwd(), 'assets', 'fonts', name)));
}

// Strip control characters pdf-lib cannot lay out.
const clean = (s: any) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\t/g, ' ');

export type PageSize = { w: number; h: number };

// Validate an uploaded PDF and read its page geometry (as displayed, i.e. after rotation).
export async function inspectPdf(buf: Uint8Array): Promise<{ pages: number; sizes: PageSize[] }> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buf, { updateMetadata: false });
  } catch (e: any) {
    if (/encrypted/i.test(String(e?.message))) throw bad('This PDF is password protected. Remove the password and upload it again.');
    throw bad('That file could not be read as a PDF.');
  }
  const sizes = doc.getPages().map((p) => {
    const b = p.getCropBox();
    const rot = ((p.getRotation().angle % 360) + 360) % 360;
    return rot % 180 ? { w: b.height, h: b.width } : { w: b.width, h: b.height };
  });
  if (!sizes.length) throw bad('That PDF has no pages.');
  return { pages: sizes.length, sizes };
}

// Wrap a PNG or JPEG in a single-page PDF so images can be sent for signature too.
export async function imageToPdf(buf: Uint8Array, mime: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  let img;
  try {
    img = mime === 'image/png' ? await doc.embedPng(buf) : await doc.embedJpg(buf);
  } catch {
    throw bad('That image could not be read. Use a PNG or JPEG.');
  }
  const W = 595.28;
  const H = 841.89;
  const scale = Math.min((W - 48) / img.width, (H - 48) / img.height, 1);
  const page = doc.addPage([W, H]);
  page.drawImage(img, { x: (W - img.width * scale) / 2, y: (H - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
  return doc.save();
}

function dataUrlBytes(url: string | null | undefined): { bytes: Buffer; png: boolean } | null {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(url || '');
  return m ? { bytes: Buffer.from(m[2], 'base64'), png: m[1] === 'png' } : null;
}

// Maps coordinates given in the displayed page (origin top-left, y down) to PDF user space, honouring /Rotate.
function mapper(page: PDFPage) {
  const b = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const W = rot % 180 ? b.height : b.width;
  const H = rot % 180 ? b.width : b.height;
  const pt = (vx: number, vy: number) =>
    rot === 0 ? { x: b.x + vx, y: b.y + b.height - vy }
    : rot === 90 ? { x: b.x + vy, y: b.y + vx }
    : rot === 180 ? { x: b.x + b.width - vx, y: b.y + vy }
    : { x: b.x + b.width - vy, y: b.y + b.height - vx };
  return { W, H, pt, rotate: degrees(rot) };
}

function fitText(font: PDFFont, text: string, maxW: number, size: number, min = 5) {
  while (size > min && font.widthOfTextAtSize(text, size) > maxW) size -= 0.5;
  return size;
}

function wrap(font: PDFFont, text: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(next, size) > maxW) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

type Ctx = { doc: PDFDocument; font: PDFFont; bold: PDFFont; images: Map<string, any>; recipients: Map<string, any>; dateFormat?: string | null };

async function image(ctx: Ctx, dataUrl: string | null | undefined) {
  if (!dataUrl) return null;
  if (ctx.images.has(dataUrl)) return ctx.images.get(dataUrl);
  const d = dataUrlBytes(dataUrl);
  let img: any = null;
  if (d) {
    try {
      img = d.png ? await ctx.doc.embedPng(d.bytes) : await ctx.doc.embedJpg(d.bytes);
    } catch {
      img = null;
    }
  }
  ctx.images.set(dataUrl, img);
  return img;
}

export function fieldDisplayValue(f: any, r: any, dateFormat?: string | null): string {
  switch (f.type) {
    case 'full_name': return r?.status === 'completed' ? r.name : '';
    case 'email': return r?.status === 'completed' ? r.email : '';
    case 'date_signed': return r?.completed_at ? formatDate(r.completed_at, dateFormat) : '';
    default: return f.value || '';
  }
}

async function drawField(ctx: Ctx, page: PDFPage, f: any) {
  const m = mapper(page);
  const vx = f.x * m.W, vy = f.y * m.H, vw = f.w * m.W, vh = f.h * m.H;
  const r = f.recipient_id ? ctx.recipients.get(f.recipient_id) : null;

  if (f.type === 'signature' || f.type === 'initials') {
    if (!f.value || !r) return;
    const img = await image(ctx, f.type === 'signature' ? r.signature_png : r.initials_png || r.signature_png);
    if (!img) return;
    const caption = f.type === 'signature' && vh >= 30;
    const availH = caption ? vh - 7 : vh;
    const s = Math.min(vw / img.width, availH / img.height);
    const w = img.width * s, h = img.height * s;
    const p = m.pt(vx + (vw - w) / 2, vy + (availH + h) / 2);
    page.drawImage(img, { x: p.x, y: p.y, width: w, height: h, rotate: m.rotate });
    if (caption) {
      const c = m.pt(vx, vy + vh - 1);
      page.drawText(`Signed via Sign&Grow · ${String(r.id).slice(-8)}`, { x: c.x, y: c.y, size: 4.5, font: ctx.font, color: GREEN, rotate: m.rotate });
    }
    return;
  }
  if (f.type === 'checkbox') {
    if (f.value !== '1') return;
    const pad = Math.min(vw, vh) * 0.2, t = Math.max(1, Math.min(vw, vh) * 0.12);
    const a = m.pt(vx + pad, vy + vh * 0.55), b = m.pt(vx + vw * 0.42, vy + vh - pad), c = m.pt(vx + vw - pad, vy + pad);
    page.drawLine({ start: a, end: b, thickness: t, color: INK });
    page.drawLine({ start: b, end: c, thickness: t, color: INK });
    return;
  }
  if (f.type === 'radio') {
    if (f.value !== '1') return;
    const c = m.pt(vx + vw / 2, vy + vh / 2);
    page.drawCircle({ x: c.x, y: c.y, size: Math.min(vw, vh) * 0.28, color: INK });
    return;
  }
  if (f.type === 'attachment') return;

  const text = clean(fieldDisplayValue(f, r, ctx.dateFormat));
  if (!text) return;
  const base = Math.max(6, Math.min(11, vh * 0.62));
  const multi = vh > base * 2.6 || text.includes('\n');
  if (multi) {
    const size = Math.min(base, 10);
    const lh = size * 1.3;
    const lines = wrap(ctx.font, text, size, vw - 4).slice(0, Math.max(1, Math.floor(vh / lh)));
    lines.forEach((ln, i) => {
      const p = m.pt(vx + 2, vy + size + 1 + i * lh);
      page.drawText(ln, { x: p.x, y: p.y, size, font: ctx.font, color: INK, rotate: m.rotate });
    });
  } else {
    const size = fitText(ctx.font, text, vw - 4, base);
    const p = m.pt(vx + 2, vy + vh / 2 + size * 0.35);
    page.drawText(text, { x: p.x, y: p.y, size, font: ctx.font, color: INK, rotate: m.rotate });
  }
}

// ---- Certificate of completion -------------------------------------------------------------

class Sheet {
  page!: PDFPage;
  y = 0;
  readonly W = 595.28;
  readonly H = 841.89;
  readonly L = 48;
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  footer: string;
  constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont, footer: string) {
    this.doc = doc;
    this.font = font;
    this.bold = bold;
    this.footer = footer;
    this.add();
  }
  add() {
    this.page = this.doc.addPage([this.W, this.H]);
    this.page.drawText(this.footer, { x: this.L, y: 28, size: 7, font: this.font, color: MUTED });
    this.y = this.H - 56;
  }
  need(h: number) {
    if (this.y - h < 52) this.add();
  }
  text(s: string, o: { size?: number; bold?: boolean; color?: any; x?: number; gap?: number; maxW?: number } = {}) {
    const size = o.size ?? 9;
    const font = o.bold ? this.bold : this.font;
    const x = o.x ?? this.L;
    for (const ln of wrap(font, clean(s), size, o.maxW ?? this.W - x - this.L)) {
      this.need(size * 1.45);
      this.page.drawText(ln, { x, y: this.y - size, size, font, color: o.color ?? INK });
      this.y -= size * 1.45;
    }
    this.y -= o.gap ?? 0;
  }
  kv(k: string, v: string, x = this.L, kw = 110) {
    this.need(13);
    this.page.drawText(clean(k), { x, y: this.y - 8.5, size: 8.5, font: this.font, color: MUTED });
    const startY = this.y;
    this.text(v || '-', { size: 8.5, x: x + kw });
    if (this.y > startY - 12.3) this.y = startY - 12.3;
  }
  rule(gap = 10) {
    this.need(gap * 2);
    this.y -= gap;
    this.page.drawLine({ start: { x: this.L, y: this.y }, end: { x: this.W - this.L, y: this.y }, thickness: 0.6, color: RULE });
    this.y -= gap;
  }
  h2(s: string) {
    this.need(40);
    this.y -= 6;
    this.text(s.toUpperCase(), { size: 8, bold: true, color: GREEN, gap: 4 });
  }
}

const ROLE_LABEL: Record<string, string> = { signer: 'Signer', approver: 'Approver', cc: 'Receives a copy', viewer: 'Needs to view', inperson: 'In-person signer' };
const ts = (s: string | null | undefined) => (s ? s.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '-');

async function drawCertificate(ctx: Ctx, e: any, audit: any[], sender: any) {
  const s = new Sheet(ctx.doc, ctx.font, ctx.bold, `Sign&Grow · Certificate of Completion · Envelope ${e.id}`);
  // Header band
  s.page.drawRectangle({ x: 0, y: s.H - 92, width: s.W, height: 92, color: GREEN });
  s.page.drawSvgPath('M0 22 C0 8 10 0 24 0 C24 14 16 24 2 24 Z', { x: s.L, y: s.H - 30, color: rgb(1, 1, 1), scale: 1.2 });
  s.page.drawText('Certificate of Completion', { x: s.L + 40, y: s.H - 52, size: 20, font: ctx.bold, color: rgb(1, 1, 1) });
  s.page.drawText('Sign&Grow · e-signatures that plant trees', { x: s.L + 40, y: s.H - 68, size: 9, font: ctx.font, color: rgb(0.85, 0.94, 0.88) });
  s.y = s.H - 112;

  s.h2('Envelope');
  s.kv('Envelope ID', e.id);
  s.kv('Subject', e.subject || '(no subject)');
  s.kv('Status', e.status === 'completed' ? 'Completed' : e.status);
  s.kv('Sender', sender ? `${sender.name} <${sender.email}>` : '-');
  s.kv('Sent', ts(e.sent_at));
  s.kv('Completed', ts(e.completed_at));
  s.kv('Signing order', e.ordered ? 'Sequential' : 'Everyone at once');

  s.h2('Documents');
  for (const d of e.documents) {
    s.text(`${d.name} (${d.pages} page${d.pages === 1 ? '' : 's'})`, { size: 9, bold: true });
    s.text(`SHA-256 of the original: ${d.sha256}`, { size: 7, color: MUTED, gap: 3 });
  }

  s.h2('Recipients');
  for (const r of e.recipients) {
    s.need(96);
    const top = s.y;
    s.text(`${r.name}  <${r.email}>`, { size: 10, bold: true, maxW: 330 });
    s.kv('Role', ROLE_LABEL[r.role] || r.role);
    s.kv('Status', r.status === 'completed' ? (r.role === 'cc' ? 'Copied' : r.role === 'viewer' ? 'Viewed' : r.role === 'approver' ? 'Approved' : 'Signed') : r.status);
    s.kv('Sent', ts(r.sent_at));
    if (r.role !== 'cc') {
      s.kv('Viewed', ts(r.viewed_at));
      s.kv('Completed', ts(r.completed_at));
      s.kv('Identity check', r.access_code ? 'Email link and access code' : 'Email link');
      s.kv('E-record consent', ts(r.consent_at));
      s.kv('IP address', r.ip || '-');
      if (r.reassigned_from) s.kv('Reassigned from', r.reassigned_from);
    }
    const img = await image(ctx, r.signature_png);
    if (img && s.y < top) {
      const sc = Math.min(150 / img.width, 54 / img.height);
      const x = s.W - s.L - 160;
      s.page.drawRectangle({ x, y: top - 72, width: 160, height: 66, borderColor: RULE, borderWidth: 0.6 });
      s.page.drawImage(img, { x: x + (160 - img.width * sc) / 2, y: top - 72 + (66 - img.height * sc) / 2, width: img.width * sc, height: img.height * sc });
    }
    s.rule(6);
  }

  s.h2('Audit trail');
  s.text('Each event is hashed together with the one before it, so the history cannot be edited without breaking the chain.', { size: 7.5, color: MUTED, gap: 4 });
  for (const a of audit) {
    s.need(24);
    const y0 = s.y;
    s.page.drawText(ts(a.at), { x: s.L, y: y0 - 8, size: 7.5, font: ctx.font, color: MUTED });
    s.text(`${a.action}${a.detail ? ` · ${a.detail}` : ''}`, { size: 8, x: s.L + 118, maxW: 330 });
    s.text(`${a.actor}${a.ip ? ` · ${a.ip}` : ''} · ${a.hash.slice(0, 16)}`, { size: 6.5, x: s.L + 118, color: MUTED, gap: 3 });
  }
  if (audit.length) s.kv('Chain head', audit[audit.length - 1].hash, s.L, 70);

  const i = impactOf(e.sheets || 0);
  s.need(90);
  s.y -= 10;
  s.page.drawRectangle({ x: s.L, y: s.y - 62, width: s.W - 2 * s.L, height: 62, color: rgb(0.93, 0.97, 0.93) });
  s.page.drawText('Signed without paper', { x: s.L + 14, y: s.y - 20, size: 11, font: ctx.bold, color: GREEN });
  s.page.drawText(
    clean(`About ${fmtNum(i.sheets)} sheets of paper, ${fmtNum(i.litresWater)} litres of water and ${fmtNum(i.kgCo2, 2)} kg of CO2e were not used`),
    { x: s.L + 14, y: s.y - 36, size: 8.5, font: ctx.font, color: INK },
  );
  s.page.drawText(
    clean(`(${fmtTrees(i.trees)} of a tree, estimated). Every dollar paid to Sign&Grow plants ${PRICING.treesPerUsd} mangrove trees with Treegens.`),
    { x: s.L + 14, y: s.y - 49, size: 8.5, font: ctx.font, color: INK },
  );
}

// ---- Fillable forms in uploaded documents ---------------------------------------------------

const nm = (s: string) => PDFName.of(s);

// Something a form keeps on the field or on one of its parents: the kind of field (FT) or what is filled in (V).
function inherited(widget: PDFDict, key: string) {
  for (let d: any = widget, hops = 0; d instanceof PDFDict && hops < 32; d = d.lookup(nm('Parent')), hops++) {
    const v = d.lookup(nm(key));
    if (v !== undefined) return v;
  }
}

// The picture a form field shows on the page right now, if it has one.
function widgetPicture(widget: PDFDict): PDFRef | undefined {
  const ap = widget.lookup(nm('AP'));
  let n = ap instanceof PDFDict ? ap.get(nm('N')) : undefined;
  const states = n instanceof PDFRef ? widget.context.lookup(n) : n;
  // A check box or radio button has one picture per state, and the page shows the one the field is in.
  if (states instanceof PDFDict) {
    const state = widget.lookup(nm('AS')) ?? inherited(widget, 'V');
    n = (state instanceof PDFName && states.get(state)) || states.get(nm('Off'));
  }
  return n instanceof PDFRef && widget.context.lookup(n) instanceof PDFStream ? n : undefined;
}

// A fillable form the sender uploaded becomes ordinary page content, so the signed file has nothing left to fill in,
// to change or to sign later. Each field's picture is drawn where the field was, then the field is taken off the
// page. A field with no picture and nothing in it is just taken off: the usual one is an empty digital-signature
// box, which must not be left waiting in a document that is already signed. pdf-lib's own flatten() is not used. It
// gives up at the first field without a picture, which left every field after it live, and it leaves each page
// pointing at field objects it has deleted, which strict readers and filing systems reject.
function flattenForm(src: PDFDocument) {
  try {
    const form = src.getForm();
    for (const field of form.getFields()) {
      try {
        if (field.needsAppearancesUpdate()) field.defaultUpdateAppearances(form.getDefaultFont());
      } catch {
        /* this field keeps the picture it came with, if it has one */
      }
    }
  } catch {
    /* no readable form: the pages are still gone through below */
  }
  for (const page of src.getPages()) {
    const annots = page.node.Annots();
    for (let i = 0; annots && i < annots.size(); ) {
      const a = annots.lookup(i);
      const widget = a instanceof PDFDict && a.lookup(nm('Subtype')) === nm('Widget') ? a : null;
      // Links, comments and the like stay as they are. An entry that points at nothing is dropped.
      if (a instanceof PDFDict && !widget) {
        i++;
        continue;
      }
      if (widget) {
        const picture = widgetPicture(widget);
        const value: any = inherited(widget, 'V');
        const filled = value !== undefined && value !== nm('Off') && value.decodeText?.() !== '';
        // Filled in but with no picture we could draw (text in a script the built-in font cannot write, say): the
        // field stays as it is, because taking it off would take what it says out of a document people signed.
        if (!picture && filled && inherited(widget, 'FT') !== nm('Sig')) {
          i++;
          continue;
        }
        const flags = widget.lookup(nm('F'));
        const hidden = flags instanceof PDFNumber && (flags.asNumber() & 34) !== 0; // hidden, or not shown on screen
        const rect = widget.lookup(nm('Rect'));
        if (picture && !hidden && rect instanceof PDFArray && rect.size() === 4) {
          try {
            const at = rect.asRectangle();
            page.pushOperators(pushGraphicsState(), translate(at.x, at.y), drawObject(page.node.newXObject('FlatWidget', picture)), popGraphicsState());
          } catch {
            /* no usable place on the page, so nothing was shown there either */
          }
        }
      }
      annots.remove(i);
    }
  }
}

// Builds the signed PDF: every document with field values stamped in, signer attachments, then the certificate.
export async function renderEnvelopePdf(e: any, audit: any[], opts: { certificate: boolean; sender?: any }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes('DejaVuSans.ttf'), { subset: true });
  const bold = await doc.embedFont(fontBytes('DejaVuSans-Bold.ttf'), { subset: true });
  const ctx: Ctx = { doc, font, bold, images: new Map(), recipients: new Map(e.recipients.map((r: any) => [r.id, r])), dateFormat: e.date_format };

  for (const d of e.documents) {
    const src = await PDFDocument.load(readBlob(d.sha256), { updateMetadata: false });
    flattenForm(src);
    const flat = await PDFDocument.load(await src.save());
    const pages = await doc.copyPages(flat, flat.getPageIndices());
    pages.forEach((p) => doc.addPage(p));
    for (const f of e.fields.filter((f: any) => f.document_id === d.id)) {
      const page = pages[f.page];
      if (page) await drawField(ctx, page, f);
    }
    for (const page of pages) {
      const m = mapper(page);
      const p = m.pt(12, 13);
      page.drawText(`Sign&Grow Envelope ID: ${e.id}`, { x: p.x, y: p.y, size: 6.5, font, color: MUTED, rotate: m.rotate });
    }
  }
  for (const f of e.fields.filter((f: any) => f.type === 'attachment' && f.value)) {
    const file = get('SELECT sha256 FROM files WHERE id=?', f.value);
    if (!file) continue;
    try {
      const att = await PDFDocument.load(readBlob(file.sha256), { updateMetadata: false });
      (await doc.copyPages(att, att.getPageIndices())).forEach((p) => doc.addPage(p));
    } catch {
      /* skip unreadable attachments */
    }
  }
  if (opts.certificate) await drawCertificate(ctx, e, audit, opts.sender);
  doc.setTitle(e.subject || 'Signed document');
  doc.setProducer('Sign&Grow');
  doc.setCreator('Sign&Grow');
  return doc.save();
}
