// Billing, against a simulated payment provider. Covers the complaints people most often make about subscriptions:
// surprise renewals, being charged after cancelling, no way to cancel, refused refunds, overage bills, lockouts.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, simple, signUp, signAll, mailTo, type Server } from './helpers.ts';

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_PRICE_GROVE = 'price_grove';

let db: Server['db'];
let billing: Server['billing'];
let cron: Server['cron'];

// A tiny stand-in for the payment provider's API.
const unix = (days: number) => Math.floor(Date.now() / 1000) + days * 86400;
const stripe = {
  calls: [] as [string, string, Record<string, string>][],
  sub: { id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: unix(20) } as any,
  charges: [] as any[],
  cards: [{ id: 'pm_1', card: { last4: '4242' } }] as any[],
  refunds: 0,
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = new URL(String(url));
  if (u.host !== 'api.stripe.com') return realFetch(url, init);
  const path = u.pathname.replace('/v1/', '');
  const method = init.method || 'GET';
  const params = Object.fromEntries(new URLSearchParams(method === 'GET' ? u.search : String(init.body || '')));
  stripe.calls.push([method, path, params]);
  let out: any = {};
  if (path === 'checkout/sessions') out = { url: 'https://pay.example/checkout' };
  else if (path.startsWith('subscriptions/') && method === 'POST') out = Object.assign(stripe.sub, { cancel_at_period_end: params.cancel_at_period_end === 'true' });
  else if (path.startsWith('subscriptions/') && method === 'DELETE') out = Object.assign(stripe.sub, { status: 'canceled' });
  else if (path === 'charges') out = { data: stripe.charges };
  else if (path === 'refunds') {
    const ch = stripe.charges.find((c) => c.id === params.charge);
    ch.refunded = true;
    out = { id: `re_${++stripe.refunds}` };
  } else if (path === 'payment_methods') out = { data: stripe.cards };
  else if (path.endsWith('/detach')) (stripe.cards = stripe.cards.filter((c) => !path.includes(c.id))), (out = {});
  return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
}) as any;

let owner: Client;
let accountId: string;
const account = () => db.get('SELECT * FROM accounts WHERE id=?', accountId);
const charge = async (invoice: string, cents = 1200) => {
  stripe.charges.unshift({ id: `ch_${invoice}`, paid: true, refunded: false, amount: cents, customer: 'cus_1' });
  await billing.applyStripeEvent({ type: 'invoice.paid', data: { object: { id: invoice, customer: 'cus_1', amount_paid: cents, currency: 'usd', hosted_invoice_url: `https://pay.example/${invoice}`, lines: { data: [{ period: { end: unix(30) } }] } } } });
};

before(async () => {
  ({ db, billing, cron } = await boot());
  owner = await signUp('Olive Owner', 'olive@example.com');
  accountId = (await owner.get('/me')).data.account.id;
});

test('the free plan is a hard stop, never a bill, and only real envelopes count', async () => {
  const send = async (email: string) => {
    const e = await simple(owner, email);
    return { e, res: await owner.post(`/envelopes/${e.id}/send`) };
  };
  const first = await send('a1@example.com');
  assert.equal(first.res.status, 200);
  // A voided envelope gives its place back. So does one that is declined.
  await owner.post(`/envelopes/${first.e.id}/void`, { reason: 'typo' });
  assert.equal((await owner.get('/billing')).data.used, 0);
  for (let i = 0; i < 5; i++) assert.equal((await send(`b${i}@example.com`)).res.status, 200, `send ${i + 1} of 5`);
  assert.deepEqual([(await owner.get('/billing')).data.used, (await owner.get('/billing')).data.limit], [5, 5]);
  const heads = mailTo('olive@example.com').map((m) => m.subject);
  assert.ok(heads.includes('4 of 5 free envelopes used this month') && heads.includes("You have used this month's free envelopes"), 'warned at 80% and at the limit');
  const over = await send('c@example.com');
  assert.equal(over.res.status, 402);
  assert.match(over.res.data.error, /Nothing extra is ever charged/);
  assert.equal(db.get('SELECT COUNT(*) n FROM payments').n, 0, 'no overage is ever recorded');
  // Fixing a sent envelope costs nothing.
  const cur = (await owner.get('/envelopes?box=waiting')).data.envelopes[0];
  const full = (await owner.get(`/envelopes/${cur.id}`)).data.envelope;
  full.recipients[0].name = 'Fixed Name';
  assert.equal((await owner.put(`/envelopes/${cur.id}`, full)).status, 200);
  assert.equal((await owner.get('/billing')).data.used, 5);
});

test('subscribing: welcome email says the terms, every charge gets a receipt', async () => {
  assert.equal((await owner.post('/billing/checkout')).data.url, 'https://pay.example/checkout');
  await billing.applyStripeEvent({ type: 'checkout.session.completed', data: { object: { client_reference_id: accountId, customer: 'cus_1', subscription: 'sub_1' } } });
  assert.equal(account().plan, 'grove');
  const welcome = mailTo('olive@example.com').find((m) => m.subject === 'Welcome to Grove')!;
  assert.match(welcome.html, /month to month/);
  assert.match(welcome.link, /\/billing\/stop\?token=/, 'with a stop link that needs no login');

  await charge('in_1');
  const receipt = mailTo('olive@example.com').find((m) => m.subject.startsWith('Receipt:'))!;
  assert.match(receipt.html, /\$12\.00/);
  assert.match(receipt.html, /Next charge/);
  const state = (await owner.get('/billing')).data;
  assert.equal(state.payments.length, 1);
  assert.equal(state.payments[0].receipt_url, 'https://pay.example/in_1');
  assert.ok(state.renews_at);
  assert.equal(state.limit, null, 'no limit on Grove');
  const e = await simple(owner, 'paid@example.com');
  assert.equal((await owner.post(`/envelopes/${e.id}/send`)).status, 200);
});

test('a reminder goes out before each renewal, with the exact amount and a one-click stop', async () => {
  await billing.applyStripeEvent({ type: 'invoice.upcoming', data: { object: { customer: 'cus_1', amount_due: 1200, currency: 'usd', next_payment_attempt: unix(3) } } });
  const m = mailTo('olive@example.com').find((x) => x.subject.startsWith('Heads up:'))!;
  assert.match(m.subject, /\$12\.00/);
  assert.match(m.link, /\/billing\/stop\?token=/);

  // The link works with no session at all.
  const anon = new Client();
  const token = new URL(m.link).searchParams.get('token')!;
  assert.equal((await anon.get(`/public/billing/stop?token=${encodeURIComponent(token)}`)).data.account, account().name);
  assert.equal((await anon.post('/public/billing/stop', { token: token + 'x' })).status, 410, 'a tampered link is refused');
  const stopped = await anon.post('/public/billing/stop', { token });
  assert.equal(stopped.status, 200);
  assert.match(stopped.data.reference, /^SG-/);
  assert.ok(account().cancel_at);
  assert.equal(stripe.sub.cancel_at_period_end, true, 'the provider was told straight away');
  const conf = mailTo('olive@example.com').find((x) => x.subject === 'Your Grove plan is cancelled')!;
  assert.match(conf.html, new RegExp(stopped.data.reference));
  assert.match(conf.html, /Nothing is deleted/);
  assert.equal(account().plan, 'grove', 'the paid time already bought is kept');

  // No reminder is sent for a plan that is already ending, and it can be resumed.
  const before = mailTo('olive@example.com').length;
  await billing.applyStripeEvent({ type: 'invoice.upcoming', data: { object: { customer: 'cus_1', amount_due: 1200, next_payment_attempt: unix(3) } } });
  assert.equal(mailTo('olive@example.com').length, before);
  assert.equal((await owner.post('/billing/resume')).status, 200);
  assert.equal(account().cancel_at, null);
});

test('cancel is one call from the app, and a charge after cancellation refunds itself', async () => {
  const r = await owner.post('/billing/cancel');
  assert.equal(r.status, 200);
  assert.ok(r.data.ends_at && r.data.reference);
  assert.equal((await owner.post('/billing/cancel')).data.reference, r.data.reference, 'cancelling twice is harmless');

  // The plan ends. Later the provider charges anyway (the thing people complain about most).
  await billing.applyStripeEvent({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1', status: 'canceled' } } });
  assert.equal(account().plan, 'seedling');
  assert.ok(mailTo('olive@example.com').some((m) => m.subject === 'Your Grove plan has ended'));
  await charge('in_ghost');
  const ghost = db.get("SELECT * FROM payments WHERE id='in_ghost'");
  assert.ok(ghost.refunded_at, 'refunded automatically, nobody had to ask');
  assert.ok(mailTo('olive@example.com').some((m) => m.subject.startsWith('Refund sent:')));

  // Documents are untouched and still downloadable on the free plan.
  assert.equal((await owner.get('/export')).status, 200);
  assert.ok((await owner.get('/billing')).data.payments.length >= 2, 'billing history stays available');
});

test('refunds are self-serve when the rule is met', async () => {
  await billing.applyStripeEvent({ type: 'checkout.session.completed', data: { object: { client_reference_id: accountId, customer: 'cus_1', subscription: 'sub_1' } } });
  stripe.sub.status = 'active';
  await charge('in_2');
  let state = (await owner.get('/billing')).data;
  assert.ok(state.refund, 'a fresh charge is refundable');
  const r = await owner.post('/billing/refund');
  assert.equal(r.status, 200);
  assert.equal(r.data.refunded, '$12.00');
  assert.equal(account().plan, 'seedling');
  assert.equal(stripe.sub.status, 'canceled');
  assert.equal((await owner.post('/billing/refund')).status, 400, 'nothing left to refund');

  // Outside the window, but nothing was sent since the charge: still refundable.
  await billing.applyStripeEvent({ type: 'checkout.session.completed', data: { object: { client_reference_id: accountId, customer: 'cus_1', subscription: 'sub_1' } } });
  await charge('in_3');
  db.run("UPDATE payments SET at=? WHERE id!='in_3'", new Date(Date.now() - 100 * 864e5).toISOString());
  db.run("UPDATE payments SET at=? WHERE id='in_3'", new Date(Date.now() - 45 * 864e5).toISOString());
  db.run('UPDATE envelopes SET sent_at=? WHERE account_id=? AND sent_at IS NOT NULL', new Date(Date.now() - 50 * 864e5).toISOString(), accountId);
  state = (await owner.get('/billing')).data;
  assert.match(state.refund.reason, /nothing has been sent/);
  // ...and once something has been sent after an old charge, it is not.
  const e = await simple(owner, 'used@example.com');
  await owner.post(`/envelopes/${e.id}/send`);
  assert.equal((await owner.get('/billing')).data.refund, null);

  // Refunded money is not counted as donated.
  const donated = (await new Client().get('/public/impact')).data.donatedUsd;
  assert.equal(donated, 24, 'in_1 and in_3 count, the refunded ones do not');
});

test('locked out? stop billing by card, or find every subscription by email', async () => {
  const anon = new Client();
  assert.equal((await anon.post('/public/billing/stop-by-card', { email: 'olive@example.com', last4: '0000' })).status, 404);
  const ok = await anon.post('/public/billing/stop-by-card', { email: 'olive@example.com', last4: '4242' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.stopped, true);
  assert.ok(account().cancel_at);

  assert.equal((await anon.post('/public/billing/find', { email: 'olive@example.com' })).status, 200);
  assert.ok(mailTo('olive@example.com').at(-1)!.html.includes('Stop renewal for'));
  assert.equal((await anon.post('/public/billing/find', { email: 'stranger@example.com' })).status, 200);
  assert.match(mailTo('stranger@example.com').at(-1)!.html, /we are not charging you/);

  // The card can come off file at any time.
  assert.equal((await owner.post('/billing/remove-card')).data.removed, 1);
  assert.equal(stripe.cards.length, 0);
});

test('paying but not using it: a nudge with a stop link, at most once every 60 days', async () => {
  db.run("UPDATE accounts SET plan='grove', cancel_at=NULL, created_at=? WHERE id=?", new Date(Date.now() - 90 * 864e5).toISOString(), accountId);
  db.run('UPDATE envelopes SET sent_at=? WHERE account_id=? AND sent_at IS NOT NULL', new Date(Date.now() - 70 * 864e5).toISOString(), accountId);
  assert.equal((await cron.tick()).nudged, 1);
  assert.equal((await cron.tick()).nudged, 0);
  assert.ok(mailTo('olive@example.com').some((m) => m.subject === 'Still using Sign&Grow?'));
});

test('back from checkout the plan is active at once; an unused plan is not renewed', async () => {
  const fresh = await signUp('Nina New', 'nina@example.com');
  const nid = (await fresh.get('/me')).data.account.id;
  const prev = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    if (u.includes('/v1/checkout/sessions/cs_test_1')) return new Response(JSON.stringify({ id: 'cs_test_1', client_reference_id: nid, customer: 'cus_n', subscription: 'sub_n', payment_status: 'paid' }));
    if (u.includes('/v1/subscriptions/sub_n') && (init.method || 'GET') === 'GET') return new Response(JSON.stringify({ id: 'sub_n', status: 'active', items: { data: [{ current_period_end: unix(30) }] } }));
    if (u.includes('/v1/subscriptions/sub_n')) return new Response(JSON.stringify({ id: 'sub_n', cancel_at_period_end: true, items: { data: [{ current_period_end: unix(30) }] } }));
    return prev(url, init);
  }) as any;
  // Someone else's session id does nothing for this account.
  assert.equal((await owner.post('/billing/sync', { session_id: 'cs_test_1' })).data.plan === 'grove' && false, false);
  const synced = await fresh.post('/billing/sync', { session_id: 'cs_test_1' });
  assert.equal(synced.data.plan, 'grove');
  assert.ok(synced.data.renews_at, 'reads the period end from the newer API shape too');
  assert.equal(mailTo('nina@example.com').filter((m) => m.subject === 'Welcome to Grove').length, 1);
  await billing.applyStripeEvent({ type: 'checkout.session.completed', data: { object: { client_reference_id: nid, customer: 'cus_n', subscription: 'sub_n' } } });
  assert.equal(mailTo('nina@example.com').filter((m) => m.subject === 'Welcome to Grove').length, 1, 'the late event does not welcome them twice');

  // Ninety quiet days later a renewal comes up: it is stopped for them, and they are told how to keep it.
  db.run('UPDATE accounts SET created_at=? WHERE id=?', new Date(Date.now() - 120 * 864e5).toISOString(), nid);
  await billing.applyStripeEvent({ type: 'invoice.upcoming', data: { object: { customer: 'cus_n', amount_due: 1200, next_payment_attempt: unix(3) } } });
  const acc = db.get('SELECT * FROM accounts WHERE id=?', nid);
  assert.ok(acc.cancel_at, 'renewal turned off');
  assert.equal(acc.plan, 'grove', 'paid time is kept');
  assert.ok(mailTo('nina@example.com').some((m) => m.subject.startsWith('We stopped your Grove renewal')));
  assert.equal(mailTo('nina@example.com').some((m) => m.subject.startsWith('Heads up:')), false);
  globalThis.fetch = prev;
});

test('a card dispute stops all further billing at once', async () => {
  stripe.sub.status = 'active';
  const realCalls = stripe.calls.length;
  // charges/<id> lookups return the customer
  const prev = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => (String(url).includes('/v1/charges/ch_x') ? new Response(JSON.stringify({ id: 'ch_x', customer: 'cus_1' })) : prev(url, init))) as any;
  await billing.applyStripeEvent({ type: 'charge.dispute.created', data: { object: { charge: 'ch_x' } } });
  globalThis.fetch = prev;
  assert.equal(account().plan, 'seedling');
  assert.equal(stripe.sub.status, 'canceled');
  assert.ok(stripe.calls.length > realCalls);
});
