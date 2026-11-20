// Languages: the catalogue and its parser (src/lib/i18n.ts, src/locales/*.json), which language each person sees,
// the rule for legal texts, what the audit trail records, the sender's choice through the editor, the API, templates,
// bulk sends and public forms, dates and numbers by language, and the check translators run (scripts/i18n-check.mjs).
// Only English is switched on. Where a test needs a second language it uses a table and catalogues of its own: the
// functions take them as arguments, so nothing here pretends a language ships.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  t, translate, parseMessage, placeholders, formatMessage, fallbackChain, dir, normalizeLocale, browserLocales, browserLocale, chooseLocale,
  uiLocale, legalLocale, legalNote, languageWords, shippedLocales, isShipped, SUPPORTED_LOCALES, CATALOGUES, SOURCE_LOCALE, type Language,
} from '../src/lib/i18n.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const en = JSON.parse(read('src/locales/en.json'));
// A table where French and Brazilian Portuguese are switched on, for the tests that need more than English.
const MORE: Language[] = [
  { tag: 'en', english: 'English', own: 'English', ui: 'reviewed', legal: 'reviewed', shipped: true },
  { tag: 'fr', english: 'French', own: 'Français', ui: 'reviewed', legal: 'draft', shipped: true },
  { tag: 'pt', english: 'Portuguese', own: 'Português', ui: 'reviewed', legal: 'reviewed', shipped: true },
  { tag: 'pt-BR', english: 'Portuguese (Brazil)', own: 'Português (Brasil)', ui: 'draft', legal: 'missing', shipped: true },
  { tag: 'de', english: 'German', own: 'Deutsch', ui: 'reviewed', legal: 'reviewed', shipped: false },
];

// ---- 1. The catalogue, its parser, plurals, the fallback chain and the direction of writing -----------------------

test('a text is read by our own parser: placeholders, plurals with #, exact numbers, and nothing that runs', () => {
  assert.equal(formatMessage('Hello {name}, welcome.', 'en', { name: 'Ada' }), 'Hello Ada, welcome.');
  assert.equal(formatMessage('{ name }!', 'en', { name: 'Ada' }), 'Ada!', 'space inside the braces is allowed');
  assert.equal(formatMessage('{count, plural, =0 {No days} one {# day} other {# days}} left', 'en', { count: 0 }), 'No days left');
  assert.equal(formatMessage('{count, plural, =0 {No days} one {# day} other {# days}} left', 'en', { count: 1 }), '1 day left');
  assert.equal(formatMessage('{count, plural, one {# day} other {# days}} for {name}', 'en', { count: 1234, name: 'Ben' }), '1,234 days for Ben', 'the number is written the language\'s way');
  assert.equal(formatMessage('{count, plural, one {# jour} other {# jours}}', 'fr', { count: 1234 }), '1 234 jours');
  // A placeholder inside a branch, and a plural inside a plural.
  assert.equal(formatMessage('{n, plural, one {{who} signed} other {{who} and # others signed}}', 'en', { n: 3, who: 'Ada' }), 'Ada and 3 others signed');
  assert.equal(formatMessage('{a, plural, one {{b, plural, one {x#} other {y#}}} other {z}}', 'en', { a: 1, b: 2 }), 'y2');
  // # outside a plural is a plain character; apostrophes are plain characters.
  assert.equal(formatMessage("Order #12 isn't {what}", 'en', { what: 'here' }), "Order #12 isn't here");
  // A value is text, whatever it looks like: markup and braces in a value are shown as they are, never read.
  assert.equal(formatMessage('Hi {name}', 'en', { name: '<b>{x}</b> ${process}' }), 'Hi <b>{x}</b> ${process}');
  assert.equal(formatMessage('Hi {name}', 'en', {}), 'Hi ', 'a value that is not given is empty, never the name');
  assert.equal(formatMessage('{n, plural, one {#} other {many}}', 'en', { n: 'lots' }), 'many', 'a value that is not a number takes "other"');
  // Texts that do not read are refused with where, and formatMessage gives null instead of throwing.
  for (const [bad, why] of [['Hi {name', /name/], ['Hi name}', /without a \{/], ['{}', /name of a placeholder/], ['{1x}', /name of a placeholder/],
    ['{n, select, a {x} other {y}}', /only be "plural"/], ['{n, plural, one {x}}', /"other"/], ['{n, plural, one {x} one {y} other {z}}', /twice/],
    ['{n, plural, some {x} other {y}}', /not a plural branch/], ['{n, plural, other {x}', /\}/], ['{n plural}', /plural/],
    ['{a, plural, other {{b, plural, other {{c, plural, other {{d, plural, other {x}}}}}}}}', /three deep/]] as [string, RegExp][]) {
    assert.throws(() => parseMessage(bad), why, bad);
    assert.equal(formatMessage(bad, 'en', { name: 'x', n: 1 }), null, bad);
  }
  assert.deepEqual(placeholders(parseMessage('{a} {n, plural, one {{b}} other {# {c}}}')), ['a', 'b', 'c', 'n']);
  // Ethiopic script and right-to-left text are just text to the parser.
  assert.equal(formatMessage('ሰላም {name}፣ {n, plural, one {# ሰነድ} other {# ሰነዶች}}', 'am', { name: 'ኣበበ', n: 2 }), 'ሰላም ኣበበ፣ 2 ሰነዶች');
  assert.equal(formatMessage('مرحبا {name}', 'ar', { name: 'سارة' }), 'مرحبا سارة');
});

test('plural branches follow each language\'s rules: English, French, Arabic and Russian', () => {
  const pick = (locale: string, n: number) => formatMessage('{n, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}', locale, { n });
  for (const [n, want] of [[0, 'other'], [1, 'one'], [2, 'other'], [1.5, 'other'], [21, 'other']] as const) assert.equal(pick('en', n), want, `en ${n}`);
  // French: 0 and 1 are "one", and so is 1.5.
  for (const [n, want] of [[0, 'one'], [1, 'one'], [1.5, 'one'], [2, 'other'], [1_000_000, 'many']] as const) assert.equal(pick('fr', n), want, `fr ${n}`);
  // Arabic has all six.
  for (const [n, want] of [[0, 'zero'], [1, 'one'], [2, 'two'], [3, 'few'], [10, 'few'], [11, 'many'], [99, 'many'], [100, 'other'], [102, 'other'], [103, 'few']] as const) assert.equal(pick('ar', n), want, `ar ${n}`);
  // Russian: 1, 21 and 101 are "one", 2 to 4 "few", 5 to 20 "many", a fraction "other".
  for (const [n, want] of [[1, 'one'], [21, 'one'], [101, 'one'], [2, 'few'], [4, 'few'], [22, 'few'], [5, 'many'], [11, 'many'], [20, 'many'], [1.5, 'other']] as const) assert.equal(pick('ru', n), want, `ru ${n}`);
  // A branch the language does not have falls to "other", an exact number comes first.
  assert.equal(formatMessage('{n, plural, one {a} other {b}}', 'ru', { n: 3 }), 'b');
  assert.equal(formatMessage('{n, plural, =1 {exactly} one {one} other {other}}', 'ru', { n: 1 }), 'exactly');
});

test('the fallback chain goes from the person\'s language to the language without its region to English', () => {
  assert.deepEqual(fallbackChain('pt-BR'), ['pt-BR', 'pt', 'en']);
  assert.deepEqual(fallbackChain('pt_br'), ['pt-BR', 'pt', 'en'], 'written another way, the same language');
  assert.deepEqual(fallbackChain('zh-Hant-TW'), ['zh-Hant-TW', 'zh-Hant', 'zh', 'en']);
  assert.deepEqual(fallbackChain('am-ET-u-ca-ethiopic'), ['am-ET', 'am', 'en'], 'how to write dates is not a language');
  assert.deepEqual(fallbackChain('en-GB'), ['en-GB', 'en']);
  for (const nothing of [undefined, null, '', 'x', 'not a language', '../en', '__proto__', 'constructor', 42, {}, 'a'.repeat(40)]) assert.deepEqual(fallbackChain(nothing), ['en'], String(nothing));
  assert.equal(normalizeLocale('EN'), 'en');
  assert.equal(normalizeLocale('iw'), 'he', 'the old code for Hebrew is Hebrew');

  const cats = {
    en: { 'a.k': 'Finish', 'a.n': '{n, plural, one {# signature} other {# signatures}}', 'a.only': 'Only English', 'a.broken': 'Hello {name}' },
    pt: { 'a.k': 'Concluir', 'a.n': '{n, plural, one {# assinatura} other {# assinaturas}}', 'a.only': '' },
    'pt-BR': { 'a.k': 'Finalizar', 'a.broken': 'Olá {name' },
  };
  assert.equal(translate(cats, 'pt-BR', 'a.k'), 'Finalizar');
  assert.equal(translate(cats, 'pt-BR', 'a.n', { n: 2 }), '2 assinaturas', 'pt-BR has none, pt has it');
  assert.equal(translate(cats, 'pt-PT', 'a.k'), 'Concluir');
  assert.equal(translate(cats, 'pt-BR', 'a.only'), 'Only English', 'an empty text is marked missing and English is shown');
  assert.equal(translate(cats, 'pt-BR', 'a.broken', { name: 'Ana' }), 'Hello Ana', 'a translation that does not read is passed over');
  assert.equal(translate(cats, 'de', 'a.n', { n: 1 }), '1 signature');
  // The plural rules of the text that was found: an English fallback reads as English, not with French rules.
  assert.equal(translate({ en: { k: '{n, plural, one {# item} other {# items}}' } }, 'fr', 'k', { n: 0 }), '0 items');
});

test('a missing key falls back to English and never shows the key', () => {
  const cats = { en: { here: 'Here' }, fr: {} };
  assert.equal(translate(cats, 'fr', 'here'), 'Here');
  assert.equal(translate(cats, 'fr', 'not.anywhere'), '', 'nothing, rather than "not.anywhere"');
  assert.equal(translate(cats, 'fr', 'constructor'), '');
  assert.equal(translate(cats, 'fr', '__proto__'), '');
  assert.equal(t('en', 'no.such.key'), '');
  assert.equal(t('fr-CA', 'legal.in_english'), en['legal.in_english'], 'a language that is not switched on reads English');
  // Every key the code asks for is in en.json, so the empty answer above never reaches a screen.
  const used = new Set<string>();
  const walk = (d: string) => {
    for (const f of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(d, f.name));
      else if (/\.(ts|tsx)$/.test(f.name)) for (const m of read(path.join(d, f.name)).matchAll(/\bt\([^,()]+, '([a-z0-9_.]+)'/g)) used.add(m[1]);
    }
  };
  walk('src');
  for (const k of used) assert.ok(typeof en[k] === 'string' && en[k] !== '', `${k} is used in src/ and is not in en.json`);
});

test('right to left for Arabic, Hebrew, Persian and Urdu, left to right for the rest', () => {
  for (const x of ['ar', 'ar-EG', 'he', 'he-IL', 'iw', 'fa', 'fa-IR', 'ur', 'ur-PK', 'az-Arab']) assert.equal(dir(x), 'rtl', x);
  for (const x of ['en', 'fr', 'am', 'am-ET', 'om', 'ti', 'ru', 'zh-Hant', 'ar-Latn', '', undefined, 'nonsense!']) assert.equal(dir(x), 'ltr', String(x));
});

// ---- 2. Which languages exist, and where each translation stands -------------------------------------------------

test('only English is switched on, every language has a status for its screens and its legal texts, and Ethiopia\'s two are there', () => {
  assert.deepEqual(shippedLocales(), ['en']);
  assert.equal(SOURCE_LOCALE, 'en');
  const statuses = ['reviewed', 'draft', 'missing'];
  for (const l of SUPPORTED_LOCALES) {
    assert.equal(normalizeLocale(l.tag), l.tag, `${l.tag} is written the standard way`);
    assert.ok(statuses.includes(l.ui) && statuses.includes(l.legal), l.tag);
    assert.ok(l.english && l.own, l.tag);
    // A language that is switched on has a catalogue in this build and words a person can read.
    if (l.shipped) assert.ok(CATALOGUES[l.tag] && l.ui !== 'missing', `${l.tag} is switched on without a catalogue`);
  }
  assert.equal(new Set(SUPPORTED_LOCALES.map((l) => l.tag)).size, SUPPORTED_LOCALES.length);
  const am = SUPPORTED_LOCALES.find((l) => l.tag === 'am')!, om = SUPPORTED_LOCALES.find((l) => l.tag === 'om')!;
  assert.match(am.own, /^[ሀ-፿]+$/u, 'Amharic is named in Ethiopic script');
  assert.equal(om.own, 'Afaan Oromoo');
  assert.equal(am.shipped || om.shipped, false, 'no translation yet: the Ethiopia batch adds them, checked by a person');
  assert.equal(isShipped('EN'), true);
  assert.equal(isShipped('fr'), false);
  assert.equal(languageWords('en'), 'English (en)');
  assert.equal(languageWords('am'), 'Amharic (am)');
  // The English catalogue is flat text, every text reads, and none holds markup or a link.
  for (const [k, v] of Object.entries(en)) {
    assert.ok(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(k), `${k} is a dotted key`);
    assert.equal(typeof v, 'string', k);
    assert.ok(parseMessage(v as string), k);
    assert.doesNotMatch(v as string, /<[a-z/!]|https?:|www\.|—/i, k);
  }
});

test('a language whose legal texts no person has checked shows them in English; a draft is never used for them', () => {
  // With French switched on but its legal texts a machine draft: the screens are French, the legal texts English.
  assert.equal(uiLocale('fr-CA', MORE), 'fr');
  assert.equal(legalLocale('fr-CA', undefined, MORE), 'en');
  // Portuguese has checked legal texts: pt-BR, whose own are missing, gets Portugal's checked ones, not English.
  assert.equal(uiLocale('pt-BR', MORE), 'pt-BR');
  assert.equal(legalLocale('pt-BR', undefined, MORE), 'pt');
  // ...unless the text in question does not exist in Portuguese (`held`), then English.
  assert.equal(legalLocale('pt-BR', ['en'], MORE), 'en');
  // German is checked but not switched on: its screens and legal texts are English.
  assert.equal(uiLocale('de', MORE), 'en');
  assert.equal(legalLocale('de', undefined, MORE), 'en');
});
