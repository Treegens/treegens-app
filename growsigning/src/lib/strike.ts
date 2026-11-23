// A strike-out: the sender's line through wording that is printed on a page. It belongs to no recipient, nobody
// fills it in, and it is part of what everyone signs: every signer is shown it from the first look, it is drawn into
// the signed PDF, and once someone has finished it can only be added, moved or removed if the sender chooses to ask
// that person to sign again (printedView in src/server/envelopes.ts counts every field by its type and its place).
//
// It takes nothing out of the file. The words under the line stay in the PDF and can still be read and searched,
// the way ink through a line on paper leaves the line readable. To take words out for good, change the PDF and use
// Replace file. The editor says so where a strike-out is placed.
//
// The editor, the signing screen and the PDF all draw the same shape, so the shape is decided here, once. Plain
// functions with no side effects: pages, components and the server may all import this file.

export const STRIKE = 'strike';
export const isStrike = (f: any): boolean => f?.type === STRIKE;

/** A box taller than this share of the page covers more than one printed line, so it is crossed out corner to corner. */
export const STRIKE_CROSS_ABOVE = 0.035;
export const strikeIsCross = (f: { h: number }): boolean => Number(f.h) > STRIKE_CROSS_ABOVE;

/** The lines to draw, as [x1, y1, x2, y2] in fractions of the box from its top left corner. */
export const strikeLines = (f: { h: number }): [number, number, number, number][] => (strikeIsCross(f) ? [[0, 0, 1, 1], [0, 1, 1, 0]] : [[0, 0.5, 1, 0.5]]);

/** The classes the editor and the signing screen draw it with (see .field.strike in src/app/globals.css). */
export const strikeClass = (f: any): string => (isStrike(f) ? (strikeIsCross(f) ? ' strike cross' : ' strike') : '');

/** Where a strike-out is, for the audit trail and for the words about a correction. */
export const strikePlace = (page: number, documentName?: string | null): string => `page ${Number(page) + 1}${documentName ? ` of "${documentName}"` : ''}`;

/**
 * Said to someone who reads the document as text or has it read out, and so cannot see the line. `near` is the
 * printed line the strike-out sits on, when the page has text that can be read. The words do not claim to know which
 * part of that line is struck: only the page itself shows that.
 */
export const strikeSays = (sender: string, near?: string | null): string =>
  `${sender} struck out wording on this page${near ? `, at the line that reads: "${near}"` : ''}. Which words are struck shows only on the page itself, in the Document view and in the PDF. If you cannot see that, ask ${sender} which words are meant before you sign.`;

/** Said in the editor, where the sender places one. */
export const STRIKE_HELP = 'A line through wording on the page. Drag the box over the words. Everyone who signs sees the line, and it is printed on the signed PDF. It takes nothing out of the file: the words under it can still be read. To remove words for good, change your PDF and use Replace file in step 1.';
