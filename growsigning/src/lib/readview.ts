// The two ways the signing page shows a document, shared by the page and the server: "page" (the pages themselves,
// which is what is signed) and "easy" (Easy reading, the words reflowed for a small phone: src/components/sign/reflow.ts).
// The audit trail records the first time each person uses each of them, and the certificate says which they used.

export const READ_VIEWS = ['page', 'easy'] as const;
export type ReadView = (typeof READ_VIEWS)[number];

export const isReadView = (v: unknown): v is ReadView => typeof v === 'string' && (READ_VIEWS as readonly string[]).includes(v);

/**
 * The audit line for the first use of a view. The signing page sends it once that view is on the screen (the pages
 * drawn, or the words of Easy reading read), so it says the view was opened: never that anything was read.
 */
export const VIEW_ACTION: Record<ReadView, string> = {
  page: 'Opened the document as pages',
  easy: 'Opened the document in Easy reading',
};
export const viewDetail = (name: string, v: ReadView) =>
  v === 'easy'
    ? `${name} first had Easy reading on their screen, a reading aid that shows the words in one column. What is signed is the pages.`
    : `${name} first had the pages of the document on their screen.`;

/** The views a person used, as stored on them ("page,easy"), in a fixed order. Anything else is dropped. */
export function viewsOf(stored: unknown): ReadView[] {
  const got = new Set(String(stored || '').split(','));
  return READ_VIEWS.filter((v) => got.has(v));
}

/** The certificate's one line: which views this person used. Null when nothing was recorded (a document from before this was kept). */
export function viewsLine(stored: unknown): string | null {
  const v = viewsOf(stored);
  if (!v.length) return null;
  // The same names the signer chose from: "Page" and "Easy reading" (More, "How to read the document").
  if (v.length === 2) return 'Pages and Easy reading';
  return v[0] === 'easy' ? 'Easy reading only' : 'Pages only';
}
