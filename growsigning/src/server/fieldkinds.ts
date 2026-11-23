// More kinds of field on the server (the rules are in src/lib/fieldkinds.ts, shared with the editor and the signing
// page): first and last name, drawing, Approve and Decline buttons, "Same answer as", "Date from another date", text
// style and saved fields. What a sender saves is checked here and refused in words when it cannot work; what a signer
// sends is settled here again whatever their browser did; the PDF prints it with drawKind and drawStyled.
import { PDFDocument, PDFPage, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { all, get, run } from './db.ts';
import { bad, id as newId, now, str } from './util.ts';
import { sealField } from './colcrypt.ts';
import { validZone } from '../lib/dates.ts';
import { typesetterFor } from './pdftext.ts';
import {
  isNamePart, namePart, NAME_CHECK, isButton, BUTTON_ROLES, isDrawingValue, LINKABLE, linkOf, settleLinked, dateFromOf, dayOf,
  DATE_UNITS, DATE_ADD_MAX, dateFromValue, dateFromWords, DATE_FROM_NOTE, lookOf, lookProblem, lookHex, STYLED, SAVED_KEYS, SAVABLE, SAVED_MAX,
  SAVED_NAME_MAX, savedKey, KIND_LABEL, type Look,
} from '../lib/fieldkinds.ts';

const NO = ' Nothing was saved.';
type Entry = { fid: string; f: any; rid: string | null; which: string };
const parse = (s: any) => {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s ?? null;
  } catch {
    return null;
  }
};
const fieldWord = (f: any) => (f?.label ? `'${String(f.label).slice(0, 60)}'` : `the ${(KIND_LABEL[f?.type] || String(f?.type || 'field').replace('_', ' ')).toLowerCase()} field on page ${Number(f?.page || 0) + 1}`);

/** The new columns as the API and the editor get them: the rule and the style as objects, the link as text. */
export const kindView = (f: any) => ({ link: f.link || null, date_from: dateFromOf(f), look: lookOf(f.look) });

/** The text style new fields of an account start with, or null. */
export const accountLook = (accountId: string): Look | null => lookOf(get('SELECT field_look FROM accounts WHERE id=?', accountId)?.field_look);

/**
 * Saves "link", "date_from" and "look" of every field writeContent (src/server/envelopes.ts) has just written, in the
 * same transaction, so a refusal saves nothing. Also makes the buttons and the worked-out dates what they must be:
 * never required, never holding the sender's words. A field that is new and was sent without "look" starts with the
 * account's text style. Then every date worked out from another date is worked out again.
 */
export function saveKinds(e: any, entries: Entry[], accountId: string) {
  const given = new Map<string, Entry>();
  for (const x of entries) if (x.f?.id != null && x.f.id !== '') given.set(String(x.f.id), x);
  const stored = new Map<string, Entry>(entries.map((x) => [x.fid, x]));
  const roles = new Map<string, any>(all('SELECT id, role, name, role_name FROM recipients WHERE envelope_id=?', e.id).map((r: any) => [r.id, r]));
  const who = (rid: string | null) => roles.get(rid || '')?.name || roles.get(rid || '')?.role_name || 'someone';
  const had = new Set<string>((e.fields || []).map((f: any) => f.id));
  // A field sent back without "look" keeps the style it had: an API caller that does not echo it loses nothing.
  const oldLook = new Map<string, any>((e.fields || []).map((f: any) => [f.id, f.look]));
  const dflt = accountLook(accountId);
  const plan: { fid: string; link: string | null; date_from: string | null; look: string | null }[] = [];
  for (const x of entries) {
    const { f, which, rid } = x;
    if (isButton(f.type) && !BUTTON_ROLES.includes(roles.get(rid || '')?.role))
      throw bad(`${which} is ${f.type === 'approve' ? 'an Approve' : 'a Decline'} button for ${who(rid)}, who ${roles.get(rid || '')?.role === 'cc' ? 'only gets a copy' : 'does not sign or approve'}. Give it to someone who signs or approves, or delete it.${NO}`);
    // Same answer as.
    let link: string | null = null;
    if (f.link != null && f.link !== '') {
      if (typeof f.link !== 'string') throw bad(`${which}: "link" is text, the name the fields that share an answer have in common.${NO}`);
      if (!LINKABLE.includes(f.type)) throw bad(`${which} is a ${(KIND_LABEL[f.type] || f.type).toLowerCase()} field, which cannot share an answer with another field. Only text, number, date, company, job title, first and last name, tick box and choice fields can.${NO}`);
      link = linkOf(f) || null;
    }
    // Date from another date.
    let df: string | null = null;
    if (f.date_from != null && f.date_from !== '') {
      if (f.type !== 'date') throw bad(`${which} is not a date field. Only a date field can be worked out from another date.${NO}`);
      const raw = parse(f.date_from);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad(`${which}: "date_from" must be an object like {"from": "f2", "add": 30, "unit": "days"}, naming the date it is worked out from.${NO}`);
      // A draft is saved as the sender works: a date that counts from nothing yet (none chosen, or the one it counted
      // from was deleted, moved to someone else or made another kind) is kept waiting for a choice, and sending is
      // refused until there is one (kindsProblem).
      const src = raw.from == null || raw.from === '' ? null : given.get(String(raw.from)) || stored.get(String(raw.from)) || null;
      const why = !src ? (raw.from == null || raw.from === '' ? `${which} is a date from another date, and no date is chosen to count from. Choose one, or delete the field.` : `${which} is worked out from "${str(raw.from, 60)}", and no field in this save has that id.`)
        : src.fid === x.fid ? `${which} cannot be worked out from itself. Choose another date.`
        : src.rid !== rid ? `${which} belongs to ${who(rid)}, and ${fieldWord(src.f)} belongs to ${src.rid ? who(src.rid) : 'nobody'}. A date can only be worked out from a date of the same person.`
        : src.f.type !== 'date' && src.f.type !== 'date_signed' ? `${which} is worked out from ${fieldWord(src.f)}, which is not a date. Choose a date field or a date signed field.`
        : src.f.date_from ? `${which} is worked out from ${fieldWord(src.f)}, which is worked out from another date itself. Work both out from the first date instead.` : '';
      if (why && e.status !== 'draft') throw bad(`${why}${NO}`);
      const add = Number(raw.add ?? 0);
      if (!Number.isInteger(add) || Math.abs(add) > DATE_ADD_MAX) throw bad(`${which}: "add" must be a whole number from -${DATE_ADD_MAX} to ${DATE_ADD_MAX}.${NO}`);
      const unit = raw.unit ?? 'days';
      if (!(DATE_UNITS as readonly string[]).includes(unit)) throw bad(`${which}: "unit" must be "days", "weeks" or "months".${NO}`);
      // A date that is not there any more is forgotten; one that cannot be used is kept, so sending says why.
      df = JSON.stringify({ from: src ? src.fid : '', add, unit });
      if (link) throw bad(`${which} is worked out from another date, so it cannot share an answer with a field someone types in. Take it out of "Same answer as", or make it a plain date.${NO}`);
    }
    // Text style.
    let look: string | null = null;
    if (f.look !== undefined) {
      const p = lookProblem(f.look);
      if (p) throw bad(`${which}: ${p}${NO}`);
      const l = STYLED.includes(f.type) ? lookOf(f.look) : null;
      look = l ? JSON.stringify(l) : null;
    } else if (had.has(x.fid)) {
      const l = STYLED.includes(f.type) ? lookOf(oldLook.get(x.fid)) : null;
      look = l ? JSON.stringify(l) : null;
    } else if (dflt && STYLED.includes(f.type)) look = JSON.stringify(dflt);
    plan.push({ fid: x.fid, link, date_from: df, look });
  }
  // Fields that share an answer are of one kind: a tick box and a text cannot hold the same answer.
  const groups = new Map<string, Entry[]>();
  for (const p of plan) if (p.link) {
    const x = stored.get(p.fid)!;
    const k = `${x.rid}\u0000${p.link}`;
    groups.set(k, [...(groups.get(k) || []), x]);
  }
  for (const [, g] of groups) {
    const kinds = new Set(g.map((x) => x.f.type));
    if (kinds.size > 1) throw bad(`${g.map((x) => fieldWord(x.f)).join(' and ')} of ${who(g[0].rid)} share an answer, and they are different kinds of field. Only fields of the same kind can share an answer.${NO}`);
  }
  for (const p of plan) if (p.link || p.date_from || p.look) run('UPDATE fields SET link=?, date_from=?, look=? WHERE id=?', p.link, p.date_from, p.look, p.fid);
  // A worked-out date is never typed into, and a button holds no answer.
  run("UPDATE fields SET required=0, readonly=0, prefill=NULL WHERE envelope_id=? AND date_from IS NOT NULL", e.id);
  run("UPDATE fields SET required=0, value=NULL, prefill=NULL WHERE envelope_id=? AND type IN ('approve','decline')", e.id);
  settleDates(e.id);
}

/** Why the new kinds stop an envelope from being sent, or ''. Said with what to do. */
export function kindsProblem(e: any): string {
  for (const f of e.fields || []) {
    const rule = dateFromOf(f);
    if (!rule) continue;
    const src = e.fields.find((g: any) => g.id === rule.from);
    const name = `${f.label ? `'${String(f.label).slice(0, 60)}'` : 'The date from another date'} on page ${Number(f.page || 0) + 1}`;
    if (!rule.from) return `${name} counts from a date you have not chosen yet. Open it in step 2 and choose one under Counted from, or delete it.`;
    if (!src || src.recipient_id !== f.recipient_id || (src.type !== 'date' && src.type !== 'date_signed') || dateFromOf(src))
      return `${name} cannot count from the date chosen for it. It must count from a Date or a Date signed field of the same person. Open it in step 2 and choose one under Counted from, or delete it.`;
  }
  return '';
}

/** The new columns go with every copy (templates, cloning, bulk send, public forms), pointing at the copy's own fields. */
export function copyKinds(src: any, fmap: Map<string, string>) {
  for (const f of src.fields || []) {
    const df = dateFromOf(f);
    const look = lookOf(f.look);
    if (!f.link && !df && !look) continue;
    run('UPDATE fields SET link=?, date_from=?, look=? WHERE id=?', linkOf(f) || null, df ? JSON.stringify({ ...df, from: fmap.get(df.from) || '' }) : null, look ? JSON.stringify(look) : null, fmap.get(f.id));
  }
}

const senderZoneOf = (e: any): string | null => validZone(e?.sender_id ? get('SELECT tz FROM users WHERE id=?', e.sender_id)?.tz : null);

/** The calendar day someone signed on: where their device said they were, else the sender's zone, else UTC (as printed). */
export function signedDayOf(r: any, e: any): string {
  return r?.completed_at ? dayOf(r.completed_at, validZone(r.tz) || senderZoneOf(e) || 'UTC') : '';
}

/**
 * Works out every date that comes from another date, for everyone who has not finished, and writes it down. A date
 * from the date of signing is there once its person has signed. Someone who has finished keeps what they signed,
 * except the person finishing right now (`acting`).
 */
export function settleDates(envelopeId: string, acting?: string | null) {
  const fields = all('SELECT id, recipient_id, type, value, date_from FROM fields WHERE envelope_id=?', envelopeId);
  if (!fields.some((f: any) => f.date_from)) return;
  const e = get('SELECT id, sender_id FROM envelopes WHERE id=?', envelopeId);
  const people = new Map<string, any>(all('SELECT id, status, completed_at, tz FROM recipients WHERE envelope_id=?', envelopeId).map((r: any) => [r.id, r]));
  const byId = new Map<string, any>(fields.map((f: any) => [f.id, f]));
  for (const f of fields) {
    const rule = dateFromOf(f);
    if (!rule) continue;
    const r = people.get(f.recipient_id);
    if (r?.status === 'completed' && r.id !== acting) continue;
    const v = dateFromValue(rule, byId.get(rule.from), {}, signedDayOf(r, e)) || null;
    if (v !== (f.value ?? null)) run('UPDATE fields SET value=? WHERE id=?', sealField(f.type, v), f.id);
  }
}

/**
 * What a signer sends, made right before anything is stored (applyValues in envelopes.ts): a first or last name
 * nobody sent keeps what is taken from the name; a drawing is a picture of ours or nothing, stored here because it is
 * longer than any typed answer; a worked-out date is the server's to work out; fields that share an answer get one.
 */
const drawn = new WeakMap<any, string | null>();
export function signerValues(r: any, mine: any[], values: Record<string, any>): Record<string, any> {
  let out: Record<string, any> = { ...values };
  for (const f of mine) {
    if (isNamePart(f.type) && !(f.id in out) && f.value == null) out[f.id] = namePart(r.name, f.type);
    if (f.type === 'drawing' && f.id in out) {
      const v = isDrawingValue(out[f.id]) ? String(out[f.id]) : out[f.id] === '1' && f.value ? f.value : '';
      // Written in afterValues, once every check of this save has passed: a refused save stores nothing.
      f.value = v || null;
      drawn.set(f, v || null);
      delete out[f.id];
    }
    if (isButton(f.type) || dateFromOf(f)) delete out[f.id];
  }
  out = settleLinked(mine.filter((f) => !dateFromOf(f)), out);
  return out;
}

/** After the answers are in: the dates worked out from them, and from today's signing when this is Finish. */
export function afterValues(e: any, r: any, mine: any[], strict: boolean) {
  for (const f of mine) if (drawn.has(f)) {
    run('UPDATE fields SET value=? WHERE id=?', sealField(f.type, drawn.get(f) ?? null), f.id);
    drawn.delete(f);
  }
  if (!mine.some((f) => dateFromOf(f))) return;
  settleDates(e.id, strict ? r.id : null);
  for (const f of mine) if (dateFromOf(f)) f.value = get('SELECT value FROM fields WHERE id=?', f.id)?.value ?? null;
}

/** A signer's own field as their signing page gets it: a name taken from theirs, and a worked-out date said in words. */
export function signerField(f: any, r: any, mine: any[]): any {
  const out: any = { ...f };
  if (isNamePart(f.type)) {
    if (f.value == null) out.value = namePart(r.name, f.type);
    out.from_name = namePart(r.name, f.type);
    out.name_check = NAME_CHECK[f.type];
  }
  const rule = dateFromOf(f);
  if (rule) {
    const src = mine.find((g) => g.id === rule.from);
    out.date_rule = dateFromWords(rule, src ? (src.label || (src.type === 'date_signed' ? 'the date you sign' : 'the date above')) : 'another date');
    out.date_note = `${out.date_rule}. ${DATE_FROM_NOTE}`;
  }
  return out;
}

/** Lines for the certificate: the drawings this person made, said as drawings and never as a signature. */
export function kindCertLines(e: any, r: any): [string, string][] {
  const n = (e.fields || []).filter((f: any) => f.recipient_id === r.id && f.type === 'drawing' && f.value).length;
  return n ? [['Drawings', `${n} drawing${n === 1 ? '' : 's'} made in a Drawing field. A drawing is a picture on the page, not a signature.`]] : [];
}

// ---- The PDF ----------------------------------------------------------------------------------------------------

type Mapper = { W: number; H: number; pt: (x: number, y: number) => { x: number; y: number }; rotate: any };
const pics = new WeakMap<PDFDocument, Map<string, any>>();
const std = new WeakMap<PDFDocument, Map<string, PDFFont>>();
const MUTED = rgb(0.42, 0.47, 0.44);

/**
 * Draws a drawing, an Approve or a Decline button. True when `f` is one of those (also when it prints nothing): a
 * drawing prints its picture, an Approve button prints "Approved" once its person approved or signed, a Decline
 * button prints nothing.
 */
export async function drawKind(doc: PDFDocument, page: PDFPage, f: any, r: any, m: Mapper, font: PDFFont): Promise<boolean> {
  if (f.type !== 'drawing' && !isButton(f.type)) return false;
  const vx = f.x * m.W, vy = f.y * m.H, vw = f.w * m.W, vh = f.h * m.H;
  if (f.type === 'drawing') {
    if (!isDrawingValue(f.value)) return true;
    let cache = pics.get(doc);
    if (!cache) pics.set(doc, (cache = new Map()));
    if (!cache.has(f.value)) {
      let img: any = null;
      try {
        img = await doc.embedPng(Buffer.from(String(f.value).split(',')[1], 'base64'));
      } catch {
        img = null;
      }
      cache.set(f.value, img);
    }
    const img = cache.get(f.value);
    if (!img) return true;
    const s = Math.min(vw / img.width, vh / img.height);
    const w = img.width * s, h = img.height * s;
    const p = m.pt(vx + (vw - w) / 2, vy + (vh + h) / 2);
    page.drawImage(img, { x: p.x, y: p.y, width: w, height: h, rotate: m.rotate });
    return true;
  }
  if (f.type === 'approve' && r?.status === 'completed') {
    const size = Math.max(5, Math.min(10, vh * 0.55));
    const text = r.role === 'approver' ? 'Approved' : 'Finished';
    const p = m.pt(vx + 2, vy + vh / 2 + size * 0.35);
    page.drawText(text, { x: p.x, y: p.y, size, font, color: MUTED, rotate: m.rotate });
  }
  return true;
}

// The letters the standard PDF fonts have (Windows-1252), asked before one is put in the file at all.
const CP1252_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
const cp1252 = (text: string) => [...text].every((ch) => { const c = ch.codePointAt(0)!; return (c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0xff) || CP1252_EXTRA.has(ch); });
const winAnsi = (font: PDFFont, text: string) => {
  try {
    font.encodeText(text);
    font.widthOfTextAtSize(text, 10);
    return true;
  } catch {
    return false;
  }
};

/**
 * Prints the text of a field that has a text style. The font is one we embed: Sans is the usual one with every
 * script's own font; Serif and Typewriter are the standard PDF fonts, which have Latin letters only, so a text with a
 * character they lack is printed in Sans (and a character no font has gets the visible mark, as everywhere). The
 * size is the one chosen, made smaller only when the text would not fit its box. True when it printed.
 */
export async function drawStyled(doc: PDFDocument, page: PDFPage, f: any, text: string, m: Mapper, base: { font: PDFFont; bold: PDFFont }): Promise<boolean> {
  const look = lookOf(f.look);
  if (!look || !text) return false;
  const brand = f.envelope_id ? get('SELECT a.brand_color c FROM envelopes e JOIN accounts a ON a.id=e.account_id WHERE e.id=?', f.envelope_id)?.c : null;
  const hex = lookHex(look, brand);
  const color = rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
  const vx = f.x * m.W, vy = f.y * m.H, vw = f.w * m.W, vh = f.h * m.H;
  const want = look.size || Math.max(6, Math.min(11, vh * 0.62));
  let face: PDFFont | null = null;
  if ((look.font === 'serif' || look.font === 'mono') && cp1252(text.replace(/\n/g, ' '))) {
    const name = look.font === 'serif' ? (look.bold ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman) : look.bold ? StandardFonts.CourierBold : StandardFonts.Courier;
    let cache = std.get(doc);
    if (!cache) std.set(doc, (cache = new Map()));
    if (!cache.has(name)) cache.set(name, await doc.embedFont(name));
    face = cache.get(name)!;
    if (!winAnsi(face, text.replace(/\n/g, ' '))) face = null;
  }
  const multi = text.includes('\n') || vh > want * 2.6;
  if (face) {
    const f2 = face;
    const lines = (sz: number) => {
      const out: string[] = [];
      for (const para of text.split('\n')) {
        let line = '';
        for (const w of para.split(' ')) {
          const next = line ? `${line} ${w}` : w;
          if (line && f2.widthOfTextAtSize(next, sz) > vw - 4) (out.push(line), (line = w));
          else line = next;
        }
        out.push(line);
      }
      return out;
    };
    let size = want;
    if (multi) {
      while (size > 5 && (lines(size).length * size * 1.3 > vh || lines(size).some((l) => f2.widthOfTextAtSize(l, size) > vw - 4))) size -= 0.5;
      lines(size).slice(0, Math.max(1, Math.floor(vh / (size * 1.3)))).forEach((l, i) => {
        const p = m.pt(vx + 2, vy + size + 1 + i * size * 1.3);
        page.drawText(l, { x: p.x, y: p.y, size, font: f2, color, rotate: m.rotate });
      });
    } else {
      while (size > 5 && f2.widthOfTextAtSize(text, size) > vw - 4) size -= 0.5;
      const p = m.pt(vx + 2, vy + vh / 2 + size * 0.35);
      page.drawText(text, { x: p.x, y: p.y, size, font: f2, color, rotate: m.rotate });
    }
    return true;
  }
  const ts = typesetterFor(doc, base.font, base.bold);
  const opts = { bold: !!look.bold };
  const left = (ln: { width: number; rtl: boolean }, size: number) => (ln.rtl ? vx + vw - 2 - (ln.width * size) / 1000 : vx + 2);
  let size = want;
  if (multi) {
    while (size > 5 && ts.wrap(text, size, vw - 4, opts).length * size * 1.3 > vh) size -= 0.5;
    ts.wrap(text, size, vw - 4, opts).slice(0, Math.max(1, Math.floor(vh / (size * 1.3)))).forEach((ln, i) => {
      const p = m.pt(left(ln, size), vy + size + 1 + i * size * 1.3);
      ts.draw(page, ln, { x: p.x, y: p.y, size, color, rotate: m.rotate });
    });
  } else {
    const ln = ts.layout(text, opts);
    size = Math.max(5, Math.min(want, Math.floor((((vw - 4) * 1000) / Math.max(1, ln.width)) * 2) / 2));
    const p = m.pt(left(ln, size), vy + vh / 2 + size * 0.35);
    ts.draw(page, ln, { x: p.x, y: p.y, size, color, rotate: m.rotate });
  }
  return true;
}

// ---- Saved fields -----------------------------------------------------------------------------------------------

const VALIDATION_MAX = 2000;
const aOrAn = (w: string) => `${/^[aeiou]/i.test(w) ? 'An' : 'A'} ${/^[A-Z][a-z]/.test(w) && w !== 'Approve button' && w !== 'Decline button' ? w.toLowerCase() : w}`;

/** A saved field's spec, made tidy: only what SAVED_KEYS names, of a kind that can be saved. Refused in words. */
export function tidySpec(raw: any): any {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('Send "field": the field to save, like {"type": "text", "label": "Postcode"}. Nothing was saved.');
  if (!SAVABLE.includes(raw.type)) throw bad(`${aOrAn(KIND_LABEL[raw.type] || String(raw.type || 'field').slice(0, 40).replace(/_/g, ' '))} cannot be saved for the team${raw.type === 'note' || raw.type === 'strike' ? ': it is your own wording on one document' : raw.type === 'stamp' ? ': a stamp is chosen under Settings, Stamps and seals' : ''}. Save another kind of field. Nothing was saved.`);
  const p = lookProblem(raw.look);
  if (p) throw bad(`${p} Nothing was saved.`);
  const out: any = {};
  for (const k of SAVED_KEYS) if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') out[k] = raw[k];
  if (out.label != null && typeof out.label !== 'string') throw bad('"label" is text, the words shown with the field, like "Postcode". Nothing was saved.');
  if (out.validation != null && typeof out.validation !== 'string' && (typeof out.validation !== 'object' || Array.isArray(out.validation)))
    throw bad('"validation" is the check on what is typed, like {"kind": "pattern", "pattern": "[0-9]{4}"}. Nothing was saved.');
  if (out.validation != null && (typeof out.validation === 'string' ? out.validation : JSON.stringify(out.validation)).length > VALIDATION_MAX)
    throw bad(`The check on what is typed is too long to save. Keep it under ${VALIDATION_MAX} characters. Nothing was saved.`);
  out.label = str(out.label, 120);
  if (out.w != null) out.w = Math.min(1, Math.max(0.005, Number(out.w) || 0.1));
  if (out.h != null) out.h = Math.min(1, Math.max(0.005, Number(out.h) || 0.03));
  if (out.options != null) out.options = Array.isArray(out.options) ? out.options.slice(0, 100).map((o: any) => str(o, 200)) : [];
  if (out.validation != null && typeof out.validation !== 'string') out.validation = JSON.parse(JSON.stringify(out.validation));
  out.required = !!out.required;
  const l = lookOf(out.look);
  if (l && STYLED.includes(out.type)) out.look = l;
  else delete out.look;
  if (out.group_name != null) out.group_name = str(out.group_name, 80);
  return out;
}

export const savedFields = (accountId: string) =>
  all('SELECT id, name, spec, made_by, made_at FROM saved_fields WHERE account_id=? ORDER BY name_key', accountId).map((s: any) => ({ id: s.id, name: s.name, field: parse(s.spec) || {}, made_by: s.made_by, made_at: s.made_at }));

export function saveField(accountId: string, by: string, body: any) {
  const name = str(body?.name, 200).normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!name) throw bad('Give the saved field a name, like Postcode. Nothing was saved.');
  if (name.length > SAVED_NAME_MAX) throw bad(`A name for a saved field can be at most ${SAVED_NAME_MAX} characters. Make it shorter. Nothing was saved.`);
  const spec = tidySpec(body?.field);
  const key = savedKey(name);
  const same = get('SELECT id FROM saved_fields WHERE account_id=? AND name_key=?', accountId, key);
  if (!same && (get('SELECT COUNT(*) n FROM saved_fields WHERE account_id=?', accountId)?.n || 0) >= SAVED_MAX)
    throw bad(`Your team has ${SAVED_MAX} saved fields, which is the most it can keep. Delete one under Settings, Sending, then save this one again. Nothing was saved.`);
  // The same name again replaces that saved field: one name, one field.
  if (same) run('UPDATE saved_fields SET name=?, spec=?, made_by=?, made_at=? WHERE id=?', name, JSON.stringify(spec), by, now(), same.id);
  else run('INSERT INTO saved_fields (id, account_id, name, name_key, spec, made_by, made_at) VALUES (?,?,?,?,?,?,?)', newId('sfl'), accountId, name, key, JSON.stringify(spec), by, now());
  return savedFields(accountId).find((s) => savedKey(s.name) === key);
}

export function deleteSaved(accountId: string, sid: string) {
  if (!run('DELETE FROM saved_fields WHERE id=? AND account_id=?', sid, accountId).changes)
    throw bad('That saved field is not there any more. Someone may have deleted it already. Nothing else was changed.', 404);
}

/** Sets or clears the account's text style for new fields. Fields already placed keep theirs. */
export function setAccountLook(accountId: string, raw: any): Look | null {
  const p = lookProblem(raw);
  if (p) throw bad(`${p} Nothing was saved.`);
  const l = lookOf(raw);
  run('UPDATE accounts SET field_look=? WHERE id=?', l ? JSON.stringify(l) : null, accountId);
  return l;
}
