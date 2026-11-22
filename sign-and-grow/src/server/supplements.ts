// Files given to read with a document, not signed: a privacy notice, terms, a leaflet (research/docusign-gaps.json,
// batch "supplements"). A document's file is either to sign (documents.supplemental NULL) or to read, with a rule
// before Finish: none, must open it, or must tick "I have been given <name>". No field can be placed on a file to
// read. The signing page lists them above the document ("Also for you"), opening and ticking go in the audit trail,
// the completed copy puts them after the signed pages behind a divider unless the sender left them out, and the
// certificate lists each with its SHA-256 and who opened and acknowledged it, when.
//
// Honest words: "opened" means this person's link fetched the file to show or save it. Never "read" or "understood".
// The words shared with the screens are in src/lib/supplements.ts.
import { all, get, run } from './db.ts';
import { bad, now, str } from './util.ts';
import { refuse } from './signlang.ts';
import { isSupplementRule, meetsRules, nameList, SUPPLEMENT_RULES, DIVIDER_TITLE, DIVIDER_LINE, type SupplementRule, type Supplemental } from '../lib/supplements.ts';

/** documents.supplemental and supplemental_copy as the API carries them: null, or { rule, in_copy }. */
export const supplementalOf = (rule: unknown, copy: unknown): Supplemental => (isSupplementRule(rule) ? { rule, in_copy: copy == null ? true : !!Number(copy) } : null);

/** A file that is to read, not to sign. */
export const isSupplement = (d: any): boolean => !!d?.supplemental;
/** The files of an envelope that are signed, in their order. */
export const toSign = (docs: any[]): any[] => (docs || []).filter((d) => !isSupplement(d));

/**
 * What a request says about one document: undefined when it says nothing (the file keeps what it had), null for a
 * file to sign, or the rule. Accepts "open" as short for { rule: "open" }. A mistake is said, never guessed at.
 */
export function readSupplemental(v: unknown, doc: string): { rule: SupplementRule; copy: boolean } | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === false) return null;
  const o: any = typeof v === 'string' ? { rule: v } : v === true ? { rule: 'none' } : v;
  if (!o || typeof o !== 'object' || Array.isArray(o))
    throw bad(`${doc}: "supplemental" must be null (a file to sign) or an object such as {"rule": "open"}. Send one of those. Nothing was saved.`);
  const rule = o.rule ?? 'none';
  if (!isSupplementRule(rule)) throw bad(`${doc}: the rule "${str(rule, 40)}" does not exist. Use one of: ${SUPPLEMENT_RULES.join(', ')}. Nothing was saved.`);
  if (o.in_copy != null && typeof o.in_copy !== 'boolean') throw bad(`${doc}: "in_copy" can only be true or false. Send one of the two. Nothing was saved.`);
  return { rule, copy: o.in_copy !== false };
}

/**
 * Saves the rule of one document, right after saveEnvelope has put the row back (documents are written afresh on
 * every save). `old` is the document as it was under the same id. On an envelope that is out, a file cannot change
 * between to sign and to read: that changes what was signed, so it is refused and the sender is told what to do.
 */
export function saveSupplement(documentId: string, d: any, i: number, old: any, correcting: boolean) {
  const doc = `Document ${i + 1}${d?.name ? ` ("${str(d.name, 60)}")` : ''}`;
  const said = readSupplemental(d?.supplemental, doc);
  const next = said === undefined ? (old?.supplemental ? { rule: old.supplemental.rule, copy: old.supplemental.in_copy } : null) : said;
  if (correcting && old && !!old.supplemental !== !!next)
    throw bad(`${doc} was sent ${old.supplemental ? 'to read' : 'to sign'}, and that cannot change on a document that is out. Remove it and add the file again as a new one instead. Nothing was saved.`);
  if (next) run('UPDATE documents SET supplemental=?, supplemental_copy=? WHERE id=?', next.rule, next.copy ? 1 : 0, documentId);
  // A rule changed while the document is out is kept with when, so the certificate never lists someone who finished
  // earlier as if they had skipped a rule that did not exist yet (supplementCert below).
  if (correcting && old?.supplemental && next && old.supplemental.rule !== next.rule)
    run('INSERT INTO supplement_rules (envelope_id, document_id, from_rule, rule, at) VALUES ((SELECT envelope_id FROM documents WHERE id=?),?,?,?,?)', documentId, documentId, old.supplemental.rule, next.rule, now());
}

/** A rule in words, for the certificate and the audit trail. */
export const ruleWords = (rule: string) => (rule === 'open' ? 'Had to be opened before finishing' : rule === 'acknowledge' ? "Had to be acknowledged ('I have been given') before finishing" : 'None');

/** What a correction did to the rule of a file to read, in words for the audit trail (describeCorrection). */
export function ruleChangeWords(o: any, d: any): string | null {
  if (!o?.supplemental || !d?.supplemental || o.supplemental.rule === d.supplemental.rule) return null;
  return `The rule for "${str(d.name, 80)}" changed from "${ruleWords(o.supplemental.rule)}" to "${ruleWords(d.supplemental.rule)}". It applies to whoever has not finished yet.`;
}

/** A field on a file to read is refused by name (saveEnvelope's field loop). */
export function noFieldsOn(envelopeId: string, documentId: string, which: string) {
  const d = get('SELECT name, supplemental FROM documents WHERE id=? AND envelope_id=?', documentId, envelopeId);
  if (d?.supplemental) throw bad(`${which} is on "${str(d.name, 80)}", which is to read, not sign, so it cannot have fields. Move the field to a file people sign, or mark the file to sign. Nothing was saved.`);
}

/** The rule goes with every copy: templates, bulk sends, public forms and clones (copyEnvelope). */
export function copySupplement(src: any, documentId: string) {
  if (src?.supplemental) run('UPDATE documents SET supplemental=?, supplemental_copy=? WHERE id=?', src.supplemental.rule, src.supplemental.in_copy ? 1 : 0, documentId);
}

/** Sending needs at least one file to sign: a document of files to read only has nothing to finish. */
export function assertSomethingToSign(e: any) {
  if (e.documents?.length && !toSign(e.documents).length)
    throw bad('Every file is marked "To read, not sign", so there is nothing to sign. Mark at least one file to sign, or add one.');
}

// ---- What each person did ---------------------------------------------------------------------

/** This person's marks that count: for the file as it is now, made after their own agreement. */
function marksOf(e: any, r: any): any[] {
  if (!r?.consent_at) return [];
  return all('SELECT document_id, file_id, kind, MIN(at) at FROM supplement_marks WHERE envelope_id=? AND recipient_id=? AND at>=? GROUP BY document_id, file_id, kind', e.id, r.id, r.consent_at)
    .filter((m) => e.documents.some((d: any) => d.id === m.document_id && d.file_id === m.file_id));
}
const markOf = (marks: any[], d: any, kind: string) => marks.find((m) => m.document_id === d.id && m.kind === kind)?.at || null;

/** The files to read for the signing page, with what this person did. Empty when the envelope has none. */
export function supplementsFor(e: any, r: any) {
  const marks = marksOf(e, r);
  return e.documents.filter(isSupplement).map((d: any) => ({
    id: d.id, name: d.name, pages: d.pages, sha256: d.sha256, rule: meetsRules(r.role) ? d.supplemental.rule : 'none',
    opened: !!markOf(marks, d, 'opened'), acknowledged: !!markOf(marks, d, 'acknowledged'),
  }));
}

/** What is missing before this person may finish: each file whose rule is not met. */
export function missingFor(e: any, r: any): { id: string; name: string; rule: SupplementRule }[] {
  if (!meetsRules(r.role)) return [];
  const marks = marksOf(e, r);
  return e.documents.filter((d: any) => {
    const rule = d.supplemental?.rule;
    return (rule === 'open' && !markOf(marks, d, 'opened')) || (rule === 'acknowledge' && !markOf(marks, d, 'acknowledged'));
  }).map((d: any) => ({ id: d.id, name: d.name, rule: d.supplemental.rule }));
}

/** Finish checks the rules (completeRecipient). The refusal names the files and says what to do. */
export function assertSupplements(e: any, r: any) {
  const missing = missingFor(e, r);
  if (missing.length) throw refuse('supplements_missing', 400, { names: nameList(missing.map((m) => m.name)), missing: missing as any });
}

/**
 * Keeps a mark. Returns true when it is new for this person and this file, so the caller writes the one audit line;
 * opening the same file again is not written again.
 */
export function mark(e: any, r: any, d: any, kind: 'opened' | 'acknowledged'): boolean {
  if (marksOf(e, r).some((m) => m.document_id === d.id && m.kind === kind)) return false;
  run('INSERT INTO supplement_marks (envelope_id, document_id, file_id, recipient_id, kind, at) VALUES (?,?,?,?,?,?)', e.id, d.id, d.file_id, r.id, kind, now());
  return true;
}

/**
 * Fetching a file to read through this person's link, to show or save it: the first time, while they still have to
 * finish and after their agreement, it counts as opened. Returns true when the caller writes the one audit line.
 * Used by GET /sign/:token/supplements/:doc and GET /sign/:token/doc/:doc alike, so both say the same.
 */
export function openedNow(e: any, r: any, d: any): boolean {
  const toFinish = e.status === 'sent' && (r.status === 'sent' || r.status === 'viewed');
  return isSupplement(d) && toFinish && !!r.consent_at && mark(e, r, d, 'opened');
}
export const OPENED_DETAIL = 'The file was opened or downloaded by this link. That does not say it was read.';

// ---- The completed copy and the certificate ----------------------------------------------------

/**
 * The files to read after the signed pages, behind one divider page, unless the sender left them out. The PDF code
 * hands in what it draws with (pdf.ts), so this file does not need it.
 */
export async function addSupplements(e: any, o: { flat: (sha256: string) => Promise<any[]>; add: (page: any) => void; sheet: () => { text: (s: string, o?: any) => void }; foot: (page: any) => void }) {
  const given = e.documents.filter((d: any) => isSupplement(d) && d.supplemental.in_copy);
  if (!given.length) return;
  const s = o.sheet();
  s.text(DIVIDER_TITLE, { size: 18, bold: true, gap: 10 });
  s.text(DIVIDER_LINE, { size: 11, gap: 8 });
  for (const d of given) s.text(`${d.name} (${d.pages} page${d.pages === 1 ? '' : 's'})`, { size: 11, gap: 2 });
  for (const d of given) for (const p of await o.flat(d.sha256)) (o.add(p), o.foot(p));
}

/** The certificate's part about the files to read: each with its SHA-256, then who opened and acknowledged it, when. */
export function supplementCert(e: any, s: { h2: (t: string) => void; text: (t: string, o?: any) => void; kv: (k: string, v: string) => void }, iso: (x: any) => string, ts: (at: string | null) => string) {
  const given = e.documents.filter(isSupplement);
  if (!given.length) return;
  s.h2('Given to read, not signed');
  s.text('Opened means the person\'s link opened or downloaded the file. It does not mean the file was read or understood.', { size: 7.5, gap: 4 });
  const people = e.recipients.filter((r: any) => meetsRules(r.role) && r.status !== 'skipped');
  const marks = new Map<string, any[]>(people.map((r: any) => [r.id, marksOf(e, r)]));
  for (const d of given) {
    const rule = d.supplemental.rule as SupplementRule;
    s.text(`${iso(d.name)} (${d.pages} page${d.pages === 1 ? '' : 's'})`, { size: 9, bold: true });
    s.text(`SHA-256 of the file: ${d.sha256}`, { size: 7, gap: 1 });
    s.kv('Rule', ruleWords(rule));
    // Rules changed by a correction while the document was out, oldest first.
    const changes = all('SELECT from_rule, rule, at FROM supplement_rules WHERE envelope_id=? AND document_id=? ORDER BY at, rowid', e.id, d.id);
    for (const c of changes) s.kv('Rule changed', `${ts(c.at)}, from "${ruleWords(c.from_rule)}" to "${ruleWords(c.rule)}"`);
    s.kv('In the signed copy', d.supplemental.in_copy ? 'Yes, after the signed pages' : 'No, the sender left it out');
    for (const r of people) {
      const m = marks.get(r.id) || [];
      const opened = markOf(m, d, 'opened');
      const acked = markOf(m, d, 'acknowledged');
      // Finished before the rule as it is now was set: said, with the rule they had to meet.
      const later = r.completed_at ? changes.find((c: any) => c.at > r.completed_at) : null;
      const before = later && later.from_rule !== rule ? `. Finished ${ts(r.completed_at)}, before the rule was changed; the rule then: "${ruleWords(later.from_rule)}"` : '';
      s.kv(iso(r.name), [opened ? `Opened ${ts(opened)}` : 'Not opened', acked ? `acknowledged receiving it ${ts(acked)}` : ''].filter(Boolean).join(', ') + before);
    }
  }
}
