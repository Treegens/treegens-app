// The sign-in rules of an account and the leaked-password check (src/server/secpolicy.ts, src/server/pwned.ts,
// src/server/routes-secpolicy.ts, src/lib/signinrules.ts). Pinned down:
//   1. A new password is looked up in the leaked-password list at sign-up, with the emailed link and under Settings.
//      Only the first 5 characters of its SHA-1 leave the server; a list that is down, slow, wrong or switched off
//      lets the password through and nothing says it was checked.
//   2. The rules: shortest password (applied on joining and on every new password, and asked for at the next sign-in
//      of a member whose password is shorter), sign out after minutes of no use (with the time left for the warning
//      and "Stay signed in"), one session at a time. The account the browser is in decides. The owner is never held.
//   3. The card says whether everyone must use two-step login.
//   4. The signing page of an account with the idle rule checks its link again after a break.
//   5. Every change of the rules, and every browser a rule signs out, is a line of the security record.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, Client, signUp, simple, tokenFor } from './helpers.ts';
import { totp, fromBase32, stepAt } from '../src/server/twostep.ts';

const { db } = await boot();
const R = await import('../src/lib/signinrules.ts');
const { pwnedLookup } = await import('../src/server/pwned.ts');
const { t } = await import('../src/lib/i18n.ts');
const PW = 'correct horse battery';

// ---- A stub of the Pwned Passwords range API. Nothing in this file reaches the network. ------------------------

const STUB = 'https://range.stub.test/range/';
const realFetch = globalThis.fetch;
const env0 = { PWNED_CHECK: process.env.PWNED_CHECK, HIBP_RANGE_URL: process.env.HIBP_RANGE_URL };
process.env.PWNED_CHECK = '1';
process.env.HIBP_RANGE_URL = STUB;
after(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(env0)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});
const sha1 = (s: string) => crypto.createHash('sha1').update(s, 'utf8').digest('hex').toUpperCase();
const LEAKED = 'summer-holiday-2019';
let mode: 'list' | 'down' | 'hang' | 'html' | 'error' | 'padded' = 'list';
const asked: { url: string; headers: Record<string, string>; body: unknown }[] = [];
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(STUB)) throw new Error(`This test reaches no network: ${url}`);
  asked.push({ url, headers: Object.fromEntries(new Headers(init.headers || {}).entries()), body: init.body });
  const prefix = url.slice(STUB.length);
  if (mode === 'down') throw new TypeError('fetch failed');
  if (mode === 'error') return new Response('Service unavailable', { status: 503 });
  if (mode === 'html') return new Response('<html><body>Maintenance</body></html>', { status: 200 });
  // A list that never answers. The timer of AbortSignal.timeout does not keep a test process alive, a server does.
  if (mode === 'hang') return new Promise((_, reject) => {
    const alive = setTimeout(() => {}, 10_000);
    init.signal?.addEventListener('abort', () => (clearTimeout(alive), reject(init.signal.reason)));
  });
  // Some lines of the list, the leaked password's among them when its first 5 characters were asked for.
  const lines = ['0018A45C4D1DEF81644B54AB7F969B88D65:3', '00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2'];
  const s = sha1(LEAKED);
  if (prefix === s.slice(0, 5)) lines.push(`${s.slice(5)}:${mode === 'padded' ? 0 : 41}`);
  return new Response(lines.join('\r\n'), { status: 200, headers: { 'content-type': 'text/plain' } });
}) as typeof fetch;

let n = 0;
const ip = () => `198.51.77.${(n++ % 250) + 1}`;
const browser = () => Object.assign(new Client(), { ip: ip() });
const person = async (name: string, email: string) => {
  const c = await signUp(name, email, ip());
  const u = db.get('SELECT id FROM users WHERE email=?', email);
  return { c, email, id: u.id as string, own: db.get("SELECT account_id a FROM memberships WHERE user_id=? AND role='owner'", u.id).a as string };
};
async function invite(admin: Client, email: string, role = 'member') {
  const r = await admin.post('/account/invites', { email, role });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY rowid DESC', email).token as string;
}
async function join(name: string, email: string, tokenText: string, password = PW) {
  const c = browser();
  const r = await c.post('/auth/signup', { name, email, password, invite: tokenText });
  return { c, r };
}
async function login(email: string, password = PW, c = browser()) {
  const r = await c.post('/auth/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}
const rules = (c: Client, body: any) => c.call('PATCH', '/account/rules', body);
const lines = (accountId: string, kind: string) => db.all('SELECT * FROM security_events WHERE account_id=? AND kind=? ORDER BY seq', accountId, kind).map((l: any) => ({ ...l, details: JSON.parse(l.details || '{}') }));
const sessionsOf = (userId: string) => db.all('SELECT * FROM sessions WHERE user_id=? ORDER BY created_at', userId);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** Makes every clock of this person's browsers in this account as if they were last used `minutes` ago. */
const idleFor = (userId: string, minutes: number) => {
  db.run('UPDATE sessions SET seen_at=?, created_at=?, last_used_at=? WHERE user_id=?', ago(minutes), ago(minutes + 1), ago(minutes), userId);
  db.run('UPDATE accounts SET idle_since=? WHERE idle_since IS NOT NULL', ago(24 * 60));
};
/** Every refusal a person reads is two sentences or more, and the last one starts with a verb (charter P10). */
const saysWhatToDo = (text: string) => {
  assert.ok(!/—/.test(text), `no em dash: ${text}`);
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  assert.ok(parts.length >= 2, `two sentences: ${text}`);
};

// The authenticator app's clock: a code works once, so the next one waits for the next 30 seconds.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
after(() => {
  Date.now = realNow;
});
const used = new Map<string, number>();
const code = (secret: string) => {
  const last = used.get(secret);
  if (last !== undefined && last >= stepAt()) skew += (last - stepAt() + 1) * 30_000;
  used.set(secret, stepAt());
  return totp(fromBase32(secret));
};

// ---- 1. The leaked-password check ---------------------------------------------------------------------------

test('1. only the first 5 characters of the SHA-1 leave the server, with padding asked for, and the rest is compared here', async () => {
  asked.length = 0;
  mode = 'list';
  assert.equal(await pwnedLookup(LEAKED), 'leaked');
  assert.equal(await pwnedLookup('a different long password'), 'not_found');
  assert.equal(asked.length, 2);
  const s = sha1(LEAKED);
  assert.equal(asked[0].url, `${STUB}${s.slice(0, 5)}`);
  assert.equal(asked[0].headers['add-padding'], 'true');
  assert.equal(asked[0].body, undefined);
  for (const a of asked) {
    assert.ok(!a.url.includes(s.slice(5, 12)), 'the rest of the fingerprint stays here');
    assert.ok(!JSON.stringify(a).includes(LEAKED));
  }
  // A padded line ("...:0") is nobody's password.
  mode = 'padded';
  assert.equal(await pwnedLookup(LEAKED), 'not_found');
  mode = 'list';
});

test('1. sign-up refuses a leaked password in plain words, before any login is made, and sends no address or name out', async () => {
  asked.length = 0;
  const c = browser();
  const r = await c.post('/auth/signup', { name: 'Lee Leaked', email: 'lee@secpolicy.example', password: LEAKED });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'password_leaked');
  assert.equal(r.data.error, t('en', 'rules.password.leaked'));
  saysWhatToDo(r.data.error);
  assert.ok(!db.get('SELECT 1 x FROM users WHERE email=?', 'lee@secpolicy.example'));
  assert.ok(asked.length === 1 && !JSON.stringify(asked).includes('lee@secpolicy') && !JSON.stringify(asked).includes('Lee'));
  // Another password goes through.
  const ok = await c.post('/auth/signup', { name: 'Lee Leaked', email: 'lee@secpolicy.example', password: 'a long one nobody leaked' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test('1. when the list is down, slow, answers an error or a page that is not the list, the password is allowed and nothing claims a check', async () => {
  for (const m of ['down', 'error', 'html'] as const) {
    mode = m;
    assert.equal(await pwnedLookup(LEAKED), 'not_checked', m);
    const c = browser();
    const r = await c.post('/auth/signup', { name: 'Dee Down', email: `dee-${m}@secpolicy.example`, password: LEAKED });
    assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`);
    assert.doesNotMatch(JSON.stringify(r.data), /leak|breach|pwned|checked/i);
  }
  // No answer within 3 seconds: the wait ends there.
  mode = 'hang';
  const t0 = realNow();
  assert.equal(await pwnedLookup(LEAKED), 'not_checked');
  const took = realNow() - t0;
  assert.ok(took >= R.PWNED_TIMEOUT_MS - 100 && took < R.PWNED_TIMEOUT_MS + 1500, `waited ${took} ms`);
  mode = 'list';
});

test('1. PWNED_CHECK=0 switches the check off and nothing is asked; HIBP_RANGE_URL must be an http(s) address', async () => {
  asked.length = 0;
  process.env.PWNED_CHECK = '0';
  try {
    assert.equal(await pwnedLookup(LEAKED), 'not_checked');
    const c = browser();
    assert.equal((await c.post('/auth/signup', { name: 'Oli Off', email: 'oli@secpolicy.example', password: LEAKED })).status, 200);
    assert.equal(asked.length, 0);
  } finally {
    process.env.PWNED_CHECK = '1';
  }
  assert.equal(R.pwnedUrl({}), R.PWNED_DEFAULT_URL);
  assert.equal(R.pwnedUrl({ HIBP_RANGE_URL: 'https://mirror.example/range' }), 'https://mirror.example/range/');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/', 'https://a b/']) assert.equal(R.pwnedUrl({ HIBP_RANGE_URL: bad }), null, bad);
  for (const off of ['0', 'off', 'false', 'no', ' OFF ']) assert.equal(R.pwnedUrl({ PWNED_CHECK: off }), null, off);
});

test('1. the emailed link and Settings refuse a leaked password too; the link still works and the code typed is not used up', async () => {
  mode = 'list';
  const p = await person('Rae Reset', 'rae@secpolicy.example');
  // The emailed link.
  assert.equal((await browser().post('/auth/forgot', { email: p.email })).status, 200);
  const link = db.all('SELECT link FROM emails WHERE to_email=? ORDER BY id', p.email).map((e: any) => e.link).filter((l: string) => /reset/.test(l || '')).pop();
  const tok = new URL(link).searchParams.get('token') || link.split('/').pop();
  const refused = await browser().post('/auth/reset', { token: tok, password: LEAKED });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.code, 'password_leaked');
  const ok = await browser().post('/auth/reset', { token: tok, password: 'a fresh long password' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // Settings, with two-step login on: the refusal comes before the code is asked for, so the code still works.
  const c = await login(p.email, 'a fresh long password');
  const s = await c.post('/me/two-step/setup', { password: 'a fresh long password' });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const secret = s.data.secret;
  assert.equal((await c.post('/me/two-step/confirm', { code: code(secret) })).status, 200);
  const typed = code(secret);
  const no = await c.post('/me/password', { current: 'a fresh long password', password: LEAKED, code: typed });
  assert.equal(no.status, 400);
  assert.equal(no.data.code, 'password_leaked');
  const yes = await c.post('/me/password', { current: 'a fresh long password', password: 'another fresh long one', code: typed });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
});

// ---- 2. The rules of an account -------------------------------------------------------------------------------

test('2. owner and admins read and change the rules in a browser; members and API keys cannot; numbers outside the limits are refused in words', async () => {
  const o = await person('Olga Owner', 'olga@secpolicy.example');
  const got = await o.c.get('/account/rules');
  assert.equal(got.status, 200);
  assert.deepEqual({ min: got.data.min_password_length, idle: got.data.idle_minutes, one: got.data.one_session }, { min: 8, idle: null, one: false });
  assert.deepEqual(got.data.limits, { password: [8, 64], idle_minutes: [15, 480], warn_seconds: 120 });
  assert.equal(got.data.leak_check, true);
  const mem = await join('Milo Member', 'milo@secpolicy.example', await invite(o.c, 'milo@secpolicy.example'));
  assert.equal(mem.r.status, 200, JSON.stringify(mem.r.data));
  assert.equal((await mem.c.get('/account/rules')).status, 403);
  assert.equal((await rules(mem.c, { min_password_length: 9 })).status, 403);
  const key = (await o.c.post('/api-keys', { name: 'admin key', scope: 'admin' })).data.key;
  const viaKey = new Client();
  viaKey.ip = ip();
  const k = await viaKey.call('PATCH', '/account/rules', { min_password_length: 9 }, { authorization: `Bearer ${key}` });
  assert.equal(k.status, 403);
  saysWhatToDo(k.data.error);
  for (const [body, field] of [[{ min_password_length: 7 }, 'min_password_length'], [{ min_password_length: 65 }, 'min_password_length'], [{ min_password_length: '12abc' }, 'min_password_length'], [{ min_password_length: 9.5 }, 'min_password_length'],
    [{ idle_minutes: 14 }, 'idle_minutes'], [{ idle_minutes: 481 }, 'idle_minutes'], [{ idle_minutes: -5 }, 'idle_minutes'], [{ one_session: 'yes' }, 'one_session']] as const) {
    const r = await rules(o.c, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.field, field);
    saysWhatToDo(r.data.error);
  }
  assert.equal(db.get('SELECT min_password_length m, idle_minutes i, one_session s FROM accounts WHERE id=?', o.own).m, null);
  const ok = await rules(o.c, { min_password_length: '12', idle_minutes: 30, one_session: false });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual([ok.data.min_password_length, ok.data.idle_minutes, ok.data.one_session], [12, 30, false]);
  // Off again: null, 0, false or an empty box.
  for (const off of [null, 0, false, '']) {
    await rules(o.c, { idle_minutes: 45 });
    assert.equal((await rules(o.c, { idle_minutes: off })).data.idle_minutes, null, String(off));
  }
});

test('2. the shortest password applies when someone joins and to every new password, with the name of the team that asks it', async () => {
  const o = await person('Pia Owner', 'pia@secpolicy.example');
  assert.equal((await rules(o.c, { min_password_length: 16 })).status, 200);
  const tok = await invite(o.c, 'jo@secpolicy.example');
  const short = await join('Jo Joiner', 'jo@secpolicy.example', tok, 'fifteen chars!!');
  assert.equal(short.r.status, 400);
  assert.equal(short.r.data.code, 'password_too_short');
  assert.equal(short.r.data.min, 16);
  assert.match(short.r.data.error, /at least 16 characters/);
  assert.match(short.r.data.error, /Pia Owner/);
  saysWhatToDo(short.r.data.error);
  // Without the invitation, the same password is fine: the rule belongs to the team.
  assert.equal((await browser().post('/auth/signup', { name: 'Free Agent', email: 'free@secpolicy.example', password: 'fifteen chars!!' })).status, 200);
  const jo = await join('Jo Joiner', 'jo@secpolicy.example', tok, 'sixteen chars!!!');
  assert.equal(jo.r.status, 200, JSON.stringify(jo.r.data));
  // Settings and the emailed link: shorter than the longest rule of the person's teams is refused.
  const ch = await jo.c.post('/me/password', { current: 'sixteen chars!!!', password: 'only 12 char' });
  assert.equal(ch.status, 400);
  assert.equal(ch.data.code, 'password_too_short');
  assert.equal((await jo.c.post('/me/password', { current: 'sixteen chars!!!', password: 'now seventeen ch!' })).status, 200);
  assert.equal((await browser().post('/auth/forgot', { email: 'jo@secpolicy.example' })).status, 200);
  const link = db.all('SELECT link FROM emails WHERE to_email=? ORDER BY id', 'jo@secpolicy.example').map((e: any) => e.link).filter((l: string) => /reset/.test(l || '')).pop();
  const rt = new URL(link).searchParams.get('token');
  assert.equal((await browser().post('/auth/reset', { token: rt, password: 'short again' })).data.code, 'password_too_short');
  assert.equal((await browser().post('/auth/reset', { token: rt, password: 'long enough again!!' })).status, 200);
});

test('2. a member whose password is shorter is asked for a longer one at the next sign-in, and nothing else of that team opens until then', async () => {
  const o = await person('Quin Owner', 'quin@secpolicy.example');
  const m = await join('Mae Member', 'mae@secpolicy.example', await invite(o.c, 'mae@secpolicy.example'));
  assert.equal(m.r.status, 200);
  const other = await person('Other Team', 'other@secpolicy.example');
  await invite(other.c, 'mae@secpolicy.example');
  assert.equal((await rules(o.c, { min_password_length: 24 })).status, 200);
  // The browser already signed in is not asked: the password is only known at sign-in.
  assert.equal((await m.c.get('/envelopes')).status, 200);
  const c = await login('mae@secpolicy.example');
  const me = (await c.get('/me')).data;
  assert.equal(me.rules.password_needed, 24);
  const held = await c.get('/envelopes');
  assert.equal(held.status, 403);
  assert.equal(held.data.code, 'password_too_short');
  saysWhatToDo(held.data.error);
  // What concerns their own login stays open: choosing the password, leaving, going to another workspace.
  assert.equal((await c.get('/me/sessions')).status, 200);
  // A shorter one is refused, a long one opens everything at once.
  assert.equal((await c.post('/me/password', { current: PW, password: 'twenty-three characters' })).data.code, 'password_too_short');
  assert.equal((await c.post('/me/password', { current: PW, password: 'twenty-four characters!!' })).status, 200);
  assert.equal((await c.get('/me')).data.rules.password_needed, null);
  assert.equal((await c.get('/envelopes')).status, 200);
  assert.equal(db.get('SELECT pw_below FROM users WHERE email=?', 'mae@secpolicy.example').pw_below, null);
});

test('2. the owner is never held by the password rule: the card tells them, and every other rule only signs them out', async () => {
  const o = await person('Rhea Owner', 'rhea@secpolicy.example');
  assert.equal((await rules(o.c, { min_password_length: 30 })).status, 200);
  const c = await login(o.email);
  const me = (await c.get('/me')).data;
  assert.equal(me.rules.password_needed, null);
  assert.equal(me.rules.password_short, 30);
  assert.equal((await c.get('/envelopes')).status, 200);
  assert.equal((await c.get('/account/rules')).status, 200);
  // The owner can always loosen the rule again.
  assert.equal((await rules(c, { min_password_length: 8 })).status, 200);
});

test('2. sign out after minutes of no use: the time left for the warning, "Stay signed in", and the sign-out with its reason once', async () => {
  const o = await person('Sid Owner', 'sid@secpolicy.example');
  const m = await join('Ivy Idle', 'ivy@secpolicy.example', await invite(o.c, 'ivy@secpolicy.example'));
  const ivy = db.get('SELECT id FROM users WHERE email=?', 'ivy@secpolicy.example').id;
  assert.equal((await m.c.get('/me/idle')).data.minutes, null);
  assert.equal((await rules(o.c, { idle_minutes: 15 })).status, 200);
  // Switching the rule on starts every clock now: nobody is signed out for the time before it.
  idleFor(ivy, 60);
  db.run('UPDATE accounts SET idle_since=? WHERE id=?', ago(1), o.own);
  assert.equal((await m.c.get('/envelopes')).status, 200);
  // The page's own quiet look at the clock is not use.
  idleFor(ivy, 13.5);
  const left = (await m.c.call('GET', '/me/idle', undefined, { [R.QUIET_HEADER]: '1' })).data;
  assert.equal(left.minutes, 15);
  assert.ok(left.seconds_left > 60 && left.seconds_left <= 90, String(left.seconds_left));
  assert.equal(R.warnNow(left.seconds_left), true);
  const again = (await m.c.call('GET', '/me/idle', undefined, { [R.QUIET_HEADER]: '1' })).data;
  assert.ok(again.seconds_left <= left.seconds_left);
  // "Stay signed in" starts the clock again.
  const stay = (await m.c.post('/me/idle/stay')).data;
  assert.ok(stay.seconds_left > 14 * 60, String(stay.seconds_left));
  assert.equal(R.warnNow(stay.seconds_left), false);
  // Past the limit: signed out, told why, and the sign-in page hears it once.
  idleFor(ivy, 16);
  const out = await m.c.get('/envelopes');
  assert.equal(out.status, 401);
  assert.deepEqual([out.data.code, out.data.why], ['signed_out', 'idle']);
  assert.equal(out.data.error, t('en', 'rules.out.idle'));
  assert.equal(sessionsOf(ivy).length, 0);
  // Every page that asks with that cookie hears it (two at once both do), until the browser signs in again.
  for (let i = 0; i < 2; i++) assert.deepEqual(Object.values((({ user, signed_out }) => ({ user, signed_out }))((await m.c.get('/me')).data)), [null, 'idle']);
  assert.equal(R.signedOutWords('idle'), t('en', 'rules.out.idle'));
  assert.equal(R.signedOutWords('<script>'), '');
  const line = lines(o.own, 'session.ended').pop();
  assert.deepEqual([line.actor_type, line.about_id, line.details.how, line.details.minutes], ['system', ivy, 'idle', 15]);
  // Signing in again works at once, and the new cookie hears nothing of the old one.
  assert.equal((await login('ivy@secpolicy.example', PW, m.c).then((c) => c.get('/envelopes'))).status, 200);
  assert.equal((await m.c.get('/me')).data.signed_out, undefined);
});

test('2. the account the browser is in decides: a person on two teams is held by the rule of the one they work in', async () => {
  const a = await person('Tia Strict', 'tia@secpolicy.example');
  const b = await person('Ugo Easy', 'ugo@secpolicy.example');
  const both = await join('Val Both', 'val@secpolicy.example', await invite(a.c, 'val@secpolicy.example'));
  const val = db.get('SELECT id FROM users WHERE email=?', 'val@secpolicy.example').id;
  const tb = await invite(b.c, 'val@secpolicy.example');
  assert.equal((await both.c.post('/invites/accept', { token: tb })).status, 200);
  assert.equal((await rules(a.c, { idle_minutes: 20 })).status, 200);
  // In the easy team, an hour without use signs nobody out.
  assert.equal((await both.c.post('/auth/switch', { account_id: b.own })).status, 200);
  assert.equal((await both.c.get('/envelopes')).status, 200);
  idleFor(val, 60);
  assert.equal((await both.c.get('/envelopes')).status, 200);
  assert.equal((await both.c.get('/me/idle')).data.minutes, null);
  // Arriving in the strict team starts a fresh clock there, and from then on its rule counts.
  idleFor(val, 60);
  assert.equal((await both.c.post('/auth/switch', { account_id: a.own })).status, 200);
  assert.equal((await both.c.get('/envelopes')).status, 200);
  assert.equal((await both.c.get('/me/idle')).data.minutes, 20);
  idleFor(val, 21);
  assert.equal((await both.c.get('/envelopes')).data.why, 'idle');
});

test('2. one session at a time: a new sign-in signs the other browsers out of that team, with a note; API keys keep working', async () => {
  const o = await person('Wyn Owner', 'wyn@secpolicy.example');
  const first = await join('Xan One', 'xan@secpolicy.example', await invite(o.c, 'xan@secpolicy.example'));
  const xan = db.get('SELECT id FROM users WHERE email=?', 'xan@secpolicy.example').id;
  const second = await login('xan@secpolicy.example');
  assert.equal((await first.c.get('/envelopes')).status, 200);
  assert.equal((await second.get('/envelopes')).status, 200);
  const key = (await first.c.post('/api-keys', { name: 'sync' })).data.key;
  // Switching it on signs out every extra browser at once, keeping the one used last and the admin's own.
  const extra = await login(o.email);
  const on = await rules(o.c, { one_session: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.signed_out, 2);
  assert.equal((await o.c.get('/envelopes')).status, 200);
  assert.equal((await extra.get('/envelopes')).data.why, 'elsewhere');
  assert.equal(sessionsOf(xan).length, 1);
  const kept = (await second.get('/envelopes')).status === 200 ? second : first.c;
  const gone = kept === second ? first.c : second;
  const said = await gone.get('/envelopes');
  assert.deepEqual([said.status, said.data.why], [401, 'elsewhere']);
  assert.equal(said.data.error, t('en', 'rules.out.elsewhere'));
  // A new sign-in now signs the kept browser out.
  const third = await login('xan@secpolicy.example');
  assert.equal((await third.get('/envelopes')).status, 200);
  assert.equal((await kept.get('/envelopes')).data.why, 'elsewhere');
  assert.equal(sessionsOf(xan).length, 1);
  const k = new Client();
  k.ip = ip();
  assert.equal((await k.call('GET', '/envelopes', undefined, { authorization: `Bearer ${key}` })).status, 200);
  const l = lines(o.own, 'session.ended').filter((x: any) => x.details.how === 'signed_in_elsewhere');
  assert.ok(l.length >= 2);
  assert.equal(lines(o.own, 'settings.changed').pop().details.browsers_signed_out, 2);
});

test('2. one session at a time belongs to its team: a browser in another workspace of the same person stays signed in', async () => {
  const a = await person('Yara Strict', 'yara@secpolicy.example');
  const b = await person('Zack Other', 'zack@secpolicy.example');
  const p = await join('Abe Both', 'abe@secpolicy.example', await invite(a.c, 'abe@secpolicy.example'));
  assert.equal((await p.c.post('/invites/accept', { token: await invite(b.c, 'abe@secpolicy.example') })).status, 200);
  assert.equal((await rules(a.c, { one_session: true })).status, 200);
  // Browser 1 works in the other team; browser 2 arrives in the strict one.
  assert.equal((await p.c.post('/auth/switch', { account_id: b.own })).status, 200);
  assert.equal((await p.c.get('/envelopes')).status, 200);
  const two = await login('abe@secpolicy.example');
  assert.equal((await two.post('/auth/switch', { account_id: a.own })).status, 200);
  assert.equal((await two.get('/envelopes')).status, 200);
  assert.equal((await p.c.get('/envelopes')).status, 200);
  // Browser 1 arriving in the strict team signs browser 2 out of it.
  assert.equal((await p.c.post('/auth/switch', { account_id: a.own })).status, 200);
  assert.equal((await p.c.get('/envelopes')).status, 200);
  assert.equal((await two.get('/envelopes')).data.why, 'elsewhere');
});

test('2. a host who handed the device over for a long in-person signing is not signed out the moment they unlock it', async () => {
  const o = await person('Bea Host', 'bea@secpolicy.example');
  assert.equal((await rules(o.c, { idle_minutes: 15 })).status, 200);
  const host = await login(o.email);
  const e = await simple(host, 'walkin@secpolicy.example', { recipients: [{ id: 'r', role: 'inperson', name: 'Walk In', email: 'walkin@secpolicy.example' }] });
  assert.equal((await host.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await host.get(`/sign/${tokenFor(e.id, 'walkin@secpolicy.example')}`)).status, 200);
  assert.equal((await host.get('/envelopes')).status, 401);
  // Twenty minutes with the signer, then the host types their password.
  const sid = db.get('SELECT id FROM sessions WHERE user_id=(SELECT id FROM users WHERE email=?) AND locked_at IS NOT NULL', o.email).id;
  db.run('UPDATE sessions SET seen_at=?, created_at=? WHERE id=?', ago(20), ago(21), sid);
  db.run('UPDATE accounts SET idle_since=? WHERE id=?', ago(60), o.own);
  assert.equal((await host.post('/auth/unlock', { password: PW })).status, 200);
  assert.equal((await host.get('/envelopes')).status, 200);
});

test('2. the app goes to the sign-in page with the reason; only the two known reasons and a path of this site travel', () => {
  assert.equal(R.signedOutPath('idle', '/app/envelopes?x=1'), `/login?out=idle&next=${encodeURIComponent('/app/envelopes?x=1')}`);
  assert.equal(R.signedOutPath('elsewhere', '/app'), '/login?out=elsewhere&next=%2Fapp');
  assert.equal(R.signedOutPath('<b>hi</b>', '/app'), '/login?next=%2Fapp');
  assert.equal(R.signedOutPath(undefined, '//evil.example/x'), '/login');
  assert.equal(R.signedOutPath('idle', 'https://evil.example'), '/login?out=idle');
  assert.equal(R.leftWords(119), t('en', 'rules.left.minutes', { count: 2 }));
  assert.equal(R.leftWords(30), t('en', 'rules.left.under_minute'));
  assert.equal(R.warnNow(121), false);
  assert.equal(R.warnNow(120), true);
  assert.equal(R.warnNow(null), false);
});

// ---- 3. Two-step login for everyone, in the same card -----------------------------------------------------

test('3. the card says whether everyone must use two-step login, and changing the rules asks for the code of someone who has it', async () => {
  const o = await person('Cy Twostep', 'cy@secpolicy.example');
  assert.equal((await o.c.get('/account/rules')).data.two_step_required, false);
  const s = await o.c.post('/me/two-step/setup', { password: PW });
  const secret = s.data.secret;
  assert.equal((await o.c.post('/me/two-step/confirm', { code: code(secret) })).status, 200);
  assert.equal((await o.c.post('/account/two-step', { required: true, code: code(secret) })).status, 200);
  const got = (await o.c.get('/account/rules')).data;
  assert.equal(got.two_step_required, true);
  assert.equal(got.code_needed, true);
  const no = await rules(o.c, { idle_minutes: 60 });
  assert.equal(no.status, 403);
  assert.equal(no.data.code, 'code_needed');
  saysWhatToDo(no.data.error);
  assert.equal(db.get('SELECT idle_minutes i FROM accounts WHERE id=?', o.own).i, null);
  assert.equal((await rules(o.c, { idle_minutes: 60, code: code(secret) })).status, 200);
  // Sending what is already set changes nothing and asks for nothing.
  assert.equal((await rules(o.c, { idle_minutes: 60 })).status, 200);
});

// ---- 4. The signing page after a break -----------------------------------------------------------------------

test('4. the signing page hears the minutes only in an account with the rule, and its second look refuses a link that no longer opens', async () => {
  const o = await person('Di Sender', 'di@secpolicy.example');
  const e = await simple(o.c, 'signer1@secpolicy.example');
  assert.equal((await o.c.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = tokenFor(e.id, 'signer1@secpolicy.example');
  const signer = browser();
  const v = (await signer.get(`/sign/${tok}`)).data;
  assert.equal(v.envelope.status, 'sent');
  assert.equal('away_minutes' in v, false);
  assert.equal((await signer.get(`/sign/${tok}/away`)).data.minutes, null);
  assert.equal((await rules(o.c, { idle_minutes: 20 })).status, 200);
  const w = (await signer.get(`/sign/${tok}`)).data;
  assert.equal(w.away_minutes, 20);
  const look = (await signer.get(`/sign/${tok}/away`)).data;
  assert.deepEqual([look.ok, look.minutes, look.status, look.done], [true, 20, 'sent', false]);
  assert.equal(look.version, w.version ?? null);
  // Cancelled meanwhile: the answer says so, so the page loads again and shows it.
  assert.equal((await o.c.post(`/envelopes/${e.id}/void`, { reason: 'Wrong file' })).status, 200);
  assert.equal((await signer.get(`/sign/${tok}/away`)).data.status, 'voided');
  // A link that is not known any more is refused in the words of the page.
  const gone = await signer.get('/sign/not-a-real-token/away');
  assert.equal(gone.status, 404);
  assert.equal(gone.data.error, (await signer.get('/sign/not-a-real-token')).data.error);
  // The words of the line, in the signer's language.
  assert.equal(R.awayTooLong(0, 20 * 60_000 + 1, 20), true);
  assert.equal(R.awayTooLong(0, 20 * 60_000, 20), false);
  assert.equal(R.awayTooLong(0, 10 ** 9, null), false);
  assert.match(t('en', 'rules.away.checked'), /^You were away for a while, so we checked the link again\.$/);
});

// ---- 5. The security record ------------------------------------------------------------------------------

test('5. every change of the rules is one line with what it was and is, in words; nothing is written when nothing changed', async () => {
  const { securityDetail } = await import('../src/lib/seclog.ts');
  const o = await person('Ed Record', 'ed@secpolicy.example');
  const before = lines(o.own, 'settings.changed').length;
  assert.equal((await rules(o.c, { min_password_length: 14, idle_minutes: 30, one_session: true })).status, 200);
  const l = lines(o.own, 'settings.changed').pop();
  assert.equal(lines(o.own, 'settings.changed').length, before + 1);
  assert.deepEqual(l.details.settings, { min_length: { from: 8, to: 14 }, idle_minutes: { from: false, to: 30 }, one_session: { from: false, to: true } });
  assert.deepEqual([l.actor_type, l.actor_id], ['user', db.get('SELECT id FROM users WHERE email=?', o.email).id]);
  const words = securityDetail('settings.changed', l.details).join(' ');
  for (const label of ['security.setting.min_length', 'security.setting.idle_minutes', 'security.setting.one_session']) assert.ok(words.includes(t('en', label)), `${label}: ${words}`);
  assert.doesNotMatch(words, /min_length|idle_minutes|one_session/);
  // The same again: no line.
  assert.equal((await rules(o.c, { min_password_length: 14, idle_minutes: 30, one_session: true })).status, 200);
  assert.equal(lines(o.own, 'settings.changed').length, before + 1);
  // Off again: one more line, from 30 to off.
  assert.equal((await rules(o.c, { idle_minutes: null })).status, 200);
  assert.deepEqual(lines(o.own, 'settings.changed').pop().details.settings, { idle_minutes: { from: 30, to: false } });
  // The sign-outs a rule makes are said in words too.
  assert.match(securityDetail('session.ended', { how: 'idle', minutes: 30 }).join(' '), /30 minutes/);
  assert.match(securityDetail('session.ended', { how: 'signed_in_elsewhere', browsers: 2 }).join(' '), /2 other browsers/);
});

test('6. the card explains why there is no forced expiry or character mix, and no such rule exists', () => {
  const body = t('en', 'rules.why.body');
  assert.match(body, /SP 800-63B/);
  assert.match(t('en', 'rules.why.summary'), /no forced password change and no rule about capitals or digits/);
  for (const k of Object.keys(R)) assert.doesNotMatch(k, /expir|upper|digit|question/i);
  // Nothing in any locale key or text uses an em dash.
  for (const k of ['rules.why.body', 'rules.leak.on', 'rules.idle.hint', 'rules.one.hint', 'rules.warn.text', 'rules.short.body', 'rules.password.gate']) assert.doesNotMatch(t('en', k, { account: 'X', min: 9, count: 2, left: 'soon', lo: 1, hi: 2 }), /—/);
});

// ---- After review: the skeptic's and the simplicity reviewer's findings -----------------------------------------

test('review. lowering the shortest password keeps holding a member who may still be too short, until their password is typed again', async () => {
  const o = await person('Lou Lower', 'rv-lou@secpolicy.example');
  const m = await join('Kit Short', 'rv-kit@secpolicy.example', await invite(o.c, 'rv-kit@secpolicy.example'), 'fourteen chars');
  assert.equal(m.r.status, 200, JSON.stringify(m.r.data));
  const j = await join('Jo Fifteen', 'rv-jo@secpolicy.example', await invite(o.c, 'rv-jo@secpolicy.example'), 'fifteen chars!!');
  assert.equal(j.r.status, 200, JSON.stringify(j.r.data));
  assert.equal((await rules(o.c, { min_password_length: 16 })).status, 200);
  const kit = await login('rv-kit@secpolicy.example', 'fourteen chars');
  const jo = await login('rv-jo@secpolicy.example', 'fifteen chars!!');
  assert.equal((await kit.get('/envelopes')).status, 403);
  assert.equal((await jo.get('/envelopes')).status, 403);
  // Down to 15: the 14-character password is still too short, so nothing opens for Kit (the skeptic's probe P7).
  assert.equal((await rules(o.c, { min_password_length: 15 })).status, 200);
  const held = await kit.get('/envelopes');
  assert.deepEqual([held.status, held.data.code, held.data.min], [403, 'password_too_short', 15]);
  // Jo is long enough for 15. Signing in again shows it, and lets Jo in at once.
  const jo2 = await login('rv-jo@secpolicy.example', 'fifteen chars!!');
  assert.equal((await jo2.get('/envelopes')).status, 200);
  // Kit signs in again: still held under 15, told the right number.
  const kit2 = await login('rv-kit@secpolicy.example', 'fourteen chars');
  assert.equal((await kit2.get('/me')).data.rules.password_needed, 15);
  // Rule off: nobody is held.
  assert.equal((await rules(o.c, { min_password_length: 8 })).status, 200);
  assert.equal((await kit2.get('/envelopes')).status, 200);
});

test('review. typing the current password to change it is a moment it is looked at again: a long-enough member is released', async () => {
  const o = await person('Mo Release', 'rv-mo@secpolicy.example');
  const m = await join('Nia Exact', 'rv-nia@secpolicy.example', await invite(o.c, 'rv-nia@secpolicy.example'), 'fifteen chars!!');
  assert.equal((await rules(o.c, { min_password_length: 20 })).status, 200);
  const c = await login('rv-nia@secpolicy.example', 'fifteen chars!!');
  assert.equal((await c.get('/envelopes')).status, 403);
  assert.equal((await rules(o.c, { min_password_length: 15 })).status, 200);
  assert.equal((await c.get('/envelopes')).status, 403);
  // The change itself is refused (leaked), but the current password was typed and is long enough for 15.
  const r = await c.post('/me/password', { current: 'fifteen chars!!', password: LEAKED });
  assert.equal(r.data.code, 'password_leaked');
  assert.equal((await c.get('/envelopes')).status, 200);
  void m;
});

test('review. the page waiting for an email to be confirmed looks quietly: it does not keep an idle browser signed in', async () => {
  const o = await person('Pat Quiet', 'rv-pat@secpolicy.example');
  const m = await join('Rae Unconfirmed', 'rv-rae@secpolicy.example', await invite(o.c, 'rv-rae@secpolicy.example'));
  const rae = db.get('SELECT id FROM users WHERE email=?', 'rv-rae@secpolicy.example').id;
  assert.equal((await rules(o.c, { idle_minutes: 15 })).status, 200);
  const first = await m.c.get('/envelopes');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  idleFor(rae, 10);
  const seen = db.get('SELECT seen_at FROM sessions WHERE user_id=?', rae).seen_at;
  // The look every 15 seconds (useConfirmedElsewhere) sends the quiet header, as the app shell's reload(true) does.
  for (let i = 0; i < 3; i++) assert.ok((await m.c.call('GET', '/me', undefined, { [R.QUIET_HEADER]: '1' })).data.user);
  assert.equal(db.get('SELECT seen_at FROM sessions WHERE user_id=?', rae).seen_at, seen);
  idleFor(rae, 16);
  assert.equal((await m.c.call('GET', '/me', undefined, { [R.QUIET_HEADER]: '1' })).data.signed_out, 'idle');
  // The source keeps the quiet look: a later edit that drops it would keep such tabs signed in for ever.
  const fs = await import('node:fs');
  assert.match(fs.readFileSync(new URL('../src/components/ConfirmEmail.tsx', import.meta.url), 'utf8'), /setInterval\(\(\) => document\.visibilityState === 'visible' && latest\.current\(true\)/);
  assert.match(fs.readFileSync(new URL('../src/components/AppShell.tsx', import.meta.url), 'utf8'), /quiet === true \? \{ headers: \{ \[QUIET_HEADER\]: '1' \} \}/);
});

test('review. the sign-in page says "you were signed out" only when the server says so for this browser', async () => {
  const o = await person('Sam Notice', 'rv-sam@secpolicy.example');
  const me = (await o.c.get('/me')).data;
  // Signed in, with ?out=elsewhere in the address: nothing is said.
  assert.equal(R.signedOutNotice('elsewhere', me), '');
  // Not signed in and nothing ended this browser: nothing is said (a link someone sent).
  assert.equal(R.signedOutNotice('elsewhere', (await browser().get('/me')).data), '');
  // The reason must match what the server says.
  assert.equal(R.signedOutNotice('elsewhere', { user: null, signed_out: 'idle' }), '');
  assert.equal(R.signedOutNotice('idle', { user: null, signed_out: 'idle' }), t('en', 'rules.out.idle'));
  assert.equal(R.signedOutNotice(null, { user: null, signed_out: 'idle' }), '');
  assert.equal(R.signedOutNotice('<b>x</b>', { user: null, signed_out: '<b>x</b>' }), '');
});

test('review. /app/operator hears when the leaked-password check is off, and why; nobody else can ask', async () => {
  const op = await person('Opal Operator', 'rv-opal@secpolicy.example');
  const other = await person('Ola Other', 'rv-ola@secpolicy.example');
  const was = { OPERATOR_EMAILS: process.env.OPERATOR_EMAILS, PWNED_CHECK: process.env.PWNED_CHECK };
  const g = globalThis as any;
  const off0 = g.__sgOutsideOff;
  process.env.OPERATOR_EMAILS = 'rv-opal@secpolicy.example';
  try {
    assert.equal((await other.c.get('/operator/leak-check')).status, 404);
    assert.equal((await browser().get('/operator/leak-check')).status, 401);
    assert.deepEqual((await op.c.get('/operator/leak-check')).data, { on: true, why: null });
    process.env.PWNED_CHECK = '0';
    assert.deepEqual((await op.c.get('/operator/leak-check')).data, { on: false, why: 'setting' });
    g.__sgOutsideOff = [{ id: 'pwned', name: 'List of leaked passwords', settings: [] }];
    assert.deepEqual((await op.c.get('/operator/leak-check')).data, { on: false, why: 'outside_calls' });
  } finally {
    g.__sgOutsideOff = off0;
    for (const [k, v] of Object.entries(was)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test('review. "Where you are signed in" says when the team signs browsers out sooner; with no rule it says nothing new', () => {
  assert.equal(R.teamSessionWords(null, 'Acme'), '');
  assert.equal(R.teamSessionWords({ idle_minutes: null, one_session: false }, 'Acme'), '');
  assert.match(R.teamSessionWords({ idle_minutes: 30, one_session: false }, 'Acme'), /^Acme signs a browser out after 30 minutes of no use\. /);
  assert.match(R.teamSessionWords({ idle_minutes: null, one_session: true }, 'Acme'), /signing in on another browser signs this one out/);
  assert.doesNotMatch(R.teamSessionWords({ idle_minutes: 15, one_session: true }, 'Acme'), /—/);
});

test('review. the card: one control for "Sign out after", hints outside the labels, the link lands on two-step, short plain words', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/components/settings/SecurityPolicy.tsx', import.meta.url), 'utf8');
  // One select, no checkbox, for sign out after; Never first.
  assert.match(src, /<select id="sp-idle"/);
  assert.doesNotMatch(src, /idle_on/);
  assert.deepEqual(R.IDLE_CHOICES, [15, 30, 60, 120, 240, 480]);
  for (const m of R.IDLE_CHOICES) assert.ok(m >= R.IDLE_MIN_MINUTES && m <= R.IDLE_MAX_MINUTES);
  assert.equal(t('en', 'rules.idle.hours', { count: 1 }), '1 hour of no use');
  assert.equal(t('en', 'rules.idle.minutes', { count: 15 }), '15 minutes of no use');
  // No hint inside a <label>: each label closes before its hint starts.
  for (const id of ['sp-min-hint', 'sp-idle-hint', 'sp-one-hint']) {
    const at = src.indexOf(`id="${id}"`);
    assert.ok(at > 0, id);
    assert.ok(src.lastIndexOf('</label>', at) > src.lastIndexOf('<label', at), `${id} sits outside its label`);
  }
  // "Change this under Team" goes to the two-step section itself.
  assert.equal(R.TEAM_TWO_STEP_HREF, '/app/settings?tab=team#team-two-step');
  assert.match(fs.readFileSync(new URL('../src/app/app/settings/TwoStep.tsx', import.meta.url), 'utf8'), /id=\{TEAM_TWO_STEP_ID\}/);
  // Words: the leak line is one sentence; the fallback error says what to do; the record line reads well.
  assert.equal(t('en', 'rules.leak.on'), 'New passwords that have appeared in a data leak are refused.');
  saysWhatToDo(t('en', 'rules.short.failed'));
  assert.match(t('en', 'rules.short.failed'), /Check your connection and try again\.$/);
  assert.equal(t('en', 'security.setting.idle_minutes'), 'Minutes of no use before signing out');
  // A number set through the API that is not one of the choices is refused or kept, never silently changed.
  const o = await person('Una Api', 'rv-una@secpolicy.example');
  assert.equal((await rules(o.c, { idle_minutes: 45 })).status, 200);
  assert.equal((await o.c.get('/account/rules')).data.idle_minutes, 45);
  const bad = await rules(o.c, { idle_minutes: 14 });
  assert.deepEqual([bad.status, bad.data.field], [400, 'idle_minutes']);
  saysWhatToDo(bad.data.error);
  assert.match(bad.data.error, /It is still 45 minutes\.$/);
});
