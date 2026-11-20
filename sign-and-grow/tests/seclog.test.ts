// The security record of an account (src/server/seclog.ts, src/server/routes-seclog.ts). Pinned down: every kind of
// event is written once, to the right accounts, with the right person and internet address; nothing secret is kept
// (the test's passwords, keys, tokens, codes and email addresses are looked for in every line); members and "send"
// keys cannot read it and an admin key pages through it; lines cannot be changed or deleted, and go after
// SECURITY_LOG_DAYS and with their account; the chain shows a forged line; the alerts are throttled and can be
// switched off by a person only; the webhook is opt-in; the export carries it for admins.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
    const s = one(acc, 'signin.succeeded');
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
  assert.equal(alerts('ray@seclog.example', 'Many envelopes were deleted').length, 1);
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
