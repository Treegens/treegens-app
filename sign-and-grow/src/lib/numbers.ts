// How a number or an amount may be written in a number field. One rule, used by the signing page while someone
// types and by the server when they finish, so the two can never disagree. Plain constants: safe for pages.
//
// People do not all write numbers the American way. All of these are numbers:
//   2500    12.5    12,5              plain, with a dot or a comma before the decimals
//   1,234.56    1.234,56              thousands in groups of three, the other mark before the decimals
//   1 234,56    1'234.56              a space (also a narrow or no-break one) or an apostrophe between the groups
//   1,23,456    12,34,567.50          the Indian way: the last three digits, then groups of two
//   -40    €1.234,56    1 234,56 kr   a minus or plus in front, a currency sign before or after
// Digits of other scripts count as digits (١٢٣, १२३). What is typed is what is printed: nothing is converted to
// another notation, because the signer wrote the number and the document is theirs to read.
const D = '\\p{Nd}';
const SPACE = ' \\u00a0\\u2009\\u202f';
export const NUMBER_RULE = new RegExp(
  `^\\s*[+\\-\\u2212]?(?:\\p{Sc}[${SPACE}]?)?(?:`
  + `${D}+(?:[.,\\u066b]${D}+)?`
  + `|${D}{1,3}([.,'\\u2019\\u066c${SPACE}])${D}{3}(?:\\1${D}{3})*(?:(?!\\1)[.,\\u066b]${D}+)?`
  + `|${D}{1,2}(?:,${D}{2})+,${D}{3}(?:\\.${D}+)?`
  + `)(?:[${SPACE}]?(?:\\p{Sc}|kr|zł|Kč|Ft|лв|руб))?\\s*$`, 'u');

export const isNumber = (value: any): boolean => NUMBER_RULE.test(String(value ?? ''));

/** Shown with a number field before anything is wrong. */
export const NUMBER_HINT = 'Type the number as you write it, like 2500, 1.234,56 or 1,234.56. It is printed exactly as you type it.';
/** Shown when what was typed does not read as a number. */
export const NUMBER_PROBLEM = 'This does not read as a number. Type it as you write it, like 2500, 12.5, 1.234,56 or 1,234.56, with nothing else in the field.';

/**
 * A number the app itself shows on a screen (a count, an amount it worked out), written the reader's way: 1,234.5 in
 * English, 1 234,5 in French. Never used for what a signer typed (that is printed as typed) nor in the signed PDF.
 */
export function numberOnScreen(n: number, locale?: unknown, digits = 2): string {
  if (!Number.isFinite(n)) return '';
  let tag = 'en';
  try {
    tag = (typeof locale === 'string' && locale.trim() && Intl.getCanonicalLocales(locale.trim().replace(/_/g, '-'))[0]) || 'en';
  } catch {
    /* not a language tag: English */
  }
  return new Intl.NumberFormat(tag, { maximumFractionDigits: digits }).format(n);
}
