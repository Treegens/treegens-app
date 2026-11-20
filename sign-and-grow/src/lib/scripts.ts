// What the signed PDF can print, and the words every screen and the certificate use when it cannot. The check itself
// is made by the server, which holds the fonts (src/server/pdftext.ts). This file has no side effects and reads
// nothing, so pages and 'use client' files may import it.

/** Printed in place of a character that none of the PDF fonts has. Never an empty box. */
export const PRINT_MARK = '�';

/** The scripts the signed PDF prints, as the help page and the README say it. */
export const PRINTED_SCRIPTS = 'Latin (with accents), Greek, Cyrillic, Arabic, Hebrew, Armenian, Georgian, Chinese, Japanese, Korean, Thai, Devanagari (Hindi, Marathi, Nepali) and Khmer';

/** Characters by their Unicode numbers, the way the certificate lists what it could not print: "U+0B95 U+0BBE". */
export const codePoints = (chars: string): string => [...chars].map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');

/**
 * The characters as they are shown in a warning: side by side, so the marks of a script stay on their letters, and
 * no more than twenty of them.
 */
export const shownChars = (chars: string): string => {
  const l = [...chars];
  return l.length > 20 ? `${l.slice(0, 20).join('')} and ${l.length - 20} more` : l.join('');
};

/** The headline of the warning, the same for whoever sends and whoever signs. */
export const CANNOT_PRINT_HEAD = 'The signed PDF cannot print some of the characters here.';
/** What happens to them instead. */
export const CANNOT_PRINT_THEN = `On the PDF each of them is replaced by the mark ${PRINT_MARK}, and the certificate lists them by Unicode number, so nothing is lost without a trace. On screen and in emails everything shows as typed.`;

/** Both in one sentence, naming the characters. */
export const cannotPrintText = (chars: string): string => `The signed PDF cannot print these characters: ${shownChars(chars)}. ${CANNOT_PRINT_THEN}`;

/** What to do about it, for the person who can still change the text. */
export const cannotPrintAdvice = 'To have it readable on the PDF, add the same in Latin letters as well, for example in brackets after it.';

// The four handwriting styles for a typed signature are fonts with Latin letters only. A browser draws every other
// script in its own plain font, whichever style is chosen, so for a name with no Latin letter the four would be
// four times the same picture. Then one plain style is offered instead of four that look alike.
const LATIN = /[A-Za-zÀ-ÖØ-öø-ÿ]/;
export const handwritingWrites = (text: string): boolean => !/\p{L}/u.test(text) || LATIN.test(text);
