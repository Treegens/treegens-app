// What the product says to people outside the United States, and whether it is true. Every test here pins down
// something from research/gaps-partial.json ("map:nonus": the false promises about wording, law, price and language,
// and the needs with priority 1, 8, 12, 13, 14, 16, 19, 20, 21, 22 and 24). Each failed before its fix.
// Wording that both a page and the server use lives in src/lib (policy.ts, paperwork.ts, dataplace.ts, impact.ts),
// so most of it is tested as plain functions. Where a promise is only words on a page, the source of the page is read.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, simple, tokenFor, signUp, mailTo, type Server } from './helpers.ts';
import { CONSENT_VERSION, consentWording, consentPlain, isConsentVersion, adoptLine, LANGUAGE_NOTE } from '../src/lib/policy.ts';
import { usd, CURRENCY_NOTE } from '../src/lib/impact.ts';
import { PDFDocument } from 'pdf-lib';
import { paperWarnings, paperAuditNote, paperWordList, PAPER_KINDS, PAPER_TAIL, STAMP_ZONES, stampNote, COUNTRY_NOTES } from '../src/lib/paperwork.ts';
import { PAPER_AUDIT_ACTION } from '../src/server/warnings.ts';
import { dataPlace, dataPlaceWarning, notSaid } from '../src/lib/dataplace.ts';
import { MAIL_COPY_DAYS, CLOSE_GRACE_DAYS } from '../src/lib/policy.ts';
import { cannotOpenLine } from '../src/lib/policy.ts';
import { renderMail } from '../src/server/mail.ts';
import { PNG, upload } from './helpers.ts';
import { extractText } from '../src/server/text.ts';
import { isChargeable } from '../src/server/credits.ts';
import { bySenderProblem, reachKey, reporterKey } from '../src/server/bysender.ts';
import { labelOf, BY_SENDER_LINE, BY_SENDER_TICK, BY_SENDER_HOW, noEmailCopyText, noEmailWaitText, signerAt } from '../src/lib/bysender.ts';
import { checkLine } from '../src/lib/checks.ts';
import { whoIs, certName } from '../src/lib/groups.ts';
import { englishIf } from './words.ts';

let db: Server['db'];
let env: Server['env'];
let ada: Client;
before(async () => {
  ({ db, env } = await boot());
  ada = await signUp('Ada Sender', 'ada.sender@example.com', '198.51.100.201');
});

// Screens moved into the catalogue are read with their English put back (lang-sender-rest, tests/words.ts).
const read = (p: string) => englishIf(p, fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const src = (p: string) => read(`src/${p}`);
const full = async (c: Client, id: string) => (await c.get(`/envelopes/${id}`)).data;
// What no page, email or record of ours may say about a signature made here.
const PROMISES = /same legal effect|as valid as|legally binding|is legally valid|will hold up|equal to a handwritten|pen on paper/i;

// ---- A. Words that were not true -----------------------------------------------------------------------------------

test('the consent text says what kind of signature this is and never that it equals a handwritten one', () => {
  // Since wording 2026-11-23 (the owner's decision of 23 November 2026: one short sentence, the rest behind a link)
  // these sentences are no longer above the tick. They are one tap away under "How electronic signing works", and
  // every one of them is still said: this test reads them there. tests/consent-short.test.ts has the rest.
  const w = consentWording('Ada Sender', true);
  assert.equal(w.version, CONSENT_VERSION);
  const said = consentPlain(w);
  assert.match(said, /simple electronic signature/);
  assert.match(said, /rules differ by country and by kind of document/);
  assert.match(said, /handwritten, witnessed, notarised or qualified signature/);
  assert.match(said, /GrowSigning does not know which kind this document is/);
  assert.match(said, /ask Ada Sender or a lawyer before you sign/);
  // Need 16: the parties accept the method between themselves, in so many words.
  assert.match(said, /you accept this electronic method as a valid way for you and the other parties to sign this document/);
  assert.match(said, /Ask Ada Sender for a paper copy instead/);
  assert.doesNotMatch(said, PROMISES);
  // No em dash anywhere, and no line break inside a sentence.
  assert.doesNotMatch(said, /\n|\u2014/);

  // Someone who approves or only reads is not told that they sign, or that they accept a way of signing.
  const reads = consentWording('Ada Sender', false);
  const readsSaid = consentPlain(reads);
  assert.doesNotMatch(readsSaid, /and sign|your name or mark|you accept this electronic method|to sign this document/);
  assert.match(readsSaid, /rules differ by country and by kind of document/);
  assert.match(readsSaid, /ask Ada Sender or a lawyer before you continue/);
  assert.doesNotMatch(readsSaid, PROMISES);

  // A version we never showed is not a version, and asking for its words gives the current ones under their own name.
  assert.equal(isConsentVersion(CONSENT_VERSION), true);
  for (const bad of ['', '2019-01', 'constructor', '__proto__', 7, null, undefined]) assert.equal(isConsentVersion(bad), false, String(bad));
  assert.equal(consentWording('Ada Sender', true, 'constructor').version, CONSENT_VERSION);

  assert.equal(adoptLine('signature'), 'I agree that this mark stands for my signature.');
  assert.equal(adoptLine('initials'), 'I agree that this mark stands for my initials.');
});

test('the signing screen and the signature dialog show those words and nothing stronger', () => {
  const page = src('app/sign/[token]/page.tsx');
  const pad = src('components/SignaturePad.tsx');
  assert.doesNotMatch(page, PROMISES);
  assert.doesNotMatch(pad, PROMISES);
  // The screen prints the shared wording, ties it to the tick box for a screen reader, and sends its version back.
  // In the page's language where a person checked that wording, else English (tests/ds-lang-signing.test.ts).
  assert.match(page, /const wording = consentWording\(sender\.name, acts, undefined, lang\)/);
  assert.match(page, /<p className="muted sg-legal">\{wording\.legal\}<\/p>/);
  assert.match(page, /aria-describedby=\{formError \? 'sg-legal sg-agree-err' : 'sg-legal'\}/);
  assert.match(page, /<span lang=\{wording\.language\}>\{wording\.agree\}<\/span>/);
  assert.match(page, /body: \{ version: version\.current, wording: wording\.version[ ,}]/);
  assert.match(pad, /\{adoptLine\(word\)\}/);
  // Nothing else in the product makes the promise either: pages, components, emails, the README.
  for (const f of ['app/page.tsx', 'app/help/page.tsx', 'app/help/outside.tsx', 'app/security/page.tsx', 'server/mail.ts', 'server/pdf.ts', 'server/openapi.ts', 'components/sign/dialogs.tsx'])
    assert.doesNotMatch(src(f), PROMISES, f);
  assert.doesNotMatch(read('README.md'), PROMISES);
});

test('the audit line for consent names the wording the signer was shown', async () => {
  const consentLines = async (id: string) => (await full(ada, id)).audit.filter((a: any) => a.action === 'Agreed to electronic records and signatures');

  // The screen says which wording it showed.
  const e1 = await simple(ada, 'wording1@example.com');
  await ada.post(`/envelopes/${e1.id}/send`);
  const s1 = new Client();
  const r1 = await s1.post(`/sign/${tokenFor(e1.id, 'wording1@example.com')}/consent`, { version: 1, wording: CONSENT_VERSION });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.wording, CONSENT_VERSION);
  let lines = await consentLines(e1.id);
  assert.equal(lines.length, 1);
  // The language too, since lang-core (tests/i18n.test.ts): a screen that names none only shows English.
  assert.equal(lines[0].detail, `Sam Signer. Wording ${CONSENT_VERSION}, in English (en), as printed on the help page under "What do I agree to before I sign?".`);
  // Agreeing twice writes one line, and the chain still holds.
  await s1.post(`/sign/${tokenFor(e1.id, 'wording1@example.com')}/consent`, { wording: CONSENT_VERSION });
  lines = await consentLines(e1.id);
  assert.equal(lines.length, 1);
  assert.equal(env.verifyChain(e1.id).ok, true);
  assert.ok(db.get('SELECT consent_at FROM recipients WHERE envelope_id=?', e1.id).consent_at);

  // A call that names no wording, or one we never showed, is written down as exactly that. Nothing is made up.
  for (const [i, body] of [undefined, { wording: 'whatever-you-say' }, { wording: 5 }].entries()) {
    const email = `wording-none${i}@example.com`;
    const e = await simple(ada, email);
    await ada.post(`/envelopes/${e.id}/send`);
    const r = await new Client().call('POST', `/sign/${tokenFor(e.id, email)}/consent`, body);
    assert.equal(r.status, 200, JSON.stringify(body));
    const [line] = await consentLines(e.id);
    assert.equal(line.detail, `Sam Signer. The screen did not say which wording it showed. The wording in use was ${CONSENT_VERSION}, in English (en), as printed on the help page under "What do I agree to before I sign?".`);
  }

  // The help page prints the words under that heading, with the version, so the line can be read back by anyone.
  const help = src('app/help/outside.tsx');
  assert.match(help, /<QA id="consent-wording" q="What do I agree to before I sign\?">/);
  assert.match(help, /<p>\{w\.legal\}<\/p>/);
  assert.match(help, /This is the wording of \{versionText\(w\.version\)\}/); // day first since repair-open-public
  assert.match(src('app/help/page.tsx'), /<ConsentWords \/>/);
});

test('a page promises a QR code only because the app draws one, and every public page says which language signers are asked in', () => {
  const landing = src('app/features/page.tsx'); // the feature list moved off the home page (simplify-public)
  // The landing page once promised "a public link or QR code" while nothing drew one, and then said to use a tool
  // of your own. The app now makes the code itself (src/lib/qr.ts, held to the standard in tests/qr.test.ts), so the
  // page says that, and the promise stands on code that exists.
  assert.doesNotMatch(landing, /link or QR code|tool of your own|we do not make one yet/);
  assert.match(landing, /print the QR code the app makes for it/);
  assert.match(src('lib/qr.ts'), /export function qrEncode\(/);
  assert.match(src('app/app/powerforms/page.tsx'), /\/app\/powerforms\/\$\{p\.id\}\/qr/);

  assert.equal(LANGUAGE_NOTE, 'The signing screen and our emails are in English for now. Your document can be in any language.');
  assert.match(landing, /\$\{LANGUAGE_NOTE\}/);
  assert.match(src('app/help/outside.tsx'), /<QA id="language" q="Which language do my signers see\?">\s*<p>\{LANGUAGE_NOTE\}<\/p>/);
  assert.match(src('app/security/page.tsx'), /<Point title="Not translated yet\.">\{LANGUAGE_NOTE\}/);
  assert.ok(read('README.md').replace(/\s+/g, ' ').includes(LANGUAGE_NOTE), 'the README says it in the same words');
});

test('the help page says what "fix my name" really does, and the server does exactly that', async () => {
  const help = src('app/help/page.tsx');
  assert.doesNotMatch(help, /<li>Fix the spelling of your own name\.<\/li>/);
  // Another engineer widens what counts as a small slip (a space, a hyphen), so only the frame of the sentence is pinned here.
  assert.match(help, /A small one, such as a letter missing or two swapped[^.]* is corrected at once\./);
  assert.match(help, /it changes nothing and asks the sender, who can correct it for you/);
  assert.doesNotMatch(read('README.md'), /fix the spelling of\s+your own name, ask for more time/);

  const e = await simple(ada, 'ivan@example.com', { recipients: [{ id: 'r', role: 'signer', name: 'Ivan Petrov', email: 'ivan@example.com' }] });
  await ada.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'ivan@example.com');
  const ivan = new Client();
  await ivan.post(`/sign/${tok}/consent`, { wording: CONSENT_VERSION });
  // A small slip: corrected at once.
  const slip = await ivan.post(`/sign/${tok}/name`, { name: 'Ivan Petrow' });
  assert.equal(slip.status, 200, JSON.stringify(slip.data));
  assert.equal(slip.data.applied, true);
  // Another alphabet: nothing changes, and the sender is asked.
  const before = mailTo('ada.sender@example.com').length;
  const other = await ivan.post(`/sign/${tok}/name`, { name: 'Иван Петров' });
  assert.equal(other.status, 200, JSON.stringify(other.data));
  assert.equal(other.data.applied, false);
  assert.equal(db.get('SELECT name FROM recipients WHERE envelope_id=?', e.id).name, 'Ivan Petrow');
  assert.ok(mailTo('ada.sender@example.com').length > before, 'the sender is asked');
});

// ---- B. Prices name their currency ---------------------------------------------------------------------------------

test('every price on a public page is written as US$, with one line about currency conversion', () => {
  assert.equal(usd(9), 'US$9');
  assert.equal(usd('1,234.50'), 'US$1,234.50');
  assert.match(CURRENCY_NOTE, /^Prices are in US dollars/);
  assert.match(CURRENCY_NOTE, /your bank converts the amount and may add a fee/);

  // A bare "$" in front of a price or an amount: `${P.monthlyUsd}` in markup, or "$${...}" in a template string.
  const bare = /(?<!US)\$\{(P|PRICING)\.(monthlyUsd|topUpUsd)\}|(?<!US)\$\{PLANS\.\w+\.price\}|(?<!US)\$\{info\.price\}|\$\$\{|>\$\{d \?/;
  const publicPages = ['app/page.tsx', 'app/help/page.tsx', 'app/help/outside.tsx', 'app/impact/page.tsx', 'app/security/page.tsx', 'app/billing/stop/StopView.tsx', 'components/Public.tsx'];
  for (const f of publicPages) assert.doesNotMatch(src(f), bare, f);

  const landing = src('app/pricing/page.tsx'); // the prices moved to /pricing (simplify-public)
  assert.match(landing, /<div className="price">\{usd\(PLANS\.seedling\.price\)\}<\/div>/);
  assert.match(landing, /<div className="price">\{usd\(P\.monthlyUsd\)\}<small> \/ month<\/small><\/div>/);
  assert.match(landing, /More when you need them, \{usd\(P\.topUpUsd\)\} a signature/);
  assert.match(landing, /\{P\.planName\} is \{usd\(P\.monthlyUsd\)\} a month for the whole team/);
  assert.match(landing, /<p className="muted small pub-code-note" id="currency">\{CURRENCY_NOTE\}<\/p>/);
  const help = src('app/help/page.tsx');
  assert.match(help, /\{P\.planName\} is \{usd\(P\.monthlyUsd\)\} a month/);
  assert.match(help, /buy more at \{usd\(P\.topUpUsd\)\} each, whenever you need them\. \{CURRENCY_NOTE\}/);
  assert.match(src('app/billing/stop/StopView.tsx'), /US\$\{info\.price\} a month/);
  assert.match(src('app/billing/stop/StopView.tsx'), /<dt>Next charge<\/dt><dd>US\$\{info\.price\} on/);
  assert.match(src('components/Public.tsx'), /usd\(fmtNum\(i\.donatedUsd\)\)/);
  // /impact shows no amount of money any more (totals are hidden until they mean something, tests/impact.test.ts),
  // so there is no price on it to write wrongly.
  assert.doesNotMatch(src('app/impact/page.tsx'), /\$\{?\d|donatedUsd/);
});

// ---- C. Documents that often need paper, and the notes by country ----------------------------------------------

const kinds = (w: { kind: string }[]) => w.map((x) => x.kind).sort();

test('the check before sending finds the words that matter and leaves ordinary contracts alone', () => {
  // The subject, a document name, the text: the first place a word is seen is the one that is named.
  const will = paperWarnings({ subject: 'Last Will and Testament of Jo Bloggs', documents: [{ name: 'Scan', text: 'I revoke every earlier will and codicil.' }] });
  assert.equal(will.length, 1, 'one line for each kind of document, however often its words appear');
  assert.deepEqual({ kind: will[0].kind, word: will[0].word, where: will[0].where, document: will[0].document }, { kind: 'will', word: 'last will', where: 'subject', document: null });
  // The warning quotes the word as it stands, not as the list spells it.
  assert.equal(will[0].seen, 'Last Will');
  assert.equal(will[0].found, 'The subject says "Last Will", so this may be a will.');
  assert.ok(will[0].message.startsWith(will[0].found) && will[0].message.endsWith(PAPER_TAIL));
  assert.match(will[0].message, /nothing is blocked, and you can send it as it is/);
  assert.equal(will[0].help, '/help#outside-us');

  const named = paperWarnings({ subject: 'Please sign', documents: [{ name: 'Title deed plot 14', text: '' }] });
  assert.deepEqual([named[0].kind, named[0].where, named[0].document, named[0].word], ['land', 'document name', 'Title deed plot 14', 'title deed']);
  const inText = paperWarnings({ subject: 'Please sign', documents: [{ name: 'Form 7', text: 'This LASTING POWER\nOF ATTORNEY is made by the donor.' }] });
  assert.deepEqual([inText[0].kind, inText[0].where, inText[0].document, inText[0].word], ['attorney', 'document text', 'Form 7', 'lasting power of attorney']);
  assert.equal(inText[0].found, 'The text of "Form 7" says "LASTING POWER OF ATTORNEY", so this may be a power of attorney.');
  assert.equal(paperWarnings({ documents: [{ name: 'Vertrag', text: 'Arbeitsvertrag. Die Befristung endet am 31.12.2027.' }] })[0].seen, 'Befristung');
  assert.equal(paperWarnings({ documents: [{ name: 'KÜNDIGUNGSSCHREIBEN für Frau Özdemir' }] })[0].seen, 'KÜNDIGUNGSSCHREIBEN');
  assert.equal(paperWarnings({ subject: 'Procurac\u0327a\u0303o' })[0].seen, 'Procurac\u0327a\u0303o', 'also when the accents are typed as separate marks');

  // Any letter case, with or without accents, and in the languages the list knows.
  for (const [text, kind] of [
    ['PROCURAÇÃO', 'attorney'], ['procuracao para o banco', 'attorney'], ['Escritura pública de compraventa', 'land'], ['Testamento', 'will'], ['Mein Testament', 'will'],
    ['Grundstückskaufvertrag', 'land'], ['Compromis de vente', 'land'], ['Deed of Trust', 'trust'], ['Offer to Purchase', 'land'], ['Long lease, 99 years', 'land'],
    ['Aufhebungsvertrag', 'employment'], ['Separation agreement', 'employment'], ['Executed as a deed', 'witness'], ['Subscribed before me, a Notary Public', 'witness'], ['notariell beurkundet', 'witness'],
  ] as const) assert.deepEqual(kinds(paperWarnings({ subject: text })), [kind], text);

  // Words that are everywhere in ordinary contracts are only read in the subject and in document names.
  assert.deepEqual(paperWarnings({ subject: 'Service agreement', documents: [{ name: 'Agreement', text: 'The tenant will pay. This will of the parties is final. Die Kündigung bedarf der Schriftform. Either side may give notice of termination. He acts with Vollmacht.' }] }), []);
  assert.deepEqual(paperWarnings({ subject: 'Will you sign this?' }), []);
  assert.deepEqual(kinds(paperWarnings({ subject: 'Kündigung Müller' })), ['employment']);
  assert.deepEqual(kinds(paperWarnings({ documents: [{ name: 'Kündigungsschreiben' }] })), ['employment']);
  assert.deepEqual(kinds(paperWarnings({ documents: [{ name: 'Vollmacht' }] })), ['attorney']);
  assert.deepEqual(kinds(paperWarnings({ subject: 'Will of Jo Bloggs' })), ['will']);

  // A fixed term only says something in an employment contract.
  assert.deepEqual(paperWarnings({ subject: 'Software licence', documents: [{ name: 'Licence', text: 'The licence runs for a fixed term of 12 months.' }] }), []);
  assert.deepEqual(kinds(paperWarnings({ subject: 'Contract', documents: [{ name: 'Contract', text: 'The employee is engaged for a fixed-term of 12 months.' }] })), ['employment']);
  assert.deepEqual(kinds(paperWarnings({ subject: 'Arbeitsvertrag', documents: [{ name: 'Vertrag', text: 'Das Arbeitsverhältnis ist befristet bis zum 31.12.2027.' }] })), ['employment']);
  assert.deepEqual(kinds(paperWarnings({ subject: 'Befristeter Arbeitsvertrag' })), ['employment']);
  assert.deepEqual(paperWarnings({ subject: 'Mietvertrag', documents: [{ name: 'Miete', text: 'Der Mietvertrag ist befristet.' }] }), []);
  // A word inside a longer word is not that word.
  assert.deepEqual(paperWarnings({ subject: 'Goodwill of the business, testamentary capacity not needed, unbefristet' }), []);

  // Several kinds at once: one warning each.
  assert.deepEqual(kinds(paperWarnings({ subject: 'Will of Jo', documents: [{ name: 'Power of attorney', text: 'sale of land' }] })), ['attorney', 'land', 'will']);
  // Nothing to look at is not an error.
  assert.deepEqual(paperWarnings({}), []);
  assert.deepEqual(paperWarnings({ subject: null, documents: [{ name: null, text: null }] }), []);

  // What goes into the audit trail states what was seen and that nothing was blocked. It makes no judgement.
  const note = paperAuditNote(will);
  assert.equal(note, 'The subject says "Last Will". Documents of this kind often need a handwritten, witnessed, notarised or qualified signature, depending on the country. The sender was told when sending. Nothing was blocked.');
  assert.match(paperAuditNote(will, false), /This came through a public form, so nobody was told at that moment\. Nothing was blocked\.$/);

  // Every sentence the list can produce: plain, hedged, no promise and no em dash.
  for (const k of PAPER_KINDS) {
    assert.doesNotMatch(`${k.a} ${k.why}`, /\u2014/);
    assert.doesNotMatch(k.why, PROMISES);
  }
  assert.match(PAPER_TAIL, /rules differ by country and by kind of document/);
  // The help page prints the whole list, so nobody has to guess what sets the check off.
  const listed = paperWordList();
  assert.equal(listed.length, PAPER_KINDS.length);
  assert.ok(listed.find((k) => k.a === 'a will')!.titleOnly.includes('will of'));
  assert.ok(listed.find((k) => k.a === 'a power of attorney')!.words.includes('power of attorney'));
  // A stem is shown as one, so "befrist" is not taken for a word nobody writes.
  assert.ok(listed.find((k) => /employment/.test(k.a))!.words.includes('befrist...'));
  assert.ok(listed.find((k) => /employment/.test(k.a))!.titleOnly.includes('kündigung...'));
});

// A one-page PDF with the given lines as real text, uploaded as a sender would.
async function uploadWithText(c: Client, lines: string[], filename = 'Agreement.pdf') {
  const d = await PDFDocument.create();
  const page = d.addPage([612, 792]);
  lines.forEach((l, i) => page.drawText(l, { x: 72, y: 700 - i * 22, size: 12 }));
  const f = new FormData();
  f.append('file', new Blob([await d.save()], { type: 'application/pdf' }), filename);
  const r = await c.call('POST', '/files', f);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const oneSigner = (fileId: string, email: string, over: any = {}) => ({
  subject: 'Please sign', documents: [{ id: 'd', file_id: fileId, name: 'Agreement' }],
  recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email }],
  fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }], ...over,
});
const paperLines = async (id: string) => (await full(ada, id)).audit.filter((a: any) => a.action === PAPER_AUDIT_ACTION);

test('sending warns, never blocks, answers with "warnings" and writes what it saw to the audit trail', async () => {
  // The word is only inside the file. The editor asks before sending, and gets it from the server.
  const file = await uploadWithText(ada, ['GENERAL TERMS', 'By this power of attorney the donor appoints the attorney named below.']);
  const made = await ada.post('/envelopes', oneSigner(file.id, 'poa@example.com'));
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal(made.data.warnings, undefined, 'a draft that is only saved has nothing to answer yet');
  const id = made.data.envelope.id;
  const look = await ada.get(`/envelopes/${id}/warnings`);
  assert.equal(look.status, 200);
  assert.equal(look.data.blocks, false);
  assert.equal(look.data.warnings.length, 1);
  const w = look.data.warnings[0];
  assert.deepEqual([w.kind, w.word, w.where, w.document], ['attorney', 'power of attorney', 'document text', 'Agreement']);
  assert.equal(w.help_url, 'http://test.local/help#outside-us');
  assert.match(w.message, /^The text of "Agreement" says "power of attorney", so this may be a power of attorney\./);
  assert.deepEqual(await paperLines(id), [], 'looking writes nothing down');

  // It goes out all the same.
  const sent = await ada.post(`/envelopes/${id}/send`);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.envelope.status, 'sent');
  assert.deepEqual(sent.data.warnings, look.data.warnings);
  assert.equal(mailTo('poa@example.com').length, 1, 'and the signer is emailed');
  const lines = await paperLines(id);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].actor, 'System');
  assert.equal(lines[0].detail, 'The text of "Agreement" says "power of attorney". Documents of this kind often need a handwritten, witnessed, notarised or qualified signature, depending on the country. The sender was told when sending. Nothing was blocked.');
  assert.equal(env.verifyChain(id).ok, true);

  // Create and send in one call: the same list in the same answer.
  const file2 = await uploadWithText(ada, ['Nothing special in here.']);
  const direct = await ada.post('/envelopes', oneSigner(file2.id, 'will@example.com', { subject: 'My last will', send: true }));
  assert.equal(direct.status, 200, JSON.stringify(direct.data));
  assert.equal(direct.data.envelope.status, 'sent');
  assert.deepEqual(direct.data.warnings.map((x: any) => [x.kind, x.where]), [['will', 'subject']]);
  assert.equal((await paperLines(direct.data.envelope.id)).length, 1);

  // An ordinary agreement: an empty list and no line.
  const plain = await ada.post('/envelopes', oneSigner(file2.id, 'plain@example.com', { subject: 'Volunteer agreement', send: true }));
  assert.equal(plain.status, 200, JSON.stringify(plain.data));
  assert.deepEqual(plain.data.warnings, []);
  assert.deepEqual(await paperLines(plain.data.envelope.id), []);
  assert.deepEqual((await ada.get(`/envelopes/${plain.data.envelope.id}/warnings`)).data, { warnings: [], blocks: false });

  // Somebody else's envelope is not theirs to look into.
  const eve = await signUp('Eve Other', 'eve.other@example.com', '198.51.100.202');
  assert.equal((await eve.get(`/envelopes/${id}/warnings`)).status, 404);
  assert.equal((await new Client().get(`/envelopes/${id}/warnings`)).status, 401);
});

test('a bulk send says once what the check found in its template', async () => {
  const file = await uploadWithText(ada, ['Waiver']);
  const tpl = await ada.post('/envelopes', { kind: 'template', subject: 'Deed of sale', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Buyer' }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));
  const r = await ada.post('/bulk', { template_id: tpl.data.envelope.id, rows: [{ Buyer: { name: 'Bo Buyer', email: 'bo.buyer@example.com' } }, { Buyer: { name: 'Cy Buyer', email: 'cy.buyer@example.com' } }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sent, 2, 'every row went out');
  assert.deepEqual(r.data.warnings.map((x: any) => [x.kind, x.word, x.where]), [['land', 'deed of sale', 'subject']]);
  for (const row of r.data.results) assert.equal((await paperLines(row.id)).length, 1, 'and each envelope carries the line');
});

test('the API description and the developer page describe the warnings', async () => {
  const { openapi } = await import('../src/server/openapi.ts');
  const spec: any = openapi();
  assert.ok(spec.paths['/envelopes/{id}/warnings'].get);
  assert.deepEqual(spec.components.schemas.SendWarning.properties.kind.enum, PAPER_KINDS.map((k) => k.id));
  assert.match(JSON.stringify(spec.paths['/envelopes/{id}/send']), /SendWarning/);
  assert.match(JSON.stringify(spec.paths['/envelopes'].post), /SendWarning/);
  assert.match(JSON.stringify(spec.components.schemas.BulkResult), /SendWarning/);
  const dev = src('app/developers/page.tsx');
  assert.match(dev, /\['GET', '\/api\/envelopes\/:id\/warnings'/);
  assert.match(dev, /Sending can come back with warnings, and never fails because of them\./);
});

test('the review step shows the warning without switching Send off, and the help page has the one honest place', () => {
  const review = src('components/editor/StepReview.tsx');
  assert.match(review, /\{!closed && <PaperCheck envelopeId=\{env\.id\} subject=\{env\.subject \|\| ''\} docs=\{docs\} sending=\{!isTpl && !correcting\} \/>\}/);
  assert.match(review, /\{!isTpl && !correcting && <EnoughLink \/>\}/);
  // Whether Send is on has nothing to do with the check: the word does not appear where the button is decided.
  assert.match(review, /const blocked = busy \|\| problems\.length > 0 \|\| !!closed \|\| conflict\.length > 0 \|\| \(correcting && !changed\);/);
  const check = src('components/editor/PaperCheck.tsx');
  assert.match(check, /api\(`\/envelopes\/\$\{envelopeId\}\/warnings`\)/);
  assert.match(check, /<li key=\{w\.kind\}>\{w\.found\} \{w\.why\}<\/li>/);
  assert.match(check, /\{PAPER_TAIL\} <a href=\{PAPER_HELP\} target="_blank" rel="noreferrer">/);
  assert.match(check, /\(opens in a new tab\)/);
  assert.match(check, /href="\/help#enough"/);
  assert.doesNotMatch(check, /disabled/);

  // Stamp duty: said to a sender whose own clock is in India or Indonesia, in the words of the help page.
  assert.equal(STAMP_ZONES['Asia/Kolkata'], 'India');
  assert.equal(STAMP_ZONES['Asia/Jakarta'], 'Indonesia');
  assert.equal(STAMP_ZONES['Europe/Berlin'], undefined);
  assert.match(stampNote('India'), /^Signing here does not pay stamp duty\..*e-stamp certificate.*first file of the document/);
  assert.match(stampNote('Indonesia'), /e-meterai/);
  assert.match(check, /STAMP_ZONES\[Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone\]/);

  const help = src('app/help/outside.tsx');
  assert.match(help, /<QA id="outside-us" q="Signing outside the United States, and documents that should not be signed here">/);
  assert.match(help, /It is not legal advice, laws change, and the rule for your document may differ/);
  assert.match(help, /it never blocks a send/);
  assert.match(help, /\{COUNTRY_NOTES\.map\(\(n\) => \(/);
  assert.match(help, /Looked at in \{n\.checked\}\./);
  assert.match(help, /\{paperWordList\(\)\.map\(/);
  assert.match(help, /<QA id="enough" q="Is this signature enough for my document\?">/);
  assert.match(src('app/help/page.tsx'), /<SignatureKind \/>/);
  // The places that send people there: the landing page under the prices, the security page, the review step.
  assert.match(src('app/pricing/page.tsx'), /<Link href="\/help#enough">check before you rely on it<\/Link>/);
  assert.match(src('app/security/page.tsx'), /<Link href="\/help#outside-us">/);
});

test('every country note is dated, hedged and rests on a source the research names', () => {
  // The research for this note lives in gaps-partial.json; the EU's own copy of eIDAS was named by the research on
  // government services (government.json), which a later repair links in place of the UK's copy.
  const research = ['gaps-partial', 'gaps', 'government'].map((f) => { try { return read(`research/${f}.json`); } catch { return ''; } }).join('\n');
  assert.deepEqual(COUNTRY_NOTES.map((n) => n.id), ['eu', 'de', 'uk', 'in', 'id', 'za-ke', 'sg-ng', 'br', 'au', 'mx']);
  for (const n of COUNTRY_NOTES) {
    assert.match(n.checked, /^(January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d$/, n.id);
    assert.ok(n.sources.length >= 1, n.id);
    for (const s of n.sources) {
      assert.match(s.url, /^https:\/\//, s.url);
      assert.ok(research.includes(s.url), `${n.id}: ${s.url} is not a source the research read`);
      assert.equal(typeof s.official, 'boolean');
    }
    assert.doesNotMatch(n.text, PROMISES, n.id);
    assert.doesNotMatch(n.text, /\u2014|legally valid|is valid|are valid/, n.id);
  }
  // What the product does not provide is said in so many words where the research found people assume it does.
  const text = (id: string) => COUNTRY_NOTES.find((n) => n.id === id)!.text;
  assert.match(text('eu'), /GrowSigning makes the first/);
  assert.match(text('de'), /qualified electronic signature, which GrowSigning does not provide/);
  // Since the witness role (tests/witness.test.ts): what it records, and that it cannot check the witness was there.
  assert.match(text('uk'), /GrowSigning can add a witness who states that they saw the signature, and it cannot check that they were there/);
  assert.match(text('in'), /not an Aadhaar eSign and not a digital signature certificate/);
  assert.match(text('in'), /signing here does not pay stamp duty/);
  assert.match(text('za-ke'), /GrowSigning is not such a provider/);
  assert.match(text('br'), /ICP-Brasil certificate, which GrowSigning does not provide/);
  assert.match(text('mx'), /We do not issue a NOM-151 conservation certificate/);
  // A source that is somebody writing about the law is not passed off as the law.
  assert.equal(COUNTRY_NOTES.find((n) => n.id === 'de')!.sources.every((s) => !s.official), true);
  assert.equal(COUNTRY_NOTES.find((n) => n.id === 'au')!.sources[0].official, true);
});

// ---- D. Where your data is -----------------------------------------------------------------------------------------

test('"Where your data is" comes from settings, lists only what is switched on, and says what was not stated', () => {
  // A server whose operator has stated nothing: the page says so, in these words, and lists nobody it does not use.
  const bare = dataPlace({});
  assert.deepEqual([bare.operator, bare.region, bare.host, bare.backups], [null, null, null, null]);
  assert.equal(notSaid('where it is hosted'), 'The operator of this server has not said where it is hosted. Ask them.');
  assert.deepEqual(bare.unstated, [
    'The operator of this server has not said who they are. Ask them.',
    'The operator of this server has not said which company hosts it. Ask them.',
    'The operator of this server has not said where it is hosted. Ask them.',
    'The operator of this server has not said whether and where backups are kept. Ask them.',
  ]);
  assert.deepEqual(bare.processors.map((p) => p.id), ['host'], 'no mail, payment, sign-in or text message provider is named when none is switched on');
  assert.deepEqual(bare.off, [
    'No mail server is set up on this server, so no email leaves it.',
    'Payments are not connected on this server, so nothing goes to a payment provider.',
    'Signing in with Google or Microsoft is switched off on this server.',
    'Text messages are switched off on this server, so no phone number goes to a text message provider.',
  ]);

  // Everything switched on and everything stated.
  const env = {
    OPERATOR_NAME: 'Example Trees e.V., Hamburg, Germany', DATA_REGION: 'Frankfurt, Germany', DATA_HOST: 'Example Hosting GmbH', DATA_BACKUPS: 'Every night, kept 30 days in Helsinki, Finland.',
    SMTP_URL: 'smtps://mailuser:mail-secret@smtp.example.com', MAIL_PROVIDER_NAME: 'Example Mail Ltd', MAIL_PROVIDER_COUNTRY: 'Ireland',
    STRIPE_SECRET_KEY: 'sk_live_secret', PAYMENT_PROVIDER_COUNTRY: 'Ireland',
    GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'google-secret', MICROSOFT_CLIENT_ID: 'mid', MICROSOFT_CLIENT_SECRET: 'ms-secret',
    TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'twilio-secret', TWILIO_FROM: '+15550100', SMS_PROVIDER_COUNTRY: 'United States',
  };
  const all = dataPlace(env);
  assert.deepEqual(all.processors.map((p) => p.id), ['host', 'mail', 'payments', 'google', 'microsoft', 'sms']);
  assert.deepEqual(all.unstated, []);
  assert.deepEqual(all.off, []);
  const by = (id: string) => all.processors.find((p) => p.id === id)!;
  assert.deepEqual([by('host').name, by('host').country], ['Example Hosting GmbH', 'Frankfurt, Germany']);
  assert.deepEqual([by('mail').name, by('mail').country], ['Example Mail Ltd', 'Ireland']);
  assert.deepEqual([by('payments').name, by('payments').country], ['Stripe', 'Ireland']);
  assert.equal(by('sms').name, 'Twilio', 'the name is known from the switch itself');
  // Who is touched by whom: signers never reach the payment provider, Google or Microsoft.
  assert.match(by('payments').who, /Signers never/);
  assert.match(by('google').who, /Only account holders who choose to sign in with Google\. Signers never\./);
  assert.match(by('microsoft').data, /Nothing about documents/);
  assert.match(by('sms').who, /Only signers whose sender asked for a text message/);
  // No secret from the settings is ever in what the page prints.
  for (const secret of ['mail-secret', 'mailuser', 'sk_live_secret', 'google-secret', 'ms-secret', 'twilio-secret', 'smtp.example.com', '+15550100']) assert.ok(!JSON.stringify(all).includes(secret), secret);

  // A provider that is switched on but not described is listed, with what is missing said in its place.
  const half = dataPlace({ SMTP_URL: 'smtp://relay', STRIPE_SECRET_KEY: 'sk', SMS_WEBHOOK_URL: 'https://texts.example.com/send' });
  assert.deepEqual(half.processors.map((p) => p.id), ['host', 'mail', 'payments', 'sms']);
  assert.deepEqual(half.processors.find((p) => p.id === 'mail')!.missing, ['The operator of this server has not said which company delivers its email. Ask them.', 'The operator of this server has not said in which country its mail provider handles email. Ask them.']);
  assert.deepEqual(half.processors.find((p) => p.id === 'payments')!.missing, ['The operator of this server has not said which Stripe company and country its payments go through. Ask them.']);
  assert.equal(half.processors.find((p) => p.id === 'sms')!.name, null);
  assert.equal(half.unstated.length, 9);
  // A text message outbox on a development machine sends nothing anywhere, so no provider is listed for it.
  assert.deepEqual(dataPlace({ SMS_DEV_OUTBOX: '1' }).processors.map((p) => p.id), ['host']);
  // Blank settings count as not stated, and a long one is cut rather than printed without end.
  assert.equal(dataPlace({ DATA_REGION: '   ' }).region, null);
  assert.equal(dataPlace({ DATA_REGION: ' Frankfurt,\n Germany ' }).region, 'Frankfurt, Germany');
  assert.equal(dataPlace({ DATA_HOST: 'x'.repeat(500) }).host!.length, 200);

  // A production server that starts with something missing hears it once, with the names of the settings.
  assert.equal(dataPlaceWarning({ NODE_ENV: 'development' }), null);
  assert.equal(dataPlaceWarning({ ...env, NODE_ENV: 'production' }), null);
  assert.match(dataPlaceWarning({ NODE_ENV: 'production', SMTP_URL: 'smtp://relay' })!, /OPERATOR_NAME, DATA_REGION, DATA_HOST and DATA_BACKUPS, MAIL_PROVIDER_NAME and MAIL_PROVIDER_COUNTRY/);
});

test('the security page and the processing summary print those facts and invent none', () => {
  const block = src('app/security/DataPlace.tsx');
  assert.match(src('app/security/page.tsx'), /<WhereYourDataIs \/>/);
  assert.match(src('app/security/page.tsx'), /<a href="#data">Where your data is<\/a>/);
  assert.match(block, /const d = dataPlace\(\);/);
  assert.match(block, /<Stated value=\{d\.region\} what="where it is hosted" \/>/);
  assert.match(block, /<Stated value=\{d\.operator\} what="who they are" \/>/);
  assert.match(block, /<Stated value=\{d\.backups\} what="whether and where backups are kept" \/>/);
  assert.match(block, /There is one region\. You cannot choose another\./);
  assert.match(block, /\{d\.processors\.map\(\(p\) => \(/);
  // What is missing about the others is said in full under the table, once, and not repeated for the server itself.
  assert.match(block, /const others = d\.processors\.filter\(\(p\) => p\.id !== 'host'\)\.flatMap\(\(p\) => p\.missing\);/);
  assert.match(block, /\{others\.map\(\(u\) => <li key=\{u\}>\{u\}<\/li>\)\}/);
  // The table has a caption and header cells, and its cells carry their label for the phone layout.
  assert.match(block, /<caption>Who else handles data, and why<\/caption>/);
  assert.match(block, /<th scope="row">/);
  assert.match(block, /<td data-label="What reaches them">\{p\.data\}<\/td>/);
  assert.match(block, /It is a description, not a contract\. If you need a signed data processing agreement, it is between you and whoever runs this server/);
  // No company, city or country is typed into the pages themselves.
  for (const f of ['app/security/DataPlace.tsx', 'app/security/processing/page.tsx']) assert.doesNotMatch(src(f), /Frankfurt|Hetzner|Amazon|AWS|Mailgun|SendGrid|Ireland|Germany/, f);

  const page = src('app/security/processing/page.tsx');
  assert.match(page, /export const dynamic = 'force-dynamic';/);
  assert.match(page, /It is not a contract and not legal advice\./);
  assert.match(page, /that agreement is between you and whoever runs this server/);
  // How long, and how it is deleted: the numbers and lists the deleting code is held to, not a copy of them.
  assert.match(page, /are deleted after \{MAIL_COPY_DAYS\} days/);
  assert.match(page, /is kept for \{CLOSE_GRACE_DAYS\} days/);
  assert.match(page, /\{DELETED_WITH_ACCOUNT\.map\(/);
  assert.match(page, /\{KEPT_AFTER_DELETION\.map\(/);
  assert.match(page, /closed after \{powerformIdleHours\(\)\} hours/);
  assert.match(page, /<ProcessorTable d=\{d\} \/>/);
  // What the software does not do comes from the setting (src/lib/storedfiles.ts): with it off, that it does not
  // encrypt the files it stores now and never the database (files encrypted while it was on stay so).
  assert.match(page, /<b>What the software does not do:<\/b> \{processingNotDone\(\)\}/);
  assert.match(read('src/lib/storedfiles.ts'), /'on this server it does not encrypt the files it stores now or any of the database, so how the disk is protected depends on the host\.'/);
  assert.match(page, /An envelope that somebody signed<\/b> cannot be erased by itself/);
  assert.equal(MAIL_COPY_DAYS, 90);
  assert.equal(CLOSE_GRACE_DAYS, 30);
  // Saved as a PDF from the browser: one button, and the print rules hide everything that is not the summary.
  assert.match(src('app/security/processing/PrintButton.tsx'), /onClick=\{\(\) => window\.print\(\)\}>Print or save as PDF<\/button>/);
  assert.match(src('app/styles/abroad.css'), /@media print \{[\s\S]*\.pub-print \.pub-head, \.pub-print \.pub-foot/);
  assert.match(src('app/layout.tsx'), /import '\.\/styles\/abroad\.css';/);

  // The operator can find every setting where settings are documented.
  for (const name of ['OPERATOR_NAME', 'DATA_REGION', 'DATA_HOST', 'DATA_BACKUPS', 'MAIL_PROVIDER_NAME', 'MAIL_PROVIDER_COUNTRY', 'PAYMENT_PROVIDER_COUNTRY', 'SMS_PROVIDER_NAME', 'SMS_PROVIDER_COUNTRY']) {
    assert.ok(read('.env.example').includes(`# ${name}=`), `.env.example: ${name}`);
    assert.ok(read('README.md').includes('`' + name + '`'), `README: ${name}`);
  }
  assert.match(src('instrumentation.ts'), /dataPlaceWarning\(\)/);
});

// ---- E. When the signing page will not open where the signer is ----------------------------------------------------

test('every email that asks someone to sign says what to do when the page will not open', async () => {
  assert.equal(cannotOpenLine('Ada Sender'), 'Page will not open where you are? Reply to this email and ask Ada Sender to send the document as a PDF.');
  const e = await simple(ada, 'faraway@example.com');
  await ada.post(`/envelopes/${e.id}/send`);
  const [invite] = mailTo('faraway@example.com');
  assert.ok(invite.html.includes('Page will not open where you are? Reply to this email and ask Ada Sender to send the document as a PDF.'), 'in the footer of the invitation');
  // It is in the footer, after the link to copy, not in the body where it would read as an instruction to everyone.
  assert.ok(invite.html.indexOf('Page will not open where you are?') > invite.html.indexOf('If the button does not work, copy this link:'));
  // The reply really reaches the sender, and the plain-text part says the same.
  const row = db.get('SELECT payload FROM emails WHERE to_email=? ORDER BY id LIMIT 1', 'faraway@example.com');
  const payload = JSON.parse(row.payload);
  assert.equal(payload.replyTo, 'ada.sender@example.com');
  assert.ok(payload.text.includes(cannotOpenLine('Ada Sender')));
  // A reminder carries it too.
  const reminded = await ada.post(`/envelopes/${e.id}/remind`);
  assert.equal(reminded.status, 200, JSON.stringify(reminded.data));
  assert.ok(mailTo('faraway@example.com').at(-1)!.html.includes(cannotOpenLine('Ada Sender')));

  // Not on an email that asks nobody to open a signing page, and not on the one for an in-person signing, which
  // goes to the sender: they would be asking themselves.
  assert.ok(!renderMail({ to: 'x@example.com', subject: 's', heading: 'h', lines: ['l'] }).includes('Page will not open'));
  const inPerson = await simple(ada, 'walkin@example.com', { recipients: [{ id: 'r', role: 'inperson', name: 'Wes Walkin', email: 'walkin@example.com' }] });
  await ada.post(`/envelopes/${inPerson.id}/send`);
  const host = mailTo('ada.sender@example.com').filter((m: any) => /in-person signing for Wes Walkin/.test(m.html));
  assert.equal(host.length, 1);
  assert.ok(!host[0].html.includes('Page will not open'));
  // A name with markup in it is escaped like everything else in an email.
  assert.ok(renderMail({ to: 'x@example.com', subject: 's', heading: 'h', lines: [], askForPdf: '<b>Eve</b>' }).includes('ask &lt;b&gt;Eve&lt;/b&gt; to send'));

  // And senders are told what to do when that reply arrives, without a promise about any country.
  const help = src('app/help/outside.tsx');
  assert.match(help, /<QA id="cannot-open" q="My signer says the page will not open where they are">/);
  assert.match(help, /\{cannotOpenLine\('you'\)\}/);
  assert.match(help, /We have not tested from which places this one can be reached, so we make no promise about any country\./);
  assert.match(help, /A signature collected that way is outside GrowSigning\. It is not on our signing record and not in the document's History/);
  for (const f of ['app/help/outside.tsx', 'app/help/page.tsx', 'app/page.tsx', 'app/security/page.tsx', 'lib/policy.ts']) assert.doesNotMatch(src(f), /works in China|reachable from China|VPN/i, f);
});

// ---- F. A recipient the sender reaches themselves ("I will send the link myself") ---------------------------------

// One signer with a name and no address, whose link the sender passes on. `over` changes the recipient.
const byHand = (name = 'Wanjiru Kamau', over: any = {}) => ({ recipients: [{ id: 'r', role: 'signer', name, email: '', link_by_sender: true, ...over }] });
const linkOf = (envelopeId: string) => db.get('SELECT id, token FROM recipients WHERE envelope_id=? AND link_by_sender=1', envelopeId);
const auditOf = async (c: Client, id: string) => (await full(c, id)).audit as any[];
const signWith = async (tok: string, c = new Client()) => {
  assert.equal((await c.post(`/sign/${tok}/consent`, { wording: CONSENT_VERSION })).status, 200);
  const v = (await c.get(`/sign/${tok}`)).data;
  return c.post(`/sign/${tok}/complete`, { values: Object.fromEntries(v.fields.map((f: any) => [f.id, '1'])), signature_png: PNG, initials_png: PNG });
};

test('the words for a person without an address say what happened and nothing more', () => {
  assert.equal(BY_SENDER_LINE, 'Link shared by the sender');
  assert.equal(BY_SENDER_TICK, 'I will send the link myself');
  // The tick says before anyone relies on it: no email at all, no copy, not findable by address, and what it costs.
  assert.match(BY_SENDER_HOW, /no email at all: no invitation, no reminders, no copy at the end/);
  assert.match(BY_SENDER_HOW, /"Find my documents" on our help page cannot find it/);
  assert.match(BY_SENDER_HOW, /uses one of your signatures, also when the person is you/);
  assert.equal(labelOf({ name: 'Wanjiru Kamau', email: '', link_by_sender: 1 }), 'Wanjiru Kamau (link shared by the sender)');
  assert.equal(labelOf({ name: 'Ada', email: 'ada@example.com', link_by_sender: 0 }), 'Ada <ada@example.com>', 'everyone else is named exactly as before');
  assert.equal(whoIs({ name: 'Wanjiru Kamau', email: '', link_by_sender: 1 }), 'Wanjiru Kamau (link shared by the sender)');
  assert.equal(certName({ name: 'Wanjiru Kamau', email: '', link_by_sender: 1 }), 'Wanjiru Kamau  (link shared by the sender)');
  assert.equal(checkLine({ role: 'signer', link_by_sender: 1 }, null), 'Link shared by the sender only');
  assert.equal(checkLine({ role: 'signer', link_by_sender: 1, access_code: '4242' }, null), 'Link shared by the sender and an access code chosen by the sender');
  assert.equal(signerAt({ name: 'Wanjiru Kamau', email: '' }), 'Wanjiru Kamau, whose link the sender shares,');
  assert.match(noEmailCopyText('Ada Sender', true), /^We have no email address for you, so no copy comes by email, and "Find my documents" on our help page cannot find this one\. Download your copy now\./);
  assert.match(noEmailCopyText('Ada Sender', false), /cannot tell you when the others have finished\. Ada Sender can\./);
  assert.match(noEmailWaitText('Ada Sender'), /Ada Sender will tell you when it is your turn/);
  for (const t of [BY_SENDER_HOW, noEmailCopyText('x', true), noEmailCopyText('x', false), noEmailWaitText('x')]) assert.ok(!t.includes(String.fromCharCode(0x2014)), t);
  // Counted as a person of their own, never as "nobody".
  assert.equal(reachKey({ id: 'rcp_1', email: '', link_by_sender: 1 }), 'link:rcp_1');
  assert.equal(reachKey({ id: 'rcp_1', email: 'a@example.com', link_by_sender: 0 }), 'a@example.com');
  assert.equal(reporterKey({ id: 'rcp_2', email: '', link_by_sender: 1 }), 'link:rcp_2');
  // A group, whose members each get an email, cannot be ticked.
  assert.match(bySenderProblem({ link_by_sender: 1, name: 'HR team', group_id: 'grp_1' }, {})!, /is a group, and every member of a group gets an email of their own/);
  assert.equal(bySenderProblem({ link_by_sender: 0, name: 'Ada', email: '' }, {}), null);
});

test('a person with a name and no address gets nothing from us, the record says so, and their link does everything', async () => {
  // Without the tick, an empty address is still refused when sending.
  const bare = await simple(ada, '', { recipients: [{ id: 'r', role: 'signer', name: 'No Address', email: '' }] });
  const refused = await ada.post(`/envelopes/${bare.id}/send`);
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /No Address needs a valid email address/);

  const e = await simple(ada, '', byHand());
  const sent = await ada.post(`/envelopes/${e.id}/send`);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const r = (await full(ada, e.id)).envelope.recipients[0];
  assert.deepEqual([r.link_by_sender, r.email, r.status], [1, '', 'sent']);
  assert.equal(db.get('SELECT COUNT(*) n FROM emails WHERE envelope_id=? AND recipient_id IS NOT NULL', e.id).n, 0, 'no email is written for them');
  let audit = await auditOf(ada, e.id);
  assert.equal(audit.find((a) => a.action === 'Not emailed')?.detail, 'Wanjiru Kamau (link shared by the sender). The sender said they would send the link themselves, so no email went out. The request is open.');
  assert.ok(!audit.some((a) => a.action === 'Sent to recipient'), 'nothing claims an email was sent');
  assert.equal(r.check.line, 'Link shared by the sender only');

  // The sender takes the link from the envelope page, and that is on the record in the same words.
  const view = await ada.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: r.id });
  assert.equal(view.status, 200);
  audit = await auditOf(ada, e.id);
  assert.equal(audit.find((a) => a.action === 'Signing link issued')?.detail, 'Wanjiru Kamau (link shared by the sender)');

  // Their page knows there is no address, so it never promises an email.
  const tok = linkOf(e.id).token;
  assert.equal(view.data.url, `http://test.local/sign/${tok}`);
  const w = new Client();
  assert.equal((await w.get(`/sign/${tok}`)).data.recipient.link_by_sender, true);
  const done = await signWith(tok, w);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.envelope_status, 'completed');

  // No copy by email for them, and the record says where it is instead. The sender is told to pass it on.
  audit = await auditOf(ada, e.id);
  assert.match(audit.find((a) => a.action === 'Copy not emailed')!.detail, /^Wanjiru Kamau \(link shared by the sender\)\. There is no email address for them, so no copy was emailed\. Their link opens the completed document/);
  assert.ok(audit.filter((a) => a.actor === 'Wanjiru Kamau (link shared by the sender)').some((a) => a.action === 'Agreed to electronic records and signatures'), 'what they did is signed with how they were reached');
  const told = mailTo('ada.sender@example.com').filter((m: any) => m.subject === 'Completed: Simple agreement').at(-1)!;
  assert.match(told.html, /We have no email address for Wanjiru Kamau, so no copy went to them\. Their link opens the completed document/);
  assert.equal((await w.get(`/sign/${tok}/download`)).status, 200, 'the same link opens the completed copy');
  assert.equal(env.verifyChain(e.id).ok, true);

  // The certificate names how the link travelled, and no empty address.
  const cert = (await extractText((await ada.get(`/envelopes/${e.id}/download`)).data)).replace(/\s+/g, ' ');
  assert.match(cert, /Wanjiru Kamau \(link shared by the sender\)/);
  assert.match(cert, /Identity check Link shared by the sender only/);
  assert.doesNotMatch(cert, /<>/);
});

test('it costs a signature like anyone who is not the sender, and the sender cannot tick it to get one free', async () => {
  // The sender's own name with no address is not the sender's own address: it counts.
  assert.equal(isChargeable({ role: 'signer', name: 'Ada Sender', email: '', link_by_sender: 1, free: null }, { email: 'ada.sender@example.com', name: 'Ada Sender' }), true);
  const e = await simple(ada, '', byHand('Ada Sender'));
  await ada.post(`/envelopes/${e.id}/send`);
  assert.equal(db.get('SELECT free FROM recipients WHERE envelope_id=?', e.id).free, 0);
});

test('what cannot work without an address is refused in words before anything goes out', async () => {
  const sendIt = async (over: any, fields?: any[]) => {
    const e = await simple(ada, '', { ...byHand('Pat Phone', over), ...(fields ? { fields } : {}) });
    return ada.post(`/envelopes/${e.id}/send`);
  };
  const both = await sendIt({ email: 'pat@example.com' });
  assert.equal(both.status, 400);
  assert.match(both.data.error, /Pat Phone has an email address and "I will send the link myself" ticked\. Choose one/);
  assert.match((await sendIt({ role: 'cc' }, [])).data.error, /only gets a copy, and a copy goes out by email once everyone has finished/);
  assert.match((await sendIt({ role: 'inperson' })).data.error, /signs in person on your device, so there is no link to send them/);
  assert.match((await sendIt({ verify: 'email_code' })).data.error, /no email address here, so a one-time code by email could never reach them/);
  const withEmailField = await sendIt({}, [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'g', document_id: 'd', recipient_id: 'r', type: 'email', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.04 }]);
  assert.match(withEmailField.data.error, /has an Email field, which prints their email address on the document, and they have none here/);
  // A template cannot hold it: an envelope made from it would lose it without a word.
  const file = await upload(ada, 1);
  const tpl = await ada.post('/envelopes', { kind: 'template', subject: 'T', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Client', name: '', email: '', link_by_sender: true }] });
  assert.equal(tpl.status, 400);
  assert.match(tpl.data.error, /this is a template\. Leave it out here, and tick "I will send the link myself" on the envelope you make from the template\. Nothing was saved\./);
  // Giving an address without saying anything about the tick means we email them from now on.
  const d = await simple(ada, '', byHand('Gives Address'));
  const cur = (await full(ada, d.id)).envelope;
  const put = await ada.put(`/envelopes/${d.id}`, { subject: cur.subject, documents: cur.documents.map((x: any) => ({ id: x.id, file_id: x.file_id })), recipients: [{ id: cur.recipients[0].id, role: 'signer', name: 'Gives Address', email: 'gives@example.com' }], fields: cur.fields });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(db.get('SELECT link_by_sender FROM recipients WHERE envelope_id=?', d.id).link_by_sender, 0);
});

test('the daily limit and the automatic pause count every such person as a person', async () => {
  process.env.NEW_ACCOUNT_DAILY_RECIPIENTS = '2';
  process.env.ABUSE_SUSPEND_AFTER = '2';
  try {
    const kim = await signUp('Kim Fresh', 'kim.fresh@example.com', '198.51.100.203');
    const many = await simple(kim, '', { recipients: [0, 1, 2].map((i) => ({ id: `v${i}`, role: 'viewer', name: `Viewer ${i}`, email: '', link_by_sender: true })), fields: [] });
    const over = await kim.post(`/envelopes/${many.id}/send`);
    assert.equal(over.status, 429, JSON.stringify(over.data));
    assert.match(over.data.error, /this would add 3\./, 'three people, not none');
    // Two of them, on two envelopes, say it looks wrong: two different people, so sending pauses.
    for (const i of [0, 1]) {
      const one = await simple(kim, '', { recipients: [{ id: 'v', role: 'viewer', name: `Reader ${i}`, email: '', link_by_sender: true }], fields: [] });
      assert.equal((await kim.post(`/envelopes/${one.id}/send`)).status, 200);
      assert.equal((await new Client().post(`/sign/${linkOf(one.id).token}/report`, { reason: 'phishing' })).status, 200);
    }
    const acc = db.get("SELECT a.suspended_at FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email='kim.fresh@example.com'");
    assert.ok(acc.suspended_at, 'two people reported, so the account is paused');
  } finally {
    delete process.env.NEW_ACCOUNT_DAILY_RECIPIENTS;
    delete process.env.ABUSE_SUSPEND_AFTER;
  }
});

test('reminders, turns and questions reach the sender, who is the only one who can pass them on', async () => {
  // In order: someone with an address first, then someone whose link the sender passes on.
  const file = await upload(ada, 1);
  const e = (await ada.post('/envelopes', {
    subject: 'Two in order', ordered: true, reminder_days: 1, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'a', role: 'signer', name: 'First Mail', email: 'first.mail@example.com', routing_order: 1 }, { id: 'b', role: 'signer', name: 'Second Hand', email: '', link_by_sender: true, routing_order: 2 }],
    fields: ['a', 'b'].map((rid, i) => ({ document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y: 0.3 + i * 0.2, w: 0.3, h: 0.06 })), send: true,
  })).data.envelope;
  const turnMails = () => mailTo('ada.sender@example.com').filter((m: any) => m.subject === 'Your turn to pass it on: Two in order');
  assert.equal(turnMails().length, 0, 'not on the first send: the sender is looking at the envelope page');
  assert.equal((await signWith(tokenFor(e.id, 'first.mail@example.com'))).status, 200);
  assert.equal(turnMails().length, 1);
  assert.match(turnMails()[0].html, /It is now Second Hand&#39;s turn to sign &quot;Two in order&quot;\. You said you would send them the link yourself, so we did not write to them\./);
  const rid = linkOf(e.id).id;

  // A nudge by hand is refused in words. Reminding everyone names them as not reminded.
  const nudge = await ada.post(`/envelopes/${e.id}/remind`, { recipient_id: rid });
  assert.equal(nudge.status, 400);
  assert.match(nudge.data.error, /^Second Hand gets no email from us: you said you would send them the link yourself\. Copy it from the envelope page/);
  const all = await ada.post(`/envelopes/${e.id}/remind`);
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.not_reminded, [{ recipient_id: rid, name: 'Second Hand', why: 'link_by_sender' }]);

  // The timer: "not opened yet" in the words that fit, and the reminder goes to the sender instead.
  const past = new Date(Date.now() - 3 * 864e5).toISOString();
  db.run('UPDATE recipients SET sent_at=? WHERE id=?', past, rid);
  db.run('UPDATE envelopes SET last_reminder_at=?, sent_at=? WHERE id=?', past, past, e.id);
  await env.cronTick();
  const quiet = mailTo('ada.sender@example.com').filter((m: any) => m.subject === 'Not opened yet: Two in order');
  assert.equal(quiet.length, 1);
  assert.match(quiet[0].html, /You said you would send the link to Second Hand yourself\. If you have, it has not been opened yet\./);
  assert.doesNotMatch(quiet[0].html, /spam folder/);
  const remind = mailTo('ada.sender@example.com').filter((m: any) => m.subject === 'Reminder to pass on: Two in order');
  assert.equal(remind.length, 1);
  assert.ok((await auditOf(ada, e.id)).some((a) => a.action === 'Reminder sent to the sender' && a.detail.startsWith('Second Hand (link shared by the sender).')));

  // A question from them reaches the sender with no reply address that would go nowhere, and says so.
  const tok = linkOf(e.id).token;
  const s = new Client();
  await s.post(`/sign/${tok}/consent`, { wording: CONSENT_VERSION });
  assert.equal((await s.post(`/sign/${tok}/ask`, { message: 'Can I sign on paper instead?' })).status, 200);
  // A question is a private comment now (routes-comments.ts): the answer is written on the envelope page and shown on
  // their signing page, and the email says that they are not emailed it.
  const q = mailTo('ada.sender@example.com').filter((m: any) => /^Questions and comments: Two in order/.test(m.subject)).at(-1)!;
  assert.match(q.html, /Second Hand has no email address here, so they are not emailed your answer\. They see it when they open their link again\./);
  // Asking to be named in another script asks the sender, in words that need no address.
  assert.equal((await s.post(`/sign/${tok}/name`, { name: 'Секонд Ханд' })).data.applied, false);
  assert.ok((await auditOf(ada, e.id)).some((a) => a.action === 'Name change asked for' && a.detail.startsWith('Second Hand, whose link the sender shares, asked')));
});

test('correcting such a person: a new name keeps the link, an address means we email them from now on', async () => {
  const e = await simple(ada, '', byHand('Old Spelling'));
  await ada.post(`/envelopes/${e.id}/send`);
  const { id: rid, token: first } = linkOf(e.id);
  // The name alone, with no address: saved, and the link stays.
  const renamed = await ada.post(`/envelopes/${e.id}/correct`, { recipient_id: rid, name: 'Old Spellingg', email: '' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.deepEqual(Object.values(db.get('SELECT name, token, link_by_sender FROM recipients WHERE id=?', rid)), ['Old Spellingg', first, 1]);
  // Staying without an address and asking for a code by email cannot work, and nothing changes.
  const code = await ada.post(`/envelopes/${e.id}/correct`, { recipient_id: rid, verify: 'email_code' });
  assert.equal(code.status, 400);
  assert.match(code.data.error, /a one-time code by email could never reach them\..*Nothing was changed\.$/);
  // An address: the tick goes, the shared link stops, and the invitation goes to the address.
  const given = await ada.post(`/envelopes/${e.id}/correct`, { recipient_id: rid, name: 'Old Spellingg', email: 'now.mailed@example.com' });
  assert.equal(given.status, 200, JSON.stringify(given.data));
  const row = db.get('SELECT email, token, link_by_sender FROM recipients WHERE id=?', rid);
  assert.deepEqual([row.email, row.link_by_sender, row.token === first], ['now.mailed@example.com', 0, false]);
  assert.equal(mailTo('now.mailed@example.com').length, 1);
  assert.match((await auditOf(ada, e.id)).find((a) => a.action === 'Recipient corrected' && /now Old Spellingg <now\.mailed/.test(a.detail))!.detail, /^Old Spellingg \(link shared by the sender\) is now Old Spellingg <now\.mailed@example\.com>\. The link the sender had shared stopped working/);
});

test('a copy of the envelope keeps the choice, a template made from it does not, and a decline emails nobody without an address', async () => {
  const e = await simple(ada, '', byHand('Clone Me'));
  const copy = await ada.post(`/envelopes/${e.id}/clone`, {});
  assert.equal(copy.status, 200);
  assert.equal(db.get('SELECT link_by_sender FROM recipients WHERE envelope_id=?', copy.data.id).link_by_sender, 1);
  const tpl = await ada.post(`/envelopes/${e.id}/clone`, { kind: 'template' });
  assert.equal(db.get('SELECT link_by_sender FROM recipients WHERE envelope_id=?', tpl.data.id).link_by_sender, 0);

  // Two signers, one of them by hand: the other declines, and the one without an address is not written to.
  const file = await upload(ada, 1);
  const two = (await ada.post('/envelopes', {
    subject: 'Declined one', documents: [{ id: 'd', file_id: file.id }], send: true,
    recipients: [{ id: 'a', role: 'signer', name: 'Says No', email: 'says.no@example.com' }, { id: 'b', role: 'signer', name: 'By Hand', email: '', link_by_sender: true }],
    fields: ['a', 'b'].map((rid, i) => ({ document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y: 0.3 + i * 0.2, w: 0.3, h: 0.06 })),
  })).data.envelope;
  const no = new Client();
  const t = tokenFor(two.id, 'says.no@example.com');
  await no.post(`/sign/${t}/consent`, { wording: CONSENT_VERSION });
  assert.equal((await no.post(`/sign/${t}/decline`, { reason: 'Not for me' })).status, 200);
  // Across every test in this file: no email was ever written to an empty address.
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE trim(to_email)=''").n, 0);
});

test('the screens offer the choice, hand the sender the link, and never promise an email to someone without an address', async () => {
  // Editor: the tick replaces the address, says what it means, and the same rule as the server stops Send.
  const tick = src('components/editor/SendMyself.tsx');
  // (simplify-editor: the rule is in src/lib/editorux.ts, where the lines of a person's More are decided; the tick is the picker of "How they get it".)
  assert.match(src('lib/editorux.ts'), /export const canSendMyself = \(r: any, isTpl: boolean\) => !isTpl && !r\.group_id && \(r\.role === 'signer' \|\| r\.role === 'approver' \|\| r\.role === 'viewer'\);/);
  assert.match(tick, /export \{ canSendMyself \};/);
  assert.match(tick, /<span>\{BY_SENDER_TICK\}/);
  assert.match(tick, /\{!!r\.link_by_sender && <p id=\{hint\} className="muted small">\{BY_SENDER_HOW\}<\/p>\}/);
  assert.match(tick, /return bySenderProblem\(r, \{ fields \}\);/);
  const add = src('components/editor/StepAdd.tsx');
  assert.match(add, /\{!\(r\.link_by_sender && !isTpl\) && <input placeholder="Email"/);
  // (repair-simplify-editor: the same picker also holds "Also text the signing link" where this server sends texts.)
  assert.match(src('components/editor/PersonMore.tsx'), /if \(key === 'deliver'\) return <><SendMyself r=\{r\} isTpl=\{isTpl\} onChange=\{patch\} \/>/);
  assert.match(add, /\{more === r\.id && <PersonMore ed=\{ed\} r=\{r\} \/>\}/);
  const editor = src('components/Editor.tsx');
  assert.match(editor, /link_by_sender: !isTpl && !!r\.link_by_sender/);
  assert.match(editor, /const no = sendMyselfTrouble\(r, name, fields\.value\);/);
  assert.match(src('app/styles/abroad.css'), /\.ed-myself label\.check \{ min-height: 44px;/);

  // Envelope page: no nudge, no "Sent", the link with its share buttons while it is their turn and for their copy.
  const card = src('components/sender/Recipients.tsx');
  assert.match(card, /if \(ownLink\(r\)\) return \{ s: neverOpened\(r\) \? 'expired' : 'sent', label: 'Not opened yet' \};/);
  assert.match(card, /const reachable = turn && !isMe && r\.role !== 'inperson' && !own;/);
  assert.match(card, /\{own && <OwnLinkActions r=\{r\} envelopeStatus=\{e\.status\} busy=\{busy\} link=\{shown === r\.id \? links\[r\.id\] \|\| '' : ''\}/);
  assert.match(card, /\{qr === r\.id && links\[r\.id\] && \(turn \|\| own\) && <QrDialog/);
  assert.match(src('app/styles/abroad.css'), /\.sn-myself \.btn \{ min-height: 44px; \}/);
  const own = src('components/sender/OwnLink.tsx');
  for (const b of ['Copy link', 'QR code', 'Share on WhatsApp', 'Text']) assert.ok(own.includes(`>${b}</button>`), b);
  assert.match(own, /const done = r\.status === 'completed' && \(envelopeStatus === 'sent' \|\| envelopeStatus === 'completed'\);/);
  assert.doesNotMatch(own, /Nudge/);
  assert.match(src('components/sender/AfterSend.tsx'), /const own = acting\.filter\(\(r: any\) => ownLink\(r\) && r\.status === 'sent'\);/);
  // "Send reminder" is not offered for them alone, its answer names them apart, and the reminder sentence says where theirs go.
  const env_ = src('app/app/envelopes/[id]/page.tsx');
  assert.match(env_, /hasTurn\(r\) && !r\.muted && !stopped\.includes\(r\) && !ownLink\(r\)\);/);
  assert.match(env_, /remindedText\(reminded, \(not_reminded \|\| \[\]\)\.filter\(\(x: any\) => x\.why !== 'link_by_sender'\)\)/);
  assert.match(env_, /For someone whose link you send yourself, the reminder comes to you instead\./);
  assert.match(src('components/editor/ReminderChoice.tsx'), /n > 0 && bySender \? ' For someone whose link you send yourself, the reminder comes to you instead\.' : ''/);
  assert.match(src('components/editor/ReviewParts.tsx'), /bySender=\{!isTpl && rcps\.some\(\(r\) => r\.link_by_sender\)\}/);
  // Correct can keep them without an address, or give them one, and says which happens.
  const fix = src('components/sender/dialogs.tsx');
  assert.match(fix, /if \(!\(own && !f\.email\.trim\(\)\) && !looksLikeEmail\(f\.email\.trim\(\)\)\)/);
  assert.match(fix, /They have no email address here, so the link you sent them keeps working and nothing is emailed to them\./);

  // Signing page: what comes by email is nothing, and the link is the way back.
  const page = src('app/sign/[token]/page.tsx');
  assert.match(page, /\{me\.link_by_sender \? <NoEmailDone sender=\{sender\.name\} allDone=\{allDone\} \/> : <p[^>]*>/);
  assert.match(page, /[{:] ?me\.link_by_sender \? <NoEmailWait sender=\{sender\.name\} \/> : <p>Others need to finish first\./);
  // A question is a comment now (src/components/sign/Comments.tsx): where an answer is emailed comes from the server
  // (answers_to, null for someone without an address), and with none the page promises no email.
  assert.match(src('components/sign/Comments.tsx'), /data\?\.answers_to \? `Their answer appears here, and we email it to \$\{data\.answers_to\}\.` : 'Their answer appears here when you open this link again\.'/);
  // The consent screen's For line lives in ConsentTop.tsx.
  assert.match(src('components/sign/ConsentTop.tsx'), /sent you the link themselves, not by email from us/);

  // Help, security, developers and the API description say the same, and "Find my documents" says what it cannot find.
  const help = src('app/help/outside.tsx');
  assert.match(help, /<QA id="no-email" q="My signer has no email address, or does not read it">/);
  assert.match(help, /<b>\{BY_SENDER_TICK\}<\/b> instead of an address\. \{BY_SENDER_HOW\}/);
  assert.match(help, /not how you sent it, not whether it arrived, and not who opened it/);
  assert.match(src('app/help/page.tsx'), /Then we have no address for you and this cannot find it\. Ask the sender/);
  assert.match(src('app/help/page.tsx'), /<a href="#no-email">tick &quot;I will send the link myself&quot;<\/a>/);
  assert.match(src('app/security/page.tsx'), /<Point title="A link the sender passed on themselves\.">/);
  assert.match(src('app/developers/page.tsx'), /<C>&quot;link_by_sender&quot;: true<\/C> and no <C>email<\/C>/);
  const { openapi } = await import('../src/server/openapi.ts');
  const spec: any = openapi();
  assert.equal(spec.components.schemas.Recipient.properties.link_by_sender.type, 'boolean');
  assert.deepEqual(spec.components.schemas.Recipient.required, ['name']);
  assert.match(JSON.stringify(spec.paths['/envelopes/{id}/remind']), /link_by_sender/);
  assert.match(read('README.md'), /"I will send the link myself": a recipient with a name and no email address/);
  assert.match(read('README.md'), /\| My signers live in WhatsApp, not email, and a recipient cannot exist without an address\. \|/);
  // No em dash in anything written for this.
  for (const f of ['lib/bysender.ts', 'server/bysender.ts', 'components/editor/SendMyself.tsx', 'components/sender/OwnLink.tsx', 'components/sign/NoEmail.tsx']) assert.ok(!src(f).includes(String.fromCharCode(0x2014)), f);
});

test('a link the sender passes on is read by the fake-notice filter like an email, and passing it on gives the next person an email', async () => {
  // Not sent by us is no way round the filter: the page it opens carries the same words.
  const lou = await signUp('Lou Fresh', 'lou.fresh@example.com', '198.51.100.204');
  const lure = await simple(lou, '', { ...byHand('Vic Tim'), subject: 'PayPal invoice #4471', message: 'Your payment of $499.00 was charged. To cancel call +1 (888) 555-0142 now.' });
  const no = await lou.post(`/envelopes/${lure.id}/send`);
  assert.equal(no.status, 422, JSON.stringify(no.data));

  // The person whose link was passed on hands the document to someone with an address: from then on we email them.
  const e = await simple(ada, '', byHand('Hands On'));
  await ada.post(`/envelopes/${e.id}/send`);
  const { id: rid, token } = linkOf(e.id);
  const h = new Client();
  await h.post(`/sign/${token}/consent`, { wording: CONSENT_VERSION });
  const passed = await h.post(`/sign/${token}/reassign`, { name: 'Next Person', email: 'next.person@example.com', reason: 'My colleague signs these' });
  assert.equal(passed.status, 200, JSON.stringify(passed.data));
  assert.deepEqual(Object.values(db.get('SELECT email, link_by_sender, reassigned_from FROM recipients WHERE id=?', rid)), ['next.person@example.com', 0, 'Hands On (link shared by the sender)']);
  assert.equal(mailTo('next.person@example.com').length, 1);
  assert.match((await auditOf(ada, e.id)).find((a) => a.action === 'Reassigned')!.detail, /^Hands On \(link shared by the sender\) assigned this to Next Person <next\.person@example\.com>/);
});

test('before a correction is saved, the editor says what really happens to someone with no address', async () => {
  const { outcomes } = await import('../src/components/editor/changes.ts');
  const doc = { id: 'd', file_id: 'f', name: 'Doc', pages: 1 };
  const sig = (rid: string) => ({ id: `f-${rid}`, document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 });
  const mailed = { id: 'a', role: 'signer', name: 'Ann Mail', email: 'ann@example.com', routing_order: 1, status: 'sent' };
  const before = { documents: [doc], recipients: [mailed], fields: [sig('a')] };
  const after = { documents: [doc], recipients: [mailed, { id: 'w', role: 'signer', name: 'Wanjiru Kamau', email: '', link_by_sender: true, routing_order: 1 }], fields: [sig('a'), sig('w')] };
  const said = outcomes(before, after).people;
  assert.equal(said.find((p) => p.id === 'w')!.text, 'Is added. We send them no email: send them their link from the document\'s page once you have saved.');
  assert.equal(said.find((p) => p.id === 'a')!.text, 'Nothing changes for them. They keep the same link.', 'everyone else is told as before');
});

test('an old link whose person now has no address is answered "ask the sender", never with a promise of an email', async () => {
  // Emailed first, then the sender switches to sending the link themselves: the emailed link is replaced.
  const e = await simple(ada, 'was.mailed@example.com', { recipients: [{ id: 'r', role: 'signer', name: 'Was Mailed', email: 'was.mailed@example.com' }] });
  await ada.post(`/envelopes/${e.id}/send`);
  const old = tokenFor(e.id, 'was.mailed@example.com');
  const cur = (await full(ada, e.id)).envelope;
  const put = await ada.put(`/envelopes/${e.id}`, { subject: cur.subject, documents: cur.documents.map((x: any) => ({ id: x.id, file_id: x.file_id })), recipients: [{ id: cur.recipients[0].id, role: 'signer', name: 'Was Mailed', email: '', link_by_sender: true }], fields: cur.fields, edit_version: cur.edit_version });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(db.get('SELECT link_by_sender FROM recipients WHERE envelope_id=?', e.id).link_by_sender, 1);
  const asked = await new Client().post('/public/links/resend', { token: old });
  assert.deepEqual([asked.data.sent, asked.data.result], [false, 'ask_sender']);
  assert.match(src('components/sign/deadEnds.tsx'), /ask_sender: \['Nothing was sent\.', 'We cannot email the current link for this document\. Ask the sender for it, the way they reached you before\.'\]/);
  // The record of the correction says where the address went, in words.
  assert.ok((await auditOf(ada, e.id)).some((a) => a.action === 'Envelope corrected' && /the email address changed from was\.mailed@example\.com to none\./.test(a.detail)));
});

// ---- Repairs after the skeptic's report (verify:nonus) -------------------------------------------------

// The entries of a ZIP the app made (stored, not compressed), as tests/encrypt.test.ts reads them.
function unzipped(z: Uint8Array): Record<string, Buffer> {
  const b = Buffer.from(z);
  const out: Record<string, Buffer> = {};
  for (let i = 0; b.readUInt32LE(i) === 0x04034b50;) {
    const size = b.readUInt32LE(i + 18), nameLen = b.readUInt16LE(i + 26), extra = b.readUInt16LE(i + 28);
    out[b.subarray(i + 30, i + 30 + nameLen).toString('utf8')] = b.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    i += 30 + nameLen + extra + size;
  }
  return out;
}

test('an evidence pack prints the wording a signer saw before versions were recorded, says it was inferred, and no screen can claim that old wording', async () => {
  const { UNVERSIONED_CONSENT } = await import('../src/lib/policy.ts');
  const old = consentWording('Ada Sender', true, UNVERSIONED_CONSENT);
  assert.equal(old.version, UNVERSIONED_CONSENT);
  assert.equal(old.legal, 'You are about to review and sign this document on screen. An electronic signature has the same legal effect as a handwritten one.', 'kept word for word, as the screen showed it until 20 November 2026');
  assert.match(old.practical, /ask Ada Sender for a paper copy instead/);
  assert.equal(consentWording('Ada Sender', false, UNVERSIONED_CONSENT).legal, 'You are about to review this document on screen. An electronic signature has the same legal effect as a handwritten one.');
  // It is for the record only: a screen naming it is written down as a screen that named no wording we show.
  assert.equal(isConsentVersion(UNVERSIONED_CONSENT), false);
  const e0 = await simple(ada, 'claims-old@example.com');
  await ada.post(`/envelopes/${e0.id}/send`);
  assert.equal((await new Client().post(`/sign/${tokenFor(e0.id, 'claims-old@example.com')}/consent`, { wording: UNVERSIONED_CONSENT })).status, 200);
  assert.match((await full(ada, e0.id)).audit.find((a: any) => a.action === 'Agreed to electronic records and signatures').detail, /The screen did not say which wording it showed\. The wording in use was 2026-11/);

  // A line the way the server wrote it before versions: the action and the name, nothing else.
  const e = await simple(ada, 'old.consent@example.com');
  await ada.post(`/envelopes/${e.id}/send`);
  env.audit(e.id, { name: 'Sam Signer <old.consent@example.com>', ip: '203.0.113.9' }, 'Agreed to electronic records and signatures', 'Sam Signer');
  db.run('UPDATE recipients SET consent_at=? WHERE envelope_id=?', new Date().toISOString(), e.id);
  // And one written today, with the version the screen named.
  const e2 = await simple(ada, 'new.consent@example.com');
  await ada.post(`/envelopes/${e2.id}/send`);
  assert.equal((await new Client().post(`/sign/${tokenFor(e2.id, 'new.consent@example.com')}/consent`, { wording: CONSENT_VERSION })).status, 200);
  const consentOf = async (id: string) => unzipped((await ada.get(`/envelopes/${id}/evidence`)).data)['consent.txt'].toString();
  const before = await consentOf(e.id);
  assert.match(before, new RegExp(`Wording ${UNVERSIONED_CONSENT}, in English \\(en\\) \\(their audit line names no wording, because it was written before GrowSigning recorded which wording a screen showed; until then the signing screen showed this one, so this is inferred`));
  assert.ok(before.includes(old.legal.replace('Ada Sender', 'Ada Sender')), 'the words that person saw');
  assert.ok(!before.includes('simple electronic signature'), 'not today\'s words');
  assert.match(before, /A line written before then names no version: see the note under it\./);
  const today = await consentOf(e2.id);
  assert.match(today, new RegExp(`Wording ${CONSENT_VERSION}, in English \\(en\\):`));
  assert.ok(!today.includes('same legal effect'));
  assert.equal(env.verifyChain(e.id).ok, true);
});

test('someone with no address who asks for more time is never told "by email", and the sender is told there is no address to answer', async () => {
  const { moreTimeWords, laterWords } = await import('../src/lib/bysender.ts');
  const { momentForEmail } = await import('../src/lib/dates.ts');
  // The words: no email for someone the sender reaches themselves, as before for everyone else.
  const by = moreTimeWords('Vera Sender', true), mailed = moreTimeWords('Vera Sender', false);
  for (const t of [by.say, by.hint, by.open, laterWords(true)]) assert.doesNotMatch(t, /by email|in your email|get an email|we will email|we email you|in touch by/i, t);
  assert.match(by.say, /^We asked Vera Sender for more time\. They have no email address for you here, so they will reach you the way they sent you this link\.$/);
  assert.equal(mailed.say, 'We asked Vera Sender for more time. They will be in touch by email.');
  assert.equal(laterWords(false), 'Saved. Use the link in your email to come back and finish.');
  // The signing page picks them by me.link_by_sender, and offers no "Stop reminder emails" to someone who gets none.
  const page = src('app/sign/[token]/page.tsx');
  assert.doesNotMatch(page, /They will be in touch by email|You will get an email as soon as the document is open again|Use the link in your email to come back/);
  // (simplify-signing: Other actions has no descriptions, so the hint is gone and two uses are left; Finish later
  // answers in a note on the page, and "Stop reminder emails" moved from Other actions into that note.)
  assert.equal(page.match(/moreTimeWords\(sender\.name, !!me\.link_by_sender\)/g)?.length, 2);
  // Someone who changes the document or chooses who comes next gets the same words without "saved" (recipienttypes.ts).
  assert.match(page, /setLater\(stage === 'consent' \? laterAtConsent\(!!me\.link_by_sender\) : (isStepRole\(me\.role\) \? stepLaterWords\(!!me\.link_by_sender\) : )?laterWords\(!!me\.link_by_sender\)\)/);
  assert.doesNotMatch((await import('../src/lib/recipienttypes.ts')).stepLaterWords(true), /email/i);
  assert.match(page, /\{!muted && me\.role !== 'inperson' && !me\.link_by_sender && <button type="button" className="sg-link" onClick=\{\(\) => mute\(\)\}>Stop reminder emails<\/button>\}/);

  // The sender's email: the deadline by their own clock too, and a plain word that there is no address to answer.
  assert.equal((await ada.call('GET', '/me', undefined, { 'x-tz': 'Pacific/Auckland' })).status, 200);
  const e = await simple(ada, '', { ...byHand('Wanjiru Time'), expire_days: 14 });
  assert.equal((await ada.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = linkOf(e.id).token;
  const w = new Client();
  assert.equal((await w.post(`/sign/${tok}/consent`, { wording: CONSENT_VERSION })).status, 200);
  assert.equal((await w.post(`/sign/${tok}/request-extension`)).status, 200);
  const closes = (await full(ada, e.id)).envelope.expires_at;
  const asked = mailTo('ada.sender@example.com').filter((m: any) => m.subject === `More time needed: ${e.subject}`).pop()!;
  assert.ok(asked.html.includes(`The deadline is ${momentForEmail(closes, 'Pacific/Auckland')}.`), asked.html.slice(0, 1500));
  assert.ok(asked.html.includes('Wanjiru Time has no email address here, so this email has no reply address of theirs. Answer them the way you sent them the link.'));
  // Someone with an address: no such line.
  const e2 = await simple(ada, 'has.address@example.com', { expire_days: 14 });
  await ada.post(`/envelopes/${e2.id}/send`);
  const t2 = tokenFor(e2.id, 'has.address@example.com');
  await new Client().post(`/sign/${t2}/consent`, { wording: CONSENT_VERSION });
  assert.equal((await new Client().post(`/sign/${t2}/request-extension`)).status, 200);
  const asked2 = mailTo('ada.sender@example.com').filter((m: any) => m.subject === `More time needed: ${e2.subject}`).pop()!;
  assert.ok(!asked2.html.includes('no email address here'));
  assert.equal((await ada.call('GET', '/me', undefined, { 'x-tz': 'UTC' })).status, 200);
});

test('the check reads file names as people write them: underscores, dots, CamelCase, umlauts written out, invisible characters', async () => {
  const one = (input: any) => paperWarnings(input).map((w) => `${w.kind}:${w.seen}`);
  // Straight from file names, as the server keeps them when the sender gives no other name.
  for (const [name, want] of [
    ['power_of_attorney.pdf', 'attorney:power_of_attorney'], ['Lasting_Power_of_Attorney_Smith.pdf', 'attorney:Lasting_Power_of_Attorney'], ['PowerOfAttorney.pdf', 'attorney:PowerOfAttorney'],
    ['Deed_of_Sale.pdf', 'land:Deed_of_Sale'], ['Title_Deed_Plot14.pdf', 'land:Title_Deed'], ['Last_Will_Jo.pdf', 'will:Last_Will'], ['LastWill.pdf', 'will:LastWill'],
    ['Separation_Agreement.pdf', 'employment:Separation_Agreement'], ['Will - Jo Bloggs.pdf', 'will:Will'], ['Jo_Bloggs_Will', 'will:Will'], ['power.of.attorney.pdf', 'attorney:power.of.attorney'],
  ] as const) assert.deepEqual(one({ documents: [{ name }] }), [want], name);
  // German typed without umlauts, and ß as ss.
  for (const [subject, want] of [['Kuendigung Herr Mueller', 'employment:Kuendigung'], ['Kuendigungsschreiben', 'employment:Kuendigungsschreiben'], ['Letztwillige Verfuegung', 'will:Letztwillige Verfuegung'], ['MUELLER KUENDIGUNG', 'employment:KUENDIGUNG']] as const)
    assert.deepEqual(one({ subject }), [want], subject);
  assert.deepEqual(one({ documents: [{ name: 'Grundstueckskaufvertrag' }] }), ['land:Grundstueckskaufvertrag']);
  // Invisible characters do not cut a word in two.
  assert.deepEqual(one({ subject: 'power of at­torney' }).length, 1);
  assert.deepEqual(one({ subject: 'power​ of attorney' }).length, 1);
  // Short forms in the subject and names, and the documents that are sworn before someone.
  for (const subject of ['POA for the bank', 'LPA health and welfare', 'Power of Atty', 'Statutory declaration', 'Affidavit of support', 'Deed of gift', 'Mortgage deed'])
    assert.equal(paperWarnings({ subject }).length, 1, subject);
  // And still nothing for what only looks like it: "will" is a word on its own only in a document name.
  for (const input of [{ subject: 'Will you sign this?' }, { subject: 'We will notify you' }, { documents: [{ name: 'Goodwill_Agreement.pdf' }] }, { documents: [{ name: 'Willow Street lease.pdf' }] }, { documents: [{ name: 'Lease_v2.final.pdf' }] }, { documents: [{ name: 'X', text: 'The tenant will pay. Indeed.' }] }, { subject: 'Deed of Trust' }])
    assert.ok(paperWarnings(input).every((w) => w.kind !== 'will' && w.kind !== 'witness'), JSON.stringify(input));
  assert.deepEqual(kinds(paperWarnings({ subject: 'Deed of Trust' })), ['trust']);
  // The help page lists the names-only word and says that file names are read.
  const listed = paperWordList().find((k) => k.a === 'a will')!;
  assert.deepEqual(listed.namesOnly, ['will']);
  assert.ok(!listed.titleOnly.includes('will'));
  const help = src('app/help/outside.tsx');
  assert.match(help, /In document names only: \{k\.namesOnly\.join\(', '\)\}/);
  assert.match(help, /The name of a document is usually its file name, and it is read too: underscores and dots count as spaces/);
  assert.match(help, /an umlaut may be written out \(ue for ü\)/);

  // The same through the API: a draft with those file names warns before sending.
  const file = await upload(ada, 1);
  const d = (await ada.post('/envelopes', { subject: 'Last Will of Jo Bloggs', documents: [{ id: 'a', file_id: file.id, name: 'Lasting_Power_of_Attorney_Smith.pdf' }, { id: 'b', file_id: file.id, name: 'Kuendigung_Mueller.pdf' }], recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: 'files.named@example.com' }], fields: [{ id: 'f', document_id: 'a', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
  const w = await ada.get(`/envelopes/${d.id}/warnings`);
  assert.equal(w.status, 200);
  assert.deepEqual(kinds(w.data.warnings), ['attorney', 'employment', 'will']);
});

test('the country notes say which part of a country they are about, link the EU\'s own text, give every claim a source and state rather than instruct', () => {
  const note = (id: string) => COUNTRY_NOTES.find((n) => n.id === id)!;
  // The UK note is England and Wales law, and says so; HM Land Registry covers England and Wales only.
  assert.equal(note('uk').place, 'United Kingdom: England and Wales');
  assert.match(note('uk').text, /^This note is about England and Wales\. Scotland and Northern Ireland have their own law on deeds, wills and land/);
  assert.match(note('uk').text, /HM Land Registry, which covers England and Wales only/);
  // The EU note links EUR-Lex as the official text; the UK-kept copy is said to be what it is and not called official.
  const eu = note('eu').sources;
  assert.equal(eu[0].url, 'https://eur-lex.europa.eu/eli/reg/2014/910/oj');
  assert.equal(eu[0].official, true);
  const kept = eu.find((s) => s.url.includes('legislation.gov.uk'))!;
  assert.equal(kept.official, false);
  assert.match(kept.label, /as the United Kingdom kept and changed it after leaving the EU, not the EU's own current text/);
  assert.ok(!eu.some((s) => /the 2014 text as kept/.test(s.label)));
  // Singapore has a source of its own, and Nigeria's law is named.
  const sg = note('sg-ng');
  assert.ok(sg.sources.some((s) => s.url.startsWith('https://www.imda.gov.sg/') && /2019/.test(s.label)));
  assert.match(sg.text, /section 17\(2\) of the Cybercrimes Act 2015 leaves out wills and birth and death certificates/);
  // India: what the research confirmed, and what it did not.
  assert.match(note('in').text, /Our research confirmed that wills and trusts are still on it after a 2022 amendment\. It did not confirm the rest of that list, which has also named powers of attorney and contracts for the sale of land/);
  // An old source says how old it is.
  assert.match(note('za-ke').sources[0].label, /^De Rebus \(2012\)/);
  // No note tells the reader what to do; they say what the law asks and what GrowSigning is and is not made for.
  for (const n of COUNTRY_NOTES) assert.doesNotMatch(n.text, /\b(Do not (sign|use)|use one of those|buy the|Check your state|Add the stamped page)\b/, n.id);
  assert.doesNotMatch(stampNote('India'), /\bbuy the\b/);
  // Every note still carries its month, and the help page prints the month next to its sources.
  assert.match(src('app/help/outside.tsx'), /Looked at in \{n\.checked\}\./);
});

test('the processing summary and /security list the time zones we keep, and the Find my documents email says whose reply to use', async () => {
  const processing = src('app/security/processing/page.tsx');
  assert.match(processing, /the time zone their browser reports, which decides the day written for their signers when a signer&apos;s own device says none/);
  assert.match(processing, /and the time zone their device reports, which decides the date printed for them and is on the certificate/);
  assert.match(src('app/security/page.tsx'), /the time zone each person&apos;s device reports, which decides the date printed for them \(the first time, and again at Finish if it changed\)/);
  // The help page no longer says that every email which leads to a signing page carries the line; it says which do.
  const help = src('app/help/outside.tsx');
  assert.doesNotMatch(help, /Every email that asks someone to sign therefore ends with this line/);
  assert.match(help, /The list a signer gets from Find my documents comes from us and can name several senders, so it tells them to reply to your own email about the document instead\./);
  // And the Find my documents email does say it.
  const e = await simple(ada, 'finds.links@example.com');
  await ada.post(`/envelopes/${e.id}/send`);
  assert.equal((await new Client().post('/public/links/find', { email: 'finds.links@example.com' })).status, 200);
  const list = mailTo('finds.links@example.com').find((m: any) => m.subject === 'Your documents on GrowSigning')!;
  assert.ok(list, 'the list was emailed');
  assert.match(list.html, /Page will not open where you are\? Reply to the email the sender sent you about that document and ask them to send it as a PDF\. This list comes from GrowSigning, not from them, so a reply to it does not reach them\./);
});
