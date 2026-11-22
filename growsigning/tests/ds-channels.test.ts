// WhatsApp is switched off for every account, free or paid (WHATSAPP_OFFERED in src/lib/channels.ts, the owner's
// decision), and codes by phone call still work (src/server/voice.ts). The providers are stand-ins: a fetch stub for
// the Meta WhatsApp Business Platform and for Twilio, so nothing here reaches the network. Every WhatsApp setting an
// operator could put on the server is set here, the dev outbox too, to prove that none of them brings WhatsApp back:
// nothing offers it, the API refuses it for every account, nothing is sent or retried, nobody is emailed about it,
// the webhook answers 404, and the startup log says the settings are ignored.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, Client, simple, upload, tokenFor, signUp, signAll, mailTo } from './helpers.ts';
import { WHATSAPP_OFFERED, whatsappProvider, voiceProvider, fillWa, WA_TEXTS, channelsWarning } from '../src/lib/channels.ts';
import { checkLine } from '../src/lib/checks.ts';

const KEYS = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_TEMPLATE_INVITE', 'WHATSAPP_TEMPLATE_REMIND', 'WHATSAPP_TEMPLATE_DONE', 'WHATSAPP_TEMPLATE_DEADLINE',
  'TWILIO_WHATSAPP_FROM', 'WHATSAPP_DAILY_PER_ACCOUNT', 'WHATSAPP_DEV_OUTBOX', 'VOICE_ENABLED', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID', 'SMS_WEBHOOK_URL', 'SMS_DEV_OUTBOX', 'WHATSAPP_VERIFY_TOKEN'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
// Everything an operator could set for WhatsApp, all at once: Meta, the dev outbox and the webhook token.
const META = { WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '1234', WHATSAPP_APP_SECRET: 'app-secret', WHATSAPP_TEMPLATE_INVITE: 'gs_invite', WHATSAPP_TEMPLATE_REMIND: 'gs_remind', WHATSAPP_TEMPLATE_DONE: 'gs_done',
  WHATSAPP_DEV_OUTBOX: '1', WHATSAPP_VERIFY_TOKEN: 'verify-me', SMS_DEV_OUTBOX: '1', VOICE_ENABLED: '1' };
const provider = (set: Record<string, string>) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, set);
};
provider(META);

const { db } = await boot();
const { retryWhatsApp, alsoWhatsApp, waCompleted } = await import('../src/server/whatsapp.ts');

// ---- The stand-in providers --------------------------------------------------------------------------------------
const calls: { url: string; body: string }[] = [];
const answers: { status: number; body: any }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = new URL(String(url));
  if (u.host !== 'graph.facebook.com' && u.host !== 'api.twilio.com') return realFetch(url, init);
  calls.push({ url: String(url), body: String(init.body || '') });
  const a = answers.shift() || { status: 200, body: { messages: [{ id: `wamid.${calls.length}` }], sid: `SM${calls.length}` } };
  return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
}) as any;
after(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
});

let n = 0;
const ip = () => `198.51.${110 + (++n >> 8)}.${n & 255}`;
const fresh = (name = 'wa') => `${name}${++n}@example.com`;
const accountOf = (name: string) => db.get('SELECT m.account_id a FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.name=?', name).a as string;
const sender = async (name: string, how: 'free' | 'trusted' | 'paid' = 'trusted') => {
  const email = fresh('sender');
  const c = await signUp(name, email, ip());
  if (how !== 'free') db.run('UPDATE accounts SET trusted_at=? WHERE id=?', new Date().toISOString(), accountOf(name));
  if (how === 'paid') db.run("UPDATE accounts SET plan='grove', subscription_status='active' WHERE id=?", accountOf(name));
  return Object.assign(c, { email });
};
const ada = await sender('Ada Wa');
const PHONE = '+44 7700 900123';
// Anything that went to a WhatsApp provider: Meta's graph, or Twilio's messages with a whatsapp: number.
const waCalls = () => calls.filter((c) => c.url.includes('graph.facebook.com') || /whatsapp%3A|whatsapp:/i.test(c.body));
const actions = async (c: Client, id: string) => (await c.get(`/envelopes/${id}`)).data.audit.map((a: any) => a.action);
const sign = (raw: string) => `sha256=${crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
async function webhook(method: 'GET' | 'POST', raw = '', headers: Record<string, string> = {}, query = '') {
  const { handle } = await import('../src/server/router.ts');
  const res = await handle(new Request(`http://test.local/api/whatsapp/webhook${query}`, method === 'GET' ? { method } : { method, body: raw, headers }));
  return { status: res.status, text: await res.text() };
}

// One signer, sent, with a number. Used by the call tests and for the old choice left on a row.
async function oneWa(c: Client, r: any = {}, over: any = {}) {
  const email = r.email || fresh('sam');
  const e = await simple(c, email, { send: true, recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email, phone: PHONE, ...r }], ...over });
  const row = db.get('SELECT id, token FROM recipients WHERE envelope_id=? AND email=?', e.id, email);
  return { id: e.id as string, tok: row.token as string, rid: row.id as string, email };
}
async function tryWa(c: Client, r: any, over: any = {}) {
  const file = await upload(c, 1);
  return c.post('/envelopes', {
    subject: 'Simple agreement', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: fresh('sam'), phone: PHONE, whatsapp: true, ...r }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }], send: true, ...over,
  });
}
const OFF = /^GrowSigning does not send anything by WhatsApp, for any account, free or paid\. The signing link goes by email\. Nothing was (saved|changed)\.$/;

// ---- 1. The switch ------------------------------------------------------------------------------------------------

test('1. one switch in code: WhatsApp is off whatever an operator sets, and calls are unchanged', () => {
  assert.equal(WHATSAPP_OFFERED, false, 'the owner decided: no WhatsApp on any account');
  assert.equal(whatsappProvider({}), null);
  assert.equal(whatsappProvider(META), null, 'every Meta setting at once: still off');
  assert.equal(whatsappProvider({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_FROM: '+14155238886' }), null, 'a Twilio WhatsApp sender: still off');
  assert.equal(whatsappProvider({ WHATSAPP_DEV_OUTBOX: '1', NODE_ENV: 'development' }), null, 'the dev outbox: still off');
  assert.equal(whatsappProvider(), null, 'the settings of this very test server: still off');
  assert.equal(voiceProvider({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1555' }), null, 'calls need VOICE_ENABLED=1');
  assert.equal(voiceProvider({ VOICE_ENABLED: '1', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1555' }), 'twilio');
});

test('1a. at startup, WhatsApp settings are named and said to be ignored; none, nothing is said', () => {
  const said = channelsWarning(META) || '';
  assert.match(said, /WHATSAPP SETTINGS ARE IGNORED/);
  assert.match(said, /WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID/);
  assert.match(said, /offers WhatsApp to no account, free or paid/);
  assert.doesNotMatch(said, /SWITCHED OFF, because|WHATSAPP_APP_SECRET is not set/, 'no advice on finishing a setup that would do nothing');
  assert.match(channelsWarning({ TWILIO_WHATSAPP_FROM: '+1555' }) || '', /IGNORED \(found: TWILIO_WHATSAPP_FROM\)/);
  assert.equal(channelsWarning({}), null);
  assert.equal(channelsWarning({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1555' }), null, 'text message settings are not WhatsApp settings');
  assert.doesNotMatch(said, /\u2014/);
});

const fs = await import('node:fs');
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
test('1b. the dormant message texts still name the sender and how to stop, and the README no longer prints them', () => {
  for (const k of Object.keys(WA_TEXTS) as (keyof typeof WA_TEXTS)[]) {
    const t = fillWa(k, { sender: 'Ada', subject: '"Lease"', link: 'https://x/sign/abc' });
    assert.match(t, /Ada/);
    assert.match(t, /Reply STOP/);
    assert.doesNotMatch(t, /\u2014/, 'no em dashes');
    const tpl = WA_TEXTS[k].replace('{sender}', '{{1}}').replace('{subject}', '{{2}}').replace('{link}', '{{3}}');
    assert.ok(!readme.includes(`\`${tpl}\``), `${k}: the README does not hand an operator a template to register`);
  }
  assert.doesNotMatch(readme, /whatsapp/i, 'the README says nothing about WhatsApp');
  assert.doesNotMatch(fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8'), /whatsapp/i, '.env.example offers no WhatsApp setting');
});

// ---- 2. Every account is refused -------------------------------------------------------------------------------------

test('2. /me tells no account about WhatsApp, free or paid, with every setting present', async () => {
  for (const how of ['free', 'trusted', 'paid'] as const) {
    const c = await sender(`Me ${how}`, how);
    const me = (await c.get('/me')).data;
    assert.equal('whatsapp' in me, false, `${how}: no "whatsapp" in /me`);
    assert.equal('whatsapp_daily' in me, false, `${how}: no daily limit for WhatsApp`);
    assert.equal(me.phone_calls, true, `${how}: calls are a separate switch and stay on`);
  }
});

test('2b. asking for WhatsApp is refused for every account: send, draft, template, edit and Change person', async () => {
  for (const how of ['free', 'trusted', 'paid'] as const) {
    const c = await sender(`Ask ${how}`, how);
    const before = db.get('SELECT COUNT(*) n FROM envelopes WHERE account_id=?', accountOf(`Ask ${how}`)).n;
    for (const over of [{ send: true }, { send: false }, { send: false, kind: 'template' }]) {
      for (const r of [{ whatsapp: true, whatsapp_agreed: true }, { whatsapp: true }]) {
        const res = await tryWa(c, r, over);
        assert.equal(res.status, 400, `${how} ${JSON.stringify(over)}: ${JSON.stringify(res.data)}`);
        assert.equal(res.data.code, 'whatsapp_off');
        assert.match(res.data.error, OFF);
      }
    }
    assert.equal(db.get('SELECT COUNT(*) n FROM envelopes WHERE account_id=?', accountOf(`Ask ${how}`)).n, before, `${how}: nothing was saved`);
    // An envelope that is out: neither the editor's correction nor Change person can switch it on.
    const e = await oneWa(c, { phone: '+44 7700 900150' });
    const env = (await c.get(`/envelopes/${e.id}`)).data.envelope;
    const rec = env.recipients[0];
    assert.equal('whatsapp' in rec || 'whatsapp_agreed' in rec || 'whatsapp_status' in rec, false, 'a recipient carries no WhatsApp fields');
    const put = await c.put(`/envelopes/${e.id}`, { subject: env.subject, documents: env.documents.map((x: any) => ({ id: x.id, file_id: x.file_id })),
      recipients: [{ id: rec.id, role: 'signer', name: rec.name, email: rec.email, phone: rec.phone, whatsapp: true, whatsapp_agreed: true }], fields: env.fields });
    assert.equal(put.status, 400, JSON.stringify(put.data));
    assert.equal(put.data.code, 'whatsapp_off');
    const fix = await c.post(`/envelopes/${e.id}/correct`, { recipient_id: e.rid, whatsapp: true, whatsapp_agreed: true });
    assert.equal(fix.status, 400);
    assert.equal(fix.data.code, 'whatsapp_off');
    assert.match(fix.data.error, OFF);
    assert.equal(db.get('SELECT wa_link FROM recipients WHERE id=?', e.rid).wa_link, 0);
    // Saying no is always fine: the editor sends "whatsapp": false with every save.
    assert.equal((await c.post(`/envelopes/${e.id}/correct`, { recipient_id: e.rid, whatsapp: false })).status, 200);
  }
  assert.equal(waCalls().length, 0, 'nothing went to a WhatsApp provider');
});

// ---- 3. Nothing is ever sent ---------------------------------------------------------------------------------------------

test('3. a WhatsApp choice left on a row from before is dropped at send: no message, no retry, no audit line, no email about it', async () => {
  calls.length = 0;
  const cy = await sender('Cy Old', 'paid');
  const email = fresh('sam');
  const d = await simple(cy, email, { recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email, phone: PHONE }] });
  const rid = db.get('SELECT id FROM recipients WHERE envelope_id=?', d.id).id;
  // As if it had been saved while WhatsApp was still offered, with the tick for this number.
  const { phoneKey } = await import('../src/server/sms.ts');
  db.run('UPDATE recipients SET wa_link=1, wa_agreed_at=?, wa_agreed_for=? WHERE id=?', new Date().toISOString(), phoneKey('+447700900123'), rid);
  const sent = await cy.post(`/envelopes/${d.id}/send`, {});
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(db.get('SELECT wa_link FROM recipients WHERE id=?', rid).wa_link, 0, 'the old choice is gone');
  assert.equal(mailTo(email).length >= 1, true, 'the link went by email');
  // A reminder, the closing-soon notice and the finished copy: none by WhatsApp, even when asked for directly.
  db.run('UPDATE recipients SET wa_link=1 WHERE id=?', rid);
  const env = db.get('SELECT * FROM envelopes WHERE id=?', d.id);
  for (const kind of ['new', 'reminder', 'expiring']) await alsoWhatsApp(env, { id: rid, wa_link: 1 }, kind);
  await cy.post(`/envelopes/${d.id}/remind`, {});
  assert.equal((await signAll(d.id, email)).status, 200);
  await waCompleted(db.get('SELECT * FROM envelopes WHERE id=?', d.id), { id: rid, wa_link: 1 });
  // A message somehow waiting for another try is never tried.
  db.run("INSERT INTO wa_messages (account_id, envelope_id, recipient_id, kind, to_phone, to_masked, dest_hash, body, params, status, at, provider) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    accountOf('Cy Old'), d.id, rid, 'remind', '+447700900123', '+44 *** *** 0123', phoneKey('+447700900123'), 'x', '{}', 'queued', new Date(Date.now() - 3600e3).toISOString(), 'meta');
  assert.deepEqual(await retryWhatsApp(), { sent: 0, failed: 0, dropped: 0 });
  assert.equal(waCalls().length, 0, 'nothing went to a WhatsApp provider');
  assert.equal(db.get("SELECT COUNT(*) n FROM wa_messages WHERE envelope_id=? AND status <> 'queued'", d.id).n, 0, 'no message was written or sent');
  assert.equal((await actions(cy, d.id)).filter((a: string) => /whatsapp/i.test(a)).length, 0, 'the audit trail says nothing about WhatsApp');
  for (const to of [cy.email, email]) for (const m of mailTo(to)) assert.doesNotMatch(`${m.subject} ${m.html}`, /whatsapp/i, `email to ${to}: ${m.subject}`);
  const page = (await cy.get(`/envelopes/${d.id}`)).data;
  assert.equal('whatsapp' in page, false, 'the envelope page has no WhatsApp list');
  assert.doesNotMatch(page.envelope.recipients[0].check.line, /WhatsApp/, 'the certificate line claims no WhatsApp');
});

test('3d. a sent envelope with WhatsApp left on from before: texting the link is not blocked, and changing the person writes no WhatsApp line', async () => {
  const e = await oneWa(ada);
  // As if WhatsApp had been switched on for this person before the owner's decision.
  const { phoneKey } = await import("../src/server/sms.ts");
  db.run("UPDATE recipients SET wa_link=1, wa_agreed_for=?, wa_agreed_at=? WHERE id=?", phoneKey(PHONE), new Date().toISOString(), e.rid);
  const text = await ada.post(`/envelopes/${e.id}/correct`, { recipient_id: e.rid, name: 'Sam Signer', email: e.email, phone: PHONE, text_link: true });
  assert.notEqual(text.data?.code, 'whatsapp_and_text', 'the link by text message is not refused because of an old WhatsApp choice');
  assert.equal(text.status, 200, JSON.stringify(text.data));
  db.run("UPDATE recipients SET wa_link=1 WHERE id=?", e.rid);
  const moved = await ada.post(`/envelopes/${e.id}/correct`, { recipient_id: e.rid, name: 'Kim Other', email: fresh('kim'), phone: '+44 7700 900456', text_link: false });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal((await actions(ada, e.id)).filter((a: string) => /whatsapp/i.test(a)).length, 0, 'the audit trail says nothing about WhatsApp');
  assert.equal(db.get('SELECT wa_link FROM recipients WHERE id=?', e.rid).wa_link, 0, 'the old choice is cleared for the new person');
});

test('3b. the WhatsApp webhook answers 404 to everyone, even with the token and a signed body', async () => {
  const get = await webhook('GET', '', {}, '?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42');
  assert.equal(get.status, 404);
  assert.doesNotMatch(get.text, /42/);
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '447700900123', text: { body: 'STOP' } }] } }] }] });
  assert.equal((await webhook('POST', raw, { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) })).status, 404);
  assert.equal((await webhook('POST', 'Body=STOP&From=whatsapp%3A%2B447700900123', { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'x' })).status, 404);
});

test('3c. the API description and the outside-services list say nothing about WhatsApp', async () => {
  const spec = (await new Client().get('/openapi.json')).data;
  assert.doesNotMatch(JSON.stringify(spec), /whatsapp/i);
  const { outsideServices, NOT_BUILT } = await import('../src/lib/outside.ts');
  assert.equal(outsideServices({ ...process.env, ...META } as any).some((s: any) => s.id === 'whatsapp'), false);
  assert.doesNotMatch(NOT_BUILT.join(' '), /whatsapp/i);
});

// ---- 7. Codes by phone call ---------------------------------------------------------------------------------------------

const callSaid = (rid: string) => db.get('SELECT said FROM voice_calls WHERE recipient_id=? ORDER BY id DESC LIMIT 1', rid)?.said as string;
test('7. "Call me with the code": same code rules as a text, read out twice, and the certificate says phone call', async () => {
  const e = await oneWa(ada, { phone: '+44 7700 900511', whatsapp: false, verify: 'sms_code' });
  const v = new Client();
  v.ip = ip();
  const view = (await v.get(`/sign/${e.tok}`)).data;
  assert.equal(view.check.call, true, 'the screen offers the call');
  const r = await v.post(`/sign/${e.tok}/code/call`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.by, 'call');
  assert.equal(r.data.delivery, 'outbox');
  assert.equal(JSON.stringify(r.data).match(/\d{6}/), null, 'the answer never holds the code');
  const said = callSaid(e.rid);
  const digits = /Your code is: ([\d, ]+)\./.exec(said)![1];
  assert.equal(said.split(digits).length - 1, 2, 'read out twice');
  const code = digits.replace(/\D/g, '');
  assert.equal(code.length, 6);
  // The minute between codes holds for calls as for texts.
  const again = await v.post(`/sign/${e.tok}/code/call`);
  assert.equal(again.status, 429);
  assert.equal(again.data.code, 'wait');
  assert.equal((await v.post(`/sign/${e.tok}/code/check`, { code })).status, 200);
  const rec = (await ada.get(`/envelopes/${e.id}`)).data.envelope.recipients[0];
  assert.match(rec.check.line, /One-time code sent by phone call to \+44 \*\*\* \*\*\* 0511, passed/);
  // A call counts against the account's daily limit on texts.
  assert.ok(db.get("SELECT COUNT(*) n FROM sms_usage WHERE kind='code' AND dest_hash=(SELECT dest_hash FROM voice_calls WHERE recipient_id=?)", e.rid).n >= 1);
});

test('7b. no call for an email code or when calls are off; Twilio reads the digits slowly', async () => {
  const em = await oneWa(ada, { whatsapp: false, phone: undefined, verify: 'email_code' });
  const v = new Client();
  v.ip = ip();
  assert.equal((await v.post(`/sign/${em.tok}/code/call`)).status, 409);
  const off = await oneWa(ada, { phone: '+44 7700 900611', whatsapp: false, verify: 'sms_code' });
  delete process.env.VOICE_ENABLED;
  try {
    assert.equal((await v.get(`/sign/${off.tok}`)).data.check.call, false);
    const r = await v.post(`/sign/${off.tok}/code/call`);
    assert.equal(r.status, 503);
    assert.match(r.data.error, /calls are switched off/);
  } finally {
    process.env.VOICE_ENABLED = '1';
  }
  provider({ ...META, TWILIO_ACCOUNT_SID: 'ACv', TWILIO_AUTH_TOKEN: 'vtok', TWILIO_FROM: '+15550001111' });
  try {
    const tw = await oneWa(ada, { phone: '+44 7700 900711', whatsapp: false, verify: 'sms_code' });
    calls.length = 0;
    const w = new Client();
    w.ip = ip();
    const r = await w.post(`/sign/${tw.tok}/code/call`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const call = calls.find((c) => c.url.endsWith('/Calls.json'))!;
    const p = new URLSearchParams(call.body);
    assert.equal(p.get('To'), '+447700900711');
    assert.equal(p.get('From'), '+15550001111');
    assert.equal((p.get('Twiml')!.match(/<Pause length="1"\/>/g) || []).length, 13, 'a pause after the greeting and after every digit, twice');
    assert.equal(db.get('SELECT said FROM voice_calls WHERE recipient_id=? ORDER BY id DESC', tw.rid).said, null, 'our record never keeps the code');
  } finally {
    provider(META);
  }
});

test('8. checkLine without WhatsApp is unchanged', () => {
  assert.equal(checkLine({}, null), 'Link sent by email only');
  assert.equal(checkLine({ wa_sent_to: '+44 *** *** 0123' }, null), 'Link sent by email and by WhatsApp to +44 *** *** 0123');
});

// ---- 9. Another person or another number ends WhatsApp -----------------------------------------------------------------


// ---- 9. Codes by phone call after a change of person --------------------------------------------------------------------------

test('9e. after a call, the code screen still says it was a call when the page is opened again', async () => {
  const e = await oneWa(ada, { phone: '+44 7700 900808', whatsapp: false, verify: 'sms_code' });
  const v = new Client();
  v.ip = ip();
  assert.equal((await v.post(`/sign/${e.tok}/code/call`)).status, 200);
  assert.equal((await v.get(`/sign/${e.tok}`)).data.check.by, 'call');
});
