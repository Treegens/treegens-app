// Billing, ninth round: signatures expire (the owner's decision of 2026-11-20, research/briefs.json "expiry"). A
// month's signatures belong to the billing period they come with, top-ups expire 12 months after their payment, the
// trial's 30 days after the account was made; the one that expires soonest is used first; a held one does not
// expire while it is held and is gone if it is let go after its date; the timer writes an "expired" line to the plan
// history; the ledger accounts for every signature; refunds and disputes follow the lots; the screens, emails and
// API say the dates; the trees follow the money. Every test runs against a fake clock that is moved forward.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { boot, Client, signUp, mailTo, simple, signAll, type Server } from './helpers.ts';
import { stripe, unix } from './stripe-fake.ts';
import { PRICING } from '../src/lib/impact.ts';
import { expiryRuleText, expiryMoment, HELD_EXPIRY_TEXT, refundRuleText } from '../src/lib/policy.ts';

// ---- The fake clock ----------------------------------------------------------------------------------------------
// Every `new Date()` and `Date.now()` in the server reads it (the server only ever asks Date for the time). It keeps
// running, shifted by however far the test has travelled, so two things done one after another still have an order.
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
const DAY = 864e5;

let db: Server['db'];
let billing: Server['billing'];
let cron: Server['cron'];
let credits: typeof import('../src/server/credits.ts');

let evn = 0;
const event = (type: string, object: any) => billing.applyStripeEvent({ id: `evt9_${++evn}`, type, created: Math.floor(Date.now() / 1000), data: { object } });
const acct = (id: string) => db.get('SELECT * FROM accounts WHERE id=?', id);
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const mails = (email: string, re: RegExp) => mailTo(email).filter((m: any) => re.test(String(m.subject)));
const lastMail = (email: string, re: RegExp) => {
  const m = mails(email, re).at(-1);
  return m ? text(m.html) : null;
};
const PW = 'correct horse battery';

type Person = { c: Client; id: string; name: string; email: string; cus: string; sub: string; k: number; ip: string };
let n = 0;
async function person(first: string): Promise<Person> {
  const k = ++n;
  const email = `${first.toLowerCase()}${k}@nine.example`;
  const ip = `198.51.120.${k}`;
  const c = await signUp(`${first} Tester`, email, ip);
  return { c, id: (await c.get('/me')).data.account.id, name: `${first} Tester`, email, cus: `cus9_${k}`, sub: `sub9_${k}`, k, ip };
}
// Signs in again after the clock has moved past the life of a session.
async function again(p: Person) {
  p.c = new Client();
  p.c.ip = p.ip;
  const r = await p.c.post('/auth/login', { email: p.email, password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
// A monthly payment for the period [start, start + days), at the provider and as its message.
function invoice(p: Person, inv: string, days: number, over: any = {}) {
  const o = {
    id: inv, customer: p.cus, subscription: p.sub, amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', hosted_invoice_url: `https://pay.example/${inv}`,
    lines: { data: [{ period: { start: unix(0), end: unix(days) }, metadata: { sg_account: p.id }, price: { id: 'price_grove' } }] }, ...over,
  };
  stripe.invoices[inv] = o;
  stripe.charges.unshift({ id: `ch_${inv}`, paid: true, refunded: false, amount: o.amount_paid, currency: 'usd', customer: p.cus, invoice: inv, last4: '4242', created: unix(0) });
  return o;
}
async function subscribe(p: Person, days: number, inv = `in9_${p.k}_1`) {
  Object.assign(stripe.sub(p.sub), { customer: p.cus, status: 'active', metadata: { sg_account: p.id }, current_period_end: unix(days) });
  await event('checkout.session.completed', { id: `cs9_${p.k}`, mode: 'subscription', client_reference_id: p.id, customer: p.cus, subscription: p.sub, payment_status: 'paid' });
  await event('invoice.paid', invoice(p, inv, days));
}
async function topUp(p: Person, id: string, k: number) {
  stripe.charges.unshift({ id: `ch_${id}`, payment_intent: `pi_${id}`, paid: true, refunded: false, amount: k * 100, currency: 'usd', customer: p.cus, last4: '4242', created: unix(0) });
  await event('checkout.session.completed', { id, mode: 'payment', client_reference_id: p.id, customer: p.cus, payment_status: 'paid', amount_total: k * 100, currency: 'usd', payment_intent: `pi_${id}`, metadata: { kind: 'sg_topup', credits: String(k), sg_account: p.id } });
}
// What the Plan page is given, read on the server (no session needed, whatever the clock says).
const state = (p: Person) => billing.billingState(acct(p.id));
const sig = (p: Person) => state(p).signatures!;
// Sends one envelope to one signer and returns its id and the recipient's id.
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
const lot = (p: Person, source: string, i = 0) => credits.lotsOf(p.id).filter((l) => l.source === source)[i];
// The payment part of the timer: the same three calls cron.ts makes (its first tests below run the whole timer).
// After a long journey only these are run, because some other jobs of the timer compare the fake clock with the
// database's own clock (the security record's guard), which a fake clock cannot move.
const moneyTimer = async () => ({ renewals: await billing.renewalReminders(), expired: billing.expireSignatures(), warned: await billing.topUpExpiryNotices() });
const history = (p: Person, what: string) => db.all('SELECT detail, at, ref FROM billing_log WHERE account_id=? AND what=? ORDER BY id', p.id, what);

// Every signature is accounted for, whatever has happened: what came in equals what was used, is held, was refunded,
// expired or was adjusted, plus what is left; the ledger's own sum is the balance; and what can be sent with is the
// balance less what is held, which is also what is left less what is owed.
function balanced(p: Person) {
  const s = credits.ledgerSums(p.id);
  const sumDelta = db.get('SELECT COALESCE(SUM(delta),0) n FROM credits WHERE account_id=?', p.id).n;
  const sum = credits.creditSummary(p.id);
  assert.equal(s.bought + s.given, s.used + s.held + s.refunded + s.expired + s.adjusted + s.left, `every signature accounted for: ${JSON.stringify(s)}`);
  assert.equal(sumDelta, sum.balance, 'the ledger lines add up to the balance');
  assert.equal(sum.available, s.available, 'what can be sent with, two ways');
  assert.equal(sum.held, credits.reserved(p.id));
  for (const l of credits.lotsOf(p.id)) assert.equal(l.qty, l.used + l.held + l.refunded + l.expired + l.adjusted + l.left, `lot ${l.source} ${JSON.stringify(l)}`);
  return s;
}

before(async () => {
  ({ db, billing, cron } = await boot());
  credits = await import('../src/server/credits.ts');
  process.env.SUPPORT_EMAIL = 'ops9@nine.example';
});

// ---- 1. A month's signatures belong to the billing period they come with ---------------------------------------

test('a month of the plan: its unused signatures expire when the period ends, with a history line, and the renewal brings a fresh 9', async () => {
  const p = await person('Month');
  await subscribe(p, 20); // the month ends in 20 days, before the trial's 30
  assert.deepEqual(sig(p), { balance: 12, held: 0, available: 12 });
  let st = state(p);
  assert.deepEqual({ left: st.period!.left, of: st.period!.of, fresh: st.period!.fresh }, { left: 9, of: 9, fresh: 'renewal' });
  assert.equal(st.period!.resets_at, new Date(unix(20) * 1000).toISOString());
  await used(p, 2, 'm');
  assert.equal(state(p).period!.left, 7, 'the soonest to expire (this month) is used first');
  balanced(p);

  // A minute after the period ends: the 7 that were not used have expired, and the plan history says so.
  travel(20 + 1 / 1440);
  assert.deepEqual(sig(p), { balance: 3, held: 0, available: 3 }, 'only the trial is left');
  const h = history(p, 'expired');
  assert.equal(h.length, 1);
  assert.match(h[0].detail, /^7 of the 9 signatures of the monthly plan for the month that ended on .* expired unused\.$/);
  assert.equal(h[0].ref, `in9_${p.k}_1`);
  assert.deepEqual(state(p).ledger.find((l: any) => l.reason === 'expired'), { delta: -7, reason: 'expired', at: lot(p, 'plan').expires_at, label: 'Expired unused' });
  assert.equal(state(p).history.find((x: any) => x.what === 'expired').label, 'Signatures expired');
  balanced(p);

  // The renewal: a fresh 9 for the new period, not 16.
  await event('invoice.paid', invoice(p, `in9_${p.k}_2`, 30, { billing_reason: 'subscription_cycle' }));
  st = state(p);
  assert.deepEqual({ left: st.period!.left, of: st.period!.of }, { left: 9, of: 9 });
  assert.equal(st.signatures!.balance, 12);
  // The timer writes nothing more: what expired, expired once.
  assert.equal((await cron.tick()).signatures_expired, 0);
  assert.equal(history(p, 'expired').length, 1);
  balanced(p);
});

test('after cancelling, the paid month runs to its end and its signatures expire then; no new month follows', async () => {
  const p = await person('Cancel');
  await subscribe(p, 20);
  const r = await p.c.post('/billing/cancel');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(state(p).period!.fresh, 'none', 'the page says no new month follows');
  const conf = lastMail(p.email, /plan is cancelled/)!;
  assert.match(conf, new RegExp(`The 9 signatures left from this month of the plan can be used until ${expiryMoment(lot(p, 'plan').expires_at)}, when they expire like every month's, and no new month comes after that`));
  travel(21);
  // The timer expires them on time: no page has to be opened for it (read straight from the ledger, which does not
  // bring anything up to date by itself).
  assert.ok((await cron.tick()).signatures_expired >= 9);
  assert.equal(db.get("SELECT COALESCE(-SUM(delta),0) n FROM credits WHERE account_id=? AND reason='expired'", p.id).n, 9);
  assert.equal(credits.lotsOf(p.id).find((l) => l.source === 'plan')!.expired, 9);
  assert.equal(sig(p).available, 3);
  balanced(p);
});

test('a month free with GROWalition belongs to that calendar month (UTC); the next month brings a fresh 9', async () => {
  const p = await person('Coded');
  assert.equal((await p.c.post('/billing/redeem', { code: 'GROWalition' })).status, 200);
  const st = state(p);
  const d = new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  assert.deepEqual({ source: st.period!.source, left: st.period!.left, resets_at: st.period!.resets_at, fresh: st.period!.fresh }, { source: 'code', left: 9, resets_at: next, fresh: 'code' });
  assert.match(lastMail(p.email, /^Code GROWalition accepted/)!, /They belong to that month: the ones you have not used when it ends expire, and the next month brings a fresh 9/);
  await used(p, 4, 'c');
  // Four were used, soonest-expiring first: from this month, or from the trial when it ends sooner.
  const fromMonth = lot(p, 'code').used;
  assert.equal(fromMonth + lot(p, 'welcome').used, 4);
  assert.equal(fromMonth, lot(p, 'code').expires_at! <= lot(p, 'welcome').expires_at! ? 4 : 1);
  // Into the next month: what was left of the old one is gone, and the new month has its 9.
  travel((Date.parse(next) - Date.now()) / DAY + 1 / 24);
  assert.equal(state(p).period!.left, 9);
  const codeLots = credits.lotsOf(p.id).filter((l) => l.source === 'code');
  assert.equal(codeLots.length, 2);
  assert.deepEqual([codeLots[0].used, codeLots[0].expired, codeLots[0].left], [fromMonth, 9 - fromMonth, 0]);
  assert.ok(history(p, 'expired').some((h: any) => new RegExp(`^${9 - fromMonth} of the 9 signatures of .* that came free with your code, at the end of that month`).test(h.detail)));
  balanced(p);
});

// ---- 2 and 3. Top-ups after 12 months, the trial after 30 days --------------------------------------------------

test('the 3 signatures of a new account expire 30 days after it was made', async () => {
  const p = await person('Trial');
  const made = acct(p.id).created_at;
  assert.equal(lot(p, 'welcome').expires_at, new Date(Date.parse(made) + 30 * DAY).toISOString());
  assert.equal(lot(p, 'welcome').paid, false);
  travel(29.9);
  assert.equal(sig(p).available, 3);
  travel(0.2);
  assert.equal(sig(p).available, 0);
  assert.match(history(p, 'expired')[0].detail, /^3 of the 3 signatures every new account gets, 30 days after the account was made .* expired unused\.$/);
  balanced(p);
});

test('top-up signatures expire 12 months after the payment that bought them, and the receipt says when', async () => {
  const p = await person('Topper');
  await subscribe(p, 30);
  await topUp(p, `cs9_top_${p.k}`, 5);
  const t = lot(p, 'topup');
  const paidAt = db.get('SELECT at FROM payments WHERE id=?', `cs9_top_${p.k}`).at;
  assert.equal(t.expires_at, credits.addMonths(paidAt, 12));
  assert.equal(t.paid, true);
  assert.match(lastMail(p.email, /^Receipt: \$5\.00/)!, new RegExp(`These 5 signatures can be used until ${expiryMoment(t.expires_at)}, 12 months from today`));
  assert.equal(state(p).topups[0].expires_at, t.expires_at, 'the Plan page lists the top-up with its own date');
  assert.equal(state(p).payments.find((x: any) => x.id === `cs9_top_${p.k}`).expires_at, t.expires_at);
  travel(Date.parse(t.expires_at!) / DAY - Date.now() / DAY - 1 / 24);
  assert.equal(credits.lotsOf(p.id).find((l) => l.source === 'topup')!.left, 5, 'an hour before, all five are there');
  travel(2 / 24);
  assert.equal(credits.lotsOf(p.id).find((l) => l.source === 'topup')!.left, 0);
  assert.match(history(p, 'expired').at(-1).detail, /^5 of the 5 signatures of the top-up bought on .*, 12 months after that payment/);
  balanced(p);
});

// ---- 4. The one that expires soonest is used first -----------------------------------------------------------

test('use order: the soonest to expire first, a held one sits in the soonest lot, and moves there when a sooner one arrives', async () => {
  const p = await person('Order');
  await subscribe(p, 20);
  await topUp(p, `cs9_ord_${p.k}`, 5);
  // The month (20 days), then the trial (30 days), then the top-up (12 months).
  await used(p, 10, 'o');
  assert.deepEqual([lot(p, 'plan').left, lot(p, 'welcome').left, lot(p, 'topup').left], [0, 2, 5]);
  // Two more are sent: held in the trial's lot, the soonest with room.
  const a = await send(p, `oa-${p.k}@signers.example`);
  const b = await send(p, `ob-${p.k}@signers.example`);
  assert.deepEqual([lot(p, 'welcome').held, lot(p, 'welcome').left, lot(p, 'topup').held], [2, 0, 0]);
  // One more: the top-up is all there is.
  const c = await send(p, `oc-${p.k}@signers.example`);
  assert.equal(lot(p, 'topup').held, 1);
  // The renewal brings a month that ends sooner than the top-up, and sooner than the trial (25 days against 30): all
  // three held ones move into it, so the top-up and the trial keep theirs.
  await event('invoice.paid', invoice(p, `in9_${p.k}_2`, 25, { billing_reason: 'subscription_cycle' }));
  assert.deepEqual([lot(p, 'topup').held, lot(p, 'topup').left], [0, 5]);
  assert.deepEqual([lot(p, 'welcome').held, lot(p, 'welcome').left], [0, 2]);
  assert.deepEqual([lot(p, 'plan', 1).held, lot(p, 'plan', 1).left], [3, 6]);
  for (const e of [a, b, c]) assert.ok(e.rid);
  balanced(p);
});

// ---- 5. A held signature does not expire while it is held --------------------------------------------------------

test('a held signature does not expire while held; let go after its date, it is gone instead of coming back', async () => {
  const p = await person('Held');
  const one = await send(p, `h1-${p.k}@signers.example`);
  const two = await send(p, `h2-${p.k}@signers.example`);
  assert.deepEqual(sig(p), { balance: 3, held: 2, available: 1 });
  travel(31);
  // The trial's date has passed: the free one expired, the two held ones did not.
  assert.deepEqual(sig(p), { balance: 2, held: 2, available: 0 });
  assert.deepEqual([lot(p, 'welcome').expired, lot(p, 'welcome').held], [1, 2]);
  balanced(p);
  // One is signed: it is used, from the trial, after its date.
  assert.equal((await signAll(one.id, `h1-${p.k}@signers.example`)).status, 200);
  assert.deepEqual(sig(p), { balance: 1, held: 1, available: 0 });
  assert.equal(lot(p, 'welcome').used, 1);
  // The other is voided: it does not come back, it expires.
  await again(p);
  assert.equal((await p.c.post(`/envelopes/${two.id}/void`, { reason: 'not needed' })).status, 200);
  assert.deepEqual(sig(p), { balance: 0, held: 0, available: 0 });
  assert.equal(lot(p, 'welcome').expired, 2);
  assert.match(history(p, 'expired').at(-1).detail, /^1 signature that was held for an envelope was let go after its date had passed, so it expired instead of coming back/);
  // Where holds are explained, it says so.
  assert.equal(state(p).held_rule, HELD_EXPIRY_TEXT);
  assert.match(HELD_EXPIRY_TEXT, /does not expire while it is held\. If that envelope is then voided, declined or runs out of time after the signature's own date has passed, that signature is gone instead of coming back/);
  for (const f of ['src/app/app/settings/page.tsx', 'src/app/help/page.tsx', 'src/app/page.tsx', 'src/components/sender/UsageMeter.tsx']) {
    assert.match(readFileSync(f, 'utf8'), /HELD_EXPIRY_TEXT|held_rule/, `${f} explains holds and says what happens after the date`);
  }
  balanced(p);
});

test('a signer who finishes after the date uses the held signature, even when the balance is read between Finish and the ledger line', async () => {
  const p = await person('Gap');
  const e = await send(p, `g1-${p.k}@signers.example`);
  travel(31);
  // The moment between the Finish (the recipient is marked completed) and the "signature used" line, with a page
  // reading the balance in between: the hold is kept for it, so it does not expire there.
  db.run("UPDATE recipients SET status='completed', completed_at=? WHERE id=?", new Date().toISOString(), e.rid);
  assert.equal(sig(p).held, 0);
  const r = db.get('SELECT id, email, person_gen FROM recipients WHERE id=?', e.rid);
  credits.grant(p.id, -1, 'signature', credits.sigRef(r));
  assert.deepEqual([lot(p, 'welcome').used, lot(p, 'welcome').expired], [1, 2]);
  assert.deepEqual(sig(p), { balance: 0, held: 0, available: 0 }, 'nothing owed: it was paid for by the held one');
  balanced(p);
});

test('a declined envelope before the date gives its signature back to the same lot', async () => {
  const p = await person('Back');
  const e = await send(p, `d1-${p.k}@signers.example`);
  assert.equal(sig(p).available, 2);
  const tok = db.get('SELECT token FROM recipients WHERE id=?', e.rid).token;
  assert.equal((await new Client().post(`/sign/${tok}/decline`, { reason: 'No' })).status, 200);
  assert.equal(sig(p).available, 3);
  assert.equal(lot(p, 'welcome').left, 3);
  balanced(p);
});

// ---- 6. The ledger stays exact ---------------------------------------------------------------------------------

test('every signature is bought, used, held, refunded, expired or left, and the sums say so at every step', async () => {
  const p = await person('Ledger');
  await subscribe(p, 20);
  await topUp(p, `cs9_led_${p.k}`, 6);
  balanced(p);
  await used(p, 3, 'l');
  const held = await send(p, `lh-${p.k}@signers.example`);
  balanced(p);
  // A self-serve refund of the top-up (unused, not expired).
  const r = await p.c.post('/billing/refund', { payment_id: `cs9_led_${p.k}` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.signatures, 6);
  balanced(p);
  travel(21);
  let s = balanced(p);
  assert.deepEqual({ bought: s.bought, given: s.given, used: s.used, held: s.held, refunded: s.refunded, expired: s.expired }, { bought: 15, given: 3, used: 3, held: 1, refunded: 6, expired: 5 });
  // The held one is signed after its month ended: used, not expired.
  assert.equal((await signAll(held.id, `lh-${p.k}@signers.example`)).status, 200);
  s = balanced(p);
  assert.deepEqual({ used: s.used, held: s.held, expired: s.expired, left: s.left }, { used: 4, held: 0, expired: 5, left: 3 });
  assert.deepEqual(state(p).sums, s, 'the Plan page and the API get the same sums');
});

// ---- 7. Refunds and disputes ------------------------------------------------------------------------------------

test('an expired signature is not refunded, even inside the refund window', async () => {
  const p = await person('Late');
  await subscribe(p, 5);
  await used(p, 1, 'x');
  assert.equal(state(p).refund.signatures, 8);
  assert.match(state(p).refund.reason, /8 of the 9 signatures it bought are still unused and have not expired/);
  travel(6);
  assert.equal(state(p).refund, null, 'six days after the payment, the month has ended and its signatures with it');
  const r = await p.c.post('/billing/refund');
  assert.equal(r.status, 400);
  assert.ok(r.data.error.startsWith(refundRuleText(30)));
  balanced(p);
});

test('a refund at the provider takes that payment\'s own unused signatures first, not the month\'s', async () => {
  const p = await person('OwnFirst');
  await subscribe(p, 20);
  await topUp(p, `cs9_own_${p.k}`, 10);
  await used(p, 3, 'f');
  assert.deepEqual([lot(p, 'plan').left, lot(p, 'topup').left], [6, 10]);
  const ch = stripe.refundByHand(`ch_cs9_own_${p.k}`, 1000);
  await event('charge.refunded', { ...ch, id: `ch_cs9_own_${p.k}` });
  assert.deepEqual([lot(p, 'plan').left, lot(p, 'topup').left, lot(p, 'topup').refunded], [6, 0, 10], 'the top-up\'s ten left with its money; the month is untouched');
  balanced(p);
});

test('a dispute after the month ended: the expired ones are not taken from anything else, and the email says so', async () => {
  const p = await person('Disputed');
  await subscribe(p, 20);
  await topUp(p, `cs9_dsp_${p.k}`, 5);
  await used(p, 3, 'p');
  travel(21);
  assert.equal(lot(p, 'plan').expired, 6);
  await event('charge.dispute.created', { id: `dp9_${p.k}`, charge: `ch_in9_${p.k}_1`, amount: 900 });
  // The month's 9: 6 expired (gone already), 3 used: for the used ones, 3 leave from what is left, soonest-expiring
  // first (the trial, which ends in 9 days), and the top-up is not touched.
  assert.deepEqual([lot(p, 'welcome').left, lot(p, 'welcome').refunded, lot(p, 'topup').left], [0, 3, 5]);
  const mail = lastMail(p.email, /^A payment was disputed/)!;
  assert.match(mail, /6 signatures had expired unused, so there was nothing to take back for them/);
  balanced(p);
});

test('a dispute decided in our favour after the date: the set-aside signatures expire instead of coming back, and the email says so', async () => {
  const p = await person('Won');
  await subscribe(p, 20);
  process.env.ACCEPT_DISPUTES_UP_TO_USD = '0';
  try {
    await event('charge.dispute.created', { id: `dpw9_${p.k}`, charge: `ch_in9_${p.k}_1`, amount: 900 });
  } finally {
    delete process.env.ACCEPT_DISPUTES_UP_TO_USD;
  }
  assert.equal(lot(p, 'plan').refunded, 9, 'set aside until the bank decides');
  travel(21);
  await event('charge.dispute.closed', { id: `dpw9_${p.k}`, charge: `ch_in9_${p.k}_1`, status: 'won' });
  assert.deepEqual([lot(p, 'plan').refunded, lot(p, 'plan').expired, lot(p, 'plan').left], [0, 9, 0]);
  assert.match(lastMail(p.email, /^The disputed payment stands/)!, /9 signatures of those set aside had reached their own date while the bank decided, so they expired instead of coming back/);
  balanced(p);
});

// ---- 7 and 8. The rule, quoted where it is promised; the dates on the Plan page ---------------------------------

test('the expiry rule is written once and quoted on the Plan page, the pricing block, /help, both payment pages, the receipts and every renewal reminder', async () => {
  const rule = expiryRuleText();
  assert.match(rule, /^The 9 signatures that come with each month of Grove belong to that month/);
  // The refund rule keeps its meaning for what was not used and has not expired.
  assert.match(refundRuleText(30), /^Signatures you have not used, and that have not expired, are refunded in full within 30 days/);
  assert.match(rule, /Top-up signatures expire 12 months after the payment that bought them/);
  assert.match(rule, /The 3 free signatures of a new account expire 30 days after it is made/);
  assert.match(rule, /The one that expires soonest is always used first/);
  const p = await person('Quoted');
  assert.equal(state(p).expiry_rule, rule);
  assert.match(readFileSync('src/app/app/settings/page.tsx', 'utf8'), /\{b\.expiry_rule\}/, 'the Plan page shows it');
  assert.match(readFileSync('src/app/page.tsx', 'utf8'), /\{expiryRuleText\(\)\}/, 'the pricing block shows it');
  assert.match(readFileSync('src/app/help/page.tsx', 'utf8'), /\{expiryRuleText\(\)\}/, '/help shows it');
  // Both payment pages of the provider, inside the 1200 characters the provider allows.
  stripe.calls.length = 0;
  assert.equal((await p.c.post('/billing/checkout')).status, 200);
  const plan = stripe.calls.find((c) => c[1] === 'checkout/sessions')![2]['custom_text[submit][message]'];
  assert.ok(plan.includes(rule) && plan.length <= 1200, `${plan.length} characters`);
  await subscribe(p, 20);
  assert.ok(lastMail(p.email, /^Welcome to Grove/)!.includes(rule), 'the welcome email');
  assert.ok(lastMail(p.email, /^Receipt: \$9\.00/)!.includes(rule), 'the receipt');
  stripe.calls.length = 0;
  assert.equal((await p.c.post('/billing/topup', { quantity: 5 })).status, 200);
  const top = stripe.calls.find((c) => c[1] === 'checkout/sessions')![2]['custom_text[submit][message]'];
  assert.ok(top.includes(rule) && top.length <= 1200, `${top.length} characters`);
});

test('the Plan page says how many are left this month and when they reset, and lists each top-up with its own date', async () => {
  const p = await person('Page');
  await subscribe(p, 13);
  await topUp(p, `cs9_pg_${p.k}`, 4);
  await used(p, 3, 'g');
  const st = state(p);
  assert.deepEqual({ left: st.period!.left, of: st.period!.of }, { left: 6, of: 9 });
  // "6 of 9 left, they reset on 3 December 2026 at 14:00 UTC": the moment, in UTC, the same way as in the emails.
  assert.match(expiryMoment(st.period!.resets_at), /^\d{1,2} [A-Z][a-z]+ \d{4} at \d{2}:\d{2} UTC$/);
  assert.equal(expiryMoment('2026-12-03T14:00:00.000Z'), '3 December 2026 at 14:00 UTC');
  const src = readFileSync('src/app/app/settings/page.tsx', 'utf8');
  assert.match(src, /This month of the plan: \{b\.period\.left\} of \{b\.period\.of\} left<\/b>, \{b\.period\.fresh === 'none'/);
  assert.match(src, /they reset on \{expiryMoment\(b\.period\.resets_at\)\}/);
  assert.deepEqual(st.topups.map((l: any) => [l.of, l.left, l.expires_at]), [[4, 4, lot(p, 'topup').expires_at]]);
  assert.ok(st.lots.some((l: any) => l.source === 'welcome' && l.left === 3 && l.expires_at === lot(p, 'welcome').expires_at), 'the trial is listed with its date too');
  // The page that stops a renewal without logging in says the dates too, never "they stay yours".
  const tok = new URL(mailTo(p.email).find((m: any) => /billing\/stop/.test(m.link || ''))!.link).searchParams.get('token');
  const pub = (await new Client().get(`/public/billing/stop?token=${encodeURIComponent(tok!)}`)).data;
  assert.deepEqual([pub.plan_left, pub.plan_until, pub.topups_left, pub.topups_until], [6, lot(p, 'plan').expires_at, 4, lot(p, 'topup').expires_at]);
  balanced(p);
});

test('every renewal reminder says how many of this month\'s signatures will expire at the renewal, and quotes the rule', async () => {
  const p = await person('Remind');
  await subscribe(p, 6);
  await used(p, 2, 'r');
  assert.equal(acct(p.id).renews_at, lot(p, 'plan').expires_at, 'the renewal is the moment the month ends');
  assert.ok((await moneyTimer()).renewals >= 1);
  const m = lastMail(p.email, /^Heads up: your plan renews/)!;
  assert.match(m, new RegExp(`7 of this month's 9 signatures are still unused\\. If they are not used by the renewal, they expire then, on ${expiryMoment(lot(p, 'plan').expires_at)}, and the renewal brings a fresh 9\\.`));
  assert.ok(m.includes(expiryRuleText()));
  // The day before, with everything used or held: none will expire, and it says so.
  await used(p, 5, 'r2');
  await send(p, `rh1-${p.k}@signers.example`);
  await send(p, `rh2-${p.k}@signers.example`);
  travel(5.2);
  await moneyTimer();
  const last = lastMail(p.email, /^Last reminder: your plan renews/)!;
  assert.match(last, /None of this month's 9 signatures will expire at the renewal: they are all used or held for envelopes that are out \(a held one does not expire while it is held\)/);
  assert.ok(last.includes(expiryRuleText()));
});

test('a top-up is emailed 30 days and 3 days before it expires, once each and only while some are unused', async () => {
  const p = await person('Warned');
  await subscribe(p, 30);
  await topUp(p, `cs9_w_${p.k}`, 5);
  const q = await person('AllUsed');
  await subscribe(q, 30);
  await topUp(q, `cs9_wq_${q.k}`, 2);
  const expires = lot(p, 'topup').expires_at!;
  const subject = /from your top-up expire on/;
  travel((Date.parse(expires) - Date.now()) / DAY - 31);
  await moneyTimer();
  assert.equal(mails(p.email, subject).length, 0, 'not before 30 days');
  // Q's top-up is used up by then (the month and trial are long gone, so these come from it).
  credits.grant(q.id, -2, 'adjust', `q-used-${q.k}`);
  assert.equal(lot(q, 'topup').left, 0);
  travel(1.1);
  await moneyTimer();
  await moneyTimer();
  assert.equal(mails(p.email, subject).length, 1, 'once, 30 days before');
  const first = lastMail(p.email, subject)!;
  assert.match(first, new RegExp(`5 of them are still unused, and they expire on ${expiryMoment(expires)}, 12 months after that payment`));
  assert.match(first, /The mangroves this top-up paid for are planted whether its signatures are used or not\. We email you once more 3 days before, if any are still unused then\./);
  assert.equal(mails(q.email, subject).length, 0, 'nothing for a top-up that is used up');
  assert.equal(history(p, 'topup-expiry').length, 1);
  travel(27);
  await moneyTimer();
  await moneyTimer();
  assert.equal(mails(p.email, subject).length, 2, 'and once, 3 days before');
  assert.match(lastMail(p.email, subject)!, /Your top-up signatures expire in a few days|5 of them are still unused/);
  travel(4);
  await moneyTimer();
  assert.equal(mails(p.email, subject).length, 2, 'nothing after they expired');
  assert.equal(mails(q.email, subject).length, 0);
  assert.equal(lot(p, 'topup').expired, 5);
  balanced(p);
  balanced(q);
});

// ---- 9. Trees follow the money -------------------------------------------------------------------------------

test('the trees count the money paid, not the signatures used: a month that expires unused still planted its 90', async () => {
  const p = await person('Trees');
  await subscribe(p, 10);
  travel(11);
  assert.equal(lot(p, 'plan').expired, 9);
  assert.equal(state(p).mangroves, 90);
  const imp = (await new Client().get('/public/impact')).data;
  const paid = db.get("SELECT COALESCE(SUM(amount_cents - refunded_cents),0) c FROM payments WHERE kind IN ('plan','topup')").c / 100;
  assert.equal(imp.treesFunded, Math.floor(paid * PRICING.treesPerUsd));
  assert.match(readFileSync('src/components/ImpactView.tsx', 'utf8'), /It counts the trees funded from that money, not signatures used: a signature that expires unused was paid for, and its trees are planted all the same\./);
  assert.match(expiryRuleText(), /Every dollar still plants 10 mangroves, used or not\./);
});

// ---- 10. Nothing promises that signatures never expire --------------------------------------------------------

test('no page, email or API text promises that signatures never expire or roll over, and README says what happens now', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const full = path.join(dir, f);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx|json)$/.test(f) ? [full] : [];
  });
  const found = walk('src').flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l] as const)).filter(([, , l]) => /never expire|rolls? over|carr(y|ies) over|stay yours|saved up/i.test(l) && !/documents stay yours/i.test(l));
  assert.deepEqual(found.map(([f, i, l]) => `${f}:${i}: ${l.trim().slice(0, 120)}`), []);
  const readme = readFileSync('README.md', 'utf8');
  const row = readme.split('\n').find((l) => l.startsWith('| Prepaid allowance disappears at renewal. |'))!;
  assert.match(row, /expire at the renewal/);
  assert.match(row, /the date and time is shown everywhere/);
  assert.match(row, /the one that expires soonest is always used first/);
  assert.match(row, /top-ups get an email 30 days and 3 days before they expire/);
  assert.doesNotMatch(readme, /never expire and roll over|Signatures never expire/);
});

test('the API description gives the expiry dates on GET /billing', async () => {
  const spec = (await new Client().get('/openapi.json')).data;
  const b = spec.paths['/billing'].get;
  assert.ok(b.description.includes(expiryRuleText()));
  const props = b.responses[200].content['application/json'].schema.properties;
  assert.ok(props.period.properties.resets_at && props.lots.items.properties.expires_at && props.payments.items.properties.expires_at && props.sums);
});

// ---- 11. paidSignatureFor, for the signer's tree note ---------------------------------------------------------

test('paidSignatureFor: true only for a signature held or used from a lot that was paid for and still stands', async () => {
  const free = await person('FreeOnly');
  const t = await send(free, `pt-${free.k}@signers.example`);
  assert.equal(credits.paidSignatureFor(t.rid), false, 'the trial is not paid for');
  const own = await simple(free.c, free.email, { recipients: [{ id: 'r', role: 'signer', name: free.name, email: free.email }] });
  await free.c.post(`/envelopes/${own.id}/send`);
  assert.equal(credits.paidSignatureFor(db.get('SELECT id FROM recipients WHERE envelope_id=?', own.id).id), false, 'signing your own document uses none');
  assert.equal(credits.paidSignatureFor('no-such-recipient'), false);

  const p = await person('Payer');
  await subscribe(p, 20); // ends before the trial: the month is used first
  const h = await send(p, `pp-${p.k}@signers.example`);
  assert.equal(credits.paidSignatureFor(h.rid), true, 'held in the paid month');
  assert.equal((await signAll(h.id, `pp-${p.k}@signers.example`)).status, 200);
  assert.equal(credits.paidSignatureFor(h.rid), true, 'and used from it');
  // A payment that went back in full no longer stands.
  const ch = stripe.refundByHand(`ch_in9_${p.k}_1`, 900);
  await event('charge.refunded', { ...ch, id: `ch_in9_${p.k}_1` });
  assert.equal(credits.paidSignatureFor(h.rid), false);

  const c = await person('CodeSigner');
  await c.c.post('/billing/redeem', { code: 'GROWalition' });
  // The code's month ends sooner than the trial or later, either way neither is paid for.
  const cs = await send(c, `pc-${c.k}@signers.example`);
  assert.equal(credits.paidSignatureFor(cs.rid), false, 'the GROWalition plan is not paid for');
});

// ---- 12. Lines from before lots were kept ------------------------------------------------------------------------

test('ledger lines written before lots existed become lots with the rule\'s dates, and are drawn in order', () => {
  const id = `acc_legacy_${Date.now()}`;
  const at = new Date(Date.now() - 2 * DAY).toISOString();
  db.run("INSERT INTO accounts (id, name, created_at) VALUES (?,?,?)", id, 'Legacy', at);
  db.run("INSERT INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,?,?,?)", id, 3, 'welcome', id, at);
  db.run("INSERT INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,?,?,?)", id, 4, 'topup', 'cs_legacy', at);
  db.run("INSERT INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,?,?,?)", id, -4, 'signature', 'r_legacy|a@b.example', new Date(Date.now() - DAY).toISOString());
  const ls = credits.lotsOf(id);
  const w = ls.find((l) => l.source === 'welcome')!;
  const tp = ls.find((l) => l.source === 'topup')!;
  assert.equal(w.expires_at, new Date(Date.parse(at) + 30 * DAY).toISOString());
  assert.equal(tp.expires_at, credits.addMonths(at, 12));
  assert.deepEqual([w.used, tp.used], [3, 1], 'the trial first, it expires sooner');
  assert.equal(credits.creditSummary(id).available, 3);
});
