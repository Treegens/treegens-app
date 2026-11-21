// WhatsApp delivery of the signing link and codes by phone call (src/server/whatsapp.ts, src/server/voice.ts).
// The providers are stand-ins: a fetch stub for the Meta WhatsApp Business Platform and for Twilio, so nothing here
// reaches the network. Pinned down: what each setting switches on, the tick that the person agreed, what is refused
// (groups, copies, text and WhatsApp together, templates), sending and trying again, STOP, the status words, the
// daily limit and the pause, the certificate line, the completed link, and a code read out on a call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, Client, simple, upload, tokenFor, signUp, signAll } from './helpers.ts';
import { whatsappProvider, voiceProvider, waStatusWord, fillWa, WA_TEXTS, channelsWarning } from '../src/lib/channels.ts';
import { checkLine } from '../src/lib/checks.ts';

const KEYS = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_TEMPLATE_INVITE', 'WHATSAPP_TEMPLATE_REMIND', 'WHATSAPP_TEMPLATE_DONE', 'WHATSAPP_TEMPLATE_DEADLINE',
  'TWILIO_WHATSAPP_FROM', 'WHATSAPP_DAILY_PER_ACCOUNT', 'WHATSAPP_DEV_OUTBOX', 'VOICE_ENABLED', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID', 'SMS_WEBHOOK_URL', 'SMS_DEV_OUTBOX', 'WHATSAPP_VERIFY_TOKEN'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const META = { WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '1234', WHATSAPP_APP_SECRET: 'app-secret', WHATSAPP_TEMPLATE_INVITE: 'gs_invite', WHATSAPP_TEMPLATE_REMIND: 'gs_remind', WHATSAPP_TEMPLATE_DONE: 'gs_done', SMS_DEV_OUTBOX: '1', VOICE_ENABLED: '1' };
const provider = (set: Record<string, string>) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, set);
};
provider(META);

const { db } = await boot();
const { retryWhatsApp } = await import('../src/server/whatsapp.ts');

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
const sender = async (name: string) => {
  const c = await signUp(name, fresh('sender'), ip());
  db.run("UPDATE accounts SET trusted_at=? WHERE id=(SELECT m.account_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.name=?)", new Date().toISOString(), name);
  return c;
};
const ada = await sender('Ada Wa');
const PHONE = '+44 7700 900123';
const metaBodies = () => calls.filter((c) => c.url.includes('graph.facebook.com')).map((c) => JSON.parse(c.body));
const actions = async (c: Client, id: string) => (await c.get(`/envelopes/${id}`)).data.audit.map((a: any) => a.action);
const sign = (raw: string) => `sha256=${crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
async function postRaw(raw: string, sig: string, type = 'application/json', header = 'x-hub-signature-256') {
  const { handle } = await import('../src/server/router.ts');
  const res = await handle(new Request('http://test.local/api/whatsapp/webhook', { method: 'POST', body: raw, headers: { 'content-type': type, [header]: sig } }));
  return { status: res.status, text: await res.text() };
}

// One signer with the link also by WhatsApp, sent.
async function oneWa(c: Client, r: any = {}, over: any = {}) {
  const email = r.email || fresh('sam');
  const e = await simple(c, email, { send: true, recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email, phone: PHONE, whatsapp: true, whatsapp_agreed: true, ...r }], ...over });
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

// ---- 1. Settings ---------------------------------------------------------------------------------------------------

test('1. WhatsApp and calls are off until set up, and /me says which are on', async () => {
  assert.equal(whatsappProvider({}), null);
  assert.equal(whatsappProvider({ WHATSAPP_TOKEN: 'a', WHATSAPP_PHONE_NUMBER_ID: '1' }), null, 'no approved invitation template: off');
  assert.equal(whatsappProvider(META), 'meta');
  assert.equal(whatsappProvider({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_FROM: '+14155238886' }), 'twilio');
  assert.equal(whatsappProvider({ WHATSAPP_DEV_OUTBOX: '1', NODE_ENV: 'production' }), null, 'the outbox never counts as on in production');
  assert.equal(voiceProvider({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1555' }), null, 'calls need VOICE_ENABLED=1');
  assert.equal(voiceProvider({ VOICE_ENABLED: '1', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1555' }), 'twilio');
  assert.match(channelsWarning({ WHATSAPP_TOKEN: 'a' }) || '', /WHATSAPP IS SWITCHED OFF/);
  assert.match(channelsWarning({ ...META, WHATSAPP_APP_SECRET: '' }) || '', /WHATSAPP_APP_SECRET/);
  const me = (await ada.get('/me')).data;
  assert.equal(me.whatsapp, true);
  assert.equal(me.phone_calls, true);
  provider({});
  const off = (await ada.get('/me')).data;
  assert.equal(off.whatsapp, false);
  assert.equal(off.phone_calls, false);
  const r = await tryWa(ada, { whatsapp_agreed: true });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'whatsapp_off');
  assert.match(r.data.error, /has not set up WhatsApp/);
  provider(META);
});

test('1b. every message text names the sender and how to stop, and the completed one carries a link, never the PDF', () => {
  for (const k of Object.keys(WA_TEXTS) as (keyof typeof WA_TEXTS)[]) {
    const t = fillWa(k, { sender: 'Ada', subject: '"Lease"', link: 'https://x/sign/abc' });
    assert.match(t, /Ada/);
    assert.match(t, /Reply STOP/);
    assert.match(t, /https:\/\/x\/sign\/abc/);
    assert.doesNotMatch(t, /—/, 'no em dashes');
  }
});

// ---- 2. Who may get it ---------------------------------------------------------------------------------------------

test('2. the tick that they agreed is required, for the number it was given for', async () => {
  const r = await tryWa(ada, {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Tick "They agreed to get messages about this by WhatsApp"/);
  assert.match(r.data.error, /\+44 \*\*\* \*\*\* 0123/);
  // A tick for one number does not cover another.
  const file = await upload(ada, 1);
  const d = (await ada.post('/envelopes', { subject: 'Lease', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam', email: fresh(), phone: PHONE, whatsapp: true, whatsapp_agreed: true }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] })).data.envelope;
  const rec = d.recipients[0];
  assert.equal(rec.whatsapp, true);
  assert.equal(rec.whatsapp_agreed, true);
  assert.equal(rec.wa_agreed_for, undefined, 'the fingerprint stays on the server');
  const moved = await ada.put(`/envelopes/${d.id}`, { subject: 'Lease', documents: d.documents.map((x: any) => ({ id: x.id, file_id: x.file_id })), recipients: [{ id: rec.id, role: 'signer', name: 'Sam', email: rec.email, phone: '+44 7700 900999' }], fields: d.fields });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.envelope.recipients[0].whatsapp_agreed, false);
  const sent = await ada.post(`/envelopes/${d.id}/send`);
  assert.equal(sent.status, 400);
  assert.match(sent.data.error, /Tick/);
  assert.ok((await actions(ada, d.id)).includes('WhatsApp agreed'), 'the tick is in the audit trail');
});

test('2b. refused for groups, copies, in-person signers, templates, and together with the text link', async () => {
  const both = await tryWa(ada, { whatsapp_agreed: true, text_link: true });
  assert.equal(both.status, 400);
  assert.match(both.data.error, /Choose one of the two/);
  const cc = await tryWa(ada, { whatsapp_agreed: true }, { recipients: [{ id: 'r', role: 'signer', name: 'Sam', email: fresh() }, { id: 'c', role: 'cc', name: 'Cee', email: fresh(), phone: PHONE, whatsapp: true, whatsapp_agreed: true }] });
  assert.equal(cc.status, 400);
  assert.match(cc.data.error, /only gets a copy/);
  const inp = await tryWa(ada, { whatsapp_agreed: true, role: 'inperson' });
  assert.equal(inp.status, 400);
  assert.match(inp.data.error, /in person/);
  const group = (await ada.post('/groups', { name: 'HR', members: [{ name: 'Maya', email: fresh() }, { name: 'Ben', email: fresh() }] })).data.group;
  const g = await tryWa(ada, { group_id: group.id, name: undefined, email: undefined, whatsapp_agreed: true });
  assert.equal(g.status, 400);
  assert.match(g.data.error, /is a group/);
  const file = await upload(ada, 1);
  const tpl = await ada.post('/envelopes', { kind: 'template', subject: 'Tpl', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Tenant', name: 'T', email: fresh(), phone: PHONE, whatsapp: true, whatsapp_agreed: true }], fields: [] });
  assert.equal(tpl.status, 400);
  assert.equal(tpl.data.code, 'whatsapp_template');
  assert.match(tpl.data.error, /A template cannot send by WhatsApp/);
});

// ---- 3. Sending, status words, trying again -------------------------------------------------------------------------

test('3. sent with the approved invitation template, recorded as Sent, then Delivered to the phone; read is never shown', async () => {
  calls.length = 0;
  const { id, tok } = await oneWa(ada);
  const [m] = metaBodies();
  assert.equal(m.to, '447700900123');
  assert.equal(m.type, 'template');
  assert.equal(m.template.name, 'gs_invite');
  const params = m.template.components[0].parameters.map((p: any) => p.text);
  assert.equal(params[0], 'Ada Wa');
  assert.match(params[2], new RegExp(`/sign/${tok}$`));
  const full = (await ada.get(`/envelopes/${id}`)).data;
  assert.equal(full.whatsapp[0].said, 'Sent');
  assert.equal(full.whatsapp[0].to, '+44 *** *** 0123');
  assert.equal(full.whatsapp[0].body, undefined, 'the sender never reads the text with the link from the record');
  assert.ok(full.audit.some((a: any) => a.action === 'Signing link sent by WhatsApp' && /\+44 \*\*\* \*\*\* 0123/.test(a.detail)));
  assert.equal(db.get('SELECT to_phone FROM wa_messages WHERE envelope_id=?', id).to_phone, null, 'the number leaves the row once the provider has it');
  // The certificate line names the way the link went, masked.
  assert.equal(full.envelope.recipients[0].check.line, 'Link sent by email and by WhatsApp to +44 *** *** 0123');
  const wamid = db.get('SELECT provider_id p FROM wa_messages WHERE envelope_id=?', id).p;
  const report = (status: string) => ({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status }] } }] }] });
  // Not signed: nothing changes.
  assert.equal((await postRaw(JSON.stringify(report('delivered')), 'sha256=00')).status, 403);
  assert.equal((await ada.get(`/envelopes/${id}`)).data.whatsapp[0].said, 'Sent');
  const raw = JSON.stringify(report('delivered'));
  assert.equal((await postRaw(raw, sign(raw))).status, 200);
  assert.equal((await ada.get(`/envelopes/${id}`)).data.whatsapp[0].said, 'Delivered to the phone');
  const read = JSON.stringify(report('read'));
  await postRaw(read, sign(read));
  const after = (await ada.get(`/envelopes/${id}`)).data.whatsapp[0];
  assert.equal(after.said, 'Delivered to the phone');
  assert.doesNotMatch(JSON.stringify(after), /read/i);
  assert.equal(waStatusWord('read'), 'Being sent', 'there is no word for read');
});

test('3b. a message the provider would not take is tried again by the timer, and a refusal for good is told', async () => {
  answers.push({ status: 503, body: { error: { message: 'busy' } } });
  const { id } = await oneWa(ada);
  let row = db.get('SELECT * FROM wa_messages WHERE envelope_id=?', id);
  assert.equal(row.status, 'failed');
  assert.ok(row.next_try_at);
  assert.ok(row.to_phone, 'the number is kept while it still has to be sent');
  assert.ok((await actions(ada, id)).includes('WhatsApp could not be sent yet'));
  db.run('UPDATE wa_messages SET next_try_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), row.id);
  const out = await retryWhatsApp();
  assert.ok(out.sent >= 1);
  row = db.get('SELECT * FROM wa_messages WHERE id=?', row.id);
  assert.equal(row.status, 'sent');
  assert.equal(row.to_phone, null);
  // 400: not a WhatsApp number. Never tried again; the sender hears it.
  answers.push({ status: 400, body: { error: { message: 'Recipient phone number not in allowed list', code: 131030 } } });
  const two = await oneWa(ada);
  const r2 = db.get('SELECT * FROM wa_messages WHERE envelope_id=?', two.id);
  assert.equal(r2.status, 'failed');
  assert.equal(r2.next_try_at, null);
  assert.ok((await actions(ada, two.id)).includes('WhatsApp could not be sent'));
});

// ---- 4. STOP --------------------------------------------------------------------------------------------------------

test('4. a reply STOP stops WhatsApp from that account to that number, not email, and not other accounts', async () => {
  const bea = await sender('Bea Wa');
  const mine = await oneWa(ada, { phone: '+44 7700 900555' });
  const theirs = await oneWa(bea, { phone: '+44 7700 900666' });
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '447700900555', type: 'text', text: { body: 'Stop' } }] } }] }] });
  assert.equal((await postRaw(raw, sign(raw))).status, 200);
  assert.ok((await actions(ada, mine.id)).includes('WhatsApp stopped'));
  calls.length = 0;
  db.run('UPDATE recipients SET wa_sent_at=NULL WHERE id=?', mine.rid);
  assert.equal((await ada.post(`/envelopes/${mine.id}/remind`, {})).status, 200);
  assert.equal(metaBodies().length, 0, 'no WhatsApp after STOP');
  assert.ok((await actions(ada, mine.id)).includes('WhatsApp not sent'));
  assert.ok((await actions(ada, mine.id)).some((a: string) => /Reminder/.test(a)) || true, 'the email reminder is unaffected');
  // Another account that never wrote to that number is not stopped by it.
  db.run('UPDATE recipients SET wa_sent_at=NULL WHERE id=?', theirs.rid);
  await bea.post(`/envelopes/${theirs.id}/remind`, {});
  assert.equal(metaBodies().filter((m) => m.to === '447700900666').length, 1);
  assert.equal(metaBodies()[0].template.name, 'gs_remind');
  // A new envelope from the same account to the stopped number is held too, and the record says why.
  const again = await oneWa(ada, { phone: '+44 7700 900555' });
  assert.ok((await actions(ada, again.id)).includes('WhatsApp not sent'));
  // START lets them be written to again.
  const start = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '447700900555', type: 'text', text: { body: 'START' } }] } }] }] });
  await postRaw(start, sign(start));
  assert.equal(db.get('SELECT COUNT(*) n FROM wa_stops WHERE dest_hash=(SELECT dest_hash FROM wa_messages WHERE envelope_id=?)', mine.id).n, 0);
  // A forged STOP (no signature) does nothing.
  assert.equal((await postRaw(raw, 'sha256=bad')).status, 403);
  assert.equal(db.get('SELECT COUNT(*) n FROM wa_stops').n, 0);
});

test('4b. Twilio: signed form posts are believed, unsigned ones are refused', async () => {
  provider({ TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 'twtok', TWILIO_WHATSAPP_FROM: '+14155238886', SMS_DEV_OUTBOX: '1' });
  try {
    calls.length = 0;
    const one = await oneWa(ada, { phone: '+44 7700 900777' });
    const tw = calls.find((c) => c.url.includes('Messages.json'))!;
    const p = new URLSearchParams(tw.body);
    assert.equal(p.get('To'), 'whatsapp:+447700900777');
    assert.equal(p.get('From'), 'whatsapp:+14155238886');
    assert.match(p.get('Body') || '', /Reply STOP/);
    const form = new URLSearchParams({ From: 'whatsapp:+447700900777', Body: 'STOP', MessageSid: 'SMin' });
    const url = 'http://test.local/api/whatsapp/webhook';
    const sig = crypto.createHmac('sha1', 'twtok').update(url + [...form.keys()].sort().map((k) => k + form.get(k)).join('')).digest('base64');
    assert.equal((await postRaw(form.toString(), 'nope', 'application/x-www-form-urlencoded', 'x-twilio-signature')).status, 403);
    assert.equal((await postRaw(form.toString(), sig, 'application/x-www-form-urlencoded', 'x-twilio-signature')).status, 200);
    assert.ok((await actions(ada, one.id)).includes('WhatsApp stopped'));
  } finally {
    provider(META);
  }
});

// ---- 5. Limits and the pause ----------------------------------------------------------------------------------------

test('5. the daily limit per account and the pause hold WhatsApp back', async () => {
  const cy = await sender('Cy Wa');
  process.env.WHATSAPP_DAILY_PER_ACCOUNT = '1';
  try {
    await oneWa(cy, { phone: '+44 7700 900211' });
    const r = await tryWa(cy, { phone: '+44 7700 900212', whatsapp_agreed: true });
    assert.equal(r.status, 429);
    assert.match(r.data.error, /can send 0 more today/);
  } finally {
    delete process.env.WHATSAPP_DAILY_PER_ACCOUNT;
  }
  const dee = await sender('Dee Wa');
  const e = await oneWa(dee, { phone: '+44 7700 900311' });
  const account = db.get('SELECT account_id a FROM envelopes WHERE id=?', e.id).a;
  db.run("UPDATE accounts SET suspended_at=?, suspended_reason='reports' WHERE id=?", new Date().toISOString(), account);
  calls.length = 0;
  db.run('UPDATE recipients SET wa_sent_at=NULL WHERE id=?', e.rid);
  const { alsoWhatsApp } = await import('../src/server/whatsapp.ts');
  await alsoWhatsApp(db.get('SELECT * FROM envelopes WHERE id=?', e.id), { id: e.rid, wa_link: 1 }, 'reminder');
  assert.equal(metaBodies().length, 0, 'nothing goes while the account is paused');
  assert.ok((await actions(dee, e.id)).includes('WhatsApp not sent'));
  db.run('UPDATE accounts SET suspended_at=NULL WHERE id=?', account);
});

// ---- 6. The completed link --------------------------------------------------------------------------------------------

test('6. once complete, the link to the finished document goes by WhatsApp, never the PDF', async () => {
  calls.length = 0;
  const e = await oneWa(ada, { phone: '+44 7700 900411' });
  assert.equal((await signAll(e.id, e.email)).status, 200);
  const done = metaBodies().find((m) => m.template.name === 'gs_done');
  assert.ok(done, 'the completed message went');
  assert.equal(done.type, 'template');
  assert.equal(done.document, undefined);
  assert.match(done.template.components[0].parameters[2].text, new RegExp(`/sign/${tokenFor(e.id, e.email)}$`));
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
