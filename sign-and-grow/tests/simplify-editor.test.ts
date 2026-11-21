// The editor made simpler (research/briefs.json "simplify-editor", research/ux-charter.md 2.3). Nothing here is a
// new feature: step 1 opens with one empty person row and everything else about a person in their More; the
// subject, the message, reminders, the deadline and the date format are on step 3; step 2 shows six kinds of field
// and keeps the rest one press away; and when the only person on a document is its sender, step 3 says "Sign now".
// The counts of the flows are measured in a browser by tests/ux/flows.cjs; this file pins the rules behind them.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, simple, mailTo, tokenFor } from './helpers.ts';
import {
  STEP_NAMES, COMMON_FIELDS, isCommonField, ROLE_CHOICES, ROLE_WORDS, ROLE_CAP, MORE_CAP, STEP3_MORE_CAP, canSendMyself, moreLines, personSummary,
  isBlankPerson, onlyMe, savingLine,
} from '../src/lib/editorux.ts';
import { signNowFor, holdInvite, inviteHeld, dropHold, signNowNote } from '../src/server/signnow.ts';

let db: Awaited<ReturnType<typeof boot>>['db'];
before(async () => {
  ({ db } = await boot());
});

const read = (f: string) => fs.readFileSync(f, 'utf8');
let n = 0;
const ip = () => `10.77.${Math.floor(++n / 250)}.${n % 250}`;
const PW = 'correct horse battery';
const audit = (id: string) => db.all('SELECT action, detail FROM audit WHERE envelope_id=? ORDER BY seq', id) as { action: string; detail: string }[];
// A draft whose only person is `who`.
const ownDraft = (c: Client, who: { name: string; email: string }, over: any = {}) => simple(c, who.email, { recipients: [{ id: 'r', role: 'signer', name: who.name, email: who.email, ...over }] });

// ---- 1. Step 1: one empty row, name and email, the rest in the person's More ---------------------------------------

test('step 1 opens with one empty person row, and that row is never saved, sent or counted against anyone', () => {
  const editor = read('src/components/Editor.tsx');
  // A new draft with nobody on it gets one row without anyone pressing a button; a draft that has people, an
  // envelope that is out and a locked template's envelope are left as they are.
  assert.match(editor, /setRcps\(e\.recipients\.length \|\| e\.status !== 'draft' \|\| e\.wording_lock \? e\.recipients : \[newRcp\(\[\], e\.kind === 'template'\)\]\);/);
  // The empty row is not sent to the server, not listed as a problem and not on the review step.
  assert.match(editor, /recipients: list\.filter\(\(r\) => !isIdle\(r, flds\)\)\.map\(/);
  assert.match(editor, /const people = rcps\.filter\(\(r\) => !isIdle\(r\)\);/);
  assert.match(read('src/components/editor/StepReview.tsx'), /const rcps = ed\.rcps\.filter\(\(r\) => !ed\.isIdle\(r\)\);/);
  // What counts as empty: nothing typed, and not a group, a person without an address or a witness the signer names.
  assert.equal(isBlankPerson({ name: '', email: '' }), true);
  assert.equal(isBlankPerson({ name: '  ', email: ' ' }), true);
  for (const r of [{ name: 'A', email: '' }, { name: '', email: 'a@b.c' }, { name: '', email: '', group_id: 'g' }, { name: '', email: '', link_by_sender: true }, { name: '', email: '', named_by_signer: true }])
    assert.equal(isBlankPerson(r), false, JSON.stringify(r));
  // A row with a field placed for it, a note, a code or a role of its own is somebody: it stays and is asked for a name.
  assert.match(editor, /const isIdle = \(r: any, flds: any\[\] = fields\.value\) => !correcting && isBlankPerson\(r\) && r\.role === 'signer' && !r\.role_name && !r\.access_code && !r\.note && !\(r\.verify && r\.verify !== 'none'\) && !r\.phone && !flds\.some\(\(f\) => f\.recipient_id === r\.id\);/);
  // Someone who arrives filled in ("Add me", a group) takes the empty row's place instead of standing under it.
  assert.match(editor, /const spare = Object\.keys\(p\)\.length \? l\.find\(\(x\) => isIdle\(x\)\) : null;/);
  // With nobody on it, the words say what to do and where.
  assert.match(editor, /'Add at least one person: a name and an email address in step 1\.'/);
});

test('a person row is a name, a wide email box, More and remove; the role, the link tick and the rest are in More', () => {
  const add = read('src/components/editor/StepAdd.tsx');
  assert.match(add, /data-item="person"/);
  assert.equal(add.match(/data-more="item"/g)?.length, 1, 'one More for a person');
  assert.equal(add.match(/data-more="screen"/g)?.length, 1, 'one More options for the step');
  assert.match(add, /aria-label="Recipient email" autoComplete="off" className="ed-email" style=\{\{ flex: '2 1 260px' \}\}/, 'the address box is twice as wide as the name');
  // Not on the row any more.
  assert.doesNotMatch(add, /aria-label="Role"|<SendMyself|<CheckFields|Access code|Private note|Remind every|Expires after|Date format|Email subject|<textarea/);
  assert.match(add, />Add another \{isTpl \? 'role' : 'person'\}<\/button>/);
  assert.match(add, /onClick=\{\(\) => ed\.addMe\(\)\}>Add me<\/button>/);
  // Signing order is under the step's More options, and the More closes with the step (state, not storage).
  assert.match(add, /const \[options, setOptions\] = useState\(false\);/);
  assert.match(add, /\{options && !wording && \(\s*<div id="ed-step1-more"[\s\S]*Set signing order[\s\S]*<AddGroup ed=\{ed\} groups=\{groups\} \/>/);
  // A file: its name, its pages, one More with what is done now and then, and at most one note in view.
  const file = read('src/components/editor/FileRow.tsx');
  assert.match(file, /<div data-item="file">/);
  assert.equal(file.match(/data-more="item"/g)?.length, 1);
  for (const w of ['Replace file', 'Move up', 'Move down', 'Remove']) assert.ok(file.includes(`>${w}<`) || file.includes(`\n            ${w}\n`), w);
  assert.match(file, /\{notes\[0\]\}\s*\{notes\.length > 1 && \(\s*<details data-fold/);
  assert.match(file, /<summary>\{plural\(notes\.length - 1, 'more note'\)\}<\/summary>/);
  // The group row follows the same pattern.
  const group = read('src/components/editor/GroupRecipient.tsx');
  assert.match(group, /data-item="person"/);
  assert.equal(group.match(/data-more="item"/g)?.length, 1);
});

test("a person's More lists each choice as one line with its value, never one with a single answer, and stays under its cap", () => {
  const keys = (r: any, o: any = {}) => moreLines(r, o).map((l) => l.key);
  // Zero setup, someone who signs: the charter's four, plus how they sign (on screen, or in person with the sender).
  assert.deepEqual(keys({ role: 'signer' }), ['role', 'deliver', 'check', 'sign', 'note']);
  assert.deepEqual(moreLines({ role: 'signer' }).map((l) => `${l.label}: ${l.value}`), ['Role: Needs to sign', 'How they get it: Email', 'Check who signs: None', 'How they sign: On screen', 'Private note: None']);
  // A copy only ever goes by email and is never signed: those two lines are not listed.
  assert.deepEqual(keys({ role: 'cc' }), ['role', 'check', 'note']);
  assert.deepEqual(keys({ role: 'approver' }), ['role', 'deliver', 'check', 'note']);
  assert.deepEqual(keys({ role: 'witness' }), ['role', 'check', 'note']);
  // A template has no "I will send the link myself", and a group none either.
  assert.deepEqual(keys({ role: 'signer' }, { isTpl: true }), ['role', 'check', 'sign', 'note']);
  assert.equal(canSendMyself({ role: 'signer', group_id: 'g' }, false), false);
  // Someone whose link the sender sends cannot also sign on the sender's device.
  assert.deepEqual(keys({ role: 'signer', link_by_sender: true }), ['role', 'deliver', 'check', 'note']);
  // In person is a way of signing, kept as the role "inperson" as before.
  const inperson = moreLines({ role: 'inperson' });
  assert.equal(inperson.find((l) => l.key === 'role')!.value, 'Needs to sign');
  assert.equal(inperson.find((l) => l.key === 'sign')!.value, 'In person, with me');
  // The language only with two or more to choose from.
  assert.ok(!keys({ role: 'signer' }, { languages: 1 }).includes('language'));
  assert.ok(keys({ role: 'signer' }, { languages: 2 }).includes('language'));
  // What is set is said on the line.
  const set = moreLines({ role: 'signer', access_code: '4242', verify: 'email_code', note: 'Hi', text_link: 1 });
  assert.equal(set.find((l) => l.key === 'check')!.value, 'Access code and a code by email');
  assert.equal(set.find((l) => l.key === 'deliver')!.value, 'Email and a text message');
  assert.equal(set.find((l) => l.key === 'note')!.value, 'Added');
  assert.equal(moreLines({ role: 'signer', link_by_sender: true }).find((l) => l.key === 'deliver')!.value, 'I send the link myself');
  // The caps: 6 lines with nothing set up, 8 with everything, for every role.
  assert.deepEqual(MORE_CAP, { zero: 6, everything: 8 });
  for (const role of [...ROLE_CHOICES, 'inperson']) {
    assert.ok(moreLines({ role }).length <= MORE_CAP.zero, `${role}, zero setup`);
    assert.ok(moreLines({ role, text_link: 1, verify: 'sms_code' }, { languages: 5 }).length <= MORE_CAP.everything, `${role}, everything`);
  }
  // The screen draws exactly these lines, one picker open at a time, each a real button that says whether it is open.
  const more = read('src/components/editor/PersonMore.tsx');
  assert.match(more, /const lines = moreLines\(r, \{ isTpl, languages: shippedLocales\(\)\.length \}\);/);
  assert.match(more, /<button type="button" className="ed-line-btn" aria-expanded=\{pick === l\.key\} onClick=\{\(\) => setPick\(pick === l\.key \? null : l\.key\)\}>/);
  assert.match(more, /\{pick === l\.key && <div className="ed-pick">\{picker\(l\.key\)\}<\/div>\}/);
});

test('the role list leads with five plain choices, at most eight ever, and "in person" is a way of signing', () => {
  assert.deepEqual(ROLE_CHOICES, ['signer', 'approver', 'cc', 'viewer', 'witness']);
  assert.deepEqual(ROLE_CHOICES.map((k) => ROLE_WORDS[k]), ['Needs to sign', 'Needs to approve', 'Gets a copy', 'Must open it', 'Is a witness']);
  assert.ok(ROLE_CHOICES.length <= ROLE_CAP && ROLE_CAP === 8);
  assert.ok(!ROLE_CHOICES.includes('inperson'));
  const more = read('src/components/editor/PersonMore.tsx');
  assert.match(more, /\{ROLE_CHOICES\.map\(\(k\) => <option key=\{k\} value=\{k\}>\{ROLE_WORDS\[k\]\}<\/option>\)\}/);
  assert.match(more, /<option value="inperson">In person, with me<\/option>/);
  // The same words wherever a role is named on the sender's screens.
  assert.match(read('src/components/ui.tsx'), /cc: 'Gets a copy', viewer: 'Must open it'/);
  for (const f of ['src/components/ui.tsx', 'src/components/editor/GroupRecipient.tsx', 'src/lib/editorux.ts']) assert.doesNotMatch(read(f), /Receives a copy|Needs to view/, f);
});

test('while More is closed the row says what is set for that person, and nothing for the plain case', () => {
  assert.equal(personSummary({ role: 'signer', name: 'A', email: 'a@b.c' }), '');
  assert.equal(personSummary({ role: 'cc' }), 'Gets a copy');
  assert.equal(personSummary({ role: 'inperson' }), 'Signs in person, with you');
  assert.equal(personSummary({ role: 'viewer', link_by_sender: true, access_code: '1234', note: 'x' }), 'Must open it · You send the link yourself · Access code · Private note');
  assert.equal(personSummary({ role: 'signer', verify: 'sms_code', text_link: 1 }), 'Link also by text · Code by text');
  assert.match(read('src/components/editor/StepAdd.tsx'), /\{more !== r\.id && <PersonSummary r=\{r\} \/>\}/);
});

// ---- 2. Step 3: the subject, the message, and one More options --------------------------------------------------------

test('reminders, the deadline, the date format and the message are on step 3, reminders asked once, the time-zone note one line', () => {
  const review = read('src/components/editor/StepReview.tsx');
  const parts = read('src/components/editor/ReviewParts.tsx');
  assert.match(review, /\{!closed && <SendWords ed=\{ed\} \/>\}/);
  assert.match(parts, /'Template name and email subject' : 'Email subject'/);
  assert.equal(review.match(/<ReviewMore /g)?.length, 1);
  assert.equal(parts.match(/data-more="screen"/g)?.length, 1, 'one More options on the step');
  assert.equal((review + parts).match(/<ReminderChoice /g)?.length, 1, 'reminders are asked once');
  assert.doesNotMatch(read('src/components/editor/StepAdd.tsx'), /reminder_days|expire_days|date_format/);
  // Closed every time the step opens: plain state, nothing remembered.
  assert.match(parts, /const \[open, setOpen\] = useState\(false\);/);
  assert.doesNotMatch(parts, /localStorage|sessionStorage/);
  // The time-zone note: one sentence each, 20 words or fewer together with the second.
  const note = /: '(The date of signing is[^']+)'/.exec(parts)?.[1] || '';
  assert.equal(note, 'The date of signing is the day where each person is. The signing record has the exact time as well.');
  assert.ok(note.split(/\s+/).length <= 20);
  assert.doesNotMatch(parts, /UTC/);
  // What is set stands next to the button, so nobody has to open it to find out.
  assert.match(parts, /\{!open && <span className="muted small">/);
  // The deadline of an envelope that is out is said, not asked, as before.
  assert.match(parts, /To give people more time, use the document&rsquo;s page after you save\./);
  // Only what changes from one send to the next: reminders, the deadline, the date format, a payment link. Under the cap.
  assert.equal(STEP3_MORE_CAP, 7);
  const panel = parts.slice(parts.indexOf('id="ed-step3-more"'), parts.indexOf('export function SavingBox'));
  assert.deepEqual(panel.match(/<(ReminderChoice|PayLinkChoice|input|select|textarea)\b/g), ['<ReminderChoice', '<input', '<select', '<PayLinkChoice']);
  // One main button on the step: the one under the review. The top bar has Next on steps 1 and 2 only.
  const editor = read('src/components/Editor.tsx');
  assert.match(editor, /\{step < 3 && <button type="button" className="btn primary" onClick=\{\(\) => go\(step \+ 1\)\}>Next<\/button>\}/);
  assert.equal(editor.slice(editor.indexOf('<div className="topbar ed-top">'), editor.indexOf('{wording && <WordingBanner')).match(/btn primary/g)?.length, 1);
  assert.equal(review.slice(review.indexOf('export function StepReview')).match(/className="btn primary/g)?.length, 1);
});

test('the names of the three steps, and the words of the charter on them', () => {
  assert.deepEqual([...STEP_NAMES], ['Files and people', 'Fields', 'Review and send']);
  const editor = read('src/components/Editor.tsx');
  assert.match(editor, /const steps = \[STEP_NAMES\[0\], STEP_NAMES\[1\], isTpl \? 'Review' : correcting \? 'Review and save' : STEP_NAMES\[2\]\];/);
  assert.match(read('src/components/editor/StepAdd.tsx'), /<h2 style=\{\{ marginBottom: 12 \}\}>Files<\/h2>/);
  assert.match(read('src/components/editor/StepAdd.tsx'), /\{isTpl \? 'Roles' : 'People'\}/);
  assert.match(read('src/components/editor/StepReview.tsx'), /\{isTpl \? 'Roles' : 'Who gets it'\}/);
});

test('the saving of this one document, in the owner\'s words: pages from a tree, no fraction, the rest behind "How we work this out"', () => {
  // The pages of the document times the people who would each have had a copy.
  assert.equal(savingLine(5, 3).line, 'This saves 15 pages of paper from a tree.');
  assert.equal(savingLine(5, 3).sheets, 15);
  assert.equal(savingLine(1, 1).line, 'This saves 1 page of paper from a tree.');
  assert.equal(savingLine(600, 2).line, 'This saves 1,200 pages of paper from a tree.');
  assert.equal(savingLine(0, 4).sheets, 0);
  for (const s of [savingLine(5, 3), savingLine(1, 1), savingLine(2000, 50)]) {
    assert.doesNotMatch(s.line, /\d\.\d|of a tree|water|CO2|sheets/, 'no fraction of a tree and no other figure in the line');
    assert.match(s.how, /^An estimate: /);
    assert.match(s.how, /litres of water and [\d.,]+ kg of CO2e/);
    assert.doesNotMatch(s.how, /of a tree|\u2014/);
  }
  assert.equal(savingLine(5, 3).how, 'An estimate: 5 pages for each of 3 people, one paper copy each. Making that paper would take about 150 litres of water and 0.07 kg of CO2e. Printing, couriers and filing are not counted.');
  const parts = read('src/components/editor/ReviewParts.tsx');
  assert.match(parts, /if \(s\.sheets < 1\) return null;/);
  assert.match(parts, /<details data-fold className="ed-fold small">\s*<summary>How we work this out<\/summary>/);
  assert.match(parts, /<Link href="\/impact" target="_blank" rel="noopener">Where these numbers come from<\/Link>/);
  // Nothing is said about planting here: whether a paid signature will be used is only known once it is held.
  assert.doesNotMatch(parts, /mangrove|planted/i);
  assert.doesNotMatch(read('src/components/editor/StepReview.tsx'), /fmtTrees|of a tree/);
});

// ---- 3. Step 2: six kinds, More fields, three settings, keyboard help behind a fold ------------------------------

test('step 2 shows six kinds of field and keeps every other kind behind "More fields"', () => {
  assert.deepEqual(COMMON_FIELDS, ['signature', 'initials', 'date_signed', 'full_name', 'text', 'checkbox']);
  const shared = read('src/components/editor/shared.ts');
  const types = [...shared.slice(shared.indexOf('export const TYPES'), shared.indexOf('];', shared.indexOf('export const TYPES'))).matchAll(/\['([a-z_]+)', '([^']+)'/g)].map((m) => m[1]);
  assert.ok(types.length >= 17, 'every kind is still there');
  for (const t of COMMON_FIELDS) assert.ok(types.includes(t), t);
  assert.equal(types.filter(isCommonField).length, 6);
  const step = read('src/components/editor/StepFields.tsx');
  // A kind that is in use as the tool stays in view when the list is folded again.
  assert.match(step, /\{TYPES\.filter\(\(\[t\]\) => isCommonField\(t\) \|\| allTypes \|\| tool === t\)\.map\(/);
  assert.match(step, /<button type="button" className="ed-morefields" data-fold aria-expanded=\{allTypes\} onClick=\{\(\) => setAllTypes\(!allTypes\)\}>\{allTypes \? 'Fewer fields' : 'More fields'\}<\/button>/);
  assert.match(step, /const \[allTypes, setAllTypes\] = useState\(false\);/);
  assert.match(step, /<Wand \/> \{finding \? 'Looking' : 'Place fields for me'\}/);
});

test('a field shows Assigned to, Required and Label; the rest is under its More options; no tag jargon on screen', () => {
  const step = read('src/components/editor/StepFields.tsx');
  const panel = step.slice(step.indexOf('<div className="ed-sheetbody" data-item="field">'), step.indexOf('{/* On a phone Delete is in the bar above.'));
  assert.ok(panel.length > 500);
  const [shown, folded] = [panel.slice(0, panel.indexOf('data-more="item"')), panel.slice(panel.indexOf('{fieldMore && <div id="ed-field-more"'))];
  for (const w of ['<span>Assigned to</span>', '/> Required</label>', '<span>Label ']) assert.ok(shown.includes(w), w);
  // What a note says, a list's options and a choice's group are the field itself, so they stay in view.
  for (const w of ['<span>Text</span>', 'Options <span', 'Group <span']) assert.ok(shown.includes(w), w);
  for (const w of ['Prefilled value', 'Read only', '<span>Format</span>', '<FieldLogic', 'Width <span', 'Height <span', '>Duplicate<', '>Copy to every page<']) {
    assert.ok(folded.includes(w), `${w} is under More options`);
    assert.ok(!shown.includes(w), `${w} is not in view before`);
  }
  assert.equal(panel.match(/data-more="item"/g)?.length, 1);
  // Deleting stays one press away: the bar on a phone, a button on a desktop, the Delete key on both.
  assert.match(step, /className="btn sm danger ed-hide-sm" style=\{\{ marginTop: 8, width: '100%' \}\} onClick=\{\(\) => remove\(selected\.id\)\}>Delete field<\/button>/);
  // Keyboard help is behind a fold, with everything the list had and the Enter hint that stood under the kinds.
  const keys = step.slice(step.indexOf('<details data-fold className="ed-fold ed-keys">'), step.indexOf('</details>', step.indexOf('ed-keys')));
  assert.match(keys, /<summary>Keyboard help<\/summary>/);
  for (const w of ['Press Enter on a field type', 'Arrow keys move', 'Hold Alt', 'makes a copy', 'Delete removes', 'duplicates', 'undoes', 'Esc deselects']) assert.ok(keys.includes(w), w);
  assert.doesNotMatch(step.replace(keys, ''), /Using the keyboard\?|Arrow keys nudge/);
  // No tag jargon and no "validation" in what a person reads (comments in the code may still explain it).
  const seen = step.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(seen, /\{\{signature|tags such as|or tags found|<span>Validation<\/span>/);
  assert.match(step, /'We found no blanks or form fields in this document\. Pick a field and click where it goes\.'/);
});

// ---- 4. Sign now ---------------------------------------------------------------------------------------------------

test('"Sign now" is offered only when the one person on the document is the sender, signing on screen at their own address', () => {
  const me = 'rosa@example.com';
  const mine = { role: 'signer', name: 'Rosa', email: 'Rosa@Example.com ' };
  assert.equal(onlyMe([mine], me), mine);
  // Anyone else on it, another role, a group, a link the sender passes on, or no address: an ordinary Send.
  assert.equal(onlyMe([mine, { role: 'cc', name: 'Cee', email: 'cee@example.com' }], me), null);
  assert.equal(onlyMe([{ ...mine, email: 'other@example.com' }], me), null);
  for (const over of [{ role: 'approver' }, { role: 'inperson' }, { role: 'viewer' }, { group_id: 'g' }, { link_by_sender: true }, { email: '' }]) assert.equal(onlyMe([{ ...mine, ...over }], me), null, JSON.stringify(over));
  assert.equal(onlyMe([], me), null);
  assert.equal(onlyMe([mine], ''), null);
  assert.equal(onlyMe([{ ...mine, email: '' }], ''), null, 'two empty addresses are not the same person');
  assert.equal(onlyMe(null as any, me), null);
  // The screens: the button's words, and where it goes.
  const editor = read('src/components/Editor.tsx');
  assert.match(editor, /const signNow = !!env && !isTpl && !correcting && !!onlyMe\(rcps\.filter\(\(r\) => !isIdle\(r\)\), me\.user\.email\);/);
  assert.match(editor, /body: \{ send_anyway: anyway === true, \.\.\.\(signNow \? \{ sign_now: true \} : \{\}\) \}/);
  assert.match(editor, /if \(signNow && r\?\.sign_url\) \{\s*leaving\.current = true;\s*window\.location\.assign\(r\.sign_url\);/);
  assert.match(read('src/components/editor/StepReview.tsx'), /ed\.signNow \? 'Sign now' : 'Send'/);
  // Home still starts it with the sender on the document (the path flow h measures).
  assert.match(read('src/app/app/envelopes/new/page.tsx'), /q\.get\('self'\)/);
});

test('Sign now sends without an invitation email to the sender, answers with their signing page, and the record says so', async () => {
  const who = { name: 'Rosa Gardener', email: 'rosa.now@example.com' };
  const c = await signUp(who.name, who.email, ip());
  const e = await ownDraft(c, who);
  const before = mailTo(who.email).length;
  const r = await c.post(`/envelopes/${e.id}/send`, { sign_now: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.envelope.status, 'sent');
  assert.equal(r.data.sign_url, `http://test.local/sign/${tokenFor(e.id, who.email)}`);
  assert.equal(mailTo(who.email).length, before, 'no invitation email to the person who is already looking at it');
  const lines = audit(e.id);
  assert.ok(lines.some((l) => l.action === 'Not emailed' && l.detail === signNowNote(`${who.name} <${who.email}>`)), JSON.stringify(lines));
  assert.ok(!lines.some((l) => l.action === 'Sent to recipient'), 'the record does not say an email was sent');
  assert.doesNotMatch(signNowNote('x'), /\u2014/);
  // The request is open like any other, and the signing page opens for them.
  assert.equal(db.get('SELECT status FROM recipients WHERE envelope_id=?', e.id).status, 'sent');
  const view = await c.get(`/sign/${tokenFor(e.id, who.email)}`);
  assert.equal(view.status, 200);
  // The same draft sent the ordinary way is emailed as before.
  const e2 = await ownDraft(c, who);
  const r2 = await c.post(`/envelopes/${e2.id}/send`, {});
  assert.equal(r2.status, 200);
  assert.equal(r2.data.sign_url, undefined);
  assert.equal(mailTo(who.email).length, before + 1);
  assert.ok(!audit(e2.id).some((l) => /Sign now/.test(l.detail)), 'and its record says nothing about Sign now');
});

test('Sign now cannot be used to skip anybody else\'s email, to get a colleague\'s link, or to skip a check', async () => {
  const who = { name: 'Abe Sender', email: 'abe.now@example.com' };
  const c = await signUp(who.name, who.email, ip());
  // 1. Somebody else on the document: "sign_now" changes nothing. Everyone is emailed, and no link comes back.
  const withOther = await simple(c, 'other.now@example.com', { recipients: [{ id: 'r', role: 'signer', name: who.name, email: who.email }, { id: 'o', role: 'cc', name: 'Olive Other', email: 'other.now@example.com' }] });
  const mineBefore = mailTo(who.email).length;
  const a = await c.post(`/envelopes/${withOther.id}/send`, { sign_now: true });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.sign_url, undefined);
  assert.equal(mailTo(who.email).length, mineBefore + 1, 'the sender is invited by email as usual');
  // The only person is someone else: the same.
  const forOther = await simple(c, 'sam.now@example.com');
  const b = await c.post(`/envelopes/${forOther.id}/send`, { sign_now: true });
  assert.equal(b.data.sign_url, undefined);
  assert.equal(mailTo('sam.now@example.com').filter((m) => m.link?.includes('/sign/')).length, 1);
  // 2. Only true is yes. A word in quotes is an ordinary send.
  const quoted = await ownDraft(c, who);
  const q = await c.post(`/envelopes/${quoted.id}/send`, { sign_now: 'true' });
  assert.equal(q.status, 200);
  assert.equal(q.data.sign_url, undefined);
  // 3. A colleague who sends the owner's draft gets no link to the owner's signature, and the owner is emailed.
  assert.equal((await c.post('/account/invites', { email: 'mate.now@example.com', role: 'admin' })).status, 200);
  const mate = Object.assign(new Client(), { ip: ip() });
  const invite = db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL', 'mate.now@example.com').token;
  assert.equal((await mate.post('/auth/signup', { name: 'Mia Mate', email: 'mate.now@example.com', password: PW, invite })).status, 200);
  const owners = await ownDraft(c, who);
  const count = mailTo(who.email).length;
  const m = await mate.post(`/envelopes/${owners.id}/send`, { sign_now: true });
  if (m.status === 200) {
    assert.equal(m.data.sign_url, undefined, 'no link to somebody else\'s signature');
    assert.equal(mailTo(who.email).length, count + 1);
  } else assert.ok(m.status === 403 || m.status === 404, `a colleague who may not send it is refused as before (${m.status})`);
  assert.equal(signNowFor({ recipients: [{ role: 'signer', email: who.email }] }, { email: who.email }, 'mate.now@example.com', true), null);
  assert.equal(signNowFor({ recipients: [{ role: 'signer', email: who.email }] }, { email: who.email }, null, true), null, 'nobody signed in, no link');
  assert.equal(signNowFor({ recipients: [{ role: 'signer', email: who.email }] }, { email: who.email }, who.email, 1), null);
  // 4. An access code the sender put on themselves is still asked for on the signing page.
  const coded = await ownDraft(c, who, { access_code: '424242' });
  const k = await c.post(`/envelopes/${coded.id}/send`, { sign_now: true });
  assert.equal(k.status, 200, JSON.stringify(k.data));
  assert.ok(k.data.sign_url);
  const fresh = Object.assign(new Client(), { ip: ip() });
  const locked = await fresh.get(`/sign/${tokenFor(coded.id, who.email)}`);
  assert.ok(locked.status === 200 && JSON.stringify(locked.data).includes('locked') || locked.status === 401, 'the code stands between the link and the document');
  assert.equal((await fresh.post(`/sign/${tokenFor(coded.id, who.email)}/complete`, {})).status, 401);
});

test('a send that fails leaves nothing behind, and a held invitation is used once', async () => {
  holdInvite('rcp_x');
  assert.equal(inviteHeld('rcp_x'), true);
  assert.equal(inviteHeld('rcp_x'), false, 'once');
  holdInvite('rcp_y');
  dropHold('rcp_y');
  assert.equal(inviteHeld('rcp_y'), false);
  // The send wraps the first emails so that the hold is dropped whatever happens.
  const env = read('src/server/envelopes.ts');
  assert.match(env, /if \(o\.signNow\) holdInvite\(o\.signNow\);\s*try \{\s*await advance\(e\.id\);\s*\} finally \{\s*if \(o\.signNow\) dropHold\(o\.signNow\);\s*\}/);
  // A draft that cannot be sent (nobody signs: no field) is refused as before, and the next ordinary send is emailed.
  const who = { name: 'Fay Fails', email: 'fay.now@example.com' };
  const c = await signUp(who.name, who.email, ip());
  const bad = await simple(c, who.email, { recipients: [{ id: 'r', role: 'signer', name: who.name, email: who.email }], fields: [] });
  const no = await c.post(`/envelopes/${bad.id}/send`, { sign_now: true });
  assert.equal(no.status, 400, JSON.stringify(no.data));
  assert.equal(no.data.sign_url, undefined);
  const good = await ownDraft(c, who);
  const before = mailTo(who.email).length;
  assert.equal((await c.post(`/envelopes/${good.id}/send`, {})).status, 200);
  assert.equal(mailTo(who.email).length, before + 1);
});

// ---- 5. What stayed, and what the pages say --------------------------------------------------------------------------

test('nothing a sender could do before is gone, the pages say where things are now, and there are no em dashes', () => {
  // Every control the three steps had is still in one of the editor's files.
  const all = fs.readdirSync('src/components/editor').filter((f) => /\.tsx?$/.test(f)).map((f) => read(`src/components/editor/${f}`)).join('\n') + read('src/components/Editor.tsx') + read('src/components/sender/CheckFields.tsx');
  for (const w of ['Set signing order', 'Replace file', 'aria-label="Signing order"', 'aria-label="Role name"', 'Access code', 'Private note', 'BY_SENDER_TICK', 'Check before the document opens', 'Also text the signing link',
    '<WitnessChoice', '<AddGroup', 'Remind people who have not finished', 'Deadline', 'DATE_FORMAT_CHOICES', '<PayLinkChoice', '<CustomFieldsStep', 'Prefilled value', 'Read only', 'Copy to every page', 'Duplicate', '<StampChoice', '<FieldLogic', 'Save and close', 'HelpChatButton'])
    assert.ok(all.includes(w), w);
  // The API description and the README say what Sign now does and does not do.
  const { openapi } = { openapi: read('src/server/openapi.ts') };
  assert.match(openapi, /"sign_now": true is for the person the envelope belongs to/);
  assert.match(openapi, /In every other case "sign_now" changes nothing/);
  const readme = read('README.md');
  assert.match(readme, /Sign now/);
  assert.match(readme, /one empty person row/);
  for (const f of ['src/lib/editorux.ts', 'src/server/signnow.ts', 'src/components/editor/PersonMore.tsx', 'src/components/editor/FileRow.tsx', 'src/components/editor/ReviewParts.tsx', 'src/components/editor/StepAdd.tsx',
    'src/components/editor/StepFields.tsx', 'src/components/editor/StepReview.tsx', 'src/components/Editor.tsx', 'tests/simplify-editor.test.ts']) {
    const s = read(f);
    assert.doesNotMatch(s, /\u2014/, `${f}: no em dashes`);
    assert.doesNotMatch(s, /Sign&(amp;)?Grow/, `${f}: the product is GrowSigning`);
  }
  // Pages and components never import the server.
  for (const f of ['PersonMore.tsx', 'FileRow.tsx', 'ReviewParts.tsx']) assert.doesNotMatch(read(`src/components/editor/${f}`), /from '[^']*server\//, f);
});
