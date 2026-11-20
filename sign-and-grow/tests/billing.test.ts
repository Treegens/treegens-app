// Billing, against a simulated payment provider.
// The model: $9 a month adds 9 signatures, extra signatures are $1 each, every dollar plants 10 mangroves, and
// signatures never expire. These tests also cover the complaints people most often make about subscriptions:
// surprise renewals, being charged after cancelling, no way to cancel, refused refunds, surprise charges, lockouts.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, simple, draft, signUp, signAll, mailTo, tokenFor, type Server } from './helpers.ts';

import { stripe, unix } from './stripe-fake.ts';

let db: Server['db'];
let billing: Server['billing'];
let cron: Server['cron'];

let owner: Client;
let accountId: string;
const account = () => db.get('SELECT * FROM accounts WHERE id=?', accountId);
const sig = async (c: Client = owner) => (await c.get('/billing')).data.signatures;
const subjects = (email: string) => mailTo(email).map((m) => m.subject);
const event = (type: string, object: any) => billing.applyStripeEvent({ type, data: { object } });
const subscribe = () => event('checkout.session.completed', { mode: 'subscription', client_reference_id: accountId, customer: 'cus_1', subscription: 'sub_1' });
const monthly = async (invoice: string, sub = 'sub_1', over: any = {}) => {
  stripe.charges.unshift({ id: `ch_${invoice}`, paid: true, refunded: false, amount: 900, customer: 'cus_1', invoice });
  await event('invoice.paid', { id: invoice, customer: 'cus_1', subscription: sub, amount_paid: 900, currency: 'usd', status: 'paid', hosted_invoice_url: `https://pay.example/${invoice}`, lines: { data: [{ period: { start: unix(0), end: unix(30) } }] }, ...over });
};
const topUp = (id: string, credits: number, cents = credits * 100, who = accountId) =>
  event('checkout.session.completed', { id, mode: 'payment', client_reference_id: who, customer: 'cus_1', payment_status: 'paid', amount_total: cents, currency: 'usd', payment_intent: `pi_${id}`, metadata: { kind: 'topup', credits: String(credits) } });

before(async () => {
  ({ db, billing, cron } = await boot());
  owner = await signUp('Olive Owner', 'olive@example.com');
  accountId = (await owner.get('/me')).data.account.id;
});

test('a new account has 3 signatures to try; one is held per signer and only used when somebody signs', async () => {
  assert.deepEqual(await sig(), { balance: 3, held: 0, available: 3 });

  // Two signers and a copy recipient: two signatures are held, the copy is free.
  const two = await draft(owner, { ordered: false });
  assert.equal((await owner.post(`/envelopes/${two.id}/send`)).status, 200);
  assert.deepEqual(await sig(), { balance: 3, held: 2, available: 1 });

  // Voiding gives them straight back. Nobody pays for a typo.
  await owner.post(`/envelopes/${two.id}/void`, { reason: 'typo' });
  assert.deepEqual(await sig(), { balance: 3, held: 0, available: 3 });

  // A signature is used at the moment someone signs, not before.
  const one = await simple(owner, 'a1@example.com');
  await owner.post(`/envelopes/${one.id}/send`);
  assert.deepEqual(await sig(), { balance: 3, held: 1, available: 2 });
  await signAll(one.id, 'a1@example.com');
  assert.deepEqual(await sig(), { balance: 2, held: 0, available: 2 });
  assert.equal((await owner.get('/billing')).data.ledger[0].label, 'Signature used');

  // Declining gives it back too.
  const dec = await simple(owner, 'a2@example.com');
  await owner.post(`/envelopes/${dec.id}/send`);
  await new Client().post(`/sign/${tokenFor(dec.id, 'a2@example.com')}/decline`, { reason: 'Not for me' });
  assert.equal((await sig()).available, 2);

  // Signing your own document is always free, and so are approvers, viewers and copies.
  const own = await simple(owner, 'olive@example.com');
  assert.equal((await owner.post(`/envelopes/${own.id}/send`)).status, 200);
  const approve = await simple(owner, 'boss@example.com', { recipients: [{ id: 'r', role: 'approver', name: 'Boss', email: 'boss@example.com' }], fields: [] });
  assert.equal((await owner.post(`/envelopes/${approve.id}/send`)).status, 200);
  assert.equal((await sig()).available, 2);

  // Not enough left: sending stops and says exactly why. Nothing is charged.
  const many = await draft(owner, { ordered: false, recipients: [
    { id: 'r1', role: 'signer', name: 'One', email: 'one@example.com' }, { id: 'r2', role: 'signer', name: 'Two', email: 'two@example.com' }, { id: 'r3', role: 'signer', name: 'Three', email: 'three@example.com' },
  ], fields: ['r1', 'r2', 'r3'].map((r, i) => ({ document_id: 'd1', recipient_id: r, type: 'signature', page: 0, x: 0.1, y: 0.2 + i * 0.1, w: 0.2, h: 0.05 })) });
  const refused = await owner.post(`/envelopes/${many.id}/send`);
  assert.equal(refused.status, 402);
  assert.match(refused.data.error, /needs 3 signatures and you have 2 left/);
  assert.match(refused.data.error, /Nothing is charged unless you choose it/);
  assert.equal(db.get('SELECT COUNT(*) n FROM payments').n, 0);

  // Using the last two: a heads-up at two left was already sent, and one more when they are gone.
  const last = await draft(owner, { ordered: false });
  assert.equal((await owner.post(`/envelopes/${last.id}/send`)).status, 200);
  assert.equal((await sig()).available, 0);
  assert.ok(subjects('olive@example.com').includes('2 signatures left') && subjects('olive@example.com').includes('You have used all your signatures'));

  // A correction that adds a signer needs a signature like any other, and a refused correction changes nothing.
  const full = (await owner.get(`/envelopes/${last.id}`)).data.envelope;
  full.recipients.push({ id: 'extra', role: 'signer', name: 'Extra', email: 'extra@example.com', routing_order: 1 });
  full.fields.push({ document_id: full.documents[0].id, recipient_id: 'extra', type: 'signature', page: 0, x: 0.6, y: 0.2, w: 0.2, h: 0.05 });
  assert.equal((await owner.put(`/envelopes/${last.id}`, full)).status, 402);
  assert.equal((await owner.get(`/envelopes/${last.id}`)).data.envelope.recipients.length, 3);
  // Fixing a name costs nothing.
  const fix = (await owner.get(`/envelopes/${last.id}`)).data.envelope;
  fix.recipients[0].name = 'Ada Fixed';
  assert.equal((await owner.put(`/envelopes/${last.id}`, fix)).status, 200);
  await owner.post(`/envelopes/${last.id}/void`, { reason: 'test over' });
});

test('the monthly plan: $9 adds 9 signatures and plants 90 mangroves', async () => {
  assert.equal((await owner.post('/billing/checkout')).data.url, 'https://pay.example/subscription');
  await subscribe();
  assert.equal(account().plan, 'grove');
  const welcome = mailTo('olive@example.com').find((m) => m.subject === 'Welcome to Grove')!;
  assert.match(welcome.html, /\$9\.00 a month adds 9 signatures/);
  assert.match(welcome.html, /90 mangrove trees/);
  assert.match(welcome.link, /\/billing\/stop\?token=/, 'with a stop link that needs no login');

  const before = (await sig()).balance;
  await monthly('in_1');
  assert.equal((await sig()).balance, before + 9);
  const receipt = mailTo('olive@example.com').find((m) => m.subject === 'Receipt: $9.00 for 9 signatures')!;
  assert.match(receipt.html, /90 mangrove trees/);
  assert.match(receipt.html, /Next charge/);
  const state = (await owner.get('/billing')).data;
  assert.equal(state.price, 9);
  assert.equal(state.payments[0].credits, 9);
  assert.equal(state.payments[0].receipt_url, 'https://pay.example/in_1');
  assert.equal(state.mangroves, 90);
  assert.ok(state.renews_at);
  await monthly('in_1'); // the provider repeating itself changes nothing
  assert.equal((await sig()).balance, before + 9);
});

test('top-ups: $1 a signature, only ever on purpose', async () => {
  const free = await signUp('Fred Free', 'fred@example.com');
  assert.equal((await free.post('/billing/topup', { quantity: 5 })).status, 400, 'top-ups go with the monthly plan');
  assert.equal((await owner.post('/billing/topup', { quantity: 0 })).status, 400);
  assert.equal((await owner.post('/billing/topup', { quantity: 5000 })).status, 400);
  const start = await owner.post('/billing/topup', { quantity: 5 });
  assert.equal(start.data.total, '$5.00');
  const call = stripe.calls.at(-1)!;
  assert.equal(call[2].mode, 'payment');
  assert.equal(call[2]['line_items[0][price_data][unit_amount]'], '100');
  assert.equal(call[2]['line_items[0][quantity]'], '5');

  const before = (await sig()).balance;
  await topUp('cs_top1', 5);
  assert.equal((await sig()).balance, before + 5);
  await topUp('cs_top1', 5); // replayed event
  assert.equal((await sig()).balance, before + 5);
  const receipt = mailTo('olive@example.com').find((m) => m.subject === 'Receipt: $5.00 for 5 signatures')!;
  assert.match(receipt.html, /50 mangrove trees/);
  assert.equal(account().plan, 'grove', 'a top-up never changes the plan');

  // The count can never exceed what was paid for.
  await topUp('cs_top2', 50, 200);
  assert.equal((await sig()).balance, before + 7);

  // Coming back from checkout applies it at once, without waiting for the provider's event.
  stripe.sessions.cs_top3 = { id: 'cs_top3', mode: 'payment', client_reference_id: accountId, payment_status: 'paid', amount_total: 300, currency: 'usd', payment_intent: 'pi_cs_top3', metadata: { kind: 'topup', credits: '3' } };
  assert.equal((await owner.post('/billing/sync', { session_id: 'cs_top3' })).data.signatures.balance, before + 10);
  assert.equal((await free.post('/billing/sync', { session_id: 'cs_top3' })).data.signatures.balance, 3, 'someone else cannot claim it');
});

test('signatures roll over, and a reminder comes before each renewal with a one-click stop', async () => {
  const before = (await sig()).balance;
  await monthly('in_2');
  assert.equal((await sig()).balance, before + 9, 'nothing is reset at renewal');

  await event('invoice.upcoming', { customer: 'cus_1', amount_due: 900, currency: 'usd', next_payment_attempt: unix(3) });
  const m = mailTo('olive@example.com').find((x) => x.subject.startsWith('Heads up:'))!;
  assert.match(m.subject, /\$9\.00/);
  assert.match(m.html, /roll over/);

  // The link works with no session at all.
  const anon = new Client();
  const token = new URL(m.link).searchParams.get('token')!;
  assert.equal((await anon.get(`/public/billing/stop?token=${encodeURIComponent(token)}`)).data.price, 9);
  assert.equal((await anon.post('/public/billing/stop', { token: token + 'x' })).status, 410, 'a tampered link is refused');
  const stopped = await anon.post('/public/billing/stop', { token });
  assert.match(stopped.data.reference, /^SG-/);
  assert.equal(stripe.sub('sub_1').cancel_at_period_end, true, 'the provider was told straight away');
  const conf = mailTo('olive@example.com').find((x) => x.subject === 'Your Grove plan is cancelled')!;
  assert.match(conf.html, new RegExp(stopped.data.reference));
  assert.match(conf.html, /never expire/);

  // No reminder for a plan that is already ending, and it can be resumed.
  const count = mailTo('olive@example.com').length;
  await event('invoice.upcoming', { customer: 'cus_1', amount_due: 900, next_payment_attempt: unix(3) });
  assert.equal(mailTo('olive@example.com').length, count);
  assert.equal((await owner.post('/billing/resume')).status, 200);
  assert.equal(account().cancel_at, null);
});

test('cancelling keeps every signature; a charge after cancellation refunds itself and adds nothing', async () => {
  const r = await owner.post('/billing/cancel');
  assert.ok(r.data.ends_at && r.data.reference);
  assert.equal((await owner.post('/billing/cancel')).data.reference, r.data.reference, 'cancelling twice is harmless');
  const kept = (await sig()).balance;

  await event('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1', status: 'canceled' });
  stripe.sub('sub_1').status = 'canceled';
  assert.equal(account().plan, 'seedling');
  assert.equal((await sig()).balance, kept, 'paid-for signatures survive the plan ending');
  assert.match(mailTo('olive@example.com').find((m) => m.subject === 'Your monthly plan has ended')!.html, /never expire/);

  // They can still be used without a plan.
  const e = await simple(owner, 'later@example.com');
  assert.equal((await owner.post(`/envelopes/${e.id}/send`)).status, 200);
  await owner.post(`/envelopes/${e.id}/void`, { reason: 'test over' });

  // The provider charges anyway (the thing people complain about most): refunded by itself, no signatures added.
  await monthly('in_ghost');
  const ghost = db.get("SELECT * FROM payments WHERE id='in_ghost'");
  assert.equal(ghost.refunded_cents, 900);
  assert.equal((await sig()).balance, kept);
  assert.ok(subjects('olive@example.com').some((s) => s.startsWith('Refund sent:')));
  assert.equal((await owner.get('/export')).status, 200, 'documents are untouched');
  assert.ok((await owner.get('/billing')).data.payments.length >= 3, 'billing history stays available');
});

test('unused signatures from the latest payment are refunded on request, to the cent', async () => {
  const pat = await signUp('Pat Payer', 'patp@example.com');
  const pid = (await pat.get('/me')).data.account.id;
  await event('checkout.session.completed', { mode: 'subscription', client_reference_id: pid, customer: 'cus_p', subscription: 'sub_p' });
  stripe.charges.unshift({ id: 'ch_p1', paid: true, refunded: false, amount: 900, customer: 'cus_p' });
  await event('invoice.paid', { id: 'in_p1', customer: 'cus_p', subscription: 'sub_p', amount_paid: 900, currency: 'usd' });
  assert.deepEqual((await pat.get('/billing')).data.signatures, { balance: 12, held: 0, available: 12 });
  assert.equal((await pat.get('/billing')).data.refund.amount, '$9.00');

  // Five get used. Three of those came free, so seven of the nine paid for are still unused.
  for (let i = 0; i < 5; i++) {
    const e = await simple(pat, `p${i}@example.com`);
    await pat.post(`/envelopes/${e.id}/send`);
    await signAll(e.id, `p${i}@example.com`);
  }
  const offer = (await pat.get('/billing')).data.refund;
  assert.equal(offer.signatures, 7);
  assert.equal(offer.amount, '$7.00');
  const done = await pat.post('/billing/refund');
  assert.equal(done.data.refunded, '$7.00');
  assert.equal(done.data.plan_ended, true);
  assert.deepEqual(stripe.refunds.at(-1)!.params, { charge: 'ch_p1', amount: '700' });
  assert.equal(stripe.sub('sub_p').status, 'canceled', 'the plan was ended with the provider before any money moved');
  assert.equal((await pat.get('/billing')).data.signatures.balance, 0);
  assert.equal((await pat.get('/billing')).data.plan, 'seedling');
  assert.equal((await pat.post('/billing/refund')).status, 400, 'nothing left to refund');

  // A top-up is refunded through its own payment and leaves the plan alone.
  const before = (await sig()).balance;
  await event('checkout.session.completed', { mode: 'subscription', client_reference_id: accountId, customer: 'cus_1', subscription: 'sub_2' });
  assert.equal(account().plan, 'grove');
  await topUp('cs_top9', 4);
  assert.equal((await owner.get('/billing')).data.refund.amount, '$4.00');
  const back = await owner.post('/billing/refund');
  assert.equal(back.data.plan_ended, false);
  assert.deepEqual(stripe.refunds.at(-1)!.params, { payment_intent: 'pi_cs_top9', amount: '400' });
  assert.equal((await sig()).balance, before);

  // Outside the window there is no automatic refund.
  await topUp('cs_old', 2);
  db.run("UPDATE payments SET at=? WHERE id='cs_old'", new Date(Date.now() - 45 * 864e5).toISOString());
  db.run("UPDATE payments SET at=? WHERE id!='cs_old' AND account_id=?", new Date(Date.now() - 100 * 864e5).toISOString(), accountId);
  assert.equal((await owner.get('/billing')).data.refund, null);

  // Refunded money is not counted as planted.
  const pub = (await new Client().get('/public/impact')).data;
  const paid = db.get('SELECT SUM(amount_cents - refunded_cents) c FROM payments').c / 100;
  assert.equal(pub.donatedUsd, paid);
  assert.equal(pub.treesFunded, Math.floor(paid * 10));
});

test('locked out? stop billing by card, or find every subscription by email', async () => {
  const anon = new Client();
  assert.equal((await anon.post('/public/billing/stop-by-card', { email: 'olive@example.com', last4: '0000' })).status, 404);
  const ok = await anon.post('/public/billing/stop-by-card', { email: 'olive@example.com', last4: '4242' });
  assert.equal(ok.data.stopped, true);
  assert.ok(account().cancel_at);

  assert.equal((await anon.post('/public/billing/find', { email: 'olive@example.com' })).status, 200);
  assert.ok(mailTo('olive@example.com').at(-1)!.html.includes('Stop renewal for'));
  assert.equal((await anon.post('/public/billing/find', { email: 'stranger@example.com' })).status, 200);
  assert.match(mailTo('stranger@example.com').at(-1)!.html, /we are not charging you/);

  assert.equal((await owner.post('/billing/remove-card')).data.removed, 1);
  assert.equal(stripe.cards.length, 0);
});

test('bulk send checks the whole batch first; a public form with no signatures says so and tells its owner', async () => {
  const solo = await signUp('Sam Solo', 'samsolo@example.com');
  const tpl = await simple(solo, '', { kind: 'template', subject: 'Batch form', recipients: [{ id: 'r', role: 'signer', role_name: 'Member' }] });
  const rows = [1, 2, 3, 4].map((i) => ({ Member: { name: `M ${i}`, email: `m${i}@example.com` } }));
  const refused = await solo.post('/bulk', { template_id: tpl.id, rows });
  assert.equal(refused.status, 402);
  assert.match(refused.data.error, /needs 4 signatures and you have 3 left/);
  assert.equal(db.get('SELECT COUNT(*) n FROM bulk_batches').n, 0, 'nothing was sent');
  assert.equal((await solo.post('/bulk', { template_id: tpl.id, rows: rows.slice(0, 3) })).data.sent, 3);

  await solo.post('/powerforms', { template_id: tpl.id, name: 'Join us' });
  const slug = (await solo.get('/powerforms')).data.powerforms[0].slug;
  const walkIn = await new Client().post(`/public/powerforms/${slug}/start`, { name: 'Walk In', email: 'walkin@example.com' });
  assert.equal(walkIn.status, 503);
  assert.match(walkIn.data.error, /cannot take new signatures right now/);
  await new Client().post(`/public/powerforms/${slug}/start`, { name: 'Second', email: 'second@example.com' });
  assert.equal(subjects('samsolo@example.com').filter((s) => s.includes('has run out of signatures')).length, 1, 'the owner is told once, not per visitor');
});

test('paying but not using it: a nudge, then the renewal is stopped for them', async () => {
  await owner.post('/billing/resume');
  db.run('UPDATE accounts SET created_at=?, cancel_at=NULL WHERE id=?', new Date(Date.now() - 120 * 864e5).toISOString(), accountId);
  db.run('UPDATE envelopes SET sent_at=? WHERE account_id=? AND sent_at IS NOT NULL', new Date(Date.now() - 100 * 864e5).toISOString(), accountId);
  assert.equal((await cron.tick()).nudged, 1);
  assert.equal((await cron.tick()).nudged, 0);
  assert.ok(subjects('olive@example.com').includes('Still using Sign&Grow?'));

  await event('invoice.upcoming', { customer: 'cus_1', amount_due: 900, next_payment_attempt: unix(3) });
  assert.ok(account().cancel_at, 'renewal turned off after 90 quiet days');
  assert.equal(account().plan, 'grove', 'the paid month is kept');
  assert.match(mailTo('olive@example.com').find((m) => m.subject.startsWith('We stopped your renewal'))!.html, /never expire/);
});

test('back from checkout the plan is active at once; a card dispute stops all further billing', async () => {
  const nina = await signUp('Nina New', 'nina@example.com');
  const nid = (await nina.get('/me')).data.account.id;
  stripe.sessions.cs_sub1 = { id: 'cs_sub1', mode: 'subscription', client_reference_id: nid, customer: 'cus_n', subscription: 'sub_n', payment_status: 'paid' };
  assert.equal((await owner.post('/billing/sync', { session_id: 'cs_sub1' })).data.plan !== undefined, true);
  assert.equal(db.get('SELECT plan FROM accounts WHERE id=?', accountId).plan, 'grove', "someone else's session changes nothing here");
  const synced = await nina.post('/billing/sync', { session_id: 'cs_sub1' });
  assert.equal(synced.data.plan, 'grove');
  assert.ok(synced.data.renews_at);
  await event('checkout.session.completed', { mode: 'subscription', client_reference_id: nid, customer: 'cus_n', subscription: 'sub_n' });
  assert.equal(subjects('nina@example.com').filter((s) => s === 'Welcome to Grove').length, 1, 'the late event does not welcome them twice');

  await owner.post('/billing/resume');
  stripe.charges.unshift({ id: 'ch_x', customer: 'cus_1', amount: 900, currency: 'usd' });
  await event('charge.dispute.created', { id: 'dp_1', charge: 'ch_x' });
  assert.equal(account().plan, 'seedling');
  assert.equal(stripe.sub('sub_2').status, 'canceled');
  assert.deepEqual(stripe.disputesClosed, ['dp_1'], 'the dispute is accepted with the provider, not fought');
  assert.match(mailTo('olive@example.com').find((m) => m.subject === 'We stopped all billing on your account')!.html, /not contesting it/);
});

test('the code GROWalition makes the monthly plan free', async () => {
  // Entered at sign-up, in any letter case.
  const gro = new Client();
  assert.equal((await gro.post('/auth/signup', { name: 'Gro Member', email: 'gro@example.com', password: 'correct horse battery', code: 'growALITION' })).status, 200);
  await new Client().post('/auth/verify', { token: db.get("SELECT verify_token t FROM users WHERE email='gro@example.com'").t });
  let state = (await gro.get('/billing')).data;
  assert.equal(state.plan, 'grove');
  assert.equal(state.free_with, 'GROWalition');
  assert.deepEqual(state.signatures, { balance: 12, held: 0, available: 12 }, '3 to try plus this month\'s 9');
  assert.equal(state.renews_at, null);
  assert.equal(state.refund, null, 'nothing was paid, so there is nothing to refund');
  assert.equal(state.ledger[0].label, 'Monthly plan, free with your code');
  assert.equal((await gro.get('/billing')).data.signatures.balance, 12, 'looking twice does not add twice');
  assert.equal(db.get('SELECT COUNT(*) n FROM payments WHERE account_id=?', (await gro.get('/me')).data.account.id).n, 0);

  // Next month the plan's signatures arrive again, on top of what is left.
  const gid = (await gro.get('/me')).data.account.id;
  db.run("UPDATE credits SET ref='2026-01' WHERE account_id=? AND reason='code'", gid);
  assert.equal((await gro.get('/billing')).data.signatures.balance, 21);

  // They can send, and top up like anyone on the plan. There is nothing to cancel and nothing to check out.
  const e = await simple(gro, 'friend@example.com');
  assert.equal((await gro.post(`/envelopes/${e.id}/send`)).status, 200);
  assert.equal((await gro.post('/billing/topup', { quantity: 2 })).data.total, '$2.00');
  assert.equal((await gro.post('/billing/cancel')).status, 400);
  assert.equal((await gro.post('/billing/checkout')).status, 400);
  await cron.tick();
  assert.equal(subjects('gro@example.com').includes('Still using Sign&Grow?'), false, 'never nudged about a payment they do not make');

  // Entered later on the Plan page. A wrong code says so.
  const late = await signUp('Late Joiner', 'late@example.com');
  assert.equal((await late.post('/billing/redeem', { code: 'nope' })).status, 400);
  const ok = await late.post('/billing/redeem', { code: ' GROWalition ' });
  assert.equal(ok.data.free_with, 'GROWalition');
  assert.equal(ok.data.signatures.balance, 12);
  assert.ok(subjects('late@example.com').includes('Code GROWalition accepted: your plan is free'));
  assert.equal((await late.post('/billing/redeem', { code: 'GROWalition' })).data.signatures.balance, 12, 'entering it again changes nothing');

  // Someone already paying who adds the code is never charged again, and keeps the plan when the old one winds down.
  const payer = await signUp('Paying Member', 'payer@example.com');
  const pid = (await payer.get('/me')).data.account.id;
  await event('checkout.session.completed', { mode: 'subscription', client_reference_id: pid, customer: 'cus_pay', subscription: 'sub_pay' });
  await payer.post('/billing/redeem', { code: 'GROWalition' });
  assert.equal(stripe.sub('sub_pay').status, 'canceled', 'the paid subscription was ended there and then');
  await event('customer.subscription.deleted', { id: 'sub_pay', customer: 'cus_pay', status: 'canceled' });
  assert.equal(db.get('SELECT plan FROM accounts WHERE id=?', pid).plan, 'grove');
  assert.equal(subjects('payer@example.com').includes('Your monthly plan has ended'), false);

  // The code can be changed or switched off without touching the software.
  process.env.FREE_PLAN_CODES = 'Mangrove2027';
  assert.equal((await owner.post('/billing/redeem', { code: 'GROWalition' })).status, 400);
  delete process.env.FREE_PLAN_CODES;
});
