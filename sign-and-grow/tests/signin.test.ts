// Signing in and signing up with Google or Microsoft, against a stand-in for both providers: an RSA key made here,
// the providers' key lists and token endpoints answered by a fetch stub, and ID tokens signed (or forged) in the test.
// What is pinned down: who a person is (the provider's own id for them, never an address alone), every check on the
// ID token, the state that works once and only in the browser that started, that nothing a provider's token says
// can take over a login that exists, and that everything a password sign-in does afterwards happens here as well.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, Client, signUp, mailTo } from './helpers.ts';
import { safeNext, signInErrorText, signInNotice, signInProviders, SIGNIN_ERRORS } from '../src/lib/signin.ts';

type P = 'google' | 'microsoft';
const G = { id: 'sign-and-grow.apps.google.test', secret: 'google-secret' };
const M = { id: '0f0f0f0f-aaaa-4bbb-8ccc-121212121212', secret: 'microsoft-secret' };
const TENANT = '11111111-2222-4333-8444-555555555555'; // an organization at Microsoft
const OTHER_TENANT = '99999999-8888-4777-8666-555555555555'; // somebody else's
const PERSONAL = '9188040d-6c67-4c5b-b112-36a304b66dad'; // Microsoft's own, for personal accounts
const configure = () => {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: G.id, GOOGLE_CLIENT_SECRET: G.secret, MICROSOFT_CLIENT_ID: M.id, MICROSOFT_CLIENT_SECRET: M.secret });
  delete process.env.MICROSOFT_TENANT;
};
configure();

const { db } = await boot();
const { handle } = await import('../src/server/router.ts');
const PW = 'correct horse battery';

// ---- The stand-in provider --------------------------------------------------------------------

type Pair = { kid: string; key: crypto.KeyObject; pub: crypto.KeyObject };
const newKey = (kid: string): Pair => {
  const k = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, key: k.privateKey, pub: k.publicKey };
};
const b64 = (v: any) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const signJwt = (claims: any, pair: Pair, header: any = {}) => {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: pair.kid, ...header });
  const body = b64(claims);
  return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.key).toString('base64url')}`;
};

const idp = {
  published: [newKey('key-1')], // what the key list serves
  keyFetches: 0,
  tokenCalls: [] as Record<string, string>[],
  codes: new Map<string, { provider: P; challenge: string; redirect_uri: string; token: string }>(),
};

const HOSTS: Record<string, P> = { 'oauth2.googleapis.com': 'google', 'www.googleapis.com': 'google', 'login.microsoftonline.com': 'microsoft' };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = new URL(String(url));
  const provider = HOSTS[u.host];
  if (!provider) return realFetch(url, init); // not ours: somebody else's stand-in, or the real thing
  const json = (out: any, status = 200) => new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/oauth2/v3/certs' || u.pathname.endsWith('/discovery/v2.0/keys')) {
    idp.keyFetches++;
    return json({ keys: idp.published.map((p) => ({ ...p.pub.export({ format: 'jwk' }), kid: p.kid, use: 'sig', alg: 'RS256' })) });
  }
  if (init.method === 'POST' && (u.pathname === '/token' || u.pathname.endsWith('/oauth2/v2.0/token'))) {
    const p = Object.fromEntries(new URLSearchParams(String(init.body)));
    idp.tokenCalls.push({ ...p, url: String(url) });
    const c = idp.codes.get(p.code);
    idp.codes.delete(p.code); // a code is redeemed once
    const cfg = provider === 'google' ? G : M;
    // What a real provider checks: the code is known, it is ours (client id and secret), it goes back to the same
    // address, and the caller holds the PKCE verifier whose hash came with the request.
    if (!c || c.provider !== provider || p.grant_type !== 'authorization_code' || p.client_id !== cfg.id || p.client_secret !== cfg.secret || p.redirect_uri !== c.redirect_uri
      || crypto.createHash('sha256').update(p.code_verifier || '').digest('base64url') !== c.challenge) return json({ error: 'invalid_grant', error_description: 'The stand-in does not know this code.' }, 400);
    return json({ access_token: 'not-used', token_type: 'Bearer', id_token: c.token });
  }
  return json({ error: 'not_found' }, 404);
}) as any;
after(() => {
  globalThis.fetch = realFetch;
});

// The claims a provider would sign for this person, for the sign-in that our redirect (auth) asked for.
function claimsFor(provider: P, auth: URL, person: Record<string, any>) {
  const t = Math.floor(Date.now() / 1000);
  const base = { aud: auth.searchParams.get('client_id'), nonce: auth.searchParams.get('nonce'), iat: t, exp: t + 3600 };
  if (provider === 'google') return { iss: 'https://accounts.google.com', azp: base.aud, ...base, email_verified: true, ...person };
  const tid = person.tid || TENANT;
  return { iss: `https://login.microsoftonline.com/${tid}/v2.0`, ver: '2.0', tid, ...base, ...person };
}
type Forge = (claims: any) => string;
// The person agrees at the provider: it hands out a code that can be swapped for their ID token.
function approve(provider: P, location: string, person: Record<string, any>, forge?: Forge): string {
  const auth = new URL(location);
  const claims = claimsFor(provider, auth, person);
  const code = `code-${crypto.randomBytes(8).toString('hex')}`;
  idp.codes.set(code, { provider, challenge: auth.searchParams.get('code_challenge')!, redirect_uri: auth.searchParams.get('redirect_uri')!, token: forge ? forge(claims) : signJwt(claims, idp.published[0]) });
  return code;
}

// ---- A browser ----------------------------------------------------------------------------------

let n = 0;
const browser = () => {
  const c = new Client();
  c.ip = `198.51.${Math.floor(n / 250)}.${(n++ % 250) + 1}`; // sign-ups and sign-ins are limited per address
  return c;
};
// Follows nothing: the test looks at where each answer sends the browser.
async function go(c: Client, url: string, headers: Record<string, string> = {}) {
  const res = await handle(new Request(`http://test.local/api${url}`, { headers: { cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': c.ip, ...headers } }));
  const set = res.headers.getSetCookie();
  for (const ck of set) {
    const [kv] = ck.split(';');
    c.cookies[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  }
  return { status: res.status, location: res.headers.get('location') || '', set, data: (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
}
type Flow = { query?: Record<string, string>; forge?: Forge; state?: string | null; at?: P; between?: (auth: URL) => any };
async function signIn(c: Client, provider: P, person: Record<string, any>, o: Flow = {}) {
  const start = await go(c, `/auth/${provider}/start?${new URLSearchParams(o.query || {})}`);
  assert.equal(start.status, 302, JSON.stringify(start.data));
  const auth = new URL(start.location);
  const code = approve(provider, start.location, person, o.forge);
  await o.between?.(auth);
  const state = o.state === undefined ? auth.searchParams.get('state')! : o.state;
  delete c.cookies.sg_signin_note;
  const back = await go(c, `/auth/${o.at || provider}/callback?${new URLSearchParams({ code, ...(state === null ? {} : { state }) })}`);
  return { ...back, start, auth, code, to: new URL(back.location || 'http://nowhere.invalid/'), note: c.cookies.sg_signin_note ? JSON.parse(decodeURIComponent(c.cookies.sg_signin_note)) : null };
}
async function connect(c: Client, provider: P, person: Record<string, any>, between?: () => any) {
  const r = await c.post(`/me/signin/${provider}/connect`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const auth = new URL(r.data.url);
  const code = approve(provider, r.data.url, person);
  await between?.();
  const back = await go(c, `/auth/${provider}/callback?${new URLSearchParams({ code, state: auth.searchParams.get('state')! })}`);
  return { ...back, auth, to: new URL(back.location || 'http://nowhere.invalid/') };
}
const whoIs = async (c: Client) => (await c.get('/me')).data.user;
const user = (email: string) => db.get('SELECT * FROM users WHERE email=?', email);
const identities = (email: string) => db.all('SELECT i.* FROM identities i JOIN users u ON u.id=i.user_id WHERE u.email=? ORDER BY i.created_at', email);
// Signed in, and sent to the landing page of this site.
const landed = (r: any, next = '/app') => {
  assert.equal(r.status, 302, JSON.stringify(r.data));
  assert.equal(r.location, `http://test.local/signin/done?next=${encodeURIComponent(next)}`);
};
// Not signed in, and sent back to a page of this site with a code the page turns into words.
const refused = (r: any, code: string, page = '/login') => {
  assert.equal(r.status, 302, JSON.stringify(r.data));
  assert.equal(r.to.origin, 'http://test.local');
  assert.equal(r.to.pathname, page);
  assert.equal(r.to.searchParams.get('signin_error'), code);
  assert.equal(r.note, null, 'nothing is said about a sign-in that did not happen');
};
const google = (email: string, over: Record<string, any> = {}) => ({ sub: `g-${email}`, email, name: 'Gina Google', ...over });
const microsoft = (email: string, over: Record<string, any> = {}) => ({ oid: `oid-${email}`, sub: `pairwise-${email}`, email, preferred_username: email, name: 'Mika Microsoft', ...over });

// ---- New people ---------------------------------------------------------------------------------

test('the public route lists the providers that are switched on, by name', async () => {
  const r = await browser().get('/auth/providers');
  assert.deepEqual(r.data, { providers: [{ id: 'google', name: 'Google' }, { id: 'microsoft', name: 'Microsoft' }] });
});

test('a new person signs up with Google: the request is a proper code flow, and the login is made as sign-up makes it', async () => {
  const c = browser();
  const r = await signIn(c, 'google', google('nora@gmail.com', { name: 'Nora New' }));
  // What we sent the browser to the provider with.
  const q = r.auth.searchParams;
  assert.equal(r.auth.origin + r.auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('client_id'), G.id);
  assert.equal(q.get('redirect_uri'), 'http://test.local/api/auth/google/callback', 'APP_URL plus the callback path, the address to register');
  assert.match(q.get('scope')!, /\bopenid\b/);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('state')!.length >= 32 && q.get('nonce')!.length >= 32 && q.get('code_challenge')!.length >= 43);
  // The state is bound to this browser by a cookie scripts cannot read, and it does not live long.
  const cookie = r.start.set.find((s: string) => s.startsWith('sg_signin='))!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=600\b/);
  assert.equal(cookie.split(';')[0], `sg_signin=${q.get('state')}`);
  // The code was swapped with our secret and the PKCE verifier (the stand-in refuses anything else).
  const call = idp.tokenCalls.at(-1)!;
  assert.equal(call.url, 'https://oauth2.googleapis.com/token');
  assert.equal(crypto.createHash('sha256').update(call.code_verifier).digest('base64url'), q.get('code_challenge'));
  assert.equal(call.client_secret, G.secret);

  landed(r);
  const me = await whoIs(c);
  assert.equal(me.email, 'nora@gmail.com');
  assert.equal(me.name, 'Nora New');
  assert.equal(me.email_verified, true, 'Google runs this mailbox and says the address is confirmed');
  assert.equal(me.has_password, false);
  assert.equal(mailTo('nora@gmail.com').filter((m) => /Confirm your email/.test(m.subject)).length, 0, 'so we do not ask again');
  // A workspace of their own, with the welcome signatures, as at sign-up.
  const u = user('nora@gmail.com');
  const ws = db.all('SELECT a.id, a.name, m.role FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=?', u.id);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].role, 'owner');
  assert.equal(ws[0].name, "Nora's workspace");
  assert.equal(db.get("SELECT COALESCE(SUM(delta),0) n FROM credits WHERE account_id=? AND reason='welcome'", ws[0].id).n, 3);
  // The person is the provider's id for them.
  const [idn] = identities('nora@gmail.com');
  assert.deepEqual([idn.provider, idn.subject, idn.email, idn.vouched], ['google', 'g-nora@gmail.com', 'nora@gmail.com', 1]);
  // The first screen says how they got in and that there is no password.
  assert.equal(r.note.created, 'Google');
  assert.match(signInNotice(r.note), /made with Google.*It has no password\. You can set one under Settings/);
  // No password opens this login.
  for (const password of ['', '!', 'password', PW]) assert.equal((await browser().post('/auth/login', { email: 'nora@gmail.com', password })).status, 401);
});

test('a new person signs up with Microsoft: known by organization and object id, and we confirm the address ourselves', async () => {
  const c = browser();
  const r = await signIn(c, 'microsoft', microsoft('mo@contoso.example', { name: 'Mo Soft' }));
  assert.equal(r.auth.origin + r.auth.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(r.auth.searchParams.get('redirect_uri'), 'http://test.local/api/auth/microsoft/callback');
  assert.equal(idp.tokenCalls.at(-1)!.url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  landed(r);
  const me = await whoIs(c);
  assert.equal(me.email, 'mo@contoso.example');
  assert.equal(me.email_verified, false, 'Microsoft did not vouch for the address');
  const [idn] = identities('mo@contoso.example');
  assert.deepEqual([idn.provider, idn.subject, idn.vouched], ['microsoft', `${TENANT}/oid/oid-mo@contoso.example`, 0]);
  // Our own confirmation email, as after a sign-up with a password. It says how the login came about.
  const [confirm] = mailTo('mo@contoso.example').filter((m) => /Confirm your email/.test(m.subject));
  assert.ok(confirm);
  assert.match(confirm.html, /made by someone who signed in with Microsoft and gave this address/);
  assert.match(confirm.html, /If it was not you, do not confirm/);
  assert.equal(r.note.confirm, true);
  assert.match(signInNotice(r.note), /We emailed you a link to confirm your address/);
  // A workspace with the welcome signatures all the same.
  assert.equal(db.get("SELECT COUNT(*) n FROM credits c JOIN memberships m ON m.account_id=c.account_id WHERE m.user_id=? AND c.reason='welcome'", user('mo@contoso.example').id).n, 1);

  // With the optional claim that says the owner of the address's domain was verified, the address counts as confirmed.
  const d = browser();
  landed(await signIn(d, 'microsoft', microsoft('vera@fabrikam.example', { xms_edov: true })));
  assert.equal((await whoIs(d)).email_verified, true);
  assert.equal(mailTo('vera@fabrikam.example').filter((m) => /Confirm your email/.test(m.subject)).length, 0);
  // Without an "email" claim the sign-in name is used as the address, and is never taken as confirmed.
  const e = browser();
  landed(await signIn(e, 'microsoft', microsoft('upn@fabrikam.example', { email: undefined, xms_edov: true })));
  assert.equal((await whoIs(e)).email_verified, false);
  // And with no address at all there is nothing to make a login from.
  const f = browser();
  refused(await signIn(f, 'microsoft', { oid: 'oid-nameless', sub: 'pairwise-nameless', name: 'No Address' }, { query: { mode: 'signup' } }), 'no_email', '/signup');
  assert.equal(await whoIs(f), null);
});

test('someone who comes back is recognised by the provider\'s id, also after their address there changed', async () => {
  const first = browser();
  landed(await signIn(first, 'google', google('rita@gmail.com')));
  const id = (await whoIs(first)).id;
  const again = browser();
  const r = await signIn(again, 'google', google('rita@gmail.com'));
  landed(r);
  assert.equal((await whoIs(again)).id, id);
  assert.deepEqual(r.note, { restored: false, fresh: false, joined: null, invite_error: null });
  assert.equal(signInNotice(r.note), '', 'an ordinary sign-in says nothing');
  // Same Google account, new address: still the same login, and no second one is made for the new address.
  const moved = browser();
  landed(await signIn(moved, 'google', { ...google('rita@gmail.com'), email: 'rita.renamed@gmail.com' }));
  assert.equal((await whoIs(moved)).id, id);
  assert.equal((await whoIs(moved)).email, 'rita@gmail.com');
  assert.equal(user('rita.renamed@gmail.com'), null);
  assert.equal(db.get('SELECT COUNT(*) n FROM identities WHERE user_id=?', id).n, 1);
  assert.equal(identities('rita@gmail.com')[0].email, 'rita.renamed@gmail.com', 'Settings shows the address it has now');
});

// ---- The state: once, and only in the browser that started ---------------------------------------

test('a sign-in whose state is missing, made up, from another browser, used twice, too old or from the other provider signs nobody in', async () => {
  const people = () => db.get('SELECT COUNT(*) n FROM users').n;
  const before = people();
  const who = google('stan@gmail.com');
  // Missing and made up.
  let c = browser();
  refused(await signIn(c, 'google', who, { state: null }), 'expired');
  assert.equal(await whoIs(c), null);
  c = browser();
  refused(await signIn(c, 'google', who, { state: 'made-up-by-someone' }), 'expired');
  // Another browser: the link is right but the cookie is not there. This is how one person would sign another
  // into their own login (the code and state of the attacker, opened by the victim).
  const attacker = browser(), victim = browser();
  const started = await go(attacker, '/auth/google/start');
  const theirs = new URL(started.location);
  const code = approve('google', started.location, google('attacker@gmail.com'));
  const opened = await go(victim, `/auth/google/callback?${new URLSearchParams({ code, state: theirs.searchParams.get('state')! })}`);
  assert.match(opened.location, /^http:\/\/test\.local\/login\?signin_error=expired/);
  assert.equal(await whoIs(victim), null);
  assert.equal(user('attacker@gmail.com'), null);
  // ...and presenting it burned it: the browser that started cannot finish it any more either.
  const late = await go(attacker, `/auth/google/callback?${new URLSearchParams({ code, state: theirs.searchParams.get('state')! })}`);
  assert.match(late.location, /signin_error=expired/);
  // A cookie for one sign-in does not carry another one's state.
  c = browser();
  const one = await go(c, '/auth/google/start');
  const two = await go(c, '/auth/google/start');
  const stale = await go(c, `/auth/google/callback?${new URLSearchParams({ code: approve('google', one.location, who), state: new URL(one.location).searchParams.get('state')! })}`);
  assert.match(stale.location, /signin_error=expired/);
  assert.ok(two.location);
  // Used twice: the first time signs in, the second time (the back button, or a copy of the address) does not.
  c = browser();
  const ok = await signIn(c, 'google', who);
  landed(ok);
  const replay = browser();
  replay.cookies.sg_signin = ok.auth.searchParams.get('state')!;
  const second = await go(replay, `/auth/google/callback?${new URLSearchParams({ code: ok.code, state: ok.auth.searchParams.get('state')! })}`);
  assert.match(second.location, /signin_error=expired/);
  assert.equal(await whoIs(replay), null);
  // Too old.
  c = browser();
  refused(await signIn(c, 'google', google('slow@gmail.com'), { between: () => db.run('UPDATE signin_states SET expires_at=?', new Date(Date.now() - 1000).toISOString()) }), 'expired');
  assert.equal(user('slow@gmail.com'), null);
  // Started at Google, finished at Microsoft's callback.
  c = browser();
  refused(await signIn(c, 'google', google('mixed@gmail.com'), { at: 'microsoft' }), 'expired');
  assert.equal(user('mixed@gmail.com'), null);
  assert.equal(people(), before + 1, 'only the one honest sign-in made a login');
  assert.equal(db.get('SELECT COUNT(*) n FROM signin_states WHERE expires_at > ?', new Date().toISOString()).n, 0, 'nothing that was presented is left to use again');
  assert.match(signInErrorText('expired', 'google'), /used already, or it took longer than 10 minutes.*start again/);
});

test('over https the cookies of a sign-in are ones only this host can have set, and a start on another host name moves to the right one', async () => {
  const https = { 'x-forwarded-proto': 'https' };
  // A neighbouring site under the same domain can plant an ordinary cookie in someone's browser, and with it the
  // state of a sign-in of its own. Over https the state is read from a "__Host-" cookie, which it cannot plant.
  const attacker = browser(), victim = browser();
  const theirs = await go(attacker, '/auth/google/start', https);
  const set = theirs.set.find((s: string) => s.startsWith('__Host-sg_signin='))!;
  assert.match(set, /; Secure/);
  assert.match(set, /Path=\/;/);
  assert.doesNotMatch(set, /Domain=/i);
  const state = new URL(theirs.location).searchParams.get('state')!;
  victim.cookies.sg_signin = state; // planted under the plain name
  const code = approve('google', theirs.location, google('planter@gmail.com'));
  const opened = await go(victim, `/auth/google/callback?${new URLSearchParams({ code, state })}`, https);
  assert.match(opened.location, /signin_error=expired/);
  assert.equal(await whoIs(victim), null);
  assert.equal(user('planter@gmail.com'), null);
  // The honest flow over https, start to finish, with the note for the first screen under the same kind of name.
  const c = browser();
  const start = await go(c, '/auth/google/start', https);
  const back = await go(c, `/auth/google/callback?${new URLSearchParams({ code: approve('google', start.location, google('hosty@gmail.com')), state: new URL(start.location).searchParams.get('state')! })}`, https);
  assert.equal(back.location, 'http://test.local/signin/done?next=%2Fapp');
  const note = back.set.find((s: string) => s.startsWith('__Host-sg_signin_note='))!;
  assert.match(note, /; Secure/);
  assert.doesNotMatch(note, /HttpOnly/, 'the landing page has to read it');
  assert.match(back.set.find((s: string) => s.startsWith('ts_session='))!, /HttpOnly.*Secure/);
  assert.equal((await whoIs(c)).email, 'hosty@gmail.com');

  // Opened under another host name (www, say): the state cookie would never come back to the address the provider
  // returns to, so the browser is moved to the configured address first. Once, so it can never go round in circles.
  const www = { 'x-forwarded-host': 'www.test.local' };
  const d = browser();
  const moved = await go(d, '/auth/microsoft/start?mode=signup&code=GROWalition', www);
  assert.equal(moved.status, 302);
  assert.equal(moved.location, 'http://test.local/api/auth/microsoft/start?mode=signup&code=GROWalition&moved=1');
  assert.equal(moved.set.length, 0, 'nothing was started on the wrong host');
  const second = await go(d, '/auth/microsoft/start?mode=signup&code=GROWalition&moved=1', www);
  assert.equal(new URL(second.location).host, 'login.microsoftonline.com');
});

test('cancelling at the provider is said in words, and nothing is made', async () => {
  const c = browser();
  const start = await go(c, '/auth/microsoft/start?mode=signup&code=GROWalition');
  const state = new URL(start.location).searchParams.get('state')!;
  const back = await go(c, `/auth/microsoft/callback?${new URLSearchParams({ error: 'access_denied', error_description: 'The user cancelled', state })}`);
  const to = new URL(back.location);
  assert.equal(to.pathname, '/signup', 'back on the page they started from');
  assert.equal(to.searchParams.get('signin_error'), 'cancelled');
  assert.equal(to.searchParams.get('code'), 'GROWalition', 'with the code they had typed');
  assert.equal(await whoIs(c), null);
  assert.match(signInErrorText('cancelled', 'microsoft'), /You stopped at Microsoft.*not signed in.*try again, or use your email and password/);
});

// ---- The ID token is checked here ---------------------------------------------------------------

test('an ID token is refused unless its signature, issuer, audience, expiry and nonce are all right', async () => {
  const other = newKey('key-1'); // same key id, not the provider's key
  const t = () => Math.floor(Date.now() / 1000);
  const pub = idp.published[0];
  const cases: [string, P, Forge][] = [
    ['a signature made with another key', 'google', (c) => signJwt(c, other)],
    ['claims changed after signing', 'google', (c) => {
      const [h, , s] = signJwt(c, pub).split('.');
      return `${h}.${b64({ ...c, email: 'someone.else@gmail.com' })}.${s}`;
    }],
    ['alg "none" with no signature', 'google', (c) => `${b64({ alg: 'none', typ: 'JWT', kid: pub.kid })}.${b64(c)}.`],
    ['alg "none" with a made-up signature', 'google', (c) => `${b64({ alg: 'none', typ: 'JWT', kid: pub.kid })}.${b64(c)}.${b64('anything')}`],
    ['alg "None" in another spelling', 'google', (c) => `${b64({ alg: 'None', kid: pub.kid })}.${b64(c)}.${b64('x')}`],
    // The classic mix-up: a symmetric signature keyed with the public key, which anyone can compute.
    ['HS256 signed with the public key as the secret (PEM)', 'google', (c) => {
      const data = `${b64({ alg: 'HS256', typ: 'JWT', kid: pub.kid })}.${b64(c)}`;
      return `${data}.${crypto.createHmac('sha256', pub.pub.export({ type: 'spki', format: 'pem' })).update(data).digest('base64url')}`;
    }],
    ['HS256 signed with the public key as the secret (DER)', 'google', (c) => {
      const data = `${b64({ alg: 'HS256', typ: 'JWT', kid: pub.kid })}.${b64(c)}`;
      return `${data}.${crypto.createHmac('sha256', pub.pub.export({ type: 'spki', format: 'der' })).update(data).digest('base64url')}`;
    }],
    ['RS384, which we never asked for', 'google', (c) => {
      const data = `${b64({ alg: 'RS384', kid: pub.kid })}.${b64(c)}`;
      return `${data}.${crypto.sign('RSA-SHA384', Buffer.from(data), pub.key).toString('base64url')}`;
    }],
    ['no key id', 'google', (c) => signJwt(c, pub, { kid: undefined })],
    ['a nonce from another sign-in', 'google', (c) => signJwt({ ...c, nonce: 'nonce-of-another-sign-in' }, pub)],
    ['no nonce', 'google', (c) => signJwt({ ...c, nonce: undefined }, pub)],
    ['an audience that is another app', 'google', (c) => signJwt({ ...c, aud: 'another-app.apps.google.test', azp: 'another-app.apps.google.test' }, pub)],
    ['several audiences, authorised for another app', 'google', (c) => signJwt({ ...c, aud: [G.id, 'another-app'], azp: 'another-app' }, pub)],
    ['several audiences and nobody named as authorised', 'google', (c) => signJwt({ ...c, aud: [G.id, 'another-app'], azp: undefined }, pub)],
    ['an issuer that is not Google', 'google', (c) => signJwt({ ...c, iss: 'https://accounts.google.com.evil.example' }, pub)],
    ['a Microsoft issuer on a Google sign-in', 'google', (c) => signJwt({ ...c, iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT }, pub)],
    ['expired', 'google', (c) => signJwt({ ...c, iat: t() - 7200, exp: t() - 3600 }, pub)],
    ['no expiry', 'google', (c) => signJwt({ ...c, exp: undefined }, pub)],
    ['not valid yet', 'google', (c) => signJwt({ ...c, nbf: t() + 3600 }, pub)],
    ['nobody named', 'google', (c) => signJwt({ ...c, sub: undefined }, pub)],
    ['not a token at all', 'google', () => 'not.a.token'],
    // Microsoft signs for every organization with the same keys, so the issuer must name the organization in the token.
    ['Microsoft: the issuer of one organization, the tid of another', 'microsoft', (c) => signJwt({ ...c, tid: TENANT, iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }, pub)],
    ['Microsoft: the issuer left as the template', 'microsoft', (c) => signJwt({ ...c, iss: 'https://login.microsoftonline.com/{tenantid}/v2.0' }, pub)],
    ['Microsoft: no organization in the token', 'microsoft', (c) => signJwt({ ...c, tid: undefined }, pub)],
    ['Microsoft: an organization that is not an id', 'microsoft', (c) => signJwt({ ...c, tid: 'common', iss: 'https://login.microsoftonline.com/common/v2.0' }, pub)],
    ['Microsoft: an older kind of token with another issuer', 'microsoft', (c) => signJwt({ ...c, iss: `https://sts.windows.net/${TENANT}/` }, pub)],
    ['Microsoft: issued for another app', 'microsoft', (c) => signJwt({ ...c, aud: G.id }, pub)],
  ];
  const before = db.get('SELECT COUNT(*) n FROM users').n;
  for (const [what, provider, forge] of cases) {
    const c = browser();
    const person = provider === 'google' ? google('forged@gmail.com') : microsoft('forged@contoso.example');
    const r = await signIn(c, provider, person, { forge });
    assert.equal(r.to.searchParams.get('signin_error'), 'failed', what);
    assert.equal(r.to.pathname, '/login', what);
    assert.equal(await whoIs(c), null, what);
  }
  assert.equal(db.get('SELECT COUNT(*) n FROM users').n, before, 'no forged token made a login');
  assert.equal(db.get('SELECT COUNT(*) n FROM identities WHERE email LIKE ?', 'forged@%').n, 0);
  // The same people with honest tokens get in, so it was the forgery that was refused and not the person. A token
  // that ran out a few seconds ago is still taken, because clocks differ a little.
  landed(await signIn(browser(), 'google', google('forged@gmail.com'), { forge: (c) => signJwt({ ...c, exp: t() - 5 }, pub) }));
  landed(await signIn(browser(), 'microsoft', microsoft('forged@contoso.example')));
  assert.match(signInErrorText('failed', 'google'), /Google did not confirm who you are.*not signed in.*use your email and password, or get help/);
});

test('the provider\'s keys are fetched once and kept, and fetched once more when a token names a key we have not seen', async () => {
  (globalThis as any).__tsjwks.clear();
  idp.keyFetches = 0;
  landed(await signIn(browser(), 'google', google('kay@gmail.com')));
  landed(await signIn(browser(), 'google', google('kay@gmail.com')));
  landed(await signIn(browser(), 'google', google('kay2@gmail.com')));
  assert.equal(idp.keyFetches, 1, 'kept for an hour');
  // The provider changes its key. The new key id is not in our copy, so the list is read once more.
  const old = idp.published[0];
  idp.published = [newKey('key-2')];
  landed(await signIn(browser(), 'google', google('kay@gmail.com')));
  assert.equal(idp.keyFetches, 2);
  // A token signed with the key that was withdrawn is no longer accepted.
  const c = browser();
  refused(await signIn(c, 'google', google('kay@gmail.com'), { forge: (cl) => signJwt(cl, old) }), 'failed');
  assert.equal(idp.keyFetches, 3, 'one more look, and the key is not there');
  // A key id nobody published: one look, refused, and nobody is signed in.
  refused(await signIn(c, 'google', google('kay@gmail.com'), { forge: (cl) => signJwt(cl, newKey('ghost')) }), 'failed');
  assert.equal(idp.keyFetches, 4);
  // After an hour the copy is read again.
  for (const v of (globalThis as any).__tsjwks.values()) v.at -= 3601_000;
  landed(await signIn(browser(), 'google', google('kay@gmail.com')));
  assert.equal(idp.keyFetches, 5);
  // Microsoft's keys are a list of their own.
  landed(await signIn(browser(), 'microsoft', microsoft('kay@contoso.example')));
  landed(await signIn(browser(), 'microsoft', microsoft('kay@contoso.example')));
  assert.equal(idp.keyFetches, 6);
});

test('MICROSOFT_TENANT limits who may sign in with Microsoft, and a value we cannot check switches it off', async () => {
  try {
    process.env.MICROSOFT_TENANT = TENANT;
    const c = browser();
    const r = await signIn(c, 'microsoft', microsoft('guest@elsewhere.example', { tid: OTHER_TENANT }));
    assert.equal(r.auth.pathname, `/${TENANT}/oauth2/v2.0/authorize`);
    refused(r, 'failed');
    assert.equal(user('guest@elsewhere.example'), null);
    landed(await signIn(browser(), 'microsoft', microsoft('staff@contoso.example', { tid: TENANT })));
    process.env.MICROSOFT_TENANT = 'organizations';
    refused(await signIn(browser(), 'microsoft', microsoft('home@outlook.example', { tid: PERSONAL })), 'failed');
    process.env.MICROSOFT_TENANT = 'consumers';
    refused(await signIn(browser(), 'microsoft', microsoft('work@contoso.example', { tid: TENANT })), 'failed');
    landed(await signIn(browser(), 'microsoft', microsoft('home@outlook.example', { tid: PERSONAL })));
    // A domain name cannot be compared with the organization in a token, so it is not accepted as a setting.
    process.env.MICROSOFT_TENANT = 'contoso.example';
    assert.deepEqual(signInProviders(), ['google']);
    assert.equal((await go(browser(), '/auth/microsoft/start')).status, 404);
  } finally {
    configure();
  }
});

// ---- An address alone never opens a login --------------------------------------------------------

test('a token that only claims the address of an existing login does not get in (Microsoft and Google)', async () => {
  const victim = await signUp('Vic Tim', 'vic@corp.example', browser().ip);
  const mailBefore = mailTo('vic@corp.example').length;
  const tries: [string, P, Record<string, any>][] = [
    // The known takeover: the admin of any organization at Microsoft can write any address into "email".
    ['Microsoft, an address set by the organization\'s admin', 'microsoft', microsoft('vic@corp.example', { tid: OTHER_TENANT, oid: 'attacker' })],
    ['Microsoft, in capitals', 'microsoft', microsoft('VIC@Corp.Example', { tid: OTHER_TENANT, oid: 'attacker-2' })],
    ['Microsoft, only as the sign-in name', 'microsoft', microsoft('vic@corp.example', { tid: OTHER_TENANT, oid: 'attacker-3', email: undefined })],
    ['Microsoft, with the vouching claim as text instead of true', 'microsoft', microsoft('vic@corp.example', { tid: OTHER_TENANT, oid: 'attacker-4', xms_edov: 'true' })],
    ['Microsoft, with the vouching claim as a number', 'microsoft', microsoft('vic@corp.example', { tid: OTHER_TENANT, oid: 'attacker-5', xms_edov: 1 })],
    ['Google, address not confirmed', 'google', google('vic@corp.example', { sub: 'g-attacker', email_verified: false })],
    ['Google, "confirmed" as text', 'google', google('vic@corp.example', { sub: 'g-attacker-2', email_verified: 'true' })],
    ['Google, no word about confirmation', 'google', google('vic@corp.example', { sub: 'g-attacker-3', email_verified: undefined })],
    // Confirmed once, long ago, for a mailbox Google does not run: not enough to open a login that exists.
    ['Google, confirmed but not a mailbox Google runs', 'google', google('vic@corp.example', { sub: 'g-attacker-4', email_verified: true })],
  ];
  for (const [what, provider, person] of tries) {
    const c = browser();
    const r = await signIn(c, provider, person);
    refused(r, 'exists');
    assert.equal(r.to.searchParams.get('provider'), provider, what);
    assert.equal(await whoIs(c), null, what);
  }
  assert.equal(identities('vic@corp.example').length, 0, 'nothing was connected');
  // At a mailbox Google does run, only a plain "true" counts as Google confirming the address.
  await signUp('Gem Mail', 'gem@gmail.com', browser().ip);
  for (const email_verified of ['true', 1, 'yes', {}, null]) {
    const c = browser();
    refused(await signIn(c, 'google', google('gem@gmail.com', { sub: `g-loose-${String(email_verified)}`, email_verified })), 'exists');
    assert.equal(await whoIs(c), null);
  }
  assert.equal(identities('gem@gmail.com').length, 0);
  // The same object id in another organization is another person: it does not open the login of the first.
  assert.equal(identities('mo@contoso.example')[0].subject, `${TENANT}/oid/oid-mo@contoso.example`);
  const twin = browser();
  refused(await signIn(twin, 'microsoft', microsoft('mo@contoso.example', { tid: OTHER_TENANT })), 'exists');
  assert.equal(await whoIs(twin), null);
  assert.equal(identities('mo@contoso.example').length, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM users WHERE email=?', 'vic@corp.example').n, 1);
  assert.equal(mailTo('vic@corp.example').length, mailBefore);
  assert.equal((await whoIs(victim)).email, 'vic@corp.example', 'and the real owner is still signed in');
  assert.equal((await browser().post('/auth/login', { email: 'vic@corp.example', password: PW })).status, 200, 'with their password as it was');
  // The page says what to do, in the words of the brief.
  const words = signInErrorText('exists', 'microsoft');
  assert.match(words, /^You already have a Sign&Grow login with this address\. Sign in with your password once, then connect Microsoft under Settings\./);
  assert.match(words, /does not confirm to us that this address is yours/);
  assert.match(words, /Forgot password/);
});

test('when the provider vouches for the address, it is connected to the existing login and the owner is told', async () => {
  const ada = await signUp('Ada Owner', 'ada@gmail.com', browser().ip);
  const id = (await whoIs(ada)).id;
  const c = browser();
  const r = await signIn(c, 'google', google('ADA@gmail.com'));
  landed(r);
  assert.equal((await whoIs(c)).id, id);
  assert.equal(identities('ada@gmail.com').length, 1);
  assert.deepEqual([r.note.linked, r.note.reclaimed], ['Google', undefined]);
  assert.match(signInNotice(r.note), /Google is now connected to your login.*We emailed you a note/);
  const [told] = mailTo('ada@gmail.com').filter((m) => /Google can now open your Sign&amp;Grow login|Google can now open your Sign&Grow login/.test(m.subject));
  assert.ok(told, 'the owner gets an email');
  assert.match(told.html, /because Google confirmed to us that ada@gmail\.com belongs to the person who just signed in there\. Your password is unchanged\./);
  assert.match(told.html, /If it was not you: sign in, open Settings, Profile, and under &quot;Ways to sign in&quot; disconnect Google\. Then change your password/);
  // The password still works, and the browser that was signed in stays signed in.
  assert.equal((await browser().post('/auth/login', { email: 'ada@gmail.com', password: PW })).status, 200);
  assert.equal((await whoIs(ada)).id, id);
  // A Google Workspace address counts the same way (the "hd" claim), and so does Microsoft with its vouching claim.
  await signUp('Wes Work', 'wes@firm.example', browser().ip);
  landed(await signIn(browser(), 'google', google('wes@firm.example', { hd: 'firm.example' })));
  assert.equal(identities('wes@firm.example')[0].vouched, 1);
  await signUp('Mia Soft', 'mia@firm.example', browser().ip);
  const m = await signIn(browser(), 'microsoft', microsoft('mia@firm.example', { xms_edov: true }));
  landed(m);
  assert.equal(m.note.linked, 'Microsoft');
  assert.equal(mailTo('mia@firm.example').filter((x) => /Microsoft can now open your/.test(x.subject)).length, 1);
});

test('a login somebody started in another person\'s name is theirs no longer once the provider vouches for the real owner', async () => {
  // A stranger signs up with the address of someone who has no login yet, chooses the password, makes an API key
  // and waits. The address is never confirmed.
  const stranger = browser();
  assert.equal((await stranger.post('/auth/signup', { name: 'Not Really Val', email: 'val@gmail.com', password: 'known to the stranger' })).status, 200);
  const key = (await stranger.post('/api-keys', { name: 'left behind' })).data.key;
  assert.equal((await new Client().call('GET', '/envelopes', undefined, { authorization: `Bearer ${key}` })).status, 200);
  // The real Val arrives with Google.
  const val = browser();
  const r = await signIn(val, 'google', google('val@gmail.com', { name: 'Val Real' }));
  landed(r);
  assert.equal((await whoIs(val)).email, 'val@gmail.com');
  assert.equal((await whoIs(val)).email_verified, true);
  // Every way in the stranger had is gone: the password, the open browser, the API key.
  assert.equal((await browser().post('/auth/login', { email: 'val@gmail.com', password: 'known to the stranger' })).status, 401);
  assert.equal(await whoIs(stranger), null);
  const withKey = await new Client().call('GET', '/envelopes', undefined, { authorization: `Bearer ${key}` });
  assert.equal(withKey.status, 401);
  assert.match(withKey.data.error, /It was revoked/);
  // Val is told on the first screen and by email, with what to look at.
  assert.equal(r.note.reclaimed, 'password');
  assert.match(signInNotice(r.note), /the address was never confirmed.*the password that was set before no longer works.*choose a new password under Settings.*look at the team, the API keys and the webhooks/);
  const [told] = mailTo('val@gmail.com').filter((m) => /Google can now open your/.test(m.subject));
  assert.match(told.html, /its address had never been confirmed.*the password that was set before no longer works.*API keys made by this login were revoked/s);

  // The other way round: the stranger makes the login by signing in with Microsoft under the victim's address.
  const squatter = browser();
  landed(await signIn(squatter, 'microsoft', microsoft('uma@corp.example', { tid: OTHER_TENANT, oid: 'squatter' })));
  assert.equal((await whoIs(squatter)).email, 'uma@corp.example');
  // Uma finds a login exists, asks for the password link, and chooses a password. That link went to her mailbox.
  assert.equal((await browser().post('/auth/signup', { name: 'Uma', email: 'uma@corp.example', password: PW })).status, 409);
  assert.equal((await browser().post('/auth/forgot', { email: 'uma@corp.example' })).status, 200);
  const mail = mailTo('uma@corp.example').filter((m) => /Choose a password/.test(m.subject)).at(-1)!;
  assert.match(mail.html, /has no password yet\. It is opened by signing in with Microsoft/);
  assert.match(mail.html, /has not been confirmed yet, so choosing a password here also disconnects Microsoft/);
  const reset = await browser().post('/auth/reset', { token: new URL(mail.link).searchParams.get('token'), password: PW });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.data.disconnected, ['Microsoft']);
  // The stranger is out, for good: their browser, and their Microsoft account.
  assert.equal(await whoIs(squatter), null);
  const back = browser();
  refused(await signIn(back, 'microsoft', microsoft('uma@corp.example', { tid: OTHER_TENANT, oid: 'squatter' })), 'exists');
  assert.equal(await whoIs(back), null);
  assert.equal((await browser().post('/auth/login', { email: 'uma@corp.example', password: PW })).status, 200);
});

// ---- Everything sign-up and sign-in do afterwards --------------------------------------------------

test('an invitation carried through the sign-in joins the team: for a new person, for someone with a login, and not for another address', async () => {
  const owner = await signUp('Olga Owner', 'olga@team.example', browser().ip);
  const team = (await owner.get('/me')).data.account;
  const invite = async (email: string) => {
    assert.equal((await owner.post('/account/invites', { email })).status, 200);
    return db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL', email).token as string;
  };
  // A new person: joins the team instead of getting a workspace, and the address counts as confirmed, as at sign-up.
  const tok = await invite('ned@invited.example');
  const ned = browser();
  const r = await signIn(ned, 'microsoft', microsoft('ned@invited.example', { name: 'Ned New' }), { query: { mode: 'signup', invite: tok } });
  assert.equal(r.auth.searchParams.get('login_hint'), 'ned@invited.example', 'the provider is asked for the invited account');
  landed(r);
  const me = (await ned.get('/me')).data;
  assert.equal(me.account.id, team.id);
  assert.equal(me.role, 'member');
  assert.equal(me.user.email_verified, true);
  assert.equal(db.get('SELECT COUNT(*) n FROM memberships WHERE user_id=?', me.user.id).n, 1, 'no workspace of their own was made');
  assert.equal(r.note.joined, team.name);
  assert.match(signInNotice(r.note), new RegExp(`You have joined ${team.name}\\.`));
  assert.equal(db.get('SELECT accepted_at FROM invites WHERE token=?', tok).accepted_at != null, true);

  // Someone who already has a login (and is known to Google): signed in and on the team.
  landed(await signIn(browser(), 'google', google('hal@gmail.com')));
  const tok2 = await invite('hal@gmail.com');
  const hal = browser();
  const h = await signIn(hal, 'google', google('hal@gmail.com'), { query: { invite: tok2 } });
  landed(h);
  assert.equal(h.note.joined, team.name);
  assert.equal((await hal.get('/me')).data.account.id, team.id, 'and the team is what opens');

  // A new person who picks an account with another address: nothing is made, and the page says why.
  const tok3 = await invite('wanda@invited.example');
  const wanda = browser();
  const w = await signIn(wanda, 'google', google('wanda.private@gmail.com'), { query: { mode: 'signup', invite: tok3 } });
  refused(w, 'invite', '/signup');
  assert.equal(w.to.searchParams.get('invite'), tok3, 'the invitation is still in the address, to try again');
  assert.equal(w.to.searchParams.get('email'), 'wanda@invited.example', 'with the invited address for the form');
  assert.equal(await whoIs(wanda), null);
  assert.equal(user('wanda.private@gmail.com'), null);
  assert.equal(db.get('SELECT COUNT(*) n FROM identities WHERE email=?', 'wanda.private@gmail.com').n, 0);
  assert.equal(db.get('SELECT accepted_at FROM invites WHERE token=?', tok3).accepted_at, null, 'and it is still there for the person it was meant for');
  assert.match(signInErrorText('invite', 'google'), /cannot be used with the address you chose at Google.*No login was created.*create a login with that address and a password/);

  // Someone with a login who carries an invitation for another address: signed in, told why they did not join.
  const o = await signIn(browser(), 'google', google('hal@gmail.com'), { query: { invite: tok3 } });
  landed(o);
  assert.match(o.note.invite_error, /cannot be used with hal@gmail\.com/);
  assert.match(signInNotice(o.note), /You are signed in, but you did not join the team/);
});

test('a code typed on the sign-up page is carried through and makes the plan free, and a wrong one makes nothing', async () => {
  const c = browser();
  const r = await signIn(c, 'google', google('cody@gmail.com'), { query: { mode: 'signup', code: ' growalition ' } });
  landed(r);
  const a = db.get('SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email=?', 'cody@gmail.com');
  assert.equal(a.promo_code, 'GROWalition');
  assert.equal(a.plan, 'grove');
  assert.ok(mailTo('cody@gmail.com').some((m) => /Code GROWalition accepted/.test(m.subject)));
  // A typo is said out loud and nothing is created, as at sign-up.
  const d = browser();
  const bad = await signIn(d, 'google', google('typo@gmail.com'), { query: { mode: 'signup', code: 'GROWalitoin' } });
  refused(bad, 'code', '/signup');
  assert.equal(bad.to.searchParams.get('code'), 'GROWalitoin', 'the box still holds what they typed');
  assert.equal(user('typo@gmail.com'), null);
  assert.equal(await whoIs(d), null);
  assert.match(signInErrorText('code'), /do not recognise that code, so no login was created/);
  // Someone who already has a login is signed in, and told the code was not used.
  const again = await signIn(browser(), 'google', google('rita@gmail.com'), { query: { mode: 'signup', code: 'GROWalition' } });
  landed(again);
  assert.equal(again.note.code_unused, true);
  assert.match(signInNotice(again.note), /The code was not used, because you already had a login\. You can add it under Settings, Plan\./);
  assert.equal(db.get('SELECT a.promo_code p FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email=?', 'rita@gmail.com').p, null);
});

test('signing in with a provider brings a closing login back, like signing in with the password', async () => {
  const c = await signUp('Clo Sing', 'clo@gmail.com', browser().ip);
  landed(await signIn(browser(), 'google', google('clo@gmail.com')));
  const closed = await c.post('/me/delete', { password: PW });
  assert.equal(closed.data.closed, 'scheduled');
  assert.ok(user('clo@gmail.com').closing_at);
  const back = browser();
  const r = await signIn(back, 'google', google('clo@gmail.com'));
  landed(r);
  assert.equal(r.note.restored, true);
  assert.equal(user('clo@gmail.com').closing_at, null);
  assert.equal(db.get("SELECT COUNT(*) n FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND a.closing_at IS NOT NULL", user('clo@gmail.com').id).n, 0);
  assert.equal((await whoIs(back)).email, 'clo@gmail.com');
});

test('someone removed from their only team gets a workspace when they sign in with a provider, and the workspace used last opens', async () => {
  const boss = await signUp('Bo Boss', 'bo@crew.example', browser().ip);
  assert.equal((await boss.post('/account/invites', { email: 'rem@gmail.com' })).status, 200);
  const tok = db.get('SELECT token FROM invites WHERE email=?', 'rem@gmail.com').token;
  const rem = browser();
  landed(await signIn(rem, 'google', google('rem@gmail.com', { name: 'Rem Oved' }), { query: { mode: 'signup', invite: tok } }));
  const id = (await whoIs(rem)).id;
  assert.equal(db.get("SELECT COUNT(*) n FROM credits c JOIN memberships m ON m.account_id=c.account_id WHERE m.user_id=? AND c.reason='welcome' AND m.role='owner'", id).n, 0);
  assert.equal((await boss.call('DELETE', `/account/members/${id}`)).status, 200);
  const again = browser();
  const r = await signIn(again, 'google', google('rem@gmail.com'));
  landed(r);
  assert.equal(r.note.fresh, true);
  assert.match(signInNotice(r.note), /no longer on a team, so we made you a workspace of your own/);
  const me = (await again.get('/me')).data;
  assert.equal(me.role, 'owner');
  assert.equal(me.account.name, "Rem's workspace");
  assert.equal(db.get("SELECT COALESCE(SUM(delta),0) n FROM credits WHERE account_id=? AND reason='welcome'", me.account.id).n, 3, 'with the welcome signatures, once');
  // Invited again and switched to their own workspace: the next sign-in opens the one used last.
  assert.equal((await boss.post('/account/invites', { email: 'rem@gmail.com' })).status, 200);
  const tok2 = db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL', 'rem@gmail.com').token;
  assert.equal((await again.post('/invites/accept', { token: tok2 })).status, 200);
  assert.equal((await again.post('/auth/switch', { account_id: me.account.id })).status, 200);
  const third = browser();
  landed(await signIn(third, 'google', google('rem@gmail.com')));
  assert.equal((await third.get('/me')).data.account.id, me.account.id);
  assert.equal(db.get("SELECT COUNT(*) n FROM credits c JOIN memberships m ON m.account_id=c.account_id WHERE m.user_id=? AND c.reason='welcome' AND m.role='owner'", id).n, 1);
});

test('after signing in the browser only ever goes to a path on this site', async () => {
  const outside = ['https://evil.example/app', '//evil.example', '/\\evil.example', '\\\\evil.example', '/\t/evil.example', '/\n/evil.example', 'javascript:alert(1)', 'evil.example', '/%0d%0aLocation: https://evil.example', ' /app', 'http:evil.example', '/' + 'a'.repeat(600)];
  for (const next of outside) {
    const r = await signIn(browser(), 'google', google('rita@gmail.com'), { query: { next } });
    assert.equal(r.status, 302);
    assert.equal(r.to.origin, 'http://test.local', next);
    assert.equal(r.to.pathname, '/signin/done', next);
    const kept = r.to.searchParams.get('next')!;
    assert.equal(new URL(kept, 'http://test.local').origin, 'http://test.local', next);
    assert.ok(!/evil\.example/.test(new URL(kept, 'http://test.local').host), next);
  }
  // A path on this site is kept, query and all.
  landed(await signIn(browser(), 'google', google('rita@gmail.com'), { query: { next: '/app/settings?tab=billing' } }), '/app/settings?tab=billing');
  // The same rule for what the landing page and the sign-in form do with ?next= themselves.
  for (const next of [...outside.filter((x) => !x.startsWith('/%0d')), undefined, null, 42, '']) assert.equal(safeNext(next), '/app', String(next));
  assert.equal(safeNext('/%0d%0aLocation: https://evil.example').startsWith('/%0d%0aLocation'), true, 'an encoded line break stays a harmless path');
  assert.equal(safeNext('/app/envelopes/env_1?x=1#sign'), '/app/envelopes/env_1?x=1#sign');
  assert.equal(safeNext('/app/../../evil.example'), '/evil.example', 'dots are resolved, and it is still a path here');
  // A refusal goes back to our own page too, whatever was asked for, and does not hand the address on to it.
  const no = await signIn(browser(), 'google', google('nobody@gmail.com'), { query: { next: '//evil.example' }, state: 'wrong' });
  assert.equal(no.to.origin, 'http://test.local');
  const stopped = browser();
  const begun = await go(stopped, '/auth/google/start?next=//evil.example');
  const stoppedAt = new URL((await go(stopped, `/auth/google/callback?${new URLSearchParams({ error: 'access_denied', state: new URL(begun.location).searchParams.get('state')! })}`)).location);
  assert.equal(stoppedAt.origin + stoppedAt.pathname, 'http://test.local/login');
  assert.equal(stoppedAt.searchParams.get('next'), null);
  const kept = browser();
  const begun2 = await go(kept, '/auth/google/start?next=/app/inbox');
  assert.equal(new URL((await go(kept, `/auth/google/callback?${new URLSearchParams({ error: 'access_denied', state: new URL(begun2.location).searchParams.get('state')! })}`)).location).searchParams.get('next'), '/app/inbox', 'a page of ours is kept for the next try');
  // And the start itself only ever sends the browser to the provider.
  const start = await go(browser(), '/auth/google/start?next=//evil.example&redirect_uri=https://evil.example/cb');
  assert.equal(new URL(start.location).origin, 'https://accounts.google.com');
  assert.equal(new URL(start.location).searchParams.get('redirect_uri'), 'http://test.local/api/auth/google/callback');
});

test('attempts on one address are limited, as for a password', async () => {
  await signUp('Lim Ited', 'lim@corp.example', browser().ip);
  let last: any;
  for (let i = 0; i < 12; i++) last = await signIn(browser(), 'microsoft', microsoft('lim@corp.example', { tid: OTHER_TENANT, oid: `guess-${i}` }));
  refused(last, 'busy');
  assert.match(signInErrorText('busy'), /Too many attempts\. Please wait a bit and try again\./);
  // The same counter as the password form, so the two together cannot be used to try more often.
  assert.equal((await browser().post('/auth/login', { email: 'lim@corp.example', password: PW })).status, 429);
});

// ---- Settings: ways to sign in -------------------------------------------------------------------

test('Settings lists the ways to sign in, and the last way in cannot be disconnected', async () => {
  const c = browser();
  landed(await signIn(c, 'google', google('gil@gmail.com')));
  let ways = (await c.get('/me/signin')).data;
  assert.equal(ways.password, false);
  assert.deepEqual(ways.providers.map((p: any) => [p.id, p.name, p.on, p.connected.length]), [['google', 'Google', true, 1], ['microsoft', 'Microsoft', true, 0]]);
  assert.equal(ways.providers[0].connected[0].email, 'gil@gmail.com');
  assert.ok(Date.parse(ways.providers[0].connected[0].since) > Date.now() - 60_000);
  // Google is the only way in: refused, with why and what to do first.
  const only = await c.call('DELETE', `/me/signin/${ways.providers[0].connected[0].id}`);
  assert.equal(only.status, 409);
  assert.equal(only.data.code, 'last_way_in');
  assert.match(only.data.error, /Google is the only way into this login, so it was not disconnected: you could never sign in again\. Set a password first.*or connect another way to sign in/);
  assert.equal(identities('gil@gmail.com').length, 1);
  // Changing a password that does not exist says how to get one. So does closing the account.
  const change = await c.post('/me/password', { current: '', password: 'a new password' });
  assert.equal(change.status, 400);
  assert.match(change.data.error, /has no password yet.*Email me a link to set a password.*gil@gmail\.com/);
  const close = await c.post('/me/delete', { password: '' });
  assert.equal(close.status, 400);
  assert.equal(close.data.code, 'no_password');
  assert.match(close.data.error, /this login has none yet because you sign in another way\. Set one first/);
  assert.equal(user('gil@gmail.com').closing_at, null);

  // A second way in: Microsoft, connected from Settings. Then Google can go.
  const m = await connect(c, 'microsoft', microsoft('gil@work.example'));
  assert.equal(m.location, 'http://test.local/app/settings?tab=profile&signin=connected&provider=microsoft');
  ways = (await c.get('/me/signin')).data;
  assert.equal(ways.providers[1].connected[0].email, 'gil@work.example');
  const told = mailTo('gil@gmail.com').filter((x) => /Microsoft can now open your/.test(x.subject));
  assert.equal(told.length, 1, 'the owner is told about a way in that was connected under Settings too');
  assert.match(told[0].html, /Signing in with Microsoft as gil@work\.example now opens the Sign&amp;Grow login of gil@gmail\.com/);
  assert.match(told[0].html, /It was connected under Settings, by someone who was signed in to your login/);
  assert.equal((await c.call('DELETE', `/me/signin/${ways.providers[0].connected[0].id}`)).status, 200);
  assert.deepEqual(identities('gil@gmail.com').map((i) => i.provider), ['microsoft']);
  // Microsoft now opens the login, although its address is another one: the connection is what counts.
  const viaMs = browser();
  landed(await signIn(viaMs, 'microsoft', microsoft('gil@work.example')));
  assert.equal((await whoIs(viaMs)).email, 'gil@gmail.com');
  // And now Microsoft is the last way in.
  const last = await c.call('DELETE', `/me/signin/${ways.providers[1].connected[0].id}`);
  assert.equal(last.status, 409);
  assert.match(last.data.error, /Microsoft is the only way into this login/);
  // Somebody else's connection cannot be removed, or even seen.
  const stranger = browser();
  landed(await signIn(stranger, 'google', google('other@gmail.com')));
  assert.equal((await stranger.call('DELETE', `/me/signin/${ways.providers[1].connected[0].id}`)).status, 404);
  assert.equal(identities('gil@gmail.com').length, 1);
});

test('a first password is set through a link to the mailbox, and then the provider can be disconnected', async () => {
  const c = browser();
  landed(await signIn(c, 'google', google('pia@gmail.com')));
  const link = await c.post('/me/signin/password-link');
  assert.equal(link.status, 200);
  assert.equal(link.data.sent_to, 'pia@gmail.com');
  const mail = mailTo('pia@gmail.com').filter((m) => /Choose a password for Sign/.test(m.subject)).at(-1)!;
  assert.match(mail.html, /has no password yet\. It is opened by signing in with Google\. With this link you choose a password/);
  assert.match(mail.html, /Signing in with Google keeps working as before/);
  assert.match(mail.html, /works for one hour\. If you did not ask for it, ignore this email and nothing changes/);
  // The "Forgot password" page sends the same email to someone who does not remember how they sign in.
  assert.equal((await browser().post('/auth/forgot', { email: 'pia@gmail.com' })).status, 200);
  assert.equal(mailTo('pia@gmail.com').filter((m) => /Choose a password for Sign/.test(m.subject)).length, 2);
  assert.equal(mailTo('pia@gmail.com').filter((m) => /Reset your Sign/.test(m.subject)).length, 0, 'it does not talk about resetting a password that never was');
  const reset = await browser().post('/auth/reset', { token: new URL(mail.link).searchParams.get('token'), password: PW });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.data.disconnected, [], 'the address was confirmed, so Google stays connected');
  const withPw = browser();
  assert.equal((await withPw.post('/auth/login', { email: 'pia@gmail.com', password: PW })).status, 200);
  const ways = (await withPw.get('/me/signin')).data;
  assert.equal(ways.password, true);
  landed(await signIn(browser(), 'google', google('pia@gmail.com')));
  // With a password there is another way in, so Google can be disconnected.
  assert.equal((await withPw.call('DELETE', `/me/signin/${ways.providers[0].connected[0].id}`)).status, 200);
  assert.equal(identities('pia@gmail.com').length, 0);
  // Someone who has a password is not sent a link to set one: they are told where to change it.
  const again = await withPw.post('/me/signin/password-link');
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already has a password.*change it on this page with your current password.*Forgot password/);
  // A person from a provider that does not vouch, whose address is not confirmed yet: first the confirmation, so
  // that setting a password does not cut off the only way they have in.
  const m = browser();
  landed(await signIn(m, 'microsoft', microsoft('una@corp.example')));
  const early = await m.post('/me/signin/password-link');
  assert.equal(early.status, 409);
  assert.equal(early.data.code, 'confirm_first');
  assert.match(early.data.error, /Confirm your email address first.*una@corp\.example.*would disconnect Microsoft from your login/);
  assert.equal((await new Client().post('/auth/verify', { token: user('una@corp.example').verify_token })).status, 200);
  assert.equal((await m.post('/me/signin/password-link')).status, 200);
  const una = mailTo('una@corp.example').filter((x) => /Choose a password for Sign/.test(x.subject)).at(-1)!;
  const done = await browser().post('/auth/reset', { token: new URL(una.link).searchParams.get('token'), password: PW });
  assert.deepEqual(done.data.disconnected, []);
  landed(await signIn(browser(), 'microsoft', microsoft('una@corp.example')));
});

test('connecting under Settings ties the provider to the login that is signed in, and to no other', async () => {
  const ann = await signUp('Ann Connect', 'ann@corp.example', browser().ip);
  const bea = await signUp('Bea Other', 'bea@corp.example', browser().ip);
  // Connecting needs our own page and a person: it starts with a POST, never a link another site can open.
  assert.equal((await go(ann, '/me/signin/google/connect')).status, 404);
  const crossSite = await ann.call('POST', '/me/signin/google/connect', {}, { origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
  assert.equal(db.get('SELECT COUNT(*) n FROM signin_states WHERE user_id=?', (await whoIs(ann)).id).n, 0, 'and nothing was started');
  const ok = await connect(ann, 'google', google('ann.private@gmail.com'));
  assert.equal(ok.to.searchParams.get('signin'), 'connected');
  assert.equal(identities('ann@corp.example')[0].vouched, 0, 'Google vouches for another address than this login has');
  assert.equal(user('ann.private@gmail.com'), null, 'no second login was made for the Google address');
  // Signing in with it now opens Ann's login.
  const viaGoogle = browser();
  landed(await signIn(viaGoogle, 'google', google('ann.private@gmail.com')));
  assert.equal((await whoIs(viaGoogle)).email, 'ann@corp.example');
  // Connecting it a second time changes nothing and sends no second email.
  await connect(ann, 'google', google('ann.private@gmail.com'));
  assert.equal(identities('ann@corp.example').length, 1);
  assert.equal(mailTo('ann@corp.example').filter((m) => /Google can now open your/.test(m.subject)).length, 1);
  // The same Google account cannot also open Bea's login.
  const taken = await connect(bea, 'google', google('ann.private@gmail.com'));
  assert.equal(taken.to.pathname, '/app/settings');
  assert.equal(taken.to.searchParams.get('signin_error'), 'taken');
  assert.equal(identities('bea@corp.example').length, 0);
  assert.match(signInErrorText('taken', 'google'), /already connected to another Sign&Grow login, so it was not connected to this one\. Sign in to the other login and disconnect it there first/);
  // Signed out, or signed in as somebody else, before the provider answered: nothing is connected to anyone.
  const gone = await connect(bea, 'microsoft', microsoft('bea@outlook.example'), () => bea.post('/auth/logout'));
  assert.equal(gone.to.pathname, '/login', 'someone who is signed out is sent to the sign-in page, where the words can be read');
  assert.equal(gone.to.searchParams.get('signin_error'), 'session');
  assert.equal(await whoIs(bea), null, 'and a connection never signs anyone in');
  assert.equal(identities('bea@corp.example').length, 0);
  const swapped = browser();
  assert.equal((await swapped.post('/auth/login', { email: 'bea@corp.example', password: PW })).status, 200);
  const sw = await connect(swapped, 'microsoft', microsoft('bea@outlook.example'), () => swapped.post('/auth/login', { email: 'ann@corp.example', password: PW }));
  assert.equal(sw.to.searchParams.get('signin_error'), 'session');
  assert.equal(db.get('SELECT COUNT(*) n FROM identities WHERE email=?', 'bea@outlook.example').n, 0, 'the Microsoft account went to neither of them');
  assert.match(signInErrorText('session', 'microsoft'), /no longer signed in to the same Sign&Grow login when Microsoft answered, so nothing was connected\. Sign in and try again/);
  // Connecting a provider that vouches for the login's own address confirms the address on the way.
  const raw = browser();
  assert.equal((await raw.post('/auth/signup', { name: 'Raw Recruit', email: 'raw@gmail.com', password: PW })).status, 200);
  assert.equal((await whoIs(raw)).email_verified, false);
  await connect(raw, 'google', google('raw@gmail.com'));
  assert.equal((await whoIs(raw)).email_verified, true);
});

test('an API key can do none of this', async () => {
  const c = await signUp('Kay Holder', 'keys@corp.example', browser().ip);
  await connect(c, 'google', google('keys@gmail.com'));
  const connectedId = identities('keys@corp.example')[0].id;
  for (const scope of ['send', 'admin']) {
    const key = (await c.post('/api-keys', { name: scope, scope })).data.key;
    const withKey = (method: string, url: string) => new Client().call(method, url, method === 'GET' ? undefined : {}, { authorization: `Bearer ${key}` });
    for (const [method, url] of [['GET', '/me/signin'], ['POST', '/me/signin/google/connect'], ['POST', '/me/signin/password-link'], ['DELETE', `/me/signin/${connectedId}`]]) {
      const r = await withKey(method, url);
      assert.equal(r.status, 403, `${scope} ${method} ${url}`);
      assert.match(r.data.error, /An API key cannot see or change the ways to sign in\. That needs a person signed in to the app\./);
    }
    // A key is not a person at the callback either: a connection started by the person is not finished by their key.
    const started = await c.post('/me/signin/microsoft/connect');
    const auth = new URL(started.data.url);
    const code = approve('microsoft', started.data.url, microsoft('keys@outlook.example'));
    const byKey = await go(Object.assign(new Client(), { cookies: { sg_signin: c.cookies.sg_signin } }), `/auth/microsoft/callback?${new URLSearchParams({ code, state: auth.searchParams.get('state')! })}`, { authorization: `Bearer ${key}` });
    assert.match(byKey.location, /signin_error=session/);
  }
  assert.deepEqual(identities('keys@corp.example').map((i) => i.provider), ['google']);
});

test('deleting a login takes its connections with it', async () => {
  const c = await signUp('Del Eted', 'del@gmail.com', browser().ip);
  landed(await signIn(browser(), 'google', google('del@gmail.com')));
  assert.equal(db.get('SELECT COUNT(*) n FROM identities WHERE email=?', 'del@gmail.com').n, 1);
  assert.equal((await c.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
  assert.equal(db.get('SELECT COUNT(*) n FROM identities WHERE email=?', 'del@gmail.com').n, 0);
  // The same Google account starts from nothing afterwards.
  const again = browser();
  const r = await signIn(again, 'google', google('del@gmail.com'));
  landed(r);
  assert.equal(r.note.created, 'Google');
});

// ---- Switched off ---------------------------------------------------------------------------------

test('a provider that is not configured does not exist: no route answers and the pages are told of no button', async () => {
  const signedIn = await signUp('Offa Switch', 'offa@corp.example', browser().ip);
  await connect(signedIn, 'google', google('offa@gmail.com'));
  const started = await go(browser(), '/auth/google/start');
  const state = new URL(started.location).searchParams.get('state')!;
  try {
    for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET']) delete process.env[k];
    assert.deepEqual((await browser().get('/auth/providers')).data, { providers: [] });
    for (const p of ['google', 'microsoft']) {
      assert.equal((await go(browser(), `/auth/${p}/start`)).status, 404);
      assert.equal((await go(browser(), `/auth/${p}/callback?code=x&state=${state}`)).status, 404);
      assert.equal((await signedIn.post(`/me/signin/${p}/connect`)).status, 404);
    }
    // Settings lists a provider only while it is on, or while a connection from before is still there to remove.
    const ways = (await signedIn.get('/me/signin')).data;
    assert.deepEqual(ways.providers.map((p: any) => [p.id, p.on, p.connected.length]), [['google', false, 1]]);
    assert.deepEqual((await (await signUp('Plain Pat', 'plain@corp.example', browser().ip)).get('/me/signin')).data.providers, []);
    // One value of the two is not enough.
    process.env.GOOGLE_CLIENT_ID = G.id;
    process.env.MICROSOFT_CLIENT_SECRET = M.secret;
    assert.deepEqual((await browser().get('/auth/providers')).data, { providers: [] });
    assert.equal((await go(browser(), '/auth/google/start')).status, 404);
    process.env.GOOGLE_CLIENT_SECRET = '   ';
    assert.deepEqual(signInProviders(), []);
    // One provider on, the other off.
    process.env.GOOGLE_CLIENT_SECRET = G.secret;
    assert.deepEqual((await browser().get('/auth/providers')).data, { providers: [{ id: 'google', name: 'Google' }] });
    assert.equal((await go(browser(), '/auth/microsoft/start')).status, 404);
    assert.equal((await go(browser(), '/auth/google/start')).status, 302);
  } finally {
    configure();
  }
  // Something that is not a provider at all.
  assert.equal((await go(browser(), '/auth/facebook/start')).status, 404);
  assert.equal((await go(browser(), '/auth/__proto__/start')).status, 404);
});

test('every way a sign-in can fail has words that say what happened and what to do, with no jargon', () => {
  for (const code of SIGNIN_ERRORS)
    for (const p of ['google', 'microsoft', 'something-else', undefined]) {
      const words = signInErrorText(code, p);
      assert.ok(words.length > 40, code);
      assert.doesNotMatch(words, /OAuth|OpenID|OIDC|token|nonce|state\b|JWT|claim|tenant|undefined|null|—/i, `${code}: ${words}`);
      if (p === 'something-else') assert.doesNotMatch(words, /something-else/, 'a provider name from the address bar is never printed');
    }
  assert.match(signInErrorText('made-up-code', 'google'), /Google did not confirm who you are/, 'an unknown code gets the general words');
  assert.match(signInErrorText('no_email', 'microsoft'), /Microsoft did not tell us an email address.*Create one with your email and a password instead/);
});
