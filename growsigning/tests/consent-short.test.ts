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
import { boot, Client, signUp, simple, upload, tokenFor, PNG, type Server } from './helpers.ts';
import { otherActions } from '../src/components/sign/actions.ts';
import {
  CONSENT_VERSION, CONSENT_HISTORY, CONSENT_PARTS, consentPart, consentSigns, consentWording, consentIsShort, consentPlain, consentRecordLines, consentDetailLines, consentVersionOf, isConsentVersion,
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
  // Lighter, in numbers: our own words on the screen before the tick were 100 (wording 2026-11-21), and are now
  // none: the link of 4 words stands under Continue. With the sentence next to the tick: 108 before, 11 now. The
  // whole screen, measured in a browser at 390 by 844 and 1440 by 900 with a one-line message: 114 words before the
  // tick then, 15 now (research/consent-before-*.png, research/consent-final-*.png).
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
  assert.match(consent, /const wording = consentWording\(sender\.name, consentPart\(me\.role\), undefined, lang\);/);
  // One tick, and the sentence is its label.
  assert.equal((consent.match(/type="checkbox"/g) || []).length, 1);
  assert.match(consent, /<input type="checkbox" checked=\{agree\} [^\n]*\/> <span lang=\{wording\.language\}>\{wording\.agree\}<\/span>/);
  // The link stands under Continue, on the same card: opening it never moves the box or the button (the review
  // measured the box pushed to y=1098 on an 844 px phone when the link stood above it).
  assert.match(consent, /\}\}>\{T\('sign\.consent\.continue'\)\}<\/button>\s*<ConsentDetails wording=\{wording\} \/>\s*<\/div>/);
  assert.ok(consent.indexOf('<ConsentDetails') > consent.indexOf('type="checkbox"'));
  assert.equal((consent.match(/<ConsentDetails/g) || []).length, 1);
  // A paragraph of an older wording is printed only when that wording has one. Today's has none.
  assert.match(consent, /\{wording\.legal && <p className="muted sg-legal">\{wording\.legal\}<\/p>\}/);
  assert.match(consent, /\{wording\.practical && <p className="muted sg-legal">\{wording\.practical\}<\/p>\}/);
  // Still required: Continue does nothing but say so until the box is ticked.
  assert.match(consent, /if \(!agree\) return setFormError\(T\('sign\.consent\.tick_first'\)\);/);
  // And the agreement names the wording and the language of the words on the screen.
  assert.match(consent, /body: \{ version: version\.current, wording: wording\.version, language: wording\.language, /);
  // The same on a host's device without a connection (in person).
  const ip = read('src/app/in-person/page.tsx');
  assert.match(ip, /<Ways [^\n]*\/>\s*<ConsentDetails wording=\{wording\} \/>/);
  assert.match(ip, /const wording = consentWording\(sender, consentPart\('inperson'\), undefined, 'en'\);/);
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
    assert.ok(said.includes(`You do not have to agree. Ask ${sender} for a paper copy, or choose Other actions, then Decline to sign.`));
    assert.deepEqual(w.details.map((d) => d.h), ['What this is', 'What is recorded', 'When this may not be enough', 'A copy, paper, or saying no']);
    // In words a person uses: no "names these words", and nobody is told that "anyone" can read their record.
    assert.doesNotMatch(said, /names these words|anyone/);
    assert.match(said, /An IP address is the internet address of your connection\./);
    assert.match(said, /The record also says which version of this text you were shown, so it can be checked later\./);
    // Each fact of wording 2026-11-21, by its own words: none was dropped on the way behind the link.
    const before = consentWording(sender, true, '2026-11-21');
    for (const fact of ['simple electronic signature', 'your name or mark', 'We record the time, your IP address and each step', 'rules differ by country and by kind of document',
      'handwritten, witnessed, notarised or qualified signature', 'GrowSigning does not know which kind this document is', `ask ${sender} or a lawyer before you sign`,
      'you accept this electronic method as a valid way for you and the other parties to sign this document', 'download', 'decline', `${sender} for a paper copy`]) {
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
  // In the words of the sentence on the screen today, not of the wording before it.
  assert.equal(done.data.error, 'Please tick the box to agree to sign electronically first.');
  assert.equal(JSON.parse(read('src/locales/en.json'))['sign.error.consent_first'], 'Please tick the box to agree first.');
  assert.equal((await consentLines(e.id)).length, 0);
  // Decline works from the consent screen, without the tick.
  assert.equal((await c.post(`/sign/${tok}/decline`, { reason: 'I would like this on paper' })).status, 200);
  assert.equal((await ada.get(`/envelopes/${e.id}`)).data.envelope.status, 'declined');
  assert.equal((await consentLines(e.id)).length, 0, 'declining is not agreeing');
});

// ---- 5. Each person is shown, and recorded with, their own words -----------------------------------------------------------

test('one rule says whose words they are, for the screen and for the record', () => {
  assert.deepEqual(['signer', 'inperson', 'witness', 'approver', 'editor', 'agent', 'viewer', 'cc'].map(consentPart), ['signer', 'inperson', 'witness', 'approver', 'step', 'step', 'reader', 'reader']);
  assert.deepEqual(CONSENT_PARTS.filter(consentSigns), ['signer', 'inperson', 'witness'], 'a witness signs too');
  // The screen and the evidence pack both ask it, and neither decides "who signs" by itself for the wording.
  assert.match(read('src/app/sign/[token]/page.tsx'), /consentWording\(sender\.name, consentPart\(me\.role\), undefined, lang\)/);
  assert.match(read('src/server/evidence.ts'), /consentWordingAsRecorded\(sender\?\.name \|\| 'the sender', r \? consentPart\(r\.role\) : 'signer', version, /);
  // true and false still mean someone who signs and someone who only reads.
  assert.deepEqual(consentWording('Ada', true), consentWording('Ada', 'signer'));
  assert.deepEqual(consentWording('Ada', false), consentWording('Ada', 'reader'));
  // An older wording knew only "signs or not": a witness read the signer's paragraphs there too.
  assert.deepEqual(consentWording('Ada', 'witness', '2026-11-21'), consentWording('Ada', true, '2026-11-21'));
  assert.deepEqual(consentWording('Ada', 'approver', '2026-11-21'), consentWording('Ada', false, '2026-11-21'));
});

test('nobody is told a way to say no that their screen does not have', () => {
  // The names the menu gives its entries (src/app/sign/[token]/page.tsx), by the role of the person.
  const page = read('src/app/sign/[token]/page.tsx');
  assert.match(page, /const declineLabel = me\.role === 'approver' \? 'Decline to approve' : isStepRole\(me\.role\) \? 'Decline' : 'Decline to sign';/);
  assert.match(page, /absent: \{ key: 'absent', label: 'I was not there',/);
  const last = (role: string) => consentWording('Rosa Gardener', consentPart(role)).details.at(-1)!.lines.at(-1)!;
  const menu = (role: string) => otherActions({ role }, { stage: 'consent', deadline: false });
  for (const [role, way] of [['signer', 'Other actions, then Decline to sign.'], ['approver', 'Other actions, then Decline to approve.'], ['editor', 'Other actions, then Decline.'], ['agent', 'Other actions, then Decline.']] as const) {
    assert.ok(last(role).endsWith(way), `${role}: ${last(role)}`);
    assert.ok(menu(role).includes('decline'), `${role} has Decline in Other actions`);
  }
  // A witness cannot decline for the people who sign, so they are not told to. Their way out is "I was not there".
  assert.ok(!menu('witness').includes('decline') && menu('witness').includes('absent'));
  assert.equal(last('witness'), 'You do not have to agree. Ask Rosa Gardener for a paper copy. If you did not see them sign, choose Other actions, then I was not there.');
  assert.doesNotMatch(consentPlain(consentWording('Rosa Gardener', 'witness')), /decline/i);
  // Someone who only reads has nothing to decline.
  assert.ok(!menu('viewer').includes('decline'));
  assert.equal(last('viewer'), 'You do not have to agree. Ask Rosa Gardener for a paper copy instead.');
  assert.doesNotMatch(consentPlain(consentWording('Rosa Gardener', 'reader')), /decline|Other actions/i);
  // In person the same words must hold on the host's device without signal, which has no Other actions: the button
  // there is on the screen, under the same name.
  assert.equal(last('inperson'), 'You do not have to agree. Ask Rosa Gardener for a paper copy, or choose Decline to sign. It is on this screen or under Other actions.');
  assert.ok(menu('inperson').includes('decline'));
  assert.match(read('src/app/in-person/page.tsx'), /onClick=\{onNo\}>Decline to sign<\/button>/);
  // Every part: one sentence of at most 8 words on the face, and plain short sentences behind the link.
  for (const p of CONSENT_PARTS) {
    const w = consentWording('Rosa Gardener', p);
    assert.equal(w.agree, consentSigns(p) ? 'I agree to sign this document electronically.' : 'I agree to review this document electronically.', p);
    for (const d of w.details) for (const l of d.lines) for (const s of l.split(/(?<=[.!?])\s+/)) assert.ok(words(s) <= 22, `${p}: ${s}`);
  }
});

test('a witness is recorded with the sentence their screen showed, and their own way out', async () => {
  const file = await upload(ada, 1);
  const made = await ada.post('/envelopes', {
    subject: 'Deed of dedication', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'ann', role: 'signer', name: 'Ann Signer', email: 'ann.short@example.com' }, { id: 'wit', role: 'witness', witness_for: 'ann', name: 'Will Witness', email: 'will.short@example.com' },
      { id: 'app', role: 'approver', name: 'Abe Approver', email: 'abe.short@example.com' }],
    fields: [{ document_id: 'd', recipient_id: 'ann', type: 'signature', page: 0, x: 0.1, y: 0.3, w: 0.25, h: 0.06 }, { document_id: 'd', recipient_id: 'wit', type: 'signature', page: 0, x: 0.1, y: 0.6, w: 0.22, h: 0.05 }],
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.envelope.id;
  for (const who of ['ann', 'will', 'abe']) assert.equal((await new Client().post(`/sign/${tokenFor(id, `${who}.short@example.com`)}/consent`, { wording: CONSENT_VERSION, language: 'en' })).status, 200, who);
  const blocks = (await consentTxt(id)).split('----');
  const of = (name: string) => blocks.find((b) => b.includes(`${name} <`))!;
  // The witness: the signer's sentence, as on their screen (the pack used to print the reviewer's here).
  const will = of('Will Witness');
  assert.ok(will.includes('"I agree to sign this document electronically."'), will);
  assert.ok(!will.includes('I agree to review this document electronically.'));
  for (const line of consentDetailLines(consentWording('Ada Sender', 'witness'))) assert.ok(will.includes(line), line);
  assert.ok(will.includes('choose Other actions, then I was not there.'));
  assert.doesNotMatch(will, /Decline/);
  // And a witness still cannot decline for the others, so that sentence would have been untrue.
  assert.equal((await new Client().post(`/sign/${tokenFor(id, 'will.short@example.com')}/decline`, { reason: 'no' })).status >= 400, true);
  // The signer and the approver, each with their own.
  assert.ok(of('Ann Signer').includes('choose Other actions, then Decline to sign.'));
  const abe = of('Abe Approver');
  assert.ok(abe.includes('"I agree to review this document electronically."') && abe.includes('choose Other actions, then Decline to approve.'), abe);
});

test('/help prints the words of the people who are not the signer too', () => {
  const help = read('src/app/help/outside.tsx');
  assert.match(help, /CONSENT_PARTS\.filter\(\(p\) => p !== 'signer'\)\.map\(/);
  assert.match(help, /<summary>What other people are shown: in person, witnesses, approvers and readers<\/summary>/);
  // The answer starts with the sentence itself.
  assert.match(help, /<p>You tick one box: &quot;\{w\.agree\}&quot; The rest is behind the link &quot;\{w\.more\}&quot; on the same screen, under Continue\./);
});

test('the docs say the same: README, the API description and the certificate page', async () => {
  const readme = read('README.md');
  assert.match(readme, /one tick next to one sentence, "I agree to sign this\s+document electronically\."/);
  assert.match(readme, /"How electronic signing works"/);
  await import('../src/server/openapi-disclosure.ts');
  const spec = JSON.stringify((await ada.get('/openapi.json')).data.paths['/sign/{token}/consent']);
  assert.ok(spec.includes('2026-11-23') && spec.includes('I agree to sign this document electronically.') && spec.includes('How electronic signing works'), spec.slice(0, 400));
  assert.match(read('src/app/security/certificate/page.tsx'), /the sentence next to the box, and what the link on the same screen opened/);
  // No em dash in anything this change wrote.
  const dash = String.fromCharCode(0x2014);
  for (const f of ['src/components/sign/ConsentDetails.tsx', 'tests/consent-short.test.ts', 'src/app/help/outside.tsx']) assert.ok(!read(f).includes(dash), f);
});
