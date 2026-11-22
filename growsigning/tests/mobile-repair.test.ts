// Repairs to the phone work, from what a skeptic proved broken (research/verify-new.json, "verify:mobile"): the
// hand-over lock counted guesses sent at once as one, a copied session cookie never ran out while it was used,
// Finish said "nothing was signed" when it could not know, a public form's own refusal was shown as no connection,
// two fingers on the signature pad made a signature, the stacked-field rule refused what a finger can reach and
// shut public forms without a word, "Sign out everywhere else" left remembered two-step devices, and photos sent
// through the API reached every signer's phone at full size.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { boot, signUp, simple, Client, type Server } from './helpers.ts';
import { sha256 } from '../src/server/util.ts';
import { HAND_OVER_TRIES } from '../src/lib/policy.ts';

let s: Server;
let handle: (req: Request) => Promise<Response>;
before(async () => {
  s = await boot();
  handle = (await import('../src/server/router.ts')).handle;
});

let n = 0;
const ip = () => `198.51.131.${++n}`;
const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
const PASSWORD = 'correct horse battery';

// ---- The hand-over lock: five tries, however they are sent ---------------------------------------------

async function hosting(tag: string) {
  const host = await signUp(`Hal ${tag}`, `hal-${tag}@example.com`, ip());
  const e = await simple(host, `hal-${tag}@example.com`, {
    recipients: [{ id: 'r', role: 'inperson', name: 'Pat Present', email: `pat-${tag}@example.com` }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
    send: true,
  });
  const tok = s.db.get('SELECT token FROM recipients WHERE envelope_id=?', e.id).token;
  await host.get(`/sign/${tok}`);
  assert.equal((await host.get('/envelopes')).data.code, 'handed_over');
  return { host, tok, sid: sha256(host.cookies.ts_session) };
}
// Many tries at the same moment from the locked browser, as a loop in its console would send them.
const unlockAll = (host: Client, passwords: string[]) =>
  Promise.all(passwords.map((password) => handle(new Request('http://test.local/api/auth/unlock', { method: 'POST', headers: { cookie: `ts_session=${host.cookies.ts_session}`, 'content-type': 'application/json', 'x-forwarded-for': host.ip }, body: JSON.stringify({ password }) }))
    .then(async (r) => ({ status: r.status, ...(await r.json()), cleared: r.headers.getSetCookie().some((x) => /^ts_session=;.*Max-Age=0/.test(x)) }))));
// How many passwords the server actually compared: every check runs scrypt once.
function counting<T>(fn: () => Promise<T>): Promise<{ out: T; checked: number }> {
  const real = crypto.scryptSync;
  let checked = 0;
  (crypto as any).scryptSync = (...a: any[]) => (checked++, (real as any)(...a));
  return fn().then((out) => ({ out, checked }), (e) => Promise.reject(e)).finally(() => ((crypto as any).scryptSync = real));
}

test('forty wrong passwords sent at once on a handed-over device get five checks, and the fifth wrong one signs the browser out', async () => {
  const { host, sid } = await hosting('race');
  const { out, checked } = await counting(() => unlockAll(host, Array.from({ length: 40 }, (_, i) => `guess ${i}`)));
  assert.equal(checked, HAND_OVER_TRIES, 'only five passwords were compared, however many were sent');
  const wrong = out.filter((r: any) => r.code === 'wrong_password');
  assert.deepEqual(wrong.map((r: any) => r.tries_left).sort(), [1, 2, 3, 4], 'each checked try has its own number');
  assert.ok(out.filter((r: any) => r.code === 'signed_out').length >= 1);
  // Every other answer is a refusal without a check: the lock is used up (signed_out), the session is already gone
  // (not_locked), or the address or session sent too many (429).
  assert.equal(out.filter((r: any) => !['wrong_password', 'signed_out', 'not_locked'].includes(r.code) && r.status !== 429).length, 0, JSON.stringify(out.map((r: any) => r.code)));
  assert.equal(s.db.get('SELECT COUNT(*) n FROM sessions WHERE id=?', sid).n, 0, 'the browser is signed out');
  assert.ok(out.some((r: any) => r.cleared), 'and its cookie is taken away');
  // The right password now changes nothing: the lock is shut for everyone, and the sign-in page is the way back.
  // (From another address: this one sent forty tries and has reached its own limit.)
  host.ip = ip();
  assert.equal((await host.post('/auth/unlock', { password: PASSWORD })).data.code, 'not_locked');
  assert.equal((await host.get('/envelopes')).status, 401);
});

test('the right password among many wrong ones sent together only counts if it was one of the five tries', async () => {
  // Sent first of forty: it is one of the five, so it opens the lock, and nothing after it is guessed.
  const a = await hosting('first');
  const { out } = await counting(() => unlockAll(a.host, [PASSWORD, ...Array.from({ length: 39 }, (_, i) => `guess ${i}`)]));
  assert.equal(out[0].ok, true);
  assert.equal((await a.host.get('/envelopes')).status, 200, 'unlocked');
  // Sent last, after five wrong ones: refused without being looked at, and the browser is signed out.
  const b = await hosting('last');
  const late = await counting(() => unlockAll(b.host, [...Array.from({ length: 5 }, (_, i) => `guess ${i}`), PASSWORD]));
  assert.equal(late.checked, HAND_OVER_TRIES);
  assert.ok(['signed_out', 'not_locked'].includes(late.out[5].code), late.out[5].code);
  assert.notEqual(late.out[5].ok, true);
  assert.equal(s.db.get('SELECT COUNT(*) n FROM sessions WHERE id=?', b.sid).n, 0);
});

test('tries one after another: four wrong and the right one opens, and the next hand-over starts at five again', async () => {
  const { host, tok, sid } = await hosting('seq');
  for (let i = 1; i < HAND_OVER_TRIES; i++) assert.equal((await host.post('/auth/unlock', { password: `guess ${i}` })).data.tries_left, HAND_OVER_TRIES - i);
  assert.equal((await host.get('/me')).data.handed_over.tries_left, 1);
  // Opening the signing page again while it is locked does not give the guesser five new tries.
  await host.get(`/sign/${tok}`);
  assert.equal((await host.get('/me')).data.handed_over.tries_left, 1);
  assert.deepEqual((await host.post('/auth/unlock', { password: PASSWORD })).data.ok, true, 'the fifth try is the right one');
  assert.equal(s.db.get('SELECT unlock_tries n FROM sessions WHERE id=?', sid).n, 0);
  // The signer still has to sign, so opening the page again locks again, with all five tries.
  await host.get(`/sign/${tok}`);
  assert.equal((await host.get('/me')).data.handed_over.tries_left, HAND_OVER_TRIES);
  // An empty box is not a try, and a body that is not JSON is not one either.
  assert.equal((await host.post('/auth/unlock', {})).status, 400);
  const junk = await handle(new Request('http://test.local/api/auth/unlock', { method: 'POST', headers: { cookie: `ts_session=${host.cookies.ts_session}`, 'x-forwarded-for': host.ip }, body: 'password=x' }));
  assert.equal(junk.status, 400);
  assert.equal((await host.get('/me')).data.handed_over.tries_left, HAND_OVER_TRIES);
});

test('one address cannot keep trying the locks of many devices', async () => {
  const where = ip();
  let last: any;
  for (let i = 0; i < 31; i++) {
    const c = new Client();
    c.ip = where;
    last = await c.post('/auth/unlock', { password: 'x' });
  }
  assert.equal(last.status, 429);
  // Somebody at another address is not affected.
  const other = new Client();
  other.ip = ip();
  assert.equal((await other.post('/auth/unlock', { password: 'x' })).data.code, 'not_locked');
  // The code says what it enforces.
  const src = read('src/server/handover.ts');
  assert.match(src, /UPDATE sessions SET unlock_tries=unlock_tries\+1 WHERE id=\? AND locked_at IS NOT NULL AND unlock_tries < \? RETURNING unlock_tries/);
  assert.ok(src.indexOf('await c.body()') < src.indexOf('const s = lockedSession(c.req)'), 'the body is read before the session, so nothing waits between count and check');
});

// ---- A session ends 90 days after signing in, however often it is used, or after 30 days without use -----

const DAY = 864e5;
const iso = (ms: number) => new Date(ms).toISOString();
// Moves a session back in time, as if `days` had passed (when it signed in, when it was used, when it ends).
const age = (sid: string, days: number) => {
  const r = s.db.get('SELECT * FROM sessions WHERE id=?', sid);
  s.db.run('UPDATE sessions SET expires_at=?, last_used_at=?, created_at=? WHERE id=?', iso(Date.parse(r.expires_at) - days * DAY), r.last_used_at ? iso(Date.parse(r.last_used_at) - days * DAY) : null, r.created_at ? iso(Date.parse(r.created_at) - days * DAY) : null, sid);
};
const me = (cookie: string, ip: string) => handle(new Request('http://test.local/api/me', { headers: { cookie: `ts_session=${cookie}`, 'x-forwarded-for': ip, 'user-agent': 'curl/8' } })).then((r) => r.json());

test('a copied cookie used once every 29 days runs out 90 days after the sign-in, and does not come back', async () => {
  const { SESSION_MAX_DAYS, SESSION_DAYS } = await import('../src/lib/policy.ts');
  assert.equal(SESSION_MAX_DAYS, 90);
  assert.equal(SESSION_DAYS, 30);
  const victim = await signUp('Vee Victim', 'vee-r@example.com', ip());
  const sid = sha256(victim.cookies.ts_session);
  const alive: boolean[] = [];
  for (let i = 0; i < 6; i++) {
    age(sid, 29);
    alive.push((await me(victim.cookies.ts_session, ip())).user?.email === 'vee-r@example.com');
  }
  assert.deepEqual(alive, [true, true, true, false, false, false], 'alive at 29, 58 and 87 days, gone at 116 and after: 90 days from the sign-in at the latest');
  // Not listed under Settings any more, and the next sign-in clears it.
  const desk = new Client();
  desk.ip = ip();
  assert.equal((await desk.post('/auth/login', { email: 'vee-r@example.com', password: PASSWORD })).status, 200);
  assert.equal(s.db.get('SELECT COUNT(*) n FROM sessions WHERE id=?', sid).n, 0);
  assert.equal((await desk.get('/me/sessions')).data.sessions.length, 1);
});

test('a session that slid past 90 days before the rule existed is refused, unlisted and cannot be unlocked', async () => {
  const c = await signUp('Old Slider', 'old-slider@example.com', ip());
  const sid = sha256(c.cookies.ts_session);
  // What the sliding session left behind: signed in 100 days ago, last moved yesterday, ends in 29 days.
  s.db.run('UPDATE sessions SET created_at=?, last_used_at=?, expires_at=? WHERE id=?', iso(Date.now() - 100 * DAY), iso(Date.now() - DAY), iso(Date.now() + 29 * DAY), sid);
  assert.equal((await c.get('/envelopes')).status, 401);
  assert.equal((await c.get('/me')).data.user, null);
  const other = new Client();
  other.ip = ip();
  await other.post('/auth/login', { email: 'old-slider@example.com', password: PASSWORD });
  assert.deepEqual((await other.get('/me/sessions')).data.sessions.map((x: any) => x.current), [true]);
  // A handed-over browser in that state shows no lock screen to work on.
  const { host, sid: hid } = await hosting('old');
  s.db.run('UPDATE sessions SET created_at=?, expires_at=? WHERE id=?', iso(Date.now() - 95 * DAY), iso(Date.now() + 20 * DAY), hid);
  assert.equal((await host.get('/me')).data.handed_over, undefined);
  assert.equal((await host.post('/auth/unlock', { password: PASSWORD })).data.code, 'not_locked');
});

test('a session from before its sign-in time was kept is never moved forward again', async () => {
  const c = await signUp('No Start', 'no-start@example.com', ip());
  const sid = sha256(c.cookies.ts_session);
  const end = iso(Date.now() + 10 * DAY);
  s.db.run('UPDATE sessions SET created_at=NULL, last_used_at=NULL, expires_at=? WHERE id=?', end, sid);
  assert.equal((await c.get('/envelopes')).status, 200, 'it still works until its end');
  assert.equal(s.db.get('SELECT expires_at t FROM sessions WHERE id=?', sid).t, end, 'the end stays where it was');
});

test('a new session ends 30 days after its last use and 90 after signing in at the latest, Settings shows that day, and a cookie sent again never outlives it', async () => {
  const c = await signUp('Day Shower', 'day-shower@example.com', ip());
  const row = s.db.get('SELECT * FROM sessions WHERE id=?', sha256(c.cookies.ts_session));
  assert.ok(Math.abs(Date.parse(row.expires_at) - Date.parse(row.created_at) - 30 * DAY) < 5000, 'unused, it ends 30 days after signing in');
  const list = (await c.get('/me/sessions')).data;
  assert.equal(list.max_days, 90);
  assert.equal(list.days, 30);
  assert.ok(Math.abs(Date.parse(list.sessions[0].signs_out_at) - Date.parse(row.created_at) - 30 * DAY) < 5000);
  // The cookie that goes out again carries the time the session has left, never a fresh 30 days: 20 days left of
  // the idle time here, and near the 90 day end only what is left of that.
  const { renewedCookie } = await import('../src/server/auth.ts');
  age(row.id, 10);
  const cookieNow = () => renewedCookie(new Request('http://test.local/', { headers: { cookie: `ts_session=${c.cookies.ts_session}` } }), true);
  const again = cookieNow();
  const maxAge = Number(/Max-Age=(\d+)/.exec(again)![1]);
  assert.ok(Math.abs(maxAge - 20 * 86400) < 10, `${maxAge}`);
  s.db.run('UPDATE sessions SET created_at=?, expires_at=? WHERE id=?', iso(Date.now() - 85 * DAY), iso(Date.now() + 25 * DAY), row.id);
  const late = Number(/Max-Age=(\d+)/.exec(cookieNow())![1]);
  assert.ok(Math.abs(late - 5 * 86400) < 10, `5 days left of the 90, whatever the idle end says: ${late}`);
  assert.match(again, /; Secure$/);
  // The words the pages print come from the same two numbers.
  const { sessionWords } = await import('../src/lib/policy.ts');
  assert.match(sessionWords(30, 30), /^A browser is signed out 30 days after you signed in on it, however often you use it in between, and then you sign in again\./);
  assert.match(sessionWords(7, 30), /Two rules sign it out, whichever comes first: 7 days without using GrowSigning in it, or 30 days after you signed in on it/);
  assert.match(sessionWords(), /Two rules sign it out, whichever comes first: 30 days without using GrowSigning in it, or 90 days after you signed in on it, however often you use it in between\. Then you sign in again\./);
  assert.match(read('src/app/security/page.tsx'), /\{sessionWords\(\)\}/);
  assert.match(read('src/app/app/settings/SignedIn.tsx'), /\{sessionWords\(d\.days, d\.max_days\)\}/);
  for (const f of ['src/app/security/page.tsx', 'src/app/app/settings/SignedIn.tsx', 'README.md']) assert.doesNotMatch(read(f), /once a month does not ask|not after it signed in/, f);
});

// ---- "Sign out everywhere else" also ends remembered two-step devices ------------------------------------

test('signing out everywhere else also stops other devices from skipping two-step login, and keeps this one', async () => {
  const c = await signUp('Rem Device', 'rem-device@example.com', ip());
  const uid = s.db.get("SELECT id FROM users WHERE email='rem-device@example.com'").id;
  const phone = new Client();
  phone.ip = ip();
  await phone.post('/auth/login', { email: 'rem-device@example.com', password: PASSWORD });
  // Two remembered devices: this browser (its cookie is what twostep.ts looks for) and the lost phone.
  const mine = 'this-browser-device-token', lost = 'lost-phone-device-token';
  c.cookies[`sg_device_${sha256(`device:${uid}`).slice(0, 12)}`] = mine;
  for (const t of [mine, lost]) s.db.run('INSERT INTO two_step_devices (id, user_id, ua, created_at, last_used_at, expires_at) VALUES (?,?,?,?,?,?)', sha256(t), uid, null, iso(Date.now()), iso(Date.now()), iso(Date.now() + 20 * DAY));
  const r = await c.post('/me/sessions/sign-out-others');
  assert.deepEqual(r.data, { ok: true, signed_out: 1, two_step_devices_forgotten: 1 });
  assert.deepEqual(s.db.all('SELECT id FROM two_step_devices WHERE user_id=?', uid).map((x: any) => x.id), [sha256(mine)], 'only this browser stays remembered');
  assert.equal((await phone.get('/envelopes')).status, 401);
  // Somebody else's remembered devices are not touched.
  const other = await signUp('Not Me', 'not-me-rem@example.com', ip());
  const oid = s.db.get("SELECT id FROM users WHERE email='not-me-rem@example.com'").id;
  s.db.run('INSERT INTO two_step_devices (id, user_id, ua, created_at, last_used_at, expires_at) VALUES (?,?,?,?,?,?)', sha256('theirs'), oid, null, iso(Date.now()), iso(Date.now()), iso(Date.now() + 20 * DAY));
  await c.post('/me/sessions/sign-out-others');
  assert.equal(s.db.get('SELECT COUNT(*) n FROM two_step_devices WHERE user_id=?', oid).n, 1);
  assert.ok(other);
  // The card says so.
  assert.match(read('src/app/app/settings/SignedIn.tsx'), /no other device skips the code any more/);
});

// ---- Finish: say only what is known --------------------------------------------------------------------

const noDash = (t: string, what: string) => assert.ok(!/[\u2013\u2014]/.test(t), `${what} has a dash: ${t}`);
const signPage = () => read('src/app/sign/[token]/page.tsx');
const completeFn = () => {
  const page = signPage();
  return page.slice(page.indexOf('async function complete()'), page.indexOf('async function askForTime()'));
};

test('our own 503 is not "no connection"; only no answer, or a 502/503/504 without our sentence, is', async () => {
  const { isConnectionError } = await import('../src/components/sign/offline.ts');
  const err = (status?: number, data?: any) => Object.assign(new Error('x'), { status, data });
  assert.equal(isConnectionError(new TypeError('Failed to fetch')), true);
  for (const st of [502, 503, 504]) {
    assert.equal(isConnectionError(err(st, {})), true, `${st} from something in between`);
    assert.equal(isConnectionError(err(st, { error: 'Our own words.', request_id: 'req_x' })), false, `${st} from our server`);
  }
  // The real refusal of a public form with no signature free: a code of its own, and our sentence. Counting
  // signatures is on only while a payment provider is set, so for this test only.
  const hadKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY ||= 'sk_test_x';
  try {
    const o = await signUp('Olu Owner', 'olu-r@example.com', ip());
    const acct = s.db.get("SELECT m.account_id a FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='olu-r@example.com'").a;
    const { grant, available } = await import('../src/server/credits.ts');
    const form = await simple(o, '', { kind: 'template', subject: 'Sign up', recipients: [{ id: 'r', role: 'signer', role_name: 'Member' }] });
    assert.equal((await o.post('/powerforms', { template_id: form.id, name: 'Sign up' })).status, 200);
    const slug = (await o.get('/powerforms')).data.powerforms[0].slug;
    const v = new Client();
    v.ip = ip();
    assert.equal((await v.post(`/public/powerforms/${slug}/start`, { name: 'Visitor One', email: 'visitor-r1@example.com' })).status, 200);
    grant(acct, -available(acct), 'adjust', 'test: no signature free');
    const eid = s.db.get("SELECT e.id FROM envelopes e JOIN recipients r ON r.envelope_id=e.id WHERE r.email='visitor-r1@example.com'").id;
    const tok = s.db.get("SELECT token FROM recipients WHERE envelope_id=? AND email='visitor-r1@example.com'", eid).token;
    await v.post(`/sign/${tok}/consent`);
    const view = (await v.get(`/sign/${tok}`)).data;
    const done = await v.post(`/sign/${tok}/complete`, { values: Object.fromEntries(view.fields.map((f: any) => [f.id, f.type === 'checkbox' ? '1' : 'x'])), signature_png: PNG_SIG, initials_png: PNG_SIG, version: view.version });
    assert.equal(done.status, 503, JSON.stringify(done.data));
    assert.equal(done.data.code, 'form_waits');
    assert.match(done.data.error, /We email you at visitor-r1@example\.com once the form can take your signature/);
    assert.equal(isConnectionError(Object.assign(new Error(done.data.error), { status: done.status, code: done.data.code, data: done.data })), false, 'shown as it is, not as no connection');
  } finally {
    if (hadKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = hadKey;
  }
  // The page shows that sentence and does not send Finish again by itself.
  const fn = completeFn();
  assert.match(fn, /else if \(e\?\.code === 'form_waits'\) \{[\s\S]*?setFinishPending\(false\);\s+say\(msg\);/);
  assert.ok(fn.indexOf("e?.code === 'form_waits'") < fn.indexOf('isConnectionError(e) || e?.status >= 500'));
});
const PNG_SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('a Finish whose answer was lost is found to be done, a second Finish says so with a code, and nothing claims "nothing was signed" unknown', async () => {
  const { finishLanded, finishUnknown, finishNotSent, isAlreadyFinished } = await import('../src/components/sign/offline.ts');
  const sender = await signUp('Lu Lost', 'lu-lost@example.com', ip());
  const e = await simple(sender, 'pat-lost@example.com', { send: true });
  const tok = s.db.get("SELECT token FROM recipients WHERE envelope_id=? AND email='pat-lost@example.com'", e.id).token;
  const pat = new Client();
  pat.ip = ip();
  await pat.post(`/sign/${tok}/consent`);
  const view = (await pat.get(`/sign/${tok}`)).data;
  const body = { values: Object.fromEntries(view.fields.map((f: any) => [f.id, f.type === 'checkbox' ? '1' : 'x'])), signature_png: PNG_SIG, initials_png: PNG_SIG, version: view.version };
  assert.equal(await finishLanded(() => pat.get(`/sign/${tok}`).then((r) => r.data)), 'open', 'before Finish: not done');
  // The server signs; the answer is lost on the way (the page only sees a network error). Asking says done.
  assert.equal((await pat.post(`/sign/${tok}/complete`, body)).status, 200);
  assert.equal(await finishLanded(() => pat.get(`/sign/${tok}`).then((r) => r.data)), 'done');
  // The retry that follows gets 409 with a code the page reads as done, not as a mistake.
  const again = await pat.post(`/sign/${tok}/complete`, body);
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'already_finished');
  assert.equal(isAlreadyFinished(Object.assign(new Error(again.data.error), { status: 409, code: again.data.code })), true);
  assert.equal(isAlreadyFinished(Object.assign(new Error('This envelope is no longer open for signing.'), { status: 409 })), false);
  // No connection to ask either: unknown, and the words promise nothing either way.
  assert.equal(await finishLanded(() => Promise.reject(new TypeError('Failed to fetch'))), 'unknown');
  for (const online of [true, false]) {
    const said = finishUnknown(online);
    assert.match(said, /cannot tell yet whether it went through/);
    assert.match(said, /Nothing you typed is lost\./);
    assert.doesNotMatch(said, /nothing was signed|nothing is signed/i);
    noDash(said, 'finishUnknown');
    noDash(finishNotSent(online), 'finishNotSent');
  }
  // The page: an "already finished" answer comes first and never as a red toast; a lost answer or an error of ours
  // asks the server before saying anything; "nothing was signed" only after that, or when the device was offline
  // before sending.
  const fn = completeFn();
  assert.match(fn, /if \(isAlreadyFinished\(e\)\) \{\s+\/\/[^\n]*\n\s+landed\(\);\s+if \(!finishPending\) toast\('You had already finished this document, so nothing more was sent\.'\);\s+await load\(\);/);
  assert.ok(fn.indexOf('isAlreadyFinished(e)') < fn.indexOf('isConnectionError(e)'));
  assert.match(fn, /const offline = navigator\.onLine === false;/);
  assert.match(fn, /const now = offline \? 'open' : await finishLanded\(\(\) => api\(base\)\);\s+if \(now === 'done'\) return void \(landed\(\), await load\(\)\);/);
  assert.match(fn, /say\(now === 'unknown' \? finishUnknown\(/);
  assert.doesNotMatch(fn, /already finished\|/, 'the old branch that showed it as a red toast is gone');
  assert.doesNotMatch(fn, /e\?\.status >= 500 \? `\$\{msg\} Nothing was signed/, 'a 500 no longer says nothing was signed before asking');
});

// ---- The signature pad: one finger at a time -----------------------------------------------------------

// The pad's pointer handling as SignaturePad does it, on plain events, so a pinch can be fed in as the browser sends it.
async function padRun(events: { t: 'down' | 'move' | 'up'; id: number; type?: string; primary?: boolean; x?: number; y?: number }[]) {
  const { onePen } = await import('../src/lib/ink.ts');
  const pens = onePen();
  let strokes: { x: number; y: number }[][] = [];
  let live: { x: number; y: number }[] | null = null;
  let said = '';
  for (const e of events) {
    if (e.t === 'down') {
      const what = pens.down(e.id, e.type || 'touch', !!e.primary);
      if (what === 'drop') (strokes = strokes.filter((s) => s !== live)), (live = null), (said = 'two fingers');
      else if (what === 'draw') strokes.push((live = [{ x: e.x!, y: e.y! }]));
    } else if (e.t === 'move') {
      if (live && pens.move(e.id)) live.push({ x: e.x!, y: e.y! });
    } else if (pens.up(e.id) && live) live = null;
  }
  return { strokes, said };
}

test('two fingers spread on the pad make no signature, one finger still does, and a resting palm does not spoil a pen', async () => {
  const { drawnProblem, twoFingers } = await import('../src/lib/ink.ts');
  const pad = { w: 358, h: 160 };
  // The skeptic's pinch: two touch points that land together and move apart in 12 steps, their moves interleaved.
  const pinch: any[] = [{ t: 'down', id: 1, primary: true, x: 170, y: 80 }, { t: 'down', id: 2, x: 190, y: 80 }];
  for (let i = 1; i <= 12; i++) pinch.push({ t: 'move', id: 1, x: 170 - i * 10, y: 80 - i * 4 }, { t: 'move', id: 2, x: 190 + i * 10, y: 80 + i * 4 });
  pinch.push({ t: 'up', id: 2 }, { t: 'up', id: 1 });
  const p = await padRun(pinch);
  assert.deepEqual(p.strokes, [], 'nothing of the pinch is kept');
  assert.equal(p.said, 'two fingers');
  assert.match(drawnProblem(p.strokes, pad, 'signature'), /^Draw your signature in the box first\./, 'so Adopt is refused');
  assert.match(twoFingers('signature'), /^That was two fingers at once, so it was not kept\. Draw your signature with one finger, or choose Type\.$/);
  noDash(twoFingers('initials'), 'twoFingers');
  // A second finger in the middle of a real signature takes that line away, and earlier lines stay.
  const wave = (id: number, primary: boolean, y0: number) => [{ t: 'down', id, primary, x: 40, y: y0 }, ...Array.from({ length: 30 }, (_, i) => ({ t: 'move', id, x: 40 + i * 9, y: y0 + 20 * Math.sin(i / 3) })), { t: 'up', id }];
  const mid = await padRun([...wave(5, true, 60), { t: 'down', id: 6, primary: true, x: 40, y: 100 }, { t: 'move', id: 6, x: 90, y: 110 }, { t: 'down', id: 7, x: 200, y: 100 }, { t: 'move', id: 6, x: 140, y: 120 }, { t: 'move', id: 7, x: 260, y: 90 }, { t: 'up', id: 7 }, { t: 'move', id: 6, x: 190, y: 120 }, { t: 'up', id: 6 }]);
  assert.equal(mid.strokes.length, 1, 'the first line stays, the spoiled one is gone, and the finger left on the pad draws nothing more');
  assert.equal(mid.strokes[0].length, 31);
  // After every finger is off, one finger draws as before, and that passes.
  const after = await padRun([...pinch, ...wave(9, true, 80)]);
  assert.equal(after.strokes.length, 1);
  assert.equal(drawnProblem(after.strokes, pad, 'signature'), '');
  // A pen with the palm resting on the glass: the palm is ignored, the pen line is whole.
  const pen = await padRun([{ t: 'down', id: 11, type: 'pen', primary: true, x: 30, y: 80 }, { t: 'down', id: 12, type: 'touch', primary: true, x: 300, y: 150 }, ...Array.from({ length: 30 }, (_, i) => ({ t: 'move', id: i % 2 ? 12 : 11, x: 30 + i * 10, y: 80 + (i % 2 ? 60 : 10 * Math.sin(i)) })), { t: 'up', id: 12 }, { t: 'up', id: 11 }]);
  // The browser calls that touch primary (the first touch), yet the pen is still down: its line is whole.
  assert.equal(pen.strokes.length, 1);
  assert.equal(pen.strokes[0].length, 16, 'the pen point and its 15 moves, none of the palm');
  assert.ok(pen.strokes[0].every((pt) => pt.y < 100));
  // A finger whose lifting was never reported does not lock the pad: the next first finger draws.
  const stuck = await padRun([{ t: 'down', id: 21, primary: true, x: 10, y: 10 }, { t: 'down', id: 22, primary: true, x: 30, y: 30 }, { t: 'move', id: 22, x: 200, y: 40 }, { t: 'up', id: 22 }]);
  assert.equal(stuck.strokes.at(-1)!.length, 2);
  // The pad itself is wired to it.
  const src = read('src/components/SignaturePad.tsx');
  assert.match(src, /const what = pens\.down\(e\.pointerId, e\.pointerType, e\.isPrimary\);/);
  assert.match(src, /if \(!live \|\| !pens\.move\(e\.pointerId\)\) return;/);
  assert.match(src, /if \(!pens\.up\(e\.pointerId\) \|\| !live\) return;/);
  assert.match(src, /return setError\(twoFingers\(kind\)\);/);
});

// ---- Fields that cover each other: what a finger can reach --------------------------------------------

const fbox = (o: any) => ({ document_id: 'd1', page: 0, type: 'signature', x: 0.1, y: 0.5, w: 0.3, h: 0.06, recipient_id: 'r1', ...o });
const who = [{ id: 'r1', name: 'Pat Patient' }];
const doc1 = [{ id: 'd1', name: 'Intake' }];

test('a tick box inside a text field is drawn on top and allowed; a field mostly hidden by others is still refused', async () => {
  const { stackedFields, layers } = await import('../src/lib/stacked.ts');
  // The skeptic's paper-form layout: "Allergies", with a tick box "None" inside its right end.
  const text = fbox({ id: 'txt', type: 'text', x: 0.1, y: 0.4, w: 0.6, h: 0.03 });
  const tick = fbox({ id: 'na', type: 'checkbox', x: 0.67, y: 0.4025, w: 0.025, h: 0.025 });
  assert.deepEqual(stackedFields([text, tick], who, doc1), []);
  assert.deepEqual(stackedFields([tick, text], who, doc1), [], 'whichever was placed first');
  // On the signing page the tick box is drawn over the text field, whatever order they came in.
  assert.deepEqual([...layers([text, tick])], [['txt', 1], ['na', 2]]);
  assert.deepEqual([...layers([tick, text])], [['na', 2], ['txt', 1]]);
  assert.deepEqual([...layers([text, fbox({ id: 'far', y: 0.8 })])], [], 'fields that touch nothing keep the page order');
  // Still refused: two the same size in one spot (the later is on top and hides the earlier), a field just a
  // little smaller than the one it sits on, and a text field covered end to end by three tick boxes.
  const msg = 'Two fields for Pat Patient sit on top of each other on page 1, so one of them cannot be tapped. Move or remove one.';
  assert.deepEqual(stackedFields([fbox({}), fbox({ x: 0.11 })], who, doc1), [msg]);
  assert.deepEqual(stackedFields([fbox({}), fbox({ type: 'text', x: 0.11, y: 0.502, w: 0.28, h: 0.055 })], who, doc1), [msg]);
  assert.deepEqual(stackedFields([fbox({ type: 'text', w: 0.3, h: 0.03 }), ...[0, 1, 2].map((k) => fbox({ type: 'checkbox', x: 0.1 + k * 0.1, w: 0.1, h: 0.03 }))], who, doc1), [msg]);
  // The page uses the same order for the person's own fields.
  assert.match(signPage(), /const layered = useMemo\(\(\) => layers\(fields\), \[fields\]\);/);
  assert.match(signPage(), /style: \{ \.\.\.pos\(f\), zIndex: layered\.get\(f\.id\) \}/);
});

test('templates and public forms are checked when they are saved or made, and a form made before the rule takes its visitors', async () => {
  const c = await signUp('Nia Forms', 'nia-r@example.com', ip());
  const { upload } = await import('./helpers.ts');
  const file = await upload(c, 1);
  const base = { kind: 'template', subject: 'Intake form', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Patient' }] };
  const apart = [fbox({ id: 'a', document_id: 'd', recipient_id: 'r', y: 0.3 }), fbox({ id: 'b', document_id: 'd', recipient_id: 'r', y: 0.6 })];
  const together = [fbox({ id: 'a', document_id: 'd', recipient_id: 'r' }), fbox({ id: 'b', document_id: 'd', recipient_id: 'r', x: 0.11 })];
  // Saving a template whose fields cover each other is refused, and nothing is left behind.
  const before = s.db.get("SELECT COUNT(*) n FROM envelopes WHERE kind='template'").n;
  const bad1 = await c.post('/envelopes', { ...base, fields: together });
  assert.equal(bad1.status, 400);
  assert.match(bad1.data.error, /^Two fields for Patient sit on top of each other on page 1, so one of them cannot be tapped\. Move or remove one\. The template was not saved\.$/);
  assert.equal(s.db.get("SELECT COUNT(*) n FROM envelopes WHERE kind='template'").n, before);
  // A good one saves; stacking it later through PUT is refused and the template stays as it was.
  const tpl = (await c.post('/envelopes', { ...base, fields: apart })).data.envelope;
  const put = await c.put(`/envelopes/${tpl.id}`, { ...base, fields: together });
  assert.equal(put.status, 400);
  assert.deepEqual(s.db.all('SELECT y FROM fields WHERE envelope_id=? ORDER BY y', tpl.id).map((f: any) => f.y), [0.3, 0.6]);
  // A draft may still hold it while the sender works (refused at send, as before).
  assert.equal((await c.post('/envelopes', { ...base, kind: 'envelope', recipients: [{ id: 'r', role: 'signer', name: 'Pat', email: 'pat-r@example.com' }], fields: together })).status, 200);
  // A template made before the rule (stacked in the database) cannot become a new public form.
  s.db.run('UPDATE fields SET x=0.11, y=0.5 WHERE envelope_id=? AND y=0.6', tpl.id);
  s.db.run('UPDATE fields SET x=0.1, y=0.5 WHERE envelope_id=? AND y=0.3', tpl.id);
  const pf = await c.post('/powerforms', { template_id: tpl.id, name: 'Intake form' });
  assert.equal(pf.status, 400);
  assert.match(pf.data.error, /Change the template first\. The form was not made\.$/);
  assert.equal(s.db.get('SELECT COUNT(*) n FROM powerforms WHERE template_id=?', tpl.id).n, 0);
  // A form that was already live when its template was stacked: visitors are let in, the owner is told once a day.
  s.db.run('UPDATE fields SET y=0.3 WHERE envelope_id=? AND x=0.1', tpl.id);
  s.db.run('UPDATE fields SET x=0.1, y=0.6 WHERE envelope_id=? AND x=0.11', tpl.id);
  assert.equal((await c.post('/powerforms', { template_id: tpl.id, name: 'Intake form' })).status, 200);
  s.db.run('UPDATE fields SET x=0.11, y=0.5 WHERE envelope_id=? AND y=0.6', tpl.id);
  s.db.run('UPDATE fields SET y=0.5 WHERE envelope_id=? AND y=0.3', tpl.id);
  const slug = (await c.get('/powerforms')).data.powerforms[0].slug;
  for (const [i, email] of ['walkin1-r@example.com', 'walkin2-r@example.com'].entries()) {
    const v = new Client();
    v.ip = ip();
    const start = await v.post(`/public/powerforms/${slug}/start`, { name: `Walk In ${i}`, email });
    assert.equal(start.status, 200, JSON.stringify(start.data));
    assert.match(start.data.url, /\/sign\//);
  }
  const told = s.db.all("SELECT subject, html FROM emails WHERE to_email='nia-r@example.com' AND subject LIKE 'Two fields on your form%'");
  assert.equal(told.length, 1, 'once a day, not once a visitor');
  assert.equal(told[0].subject, 'Two fields on your form "Intake form" cover each other');
  assert.match(told[0].html, /Easy reading/);
  // Only the start is let in: the owner correcting a visitor's envelope keeps to the rule.
  const visitorEnv = s.db.get("SELECT e.id FROM envelopes e JOIN recipients r ON r.envelope_id=e.id WHERE r.email='walkin1-r@example.com'").id;
  const out = (await c.get(`/envelopes/${visitorEnv}`)).data.envelope;
  const corr = await c.put(`/envelopes/${visitorEnv}`, { subject: out.subject, documents: out.documents, recipients: out.recipients, fields: out.fields });
  assert.equal(corr.status, 400, JSON.stringify(corr.data));
  assert.match(corr.data.error, /sit on top of each other/);
  noDash(read('src/server/stackedforms.ts'), 'stackedforms.ts');
});

// ---- Photos: all eight camera orientations, in files laid out the way cameras and phones write them ------

// A real JPEG, 48 by 32 pixels as stored: top left red, top right green, bottom left blue, bottom right white. It
// starts with a JFIF header, as files saved by an editor or a messaging app do.
const BASE = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAgADADAREAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAcKCP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAYAQEBAQEBAAAAAAAAAAAAAAAACQYHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AOWnHFJQAFKZVCcABNWqXYAAUplUJwAHI62T0GAA0zJtNgAAzMqSseAA0zJtNgAA/9k=', 'base64');
const JFIF_END = 2 + 2 + BASE.readUInt16BE(4); // SOI, then the JFIF APP0 segment
// The thumbnail a camera puts inside its note: a JPEG of its own, with its own size mark (here it says 160 by 120),
// which a careless reader takes for the photo's.
const THUMB = (() => {
  const t = Buffer.from(BASE);
  const sof = t.indexOf(Buffer.from([0xff, 0xc0]));
  t.writeUInt16BE(120, sof + 5);
  t.writeUInt16BE(160, sof + 7);
  return t;
})();
// The note as a phone writes it: IFD0 with Make, Model, Orientation, resolutions, Software, DateTime and a pointer
// to the Exif sub-IFD (with the time taken and the pixel size), then IFD1 pointing at the thumbnail. Values that
// do not fit in four bytes live after the lists, as in real files. `little`: "II" (most Android phones), else "MM".
function cameraNote(orientation: number, little: boolean): Buffer {
  const u16 = (v: number) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) => (little ? [...u16(v & 65535), ...u16(v >>> 16)] : [...u16(v >>> 16), ...u16(v & 65535)]);
  const ascii = (t: string) => [...Buffer.from(`${t}\0`)];
  const make = ascii('Apple'), model = ascii('iPhone 13'), soft = ascii('17.5'), when = ascii('2026:11:20 09:30:00');
  const n0 = 10, n1 = 3, n2 = 3;
  const ifd0 = 8, ifdE = ifd0 + 2 + n0 * 12 + 4, ifd1 = ifdE + 2 + n1 * 12 + 4, data = ifd1 + 2 + n2 * 12 + 4;
  const at: number[] = [];
  let o = data;
  for (const len of [make.length, model.length, 8, 8, soft.length, when.length, when.length]) at.push(o), (o += len);
  const thumbAt = o;
  const e = (tag: number, kind: number, count: number, value: number[]) => [...u16(tag), ...u16(kind), ...u32(count), ...value, ...Array(4 - value.length).fill(0)];
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0),
    ...u16(n0), ...e(0x010f, 2, make.length, u32(at[0])), ...e(0x0110, 2, model.length, u32(at[1])), ...e(0x0112, 3, 1, u16(orientation)),
    ...e(0x011a, 5, 1, u32(at[2])), ...e(0x011b, 5, 1, u32(at[3])), ...e(0x0128, 3, 1, u16(2)), ...e(0x0131, 2, soft.length, u32(at[4])),
    ...e(0x0132, 2, when.length, u32(at[5])), ...e(0x0213, 3, 1, u16(1)), ...e(0x8769, 4, 1, u32(ifdE)), ...u32(ifd1),
    ...u16(n1), ...e(0x9003, 2, when.length, u32(at[6])), ...e(0xa002, 4, 1, u32(48)), ...e(0xa003, 4, 1, u32(32)), ...u32(0),
    ...u16(n2), ...e(0x0103, 3, 1, u16(6)), ...e(0x0201, 4, 1, u32(thumbAt)), ...e(0x0202, 4, 1, u32(THUMB.length)), ...u32(0),
    ...make, ...model, ...u32(72), ...u32(1), ...u32(72), ...u32(1), ...soft, ...when, ...when, ...THUMB];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body]);
}
// Other segments real files carry next to the note: a colour profile (APP2) and Adobe's XMP (a second APP1, which
// starts like no Exif note and here even claims orientation 1: browsers go by the Exif note, and so do we).
const seg = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
const ICC = seg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), Buffer.alloc(120, 7)]));
const XMP = seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description tiff:Orientation="1"/></rdf:RDF></x:xmpmeta>', 'latin1'));
const LAYOUTS: Record<string, (o: number, little: boolean) => Buffer> = {
  // A camera original: the note first, then (here) the JFIF header that follows in some files.
  'note first': (o, little) => Buffer.concat([BASE.subarray(0, 2), cameraNote(o, little), BASE.subarray(2)]),
  // Saved again by an editor or an app: JFIF first, the note after it.
  'note after JFIF': (o, little) => Buffer.concat([BASE.subarray(0, JFIF_END), cameraNote(o, little), BASE.subarray(JFIF_END)]),
  // With a colour profile and XMP after the note.
  'note, profile, XMP': (o, little) => Buffer.concat([BASE.subarray(0, 2), cameraNote(o, little), ICC, XMP, BASE.subarray(2)]),
};
// Where each stored corner is seen once the photo is the right way up, from the EXIF standard.
const SEEN: Record<number, Record<string, string>> = {
  1: { red: 'TL', green: 'TR', blue: 'BL', white: 'BR' }, 2: { red: 'TR', green: 'TL', blue: 'BR', white: 'BL' },
  3: { red: 'BR', green: 'BL', blue: 'TR', white: 'TL' }, 4: { red: 'BL', green: 'BR', blue: 'TL', white: 'TR' },
  5: { red: 'TL', green: 'BL', blue: 'TR', white: 'BR' }, 6: { red: 'TR', green: 'BR', blue: 'TL', white: 'BL' },
  7: { red: 'BR', green: 'TR', blue: 'BL', white: 'TL' }, 8: { red: 'BL', green: 'TL', blue: 'BR', white: 'TR' },
};
// One page drawn the way a PDF viewer draws it, far enough to look at the photo: pdf.js decodes the JPEG with its own
// decoder (which ignores camera notes, as the viewers a signed PDF is downloaded into do) and says where the picture
// goes. Gives the colour seen well inside each quarter of the picture as it lies on the page.
async function seen(pdf: Uint8Array, want = (img: any) => img.width === 48 || img.height === 48) {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const page = await doc.getPage(1);
    const ops = await page.getOperatorList();
    const mul = (m: number[], t: number[]) => [m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1], m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3], m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5]];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === pdfjs.OPS.save) stack.push(ctm);
      else if (fn === pdfjs.OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === pdfjs.OPS.transform) ctm = mul(ctm, ops.argsArray[i]);
      else if (fn === pdfjs.OPS.paintImageXObject) {
        const img: any = await new Promise((res) => page.objs.get(ops.argsArray[i][0], res));
        if (!want(img)) continue;
        const [a, b, c, d, e, f] = ctm;
        const det = a * d - b * c;
        const per = img.data.length / (img.width * img.height);
        const colour = (x: number, y: number) => {
          const u = (d * (x - e) - c * (y - f)) / det, v = (-b * (x - e) + a * (y - f)) / det;
          const col = Math.min(img.width - 1, Math.floor(u * img.width)), row = Math.min(img.height - 1, Math.floor((1 - v) * img.height));
          const [r, g, bl] = img.data.subarray((row * img.width + col) * per);
          return r > 180 && g < 80 && bl < 80 ? 'red' : g > 110 && r < 80 && bl < 80 ? 'green' : bl > 180 && r < 80 && g < 80 ? 'blue' : r > 200 && g > 200 && bl > 200 ? 'white' : `rgb(${r},${g},${bl})`;
        };
        const xs = [e, e + a, e + c, e + a + c], ys = [f, f + b, f + d, f + b + d];
        const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
        const at = (fx: number, fy: number) => colour(box.x0 + (box.x1 - box.x0) * fx, box.y0 + (box.y1 - box.y0) * fy);
        // PDF y runs upwards, so the top of what is seen is the larger y.
        const corners: Record<string, string> = { TL: at(0.2, 0.8), TR: at(0.8, 0.8), BL: at(0.2, 0.2), BR: at(0.8, 0.2) };
        return { page: page.view as number[], tall: box.y1 - box.y0 > box.x1 - box.x0, where: Object.fromEntries(Object.entries(corners).map(([k, v]) => [v, k])) };
      }
    }
    throw new Error('no photo on this page');
  } finally {
    await doc.destroy().catch(() => {});
  }
}

test('all eight camera orientations come out upright, in both byte orders and three real file layouts, on the page and in the signed PDF', async () => {
  const { jpegOrientation, pictureSize } = await import('../src/server/exif.ts');
  const c = await signUp('Pho Eight', 'pho-eight@example.com', ip());
  const upload1 = (bytes: Buffer, name: string) => {
    const f = new FormData();
    f.append('file', new Blob([bytes], { type: 'image/jpeg' }), name);
    return c.call('POST', '/files', f);
  };
  for (const [layout, make] of Object.entries(LAYOUTS))
    for (const little of [false, true])
      for (let o = 1; o <= 8; o++) {
        const file = make(o, little);
        const what = `${layout}, ${little ? 'II' : 'MM'}, orientation ${o}`;
        assert.equal(jpegOrientation(file)?.value, o, `${what}: the note is read`);
        assert.deepEqual(pictureSize(file, false), { w: 48, h: 32 }, `${what}: the photo's size, not the thumbnail's`);
        const up = await upload1(file, `IMG_${o}.jpg`);
        assert.equal(up.status, 200, `${what}: ${JSON.stringify(up.data)}`);
        const side = o >= 5;
        const size = up.data.page_sizes[0];
        assert.equal(size.w < size.h, side, `${what}: the page suits the photo as it is looked at`);
        const pdf = (await c.get(`/files/${up.data.id}/content`)).data as Uint8Array;
        const d = await seen(pdf);
        assert.equal(d.tall, side, `${what}: the photo's shape on the page`);
        assert.deepEqual(d.where, SEEN[o], `${what}: every corner where it belongs`);
      }
  // The same in what a signer signs: one envelope per orientation, saved again by an app (the commonest layout).
  for (let o = 1; o <= 8; o++) {
    const up = await upload1(LAYOUTS['note after JFIF'](o, o % 2 === 0), `Lease ${o}.jpg`);
    const email = `tenant-${o}@example.com`;
    const made = await c.post('/envelopes', { subject: `Photographed lease ${o}`, documents: [{ id: 'd', file_id: up.data.id }], recipients: [{ id: 'r', role: 'signer', name: 'Hal Tenant', email }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.88, w: 0.3, h: 0.06 }], send: true });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    const tok = s.db.get('SELECT token FROM recipients WHERE envelope_id=?', made.data.envelope.id).token;
    const signer = new Client();
    signer.ip = ip();
    await signer.post(`/sign/${tok}/consent`);
    const view = (await signer.get(`/sign/${tok}`)).data;
    assert.equal((await signer.post(`/sign/${tok}/complete`, { values: Object.fromEntries(view.fields.map((f: any) => [f.id, '1'])), signature_png: PNG_SIG, initials_png: PNG_SIG, version: view.version })).status, 200);
    const signed = (await c.get(`/envelopes/${made.data.envelope.id}/download`)).data as Uint8Array;
    const d = await seen(signed);
    assert.equal(d.page[2] < d.page[3], o >= 5, `signed, orientation ${o}: the page`);
    assert.deepEqual(d.where, SEEN[o], `signed, orientation ${o}: every corner where it belongs`);
  }
});

test('/help says what the page does when the signal drops at Finish, and no more', async () => {
  const { SIGNING_WEAK_SIGNAL } = await import('../src/lib/mobile.ts');
  assert.doesNotMatch(SIGNING_WEAK_SIGNAL, /says that nothing was signed/);
  assert.match(SIGNING_WEAK_SIGNAL, /asks whether it went through and says what it finds\. When it cannot tell yet, it says so/);
  assert.match(SIGNING_WEAK_SIGNAL, /Trying again never signs twice\./);
  noDash(SIGNING_WEAK_SIGNAL, 'SIGNING_WEAK_SIGNAL');
});

test('the adopt dialog on a phone held sideways at 200 percent (195 px tall) keeps its buttons on the screen', () => {
  // Measured in the browser (tests/out/repair-mobile/g-adopt-zoom.cjs): at 422 by 195 the buttons were 15 px below
  // the screen before this rule; with it they are on it, and 76 px of the box to draw in shows above them.
  const css = read('src/app/styles/signphone.css');
  const at = css.indexOf('@media (max-height: 260px) {');
  assert.ok(at > 0, 'the rule is there');
  const rule = css.slice(at, css.indexOf('\n}\n', at) + 2);
  assert.match(rule, /\.sg-adopt-foot \{ max-height: none; \}/);
  assert.match(rule, /\.sg-dialog \.sigpad \{ height: 90px; \}/);
  assert.match(rule, /\.sg-adopt-foot \.actions \.btn \{ min-height: 44px; \}/, 'tap targets stay 44 px');
  noDash(rule, 'signphone.css');
});
