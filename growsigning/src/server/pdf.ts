import fs from 'node:fs';
import path from 'node:path';
import { firstSender, certSentBy } from './sentfor.ts';
import { PDFDocument, PDFPage, PDFFont, PDFName, PDFDict, PDFRef, PDFArray, PDFNumber, PDFStream, rgb, degrees, pushGraphicsState, popGraphicsState, translate, drawObject, concatTransformationMatrix } from 'pdf-lib';
import { jpegOrientation, markUpright, uprightMatrix, liesOnItsSide, pictureLimit } from './exif.ts';
import fontkitMod from '@pdf-lib/fontkit';
import { readBlob, get } from './db.ts';
import { bad, baseUrl } from './util.ts';
import { impactOf } from '../lib/impact.ts';
import { recordShowsTrees, treesOnEnvelope, takesPayments } from './impact.ts';
import { recordLines } from '../lib/impactwords.ts';
import { dayText, formatDate, formatDateValue, localStamp, validZone, zoneLabel } from '../lib/dates.ts';
import { typesetterFor } from './pdftext.ts';
import { isolate, hasRtl } from './bidi.ts';
import { PRINT_MARK, codePoints } from '../lib/scripts.ts';
import { strikeLines } from '../lib/strike.ts';
import { payLineForPrint } from '../lib/paylink.ts';
import { certName, certGroup } from '../lib/groups.ts';
// Signed by a delegate for a person who was away: who, for whom, under which delegation (delegation.ts).
import { delegateCertLines } from './delegation.ts';
import { offlineCertLines } from './offlinesign.ts';
import { labelOf } from '../lib/bysender.ts';
import { consentCertValue } from '../lib/disclosure.ts';
import { certLanguageLine } from './signlang.ts';
import { viewsLine } from '../lib/readview.ts';
import { readableWording } from '../lib/wordingday.ts';
// A witness is listed under the person they witnessed, with their statement (src/server/witness.ts).
import { witnessOrder, witnessCertLines } from './witness.ts';
import { stepCertLines, stepStatus } from '../lib/recipienttypes.ts';
// What an official recorded at a service counter, as their statements (counter.ts).
import { counterCertLines } from './counter.ts';
import { drawStamp, stampFor, stampForMark, markFields } from './stamp.ts';
import { hiddenOf } from './logic.ts';
// A company stamp on the page, printed like ink (src/server/stamps.ts). Not the large "VOIDED" mark of stamp.ts.
import { BlendMode } from 'pdf-lib';
import { stampPng, stampCertLines, senderStampCertLines, stampCertNote } from './stamps.ts';
import { drawSenderDetails } from './customfields.ts';
import { collectCertLines } from './collect.ts';
import { sharedCertLines } from './collab.ts';
import { sealLineFor } from './seal.ts';
import { pdfaLineFor } from './pdfa.ts';
// Hidden values, currency signs and boxes of fixed size (fieldchecks.ts, src/lib/fieldrules.ts).
import { printedFields, hiddenLine } from './fieldchecks.ts';
import { printedAmount, fieldChecks, FIXED_MIN_PT } from '../lib/fieldrules.ts';
/** The smallest a box of fixed size ever prints, for text of wide letters that does not fit at 7 points. */
const FIXED_FLOOR_PT = 2;
import { chainStampLine } from './auditstamp.ts';
import { STAMP_OPACITY, stampTurn } from '../lib/stamps.ts';
// "Not asked: Ben, because Amount was 800 (rule: more than 1000)." for a person whose "Only when..." was not met.
import { notAskedStatus } from '../lib/routing.ts';
// The logo in the certificate's header and the "Signed with growsigning" stamp at the foot of pages (brandpdf.ts).
import { drawBrandHeader, drawSheetFoot } from './brandpdf.ts';
import { notePages, drawFootClear, fieldBox } from './footplace.ts';
// Files given to read with the document, not signed: after the signed pages, and in the certificate (supplements.ts).
import { toSign, addSupplements, supplementCert } from './supplements.ts';
import { hiddenDocLines, TRAIL_NAMES_NOTE } from '../lib/owndocs.ts';
import { drawKind, drawStyled, kindCertLines } from './fieldkinds.ts';
import { howCertLines, unfinishedMark } from './switches.ts';
// Signed on paper: the scan after a divider page, the places that point to it, the certificate lines (paper.ts).
import { paperSigned, addPaperScans, paperCertLines, paperStatus } from './paper.ts';

const fontkit: any = (fontkitMod as any).default || fontkitMod;
const GREEN = rgb(0.12, 0.44, 0.26);
const INK = rgb(0.11, 0.16, 0.13);
const MUTED = rgb(0.42, 0.47, 0.44);
const RULE = rgb(0.86, 0.87, 0.84);

const g = globalThis as any;
export function fontBytes(name: string): Buffer {
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
  // A file that starts like a PDF and is cut short or damaged can load and still have no readable pages. Reading
  // them is part of reading the file, so that is refused in the same words and never as an error on our side.
  let sizes: PageSize[];
  try {
    sizes = doc.getPages().map((p) => {
      const b = p.getCropBox();
      const rot = ((p.getRotation().angle % 360) + 360) % 360;
      return rot % 180 ? { w: b.height, h: b.width } : { w: b.width, h: b.height };
    });
  } catch {
    throw bad('That file could not be read as a PDF. It looks damaged or cut short. Export or download it again and use the new file.');
  }
  if (!sizes.length) throw bad('That PDF has no pages.');
  return { pages: sizes.length, sizes };
}

// Wrap a PNG or JPEG in a single-page PDF so images can be sent for signature too.
export const imageToPdf = (buf: Uint8Array, mime: string): Promise<Uint8Array> => imagesToPdf([{ bytes: buf, png: mime === 'image/png' }]);

// One PDF from one or more pictures, a page each, in the order given. Each page is A4, upright or on its side to
// suit the picture, so fields are a normal size whatever the camera's resolution.
// A phone photo says which way up it is in a note beside the picture (see exif.ts), and a PDF has no such note. So
// the picture is drawn turned the way the note says, and the note in the bytes we keep is set to "upright". Without
// the first, the photo is sideways in the signed PDF. Without the second, a viewer that does read the note (the
// browser, drawing the page on screen) turns it once more. Either way the sender would place a field on a line
// that is somewhere else in the PDF people download.
export async function imagesToPdf(list: { bytes: Uint8Array; png: boolean; name?: string }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const it of list) {
    const o = it.png ? null : jpegOrientation(it.bytes);
    const turn = o && o.value > 1 ? o.value : 1;
    // Counted from the header before a pixel is unpacked: a small PNG can claim to be enormous (exif.ts).
    const huge = pictureLimit(it.bytes, it.png, list.length > 1 ? it.name || 'One of the pictures' : undefined);
    if (huge) throw bad(huge);
    let img;
    try {
      img = it.png ? await doc.embedPng(it.bytes) : await doc.embedJpg(turn > 1 ? markUpright(it.bytes, o!) : it.bytes);
    } catch {
      throw bad(list.length > 1 ? `${it.name ? `"${it.name}"` : 'One of the pictures'} could not be read, so no document was made. Use PNG or JPEG pictures, or leave that one out and try again.` : 'That image could not be read. Use a PNG or JPEG.');
    }
    // The size of the picture as it is looked at: a photo stored on its side is as wide as its stored height.
    const side = liesOnItsSide(turn);
    const iw = side ? img.height : img.width;
    const ih = side ? img.width : img.height;
    const [W, H] = iw > ih ? [841.89, 595.28] : [595.28, 841.89];
    const scale = Math.min((W - 48) / iw, (H - 48) / ih, 1);
    const page = doc.addPage([W, H]);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...uprightMatrix(turn, (W - iw * scale) / 2, (H - ih * scale) / 2, iw * scale, ih * scale)), drawObject(page.node.newXObject('Image', img.ref)), popGraphicsState());
    // Packed into the PDF now, so the unpacked pixels of this picture are let go before the next one is read.
    await img.embed();
  }
  return doc.save();
}

function dataUrlBytes(url: string | null | undefined): { bytes: Buffer; png: boolean } | null {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(url || '');
  return m ? { bytes: Buffer.from(m[2], 'base64'), png: m[1] === 'png' } : null;
}

// Maps coordinates given in the displayed page (origin top-left, y down) to PDF user space, honouring /Rotate.
export function mapper(page: PDFPage) {
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

type Ctx = { doc: PDFDocument; font: PDFFont; bold: PDFFont; images: Map<string, any>; recipients: Map<string, any>; dateFormat?: string | null; tz?: string | null };

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

// A name or an email field prints the name and the address the sender gave its owner, from the start: they are
// wording on the page, shown to every signer before signing, so a copy made at any time prints them too. The date
// of signing is different. It only exists once its signer has finished.
//
// Every date on the pages is written in the one format the sender chose for the envelope: the date of signing, and
// a date a signer picked in a date field. The date of signing is the calendar day where the signer was: in the time
// zone their device reported when they agreed and when they finished. If it reported none, the sender's zone
// (`senderTz`) is used, and failing that UTC. The certificate gives the exact moment in UTC beside it.
export function fieldDisplayValue(f: any, r: any, dateFormat?: string | null, senderTz?: string | null): string {
  switch (f.type) {
    // For a group the sender named nobody. Its name and email fields are filled in like a date of signing: with the
    // member who acted, once that person has finished (see printedWords in envelopes.ts). So are a witness's: who
    // witnesses can still change until they have.
    case 'full_name': return ((r?.group_name || r?.role === 'witness') && r.status !== 'completed' ? '' : r?.name) || '';
    case 'email': return ((r?.group_name || r?.role === 'witness') && r.status !== 'completed' ? '' : r?.email) || '';
    case 'date_signed': return r?.completed_at ? formatDate(r.completed_at, dateFormat, validZone(r.tz) || senderTz) : '';
    case 'date': return formatDateValue(f.value, dateFormat);
    // A stamp is a picture. Its value is the fingerprint of that picture, never words on the page.
    case 'stamp': return '';
    // So is a drawing, and a button holds no words (fieldkinds.ts).
    case 'drawing': case 'approve': case 'decline': return '';
    // An amount in a currency is printed as typed, with the currency's sign in front when it was typed without one.
    case 'number': return printedAmount(f.value || '', fieldChecks(f));
    default: return f.value || '';
  }
}

async function drawField(ctx: Ctx, page: PDFPage, f: any) {
  const m = mapper(page);
  const vx = f.x * m.W, vy = f.y * m.H, vw = f.w * m.W, vh = f.h * m.H;
  const r = f.recipient_id ? ctx.recipients.get(f.recipient_id) : null;
  // A drawing (a picture, never a signature) and the Approve and Decline buttons (fieldkinds.ts).
  if (await drawKind(ctx.doc, page, f, r, m, ctx.font)) return;

  if (f.type === 'signature' || f.type === 'initials') {
    if (!f.value || !r) return;
    const img = await image(ctx, f.type === 'signature' ? r.signature_png : r.initials_png || r.signature_png);
    if (!img) return;
    const caption = f.type === 'signature' && vh >= 30;
    const availH = caption ? vh - 7 : vh;
    // The whole picture, as large as fits, in the middle of the field: never cropped and never past an edge. The
    // picture itself holds all of the ink with clear space around it (src/lib/sigmark.ts).
    const s = Math.min(vw / img.width, availH / img.height);
    const w = img.width * s, h = img.height * s;
    const p = m.pt(vx + (vw - w) / 2, vy + (availH + h) / 2);
    page.drawImage(img, { x: p.x, y: p.y, width: w, height: h, rotate: m.rotate });
    if (caption) {
      // The small line under the signature stays inside the field as well: in a narrow field (a table cell) it is
      // printed in smaller letters instead of running into the next cell.
      const line = `Signed via GrowSigning · ${String(r.id).slice(-8)}`;
      const size = Math.min(4.5, (4.5 * vw) / (ctx.font.widthOfTextAtSize(line, 4.5) + 0.5));
      const c = m.pt(vx, vy + vh - 1);
      page.drawText(line, { x: c.x, y: c.y, size, font: ctx.font, color: GREEN, rotate: m.rotate });
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
  // A stamp, printed like ink: multiplied into the page at slightly less than full strength, so the words printed
  // under it show through as they would under a real stamp, and there is never a box around it. The words stay in
  // the file. As large as fits its field, in the middle of it, the way the signing screen shows it (stamps.ts).
  if (f.type === 'stamp') {
    if (!f.value) return;
    const key = `stamp:${f.value}`;
    if (!ctx.images.has(key)) {
      const png = stampPng(f.value);
      let img: any = null;
      try {
        img = png ? await ctx.doc.embedPng(png) : null;
      } catch {
        img = null;
      }
      ctx.images.set(key, img);
    }
    const img = ctx.images.get(key);
    if (!img) return;
    const s = Math.min(vw / img.width, vh / img.height);
    const w = img.width * s, h = img.height * s;
    // Turned about its middle by its natural tilt, clockwise as the page is looked at, as the signing screen turns
    // it: the design keeps the size of its field, and its turned corners may reach a little past it.
    const turn = stampTurn(f.stamp_meta), t = (turn * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    const cx = vx + vw / 2, cy = vy + vh / 2;
    const p = m.pt(cx - (w / 2) * cos - (h / 2) * sin, cy - (w / 2) * sin + (h / 2) * cos);
    page.drawImage(img, { x: p.x, y: p.y, width: w, height: h, rotate: degrees(m.rotate.angle - turn), opacity: STAMP_OPACITY, blendMode: BlendMode.Multiply });
    return;
  }
  // A strike-out: the sender's line through wording printed on the page. The same shape the signing screen shows
  // (strikeLines in src/lib/strike.ts): one line through the middle, or corner to corner over more than one line.
  // The words under it stay in the file.
  if (f.type === 'strike') {
    const thickness = Math.max(0.8, Math.min(1.6, vh * 0.09));
    for (const [x1, y1, x2, y2] of strikeLines(f)) page.drawLine({ start: m.pt(vx + vw * x1, vy + vh * y1), end: m.pt(vx + vw * x2, vy + vh * y2), thickness, color: INK });
    return;
  }

  const text = clean(fieldDisplayValue(f, r, ctx.dateFormat, ctx.tz));
  if (!text) return;
  // A field with a text style: its font, size, colour and bold (fieldkinds.ts).
  if (await drawStyled(ctx.doc, page, f, text, m, ctx)) return;
  const base = Math.max(6, Math.min(11, vh * 0.62));
  const multi = vh > base * 2.6 || text.includes('\n');
  // The typesetter picks a font for every script, puts right-to-left text in its reading order with digits and
  // Latin words left to right, and says how wide a line is. A line that reads right to left starts at the right
  // edge of its box, as it would on paper.
  const ts = typesetterFor(ctx.doc, ctx.font, ctx.bold);
  const left = (ln: { width: number; rtl: boolean }, size: number) => (ln.rtl ? vx + vw - 2 - (ln.width * size) / 1000 : vx + 2);
  if (multi) {
    let size = Math.min(base, 10);
    // A box of fixed size makes its text smaller until every line fits in it (fieldrules.ts). The signer can type no
    // more than about fits at 7 points; text of wide letters (capitals, W) goes smaller still, so nothing typed is
    // ever cut off or printed past the box.
    if (fieldChecks(f).fixed) while (size > FIXED_FLOOR_PT && ts.wrap(text, size, vw - 4).length > Math.floor(vh / (size * 1.3))) size = Math.max(FIXED_FLOOR_PT, size - (size > FIXED_MIN_PT ? 0.5 : 0.25));
    const lh = size * 1.3;
    const lines = ts.wrap(text, size, vw - 4).slice(0, Math.max(1, Math.floor(vh / lh)));
    lines.forEach((ln, i) => {
      const p = m.pt(left(ln, size), vy + size + 1 + i * lh);
      ts.draw(page, ln, { x: p.x, y: p.y, size, color: INK, rotate: m.rotate });
    });
  } else {
    const ln = ts.layout(text);
    // As large as fits the box, in half-point steps, never below 5 points.
    // A box of fixed size shrinks its text until it fits, below 7 points for wide letters (fieldrules.ts), and never
    // prints past its box.
    const floor = fieldChecks(f).fixed ? Math.min(base, FIXED_FLOOR_PT) : 5;
    const size = Math.max(floor, Math.min(base, Math.floor((((vw - 4) * 1000) / Math.max(1, ln.width)) * 2) / 2));
    const p = m.pt(left(ln, size), vy + vh / 2 + size * 0.35);
    ts.draw(page, ln, { x: p.x, y: p.y, size, color: INK, rotate: m.rotate });
  }
}

// ---- Certificate of completion -------------------------------------------------------------

export class Sheet {
  page!: PDFPage;
  y = 0;
  readonly W = 595.28;
  readonly H = 841.89;
  readonly L = 48;
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  footer: string;
  // badge false: no "Signed with growsigning" at the foot, for a sheet of something nobody signed yet (the print to
  // sign on paper, paper.ts). The footer line is still there.
  badge: boolean;
  constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont, footer: string, badge = true) {
    this.doc = doc;
    this.font = font;
    this.bold = bold;
    this.footer = footer;
    this.badge = badge;
    this.add();
  }
  add() {
    this.page = this.doc.addPage([this.W, this.H]);
    if (this.badge) drawSheetFoot(this.page, { L: this.L, footer: this.footer, font: this.font, color: MUTED });
    else if (this.footer) this.page.drawText(this.footer, { x: this.L, y: 26.8, size: 7, font: this.font, color: MUTED });
    this.y = this.H - 56;
  }
  need(h: number) {
    if (this.y - h < 52) this.add();
  }
  text(s: string, o: { size?: number; bold?: boolean; color?: any; x?: number; gap?: number; maxW?: number } = {}) {
    const size = o.size ?? 9;
    const x = o.x ?? this.L;
    // The certificate is written in English, left to right. A name or a subject in a right-to-left script stands
    // inside its line in its own reading order (see isolate() where the lines are put together).
    const ts = typesetterFor(this.doc, this.font, this.bold);
    for (const ln of ts.wrap(s, size, o.maxW ?? this.W - x - this.L, { bold: o.bold, dir: 'ltr' })) {
      this.need(size * 1.45);
      ts.draw(this.page, ln, { x, y: this.y - size, size, color: o.color ?? INK });
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

const ROLE_LABEL: Record<string, string> = { signer: 'Signer', approver: 'Approver', cc: 'Receives a copy', viewer: 'Needs to view', inperson: 'In-person signer', witness: 'Witness', editor: 'Can change the document', agent: 'Chooses who comes next' };
// A moment on the signing record: the day with the month as a word, so nobody can misread it, and the time in UTC.
const ts = (s: string | null | undefined) => (s ? `${dayText(s)} ${s.slice(11, 19)} UTC` : '-');

async function drawCertificate(ctx: Ctx, e: any, audit: any[], sender: any) {
  // The stamp at the foot of each sheet says "Signed with growsigning", so the footer line does not repeat the name.
  const s = new Sheet(ctx.doc, ctx.font, ctx.bold, `Certificate of Completion · Envelope ${e.id}`);
  drawBrandHeader(s.page, { W: s.W, H: s.H, L: s.L, title: 'Certificate of Completion', bold: ctx.bold });
  s.y = s.H - 112;
  // A name, a subject or a file name in a right-to-left script is ordered by itself inside our English line, so
  // "ABC" or a number in it stays where its writer put it. In the audit lines, which were written earlier as plain
  // sentences, the names and titles of this envelope are found again and treated the same way.
  const iso = (x: any) => (hasRtl(String(x ?? '')) ? isolate(String(x)) : String(x ?? ''));
  const own = [...new Set<string>([e.subject, sender?.name, ...e.documents.map((d: any) => d.name), ...e.recipients.map((r: any) => r.name)].filter((x: any) => x && hasRtl(x)))].sort((a, b) => b.length - a.length);
  const known = (text: string) => own.reduce((t, name) => t.split(name).join(isolate(name)), text);

  s.h2('Envelope');
  s.kv('Envelope ID', e.id);
  s.kv('Subject', iso(e.subject) || '(no subject)');
  s.kv('Status', e.status === 'completed' ? 'Completed' : e.status);
  // The first sender stays on the certificate after a move; who sent it for whom has a line of its own (sentfor.ts).
  const first = firstSender(e) || sender;
  s.kv('Sender', first ? `${iso(first.name)} <${first.email}>` : '-');
  const sentBy = certSentBy(e);
  if (sentBy) s.kv('Sent by', known(sentBy));
  s.kv('Sent', ts(e.sent_at));
  s.kv('Completed', ts(e.completed_at));
  s.kv('Signing order', e.ordered ? 'Sequential' : 'Everyone at once');
  if (hiddenLine(e.fields)) s.kv('Hidden values', hiddenLine(e.fields)!);
  // The sender's own stamp: which one, where, and the fingerprint of its picture (stamps.ts).
  for (const [k, v] of senderStampCertLines(e)) s.kv(k, known(v));
  // The custom fields the account prints on the certificate, in the sender's words (customfields.ts).
  drawSenderDetails(s, e, iso, MUTED);
  // A payment taken while signing, only once Stripe confirmed it (collect.ts): never "paid" without that.
  for (const [k, v] of collectCertLines(e)) s.kv(k, known(v));
  // Fields anyone on the document could fill in: each change, who made it and what it was before (collab.ts).
  for (const [k, v] of sharedCertLines(e)) s.kv(k, known(v));

  s.h2('Documents');
  for (const d of toSign(e.documents)) {
    s.text(`${iso(d.name)} (${d.pages} page${d.pages === 1 ? '' : 's'})`, { size: 9, bold: true });
    s.text(`SHA-256 of the original: ${d.sha256}`, { size: 7, color: MUTED, gap: 3 });
  }
  // A copy made for one person: each file they were not shown, by its fingerprint only (visibility.ts).
  for (const [k, v] of hiddenDocLines(e.hidden_documents)) (s.text(k, { size: 9, bold: true }), s.text(v, { size: 7, color: MUTED, gap: 3 }));
  supplementCert(e, s, iso, ts);

  s.h2('Recipients');
  // A witness comes straight after the person they witnessed (witnessOrder in witness.ts).
  for (const r of witnessOrder(e.recipients)) {
    s.need(96);
    const top = s.y;
    // For a group: the member who acted and the group ("Maya Lopez, for HR team"), see certName in src/lib/groups.ts.
    s.text(certName(r, iso), { size: 10, bold: true, maxW: 330 });
    s.kv('Role', ROLE_LABEL[r.role] || r.role);
    s.kv('Status', r.status === 'skipped' ? notAskedStatus(r) : paperStatus(r) || stepStatus(r) || (r.status === 'completed' ? (r.role === 'cc' ? 'Copied' : r.role === 'viewer' ? 'Viewed' : r.role === 'approver' ? 'Approved' : r.role === 'witness' ? 'Witnessed' : 'Signed') : r.status));
    // What someone who changes the document could do, and who named this person (src/lib/recipienttypes.ts).
    for (const [k, v] of stepCertLines(e, r, ts)) s.kv(k, known(v));
    // Whose signature a witness witnessed, their statement as ticked, when, and what a challenge would look at.
    for (const [k, v] of witnessCertLines(e, r, ts)) s.kv(k, known(v));
    for (const [k, v] of counterCertLines(e, r, ts)) s.kv(k, known(v));
    for (const [k, v] of delegateCertLines(e, r)) s.kv(k, known(v));
    // Signed in person on the host's device without a connection: the device's clock, unchecked, and when we got it (offlinesign.ts).
    for (const [k, v] of offlineCertLines(e, r, ts)) s.kv(k, known(v));
    // Signed on paper: when the scan came, from where, who accepted it, and that nobody checked the handwriting (paper.ts).
    for (const [k, v] of paperCertLines(e, r, ts)) s.kv(k, known(v));
    s.kv('Sent', ts(r.sent_at));
    // Someone who was not asked never had the document: no times, checks or address to show for them.
    if (r.role !== 'cc' && r.status !== 'skipped') {
      s.kv('Viewed', ts(r.viewed_at));
      // Someone who finished, was asked to sign again because the sender changed the document, and did: both
      // times are shown. The audit trail below says what changed in between.
      const earlier = String(r.signed_before || '').split('\n').filter(Boolean);
      if (earlier.length) {
        s.kv('First completed', ts(earlier[0]));
        if (earlier.length > 1) s.kv('Completed again', earlier.slice(1).map(ts).join(', '));
        s.kv(r.completed_at ? 'Completed again' : 'Completed', r.completed_at ? `${ts(r.completed_at)}, after the sender changed the document` : 'Not yet, since the sender changed the document');
      } else s.kv('Completed', ts(r.completed_at));
      // How this person was checked before the document opened, and nothing more than happened: "Link sent by email
      // only" when there was no check. The words are made in src/lib/checks.ts (checkLine) and put on the recipient
      // by buildPdf, which knows whether a one-time code was passed by whoever holds the link now.
      s.kv('Identity check', r.check_line || (r.access_code ? 'Link sent by email and an access code chosen by the sender' : 'Link sent by email only'));
      // With "withdrawn" and when, for someone who asked for paper instead (src/lib/disclosure.ts).
      s.kv('E-record consent', consentCertValue(r, ts));
      // In which language they read the signing page and the consent wording (signlang.ts). Absent when neither was recorded.
      { const l = certLanguageLine(r, audit); if (l) s.kv('Language', l); }
      // Which ways of showing the document they used: the pages, Easy reading, or both (src/lib/readview.ts).
      { const v = viewsLine(r.views_used); if (v) s.kv('Read as', v); }
      s.kv('IP address', r.ip || '-');
      // The same moments by this person's own clock, in the time zone their device reported. The date of signing on
      // the pages is the calendar day there, so the certificate shows what that day rests on, next to UTC above.
      const zone = validZone(r.tz);
      if (zone) {
        s.kv('Time zone', `${zoneLabel(zone, r.completed_at || r.consent_at || undefined)}, as reported by their device`);
        if (r.viewed_at) s.kv('Viewed, their time', localStamp(r.viewed_at, zone));
        if (r.consent_at) s.kv('Consent, their time', localStamp(r.consent_at, zone));
        if (r.completed_at) s.kv('Completed, their time', localStamp(r.completed_at, zone));
      }
      if (r.reassigned_from) s.kv('Reassigned from', known(r.reassigned_from));
      // How the signature and initials were made, as their signing page reported it (src/lib/switches.ts).
      for (const [k, v] of howCertLines(r)) s.kv(k, v);
      // Each stamp this person put on: which, where, when, and the fingerprint of its picture (stamps.ts).
      for (const [k, v] of stampCertLines(e, r)) s.kv(k, known(v));
      // The drawings they made, as drawings and never as a signature (fieldkinds.ts).
      for (const [k, v] of kindCertLines(e, r)) s.kv(k, known(v));
    }
    const img = await image(ctx, r.signature_png);
    if (img && s.y < top) {
      const sc = Math.min(150 / img.width, 54 / img.height);
      const x = s.W - s.L - 160;
      s.page.drawRectangle({ x, y: top - 72, width: 160, height: 66, borderColor: RULE, borderWidth: 0.6 });
      s.page.drawImage(img, { x: x + (160 - img.width * sc) / 2, y: top - 72 + (66 - img.height * sc) / 2, width: img.width * sc, height: img.height * sc });
    }
    // A group: everyone who could have acted for it on this envelope, as it was sent.
    if (r.group_name) s.kv(r.claimed_by ? 'Acted for' : 'Sent to', certGroup(r, iso));
    s.rule(6);
  }
  // What a stamp on this envelope is, and what it is not, said once (STAMP_IS in src/lib/stamps.ts).
  const stamped = stampCertNote(e);
  if (stamped) s.text(stamped, { size: 7.5, color: MUTED, gap: 4 });

  // Whose time zone we know, by the name and address each of their audit lines is signed with. Their lines carry
  // their local time as well as UTC.
  const zones = new Map<string, string>();
  for (const r of e.recipients) {
    const zone = validZone(r.tz);
    if (!zone) continue;
    for (const name of new Set([r.name, r.sender_name, r.self_name].filter(Boolean))) zones.set(labelOf({ ...r, name }), zone);
  }
  s.h2('Audit trail');
  s.text('Each event is hashed together with the one before it, so the history cannot be edited without breaking the chain.', { size: 7.5, color: MUTED, gap: 4 });
  if (e.hidden_documents?.length) s.text(TRAIL_NAMES_NOTE, { size: 7.5, color: MUTED, gap: 4 });
  for (const a of audit) {
    s.need(24);
    const y0 = s.y;
    s.page.drawText(ts(a.at), { x: s.L, y: y0 - 8, size: 7.5, font: ctx.font, color: MUTED });
    // A payment link's address never goes out in this certificate, also from a line written before it was kept out.
    s.text(known(`${a.action}${a.detail ? ` · ${readableWording(payLineForPrint(a.action, a.detail))}` : ''}`), { size: 8, x: s.L + 118, maxW: 330 });
    s.text(known(`${a.actor}${a.ip ? ` · ${a.ip}` : ''} · ${a.hash.slice(0, 16)}${zones.has(a.actor) ? ` · their time ${localStamp(a.at, zones.get(a.actor))}` : ''}`), { size: 6.5, x: s.L + 118, color: MUTED, gap: 3 });
  }
  if (audit.length) s.kv('Chain head', audit[audit.length - 1].hash, s.L, 70);
  // With a time-stamp service: the line about the time stamp over that head (src/server/auditstamp.ts).
  const headStamp = chainStampLine(e, audit[audit.length - 1]?.hash);
  if (headStamp) s.text(headStamp, { size: 7.5, color: MUTED, gap: 4 });
  // The digital seal of this file, when finishPdf is sealing it (src/server/seal.ts). Nothing without seal settings.
  const sealLine = sealLineFor(e);
  if (sealLine) (s.h2('Digital seal'), s.text(sealLine, { size: 8, gap: 4 }));
  // The archive format of this file, when the account asked for PDF/A (src/server/pdfa.ts). Nothing otherwise.
  const pdfaLine = pdfaLineFor(e);
  if (pdfaLine) s.text(pdfaLine, { size: 8, gap: 4 });

  // A character none of our fonts has is never left as an empty box. It is marked wherever it stood, and listed here
  // by its Unicode number, so what was typed can be put back together from this record.
  const gone = [...typesetterFor(ctx.doc, ctx.font, ctx.bold).missing].join('');
  if (gone) {
    const n = [...gone].length;
    s.h2('Characters this PDF could not print');
    s.text(`The fonts of this PDF do not have ${n === 1 ? 'one character' : `${n} different characters`} used in this envelope. Wherever ${n === 1 ? 'it' : 'one of them'} stood, the pages and this certificate show the mark ${PRINT_MARK} instead. By Unicode number, in the order they first appear: ${codePoints(gone)}. On screen and in emails they show as they were typed.`, { size: 8, gap: 4 });
  }

  // 'Trees on the signing record' (Settings, Account): on unless the account's admins switched it off, as a
  // government tenant will have. Estimates are called estimates, and trees are claimed only for signatures that
  // were paid for (src/server/impact.ts, src/lib/impactwords.ts).
  // Not when someone printed it to sign on paper: "were not used" would not be true (paper.ts).
  if (!recordShowsTrees(e.account_id) || paperSigned(e).size) return;
  const i = impactOf(e.sheets || 0);
  const lines = recordLines({ ...i, trees: treesOnEnvelope(e.id), plans: takesPayments(), site: baseUrl() });
  const high = 36 + lines.length * 13;
  s.need(high + 28);
  s.y -= 10;
  s.page.drawRectangle({ x: s.L, y: s.y - high, width: s.W - 2 * s.L, height: high, color: rgb(0.93, 0.97, 0.93) });
  s.page.drawText('Signed without paper', { x: s.L + 14, y: s.y - 20, size: 11, font: ctx.bold, color: GREEN });
  lines.forEach((line, k) => s.page.drawText(clean(line), { x: s.L + 14, y: s.y - 36 - k * 13, size: 8.5, font: ctx.font, color: INK }));
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

// A fillable form, in a document that was sent or in a file a signer attached, becomes ordinary page content, so the
// signed file has nothing left to fill in, to change or to sign later. Each field's picture is drawn where the field
// was, then the field is taken off the page. A field with no picture and nothing in it is just taken off: the usual
// one is an empty digital-signature box, which must not be left waiting in a document that is already signed.
// pdf-lib's own flatten() is not used. It gives up at the first field without a picture, which left every field
// after it live, and it leaves each page pointing at field objects it has deleted, which strict readers and filing
// systems reject.
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
    let annots: PDFArray | undefined;
    try {
      annots = page.node.Annots();
    } catch {
      // Written as something that is not a list. No reader shows anything from it, so it goes, like an entry that
      // points at nothing. Failing here would fail the whole signed PDF, or leave a signer's attachment out of it.
      page.node.delete(nm('Annots'));
    }
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

// The pages of one stored PDF, copied into the signed file with any fillable form in it made flat first. The
// envelope's own documents and the files signers attach both come through here: what a signer attaches is very
// often a form itself (a tax or bank form with a box to sign), and its fields must not stay live either.
async function flatPages(doc: PDFDocument, sha256: string): Promise<PDFPage[]> {
  const src = await PDFDocument.load(readBlob(sha256), { updateMetadata: false });
  flattenForm(src);
  // flattenForm has drawn every picture that could be drawn. Left to itself, save() would try the ones that could
  // not be drawn once more and fail the whole document over them.
  const bytes = await src.save({ updateFieldAppearances: false });
  const flat = await PDFDocument.load(bytes);
  const pages = await doc.copyPages(flat, flat.getPageIndices());
  await notePages(pages, bytes, sha256); // what each page has near its foot, for the stamp's place (footplace.ts)
  return pages;
}

// The page a copy opens with when it must not pass for a finished agreement: a red band with the title, then the
// reasons in plain sentences.
function noticeSheet(doc: PDFDocument, font: PDFFont, bold: PDFFont, footer: string, notice: { title: string; lines: string[] }) {
  const s = new Sheet(doc, font, bold, footer);
  s.page.drawRectangle({ x: 0, y: s.H - 92, width: s.W, height: 92, color: rgb(0.66, 0.2, 0.16) });
  s.page.drawText(clean(notice.title), { x: s.L, y: s.H - 56, size: 20, font: bold, color: rgb(1, 1, 1) });
  s.y = s.H - 120;
  for (const line of notice.lines) s.text(line, { size: 11, gap: 8 });
}

// Puts such a page in front of a PDF that was stored earlier: the document as one person signed it, kept when the
// sender changed the document afterwards. Every page of it is marked as well (`mark`), so no single page of it can
// pass for the document as it is now.
export async function withNotice(pdf: Uint8Array, envelopeId: string, notice: { title: string; lines: string[] }, mark: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes('DejaVuSans.ttf'), { subset: true });
  const bold = await doc.embedFont(fontBytes('DejaVuSans-Bold.ttf'), { subset: true });
  noticeSheet(doc, font, bold, `${mark} · Envelope ${envelopeId}`, notice);
  const src = await PDFDocument.load(pdf, { updateMetadata: false });
  for (const page of await doc.copyPages(src, src.getPageIndices())) {
    doc.addPage(page);
    const m = mapper(page);
    const p = m.pt(12, 22);
    page.drawText(clean(`${mark.toUpperCase()}, see the first page`), { x: p.x, y: p.y, size: 6.5, font, color: MUTED, rotate: m.rotate });
    drawStamp(page, bold, stampForMark(mark)); // large across the page as well (stamp.ts)
  }
  doc.setTitle(notice.title);
  doc.setProducer('GrowSigning');
  doc.setCreator('GrowSigning');
  return doc.save();
}

/** The time zone of whoever sent an envelope, as their browser last reported it. Null when it never did. */
export const senderZone = (e: any): string | null => validZone(e?.sender_id ? get('SELECT tz FROM users WHERE id=?', e.sender_id)?.tz : null);

// Builds the signed PDF: every document with field values stamped in, signer attachments, then the certificate.
// `notice` is for a copy of an envelope that was never completed (voided, declined or out of time), made for someone
// who had signed it: the copy opens with a page that says so and why, and every page carries the words too.
// `unfinished`: a copy of an envelope that is still out is marked as such across every page too (stamp.ts).
export async function renderEnvelopePdf(e: any, audit: any[], opts: { certificate: boolean; sender?: any; viewer?: string; notice?: { title: string; lines: string[] }; unfinished?: boolean; foot?: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes('DejaVuSans.ttf'), { subset: true });
  const bold = await doc.embedFont(fontBytes('DejaVuSans-Bold.ttf'), { subset: true });
  if (opts.notice) noticeSheet(doc, font, bold, `Not completed · Envelope ${e.id}`, opts.notice);
  const ctx: Ctx = { doc, font, bold, images: new Map(), recipients: new Map(e.recipients.map((r: any) => [r.id, r])), dateFormat: e.date_format, tz: senderZone(e) };
  // A copy made for one recipient (`viewer`) while others are still at work shows the pages as that recipient's
  // screen does: everything the sender wrote, what people who have finished filled in, and what the viewer has
  // entered so far. Another person's half-filled answer, saved signature or uploaded file is not printed until that
  // person has finished: their field shows what the sender put there, or nothing.
  const asSeen = (f: any) => {
    const o = f.recipient_id ? ctx.recipients.get(f.recipient_id) : null;
    return !opts.viewer || !o || o.id === opts.viewer || o.status === 'completed' || f.readonly ? f : { ...f, value: f.prefill ?? null };
  };
  // A field that is not shown (its "Only show when" answer was not given) prints nothing at all (src/server/logic.ts).
  // A value the sender hid prints as dots for anyone else while it is out, and as "(hidden by the sender)" in a
  // completed copy when they asked for that too (fieldchecks.ts).
  const seen = printedFields(e.fields.map(asSeen), ctx.recipients, opts.certificate ? 'completed' : e.status, opts.viewer);
  const hide = hiddenOf(seen);
  // Nor do the fields of someone who was not asked (routing.ts): not even their name, as if they had taken part.
  // Someone who signed on paper prints nothing of their own at their places: those point to their scan (paper.ts).
  const onPaper = paperSigned(e);
  const fields = seen.filter((f: any) => !hide.has(f.id) && ctx.recipients.get(f.recipient_id)?.status !== 'skipped' && !onPaper.has(f.recipient_id));
  // The mark of a copy that must not pass for a signed document: closed, or still out (stamp.ts).
  // The big words of a copy still out are the account's own when an admin chose them (switches.ts); the small line is not.
  const mark = opts.notice ? stampFor(e.status) : opts.unfinished && e.status === 'sent' && !opts.certificate ? unfinishedMark(e) : null;

  const docPages = new Map<string, PDFPage[]>();
  const footLine = `GrowSigning Envelope ID: ${e.id}${opts.notice ? ' · NOT COMPLETED BY EVERYONE, see the first page' : mark ? ' · NOT COMPLETED YET: not everyone has signed' : ''}`;
  for (const d of toSign(e.documents)) {
    const pages = await flatPages(doc, d.sha256);
    pages.forEach((p) => doc.addPage(p));
    docPages.set(d.id, pages);
    for (const f of fields.filter((f: any) => f.document_id === d.id)) {
      const page = pages[f.page];
      if (page) await drawField(ctx, page, f);
    }
    for (const [i, page] of pages.entries()) {
      const m = mapper(page);
      // The stamp and the envelope ID, side by side at the foot, where the page has neither words nor pictures nor
      // one of our fields (footplace.ts); nothing of ours at the top.
      // foot false: the print to sign on paper, which carries its own line and is not signed with us (paper.ts).
      if (opts.foot !== false) drawFootClear(page, m, fields.filter((f: any) => f.document_id === d.id && f.page === i).map((f: any) => fieldBox(f, m)), { line: footLine, font, color: MUTED });
      if (mark) drawStamp(page, bold, mark); // and across the whole page (stamp.ts)
    }
    if (mark) markFields(pages, fields.filter((f: any) => f.document_id === d.id), bold, mark);
  }
  for (const f of fields.filter((f: any) => f.type === 'attachment' && f.value)) {
    const file = get('SELECT sha256 FROM files WHERE id=?', f.value);
    if (!file) continue;
    try {
      // A file a signer attached is part of the signed copy, so its pages carry the stamp and the envelope ID too.
      (await flatPages(doc, file.sha256)).forEach((p) => (doc.addPage(p), drawFootClear(p, mapper(p), [], { line: footLine, font, color: MUTED }), mark && drawStamp(p, bold, mark)));
    } catch (err: any) {
      // The signed PDF is stored for good, so it is never sealed without a signer's attachment whose stored copy failed
      // its check or is locked: the build fails and is tried again until the file is back (finalretry.ts tells the
      // sender and the operators). A file that pdf-lib cannot read at all is left out as before.
      if (opts.certificate && (err?.data?.code === 'file_damaged' || err?.data?.code === 'file_locked')) throw err;
    }
  }
  // The scan of each person who signed on paper, after a divider page, and their places pointing to it (paper.ts).
  if (onPaper.size) await addPaperScans(e, doc, { font, bold, footLine, mark, places: seen.filter((f: any) => !hide.has(f.id) && onPaper.has(f.recipient_id)), docPages, flat: (sha) => flatPages(doc, sha) });
  await addSupplements(e, { flat: (sha) => flatPages(doc, sha), add: (p) => doc.addPage(p), sheet: () => new Sheet(doc, font, bold, footLine), foot: (p) => (drawFootClear(p, mapper(p), [], { line: footLine, font, color: MUTED }), mark && drawStamp(p, bold, mark)) });
  if (opts.certificate) await drawCertificate(ctx, e, audit, opts.sender);
  doc.setTitle(e.subject || 'Signed document');
  doc.setProducer('GrowSigning');
  doc.setCreator('GrowSigning');
  return doc.save();
}

// A record of our own that is not an envelope (the certificate of a click-to-agree acceptance, src/server/clickwrap.ts),
// drawn with the same fonts, scripts and sheet as the certificate of completion. `draw` fills the sheet; `after` may
// add pages behind it (the terms as they were shown, when they were a PDF).
export async function sheetPdf(title: string, footer: string, draw: (s: Sheet) => void | Promise<void>, after?: (doc: PDFDocument) => Promise<void>, o?: { badge?: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes('DejaVuSans.ttf'), { subset: true });
  const bold = await doc.embedFont(fontBytes('DejaVuSans-Bold.ttf'), { subset: true });
  const s = new Sheet(doc, font, bold, footer, o?.badge !== false);
  drawBrandHeader(s.page, { W: s.W, H: s.H, L: s.L, title: clean(title), bold });
  s.y = s.H - 112;
  await draw(s);
  if (after) await after(doc);
  doc.setTitle(title);
  doc.setProducer('GrowSigning');
  doc.setCreator('GrowSigning');
  return doc.save();
}
