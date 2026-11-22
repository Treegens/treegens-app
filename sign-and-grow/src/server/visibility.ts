// "Each person sees only their files" (research/docusign-gaps.json, batch "visibility"). An envelope with a contract
// for the employee and a salary sheet for HR shows each person only what is theirs: on their signing link, in every
// answer it gives, and in their completed copy. The rule for who sees which file is in src/lib/owndocs.ts.
//
// What this file does, and where it is called from:
//   - limitForLink (routes-sign.ts look): the envelope a signing link works with holds only that person's files, so
//     every /sign/:token answer (the view, a file by URL, the text a machine read, the summary, the files to read)
//     knows nothing else. A file that is not theirs answers 404 like one that does not exist.
//     Its fields stay on the envelope, because Finish works out formulas and "Only show when" over every field;
//     what the screen is given is filtered (onShownDoc, in signView), and so are comments pinned to such a file.
//   - asSeenBy (buildPdf): a PDF made for one person holds only their files, and the certificate lists each other
//     file as OTHER_DOC_LINE with its SHA-256 and no name. Their audit trail names such a file "a document you were
//     not shown".
//   - buildOwnCopies (buildFinal): when everyone has finished, each person whose view is limited gets their own
//     completed copy, made through the same finishing steps (finalpipe.ts: archive format, seal), stored, and its
//     SHA-256 kept in final_copies so /verify finds it. The sender's copy and the evidence pack hold everything.
//   - saveOwnDocs and copyOwnDocs (writeContent, copyEnvelope): the option and the ticks, on drafts, corrections,
//     templates and every copy made from them (sign again, bulk, forms).
import { get, all, run, saveBlob, readBlob } from './db.ts';
import { bad, now } from './util.ts';
import { shownDocIds, cleanTicks, OTHER_DOC_WORDS, subjectFor, changeFor, namesFile, type OwnDocsPerson } from '../lib/owndocs.ts';
import { formulaInputs } from './logic.ts';

const parse = (s: any): string[] | null => {
  if (s == null || s === '') return null;
  try {
    return cleanTicks(JSON.parse(s));
  } catch {
    return null;
  }
};

/** The ticks of one recipient row, as the API and the editor see them ("also_sees"). */
export const ticksOf = (r: any): string[] | null => parse(r?.own_docs_extra);

/** loadEnvelope: each recipient carries its ticks as "also_sees" for the sender's screens. */
export function attachTicks(e: any) {
  for (const r of e.recipients || []) r.also_sees = ticksOf(r);
}

const person = (r: any): OwnDocsPerson => ({ id: r.id, role: r.role, witness_for: r.witness_for || null, also_sees: Array.isArray(r.also_sees) ? r.also_sees : ticksOf(r) });

/** The ids of the files this recipient is shown, or null for every file. */
export function shownFor(e: any, rid: string): Set<string> | null {
  if (!e?.own_docs || (e.documents || []).length < 2) return null;
  // Another person's field that one of this person's formulas counts is on their screen, so its file is too.
  let more: string[] = [];
  try {
    const ins = formulaInputs(e, rid).fields.map((f: any) => f.id);
    more = e.fields.filter((f: any) => ins.includes(f.id)).map((f: any) => f.document_id);
  } catch {
    /* a formula that cannot be read changes nothing here */
  }
  return shownDocIds(true, e.documents, e.recipients.map(person), e.fields, rid, more);
}

/**
 * For a signing link: the envelope holds only this person's files. Called once, right after the envelope is loaded,
 * before anything is given out. `hidden_docs` keeps what was taken out (for the certificate line), and the
 * recipient row is marked with the hidden ids, so the comments know which threads to leave out.
 */
export function limitForLink(e: any, rid: string) {
  if (!e || e.hidden_docs) return e;
  const shown = shownFor(e, rid);
  e.hidden_docs = shown ? e.documents.filter((d: any) => !shown.has(d.id)) : [];
  e.limited_for = rid;
  if (shown) {
    // Their subject and "what changed" never name another person's file (subjectFor, changeFor). subject_full
    // keeps the sender's subject for what goes to the sender from this link (notifySender in envelopes.ts).
    e.subject_full = e.subject;
    e.last_change_full = e.last_change;
    e.subject = subjectFor(e.subject, e.documents, shown);
    e.last_change = changeFor(e.last_change, namesOf(e.hidden_docs, e.documents.filter((d: any) => shown.has(d.id)))) || null;
    e.documents = e.documents.filter((d: any) => shown.has(d.id));
  }
  const r = e.recipients.find((x: any) => x.id === rid);
  if (r) r.hidden_docs = new Set(e.hidden_docs.map((d: any) => d.id));
  return e;
}

/** A field, note or thread that sits on a file this envelope (as loaded for a link) still holds. */
export const onShownDoc = (e: any, documentId: string | null | undefined): boolean =>
  !documentId || !e?.hidden_docs?.length || !e.hidden_docs.some((d: any) => d.id === documentId);

/** The envelope as one person is shown it, for a PDF made for them. The same object when they see everything. */
export function asSeenBy(e: any, rid: string): any {
  if (e.hidden_docs && e.limited_for === rid) {
    if (!e.hidden_docs.length) return e;
    return { ...e, fields: e.fields.filter((f: any) => onShownDoc(e, f.document_id)), hidden_documents: e.hidden_docs.map(hiddenRow) };
  }
  const shown = shownFor(e, rid);
  if (!shown) return e;
  return {
    ...e,
    ...wordsFor(e, shown),
    documents: e.documents.filter((d: any) => shown.has(d.id)),
    fields: e.fields.filter((f: any) => !f.document_id || shown.has(f.document_id)),
    hidden_documents: e.documents.filter((d: any) => !shown.has(d.id)).map(hiddenRow),
    limited_for: rid,
  };
}
const hiddenRow = (d: any) => ({ id: d.id, name: d.name, sha256: d.sha256 });

// The names of the files in `hidden` that no shown file also goes by.
const namesOf = (hidden: any[], shown: any[]): string[] => {
  const mine = new Set(shown.map((d: any) => String(d.name || '')));
  return hidden.map((d: any) => String(d.name || '')).filter((n) => n.trim() && !mine.has(n));
};
const wordsFor = (e: any, shown: Set<string>) => ({
  subject: subjectFor(e.subject, e.documents, shown),
  last_change: changeFor(e.last_change, namesOf(e.documents.filter((d: any) => !shown.has(d.id)), e.documents.filter((d: any) => shown.has(d.id)))) || null,
});

/**
 * The envelope as one person is written to about it: the same, with their own subject and their own "what changed"
 * (wordsFor). For every email to a recipient (notifyRecipient, the completed email, void and decline notices).
 */
export function forPerson(e: any, rid: string | null | undefined): any {
  if (!e || !rid || e.limited_for === rid) return e;
  // An envelope loaded for someone else's link: back to every file and the sender's own words first.
  const full = e.limited_for
    ? { ...e, subject: e.subject_full ?? e.subject, last_change: e.last_change_full ?? e.last_change, documents: [...e.documents, ...(e.hidden_docs || [])].sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0)), hidden_docs: undefined, limited_for: undefined }
    : e;
  const shown = shownFor(full, rid);
  return shown ? { ...full, ...wordsFor(full, shown) } : full;
}

// Names of files this person was not shown, longest first, so "Pay 2027 extra" is replaced before "Pay 2027".
const hiddenNames = (e: any): string[] => {
  const shown = new Set((e.documents || []).map((d: any) => d.name));
  return [...new Set<string>((e.hidden_documents || e.hidden_docs || []).map((d: any) => String(d.name || '')).filter((n: string) => n.trim().length > 0 && !shown.has(n)))].sort((a, b) => b.length - a.length);
};

const wholeWord = (n: string) => new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');

/**
 * Words of ours (an audit line, the last change) with the names of files this person was not shown taken out. Our
 * lines put a file's name in quotes (Document "Pay sheet" added), so only quoted words are looked at: a quote that
 * is such a name becomes OTHER_DOC_WORDS, and a quote that holds one as a whole word ("Please sign: Pay sheet")
 * has it replaced there. Words outside quotes are never touched, so a file called "Signed" leaves "Signed" alone.
 */
export function scrubNames(e: any, text: string | null | undefined): string {
  const s = String(text ?? '');
  const names = hiddenNames(e);
  if (!names.length || !s.includes('"')) return s;
  return s.replace(/"([^"\n]{1,500})"/g, (all, inner: string) => {
    if (names.includes(inner)) return OTHER_DOC_WORDS;
    let out = inner;
    for (const n of names) if (namesFile(out, n)) out = out.replace(wholeWord(n), OTHER_DOC_WORDS);
    return out === inner ? all : `"${out}"`;
  });
}

/** The audit trail printed in a copy made for one person: the same lines, without the names of files they were not shown. */
export function seenTrail(e: any, trail: any[]): any[] {
  if (!hiddenNames(e).length) return trail;
  // "Envelope sent · 2 recipients, 5 pages" would tell them the envelope holds more pages than they were shown.
  const sent = (a: any, d: string) => (a.action === 'Envelope sent' ? d.replace(/, \d+ pages?$/, '') : d);
  return trail.map((a) => ({ ...a, action: scrubNames(e, a.action), detail: sent(a, scrubNames(e, a.detail)) }));
}

// ---- Saving the option and the ticks ---------------------------------------------------------------------------

/**
 * writeContent, after every recipient and document is in. `body.own_docs` (yes or no) and each recipient's
 * `also_sees` (a list of document ids). Left out, each stays as it was. Someone who has finished keeps exactly the
 * files they were shown: a change that would add or take one away from them is refused, and nothing is saved.
 */
export function saveOwnDocs(e: any, body: any, asked: { rid: string; r: any }[], docId: (id: any) => string, docIds: Set<string>, oldRecs: Map<string, any>, correcting: boolean, load: (id: string) => any) {
  // Asked to sign again anyway ("resign"): what they are shown is part of what they sign then.
  const resign = body.resign === true;
  if (body.own_docs !== undefined) {
    if (body.own_docs !== true && body.own_docs !== false && body.own_docs !== 1 && body.own_docs !== 0 && body.own_docs !== null)
      throw bad('"own_docs" is true (each person sees only the files with their fields, and those ticked for them) or false (everyone sees every file). Nothing was saved.');
    run('UPDATE envelopes SET own_docs=? WHERE id=?', body.own_docs ? 1 : 0, e.id);
  }
  for (const { rid, r } of asked) {
    if (r?.also_sees === undefined) continue;
    if (r.also_sees !== null && !Array.isArray(r.also_sees)) throw bad(`"also_sees" of ${r.name || 'a recipient'} is a list of document ids, or null. Nothing was saved.`);
    const ids = r.also_sees === null ? null : [...new Set((r.also_sees as any[]).map((d) => docId(d)).filter((d) => docIds.has(d)))];
    run('UPDATE recipients SET own_docs_extra=? WHERE id=?', ids && ids.length ? JSON.stringify(ids) : null, rid);
  }
  if (!correcting || resign) return;
  // What each person who has finished was shown, before and after this save, by file.
  const before = { ...e, documents: e.documents, recipients: e.recipients };
  const after = load(e.id);
  for (const o of oldRecs.values()) {
    if (o.status !== 'completed' || o.role === 'cc') continue;
    const was = shownFor(before, o.id);
    const is = after.recipients.some((x: any) => x.id === o.id) ? shownFor(after, o.id) : was;
    const key = (s: Set<string> | null, docs: any[]) => (s ? [...s] : docs.map((d: any) => d.id)).filter((d) => after.documents.some((x: any) => x.id === d)).sort().join(',');
    if (key(was, e.documents) !== key(is, after.documents))
      throw bad(`${o.name} has already finished and was shown ${was ? 'only some of the files' : 'every file'}. Which files they see can no longer change. Nothing was saved. Put the ticks back, or ask them to sign again first.`, 409, { code: 'own_docs_locked', name: o.name });
  }
}

/** copyEnvelope: the option and each person's ticks go with the copy, pointing at the copy's own files. */
export function copyOwnDocs(src: any, eid: string, rmap: Map<string, string>, dmap: Map<string, string>) {
  if (src.own_docs) run('UPDATE envelopes SET own_docs=1 WHERE id=?', eid);
  for (const r of src.recipients || []) {
    const t = ticksOf(r);
    if (!t?.length || !rmap.get(r.id)) continue;
    const ids = t.map((d) => dmap.get(d)).filter(Boolean);
    if (ids.length) run('UPDATE recipients SET own_docs_extra=? WHERE id=?', JSON.stringify(ids), rmap.get(r.id));
  }
}

/** Who on this envelope is shown only some of its files, with which: for the sender's screens and the evidence pack. */
export function limitedPeople(e: any): { id: string; name: string; sees: string[] }[] {
  if (!e?.own_docs) return [];
  return e.recipients.map((r: any) => ({ r, s: shownFor(e, r.id) })).filter((x: any) => x.s)
    .map(({ r, s }: any) => ({ id: r.id, name: r.name || r.role_name || 'Someone', sees: e.documents.filter((d: any) => s.has(d.id)).map((d: any) => d.name) }));
}

// ---- Completed copies -----------------------------------------------------------------------------------------

type Render = (e: any) => Promise<Uint8Array>;
type Finish = (e: any, render: Render) => Promise<Uint8Array>;

/**
 * After the sender's copy is stored: one completed copy for each person whose view is limited, if it is not made
 * yet. True when every copy that should exist does. A copy that fails is tried again the next time (the download
 * of that person, or buildFinal from the timer); nobody is ever given the full copy in its place.
 */
export async function buildOwnCopies(e: any, finish: Finish, render: Render): Promise<boolean> {
  if (!e?.own_docs || e.status !== 'completed') return true;
  let ok = true;
  for (const r of e.recipients) {
    const seen = asSeenBy(e, r.id);
    if (seen === e) continue;
    if (get('SELECT 1 x FROM final_copies WHERE envelope_id=? AND recipient_id=?', e.id, r.id)) continue;
    try {
      const pdf = await finish(seen, render);
      run('INSERT OR IGNORE INTO final_copies (envelope_id, recipient_id, sha256, size, docs, made_at) VALUES (?,?,?,?,?,?)', e.id, r.id, saveBlob(pdf), pdf.length, JSON.stringify(seen.documents.map((d: any) => d.id)), now());
    } catch (err: any) {
      ok = false;
      console.error('[visibility] could not make the own copy of', r.id, 'on', e.id, err?.message);
    }
  }
  return ok;
}

/** The stored completed copy of one person whose view is limited. Null when they see everything or it is not made yet. */
export const ownCopyRow = (e: any, rid: string): { sha256: string; size: number } | null =>
  get('SELECT sha256, size FROM final_copies WHERE envelope_id=? AND recipient_id=?', e.id, rid) || null;

/**
 * The completed copy for this person: their own when their view is limited (made now if it is missing), else the
 * sender's. `limited` tells the caller that a missing copy must never be replaced by the full one.
 */
export async function copyFor(e: any, rid: string, finish: Finish, render: Render, full: () => Buffer | null, load: (id: string) => any): Promise<{ pdf: Buffer | null; sha256: string | null; limited: boolean }> {
  const limited = !!e.own_docs && (e.hidden_docs ? e.limited_for === rid && e.hidden_docs.length > 0 : !!shownFor(e, rid));
  if (!limited) {
    const pdf = full();
    return { pdf, sha256: pdf ? e.final_sha256 : null, limited };
  }
  let row = ownCopyRow(e, rid);
  if (!row && e.final_sha256) {
    await buildOwnCopies(load(e.id), finish, render);
    row = ownCopyRow(e, rid);
  }
  return row ? { pdf: readBlob(row.sha256), sha256: row.sha256, limited } : { pdf: null, sha256: null, limited };
}

/** Said in the completed email of someone who gets a copy of their own. */
export const OWN_COPY_MAIL = 'Your copy holds the files that were for you. Its certificate lists any other file on this envelope by its fingerprint only.';

/**
 * The completed email of one person: their own copy attached and its own fingerprint, when their view is limited.
 * `base` is what everyone else gets; `plain` is its lines before the fingerprint line.
 */
export async function ownMail(e: any, r: any, base: { lines: string[]; plain: string[]; attachments: any; copy: 'attached' | 'too-large' | 'not-ready' }, fingerprint: (copy: 'attached' | 'too-large' | 'not-ready', sha: string) => string[], finish: Finish, render: Render, load: (id: string) => any) {
  const c = await copyFor(e, r.id, finish, render, () => null, load);
  if (!c.limited) return base;
  // Named after their own subject (forPerson), so not even the file name names another person's file.
  const name = `${(forPerson(e, r.id).subject || 'signed').replace(/[^\w .-]+/g, '_').slice(0, 80)}.pdf`;
  const attachments = c.pdf && c.pdf.length < 8_000_000 ? [{ filename: name, content: Buffer.from(c.pdf) }] : undefined;
  const copy: 'attached' | 'too-large' | 'not-ready' = !c.pdf ? 'not-ready' : attachments ? 'attached' : 'too-large';
  const lines = [...base.plain];
  if (!c.pdf) lines[0] = 'Everyone has finished. Your signed copy and its certificate of completion are being prepared and will be at the link below shortly.';
  lines.splice(1, 0, ...(c.sha256 ? fingerprint(copy, c.sha256) : []), OWN_COPY_MAIL);
  return { lines, plain: base.plain, attachments, copy };
}

/** Every stored own copy of an envelope, for the evidence pack, the deletion of its files and the lookup by ID. */
export const ownCopies = (envelopeId: string): { recipient_id: string; sha256: string; size: number; docs: string }[] =>
  all('SELECT recipient_id, sha256, size, docs FROM final_copies WHERE envelope_id=? ORDER BY made_at, recipient_id', envelopeId);

/** /verify by file: a stored own copy of a completed envelope that still has its files. */
export const envelopeOfCopy = (hash: string): string | null =>
  get("SELECT c.envelope_id id FROM final_copies c JOIN envelopes e ON e.id=c.envelope_id WHERE c.sha256=? AND e.status='completed' AND e.purged_at IS NULL", hash)?.id || null;

/** /verify by file of a copy made for one person: the subject as that person was shown it (forPerson), never one
 * that names a file of someone else. */
export function subjectOfCopy(hash: string, load: (id: string) => any): string {
  const c = get('SELECT envelope_id, recipient_id FROM final_copies WHERE sha256=?', hash);
  const e = c && load(c.envelope_id);
  return e ? forPerson(e, c.recipient_id).subject : '';
}
