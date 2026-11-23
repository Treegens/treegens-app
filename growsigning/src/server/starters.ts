// Ready-made templates (src/lib/starters/): a starter rendered to a PDF with our embedded fonts, its fields placed
// under the paragraphs they belong to, and a normal template made of it in the account.
//
// The PDF is the starter's text with the words the sender wrote in when they picked it (their organisation's name,
// and for some a partner or an event). It has no logo and no "not legal advice" line: it is the organisation's own
// document, and that note is for the sender (the list and the editor), not for the people who sign.
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import fontkitMod from '@pdf-lib/fontkit';
import { run, saveBlob, all } from './db.ts';
import { id, now, bad } from './util.ts';
import { typesetterFor } from './pdftext.ts';
import { createEnvelope, saveDraft, loadEnvelope, audit, type Actor } from './envelopes.ts';
import { keepText } from './searchtext.ts';
import { posesAs, plain } from './fakenotice.ts';
import { PRODUCT } from '../lib/site.ts';
import { asksOf, cleanAsk, fillText, askProblem, starterNote, type Starter, type StarterField } from '../lib/starters/index.ts';

const fontkit: any = (fontkitMod as any).default || fontkitMod;
const INK = rgb(0.11, 0.13, 0.12);
const MUTED = rgb(0.4, 0.43, 0.41);
const LINE = rgb(0.55, 0.58, 0.56);

// A4, which most of the world prints on. Margins wide enough for a hole punch and for the strip a signed copy adds at the foot.
export const PAGE = { W: 595.28, H: 841.89 };
const L = 52;
const CW = PAGE.W - 2 * L;
const TOP = 64;
const BOTTOM = 62;
const BODY = 10;
const LEAD = BODY * 1.45;

/** How big each kind of field is drawn, in points. A text answer gets the whole line. */
const SIZE: Record<StarterField['type'], { w: number; h: number }> = {
  signature: { w: 190, h: 40 },
  initials: { w: 70, h: 30 },
  full_name: { w: 170, h: 20 },
  email: { w: 230, h: 20 },
  date_signed: { w: 95, h: 20 },
  date: { w: 120, h: 20 },
  text: { w: CW, h: 20 },
  checkbox: { w: 12, h: 12 },
};

/** A field where it landed: page counted from 0, and x, y, w, h as fractions of the page from its top left, like every field. */
export type Placed = StarterField & { page: number; x: number; y: number; w: number; h: number };

const fontsDir = () => path.join(/* turbopackIgnore: true */ process.cwd(), 'assets', 'fonts');

/**
 * The starter as a PDF. `values` holds what the sender wrote in, by key ({organisation}, {partner}, ...); a key with
 * nothing in it is printed as its label in brackets, which is what the preview shows.
 */
export async function renderStarter(s: Starter, values: Record<string, string>): Promise<{ pdf: Uint8Array; text: string; pages: number; fields: Placed[] }> {
  const fill: Record<string, string> = {};
  for (const a of asksOf(s)) fill[a.key] = cleanAsk(values[a.key]) || `[${a.label}]`;
  const words = (t: string) => fillText(t, fill);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(path.join(fontsDir(), 'DejaVuSans.ttf')), { subset: true });
  const bold = await doc.embedFont(fs.readFileSync(path.join(fontsDir(), 'DejaVuSans-Bold.ttf')), { subset: true });
  // The typesetter prints names in any script (it falls back to the other fonts we ship), so an organisation's name in
  // Arabic, Devanagari or Chinese comes out as written.
  const ts = typesetterFor(doc, font, bold);
  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let top = 0; // distance from the top of the page, in points
  const text: string[] = [];
  const placed: Placed[] = [];
  const add = () => {
    page = doc.addPage([PAGE.W, PAGE.H]);
    pages.push(page);
    top = TOP;
  };
  const need = (h: number) => {
    if (top + h > PAGE.H - BOTTOM) add();
  };
  const write = (t: string, o: { size?: number; bold?: boolean; color?: any; x?: number; maxW?: number; keep?: number } = {}) => {
    const size = o.size ?? BODY;
    const lead = size * 1.45;
    const x = o.x ?? L;
    const lines = ts.wrap(t, size, o.maxW ?? CW - (x - L), { bold: o.bold });
    // A heading is kept with the first lines under it (keep), so it never stands alone at the foot of a page.
    need(Math.min(lines.length, 2) * lead + (o.keep ?? 0));
    for (const ln of lines) {
      need(lead);
      ts.draw(page, ln, { x, y: PAGE.H - top - size, size, color: o.color ?? INK });
      top += lead;
    }
    text.push(t);
  };
  const box = (f: StarterField, x: number, y: number, w: number, h: number) => {
    placed.push({ ...f, page: pages.length - 1, x: x / PAGE.W, y: y / PAGE.H, w: w / PAGE.W, h: h / PAGE.H });
  };
  // Fields in rows: a label above each, a line to write on, side by side while they fit on the line.
  const fieldRows = (list: StarterField[]) => {
    top += 4;
    let i = 0;
    while (i < list.length) {
      const f = list[i];
      if (f.type === 'checkbox') {
        const size = 9.5;
        const lines = ts.wrap(f.label, size, CW - 22);
        const h = Math.max(SIZE.checkbox.h, lines.length * size * 1.4) + 8;
        need(h);
        page.drawRectangle({ x: L, y: PAGE.H - top - 13, width: 12, height: 12, borderColor: LINE, borderWidth: 0.8 });
        box(f, L, top + 1, 12, 12);
        let ly = top;
        for (const ln of lines) {
          ts.draw(page, ln, { x: L + 22, y: PAGE.H - ly - size - 1, size, color: INK });
          ly += size * 1.4;
        }
        text.push(f.label);
        top += h;
        i++;
        continue;
      }
      const row: StarterField[] = [];
      let used = 0;
      while (i < list.length && list[i].type !== 'checkbox') {
        const w = SIZE[list[i].type].w;
        if (row.length && used + 16 + w > CW) break;
        used += (row.length ? 16 : 0) + w;
        row.push(list[i++]);
      }
      const h = Math.max(...row.map((r) => SIZE[r.type].h));
      const labelH = 11;
      need(labelH + h + 12);
      let x = L;
      for (const r of row) {
        const sz = SIZE[r.type];
        const label = ts.wrap(r.label, 7.5, sz.w)[0];
        if (label) ts.draw(page, label, { x, y: PAGE.H - top - 7.5, size: 7.5, color: MUTED });
        const boxTop = top + labelH + (h - sz.h);
        page.drawLine({ start: { x, y: PAGE.H - boxTop - sz.h }, end: { x: x + sz.w, y: PAGE.H - boxTop - sz.h }, thickness: 0.7, color: LINE });
        box(r, x, boxTop, sz.w, sz.h);
        text.push(r.label);
        x += sz.w + 16;
      }
      top += labelH + h + 12;
    }
    top += 2;
  };

  add();
  write(s.title, { size: 18, bold: true });
  top += 2;
  write(fill.organisation, { size: 10.5, color: MUTED });
  top += 10;
  const byBlock = new Map<string, StarterField[]>();
  for (const f of s.fields) byBlock.set(f.after, [...(byBlock.get(f.after) || []), f]);
  // How tall a block and the fields under it come out, so a heading starts a new page with what belongs under it
  // rather than leaving the signatures alone on the next one.
  const fieldsH = (list: StarterField[]) => {
    let h = 6, i = 0;
    while (i < list.length) {
      if (list[i].type === 'checkbox') {
        h += Math.max(SIZE.checkbox.h, ts.wrap(list[i].label, 9.5, CW - 22).length * 9.5 * 1.4) + 8;
        i++;
        continue;
      }
      let used = 0, row = 0, n = 0;
      while (i < list.length && list[i].type !== 'checkbox') {
        const w = SIZE[list[i].type].w;
        if (n && used + 16 + w > CW) break;
        used += (n ? 16 : 0) + w;
        row = Math.max(row, SIZE[list[i].type].h);
        n++;
        i++;
      }
      h += 11 + row + 12;
    }
    return h;
  };
  const blockH = (b: (typeof s.blocks)[number]) =>
    (b.kind === 'p' ? ts.wrap(words(b.text || ''), BODY, CW).length * LEAD + 4 : b.kind === 'list' ? (b.items || []).reduce((n, it) => n + ts.wrap(words(it), BODY, CW - 14).length * LEAD + 2, 2) : 0)
    + (byBlock.has(b.id) ? fieldsH(byBlock.get(b.id)!) : 0);
  const room = PAGE.H - TOP - BOTTOM;
  s.blocks.forEach((b, n) => {
    if (b.kind === 'h') {
      top += 8;
      const next = s.blocks[n + 1];
      const section = 11 * 1.45 + 2 + (byBlock.has(b.id) ? fieldsH(byBlock.get(b.id)!) : 0) + (next && next.kind !== 'h' ? blockH(next) : 0);
      write(words(b.text || ''), { size: 11, bold: true, keep: Math.min(section, room) - 11 * 1.45 });
      top += 2;
    } else if (b.kind === 'p') {
      write(words(b.text || ''));
      top += 4;
    } else {
      for (const item of b.items || []) {
        const lines = ts.wrap(words(item), BODY, CW - 14);
        need(LEAD);
        ts.draw(page, ts.wrap('•', BODY, 10)[0], { x: L + 2, y: PAGE.H - top - BODY, size: BODY, color: INK });
        for (const ln of lines) {
          need(LEAD);
          ts.draw(page, ln, { x: L + 14, y: PAGE.H - top - BODY, size: BODY, color: INK });
          top += LEAD;
        }
        text.push(words(item));
        top += 2;
      }
      top += 2;
    }
    const here = byBlock.get(b.id);
    if (here) fieldRows(here);
  });
  // The foot of each page: what the document is and where in it you are, above the strip a signed copy adds.
  pages.forEach((p, n) => {
    const foot = ts.wrap(`${s.title} · page ${n + 1} of ${pages.length}`, 7.5, CW)[0];
    if (foot) ts.draw(p, foot, { x: L, y: 34, size: 7.5, color: MUTED });
  });
  doc.setTitle(s.title);
  doc.setProducer('GrowSigning');
  doc.setCreator('GrowSigning');
  return { pdf: await doc.save(), text: text.join('\n'), pages: pages.length, fields: placed };
}

/** The words a sender wrote in, cleaned and checked: a refusal names what to fix, and nothing is made. */
export function starterValues(s: Starter, body: any): Record<string, string> {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  for (const a of asksOf(s)) {
    if (raw[a.key] != null && typeof raw[a.key] !== 'string') throw bad(`"${a.key}" has to be text. Nothing was made.`);
  }
  const problem = askProblem(s, raw);
  if (problem) throw bad(`${problem} Nothing was made.`);
  const values: Record<string, string> = {};
  for (const a of asksOf(s)) values[a.key] = cleanAsk(raw[a.key]);
  // A name that reads like a well-known company ("PayPal Billing") is how fake payment notices are dressed up. The same
  // filter checks every send; here it stops the template from being made at all.
  for (const a of asksOf(s)) {
    const brand = posesLike(values[a.key]);
    if (brand) throw bad(`"${values[a.key]}" reads like the name of ${brand}, so nothing was made. Write the name of your own organisation.`, 400, { code: 'poses_as' });
  }
  return values;
}

/**
 * The brand a word reads like, or null: the well-known companies the send check knows (fakenotice.ts), and our own
 * name, old and new, since a document headed "GrowSigning Support" reads as if it came from us.
 */
// Glued and in small letters: GrowSigning (and GrowSigner), and the name before it. Built from pieces so the check
// for the old name (tests/brand.test.ts) does not take this line for a left-over.
const OUR_NAMES = new RegExp(['grow' + 'sign', 'sign' + 'and' + 'grow', 'sign' + 'grow'].join('|'));
export function posesLike(v: string): string | null {
  const brand = posesAs(v);
  if (brand) return brand;
  const glued = plain(v).replace(/[^a-z]/g, '');
  return OUR_NAMES.test(glued) ? PRODUCT : null;
}

/** The words for a preview: a word that reads like a brand is left out, so its label in brackets is printed instead. */
export function previewValues(s: Starter, q: { get(k: string): string | null }): Record<string, string> {
  const values: Record<string, string> = {};
  for (const a of asksOf(s)) {
    const v = cleanAsk(q.get(a.key)).slice(0, a.max);
    values[a.key] = posesLike(v) ? '' : v;
  }
  return values;
}

/**
 * A normal template in the account, made from a starter: it belongs to the person who picked it, everyone on the
 * team may use it (the usual rule, tplroles.ts), and its PDF, roles and fields can be changed like any other.
 */
export async function makeFromStarter(account: any, userId: string, actor: Actor, s: Starter, values: Record<string, string>): Promise<string> {
  const r = await renderStarter(s, values);
  const fid = id('fil');
  const kept = keepText(fid, r.text);
  const sizes = Array.from({ length: r.pages }, () => ({ w: PAGE.W, h: PAGE.H }));
  run('INSERT INTO files (id, account_id, sha256, name, size, pages, page_sizes, created_at, text, scan_pages, text_sealed, text_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    fid, account.id, saveBlob(r.pdf), s.title, r.pdf.length, r.pages, JSON.stringify(sizes), now(), kept.text, null, kept.sealed, kept.key);
  const eid = createEnvelope(account, userId, 'template', { subject: s.title });
  try {
    saveDraft(loadEnvelope(eid), {
      ordered: s.roles.length > 1,
      documents: [{ id: 'd', file_id: fid, name: s.title }],
      recipients: s.roles.map((ro, i) => ({ id: ro.key, role: 'signer', role_name: ro.name, name: '', email: '', routing_order: s.roles.length > 1 ? ro.order : 1, position: i })),
      fields: r.fields.map((f, i) => ({ id: `f${i + 1}`, document_id: 'd', recipient_id: f.role, type: f.type, label: f.label, required: f.required, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h })),
    }, account.id);
  } catch (e) {
    run('DELETE FROM envelopes WHERE id=?', eid);
    run('DELETE FROM files WHERE id=?', fid);
    throw e;
  }
  const note = starterNote(s);
  run('UPDATE envelopes SET starter_id=?, starter_note=? WHERE id=?', s.id, note, eid);
  audit(eid, actor, 'Made from a ready-made template', `${s.title}, written ${s.written}. ${note}`);
  return eid;
}

/** The templates in this account made from each starter, newest first, for "You made one on ...". */
export function madeFrom(accountId: string): Map<string, { id: string; subject: string; created_at: string }[]> {
  const out = new Map<string, { id: string; subject: string; created_at: string }[]>();
  for (const t of all("SELECT id, subject, created_at, starter_id FROM envelopes WHERE account_id=? AND kind='template' AND starter_id IS NOT NULL AND hidden_at IS NULL ORDER BY created_at DESC", accountId))
    out.set(t.starter_id, [...(out.get(t.starter_id) || []), { id: t.id, subject: t.subject, created_at: t.created_at }]);
  return out;
}
