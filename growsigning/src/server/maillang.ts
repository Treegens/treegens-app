// Emails and texts in the language of the person who receives them (research/docusign-gaps.json, batch "lang-mail").
// Our own words (the footer, our subjects, the lines we write) come from src/locales/en.json through t(), in the
// language decided for that person (src/server/locales.ts): the one the sender set, else the one they read the signing
// page in, else English. With only English switched on, every email reads exactly as before.
//
// What a sender writes (the subject, the message, notes) is never translated. In an email it is set apart under one
// line in the reader's language, "Message from {sender}, in their words:", so nobody takes it for our words.
//
// An email is in one language. One whose lines are not all in the catalogue yet is written without a locale, so it is
// all English, rather than an English body under a translated footer.
import { t, uiLocale, dir, normalizeLocale, SOURCE_LOCALE, SUPPORTED_LOCALES, type Vars } from '../lib/i18n.ts';
import { esc } from './util.ts';

/** The language of our words in an email or a text to recipient `r`: see the top of this file. Always a switched-on one. */
export function mailLocale(r: any): string {
  const tag = uiLocale(r?.locale || r?.page_locale || SOURCE_LOCALE);
  // A language reaches recipients' emails only once all of them are translated (Language.mail in src/lib/i18n.ts).
  // Today the request family and codes are, and the completed copy, declined, voided, witness, group, comment, Find
  // my documents and mail-again emails are not, so no language is marked ready: everyone reads English throughout.
  return tag === SOURCE_LOCALE || SUPPORTED_LOCALES.find((l) => l.tag === tag)?.mail ? tag : SOURCE_LOCALE;
}

/** The language an email is written in, as it is stored on its row: null for English, so old and new rows read alike. */
export const storedLocale = (locale: unknown): string | null => {
  const tag = normalizeLocale(locale);
  return !tag || tag === SOURCE_LOCALE ? null : tag;
};

/** The words of `key` for an email in `locale`. */
export const mt = (locale: unknown, key: string, vars: Vars = {}): string => t(locale || SOURCE_LOCALE, key, vars);

/**
 * A text of the footer with parts that are html (a code in bold, a link): the text is translated with a marker in
 * each place, escaped, and the parts are put in. A language may put them wherever its sentence needs them.
 */
export function mailHtml(locale: unknown, key: string, parts: Record<string, string>, vars: Vars = {}): string {
  const names = Object.keys(parts);
  const marked: Vars = { ...vars };
  names.forEach((n, i) => (marked[n] = `${i}`));
  return esc(mt(locale, key, marked)).replace(/(\d+)/g, (_, i) => parts[names[Number(i)]]);
}

/** The attributes of an email's html element in `locale`. */
export const mailLangAttrs = (locale: unknown): string => {
  const tag = normalizeLocale(locale) || SOURCE_LOCALE;
  return `lang="${esc(tag)}" dir="${dir(tag)}"`;
};

/** "a, b and c" in the reader's language. */
export function listIn(locale: unknown, items: string[]): string {
  try {
    return new Intl.ListFormat(normalizeLocale(locale) || SOURCE_LOCALE, { type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** The invisible sign in front of a line that holds a sender's own words: renderMail sets that line apart as a quote. */
export const QUOTE_MARK = '\u2063';
/** A line without the sign, for the plain text part and anything else that reads the words. */
export const unquote = (line: string): string => (line.startsWith(QUOTE_MARK) ? line.slice(1) : line);

/**
 * A sender's own words in an email: one line in the reader's language that says whose words they are, then the words
 * as written. In the email it is a quote with a line down its left side, so it reads apart from our words.
 */
export const theirWords = (locale: unknown, sender: string, words: string): string => `${QUOTE_MARK}${mt(locale, 'mail.their_words', { sender })}\n${words}`;

/** A line of renderMail: a sender's words (see theirWords) as a quote, anything else as a paragraph. */
export function mailLine(line: string): string {
  const para = 'font-size:15px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word';
  if (!line.startsWith(QUOTE_MARK)) return `<p style="font-size:15px;line-height:1.55;margin:0 0 14px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word">${esc(line)}</p>`;
  const [label, ...words] = line.slice(1).split('\n');
  return `<div style="margin:0 0 14px;border-left:3px solid #cfd8d2;padding-left:12px"><p style="font-size:13px;line-height:1.4;font-weight:600;color:#3d4a42;margin:0 0 4px;overflow-wrap:anywhere">${esc(label)}</p><p style="${para};margin:0">${esc(words.join('\n'))}</p></div>`;
}
