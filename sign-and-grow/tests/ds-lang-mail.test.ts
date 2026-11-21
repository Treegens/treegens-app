// What a recipient receives, in their language (research/docusign-gaps.json, batch "lang-mail"): our words in emails
// and texts come from en.json in the language decided for that person, the sender's words never change, the language
// is kept on the email row, text messages count their parts the way phones do, and the public pages a signer reaches
// from an email follow the browser. Only English is switched on: a test that needs a second language switches French
// on with a test catalogue and puts it back, so nothing here pretends a language ships.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, Client, simple, signUp, mailTo, upload, type Server } from './helpers.ts';
import { SUPPORTED_LOCALES, CATALOGUES, parseMessage, placeholders } from '../src/lib/i18n.ts';
import { cannotOpenLine } from '../src/lib/policy.ts';
import { renderMail } from '../src/server/mail.ts';
import { mailLocale, mailHtml, theirWords } from '../src/server/maillang.ts';
import { textParts, plainSigns, sentParts } from '../src/lib/smsparts.ts';
import { sendText, textsLeft } from '../src/server/sms.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const en: Record<string, string> = JSON.parse(read('src/locales/en.json'));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

let db: Server['db'];
let ada: Client;
before(async () => {
  ({ db } = await boot());
  ada = await signUp('Ada Sender', 'ada.langmail@example.com', '198.51.100.81');
});

/** A language switched on for one test, with a catalogue of its own, and put back afterwards whatever happens. */
async function withLanguage(tag: string, words: Record<string, string>, run: () => Promise<void>) {
  let lang = SUPPORTED_LOCALES.find((l) => l.tag === tag);
  const added = !lang;
  if (!lang) SUPPORTED_LOCALES.push((lang = { tag, english: tag, own: tag, ui: 'reviewed', legal: 'missing', shipped: true, mail: true }));
  const was = { ...lang };
  Object.assign(lang, { shipped: true, ui: 'reviewed', legal: 'missing', mail: true });
  CATALOGUES[tag] = words;
  try {
    await run();
  } finally {
    Object.assign(lang, was);
    if (!('mail' in was)) delete lang.mail;
    if (added) SUPPORTED_LOCALES.splice(SUPPORTED_LOCALES.indexOf(lang), 1);
    delete CATALOGUES[tag];
  }
}
/** A test French: every text of ours that starts with `prefix`, marked "FR " in front, with its placeholders kept. */
const testFrench = (prefix = 'mail.') => Object.fromEntries(Object.entries(en).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, `FR ${v}`]));

const sendTo = async (email: string, over: any = {}, recipient: any = {}) => {
  const e = await simple(ada, email, { message: 'Bitte unterschreiben Sie bis Freitag. Danke!', recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email, ...recipient }], ...over });
  const r = await ada.post(`/envelopes/${e.id}/send`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return e;
};
const lastTo = (email: string) => db.get('SELECT * FROM emails WHERE to_email=? ORDER BY id DESC LIMIT 1', email);

// ---- 1. The email itself ------------------------------------------------------------------------------------------

test('every mail text in en.json reads, and the footer line about a page that will not open is the one policy.ts says', () => {
  const keys = Object.keys(en).filter((k) => k.startsWith('mail.'));
  assert.ok(keys.length >= 50, `found ${keys.length}`);
  for (const k of keys) assert.doesNotThrow(() => parseMessage(en[k]), k);
  assert.equal(CATALOGUES.en['mail.footer.cannot_open'].replace('{sender}', 'Ada'), cannotOpenLine('Ada'));
  // Every key the mail code asks for is in en.json: a key that is not would print nothing.
  for (const f of ['src/server/mail.ts', 'src/server/maillang.ts', 'src/server/requestmail.ts', 'src/server/envelopes.ts', 'src/server/sms.ts', 'src/server/signercode.ts', 'src/server/routes-signercode.ts'].filter((f) => fs.existsSync(path.join(root, f))))
    for (const m of read(f).matchAll(/\bmt\([^,()]+, '([a-z0-9_.]+)'/g)) assert.ok(Object.hasOwn(en, m[1]), `${f} asks for "${m[1]}", which en.json does not have`);
  // No em dashes in our words.
  for (const k of keys) assert.ok(!en[k].includes('—'), k);
});

test('an English email is unchanged: lang and dir on the html, the footer word for word', () => {
  const html = renderMail({ to: 'x@example.com', subject: 'S', heading: 'H', lines: ['L'], cta: { label: 'Go', url: 'https://example.com/sign/abc' }, code: 'ABCDEFGH', askForPdf: 'Ada', envelopeId: 'e1' });
  assert.match(html, /^<!doctype html><html lang="en" dir="ltr">/);
  const t = text(html);
  for (const s of ['Not sure this email is real? Type', '/check into your browser and enter ABCD-EFGH . We never ask for a password or a payment by email. Report this email',
    'If the button does not work, copy this link: https://example.com/sign/abc', cannotOpenLine('Ada'), 'The link is personal to you. Do not forward this email.', 'Get help with this document', 'Sent with GrowSigning.'])
    assert.ok(t.includes(s), `missing: ${s}\n${t}`);
});

test('the footer in another language: every fixed part from its catalogue, html parts kept, nothing escaped twice', async () => {
  await withLanguage('fr', testFrench(), async () => {
    const html = renderMail({ to: 'x@example.com', subject: 'S', heading: 'H', lines: ['L'], cta: { label: 'Go', url: 'https://example.com/sign/abc' }, code: 'ABCDEFGH', askForPdf: 'Ada <Boss>', envelopeId: 'e1', locale: 'fr' });
    assert.match(html, /<html lang="fr" dir="ltr">/);
    const t = text(html);
    for (const k of ['not_sure', 'never_ask', 'report', 'personal', 'get_help', 'sent_with']) assert.ok(t.includes(`FR ${en[`mail.footer.${k}`]}`), k);
    assert.match(t, /FR Type \S+\/check into your browser and enter ABCD-EFGH \./);
    assert.ok(t.includes('FR Page will not open where you are? Reply to this email and ask Ada <Boss> to send'), 'the name once escaped, shown as written');
    assert.ok(!html.includes('&amp;lt;'), 'never escaped twice');
    // A right-to-left language turns the email round.
  });
  await withLanguage('ar', testFrench(), async () => {
    assert.match(renderMail({ to: 'x@example.com', subject: 'S', heading: 'H', lines: [], locale: 'ar' }), /<html lang="ar" dir="rtl">/);
  });
  // A placeholder value that looks like html stays text.
  assert.equal(mailHtml('en', 'mail.footer.need_hand', {}, { url: '<b>x</b>' }), 'Need a hand? &lt;b&gt;x&lt;/b&gt;');
});

test('the sender\'s own words are set apart under one line saying whose words they are, in every language', () => {
  assert.equal(theirWords('en', 'Ada', 'Hello'), '\u2063Ada\'s message:\nHello');
  // In the email: a quote with a line down its left side, the label in bold above the words, both escaped.
  const html = renderMail({ to: 'x@example.com', subject: 'S', heading: 'H', lines: ['Ours.', theirWords('en', 'Ada <b>', 'Line one\n<script>x</script>')] } as any);
  assert.match(html, /<div style="margin:0 0 14px;border-left:3px solid #cfd8d2;padding-left:12px"><p style="font-size:13px[^"]*font-weight:600[^"]*">Ada &lt;b&gt;&#39;s message:<\/p><p style="[^"]*white-space:pre-wrap[^"]*">Line one\n&lt;script&gt;x&lt;\/script&gt;<\/p><\/div>/);
  assert.ok(!html.includes('\u2063'), 'the sign never reaches the reader');
  // Our own lines read exactly as before.
  assert.ok(html.includes('<p style="font-size:15px;line-height:1.55;margin:0 0 14px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word">Ours.</p>'));
});

test('a long link in a footnote or the footer wraps, so the email is never wider than a phone', () => {
  const html = renderMail({ to: 'x@example.com', subject: 'S', heading: 'H', lines: ['x'], footnote: `Too many reminders? ${'https://growsigning.com/mute/'}${'a'.repeat(80)}`, cta: { label: 'Go', url: `https://growsigning.com/sign/${'b'.repeat(43)}` }, code: 'ABCD2345EFGH', envelopeId: 'e' } as any);
  assert.match(html, /<p style="font-size:12px;color:#6b776f;margin:18px 0 0;line-height:1.5;overflow-wrap:anywhere;word-break:break-word">Too many reminders/);
  assert.match(html, /<p style="font-size:12px;color:#6b776f;line-height:1.6;padding:16px 4px 0;overflow-wrap:anywhere;word-break:break-word">/);
});

// ---- 2. Emails to recipients carry the recipient's language --------------------------------------------------------

test('a request and a reminder in a test French: our lines translated, the sender\'s subject and message untouched, the language on the row', async () => {
  await withLanguage('fr', testFrench(), async () => {
    const e = await sendTo('lm.fr@example.com', { subject: 'Mietvertrag Wohnung 3' }, { locale: 'fr' });
    const row = lastTo('lm.fr@example.com');
    assert.equal(row.locale, 'fr');
    assert.equal(row.subject, 'FR Mietvertrag Wohnung 3');
    const t = text(row.html);
    assert.ok(t.includes('FR Ada Sender sent you a document to sign'), t);
    assert.ok(t.includes('FR Ada Sender\'s message: Bitte unterschreiben Sie bis Freitag. Danke!'), 'the message as written, under our line');
    assert.ok(t.includes('Mietvertrag Wohnung 3'), 'the subject as written');
    assert.ok(t.includes('FR Review and sign'), 'the button');
    assert.ok(t.includes('FR Reply to this email to reach Ada Sender (ada.langmail@example.com).'));
    assert.ok(t.includes(`FR ${en['mail.footer.not_sure']}`), 'the footer');
    // No line of ours in English: every paragraph is the subject, the sender's words, or ours marked FR.
    const paras = [...row.html.matchAll(/<p style="font-size:15px[^>]*>([\s\S]*?)<\/p>/g)].map((m) => text(m[1]).trim());
    for (const p of paras) assert.ok(p === 'Mietvertrag Wohnung 3' || p === 'Bitte unterschreiben Sie bis Freitag. Danke!' || p.startsWith('FR '), `English line in a French email: ${p}`);
    assert.match(JSON.parse(row.payload).text, /FR Not sure this email is real\? Go to /, 'the text part too');

    assert.equal((await ada.post(`/envelopes/${e.id}/remind`)).status, 200);
    const again = lastTo('lm.fr@example.com');
    assert.equal(again.subject, 'FR Reminder: Mietvertrag Wohnung 3');
    assert.ok(text(again.html).includes('FR Too many reminders? Stop them for this document:'), 'the footnote');
    assert.equal(again.locale, 'fr');
  });
});

test('with a catalogue that says the same as English, the translated email is the English email word for word', async () => {
  // en-GB switched on with the English words: the email is written by requestmail.ts and must match notifyRecipient.
  await withLanguage('en-GB', { ...en }, async () => {
    for (const [i, over, who] of [[1, {}, {}], [2, { expires_at: new Date(Date.now() + 5 * 864e5).toISOString() }, { note: 'Bring your ID' }], [3, {}, { role: 'approver' }], [4, {}, { role: 'viewer' }], [5, {}, { access_code: '1234' }]] as const) {
      const a = await sendTo(`lm.same${i}a@example.com`, over, who);
      const b = await sendTo(`lm.same${i}b@example.com`, over, { ...who, locale: 'en-GB' });
      const ra = lastTo(`lm.same${i}a@example.com`), rb = lastTo(`lm.same${i}b@example.com`);
      assert.equal(rb.locale, 'en-GB');
      const norm = (row: any, id: string, email: string) => row.html.replace(/<html [^>]*>/, '<html>').replaceAll(db.get('SELECT token FROM recipients WHERE envelope_id=?', id).token, 'TOKEN').replaceAll(db.get('SELECT check_code FROM recipients WHERE envelope_id=?', id).check_code.replace(/(.{4})(?=.)/g, '$1-'), 'CODE').replaceAll(db.get('SELECT check_code FROM recipients WHERE envelope_id=?', id).check_code, 'CODE').replaceAll(email, 'EMAIL');
      assert.equal(norm(rb, b.id, `lm.same${i}b@example.com`), norm(ra, a.id, `lm.same${i}a@example.com`), `case ${i}`);
      assert.equal(rb.subject, ra.subject);
      await ada.post(`/envelopes/${a.id}/remind`);
      await ada.post(`/envelopes/${b.id}/remind`);
      assert.equal(norm(lastTo(`lm.same${i}b@example.com`), b.id, `lm.same${i}b@example.com`), norm(lastTo(`lm.same${i}a@example.com`), a.id, `lm.same${i}a@example.com`), `reminder ${i}`);
    }
  });
});

test('an English recipient and a sender get English, and no language is stored for them', async () => {
  await withLanguage('fr', testFrench(), async () => {
    await sendTo('lm.en@example.com');
    const row = lastTo('lm.en@example.com');
    assert.equal(row.locale, null);
    assert.ok(!text(row.html).includes('FR '), 'nothing from the French catalogue');
    assert.ok(text(row.html).includes("Ada Sender's message: Bitte"), 'the same line in English');
    const toSender = db.get("SELECT * FROM emails WHERE to_email='ada.langmail@example.com' ORDER BY id DESC LIMIT 1");
    if (toSender) assert.equal(toSender.locale, null, 'emails to senders stay English (lang-sender)');
  });
});

test('mailLocale: the language set for the person, else the one they read the page in, else English; never one that is off', async () => {
  assert.equal(mailLocale({}), 'en');
  assert.equal(mailLocale({ locale: 'fr' }), 'en', 'French is not switched on');
  await withLanguage('fr', {}, async () => {
    assert.equal(mailLocale({ locale: 'fr' }), 'fr');
    assert.equal(mailLocale({ page_locale: 'fr-CA' }), 'fr');
    assert.equal(mailLocale({ locale: 'xx' }), 'en');
  });
});

// ---- 3. Text messages ------------------------------------------------------------------------------------------------

test('text parts: GSM letters 160 a text and 153 a part, one letter outside them makes it UCS-2 at 70 and 67', () => {
  assert.deepEqual(textParts('a'.repeat(160)), { encoding: 'gsm7', units: 160, parts: 1 });
  assert.deepEqual(textParts('a'.repeat(161)), { encoding: 'gsm7', units: 161, parts: 2 });
  assert.equal(textParts('a'.repeat(306)).parts, 2);
  assert.equal(textParts('a'.repeat(307)).parts, 3);
  // The extension signs take two places: 80 euro signs fill one text.
  assert.equal(textParts('€'.repeat(80)).parts, 1);
  assert.equal(textParts('€'.repeat(81)).parts, 2);
  // An accented letter GSM has (é) keeps it GSM; one it lacks (ç lower case is not in it, ê is not) does not.
  assert.equal(textParts(`${'a'.repeat(150)}é`).encoding, 'gsm7');
  assert.deepEqual(textParts(`${'a'.repeat(69)}ê`), { encoding: 'ucs2', units: 70, parts: 1 });
  assert.equal(textParts(`${'a'.repeat(70)}ê`).parts, 2);
  const arabic = 'رمزك لفتح المستند من آدا هو ١٢٣٤٥٦. يعمل لمدة عشر دقائق. إذا لم تطلبه فتجاهل هذه الرسالة.';
  assert.equal(textParts(arabic).encoding, 'ucs2');
  assert.equal(textParts(arabic).parts, Math.ceil(arabic.length / 67));
  // An emoji is two UTF-16 units.
  assert.equal(textParts('😀'.repeat(35)).parts, 1);
  assert.equal(textParts('😀'.repeat(36)).parts, 2);
});

test('a text in Arabic is written from the catalogue, counted in UCS-2 parts on the row and against the daily limit', async () => {
  const was = { o: process.env.SMS_DEV_OUTBOX, d: process.env.SMS_DAILY_PER_ACCOUNT };
  process.env.SMS_DEV_OUTBOX = '1';
  process.env.SMS_DAILY_PER_ACCOUNT = '200';
  try {
    const words = { ...testFrench('text.'), 'text.link.new.signer': 'رسالة من GrowSigning نيابة عن {sender}: المستند {doc} ينتظر توقيعك. افتح الرابط وقّع عليه عندما تكون مستعدا، وشكرا لك على وقتك. {url}' };
    await withLanguage('ar', words, async () => {
      const e = await sendTo('lm.ar@example.com', { subject: 'Lease' }, { locale: 'ar', phone: '+447700900123', text_link: true });
      const row = db.get('SELECT * FROM texts WHERE envelope_id=? ORDER BY id DESC LIMIT 1', e.id);
      assert.ok(row, 'a text was written');
      assert.match(row.body, /^رسالة من GrowSigning نيابة عن Ada Sender: المستند "Lease" ينتظر توقيعك/);
      assert.equal(textParts(row.body).encoding, 'ucs2');
      assert.ok(row.parts >= 3, `parts ${row.parts}`);
      assert.equal(row.parts, textParts(row.body).parts);
      const used = db.get('SELECT parts FROM sms_usage WHERE account_id=? ORDER BY id DESC LIMIT 1', e.account_id);
      assert.equal(used.parts, row.parts, 'the daily limit counts parts');
      // The email to the same person is in Arabic too.
      assert.equal(lastTo('lm.ar@example.com').locale, 'ar');
    });
    // An English text with the same facts is one GSM part, and reads as before.
    const e2 = await sendTo('lm.ar.en@example.com', { subject: 'Lease' }, { phone: '+447700900124', text_link: true });
    const t2 = db.get('SELECT * FROM texts WHERE envelope_id=? ORDER BY id DESC LIMIT 1', e2.id);
    assert.match(t2.body, /^GrowSigning, sent for Ada Sender: "Lease" is waiting for you to sign\. http/);
    assert.equal(t2.parts, 1);
  } finally {
    for (const [k, v] of [['SMS_DEV_OUTBOX', was.o], ['SMS_DAILY_PER_ACCOUNT', was.d]] as const) v == null ? delete process.env[k] : (process.env[k] = v);
  }
});

test('textsLeft counts parts: a limit of 4 is used up by one Arabic text of 4 parts', async () => {
  const was = { o: process.env.SMS_DEV_OUTBOX, d: process.env.SMS_DAILY_PER_ACCOUNT };
  process.env.SMS_DEV_OUTBOX = '1';
  try {
    const bob = await signUp('Bob Sender', 'bob.langmail@example.com', '198.51.100.82');
    const acct = db.get('SELECT account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?', 'bob.langmail@example.com').account_id;
    process.env.SMS_DAILY_PER_ACCOUNT = '4';
    const long = 'ا'.repeat(67 * 4);
    await sendText({ to: '+447700900125', text: long, accountId: acct, kind: 'link' });
    assert.equal(textsLeft(acct), 0);
    void bob;
  } finally {
    for (const [k, v] of [['SMS_DEV_OUTBOX', was.o], ['SMS_DAILY_PER_ACCOUNT', was.d]] as const) v == null ? delete process.env[k] : (process.env[k] = v);
  }
});

// The daily limit is a hard stop in parts (repair-lang-mail, skeptic probe P2): a text goes only when all of its
// parts fit in what is left, and a send to several people at once adds up the parts of every text it would send.
const smsEnv = async (limit: string, run: () => Promise<void>) => {
  const was = { o: process.env.SMS_DEV_OUTBOX, d: process.env.SMS_DAILY_PER_ACCOUNT };
  process.env.SMS_DEV_OUTBOX = '1';
  process.env.SMS_DAILY_PER_ACCOUNT = limit;
  try {
    await run();
  } finally {
    for (const [k, v] of [['SMS_DEV_OUTBOX', was.o], ['SMS_DAILY_PER_ACCOUNT', was.d]] as const) v == null ? delete process.env[k] : (process.env[k] = v);
  }
};
const accountOfEmail = (email: string) => db.get('SELECT account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?', email).account_id;

test('the daily text limit is never overshot: 1 part left refuses a 5 part text, with the count in parts', async () => {
  const cy = await signUp('Cy Parts', 'cy.parts.langmail@example.com', '198.51.100.85');
  const acct = accountOfEmail('cy.parts.langmail@example.com');
  await smsEnv('4', async () => {
    for (let i = 0; i < 3; i++) await sendText({ to: `+44770090030${i}`, text: 'hi', accountId: acct, kind: 'link' });
    assert.equal(textsLeft(acct), 1);
    await withLanguage('ar', { 'text.link.new.signer': `${'ا'.repeat(250)} {sender} {doc} {url}` }, async () => {
      const e = await simple(cy, 'lm.parts@example.com', { recipients: [{ id: 'r', role: 'signer', name: 'Sam', email: 'lm.parts@example.com', locale: 'ar', phone: '+447700900310', text_link: true }] });
      const r = await cy.post(`/envelopes/${e.id}/send`);
      assert.equal(r.status, 429, JSON.stringify(r.data));
      assert.match(r.data.error, /This would use [56] text message parts, and this account has 1 left today \(the limit is 4 parts in 24 hours\)\. The limit counts text message parts/);
      assert.match(r.data.error, /Nothing was sent\./);
      assert.equal(db.get('SELECT COUNT(*) n FROM texts WHERE envelope_id=?', e.id).n, 0);
    });
    assert.equal(textsLeft(acct), 1, 'nothing more was counted');
  });
});

test('a send to three people with 2 parts left is refused before anything goes, not half sent', async () => {
  const di = await signUp('Di Parts', 'di.parts.langmail@example.com', '198.51.100.86');
  const acct = accountOfEmail('di.parts.langmail@example.com');
  db.run('UPDATE accounts SET trusted_at=? WHERE id=?', new Date().toISOString(), acct);
  await smsEnv('2', async () => {
    const people = [1, 2, 3].map((i) => ({ id: `r${i}`, role: 'signer', name: `Sam ${i}`, email: `lm.three${i}@example.com`, phone: `+44770090032${i}`, text_link: true }));
    const e = await simple(di, 'lm.three1@example.com', { recipients: people, fields: people.map((p, i) => ({ id: `f${i}`, document_id: 'd', recipient_id: p.id, type: 'signature', page: 0, x: 0.1, y: 0.2 + i * 0.2, w: 0.3, h: 0.06 })) });
    const r = await di.post(`/envelopes/${e.id}/send`);
    assert.equal(r.status, 429, JSON.stringify(r.data));
    assert.match(r.data.error, /This would use 3 text message parts, and this account has 2 left today/);
    assert.equal(db.get('SELECT COUNT(*) n FROM texts WHERE account_id=?', acct).n, 0);
    assert.equal(textsLeft(acct), 2);
  });
});

test('a curly apostrophe or long dash in a subject is made plain, so an English text stays 1 part', async () => {
  assert.equal(plainSigns('Jo\u2019s \u201Clease\u201D \u2013 flat 3\u2026'), 'Jo\'s "lease" - flat 3...');
  // Letters are never changed, only the signs.
  assert.equal(plainSigns('عقد Zoë Łukasz'), 'عقد Zoë Łukasz');
  const body = 'GrowSigning, sent for Ada Sender: "Jo\u2019s lease" is waiting for you to sign. https://growsigning.com/sign/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  assert.equal(textParts(body).encoding, 'ucs2');
  assert.equal(sentParts(body), 1);
  await smsEnv('200', async () => {
    const e = await sendTo('lm.curly@example.com', { subject: 'Jo\u2019s lease \u2013 flat 3' }, { phone: '+447700900330', text_link: true });
    const row = db.get('SELECT * FROM texts WHERE envelope_id=? ORDER BY id DESC LIMIT 1', e.id);
    assert.match(row.body, /"Jo's lease - flat 3"/);
    assert.equal(row.parts, 1);
  });
});

test('a one-time code by email in a test French: every line from the catalogue, and our copy still loses the code', async () => {
  // A French that puts the code at the end of the heading, as a real language might.
  const words = { ...testFrench(), 'mail.code.heading': 'FR Votre code : {code}' };
  await withLanguage('fr', words, async () => {
    const e = await sendTo('lm.code@example.com', {}, { locale: 'fr', verify: 'email_code' });
    const tok = db.get('SELECT token FROM recipients WHERE envelope_id=?', e.id).token;
    const asked = await new Client('198.51.100.83').post(`/sign/${tok}/code`);
    assert.equal(asked.status, 200, JSON.stringify(asked.data));
    const row = lastTo('lm.code@example.com');
    assert.equal(row.locale, 'fr');
    assert.equal(row.subject, 'FR Your code to open a document from Ada Sender');
    const code = /FR Votre code : (\d{6})/.exec(row.html)?.[1];
    assert.ok(code, 'the code is in the heading');
    for (const p of [...row.html.matchAll(/<p style="font-size:15px[^>]*>([\s\S]*?)<\/p>/g)].map((m) => text(m[1]).trim())) assert.ok(p.startsWith('FR '), p);
    // Once the mail server takes it on a later try, our copy loses the code, whatever language it is in.
    await (globalThis as any).__tsmailListeners.signercode({ id: row.id, envelope_id: e.id }, 'sent');
    const after = db.get('SELECT html, payload FROM emails WHERE id=?', row.id);
    assert.ok(!after.html.includes(code) && !after.payload.includes(code), 'the code is gone from our copy');
    assert.match(after.html, /FR Votre code : \(removed\)/);
  });
});

// ---- 5. The fake-notice filter ---------------------------------------------------------------------------------------

test('the fake-notice filter reads the sender\'s words the same for a recipient in another language: refused, nothing written', async () => {
  const LURE = 'Your payment of $499.00 was charged. To cancel call +1 (888) 555-0142 now.';
  await withLanguage('fr', testFrench(), async () => {
    const posing = await signUp('PayPal Billing', 'billing.langmail@scam.test', '198.51.100.84');
    const e = await simple(posing, 'lm.victim@example.com', { subject: 'Invoice #4471', message: LURE, recipients: [{ id: 'r', role: 'signer', name: 'Vic', email: 'lm.victim@example.com', locale: 'fr' }] });
    const refused = await posing.post(`/envelopes/${e.id}/send`);
    assert.equal(refused.status, 422);
    assert.equal(mailTo('lm.victim@example.com').length, 0, 'no email, in any language');
  });
});

test('a language switched on for screens but not marked ready for mail: every email to that person stays English', async () => {
  await withLanguage('fr', testFrench(), async () => {
    const fr = SUPPORTED_LOCALES.find((l) => l.tag === 'fr')!;
    fr.mail = false;
    try {
      assert.equal(mailLocale({ locale: 'fr' }), 'en');
      await sendTo('lm.notready@example.com', {}, { locale: 'fr' });
      const row = lastTo('lm.notready@example.com');
      assert.equal(row.locale, null);
      assert.ok(!text(row.html).includes('FR '), 'not one line from the French catalogue');
    } finally {
      fr.mail = true;
    }
  });
  // Nothing ships ready for mail today, because some recipient emails have no keys yet.
  assert.deepEqual(SUPPORTED_LOCALES.filter((l) => l.mail).map((l) => l.tag), []);
});

test('a sender cannot smuggle a language: one that is not switched on is refused before anything is written', async () => {
  const file = await upload(ada, 1);
  const r = await ada.post('/envelopes', { subject: 'S', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam', email: 'lm.smuggle@example.com', locale: 'fr' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /not available yet/);
  // A language stored on a row by hand that is not switched on is never used: the email is English.
  assert.equal(mailLocale({ locale: 'fr', page_locale: 'fr' }), 'en');
});
