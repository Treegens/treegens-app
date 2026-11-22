// build-simplicity-r6: the fixes of the sixth simplicity walk (src/lib/simplicity.ts). Each test reads what a person
// sees, from the shared words and from the screen's source, the way the other simplify tests do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { doneLine, doneActions, STEP3_ORDER, documentsIntro, countLine, NEEDS_YOU_LINE, ALWAYS_REACH, pagesButton, emailLine, TARGET_PX } from '../src/lib/simplicity.ts';

const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const NO_EM = /—/;

// ---- 1. The done screen -----------------------------------------------------------------------------------------------

test('1. the done screen has one main button, Download, and says "signing record", never "certificate"', () => {
  for (const all of [true, false]) {
    const acts = doneActions(all);
    assert.equal(acts.filter((a) => a.primary).length, 1, 'one main button');
    assert.equal(acts[0].key, 'download', 'Download comes first and is the main one');
    assert.ok(acts[0].primary);
    assert.match(acts[0].label, /^Download/);
    // Buttons start with a verb (charter P6).
    for (const a of acts) assert.match(a.label, /^(Download|Open) /);
    for (const inPerson of [true, false]) {
      const line = doneLine({ allDone: all, inPerson, sender: 'Rosa Gardener', email: 'ada@example.org' });
      assert.doesNotMatch(line, /certificate/i, line);
      assert.doesNotMatch(line, NO_EM);
      // Signer screens: sentences of 20 words or fewer (charter P6).
      for (const s of line.split(/(?<=\.)\s+/)) assert.ok(words(s) <= 20, `${words(s)} words: ${s}`);
    }
  }
  assert.match(doneLine({ allDone: true, inPerson: false, sender: 'R', email: 'ada@example.org' }), /signing record: who signed and when/);
  // The page draws exactly these, and the old pair is gone.
  const page = read('src/app/sign/[token]/page.tsx');
  assert.match(page, /doneLine\(\{ allDone, inPerson, sender: sender\.name, email: me\.email \}\)/);
  assert.match(page, /doneActions\(allDone\)\.map/);
  assert.doesNotMatch(page, /View completed document|It includes a certificate with the full record|with its certificate, has been emailed/);
  // The download link is the filled one; the "open in a new tab" one is plain.
  assert.match(page, /a\.key === 'download'\s*\? <a key=\{a\.key\} className="btn primary lg" href=\{downloadUrl\}>/);
  assert.match(page, /: <a key=\{a\.key\} className="btn lg" href=\{`\$\{downloadUrl\}\?inline=1`\} target="_blank"/);
});

// ---- 2. 44 px targets at every width --------------------------------------------------------------------------------

test('2. buttons, step tabs, the sidebar and boxes are 44 px tall on a desktop too, without growing what sits on a page', () => {
  assert.equal(TARGET_PX, 44);
  const css = read('src/app/globals.css');
  const block = css.slice(css.indexOf('44 px targets at every width'));
  assert.match(block, /:where\(\.btn, \.steps button, \.side button, \.tabs button, summary\.btn\) \{ min-height: 44px; \}/);
  assert.match(block, /:where\(input:not\(\[type='checkbox'\], \[type='radio'\], \[type='color'\], \[type='range'\], \[type='file'\], \[type='hidden'\]\), select\) \{ min-height: 44px; \}/);
  assert.match(block, /:where\(\.pub-toc a\) \{[^}]*min-height: 44px/);
  // Zero weight, so the boxes on a document page keep their own size (.field.fill input sets min-height: 0).
  for (const rule of block.match(/^[^/\n*][^{\n]*\{/gm) || []) assert.match(rule, /^:where\(/, rule);
  assert.match(css, /\.field\.fill input, \.field\.fill select, \.field\.fill textarea \{[^}]*min-height: 0/);
  // Not inside a media query: it holds at 1440 x 900.
  const before = css.slice(0, css.indexOf('44 px targets at every width'));
  assert.equal((before.match(/\{/g) || []).length, (before.match(/\}/g) || []).length, 'the block is at the top level');
});

// ---- 3. Step 3 in the charter's order --------------------------------------------------------------------------------

test('3. step 3 shows who gets it before the email subject and message, right above Send', () => {
  assert.deepEqual([...STEP3_ORDER], ['preview', 'who', 'message', 'more', 'send']);
  const s = read('src/components/editor/StepReview.tsx');
  const at = (re: RegExp) => { const m = s.search(re); assert.ok(m >= 0, String(re)); return m; };
  const preview = at(/<SeeWhatTheySee ed=\{ed\}/);
  const who = at(/\{isTpl \? 'Roles' : 'Who gets it'\}/);
  const message = at(/\{!closed && <SendWords ed=\{ed\} \/>\}/);
  const more = at(/<ReviewMore ed=\{ed\} closed=\{!!closed\} \/>/);
  const send = at(/className="row wrap ed-actions"/);
  assert.ok(preview < who && who < message && message < more && more < send, 'preview, who, message, more options, send');
  assert.equal(s.match(/<SendWords /g)?.length, 1, 'the subject and message are drawn once');
  assert.equal(s.match(/<CustomFieldsStep /g)?.length, 1);
});

// ---- 4. Documents ---------------------------------------------------------------------------------------------------

test('4. Documents says what its line is about, and asks to tick boxes only when there are boxes', () => {
  assert.equal(documentsIntro(false), 'Downloading your signed PDFs is free, also after you cancel.');
  assert.match(documentsIntro(true), /The full export is in Settings, Records and data\.$/);
  assert.equal(countLine(1, 0, 50), '1 document.', 'a list of drafts has nothing to tick');
  assert.equal(countLine(3, 2, 50), '3 documents. Tick the boxes to download several as one ZIP.');
  assert.equal(countLine(50, 50, 50), '50 most recently updated documents. Search to find older ones. Tick the boxes to download several as one ZIP.');
  assert.equal(countLine(0, 0, 50), '');
  const page = read('src/app/app/envelopes/page.tsx');
  assert.match(page, /\{documentsIntro\(!!isAdmin\)\}/);
  assert.match(page, /countLine\(rows\.length, inRemoved \? 0 : pickable\.length, PAGE\)/);
  assert.doesNotMatch(page, /Free, also after you cancel\./);
});

// ---- 5. Settings, Profile: the email switches ----------------------------------------------------------------------

test('5. each email switch has one line under it; what reaches you anyway is said once, under all of them', () => {
  assert.ok(words(NEEDS_YOU_LINE) <= 30, `${words(NEEDS_YOU_LINE)} words`);
  assert.equal(NEEDS_YOU_LINE.split(/(?<=\.)\s+/).length, 1, 'one sentence');
  const s = read('src/app/app/settings/page.tsx');
  assert.match(s, /\['problems', 'When something needs you', NEEDS_YOU_LINE\]/);
  assert.match(s, /\{ALWAYS_REACH\} People you send to get one request/);
  // Nothing that was said before is lost: every case is still named.
  for (const w of ['declined', 'could not be delivered', 'unopened', 'link could not be opened', 'deadline']) assert.ok(NEEDS_YOU_LINE.includes(w), w);
  for (const w of ['passed the document on', 'how their name is written', 'more time', 'access code']) assert.ok(ALWAYS_REACH.includes(w), w);
});

// ---- 6. The sender's words on the daily path --------------------------------------------------------------------------

test('6. Settings, Account and Contacts say "the people you send to" and "documents", not recipients and envelopes', () => {
  const acc = read('src/app/app/settings/page.tsx');
  const account = acc.slice(acc.indexOf('function Account()'), acc.indexOf('function Account()') + 3000);
  assert.doesNotMatch(account, /recipients?\b(?![_A-Za-z])(?=[^']*<)/i);
  assert.match(account, /\(shown to the people you send to\)/);
  assert.match(account, /Emails to the people you send to come from/);
  const groups = read('src/components/sender/SigningGroups.tsx');
  for (const line of groups.split('\n').filter((l) => /<p[ >]/.test(l))) assert.doesNotMatch(line.replace(/\{[^}]*\}/g, ''), /\brecipients?\b|\benvelopes?\b/, line.trim().slice(0, 120));
});

// ---- 8. Settings, Profile: the address once --------------------------------------------------------------------------

test('8. the login address is said once, with "not confirmed yet" only when that is so', () => {
  assert.equal(emailLine('rosa@example.org', true, false), 'You sign in with rosa@example.org, and our emails to you go there.');
  assert.equal(emailLine('rosa@example.org', false, false), 'You sign in with rosa@example.org, which is not confirmed yet, and our emails to you go there.');
  assert.match(emailLine('rosa@example.org', true, true), /Our last email to it came back, see the notice at the top\.$/);
  const s = read('src/app/app/settings/page.tsx');
  const profile = s.slice(s.indexOf('function Profile()'), s.indexOf('function Security()'));
  assert.doesNotMatch(profile, /me\.user\.email\} · /, 'the Profile card no longer repeats the address');
  assert.match(read('src/components/EmailProblem.tsx'), /\{emailLine\(me\.user\.email, !!me\.user\.email_verified, !!me\.email_problem\)\}/);
});

// ---- 9. Editor, step 1: the pages of a file ---------------------------------------------------------------------------

test('9. a file row says its page count once, as the button that opens its pages', () => {
  assert.equal(pagesButton(2), '2 pages');
  assert.equal(pagesButton(1), '1 page');
  assert.equal(pagesButton(1200), '1,200 pages');
  assert.equal(pagesButton(0), 'Pages', 'a file still being read keeps a plain name');
  const s = read('src/components/editor/FileRow.tsx');
  // The visible label is part of the name a screen reader hears (WCAG 2.5.3, label in name).
  assert.match(s, /aria-label=\{`\$\{pagesButton\(d\.pages\)\} of \$\{name\}: remove, turn or move pages`\}>\{pagesButton\(d\.pages\)\}<\/button>/);
  assert.doesNotMatch(s, />Pages<\/button>/);
  // A read-only row keeps the plain count, and only one of the two is drawn.
  assert.match(s, /\{ed\.wording && <span className="muted small" style=\{\{ whiteSpace: 'nowrap' \}\}>\{plural\(d\.pages, 'page'\)\}<\/span>\}/);
  assert.match(s, /\{!ed\.wording && <button type="button" className="btn sm ghost" data-feature="ds-page-tools"/);
});

test('no em dash in anything this round wrote', () => {
  assert.doesNotMatch(read('src/lib/simplicity.ts'), NO_EM);
});
