// The signing page, the consent screen and the invitation email made simpler (brief "simplify-signing",
// research/ux-charter.md 2.6 and its corrections in research/ux.json "ux:check"). No feature is added here: these
// tests hold the shorter screens to their numbers, and hold on to everything a person could do before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, simple, draft, mailTo, tokenFor, PNG } from './helpers.ts';
import { otherActions, lookAgain, nameDiffers, nextOpens, laterAtConsent, ACTION_ORDER, WITNESS_ACTIONS, MAX_ACTIONS, GUIDE_NEXT, GUIDE_FINISH, FLAG_MARGIN } from '../src/components/sign/actions.ts';
import { CONSENT_WORDS, wordsIn, laterLabel, reviewTitle, savedLine } from '../src/components/sign/actions.ts';
import { readTypedName, writeTypedName } from '../src/components/sign/typedName.ts';
import { orgOf } from '../src/lib/sendername.ts';
import { CONSENT_HISTORY, isConsentVersion } from '../src/lib/policy.ts';
import { rudeCode, checkCode, shortCode } from '../src/server/util.ts';
import { placeFlag } from '../src/components/sign/fields.ts';
import { CANNOT_REACH } from '../src/components/sign/stuck.ts';
import { consentWording, CONSENT_VERSION, adoptLine } from '../src/lib/policy.ts';
import { yourMoment, momentForReader, momentText } from '../src/lib/dates.ts';
import { CHAT_SHORT_AI, CHAT_SHORT_BUILTIN } from '../src/lib/chat.ts';
import { renderMail } from '../src/server/mail.ts';

await boot();
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const page = read('src/app/sign/[token]/page.tsx');
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
let n = 0;
const ip = () => `198.51.100.${++n}`;
// What a person reads of an email: the tags gone, the entities back.
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
// The part of an email above its button, and the part under it.
const aboveButton = (html: string) => textOf(html.slice(html.indexOf('<h1'), html.indexOf('<p style="margin:24px 0 8px">')));
const underButton = (html: string) => textOf(html.slice(html.indexOf('<p style="margin:24px 0 8px">')));

// ---- 1. The signing page: Next opens, the pointer keeps off labels, the view is behind More -------------------------

test('Next opens the field when a tap would only have opened a dialog: a signature, initials or a stamp still to be made', () => {
  assert.equal(nextOpens({ type: 'signature' }, false, false), true);
  assert.equal(nextOpens({ type: 'initials' }, false, false), true);
  assert.equal(nextOpens({ type: 'stamp' }, false, false), true);
  // A signature already made in this tab goes on with a tap of the person's own, never by Next alone.
  assert.equal(nextOpens({ type: 'signature' }, false, true), false);
  // Nothing that is filled in is opened again, and a text field is gone to and given the focus as before.
  assert.equal(nextOpens({ type: 'signature' }, true, false), false);
  assert.equal(nextOpens({ type: 'text' }, false, false), false);
  assert.match(page, /if \(open && opensOnNext\(f\)\) \{/);
  assert.match(page, /return f\.type === 'stamp' \? setStampFor\(f\.id\) : clickSig\(f\);/);
  assert.match(page, /goTo\(nextField, true\)\)\}>Next<\/button>/);
  // Someone who cannot reach a field is told where Easy reading is now (the text view, renamed by reading-view).
  assert.equal(CANNOT_REACH, 'Cannot reach this field? Choose More, then Easy reading, where every field is listed as a form you can fill in.');
});

test('the "Sign here" pointer never stands on a printed label, or right beside one on the same line', () => {
  // The page of the researcher's screenshot at 390 px: "Signed by the Sponsor:" above the field, "Date:" under it
  // and to the left. Without a margin the pointer went under the field and read "Date: Sign here".
  const pageW = 366, pageH = 518;
  const field = { x: 0.2, y: 0.45, w: 0.24, h: 0.06 };
  const flag = { w: 104 / pageW, h: 27 / pageH }, gap = { x: 10 / pageW, y: 8 / pageH };
  const labelAbove = { x: 0.14, y: 0.415, w: 0.2, h: 0.02 };
  const dateLabel = { x: 0.14, y: 0.535, w: 0.045, h: 0.02 };
  assert.equal(placeFlag(field, flag, gap, [labelAbove, dateLabel]), 'below', 'as it was: under the field, next to "Date:"');
  const margin = { x: FLAG_MARGIN.x / pageW, y: FLAG_MARGIN.y / pageH };
  assert.equal(placeFlag(field, flag, gap, [labelAbove, dateLabel], margin), 'right', 'with room kept around the words it goes beside the field');
  // Nothing in the way: above, as before. A margin never moves a pointer that was clear of everything.
  assert.equal(placeFlag(field, flag, gap, [], margin), 'above');
  assert.match(page, /p \? \{ x: FLAG_MARGIN\.x \/ p\.w, y: FLAG_MARGIN\.y \/ p\.h \} : undefined\)/);
});

test('the view, the size of the pages and the download are behind one More of at most six lines; nothing above the pages', () => {
  const more = read('src/components/sign/More.tsx');
  assert.match(more, /data-more="screen" aria-haspopup="dialog" aria-expanded=\{open\}/);
  const dialog = more.slice(more.indexOf('export function MoreDialog'));
  // Two views, the three sizes of ZoomControl (ZOOMS), one download: six. The dialog's own Close is the way back.
  assert.equal((dialog.match(/<button /g) || []).length, 2);
  assert.equal((dialog.match(/<ZoomControl /g) || []).length, 1);
  assert.equal((dialog.match(/<a /g) || []).length, 1);
  assert.match(dialog, />\{T\('sign\.read\.easy'\)\}<\/button>/);
  assert.match(dialog, /Download the document<\/a>/);
  // The row of six controls above the pages is gone, and so are its copies inside Other actions.
  assert.doesNotMatch(page, /className="sg-tools"|sg-menu-doc|docTools/);
  assert.match(page, /<MoreButton open=\{open === 'more'\} onOpen=\{go\('more'\)\} \/>/);
  assert.match(page, /<MoreButton open=\{open === 'more'\} onOpen=\{go\('more'\)\} className="btn sg-morebtn" \/>/, 'and in the bar at the bottom of a phone');
  // A keyboard or screen reader user still meets the text view before the pages, which are pictures.
  assert.match(page, /className="sg-skip sg-skip-text" onClick=\{\(\) => chooseView\('text'\)\}/);
  // No internal number and no sender word on the signer's page.
  assert.doesNotMatch(page, /Envelope \{env\.id\}/);
});

// ---- 2. The consent screen and Other actions ---------------------------------------------------------------------

test('Other actions: one fixed order, no descriptions, never more than six, and Finish later is there before agreeing', () => {
  const signer = { role: 'signer' };
  assert.deepEqual(otherActions(signer, { stage: 'consent', deadline: true }), ['later', 'time', 'reassign', 'ask', 'decline']);
  assert.deepEqual(otherActions(signer, { stage: 'consent', deadline: false }), ['later', 'reassign', 'ask', 'decline']);
  assert.deepEqual(otherActions(signer, { stage: 'sign', deadline: true, paper: true }), ['later', 'time', 'reassign', 'ask', 'paper', 'decline']);
  // Someone who took on a group's document hands it back, and passes it to nobody outside the group.
  assert.deepEqual(otherActions({ role: 'signer', group: { can_hand_back: true, name: 'Legal' } }, { stage: 'sign', deadline: true }), ['later', 'time', 'handback', 'ask', 'decline']);
  assert.deepEqual(otherActions({ role: 'signer', group: { can_hand_back: false } }, { stage: 'sign', deadline: false }), ['later', 'ask', 'decline']);
  // A viewer and someone with a copy close nothing for the others.
  assert.deepEqual(otherActions({ role: 'viewer' }, { stage: 'sign', deadline: false }), ['later', 'ask']);
  assert.deepEqual(otherActions({ role: 'cc' }, { stage: 'sign', deadline: true }), ['ask']);
  // A witness has a list of their own, without Decline.
  assert.deepEqual(otherActions({ role: 'witness' }, { stage: 'sign', deadline: true }), [...WITNESS_ACTIONS]);
  // Every combination: at most six, in the fixed order, Decline last when it is there.
  for (const role of ['signer', 'approver', 'viewer', 'cc', 'inperson'])
    for (const stage of ['consent', 'sign'])
      for (const deadline of [true, false])
        for (const paper of [true, false])
          for (const group of [null, { can_hand_back: true }, { can_hand_back: false }]) {
            const keys = otherActions({ role, group }, { stage, deadline, paper });
            assert.ok(keys.length <= MAX_ACTIONS, `${role} ${stage}: ${keys}`);
            assert.deepEqual(keys, ACTION_ORDER.filter((k) => keys.includes(k)), 'the fixed order');
            if (keys.includes('decline')) assert.equal(keys.at(-1), 'decline');
          }
  // The entries have no descriptions, and paper is offered only when the account has its own consent text
  // (tests/ds-consent-own.test.ts): with zero setup, to nobody.
  const actions = page.slice(page.indexOf('const ACTION: Record<ActionKey, MenuItem>'), page.indexOf('const menu: MenuItem[]'));
  assert.doesNotMatch(actions, /hint:/);
  assert.match(page, /otherActions\(me, \{ stage, deadline: !!env\.expires_at, paper: !!data\.own_terms \}\)/, 'paper only with the account\'s own text');
  // After Finish later the page says where the way back is, also for someone with no email from us.
  assert.equal(laterAtConsent(false), 'Nothing is lost. Use the link in your email when you are ready.');
  assert.doesNotMatch(laterAtConsent(true), /email/);
  // What left the list did not leave the page: Help is one button in the top bar, Stop reminder emails is in the note
  // after Finish later, and "Fix my name" is behind a tap on the name on the document and in Pass to someone else.
  assert.match(page, /const headHelp = me\.role === 'witness' \? undefined : go\('help'\);/);
  assert.match(page, /onClick=\{\(\) => mute\(\)\}>Stop reminder emails<\/button>/);
  assert.match(page, /if \(f\.type === 'full_name' && me\.role !== 'viewer'\)\s+return <button key=\{f\.id\} type="button" \{\.\.\.common\} title="Added for you" aria-haspopup="dialog" onClick=\{go\('name'\)\}/);
  assert.match(page, /\{open === 'name' && <NameDialog name=\{me\.name\} approving=\{me\.role === 'approver'\} onRename=\{rename\}/);
  assert.match(page, /<ReassignDialog base=\{base\} sender=\{sender\} fixName=\{<FixName name=\{me\.name\} onRename=\{rename\} \/>\}/);
  assert.match(read('src/components/sign/NameDialog.tsx'), /<FixName name=\{name\} onRename=\{onRename\} \/>/);
  assert.match(page, /<ReviewDialog [^]*?onRename=\{rename\} \/>/, 'and where it always was, when that step opens');
});

test('the consent screen: the sender once, 120 words or fewer before the tick, the deadline in the signer\'s own time', () => {
  // Our own words, with a sender whose name has two words: 100 at most (wording 2026-11-21, which says again that a
  // copy can be downloaded and that each step is recorded). The whole screen was measured in a browser the way
  // tests/ux/flows.cjs counts it: 114 words before the tick with a four-word subject and no message, 116 with the
  // sender's message behind "Read the message" (tests/out/repair-simplify-signing/probe.log).
  for (const signs of [true, false]) {
    const w = consentWording('Rosa Gardener', signs);
    assert.ok(words(`${w.legal} ${w.practical}`) <= 100, `${words(`${w.legal} ${w.practical}`)} words`);
    // No sentence of more than 21 words (the one about accepting the method is 21, and its words are pinned by
    // tests/gaps-nonus-words.test.ts, so it stays).
    for (const s of `${w.legal} ${w.practical}`.split(/(?<=[.!?])\s+/)) assert.ok(words(s) <= 21, s);
  }
  assert.equal(consentWording('Ada', true).version, CONSENT_VERSION);
  const consent = page.slice(page.indexOf("if (stage === 'consent') {"), page.indexOf('// ---- The document'));
  // The sender is named once, by name and address, and the account only when its name says more than the person's.
  assert.equal((consent.match(/<Sender /g) || []).length, 0, 'the "Sent by / Email / Account" box is gone');
  // The top of the screen lives in ConsentTop.tsx, which keeps it to 120 words (tests/open-signing.test.ts).
  assert.match(consent, /<ConsentTop data=\{data\} ask=\{ask\} myEmail=\{myEmail\} \/>/);
  const top = read('src/components/sign/ConsentTop.tsx');
  assert.match(top, /<p className="sg-from">From <b>\{sender\.name\}<\/b>\{org \? <> at \{org\}<\/> : null\}/);
  assert.match(top, /const org = orgOf\(data\.brand\?\.name, sender\.name\);/);
  assert.equal(orgOf("Rosa Gardener's workspace", 'Rosa Gardener'), '', 'never "Rosa Gardener\'s workspace"');
  // The subject is the heading of the screen, so the bar above does not say it a second time.
  assert.match(consent, /<Shell data=\{data\} bar=\{other\} footer=\{report\} helpInNewTab plainBar onHelp=\{headHelp\}>/);
  // One way to read it first, and one tick. No tree line and no price on the screen where the method is agreed to.
  assert.equal((consent.match(/href=\{`\$\{downloadUrl\}/g) || []).length, 1);
  assert.equal((consent.match(/type="checkbox"/g) || []).length, 1);
  assert.doesNotMatch(consent, /<Impact|mangrove|sheets of paper/);
  // Other actions is on this screen, and Report this request stays in its footer.
  assert.match(consent, /\{menuDialog\}/);
  // The deadline by the clock of the device, on every screen that names it.
  assert.equal(yourMoment('2027-03-20T22:33:00Z', 'Asia/Kolkata'), '21 March 2027 at 04:03, your time');
  assert.equal(yourMoment('2027-03-20T22:33:00Z', 'Nope/Nowhere'), '20 March 2027 at 22:33, your time', 'a zone we cannot read: the device said nothing we can use');
  assert.doesNotMatch(page, /momentText\(/, 'no deadline in UTC on the signing page');
  assert.equal((page.match(/yourMoment\(env\.expires_at, deviceZone\(\)\)/g) || []).length, 3);
});

// ---- 3. "Your signature", "Sign", and Finish that signs ---------------------------------------------------------------

test('the dialog is "Your signature" with the button "Sign"; nothing a signer reads says "adopt"', () => {
  const pad = read('src/components/SignaturePad.tsx');
  assert.match(pad, /<Dialog title=\{kind === 'signature' \? 'Your signature' : 'Your initials'\}/);
  assert.match(pad, /const sign = doneLabel \|\| \(kind === 'signature' \? 'Sign' : 'Add initials'\);/);
  // Every string of the dialog a person can read, and the refusals of the server at Finish.
  for (const s of pad.match(/'[^'\n]*'|>[^<>{}\n]+</g) || []) assert.doesNotMatch(s, /\badopt/i, s);
  assert.doesNotMatch(read('src/server/envelopes.ts'), /'Adopt /);
  assert.doesNotMatch(adoptLine('signature'), /adopt/i);
  // In Settings nothing is signed, so the same dialog says Save there.
  assert.match(read('src/app/app/settings/page.tsx'), /<AdoptSignature kind=\{adopt\} name=\{me\.user\.name\} doneLabel="Save"/);
});

test('Finish signs at once, and "Check before you finish" comes only when something needs a look', () => {
  const quiet = { questions: 0, witness: null, typedName: 'Ada Sponsor', name: 'Ada Sponsor' };
  assert.deepEqual(lookAgain(quiet), []);
  assert.deepEqual(lookAgain({ ...quiet, questions: 1 }), ['question']);
  assert.deepEqual(lookAgain({ ...quiet, witness: { may_name: true, name: null } }), ['witness']);
  assert.deepEqual(lookAgain({ ...quiet, witness: { may_name: true, name: 'Wim', state: 'absent' } }), ['witness']);
  assert.deepEqual(lookAgain({ ...quiet, witness: { may_name: true, name: 'Wim', state: 'named' } }), []);
  assert.deepEqual(lookAgain({ ...quiet, typedName: 'Ada Sponsr' }), ['name']);
  assert.deepEqual(lookAgain({ ...quiet, cannotPrint: 2, problem: 'x' }), ['print', 'problem']);
  // The same name in other capitals, spacing or dots is the same name. A drawn signature has no typed name.
  for (const same of ['ada sponsor', 'ADA  SPONSOR', ' Ada Sponsor ', 'Ada-Sponsor']) assert.equal(nameDiffers(same, 'Ada Sponsor'), false, same);
  for (const none of [null, undefined, '', '   ']) assert.equal(nameDiffers(none, 'Ada Sponsor'), false);
  assert.equal(nameDiffers('Somebody Else', 'Ada Sponsor'), true);
  const finish = page.slice(page.indexOf('async function pressFinish()'), page.indexOf('async function complete()'));
  // A wrong answer is still gone to first, and pages that are not on the screen still stop it.
  assert.ok(finish.indexOf('if (!allShown) return toast(NOT_SHOWN, true);') < finish.indexOf('lookAgain('));
  assert.ok(finish.indexOf('problemWith(f, values[f.id]') < finish.indexOf('lookAgain('));
  assert.match(finish, /if \(lookAgain\(\{ questions, witness: me\.witness, typedName: sig \? typedName : null, name: me\.name \}\)\.length\) return setOpen\('review'\);/);
  // Characters the signed PDF cannot print are asked about before signing, and shown in the same step.
  assert.match(finish, /api\(`\$\{base\}\/print-check`, \{ body: \{ values \} \}\)/);
  assert.match(finish, /if \(unprintable\) return setOpen\('review'\);\s+complete\(\);/);
  // A check that could not be made is not a check that found nothing: the step opens and says so (repair, low).
  assert.match(finish, /\.then\(\(r: any\) => r\?\.problems\?\.length \|\| 0, \(\) => -1\);/);
  assert.match(finish, /if \(unprintable < 0\) setCheckFailed\(true\);/);
  assert.doesNotMatch(finish, /\(\) => 0\)/, 'a failed check never counts as no problems');
  // The typed name reaches the page from the dialog, and the step says why it opened.
  assert.match(page, /if \(adopt\.kind === 'signature'\) \(setSig\(png\), setTypedName\(typed \?\? null\), writeTypedName\(token, typed\)\);/);
  assert.match(page, /!!sig && nameDiffers\(typedName, me\.name\) && <div className="notice warn sg-problem" role="status"><b>Check your name\.<\/b>/);
  // No dialog opens by itself: the hook that did it is gone.
  assert.equal(fs.existsSync(new URL('../src/components/sign/autoReview.ts', import.meta.url)), false);
  assert.doesNotMatch(page, /useAutoReview/);
  assert.equal(GUIDE_NEXT, 'Choose Next to go to each place that needs you.');
  assert.match(GUIDE_FINISH, /Choose Finish to sign and send it\.$/);
});

test('a Finish that skips the check is still refused by the server when the signature is missing, in plain words', async () => {
  const c = await signUp('Fay Sender', 'fay-simplify@example.com', ip());
  const e = await simple(c, 'sig-missing@example.com');
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const s = new Client(), tok = tokenFor(e.id, 'sig-missing@example.com');
  // Before agreeing nothing can be finished, however the page is driven.
  const early = await s.post(`/sign/${tok}/complete`, { values: {}, signature_png: PNG });
  assert.equal(early.status >= 400, true);
  await s.post(`/sign/${tok}/consent`);
  const v = (await s.get(`/sign/${tok}`)).data;
  const no = await s.post(`/sign/${tok}/complete`, { values: { [v.fields[0].id]: '1' }, version: v.version });
  assert.equal(no.status, 400);
  assert.equal(no.data.error, 'Your signature is missing. Make it on the page, then finish again.');
  const yes = await s.post(`/sign/${tok}/complete`, { values: { [v.fields[0].id]: '1' }, signature_png: PNG, version: v.version });
  assert.equal(yes.status, 200);
  // Pressing Finish twice signs once.
  const again = await s.post(`/sign/${tok}/complete`, { values: { [v.fields[0].id]: '1' }, signature_png: PNG, version: v.version });
  assert.notEqual(again.status, 200);
});

// ---- 4. The invitation email ---------------------------------------------------------------------------------------

test('the invitation: 80 words or fewer above the button, and one short footer with the code, the report link and the link itself', async () => {
  const c = await signUp('Rosa Gardener', 'rosa-simplify@example.com', ip());
  const e = await simple(c, 'ada-simplify@example.com', { subject: 'Please sign: Planting partnership', expire_days: 30 });
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const mail = mailTo('ada-simplify@example.com').at(-1)!;
  const above = aboveButton(mail.html), under = underButton(mail.html);
  assert.ok(words(above) <= 80, `${words(above)} words above the button`);
  // The heading no longer runs into the subject ("... to sign: Please sign: ..."): the subject is the line under it.
  assert.match(above, /^Rosa Gardener sent you a document to sign Please sign: Planting partnership Reply to this email to reach Rosa Gardener \(rosa-simplify@example\.com\)\.$/);
  // The account is not named at the top when it is only "<sender>'s workspace": our own logo stands there.
  assert.doesNotMatch(mail.html, /workspace/);
  assert.match(mail.html, /brand\/email-logo\.png/);
  // Under the button: the button, the deadline and one footer. It was about 170 words in three blocks.
  assert.ok(words(under) <= 115, `${words(under)} words under the button`);
  assert.ok(words(textOf(mail.html)) <= 150, `${words(textOf(mail.html))} words in all (204 before)`);
  assert.equal((mail.html.match(/border-radius:14px/g) || []).length, 1, 'one card, no second panel for the code');
  const code = /letter-spacing:1px[^>]*>([A-Z0-9-]{14})</.exec(mail.html)![1];
  assert.ok(under.includes(`Type test.local/check into your browser and enter ${code} .`), under);
  assert.ok(mail.html.includes(`http://test.local/check?code=${code}&amp;report=1`), 'Report this email, with the code filled in');
  assert.ok(under.includes(`If the button does not work, copy this link: ${mail.link}`));
  assert.match(under, /We never ask for a password or a payment by email\./);
  assert.match(under, /The link is personal to you\. Do not forward this email\./);
  assert.match(under, /Get help with this document/);
  assert.match(under, /Sent with GrowSigning\.$/);
  assert.doesNotMatch(mail.html, /every dollar plants|no paper, no printer/, 'nothing that sells, to someone who only came to sign');
  // The most the software itself adds above the button: an access code, a private note line, a shared address.
  const d = await draft(c, { subject: 'Tree planting agreement', message: '', ordered: false,
    recipients: [
      { id: 'r1', role: 'signer', name: 'Ada Signer', email: 'both-simplify@example.com', routing_order: 1 },
      { id: 'r2', role: 'signer', name: 'Ben Signer', email: 'both-simplify@example.com', routing_order: 1, access_code: '4242', note: 'Bring the stamp.' },
      { id: 'r3', role: 'cc', name: 'Cee Copy', email: 'cee-simplify@example.com', routing_order: 1 },
    ] });
  assert.equal((await c.post(`/envelopes/${d.id}/send`)).status, 200);
  const full = mailTo('both-simplify@example.com').find((m: any) => m.html.includes('For Ben Signer:'))!;
  assert.ok(words(aboveButton(full.html)) <= 80, `${words(aboveButton(full.html))} words with every line of ours`);
});

test('a deadline in an email is in the reader\'s own time once their device has told us the zone, and in UTC, said as UTC, until then', async () => {
  const closes = '2027-03-20T16:40:00.000Z';
  assert.equal(momentForReader(closes, 'Asia/Kolkata'), '20 March 2027 at 22:10 Asia/Kolkata time (UTC+05:30)');
  assert.equal(momentForReader(closes, null), '20 March 2027 at 16:40 UTC');
  // A zone that is made up, or something that is not a zone at all, never reaches the email: UTC.
  for (const bad of ['Nope/Nowhere', '<script>', 'x'.repeat(80), 5 as any]) assert.equal(momentForReader(closes, bad), momentText(closes));
  assert.equal(momentForReader(null, 'Asia/Kolkata'), '');
  const c = await signUp('Dee Sender', 'dee-simplify@example.com', ip());
  const e = await simple(c, 'ravi-simplify@example.com', { expire_days: 30 });
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const at = (await c.get(`/envelopes/${e.id}`)).data.envelope.expires_at;
  // Not known yet: UTC, said as UTC, and that the signing page shows it in their own time, in the page's own words
  // ("Open until"), so the email and the page do not read as two deadlines. Never a bare day: west of UTC that day
  // can be one day late.
  assert.ok(mailTo('ravi-simplify@example.com').at(-1)!.html.includes(`Open until ${momentText(at)}. The signing page shows your own time.`));
  // Ravi opens it in India and agrees. The reminder then names the moment by his clock.
  const rc = new Client(), tok = tokenFor(e.id, 'ravi-simplify@example.com');
  assert.equal((await rc.post(`/sign/${tok}/consent`, { tz: 'Asia/Kolkata' })).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/remind`)).status, 200);
  const reminder = mailTo('ravi-simplify@example.com').at(-1)!;
  assert.ok(reminder.html.includes(`Open until ${momentText(at, 'Asia/Kolkata')}. Too many reminders?`), reminder.html.slice(-700));
  assert.doesNotMatch(reminder.html, /shows your own time/, 'their own time is what the email now says');
});

test('the footer cannot be made to carry markup: names and links are written as text', () => {
  const html = renderMail({ to: 'x@example.com', subject: 's', heading: '<img src=x onerror=alert(1)>', lines: ['<b>bold</b>'], cta: { label: 'Review and sign', url: 'http://test.local/sign/abc"><script>alert(1)</script>' },
    code: 'ABCDEFGHJKLM', askForPdf: 'Eve <script>alert(1)</script> "Sender"', envelopeId: 'env_x' });
  assert.doesNotMatch(html, /<script|<img src=x|<b>bold/);
  assert.match(html, /ask Eve &lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;Sender&quot; to send the document as a PDF\./);
  // An email with no signing link has no code line and keeps its plain help address.
  const plain = renderMail({ to: 'x@example.com', subject: 's', heading: 'h', lines: ['l'] });
  assert.doesNotMatch(plain, /Not sure this email is real|Do not forward/);
  assert.match(plain, /Need a hand\? http:\/\/test\.local\/help/);
});

// ---- 5. Help on the signing page -----------------------------------------------------------------------------------

test('Help on a signer\'s screen opens with one line, names no model, and "Talk to a person" does not ask who they are again', () => {
  assert.equal(CHAT_SHORT_AI, 'Answers are written by AI and can be wrong. Do not type passwords or card numbers.');
  for (const line of [CHAT_SHORT_AI, CHAT_SHORT_BUILTIN]) {
    assert.ok(words(line) <= 20, line);
    assert.doesNotMatch(line, /model|moonshot|kimi|gpt|claude|\bhost\b|https?:/i);
  }
  const chat = read('src/components/HelpChat.tsx');
  // One line above the conversation, on every screen, and only when a model answers (repair-chat, after the
  // simplicity review). With the built-in answers the short line is the first grey line of the empty conversation.
  assert.match(chat, /\{status\?\.ai && <p className="hc-note hc-top">\{CHAT_SHORT_AI\}<\/p>\}/);
  assert.match(chat, /status && !status\.ai \? `\$\{CHAT_SHORT_BUILTIN\} ` : ''/);
  // What is kept, and the longer warning, are still there for whoever opens the fold.
  assert.match(chat, /<details className="hc-kept" data-fold><summary>What we keep<\/summary>\{CHAT_DO_NOT_TYPE\} \{status\?\.kept \|\| CHAT_KEPT\}<\/details>/);
  // The signing page hands over the name and address it already has. Never in person: that device is the host's.
  assert.match(page, /who=\{me\.role !== 'inperson' && me\.email \? \{ name: me\.name, email: me\.email \} : null\}/);
  const form = read('src/app/help/tools.tsx');
  assert.match(form, /useState\(\{ name: who\?\.name \|\| '', email: who\?\.email \|\| '', topic:/);
  assert.match(form, /We reply to <b><bdi>\{f\.email\}<\/bdi><\/b>\. <button type="button" className="sg-link" onClick=\{\(\) => setKnown\(false\)\}>Use another address<\/button>/);
});

// ---- 6. After the skeptic and the simplicity review (repair-simplify-signing) ------------------------------------------

test('wording 2026-11-21 says again what 2026-11-20 dropped, and tells nobody they can decline who has no Decline', () => {
  assert.equal(CONSENT_VERSION, '2026-11-21');
  // The version rule: every wording ever shown is still there to be read back, newest first.
  assert.deepEqual(CONSENT_HISTORY.map((h) => h.version), ['2026-11-21', '2026-11-20', '2026-11']);
  for (const v of ['2026-11-21', '2026-11-20', '2026-11']) assert.equal(isConsentVersion(v), true, v);
  const old = consentWording('Rosa Gardener', true, '2026-11-20');
  assert.equal(old.practical, 'You can decline, or ask Rosa Gardener for a paper copy instead.', 'what people agreed to on that day is kept word for word');
  const w = consentWording('Rosa Gardener', true);
  // The two disclosures: how the person gets and keeps a copy, and that each step is recorded.
  assert.match(w.practical, /^You can download a copy now or later, /);
  assert.match(w.legal, /We record the time, your IP address and each step\./);
  assert.match(w.practical, /decline, or ask Rosa Gardener for a paper copy instead\.$/);
  // Someone asked to read or to approve: the same two, and no "You can decline" (a reader has no Decline to press).
  const r = consentWording('Rosa Gardener', false);
  assert.match(r.practical, /^You can download a copy now or later\./);
  assert.match(r.legal, /We record the time, your IP address and each step\./);
  assert.doesNotMatch(`${r.legal} ${r.practical}`, /decline/i);
  assert.match(r.practical, /You do not have to agree: ask Rosa Gardener for a paper copy instead\.$/);
  assert.deepEqual(otherActions({ role: 'viewer' }, { stage: 'consent', deadline: true }), ['later', 'time', 'ask']);
  // And for a reader the first entry is not called "Finish later": there is nothing for them to finish.
  assert.equal(laterLabel('viewer'), 'Read it later');
  for (const role of ['signer', 'approver', 'inperson']) assert.equal(laterLabel(role), 'Finish later');
  assert.match(page, /ACTION\.later\.label = laterLabel\(me\.role\);/);
  for (const text of [w.legal, w.practical, r.legal, r.practical]) assert.doesNotMatch(text, /\u2014|is valid\b|will hold up|legally binding/);
});

test('the sender\'s message and note fold behind one line when the consent screen would pass 120 words before the tick', () => {
  assert.equal(CONSENT_WORDS, 120);
  // Counted the way the flow script counts: anything between spaces with a letter or a digit in it.
  assert.equal(wordsIn('  Please sign:  Planting partnership \u2022 - 2026 '), 5);
  assert.equal(wordsIn(''), 0);
  const fold = read('src/components/sign/SenderWords.tsx');
  assert.match(fold, /range\.setStart\(document\.body, 0\);\s+range\.setEndBefore\(tick\.closest\('label'\) \|\| tick\);\s+if \(wordsIn\(range\.toString\(\)\) > CONSENT_WORDS\) setFold\(true\);/);
  // Folded: one line, marked data-fold, and the words are not in the page until it is opened.
  assert.match(fold, /<details className="sg-fold" data-fold open=\{open\}/);
  assert.match(fold, /\{message \? 'Read the message' : 'Read the note'\}<\/summary>\s+\{open && words\}/);
  // The words themselves are written as text, never as markup.
  assert.doesNotMatch(fold, /dangerouslySetInnerHTML/);
  const consent = page.slice(page.indexOf("if (stage === 'consent') {"), page.indexOf('// ---- The document'));
  assert.match(read('src/components/sign/ConsentTop.tsx'), /<SenderWords sender=\{sender\.name\} message=\{data\.message\} note=\{data\.note\} fold=\{level >= 2\} \/>/);
  assert.doesNotMatch(consent, /Message from \{sender\.name\}/, 'the sender is named once');
  // In person, the consent screen says whose turn it is and leaves the line about the connection to the document.
  assert.match(consent, /\{richText\(lang, 'sign\.consent\.hand_over', \{ name: <b>\{me\.name\}<\/b> \}\)\}<\/div>/);
  assert.equal(JSON.parse(read('src/locales/en.json'))['sign.consent.hand_over'], 'Hand this device to {name} now.');
  assert.doesNotMatch(consent, /SIGNING_ONLINE/);
});

test('the note from Finish later does not follow the person onto the document, and its link stands on a line of its own', () => {
  const consent = page.slice(page.indexOf("if (stage === 'consent') {"), page.indexOf('// ---- The document'));
  assert.match(consent, /await api\(`\$\{base\}\/consent`,[^\n]+\);\s+setAgreedHere\(true\);\s+\/\/[^\n]+\s+setLater\(''\);\s+await load\(\);/);
  assert.match(page, /<div className="sg-later-stop">\s+\{!muted && [^\n]+>Stop reminder emails<\/button>\}\s+<\/div>/);
});

test('the name typed for a signature is kept in the tab, so "Check your name" still comes after a reload', () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  assert.equal(readTypedName('tok', store), null);
  writeTypedName('tok', 'Bob Builder', store);
  assert.equal(readTypedName('tok', store), 'Bob Builder');
  assert.equal(readTypedName('other', store), null, 'one link never reads another link\'s name');
  // A drawn or uploaded signature has no typed name: the old one goes.
  writeTypedName('tok', undefined, store);
  assert.equal(readTypedName('tok', store), null);
  // Never more than a name is kept or read back, and a tab without storage is simply a tab that forgets.
  writeTypedName('tok', 'x'.repeat(5000), store);
  assert.equal(readTypedName('tok', store)!.length, 200);
  mem.set('sg:typed:tok', 'y'.repeat(201));
  assert.equal(readTypedName('tok', store), null);
  const broken = { getItem: () => { throw new Error('no storage'); }, setItem: () => { throw new Error('full'); }, removeItem: () => {} };
  assert.equal(readTypedName('tok', broken), null);
  assert.doesNotThrow(() => writeTypedName('tok', 'Bob', broken));
  assert.match(page, /useEffect\(\(\) => setTypedName\(readTypedName\(token\)\), \[token\]\);/);
  // Gone with the kept signature once the document is finished.
  assert.match(page, /writeKept\(token, null, null\), writeTypedName\(token, null\), dropAnswers\(token\)/);
});

test('the step at Finish is titled by its reason, and its button is the same word as on the page', () => {
  assert.equal(reviewTitle(['name']), 'Check your name');
  assert.equal(reviewTitle(['question', 'name']), 'One question is not answered');
  assert.equal(reviewTitle(['witness']), 'Name your witness');
  assert.equal(reviewTitle(['print']), 'Some characters cannot be printed');
  assert.equal(reviewTitle([]), 'Check before you finish');
  assert.equal(reviewTitle([], true), 'Approve this document');
  const dlg = read('src/components/sign/dialogs.tsx');
  const review = dlg.slice(dlg.indexOf('export function ReviewDialog'));
  assert.match(review, /\{busy \? 'Sending' : approving \? 'Approve' : 'Finish'\}<\/button>/);
  assert.doesNotMatch(review, /Finish and send|Approve and send/);
  assert.match(review, /`Choosing Finish signs the document and tells \$\{sender\.name\}\.`/);
  // A check that could not be made is said in the step, until the step's own check comes through.
  assert.match(review, /\{unchecked && cannotPrint\.length === 0 && \(\s+<div className="notice warn sg-problem" role="status">\s+<b>We could not check your answers just now\.<\/b>/);
  assert.doesNotMatch(page, /'Finish and send'|'Approve and send'/);
});

test('a security code never spells a rude word, also across its dashes or with digits read as letters', () => {
  assert.equal(rudeCode('FUCK-F3AM-HJTE'), true, 'the code a probe invitation carried');
  assert.equal(rudeCode('ABFU-CKGH-JKMN'), true, 'across a dash');
  assert.equal(rudeCode('A55A-CKGH-JKMN'), true, 'digits read as letters');
  assert.equal(rudeCode('abfuckghjkmn'), true);
  assert.equal(rudeCode('ABCD-EFGH-JKMN'), false);
  for (let i = 0; i < 3000; i++) {
    const c = checkCode();
    assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
    assert.equal(rudeCode(c), false, c);
  }
  for (let i = 0; i < 500; i++) assert.equal(rudeCode(shortCode()), false);
});

test('the Done screen says "1 sheet", and leaves out a figure that rounds to nothing', () => {
  const say = (i: any) => { const s = savedLine(i); return `About ${s.sheets}${s.rest} ${s.verb} not used.${s.trees ? ' tree' : ''}`; };
  assert.equal(say({ sheets: 1, litresWater: 10, kgCo2: 0.004, trees: 0.0001 }), 'About 1 sheet of paper and 10 litres of water were not used.');
  assert.equal(say({ sheets: 1, litresWater: 0, kgCo2: 0, trees: 0 }), 'About 1 sheet of paper was not used.');
  assert.equal(say({ sheets: 240, litresWater: 2400, kgCo2: 1.2, trees: 0.03 }), 'About 240 sheets of paper, 2,400 litres of water and 1.2 kg of CO2e were not used. tree');
  assert.equal(say({ sheets: 3, litresWater: 1, kgCo2: 0, trees: 0 }), 'About 3 sheets of paper and 1 litre of water were not used.');
  assert.doesNotMatch(read('src/components/sign/parts.tsx'), /sheets of paper<\/b>, \{fmtNum/);
});

test('the account is named beside the sender only when its name says more than theirs', () => {
  assert.equal(orgOf('Acme Ltd', 'Rosa Gardener'), 'Acme Ltd');
  assert.equal(orgOf("Rosa Gardener\u2019s workspace", 'Rosa Gardener'), '');
  assert.equal(orgOf("Somebody's Workspace", 'Rosa Gardener'), '');
  assert.equal(orgOf('Rosa Gardener Consulting', 'rosa gardener'), '');
  for (const none of [null, undefined, '', '   ']) assert.equal(orgOf(none, 'Rosa'), '');
  assert.equal(orgOf('<b>Acme</b>', ''), '<b>Acme</b>', 'a name is text: the page and the email write it as text');
});

test('44 px to press at every width, and one filled button in Help', () => {
  const css = read('src/app/styles/simplesign.css');
  assert.match(css, /\.sg-shell \.btn\.sm, \.sg-dialog \.btn\.sm \{ min-height: 44px; \}/);
  assert.match(css, /\.sg-foot-links \.sg-link, \.sg-top \.sg-link, \.sg-dialog \.sg-link \{ display: inline-flex; align-items: center; min-height: 44px; \}/);
  assert.match(css, /\.sg-from a \{ display: inline-block; padding: 12px 0; margin: -12px 0; \}/);
  // On the consent screen the bar carries our logo, so "sent with" is not said again under it, at any width.
  assert.match(css, /\n\.sg-shell:has\(\.sg-consent\) \.sg-foot-by \{ display: none; \}/);
  // Under a Help answer the page's own actions are plain buttons: Send is the dialog's one filled button.
  assert.match(read('src/components/HelpChat.tsx'), /className="btn sm" onClick=\{\(\) => doAct\(a\)\}/);
});
