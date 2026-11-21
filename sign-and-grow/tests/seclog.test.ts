// The security record of an account (src/server/seclog.ts, src/server/routes-seclog.ts). Pinned down: every kind of
// event is written once, to the right accounts, with the right person and internet address; nothing secret is kept
// (the test's passwords, keys, tokens, codes and email addresses are looked for in every line); members and "send"
// keys cannot read it and an admin key pages through it; lines cannot be changed or deleted, and go after
// SECURITY_LOG_DAYS and with their account; the chain shows a forged line; the alerts are throttled and can be
// switched off by a person only; the webhook is opt-in; the export carries it for admins.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { boot, Client, signUp, mailTo, simple, signAll, PNG } from './helpers.ts';
import { totp, fromBase32, stepAt } from '../src/server/twostep.ts';

const { db, cron } = await boot();
const seclog = await import('../src/server/seclog.ts');
const { SECURITY_KIND_LIST, SECURITY_PAGE_MAX } = await import('../src/lib/seclog.ts');
const PW = 'correct horse battery';

// Everything secret the test hands out or types, looked for in every line at the end.
const secrets = new Set<string>([PW]);
const keep = (s: any) => (typeof s === 'string' && s.length >= 6 ? (secrets.add(s), s) : s);

// Alerts and the webhook run just after the request that wrote the line (setImmediate in seclog.ts).
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 30));
};

// The clock of the authenticator app. A code works once, so a second code in the same 30 seconds waits for the next.
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
  return keep(totp(fromBase32(secret)));
};

let n = 0;
const ip = () => `198.51.${Math.floor(n / 250) + 1}.${(n++ % 250) + 1}`;
const browser = () => {
  const c = new Client();
  c.ip = ip();
  return c;
};
const person = async (name: string, email: string) => {
  const c = await signUp(name, email, ip());
  keep(c.cookies.ts_session);
  const u = db.get('SELECT id, verify_token FROM users WHERE email=?', email);
  keep(u.verify_token);
  return { c, email, id: u.id as string, own: db.get("SELECT account_id a FROM memberships WHERE user_id=? AND role='owner'", u.id)?.a as string };
};
const withKey = (key: string, from = ip()) => {
  const c = new Client();
  c.ip = from;
  const call = c.call.bind(c);
  c.call = (m: string, u: string, b?: any, h: Record<string, string> = {}) => call(m, u, b, { authorization: `Bearer ${key}`, ...h });
  return c;
};
const lines = (accountId: string, kind?: string) => db.all(`SELECT * FROM security_events WHERE account_id=?${kind ? ' AND kind=?' : ''} ORDER BY seq`, ...(kind ? [accountId, kind] : [accountId]));
const one = (accountId: string, kind: string) => {
  const l = lines(accountId, kind);
  assert.equal(l.length, 1, `${kind}: ${l.length} lines in ${accountId}`);
  return { ...l[0], details: JSON.parse(l[0].details) };
};
const count = (kind: string) => db.get('SELECT COUNT(*) n FROM security_events WHERE kind=?', kind).n;
async function invite(admin: Client, accountId: string, email: string, role = 'member') {
  assert.equal((await admin.post('/account/invites', { email, role })).status, 200);
  return keep(db.get('SELECT token FROM invites WHERE account_id=? AND email=? AND accepted_at IS NULL', accountId, email).token) as string;
}
async function joinBySignup(name: string, email: string, tokenText: string) {
  const c = browser();
  const r = await c.post('/auth/signup', { name, email, password: PW, invite: tokenText });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  keep(c.cookies.ts_session);
  return { c, id: db.get('SELECT id FROM users WHERE email=?', email).id as string };
}

const ada = await person('Ada Admin', 'ada@seclog.example');
const ben = await person('Ben Member', 'ben@seclog.example');
const A = ada.own;

// ---- 1 and 2: the lines, from each place ---------------------------------------------------------------------

test('the team: invited, joined, role changed, removed, left and the owner handed over, each once with the person who did it', async () => {
  const t = await invite(ada.c, A, ben.email);
  const inv = one(A, 'member.invited');
  assert.deepEqual([inv.actor_type, inv.actor_id, inv.about_type, inv.details.role, inv.ip], ['user', ada.id, 'invite', 'member', ada.c.ip]);
  assert.equal((await ben.c.post('/invites/accept', { token: t })).status, 200);
  const joined = one(A, 'member.joined');
  assert.deepEqual([joined.actor_id, joined.about_id, joined.ip], [ben.id, ben.id, ben.c.ip]);
  // Ben's own workspace hears nothing of it.
  assert.equal(lines(ben.own, 'member.joined').length, 0);

  assert.equal((await ada.c.call('PATCH', `/account/members/${ben.id}`, { role: 'admin' })).status, 200);
  assert.equal((await ada.c.call('PATCH', `/account/members/${ben.id}`, { role: 'admin' })).status, 200);
  const role = one(A, 'member.role_changed');
  assert.deepEqual([role.actor_id, role.about_id, role.details.from, role.details.to], [ada.id, ben.id, 'member', 'admin']);

  // Cara joins by signing up from her invitation, Ada removes her; Dan joins and leaves on his own.
  const cara = await joinBySignup('Cara Gone', 'cara@seclog.example', await invite(ada.c, A, 'cara@seclog.example'));
  assert.equal((await ada.c.call('DELETE', `/account/members/${cara.id}`)).status, 200);
  const removed = lines(A, 'member.removed');
  assert.equal(removed.length, 1);
  assert.deepEqual([removed[0].actor_id, removed[0].about_id], [ada.id, cara.id]);
  const dan = await joinBySignup('Dan Leaves', 'dan@seclog.example', await invite(ada.c, A, 'dan@seclog.example'));
  assert.equal((await dan.c.post('/account/leave', {})).status, 200);
  const left = one(A, 'member.left');
  assert.deepEqual([left.actor_id, left.about_id], [dan.id, dan.id]);
  assert.equal(lines(A, 'member.joined').length, 3);
});

test('signing in: success and failure go to every account of the person, a stranger\'s address writes nothing, signing out is written', async () => {
  const before = count('signin.failed');
  const c = browser();
  assert.equal((await c.post('/auth/login', { email: ben.email, password: PW })).status, 200);
  keep(c.cookies.ts_session);
  for (const acc of [A, ben.own]) {
    // Signing up was a sign-in too (a line with new_login), so the sign-in with the password is looked for by itself.
    const mine = lines(acc, 'signin.succeeded').map((l: any) => ({ ...l, details: JSON.parse(l.details) })).filter((l: any) => l.actor_id === ben.id && !l.details.new_login);
    assert.equal(mine.length, 1);
    const s = mine[0];
    assert.deepEqual([s.actor_type, s.actor_id, s.details.method, s.ip, s.outcome], ['user', ben.id, 'password', c.ip, 'success']);
    assert.ok(s.ua !== undefined);
  }
  const wrong = browser();
  assert.equal((await wrong.post('/auth/login', { email: ben.email, password: 'not the password at all' })).status, 401);
  keep('not the password at all');
  for (const acc of [A, ben.own]) {
    const f = one(acc, 'signin.failed');
    assert.deepEqual([f.actor_id, f.outcome, f.details.reason, f.ip], [ben.id, 'failure', 'wrong_password', wrong.ip]);
  }
  assert.equal((await browser().post('/auth/login', { email: 'nobody@seclog.example', password: 'whatever it is' })).status, 401);
  assert.equal(count('signin.failed'), before + 2);
  assert.equal((await c.post('/auth/logout')).status, 200);
  assert.equal(lines(A, 'session.ended').length, 1);
  assert.equal(lines(ben.own, 'session.ended').length, 1);
});

test('logins: password changed and reset, signed out everywhere, email changed, closing started and undone', async () => {
  const eve = await person('Eve Login', 'eve@seclog.example');
  const other = browser();
  await other.post('/auth/login', { email: eve.email, password: PW });
  assert.equal((await eve.c.post('/me/password', { current: PW, password: keep('a brand new password 1') })).status, 200);
  assert.equal(one(eve.own, 'password.changed').actor_id, eve.id);
  assert.equal((await eve.c.post('/me/sessions/sign-out-others')).status, 200);
  assert.equal(one(eve.own, 'signout.everywhere').details.signed_out >= 0, true);

  assert.equal((await browser().post('/auth/forgot', { email: eve.email })).status, 200);
  const link = mailTo(eve.email).map((m: any) => m.link).filter((l: string) => l?.includes('/reset?token='))[0];
  const tok = keep(new URL(link).searchParams.get('token'));
  const fresh = browser();
  assert.equal((await fresh.post('/auth/reset', { token: tok, password: keep('another brand new one 2') })).status, 200);
  const reset = one(eve.own, 'password.reset');
  assert.deepEqual([reset.actor_type, reset.actor_id, reset.ip], ['user', eve.id, fresh.ip]);

  const me = browser();
  assert.equal((await me.post('/auth/login', { email: eve.email, password: 'another brand new one 2' })).status, 200);
  keep(me.cookies.ts_session);
  assert.equal((await me.post('/me/email', { email: 'eve.new@seclog.example', password: 'another brand new one 2' })).status, 200);
  const confirm = mailTo('eve.new@seclog.example').map((m: any) => m.link).find((l: string) => l?.includes('/change-email?token='));
  const ct = keep(new URL(confirm).searchParams.get('token'));
  assert.equal((await me.post('/me/email/confirm', { token: ct })).status, 200);
  const changed = one(eve.own, 'email.changed');
  assert.equal(changed.actor_id, eve.id);
  assert.ok(!JSON.stringify(changed).includes('eve.new@') && !JSON.stringify(changed).includes('eve@seclog'));

  assert.equal((await me.post('/me/delete', { password: 'another brand new one 2' })).status, 200);
  const closing = one(eve.own, 'account.closing');
  assert.equal(closing.details.deleted_now, false);
  const back = browser();
  assert.equal((await back.post('/auth/login', { email: 'eve.new@seclog.example', password: 'another brand new one 2' })).status, 200);
  keep(back.cookies.ts_session);
  assert.equal(one(eve.own, 'account.close_undone').actor_id, eve.id);
});

test('API keys: made, used from a new internet address once per address, revoked; settings by name and value, a logo by name only', async () => {
  const made = await ada.c.post('/api-keys', { name: 'Payroll sync', scope: 'admin' });
  const key = keep(made.data.key);
  const k = one(A, 'api_key.created');
  assert.deepEqual([k.actor_id, k.details.name, k.details.scope], [ada.id, 'Payroll sync', 'admin']);
  const keyId = k.about_id;
  const first = withKey(key, '203.0.113.50');
  assert.equal((await first.get('/me')).status, 200);
  assert.equal((await first.get('/me')).status, 200);
  const used1 = one(A, 'api_key.new_address');
  assert.deepEqual([used1.actor_type, used1.actor_id, used1.ip, used1.details.first_use], ['api_key', keyId, '203.0.113.50', true]);
  assert.equal((await withKey(key, '203.0.113.51').get('/me')).status, 200);
  const both = lines(A, 'api_key.new_address');
  assert.deepEqual(both.map((l: any) => [l.ip, JSON.parse(l.details).first_use]), [['203.0.113.50', true], ['203.0.113.51', false]]);
  // What a key does is written with the key as the one who did it.
  assert.equal((await first.call('PATCH', '/account', { default_reminder_days: 5, brand_logo: PNG })).status, 200);
  const s = one(A, 'settings.changed');
  assert.deepEqual([s.actor_type, s.actor_id, s.details.settings.default_reminder_days.to, s.details.settings.brand_logo], ['api_key', keyId, 5, { changed: true }]);
  assert.ok(!s.details.includes?.(PNG) && !JSON.stringify(s.details).includes('base64'));
  assert.equal((await ada.c.call('DELETE', `/api-keys/${keyId}`)).status, 200);
  const r = one(A, 'api_key.revoked');
  assert.deepEqual([r.actor_id, r.about_id, r.details.name], [ada.id, keyId, 'Payroll sync']);
  // The key is gone, and so are the addresses it was seen from.
  assert.equal(db.get('SELECT COUNT(*) n FROM api_key_addresses WHERE key_id=?', keyId).n, 0);
});

test('webhooks by host only, envelopes deleted, purged and put back, template rules, everything exported', async () => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    const w = await ada.c.post('/webhooks', { url: 'http://127.0.0.1:9/hooks/T0SECRET/B0SECRET/xoxSECRETPATH', events: ['envelope.sent'] });
    assert.equal(w.status, 200, JSON.stringify(w.data));
    const made = one(A, 'webhook.created');
    assert.deepEqual([made.details.host, made.about_id], ['127.0.0.1:9', w.data.id]);
    assert.ok(!JSON.stringify(made).includes('SECRET'));
    keep(db.get('SELECT secret FROM webhooks WHERE id=?', w.data.id).secret);
    assert.equal((await ada.c.call('DELETE', `/webhooks/${w.data.id}`)).status, 200);
    assert.equal(one(A, 'webhook.removed').details.host, '127.0.0.1:9');
  } finally {
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  }
  // A draft goes for good; a signed one is only taken out of the lists, and an admin puts it back.
  const draft = await ada.c.post('/envelopes', { subject: 'Draft that goes' });
  assert.equal((await ada.c.call('DELETE', `/envelopes/${draft.data.envelope.id}`)).status, 200);
  const purged = one(A, 'envelope.purged');
  assert.deepEqual([purged.about_type, purged.about_id, purged.details.status], ['envelope', draft.data.envelope.id, 'draft']);
  assert.ok(!JSON.stringify(purged).includes('Draft that goes'));
  const e = await simple(ada.c, 'signer@seclog.example');
  assert.equal((await ada.c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, 'signer@seclog.example')).status, 200);
  assert.equal((await ada.c.call('DELETE', `/envelopes/${e.id}`)).status, 200);
  assert.equal(one(A, 'envelope.deleted').about_id, e.id);
  assert.equal((await ada.c.post(`/envelopes/${e.id}/restore`)).status, 200);
  // Pressed twice: the second finds it in the lists already, and writes nothing.
  assert.equal((await ada.c.post(`/envelopes/${e.id}/restore`)).status, 200);
  assert.equal(one(A, 'envelope.restored').about_id, e.id);

  const tpl = await ada.c.post('/envelopes', { subject: 'Template', kind: 'template' });
  const put = await ada.c.put(`/envelopes/${tpl.data.envelope.id}/access`, { use: 'admins', change: 'owner', locked: true });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const rule = one(A, 'template.rules_changed');
  assert.deepEqual([rule.about_id, rule.details.to.use, rule.details.to.locked, rule.details.from.locked], [tpl.data.envelope.id, 'admins', true, false]);

  const ex = await ada.c.get('/export');
  assert.equal(ex.status, 200);
  const x = one(A, 'export.made');
  assert.deepEqual([x.details.everything, x.details.whose, x.details.envelopes], [true, 'account', 1]);
  // The admin's export carries the record; it names the file in its README.
  const zip = Buffer.from(ex.data).toString('latin1');
  assert.ok(zip.includes('security/security-events.csv'));
  // A member's export of their own envelopes does not.
  const mem = await joinBySignup('Mia Member', 'mia@seclog.example', await invite(ada.c, A, 'mia@seclog.example'));
  const theirs = await simple(mem.c, 'other.signer@seclog.example');
  assert.equal((await mem.c.post(`/envelopes/${theirs.id}/send`)).status, 200);
  const mine = await mem.c.get('/export');
  assert.equal(mine.status, 200);
  assert.ok(!Buffer.from(mine.data).toString('latin1').includes('security/security-events.csv'));
});

test('two-step login: on and off, a wrong code at sign-in, and the record never says whether the password before it was right', async () => {
  const s = await ben.c.post('/me/two-step/setup', { password: PW });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const secret = keep(s.data.secret);
  const on = await ben.c.post('/me/two-step/confirm', { code: code(secret) });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  for (const rc of on.data.codes) keep(rc);
  for (const acc of [A, ben.own]) assert.equal(one(acc, 'two_step.on').actor_id, ben.id);

  // A wrong password for a login with two-step login shows the second screen, as the right one does. The record
  // writes nothing then, and at the code the same reason for both, so an admin of a team Ben is on learns nothing.
  const failedBefore = lines(A, 'signin.failed').length;
  const wrongPw = browser();
  const w1 = await wrongPw.post('/auth/login', { email: ben.email, password: 'a wrong one for sure' });
  assert.equal(w1.data.two_step, true);
  const rightPw = browser();
  const r1 = await rightPw.post('/auth/login', { email: ben.email, password: PW });
  assert.equal(r1.data.two_step, true);
  assert.equal(lines(A, 'signin.failed').length, failedBefore);
  assert.equal((await wrongPw.post('/auth/two-step', { code: '000000' })).status, 401);
  assert.equal((await rightPw.post('/auth/two-step', { code: '000001' })).status, 401);
  const after2 = lines(A, 'signin.failed').slice(failedBefore).map((l: any) => JSON.parse(l.details));
  assert.deepEqual(after2, [{ method: 'password', reason: 'wrong_password_or_code' }, { method: 'password', reason: 'wrong_password_or_code' }]);
  // The right code: a sign-in, with the second step named.
  const ok = await rightPw.post('/auth/two-step', { code: code(secret) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  keep(rightPw.cookies.ts_session);
  const last = lines(A, 'signin.succeeded').pop();
  assert.deepEqual(JSON.parse(last.details), { method: 'password', second_step: 'code' });

  assert.equal((await ben.c.post('/me/two-step/off', { code: code(secret) })).status, 200);
  for (const acc of [A, ben.own]) assert.equal(one(acc, 'two_step.off').actor_id, ben.id);
});

test('the owner hands the account over, and the GrowSigning team pauses and resumes sending without leaving an address', async () => {
  const B = (await person('Bea Owner', 'bea@seclog.example'));
  const zed = await joinBySignup('Zed Next', 'zed@seclog.example', await invite(B.c, B.own, 'zed@seclog.example'));
  assert.equal((await B.c.post('/account/transfer-owner', { user_id: zed.id })).status, 200);
  const h = one(B.own, 'owner.handed_over');
  assert.deepEqual([h.actor_id, h.details.from, h.details.to], [B.id, B.id, zed.id]);

  process.env.OPERATOR_EMAILS = 'op@seclog.example';
  try {
    const op = await person('Opal Operator', 'op@seclog.example');
    assert.equal((await op.c.post(`/operator/accounts/${B.own}`, { paused: true, reason: 'Checking reports' })).status, 200);
    assert.equal((await op.c.post(`/operator/accounts/${B.own}`, { paused: false })).status, 200);
    assert.equal((await op.c.post(`/operator/accounts/${B.own}`, { paused: false })).status, 200);
    const p = one(B.own, 'operator.paused');
    assert.deepEqual([p.actor_type, p.actor_id, p.ip, p.ua, p.details.reason], ['operator', op.id, null, null, 'Checking reports']);
    assert.equal(one(B.own, 'operator.resumed').actor_type, 'operator');
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
});

test('every kind the code writes is a kind the list knows, and nothing secret is in any line', async () => {
  await settle();
  const kinds = db.all('SELECT DISTINCT kind FROM security_events').map((r: any) => r.kind);
  for (const k of kinds) assert.ok(SECURITY_KIND_LIST.includes(k), k);
  const all = JSON.stringify(db.all('SELECT * FROM security_events'));
  for (const s of secrets) assert.ok(!all.includes(s), `found a secret in the record: ${s.slice(0, 6)}...`);
  // No email address either, unless the account shares them (and then only on the way out, never in the table).
  assert.ok(!/[a-z]+@seclog\.example/.test(all), 'an email address is in the table');
  assert.ok(!all.includes('tsk_') && !all.includes('whsec_') && !all.includes('scrypt$'));
});

// ---- 3 and 4: who reads it, and pulling it ----------------------------------------------------------------------

test('members and "send" keys cannot read the record, an admin key pages through it in order, and only a person switches alerts', async () => {
  const mem = await joinBySignup('Mo Member', 'mo@seclog.example', await invite(ada.c, A, 'mo@seclog.example'));
  for (const u of ['/account/security-events', '/account/security-events/view', '/account/security-events/csv', '/account/security'])
    assert.equal((await mem.c.get(u)).status, 403, u);
  const send = withKey(keep((await ada.c.post('/api-keys', { name: 'everyday' })).data.key));
  assert.equal((await send.get('/account/security-events')).status, 403);
  const admin = withKey(keep((await ada.c.post('/api-keys', { name: 'siem', scope: 'admin' })).data.key));
  assert.equal((await admin.call('PATCH', '/account/security', { alerts: { api_key_created: false } })).status, 403);

  const total = lines(A).length;
  const seen: number[] = [];
  let after = '0';
  for (let i = 0; i < 100; i++) {
    const p = await admin.get(`/account/security-events?after=${after}&limit=7`);
    assert.equal(p.status, 200, JSON.stringify(p.data));
    seen.push(...p.data.events.map((e: any) => e.seq));
    for (const e of p.data.events) assert.ok(e.kind && e.at && e.actor && e.hash && !('email' in e.actor));
    after = p.data.next_after;
    if (!p.data.has_more) break;
  }
  // The key's own first use is a line too, written while it pulled.
  assert.ok(seen.length >= total);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  assert.equal(new Set(seen).size, seen.length);
  const empty = await admin.get(`/account/security-events?after=${after}`);
  assert.deepEqual([empty.data.events.length, empty.data.next_after, empty.data.has_more], [0, after, false]);
  assert.match(empty.data.note, /kept for 400 days\. Nobody watches it for you: the alerts are emails\./);
  assert.equal((await admin.get(`/account/security-events?limit=${SECURITY_PAGE_MAX + 1}`)).status, 400);
  assert.equal((await admin.get('/account/security-events?after=abc')).status, 400);
  // Another account's admin sees only their own.
  const zoe = await person('Zoe Else', 'zoe@seclog.example');
  const theirs = await zoe.c.get('/account/security-events?limit=1000');
  assert.ok(theirs.data.events.every((e: any) => db.get('SELECT account_id a FROM security_events WHERE seq=?', e.seq).a === zoe.own));

  // The screen: newest first, filtered by kind, person and dates; the CSV the same; names only when shared.
  const v = await ada.c.get(`/account/security-events/view?kind=member.joined&person=${mem.id}`);
  assert.deepEqual(v.data.events.map((e: any) => [e.kind, e.actor_name]), [['member.joined', 'Mo Member']]);
  assert.equal((await ada.c.get('/account/security-events/view?kind=nope')).status, 400);
  assert.equal((await ada.c.get('/account/security-events/view?from=yesterday')).status, 400);
  const future = new Date(Date.now() + 864e5).toISOString();
  assert.equal((await ada.c.get(`/account/security-events/view?from=${future}`)).data.events.length, 0);
  const csv = await ada.c.get('/account/security-events/csv?kind=api_key.created');
  assert.equal(csv.status, 200);
  const text = Buffer.from(csv.data).toString('utf8');
  assert.ok(text.includes('"api_key.created"') && !text.includes('ada@seclog.example'));
  assert.equal((await ada.c.call('PATCH', '/account/security', { emails: true })).status, 200);
  assert.ok(Buffer.from((await ada.c.get('/account/security-events/csv?kind=api_key.created')).data).toString('utf8').includes('ada@seclog.example'));
  const pulled = await admin.get('/account/security-events?limit=1000');
  assert.ok(pulled.data.events.some((e: any) => e.actor.email === 'ada@seclog.example'));
  assert.equal((await ada.c.call('PATCH', '/account/security', { emails: false })).status, 200);
  assert.equal((await ada.c.call('PATCH', '/account/security', { emails: 'yes' })).status, 400);
  assert.equal((await ada.c.call('PATCH', '/account/security', { alerts: { nope: false } })).status, 400);
  const changes = lines(A, 'settings.changed').map((l: any) => JSON.parse(l.details).settings);
  assert.ok(changes.some((s: any) => s.security_log_emails?.to === true) && changes.some((s: any) => s.security_log_emails?.to === false));
});

// ---- 1: lines never change, and go after their days or with their account ---------------------------------------

test('a line cannot be changed or deleted, a forged one breaks the chain, old lines go after SECURITY_LOG_DAYS and all go with the account', async () => {
  assert.throws(() => db.run("UPDATE security_events SET kind='signin.succeeded' WHERE account_id=?", A), /never changed/);
  assert.throws(() => db.run('DELETE FROM security_events WHERE account_id=?', A), /kept for its days/);
  assert.equal(seclog.verifySecurityChain(A).ok, true);

  const kim = await person('Kim Old', 'kim@seclog.example');
  const K = kim.own;
  // A line from 30 days ago, at the start of the account's chain (written as record() would have written it then).
  const at = new Date(Date.now() - 30 * 864e5).toISOString();
  assert.equal((await browser().post('/auth/login', { email: kim.email, password: PW })).status, 200);
  assert.ok(lines(K).length >= 1);
  // Old lines are first in a real record; here one is forged at the end to show the chain notices it.
  db.run('INSERT INTO security_events (account_id, at, actor_type, actor_id, kind, outcome, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)', K, at, 'user', kim.id, 'signin.succeeded', 'success', '{}', 'x', 'y');
  const broken = seclog.verifySecurityChain(K);
  assert.equal(broken.ok, false);
  process.env.SECURITY_LOG_DAYS = '10';
  try {
    assert.ok(seclog.purgeSecurityLog() >= 1);
    assert.equal(db.get('SELECT COUNT(*) n FROM security_events WHERE account_id=? AND at=?', K, at).n, 0);
    assert.ok(lines(K).length >= 1);
    assert.equal(seclog.verifySecurityChain(K).ok, true);
    // A line of today is still kept, also with the shorter days.
    assert.throws(() => db.run('DELETE FROM security_events WHERE account_id=?', K), /kept for its days/);
    assert.match((await kim.c.get('/account/security')).data.note, /kept for 10 days/);
  } finally {
    delete process.env.SECURITY_LOG_DAYS;
    seclog.purgeSecurityLog();
  }
  // Deleting the account at once takes its record with it.
  assert.equal((await kim.c.post('/me/delete', { password: PW, now: true })).status, 200);
  assert.equal(lines(K).length, 0);
});

// ---- 5: alerts ---------------------------------------------------------------------------------------------------

test('alerts: ten failed sign-ins email the admins once an hour, a new key once, switching one off is said to the other admins', async () => {
  const pam = await person('Pam Boss', 'pam@seclog.example');
  const P = pam.own;
  const ray = await joinBySignup('Ray Admin', 'ray@seclog.example', await invite(pam.c, P, 'ray@seclog.example', 'admin'));
  await settle();
  const alerts = (to: string, what: string) => mailTo(to).filter((m: any) => m.subject.startsWith('Security alert for') && m.subject.includes(what));
  for (let i = 0; i < 12; i++) await browser().post('/auth/login', { email: 'ray@seclog.example', password: `wrong password ${i}` });
  await settle();
  assert.equal(alerts('pam@seclog.example', 'Many failed sign-ins').length, 1);
  assert.equal(alerts('ray@seclog.example', 'Many failed sign-ins').length, 1);
  assert.match(alerts('pam@seclog.example', 'Many failed sign-ins')[0].html, /sign-ins to the login of Ray Admin failed/);

  await pam.c.post('/api-keys', { name: 'one' });
  await settle();
  await pam.c.post('/api-keys', { name: 'two' });
  await settle();
  assert.equal(alerts('ray@seclog.example', 'An API key was made').length, 1);
  // An hour later the same alert may go again.
  db.run("UPDATE security_alerts_sent SET at=? WHERE account_id=? AND rule='api_key_created'", new Date(Date.now() - 2 * 3600_000).toISOString(), P);
  await pam.c.post('/api-keys', { name: 'three' });
  await settle();
  assert.equal(alerts('ray@seclog.example', 'An API key was made').length, 2);

  // Switched off by Pam: Ray hears that it was, and no longer hears the alert.
  const off = await pam.c.call('PATCH', '/account/security', { alerts: { api_key_created: false } });
  assert.equal(off.status, 200);
  assert.equal(off.data.alerts.find((a: any) => a.id === 'api_key_created').on, false);
  assert.equal(mailTo('ray@seclog.example').filter((m: any) => m.subject === 'Pam Boss switched off a security alert of Pam Boss\'s workspace').length, 1);
  db.run("UPDATE security_alerts_sent SET at=? WHERE account_id=? AND rule='api_key_created'", new Date(Date.now() - 2 * 3600_000).toISOString(), P);
  await pam.c.post('/api-keys', { name: 'four' });
  await settle();
  assert.equal(alerts('ray@seclog.example', 'An API key was made').length, 2);
  // Every key is still in the record.
  assert.equal(lines(P, 'api_key.created').length, 4);

  // Everything exported, and twenty deletions in an hour.
  const sent = await simple(pam.c, 'x@seclog.example');
  assert.equal((await pam.c.post(`/envelopes/${sent.id}/send`)).status, 200);
  assert.equal((await pam.c.get('/export')).status, 200);
  await settle();
  assert.equal(alerts('ray@seclog.example', 'Everything was exported').length, 1);
  for (let i = 0; i < 21; i++) {
    const d = await pam.c.post('/envelopes', { subject: `Draft ${i}` });
    await pam.c.call('DELETE', `/envelopes/${d.data.envelope.id}`);
  }
  await settle();
  assert.equal(alerts('ray@seclog.example', 'Many documents were deleted').length, 1);
  // The owner handed over.
  assert.equal((await pam.c.post('/account/transfer-owner', { user_id: ray.id })).status, 200);
  await settle();
  assert.equal(alerts('pam@seclog.example', 'The account has a new owner').length, 1);
});

// ---- The webhook --------------------------------------------------------------------------------------------------

test('security.event goes only to a webhook that asked for it by name, with ids only until the account shares names', async () => {
  const hits: any[] = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => (hits.push({ path: req.url, body: JSON.parse(b) }), res.end('ok')));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    const sam = await person('Sam Siem', 'sam@seclog.example');
    assert.equal((await sam.c.post('/webhooks', { url: `http://127.0.0.1:${port}/all` })).status, 200);
    assert.equal((await sam.c.post('/webhooks', { url: `http://127.0.0.1:${port}/sec`, events: ['security.event'] })).status, 200);
    await settle();
    await sam.c.post('/api-keys', { name: 'watched' });
    for (let i = 0; i < 100 && !hits.some((h) => h.body.security_event?.kind === 'api_key.created'); i++) await new Promise((r) => setTimeout(r, 20));
    const got = hits.filter((h) => h.body.event === 'security.event');
    assert.ok(got.length >= 1);
    assert.ok(got.every((h) => h.path === '/sec'), 'a "*" webhook got a security event');
    const k = got.find((h) => h.body.security_event.kind === 'api_key.created').body.security_event;
    assert.deepEqual([k.actor.type, k.actor.id, 'email' in k.actor], ['user', sam.id, false]);
    assert.equal((await sam.c.get('/account/security')).data.webhooks.length, 1);
  } finally {
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    server.close();
  }
  const { openapi } = await import('../src/server/openapi.ts');
  const spec: any = openapi();
  assert.ok(spec.paths['/account/security-events'].get && spec.paths['/account/security'].patch && spec.paths['/account/security-events/csv'].get);
  void cron;
});

// ---- What a stranger can type into it --------------------------------------------------------------------------

test('a browser name that is a formula opens as text in the CSV, and a key from many addresses writes a limited number of lines', async () => {
  const vic = await person('Vic Target', 'vic@seclog.example');
  const evil = browser();
  assert.equal((await evil.call('POST', '/auth/login', { email: vic.email, password: 'guessing here' }, { 'user-agent': '=HYPERLINK("https://evil.example","x")' })).status, 401);
  const csv = Buffer.from((await vic.c.get('/account/security-events/csv?kind=signin.failed')).data).toString('utf8');
  assert.ok(csv.includes(`"'=HYPERLINK(""https://evil.example"",""x"")"`), csv);
  assert.ok(!/(^|,)"=HYPERLINK/m.test(csv));

  const key = keep((await vic.c.post('/api-keys', { name: 'leaky' })).data.key);
  const { KEY_NEW_ADDRESS_PER_DAY } = await import('../src/lib/policy.ts');
  for (let i = 0; i < KEY_NEW_ADDRESS_PER_DAY + 5; i++) assert.equal((await withKey(key, `203.0.114.${i + 1}`).get('/me')).status, 200);
  assert.equal(lines(vic.own, 'api_key.new_address').length, KEY_NEW_ADDRESS_PER_DAY);
  // The addresses past the limit are not remembered, so they are written on a later day.
  const keyId = db.get('SELECT id FROM api_keys WHERE account_id=? AND name=?', vic.own, 'leaky').id;
  assert.equal(db.get('SELECT COUNT(*) n FROM api_key_addresses WHERE key_id=?', keyId).n, KEY_NEW_ADDRESS_PER_DAY);
});

// ==== Repairs after the skeptic's and the simplicity reviewer's reports ============================================

const view = async (c: Client, query = '') => (await c.get(`/account/security-events/view${query}`)).data.events as any[];
const hourBack = (accountId: string, rule: string) => db.run('UPDATE security_alerts_sent SET at=? WHERE account_id=? AND rule=?', new Date(Date.now() - 2 * 3600_000).toISOString(), accountId, rule);

test('repair: INSERT OR REPLACE cannot rewrite a line, the days cannot be set to none, and a line re-chained without the server secret shows', async () => {
  const tom = await person('Tom Tamper', 'tom@seclog.example');
  const T = tom.own;
  await tom.c.post('/api-keys', { name: 'first' });
  await tom.c.post('/api-keys', { name: 'second' });
  const rows = lines(T);
  assert.ok(rows.length >= 3);
  const r = rows[1];
  // The skeptic's probe: the same number again, with another person in it.
  assert.throws(() => db.run('INSERT OR REPLACE INTO security_events (seq, account_id, at, actor_type, actor_id, kind, outcome, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
    r.seq, T, r.at, 'user', 'usr_forged', r.kind, r.outcome, r.details, r.prev_hash, r.hash), /never replaced/);
  assert.equal(db.get('SELECT actor_id FROM security_events WHERE seq=?', r.seq).actor_id, r.actor_id);
  assert.throws(() => db.run('UPDATE security_log_keep SET days=0 WHERE id=1'), /at least one day/);
  assert.throws(() => db.run('DELETE FROM security_log_keep'), /at least one day/);
  assert.equal(seclog.verifySecurityChain(T).ok, true);

  // Someone who can change the database's own rules: the triggers go, a line is rewritten, and every fingerprint is
  // made again the way the code makes it, but without the server's secret (plain SHA-256, as it was before).
  const triggers = db.all("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='security_events'");
  for (const g of triggers) db.run(`DROP TRIGGER ${g.name}`);
  try {
    db.run("UPDATE security_events SET actor_id='usr_forged' WHERE seq=?", r.seq);
    let prev = lines(T)[0].prev_hash || '';
    for (const l of lines(T)) {
      const h = crypto.createHash('sha256').update(JSON.stringify([prev, T, l.at, l.actor_type, l.actor_id || '', l.kind, l.outcome, l.about_type || '', l.about_id || '', l.details, l.ip || '', l.ua || ''])).digest('hex');
      db.run('UPDATE security_events SET prev_hash=?, hash=? WHERE seq=?', prev, h, l.seq);
      prev = h;
    }
    const v = seclog.verifySecurityChain(T);
    assert.deepEqual([v.ok, v.why], [false, 'line']);
    const said = (await tom.c.get('/account/security')).data.chain;
    assert.deepEqual([said.whole, said.why], [false, 'line']);
  } finally {
    for (const g of triggers) db.run(g.sql);
  }
});

test('repair: the newest lines taken away show, and so does a changed note of the newest line; an account with nothing left after its days reads as whole', async () => {
  const una = await person('Una Tail', 'una@seclog.example');
  const U = una.own;
  for (const name of ['a', 'b', 'c']) await una.c.post('/api-keys', { name });
  assert.equal(seclog.verifySecurityChain(U).ok, true);
  const kept = db.get("SELECT sql FROM sqlite_master WHERE name='security_events_kept'").sql;
  db.run('DROP TRIGGER security_events_kept');
  try {
    // The skeptic's probe: the three newest lines go, and what is left still chains.
    const newest = lines(U).slice(-3).map((l: any) => l.seq);
    db.run(`DELETE FROM security_events WHERE seq IN (${newest.join(',')})`);
    const v = seclog.verifySecurityChain(U);
    assert.deepEqual([v.ok, v.why], [false, 'missing']);
    assert.equal((await una.c.get('/account/security')).data.chain.why, 'missing');
    // Pointing the note at the line that is now the newest does not help without the secret.
    const last = lines(U).pop();
    db.run('UPDATE security_heads SET seq=?, hash=?, at=? WHERE account_id=?', last.seq, last.hash, last.at, U);
    assert.equal(seclog.verifySecurityChain(U).ok, false);
    // Nor does removing the note.
    db.run('DELETE FROM security_heads WHERE account_id=?', U);
    assert.equal(seclog.verifySecurityChain(U).ok, false);
  } finally {
    db.run(kept);
  }
  // Every line gone after its days, the honest way: nothing is wrong.
  const old = await person('Olga Old', 'olga@seclog.example');
  process.env.SECURITY_LOG_DAYS = '1';
  const real = Date.now;
  try {
    seclog.purgeSecurityLog();
    assert.throws(() => db.run('DELETE FROM security_events WHERE account_id=?', old.own), /kept for its days/);
  } finally {
    delete process.env.SECURITY_LOG_DAYS;
    seclog.purgeSecurityLog();
    Date.now = real;
  }
  // After the server's secret was changed, the lines written before still check when the old one is named as retired.
  const { secret } = await import('../src/server/db.ts');
  const was = process.env.APP_SECRET;
  const oldSecret = secret();
  process.env.APP_SECRET = 'a new secret after rotating';
  try {
    assert.deepEqual([seclog.verifySecurityChain(A).ok, seclog.verifySecurityChain(A).why], [false, 'line']);
    process.env.APP_SECRET_RETIRED = `something else, ${oldSecret}`;
    assert.equal(seclog.verifySecurityChain(A).ok, true);
  } finally {
    if (was === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = was;
    delete process.env.APP_SECRET_RETIRED;
  }
  assert.equal(seclog.verifySecurityChain(A).ok, true);
  // The newest lines only are checked on the screen, and a short check of a long record is still right.
  assert.equal(seclog.verifySecurityChain(A, 3).ok, true);
  assert.equal(seclog.verifySecurityChain(A, 3).checked, 3);
});

test('repair: a key or a secret in the browser name is left out, and an ordinary browser name is kept', async () => {
  const wes = await person('Wes Agent', 'wes@seclog.example');
  for (const ua of ['curl Bearer tsk_live_abcdefghijklmnop whsec_zzz', 'tool/1 Bearer abcdefghijklmnop', 'x whsec_abcdef']) {
    assert.equal((await browser().call('POST', '/auth/login', { email: wes.email, password: 'a wrong guess' }, { 'user-agent': ua })).status, 401);
  }
  assert.equal((await browser().call('POST', '/auth/login', { email: wes.email, password: 'a wrong guess' }, { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15' })).status, 401);
  const uas = lines(wes.own, 'signin.failed').map((l: any) => l.ua);
  assert.deepEqual(uas.slice(0, 3), ['[left out]', '[left out]', '[left out]']);
  assert.match(uas[3], /Macintosh/);
  const everything = JSON.stringify(lines(wes.own)) + Buffer.from((await wes.c.get('/account/security-events/csv')).data).toString('utf8');
  assert.ok(!/tsk_live|whsec_|abcdefghijklmnop/.test(everything));
  // On the screen the browser is words, never the raw text.
  const shown = (await view(wes.c, '?kind=signin.failed'))[0];
  assert.equal(shown.device, 'Mac or iPad, Safari');
});

test('repair: someone who left the team is no longer named: not by the API, the webhook view, the download or the screen', async () => {
  const eve = await person('Eve Owner', 'eve@seclog.example');
  const E = eve.own;
  const gus = await joinBySignup('Gus Leaver', 'gus@seclog.example', await invite(eve.c, E, 'gus@seclog.example', 'admin'));
  assert.equal((await eve.c.call('PATCH', '/account/security', { emails: true })).status, 200);
  const key = keep((await eve.c.post('/api-keys', { name: 'siem', scope: 'admin' })).data.key);
  const pulled = async () => (await withKey(key).get('/account/security-events?limit=1000')).data.events as any[];
  // While on the team, with names switched on: named.
  assert.ok((await pulled()).some((e) => e.actor.id === gus.id && e.actor.email === 'gus@seclog.example'));
  assert.equal((await eve.c.call('DELETE', `/account/members/${gus.id}`)).status, 200);
  // Afterwards they change their name and address, in a workspace that is theirs alone.
  db.run("UPDATE users SET name='Gus Newname', email='gus.new@elsewhere.example' WHERE id=?", gus.id);
  const after = await pulled();
  const about = after.filter((e) => e.actor.id === gus.id || e.about?.id === gus.id);
  assert.ok(about.length >= 2);
  for (const e of about) {
    assert.ok(!('name' in e.actor && e.actor.id === gus.id) && !('email' in e.actor && e.actor.id === gus.id), JSON.stringify(e.actor));
    if (e.about?.id === gus.id) assert.ok(!('name' in e.about) && !('email' in e.about));
  }
  const all = JSON.stringify(after) + JSON.stringify(await view(eve.c)) + Buffer.from((await eve.c.get('/account/security-events/csv')).data).toString('utf8') + Buffer.from((await withKey(key).get('/account/security-events/csv')).data).toString('utf8');
  assert.ok(!/Gus Newname|gus\.new@elsewhere|Gus Leaver|gus@seclog/.test(all), 'a former member is named');
  const removed = (await view(eve.c, '?kind=member.removed'))[0];
  assert.equal(removed.about_name, 'someone who is no longer on the team');
  assert.equal(removed.actor_name, 'Eve Owner');
});

test('repair: switching an alert off and on fifteen times is one email to the other admins, and one more when the hour is over and it is still off', async () => {
  const ida = await person('Ida Flood', 'ida@seclog.example');
  const I = ida.own;
  await joinBySignup('Jon Other', 'jon@seclog.example', await invite(ida.c, I, 'jon@seclog.example', 'admin'));
  const told = () => mailTo('jon@seclog.example').filter((m: any) => /switched off a security alert/.test(m.subject)).length;
  for (let i = 0; i < 15; i++) {
    assert.equal((await ida.c.call('PATCH', '/account/security', { alerts: { everything_exported: false } })).status, 200);
    if (i < 14) assert.equal((await ida.c.call('PATCH', '/account/security', { alerts: { everything_exported: true } })).status, 200);
  }
  assert.equal(told(), 1);
  // Another alert is its own email: one admin cannot hide a second switch-off behind the first.
  assert.equal((await ida.c.call('PATCH', '/account/security', { alerts: { api_key_created: false } })).status, 200);
  assert.equal(told(), 2);
  // Every switch is still a line.
  assert.equal(lines(I, 'settings.changed').length, 30);
  // Nothing more within the hour; when it is over, one email says it is off now.
  assert.equal(await seclog.sendHeldAlerts(), 0);
  hourBack(I, 'off:everything_exported');
  assert.equal(await seclog.sendHeldAlerts(), 2);
  assert.equal(mailTo('jon@seclog.example').filter((m: any) => m.subject === "A security alert of Ida Flood's workspace is switched off").length, 1);
  assert.equal(await seclog.sendHeldAlerts(), 0);
});

test('repair: a second API key made within the hour of the first is named to the admins when the hour is over', async () => {
  const kay = await person('Kay Keys', 'kay@seclog.example');
  const K = kay.own;
  await kay.c.post('/api-keys', { name: 'ordinary' });
  await settle();
  await kay.c.post('/api-keys', { name: 'hostile one', scope: 'admin' });
  await settle();
  const mails = () => mailTo('kay@seclog.example').filter((m: any) => m.subject.startsWith('Security alert for'));
  assert.equal(mails().length, 1);
  assert.equal(db.get("SELECT held FROM security_alerts_sent WHERE account_id=? AND rule='api_key_created'", K).held, 1);
  // The timer within the hour: nothing yet. The purge does not forget what is held either.
  assert.equal(await seclog.sendHeldAlerts(), 0);
  hourBack(K, 'api_key_created');
  seclog.purgeSecurityLog();
  assert.equal(await seclog.sendHeldAlerts(), 1);
  const follow = mails().pop();
  assert.match(follow.subject, /1 more since the last alert/);
  assert.match(follow.html, /hostile one/);
  assert.match(follow.html, /Can do everything an admin can/);
  assert.ok(!follow.html.includes('Named ordinary'), 'the key of the first email is not repeated');
  assert.equal(await seclog.sendHeldAlerts(), 0);
  // An alert that was switched off in between says nothing afterwards.
  await kay.c.post('/api-keys', { name: 'third' });
  await settle();
  await kay.c.post('/api-keys', { name: 'fourth' });
  await settle();
  await kay.c.call('PATCH', '/account/security', { alerts: { api_key_created: false } });
  hourBack(K, 'api_key_created');
  assert.equal(await seclog.sendHeldAlerts(), 0);
});

test('repair: an invitation withdrawn, new recovery codes, remembered devices withdrawn and signing up each write one line, without an address or a code', async () => {
  const lea = await person('Lea Lines', 'lea@seclog.example');
  const L = lea.own;
  // Signing up signed her in.
  const up = lines(L, 'signin.succeeded').map((l: any) => ({ ...l, details: JSON.parse(l.details) }));
  assert.equal(up.length, 1);
  assert.deepEqual([up[0].actor_id, up[0].details], [lea.id, { method: 'sign_up', new_login: true }]);
  // An admin invitation, withdrawn.
  await invite(lea.c, L, 'never@seclog.example', 'admin');
  const inv = db.get('SELECT id FROM invites WHERE account_id=?', L).id;
  assert.equal((await lea.c.call('DELETE', `/account/invites/${inv}`)).status, 200);
  const w = one(L, 'member.invite_withdrawn');
  assert.deepEqual([w.actor_id, w.about_type, w.about_id, w.details], [lea.id, 'invite', inv, { role: 'admin' }]);
  // Withdrawing it again, or one of another account, writes nothing.
  await lea.c.call('DELETE', `/account/invites/${inv}`);
  const other = db.get('SELECT id FROM invites WHERE account_id != ? LIMIT 1', L);
  if (other) await lea.c.call('DELETE', `/account/invites/${other.id}`);
  assert.equal(lines(L, 'member.invite_withdrawn').length, 1);

  const s = await lea.c.post('/me/two-step/setup', { password: PW });
  const secret = keep(s.data.secret);
  const on = await lea.c.post('/me/two-step/confirm', { code: code(secret) });
  for (const rc of on.data.codes) keep(rc);
  const fresh = await lea.c.post('/me/two-step/recovery-codes', { code: code(secret) });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  for (const rc of fresh.data.codes) keep(rc);
  assert.equal(one(L, 'two_step.codes_renewed').actor_id, lea.id);
  // A browser that is remembered, then withdrawn from Settings.
  const b = browser();
  assert.equal((await b.post('/auth/login', { email: lea.email, password: PW })).data.two_step, true);
  assert.equal((await b.post('/auth/two-step', { code: code(secret), remember: true })).status, 200);
  keep(b.cookies.ts_session);
  for (const v of Object.values(b.cookies)) keep(v);
  assert.equal((await lea.c.call('DELETE', '/me/two-step/devices')).status, 200);
  const d = one(L, 'two_step.devices_forgotten');
  assert.deepEqual([d.actor_id, d.details.devices], [lea.id, 1]);
  // With none left, nothing is written.
  assert.equal((await lea.c.call('DELETE', '/me/two-step/devices')).status, 200);
  assert.equal(lines(L, 'two_step.devices_forgotten').length, 1);

  const all = JSON.stringify(lines(L));
  for (const x of secrets) assert.ok(!all.includes(x), `found a secret in the record: ${x.slice(0, 6)}...`);
  assert.ok(!all.includes('never@seclog.example'));
  // Each reads as a sentence on the screen, and no id is in the words.
  for (const e of await view(lea.c)) assert.ok(!/\b(usr|inv|key|whk|env|acc)_[A-Za-z0-9]/.test(JSON.stringify([e.actor_name, e.about_name, e.said, e.device])), JSON.stringify(e));
});

test('repair: Google connected to a login, a sign-in with it and its removal are each one line', async () => {
  const G = { id: 'seclog.apps.google.test', secret: 'google-secret-for-seclog' };
  keep(G.secret);
  Object.assign(process.env, { GOOGLE_CLIENT_ID: G.id, GOOGLE_CLIENT_SECRET: G.secret });
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64 = (v: any) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const codes = new Map<string, string>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    const json = (out: any, status = 200) => new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
    if (u.host !== 'oauth2.googleapis.com' && u.host !== 'www.googleapis.com') return realFetch(url, init);
    if (u.pathname === '/oauth2/v3/certs') return json({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
    if (init.method === 'POST' && u.pathname === '/token') {
      const p = Object.fromEntries(new URLSearchParams(String(init.body)));
      const token = codes.get(p.code);
      codes.delete(p.code);
      return token ? json({ access_token: 'not-used', token_type: 'Bearer', id_token: token }) : json({ error: 'invalid_grant' }, 400);
    }
    return json({ error: 'not_found' }, 404);
  }) as any;
  const { handle } = await import('../src/server/router.ts');
  const go = async (c: Client, url: string) => {
    const res = await handle(new Request(`http://test.local/api${url}`, { headers: { cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': c.ip } }));
    for (const ck of res.headers.getSetCookie()) {
      const [kv] = ck.split(';');
      c.cookies[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
    }
    return { status: res.status, location: res.headers.get('location') || '' };
  };
  const approve = (location: string, who: Record<string, any>) => {
    const auth = new URL(location);
    const t = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
    const body = b64({ iss: 'https://accounts.google.com', azp: G.id, aud: auth.searchParams.get('client_id'), nonce: auth.searchParams.get('nonce'), iat: t, exp: t + 3600, email_verified: true, ...who });
    const code = keep(`code-${crypto.randomBytes(8).toString('hex')}`);
    codes.set(code, keep(`${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.privateKey).toString('base64url')}`));
    return `/auth/google/callback?${new URLSearchParams({ code, state: keep(auth.searchParams.get('state')!) })}`;
  };
  try {
    const mia = await person('Mia Google', 'gina@seclog.example');
    const who = { sub: 'google-sub-mia-1', email: 'gina@seclog.example', name: 'Mia Google' };
    // Connected from Settings.
    const start = await mia.c.post('/me/signin/google/connect');
    assert.equal(start.status, 200, JSON.stringify(start.data));
    assert.equal((await go(mia.c, approve(start.data.url, who))).status, 302);
    const con = one(mia.own, 'signin_method.connected');
    assert.deepEqual([con.actor_id, con.about_id, con.details.provider], [mia.id, mia.id, 'google']);
    // A sign-in with it, in another browser.
    const b = browser();
    const s = await go(b, '/auth/google/start');
    assert.equal(s.status, 302);
    assert.equal((await go(b, approve(s.location, who))).status, 302);
    keep(b.cookies.ts_session);
    const ins = lines(mia.own, 'signin.succeeded').map((l: any) => ({ ...l, details: JSON.parse(l.details) })).filter((l: any) => l.details.method === 'google');
    assert.equal(ins.length, 1);
    assert.deepEqual([ins[0].actor_id, ins[0].ip], [mia.id, b.ip]);
    assert.deepEqual(seclog.screenView(ins[0].seq ? db.get('SELECT * FROM security_events WHERE seq=?', ins[0].seq) : null).said, ['With Google.']);
    // Removed again.
    const idn = db.get('SELECT id FROM identities WHERE user_id=?', mia.id).id;
    assert.equal((await mia.c.call('DELETE', `/me/signin/${idn}`)).status, 200);
    const rem = one(mia.own, 'signin_method.removed');
    assert.deepEqual([rem.actor_id, rem.details.provider], [mia.id, 'google']);
    const all = JSON.stringify(lines(mia.own));
    assert.ok(!all.includes('google-sub-mia-1') && !all.includes(G.secret));
    for (const x of secrets) assert.ok(!all.includes(x), `found a secret in the record: ${x.slice(0, 6)}...`);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  }
});

test('repair: the search box finds lines by a name, by what happened and by a key name; the signed-in download has names, a key gets ids', async () => {
  const noa = await person('Noa Search', 'noa@seclog.example');
  const N = noa.own;
  const pat = await joinBySignup('Pat Finder', 'pat@seclog.example', await invite(noa.c, N, 'pat@seclog.example', 'member'));
  const key = keep((await noa.c.post('/api-keys', { name: 'Payroll sync', scope: 'admin' })).data.key);
  assert.equal((await browser().post('/auth/login', { email: 'pat@seclog.example', password: 'not right at all' })).status, 401);
  const kinds = async (q: string) => (await view(noa.c, `?q=${encodeURIComponent(q)}`)).map((e) => e.kind);
  assert.deepEqual([...new Set(await kinds('pat finder'))].sort(), ['member.joined', 'signin.failed', 'signin.succeeded']);
  assert.deepEqual(await kinds('failed'), ['signin.failed']);
  assert.deepEqual(await kinds('payroll'), ['api_key.created']);
  assert.deepEqual(await kinds('PAT failed'), ['signin.failed']);
  assert.deepEqual(await kinds('nothing like this is in it'), []);
  // What is typed is words, never part of the question to the database.
  assert.deepEqual(await kinds("%' OR 1=1 --"), []);
  assert.deepEqual(await kinds('_'), (await kinds('_')).filter(() => true));
  // Search and the other filters work together, and the download follows both.
  assert.deepEqual((await view(noa.c, `?q=pat&kind=member.joined`)).map((e) => e.kind), ['member.joined']);
  const mine = Buffer.from((await noa.c.get('/account/security-events/csv?q=pat')).data).toString('utf8');
  assert.match(mine.split('\r\n')[0], /"said"/);
  assert.ok(mine.includes('"Pat Finder"') && mine.includes('Wrong password.'));
  assert.ok(!mine.includes('pat@seclog.example'), 'email addresses stay out until they are switched on');
  assert.ok(!mine.includes('Payroll'));
  const machine = Buffer.from((await withKey(key).get('/account/security-events/csv?q=pat')).data).toString('utf8');
  assert.ok(machine.includes(pat.id) && !machine.includes('Pat Finder'));
  // Another account's admin finds nothing of this one by searching for its people.
  assert.deepEqual((await view(ada.c, '?q=pat%20finder')).length, 0);
  // A cursor that is not a number is said, not ignored.
  const badBefore = await noa.c.get('/account/security-events/view?before=abc');
  assert.equal(badBefore.status, 400);
  assert.match(badBefore.data.error, /whole number\. Leave it out/);
});

test('repair: a long record is exported in files of a set size, and addresses a key was used from are forgotten after the days', async () => {
  const quy = await person('Quy Export', 'quy@seclog.example');
  const Q = quy.own;
  const key = keep((await quy.c.post('/api-keys', { name: 'k' })).data.key);
  assert.equal((await withKey(key, '203.0.113.77').get('/me')).status, 200);
  const n = lines(Q).length;
  assert.ok(n >= 3);
  const files = [...seclog.securityExport(Q, 2)];
  assert.equal(files.length, Math.ceil(n / 2) + (n % 2 === 0 ? 1 : 0) - (n % 2 === 0 ? 1 : 0) || files.length);
  assert.ok(files.every((f) => /^security\/security-events-\d+\.csv$/.test(f.name)));
  const rows = files.flatMap((f) => f.data.toString('utf8').replace('﻿', '').split('\r\n').slice(1)).filter(Boolean);
  assert.equal(rows.length, n);
  assert.ok(files.every((f) => f.data.toString('utf8').split('\r\n').length <= 3));
  assert.ok(rows.some((r) => r.includes('"Quy Export"')));
  // A short record is one file with the name it always had.
  assert.deepEqual([...seclog.securityExport(Q)].map((f) => f.name), ['security/security-events.csv']);

  const keyId = db.get('SELECT id FROM api_keys WHERE account_id=?', Q).id;
  assert.equal(db.get('SELECT COUNT(*) n FROM api_key_addresses WHERE key_id=?', keyId).n, 1);
  db.run('UPDATE api_key_addresses SET at=? WHERE key_id=?', new Date(Date.now() - 401 * 864e5).toISOString(), keyId);
  seclog.purgeSecurityLog();
  assert.equal(db.get('SELECT COUNT(*) n FROM api_key_addresses WHERE key_id=?', keyId).n, 0);
});

test('repair: the words: no envelope, recipient, purge, legal hold or events on the screen, details as sentences, every kind and alert has its words', async () => {
  const lib = await import('../src/lib/seclog.ts');
  const { CATALOGUES } = await import('../src/lib/i18n.ts');
  const en = CATALOGUES.en as Record<string, string>;
  for (const k of lib.SECURITY_KIND_LIST) assert.ok(en[`security.kind.${k}`], `no words for ${k}`);
  for (const [g, kinds] of lib.SECURITY_GROUPS) {
    assert.ok(en[`security.group.${g}`], g);
    for (const k of kinds) assert.ok(lib.isSecurityKind(k));
  }
  assert.deepEqual(lib.SECURITY_GROUPS.flatMap(([, k]) => k).sort(), [...lib.SECURITY_KIND_LIST].sort(), 'every kind is in one group of the filter');
  for (const a of lib.SECURITY_ALERT_LIST) assert.ok(en[`security.alert.${a}`]);
  const screen = Object.entries(en).filter(([k]) => k.startsWith('settings.security.') || /^security\.(kind|group|alert|detail|who|device|setting|words)/.test(k));
  assert.ok(screen.length > 150);
  for (const [k, v] of screen) {
    assert.ok(!/envelope|recipient|purge|legal hold|\bevents?\b|24\/7|monitor|—/i.test(v), `${k}: ${v}`);
    // Technical names only where the destination is set up.
    if (!/siem_title|webhook|kind\.webhook|group\.keys|detail\.hook/.test(k)) assert.ok(!/next_after|security\.event|\bGET\b|scope|SIEM|syslog/i.test(v), `${k}: ${v}`);
  }
  assert.equal(lib.securityLogWords(400), 'Who signed in and what changed, kept for 400 days. Nobody watches it for you: the alerts are emails.');
  assert.equal(en['settings.security.search_label'], 'Search the record');

  const said = (kind: string, d: any) => lib.securityDetail(kind, d).join(' ');
  assert.equal(said('member.role_changed', { from: 'admin', to: 'member' }), 'Role changed from admin to member.');
  assert.equal(said('signin.failed', { method: 'password', reason: 'wrong_password' }), 'Wrong password.');
  assert.equal(said('member.joined', { role: 'member', invite: 'inv_hJ1GopbQ9uTnSR7' }), 'Joined with the role member.');
  assert.equal(said('settings.changed', { settings: { default_reminder_days: { from: 3, to: 7 } } }), 'Days between reminders: 3 changed to 7.');
  assert.equal(said('settings.changed', { settings: { alert_api_key_created: { from: true, to: false } } }), 'Alert switched off: An API key is made.');
  assert.equal(said('settings.changed', { settings: { brand_logo: { changed: true } } }), 'Logo changed.');
  assert.equal(said('api_key.created', { name: 'Payroll sync', scope: 'admin' }), 'Named Payroll sync. Can do everything an admin can.');
  assert.equal(said('signin.succeeded', { method: 'password' }), '');
  assert.equal(said('signout.everywhere', { signed_out: 2, devices_forgotten: 0 }), '2 other sign-ins ended.');
  assert.equal(said('retention.changed', { days: 365, level: 'files', was_days: 0, was_level: null, templates: 0 }), 'Finished documents are now kept for 365 days. Before: until someone deletes them.');
  // Something nobody wrote a sentence for is still words, and an id never shows.
  assert.equal(said('envelope.purged', { kind: 'template', status: 'draft', made_by: 'usr_zqMz3FFvTcMjfYhv', odd_new_detail: 'by_hand' }), 'It was draft. Odd new detail: by hand.');
  assert.equal(lib.securityDevice('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/157.0.8103.78 Safari/537.36'), 'Linux computer, Chrome');
  assert.equal(lib.securityDevice(''), '');
  assert.equal(lib.securityDevice('[left out]'), '');
  // Every line written by this whole file reads without an id or a field name with an underscore.
  for (const r of db.all('SELECT * FROM security_events')) {
    const v = seclog.screenView(r);
    assert.ok(!/\b(usr|inv|key|whk|env|acc|tpl)_[A-Za-z0-9]{6,}|[a-z]_[a-z]/.test(v.said.join(' ')), `${r.kind}: ${v.said.join(' ')} <- ${r.details}`);
  }
});
