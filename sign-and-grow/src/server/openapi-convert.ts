// What the API description says about office files turned into PDF on upload (src/server/convert.ts), kept apart
// so the busy openapi.ts only needs two references to it.
import { CONVERT_KINDS_TEXT, CONVERT_NOTE, convertedLine } from '../lib/convert.ts';
import { UNPACKED_MAX, UNPACKED_RATIO, PER_ACCOUNT_AT_ONCE, PER_ACCOUNT_HOUR } from './convert.ts';

export const CONVERT_API = `Office files: on a server whose operator set up a converter (CONVERTER=soffice for LibreOffice on the server, or CONVERTER_URL for a Gotenberg service), POST /files also takes ${CONVERT_KINDS_TEXT}, recognised by their bytes and never by their name or type. Each becomes a PDF before anything else happens, and from then on it is a PDF like any other: the same 25 MB and 500 page limits (the PDF made must also be under 25 MB), the same text for search and the same scan flag. The PDF is what people see and sign; the original is kept with it, named by its SHA-256 in the audit trail when the envelope is sent ("Converted to PDF"), and put in the evidence pack under originals/. Conversion can move text, so look at every page before you send: the answer's "converted" says what it was made from and what to check. GET /api/me says in "converts" whether this server converts. Without a converter such a file is refused with 400, "code": "needs_converter" and a sentence that says what to do. Also refused: a ZIP-based file that unpacks to more than ${UNPACKED_MAX / 1e6} MB or ${UNPACKED_RATIO} times its own size (400), a file protected with a password (400), a file the converter cannot open (422, "convert_failed"), one that takes longer than CONVERT_TIMEOUT_MS (422, "convert_timeout"), a TIFF that would lose pages (422, "convert_pages"), a third file of one account while ${PER_ACCOUNT_AT_ONCE} of its own are being converted (429, "convert_busy"), more than ${PER_ACCOUNT_HOUR} conversions of one account in an hour (429, "convert_hourly"), a full queue (503, "convert_queue_full") and a converter that is down (503, "converter_down"). Several "file" fields in one upload are still pictures only. A file a signer attaches is never converted.`;

export const CONVERTED_SCHEMA = {
  type: 'object', nullable: true, readOnly: true,
  description: `Set when the file was made from ${CONVERT_KINDS_TEXT.replace(/ files$/, '')} file, null otherwise. Repeated on every document that uses the file. The editor shows "${convertedLine('<from>')}" and one sentence for each note.`,
  properties: {
    from: { type: 'string', description: 'The name of the file as it was uploaded.' },
    kind: { type: 'string', enum: ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'doc', 'xls', 'ppt', 'rtf', 'html', 'txt', 'tiff'], description: 'What its bytes said it was.' },
    family: { type: 'string', enum: ['word', 'sheet', 'slides', 'rtf', 'text', 'html', 'tiff'] },
    sha256: { type: 'string', description: 'SHA-256 of the original as uploaded. The audit trail names it, and the evidence pack holds the file.' },
    size: { type: 'integer', description: 'Bytes of the original.' },
    tool: { type: 'string', description: 'What made the PDF, for example "LibreOffice 24.2.7.2".' },
    notes: { type: 'array', items: { type: 'string', enum: Object.keys(CONVERT_NOTE) }, description: `What to check. ${Object.entries(CONVERT_NOTE).map(([k, v]) => `${k}: "${v}"`).join(' ')}` },
    at: { type: 'string', format: 'date-time' },
  },
};
