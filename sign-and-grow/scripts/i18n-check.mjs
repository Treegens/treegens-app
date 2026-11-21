// npm run i18n:check [folder]
//
// Checks the catalogues in src/locales (or the folder given) against en.json, the source of every text:
//   - every key of en.json is in each catalogue, translated or marked missing with "" (a text that is "" shows the
//     English one), and a catalogue has no key that en.json does not have;
//   - every text reads (the placeholders {name} and {count, plural, one {...} other {...}} of src/lib/i18n.ts), and a
//     translation has exactly the placeholders of its English text;
//   - a translation keeps every plural of its English text as a plural, with every branch its own language needs
//     (Russian: one, few, many, other), so no number is ever read with the wrong word;
//   - no key is written twice in one file (the second would silently win);
//   - no text holds HTML, an entity, a link or a web address of any country, nor "javascript:" and the like:
//     catalogues are plain words, and links belong in the code;
//   - no text holds an invisible control character or one that turns the reading direction around (U+202E and the
//     like), which can make a sentence read as something else, and no em dash;
//   - a warning, not an error, when a button (a key with "button" in it) is more than 40 percent longer than the
//     English one, or when any other short text (24 characters or fewer in English: a label, a tab, a heading, a
//     button not named so) is more than 40 percent longer and over 20 characters, because it may not fit on a phone.
// It prints what it found, a line per catalogue saying how much is translated, and ends with exit code 1 when there is
// an error, so it can stand in CI. It reads the same parser the app uses, so the two cannot disagree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMessage, placeholders, normalizeLocale, SUPPORTED_LOCALES } from '../src/lib/i18n.ts';

const MARKUP = /<\/?[a-z!][^>]*>|&[a-z]+;|&#x?[0-9a-f]+;/i;
// An address with a scheme, a scheme a browser would run or open, or a name with a dot and an ending in any script
// (exemple.fr, example.co.uk, пример.рф). A file name (signed.pdf, audit-trail.txt) is not an address.
const LINK = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b(?:javascript|vbscript|mailto):|\bdata:[a-z]+\/|(?<![\p{L}\p{N}@.-])[\p{L}\p{N}-]+\.(?!(?:pdf|csv|txt|json|zip|png|jpe?g|html?|docx?|xlsx?)(?![\p{L}\p{N}]))\p{L}{2,24}(?![\p{L}\p{N}])/iu;
// Control characters, and the characters that override or embed a reading direction (U+202A to U+202E, U+2066 to
// U+2069). The marks a right-to-left text may need (U+200E, U+200F, U+061C) and the joiners are fine.
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/;
const codeOf = (text) => 'U+' + text.match(HIDDEN)[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
const STRETCH = 1.4;
const SHORT = 24;
// A short text that is still this short after translation fits wherever the English one did.
const ROOMY = 20;
const isButton = (key) => key.split('.').some((part) => /button/.test(part));
const chars = (s) => [...s].length;

/** The keys of a flat JSON object as they are written in the file, repeats included (JSON.parse keeps only the last). */
export function keysAsWritten(raw) {
  const keys = [];
  const string = /"(?:[^"\\]|\\.)*"/gy;
  let i = 0;
  let depth = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      string.lastIndex = i;
      const m = string.exec(raw);
      if (!m) break;
      i = string.lastIndex;
      let j = i;
      while (/\s/.test(raw[j] || '')) j++;
      if (raw[j] === ':' && depth === 1) {
        try {
          keys.push(JSON.parse(m[0]));
        } catch {
          /* JSON.parse of the whole file says what is wrong */
        }
      }
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    i++;
  }
  return keys;
}

/** Every plural in a text that was read: the name it counts and the branches it has. */
function plurals(nodes, out = []) {
  for (const x of nodes) {
    if (typeof x === 'string' || 'hash' in x || 'v' in x) continue;
    out.push({ name: x.p, branches: Object.keys(x.b) });
    for (const b of Object.values(x.b)) plurals(b, out);
  }
  return out;
}
// The plural branches a language needs for the numbers people meet: the ones its rules give for 0 to 200 and a few
// fractions. (French and Spanish have a "many" that only a round million gets; without it "other" reads right.)
const categoriesOf = (tag) => {
  try {
    const rules = new Intl.PluralRules(tag);
    const met = new Set(['other']);
    for (let n = 0; n <= 200; n++) met.add(rules.select(n));
    for (const n of [0.5, 1.5, 2.5]) met.add(rules.select(n));
    return ['zero', 'one', 'two', 'few', 'many', 'other'].filter((c) => met.has(c));
  } catch {
    return ['other'];
  }
};

/** The check itself, for the script and for tests: { errors, warnings, summary }, each a list of lines. */
export function checkCatalogues(dir) {
  const errors = [];
  const warnings = [];
  const summary = [];
  const load = (file) => {
    let data;
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\ufeff/, '');
      data = JSON.parse(raw);
      const seen = new Set();
      for (const k of keysAsWritten(raw)) {
        if (seen.has(k)) errors.push(`${file}: "${k}" is written more than once. Only the last one would be used, without a word. Keep one.`);
        seen.add(k);
      }
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
      const nodes = parseMessage(text);
      const names = placeholders(nodes);
      names.plurals = plurals(nodes);
      return names;
    } catch (e) {
      errors.push(`${file}: "${key}" does not read: ${e.message}.`);
      return null;
    }
  };
  const plain = (file, key, text) => {
    if (MARKUP.test(text)) errors.push(`${file}: "${key}" holds HTML or an entity. Catalogues are plain words: say it in words, and leave links and formatting to the code.`);
    if (LINK.test(text)) errors.push(`${file}: "${key}" holds a link or a web address ("${text.match(LINK)[0]}"). Leave addresses to the code, which can check them.`);
    if (HIDDEN.test(text)) errors.push(`${file}: "${key}" holds an invisible character (${codeOf(text)}): a control character, or one that turns the reading direction around. It can make a sentence read as something else. Type the text again without it.`);
    if (/\u2014/.test(text)) errors.push(`${file}: "${key}" has an em dash. Use a colon, a comma or two sentences.`);
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
      if (got && want[k]) {
        // A plural stays a plural, with every branch this language needs: a missing one would be read as "other".
        const needs = categoriesOf(tag);
        for (const name of new Set(want[k].plurals.map((p) => p.name))) {
          const mine = got.plurals.filter((p) => p.name === name);
          if (!mine.length) errors.push(`${file}: "${k}" counts {${name}} with a plural in English ({${name}, plural, ...}), and here it is only {${name}} or not counted at all. Keep the plural, so 1 and 5 each get the right word.`);
          for (const p of mine) {
            const lacks = needs.filter((c) => !p.branches.includes(c));
            if (lacks.length) errors.push(`${file}: "${k}": the plural of {${name}} has the branches ${p.branches.join(', ')}, and this language (${tag}) also needs ${lacks.join(', ')}. Add ${lacks.length === 1 ? 'it' : 'them'}, or some numbers are read with the wrong word.`);
          }
        }
      }
      // Buttons, and every other short text: a label, a tab or a heading has as little room as a button.
      if ((isButton(k) || (chars(en[k]) <= SHORT && chars(text) > ROOMY)) && chars(text) > STRETCH * chars(en[k]))
        warnings.push(`${file}: "${k}" is ${isButton(k) ? 'a button' : 'a short text (a button, a label or a heading)'} and is ${Math.round((chars(text) / chars(en[k]) - 1) * 100)} percent longer than in English (${chars(text)} characters against ${chars(en[k])}). Check that it fits on a phone, or find a shorter word.`);
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
