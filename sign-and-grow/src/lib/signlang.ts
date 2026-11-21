// The signing page in the signer's language: the words, the two test languages, the server's refusals by their code,
// and which languages the header menu offers. Plain functions with no React and no environment in them, so the page,
// its components and tests/ds-lang-signing.test.ts all read the same rules. The catalogue and the language rules
// themselves are src/lib/i18n.ts.
//
// Two test languages, for development only, never offered on a production build and never saved on a recipient:
//   en-XA  every English text with accented letters, 40 percent longer, in [brackets]: a word that is still plain
//          English was not put through t(), and a button that overflows is one a longer language would break.
//   ar-XB  every English text written right to left: the layout mirrors the way Arabic or Hebrew would, so a part of
//          the page that does not turn around is easy to spot. The document pages and the signature pad never turn.
// Open a signing link with ?lang=en-XA or ?lang=ar-XB on a development server to see them.
import { translate, CATALOGUES, parseMessage, dir, languageOf, shippedLocales, normalizeLocale, type Catalogue, type Node, type Vars } from './i18n.ts';
import en from '../locales/en.json' with { type: 'json' };

export const PSEUDO_LOCALES = ['en-XA', 'ar-XB'] as const;
export type PseudoLocale = (typeof PSEUDO_LOCALES)[number];
const PSEUDO_NAMES: Record<PseudoLocale, string> = { 'en-XA': '[Ëñğļîšĥ, ţëšţ]', 'ar-XB': 'Right to left, test' };

export const isPseudo = (tag: unknown): tag is PseudoLocale => typeof tag === 'string' && (PSEUDO_LOCALES as readonly string[]).includes(tag);

const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/** One piece of plain text in a test language. */
export function pseudoText(s: string, tag: PseudoLocale): string {
  if (tag === 'ar-XB') return s.trim() ? `‮${s}‬` : s;
  return s.replace(/[A-Za-z]/g, (c) => ACCENTS[c] || c);
}

// A text read by parseMessage, written back with its plain parts changed and its placeholders and plurals kept.
const write = (nodes: Node[], tag: PseudoLocale): string =>
  nodes.map((x) => {
    if (typeof x === 'string') return pseudoText(x, tag);
    if ('hash' in x) return '#';
    if ('v' in x) return `{${x.v}}`;
    return `{${x.p}, plural, ${Object.entries(x.b).map(([k, v]) => `${k} {${write(v, tag)}}`).join(' ')}}`;
  }).join('');

/** A whole text in a test language: the English one changed, 40 percent longer for en-XA, in brackets. */
export function pseudoMessage(text: string, tag: PseudoLocale): string {
  let body: string;
  try {
    body = write(parseMessage(text), tag);
  } catch {
    return text;
  }
  if (tag === 'ar-XB') return body;
  const plain = text.replace(/\{[^{}]*\}/g, '').length;
  return `[${body}${plain ? ` ${'~'.repeat(Math.max(1, Math.round(plain * 0.4)))}` : ''}]`;
}

const pseudoCats = new Map<PseudoLocale, Catalogue>();
/** The catalogue of a test language, made from en.json the first time it is asked for. */
export function pseudoCatalogue(tag: PseudoLocale, source: Catalogue = en as Catalogue): Catalogue {
  if (source !== en) return Object.fromEntries(Object.entries(source).map(([k, v]) => [k, pseudoMessage(v, tag)]));
  if (!pseudoCats.has(tag)) pseudoCats.set(tag, Object.fromEntries(Object.entries(source).map(([k, v]) => [k, pseudoMessage(v, tag)])));
  return pseudoCats.get(tag)!;
}

/**
 * The text of `key` on the signing page for someone reading `lang`: their language along its fallback chain, then
 * English (see translate in i18n.ts). A test language is made from English here.
 */
export function signT(lang: unknown, key: string, vars: Vars = {}): string {
  if (isPseudo(lang)) return translate({ ...CATALOGUES, [lang]: pseudoCatalogue(lang) }, lang, key, vars);
  return translate(CATALOGUES, lang, key, vars);
}

/** Which way the page is written for `lang`: test languages included. */
export const signDir = (lang: unknown): 'rtl' | 'ltr' => (lang === 'ar-XB' ? 'rtl' : dir(lang));

/** The language attribute of the page: a test language reads as English to a browser and a screen reader. */
export const signLangAttr = (lang: unknown): string => (isPseudo(lang) ? 'en' : normalizeLocale(lang) || 'en');

export type MenuLanguage = { tag: string; own: string };
/**
 * What the header menu lists: every language that is switched on, each in its own name, and on a development server
 * the test languages once one of them is open. Fewer than two: the menu is not shown at all (research/ux-notes.json
 * ds-lang-signing: "Menu hidden with one language").
 */
export function menuLanguages(o: { dev: boolean; current?: unknown; shipped?: string[] }): MenuLanguage[] {
  const out: MenuLanguage[] = (o.shipped || shippedLocales()).map((tag) => ({ tag, own: languageOf(tag)?.own || tag }));
  if (o.dev && isPseudo(o.current)) for (const tag of PSEUDO_LOCALES) out.push({ tag, own: PSEUDO_NAMES[tag] });
  return out;
}

/** The catalogue key of a refusal's code: "sign.error.<code>". */
export const errorKey = (code: string) => `sign.error.${code}`;

/**
 * What the page shows for a refusal from the server, in the signer's language. A refusal with a code that has a text
 * is said from that text, with the facts the answer carries (minutes, names, counts) put in. One without (an old
 * server, a failure on the way) is said in the server's own English words, else in `fallbackKey`'s text.
 */
export function shownError(lang: unknown, e: any, fallbackKey = 'sign.error.unknown'): string {
  // A refusal said in one of its two ways names that text beside its code (refuse in src/server/signlang.ts).
  const said = typeof e?.data?.text === 'string' ? e.data.text : '';
  const code = said && /^[a-z_]{1,40}$/.test(said) && Object.hasOwn(en, errorKey(said)) ? said : typeof e?.code === 'string' ? e.code : typeof e?.data?.code === 'string' ? e.data.code : '';
  if (code && /^[a-z_]{1,40}$/.test(code) && Object.hasOwn(en, errorKey(code))) {
    const vars: Vars = {};
    for (const [k, v] of Object.entries(e?.data || {})) if (typeof v === 'string' || typeof v === 'number') vars[k] = v;
    const text = signT(lang, errorKey(code), vars);
    if (text) return text;
  }
  return (typeof e?.message === 'string' && e.message) || signT(lang, fallbackKey);
}

/**
 * The one sentence above the consent's legal text: the note of the wording (a language whose legal text nobody has
 * checked yet reads it in English, and says so), and on a test language the same sentence, so its length and place
 * can be seen on a development server before a real language ships.
 */
export const consentNote = (lang: unknown, note: string): string => note || (isPseudo(lang) ? signT(lang, 'legal.in_english') : '');
