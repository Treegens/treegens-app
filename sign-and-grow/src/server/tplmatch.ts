// "This looks like your template Volunteer agreement. Use it?" under a file just uploaded in the
// editor. The words of the upload (read when it was uploaded, files.text, one line a page) are compared with the
// words of the documents of the templates this person may use: runs of 5 words ("shingles"), and how many of them
// the two have in common out of the runs of the longer one (alike). Not out of all they have between them (Jaccard):
// one word changed on a short form breaks up to 5 runs in each, which Jaccard counts twice, so a one-page waiver with
// a name filled in fell under 90 percent. Dividing by the longer one keeps a short template inside a long file from
// looking alike. At or above the account's level (80, 90 or 95 percent; 80 unless an admin chose another through the
// API) the editor offers the template, and says what differs.
// Nothing is ever applied without the sender's yes: "Use it" asks for the template's people and fields
// (fieldsFor), and the editor puts them on the file. A file with no words (a scan nobody read) is never matched.
import type { Ctx } from './router.ts';
import { all, get } from './db.ts';
import { bad, id, str } from './util.ts';
import { keptText } from './searchtext.ts';
import { usableSql, mayUse, mayChange, ruleOf, askWho, fileHeldBack } from './tplroles.ts';
import { matchPercentOf, type TemplateMatch } from '../lib/tplcombine.ts';

const SHINGLE = 5;
/** Templates looked at for one upload, the most recently changed first. */
const MAX_TEMPLATES = 300;
/** Fewer words than this is too little to say two documents are alike. */
const MIN_WORDS = 20;
const MAX_LISTED = 8;
/** Words of one file looked at, so a very long file costs no more than a long one. */
const MAX_WORDS = 20_000;

/** The words of a text, in order: letters and digits of any script, in lower case. */
export const wordsOf = (text: string): string[] => (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || []);

export function shingles(words: string[]): Set<string> {
  const out = new Set<string>();
  if (!words.length) return out;
  if (words.length < SHINGLE) return out.add(words.join(' '));
  for (let i = 0; i + SHINGLE <= words.length; i++) out.add(words.slice(i, i + SHINGLE).join(' '));
  return out;
}

/** How alike two sets of shingles are: the runs they share, out of the runs of the bigger one. 1 for the same words. */
export function alike(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let both = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const s of small) if (big.has(s)) both++;
  return both / big.size;
}

/** The kept words of a file, page by page (files.text holds one line a page). */
type Read = { pages: string[][]; all: Set<string>; words: number };
const cache = new Map<string, Read>();
function readFile(fileId: string): Read {
  const row = get('SELECT id, text, text_sealed FROM files WHERE id=?', fileId);
  const text = keptText(row);
  const key = `${fileId}:${text.length}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let left = MAX_WORDS;
  const pages = lines.map((l) => {
    const w = wordsOf(l).slice(0, Math.max(0, left));
    left -= w.length;
    return w;
  });
  const flat = pages.flat();
  const r = { pages, all: shingles(flat), words: flat.length };
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  cache.set(key, r);
  return r;
}

/** The account's level, in percent. */
export const matchPercent = (accountId: string) => matchPercentOf(get('SELECT tpl_match_percent p FROM accounts WHERE id=?', accountId)?.p);

/** A file of this account that this person may read. */
function fileOf(c: Ctx, fileId: string) {
  const f = get('SELECT id, pages FROM files WHERE id=? AND account_id=?', str(fileId, 80), c.account.id);
  if (!f || fileHeldBack(c, f.id)) throw bad('File not found.', 404);
  return f;
}

/** The best template for an upload, at or above the account's level, or null. Only templates this person may use. */
export function bestMatch(c: Ctx, fileId: string): TemplateMatch | null {
  const f = fileOf(c, fileId);
  const up = readFile(f.id);
  if (up.words < MIN_WORDS) return null;
  const [usable, p] = usableSql(c);
  const tpls = all(`SELECT e.* FROM envelopes e WHERE e.account_id=? AND e.kind='template' AND e.hidden_at IS NULL${usable ? ` AND ${usable}` : ''} ORDER BY e.updated_at DESC LIMIT ${MAX_TEMPLATES}`, c.account.id, ...p);
  let best: { t: any; doc: any; score: number } | null = null;
  for (const t of tpls) {
    for (const doc of all('SELECT d.id, d.file_id, f.pages FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=? ORDER BY d.position', t.id)) {
      const other = readFile(doc.file_id);
      if (other.words < MIN_WORDS) continue;
      const score = alike(up.all, other.all);
      if (!best || score > best.score) best = { t, doc, score };
    }
  }
  if (!best) return null;
  const percent = Math.floor(best.score * 100 + 1e-9);
  if (percent < matchPercent(c.account.id)) return null;
  return {
    template_id: best.t.id,
    template: str(best.t.subject || 'Untitled template', 200),
    percent,
    locked: ruleOf(best.t).locked && !mayChange(c, best.t),
    differences: differences(f.pages, up, best.doc.pages, readFile(best.doc.file_id)),
  };
}

function differences(upPages: number, up: Read, tplPages: number, tpl: Read): TemplateMatch['differences'] {
  const changed: number[] = [];
  const n = Math.max(up.pages.length, tpl.pages.length);
  for (let i = 0; i < n; i++) {
    const a = up.pages[i] || [], b = tpl.pages[i] || [];
    if (a.join(' ') !== b.join(' ')) changed.push(i + 1);
  }
  const inUp = new Set(up.pages.flat()), inTpl = new Set(tpl.pages.flat());
  const only = (from: string[][], other: Set<string>) => [...new Set(from.flat().filter((w) => !other.has(w)))].slice(0, MAX_LISTED);
  return { pages: { upload: upPages, template: tplPages }, changed_pages: changed, only_in_upload: only(up.pages, inTpl), only_in_template: only(tpl.pages, inUp) };
}

/**
 * "Use it": the template's people and its fields, placed on the upload's pages, for the editor to add to the draft.
 * New ids, so nothing on the draft is replaced. Fields on pages the upload does not have are left out and counted.
 * Refused for a template whose wording is locked for this person: its fields belong to its own documents.
 */
export function fieldsFor(c: Ctx, fileId: string, templateId: string, documentId: string) {
  const f = fileOf(c, fileId);
  const t = get("SELECT * FROM envelopes WHERE id=? AND account_id=? AND kind='template' AND hidden_at IS NULL", str(templateId, 80), c.account.id);
  if (!t || !mayUse(c, t)) throw bad('That template is not one you can use. Choose another, or place the fields yourself.', 404);
  if (ruleOf(t).locked && !mayChange(c, t))
    throw bad(`The wording of the template "${str(t.subject || 'Untitled template', 120)}" is locked, so its fields cannot go on another file. Start a new document from the template itself instead, or ask ${askWho(t)}.`, 403, { code: 'wording_locked', template_id: t.id });
  // The template's document most like this file.
  const up = readFile(f.id);
  const docs = all('SELECT d.id, d.file_id FROM documents d WHERE d.envelope_id=? ORDER BY d.position', t.id);
  if (!docs.length) throw bad('That template has no file, so it has no fields to use. Choose another, or place the fields yourself.');
  const doc = docs.map((d) => ({ d, s: alike(up.all, readFile(d.file_id).all) })).sort((a, b) => b.s - a.s)[0].d;
  const rmap = new Map<string, string>();
  const people = all('SELECT * FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', t.id).map((r) => {
    rmap.set(r.id, id('rcp'));
    return { id: rmap.get(r.id), role: r.role, role_name: r.role_name || '', name: r.name || '', email: r.email || '', routing_order: r.routing_order, note: r.note || '', access_code: r.access_code || '' };
  });
  const all_ = all('SELECT * FROM fields WHERE envelope_id=? AND document_id=? ORDER BY rowid', t.id, doc.id);
  const fits = all_.filter((x) => x.page < f.pages);
  const NO_VALUE = ['signature', 'initials', 'attachment', 'date_signed', 'full_name', 'email', 'stamp'];
  const fields = fits.map((x) => ({
    id: id('fld'), document_id: str(documentId, 80), recipient_id: x.recipient_id ? rmap.get(x.recipient_id) ?? null : null, type: x.type, page: x.page, x: x.x, y: x.y, w: x.w, h: x.h,
    required: !!x.required, label: x.label || '', value: NO_VALUE.includes(x.type) ? null : x.value ?? null, options: safeList(x.options), group_name: x.group_name || null, validation: x.validation || null, readonly: !!x.readonly,
  }));
  // People who have no field on this file are still part of the template: they come too, as the template has them.
  return { template: str(t.subject || 'Untitled template', 200), people, fields, left_out: all_.length - fits.length };
}

const safeList = (v: any) => {
  try {
    const l = JSON.parse(v || '[]');
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
};
