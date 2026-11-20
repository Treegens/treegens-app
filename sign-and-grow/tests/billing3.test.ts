// Billing, third round. A second pair of skeptics attacked the rewritten payment code (research/verify-billing.json)
// and found what the first tests had missed: provider messages handled at the same instant, a refund whose answer is
// lost on the way back, disputes that returned the money and left the signatures, and a row of smaller holes. Each
// test here is one of those, written so that it fails without the fix.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, Client, simple, signUp, signAll, mailTo, type Server } from './helpers.ts';
import { stripe, unix } from './stripe-fake.ts';

let db: Server['db'];
let billing: Server['billing'];
let cron: Server['cron'];

const event = (type: string, object: any, extra: any = {}) => billing.applyStripeEvent({ type, data: { object }, ...extra });
const acct = (id: string) => db.get('SELECT * FROM accounts WHERE id=?', id);
const pay = (id: string) => db.get('SELECT * FROM payments WHERE id=?', id);
const subjects = (email: string) => mailTo(email).map((m) => m.subject);
const alerts = () => db.all("SELECT message FROM support_requests WHERE topic='billing' ORDER BY rowid").map((r: any) => r.message as string);
const adjust = (accountId: string, delta: number) => db.run('INSERT INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,?,?,?)', accountId, delta, 'adjust', crypto.randomUUID(), new Date().toISOString());
const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();

type Person = { c: Client; id: string; email: string; cus: string; sub: string; k: number };
let n = 0;
async function person(name: string): Promise<Person> {
  const k = ++n;
  const email = `${name.toLowerCase()}${k}@example.com`;
  const c = await signUp(`${name} Tester`, email, `198.51.101.${k}`);
  return { c, id: (await c.get('/me')).data.account.id, email, cus: `cus3_${k}`, sub: `sub3_${k}`, k };
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
const checkout = (p: Person, over: any = {}) => ({ id: `cs3_${p.k}`, mode: 'subscription', client_reference_id: p.id, customer: p.cus, subscription: p.sub, payment_status: 'paid', ...over });
async function subscribe(p: Person, inv = `in3_${p.k}_1`) {
  await event('checkout.session.completed', checkout(p));
  await event('invoice.paid', invoice(p, inv));
}
const topUp = (p: Person, sid: string, credits: number, over: any = {}) => {
  stripe.charges.unshift({ id: `ch_${sid}`, payment_intent: `pi_${sid}`, paid: true, refunded: false, amount: credits * 100, currency: 'usd', customer: p.cus, last4: '4242', created: unix(0) });
  return { id: sid, mode: 'payment', client_reference_id: p.id, customer: p.cus, payment_status: 'paid', amount_total: credits * 100, currency: 'usd', payment_intent: `pi_${sid}`, metadata: { kind: 'sg_topup', credits: String(credits), sg_account: p.id }, ...over };
};
const bal = async (p: Person) => (await p.c.get('/billing')).data.signatures;
const state = async (p: Person) => (await p.c.get('/billing')).data;

before(async () => {
  ({ db, billing, cron } = await boot());
});

test('provider messages handled at the same instant: the first payment is counted once and never sent back', async () => {
  const subUpdated = (p: Person) => ({ id: p.sub, customer: p.cus, status: 'active', current_period_end: unix(30), metadata: { sg_account: p.id } });
  // Every pair and the three together, in each starting order, with the provider answering slowly enough to overlap.
  const orders: ((p: Person, inv: any) => Promise<any>[])[] = [
    (p, inv) => [event('invoice.paid', inv), event('customer.subscription.updated', subUpdated(p))],
    (p, inv) => [event('checkout.session.completed', checkout(p, { invoice: inv.id })), event('invoice.paid', inv)],
    (p, inv) => [event('customer.subscription.updated', subUpdated(p)), event('invoice.paid', inv), event('checkout.session.completed', checkout(p, { invoice: inv.id }))],
    (p, inv) => [event('invoice.paid', inv), event('checkout.session.completed', checkout(p, { invoice: inv.id })), p.c.post('/billing/sync', { session_id: `cs3_${p.k}` })],
  ];
  for (const [i, start] of orders.entries()) {
    const p = await person('Race');
    const inv = invoice(p, `in3_race_${i}`);
    stripe.sessions[`cs3_${p.k}`] = checkout(p, { invoice: inv.id });
    stripe.delayMs = 5;
    await Promise.all(start(p, inv));
    stripe.delayMs = 0;
    assert.deepEqual(await bal(p), { balance: 12, held: 0, available: 12 }, `order ${i}`);
    assert.equal(pay(inv.id).refunded_cents, 0, `order ${i}: nothing sent back`);
    assert.equal(stripe.refunded(`ch_${inv.id}`), 0);
    assert.deepEqual(subjects(p.email).filter((s) => /Welcome|Receipt|Refund/.test(s)), ['Welcome to Grove', 'Receipt: $9.00 for 9 signatures'], `order ${i}: one welcome, one receipt, no refund`);
    assert.equal(acct(p.id).plan, 'grove');
    assert.equal(stripe.sub(p.sub).status, 'active');
  }

  // The same for someone coming back after cancelling.
  const r = await person('Back');
  await subscribe(r);
  await r.c.post('/billing/cancel');
  await event('customer.subscription.deleted', { id: r.sub, customer: r.cus, status: 'canceled' });
  stripe.sub(r.sub).status = 'canceled';
  const again = { ...r, sub: 'sub3_back_new' };
  const inv = invoice(again, 'in3_back_2');
  stripe.delayMs = 5;
  await Promise.all([event('invoice.paid', inv), event('customer.subscription.updated', subUpdated(again))]);
  stripe.delayMs = 0;
  assert.equal(pay('in3_back_2').refunded_cents, 0);
  assert.equal((await bal(r)).balance, 21);
  assert.equal(subjects(r.email).some((s) => s.startsWith('Refund sent')), false);

  // Two clicks at once on the things people double-click.
  const d = await person('Dbl');
  await subscribe(d);
  const two = await Promise.all([d.c.post('/billing/cancel'), d.c.post('/billing/cancel')]);
  assert.equal(two[0].data.reference, two[1].data.reference, 'one cancellation, one reference');
  assert.equal(subjects(d.email).filter((s) => s === 'Your Grove plan is cancelled').length, 1);
  await d.c.post('/billing/resume');
  const codes = await Promise.all([d.c.post('/billing/redeem', { code: 'GROWalition' }), d.c.post('/billing/redeem', { code: 'GROWalition' })]);
  assert.deepEqual(codes.map((x) => x.status), [200, 200]);
  assert.equal(subjects(d.email).filter((s) => s.startsWith('Code GROWalition accepted')).length, 1);
});

test('a refund whose answer is lost on the way back is neither paid twice nor forgotten, and the signatures do not come back', async () => {
  const p = await person('Lost');
  await subscribe(p);
  stripe.loseAnswer('POST', /^refunds$/);
  const r = await p.c.post('/billing/refund');
  assert.equal(r.status, 200);
  assert.equal(r.data.pending, true, 'the page is told it has not been confirmed yet');
  assert.equal(r.data.plan_ended, true);
  assert.equal(stripe.refunded(`ch_in3_${p.k}_1`), 900, 'the provider did carry it out');
  assert.equal((await bal(p)).balance, 3, 'the signatures stay off the balance while the outcome is unknown');
  let s = await state(p);
  assert.equal(s.refund, null);
  assert.equal(s.payments[0].refund_pending, true);
  assert.equal((await p.c.post('/billing/refund')).status, 400, 'no second refund while one is open');
  // The timer asks the provider whether it happened, finds it, and records it. Nothing is paid a second time.
  await cron.tick();
  assert.equal(pay(`in3_${p.k}_1`).refunded_cents, 900);
  assert.equal(stripe.refunded(`ch_in3_${p.k}_1`), 900);
  assert.equal(stripe.refunds.filter((x) => x.charge === `ch_in3_${p.k}_1`).length, 1);
  assert.equal(subjects(p.email).filter((x) => x === 'Refund sent: $9.00').length, 1);
  s = await state(p);
  assert.equal(s.payments[0].refund_pending, false);
  assert.equal(s.signatures.balance, 3);

  // If the provider's own notice arrives before the timer, that settles it just the same.
  const q = await person('Echo');
  await subscribe(q);
  await event('checkout.session.completed', topUp(q, 'cs3_echo_top', 4));
  stripe.loseAnswer('POST', /^refunds$/);
  assert.equal((await q.c.post('/billing/refund')).data.pending, true);
  await event('charge.refunded', { id: 'ch_cs3_echo_top', payment_intent: 'pi_cs3_echo_top', customer: q.cus, amount: 400, amount_refunded: 400 });
  assert.equal(pay('cs3_echo_top').refunded_cents, 400);
  assert.equal((await bal(q)).balance, 12, 'four left with the refund, and only four');
  assert.equal(stripe.refunded('ch_cs3_echo_top'), 400);

  // When the provider says a clear no, the signatures go back and the customer is told the truth.
  const t = await person('Nope');
  await subscribe(t);
  await event('checkout.session.completed', topUp(t, 'cs3_nope_top', 4));
  stripe.fail('POST', /^refunds$/, 1, 'This charge cannot be refunded.', 400);
  const no = await t.c.post('/billing/refund');
  assert.equal(no.status, 502);
  assert.match(no.data.error, /cannot be refunded/);
  assert.equal((await bal(t)).balance, 16);
  assert.equal(acct(t.id).plan, 'grove', 'a top-up refund never touches the plan');
  // For a monthly payment the plan has ended by then: a person is told and the customer is not left guessing.
  await t.c.post('/billing/refund'); // the top-up, this time it works
  stripe.fail('POST', /^refunds$/, 1, 'This charge cannot be refunded.', 400);
  const stuck = await t.c.post('/billing/refund', { payment_id: `in3_${t.k}_1` });
  assert.equal(stuck.status, 502);
  assert.match(stuck.data.error, /A person here has been told and will refund it by hand/);
  assert.ok(alerts().some((m) => m.includes('A refund failed after the plan was ended') && m.includes(t.id)));
  assert.equal((await bal(t)).balance, 12);
});

test('signatures that come back later can still be refunded from the same payment', async () => {
  const p = await person('Twice');
  await subscribe(p);
  const out: string[] = [];
  for (let i = 0; i < 5; i++) {
    const e = await simple(p.c, `tw${i}@example.com`);
    await p.c.post(`/envelopes/${e.id}/send`);
    out.push(e.id);
  }
  assert.deepEqual(await bal(p), { balance: 12, held: 5, available: 7 });
  assert.equal((await p.c.post('/billing/refund')).data.refunded, '$7.00');
  // The five that were out are voided, so their signatures are free again. Two of them are what is left of the $9.
  for (const id of out) await p.c.post(`/envelopes/${id}/void`, { reason: 'changed my mind' });
  const s = await state(p);
  assert.equal(s.refund.amount, '$2.00');
  assert.match(s.refund.reason, /you have 2 unused signatures to hand back out of the 9 it bought/);
  assert.equal((await p.c.post('/billing/refund')).data.refunded, '$2.00');
  assert.equal(pay(`in3_${p.k}_1`).refunded_cents, 900);
  assert.equal(stripe.refunded(`ch_in3_${p.k}_1`), 900);
  assert.equal((await bal(p)).balance, 3);
  assert.equal((await state(p)).refund, null);
});

test('a dispute takes the unused signatures with it, bigger ones are left to a person, and payments stay off until someone has looked', async () => {
  const p = await person('Disp');
  await subscribe(p);
  await event('checkout.session.completed', topUp(p, 'cs3_disp_top', 100));
  // 40 of the 112 get used.
  adjust(p.id, -40);
  assert.equal((await bal(p)).balance, 72);
  await event('charge.dispute.created', { id: 'dp3_big', charge: 'ch_cs3_disp_top', amount: 10000 });
  assert.equal(stripe.disputesClosed.includes('dp3_big'), false, '$100 is above what is conceded without a person');
  const s = await state(p);
  assert.equal(s.signatures.balance, 0, 'the 72 unused signatures that payment bought leave with the money');
  assert.equal(s.disputed, true);
  assert.equal(s.plan, 'seedling');
  assert.equal(stripe.sub(p.sub).status, 'canceled');
  assert.equal(s.payments.find((x: any) => x.id === 'cs3_disp_top').refundable, null);
  const mail = mailTo(p.email).find((m) => m.subject === 'A payment was disputed, so we stopped billing you')!;
  assert.match(mail.html, /A person here will look at it and write to you/);
  assert.match(mail.html, /72 signatures that payment bought are set aside until the bank decides\. If the payment stands, they come back/);
  assert.equal(s.payments.find((x: any) => x.id === 'cs3_disp_top').refunded, null, 'nothing has gone back yet, so nothing is shown as refunded');
  assert.equal(s.payments.find((x: any) => x.id === 'cs3_disp_top').disputed, 'open');
  assert.equal(s.mangroves, 1090, 'and the money still counts until the bank decides');
  assert.doesNotMatch(mail.html, /stay yours|start the plan again/);
  assert.ok(alerts().some((m) => m.includes('Card dispute') && m.includes('NOT accepted automatically') && m.includes('28 signatures bought with that payment had already been used')));
  assert.equal((await p.c.post('/billing/topup', { quantity: 5 })).status, 403);

  // On a plan that is free through a code, a disputed top-up does not end the plan.
  const g = await person('DispCode');
  await g.c.post('/billing/redeem', { code: 'GROWalition' });
  await event('checkout.session.completed', topUp(g, 'cs3_dispc_top', 5));
  await event('charge.dispute.created', { id: 'dp3_small', charge: 'ch_cs3_dispc_top', amount: 500 });
  assert.ok(stripe.disputesClosed.includes('dp3_small'), 'a small one is conceded');
  assert.equal(acct(g.id).plan, 'grove');
  assert.equal(acct(g.id).promo_code, 'GROWalition');
  assert.match(mailTo(g.email).find((m) => m.subject === 'A payment was disputed, so we stopped billing you')!.html, /Your plan stays free with the code GROWalition/);
  assert.equal((await bal(g)).balance, 12);

  // A refund a person makes in the provider's dashboard takes its unused signatures too.
  const h = await person('Dash');
  await subscribe(h);
  await event('charge.refunded', { id: `ch_in3_${h.k}_1`, customer: h.cus, amount: 900, amount_refunded: 900 });
  assert.equal((await bal(h)).balance, 3);
  assert.equal((await state(h)).refund, null);
  assert.ok(alerts().some((m) => m.includes('A refund made outside the app was recorded')));
});

test('the invoice the provider makes for a top-up is not a second payment, and invoices that are not ours count nowhere', async () => {
  const p = await person('Inv');
  await subscribe(p);
  const topInvoice = { id: 'in3_top_inv', customer: p.cus, amount_paid: 1000, currency: 'usd', status: 'paid', billing_reason: 'manual', hosted_invoice_url: 'https://pay.example/in3_top_inv', metadata: { kind: 'sg_topup', sg_account: p.id } };
  stripe.invoices.in3_top_inv = topInvoice;
  await event('checkout.session.completed', topUp(p, 'cs3_inv_top', 10, { invoice: 'in3_top_inv' }));
  await event('invoice.paid', topInvoice);
  let s = await state(p);
  assert.equal(s.payments.length, 2, 'the monthly payment and the top-up, nothing else');
  assert.equal(s.mangroves, 190);
  assert.equal(s.payments[0].receipt_url, 'https://pay.example/in3_top_inv', 'its link goes on the top-up');
  assert.equal(alerts().some((m) => m.includes('in3_top_inv')), false, 'and nobody is alarmed about it');
  // The other way round: the invoice is reported before the checkout says which invoice is its own.
  const other = { ...topInvoice, id: 'in3_top_inv2', hosted_invoice_url: 'https://pay.example/in3_top_inv2', amount_paid: 300 };
  stripe.invoices.in3_top_inv2 = other;
  await event('invoice.paid', other);
  await event('checkout.session.completed', topUp(p, 'cs3_inv_top2', 3, { invoice: 'in3_top_inv2' }));
  s = await state(p);
  assert.equal(s.payments.length, 3);
  assert.equal(s.payments[0].receipt_url, 'https://pay.example/in3_top_inv2');
  assert.equal(s.mangroves, 220);

  // Something else being sold on the same provider account: not ours, not counted, nobody alerted, nothing refunded.
  const before = (await new Client().get('/public/impact')).data.donatedUsd;
  stripe.charges.unshift({ id: 'ch_foreign', paid: true, refunded: false, amount: 49900, customer: 'cus_foreign', invoice: 'in_foreign' });
  await event('invoice.paid', { id: 'in_foreign', customer: 'cus_foreign', subscription: 'sub_foreign', amount_paid: 49900, currency: 'usd', status: 'paid', billing_reason: 'subscription_cycle', lines: { data: [{ price: { id: 'price_someone_elses' } }] } });
  assert.equal((await new Client().get('/public/impact')).data.donatedUsd, before);
  assert.equal(alerts().some((m) => m.includes('in_foreign')), false);
  db.run("UPDATE payments SET at=? WHERE id='in_foreign'", ago(10));
  await cron.tick();
  assert.equal(stripe.refunded('ch_foreign'), 0, 'we never refund money that was not paid to us');

  // A payment that IS ours and that nobody can be found for is refunded after three days, and a person is told.
  stripe.charges.unshift({ id: 'ch_lost', paid: true, refunded: false, amount: 900, customer: 'cus_lost', invoice: 'in_lost' });
  const lost = { id: 'in_lost', customer: 'cus_lost', subscription: 'sub_lost', amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', lines: { data: [{ price: { id: 'price_grove' } }] } };
  stripe.invoices.in_lost = lost;
  await event('invoice.paid', lost);
  await cron.tick();
  assert.equal(stripe.refunded('ch_lost'), 0, 'not on the first day');
  db.run("UPDATE payments SET at=? WHERE id='in_lost'", ago(4));
  await cron.tick();
  assert.equal(stripe.refunded('ch_lost'), 900);
  assert.equal(stripe.sub('sub_lost').status, 'canceled');
  assert.ok(alerts().some((m) => m.includes('An unmatched payment was refunded after three days') && m.includes('in_lost')));

  // Only US dollars are taken. Anything else goes straight back, and checkout is told not to convert.
  await event('checkout.session.completed', topUp(p, 'cs3_gbp', 10, { currency: 'gbp', amount_total: 790 }));
  assert.equal(pay('cs3_gbp').credits, 0);
  assert.equal(stripe.refunded('ch_cs3_gbp'), 790);
  await p.c.post('/billing/topup', { quantity: 2 });
  assert.equal(stripe.calls.at(-1)![2]['adaptive_pricing[enabled]'], 'false');
});

test('cancelling: the cases where "you will not be charged again" used to be wrong', async () => {
  // A payment is failing AND the plan was already set to end: cancelling really ends it.
  const p = await person('Both');
  await subscribe(p);
  await p.c.post('/billing/cancel');
  Object.assign(stripe.sub(p.sub), { status: 'past_due', latest_invoice: 'in3_both_open' });
  stripe.invoices.in3_both_open = { id: 'in3_both_open', status: 'open' };
  await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'past_due', cancel_at_period_end: true, current_period_end: unix(30) });
  assert.equal((await state(p)).can_cancel, true);
  const r = await p.c.post('/billing/cancel');
  assert.equal(r.data.ended_now, true);
  assert.match(r.data.reference, /^SG-/);
  assert.equal(stripe.sub(p.sub).status, 'canceled');
  assert.equal(stripe.invoices.in3_both_open.status, 'void');

  // The new month has started but its payment has not been taken yet: it is withdrawn, not left to go through.
  const q = await person('Hour');
  await subscribe(q);
  stripe.sub(q.sub).latest_invoice = 'in3_hour_draft';
  stripe.invoices.in3_hour_draft = { id: 'in3_hour_draft', status: 'draft' };
  const c = await q.c.post('/billing/cancel');
  assert.equal(c.data.ended_now, true);
  assert.equal(stripe.invoices.in3_hour_draft.status, 'deleted');
  assert.match(mailTo(q.email).find((m) => m.subject === 'Your Grove plan is cancelled')!.html, /had not been taken yet, so the plan ends today/);

  // Cancelled on the provider's own page: same reference, history line and email as in the app.
  const s = await person('Portal');
  await subscribe(s);
  await event('customer.subscription.updated', { id: s.sub, customer: s.cus, status: 'active', cancel_at_period_end: true, current_period_end: unix(20) });
  let st = await state(s);
  assert.ok(st.ends_at);
  assert.match(st.cancel_ref, /^SG-/);
  assert.ok(st.history.some((h: any) => h.label === 'Cancelled' && h.ref === st.cancel_ref));
  assert.match(mailTo(s.email).find((m) => m.subject === 'Your Grove plan is cancelled')!.html, /on the payment provider&#39;s page/);
  // A cancellation given as a date, not as "at the end of the period", is understood too.
  const s2 = await person('PortalDate');
  await subscribe(s2);
  await event('customer.subscription.updated', { id: s2.sub, customer: s2.cus, status: 'active', cancel_at: unix(10), current_period_end: unix(20) });
  assert.ok((await state(s2)).ends_at);

  // An older message from the provider does not undo a cancellation made here a moment ago.
  const t = await person('Late');
  await subscribe(t);
  await t.c.post('/billing/cancel');
  await event('customer.subscription.updated', { id: t.sub, customer: t.cus, status: 'active', cancel_at_period_end: false, current_period_end: unix(20) }, { created: unix(0) - 300 });
  assert.ok(acct(t.id).cancel_at, 'still cancelled');
  // Undoing it tells every admin that charging is back on.
  await t.c.post('/billing/resume');
  assert.ok(subjects(t.email).includes('Your Grove plan continues'));

  // The provider ended a plan and its message never arrived: the timer finds out.
  const u = await person('Quiet');
  await subscribe(u);
  await u.c.post('/billing/cancel');
  db.run('UPDATE accounts SET cancel_at=?, sub_event_at=? WHERE id=?', ago(0.2), unix(-1), u.id);
  stripe.sub(u.sub).status = 'canceled';
  await cron.tick();
  st = await state(u);
  assert.equal(st.plan, 'seedling');
  assert.equal(st.ended, true);
  assert.equal((await u.c.post('/billing/checkout')).status, 200, 'and they can start again');
  // Resuming a plan that has already ended at the provider says so instead of pretending.
  const v = await person('Gone');
  await subscribe(v);
  await v.c.post('/billing/cancel');
  stripe.sub(v.sub).status = 'canceled';
  const res = await v.c.post('/billing/resume');
  assert.equal(res.status, 409);
  assert.match(res.data.error, /already ended/);
  assert.equal(acct(v.id).plan, 'seedling');

  // A weeks-old "active" message about a subscription that is long dead brings nothing back.
  await event('customer.subscription.updated', { id: v.sub, customer: v.cus, status: 'active' });
  stripe.sub('sub3_old_ours').status = 'canceled';
  await event('customer.subscription.updated', { id: 'sub3_old_ours', customer: v.cus, status: 'active', metadata: { sg_account: v.id } }, { created: unix(-20) });
  // Nor does a live subscription of the same customer for something else sold on the same provider account.
  await event('customer.subscription.updated', { id: 'sub3_other_product', customer: v.cus, status: 'active', items: { data: [{ price: { id: 'price_other_product' } }] } });
  assert.equal(stripe.sub('sub3_other_product').status, 'active', 'and it is left alone');
  assert.equal(acct(v.id).plan, 'seedling');
  assert.equal(subjects(v.email).filter((x) => x === 'Welcome to Grove').length, 1);
});

test('the plan nobody uses: stopped once, and "keep it" means keep it', async () => {
  const p = await person('Dorm');
  await subscribe(p);
  stripe.sub(p.sub).current_period_end = unix(6);
  db.run('UPDATE accounts SET created_at=?, plan_started_at=?, renews_at=? WHERE id=?', ago(200), ago(120), new Date(unix(6) * 1000).toISOString(), p.id);
  await cron.tick();
  assert.ok(acct(p.id).cancel_at, 'stopped for them');
  assert.equal((await p.c.post('/billing/resume')).status, 200);
  await cron.tick();
  await cron.tick();
  assert.equal(acct(p.id).cancel_at, null, 'not stopped a second time');
  assert.equal(subjects(p.email).filter((s) => s.startsWith('We stopped your renewal')).length, 1);
  assert.equal(subjects(p.email).filter((s) => s.startsWith('Heads up')).length, 1, 'the ordinary reminder goes out instead');

  // An old account that only started paying three weeks ago is not "unused for 90 days".
  const q = await person('Young');
  await subscribe(q);
  db.run('UPDATE accounts SET created_at=?, plan_started_at=?, renews_at=? WHERE id=?', ago(200), ago(21), new Date(Date.now() + 6 * 864e5).toISOString(), q.id);
  await cron.tick();
  assert.equal(acct(q.id).cancel_at, null);

  // The amount goes up after the reminder said $9, because tax now applies: a correction goes out, and the charge
  // is then held to that. (A higher price is another matter: that needs thirty days' notice, see billing5.)
  await event('invoice.upcoming', { customer: q.cus, subscription: q.sub, amount_due: 1080, tax: 180, currency: 'usd', period_end: Math.floor(Date.parse(acct(q.id).renews_at) / 1000) });
  const fix = mailTo(q.email).find((m) => m.subject.startsWith('Correction: your plan renews on'))!;
  assert.match(fix.subject, /for \$10\.80, not \$9\.00/);
  assert.equal((await state(q)).next_amount, '$10.80');
  // One reminder per renewal even when the provider names a slightly different moment for it.
  await event('invoice.upcoming', { customer: q.cus, subscription: q.sub, amount_due: 1080, tax: 180, currency: 'usd', next_payment_attempt: Math.floor(Date.parse(acct(q.id).renews_at) / 1000) + 3600 });
  assert.equal(subjects(q.email).filter((s) => /^(Heads up|Correction)/.test(s)).length, 2);
});

test('who pays for a signature: in-person signers always, approvals never, public forms without holding the balance', async () => {
  const p = await person('Free');
  adjust(p.id, -3);
  // An in-person signer is somebody else signing on the sender's device, whatever address was typed for them.
  const walkIn = { recipients: [{ id: 'r', role: 'inperson', name: 'Walk-in Client', email: p.email }] };
  const one = await simple(p.c, p.email, walkIn);
  const refused = await p.c.post(`/envelopes/${one.id}/send`);
  assert.equal(refused.status, 402);
  assert.match(refused.data.error, /needs 1 signature and you have 0 left/);
  adjust(p.id, 1);
  assert.equal((await p.c.post(`/envelopes/${one.id}/send`)).status, 200);
  assert.deepEqual(await bal(p), { balance: 1, held: 1, available: 0 });

  // Below zero, what is free still goes: a batch of approvals.
  adjust(p.id, -1);
  assert.equal((await bal(p)).available, -1);
  const tpl = await simple(p.c, '', { kind: 'template', subject: 'Sign-off', recipients: [{ id: 'r', role: 'approver', role_name: 'Boss' }], fields: [] });
  const batch = await p.c.post('/bulk', { template_id: tpl.id, rows: [{ Boss: { name: 'B One', email: 'b1@example.com' } }, { Boss: { name: 'B Two', email: 'b2@example.com' } }] });
  assert.equal(batch.status, 200, JSON.stringify(batch.data));

  // A public form does not hold the owner's signatures for people who only started it.
  const o = await person('Form');
  const form = await simple(o.c, '', { kind: 'template', subject: 'Join us', recipients: [{ id: 'r', role: 'signer', role_name: 'Member' }] });
  await o.c.post('/powerforms', { template_id: form.id, name: 'Join us' });
  const slug = (await o.c.get('/powerforms')).data.powerforms[0].slug;
  for (let i = 0; i < 3; i++) {
    const visitor = new Client();
    visitor.ip = `203.0.114.${i + 1}`;
    assert.equal((await visitor.post(`/public/powerforms/${slug}/start`, { name: `Visitor ${i}`, email: `made-up-${i}@example.com` })).status, 200);
  }
  assert.deepEqual(await bal(o), { balance: 3, held: 0, available: 3 }, 'three strangers cannot lock up the balance');
  const mine = await simple(o.c, 'client@example.com');
  assert.equal((await o.c.post(`/envelopes/${mine.id}/send`)).status, 200);
  // The form uses a signature when its visitor actually signs.
  const started = db.get("SELECT e.id FROM envelopes e WHERE e.powerform_id IS NOT NULL AND e.account_id=? ORDER BY e.created_at LIMIT 1", o.id).id;
  assert.equal((await signAll(started, 'made-up-0@example.com')).status, 200);
  assert.equal((await bal(o)).balance, 2);
});

test('the tools for people who are locked out say what is true', async () => {
  const p = await person('Tools');
  await subscribe(p);
  const anon = new Client();
  anon.ip = '203.0.115.1';
  // The provider cannot be asked: that is not "your details are wrong".
  stripe.fail('GET', /payment_methods/);
  const down = await anon.post('/public/billing/stop-by-card', { email: p.email, last4: '4242' });
  assert.equal(down.status, 502);
  assert.match(down.data.error, /could not check that with the payment provider/);
  assert.equal(acct(p.id).cancel_at, null);
  stripe.fail('GET', /charges\/search/);
  assert.equal((await anon.post('/public/billing/stop-by-card', { last4: '4242', charged_on: new Date().toISOString().slice(0, 10), amount: '9.00' })).status, 502);

  // One address that manages two paid teams on the same card: both are stopped and both are named.
  const second = { ...p, id: db.get("SELECT id FROM accounts WHERE id != ? ORDER BY created_at DESC LIMIT 1", p.id).id };
  db.run("INSERT INTO accounts (id, name, created_at) VALUES ('acc_tools_two', 'Second team', ?)", new Date().toISOString());
  db.run("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES ('acc_tools_two', (SELECT id FROM users WHERE email=?), 'owner', ?)", p.email, new Date().toISOString());
  void second;
  await event('checkout.session.completed', { id: 'cs3_tools_two', mode: 'subscription', client_reference_id: 'acc_tools_two', customer: 'cus3_tools_two', subscription: 'sub3_tools_two', payment_status: 'paid' });
  const both = await anon.post('/public/billing/stop-by-card', { email: p.email, last4: '4242' });
  assert.equal(both.data.stopped, true);
  assert.equal(both.data.all.length, 2);
  assert.ok(acct(p.id).cancel_at && acct('acc_tools_two').cancel_at);

  // Taking the card off file reports what was really removed.
  stripe.cards = [];
  assert.equal((await p.c.post('/billing/remove-card')).data.removed, 0);

  // The provider signs with two secrets while one is being replaced: either signature is good.
  const raw = '{"id":"evt_x"}';
  const t = Math.floor(Date.now() / 1000);
  const good = crypto.createHmac('sha256', 'whsec_new').update(`${t}.${raw}`).digest('hex');
  assert.equal(billing.verifyStripeSignature(raw, `t=${t},v1=${good},v1=${'0'.repeat(64)}`, 'whsec_new'), true);
  assert.equal(billing.verifyStripeSignature(raw, `t=${t},v1=${'0'.repeat(64)},v1=${good}`, 'whsec_new'), true);
  assert.equal(billing.verifyStripeSignature(raw, `t=${t},v1=${'0'.repeat(64)}`, 'whsec_new'), false);

  // Closing an account stops billing whatever state the plan is in, and never gets stuck on one that is already gone.
  const g = await person('CloseCode');
  await subscribe(g);
  await g.c.post('/billing/redeem', { code: 'GROWalition' });
  assert.equal(await billing.stopBillingFor(acct(g.id)), true, 'nothing left to stop is not an error');
  const h = await person('CloseHold');
  await subscribe(h);
  stripe.sub(h.sub).status = 'unpaid';
  await event('customer.subscription.updated', { id: h.sub, customer: h.cus, status: 'unpaid' });
  assert.equal(await billing.stopBillingFor(acct(h.id)), true);
  assert.equal(stripe.sub(h.sub).status, 'canceled', 'a plan on hold is ended too');
  await event('invoice.paid', invoice(h, 'in3_close_late', { billing_reason: 'subscription_cycle' }));
  assert.equal(pay('in3_close_late').refunded_cents, 900, 'and a late charge on it goes back');
});

test('a free code that is switched off leaves nobody stuck, and switching it back on in time changes nothing', async () => {
  const p = await person('Off');
  await subscribe(p);
  await p.c.post('/billing/redeem', { code: 'GROWalition' });
  assert.equal(acct(p.id).stripe_subscription_id, null, 'the ended subscription is not kept on the account');
  process.env.FREE_PLAN_CODES = 'SomethingElse';
  await cron.tick();
  assert.equal(acct(p.id).plan, 'grove', 'not on the first day');
  // Put back before the three days are up: as if nothing happened.
  delete process.env.FREE_PLAN_CODES;
  await cron.tick();
  assert.equal(acct(p.id).promo_missing_since, null);
  assert.equal(acct(p.id).promo_code, 'GROWalition');
  // Gone for good.
  process.env.FREE_PLAN_CODES = 'SomethingElse';
  await cron.tick();
  db.run('UPDATE accounts SET promo_missing_since=? WHERE id=?', ago(4), p.id);
  await cron.tick();
  const s = await state(p);
  assert.equal(s.plan, 'seedling');
  assert.equal(s.problem, null, 'not shown as a failed payment');
  assert.equal(s.can_cancel, false);
  const mail = mailTo(p.email).find((m) => m.subject === 'The code GROWalition has ended')!;
  assert.doesNotMatch(mail.html, /Do not renew/);
  assert.equal((await p.c.post('/billing/checkout')).status, 200, 'and the Start button works');
  delete process.env.FREE_PLAN_CODES;
});
