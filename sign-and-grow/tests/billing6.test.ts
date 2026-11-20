// Billing, sixth round: what the third skeptic pass on the payment code still found. Cancelling is decided from the
// provider's state and survives a failed call; a payment that was waiting when a plan was stopped never stays; a
// charge is never matched to one of ours by its amount alone; the provider's messages neither wait for ever nor hide
// one another; a refund the provider will not take ends with a person; free signatures count as used first; and the
// words on the Plan page and in the emails say what really happened.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { boot, Client, signUp, mailTo, type Server } from './helpers.ts';
import { stripe, unix } from './stripe-fake.ts';

let db: Server['db'];
let billing: Server['billing'];
let cron: Server['cron'];

const SECRET = 'whsec_round6';
const event = (type: string, object: any, extra: any = {}) => billing.applyStripeEvent({ type, data: { object }, ...extra });
const tryEvent = async (type: string, object: any, extra: any = {}) => {
  try {
    await event(type, object, extra);
    return 'ok';
  } catch (e: any) {
    return `failed: ${e?.message}`;
  }
};
// A message as the provider sends it: signed, to the public address.
async function deliver(id: string, type: string, object: any, extra: any = {}) {
  const body = JSON.stringify({ id, type, data: { object }, ...extra });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  const { handle } = await import('../src/server/router.ts');
  const res = await handle(new Request('http://test.local/api/stripe/webhook', { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' } }));
  return { status: res.status, data: await res.json().catch(() => null) };
}
const acct = (id: string) => db.get('SELECT * FROM accounts WHERE id=?', id);
const pay = (id: string) => db.get('SELECT * FROM payments WHERE id=?', id);
const inbox = () => db.all('SELECT id, tries, error FROM stripe_inbox ORDER BY at');
const alerts = () => db.all("SELECT message FROM support_requests WHERE topic='billing' ORDER BY rowid").map((r: any) => r.message as string);
const subjects = (email: string) => mailTo(email).map((m: any) => m.subject as string);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const lastMail = (email: string, re: RegExp) => {
  const m = mailTo(email).filter((x: any) => re.test(x.subject)).at(-1);
  return m ? text(m.html) : '';
};

type Person = { c: Client; id: string; name: string; email: string; cus: string; sub: string; k: number };
let n = 0;
async function person(first: string): Promise<Person> {
  const k = ++n;
  const email = `${first.toLowerCase()}${k}@six.example`;
  const name = `${first} Tester`;
  const c = await signUp(name, email, `198.51.106.${k}`);
  return { c, id: (await c.get('/me')).data.account.id, name, email, cus: `cus6_${k}`, sub: `sub6_${k}`, k };
}
function invoice(p: Person, inv: string, over: any = {}, charge: any = {}) {
  const o = {
    id: inv, customer: p.cus, subscription: p.sub, amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', hosted_invoice_url: `https://pay.example/${inv}`,
    lines: { data: [{ period: { start: unix(0), end: unix(30) }, metadata: { sg_account: p.id }, price: { id: 'price_grove' } }] }, ...over,
  };
  stripe.invoices[inv] = o;
  stripe.charges.unshift({ id: `ch_${inv}`, paid: true, refunded: false, amount: o.amount_paid, currency: o.currency, customer: o.customer, invoice: inv, last4: '4242', created: unix(0), ...charge });
  return o;
}
const renewal = (p: Person, inv: string, startU: number, over: any = {}, charge: any = {}) =>
  invoice(p, inv, { billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: startU, end: startU + 30 * 86400 }, metadata: { sg_account: p.id }, price: { id: 'price_grove' } }] }, ...over }, charge);
const checkout = (p: Person, over: any = {}) => ({ id: `cs6_${p.k}`, mode: 'subscription', client_reference_id: p.id, customer: p.cus, subscription: p.sub, payment_status: 'paid', ...over });
async function subscribe(p: Person, inv = `in6_${p.k}_1`) {
  Object.assign(stripe.sub(p.sub), { customer: p.cus, metadata: { sg_account: p.id } });
  await event('checkout.session.completed', checkout(p));
  await event('invoice.paid', invoice(p, inv));
}
const topUp = (p: Person, id: string, credits: number) => {
  stripe.charges.unshift({ id: `ch_${id}`, payment_intent: `pi_${id}`, paid: true, refunded: false, amount: credits * 100, currency: 'usd', customer: p.cus, last4: '4242', created: unix(0) });
  return { id, mode: 'payment', client_reference_id: p.id, customer: p.cus, payment_status: 'paid', amount_total: credits * 100, currency: 'usd', payment_intent: `pi_${id}`, metadata: { kind: 'sg_topup', credits: String(credits), sg_account: p.id } };
};
const state = async (p: Person) => (await p.c.get('/billing')).data;
const bal = async (p: Person) => (await state(p)).signatures.balance;
// Signatures used by people signing, written straight into the ledger: what matters here is only the count.
const useUp = (p: Person, k: number, tag: string) => {
  for (let i = 0; i < k; i++) db.run("INSERT INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,'signature',?,?)", p.id, -1, `${tag}-${i}|x@six.example`, new Date().toISOString());
};

before(async () => {
  ({ db, billing, cron } = await boot());
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});

test('cancelled on the provider page while a payment is failing: one failed call loses nothing, and that payment never stays', async () => {
  const fail = async (p: Person) => {
    await subscribe(p);
    const open = `in6_${p.k}_open`;
    stripe.invoices[open] = { id: open, customer: p.cus, subscription: p.sub, status: 'open', amount_due: 900, currency: 'usd', hosted_invoice_url: 'https://pay.example/open' };
    Object.assign(stripe.sub(p.sub), { status: 'past_due', latest_invoice: open, customer: p.cus });
    await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'past_due', current_period_end: unix(30), metadata: { sg_account: p.id } }, { id: `evt6_${p.k}_pd`, created: unix(0) });
    // The customer sets "cancel at the end of the period" on the provider's page. Ending it now fails once.
    stripe.sub(p.sub).cancel_at_period_end = true;
    stripe.fail('DELETE', /^subscriptions\//, 1);
    const msg = { id: p.sub, customer: p.cus, status: 'past_due', cancel_at_period_end: true, current_period_end: unix(30), metadata: { sg_account: p.id } };
    const first = await deliver(`evt6_${p.k}_cape`, 'customer.subscription.updated', msg, { created: unix(0) + 5 });
    assert.equal(first.status, 502, 'the provider is told it did not go through, so it sends the message again');
    // Nothing that only the provider's answer could settle is written down before it answered.
    assert.deepEqual([acct(p.id).plan, acct(p.id).subscription_status, acct(p.id).cancel_at], ['grove', 'past_due', null]);
    return { open, msg };
  };

  // The provider sends the message again: now the plan ends today, the failing payment is withdrawn, one email.
  const p = await person('Failing');
  const { open, msg } = await fail(p);
  const again = await deliver(`evt6_${p.k}_cape`, 'customer.subscription.updated', msg, { created: unix(0) + 5 });
  assert.equal(again.status, 200);
  assert.deepEqual([acct(p.id).plan, acct(p.id).subscription_status], ['seedling', 'canceled']);
  assert.equal(stripe.sub(p.sub).status, 'canceled');
  assert.equal(stripe.invoices[open].status, 'void');
  assert.equal(subjects(p.email).filter((s) => /plan is cancelled/.test(s)).length, 1);
  assert.match(lastMail(p.email, /plan is cancelled/), /Cancelled on the payment provider's page\. The last payment had not gone through, so the plan ends today/);
  // The timer finds nothing left to do, and the email is not sent twice.
  db.run('UPDATE stripe_inbox SET at=?, last_at=?', ago(0.1), ago(0.1));
  await cron.tick();
  assert.equal(subjects(p.email).filter((s) => /plan is cancelled/.test(s)).length, 1);
  // Paid anyway afterwards: it goes straight back and buys nothing.
  const had = await bal(p);
  await event('invoice.paid', renewal(p, open, unix(-2)), { id: `evt6_${p.k}_late` });
  assert.equal(stripe.refunded(`ch_${open}`), 900);
  assert.equal(await bal(p), had);

  // The failing payment goes through before our second try: it is refunded in full, the plan ends, and they are told.
  const q = await person('Retried');
  const qq = await fail(q);
  const before = await bal(q);
  await event('invoice.paid', renewal(q, qq.open, unix(-2)), { id: `evt6_${q.k}_paid` });
  assert.equal(stripe.refunded(`ch_${qq.open}`), 900, 'a payment taken after the plan was stopped is never kept');
  assert.equal(await bal(q), before, 'and it brings no signatures');
  assert.deepEqual([acct(q.id).plan, acct(q.id).subscription_status], ['seedling', 'canceled']);
  assert.equal(stripe.sub(q.sub).status, 'canceled');
  assert.match(lastMail(q.email, /plan has ended/), /had been stopped while a payment of \$9\.00 was still waiting\. That payment went through afterwards, so we are refunding it in full/);
  const s = await state(q);
  assert.equal(s.problem, null);
  // The provider's repeat of the cancel message changes nothing more.
  const n0 = mailTo(q.email).length;
  assert.equal((await deliver(`evt6_${q.k}_cape`, 'customer.subscription.updated', qq.msg, { created: unix(0) + 5 })).status, 200);
  assert.equal(mailTo(q.email).length, n0);
});

test('cancelling in the hour a new month starts: a lookup that fails does not turn into "already paid for", and the new month is not kept', async () => {
  const setUp = async (p: Person) => {
    await subscribe(p);
    const draft = `in6_${p.k}_draft`;
    stripe.invoices[draft] = { id: draft, customer: p.cus, subscription: p.sub, status: 'draft', amount_due: 900, currency: 'usd' };
    Object.assign(stripe.sub(p.sub), { status: 'active', current_period_end: unix(30), latest_invoice: draft, customer: p.cus });
    stripe.fail('GET', /^invoices\//, 1);
    const first = await p.c.post('/billing/cancel');
    assert.equal(first.status, 502);
    assert.match(first.data.error, /did not confirm the cancellation/);
    assert.equal(acct(p.id).cancel_at, null);
    return draft;
  };
  const echo = (p: Person, extra = 1) => ({ id: p.sub, customer: p.cus, status: 'active', cancel_at_period_end: true, current_period_end: unix(30), metadata: { sg_account: p.id } });

  // The provider's own message about the change it made is worked out like a press here, from its state now.
  const p = await person('Rollover');
  const draft = await setUp(p);
  await event('customer.subscription.updated', echo(p), { id: `evt6_${p.k}_echo`, created: unix(0) + 1 });
  assert.deepEqual([acct(p.id).plan, acct(p.id).subscription_status], ['seedling', 'canceled']);
  const mail = lastMail(p.email, /plan is cancelled/);
  assert.match(mail, /Cancelled in the app by Rollover Tester\. The payment for the new month had not been taken yet, so the plan ends today and that payment is withdrawn/);
  assert.doesNotMatch(mail, /payment provider's page/, 'a Cancel pressed here is not put down to the provider page');
  assert.notEqual(stripe.invoices[draft].status, 'draft');
  // Pressing again, as the error said, does not say "already paid for".
  const second = await p.c.post('/billing/cancel');
  assert.equal(second.status, 400);
  assert.doesNotMatch(JSON.stringify(second.data), /already paid for/);
  // Charged anyway: back it goes.
  await event('invoice.paid', renewal(p, draft, unix(0) - 3600), { id: `evt6_${p.k}_dp` });
  assert.equal(stripe.refunded(`ch_${draft}`), 900);

  // Two failures in a row: the echo cannot be worked out either, and the new month is charged before anything else
  // happens. It still goes back, because it was not paid when the provider confirmed the plan stops.
  const q = await person('Twice');
  const qd = await setUp(q);
  stripe.fail('GET', /^subscriptions\//, 1);
  assert.match(await tryEvent('customer.subscription.updated', echo(q), { id: `evt6_${q.k}_echo`, created: unix(0) + 1 }), /^failed/);
  assert.equal(acct(q.id).cancel_at, null);
  const had = await bal(q);
  await event('invoice.paid', renewal(q, qd, unix(0) - 3600), { id: `evt6_${q.k}_dp` });
  assert.equal(stripe.refunded(`ch_${qd}`), 900);
  assert.equal(await bal(q), had);
  assert.deepEqual([acct(q.id).plan, acct(q.id).subscription_status], ['seedling', 'canceled']);

  // Kept the plan after all ("Keep the plan after all" after a normal cancel): nothing of the stop is left over, so
  // the next month is kept as it should be.
  const r = await person('Kept');
  await subscribe(r);
  assert.equal((await r.c.post('/billing/cancel')).status, 200);
  assert.equal((await r.c.post('/billing/resume')).status, 200);
  const before = await bal(r);
  await event('invoice.paid', renewal(r, `in6_${r.k}_2`, unix(0)));
  assert.equal(stripe.refunded(`ch_in6_${r.k}_2`), 0);
  assert.equal(await bal(r), before + 9);
});

test('a subscription draft that the provider will not delete is told never to go ahead by itself', async () => {
  const p = await person('Draft');
  await subscribe(p);
  const draft = `in6_${p.k}_d`;
  stripe.invoices[draft] = { id: draft, customer: p.cus, subscription: p.sub, status: 'draft', amount_due: 900, currency: 'usd' };
  Object.assign(stripe.sub(p.sub), { status: 'active', latest_invoice: draft, customer: p.cus });
  stripe.fail('DELETE', /^invoices\//, 1, 'You can only delete draft invoices that are not attached to a subscription.', 400);
  const r = await p.c.post('/billing/cancel');
  assert.deepEqual([r.status, r.data.ended_now, r.data.why], [200, true, 'not_taken']);
  assert.ok(stripe.calls.some(([m, path, params]) => m === 'POST' && path === `invoices/${draft}` && params.auto_advance === 'false'));
});

test('a refund or a dispute of a charge that may be another product\'s never touches our customer: a person decides', async () => {
  const p = await person('Shared');
  await subscribe(p);
  const inv = `in6_${p.k}_1`;
  // Applied while the provider could not be asked for the charge, or from before charges were kept.
  db.run('UPDATE payments SET charge_id=NULL WHERE id=?', inv);
  const seen = alerts().length;
  await event('charge.refunded', { id: 'ch6_foreign_rf', customer: p.cus, amount: 900, amount_refunded: 900, currency: 'usd', created: unix(0) }, { id: 'evt6_foreign_rf' });
  assert.equal(pay(inv).refunded_cents, 0);
  assert.equal(await bal(p), 12);
  assert.match(alerts().slice(seen).join('\n'), /A refund at the payment provider could not be matched to a payment for sure[\s\S]*ch6_foreign_rf/);

  stripe.charges.unshift({ id: 'ch6_foreign_dsp', paid: true, refunded: false, amount: 900, currency: 'usd', customer: p.cus, invoice: null, created: unix(0) });
  await event('charge.dispute.created', { id: 'dp6_foreign', charge: 'ch6_foreign_dsp', amount: 900 }, { id: 'evt6_foreign_dsp' });
  assert.equal(stripe.disputesClosed.includes('dp6_foreign'), false, 'nobody else\'s dispute is conceded');
  assert.deepEqual([acct(p.id).plan, acct(p.id).dispute_at, stripe.sub(p.sub).status], ['grove', null, 'active']);
  assert.equal(await bal(p), 12);
  assert.equal((await p.c.post('/billing/topup', { quantity: 2 })).status, 200, 'payments are not switched off');
  assert.doesNotMatch(subjects(p.email).join('|'), /disputed/);
  assert.match(alerts().slice(seen).join('\n'), /A card dispute could not be matched to a payment for sure[\s\S]*dp6_foreign/);

  // When the provider confirms the charge is this payment's own, a refund made by hand is matched as before.
  stripe.invoices[inv].payment_intent = 'pi6_ours';
  await event('charge.refunded', { id: 'ch6_ours', payment_intent: 'pi6_ours', customer: p.cus, amount: 900, amount_refunded: 900, currency: 'usd', created: unix(0) }, { id: 'evt6_ours_rf' });
  assert.equal(pay(inv).refunded_cents, 900);
  assert.equal(pay(inv).charge_id, 'pi6_ours');
  assert.equal(await bal(p), 3);
});

test('a refund made by hand at the provider is told to the customer: how many signatures went, and why', async () => {
  const p = await person('Dash');
  await subscribe(p);
  const ch = stripe.refundByHand(`ch_in6_${p.k}_1`, 900);
  await event('charge.refunded', ch, { id: `evt6_${p.k}_hand` });
  assert.equal(await bal(p), 3);
  const mail = lastMail(p.email, /^Refund sent: \$9\.00/);
  assert.match(mail, /\$9\.00 of your monthly plan payment of \$9\.00 from .+ was refunded to the card it was paid with\. It was sent by a person here/);
  assert.match(mail, /Signatures follow the money, so the 9 signatures it paid for went with it: 9 signatures left your balance\. You have 3 signatures to send now/);
  assert.match(mail, /Your monthly plan is not affected and continues: it renews on/);
});

test('the bank\'s decision on a dispute waits for the dispute itself, and is found by the charge alone', async () => {
  // The message that opens the dispute fails once; the decision arrives first. It waits, and the timer applies both
  // in the order they happened.
  const p = await person('Order');
  await subscribe(p);
  await event('checkout.session.completed', topUp(p, `cs6_${p.k}_top`, 100));
  assert.equal(await bal(p), 112);
  stripe.fail('GET', /^charges\//, 1);
  const opened = await deliver(`evt6_${p.k}_dc`, 'charge.dispute.created', { id: `dp6_${p.k}`, charge: `ch_cs6_${p.k}_top`, payment_intent: `pi_cs6_${p.k}_top`, amount: 10000 });
  assert.equal(opened.status, 502);
  const decided = await deliver(`evt6_${p.k}_dw`, 'charge.dispute.closed', { id: `dp6_${p.k}`, charge: `ch_cs6_${p.k}_top`, payment_intent: `pi_cs6_${p.k}_top`, amount: 10000, status: 'won' });
  assert.equal(decided.status, 502, 'the decision is not thrown away');
  assert.equal(inbox().length, 2);
  db.run('UPDATE stripe_inbox SET at=?, last_at=?', ago(0.1), ago(0.1));
  await cron.tick();
  assert.deepEqual(inbox(), []);
  assert.equal(pay(`cs6_${p.k}_top`).disputed, 'won');
  assert.equal(await bal(p), 112, 'the payment stands, so its signatures are back');
  assert.deepEqual(subjects(p.email).slice(-2), ['A payment was disputed, so we stopped billing you', 'The disputed payment stands']);

  // A decision that names only the charge, for a top-up we know by its payment.
  const q = await person('Bycharge');
  await subscribe(q);
  await event('checkout.session.completed', topUp(q, `cs6_${q.k}_top`, 100));
  await event('charge.dispute.created', { id: `dp6_${q.k}`, charge: `ch_cs6_${q.k}_top`, amount: 10000 }, { id: `evt6_${q.k}_dc` });
  assert.equal(await bal(q), 12);
  await event('charge.dispute.closed', { id: `dp6_${q.k}`, charge: `ch_cs6_${q.k}_top`, amount: 10000, status: 'won' }, { id: `evt6_${q.k}_dw` });
  assert.equal(pay(`cs6_${q.k}_top`).disputed, 'won');
  assert.equal(await bal(q), 112);
});

test('messages waiting out their gap never hide a newer one from the timer', async () => {
  const p = await person('Jam');
  await event('checkout.session.completed', checkout(p));
  Object.assign(stripe.sub(p.sub), { customer: p.cus });
  for (let i = 0; i < 100; i++) {
    const body = JSON.stringify({ id: `evt6_stuck_${i}`, type: 'invoice.paid', data: { object: { id: `in6_stuck_${i}` } } });
    db.run('INSERT INTO stripe_inbox (id, body, at, tries, last_at, error) VALUES (?,?,?,?,?,?)', `evt6_stuck_${i}`, body, ago(1 - i / 1000), 8, new Date(Date.now() - 10 * 60_000).toISOString(), 'still failing');
  }
  const good = { id: `evt6_${p.k}_good`, type: 'invoice.paid', data: { object: invoice(p, `in6_${p.k}_1`) } };
  db.run('INSERT INTO stripe_inbox (id, body, at, tries, last_at, error) VALUES (?,?,?,?,?,?)', good.id, JSON.stringify(good), ago(0.5), 1, ago(0.4), 'The payment provider is having trouble.');
  await cron.tick();
  assert.ok(!db.get('SELECT 1 x FROM stripe_inbox WHERE id=?', good.id), 'applied at the first run');
  assert.equal(await bal(p), 12);
  assert.equal(db.get("SELECT COUNT(*) n FROM stripe_inbox WHERE id LIKE 'evt6_stuck_%'").n, 100, 'the others wait out their gap');
  db.run("DELETE FROM stripe_inbox WHERE id LIKE 'evt6_stuck_%'");
});

test('a message moved from one account\'s queue to another and back does not wait for ever, and neither does the timer', async () => {
  process.env.STRIPE_WEBHOOK_WAIT_MS = '200';
  try {
    const p = await person('Loop');
    await subscribe(p);
    const own = acct(p.id).stripe_customer_id;
    stripe.delayMs = 300;
    // A message for a provider customer nobody here has yet waits in that customer's queue, a refund notice behind it.
    const slowFirst = tryEvent('invoice.paid', { id: 'in6_loop_x', customer: 'cus6_loop', subscription: 'sub6_loop', amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', lines: { data: [{ period: { start: unix(0), end: unix(30) }, price: { id: 'price_grove' } }] } }, { id: 'evt6_loop_1' });
    await sleep(10);
    const notice = deliver('evt6_loop_2', 'charge.refunded', { id: 'ch6_loop', customer: 'cus6_loop', amount: 900, amount_refunded: 900 });
    await sleep(5);
    // The account becomes that customer's (the notice moves to the account's queue at its turn) ...
    db.run('UPDATE accounts SET stripe_customer_id=? WHERE id=?', 'cus6_loop', p.id);
    const busy = tryEvent('invoice.paid', renewal(p, `in6_${p.k}_2`, unix(0)), { id: `evt6_${p.k}_ren` });
    await sleep(450);
    // ... and back again before it gets its turn there.
    db.run('UPDATE accounts SET stripe_customer_id=? WHERE id=?', own, p.id);
    const within = <T>(pr: Promise<T>, ms: number) => Promise.race([pr.then(() => 'finished'), sleep(ms).then(() => 'still waiting')]);
    assert.deepEqual(await Promise.all([within(slowFirst, 8000), within(notice, 8000), within(busy, 8000)]), ['finished', 'finished', 'finished']);
    stripe.delayMs = 0;
    for (let i = 0; i < 60 && inbox().some((r: any) => r.id === 'evt6_loop_2'); i++) await sleep(50);
    assert.equal(await within(p.c.post('/billing/cancel'), 3000), 'finished', 'the account\'s own Cancel is not stuck behind it');
    // And the timer always finishes its run.
    db.run('UPDATE stripe_inbox SET at=?', ago(0.01));
    assert.equal(await within(cron.tick(), 6000), 'finished');
  } finally {
    stripe.delayMs = 0;
    delete process.env.STRIPE_WEBHOOK_WAIT_MS;
  }
});

test('a refund we owe that the provider refuses three times needs a person: the customer is told once, the page says so', async () => {
  const p = await person('Nofind');
  await subscribe(p);
  assert.equal((await p.c.post('/billing/cancel')).status, 200);
  stripe.sub(p.sub).status = 'canceled';
  await event('customer.subscription.deleted', { id: p.sub, customer: p.cus, status: 'canceled' }, { created: unix(0) + 2 });
  // Charged after cancelling, and the card charge cannot be found by the software (its amount does not match).
  const inv = 'in6_ghost';
  await event('invoice.paid', renewal(p, inv, unix(0), {}, { amount: 901 }));
  let s = await state(p);
  assert.equal(s.refunds_pending.length, 1);
  assert.deepEqual([s.refunds_pending[0].auto, s.refunds_pending[0].why, s.refunds_pending[0].by_hand], [true, 'you were charged after the plan was cancelled', false]);
  const seen = alerts().length;
  for (let i = 0; i < 6; i++) {
    db.run("UPDATE refunds SET last_at=? WHERE status='pending'", ago(1));
    await cron.tick();
  }
  const r = db.get('SELECT status, refused FROM refunds WHERE payment_id=?', inv);
  assert.deepEqual([r.status, r.refused], ['manual', 3], 'the third clear no ends the automatic tries');
  assert.equal(subjects(p.email).filter((x) => /A person will send your refund of \$9\.00/.test(x)).length, 1, 'told once');
  assert.match(lastMail(p.email, /A person will send your refund/), /We owe you a refund of \$9\.00: you were charged after the plan was cancelled\. The payment provider would not send it automatically, so a person here will send it to the card by hand/);
  assert.equal(alerts().slice(seen).filter((m) => /needs a person/.test(m)).length, 1);
  assert.equal(alerts().slice(seen).filter((m) => /has not gone through yet/.test(m)).length, 0, 'no daily alerts once a person has it');
  s = await state(p);
  assert.deepEqual([s.refunds_pending.length, s.refunds_pending[0].by_hand], [1, true]);
  // The person sends it by hand: it is recorded, and the customer gets the usual email.
  const ch = stripe.refundByHand(`ch_${inv}`, 901);
  await event('charge.refunded', ch, { id: 'evt6_ghost_hand' });
  assert.equal(db.get('SELECT status FROM refunds WHERE payment_id=?', inv).status, 'done');
  assert.match(lastMail(p.email, /^Refund sent/), /We refunded \$9\.00 to the card it was paid with \(you were charged after the plan was cancelled\)\. It was sent by a person here/);
  assert.deepEqual((await state(p)).refunds_pending, []);
});

test('free signatures count as used first, so a code never makes a used-up payment refundable again', async () => {
  // Paid $9 (3 welcome + 9), every signature used, then the free code: 9 free ones arrive. Nothing to refund.
  const p = await person('Coded');
  await subscribe(p);
  useUp(p, 12, 'p');
  assert.equal((await state(p)).refund, null);
  assert.equal((await p.c.post('/billing/redeem', { code: 'GROWalition' })).status, 200);
  assert.equal(await bal(p), 9);
  let s = await state(p);
  assert.equal(s.refund, null);
  assert.equal(s.payments.find((x: any) => x.id === `in6_${p.k}_1`).refundable, null);
  assert.equal((await p.c.post('/billing/refund')).status, 400);

  // The welcome signatures are the first ones used: three used out of twelve leaves the whole payment refundable.
  const q = await person('Welcome');
  await subscribe(q);
  useUp(q, 3, 'q');
  s = await state(q);
  assert.deepEqual([s.refund.amount, s.refund.signatures], ['$9.00', 9]);
  // With the code on top, the paid ones that are left are still refundable, and only those.
  useUp(q, 4, 'q2');
  assert.equal((await q.c.post('/billing/redeem', { code: 'GROWalition' })).status, 200);
  s = await state(q);
  assert.equal(s.signatures.available, 14);
  const offer = s.payments.find((x: any) => x.id === `in6_${q.k}_1`).refundable;
  assert.deepEqual([offer.amount, offer.signatures], ['$5.00', 5]);
  assert.match(offer.reason, /free signatures, the ones every new account gets and any from a code, count as used first/);
});

test('a first invoice of $0 is said in the welcome: that month brought no signatures, and why', async () => {
  const p = await person('Zero');
  Object.assign(stripe.sub(p.sub), { customer: p.cus, metadata: { sg_account: p.id } });
  const inv = `in6_${p.k}_zero`;
  invoice(p, inv, { amount_paid: 0 });
  await event('checkout.session.completed', checkout(p, { invoice: inv }));
  await event('invoice.paid', stripe.invoices[inv]);
  assert.equal(await bal(p), 3);
  const mail = lastMail(p.email, /^Welcome/);
  assert.match(mail, /Your first invoice came to \$0\.00, so this first month brought no signatures\. Signatures are added only for what is paid/);
  // An ordinary first payment says nothing of the kind.
  const q = await person('Paid');
  await subscribe(q);
  assert.doesNotMatch(lastMail(q.email, /^Welcome/), /brought no signatures/);
});

test('the plan history says a reminder was sent only when its email left', async () => {
  const p = await person('Late');
  await subscribe(p);
  db.run('UPDATE accounts SET renews_at=? WHERE id=?', new Date(Date.now() + 20 * 3600_000).toISOString(), p.id);
  process.env.SMTP_URL = 'smtp://127.0.0.1:1';
  (globalThis as any).__tsmail = undefined;
  try {
    await cron.tick();
  } finally {
    delete process.env.SMTP_URL;
    (globalThis as any).__tsmail = undefined;
  }
  const h = (await state(p)).history.filter((x: any) => /reminder/.test(x.what));
  assert.equal(h.length, 1);
  assert.equal(h[0].label, 'Renewal reminder could not be delivered');
  assert.match(h[0].detail, /About a day before: \$9\.00\. The mail server did not take it/);
  // One that left is "sent".
  const q = await person('Ontime');
  await subscribe(q);
  db.run('UPDATE accounts SET renews_at=? WHERE id=?', new Date(Date.now() + 20 * 3600_000).toISOString(), q.id);
  await cron.tick();
  assert.deepEqual((await state(q)).history.filter((x: any) => /reminder/.test(x.what)).map((x: any) => x.label), ['Renewal reminder sent']);
});

test('the provider\'s early notice of a renewal is remembered, so a change in tax is said before the charge', async () => {
  const p = await person('Tax');
  Object.assign(stripe.sub(p.sub), { customer: p.cus, metadata: { sg_account: p.id } });
  await event('checkout.session.completed', checkout(p));
  await event('invoice.paid', invoice(p, `in6_${p.k}_1`, { amount_paid: 972, tax: 72 }));
  assert.equal((await state(p)).next_amount, '$9.72');
  const when = new Date(Date.now() + 10 * 864e5).toISOString();
  db.run('UPDATE accounts SET renews_at=? WHERE id=?', when, p.id);
  // Ten days ahead the provider says $9.90: the tax went up.
  await event('invoice.upcoming', { customer: p.cus, subscription: p.sub, amount_due: 990, tax: 90, currency: 'usd', next_payment_attempt: Math.floor(Date.parse(when) / 1000) });
  assert.equal((await state(p)).next_amount, '$9.90');
  const soon = new Date(Date.now() + 6 * 864e5).toISOString();
  db.run('UPDATE accounts SET renews_at=? WHERE id=?', soon, p.id);
  await cron.tick();
  assert.match(subjects(p.email).filter((x) => /^Heads up/.test(x)).join('|'), /for \$9\.90/);
  await event('invoice.paid', renewal(p, `in6_${p.k}_2`, Math.floor(Date.parse(soon) / 1000), { amount_paid: 990, tax: 90 }));
  assert.equal(stripe.refunded(`ch_in6_${p.k}_2`), 0, 'nothing to send back: the amount was the one we said');
});

test('an invoice that names no subscription goes to the account its subscription names, also when two accounts share a provider customer', async () => {
  const p = await person('Mine');
  const q = await person('Theirs');
  await subscribe(q);
  await event('checkout.session.completed', checkout(p, { customer: q.cus, subscription: `sub6_${p.k}` }));
  await event('invoice.paid', invoice(p, `in6_${p.k}_1`, { customer: q.cus, subscription: `sub6_${p.k}` }));
  db.run("UPDATE accounts SET plan='seedling', subscription_status='canceled', stripe_customer_id=? WHERE id=?", q.cus, p.id);
  Object.assign(stripe.sub(q.sub), { customer: q.cus, status: 'active', metadata: { sg_account: q.id } });
  Object.assign(stripe.sub(`sub6_${p.k}`), { customer: q.cus, status: 'canceled' });
  const was = await bal(q);
  await event('invoice.paid', invoice(q, `in6_${q.k}_2`, { subscription: undefined, billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: unix(0), end: unix(30) }, price: { id: 'price_grove' } }] } }));
  assert.equal(pay(`in6_${q.k}_2`).account_id, q.id);
  assert.equal(await bal(q), was + 9);
  assert.deepEqual([acct(p.id).plan, acct(p.id).stripe_subscription_id], ['seedling', `sub6_${p.k}`]);
  assert.equal(stripe.refunded(`ch_in6_${q.k}_2`), 0);
});

test('on hold, the words say what brings top-ups back; paying the open payment says nothing that is not so', async () => {
  const h = await person('Hold');
  await subscribe(h);
  const open = `in6_${h.k}_open`;
  stripe.invoices[open] = { id: open, customer: h.cus, subscription: h.sub, status: 'open', amount_due: 900, amount_remaining: 900, currency: 'usd', hosted_invoice_url: 'https://pay.example/invoice/hold' };
  Object.assign(stripe.sub(h.sub), { status: 'unpaid', latest_invoice: open, customer: h.cus });
  await event('customer.subscription.updated', { id: h.sub, customer: h.cus, status: 'unpaid', current_period_end: unix(30), metadata: { sg_account: h.id } }, { created: unix(0) + 10 });
  const top = await h.c.post('/billing/topup', { quantity: 3 });
  assert.equal(top.status, 400);
  assert.match(top.data.error, /Pay the open payment/);
  assert.doesNotMatch(top.data.error, /Update the card/);
  // Some dunning settings mark the payment "uncollectible" instead of leaving it open: it can still be paid there.
  stripe.invoices[open].status = 'uncollectible';
  assert.deepEqual((await h.c.post('/billing/pay-open')).data, { url: 'https://pay.example/invoice/hold', amount: '$9.00' });
  // The provider cannot be reached: said in plain words.
  stripe.fail('GET', /^subscriptions\//, 1);
  const down = await h.c.post('/billing/pay-open');
  assert.equal(down.status, 502);
  assert.match(down.data.error, /could not reach the payment provider just now, so the open payment could not be opened\. Nothing was charged/);
  // Nothing failing at all: not "any more", because nothing was open before.
  const p = await person('Calm');
  await subscribe(p);
  const calm = await p.c.post('/billing/pay-open');
  assert.equal(calm.status, 409);
  assert.equal(calm.data.error, 'Nothing is waiting to be paid on this plan: its last payment went through.');
});

test('a mail server that takes the connection and then says nothing is given up on in seconds, not minutes', async () => {
  const silent = net.createServer(() => {}); // accepts and never greets
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
  const port = (silent.address() as net.AddressInfo).port;
  const { sendMail } = await import('../src/server/mail.ts');
  process.env.SMTP_URL = `smtp://127.0.0.1:${port}`;
  (globalThis as any).__tsmail = undefined;
  const started = Date.now();
  try {
    const how = await sendMail({ to: 'nobody6@six.example', subject: 'Silent server', heading: 'x', lines: ['x'] });
    assert.equal(how, 'failed');
    assert.ok(Date.now() - started < 15_000, `gave up after ${Date.now() - started} ms`);
  } finally {
    delete process.env.SMTP_URL;
    (globalThis as any).__tsmail = undefined;
    silent.close();
  }
});

test('what the Plan page and the help page promise about these cases is what the code does', () => {
  const page = readFileSync(new URL('../src/app/app/settings/page.tsx', import.meta.url), 'utf8');
  // The cancel confirmation is brought into view, as for a refund and a removed card.
  assert.match(page, /setDone\(\{ kind: 'cancel', \.\.\.r \}\); setModal\(''\); window\.scrollTo\(\{ top: 0 \}\);/);
  // A refund the software owes is never shown as one the customer asked for, and one that needs a person says so.
  assert.match(page, /r\.by_hand \?[\s\S]*We owe you a refund of[\s\S]*a person here will send it to your card by hand[\s\S]*: r\.auto \?[\s\S]*We owe you a refund of/);
  // The refund dialog does not end a plan that has already ended.
  assert.match(page, /\(grove \|\| b\.problem\) \? ' Because this was a monthly payment, the monthly plan ends first, today\. Nothing is deleted\.' : ' Your monthly plan has already ended, so nothing else changes\.'/);
  // On hold, a new card is not said to bring top-ups back.
  assert.doesNotMatch(page, /Update the card above and you can top up again/);
  // A dispute we do not concede sets the signatures aside; the rule says so.
  assert.doesNotMatch(page, /go back with the money/);
  assert.match(page, /are set aside: they leave with the money if it goes back to the card, and come back if the bank decides the payment stands/);
  assert.doesNotMatch(page, /keeps trying until the refund has gone through\./);
  const help = readFileSync(new URL('../src/app/help/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(help, /refunds it by itself and keeps trying until the refund has gone through\.<\/p>/);
  assert.match(help, /a person here sends it by hand and we tell you so/);
});
