import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFPage, PDFFont, PDFName, PDFDict, PDFRef, PDFArray, PDFNumber, PDFStream, rgb, degrees, pushGraphicsState, popGraphicsState, translate, drawObject, concatTransformationMatrix } from 'pdf-lib';
import { jpegOrientation, markUpright, uprightMatrix, liesOnItsSide, pictureLimit } from './exif.ts';
import fontkitMod from '@pdf-lib/fontkit';
import { readBlob, get } from './db.ts';
import { bad } from './util.ts';
import { impactOf, fmtTrees, fmtNum, PRICING } from '../lib/impact.ts';
import { formatDate, formatDateValue, localStamp, validZone } from '../lib/dates.ts';
import { typesetterFor } from './pdftext.ts';
import { isolate, hasRtl } from './bidi.ts';
import { PRINT_MARK, codePoints } from '../lib/scripts.ts';
import { strikeLines } from '../lib/strike.ts';
import { certName, certGroup } from '../lib/groups.ts';
import { labelOf } from '../lib/bysender.ts';

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
    // member who acted, once that person has finished (see printedWords in envelopes.ts).
    case 'full_name': return (r?.group_name && r.status !== 'completed' ? '' : r?.name) || '';
    case 'email': return (r?.group_name && r.status !== 'completed' ? '' : r?.email) || '';
    case 'date_signed': return r?.completed_at ? formatDate(r.completed_at, dateFormat, validZone(r.tz) || senderTz) : '';
    case 'date': return formatDateValue(f.value, dateFormat);
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
  const base = Math.max(6, Math.min(11, vh * 0.62));
  const multi = vh > base * 2.6 || text.includes('\n');
  // The typesetter picks a font for every script, puts right-to-left text in its reading order with digits and
  // Latin words left to right, and says how wide a line is. A line that reads right to left starts at the right
  // edge of its box, as it would on paper.
  const ts = typesetterFor(ctx.doc, ctx.font, ctx.bold);
  const left = (ln: { width: number; rtl: boolean }, size: number) => (ln.rtl ? vx + vw - 2 - (ln.width * size) / 1000 : vx + 2);
  if (multi) {
    const size = Math.min(base, 10);
    const lh = size * 1.3;
    const lines = ts.wrap(text, size, vw - 4).slice(0, Math.max(1, Math.floor(vh / lh)));
    lines.forEach((ln, i) => {
      const p = m.pt(left(ln, size), vy + size + 1 + i * lh);
      ts.draw(page, ln, { x: p.x, y: p.y, size, color: INK, rotate: m.rotate });
    });
  } else {
    const ln = ts.layout(text);
    // As large as fits the box, in half-point steps, never below 5 points.
    const size = Math.max(5, Math.min(base, Math.floor((((vw - 4) * 1000) / Math.max(1, ln.width)) * 2) / 2));
    const p = m.pt(left(ln, size), vy + vh / 2 + size * 0.35);
    ts.draw(page, ln, { x: p.x, y: p.y, size, color: INK, rotate: m.rotate });
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
  s.kv('Sender', sender ? `${iso(sender.name)} <${sender.email}>` : '-');
  s.kv('Sent', ts(e.sent_at));
  s.kv('Completed', ts(e.completed_at));
  s.kv('Signing order', e.ordered ? 'Sequential' : 'Everyone at once');

  s.h2('Documents');
  for (const d of e.documents) {
    s.text(`${iso(d.name)} (${d.pages} page${d.pages === 1 ? '' : 's'})`, { size: 9, bold: true });
    s.text(`SHA-256 of the original: ${d.sha256}`, { size: 7, color: MUTED, gap: 3 });
  }

  s.h2('Recipients');
  for (const r of e.recipients) {
    s.need(96);
    const top = s.y;
    // For a group: the member who acted and the group ("Maya Lopez, for HR team"), see certName in src/lib/groups.ts.
    s.text(certName(r, iso), { size: 10, bold: true, maxW: 330 });
    s.kv('Role', ROLE_LABEL[r.role] || r.role);
    s.kv('Status', r.status === 'completed' ? (r.role === 'cc' ? 'Copied' : r.role === 'viewer' ? 'Viewed' : r.role === 'approver' ? 'Approved' : 'Signed') : r.status);
    s.kv('Sent', ts(r.sent_at));
    if (r.role !== 'cc') {
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
      s.kv('E-record consent', ts(r.consent_at));
      s.kv('IP address', r.ip || '-');
      // The same moments by this person's own clock, in the time zone their device reported. The date of signing on
      // the pages is the calendar day there, so the certificate shows what that day rests on, next to UTC above.
      const zone = validZone(r.tz);
      if (zone) {
        s.kv('Time zone', `${zone}, as reported by their device`);
        if (r.viewed_at) s.kv('Viewed, their time', localStamp(r.viewed_at, zone));
        if (r.consent_at) s.kv('Consent, their time', localStamp(r.consent_at, zone));
        if (r.completed_at) s.kv('Completed, their time', localStamp(r.completed_at, zone));
      }
      if (r.reassigned_from) s.kv('Reassigned from', known(r.reassigned_from));
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
  for (const a of audit) {
    s.need(24);
    const y0 = s.y;
    s.page.drawText(ts(a.at), { x: s.L, y: y0 - 8, size: 7.5, font: ctx.font, color: MUTED });
    s.text(known(`${a.action}${a.detail ? ` · ${a.detail}` : ''}`), { size: 8, x: s.L + 118, maxW: 330 });
    s.text(known(`${a.actor}${a.ip ? ` · ${a.ip}` : ''} · ${a.hash.slice(0, 16)}${zones.has(a.actor) ? ` · their time ${localStamp(a.at, zones.get(a.actor))}` : ''}`), { size: 6.5, x: s.L + 118, color: MUTED, gap: 3 });
  }
  if (audit.length) s.kv('Chain head', audit[audit.length - 1].hash, s.L, 70);

  // A character none of our fonts has is never left as an empty box. It is marked wherever it stood, and listed here
  // by its Unicode number, so what was typed can be put back together from this record.
  const gone = [...typesetterFor(ctx.doc, ctx.font, ctx.bold).missing].join('');
  if (gone) {
    const n = [...gone].length;
    s.h2('Characters this PDF could not print');
    s.text(`The fonts of this PDF do not have ${n === 1 ? 'one character' : `${n} different characters`} used in this envelope. Wherever ${n === 1 ? 'it' : 'one of them'} stood, the pages and this certificate show the mark ${PRINT_MARK} instead. By Unicode number, in the order they first appear: ${codePoints(gone)}. On screen and in emails they show as they were typed.`, { size: 8, gap: 4 });
  }

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
  const flat = await PDFDocument.load(await src.save({ updateFieldAppearances: false }));
  return doc.copyPages(flat, flat.getPageIndices());
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
  noticeSheet(doc, font, bold, `Sign&Grow · ${mark} · Envelope ${envelopeId}`, notice);
  const src = await PDFDocument.load(pdf, { updateMetadata: false });
  for (const page of await doc.copyPages(src, src.getPageIndices())) {
    doc.addPage(page);
    const m = mapper(page);
    const p = m.pt(12, 22);
    page.drawText(clean(`${mark.toUpperCase()}, see the first page`), { x: p.x, y: p.y, size: 6.5, font, color: MUTED, rotate: m.rotate });
  }
  doc.setTitle(notice.title);
  doc.setProducer('Sign&Grow');
  doc.setCreator('Sign&Grow');
  return doc.save();
}

/** The time zone of whoever sent an envelope, as their browser last reported it. Null when it never did. */
export const senderZone = (e: any): string | null => validZone(e?.sender_id ? get('SELECT tz FROM users WHERE id=?', e.sender_id)?.tz : null);

// Builds the signed PDF: every document with field values stamped in, signer attachments, then the certificate.
// `notice` is for a copy of an envelope that was never completed (voided, declined or out of time), made for someone
// who had signed it: the copy opens with a page that says so and why, and every page carries the words too.
export async function renderEnvelopePdf(e: any, audit: any[], opts: { certificate: boolean; sender?: any; viewer?: string; notice?: { title: string; lines: string[] } }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes('DejaVuSans.ttf'), { subset: true });
  const bold = await doc.embedFont(fontBytes('DejaVuSans-Bold.ttf'), { subset: true });
  if (opts.notice) noticeSheet(doc, font, bold, `Sign&Grow · Not completed · Envelope ${e.id}`, opts.notice);
  const ctx: Ctx = { doc, font, bold, images: new Map(), recipients: new Map(e.recipients.map((r: any) => [r.id, r])), dateFormat: e.date_format, tz: senderZone(e) };
  // A copy made for one recipient (`viewer`) while others are still at work shows the pages as that recipient's
  // screen does: everything the sender wrote, what people who have finished filled in, and what the viewer has
  // entered so far. Another person's half-filled answer, saved signature or uploaded file is not printed until that
  // person has finished: their field shows what the sender put there, or nothing.
  const asSeen = (f: any) => {
    const o = f.recipient_id ? ctx.recipients.get(f.recipient_id) : null;
    return !opts.viewer || !o || o.id === opts.viewer || o.status === 'completed' || f.readonly ? f : { ...f, value: f.prefill ?? null };
  };
  const fields = e.fields.map(asSeen);

  for (const d of e.documents) {
    const pages = await flatPages(doc, d.sha256);
    pages.forEach((p) => doc.addPage(p));
    for (const f of fields.filter((f: any) => f.document_id === d.id)) {
      const page = pages[f.page];
      if (page) await drawField(ctx, page, f);
    }
    for (const page of pages) {
      const m = mapper(page);
      const p = m.pt(12, 13);
      page.drawText(`Sign&Grow Envelope ID: ${e.id}${opts.notice ? ' · NOT COMPLETED BY EVERYONE, see the first page' : ''}`, { x: p.x, y: p.y, size: 6.5, font, color: MUTED, rotate: m.rotate });
    }
  }
  for (const f of fields.filter((f: any) => f.type === 'attachment' && f.value)) {
    const file = get('SELECT sha256 FROM files WHERE id=?', f.value);
    if (!file) continue;
    try {
      (await flatPages(doc, file.sha256)).forEach((p) => doc.addPage(p));
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
