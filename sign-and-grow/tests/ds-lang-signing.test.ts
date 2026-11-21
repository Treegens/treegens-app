// The signing page in the signer's language (research/docusign-gaps.json, batch "lang-signing"): refusals the page
// shows carry a code and are said from en.json, the header menu saves the choice on the person and writes it to the
// audit trail, right-to-left languages mirror the layout but never the document, the certificate names the language
// of the page and of the consent, and two test languages (en-XA, ar-XB) exist on development servers only.
// Only English is switched on. Where a test needs a second language it switches French on for that test and puts it
// back, so nothing here pretends a language ships.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, Client, simple, signUp, signAll, tokenFor, type Server } from './helpers.ts';
import { SUPPORTED_LOCALES, CATALOGUES, parseMessage, placeholders, translate } from '../src/lib/i18n.ts';
import { pseudoMessage, pseudoCatalogue, signT, signDir, signLangAttr, menuLanguages, shownError, isPseudo, errorKey } from '../src/lib/signlang.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const en = JSON.parse(read('src/locales/en.json'));

let db: Server['db'];
let ada: Client;
before(async () => {
  ({ db } = await boot());
  ada = await signUp('Ada Sender', 'ada.langsign@example.com', '198.51.100.71');
});
const sent = async (email: string, over: any = {}) => {
  const e = await simple(ada, email, over);
  assert.equal((await ada.post(`/envelopes/${e.id}/send`)).status, 200);
  return e;
};
const auditOf = (id: string, action: string) => db.all('SELECT detail FROM audit WHERE envelope_id=? AND action=? ORDER BY seq', id, action).map((x: any) => x.detail as string);

/** French switched on for one test, with a catalogue of its own, and put back afterwards whatever happens. */
async function withFrench(words: Record<string, string>, run: () => Promise<void>) {
  const fr = SUPPORTED_LOCALES.find((l) => l.tag === 'fr')!;
  const was = { ...fr };
  Object.assign(fr, { shipped: true, ui: 'reviewed', legal: 'missing' });
  CATALOGUES.fr = words;
  try {
    await run();
  } finally {
    Object.assign(fr, was);
    delete CATALOGUES.fr;
  }
}

// ---- 1. Refusals the page shows have a code and a text ------------------------------------------------------------

const ROUTES = ['routes-sign', 'routes-signercode', 'routes-witness', 'routes-stamps', 'routes-comments'].map((f) => `src/server/${f}.ts`);

test('every refusal the signing routes say with a code has its text in en.json, and the English answer is that text', async () => {
  const codes = new Set<string>();
  for (const f of ROUTES) for (const m of read(f).matchAll(/refuse\(\s*(?:[^'()]*\?\s*)?'([a-z_]+)'(?:\s*:\s*'([a-z_]+)')?/g)) [m[1], m[2]].filter(Boolean).forEach((c) => codes.add(c));
  assert.ok(codes.size >= 30, `found ${codes.size} codes`);
  for (const c of codes) {
    assert.ok(Object.hasOwn(en, errorKey(c)), `en.json has no "${errorKey(c)}"`);
    assert.doesNotThrow(() => parseMessage(en[errorKey(c)]), c);
  }
  // The answer a program reads is the English text, with the code and its facts beside it.
  const e = await sent('ls.code@example.com', { recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: 'ls.code@example.com', access_code: '4242' }] });
  const tok = tokenFor(e.id, 'ls.code@example.com');
  const c = new Client();
  c.ip = '198.51.100.72';
  let r = await c.post(`/sign/${tok}/unlock`, { code: '0000' });
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'access_code_wrong');
  assert.equal(r.data.error, 'That access code is not right. Ada Sender chose the code and can tell you what it is: ada.langsign@example.com. It is not in the email we sent you.');
  assert.equal(shownError('en', { message: r.data.error, code: r.data.code, data: r.data }), r.data.error, 'the page says the same in English');
  r = await c.post(`/sign/${tok}/consent`, {});
  assert.equal(r.status, 401);
  assert.deepEqual([r.data.code, r.data.error], ['access_code_first', 'Enter the access code first.']);
  // The tries before the code freezes are counted in words that know one from many.
  // (A new connection for each try: one connection is told to wait after five.)
  for (let i = 0; i < 9 && r.data.code !== 'access_code_wrong_left'; i++) {
    const other = new Client();
    other.ip = `198.51.100.${120 + i}`;
    r = await other.post(`/sign/${tok}/unlock`, { code: '0000' });
  }
  assert.equal(r.data.code, 'access_code_wrong_left');
  assert.match(r.data.error, /After \d more wrong tr(y|ies) the code is frozen until Ada Sender sets a new one\.$/);
  // A link nobody knows.
  r = await new Client().get('/sign/not-a-real-token-at-all');
  assert.deepEqual([r.status, r.data.code], [404, 'unknown_link']);
});

test('the page says a refusal in the signer\'s language from its code, and in the server\'s words when it has no text', async () => {
  await withFrench({ 'sign.error.access_code_wrong': '{sender} a choisi le code et peut vous le dire : {email}.', 'sign.error.unknown': 'Un problème de notre côté.' }, async () => {
    const e = { message: 'That access code is not right.', code: 'access_code_wrong', data: { code: 'access_code_wrong', sender: 'Ada', email: 'ada@example.com' } };
    assert.equal(shownError('fr', e), 'Ada a choisi le code et peut vous le dire : ada@example.com.');
    // A text French does not have yet is said in English, never as its key.
    assert.equal(shownError('fr', { message: 'x', code: 'turn_not_yet' }), 'It is not your turn yet.');
    // No code, or a code we have no text for: the server's own words. A code is never read as a key of anything else.
    assert.equal(shownError('fr', { message: 'The server said this.', code: 'taken' }), 'The server said this.');
    assert.equal(shownError('fr', { message: 'Plain.', code: '../legal.in_english' }), 'Plain.');
    assert.equal(shownError('fr', { message: 'Plain.', code: 'shell.help' }), 'Plain.', 'only sign.error.* texts are reachable');
    assert.equal(shownError('fr', {}), 'Un problème de notre côté.');
    // A fact in the answer is shown as text, never read as a placeholder or markup.
    assert.equal(shownError('en', { code: 'document_not_found', data: { x: '{y}' } }), 'Document not found.');
    assert.equal(shownError('fr', { code: 'access_code_wrong', data: { sender: '<b>{email}</b>', email: 'e' } }), '<b>{email}</b> a choisi le code et peut vous le dire : e.');
  });
});

// ---- 2. The language menu saves on the person and writes the audit trail -------------------------------------------

test('with one language switched on the menu is not there; it lists each language in its own name once there are two', async () => {
  assert.deepEqual(menuLanguages({ dev: false }), [{ tag: 'en', own: 'English' }], 'one entry: the page shows no menu');
  assert.deepEqual(menuLanguages({ dev: true }), [{ tag: 'en', own: 'English' }], 'a development server shows no menu either until a test language is open');
  assert.equal(menuLanguages({ dev: false, current: 'en-XA' }).length, 1, 'a production build never offers a test language');
  assert.deepEqual(menuLanguages({ dev: true, current: 'en-XA' }).map((x) => x.tag), ['en', 'en-XA', 'ar-XB']);
  await withFrench({}, async () => {
    assert.deepEqual(menuLanguages({ dev: false }), [{ tag: 'en', own: 'English' }, { tag: 'fr', own: 'Français' }]);
  });
  // The component hides itself below two entries (src/components/sign/lang.tsx) and the Shell puts it in the header.
  assert.match(read('src/components/sign/lang.tsx'), /if \(options\.length < 2/);
  assert.match(read('src/components/sign/parts.tsx'), /<LanguageMenu lang=\{lang\} \/>/);
});

test('choosing a language saves it on the person, writes it to the audit trail once, and the page and their next visit follow it', async () => {
  const email = 'ls.menu@example.com';
  const e = await sent(email);
  const tok = tokenFor(e.id, email);
  const c = new Client();
  c.ip = '198.51.100.73';
  // Not switched on: refused in words that name what is, and nothing changes.
  let r = await c.post(`/sign/${tok}/locale`, { locale: 'fr' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /not available yet.*English \(en\).*Nothing was changed\./);
  assert.equal(db.get('SELECT locale FROM recipients WHERE token=?', tok).locale, null);
  r = await c.post(`/sign/${tok}/locale`, { locale: '<script>' });
  assert.equal(r.status, 400);
  await withFrench({}, async () => {
    r = await c.post(`/sign/${tok}/locale`, { locale: 'fr' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.saved, true);
    assert.equal(r.data.language.locale, 'fr');
    assert.equal(db.get('SELECT locale FROM recipients WHERE token=?', tok).locale, 'fr');
    assert.deepEqual(auditOf(e.id, 'Chose the language of the page'), ['Sam Signer chose to read the page in French (fr).']);
    // The same choice again is not a second line.
    await c.post(`/sign/${tok}/locale`, { locale: 'fr' });
    assert.equal(auditOf(e.id, 'Chose the language of the page').length, 1);
    // The page, opened again in a browser that asks for English, is in French: the person chose.
    r = await new Client().call('GET', `/sign/${tok}`, undefined, { 'accept-language': 'en-US' });
    assert.deepEqual(r.data.language, { locale: 'fr', dir: 'ltr', set_by: 'sender' });
    // Back to "as my browser asks".
    r = await c.post(`/sign/${tok}/locale`, { locale: null });
    assert.equal(r.status, 200);
    assert.equal(db.get('SELECT locale FROM recipients WHERE token=?', tok).locale, null);
    assert.equal(auditOf(e.id, 'Chose the language of the page')[1], 'Sam Signer chose to read the page in the language their browser asks for.');
  });
});

test('someone with only the link cannot change the language behind an access code; the menu is limited per person', async () => {
  const email = 'ls.locked@example.com';
  const e = await sent(email, { recipients: [{ id: 'r', role: 'signer', name: 'Lee Locked', email, access_code: '9191' }] });
  const tok = tokenFor(e.id, email);
  await withFrench({}, async () => {
    const stranger = new Client();
    stranger.ip = '198.51.100.74';
    const r = await stranger.post(`/sign/${tok}/locale`, { locale: 'fr' });
    assert.deepEqual([r.status, r.data.code], [401, 'access_code_first']);
    assert.equal(db.get('SELECT locale FROM recipients WHERE token=?', tok).locale, null);
    assert.equal(auditOf(e.id, 'Chose the language of the page').length, 0);
    // The person who has the code: 20 changes an hour, plenty for someone looking for their language.
    const me = new Client();
    me.ip = '198.51.100.75';
    assert.equal((await me.post(`/sign/${tok}/unlock`, { code: '9191' })).status, 200);
    const got: number[] = [];
    for (let i = 0; i < 22; i++) got.push((await me.post(`/sign/${tok}/locale`, { locale: i % 2 ? 'en' : 'fr' })).status);
    assert.equal(got[20], 429, 'flooding the audit trail stops');
    assert.ok(auditOf(e.id, 'Chose the language of the page').length <= 20);
  });
});

// ---- Consent: in the language only where a person checked it, else English with the note --------------------------

test('consent in a language without checked legal text is shown in English with one sentence in the page\'s language, and recorded as English', async () => {
  const { consentWording } = await import('../src/lib/policy.ts');
  await withFrench({ 'legal.in_english': 'Cette partie est en anglais.' }, async () => {
    const w = consentWording('Ada', true, undefined, 'fr');
    assert.equal(w.language, 'en');
    assert.equal(w.note, 'Cette partie est en anglais.');
    assert.match(w.agree, /^I agree/);
    const email = 'ls.consent@example.com';
    const e = await sent(email);
    const tok = tokenFor(e.id, email);
    const r = await new Client().post(`/sign/${tok}/consent`, { wording: w.version, language: w.language, page_language: 'fr' });
    assert.equal(r.status, 200);
    assert.match(auditOf(e.id, 'Agreed to electronic records and signatures')[0], /in English \(en\), as printed/);
    assert.equal(db.get('SELECT page_locale FROM recipients WHERE token=?', tok).page_locale, 'fr');
  });
  // In English, the note is empty: nothing extra is shown.
  assert.equal(consentWording('Ada', true, undefined, 'en').note, '');
  // The page sends the wording's language and its own (src/app/sign/[token]/page.tsx).
  const page = read('src/app/sign/[token]/page.tsx');
  assert.match(page, /consentWording\(sender\.name, acts, undefined, lang\)/);
  assert.match(page, /language: wording\.language, page_language: lang/);
  assert.match(page, /\{consentNote\(lang, wording\.note\) && <p/);
});

// ---- 4. The certificate ------------------------------------------------------------------------------------------

test('the certificate says in which language each person read the page and the consent', async () => {
  const { certLanguageLine, pageLanguage } = await import('../src/server/signlang.ts');
  const email = 'ls.cert@example.com';
  const e = await sent(email);
  const tok = tokenFor(e.id, email);
  const c = new Client();
  assert.equal((await c.post(`/sign/${tok}/consent`, { language: 'en', page_language: 'en-XA' })).status, 200);
  assert.equal(db.get('SELECT page_locale FROM recipients WHERE token=?', tok).page_locale, 'en', 'a test language is recorded as the English its words came from');
  await signAll(e.id, email);
  const { extractPages } = await import('../src/server/text.ts');
  const text = (await extractPages((await ada.get(`/envelopes/${e.id}/download`)).data)).join('\n');
  assert.match(text.replace(/\s+/g, ' '), /Signing page in English \(en\); consent wording in English \(en\)/);
  // Nothing recorded: no line, rather than a guess. A person from before pages recorded it: said so.
  assert.equal(certLanguageLine({ name: 'X' }, []), null);
  assert.equal(certLanguageLine({ name: 'X' }, [{ action: 'Agreed to electronic records and signatures', actor: 'x@example.com', detail: 'X. Wording 2026-01, as printed on the help page under "What do I agree to before I sign?".' }]), 'Signing page language not recorded; consent wording in English (en)');
  // Only languages that exist are kept.
  assert.equal(pageLanguage('../../etc'), null);
  assert.equal(pageLanguage('fr'), 'en', 'not switched on: the English the words came from');
  assert.equal(pageLanguage(42), null);
});

// ---- 3. Right to left -----------------------------------------------------------------------------------------------

test('right to left: the screens use start and end, the document, the pad and the zoom never turn around', () => {
  const css = read('src/app/styles/sign.css');
  // No physical left or right outside the document's own rules (fields sit where the sender put them).
  const outside = css.split('\n').filter((l) => !/^\s*\.sg-(doc|flag|padwrap)\b|\.sg-doc /.test(l) && !/^\s*\/?\*/.test(l));
  const physical = outside.filter((l) => /(?:margin|padding|border)-(?:left|right)\b|text-align:\s*(?:left|right)|(?:^|[\s;{])(?:left|right):/.test(l));
  assert.deepEqual(physical, [], 'use margin-inline, padding-inline, inset-inline and text-align: start');
  assert.match(css, /\.sg-doc, \.sg-padwrap, \.sg-zoom \{ direction: ltr; \}/);
  assert.equal(signDir('ar'), 'rtl');
  assert.equal(signDir('he-IL'), 'rtl');
  assert.equal(signDir('ar-XB'), 'rtl');
  assert.equal(signDir('fr'), 'ltr');
  assert.equal(signLangAttr('ar-XB'), 'en', 'a test language is English to a screen reader');
  assert.match(read('src/components/sign/parts.tsx'), /<div className="sg-shell" \{\.\.\.langAttrs\(lang\)\}>/);
});

// ---- 5. The test languages ------------------------------------------------------------------------------------------

test('en-XA: accented, 40 percent longer, in brackets, with every placeholder and plural kept; development only', () => {
  const s = pseudoMessage('Hand this device to {name} now.', 'en-XA');
  assert.match(s, /^\[Ĥáñð ţĥîš ðéṽîçé ţö \{name\} ñöŵ\. ~+\]$/);
  assert.ok(s.length >= 'Hand this device to {name} now.'.length * 1.3);
  const p = pseudoMessage('After {left, plural, one {# more wrong try} other {# more wrong tries}} it stops.', 'en-XA');
  assert.deepEqual(placeholders(parseMessage(p)), ['left']);
  assert.match(translate({ 'en-XA': { k: p } }, 'en-XA', 'k', { left: 2 }), /2 ɱöŕé ŵŕöñĝ ţŕîéš/);
  // Every text in en.json still reads in both test languages, with the same placeholders.
  for (const tag of ['en-XA', 'ar-XB'] as const) {
    const cat = pseudoCatalogue(tag);
    for (const [k, v] of Object.entries(en as Record<string, string>)) assert.deepEqual(placeholders(parseMessage(cat[k])), placeholders(parseMessage(v)), `${tag} ${k}`);
  }
  assert.match(signT('ar-XB', 'sign.consent.continue'), /^‮Continue‬$/);
  assert.equal(signT('en-XA', 'sign.consent.hand_over', { name: 'Zoë' }).includes('Zoë'), true, 'a value is never changed');
  assert.ok(isPseudo('en-XA') && !isPseudo('en'));
  // Only on a development server, and never saved on a recipient: the server refuses it like any language not switched on.
  assert.match(read('src/components/sign/lang.tsx'), /const DEV = process\.env\.NODE_ENV !== 'production';/);
  assert.match(read('src/components/sign/lang.tsx'), /if \(!DEV \|\| typeof window === 'undefined'\) return null;/);
});

test('a test language is never saved: the server refuses it', async () => {
  const email = 'ls.pseudo@example.com';
  const e = await sent(email);
  const r = await new Client().post(`/sign/${tokenFor(e.id, email)}/locale`, { locale: 'en-XA' });
  assert.equal(r.status, 400);
});

// ---- 1. Every word through t(): the files that are done stay done -------------------------------------------------

/** JSX text and shown attributes written as English in a file, rather than through T(). Brand and units are allowed. */
function untranslated(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const ALLOW = /^(GrowSigning|growsigning|PDF|PNG|JPEG|px|mm|·|&apos;|%)$/;
  const out: string[] = [];
  for (const m of code.matchAll(/>([^<>{}]*?[A-Za-z]{2}[^<>{}]*?)</g)) {
    const t = m[1].trim();
    // Code between two tags (") : x ? (") is not words.
    if (t && !ALLOW.test(t) && !/=>|&&|\|\||\)\s*[;,]?$|[?:]\s*\(\s*$/.test(m[1])) out.push(t);
  }
  for (const m of code.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*[A-Za-z]{2}[^"]*)"/g)) out.push(`${m[1]}="${m[2]}"`);
  return out;
}

// The signing page's files whose every word goes through T() now. A file joins this list when it is done; the rest
// are named in the report of this batch and in README "What is not in it".
const DONE = ['src/components/HandBack.tsx', 'src/components/HandedOver.tsx', 'src/components/sign/lang.tsx'];

test('the finished files of the signing page show no English written into the code', () => {
  for (const f of DONE) assert.deepEqual(untranslated(read(f)), [], f);
  // The scan finds what it should: a word in JSX, and a label on a button.
  assert.deepEqual(untranslated('<p>Hello there</p><button aria-label="Close it">{T(\'x\')}</button>'), ['Hello there', 'aria-label="Close it"']);
  assert.deepEqual(untranslated('<p>{T(\'a\')}</p><span>GrowSigning</span>'), []);
  // Every key these files and the Shell ask for is in en.json, so none ever shows empty.
  for (const f of [...DONE, 'src/components/sign/parts.tsx', 'src/app/sign/[token]/page.tsx']) {
    for (const m of read(f).matchAll(/\bT\(\s*'([a-z0-9_.]+)'/g)) assert.ok(Object.hasOwn(en, m[1]), `${f}: ${m[1]}`);
    for (const m of read(f).matchAll(/richText\(lang, '([a-z0-9_.]+)'/g)) assert.ok(Object.hasOwn(en, m[1]), `${f}: ${m[1]}`);
  }
});

// ---- Repairs after the skeptic and the simplicity review -------------------------------------------------------------

test('the certificate keeps the language a person read when they signed: nothing said after they finish changes it', async () => {
  await withFrench({}, async () => {
    const e = await sent('ls.one@example.com', { recipients: [
      { id: 'r', role: 'signer', name: 'One Signer', email: 'ls.one@example.com', order: 1 },
      { id: 'r2', role: 'signer', name: 'Two Signer', email: 'ls.two@example.com', order: 2 }],
      fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'f2', document_id: 'd', recipient_id: 'r2', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }] });
    const tok = tokenFor(e.id, 'ls.one@example.com');
    assert.equal((await signAll(e.id, 'ls.one@example.com')).status, 200);
    assert.equal(db.get('SELECT page_locale FROM recipients WHERE token=?', tok).page_locale, null);
    const c = new Client();
    c.ip = '198.51.100.81';
    // Agreeing again and choosing a language after finishing: the page may change, the record does not.
    await c.post(`/sign/${tok}/consent`, { language: 'en', page_language: 'fr' });
    const r = await c.post(`/sign/${tok}/locale`, { locale: 'fr' });
    assert.deepEqual([r.status, r.data.saved, r.data.why], [200, false, 'finished']);
    assert.equal(r.data.language.locale, 'fr', 'the page in that tab still changes');
    const row = db.get('SELECT page_locale, locale FROM recipients WHERE token=?', tok);
    assert.deepEqual([row.page_locale, row.locale], [null, null]);
    assert.equal(auditOf(e.id, 'Chose the language of the page').length, 0);
    assert.equal((await signAll(e.id, 'ls.two@example.com')).status, 200);
    const { extractPages } = await import('../src/server/text.ts');
    const text = (await extractPages((await ada.get(`/envelopes/${e.id}/download`)).data)).join('\n').replace(/\s+/g, ' ');
    assert.doesNotMatch(text, /Signing page in French/);
  });
});

test('on a completed or voided document a language choice saves nothing and adds nothing to the record', async () => {
  const done = await sent('ls.done@example.com');
  assert.equal((await signAll(done.id, 'ls.done@example.com')).status, 200);
  const voided = await sent('ls.void@example.com');
  assert.equal((await ada.post(`/envelopes/${voided.id}/void`, { reason: 'Sent by mistake' })).status, 200);
  for (const [e, email, why] of [[done, 'ls.done@example.com', 'finished'], [voided, 'ls.void@example.com', 'closed']] as const) {
    const c = new Client();
    c.ip = '198.51.100.82';
    for (const locale of ['en', null]) {
      const r = await c.post(`/sign/${tokenFor(e.id, email)}/locale`, { locale });
      assert.deepEqual([r.status, r.data.saved, r.data.why], [200, false, why], email);
    }
    assert.equal(auditOf(e.id, 'Chose the language of the page').length, 0, email);
    assert.equal(db.get('SELECT locale FROM recipients WHERE token=?', tokenFor(e.id, email)).locale, null);
  }
  // The page tells the person why, in words of its own for each case.
  for (const k of ['sign.language.not_saved', 'sign.language.not_saved_done', 'sign.language.not_saved_closed', 'sign.language.not_saved_group']) assert.ok(en[k], k);
  const menu = read('src/components/sign/lang.tsx');
  assert.match(menu, /toast\(signT\(tag, why\)\)/, 'shown on screen, not only to a screen reader');
  assert.doesNotMatch(menu, /className="sg-vh" role="status"/);
});

test('someone with a forwarded link cannot use up the signer\'s language changes, and a wrong request counts for nothing', async () => {
  const email = 'ls.rate@example.com';
  const e = await sent(email);
  const tok = tokenFor(e.id, email);
  const stranger = new Client();
  stranger.ip = '198.51.100.83';
  for (let i = 0; i < 25; i++) await stranger.post(`/sign/${tok}/locale`, { locale: 'xx-not-a-language' });
  // Same language as now: changes nothing and is not counted.
  for (let i = 0; i < 25; i++) assert.equal((await stranger.post(`/sign/${tok}/locale`, { locale: null })).status, 200);
  const got: number[] = [];
  for (let i = 0; i < 22; i++) got.push((await stranger.post(`/sign/${tok}/locale`, { locale: i % 2 ? null : 'en' })).status);
  assert.equal(got.indexOf(429), 20, 'one connection: 20 changes an hour, and the refused ones before it did not count');
  const me = new Client();
  me.ip = '198.51.100.84';
  const r = await me.post(`/sign/${tok}/locale`, { locale: 'en' });
  assert.equal(r.status, 200, 'the signer on their own connection still can');
  assert.ok(auditOf(e.id, 'Chose the language of the page').length <= 40);
});

test('a refusal said two ways keeps one code, and the page says the right one of the two', async () => {
  const { refuse } = await import('../src/server/signlang.ts');
  const x: any = refuse('handed_on', 403, { name: 'Pat', sender: 'Ada' }, 'handed_on_unsent');
  assert.equal(x.status, 403);
  assert.equal(x.data.code, 'handed_on');
  assert.match(x.message, /^This is the signing page of Pat, .*Host signing now"\. Nothing was sent\.$/);
  assert.equal(shownError('en', { message: 'm', code: 'handed_on', data: x.data }), x.message);
  assert.doesNotMatch(shownError('en', { message: 'm', code: 'handed_on', data: { code: 'handed_on', name: 'Pat', sender: 'Ada' } }), /Nothing was sent/);
  // A "text" that is not a refusal's text is never read as a key.
  assert.equal(shownError('en', { message: 'm', code: 'handed_on', data: { code: 'handed_on', text: 'shell.help', name: 'P', sender: 'A' } }).startsWith('This is the signing page of P'), true);
  const comments = read('src/server/routes-comments.ts');
  assert.doesNotMatch(comments, /bad\([^;]*code: 'handed_on'/, 'the hand-over refusals go through refuse()');
});

test('dialogs and toasts follow the page: the whole document carries its language and direction while it is open', () => {
  assert.match(read('src/components/sign/parts.tsx'), /useDocumentLang\(lang\);/);
  const menu = read('src/components/sign/lang.tsx');
  assert.match(menu, /el\.setAttribute\('dir', want\.dir\)/);
  assert.match(menu, /removeAttribute/, 'put back as it was when the page goes');
  // A language chosen in the menu belongs to that one link, not to the tab.
  assert.match(menu, /chosen\?\.token === token/);
});

test('with the menu there, the phone header keeps one row and shows the leaf rather than a cut-off logo', () => {
  const css = read('src/app/styles/sign.css');
  assert.doesNotMatch(css, /max-width: 9em/);
  assert.match(css, /field-sizing: content/);
  assert.match(css, /\.sg-bar:has\(\.sg-lang\) \.sg-title \.sg-logo-small \{ display: block; \}/);
  assert.match(css, /@media \(max-width: 379px\) \{\n  \.sg-bar:has\(\.sg-lang\) \{ flex-wrap: wrap/, 'a second row only below 380 px');
});

test('a test language shows the consent note too, so its length and place can be checked before a language ships', async () => {
  const { consentNote } = await import('../src/lib/signlang.ts');
  assert.equal(consentNote('en', ''), '');
  assert.match(consentNote('en-XA', ''), /^\[Ţĥîš/);
  assert.equal(consentNote('fr', 'Note.'), 'Note.');
});

// No language besides English may be switched on while part of the signing page still has its English written into
// the code: a signer would read two languages on one screen (research/ux-notes.json ds-lang-signing "never").
const SIGNING_FILES = ['src/app/sign/[token]/page.tsx', 'src/components/SignaturePad.tsx', 'src/components/StampDialog.tsx', 'src/components/HandBack.tsx', 'src/components/HandedOver.tsx',
  ...fs.readdirSync(path.join(root, 'src/components/sign')).filter((f) => f.endsWith('.tsx')).map((f) => `src/components/sign/${f}`)].filter((f) => fs.existsSync(path.join(root, f)));
test('no second language is switched on until every file of the signing page is in the catalogue', () => {
  const left = SIGNING_FILES.filter((f) => !DONE.includes(f) || untranslated(read(f)).length);
  const shipped = SUPPORTED_LOCALES.filter((l) => l.shipped).map((l) => l.tag);
  if (left.length) assert.deepEqual(shipped, ['en'], `still in English in the code: ${left.join(', ')}`);
});
