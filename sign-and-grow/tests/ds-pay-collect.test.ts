// Ask for a payment, taken while signing into the sender's own Stripe account (src/server/collect.ts,
// src/server/routes-collect.ts, src/lib/collect.ts). Stripe is a stand-in in this file: nothing reaches the network,
// and fetch is put back after every test.
import test, { before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.STRIPE_CONNECT_CLIENT_ID = 'ca_test';
process.env.STRIPE_CONNECT_SECRET_KEY = 'sk_test_connect';
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';

import { boot, signUp, upload, Client, PNG, tokenFor, mailTo, type Server } from './helpers.ts';

let s: Server;
before(async () => {
  s = await boot();
});

let n = 0;
const ip = () => `198.51.100.${++n}`;
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---- A stand-in for Stripe ------------------------------------------------------------------------------------------

let sessionNo = 0;
type Sess = { id: string; account: string; amount_total: number; currency: string; payment_status: string; status: string; url: string; metadata: any; payment_intent: string | null };
function fakeStripe(o: { acct?: string; name?: string } = {}) {
  const st = { sessions: {} as Record<string, Sess>, calls: [] as { url: string; account: string | null; params: URLSearchParams; key: string | null }[], deauthorized: [] as string[], n: 0, expired: [] as string[], gone: [] as string[] };
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const h = init.headers || {};
    const params = new URLSearchParams(init.body || (url.includes('?') ? url.split('?')[1] : ''));
    const account = h['stripe-account'] || null;
    st.calls.push({ url, account, params, key: h['idempotency-key'] || null });
    const json = (x: any, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
    if (!/^https:\/\/(api|connect)\.stripe\.com\//.test(url)) throw new Error(`no network in tests: ${url}`);
    assert.equal(h.authorization, 'Bearer sk_test_connect');
    if (url.startsWith('https://connect.stripe.com/oauth/token')) return params.get('code') === 'good' ? json({ stripe_user_id: o.acct || 'acct_green', livemode: false }) : json({ error: 'invalid_grant', error_description: 'bad code' }, 400);
    if (url.startsWith('https://connect.stripe.com/oauth/deauthorize')) return (st.deauthorized.push(params.get('stripe_user_id')!), json({ stripe_user_id: params.get('stripe_user_id') }));
    if (/\/v1\/accounts\//.test(url)) return json({ id: o.acct || 'acct_green', business_profile: { name: o.name || 'Green Trust' } });
    const m = url.match(/\/v1\/checkout\/sessions\/([^/?]+)(\/expire)?/);
    if (m) {
      const x = st.sessions[m[1]];
      if (!x || x.account !== account || st.gone.includes(account!)) return json({ error: { message: 'No such checkout.session' } }, 404);
      if (m[2]) {
        st.expired.push(x.id);
        if (x.status !== 'open') return json({ error: { message: 'Only Checkout Sessions with a status of open can be expired.' } }, 400);
        x.status = 'expired';
      }
      return json(x);
    }
    if (url.startsWith('https://api.stripe.com/v1/checkout/sessions') && init.method === 'POST') {
      const id = `cs_${++sessionNo}`;
      st.sessions[id] = { id, account: account!, amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), currency: params.get('line_items[0][price_data][currency]')!,
        payment_status: 'unpaid', status: 'open', url: `https://checkout.stripe.com/c/pay/${id}`, metadata: { growsigning_payment: params.get('metadata[growsigning_payment]') }, payment_intent: null };
      return json(st.sessions[id]);
    }
    return json({ error: { message: `not faked: ${url}` } }, 400);
  }) as any;
  return {
    ...st,
    pay(id: string) {
      Object.assign(st.sessions[id], { payment_status: 'paid', status: 'complete', payment_intent: `pi_${id}` });
      return st.sessions[id];
    },
  };
}

const sign = (raw: string, secret = 'whsec_connect', t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
let evn = 0;
async function hook(ev: any, header?: string) {
  const raw = JSON.stringify({ id: `evt_${++evn}`, ...ev });
  const c = new Client();
  return c.call('POST', '/collect/webhook', JSON.parse(raw), { 'stripe-signature': header ?? sign(raw) });
}
const paidEvent = (x: Sess) => ({ type: 'checkout.session.completed', account: x.account, data: { object: { id: x.id, payment_status: 'paid', amount_total: x.amount_total, currency: x.currency } } });

async function charity(name: string, email: string, o: { trusted?: boolean; connect?: boolean } = {}) {
  const c = await signUp(name, email, ip());
  const acc = s.db.get('SELECT m.account_id id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?', email).id;
  if (o.trusted !== false) s.db.run('UPDATE accounts SET trusted_at=? WHERE id=?', new Date().toISOString(), acc);
  if (o.connect !== false) {
    const r = await c.post('/collect/connect');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const state = new URL(r.data.url).searchParams.get('state');
    const back = await c.get(`/collect/callback?state=${state}&code=good`);
    assert.equal(back.status, 303);
  }
  return { c, acc };
}

async function doc(c: Client, email: string, over: any = {}, fields: any[] = []) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    subject: 'Hall booking', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', name: 'Pat Payer', email }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, ...fields], ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
// What a signer fills in: every field, the way signAll in helpers.ts does, with `extra` on top.
async function valuesFor(p: Client, tok: string, extra: any = {}) {
  const v = (await p.get(`/sign/${tok}`)).data;
  const values: Record<string, string> = { ...extra };
  for (const f of v.fields || []) if (!(f.id in values)) values[f.id] = f.type === 'number' ? '' : '1';
  return values;
}
const finish = async (tok: string, extra: any = {}) => {
  const p = new Client();
  await p.post(`/sign/${tok}/consent`);
  return { p, r: await p.post(`/sign/${tok}/complete`, { values: await valuesFor(p, tok, extra), signature_png: PNG }) };
};

// ---- 1. Connecting the account's own Stripe account -------------------------------------------------------------------

test('1. an admin connects the account\'s own Stripe account; the state is one-time, for that person, and a member cannot', async () => {
  const fake = fakeStripe();
  const { c, acc } = await charity('Gina Green', 'gina@green.example', { connect: false });
  assert.equal((await c.get('/collect/connection')).data.connected, null);
  const r = await c.post('/collect/connect');
  const u = new URL(r.data.url);
  assert.equal(u.host, 'connect.stripe.com');
  assert.equal(u.searchParams.get('client_id'), 'ca_test');
  assert.match(u.searchParams.get('redirect_uri')!, /\/api\/collect\/callback$/);
  const state = u.searchParams.get('state')!;
  // Someone else's browser with the same state connects nothing to their account, and does not use it up.
  const other = await charity('Olga Other', 'olga@other.example', { connect: false });
  assert.equal((await other.c.get(`/collect/callback?state=${state}&code=good`)).status, 303);
  assert.equal(s.db.get('SELECT 1 x FROM collect_accounts WHERE account_id=?', other.acc), null);
  // A refused connect says so, and a bad code connects nothing.
  assert.equal((await c.get('/collect/callback?error=access_denied')).status, 303);
  const back = await c.get(`/collect/callback?state=${state}&code=good`);
  assert.equal(back.status, 303);
  const conn = (await c.get('/collect/connection')).data;
  assert.equal(conn.connected.name, 'Green Trust');
  assert.equal(s.db.get('SELECT stripe_account a FROM collect_accounts WHERE account_id=?', acc).a, 'acct_green');
  // The state was used up: the same answer again connects nothing new.
  s.db.run('DELETE FROM collect_accounts WHERE account_id=?', acc);
  await c.get(`/collect/callback?state=${state}&code=good`);
  assert.equal(s.db.get('SELECT 1 x FROM collect_accounts WHERE account_id=?', acc), null);
  // Connect again, then disconnect: Stripe is told.
  const again = new URL((await c.post('/collect/connect')).data.url).searchParams.get('state');
  await c.get(`/collect/callback?state=${again}&code=good`);
  const d = await c.call('DELETE', '/collect/connection');
  assert.equal(d.status, 200);
  assert.deepEqual(fake.deauthorized, ['acct_green']);
  assert.equal((await c.get('/collect/connection')).data.connected, null);
  // A member of the team cannot connect or disconnect.
  assert.equal((await c.post('/account/invites', { email: 'mo@green.example', role: 'member' })).status, 200);
  const m = new Client();
  m.ip = ip();
  await m.post('/auth/signup', { name: 'Mo Member', email: 'mo@green.example', password: 'correct horse battery', invite: s.db.get('SELECT token FROM invites WHERE email=?', 'mo@green.example').token });
  assert.equal((await m.post('/collect/connect')).status, 403);
});

test('1b. an account that has not earned trust is not offered Connect; without the settings nothing is offered at all', async () => {
  fakeStripe();
  const { c } = await charity('Nina New', 'nina@new.example', { trusted: false, connect: false });
  const conn = (await c.get('/collect/connection')).data;
  assert.equal(conn.may, false);
  assert.match(conn.why, /Payments can be asked for while signing once/);
  const r = await c.post('/collect/connect');
  assert.equal(r.status, 403);
  assert.match(r.data.error, /Nothing was connected\.$/);
  const keep = process.env.STRIPE_CONNECT_CLIENT_ID;
  delete process.env.STRIPE_CONNECT_CLIENT_ID;
  try {
    assert.deepEqual((await c.get('/collect/connection')).data, { available: false });
    assert.equal((await c.post('/collect/connect')).status, 404);
  } finally {
    process.env.STRIPE_CONNECT_CLIENT_ID = keep;
  }
});

// ---- 2. The payment on an envelope or a template --------------------------------------------------------------------------

test('2. a sender asks for a fixed amount or the amount in a field; wrong amounts, links and currencies are refused in words', async () => {
  fakeStripe();
  const { c } = await charity('Hana Hall', 'hana@hall.example');
  const e = await doc(c, 'pat1@example.com', {}, [{ id: 'amt', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Donation', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.03 }]);
  const put = (b: any) => c.put(`/envelopes/${e.id}/collect`, b);
  for (const [b, re] of [
    [{ amount: '0.10', currency: 'eur', for: 'Deposit' }, /between 0\.50 EUR and/],
    [{ amount: '25', currency: 'xyz', for: 'Deposit' }, /not a currency offered here/],
    [{ amount: '25', currency: 'eur', for: '' }, /Say what the payment is for/],
    [{ amount: '25', currency: 'eur', for: 'pay at https://evil.example' }, /cannot hold a web address/],
    [{ amount: '1,234', currency: 'eur', for: 'Deposit' }, /can be read two ways/],
    [{ field_id: 'nope', currency: 'eur', for: 'Deposit' }, /not a number field or a calculated field/],
  ] as [any, RegExp][]) {
    const r = await put(b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.match(r.data.error, re);
    assert.match(r.data.error, /Nothing was saved\.$/);
  }
  const ok = await put({ amount: '25.00', currency: 'EUR', for: 'Deposit for the hall', when: 'before' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.setting.amount_text, '25.00 EUR');
  const view = (await c.get(`/envelopes/${e.id}/collect`)).data;
  assert.equal(view.setting.when, 'before');
  assert.deepEqual(view.fields.map((f: any) => f.label), ['Donation']);
  const fieldId = view.fields[0].id;
  assert.equal((await put({ field_id: fieldId, currency: 'eur', for: 'Donation', when: 'after' })).data.setting.field_label, 'Donation');
  // A payment link and a card payment never both: each refuses the other.
  const link = await c.put(`/envelopes/${e.id}/pay-link`, { url: 'https://pay.example.org/x' });
  assert.equal(link.status, 409);
  assert.match(link.data.error, /already asks for a payment by card/);
  // Once sent it can be taken off, not changed.
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const late = await put({ amount: '30', currency: 'eur', for: 'Deposit' });
  assert.equal(late.status, 409);
  assert.match(late.data.error, /can only be taken off now/);
  // A template's payment goes with each document made from it, from the copy's own field.
  const file = await upload(c, 1);
  const t = (await c.post('/envelopes', { kind: 'template', subject: 'Membership', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Member' }],
    fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }, { id: 'a', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Fee', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.03 }] })).data;
  const tid = t.envelope.id;
  const tf = (await c.get(`/envelopes/${tid}/collect`)).data.fields[0].id;
  assert.equal((await c.put(`/envelopes/${tid}/collect`, { field_id: tf, currency: 'gbp', for: 'Membership fee' })).status, 200);
  const made = s.env.copyEnvelope(s.env.loadEnvelope(tid), { accountId: s.env.loadEnvelope(tid).account_id, senderId: s.env.loadEnvelope(tid).sender_id, kind: 'envelope' });
  const copy = s.env.loadEnvelope(made);
  assert.equal(copy.collect_currency, 'gbp');
  assert.notEqual(copy.collect_field, tf);
  assert.equal(copy.fields.find((f: any) => f.id === copy.collect_field)?.label, 'Fee');
});

// ---- 3. Paid only on Stripe's word ------------------------------------------------------------------------------------------

test('3. pay before finishing: Finish waits, the Stripe page is on the connected account, and the part completes on the signed message', async () => {
  const fake = fakeStripe();
  const { c } = await charity('Ivo Hall', 'ivo@hall.example');
  const e = await doc(c, 'pat2@example.com');
  assert.equal((await c.put(`/envelopes/${e.id}/collect`, { amount: '25', currency: 'eur', for: 'Hall deposit', when: 'before' })).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = tokenFor(e.id, 'pat2@example.com');
  // The one line ahead, so nobody is surprised.
  const p = new Client();
  await p.post(`/sign/${tok}/consent`);
  const ahead = (await p.get(`/sign/${tok}/collect`)).data.collect;
  assert.equal(ahead.state, 'ahead');
  assert.match(ahead.line, /When you finish, you pay 25\.00 EUR to Green Trust for Hall deposit\./);
  // Pay before Finish was pressed: nothing to pay yet.
  assert.equal((await p.post(`/sign/${tok}/collect/start`)).status, 409);
  // Finish: not signed, the Pay screen.
  const f = await p.post(`/sign/${tok}/complete`, { values: await valuesFor(p, tok), signature_png: PNG });
  assert.equal(f.status, 402);
  assert.equal(f.data.code, 'pay_first');
  assert.match(f.data.error, /Pay 25\.00 EUR to Green Trust to finish\./);
  assert.equal(s.db.get('SELECT status FROM recipients WHERE token=?', tok).status !== 'completed', true);
  assert.equal((await p.get(`/sign/${tok}/collect`)).data.collect.state, 'ready');
  const start = await p.post(`/sign/${tok}/collect/start`);
  assert.equal(start.status, 200);
  assert.match(start.data.url, /^https:\/\/checkout\.stripe\.com\//);
  const call = fake.calls.find((x) => x.url === 'https://api.stripe.com/v1/checkout/sessions')!;
  assert.equal(call.account, 'acct_green', 'a direct charge on the charity\'s own account');
  assert.equal(call.params.get('line_items[0][price_data][unit_amount]'), '2500');
  assert.equal(call.params.get('application_fee_amount'), null, 'no fee is taken');
  assert.doesNotMatch(call.params.get('success_url')!, new RegExp(tok), 'the signing link is never given to Stripe');
  // Pressing Pay again gives the same page: never two open at once.
  assert.equal((await p.post(`/sign/${tok}/collect/start`)).data.url, start.data.url);
  assert.equal(fake.calls.filter((x) => x.url === 'https://api.stripe.com/v1/checkout/sessions').length, 1);
  assert.equal((await p.get(`/sign/${tok}/collect`)).data.collect.state, 'started');
  const sid = Object.keys(fake.sessions)[0];
  // Unpaid: a completed session that is not paid yet (a bank transfer, say) changes nothing.
  assert.equal((await hook({ type: 'checkout.session.completed', account: 'acct_green', data: { object: { id: sid, payment_status: 'unpaid' } } })).data.done, 'waiting');
  // A message that claims paid while Stripe, asked again, says unpaid: not paid.
  assert.equal((await hook(paidEvent({ ...fake.sessions[sid], payment_status: 'paid' }))).data.done, 'ignored');
  assert.notEqual(s.db.get('SELECT status FROM recipients WHERE token=?', tok).status, 'completed');
  const envPage = (await c.get(`/envelopes/${e.id}/collect`)).data.people[0];
  assert.equal(envPage.line, 'Payment started, not confirmed.');
  // Paid, and Stripe's message says so: the part completes with what was signed.
  fake.pay(sid);
  const done = await hook(paidEvent(fake.sessions[sid]));
  assert.equal(done.data.done, 'paid');
  assert.equal(s.db.get('SELECT status FROM recipients WHERE token=?', tok).status, 'completed');
  assert.equal(s.env.loadEnvelope(e.id).status, 'completed');
  const line = (await c.get(`/envelopes/${e.id}/collect`)).data.people[0].line;
  assert.match(line, /^Payment of 25\.00 EUR to Green Trust confirmed by Stripe at \d+ \w+ \d{4} at \d\d:\d\d UTC\.$/);
  // Replayed: applied once.
  const ev = { id: 'evt_replay', ...paidEvent(fake.sessions[sid]) };
  const raw = JSON.stringify(ev);
  assert.equal((await new Client().call('POST', '/collect/webhook', ev, { 'stripe-signature': sign(raw) })).data.done, 'ignored', 'already paid');
  assert.equal((await new Client().call('POST', '/collect/webhook', ev, { 'stripe-signature': sign(raw) })).data.done, 'duplicate');
  assert.equal(s.db.all("SELECT 1 FROM audit WHERE envelope_id=? AND action='Payment confirmed'", e.id).length, 1);
  // 4. The signing record says it in those words.
  const cert = s.env.loadEnvelope(e.id);
  const { collectCertLines } = await import('../src/server/collect.ts');
  assert.match(collectCertLines(cert)[0][1], /^Pat Payer: Payment of 25\.00 EUR to Green Trust confirmed by Stripe at /);
  assert.match(read('src/server/pdf.ts'), /collectCertLines\(e\)/);
});

test('3b. forged, stale, wrong-account and replayed messages from Stripe change nothing', async () => {
  const fake = fakeStripe();
  const { c } = await charity('Kai Hall', 'kai@hall.example');
  const e = await doc(c, 'pat3@example.com');
  await c.put(`/envelopes/${e.id}/collect`, { amount: '10', currency: 'usd', for: 'Fee', when: 'before' });
  await c.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'pat3@example.com');
  const { p } = await finish(tok);
  await p.post(`/sign/${tok}/collect/start`);
  const sid = Object.keys(fake.sessions).pop()!;
  fake.pay(sid);
  const ev = paidEvent(fake.sessions[sid]);
  const raw = JSON.stringify({ id: 'evt_x', ...ev });
  // Forged: signed with another secret, or not signed.
  assert.equal((await new Client().call('POST', '/collect/webhook', JSON.parse(raw), { 'stripe-signature': sign(raw, 'whsec_guess') })).status, 400);
  assert.equal((await new Client().call('POST', '/collect/webhook', JSON.parse(raw), {})).status, 400);
  // Stale: a real signature from 10 minutes ago (a replay of an old message).
  assert.equal((await new Client().call('POST', '/collect/webhook', JSON.parse(raw), { 'stripe-signature': sign(raw, 'whsec_connect', Math.floor(Date.now() / 1000) - 600) })).status, 400);
  // Wrong account: the same session named for another connected account.
  assert.equal((await hook({ ...ev, account: 'acct_evil' })).data.done, 'ignored');
  assert.notEqual(s.db.get('SELECT status FROM recipients WHERE token=?', tok).status, 'completed');
  // The real one, then the same one again.
  const real = await new Client().call('POST', '/collect/webhook', JSON.parse(raw), { 'stripe-signature': sign(raw) });
  assert.equal(real.data.done, 'paid');
  const again = await new Client().call('POST', '/collect/webhook', JSON.parse(raw), { 'stripe-signature': sign(raw) });
  assert.equal(again.data.done, 'duplicate');
  assert.equal(s.db.all("SELECT 1 FROM audit WHERE envelope_id=? AND action='Payment confirmed'", e.id).length, 1);
});

test('3c. refunds and disputes in Stripe show on the envelope; pay after finishing never holds signing up', async () => {
  const fake = fakeStripe();
  const { c } = await charity('Lea Hall', 'lea@hall.example');
  const e = await doc(c, 'pat4@example.com', {}, [{ id: 'amt', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Donation', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.03 }]);
  const fid = (await c.get(`/envelopes/${e.id}/collect`)).data.fields[0].id;
  await c.put(`/envelopes/${e.id}/collect`, { field_id: fid, currency: 'eur', for: 'Donation', when: 'after' });
  await c.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'pat4@example.com');
  const view = (await (async () => { const p = new Client(); await p.post(`/sign/${tok}/consent`); return p.get(`/sign/${tok}`); })()).data;
  const amt = view.fields.find((f: any) => f.type === 'number').id;
  // The signer's own amount, unreadable: Finish is not held, and nothing is asked (after finishing).
  const { p, r } = await finish(tok, { [amt]: '40.00' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(s.env.loadEnvelope(e.id).status, 'completed');
  const ready = (await p.get(`/sign/${tok}/collect`)).data.collect;
  assert.equal(ready.state, 'ready');
  assert.equal(ready.amount, '40.00 EUR');
  await p.post(`/sign/${tok}/collect/start`);
  const sid = Object.keys(fake.sessions).pop()!;
  fake.pay(sid);
  assert.equal((await hook(paidEvent(fake.sessions[sid]))).data.done, 'paid');
  const pi = fake.sessions[sid].payment_intent;
  // A refund from another account's charge with the same id changes nothing; the real one shows.
  assert.equal((await hook({ type: 'charge.refunded', account: 'acct_evil', data: { object: { payment_intent: pi, amount_refunded: 4000 } } })).data.done, 'ignored');
  assert.equal((await hook({ type: 'charge.refunded', account: 'acct_green', data: { object: { payment_intent: pi, amount_refunded: 1000 } } })).data.done, 'refunded');
  let person = (await c.get(`/envelopes/${e.id}/collect`)).data.people[0];
  assert.equal(person.state, 'partly_refunded');
  assert.match(person.line, /10\.00 EUR refunded on .*, as Stripe reported\./);
  assert.equal((await hook({ type: 'charge.dispute.created', account: 'acct_green', data: { object: { payment_intent: pi, status: 'needs_response' } } })).data.done, 'disputed');
  person = (await c.get(`/envelopes/${e.id}/collect`)).data.people[0];
  assert.equal(person.state, 'disputed');
  assert.match(person.line, /The card payment is disputed, as Stripe reported on/);
  const actions = (await c.get(`/envelopes/${e.id}`)).data.audit.map((a: any) => a.action);
  for (const a of ['Payment request added', 'Payment started', 'Payment confirmed', 'Payment refunded', 'Payment disputed']) assert.ok(actions.includes(a), a);
});

test('3d. nobody is stuck: a disconnected account lets people finish without paying and says why; the sender\'s own team is never asked', async () => {
  fakeStripe();
  const { c } = await charity('Max Hall', 'max@hall.example');
  const e = await doc(c, 'pat5@example.com');
  await c.put(`/envelopes/${e.id}/collect`, { amount: '25', currency: 'eur', for: 'Deposit', when: 'before' });
  await c.post(`/envelopes/${e.id}/send`);
  const d = await c.call('DELETE', '/collect/connection');
  assert.equal(d.data.open_asking, 1);
  const { r } = await finish(tokenFor(e.id, 'pat5@example.com'));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const audit = (await c.get(`/envelopes/${e.id}`)).data.audit.find((a: any) => a.action === 'Payment not asked');
  assert.match(audit.detail, /disconnected its Stripe account, so no payment is asked\./);
  // The sender's own team is never asked.
  const again = await charity('Ned Hall', 'ned@hall.example');
  const own = await doc(again.c, 'ned@hall.example');
  await again.c.put(`/envelopes/${own.id}/collect`, { amount: '25', currency: 'eur', for: 'Deposit', when: 'before' });
  await again.c.post(`/envelopes/${own.id}/send`);
  assert.equal((await finish(tokenFor(own.id, 'ned@hall.example'))).r.status, 200);
});

test('3e. paid, then the document changed: nothing is signed unseen, the payment stays, and Finish later goes straight through', async () => {
  const fake = fakeStripe();
  const { c } = await charity('Ola Hall', 'ola@hall.example');
  const e = await doc(c, 'pat6@example.com');
  await c.put(`/envelopes/${e.id}/collect`, { amount: '12.50', currency: 'eur', for: 'Fee', when: 'before' });
  await c.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'pat6@example.com');
  const { p } = await finish(tok);
  await p.post(`/sign/${tok}/collect/start`);
  const sid = Object.keys(fake.sessions).pop()!;
  // The sender corrects the document while Stripe takes the money.
  s.db.run('UPDATE envelopes SET content_version=content_version+1 WHERE id=?', e.id);
  fake.pay(sid);
  assert.equal((await hook(paidEvent(fake.sessions[sid]))).data.done, 'paid');
  assert.notEqual(s.db.get('SELECT status FROM recipients WHERE token=?', tok).status, 'completed');
  assert.ok(mailTo('pat6@example.com').some((m: any) => /Your payment is confirmed/.test(m.subject)));
  const v = (await p.get(`/sign/${tok}`)).data;
  const r = await p.post(`/sign/${tok}/complete`, { values: await valuesFor(p, tok), signature_png: PNG, version: v.version });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(fake.calls.filter((x) => x.url === 'https://api.stripe.com/v1/checkout/sessions').length, 1, 'not asked to pay twice');
});

// ---- 5, 6 and the words -------------------------------------------------------------------------------------------------

test('5-6. mobile money is an adapter that is not set up; no fee; the words are plain and promise nothing about the law', async () => {
  const col = await import('../src/server/collect.ts');
  const lib = await import('../src/lib/collect.ts');
  assert.equal(col.MOBILE_MONEY.configured(), false);
  assert.deepEqual(col.PROVIDERS.map((x) => x.key), ['stripe', 'mobile_money']);
  assert.equal(lib.moneyText(2500, 'eur'), '25.00 EUR');
  assert.equal(lib.moneyText(500, 'jpy'), '500 JPY');
  assert.equal(lib.toMinor(25.555, 'eur'), null);
  assert.doesNotMatch(read('src/server/collect.ts'), /application_fee/);
  const words = [read('src/lib/collect.ts'), read('src/server/collect.ts'), read('src/server/routes-collect.ts'), read('src/components/sign/PayNow.tsx'), read('src/components/editor/CollectChoice.tsx'), read('src/components/settings/TakePayments.tsx')].join('\n');
  assert.doesNotMatch(words, /\u2014|is valid|will hold up|guarantee/i);
  // Every refusal says what happened, then what to do.
  const { checkFor } = lib;
  for (const t of [(checkFor('') as any).error, (checkFor('x'.repeat(200)) as any).error]) assert.match(t, /\. [A-Z][^.]*\.( Nothing was saved\.)?$/);
  // The signing page shows the payment only for documents that ask for one, after the last signature, before Done.
  const page = read('src/app/sign/[token]/page.tsx');
  assert.match(page, /pay_first/);
  assert.match(page, /<PayNow /);
  // Documented where people look.
  const readme = read('README.md');
  assert.match(readme, /STRIPE_CONNECT_CLIENT_ID/);
  assert.match(read('.env.example'), /STRIPE_CONNECT_WEBHOOK_SECRET/);
  const { openapi } = await import('../src/server/openapi.ts');
  const paths = (openapi() as any).paths;
  for (const k of ['/collect/connection', '/collect/connect', '/collect/webhook', '/envelopes/{id}/collect', '/sign/{token}/collect', '/sign/{token}/collect/start']) assert.ok(paths[k], k);
});

test('3f. a payment Stripe has but has not confirmed by message is never called paid; the amount paid cannot change after', async () => {
  const fake = fakeStripe();
  const { c } = await charity('Pia Hall', 'pia@hall.example');
  const e = await doc(c, 'pat7@example.com', {}, [{ id: 'amt', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Donation', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.03 }]);
  const fid = (await c.get(`/envelopes/${e.id}/collect`)).data.fields[0].id;
  await c.put(`/envelopes/${e.id}/collect`, { field_id: fid, currency: 'eur', for: 'Donation', when: 'before' });
  await c.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'pat7@example.com');
  const p = new Client();
  await p.post(`/sign/${tok}/consent`);
  const amt = (await p.get(`/sign/${tok}`)).data.fields.find((f: any) => f.type === 'number').id;
  // An amount nobody can read is refused before anything is asked.
  const odd = await p.post(`/sign/${tok}/complete`, { values: await valuesFor(p, tok, { [amt]: '1,234' }), signature_png: PNG });
  assert.equal(odd.status, 400);
  assert.match(odd.data.error, /can be read two ways\. Write it with its decimals/);
  assert.equal((await p.post(`/sign/${tok}/complete`, { values: await valuesFor(p, tok, { [amt]: '5.00' }), signature_png: PNG })).data.code, 'pay_first');
  await p.post(`/sign/${tok}/collect/start`);
  const sid = Object.keys(fake.sessions).pop()!;
  fake.pay(sid);
  // Paid on Stripe's page, no message yet: Pay again opens no second page and nothing says paid.
  const again = await p.post(`/sign/${tok}/collect/start`);
  assert.deepEqual(again.data, { waiting: true });
  assert.equal(s.db.get('SELECT status FROM collect_payments WHERE session_id=?', sid).status, 'started');
  assert.equal(fake.calls.filter((x) => x.url === 'https://api.stripe.com/v1/checkout/sessions').length, 1);
  // The message arrives, but the document changed first, so the part is not completed with it.
  s.db.run('UPDATE envelopes SET content_version=content_version+1 WHERE id=?', e.id);
  assert.equal((await hook(paidEvent(fake.sessions[sid]))).data.done, 'paid');
  // Finishing again with another amount than was paid is refused in words; with the same amount it goes through.
  const v = (await p.get(`/sign/${tok}`)).data.version;
  const other = await p.post(`/sign/${tok}/complete`, { values: await valuesFor(p, tok, { [amt]: '500.00' }), signature_png: PNG, version: v });
  assert.equal(other.status, 409);
  assert.match(other.data.error, /^You paid 5\.00 EUR, and Donation now says something else\. Change it back to 5\.00 EUR, then finish again\.$/);
  const same = await p.post(`/sign/${tok}/complete`, { values: await valuesFor(p, tok, { [amt]: '5.00' }), signature_png: PNG, version: v });
  assert.equal(same.status, 200, JSON.stringify(same.data));
});

// ---- Repairs after the skeptic and the simplicity review ------------------------------------------------------------------

const amountDoc = async (c: Client, email: string) => {
  const e = await doc(c, email, {}, [{ id: 'amt', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Donation', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.03 }]);
  const fid = (await c.get(`/envelopes/${e.id}/collect`)).data.fields[0].id;
  assert.equal((await c.put(`/envelopes/${e.id}/collect`, { field_id: fid, currency: 'eur', for: 'Donation', when: 'before' })).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  const tok = tokenFor(e.id, email);
  const p = new Client();
  await p.post(`/sign/${tok}/consent`);
  const amt = (await p.get(`/sign/${tok}`)).data.fields.find((f: any) => f.type === 'number').id;
  const fin = async (v: string) => p.post(`/sign/${tok}/complete`, { values: await valuesFor(p, tok, { [amt]: v }), signature_png: PNG });
  return { e, tok, p, fin };
};
const status = (tok: string) => s.db.get('SELECT status FROM recipients WHERE token=?', tok).status;

test('R1 (high). a changed amount closes the earlier Stripe page first; never two open at once', async () => {
  const fake = fakeStripe();
  const { c } = await charity('Ria Hall', 'ria@hall.example');
  const { tok, p, fin } = await amountDoc(c, 'r1@example.com');
  assert.equal((await fin('100.00')).data.code, 'pay_first');
  await p.post(`/sign/${tok}/collect/start`);
  const [cs1] = Object.keys(fake.sessions).slice(-1);
  assert.equal((await fin('50.00')).data.code, 'pay_first');
  const again = await p.post(`/sign/${tok}/collect/start`);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  const cs2 = Object.keys(fake.sessions).pop()!;
  assert.notEqual(cs2, cs1);
  assert.ok(fake.expired.includes(cs1), 'the 100.00 page was closed at Stripe before the 50.00 one was made');
  assert.equal(fake.sessions[cs1].status, 'expired');
  assert.equal(fake.sessions[cs2].amount_total, 5000);
  // Stripe unreachable while closing the old page: no new page is made, and nothing was charged.
  assert.equal((await fin('60.00')).data.code, 'pay_first');
  const real = globalThis.fetch;
  const before = Object.keys(fake.sessions).length;
  globalThis.fetch = (async (u: any, i: any) => (String(u).includes('/expire') ? Promise.reject(new Error('down')) : real(u, i))) as any;
  const down = await p.post(`/sign/${tok}/collect/start`);
  globalThis.fetch = real;
  assert.equal(down.status, 503);
  assert.match(down.data.error, /Nothing was charged/);
  assert.equal(Object.keys(fake.sessions).length, before, 'no second page while the first may still be open');
});

test('R1b (high). a payment on the earlier page is recorded, never dropped, and the person is told what is left', async () => {
  const fake = fakeStripe();
  const { c } = await charity('Rob Hall', 'rob@hall.example');
  const { e, tok, p, fin } = await amountDoc(c, 'r1b@example.com');
  await fin('100.00');
  await p.post(`/sign/${tok}/collect/start`);
  const cs1 = Object.keys(fake.sessions).pop()!;
  // They change the amount and press Finish (the row now asks 50.00), and meanwhile pay the 100.00 page.
  assert.equal((await fin('50.00')).data.code, 'pay_first');
  fake.pay(cs1);
  const hooked = await hook(paidEvent(fake.sessions[cs1]));
  assert.equal(hooked.data.done, 'paid', 'the payment on the older page counts');
  const row = s.db.get("SELECT * FROM collect_payments WHERE envelope_id=?", e.id);
  assert.equal(row.status, 'paid');
  assert.equal(row.amount, 10000, 'what was actually paid');
  // Their part does not complete with 50.00 when 100.00 was paid: they are told, in words, and asked to finish again.
  assert.notEqual(status(tok), 'completed');
  assert.ok(s.db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Paid, not finished yet'", e.id));
  const mail = mailTo('r1b@example.com').map((m: any) => m.html).join('\n');
  assert.match(mail, /payment of 100\.00 EUR/);
  assert.match(mail, /set the amount back to 100\.00 EUR and press Finish/);
  // Finishing with 100.00 goes through without paying again.
  const v = (await p.get(`/sign/${tok}`)).data.version;
  const amt = (await p.get(`/sign/${tok}`)).data.fields.find((f: any) => f.type === 'number').id;
  const ok = await p.post(`/sign/${tok}/complete`, { values: await valuesFor(p, tok, { [amt]: '100.00' }), signature_png: PNG, version: v });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(status(tok), 'completed');
});

test('R1c. pressing Pay after the earlier page was paid: it counts, no new page, and the person is told what is left', async () => {
  const fake = fakeStripe();
  const { c } = await charity('Rui Hall', 'rui@hall.example');
  const { tok, p, fin } = await amountDoc(c, 'r1c@example.com');
  await fin('30.00');
  await p.post(`/sign/${tok}/collect/start`);
  const cs1 = Object.keys(fake.sessions).pop()!;
  fake.pay(cs1);
  // Same amount again: the open page is reused, and Stripe says it is paid (no message yet): waiting, never a second page.
  await fin('30.00');
  assert.deepEqual((await p.post(`/sign/${tok}/collect/start`)).data, { waiting: true });
  // A changed amount: the older page is found paid while closing it, so it counts and the 30.00 Finish waits on the field.
  await fin('20.00');
  const n = Object.keys(fake.sessions).length;
  const r = await p.post(`/sign/${tok}/collect/start`);
  assert.deepEqual(r.data, { paid: true });
  assert.equal(Object.keys(fake.sessions).length, n, 'no new page');
  // The message from Stripe arriving later changes nothing more.
  assert.equal((await hook(paidEvent(fake.sessions[cs1]))).data.done, 'ignored');
  assert.notEqual(status(tok), 'completed', 'paid 30.00 while the field says 20.00: never signed with the other amount');
  assert.ok(mailTo('r1c@example.com').some((m: any) => /set the amount back to 30\.00 EUR/.test(m.html)));
});

test('R1d. paid on two pages: the second is never silently kept; the history and the sender say to refund it', async () => {
  const fake = fakeStripe();
  const { c } = await charity('Rae Hall', 'rae@hall.example');
  const { e, tok, p, fin } = await amountDoc(c, 'r1d@example.com');
  await fin('10.00');
  await p.post(`/sign/${tok}/collect/start`);
  const cs1 = Object.keys(fake.sessions).pop()!;
  await fin('12.00');
  await p.post(`/sign/${tok}/collect/start`);
  const cs2 = Object.keys(fake.sessions).pop()!;
  // A race at Stripe: both end up paid.
  fake.pay(cs2);
  fake.pay(cs1);
  assert.equal((await hook(paidEvent(fake.sessions[cs2]))).data.done, 'paid');
  assert.equal(status(tok), 'completed');
  const twice = await hook(paidEvent(fake.sessions[cs1]));
  assert.equal(twice.data.done, 'paid_twice');
  const line = s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Paid twice'", e.id).detail;
  assert.match(line, /also paid 10\.00 EUR on an earlier Stripe page.*Refund the second one in your Stripe dashboard\./);
  assert.ok(mailTo('rae@hall.example').some((m: any) => /Paid twice/.test(m.subject)));
  // Sent again by Stripe: said once.
  assert.equal((await hook(paidEvent(fake.sessions[cs1]))).data.done, 'ignored');
});

test('R2. after the account took access away in Stripe, a page already open and paid is still recorded from the signed message', async () => {
  const fake = fakeStripe();
  const { c } = await charity('Dee Hall', 'dee@hall.example');
  const e = await doc(c, 'r2@example.com');
  await c.put(`/envelopes/${e.id}/collect`, { amount: '15', currency: 'eur', for: 'Fee', when: 'before' });
  await c.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'r2@example.com');
  const { p } = await finish(tok);
  await p.post(`/sign/${tok}/collect/start`);
  const sid = Object.keys(fake.sessions).pop()!;
  fake.pay(sid);
  assert.equal((await hook({ type: 'account.application.deauthorized', account: 'acct_green', data: { object: {} } })).data.done, 'disconnected');
  fake.gone.push('acct_green');
  assert.equal((await hook(paidEvent(fake.sessions[sid]))).data.done, 'paid');
  assert.equal(s.db.get('SELECT status FROM collect_payments WHERE session_id=?', sid).status, 'paid');
});

test('R3. the Stripe connect answer reaching a signed-out browser goes to sign in, then back to Settings', async () => {
  fakeStripe();
  const { handle } = await import('../src/server/router.ts');
  const r = await handle(new Request('http://test.local/api/collect/callback?state=x&code=good'));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), `/login?next=${encodeURIComponent('/app/settings?tab=sending&collect=failed')}`);
});

test('R4. choosing "By card" over the own payment page: the link goes only once the payment itself is accepted', async () => {
  fakeStripe();
  const { c } = await charity('Lin Hall', 'lin@hall.example');
  const e = await doc(c, 'r4@example.com');
  // The link as the pay-link route stores it (its own checks are tested in gaps-industry.test.ts).
  s.db.run("UPDATE envelopes SET pay_url='https://pay.example.org/hall', pay_kind='deposit' WHERE id=?", e.id);
  const refused = await c.put(`/envelopes/${e.id}/collect`, { amount: '-5', currency: 'eur', for: 'Fee', replace_link: true });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /Nothing was saved\.$/);
  assert.ok(s.db.get('SELECT pay_url FROM envelopes WHERE id=?', e.id).pay_url, 'a refused payment leaves the link where it was');
  assert.equal((await c.put(`/envelopes/${e.id}/collect`, { amount: '5', currency: 'eur', for: 'Fee' })).status, 409, 'without replace_link the link is never taken off');
  const ok = await c.put(`/envelopes/${e.id}/collect`, { amount: '5', currency: 'eur', for: 'Fee', replace_link: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.pay_link_removed, true);
  assert.equal(s.db.get('SELECT pay_url FROM envelopes WHERE id=?', e.id).pay_url, null);
  assert.ok(s.db.get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Payment link removed'", e.id));
});

test('R5. the sender\'s page and the reminder say "waiting for payment" for someone who pressed Finish, never "press Finish"', async () => {
  fakeStripe();
  const { c } = await charity('Mae Hall', 'mae@hall-r5.example');
  const e = await doc(c, 'r5@example.com');
  await c.put(`/envelopes/${e.id}/collect`, { amount: '40', currency: 'eur', for: 'Deposit for the hall', when: 'before' });
  await c.post(`/envelopes/${e.id}/send`);
  const tok = tokenFor(e.id, 'r5@example.com');
  const { p } = await finish(tok);
  // Their answers saved by autosave too, the way a real page does: still "waiting for payment", not "ready".
  const fid = s.db.get("SELECT id FROM fields WHERE envelope_id=? AND type='signature'", e.id).id;
  s.db.run('UPDATE fields SET value=? WHERE id=?', 'sig', fid);
  void p;
  const r = (await c.get(`/envelopes/${e.id}`)).data.envelope.recipients[0];
  assert.equal(r.progress.ready, false);
  assert.equal(r.progress.paying, '40.00 EUR');
  assert.match(read('src/components/sender/Recipients.tsx'), /Waiting for payment\./);
  const rem = await c.post(`/envelopes/${e.id}/remind`, {});
  assert.equal(rem.status, 200, JSON.stringify(rem.data));
  const last = mailTo('r5@example.com').pop();
  assert.match(last.html, /Your signature is ready\. Pay 40\.00 EUR to finish/);
  assert.doesNotMatch(last.html, /press Finish\. Until you do/);
});

test('R6. people on the sender\'s own team read "not asked: on your own team", and the words say so', async () => {
  fakeStripe();
  const { c } = await charity('Tia Hall', 'tia@hall.example');
  const e = await doc(c, 'tia@hall.example');
  await c.put(`/envelopes/${e.id}/collect`, { amount: '9', currency: 'eur', for: 'Fee' });
  const people = (await c.get(`/envelopes/${e.id}/collect`)).data.people;
  assert.equal(people[0].line, 'Not asked to pay: they are on your own team.');
  assert.match(read('src/components/sender/CollectNote.tsx'), /other than people on your own team/);
  assert.match(s.db.get("SELECT detail FROM audit WHERE envelope_id=? AND action='Payment request added'", e.id).detail, /other than people on the sending account's own team/);
});

test('R7. screens: short "when" choices with a hint, autosave with a Send guard, Pay after before Done, no forced bounce, summary', async () => {
  const lib = await import('../src/lib/collect.ts');
  assert.ok(lib.WHEN_WORDS.after.length <= 20 && lib.WHEN_WORDS.before.length <= 20, 'fits a phone select');
  assert.equal(lib.collectSummary({ amount_text: '40.00 EUR', field_label: null, when: 'before' }), 'asks each signer to pay 40.00 EUR before finishing');
  const { reviewSummary } = await import('../src/lib/editorux.ts');
  assert.match(reviewSummary({ reminderDays: 3, defaults: {}, collect: lib.collectSummary({ amount_text: '40.00 EUR', field_label: null, when: 'before' }) }), /Reminder every 3 days · asks each signer to pay 40\.00 EUR before finishing/);
  const choice = read('src/components/editor/CollectChoice.tsx');
  assert.doesNotMatch(choice, /Save the payment|Choose &ldquo;By card&rdquo; and take it off/, 'no save button to forget, no detour to take it off');
  assert.match(choice, /Payment taken off\. Nobody was emailed\./);
  assert.match(read('src/components/Editor.tsx'), /flushCollect\(id\)/);
  const pay = read('src/components/sign/PayNow.tsx');
  assert.match(pay, /shown\.has\(base\)/, 'the Pay screen opens by itself once per page load, so Back stays back');
  assert.match(pay, /sign\.pay\.not_now/);
  const page = read('src/app/sign/[token]/page.tsx');
  assert.match(page, /<PayAfter base=\{base\} token=\{token\} on=\{acts\}>/);
  assert.match(page, /payWait && acts\) return <Shell data=\{data\} bar=\{other\}[^\n]*onHelp=\{headHelp\}/, 'Other actions (with Decline) and Help on the Pay screen');
  const en = JSON.parse(read('src/locales/en.json'));
  for (const k of ['sign.pay.title', 'sign.pay.not_now', 'sign.pay.still', 'sign.pay.waits']) assert.ok(en[k], k);
});
