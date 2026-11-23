// The rules for making an account (src/lib/signup.ts, src/server/signuprules.ts): no "+" in the address of a new
// login on every path that makes or moves one, one login per mailbox, and a phone number: read per country, one login
// per number, asked of Google and Microsoft logins before the app opens, asked once of logins from before the rule,
// seen by operators only, exported with its owner's login and deleted with it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { boot, Client, signUp, simple, mailTo, nextPhone } from './helpers.ts';
import { plusInEmail, mailboxKey, parsePhone, guessCountry, phoneProblemText, showPhone, PLUS_REFUSAL, PLUS_INVITE_REFUSAL, PHONE_TAKEN, PHONE_WHY, PHONE_COUNTRIES } from '../src/lib/signup.ts';
import { signInErrorText, SIGNIN_ERRORS } from '../src/lib/signin.ts';

const G = { id: 'rules.apps.google.test', secret: 'google-secret' };
const M = { id: '0f0f0f0f-aaaa-4bbb-8ccc-343434343434', secret: 'microsoft-secret' };
Object.assign(process.env, { GOOGLE_CLIENT_ID: G.id, GOOGLE_CLIENT_SECRET: G.secret, MICROSOFT_CLIENT_ID: M.id, MICROSOFT_CLIENT_SECRET: M.secret, OPERATOR_EMAILS: 'olga@ops.example' });
delete process.env.SIGNUP_PHONE;

const { db } = await boot();
const { handle } = await import('../src/server/router.ts');
const { phoneRequired, phoneState } = await import('../src/server/signuprules.ts');
const { exportEntries } = await import('../src/server/exportfull.ts');
const ROOT = path.resolve(import.meta.dirname, '..');
const PW = 'correct horse battery';

let n = 0;
const ip = () => `198.18.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
// A browser that sends exactly what the test says: no phone number is filled in for it.
const bare = () => {
  const c = new Client();
  c.autoPhone = false;
  c.ip = ip();
  return c;
};
const join = (c: Client, body: any) => c.post('/auth/signup', { name: 'Nia New', password: PW, ...body });
const user = (email: string) => db.get('SELECT * FROM users WHERE email=?', email);
const rawPhone = (email: string) => (db.db().prepare('SELECT phone FROM users WHERE email=?').get(email) as any)?.phone;

// ---- 1. The email address ---------------------------------------------------------------------------

test('the words: one kind sentence for the + rule, and why the phone number is asked', () => {
  assert.equal(PLUS_REFUSAL, 'Please use your email address without the + part.');
  assert.match(PHONE_WHY, /keep accounts real/);
  assert.match(PHONE_WHY, /reach you about your account/);
  assert.match(PHONE_WHY, /never shared/i);
  assert.match(PHONE_WHY, /never used for marketing calls or texts/);
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/locales/en.json'), 'utf8'));
  assert.equal(en['auth.plus_email'], PLUS_REFUSAL, 'the page says what the server says');
  assert.match(en['phone.why'], /Never shared, never used for marketing calls or texts/);
  assert.equal(en['phone.title'], 'One more thing');
  const DASH = String.fromCharCode(0x2014);
  for (const f of ['src/lib/signup.ts', 'src/server/signuprules.ts', 'src/components/PhoneField.tsx', 'src/components/PhoneRequired.tsx', 'src/app/app/operator/people.tsx', 'tests/signup-rules.test.ts'])
    assert.ok(!fs.readFileSync(path.join(ROOT, f), 'utf8').includes(DASH), `${f} has no em dash`);
});

test('what counts as a + and as the same mailbox', () => {
  assert.equal(plusInEmail('ann+work@example.com'), true);
  assert.equal(plusInEmail('ann@example.com'), false);
  assert.equal(plusInEmail('ann@ex+ample.com'), false, 'only the part before the @ counts');
  assert.equal(mailboxKey('Ann.Lee@GoogleMail.com'), 'annlee@gmail.com');
  assert.equal(mailboxKey('annlee@gmail.com'), 'annlee@gmail.com');
  assert.equal(mailboxKey('a.n.n.lee@gmail.com'), 'annlee@gmail.com');
  assert.equal(mailboxKey('Ann.Lee@Example.com'), 'ann.lee@example.com', 'dots at another mail service can be two people');
  assert.equal(mailboxKey('ann+x@example.com'), 'ann@example.com');
});

test('sign-up refuses an address with a + in one sentence, and makes nothing', async () => {
  const c = bare();
  const r = await join(c, { email: 'plus+one@rules.example', phone: nextPhone() });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, PLUS_REFUSAL);
  assert.equal(r.data.code, 'plus_in_email');
  assert.equal(user('plus+one@rules.example'), null);
  // The same address without the + part is welcome.
  assert.equal((await join(c, { email: 'plus@rules.example', phone: nextPhone() })).status, 200);
  assert.equal(user('plus@rules.example').email_key, 'plus@rules.example');
});

test('one login per mailbox: capital letters, dots at Gmail and googlemail are the same person', async () => {
  assert.equal((await join(bare(), { email: 'Dot.Ty.Example@gmail.com', phone: nextPhone() })).status, 200);
  assert.ok(user('dot.ty.example@gmail.com'), 'kept as typed, in small letters');
  for (const again of ['dottyexample@gmail.com', 'd.o.t.t.y.example@gmail.com', 'dot.ty.example@googlemail.com', 'DOTTYEXAMPLE@GMAIL.COM']) {
    const r = await join(bare(), { email: again, phone: nextPhone() });
    assert.equal(r.status, 409, again);
    assert.equal(r.data.code, 'same_mailbox', again);
    assert.match(r.data.error, /already exists/);
  }
  // Exactly the same address is refused in the words sign-up always used.
  const same = await join(bare(), { email: 'DOT.TY.EXAMPLE@gmail.com', phone: nextPhone() });
  assert.equal(same.status, 409);
  assert.match(same.data.error, /An account with this email already exists/);
  // Dots at another mail service are kept apart.
  assert.equal((await join(bare(), { email: 'dot.ty@rules.example', phone: nextPhone() })).status, 200);
  assert.equal((await join(bare(), { email: 'dotty@rules.example', phone: nextPhone() })).status, 200);
  assert.equal(db.get("SELECT COUNT(*) n FROM users WHERE email_key='dottyexample@gmail.com'").n, 1);
});

test('a login that already has a + keeps working: it signs in, sends, and nothing locks it out', async () => {
  // Made before the rule, the way the database held it then.
  const c = await signUp('Olive Old', 'olive@rules.example', ip());
  db.run("UPDATE users SET email='olive+docs@rules.example', email_key=NULL WHERE email='olive@rules.example'");
  assert.equal((await c.post('/auth/logout')).status, 200);
  const back = bare();
  const r = await back.post('/auth/login', { email: 'olive+docs@rules.example', password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await back.get('/me')).data.user.email, 'olive+docs@rules.example');
  const e = await simple(back, 'signer@rules.example');
  assert.equal((await back.post(`/envelopes/${e.id}/send`)).status, 200);
  // And nobody can make a second login on that mailbox by leaving the + part out.
  const second = await join(bare(), { email: 'olive@rules.example', phone: nextPhone() });
  assert.equal(second.status, 409);
  assert.equal(second.data.code, 'same_mailbox');
});

test('signers and recipients are not affected: a document goes to an address with a +', async () => {
  const c = await signUp('Sam Sender', 'sam.sender@rules.example', ip());
  const e = await simple(c, 'client+contracts@rules.example');
  const sent = await c.post(`/envelopes/${e.id}/send`);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.ok(mailTo('client+contracts@rules.example').length >= 1, 'the invitation went to the + address');
  // A contact with a + is fine too.
  assert.equal((await c.post('/contacts', { name: 'Plus Contact', email: 'pat+home@rules.example' })).status, 200);
});

test('an invitation to a team: nobody is invited at a + address, and the invited person gives their own number', async () => {
  const admin = await signUp('Ada Admin', 'ada.admin@rules.example', ip());
  const no = await admin.post('/account/invites', { email: 'new+hire@rules.example', role: 'member' });
  assert.equal(no.status, 400);
  assert.equal(no.data.error, PLUS_INVITE_REFUSAL);
  assert.equal(db.get("SELECT COUNT(*) n FROM invites WHERE email='new+hire@rules.example'").n, 0);
  // Someone who already has a login with a + can still be invited at it.
  db.run("UPDATE users SET email='olive+docs@rules.example' WHERE email='olive+docs@rules.example'");
  assert.equal((await admin.post('/account/invites', { email: 'olive+docs@rules.example', role: 'member' })).status, 200);

  assert.equal((await admin.post('/account/invites', { email: 'mel.member@rules.example', role: 'member' })).status, 200);
  const invite = db.get("SELECT token FROM invites WHERE email='mel.member@rules.example'").token;
  const mel = bare();
  const without = await mel.post('/auth/signup', { name: 'Mel Member', email: 'mel.member@rules.example', password: PW, invite });
  assert.equal(without.status, 400, 'an invited member gives a number too');
  assert.equal(without.data.code, 'phone');
  const adminPhone = user('ada.admin@rules.example').phone;
  const taken = await mel.post('/auth/signup', { name: 'Mel Member', email: 'mel.member@rules.example', password: PW, invite, phone: adminPhone });
  assert.equal(taken.status, 409, 'and it is their own, not the admin\'s');
  assert.equal(taken.data.error, PHONE_TAKEN);
  const ok = await mel.post('/auth/signup', { name: 'Mel Member', email: 'mel.member@rules.example', password: PW, invite, phone: '0412 345 678', phone_country: 'AU' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(user('mel.member@rules.example').phone, '+61412345678');
  // Nobody on the team is sent anybody else's number.
  const members = await admin.get('/account/members');
  assert.ok(!JSON.stringify(members.data).includes('61412345678'));
  assert.ok(!JSON.stringify(members.data).includes('phone'));
  const mine = (await admin.get('/me')).data;
  assert.ok(mine.phone.number, 'everyone sees their own');
  assert.ok(!JSON.stringify(mine).includes('61412345678'));
});

test('moving a login to another address follows the same rules', async () => {
  const c = await signUp('Mo Mover', 'mo.mover@rules.example', ip());
  const plus = await c.post('/me/email', { email: 'mo+new@rules.example', password: PW });
  assert.equal(plus.status, 400);
  assert.equal(plus.data.error, PLUS_REFUSAL);
  const taken = await c.post('/me/email', { email: 'dottyexample@gmail.com', password: PW });
  assert.equal(taken.status, 409);
  assert.equal(taken.data.code, 'same_mailbox');
  const ok = await c.post('/me/email', { email: 'mo.moved@gmail.com', password: PW });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const link = mailTo('mo.moved@gmail.com').at(-1).link;
  assert.equal((await c.post('/me/email/confirm', { token: new URL(link).searchParams.get('token') })).status, 200);
  assert.equal(user('mo.moved@gmail.com').email_key, 'momoved@gmail.com', 'the mailbox of the new address is kept with it');
  assert.equal((await join(bare(), { email: 'momoved@gmail.com', phone: nextPhone() })).data.code, 'same_mailbox');
});

// ---- 2. The phone number ----------------------------------------------------------------------------

const GOOD: [country: string, typed: string, e164: string][] = [
  ['US', '(201) 555-0123', '+12015550123'],
  ['US', '1 201 555 0123', '+12015550123'],
  ['GB', '07400 123456', '+447400123456'],
  ['GB', '020 7946 0958', '+442079460958'],
  ['DE', '01512 3456789', '+4915123456789'],
  ['DE', '030 123456', '+4930123456'],
  ['FR', '06 12 34 56 78', '+33612345678'],
  ['ES', '612 34 56 78', '+34612345678'],
  ['BR', '(11) 96123-4567', '+5511961234567'],
  ['BR', '11 3123 4567', '+551131234567'],
  ['IN', '081234 56789', '+918123456789'],
  ['NG', '0802 123 4567', '+2348021234567'],
  ['KE', '0712 123456', '+254712123456'],
  ['TR', '0501 234 56 78', '+905012345678'],
  ['AE', '050 123 4567', '+971501234567'],
  ['AU', '0412 345 678', '+61412345678'],
  ['JP', '090-1234-5678', '+819012345678'],
  ['ZA', '082 123 4567', '+27821234567'],
  ['IT', '333 123 4567', '+393331234567'],
  ['IT', '06 1234 5678', '+390612345678'],
  ['RU', '8 912 345-67-89', '+79123456789'],
  // Typed with the country code, whatever the picker says.
  ['FR', '+44 7400 123456', '+447400123456'],
  ['US', '0044 (0)7400 123456', '+447400123456'],
  ['GB', '44 7400 123456', '+447400123456'],
  ['', '+254 712 123456', '+254712123456'],
];
const WRONG: [country: string, typed: string, why: string][] = [
  ['US', '', 'empty'],
  ['US', 'call me maybe', 'letters'],
  ['US', '555 0123', 'short'],
  ['US', '201 555 01234', 'long'],
  ['US', '123 456 7890', 'shape'],
  ['GB', '07400 1234', 'short'],
  ['GB', '07400 1234567', 'long'],
  ['DE', '0151', 'short'],
  ['FR', '06 12 34 56', 'short'],
  ['FR', '06 12 34 56 78 9', 'long'],
  ['ES', '512 34 56 78', 'shape'],
  ['BR', '11 6123 45678', 'shape'],
  ['IN', '81234 5678', 'short'],
  ['IN', '99999 99999', 'fake'],
  ['NG', '0802 123 45678', 'long'],
  ['KE', '0812 123456', 'shape'],
  ['TR', '0601 234 56 78', 'shape'],
  ['AE', '050 123 45678', 'long'],
  ['AU', '0512 345 678', 'shape'],
  ['AU', '4444 444 44', 'fake'],
  ['', '201 555 0123', 'country'],
  ['US', '+999 123 456 789', 'country'],
  ['GB', '0900 123 4567', 'premium'],
  ['US', '900 555 0123', 'premium'],
];

test('phone numbers are read for the country chosen: twelve countries and more, as people write them at home', () => {
  for (const [country, typed, e164] of GOOD) {
    const r = parsePhone(typed, country);
    assert.deepEqual([r.ok, r.ok ? r.e164 : r.why], [true, e164], `${country} ${typed}`);
    assert.match(e164, /^\+[1-9]\d{7,14}$/, 'international form: a plus and 8 to 15 digits');
  }
  for (const c of ['US', 'GB', 'DE', 'FR', 'ES', 'BR', 'IN', 'NG', 'KE', 'TR', 'AE', 'AU']) assert.ok(GOOD.some((g) => g[0] === c) && WRONG.some((w) => w[0] === c), `${c} has good and wrong numbers here`);
  assert.ok(PHONE_COUNTRIES.length > 200, 'the picker lists the world');
  assert.equal(new Set(PHONE_COUNTRIES.map((c) => c.iso)).size, PHONE_COUNTRIES.length);
});

test('wrong numbers are refused, each with a kind sentence', () => {
  for (const [country, typed, why] of WRONG) {
    const r = parsePhone(typed, country);
    assert.deepEqual([r.ok, r.ok ? r.e164 : r.why], [false, why], `${country} "${typed}"`);
    const words = phoneProblemText(why as any, country);
    assert.ok(words.length > 20 && /[.]$/.test(words), words);
  }
  assert.match(phoneProblemText('short', 'GB'), /too short for United Kingdom\. Please check it\. For example 07400 123456\./);
});

test('the picker starts on the country of the browser, and a number is shown with its country code apart', () => {
  assert.equal(guessCountry(['en-GB', 'en']), 'GB');
  assert.equal(guessCountry(['pt-BR']), 'BR');
  assert.equal(guessCountry(['de']), 'DE', 'a language without a country gives its likely country');
  assert.equal(guessCountry('hi'), 'IN');
  assert.equal(guessCountry([]), 'US');
  assert.equal(guessCountry(['not a language']), 'US');
  assert.equal(showPhone('+447400123456'), '+44 7400123456');
});

test('sign-up needs a phone number, keeps it in international form, and one number belongs to one login', async () => {
  assert.equal(phoneRequired(), true);
  const c = bare();
  const none = await join(c, { email: 'pia@rules.example' });
  assert.equal(none.status, 400);
  assert.equal(none.data.code, 'phone');
  assert.match(none.data.error, /Please type your phone number/);
  const short = await join(c, { email: 'pia@rules.example', phone: '0612', phone_country: 'FR' });
  assert.equal(short.status, 400);
  assert.match(short.data.error, /too short for France/);
  assert.equal(user('pia@rules.example'), null, 'nothing was made');
  const ok = await join(c, { email: 'pia@rules.example', phone: '06 12 34 56 78', phone_country: 'FR' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(user('pia@rules.example').phone, '+33612345678');
  const me = (await c.get('/me')).data;
  assert.deepEqual(me.phone, { number: '+33 612345678', verified: false, needed: false, ask: null, can_verify: false });
  // The same number written another way is the same number.
  for (const again of [{ phone: '+33 6 12 34 56 78' }, { phone: '0033612345678' }, { phone: '0612345678', phone_country: 'FR' }]) {
    const r = await join(bare(), { email: `again${n}@rules.example`, ...again });
    assert.equal(r.status, 409, JSON.stringify(again));
    assert.equal(r.data.error, 'This number is already used by another account.');
    assert.equal(r.data.code, 'phone_taken');
  }
  assert.equal(db.get("SELECT COUNT(*) n FROM users WHERE email LIKE 'again%@rules.example'").n, 0);
});

test('an operator can allow one number for more than one login, and take that back', async () => {
  const olga = await signUp('Olga Operator', 'olga@ops.example', ip());
  const outsider = await signUp('Not Operator', 'nosy@rules.example', ip());
  assert.equal((await outsider.post('/operator/phones', { phone: '+33612345678', shared: true })).status, 404, 'only the people who run the server');
  assert.equal((await olga.post('/operator/phones', { phone: '+33612345678' })).status, 400, 'it has to say what it wants');
  assert.equal((await olga.post('/operator/phones', { phone: '06 12 34 56 78', phone_country: 'FR', shared: true })).status, 200);
  const twin = await join(bare(), { email: 'twin@rules.example', phone: '+33612345678' });
  assert.equal(twin.status, 200, JSON.stringify(twin.data));
  assert.equal((await olga.post('/operator/phones', { phone: '+33612345678', shared: false })).status, 200);
  assert.equal((await join(bare(), { email: 'triplet@rules.example', phone: '+33612345678' })).status, 409);
  assert.equal(user('twin@rules.example').phone, '+33612345678', 'a login that already has it keeps it');
});

test('a person changes their own number; an API key never reads or writes one', async () => {
  const c = await signUp('Cy Changer', 'cy@rules.example', ip());
  const bad = await c.post('/me/phone', { phone: '12', phone_country: 'US' });
  assert.equal(bad.status, 400);
  const taken = await c.post('/me/phone', { phone: '+33612345678' });
  assert.equal(taken.status, 409);
  const same = await c.post('/me/phone', { phone: user('cy@rules.example').phone });
  assert.equal(same.status, 200, 'their own number again is not "taken"');
  const ok = await c.post('/me/phone', { phone: '0802 123 4567', phone_country: 'NG' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.phone.number, '+234 8021234567');
  assert.equal(user('cy@rules.example').phone, '+2348021234567');
  const key = (await c.post('/api-keys', { name: 'k', scope: 'admin' })).data.key;
  const api = async (method: string, url: string, body?: any) => {
    const res = await handle(new Request(`http://test.local/api${url}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
    return { status: res.status, data: await res.json() };
  };
  const me = await api('GET', '/me');
  assert.equal(me.status, 200);
  assert.ok(!('phone' in me.data) && !JSON.stringify(me.data).includes('8021234567'), 'a key is not sent the number');
  assert.equal((await api('POST', '/me/phone', { phone: '+2348021234568' })).status, 403);
});

// ---- Google and Microsoft -----------------------------------------------------------------------------

const pair = (() => {
  const k = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid: 'key-1', key: k.privateKey, pub: k.publicKey };
})();
const b64 = (v: any) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const signJwt = (claims: any) => {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: pair.kid });
  const body = b64(claims);
  return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.key).toString('base64url')}`;
};
type P = 'google' | 'microsoft';
const TENANT = '11111111-2222-4333-8444-555555555555';
const codes = new Map<string, string>();
const HOSTS: Record<string, P> = { 'oauth2.googleapis.com': 'google', 'www.googleapis.com': 'google', 'login.microsoftonline.com': 'microsoft' };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = new URL(String(url));
  if (!HOSTS[u.host]) return realFetch(url, init);
  const json = (out: any, status = 200) => new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/oauth2/v3/certs' || u.pathname.endsWith('/discovery/v2.0/keys')) return json({ keys: [{ ...pair.pub.export({ format: 'jwk' }), kid: pair.kid, use: 'sig', alg: 'RS256' }] });
  if (init.method === 'POST') {
    const p = Object.fromEntries(new URLSearchParams(String(init.body)));
    const token = codes.get(p.code);
    codes.delete(p.code);
    return token ? json({ access_token: 'x', token_type: 'Bearer', id_token: token }) : json({ error: 'invalid_grant' }, 400);
  }
  return json({ error: 'not_found' }, 404);
}) as any;
after(() => {
  globalThis.fetch = realFetch;
});
async function go(c: Client, url: string) {
  const res = await handle(new Request(`http://test.local/api${url}`, { headers: { cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': c.ip } }));
  for (const ck of res.headers.getSetCookie()) {
    const [kv] = ck.split(';');
    c.cookies[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  }
  return { status: res.status, location: res.headers.get('location') || '' };
}
// The whole trip through the provider and back, as a browser makes it.
async function signInWith(c: Client, provider: P, person: Record<string, any>, query: Record<string, string> = { mode: 'signup' }) {
  const start = await go(c, `/auth/${provider}/start?${new URLSearchParams(query)}`);
  assert.equal(start.status, 302);
  const auth = new URL(start.location);
  const t = Math.floor(Date.now() / 1000);
  const base = { aud: auth.searchParams.get('client_id'), nonce: auth.searchParams.get('nonce'), iat: t, exp: t + 3600 };
  const claims = provider === 'google' ? { iss: 'https://accounts.google.com', azp: base.aud, ...base, email_verified: true, ...person }
    : { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, ver: '2.0', tid: TENANT, ...base, ...person };
  const code = `code-${crypto.randomBytes(8).toString('hex')}`;
  codes.set(code, signJwt(claims));
  const back = await go(c, `/auth/${provider}/callback?${new URLSearchParams({ code, state: auth.searchParams.get('state')! })}`);
  return { ...back, to: new URL(back.location || 'http://nowhere.invalid/') };
}

test('Google and Microsoft: no new login with a + in the address, in words on the page', async () => {
  for (const [provider, person] of [['google', { sub: 'g-plus', email: 'gina+one@gmail.com', name: 'Gina' }], ['microsoft', { oid: 'm-plus', sub: 's', email: 'mike+one@corp.example', xms_edov: true, name: 'Mike' }]] as [P, any][]) {
    const r = await signInWith(bare(), provider, person);
    assert.equal(r.to.pathname, '/signup', provider);
    assert.equal(r.to.searchParams.get('signin_error'), 'plus_email', provider);
    assert.equal(user(person.email), null, 'no login was made');
  }
  assert.ok((SIGNIN_ERRORS as readonly string[]).includes('plus_email'));
  assert.match(signInErrorText('plus_email', 'google'), /Please use your email address without the \+ part/);
  assert.match(signInErrorText('same_mailbox', 'microsoft'), /already have a GrowSigning login for this mailbox/);
});

test('Google signs in to the login of the same Gmail mailbox and makes no second one', async () => {
  // dot.ty.example@gmail.com signed up above with a password.
  const c = bare();
  const r = await signInWith(c, 'google', { sub: 'g-dotty', email: 'dottyexample@gmail.com', name: 'Dotty' }, { mode: 'login' });
  assert.equal(r.to.pathname, '/signin/done');
  assert.equal((await c.get('/me')).data.user.email, 'dot.ty.example@gmail.com');
  assert.equal(db.get("SELECT COUNT(*) n FROM users WHERE email_key='dottyexample@gmail.com'").n, 1);
});

test('a login made with Google or Microsoft is asked for its number once, before the app opens', async () => {
  for (const [provider, person, email] of [['google', { sub: 'g-new', email: 'gus@gmail.com', name: 'Gus Green' }, 'gus@gmail.com'], ['microsoft', { oid: 'm-new', sub: 's2', email: 'mia@corp.example', xms_edov: true, name: 'Mia Moss' }, 'mia@corp.example']] as [P, any, string][]) {
    const c = bare();
    const r = await signInWith(c, provider, person);
    assert.equal(r.to.pathname, '/signin/done', provider);
    const u = user(email);
    assert.ok(u && !u.phone && u.phone_rule === 1, provider);
    let me = (await c.get('/me')).data;
    assert.deepEqual([me.phone.needed, me.phone.ask, me.phone.number], [true, 'now', null], 'the app shows the One more thing screen and nothing else');
    // It cannot be put off, and nothing new goes out before it is given.
    assert.equal((await c.post('/me/phone/later')).status, 409);
    const e = await simple(c, `signer-${provider}@rules.example`);
    const sent = await c.post(`/envelopes/${e.id}/send`);
    assert.equal(sent.status, 403);
    assert.equal(sent.data.code, 'phone_needed');
    assert.match(sent.data.error, /^Add your phone number before you send\./);
    assert.equal((await c.post('/api-keys', { name: 'k' })).data.code, 'phone_needed');
    // Ten seconds: one number, and the app is open.
    const taken = await c.post('/me/phone', { phone: '+33612345678' });
    assert.equal(taken.status, 409);
    const ok = await c.post('/me/phone', provider === 'google' ? { phone: '0171 2345678', phone_country: 'DE' } : { phone: '0501 234 56 99', phone_country: 'TR' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    me = (await c.get('/me')).data;
    assert.deepEqual([me.phone.needed, me.phone.ask], [false, null]);
    assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  }
});

// ---- Logins from before the rule ----------------------------------------------------------------------

test('a login from before the rule is asked once, may say not now, keeps what is out, and gives the number before the next new send', async () => {
  const c = await signUp('Elle Earlier', 'elle@rules.example', ip());
  const out = await simple(c, 'before@rules.example');
  assert.equal((await c.post(`/envelopes/${out.id}/send`)).status, 200);
  const key = (await c.post('/api-keys', { name: 'before the rule' })).data.key;
  // As the database held her before the rule: no number, and nothing that says how she is asked.
  db.run("UPDATE users SET phone=NULL, phone_key=NULL, phone_rule=NULL, phone_asked_at=NULL WHERE email='elle@rules.example'");
  await c.post('/auth/logout');
  const back = bare();
  assert.equal((await back.post('/auth/login', { email: 'elle@rules.example', password: PW })).status, 200, 'she is not locked out');
  let me = (await back.get('/me')).data;
  assert.deepEqual([me.phone.needed, me.phone.ask], [true, 'may_wait']);
  assert.equal((await back.post('/me/phone/later')).status, 200);
  me = (await back.get('/me')).data;
  assert.deepEqual([me.phone.needed, me.phone.ask], [true, 'before_send'], 'the app opens; she is asked again when she sends');
  assert.equal((await back.post('/me/phone/later')).status, 409, 'not now is said once');
  // What is already out goes on: she reads it, reminds, and the signer signs.
  assert.equal((await back.get(`/envelopes/${out.id}`)).status, 200);
  assert.equal((await back.post(`/envelopes/${out.id}/remind`)).status, 200);
  assert.equal((await back.get('/export')).status, 200);
  // A key she made before goes on sending.
  const f = new FormData();
  const { samplePdf } = await import('./helpers.ts');
  f.append('file', new Blob([await samplePdf(1)], { type: 'application/pdf' }), 'A.pdf');
  const up = await handle(new Request('http://test.local/api/files', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: f }));
  const file = await up.json();
  const viaKey = await handle(new Request('http://test.local/api/envelopes', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ subject: 'By key', send: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Kay Key', email: 'kay@rules.example' }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] }) }));
  assert.equal(viaKey.status, 200, 'a key that already works is not stopped');
  // The next new document from the app waits for the number.
  const next = await simple(back, 'after@rules.example');
  const no = await back.post(`/envelopes/${next.id}/send`);
  assert.equal(no.status, 403);
  assert.equal(no.data.code, 'phone_needed');
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', next.id).status, 'draft', 'the draft is kept');
  assert.equal((await back.post(`/envelopes/${next.id}/send-later`, { send_at: new Date(Date.now() + 3600_000).toISOString() })).data.code, 'phone_needed');
  assert.equal((await back.post('/me/phone', { phone: '0712 123456', phone_country: 'KE' })).status, 200);
  assert.equal((await back.post(`/envelopes/${next.id}/send`)).status, 200);
  assert.equal((await back.get('/me')).data.phone.ask, null);
});

test('a server can switch the question off, and a server under a contract does not ask unless told to', async () => {
  assert.equal(phoneRequired({}), true);
  assert.equal(phoneRequired({ SIGNUP_PHONE: 'off' }), false);
  assert.equal(phoneRequired({ BILLING_MODE: 'deployment' }), false);
  assert.equal(phoneRequired({ BILLING_MODE: 'deployment', SIGNUP_PHONE: 'required' }), true);
  process.env.SIGNUP_PHONE = 'off';
  try {
    const c = bare();
    assert.equal((await join(c, { email: 'nophone@rules.example' })).status, 200);
    assert.equal((await c.get('/me')).data.phone.needed, false);
    // The + rule is not part of that switch.
    assert.equal((await join(bare(), { email: 'still+no@rules.example' })).status, 400);
    // A number that is given is still read properly.
    assert.equal((await join(bare(), { email: 'badphone@rules.example', phone: '12' })).status, 400);
  } finally {
    delete process.env.SIGNUP_PHONE;
  }
  assert.equal(phoneState({ phone: null, phone_rule: 2 }).needed, false, 'a login an organisation made is not asked');
});

// ---- 3. Who sees it, export, deletion, encryption ------------------------------------------------------

test('operators see the numbers of an account; nobody else does', async () => {
  const olga = new Client();
  olga.ip = ip();
  assert.equal((await olga.post('/auth/login', { email: 'olga@ops.example', password: PW })).status, 200);
  const accountId = db.get("SELECT m.account_id a FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='ada.admin@rules.example'").a;
  const r = await olga.get(`/operator/accounts/${accountId}/people`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const mel = r.data.people.find((p: any) => p.email === 'mel.member@rules.example');
  assert.deepEqual([mel.phone, mel.phone_verified, mel.role], ['+61 412345678', false, 'member']);
  assert.ok(r.data.people.find((p: any) => p.email === 'ada.admin@rules.example').phone);
  // The admin of that very account is not an operator: the page does not exist for her.
  const ada = new Client();
  ada.ip = ip();
  await ada.post('/auth/login', { email: 'ada.admin@rules.example', password: PW });
  assert.equal((await ada.get(`/operator/accounts/${accountId}/people`)).status, 404);
  // Nothing a sender or an admin can read carries a colleague's number.
  for (const url of ['/account/members', '/me', '/contacts', '/envelopes'])
    assert.ok(!JSON.stringify((await ada.get(url)).data).includes('412345678'), url);
});

test('the number is exported with its owner\'s login, only theirs, and is deleted with the login', async () => {
  const ada = new Client();
  ada.ip = ip();
  await ada.post('/auth/login', { email: 'ada.admin@rules.example', password: PW });
  const adaRow = user('ada.admin@rules.example');
  const account = db.get('SELECT * FROM accounts WHERE id=?', adaRow.last_account_id);
  let own: any = null, all = '';
  for await (const entry of exportEntries(account, adaRow)) {
    if (entry.name === 'your-login.json') own = JSON.parse(Buffer.from(entry.data as Uint8Array).toString());
    if (/\.(json|txt)$/.test(entry.name)) all += Buffer.from(entry.data as Uint8Array).toString();
  }
  assert.equal(own.email, 'ada.admin@rules.example');
  assert.equal(own.phone, adaRow.phone);
  assert.equal(own.phone_checked_by_code, false);
  assert.ok(all.includes('your-login.json'), 'the README names the file');
  assert.ok(!all.includes('61412345678'), 'the number of the other member of the team is not in the export');

  // Closing the login deletes the number with it.
  const c = await signUp('Del Leaver', 'del@rules.example', ip());
  const phone = user('del@rules.example').phone;
  const { purgeUser } = await import('../src/server/routes-trust.ts') as any;
  assert.equal(typeof purgeUser, 'function');
  await purgeUser(user('del@rules.example').id);
  assert.equal(user('del@rules.example'), null);
  assert.equal(db.get('SELECT COUNT(*) n FROM users WHERE phone_key IS NOT NULL AND phone=?', phone).n, 0);
  // And the number is free again for whoever has it next.
  assert.equal((await join(bare(), { email: 'del.next@rules.example', phone })).status, 200);
  void c;
});

test('with an encryption key the number is unreadable in the database, and still one login per number', async () => {
  const { SEALED_COLUMNS, isSealed } = await import('../src/server/colcrypt.ts');
  assert.ok(SEALED_COLUMNS.some((x) => x.table === 'users' && x.column === 'phone'));
  const { SEALED_WORDS } = await import('../src/lib/sealedcolumns.ts');
  assert.ok(SEALED_WORDS.some((w) => /phone number of each login/.test(w)), 'the pages say so');
  const before = process.env.FILE_ENCRYPTION_KEY;
  process.env.FILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  try {
    assert.equal((await join(bare(), { email: 'kim.key@rules.example', phone: '0412 999 888', phone_country: 'AU' })).status, 200);
    assert.ok(isSealed(rawPhone('kim.key@rules.example')), 'sealed where it is stored');
    assert.equal(user('kim.key@rules.example').phone, '+61412999888', 'and read back as it was written');
    assert.equal((await join(bare(), { email: 'kim.two@rules.example', phone: '+61 412 999 888' })).status, 409);
    const disk = fs.readFileSync(path.join(process.env.DATA_DIR!, 'sign.db'));
    const wal = fs.existsSync(path.join(process.env.DATA_DIR!, 'sign.db-wal')) ? fs.readFileSync(path.join(process.env.DATA_DIR!, 'sign.db-wal')) : Buffer.alloc(0);
    assert.ok(!Buffer.concat([disk, wal]).includes(Buffer.from('61412999888')), 'the number is not readable in the database file');
    // The key goes again below: this row would then be a value nobody can open.
    db.run("DELETE FROM users WHERE email='kim.key@rules.example'");
  } finally {
    if (before === undefined) delete process.env.FILE_ENCRYPTION_KEY;
    else process.env.FILE_ENCRYPTION_KEY = before;
  }
});

// ---- Checking by code: only where the server sends text messages ----------------------------------------

test('no verification text without a provider; with one, checking by code is offered, never required, and kept', async () => {
  const c = await signUp('Vera Verify', 'vera@rules.example', ip());
  delete process.env.SMS_DEV_OUTBOX;
  assert.equal((await c.get('/me')).data.phone.can_verify, false);
  const no = await c.post('/me/phone/code');
  assert.equal(no.status, 404);
  assert.equal(db.get('SELECT COUNT(*) n FROM texts').n, 0, 'nothing was texted to anyone in this whole file');
  // A provider is set (the outbox stands in for one on a machine that is not production).
  process.env.SMS_DEV_OUTBOX = '1';
  try {
    assert.equal((await c.get('/me')).data.phone.can_verify, true);
    const e = await simple(c, 'unverified@rules.example');
    assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200, 'sending never waits for the code');
    assert.equal((await c.post('/me/phone/code')).status, 200);
    const text = db.get('SELECT body FROM texts ORDER BY id DESC LIMIT 1').body;
    const code = /code is (\d{3}) (\d{3})/.exec(text)!.slice(1).join('');
    const wrong = await c.post('/me/phone/verify', { code: code === '000000' ? '000001' : '000000' });
    assert.equal(wrong.status, 400);
    assert.equal((await c.post('/me/phone/verify', { code })).status, 200);
    const me = (await c.get('/me')).data;
    assert.deepEqual([me.phone.verified, me.phone.can_verify], [true, false]);
    assert.ok(user('vera@rules.example').phone_verified_at);
    // A changed number is not a checked number.
    assert.equal((await c.post('/me/phone', { phone: nextPhone() })).status, 200);
    assert.equal((await c.get('/me')).data.phone.verified, false);
  } finally {
    delete process.env.SMS_DEV_OUTBOX;
  }
});

// ---- 4. The pages and the documents say it ---------------------------------------------------------------

test('the form, the privacy and security pages, the help page, the README and the API description say it', async () => {
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const form = read('src/components/AuthForm.tsx');
  assert.match(form, /PhoneField/);
  assert.match(form, /auth\.plus_email/);
  assert.match(read('src/components/PhoneField.tsx'), /phone\.why/);
  assert.match(read('src/components/AppShell.tsx'), /PhoneRequired/);
  for (const f of ['src/app/security/page.tsx', 'src/app/help/page.tsx', 'README.md'])
    assert.match(read(f), /phone number/i, f);
  assert.match(read('README.md'), /SIGNUP_PHONE/);
  assert.match(read('.env.example'), /SIGNUP_PHONE/);
  const spec = (await new Client().get('/openapi.json')).data;
  const body = spec.paths['/auth/signup'].post.requestBody.content['application/json'].schema;
  assert.ok(body.required.includes('phone'));
  assert.match(body.properties.phone.description, /international form/);
  assert.match(body.properties.email.description, /\+/);
  assert.ok(body.properties.phone_country);
  assert.ok(spec.paths['/me/phone']);
});
