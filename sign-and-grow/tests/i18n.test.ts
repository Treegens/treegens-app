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
import { boot, Client, simple, signUp, tokenFor, type Server } from './helpers.ts';
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
    assert.doesNotMatch(v as string, /<[a-z/!]|https?:|www\.|\u2014/i, k);
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

// ---- 3. Which language a person sees ------------------------------------------------------------------------------

let db: Server['db'];
let ada: Client;
before(async () => {
  ({ db } = await boot());
  ada = await signUp('Ada Sender', 'ada.lang@example.com', '198.51.100.31');
});
const sent = async (email: string, over: any = {}) => {
  const e = await simple(ada, email, over);
  assert.equal((await ada.post(`/envelopes/${e.id}/send`)).status, 200);
  return e;
};
const auditOf = (id: string, action: string) => db.all('SELECT detail FROM audit WHERE envelope_id=? AND action=? ORDER BY seq', id, action).map((x: any) => x.detail as string);

test('the sender\'s choice first, then the browser among the languages switched on, then English', () => {
  assert.equal(chooseLocale({ chosen: 'fr', acceptLanguage: 'pt-BR' }, MORE), 'fr', 'the sender set it');
  assert.equal(chooseLocale({ chosen: 'de', acceptLanguage: 'pt-BR,fr;q=0.5' }, MORE), 'pt-BR', 'what the sender set is not switched on: the browser decides');
  assert.equal(chooseLocale({ acceptLanguage: 'fr-CA,en;q=0.5' }, MORE), 'fr', 'fr-CA is served by fr');
  assert.equal(chooseLocale({ acceptLanguage: 'pt-PT' }, MORE), 'pt');
  assert.equal(chooseLocale({ acceptLanguage: 'de-DE,de;q=0.9,fr;q=0.4' }, MORE), 'fr', 'German is not switched on, the next one the browser asks for is');
  assert.equal(chooseLocale({ acceptLanguage: 'en;q=0.2,fr;q=0.8' }, MORE), 'fr', 'by weight, not by order');
  assert.equal(chooseLocale({ acceptLanguage: 'de,ja' }, MORE), 'en', 'nothing it asks for: English');
  assert.equal(chooseLocale({ acceptLanguage: 'fr;q=0,*' }, MORE), 'en', 'q=0 means no, and * is not a language');
  for (const h of [undefined, '', ';;;,,,', 'q=1', `${'x-'.repeat(2000)}fr`, 'fr;q=abc', 42]) assert.equal(chooseLocale({ acceptLanguage: h }, MORE), 'en', String(h).slice(0, 20));
  assert.deepEqual(browserLocales('fr-CA,fr;q=0.8,en;q=0.5'), ['fr-CA', 'fr', 'en']);
  // A script is never swapped for another one of the same language.
  const zh: Language[] = [MORE[0], { tag: 'zh-Hans', english: 'Chinese (Simplified)', own: '简体中文', ui: 'reviewed', legal: 'missing', shipped: true }];
  assert.equal(chooseLocale({ acceptLanguage: 'zh-Hant-TW' }, zh), 'en', 'a Traditional Chinese reader is not given Simplified');
  assert.equal(chooseLocale({ acceptLanguage: 'zh-CN' }, zh), 'zh-Hans');
  // With the languages that really are switched on (English alone), every browser gets English.
  assert.equal(chooseLocale({ chosen: 'fr', acceptLanguage: 'fr-FR' }), 'en');
  assert.equal(browserLocale('am-ET,om;q=0.8'), null);
});

test('the signing page is told the language, its direction and who chose it; the sender\'s choice is kept on the recipient', async () => {
  const e = await sent('lang.page@example.com');
  const tok = tokenFor(e.id, 'lang.page@example.com');
  const look = (h: Record<string, string>) => new Client().call('GET', `/sign/${tok}`, undefined, h);
  let r = await look({ 'accept-language': 'fr-FR,fr;q=0.9' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.language, { locale: 'en', dir: 'ltr', set_by: 'default' }, 'French is not switched on: English, and nobody chose it');
  r = await look({ 'accept-language': 'en-GB' });
  assert.deepEqual(r.data.language, { locale: 'en', dir: 'ltr', set_by: 'browser' });
  db.run('UPDATE recipients SET locale=? WHERE envelope_id=?', 'en', e.id);
  r = await look({ 'accept-language': 'fr' });
  assert.deepEqual(r.data.language, { locale: 'en', dir: 'ltr', set_by: 'sender' });
  // A language stored before it was switched off is not used: the browser decides again.
  db.run('UPDATE recipients SET locale=? WHERE envelope_id=?', 'fr', e.id);
  r = await look({ 'accept-language': 'en-US' });
  assert.deepEqual(r.data.language, { locale: 'en', dir: 'ltr', set_by: 'browser' });
  // A page behind an access code is told its language too: the code screen is a screen.
  const locked = await sent('lang.locked@example.com', { recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: 'lang.locked@example.com', access_code: '4242' }] });
  r = await new Client().get(`/sign/${tokenFor(locked.id, 'lang.locked@example.com')}`);
  assert.equal(r.data.locked, true);
  assert.equal(r.data.language.locale, 'en');
});

// ---- 4. Legal texts: checked by a person in that language, or English with one sentence -------------------------

test('legal texts: in the person\'s language only once a person checked it, else English with one sentence in their language', async () => {
  const { consentWording, consentWordingAsRecorded, isConsentLanguage, CONSENT_VERSION, UNVERSIONED_CONSENT } = await import('../src/lib/policy.ts');
  const sentence = en['legal.in_english'];
  assert.equal(sentence, 'This part is in English because its translation has not yet been checked by a person.');
  // French switched on, its legal texts a machine draft: English legal text, the sentence in French.
  const fr = { 'legal.in_english': 'Cette partie est en anglais, car sa traduction n\'a pas encore été vérifiée par une personne.' };
  assert.equal(legalNote('fr-CA', undefined, MORE, { en, fr }), fr['legal.in_english']);
  assert.equal(legalNote('fr', undefined, MORE, { en }), sentence, 'a French catalogue without the sentence gives the English one, never nothing');
  assert.equal(legalNote('pt-BR', undefined, MORE), '', 'Portuguese legal texts were checked: no sentence');
  assert.equal(legalNote('pt-BR', ['en'], MORE), sentence, 'a text that exists only in English gets the sentence');
  assert.equal(legalNote('de', undefined, MORE), '', 'screens in English (German is off): nothing to explain');
  assert.equal(legalNote('en'), '');
  // Every version of the consent wording exists in English, and in no language a person has not checked.
  for (const v of [CONSENT_VERSION, UNVERSIONED_CONSENT]) {
    assert.equal(isConsentLanguage(v, 'en'), true, v);
    for (const l of SUPPORTED_LOCALES.filter((x) => x.legal !== 'reviewed')) assert.equal(isConsentLanguage(v, l.tag), false, `${v} ${l.tag}`);
  }
  assert.equal(isConsentLanguage('2019-01', 'en'), false);
  assert.equal(isConsentLanguage(CONSENT_VERSION, '__proto__'), false);
  // A screen in French today (not switched on) is shown the English wording, without the sentence (its screens are English).
  const w = consentWording('Ada Sender', true, CONSENT_VERSION, 'fr');
  assert.equal(w.language, 'en');
  assert.equal(w.note, '');
  assert.deepEqual(consentWording('Ada Sender', true), { ...w }, 'the same as asking without a language');
  // What an audit line recorded is read back in that language, even one that is not held: English then.
  assert.equal(consentWordingAsRecorded('Ada Sender', true, CONSENT_VERSION, 'en').legal, w.legal);
  assert.equal(consentWordingAsRecorded('Ada Sender', true, CONSENT_VERSION, 'xx').language, 'en');
});

test('the audit line records the wording and the language actually shown, and the evidence pack reads it back', async () => {
  const { consentLanguageOf, CONSENT_VERSION } = await import('../src/lib/policy.ts');
  const agree = async (email: string, body: any) => {
    const e = await sent(email);
    assert.equal((await new Client().post(`/sign/${tokenFor(e.id, email)}/consent`, body)).status, 200);
    return { e, line: auditOf(e.id, 'Agreed to electronic records and signatures')[0] };
  };
  const tail = 'as printed on the help page under "What do I agree to before I sign?".';
  // Today's signing page names the wording and no language: it shows English, and the line says so.
  let { line, e } = await agree('lang.c1@example.com', { wording: CONSENT_VERSION });
  assert.equal(line, `Sam Signer. Wording ${CONSENT_VERSION}, in English (en), ${tail}`);
  assert.equal(consentLanguageOf(line), 'en');
  ({ line } = await agree('lang.c2@example.com', { wording: CONSENT_VERSION, language: 'EN' }));
  assert.equal(line, `Sam Signer. Wording ${CONSENT_VERSION}, in English (en), ${tail}`, 'a language this wording exists in is written as it is');
  // A language the wording does not exist in is not believed, and is said to be one. Nothing the call sent is copied.
  for (const [i, language] of ['fr', 'am', '<b>x</b>', 'x'.repeat(500), 7, { a: 1 }].entries()) {
    ({ line } = await agree(`lang.c3${i}@example.com`, { wording: CONSENT_VERSION, language }));
    assert.equal(line, `Sam Signer. Wording ${CONSENT_VERSION}, in English (en), ${tail} The screen named a language this wording does not exist in, so this names the English wording.`, String(language));
    assert.equal(consentLanguageOf(line), 'en');
  }
  ({ line } = await agree('lang.c4@example.com', {}));
  assert.equal(line, `Sam Signer. The screen did not say which wording it showed. The wording in use was ${CONSENT_VERSION}, in English (en), ${tail}`);
  // Lines from before languages were recorded name none: they are read as English, which is all there was.
  assert.equal(consentLanguageOf('Sam Signer'), 'en');
  assert.equal(consentLanguageOf(`Sam Signer. Wording ${CONSENT_VERSION}, ${tail}`), 'en');
  assert.equal(consentLanguageOf(`Sam Signer. Wording ${CONSENT_VERSION}, in French (fr), ${tail}`), 'fr');
  // The evidence pack prints the words in the language the line names.
  const zip = Buffer.from((await ada.get(`/envelopes/${e.id}/evidence`)).data);
  assert.ok(zip.includes(Buffer.from('simple electronic signature')), 'the English words of the wording are in the pack');
});

// ---- 5. The sender's side: per recipient, the account's default, templates, bulk sends, public forms -----------

const localeOf = (envelopeId: string) => db.all('SELECT locale FROM recipients WHERE envelope_id=? ORDER BY position', envelopeId).map((x: any) => x.locale);

test('the API takes recipients[].locale, refuses a language that is not available in plain words, and saves nothing then', async () => {
  const before = db.get('SELECT COUNT(*) n FROM envelopes').n;
  const e = await simple(ada, 'lang.api@example.com', { recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: 'lang.api@example.com', locale: 'EN' }] });
  assert.deepEqual(localeOf(e.id), ['en'], 'written the standard way');
  assert.equal(e.recipients[0].locale, 'en', 'and returned');
  for (const [locale, why] of [['fr', /"fr", and that language is not available yet: our screens have not been translated into it and checked by a person\. Use one of: English \(en\), or leave it out so the person's browser decides\. Nothing was saved\./],
    ['am', /"am", and that language is not available yet/], ['english', /"english", which is not a language code\. Use a code like "en"/], ['<script>', /which is not a language code/], [42, /42, which is not a language code/], [['en'], /which is not a language code/]] as [any, RegExp][]) {
    const r = await ada.post('/envelopes', { subject: 'x', recipients: [{ name: 'Sam', email: 'lang.api@example.com', locale }] });
    assert.equal(r.status, 400, String(locale));
    assert.match(r.data.error, why);
    assert.match(r.data.error, /^The language \("locale"\) of recipient 1 \(Sam\) is /);
  }
  assert.equal(db.get('SELECT COUNT(*) n FROM envelopes').n, before + 1, 'none of the refused ones was made');
  // Left out on a save, a recipient keeps theirs; null or "" means their browser.
  const kept = await ada.put(`/envelopes/${e.id}`, { subject: 'Simple agreement again' });
  assert.equal(kept.status, 200);
  assert.deepEqual(localeOf(e.id), ['en']);
  assert.equal((await ada.put(`/envelopes/${e.id}`, { recipients: [{ id: e.recipients[0].id, role: 'signer', name: 'Sam Signer', email: 'lang.api@example.com' }] })).status, 200);
  assert.deepEqual(localeOf(e.id), ['en'], 'a full list without "locale" keeps it too');
  assert.equal((await ada.put(`/envelopes/${e.id}`, { recipients: [{ id: e.recipients[0].id, role: 'signer', name: 'Sam Signer', email: 'lang.api@example.com', locale: null }] })).status, 200);
  assert.deepEqual(localeOf(e.id), [null]);
  // A language stored before it was switched off does not stop an honest save that sends it back unchanged...
  db.run("UPDATE recipients SET locale='fr' WHERE envelope_id=?", e.id);
  const back = await ada.put(`/envelopes/${e.id}`, { subject: 'Still saves', recipients: [{ id: e.recipients[0].id, role: 'signer', name: 'Sam Signer', email: 'lang.api@example.com', locale: 'fr' }] });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.deepEqual(localeOf(e.id), ['fr']);
  // ...but it cannot be given to someone else, or be chosen anew.
  const other = await ada.put(`/envelopes/${e.id}`, { recipients: [{ id: e.recipients[0].id, role: 'signer', name: 'Sam Signer', email: 'lang.api@example.com', locale: 'fr' }, { role: 'signer', name: 'New One', email: 'lang.new@example.com', locale: 'fr' }] });
  assert.equal(other.status, 400);
  assert.match(other.data.error, /recipient 2 \(New One\)/);
  // The description of the API says all of it.
  const spec = (await new Client().get('/openapi.json')).data;
  const rcp = JSON.stringify(spec.components.schemas);
  assert.match(rcp, /"locale":\{"type":"string","nullable":true,"description":"The language of our screens for this person/);
  assert.match(rcp, /never translated/);
  assert.ok(spec.paths['/account'].patch.description.includes('default_locale'));
  assert.match(JSON.stringify(spec.paths['/bulk']), /"language":\{"type":"string","description":"The language for that person/);
});

test('the account default: set by an admin, refused when not available (and nothing else changed), given to new recipients', async () => {
  const bea = await signUp('Bea Admin', 'bea.lang@example.com', '198.51.100.32');
  assert.equal((await bea.get('/me')).data.account.default_locale, null);
  const no = await bea.call('PATCH', '/account', { default_locale: 'fr', default_date_format: 'D MMM YYYY' });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /^The default language \("default_locale"\) is "fr", and that language is not available yet.*Nothing was changed\.$/);
  assert.equal((await bea.get('/me')).data.account.default_date_format, null, 'the date format in the same call was not saved either');
  assert.equal((await bea.call('PATCH', '/account', { default_locale: 'en' })).status, 200);
  assert.equal((await bea.get('/me')).data.account.default_locale, 'en');
  // A new recipient that names no language gets it; one that says null keeps null; a saved one keeps its own.
  const e = await simple(bea, 'lang.def@example.com', { recipients: [{ id: 'r', role: 'signer', name: 'A', email: 'lang.def@example.com' }, { id: 'b', role: 'cc', name: 'B', email: 'lang.def2@example.com', locale: null }] });
  assert.deepEqual(localeOf(e.id), ['en', null]);
  assert.equal((await bea.call('PATCH', '/account', { default_locale: '' })).status, 200);
  assert.equal((await bea.get('/me')).data.account.default_locale, null);
  // A default stored before its language was switched off is not handed out, and /me does not claim it.
  db.run("UPDATE accounts SET default_locale='fr' WHERE id=(SELECT account_id FROM envelopes WHERE id=?)", e.id);
  assert.equal((await bea.get('/me')).data.account.default_locale, null);
  const e2 = await simple(bea, 'lang.def3@example.com');
  assert.deepEqual(localeOf(e2.id), [null]);
  // Only admins change it (the same rule as every account setting).
  const mem = await signUp('Mo Member', 'mo.lang@example.com', '198.51.100.33');
  assert.equal((await bea.post('/account/invites', { email: 'mo.lang@example.com', role: 'member' })).status, 200);
  const tok = db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL', 'mo.lang@example.com').token;
  assert.equal((await mem.post('/invites/accept', { token: tok })).status, 200);
  const asMember = await mem.call('PATCH', '/account', { default_locale: 'en' });
  assert.equal(asMember.status, 403);
});

test('templates keep the language, a copy keeps it, using a template can set it per role, a bulk row sets it with "language"', async () => {
  const tpl = await simple(ada, '', { kind: 'template', subject: 'Lang template', recipients: [{ id: 'r', role: 'signer', role_name: 'Member', locale: 'en' }] });
  assert.deepEqual(localeOf(tpl.id), ['en']);
  const used = await ada.post('/envelopes', { template_id: tpl.id, recipients: { Member: { name: 'Mia Member', email: 'lang.tpl@example.com' } } });
  assert.equal(used.status, 200, JSON.stringify(used.data));
  assert.deepEqual(localeOf(used.data.envelope.id), ['en'], 'the template\'s language');
  const set = await ada.post('/envelopes', { template_id: tpl.id, recipients: { Member: { name: 'Mia Member', email: 'lang.tpl@example.com', locale: null } } });
  assert.deepEqual(localeOf(set.data.envelope.id), [null], 'a role filled in with locale null: their browser');
  const bad = await ada.post('/envelopes', { template_id: tpl.id, recipients: { Member: { name: 'Mia Member', email: 'lang.tpl@example.com', locale: 'fr' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /The language for Member is "fr", and that language is not available yet.*Nothing was made\./);
  const copy = await ada.post(`/envelopes/${used.data.envelope.id}/clone`, {});
  assert.equal(copy.status, 200);
  assert.deepEqual(localeOf(copy.data.id), ['en'], 'a copy keeps it');

  // Bulk: a row's "language" for a role; one that is not available refuses the whole batch, here and in the check.
  const plain = await simple(ada, '', { kind: 'template', subject: 'Lang bulk', recipients: [{ id: 'r', role: 'signer', role_name: 'Member' }] });
  const rows = [{ Member: { name: 'Row One', email: 'lang.row1@example.com', language: 'en' } }, { Member: { name: 'Row Two', email: 'lang.row2@example.com' } }];
  const batches = db.get('SELECT COUNT(*) n FROM bulk_batches').n;
  const wrong = [...rows, { Member: { name: 'Row Three', email: 'lang.row3@example.com', language: 'fr' } }];
  const check = await ada.post('/bulk/check', { template_id: plain.id, rows: wrong });
  assert.equal(check.status, 200);
  assert.equal(check.data.refusal.status, 400);
  assert.match(check.data.refusal.message, /^Row 3: the "language" of "Member" is "fr", and that language is not available yet.*Nothing was sent\.$/);
  const refused = await ada.post('/bulk', { template_id: plain.id, rows: wrong });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error, check.data.refusal.message, 'the check and the send say the same');
  assert.equal(db.get('SELECT COUNT(*) n FROM bulk_batches').n, batches, 'nothing was written');
  const ok = await ada.post('/bulk', { template_id: plain.id, rows });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const made = db.all('SELECT r.email, r.locale FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE e.bulk_id=? ORDER BY r.email', ok.data.id);
  assert.deepEqual(made, [{ email: 'lang.row1@example.com', locale: 'en' }, { email: 'lang.row2@example.com', locale: null }]);
});

test('a public form takes the visitor\'s browser language, else the template\'s for that role', async () => {
  const pf = await signUp('Pia Forms', 'pia.lang@example.com', '198.51.100.34');
  const tpl = await simple(pf, '', { kind: 'template', subject: 'Lang form', recipients: [{ id: 'r', role: 'signer', role_name: 'Walker' }] });
  assert.equal((await pf.post('/powerforms', { template_id: tpl.id, name: 'Walk in' })).status, 200);
  const slug = (await pf.get('/powerforms')).data.powerforms[0].slug;
  const start = async (i: number, lang?: string) => {
    const v = new Client();
    v.ip = `192.0.2.${100 + i}`;
    const r = await v.call('POST', `/public/powerforms/${slug}/start`, { name: `Walk In ${i}`, email: `lang.walk${i}@example.com` }, lang ? { 'accept-language': lang } : {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return db.get("SELECT r.locale FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE e.powerform_id IS NOT NULL AND r.email=?", `lang.walk${i}@example.com`).locale;
  };
  assert.equal(await start(1, 'en-GB,en;q=0.9'), 'en', 'their browser asked for English');
  assert.equal(await start(2, 'fr-FR'), null, 'French is not available: nothing set, the page decides from the browser');
  assert.equal(await start(3), null);
  db.run("UPDATE recipients SET locale='en' WHERE envelope_id=?", tpl.id);
  assert.equal(await start(4, 'de'), 'en', 'the template\'s language for the role, when the browser asks for none we have');
});

test('the bulk list reads a "language" column, takes a code or a name, and leaves out a language we do not have with a note', async () => {
  const { readRecipients } = await import('../src/components/sender/csv.ts');
  const roles = [{ key: 'Member', label: 'Member' }];
  const r = readRecipients('Name,Email,Language\nAda One,ada1@example.org,English\nBen Two,ben2@example.org,en-GB\nCee Three,cee3@example.org,Français\nDee Four,dee4@example.org,\n', roles);
  assert.deepEqual(r.ignored, [], 'the column is read, not ignored');
  assert.equal(r.rows[0].cells.Member.language, 'en');
  assert.equal(r.rows[1].cells.Member.language, undefined, 'en-GB is not a language of its own here');
  assert.deepEqual(r.rows[1].notes, ['the language "en-GB" is not available yet, so it is left out: this person sees their browser\'s language if we have it, otherwise English']);
  assert.equal(r.rows[2].cells.Member.language, undefined);
  assert.match(r.rows[2].notes[0], /"Français" is not available yet/);
  assert.deepEqual(r.rows.map((x) => x.problems.length), [0, 0, 0, 0], 'a language is never a reason to stop a row');
  assert.equal(r.rows[3].cells.Member.language, undefined);
  // Two roles: the column is named after its role.
  const two = readRecipients('Client name,Client email,Client language,Agent name,Agent email\nA,a@example.org,en,B,b@example.org\n', [{ key: 'Client', label: 'Client' }, { key: 'Agent', label: 'Agent' }]);
  assert.equal(two.rows[0].cells.Client.language, 'en');
  assert.equal(two.rows[0].cells.Agent.language, undefined);
});

test('the editor and Settings offer a language only when there is more than one to choose; nothing a sender writes is translated', () => {
  const stepAdd = read('src/components/editor/StepAdd.tsx');
  // (simplify-editor: the language is a line of the person's More, listed only with 2 or more languages.)
  assert.match(stepAdd, /<PersonMore ed=\{ed\} r=\{r\} \/>/);
  assert.match(read('src/components/editor/PersonMore.tsx'), /if \(key === 'language'\) return <RecipientLanguage value=\{r\.locale\} who=\{name\} onChange=\{patch\} \/>;/);
  assert.match(read('src/lib/editorux.ts'), /if \(\(o\.languages \|\| 1\) >= 2\) lines\.push\(\{ key: 'language'/);
  const editor = read('src/components/Editor.tsx');
  assert.match(editor, /locale: r\.locale \|\| null,/, 'every save sends it');
  assert.match(editor, /locale: me\.account\?\.default_locale \|\| null, \.\.\.p \}/, 'a new person starts with the default');
  const comp = read('src/components/editor/RecipientLanguage.tsx');
  assert.match(comp, /if \(on\.length < 2\) return null;/, 'no list with one entry in it');
  const settings = read('src/components/settings/LanguageSettings.tsx');
  assert.match(settings, /on\.length < 2 \? <p className="muted small" style=\{\{ margin: 0 \}\}>\{LANGUAGE_NOTE\}<\/p>/, 'with English alone it says so and offers nothing');
  assert.match(read('src/app/app/settings/page.tsx'), /\{tab === 'account' && <LanguageSettings \/>\}/);
  assert.match(en['editor.language.hint'], /Your subject, message and documents are never translated/);
  assert.match(en['settings.language.hint'], /Your subject, message and documents are never translated/);
});

// ---- 6. <html lang> and dir ----------------------------------------------------------------------------------------

test('the page\'s lang and dir come from the request, among the languages switched on', () => {
  const layout = read('src/app/layout.tsx');
  assert.match(layout, /const lang = chooseLocale\(\{ acceptLanguage: \(await headers\(\)\)\.get\('accept-language'\) \}\);/);
  assert.match(layout, /<html lang=\{lang\} dir=\{dir\(lang\)\}>/);
  assert.doesNotMatch(layout, /<html lang="en">/);
  // What the layout works out, for a few browsers: English today, and the right direction once a language is on.
  for (const h of ['fr-FR', 'ar-EG,ar;q=0.9', '', 'he']) assert.equal(chooseLocale({ acceptLanguage: h }), 'en', h);
  const withArabic: Language[] = [...MORE, { tag: 'ar', english: 'Arabic', own: 'العربية', ui: 'reviewed', legal: 'missing', shipped: true }];
  const l = chooseLocale({ acceptLanguage: 'ar-EG,ar;q=0.9' }, withArabic);
  assert.equal(l, 'ar');
  assert.equal(dir(l), 'rtl');
});

// ---- 7. Dates and numbers on screen by language; the signed PDF unchanged ------------------------------------------

test('dates and numbers on a screen follow the reader\'s language through Intl; English and the signed PDF stay as they were', async () => {
  const { dateOnScreen, momentOnScreen, momentText, formatDate, validCalendar } = await import('../src/lib/dates.ts');
  const { numberOnScreen } = await import('../src/lib/numbers.ts');
  const t0 = '2026-11-20T23:30:00Z';
  // English is written exactly as before, on every screen that already shows it.
  assert.equal(momentOnScreen(t0, 'en', 'Pacific/Auckland'), momentText(t0, 'Pacific/Auckland'));
  assert.equal(momentOnScreen(t0, undefined), momentText(t0));
  assert.equal(dateOnScreen(t0, 'en-GB', 'Pacific/Auckland'), '21 November 2026', 'the day where the reader is');
  // Other languages the way they write it, with the zone named as the device names it.
  assert.equal(dateOnScreen(t0, 'fr', 'Europe/Paris'), '21 novembre 2026');
  assert.equal(momentOnScreen(t0, 'fr', 'Europe/Paris'), '21 novembre 2026 à 00:30 Europe/Paris (UTC+01:00)');
  assert.match(momentOnScreen(t0, 'de', 'UTC'), /^20\. November 2026 um 23:30 UTC$/);
  assert.match(dateOnScreen(t0, 'ar', 'UTC'), /نوفمبر/);
  // Another calendar is asked for in one place: the Ethiopian one gives the Ethiopian year.
  assert.equal(validCalendar('ethiopic'), 'ethiopic');
  assert.equal(validCalendar('made-up'), null);
  assert.match(dateOnScreen(t0, 'am', 'Africa/Addis_Ababa', 'ethiopic'), /2019/);
  assert.match(dateOnScreen(t0, 'en', 'Africa/Addis_Ababa', 'ethiopic'), /2019/, 'also with English words');
  assert.equal(dateOnScreen(t0, 'en', 'UTC', 'not a calendar'), '20 November 2026');
  for (const nonsense of ['', '!!', '__proto__', 42, null]) assert.equal(dateOnScreen(t0, nonsense, 'UTC'), '20 November 2026', String(nonsense));
  assert.equal(dateOnScreen('not a date', 'fr'), '');
  assert.equal(numberOnScreen(1234.5, 'en'), '1,234.5');
  assert.equal(numberOnScreen(1234.5, 'fr'), '1 234,5');
  assert.match(numberOnScreen(1234.5, 'de-CH'), /^1['\u2019]234\.5$/, 'Swiss German, with the apostrophe this runtime writes');
  assert.equal(numberOnScreen(1234.5, 'nonsense!!'), '1,234.5');
  assert.equal(numberOnScreen(NaN, 'en'), '');
  // The signed PDF prints what it printed: the sender's chosen format, the same for every reader.
  assert.equal(formatDate(t0, 'D MMM YYYY', 'Pacific/Auckland'), '21 Nov 2026');
  for (const f of ['src/server/pdf.ts', 'src/server/evidence.ts']) assert.doesNotMatch(read(f), /OnScreen|i18n\.ts/, `${f} does not use the screen formats`);
});

// ---- 8. The check translators run ----------------------------------------------------------------------------------

test('npm run i18n:check passes on our catalogues and fails on a catalogue that does not match English', () => {
  const run = (dir?: string) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(root, 'scripts/i18n-check.mjs'), ...(dir ? [dir] : [])], { encoding: 'utf8' });
  assert.match(read('package.json'), /"i18n:check": "node --experimental-strip-types --no-warnings scripts\/i18n-check\.mjs"/);
  const ours = run();
  assert.equal(ours.status, 0, ours.stdout + ours.stderr);
  assert.match(ours.stdout, /^en: \d+ texts, the source\.$/m);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-check-'));
  const write = (f: string, o: any) => fs.writeFileSync(path.join(dir, f), typeof o === 'string' ? o : JSON.stringify(o, null, 2));
  write('en.json', { 'a.hello': 'Hello {name}', 'a.count': '{n, plural, one {# day} other {# days}}', 'a.finish.button': 'Finish', 'a.left': 'Left' });
  write('fr.json', { 'a.hello': 'Bonjour {nom}', 'a.count': '{n, plural, one {# jour} other {# jours}}', 'a.finish.button': 'Terminer et envoyer maintenant', 'a.left': '', 'a.old': 'Vieux' });
  write('de.json', { 'a.hello': 'Hallo <b>{name}</b>', 'a.count': '{n, plural, one {# Tag}}', 'a.finish.button': 'Fertig' });
  write('pt-br.json', { 'a.hello': 'Olá {name}' });
  write('es.json', '{ not json');
  write('it.json', { 'a.hello': 'Ciao {name}, vedi https://example.com', 'a.count': { one: 'x' }, 'a.finish.button': 'Fine', 'a.left': 'Sinistra' });
  const bad = run(dir);
  assert.equal(bad.status, 1, bad.stdout);
  const out = bad.stdout;
  for (const want of [
    'error: fr.json: "a.hello" has the placeholders {nom}, and the English text has {name}. Keep exactly the ones in English, with the same names.',
    'error: fr.json: "a.old" is not in en.json. Remove it: the English key may have been renamed or taken out.',
    'warning: fr.json: "a.finish.button" is a button and is 400 percent longer than in English (30 characters against 6). Check that it fits on a phone, or find a shorter word.',
    'fr: 3 of 4 translated, 1 marked missing (shown in English).',
    'error: de.json: "a.hello" holds HTML or an entity.',
    'error: de.json: "a.count" does not read: {n, plural} needs an "other" branch',
    'error: de.json: "a.left" is missing. Add it, with "" while it is not translated, so it is marked missing.',
    'error: pt-br.json: the name must be a language code written the standard way, like fr.json or pt-BR.json (here: pt-BR.json).',
    'error: es.json: this is not JSON that can be read',
    'error: it.json: "a.hello" holds a link or a web address.',
    'error: it.json: "a.count" holds an object. Every value is a text, and keys are flat',
    'error: it.json: "a.count" is missing.',
    'warning: de.json: de is not listed in SUPPORTED_LOCALES',
  ]) assert.ok(out.includes(want), `missing: ${want}\n---\n${out}`);
  assert.match(out, /\d+ errors\. Fix them and run npm run i18n:check again\.$/m);
  // A folder without en.json has nothing to check against.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-empty-'));
  const none = run(empty);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /there is no en\.json/);
  // A catalogue that matches passes, with the long button as a warning only.
  fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir);
  write('en.json', { 'a.hello': 'Hello {name}', 'a.finish.button': 'Finish' });
  write('fr.json', { 'a.hello': 'Bonjour {name}', 'a.finish.button': 'Terminer maintenant' });
  const good = run(dir);
  assert.equal(good.status, 0, good.stdout);
  assert.match(good.stdout, /No errors, 1 warning\./);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(empty, { recursive: true });
});

// ---- Honest words ------------------------------------------------------------------------------------------------

test('the product keeps saying its screens are in English until a language ships, and that nothing a sender writes is translated', () => {
  const { LANGUAGE_NOTE } = { LANGUAGE_NOTE: read('src/lib/policy.ts').match(/export const LANGUAGE_NOTE = '([^']+)'/)![1] };
  assert.equal(shippedLocales().length, 1);
  assert.match(LANGUAGE_NOTE, /in English for now/);
  const readme = read('README.md').replace(/\s+/g, ' ');
  assert.ok(readme.includes('npm run i18n:check'), 'the README tells translators how to check their work');
  assert.match(readme, /Weblate/);
  assert.match(readme, /never translated/);
  // No call to a translation service from the server, anywhere.
  for (const f of fs.readdirSync(path.join(root, 'src/server'))) assert.doesNotMatch(read(`src/server/${f}`), /translate\.googleapis|api\.deepl|translator\.microsoft|libretranslate/i, f);
});
