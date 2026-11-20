// Checking who signs: a one-time code by email or by text message before a document opens, and text messages as a
// second way to reach a signer. The text message provider is a stand-in (a fetch stub for Twilio and for the generic
// hook, and the outbox table), so nothing here reaches the network. What is pinned down: what each setting switches
// on, what is refused and in which words, what a link gives away before the check is passed, every limit on codes
// and on texts, that the code cannot be read from any answer, corrections, the audit trail and the certificate.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, PNG, simple, upload, tokenFor, signUp, mailTo } from './helpers.ts';
import { smsProvider, smsWarning, normalPhone, maskPhone, maskEmail, checkLine, SMS_OFF, CHECK_PROVES } from '../src/lib/checks.ts';
import { SIGNER_CODE_TRIES, SIGNER_CODES_PER_HOUR, SIGNER_CODES_PER_CALLER_HOUR, SIGNER_CODES_PER_DESTINATION_DAY, SIGNER_CODE_MINUTES, LINK_TEXTS_PER_NUMBER_DAY, smsDailyPerAccount } from '../src/lib/policy.ts';
import { extractText } from '../src/server/text.ts';

// Text messages are switched on for this file the way a developer's machine has them: written to the outbox only.
const SMS_KEYS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID', 'SMS_WEBHOOK_URL', 'SMS_WEBHOOK_TOKEN', 'SMS_DEV_OUTBOX', 'SMS_DAILY_PER_ACCOUNT'];
const provider = (set: Record<string, string>) => {
  for (const k of SMS_KEYS) delete process.env[k];
  Object.assign(process.env, set);
};
provider({ SMS_DEV_OUTBOX: '1' });

const { db, cron } = await boot();

// ---- The stand-in for a text message provider ------------------------------------------------------------------

const sms = {
  calls: [] as { url: string; headers: Record<string, string>; body: string }[],
  // What the next calls answer: a status and a body. Empty means "taken".
  answers: [] as { status: number; body: any }[],
};
const HOSTS = new Set(['api.twilio.com', 'texts.provider.test']);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = new URL(String(url));
  if (!HOSTS.has(u.host)) return realFetch(url, init); // not ours: somebody else's stand-in, or the real thing
  sms.calls.push({ url: String(url), headers: Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: String(init.body || '') });
  const a = sms.answers.shift() || { status: 201, body: { sid: `SM${sms.calls.length}`, id: `msg-${sms.calls.length}` } };
  return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
}) as any;
after(() => {
  globalThis.fetch = realFetch;
  provider({});
});

// ---- Fixtures -----------------------------------------------------------------------------------------------------

let n = 0;
const ip = () => `198.51.${100 + (++n >> 8)}.${n & 255}`;
const fresh = (name = 'Sam') => `${name.toLowerCase()}${++n}@example.com`;
const visitor = () => Object.assign(new Client(), { ip: ip() });
const ada = await signUp('Ada Sender', 'ada.sender@example.com', ip());
// Ada sends far more in this file than an account that has not paid may in a day. That limit is not what most of
// these tests are about, so a person has cleared her account. The tests about limits use accounts of their own.
db.run("UPDATE accounts SET trusted_at=? WHERE id=(SELECT m.account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='ada.sender@example.com')", new Date().toISOString());
const full = async (c: Client, id: string) => (await c.get(`/envelopes/${id}`)).data;
const actions = async (c: Client, id: string) => (await full(c, id)).audit.map((a: any) => a.action);
const line = async (c: Client, id: string, action: string) => (await full(c, id)).audit.filter((a: any) => a.action === action).pop();
const toAda = (prefix: string) => mailTo('ada.sender@example.com').filter((m) => m.subject.startsWith(prefix));

// One signer on a one-page document, sent. `r` is merged into the recipient, `over` into the envelope.
async function one(c: Client, r: any = {}, over: any = {}) {
  const email = r.email || fresh();
  const e = await simple(c, email, { send: true, recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', ...r, email }], ...over });
  const row = db.get('SELECT id, token FROM recipients WHERE envelope_id=? AND email=?', e.id, email);
  return { id: e.id as string, tok: row.token as string, rid: row.id as string, email };
}
// The same request without the helper's own assertion, for the refusals.
async function tryOne(c: Client, r: any, over: any = {}) {
  const file = await upload(c, 1);
  return c.post('/envelopes', {
    subject: 'Simple agreement', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: fresh(), ...r }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }], send: true, ...over,
  });
}
// The code as only the mailbox or the phone would see it: read from the outbox, never from an answer.
const emailCode = (to: string) => /(\d{6}) is your code/.exec(db.get("SELECT html FROM emails WHERE to_email=? AND subject LIKE 'Your code to open%' ORDER BY id DESC LIMIT 1", to)?.html || '')?.[1] as string;
const textCode = (rid: string) => /^(\d{6}) is your/.exec(db.get("SELECT body FROM texts WHERE recipient_id=? AND kind='code' ORDER BY id DESC LIMIT 1", rid)?.body || '')?.[1] as string;
const texts = (rid: string) => db.all('SELECT * FROM texts WHERE recipient_id=? ORDER BY id', rid);
// Lets time pass for one recipient's codes: every code of theirs becomes this many seconds older.
function older(rid: string, seconds: number) {
  for (const c of db.all('SELECT id, at, expires_at FROM signer_codes WHERE recipient_id=?', rid))
    db.run('UPDATE signer_codes SET at=?, expires_at=? WHERE id=?', new Date(Date.parse(c.at) - seconds * 1000).toISOString(), new Date(Date.parse(c.expires_at) - seconds * 1000).toISOString(), c.id);
}
// Asks for a code and types it in, on this browser.
async function pass(c: Client, s: { tok: string; rid: string; email: string }, by: 'email' | 'text' = 'email') {
  const sent = await c.post(`/sign/${s.tok}/code`);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const done = await c.post(`/sign/${s.tok}/code/check`, { code: by === 'email' ? emailCode(s.email) : textCode(s.rid) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
}
async function finish(c: Client, tok: string) {
  await c.post(`/sign/${tok}/consent`);
  const v = (await c.get(`/sign/${tok}`)).data;
  const values = Object.fromEntries((v.fields || []).map((f: any) => [f.id, '1']));
  return c.post(`/sign/${tok}/complete`, { values, signature_png: PNG, initials_png: PNG });
}
const certificate = async (c: Client, id: string) => (await extractText((await c.get(`/envelopes/${id}/download`)).data)).replace(/\s+/g, ' ');
const UK = '+44 7700 900123';
const UK_MASKED = '+44 *** *** 0123';

// ---- 1. Settings, numbers and words --------------------------------------------------------------------------------

test('text messages exist only when the operator has set a provider up, and a half set-up one is said out loud', () => {
  assert.equal(smsProvider({}), null);
  assert.equal(smsProvider({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15550100' }), 'twilio');
  assert.equal(smsProvider({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_MESSAGING_SERVICE_SID: 'MG1' }), 'twilio');
  // Without a sender, without the token or without the account: off, and the warning names what was found.
  assert.equal(smsProvider({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }), null);
  assert.equal(smsProvider({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_FROM: '+15550100' }), null);
  assert.match(smsWarning({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_FROM: '+15550100' })!, /SWITCHED OFF.*TWILIO_ACCOUNT_SID, TWILIO_FROM.*TWILIO_AUTH_TOKEN/s);
  assert.equal(smsProvider({ SMS_WEBHOOK_URL: 'https://texts.provider.test/send' }), 'hook');
  assert.equal(smsProvider({ SMS_WEBHOOK_URL: 'texts.provider.test' }), null);
  assert.match(smsWarning({ SMS_WEBHOOK_URL: 'texts.provider.test' })!, /SMS_WEBHOOK_URL/);
  // The outbox delivers nothing, so it never switches texts on for a real server.
  assert.equal(smsProvider({ SMS_DEV_OUTBOX: '1' }), 'outbox');
  assert.equal(smsProvider({ SMS_DEV_OUTBOX: '1', NODE_ENV: 'production' }), null);
  assert.match(smsWarning({ SMS_DEV_OUTBOX: '1', NODE_ENV: 'production' })!, /IGNORED/);
  assert.equal(smsWarning({}), null);
  assert.equal(smsWarning({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15550100' }), null);
  // The daily limit: 200 unless set, 0 means none, nonsense means the default.
  assert.equal(smsDailyPerAccount({}), 200);
  assert.equal(smsDailyPerAccount({ SMS_DAILY_PER_ACCOUNT: '25' }), 25);
  assert.equal(smsDailyPerAccount({ SMS_DAILY_PER_ACCOUNT: '0' }), 0);
  assert.equal(smsDailyPerAccount({ SMS_DAILY_PER_ACCOUNT: 'lots' }), 200);
});

test('a number is taken in international form only, and an address or a number is never shown whole', () => {
  assert.equal(normalPhone('+44 7700 900123'), '+447700900123');
  assert.equal(normalPhone('+44 (0)7700-900.123'), '+447700900123');
  assert.equal(normalPhone('0044 7700 900123'), '+447700900123');
  assert.equal(normalPhone('+1 (415) 555-0100'), '+14155550100');
  // No country code, letters, too short, too long: not a number we can text.
  for (const bad of ['07700 900123', '7700900123', '+44 77OO 900123', '+1 555', '+1234567890123456', '', null, '+0 123456789']) assert.equal(normalPhone(bad), null, String(bad));
  assert.equal(maskPhone('+447700900123'), UK_MASKED);
  assert.equal(maskPhone('+14155550100'), '+1 *** *** 0100');
  assert.equal(maskPhone('+3581234567'), '+358 *** *** 67', 'a short number keeps fewer digits in view');
  assert.equal(maskEmail('jane.doe@example.com'), 'j***@example.com');
  assert.equal(maskEmail('nonsense'), 'an email address');
  // The sentence for the certificate says what happened and no more.
  assert.equal(checkLine({ role: 'signer' }, null), 'Link sent by email only');
  assert.equal(checkLine({ role: 'signer', access_code: '4242' }, null), 'Link sent by email and an access code chosen by the sender');
  assert.equal(checkLine({ role: 'signer', verify: 'sms_code' }, { how: `One-time code sent by text message to ${UK_MASKED}`, at: '2026-03-12T14:02:09.000Z' }), `One-time code sent by text message to ${UK_MASKED}, passed 12 March 2026 14:02 UTC`);
  assert.match(checkLine({ role: 'signer', verify: 'email_code' }, null), /^Link sent by email\. A one-time code by email was asked for and was not passed$/);
  // What each check proves is written once, in two sentences each, and says that a code by email proves less.
  assert.deepEqual(CHECK_PROVES.map((p) => p.key), ['link', 'access_code', 'email_code', 'sms_code']);
  for (const p of CHECK_PROVES) assert.equal(p.text.split(/(?<=\.)\s+/).length, 2, p.key);
  assert.match(CHECK_PROVES[2].text, /same mailbox as the link.*little more than the link/);
  assert.match(CHECK_PROVES[3].text, /proves more than a code by email/);
});

// ---- 2. Not configured: the feature is absent ------------------------------------------------------------------------

test('without a provider nothing offers text messages and the API refuses them in words, while a code by email still works', async () => {
  provider({});
  try {
    assert.equal((await ada.get('/me')).data.text_messages, false);
    const byText = await tryOne(ada, { verify: 'sms_code', phone: UK });
    assert.equal(byText.status, 400);
    assert.ok(byText.data.error.startsWith(SMS_OFF), byText.data.error);
    assert.match(byText.data.error, /operator of this server has not switched text messages on/);
    assert.equal(byText.data.code, 'texts_off');
    const link = await tryOne(ada, { phone: UK, text_link: true });
    assert.equal(link.status, 400);
    assert.match(link.data.error, /operator of this server has not switched text messages on.*leave "also text the signing link" off/);
    // Nothing was left behind by the refusals, and no text was written anywhere.
    assert.equal(db.get('SELECT COUNT(*) n FROM texts').n, 0);
    // A code by email needs no provider.
    const s = await one(ada, { verify: 'email_code' });
    assert.equal((await visitor().post(`/sign/${s.tok}/code`)).status, 200);
    // An envelope that was sent while texts were on, on a server that has switched them off since: the signer is
    // told honestly, and so is the sender. No dead end without a word.
    provider({ SMS_DEV_OUTBOX: '1' });
    const t = await one(ada, { verify: 'sms_code', phone: UK });
    provider({});
    const asked = await visitor().post(`/sign/${t.tok}/code`);
    assert.equal(asked.status, 503);
    assert.match(asked.data.error, /cannot send you a code by text message right now\. That is nothing you did: text messages are switched off on this server\. Ada Sender has been told/);
    assert.equal(toAda('Cannot open: Simple agreement').length, 1);
    // A draft that asks for texts cannot be sent, and the refusal says what to change.
    const d = await tryOne(ada, { verify: 'email_code' }, { send: false });
    db.run("UPDATE recipients SET verify='sms_code', phone='+447700900123' WHERE envelope_id=?", d.data.envelope.id);
    const send = await ada.post(`/envelopes/${d.data.envelope.id}/send`);
    assert.equal(send.status, 400);
    assert.match(send.data.error, /has not switched text messages on.*Sam Signer is set to get a one-time code by text message/);
  } finally {
    provider({ SMS_DEV_OUTBOX: '1' });
  }
  assert.equal((await ada.get('/me')).data.text_messages, true);
});

test('a check that does not exist, a number that is not one, and a text with nowhere to go are refused in words', async () => {
  const unknown = await tryOne(ada, { verify: 'fingerprint' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.error, /The check "fingerprint" for recipient 1 \(Sam Signer\) does not exist\. Use one of: none, email_code, sms_code/);
  const noNumber = await tryOne(ada, { verify: 'sms_code' });
  assert.equal(noNumber.status, 400);
  assert.match(noNumber.data.error, /Sam Signer is checked with a one-time code by text message, so they need a mobile number\. Write the mobile number with its country code, starting with a plus sign, for example \+44 7700 900123\./);
  const local = await tryOne(ada, { verify: 'sms_code', phone: '07700 900123' });
  assert.equal(local.status, 400);
  assert.match(local.data.error, /"07700 900123", the mobile number of Sam Signer, is not a number we can text/);
  const linkOnly = await tryOne(ada, { text_link: true });
  assert.match(linkOnly.data.error, /"Also text the signing link" is on for Sam Signer, so they need a mobile number/);
  const inPerson = await tryOne(ada, { role: 'inperson', phone: UK, text_link: true });
  assert.match(inPerson.data.error, /signs in person on your device, so there is no link to text them/);
  // A draft keeps a half-typed number, like a half-typed address, and none of these left a stray draft behind.
  const d = await tryOne(ada, { verify: 'sms_code', phone: '+44 77' }, { send: false });
  assert.equal(d.status, 200);
  assert.equal(d.data.envelope.recipients[0].phone, '+44 77');
  // What comes back names the check in the API's own words, and nothing the server keeps for itself.
  const ok = await tryOne(ada, { verify: 'sms_code', phone: UK, text_link: true }, { send: false });
  const r = ok.data.envelope.recipients[0];
  assert.deepEqual([r.verify, r.phone, r.text_link], ['sms_code', '+447700900123', true]);
  for (const k of ['check_gen', 'checked_for', 'checked_how', 'check_stop', 'token']) assert.equal(k in r, false, k);
  const plain = (await tryOne(ada, {}, { send: false })).data.envelope.recipients[0];
  assert.deepEqual([plain.verify, plain.phone, plain.text_link, plain.check.line], ['none', null, false, 'Link sent by email only']);
  // A save that says nothing about the check leaves it as it was.
  const kept = await ada.put(`/envelopes/${ok.data.envelope.id}`, { documents: ok.data.envelope.documents, fields: ok.data.envelope.fields, recipients: [{ id: r.id, name: 'Sam Signer', email: r.email, role: 'signer' }] });
  assert.deepEqual([kept.data.envelope.recipients[0].verify, kept.data.envelope.recipients[0].phone, kept.data.envelope.recipients[0].text_link], ['sms_code', '+447700900123', true]);
});

// ---- 3. A code by email, from the link to the certificate ---------------------------------------------------------

test('before the code is typed a link gives away nothing: no subject, no message, no document, no address', async () => {
  const s = await one(ada, { verify: 'email_code', name: 'Sam Signer', note: 'Private note for Sam' }, { subject: 'Secret merger terms', message: 'Do not show this to Ben' });
  const c = visitor();
  const v = (await c.get(`/sign/${s.tok}`)).data;
  assert.equal(v.locked, true);
  assert.equal(v.needs, 'code');
  assert.deepEqual([v.check.kind, v.check.to, v.check.sent, v.check.stopped], ['email_code', maskEmail(s.email), false, false]);
  const said = JSON.stringify(v);
  for (const secret of ['Secret merger', 'Do not show', 'Private note', s.email, 'documents', 'fields', 'others', 'Agreement']) assert.equal(said.includes(secret), false, `gave away: ${secret}`);
  assert.equal(v.envelope.subject, '');
  assert.equal(v.recipient.email, maskEmail(s.email));
  // Less than a recipient behind an access code alone is told, and that one is told what it always was.
  const coded = await one(ada, { access_code: '4242' }, { subject: 'Plain terms' });
  const cv = (await visitor().get(`/sign/${coded.tok}`)).data;
  assert.deepEqual([cv.locked, cv.envelope.subject, cv.recipient.email, cv.check, cv.needs], [true, 'Plain terms', coded.email, undefined, undefined]);
  for (const k of Object.keys(v)) if (!['needs', 'check', 'code_next'].includes(k)) assert.ok(k in cv, `the code screen is told "${k}", which the access code screen is not`);
  // Nothing behind the check opens, by any route.
  const docId = db.get('SELECT id FROM documents WHERE envelope_id=?', s.id).id;
  for (const [method, path] of [['GET', `/doc/${docId}`], ['GET', '/download'], ['POST', '/consent'], ['POST', '/complete'], ['POST', '/save'], ['POST', '/decline'], ['POST', '/reassign'], ['POST', '/ask'], ['POST', '/name'], ['POST', '/upload']] as const) {
    const res = await c.call(method, `/sign/${s.tok}${path}`, method === 'POST' ? { reason: 'x', name: 'Eve', email: 'eve@example.com', message: 'hello there', values: {} } : undefined);
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal(res.data.error, 'Type the one-time code first.');
  }
  // Not opened, so not "viewed".
  assert.equal(db.get('SELECT status FROM recipients WHERE id=?', s.rid).status, 'sent');
});

test('a code by email: asked for, typed, remembered on that device only, used once, and on the record', async () => {
  const s = await one(ada, { verify: 'email_code' }, { subject: 'Garden lease' });
  const c = visitor();
  // Nothing is sent until the person asks: opening the link costs nothing and mails nothing.
  assert.equal(mailTo(s.email).filter((m) => m.subject.startsWith('Your code')).length, 0);
  const sent = await c.post(`/sign/${s.tok}/code`);
  assert.equal(sent.status, 200);
  assert.deepEqual([sent.data.sent, sent.data.kind, sent.data.to, sent.data.minutes, sent.data.tries_left], [true, 'email_code', maskEmail(s.email), SIGNER_CODE_MINUTES, SIGNER_CODE_TRIES]);
  const code = emailCode(s.email);
  assert.match(code, /^\d{6}$/);
  // The email says who it is for and warns against passing the code on. Its subject does not hold the code.
  const mail = mailTo(s.email).filter((m) => m.subject.startsWith('Your code')).pop()!;
  assert.equal(mail.subject, 'Your code to open a document from Ada Sender');
  assert.match(mail.html, /works for 10 minutes, and only for the document Ada Sender sent you/);
  assert.match(mail.html, /will ever ask you for this code/);
  assert.equal(mail.html.includes('Garden lease'), false, 'the code email does not name the document');
  // The code is not in any answer: not to whoever holds the link, and not to the sender or an API key of theirs.
  const key = (await ada.post('/api-keys', { name: 'reader' })).data.key;
  const viaKey = await visitor().call('GET', `/envelopes/${s.id}`, undefined, { authorization: `Bearer ${key}` });
  for (const answer of [sent.data, (await c.get(`/sign/${s.tok}`)).data, await full(ada, s.id), viaKey.data, (await ada.get('/envelopes')).data])
    assert.equal(JSON.stringify(answer).includes(code), false, 'an answer held the code');
  // And it is not stored: the table holds a keyed fingerprint.
  const row = db.get('SELECT * FROM signer_codes WHERE recipient_id=?', s.rid);
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(row).includes(code), false);
  assert.equal(row.dest, maskEmail(s.email));
  assert.equal(JSON.stringify(row).includes(s.email), false, 'the address is not in the code table either');

  // A wrong code is said, counted and written down. A code that is not six digits is not a try.
  const short = await c.post(`/sign/${s.tok}/code/check`, { code: '12345' });
  assert.deepEqual([short.status, short.data.code], [400, 'format']);
  const wrong = await c.post(`/sign/${s.tok}/code/check`, { code: code === '000000' ? '000001' : '000000' });
  assert.deepEqual([wrong.status, wrong.data.code, wrong.data.tries_left], [401, 'wrong', SIGNER_CODE_TRIES - 1]);
  assert.match(wrong.data.error, /That code is not right\. Only the newest email from us has the code that works\. You can try 4 more times with this code\./);
  assert.equal((await c.get(`/sign/${s.tok}`)).data.check.tries_left, SIGNER_CODE_TRIES - 1);
  // The right one opens the document, with spaces forgiven.
  const right = await c.post(`/sign/${s.tok}/code/check`, { code: `${code.slice(0, 3)} ${code.slice(3)}` });
  assert.equal(right.status, 200);
  const open = (await c.get(`/sign/${s.tok}`)).data;
  assert.deepEqual([open.locked, open.envelope.subject, open.recipient.email, open.check], [false, 'Garden lease', s.email, undefined]);
  assert.equal(open.fields.length, 1);
  // The same browser stays passed, like after a correct access code. Another browser does not, and the used code
  // opens nothing a second time.
  assert.equal((await c.get(`/sign/${s.tok}`)).data.locked, false);
  const other = visitor();
  assert.equal((await other.get(`/sign/${s.tok}`)).data.locked, true);
  const again = await other.post(`/sign/${s.tok}/code/check`, { code });
  assert.deepEqual([again.status, again.data.code], [410, 'no_code']);
  // A cookie made up by hand is not a pass.
  const forged = visitor();
  forged.cookies[`ts_vc_${s.rid}`] = 'f'.repeat(64);
  assert.equal((await forged.get(`/sign/${s.tok}`)).data.locked, true);
  // And a pass for one link is no pass for another.
  const s2 = await one(ada, { verify: 'email_code' });
  c.cookies[`ts_vc_${s2.rid}`] = c.cookies[`ts_vc_${s.rid}`];
  assert.equal((await c.get(`/sign/${s2.tok}`)).data.locked, true);

  // The record: sent (with the masked address and the channel), a wrong try, passed.
  const trail = (await full(ada, s.id)).audit;
  const sentLine = trail.find((a: any) => a.action === 'One-time code not delivered');
  assert.match(sentLine.detail, new RegExp(`^Sam Signer: by email to ${maskEmail(s.email).replace(/[*.]/g, '\\$&')}\\. This machine has no mail server`));
  assert.match(trail.find((a: any) => a.action === 'One-time code failed').detail, /Sam Signer: a wrong code was typed for the one sent by email to s\*\*\*@example\.com/);
  assert.match(trail.find((a: any) => a.action === 'One-time code accepted').detail, /Sam Signer: the code sent by email to s\*\*\*@example\.com/);
  for (const a of trail.filter((x: any) => x.action.startsWith('One-time code'))) assert.equal(a.detail.includes(s.email), false, 'the record of a code never holds the whole address');
  // The sender's own view says what will be on the certificate.
  assert.match((await full(ada, s.id)).envelope.recipients[0].check.line, /^One-time code sent by email to s\*\*\*@example\.com, passed \d{1,2} \w+ \d{4} \d\d:\d\d UTC$/);

  // Signed, and the certificate says how this person was checked.
  assert.equal((await finish(c, s.tok)).data.envelope_status, 'completed');
  const cert = await certificate(ada, s.id);
  assert.match(cert, /Identity check One-time code sent by email to s\*\*\*@example\.com, passed \d{1,2} \w+ \d{4} \d\d:\d\d UTC/);
  assert.equal(cert.includes(code), false);
});

test('with a mail server, "sent" is written when it took the code, and our copy of the email no longer holds it', async () => {
  const g = globalThis as any;
  const taken: any[] = [];
  process.env.SMTP_URL = 'smtp://mail.invalid';
  g.__tsmail = { sendMail: async (m: any) => void taken.push(m) };
  try {
    const s = await one(ada, { verify: 'email_code' });
    const c = visitor();
    assert.equal((await c.post(`/sign/${s.tok}/code`)).data.delivery, 'sent');
    const delivered = taken.filter((m) => m.to === s.email).pop();
    const code = /(\d{6}) is your code/.exec(delivered.html)![1];
    assert.match((await line(ada, s.id, 'One-time code sent')).detail, /^Sam Signer: by email to s\*\*\*@example\.com$/);
    const kept = db.get("SELECT html, payload, subject FROM emails WHERE to_email=? AND subject LIKE 'Your code%'", s.email);
    assert.equal(`${kept.html}${kept.payload}${kept.subject}`.includes(code), false, 'our stored copy still held the code');
    assert.equal((await c.post(`/sign/${s.tok}/code/check`, { code })).status, 200);
  } finally {
    delete process.env.SMTP_URL;
    delete g.__tsmail;
  }
});

// ---- 4. The rules of a code ----------------------------------------------------------------------------------------

test('a code works for ten minutes, for five tries, and only the newest one counts', async () => {
  const s = await one(ada, { verify: 'email_code' });
  const c = visitor();
  await c.post(`/sign/${s.tok}/code`);
  const first = emailCode(s.email);
  // Five wrong tries end the code: the right one no longer opens anything, and a new one must be asked for.
  const wrongs = ['111111', '222222', '333333', '444444', '555555'].map((w) => (w === first ? '666666' : w));
  for (let i = 0; i < SIGNER_CODE_TRIES - 1; i++) assert.equal((await c.post(`/sign/${s.tok}/code/check`, { code: wrongs[i] })).status, 401);
  const last = await c.post(`/sign/${s.tok}/code/check`, { code: wrongs[4] });
  assert.deepEqual([last.status, last.data.code], [423, 'spent']);
  assert.match(last.data.error, /typed wrongly 5 times, so it no longer works\. Ask for a new one below\./);
  const late = await c.post(`/sign/${s.tok}/code/check`, { code: first });
  assert.deepEqual([late.status, late.data.code], [423, 'spent']);
  assert.equal((await c.get(`/sign/${s.tok}`)).data.locked, true);
  assert.equal((await actions(ada, s.id)).filter((a: string) => a === 'One-time code failed').length, SIGNER_CODE_TRIES);
  // The sender hears that someone typed five wrong codes, once.
  assert.equal(toAda('Wrong codes: Simple agreement').length, 1);

  // A new code at most once a minute, and the answer says when.
  const soon = await c.post(`/sign/${s.tok}/code`);
  assert.deepEqual([soon.status, soon.data.code], [429, 'wait']);
  assert.ok(soon.data.resend_in > 50 && soon.data.resend_in <= 60);
  assert.match(soon.data.error, /A code was sent less than a minute ago\. You can ask for a new one in \d+ seconds\./);
  assert.ok((await c.get(`/sign/${s.tok}`)).data.check.resend_in > 50);
  older(s.rid, 61);
  assert.equal((await c.post(`/sign/${s.tok}/code`)).status, 200);
  const second = emailCode(s.email);
  // After ten minutes the code has run out.
  older(s.rid, SIGNER_CODE_MINUTES * 60 + 1);
  const expired = await c.post(`/sign/${s.tok}/code/check`, { code: second });
  assert.deepEqual([expired.status, expired.data.code], [410, 'expired']);
  assert.match(expired.data.error, /more than 10 minutes old/);
  // A newer code ends the older one.
  assert.equal((await c.post(`/sign/${s.tok}/code`)).status, 200);
  const third = emailCode(s.email);
  older(s.rid, 61);
  assert.equal((await c.post(`/sign/${s.tok}/code`)).status, 200);
  const fourth = emailCode(s.email);
  if (third !== fourth) assert.equal((await c.post(`/sign/${s.tok}/code/check`, { code: third })).status, 401, 'the older code still opened the document');
  assert.equal((await c.post(`/sign/${s.tok}/code/check`, { code: fourth })).status, 200);
});

test('codes are limited for a recipient, for a caller and for a mailbox, each with words that say when', async () => {
  // Five an hour for one recipient, however long the person waits in between.
  const s = await one(ada, { verify: 'email_code' });
  const c = visitor();
  for (let i = 0; i < SIGNER_CODES_PER_HOUR; i++) {
    assert.equal((await c.post(`/sign/${s.tok}/code`)).status, 200, `code ${i + 1}`);
    older(s.rid, 120);
  }
  const sixth = await c.post(`/sign/${s.tok}/code`);
  assert.deepEqual([sixth.status, sixth.data.code], [429, 'wait']);
  assert.match(sixth.data.error, /5 codes were sent for this document in the last hour, which is the most we send\. You can ask for a new one in \d+ minutes\./);
  assert.ok(sixth.data.resend_in > 60, 'the wait is until the hour has room again, not a minute');
  assert.equal((await c.get(`/sign/${s.tok}`)).data.check.resend_in, sixth.data.resend_in);
  older(s.rid, 3600);
  assert.equal((await c.post(`/sign/${s.tok}/code`)).status, 200);

  // One caller over many links: an address cannot work its way through every document it holds a link to.
  const caller = visitor();
  const links: string[] = [];
  for (let i = 0; i < SIGNER_CODES_PER_CALLER_HOUR + 1; i++) links.push((await one(ada, { verify: 'email_code' })).tok);
  for (let i = 0; i < SIGNER_CODES_PER_CALLER_HOUR; i++) assert.equal((await caller.post(`/sign/${links[i]}/code`)).status, 200, `link ${i + 1}`);
  const tooMany = await caller.post(`/sign/${links[SIGNER_CODES_PER_CALLER_HOUR]}/code`);
  assert.deepEqual([tooMany.status, tooMany.data.code], [429, 'wait_caller']);
  assert.match(tooMany.data.error, /codes were asked for from your internet connection in the last hour/);
  // Somebody else, from somewhere else, is not held up by that.
  assert.equal((await visitor().post(`/sign/${links[SIGNER_CODES_PER_CALLER_HOUR]}/code`)).status, 200);

  // One mailbox over many documents and many callers: a sender cannot fill it with codes.
  const box = fresh('flooded');
  let sentTo = 0;
  for (let i = 0; i < SIGNER_CODES_PER_DESTINATION_DAY + 1; i++) {
    const x = await one(ada, { verify: 'email_code', email: box });
    const res = await visitor().post(`/sign/${x.tok}/code`);
    if (i < SIGNER_CODES_PER_DESTINATION_DAY) (assert.equal(res.status, 200, `document ${i + 1}`), sentTo++);
    else {
      assert.deepEqual([res.status, res.data.code], [429, 'wait_destination']);
      assert.match(res.data.error, /15 codes have gone to f\*\*\*@example\.com in the last 24 hours, which is the most we send to one mailbox in a day/);
      assert.equal(res.data.error.includes(box), false);
    }
  }
  assert.equal(mailTo(box).filter((m) => m.subject.startsWith('Your code')).length, sentTo);
});

// ---- 5. A code by text message ------------------------------------------------------------------------------------

test('a code by text message goes to the number the sender typed, masked on every screen, and the certificate says so', async () => {
  const s = await one(ada, { verify: 'sms_code', phone: UK }, { subject: 'Boat sale' });
  const c = visitor();
  const v = (await c.get(`/sign/${s.tok}`)).data;
  assert.deepEqual([v.needs, v.check.kind, v.check.to], ['code', 'sms_code', UK_MASKED]);
  assert.equal(JSON.stringify(v).includes('7700'), false, 'the number was given away');
  const sent = await c.post(`/sign/${s.tok}/code`);
  assert.deepEqual([sent.status, sent.data.to, sent.data.kind], [200, UK_MASKED, 'sms_code']);
  assert.equal(JSON.stringify(sent.data).includes('7700'), false);
  // The text: short, the code first, who the document is from, not what it is, and the line phones read to offer
  // the code on this site only.
  const [t] = texts(s.rid);
  const code = textCode(s.rid);
  assert.match(t.body, new RegExp(`^${code} is your Sign&Grow code to open a document from Ada Sender\\. It works for 10 minutes\\. Did not ask for it\\? Ignore this text\\.\\n\\n@test\\.local #${code}$`));
  assert.equal(t.body.includes('Boat sale'), false);
  assert.ok(t.body.length <= 160, `one text, not two: ${t.body.length}`);
  // The number is kept on the recipient and nowhere else: the text's own row has it masked.
  assert.deepEqual([t.kind, t.status, t.to_phone, t.to_masked], ['code', 'outbox', null, UK_MASKED]);
  assert.equal(db.get('SELECT phone FROM recipients WHERE id=?', s.rid).phone, '+447700900123');
  for (const table of ['texts', 'signer_codes', 'sms_usage', 'contacts', 'reached', 'audit']) assert.equal(JSON.stringify(db.all(`SELECT * FROM ${table}`)).includes('447700900123'), false, `${table} holds the number`);
  // Nothing the sender can read holds the code, and the record of texts shows the number masked and no text.
  const d = await full(ada, s.id);
  assert.equal(JSON.stringify(d).includes(code), false);
  assert.deepEqual([d.texts[0].kind, d.texts[0].to, d.texts[0].status, 'body' in d.texts[0]], ['code', UK_MASKED, 'outbox', false]);
  // Typed in: open, and on the record with the channel and the masked number.
  assert.equal((await c.post(`/sign/${s.tok}/code/check`, { code })).status, 200);
  assert.equal((await c.get(`/sign/${s.tok}`)).data.envelope.subject, 'Boat sale');
  assert.match((await line(ada, s.id, 'One-time code accepted')).detail, /Sam Signer: the code sent by text message to \+44 \*\*\* \*\*\* 0123/);
  assert.match((await line(ada, s.id, 'One-time code not delivered')).detail, /by text message to \+44 \*\*\* \*\*\* 0123\. This machine has no text message provider/);
  assert.equal((await finish(c, s.tok)).data.envelope_status, 'completed');
  assert.match(await certificate(ada, s.id), /Identity check One-time code sent by text message to \+44 \*\*\* \*\*\* 0123, passed \d{1,2} \w+ \d{4} \d\d:\d\d UTC/);
  // The page that shows a completed document to anyone holding the PDF gives no number away either.
  assert.equal((await certificate(ada, s.id)).includes('7700'), false);
});

test('the certificate says "Link sent by email only" when there was no check, and says so when a code was never typed', async () => {
  const file = await upload(ada, 1);
  const emails = [fresh('plain'), fresh('coded'), fresh('copy')];
  const e = (await ada.post('/envelopes', {
    subject: 'Three ways in', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [
      { id: 'a', role: 'signer', name: 'Pat Plain', email: emails[0] },
      { id: 'b', role: 'signer', name: 'Cody Coded', email: emails[1], access_code: '4242' },
      { id: 'c', role: 'cc', name: 'Cee Copy', email: emails[2], verify: 'email_code' },
    ],
    fields: [{ document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }],
  })).data.envelope;
  assert.equal((await finish(visitor(), tokenFor(e.id, emails[0]))).status, 200);
  const cody = visitor();
  assert.equal((await cody.post(`/sign/${tokenFor(e.id, emails[1])}/unlock`, { code: '4242' })).status, 200);
  assert.equal((await finish(cody, tokenFor(e.id, emails[1]))).data.envelope_status, 'completed');
  const lines = Object.fromEntries((await full(ada, e.id)).envelope.recipients.map((r: any) => [r.name, r.check.line]));
  assert.equal(lines['Pat Plain'], 'Link sent by email only');
  assert.equal(lines['Cody Coded'], 'Link sent by email and an access code chosen by the sender');
  // Someone who was sent a copy and never opened it never typed a code, and nothing claims they did.
  assert.equal(lines['Cee Copy'], 'Link sent by email. A one-time code by email was asked for and was not passed');
  const cert = await certificate(ada, e.id);
  assert.match(cert, /Identity check Link sent by email only/);
  assert.match(cert, /Identity check Link sent by email and an access code chosen by the sender/);
  // The copy still asks for its code before it shows the completed document.
  const cee = visitor();
  const ceeTok = tokenFor(e.id, emails[2]);
  assert.equal((await cee.get(`/sign/${ceeTok}/download`)).status, 401);
  await pass(cee, { tok: ceeTok, rid: '', email: emails[2] });
  assert.equal((await cee.get(`/sign/${ceeTok}/download`)).status, 200);
});

test('an access code and a one-time code together: the access code comes first, and nothing is sent before it', async () => {
  const s = await one(ada, { verify: 'sms_code', phone: UK, access_code: '4242' }, { subject: 'Both locks' });
  const c = visitor();
  const v = (await c.get(`/sign/${s.tok}`)).data;
  // The access code screen of someone who also has to pass a code is told as little as the code screen.
  assert.deepEqual([v.locked, v.needs, v.code_next, v.check, v.envelope.subject, v.recipient.email], [true, 'access_code', true, undefined, '', maskEmail(s.email)]);
  // A stranger with only the link cannot make us text anyone.
  for (const path of ['/code', '/code/check', '/code/problem']) {
    const res = await c.post(`/sign/${s.tok}${path}`, { code: '123456', what: 'no_code' });
    assert.deepEqual([res.status, res.data.error], [401, 'Enter the access code first.'], path);
  }
  assert.equal(texts(s.rid).length, 0);
  assert.equal((await c.post(`/sign/${s.tok}/unlock`, { code: '4242' })).status, 200);
  const next = (await c.get(`/sign/${s.tok}`)).data;
  assert.deepEqual([next.locked, next.needs, next.check.to, next.envelope.subject], [true, 'code', UK_MASKED, '']);
  assert.equal((await c.get(`/sign/${s.tok}/download`)).status, 401);
  await pass(c, s, 'text');
  assert.equal((await c.get(`/sign/${s.tok}`)).data.envelope.subject, 'Both locks');
  await finish(c, s.tok);
  assert.match(await certificate(ada, s.id), /One-time code sent by text message to \+44 \*\*\* \*\*\* 0123, passed [^.]+ UTC\. Also an access code chosen by the sender/);
});

test('"This is not my number" and "I do not get the code" tell the sender, and the wrong number is left alone', async () => {
  const s = await one(ada, { verify: 'sms_code', phone: UK }, { subject: 'Wrong number lease' });
  const c = visitor();
  await c.post(`/sign/${s.tok}/code`);
  const code = textCode(s.rid);
  const before = toAda('Code did not arrive').length;
  const none = await c.post(`/sign/${s.tok}/code/problem`, { what: 'no_code' });
  assert.deepEqual([none.status, none.data.told, none.data.stopped], [200, true, false]);
  const told = toAda('Code did not arrive: Wrong number lease');
  assert.equal(told.length, before + 1);
  assert.match(told.pop()!.html, /does not arrive.*Check that the number is right.*choose Correct next to their name.*make sure you are dealing with the right person/s);
  assert.match((await line(ada, s.id, 'One-time code: did not arrive')).detail, /said the code sent by text message to \+44 \*\*\* \*\*\* 0123 did not arrive/);
  // Not my number: no further code goes to it, also not the one that was on its way, until the sender corrects it.
  const mine = await c.post(`/sign/${s.tok}/code/problem`, { what: 'not_mine' });
  assert.deepEqual([mine.status, mine.data.stopped], [200, true]);
  assert.match(toAda('Wrong number: Wrong number lease').pop()!.html, /is not their number\. We have stopped sending codes to it/);
  assert.equal((await c.get(`/sign/${s.tok}`)).data.check.stopped, true);
  assert.equal((await c.post(`/sign/${s.tok}/code/check`, { code })).status, 410, 'the code that went to the wrong number still worked');
  older(s.rid, 120);
  const refused = await c.post(`/sign/${s.tok}/code`);
  assert.deepEqual([refused.status, refused.data.code], [409, 'stopped']);
  assert.match(refused.data.error, /No code is sent to \+44 \*\*\* \*\*\* 0123 any more, because someone using this link said it is not their number\. Ada Sender has been told and has to put in the right number/);
  assert.equal(texts(s.rid).length, 1);
  assert.equal((await full(ada, s.id)).envelope.recipients[0].check.stopped, true);
  // Only a few a day, so a link cannot be used to fill the sender's inbox.
  assert.equal((await c.post(`/sign/${s.tok}/code/problem`, { what: 'no_code' })).status, 200);
  assert.equal((await c.post(`/sign/${s.tok}/code/problem`, { what: 'no_code' })).status, 429);
  // Neither choice is offered for the wrong kind of check, and a made-up one is refused.
  const m = await one(ada, { verify: 'email_code' });
  assert.equal((await visitor().post(`/sign/${m.tok}/code/problem`, { what: 'not_mine' })).status, 400);
  assert.equal((await visitor().post(`/sign/${m.tok}/code/problem`, { what: 'whatever' })).status, 400);
  // The sender puts the right number in. Codes go out again, to the new number.
  const fix = await ada.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, phone: '+44 7700 900999' });
  assert.equal(fix.status, 200, JSON.stringify(fix.data));
  assert.equal((await c.get(`/sign/${s.tok}`)).data.check.stopped, false);
  const again = await c.post(`/sign/${s.tok}/code`);
  assert.deepEqual([again.status, again.data.to], [200, '+44 *** *** 0999']);
});

// ---- 6. A real provider: Twilio and the generic hook -----------------------------------------------------------

test('Twilio is called with the account, the token, the sender and the text, and a text it took is not kept readable', async () => {
  provider({ TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'twilio-secret', TWILIO_FROM: '+15550100' });
  sms.calls.length = 0;
  try {
    const s = await one(ada, { verify: 'sms_code', phone: UK });
    const c = visitor();
    const sent = await c.post(`/sign/${s.tok}/code`);
    assert.deepEqual([sent.status, sent.data.delivery], [200, 'sent']);
    assert.equal(sms.calls.length, 1);
    const call = sms.calls[0];
    assert.equal(call.url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    assert.equal(call.headers.authorization, `Basic ${Buffer.from('AC123:twilio-secret').toString('base64')}`);
    assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
    const p = new URLSearchParams(call.body);
    assert.deepEqual([p.get('To'), p.get('From'), p.get('MessagingServiceSid')], ['+447700900123', '+15550100', null]);
    const code = /^(\d{6}) is your Sign&Grow code/.exec(p.get('Body')!)![1];
    // Once the provider has it: "sent" on the record, and our own row holds neither the code nor the number.
    assert.match((await line(ada, s.id, 'One-time code sent')).detail, /^Sam Signer: by text message to \+44 \*\*\* \*\*\* 0123$/);
    const [row] = texts(s.rid);
    assert.deepEqual([row.status, row.to_phone, row.provider, row.provider_id], ['sent', null, 'twilio', 'SM1']);
    assert.equal(row.body.includes(code), false);
    assert.equal(JSON.stringify(sent.data).includes(code), false);
    assert.equal((await c.post(`/sign/${s.tok}/code/check`, { code })).status, 200);

    // A messaging service wins over a number when both are set.
    process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG999';
    const s2 = await one(ada, { verify: 'sms_code', phone: '+1 415 555 0101' });
    await visitor().post(`/sign/${s2.tok}/code`);
    const p2 = new URLSearchParams(sms.calls.pop()!.body);
    assert.deepEqual([p2.get('To'), p2.get('MessagingServiceSid'), p2.get('From')], ['+14155550101', 'MG999', null]);
  } finally {
    provider({ SMS_DEV_OUTBOX: '1' });
  }
});

test('any other provider gets one POST with { to, text } and the bearer token', async () => {
  provider({ SMS_WEBHOOK_URL: 'https://texts.provider.test/send', SMS_WEBHOOK_TOKEN: 'hook-secret' });
  sms.calls.length = 0;
  try {
    const s = await one(ada, { verify: 'sms_code', phone: UK });
    const sent = await visitor().post(`/sign/${s.tok}/code`);
    assert.deepEqual([sent.status, sent.data.delivery], [200, 'sent']);
    const call = sms.calls[0];
    assert.equal(call.url, 'https://texts.provider.test/send');
    assert.equal(call.headers.authorization, 'Bearer hook-secret');
    assert.equal(call.headers['content-type'], 'application/json');
    const body = JSON.parse(call.body);
    assert.deepEqual(Object.keys(body).sort(), ['text', 'to']);
    assert.equal(body.to, '+447700900123');
    assert.match(body.text, /^\d{6} is your Sign&Grow code/);
    assert.deepEqual([texts(s.rid)[0].status, texts(s.rid)[0].provider, texts(s.rid)[0].provider_id], ['sent', 'hook', 'msg-1']);
  } finally {
    provider({ SMS_DEV_OUTBOX: '1' });
  }
});

test('a provider that fails: the signer is told at once, it is tried again by the timer, and a refusal is final and told to the sender', async () => {
  provider({ TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'twilio-secret', TWILIO_FROM: '+15550100' });
  sms.calls.length = 0;
  try {
    // The provider is down. Nothing claims a text was sent, and the person can ask again.
    const s = await one(ada, { verify: 'sms_code', phone: UK }, { subject: 'Down for a moment' });
    const c = visitor();
    sms.answers.push({ status: 503, body: { message: 'Service unavailable' } });
    const failed = await c.post(`/sign/${s.tok}/code`);
    assert.deepEqual([failed.status, failed.data.code], [502, 'not_sent']);
    assert.match(failed.data.error, /We could not send the code just now\. That is nothing you did, and nothing you filled in is lost\. Try again in a minute\./);
    let [row] = texts(s.rid);
    assert.deepEqual([row.status, row.tries, !!row.next_try_at, row.to_phone], ['failed', 1, true, '+447700900123']);
    assert.match(row.error, /answered 503: Service unavailable/);
    const trail = await actions(ada, s.id);
    assert.equal(trail.includes('One-time code sent'), false);
    assert.ok(trail.includes('Text could not be sent yet') && trail.includes('One-time code could not be sent'));
    assert.match((await line(ada, s.id, 'Text could not be sent yet')).detail, /A one-time code by text message to Sam Signer, \+44 \*\*\* \*\*\* 0123\. What went wrong: The text message provider answered 503: Service unavailable\. It is tried again automatically while the code still works\./);
    // The timer leaves it alone until it is due, then tries again while the code still works.
    assert.deepEqual((await cron.tick()).texts, { sent: 0, failed: 0, dropped: 0 });
    db.run("UPDATE texts SET next_try_at=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), row.id);
    assert.deepEqual((await cron.tick()).texts, { sent: 1, failed: 0, dropped: 0 });
    [row] = texts(s.rid);
    assert.deepEqual([row.status, row.tries, row.to_phone], ['sent', 2, null]);
    assert.match((await line(ada, s.id, 'Text sent')).detail, /on try 2/);
    const code = /^(\d{6}) /.exec(new URLSearchParams(sms.calls.pop()!.body).get('Body')!)![1];
    assert.equal((await c.post(`/sign/${s.tok}/code/check`, { code })).status, 200, 'the code that arrived late did not work');

    // A code that has been replaced or has run out is not sent late.
    const s2 = await one(ada, { verify: 'sms_code', phone: '+44 7700 900222' });
    sms.answers.push({ status: 500, body: {} });
    await visitor().post(`/sign/${s2.tok}/code`);
    older(s2.rid, 61);
    assert.equal((await visitor().post(`/sign/${s2.tok}/code`)).status, 200);
    db.run("UPDATE texts SET next_try_at=? WHERE recipient_id=? AND status='failed'", new Date(Date.now() - 1000).toISOString(), s2.rid);
    const calls = sms.calls.length;
    assert.deepEqual((await cron.tick()).texts, { sent: 0, failed: 0, dropped: 1 });
    assert.equal(sms.calls.length, calls, 'an old code was texted after a newer one');

    // A number the provider refuses: no second try, the sender is told at once with what went wrong, and the
    // number in the provider's own words is masked before it reaches the record.
    const s3 = await one(ada, { verify: 'sms_code', phone: '+44 7700 900333' }, { subject: 'Not a mobile' });
    sms.answers.push({ status: 400, body: { code: 21211, message: "The 'To' number +447700900333 is not a valid phone number." } });
    const refused = await visitor().post(`/sign/${s3.tok}/code`);
    assert.equal(refused.status, 502);
    const [r3] = texts(s3.rid);
    assert.deepEqual([r3.status, r3.next_try_at, r3.to_phone], ['failed', null, null]);
    assert.equal(r3.error.includes('900333'), false);
    const final = await line(ada, s3.id, 'Text could not be sent');
    assert.match(final.detail, /The 'To' number \+44 \*\*\* \*\*\* 0333 is not a valid phone number \(its code 21211\)\. No more tries are made\./);
    const mail = toAda('Text not delivered: Not a mobile').pop()!;
    assert.match(mail.html, /could not be handed to the text message provider, so we have stopped trying.*cannot open the document until a code reaches them\. Check the number/s);
    assert.equal(mail.html.includes('900333'), false);
    const d = await full(ada, s3.id);
    assert.deepEqual([d.texts[0].status, d.texts[0].next_try_at], ['failed', null]);
  } finally {
    provider({ SMS_DEV_OUTBOX: '1' });
    sms.answers.length = 0;
  }
});

// ---- 7. Texting the signing link -------------------------------------------------------------------------------------

test('"also text the signing link" is off unless chosen, and the text names the sender, the document and Sign&Grow', async () => {
  const quiet = await one(ada, { phone: UK });
  assert.equal(texts(quiet.rid).length, 0, 'a number alone texts nobody');
  const s = await one(ada, { phone: UK, text_link: true }, { subject: 'Allotment rules 2026' });
  const [t] = texts(s.rid);
  assert.deepEqual([t.kind, t.status, t.to_masked, t.to_phone], ['link', 'outbox', UK_MASKED, null]);
  assert.equal(t.body, `Sign&Grow, sent for Ada Sender: "Allotment rules 2026" is waiting for you to sign. http://test.local/sign/${s.tok}`);
  assert.match((await line(ada, s.id, 'Not texted')).detail, /Sam Signer, to \+44 \*\*\* \*\*\* 0123\. This machine has no text message provider/);
  // With a provider the record says it was sent.
  provider({ SMS_WEBHOOK_URL: 'https://texts.provider.test/send' });
  try {
    const live = await one(ada, { phone: '+44 7700 900444', text_link: true });
    assert.match((await line(ada, live.id, 'Signing link sent by text message')).detail, /^Sam Signer, to \+44 \*\*\* \*\*\* 0444$/);
    assert.equal(sms.calls.pop()!.headers.authorization, undefined, 'no token set, none sent');
  } finally {
    provider({ SMS_DEV_OUTBOX: '1' });
  }
  // A long subject and a long name are cut, so the link always fits.
  const long = await one(ada, { phone: '+44 7700 900555', text_link: true }, { subject: 'An agreement with a very long title that goes on and on about nothing in particular at all' });
  assert.match(texts(long.rid)[0].body, /"An agreement with a very long title that goes on and on a\.\.\." is waiting/);

  // Reminders by text follow at most once a day, however often the sender nudges.
  db.run('UPDATE recipients SET texted_at=? WHERE id=?', new Date(Date.now() - 25 * 3600_000).toISOString(), s.rid);
  assert.equal((await ada.post(`/envelopes/${s.id}/remind`)).data.reminded, 1);
  assert.equal((await ada.post(`/envelopes/${s.id}/remind`)).data.reminded, 1);
  const mine = texts(s.rid);
  assert.deepEqual(mine.map((x: any) => x.kind), ['link', 'reminder']);
  assert.equal(mine[1].body, `Reminder from Sign&Grow, sent for Ada Sender: "Allotment rules 2026" is still waiting for you to sign. http://test.local/sign/${s.tok}`);
  assert.equal(mailTo(s.email).filter((m) => m.subject.startsWith('Reminder:')).length, 2, 'the email reminder is not held to once a day');
  // Someone who turned reminders off gets none by text either.
  db.run('UPDATE recipients SET texted_at=NULL, muted=1 WHERE id=?', s.rid);
  await ada.post(`/envelopes/${s.id}/remind`);
  assert.equal(texts(s.rid).length, 2);
});

test('a recipient who reports the document or declines gets no more texts, and a paused sender texts nobody', async () => {
  const bo = await signUp('Bo Sender', 'bo.sender@example.com', ip());
  const s = await one(bo, { phone: '+44 7700 900666', text_link: true });
  assert.equal(texts(s.rid).length, 1);
  assert.equal((await visitor().post(`/sign/${s.tok}/report`, { reason: 'spam' })).status, 200);
  db.run('UPDATE recipients SET texted_at=NULL WHERE id=?', s.rid);
  await bo.post(`/envelopes/${s.id}/remind`);
  assert.equal(texts(s.rid).length, 1, 'someone who reported the document was texted again');

  // In a signing order: the second person declines before... no, they can only decline once it is their turn. So:
  // two people at once, one declines, and nothing more goes to either by text.
  const file = await upload(bo, 1);
  const emails = [fresh('dee'), fresh('eli')];
  const e = (await bo.post('/envelopes', {
    subject: 'Two at once', send: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'a', role: 'signer', name: 'Dee', email: emails[0], phone: '+44 7700 900701', text_link: true }, { id: 'b', role: 'signer', name: 'Eli', email: emails[1], phone: '+44 7700 900702', text_link: true }],
    fields: [{ document_id: 'd', recipient_id: 'a', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { document_id: 'd', recipient_id: 'b', type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }],
  })).data.envelope;
  const count = () => db.get('SELECT COUNT(*) n FROM texts WHERE envelope_id=?', e.id).n;
  assert.equal(count(), 2);
  assert.equal((await visitor().post(`/sign/${tokenFor(e.id, emails[0])}/decline`, { reason: 'Not for me' })).status, 200);
  assert.equal((await bo.post(`/envelopes/${e.id}/remind`)).status, 400, 'a declined envelope is closed');
  assert.equal(count(), 2);

  // Paused: the email is held back by the same guard, and no text goes out either.
  const p = await one(bo, { phone: '+44 7700 900777', text_link: true });
  const account = db.get("SELECT a.id FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email='bo.sender@example.com'").id;
  db.run("UPDATE accounts SET suspended_at=?, suspended_reason='reports' WHERE id=?", new Date().toISOString(), account);
  db.run('UPDATE recipients SET texted_at=NULL WHERE id=?', p.rid);
  assert.equal((await bo.post(`/envelopes/${p.id}/remind`)).status, 403);
  await cron.tick();
  assert.equal(texts(p.rid).length, 1, 'a paused sender still texted');
  // A code is something the signer asks for, for a document they already have: that still works while paused.
  const coded = db.get('SELECT id FROM recipients WHERE id=?', p.rid);
  db.run("UPDATE recipients SET verify='sms_code' WHERE id=?", coded.id);
  assert.equal((await visitor().post(`/sign/${p.tok}/code`)).status, 200);
  db.run('UPDATE accounts SET suspended_at=NULL WHERE id=?', account);
});

// ---- 8. Money: the daily limits ------------------------------------------------------------------------------------

test('SMS_DAILY_PER_ACCOUNT is a hard stop: every new text counts, also a code that is asked for again', async () => {
  const cy = await signUp('Cy Sender', 'cy.sender@example.com', ip());
  process.env.SMS_DAILY_PER_ACCOUNT = '3';
  try {
    const a = await one(cy, { verify: 'sms_code', phone: '+44 7700 900801', text_link: true }); // 1: the link
    const c = visitor();
    assert.equal((await c.post(`/sign/${a.tok}/code`)).status, 200); // 2: a code
    older(a.rid, 61);
    assert.equal((await c.post(`/sign/${a.tok}/code`)).status, 200); // 3: the code again
    assert.equal(db.get("SELECT COUNT(*) n FROM sms_usage WHERE account_id=(SELECT account_id FROM envelopes WHERE id=?)", a.id).n, 3);
    // The fourth is refused to the signer in words that blame nobody in the room, and the sender is told why.
    older(a.rid, 61);
    const fourth = await c.post(`/sign/${a.tok}/code`);
    assert.deepEqual([fourth.status, fourth.data.code], [503, 'unavailable']);
    assert.match(fourth.data.error, /That is nothing you did: the account this document was sent from has sent as many text messages as this server allows in a day \(3\)\. Cy Sender has been told/);
    assert.equal(texts(a.rid).length, 3);
    const told = mailTo('cy.sender@example.com').filter((m) => m.subject.startsWith('Cannot open:'));
    assert.equal(told.length, 1);
    assert.match(told[0].html, /We did not send it, because the account this document was sent from has sent as many text messages as this server allows in a day \(3\)/);
    // Asked again: still refused, and the sender is not told a second time the same day.
    assert.equal((await c.post(`/sign/${a.tok}/code`)).status, 503);
    assert.equal(mailTo('cy.sender@example.com').filter((m) => m.subject.startsWith('Cannot open:')).length, 1);
    // Sending something new that needs a text is refused with what to do. Without texts it goes out.
    const more = await tryOne(cy, { phone: '+44 7700 900802', text_link: true });
    assert.equal(more.status, 429);
    assert.match(more.data.error, /This account has used all 3 text messages this server sends for one account in a day\. Nothing was sent\. There is room again in about 24 hours.*To send now, do it without text messages/);
    assert.equal((await tryOne(cy, { verify: 'email_code' })).status, 200);
    // Voiding and deleting hands nothing back: the count is not the envelopes.
    await cy.post(`/envelopes/${a.id}/void`, { reason: 'Start again' });
    assert.equal((await cy.call('DELETE', `/envelopes/${a.id}`)).status, 200);
    assert.equal((await tryOne(cy, { phone: '+44 7700 900802', text_link: true })).status, 429);
    // A day later there is room again.
    db.run('UPDATE sms_usage SET at=?', new Date(Date.now() - 25 * 3600_000).toISOString());
    assert.equal((await tryOne(cy, { phone: '+44 7700 900802', text_link: true })).status, 200);
    // Zero lets none through, and says that this is the operator's setting.
    process.env.SMS_DAILY_PER_ACCOUNT = '0';
    assert.match((await tryOne(cy, { phone: '+44 7700 900803', text_link: true })).data.error, /set the number of text messages an account can send in a day to zero/);
  } finally {
    delete process.env.SMS_DAILY_PER_ACCOUNT;
  }
});

test('a text counts like an email to that person: an account under the daily limit can text only that many numbers, and one number only gets so many', async () => {
  const di = await signUp('Di Sender', 'di.sender@example.com', ip());
  process.env.NEW_ACCOUNT_DAILY_RECIPIENTS = '2';
  try {
    // One address with many numbers under it would walk round the limit on people. It does not.
    const box = fresh('shared');
    assert.equal((await tryOne(di, { email: box, phone: '+44 7700 900901', text_link: true })).status, 200);
    assert.equal((await tryOne(di, { email: box, phone: '+44 7700 900902', text_link: true })).status, 200);
    const third = await tryOne(di, { email: box, phone: '+44 7700 900903', text_link: true });
    assert.equal(third.status, 429);
    assert.match(third.data.error, /In its first week, an account that has not paid can text 2 phone numbers a day, as many as the people it can email\. This account has texted 2 in the last 24 hours and this would add 1\. Nothing was sent\./);
    // A number that was already texted today is not counted again.
    assert.equal((await tryOne(di, { email: box, phone: '+44 7700 900901', text_link: true })).status, 200);
    // A code for a number over the limit is not sent either, whichever way it is asked for.
    const s = await one(di, { email: box, verify: 'email_code' });
    db.run("UPDATE recipients SET verify='sms_code', phone='+447700900904' WHERE id=?", s.rid);
    assert.equal((await visitor().post(`/sign/${s.tok}/code`)).status, 503);
    assert.equal(texts(s.rid).length, 0);
  } finally {
    delete process.env.NEW_ACCOUNT_DAILY_RECIPIENTS;
  }
  // Texts about documents to one number are held to a few a day, whatever the sender does to cause them.
  const el = await signUp('El Sender', 'el.sender@example.com', ip());
  const number = '+44 7700 900950';
  let sent = 0;
  for (let i = 0; i < LINK_TEXTS_PER_NUMBER_DAY + 2; i++) {
    const x = await one(el, { phone: number, text_link: true }, { subject: 'Again and again' });
    sent += texts(x.rid).length;
    if (i === LINK_TEXTS_PER_NUMBER_DAY) {
      assert.match((await line(el, x.id, 'Text not sent')).detail, /the signing link by text message to \+44 \*\*\* \*\*\* 0950 was not sent, because 4 texts about documents have gone to this number from this account in the last 24 hours/);
      assert.equal(mailTo('el.sender@example.com').filter((m) => m.subject.startsWith('Text not sent:')).length, 1);
    }
  }
  assert.equal(sent, LINK_TEXTS_PER_NUMBER_DAY);
});

// ---- 9. Corrections --------------------------------------------------------------------------------------------------

test('correcting one person: a new number or a new check makes every device pass again and is on the record', async () => {
  const s = await one(ada, { verify: 'sms_code', phone: UK }, { subject: 'Corrected lease' });
  const c = visitor();
  await pass(c, s, 'text');
  assert.equal((await c.get(`/sign/${s.tok}`)).data.locked, false);
  assert.ok((await full(ada, s.id)).envelope.recipients[0].check.passed_at);
  // A number that is not one is refused and nothing changes.
  const bad = await ada.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, phone: '0770' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /"0770", the mobile number of Sam Signer, is not a number we can text/);
  assert.equal((await c.get(`/sign/${s.tok}`)).data.locked, false);
  // The number changes: the link stays, the pass does not.
  const fix = await ada.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, phone: '+44 7700 900124' });
  assert.equal(fix.status, 200, JSON.stringify(fix.data));
  const v = (await c.get(`/sign/${s.tok}`)).data;
  assert.deepEqual([v.locked, v.check.to, v.check.sent], [true, '+44 *** *** 0124', false]);
  const r = (await full(ada, s.id)).envelope.recipients[0];
  assert.deepEqual([r.phone, r.check.passed_at, r.check.line], ['+447700900124', null, 'Link sent by email. A one-time code by text message was asked for and was not passed']);
  const said = (await line(ada, s.id, 'Check corrected')).detail;
  assert.match(said, /mobile number changed from \+44 \*\*\* \*\*\* 0123 to \+44 \*\*\* \*\*\* 0124, the one-time code that was passed on \d{1,2} \w+ \d{4} \d\d:\d\d UTC no longer counts, and a new one is asked for\./);
  assert.equal(said.includes('7700'), false);
  // A code that was on its way to the old number is dead.
  await pass(c, s, 'text');
  // The kind of check changes: passed again.
  assert.equal((await ada.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, verify: 'email_code' })).status, 200);
  const v2 = (await c.get(`/sign/${s.tok}`)).data;
  assert.deepEqual([v2.locked, v2.check.kind, v2.check.to], [true, 'email_code', maskEmail(s.email)]);
  assert.match((await line(ada, s.id, 'Check corrected')).detail, /check before the document opens changed from a one-time code by text message to a one-time code by email/);
  // Taken off: the document opens with the link alone again, and the record says who decided that.
  assert.equal((await ada.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, verify: 'none' })).status, 200);
  assert.equal((await visitor().get(`/sign/${s.tok}`)).data.locked, false);
  assert.match((await line(ada, s.id, 'Check corrected')).detail, /changed from a one-time code by email to no extra check/);
  // A name fix alone changes nothing about the check and writes no line about it.
  const lines = (await actions(ada, s.id)).filter((a: string) => a === 'Check corrected').length;
  assert.equal((await ada.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, name: 'Sam Signer-Smith', email: s.email })).status, 200);
  assert.equal((await actions(ada, s.id)).filter((a: string) => a === 'Check corrected').length, lines);
});

test('another person at another address: the number has to be said again, and the first person\'s pass does not count', async () => {
  const s = await one(ada, { verify: 'sms_code', phone: UK, text_link: true }, { subject: 'Swapped' });
  const c = visitor();
  await pass(c, s, 'text');
  const swapTo = fresh('newperson');
  // The address alone: refused, or the new person's code and link would go to the first person's phone.
  const silent = await ada.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, name: 'Nia New', email: swapTo });
  assert.equal(silent.status, 400);
  assert.match(silent.data.error, /another email address, so to another person, and the mobile number on file was typed for Sam Signer\. Send "phone" with the new person's number/);
  assert.equal(db.get('SELECT email FROM recipients WHERE id=?', s.rid).email, s.email, 'nothing was changed');
  const before = texts(s.rid).length;
  const swapped = await ada.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, name: 'Nia New', email: swapTo, phone: '+44 7700 900200' });
  assert.equal(swapped.status, 200, JSON.stringify(swapped.data));
  // The new link is texted to the new number only, and it is locked for everyone, also for the first person's browser.
  const added = texts(s.rid).slice(before);
  assert.deepEqual(added.map((t: any) => [t.kind, t.to_masked]), [['link', '+44 *** *** 0200']]);
  const tok = tokenFor(s.id, swapTo);
  assert.notEqual(tok, s.tok);
  assert.equal((await c.get(`/sign/${s.tok}`)).status, 410);
  assert.equal((await c.get(`/sign/${tok}`)).data.locked, true);
  const r = (await full(ada, s.id)).envelope.recipients[0];
  assert.deepEqual([r.check.passed_at, r.phone], [null, '+447700900200']);
  assert.match((await line(ada, s.id, 'Check corrected')).detail, /Nia New <newperson\d+@example\.com>: mobile number changed from \+44 \*\*\* \*\*\* 0123 to \+44 \*\*\* \*\*\* 0200, the one-time code that was passed on .* no longer counts, and a new one is asked for\./);

  // The same through the editor's save (PUT): refused without the number, and with it the audit line says it all.
  const e = (await full(ada, s.id)).envelope;
  const body = (rcp: any) => ({ documents: e.documents, fields: e.fields, recipients: [{ id: r.id, role: 'signer', ...rcp }] });
  const other = fresh('third');
  const put = await ada.put(`/envelopes/${s.id}`, body({ name: 'Tom Third', email: other }));
  assert.equal(put.status, 400);
  assert.match(put.data.error, /Recipient 1 \(Tom Third\) now has another email address, so this is another person, and the mobile number on file was typed for Nia New/);
  const ok = await ada.put(`/envelopes/${s.id}`, body({ name: 'Tom Third', email: other, verify: 'email_code', phone: '', text_link: false }));
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual([ok.data.envelope.recipients[0].verify, ok.data.envelope.recipients[0].phone, ok.data.envelope.recipients[0].text_link], ['email_code', null, false]);
  assert.match((await line(ada, s.id, 'Envelope corrected')).detail, /check before the document opens changed from a one-time code by text message to a one-time code by email, mobile number \+44 \*\*\* \*\*\* 0200 removed, the signing link is no longer sent by text message/);
});

test('through the editor: a check added to someone who has the document locks it at once, and a pass is reset by a new number', async () => {
  const s = await one(ada, {}, { subject: 'Editor path' });
  const c = visitor();
  assert.equal((await c.get(`/sign/${s.tok}`)).data.locked, false);
  const e = (await full(ada, s.id)).envelope;
  const put = (rcp: any) => ada.put(`/envelopes/${s.id}`, { documents: e.documents, fields: e.fields, recipients: [{ id: e.recipients[0].id, role: 'signer', name: 'Sam Signer', email: s.email, ...rcp }] });
  assert.equal((await put({ verify: 'sms_code', phone: UK, text_link: true })).status, 200);
  assert.equal((await c.get(`/sign/${s.tok}`)).data.locked, true);
  assert.match((await line(ada, s.id, 'Envelope corrected')).detail, /check before the document opens changed from no extra check to a one-time code by text message, mobile number \+44 \*\*\* \*\*\* 0123 added, the signing link is now also sent by text message/);
  // They already had the document, so the link is texted now, not with the next reminder.
  assert.deepEqual(texts(s.rid).map((t: any) => t.kind), ['link']);
  await pass(c, s, 'text');
  assert.equal((await put({ verify: 'sms_code', phone: '+44 7700 900300', text_link: true })).status, 200);
  assert.equal((await c.get(`/sign/${s.tok}`)).data.check.to, '+44 *** *** 0300');
  assert.match((await line(ada, s.id, 'Envelope corrected')).detail, /the one-time code that was passed on .* no longer counts, and a new one is asked for/);
  // A check that cannot work is refused and nothing of the correction is saved.
  const bad = await put({ name: 'Sam Renamed', verify: 'sms_code', phone: '' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /checked with a one-time code by text message, so they need a mobile number.*Nothing was saved\./);
  assert.equal(db.get('SELECT name FROM recipients WHERE id=?', s.rid).name, 'Sam Signer');
});

test('a signer who passes the document on: the number is not used for the new person, and the sender is told what the check became', async () => {
  const s = await one(ada, { verify: 'sms_code', phone: UK, text_link: true }, { subject: 'Handed over' });
  const c = visitor();
  // Nobody passes a document on before passing the check.
  assert.equal((await c.post(`/sign/${s.tok}/reassign`, { name: 'Dee Deputy', email: fresh('dee') })).status, 401);
  await pass(c, s, 'text');
  const dee = fresh('deputy');
  const before = texts(s.rid).length;
  assert.equal((await c.post(`/sign/${s.tok}/reassign`, { name: 'Dee Deputy', email: dee })).status, 200);
  const row = db.get('SELECT verify, phone, text_link, checked_at FROM recipients WHERE id=?', s.rid);
  assert.deepEqual([row.verify, row.phone, row.text_link, row.checked_at], ['email_code', null, 0, null]);
  assert.equal(texts(s.rid).length, before, 'the new person\'s link was texted to the first person\'s phone');
  const said = (await line(ada, s.id, 'Check passed on')).detail;
  assert.match(said, /Sam Signer was checked with a one-time code by text message to \+44 \*\*\* \*\*\* 0123, a number the sender typed for them\. Dee Deputy is asked for a one-time code by email instead, sent to d\*\*\*@example\.com\. The signing link is no longer sent by text message.*The one-time code Sam Signer passed on .* does not count for Dee Deputy\./);
  assert.match(toAda('Check changed: Handed over').pop()!.html, /Dee Deputy is asked for a one-time code by email instead\. That proves less than a text/);
  // The new person is checked by email, and the first person's browser is no pass for the new link.
  const tok = tokenFor(s.id, dee);
  const v = (await c.get(`/sign/${tok}`)).data;
  assert.deepEqual([v.locked, v.check.kind, v.check.to], [true, 'email_code', maskEmail(dee)]);
  await pass(c, { tok, rid: s.rid, email: dee });
  await finish(c, tok);
  assert.match(await certificate(ada, s.id), /Identity check One-time code sent by email to d\*\*\*@example\.com, passed/);
});

// ---- 10. Templates, bulk send and public forms ----------------------------------------------------------------------

test('templates keep the check, a bulk row brings its own phone, and a public form checks by email only', async () => {
  const file = await upload(ada, 1);
  const tpl = (await ada.post('/envelopes', {
    kind: 'template', subject: 'Volunteer waiver', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Volunteer', verify: 'sms_code', text_link: true }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  })).data.envelope;
  assert.deepEqual([tpl.recipients[0].verify, tpl.recipients[0].text_link], ['sms_code', true]);
  // Used once: the person's own number comes with their name and address.
  const noPhone = await ada.post('/envelopes', { template_id: tpl.id, recipients: { Volunteer: { name: 'Vee', email: fresh('vee') } }, send: true });
  assert.equal(noPhone.status, 400);
  assert.match(noPhone.data.error, /Vee is checked with a one-time code by text message, so they need a mobile number/);
  const used = await ada.post('/envelopes', { template_id: tpl.id, recipients: { Volunteer: { name: 'Vee', email: fresh('vee'), phone: '+44 7700 900401' } }, send: true });
  assert.equal(used.status, 200, JSON.stringify(used.data));
  assert.deepEqual([used.data.envelope.recipients[0].verify, used.data.envelope.recipients[0].phone, used.data.envelope.recipients[0].text_link], ['sms_code', '+447700900401', true]);
  // Bulk: a row without a number, or with one that is not a number, stops the whole batch before anything is sent.
  const rows = (phones: any[]) => phones.map((phone, i) => ({ Volunteer: { name: `Bulk ${i}`, email: fresh('bulk'), ...(phone === undefined ? {} : { phone }) } }));
  const missing = await ada.post('/bulk', { template_id: tpl.id, rows: rows(['+44 7700 900402', undefined]) });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /Row 2: "Volunteer" needs a mobile number, because this template checks them with a one-time code by text message\. Add a "phone" to the row\./);
  const wrong = await ada.post('/bulk', { template_id: tpl.id, rows: rows(['+44 7700 900402', '0770 900403']) });
  assert.match(wrong.data.error, /Row 2: "0770 900403" is not a mobile number we can text for "Volunteer"/);
  assert.equal(db.get("SELECT COUNT(*) n FROM bulk_batches WHERE template_id=?", tpl.id).n, 0);
  const bulk = await ada.post('/bulk', { template_id: tpl.id, rows: rows(['+44 7700 900402', '+44 7700 900403']) });
  assert.equal(bulk.data.sent, 2, JSON.stringify(bulk.data));
  const sent = db.all('SELECT r.phone, r.verify, r.text_link FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE e.bulk_id=? ORDER BY r.phone', bulk.data.id);
  assert.deepEqual(sent.map((r: any) => [r.phone, r.verify, r.text_link]), [['+447700900402', 'sms_code', 1], ['+447700900403', 'sms_code', 1]]);
  assert.equal(db.get("SELECT COUNT(*) n FROM texts t JOIN envelopes e ON e.id=t.envelope_id WHERE e.bulk_id=? AND t.kind='link'", bulk.data.id).n, 2);

  // A public form: its visitor types their own details, so a number of theirs is never texted.
  const form = await ada.post('/powerforms', { template_id: tpl.id, name: 'Sign the waiver' });
  assert.equal(form.status, 400);
  assert.match(form.data.error, /A public form cannot check its visitor with a code by text message or text them the link: the number would be typed by a stranger/);
  // A code by email works there: it shows the visitor can read the mailbox they typed.
  const mailTpl = (await ada.post('/envelopes', {
    kind: 'template', subject: 'Visitor waiver', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Visitor', verify: 'email_code' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
  })).data.envelope;
  const pf = await ada.post('/powerforms', { template_id: mailTpl.id, name: 'Visitor waiver' });
  assert.equal(pf.status, 200, JSON.stringify(pf.data));
  const slug = (await ada.get('/powerforms')).data.powerforms.find((p: any) => p.id === pf.data.id).slug;
  const walkIn = visitor();
  const typed = fresh('walkin');
  const start = await walkIn.post(`/public/powerforms/${slug}/start`, { name: 'Walk In', email: typed });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const tok = start.data.url.split('/sign/')[1];
  const v = (await walkIn.get(`/sign/${tok}`)).data;
  assert.deepEqual([v.locked, v.check.kind, v.check.to], [true, 'email_code', maskEmail(typed)]);
  assert.equal((await walkIn.post(`/sign/${tok}/consent`)).status, 401, 'typing an address into a form is not having its mailbox');
  await pass(walkIn, { tok, rid: '', email: typed });
  assert.equal((await finish(walkIn, tok)).status, 200);
  // If the template is changed to text its visitor after the form was made, the form closes with neutral words
  // for the visitor, and the owner is told the real reason.
  db.run("UPDATE recipients SET verify='sms_code' WHERE envelope_id=?", mailTpl.id);
  const closed = await visitor().post(`/public/powerforms/${slug}/start`, { name: 'Next One', email: fresh('next') });
  assert.equal(closed.status, 503);
  assert.match(closed.data.error, /cannot take new signatures right now/);
  assert.match(toAda('Your form "Visitor waiver" could not take a signature').pop()!.html, /A public form cannot check its visitor with a code by text message/);
});

// ---- 11. Nothing is left behind, and the screens keep their promises -------------------------------------------

test('deleting an account takes its numbers, its codes and its texts with it', async () => {
  const fi = await signUp('Fi Sender', 'fi.sender@example.com', ip());
  const s = await one(fi, { verify: 'sms_code', phone: '+44 7700 900500', text_link: true });
  await visitor().post(`/sign/${s.tok}/code`);
  const account = db.get('SELECT account_id a FROM envelopes WHERE id=?', s.id).a;
  const count = () => ['texts', 'sms_usage'].map((t) => db.get(`SELECT COUNT(*) n FROM ${t} WHERE account_id=?`, account).n).concat(db.get('SELECT COUNT(*) n FROM signer_codes WHERE account_id=?', account).n);
  assert.deepEqual(count(), [2, 2, 1]);
  assert.equal((await fi.post('/me/delete', { password: 'correct horse battery', confirm: 'fi.sender@example.com', now: true })).status, 200);
  if (db.get('SELECT 1 x FROM accounts WHERE id=?', account)) db.run('DELETE FROM accounts WHERE id=?', account); // closing keeps it for 30 days: the day has come
  assert.deepEqual(count(), [0, 0, 0]);
  assert.equal(JSON.stringify(db.all('SELECT * FROM recipients')).includes('447700900500'), false);
});

test('the signing screen asks for the code the way a phone can fill it in, and the pages say only what is true', () => {
  const screen = fs.readFileSync(new URL('../src/components/sign/CodeCheck.tsx', import.meta.url), 'utf8');
  assert.match(screen, /autoComplete="one-time-code"/);
  assert.match(screen, /inputMode="numeric"/);
  for (const words of ['This is not my number', 'I do not get the code', 'Send a new code']) assert.ok(screen.includes(words), words);
  // No jargon on a screen, and no em dash anywhere in what this feature added.
  for (const f of ['../src/components/sign/CodeCheck.tsx', '../src/lib/checks.ts', '../src/server/signercode.ts', '../src/server/sms.ts', '../src/server/routes-signercode.ts']) {
    const text = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(text.includes('\u2014'), false, `${f} has an em dash`);
  }
  for (const word of ['OTP', 'OAuth', 'webhook', 'token']) assert.equal(new RegExp(`>[^<{]*\\b${word}\\b`, 'i').test(screen), false, `the code screen says "${word}"`);
  // The public pages explain what each check proves from the one list, and say that texts depend on the operator.
  const security = fs.readFileSync(new URL('../src/app/security/page.tsx', import.meta.url), 'utf8');
  const help = fs.readFileSync(new URL('../src/app/help/page.tsx', import.meta.url), 'utf8');
  for (const page of [security, help]) {
    assert.match(page, /CHECK_PROVES/);
    assert.match(page, /smsProvider\(\)|textsOn/);
  }
  // Every setting is in the example file and the README.
  const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const k of SMS_KEYS) {
    assert.ok(example.includes(k), `.env.example does not mention ${k}`);
    assert.ok(readme.includes(k), `README does not mention ${k}`);
  }
  assert.match(readme, /## Checking who signs|\*\*Checking who signs\*\*/);
});

// ---- 12. Found while finishing: a number someone disowned, and the filter over a text ------------------------------

test('after "This is not my number" no text of any kind goes to it, and a sender who checked can let codes go to it again', async () => {
  const s = await one(ada, { verify: 'sms_code', phone: '+44 7700 900321', text_link: true }, { subject: 'Shed lease' });
  assert.deepEqual(texts(s.rid).map((t: any) => t.kind), ['link']);
  const c = visitor();
  assert.equal((await c.post(`/sign/${s.tok}/code/problem`, { what: 'not_mine' })).status, 200);
  // The sender is told how to undo it when the number was right after all.
  assert.match(toAda('Wrong number: Shed lease').pop()!.html, /If the number turns out to be right after all, tick (&quot;|")I checked with Sam Signer that this is their number(&quot;|") there, and codes go to it again\./);
  assert.match((await line(ada, s.id, 'One-time code: not my number')).detail, /No more codes or links are texted to it until the sender corrects it or confirms it with them\.$/);
  // A reminder a day later: the email goes, the text with the link does not go to a number someone disowned.
  db.run('UPDATE recipients SET texted_at=? WHERE id=?', new Date(Date.now() - 25 * 3600_000).toISOString(), s.rid);
  const reminders = () => mailTo(s.email).filter((m) => m.subject.startsWith('Reminder:')).length;
  const mails = reminders();
  assert.equal((await ada.post(`/envelopes/${s.id}/remind`)).status, 200);
  assert.equal(reminders(), mails + 1);
  assert.deepEqual(texts(s.rid).map((t: any) => t.kind), ['link'], 'the signing link was texted to a number someone said is not theirs');
  assert.match(fs.readFileSync(new URL('../src/app/help/page.tsx', import.meta.url), 'utf8'), /We stop texting it at once, codes and links alike, and tell the sender\./);
  // Sending the recipient back as it is, the way an API client fixes a name, does not lift the stop.
  const name = await ada.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, name: 'Sam Signer-Jones', email: s.email, verify: 'sms_code', phone: '+44 7700 900321', text_link: true });
  assert.equal(name.status, 200, JSON.stringify(name.data));
  assert.equal((await c.get(`/sign/${s.tok}`)).data.check.stopped, true);
  assert.equal((await c.post(`/sign/${s.tok}/code`)).data.code, 'stopped');
  // "number_confirmed" does, says so on the record with the number masked, and codes go to the same number again.
  const ok = await ada.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, number_confirmed: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await c.get(`/sign/${s.tok}`)).data.check.stopped, false);
  assert.equal((await full(ada, s.id)).envelope.recipients[0].check.stopped, false);
  const said = (await line(ada, s.id, 'Check corrected')).detail;
  assert.match(said, /the sender confirmed that \+44 \*\*\* \*\*\* 0321 is their number, after someone using the link had said it was not, so codes go to it again\.$/);
  assert.equal(said.includes('7700'), false);
  const again = await c.post(`/sign/${s.tok}/code`);
  assert.deepEqual([again.status, again.data.to], [200, '+44 *** *** 0321']);
  // Sent when nothing is stopped it changes nothing and writes nothing, and it never lifts a stop on another check.
  const lines = (await actions(ada, s.id)).filter((a: string) => a === 'Check corrected').length;
  assert.equal((await ada.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, number_confirmed: true })).status, 200);
  assert.equal((await actions(ada, s.id)).filter((a: string) => a === 'Check corrected').length, lines);
  // A correction that is refused takes the confirmation back with it: all of the call or none.
  assert.equal((await c.post(`/sign/${s.tok}/code/problem`, { what: 'not_mine' })).status, 200);
  const refused = await ada.post(`/envelopes/${s.id}/correct`, { recipient_id: s.rid, number_confirmed: true, access_code: 'ab' });
  assert.equal(refused.status, 400);
  assert.equal((await c.get(`/sign/${s.tok}`)).data.check.stopped, true, 'a refused call lifted the stop');
});

test('the filter for fake payment notices reads what a text would say: a document that reads like one is not texted', async () => {
  const lu = await signUp('Lu Sender', 'lu.sender@example.com', ip());
  const s = await one(lu, { phone: '+44 7700 900888', text_link: true }, { subject: 'Garden rota' });
  assert.equal(texts(s.rid).length, 1);
  // The envelope's words now read like a fake payment notice (the lists the filter reads grow over time). The next
  // text is held by the same guard as an email, whoever it goes to, and the sender is told.
  db.run('UPDATE envelopes SET subject=? WHERE id=?', 'PayPal invoice: $499.00 charged. To cancel call +1 (888) 555-0142', s.id);
  db.run('UPDATE recipients SET texted_at=NULL WHERE id=?', s.rid);
  const { alsoText } = await import('../src/server/signercode.ts');
  const { loadEnvelope } = await import('../src/server/envelopes.ts');
  const e = loadEnvelope(s.id);
  await alsoText(e, e.recipients[0], 'reminder');
  assert.equal(texts(s.rid).length, 1, 'a text went out that reads like a fake payment notice');
  assert.match((await line(lu, s.id, 'Text not sent')).detail, /^Sam Signer: a reminder by text message to \+44 \*\*\* \*\*\* 0888 was not sent, because the envelope reads like a fake payment notice/);
  assert.equal(mailTo('lu.sender@example.com').filter((m) => m.subject.startsWith('Text not sent:')).length, 1);
});

test('a bulk list brings a mobile number only where the template texts that role, in full international form', async () => {
  const { readRecipients, headerFor } = await import('../src/components/sender/csv.ts');
  const texted = [{ key: 'Volunteer', label: 'Volunteer', phone: true }];
  assert.equal(headerFor(texted), 'Volunteer name,Volunteer email,Volunteer phone');
  // A header in any order, with "mobile" for the number: spaces are forgiven and the number is sent on in full form.
  const r = readRecipients('Volunteer mobile,Volunteer email,Volunteer name\n+44 7700 900123,ada@example.org,Ada\n,ben@example.org,Ben\n07700 900125,cy@example.org,Cy', texted);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.rows[0].cells.Volunteer, { name: 'Ada', email: 'ada@example.org', phone: '+447700900123' });
  assert.deepEqual(r.rows[0].problems, []);
  assert.deepEqual(r.rows[1].problems, ['mobile number is missing']);
  assert.deepEqual(r.rows[2].problems, ['"07700 900125" is not a full mobile number. Write it with the country code, like +44 7700 900123']);
  // A list without the column says which one is missing before anything is sent.
  assert.deepEqual(readRecipients('Volunteer name,Volunteer email\nAda,ada@example.org', texted).missing, ['Volunteer phone']);
  // Without a header the columns come as suggested: name, email, phone.
  assert.deepEqual(readRecipients('Ada,ada@example.org,+1 415 555 0100', texted).rows[0].cells.Volunteer, { name: 'Ada', email: 'ada@example.org', phone: '+14155550100' });
  // A role the template does not text never takes a number along, even when the list has one.
  const plain = readRecipients('Volunteer name,Volunteer email,Volunteer phone\nAda,ada@example.org,+44 7700 900123', [{ key: 'Volunteer', label: 'Volunteer' }]);
  assert.deepEqual(plain.rows[0].cells.Volunteer, { name: 'Ada', email: 'ada@example.org' });
  assert.deepEqual(plain.ignored, ['Volunteer phone']);
});
