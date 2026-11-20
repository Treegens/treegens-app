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

// ---- A session ends 30 days after signing in, however often it is used ---------------------------------

const DAY = 864e5;
const iso = (ms: number) => new Date(ms).toISOString();
// Moves a session back in time, as if `days` had passed (when it signed in, when it was used, when it ends).
const age = (sid: string, days: number) => {
  const r = s.db.get('SELECT * FROM sessions WHERE id=?', sid);
  s.db.run('UPDATE sessions SET expires_at=?, last_used_at=?, created_at=? WHERE id=?', iso(Date.parse(r.expires_at) - days * DAY), r.last_used_at ? iso(Date.parse(r.last_used_at) - days * DAY) : null, r.created_at ? iso(Date.parse(r.created_at) - days * DAY) : null, sid);
};
const me = (cookie: string, ip: string) => handle(new Request('http://test.local/api/me', { headers: { cookie: `ts_session=${cookie}`, 'x-forwarded-for': ip, 'user-agent': 'curl/8' } })).then((r) => r.json());

test('a copied cookie used once every 29 days runs out 30 days after the sign-in, and does not come back', async () => {
  const { SESSION_MAX_DAYS } = await import('../src/lib/policy.ts');
  assert.equal(SESSION_MAX_DAYS, 30);
  const victim = await signUp('Vee Victim', 'vee-r@example.com', ip());
  const sid = sha256(victim.cookies.ts_session);
  const alive: boolean[] = [];
  for (let i = 0; i < 6; i++) {
    age(sid, 29);
    alive.push((await me(victim.cookies.ts_session, ip())).user?.email === 'vee-r@example.com');
  }
  assert.deepEqual(alive, [true, false, false, false, false, false], 'alive at 29 days, gone at 58 and after');
  // Not listed under Settings any more, and the next sign-in clears it.
  const desk = new Client();
  desk.ip = ip();
  assert.equal((await desk.post('/auth/login', { email: 'vee-r@example.com', password: PASSWORD })).status, 200);
  assert.equal(s.db.get('SELECT COUNT(*) n FROM sessions WHERE id=?', sid).n, 0);
  assert.equal((await desk.get('/me/sessions')).data.sessions.length, 1);
});

test('a session that slid past 30 days before the rule existed is refused, unlisted and cannot be unlocked', async () => {
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
  s.db.run('UPDATE sessions SET created_at=?, expires_at=? WHERE id=?', iso(Date.now() - 40 * DAY), iso(Date.now() + 20 * DAY), hid);
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

test('a new session ends 30 days after signing in, Settings shows that day, and a cookie sent again never outlives it', async () => {
  const c = await signUp('Day Shower', 'day-shower@example.com', ip());
  const row = s.db.get('SELECT * FROM sessions WHERE id=?', sha256(c.cookies.ts_session));
  assert.ok(Math.abs(Date.parse(row.expires_at) - Date.parse(row.created_at) - 30 * DAY) < 5000);
  const list = (await c.get('/me/sessions')).data;
  assert.equal(list.max_days, 30);
  assert.ok(Math.abs(Date.parse(list.sessions[0].signs_out_at) - Date.parse(row.created_at) - 30 * DAY) < 5000);
  // The cookie that goes out again (only when the end moves, which a shorter idle time than 30 days would make
  // happen) carries the time the session has left, never a fresh 30 days.
  const { renewedCookie } = await import('../src/server/auth.ts');
  age(row.id, 10);
  const again = renewedCookie(new Request('http://test.local/', { headers: { cookie: `ts_session=${c.cookies.ts_session}` } }), true);
  const maxAge = Number(/Max-Age=(\d+)/.exec(again)![1]);
  assert.ok(Math.abs(maxAge - 20 * 86400) < 10, `${maxAge}`);
  assert.match(again, /; Secure$/);
  // The words the pages print come from the same two numbers.
  const { sessionWords } = await import('../src/lib/policy.ts');
  assert.match(sessionWords(30, 30), /^A browser is signed out 30 days after you signed in on it, however often you use it in between, and then you sign in again\./);
  assert.match(sessionWords(7, 30), /signed out 7 days after you last used Sign&Grow in it, and in any case 30 days after you signed in on it/);
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

const noDash = (t: string, what: string) => assert.ok(!/[–—]/.test(t), `${what} has a dash: ${t}`);
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
