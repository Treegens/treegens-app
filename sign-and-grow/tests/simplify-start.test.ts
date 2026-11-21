// The way in, Home and navigation made simpler (brief "simplify-start", research/ux-charter.md section 7, quick wins
// 1 to 3 and 6): confirming the address with a 6-digit code in the same tab, one start button, the shorter sidebar
// and document names that read well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, mailTo, simple, signAll, samplePdf } from './helpers.ts';
import { NAV_START, NAV_MAIN, NAV_MORE, NAV_END, NAV_ENTRIES, TAB_BAR, navOn, moreFor, insideMore, moreKey } from '../src/lib/nav.ts';
import { nameFromFile } from '../src/lib/docname.ts';
import { TOTALS_FROM, totalWorthShowing } from '../src/lib/impact.ts';
import { CONFIRM_CODE_MAX_WRONG, CONFIRM_CODE_HOURS, CODE_REFUSED, cleanCode, showCode } from '../src/lib/confirm.ts';

const { db } = await boot();

// A new login that has not confirmed its address yet, in the browser it signed up in.
async function fresh(email: string, ip: string, password = 'correct horse battery') {
  const c = new Client();
  c.ip = ip;
  const r = await c.post('/auth/signup', { name: 'Rosa Gardener', email, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}
const confirmMails = (email: string) => mailTo(email).filter((m: any) => m.subject === 'Confirm your email for GrowSigning');
// The code as the person reads it in the newest confirmation email.
function codeIn(email: string): string | null {
  const html = confirmMails(email).at(-1)!.html as string;
  const m = /Your code is (\d{3}) (\d{3})\./.exec(html);
  return m ? m[1] + m[2] : null;
}
// The limit in memory on typing codes lasts a minute: this runs `fn` as if that minute had passed.
async function aMinuteLater<T>(fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + 61_000;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}
const verified = (email: string) =>!!db.get('SELECT email_verified v FROM users WHERE email=?', email).v;
// The words a person reads in an email: the text of the HTML without its tags, its style and the long link.
const wordsOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w) && !/^https?:\/\//.test(w));

test('1. the confirmation email has a 6-digit code, is 50 words or fewer, and keeps the button', async () => {
  await fresh('code.one@start.test', '198.51.100.1');
  const [mail] = confirmMails('code.one@start.test');
  const code = codeIn('code.one@start.test');
  assert.match(code!, /^\d{6}$/);
  const words = wordsOf(mail.html);
  assert.ok(words.length <= 50, `the email is ${words.length} words: ${words.join(' ')}`);
  assert.match(mail.html, /Type it where you signed up, or press the button\./);
  assert.match(mail.html, new RegExp(`It works for ${CONFIRM_CODE_HOURS} hours\\.`));
  assert.match(mail.link, /\/verify-email\?token=/, 'the button in the email still confirms');
  // No browser or password advice, no selling line in it.
  assert.doesNotMatch(mail.html, /browser|password|mangrove|every dollar/i);
  // The code is not kept in the database in a form that gives it away.
  const row = db.get("SELECT verify_code_hash h FROM users WHERE email='code.one@start.test'");
  assert.ok(row.h && !row.h.includes(code!));
});

test('1. the code typed in the tab that signed up confirms the address there and then', async () => {
  const c = await fresh('code.two@start.test', '198.51.100.2');
  assert.equal((await c.get('/me')).data.user.email_verified, false);
  // People copy it with the space, or with a dash.
  const code = codeIn('code.two@start.test')!;
  const r = await c.post('/auth/verify-code', { code: `${code.slice(0, 3)}-${code.slice(3)} ` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await c.get('/me')).data.user.email_verified, true);
  // Sending works straight away.
  assert.equal((await c.post('/auth/verify-code', { code })).status, 200, 'typing it again after it worked says it is done');
  // And the link in the same email simply says it is done too.
  const t = db.get("SELECT verify_token t FROM users WHERE email='code.two@start.test'").t;
  assert.equal((await new Client().post('/auth/verify', { token: t })).status, 200);
});

test('1. the code only works in a browser signed in to that login, never for another login', async () => {
  const victim = await fresh('code.three@start.test', '198.51.100.3');
  const code = codeIn('code.three@start.test')!;
  // Someone who is not signed in at all.
  const nobody = new Client();
  nobody.ip = '198.51.100.30';
  assert.equal((await nobody.post('/auth/verify-code', { code })).status, 401);
  // Someone signed in to another login who got hold of this code: it is bound to the login it was sent for.
  const other = await fresh('code.four@start.test', '198.51.100.4');
  const wrongLogin = await other.post('/auth/verify-code', { code });
  assert.equal(wrongLogin.status, 400);
  assert.equal(wrongLogin.data.code, 'code_wrong');
  assert.equal(verified('code.three@start.test'), false);
  assert.equal(verified('code.four@start.test'), false);
  // The person, in the browser they signed up in, can.
  assert.equal((await victim.post('/auth/verify-code', { code })).status, 200);
  assert.equal(verified('code.three@start.test'), true);
});

test('1. a new code replaces the one before; an old code says to use the newest email', async () => {
  const c = await fresh('code.five@start.test', '198.51.100.5');
  const first = codeIn('code.five@start.test')!;
  assert.equal((await c.post('/auth/resend-verification', {})).status, 200);
  const second = codeIn('code.five@start.test')!;
  assert.equal(confirmMails('code.five@start.test').length, 2);
  if (first !== second) {
    const old = await c.post('/auth/verify-code', { code: first });
    assert.equal(old.status, 400);
    assert.equal(old.data.error, CODE_REFUSED.code_wrong);
    assert.match(old.data.error, /newest email/);
  }
  assert.equal((await c.post('/auth/verify-code', { code: second })).status, 200);
});

test('1. a code runs out after a day, and "Send a new code" gives one that works', async () => {
  const c = await fresh('code.six@start.test', '198.51.100.6');
  const code = codeIn('code.six@start.test')!;
  db.run("UPDATE users SET verify_code_at=? WHERE email='code.six@start.test'", new Date(Date.now() - (CONFIRM_CODE_HOURS * 3600_000 + 60_000)).toISOString());
  const late = await c.post('/auth/verify-code', { code });
  assert.equal(late.status, 400);
  assert.equal(late.data.code, 'code_old');
  assert.match(late.data.error, /Send a new code/);
  assert.equal(db.get("SELECT verify_code_wrong n FROM users WHERE email='code.six@start.test'").n, 0, 'the right code typed late is not a wrong guess');
  await c.post('/auth/resend-verification', {});
  assert.equal((await c.post('/auth/verify-code', { code: codeIn('code.six@start.test') })).status, 200);
});

test('1. guessing is capped for good; after that only the button in the email confirms, and the email says so', async () => {
  const c = await fresh('code.seven@start.test', '198.51.100.7');
  const real = codeIn('code.seven@start.test')!;
  // A script typing codes fast is stopped after 5 in a minute, before it gets far.
  const guesses = Array.from({ length: 6 }, (_, i) => String((Number(real) + 1 + i) % 1e6).padStart(6, '0'));
  const answers = [];
  for (const g of guesses) answers.push((await c.post('/auth/verify-code', { code: g })).status);
  assert.deepEqual(answers, [400, 400, 400, 400, 400, 429]);
  assert.equal(db.get("SELECT verify_code_wrong n FROM users WHERE email='code.seven@start.test'").n, 5);
  // The cap in the database is what counts, whatever happens to the limit in memory (a restart clears it). Once it
  // is reached, the right code is refused as well.
  db.run("UPDATE users SET verify_code_wrong=? WHERE email='code.seven@start.test'", CONFIRM_CODE_MAX_WRONG);
  const after = await aMinuteLater(() => c.post('/auth/verify-code', { code: real }));
  assert.equal(after.status, 403, JSON.stringify(after.data));
  assert.equal(after.data.code, 'code_closed');
  assert.match(after.data.error, /Press the button in our email instead, in this browser\./);
  assert.equal(verified('code.seven@start.test'), false);
  // A new email then has the button and no code that would not work.
  await c.post('/auth/resend-verification', {});
  assert.equal(codeIn('code.seven@start.test'), null);
  assert.match(confirmMails('code.seven@start.test').at(-1)!.html, /Press the button to confirm your email\./);
  // The button still works in the browser that signed up.
  const t = db.get("SELECT verify_token t FROM users WHERE email='code.seven@start.test'").t;
  assert.equal((await c.post('/auth/verify', { token: t })).status, 200);
  assert.equal(verified('code.seven@start.test'), true);
});

test('1. wrong guesses are counted one by one up to the cap, and the last one says codes stopped', async () => {
  const c = await fresh('code.eight@start.test', '198.51.100.8');
  const real = codeIn('code.eight@start.test')!;
  const wrong = String((Number(real) + 500_000) % 1e6).padStart(6, '0');
  db.run("UPDATE users SET verify_code_wrong=? WHERE email='code.eight@start.test'", CONFIRM_CODE_MAX_WRONG - 2);
  const one = await c.post('/auth/verify-code', { code: wrong });
  assert.equal(one.data.code, 'code_wrong');
  const two = await c.post('/auth/verify-code', { code: wrong });
  assert.equal(two.status, 403);
  assert.equal(two.data.code, 'code_closed');
  assert.equal(db.get("SELECT verify_code_wrong n FROM users WHERE email='code.eight@start.test'").n, CONFIRM_CODE_MAX_WRONG);
  const three = await c.post('/auth/verify-code', { code: wrong });
  assert.equal(three.data.code, 'code_closed');
  assert.equal(db.get("SELECT verify_code_wrong n FROM users WHERE email='code.eight@start.test'").n, CONFIRM_CODE_MAX_WRONG, 'and nothing is counted past it');
});

test('1. typing something that is not 6 digits is said in words and costs no guess', async () => {
  const c = await fresh('code.nine@start.test', '198.51.100.9');
  for (const typed of ['', '12345', '1234567', 'abcdef', '12 34 5x']) {
    const r = await c.post('/auth/verify-code', { code: typed });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'code_format');
    assert.equal(r.data.error, 'Type the 6 digits of the code in our email.');
  }
  assert.equal(db.get("SELECT verify_code_wrong n FROM users WHERE email='code.nine@start.test'").n, 0);
  assert.equal(cleanCode(' 482 915 '), '482915');
  assert.equal(cleanCode('482-915'), '482915');
  assert.equal(showCode('482915'), '482 915');
});

test('1. a login made by an invitation or a provider that vouched needs no code; one that did not is told how it came about', async () => {
  // Already confirmed: no confirmation email at all, as before.
  const rosa = await signUp('Rosa Owner', 'rosa.owner@start.test', '198.51.100.10');
  assert.equal(confirmMails('rosa.owner@start.test').length, 1, 'signUp in the helpers confirms with the link');
  assert.equal((await rosa.post('/auth/verify-code', { code: '000000' })).status, 200, 'an address already confirmed is simply done');
  // The provider case keeps its warning, in the short email (signin.test.ts checks the sign-in itself).
  const { sendVerification } = await import('../src/server/routes-account.ts');
  const u = db.get("SELECT * FROM users WHERE email='code.nine@start.test'");
  await sendVerification(u, 'Microsoft');
  const mail = confirmMails('code.nine@start.test').at(-1)!;
  assert.match(mail.html, /Someone signed in with Microsoft and gave this address\./);
  assert.match(mail.html, /If it was not you, do not confirm/);
  assert.ok(wordsOf(mail.html).length <= 50, `${wordsOf(mail.html).length} words`);
});

test('1. the code route is named in the API description as left out on purpose, and open while a team asks for two-step login', async () => {
  const src = fs.readFileSync(new URL('../src/server/openapi.ts', import.meta.url), 'utf8');
  assert.match(src, /'\/auth\/verify-code' for the 6-digit code/);
  const spec = (await new Client().get('/openapi.json')).data;
  assert.equal(spec.paths?.['/auth/verify-code'], undefined, 'it is not part of the developer API');
  const gate = fs.readFileSync(new URL('../src/server/twostep.ts', import.meta.url), 'utf8');
  assert.match(gate, /verify-code/);
});

const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ---- 2. One start button; Home shows what was completed, with Download ----------------------------------------------

test('2. Home has no start button of its own, and the old three are gone', () => {
  const home = read('src/app/app/page.tsx');
  for (const gone of ['Send for signature', 'Send your first envelope', 'New envelope', 'Recent envelopes', 'Paper saved']) assert.ok(!home.includes(gone), gone);
  // No link that starts a document, and no filled button besides the first document that waits for the person.
  assert.equal(/href=["'{`]+\/app\/envelopes\/new/.test(home), false);
  // "Sign a document yourself" is gone too: the editor's review step reads "Sign now" when the only person is the
  // sender (the charter's order: that first, then this goes), and "Add me" in step 1 puts the sender on it.
  assert.ok(!/self=1|Sign a document yourself/.test(home));
  assert.match(read('src/components/editor/StepReview.tsx'), /'Sign now'/);
  assert.match(read('src/components/editor/StepAdd.tsx'), /Add me|Add myself/);
  assert.deepEqual(home.match(/btn[^"`]*primary/g) || [], ["btn sm${n === 0 ? ' primary"]);
  // The empty Home says where the one start button is, by its name, for a wide screen and for a phone.
  assert.match(home, /Press <b>\{NAV_START\.label\}<\/b><span className="sn-where-wide"> on the left<\/span><span className="sn-where-phone"> \(Send, in the bar at the bottom\)<\/span>/);
  // No total of paper, no fraction of a tree and no "..." while something loads.
  assert.ok(!/fmtTrees|of a tree|'…'/.test(home));
  // The shell: the one start button has a class of its own and is not a filled button of the page.
  const nav = read('src/components/AppNav.tsx');
  assert.match(nav, /<Link href=\{NAV_START\.href\} className="btn side-start"/);
  assert.equal(NAV_START.label, 'Send a document');
  assert.equal(NAV_START.href, '/app/envelopes/new');
});

test('2. Recently completed: the newest completed documents of the account, each with a Download that names it and gives the signed PDF', async () => {
  const c = await signUp('Hana Home', 'hana.home@start.test', '198.51.100.20');
  const empty = await c.get('/envelopes?box=completed&limit=5');
  assert.deepEqual(empty.data.envelopes, []);
  const first = await simple(c, 'sam.one@start.test', { subject: 'First agreement', send: true });
  const second = await simple(c, 'sam.two@start.test', { subject: 'Second agreement', send: true });
  const open = await simple(c, 'sam.three@start.test', { subject: 'Still out', send: true });
  assert.equal((await signAll(first.id, 'sam.one@start.test')).status, 200);
  assert.equal((await signAll(second.id, 'sam.two@start.test')).status, 200);
  const list = (await c.get('/envelopes?box=completed&limit=5')).data.envelopes;
  assert.deepEqual(list.map((e: any) => e.subject).sort(), ['First agreement', 'Second agreement']);
  assert.ok(!list.some((e: any) => e.id === open.id), 'a document that is still out is not listed as completed');
  for (const e of list) assert.ok(e.completed_at, 'the row has the day it was completed');
  // The Download of a row is this address.
  const home = read('src/app/app/page.tsx');
  assert.match(home, /api\('\/envelopes\?box=completed&limit=5'\)/);
  assert.match(home, /<li key=\{e\.id\} data-item="row">[\s\S]*?href=\{`\/api\/envelopes\/\$\{e\.id\}\/download`\} aria-label=\{`Download \$\{e\.subject \|\| 'the signed document'\}`\}>Download<\/a>/);
  const pdf = await c.call('GET', `/envelopes/${first.id}/download`);
  assert.equal(pdf.status, 200);
  assert.match(String(pdf.headers?.get?.('content-type') || pdf.res?.headers.get('content-type') || 'application/pdf'), /pdf/);
  // Somebody else's account gets neither the row nor the file.
  const other = await signUp('Olga Other', 'olga.other@start.test', '198.51.100.21');
  assert.deepEqual((await other.get('/envelopes?box=completed&limit=5')).data.envelopes, []);
  assert.ok([403, 404].includes((await other.call('GET', `/envelopes/${first.id}/download`)).status));
});

// ---- 3. The sidebar: nine entries, a closed More, one Help ----------------------------------------------------------

test('3. the sidebar has nine entries in the charter\'s order and words, and More holds the five that moved', () => {
  assert.equal(NAV_ENTRIES, 9);
  assert.deepEqual(NAV_MAIN.map((n) => n.label), ['Home', 'Documents', 'To sign', 'Templates', 'Contacts']);
  assert.deepEqual(NAV_MORE.map((n) => n.label), ['Send to many', 'Forms', 'Website terms', 'Reports', 'Trees planted']);
  assert.deepEqual(NAV_END.map((n) => n.label), ['Settings']);
  assert.deepEqual([...TAB_BAR], ['Home', 'Documents', 'Send', 'To sign', 'Menu']);
  // Nothing vanished: every page the old sidebar reached is still reached, and each entry has a page.
  const hrefs = [...NAV_MAIN, ...NAV_MORE, ...NAV_END].map((n) => n.href);
  assert.deepEqual([...hrefs].sort(), ['/app', '/app/agreements', '/app/bulk', '/app/contacts', '/app/envelopes', '/app/impact', '/app/inbox', '/app/powerforms', '/app/reports', '/app/settings', '/app/templates'].sort());
  for (const h of [...hrefs, NAV_START.href]) assert.ok(fs.existsSync(new URL(`../src/app${h}/page.tsx`, import.meta.url)), h);
  // The old names are not in the navigation any more.
  const drawn = read('src/components/AppShell.tsx') + read('src/components/AppNav.tsx') + read('src/lib/nav.ts');
  for (const old of ["'Envelopes'", "'Inbox'", 'Bulk send', 'PowerForms', 'Click-to-agree', 'Our impact', 'New envelope', 'Ask for help', 'Review queue']) assert.ok(!drawn.includes(old), old);
  // One Help, drawn once, after the pages.
  const shell = read('src/components/AppShell.tsx');
  assert.equal((shell.match(/<HelpChatButton/g) || []).length, 1);
  assert.match(shell, /<SideNav [^\n]*\/>\s*\{\/\*[^*]*\*\/\}\s*<HelpChatButton className="nav hc-open hc-nav">Help<\/HelpChatButton>/);
  // The phone's bar is drawn with the shell, and its Send is the same start as the sidebar's.
  assert.match(shell, /<TabBar path=\{path\} menuOpen=\{open\} onMenu=\{\(\) => setOpen\(!open\)\} \/>/);
  assert.equal((shell.match(/>Menu</g) || []).length, 0, 'one Menu on a phone: the one in the bar at the bottom');
  const nav = read('src/components/AppNav.tsx');
  assert.match(nav, /<nav className="tabbar" aria-label="Main">/);
  assert.match(nav, /className="tab-send" aria-label=\{NAV_START\.label\}/);
});

test('3. More is marked as the navigation\'s own, closed until opened, open by itself on a page inside it, remembered per person', () => {
  const nav = read('src/components/AppNav.tsx');
  assert.match(nav, /<div data-more="nav">\s*\{\/\*[^*]*\*\/\}\s*<button type="button" className="nav nav-more-toggle" aria-expanded=\{open\} aria-controls=\{listId\}/);
  assert.match(nav, /<div id=\{listId\} className="nav-more-list" hidden=\{!open\}>/);
  assert.match(nav, /const open = kept \|\| inside;/);
  assert.match(nav, /useState\(false\)/, 'closed until this browser says the person left it open');
  assert.match(nav, /localStorage\.setItem\(moreKey\(userId\), '1'\)/);
  assert.notEqual(moreKey('usr_a'), moreKey('usr_b'));
  for (const p of ['/app/bulk', '/app/bulk/blk_1', '/app/powerforms', '/app/reports', '/app/impact']) assert.equal(insideMore(p, 'member'), true, p);
  for (const p of ['/app', '/app/envelopes', '/app/envelopes/env_1', '/app/settings', '/app/inbox', '/app/bulky']) assert.equal(insideMore(p, 'owner'), false, p);
  // Website terms speak for the team's website: members do not get the entry (the page and the API refuse them too).
  assert.deepEqual(moreFor('member').map((n) => n.label), ['Send to many', 'Forms', 'Reports', 'Trees planted']);
  assert.equal(moreFor('admin').length, 5);
  assert.equal(moreFor('owner').length, 5);
  assert.equal(insideMore('/app/agreements', 'member'), false);
  assert.equal(insideMore('/app/agreements', 'admin'), true);
  // Which entry is lit.
  assert.equal(navOn('/app', '/app'), true);
  assert.equal(navOn('/app', '/app/envelopes'), false);
  assert.equal(navOn('/app/envelopes', '/app/envelopes/env_1'), true);
  assert.equal(navOn('/app/envelopes', '/app/envelopes/new'), false, 'starting a document does not light Documents');
  assert.equal(navOn('/app/inbox', '/app/inboxes'), false);
});

test('3. a member is refused Website terms by the server as well, so hiding the entry hides nothing they could use', async () => {
  const owner = await signUp('Wim Owner', 'wim.owner@start.test', '198.51.100.30');
  assert.equal((await owner.get('/clickwraps')).status, 200);
  const inv = await owner.post('/account/invites', { email: 'mia.member@start.test', role: 'member' });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  const token = db.get("SELECT token FROM invites WHERE email='mia.member@start.test'").token;
  const mia = new Client();
  mia.ip = '198.51.100.31';
  const joined = await mia.post('/auth/signup', { name: 'Mia Member', email: 'mia.member@start.test', password: 'correct horse battery', invite: token });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  assert.equal((await mia.get('/me')).data.role, 'member');
  assert.equal((await mia.get('/clickwraps')).status, 403);
});

test('3. no total of paper while it is tiny or loading: nothing stands in the sidebar until 1,000 sheets', async () => {
  assert.equal(TOTALS_FROM.sheets, 1000);
  assert.equal(TOTALS_FROM.treesPlanted, 10);
  for (const [n, shown] of [[0, false], [15, false], [999, false], [1000, true], [25000, true], [undefined, false], [null, false], ['abc', false]] as const) assert.equal(totalWorthShowing(n), shown, String(n));
  const shell = read('src/components/AppShell.tsx');
  assert.match(shell, /\{impact && totalWorthShowing\(impact\.account\.sheets\)\s*\? <div className="impact">/);
  assert.ok(!/'…'|fmtTrees|of a tree/.test(shell));
  assert.match(shell, /by our estimate/);
  // What the shell reads is there, and a new account is far under the line.
  const c = await signUp('Pia Paper', 'pia.paper@start.test', '198.51.100.32');
  const impact = (await c.get('/impact')).data;
  assert.equal(typeof impact.account.sheets, 'number');
  assert.equal(totalWorthShowing(impact.account.sheets), false);
});

// ---- 4. Document names that read well -------------------------------------------------------------------------------

test('4. a name from a file name: hyphens and underscores become spaces, a first small letter a capital, and nothing typed on purpose changes', () => {
  const cases: [string, string][] = [
    ['planting-partnership', 'Planting partnership'],
    ['planting_partnership_2026', 'Planting partnership 2026'],
    ['nda', 'Nda'],
    ['NDA-acme', 'NDA acme'],
    ['NDA', 'NDA'],
    ['iPhone-lease', 'iPhone lease'],
    ['Well-being policy', 'Well-being policy'],
    ['contract 2026-03-01', 'Contract 2026-03-01'],
    ['lease-2026-03-01', 'Lease-2026-03-01'],
    ['Agreement', 'Agreement'],
    ['  spaced   out  ', 'Spaced out'],
    ['élan-vital', 'Élan vital'],
    ['договор-аренды', 'Договор аренды'],
    ['契約書', '契約書'],
    ['___', ''],
    ['', ''],
  ];
  for (const [from, to] of cases) assert.equal(nameFromFile(from), to, from);
  // It never makes a name longer, and it adds no markup or line break of its own.
  for (const nasty of ['<b>x</b>-y', 'a‮b-c', 'x'.repeat(200)]) {
    const out = nameFromFile(nasty);
    assert.ok(out.length <= nasty.length);
    assert.equal(out.replace(/[-_ ]/g, '').toLowerCase(), nasty.replace(/[-_ ]/g, '').toLowerCase());
  }
});

test('4. an uploaded file gets the readable name, and a name the sender types is kept as typed', async () => {
  const c = await signUp('Nia Namer', 'nia.namer@start.test', '198.51.100.40');
  const up = async (fileName: string) => {
    const f = new FormData();
    f.append('file', new Blob([await samplePdf(1)], { type: 'application/pdf' }), fileName);
    const r = await c.call('POST', '/files', f);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const file = await up('planting-partnership.pdf');
  assert.equal(file.name, 'Planting partnership');
  assert.equal((await up('Agreement.pdf')).name, 'Agreement');
  assert.equal((await up('scan_0042.PDF')).name, 'Scan 0042');
  assert.equal((await up('.pdf')).name, 'Document', 'a file with no name at all is still called something');
  // The envelope's document takes the file's name unless the sender gave one, and theirs is never rewritten.
  const env = await c.post('/envelopes', { subject: 'x', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam', email: 'sam.namer@start.test' }], fields: [] });
  assert.equal(env.status, 200, JSON.stringify(env.data));
  assert.equal(env.data.envelope.documents[0].name, 'Planting partnership');
  const typed = await c.post('/envelopes', { subject: 'x', documents: [{ id: 'd', file_id: file.id, name: 'my-own_name' }], recipients: [], fields: [] });
  assert.equal(typed.data.envelope.documents[0].name, 'my-own_name');
});

test('1. an API key of the account cannot type the code: confirming is done by the person, in their own signed-in browser', async () => {
  // An owner whose address is confirmed makes a key; then the address counts as unconfirmed again, as for a login
  // that changed nothing else, and the key tries the code that the browser would be allowed to use.
  const owner = await signUp('Kay Keyholder', 'kay.key@start.test', '198.51.100.50');
  const made = await owner.post('/api-keys', { name: 'integration' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const { newConfirmCode } = await import('../src/server/confirmcode.ts');
  const u = db.get("SELECT id FROM users WHERE email='kay.key@start.test'");
  db.run('UPDATE users SET email_verified=0 WHERE id=?', u.id);
  const code = newConfirmCode(u.id)!;
  const byKey = new Client();
  byKey.ip = '198.51.100.51';
  const r = await byKey.call('POST', '/auth/verify-code', { code }, { authorization: `Bearer ${made.data.key}` });
  assert.ok([401, 403].includes(r.status), `${r.status} ${JSON.stringify(r.data)}`);
  assert.equal(verified('kay.key@start.test'), false);
  assert.equal(db.get('SELECT verify_code_wrong n FROM users WHERE id=?', u.id).n, 0, 'and it costs the person no guess');
  assert.equal((await owner.post('/auth/verify-code', { code })).status, 200);
  assert.equal(verified('kay.key@start.test'), true);
});
