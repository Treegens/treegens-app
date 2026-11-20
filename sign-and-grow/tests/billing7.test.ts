// Billing, seventh round: the price an account is on and how a change of price is told, things on a shared provider
// account that are not ours, public forms whose visitor is told to come back, and one signature per person at a
// shared address. Each test is the regression test for a finding of the third payment review (verify:pay-terms).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, mailTo, upload, signAll, PNG, type Server } from './helpers.ts';
import { stripe, unix } from './stripe-fake.ts';
import { PRICING } from '../src/lib/impact.ts';

let db: Server['db'];
let billing: Server['billing'];
let cron: Server['cron'];

let evn = 0;
const event = (type: string, object: any, extra: any = {}) => billing.applyStripeEvent({ id: `evt7_${++evn}`, type, created: Math.floor(Date.now() / 1000), data: { object }, ...extra });
const acct = (id: string) => db.get('SELECT * FROM accounts WHERE id=?', id);
const pay = (id: string) => db.get('SELECT * FROM payments WHERE id=?', id);
const alerts = () => db.all("SELECT message FROM support_requests WHERE topic='billing' ORDER BY rowid").map((r: any) => r.message as string);
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const subjects = (email: string) => mailTo(email).map((m: any) => m.subject as string);
const lastMail = (email: string, starts: string) => {
  const m = mailTo(email).filter((x: any) => String(x.subject).startsWith(starts)).at(-1);
  return m ? text(m.html) : null;
};
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const adjust = (id: string, delta: number, ref: string) => db.run("INSERT INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,'adjust',?,?)", id, delta, ref, new Date().toISOString());

type Person = { c: Client; id: string; name: string; email: string; cus: string; sub: string; k: number };
let n = 0;
async function person(first: string): Promise<Person> {
  const k = ++n;
  const email = `${first.toLowerCase()}${k}@seven.example`;
  const name = `${first} Tester`;
  const c = await signUp(name, email, `198.51.117.${k}`);
  return { c, id: (await c.get('/me')).data.account.id, name, email, cus: `cus7_${k}`, sub: `sub7_${k}`, k };
}
function invoice(p: Person, inv: string, over: any = {}) {
  const o = {
    id: inv, customer: p.cus, subscription: p.sub, amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', hosted_invoice_url: `https://pay.example/${inv}`,
    lines: { data: [{ period: { start: unix(0), end: unix(30) }, metadata: { sg_account: p.id }, price: { id: 'price_grove' } }] }, ...over,
  };
  stripe.invoices[inv] = o;
  stripe.charges.unshift({ id: `ch_${inv}`, paid: true, refunded: false, amount: o.amount_paid, currency: o.currency, customer: o.customer, invoice: inv, last4: '4242', created: unix(0) });
  return o;
}
const renewal = (p: Person, inv: string, cents: number, over: any = {}) => invoice(p, inv, { amount_paid: cents, billing_reason: 'subscription_cycle', ...over });
const checkout = (p: Person, over: any = {}) => ({ id: `cs7_${p.k}`, mode: 'subscription', client_reference_id: p.id, customer: p.cus, subscription: p.sub, payment_status: 'paid', ...over });
async function subscribe(p: Person, inv = `in7_${p.k}_1`) {
  Object.assign(stripe.sub(p.sub), { customer: p.cus, metadata: { sg_account: p.id } });
  await event('checkout.session.completed', checkout(p));
  await event('invoice.paid', invoice(p, inv));
}
const state = async (p: Person) => (await p.c.get('/billing')).data;
const bal = async (p: Person) => (await state(p)).signatures;
const asOperator = async <T>(p: Person, fn: () => Promise<T>): Promise<T> => {
  process.env.OPERATOR_EMAILS = p.email;
  try {
    return await fn();
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
};
const day = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

before(async () => {
  ({ db, billing, cron } = await boot());
});

// ---- The price an account is on -------------------------------------------------------------------------------

test('a returning customer pays the price its new checkout showed, not the price of the plan that ended', async () => {
  const p = await person('Returner');
  await subscribe(p);
  assert.equal(acct(p.id).price_cents, 900);
  await p.c.post('/billing/cancel');
  Object.assign(stripe.sub(p.sub), { status: 'canceled' });
  await event('customer.subscription.deleted', { id: p.sub, customer: p.cus, status: 'canceled' });
  PRICING.monthlyUsd = 12;
  try {
    // The checkout shows the new price and carries it on the subscription.
    assert.equal((await p.c.post('/billing/checkout')).status, 200);
    const made = stripe.calls.filter((c) => c[1] === 'checkout/sessions').at(-1)![2];
    assert.equal(made['subscription_data[metadata][sg_price_cents]'], '1200');
    assert.match(made['custom_text[submit][message]'], /^\$12\.00 today, then \$12\.00 every month/);
    const again = { ...p, sub: 'sub7_returned' };
    Object.assign(stripe.sub(again.sub), { customer: p.cus, metadata: { sg_account: p.id, sg_price_cents: '1200' } });
    await event('checkout.session.completed', checkout(again, { id: 'cs7_returned' }));
    const line = (start: number) => ({ data: [{ period: { start: unix(start), end: unix(start + 30) }, metadata: { sg_account: p.id }, price: { id: 'price_grove', unit_amount: 1200 } }] });
    await event('invoice.paid', invoice(again, 'in7_ret_1', { amount_paid: 1200, lines: line(0) }));
    assert.equal(acct(p.id).price_cents, 1200, 'the new subscription is on the price its checkout showed');
    assert.equal((await state(p)).plan_price, '$12.00');
    // Its renewals at that price are not "a price rise without notice": nothing is refunded, nobody is told so.
    await event('invoice.paid', renewal(again, 'in7_ret_2', 1200, { lines: line(30) }));
    assert.equal(stripe.refunded('ch_in7_ret_2'), 0);
    assert.ok(!subjects(p.email).some((s) => s.startsWith('Refund sent')));
    assert.ok(!alerts().some((m) => m.includes('in7_ret_2') && /charged more than we told them/.test(m)));
    // The welcome email quotes that price too.
    assert.match(lastMail(p.email, 'Welcome to')!, /\$12\.00 a month adds 9 signatures/);
  } finally {
    PRICING.monthlyUsd = 9;
  }
});

test('every account has a stored price: a row without one gets it at start, so a raise without notice is still refunded', async () => {
  const p = await person('OldRow');
  await subscribe(p);
  // An account from before the price was kept.
  db.run('UPDATE accounts SET price_cents=NULL WHERE id=?', p.id);
  // One that never paid.
  const q = await person('NeverPaid');
  db.run('UPDATE accounts SET price_cents=NULL WHERE id=?', q.id);
  assert.ok(billing.backfillPrices() >= 2);
  assert.equal(acct(p.id).price_cents, 900, 'from its last plan payment, before tax');
  assert.equal(acct(q.id).price_cents, 900, 'the price for new customers at that moment');
  // The operator then raises the price for new customers, and the provider charges the old account more, with no notice.
  PRICING.monthlyUsd = 12;
  try {
    assert.equal((await state(p)).plan_price, '$9.00');
    await event('invoice.paid', renewal(p, 'in7_old_2', 1200, { lines: { data: [{ period: { start: unix(30), end: unix(60) }, metadata: { sg_account: p.id }, price: { id: 'price_grove' } }] } }));
    assert.equal(stripe.refunded('ch_in7_old_2'), 300, 'the difference goes back');
  } finally {
    PRICING.monthlyUsd = 9;
  }
});

test('a price notice goes to every account with a subscription of ours, in any state', async () => {
  const live = await person('NoticeLive');
  await subscribe(live);
  const hold = await person('NoticeHold');
  await subscribe(hold);
  await event('customer.subscription.updated', { id: hold.sub, customer: hold.cus, status: 'unpaid', current_period_end: unix(30), metadata: { sg_account: hold.id } }, { created: unix(0) + 5 });
  const paused = await person('NoticePaused');
  await subscribe(paused);
  await event('customer.subscription.updated', { id: paused.sub, customer: paused.cus, status: 'paused', current_period_end: unix(30), metadata: { sg_account: paused.id } }, { created: unix(0) + 5 });
  assert.equal(acct(hold.id).plan, 'seedling');
  assert.equal(acct(paused.id).subscription_status, 'paused');
  const r = await asOperator(live, () => live.c.post('/operator/billing/price-notice', { new_usd: 12, from: day(40) }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const x of [live, hold, paused]) {
    assert.equal(acct(x.id).price_notice_cents, 1200, `${x.name} was told`);
    assert.ok(subjects(x.email).some((s) => s.startsWith('The price of your Sign&Grow plan changes on')));
  }
});

test('tax inside the price: the reminder says what is charged, and an unannounced raise is refunded in full', async () => {
  const p = await person('Inclusive');
  Object.assign(stripe.sub(p.sub), { customer: p.cus, metadata: { sg_account: p.id } });
  await event('checkout.session.completed', checkout(p));
  const line = (start: number, unit: number) => ({ data: [{ period: { start: unix(start), end: unix(start + 30) }, metadata: { sg_account: p.id }, price: { id: 'price_grove', unit_amount: unit } }] });
  await event('invoice.paid', invoice(p, 'in7_inc_1', { amount_paid: 900, tax: 150, lines: line(0, 900) }));
  assert.equal(acct(p.id).renewal_tax_cents, 0, 'nothing was added on top');
  assert.ok(!alerts().some((m) => m.includes('in7_inc_1')), 'an ordinary payment raises no alert');
  db.run('UPDATE accounts SET renews_at=?, renewal_reminded=NULL, renewal_quoted_cents=NULL, created_at=? WHERE id=?', ahead(6 * 864e5), new Date().toISOString(), p.id);
  await billing.renewalReminders();
  assert.match(subjects(p.email).find((s) => s.startsWith('Heads up'))!, /for \$9\.00$/);
  assert.equal((await state(p)).next_amount, '$9.00');
  // Raised to $12 (tax inside) without notice: all $3 goes back.
  await event('invoice.paid', renewal(p, 'in7_inc_2', 1200, { tax: 200, lines: line(6, 1200) }));
  assert.equal(stripe.refunded('ch_in7_inc_2'), 300);

  // The newer and older API shapes that say so outright, and tax added on top, which is still allowed.
  const q = await person('TaxShapes');
  Object.assign(stripe.sub(q.sub), { customer: q.cus, metadata: { sg_account: q.id } });
  await event('checkout.session.completed', checkout(q));
  await event('invoice.paid', invoice(q, 'in7_tax_1', { amount_paid: 1050, total_taxes: [{ amount: 150, tax_behavior: 'exclusive' }] }));
  assert.equal(stripe.refunded('ch_in7_tax_1'), 0, 'tax on top is allowed');
  assert.equal(acct(q.id).renewal_tax_cents, 150);
  await event('invoice.paid', renewal(q, 'in7_tax_2', 1200, { total_tax_amounts: [{ amount: 200, inclusive: true }] }));
  assert.equal(stripe.refunded('ch_in7_tax_2'), 300, 'tax inside a raised price adds nothing to what is allowed');
});

test('a notice for the same price withdraws an announced rise, and the people who were told are told', async () => {
  const p = await person('Withdrawn');
  await subscribe(p);
  const first = await asOperator(p, () => p.c.post('/operator/billing/price-notice', { new_usd: 12, from: day(45) }));
  assert.ok(first.data.told >= 1);
  assert.ok((await state(p)).price_change);
  const second = await asOperator(p, () => p.c.post('/operator/billing/price-notice', { new_usd: 9, from: day(45) }));
  assert.ok(second.data.withdrawn >= 1, JSON.stringify(second.data));
  assert.equal(acct(p.id).price_notice_cents, null);
  assert.equal((await state(p)).price_change, null);
  const mail = lastMail(p.email, 'The price of your Sign&Grow plan is not changing after all');
  assert.ok(mail, 'an email says the rise is withdrawn');
  assert.match(mail!, /would cost \$12\.00 a month\. That change is withdrawn: the price stays \$9\.00 a month\./);
});

test('a notice counts only when the email left for every owner and admin: the outbox does not count on a real server', async () => {
  const p = await person('NoSmtp');
  await subscribe(p);
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  let r: any;
  try {
    r = await asOperator(p, () => p.c.post('/operator/billing/price-notice', { new_usd: 13, from: day(40) }));
  } finally {
    process.env.NODE_ENV = was;
  }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(acct(p.id).price_notice_cents, null, 'not recorded as told');
  assert.ok(r.data.not_told.some((x: string) => x.startsWith(acct(p.id).name) && x.includes(p.email)), JSON.stringify(r.data.not_told));
  // On a development server the outbox is where mail is read, so there it counts.
  const again = await asOperator(p, () => p.c.post('/operator/billing/price-notice', { new_usd: 13, from: day(40) }));
  assert.equal(acct(p.id).price_notice_cents, 1300);
  assert.ok(!again.data.not_told.some((x: string) => x.startsWith(acct(p.id).name)));
});

test('the day of a price change is one calendar day in UTC, the same in the email, on the Plan page and for the operator', async () => {
  const p = await person('Zone');
  await subscribe(p);
  db.run("UPDATE users SET tz='America/Los_Angeles' WHERE email=?", p.email);
  const r = await asOperator(p, () => p.c.post('/operator/billing/price-notice', { new_usd: 12, from: '2027-03-01' }));
  assert.equal(r.data.from_day, 'March 1, 2027 (UTC)');
  assert.ok(subjects(p.email).includes('The price of your Sign&Grow plan changes on March 1, 2027 (UTC)'), JSON.stringify(subjects(p.email)));
  assert.equal((await state(p)).price_change.from_day, 'March 1, 2027 (UTC)');
});

test('once the announced day has passed, the Plan page shows the new price and no longer says it is coming', async () => {
  const p = await person('Passed');
  await subscribe(p);
  db.run('UPDATE accounts SET price_notice_cents=1200, price_notice_from=?, price_notice_at=?, renews_at=? WHERE id=?', ago(2 * 864e5), ago(40 * 864e5), ahead(5 * 864e5), p.id);
  const s = await state(p);
  assert.equal(s.price_change, null);
  assert.equal(s.plan_price, '$12.00');
  assert.equal(s.next_amount, '$12.00');
});

test('a notice that has taken effect is the price: a later notice neither withdraws it nor says the old price', async () => {
  const p = await person('Effective');
  await subscribe(p);
  db.run('UPDATE accounts SET price_notice_cents=1200, price_notice_from=?, price_notice_at=? WHERE id=?', ago(2 * 864e5), ago(40 * 864e5), p.id);
  // The same price again: nothing is withdrawn, and nobody is told the price is not changing.
  const same = await asOperator(p, () => p.c.post('/operator/billing/price-notice', { new_usd: 12, from: day(45) }));
  assert.equal(same.status, 200);
  assert.equal(acct(p.id).price_cents, 1200, 'the price in effect is written down as the price');
  assert.equal((await state(p)).plan_price, '$12.00');
  assert.ok(!subjects(p.email).some((s) => s.startsWith('The price of your Sign&Grow plan is not changing')));
  // A higher one: the email says what they pay today, which is the price in effect.
  await asOperator(p, () => p.c.post('/operator/billing/price-notice', { new_usd: 15, from: day(45) }));
  assert.match(lastMail(p.email, 'The price of your Sign&Grow plan changes on')!, /pays \$12\.00 a month\. From .+ the monthly plan costs \$15\.00 a month/);
});

test('the stop page and the emails quote the price this account is charged, not the price for new customers', async () => {
  const p = await person('Prices');
  await subscribe(p);
  db.run('UPDATE accounts SET price_notice_cents=1200, price_notice_from=?, price_notice_at=?, renews_at=? WHERE id=?', ago(864e5), ago(40 * 864e5), ahead(5 * 864e5), p.id);
  const uid = db.get('SELECT id FROM users WHERE email=?', p.email).id;
  const stop = await new Client().get(`/public/billing/stop?token=${encodeURIComponent(billing.stopToken(p.id, uid))}`);
  assert.equal(stop.data.price, 12);
  assert.equal(stop.data.next_amount, '$12.00');
  const c = new Client();
  c.ip = '203.0.113.171';
  await c.post('/public/billing/find', { email: p.email });
  assert.match(lastMail(p.email, 'Your Sign&Grow subscriptions')!, /\$12\.00 a month, next charge \$12\.00 on/);
  // Cancelled here, then the cancellation undone on the provider's own page.
  await p.c.post('/billing/cancel');
  stripe.sub(p.sub).cancel_at_period_end = true;
  await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'active', cancel_at_period_end: false, current_period_end: unix(5), metadata: { sg_account: p.id } }, { created: unix(0) + 100 });
  assert.match(lastMail(p.email, 'Your Grove plan continues')!, /The next charge is \$12\.00 on/);
});

test('a production server without a pinned provider API version says so loudly, once', async () => {
  const p = await person('Version');
  const was = { env: process.env.NODE_ENV, version: process.env.STRIPE_API_VERSION };
  const said: string[] = [];
  const err = console.error;
  console.error = (...a: any[]) => void said.push(a.join(' '));
  process.env.NODE_ENV = 'production';
  delete process.env.STRIPE_API_VERSION;
  try {
    await p.c.post('/billing/checkout');
    await p.c.post('/billing/checkout');
  } finally {
    console.error = err;
    process.env.NODE_ENV = was.env;
    if (was.version !== undefined) process.env.STRIPE_API_VERSION = was.version;
  }
  assert.equal(said.filter((s) => s.includes('STRIPE_API_VERSION IS NOT SET')).length, 1, JSON.stringify(said));
});

// ---- The Plan page --------------------------------------------------------------------------------------------

test('a paused plan is told apart from a failed payment, and a free code that ended reads as a plan that ended', async () => {
  const p = await person('Paused');
  await subscribe(p);
  await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'paused', current_period_end: unix(30), metadata: { sg_account: p.id } }, { created: unix(0) + 5 });
  assert.equal((await state(p)).problem, 'paused');
  const top = await p.c.post('/billing/topup', { quantity: 5 });
  assert.equal(top.status, 400);
  assert.match(top.data.error, /yours is paused with the payment provider/);
  assert.doesNotMatch(top.data.error, /did not go through/);

  const q = await person('CodeOnly');
  assert.equal((await q.c.post('/billing/redeem', { code: 'GROWalition' })).status, 200);
  const was = process.env.FREE_PLAN_CODES;
  process.env.FREE_PLAN_CODES = 'SOMETHINGELSE';
  try {
    await billing.endRemovedCodes();
    db.run('UPDATE accounts SET promo_missing_since=? WHERE id=?', ago(4 * 864e5), q.id);
    await billing.endRemovedCodes();
  } finally {
    if (was === undefined) delete process.env.FREE_PLAN_CODES;
    else process.env.FREE_PLAN_CODES = was;
  }
  const s = await state(q);
  assert.equal(s.plan, 'seedling');
  assert.equal(s.ended, true, 'a plan that was on through a code has ended; it did not "never start"');
});

test('coming back to an old checkout link says the plan is there, not that its signatures are on their way', async () => {
  const p = await person('OldLink');
  await subscribe(p);
  db.run("UPDATE payments SET at=? WHERE account_id=? AND kind='plan'", ago(7 * 864e5), p.id);
  stripe.sessions[`cs_7old${p.k}`] = { ...checkout(p, { id: `cs_7old${p.k}` }), invoice: `in7_${p.k}_1` };
  const r = await p.c.post('/billing/sync', { session_id: `cs_7old${p.k}` });
  assert.equal(r.data.applied, 'plan');
  // Without the session naming its invoice, a plan payment of that subscription is enough.
  stripe.sessions[`cs_7old${p.k}`] = checkout(p, { id: `cs_7old${p.k}` });
  assert.equal((await p.c.post('/billing/sync', { session_id: `cs_7old${p.k}` })).data.applied, 'plan');
});

// ---- Stopping without logging in ------------------------------------------------------------------------------

test('a plain member cannot stop the team plan with the card, as they cannot in the app', async () => {
  const owner = await person('CardOwner');
  await subscribe(owner);
  const inv = await owner.c.post('/account/invites', { email: 'member.seven@seven.example', role: 'member' });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  const tok = db.get("SELECT token FROM invites WHERE email='member.seven@seven.example'").token;
  const m = new Client();
  m.ip = '198.51.118.77';
  assert.equal((await m.post('/auth/signup', { name: 'Mallory Member', email: 'member.seven@seven.example', password: 'correct horse battery', invite: tok })).status, 200);
  const c = new Client();
  c.ip = '203.0.113.241';
  const r = await c.post('/public/billing/stop-by-card', { email: 'member.seven@seven.example', last4: '4242' });
  assert.equal(r.status, 404, JSON.stringify(r.data));
  assert.match(r.data.error, /only be stopped here with the address of one of its owners or admins/);
  assert.equal(acct(owner.id).cancel_at, null);
  assert.ok(!subjects(owner.email).some((s) => /is cancelled/.test(s)));
  // The owner can.
  const c2 = new Client();
  c2.ip = '203.0.113.242';
  assert.equal((await c2.post('/public/billing/stop-by-card', { email: owner.email, last4: '4242' })).status, 200);
});

test('find my subscription does not say "not charging you" while the end of a plan is still being confirmed', async () => {
  const p = await person('Queued');
  await subscribe(p);
  stripe.fail('DELETE', new RegExp(`^subscriptions/${p.sub}$`), 3);
  stripe.fail('GET', new RegExp(`^subscriptions/${p.sub}$`), 3);
  const close = billing.stopBillingFor(acct(p.id));
  assert.equal(await close, false);
  assert.ok(db.get("SELECT 1 x FROM billing_todo WHERE kind='cancel' AND account_id=? AND done_at IS NULL", p.id));
  stripe.failing.length = 0;
  const c = new Client();
  c.ip = '203.0.113.172';
  await c.post('/public/billing/find', { email: p.email });
  const mail = lastMail(p.email, 'Your Sign&Grow subscriptions')!;
  assert.doesNotMatch(mail, /not charging you/);
  assert.match(mail, /has not confirmed that yet/);
});

test('closing an account at once while a refund is on its way: the email says it still reaches the card', async () => {
  const p = await person('CloseOpen');
  await subscribe(p);
  stripe.charges.unshift({ id: 'ch_cs7_close', payment_intent: 'pi_cs7_close', paid: true, refunded: false, amount: 3000, customer: p.cus, last4: '4242', created: unix(0) });
  await event('checkout.session.completed', { id: 'cs7_close', mode: 'payment', client_reference_id: p.id, customer: p.cus, payment_status: 'paid', amount_total: 3000, currency: 'usd', payment_intent: 'pi_cs7_close', metadata: { kind: 'sg_topup', credits: '30', sg_account: p.id } });
  stripe.fail('POST', /^refunds$/, 1, 'busy', 503);
  const rf = await p.c.post('/billing/refund');
  assert.equal(rf.data.pending, true, JSON.stringify(rf.data));
  const ref = db.get("SELECT id FROM refunds WHERE payment_id='cs7_close'").id;
  const del = await p.c.post('/me/delete', { password: 'correct horse battery', now: true });
  assert.equal(del.data.closed, 'now', JSON.stringify(del.data));
  const mail = text(db.get("SELECT html FROM emails WHERE to_email=? AND subject='Your Sign&Grow account is closed' ORDER BY id DESC LIMIT 1", p.email)?.html || '');
  assert.match(mail, /A refund of \$30\.00 \(reference rf_[\w-]+\) is still on its way to the card it was paid with\. It goes through even though the account is deleted/);
  assert.ok(mail.includes(ref));
});

// ---- A provider account shared with something else --------------------------------------------------------------

test('other products\' invoices never take the timer\'s places, and ours waiting is never deleted', async () => {
  for (let i = 0; i < 45; i++) {
    const o = { id: `in7_other_${i}`, customer: `cus7_stranger_${i}`, subscription: `sub7_stranger_${i}`, amount_paid: 2900, currency: 'usd', status: 'paid', billing_reason: 'subscription_cycle', lines: { data: [{ price: { id: 'price_other_product' }, period: { start: unix(0), end: unix(30) } }] } };
    stripe.invoices[o.id] = o;
    await event('invoice.paid', o);
  }
  db.run("UPDATE payments SET at=? WHERE id LIKE 'in7_other_%'", ago(10 * 864e5));
  assert.equal(db.get("SELECT COUNT(*) n FROM payments WHERE id LIKE 'in7_other_%' AND kind='not_ours'").n, 45);
  const p = await person('Starved');
  // Our first payment arrives before its checkout and names nothing; the checkout is reported while invoices cannot be read.
  await event('invoice.paid', invoice(p, 'in7_starved', { subscription: null, lines: { data: [{ period: { start: unix(0), end: unix(30) } }] } }));
  stripe.fail('GET', /^invoices\//, 2);
  Object.assign(stripe.sub(p.sub), { customer: p.cus, metadata: { sg_account: p.id } });
  await event('checkout.session.completed', checkout(p, { invoice: 'in7_starved' }));
  stripe.failing.length = 0;
  assert.equal(pay('in7_starved').kind, 'unknown');
  db.run('UPDATE payments SET at=? WHERE id=?', ago(2 * 864e5), 'in7_starved');
  const from = stripe.calls.length;
  await cron.tick();
  const asked = stripe.calls.slice(from).filter((c) => c[0] === 'GET' && c[1].startsWith('invoices/'));
  assert.ok(!asked.some((c) => c[1].startsWith('invoices/in7_other_')), 'nobody else\'s invoice was looked up');
  assert.ok(pay('in7_starved').applied_at, 'ours was looked up and applied');
  assert.equal((await bal(p)).balance, 12);

  // A payment kept aside whose customer is one of ours stays past 90 days; one of a stranger goes.
  db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, kind, credits, customer_id) VALUES ('in7_old_ours', NULL, 900, 'usd', ?, 'unknown', 0, ?)", ago(91 * 864e5), p.cus);
  db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, kind, credits, customer_id) VALUES ('in7_old_theirs', NULL, 900, 'usd', ?, 'unknown', 0, 'cus7_nobody')", ago(91 * 864e5));
  stripe.fail('GET', /^invoices\/in7_old_ours$/, 5);
  await cron.tick();
  stripe.failing.length = 0;
  assert.ok(pay('in7_old_ours'), 'ours is kept until it is settled');
  assert.equal(pay('in7_old_theirs'), null);
});

test('an invoice for another price is not taken for our plan, and another product\'s one-off invoice is not a top-up\'s receipt', async () => {
  const p = await person('NotOurs');
  await subscribe(p);
  const before = (await bal(p)).balance;
  stripe.subs[p.sub].status = 'active';
  const other = { id: 'in7_other_cycle', customer: p.cus, amount_paid: 4900, currency: 'usd', status: 'paid', billing_reason: 'subscription_cycle', lines: { data: [{ price: { id: 'price_other_product' }, period: { start: unix(0), end: unix(30) } }] } };
  stripe.invoices[other.id] = other;
  await event('invoice.paid', other);
  assert.equal((await bal(p)).balance, before, 'no signatures for it');
  assert.equal(pay('in7_other_cycle').kind, 'not_ours');
  assert.ok(!stripe.refunds.some((r) => r.params.amount === '4000'), 'none of its money was refunded');
  // A $10 top-up of ours, whose own checkout has no invoice yet, and a $10 one-off invoice of something else.
  stripe.charges.unshift({ id: 'ch_cs7_top10', payment_intent: 'pi_cs7_top10', paid: true, refunded: false, amount: 1000, customer: p.cus, last4: '4242', created: unix(0) });
  await event('checkout.session.completed', { id: 'cs7_top10', mode: 'payment', client_reference_id: p.id, customer: p.cus, payment_status: 'paid', amount_total: 1000, currency: 'usd', payment_intent: 'pi_cs7_top10', metadata: { kind: 'sg_topup', credits: '10', sg_account: p.id } });
  const manual = { id: 'in7_other_manual', customer: p.cus, amount_paid: 1000, currency: 'usd', status: 'paid', billing_reason: 'manual', hosted_invoice_url: 'https://pay.example/OTHER-PRODUCT-INVOICE', lines: { data: [{ price: { id: 'price_other_oneoff' } }] } };
  stripe.invoices[manual.id] = manual;
  await event('invoice.paid', manual);
  assert.equal(pay('cs7_top10').receipt_url, null, 'not the receipt of our top-up');
});

// ---- Public forms ---------------------------------------------------------------------------------------------

const sigField = (rid: string, y = 0.5) => ({ id: `f_${rid}`, document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y, w: 0.3, h: 0.06 });
const textField = (rid: string) => ({ id: `t_${rid}`, document_id: 'd', recipient_id: rid, type: 'text', label: 'Your answer', page: 0, x: 0.5, y: 0.2, w: 0.3, h: 0.03 });
async function form(p: Person, recipients: any[], name = 'Join us') {
  const file = await upload(p.c, 1);
  const t = await p.c.post('/envelopes', { kind: 'template', subject: 'Join', documents: [{ id: 'd', file_id: file.id }], recipients, fields: recipients.filter((r) => r.role === 'signer').flatMap((r, i) => [sigField(r.id, 0.4 + i * 0.1), textField(r.id)]) });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const made = await p.c.post('/powerforms', { template_id: t.data.envelope.id, name });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  return (await p.c.get('/powerforms')).data.powerforms.find((x: any) => x.id === made.data.id).slug as string;
}
let ipn = 20;
async function visit(slug: string, name: string, email: string) {
  const v = new Client();
  v.ip = `203.0.117.${ipn++}`;
  const st = await v.post(`/public/powerforms/${slug}/start`, { name, email });
  const tok = st.data?.url ? String(st.data.url).split('/sign/')[1] : null;
  return { v, st, tok };
}
async function finish(v: Client, tok: string, answer = 'my answer') {
  await v.post(`/sign/${tok}/consent`);
  const view = (await v.get(`/sign/${tok}`)).data;
  const values: Record<string, string> = {};
  for (const f of view.fields || []) values[f.id] = f.type === 'text' ? answer : '1';
  return v.post(`/sign/${tok}/complete`, { values, signature_png: PNG, initials_png: PNG, version: view.version ?? view.content_version });
}

test('a form visitor told that what they filled in is kept does not lose it to the idle timer, and is emailed once they can finish', async () => {
  const p = await person('FormIdle');
  adjust(p.id, -2, 'leave2'); // 1 left
  const slug = await form(p, [{ id: 'r', role: 'signer', role_name: 'Member' }]);
  const a = await visit(slug, 'Takes Last', 'idle7a@seven.example');
  const b = await visit(slug, 'Comes Back', 'idle7b@seven.example');
  assert.equal((await finish(a.v, a.tok!)).status, 200);
  const refused = await finish(b.v, b.tok!, 'my long careful answer');
  assert.equal(refused.status, 503);
  assert.match(refused.data.error, /Everything you filled in is saved, and it stays saved while you wait, until .+\. We email you at idle7b@seven\.example once the form can take your signature\. Then open the same link and press Finish\./);
  const eid = db.get("SELECT e.id FROM envelopes e JOIN recipients r ON r.envelope_id=e.id WHERE r.email='idle7b@seven.example'").id;
  // A day and more later, nobody has touched it.
  db.run('UPDATE audit SET at=? WHERE envelope_id=?', ago(25 * 3600_000), eid);
  db.run('UPDATE envelopes SET sent_at=? WHERE id=?', ago(25 * 3600_000), eid);
  db.run('UPDATE recipients SET touched_at=? WHERE envelope_id=? AND touched_at IS NOT NULL', ago(25 * 3600_000), eid);
  await cron.tick();
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', eid).status, 'sent', 'still open');
  assert.ok(!subjects('idle7b@seven.example').some((s) => s.startsWith('You can finish')), 'nothing to say while none is free');
  // The owner adds signatures: the visitor is emailed once, and finishes with the same link.
  adjust(p.id, 5, 'topup7');
  await cron.tick();
  await cron.tick();
  assert.equal(subjects('idle7b@seven.example').filter((s) => s.startsWith('You can finish')).length, 1);
  assert.match(lastMail('idle7b@seven.example', 'You can finish')!, /Everything you filled in is still there/);
  assert.equal(db.get("SELECT value FROM fields WHERE envelope_id=? AND type='text'", eid).value, 'my long careful answer');
  assert.equal((await finish(b.v, b.tok!, 'my long careful answer')).status, 200);
});

test('a form whose template has a second signer is refused at start only when what is free does not cover both', async () => {
  const p = await person('TwoRole');
  adjust(p.id, -2, 'leave2'); // 1 left
  const slug = await form(p, [{ id: 'r', role: 'signer', role_name: 'Member' }, { id: 'c', role: 'signer', name: 'Colleague Countersign', email: 'colleague7@seven.example' }]);
  const one = await visit(slug, 'First Visitor', 'two7a@seven.example');
  assert.equal(one.st.status, 503);
  const owner = lastMail(p.email, 'Your form "Join us" has run out of signatures')!;
  assert.match(owner, /\(2 signatures for each visitor, because the form has other signers too\), and only 1 is free right now/);
  assert.match(owner, /stopped before they filled anything in/);
  adjust(p.id, 1, 'one-more'); // 2 free
  db.run('UPDATE powerforms SET alerted_at=NULL');
  const two = await visit(slug, 'Second Visitor', 'two7b@seven.example');
  assert.equal(two.st.status, 200, JSON.stringify(two.st.data));
});

test('when public forms use the balance down to two and to none, the low-balance emails go out', async () => {
  const p = await person('FormLow'); // 3 welcome signatures
  const slug = await form(p, [{ id: 'r', role: 'signer', role_name: 'Member' }], 'Sign up');
  for (let i = 0; i < 3; i++) {
    const v = await visit(slug, `Low Visitor ${i}`, `low7${i}@seven.example`);
    assert.equal((await finish(v.v, v.tok!)).status, 200);
  }
  const subs = subjects(p.email);
  assert.ok(subs.includes('2 signatures left'), JSON.stringify(subs));
  assert.ok(subs.includes('You have used all your signatures'), JSON.stringify(subs));
  assert.match(lastMail(p.email, '2 signatures left')!, /after Low Visitor 0 signed your public form "Sign up"/);
});

// ---- One signature per person ---------------------------------------------------------------------------------

async function envelope(p: Person, recipients: any[]) {
  const file = await upload(p.c, 1);
  const made = await p.c.post('/envelopes', { subject: 'Shared inbox', documents: [{ id: 'd', file_id: file.id }], recipients, fields: recipients.map((r, i) => sigField(r.id, 0.2 + i * 0.15)) });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal((await p.c.post(`/envelopes/${made.data.envelope.id}/send`)).status, 200);
  return made.data.envelope.id as string;
}
const rcp = (eid: string, email: string) => db.get('SELECT * FROM recipients WHERE envelope_id=? AND email=?', eid, email);
const used = (p: Person) => db.get("SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature'", p.id).n;
const signAgain = async (p: Person, eid: string) => {
  const full = (await p.c.get(`/envelopes/${eid}`)).data.envelope;
  return p.c.put(`/envelopes/${eid}`, { ...full, fields: [...full.fields, { id: `n${Date.now()}`, document_id: full.documents[0].id, type: 'note', value: 'Changed', page: 0, x: 0.5, y: 0.8, w: 0.3, h: 0.03 }], resign: true });
};

test('another person at the same address never signs on the first person\'s signature', async () => {
  // Edit envelope with "sign again": Ann's request goes to Bob at the same inbox.
  const p = await person('SameBox');
  adjust(p.id, -2, 'leave2'); // 1 left
  const e1 = await envelope(p, [{ id: 'r1', role: 'signer', name: 'Ann Smith', email: 'office7@seven.example' }, { id: 'r2', role: 'signer', name: p.name, email: p.email }]);
  assert.equal((await signAll(e1, 'office7@seven.example')).status, 200);
  assert.equal((await bal(p)).available, 0);
  const full = (await p.c.get(`/envelopes/${e1}`)).data.envelope;
  full.recipients.find((r: any) => r.email === 'office7@seven.example').name = 'Bob Jones';
  const put = await p.c.put(`/envelopes/${e1}`, { ...full, resign: true });
  assert.equal(put.status, 402, JSON.stringify(put.data));
  assert.equal(rcp(e1, 'office7@seven.example').name, 'Ann Smith', 'nothing was changed');
  // A spelling of the same name is the same person: asked to sign again, it is free.
  const fix = (await p.c.get(`/envelopes/${e1}`)).data.envelope;
  fix.recipients.find((r: any) => r.email === 'office7@seven.example').name = 'Ann  Smith';
  assert.equal((await p.c.put(`/envelopes/${e1}`, { ...fix, resign: true })).status, 200);
  assert.equal((await signAll(e1, 'office7@seven.example')).status, 200);
  assert.equal(used(p), 1, 'signing again after a change uses nothing more');

  // "Correct" after sign again, to a different person at the same address.
  const q = await person('Point6');
  adjust(q.id, -2, 'leave2');
  const e2 = await envelope(q, [{ id: 'r1', role: 'signer', name: 'Ann Smith', email: 'shared7@seven.example' }, { id: 'r2', role: 'signer', name: q.name, email: q.email }]);
  await signAll(e2, 'shared7@seven.example');
  assert.equal((await signAgain(q, e2)).status, 200);
  const fixd = await q.c.post(`/envelopes/${e2}/correct`, { recipient_id: rcp(e2, 'shared7@seven.example').id, name: 'Zed Quartermaine' });
  assert.equal(fixd.status, 402, JSON.stringify(fixd.data));
  // With a signature free, the same correction goes through and Zed's signature is his own.
  adjust(q.id, 1, 'one-more');
  assert.equal((await q.c.post(`/envelopes/${e2}/correct`, { recipient_id: rcp(e2, 'shared7@seven.example').id, name: 'Zed Quartermaine' })).status, 200);
  assert.equal((await bal(q)).available, 0, 'his signature is held');
  assert.equal((await signAll(e2, 'shared7@seven.example')).status, 200);
  assert.equal(used(q), 2, 'two people, two signatures');

  // The re-signer's own hand-over to a colleague at the same inbox.
  const s = await person('HandOver');
  adjust(s.id, -2, 'leave2');
  const e3 = await envelope(s, [{ id: 'r1', role: 'signer', name: 'Ann Smith', email: 'desk7@seven.example' }, { id: 'r2', role: 'signer', name: s.name, email: s.email }]);
  await signAll(e3, 'desk7@seven.example');
  assert.equal((await signAgain(s, e3)).status, 200);
  const sc = new Client();
  const tok = rcp(e3, 'desk7@seven.example').token;
  await sc.post(`/sign/${tok}/consent`);
  const re = await sc.post(`/sign/${tok}/reassign`, { name: 'Other Colleague', email: 'desk7@seven.example', reason: 'my colleague signs' });
  assert.equal(re.status, 402, JSON.stringify(re.data));
});
