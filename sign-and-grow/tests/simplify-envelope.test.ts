// The document page, completed documents and Templates made simpler (research/briefs.json "simplify-envelope",
// research/ux-charter.md 2.4 and 2.5). Nothing here is a new feature: the page gets one main button by state, the
// rest moves into one More, each person has one status line and a More of their own, comments, history, files and
// details are folded, and the page shows no internet address or fingerprint. The counts of the flows are measured
// in a browser by tests/ux/flows.cjs; this file pins the rules behind them, and that nothing became impossible.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, simple, signAll, draft } from './helpers.ts';
import { toastLift } from '../src/lib/toastplace.ts';
import {
  PAGE_MORE_CAP, PERSON_MORE_CAP, mainButton, remindLabel, personRemind, waitingSentence, pageMore, offThePage, withoutAddresses, historyLines,
  type PagePerson,
} from '../src/lib/envelopepage.ts';

let db: Awaited<ReturnType<typeof boot>>['db'];
before(async () => {
  ({ db } = await boot());
});

const read = (f: string) => fs.readFileSync(f, 'utf8');
let n = 0;
const ip = () => `10.81.${Math.floor(++n / 250)}.${n % 250}`;
const PAGE = 'src/app/app/envelopes/[id]/page.tsx';
const PEOPLE = 'src/components/sender/Recipients.tsx';
const TEMPLATES = 'src/app/app/templates/page.tsx';
const person = (over: Partial<PagePerson> = {}): PagePerson => ({ id: 'r', name: 'Ana Silva', role: 'signer', status: 'sent', turn: true, me: false, remindable: true, ...over });
/** The words a person can read in a source file: what stands between tags and in quoted strings of JSX. */
const noComments = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- 1. One main button by state -----------------------------------------------------------------------------------

test('each state has one main button, and it says what it does', () => {
  const none: PagePerson[] = [];
  assert.deepEqual(mainButton({ status: 'draft', people: none }), { kind: 'continue', label: 'Continue' });
  assert.deepEqual(mainButton({ status: 'sent', people: [person()] }), { kind: 'remind', label: 'Remind Ana Silva' });
  assert.deepEqual(mainButton({ status: 'completed', people: none }), { kind: 'download', label: 'Download' });
  assert.deepEqual(mainButton({ status: 'expired', people: none }), { kind: 'reopen', label: 'Reopen' });
  assert.deepEqual(mainButton({ status: 'declined', people: none }), { kind: 'copy_fix', label: 'Copy and fix' });
  assert.deepEqual(mainButton({ status: 'voided', people: none }), { kind: 'copy', label: 'Copy' });
  // Removed by its sender: the only thing an admin does with it is put it back, whatever its state.
  for (const status of ['sent', 'completed', 'voided']) assert.equal(mainButton({ status, removed: true, people: [person()] })?.kind, 'restore');
  // A template has its own card (Edit template, Use or Make my own copy), so the rule gives it nothing more.
  assert.equal(mainButton({ status: 'draft', isTemplate: true, people: none }), null);
  // Once the files were deleted there is nothing to download or copy.
  for (const status of ['completed', 'declined', 'voided']) assert.equal(mainButton({ status, purged: true, people: none }), null, status);
});

test('while it is out, the main button is the next thing that moves it: your own turn, then the person next to you, then a reminder', () => {
  const me = person({ id: 'me', name: 'Rosa', me: true, remindable: false });
  const here = person({ id: 'p', name: 'Pat Present', role: 'inperson', remindable: false });
  assert.deepEqual(mainButton({ status: 'sent', people: [person(), me] }), { kind: 'sign', label: 'Sign now', personId: 'me' });
  assert.equal(mainButton({ status: 'sent', people: [{ ...me, role: 'approver' }] })?.label, 'Review now');
  assert.equal(mainButton({ status: 'sent', people: [{ ...me, role: 'viewer' }] })?.label, 'View now');
  assert.deepEqual(mainButton({ status: 'sent', people: [person(), here] }), { kind: 'host', label: 'Host signing now', personId: 'p' });
  // Someone who waits for their turn is not reminded, and is not the reason for a button.
  assert.equal(mainButton({ status: 'sent', people: [person({ turn: false })] }), null);
  // Nobody a reminder could reach (they turned reminders off, their email came back, or you send their link): no
  // button that would do nothing. Their link is in their More instead.
  assert.equal(mainButton({ status: 'sent', people: [person({ remindable: false })] }), null);
  // The button names who it writes to, and stays short with many.
  assert.equal(remindLabel(['Ana Silva']), 'Remind Ana Silva');
  assert.equal(remindLabel(['Ana Silva', 'Ben Okoro']), 'Remind Ana Silva and Ben Okoro');
  assert.equal(remindLabel(['A', 'B', 'C']), 'Remind all 3');
  assert.equal(remindLabel([' ', '']), 'Remind');
  assert.equal(mainButton({ status: 'sent', people: [person(), person({ id: 'b', name: 'Ben Okoro' }), person({ id: 'c', name: 'Cy', remindable: false })] })?.label, 'Remind Ana Silva and Ben Okoro');
});

test('a second Remind, for one person, only when two or more wait at once or the main button is busy with something else', () => {
  const ana = person();
  const ben = person({ id: 'b', name: 'Ben Okoro' });
  const one = [ana];
  assert.equal(personRemind(one, mainButton({ status: 'sent', people: one }), ana), false, 'one person waiting: the main button is the reminder');
  const two = [ana, ben];
  assert.equal(personRemind(two, mainButton({ status: 'sent', people: two }), ana), true);
  assert.equal(personRemind(two, mainButton({ status: 'sent', people: two }), ben), true);
  // The sender signs too: the main button is Sign now, so Ana's reminder is in her More and is not lost.
  const withMe = [ana, person({ id: 'me', me: true, remindable: false })];
  assert.equal(mainButton({ status: 'sent', people: withMe })?.kind, 'sign');
  assert.equal(personRemind(withMe, mainButton({ status: 'sent', people: withMe }), ana), true);
  // Never for someone a reminder cannot reach, or whose turn has not come.
  assert.equal(personRemind(two, null, person({ remindable: false })), false);
  assert.equal(personRemind(two, null, person({ turn: false })), false);
});

test('one status sentence says who it waits for and what they do', () => {
  assert.equal(waitingSentence([person()]), 'Waiting for Ana Silva to sign.');
  assert.equal(waitingSentence([person({ role: 'approver' })]), 'Waiting for Ana Silva to approve.');
  assert.equal(waitingSentence([person(), person({ id: 'b', name: 'Ben Okoro' })]), 'Waiting for Ana Silva and Ben Okoro to sign.');
  assert.equal(waitingSentence([person({ me: true }), person({ id: 'b', name: 'Ben Okoro' })]), 'Waiting for you and Ben Okoro to sign.');
  assert.equal(waitingSentence([person(), person({ id: 'b', name: 'Vi', role: 'viewer' })]), 'Waiting for Ana Silva and Vi.', 'two different things to do: no verb is better than a wrong one');
  assert.equal(waitingSentence([person({ turn: false })]), 'Sent. Nobody is holding it up right now.');
  for (const s of [waitingSentence([person()]), waitingSentence([])]) assert.ok(s.split(' ').length <= 20 && !s.includes(String.fromCharCode(0x2014)));
});

// ---- 2. The page's More: everything else, in a fixed order, never more than nine -----------------------------------

const labels = (o: Parameters<typeof pageMore>[0]) => pageMore(o).map((l) => l.label);

test('the More of the page holds what the row of header buttons held, in one order', () => {
  // Right after the first send, with nothing set up: seven lines, where the page used to show eleven buttons.
  assert.deepEqual(labels({ status: 'sent', hasFiles: true, mayChange: true, main: 'remind' }),
    ['Open the PDF', 'Full record for disputes', 'Edit', 'Give more time', 'Copy', 'Save as template', 'Cancel the request']);
  // Completed: Download is the main button, so the same file is not offered a second time under another name.
  assert.deepEqual(labels({ status: 'completed', hasFiles: true, mayChange: true, main: 'download' }), ['Full record for disputes', 'Copy', 'Save as template', 'Delete']);
  // A draft: it can be opened, copied, saved as a template and deleted. There is no record to download yet.
  assert.deepEqual(labels({ status: 'draft', hasFiles: true, mayChange: true, main: 'continue' }), ['Open the PDF', 'Copy', 'Save as template', 'Delete']);
  // Declined and cancelled: Copy is the main button, so it is not in More as well.
  assert.deepEqual(labels({ status: 'declined', hasFiles: true, mayChange: true, main: 'copy_fix' }), ['Open the PDF', 'Full record for disputes', 'Save as template', 'Delete']);
  assert.deepEqual(labels({ status: 'voided', hasFiles: true, mayChange: true, main: 'copy' }), ['Open the PDF', 'Full record for disputes', 'Save as template', 'Delete']);
  assert.deepEqual(labels({ status: 'expired', hasFiles: true, mayChange: true, main: 'reopen' }), ['Open the PDF', 'Full record for disputes', 'Copy', 'Save as template', 'Delete']);
  // A template: Use (unless its card already says Use), and Delete only for who may.
  assert.deepEqual(labels({ status: 'draft', isTemplate: true, hasFiles: true, mayChange: true }), ['Open the PDF', 'Use', 'Delete']);
  assert.deepEqual(labels({ status: 'draft', isTemplate: true, hasFiles: true, mayChange: false, main: 'copy' }), ['Open the PDF']);
  assert.deepEqual(labels({ status: 'draft', isTemplate: true, hasFiles: true, mayChange: true, mayDelete: false }), ['Open the PDF', 'Use']);
  // Removed by its sender: an admin reads it and downloads its record, and changes nothing until it is back.
  assert.deepEqual(labels({ status: 'completed', removed: true, hasFiles: true, mayChange: true, main: 'restore' }), ['Full record for disputes']);
  // After its files were deleted: nothing to open, copy or download.
  assert.deepEqual(labels({ status: 'completed', purged: true, hasFiles: false, mayChange: true }), ['Delete']);
});

test('one Delete; Keep it and Hold only when a deletion schedule applies, Hold only for who may hold', () => {
  const done = { status: 'completed', hasFiles: true, mayChange: true, main: 'download' as const };
  // No schedule: neither is listed, even for an admin who could hold it (the hold is then in the folded Files section).
  assert.deepEqual(labels({ ...done, schedule: false, mayKeep: true, mayHold: true }), ['Full record for disputes', 'Copy', 'Save as template', 'Delete']);
  assert.deepEqual(labels({ ...done, schedule: true, mayKeep: true, mayHold: true }), ['Full record for disputes', 'Copy', 'Save as template', 'Keep it', 'Hold', 'Delete']);
  assert.deepEqual(labels({ ...done, schedule: true, mayKeep: true, mayHold: false }), ['Full record for disputes', 'Copy', 'Save as template', 'Keep it', 'Delete'], 'a member never sees Hold');
  // A hold that is on can always be lifted by who may, schedule or not, so nobody is locked out of it.
  assert.deepEqual(labels({ ...done, schedule: false, mayHold: true, heldHere: true }), ['Full record for disputes', 'Copy', 'Save as template', 'Lift the hold', 'Delete']);
  for (const o of [{ ...done, schedule: true, mayKeep: true, mayHold: true }, { status: 'sent', hasFiles: true, mayChange: true, schedule: true, mayHold: true }]) {
    const l = labels(o);
    assert.equal(l.filter((x) => /delete/i.test(x)).length <= 1, true, 'never two ways to delete side by side');
    assert.ok(!l.some((x) => /purge|delete now|void|clone|evidence/i.test(x)), l.join(', '));
  }
});

test('in every state the More stays within nine lines, and never repeats the main button', () => {
  let most = 0;
  for (const status of ['draft', 'sent', 'completed', 'expired', 'declined', 'voided'])
    for (const isTemplate of [false, true]) for (const removed of [false, true]) for (const purged of [false, true]) for (const schedule of [false, true]) for (const mayHold of [false, true]) for (const heldHere of [false, true]) {
      const main = mainButton({ status, isTemplate, removed, purged, people: [person()] });
      const l = pageMore({ status, isTemplate, removed, purged, hasFiles: !purged, mayChange: true, main: main?.kind || null, schedule, mayKeep: schedule, mayHold, heldHere });
      most = Math.max(most, l.length);
      assert.ok(l.length <= PAGE_MORE_CAP, `${status}: ${l.map((x) => x.label).join(', ')}`);
      assert.equal(new Set(l.map((x) => x.key)).size, l.length, 'no line twice');
      if (main) assert.ok(!l.some((x) => x.label === main.label), `${status}: ${main.label} is not in More as well`);
      if (status === 'completed' && !purged) assert.ok(!l.some((x) => x.key === 'open_pdf'), 'no Open the PDF next to Download');
    }
  assert.ok(most <= PAGE_MORE_CAP && most >= 7, `the busiest state has ${most} lines`);
  assert.equal(PAGE_MORE_CAP, 9);
  assert.equal(PERSON_MORE_CAP, 6);
});

// ---- 3. The page itself --------------------------------------------------------------------------------------------

test('the page draws one More, one filled button, and no row of header buttons', () => {
  const page = read(PAGE);
  assert.equal(page.match(/<MoreMenu kind="screen"/g)?.length, 1);
  assert.match(read('src/components/sender/More.tsx'), /data-more=\{kind\} aria-expanded=\{open\} aria-controls=\{open \? id : undefined\}/);
  // The main button comes from the rule, and each state's card draws that one and no other.
  assert.match(page, /const main = mainButton\(\{ status: e\.status, isTemplate: isTpl, removed: !!removed, purged: !!e\.purged_at, people \}\);/);
  const filled = noComments(page).match(/className="btn primary"/g)?.length || 0;
  // In the source: the seven shapes of the one main button, and the three of a template's card. Never two at once.
  assert.equal(filled, 10);
  assert.doesNotMatch(page, /sn-edit|Edit envelope<\/Link>|Give more time<\/button>|Send reminder/);
  // Everything the header had is reachable: the lines of More are wired to the same calls as before.
  for (const call of ['/download?inline=1`', '/evidence`', "setDialog('extend')", "clone('envelope')", "clone('template')", "setDialog('void')", "setDialog('delete')", '/restore`'])
    assert.ok(page.includes(call), call);
  // More closes on Escape and gives the keyboard back, and on a click elsewhere.
  const more = read('src/components/sender/More.tsx');
  assert.match(more, /if \(e\.key !== 'Escape'\) return;\s*setOpen\(false\);\s*button\.current\?\.focus\(\);/);
  assert.match(more, /if \(box\.current && !box\.current\.contains\(e\.target as Node\)\) setOpen\(false\);/);
  assert.match(read('src/app/styles/envelope.css'), /\.mo-line \{ display: flex; align-items: center; min-height: 44px;/);
});

test('plain words on the page: document, people, Copy, Cancel the request, History, Full record for disputes', () => {
  for (const f of [PAGE, PEOPLE, TEMPLATES, 'src/components/sender/AfterSend.tsx', 'src/components/sender/History.tsx', 'src/components/sender/More.tsx', 'src/components/sender/OwnLink.tsx', 'src/lib/envelopepage.ts', 'src/app/styles/envelope.css', 'tests/simplify-envelope.test.ts']) {
    const src = read(f);
    assert.ok(!src.includes(String.fromCharCode(0x2014)), `no em dash in ${f}`);
  }
  const shown = noComments(read(PAGE)) + noComments(read(PEOPLE));
  for (const word of [/\bVoid\b/, /\bClone\b/, /\bNudge\b/, /evidence pack/i, /Audit trail/, /'Recipients'/, />Correct</, /Download with certificate/, /Preview PDF/, /View signed PDF/])
    assert.doesNotMatch(shown, word, String(word));
  const page = read(PAGE);
  assert.match(page, /<VoidDialog title="Cancel the request" confirmLabel="Cancel the request"/);
  assert.match(page, /<h2 id="sn-rcpt-h">\{isTpl \? 'Roles' : 'People'\}<\/h2>/);
  assert.match(page, /Cancelled\. Nobody can sign it any more\./);
  // The words other screens use for the buttons of this page are the ones it has now.
  assert.match(read('src/components/editor/StepReview.tsx'), /Cancel the request, in More on its page/);
  assert.match(read('src/components/sender/Disputed.tsx'), /<b>Full record for disputes<\/b>, in More at the top of this page/);
});

test('no internet address, fingerprint or device report on the page; they stay in the full record', async () => {
  const page = noComments(read(PAGE)) + noComments(read('src/components/sender/History.tsx'));
  assert.doesNotMatch(page, /a\.ip|\.hash|user_agent|\.ip\b/);
  assert.equal(offThePage('Time zone reported'), true);
  assert.equal(offThePage('Envelope sent'), false);
  assert.equal(withoutAddresses('Opened from 203.0.113.9 and 2001:db8:0:1::2:3'), 'Opened from (address in the full record) and (address in the full record)');
  assert.equal(withoutAddresses(`File ${'a'.repeat(64)} stored`), 'File (fingerprint in the full record) stored');
  assert.equal(withoutAddresses('2 recipients, 3 pages, closes 2026-11-21 10:30'), '2 recipients, 3 pages, closes 2026-11-21 10:30', 'dates and counts are left alone');
  // On a real document: the API still gives the record whole, and what the page lists has none of it.
  const c = await signUp('Hana History', 'hana-history@example.com', ip());
  const e = await simple(c, 'sam-history@example.com');
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, 'sam-history@example.com')).status, 200);
  const data = (await c.get(`/envelopes/${e.id}`)).data;
  assert.ok(data.audit.length > 2 && data.audit.every((a: any) => /^[0-9a-f]{64}$/.test(a.hash)), 'the record keeps the fingerprint of every line');
  assert.ok(data.audit.some((a: any) => a.ip), 'and the address each thing came from');
  const lines = historyLines(data.audit, (data.deliveries || []).map((d: any) => ({ at: d.at, subject: d.subject, to_email: d.to_email, state: 'Handed to the mail server.' })));
  const text = JSON.stringify(lines);
  for (const a of data.audit) {
    assert.ok(!text.includes(a.hash), 'no fingerprint');
    if (a.ip) assert.ok(!new RegExp(`\\b${a.ip.replace(/[.:]/g, '\\$&')}\\b`).test(text), 'no address');
  }
  assert.ok(!lines.some((l) => /time zone reported/i.test(l.title)));
  // The emails are lines of the same list, each with what became of it, in the order things happened.
  assert.ok(lines.some((l) => l.mail && /^Email: /.test(l.title) && /^To sam-history@example\.com\. Handed to the mail server\.$/.test(l.detail)));
  assert.deepEqual(lines.map((l) => l.at), [...lines.map((l) => l.at)].sort());
  assert.doesNotMatch(read(PAGE), /Every email about this envelope|sn-mails/);
  // The full record is one press away, in More and under History.
  assert.equal((await c.get(`/envelopes/${e.id}/evidence`)).status, 200);
  assert.match(read('src/components/sender/History.tsx'), /are in the <a href=\{fullRecordHref\}>full record for disputes<\/a>/);
});

test('comments, history, files, details and checks are folded, and closed when the page opens', () => {
  const fold = read('src/components/sender/More.tsx');
  assert.match(fold, /<details className="card sn-fold" data-fold="" id=\{id\}>/);
  assert.doesNotMatch(fold, /<details[^>]* open/);
  const page = read(PAGE);
  assert.match(page, /<History audit=\{data\.audit\} deliveries=\{deliveries\} chain=\{data\.chain\}/);
  assert.match(page, /<Fold title="Files" count=\{nFiles\}>/);
  const comments = read('src/components/sender/Comments.tsx');
  assert.match(comments, /<details className="card sn-fold cm-card" id="comments" data-fold="" open=\{open\}/);
  assert.match(comments, /const \[open, setOpen\] = useState\(false\);/);
  // It opens by itself only for someone who came for it: the link in the email about a new comment.
  assert.match(comments, /if \(arrived && window\.location\.hash === '#comments'\) \(setOpen\(true\)/);
  // Its count, and who waits for an answer, are said on the closed line.
  assert.match(comments, /Questions and comments\{data \? ` \(\$\{threads\.length\}\)` : ''\}/);
  assert.match(comments, /<\/span>\s*\{waiting\.length > 0 && <span className="cm-tag warn">/);
  assert.doesNotMatch(comments, /className="btn primary"/, 'the page keeps one filled button when a fold is open');
  for (const f of ['src/components/sender/CustomDetails.tsx', 'src/components/sender/FileChecks.tsx']) assert.match(read(f), /data-fold=""/, f);
  // The sentence about reminders is with the files now, and still says where to change it.
  assert.match(page, /id="sn-reminders">\{reminderText\(e\.reminder_days\)\}[^\n]*To change it, choose Edit in More\./);
});

// ---- 4. People ------------------------------------------------------------------------------------------------------

test('each person is one item with one line and one More; sharing the link is one group with plain names', () => {
  const people = read(PEOPLE);
  assert.match(people, /<li key=\{r\.id\} className=\{`sn-person[^\n]*data-item="person">/);
  assert.equal(people.match(/<MorePanel /g)?.length, 1);
  assert.match(read('src/components/sender/More.tsx'), /className="btn sm mo-btn" data-more="item" aria-expanded=\{open\} aria-controls=\{open \? panelId : undefined\} aria-label=\{label\}/);
  assert.match(people, /\{line && <p className="sn-person-line">\{line\}<\/p>\}/);
  // What happened to their email, and the things to do, are inside the More and nowhere else.
  const panel = people.slice(people.indexOf('{isOpen && ('), people.indexOf('{qr === r.id'));
  for (const inside of ['<dl className="sn-facts">', 'Change person</button>', '>Copy link</button>', '>QR code</button>', '>WhatsApp</button>', '>Text</button>', 'Share the link yourself</p>', '<TryAgainButton'])
    assert.ok(panel.includes(inside) && !people.replace(panel, '').includes(inside), inside);
  // With zero setup a waiting person's More has at most six lines: Remind (two or more waiting), four ways to share, Change person.
  const zeroSetup = (panel.match(/<button className="btn sm[^\n]*/g) || []).filter((b) => !/TryAgain|code_only/.test(b));
  assert.ok(zeroSetup.length <= PERSON_MORE_CAP, `${zeroSetup.length} buttons`);
  // The reminder of one person follows the rule, names them, and is not a second "Remind" next to the main button.
  assert.match(people, /\(!remindOne \|\| remindOne\(r\)\) && <button[^\n]*>\{busy === `nudge:\$\{r\.id\}` \? 'Sending…' : `Remind \$\{r\.name\}`\}<\/button>/);
  assert.match(read(PAGE), /remindOne=\{\(r: any\) => \{ const p = people\.find\(\(x\) => x\.id === r\.id\); return !!p && personRemind\(people, main, p\); \}\}/);
  // "Sign now" is the main button for the person it belongs to, so their card does not repeat it.
  assert.match(people, /const signHere = turn && \(isMe \|\| r\.role === 'inperson'\) && r\.id !== mainPersonId;/);
  assert.doesNotMatch(people, /className="btn sm primary"/);
  // Someone whose link the sender sends has it in the open, not behind More.
  assert.ok(people.indexOf('{own && <OwnLinkActions') < people.indexOf('{isOpen && ('));
  // Escape closes a person's More and gives the keyboard back to its button, unless a dialog is on top.
  assert.match(people, /if \(ev\.key !== 'Escape' \|\| document\.querySelector\('\[role="dialog"\]'\)\) return;\s*moreBtn\.current\[more\]\?\.focus\(\);\s*setMore\(''\);/);
});

// ---- 5. Completed documents -----------------------------------------------------------------------------------------

test('a completed document has one Download: the signed PDF with its signing record. The full record is in More', async () => {
  const c = await signUp('Dora Done', 'dora-done@example.com', ip());
  const e = await simple(c, 'sam-done@example.com');
  await c.post(`/envelopes/${e.id}/send`);
  await signAll(e.id, 'sam-done@example.com');
  const data = (await c.get(`/envelopes/${e.id}`)).data;
  assert.equal(data.envelope.status, 'completed');
  const main = mainButton({ status: data.envelope.status, people: [] });
  assert.equal(main?.label, 'Download');
  // With nothing set up, the page of a completed document offers four more things, and no Keep it or Hold.
  const ret = data.retention;
  const schedule = !!ret && !!(ret.period || ret.due_at || ret.noticed_at);
  assert.equal(schedule, false, 'no deletion schedule on a new account');
  const more = pageMore({ status: 'completed', hasFiles: true, mayChange: true, main: 'download', schedule, mayKeep: !!ret?.closed_at && !!(ret.noticed_at || ret.due_at), mayHold: !!ret?.may_hold });
  assert.deepEqual(more.map((l) => l.label), ['Full record for disputes', 'Copy', 'Save as template', 'Delete']);
  // The one file: a PDF, with the pages of the signing record after the pages that were signed.
  const dl = await c.get(`/envelopes/${e.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(Buffer.from(dl.data.slice(0, 5)).toString(), '%PDF-');
  const page = read(PAGE);
  assert.match(page, /main\.kind === 'download' \? <a className="btn primary" href=\{`\/api\/envelopes\/\$\{e\.id\}\/download`\}>\{main\.label\}<\/a>/);
  // The head of the page is the title and More: nothing else can push the title onto three lines.
  const head = page.slice(page.indexOf('<div className="pagehead sn-head"'), page.indexOf('{removed && ('));
  assert.equal((head.match(/<button|<a |<MoreMenu/g) || []).length, 1);
  assert.match(read('src/app/styles/envelope.css'), /\.sn > \.pagehead\.sn-head \{ flex-wrap: nowrap;/);
  // An admin without a schedule still finds the hold, in the folded Files section, so nothing became impossible.
  assert.match(page, /!!ret\?\.may_hold && !schedule && [^\n]*onClick=\{\(\) => setKeeping\('hold'\)\}>Put on hold<\/button>/);
});

test('with a deletion schedule, the page lists Keep it and Hold for an admin, and Delete says the date', async () => {
  const c = await signUp('Rae Records', 'rae-records@example.com', ip());
  assert.equal((await c.put('/account/retention', { days: 365 })).status, 200);
  const e = await simple(c, 'sam-records@example.com');
  await c.post(`/envelopes/${e.id}/send`);
  await signAll(e.id, 'sam-records@example.com');
  const ret = (await c.get(`/envelopes/${e.id}`)).data.retention;
  assert.ok(ret.period && ret.due_at, 'the schedule reaches this document');
  const more = pageMore({ status: 'completed', hasFiles: true, mayChange: true, main: 'download', schedule: true, mayKeep: !!ret.closed_at && !ret.held && !!(ret.noticed_at || ret.due_at) && !ret.asked, mayHold: !!ret.may_hold });
  assert.deepEqual(more.map((l) => l.label), ['Full record for disputes', 'Copy', 'Save as template', 'Keep it', 'Hold', 'Delete']);
  const card = read('src/components/sender/Retention.tsx');
  // The Delete dialog says what the schedule does by itself and offers Keep it instead; removing the files for
  // good is one more step from there, for who may. The card itself has no buttons of its own for these any more.
  assert.match(card, /Your account&apos;s deletion schedule removes its contents on \{longDate\(day\)\} without you doing anything\. To stop that, keep it instead\. <button type="button" className="btn sm" onClick=\{onKeep\}>Keep it<\/button>/);
  assert.match(card, /onClick=\{onPurge\}>Remove the files for good<\/button>/);
  assert.doesNotMatch(card, />Purge now<|>Put on legal hold<|>Keep it<\/button>\}\n\s*\{r\.asked/);
  assert.match(card, /if \(!news && !\(r\.due_at && r\.period\)\) return dialogs;/, 'nothing on the page when there is nothing to say');
  assert.match(card, /<details className="card sn-fold ret" data-fold="" data-feature="ds-retention">/);
  // The hold really holds, and can be lifted from More afterwards.
  assert.equal((await c.post(`/envelopes/${e.id}/hold`, { reason: 'A case is open' })).status, 200);
  const held = (await c.get(`/envelopes/${e.id}`)).data.retention;
  const after = pageMore({ status: 'completed', hasFiles: true, mayChange: true, main: 'download', schedule: true, mayHold: !!held.may_hold, held: held.held, heldHere: held.holds.some((h: any) => h.envelope_id === e.id) });
  assert.ok(after.some((l) => l.label === 'Lift the hold') && !after.some((l) => l.label === 'Hold'));
});

// ---- 6. Templates ---------------------------------------------------------------------------------------------------

test('Templates: Use on each row, the other five in the row\'s More; a short intro; a Use dialog without the reminder paragraph', () => {
  const list = read(TEMPLATES);
  assert.match(list, /<tr data-item="template">/);
  assert.equal(list.match(/aria-label=\{`Use \$\{name\}`\}>Use<\/button>/g)?.length, 1, 'one Use, on a phone and on a desktop');
  assert.equal(list.match(/<MorePanel /g)?.length, 1);
  const panel = list.slice(list.indexOf('<div className="sn-rowmore"'), list.indexOf('</Fragment>'));
  for (const b of ['Send to many</Link>', '>Edit</Link>', '>Move</button>', '>Who can use this</button>', '>Delete</button>']) assert.ok(panel.includes(b) && !list.replace(panel, '').includes(b), b);
  assert.equal((panel.match(/<button|<Link/g) || []).length, 5);
  assert.match(list, /<div className="muted">Set a document up once, then send it again in seconds\.<\/div>/);
  assert.doesNotMatch(list, /sn-use-reminders|reminderText|only the person it belongs to or an admin can change or delete it/);
  // Who may do what is still said where it matters: on the row (its marks) and in "Who can use this".
  assert.match(list, /<AccessMarks access=\{t\.access\} \/>/);
});

test('after sending from a template the page says Sent, and the way back is Templates', async () => {
  const list = read(TEMPLATES);
  assert.match(list, /router\.push\(`\/app\/envelopes\/\$\{id\}\?sent=1&from=templates`\);/);
  assert.doesNotMatch(list, /toast\('Sent\.'\)/, 'the banner says it, so no toast says it a second time');
  const page = read(PAGE);
  assert.match(page, /setFromTemplates\(new URLSearchParams\(window\.location\.search\)\.get\('from'\) === 'templates'\)/);
  assert.match(page, /href=\{isTpl \|\| fromTemplates \? '\/app\/templates' : '\/app\/envelopes'\} className="small sn-back">← \{isTpl \|\| fromTemplates \? 'Templates' : 'Documents'\}/);
  const banner = read('src/components/sender/AfterSend.tsx');
  // The heading "Sent." (and, the first time an account sends, its picture) is drawn by SentHead in impact/SenderTrees.tsx.
  assert.match(banner, /<SentHead envelopeId=\{envelope\.id\} id="sn-sent-h" \/>/);
  assert.match(banner, /if \(q\.get\('sent'\) !== '1'\) return;/);
  // The address only chooses a label: anything else typed there changes nothing, and the link never leaves the app.
  assert.doesNotMatch(page, /href=\{[^}]*searchParams|href=\{[^}]*\.get\('from'\)\}/);
  // The same flow through the API still works as before: a draft from the template, then sent.
  const c = await signUp('Tess Template', 'tess-template@example.com', ip());
  const t = await draft(c, { kind: 'template', subject: 'Volunteer agreement', recipients: [{ id: 'r1', role: 'signer', role_name: 'Volunteer', name: '', email: '', routing_order: 1 }], fields: [{ id: 'f1', document_id: 'd1', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.25, h: 0.06 }] });
  const made = await c.post('/envelopes', { template_id: t.id, recipients: { [t.recipients[0].id]: { name: 'Vera Volunteer', email: 'vera-volunteer@example.com' } } });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const sent = await c.post(`/envelopes/${made.data.envelope.id}/send`, { send_anyway: false });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal((await c.get(`/envelopes/${made.data.envelope.id}`)).data.envelope.status, 'sent');
});

// ---- 7. Toasts ------------------------------------------------------------------------------------------------------

test('toasts sit at the bottom edge, let taps through, and the page keeps room under its last line while one shows', () => {
  const css = read('src/app/styles/envelope.css');
  assert.match(css, /\.toasts \{ bottom: 12px;/);
  assert.match(css, /body:has\(\.toasts > \.toast\) \.shell \.main \{ padding-bottom: 120px; \}/);
  assert.match(css, /body:has\(\.toasts > \.toast\) \.shell \.main \{ padding-bottom: calc\(176px \+ env\(safe-area-inset-bottom\)\); \}/, 'on a phone the room clears the bottom bar too');
  assert.match(read('src/app/globals.css'), /\.toasts \{ position: fixed; bottom: 20px;[^}]*pointer-events: none; \}/);
  assert.match(read('src/app/styles/start.css'), /body:has\(\.tabbar\) \.toasts \{ bottom: calc\(80px \+ env\(safe-area-inset-bottom\)\); \}/);
  // And it is never drawn over something a person can press: it is lifted to the nearest free band.
  const toast = { top: 780, bottom: 820, left: 20, right: 370 };
  assert.equal(toastLift(toast, [], 844), 0);
  assert.equal(toastLift(toast, [{ top: 700, bottom: 744, left: 300, right: 360 }], 844), 0, 'a button above it is not under it');
  assert.equal(toastLift(toast, [{ top: 790, bottom: 834, left: 300, right: 360 }], 844), 38, 'lifted to sit 8 px above the button');
  assert.equal(toastLift(toast, [{ top: 790, bottom: 834, left: 300, right: 360 }, { top: 730, bottom: 774, left: 30, right: 200 }], 844), 98, 'and above the next one it would have landed on');
  assert.equal(toastLift(toast, [{ top: 790, bottom: 834, left: 400, right: 460 }], 844), 0, 'a button beside it is left alone');
  assert.equal(toastLift(toast, Array.from({ length: 20 }, (_, i) => ({ top: i * 44, bottom: i * 44 + 44, left: 0, right: 390 })), 844), 0, 'a screen full of buttons: it stays at the bottom rather than jump to the middle');
  assert.match(read('src/components/ui.tsx'), /const t = plain\(el\.getBoundingClientRect\(\)\);/, 'plain boxes, or the sides of the toast are lost');
  assert.match(read('src/components/ui.tsx'), /const lift = toastLift\(t, controls, window\.innerHeight\);\s*if \(lift\) el\.style\.marginBottom = `\$\{lift\}px`;/);
  const layout = read('src/app/layout.tsx');
  assert.ok(layout.indexOf("import './styles/envelope.css';") > layout.indexOf("import './globals.css';") && layout.indexOf("import './styles/envelope.css';") < layout.indexOf("import './styles/brand.css';"));
});

// ---- 8. Nothing became impossible, and nothing here can be turned against someone ----------------------------------

test('everything the old page could do still answers: remind, more time, copy, save as template, cancel, change a person, delete', async () => {
  const c = await signUp('Nora Nothing', 'nora-nothing@example.com', ip());
  const e = await simple(c, 'sam-nothing@example.com');
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const sam = (await c.get(`/envelopes/${e.id}`)).data.envelope.recipients[0];
  assert.equal((await c.post(`/envelopes/${e.id}/remind`)).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/remind`, { recipient_id: sam.id })).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/extend`, { days: 7 })).status, 200);
  assert.ok((await c.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: sam.id })).data.url);
  assert.equal((await c.post(`/envelopes/${e.id}/correct`, { recipient_id: sam.id, name: 'Sam Signer', email: 'sam-nothing2@example.com' })).status, 200);
  const copy = await c.post(`/envelopes/${e.id}/clone`, { kind: 'envelope' });
  const tpl = await c.post(`/envelopes/${e.id}/clone`, { kind: 'template' });
  assert.ok(copy.data.id && tpl.data.id);
  assert.equal((await c.get(`/envelopes/${e.id}/evidence`)).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/void`, { reason: 'Sent the wrong version' })).status, 200);
  assert.equal((await c.call('DELETE', `/envelopes/${e.id}`)).status, 200);
});

test('a stranger gets nothing from the page\'s calls, and a member cannot hold or keep what the menu would not show them', async () => {
  const owner = await signUp('Olga Owner', 'olga-owner@example.com', ip());
  const e = await simple(owner, 'sam-owner@example.com');
  await owner.post(`/envelopes/${e.id}/send`);
  const stranger = await signUp('Stan Stranger', 'stan-stranger@example.com', ip());
  for (const [m, p] of [['GET', ''], ['GET', '/evidence'], ['GET', '/download'], ['POST', '/remind'], ['POST', '/void'], ['POST', '/clone'], ['POST', '/hold'], ['POST', '/keep'], ['DELETE', '']] as const) {
    const r = await stranger.call(m, `/envelopes/${e.id}${p}`, m === 'POST' ? { reason: 'x', kind: 'envelope' } : undefined);
    assert.ok(r.status === 404 || r.status === 403, `${m} ${p}: ${r.status}`);
  }
  // Nobody signed in: nothing either.
  const nobody = new Client();
  assert.equal((await nobody.get(`/envelopes/${e.id}`)).status, 401);
  // The menu is drawn in the browser, so the server is what decides: `from=templates` in the address is only a label.
  assert.equal((await owner.get(`/envelopes/${e.id}?from=templates&sent=1`)).status, 200);
});
