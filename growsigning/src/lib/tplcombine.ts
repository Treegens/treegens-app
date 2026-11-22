// Several templates in one document, and "This looks like your template ...". The words and numbers the templates
// page, the editor and the server share (src/server/tplcombine.ts, src/server/tplmatch.ts).

/** How many templates one document can start from. */
export const MAX_COMBINED = 5;

/**
 * How alike an upload must be to a template before the editor offers it, in percent. 80 when the account chose none:
 * a one-page form with a name, a date and a word changed is still offered, and "What is different" says what changed.
 * Only through the API (PUT /account/template-match): there is no setting for it on a screen.
 */
export const MATCH_CHOICES = [80, 90, 95] as const;
export const DEFAULT_MATCH_PERCENT = 80;
export const matchPercentOf = (v: unknown): number => (MATCH_CHOICES as readonly number[]).includes(Number(v)) ? Number(v) : DEFAULT_MATCH_PERCENT;

/** Two role names are the same role when they are the same words, whatever the capitals and spaces. */
export const roleKey = (name: unknown): string => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** "A", "A and B", "A, B and C". */
export const joinNames = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The name of a document made from several templates, when the sender gives none. */
export const combinedName = (names: string[]) => joinNames(names.map((n) => n || 'Untitled template')).slice(0, 200);

/** What the server answers for a file that looks like a template (GET /files/:id/template-match). */
export type TemplateMatch = {
  template_id: string;
  template: string;
  percent: number;
  /** The template's wording is locked for this person: its fields cannot go on another file, only the template itself can be used. */
  locked: boolean;
  differences: {
    /** Pages of the upload and of the template's document. */
    pages: { upload: number; template: number };
    /** Pages (counted from 1) whose words are not the same in both. */
    changed_pages: number[];
    /** A few words that are only in the upload, and a few only in the template. */
    only_in_upload: string[];
    only_in_template: string[];
  };
};

/** The one line under the file. For a locked template, what its button does, said before it is pressed. */
export const matchLine = (m: Pick<TemplateMatch, 'template' | 'locked'>) => m.locked
  ? `This looks like your template ${m.template}. Its wording is locked, so this starts a new document from the template. Your file stays in Drafts.`
  : `This looks like your template ${m.template}. Use it?`;

/** The button of the line. */
export const useLabel = (m: Pick<TemplateMatch, 'template' | 'locked'>) => (m.locked ? `Start from ${m.template}` : 'Use it');

/** What differs, in plain words, for the line's "What is different": how much is the same first, then what is not. */
export function differenceLines(m: TemplateMatch): string[] {
  const d = m.differences;
  const out: string[] = [m.percent >= 100 ? 'All of the words are the same.' : `${m.percent} percent of the words are the same.`];
  if (d.pages.upload !== d.pages.template) out.push(`Your file has ${d.pages.upload} page${d.pages.upload === 1 ? '' : 's'} and the template has ${d.pages.template}.`);
  if (d.changed_pages.length) out.push(`The words are not the same on page${d.changed_pages.length === 1 ? '' : 's'} ${joinNames(d.changed_pages.map(String))}.`);
  if (d.only_in_upload.length) out.push(`Only in your file: ${d.only_in_upload.join(', ')}.`);
  if (d.only_in_template.length) out.push(`Only in the template: ${d.only_in_template.join(', ')}.`);
  return out;
}

/** What "Use it" does, said before it is pressed. */
export const useMeans = (m: Pick<TemplateMatch, 'locked'>) => m.locked
  ? 'Its wording is locked, so its fields cannot go on another file. The new document has the template\'s own file, and the draft with your file is not changed.'
  : 'Use it puts the template\'s people and fields on your file. You can change them before sending.';
