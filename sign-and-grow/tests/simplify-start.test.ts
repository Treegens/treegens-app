// The way in, Home and navigation made simpler (brief "simplify-start", research/ux-charter.md section 7, quick wins
// 1 to 3 and 6): confirming the address with a 6-digit code in the same tab, one start button, the shorter sidebar
// and document names that read well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, mailTo } from './helpers.ts';
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
