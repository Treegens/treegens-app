// Billing under stress, against a simulated payment provider: messages out of order, the provider failing half way,
// two requests at the same moment, replays, and the corners of the free code. Each test here is a bug an independent
// audit found in the first version (research/audit-1.json), written so that it fails without the fix.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, simple, signUp, signAll, mailTo, tokenFor, type Server } from './helpers.ts';
import { stripe, unix } from './stripe-fake.ts';

let db: Server['db'];
let billing: Server['billing'];
let cron: Server['cron'];

const event = (type: string, object: any, extra: any = {}) => billing.applyStripeEvent({ type, data: { object }, ...extra });
const acct = (id: string) => db.get('SELECT * FROM accounts WHERE id=?', id);
const pay = (id: string) => db.get('SELECT * FROM payments WHERE id=?', id);
const subjects = (email: string) => mailTo(email).map((m) => m.subject);
const alerts = () => db.all("SELECT message FROM support_requests WHERE topic='billing' ORDER BY rowid").map((r: any) => r.message as string);

// A fresh customer with ids of their own, so the tests do not lean on each other.
type Person = { c: Client; id: string; email: string; cus: string; sub: string; k: number };
let n = 0;
async function person(name: string): Promise<Person> {
  const k = ++n;
  const email = `${name.toLowerCase()}${k}@example.com`;
  const c = await signUp(`${name} Tester`, email, `198.51.100.${k}`);
  return { c, id: (await c.get('/me')).data.account.id, email, cus: `cus_${k}`, sub: `sub_${k}`, k };
}
function invoice(p: Person, inv: string, over: any = {}) {
  const o = {
    id: inv, customer: p.cus, subscription: p.sub, amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', hosted_invoice_url: `https://pay.example/${inv}`,
    lines: { data: [{ period: { start: unix(0), end: unix(30) }, metadata: { sg_account: p.id } }] }, ...over,
  };
  stripe.invoices[inv] = o;
  stripe.charges.unshift({ id: `ch_${inv}`, paid: true, refunded: false, amount: o.amount_paid, currency: 'usd', customer: o.customer, invoice: inv, last4: '4242', created: unix(0) });
  return o;
}
const checkout = (p: Person, over: any = {}) => ({ id: `cs_${p.k}`, mode: 'subscription', client_reference_id: p.id, customer: p.cus, subscription: p.sub, payment_status: 'paid', ...over });
async function subscribe(p: Person, inv = `in_${p.k}_1`) {
  await event('checkout.session.completed', checkout(p));
  await event('invoice.paid', invoice(p, inv));
}
const topUp = (p: Person, sid: string, credits: number, over: any = {}) => {
  stripe.charges.unshift({ id: `ch_${sid}`, payment_intent: `pi_${sid}`, paid: true, refunded: false, amount: credits * 100, customer: p.cus, last4: '4242', created: unix(0) });
  return { id: sid, mode: 'payment', client_reference_id: p.id, customer: p.cus, payment_status: 'paid', amount_total: credits * 100, currency: 'usd', payment_intent: `pi_${sid}`, metadata: { kind: 'sg_topup', credits: String(credits), sg_account: p.id }, ...over };
};
const bal = async (p: Person) => (await p.c.get('/billing')).data.signatures;
const state = async (p: Person) => (await p.c.get('/billing')).data;

before(async () => {
  ({ db, billing, cron } = await boot());
});

test('the first payment counts whichever message the provider sends first', async () => {
  // The paid invoice is reported before the finished checkout, and it names the account it is for.
  const a = await person('Ann');
  await event('invoice.paid', invoice(a, 'in_a1'));
  assert.equal(acct(a.id).plan, 'grove');
  assert.deepEqual(await bal(a), { balance: 12, held: 0, available: 12 });
  assert.deepEqual(subjects(a.email).filter((s) => /Welcome|Receipt/.test(s)), ['Welcome to Grove', 'Receipt: $9.00 for 9 signatures']);
  await event('checkout.session.completed', checkout(a));
  await event('invoice.paid', stripe.invoices.in_a1);
  assert.equal((await bal(a)).balance, 12, 'nothing doubles when the rest arrives');
  assert.equal(subjects(a.email).filter((s) => s === 'Welcome to Grove').length, 1);

  // The same, for an invoice that does not say whose it is. It waits, a person is told, and it is picked up the
  // moment the checkout is reported.
  const b = await person('Bob');
  await event('invoice.paid', invoice(b, 'in_b1', { lines: { data: [{ period: { start: unix(0), end: unix(30) }, price: { id: 'price_grove' } }] } }));
  assert.equal(acct(b.id).plan, 'seedling');
  assert.ok(alerts().some((m) => m.includes('in_b1') && m.includes('could not be matched')), 'somebody is told even with no support address set');
  await event('checkout.session.completed', checkout(b));
  assert.equal(acct(b.id).plan, 'grove');
  assert.equal((await bal(b)).balance, 12);
  assert.ok(subjects(b.email).includes('Receipt: $9.00 for 9 signatures'));
  assert.equal(pay('in_b1').account_id, b.id);

  // Coming back from checkout before any message at all: the plan and its signatures are there at once.
  const c = await person('Cy');
  invoice(c, 'in_c1');
  stripe.sessions[`cs_${c.k}`] = checkout(c, { invoice: 'in_c1' });
  const back = await c.c.post('/billing/sync', { session_id: `cs_${c.k}` });
  assert.equal(back.data.applied, 'plan');
  assert.equal(back.data.signatures.balance, 12, '9 signatures straight away');
  await event('checkout.session.completed', checkout(c, { invoice: 'in_c1' }));
  await event('invoice.paid', stripe.invoices.in_c1);
  assert.equal((await bal(c)).balance, 12);
  assert.equal(subjects(c.email).filter((s) => s.startsWith('Receipt')).length, 1);

  // A session that was never paid, or does not exist, applies nothing and says so.
  stripe.sessions.cs_unpaid = checkout(await person('Una'), { id: 'cs_unpaid', payment_status: 'unpaid' });
  assert.equal((await c.c.post('/billing/sync', { session_id: 'cs_never_existed' })).data.applied, null);
});

test('coming back after cancelling: the new plan is not mistaken for the old one, and old messages change nothing', async () => {
  const p = await person('Rita');
  await subscribe(p);
  await p.c.post('/billing/cancel');
  await event('customer.subscription.deleted', { id: p.sub, customer: p.cus, status: 'canceled' });
  stripe.sub(p.sub).status = 'canceled';
  assert.equal(acct(p.id).plan, 'seedling');
  const kept = (await bal(p)).balance;

  // She subscribes again, and the paid invoice of the new subscription is reported first.
  const again = { ...p, sub: 'sub_rita_new' };
  await event('invoice.paid', invoice(again, 'in_r2'));
  assert.equal(acct(p.id).plan, 'grove');
  assert.equal(acct(p.id).stripe_subscription_id, 'sub_rita_new');
  assert.equal((await bal(p)).balance, kept + 9);
  assert.equal(subjects(p.email).some((s) => s.startsWith('Refund sent')), false, 'the new payment is not refunded as "already cancelled"');

  // A late message about the old subscription does not end the new plan.
  const ended = subjects(p.email).filter((s) => s === 'Your monthly plan has ended').length;
  await event('customer.subscription.deleted', { id: p.sub, customer: p.cus, status: 'canceled' });
  await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'canceled' });
  assert.equal(acct(p.id).plan, 'grove');
  assert.equal(subjects(p.email).filter((s) => s === 'Your monthly plan has ended').length, ended);

  // An older message about the current subscription does not undo a newer one.
  await event('customer.subscription.updated', { id: 'sub_rita_new', customer: p.cus, status: 'active', cancel_at_period_end: true, current_period_end: unix(30) }, { created: unix(0) });
  assert.ok(acct(p.id).cancel_at);
  await event('customer.subscription.updated', { id: 'sub_rita_new', customer: p.cus, status: 'active', cancel_at_period_end: false, current_period_end: unix(30) }, { created: unix(-1) });
  assert.ok(acct(p.id).cancel_at, 'still set to end');

  // The provider repeating one message applies it once.
  const q = await person('Quin');
  stripe.sessions[`cs_${q.k}`] = checkout(q);
  await subscribe(q);
  const upcoming = { type: 'invoice.upcoming', id: 'evt_same', data: { object: { customer: q.cus, amount_due: 900, currency: 'usd', next_payment_attempt: unix(3) } } };
  await billing.applyStripeEvent(upcoming);
  await billing.applyStripeEvent(upcoming);
  assert.equal(subjects(q.email).filter((s) => s.startsWith('Heads up')).length, 1);

  // An old checkout link replayed does not bring a dead plan back.
  assert.equal((await q.c.post('/billing/refund')).data.plan_ended, true);
  assert.equal(acct(q.id).plan, 'seedling');
  const replay = await q.c.post('/billing/sync', { session_id: `cs_${q.k}` });
  assert.equal(replay.data.applied, null);
  assert.equal(acct(q.id).plan, 'seedling');
  await event('checkout.session.completed', checkout(q));
  assert.equal(acct(q.id).plan, 'seedling');
  assert.equal((await q.c.post('/billing/topup', { quantity: 5 })).status, 400);
  assert.equal(subjects(q.email).filter((s) => s === 'Welcome to Grove').length, 1);

  // Two live subscriptions for one account: the second is ended and its payment sent back.
  const d = await person('Dup');
  await subscribe(d);
  const second = { ...d, sub: 'sub_dup_2' };
  await event('checkout.session.completed', checkout(second, { id: 'cs_dup2' }));
  assert.equal(stripe.sub('sub_dup_2').status, 'canceled');
  assert.equal(acct(d.id).stripe_subscription_id, d.sub);
  await event('invoice.paid', invoice(second, 'in_dup2'));
  assert.equal(pay('in_dup2').refunded_cents, 900);
  assert.equal((await bal(d)).balance, 12, 'no signatures for money that went back');
});

test('two refund requests at the same moment pay out once', async () => {
  const p = await person('Dee');
  await subscribe(p);
  stripe.delayMs = 15;
  const both = await Promise.all([p.c.post('/billing/refund'), p.c.post('/billing/refund')]);
  stripe.delayMs = 0;
  assert.equal(both.filter((r) => r.status === 200).length, 1, JSON.stringify(both.map((r) => r.data)));
  assert.equal(stripe.refunded(`ch_in_${p.k}_1`), 900);
  assert.equal(stripe.refunds.filter((r) => r.params.charge === `ch_in_${p.k}_1`).length, 1);
  assert.ok(stripe.refunds.at(-1)!.key, 'the provider is given a key for this exact refund, so a retry cannot pay twice');
  assert.equal((await bal(p)).balance, 3);
  assert.equal(subjects(p.email).filter((s) => s.startsWith('Refund sent')).length, 1);
  assert.equal((await p.c.post('/billing/refund')).status, 400, 'and not a second time afterwards either');
});

test('any payment inside the window can be refunded, not only the latest', async () => {
  const p = await person('Kay');
  await subscribe(p);
  await event('checkout.session.completed', topUp(p, 'cs_kay_top', 4));
  let s = await state(p);
  assert.equal(s.refund.payment_id, 'cs_kay_top', 'the latest payment is offered up front');
  assert.deepEqual(s.payments.map((x: any) => x.refundable?.amount), ['$4.00', '$9.00'], 'and every payment in the list says what it can give back');
  assert.match(mailTo(p.email).find((m) => m.subject.startsWith('Receipt: $4.00'))!.html, /refunded in full within 30 days of the payment that bought them/);

  assert.equal((await p.c.post('/billing/refund')).data.refunded, '$4.00');
  assert.equal((await p.c.post('/billing/refund')).status, 400, 'the plain button never moves on to an older payment by itself');
  const stranger = await person('Sly');
  assert.equal((await stranger.c.post('/billing/refund', { payment_id: `in_${p.k}_1` })).status, 400, "somebody else's payment is not theirs to refund");
  const older = await p.c.post('/billing/refund', { payment_id: `in_${p.k}_1` });
  assert.equal(older.data.refunded, '$9.00');
  assert.equal(older.data.plan_ended, true);
  s = await state(p);
  assert.equal(s.signatures.balance, 3);
  assert.equal(s.refund, null);
  assert.ok(s.history.some((h: any) => h.label === 'Refund sent' && h.ref), 'each refund is in the plan history with its reference');
});

test('when the payment provider fails, nothing is claimed that did not happen', async () => {
  // Refunding a monthly payment ends the plan first. If the provider will not end it, nothing moves.
  const p = await person('Eve');
  await subscribe(p);
  stripe.fail('DELETE', /^subscriptions\//);
  stripe.fail('GET', /^subscriptions\//);
  const r = await p.c.post('/billing/refund');
  assert.equal(r.status, 502);
  assert.match(r.data.error, /nothing was refunded and nothing changed/);
  assert.equal(acct(p.id).plan, 'grove');
  assert.equal((await bal(p)).balance, 12);
  assert.equal(stripe.refunded(`ch_in_${p.k}_1`), 0);
  const ok = await p.c.post('/billing/refund');
  assert.equal(ok.status, 200, 'the offer is still there and works the second time');
  assert.equal(ok.data.plan_ended, true);
  assert.equal(stripe.sub(p.sub).status, 'canceled');

  // Cancelling says "cancelled" only once the provider has confirmed it.
  const q = await person('Quy');
  await subscribe(q);
  stripe.fail('POST', /^subscriptions\//);
  stripe.fail('GET', /^subscriptions\//);
  assert.equal((await q.c.post('/billing/cancel')).status, 502);
  assert.equal(acct(q.id).cancel_at, null);
  assert.equal(subjects(q.email).includes('Your Grove plan is cancelled'), false);
  assert.equal((await q.c.post('/billing/cancel')).status, 200);

  // A charge after the plan ended is refunded by itself. If the provider cannot take the refund right now it is tried
  // again on the timer, a person is told when it keeps failing, and the customer gets their money in the end.
  stripe.fail('POST', /^refunds$/, 3);
  await event('invoice.paid', invoice(p, 'in_eve_ghost', { billing_reason: 'subscription_cycle' }));
  assert.equal(pay('in_eve_ghost').refunded_cents, 0);
  await event('invoice.paid', stripe.invoices.in_eve_ghost);
  await cron.tick();
  assert.equal(alerts().some((m) => m.includes('has not gone through yet')), false);
  await cron.tick();
  assert.ok(alerts().some((m) => m.includes('has not gone through yet') && m.includes('in_eve_ghost')), 'a person is told at the third failure');
  await cron.tick();
  assert.equal(pay('in_eve_ghost').refunded_cents, 900);
  assert.equal(stripe.refunded('ch_in_eve_ghost'), 900);
  assert.equal(subjects(p.email).filter((s) => s === 'Refund sent: $9.00').length, 2, 'one for the refund they asked for, one for the charge that should not have happened');
  assert.equal((await bal(p)).balance, 3, 'and no signatures were added for it');
  await cron.tick();
  assert.equal(stripe.refunded('ch_in_eve_ghost'), 900, 'done is done');
});

test('cancelling while a payment is failing ends the plan today, and the failed payment is not taken afterwards', async () => {
  const p = await person('Fay');
  await subscribe(p);
  Object.assign(stripe.sub(p.sub), { status: 'past_due', latest_invoice: 'in_fay_open' });
  stripe.invoices.in_fay_open = { id: 'in_fay_open', status: 'open' };
  await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'past_due', current_period_end: unix(30) });
  assert.equal((await state(p)).problem, 'past_due');
  const r = await p.c.post('/billing/cancel');
  assert.equal(r.data.ended_now, true);
  assert.equal(stripe.sub(p.sub).status, 'canceled');
  assert.equal(stripe.invoices.in_fay_open.status, 'void', 'the open invoice is withdrawn, so it cannot be retried');
  assert.equal(acct(p.id).plan, 'seedling');
  const mail = mailTo(p.email).find((m) => m.subject === 'Your Grove plan is cancelled')!;
  assert.match(mail.html, /will not be tried again/);
  assert.doesNotMatch(mail.html, /already paid for/);
  // If the provider takes it anyway, it goes straight back.
  await event('invoice.paid', invoice(p, 'in_fay_late', { billing_reason: 'subscription_cycle' }));
  assert.equal(pay('in_fay_late').refunded_cents, 900);
  assert.equal((await bal(p)).balance, 12);

  // A plan the provider has put on hold can be cancelled from the app and from the email link too.
  const u = await person('Uma');
  await subscribe(u);
  stripe.sub(u.sub).status = 'unpaid';
  await event('customer.subscription.updated', { id: u.sub, customer: u.cus, status: 'unpaid' });
  const held = await state(u);
  assert.equal(held.plan, 'seedling');
  assert.equal(held.can_cancel, true);
  assert.ok(subjects(u.email).includes('Your monthly plan is on hold'));
  assert.equal((await u.c.post('/billing/cancel')).status, 200);
  assert.equal(stripe.sub(u.sub).status, 'canceled');

  // A payment that gets through brings a held plan back.
  const v = await person('Val');
  await subscribe(v);
  await event('customer.subscription.updated', { id: v.sub, customer: v.cus, status: 'unpaid' });
  assert.equal(acct(v.id).plan, 'seedling');
  await event('invoice.paid', invoice(v, 'in_val_2', { billing_reason: 'subscription_cycle' }));
  assert.equal(acct(v.id).plan, 'grove');
  assert.equal((await bal(v)).balance, 21);
});

test("the provider's echo of our own refund touches no other payment", async () => {
  const p = await person('Gus');
  await subscribe(p);
  await event('invoice.paid', invoice(p, 'in_gus_2', { billing_reason: 'subscription_cycle' }));
  assert.equal((await state(p)).mangroves, 180);
  assert.equal((await p.c.post('/billing/refund')).data.refunded, '$9.00');
  // Newer provider versions do not say which invoice a charge belongs to.
  await event('charge.refunded', { id: 'ch_in_gus_2', customer: p.cus, amount: 900, amount_refunded: 900 });
  assert.equal(pay('in_gus_2').refunded_cents, 900);
  assert.equal(pay(`in_${p.k}_1`).refunded_cents, 0, 'the earlier payment is untouched');
  assert.equal((await state(p)).mangroves, 90);
  // A refund a person makes in the provider's dashboard is recorded against the right payment.
  await event('charge.refunded', { id: `ch_in_${p.k}_1`, customer: p.cus, amount: 900, amount_refunded: 400, invoice: `in_${p.k}_1` });
  assert.equal(pay(`in_${p.k}_1`).refunded_cents, 400);
});

test('slow payment methods are credited when the money arrives, not before and not never', async () => {
  const p = await person('Hal');
  await subscribe(p);
  const s = topUp(p, 'cs_hal_slow', 5, { payment_status: 'unpaid' });
  await event('checkout.session.completed', s);
  assert.equal((await bal(p)).balance, 12);
  assert.equal(pay('cs_hal_slow'), null);
  await event('checkout.session.async_payment_succeeded', { ...s, payment_status: 'paid' });
  assert.equal((await bal(p)).balance, 17);
  await event('checkout.session.async_payment_failed', topUp(p, 'cs_hal_failed', 5, { payment_status: 'unpaid' }));
  assert.equal((await bal(p)).balance, 17);
  assert.ok(subjects(p.email).includes('Your payment did not go through'));

  // A top-up that names an account nobody here has ever heard of is not ours to touch (it could be another
  // server's, or another product's on the same provider account).
  await event('checkout.session.completed', topUp({ ...p, id: 'acc_never_ours' }, 'cs_stranger', 3));
  assert.equal(pay('cs_stranger'), null);
  assert.equal(stripe.refunded('ch_cs_stranger'), 0);
  // A top-up for an account that has since been deleted goes straight back, and a person is told.
  db.run("INSERT INTO accounts (id, name, created_at) VALUES ('acc_gone', 'Gone', ?)", new Date().toISOString());
  db.run("DELETE FROM accounts WHERE id='acc_gone'");
  await event('checkout.session.completed', topUp({ ...p, id: 'acc_gone' }, 'cs_orphan', 3));
  assert.equal(pay('cs_orphan').refunded_cents, 300);
  assert.ok(alerts().some((m) => m.includes('cs_orphan')));
});

test('the free code: typos are said out loud, nobody on it is ever charged, and no month is skipped', async () => {
  // A mistyped code at sign-up stops the sign-up instead of quietly making an ordinary account.
  const t = new Client();
  t.ip = '198.51.100.201';
  const typo = await t.post('/auth/signup', { name: 'Ty Po', email: 'typo@example.com', password: 'correct horse battery', code: 'GROWaliton' });
  assert.equal(typo.status, 400);
  assert.match(typo.data.error, /do not recognise that code/);
  assert.equal(db.get("SELECT COUNT(*) n FROM users WHERE email='typo@example.com'").n, 0);
  assert.equal((await t.post('/auth/signup', { name: 'Ty Po', email: 'typo@example.com', password: 'correct horse battery', code: 'growalition' })).status, 200);
  assert.ok(subjects('typo@example.com').includes('Code GROWalition accepted: your plan is free'), 'and a good one is confirmed by email');

  // A paying member adds the code: the paid subscription ends that moment, in writing, with a reference.
  const p = await person('Ivy');
  await subscribe(p);
  assert.equal((await p.c.post('/billing/redeem', { code: 'GROWalition' })).data.free_with, 'GROWalition');
  assert.equal(stripe.sub(p.sub).status, 'canceled');
  const told = mailTo(p.email).find((m) => m.subject === 'Code GROWalition accepted: your plan is free')!;
  assert.match(told.html, /ended today and will not be charged again\. Cancellation reference: SG-/);
  assert.match(told.html, /If a card is still saved from an earlier payment, it stays saved for top-ups/);
  assert.ok((await state(p)).has_customer, 'so the page can offer to remove it');

  // The refund of what they had paid is still theirs, and taking it does not knock them off the free plan.
  assert.equal((await state(p)).refund.amount, '$9.00');
  const back = await p.c.post('/billing/refund');
  assert.equal(back.data.plan_ended, false);
  let s = await state(p);
  assert.equal(s.plan, 'grove');
  assert.equal(s.free_with, 'GROWalition');
  assert.equal((await p.c.post('/billing/topup', { quantity: 2 })).status, 200);
  assert.equal((await p.c.post('/billing/resume')).status, 400);
  assert.equal((await p.c.post('/billing/remove-card')).status, 200, 'the card can be taken off file at any time');

  // A checkout opened before the code and paid after it: ended at once, and the money goes back.
  const sneak = { ...p, sub: 'sub_ivy_sneak' };
  await event('checkout.session.completed', checkout(sneak, { id: 'cs_sneak' }));
  assert.equal(stripe.sub('sub_ivy_sneak').status, 'canceled');
  await event('invoice.paid', invoice(sneak, 'in_sneak'));
  assert.equal(pay('in_sneak').refunded_cents, 900);
  assert.equal((await state(p)).free_with, 'GROWalition');
  stripe.sub('sub_ivy_zombie');
  await event('customer.subscription.updated', { id: 'sub_ivy_zombie', customer: p.cus, status: 'active', metadata: { sg_account: p.id } });
  assert.equal(stripe.sub('sub_ivy_zombie').status, 'canceled', 'a paid subscription on a free plan is never left alive');

  // Months in which nobody opened the account are made up, not lost.
  const g = new Client();
  g.ip = '198.51.100.202';
  await g.post('/auth/signup', { name: 'Gro Quiet', email: 'quiet@example.com', password: 'correct horse battery', code: 'GROWalition' });
  const gid = (await g.get('/me')).data.account.id;
  const d = new Date();
  db.run("DELETE FROM credits WHERE account_id=? AND reason='code'", gid);
  db.run('UPDATE accounts SET promo_at=? WHERE id=?', new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 15)).toISOString(), gid);
  assert.equal((await g.get('/billing')).data.signatures.balance, 3 + 9 * 4, 'three quiet months and this one');
  assert.equal((await g.get('/billing')).data.signatures.balance, 39);
  assert.ok((await g.get('/billing')).data.free_next_at, 'the page says when the next ones arrive');

  // Two codes do not stack.
  process.env.FREE_PLAN_CODES = 'GROWalition,Mangrove2027';
  assert.equal((await g.post('/billing/redeem', { code: 'Mangrove2027' })).data.signatures.balance, 39);

  // A code that is switched off adds nothing more, and the plan it made free ends with an email.
  process.env.FREE_PLAN_CODES = 'SomethingElse';
  db.run("DELETE FROM credits WHERE account_id=? AND reason='code' AND ref=?", gid, new Date().toISOString().slice(0, 7));
  assert.equal((await g.get('/billing')).data.signatures.balance, 30);
  // A code has to be gone for three days before plans end, so a slip in a deployment does not end everyone's plan.
  assert.equal((await cron.tick()).codes_ended, 0);
  assert.equal(acct(gid).plan, 'grove');
  db.run('UPDATE accounts SET promo_missing_since=? WHERE promo_missing_since IS NOT NULL', new Date(Date.now() - 4 * 864e5).toISOString());
  assert.equal((await cron.tick()).codes_ended >= 1, true);
  assert.equal(acct(gid).plan, 'seedling');
  assert.equal(acct(gid).promo_code, null);
  assert.ok(subjects('quiet@example.com').includes('The code Mangrove2027 has ended'));
  assert.equal((await g.get('/billing')).data.signatures.balance, 30, 'they keep what they have');
  delete process.env.FREE_PLAN_CODES;
});

test('renewal reminders run on our own timer, a week before and the day before, once each', async () => {
  const p = await person('Jem');
  await subscribe(p);
  const inSix = new Date(Date.now() + 6 * 864e5).toISOString();
  db.run('UPDATE accounts SET renews_at=? WHERE id=?', inSix, p.id);
  assert.equal((await cron.tick()).renewals, 1);
  const week = mailTo(p.email).find((m) => m.subject.startsWith('Heads up: your plan renews on'))!;
  assert.match(week.subject, /\$9\.00/);
  assert.match(week.link, /\/billing\/stop\?token=/);
  assert.equal((await cron.tick()).renewals, 0, 'once');
  // The provider's own notice for the same renewal does not send a second one, but its amount is remembered.
  await event('invoice.upcoming', { customer: p.cus, amount_due: 900, currency: 'usd', next_payment_attempt: Math.floor(Date.parse(inSix) / 1000) });
  assert.equal(subjects(p.email).filter((s) => s.startsWith('Heads up')).length, 1);
  assert.equal(acct(p.id).renewal_quoted_cents, 900);

  // The day before: one more.
  const inTwenty = new Date(Date.now() + 20 * 3600_000).toISOString();
  db.run('UPDATE accounts SET renews_at=?, renewal_reminded=? WHERE id=?', inTwenty, `${inTwenty.slice(0, 10)}|7`, p.id);
  assert.equal((await cron.tick()).renewals, 1);
  assert.ok(subjects(p.email).some((s) => s.startsWith('Last reminder: your plan renews on') && s.endsWith('for $9.00')));
  assert.equal((await cron.tick()).renewals, 0);
  assert.equal((await state(p)).history.filter((h: any) => h.label === 'Renewal reminder sent').length, 2, 'every reminder is on record');

  // If more is charged than the reminder said, the difference goes back by itself and a person is told.
  const renewal = Math.floor(Date.parse(inTwenty) / 1000);
  await event('invoice.paid', invoice(p, 'in_jem_more', { amount_paid: 1200, billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: renewal, end: renewal + 30 * 86400 }, metadata: { sg_account: p.id } }] } }));
  assert.equal(pay('in_jem_more').refunded_cents, 300);
  assert.ok(subjects(p.email).includes('Refund sent: $3.00'));
  assert.ok(alerts().some((m) => m.includes('was charged more than we told them')));
  assert.equal(alerts().some((m) => m.includes('in_jem_more') && m.includes('without a reminder')), false, 'this renewal was reminded, so no false alarm');
  assert.equal((await bal(p)).balance, 21);

  // A renewal nobody was reminded of is flagged, and signatures follow the money.
  const q = await person('Kit');
  await subscribe(q);
  await event('invoice.paid', invoice(q, 'in_kit_small', { amount_paid: 50, billing_reason: 'subscription_cycle' }));
  assert.ok(alerts().some((m) => m.includes('renewed without a reminder')));
  assert.equal((await bal(q)).balance, 12, 'fifty cents does not buy nine signatures');
  assert.equal(pay('in_kit_small').credits, 0);
});

test('every email about money carries the way out, and the link stops working when its admin leaves', async () => {
  const p = await person('Lea');
  await subscribe(p);
  const receipt = mailTo(p.email).find((m) => m.subject.startsWith('Receipt'))!;
  assert.match(receipt.html, /\/billing\/stop\?token=/, 'the monthly receipt has the stop link');
  assert.match(receipt.html, new RegExp(`reference ${p.id}`), 'and says which account it is for');
  await event('invoice.payment_failed', { customer: p.cus, subscription: p.sub });
  assert.match(mailTo(p.email).find((m) => m.subject === 'Your monthly payment did not go through')!.html, /\/billing\/stop\?token=/);

  // A second admin gets the same emails, with a link of their own.
  await p.c.post('/account/invites', { email: 'lea-admin@example.com', role: 'admin' });
  const adm = new Client();
  await adm.post('/auth/signup', { name: 'Second Admin', email: 'lea-admin@example.com', password: 'correct horse battery', invite: db.get("SELECT token FROM invites WHERE email='lea-admin@example.com'").token });
  await event('invoice.paid', invoice(p, 'in_lea_2', { billing_reason: 'subscription_cycle' }));
  const theirs = mailTo('lea-admin@example.com').find((m) => m.subject.startsWith('Receipt'))!;
  const token = decodeURIComponent(/billing\/stop\?token=([^"<\s]+)/.exec(theirs.html)![1]);
  const anon = new Client();
  assert.equal((await anon.get(`/public/billing/stop?token=${encodeURIComponent(token)}`)).status, 200);
  // Removed from the team: their old emails can no longer stop the plan.
  const uid = db.get("SELECT id FROM users WHERE email='lea-admin@example.com'").id;
  assert.equal((await p.c.call('DELETE', `/account/members/${uid}`)).status, 200);
  assert.equal((await anon.get(`/public/billing/stop?token=${encodeURIComponent(token)}`)).status, 410);
  assert.equal((await anon.post('/public/billing/stop', { token })).status, 410);
  assert.equal(acct(p.id).cancel_at, null);
});

test('dates in emails are the dates on the reader\'s screen', async () => {
  const p = await person('Moe');
  await subscribe(p);
  stripe.sub(p.sub).current_period_end = Date.UTC(2031, 2, 8, 2, 0) / 1000; // 8 March 02:00 UTC is still 7 March in Los Angeles
  await p.c.call('GET', '/me', undefined, { 'x-tz': 'America/Los_Angeles' });
  await p.c.post('/account/invites', { email: 'moe-utc@example.com', role: 'admin' });
  await new Client().post('/auth/signup', { name: 'No Zone', email: 'moe-utc@example.com', password: 'correct horse battery', invite: db.get("SELECT token FROM invites WHERE email='moe-utc@example.com'").token });
  await p.c.post('/billing/cancel');
  assert.match(mailTo(p.email).find((m) => m.subject === 'Your Grove plan is cancelled')!.html, /runs until March 7, 2031,/);
  assert.match(mailTo('moe-utc@example.com').find((m) => m.subject === 'Your Grove plan is cancelled')!.html, /runs until March 8, 2031 \(UTC\),/, 'with no zone on record the email says which zone it means');
});

test('a card dispute stops billing, is not fought, and cannot be refunded a second time', async () => {
  const p = await person('Ned');
  await subscribe(p);
  assert.equal((await state(p)).refund.amount, '$9.00');
  await event('charge.dispute.created', { id: 'dp_ned', charge: `ch_in_${p.k}_1` });
  assert.ok(stripe.disputesClosed.includes('dp_ned'));
  assert.equal(stripe.sub(p.sub).status, 'canceled');
  const s = await state(p);
  assert.equal(s.plan, 'seedling');
  assert.equal(s.refund, null, 'the bank is returning it, so the app does not offer it again');
  assert.equal(s.mangroves, 0);
  assert.ok(subjects(p.email).includes('A payment was disputed, so we stopped billing you'));
  assert.ok(alerts().some((m) => m.includes('Card dispute') && m.includes('accepted with the payment provider automatically')));
  assert.equal(s.signatures.balance, 3, 'the signatures that payment bought and that were unused go with it');
  assert.equal((await p.c.post('/billing/checkout')).status, 403, 'new payments stay off until a person has looked');
  process.env.OPERATOR_EMAILS = p.email;
  assert.equal((await p.c.post(`/operator/billing/accounts/${p.id}/clear-dispute`)).status, 200);
  delete process.env.OPERATOR_EMAILS;
  assert.equal((await p.c.post('/billing/checkout')).status, 200);
});

test('locked out and not sure which address the account is under: the card, a date and an amount are enough', async () => {
  const p = await person('Oda');
  await subscribe(p);
  stripe.charges.find((c) => c.id === `ch_in_${p.k}_1`)!.last4 = '7788';
  const anon = new Client();
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await anon.post('/public/billing/stop-by-card', { last4: '7788' })).status, 400, 'four digits alone are not enough');
  assert.equal((await anon.post('/public/billing/stop-by-card', { last4: '7788', charged_on: today, amount: '12.00' })).status, 404);
  const ok = await anon.post('/public/billing/stop-by-card', { last4: '7788', charged_on: today, amount: '$9.00' });
  assert.equal(ok.data.stopped, true);
  assert.equal(ok.data.account, undefined, 'the account name is not given away to whoever knows a card');
  assert.match(ok.data.reference, /^SG-/);
  assert.ok(acct(p.id).cancel_at);
  assert.ok(subjects(p.email).includes('Your Grove plan is cancelled'), 'the owners are told, and can undo it with one click');

  // The people running the service can find an account the same way.
  process.env.OPERATOR_EMAILS = p.email;
  const found = await p.c.get('/operator/billing/lookup?last4=7788');
  assert.equal(found.data.accounts[0].id, p.id);
  delete process.env.OPERATOR_EMAILS;
  assert.equal((await p.c.get('/operator/billing/lookup?last4=7788')).status, 404);
});

test('sending to yourself is free, but pointing that request at someone else needs a signature', async () => {
  const p = await person('Pia');
  db.run("INSERT INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,?,?,?)", p.id, -3, 'adjust', 'test', new Date().toISOString());
  assert.equal((await bal(p)).available, 0);

  // Free to send to yourself at zero.
  // "Yourself" means your own address and your own name. A client entered under your address is somebody else.
  const me = { recipients: [{ id: 'r', role: 'signer', name: 'Pia Tester', email: p.email }] };
  const client = await simple(p.c, p.email, { recipients: [{ id: 'r', role: 'signer', name: 'Walk-in Client', email: p.email }] });
  assert.equal((await p.c.post(`/envelopes/${client.id}/send`)).status, 402, 'a client under your own address still needs a signature');
  const own = await simple(p.c, p.email, me);
  assert.equal((await p.c.post(`/envelopes/${own.id}/send`)).status, 200);
  const rid = (await p.c.get(`/envelopes/${own.id}`)).data.envelope.recipients[0].id;
  // The quick fix cannot turn it into a free signature for somebody else.
  const swap = await p.c.post(`/envelopes/${own.id}/correct`, { recipient_id: rid, name: 'A Client', email: 'client@example.com' });
  assert.equal(swap.status, 402);
  assert.match(swap.data.error, /needs 1 signature and you have 0 left/);
  // Nor can "assign to someone else" on the signing screen.
  const pass = await new Client().post(`/sign/${tokenFor(own.id, p.email)}/reassign`, { name: 'A Client', email: 'client@example.com' });
  assert.equal(pass.status, 402);
  // Nor the full editor.
  const full = (await p.c.get(`/envelopes/${own.id}`)).data.envelope;
  full.recipients[0].email = 'client@example.com';
  assert.equal((await p.c.put(`/envelopes/${own.id}`, full)).status, 402);
  assert.equal((await bal(p)).available, 0);
  assert.equal(mailTo('client@example.com').length, 0);

  // With a signature on the balance it works, holds one, and uses it when the client signs.
  db.run("INSERT INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,?,?,?)", p.id, 1, 'adjust', 'test2', new Date().toISOString());
  assert.equal((await p.c.post(`/envelopes/${own.id}/correct`, { recipient_id: rid, name: 'A Client', email: 'client@example.com' })).status, 200);
  assert.deepEqual(await bal(p), { balance: 1, held: 1, available: 0 });
  assert.equal((await signAll(own.id, 'client@example.com')).status, 200);
  assert.deepEqual(await bal(p), { balance: 0, held: 0, available: 0 });

  // Being over-committed never blocks what is free: your own documents, and a name fix on something already out.
  const out = await simple(p.c, p.email, me);
  await p.c.post(`/envelopes/${out.id}/send`);
  db.run("INSERT INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,?,?,?)", p.id, -1, 'adjust', 'test3', new Date().toISOString());
  assert.equal((await bal(p)).available, -1);
  const again = await simple(p.c, p.email, me);
  assert.equal((await p.c.post(`/envelopes/${again.id}/send`)).status, 200, 'signing your own document stays free below zero');
  const fix = (await p.c.get(`/envelopes/${out.id}`)).data.envelope;
  fix.subject = 'Renamed agreement';
  assert.equal((await p.c.put(`/envelopes/${out.id}`, fix)).status, 200, 'a change that needs no signatures is never refused');
  // Renaming your own free signature to somebody else's name makes it theirs, and then it needs one.
  const rename = (await p.c.get(`/envelopes/${out.id}`)).data.envelope;
  rename.recipients[0].name = 'Somebody Else';
  assert.equal((await p.c.put(`/envelopes/${out.id}`, rename)).status, 402);
  assert.equal((await p.c.post(`/envelopes/${out.id}/correct`, { recipient_id: rename.recipients[0].id, name: 'Somebody Else' })).status, 402);

  // Handing a departed member's own documents to someone else does not start charging for them.
  const t = await person('Tea');
  await t.c.post('/account/invites', { email: 'tea-member@example.com' });
  const mem = new Client();
  await mem.post('/auth/signup', { name: 'Tea Member', email: 'tea-member@example.com', password: 'correct horse battery', invite: db.get("SELECT token FROM invites WHERE email='tea-member@example.com'").token });
  const theirs = await simple(mem, 'tea-member@example.com', { recipients: [{ id: 'r', role: 'signer', name: 'Tea Member', email: 'tea-member@example.com' }] });
  assert.equal((await mem.post(`/envelopes/${theirs.id}/send`)).status, 200);
  assert.deepEqual(await bal(t), { balance: 3, held: 0, available: 3 });
  const uid = db.get("SELECT id FROM users WHERE email='tea-member@example.com'").id;
  assert.equal((await t.c.call('DELETE', `/account/members/${uid}`)).status, 200);
  assert.deepEqual(await bal(t), { balance: 3, held: 0, available: 3 }, 'still free after the hand-over');
});

test('running low is told to the people who can buy more, not only to whoever sent', async () => {
  const t = await person('Wes');
  await t.c.post('/account/invites', { email: 'wes-member@example.com' });
  const mem = new Client();
  await mem.post('/auth/signup', { name: 'Wes Member', email: 'wes-member@example.com', password: 'correct horse battery', invite: db.get("SELECT token FROM invites WHERE email='wes-member@example.com'").token });
  for (const to of ['w1@example.com', 'w2@example.com', 'w3@example.com']) {
    const e = await simple(mem, to);
    assert.equal((await mem.post(`/envelopes/${e.id}/send`)).status, 200);
  }
  assert.ok(subjects(t.email).includes('2 signatures left') && subjects(t.email).includes('You have used all your signatures'), 'the owner hears about it');
  const toMember = mailTo('wes-member@example.com').find((m) => m.subject === 'You have used all your signatures')!;
  assert.match(toMember.html, /Only an owner or admin of your team can buy more/);
  assert.match(mailTo(t.email).find((m) => m.subject === 'You have used all your signatures')!.html, /after Wes Member sent/);
});
