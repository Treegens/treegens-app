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
