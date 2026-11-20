// The words on our screens in more than one language, without a library. Plain functions and a JSON catalogue per
// language, with no environment in them, so a 'use client' file may import this as well as the server.
//
// Catalogues: src/locales/<tag>.json, flat, key to text ("sign.finish.button": "Finish"). en.json is the source:
// every key starts there, and every other catalogue has the same keys (npm run i18n:check says what is not so). A
// text holds plain words and two kinds of placeholder, read by the small parser below and never run as code:
//   {name}                                         the value given for name, as text (a number in the language's own way)
//   {count, plural, one {# day} other {# days}}    the branch for that number by the language's plural rules
//                                                  (Intl.PluralRules), with # standing for the number; =0 {...} for an
//                                                  exact number. Branches are zero, one, two, few, many and other, and
//                                                  other is always needed.
// There is no other syntax and no escaping: a { or } is always one of these. A text that does not read is not shown:
// the English one is.
//
// What a person sees, in order: their own language (pt-BR), then the language without the region (pt), then English.
// A key with no text in any of them shows nothing rather than the key: tests/i18n.test.ts checks that every key used
// in the code is in en.json.
//
// The legal texts (consent, what kind of signature this is, the adopt line, witness statements, STAMP_IS,
// CHECK_PROVES) are not in the catalogues. They live in the code beside their versions (src/lib/policy.ts), a
// person who can answer for them checks each language, and until one has, that part is shown in English with one
// sentence in the person's language saying why (legalNote below). A machine translation of a legal text is never
// shown as the text.
import en from '../locales/en.json' with { type: 'json' };

export type Catalogue = Record<string, string>;
export type Vars = Record<string, string | number | null | undefined>;
/** reviewed: a person checked every text. draft: a machine's first draft, nobody has checked it. missing: nothing yet. */
export type Status = 'reviewed' | 'draft' | 'missing';
export type Language = {
  /** The BCP 47 tag, as Intl.getCanonicalLocales writes it. */
  tag: string;
  /** Its name in English, for the audit trail and the certificate, which are in English. */
  english: string;
  /** Its name in itself, for a list a person picks from. */
  own: string;
  /** The words on screens and in emails. */
  ui: Status;
  /** The legal texts listed at the top of this file. */
  legal: Status;
  /** Switched on: a sender can choose it and a browser that asks for it gets it. The owner switches a language on. */
  shipped: boolean;
};

/** The language every text starts in, and the one shown when nothing better is there. */
export const SOURCE_LOCALE = 'en';

/**
 * Every language the catalogue can hold, with where its translation stands. Only English is switched on. French is
 * here for Canada and the EU, Amharic (in its own Ethiopic script) and Afaan Oromo for Ethiopia: each has no
 * translation yet, and is switched on only when a person has checked its words (the owner's decision, not a setting).
 */
export const SUPPORTED_LOCALES: Language[] = [
  { tag: 'en', english: 'English', own: 'English', ui: 'reviewed', legal: 'reviewed', shipped: true },
  { tag: 'fr', english: 'French', own: 'Français', ui: 'missing', legal: 'missing', shipped: false },
  { tag: 'am', english: 'Amharic', own: 'አማርኛ', ui: 'missing', legal: 'missing', shipped: false },
  { tag: 'om', english: 'Afaan Oromo', own: 'Afaan Oromoo', ui: 'missing', legal: 'missing', shipped: false },
];

/** The catalogues in this build: the source and every language that is switched on. A new one is imported here. */
export const CATALOGUES: Record<string, Catalogue> = { en };

/** The tags a sender can choose and a browser can get, in the order a list shows them. */
export const shippedLocales = (langs: Language[] = SUPPORTED_LOCALES): string[] => langs.filter((l) => l.shipped).map((l) => l.tag);
export const isShipped = (tag: unknown, langs: Language[] = SUPPORTED_LOCALES): boolean => {
  const t = normalizeLocale(tag);
  return !!t && shippedLocales(langs).includes(t);
};
export const languageOf = (tag: unknown, langs: Language[] = SUPPORTED_LOCALES): Language | undefined => {
  const t = normalizeLocale(tag);
  return t ? langs.find((l) => l.tag === t) : undefined;
};
/** "English (en)": how the audit trail and the certificate name a language. A tag we do not list is named by its tag. */
export const languageWords = (tag: unknown, langs: Language[] = SUPPORTED_LOCALES): string => {
  const t = normalizeLocale(tag) || SOURCE_LOCALE;
  return `${languageOf(t, langs)?.english || t} (${t})`;
};

/** A language tag written the one standard way ("pt-br" and "pt_BR" are "pt-BR"), or null when it is not one. */
export function normalizeLocale(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/_/g, '-');
  if (!s || s.length > 35 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(s)) return null;
  try {
    return Intl.getCanonicalLocales(s)[0] || null;
  } catch {
    return null;
  }
}

const primary = (tag: string) => tag.split('-')[0];

/** The languages a text is looked for in, best first: ["pt-BR", "pt", "en"]. Always ends with English. */
export function fallbackChain(locale: unknown): string[] {
  const tag = normalizeLocale(locale);
  const out: string[] = [];
  if (tag) {
    // Extensions (-u-ca-ethiopic, -x-...) say how to write things, not which words: they are not looked up.
    const parts = tag.split(/-[a-wyz0-9]-|-x-/i)[0].split('-');
    for (let n = parts.length; n > 0; n--) {
      const t = parts.slice(0, n).join('-');
      if (!out.includes(t)) out.push(t);
    }
  }
  if (!out.includes(SOURCE_LOCALE)) out.push(SOURCE_LOCALE);
  return out;
}

const RTL = new Set(['ar', 'he', 'fa', 'ur']);
const RTL_SCRIPTS = new Set(['Arab', 'Hebr']);
/** Which way a language is written: 'rtl' for Arabic, Hebrew, Persian and Urdu (and a tag that names their scripts). */
export function dir(locale: unknown): 'rtl' | 'ltr' {
  const tag = normalizeLocale(locale);
  if (!tag) return 'ltr';
  const script = tag.split('-').find((p, i) => i > 0 && /^[A-Z][a-z]{3}$/.test(p));
  if (script) return RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
  return RTL.has(primary(tag)) ? 'rtl' : 'ltr';
}

// ---- The parser ------------------------------------------------------------------------------------------

export type Node = string | { v: string } | { p: string; b: Record<string, Node[]> } | { hash: true };
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/** Reads a catalogue text into its parts. Throws, with the place, when the text does not read. */
export function parseMessage(src: string): Node[] {
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`${why} (at character ${i + 1})`);
  };
  const space = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const word = () => {
    const s = i;
    while (i < src.length && /[A-Za-z0-9_=]/.test(src[i])) i++;
    return src.slice(s, i);
  };
  const message = (inPlural: boolean, depth: number): Node[] => {
    const out: Node[] = [];
    let text = '';
    while (i < src.length && src[i] !== '}') {
      if (src[i] === '{') {
        if (text) out.push(text), (text = '');
        out.push(arg(depth));
      } else if (src[i] === '#' && inPlural) {
        if (text) out.push(text), (text = '');
        out.push({ hash: true });
        i++;
      } else text += src[i++];
    }
    if (text) out.push(text);
    return out;
  };
  const arg = (depth: number): Node => {
    i++;
    space();
    const name = word();
    if (!NAME.test(name)) fail('A { has to be followed by the name of a placeholder');
    space();
    if (src[i] === '}') return (i++, { v: name });
    if (src[i] !== ',') fail(`After {${name} there has to be } or ", plural,"`);
    i++;
    space();
    if (word() !== 'plural') fail(`{${name}, ...} can only be "plural"`);
    space();
    if (src[i] !== ',') fail(`{${name}, plural needs a comma before its branches`);
    i++;
    if (depth >= 3) fail('Plurals can be put inside each other three deep at most');
    const b: Record<string, Node[]> = {};
    for (;;) {
      space();
      if (i >= src.length) fail(`{${name}, plural} is not closed with }`);
      if (src[i] === '}') {
        i++;
        break;
      }
      const sel = word();
      if (!CATEGORIES.has(sel) && !/^=\d{1,9}$/.test(sel)) fail(`"${sel}" is not a plural branch: use zero, one, two, few, many, other or =<number>`);
      if (Object.hasOwn(b, sel)) fail(`The branch "${sel}" is there twice`);
      space();
      if (src[i] !== '{') fail(`The branch "${sel}" needs its text in { }`);
      i++;
      b[sel] = message(true, depth + 1);
      if (src[i] !== '}') fail(`The branch "${sel}" is not closed with }`);
      i++;
    }
    if (!b.other) fail(`{${name}, plural} needs an "other" branch`);
    return { p: name, b };
  };
  const out = message(false, 0);
  if (i < src.length) fail('There is a } without a { before it');
  return out;
}

/** The names of the placeholders in a text, plural ones included, sorted: what a translation must keep. */
export function placeholders(nodes: Node[]): string[] {
  const seen = new Set<string>();
  const walk = (list: Node[]) => {
    for (const x of list) {
      if (typeof x === 'string' || 'hash' in x) continue;
      if ('v' in x) seen.add(x.v);
      else {
        seen.add(x.p);
        Object.values(x.b).forEach(walk);
      }
    }
  };
  walk(nodes);
  return [...seen].sort();
}

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();
const rulesFor = (locale: string) => {
  if (!pluralRules.has(locale)) pluralRules.set(locale, new Intl.PluralRules(locale));
  return pluralRules.get(locale)!;
};
const numberIn = (locale: string, n: number) => {
  if (!numberFormats.has(locale)) numberFormats.set(locale, new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }));
  return numberFormats.get(locale)!.format(n);
};
const shown = (locale: string, v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? numberIn(locale, v) : v == null ? '' : String(v));

/** Puts the values into a text that was read with parseMessage, by the rules of `locale`. */
export function render(nodes: Node[], locale: string, vars: Vars = {}, count?: number): string {
  let out = '';
  for (const x of nodes) {
    if (typeof x === 'string') out += x;
    else if ('hash' in x) out += count == null ? '' : numberIn(locale, count);
    else if ('v' in x) out += shown(locale, Object.hasOwn(vars, x.v) ? vars[x.v] : undefined);
    else {
      const value = Object.hasOwn(vars, x.p) ? vars[x.p] : undefined;
      const n = typeof value === 'number' ? value : value != null && String(value).trim() !== '' ? Number(value) : NaN;
      let branch = x.b.other;
      if (Number.isFinite(n)) {
        const exact = x.b[`=${n}`];
        branch = exact || x.b[rulesFor(locale).select(n)] || x.b.other;
      }
      out += render(branch, locale, vars, Number.isFinite(n) ? n : undefined);
    }
  }
  return out;
}

/** A text with its values put in, in one language, or null when it does not read. Never throws. */
export function formatMessage(text: string, locale: string, vars: Vars = {}): string | null {
  try {
    return render(parseMessage(text), locale, vars);
  } catch {
    return null;
  }
}

const parsedCache = new WeakMap<Catalogue, Map<string, Node[] | null>>();
function parsedIn(cat: Catalogue, key: string): Node[] | null {
  if (!parsedCache.has(cat)) parsedCache.set(cat, new Map());
  const m = parsedCache.get(cat)!;
  if (!m.has(key)) {
    let nodes: Node[] | null = null;
    try {
      nodes = parseMessage(cat[key]);
    } catch {
      nodes = null;
    }
    m.set(key, nodes);
  }
  return m.get(key)!;
}

const warned = new Set<string>();
function warnMissing(key: string, locale: unknown) {
  try {
    if (process.env.NODE_ENV !== 'development' || warned.has(`${locale}|${key}`)) return;
    warned.add(`${locale}|${key}`);
    console.warn(`[i18n] No text for "${key}" in ${String(locale)} or English.`);
  } catch {
    /* no process in this browser: nothing to say */
  }
}

/**
 * The text of `key` for someone who reads `locale`, from the catalogues given, along the fallback chain. A text that
 * is missing, empty or does not read is passed over for the next language. With none, the answer is empty, never
 * the key. Numbers and plural branches follow the language the text was found in, so an English fallback reads as
 * English.
 */
export function translate(cats: Record<string, Catalogue>, locale: unknown, key: string, vars: Vars = {}): string {
  for (const loc of fallbackChain(locale)) {
    const cat = Object.hasOwn(cats, loc) ? cats[loc] : undefined;
    if (!cat || !Object.hasOwn(cat, key) || typeof cat[key] !== 'string' || cat[key] === '') continue;
    const nodes = parsedIn(cat, key);
    if (nodes) return render(nodes, loc, vars);
  }
  warnMissing(key, locale);
  return '';
}

/** The text of `key` in `locale`, with {name} placeholders and plurals filled in. */
export const t = (locale: unknown, key: string, vars: Vars = {}): string => translate(CATALOGUES, locale, key, vars);

// ---- Which language a person sees -------------------------------------------------------------------------

/** The languages an Accept-Language header asks for, best first ("fr-CA,fr;q=0.8,en;q=0.5" is fr-CA, fr, en). */
export function browserLocales(header: unknown): string[] {
  if (typeof header !== 'string' || !header) return [];
  return header.slice(0, 1000).split(',').slice(0, 30)
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => /^q=/i.test(p));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: normalizeLocale(tag), q: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((x) => x.tag!);
}

/** The first language a browser asks for that is switched on (fr-CA is served by fr, pt by pt-BR), or null. */
export function browserLocale(header: unknown, langs: Language[] = SUPPORTED_LOCALES): string | null {
  const on = shippedLocales(langs);
  for (const want of browserLocales(header)) {
    const chain = fallbackChain(want).filter((x) => x !== SOURCE_LOCALE || primary(want) === SOURCE_LOCALE);
    const hit = chain.find((x) => on.includes(x)) || on.find((x) => primary(x) === primary(want));
    if (hit) return hit;
  }
  return null;
}

/**
 * The language of someone's screens and emails: the one the sender set for them, when it is switched on; else the
 * first one their browser asks for that is; else English.
 */
export function chooseLocale(o: { chosen?: unknown; acceptLanguage?: unknown }, langs: Language[] = SUPPORTED_LOCALES): string {
  const chosen = normalizeLocale(o.chosen);
  if (chosen && isShipped(chosen, langs)) return chosen;
  return browserLocale(o.acceptLanguage, langs) || SOURCE_LOCALE;
}

/** The language the screens are actually in for `locale`: the first switched-on one along its chain, else English. */
export const uiLocale = (locale: unknown, langs: Language[] = SUPPORTED_LOCALES): string =>
  fallbackChain(locale).find((x) => isShipped(x, langs)) || SOURCE_LOCALE;

/**
 * The language the legal texts are shown in for someone whose screens are in `locale`: theirs when it is switched on
 * and a person has checked its legal texts, else English. `held` narrows it to the languages a text exists in (the
 * versions of the consent wording, for example). A draft is never chosen.
 */
export function legalLocale(locale: unknown, held?: string[], langs: Language[] = SUPPORTED_LOCALES): string {
  for (const x of fallbackChain(uiLocale(locale, langs))) {
    const l = languageOf(x, langs);
    if (l?.shipped && l.legal === 'reviewed' && (!held || held.includes(x))) return x;
  }
  return SOURCE_LOCALE;
}

/**
 * The one sentence, in the person's own language, shown with a legal text that is in English because their
 * language's translation of it has not been checked by a person. Empty when the legal text is in their language.
 */
export function legalNote(locale: unknown, held?: string[], langs: Language[] = SUPPORTED_LOCALES, cats: Record<string, Catalogue> = CATALOGUES): string {
  const ui = uiLocale(locale, langs);
  return primary(legalLocale(locale, held, langs)) === primary(ui) ? '' : translate(cats, ui, 'legal.in_english');
}
