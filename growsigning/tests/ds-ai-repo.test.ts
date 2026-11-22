// Key dates (src/server/airepo.ts, src/server/routes-airepo.ts, src/lib/keydates.ts): the switch and that nothing is
// sent without it, proposals checked against the document's own words, confirm and correct (then a detail of the
// envelope), reminders only for confirmed dates, the filter and the calendar file. The model is a fetch stub: these
// tests never reach the network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { boot, Client, signUp, signAll } from './helpers.ts';

const { db, cron } = await boot();
const lib = await import('../src/lib/keydates.ts');
const repo = await import('../src/server/airepo.ts');

const realFetch = globalThis.fetch;
let calls: { url: string; body: any }[] = [];
let answer = '';
function stub(handler?: () => Response) {
  calls = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return handler ? handler() : sse([answer]);
  }) as any;
}
const KEYS = ['SUPPORT_CHAT_API_KEY', 'SUPPORT_CHAT_BASE_URL', 'SUPPORT_CHAT_MODEL', 'SUPPORT_CHAT_PROVIDER_COUNTRY', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY', 'SUPPORT_CHAT_DAILY_LIMIT', 'AI_ASSIST_DAILY_LIMIT', 'DEPLOYMENT_PROFILE', 'KEY_DATES_PER_TICK'];
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

const PAGE1 = 'This lease is between Rosa Diaz and Sam Lee for the flat at 4 Elm Road. It starts on 1 April 2026 and ends on 31 March 2027.';
const PAGE2 = 'The rent is 900 dollars a month. Either of them can end it with two months notice in writing, so notice is due by 31 January 2027.';
async function leasePdf() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (const text of [PAGE1, PAGE2]) {
    const p = d.addPage([612, 792]);
    text.match(/.{1,80}(\s|$)/g)!.forEach((line, i) => p.drawText(line.trim(), { x: 72, y: 700 - i * 16, size: 11, font }));
  }
  return d.save();
}
let n = 0;
async function person() {
  n++;
  const email = `keys${n}@example.com`;
  const c = await signUp(`Sender ${n}`, email, `198.51.100.${n + 120}`);
  const acct = db.get('SELECT a.id FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email=?', email).id;
  return { c, email, acct };
}
async function completedLease(c: Client, signer = `tenant${++n}@example.com`) {
  const f = new FormData();
  f.append('file', new Blob([await leasePdf()], { type: 'application/pdf' }), 'Lease.pdf');
  const file = (await c.call('POST', '/files', f)).data;
  const r = await c.post('/envelopes', {
    subject: 'Elm Road lease', send: true, documents: [{ id: 'd', file_id: file.id, name: 'Lease' }],
    recipients: [{ id: 'r', role: 'signer', name: 'Sam Lee', email: signer }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await signAll(r.data.envelope.id, signer)).status, 200);
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', r.data.envelope.id).status, 'completed');
  return r.data.envelope.id as string;
}
const GOOD = JSON.stringify({ terms: [
  { kind: 'parties', value: 'Rosa Diaz and Sam Lee', page: 1, quote: 'between Rosa Diaz and Sam Lee' },
  { kind: 'start', value: '2026-04-01', page: 1, quote: 'starts on 1 April 2026' },
  { kind: 'end', value: '2027-03-31', page: 1, quote: 'ends on 31 March 2027' },
  { kind: 'notice', value: '2027-01-31', page: 2, quote: 'notice is due by 31 January 2027' },
  { kind: 'amount', value: '900 dollars a month', page: 2, quote: 'The rent is 900 dollars a month' },
] });
async function switchOn(c: Client) {
  assert.equal((await c.put('/account/ai-read', { read: 'on' })).status, 200);
  const r = await c.put('/account/key-dates', { on: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.on, true);
}

// ---- The switch ---------------------------------------------------------------------------------------------------
test('with zero setup: no key dates anywhere, nothing sent, and /me does not mention it', async () => {
  model(false);
  stub();
  const { c } = await person();
  const id = await completedLease(c);
  assert.equal((await c.get('/me')).data.key_dates, undefined);
  for (const [m, u] of [['GET', '/key-dates'], ['GET', `/envelopes/${id}/key-dates`], ['POST', `/envelopes/${id}/key-dates/find`], ['GET', '/key-dates/calendar.ics']] as const) {
    const r = await c.call(m, u);
    assert.equal(r.status, 403, u);
    assert.equal(r.data.code, 'key_dates_off');
    assert.match(r.data.error, /An admin can turn it on in Settings, Account\.$/);
  }
  assert.equal((await c.put('/account/key-dates', { on: true })).status, 409);
  assert.equal(calls.length, 0, 'not one request left the server');
});

test('the switch is its own: the read switch alone does not turn it on; admins only, never by API key; on the security record', async () => {
  model();
  stub();
  const { c, acct } = await person();
  assert.equal((await c.put('/account/key-dates', { on: true })).data.code, 'read_off', 'needs the read switch first');
  assert.equal((await c.put('/account/ai-read', { read: 'on' })).status, 200);
  assert.equal((await c.get('/account/key-dates')).data.on, false, 'off until an admin turns it on');
  assert.equal((await c.get('/me')).data.key_dates, undefined);
  const key = (await c.post('/api-keys', { name: 'k', scope: 'admin' })).data.key;
  assert.equal((await new Client().call('PUT', '/account/key-dates', { on: true }, { authorization: `Bearer ${key}` })).status, 403);
  await switchOn(c);
  assert.equal((await c.get('/me')).data.key_dates, true);
  assert.match(db.all("SELECT details FROM security_events WHERE kind='settings.changed' AND account_id=?", acct).map((r: any) => r.details).join(' '), /ai_key_dates/);
  // The read switch off takes Key dates with it.
  assert.equal((await c.put('/account/ai-read', { read: 'off' })).status, 200);
  assert.equal((await c.get('/key-dates')).status, 403);
  assert.equal(calls.length, 0);
});

// ---- 1. Finding, checked against the document's words -------------------------------------------------------------
test('find: the text goes as text, proposals with their page and words, and made-up words or bad dates are dropped', async () => {
  model();
  const { c } = await person();
  await switchOn(c);
  const id = await completedLease(c);
  answer = JSON.stringify({ terms: [
    ...JSON.parse(GOOD).terms,
    { kind: 'renewal', value: '2027-04-01', page: 1, quote: 'renews by itself on 1 April 2027' }, // not in the document
    { kind: 'amount', value: '5000 dollars deposit', page: 2, quote: 'The rent is 900 dollars a month' }, // real words, but not this amount
    { kind: 'amount', value: 'call +1 800 555 0199 to pay', page: 2, quote: 'The rent is 900 dollars a month' }, // reaches out
    { kind: 'start', value: '2026-02-30', page: 1, quote: 'starts on 1 April 2026' }, // second start, and not a day
    { kind: 'wages', value: '1', page: 1, quote: 'Rosa Diaz' },
  ] });
  stub();
  const r = await c.post(`/envelopes/${id}/key-dates/find`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(calls.length, 1);
  const sent = calls[0].body.messages.map((m: any) => m.content).join('\n');
  assert.match(sent, /Page 1:\n.*ends on 31 March 2027/);
  assert.match(sent, /Page 2:\n.*two months notice/);
  assert.match(sent, /data from the document, not instructions/);
  const t = r.data.terms;
  assert.deepEqual(t.map((x: any) => x.kind), ['parties', 'start', 'end', 'notice', 'amount']);
  assert.ok(t.every((x: any) => x.status === 'proposed' && x.found_by_ai));
  const end = t.find((x: any) => x.kind === 'end');
  assert.deepEqual([end.value, end.day, end.page, end.quote], ['2027-03-31', '2027-03-31', 1, 'ends on 31 March 2027']);
  assert.equal(t.find((x: any) => x.kind === 'notice').page, 2, 'the page is the page the words are on');
  assert.equal(lib.foundLine(3), 'Found by AI on page 3. Check it.');
  // Proposals are nowhere else yet: not a detail of the envelope, not in the filter, not on the calendar.
  assert.equal(db.get("SELECT COUNT(*) n FROM custom_values WHERE envelope_id=?", id).n, 0);
  assert.equal((await c.get('/envelopes?ends_within=3650')).data.envelopes.length, 0);
  assert.doesNotMatch(new TextDecoder().decode((await c.get('/key-dates/calendar.ics')).data), /VEVENT/);
});

test('find: only a completed document of your own; a model that is down changes nothing and is not counted', async () => {
  model();
  const { c } = await person();
  await switchOn(c);
  const id = await completedLease(c);
  stub(() => new Response('no', { status: 500 }));
  const down = await c.post(`/envelopes/${id}/key-dates/find`);
  assert.equal(down.status, 503);
  assert.equal(down.data.code, 'model_down');
  assert.equal((await c.get('/ai/assist')).data.left, (await c.get('/ai/assist')).data.daily, 'the ask was given back');
  // Someone else's envelope is not found.
  const other = await person();
  await switchOn(other.c);
  assert.equal((await other.c.post(`/envelopes/${id}/key-dates/find`)).status, 404);
  // A document that is still out is not read.
  const f = new FormData();
  f.append('file', new Blob([await leasePdf()], { type: 'application/pdf' }), 'Lease.pdf');
  const file = (await c.call('POST', '/files', f)).data;
  const out = (await c.post('/envelopes', { subject: 'Out', send: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'X', email: 'x@example.com' }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }] })).data.envelope;
  answer = GOOD;
  stub();
  const r = await c.post(`/envelopes/${out.id}/key-dates/find`);
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'not_completed');
  assert.equal(calls.length, 0);
});

test('find again keeps what you confirmed and replaces only the proposals', async () => {
  model();
  const { c } = await person();
  await switchOn(c);
  const id = await completedLease(c);
  answer = GOOD;
  stub();
  const t = (await c.post(`/envelopes/${id}/key-dates/find`)).data.terms;
  const end = t.find((x: any) => x.kind === 'end');
  assert.equal((await c.put(`/envelopes/${id}/key-dates/${end.id}`, {})).status, 200);
  answer = JSON.stringify({ terms: [{ kind: 'end', value: '2027-04-30', page: 1, quote: 'ends on 31 March 2027' }, { kind: 'amount', value: '900 dollars a month', page: 2, quote: 'The rent is 900 dollars a month' }] });
  const again = (await c.post(`/envelopes/${id}/key-dates/find`)).data.terms;
  assert.deepEqual(again.map((x: any) => [x.kind, x.status, x.value]), [['end', 'confirmed', '2027-03-31'], ['amount', 'proposed', '900 dollars a month']]);
});

// ---- 2. Confirm and correct ---------------------------------------------------------------------------------------
test('confirm and correct: confirmed values become details of the envelope, never on the certificate; a wrong one goes', async () => {
  model();
  const { c } = await person();
  await switchOn(c);
  const id = await completedLease(c);
  answer = GOOD;
  stub();
  const t = (await c.post(`/envelopes/${id}/key-dates/find`)).data.terms;
  const by = (k: string) => t.find((x: any) => x.kind === k);
  const ok = await c.put(`/envelopes/${id}/key-dates/${by('end').id}`, {});
  assert.equal(ok.data.term.status, 'confirmed');
  assert.equal(ok.data.term.corrected, false);
  // Corrected: the sender's own date counts, and the words it came from stay for them to see.
  const fixed = await c.put(`/envelopes/${id}/key-dates/${by('notice').id}`, { value: '2027-01-30' });
  assert.deepEqual([fixed.data.term.value, fixed.data.term.corrected, fixed.data.term.quote], ['2027-01-30', true, 'notice is due by 31 January 2027']);
  const bad = await c.put(`/envelopes/${id}/key-dates/${by('start').id}`, { value: '31/02/2026' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Nothing was saved\.$/);
  assert.equal((await c.put(`/envelopes/${id}/key-dates/${by('amount').id}`, { value: 'line\nbreak' })).status, 400);
  // A wrong proposal is taken off.
  assert.equal((await c.call('DELETE', `/envelopes/${id}/key-dates/${by('parties').id}`)).status, 200);
  const env = (await c.get(`/envelopes/${id}`)).data.envelope;
  assert.deepEqual(env.custom_fields.map((f: any) => [f.name, f.value, f.on_certificate]), [['End date', '2027-03-31', false], ['Notice date', '2027-01-30', false]]);
  // Taking off a confirmed one takes its detail off too.
  assert.equal((await c.call('DELETE', `/envelopes/${id}/key-dates/${by('end').id}`)).status, 200);
  assert.deepEqual((await c.get(`/envelopes/${id}`)).data.envelope.custom_fields.map((f: any) => f.name), ['Notice date']);
  // The list filter by detail finds it too (customfields.ts).
  assert.equal((await c.get('/envelopes?field=Notice%20date&value=2027')).data.envelopes.length, 1);
});

test('a detail the sender already has under the same name is never written over', async () => {
  model();
  const { c } = await person();
  await switchOn(c);
  assert.equal((await c.post('/custom-fields', { name: 'End date' })).status, 200);
  const f = new FormData();
  f.append('file', new Blob([await leasePdf()], { type: 'application/pdf' }), 'Lease.pdf');
  const file = (await c.call('POST', '/files', f)).data;
  const signer = `own${n}@example.com`;
  const env = (await c.post('/envelopes', { subject: 'With own', send: true, custom_fields: [{ name: 'End date', value: 'their own words' }], documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'X', email: signer }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }] })).data.envelope;
  await signAll(env.id, signer);
  answer = GOOD;
  stub();
  const end = (await c.post(`/envelopes/${env.id}/key-dates/find`)).data.terms.find((x: any) => x.kind === 'end');
  await c.put(`/envelopes/${env.id}/key-dates/${end.id}`, {});
  const got = (await c.get(`/envelopes/${env.id}`)).data.envelope.custom_fields;
  assert.deepEqual(got.map((x: any) => [x.name, x.value]), [['End date', 'their own words'], ['End date 2', '2027-03-31']]);
});

test('a date added by hand is confirmed at once; a second end date is refused', async () => {
  model();
  const { c } = await person();
  await switchOn(c);
  const id = await completedLease(c);
  const r = await c.post(`/envelopes/${id}/key-dates`, { kind: 'renewal', value: '2027-04-01' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.term.status, r.data.term.found_by_ai, r.data.term.quote], ['confirmed', false, '']);
  assert.equal((await c.post(`/envelopes/${id}/key-dates`, { kind: 'renewal', value: '2027-05-01' })).status, 409);
  assert.equal((await c.post(`/envelopes/${id}/key-dates`, { kind: 'bonus', value: '1' })).status, 400);
});

// ---- 3. Reminders, only for confirmed values ------------------------------------------------------------------------
test('reminders: refused until a date is confirmed, sent once N days before, never for a proposal, stop when switched off', async () => {
  model();
  const { c, email } = await person();
  await switchOn(c);
  const id = await completedLease(c);
  answer = GOOD;
  stub();
  const t = (await c.post(`/envelopes/${id}/key-dates/find`)).data.terms;
  const no = await c.put(`/envelopes/${id}/key-dates-reminder`, { days: 30 });
  assert.equal(no.status, 409, 'nothing confirmed yet');
  assert.equal(no.data.code, 'nothing_confirmed');
  assert.equal((await c.put(`/envelopes/${id}/key-dates-reminder`, { days: 0.5 })).status, 400);
  await c.put(`/envelopes/${id}/key-dates/${t.find((x: any) => x.kind === 'end').id}`, {});
  assert.equal((await c.put(`/envelopes/${id}/key-dates-reminder`, { days: 30 })).data.reminder.days, 30);
  const mails = () => db.all("SELECT subject FROM emails WHERE to_email=? AND subject LIKE 'Elm Road lease%'", email).map((r: any) => r.subject);
  // Forty days before the end: nothing. The notice date (31 January) is a proposal: nothing, ever.
  assert.equal(await repo.keyReminders(new Date('2027-01-20T12:00:00Z')), 0);
  assert.equal(await repo.keyReminders(new Date('2027-02-19T12:00:00Z')), 0);
  // Twenty-nine days before: one email, and only one.
  assert.equal(await repo.keyReminders(new Date('2027-03-02T12:00:00Z')), 1);
  assert.equal(await repo.keyReminders(new Date('2027-03-03T12:00:00Z')), 0);
  assert.deepEqual(mails(), ['Elm Road lease ends on 31 March 2027']);
  const html = db.get("SELECT html FROM emails WHERE to_email=? AND subject LIKE 'Elm Road lease%'", email).html;
  assert.match(html, /in 29 days, on 31 March 2027/);
  assert.match(html, /You checked this date after the AI found it/);
  // A corrected date is a new date: one more email for it, when it is close.
  const end = (await c.get(`/envelopes/${id}/key-dates`)).data.terms.find((x: any) => x.kind === 'end');
  await c.put(`/envelopes/${id}/key-dates/${end.id}`, { value: '2027-03-10' });
  assert.equal(await repo.keyReminders(new Date('2027-03-03T12:00:00Z')), 1);
  // Key dates switched off: no more emails, even for a confirmed date.
  await c.post(`/envelopes/${id}/key-dates`, { kind: 'renewal', value: '2027-03-20' });
  assert.equal((await c.put('/account/key-dates', { on: false })).status, 200);
  assert.equal(await repo.keyReminders(new Date('2027-03-04T12:00:00Z')), 0);
  // Stop reminders.
  await c.put('/account/key-dates', { on: true });
  assert.equal((await c.put(`/envelopes/${id}/key-dates-reminder`, { days: null })).data.reminder, null);
  assert.equal(await repo.keyReminders(new Date('2027-03-04T12:00:00Z')), 0);
});

test('a reminder for someone who can no longer open the document is not sent', async () => {
  model();
  const { c } = await person();
  await switchOn(c);
  const id = await completedLease(c);
  await c.post(`/envelopes/${id}/key-dates`, { kind: 'end', value: '2027-03-31' });
  await c.put(`/envelopes/${id}/key-dates-reminder`, { days: 30 });
  db.run('UPDATE envelopes SET hidden_at=? WHERE id=?', new Date().toISOString(), id);
  assert.equal(await repo.keyReminders(new Date('2027-03-20T12:00:00Z')), 0);
});

// ---- 4. The list, the filter and the calendar -----------------------------------------------------------------------
test('filter by ending in the next N days and a calendar file with only confirmed dates', async () => {
  model();
  const { c } = await person();
  await switchOn(c);
  const soon = await completedLease(c);
  const later = await completedLease(c);
  const day = (k: number) => new Date(Date.now() + k * 86_400_000).toISOString().slice(0, 10);
  await c.post(`/envelopes/${soon}/key-dates`, { kind: 'end', value: day(20) });
  await c.post(`/envelopes/${later}/key-dates`, { kind: 'end', value: day(200) });
  await c.post(`/envelopes/${later}/key-dates`, { kind: 'notice', value: day(100) });
  const in90 = (await c.get('/envelopes?ends_within=90')).data.envelopes.map((e: any) => e.id);
  assert.deepEqual(in90, [soon]);
  assert.equal((await c.get('/envelopes?ends_within=abc')).status, 400);
  const list = (await c.get('/key-dates?within=90')).data.documents;
  assert.deepEqual(list.map((d: any) => d.id), [soon]);
  const all = (await c.get('/key-dates')).data.documents;
  assert.deepEqual(all.map((d: any) => d.id), [soon, later], 'the nearest date first');
  assert.equal(all[1].next.kind, 'notice');
  const ics = await c.get('/key-dates/calendar.ics');
  assert.equal(ics.status, 200);
  const text = new TextDecoder().decode(ics.data);
  assert.match(text, /^BEGIN:VCALENDAR\r\n/);
  assert.equal(text.match(/BEGIN:VEVENT/g)!.length, 3);
  assert.match(text, new RegExp(`DTSTART;VALUE=DATE:${day(20).replace(/-/g, '')}`));
  assert.match(text, /SUMMARY:Elm Road lease: ends/);
  assert.ok(text.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75), 'lines folded');
  // A member sees only their own documents in the list and on the calendar.
  assert.ok(!text.includes('\u2014'));
});

test('calendar text is escaped, and a subject cannot add lines of its own', () => {
  const f = lib.calendarFile([{ uid: 'a@x', day: '2027-03-31', title: 'Lease; with, commas\nBEGIN:VEVENT', note: 'n', url: 'https://x' }], '2026-11-21T10:00:00.000Z');
  assert.match(f, /SUMMARY:Lease\\; with\\, commas\\nBEGIN:VEVENT/);
  assert.equal(f.match(/^BEGIN:VEVENT/gm)!.length, 1);
  assert.match(f, /DTEND;VALUE=DATE:20270401/);
});

// ---- The timer reads new completed documents ------------------------------------------------------------------------
test('the timer reads documents completed after the switch, older ones only after Look through older documents', async () => {
  model();
  const { c } = await person();
  assert.equal((await c.put('/account/ai-read', { read: 'on' })).status, 200);
  const before = await completedLease(c);
  db.run('UPDATE envelopes SET completed_at=? WHERE id=?', '2020-01-01T00:00:00.000Z', before);
  await switchOn(c);
  const after = await completedLease(c);
  answer = GOOD;
  stub();
  process.env.KEY_DATES_PER_TICK = '10';
  await repo.keyDatesTick();
  assert.equal(db.get('SELECT state FROM key_scans WHERE envelope_id=?', after)?.state, 'found');
  assert.ok(!db.get('SELECT state FROM key_scans WHERE envelope_id=?', before), 'older one left alone');
  const older = await c.post('/account/key-dates/older');
  assert.equal(older.status, 200);
  assert.equal(older.data.waiting, 1);
  await repo.keyDatesTick();
  assert.equal(db.get('SELECT state FROM key_scans WHERE envelope_id=?', before)?.state, 'found');
  // Read once: the next run reads nothing.
  const asked = calls.length;
  await repo.keyDatesTick();
  assert.equal(calls.length, asked);
  // KEY_DATES_PER_TICK=0 stops it reading by itself.
  process.env.KEY_DATES_PER_TICK = '0';
  assert.equal(await repo.keyDatesTick(), 0);
  assert.ok(cron);
});

test('a purge that removes personal details takes the key dates with it', async () => {
  model();
  const { c } = await person();
  await switchOn(c);
  const id = await completedLease(c);
  await c.post(`/envelopes/${id}/key-dates`, { kind: 'end', value: '2027-03-31' });
  repo.purgeKeyTerms(id);
  assert.equal(db.get('SELECT COUNT(*) n FROM key_terms WHERE envelope_id=?', id).n, 0);
});

test('refusals say what happened and what to do', async () => {
  for (const s of [lib.KEY_OFF, lib.NOT_COMPLETED, lib.NOTHING_FOUND]) {
    const parts = s.split(/(?<=\.)\s+/);
    assert.equal(parts.length, 2, s);
    assert.ok(!s.includes('\u2014'));
  }
  assert.equal(lib.readDay('2027-02-29'), null);
  assert.equal(lib.readDay('2028-02-29'), '2028-02-29');
  assert.equal(lib.termSentence('end', '2027-03-03'), 'Ends on 3 March 2027');
});

test('every Key dates route is in the API description, and nothing documented is missing', async () => {
  const { listRoutes } = await import('../src/server/router.ts');
  const { openapi } = await import('../src/server/openapi.ts');
  const spec: any = openapi();
  const mine = listRoutes().filter((r) => /key-dates/.test(r.path)).map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}')}`);
  assert.equal(mine.length, 11);
  for (const m of mine) {
    const [method, path] = m.split(' ');
    assert.ok(spec.paths[path]?.[method], `not documented: ${m}`);
  }
  assert.ok(spec.paths['/envelopes'].get.parameters.some((p: any) => p.name === 'ends_within'));
});

test('a member sees only their own documents in Key dates; the sidebar entry follows the switch', async () => {
  model();
  const nav = await import('../src/lib/nav.ts');
  assert.deepEqual(nav.moreFor('member').map((x) => x.label), ['Send to many', 'Forms', 'Reports', 'Trees planted']);
  assert.deepEqual(nav.moreFor('member', { keyDates: true }).map((x) => x.label), ['Send to many', 'Forms', 'Reports', 'Key dates', 'Trees planted']);
  assert.equal(nav.pageTitle('/app/key-dates'), 'Key dates · GrowSigning');
  const { c, acct } = await person();
  await switchOn(c);
  const own = await completedLease(c);
  await c.post(`/envelopes/${own}/key-dates`, { kind: 'end', value: '2030-01-01' });
  // A member of the same account, with a document of their own.
  const m = await signUp('Member', `member${n}@example.com`, `198.51.100.${n + 150}`);
  const mid = db.get('SELECT id FROM users WHERE email=?', `member${n}@example.com`).id;
  const theirAcct = db.get('SELECT account_id FROM memberships WHERE user_id=?', mid).account_id;
  db.run('DELETE FROM memberships WHERE user_id=?', mid);
  db.run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,'member',?)", acct, mid, new Date().toISOString());
  db.run('UPDATE sessions SET account_id=? WHERE user_id=?', acct, mid);
  assert.ok(theirAcct);
  const seen = await m.get('/key-dates');
  assert.equal(seen.status, 200, JSON.stringify(seen.data));
  assert.equal(seen.data.documents.length, 0, 'the admin\'s document is not the member\'s');
  assert.equal((await m.get(`/envelopes/${own}/key-dates`)).status, 404);
  assert.doesNotMatch(new TextDecoder().decode((await m.get('/key-dates/calendar.ics')).data), /VEVENT/);
  assert.equal((await m.put('/account/key-dates', { on: false })).status, 403, 'members cannot switch it');
});

// ---- Repairs after the skeptic and the simplicity review ---------------------------------------------------------
test('the words shown under a value have to hold the value: an invented date or amount with unrelated words is dropped', async () => {
  model();
  const { c } = await person();
  await switchOn(c);
  const id = await completedLease(c);
  answer = JSON.stringify({ terms: [
    { kind: 'end', value: '2099-12-31', page: 1, quote: 'and' }, // too short, and not this date
    { kind: 'renewal', value: '2099-12-31', page: 1, quote: 'for the flat at 4 Elm Road' }, // real words, no date
    { kind: 'notice', value: '2027-02-28', page: 2, quote: 'notice is due by 31 January 2027' }, // real words, another date
    { kind: 'amount', value: '50000 dollars penalty', page: 1, quote: 'the flat at 4 Elm Road' }, // real words, no amount
    { kind: 'parties', value: 'Acme Holdings and Sam Lee', page: 1, quote: 'between Rosa Diaz and Sam Lee' }, // a made-up party
    { kind: 'start', value: '2026-04-01', page: 1, quote: 'starts on 1 April 2026' }, // the one that holds
  ] });
  stub();
  const r = await c.post(`/envelopes/${id}/key-dates/find`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.terms.map((x: any) => [x.kind, x.value]), [['start', '2026-04-01']]);
  // The forms a date is written in, and amounts by their numbers.
  for (const q of ['ends on 31 March 2027', 'ends 2027-03-31', 'ends on 31/03/2027', 'ends on 03/31/2027', 'March 31st, 2027', 'le 31 mars 2027', 'am 31. März 2027', 'el 31 de marzo de 2027', 'Mar 31 2027'])
    assert.ok(lib.dateInWords('2027-03-31', q), q);
  for (const q of ['ends on 30 March 2027', 'ends on 31 March 2028', 'in 2027, 31 days after March', 'ends on 31 May 2027'])
    assert.ok(!lib.dateInWords('2027-03-31', q), q);
  assert.ok(lib.amountInWords('1,500.00 euros', 'a deposit of 1.500 EUR'));
  assert.ok(lib.amountInWords('900 dollars a month', 'The rent is 900 dollars a month'));
  assert.ok(!lib.amountInWords('9000 dollars', 'The rent is 900 dollars a month'));
  assert.ok(!lib.amountInWords('a lot of money', 'The rent is 900 dollars a month'));
});

test('turning the read switch off turns Key dates off for good: turning read on again does not bring it back', async () => {
  model();
  stub();
  const { c, acct } = await person();
  await switchOn(c);
  const off = await c.put('/account/ai-read', { read: 'off' });
  assert.equal(off.status, 200);
  assert.equal(off.data.key_dates_stopped, true, 'the answer says Key dates went off too');
  assert.equal((await c.put('/account/ai-read', { read: 'on' })).data.key_dates_stopped, undefined);
  const s = (await c.get('/account/key-dates')).data;
  assert.deepEqual([s.possible, s.on, s.since], [true, false, null]);
  assert.equal((await c.get('/me')).data.key_dates, undefined);
  assert.equal(db.get('SELECT ai_key_dates v FROM accounts WHERE id=?', acct).v, null);
  // The security record says Key dates went off with it.
  const lines = db.all("SELECT details FROM security_events WHERE kind='settings.changed' AND account_id=?", acct).map((r: any) => r.details);
  assert.ok(lines.some((l: string) => /ai_reads_document_text/.test(l) && /ai_key_dates/.test(l)), lines.join('\n'));
  // Turning read off again while Key dates is already off says nothing about Key dates.
  assert.equal((await c.put('/account/ai-read', { read: 'off' })).data.key_dates_stopped, undefined);
  assert.equal(calls.length, 0);
});

test('Look through older documents is refused to an API key, like the switch', async () => {
  model();
  stub();
  const { c } = await person();
  await switchOn(c);
  const key = (await c.post('/api-keys', { name: 'k', scope: 'admin' })).data.key;
  const r = await new Client().call('POST', '/account/key-dates/older', undefined, { authorization: `Bearer ${key}` });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /API key cannot do this.*Nothing was changed\.$/);
  assert.equal((await c.get('/account/key-dates')).data.older, false);
});

test('the timer uses at most half of the day\'s AI requests, so the person can still ask; with no share it reads nothing', async () => {
  model();
  // First the documents other tests left waiting are read, so only this account's are left.
  answer = GOOD;
  stub();
  process.env.AI_ASSIST_DAILY_LIMIT = '1000';
  process.env.KEY_DATES_PER_TICK = '50';
  while (await repo.keyDatesTick()) {}
  process.env.AI_ASSIST_DAILY_LIMIT = '2';
  process.env.KEY_DATES_PER_TICK = '10';
  const { c } = await person();
  await switchOn(c);
  await completedLease(c);
  await completedLease(c);
  const mine = await completedLease(c);
  answer = GOOD;
  stub();
  await repo.keyDatesTick();
  assert.equal(calls.length, 1, 'one of two requests for the timer');
  assert.equal((await c.get('/account/key-dates')).data.auto, true);
  const r = await c.post(`/envelopes/${mine}/key-dates/find`);
  assert.equal(r.status, 200, 'the person keeps the other one');
  // A limit of 1 leaves the timer nothing: it reads nothing, and the screens do not promise it.
  process.env.AI_ASSIST_DAILY_LIMIT = '1';
  const { c: c2 } = await person();
  await switchOn(c2);
  await completedLease(c2);
  calls = [];
  assert.equal(await repo.keyDatesTick(), 0);
  assert.equal(calls.length, 0);
  assert.equal((await c2.get('/account/key-dates')).data.auto, false);
  process.env.AI_ASSIST_DAILY_LIMIT = '20';
  process.env.KEY_DATES_PER_TICK = '0';
  assert.equal((await c2.get('/account/key-dates')).data.auto, false, 'KEY_DATES_PER_TICK=0: not read by itself');
  assert.match(lib.autoLine(false, false), /does not read documents by itself/);
  assert.match(lib.autoLine(true, false), /at most half/);
});

test('Remind me is refused when every checked date has passed, with a plain message', async () => {
  model();
  stub();
  const { c } = await person();
  await switchOn(c);
  const id = await completedLease(c);
  await c.post(`/envelopes/${id}/key-dates`, { kind: 'end', value: '2020-01-01' });
  const r = await c.put(`/envelopes/${id}/key-dates-reminder`, { days: 30 });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'all_passed');
  assert.match(r.data.error, /has passed.*Nothing was saved\.$/);
  assert.equal(db.get('SELECT COUNT(*) n FROM key_reminders WHERE envelope_id=?', id).n, 0);
  // A date still to come makes it possible.
  const day = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  await c.post(`/envelopes/${id}/key-dates`, { kind: 'notice', value: day });
  assert.equal((await c.put(`/envelopes/${id}/key-dates-reminder`, { days: 30 })).status, 200);
});

test('the list: the filter counts notice and renewal dates, each row lists its coming dates, the calendar only when it has one', async () => {
  model();
  stub();
  const { c } = await person();
  await switchOn(c);
  const id = await completedLease(c);
  const day = (k: number) => new Date(Date.now() + k * 86_400_000).toISOString().slice(0, 10);
  answer = GOOD;
  await c.post(`/envelopes/${id}/key-dates/find`);
  const empty = (await c.get('/key-dates')).data;
  assert.equal(empty.calendar, false, 'nothing checked yet: no calendar button');
  await c.post(`/envelopes/${id}/key-dates`, { kind: 'renewal', value: day(20) });
  const t = (await c.post(`/envelopes/${id}/key-dates`, { kind: 'end', value: day(300) })).data.term;
  assert.equal(t.detail, 'End date', 'the detail it is on the envelope, so the page shows it once');
  const list = (await c.get('/key-dates?within=30')).data;
  assert.deepEqual(list.documents.map((d: any) => d.id), [id], 'a renewal in 20 days counts');
  assert.equal(list.calendar, true);
  assert.deepEqual(list.documents[0].coming.map((x: any) => x.kind), ['renewal', 'end']);
  // The API filter on /envelopes is about end dates, as its name says.
  assert.equal((await c.get('/envelopes?ends_within=30')).data.envelopes.length, 0);
});

test('words of the repaired screens: no "counts", no "Take off", what turning it off stops', async () => {
  const { readFileSync } = await import('node:fs');
  const src = ['src/components/sender/KeyDates.tsx', 'src/components/settings/KeyDatesSetting.tsx', 'src/app/app/key-dates/page.tsx', 'src/lib/keydates.ts'].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(src, /It now counts|before it counts|Take off|Taken off|Ending in the next/);
  assert.match(lib.KEY_OFF_WARNING, /stops Key dates and its reminders/);
  assert.equal(lib.usedLine('end', 'Confirmed'), 'Confirmed. It is now in the calendar file and can be used for reminders.');
  assert.equal(lib.usedLine('amount', 'Added'), 'Added. It is now kept with this document.');
  for (const f of ['src/components/sender/KeyDates.tsx', 'src/app/app/key-dates/page.tsx']) assert.match(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /data-feature="ds-ai-repo"/, f);
  const nav = await import('../src/lib/nav.ts');
  assert.equal(nav.NAV_KEY_DATES.feature, 'ds-ai-repo');
  assert.ok(!/—/.test(src));
});
