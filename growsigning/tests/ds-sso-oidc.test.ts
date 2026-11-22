// Single sign-on for an organisation (src/server/orgsso.ts, routes-orgsso.ts, oidc.ts), against a stand-in sign-in
// service made here: its keys (RSA and P-256), its discovery document, its key list and token endpoint answered by a
// fetch stub, and ID tokens signed (or forged) in the test. The DNS is a stub too. Nothing reaches the network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.FILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
import { boot, Client, signUp, mailTo } from './helpers.ts';
import { totp, fromBase32, stepAt } from '../src/server/twostep.ts';
import { ssoErrorText, SSO_ERRORS, cleanDomain, domainOf } from '../src/lib/orgsso.ts';
import { signInErrorText, signInNotice } from '../src/lib/signin.ts';
import { outsideServices, outsideStartLines } from '../src/lib/outside.ts';

const { db, cron } = await boot();
const { handle } = await import('../src/server/router.ts');
const orgsso = await import('../src/server/orgsso.ts');
const paydns = await import('../src/server/paydns.ts');
const oidc = await import('../src/server/oidc.ts');
const PW = 'correct horse battery';

// ---- The stand-in sign-in service ----------------------------------------------------------------------------------

const ISS = 'https://login.acme.test';
const CLIENT = { id: 'growsigning-at-acme', secret: 'acme-secret-value' };
type Pair = { kid: string; alg: 'RS256' | 'ES256'; key: crypto.KeyObject; pub: crypto.KeyObject };
const rsa = (kid: string): Pair => {
  const k = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, alg: 'RS256', key: k.privateKey, pub: k.publicKey };
};
const ec = (kid: string): Pair => {
  const k = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, alg: 'ES256', key: k.privateKey, pub: k.publicKey };
};
const b64 = (v: any) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const signJwt = (claims: any, pair: Pair, header: any = {}) => {
  const head = b64({ alg: pair.alg, typ: 'JWT', kid: pair.kid, ...header });
  const body = b64(claims);
  const data = Buffer.from(`${head}.${body}`);
  const sig = pair.alg === 'ES256' ? crypto.sign('sha256', data, { key: pair.key, dsaEncoding: 'ieee-p1363' }) : crypto.sign('RSA-SHA256', data, pair.key);
  return `${head}.${body}.${sig.toString('base64url')}`;
};
const idp = {
  published: [rsa('acme-1')] as Pair[],
  docIssuer: ISS,
  docExtra: {} as Record<string, any>,
  keyFetches: 0,
  discoveries: 0,
  codes: new Map<string, { challenge: string; redirect_uri: string; token: string }>(),
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = new URL(String(url));
  if (u.host !== 'login.acme.test' && u.host !== 'other.acme.test') return realFetch(url, init);
  const json = (out: any, status = 200) => new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  const base = `https://${u.host}`;
  if (u.pathname === '/.well-known/openid-configuration') {
    idp.discoveries++;
    return json({ issuer: u.host === 'login.acme.test' ? idp.docIssuer : 'https://somebody.else.test', authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`,
      code_challenge_methods_supported: ['S256'], id_token_signing_alg_values_supported: ['RS256', 'ES256'], ...idp.docExtra });
  }
  if (u.pathname === '/jwks') {
    idp.keyFetches++;
    return json({ keys: idp.published.map((p) => ({ ...p.pub.export({ format: 'jwk' }), kid: p.kid, use: 'sig', alg: p.alg })) });
  }
  if (init.method === 'POST' && u.pathname === '/token') {
    const p = Object.fromEntries(new URLSearchParams(String(init.body)));
    const c = idp.codes.get(p.code);
    idp.codes.delete(p.code);
    if (!c || p.client_id !== CLIENT.id || p.client_secret !== CLIENT.secret || p.redirect_uri !== c.redirect_uri || crypto.createHash('sha256').update(p.code_verifier || '').digest('base64url') !== c.challenge)
      return json({ error: 'invalid_grant' }, 400);
    return json({ access_token: 'unused', token_type: 'Bearer', id_token: c.token });
  }
  return json({ error: 'not_found' }, 404);
}) as any;
// Names lead to public addresses, except one that leads inside a private network.
const realLookup = paydns.resolver.lookup;
paydns.resolver.lookup = async (host: string) => (host.startsWith('internal.') ? [{ address: '10.0.0.7', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
// The DNS: TXT records the test puts there.
const realTxt = orgsso.txt.lookup;
const dnsTxt = new Map<string, string[][]>();
let dnsDown = false;
orgsso.txt.lookup = async (name: string) => {
  if (dnsDown) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
  const r = dnsTxt.get(name);
  if (!r) throw Object.assign(new Error('nothing'), { code: 'ENOTFOUND' });
  return r;
};
after(() => {
  globalThis.fetch = realFetch;
  paydns.resolver.lookup = realLookup;
  orgsso.txt.lookup = realTxt;
});

const claimsFor = (auth: URL, person: Record<string, any>) => {
  const t = Math.floor(Date.now() / 1000);
  return { iss: ISS, aud: auth.searchParams.get('client_id'), nonce: auth.searchParams.get('nonce'), iat: t, exp: t + 600, email_verified: true, ...person };
};
type Forge = (claims: any) => string;
function approve(location: string, person: Record<string, any>, forge?: Forge): string {
  const auth = new URL(location);
  const claims = claimsFor(auth, person);
  const code = `code-${crypto.randomBytes(8).toString('hex')}`;
  idp.codes.set(code, { challenge: auth.searchParams.get('code_challenge')!, redirect_uri: auth.searchParams.get('redirect_uri')!, token: forge ? forge(claims) : signJwt(claims, idp.published[0]) });
  return code;
}

let n = 0;
const browser = () => {
  const c = new Client();
  c.ip = `198.18.${Math.floor(n / 250) + 40}.${(n++ % 250) + 1}`;
  return c;
};
async function go(c: Client, url: string) {
  const res = await handle(new Request(`http://test.local/api${url}`, { headers: { cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': c.ip } }));
  for (const ck of res.headers.getSetCookie()) {
    const [kv] = ck.split(';');
    c.cookies[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  }
  return { status: res.status, location: res.headers.get('location') || '', data: (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
}
/** The whole way through "Continue with ... sign-in": start, the service, the callback. */
async function ssoSignIn(c: Client, email: string, person: Record<string, any>, forge?: Forge) {
  const start = await go(c, `/sso/start?${new URLSearchParams({ email })}`);
  assert.equal(start.status, 302);
  if (!start.location.startsWith(ISS)) return { ...start, to: new URL(start.location) };
  const auth = new URL(start.location);
  const code = approve(start.location, { email, ...person }, forge);
  const back = await go(c, `/sso/callback?${new URLSearchParams({ code, state: auth.searchParams.get('state')! })}`);
  return { ...back, auth, to: new URL(back.location) };
}
const landed = (r: any) => assert.equal(r.to.pathname, '/signin/done', `${r.location}`);
const refusedWith = (r: any, code: string) => assert.equal(r.to.searchParams.get('sso_error'), code, r.location);
const lines = (accountId: string, kind: string) => db.all('SELECT * FROM security_events WHERE account_id=? AND kind=? ORDER BY seq', accountId, kind);

const used = new Map<string, number>();
let skew = 0;
const realNow = Date.now;
Date.now = () => realNow() + skew;
after(() => void (Date.now = realNow));
function code(secret: string) {
  const last = used.get(secret);
  if (last !== undefined && last >= stepAt()) skew += (last - stepAt() + 1) * 30_000;
  used.set(secret, stepAt());
  return totp(fromBase32(secret));
}
async function twoStepOn(c: Client) {
  const s = await c.post('/me/two-step/setup', { password: PW });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const r = await c.post('/me/two-step/confirm', { code: code(s.data.secret) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return s.data.secret as string;
}

// ---- The organisation ---------------------------------------------------------------------------------------------

const owner = await signUp('Olive Owner', 'olive@acme.test', '198.18.1.1');
const ownerId = db.get("SELECT id FROM users WHERE email='olive@acme.test'").id;
const account = db.get("SELECT account_id a FROM memberships WHERE user_id=? AND role='owner'", ownerId).a;
const save = (c: Client, b: any) => c.put('/account/sso', b);
const setup = { name: 'Acme', issuer: ISS, client_id: CLIENT.id, client_secret: CLIENT.secret };

test('words: every refusal and every error is two sentences, the second starting with a verb, and has no em dash', async () => {
  for (const k of SSO_ERRORS) {
    const s = ssoErrorText(k, 'Acme');
    assert.ok(s && !s.includes('—'), k);
    const parts = s.split(/(?<=\.)\s+/);
    assert.ok(parts.length >= 2, `${k}: ${s}`);
    assert.match(parts[1], /^(Try|Press|Start|Ask|Wait|Sign)\b/, `${k}: ${s}`);
  }
  assert.match(ssoErrorText('nonsense'), /your organisation's sign-in/, 'an unknown code is the general failure, never the code');
  assert.match(signInErrorText('org_sso', 'google'), /Google is not used for this address\. Type your work email/);
  assert.equal(cleanDomain(' Acme.TEST. '), 'acme.test');
  assert.equal(cleanDomain('@acme.test'), 'acme.test');
  assert.equal(cleanDomain('https://www.acme.test/path'), 'www.acme.test');
  for (const bad of ['', 'acme', '10.0.0.1', 'a b.test', 'acme..test', '-acme.test']) assert.equal(cleanDomain(bad), null, bad);
  assert.equal(domainOf('Pat@Acme.Test'), 'acme.test');
});

test('nothing exists until it is set up: no card without FILE_ENCRYPTION_KEY, the sign-in page unchanged, a key cannot touch it', async () => {
  const key = process.env.FILE_ENCRYPTION_KEY;
  delete process.env.FILE_ENCRYPTION_KEY;
  try {
    assert.deepEqual((await owner.get('/account/sso')).data, { available: false });
    const r = await save(owner, setup);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /cannot keep a client secret safely.*FILE_ENCRYPTION_KEY/);
  } finally {
    process.env.FILE_ENCRYPTION_KEY = key;
  }
  const card = (await owner.get('/account/sso')).data;
  assert.equal(card.available, true);
  assert.deepEqual(card.domains, []);
  assert.equal(card.service, null);
  assert.equal(card.redirect_uri, 'http://test.local/api/sso/callback');
  assert.deepEqual((await browser().get('/sso/lookup?email=pat@acme.test')).data, { sso: null });
  // An API key, even an admin one, never changes single sign-on.
  const k = await owner.post('/api-keys', { name: 'admin key', scope: 'admin' });
  assert.equal(k.status, 200, JSON.stringify(k.data));
  const viaKey = await owner.call('PUT', '/account/sso', setup, { authorization: `Bearer ${k.data.key}`, cookie: '' });
  assert.equal(viaKey.status, 403);
  // A member is not an admin.
  const member = await signUp('Mo Member', 'mo@elsewhere.test', '198.18.1.2');
  assert.equal((await member.get('/account/sso')).status, 200, 'their own workspace');
});

test('the issuer: https only, a public host, a discovery document that names the same issuer, PKCE and RS256 or ES256', async () => {
  const bad = async (b: any, re: RegExp) => {
    const r = await save(owner, { ...setup, ...b });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, re);
    assert.doesNotMatch(r.data.error, /—/);
  };
  await bad({ issuer: 'http://login.acme.test' }, /not an https address/);
  await bad({ issuer: 'https://user:pw@login.acme.test' }, /not an https address/);
  await bad({ issuer: 'https://internal.acme.test' }, /internal\.acme\.test leads to 10\.0\.0\.7, which is inside a private network, so the issuer cannot be used and nothing was saved\. Use/);
  await bad({ issuer: 'https://other.acme.test' }, /names a different issuer/);
  idp.docExtra = { code_challenge_methods_supported: ['plain'] };
  await bad({}, /PKCE with S256/);
  idp.docExtra = { id_token_signing_alg_values_supported: ['HS256'] };
  await bad({}, /RS256 or ES256/);
  idp.docExtra = { jwks_uri: 'http://login.acme.test/jwks' };
  await bad({}, /not https/);
  idp.docExtra = {};
  await bad({ name: '' }, /That name cannot be used/);
  await bad({ client_id: 'has space' }, /client id cannot be used/);
  await bad({ client_secret: '' }, /client secret is needed/);
  const ok = await save(owner, setup);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.service.tested_at, null);
  // The secret is kept encrypted, never in the clear, and never sent back.
  const row = db.get('SELECT * FROM org_idps WHERE account_id=?', account);
  assert.ok(!row.secret_sealed.includes(CLIENT.secret) && !Buffer.from(row.secret_sealed, 'base64').toString('latin1').includes(CLIENT.secret));
  assert.ok(!JSON.stringify((await owner.get('/account/sso')).data).includes(CLIENT.secret));
  assert.ok(!JSON.stringify(db.all('SELECT details FROM security_events WHERE account_id=?', account)).includes(CLIENT.secret));
  assert.equal(lines(account, 'sso.changed').length, 1);
});

let domainId = '';
test('a domain is claimed with a TXT record, belongs to one account, and a DNS that does not answer proves nothing', async () => {
  const add = await owner.post('/account/sso/domains', { domain: 'Acme.test' });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  const d = add.data.domain;
  domainId = d.id;
  assert.equal(d.state, 'waiting');
  assert.equal(d.record.name, '_growsigning.acme.test');
  assert.match(d.record.value, /^growsigning-domain=[A-Za-z0-9_-]{20,}$/);
  // Not there yet.
  let r = await owner.post(`/account/sso/domains/${d.id}/check`);
  assert.equal(r.data.found, 'missing');
  assert.equal(r.data.domain.state, 'waiting');
  // Somebody else's value does not count.
  dnsTxt.set('_growsigning.acme.test', [['growsigning-domain=somebody-else']]);
  assert.equal((await owner.post(`/account/sso/domains/${d.id}/check`)).data.found, 'missing');
  // A DNS that does not answer.
  dnsDown = true;
  assert.equal((await owner.post(`/account/sso/domains/${d.id}/check`)).data.found, 'unknown');
  dnsDown = false;
  // In two pieces, as a long TXT record comes.
  const v = d.record.value as string;
  dnsTxt.set('_growsigning.acme.test', [['v=spf1 -all'], [v.slice(0, 10), v.slice(10)]]);
  r = await owner.post(`/account/sso/domains/${d.id}/check`);
  assert.equal(r.data.found, 'found');
  assert.equal(r.data.domain.state, 'claimed');
  assert.equal(lines(account, 'sso.domain_claimed').length, 1);
  // Another account cannot claim it while the record stands.
  const rival = await signUp('Rex Rival', 'rex@rival.test', '198.18.1.3');
  const taken = await rival.post('/account/sso/domains', { domain: 'acme.test' });
  assert.equal(taken.status, 409);
  assert.match(taken.data.error, /claimed by another GrowSigning account, so it was not added\. Ask/);
  assert.doesNotMatch(taken.data.error, /Olive|workspace/, 'the other account is not named');
  // Garbage in, plain words out.
  assert.equal((await owner.post('/account/sso/domains', { domain: 'not a domain' })).status, 400);
});

test('nothing changes for anyone until an admin tried a sign-in through the service once', async () => {
  assert.deepEqual((await browser().get('/sso/lookup?email=pat@acme.test')).data, { sso: null });
  const r = await ssoSignIn(browser(), 'pat@acme.test', { sub: 'pat-1' });
  refusedWith(r, 'off');
  // The admin tries it.
  const t = await owner.post('/account/sso/try');
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const auth = new URL(t.data.url);
  assert.equal(auth.origin + auth.pathname, `${ISS}/authorize`);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), 'http://test.local/api/sso/callback');
  assert.equal(auth.searchParams.get('login_hint'), 'olive@acme.test');
  assert.ok(auth.searchParams.get('nonce') && auth.searchParams.get('state'));
  const back = await go(owner, `/sso/callback?${new URLSearchParams({ code: approve(t.data.url, { sub: 'olive-1', email: 'olive@acme.test' }), state: auth.searchParams.get('state')! })}`);
  assert.equal(back.status, 302);
  assert.equal(new URL(back.location).searchParams.get('sso'), 'tried', back.location);
  assert.ok(db.get('SELECT tested_at FROM org_idps WHERE account_id=?', account).tested_at);
  assert.equal(lines(account, 'sso.tested').length, 1);
  assert.deepEqual((await browser().get('/sso/lookup?email=Pat@ACME.test')).data, { sso: { name: 'Acme', password: 'allowed' } });
  assert.deepEqual((await browser().get('/sso/lookup?email=pat@acme.test.evil')).data, { sso: null }, 'exactly the domain');
  assert.deepEqual((await browser().get('/sso/lookup?email=pat@sub.acme.test')).data, { sso: null }, 'a sub-domain is not covered');
});

test('the ID token: a good one signs in; wrong issuer, audience, expired, nonce, unknown key, forged signature, "none" and HS256 do not', async () => {
  const good = await ssoSignIn(browser(), 'pat@acme.test', { sub: 'pat-1', name: 'Pat Example' });
  landed(good);
  const pat = db.get("SELECT * FROM users WHERE email='pat@acme.test'");
  assert.equal(pat.name, 'Pat Example');
  assert.equal(pat.email_verified, 1);
  assert.equal(db.get('SELECT subject FROM identities WHERE user_id=?', pat.id).subject, `${ISS} pat-1`);
  const forged: [string, Forge][] = [
    ['wrong issuer', (c) => signJwt({ ...c, iss: 'https://login.acme.test/' }, idp.published[0])],
    ['wrong audience', (c) => signJwt({ ...c, aud: 'someone-else' }, idp.published[0])],
    ['expired', (c) => signJwt({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 }, idp.published[0])],
    ['no iat', (c) => signJwt({ ...c, iat: undefined }, idp.published[0])],
    ['bad nonce', (c) => signJwt({ ...c, nonce: 'another' }, idp.published[0])],
    ['unknown key', (c) => signJwt(c, rsa('acme-unknown'))],
    ['forged signature', (c) => signJwt(c, { ...rsa('x'), kid: 'acme-1' })],
    ['alg none', (c) => `${b64({ alg: 'none', kid: 'acme-1' })}.${b64(c)}.`],
    ['HS256 with the public key', (c) => {
      const head = b64({ alg: 'HS256', kid: 'acme-1' });
      const body = b64(c);
      const pem = idp.published[0].pub.export({ type: 'spki', format: 'pem' });
      return `${head}.${body}.${crypto.createHmac('sha256', pem).update(`${head}.${body}`).digest('base64url')}`;
    }],
  ];
  for (const [what, forge] of forged) {
    const r = await ssoSignIn(browser(), 'pat@acme.test', { sub: 'pat-1' }, forge);
    refusedWith(r, 'failed');
    assert.equal(r.to.pathname, '/login', what);
  }
  // A state used twice, or in another browser, does nothing.
  const c = browser();
  const start = await go(c, `/sso/start?email=pat@acme.test`);
  const auth = new URL(start.location);
  const code1 = approve(start.location, { sub: 'pat-1', email: 'pat@acme.test' });
  const other = await go(browser(), `/sso/callback?${new URLSearchParams({ code: code1, state: auth.searchParams.get('state')! })}`);
  assert.equal(new URL(other.location).searchParams.get('sso_error'), 'expired');
});

test('a rotated key is fetched again; ES256 works for an organisation\'s service', async () => {
  idp.keyFetches = 0;
  idp.published = [rsa('acme-2'), ...idp.published];
  landed(await ssoSignIn(browser(), 'pat@acme.test', { sub: 'pat-1' }));
  assert.equal(idp.keyFetches, 1, 'one more look at the list for the new key');
  idp.published = [ec('acme-ec'), ...idp.published];
  landed(await ssoSignIn(browser(), 'pat@acme.test', { sub: 'pat-1' }));
  // An ES256 signature in DER, not side by side, is refused.
  const der: Forge = (c) => {
    const head = b64({ alg: 'ES256', kid: 'acme-ec' });
    const body = b64(c);
    return `${head}.${body}.${crypto.sign('sha256', Buffer.from(`${head}.${body}`), idp.published[0].key).toString('base64url')}`;
  };
  refusedWith(await ssoSignIn(browser(), 'pat@acme.test', { sub: 'pat-1' }, der), 'failed');
  idp.published = idp.published.slice(1);
});

test('an address outside the claimed domains, or one the service says is unconfirmed, is not signed in', async () => {
  const r = await ssoSignIn(browser(), 'pat@acme.test', { sub: 'stranger', email: 'stranger@gmail.test' });
  refusedWith(r, 'domain');
  refusedWith(await ssoSignIn(browser(), 'pat@acme.test', { sub: 'pat-9', email: 'pat9@acme.test', email_verified: false }), 'no_email');
  assert.ok(!db.get("SELECT 1 x FROM users WHERE email='stranger@gmail.test'"));
});

test('an existing login at the domain is connected, its owner emailed; a second person of the service for it is refused', async () => {
  const sam = await signUp('Sam Already', 'sam@acme.test', '198.18.1.4');
  void sam;
  landed(await ssoSignIn(browser(), 'sam@acme.test', { sub: 'sam-1' }));
  const samId = db.get("SELECT id FROM users WHERE email='sam@acme.test'").id;
  assert.equal(db.all('SELECT * FROM identities WHERE user_id=?', samId).length, 1);
  assert.ok(mailTo('sam@acme.test').some((m: any) => /Acme sign-in can now open your GrowSigning login/.test(m.subject)));
  refusedWith(await ssoSignIn(browser(), 'sam@acme.test', { sub: 'sam-impostor' }), 'taken');
});

test('joining on first sign-in is off by default, and adds people as members when switched on', async () => {
  const pat = db.get("SELECT id FROM users WHERE email='pat@acme.test'").id;
  assert.ok(!db.get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', account, pat), 'off: a workspace of their own');
  const on = await owner.call('PATCH', '/account/sso/rules', { join_new: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  landed(await ssoSignIn(browser(), 'nia@acme.test', { sub: 'nia-1', name: 'Nia New' }));
  const nia = db.get("SELECT id FROM users WHERE email='nia@acme.test'").id;
  assert.equal(db.get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', account, nia).role, 'member');
  assert.equal(db.all('SELECT * FROM memberships WHERE user_id=?', nia).length, 1, 'no extra workspace');
  // Someone who had a login before joins the next time they come through the service.
  landed(await ssoSignIn(browser(), 'pat@acme.test', { sub: 'pat-1' }));
  assert.equal(db.get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', account, pat).role, 'member');
  assert.ok(lines(account, 'member.joined').length >= 2);
});

let ownerSecret = '';
test('"everyone signs in through it": only after a try, with a claimed domain, and with the owner\'s two-step login', async () => {
  let r = await owner.call('PATCH', '/account/sso/rules', { enforce: true });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Your way back in.*two-step login.*nothing was switched on\. Switch two-step login on/);
  ownerSecret = await twoStepOn(owner);
  r = await owner.call('PATCH', '/account/sso/rules', { enforce: true });
  assert.equal(r.status, 403, 'the code is asked for');
  r = await owner.call('PATCH', '/account/sso/rules', { enforce: true, code: code(ownerSecret) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.service.enforce, true);
  assert.deepEqual((await browser().get('/sso/lookup?email=pat@acme.test')).data, { sso: { name: 'Acme', password: 'owner_only' } });
  // Changing the issuer or client id while it is on is refused: it would need a new try.
  const ch = await save(owner, { client_id: 'another', code: code(ownerSecret) });
  assert.equal(ch.status, 409);
  assert.match(ch.data.error, /Switch that off first/);
  const line = lines(account, 'sso.changed').at(-1);
  assert.match(line.details, /everyone_signs_in_through_it/);
});

test('enforced: password, sign-up, Google and Microsoft are refused with the reason; browsers end within SSO_SESSION_HOURS', async () => {
  const sam = browser();
  let r = await sam.post('/auth/login', { email: 'sam@acme.test', password: PW });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'sso_required');
  assert.match(r.data.error, /^Acme signs everyone at acme\.test in through its own sign-in service, so a password does not open this login\. Press "Continue with Acme sign-in"/);
  // The way back is the owner's only: a member who asks for it gets the same answer once the password is checked.
  r = await sam.post('/auth/login', { email: 'sam@acme.test', password: PW, way_back: true });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'sso_required');
  r = await browser().post('/auth/signup', { name: 'New', email: 'newbie@acme.test', password: PW });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /no login with a password is made for this address\. Press/);
  // "Forgot password" says how to sign in instead of sending a link that leads nowhere.
  await browser().post('/auth/forgot', { email: 'sam@acme.test' });
  assert.match(mailTo('sam@acme.test').at(-1).subject, /Sign in to GrowSigning with Acme sign-in/);
  // A browser made now through the service ends within the hours.
  const c = browser();
  landed(await ssoSignIn(c, 'sam@acme.test', { sub: 'sam-1' }));
  const s = db.get("SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='sam@acme.test' ORDER BY s.created_at DESC LIMIT 1");
  const hours = (Date.parse(s.ends_by) - Date.now()) / 3600_000;
  assert.ok(hours > 11 && hours <= 12.01, String(hours));
  assert.equal((await c.get('/me')).status, 200);
  // Past it, the browser is signed out, whatever it was given.
  db.run('UPDATE sessions SET ends_by=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), s.id);
  assert.ok(!(await c.get('/me')).data.user);
  // Browsers signed in before the rule was switched on were given the same end then.
  const older = db.all("SELECT s.ends_by FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='pat@acme.test'");
  assert.ok(older.length && older.every((x: any) => x.ends_by), 'every browser of pat has an end');
});

test('enforced: Google is refused for an address at the domain, whether the login exists or not', async () => {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'gs.apps.google.test', GOOGLE_CLIENT_SECRET: 'google-secret' });
  const gkey = rsa('g-1');
  const tokens = new Map<string, string>();
  const before = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    const json = (out: any, status = 200) => new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'www.googleapis.com') return json({ keys: [{ ...gkey.pub.export({ format: 'jwk' }), kid: gkey.kid, use: 'sig', alg: 'RS256' }] });
    if (u.host === 'oauth2.googleapis.com') return json({ id_token: tokens.get(Object.fromEntries(new URLSearchParams(String(init.body))).code) });
    return before(url, init);
  }) as any;
  try {
    for (const email of ['sam@acme.test', 'brand.new@acme.test']) {
      const c = browser();
      const start = await go(c, '/auth/google/start');
      const auth = new URL(start.location);
      const t = Math.floor(Date.now() / 1000);
      const codeG = `g-${crypto.randomBytes(6).toString('hex')}`;
      tokens.set(codeG, signJwt({ iss: 'https://accounts.google.com', aud: 'gs.apps.google.test', azp: 'gs.apps.google.test', nonce: auth.searchParams.get('nonce'), iat: t, exp: t + 600, sub: `g-${email}`, email, email_verified: true, hd: 'acme.test' }, gkey));
      const back = await go(c, `/auth/google/callback?${new URLSearchParams({ code: codeG, state: auth.searchParams.get('state')! })}`);
      assert.equal(new URL(back.location).searchParams.get('signin_error'), 'org_sso', back.location);
      assert.ok(!c.cookies.ts_session, email);
    }
    assert.ok(!db.get("SELECT 1 x FROM users WHERE email='brand.new@acme.test'"));
  } finally {
    globalThis.fetch = before;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  }
  assert.match(signInErrorText('org_sso', 'microsoft'), /Microsoft is not used/);
  assert.equal(orgsso.enforcedFor('sam@other.test'), null);
});

test('the owner\'s way back in: password and two-step code, written to the security record each time', async () => {
  const c = browser();
  let r = await c.post('/auth/login', { email: 'olive@acme.test', password: PW });
  assert.equal(r.status, 403, 'without asking for the way back, the owner is sent to the service too');
  r = await c.post('/auth/login', { email: 'olive@acme.test', password: PW, way_back: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.two_step, true);
  const before = lines(account, 'sso.way_back').length;
  assert.equal(before, 1, 'written once the password was right');
  const done = await c.post('/auth/two-step', { code: code(ownerSecret) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal((await c.get('/me')).data.user.email, 'olive@acme.test');
  // A wrong password writes nothing, and answers as it always does with two-step login on (the second screen, so a
  // password cannot be found out by trying it).
  r = await browser().post('/auth/login', { email: 'olive@acme.test', password: 'wrong', way_back: true });
  assert.equal(r.data.two_step, true);
  assert.equal(lines(account, 'sso.way_back').length, 1);
  // Owner without two-step: refused with what to do.
  const ownerRow = db.get("SELECT * FROM users WHERE email='olive@acme.test'");
  db.run('UPDATE users SET two_step_on_at=NULL WHERE id=?', ownerRow.id);
  r = await browser().post('/auth/login', { email: 'olive@acme.test', password: PW, way_back: true });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /only while two-step login is on, so you are not signed in\. Sign in with "Continue with Acme sign-in"/);
  db.run('UPDATE users SET two_step_on_at=? WHERE id=?', ownerRow.two_step_on_at, ownerRow.id);
});

test('a lost DNS record pauses single sign-on for the domain, is said to the admins, and comes back by itself', async () => {
  dnsTxt.delete('_growsigning.acme.test');
  db.run('UPDATE org_domains SET checked_at=? WHERE id=?', new Date(Date.now() - 25 * 3600_000).toISOString(), domainId);
  assert.equal(await orgsso.recheckDomains(), 1);
  const d = db.get('SELECT * FROM org_domains WHERE id=?', domainId);
  assert.ok(d.lost_at);
  assert.equal(lines(account, 'sso.domain_lost').length, 1);
  assert.ok(mailTo('olive@acme.test').some((m: any) => /Single sign-on paused for acme\.test/.test(m.subject)));
  // Paused: the usual sign-in works again, and the page no longer offers the service.
  assert.deepEqual((await browser().get('/sso/lookup?email=sam@acme.test')).data, { sso: null });
  const r = await browser().post('/auth/login', { email: 'sam@acme.test', password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // The card says it.
  assert.equal((await owner.get('/account/sso')).data.domains[0].state, 'lost');
  // Checked again within the day: nothing new is written.
  assert.equal(await orgsso.recheckDomains(), 0);
  // The record is back.
  dnsTxt.set('_growsigning.acme.test', [[`growsigning-domain=${d.value}`]]);
  db.run('UPDATE org_domains SET checked_at=? WHERE id=?', new Date(Date.now() - 25 * 3600_000).toISOString(), domainId);
  await cron.tick();
  assert.equal(db.get('SELECT lost_at FROM org_domains WHERE id=?', domainId).lost_at, null);
  assert.ok(orgsso.enforcedFor('sam@acme.test'));
});

test('a domain whose record went can be claimed by the account whose record is there now', async () => {
  const rival = await signUp('Rae Rival', 'rae@rival2.test', '198.18.1.5');
  dnsTxt.delete('_growsigning.acme.test');
  db.run('UPDATE org_domains SET checked_at=? WHERE id=?', new Date(Date.now() - 25 * 3600_000).toISOString(), domainId);
  await orgsso.recheckDomains();
  const add = await rival.post('/account/sso/domains', { domain: 'acme.test' });
  assert.equal(add.status, 200, 'the old claim is lost, so a new one may be started');
  dnsTxt.set('_growsigning.acme.test', [[add.data.domain.record.value]]);
  const r = await rival.post(`/account/sso/domains/${add.data.domain.id}/check`);
  assert.equal(r.data.domain.state, 'claimed');
  assert.ok(!db.get('SELECT * FROM org_domains WHERE id=?', domainId), 'the first account no longer has it');
  assert.equal(lines(account, 'sso.domain_removed').length, 1);
  assert.equal(orgsso.ssoFor('sam@acme.test'), null, 'the rival has no service: nothing is enforced');
});

test('removing single sign-on is recorded, and every kind it writes has words', async () => {
  const r = await owner.call('DELETE', '/account/sso', { code: code(ownerSecret) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(lines(account, 'sso.removed').length, 1);
  const { securityKindWords, SECURITY_GROUPS } = await import('../src/lib/seclog.ts');
  for (const k of ['sso.domain_added', 'sso.domain_claimed', 'sso.domain_lost', 'sso.domain_removed', 'sso.changed', 'sso.removed', 'sso.tested', 'sso.way_back']) {
    assert.notEqual(securityKindWords(k), k);
    assert.ok(SECURITY_GROUPS.some(([, kinds]) => (kinds as string[]).includes(k)), k);
  }
  void oidc;
});

// ---- After the review (tests/out/verify-ds-sso-oidc, tests/out/ux-ds-sso-oidc): the attacks and the dead ends -------
// A second organisation, Beta, on the same stand-in service.

const bea = await signUp('Bea Boss', 'bea@beta.test', '198.18.2.1');
const beaId = db.get("SELECT id FROM users WHERE email='bea@beta.test'").id;
const beta = db.get("SELECT account_id a FROM memberships WHERE user_id=? AND role='owner'", beaId).a;
await signUp('Ben Member', 'ben@beta.test', '198.18.2.2');
const benId = db.get("SELECT id FROM users WHERE email='ben@beta.test'").id;
let beaSecret = '';
let betaDomain = '';
const hostProblem = (host: string) => (e: any) => e instanceof oidc.DiscoveryProblem && e.why === 'host' && e.host === host;
async function tryAs(c: Client, sub: string, email: string) {
  const t = await c.post('/account/sso/try');
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const back = await go(c, `/sso/callback?${new URLSearchParams({ code: approve(t.data.url, { sub, email }), state: new URL(t.data.url).searchParams.get('state')! })}`);
  assert.equal(new URL(back.location).searchParams.get('sso'), 'tried', back.location);
}

test('review: issuer refusals speak of the sign-in service, never of payments or signers', () => {
  for (const check of [{ ok: false, why: 'none' }, { ok: false, why: 'private', address: '10.0.0.7' }, { ok: false, why: 'later', closed: true }, { ok: false, why: 'later' }]) {
    const s = orgsso.issuerProblemWords(new oidc.DiscoveryProblem('host', 'x', { host: 'login.x.test', check }));
    assert.match(s, /login\.x\.test/);
    assert.doesNotMatch(s, /payment|signer|—/i);
    assert.match(s, /nothing was saved\. (Check|Use|Ask|Try) /, s);
  }
});

test('review: a discovery document fetched again, or a name that moved, cannot lead the sign-in to a private host', async () => {
  assert.equal((await save(bea, setup)).status, 200);
  const add = await bea.post('/account/sso/domains', { domain: 'beta.test' });
  betaDomain = add.data.domain.id;
  dnsTxt.set('_growsigning.beta.test', [[add.data.domain.record.value]]);
  assert.equal((await bea.post(`/account/sso/domains/${betaDomain}/check`)).data.domain.state, 'claimed');
  await tryAs(bea, 'bea-1', 'bea@beta.test');
  assert.ok(await orgsso.providerOf(beta));
  // An hour later the document names a host inside a private network for its token endpoint.
  const seen: string[] = [];
  const before = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push(String(url));
    return before(url, init);
  }) as any;
  idp.docExtra = { token_endpoint: 'https://internal.acme.test/token' };
  oidc.forgetDiscovery(ISS);
  try {
    await assert.rejects(orgsso.providerOf(beta), hostProblem('internal.acme.test'));
    refusedWith(await ssoSignIn(browser(), 'ben@beta.test', { sub: 'ben-1' }), 'off');
    const t = await bea.post('/account/sso/try');
    assert.equal(t.status, 400);
    assert.match(t.data.error, /internal\.acme\.test leads to 10\.0\.0\.7, which is inside a private network/);
    idp.docExtra = { jwks_uri: 'https://internal.acme.test/jwks' };
    oidc.forgetDiscovery(ISS);
    await assert.rejects(orgsso.providerOf(beta), hostProblem('internal.acme.test'));
    assert.ok(!seen.some((u) => u.includes('internal.')), `nothing was sent inside: ${seen.join(' ')}`);
  } finally {
    globalThis.fetch = before;
    idp.docExtra = {};
    oidc.forgetDiscovery(ISS);
  }
  // The document is right again and kept, but the service's own name now leads inside: checked on every use.
  assert.ok(await orgsso.providerOf(beta));
  const lookup = paydns.resolver.lookup;
  paydns.resolver.lookup = async () => [{ address: '10.1.2.3', family: 4 }];
  try {
    await assert.rejects(orgsso.providerOf(beta), hostProblem('login.acme.test'));
  } finally {
    paydns.resolver.lookup = lookup;
  }
});

test('review: a new login made through the service says so, and that an older login stays where it was', async () => {
  const c = browser();
  const r = await ssoSignIn(c, 'nora@beta.test', { sub: 'nora-1', name: 'Nora New' });
  landed(r);
  const note = JSON.parse(decodeURIComponent(c.cookies.sg_signin_note));
  assert.equal(note.sso_made, 'Acme');
  assert.match(signInNotice(note), /A new GrowSigning login was made for this address, because Acme confirmed it is yours\. If you used GrowSigning before under another address/);
  // Someone who had a login with this address is connected, and is not told a new one was made.
  const b = browser();
  landed(await ssoSignIn(b, 'ben@beta.test', { sub: 'ben-1' }));
  assert.equal(JSON.parse(decodeURIComponent(b.cookies.sg_signin_note) || '{}').sso_made, undefined);
});

test('review: while everyone signs in through it, the owner keeps the way back, and the domain switch asks for the code', async () => {
  beaSecret = await twoStepOn(bea);
  let r = await bea.call('PATCH', '/account/sso/rules', { enforce: true, join_new: true, code: code(beaSecret) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Ben joins Beta as a member through the service.
  landed(await ssoSignIn(browser(), 'ben@beta.test', { sub: 'ben-1' }));
  assert.equal(db.get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', beta, benId).role, 'member');
  // Two-step login cannot be switched off while it is the owner's way back, even with the code.
  r = await bea.post('/me/two-step/off', { code: code(beaSecret) });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, 'sso_way_back');
  assert.match(r.data.error, /^You own .+, where everyone signs in through Acme, .+ so two-step login stays on and nothing was changed\. Switch off "Everyone at these domains signs in through Acme"/);
  assert.ok(db.get('SELECT two_step_on_at FROM users WHERE id=?', beaId).two_step_on_at);
  // The account is not handed to someone without two-step login.
  r = await bea.post('/account/transfer-owner', { user_id: benId });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.match(r.data.error, /Ben Member does not have two-step login on, so the account was not handed over\. Ask them/);
  assert.equal(db.get('SELECT role FROM memberships WHERE account_id=? AND user_id=?', beta, beaId).role, 'owner');
  // Taking the domain out of single sign-on, or removing it, needs the code while the rule is on.
  r = await bea.call('PATCH', `/account/sso/domains/${betaDomain}`, { use_sso: false });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'code_needed');
  assert.ok(orgsso.enforcedFor('ben@beta.test'), 'still enforced');
  r = await bea.call('DELETE', `/account/sso/domains/${betaDomain}`, {});
  assert.equal(r.status, 403);
  assert.ok(db.get('SELECT 1 x FROM org_domains WHERE id=?', betaDomain));
  r = await bea.call('PATCH', `/account/sso/domains/${betaDomain}`, { use_sso: false, code: code(beaSecret) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(orgsso.enforcedFor('ben@beta.test'), null);
  r = await bea.call('PATCH', `/account/sso/domains/${betaDomain}`, { use_sso: true, code: code(beaSecret) });
  assert.equal(r.status, 200);
  // The card knows when the owner's two-step login went anyway (a reset by email after a lost phone).
  assert.equal((await bea.get('/account/sso')).data.owner_two_step, true);
  const was = db.get('SELECT two_step_on_at FROM users WHERE id=?', beaId).two_step_on_at;
  db.run('UPDATE users SET two_step_on_at=NULL WHERE id=?', beaId);
  assert.equal((await bea.get('/account/sso')).data.owner_two_step, false);
  db.run('UPDATE users SET two_step_on_at=? WHERE id=?', was, beaId);
});

test('review: asking for the way back tells a member nothing about their password', async () => {
  const wrong = await browser().post('/auth/login', { email: 'ben@beta.test', password: 'not the password', way_back: true });
  const right = await browser().post('/auth/login', { email: 'ben@beta.test', password: PW, way_back: true });
  const nobody = await browser().post('/auth/login', { email: 'nobody@beta.test', password: PW, way_back: true });
  for (const r of [wrong, right, nobody]) {
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'sso_required');
  }
  assert.deepEqual({ ...wrong.data, request_id: 0 }, { ...right.data, request_id: 0 });
});

test('review: moving to another sign-in service connects everyone again instead of locking them out as "taken"', async () => {
  // The same person with another id at the service (a new tenant, another service) is "taken" while the old id stands.
  refusedWith(await ssoSignIn(browser(), 'ben@beta.test', { sub: 'ben-at-the-new-service' }), 'taken');
  let r = await bea.call('PATCH', '/account/sso/rules', { enforce: false, code: code(beaSecret) });
  assert.equal(r.status, 200);
  r = await bea.call('DELETE', '/account/sso', { code: code(beaSecret) });
  assert.equal(r.status, 200);
  assert.equal(db.all('SELECT * FROM identities WHERE provider=?', `org:${beta}`).length, 0, 'removing it removes the connections');
  assert.match(lines(beta, 'sso.removed').at(-1).details, /connections_removed/);
  assert.equal((await save(bea, { ...setup, code: code(beaSecret) })).status, 200);
  await tryAs(bea, 'bea-new', 'bea@beta.test');
  landed(await ssoSignIn(browser(), 'ben@beta.test', { sub: 'ben-at-the-new-service' }));
  assert.equal(db.get('SELECT subject FROM identities WHERE user_id=? AND provider=?', benId, `org:${beta}`).subject, `${ISS} ben-at-the-new-service`);
  // Another client id (the same service registered again) also starts the connections afresh.
  r = await save(bea, { client_id: 'registered-again', code: code(beaSecret) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.service.tested_at, null);
  assert.equal(db.all('SELECT * FROM identities WHERE provider=?', `org:${beta}`).length, 0);
  assert.match(lines(beta, 'sso.changed').at(-1).details, /connections_removed/);
});

test('review: the outside-services list names organisations\' sign-in services when single sign-on can be set up', () => {
  const on = outsideServices({ FILE_ENCRYPTION_KEY: process.env.FILE_ENCRYPTION_KEY, PWNED_CHECK: '0' }).find((s) => s.id === 'orgsso')!;
  assert.equal(on.on, true);
  assert.match(on.purpose, /client secret/);
  assert.match(on.purpose, /TXT record/);
  assert.match(on.hostWords!, /sign-in service an account admin enters/);
  assert.equal(outsideServices({}).find((s) => s.id === 'orgsso')!.on, false);
  assert.match(outsideStartLines({ FILE_ENCRYPTION_KEY: process.env.FILE_ENCRYPTION_KEY, PWNED_CHECK: '0' })[0], /single sign-on/);
});
