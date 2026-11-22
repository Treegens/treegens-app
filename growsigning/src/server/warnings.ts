import { all } from './db.ts';
import { keptText } from './searchtext.ts';
import { baseUrl } from './util.ts';
import { paperWarnings, type PaperWarning } from '../lib/paperwork.ts';

// The check before sending: does the subject, a document's name or the text read from a document name a kind of
// document that often needs paper, a witness, a notary or a qualified signature? The words and the sentences are in
// src/lib/paperwork.ts, the one list the editor and the help page use too. This file only fetches what the server
// has that a page does not: the text of the uploaded files, which is kept for the sender's own search.
//
// It warns and never refuses. A send goes out with or without a warning, the answer to sending carries the list as
// "warnings", and sendEnvelope writes one line about it to the audit trail (PAPER_AUDIT_ACTION).

export type SendWarning = PaperWarning & { help_url: string };

/** What the audit line is called. The detail is paperAuditNote() from src/lib/paperwork.ts. */
export const PAPER_AUDIT_ACTION = 'Checked for documents that often need paper';

/**
 * `e` is an envelope or a template, by its id and subject. An empty subject is filled in from the first document's
 * name when the envelope is sent, and document names are looked at anyway, so nothing is missed by leaving it empty.
 */
export function sendWarnings(e: { id: string; subject?: string | null }): SendWarning[] {
  // The kept text may be encrypted (FILE_ENCRYPTION_KEY): it is opened here, in memory, for this check only (searchtext.ts).
  const documents = all('SELECT d.name, f.id, f.text, f.text_sealed FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=? ORDER BY d.position', e.id).map((d) => ({ name: d.name, text: keptText(d) }));
  return paperWarnings({ subject: e.subject, documents }).map((w) => ({ ...w, help_url: `${baseUrl()}${w.help}` }));
}
