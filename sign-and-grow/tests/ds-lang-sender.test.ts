// The sender's own screens and the emails to senders in the sender's language (research/docusign-gaps.json, batch
// "lang-sender"): the choice under Settings, Profile (users.locale, PATCH /me "locale"), the browser's language noted
// for emails while none is chosen (users.seen_locale), the emails to a sender written from en.json in that language,
// and the screens that are done showing no English written into the code. Only English is switched on: a test that
// needs a second language switches French on with a test catalogue and puts it back, so nothing here pretends a
// language ships.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, Client, simple, signUp, signAll, tokenFor, type Server } from './helpers.ts';
import { SUPPORTED_LOCALES, CATALOGUES, parseMessage } from '../src/lib/i18n.ts';
import { senderLanguages, senderChoiceShown, senderLocale, senderMailLocale, senderLanguageName, howLongIn, joinIn, senderT } from '../src/lib/senderlang.ts';
import { askedSenderLocale, namesIn, senderCompletedMail } from '../src/server/senderlocale.ts';
import { NAV_START, NAV_MAIN, NAV_MORE, NAV_END, NAV_KEY_DATES, NAV_COUNTER } from '../src/lib/nav.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const en: Record<string, string> = JSON.parse(read('src/locales/en.json'));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

let db: Server['db'];
let ada: Client;
before(async () => {
  ({ db } = await boot());
  ada = await signUp('Ada Sender', 'ada.langsender@example.com', '198.51.100.121');
});
const patchMe = (c: Client, body: any, headers: Record<string, string> = {}) => c.call('PATCH', '/me', body, headers);
const lastTo = (email: string, like = '%') => db.get('SELECT * FROM emails WHERE to_email=? AND subject LIKE ? ORDER BY id DESC LIMIT 1', email, like);

/** French switched on for one test, as a sender language with its own test catalogue, and put back whatever happens. */
async function withFrench(words: Record<string, string>, run: () => Promise<void>, status: 'draft' | 'reviewed' = 'draft') {
  const fr = SUPPORTED_LOCALES.find((l) => l.tag === 'fr')!;
  const was = { ...fr };
  Object.assign(fr, { shipped: true, ui: 'reviewed', legal: 'missing', sender: status });
  CATALOGUES.fr = words;
  try {
    await run();
  } finally {
    Object.assign(fr, was);
    delete CATALOGUES.fr;
  }
}
/** A test French: every text of ours, marked "FR " in front of each plain part (placeholders and plurals kept). */
const testFrench = () => Object.fromEntries(Object.entries(en).map(([k, v]) => [k, /^\{\w+, plural,/.test(v) ? v.replace(/\b(one|other) \{/g, '$1 {FR ') : `FR ${v}`]));

const sent = async (c: Client, email: string, over: any = {}) => {
  const e = await simple(c, email, over);
  const r = await c.post(`/envelopes/${e.id}/send`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return e;
};
const decline = async (envelopeId: string, email: string, reason: string) => {
  const s = new Client();
  s.ip = '198.51.100.140';
  const tok = tokenFor(envelopeId, email);
  await s.post(`/sign/${tok}/consent`);
  const r = await s.post(`/sign/${tok}/decline`, { reason });
  assert.equal(r.status, 200, JSON.stringify(r.data));
};

// ---- 1. With zero setup nothing changes ------------------------------------------------------------------------

test('with English the only language there is nothing to choose, and a sender reads English everywhere', async () => {
  assert.deepEqual(senderLanguages().map((l) => l.tag), ['en']);
  assert.equal(senderChoiceShown(), false);
  assert.equal(senderLocale({ browser: 'fr-CA,fr;q=0.9' }), 'en');
  assert.equal(senderMailLocale({ locale: 'fr', seen_locale: 'fr' }), 'en');
  const me = await ada.get('/me');
  assert.equal(me.data.user.locale, null);
  // A French browser opening the app writes nothing while English is the only sender language.
  await ada.call('GET', '/me', undefined, { 'accept-language': 'fr' });
  assert.equal(db.get('SELECT seen_locale FROM users WHERE email=?', 'ada.langsender@example.com').seen_locale, null);
});

test('PATCH /me "locale": a language that is not a sender language, a test language or nonsense is refused in words, and nothing is changed', async () => {
  for (const bad of ['fr', 'en-XA', 'ar-XB', 'klingon!!', 42, { x: 1 }]) {
    const r = await patchMe(ada, { locale: bad, name: 'Changed Name' });
    assert.equal(r.status, 400, String(bad));
    assert.match(r.data.error, /Nothing was changed\.$/);
    assert.doesNotMatch(r.data.error, /—/);
    assert.equal(r.data.code, 'sender_locale');
  }
  const row = db.get('SELECT name, locale FROM users WHERE email=?', 'ada.langsender@example.com');
  assert.deepEqual([row.name, row.locale], ['Ada Sender', null], 'the refused call saved neither the language nor the name');
  // English, or empty for "my browser decides", is fine.
  assert.equal((await patchMe(ada, { locale: 'en' })).data.user.locale, 'en');
  assert.equal((await patchMe(ada, { locale: '' })).data.user.locale, null);
  assert.equal((await patchMe(ada, { name: 'Ada Sender' })).data.user.locale, null, 'leaving it out changes nothing');
  assert.equal(askedSenderLocale(undefined), undefined);
  assert.equal(askedSenderLocale(null), null);
});

test('an English email to a sender reads as before, with "document" where it said "envelope"', async () => {
  const email = 'lsd.en@example.com';
  const e = await sent(ada, email);
  await decline(e.id, email, 'Wrong address on page 2');
  const m = lastTo('ada.langsender@example.com', 'Declined:%');
  assert.equal(m.subject, 'Declined: Simple agreement');
  assert.equal(m.locale, null);
  const body = text(m.html);
  assert.match(body, /Sam Signer declined to sign/);
  assert.match(body, /Reason: Wrong address on page 2/);
  assert.match(body, /The document is closed\. You can copy it, change what needs changing and send it again\./);
  assert.match(m.html, /<html lang="en" dir="ltr">/);
  assert.match(body, /Open the document/);
});

// ---- 2. A sender language switched on ----------------------------------------------------------------------------

test('with a second sender language: the choice is saved, listed as a draft, and a browser language is noted for emails', async () => {
  await withFrench(testFrench(), async () => {
    assert.equal(senderChoiceShown(), true);
    assert.equal(senderLanguageName('fr', 'en'), 'Français (draft translation)');
    assert.equal(senderLanguageName('en', 'en'), 'English');
    assert.equal(senderLocale({ browser: 'fr-CA,fr;q=0.9,en;q=0.5' }), 'fr', 'the browser decides when nothing is chosen');
    assert.equal(senderLocale({ chosen: 'en', browser: 'fr' }), 'en', 'a choice wins over the browser');
    const bea = await signUp('Bea Sender', 'bea.langsender@example.com', '198.51.100.122');
    assert.equal((await patchMe(bea, { locale: 'fr' })).data.user.locale, 'fr');
    assert.equal((await bea.get('/me')).data.user.locale, 'fr');
    // Someone who chose nothing: their browser's language, noted for emails when they open the app.
    const cal = await signUp('Cal Sender', 'cal.langsender@example.com', '198.51.100.123');
    await cal.call('GET', '/me', undefined, { 'accept-language': 'fr-CA,fr;q=0.8' });
    assert.equal(db.get('SELECT seen_locale FROM users WHERE email=?', 'cal.langsender@example.com').seen_locale, 'fr');
    await cal.call('GET', '/me', undefined, { 'accept-language': 'en-GB' });
    assert.equal(db.get('SELECT seen_locale FROM users WHERE email=?', 'cal.langsender@example.com').seen_locale, null);
    // A test language is never saved, also when a second language ships.
    assert.equal((await patchMe(bea, { locale: 'en-XA' })).status, 400);
  });
  // French switched off again: the stored choice is no longer used, and English is what the sender reads.
  assert.equal(senderMailLocale(db.get('SELECT locale, seen_locale FROM users WHERE email=?', 'bea.langsender@example.com')), 'en');
});

test('a sender email in another language: every line of ours from the catalogue, the signer\'s words untouched, the signer\'s own emails unchanged', async () => {
  const fr = testFrench();
  await withFrench(fr, async () => {
    const dan = await signUp('Dan Sender', 'dan.langsender@example.com', '198.51.100.124');
    await patchMe(dan, { locale: 'fr' });
    const email = 'lsd.fr@example.com';
    const e = await sent(dan, email);
    // The request to the signer is not the sender's: it stays in the signer's language (English here).
    const req = db.get('SELECT * FROM emails WHERE to_email=? ORDER BY id LIMIT 1', email);
    assert.equal(req.locale, null);
    assert.doesNotMatch(text(req.html), /\bFR\b/);
    await decline(e.id, email, 'Je ne suis pas d\'accord');
    const m = lastTo('dan.langsender@example.com', 'FR Declined:%');
    assert.ok(m, 'the decline email to the sender is in French');
    assert.equal(m.subject, 'FR Declined: Simple agreement', 'the sender\'s own subject is not translated');
    assert.equal(m.locale, 'fr');
    assert.match(m.html, /<html lang="fr" dir="ltr">/);
    const body = text(m.html);
    for (const line of ['FR Sam Signer declined to sign', "FR Reason: Je ne suis pas d'accord", 'FR The document is closed.', 'FR Open the document'])
      assert.ok(body.includes(line), line);
    // No sentence of ours is left in English: each paragraph of the email starts with the marker.
    for (const p of [...m.html.matchAll(/<p style="font-size:15px[^>]*>([^<]*)<\/p>/g)].map((x) => x[1])) assert.match(p, /^FR /, p);
  });
});

test('the sender\'s completed email, the pass-on emails and "not opened" come from the catalogue, and English is unchanged', () => {
  const e = { id: 'env1', subject: 'Lease', final_sha256: 'ab'.repeat(32), recipients: [{ name: 'Una', link_by_sender: 1 }, { name: 'Vic', link_by_sender: 1 }] };
  const m = senderCompletedMail('en', e, { ready: true, copy: 'attached', impact: { sheets: 1, litresWater: 10.4 } });
  assert.equal(m.subject, 'Completed: Lease');
  assert.equal(m.heading, 'Your document is complete');
  assert.equal(m.lines[0], 'Everyone has finished. The signed document and its certificate of completion are ready.');
  assert.match(m.lines[1], /^The signed PDF attached to this email has this SHA-256 fingerprint: a{0}(ab){32}\. Keep it with your copy\. Anyone can check a file against it at .*\/verify, and whoever has a printed copy can look the document up there by its envelope ID, env1\.$/);
  assert.match(m.lines[2], /^Because this was signed on screen, about 1 sheet of paper and 10 litres of water were not used\./);
  assert.equal(m.lines[3], 'We have no email address for Una and Vic, so no copy went to them by email. Each of their links opens the completed document: copy it from the document\'s page and send it on, or send them the PDF yourself.');
  assert.equal(senderCompletedMail('en', { ...e, recipients: [] }, { ready: false, copy: 'not-ready', impact: null }).lines.length, 1);
  // Names as these emails always wrote them in English; another language lists them its own way.
  assert.equal(namesIn('en', ['A', 'B', 'C']), 'A, B and C');
  assert.equal(namesIn('en', ['A', 'B', 'C'], true), 'A, B, C');
  assert.equal(namesIn('fr', ['A', 'B', 'C']), 'A, B et C');
  // Every mail.sender text reads, has no em dash, and the English bodies are what bysender.ts wrote before.
  for (const [k, v] of Object.entries(en).filter(([k]) => k.startsWith('mail.sender.') || k.startsWith('sender.') || k.startsWith('home.') || k.startsWith('shell.') || k.startsWith('nav.'))) {
    assert.doesNotThrow(() => parseMessage(v), k);
    assert.doesNotMatch(v, /—/, k);
  }
  assert.equal(senderT('en', 'mail.sender.pass_on.heading', { names: 'Una', count: 1 }), 'Una has not finished yet');
  assert.equal(senderT('en', 'mail.sender.pass_on.heading', { names: 'Una and Vic', count: 2 }), 'Una and Vic have not finished yet');
  assert.equal(senderT('en', 'mail.sender.turn.sign', { name: 'Una', subject: 'Lease' }), 'It is now Una\'s turn to sign "Lease". You said you would send them the link yourself, so we did not write to them.');
});

test('the signed and expired emails to a sender follow the sender\'s language too', async () => {
  await withFrench(testFrench(), async () => {
    const eve = await signUp('Eve Sender', 'eve.langsender@example.com', '198.51.100.125');
    await patchMe(eve, { locale: 'fr', notify: { signed: true } });
    const e = await sent(eve, 'lsd.one@example.com', { recipients: [
      { id: 'r', role: 'signer', name: 'One Signer', email: 'lsd.one@example.com', routing_order: 1 },
      { id: 'r2', role: 'signer', name: 'Two Signer', email: 'lsd.two@example.com', routing_order: 2 }],
      fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'f2', document_id: 'd', recipient_id: 'r2', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }] });
    assert.equal((await signAll(e.id, 'lsd.one@example.com')).status, 200);
    const m = lastTo('eve.langsender@example.com', 'FR Signed:%');
    assert.ok(m, 'signed email in French');
    assert.ok(text(m.html).includes('FR Still waiting on Two Signer.'));
    assert.equal((await signAll(e.id, 'lsd.two@example.com')).status, 200);
    const done = lastTo('eve.langsender@example.com', 'FR Completed:%');
    assert.ok(done, 'completed email in French');
    assert.equal(done.locale, 'fr');
    assert.ok(text(done.html).includes('FR Everyone has finished.'));
  });
});

// ---- 3. The sender's screens -------------------------------------------------------------------------------------

/** JSX text and shown attributes written as English in a file, rather than through T(). Brand and units are allowed. */
function untranslated(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const ALLOW = /^(GrowSigning|growsigning|PDF|PNG|JPEG|px|mm|·|&apos;|%)$/;
  const out: string[] = [];
  for (const m of code.matchAll(/>([^<>{}]*?[A-Za-z]{2}[^<>{}]*?)</g)) {
    const t = m[1].trim();
    // Code between two tags (") : x ? (", a generic like useState<any>(null);) is not words: words have no ; or =.
    if (t && !ALLOW.test(t) && !/=>|&&|\|\||\)\s*[;,]?$|[?:]\s*\(\s*$|[;=]/.test(m[1]) && !/^,|:$|\?$/.test(t)) out.push(t);
  }
  for (const m of code.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*[A-Za-z]{2}[^"]*)"/g)) out.push(`${m[1]}="${m[2]}"`);
  return out;
}

// The sender's files whose every word goes through T() now. A file joins this list when it is done; the rest are
// named in README "What is not in it".
const DONE = ['src/components/AppShell.tsx', 'src/components/AppNav.tsx', 'src/app/app/page.tsx', 'src/components/settings/ScreenLanguage.tsx', 'src/components/senderLang.tsx'];

test('the finished sender screens show no English written into the code, and every key they ask for is in en.json', () => {
  for (const f of DONE) assert.deepEqual(untranslated(read(f)), [], f);
  for (const f of DONE) {
    for (const m of read(f).matchAll(/\bT\(\s*'([a-z0-9_.]+)'/g)) assert.ok(Object.hasOwn(en, m[1]), `${f}: ${m[1]}`);
    for (const m of read(f).matchAll(/senderRich\([a-zA-Z.]+, '([a-z0-9_.]+)'/g)) assert.ok(Object.hasOwn(en, m[1]), `${f}: ${m[1]}`);
  }
  // Every entry of the navigation has a key, and its English text is the label the tests and titles use.
  for (const n of [NAV_START, ...NAV_MAIN, ...NAV_MORE, NAV_KEY_DATES, NAV_COUNTER, ...NAV_END]) {
    assert.ok(n.key && Object.hasOwn(en, n.key), n.label);
    assert.equal(en[n.key!], n.label);
  }
});

test('the test languages work on the sender screens: longer, right to left, placeholders and plurals kept', () => {
  const long = senderT('en-XA', 'home.drafts', { count: 3 });
  assert.match(long, /^\[.*3.*~+\]$/);
  assert.notEqual(long, senderT('en', 'home.drafts', { count: 3 }));
  assert.match(senderT('ar-XB', 'home.hello', { name: 'Ada' }), /Ada/);
  assert.equal(senderLocale({ pseudo: 'ar-XB', chosen: 'en' }), 'ar-XB');
  assert.equal(howLongIn('en', new Date(Date.now() - 3 * 86400_000 - 1000).toISOString()), '3 days');
  assert.equal(howLongIn('en', new Date(Date.now() - 3600_000 - 1000).toISOString()), '1 hour');
  assert.equal(howLongIn('en', new Date().toISOString()), 'less than an hour');
  assert.equal(joinIn('en', ['you', 'Sam']), 'you and Sam');
  assert.equal(joinIn('en', ['A', 'B', 'C']), 'A, B and C');
  assert.equal(joinIn('en', ['A', 'B', 'C', 'D', 'E']), 'A, B and 3 others');
  assert.equal(joinIn('en', ['A', 'B', 'C', 'D']), 'A, B and 2 others');
});

// ---- 4. The comment digest to the sender -------------------------------------------------------------------------

test('the comment digest to a sender: English as before, and in the sender\'s language with the comment as written', async () => {
  const { flushComments } = await import('../src/server/routes-comments.ts');
  const { COMMENTS_NOT_SIGNED } = await import('../src/lib/policy.ts');
  const { pinWords } = await import('../src/lib/comments.ts');
  const { pinIn } = await import('../src/server/senderlocale.ts');
  // pinIn says in English exactly what pinWords says.
  for (const [x, y] of [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9], [0.1, 0.9], [0.9, 0.1], [0.5, 0.1], [null, null]] as const)
    for (const docs of [1, 2]) assert.equal(pinIn('en', { document: 'Lease', page: 1, x, y }, docs), pinWords({ document_id: 'd', document: 'Lease', page: 1, x, y } as any, docs));
  assert.equal(en['mail.sender.comments.not_signed'], COMMENTS_NOT_SIGNED);
  const ask = async (c: Client, email: string, words: string) => {
    const e = await sent(c, email);
    const s = new Client();
    s.ip = '198.51.100.141';
    const tok = tokenFor(e.id, email);
    await s.post(`/sign/${tok}/consent`);
    const r = await s.post(`/sign/${tok}/comments`, { text: words, for: 'everyone', pin: { document_id: e.documents[0].id, page: 0, x: 0.8, y: 0.1 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await flushComments(e.id);
    return e;
  };
  await ask(ada, 'lsd.ask@example.com', 'Is the deposit refundable?');
  const m = lastTo('ada.langsender@example.com', 'Questions and comments:%');
  assert.ok(m);
  assert.equal(m.locale, null);
  const body = text(m.html);
  assert.ok(body.includes('Sam Signer wrote about "Simple agreement"'), body);
  assert.ok(body.includes('Sam Signer, for everyone on the document, about page 1, near the top on the right: Is the deposit refundable?'), body);
  assert.ok(body.includes(COMMENTS_NOT_SIGNED));
  assert.ok(body.includes('We send at most one email like this every 10 minutes for each document.'));
  await withFrench(testFrench(), async () => {
    const fay = await signUp('Fay Sender', 'fay.langsender@example.com', '198.51.100.126');
    await patchMe(fay, { locale: 'fr' });
    await ask(fay, 'lsd.ask2@example.com', 'Le dépôt est-il remboursable ?');
    const f = lastTo('fay.langsender@example.com', 'FR Questions and comments:%');
    assert.ok(f, 'digest in French');
    assert.equal(f.locale, 'fr');
    const b = text(f.html);
    assert.ok(b.includes('Le dépôt est-il remboursable ?'), 'the comment is as written');
    assert.ok(b.includes('FR page 1, near the top on the right'), b);
    assert.ok(b.includes("FR Answer on the document's page"), b);
  });
});

test('a refusal on a sender screen is said from its code in the sender\'s language, else in the server\'s words', async () => {
  const { senderError } = await import('../src/lib/senderlang.ts');
  const r = await patchMe(ada, { locale: 'zz' });
  const e = Object.assign(new Error(r.data.error), { code: r.data.code, data: r.data });
  assert.equal(senderError('en', e), en['sender.error.sender_locale']);
  assert.match(senderError('en-XA', e), /^\[/);
  assert.equal(senderError('en', Object.assign(new Error('Server words.'), { code: 'no_such_code' })), 'Server words.');
  assert.equal(senderError('en', new TypeError('')), en['sender.error.offline']);
});

// ---- Repairs after review (tests/out/verify-ds-lang-sender, tests/out/ux-ds-lang-sender) ----------------------------

test('a text with bold parts keeps every digit of a plain variable and of the words (an account called "Studio 54")', async () => {
  const { senderRichPieces } = await import('../src/lib/senderlang.ts');
  const draw = (account: string) => senderRichPieces('en', 'shell.impact', ['sheets'], { account }).map((p, i) => (i % 2 ? `<${p}>` : p)).join('');
  assert.equal(draw('Studio 54'), '<sheets> sheets of paper saved by Studio 54, by our estimate');
  assert.equal(draw('Team 0'), '<sheets> sheets of paper saved by Team 0, by our estimate');
  assert.equal(draw("Rosa Studio 54's workspace 1 2"), "<sheets> sheets of paper saved by Rosa Studio 54's workspace 1 2, by our estimate");
  // In a test language too, and a part given twice is not mixed up with a number.
  const long = senderRichPieces('en-XA', 'shell.impact', ['sheets'], { account: 'Room 101' });
  assert.equal(long.filter((_, i) => i % 2).join(','), 'sheets');
  assert.ok(long.join('').includes('101'), long.join(''));
  // The component draws from these pieces, with no bare-digit markers left of its own.
  const comp = read('src/components/senderLang.tsx');
  assert.match(comp, /senderRichPieces\(lang, key, Object\.keys\(parts\), vars\)/);
  assert.doesNotMatch(comp, /split\(\/\(\\d\+\)\//);
});

test('PATCH /me "locale": a browser\'s regional tag means its language, a test language never does', async () => {
  assert.equal(askedSenderLocale('en-US'), 'en');
  assert.equal(askedSenderLocale('en_GB'), 'en');
  assert.equal(askedSenderLocale('EN'), 'en');
  for (const bad of ['en-XA', 'ar-XB', 'fr-CA', 'fr']) assert.throws(() => askedSenderLocale(bad), /Nothing was changed\./, bad);
  const r = await patchMe(ada, { locale: 'en-US' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.locale, 'en');
  await patchMe(ada, { locale: '' });
  await withFrench(testFrench(), async () => {
    assert.equal(askedSenderLocale('fr-CA'), 'fr');
    assert.throws(() => askedSenderLocale('de-DE'), /Nothing was changed\./);
  });
});

test('the language card saves when the select changes, says "Saved" next to it, and promises only what is translated', () => {
  const card = read('src/components/settings/ScreenLanguage.tsx');
  assert.doesNotMatch(card, /<button/, 'no separate Save button for one select');
  assert.match(card, /useSaved\(T\('sender\.language\.saved'\)\)/);
  assert.match(card, /onChange=\{\(e\) => save\(e\.target\.value\)\}/);
  assert.doesNotMatch(card, /toast\(T\('sender\.language\.saved'/, 'no toast in the language just left');
  assert.equal(en['sender.language.saved'], 'Saved');
  assert.ok(!Object.hasOwn(en, 'sender.language.button'));
  // The hint says what changes today and that the rest stays English; nothing claims who made a draft.
  assert.match(en['sender.language.hint'], /Other screens stay in English/);
  assert.doesNotMatch(en['sender.language.hint'], /^Your own screens/);
  assert.doesNotMatch(en['sender.language.draft_note'], /machine/);
});

test('the empty Home says where to start in one whole sentence per layout, with no "left" that a right-to-left page mirrors', () => {
  for (const k of ['home.empty.wide', 'home.empty.phone']) {
    assert.match(en[k], /^Press \{button\} .* to start\. Upload a PDF, add who needs to sign and place the fields\. It takes about a minute\.$/, k);
    assert.doesNotMatch(en[k], /\bleft\b|\bright\b/, k);
  }
  for (const gone of ['home.empty.press', 'home.empty.steps']) assert.ok(!Object.hasOwn(en, gone), gone);
  const home = read('src/app/app/page.tsx');
  assert.match(home, /senderRich\(T\.lang, 'home\.empty\.wide'/);
  assert.match(home, /senderRich\(T\.lang, 'home\.empty\.phone'/);
});
