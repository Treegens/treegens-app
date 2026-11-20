// What the editor says about a document that has pages which are pictures with no text: a scan, a photo, a PNG or
// JPEG upload. The server looks at every page when the file is uploaded and keeps the answer with the file
// (storeUpload in src/server/routes-envelopes.ts), so this can be said at upload, again when a draft is opened
// later, and once more before sending. No imports and no side effects: pages and tests can both use it.

export type ScanInfo = { is_scan?: boolean; scan_pages?: number[]; pages?: number };

/** "page 2", "pages 2 and 3", "pages 2, 3 and 5", and for a long list the first six and how many more. */
export function pageList(pages: number[]): string {
  const p = [...pages].sort((a, b) => a - b);
  if (p.length === 1) return `page ${p[0]}`;
  if (p.length > 7) return `pages ${p.slice(0, 6).join(', ')} and ${p.length - 6} more`;
  return `pages ${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}`;
}

/** The warning for one document, or '' when every page has text. */
export function scanWarning(d: ScanInfo): string {
  const pages = d.scan_pages || [];
  if (!d.is_scan && !pages.length) return '';
  const whole = !pages.length || (d.pages != null && pages.length >= d.pages);
  const one = pages.length === 1;
  const what = whole
    ? 'This looks like a scan or a photo: it is a picture of the pages with no real text.'
    : `${pageList(pages).replace(/^p/, 'P')} of this document ${one ? 'has' : 'have'} no real text: ${one ? 'it looks like a scan or a photo of a page' : 'they look like scans or photos of pages'}.`;
  const it = whole ? 'it' : one ? 'that page' : 'those pages';
  return `${what} People who use a screen reader will not be able to have ${it} read to them, ${whole ? 'it' : one ? 'it' : 'they'} cannot be found by searching, and Find fields for me has nothing to work with there. If you have the original file, export a PDF from that and use Replace file.`;
}
