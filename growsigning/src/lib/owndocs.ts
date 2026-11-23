// "Each person sees only their files": which files of an envelope one person is shown. One rule for the server
// (src/server/visibility.ts), the editor's step 3 and the Settings card, so the screen never says one thing and the
// signing link does another. Safe in 'use client' files: no server imports.
//
// With the option off, or with fewer than two files, everyone sees every file. With it on, a person sees:
//   - every file that holds one of their own fields;
//   - every file the sender ticked for them ("also_sees");
//   - a witness also sees what the person they witness sees;
//   - files that hold another person's field that one of their own formulas counts (the server adds those, because
//     the screen shows that value next to the result).
// Someone who has no field and nothing ticked (a copy, a viewer) sees every file: nobody is left with nothing to
// open. Someone who can change the document or chooses who comes next always sees everything. The sender's side
// (the sender, admins, the evidence pack, the sender's copy) always sees everything.

import { ASK_PREFIX } from './docname.ts';

export type OwnDocsPerson = { id: string; role?: string | null; witness_for?: string | null; also_sees?: string[] | null };
/** A file of the envelope. `supplemental` set: a file to read, not to sign (src/lib/supplements.ts). */
export type OwnDocsDoc = { id: string; name?: string | null; supplemental?: unknown };
export type OwnDocsField = { document_id: string; recipient_id?: string | null };

/** Roles that always see every file, because their job is the whole document. */
export const SEES_ALL_ROLES = ['editor', 'agent'];

/** The words of the option, in the editor and in Settings. */
export const OWN_DOCS_LABEL = 'Each person sees only their files';
/** Said beside the option. It never calls a file private from someone who gets any copy that shows it. */
export const OWN_DOCS_NOTE = "Each person's own copy holds only their files. The sender, admins and anyone the sender shares the full copy with see everything.";
/** Said in the certificate of a copy made for one person, for each file they were not shown. */
export const OTHER_DOC_LINE = 'One other document you were not shown';
/** Put in the copied audit trail wherever it named a file this person was not shown. */
export const OTHER_DOC_WORDS = 'a document you were not shown';

/** The ids of the files this person is shown, or null when they see every file. A file to read (a handbook, terms)
 * that nobody has ticked goes to everyone: it has no fields, and a rule such as "acknowledge" must never be skipped
 * without a word because nobody was shown it. Once it is ticked for someone, only those ticked get it. */
export function shownDocIds(on: boolean, docs: OwnDocsDoc[], people: OwnDocsPerson[], fields: OwnDocsField[], personId: string, more: string[] = []): Set<string> | null {
  if (!on || docs.length < 2) return null;
  const me = people.find((p) => p.id === personId);
  if (!me || SEES_ALL_ROLES.includes(String(me.role || ''))) return null;
  const ids = new Set(docs.map((d) => d.id));
  const set = new Set<string>();
  const add = (p: OwnDocsPerson | undefined) => {
    if (!p) return;
    for (const f of fields) if (f.recipient_id === p.id && ids.has(f.document_id)) set.add(f.document_id);
    for (const d of p.also_sees || []) if (ids.has(d)) set.add(d);
  };
  add(me);
  if (me.role === 'witness' && me.witness_for) add(people.find((p) => p.id === me.witness_for));
  for (const d of more) if (ids.has(d)) set.add(d);
  if (!set.size) return null;
  for (const d of docs) if (d.supplemental && !people.some((p) => (p.also_sees || []).includes(d.id))) set.add(d.id);
  if (set.size >= ids.size) return null;
  return set;
}

/** A list of ticks that may be stored: document ids only, each once, at most 30 (the most files an envelope holds). */
export function cleanTicks(v: unknown): string[] | null {
  if (v == null) return null;
  if (!Array.isArray(v)) return null;
  return [...new Set(v.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 80))].slice(0, 30) as string[];
}

/** The certificate of a copy made for one person: each file they were not shown, with its fingerprint and no name. */
export function hiddenDocLines(hidden: { sha256: string }[] | null | undefined): [string, string][] {
  return (hidden || []).map((d) => [OTHER_DOC_LINE, `SHA-256 of the original: ${d.sha256}`]);
}
/** Said under the audit trail heading of such a copy, so nobody takes the changed names for the record itself. */
export const TRAIL_NAMES_NOTE = 'In this copy, where a line names a file you were not shown, its name is replaced with "a document you were not shown", and the line about sending leaves out how many pages were sent in all. The sender\'s copy has the full trail, and the chain is checked against that.';

/** True when `text` names `name` as a whole, not as part of a longer word: "Pay" is not named in "Payment". */
export function namesFile(text: string | null | undefined, name: string | null | undefined): boolean {
  const t = String(text ?? ''), n = String(name ?? '').trim();
  if (!n || !t) return false;
  const low = t.toLocaleLowerCase(), key = n.toLocaleLowerCase();
  const word = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
  for (let i = low.indexOf(key); i >= 0; i = low.indexOf(key, i + 1)) if (!word(low[i - 1]) && !word(low[i + key.length])) return true;
  return false;
}

/**
 * The subject one person is emailed and shown. Someone who is shown every file gets the subject as it is. Someone
 * shown only some files gets it too, unless it is empty or names a file they are not shown (also the automatic
 * "Please sign: <first file>"): then it is "Please sign: <the first file they are shown>". So no subject, page
 * heading, email or file name of theirs names another person's file.
 */
export function subjectFor(subject: string | null | undefined, docs: OwnDocsDoc[], shown: Set<string> | null): string {
  const s = String(subject ?? '');
  if (!shown) return s;
  const mine = docs.filter((d) => shown.has(d.id));
  const mineNames = new Set(mine.map((d) => String(d.name || '')));
  const others = docs.filter((d) => !shown.has(d.id) && !mineNames.has(String(d.name || '')));
  if (s.trim() && !others.some((d) => namesFile(s, d.name))) return s;
  const first = mine.find((d) => !d.supplemental) || mine[0];
  return `${ASK_PREFIX}${String(first?.name || 'a document')}`;
}

/**
 * What one person is told changed: the sentences of `said` that name no file they are not shown. A change to another
 * person's file is not theirs to hear about. Empty when nothing is left.
 */
export function changeFor(said: string | null | undefined, hiddenNames: string[]): string {
  const s = String(said ?? '').trim();
  if (!s || !hiddenNames.length) return s;
  // "Before: 2 pages. Now: 3 pages." belongs to the line before it, about the same file.
  const lines: string[] = [];
  for (const x of s.split(/(?<=[.!?])\s+(?=[A-Z"])/)) if (/^(Before|Now):/.test(x) && lines.length) lines[lines.length - 1] += ` ${x}`; else lines.push(x);
  return lines.filter((x) => !hiddenNames.some((n) => namesFile(x, n))).join(' ').trim();
}

/** /verify, when a file is the completed copy made for one person (by file, or compared after a lookup by ID). */
export const OWN_COPY_VERIFY = 'This is the completed copy made for one person. It holds only the files that were for them, so it has fewer pages than the full signed file. Its certificate lists each other file by its fingerprint only.';

/** The sender's page, folded Files section: one line for each person shown only some files (limited_people). */
export const seesLine = (p: { name: string; sees: string[] }) => (p.sees.length ? `${p.name} sees only: ${p.sees.join(', ')}` : `${p.name} is shown no file.`);
/** Said once after those lines, when someone on the document is not limited. */
export const SEES_REST = 'Everyone else sees every file.';
