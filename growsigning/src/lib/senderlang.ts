// The sender's own screens and the emails to senders in the sender's language (research/docusign-gaps.json, batch
// "lang-sender"). Plain functions with no React and no environment in them, so the pages, the server and
// tests/ds-lang-sender.test.ts read the same rules. The catalogue and the language rules are src/lib/i18n.ts; the
// test languages (en-XA, ar-XB) and the translator are the signing page's (src/lib/signlang.ts), so a word looks the
// same in both places.
//
// Which language a sender's screens are in: the one they chose under Settings, Profile ("Language of your screens",
// users.locale), when it is still a sender language; else the first one their browser asks for that is; else English.
// A sender language is one that is switched on (shipped) and whose sender screens are not 'missing'. While English is
// the only one, nothing is chosen and nothing is shown (research/ux-notes.json ds-lang-sender).
import { SUPPORTED_LOCALES, SOURCE_LOCALE, browserLocale, normalizeLocale, languageOf, type Language, type Status, type Vars } from './i18n.ts';
import { signT, signDir, signLangAttr, isPseudo } from './signlang.ts';

/** Where the sender's screens of a language stand: their own status, else the language's. */
export const senderStatus = (l: Language): Status => l.sender || l.ui;

/** The languages a sender can choose for their own screens and emails, in the order a list shows them. English first. */
export const senderLanguages = (langs: Language[] = SUPPORTED_LOCALES): Language[] =>
  langs.filter((l) => l.tag === SOURCE_LOCALE || (l.shipped && senderStatus(l) !== 'missing'));
export const senderTags = (langs: Language[] = SUPPORTED_LOCALES): string[] => senderLanguages(langs).map((l) => l.tag);
export const isSenderLanguage = (tag: unknown, langs: Language[] = SUPPORTED_LOCALES): boolean => {
  const t = normalizeLocale(tag);
  return !!t && senderTags(langs).includes(t);
};
/** Whether Settings, Profile lists the choice at all: only with two or more sender languages. */
export const senderChoiceShown = (langs: Language[] = SUPPORTED_LOCALES): boolean => senderLanguages(langs).length > 1;

/** The first sender language an Accept-Language header (or the browser's list, joined) asks for, or null. */
export const senderBrowserLocale = (header: unknown, langs: Language[] = SUPPORTED_LOCALES): string | null =>
  browserLocale(header, senderLanguages(langs).map((l) => ({ ...l, shipped: true })));

/**
 * The language of a sender's screens: `chosen` (users.locale) when it is a sender language, else `browser` (an
 * Accept-Language header or navigator.languages joined with commas), else English. On a development server a test
 * language (`pseudo`) wins, so a word that skipped the catalogue shows at once.
 */
export function senderLocale(o: { chosen?: unknown; browser?: unknown; pseudo?: unknown }, langs: Language[] = SUPPORTED_LOCALES): string {
  if (isPseudo(o.pseudo)) return o.pseudo;
  const chosen = normalizeLocale(o.chosen);
  if (chosen && isSenderLanguage(chosen, langs)) return chosen;
  return senderBrowserLocale(o.browser, langs) || SOURCE_LOCALE;
}

/**
 * The language of an email to a sender: the one they chose, else the one their browser last asked for when they
 * opened the app (users.seen_locale), else English. Never a test language, never one that is not a sender language.
 */
export function senderMailLocale(u: { locale?: unknown; seen_locale?: unknown } | null | undefined, langs: Language[] = SUPPORTED_LOCALES): string {
  for (const v of [u?.locale, u?.seen_locale]) {
    const t = normalizeLocale(v);
    if (t && !isPseudo(t) && isSenderLanguage(t, langs)) return t;
  }
  return SOURCE_LOCALE;
}

/** The words of `key` on a sender's screen or in an email to a sender, in `lang` (test languages included). */
export const senderT = (lang: unknown, key: string, vars: Vars = {}): string => signT(lang, key, vars);

/**
 * The text of `key` cut where its parts go (a name in bold): plain text at even places, the name of a part at odd
 * places. Each part is marked with private-use characters, never with bare digits, so a digit in a plain variable
 * (an account called "Studio 54") or in a translation stays as it is. senderRich in components/senderLang.tsx draws it.
 */
export function senderRichPieces(lang: unknown, key: string, names: string[], vars: Vars = {}): string[] {
  const marked: Vars = { ...vars };
  names.forEach((n, i) => (marked[n] = `${i}`));
  return senderT(lang, key, marked).split(/(\d+)/).map((piece, i) => (i % 2 ? names[Number(piece)] : piece));
}
export const senderDir = signDir;
export const senderLangAttr = signLangAttr;

/** How the language list names a language for a sender: its own name, and "(draft)" in the reader's words when a machine's draft. */
export function senderLanguageName(tag: string, reader: unknown, langs: Language[] = SUPPORTED_LOCALES): string {
  const l = languageOf(tag, langs);
  if (!l) return tag;
  return senderStatus(l) === 'draft' ? senderT(reader, 'sender.language.draft_name', { language: l.own }) : l.own;
}

/** "Ada", "Ada and Ben", "Ada, Ben and Cee", "Ada, Ben and 3 others", in the reader's language (sender.names.* in en.json). */
export function joinIn(lang: unknown, items: string[]): string {
  const n = items.filter(Boolean);
  if (n.length <= 1) return n[0] || '';
  if (n.length === 2) return senderT(lang, 'sender.names.two', { a: n[0], b: n[1] });
  if (n.length === 3) return senderT(lang, 'sender.names.three', { a: n[0], b: n[1], c: n[2] });
  return senderT(lang, 'sender.names.more', { a: n[0], b: n[1], count: n.length - 2 });
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** A length of time since then, in `lang`: "3 days", "5 hours", "less than an hour". Empty for no date. */
export function howLongIn(lang: unknown, iso?: string | null, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const ms = Math.max(0, now - t);
  if (ms >= DAY) return senderT(lang, 'sender.time.days', { count: Math.floor(ms / DAY) });
  if (ms >= HOUR) return senderT(lang, 'sender.time.hours', { count: Math.floor(ms / HOUR) });
  return senderT(lang, 'sender.time.under_hour');
}

/**
 * What a sender's screen shows for a refusal from the server: the text of its code ("sender.error.<code>" in en.json)
 * in the sender's language, with the facts the answer carries put in; else the server's own words; else a plain
 * "could not reach the server" in the sender's language.
 */
export function senderError(lang: unknown, e: any): string {
  const code = typeof e?.code === 'string' ? e.code : typeof e?.data?.code === 'string' ? e.data.code : '';
  if (/^[a-z_]{1,40}$/.test(code)) {
    const vars: Vars = {};
    for (const [k, v] of Object.entries(e?.data || {})) if (typeof v === 'string' || typeof v === 'number') vars[k] = v;
    const text = senderT(lang, `sender.error.${code}`, vars);
    if (text) return text;
  }
  return (typeof e?.message === 'string' && e.message) || senderT(lang, 'sender.error.offline');
}
