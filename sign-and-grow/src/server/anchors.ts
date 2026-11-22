// Fields placed by the words of a document, for POST /envelopes and PUT /envelopes/{id} (drafts and templates):
//   - a field with "anchor": {text, occurrence, offset_x, offset_y, units: "pt"} goes where that text is written,
//     once for each place it is found ("all") or at the one place named by a number;
//   - "auto_tags": true turns every {{signature}}, {{date2}}, {{text:Label}} tag into a field of the signer it names.
// The text and its position come from pdf.js, as in the editor's "Find fields", and the rules from src/lib/anchors.ts
// and src/lib/autoplace.ts. The body is changed in place into ordinary fields with a page and a box, so everything
// after this (checks, saving, sending) treats them like any other field. The answer says what was placed and what
// was not found. Nothing is guessed: text that is not found places no field.
import { get, readBlob } from './db.ts';
import { bad, str } from './util.ts';
import { scanPdf, withoutTaken, type PageScan } from '../lib/autoplace.ts';
import { readAnchor, findText, pick, boxAt, tagsOn, ANCHOR_PLACED_MAX, ANCHOR_FIELDS_MAX, type Anchor } from '../lib/anchors.ts';

export type Placed = { id?: string; type: string; document_id: string; page: number; x: number; y: number; w: number; h: number; by: 'anchor' | 'tag'; text: string; recipient_id?: string };
export type NotFound = { text: string; document_id?: string; why: string };
export type Placement = { placed: Placed[]; not_found: NotFound[] };

// The size a field gets when the request gives none, in points: about what the editor gives a new field.
const SIZE_PT: Record<string, [number, number]> = {
  signature: [150, 36], initials: [50, 30], date_signed: [90, 16], date: [90, 16], full_name: [140, 16], email: [160, 16], company: [140, 16], title: [140, 16],
  text: [140, 16], number: [80, 16], checkbox: [12, 12], radio: [12, 12], dropdown: [120, 18], attachment: [120, 24], note: [160, 40], stamp: [100, 100], strike: [150, 12],
};
// The roles a {{tag}} can belong to, counted in the order of the request: {{signature}} is the first of them,
// {{signature2}} the second. Approvers, copies and witnesses are left out, as in the editor.
const TAGGED_ROLES = ['signer', 'inperson'];
const SCAN_MS = 20_000;

async function readPages(bytes: Uint8Array): Promise<PageScan[] | null> {
  let doc: any = null;
  let late = false;
  const work = async () => {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
    doc = task;
    const d = await task.promise;
    try {
      // A scan that ran out of time stops here instead of reading the rest of the pages for nobody.
      return late ? null : await scanPdf(d);
    } finally {
      await d.destroy().catch(() => {});
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<null>((resolve) => (timer = setTimeout(() => {
      late = true;
      // Out of time: the reading is stopped, so it does not go on taking the server's time in the background.
      doc?.destroy?.().catch?.(() => {});
      resolve(null);
    }, SCAN_MS)))]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const wants = (b: any) => b?.auto_tags != null || (Array.isArray(b?.fields) && b.fields.some((f: any) => f && typeof f === 'object' && f.anchor != null));

/**
 * Turns anchored fields and tags in `b` into placed fields. Returns null when the body uses neither, so a request
 * without them is exactly what it was. `kept` gives the documents and recipients of a saved draft for a PUT that
 * leaves them out. Refusals are 400s that name the field and say that nothing was saved.
 */
export async function placeByWords(accountId: string, b: any, kept: { documents?: any[]; recipients?: any[]; fields?: any[] } = {}): Promise<Placement | null> {
  if (!wants(b)) return null;
  if (b.auto_tags != null && typeof b.auto_tags !== 'boolean') throw bad('"auto_tags" is true or false. Send one of those without quotes. Nothing was saved.');
  const documents: any[] = Array.isArray(b.documents) ? b.documents : kept.documents || [];
  const recipients: any[] = Array.isArray(b.recipients) ? b.recipients : kept.recipients || [];
  if (!documents.length) throw bad('Fields placed by "anchor" or "auto_tags" need a document to look in. Add "documents" with a file_id. Nothing was saved.');
  // A document needs an id for its fields to point at it. One the request did not name gets one here.
  documents.forEach((d, i) => {
    if (d && typeof d === 'object' && (d.id == null || d.id === '')) d.id = `doc${i + 1}`;
  });
  const pagesOf = new Map<string, PageScan[] | null>();
  const scan = async (d: any): Promise<PageScan[] | null> => {
    const key = String(d.id);
    if (pagesOf.has(key)) return pagesOf.get(key)!;
    const f = d.file_id ? get('SELECT sha256 FROM files WHERE id=? AND account_id=?', str(d.file_id), accountId) : null;
    const pages = f ? await readPages(readBlob(f.sha256)) : null;
    pagesOf.set(key, pages);
    return pages;
  };
  const docName = (d: any) => `document ${JSON.stringify(String(d.name || d.id))}`;

  const placed: Placed[] = [];
  const notFound: NotFound[] = [];
  const out: any[] = [];
  const given: any[] = Array.isArray(b.fields) ? b.fields : b.fields === undefined ? [...(kept.fields || [])] : null!;
  if (!given) throw bad('"fields" must be a list, written with square brackets, and it is not. Nothing was saved.');
  // Counted before any document is read: every anchor is looked for on every page, so their number is what costs.
  const anchored = given.filter((f) => f && typeof f === 'object' && f.anchor != null).length;
  if (anchored > ANCHOR_FIELDS_MAX) throw bad(`This request has ${anchored} fields with an "anchor", and one request can have up to ${ANCHOR_FIELDS_MAX}. Use "occurrence": "all" to place one field at every place its text is found, or send the rest in a second request with PUT /envelopes/{id}. Nothing was saved.`, 400, { code: 'too_many_anchors' });

  for (const [i, f] of given.entries()) {
    if (!f || typeof f !== 'object' || f.anchor == null) {
      out.push(f);
      continue;
    }
    // Other requests get their turn between anchors.
    if (i % 20 === 19) await new Promise((r) => setImmediate(r));
    const which = `Field ${i + 1}${f.label ? ` (${JSON.stringify(String(f.label).slice(0, 60))})` : ''}`;
    let a: Anchor;
    try {
      a = readAnchor(f.anchor);
    } catch (e: any) {
      throw bad(`${which}: ${e.message} Nothing was saved.`);
    }
    const docs = f.document_id != null && f.document_id !== '' ? documents.filter((d) => String(d?.id) === String(f.document_id)) : documents;
    if (!docs.length) throw bad(`${which} names the document "${str(f.document_id, 60)}", which is not on it. Use the "id" of one of "documents", or leave "document_id" out to look in all of them. Nothing was saved.`);
    const [pw, ph] = SIZE_PT[f.type] || [140, 16];
    const hits: { d: any; page: number; spot: any; size: { w: number; h: number } }[] = [];
    let unread = false;
    for (const d of docs) {
      const pages = await scan(d);
      if (!pages) {
        unread = true;
        continue;
      }
      pages.forEach((p, page) => findText(p, a.text).forEach((spot) => hits.push({ d, page, spot, size: p.size })));
    }
    const chosen = pick(hits, a.occurrence);
    if (!chosen.length) {
      const where = docs.length === 1 ? docName(docs[0]) : 'any of the documents';
      notFound.push({
        text: a.text, ...(docs.length === 1 ? { document_id: String(docs[0].id) } : {}),
        why: unread && !hits.length ? `The text of ${where} could not be read: it may be a scan or a picture. Place this field with a page and a position instead.`
          : hits.length ? `"${a.text}" is in ${where} ${hits.length === 1 ? 'once' : `${hits.length} times`}, so there is no place number ${a.occurrence}. Use a smaller "occurrence", or "all".`
          : `"${a.text}" is not written in ${where} on one line. Check the spelling, or use a shorter piece of the text.`,
      });
      continue;
    }
    chosen.forEach((h, n) => {
      const w = typeof f.w === 'number' && f.w > 0 ? f.w : pw / h.size.w;
      const hh = typeof f.h === 'number' && f.h > 0 ? f.h : ph / h.size.h;
      const box = boxAt(h.spot, h.size, a, w, hh);
      const { anchor: _drop, ...rest } = f;
      const fid = f.id != null && f.id !== '' ? (n ? `${f.id}_${n + 1}` : String(f.id)) : undefined;
      out.push({ ...rest, ...(fid ? { id: fid } : {}), document_id: h.d.id, page: h.page, ...box });
      placed.push({ ...(fid ? { id: fid } : {}), type: String(f.type), document_id: String(h.d.id), page: h.page, ...box, by: 'anchor', text: a.text, ...(f.recipient_id ? { recipient_id: String(f.recipient_id) } : {}) });
    });
  }

  if (b.auto_tags === true) {
    // Who {{signature}}, {{signature2}} ... belong to: the people who sign, in the order of the request.
    const ordered = recipients
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r && TAGGED_ROLES.includes(r.role || 'signer'))
      .sort((p, q) => (Number(p.r.routing_order) || 1) - (Number(q.r.routing_order) || 1) || p.i - q.i)
      .map(({ r }) => r);
    let tags = 0;
    for (const d of documents) {
      const pages = await scan(d);
      if (!pages) {
        notFound.push({ text: '{{tags}}', document_id: String(d.id), why: `The text of ${docName(d)} could not be read, so no tags were looked for in it. It may be a scan or a picture.` });
        continue;
      }
      for (const [page, p] of pages.entries()) {
        // A tag under a field that is already there (given in the request, or placed by an anchor) gets no second one.
        const here = withoutTaken(tagsOn(p).map((t) => ({ ...t, page })), out.filter((x) => x && String(x.document_id) === String(d.id) && typeof x.page === 'number'));
        for (const t of here) {
          tags++;
          const n = t.signer || 1;
          const text = `{{${t.type}${t.signer ? t.signer : ''}${t.label ? `:${t.label}` : ''}}}`;
          const r = ordered[n - 1];
          if (!r) {
            notFound.push({ text, document_id: String(d.id), why: `This tag is for signer ${n}, and the request has ${ordered.length === 1 ? 'one person who signs' : `${ordered.length} people who sign`}. Add the person, or change the tag.` });
            continue;
          }
          if (r.id == null || r.id === '') r.id = `rcp${recipients.indexOf(r) + 1}`;
          const box = { x: t.x, y: t.y, w: t.w, h: t.h };
          const field = { document_id: d.id, recipient_id: r.id, type: t.type, page, ...box, ...(t.label ? { label: t.label } : {}) };
          out.push(field);
          placed.push({ type: t.type, document_id: String(d.id), page, ...box, by: 'tag', text, recipient_id: String(r.id) });
        }
      }
    }
    if (!tags && !notFound.some((x) => x.text === '{{tags}}')) notFound.push({ text: '{{tags}}', why: 'No {{signature}} style tags were found in the documents. Nothing was placed by "auto_tags".' });
  }

  if (placed.length > ANCHOR_PLACED_MAX) throw bad(`Anchors and tags would place ${placed.length} fields, and one request can place up to ${ANCHOR_PLACED_MAX}. Use a number for "occurrence" or a longer anchor text. Nothing was saved.`);
  b.fields = out;
  delete b.auto_tags;
  return { placed, not_found: notFound };
}

/**
 * POST /envelopes with "template_id" makes a copy of the template's own fields, so anchors and tags in the same
 * request would place nothing. Refused in words instead of being dropped without a word.
 */
export function refuseWordsWithTemplate(b: any): null {
  if (wants(b)) throw bad('"anchor" and "auto_tags" cannot be used together with "template_id": a copy of a template takes the template\'s own fields. Make the copy first (without "send"), then place fields on it with PUT /envelopes/{id}, then send it with POST /envelopes/{id}/send. Nothing was saved.', 400, { code: 'anchors_with_template' });
  return null;
}

/** For "send": true: an envelope never goes out with a field that was asked for and not placed. */
export function assertAllPlaced(p: Placement | null) {
  if (!p || !p.not_found.length) return;
  const first = p.not_found[0];
  throw bad(`Nothing was sent: ${p.not_found.length === 1 ? 'one anchor or tag was' : `${p.not_found.length} anchors or tags were`} not found. ${first.text}: ${first.why}`, 400, { code: 'anchor_not_found', not_found: p.not_found });
}
