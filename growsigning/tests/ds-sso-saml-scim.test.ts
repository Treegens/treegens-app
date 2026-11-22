// SAML 2.0 sign-in (src/server/saml.ts, routes-saml.ts) and members from a directory (SCIM 2.0, src/server/scim.ts,
// routes-scim.ts), against a stand-in identity provider made here: its key and certificate (tests/sealcerts.ts), its
// metadata, and SAML responses signed (or forged) in the test with xml-crypto, the library node-saml checks with.
// The DNS is a stub. Nothing reaches the network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

process.env.FILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
import { boot, Client, signUp, mailTo, simple } from './helpers.ts';
import { makeCert } from './sealcerts.ts';
import { SignedXml } from 'xml-crypto';

const { db } = await boot();
const { handle } = await import('../src/server/router.ts');
const orgsso = await import('../src/server/orgsso.ts');
const saml = await import('../src/server/saml.ts');
const en = JSON.parse((await import('node:fs')).readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));

// ---- DNS: the TXT records the test puts there ----------------------------------------------------------------------
const realTxt = orgsso.txt.lookup;
const dnsTxt = new Map<string, string[][]>();
orgsso.txt.lookup = async (name: string) => {
  const r = dnsTxt.get(name);
  if (!r) throw Object.assign(new Error('nothing'), { code: 'ENOTFOUND' });
  return r;
};
after(() => void (orgsso.txt.lookup = realTxt));

// ---- The stand-in identity provider --------------------------------------------------------------------------------
const IDP = 'https://idp.acme.test/saml';
const SSO_URL = 'https://idp.acme.test/sso';
const idpCert = makeCert({ cn: 'Acme IdP' });
const otherCert = makeCert({ cn: 'Somebody else' });
const certB64 = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
const metadata = (o: { cert?: string; binding?: string; location?: string; entity?: string } = {}) => `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${o.entity || IDP}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${o.cert || certB64(idpCert.pem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="${o.binding || 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'}" Location="${o.location || SSO_URL}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
type Answer = { requestId: string; email: string; audience?: string; recipient?: string; notOnOrAfter?: string; assertionId?: string; issuer?: string; nameId?: string; extra?: string };
const ctx = { entityId: '', acs: '' };
function assertionXml(a: Answer) {
  const id = a.assertionId || `_a${crypto.randomBytes(12).toString('hex')}`;
  const until = a.notOnOrAfter || iso(5 * 60_000);
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(-1000)}"><saml:Issuer>${a.issuer || IDP}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${a.nameId || a.email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${a.requestId}" NotOnOrAfter="${until}" Recipient="${a.recipient || ctx.acs}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${a.audience || ctx.entityId}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(-1000)}" SessionIndex="${id}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${a.email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Sam Acme</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>${a.extra || ''}</saml:Assertion>`;
}
function sign(xml: string, keyPem = idpCert.keyPem) {
  const sig = new SignedXml({ privateKey: keyPem, canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#', signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } });
  return sig.getSignedXml();
}
const responseXml = (requestId: string, assertion: string, inner = '') =>
  `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${iso(0)}" Destination="${ctx.acs}" InResponseTo="${requestId}"><saml:Issuer>${IDP}</saml:Issuer>${inner}<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
const b64 = (s: string) => Buffer.from(s).toString('base64');

/** The AuthnRequest id and RelayState in the address we send the browser to. */
function readRequest(location: string) {
  const u = new URL(location);
  assert.equal(`${u.origin}${u.pathname}`, SSO_URL);
  const xml = zlib.inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest')!, 'base64')).toString();
  const id = /ID="([^"]+)"/.exec(xml)![1];
  return { id, relay: u.searchParams.get('RelayState')!, xml };
}

let n = 0;
const browser = () => {
  const c = new Client();
  c.ip = `198.19.${Math.floor(n / 250) + 10}.${(n++ % 250) + 1}`;
  return c;
};
async function go(c: Client, url: string, init: RequestInit = {}) {
  const headers: any = { cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': c.ip, ...(init.headers || {}) };
  const res = await handle(new Request(`http://test.local/api${url}`, { ...init, headers }));
  for (const ck of res.headers.getSetCookie()) {
    const [kv] = ck.split(';');
    c.cookies[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  }
  const type = res.headers.get('content-type') || '';
  return { status: res.status, location: res.headers.get('location') || '', type, data: type.includes('json') ? await res.json() : await res.text() };
}
/** The identity provider's page posting its answer to us, from its own site: no cookies of ours go with it. */
const post = (relay: string | null, response: string) => {
  const body = new URLSearchParams({ SAMLResponse: b64(response), ...(relay !== null ? { RelayState: relay } : {}) });
  return go(new Client(), '/sso/saml/acs', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
};
/** Post, then follow to the finish in `c` (the browser that started). */
async function answer(c: Client, relay: string, response: string) {
  const acs = await post(relay, response);
  assert.equal(acs.status, 303, `${acs.status} ${acs.location}`);
  if (!new URL(acs.location).pathname.endsWith('/sso/saml/finish')) return { ...acs, to: new URL(acs.location) };
  const fin = await go(c, new URL(acs.location).pathname.replace(/^\/api/, '') + new URL(acs.location).search);
  return { ...fin, to: new URL(fin.location) };
}
const refusedWith = (r: any, code: string) => assert.equal(r.to.searchParams.get('sso_error'), code, r.location);
const lines = (accountId: string, kind: string) => db.all('SELECT * FROM security_events WHERE account_id=? AND kind=? ORDER BY seq', accountId, kind);

// ---- The organisation ---------------------------------------------------------------------------------------------

const owner = await signUp('Olive Owner', 'olive@acme.test', '198.19.1.1');
const ownerId = db.get("SELECT id FROM users WHERE email='olive@acme.test'").id;
const account = db.get("SELECT account_id a FROM memberships WHERE user_id=? AND role='owner'", ownerId).a;

async function claim(c: Client, domain: string) {
  const add = await c.post('/account/sso/domains', { domain });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  dnsTxt.set(`_${'growsigning'}.${domain}`, [[add.data.domain.record.value]]);
  const chk = await c.post(`/account/sso/domains/${add.data.domain.id}/check`, {});
  assert.equal(chk.data.found, 'found');
  return add.data.domain;
}

test('the card gives our two addresses, and our metadata is served at the entity id', async () => {
  const card = await owner.get('/account/sso');
  assert.equal(card.status, 200);
  assert.ok(card.data.saml.entity_id.startsWith('http://test.local/api/sso/saml/sp/'), card.data.saml.entity_id);
  assert.equal(card.data.saml.acs_url, 'http://test.local/api/sso/saml/acs');
  ctx.entityId = card.data.saml.entity_id;
  ctx.acs = card.data.saml.acs_url;
  const md = await go(new Client(), new URL(ctx.entityId).pathname.replace(/^\/api/, ''));
  assert.equal(md.status, 200);
  assert.match(md.type, /samlmetadata\+xml/);
  assert.ok(md.data.includes(`entityID="${ctx.entityId}"`) && md.data.includes(ctx.acs) && md.data.includes('WantAssertionsSigned="true"'), md.data);
  // An id we never made answers in words.
  const none = await go(new Client(), '/sso/saml/sp/nosuchspid12345');
  assert.equal(none.status, 404);
  assert.match(none.data.error, /no SAML set up at this address/);
});

test('metadata that cannot be used is refused, each time saying what to do', async () => {
  await claim(owner, 'acme.test');
  const bad = async (metadata: any, re: RegExp) => {
    const r = await owner.put('/account/sso/saml', { name: 'Acme', metadata });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, re);
    // Two sentences, and the second tells what to do.
    assert.ok(r.data.error.split('. ').length >= 2, r.data.error);
  };
  await bad('', /Paste the identity provider's metadata/);
  await bad('<html>hello</html>', /not SAML metadata/);
  await bad(`<!DOCTYPE x [<!ENTITY a "aaaa">]>${metadata()}`, /not SAML metadata/);
  await bad(metadata({ binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST' }), /HTTP-Redirect/);
  await bad(metadata({ location: 'http://idp.acme.test/sso' }), /https/);
  await bad(metadata({ cert: 'bm90IGEgY2VydA==' }), /certificate .* could not be read/);
  const old = makeCert({ cn: 'Old IdP', from: new Date('2019-01-01'), to: new Date('2020-01-01') });
  await bad(metadata({ cert: certB64(old.pem) }), /ended, the last on 2020-01-01/);
  await bad(`<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${metadata().replace(/^<\?xml[^>]*>/, '')}${metadata({ entity: 'https://two.test' }).replace(/^<\?xml[^>]*>/, '')}</md:EntitiesDescriptor>`, /describes 2 identity providers/);
  assert.equal(db.get('SELECT 1 x FROM org_idps WHERE account_id=?', account), null);
});

let tried = false;
test('SAML is saved, tried with success, and only then offered on the sign-in page', async () => {
  const r = await owner.put('/account/sso/saml', { name: 'Acme', metadata: metadata() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const card = await owner.get('/account/sso');
  assert.equal(card.data.service.kind, 'saml');
  assert.equal(card.data.service.has_secret, false);
  assert.equal(card.data.saml.idp.idp_entity_id, IDP);
  assert.equal(card.data.saml.idp.sso_url, SSO_URL);
  assert.equal(card.data.saml.idp.certificates.length, 1);
  // Not tried yet: the sign-in page knows nothing of it.
  assert.equal((await go(browser(), '/sso/lookup?email=sam%40acme.test')).data.sso, null);
  // An API key cannot change SAML (single sign-on decides who gets in).
  const key = await owner.post('/api-keys', { name: 'k', scope: 'admin' });
  const viaKey = await go(new Client(), '/account/sso/saml', { method: 'PUT', body: JSON.stringify({ name: 'X', metadata: metadata() }), headers: { authorization: `Bearer ${key.data.key}`, 'content-type': 'application/json' } });
  assert.equal(viaKey.status, 403);

  const t = await owner.post('/account/sso/try', {});
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const req = readRequest(t.data.url);
  assert.match(req.xml, /AssertionConsumerServiceURL="http:\/\/test\.local\/api\/sso\/saml\/acs"/);
  assert.ok(req.xml.includes(`<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${ctx.entityId}</saml:Issuer>`), req.xml);
  const back = await answer(owner, req.relay, responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'olive@acme.test' }))));
  assert.equal(back.to.pathname, '/app/settings');
  assert.equal(back.to.searchParams.get('sso'), 'tried', back.location);
  assert.ok(db.get('SELECT tested_at FROM org_idps WHERE account_id=?', account).tested_at);
  assert.equal(lines(account, 'sso.tested').length, 1);
  assert.equal((await go(browser(), '/sso/lookup?email=sam%40acme.test')).data.sso.name, 'Acme');
  tried = true;
});

/** "Continue with Acme sign-in" up to the identity provider. */
async function start(c: Client, email: string) {
  const s = await go(c, `/sso/start?${new URLSearchParams({ email })}`);
  assert.equal(s.status, 302, JSON.stringify(s.data));
  return readRequest(s.location);
}

test('a good answer signs the person in, once, in the browser that started', async () => {
  assert.ok(tried);
  const c = browser();
  const req = await start(c, 'sam@acme.test');
  const r = await answer(c, req.relay, responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'sam@acme.test' }))));
  assert.equal(r.to.pathname, '/signin/done', r.location);
  const u = db.get("SELECT * FROM users WHERE email='sam@acme.test'");
  assert.equal(u.name, 'Sam Acme');
  assert.ok(db.get("SELECT 1 x FROM identities WHERE user_id=? AND provider=? AND subject=?", u.id, `org:${account}`, `${IDP} sam@acme.test`));
  const me = await go(c, '/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'sam@acme.test');
});

test('an answer the browser did not start, or that another browser finishes, signs nobody in', async () => {
  // Started by the identity provider by itself: no RelayState of ours.
  const lone = await post(null, responseXml('_none', sign(assertionXml({ requestId: '_none', email: 'sam@acme.test' }))));
  assert.equal(lone.status, 303);
  assert.equal(new URL(lone.location).searchParams.get('sso_error'), 'expired');
  // Someone's real answer finished in another browser (a link sent to a victim): the cookie is missing.
  const c = browser();
  const req = await start(c, 'sam@acme.test');
  const acs = await post(req.relay, responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'sam@acme.test' }))));
  const other = browser();
  const fin = await go(other, new URL(acs.location).pathname.replace(/^\/api/, '') + new URL(acs.location).search);
  assert.equal(new URL(fin.location).searchParams.get('sso_error'), 'expired');
  assert.ok(!(await go(other, '/me')).data.user);
  // And the line is gone: the right browser cannot use it afterwards either.
  const late = await go(c, new URL(acs.location).pathname.replace(/^\/api/, '') + new URL(acs.location).search);
  assert.equal(new URL(late.location).searchParams.get('sso_error'), 'expired');
});

test('forged, wrapped, expired, replayed and misdirected answers are refused', async () => {
  const tryOne = async (make: (req: { id: string; relay: string }) => string) => {
    const c = browser();
    const req = await start(c, 'sam@acme.test');
    const r = await answer(c, req.relay, make(req));
    refusedWith(r, 'failed');
    assert.ok(!(await go(c, '/me')).data.user);
    return req;
  };
  // Not signed at all.
  await tryOne((req) => responseXml(req.id, assertionXml({ requestId: req.id, email: 'sam@acme.test' })));
  // Signed with a key that is not in the metadata.
  await tryOne((req) => responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'sam@acme.test' }), otherCert.keyPem)));
  // Signed, then changed: the address of someone else put in.
  await tryOne((req) => responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'sam@acme.test' })).replace(/sam@acme\.test/g, 'olive@acme.test')));
  // Signature wrapping: the signed assertion hidden in Extensions, an unsigned one of the owner's beside it.
  await tryOne((req) => {
    const good = sign(assertionXml({ requestId: req.id, email: 'sam@acme.test' }));
    const evil = assertionXml({ requestId: req.id, email: 'olive@acme.test', assertionId: /ID="([^"]+)"/.exec(good)![1] });
    return responseXml(req.id, evil, `<samlp:Extensions>${good}</samlp:Extensions>`);
  });
  // Wrapping the other way: an unsigned assertion of the owner's, with the signed one inside it.
  await tryOne((req) => {
    const good = sign(assertionXml({ requestId: req.id, email: 'sam@acme.test' }));
    return responseXml(req.id, assertionXml({ requestId: req.id, email: 'olive@acme.test', extra: `<saml:Advice>${good}</saml:Advice>` }));
  });
  // Expired an hour ago.
  await tryOne((req) => responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'sam@acme.test', notOnOrAfter: iso(-3600_000) }))));
  // For another service (audience), or posted somewhere else (recipient).
  await tryOne((req) => responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'sam@acme.test', audience: 'https://other.example/sp' }))));
  await tryOne((req) => responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'sam@acme.test', recipient: 'https://other.example/acs' }))));
  // From another identity provider's name.
  await tryOne((req) => responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'sam@acme.test', issuer: 'https://evil.test' }))));
  // An answer to another request of the same account: request A answered with B's RelayState.
  const a = await start(browser(), 'sam@acme.test');
  await tryOne((req) => responseXml(a.id, sign(assertionXml({ requestId: a.id, email: 'sam@acme.test' }))));
  // Replay: an assertion accepted once is refused after, even inside an answer to a new request.
  const c = browser();
  const first = await start(c, 'sam@acme.test');
  const assertionId = `_replay${crypto.randomBytes(6).toString('hex')}`;
  const ok = await answer(c, first.relay, responseXml(first.id, sign(assertionXml({ requestId: first.id, email: 'sam@acme.test', assertionId }))));
  assert.equal(ok.to.pathname, '/signin/done', ok.location);
  // The very same post again: its request was used.
  const again = await post(first.relay, responseXml(first.id, sign(assertionXml({ requestId: first.id, email: 'sam@acme.test', assertionId }))));
  assert.equal(new URL(again.location).searchParams.get('sso_error'), 'expired');
  await tryOne((req) => responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'sam@acme.test', assertionId }))));
  assert.ok(db.get('SELECT 1 x FROM saml_seen WHERE key LIKE ?', `%${assertionId}%`));
});

test('an address outside the claimed domains, or none at all, is refused in words', async () => {
  const c = browser();
  const req = await start(c, 'sam@acme.test');
  const r = await answer(c, req.relay, responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'sam@elsewhere.test' }))));
  refusedWith(r, 'domain');
  const c2 = browser();
  const req2 = await start(c2, 'sam@acme.test');
  const r2 = await answer(c2, req2.relay, responseXml(req2.id, sign(assertionXml({ requestId: req2.id, email: 'not-an-address', nameId: 'abc123' }))));
  refusedWith(r2, 'failed');
});

test('new certificates of the same provider keep it tried; another provider needs a new try, and not while enforced', async () => {
  const next = makeCert({ cn: 'Acme IdP 2' });
  const both = metadata().replace('</md:KeyDescriptor>', `</md:KeyDescriptor><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certB64(next.pem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`);
  assert.equal((await owner.put('/account/sso/saml', { metadata: both })).status, 200);
  assert.ok(db.get('SELECT tested_at FROM org_idps WHERE account_id=?', account).tested_at);
  assert.equal(JSON.parse(lines(account, 'sso.changed').slice(-1)[0].details).certificates_replaced, true);
  // Signed with the new key: works.
  const c = browser();
  const req = await start(c, 'sam@acme.test');
  assert.equal((await answer(c, req.relay, responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'sam@acme.test' }), next.keyPem)))).to.pathname, '/signin/done');
  // Back to the first metadata for the rest.
  assert.equal((await owner.put('/account/sso/saml', { metadata: metadata() })).status, 200);
  // While everyone must sign in through it, another entity id is refused.
  db.run('UPDATE org_idps SET enforce=1 WHERE account_id=?', account);
  const moved = await owner.put('/account/sso/saml', { metadata: metadata({ entity: 'https://idp2.acme.test' }) });
  assert.equal(moved.status, 409);
  db.run('UPDATE org_idps SET enforce=0 WHERE account_id=?', account);
});

// ---- Members from your directory ----------------------------------------------------------------------------------

const BASE = '/scim/v2';
let scimToken = '';
const dir = (method: string, path: string, body?: any, tokenText = scimToken) =>
  go(new Client(), `${BASE}${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), headers: { authorization: `Bearer ${tokenText}`, 'content-type': 'application/scim+json' } });
const user = (email: string, more: any = {}) => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: email, name: { givenName: 'Pat', familyName: 'Person' }, emails: [{ value: email, primary: true }], active: true, ...more });
const isMember = (email: string) => !!db.get('SELECT 1 x FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND u.email=?', account, email);

test('the directory needs single sign-on first, and a person signed in to make its token', async () => {
  // Another account without single sign-on is told what to do first.
  const other = await signUp('Nora Nobody', 'nora@nowhere.test', '198.19.1.2');
  const r = await other.post('/account/directory/token', {});
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Set up single sign-on first/);
  assert.equal((await other.get('/account/directory')).data.offered, false);
  const key = await owner.post('/api-keys', { name: 'k2', scope: 'admin' });
  const viaKey = await go(new Client(), '/account/directory/token', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${key.data.key}`, 'content-type': 'application/json' } });
  assert.equal(viaKey.status, 403);
  const made = await owner.post('/account/directory/token', {});
  assert.equal(made.status, 200, JSON.stringify(made.data));
  scimToken = made.data.token;
  assert.match(scimToken, /^tss_/);
  assert.equal(made.data.directory.base_url, 'http://test.local/api/scim/v2');
  // Only its fingerprint is kept, and the card never shows it again.
  assert.equal(db.get('SELECT token_hash FROM org_directory WHERE account_id=?', account).token_hash, crypto.createHash('sha256').update(scimToken).digest('hex'));
  assert.ok(!JSON.stringify((await owner.get('/account/directory')).data).includes(scimToken));
  assert.equal(lines(account, 'directory.token_made').length, 1);
});

test('a wrong, missing or old token is refused in SCIM form', async () => {
  for (const t of ['', 'tss_wrong', 'tsk_notascimtoken']) {
    const r = await dir('GET', '/Users', undefined, t);
    assert.equal(r.status, 401);
    assert.match(r.type, /application\/scim\+json/);
    assert.deepEqual(r.data.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
    assert.equal(r.data.status, '401');
  }
  // A new token replaces the old one at once.
  const old = scimToken;
  scimToken = (await owner.post('/account/directory/token', {})).data.token;
  assert.equal((await dir('GET', '/Users', undefined, old)).status, 401);
  assert.equal((await dir('GET', '/Users')).status, 200);
  assert.equal((await dir('GET', '/ServiceProviderConfig')).data.patch.supported, true);
  assert.equal((await dir('GET', '/Groups')).status, 404);
});

test('create: someone with a login joins at once; someone without joins at their first sign-in; nobody outside the domains', async () => {
  const bea = await signUp('Bea Acme', 'bea@acme.test', '198.19.1.3');
  const made = await dir('POST', '/Users', user('Bea@Acme.test', { externalId: 'okta-1' }));
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.userName, 'bea@acme.test');
  assert.equal(made.data.active, true);
  assert.ok(isMember('bea@acme.test'));
  assert.equal(db.get("SELECT role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND u.email='bea@acme.test'", account).role, 'member');
  assert.ok(mailTo('bea@acme.test').some((m: any) => /You were added to/.test(m.subject)));
  assert.equal(JSON.parse(lines(account, 'member.joined').slice(-1)[0].details).by_directory, true);
  void bea;
  // The same person again.
  const twice = await dir('POST', '/Users', user('bea@acme.test'));
  assert.equal(twice.status, 409);
  assert.equal(twice.data.scimType, 'uniqueness');
  // Outside the claimed domains.
  const out = await dir('POST', '/Users', user('eve@evil.test'));
  assert.equal(out.status, 400);
  assert.match(out.data.detail, /not one of this account's claimed email domains/);
  // No login yet: waits, and joins on the first sign-in through the service, though join_new is off.
  assert.equal(db.get('SELECT join_new FROM org_idps WHERE account_id=?', account).join_new, 0);
  const cy = await dir('POST', '/Users', user('cy@acme.test'));
  assert.equal(cy.status, 201);
  assert.equal(isMember('cy@acme.test'), false);
  const c = browser();
  const req = await start(c, 'cy@acme.test');
  const r = await answer(c, req.relay, responseXml(req.id, sign(assertionXml({ requestId: req.id, email: 'cy@acme.test' }))));
  assert.equal(r.to.pathname, '/signin/done', r.location);
  assert.ok(isMember('cy@acme.test'));
});

test('read and filter', async () => {
  const all = await dir('GET', '/Users');
  assert.equal(all.data.totalResults, 2);
  const one = await dir('GET', `/Users?${new URLSearchParams({ filter: 'userName eq "BEA@acme.test"' })}`);
  assert.equal(one.data.totalResults, 1);
  assert.equal(one.data.Resources[0].userName, 'bea@acme.test');
  const byExt = await dir('GET', `/Users?${new URLSearchParams({ filter: 'externalId eq "okta-1"' })}`);
  assert.equal(byExt.data.Resources[0].userName, 'bea@acme.test');
  assert.equal((await dir('GET', `/Users?${new URLSearchParams({ filter: 'userName eq "nobody@acme.test"' })}`)).data.totalResults, 0);
  const odd = await dir('GET', `/Users?${new URLSearchParams({ filter: 'name.givenName sw "P"' })}`);
  assert.equal(odd.status, 400);
  assert.equal(odd.data.scimType, 'invalidFilter');
  const got = await dir('GET', `/Users/${one.data.Resources[0].id}`);
  assert.equal(got.data.name.givenName, 'Pat');
  assert.equal((await dir('GET', '/Users/scim_nope')).status, 404);
  // Another account's token sees none of these.
  const page = await dir('GET', '/Users?count=1&startIndex=2');
  assert.equal(page.data.itemsPerPage, 1);
  assert.equal(page.data.startIndex, 2);
});

test('update: names change, the address cannot, and nobody is made more than a member', async () => {
  const id = (await dir('GET', `/Users?${new URLSearchParams({ filter: 'userName eq "bea@acme.test"' })}`)).data.Resources[0].id;
  db.run("UPDATE memberships SET role='admin' WHERE account_id=? AND user_id=(SELECT id FROM users WHERE email='bea@acme.test')", account);
  const put = await dir('PUT', `/Users/${id}`, user('bea@acme.test', { name: { givenName: 'Beatrix', familyName: 'Acme' }, displayName: 'Beatrix Acme' }));
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.displayName, 'Beatrix Acme');
  // The directory never changes a role.
  assert.equal(db.get("SELECT role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND u.email='bea@acme.test'", account).role, 'admin');
  db.run("UPDATE memberships SET role='member' WHERE account_id=? AND user_id=(SELECT id FROM users WHERE email='bea@acme.test')", account);
  const rename = await dir('PATCH', `/Users/${id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'userName', value: 'other@acme.test' }] });
  assert.equal(rename.status, 400);
  assert.match(rename.data.detail, /remove them in the directory and add them again/);
});

test('deactivate removes the person the way an admin would: their work passes on, keys stop, everyone is told', async () => {
  const bea = new Client();
  bea.ip = '198.19.1.3';
  // Bea signs in with her password (single sign-on is not required) and sends something.
  assert.equal((await bea.post('/auth/login', { email: 'bea@acme.test', password: 'correct horse battery' })).status, 200);
  const sw = await bea.post('/auth/switch', { account_id: account });
  assert.equal(sw.status, 200, JSON.stringify(sw.data));
  const env = await simple(bea, 'zed@example.com');
  const k = await bea.post('/api-keys', { name: 'bea key', scope: 'send' });
  assert.equal(k.status, 200, JSON.stringify(k.data));
  const id = (await dir('GET', `/Users?${new URLSearchParams({ filter: 'userName eq "bea@acme.test"' })}`)).data.Resources[0].id;
  // Microsoft Entra sends "False" as a string, with no path.
  const off = await dir('PATCH', `/Users/${id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', value: { active: 'False' } }] });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.active, false);
  assert.equal(isMember('bea@acme.test'), false);
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', env.id).sender_id, ownerId);
  assert.ok(db.get("SELECT stopped_at FROM api_keys WHERE account_id=? AND name='bea key'", account).stopped_at);
  assert.notEqual((await bea.get(`/envelopes/${env.id}`)).status, 200);
  assert.ok(mailTo('bea@acme.test').some((m: any) => /You were removed from/.test(m.subject)));
  assert.ok(mailTo('olive@acme.test').some((m: any) => /API keys stopped working/.test(m.subject)));
  const line = lines(account, 'member.removed').slice(-1)[0];
  assert.equal(line.actor_type, 'system');
  assert.deepEqual({ ...JSON.parse(line.details), handed_to: 'x' }, { role: 'member', keys_stopped: 1, handed_over: 1, handed_to: 'x', by_directory: true });
  assert.ok(lines(account, 'directory.person_removed').length >= 1);
  // Switched on again: a member again.
  const on = await dir('PATCH', `/Users/${id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: true }] });
  assert.equal(on.data.active, true);
  assert.ok(isMember('bea@acme.test'));
});

test('an admin can choose who takes over; delete removes the person and the record of them', async () => {
  const cyId = db.get("SELECT id FROM users WHERE email='cy@acme.test'").id;
  db.run("UPDATE memberships SET role='admin' WHERE account_id=? AND user_id=?", account, cyId);
  const set = await owner.call('PATCH', '/account/directory', { heir_id: cyId });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(set.data.directory.heir.name, 'Sam Acme');
  // Nobody outside the team can be chosen.
  assert.equal((await owner.call('PATCH', '/account/directory', { heir_id: 'usr_nobody' })).status, 400);
  const beaId = db.get("SELECT id FROM users WHERE email='bea@acme.test'").id;
  const env = db.get('SELECT id FROM envelopes WHERE account_id=? ORDER BY created_at DESC LIMIT 1', account);
  db.run('UPDATE envelopes SET sender_id=? WHERE id=?', beaId, env.id);
  const id = (await dir('GET', `/Users?${new URLSearchParams({ filter: 'userName eq "bea@acme.test"' })}`)).data.Resources[0].id;
  const del = await dir('DELETE', `/Users/${id}`);
  assert.equal(del.status, 204);
  assert.equal(isMember('bea@acme.test'), false);
  assert.equal(db.get('SELECT sender_id FROM envelopes WHERE id=?', env.id).sender_id, cyId, JSON.stringify({ owner: ownerId, bea: beaId, line: lines(account, 'member.removed').slice(-1)[0] }));
  assert.equal((await dir('GET', `/Users/${id}`)).status, 404);
  // The login itself stays: only the membership went.
  assert.ok(db.get("SELECT 1 x FROM users WHERE email='bea@acme.test'"));
});

test('the owner is never removed by the directory', async () => {
  const made = await dir('POST', '/Users', user('olive@acme.test'));
  assert.equal(made.status, 201);
  const off = await dir('PATCH', `/Users/${made.data.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] });
  assert.equal(off.status, 409);
  assert.match(off.data.detail, /owns the account/);
  assert.ok(isMember('olive@acme.test'));
  assert.equal((await dir('GET', `/Users/${made.data.id}`)).data.active, true);
  assert.equal((await dir('DELETE', `/Users/${made.data.id}`)).status, 409);
  assert.ok(isMember('olive@acme.test'));
});

test('"Members are managed by your directory" stops invitations by hand, and stopping the directory lifts it', async () => {
  const on = await owner.call('PATCH', '/account/directory', { managed: true });
  assert.equal(on.status, 200);
  assert.equal((await owner.get('/account/members')).data.managed_by_directory, true);
  const inv = await owner.post('/account/invites', { email: 'dee@acme.test' });
  assert.equal(inv.status, 409);
  assert.match(inv.data.error, /managed by your organisation's directory/);
  assert.equal((await owner.call('PATCH', '/account/directory', { managed: 'yes' })).status, 400);
  const stop = await owner.call('DELETE', '/account/directory/token', {});
  assert.equal(stop.status, 200);
  assert.equal((await dir('GET', '/Users')).status, 401);
  assert.equal((await owner.get('/account/members')).data.managed_by_directory, false);
  assert.equal((await owner.post('/account/invites', { email: 'dee@acme.test' })).status, 200);
  assert.equal(lines(account, 'directory.token_removed').length, 1);
  assert.ok(lines(account, 'directory.changed').length >= 2);
});

test('every new security line has words, and every new refusal says what to do', () => {
  for (const k of ['directory.token_made', 'directory.token_removed', 'directory.changed', 'directory.person_added', 'directory.person_removed']) assert.ok(en[`security.kind.${k}`], k);
  for (const [k, v] of Object.entries<string>(en)) {
    if (!/^(saml\.err|directory\.err)\./.test(k)) continue;
    assert.ok(!v.includes('\u2014'), k);
    const parts = v.split(/(?<=\.) /);
    assert.ok(parts.length >= 2, `${k}: ${v}`);
  }
  // No em dash anywhere in what this feature added.
  for (const [k, v] of Object.entries<string>(en)) if (/^(saml|directory)\./.test(k)) assert.ok(!v.includes('\u2014'), k);
  void saml;
});

// ---- After the review: who may run the directory, the owner sent switched off, a paused directory, why a try failed

const PW = 'correct horse battery';
async function joinAs(name: string, email: string, ip: string, role: string) {
  const inv = await owner.post('/account/invites', { email, role });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  const c = new Client();
  c.ip = ip;
  const tokenOf = db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL ORDER BY created_at DESC', email).token;
  const r = await c.post('/auth/signup', { name, email, password: PW, invite: tokenOf });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  db.run('UPDATE users SET email_verified=1 WHERE email=?', email);
  return c;
}

test('a role an admin made never runs the directory, with or without Team, so it cannot remove admins through it', async () => {
  const noTeam = (await owner.post('/account/roles', { name: 'Settings person', base: 'admin', left_out: ['team'] })).data.role;
  const withTeam = (await owner.post('/account/roles', { name: 'Admin without keys', base: 'admin', left_out: ['api_keys'] })).data.role;
  assert.ok(noTeam && withTeam);
  const sid = await joinAs('Sid Settings', 'sid@acme.test', '198.19.2.1', noTeam.id);
  const tia = await joinAs('Tia Team', 'tia@acme.test', '198.19.2.2', withTeam.id);
  await joinAs('Adam Admin', 'adam@acme.test', '198.19.2.3', 'admin');
  for (const c of [sid, tia]) {
    const made = await c.post('/account/directory/token', {});
    assert.equal(made.status, 403, JSON.stringify(made.data));
    assert.ok(!made.data.token);
    assert.equal((await c.call('PATCH', '/account/directory', { managed: true })).status, 403);
    assert.equal((await c.call('DELETE', '/account/directory/token', {})).status, 403);
  }
  // The one with Team is told why, in words; the card is not offered to them.
  const told = await tia.post('/account/directory/token', {});
  assert.equal(told.data.code, 'role_too_narrow');
  assert.match(told.data.error, /^Nothing was changed, because only the owner or someone with the built-in Admin role/);
  assert.equal((await tia.get('/account/directory')).data.may_change, false);
  assert.equal(db.get('SELECT token_hash FROM org_directory WHERE account_id=?', account)?.token_hash || null, null);
  // The owner and a built-in admin can.
  assert.equal((await owner.get('/account/directory')).data.may_change, true);
  const adam = new Client();
  adam.ip = '198.19.2.3';
  assert.equal((await adam.post('/auth/login', { email: 'adam@acme.test', password: PW })).status, 200);
  await adam.post('/auth/switch', { account_id: account });
  const made = await adam.post('/account/directory/token', {});
  assert.equal(made.status, 200, JSON.stringify(made.data));
  scimToken = made.data.token;
  assert.ok(isMember('adam@acme.test'));
});

test('the owner sent switched off is refused before anything is kept, so a retry gets the same answer', async () => {
  db.run("DELETE FROM scim_users WHERE account_id=? AND user_name='olive@acme.test'", account);
  const before = lines(account, 'directory.person_added').length;
  for (let i = 0; i < 2; i++) {
    const r = await dir('POST', '/Users', user('olive@acme.test', { active: false }));
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.scimType, 'mutability');
    assert.match(r.data.detail, /owns the account/);
  }
  assert.ok(!db.get("SELECT 1 x FROM scim_users WHERE account_id=? AND user_name='olive@acme.test'", account));
  assert.equal(lines(account, 'directory.person_added').length, before);
  assert.ok(isMember('olive@acme.test'));
});

test('a failed SAML try tells the admin why and what to change; a person signing in is not told', async () => {
  const tryWith = async (make: (id: string) => string) => {
    const t = await owner.post('/account/sso/try', {});
    assert.equal(t.status, 200, JSON.stringify(t.data));
    const req = readRequest(t.data.url);
    const acs = await post(req.relay, make(req.id));
    assert.equal(acs.status, 303);
    const to = new URL(acs.location);
    assert.equal(to.pathname, '/app/settings');
    assert.equal(to.searchParams.get('sso_error'), 'failed');
    return to.searchParams.get('sso_why');
  };
  // The provider signs only the Response, not the assertion (the most usual first-day mistake).
  const signResponse = (xml: string) => {
    const sig = new SignedXml({ privateKey: idpCert.keyPem, canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#', signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' });
    sig.addReference({ xpath: "//*[local-name(.)='Response']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
    sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } });
    return sig.getSignedXml();
  };
  assert.equal(await tryWith((id) => signResponse(responseXml(id, assertionXml({ requestId: id, email: 'olive@acme.test' })))), 'unsigned');
  assert.equal(await tryWith((id) => responseXml(id, sign(assertionXml({ requestId: id, email: 'olive@acme.test', audience: 'https://someone-else.test' })))), 'audience');
  assert.equal(await tryWith((id) => responseXml(id, sign(assertionXml({ requestId: id, email: 'olive@acme.test', recipient: 'https://elsewhere.test/acs' })))), 'recipient');
  const noMail = (id: string) => responseXml(id, sign(assertionXml({ requestId: id, email: 'olive@acme.test' }).replace(/<saml:AttributeStatement>.*<\/saml:AttributeStatement>/, '').replace(/>olive@acme\.test<\/saml:NameID>/, '>u-123</saml:NameID>')));
  assert.equal(await tryWith(noMail), 'no_email');
  // Each reason has words that say what happened first, then what to do, with no em dash.
  const { SAML_WHY, samlWhyOf } = await import('../src/lib/samlscim.ts');
  for (const k of SAML_WHY) {
    const v = en[`saml.why.${k}`];
    assert.ok(v && v.startsWith('The sign-in did not work, because') && !v.includes('—'), k);
  }
  assert.equal(samlWhyOf('SAML assertion audience mismatch. Expected: x'), 'audience');
  assert.equal(samlWhyOf('Invalid signature'), 'unsigned');
  assert.equal(samlWhyOf('SAML assertion expired: clocks skewed too much'), 'clock');
  assert.equal(samlWhyOf('Bad status code: Requester'), 'refused');
  // Still tried: a failed try does not undo the good one.
  assert.ok(db.get('SELECT tested_at FROM org_idps WHERE account_id=?', account).tested_at);
  // A person signing in from the sign-in page gets the short answer and no reason.
  const c = browser();
  const req = await start(c, 'sam@acme.test');
  const r = await post(req.relay, signResponse(responseXml(req.id, assertionXml({ requestId: req.id, email: 'sam@acme.test' }))));
  const to = new URL(r.location);
  assert.equal(to.pathname, '/login');
  assert.equal(to.searchParams.get('sso_error'), 'failed');
  assert.equal(to.searchParams.get('sso_why'), null);
});

test('removing single sign-on pauses the directory, and invitations by hand work again at once', async () => {
  assert.equal((await owner.call('PATCH', '/account/directory', { managed: true })).status, 200);
  assert.equal((await owner.post('/account/invites', { email: 'gil@acme.test' })).status, 409);
  const off = await owner.call('DELETE', '/account/sso', {});
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal((await owner.get('/account/members')).data.managed_by_directory, false);
  assert.equal((await owner.post('/account/invites', { email: 'gil@acme.test' })).status, 200);
  const view = (await owner.get('/account/directory')).data;
  assert.equal(view.offered, false);
  assert.ok(view.token, 'the token stays, so the card can say the directory is paused');
  assert.ok(en['directory.paused']);
  assert.equal((await dir('GET', '/Users')).status, 403);
});
