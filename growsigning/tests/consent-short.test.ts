// The consent screen since 23 November 2026 (the owner's decision: "always user friendly and as simple and easy as
// possible to use"): one short sentence with one tick, and everything a careful signer may want one tap away under
// "How electronic signing works". Nothing that was said before is gone, it moved behind the link. This file proves:
//   1. the short sentence is what is shown, and what the record names;
//   2. the details are reachable from the same screen and complete;
//   3. people who agreed under an earlier wording keep that wording in their record, word for word;
//   4. the safeguards that are not copy still hold: no Finish without agreeing, the time and the IP address on the
//      record, declining without agreeing.
// The sentences themselves are in src/lib/policy.ts, the screen in src/app/sign/[token]/page.tsx and
// src/components/sign/ConsentDetails.tsx.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, simple, tokenFor, PNG, type Server } from './helpers.ts';
import {
  CONSENT_VERSION, CONSENT_HISTORY, consentWording, consentIsShort, consentPlain, consentRecordLines, consentDetailLines, consentVersionOf, isConsentVersion,
} from '../src/lib/policy.ts';

let env: Server['env'];
let ada: Client;
before(async () => {
  ({ env } = await boot());
  ada = await signUp('Ada Sender', 'ada.short@example.com');
});

const read = (f: string) => fs.readFileSync(f, 'utf8');
const words = (s: string) => (s.trim().match(/\S+/g) || []).length;
const AGREED = 'Agreed to electronic records and signatures';
const consentLines = async (id: string) => (await ada.get(`/envelopes/${id}`)).data.audit.filter((a: any) => a.action === AGREED);

// The entries of a ZIP the app made (stored, not compressed), as tests/i18n.test.ts reads them.
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
const consentTxt = async (id: string) => unzipped((await ada.get(`/envelopes/${id}/evidence`)).data)['consent.txt'].toString();

// ---- 1. One short sentence ------------------------------------------------------------------------------------------

test('the wording in use is one short sentence next to the tick, with nothing of ours above it', () => {
  assert.equal(CONSENT_VERSION, '2026-11-23');
  assert.equal(CONSENT_HISTORY[0].version, CONSENT_VERSION, 'newest first');
  assert.equal(isConsentVersion(CONSENT_VERSION), true);
  const w = consentWording('Rosa Gardener', true);
  assert.equal(w.agree, 'I agree to sign this document electronically.');
  assert.equal(w.legal, '');
  assert.equal(w.practical, '');
  assert.equal(w.more, 'How electronic signing works');
  assert.equal(consentIsShort(w), true);
  // Someone who approves or only reads is not asked to agree to sign.
  assert.equal(consentWording('Rosa Gardener', false).agree, 'I agree to review this document electronically.');
  // The face of it: no unknown kinds of document, no paper, no lawyer, and neither the sender's name.
  for (const signs of [true, false]) {
    const face = consentWording('Rosa Gardener', signs);
    assert.doesNotMatch(`${face.agree} ${face.more}`, /does not know|kind|paper|lawyer|handwritten|notaris|Rosa/i);
    assert.ok(words(face.agree) <= 8, face.agree);
  }
  // Lighter, in numbers: our own words on the screen before the tick were 100 (wording 2026-11-21), and are now the 4
  // of the link. With the sentence next to the tick: 108 before, 11 now. The whole screen, measured in a browser at
  // 390 by 844 and 1440 by 900 with a one-line message: 114 words before the tick then, 19 now
  // (research/consent-before-*.png, research/consent-after-*.png).
  const old = consentWording('Rosa Gardener', true, '2026-11-21');
  assert.equal(words(`${old.legal} ${old.practical}`), 100);
  assert.equal(words(w.more), 4);
  assert.equal(words(`${old.legal} ${old.practical} ${old.agree}`), 108);
  assert.equal(words(`${w.more} ${w.agree}`), 11);
});

test('the screen shows the sentence with the tick and the link, and sends back the version it showed', () => {
  const page = read('src/app/sign/[token]/page.tsx');
  const consent = page.slice(page.indexOf("if (stage === 'consent') {"), page.indexOf('// ---- The document'));
  // The words come from the wording in use, in the person's language where a person has checked one.
  assert.match(consent, /const wording = consentWording\(sender\.name, acts, undefined, lang\);/);
  // One tick, and the sentence is its label.
  assert.equal((consent.match(/type="checkbox"/g) || []).length, 1);
  assert.match(consent, /<input type="checkbox" checked=\{agree\} [^\n]*\/> <span lang=\{wording\.language\}>\{wording\.agree\}<\/span>/);
  // The link stands right above the tick, inside the block the tick is described by.
  assert.match(consent, /<div id="sg-legal" lang=\{wording\.language\}>[^]*?<ConsentDetails wording=\{wording\} \/>\s*<\/div>/);
  assert.ok(consent.indexOf('<ConsentDetails') < consent.indexOf('type="checkbox"'));
  // A paragraph of an older wording is printed only when that wording has one. Today's has none.
  assert.match(consent, /\{wording\.legal && <p className="muted sg-legal">\{wording\.legal\}<\/p>\}/);
  assert.match(consent, /\{wording\.practical && <p className="muted sg-legal">\{wording\.practical\}<\/p>\}/);
  // Still required: Continue does nothing but say so until the box is ticked.
  assert.match(consent, /if \(!agree\) return setFormError\(T\('sign\.consent\.tick_first'\)\);/);
  // And the agreement names the wording and the language of the words on the screen.
  assert.match(consent, /body: \{ version: version\.current, wording: wording\.version, language: wording\.language, /);
  // The same on a host's device without a connection (in person).
  const ip = read('src/app/in-person/page.tsx');
  assert.match(ip, /<ConsentDetails wording=\{wording\} \/>/);
  assert.match(ip, /<span>\{wording\.agree\}<\/span>/);
  assert.match(ip, /consent: \{ wording: wording\.version, language: wording\.language, /);
});

test('agreeing is recorded under the new version, once, with the time and the IP address', async () => {
  const e = await simple(ada, 'short1@example.com');
  await ada.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'short1@example.com');
  const sam = Object.assign(new Client(), { ip: '198.51.100.77' });
  const t0 = Date.now();
  const r = await sam.post(`/sign/${tok}/consent`, { wording: CONSENT_VERSION, language: 'en' });
  assert.equal(r.status, 200);
  assert.equal(r.data.wording, '2026-11-23');
  const lines = await consentLines(e.id);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].detail, 'Sam Signer. Wording 2026-11-23, in English (en), as printed on the help page under "What do I agree to before I sign?".');
  assert.equal(consentVersionOf(lines[0].detail), '2026-11-23');
  assert.equal(lines[0].ip, '198.51.100.77');
  assert.ok(Math.abs(Date.parse(lines[0].at) - t0) < 60_000, lines[0].at);
  // Ticking again writes nothing more, and the chain of the record holds.
  await sam.post(`/sign/${tok}/consent`, { wording: CONSENT_VERSION });
  assert.equal((await consentLines(e.id)).length, 1);
  assert.equal(env.verifyChain(e.id).ok, true);
  // The evidence pack prints the sentence as what was on the screen, and the rest as what could be opened.
  const text = await consentTxt(e.id);
  assert.ok(text.includes('Wording 2026-11-23, in English (en):'), text.slice(0, 500));
  assert.ok(text.includes('On the screen, next to the box they ticked:\r\n\r\n"I agree to sign this document electronically."'));
  assert.ok(text.includes('One tap away on the same screen, under the link "How electronic signing works" (the record does not say whether they opened it):'));
  const w = consentWording('Ada Sender', true);
  for (const line of consentDetailLines(w)) assert.ok(text.includes(line), line);
  assert.ok(text.includes('ask Ada Sender or a lawyer before you sign'), 'with the sender named, as on the screen');
  assert.ok(text.includes('198.51.100.77'));
});

// ---- 2. The details: reachable, and complete ---------------------------------------------------------------------------

test('everything the wording before it said is still said, one tap away', () => {
  for (const sender of ['Rosa Gardener', 'Ada']) {
    const w = consentWording(sender, true);
    const said = consentPlain(w);
    // What a simple electronic signature is.
    assert.match(said, /This is a simple electronic signature: your name or mark on the page\./);
    assert.match(said, /you accept this electronic method as a valid way for you and the other parties to sign this document\./);
    // What is recorded.
    assert.match(said, /We record the time, your IP address and each step you take\./);
    // Some documents need more, and whom to ask.
    assert.match(said, /The rules differ by country and by kind of document\. Some documents need a handwritten, witnessed, notarised or qualified signature\./);
    assert.match(said, /GrowSigning does not know which kind this document is\./);
    assert.ok(said.includes(`If you are not sure, ask ${sender} or a lawyer before you sign.`));
    // A copy, paper, and saying no.
    assert.match(said, /You can download or print a copy now, and later from this same link\./);
    assert.ok(said.includes(`You do not have to agree. Ask ${sender} for a paper copy instead.`));
    assert.match(said, /You can decline\. Choose Decline on the signing page/);
    assert.deepEqual(w.details.map((d) => d.h), ['What this is', 'What is recorded', 'When this may not be enough', 'A copy, or paper', 'Saying no']);
    // Each fact of wording 2026-11-21, by its own words: none was dropped on the way behind the link.
    const before = consentWording(sender, true, '2026-11-21');
    for (const fact of ['simple electronic signature', 'your name or mark', 'We record the time, your IP address and each step', 'rules differ by country and by kind of document',
      'handwritten, witnessed, notarised or qualified signature', 'GrowSigning does not know which kind this document is', `ask ${sender} or a lawyer before you sign`,
      'you accept this electronic method as a valid way for you and the other parties to sign this document', 'download', 'decline', `${sender} for a paper copy instead`]) {
      assert.ok(`${before.legal} ${before.practical}`.toLowerCase().includes(fact.toLowerCase()), `2026-11-21 said: ${fact}`);
      assert.ok(said.toLowerCase().includes(fact.toLowerCase()), `2026-11-23 still says: ${fact}`);
    }
    // Plain words: short sentences, no em dash, and no promise about what a court will make of it.
    for (const d of w.details) for (const l of d.lines) for (const s of l.split(/(?<=[.!?])\s+/)) assert.ok(words(s) <= 22, s);
    assert.doesNotMatch(said, /\u2014|same legal effect|legally binding|as valid as|will hold up|equal to a handwritten/i);
  }
  // Someone who only reads or approves: the same, without the sentences about signing, and no Decline they may not have.
  const r = consentWording('Rosa Gardener', false);
  const said = consentPlain(r);
  assert.doesNotMatch(said, /your name or mark|to sign this document|decline/i);
  assert.match(said, /What you do here is recorded electronically, not on paper\./);
  assert.match(said, /ask Rosa Gardener or a lawyer before you continue\./);
  assert.match(said, /Ask Rosa Gardener for a paper copy instead\./);
  assert.deepEqual(r.details.map((d) => d.h), ['What this is', 'What is recorded', 'When this may not be enough', 'A copy, or paper']);
});

test('the link opens the details in place, closed when the screen opens, and /help prints them', () => {
  const c = read('src/components/sign/ConsentDetails.tsx');
  // Closed at first, one tap opens it, and the words under it are the wording's own.
  assert.match(c, /const \[open, setOpen\] = useState\(false\);/);
  assert.match(c, /<details className="sg-fold sg-how" data-fold open=\{open\}/);
  assert.match(c, /<summary lang=\{wording\.language\}>\{wording\.more\}<\/summary>/);
  assert.match(c, /\{open && <ConsentDetailWords wording=\{wording\} \/>\}/);
  assert.match(c, /\{wording\.details\.map\(\(d\) => \(/);
  assert.match(c, /<b>\{d\.h\}<\/b>\s*\{d\.lines\.map\(\(l, i\) => <p key=\{i\}>\{l\}<\/p>\)\}/);
  // A wording with nothing behind a link (the older ones) shows no link.
  assert.match(c, /if \(!wording\.details\.length\) return null;/);
  // The link is big enough for a thumb (the fold's own rule, shared with the sender's message).
  assert.match(read('src/app/styles/simplesign.css'), /\.sg-fold > summary \{[^}]*min-height: 44px;/);
  // /help prints the sentence and the details, open, under the heading the audit line names.
  const help = read('src/app/help/outside.tsx');
  assert.match(help, /<QA id="consent-wording" q="What do I agree to before I sign\?">/);
  assert.match(help, /<p><b>\{w\.agree\}<\/b><\/p>\s*<p className="muted small">Under the link &quot;\{w\.more\}&quot;, on the same screen:<\/p>\s*<ConsentDetailWords wording=\{w\} \/>/);
  // And every earlier wording, so a record that names one can still be read back there.
  assert.match(help, /const earlier = CONSENT_HISTORY\.filter\(\(h\) => h\.version !== w\.version\);/);
  assert.match(help, /\{earlier\.map\(\(h\) => \([^]*?<WordingQuote version=\{h\.version\} \/>/);
  // The helper's notes carry all of it too.
  assert.match(read('src/server/chatkb.ts'), /consentPlain\(consentWording\('the sender', true\)\)/);
});

// ---- 3. Earlier wordings stay what they were ----------------------------------------------------------------------------

test('the wordings people agreed to before are kept word for word', () => {
  assert.deepEqual(CONSENT_HISTORY.map((h) => h.version), ['2026-11-23', '2026-11-21', '2026-11-20', '2026-11']);
  const w = consentWording('Rosa Gardener', true, '2026-11-21');
  assert.equal(w.version, '2026-11-21');
  assert.equal(w.legal, 'This is a simple electronic signature: your name or mark. We record the time, your IP address and each step. The rules differ by country and by kind of document, and some need a handwritten, witnessed, notarised or qualified signature. GrowSigning does not know which kind this document is. If in doubt, ask Rosa Gardener or a lawyer before you sign. By continuing, you accept this electronic method as a valid way for you and the other parties to sign this document.');
  assert.equal(w.practical, 'You can download a copy now or later, decline, or ask Rosa Gardener for a paper copy instead.');
  assert.equal(w.agree, 'I agree to use electronic records and signatures.');
  // They had no link: everything stood above the tick, and the record says it that way.
  assert.equal(w.more, '');
  assert.deepEqual(w.details, []);
  assert.equal(consentIsShort(w), false);
  assert.deepEqual(consentRecordLines(w), [w.legal, '', w.practical, '', `"${w.agree}"`]);
  for (const v of ['2026-11-20', '2026-11']) {
    const o = consentWording('Rosa Gardener', true, v);
    assert.equal(o.version, v);
    assert.ok(o.legal && o.practical && !o.details.length, v);
    assert.equal(o.agree, 'I agree to use electronic records and signatures.');
  }
});

test('an envelope agreed to under an earlier wording keeps that wording in its record, next to one agreed to today', async () => {
  // A screen that was open across the change sends the wording it showed: that one is recorded, not today's.
  const e = await simple(ada, 'short.old@example.com');
  await ada.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'short.old@example.com');
  assert.equal((await new Client().post(`/sign/${tok}/consent`, { wording: '2026-11-21', language: 'en' })).status, 200);
  const [line] = await consentLines(e.id);
  assert.equal(line.detail, 'Sam Signer. Wording 2026-11-21, in English (en), as printed on the help page under "What do I agree to before I sign?".');
  const old = await consentTxt(e.id);
  const then = consentWording('Ada Sender', true, '2026-11-21');
  assert.ok(old.includes('Wording 2026-11-21, in English (en):'));
  assert.ok(old.includes(then.legal) && old.includes(then.practical) && old.includes(`"${then.agree}"`), 'the paragraphs their screen printed');
  assert.ok(!old.includes('I agree to sign this document electronically.'), 'not the sentence of a later wording');
  assert.ok(!old.includes('One tap away'), 'and no link they never had');
  // They are not asked again because the wording changed: their agreement stands, and they can go on.
  const view = (await new Client().get(`/sign/${tok}`)).data;
  assert.equal(view.recipient.consented, true);
  const sig = view.fields.find((f: any) => f.type === 'signature');
  assert.equal((await new Client().post(`/sign/${tok}/complete`, { values: { [sig.id]: '1' }, signature_png: PNG })).status, 200);
  assert.equal((await consentLines(e.id)).length, 1);
  assert.equal(env.verifyChain(e.id).ok, true);
  // The record after completion still names the wording of that day.
  assert.ok((await consentTxt(e.id)).includes('Wording 2026-11-21, in English (en):'));
});

// ---- 4. What is not copy stays -------------------------------------------------------------------------------------------

test('nothing can be signed before agreeing, and declining needs no agreement', async () => {
  const e = await simple(ada, 'short.no@example.com');
  await ada.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'short.no@example.com');
  const c = new Client();
  const view = (await c.get(`/sign/${tok}`)).data;
  assert.equal(view.recipient.consented, false);
  const sig = view.fields.find((f: any) => f.type === 'signature');
  const done = await c.post(`/sign/${tok}/complete`, { values: { [sig.id]: '1' }, signature_png: PNG });
  assert.equal(done.status, 400);
  assert.match(done.data.error, /Please agree to use electronic records and signatures first\./);
  assert.equal((await consentLines(e.id)).length, 0);
  // Decline works from the consent screen, without the tick.
  assert.equal((await c.post(`/sign/${tok}/decline`, { reason: 'I would like this on paper' })).status, 200);
  assert.equal((await ada.get(`/envelopes/${e.id}`)).data.envelope.status, 'declined');
  assert.equal((await consentLines(e.id)).length, 0, 'declining is not agreeing');
});

test('the docs say the same: README, the API description and the certificate page', async () => {
  const readme = read('README.md');
  assert.match(readme, /one tick next to one sentence, "I agree to sign this\s+document electronically\."/);
  assert.match(readme, /"How electronic signing works"/);
  await import('../src/server/openapi-disclosure.ts');
  const spec = JSON.stringify((await ada.get('/openapi.json')).data.paths['/sign/{token}/consent']);
  assert.ok(spec.includes('2026-11-23') && spec.includes('I agree to sign this document electronically.') && spec.includes('How electronic signing works'), spec.slice(0, 400));
  assert.match(read('src/app/security/certificate/page.tsx'), /the sentence next to the box, and what the link above it opened/);
  // No em dash in anything this change wrote.
  const dash = String.fromCharCode(0x2014);
  for (const f of ['src/components/sign/ConsentDetails.tsx', 'tests/consent-short.test.ts', 'src/app/help/outside.tsx']) assert.ok(!read(f).includes(dash), f);
});
