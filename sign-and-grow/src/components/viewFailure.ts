// Why a PDF could not be shown, for the viewer (PdfDoc) and the pages that use it. No React here, so tests can read it.

/**
 * The three cases a person can do something different about: this browser cannot run the viewer ('browser'), the
 * file did not arrive ('offline'), or the file itself is not readable ('file').
 */
export type ViewFailure = 'browser' | 'offline' | 'file';

/** The sentence for each, when the page showing the document has nothing more specific to say. */
export const VIEW_FAILED: Record<ViewFailure, string> = {
  browser: 'This browser could not show the document. Open the page in another browser, or update this one, and try again.',
  offline: 'The document did not arrive. This device seems to be offline. Check the connection and try again.',
  file: 'The document could not be read. Try again in a moment. If it keeps happening, the file may be damaged.',
};

/**
 * `loaded` says whether the viewer itself arrived and started. The viewer names its own errors; anything else, a
 * function the browser does not have above all ("Promise.withResolvers is not a function"), is the browser.
 */
export function whyNotShown(e: any, loaded: boolean, online = true): ViewFailure {
  if (!online) return 'offline';
  if (!loaded) return /fetch|network|load failed/i.test(e?.message || '') ? 'offline' : 'browser';
  if (e?.name === 'UnexpectedResponseException') return e?.status ? 'file' : 'offline';
  if (['MissingPDFException', 'InvalidPDFException', 'PasswordException'].includes(e?.name)) return 'file';
  if (/fetch|network|load failed/i.test(e?.message || '')) return 'offline';
  return 'browser';
}

/** What the server said when it refused a stored file: it failed its check, or it is locked with an encryption key the
 *  server was not given (src/server/filestore.ts). Its words say what happened; a page shows them as they are. */
export type ServerSaid = { code: 'file_damaged' | 'file_locked'; text: string };
export const STORED_FILE_CODES = ['file_damaged', 'file_locked'];
export function readServerSaid(body: any): ServerSaid | null {
  return body && STORED_FILE_CODES.includes(body.code) && typeof body.error === 'string' ? { code: body.code, text: body.error } : null;
}
/** Asks once more for a file the viewer could not load, only to read why. Null when it says nothing we know. */
export async function serverSaid(url: string): Promise<ServerSaid | null> {
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!/json/.test(r.headers.get('content-type') || '')) return (r.body?.cancel().catch(() => {}), null);
    return readServerSaid(await r.json());
  } catch {
    return null;
  }
}
