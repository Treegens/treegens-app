// Send later, pause and resume, and a wait before a person (src/server/timing.ts, src/server/waits.ts,
// src/lib/timing.ts, research/docusign-gaps.json batch "timing"). Time is moved by moving the stored moments back,
// the way a clock that ran on would see them. Nothing here reaches the network: fetch is stubbed to refuse.
//   1. Send later: sends on time through every check, an empty balance stops it and the sender is told why, change
//      and cancel, and the limits of the time.
//   2. Pause: every signing action is refused in the paused words, no reminder and no expiry while paused, the
//      deadline moves on by exactly the time paused, Resume emails whoever's turn it is.
//   3. A wait before a person starts on time, refuses waits that do not fit, and templates carry it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, upload, tokenFor, mailTo, signAll, PNG } from './helpers.ts';

const { db, cron } = await boot();
const { WEBHOOK_EVENTS } = await import('../src/server/webhooks.ts');
const L = await import('../src/lib/timing.ts');

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error('no network in tests');
}) as any;
after(() => {
  globalThis.fetch = realFetch;
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 3600_000;
const env = (id: string) => db.get('SELECT * FROM envelopes WHERE id=?', id);
const rcp = (id: string, email: string) => db.get('SELECT * FROM recipients WHERE envelope_id=? AND email=?', id, email);
const actions = (id: string) => db.all('SELECT action, detail FROM audit WHERE envelope_id=? ORDER BY seq', id).map((a: any) => a.action);
const said: string[] = [];
const refusal = (r: any) => (said.push(r.data.error), r.data.error as string);

const owner = await signUp('Rosa Gardener', 'rosa@example.com', '198.51.100.31');

async function make(c: Client, people: { name: string; email: string; order?: number; wait_hours?: any }[], over: any = {}) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    subject: over.subject || 'Planting agreement', ordered: true,
    documents: [{ id: 'd', file_id: file.id }],
    recipients: people.map((p, i) => ({ id: `r${i}`, role: 'signer', name: p.name, email: p.email, routing_order: p.order ?? i + 1, ...(p.wait_hours !== undefined ? { wait_hours: p.wait_hours } : {}) })),
    fields: people.map((_, i) => ({ id: `f${i}`, document_id: 'd', recipient_id: `r${i}`, type: 'signature', page: 0, x: 0.1, y: 0.1 + i * 0.1, w: 0.3, h: 0.06 })),
    ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}

// ---- 1. Send later ---------------------------------------------------------------------------------------------

test('send later: it waits as a draft, holds nothing, and the timer sends it at its time with every check', async () => {
  const e = await make(owner, [{ name: 'Ana Silva', email: 'ana@example.com' }]);
  const at = ahead(2 * HOUR);
  const r = await owner.post(`/envelopes/${e.id}/send`, { send_at: at });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.envelope.status, 'draft');
  assert.equal(r.data.envelope.send_at, at);
  assert.equal(mailTo('ana@example.com').length, 0, 'nobody is emailed before the time');
  assert.ok(actions(e.id).includes('Send later set'));
  // Not due yet: the timer leaves it.
  await cron.tick();
  assert.equal(env(e.id).status, 'draft');
  // Its time comes.
  db.run('UPDATE envelopes SET send_at=? WHERE id=?', ago(60_000), e.id);
  await cron.tick();
  const after_ = env(e.id);
  assert.equal(after_.status, 'sent');
  assert.equal(after_.send_at, null);
  assert.equal(mailTo('ana@example.com').length, 1);
  assert.ok(actions(e.id).includes('Sent at the time chosen'));
  // A second tick sends nothing twice.
  await cron.tick();
  assert.equal(mailTo('ana@example.com').length, 1);
});

test('send later: change the time, cancel it, and Send now on a draft with a time', async () => {
  const e = await make(owner, [{ name: 'Ben Okafor', email: 'ben@example.com' }]);
  assert.equal((await owner.post(`/envelopes/${e.id}/send-later`, { send_at: ahead(3 * HOUR) })).status, 200);
  const later = ahead(5 * HOUR);
  const changed = await owner.post(`/envelopes/${e.id}/send-later`, { send_at: later });
  assert.equal(changed.data.send_at, later);
  const off = await owner.call('DELETE', `/envelopes/${e.id}/send-later`);
  assert.equal(off.status, 200);
  assert.equal(env(e.id).send_at, null);
  assert.ok(actions(e.id).includes('Send later cancelled'));
  // Cancelled: its old time passing sends nothing.
  await cron.tick();
  assert.equal(env(e.id).status, 'draft');
  // Set again, then sent by hand before the time: the time is over and it goes out once.
  await owner.post(`/envelopes/${e.id}/send-later`, { send_at: ahead(HOUR) });
  assert.equal((await owner.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal(env(e.id).status, 'sent');
  assert.equal(env(e.id).send_at, null);
  assert.equal(mailTo('ben@example.com').length, 1);
  // Not a draft any more: no time can be set or taken off.
  assert.equal((await owner.post(`/envelopes/${e.id}/send-later`, { send_at: ahead(HOUR) })).status, 409);
});

test('send later: a time in the past, too soon, too far or unreadable is refused in words', async () => {
  const e = await make(owner, [{ name: 'Cleo Park', email: 'cleo@example.com' }]);
  for (const v of [ago(HOUR), ahead(60_000), ahead(31 * 864e5), 'next tuesday', 12]) {
    const r = await owner.post(`/envelopes/${e.id}/send`, { send_at: v });
    assert.equal(r.status, 400, String(v));
    refusal(r);
  }
  assert.equal(env(e.id).send_at, null);
  // Nobody on it yet: said now, not at the time.
  const file = await upload(owner, 1);
  const empty = (await owner.post('/envelopes', { subject: 'Empty', documents: [{ id: 'd', file_id: file.id }], recipients: [], fields: [] })).data.envelope;
  const r = await owner.post(`/envelopes/${empty.id}/send-later`, { send_at: ahead(HOUR) });
  assert.equal(r.status, 400);
  // Someone else's envelope cannot be scheduled.
  const other = await signUp('Mallory Other', 'mallory@example.com', '198.51.100.32');
  assert.equal((await other.post(`/envelopes/${e.id}/send-later`, { send_at: ahead(HOUR) })).status, 404);
  assert.equal((await other.post(`/envelopes/${e.id}/pause`)).status, 404);
});

test('send later: an empty balance stops it at its time, nothing goes out, and the sender is told why', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_timing';
  try {
    // A new account has 3 signatures to try; this needs 4.
    const people = ['dan', 'eve', 'fay', 'gus'].map((n) => ({ name: `${n[0].toUpperCase()}${n.slice(1)} Person`, email: `${n}@example.com`, order: 1 }));
    const e = await make(owner, people, { subject: 'Four signers' });
    // Nothing is held while it waits.
    assert.equal((await owner.post(`/envelopes/${e.id}/send`, { send_at: ahead(HOUR) })).status, 200);
    db.run('UPDATE envelopes SET send_at=? WHERE id=?', ago(1000), e.id);
    const before = mailTo('rosa@example.com').length;
    await cron.tick();
    const now_ = env(e.id);
    assert.equal(now_.status, 'draft');
    assert.match(now_.send_error, /signatures/);
    assert.equal(mailTo('dan@example.com').length, 0);
    const told = mailTo('rosa@example.com').slice(before);
    assert.ok(told.some((m: any) => m.subject === 'Not sent: Four signers'), JSON.stringify(told.map((m: any) => m.subject)));
    assert.ok(actions(e.id).includes('Not sent at the time chosen'));
    // It is not tried again by itself, and the page has the reason.
    await cron.tick();
    assert.equal(mailTo('rosa@example.com').filter((m: any) => m.subject === 'Not sent: Four signers').length, 1);
    const page = (await owner.get(`/envelopes/${e.id}`)).data.envelope;
    assert.match(page.send_error, /signatures/);
    // A new time clears the reason.
    await owner.post(`/envelopes/${e.id}/send-later`, { send_at: ahead(HOUR) });
    assert.equal(env(e.id).send_error, null);
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});

// ---- 2. Pause and resume ---------------------------------------------------------------------------------------

test('pause: every signing action is refused in the paused words, comments stay readable, no reminder by hand', async () => {
  const e = await make(owner, [{ name: 'Hana Ito', email: 'hana@example.com' }]);
  await owner.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'hana@example.com');
  const s = new Client();
  s.ip = '198.51.100.40';
  assert.equal((await s.post(`/sign/${tok}/consent`)).status, 200);
  const p = await owner.post(`/envelopes/${e.id}/pause`);
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.ok(p.data.envelope.paused_at);
  assert.equal((await owner.post(`/envelopes/${e.id}/pause`)).status, 409, 'paused once');
  const page = (await s.get(`/sign/${tok}`)).data;
  assert.match(page.envelope.paused.text, /^Paused by Rosa Gardener on \d+ \w+\. You will get an email when it can be signed again\.$/);
  assert.doesNotMatch(page.envelope.paused.text, /expire/i);
  for (const [path, body] of [['consent', {}], ['save', { values: {} }], ['complete', { values: { f0: '1' }, signature_png: PNG }], ['decline', { reason: 'no' }], ['reassign', { name: 'X', email: 'x@example.com' }], ['name', { name: 'Hana I.' }]] as const) {
    const r = await s.post(`/sign/${tok}/${path}`, body);
    assert.equal(r.status, 409, `${path}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, 'paused');
  }
  assert.equal(rcp(e.id, 'hana@example.com').status, 'viewed');
  assert.equal((await s.get(`/sign/${tok}/comments`)).status, 200);
  const remind = await owner.post(`/envelopes/${e.id}/remind`);
  assert.equal(remind.status, 409);
  refusal(remind);
});

test('pause: the timer sends no reminder and lets nothing expire; resume moves the deadline on by exactly the pause and emails', async () => {
  const e = await make(owner, [{ name: 'Ivo Brandt', email: 'ivo@example.com' }], { reminder_days: 1 });
  await owner.post(`/envelopes/${e.id}/send`);
  await owner.post(`/envelopes/${e.id}/pause`);
  // A reminder would be due and the deadline has passed: while paused, neither happens.
  const deadline = ago(60_000);
  db.run('UPDATE envelopes SET last_reminder_at=?, sent_at=?, expires_at=? WHERE id=?', ago(3 * 864e5), ago(3 * 864e5), deadline, e.id);
  await cron.tick();
  assert.equal(env(e.id).status, 'sent');
  assert.equal(mailTo('ivo@example.com').length, 1, 'only the first request');
  // Paused for 26 hours by the stored clock, with a deadline 5 days out (so no "expires soon" email either).
  const pausedAt = ago(26 * HOUR);
  const due = ahead(5 * 864e5);
  db.run('UPDATE envelopes SET paused_at=?, expires_at=? WHERE id=?', pausedAt, due, e.id);
  const t0 = Date.now();
  const r = await owner.post(`/envelopes/${e.id}/resume`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const moved = Date.parse(env(e.id).expires_at) - Date.parse(due);
  // Exactly the time paused, measured between pausedAt and the moment of resuming.
  assert.ok(Math.abs(moved - (t0 - Date.parse(pausedAt))) < 5000, `moved ${moved}`);
  assert.equal(env(e.id).paused_at, null);
  assert.ok(env(e.id).paused_ms >= 26 * HOUR - 5000);
  const mails = mailTo('ivo@example.com');
  assert.equal(mails.length, 2);
  assert.equal(mails[1].subject, 'Ready to sign again: Planting agreement');
  assert.match(mails[1].html, /paused this document for a while and has now resumed it/);
  assert.ok(actions(e.id).includes('Resumed'));
  // Resume restarted the reminder clock: no second email at once from the timer.
  await cron.tick();
  assert.equal(mailTo('ivo@example.com').length, 2);
  assert.equal((await owner.post(`/envelopes/${e.id}/resume`)).status, 409, 'not paused');
  // And now it signs.
  assert.equal((await signAll(e.id, 'ivo@example.com')).status, 200);
  assert.equal(env(e.id).status, 'completed');
});

test('pause: nobody further down the order is asked while paused; resume asks them', async () => {
  const e = await make(owner, [{ name: 'Jo Lee', email: 'jo@example.com' }, { name: 'Kai Moss', email: 'kai@example.com' }]);
  await owner.post(`/envelopes/${e.id}/send`);
  assert.equal((await signAll(e.id, 'jo@example.com')).status, 200);
  assert.equal(rcp(e.id, 'kai@example.com').status, 'sent');
  // Paused with Kai's turn on: Kai is not emailed again until resumed, and a draft or a closed one cannot be paused.
  await owner.post(`/envelopes/${e.id}/pause`);
  await cron.tick();
  assert.equal(mailTo('kai@example.com').length, 1);
  await owner.post(`/envelopes/${e.id}/resume`);
  assert.equal(mailTo('kai@example.com').length, 2);
  const d = await make(owner, [{ name: 'Lu Chen', email: 'lu@example.com' }]);
  const r = await owner.post(`/envelopes/${d.id}/pause`);
  assert.equal(r.status, 409);
  refusal(r);
  assert.ok(WEBHOOK_EVENTS.includes('envelope.paused') && WEBHOOK_EVENTS.includes('envelope.resumed'));
});

// ---- 3. Wait before a person -----------------------------------------------------------------------------------

test('a wait before a person starts on time after the step before finishes', async () => {
  const e = await make(owner, [{ name: 'Mo Diaz', email: 'mo@example.com' }, { name: 'Nia Roy', email: 'nia@example.com', wait_hours: 48 }]);
  assert.equal(e.recipients.find((r: any) => r.email === 'nia@example.com').wait_hours, 48);
  await owner.post(`/envelopes/${e.id}/send`);
  assert.equal((await signAll(e.id, 'mo@example.com')).status, 200);
  assert.equal(rcp(e.id, 'nia@example.com').status, 'pending');
  assert.equal(mailTo('nia@example.com').length, 0);
  assert.ok(actions(e.id).includes('Waits before the next person'));
  // 47 hours on: still waiting.
  db.run('UPDATE recipients SET completed_at=? WHERE envelope_id=? AND email=?', ago(47 * HOUR), e.id, 'mo@example.com');
  await cron.tick();
  assert.equal(rcp(e.id, 'nia@example.com').status, 'pending');
  // 48 hours on: asked.
  db.run('UPDATE recipients SET completed_at=? WHERE envelope_id=? AND email=?', ago(48 * HOUR + 60_000), e.id, 'mo@example.com');
  await cron.tick();
  assert.equal(rcp(e.id, 'nia@example.com').status, 'sent');
  assert.equal(mailTo('nia@example.com').length, 1);
  assert.equal(actions(e.id).filter((a: string) => a === 'Waits before the next person').length, 1, 'said once');
});

test('waits: out of range is refused, waits longer than the deadline are refused at send, the first step has none', async () => {
  const file = await upload(owner, 1);
  for (const w of [900, -1, 1.5, 'two days']) {
    const r = await owner.post('/envelopes', { subject: 'W', ordered: true, documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'a', name: 'A', email: 'a@example.com', wait_hours: w }], fields: [] });
    assert.equal(r.status, 400, String(w));
    refusal(r);
  }
  const e = await make(owner, [{ name: 'Oli Fox', email: 'oli@example.com' }, { name: 'Pat Gray', email: 'pat@example.com', wait_hours: 72 }], { expire_days: 2 });
  const r = await owner.post(`/envelopes/${e.id}/send`);
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'waits_too_long');
  refusal(r);
  // A wait on the first person changes nothing: they are asked when it is sent.
  const first = await make(owner, [{ name: 'Quin Hale', email: 'quin@example.com', wait_hours: 24 }]);
  await owner.post(`/envelopes/${first.id}/send`);
  assert.equal(rcp(first.id, 'quin@example.com').status, 'sent');
});

test('templates carry waits into what is made from them', async () => {
  const file = await upload(owner, 1);
  const t = await owner.post('/envelopes', { kind: 'template', subject: 'Lease with a wait', ordered: true, documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'a', role: 'signer', role_name: 'Tenant', name: '', email: '', routing_order: 1 }, { id: 'b', role: 'signer', role_name: 'Landlord', name: '', email: '', routing_order: 2, wait_hours: 24 }], fields: [] });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const tpl = t.data.envelope || t.data.template;
  const made = await owner.post(`/envelopes/${tpl.id}/clone`, { kind: 'envelope' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const rows = db.all('SELECT role_name, wait_hours FROM recipients WHERE envelope_id=? ORDER BY routing_order', made.data.id);
  assert.deepEqual(rows.map((r: any) => r.wait_hours), [0, 24]);
});

test('the shared words: plain, no em dashes, refusals say what to do', () => {
  assert.equal(L.waitLine(48), 'Wait 2 days before this person');
  assert.equal(L.waitWords(28), '1 day and 4 hours');
  assert.equal(L.atWords('2026-12-03T09:00:00Z', 'UTC').replace(/ 2026$/, ''), '9:00 on 3 December');
  assert.equal(L.spanWords(26 * HOUR), '1 day and 2 hours');
  for (const m of [...said, L.PAUSED_NO_REMINDER, L.pausedLinkText('Rosa', '3 December')]) {
    assert.doesNotMatch(m, /\u2014/, m);
    assert.doesNotMatch(m, /cooling-off|scheduled|delayed routing/i, m);
    // Two sentences or more: what happened, then what to do.
    assert.ok(m.split(/(?<=\.)\s+/).length >= 2, m);
  }
});

// ---- 4. Repairs after review (tests/out/verify-ds-timing, tests/out/ux-ds-timing) ------------------------------

test('send later: a day alone or a time with no zone is refused, a zone or offset is taken', async () => {
  const e = await make(owner, [{ name: 'Rae Moon', email: 'rae@example.com' }]);
  const d = new Date(Date.now() + 3 * 864e5);
  const day = d.toISOString().slice(0, 10);
  for (const v of [day, `${day}T10:15`, `${day}T10:15:00`]) {
    const r = await owner.post(`/envelopes/${e.id}/send-later`, { send_at: v });
    assert.equal(r.status, 400, v);
    assert.match(refusal(r), /with its zone/);
  }
  assert.equal(env(e.id).send_at, null);
  assert.equal(L.sendAtProblem(`${day}T10:15:00+02:00`), null);
  assert.equal(L.sendAtProblem(`${day}T10:15Z`), null);
  const r = await owner.post(`/envelopes/${e.id}/send-later`, { send_at: `${day}T10:15:00+02:00` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.send_at, new Date(`${day}T08:15:00Z`).toISOString());
});

test('pause: a trailing slash and removing a stamp are refused like the plain actions', async () => {
  const e = await make(owner, [{ name: 'Sol Rey', email: 'sol@example.com' }]);
  await owner.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'sol@example.com');
  const s = new Client();
  s.ip = '198.51.100.41';
  await s.post(`/sign/${tok}/consent`);
  await owner.post(`/envelopes/${e.id}/pause`);
  for (const [m, path, body] of [['POST', 'decline/', { reason: 'x' }], ['POST', 'complete/', {}], ['DELETE', 'stamp/f0', undefined], ['POST', 'decline/paper/', {}]] as const) {
    const r = await s.call(m, `/sign/${tok}/${path}`, body as any);
    assert.equal(r.status, 409, `${m} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, 'paused');
  }
  assert.ok(['sent', 'viewed'].includes(rcp(e.id, 'sol@example.com').status));
  assert.equal(env(e.id).status, 'sent');
  // Turning our emails back on is still allowed while paused: that is how the resume email can reach them.
  assert.notEqual((await s.post(`/sign/${tok}/mail-again`, {})).data.code, 'paused');
});

test('waits: a correction that adds a wait past the deadline is refused; one that fits, or changes no wait, is not', async () => {
  const e = await make(owner, [{ name: 'Tom Ash', email: 'tom@example.com' }, { name: 'Ula Bay', email: 'ula@example.com' }], { expire_days: 3 });
  await owner.post(`/envelopes/${e.id}/send`);
  const full = (await owner.get(`/envelopes/${e.id}`)).data.envelope;
  const withWait = (h: number) => full.recipients.map((r: any) => (r.email === 'ula@example.com' ? { ...r, wait_hours: h } : r));
  const put = await owner.put(`/envelopes/${e.id}`, { recipients: withWait(720) });
  assert.equal(put.status, 400, JSON.stringify(put.data));
  assert.equal(put.data.code, 'waits_too_long');
  assert.match(refusal(put), /Nothing was changed/);
  assert.equal(rcp(e.id, 'ula@example.com').wait_hours, 0);
  const ok = await owner.put(`/envelopes/${e.id}`, { recipients: withWait(24) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(rcp(e.id, 'ula@example.com').wait_hours, 24);
  // A running wait counts only what is left of it: Tom signs, and a later correction that keeps it is fine.
  assert.equal((await signAll(e.id, 'tom@example.com')).status, 200);
  const again = (await owner.get(`/envelopes/${e.id}`)).data.envelope;
  assert.equal((await owner.put(`/envelopes/${e.id}`, { recipients: again.recipients, message: 'Thanks' })).status, 200);
});

test('screens tell the truth during a wait, a pause and a scheduled send', async () => {
  const P = await import('../src/lib/envelopepage.ts');
  const e = await make(owner, [{ name: 'Ana Silva', email: 'ana2@example.com' }, { name: 'Ben Okafor', email: 'ben2@example.com', wait_hours: 48 }]);
  await owner.post(`/envelopes/${e.id}/send`);
  // Before Ana finishes: Ben's line says the wait comes after her.
  let page = (await owner.get(`/envelopes/${e.id}`)).data.envelope;
  const ben = () => page.recipients.find((r: any) => r.email === 'ben2@example.com');
  const ana = () => page.recipients.find((r: any) => r.email === 'ana2@example.com');
  assert.equal(L.pendingWhen(page, ben(), [ana()]), 'It goes out 2 days after Ana Silva has finished, as you chose.');
  assert.equal(await signAll(e.id, 'ana2@example.com').then((r: any) => r.status), 200);
  page = (await owner.get(`/envelopes/${e.id}`)).data.envelope;
  const at = Date.parse(ana().completed_at) + 48 * HOUR;
  assert.equal(L.pendingWhen(page, ben(), []), `It goes out soon after ${L.atWords(new Date(at).toISOString())}, after the wait of 2 days you chose.`);
  // The status sentence names the wait, not "nobody is holding it up".
  const w = L.waitRunning(page);
  assert.equal(w?.name, 'Ben Okafor');
  const said_ = P.waitingSentence([], { wait: { name: w!.name, when: L.goesOutWords(w!.at) } });
  assert.match(said_, /^Ben Okafor is asked soon after .*, after the wait you chose\.$/);
  // The Documents list row: never "It was cancelled".
  const row = (await owner.get('/envelopes')).data.envelopes.find((x: any) => x.id === e.id);
  assert.match(L.timingRow(row), /^Ben Okafor, asked soon after .* after the wait you chose$/);
  // Paused: the page leads with it, and the list says it.
  await owner.post(`/envelopes/${e.id}/pause`);
  assert.equal(P.waitingSentence([], { paused: true }), 'Paused. Nobody can sign it until you resume it.');
  const row2 = (await owner.get('/envelopes')).data.envelopes.find((x: any) => x.id === e.id);
  assert.match(L.timingRow(row2), /^Paused\./);
  // A scheduled draft: the list says when, Home counts it apart from forgotten drafts.
  const d = await make(owner, [{ name: 'Cal Dun', email: 'cal@example.com' }]);
  const when = ahead(6 * HOUR);
  await owner.post(`/envelopes/${d.id}/send-later`, { send_at: when });
  const row3 = (await owner.get('/envelopes')).data.envelopes.find((x: any) => x.id === d.id);
  assert.equal(L.timingRow(row3), `Sends at ${L.atWords(when)}`);
  const sum = (await owner.get('/reports/summary')).data;
  assert.ok(sum.scheduled.count >= 1);
  assert.ok(sum.byStatus.draft >= sum.scheduled.count);
  assert.match(L.scheduledHome(1, when), /^1 document goes out by itself, soon after /);
  // The page's More names what the line does.
  const more = P.pageMore({ status: 'draft', scheduled: true, mayChange: true });
  assert.ok(more.some((l: any) => l.label === 'Do not send at that time'));
  for (const m of [L.pendingWhen(page, ben(), []), L.timingRow(row3), L.scheduledHome(2, when), said_]) assert.doesNotMatch(m, /\u2014|signatures/, m);
});
