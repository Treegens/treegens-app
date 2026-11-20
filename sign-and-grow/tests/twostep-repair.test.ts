// Repairs of two-step login after the skeptic's report (research/verify-new.json, "verify:twostep"), with the owner's
// decisions: nothing but the person with a code, an admin reset or the reset by email weakens two-step login; the
// reset by email needs the password, waits 7 days, is emailed daily with a stop link and shown on every page, and
// stops at any sign-in with the second step; a switch turns it off; an admin resets only members this team speaks
// for alone; wrong codes never lock anyone else out and cannot be raced; no API key reads or changes any of it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { boot, Client, signUp, mailTo } from './helpers.ts';
import { totp, fromBase32, stepAt } from '../src/server/twostep.ts';
import { TWO_STEP_TRIES, TWO_STEP_EMAIL_RESET_DAYS, TWO_STEP_RESET_BLOCK_DAYS, TWO_STEP_LOST_PER_DAY, TWO_STEP_LOST, TWO_STEP_EMAIL_RESET_RISK } from '../src/lib/policy.ts';

const G = { id: 'two-step-repair.apps.google.test', secret: 'google-secret' };
Object.assign(process.env, { GOOGLE_CLIENT_ID: G.id, GOOGLE_CLIENT_SECRET: G.secret });
const { db, cron } = await boot();
const { handle } = await import('../src/server/router.ts');
const PW = 'correct horse battery';

// The clock, as the authenticator app and the server both read it. A code works once, so `code` moves this clock on
// to the next 30 seconds when the last code of a secret was of this step, as a person would wait for the next one.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
after(() => {
  Date.now = realNow;
});
const usedStep = new Map<string, number>();
function code(secret: string): string {
  const last = usedStep.get(secret);
  if (last !== undefined && last >= stepAt()) skew += (last - stepAt() + 1) * 30_000;
  usedStep.set(secret, stepAt());
  return totp(fromBase32(secret));
}
const iso = (ms: number) => new Date(ms).toISOString();
// The server's now() reads the real clock (new Date()), so times written into the database for it do too.
const ago = (ms: number) => iso(realNow() - ms);

let n = 0;
const browser = (ip?: string) => {
  const c = new Client();
  c.ip = ip || `198.51.${Math.floor(n / 250) + 20}.${(n++ % 250) + 1}`;
  return c;
};
const person = async (name: string) => {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${n}@example.com`;
  const c = await signUp(name, email, `198.19.${Math.floor(n / 250)}.${(n++ % 250) + 1}`);
  return { c, email, id: db.get('SELECT id FROM users WHERE email=?', email).id as string };
};
async function switchOn(c: Client): Promise<{ secret: string; codes: string[] }> {
  const s = await c.post('/me/two-step/setup', { password: PW });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const r = await c.post('/me/two-step/confirm', { code: code(s.data.secret) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { secret: s.data.secret, codes: r.data.codes };
}
const signedIn = (c: Client) => !!c.cookies.ts_session;
const password = async (email: string, pw = PW, c = browser()) => ({ c, r: await c.post('/auth/login', { email, password: pw }) });
async function fullSignIn(email: string, secret: string, extra: any = {}, c = browser()) {
  const { r } = await password(email, PW, c);
  assert.equal(r.data.two_step, true, JSON.stringify(r.data));
  const done = await c.post('/auth/two-step', { code: code(secret), ...extra });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return { c, done };
}
const lostLink = (email: string) => mailTo(email).filter((m) => m.subject === 'Reset two-step login of your GrowSigning login');
const tokenOf = (m: any, key = 'token') => new URL(m.link).searchParams.get(key)!;
const user = (id: string) => db.get('SELECT * FROM users WHERE id=?', id);
// Two-step login as an older version could leave it: switched on for a login whose address nobody confirmed.
function legacyTwoStep(userId: string): string {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  db.run('UPDATE users SET two_step_secret=?, two_step_on_at=?, two_step_codes=? WHERE id=?', secret, iso(realNow()), '[]', userId);
  return secret;
}
async function unconfirmed(name: string, email: string) {
  const c = browser();
  assert.equal((await c.post('/auth/signup', { name, email, password: PW })).status, 200);
  return { c, email, id: db.get('SELECT id FROM users WHERE email=?', email).id as string };
}
// Starts a reset by email the way the person does: password, "I lost my phone", the link, the button.
async function startReset(email: string) {
  const { c } = await password(email);
  assert.deepEqual((await c.post('/auth/two-step/lost', {})).data, { ok: true });
  const r = await browser().post('/auth/two-step/email-reset', { token: tokenOf(lostLink(email).at(-1)) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

// A stand-in for Google, as in tests/twostep.test.ts, answering only its own hosts. fetch is restored afterwards.
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (v: any) => Buffer.from(JSON.stringify(v)).toString('base64url');
const idTokens = new Map<string, string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = new URL(String(url));
  if (u.host !== 'oauth2.googleapis.com' && u.host !== 'www.googleapis.com') return realFetch(url, init);
  const out = (x: any, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/oauth2/v3/certs') return out({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
  const p = Object.fromEntries(new URLSearchParams(String(init.body)));
  const t = idTokens.get(p.code);
  idTokens.delete(p.code);
  return t ? out({ access_token: 'x', token_type: 'Bearer', id_token: t }) : out({ error: 'invalid_grant' }, 400);
}) as any;
after(() => {
  globalThis.fetch = realFetch;
});
async function go(c: Client, url: string) {
  const res = await handle(new Request(`http://test.local/api${url}`, { headers: { cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': c.ip } }));
  for (const ck of res.headers.getSetCookie()) {
    const [kv] = ck.split(';');
    c.cookies[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  }
  return { status: res.status, location: res.headers.get('location') || '' };
}
async function withGoogle(c: Client, email: string, sub: string) {
  const start = await go(c, '/auth/google/start');
  const auth = new URL(start.location);
  const t = Math.floor(realNow() / 1000);
  const claims = { iss: 'https://accounts.google.com', aud: G.id, azp: G.id, nonce: auth.searchParams.get('nonce'), iat: t, exp: t + 3600, sub, email, email_verified: true, name: 'Someone With Gmail' };
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const body = b64(claims);
  const jwt = `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.privateKey).toString('base64url')}`;
  const ca = `code-${crypto.randomBytes(6).toString('hex')}`;
  idTokens.set(ca, jwt);
  return go(c, `/auth/google/callback?${new URLSearchParams({ code: ca, state: auth.searchParams.get('state')! })}`);
}

// ---- High: an unconfirmed address, a password reset and Google never take two-step login away -----------------

test('two-step login can only be switched on for a confirmed address', async () => {
  const v = await unconfirmed('Una Unconfirmed', `una.${n++}@example.com`);
  const s = await v.c.post('/me/two-step/setup', { password: PW });
  assert.equal(s.status, 409);
  assert.equal(s.data.code, 'confirm_first');
  assert.match(s.data.error, /^Confirm your email address first, then switch two-step login on\./);
  assert.equal(user(v.id).two_step_new_secret, null, 'no secret was even made');
  // Confirmed in the same browser: now it works.
  assert.equal((await v.c.post('/auth/verify', { token: user(v.id).verify_token })).status, 200);
  await switchOn(v.c);
  assert.ok(user(v.id).two_step_on_at);
});

test('a password reset by email of an unconfirmed login keeps two-step login, and the code is still asked (probe A)', async () => {
  const v = await unconfirmed('Ann Old', `ann.old.${n++}@example.com`);
  const secret = legacyTwoStep(v.id);
  const before = mailTo(v.email).length;
  await browser().post('/auth/forgot', { email: v.email });
  const r = await browser().post('/auth/reset', { token: tokenOf(mailTo(v.email).filter((m) => /password/i.test(m.subject)).at(-1)) , password: 'thief password 1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.two_step, true, 'the reset page says the code is asked for next');
  assert.ok(user(v.id).two_step_on_at, 'two-step login is still on');
  assert.equal(signedIn(v.c) && (await v.c.get('/envelopes')).status, 401, 'the browsers that were in are out, as before');
  const { c, r: inn } = await password(v.email, 'thief password 1');
  assert.equal(inn.data.two_step, true);
  assert.equal(signedIn(c), false, 'no session without the code');
  assert.ok(!mailTo(v.email).slice(before).some((m) => /two-step login.*off|switched off/i.test(m.subject)));
  // The owner with the phone gets in with the code.
  usedStep.delete(secret);
  assert.equal((await c.post('/auth/two-step', { code: code(secret) })).status, 200);
});

test('Google for an unconfirmed login with two-step login connects, cuts and confirms nothing before the code (probe B)', async () => {
  const email = `gus.${n++}@gmail.com`;
  const v = await unconfirmed('Gus Gmail', email);
  const secret = legacyTwoStep(v.id);
  const hash = user(v.id).password_hash;
  const b = browser();
  const back = await withGoogle(b, email, `thief-sub-${n}`);
  assert.equal(back.location, 'http://test.local/login/two-step');
  assert.equal(signedIn(b), false);
  assert.equal(db.all('SELECT 1 FROM identities WHERE user_id=?', v.id).length, 0, 'nothing connected');
  assert.equal(user(v.id).password_hash, hash, 'the password stays');
  assert.equal(user(v.id).email_verified, 0, 'nothing confirmed');
  assert.ok(user(v.id).two_step_on_at, 'two-step login is still on');
  assert.ok(signedIn(v.c), 'and the browser that was in stays in');
  // With the code, all of it happens, as it did before for a login without two-step login.
  usedStep.delete(secret);
  const done = await b.post('/auth/two-step', { code: code(secret) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.linked, 'Google');
  assert.equal(done.data.reclaimed, 'password');
  assert.equal(db.all('SELECT 1 FROM identities WHERE user_id=?', v.id).length, 1);
  assert.ok(signedIn(b));
});

test('Google with only the mailbox: no connection before the code, and "I lost my phone" needs the password (probe C)', async () => {
  const email = `vera.${n++}@gmail.com`;
  const v = await signUp('Vera Verified', email, `198.19.200.${n % 250}`);
  const id = db.get('SELECT id FROM users WHERE email=?', email).id;
  const { secret } = await switchOn(v);
  const b = browser();
  const back = await withGoogle(b, email, `thief-sub-${n}`);
  assert.equal(back.location, 'http://test.local/login/two-step');
  assert.equal(db.all('SELECT 1 FROM identities WHERE user_id=?', id).length, 0, 'no way in was added before the code');
  assert.ok(!mailTo(email).some((m) => /can now open your GrowSigning login/.test(m.subject)), 'nothing announced either');
  const screen = (await b.get('/auth/two-step')).data;
  assert.equal(screen.password_asked, true, 'the second screen asks for the password before a reset by email');
  // Without the password, or with a wrong one: the same answer, and nothing is emailed.
  const before = lostLink(email).length;
  assert.deepEqual((await b.post('/auth/two-step/lost', {})).data, { ok: true });
  assert.deepEqual((await b.post('/auth/two-step/lost', { password: 'a guess' })).data, { ok: true });
  assert.equal(lostLink(email).length, before);
  // With the right one, the link goes to the mailbox, and its words are true: the password was typed.
  assert.deepEqual((await b.post('/auth/two-step/lost', { password: PW })).data, { ok: true });
  assert.equal(lostLink(email).length, before + 1);
  assert.match(lostLink(email).at(-1)!.html, /Someone who typed the right password/);
  // The owner, with the code: now Google is connected and they are told.
  const done = await b.post('/auth/two-step', { code: code(secret) });
  assert.equal(done.status, 200);
  assert.equal(done.data.linked, 'Google');
  assert.equal(db.all('SELECT 1 FROM identities WHERE user_id=?', id).length, 1);
  assert.ok(mailTo(email).some((m) => m.subject === 'Google can now open your GrowSigning login'));
});

test('the reset by email under Settings asks for the password too', async () => {
  const { c } = await person('Sid Settings');
  await switchOn(c);
  const none = await c.post('/me/two-step/lost', {});
  assert.equal(none.status, 403);
  assert.equal(none.data.code, 'password_needed');
  assert.equal((await c.post('/me/two-step/lost', { password: 'wrong one' })).status, 403);
  const ok = await c.post('/me/two-step/lost', { password: PW });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.what, 'link');
});

// ---- The reset by email, as decided ------------------------------------------------------------------------------

test(`the reset by email waits ${TWO_STEP_EMAIL_RESET_DAYS} days, every email has a stop link that works signed out, and every signed-in browser is told`, async () => {
  const { c, email, id } = await person('Rosa Reset');
  const { secret } = await switchOn(c);
  const other = (await fullSignIn(email, secret)).c;
  const started = await startReset(email);
  assert.ok(Math.abs(Date.parse(started.takes_effect_at) - (Date.now() + TWO_STEP_EMAIL_RESET_DAYS * 864e5)) < 60_000);
  assert.equal(TWO_STEP_EMAIL_RESET_DAYS, 7);
  // Every browser that is signed in sees it on GET /me, which every page of the app reads (AppShell).
  for (const b of [c, other]) assert.equal((await b.get('/me')).data.two_step.reset_at, started.takes_effect_at);
  const first = mailTo(email).find((m) => m.subject === 'Two-step login of your GrowSigning login will be switched off')!;
  assert.match(first.link, /\/two-step-reset\?stop=/, 'the start email carries a stop link');
  // A day later: the reminder, with a stop link of its own.
  db.run('UPDATE users SET two_step_reset_noticed_at=? WHERE id=?', ago(24 * 3600_000), id);
  await cron.tick();
  const daily = mailTo(email).filter((m) => /^Reminder: two-step login of your GrowSigning login goes off in 7 days/.test(m.subject));
  assert.equal(daily.length, 1);
  assert.match(daily[0].link, /\/two-step-reset\?stop=/);
  assert.notEqual(tokenOf(daily[0], 'stop'), tokenOf(first, 'stop'));
  // A mail program that opens the link stops nothing: only the button on the page (a POST) does. Without signing in.
  const stop = await browser().post('/auth/two-step/email-reset/stop', { token: tokenOf(daily[0], 'stop') });
  assert.equal(stop.status, 200, JSON.stringify(stop.data));
  assert.equal(stop.data.stopped, true);
  assert.equal(user(id).two_step_reset_at, null);
  assert.ok(mailTo(email).some((m) => m.subject === 'The reset of your two-step login was stopped' && /with the link in one of our emails/.test(m.html)));
  // Every stop link of that reset is spent now.
  assert.equal((await browser().post('/auth/two-step/email-reset/stop', { token: tokenOf(first, 'stop') })).status, 410);
  assert.equal((await c.get('/me')).data.two_step.reset_at, null);
});

test(`a stopped reset cannot be asked for again for ${TWO_STEP_RESET_BLOCK_DAYS} days, unless the person signs in with the second step`, async () => {
  const { c, email, id } = await person('Bo Blocked');
  const { secret } = await switchOn(c);
  await startReset(email);
  assert.equal((await c.post('/me/two-step/reset/stop')).data.stopped, true);
  assert.ok(user(id).two_step_reset_stopped_at);
  // Asked for again: the answer on the second screen is the same, but the email says it has to wait, with no link.
  const links = lostLink(email).length;
  const { c: b } = await password(email);
  assert.deepEqual((await b.post('/auth/two-step/lost', {})).data, { ok: true });
  assert.equal(lostLink(email).length, links);
  assert.ok(mailTo(email).some((m) => m.subject === 'A reset of your two-step login cannot start yet'));
  // A link sent before the stop does not start one either.
  const inSettings = await c.post('/me/two-step/lost', { password: PW });
  assert.equal(inSettings.data.what, 'blocked');
  // A sign-in with the code ends the wait.
  await fullSignIn(email, secret);
  db.run("DELETE FROM two_step_log WHERE user_id=? AND what='lost_asked'", id);
  assert.equal(user(id).two_step_reset_stopped_at, null);
  assert.equal((await c.post('/me/two-step/lost', { password: PW })).data.what, 'link');
  // And after the days have passed, too.
  await startReset(email);
  await c.post('/me/two-step/reset/stop');
  db.run('UPDATE users SET two_step_reset_stopped_at=? WHERE id=?', ago(TWO_STEP_RESET_BLOCK_DAYS * 864e5 + 1000), id);
  db.run("DELETE FROM two_step_log WHERE user_id=? AND what='lost_asked'", id);
  assert.equal((await c.post('/me/two-step/lost', { password: PW })).data.what, 'link');
});

test('only one reset waits at a time, and a link opened while one is under way changes nothing', async () => {
  const { c, email, id } = await person('Olga Once');
  await switchOn(c);
  // Two links asked for before either was opened: the newer one replaces the older.
  const { c: b } = await password(email);
  await b.post('/auth/two-step/lost', {});
  const older = lostLink(email).at(-1)!;
  await b.post('/auth/two-step/lost', {});
  const newer = lostLink(email).at(-1)!;
  assert.equal((await browser().post('/auth/two-step/email-reset', { token: tokenOf(older) })).status, 410);
  const r = await browser().post('/auth/two-step/email-reset', { token: tokenOf(newer) });
  assert.equal(r.status, 200);
  const at = user(id).two_step_reset_at;
  // Asked for once more while it is under way: no new link, an email that says so, the date unchanged.
  db.run("DELETE FROM two_step_log WHERE user_id=? AND what='lost_asked'", id);
  const links = lostLink(email).length;
  assert.equal((await c.post('/me/two-step/lost', { password: PW })).data.what, 'under_way');
  assert.equal(lostLink(email).length, links);
  assert.ok(mailTo(email).some((m) => m.subject === 'A reset of your two-step login is already under way'));
  assert.equal(user(id).two_step_reset_at, at);
});

test(`at most ${TWO_STEP_LOST_PER_DAY} emails a day about a lost phone, and the answer on the second screen never changes`, async () => {
  const { c, email, id } = await person('Flo Flood');
  await switchOn(c);
  const { c: b } = await password(email);
  const before = mailTo(email).length;
  for (let i = 0; i < TWO_STEP_LOST_PER_DAY + 2; i++) assert.deepEqual((await b.post('/auth/two-step/lost', {})).data, { ok: true });
  assert.equal(mailTo(email).length - before, TWO_STEP_LOST_PER_DAY, 'no flood');
  // Signed in, the person is told plainly.
  const more = await c.post('/me/two-step/lost', { password: PW });
  assert.equal(more.status, 429);
  assert.equal(more.data.code, 'lost_limit');
  assert.match(more.data.error, /3 times in the last day already, so nothing more was sent/);
  // After a day, again.
  db.run("UPDATE two_step_log SET at=? WHERE user_id=? AND what='lost_asked'", ago(864e5 + 1000), id);
  assert.equal((await c.post('/me/two-step/lost', { password: PW })).status, 200);
});

test('a sign-in on a remembered device stops a reset under way, and says so (probe D)', async () => {
  const { c, email, id } = await person('Remy Remember');
  const { secret } = await switchOn(c);
  const dev = (await fullSignIn(email, secret, { remember: true })).c;
  await dev.post('/auth/logout');
  // Someone with the password and the mailbox starts the reset.
  await startReset(email);
  assert.ok(user(id).two_step_reset_at);
  // The owner signs in on the remembered laptop, as every day.
  const r = await dev.post('/auth/login', { email, password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(signedIn(dev));
  assert.equal(r.data.reset_stopped, true, 'the first screen can say it');
  assert.equal(user(id).two_step_reset_at, null);
  assert.ok(mailTo(email).some((m) => m.subject === 'The reset of your two-step login was stopped' && /remembered for it/.test(m.html)));
  assert.equal(user(id).two_step_reset_stopped_at, null, 'a sign-in with the second step leaves no wait');
});

test('a lost phone that is still signed in can be put out with "Forgot password", and the reset goes on', async () => {
  const { c: phone, email, id } = await person('Lia Lost');
  await switchOn(phone);
  await startReset(email);
  // Whoever has the phone could press Stop. The owner chooses a new password by email first, as the words advise.
  assert.match(TWO_STEP_LOST.join(' '), /choose a new password first with "Forgot password" on the sign-in page: that signs out every browser/);
  await browser().post('/auth/forgot', { email });
  await browser().post('/auth/reset', { token: tokenOf(mailTo(email).filter((m) => /Reset your GrowSigning password/.test(m.subject)).at(-1)), password: 'owner new password' });
  assert.equal((await phone.post('/me/two-step/reset/stop')).status, 401, 'the phone is signed out and cannot stop it');
  assert.ok(user(id).two_step_reset_at, 'the reset is still under way');
});

test('a password change while signed in stops a reset under way', async () => {
  const { c, email, id } = await person('Pat Password');
  const { secret } = await switchOn(c);
  await startReset(email);
  assert.equal((await c.post('/me/password', { current: PW, password: 'a new password 2', code: code(secret) })).status, 200);
  assert.equal(user(id).two_step_reset_at, null);
  assert.ok(mailTo(email).some((m) => m.subject === 'The reset of your two-step login was stopped' && /login was changed in a browser that is signed in to it/.test(m.html)));
});

test('when the days have passed it takes effect, and every browser is signed out so the owner notices', async () => {
  const { c, email, id } = await person('Tom Took');
  const { secret } = await switchOn(c);
  const other = (await fullSignIn(email, secret)).c;
  await startReset(email);
  db.run('UPDATE users SET two_step_reset_at=? WHERE id=?', ago(1000), id);
  assert.equal((await cron.tick()).two_step.switched_off, 1);
  for (const b of [c, other]) assert.equal((await b.get('/envelopes')).status, 401);
  const mail = mailTo(email).find((m) => m.subject === 'Two-step login of your GrowSigning login is off')!;
  assert.match(mail.html, /every browser that was signed in was signed out/);
  assert.equal(user(id).two_step_on_at, null);
});

test('"Allow a reset by email": on by default, needs a code to change, and switched off there is no link', async () => {
  const { c, email, id } = await person('Ali Allow');
  const { secret } = await switchOn(c);
  const d = (await c.get('/me/two-step')).data;
  assert.deepEqual([d.email_reset.allowed, d.email_reset.admins_can], [true, false], 'on by default; this owner has no admin to ask');
  // A link asked for before the switch goes off stops working with it.
  const { c: b } = await password(email);
  await b.post('/auth/two-step/lost', {});
  const old = lostLink(email).at(-1)!;
  assert.equal((await c.post('/me/two-step/email-reset', { allowed: false })).data.code, 'code_needed');
  const off = await c.post('/me/two-step/email-reset', { allowed: false, code: code(secret) });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal((await c.get('/me/two-step')).data.email_reset.allowed, false);
  assert.ok(mailTo(email).some((m) => m.subject === 'The reset by email of your two-step login is off' && /nobody can switch your second step off/.test(m.html)));
  assert.equal((await browser().post('/auth/two-step/email-reset', { token: tokenOf(old) })).status, 410);
  // Lost phone now: the same answer on the second screen, and an email that says what is left. No link.
  const links = lostLink(email).length;
  const { c: x } = await password(email);
  assert.deepEqual((await x.post('/auth/two-step/lost', {})).data, { ok: true });
  assert.equal(lostLink(email).length, links);
  assert.ok(mailTo(email).some((m) => m.subject === 'Getting back into your GrowSigning login without your phone' && /You switched the reset by email off/.test(m.html)));
  assert.equal((await c.post('/me/two-step/lost', { password: PW })).data.what, 'nobody');
  // On again, with a code.
  assert.equal((await c.post('/me/two-step/email-reset', { allowed: true, code: code(secret) })).status, 200);
  assert.equal(user(id).two_step_email_reset_off, null);
  // A reset under way stops when it is switched off.
  db.run("DELETE FROM two_step_log WHERE user_id=? AND what='lost_asked'", id);
  await startReset(email);
  await c.post('/me/two-step/email-reset', { allowed: false, code: code(secret) });
  assert.equal(user(id).two_step_reset_at, null);
});

// ---- Wrong codes: nobody locks anyone else out, and no extra tries at the same moment ------------------------------

test('someone who does not know the password cannot pause the owner, and is answered as if they did (probe I)', async () => {
  const { c, email, id } = await person('Lou Locked');
  const { secret } = await switchOn(c);
  const before = mailTo(email).length;
  const stranger = browser();
  const right = browser();
  await stranger.post('/auth/login', { email, password: 'no idea' });
  await right.post('/auth/login', { email, password: PW });
  // The same words and the same count for both, try after try, until both are paused.
  for (let i = 0; i < TWO_STEP_TRIES; i++) {
    const a = await stranger.post('/auth/two-step', { code: '000000' });
    const b = await right.post('/auth/two-step', { code: '000000' });
    assert.deepEqual([a.status, a.data.code, a.data.tries_left], [b.status, b.data.code, b.data.tries_left]);
    assert.equal(a.data.error, b.data.error);
  }
  // That paused the login (the right password came first). Wait it out, and now only the stranger tries.
  db.run('UPDATE users SET two_step_paused_until=? WHERE id=?', ago(1000), id);
  db.run('DELETE FROM two_step_tries WHERE user_id=?', id);
  const mails = mailTo(email).length;
  for (let round = 0; round < 3; round++) {
    await stranger.post('/auth/login', { email, password: 'no idea' });
    let last: any;
    for (let i = 0; i < TWO_STEP_TRIES; i++) last = await stranger.post('/auth/two-step', { code: '000000' });
    assert.equal(last.status, 429, 'the stranger is paused, in the same words');
    assert.equal(last.data.code, 'two_step_paused');
    // The owner, from another address, with the right password and the right code: in, every round.
    const { c: o } = await password(email);
    assert.equal((await o.post('/auth/two-step', { code: code(secret) })).status, 200, `round ${round + 1}`);
    db.run("DELETE FROM two_step_tries WHERE key LIKE 'ip:%' AND user_id=?", id);
  }
  assert.equal(mailTo(email).slice(mails).filter((m) => /Wrong codes/.test(m.subject)).length, 0, 'and no email flood for what a stranger did');
  assert.ok(mailTo(email).length - before >= 1);
});

test('on the same network as the stranger, the owner still gets in with the right code, and a recovery code works too', async () => {
  const { c, email } = await person('Nia Network');
  const { secret, codes } = await switchOn(c);
  const ip = '203.0.113.77';
  const stranger = browser(ip);
  await stranger.post('/auth/login', { email, password: 'wrong' });
  for (let i = 0; i < TWO_STEP_TRIES; i++) await stranger.post('/auth/two-step', { code: '111111' });
  const owner = browser(ip);
  const shown = (await owner.post('/auth/login', { email, password: PW })).data;
  assert.ok(shown.paused_until, 'the second screen says that this address is paused');
  // A wrong code is answered as the stranger was: paused. The right one gets through.
  assert.equal((await owner.post('/auth/two-step', { code: '222222' })).status, 429);
  assert.equal((await owner.post('/auth/two-step', { code: codes[0] })).status, 200, 'a recovery code');
  const again = browser(ip);
  await again.post('/auth/login', { email, password: PW });
  assert.equal((await again.post('/auth/two-step', { code: code(secret) })).status, 200, 'the code from the app');
});

test('after the right password five wrong codes pause the login for everyone, and the owner is emailed once a day at most', async () => {
  const { c, email, id } = await person('Kit Known');
  const { secret } = await switchOn(c);
  for (let round = 0; round < 2; round++) {
    const { c: t } = await password(email);
    let last: any;
    for (let i = 0; i < TWO_STEP_TRIES; i++) last = await t.post('/auth/two-step', { code: '333333' });
    assert.equal(last.status, 429);
    // Every browser with the right password waits, also with the right code.
    const { c: o } = await password(email);
    assert.equal((await o.post('/auth/two-step', { code: code(secret) })).status, 429);
    db.run('UPDATE users SET two_step_paused_until=? WHERE id=?', ago(1000), id);
  }
  const mail = mailTo(email).filter((m) => m.subject === 'Wrong codes were typed for your GrowSigning login');
  assert.equal(mail.length, 1, 'one email, though it happened twice');
  assert.match(mail[0].html, /They came after your correct password/);
  assert.equal(db.all("SELECT 1 FROM two_step_log WHERE user_id=? AND what='paused'", id).length, 2, 'Settings lists both');
});

test('many wrong codes sent at the same moment get no more than five tries', async () => {
  const { c, email, id } = await person('Ray Race');
  const { secret } = await switchOn(c);
  const tries = await Promise.all(Array.from({ length: 8 }, async () => {
    const { c: b } = await password(email);
    return b.post('/auth/two-step', { code: '444444' });
  }));
  const counts = tries.reduce((m: any, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  assert.deepEqual(counts, { 401: TWO_STEP_TRIES - 1, 429: 8 - (TWO_STEP_TRIES - 1) });
  assert.ok(user(id).two_step_paused_until > new Date().toISOString());
  const { c: o } = await password(email);
  assert.equal((await o.post('/auth/two-step', { code: code(secret) })).status, 429, 'the pause holds for the right code too');
  assert.equal(mailTo(email).filter((m) => /Wrong codes/.test(m.subject)).length, 1);
});

test('a pause from signing in never stops the owner, signed in, from changing the password someone else knows', async () => {
  const { c, email, id } = await person('Hal Hold');
  const { secret } = await switchOn(c);
  const { c: t } = await password(email);
  for (let i = 0; i < TWO_STEP_TRIES; i++) await t.post('/auth/two-step', { code: '555555' });
  assert.ok(user(id).two_step_paused_until > new Date().toISOString());
  const ch = await c.post('/me/password', { current: PW, password: 'owner new password', code: code(secret) });
  assert.equal(ch.status, 200, JSON.stringify(ch.data));
  // Under Settings the tries are this browser's own: five wrong ones pause changes here, in words.
  let last: any;
  for (let i = 0; i < TWO_STEP_TRIES; i++) last = await c.post('/me/two-step/recovery-codes', { code: '666666' });
  assert.equal(last.status, 429);
  assert.match(last.data.error, /^5 wrong codes in a row were typed in this browser, so changes here that need a code are paused/);
});

// ---- Admin reset, as decided ---------------------------------------------------------------------------------------

test('an admin resets only a member this team speaks for alone, after their own code, and the email keeps no address (probes E and O)', async () => {
  const boss = await person('Bea Team');
  const bossStep = await switchOn(boss.c);
  const acc = db.get("SELECT account_id a FROM memberships WHERE user_id=? AND role='owner'", boss.id).a;
  const ada = await person('Ada Admin');
  const owen = await person('Owen Owner'); // owns the workspace he signed up with
  const ivy = await person('Ivy Invited'); // only on this team, as if she had joined from the invitation
  const amy = await person('Amy Elsewhere'); // only a member here, but an admin of another team
  for (const [p, role] of [[ada, 'admin'], [owen, 'member'], [ivy, 'member'], [amy, 'member']] as const) db.run('INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,?,?)', acc, p.id, role, iso(Date.now()));
  db.run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES ((SELECT account_id FROM memberships WHERE user_id=? AND role='owner'), ?, 'admin', ?)", owen.id, amy.id, iso(Date.now()));
  for (const p of [ada, owen, ivy, amy]) assert.equal((await p.c.post('/auth/switch', { account_id: acc })).status, 200);
  for (const p of [ivy, amy]) db.run("DELETE FROM accounts WHERE id IN (SELECT account_id FROM memberships WHERE user_id=? AND role='owner')", p.id);
  for (const p of [owen, ivy, amy]) await switchOn(p.c);
  const card = (await ada.c.get('/account/two-step')).data.members;
  const row = (p: any) => card.find((m: any) => m.id === p.id);
  assert.deepEqual([row(owen).can_reset, row(owen).only_by_email], [false, true]);
  assert.deepEqual([row(amy).can_reset, row(amy).only_by_email], [false, true]);
  assert.deepEqual([row(ivy).can_reset, row(ivy).only_by_email], [true, false]);
  // Owen owns a workspace: nobody here may open it by switching his second step off.
  const e = await ada.c.post(`/account/members/${owen.id}/two-step/reset`, {});
  assert.equal(e.status, 403);
  assert.equal(e.data.code, 'admin_elsewhere');
  assert.match(e.data.error, /owns a workspace or is an admin of another one, so nobody on .* can switch their second step off/);
  assert.ok(user(owen.id).two_step_on_at, 'still on');
  assert.equal((await ada.c.post(`/account/members/${amy.id}/two-step/reset`, {})).data.code, 'admin_elsewhere');
  // The owner has two-step login, so the owner's own code first. Ada has none, so she is not asked for one.
  assert.equal((await boss.c.post(`/account/members/${ivy.id}/two-step/reset`, {})).data.code, 'code_needed');
  const done = await ada.c.post(`/account/members/${ivy.id}/two-step/reset`, {});
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const mail = mailTo(ivy.email).find((m) => /switched off two-step login/.test(m.subject))!;
  assert.match(mail.html, /Ada Admin, an admin of/);
  assert.ok(!mail.html.includes(ada.email), 'the copy we keep does not hold the admin address');
  assert.ok((await ivy.c.get('/me/two-step')).data.log[0].text.includes('Ada Admin'));
  void bossStep;
});

// ---- Lows ----------------------------------------------------------------------------------------------------------

test('a sign-in waiting for its code ends when the password is changed, reset by email or other browsers are signed out (probe F)', async () => {
  const { c, email, id } = await person('Pia Pending');
  const { secret } = await switchOn(c);
  const waiting = () => db.all('SELECT 1 FROM two_step_pending WHERE user_id=?', id).length;
  const a = (await password(email)).c;
  assert.equal(waiting(), 1);
  assert.equal((await c.post('/me/password', { current: PW, password: 'owner new password', code: code(secret) })).status, 200);
  assert.equal(waiting(), 0);
  assert.equal((await a.post('/auth/two-step', { code: code(secret) })).data.code, 'two_step_expired', 'the old password plus a code opens nothing');
  // A password reset by email ends it too.
  await password(email, 'owner new password');
  assert.equal(waiting(), 1);
  await browser().post('/auth/forgot', { email });
  await browser().post('/auth/reset', { token: tokenOf(mailTo(email).filter((m) => /Reset your GrowSigning password/.test(m.subject)).at(-1)), password: 'owner newer password' });
  assert.equal(waiting(), 0);
  // And "Sign out every other browser".
  const fresh = browser();
  await fresh.post('/auth/login', { email, password: 'owner newer password' });
  assert.equal((await fresh.post('/auth/two-step', { code: code(secret) })).status, 200);
  await password(email, 'owner newer password');
  assert.equal(waiting(), 1);
  assert.equal((await fresh.post('/me/sessions/sign-out-others')).status, 200);
  assert.equal(waiting(), 0);
});

test('no API key can change the password or read anything of two-step login (keypause probe)', async () => {
  const { c, email } = await person('Kay Keyholder');
  const key = (await c.post('/api-keys', { name: 'zapier', scope: 'send' })).data.key;
  await switchOn(c);
  const k = (m: string, u: string, b?: any) => browser().call(m, u, b, { authorization: `Bearer ${key}` });
  const pw = await k('POST', '/me/password', { current: PW, password: 'changed by key 1', code: '000000' });
  assert.equal(pw.status, 403);
  assert.match(pw.data.error, /An API key cannot change the password of a login/);
  assert.equal(mailTo(email).filter((m) => /Wrong codes/.test(m.subject)).length, 0, 'and nothing was paused');
  const me = (await k('GET', '/me')).data;
  assert.equal(me.two_step, null);
  assert.equal('two_step' in me.user, false);
  assert.equal('two_step' in (await k('PATCH', '/me', { title: 'Keyed' })).data.user, false);
  // The browser still sees it.
  assert.equal((await c.get('/me')).data.user.two_step, true);
});

test('withdrawing a remembered device signs that browser out too, and the browser doing it stays in', async () => {
  const { c, email } = await person('Dee Device');
  const { secret } = await switchOn(c);
  // Remembered when signing in with the code...
  const a = (await fullSignIn(email, secret, { remember: true })).c;
  // ...and another browser that got in by skipping the code on its remembered device.
  const b = (await fullSignIn(email, secret, { remember: true })).c;
  await b.post('/auth/logout');
  assert.equal((await b.post('/auth/login', { email, password: PW })).status, 200);
  assert.ok(signedIn(b));
  const list = (await c.get('/me/two-step')).data.devices;
  assert.equal(list.length, 2);
  const one = await c.call('DELETE', `/me/two-step/devices/${list[0].id}`);
  assert.equal(one.data.signed_out, 1);
  const all = await c.call('DELETE', '/me/two-step/devices');
  assert.equal(all.data.signed_out, 1);
  for (const x of [a, b]) assert.equal((await x.get('/envelopes')).status, 401);
  assert.equal((await c.get('/envelopes')).status, 200);
  assert.match(fs.readFileSync(new URL('../src/app/app/settings/TwoStep.tsx', import.meta.url), 'utf8'), /Withdrawing one also signs that browser out/);
});

test('a team that requires two-step login still lets a member see and end their sessions and close their login', async () => {
  const boss = await person('Tia Team');
  const bs = await switchOn(boss.c);
  const acc = db.get("SELECT account_id a FROM memberships WHERE user_id=? AND role='owner'", boss.id).a;
  const m = await person('Mo Member');
  db.run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'admin',?)", acc, m.id, iso(Date.now()));
  await m.c.post('/auth/switch', { account_id: acc });
  await boss.c.post('/account/two-step', { required: true, code: code(bs.secret) });
  assert.equal((await m.c.get('/envelopes')).data.code, 'two_step_setup');
  assert.equal((await m.c.get('/me/sessions')).status, 200);
  const del = await m.c.post('/me/delete', {});
  assert.notEqual(del.data.code, 'two_step_setup');
});

test('a member of a team that requires it, with an unconfirmed address, is told to confirm and can have the link sent again', async () => {
  const boss = await person('Uli Upper');
  const bs = await switchOn(boss.c);
  const acc = db.get("SELECT account_id a FROM memberships WHERE user_id=? AND role='owner'", boss.id).a;
  const v = await unconfirmed('Ned New', `ned.${n++}@example.com`);
  db.run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'member',?)", acc, v.id, iso(Date.now()));
  await v.c.post('/auth/switch', { account_id: acc });
  await boss.c.post('/account/two-step', { required: true, code: code(bs.secret) });
  assert.equal((await v.c.get('/me')).data.two_step.setup_required, true);
  assert.equal((await v.c.post('/me/two-step/setup', { password: PW })).data.code, 'confirm_first');
  const before = mailTo(v.email).length;
  assert.equal((await v.c.post('/auth/resend-verification', {})).status, 200, 'open while the team requires two-step login');
  assert.equal(mailTo(v.email).length, before + 1);
  // The screen that hides the rest of the app offers it, because the banner that usually does is hidden too.
  const src = fs.readFileSync(new URL('../src/components/TwoStep.tsx', import.meta.url), 'utf8');
  assert.match(src.slice(src.indexOf('export function TwoStepRequired')), /!me\.user\.email_verified[\s\S]*Send the link again/);
});

test('disagree: a mistyped password on a login without two-step login is still said to be wrong at once (probe K)', async () => {
  // The skeptic suggested a second screen for every address, so that nobody can tell which logins have two-step
  // login. That would ask every honest person without it for a code they do not have whenever they mistype.
  const { email } = await person('Eff Off');
  const r = await password(email, 'mistyped');
  assert.equal(r.r.status, 401);
  assert.equal(r.r.data.error, 'That email and password do not match.');
});

test('the words: 7 days, the switch and its risk, on the screens, /help, /security and in the README', () => {
  const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.match(TWO_STEP_LOST.join(' '), /switched it off under Settings, Profile/);
  assert.match(TWO_STEP_LOST.join(' '), /unless you own a workspace or are an admin of another one/);
  assert.match(TWO_STEP_LOST.join(' '), /remembered device stops it at once/);
  assert.equal(TWO_STEP_EMAIL_RESET_RISK, 'Someone who controls your mailbox and knows your password, and whom you do not notice for a week, could get in this way. Switch the reset by email off if you would rather be locked out than take that risk.');
  assert.match(read('src/app/security/page.tsx'), /TWO_STEP_EMAIL_RESET_RISK/);
  assert.match(read('src/app/app/settings/TwoStep.tsx'), /Allow a reset by email/);
  assert.match(read('src/app/app/settings/TwoStep.tsx'), /TWO_STEP_EMAIL_RESET_RISK/);
  assert.match(read('src/components/AppShell.tsx'), /<TwoStepResetBanner/);
  const readme = read('README.md');
  assert.match(readme, /takes effect 7 days after/);
  assert.doesNotMatch(readme.slice(readme.indexOf('### Two-step login'), readme.indexOf('### Encrypting')), /3 days|password alone/);
  for (const f of ['src/server/twostep.ts', 'src/server/routes-twostep.ts', 'src/app/two-step-reset/ResetView.tsx', 'src/components/TwoStep.tsx', 'src/app/app/settings/TwoStep.tsx', 'src/app/login/two-step/TwoStepForm.tsx']) {
    assert.doesNotMatch(read(f), /password alone signs in/, f);
    assert.doesNotMatch(read(f), /—|–/, `${f} has a long dash`);
  }
});
