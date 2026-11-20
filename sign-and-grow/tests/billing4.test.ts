// Billing, fourth round: what the second pair of skeptics found (research/verify-billing-2.json). A refund racing
// against sends, things on a shared provider account that are not ours, disputes that are won back, refunds settled
// by hand, the per-account queue, and the corners of who pays for which signature.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Person = { c: Client; id: string; name: string; email: string; cus: string; sub: string; k: number };
let n = 0;
async function person(first: string): Promise<Person> {
  const k = ++n;
  const email = `${first.toLowerCase()}${k}@example.com`;
  const name = `${first} Tester`;
  const c = await signUp(name, email, `198.51.102.${k}`);
  return { c, id: (await c.get('/me')).data.account.id, name, email, cus: `cus4_${k}`, sub: `sub4_${k}`, k };
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
const checkout = (p: Person, over: any = {}) => ({ id: `cs4_${p.k}`, mode: 'subscription', client_reference_id: p.id, customer: p.cus, subscription: p.sub, payment_status: 'paid', ...over });
async function subscribe(p: Person, inv = `in4_${p.k}_1`) {
  await event('checkout.session.completed', checkout(p));
  await event('invoice.paid', invoice(p, inv));
}
const topUp = (p: Person, sid: string, credits: number, over: any = {}) => {
  stripe.charges.unshift({ id: `ch_${sid}`, payment_intent: `pi_${sid}`, paid: true, refunded: false, amount: credits * 100, currency: 'usd', customer: p.cus, last4: '4242', created: unix(0) });
  return { id: sid, mode: 'payment', client_reference_id: p.id, customer: p.cus, payment_status: 'paid', amount_total: credits * 100, currency: 'usd', payment_intent: `pi_${sid}`, metadata: { kind: 'sg_topup', credits: String(credits), sg_account: p.id }, ...over };
};
const bal = async (p: Person) => (await p.c.get('/billing')).data.signatures;
const state = async (p: Person) => (await p.c.get('/billing')).data;
const mine = (p: Person) => ({ recipients: [{ id: 'r', role: 'signer', name: p.name, email: p.email }] });

before(async () => {
  ({ db, billing, cron } = await boot());
});

test('a refund and a burst of sends at the same moment: the refunded signatures cannot be sent on', async () => {
  const p = await person('Burst');
  await subscribe(p);
  const drafts: string[] = [];
  for (let i = 0; i < 12; i++) drafts.push((await simple(p.c, `burst${i}@example.com`)).id);
  stripe.delayMs = 25;
  const refund = p.c.post('/billing/refund');
  await sleep(8);
  const sends = await Promise.all(drafts.map((id) => p.c.post(`/envelopes/${id}/send`)));
  const r = await refund;
  stripe.delayMs = 0;
  assert.equal(r.status, 200);
  assert.equal(r.data.refunded, '$9.00');
  assert.equal(sends.filter((x) => x.status === 200).length, 3, 'only the three that are left can go out');
  assert.equal(sends.filter((x) => x.status === 402).length, 9);
  assert.deepEqual(await bal(p), { balance: 3, held: 3, available: 0 });

  // A refund the provider refuses gives the signatures back: nothing was lost by taking them first.
  const q = await person('Giveback');
  await subscribe(q);
  await event('checkout.session.completed', topUp(q, 'cs4_give_top', 4));
  stripe.fail('POST', /^refunds$/, 1, 'This charge cannot be refunded.', 400);
  assert.equal((await q.c.post('/billing/refund')).status, 502);
  assert.equal((await bal(q)).balance, 16);
});

test('one customer waiting on the provider does not hold up another, and every copy of the server shares the queues', async () => {
  const a = await person('Slow');
  const b = await person('Quick');
  await subscribe(a);
  await subscribe(b);
  const order: string[] = [];
  stripe.delayMs = 40;
  const slow = a.c.post('/billing/refund').then(() => order.push('refund for the first customer'));
  await sleep(10);
  const quick = b.c.post('/billing/cancel').then(() => order.push('cancel for the second customer'));
  await Promise.all([slow, quick]);
  stripe.delayMs = 0;
  assert.deepEqual(order, ['cancel for the second customer', 'refund for the first customer']);
  assert.ok((globalThis as any).__sgBillingQueues instanceof Map, 'the queues are shared by every bundle of the server, the built-in timer included');
});

test('on a provider account shared with something else, nothing that is not ours is touched', async () => {
  const before = alerts().length;
  // Another product's invoice whose metadata happens to use the key "account_id".
  stripe.charges.unshift({ id: 'ch_tenant', paid: true, refunded: false, amount: 4900, customer: 'cus_other_app', invoice: 'in_tenant' });
  await event('invoice.paid', { id: 'in_tenant', customer: 'cus_other_app', subscription: 'sub_other_app', amount_paid: 4900, currency: 'usd', status: 'paid', billing_reason: 'subscription_cycle', lines: { data: [{ price: { id: 'price_other_app' }, metadata: { account_id: 'tenant-42' } }] } });
  assert.equal(stripe.refunded('ch_tenant'), 0);
  assert.equal(stripe.sub('sub_other_app').status, 'active');
  // Another product's one-off checkout that calls itself a "topup".
  stripe.charges.unshift({ id: 'ch_user981', payment_intent: 'pi_user981', paid: true, refunded: false, amount: 2000, customer: 'cus_other_app' });
  await event('checkout.session.completed', { id: 'cs_user981', mode: 'payment', client_reference_id: 'user_981', customer: 'cus_other_app', payment_status: 'paid', amount_total: 2000, currency: 'usd', payment_intent: 'pi_user981', metadata: { kind: 'topup', credits: '20' } });
  assert.equal(pay('cs_user981'), null);
  assert.equal(stripe.refunded('ch_user981'), 0);

  // One of OUR customers also buys something else from the same provider account.
  const p = await person('Shared');
  await subscribe(p);
  stripe.charges.unshift({ id: 'ch_shared_other', paid: true, refunded: false, amount: 4900, customer: p.cus, invoice: 'in_shared_other' });
  await event('invoice.paid', { id: 'in_shared_other', customer: p.cus, subscription: 'sub_shared_other', amount_paid: 4900, currency: 'usd', status: 'paid', billing_reason: 'subscription_cycle', lines: { data: [{ price: { id: 'price_other_app' } }] } });
  await event('customer.subscription.updated', { id: 'sub_shared_other', customer: p.cus, status: 'active', items: { data: [{ price: { id: 'price_other_app' } }] } });
  assert.equal(stripe.refunded('ch_shared_other'), 0, 'not refunded as a "second charge"');
  assert.equal(stripe.sub('sub_shared_other').status, 'active', 'and not cancelled');
  assert.equal(acct(p.id).stripe_subscription_id, p.sub, 'and not taken up as our plan');
  assert.equal((await bal(p)).balance, 12);
  assert.equal((await state(p)).payments.length, 1);
  assert.equal(alerts().length, before, 'and nobody is alarmed about any of it');

  // An invoice of ours that names an account this database has never had is not refunded on the spot: only an
  // account that was really closed and deleted is "gone".
  stripe.charges.unshift({ id: 'ch_never', paid: true, refunded: false, amount: 900, customer: 'cus_never', invoice: 'in_never' });
  await event('invoice.paid', { id: 'in_never', customer: 'cus_never', subscription: 'sub_never', amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', lines: { data: [{ price: { id: 'price_grove' }, metadata: { sg_account: 'acc_from_another_server' } }] } });
  assert.equal(stripe.refunded('ch_never'), 0);
  assert.equal(stripe.sub('sub_never').status, 'active');
  assert.ok(alerts().some((m) => m.includes('in_never') && m.includes('could not be matched')), 'a person is told instead');
});

test('a dispute we do not concede sets the signatures aside, and the bank\'s decision settles it either way', async () => {
  const p = await person('Won');
  await subscribe(p);
  await event('checkout.session.completed', topUp(p, 'cs4_won_top', 40));
  await event('charge.dispute.created', { id: 'dp4_won', charge: 'ch_cs4_won_top', payment_intent: 'pi_cs4_won_top', amount: 4000 });
  assert.equal((await bal(p)).balance, 12, 'the 40 are set aside');
  let s = await state(p);
  assert.equal(s.payments.find((x: any) => x.id === 'cs4_won_top').disputed, 'open');
  assert.equal(s.ledger[0].label, 'Card dispute');
  // The bank decides the payment stands.
  await event('charge.dispute.closed', { id: 'dp4_won', charge: 'ch_cs4_won_top', payment_intent: 'pi_cs4_won_top', status: 'won' });
  s = await state(p);
  assert.equal(s.signatures.balance, 52, 'and they come back');
  assert.equal(s.payments.find((x: any) => x.id === 'cs4_won_top').refunded, null);
  assert.equal(s.mangroves, 490);
  assert.ok(subjects(p.email).includes('The disputed payment stands'));
  assert.equal(s.disputed, true, 'payments stay off until a person switches them back on');

  // The bank returns the money.
  const q = await person('Lost');
  await subscribe(q);
  await event('checkout.session.completed', topUp(q, 'cs4_lost_top', 40));
  await event('charge.dispute.created', { id: 'dp4_lost', charge: 'ch_cs4_lost_top', payment_intent: 'pi_cs4_lost_top', amount: 4000 });
  await event('charge.dispute.closed', { id: 'dp4_lost', charge: 'ch_cs4_lost_top', payment_intent: 'pi_cs4_lost_top', status: 'lost' });
  s = await state(q);
  assert.equal(s.signatures.balance, 12);
  assert.equal(s.payments.find((x: any) => x.id === 'cs4_lost_top').refunded, '$40.00');
  assert.equal(s.mangroves, 90);

  // Signatures that are held for envelopes that are out go with the money too. Nobody keeps both.
  const h = await person('Held');
  await subscribe(h);
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const e = await simple(h.c, `held${i}@example.com`);
    await h.c.post(`/envelopes/${e.id}/send`);
    out.push(e.id);
  }
  assert.deepEqual(await bal(h), { balance: 12, held: 12, available: 0 });
  await event('charge.dispute.created', { id: 'dp4_held', charge: `ch_in4_${h.k}_1`, amount: 900 });
  assert.deepEqual(await bal(h), { balance: 3, held: 12, available: -9 }, 'the nine it bought leave the balance although they were held');
  for (const id of out.slice(0, 6)) await h.c.post(`/envelopes/${id}/void`, { reason: 'no longer needed' });
  assert.equal((await bal(h)).available, -3, 'voiding does not bring them back');
  const more = await simple(h.c, 'one-more@example.com');
  assert.equal((await h.c.post(`/envelopes/${more.id}/send`)).status, 402);

  // If the provider cannot be asked about the charge, the message fails as a whole and is handled when it is sent again.
  const d = await person('Retry');
  await subscribe(d);
  const dispute = { type: 'charge.dispute.created', id: 'evt4_dispute_retry', data: { object: { id: 'dp4_retry', charge: `ch_in4_${d.k}_1`, amount: 900 } } };
  stripe.fail('GET', /^charges\//);
  await assert.rejects(billing.applyStripeEvent(dispute));
  assert.equal(acct(d.id).dispute_at, null);
  await billing.applyStripeEvent(dispute);
  assert.ok(acct(d.id).dispute_at, 'the second delivery is not skipped as "seen"');
  assert.equal(stripe.sub(d.sub).status, 'canceled');
});

test('a refund we owe that a person then makes by hand is settled, not left "on its way" for ever', async () => {
  const p = await person('Hand');
  await subscribe(p);
  await p.c.post('/billing/cancel');
  await event('customer.subscription.deleted', { id: p.sub, customer: p.cus, status: 'canceled' });
  stripe.sub(p.sub).status = 'canceled';
  // A charge after the plan ended, and the provider is down for our refund.
  stripe.fail('POST', /^refunds$/);
  await event('invoice.paid', invoice(p, 'in4_hand_ghost', { billing_reason: 'subscription_cycle' }));
  assert.equal((await state(p)).refunds_pending.length, 1);
  // An operator refunds it in the provider's dashboard, and the provider reports that.
  await event('charge.refunded', stripe.refundByHand('ch_in4_hand_ghost', 900));
  assert.equal(pay('in4_hand_ghost').refunded_cents, 900);
  assert.equal((await state(p)).refunds_pending.length, 0);
  assert.equal(subjects(p.email).filter((x) => x === 'Refund sent: $9.00').length, 1);
  const calls = stripe.calls.length;
  await cron.tick();
  assert.equal(stripe.calls.slice(calls).some(([m, path]) => m === 'POST' && path === 'refunds'), false, 'nothing more is asked of the provider for it');
  assert.equal(stripe.refunds.filter((x) => x.charge === 'ch_in4_hand_ghost').length, 0, 'and we never sent a second one');

  // The same when the provider's notice never arrives: our next try is refused as "already refunded", we look, and it is done.
  const q = await person('Hand2');
  await subscribe(q);
  await q.c.post('/billing/cancel');
  await event('customer.subscription.deleted', { id: q.sub, customer: q.cus, status: 'canceled' });
  stripe.sub(q.sub).status = 'canceled';
  stripe.fail('POST', /^refunds$/);
  await event('invoice.paid', invoice(q, 'in4_hand2_ghost', { billing_reason: 'subscription_cycle' }));
  stripe.refundByHand('ch_in4_hand2_ghost', 900);
  await cron.tick();
  assert.equal(pay('in4_hand2_ghost').refunded_cents, 900);
  assert.equal((await state(q)).refunds_pending.length, 0);

  // A refund the bank could not deliver after all is undone, and a person takes over.
  const f = await person('Bounce');
  await subscribe(f);
  await event('checkout.session.completed', topUp(f, 'cs4_bounce_top', 4));
  const ok = await f.c.post('/billing/refund');
  assert.equal((await bal(f)).balance, 12);
  await event('refund.failed', { id: ok.data.reference, status: 'failed', charge: 'ch_cs4_bounce_top' });
  assert.equal(pay('cs4_bounce_top').refunded_cents, 0);
  assert.equal((await bal(f)).balance, 16, 'the signatures are back until it is sorted out');
  assert.ok(subjects(f.email).includes('Your refund could not be delivered'));
  assert.ok(alerts().some((m) => m.includes('could not be delivered by the bank')));
});

test('cancelling never guesses: a failing payment cancelled on the provider\'s page, a lookup that fails, a hiccup while resuming', async () => {
  // Payment failing, then cancelled on the provider's own page: there is no paid month, so it ends now.
  const p = await person('Page');
  await subscribe(p);
  Object.assign(stripe.sub(p.sub), { status: 'past_due', latest_invoice: 'in4_page_open' });
  stripe.invoices.in4_page_open = { id: 'in4_page_open', status: 'open' };
  await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'past_due', current_period_end: unix(20) });
  await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'past_due', cancel_at_period_end: true, current_period_end: unix(20) });
  assert.equal(stripe.sub(p.sub).status, 'canceled');
  assert.equal(stripe.invoices.in4_page_open.status, 'void');
  assert.equal(acct(p.id).plan, 'seedling');
  const mail = mailTo(p.email).find((m) => m.subject === 'Your Grove plan is cancelled')!;
  assert.match(mail.html, /last payment had not gone through, so the plan ends today/);
  assert.doesNotMatch(mail.html, /runs until/);
  // If the provider takes the failed payment anyway, it goes back.
  await event('invoice.paid', invoice(p, 'in4_page_late', { billing_reason: 'subscription_cycle' }));
  assert.equal(pay('in4_page_late').refunded_cents, 900);

  // The provider cannot be asked whether the new month's payment is still waiting: the answer is "not confirmed".
  const q = await person('Lookup');
  await subscribe(q);
  stripe.sub(q.sub).latest_invoice = 'in4_lookup_draft';
  stripe.invoices.in4_lookup_draft = { id: 'in4_lookup_draft', status: 'draft' };
  stripe.fail('GET', /^invoices\/in4_lookup_draft/);
  const no = await q.c.post('/billing/cancel');
  assert.equal(no.status, 502);
  assert.equal(subjects(q.email).includes('Your Grove plan is cancelled'), false);
  const yes = await q.c.post('/billing/cancel');
  assert.equal(yes.data.ended_now, true);
  assert.equal(yes.data.why, 'not_taken');

  // A hiccup at the provider while keeping the plan is an error, not "your plan has ended".
  const r = await person('Hiccup');
  await subscribe(r);
  await r.c.post('/billing/cancel');
  stripe.fail('POST', /^subscriptions\//, 1, 'Too many requests', 429);
  assert.equal((await r.c.post('/billing/resume')).status, 502);
  assert.equal(acct(r.id).plan, 'grove');
  assert.ok(acct(r.id).cancel_at);
  assert.equal(subjects(r.email).includes('Your monthly plan has ended'), false);
  assert.equal((await r.c.post('/billing/resume')).status, 200);

  // A customer that was deleted at the provider does not lock the account out of paying.
  const g = await person('NoCus');
  await subscribe(g);
  await g.c.post('/billing/refund');
  stripe.fail('POST', /^checkout\/sessions$/, 1, "No such customer: 'cus_gone'", 404);
  const again = await g.c.post('/billing/checkout');
  assert.equal(again.status, 200);
  assert.equal(acct(g.id).stripe_customer_id, null);
  assert.equal(stripe.calls.at(-1)![2].customer_email, g.email);

  // A declined card at a new checkout is not mailed as "your monthly payment failed" to someone with no plan.
  const mails = mailTo(g.email).length;
  await event('invoice.payment_failed', { customer: g.cus, subscription: 'sub4_declined_try' });
  assert.equal(mailTo(g.email).length, mails);
});

test('what the timer catches up on: a paid invoice whose message was lost, and a payment that got stuck half way', async () => {
  const p = await person('LostMsg');
  await subscribe(p);
  // The renewal happened three hours ago and no message about it arrived.
  const renewed = invoice(p, 'in4_lostmsg_2', { billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: unix(0), end: unix(30) }, metadata: { sg_account: p.id }, price: { id: 'price_grove' } }] } });
  Object.assign(stripe.sub(p.sub), { latest_invoice: renewed.id, current_period_end: unix(30) });
  db.run('UPDATE accounts SET renews_at=?, sub_event_at=? WHERE id=?', ago(0.2), unix(-1), p.id);
  await cron.tick();
  assert.equal((await bal(p)).balance, 21, 'the month that was paid for is there');
  assert.ok(Date.parse(acct(p.id).renews_at) > Date.now(), 'and the next charge date is in the future again');
  assert.equal((await state(p)).payments.length, 2);

  // A payment that was written down but never turned into signatures is picked up again, and is not listed as a
  // payment until it is.
  const q = await person('Stuck');
  await subscribe(q);
  const inv = invoice(q, 'in4_stuck_2', { billing_reason: 'subscription_cycle' });
  db.run("INSERT INTO payments (id, account_id, amount_cents, currency, at, kind, credits, customer_id, subscription_id) VALUES (?,?,900,'usd',?,'plan',9,?,?)", inv.id, q.id, ago(0.1), q.cus, q.sub);
  assert.equal((await state(q)).payments.length, 1);
  await cron.tick();
  assert.equal((await bal(q)).balance, 21);
  assert.equal((await state(q)).payments.length, 2);

  // Tiny and zero invoices: signatures follow the money, and what buys nothing goes back.
  await event('invoice.paid', invoice(q, 'in4_tiny', { amount_paid: 50, billing_reason: 'subscription_cycle' }));
  assert.equal(pay('in4_tiny').refunded_cents, 50);
  assert.equal((await bal(q)).balance, 21);
  await event('invoice.paid', { id: 'in4_zero', customer: q.cus, subscription: q.sub, amount_paid: 0, currency: 'usd', status: 'paid', billing_reason: 'subscription_cycle', lines: { data: [{ metadata: { sg_account: q.id } }] } });
  assert.ok(alerts().some((m) => m.includes('in4_zero') && m.includes('$0')));
});

test('who pays, the corners: your own name, a changed role, and a public form that cannot overdraw', async () => {
  const p = await person('Corner');
  adjust(p.id, -3);
  // You put yourself on your own document as an approver, send it, then make yourself a signer: still free.
  const e = await simple(p.c, p.email, { recipients: [{ id: 'r', role: 'approver', name: p.name, email: p.email }], fields: [] });
  assert.equal((await p.c.post(`/envelopes/${e.id}/send`)).status, 200);
  const full = (await p.c.get(`/envelopes/${e.id}`)).data.envelope;
  full.recipients[0].role = 'signer';
  full.fields = [{ document_id: full.documents[0].id, recipient_id: full.recipients[0].id, type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }];
  const flip = await p.c.put(`/envelopes/${e.id}`, full);
  assert.equal(flip.status, 200, JSON.stringify(flip.data));
  assert.deepEqual(await bal(p), { balance: 0, held: 0, available: 0 });
  assert.equal((await signAll(e.id, p.email)).status, 200);
  assert.equal((await bal(p)).balance, 0, 'and signing it uses nothing');
  // The same document sent to yourself under your own name is free; under a client's name it is not.
  const own = await simple(p.c, p.email, mine(p));
  assert.equal((await p.c.post(`/envelopes/${own.id}/send`)).status, 200);
  const client = await simple(p.c, p.email, { recipients: [{ id: 'r', role: 'signer', name: 'Walk-in Client', email: p.email }] });
  assert.equal((await p.c.post(`/envelopes/${client.id}/send`)).status, 402);

  // A public form on an account with one signature: one visitor can start, the next is told to come back later,
  // nobody is emailed "you are running low" for a start, and the balance never goes below zero through the form.
  const o = await person('OneLeft');
  adjust(o.id, -2);
  const form = await simple(o.c, '', { kind: 'template', subject: 'Sign up', recipients: [{ id: 'r', role: 'signer', role_name: 'Member' }] });
  await o.c.post('/powerforms', { template_id: form.id, name: 'Sign up' });
  const slug = (await o.c.get('/powerforms')).data.powerforms[0].slug;
  const visit = (i: number) => {
    const v = new Client();
    v.ip = `203.0.116.${i + 1}`;
    return v.post(`/public/powerforms/${slug}/start`, { name: `Visitor ${i}`, email: `form-visitor-${i}@example.com` });
  };
  // Starting holds nothing and blocks nobody: three people can be filling the form in with one signature left.
  const starts = [await visit(0), await visit(1), await visit(2)];
  assert.deepEqual(starts.map((x) => x.status), [200, 200, 200]);
  assert.equal(subjects(o.email).some((x) => /signatures? left|used all your signatures/.test(x)), false);
  const of = (i: number) => db.get('SELECT e.id FROM envelopes e JOIN recipients r ON r.envelope_id=e.id WHERE e.account_id=? AND r.email=?', o.id, `form-visitor-${i}@example.com`).id;
  // The first to finish gets the signature. The next is told, politely and truthfully, at the moment it matters:
  // nothing is signed, the balance never goes below zero, and the owner hears it once with the real numbers.
  assert.equal((await signAll(of(0), 'form-visitor-0@example.com')).status, 200);
  assert.deepEqual(await bal(o), { balance: 0, held: 0, available: 0 });
  const late = await signAll(of(1), 'form-visitor-1@example.com');
  assert.equal(late.status, 503);
  assert.match(late.data.error, /cannot take your signature at the moment\. That is nothing you did[\s\S]*Everything you filled in is saved/);
  assert.equal(db.get("SELECT status FROM recipients WHERE email='form-visitor-1@example.com'").status !== 'completed', true);
  assert.equal((await signAll(of(2), 'form-visitor-2@example.com')).status, 503);
  assert.deepEqual(await bal(o), { balance: 0, held: 0, available: 0 });
  const told = mailTo(o.email).filter((m) => m.subject.includes('has run out of signatures'));
  assert.equal(told.length, 1, 'the owner is told once, not per visitor');
  assert.match(told[0].html, /none is free right now: you have 0 signatures on your balance/);
  // A new visitor is told before typing anything, and once the owner has topped up, the one who was turned away
  // finishes with the same link.
  assert.equal((await visit(3)).status, 503);
  adjust(o.id, 1);
  assert.equal((await signAll(of(1), 'form-visitor-1@example.com')).status, 200);
  assert.deepEqual(await bal(o), { balance: 0, held: 0, available: 0 });

  // The owner's own envelopes keep what is held for them: a form visitor cannot take a held signature.
  const h = await person('Held');
  adjust(h.id, -2);
  const hf = await simple(h.c, '', { kind: 'template', subject: 'Waiver', recipients: [{ id: 'r', role: 'signer', role_name: 'Guest' }] });
  await h.c.post('/powerforms', { template_id: hf.id, name: 'Waiver' });
  const hslug = (await h.c.get('/powerforms')).data.powerforms[0].slug;
  const guest = new Client();
  guest.ip = '203.0.116.77';
  assert.equal((await guest.post(`/public/powerforms/${hslug}/start`, { name: 'Guest One', email: 'guest-one@example.com' })).status, 200);
  const ownOut = await simple(h.c, 'client-held@example.com');
  assert.equal((await h.c.post(`/envelopes/${ownOut.id}/send`)).status, 200);
  assert.deepEqual(await bal(h), { balance: 1, held: 1, available: 0 });
  const ge = db.get("SELECT e.id FROM envelopes e JOIN recipients r ON r.envelope_id=e.id WHERE r.email='guest-one@example.com'").id;
  assert.equal((await signAll(ge, 'guest-one@example.com')).status, 503);
  assert.equal((await signAll(ownOut.id, 'client-held@example.com')).status, 200);
  assert.deepEqual(await bal(h), { balance: 0, held: 0, available: 0 });
});
