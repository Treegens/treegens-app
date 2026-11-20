// npm run i18n:check [folder]
//
// Checks the catalogues in src/locales (or the folder given) against en.json, the source of every text:
//   - every key of en.json is in each catalogue, translated or marked missing with "" (a text that is "" shows the
//     English one), and a catalogue has no key that en.json does not have;
//   - every text reads (the placeholders {name} and {count, plural, one {...} other {...}} of src/lib/i18n.ts), and a
//     translation has exactly the placeholders of its English text;
//   - no text holds HTML, an entity or a link: catalogues are plain words, and links belong in the code;
//   - a warning, not an error, when a button's text is more than 40 percent longer than the English one, because it
//     may not fit on a phone.
// It prints what it found, a line per catalogue saying how much is translated, and ends with exit code 1 when there is
// an error, so it can stand in CI. It reads the same parser the app uses, so the two cannot disagree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMessage, placeholders, normalizeLocale, SUPPORTED_LOCALES } from '../src/lib/i18n.ts';

const MARKUP = /<\/?[a-z!][^>]*>|&[a-z]+;|&#x?[0-9a-f]+;/i;
const LINK = /\b(?:https?:\/\/|www\.|mailto:)|\b[a-z0-9-]+\.(?:com|org|net|app|io)\b/i;
const BUTTON_STRETCH = 1.4;
const isButton = (key) => key.split('.').some((part) => /button/.test(part));
const chars = (s) => [...s].length;

/** The check itself, for the script and for tests: { errors, warnings, summary }, each a list of lines. */
export function checkCatalogues(dir) {
  const errors = [];
  const warnings = [];
  const summary = [];
  const load = (file) => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (e) {
      errors.push(`${file}: this is not JSON that can be read (${e.message}).`);
      return null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      errors.push(`${file}: a catalogue is one object of "key": "text" pairs.`);
      return null;
    }
    for (const [k, v] of Object.entries(data)) {
      if (typeof v !== 'string') {
        errors.push(`${file}: "${k}" holds ${Array.isArray(v) ? 'a list' : v === null ? 'null' : typeof v === 'object' ? 'an object' : `a ${typeof v}`}. Every value is a text, and keys are flat: write "a.b": "...", not "a": {"b": "..."}.`);
        delete data[k];
      }
    }
    return data;
  };
  const read = (file, key, text) => {
    try {
      return placeholders(parseMessage(text));
    } catch (e) {
      errors.push(`${file}: "${key}" does not read: ${e.message}.`);
      return null;
    }
  };
  const plain = (file, key, text) => {
    if (MARKUP.test(text)) errors.push(`${file}: "${key}" holds HTML or an entity. Catalogues are plain words: say it in words, and leave links and formatting to the code.`);
    if (LINK.test(text)) errors.push(`${file}: "${key}" holds a link or a web address. Leave addresses to the code, which can check them.`);
  };

  if (!fs.existsSync(path.join(dir, 'en.json'))) {
    errors.push(`${dir}: there is no en.json, the source every other catalogue is checked against.`);
    return { errors, warnings, summary };
  }
  const en = load('en.json');
  if (!en) return { errors, warnings, summary };
  const want = {};
  for (const [k, v] of Object.entries(en)) {
    if (v === '') errors.push(`en.json: "${k}" is empty. English is the source: every key needs its English text.`);
    if (/\u2014/.test(v)) errors.push(`en.json: "${k}" has an em dash. Use a colon, a comma or two sentences.`);
    plain('en.json', k, v);
    want[k] = read('en.json', k, v);
  }
  const keys = Object.keys(en);
  summary.push(`en: ${keys.length} texts, the source.`);

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'en.json').sort()) {
    const tag = file.slice(0, -5);
    if (normalizeLocale(tag) !== tag) {
      errors.push(`${file}: the name must be a language code written the standard way, like fr.json or pt-BR.json${normalizeLocale(tag) ? ` (here: ${normalizeLocale(tag)}.json)` : ''}.`);
      continue;
    }
    if (!SUPPORTED_LOCALES.some((l) => l.tag === tag)) warnings.push(`${file}: ${tag} is not listed in SUPPORTED_LOCALES (src/lib/i18n.ts), so nothing uses it yet.`);
    const cat = load(file);
    if (!cat) continue;
    let done = 0;
    for (const k of keys) {
      if (!Object.hasOwn(cat, k)) {
        errors.push(`${file}: "${k}" is missing. Add it, with "" while it is not translated, so it is marked missing.`);
        continue;
      }
      const text = cat[k];
      if (text === '') continue;
      done++;
      plain(file, k, text);
      const got = read(file, k, text);
      if (got && want[k] && got.join() !== want[k].join())
        errors.push(`${file}: "${k}" has the placeholders ${got.length ? got.map((x) => `{${x}}`).join(', ') : 'none'}, and the English text has ${want[k].length ? want[k].map((x) => `{${x}}`).join(', ') : 'none'}. Keep exactly the ones in English, with the same names.`);
      if (isButton(k) && chars(text) > BUTTON_STRETCH * chars(en[k]))
        warnings.push(`${file}: "${k}" is a button and is ${Math.round((chars(text) / chars(en[k]) - 1) * 100)} percent longer than in English (${chars(text)} characters against ${chars(en[k])}). Check that it fits on a phone, or find a shorter word.`);
    }
    for (const k of Object.keys(cat)) if (!Object.hasOwn(en, k)) errors.push(`${file}: "${k}" is not in en.json. Remove it: the English key may have been renamed or taken out.`);
    summary.push(`${tag}: ${done} of ${keys.length} translated, ${keys.length - done} marked missing (shown in English).`);
  }
  return { errors, warnings, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales'));
  const { errors, warnings, summary } = checkCatalogues(dir);
  for (const e of errors) console.log(`error: ${e}`);
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const s of summary) console.log(s);
  console.log(errors.length ? `${errors.length} error${errors.length === 1 ? '' : 's'}. Fix ${errors.length === 1 ? 'it' : 'them'} and run npm run i18n:check again.` : `No errors${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}.`);
  process.exitCode = errors.length ? 1 : 0;
}
