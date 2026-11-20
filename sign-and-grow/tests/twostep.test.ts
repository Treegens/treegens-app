// Two-step login with an authenticator app (src/server/twostep.ts, src/server/routes-twostep.ts). Pinned down: the
// code algorithm against the published test values; the whole life of it (set up, sign in, remember a device,
// recovery codes, a reset by an admin, a reset by email with its wait and stopping it); that a code works once; the
// pause after wrong codes; a team that asks everyone for it; every way of signing in (password, Google, a password
// reset by email); API keys; and that nothing gives a session before the second step is done.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, Client, signUp, mailTo, simple } from './helpers.ts';
import { hotp, totp, toBase32, fromBase32, stepAt, otpauthUri } from '../src/server/twostep.ts';
import { TWO_STEP_TRIES, TWO_STEP_RECOVERY_CODES, TWO_STEP_EMAIL_RESET_DAYS, TWO_STEP_REMEMBER_DAYS } from '../src/lib/policy.ts';

const G = { id: 'two-step.apps.google.test', secret: 'google-secret' };
Object.assign(process.env, { GOOGLE_CLIENT_ID: G.id, GOOGLE_CLIENT_SECRET: G.secret });
const { db, cron } = await boot();
const { handle, listRoutes } = await import('../src/server/router.ts');
const PW = 'correct horse battery';

// The clock, as the authenticator app and the server both read it. A code works once, so a person who signs in
// twice within 30 seconds waits for the next code: `code` moves this clock on when it has to, as that wait would.
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

let n = 0;
const browser = () => {
  const c = new Client();
  c.ip = `192.0.${Math.floor(n / 250) + 10}.${(n++ % 250) + 1}`;
  return c;
};
const person = async (name: string) => {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${n}@example.com`;
  const c = await signUp(name, email, `198.18.${Math.floor(n / 250)}.${(n++ % 250) + 1}`);
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
async function fullSignIn(email: string, secret: string, extra: any = {}) {
  const { c, r } = await password(email);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.two_step, true);
  const done = await c.post('/auth/two-step', { code: code(secret), ...extra });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return { c, done };
}

// ---- The algorithm --------------------------------------------------------------------------------------

test('HOTP and TOTP give the published test values of RFC 4226 and RFC 6238', () => {
  const key = Buffer.from('12345678901234567890');
  // RFC 4226, appendix D.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => hotp(key, i)), ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']);
  // RFC 6238, appendix B: 8 digits, the three hash functions, each with its own key.
  const keys: Record<string, Buffer> = { sha1: key, sha256: Buffer.from('12345678901234567890123456789012'), sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234') };
  const table: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [t, sha1, sha256, sha512] of table) {
    assert.equal(totp(keys.sha1, t * 1000, 8, 'sha1'), sha1, `SHA-1 at ${t}`);
    assert.equal(totp(keys.sha256, t * 1000, 8, 'sha256'), sha256, `SHA-256 at ${t}`);
    assert.equal(totp(keys.sha512, t * 1000, 8, 'sha512'), sha512, `SHA-512 at ${t}`);
  }
  // What the apps use: 6 digits, 30 seconds, SHA-1. The last six digits of the same number.
  assert.equal(totp(key, 59_000), '287082');
  assert.equal(totp(key, 1111111109_000), '081804');
  // Base32 as RFC 4648 writes it (without the padding the apps do not want), both ways.
  for (const [plain, b32] of [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]) {
    assert.equal(toBase32(Buffer.from(plain)), b32);
    assert.equal(fromBase32(b32).toString(), plain);
  }
  const random = crypto.randomBytes(20);
  assert.deepEqual(fromBase32(toBase32(random).toLowerCase().replace(/(.{4})/g, '$1 ')), random, 'typed in groups and in small letters, it is the same secret');
  const uri = new URL(otpauthUri('JBSWY3DPEHPK3PXP', 'ada@example.com'));
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.host, 'totp');
  assert.equal(decodeURIComponent(uri.pathname.slice(1)), 'Sign&Grow:ada@example.com', 'the label the app shows: who issued it, and the login');
  assert.equal(uri.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
  assert.equal(uri.searchParams.get('issuer'), 'Sign&Grow');
  assert.equal(uri.searchParams.get('digits'), '6');
  assert.equal(uri.searchParams.get('period'), '30');
  assert.equal(uri.searchParams.get('algorithm'), 'SHA1');
});

// ---- Setting it up --------------------------------------------------------------------------------------

test('setting it up: the password first, a secret as text and as a link, on only after a right code, ten recovery codes once', async () => {
  const { c, email, id } = await person('Sara Setup');
  const other = (await password(email)).c; // another browser, signed in before
  assert.ok(signedIn(other));
  // A browser left signed in is not enough to put somebody else's phone in front of this login.
  const noPw = await c.post('/me/two-step/setup', {});
  assert.equal(noPw.status, 403);
  assert.equal(noPw.data.code, 'password_needed');
  assert.equal((await c.post('/me/two-step/setup', { password: 'wrong one' })).data.code, 'password_needed');
  const s = await c.post('/me/two-step/setup', { password: PW });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.match(s.data.secret, /^[A-Z2-7]{32}$/, '20 random bytes, written as the apps expect');
  assert.equal(new URL(s.data.uri).searchParams.get('secret'), s.data.secret);
  assert.equal(s.data.account, email);
  // Not on yet: a wrong code switches nothing on, and signing in still needs no code.
  const wrong = await c.post('/me/two-step/confirm', { code: '000000' === code(s.data.secret) ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /does not match, so nothing was switched on/);
  assert.equal((await c.get('/me/two-step')).data.on, false);
  assert.ok(signedIn((await password(email)).c), 'until a right code, the password alone signs in');
  // A code a step off either way counts: phone clocks are often a few seconds out.
  const late = hotp(fromBase32(s.data.secret), stepAt() - 1);
  const on = await c.post('/me/two-step/confirm', { code: late });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.codes.length, TWO_STEP_RECOVERY_CODES);
  assert.equal(new Set(on.data.codes).size, TWO_STEP_RECOVERY_CODES);
  for (const rc of on.data.codes) assert.match(rc, /^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
  // Stored as fingerprints only: no code is in the database.
  const row = db.get('SELECT * FROM users WHERE id=?', id);
  for (const rc of on.data.codes) assert.ok(!row.two_step_codes.includes(rc) && !row.two_step_codes.includes(rc.replace('-', '')));
  assert.equal(row.two_step_new_secret, null);
  // Shown once: nothing gives them back.
  const st = (await c.get('/me/two-step')).data;
  assert.equal(st.on, true);
  assert.equal(st.recovery_left, TWO_STEP_RECOVERY_CODES);
  assert.ok(!JSON.stringify(st).includes(on.data.codes[0]) && !JSON.stringify(st).includes(s.data.secret));
  assert.equal(st.log[0].text, 'Switched on.');
  // The other browser got in without a second step, so it is signed out. This one stays.
  assert.equal((await other.get('/me')).data.user, null);
  assert.equal((await c.get('/me')).data.user.two_step, true);
  assert.ok(mailTo(email).some((m) => m.subject === 'Two-step login is on for your Sign&Grow login'));
  // The setup secret no longer works for confirming.
  assert.equal((await c.post('/me/two-step/confirm', { code: code(s.data.secret) })).data.code, 'setup_first');
});

test('a secret for setting up is kept for an hour only', async () => {
  const { c, id } = await person('Olga Old');
  const s = await c.post('/me/two-step/setup', { password: PW });
  db.run('UPDATE users SET two_step_new_at=? WHERE id=?', new Date(Date.now() - 2 * 3600_000).toISOString(), id);
  const r = await c.post('/me/two-step/confirm', { code: code(s.data.secret) });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'setup_first');
});

// ---- Signing in -----------------------------------------------------------------------------------------

test('after the password a second screen asks for the code, and a wrong password gets exactly the same answer', async () => {
  const { c, email } = await person('Petra Pass');
  const { secret } = await switchOn(c);
  const right = await password(email);
  const wrong = await password(email, 'not the password');
  for (const x of [right, wrong]) {
    assert.equal(x.r.status, 200);
    assert.deepEqual(Object.keys(x.r.data).sort(), ['minutes', 'paused_until', 'two_step']);
    assert.equal(x.r.data.two_step, true);
    assert.equal(signedIn(x.c), false, 'no session before the code');
    assert.ok(x.c.cookies.sg_twostep, 'a waiting sign-in, tied to this browser');
    assert.equal((await x.c.get('/me')).data.user, null);
    assert.deepEqual((await x.c.get('/auth/two-step')).data.waiting, true);
  }
  assert.deepEqual(right.r.data, wrong.r.data, 'the password step says nothing about the password');
  const look = async (c: Client) => {
    const { expires_at, ...rest } = (await c.get('/auth/two-step')).data;
    return rest;
  };
  assert.deepEqual(await look(right.c), await look(wrong.c), 'nor does the second screen');
  // A login without two-step login, and an address nobody has, still say so at once.
  assert.equal((await password('nobody.here@example.com')).r.status, 401);
  // After a code: the same answer for a wrong code after the right password and for any code after a wrong one.
  const a = await right.c.post('/auth/two-step', { code: '123456' });
  const b = await wrong.c.post('/auth/two-step', { code: code(secret) });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.data.error, 'That did not work: the code is not right, or the password you typed before it was not. We do not say which, so that nobody can find out a password by trying it here. 3 more tries, then the second step of this login pauses for 15 minutes. Type the newest code from your app, or start again with your password.'.replace('3 more', `${TWO_STEP_TRIES - 1} more`));
  // Each internet address counts its own tries, the same way after a right and a wrong password, so that a stranger
  // cannot pause the owner (twostep-repair.test.ts). The count says nothing about the password either.
  assert.equal(b.data.error, a.data.error, 'the same words and the same count');
  assert.equal(signedIn(wrong.c), false);
  // A typo costs a try, not the password: the right password's sign-in still waits, and the right code finishes it.
  usedStep.delete(secret);
  const ok = await right.c.post('/auth/two-step', { code: code(secret) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(signedIn(right.c));
  assert.equal(ok.data.user.email, email);
  assert.equal(ok.data.used, 'app');
  assert.equal((await right.c.get('/me')).data.user.email, email);
  assert.equal(right.c.cookies.sg_twostep, '', 'the waiting sign-in is over');
  // And the browser with the wrong password never gets in, whatever code it types.
  assert.equal((await wrong.c.post('/auth/two-step', { code: code(secret) })).status, 401);
  assert.equal(signedIn(wrong.c), false);
});

test('a code works once, also when two browsers send it at the same moment', async () => {
  const { c, email } = await person('Rita Replay');
  const { secret } = await switchOn(c);
  const one = await fullSignIn(email, secret);
  const used = usedStep.get(secret)!;
  const again = await password(email);
  const replay = await again.c.post('/auth/two-step', { code: hotp(fromBase32(secret), used) });
  assert.equal(replay.status, 401, 'the code that signed the first browser in');
  assert.equal(replay.data.code, 'wrong_code');
  // An older code of the window does not work after a newer one was used either.
  assert.equal((await again.c.post('/auth/two-step', { code: hotp(fromBase32(secret), used - 1) })).status, 401);
  assert.ok(one.c.cookies.ts_session);
  // Two browsers with the right password, the same fresh code, at once: one gets in.
  db.run('UPDATE users SET two_step_wrong=0 WHERE email=?', email);
  const x = await password(email), y = await password(email);
  const fresh = code(secret);
  const [rx, ry] = await Promise.all([x.c.post('/auth/two-step', { code: fresh }), y.c.post('/auth/two-step', { code: fresh })]);
  assert.deepEqual([rx.status, ry.status].sort(), [200, 401]);
});

test(`${TWO_STEP_TRIES} wrong codes pause the second step of that login for 15 minutes, in words, and the owner is emailed`, async () => {
  const { c, email, id } = await person('Lena Lock');
  const { secret } = await switchOn(c);
  const { c: b } = await password(email);
  // Four wrong and then a right one: the count starts again.
  for (let i = 0; i < TWO_STEP_TRIES - 1; i++) assert.equal((await b.post('/auth/two-step', { code: '000001' })).status, 401);
  assert.equal((await b.post('/auth/two-step', { code: code(secret) })).status, 200);
  assert.equal(db.get('SELECT two_step_wrong n FROM users WHERE id=?', id).n, 0);
  const { c: d } = await password(email);
  let last: any;
  for (let i = 0; i < TWO_STEP_TRIES; i++) last = await d.post('/auth/two-step', { code: '000001' });
  assert.equal(last.status, 429);
  assert.equal(last.data.code, 'two_step_paused');
  assert.match(last.data.error, /^5 wrong codes in a row were typed for this login, so its second step is paused for 15 more minutes\./);
  assert.ok(last.data.paused_until > new Date().toISOString());
  // Even the right code waits now, and so does every browser of that login.
  const right = await d.post('/auth/two-step', { code: code(secret) });
  assert.equal(right.status, 429);
  assert.equal(signedIn(d), false);
  const other = await password(email);
  assert.ok(other.r.data.paused_until, 'the second screen says so at once, for a right password and for a wrong one');
  assert.equal((await password(email, 'wrong')).r.data.paused_until, other.r.data.paused_until);
  const mail = mailTo(email).filter((m) => m.subject === 'Wrong codes were typed for your Sign&Grow login');
  assert.equal(mail.length, 1);
  assert.match(mail[0].html, /They came after your correct password/);
  // When the pause is over, the right code works.
  db.run('UPDATE users SET two_step_paused_until=? WHERE id=?', new Date(realNow() - 1000).toISOString(), id);
  assert.equal((await other.c.post('/auth/two-step', { code: code(secret) })).status, 200);
});

test('a waiting sign-in ends after its minutes, and says so', async () => {
  const { c, email } = await person('Edda Expired');
  const { secret } = await switchOn(c);
  const { c: b } = await password(email);
  db.run('UPDATE two_step_pending SET expires_at=?', new Date(realNow() - 1000).toISOString());
  const r = await b.post('/auth/two-step', { code: code(secret) });
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'two_step_expired');
  assert.match(r.data.error, /Start again on the sign-in page/);
  assert.equal((await b.get('/auth/two-step')).data.waiting, false);
});

test('"Remember this device" skips the second step in that browser, for that login only, and can be withdrawn', async () => {
  const { c, email, id } = await person('Mia Mind');
  const { secret } = await switchOn(c);
  const { c: b, done } = await fullSignIn(email, secret, { remember: true });
  assert.ok(done.data.user);
  const name = Object.keys(b.cookies).find((k) => k.startsWith('sg_device_'))!;
  assert.ok(name && b.cookies[name]);
  const row = db.get('SELECT * FROM two_step_devices WHERE user_id=?', id);
  assert.ok(Math.abs(Date.parse(row.expires_at) - realNow() - skew - TWO_STEP_REMEMBER_DAYS * 864e5) < 60_000);
  await b.post('/auth/logout');
  // The password alone, in that browser.
  const back = await b.post('/auth/login', { email, password: PW });
  assert.equal(back.status, 200);
  assert.equal(back.data.user.email, email);
  assert.ok(signedIn(b));
  // There a wrong password is said to be wrong, as on any login without a second step: the device is the second step.
  assert.equal((await password(email, 'wrong', b)).r.status, 401);
  // Another browser still gets the second screen.
  assert.equal((await password(email)).r.data.two_step, true);
  // The cookie belongs to this login: under another login's name it opens nothing.
  const other = await person('Otto Other');
  await switchOn(other.c);
  const thief = browser();
  thief.cookies[`sg_device_${crypto.createHash('sha256').update(`device:${other.id}`).digest('hex').slice(0, 12)}`] = b.cookies[name];
  assert.equal((await password(other.email, PW, thief)).r.data.two_step, true);
  // Listed under Settings, and withdrawn from there.
  const list = (await c.get('/me/two-step')).data.devices;
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes(row.id) && !JSON.stringify(list).includes(b.cookies[name]), 'named by a handle, never by the secret');
  assert.equal((await c.call('DELETE', `/me/two-step/devices/${list[0].id}`)).status, 200);
  await b.post('/auth/logout');
  assert.equal((await password(email, PW, b)).r.data.two_step, true, 'withdrawn: the code is asked again');
  // "Withdraw all" too.
  await fullSignIn(email, secret, { remember: true });
  assert.equal((await c.call('DELETE', '/me/two-step/devices')).data.withdrawn, 1);
});

test('a recovery code signs in once and says how many are left; new ones replace the old ones', async () => {
  const { c, email } = await person('Rhea Recover');
  const { secret, codes } = await switchOn(c);
  const { c: b } = await password(email);
  // Typed as people type: capitals, spaces, no dash.
  const r = await b.post('/auth/two-step', { code: ` ${codes[0].toUpperCase().replace('-', ' ')} ` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.used, 'recovery');
  assert.equal(r.data.recovery_left, TWO_STEP_RECOVERY_CODES - 1);
  const again = await password(email);
  assert.equal((await again.c.post('/auth/two-step', { code: codes[0] })).status, 401, 'each works once');
  assert.equal((await c.get('/me/two-step')).data.recovery_left, TWO_STEP_RECOVERY_CODES - 1);
  // New codes need the current code.
  assert.equal((await c.post('/me/two-step/recovery-codes', {})).data.code, 'code_needed');
  const fresh = await c.post('/me/two-step/recovery-codes', { code: code(secret) });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.equal(fresh.data.codes.length, TWO_STEP_RECOVERY_CODES);
  db.run('UPDATE users SET two_step_wrong=0 WHERE email=?', email);
  assert.equal((await again.c.post('/auth/two-step', { code: codes[1] })).status, 401, 'the old ones stopped working');
  assert.equal((await again.c.post('/auth/two-step', { code: fresh.data.codes[1] })).status, 200);
});

// ---- Changes that need the current code -----------------------------------------------------------------

test('changing the password, the email address or the second step itself asks for a current code', async () => {
  const { c, email } = await person('Cora Change');
  const { secret } = await switchOn(c);
  const pw = await c.post('/me/password', { current: PW, password: 'a brand new password' });
  assert.equal(pw.status, 403);
  assert.equal(pw.data.code, 'code_needed');
  assert.match(pw.data.error, /To change your password, type the 6-digit code from your authenticator app as well/);
  const wrongCode = await c.post('/me/password', { current: PW, password: 'a brand new password', code: '000000' });
  assert.equal(wrongCode.status, 401);
  assert.match(wrongCode.data.error, /^That code is not right, so nothing was changed/);
  assert.equal((await c.post('/me/password', { current: PW, password: 'a brand new password', code: code(secret) })).status, 200);
  db.run('UPDATE users SET password_hash=? WHERE email=?', (await import('../src/server/auth.ts')).hashPassword(PW), email);
  const mv = await c.post('/me/email', { email: `new.${email}`, password: PW });
  assert.equal(mv.status, 403);
  assert.equal(mv.data.code, 'code_needed');
  assert.equal((await c.post('/me/email', { email: `new.${email}`, password: PW, code: code(secret) })).status, 200);
  // Off, and moving to another app.
  assert.equal((await c.post('/me/two-step/off', {})).data.code, 'code_needed');
  assert.equal((await c.post('/me/two-step/setup', {})).data.code, 'code_needed', 'moving to another app is a change of the second step');
  const move = await c.post('/me/two-step/setup', { code: code(secret) });
  assert.equal(move.status, 200);
  assert.equal(move.data.moving, true);
  const moved = await c.post('/me/two-step/confirm', { code: code(move.data.secret) });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.codes, null, 'recovery codes stay as they were');
  assert.ok(signedIn(c), 'moving signs nobody out');
  // The old app no longer works; the new one does.
  const { c: b } = await password(email);
  assert.equal((await b.post('/auth/two-step', { code: code(secret) })).status, 401);
  assert.equal((await b.post('/auth/two-step', { code: code(move.data.secret) })).status, 200);
  const off = await c.post('/me/two-step/off', { code: code(move.data.secret) });
  assert.equal(off.status, 200);
  assert.ok(signedIn((await password(email)).c), 'off: the password alone signs in');
  assert.equal(db.get('SELECT two_step_secret s, two_step_codes k FROM users WHERE email=?', email).s, null);
});

test('a password reset by email still needs the code afterwards', async () => {
  const { c, email } = await person('Nina Reset');
  const { secret } = await switchOn(c);
  await browser().post('/auth/forgot', { email });
  const t = new URL(mailTo(email).filter((m) => /Reset your Sign&Grow password/.test(m.subject)).at(-1)!.link).searchParams.get('token');
  const r = await browser().post('/auth/reset', { token: t, password: 'mailbox thief password' });
  assert.equal(r.status, 200);
  assert.equal(r.data.two_step, true, 'the page says the code is asked for next');
  const { c: b, r: step } = await password(email, 'mailbox thief password');
  assert.equal(step.data.two_step, true);
  assert.equal(signedIn(b), false);
  assert.equal((await b.post('/auth/two-step', { code: code(secret) })).status, 200);
});

test('a stranger who set up a login in someone else\'s name, with two-step login, does not keep its owner out', async () => {
  // Signed up with an address that is not theirs (never confirmed). Putting their own phone in front of it is
  // refused: two-step login needs a confirmed address, because proving the address later does not remove it.
  const stranger = browser();
  const email = `victim.${n}@example.com`;
  assert.equal((await stranger.post('/auth/signup', { name: 'Not Them', email, password: PW })).status, 200);
  assert.equal((await stranger.post('/me/two-step/setup', { password: PW })).data.code, 'confirm_first');
  // The owner of the mailbox chooses a password by email: that proves the address, and cuts what was there before.
  await browser().post('/auth/forgot', { email });
  const t = new URL(mailTo(email).filter((m) => /password/i.test(m.subject)).at(-1)!.link).searchParams.get('token');
  const r = await browser().post('/auth/reset', { token: t, password: 'the real owner' });
  assert.equal(r.data.two_step, false);
  const { c, r: inn } = await password(email, 'the real owner');
  assert.equal(inn.data.user?.email, email);
  assert.ok(signedIn(c));
});

// ---- Losing the phone -----------------------------------------------------------------------------------

test('an owner or admin resets a member\'s second step: the member is emailed at once and it is written down who', async () => {
  const owner = await person('Olive Owner');
  const ownerStep = await switchOn(owner.c);
  const acc = db.get("SELECT account_id a FROM memberships WHERE user_id=? AND role='owner'", owner.id).a;
  const member = await person('Max Member');
  const admin = await person('Ada Admin');
  for (const [p, role] of [[member, 'member'], [admin, 'admin']] as const) {
    db.run('INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,?,?)', acc, p.id, role, new Date().toISOString());
    assert.equal((await p.c.post('/auth/switch', { account_id: acc })).status, 200);
  }
  // Max is only on this team, as someone who joined from the invitation is: an admin may reset only such a member,
  // not someone who owns a workspace of their own (twostep-repair.test.ts).
  db.run("DELETE FROM accounts WHERE id IN (SELECT account_id FROM memberships WHERE user_id=? AND role='owner')", member.id);
  await switchOn(member.c);
  // Not a member's to do, and not an API key's.
  assert.equal((await member.c.post(`/account/members/${admin.id}/two-step/reset`, {})).status, 403);
  const key = (await owner.c.post('/api-keys', { name: 'admin key', scope: 'admin' })).data.key;
  const byKey = await browser().call('POST', `/account/members/${member.id}/two-step/reset`, {}, { authorization: `Bearer ${key}` });
  assert.equal(byKey.status, 403);
  assert.match(byKey.data.error, /An API key cannot see or change two-step login/);
  // The team card shows who has it, to admins.
  const card = (await admin.c.get('/account/two-step')).data;
  assert.deepEqual(card.members.map((x: any) => [x.name, x.on, x.can_reset]), [['Olive Owner', true, false], ['Max Member', true, true], ['Ada Admin', false, false]]);
  assert.equal(card.can_require, false, 'only the owner decides for the team');
  // An admin may not take the owner's place.
  const ownerReset = await admin.c.post(`/account/members/${owner.id}/two-step/reset`, {});
  assert.equal(ownerReset.status, 403);
  assert.match(ownerReset.data.error, /nobody else can reset the second step of an owner/);
  // The owner has two-step login, so the owner's own code is asked first.
  assert.equal((await owner.c.post(`/account/members/${member.id}/two-step/reset`, {})).data.code, 'code_needed');
  const done = await owner.c.post(`/account/members/${member.id}/two-step/reset`, { code: code(ownerStep.secret) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const mail = mailTo(member.email).filter((x) => /switched off two-step login/.test(x.subject));
  assert.equal(mail.length, 1);
  assert.match(mail[0].html, /Olive Owner/);
  const log = (await member.c.get('/me/two-step')).data.log;
  assert.match(log[0].text, new RegExp(`Switched off by Olive Owner \\(${owner.email.replace(/\./g, '\\.')}\\), an admin of Olive Owner's workspace\\.`));
  assert.equal((await owner.c.get('/account/two-step')).data.members.find((x: any) => x.id === member.id).last_reset.by, `Olive Owner (${owner.email})`);
  // Stored is the name and the login it belongs to, never the address: that is looked up while the login exists.
  assert.deepEqual({ ...db.get("SELECT by_id, by_name FROM two_step_log WHERE user_id=? AND what='reset_by_admin'", member.id) }, { by_id: owner.id, by_name: 'Olive Owner' });
  // The member signs in with the password alone, and the old app and codes are gone.
  const back = await password(member.email);
  assert.equal(back.r.data.user?.email, member.email);
  assert.equal(db.get('SELECT two_step_codes k FROM users WHERE id=?', member.id).k, null);
  // Nobody resets someone of another team: that person is not on this one.
  const stranger = await person('Sol Stranger');
  await switchOn(stranger.c);
  assert.equal((await owner.c.post(`/account/members/${stranger.id}/two-step/reset`, { code: code(ownerStep.secret) })).status, 404);
  assert.ok(db.get('SELECT two_step_secret s FROM users WHERE id=?', stranger.id).s);
});

test('the only owner resets by email: it takes effect after the wait, is emailed every day, and signing in stops it', async () => {
  const { c, email, id } = await person('Uma Unique');
  const { secret } = await switchOn(c);
  // From the second screen. The answer is the same after a wrong password, and then nothing is emailed.
  const before = mailTo(email).length;
  const wrong = await password(email, 'not it');
  assert.deepEqual((await wrong.c.post('/auth/two-step/lost', {})).data, { ok: true });
  assert.equal(mailTo(email).length, before);
  const right = await password(email);
  assert.deepEqual((await right.c.post('/auth/two-step/lost', {})).data, { ok: true });
  const link = mailTo(email).filter((m) => m.subject === 'Reset two-step login of your Sign&Grow login').at(-1)!;
  assert.ok(link, 'the mailbox of the login gets the link');
  const t = new URL(link.link).searchParams.get('token');
  // Nothing changes until the link is opened.
  assert.equal(db.get('SELECT two_step_reset_at r FROM users WHERE id=?', id).r, null);
  const started = await browser().post('/auth/two-step/email-reset', { token: t });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const at = Date.parse(started.data.takes_effect_at);
  assert.ok(Math.abs(at - (Date.now() + TWO_STEP_EMAIL_RESET_DAYS * 864e5)) < 60_000);
  assert.equal((await browser().post('/auth/two-step/email-reset', { token: t })).status, 410, 'the link works once');
  assert.ok(mailTo(email).some((m) => m.subject === 'Two-step login of your Sign&Grow login will be switched off'));
  // Until then the code is still asked for.
  assert.equal((await password(email)).r.data.two_step, true);
  // Every day an email.
  await cron.tick();
  assert.equal(mailTo(email).filter((m) => /^Reminder: two-step login/.test(m.subject)).length, 0, 'not twice on the first day');
  db.run('UPDATE users SET two_step_reset_noticed_at=? WHERE id=?', new Date(realNow() - 24 * 3600_000).toISOString(), id);
  await cron.tick();
  assert.equal(mailTo(email).filter((m) => new RegExp(`^Reminder: two-step login of your Sign&Grow login goes off in ${TWO_STEP_EMAIL_RESET_DAYS} days`).test(m.subject)).length, 1);
  assert.equal((await c.get('/me/two-step')).data.reset_at, started.data.takes_effect_at, 'Settings shows it, with a Stop');
  // The owner (who still has the phone) signs in with the code: it stops, and they are told.
  await fullSignIn(email, secret);
  assert.equal(db.get('SELECT two_step_reset_at r FROM users WHERE id=?', id).r, null);
  assert.ok(mailTo(email).some((m) => m.subject === 'The reset of your two-step login was stopped'));
  // Started again, and stopped from Settings.
  await (await password(email)).c.post('/auth/two-step/lost', {});
  const t2 = new URL(mailTo(email).filter((m) => m.subject === 'Reset two-step login of your Sign&Grow login').at(-1)!.link).searchParams.get('token');
  assert.equal((await browser().post('/auth/two-step/email-reset', { token: t2 })).status, 200);
  assert.equal((await c.post('/me/two-step/reset/stop')).data.stopped, true);
  // A stop under Settings makes a new reset wait, unless the owner signs in with the code (twostep-repair.test.ts).
  await fullSignIn(email, secret);
  // Started a third time, and this time the days pass: off, by the timer, in words. Under Settings the password is
  // asked for too.
  const s3 = await c.post('/me/two-step/lost', { password: PW });
  assert.equal(s3.data.what, 'link');
  const t3 = new URL(mailTo(email).filter((m) => m.subject === 'Reset two-step login of your Sign&Grow login').at(-1)!.link).searchParams.get('token');
  assert.equal((await browser().post('/auth/two-step/email-reset', { token: t3 })).status, 200);
  db.run('UPDATE users SET two_step_reset_at=? WHERE id=?', new Date(realNow() - 1000).toISOString(), id);
  assert.equal((await cron.tick()).two_step.switched_off, 1);
  assert.ok(mailTo(email).some((m) => m.subject === 'Two-step login of your Sign&Grow login is off'));
  assert.equal((await password(email)).r.data.user?.email, email);
});

test('a reset whose day has come takes effect at the next sign-in, also before the timer runs', async () => {
  const { c, email, id } = await person('Tess Timer');
  await switchOn(c);
  db.run('UPDATE users SET two_step_reset_at=? WHERE id=?', new Date(realNow() - 1000).toISOString(), id);
  const { c: b, r } = await password(email);
  assert.equal(r.data.user?.email, email);
  assert.ok(signedIn(b));
  assert.equal((await b.get('/me/two-step')).data.on, false);
  // Every browser that was signed in was signed out when it took effect, so the owner notices.
  assert.equal((await c.get('/me/two-step')).status, 401);
});

test('someone who owns no account is told by email which admins can reset it, next to the reset link', async () => {
  const owner = await person('Bea Boss');
  const acc = db.get("SELECT account_id a FROM memberships WHERE user_id=? AND role='owner'", owner.id).a;
  const m = await person('Ivo Invited');
  // Only on the team: their own workspace is gone.
  db.run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'member',?)", acc, m.id, new Date().toISOString());
  assert.equal((await m.c.post('/auth/switch', { account_id: acc })).status, 200);
  db.run("DELETE FROM accounts WHERE id IN (SELECT account_id FROM memberships WHERE user_id=? AND role='owner')", m.id);
  await switchOn(m.c);
  const { c } = await password(m.email);
  assert.deepEqual((await c.post('/auth/two-step/lost', {})).data, { ok: true });
  // The reset by email is for everyone who did not switch it off (the owner's decision), and the admin who can do it
  // faster is named in the same email.
  const mail = mailTo(m.email).at(-1)!;
  assert.equal(mail.subject, 'Reset two-step login of your Sign&Grow login');
  assert.match(mail.html, /Faster: An owner or an admin of your team can switch it off at once/);
  assert.match(mail.html, /Bea Boss/);
});

// ---- Teams ----------------------------------------------------------------------------------------------

test('an owner can ask everyone for two-step login: members without it set it up and can do nothing else there until then', async () => {
  const owner = await person('Tara Team');
  const acc = db.get("SELECT account_id a FROM memberships WHERE user_id=? AND role='owner'", owner.id).a;
  const m = await person('Milo Member');
  db.run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'member',?)", acc, m.id, new Date().toISOString());
  await m.c.post('/auth/switch', { account_id: acc });
  const key = (await m.c.post('/api-keys', { name: 'integration' })).data.key;
  // The owner first.
  const first = await owner.c.post('/account/two-step', { required: true });
  assert.equal(first.status, 409);
  assert.equal(first.data.code, 'set_up_first');
  const o = await switchOn(owner.c);
  assert.equal((await owner.c.post('/account/two-step', { required: true })).data.code, 'code_needed');
  assert.equal((await m.c.post('/account/two-step', { required: true })).status, 403, 'not for an ordinary member');
  const on = await owner.c.post('/account/two-step', { required: true, code: code(o.secret) });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.told, 1);
  assert.ok(mailTo(m.email).some((x) => x.subject === "Tara Team's workspace asks you to use two-step login"));
  // The member, already signed in: nothing in that account opens, and the app knows to show the setup.
  const me = (await m.c.get('/me')).data;
  assert.deepEqual([me.two_step.required, me.two_step.setup_required], [true, true]);
  const blocked = await m.c.get('/envelopes');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'two_step_setup');
  assert.match(blocked.data.error, /Tara Team's workspace asks everyone on the team to sign in with two-step login/);
  // API keys are not affected.
  assert.equal((await browser().call('GET', '/envelopes', undefined, { authorization: `Bearer ${key}` })).status, 200);
  // The next sign-in lands in the same place.
  const fresh = (await password(m.email)).c;
  assert.equal((await fresh.get('/me')).data.two_step.setup_required, true);
  assert.equal((await fresh.get('/contacts')).status, 403);
  // Their own workspace is not affected, and setting it up is allowed.
  const own = db.get("SELECT account_id a FROM memberships WHERE user_id=? AND role='owner'", m.id).a;
  const ms = await switchOn(fresh);
  assert.equal((await fresh.get('/envelopes')).status, 200, 'set up: the account opens');
  assert.equal((await fresh.post('/auth/switch', { account_id: own })).status, 200);
  // While on a team that asks for it, it cannot be switched off.
  const off = await fresh.post('/me/two-step/off', { code: code(ms.secret) });
  assert.equal(off.status, 409);
  assert.equal(off.data.code, 'required_by_team');
  // The owner stops asking: with a code again.
  assert.equal((await owner.c.post('/account/two-step', { required: false, code: code(o.secret) })).data.required, false);
  assert.equal((await fresh.post('/me/two-step/off', { code: code(ms.secret) })).status, 200);
});

// ---- Every way of signing in ------------------------------------------------------------------------------

// A stand-in for Google, as in tests/signin.test.ts, answering only its own hosts.
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
  const start = await go(c, '/auth/google/start?next=%2Fapp%2Fenvelopes');
  const auth = new URL(start.location);
  const t = Math.floor(realNow() / 1000);
  const claims = { iss: 'https://accounts.google.com', aud: G.id, azp: G.id, nonce: auth.searchParams.get('nonce'), iat: t, exp: t + 3600, sub, email, email_verified: true, name: 'Gwen Google' };
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const body = b64(claims);
  const jwt = `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.privateKey).toString('base64url')}`;
  const codeAt = `code-${crypto.randomBytes(6).toString('hex')}`;
  idTokens.set(codeAt, jwt);
  return go(c, `/auth/google/callback?${new URLSearchParams({ code: codeAt, state: auth.searchParams.get('state')! })}`);
}

test('signing in with Google goes through the second step too, and what it did is said after the code', async () => {
  const { c, email } = await person('Gwen Google');
  const { secret } = await switchOn(c);
  const b = browser();
  // Google is connected to this login already (as under Settings, Ways to sign in).
  const sub = `g-${email}`;
  db.run('INSERT INTO identities (id, provider, subject, user_id, email, vouched, created_at) VALUES (?,?,?,?,?,1,?)', `idn_${n}`, 'google', sub, db.get('SELECT id FROM users WHERE email=?', email).id, email, new Date().toISOString());
  const back = await withGoogle(b, email, sub);
  assert.equal(back.status, 302);
  assert.equal(back.location, 'http://test.local/login/two-step');
  assert.equal(signedIn(b), false, 'Google said who it is; the second step is still ours');
  assert.equal((await b.get('/me')).data.user, null);
  const waiting = (await b.get('/auth/two-step')).data;
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.via, 'Google');
  const done = await b.post('/auth/two-step', { code: code(secret) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.next, '/app/envelopes', 'the page asked for at the start is opened after the code');
  assert.ok(signedIn(b));
  assert.equal((await b.get('/me')).data.user.email, email);
});

test('API keys are not affected, and no key can see or change two-step login', async () => {
  const { c } = await person('Kai Key');
  const key = (await c.post('/api-keys', { name: 'k', scope: 'admin' })).data.key;
  await switchOn(c);
  const k = (m: string, u: string, body?: any) => browser().call(m, u, body, { authorization: `Bearer ${key}` });
  assert.equal((await k('GET', '/envelopes')).status, 200);
  await simple(c);
  assert.equal((await k('GET', '/envelopes')).data.envelopes?.length ?? 1, 1);
  for (const [m, u] of [['GET', '/me/two-step'], ['POST', '/me/two-step/off'], ['POST', '/me/two-step/setup'], ['GET', '/account/two-step'], ['POST', '/account/two-step'], ['DELETE', '/me/two-step/devices']]) {
    const r = await k(m, u, m === 'GET' ? undefined : {});
    assert.equal(r.status, 403, `${m} ${u}`);
    assert.match(r.data.error, /An API key cannot see or change two-step login/);
  }
});

test('no route gives a session before the second step is done', async () => {
  const { c, email } = await person('Nadia Nothing');
  await switchOn(c);
  for (const pw of [PW, 'wrong password']) {
    const { c: b } = await password(email, pw);
    assert.ok(b.cookies.sg_twostep);
    const waiting = b.cookies.sg_twostep;
    for (const r of listRoutes()) {
      if (r.path === '/auth/two-step' && r.method === 'POST') continue; // the one that does, with a right code (above)
      const url = r.path.replace(/:(\w+)/g, 'x');
      const res = await handle(new Request(`http://test.local/api${url}`, { method: r.method, headers: { cookie: `sg_twostep=${waiting}`, 'x-forwarded-for': b.ip, 'content-type': 'application/json' }, body: r.method === 'GET' ? undefined : '{}' }));
      const set = res.headers.getSetCookie().find((s) => s.startsWith('ts_session=') && !s.startsWith('ts_session=;'));
      assert.equal(set, undefined, `${r.method} ${r.path} set a session`);
      if (r.level !== 'public') assert.equal(res.status === 401 || res.status === 404, true, `${r.method} ${r.path} answered ${res.status} to a waiting sign-in`);
    }
    // And with nothing but wrong codes, not POST /auth/two-step either.
    assert.equal((await b.post('/auth/two-step', { code: '999999' })).status, 401);
    assert.equal(signedIn(b), false);
  }
});

test('a login without a password sets it up within minutes of signing in, so a browser left signed in is not enough', async () => {
  const b = browser();
  const email = `gina.${n}@gmail.com`;
  const sub = `g-${email}`;
  const back = await withGoogle(b, email, sub);
  assert.equal(back.status, 302);
  assert.ok(signedIn(b), 'a new login, made with Google, and no password');
  const s = await b.post('/me/two-step/setup', {});
  assert.equal(s.status, 200, 'just signed in: allowed');
  db.run('UPDATE sessions SET created_at=? WHERE user_id=(SELECT id FROM users WHERE email=?)', new Date(realNow() - 20 * 60_000).toISOString(), email);
  const late = await b.post('/me/two-step/setup', {});
  assert.equal(late.status, 403);
  assert.equal(late.data.code, 'sign_in_again');
  assert.match(late.data.error, /sign out and sign in again first \(with Google or Microsoft\)/);
  // After a fresh sign-in it works, and from then on Google is followed by the code.
  const again = browser();
  await withGoogle(again, email, sub);
  const s2 = await again.post('/me/two-step/setup', {});
  assert.equal(s2.status, 200);
  assert.equal((await again.post('/me/two-step/confirm', { code: code(s2.data.secret) })).status, 200);
  const third = browser();
  assert.equal((await withGoogle(third, email, sub)).location, 'http://test.local/login/two-step');
  assert.equal(signedIn(third), false);
});

test('the README, /security and /help say what two-step login does, and no page says it does not exist', async () => {
  const fs = await import('node:fs');
  const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const readme = read('README.md');
  const notIn = readme.slice(readme.indexOf('## What is not in it'), readme.indexOf('## Scripts and fonts'));
  assert.doesNotMatch(notIn, /two-factor login of our own|a second step is then whatever/);
  assert.match(readme, /### Two-step login/);
  for (const f of ['src/app/security/page.tsx', 'src/app/help/page.tsx', 'src/app/page.tsx', 'src/app/developers/page.tsx']) assert.doesNotMatch(read(f), /No two-step login|two-factor login of our own|We add none of our own/, f);
  assert.match(read('src/app/security/page.tsx'), /Two-step login with an authenticator app/);
  assert.match(read('src/app/help/page.tsx'), /Lost the phone with your authenticator app/);
});
