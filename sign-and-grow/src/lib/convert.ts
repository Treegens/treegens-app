// Office files, text, web pages and TIFF pictures turned into a PDF before anyone places a field on them
// (src/server/convert.ts does the work). What the editor, the server and the API description say about it, in one
// place, so the words on the screen and the server's refusals cannot drift apart. No imports and no side effects:
// pages, the server and tests can all use it. Words go through t() once the language work is in.

/** The kinds of file the server recognises by their bytes and can turn into a PDF, grouped as people know them. */
export const CONVERT_FAMILIES = [
  { family: 'word', what: 'a Word file', label: 'Word', ext: ['.docx', '.docm', '.dotx', '.dotm', '.doc', '.dot'], mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'application/vnd.ms-word.document.macroenabled.12'] },
  { family: 'sheet', what: 'an Excel file', label: 'Excel', ext: ['.xlsx', '.xlsm', '.xltx', '.xls'], mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/vnd.ms-excel.sheet.macroenabled.12'] },
  { family: 'slides', what: 'a PowerPoint file', label: 'PowerPoint', ext: ['.pptx', '.pptm', '.ppsx', '.potx', '.ppt', '.pps'], mime: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint'] },
  { family: 'opendocument', what: 'an OpenDocument file', label: 'OpenDocument', ext: ['.odt', '.ods', '.odp', '.ott', '.ots', '.otp'], mime: ['application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation'] },
  { family: 'rtf', what: 'an RTF file', label: 'RTF', ext: ['.rtf'], mime: ['application/rtf', 'text/rtf'] },
  { family: 'text', what: 'a text file', label: 'plain text', ext: ['.txt', '.text'], mime: ['text/plain'] },
  { family: 'html', what: 'a web page', label: 'web page (HTML)', ext: ['.html', '.htm'], mime: ['text/html'] },
  { family: 'tiff', what: 'a TIFF picture', label: 'TIFF', ext: ['.tif', '.tiff'], mime: ['image/tiff'] },
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
  // The daily screen names what people have; every kind is listed on /help and in a refusal.
  return converts ? 'PDF, Word, Excel, PowerPoint or a picture. Up to 25 MB and 500 pages each.' : 'PDF, PNG or JPEG. Up to 25 MB and 500 pages each.';
}

/** What the browser says before sending a file it can already tell will not be taken. */
export function notTaken(converts: boolean, file?: { name: string; type?: string }): string {
  if (converts) return `This kind of file cannot be used. Upload a PDF, PNG or JPEG, or ${CONVERT_KINDS_TEXT}. From Pages, Numbers or Google Docs, download or export it as a PDF or a Word file first.`;
  // On a server that does not turn office files into PDF, a Word file is named for what it is and what to do.
  const what = file && whatIs(file);
  return what ? saveAsPdf(what) : 'Upload a PDF, PNG or JPEG. Export Word or Google Docs files as PDF first.';
}

/** What a file chosen in the browser is, in words ("a Word file"), by its name or type; '' when it is not one of ours. */
export function whatIs(f: { name: string; type?: string }): string {
  const ext = (/\.[^.]+$/.exec(f.name.toLowerCase()) || [''])[0];
  const type = String(f.type || '').toLowerCase();
  return CONVERT_FAMILIES.find((x) => (x.ext as readonly string[]).includes(ext) || (x.mime as readonly string[]).includes(type))?.what || '';
}

/** The one thing to do with a file this server cannot turn into a PDF. */
export const saveAsPdf = (what: string): string => `This is ${what}. Save it as a PDF and add it again.`;

/** What the server says about a file it recognised and cannot turn into a PDF, because no converter is set up. */
export function needsConverter(what: string): string {
  return `${saveAsPdf(what)} Nothing was saved.`;
}

/** For the people who run the server, sent with that refusal as "operator_hint" and never shown to a sender. */
export const OPERATOR_HINT = `${CONVERT_KINDS_TEXT} are turned into a PDF only on a server with a converter (CONVERTER or CONVERTER_URL). This server has none set up.`;

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
  external: 'This file links to pictures or content stored elsewhere. They may be missing from the PDF.',
  macros: 'This file has macros. Macros are switched off when the PDF is made, so check that nothing is missing.',
};

/** The sentence that is always said: the PDF is the record, and making it can move text. */
export const convertedLine = (from: string): string => `Converted from ${from}. Check every page before you send: the PDF is what people sign, and text can move.`;

/** Every sentence for one converted file, most urgent first: tracked changes (something to do before sending) when
 *  the file has them, then the sentence that is always said, then the rest. The screens show the first and fold the
 *  others (one note line under a file). Empty for a file that was not converted. */
export function convertNotes(c: Converted | null | undefined): string[] {
  if (!c?.from) return [];
  const has = (n: ConvertNote) => !!c.notes?.includes(n);
  return [...(has('tracked') ? [CONVERT_NOTE.tracked] : []), convertedLine(c.from), ...(['sheet', 'external', 'macros'] as ConvertNote[]).filter(has).map((n) => CONVERT_NOTE[n])];
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
export const ORIGINALS_README = 'originals/            each file as the sender uploaded it, before it was turned into a PDF: a Word, Excel, PowerPoint, OpenDocument, RTF, text, web page or TIFF file. These were not signed. The PDF made from each is what people saw and signed; the audit trail names each original by its SHA-256 and says what made the PDF. Text can move when a PDF is made, so the original and the PDF may not look the same.';

/** Whether the settings name a converter, for the public help page (a server component). The server's own answer
 *  (GET /me "converts") also knows whether LibreOffice was found; this only reads the settings. */
export function converterConfigured(): boolean {
  const c = (process.env.CONVERTER || '').trim().toLowerCase();
  const url = (process.env.CONVERTER_URL || '').trim();
  if (c === 'stub') return process.env.NODE_ENV !== 'production';
  if (c === 'soffice' || c === 'libreoffice') return true;
  return (c === 'gotenberg' || !c) && /^https?:\/\/[^\s/]+/i.test(url);
}
