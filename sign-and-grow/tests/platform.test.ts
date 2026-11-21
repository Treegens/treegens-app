// Platform and security: where the links in emails come from, whose address a request has, what an API key may
// do and what it says when it cannot be used, and webhooks that either arrive or can be sent again.
import { dayText } from '../src/lib/dates.ts'; // days in sentences read 21 Dec 2026 (simplify-public)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { boot, Client, simple, mailTo, type Server } from './helpers.ts';

let db: Server['db'];
let cron: Server['cron'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

// A client that sends an API key instead of a session cookie.
function withKey(key: string, scheme = 'Bearer') {
  const c = new Client();
  const call = c.call.bind(c);
  c.call = (m: string, u: string, b?: any, h: Record<string, string> = {}) => call(m, u, b, { authorization: `${scheme} ${key}`, ...h });
  return c;
}
const newKey = async (c: Client, body: any = { name: 'Website integration' }) => (await c.post('/api-keys', body)).data.key as string;

// Sign-ups are limited per address, and this file needs more people than one address may create in an hour.
// So everybody here arrives from an address of their own.
let people = 0;
const person = () => Object.assign(new Client(), { ip: `192.0.2.${++people}` });
async function signUp(name: string, email: string) {
  const c = person();
  const r = await c.post('/auth/signup', { name, email, password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await c.post('/auth/verify', { token: db.get('SELECT verify_token t FROM users WHERE email=?', email).t })).status, 200);
  return c;
}
// A team member who joined through an invitation.
async function join(owner: Client, name: string, email: string, role = 'member') {
  assert.equal((await owner.post('/account/invites', { email, role })).status, 200);
  const inv = db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL', email).token;
  const c = person();
  assert.equal((await c.post('/auth/signup', { name, email, password: 'correct horse battery', invite: inv })).status, 200);
  return c;
}

// ---- A stand-in for a customer's webhook endpoint, and for DNS -----------------------------------------------

type Hit = { path: string; host: string; body: string; event: string };
const hits: Hit[] = [];
let release: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
const flood = { bytes: 0, closed: false };
let port = 0;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    hits.push({ path: req.url!, host: String(req.headers.host), body, event: String(req.headers['x-growsigning-event']) });
    if (req.url === '/slow') await gate;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/landed` });
      return res.end();
    }
    if (req.url === '/flood') {
      // Answers 200 and then never stops talking.
      res.writeHead(200, { 'content-type': 'text/plain' });
      const chunk = Buffer.alloc(256 * 1024, 'x');
      const timer = setInterval(() => (res.write(chunk), (flood.bytes += chunk.length)), 5);
      res.on('close', () => (clearInterval(timer), (flood.closed = true)));
      return;
    }
    res.statusCode = req.url === '/down' ? 500 : 200;
    res.end('ok');
  });
});

// Names the tests know about. Anything else does not exist, so no test ever asks a real name server.
const names: Record<string, () => string> = {};
const lookups: string[] = [];
const realLookup = dns.lookup;

before(async () => {
  ({ db, cron } = await boot());
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  port = (srv.address() as any).port;
  (dns as any).lookup = async (host: string) => {
    lookups.push(host);
    if (!names[host]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    const address = names[host]();
    return [{ address, family: net.isIP(address) }];
  };
});
after(() => {
  (dns as any).lookup = realLookup;
  srv.closeAllConnections();
  srv.close();
});

const deliveriesOf = (hookId: string) => db.all('SELECT * FROM webhook_deliveries WHERE webhook_id=? ORDER BY id', hookId);
const addHook = async (c: Client, url: string) => {
  const r = await c.post('/webhooks', { url });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return (await c.get('/webhooks')).data.webhooks.at(-1);
};
// The smallest real event: an envelope the owner sends to themselves.
async function fire(c: Client, email: string, subject = 'Webhook test') {
  const e = await simple(c, email, { subject });
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  return e;
}
const storedRow = (hookId: string, n: number, over: any = {}) =>
  db.run('INSERT INTO webhook_deliveries (webhook_id, event, envelope_id, status, error, attempts, at, body, done) VALUES (?,?,?,?,?,?,?,?,?)',
    hookId, 'envelope.sent', `env_${n}`, 'status' in over ? over.status : 200, over.error ?? null, over.attempts ?? 1, over.at ?? new Date().toISOString(), over.body ?? JSON.stringify({ id: `evt_stored_${n}` }), over.done ?? 1);

// ---- 1. Links in emails, and the caller's address ------------------------------------------------------------

test('links in emails never take their address from a request header', async () => {
  const owner = await signUp('Vic Tim', 'victim@example.com');
  const e = await simple(owner, 'reminded@example.com', { reminder_days: 1, subject: 'Remind me' });
  await owner.post(`/envelopes/${e.id}/send`);
  db.run('UPDATE envelopes SET sent_at=?, last_reminder_at=NULL WHERE id=?', new Date(Date.now() - 2 * 864e5).toISOString(), e.id);

  const warnings: string[] = [];
  const realError = console.error;
  console.error = (...a: any[]) => void warnings.push(a.join(' '));
  delete process.env.APP_URL;
  try {
    // A stranger asks for a password reset for someone else, and says which host the link should point at.
    const forged = { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };
    await new Client().call('POST', '/auth/forgot', { email: 'victim@example.com' }, forged);
    const reset = mailTo('victim@example.com').at(-1)!;
    assert.match(reset.subject, /Reset your/);
    assert.ok(!reset.link.includes('evil.example') && !reset.html.includes('evil.example'), `the reset link went to ${reset.link.replace(/token=.*/, 'token=...')}`);

    // The same with a plain Host header, then the timer sends a reminder to a signer.
    await new Client().call('GET', '/me', undefined, { host: 'evil.example' });
    await new Client().call('GET', '/me', undefined, forged);
    assert.ok((await cron.tick()).reminded >= 1);
    const reminder = mailTo('reminded@example.com').at(-1)!;
    assert.match(reminder.link, /\/sign\//);
    assert.ok(!reminder.link.includes('evil.example') && !reminder.html.includes('evil.example'), 'a signing link never points at a host a caller named');

    // It is said loudly, and once, however many requests arrive.
    assert.equal(warnings.filter((w) => w.includes('APP_URL IS NOT SET')).length, 1, warnings.join('\n'));

    // Local development still needs no setup: a request to this machine itself is believed.
    await new Client().call('POST', '/auth/forgot', { email: 'victim@example.com' }, { 'x-forwarded-host': 'localhost:3411', 'x-forwarded-proto': 'http' });
    assert.match(mailTo('victim@example.com').at(-1)!.link, /^http:\/\/localhost:3411\/reset\?token=/);
    // And it is not overwritten by the next stranger.
    await new Client().call('POST', '/auth/forgot', { email: 'victim@example.com' }, forged);
    assert.match(mailTo('victim@example.com').at(-1)!.link, /^http:\/\/localhost:3411\/reset\?token=/);
  } finally {
    process.env.APP_URL = 'http://test.local';
    console.error = realError;
  }
  // With APP_URL set, that is the address, whatever a request says.
  await new Client().call('POST', '/auth/forgot', { email: 'victim@example.com' }, { 'x-forwarded-host': 'localhost:9' });
  assert.match(mailTo('victim@example.com').at(-1)!.link, /^http:\/\/test\.local\/reset\?token=/);
});

test('the address of a caller is the one our proxy saw, not one the caller typed', async () => {
  const { clientIp } = await import('../src/server/router.ts');
  const req = (xff?: string) => new Request('http://test.local/api/me', { headers: xff ? { 'x-forwarded-for': xff } : {} });
  const had = process.env.TRUSTED_PROXY_HOPS;
  try {
    delete process.env.TRUSTED_PROXY_HOPS; // the default: one proxy of ours in front
    assert.equal(clientIp(req('198.51.100.7')), '198.51.100.7');
    assert.equal(clientIp(req('6.6.6.6, 198.51.100.7')), '198.51.100.7', 'what the caller put in front is ignored');
    assert.equal(clientIp(new Request('http://test.local/api/me', { headers: { 'x-real-ip': '6.6.6.6' } })), 'unknown', 'and no other header is believed');
    process.env.TRUSTED_PROXY_HOPS = '2';
    assert.equal(clientIp(req('6.6.6.6, 198.51.100.7, 10.0.0.1')), '198.51.100.7');
    assert.equal(clientIp(req('198.51.100.7')), '198.51.100.7', 'a shorter list than expected still gives an entry a proxy wrote');
    process.env.TRUSTED_PROXY_HOPS = '0';
    assert.equal(clientIp(req('6.6.6.6')), 'unknown', 'with no proxy the header is not believed at all');
  } finally {
    if (had === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = had;
  }

  // The limit on guesses holds when the caller invents a new first entry for every request.
  const guesser = new Client();
  let last: any;
  for (let i = 0; i < 11; i++) {
    guesser.ip = `9.9.9.${i}, 198.51.100.77`;
    last = await guesser.post('/auth/forgot', { email: 'nobody@example.com' });
  }
  assert.equal(last.status, 429, 'ten an hour from one real address, whatever the header claims');
});

// ---- 2. API keys ---------------------------------------------------------------------------------------------

test('an API key that cannot be used says what is wrong, and "bearer" may be in any case', async () => {
  const owner = await signUp('Kay Owner', 'kay@example.com');
  const key = await newKey(owner);
  assert.equal((await withKey(key).get('/envelopes')).status, 200);
  assert.equal((await withKey(key, 'bearer').get('/envelopes')).status, 200, 'lower case is the same scheme');
  assert.equal((await withKey(key, 'BEARER').get('/envelopes')).status, 200);

  const none = await new Client().get('/envelopes');
  assert.equal(none.status, 401);
  assert.equal(none.data.error, 'Please sign in.', 'nothing was sent, so this is the right thing to say');

  for (const header of ['Bearer not-a-key', key, `Token ${key}`, 'Bearer']) {
    const r = await new Client().call('GET', '/envelopes', undefined, { authorization: header });
    assert.equal(r.status, 401, header);
    assert.match(r.data.error, /could not read an API key.*Authorization: Bearer tsk_/, header);
  }
  const unknown = await withKey('tsk_this-key-was-never-issued').get('/envelopes');
  assert.equal(unknown.status, 401);
  assert.match(unknown.data.error, /not known here.*revoked.*Create a new key/);

  const id = (await owner.get('/api-keys')).data.keys[0].id;
  assert.equal((await owner.call('DELETE', `/api-keys/${id}`)).status, 200);
  const revoked = await withKey(key).get('/envelopes');
  assert.equal(revoked.status, 401);
  assert.match(revoked.data.error, /not known here.*revoked/);

  // Routes that need no sign-in do not care about a header that is not for them.
  assert.equal((await withKey('tsk_this-key-was-never-issued').get('/me')).data.user, null);
  assert.equal((await new Client().call('GET', '/public/impact', undefined, { authorization: 'Basic abc' })).status, 200);
});

test('a key gets the "send" scope unless "admin" is asked for, and some things no key can do', async () => {
  const owner = await signUp('Sco Pe', 'scope@example.com');
  const made = await owner.post('/api-keys', { name: 'Website integration' });
  assert.equal(made.data.scope, 'send');
  const send = withKey(made.data.key);

  // Everyday work goes through.
  const e = await simple(send, 'client@example.com');
  assert.equal((await send.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal(mailTo('client@example.com').length, 1);
  for (const path of ['/envelopes', '/envelopes?kind=template', '/contacts', '/bulk', '/reports/summary', '/api-keys'])
    assert.equal((await send.get(path)).status, 200, path);
  assert.equal((await send.post('/contacts', { name: 'Con Tact', email: 'con@example.com' })).status, 200);

  // Account settings do not, although the key belongs to the owner.
  for (const [method, path, body] of [
    ['POST', '/account/invites', { email: 'intruder@example.com', role: 'admin' }],
    ['PATCH', '/account', { name: 'Taken over' }],
    ['POST', '/webhooks', { url: 'https://203.0.113.5/hook' }],
  ] as const) {
    const r = await send.call(method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.match(r.data.error, /"send" scope.*"admin" scope/, `${method} ${path}`);
  }
  assert.equal(db.get("SELECT COUNT(*) n FROM invites WHERE email='intruder@example.com'").n, 0);

  // It may read the webhooks and their log, without the signing secrets.
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  await addHook(owner, `http://127.0.0.1:${port}/ok`);
  const seen = await send.get('/webhooks');
  assert.equal(seen.status, 200);
  assert.equal(seen.data.webhooks.length, 1);
  assert.equal(seen.data.webhooks[0].secret, null);
  assert.match((await owner.get('/webhooks')).data.webhooks[0].secret, /^whsec_/);

  // "admin" has to be chosen by name, by an admin.
  assert.equal((await owner.post('/api-keys', { name: 'x', scope: 'everything' })).status, 400);
  const member = await join(owner, 'Mem Ber', 'member.scope@example.com');
  const refused = await member.post('/api-keys', { name: 'x', scope: 'admin' });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /Only account admins/);
  const adminMade = await owner.post('/api-keys', { name: 'Provisioning', scope: 'admin' });
  assert.equal(adminMade.data.scope, 'admin');
  const admin = withKey(adminMade.data.key);
  assert.equal((await admin.call('PATCH', '/account', { name: 'Renamed by provisioning' })).status, 200);
  assert.equal((await admin.post('/account/invites', { email: 'newhire@example.com' })).status, 200);
  assert.match((await admin.get('/webhooks')).data.webhooks[0].secret, /^whsec_/);

  // Even then: no keys, no ownership, no closing, no removing people, no money.
  const memberId = (await member.get('/me')).data.user.id;
  const keyId = (await owner.get('/api-keys')).data.keys[0].id;
  for (const [method, path, body, what] of [
    ['POST', '/api-keys', { name: 'another' }, /create or revoke API keys/],
    ['DELETE', `/api-keys/${keyId}`, undefined, /create or revoke API keys/],
    ['POST', '/account/transfer-owner', { user_id: memberId }, /hand the account/],
    ['DELETE', `/account/members/${memberId}`, undefined, /remove someone/],
    ['POST', '/me/delete', { password: 'correct horse battery', now: true }, /close the account/],
    ['POST', '/billing/cancel', {}, /change the plan, pay or refund/],
    ['POST', '/billing/refund', {}, /change the plan, pay or refund/],
    ['POST', '/billing/redeem', { code: 'GROWalition' }, /change the plan, pay or refund/],
    ['POST', '/billing/checkout', {}, /change the plan, pay or refund/],
    ['POST', '/billing/topup', { quantity: 5 }, /change the plan, pay or refund/],
  ] as const) {
    const r = await admin.call(method, path, body);
    assert.equal(r.status, 403, `${method} ${path}: ${JSON.stringify(r.data)}`);
    assert.match(r.data.error, what, `${method} ${path}`);
    assert.match(r.data.error, /needs a person signed in/, `${method} ${path}`);
  }
  assert.equal((await owner.get('/me')).data.role, 'owner');
  assert.equal((await owner.get('/me')).data.account.free_with, null, 'no code was redeemed through the key');
  assert.equal((await owner.get('/api-keys')).data.keys.length, 2, 'no key was added or revoked through a key');
  assert.equal((await member.get('/envelopes')).status, 200, 'the member is still there');

  // The list shows what each key may do. A key from before scopes existed is a "send" key.
  db.run("INSERT INTO api_keys (id, account_id, user_id, name, prefix, key_hash, created_at) SELECT 'key_old', account_id, user_id, 'Old key', 'tsk_old', 'hash-of-old-key', created_at FROM api_keys WHERE id=?", keyId);
  const list = (await owner.get('/api-keys')).data.keys;
  assert.deepEqual(list.map((k: any) => [k.name, k.scope]).sort(), [['Old key', 'send'], ['Provisioning', 'admin'], ['Website integration', 'send']]);
});

test('removing a team member says which API keys stop, in the answer and by email', async () => {
  const owner = await signUp('Tea Mowner', 'team@example.com');
  const second = await join(owner, 'Ada Admin', 'ada.admin@example.com', 'admin');
  const pat = await join(owner, 'Pat Member', 'pat.keys@example.com');
  const key = await newKey(pat, { name: 'CRM sync' });
  await newKey(pat, { name: 'Nightly export' });
  await newKey(owner, { name: 'Owner key' });
  assert.equal((await withKey(key).get('/envelopes')).status, 200);

  // Admins can see beforehand whose key an integration hangs on. Members see their own.
  const all = (await second.get('/api-keys')).data.keys;
  assert.deepEqual(all.map((k: any) => k.name).sort(), ['CRM sync', 'Nightly export', 'Owner key']);
  const crm = all.find((k: any) => k.name === 'CRM sync');
  assert.equal(crm.owner_name, 'Pat Member');
  assert.equal(crm.owner_email, 'pat.keys@example.com');
  assert.equal(crm.scope, 'send');
  assert.equal(crm.mine, false);
  assert.ok(crm.last_used_at, 'when it was last used');
  assert.ok(!JSON.stringify(all).includes(key) && !('key_hash' in crm), 'never the key itself');
  assert.deepEqual((await pat.get('/api-keys')).data.keys.map((k: any) => k.name).sort(), ['CRM sync', 'Nightly export']);

  const patId = (await pat.get('/me')).data.user.id;
  const removed = await owner.call('DELETE', `/account/members/${patId}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data.keys_stopped.map((k: any) => k.name).sort(), ['CRM sync', 'Nightly export']);

  // Whatever used the key is told what happened, not "Please sign in."
  const after = await withKey(key).get('/envelopes');
  assert.equal(after.status, 401);
  assert.match(after.data.error, /stopped working on \d{4}-\d\d-\d\d because the person who created it is no longer in the account/);

  // Both admins and the person removed get the names.
  for (const to of ['team@example.com', 'ada.admin@example.com', 'pat.keys@example.com']) {
    // The person removed gets one email about all of it: that they were removed, what became of their work, the keys.
    const m = mailTo(to).find((x) => (to === 'pat.keys@example.com' ? /You were removed from/ : /stopped working/).test(x.subject));
    assert.ok(m, `no email to ${to}`);
    assert.ok(m.html.includes('CRM sync') && m.html.includes('Nightly export'), to);
  }
  assert.match(mailTo('team@example.com').find((x) => /stopped working/.test(x.subject))!.subject, /2 API keys stopped working: Pat Member was removed/);

  // The stopped keys stay on the admins' list until someone clears them, and coming back does not revive them.
  const stopped = (await owner.get('/api-keys')).data.keys.filter((k: any) => k.stopped_at);
  assert.deepEqual(stopped.map((k: any) => k.name).sort(), ['CRM sync', 'Nightly export']);
  db.run("INSERT INTO memberships (account_id, user_id, role, created_at) SELECT account_id, ?, 'member', created_at FROM memberships WHERE user_id=(SELECT id FROM users WHERE email='team@example.com')", patId);
  assert.equal((await withKey(key).get('/envelopes')).status, 401);
  assert.equal((await second.call('DELETE', `/api-keys/${stopped[0].id}`)).status, 200, 'an admin can clear any key in the account');
  assert.equal((await owner.get('/api-keys')).data.keys.filter((k: any) => k.stopped_at).length, 1);

  // Removing someone who has no keys sends no such email.
  const quiet = await join(owner, 'No Keys', 'nokeys@example.com');
  const r = await owner.call('DELETE', `/account/members/${(await quiet.get('/me')).data.user.id}`);
  assert.deepEqual(r.data.keys_stopped, []);
  assert.ok(!mailTo('nokeys@example.com').some((x) => /stopped working/.test(x.subject)));
  // They are still told that they were removed, and that their login stays.
  const told = mailTo('nokeys@example.com').find((x) => /^You were removed from /.test(x.subject));
  assert.ok(told, 'the person removed hears it from us');
  assert.match(told.html, /You had sent nothing there/);
  assert.match(told.html, /Your own login stays/);
  assert.ok(!/API key/.test(told.html));
});

test('API keys are switched off while an account is being closed, and work again when it is restored', async () => {
  const owner = await signUp('Clo Sing', 'closing.keys@example.com');
  const api = withKey(await newKey(owner));
  const e = await simple(api, 'afterclose@example.com');

  assert.equal((await owner.post('/me/delete', { password: 'correct horse battery' })).data.closed, 'scheduled');
  const read = await api.get('/envelopes');
  assert.equal(read.status, 403);
  assert.match(read.data.error, /This account is being closed.*Nothing is deleted before \d{4}-\d\d-\d\d.*Signing in/);
  assert.equal((await api.post(`/envelopes/${e.id}/send`)).status, 403);
  assert.equal(mailTo('afterclose@example.com').length, 0, 'nothing is sent for an account that is going away');

  assert.equal((await owner.post('/auth/login', { email: 'closing.keys@example.com', password: 'correct horse battery' })).data.restored, true);
  assert.equal((await api.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal(mailTo('afterclose@example.com').length, 1);

  // The same holds for a team member's key while that person is closing their own login.
  const mate = await join(owner, 'Team Mate', 'mate.closing@example.com');
  const mateApi = withKey(await newKey(mate));
  assert.equal((await mate.post('/me/delete', { password: 'correct horse battery' })).data.closed, 'scheduled');
  const off = await mateApi.get('/envelopes');
  assert.equal(off.status, 403);
  assert.match(off.data.error, /The person who created this API key is closing their login/);
  assert.equal((await api.get('/envelopes')).status, 200, 'the rest of the team is not affected');
});

test('a member who closes their own login takes their API keys along, and the team is told as when an admin removes someone', async () => {
  const password = 'correct horse battery';
  const owner = await signUp('Tia Lead', 'tia.lead@example.com');
  await join(owner, 'Sec Admin', 'sec.admin@example.com', 'admin');
  await join(owner, 'Plain Member', 'plain.member@example.com');
  const admins = ['tia.lead@example.com', 'sec.admin@example.com'];
  const keyMail = (to: string) => mailTo(to).filter((m) => /API keys? /.test(m.subject));
  const listed = async (name: string) => (await owner.get('/api-keys')).data.keys.find((k: any) => k.name === name);

  // Lea has a workspace of her own with a key in it, and is a member of Tia's team with another key.
  const lea = await signUp('Lea Ver', 'lea.ver@example.com');
  await newKey(lea, { name: 'Own script' });
  assert.equal((await owner.post('/account/invites', { email: 'lea.ver@example.com' })).status, 200);
  assert.equal((await lea.post('/invites/accept', { token: db.get("SELECT token FROM invites WHERE email='lea.ver@example.com'").token })).status, 200);
  const key = await newKey(lea, { name: 'Nightly sync' });
  assert.equal((await withKey(key).get('/envelopes')).status, 200);

  // Before she closes, she is shown which keys go off with her login, and which of them a team depends on.
  const preview = (await lea.get('/me/delete')).data;
  assert.deepEqual(preview.keys.map((k: any) => [k.name, k.account, k.team]), [['Own script', "Lea Ver's workspace", false], ['Nightly sync', "Tia Lead's workspace", true]]);
  assert.ok(!JSON.stringify(preview).includes(key), 'never the key itself');

  // She closes her login, with the usual days to change her mind. The team's integration stops at that moment.
  const closed = (await lea.post('/me/delete', { password })).data;
  assert.equal(closed.closed, 'scheduled');
  const until = dayText(closed.deletes_at);
  assert.equal((await withKey(key).get('/envelopes')).status, 403);
  // Every admin of the team is told which key, why, and until when it can come back. A plain member is not.
  for (const to of admins) {
    const m = keyMail(to).at(-1);
    assert.ok(m, `nobody told ${to} that a key of the team went off`);
    assert.equal(m.subject, "An API key of Tia Lead's workspace is switched off: Lea Ver is closing their login");
    assert.ok(m.html.includes('Nightly sync') && m.html.includes(`${key.slice(0, 10)}...`), 'the key is named, with the part of it an admin can see in the list');
    assert.ok(m.html.includes(until), 'and the day it stops for good');
    assert.ok(!m.html.includes('Own script'), 'a key of her own workspace is not the team\'s business');
    assert.ok(!m.html.includes(key), 'never the key itself');
  }
  assert.equal(keyMail('plain.member@example.com').length, 0);
  const own = mailTo('lea.ver@example.com').at(-1)!;
  assert.match(own.subject, /account is closing/);
  assert.ok(own.html.includes('Nightly sync') && own.html.includes('Own script'), 'her own email names every key that went off');
  assert.match(own.html, /admins of that team have been told/);
  // The admins' list says the same, so nobody has to remember the email.
  assert.deepEqual([(await listed('Nightly sync')).closing, (await listed('Nightly sync')).stopped_at], [closed.deletes_at, null]);

  // She signs in again in time: the key works again, and the admins hear that too.
  assert.equal((await lea.post('/auth/login', { email: 'lea.ver@example.com', password })).data.restored, true);
  assert.equal((await withKey(key).get('/envelopes')).status, 200);
  for (const to of admins) assert.equal(keyMail(to).at(-1)!.subject, "An API key of Tia Lead's workspace works again: Lea Ver kept their login");
  assert.equal((await listed('Nightly sync')).closing, null);

  // She closes again and the days run out. The key is not wiped from the team's list: it is stopped, it still says
  // whose it was, and what it answers is what happened, not "this key is not known here".
  await lea.post('/me/delete', { password });
  const short = (m: any) => m.subject.replace("An API key of Tia Lead's workspace ", '');
  assert.deepEqual(keyMail('tia.lead@example.com').map(short), ['is switched off: Lea Ver is closing their login', 'works again: Lea Ver kept their login', 'is switched off: Lea Ver is closing their login']);
  db.run("UPDATE users SET closing_at=? WHERE email='lea.ver@example.com'", new Date(Date.now() - 1000).toISOString());
  assert.ok((await cron.tick()).purged >= 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM users WHERE email='lea.ver@example.com'").n, 0);
  const gone = await withKey(key).get('/envelopes');
  assert.equal(gone.status, 401);
  assert.match(gone.data.error, /stopped working on \d{4}-\d\d-\d\d because the person who created it is no longer in the account/);
  const stopped = await listed('Nightly sync');
  assert.ok(stopped?.stopped_at, 'the key is still on the admins\' list, as stopped');
  assert.deepEqual([stopped.owner_name, stopped.closing], ['Lea Ver', null]);
  // Our copies of the earlier notices named her, so they went with her login. The one that says the keys have
  // stopped for good is written after that, and is what the admins are left with.
  assert.deepEqual(keyMail('tia.lead@example.com').map(short), ['stopped working: Lea Ver closed their login']);
  assert.ok(keyMail('sec.admin@example.com').at(-1)!.html.includes('Nightly sync'));
  assert.equal((await owner.call('DELETE', `/api-keys/${stopped.id}`)).status, 200, 'an admin can clear it from the list');

  // Deleting a login on the spot is the same, without the days in between.
  const ned = await join(owner, 'Ned Now', 'ned.now@example.com', 'admin');
  const nedKey = await newKey(ned, { name: 'Provisioning', scope: 'admin' });
  await newKey(ned, { name: 'Reports feed' });
  assert.equal((await ned.post('/me/delete', { password, now: true })).data.closed, 'now');
  const dead = await withKey(nedKey).get('/envelopes');
  assert.equal(dead.status, 401);
  assert.match(dead.data.error, /no longer in the account/);
  for (const to of admins) {
    const m = keyMail(to).at(-1)!;
    assert.equal(m.subject, "2 API keys of Tia Lead's workspace stopped working: Ned Now closed their login");
    assert.ok(m.html.includes('Provisioning') && m.html.includes('Reports feed') && !m.html.includes(nedKey));
  }
  assert.ok(mailTo('ned.now@example.com').at(-1)!.html.includes('Provisioning'), 'the person is told which keys went with the login');
  assert.deepEqual([(await listed('Provisioning')).owner_name, !!(await listed('Provisioning')).stopped_at, !!(await listed('Reports feed')).stopped_at], ['Ned Now', true, true]);

  // Told once: someone an admin removes while their login is closing is not announced a second time by the timer.
  const rem = await join(owner, 'Rem Oved', 'rem.oved@example.com');
  await newKey(rem, { name: 'Zap' });
  const remId = (await rem.get('/me')).data.user.id;
  await rem.post('/me/delete', { password });
  assert.deepEqual((await owner.call('DELETE', `/account/members/${remId}`)).data.keys_stopped.map((k: any) => k.name), ['Zap']);
  // (Our copies of emails that name Rem go when the login is purged, so this counts what is written after that.)
  const before = db.get('SELECT MAX(id) m FROM emails').m;
  db.run("UPDATE users SET closing_at=? WHERE email='rem.oved@example.com'", new Date(Date.now() - 1000).toISOString());
  assert.ok((await cron.tick()).purged >= 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='tia.lead@example.com' AND id > ?", before).n, 0);
  assert.equal((await listed('Zap')).owner_name, 'Rem Oved', 'the name stays on the stopped key after the login is gone');

  // And someone without keys closes their login without a word about keys to anybody.
  const quiet = await join(owner, 'No Keys', 'nokeys.closing@example.com');
  const sofar = db.get('SELECT MAX(id) m FROM emails').m;
  await quiet.post('/me/delete', { password });
  assert.equal(db.get("SELECT COUNT(*) n FROM emails WHERE to_email='tia.lead@example.com' AND id > ?", sofar).n, 0);
  assert.ok(!/API key/.test(mailTo('nokeys.closing@example.com').at(-1)!.html));
});

// ---- 3. Webhooks ---------------------------------------------------------------------------------------------

test('a webhook delivery is in the log from before the first try, and can be sent again after a restart', async () => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  const owner = await signUp('Hoo Kowner', 'hooks@example.com');
  const hook = await addHook(owner, `http://127.0.0.1:${port}/slow`);

  gate = new Promise<void>((r) => (release = r));
  const e = await fire(owner, 'hooks@example.com');
  await until(() => hits.some((h) => h.path === '/slow'), 'the first try to reach the endpoint');
  // Their server has the request and has not answered yet. If we stopped now, this is what would be left.
  const during = (await owner.get('/webhooks')).data.deliveries;
  assert.equal(during.length, 1, 'the delivery is already listed');
  assert.equal(during[0].state, 'pending');
  assert.equal(during[0].event, 'envelope.sent');
  assert.equal(during[0].envelope_id, e.id);
  assert.equal(during[0].can_redeliver, false);
  const early = await owner.post(`/webhooks/deliveries/${during[0].id}/redeliver`);
  assert.equal(early.status, 409);
  assert.match(early.data.error, /still being tried/);
  release();
  await until(() => deliveriesOf(hook.id).every((d) => d.done), 'the delivery to finish');
  const done = (await owner.get('/webhooks')).data.deliveries[0];
  assert.equal(done.id, during[0].id, 'one row per delivery, not a second one for the result');
  assert.deepEqual([done.state, done.status, done.attempts, done.can_redeliver], ['delivered', 200, 1, true]);

  // A row that was never finished because the server went down mid-delivery: shown as failed, and it can be sent again.
  storedRow(hook.id, 1, { done: 0, status: null, attempts: 1, at: new Date(Date.now() - 10 * 60_000).toISOString(), body: JSON.stringify({ id: 'evt_cut_short' }) });
  const cut = (await owner.get('/webhooks')).data.deliveries[0];
  assert.equal(cut.state, 'failed');
  assert.match(cut.error, /restarted before this delivery finished/);
  assert.equal(cut.can_redeliver, true);
  gate = Promise.resolve();
  assert.equal((await owner.post(`/webhooks/deliveries/${cut.id}/redeliver`)).status, 200);
  await until(() => hits.some((h) => h.body.includes('evt_cut_short')), 'the event to be sent again');
  await until(() => deliveriesOf(hook.id).filter((d) => d.done).length === 2, 'the redelivery to finish');
});

test('what can be sent again is counted per webhook, and the log has pages', async () => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  const mine = await signUp('Qui Et', 'quiet@example.com');
  const hook = await addHook(mine, `http://127.0.0.1:${port}/ok`);
  // My endpoint was down once.
  storedRow(hook.id, 0, { status: 500, attempts: 3, body: JSON.stringify({ id: 'evt_missed' }) });
  const missed = deliveriesOf(hook.id)[0].id;

  // Another customer is busy in the meantime.
  const busy = await signUp('Busy Tenant', 'busy@example.com');
  const theirs = await addHook(busy, `http://127.0.0.1:${port}/ok`);
  for (let i = 0; i < 250; i++) storedRow(theirs.id, i);
  const second = await addHook(busy, `http://127.0.0.1:${port}/ok?second`);
  for (let i = 0; i < 3; i++) storedRow(second.id, 1000 + i);

  // My next event arrives. My one missed delivery must still be there to send again.
  await fire(mine, 'quiet@example.com');
  await until(() => deliveriesOf(hook.id).length === 2 && deliveriesOf(hook.id).every((d) => d.done), 'my delivery');
  const row = (await mine.get('/webhooks')).data.deliveries.find((d: any) => d.id === missed);
  assert.equal(row.can_redeliver, true, 'other accounts do not wear out my log');
  assert.equal((await mine.post(`/webhooks/deliveries/${missed}/redeliver`)).status, 200);
  await until(() => hits.some((h) => h.body.includes('evt_missed')), 'the missed event to arrive');

  // Each webhook keeps the content of its own latest 200. Older rows stay listed and say why they cannot be resent.
  await fire(busy, 'busy@example.com');
  await until(() => deliveriesOf(theirs.id).length === 251 && deliveriesOf(theirs.id).every((d) => d.done), 'their delivery');
  const kept = deliveriesOf(theirs.id);
  assert.equal(kept.filter((d) => d.body).length, 200);
  assert.ok(kept.slice(0, 51).every((d) => !d.body) && kept.slice(51).every((d) => d.body), 'the newest 200 are the ones kept');
  assert.equal(deliveriesOf(second.id).filter((d) => d.body).length, 3 + 1, 'a quiet webhook of the same account loses nothing');
  const old = await busy.post(`/webhooks/deliveries/${kept[0].id}/redeliver`);
  assert.equal(old.status, 400);
  assert.match(old.data.error, /latest 200 deliveries of each webhook/);
  assert.equal((await mine.post(`/webhooks/deliveries/${kept[60].id}/redeliver`)).status, 404, 'never somebody else\'s delivery');

  // Paging: newest first, 30 at a time, all the way back.
  const ids: number[] = [];
  let before: number | null = null;
  let pages = 0;
  do {
    const page: any = (await busy.get(`/webhooks?webhook=${theirs.id}${before ? `&before=${before}` : ''}`)).data;
    assert.ok(page.deliveries.length <= 30);
    assert.ok(page.deliveries.every((d: any) => d.webhook_id === theirs.id));
    ids.push(...page.deliveries.map((d: any) => d.id));
    before = page.next_before;
    pages++;
  } while (before && pages < 50);
  assert.equal(ids.length, 251, 'every delivery can be reached');
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'newest first, nothing twice');
  assert.equal(new Set(ids).size, 251);
  const other = (await busy.get(`/webhooks?webhook=${second.id}`)).data;
  assert.equal(other.deliveries.length, 4);
  assert.equal(other.next_before, null);
  const everything = (await busy.get('/webhooks')).data;
  assert.equal(everything.deliveries.length, 30);
  assert.ok(everything.next_before);
  assert.equal((await mine.get(`/webhooks?webhook=${theirs.id}`)).data.deliveries.length, 0, 'the filter cannot reach into another account');
});

test('a webhook is sent to the address that was checked, with one answer for every address that is refused', async () => {
  const owner = await signUp('Pin Ned', 'pinned@example.com');

  // Public https only. A name that does not exist and a name that points inside get the same words.
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  names['inside.test'] = () => '10.0.0.5';
  names['metadata.test'] = () => '169.254.169.254';
  const answers = new Set<string>();
  for (const url of ['https://no-such-name.test/hook', 'https://inside.test/hook', 'https://metadata.test/hook', 'https://127.0.0.1/hook', 'https://[::1]/hook']) {
    const r = await owner.post('/webhooks', { url });
    assert.equal(r.status, 400, url);
    answers.add(r.data.error);
  }
  assert.equal(answers.size, 1, `one message, so the check tells nobody which names exist inside: ${[...answers].join(' | ')}`);
  assert.match([...answers][0], /cannot be used for a webhook.*https address on the public internet/);
  assert.equal((await owner.post('/webhooks', { url: 'http://93.184.216.34/hook' })).data.error, 'Webhook URLs must use https.');

  // A name that answers with a public address when it is checked and a private one afterwards.
  const { resolvePublic } = await import('../src/server/webhooks.ts');
  let asked = 0;
  names['flip.test'] = () => (asked++ === 0 ? '93.184.216.34' : '127.0.0.1');
  assert.equal((await owner.post('/webhooks', { url: 'https://flip.test/hook' })).status, 200, 'it looked public when it was added');
  await assert.rejects(resolvePublic('https://flip.test/hook'), /cannot be used for a webhook/, 'every delivery checks the address it is about to use');
  names['flip.test'] = () => '93.184.216.34';
  const target = await resolvePublic('https://flip.test/hook');
  assert.deepEqual(target.addresses, [{ address: '93.184.216.34', family: 4 }], 'and hands back only what it checked, to connect to');
  db.run("DELETE FROM webhooks WHERE url='https://flip.test/hook'");

  // The delivery connects to exactly the address the check returned. This name exists nowhere but in the answer
  // the check got, so the event can only arrive if no second lookup is made.
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  names['hooks.test'] = () => '127.0.0.1';
  const hook = await addHook(owner, `http://hooks.test:${port}/pinned`);
  lookups.length = 0;
  await fire(owner, 'pinned@example.com');
  await until(() => deliveriesOf(hook.id).length === 1 && deliveriesOf(hook.id)[0].done, 'the pinned delivery');
  const d = deliveriesOf(hook.id)[0];
  assert.deepEqual([d.status, d.error, d.attempts], [200, null, 1]);
  const hit = hits.find((h) => h.path === '/pinned')!;
  assert.equal(hit.host, `hooks.test:${port}`, 'their server still sees its own name');
  assert.equal(hit.event, 'envelope.sent');
  assert.deepEqual(lookups, ['hooks.test'], 'looked up once');

  // A reply that never ends is cut off. Only the status is kept.
  const flooded = await addHook(owner, `http://127.0.0.1:${port}/flood`);
  await fire(owner, 'pinned@example.com', 'Flood');
  await until(() => deliveriesOf(flooded.id).length === 1 && deliveriesOf(flooded.id)[0].done, 'the flooded delivery');
  assert.equal(deliveriesOf(flooded.id)[0].status, 200);
  await until(() => flood.closed, 'the connection to be closed on a reply that is too large', 3000);
  assert.ok(flood.bytes < 20 * 1024 * 1024, `read ${flood.bytes} bytes before giving up`);

  // An account cannot pile up webhooks without end.
  const many = await signUp('Man Y', 'many@example.com');
  for (let i = 0; i < 20; i++) assert.equal((await many.post('/webhooks', { url: `http://127.0.0.1:${port}/ok?${i}` })).status, 200);
  const over = await many.post('/webhooks', { url: `http://127.0.0.1:${port}/ok?21` });
  assert.equal(over.status, 400);
  assert.match(over.data.error, /up to 20 webhooks/);
});

test('a redirect is not followed, and the email about a failing webhook promises only what is kept', async () => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  const owner = await signUp('Red Irect', 'redirect@example.com');
  const hook = await addHook(owner, `http://127.0.0.1:${port}/redirect`);
  // Two failures are already on record. The third one is real.
  storedRow(hook.id, 1, { status: 500, attempts: 3 });
  storedRow(hook.id, 2, { status: 500, attempts: 3 });
  await fire(owner, 'redirect@example.com');
  await until(() => deliveriesOf(hook.id).length === 3 && deliveriesOf(hook.id).every((d) => d.done), 'three tries at the redirecting endpoint', 15_000);
  const d = (await owner.get('/webhooks')).data.deliveries[0];
  assert.deepEqual([d.state, d.status, d.attempts], ['failed', 302, 3]);
  assert.equal(hits.filter((h) => h.path === '/redirect').length, 3);
  assert.equal(hits.filter((h) => h.path === '/landed').length, 0, 'the signed event is not carried to wherever a redirect points');

  const mail = await until(() => mailTo('redirect@example.com').find((m) => /webhook keeps failing/.test(m.subject)), 'the email to the admin');
  assert.ok(!/Nothing is lost|every event is kept/.test(mail.html), 'no promise the log does not keep');
  assert.match(mail.html, /latest 200 events for this webhook are kept in full/);
  assert.match(mail.html, /Older events stay listed, but can no longer be sent again/);
});
