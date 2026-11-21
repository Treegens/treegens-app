// Office files, text, web pages and TIFF pictures turned into a PDF before anyone places a field on them
// (src/server/convert.ts does the work). What the editor, the server and the API description say about it, in one
// place, so the words on the screen and the server's refusals cannot drift apart. No imports and no side effects:
// pages, the server and tests can all use it. Words go through t() once the language work is in.

/** The kinds of file the server recognises by their bytes and can turn into a PDF, grouped as people know them. */
export const CONVERT_FAMILIES = [
  { family: 'word', label: 'Word', ext: ['.docx', '.docm', '.dotx', '.dotm', '.doc', '.dot'], mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'application/vnd.ms-word.document.macroenabled.12'] },
  { family: 'sheet', label: 'Excel', ext: ['.xlsx', '.xlsm', '.xltx', '.xls'], mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/vnd.ms-excel.sheet.macroenabled.12'] },
  { family: 'slides', label: 'PowerPoint', ext: ['.pptx', '.pptm', '.ppsx', '.potx', '.ppt', '.pps'], mime: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint'] },
  { family: 'opendocument', label: 'OpenDocument', ext: ['.odt', '.ods', '.odp', '.ott', '.ots', '.otp'], mime: ['application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation'] },
  { family: 'rtf', label: 'RTF', ext: ['.rtf'], mime: ['application/rtf', 'text/rtf'] },
  { family: 'text', label: 'plain text', ext: ['.txt', '.text'], mime: ['text/plain'] },
  { family: 'html', label: 'web page (HTML)', ext: ['.html', '.htm'], mime: ['text/html'] },
  { family: 'tiff', label: 'TIFF', ext: ['.tif', '.tiff'], mime: ['image/tiff'] },
] as const;

const EXTS: string[] = CONVERT_FAMILIES.flatMap((f) => [...f.ext]);
const MIMES: string[] = CONVERT_FAMILIES.flatMap((f) => [...f.mime]);

/** The kinds that need a converter, in words: "Word, Excel, PowerPoint, OpenDocument, RTF, plain text, web page (HTML) and TIFF files". */
export const CONVERT_KINDS_TEXT = `${CONVERT_FAMILIES.slice(0, -1).map((f) => f.label).join(', ')} and ${CONVERT_FAMILIES[CONVERT_FAMILIES.length - 1].label} files`;

/** What a file input offers: PDF and pictures always, the rest only on a server that can turn them into a PDF. */
export function acceptList(converts: boolean): string {
  const base = 'application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg';
  return converts ? `${base},${EXTS.join(',')},${MIMES.join(',')}` : base;
}

/** Whether a file chosen in the browser looks like one the server turns into a PDF (by its name or type only: the
 *  server decides by its bytes). */
export const isConvertible = (f: { name: string; type?: string }): boolean =>
  EXTS.includes((/\.[^.]+$/.exec(f.name.toLowerCase()) || [''])[0]) || MIMES.includes(String(f.type || '').toLowerCase());

/** The part of a file name that is dropped when it becomes a document's name. */
export const KNOWN_EXT = new RegExp(`\\.(pdf|png|jpe?g|${EXTS.map((e) => e.slice(1)).join('|')})$`, 'i');

/** The limits under the drop area, true for this server. */
export function uploadLimits(converts: boolean, phoneSeconds: number): string {
  const what = converts ? `PDF, PNG or JPEG, or ${CONVERT_KINDS_TEXT}, which we turn into a PDF for you to check before anyone signs.` : 'PDF, PNG or JPEG.';
  return `${what} Up to 25 MB and 500 pages each. A signer on a phone waits about ${Math.round(phoneSeconds)} seconds for each MB on a slow connection.`;
}

/** The same limits in one short line, for the drop area of the editor's first step. */
export function uploadLimitsShort(converts: boolean): string {
  return converts ? `PDF, PNG or JPEG, or ${CONVERT_KINDS_TEXT}, which we turn into a PDF. Up to 25 MB and 500 pages each.` : 'PDF, PNG or JPEG. Up to 25 MB and 500 pages each.';
}

/** What the browser says before sending a file it can already tell will not be taken. */
export function notTaken(converts: boolean): string {
  return converts
    ? `This kind of file cannot be used. Upload a PDF, PNG or JPEG, or ${CONVERT_KINDS_TEXT}. From Pages, Numbers or Google Docs, download or export it as a PDF or a Word file first.`
    : 'Upload a PDF, PNG or JPEG. Export Word or Google Docs files as PDF first.';
}

/** What the server says about a file it recognised and cannot turn into a PDF, because no converter is set up. */
export function needsConverter(what: string): string {
  return `This is ${what}. ${CONVERT_KINDS_TEXT} need a converter to become a PDF, and this server has none set up. Save it as a PDF in the program you made it with (in Word: File, Save a copy or Save as, then PDF) and upload that. Nothing was saved.`;
}

/** The progress line while the server works on an upload. */
export const checkingLabel = (name: string, type?: string): string => (isConvertible({ name, type }) ? 'Making a PDF of it' : 'Checking the pages');

// ---- What is said next to the converted pages --------------------------------------------------------------------

/** The kinds of notes kept with a converted file (files.converted on the server). */
export type ConvertNote = 'tracked' | 'sheet' | 'external' | 'macros';

/** What the server keeps and gives out about a converted file. `from` is the name of the file as it was uploaded,
 *  `sha256` its fingerprint, `tool` what turned it into a PDF. */
export type Converted = { from: string; kind: string; family: string; sha256: string; size: number; tool: string; notes: ConvertNote[]; at?: string };

export const CONVERT_NOTE: Record<ConvertNote, string> = {
  tracked: 'This file has tracked changes or comments. Accept or remove them first: the PDF shows them as they print.',
  sheet: 'A sheet may be split across pages.',
  external: 'This file points at outside content, which was not fetched.',
  macros: 'This file has macros. They were not run, so the PDF shows the file as it is without them.',
};

/** The sentence that is always said: the PDF is the record, and conversion can move text. */
export const convertedLine = (from: string): string => `Converted from ${from}. Check every page: the PDF is what people sign, and conversion can move text.`;

/** Every sentence for one converted file, the one that is always said first. Empty for a file that was not converted. */
export function convertNotes(c: Converted | null | undefined): string[] {
  if (!c?.from) return [];
  return [convertedLine(c.from), ...(['tracked', 'sheet', 'external', 'macros'] as ConvertNote[]).filter((n) => c.notes?.includes(n)).map((n) => CONVERT_NOTE[n])];
}

/** The note kept with a file, read back the way the server stores it (JSON, or nothing). */
export function convertedOf(stored: any): Converted | null {
  if (!stored) return null;
  try {
    const c = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return c && typeof c.from === 'string' ? { ...c, notes: Array.isArray(c.notes) ? c.notes : [] } : null;
  } catch {
    return null;
  }
}

/** What the original is called inside the evidence pack, and the line its README gives the folder. */
export const ORIGINALS_README = 'originals/            each file as the sender uploaded it, before it was turned into a PDF: a Word, Excel, PowerPoint, OpenDocument, RTF, text, web page or TIFF file. These were not signed. The PDF made from each is what people saw and signed; the audit trail names each original by its SHA-256 and says what made the PDF. Conversion can move text, so the original and the PDF may not look the same.';
