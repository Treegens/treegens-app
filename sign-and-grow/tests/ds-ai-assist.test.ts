// AI help when sending and signing (src/server/aiassist.ts, src/server/routes-aiassist.ts, src/lib/aiassist.ts):
// the read switch and that nothing is sent without it, suggested fields checked and bad ones dropped, the summary for
// signers (its words, written once, the record line without AI words), the drafted message through the fake-notice
// filter, the daily limit and a model that is down. The model is a fetch stub: these tests never reach the network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { boot, Client, signUp, tokenFor } from './helpers.ts';

const { db } = await boot();
const lib = await import('../src/lib/aiassist.ts');
const ai = await import('../src/server/aiassist.ts');

const realFetch = globalThis.fetch;
type Call = { url: string; body: any };
let calls: Call[] = [];
function stub(handler: (call: Call) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const call: Call = { url: String(url), body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return handler(call);
  }) as any;
}
const KEYS = ['SUPPORT_CHAT_API_KEY', 'SUPPORT_CHAT_BASE_URL', 'SUPPORT_CHAT_MODEL', 'SUPPORT_CHAT_PROVIDER_COUNTRY', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY', 'SUPPORT_CHAT_DAILY_LIMIT', 'AI_ASSIST_DAILY_LIMIT', 'DEPLOYMENT_PROFILE'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const model = (on = true) => {
  for (const k of KEYS) delete process.env[k];
  if (on) Object.assign(process.env, { SUPPORT_CHAT_API_KEY: 'test-key', SUPPORT_CHAT_BASE_URL: 'https://llm.example.org/v1', SUPPORT_CHAT_MODEL: 'kimi-test', SUPPORT_CHAT_PROVIDER_COUNTRY: 'Iceland' });
};
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
});
const enc = new TextEncoder();
const sse = (parts: string[]) =>
  new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

let n = 0;
const person = async () => signUp(`Sender ${++n}`, `assist${n}@example.com`, `198.51.100.${n + 40}`);
const readOn = async (c: Client) => assert.equal((await c.put('/account/ai-read', { read: 'on' })).status, 200);

const LEASE = 'This lease is between Rosa Diaz, the landlord, and Sam Lee, the tenant, for the flat at 4 Elm Road. The rent is 900 dollars a month, paid on the first day of each month. Either of them can end it with two months notice in writing.';
async function leasePdf() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([612, 792]);
  LEASE.match(/.{1,80}(\s|$)/g)!.forEach((line, i) => p.drawText(line.trim(), { x: 72, y: 700 - i * 16, size: 11, font }));
  return d.save();
}
async function sendLease(c: Client, email: string) {
  const f = new FormData();
  f.append('file', new Blob([await leasePdf()], { type: 'application/pdf' }), 'Lease.pdf');
  const file = (await c.call('POST', '/files', f)).data;
  const r = await c.post('/envelopes', {
    subject: 'Lease', send: true, documents: [{ id: 'd', file_id: file.id, name: 'Lease' }],
    recipients: [{ id: 'r', role: 'signer', name: 'Sam Lee', email }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
const page = { doc: 'd1', page: 0, w: 612, h: 792, items: [{ str: 'Tenant signature', x: 72, y: 600, w: 90, h: 11 }, { str: 'Date', x: 360, y: 600, w: 25, h: 11 }] };

// ---- 1. The switch, and nothing sent without it ------------------------------------------------------------------
test('with no model on the server nothing is offered, the read switch cannot be turned on, and nothing is sent', async () => {
  model(false);
  stub(() => sse(['x']));
  const c = await person();
  const info = (await c.get('/ai/assist')).data;
  assert.equal(info.available, false);
  assert.equal(info.model, undefined, 'no model name when nothing may be asked');
  const on = await c.put('/account/ai-read', { read: 'on' });
  assert.equal(on.status, 409);
  assert.match(on.data.error, /Nothing was changed\.$/);
  for (const [url, body] of [['/ai/fields', { pages: [page] }], ['/ai/draft', { documents: ['Lease'], people: [] }]] as const) {
    const r = await c.post(url, body);
    assert.equal(r.status, 403, url);
    assert.equal(r.data.code, 'ai_off');
  }
  assert.equal(calls.length, 0, 'not one request left the server');
});

test('the read switch is off by default, admins only, never by API key, on the security record; with it off nothing reads a document', async () => {
  model();
  stub(() => sse(['{"fields":[]}']));
  const c = await person();
  const info = (await c.get('/ai/assist')).data;
  assert.deepEqual([info.available, info.read, info.draft, info.fields, info.summary], [true, false, true, false, false]);
  assert.equal(info.where, 'The text goes to the service at llm.example.org (llm.example.org), which runs the model kimi-test, in Iceland.');
  const f = await c.post('/ai/fields', { pages: [page] });
  assert.equal(f.status, 403);
  assert.equal(f.data.code, 'read_off');
  assert.equal(calls.length, 0);
  const key = (await c.post('/api-keys', { name: 'k', scope: 'admin' })).data.key;
  const viaKey = await new Client().call('PUT', '/account/ai-read', { read: 'on' }, { authorization: `Bearer ${key}` });
  assert.equal(viaKey.status, 403);
  await readOn(c);
  assert.equal((await c.get('/ai/assist')).data.fields, true);
  const acct = db.get('SELECT a.id FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email=?', `assist${n}@example.com`).id;
  const ev = db.all("SELECT details FROM security_events WHERE kind='settings.changed' AND account_id=?", acct).map((r: any) => r.details).join(' ');
  assert.match(ev, /ai_reads_document_text/);
  // The account's AI switch off turns everything off again, the read switch with it.
  assert.equal((await c.put('/account/policy', { ai_helper: 'off' })).status, 200);
  assert.equal((await c.get('/ai/assist')).data.available, false);
  assert.equal((await c.post('/ai/fields', { pages: [page] })).status, 403);
  assert.equal(calls.length, 0);
});

test('under the government profile a hosted model is never used', async () => {
  model();
  process.env.DEPLOYMENT_PROFILE = 'government';
  delete process.env.SUPPORT_CHAT_BASE_URL;
  const c = await person();
  assert.equal((await c.get('/ai/assist')).data.available, false);
});

// ---- 2. Suggested fields -----------------------------------------------------------------------------------------
test('suggested fields: text with positions is sent, never a picture; every answer is checked and bad ones dropped', async () => {
  model();
  const answer = { fields: [
    { type: 'signature', page: 0, box: [170, 230, 390, 280], signer: 1, label: 'Tenant signature' }, // good
    { type: 'date_signed', page: 0, box: [600, 240, 780, 270], signer: 1 }, // good
    { type: 'signature', page: 0, box: [180, 240, 380, 270], signer: 1 }, // on top of the first: dropped
    { type: 'script', page: 0, box: [100, 100, 200, 130] }, // unknown kind
    { type: 'text', page: 3, box: [100, 100, 200, 130] }, // a page that was not sent
    { type: 'text', page: 0, box: [900, 100, 1200, 130] }, // off the page
    { type: 'text', page: 0, box: [300, 100, 200, 130] }, // backwards
    { type: 'initials', page: 0, box: [100, 500, 160, 540], signer: 7 }, // a signer who does not exist
    { type: 'text', page: 0, box: [100, 700, 300, 730], label: '<b>See https://evil.example</b> Name' }, // label made plain
    { type: 'checkbox', page: 0, box: [50, 50, 70, 70] }, // on a field that is already there
  ] };
  stub(() => sse(['Here you go: ```json\n', JSON.stringify(answer), '\n```']));
  const c = await person();
  await readOn(c);
  const r = await c.post('/ai/fields', { signers: 2, pages: [{ ...page, taken: [{ x: 0.04, y: 0.04, w: 0.04, h: 0.04 }] }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const got = r.data.suggestions;
  assert.deepEqual(got.map((s: any) => s.type), ['signature', 'date_signed', 'text']);
  assert.ok(got.every((s: any) => s.doc === 'd1' && s.page === 0 && s.x >= 0 && s.x + s.w <= 1 && s.y + s.h <= 1));
  assert.equal(got[0].label, 'Tenant signature');
  assert.equal(got[2].label, 'See Name', 'no markup and no link in a label');
  const sent = JSON.stringify(calls[0].body);
  assert.match(sent, /\[\d+,\d+,\d+,\d+\] Tenant signature/);
  assert.doesNotMatch(sent, /image_url|data:image|base64/);
  // Nonsense, a picture-free page with no text, and a broken answer give nothing, and say so plainly.
  stub(() => sse(['not json at all']));
  assert.deepEqual((await c.post('/ai/fields', { pages: [page] })).data.suggestions, []);
  const empty = await c.post('/ai/fields', { pages: [{ ...page, items: [] }] });
  assert.deepEqual(empty.data, { suggestions: [], pages: 0 });
  assert.equal(calls.length, 1, 'a page without text is never sent');
  assert.equal((await c.post('/ai/fields', { pages: 'everything' })).status, 400);
});

test('the checks alone: inside the page, a known kind, no overlap', () => {
  const pages = ai.cleanPages([page]);
  const ok = ai.checkSuggestions({ fields: [{ type: 'full_name', page: 0, box: [0, 0, 200, 30] }, { type: 'full_name', page: 0, box: [100, 10, 300, 40] }, { type: 'checkbox', page: 0, box: [990, 990, 1000, 1000] }] }, pages, 1);
  assert.deepEqual(ok.map((s) => s.type), ['full_name', 'checkbox']);
  assert.deepEqual(ai.checkSuggestions(null, pages, 1), []);
  assert.deepEqual(ai.checkSuggestions({ fields: 'x' }, pages, 1), []);
});

// ---- 3. Summary for signers --------------------------------------------------------------------------------------
test('summary: the sender switches it on, it is written once per file, shown with its warning, and the record says so once, without AI words', async () => {
  model();
  const c = await person();
  const e = await sendLease(c, 'sam.lee@example.com');
  // Not without the read switch.
  const off = await c.put(`/envelopes/${e.id}/ai-summary`, { on: true });
  assert.equal(off.status, 403);
  await readOn(c);
  assert.equal((await c.put(`/envelopes/${e.id}/ai-summary`, { on: true })).status, 200);
  const tok = tokenFor(e.id, 'sam.lee@example.com');
  const s = new Client();
  s.ip = '192.0.2.77';
  await s.post(`/sign/${tok}/consent`);
  const sg = (await s.get(`/sign/${tok}`)).data;
  assert.equal(sg.ai_summary, true, JSON.stringify(sg).slice(0, 600));
  stub(() => sse(['- Rosa Diaz rents the flat at 4 Elm Road to Sam Lee for 900 dollars a month.\n', '- Either can end it with two months notice.\n', '- This lease is legally binding and enforceable. See https://evil.example for more.']));
  const r = await s.post(`/sign/${tok}/summary`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.warning, 'Made by an AI. It may be wrong. It is not the agreement and not legal advice. Read the document.');
  const text = r.data.documents[0].text;
  assert.match(text, /Rosa Diaz rents the flat/);
  assert.doesNotMatch(text, /binding|enforceable|https?:|evil\.example/, 'no claims about the law and no links');
  assert.doesNotMatch(text, /—/);
  assert.match(JSON.stringify(calls[0].body), /4 Elm Road/, 'the document text went to the model');
  // Again, and for anyone else: no second model call.
  const again = await s.post(`/sign/${tok}/summary`);
  assert.equal(again.data.documents[0].text, text);
  assert.equal(calls.length, 1, 'written once per file');
  const lines = db.all("SELECT action, detail FROM audit WHERE envelope_id=? AND action='Opened the summary'", e.id);
  assert.equal(lines.length, 1, 'said once on the record');
  assert.doesNotMatch(lines[0].detail, /\bAI\b|model|Kimi/i, 'no AI words in the signed record');
  assert.match(lines[0].detail, /It is not part of what was signed\./);
  // The sender switches it off: there is no summary any more, and the page is not told about one.
  assert.equal((await c.put(`/envelopes/${e.id}/ai-summary`, { on: false })).status, 200);
  assert.equal((await s.post(`/sign/${tok}/summary`)).status, 404);
  assert.equal((await s.get(`/sign/${tok}`)).data.ai_summary, undefined);
  // The kept summary goes with its file.
  const fileId = db.get('SELECT file_id FROM documents WHERE envelope_id=?', e.id).file_id;
  assert.ok(db.get('SELECT 1 x FROM ai_summaries WHERE file_id=?', fileId));
});

test('summary: the model down gives a plain sentence, nothing on the record, and the ask back; a link that is not yours gets nothing', async () => {
  model();
  const c = await person();
  await readOn(c);
  const e = await sendLease(c, 'tia@example.com');
  await c.put(`/envelopes/${e.id}/ai-summary`, { on: true });
  const tok = tokenFor(e.id, 'tia@example.com');
  const s = new Client();
  s.ip = '192.0.2.78';
  await s.post(`/sign/${tok}/consent`);
  stub(() => new Response('down', { status: 503 }));
  const before = ai.usedToday(e.account_id);
  const r = await s.post(`/sign/${tok}/summary`);
  assert.equal(r.status, 200);
  assert.equal(r.data.documents[0].text, null);
  assert.equal(r.data.note, lib.SUMMARY_DOWN);
  assert.equal(ai.usedToday(e.account_id), before, 'the ask was given back');
  assert.equal(db.all("SELECT 1 FROM audit WHERE envelope_id=? AND action='Opened the summary'", e.id).length, 0);
  assert.equal((await new Client().post('/sign/not-a-real-link/summary')).status, 404);
  // A document with no summary switched on: 404, and the model is never asked.
  const other = await sendLease(c, 'uma@example.com');
  stub(() => sse(['- x']));
  const t2 = tokenFor(other.id, 'uma@example.com');
  await new Client().post(`/sign/${t2}/consent`);
  assert.equal((await new Client().post(`/sign/${t2}/summary`)).status, 404);
  assert.equal(calls.length, 0);
});

// ---- 4. Drafted message ------------------------------------------------------------------------------------------
test('draft a message: names and people only with the read switch off, the text with it on, and the fake-notice filter', async () => {
  model();
  const c = await person();
  const e = await sendLease(c, 'vic@example.com');
  stub(() => sse([JSON.stringify({ subject: 'Please sign the lease — thanks', message: 'Hi Sam, here is the lease for 4 Elm Road. It is legally binding. Please read it and sign when you are ready. www.evil.example' })]));
  const body = { envelope_id: e.id, documents: ['Lease'], people: [{ name: 'Sam Lee', role: 'signer' }] };
  const r = await c.post('/ai/draft', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.read, false);
  assert.equal(r.data.subject, 'Please sign the lease, thanks');
  assert.doesNotMatch(r.data.message, /binding|www\.|evil/);
  const sent = JSON.stringify(calls[0].body);
  assert.match(sent, /Sam Lee \(signs\)/);
  assert.doesNotMatch(sent, /900 dollars/, 'no document text without the switch');
  await readOn(c);
  stub(() => sse([JSON.stringify({ subject: 'Lease', message: 'Please sign.' })]));
  assert.equal((await c.post('/ai/draft', body)).data.read, true);
  assert.match(JSON.stringify(calls[0].body), /900 dollars/);
  // A lure: a brand, money and a phone number. Refused here, before the sender relies on it.
  stub(() => sse([JSON.stringify({ subject: 'PayPal invoice', message: 'Your PayPal account was charged $499.99. Call +1 888 555 0142 to cancel.' })]));
  const lure = await c.post('/ai/draft', body);
  assert.equal(lure.status, 422);
  assert.equal(lure.data.error, lib.DRAFT_REFUSED);
  // Someone else's envelope is not read.
  const d = await person();
  await readOn(d);
  stub(() => sse([JSON.stringify({ subject: 'x', message: 'y' })]));
  assert.equal((await d.post('/ai/draft', body)).status, 404);
  assert.equal((await d.post('/ai/draft', { documents: [] })).status, 400);
});

// ---- 5. Limits and a model that is down --------------------------------------------------------------------------
test('a daily limit per account, and a plain sentence when the model is down', async () => {
  model();
  process.env.AI_ASSIST_DAILY_LIMIT = '2';
  const c = await person();
  stub(() => new Response('down', { status: 500 }));
  const down = await c.post('/ai/draft', { documents: ['Lease'] });
  assert.equal(down.status, 503);
  assert.equal(down.data.error, lib.MODEL_DOWN);
  stub(() => Promise.reject(new Error('offline')));
  assert.equal((await c.post('/ai/draft', { documents: ['Lease'] })).data.error, lib.MODEL_DOWN);
  stub(() => sse([JSON.stringify({ subject: 'Lease', message: 'Please sign.' })]));
  assert.equal((await c.post('/ai/draft', { documents: ['Lease'] })).status, 200, 'asks that failed were given back');
  assert.equal((await c.post('/ai/draft', { documents: ['Lease'] })).status, 200);
  const full = await c.post('/ai/draft', { documents: ['Lease'] });
  assert.equal(full.status, 429);
  assert.equal(full.data.error, lib.DAILY_FULL(2));
  assert.equal((await c.get('/ai/assist')).data.left, 0);
  process.env.AI_ASSIST_DAILY_LIMIT = '0';
  assert.equal((await c.get('/ai/assist')).data.available, false, '0 switches it off');
});

test('every sentence a person sees says what happened and what to do, with no em dashes', () => {
  for (const s of [lib.MODEL_DOWN, lib.DAILY_FULL(5), lib.SUMMARY_DOWN, lib.DRAFT_REFUSED, lib.NOT_ALLOWED, lib.READ_OFF, lib.SUMMARY_WARNING, lib.SUMMARY_CHOICE_HINT, lib.SUMMARY_AFTER]) {
    assert.doesNotMatch(s, /—/);
    assert.ok(s.split(/(?<=\.)\s+/).length >= 2, s);
  }
  assert.doesNotMatch(lib.SUMMARY_LINK + lib.SUMMARY_WARNING, /valid|hold up|binding/i);
});

// ---- Repairs after the skeptic and the simplicity review ---------------------------------------------------------
test('nothing the AI writes carries a phone number, an email address or a request for payment details; amounts and dates stay', () => {
  for (const bad of ['Urgent: call 1-800-555-0199 to confirm your bank details before signing.', 'Please call +1 800 555 0199.', 'Email pay@evil.example to confirm.',
    'Ring (800) 555-0199 today.', 'Call 0800 555 0199 now.', 'Send us your card number.', 'Buy gift cards and send the codes.', 'Call 18005550199 now.'])
    assert.equal(ai.reachesOut(bad), true, bad);
  for (const ok of ['The rent is 900 dollars a month, paid on 2026-11-01.', 'The deposit is $1,200,000.00 for flat 12.', 'It runs from 01.02.2026 to 31.01.2027.', 'Either can end it with two months notice.'])
    assert.equal(ai.reachesOut(ok), false, ok);
  assert.equal(ai.withoutReach('- Rent 900 dollars a month.\n- Urgent: call 1-800-555-0199 to confirm.\n- Two months notice.', 'line'), '- Rent 900 dollars a month.\n- Two months notice.');
  assert.equal(ai.withoutReach('Here is the lease. Please call +1 800 555 0199 or email pay@evil.example to confirm. Sign when ready.\n\nThanks.', 'sentence'), 'Here is the lease. Sign when ready.\n\nThanks.');
});

async function summaryFor(answer: string, email: string, ip: string) {
  model();
  const c = await person();
  await readOn(c);
  const e = await sendLease(c, email);
  assert.equal((await c.put(`/envelopes/${e.id}/ai-summary`, { on: true })).status, 200);
  const tok = tokenFor(e.id, email);
  const s = new Client();
  s.ip = ip;
  await s.post(`/sign/${tok}/consent`);
  stub(() => sse([answer]));
  return { c, e, tok, s, r: await s.post(`/sign/${tok}/summary`) };
}

test('summary: a line the document talked the model into (a phone number, payment details) is not shown to the signer', async () => {
  const { r } = await summaryFor('- Rosa Diaz rents the flat to Sam Lee for 900 dollars a month.\n- Urgent: call 1-800-555-0199 to confirm your bank details before signing.\n- Write to pay@evil.example with questions.\n- Two months notice ends it.', 'wes@example.com', '192.0.2.81');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const t = r.data.documents[0].text;
  assert.match(t, /900 dollars/);
  assert.match(t, /Two months notice/);
  assert.doesNotMatch(t, /555|bank details|@/);
});

test('summary: once the person finished, or the envelope is completed, it is not offered or shown, and the record has no line after the signature', async () => {
  const { e, tok, s } = await summaryFor('- Rosa Diaz rents the flat to Sam Lee.', 'xan@example.com', '192.0.2.82');
  const { PNG } = await import('./helpers.ts');
  const view = (await s.get(`/sign/${tok}`)).data;
  const values = Object.fromEntries((view.fields || []).map((f: any) => [f.id, '1']));
  const done = await s.post(`/sign/${tok}/complete`, { values, signature_png: PNG, version: view.version });
  assert.equal(done.data.envelope_status, 'completed', JSON.stringify(done.data).slice(0, 300));
  const before = db.all('SELECT action FROM audit WHERE envelope_id=? ORDER BY rowid', e.id).length;
  stub(() => sse(['- x']));
  const r = await s.post(`/sign/${tok}/summary`);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, lib.SUMMARY_AFTER);
  assert.equal(calls.length, 0, 'the model is not asked');
  assert.equal(db.all('SELECT action FROM audit WHERE envelope_id=?', e.id).length, before, 'no line after the signature');
  assert.equal((await s.get(`/sign/${tok}`)).data.ai_summary, undefined, 'the page is not told about a summary any more');
  const shown = db.all("SELECT detail FROM audit WHERE envelope_id=? AND action='Opened the summary'", e.id);
  for (const l of shown) assert.match(l.detail, /shown with the document, before signing/);
});

test('draft: a sentence with a phone number or an email address is left out, and a refused lure gives the day back', async () => {
  model();
  process.env.AI_ASSIST_DAILY_LIMIT = '1';
  const c = await person();
  stub(() => sse([JSON.stringify({ subject: 'Lease to sign', message: 'Here is the lease for 4 Elm Road. Please call +1 800 555 0199 or email pay@evil.example to confirm. Sign when you are ready.' })]));
  const r = await c.post('/ai/draft', { documents: ['Lease'], people: [{ name: 'Sam Lee', role: 'signer' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.message, 'Here is the lease for 4 Elm Road. Sign when you are ready.');
  process.env.AI_ASSIST_DAILY_LIMIT = '2';
  stub(() => sse([JSON.stringify({ subject: 'PayPal invoice', message: 'Your PayPal account was charged $499.99. Call +1 888 555 0142 to cancel.' })]));
  const lure = await c.post('/ai/draft', { documents: ['Lease'] });
  assert.equal(lure.status, 422, 'still refused: the lure is read as the model wrote it');
  assert.equal((await c.get('/ai/assist')).data.left, 1, 'the refused ask does not count');
});

test('kept summaries are sealed when the server starts with a key; one no key can open is deleted and written again', async () => {
  const { e, tok, s } = await summaryFor('- Rosa Diaz rents the flat to Sam Lee for 900 dollars a month.', 'yul@example.com', '192.0.2.83');
  const fileId = db.get('SELECT file_id FROM documents WHERE envelope_id=?', e.id).file_id;
  assert.match(db.get('SELECT text FROM ai_summaries WHERE file_id=?', fileId).text, /Rosa Diaz/, 'in the clear without a key');
  const crypto = await import('node:crypto');
  const saved = [process.env.FILE_ENCRYPTION_KEY, process.env.FILE_ENCRYPTION_KEYS_OLD];
  try {
    process.env.FILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    assert.ok(ai.sealKeptSummaries() >= 1);
    const row = db.get('SELECT text, text_sealed, text_key FROM ai_summaries WHERE file_id=?', fileId);
    assert.equal(row.text, null);
    assert.ok(row.text_sealed && row.text_key);
    assert.match((await s.post(`/sign/${tok}/summary`)).data.documents[0].text, /Rosa Diaz/, 'still shown, from the sealed row');
    // The key is replaced and the old one dropped: the row can no longer be opened.
    process.env.FILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    assert.ok(ai.sealKeptSummaries() >= 1);
    assert.ok(!db.get('SELECT 1 x FROM ai_summaries WHERE file_id=?', fileId), 'deleted, so it is written again');
    stub(() => sse(['- Rosa Diaz rents the flat to Sam Lee.']));
    assert.match((await s.post(`/sign/${tok}/summary`)).data.documents[0].text, /Rosa Diaz/);
    assert.equal(calls.length, 1);
    assert.equal((await s.post(`/sign/${tok}/summary`)).status, 200);
    assert.equal(calls.length, 1, 'written once again, then kept');
  } finally {
    saved[0] === undefined ? delete process.env.FILE_ENCRYPTION_KEY : (process.env.FILE_ENCRYPTION_KEY = saved[0]);
    saved[1] === undefined ? delete process.env.FILE_ENCRYPTION_KEYS_OLD : (process.env.FILE_ENCRYPTION_KEYS_OLD = saved[1]);
  }
});

test('what the pages say the AI service gets is true of what Draft a message sends', async () => {
  model();
  assert.doesNotMatch(lib.READ_SENT, /Nothing that says who/);
  assert.match(lib.READ_SENT, /sender's name and account name/);
  const { dataPlace } = await import('../src/lib/dataplace.ts');
  const chat = dataPlace().processors.find((p: any) => p.id === 'chat');
  assert.equal(chat.who, lib.READ_WHO, 'the who line names senders and the people on their documents');
  assert.match(lib.READ_ALSO, /Draft a message/);
  for (const f of ['src/app/security/DataPlace.tsx', 'src/app/security/processing/page.tsx']) {
    const src = (await import('node:fs')).readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /READ_ALSO/, f);
  }
  // The help chat switch says it also turns Draft a message on, where it does.
  const c = await person();
  assert.equal((await c.get('/account/policy')).data.ai_assist, true);
  process.env.AI_ASSIST_DAILY_LIMIT = '0';
  assert.equal((await c.get('/account/policy')).data.ai_assist, false);
});

test('the words the screens show: one line for the switch, nothing "beside", no UTC for a busy sender', async () => {
  assert.equal(lib.READ_HINT.split(/(?<=\.)\s+/).length, 1, 'one line on what the switch is for');
  assert.doesNotMatch(lib.READ_HINT, /Saves by itself/);
  assert.doesNotMatch(lib.SUMMARY_CHOICE_HINT + ai.SUMMARY_AUDIT_DETAIL, /beside/);
  assert.doesNotMatch(lib.DAILY_FULL(5), /UTC|midnight/);
  for (const s of [lib.SUMMARY_AFTER, lib.READ_WHO]) assert.doesNotMatch(s, /—/);
  const fs = await import('node:fs');
  const src = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  // Zero setup: Settings asks /ai/assist only where the account's AI is on.
  assert.match(src('src/components/settings/AiSettings.tsx'), /on \? api\('\/ai\/assist'\)/);
  // Closing the summary puts the focus back on its link, and Escape closes it.
  const sum = src('src/components/sign/Summary.tsx');
  assert.match(sum, /link\.current\?\.focus\(\)/);
  assert.match(sum, /e\.key === 'Escape'/);
  // Suggestions are drawn on the page before they are added.
  assert.match(src('src/components/editor/StepFields.tsx'), /suggest\.outlines\(d\.id, page\)/);
});
