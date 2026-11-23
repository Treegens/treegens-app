// build-simplicity-r6: the fixes of the sixth simplicity walk (src/lib/simplicity.ts). Each test reads what a person
// sees, from the shared words and from the screen's source, the way the other simplify tests do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { doneLine, doneActions, STEP3_ORDER, documentsIntro, exportNote, onePersonLineShown, rowStatusLabel, countLine, NEEDS_YOU_LINE, ALWAYS_REACH, pagesButton, emailLine, TARGET_PX, barTitle, exportShown, SEARCH_HINT } from '../src/lib/simplicity.ts';
import { englishIf } from './words.ts';

// Screens moved into the catalogue are read with their English put back (lang-sender-rest, tests/words.ts).
const read = (p: string) => englishIf(p, fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
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
  // repair-simplicity-r6: the intro says what the list holds; the download sentence goes with the ZIP button.
  assert.equal(documentsIntro(false), 'Sent documents and drafts, most recently changed first.');
  assert.equal(documentsIntro(true), documentsIntro(false));
  assert.equal(exportNote(false), 'Downloading your signed PDFs is free, also after you cancel.');
  assert.match(exportNote(true), /The full export is in Settings, Records and data\.$/);
  assert.equal(countLine(1, 0, 50), '1 document.', 'a list of drafts has nothing to tick');
  assert.equal(countLine(1, 1, 50), '1 document.', 'one box is not "several": its own Download is the way');
  assert.equal(countLine(3, 2, 50), '3 documents. Tick the boxes to download several as one ZIP.');
  assert.equal(countLine(50, 50, 50), '50 most recently updated documents. Search to find older ones. Tick the boxes to download several as one ZIP.');
  assert.equal(countLine(0, 0, 50), '');
  const page = read('src/app/app/envelopes/page.tsx');
  assert.match(page, /<div className="muted small">\{documentsIntro\(\)\}<\/div>/);
  // The note is drawn inside the block that only exists with the button, and the button points at it.
  const zip = page.slice(page.indexOf('{exportShown(sentOne) &&'), page.indexOf('{exportShown(sentOne) &&') + 700);
  assert.match(zip, /aria-describedby="sn-export-note"/);
  assert.match(zip, /<div className="muted small" id="sn-export-note">\{exportNote\(!!isAdmin\)\}<\/div>/);
  assert.equal(page.match(/id="sn-export-note"/g)?.length, 1);
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
  for (const line of groups.split('\n').filter((l) => /<p[ >]/.test(l))) assert.doesNotMatch(line.replace(/\{[^}]*\}/g, ''), /\brecipients?\b|\benvelopes?\b/i, line.trim().slice(0, 120));
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

// ---- 7. The signing page's top bar ----------------------------------------------------------------------------------

test('7. the signing page top bar names the document, without the app\'s "Please sign: "', () => {
  assert.equal(barTitle('Please sign: Planting partnership'), 'Planting partnership');
  assert.equal(barTitle('please sign:   Lease 12B'), 'Lease 12B');
  // The sender's own words stay as written, and a subject that is only the prefix is not emptied.
  assert.equal(barTitle('Your lease for 2027'), 'Your lease for 2027');
  assert.equal(barTitle('Please sign:'), 'Please sign:');
  assert.equal(barTitle(undefined), '');
  const parts = read('src/components/sign/parts.tsx');
  assert.match(parts, /const title = data\?\.envelope\?\.subject \? barTitle\(data\.envelope\.subject\) : 'GrowSigning';/);
  // The consent heading still asks: it is the one place the whole subject is read.
  assert.match(read('src/components/sign/ConsentTop.tsx'), /headingFor\(env\.subject, !!ask\)/);
});

// ---- 10. The sender's daily path says documents, History and Send to many ------------------------------------------

/** The words a person reads in a .tsx file: text between tags that is not code. */
const shownText = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').replace(/\{[^{}<>]*\}/g, ' ')
  .match(/>([^<>{}();=]*[A-Za-z][^<>{}();=]*)</g)?.map((m) => m.slice(1, -1).trim()) || [];
const AVOID_SENDER = /\b(envelopes?|recipients?|bulk sends?|audit trail|void|clone|nudge)\b/i;

test('10. Documents, the document page, the editor, Contacts and Team say document, History and Send to many', () => {
  const files = ['src/app/app/envelopes/page.tsx', 'src/app/app/envelopes/[id]/page.tsx', 'src/app/app/templates/page.tsx', 'src/app/app/page.tsx',
    ...fs.readdirSync(new URL('../src/components/editor/', import.meta.url)).filter((f) => f.endsWith('.tsx')).map((f) => `src/components/editor/${f}`),
    ...fs.readdirSync(new URL('../src/components/sender/', import.meta.url)).filter((f) => f.endsWith('.tsx')).map((f) => `src/components/sender/${f}`)];
  for (const f of files) for (const t of shownText(read(f))) assert.doesNotMatch(t, AVOID_SENDER, `${f}: ${t.slice(0, 120)}`);
  assert.match(read('src/app/app/envelopes/page.tsx'), />Sent with Send to many<\/Link>/);
  // Strings a component keeps in a constant are read too.
  assert.match(read('src/components/editor/CheckPick.tsx'), /a "phone" column in Send to many,/);
  assert.match(read('src/components/sender/WitnessFacts.tsx'), /'Nobody on this document\. To choose whose signature they witness, choose More, then Edit\.'/);
  const team = read('src/app/app/settings/page.tsx');
  const t = team.slice(team.indexOf('function Team()'), team.indexOf('function Team()') + 12000);
  assert.equal(t.match(/Each document&apos;s History says who handed it to whom\./g)?.length, 2);
  assert.doesNotMatch(t, /bulk sends pass|envelope&apos;s audit trail/);
});

// ---- 11. Help on the signing page: buttons start with a verb -----------------------------------------------------------

test('11. the Help dialog says "Open the help page", a button that starts with a verb (charter P6)', () => {
  const h = read('src/components/HelpChat.tsx');
  assert.match(h, />Open the help page\{newTab && <span className="sg-vh"> \(opens in a new tab\)<\/span>\}<\/a>/);
  assert.doesNotMatch(h, />The help page\{/);
});

// ---- 12. One name for a document --------------------------------------------------------------------------------

test('12. the document page heading uses the same name as Home and Documents', () => {
  const p = read('src/app/app/envelopes/[id]/page.tsx');
  assert.match(p, /const title = listName\(e\.subject\) \|\| \(isTpl \? 'Untitled template' : 'Untitled'\);/);
  assert.match(p, /<h1 className="serif sn-title">\{title\}<\/h1>/);
  assert.match(read('src/app/app/envelopes/page.tsx'), /const title = listName\(e\.subject\) \|\| 'Untitled draft';/);
});

// ---- 13. Documents: no empty ZIP button, a hint that fits a phone, a column called Document ---------------------------

test('13. Documents shows the ZIP button only once something is completed, and a short search hint', () => {
  assert.equal(exportShown(null), false, 'hidden while loading');
  assert.equal(exportShown({ envelopes: [] }), false, 'hidden before anything was sent');
  assert.equal(exportShown({ envelopes: [{}] }), true);
  // 390 px wide, 16 px type: about 32 characters fit in the box.
  assert.ok(SEARCH_HINT.length <= 32, SEARCH_HINT);
  assert.doesNotMatch(SEARCH_HINT, /\bID\b|subject/i);
  const page = read('src/app/app/envelopes/page.tsx');
  assert.match(page, /\{exportShown\(sentOne\) && <div className="stack"/);
  // repair-simplicity-r6: "something completed", not "something sent": a waiting document has no signed PDF yet.
  assert.match(page, /const \[sentOne\] = useLoad<any>\(\(\) => api\('\/envelopes\?box=completed&limit=1'\)\);/);
  assert.match(page, /placeholder=\{SEARCH_HINT\}/);
  assert.match(page, /<th>Document<\/th>/);
  assert.doesNotMatch(page, /Envelopes are included/);
});

// ---- 14. Public pages: the rules that undid 44 px on a desktop -----------------------------------------------------------

test('14. public pages keep 44 px targets on a desktop: the form buttons, the /security contents, the promise links', () => {
  const css = read('src/app/styles/public.css');
  assert.match(css, /\.pub-form-row \.btn \{ min-height: 44px; \}/);
  assert.match(css, /\.pub-toc a \{[^}]*min-height: 44px;/);
  assert.match(css, /\.pub-promise a \{[^}]*min-height: 44px;/);
  // No rule outside a phone-only media query sets a target below 44 px again.
  const top = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '');
  for (const m of top.matchAll(/([^{}]+)\{[^}]*min-height: (\d+)px/g)) {
    if (/\b(a|\.btn|button|summary)\b/.test(m[1])) assert.ok(Number(m[2]) >= 44, `${m[1].trim()}: ${m[2]}px`);
  }
});

// ---- 15. The sender's small links -----------------------------------------------------------------------------------

test('15. the back link on a document page and the API reference link are 44 px tall and say what they do', () => {
  const css = read('src/app/styles/sender.css');
  assert.match(css, /^\.sn-back \{ display: inline-flex; align-items: center; min-height: 44px; \}/m);
  assert.doesNotMatch(css, /\.sn-back \{ min-height: (?!44)\d+px/);
  const s = read('src/app/app/settings/page.tsx');
  assert.match(s, /<a href="\/developers" target="_blank" rel="noreferrer" style=\{\{ display: 'inline-flex', alignItems: 'center', minHeight: 44 \}\}>Open the API reference<span className="sn-vh"> \(opens in a new tab\)<\/span><\/a>/);
  assert.doesNotMatch(s, /API reference ↗/);
});

test('no em dash in anything this round wrote', () => {
  assert.doesNotMatch(read('src/lib/simplicity.ts'), NO_EM);
});

// ==== repair-simplicity-r6: what the skeptic and the simplicity reviewer found ==========================================

import { signerWords, senderWords } from '../src/lib/impactwords.ts';
import { SIGN_LABELS } from '../src/server/chatscreens.ts';
import { builtInAnswer } from '../src/server/chatkb.ts';

test('R1. Home: the one-person line is for a team of two or more only, one line, closable; the full words stay in Settings', () => {
  // A person who works alone, paying or not, has nobody to lock out: nothing on Home.
  assert.equal(onePersonLineShown({ role: 'owner', admins: 1, members: 1 }), false);
  assert.equal(onePersonLineShown({ role: 'owner', admins: 1, members: 0 }), false);
  assert.equal(onePersonLineShown({ role: 'owner', admins: 1, members: 3 }), true);
  assert.equal(onePersonLineShown({ role: 'admin', admins: 2, members: 3 }), false, 'a second admin is there');
  assert.equal(onePersonLineShown({ role: 'member', admins: 1, members: 3 }), false, 'a member cannot add an admin');
  assert.equal(onePersonLineShown({}), false, 'nothing known yet: nothing shown');
  const home = read('src/app/app/page.tsx');
  assert.match(home, /<OnePersonLine me=\{me\} \/>/);
  assert.doesNotMatch(home, /me\.account\.plan !== 'seedling'/, 'a paid plan alone is no reason');
  assert.doesNotMatch(home, /home\.one_person/, 'the words live in the component');
  const c = read('src/components/sender/OnePersonLine.tsx');
  assert.match(c, /onePersonLineShown\(\{ role: me\?\.role, admins: me\?\.admins, members: me\?\.members \}\)/);
  assert.match(c, /className="ph-hint-x" onClick=\{hide\} aria-label=\{T\('home\.add_dismiss_label'\)\}/, 'it can be closed, with a name for screen readers');
  assert.match(c, /localStorage\.setItem\(KEY, '1'\)/);
  assert.doesNotMatch(c, /className="notice/, 'a quiet line, not a warning box');
  const en = JSON.parse(fs.readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));
  const line = `${en['home.one_person.title']} ${en['home.one_person.body'].replace('{email}', 'rosa@example.org')} ${en['home.one_person.button']}`;
  assert.ok(words(line) <= 25, `${words(line)} words: ${line}`);
  assert.doesNotMatch(line, /workspace|—/);
  assert.match(read('src/app/app/settings/page.tsx'), /<b>This account depends on one person\.<\/b> If you lose access to \{me\.user\.email\}/, 'Settings, Team keeps the whole explanation');
});

test('R2. the product name is never used as a word for a document', () => {
  const s = signerWords({ trees: 0, sheets: 0, total: 0 } as any);
  assert.equal(s.title, 'You signed your first document with GrowSigning');
  assert.equal(senderWords({ paid: 0, signers: 1, planted: 0, sheets: 0 }).title, 'Your first document is out.');
  assert.doesNotMatch(read('src/lib/impactwords.ts'), /first GrowSigning/);
});

test('R3. the signing page has one menu of actions: the view button is called View, not More', () => {
  const m = read('src/components/sign/More.tsx');
  assert.match(m, /aria-expanded=\{open\} onClick=\{onOpen\}>View<\/button>/);
  assert.match(m, /<Dialog title="How the document looks"/);
  assert.equal(SIGN_LABELS.more, 'View');
  assert.equal(SIGN_LABELS.menu, 'Other actions');
  // The helper, the stuck line and the zoom answer say the same name as the button.
  assert.match(builtInAnswer('I cannot see the document', 'signing').reply, /choose View\. It has Easy reading/);
  assert.match(read('src/components/sign/stuck.ts'), /Choose View, then Easy reading/);
  assert.match(read('src/lib/mobile.ts'), /'Choose View, then 150% or 200%\./);
  assert.match(read('src/components/sign/TextFields.tsx'), /To draw this, open View and choose Page\./);
  for (const f of ['src/components/sign/stuck.ts', 'src/lib/mobile.ts', 'src/components/sign/TextFields.tsx', 'src/lib/a11y.ts'])
    assert.doesNotMatch(read(f), /(Choose|open|under) More\b/, f);
});

test('R4. Documents: a row waiting only on you says so in its chip too', () => {
  assert.equal(rowStatusLabel('sent', { you: true, people: [{}] }), 'Waiting for you');
  assert.equal(rowStatusLabel('sent', { you: true, people: [{}, {}] }), undefined, 'you and someone else: the usual chip');
  assert.equal(rowStatusLabel('sent', { you: false, people: [{}] }), undefined);
  assert.equal(rowStatusLabel('completed', { you: true, people: [{}] }), undefined);
  assert.equal(rowStatusLabel('sent', null), undefined);
  const page = read('src/app/app/envelopes/page.tsx');
  assert.equal(page.match(/<Status s=\{e\.status\} label=\{rowStatusLabel\(e\.status, w\)\} \/>/g)?.length, 2, 'the phone line and the desktop column');
  assert.doesNotMatch(page, /<Status s=\{e\.status\} \/>/);
});

test('R5. 44 px: the tabs, the colour box, the /help hint button and the /help folds', () => {
  const g = read('src/app/globals.css');
  assert.match(g, /:where\(\.tabs button, \.tabs a\) \{ min-width: 44px; \}/);
  assert.match(g, /:where\(input\[type='color'\]\) \{ min-height: 44px; min-width: 44px; \}/);
  const p = read('src/app/styles/public.css');
  assert.match(p, /\.pub-form-hint \.linklike \{ display: inline-flex; align-items: center; min-height: 44px;/);
  assert.match(p, /\.pub details:not\(\.pub-fold\) > summary:not\(\[class\]\) \{ min-height: 44px;/);
  // The hint button and the fold this is for are still drawn that way.
  assert.match(read('src/app/help/tools.tsx'), /<p className="muted small pub-form-hint">[\s\S]{0,400}<button type="button" className="linklike"/);
  assert.match(read('src/app/help/outside.tsx'), /<details data-fold="">\s*<summary>The words it looks for<\/summary>/);
  // The five tabs of Documents fit one row on a phone.
  assert.match(read('src/app/styles/sender.css'), /\.sn \.tabs \{ gap: 0; \}\n  \.sn \.tabs button \{ padding-left: 8px; padding-right: 8px; \}/);
});

test('R6. the document page: an empty Details fold says "Add details" and looks like History and Files', () => {
  const c = read('src/components/sender/CustomDetails.tsx');
  assert.match(c, /<details className="card sn-fold cf-details"/);
  assert.match(c, /rows\.length \? `\$\{t\(ui, 'customfields\.page\.title'\)\} \(\$\{rows\.length\}\)` : t\(ui, 'customfields\.page\.add'\)/);
  assert.match(c, /<div className="sn-fold-in">/);
  assert.doesNotMatch(c, /\(\{rows\.length\}\)<\/summary>/);
  const en = JSON.parse(fs.readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));
  assert.equal(en['customfields.page.add'], 'Add details');
});

test('R7. one Help: the sidebar no longer repeats the support address; /help says "You do not need an account"', () => {
  const shell = read('src/components/AppShell.tsx');
  assert.doesNotMatch(shell, /href=\{`mailto:\$\{me\.support_email\}`\}/);
  assert.match(read('README.md'), /in the app, Help's "Talk to a person" reaches it\./);
  const help = read('src/app/help/page.tsx');
  assert.match(help, /<p className="pub-lead">You do not need an account to get help\. /);
  assert.doesNotMatch(help, /login wall/i);
});

test('R8. one word for the account: "account", not "workspace", in what a person reads', () => {
  const en = JSON.parse(fs.readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));
  for (const k of ['home.one_person.title', 'home.one_person.body', 'shell.workspace', 'rules.password.gate']) assert.doesNotMatch(en[k], /workspace/i, k);
  assert.equal(en['shell.workspace'], 'The account you are in');
});

test('R9. the charter and the product agree on where the email switches are', () => {
  const ch = read('research/ux-charter.md');
  assert.match(ch, /\| Profile \| everyone \|[^\n]*and the email switches/);
  assert.match(read('src/lib/settingsnav.ts'), /if \(asked === 'notifications'\) return \{ tab: 'profile', focus: 'notifications' \};/);
});

import { pageMore, PAGE_MORE_CAP } from '../src/lib/envelopepage.ts';
// The page's rule for Keep it, read from its source (a component file cannot be imported here).
const deleteOffersKeep = (r: any) => !!r.closed_at && !r.held && !!(r.noticed_at || r.due_at || r.asked);

test('R10. the document page More stays within 9 lines with everything set up: Hold waits until the document closes', () => {
  // The fullest waiting document: files, an admin on a team with a deletion schedule (the page adds "Move" for a team).
  // mayKeep is what the page passes: deleteOffers(ret).keep, which needs closed_at, so it is false while the document is out.
  assert.equal(deleteOffersKeep({ closed_at: null, noticed_at: '2026-01-01', held: false }), false);
  const out = pageMore({ status: 'sent', hasFiles: true, mayChange: true, main: 'remind', schedule: true, mayKeep: false, mayHold: true, mayPurge: true, pausable: true });
  assert.ok(out.length + 1 <= PAGE_MORE_CAP, `${out.length + 1} lines with Move: ${out.map((l) => l.label).join(', ')}`);
  assert.ok(!out.some((l) => l.key === 'hold'));
  // Once it closes, Hold is there; a hold placed while it was out can still be lifted from the page.
  assert.ok(pageMore({ status: 'completed', hasFiles: true, mayChange: true, main: 'download', schedule: true, mayHold: true }).some((l) => l.key === 'hold'));
  assert.ok(pageMore({ status: 'sent', hasFiles: true, mayChange: true, schedule: true, mayHold: true, held: true, heldHere: true }).some((l) => l.key === 'lift_hold'));
  assert.match(read('src/components/sender/Retention.tsx'), /keep: !!r\.closed_at && !r\.held && !!\(r\.noticed_at \|\| r\.due_at \|\| r\.asked\)/, 'the rule above is the page\'s');
  // Settings, Records and data still places a hold on any one document.
  assert.match(read('src/server/routes-retention.ts'), /route\('POST', '\/account\/retention\/holds'[\s\S]{0,200}envelope_id/);
});
