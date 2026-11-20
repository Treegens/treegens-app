// What the product says to people outside the United States, and whether it is true. Every test here pins down
// something from research/gaps-partial.json ("map:nonus": the false promises about wording, law, price and language,
// and the needs with priority 1, 8, 12, 13, 14, 16, 19, 20, 21, 22 and 24). Each failed before its fix.
// Wording that both a page and the server use lives in src/lib (policy.ts, paperwork.ts, dataplace.ts, impact.ts),
// so most of it is tested as plain functions. Where a promise is only words on a page, the source of the page is read.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, simple, tokenFor, signUp, mailTo, type Server } from './helpers.ts';
import { CONSENT_VERSION, consentWording, isConsentVersion, adoptLine, LANGUAGE_NOTE } from '../src/lib/policy.ts';
import { usd, CURRENCY_NOTE } from '../src/lib/impact.ts';
import { PDFDocument } from 'pdf-lib';
import { paperWarnings, paperAuditNote, paperWordList, PAPER_KINDS, PAPER_TAIL, STAMP_ZONES, stampNote, COUNTRY_NOTES } from '../src/lib/paperwork.ts';
import { PAPER_AUDIT_ACTION } from '../src/server/warnings.ts';
import { dataPlace, dataPlaceWarning, notSaid } from '../src/lib/dataplace.ts';
import { MAIL_COPY_DAYS, CLOSE_GRACE_DAYS } from '../src/lib/policy.ts';
import { cannotOpenLine } from '../src/lib/policy.ts';
import { renderMail } from '../src/server/mail.ts';

let db: Server['db'];
let env: Server['env'];
let ada: Client;
before(async () => {
  ({ db, env } = await boot());
  ada = await signUp('Ada Sender', 'ada.sender@example.com', '198.51.100.201');
});

const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const src = (p: string) => read(`src/${p}`);
const full = async (c: Client, id: string) => (await c.get(`/envelopes/${id}`)).data;
// What no page, email or record of ours may say about a signature made here.
const PROMISES = /same legal effect|as valid as|legally binding|is legally valid|will hold up|equal to a handwritten|pen on paper/i;

// ---- A. Words that were not true -----------------------------------------------------------------------------------

test('the consent text says what kind of signature this is and never that it equals a handwritten one', () => {
  const w = consentWording('Ada Sender', true);
  assert.equal(w.version, CONSENT_VERSION);
  assert.match(w.legal, /simple electronic signature/);
  assert.match(w.legal, /rules differ by country and by kind of document/);
  assert.match(w.legal, /handwritten, witnessed, notarised or qualified signature/);
  assert.match(w.legal, /Sign&Grow does not know which kind this document is/);
  assert.match(w.legal, /ask Ada Sender or a lawyer before you sign/);
  // Need 16: the parties accept the method between themselves, in so many words.
  assert.match(w.legal, /you accept this electronic method as a valid way for you and the other parties to sign this document/);
  assert.match(w.practical, /ask Ada Sender for a paper copy instead/);
  assert.doesNotMatch(`${w.legal} ${w.practical} ${w.agree}`, PROMISES);
  // One paragraph each, and no em dash anywhere.
  assert.doesNotMatch(`${w.legal}${w.practical}`, /\n|\u2014/);

  // Someone who approves or only reads is not told that they sign, or that they accept a way of signing.
  const reads = consentWording('Ada Sender', false);
  assert.doesNotMatch(reads.legal, /and sign|your name or mark|you accept this electronic method/);
  assert.match(reads.legal, /rules differ by country and by kind of document/);
  assert.match(reads.legal, /ask Ada Sender or a lawyer before you continue/);
  assert.doesNotMatch(`${reads.legal} ${reads.practical}`, PROMISES);

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
  assert.match(page, /const wording = consentWording\(sender\.name, acts\)/);
  assert.match(page, /<p className="muted sg-legal">\{wording\.legal\}<\/p>/);
  assert.match(page, /aria-describedby=\{formError \? 'sg-legal sg-agree-err' : 'sg-legal'\}/);
  assert.match(page, /<span>\{wording\.agree\}<\/span>/);
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
  assert.equal(lines[0].detail, `Sam Signer. Wording ${CONSENT_VERSION}, as printed on the help page under "What do I agree to before I sign?".`);
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
    assert.equal(line.detail, `Sam Signer. The screen did not say which wording it showed. The wording in use was ${CONSENT_VERSION}, as printed on the help page under "What do I agree to before I sign?".`);
  }

  // The help page prints the words under that heading, with the version, so the line can be read back by anyone.
  const help = src('app/help/outside.tsx');
  assert.match(help, /<QA id="consent-wording" q="What do I agree to before I sign\?">/);
  assert.match(help, /<p>\{w\.legal\}<\/p>/);
  assert.match(help, /This is wording \{w\.version\}/);
  assert.match(src('app/help/page.tsx'), /<ConsentWords \/>/);
});

test('a page promises a QR code only because the app draws one, and every public page says which language signers are asked in', () => {
  const landing = src('app/page.tsx');
  // The landing page once promised "a public link or QR code" while nothing drew one, and then said to use a tool
  // of your own. The app now makes the code itself (src/lib/qr.ts, held to the standard in tests/qr.test.ts), so the
  // page says that, and the promise stands on code that exists.
  assert.doesNotMatch(landing, /link or QR code|tool of your own|we do not make one yet/);
  assert.match(landing, /print the QR code the app makes for it on a sheet/);
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

  const landing = src('app/page.tsx');
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
  assert.match(src('app/impact/page.tsx'), /\{usd\(d \? fmtNum\(d\.donatedUsd, 2\) : '…'\)\}/);
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
  assert.match(stampNote('India'), /^Signing here does not pay stamp duty\..*e-stamp certificate.*first document of the envelope/);
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
  assert.match(src('app/page.tsx'), /<Link href="\/help#enough">check before you rely on it<\/Link>/);
  assert.match(src('app/security/page.tsx'), /<Link href="\/help#outside-us">/);
});

test('every country note is dated, hedged and rests on a source the research names', () => {
  const research = read('research/gaps-partial.json');
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
  assert.match(text('eu'), /Sign&Grow makes the first/);
  assert.match(text('de'), /qualified electronic signature, which Sign&Grow does not provide/);
  assert.match(text('uk'), /Sign&Grow has no witness step/);
  assert.match(text('in'), /not an Aadhaar eSign and not a digital signature certificate/);
  assert.match(text('in'), /signing here does not pay stamp duty/);
  assert.match(text('za-ke'), /Sign&Grow is not such a provider/);
  assert.match(text('br'), /ICP-Brasil certificate, which Sign&Grow does not provide/);
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
  assert.match(page, /it adds no encryption of its own to stored files/);
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
  assert.match(help, /A signature collected that way is outside Sign&Grow\. It is not on our certificate and not in the audit trail/);
  for (const f of ['app/help/outside.tsx', 'app/help/page.tsx', 'app/page.tsx', 'app/security/page.tsx', 'lib/policy.ts']) assert.doesNotMatch(src(f), /works in China|reachable from China|VPN/i, f);
});
