import { route } from './router.ts';
import { find, assertViewable } from './routes-sign.ts';
import { ocrState, ocrText } from './ocr.ts';
import { OCR_WARNING } from '../lib/a11y.ts';

// The text a machine read from the pages of this person's documents that are pictures (src/server/ocr.ts), for the
// text view of the signing page and so for screen readers. Readable exactly when the documents are: the same link,
// access code, one-time code and turn as GET /sign/:token/doc/:doc. Only pages that had no text of their own are in
// it, and the warning goes with it, word for word, so no screen shows the text without it.
route('GET', '/sign/:token/ocr', (c) => {
  const { e, r } = find(c);
  assertViewable(e, r);
  const documents = e.documents
    .map((d: any) => ({ id: d.id, state: ocrState(d.file_id), pages: ocrText(d.file_id) }))
    .filter((d: any) => d.state)
    .map((d: any) => ({ id: d.id, state: d.state, pages: Object.entries(d.pages).map(([page, text]) => ({ page: Number(page), text })) }));
  return { warning: OCR_WARNING, documents };
}, 'public');
