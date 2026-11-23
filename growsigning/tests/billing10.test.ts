// Billing, tenth round: what the earlier rounds left open about expiring signatures.
//   1. The hour between the end of a paid month and its renewal payment: a signature used out of a top-up in that
//      gap moves to the new month when the payment arrives, so the top-up is not spent on what the month covers.
//   2. One rule for "would the next signatures come out of a payment" (paidForecast), which the tree sentence at the
//      review step asks, instead of a copy of the order kept in impact.ts.
//   3. Two swaps to another person at the very same moment with one signature free: one goes through, one is refused.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, Client, signUp, simple, signAll, type Server } from './helpers.ts';
import { stripe, unix } from './stripe-fake.ts';

const RealDate = Date;
let shift = 0;
class FakeDate extends RealDate {
  constructor(...a: any[]) {
    if (a.length === 0) super(RealDate.now() + shift);
    else super(...(a as [any]));
  }
  static now() {
    return RealDate.now() + shift;
  }
}
(globalThis as any).Date = FakeDate;
const travel = (days: number) => void (shift += Math.round(days * 864e5));

let db: Server['db'];
let billing: Server['billing'];
let credits: typeof import('../src/server/credits.ts');
let impact: typeof import('../src/server/impact.ts');

let evn = 0;
const event = (type: string, object: any) => billing.applyStripeEvent({ id: `evt10_${++evn}`, type, created: Math.floor(Date.now() / 1000), data: { object } });
const acct = (id: string) => db.get('SELECT * FROM accounts WHERE id=?', id);
const PW = 'correct horse battery';

type Person = { c: Client; id: string; name: string; email: string; cus: string; sub: string; k: number; ip: string };
let n = 0;
async function person(first: string): Promise<Person> {
  const k = ++n;
  const email = `${first.toLowerCase()}${k}@ten.example`;
  const ip = `198.51.121.${k}`;
  const c = await signUp(`${first} Tester`, email, ip);
  return { c, id: (await c.get('/me')).data.account.id, name: `${first} Tester`, email, cus: `cus10_${k}`, sub: `sub10_${k}`, k, ip };
}
async function again(p: Person) {
  p.c = new Client();
  p.c.ip = p.ip;
  const r = await p.c.post('/auth/login', { email: p.email, password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
function invoice(p: Person, inv: string, days: number, over: any = {}) {
  const o = {
    id: inv, customer: p.cus, subscription: p.sub, amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', hosted_invoice_url: `https://pay.example/${inv}`,
    lines: { data: [{ period: { start: unix(0), end: unix(days) }, metadata: { sg_account: p.id }, price: { id: 'price_grove' } }] }, ...over,
  };
  stripe.invoices[inv] = o;
  stripe.charges.unshift({ id: `ch_${inv}`, paid: true, refunded: false, amount: o.amount_paid, currency: 'usd', customer: p.cus, invoice: inv, last4: '4242', created: unix(0) });
  return o;
}
async function subscribe(p: Person, days: number, inv = `in10_${p.k}_1`) {
  Object.assign(stripe.sub(p.sub), { customer: p.cus, status: 'active', metadata: { sg_account: p.id }, current_period_end: unix(days) });
  const paid = invoice(p, inv, days);
  stripe.sub(p.sub).current_period_end = paid.lines.data[0].period.end;
  await event('checkout.session.completed', { id: `cs10_${p.k}`, mode: 'subscription', client_reference_id: p.id, customer: p.cus, subscription: p.sub, payment_status: 'paid' });
  await event('invoice.paid', paid);
}
async function topUp(p: Person, id: string, k: number) {
  stripe.charges.unshift({ id: `ch_${id}`, payment_intent: `pi_${id}`, paid: true, refunded: false, amount: k * 100, currency: 'usd', customer: p.cus, last4: '4242', created: unix(0) });
  await event('checkout.session.completed', { id, mode: 'payment', client_reference_id: p.id, customer: p.cus, payment_status: 'paid', amount_total: k * 100, currency: 'usd', payment_intent: `pi_${id}`, metadata: { kind: 'sg_topup', credits: String(k), sg_account: p.id } });
}
const state = (p: Person) => billing.billingState(acct(p.id));
async function send(p: Person, email: string) {
  const e = await simple(p.c, email, { recipients: [{ id: 'r', role: 'signer', name: `Signer ${email}`, email }] });
  const r = await p.c.post(`/envelopes/${e.id}/send`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { id: e.id as string, rid: db.get('SELECT id FROM recipients WHERE envelope_id=? AND email=?', e.id, email).id as string };
}
async function used(p: Person, k: number, tag: string) {
  for (let i = 0; i < k; i++) {
    const e = await send(p, `${tag}${i}-${p.k}@signers.example`);
    assert.equal((await signAll(e.id, `${tag}${i}-${p.k}@signers.example`)).status, 200);
  }
}
const lots = (p: Person, source: string) => credits.lotsOf(p.id).filter((l) => l.source === source);
function balanced(p: Person) {
  const s = credits.ledgerSums(p.id);
  const sum = credits.creditSummary(p.id);
  assert.equal(s.bought + s.given, s.used + s.held + s.refunded + s.expired + s.adjusted + s.left, `every signature accounted for: ${JSON.stringify(s)}`);
  assert.equal(sum.available, s.available, 'what can be sent with, two ways');
  for (const l of credits.lotsOf(p.id)) assert.equal(l.qty, l.used + l.held + l.refunded + l.expired + l.adjusted + l.left, `lot ${l.source} ${JSON.stringify(l)}`);
  return s;
}

before(async () => {
  ({ db, billing } = await boot());
  credits = await import('../src/server/credits.ts');
  impact = await import('../src/server/impact.ts');
});

test('the tree sentence at review asks one rule: every next signature out of a payment that stands, soonest to expire first', async () => {
  const p = await person('Forecast');
  // Only the three free ones of a new account: nothing was paid for.
  assert.equal(credits.paidForecast(p.id, 1), false);
  await topUp(p, `cs10_top_${p.k}`, 2);
  // The free ones expire sooner, so they are used first: a free one is in the way.
  assert.equal(credits.paidForecast(p.id, 1), false);
  await used(p, 3, 'f');
  assert.equal(credits.paidForecast(p.id, 1), true);
  assert.equal(credits.paidForecast(p.id, 2), true);
  assert.equal(credits.paidForecast(p.id, 3), false, 'one more than there is');
  assert.equal(credits.paidForecast(p.id, 0), false);
  // Since the 5 trees rule (23 November 2026) the draft's answer no longer asks about payments: every signature
  // from the balance plants trees, so the review step asks allCountForecast (tests/trees-5.test.ts). paidForecast
  // stays as the rule of the order signatures are used in.
  const e = await simple(p.c, 'draft', { recipients: [{ id: 'r', role: 'signer', name: 'Dana Draft', email: `draft-${p.k}@signers.example` }] });
  const full = () => ({ ...db.get('SELECT * FROM envelopes WHERE id=?', e.id), recipients: db.all('SELECT * FROM recipients WHERE envelope_id=?', e.id) });
  assert.equal(impact.allCountForecast(full()), true);
  // A payment that went back in full is no longer "a payment that stands"; the draft's signatures still count.
  db.run('UPDATE payments SET refunded_cents=amount_cents WHERE account_id=?', p.id);
  assert.equal(credits.paidForecast(p.id, 1), false);
  assert.equal(impact.allCountForecast(full()), true);
  assert.doesNotMatch(readFileSync('src/server/impact.ts', 'utf8'), /lotsOf\(/, 'impact.ts keeps no copy of the order');
});

test('a signature used out of a top-up between the end of a month and the renewal payment moves to the new month', async () => {
  const p = await person('Gap');
  await subscribe(p, 20);
  await topUp(p, `cs10_top_${p.k}`, 4);
  travel(20 + 1 / 1440);
  await again(p);
  assert.equal(state(p).renewal_pending, true);
  // In the gap: the three free ones of the new account go first (they expire soonest), then two of the top-up.
  await used(p, 5, 'g');
  assert.deepEqual(lots(p, 'topup').map((l) => [l.used, l.left]), [[2, 2]]);
  // One more is sent and not signed yet: held in the top-up.
  const waiting = await send(p, `wait-${p.k}@signers.example`);
  assert.deepEqual(lots(p, 'topup').map((l) => [l.used, l.held, l.left]), [[2, 1, 1]]);
  balanced(p);
  // The renewal payment arrives: the new month pays for the two that were signed and holds the one that waits.
  await event('invoice.paid', invoice(p, `in10_${p.k}_2`, 30, { billing_reason: 'subscription_cycle' }));
  assert.equal(state(p).renewal_pending, false);
  assert.deepEqual(lots(p, 'topup').map((l) => [l.used, l.held, l.left]), [[0, 0, 4]], 'the top-up has all four again, with its own date');
  const month = lots(p, 'plan').at(-1)!;
  assert.deepEqual([month.used, month.held, month.left], [2, 1, 6]);
  balanced(p);
  // Asking again moves nothing twice.
  credits.lotsOf(p.id);
  assert.deepEqual(lots(p, 'topup').map((l) => l.left), [4]);
  assert.equal((await signAll(waiting.id, `wait-${p.k}@signers.example`)).status, 200);
  assert.deepEqual([lots(p, 'plan').at(-1)!.used, lots(p, 'topup')[0].left], [3, 4]);
  // A signature used after the payment arrived is the new month's anyway, and one from before the month ended stays.
  balanced(p);
});

test('the new month takes over only what it has room for, and a plan started again weeks later takes over nothing', async () => {
  const p = await person('Room');
  await subscribe(p, 20);
  await used(p, 3, 'w'); // the plan's own, before the month ends (they expire before the free three)
  await topUp(p, `cs10_top_${p.k}`, 12);
  travel(20 + 1 / 1440);
  await again(p);
  await used(p, 13, 'r'); // the three free ones, then ten of the top-up
  assert.deepEqual(lots(p, 'topup').map((l) => [l.used, l.left]), [[10, 2]]);
  await event('invoice.paid', invoice(p, `in10_${p.k}_2`, 30, { billing_reason: 'subscription_cycle' }));
  assert.deepEqual(lots(p, 'topup').map((l) => [l.used, l.left]), [[1, 11]], 'nine moved, the tenth stays with the top-up');
  assert.deepEqual([lots(p, 'plan').at(-1)!.used, lots(p, 'plan').at(-1)!.left], [9, 0]);
  balanced(p);

  const q = await person('Late');
  await subscribe(q, 20);
  await topUp(q, `cs10_top_${q.k}`, 5);
  travel(20 + 1 / 1440);
  await again(q);
  await used(q, 4, 'l'); // three free, one of the top-up
  travel(3);
  await again(q);
  await used(q, 1, 'm');
  await event('invoice.paid', invoice(q, `in10_${q.k}_2`, 30, { billing_reason: 'subscription_cycle' }));
  assert.deepEqual(lots(q, 'topup').map((l) => [l.used, l.left]), [[2, 3]], `more than ${credits.RENEWAL_GAP_HOURS} hours after the month ended: a new start, nothing moves`);
  assert.equal(lots(q, 'plan').at(-1)!.used, 0);
  balanced(q);
});

test('two swaps to another person at the same moment with one signature free: one goes through, the other is refused', async () => {
  const p = await person('Race');
  const a = await send(p, `ra-${p.k}@signers.example`);
  const b = await send(p, `rb-${p.k}@signers.example`);
  // One free signature is left. The clock passes the date of the three free ones, so each swap needs one of today's.
  await topUp(p, `cs10_top_${p.k}`, 1);
  travel(31);
  await again(p);
  assert.equal(state(p).signatures!.available, 1);
  const [x, y] = await Promise.all([
    p.c.post(`/envelopes/${a.id}/correct`, { recipient_id: a.rid, name: 'Other Person A', email: `oa-${p.k}@signers.example` }),
    p.c.post(`/envelopes/${b.id}/correct`, { recipient_id: b.rid, name: 'Other Person B', email: `ob-${p.k}@signers.example` }),
  ]);
  assert.deepEqual([x.status, y.status].sort(), [200, 402], `${x.status} ${JSON.stringify(x.data).slice(0, 200)} / ${y.status} ${JSON.stringify(y.data).slice(0, 200)}`);
  assert.ok(state(p).signatures!.available >= 0, 'nobody is left signing unpaid');
  assert.equal(state(p).short, 0);
  balanced(p);
});
