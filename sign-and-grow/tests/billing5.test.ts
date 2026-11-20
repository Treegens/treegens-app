// Billing, fifth round: the last three open ends of the payment code. The provider is answered quickly and its
// message is kept until it has been applied; a plan on hold has a real way back; and an invoice that names no
// subscription is matched by asking the provider instead of being refunded.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, Client, signUp, mailTo, draft, signAll, type Server } from './helpers.ts';
import { stripe, unix } from './stripe-fake.ts';

let db: Server['db'];
let billing: Server['billing'];
let cron: Server['cron'];

const SECRET = 'whsec_round5';
const event = (type: string, object: any, extra: any = {}) => billing.applyStripeEvent({ type, data: { object }, ...extra });
// A message as the provider sends it: signed, to the public address.
async function deliver(id: string, type: string, object: any) {
  const body = { id, type, data: { object } };
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', SECRET).update(`${t}.${JSON.stringify(body)}`).digest('hex');
  const started = Date.now();
  const r = await new Client().call('POST', '/stripe/webhook', body, { 'stripe-signature': `t=${t},v1=${sig}` });
  return { ...r, ms: Date.now() - started };
}
const acct = (id: string) => db.get('SELECT * FROM accounts WHERE id=?', id);
const pay = (id: string) => db.get('SELECT * FROM payments WHERE id=?', id);
const inbox = () => db.all('SELECT id, tries, error FROM stripe_inbox ORDER BY at');
const alerts = () => db.all("SELECT message FROM support_requests WHERE topic='billing' ORDER BY rowid").map((r: any) => r.message as string);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

type Person = { c: Client; id: string; name: string; email: string; cus: string; sub: string; k: number };
let n = 0;
async function person(first: string): Promise<Person> {
  const k = ++n;
  const email = `${first.toLowerCase()}${k}@five.example`;
  const name = `${first} Tester`;
  const c = await signUp(name, email, `198.51.105.${k}`);
  return { c, id: (await c.get('/me')).data.account.id, name, email, cus: `cus5_${k}`, sub: `sub5_${k}`, k };
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
const checkout = (p: Person, over: any = {}) => ({ id: `cs5_${p.k}`, mode: 'subscription', client_reference_id: p.id, customer: p.cus, subscription: p.sub, payment_status: 'paid', ...over });
async function subscribe(p: Person, inv = `in5_${p.k}_1`) {
  await event('checkout.session.completed', checkout(p));
  await event('invoice.paid', invoice(p, inv));
}
const bal = async (p: Person) => (await p.c.get('/billing')).data.signatures;
const state = async (p: Person) => (await p.c.get('/billing')).data;

before(async () => {
  ({ db, billing, cron } = await boot());
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});

test('the provider is answered quickly, and its message is kept until it has been applied', async () => {
  process.env.STRIPE_WEBHOOK_WAIT_MS = '80';
  try {
    // Ordinary case: applied before the answer, nothing left in the inbox.
    const a = await person('Quick');
    const one = await deliver('evt5_a_cs', 'checkout.session.completed', checkout(a));
    assert.deepEqual([one.status, one.data], [200, { received: true, applied: true }]);
    const two = await deliver('evt5_a_inv', 'invoice.paid', invoice(a, 'in5_a'));
    assert.deepEqual(two.data, { received: true, applied: true });
    assert.equal((await bal(a)).balance, 12);
    assert.deepEqual(inbox(), []);
    // Sent again by the provider: answered, applied once.
    assert.equal((await deliver('evt5_a_inv', 'invoice.paid', invoice(a, 'in5_a'))).status, 200);
    assert.equal((await bal(a)).balance, 12);
    assert.deepEqual(inbox(), []);

    // A bad signature gets nothing in.
    const bad = await new Client().call('POST', '/stripe/webhook', { id: 'evt5_forged', type: 'invoice.paid', data: { object: {} } }, { 'stripe-signature': 't=1,v1=00' });
    assert.equal(bad.status, 400);
    assert.deepEqual(inbox(), []);

    // The payment provider is slow while this message is worked on. The answer does not wait for it: it says
    // "received", the message stays in the inbox, and it is finished in the background.
    const b = await person('Slow');
    await deliver('evt5_b_cs', 'checkout.session.completed', checkout(b));
    stripe.delayMs = 150;
    const slow = await deliver('evt5_b_inv', 'invoice.paid', invoice(b, 'in5_b', { subscription: 'sub5_b_other' }));
    assert.deepEqual([slow.status, slow.data], [200, { received: true, applied: false }]);
    assert.ok(slow.ms < 140, `answered in ${slow.ms} ms, before the provider call returned`);
    assert.deepEqual(inbox().map((r: any) => r.id), ['evt5_b_inv']);
    // The same message arrives a second time while the first is still being worked on.
    const dup = await deliver('evt5_b_inv', 'invoice.paid', invoice(b, 'in5_b', { subscription: 'sub5_b_other' }));
    assert.equal(dup.status, 200);
    for (let i = 0; i < 100 && inbox().length; i++) await sleep(50);
    stripe.delayMs = 0;
    assert.deepEqual(inbox(), [], 'finished in the background and taken out');
    assert.equal(db.get('SELECT COUNT(*) n FROM payments WHERE id=?', 'in5_b').n, 1);
    assert.ok(pay('in5_b').applied_at, 'applied once');

    // Applying fails while the provider is still waiting: it gets an error, so it sends the message again, and the
    // message is in the inbox with what went wrong, so we try again ourselves as well.
    const c = await person('Fails');
    await deliver('evt5_c_cs', 'checkout.session.completed', checkout(c));
    stripe.fail('GET', /^subscriptions\/sub5_c_new$/, 1);
    const failed = await deliver('evt5_c_inv', 'invoice.paid', invoice(c, 'in5_c', { subscription: 'sub5_c_new', billing_reason: 'subscription_cycle' }));
    assert.equal(failed.status, 502);
    assert.equal(inbox().length, 1);
    assert.equal(inbox()[0].tries, 1);
    assert.ok(inbox()[0].error);
    // Not tried again at once (the gap grows with every try), and then applied by the timer.
    await cron.tick();
    assert.equal(inbox().length, 1);
    db.run("UPDATE stripe_inbox SET at=?, last_at=?", new Date(Date.now() - 20 * 60_000).toISOString(), new Date(Date.now() - 10 * 60_000).toISOString());
    await cron.tick();
    assert.deepEqual(inbox(), []);
    assert.ok(pay('in5_c').applied_at);

    // The server stopped between "received" and "applied": the row is all that is left. The timer applies it.
    const d = await person('Restart');
    await event('checkout.session.completed', checkout(d));
    const lost = { id: 'evt5_d_inv', type: 'invoice.paid', data: { object: invoice(d, 'in5_d') } };
    db.run('INSERT INTO stripe_inbox (id, body, at) VALUES (?,?,?)', lost.id, JSON.stringify(lost), new Date(Date.now() - 5 * 60_000).toISOString());
    assert.equal((await bal(d)).balance, 3);
    await cron.tick();
    assert.equal((await bal(d)).balance, 12);
    assert.deepEqual(inbox(), []);
    // One that only just arrived is left to the request that is working on it.
    db.run('INSERT INTO stripe_inbox (id, body, at) VALUES (?,?,?)', 'evt5_fresh', JSON.stringify({ id: 'evt5_fresh', type: 'ping', data: { object: {} } }), new Date().toISOString());
    await cron.tick();
    assert.deepEqual(inbox().map((r: any) => r.id), ['evt5_fresh']);
    db.run('DELETE FROM stripe_inbox');

    // A message that cannot be applied for three days is dropped, and a person is told which one.
    db.run('INSERT INTO stripe_inbox (id, body, at, tries, last_at, error) VALUES (?,?,?,?,?,?)', 'evt5_stuck', JSON.stringify({ id: 'evt5_stuck', type: 'invoice.paid', data: { object: {} } }),
      new Date(Date.now() - 3.1 * 864e5).toISOString(), 14, new Date(Date.now() - 3600_000).toISOString(), 'The payment provider is having trouble.');
    const before = alerts().length;
    await cron.tick();
    assert.deepEqual(inbox(), []);
    assert.match(alerts().slice(before).join('\n'), /could not be applied for three days[\s\S]*evt5_stuck \(invoice\.paid\)[\s\S]*The payment provider is having trouble/);
  } finally {
    stripe.delayMs = 0;
    delete process.env.STRIPE_WEBHOOK_WAIT_MS;
  }
});

test('a plan on hold says what really brings it back, and the open payment can be paid from the Plan page', async () => {
  const p = await person('Hold');
  await subscribe(p);
  // No open payment while all is well.
  assert.equal((await state(p)).can_pay_open, false);
  // The card fails for a renewal and the provider gives up: the plan is on hold.
  Object.assign(stripe.sub(p.sub), { status: 'unpaid', latest_invoice: 'in5_open' });
  stripe.invoices['in5_open'] = { id: 'in5_open', customer: p.cus, subscription: p.sub, status: 'open', amount_due: 900, amount_remaining: 900, currency: 'usd', hosted_invoice_url: 'https://pay.example/invoice/in5_open' };
  await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'unpaid', current_period_end: unix(30), metadata: { sg_account: p.id } }, { created: unix(0) });
  const s = await state(p);
  assert.equal(s.problem, 'unpaid');
  assert.equal(s.can_pay_open, true);
  const mail = mailTo(p.email).find((m: any) => m.subject === 'Your monthly plan is on hold');
  assert.ok(mail);
  assert.match(text(mail.html), /press "Pay the open payment"\. You can use another card there\. A new card on file is not enough by itself/);
  assert.doesNotMatch(text(mail.html), /update the card on the Plan page/);

  // An admin gets the provider's own page for that invoice. Nobody else does.
  const open = await p.c.post('/billing/pay-open');
  assert.deepEqual([open.status, open.data], [200, { url: 'https://pay.example/invoice/in5_open', amount: '$9.00' }]);
  const key = (await p.c.post('/api-keys', { name: 'k', scope: 'admin' })).data.key;
  const keyed = await new Client().call('POST', '/billing/pay-open', undefined, { authorization: `Bearer ${key}` });
  assert.equal(keyed.status, 403);
  assert.equal((await new Client().post('/billing/pay-open')).status, 401);

  // It is paid there. Coming back and pressing the button again does not offer the same payment: the plan is read
  // back, the signatures for the paid month are added once, and the answer says nothing is waiting.
  const before = (await bal(p)).balance;
  Object.assign(stripe.sub(p.sub), { status: 'active', current_period_end: unix(30) });
  Object.assign(stripe.invoices['in5_open'], { status: 'paid', amount_paid: 900, amount_remaining: 0, billing_reason: 'subscription_cycle',
    lines: { data: [{ period: { start: unix(0), end: unix(30) }, metadata: { sg_account: p.id }, price: { id: 'price_grove' } }] } });
  stripe.charges.unshift({ id: 'ch_in5_open', paid: true, refunded: false, amount: 900, currency: 'usd', customer: p.cus, invoice: 'in5_open', last4: '4242', created: unix(0) });
  const again = await p.c.post('/billing/pay-open');
  assert.equal(again.status, 409);
  assert.match(again.data.error, /has gone through in the meantime, so nothing is waiting to be paid/);
  const after = await state(p);
  assert.deepEqual([after.plan, after.problem, after.can_pay_open], ['grove', null, false]);
  assert.equal((await bal(p)).balance, before + 9);
  // The provider's own message about that payment arrives later and adds nothing twice.
  await event('invoice.paid', stripe.invoices['in5_open']);
  assert.equal((await bal(p)).balance, before + 9);

  // An account with no plan has nothing to pay.
  const q = await person('Noplan');
  const none = await q.c.post('/billing/pay-open');
  assert.equal(none.status, 400);
  assert.match(none.data.error, /no payment waiting/);
});

test('an invoice that names no subscription is matched by asking the provider what the customer is subscribed to', async () => {
  // A returning customer: the old plan ended, a new one was started, and the invoice for it arrives in a shape that
  // names no subscription at all, before the checkout is reported.
  const p = await person('Back');
  await subscribe(p);
  assert.equal((await p.c.post('/billing/cancel')).status, 200);
  stripe.sub(p.sub).status = 'canceled';
  Object.assign(stripe.sub(p.sub), { customer: p.cus });
  await event('customer.subscription.deleted', { id: p.sub, customer: p.cus, status: 'canceled' });
  assert.equal(acct(p.id).subscription_status, 'canceled');
  const kept = (await bal(p)).balance;
  const again = { ...p, sub: 'sub5_back_new' };
  Object.assign(stripe.sub(again.sub), { customer: p.cus, status: 'active', metadata: { sg_account: p.id }, items: { data: [{ price: { id: 'price_grove' } }] } });
  const bare = invoice(again, 'in5_back2', { subscription: undefined, lines: { data: [{ period: { start: unix(0), end: unix(30) } }] } });
  await event('invoice.paid', bare);
  assert.equal(stripe.refunded('ch_in5_back2'), 0, 'not sent back as "already cancelled"');
  assert.equal((await bal(p)).balance, kept + 9);
  assert.deepEqual([acct(p.id).plan, acct(p.id).stripe_subscription_id, acct(p.id).subscription_status], ['grove', 'sub5_back_new', 'active']);
  assert.equal(pay('in5_back2').refunded_cents || 0, 0);
  // The checkout is reported afterwards and changes nothing.
  await event('checkout.session.completed', checkout(again, { id: 'cs5_back2' }));
  assert.equal((await bal(p)).balance, kept + 9);
  assert.ok(!mailTo(p.email).some((m: any) => /^Refund/.test(m.subject)));

  // When the customer really is subscribed to nothing any more, such an invoice still goes back.
  const q = await person('Gone');
  await subscribe(q);
  assert.equal((await q.c.post('/billing/cancel')).status, 200);
  Object.assign(stripe.sub(q.sub), { customer: q.cus, status: 'canceled' });
  await event('customer.subscription.deleted', { id: q.sub, customer: q.cus, status: 'canceled' });
  await event('invoice.paid', invoice(q, 'in5_gone2', { subscription: undefined, billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: unix(0), end: unix(30) } }] } }));
  assert.equal(stripe.refunded('ch_in5_gone2'), 900);
  assert.equal(acct(q.id).plan, 'seedling');

  // A subscription on the same provider account that is not ours (another product, another price) is never adopted.
  const r = await person('Other');
  await subscribe(r);
  assert.equal((await r.c.post('/billing/cancel')).status, 200);
  Object.assign(stripe.sub(r.sub), { customer: r.cus, status: 'canceled' });
  await event('customer.subscription.deleted', { id: r.sub, customer: r.cus, status: 'canceled' });
  Object.assign(stripe.sub('sub5_other_product'), { customer: r.cus, status: 'active', metadata: {}, items: { data: [{ price: { id: 'price_something_else' } }] } });
  const was = (await bal(r)).balance;
  await event('invoice.paid', invoice(r, 'in5_other2', { subscription: undefined, billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: unix(0), end: unix(30) }, price: { id: 'price_something_else' } }] } }));
  assert.equal(acct(r.id).plan, 'seedling');
  assert.notEqual(acct(r.id).stripe_subscription_id, 'sub5_other_product');
  assert.equal((await bal(r)).balance, was);
});

test('the price never goes up without thirty days of notice: a renewal above the price an account is on refunds the difference', async () => {
  const p = await person('Priced');
  await subscribe(p);
  assert.equal(acct(p.id).price_cents, 900);
  let s = await state(p);
  assert.deepEqual([s.plan_price, s.price_change], ['$9.00', null]);
  assert.match(s.price_rule, /at least 30 days before the first renewal at the new price/);
  const renewal = (inv: string, cents: number) => invoice(p, inv, { amount_paid: cents, billing_reason: 'subscription_cycle' });
  const refundMails = () => mailTo(p.email).filter((m: any) => /^Refund/.test(m.subject));

  // The price is raised with the payment provider and nobody was told. The renewal is held to $9: the customer
  // gets the full month, the $3 comes back by itself, and a person is told what to do first next time.
  let had = (await bal(p)).balance;
  let seen = alerts().length;
  await event('invoice.paid', renewal('in5_price_2', 1200));
  assert.equal(stripe.refunded('ch_in5_price_2'), 300);
  assert.equal((await bal(p)).balance, had + 9);
  assert.equal(acct(p.id).price_cents, 900, 'still on the price they were on');
  assert.match(text(refundMails().at(-1)!.html), /the price went up without the 30 days' notice we promise, so you pay the price you were on: \$9\.00, not \$12\.00/);
  assert.match(alerts().slice(seen).join('\n'), /charged more than we told them[\s\S]*has not had 30 days' notice of a higher price\. Announce a price change on the operator page/);

  // Announcing a price is for operators, and never with less than thirty days to go.
  const body = (days: number, usd = 12) => ({ new_usd: usd, from: new Date(Date.now() + days * 864e5).toISOString().slice(0, 10) });
  assert.equal((await p.c.post('/operator/billing/price-notice', body(40))).status, 404);
  process.env.OPERATOR_EMAILS = p.email;
  try {
    const soon = await p.c.post('/operator/billing/price-notice', body(20));
    assert.equal(soon.status, 400);
    assert.match(soon.data.error, /Everyone on the plan is promised 30 days' notice/);
    assert.equal((await p.c.post('/operator/billing/price-notice', { new_usd: 'lots', from: '2030-01-01' })).status, 400);
    const mailsBefore = mailTo(p.email).length;
    const told = await p.c.post('/operator/billing/price-notice', body(40));
    assert.equal(told.status, 200, JSON.stringify(told.data));
    assert.ok(told.data.told >= 1);
    assert.deepEqual(told.data.not_told, []);
    const notice = mailTo(p.email).slice(mailsBefore).find((m: any) => /^The price of your Sign&Grow plan changes on /.test(m.subject));
    assert.ok(notice, 'the owner is told by email');
    const t = text(notice.html);
    assert.match(t, /Today Priced's workspace pays \$9\.00 a month\. From .* the monthly plan costs \$12\.00 a month/);
    assert.match(t, /stop the plan with the button below/);
    assert.match(notice.link || '', /\/billing\/stop\?token=/);
    assert.doesNotMatch(t, /—/);
    // Someone on the free code and someone with no plan hear nothing.
    // Sent again by mistake: nobody is emailed twice.
    const again = await p.c.post('/operator/billing/price-notice', body(40));
    assert.equal(again.data.told, 0);
    assert.ok(again.data.already_told >= 1);
    assert.equal(mailTo(p.email).filter((m: any) => /^The price of your Sign&Grow plan changes on /.test(m.subject)).length, 1);
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
  s = await state(p);
  assert.deepEqual([s.price_change.now, s.price_change.next, s.plan_price], ['$9.00', '$12.00', '$9.00']);
  assert.ok(s.history.some((h: any) => h.label === 'Price change announced'));

  // A renewal before the announced day is still held to the old price.
  had = (await bal(p)).balance;
  await event('invoice.paid', renewal('in5_price_3', 1200));
  assert.equal(stripe.refunded('ch_in5_price_3'), 300);
  assert.equal((await bal(p)).balance, had + 9);

  // A week before a renewal the provider says $12 is coming, and the day has not come: the reminder says what the
  // customer will end up paying, and a person is told while there is still time to put it right.
  db.run('UPDATE accounts SET renews_at=?, renewal_reminded=NULL, renewal_quoted_cents=NULL WHERE id=?', new Date(Date.now() + 6 * 864e5).toISOString(), p.id);
  seen = alerts().length;
  await event('invoice.upcoming', { customer: p.cus, subscription: p.sub, amount_due: 1200, currency: 'usd', next_payment_attempt: unix(6) });
  const heads = mailTo(p.email).filter((m: any) => /^Heads up: your plan renews/.test(m.subject)).at(-1)!;
  assert.ok(heads, 'a reminder went out');
  assert.match(heads.subject + text(heads.html), /\$9\.00/);
  assert.doesNotMatch(heads.subject + text(heads.html), /\$12\.00/);
  assert.match(alerts().slice(seen).join('\n'), /is set above the price they are on[\s\S]*will charge \$12\.00/);

  // Notice that was given less than thirty days before its day does not count, however it got there.
  db.run('UPDATE accounts SET price_notice_at=?, price_notice_from=? WHERE id=?', new Date(Date.now() - 10 * 864e5).toISOString(), new Date(Date.now() - 5 * 864e5).toISOString(), p.id);
  await event('invoice.paid', renewal('in5_price_4', 1200));
  assert.equal(stripe.refunded('ch_in5_price_4'), 300);

  // Thirty-five days after the notice the announced day has passed. The renewal at the new price stands: nothing is
  // refunded, the month is added in full, and the account is on the new price from here.
  db.run('UPDATE accounts SET price_notice_at=?, price_notice_from=? WHERE id=?', new Date(Date.now() - 40 * 864e5).toISOString(), new Date(Date.now() - 5 * 864e5).toISOString(), p.id);
  had = (await bal(p)).balance;
  const refundsBefore = refundMails().length;
  await event('invoice.paid', renewal('in5_price_5', 1200));
  assert.equal(stripe.refunded('ch_in5_price_5'), 0);
  assert.equal((await bal(p)).balance, had + 9);
  assert.equal(refundMails().length, refundsBefore);
  const after = acct(p.id);
  assert.deepEqual([after.price_cents, after.price_notice_cents, after.price_notice_from], [1200, null, null]);
  s = await state(p);
  assert.deepEqual([s.plan_price, s.price_change], ['$12.00', null]);

  // A smaller invoice that is a one-off says nothing about next month: part of a month after a change, or a
  // discount. The account stays on its price, and the next ordinary renewal is not "more than they were on".
  await event('invoice.paid', invoice(p, 'in5_price_part', { amount_paid: 200, billing_reason: 'subscription_update' }));
  assert.equal(acct(p.id).price_cents, 1200);
  await event('invoice.paid', renewal('in5_price_disc', 600));
  assert.equal(acct(p.id).price_cents, 1200);
  await event('invoice.paid', renewal('in5_price_7', 1200));
  assert.equal(stripe.refunded('ch_in5_price_7'), 0, 'the ordinary price after a discount is not refunded');

  // A lower price for the plan itself needs no notice. It applies when it is charged, with the full month.
  had = (await bal(p)).balance;
  const lower = renewal('in5_price_6', 900);
  lower.lines.data[0].price = { id: 'price_grove', unit_amount: 900 };
  await event('invoice.paid', lower);
  assert.equal(stripe.refunded('ch_in5_price_6'), 0);
  assert.equal((await bal(p)).balance, had + 9);
  assert.equal(acct(p.id).price_cents, 900);

  // Someone who started with a discount is on the price the checkout showed, not on the discounted amount.
  const d = await person('Coupon');
  await event('checkout.session.completed', checkout(d));
  await event('invoice.paid', invoice(d, 'in5_coupon_1', { amount_paid: 450 }));
  assert.equal(acct(d.id).price_cents, 900);
  await event('invoice.paid', invoice(d, 'in5_coupon_2', { amount_paid: 900, billing_reason: 'subscription_cycle' }));
  assert.equal(stripe.refunded('ch_in5_coupon_2'), 0);
});

test('putting right the name of someone who was asked to sign again needs no signature, and pointing their request at somebody else still does', async () => {
  const p = await person('Again');
  const e = await draft(p.c, { ordered: false, subject: 'Name fix' });
  assert.equal((await p.c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, 'ada@example.com')).status, 200);
  // One used by Ada, one held for Ben, and the third is taken away: nothing is free.
  db.run('INSERT INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,?,?,?)', p.id, -1, 'adjust', crypto.randomUUID(), new Date().toISOString());
  assert.deepEqual(await bal(p), { balance: 1, held: 1, available: 0 });

  // The sender adds a line to the page and chooses to have Ada sign again. That is free.
  const cur = (await p.c.get(`/envelopes/${e.id}`)).data.envelope;
  const body = { subject: cur.subject, message: cur.message, ordered: cur.ordered, documents: cur.documents, recipients: cur.recipients, fields: [...cur.fields, { id: 'n1', document_id: cur.documents[0].id, type: 'note', value: 'Delivery in May', page: 0, x: 0.3, y: 0.3, w: 0.3, h: 0.03 }] };
  assert.equal((await p.c.call('PUT', `/envelopes/${e.id}`, { ...body, resign: true })).status, 200);
  const ada = db.get("SELECT id, status FROM recipients WHERE envelope_id=? AND email='ada@example.com'", e.id);
  assert.equal(ada.status, 'sent');
  assert.deepEqual(await bal(p), { balance: 1, held: 1, available: 0 });

  // Her name was misspelled. Putting it right is not a new signature: it was refused with "you have 0 left" before.
  const fix = await p.c.post(`/envelopes/${e.id}/correct`, { recipient_id: ada.id, name: 'Ada Signér' });
  assert.equal(fix.status, 200, JSON.stringify(fix.data));
  assert.deepEqual(await bal(p), { balance: 1, held: 1, available: 0 });
  assert.equal((await signAll(e.id, 'ada@example.com')).status, 200);
  assert.equal(db.get("SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature'", p.id).n, 1, 'Ada was paid for once');

  // Asked again, and this time the request is pointed at a different person. That is a new signature, and none is free.
  const cur2 = (await p.c.get(`/envelopes/${e.id}`)).data.envelope;
  const body2 = { subject: cur2.subject, message: cur2.message, ordered: cur2.ordered, documents: cur2.documents, recipients: cur2.recipients, fields: [...cur2.fields, { id: 'n2', document_id: cur2.documents[0].id, type: 'note', value: 'And in June', page: 0, x: 0.3, y: 0.4, w: 0.3, h: 0.03 }] };
  assert.equal((await p.c.call('PUT', `/envelopes/${e.id}`, { ...body2, resign: true })).status, 200);
  const other = await p.c.post(`/envelopes/${e.id}/correct`, { recipient_id: ada.id, name: 'Somebody Else', email: 'else@example.com' });
  assert.equal(other.status, 402);
  assert.match(other.data.error, /needs 1 signature and you have 0 left/);
});

test('the payment page asks for a tax number and address only when the operator switched that on', async () => {
  const p = await person('Vat');
  const asked = () => stripe.calls.filter((c) => c[1] === 'checkout/sessions').at(-1)![2];
  assert.equal((await p.c.post('/billing/checkout')).status, 200);
  assert.equal(asked()['tax_id_collection[enabled]'], undefined);
  process.env.STRIPE_COLLECT_TAX_ID = '1';
  try {
    // A new customer: the provider creates them from what they type.
    assert.equal((await p.c.post('/billing/checkout')).status, 200);
    assert.deepEqual([asked()['tax_id_collection[enabled]'], asked().billing_address_collection, asked()['customer_update[name]']], ['true', 'required', undefined]);
    // A customer the provider already knows: it has to be allowed to update their name and address.
    await subscribe(p);
    assert.equal((await p.c.post('/billing/topup', { quantity: 5 })).status, 200);
    assert.deepEqual([asked().customer, asked()['tax_id_collection[enabled]'], asked()['customer_update[name]'], asked()['customer_update[address]']], [p.cus, 'true', 'auto', 'auto']);
  } finally {
    delete process.env.STRIPE_COLLECT_TAX_ID;
  }
});

test('closing an account: asking twice does not turn "the provider has not confirmed" into "done", and the ledger that stays names nobody', async () => {
  const PW = 'correct horse battery';
  const p = await person('Closer');
  await subscribe(p);
  // Somebody signs something of theirs, so the ledger has a "signature used" line named after that person.
  const { simple } = await import('./helpers.ts');
  const e = await simple(p.c, 'private.signer@five.example');
  assert.equal((await p.c.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await signAll(e.id, 'private.signer@five.example')).status, 200);
  assert.match(db.get("SELECT ref FROM credits WHERE account_id=? AND reason='signature'", p.id).ref, /private\.signer@five\.example/);
  const uid = (await p.c.get('/me')).data.user.id;

  // The payment provider cannot be reached for cancellations.
  stripe.fail('DELETE', /^subscriptions\//, 50);
  const first = await p.c.post('/me/delete', { password: PW, now: true });
  assert.equal(first.status, 502);
  assert.match(first.data.error, /nothing was deleted/);
  // Seconds later, the same again. The plan is already over on our side, but the provider still has not said so.
  const second = await p.c.post('/me/delete', { password: PW, now: true });
  assert.equal(second.status, 502, 'still not confirmed, so still not deleted');
  assert.equal(db.get('SELECT COUNT(*) n FROM users WHERE id=?', uid).n, 1);
  assert.equal(stripe.sub(p.sub).status, 'active', 'the subscription really is still running at the provider');
  // Choosing the ordinary close instead does not claim it either.
  assert.equal((await p.c.post('/me/delete', { password: PW })).data.closed, 'scheduled');
  const said = text(mailTo(p.email).at(-1)!.html);
  assert.doesNotMatch(said, /you will not be charged again/);
  assert.match(said, /did not confirm it straight away, so we keep trying/);

  // The provider is back. Now it goes through, the queued ending is settled, and the account is deleted.
  stripe.failing.length = 0;
  const back = new Client();
  back.ip = '198.51.105.250';
  assert.equal((await back.post('/auth/login', { email: p.email, password: PW })).data.restored, true);
  assert.equal((await back.post('/me/delete', { password: PW, now: true })).data.closed, 'now');
  assert.equal(stripe.sub(p.sub).status, 'canceled');
  assert.equal(db.get("SELECT COUNT(*) n FROM billing_todo WHERE kind='cancel' AND ref=? AND done_at IS NULL", p.sub).n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM users WHERE id=?', uid).n, 0);

  // What stays of the ledger carries no address: the line is still there, under a name of its own.
  const left = db.all("SELECT ref FROM credits WHERE account_id=? AND reason='signature'", p.id);
  assert.equal(left.length, 1);
  assert.doesNotMatch(JSON.stringify(left), /@|private\.signer/);
});
