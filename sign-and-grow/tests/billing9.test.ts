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
import { boot, Client, signUp, mailTo, simple, signAll, upload, tokenFor, type Server } from './helpers.ts';
import { stripe, unix } from './stripe-fake.ts';
import { PRICING } from '../src/lib/impact.ts';
import { expiryRuleText, expiryShortText, expiredWords, expiryMoment, HELD_EXPIRY_TEXT, refundRuleText } from '../src/lib/policy.ts';

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
  // One reading of the clock for both: the subscription's period ends when the invoice's does.
  const paid = invoice(p, inv, days);
  stripe.sub(p.sub).current_period_end = paid.lines.data[0].period.end;
  await event('checkout.session.completed', { id: `cs9_${p.k}`, mode: 'subscription', client_reference_id: p.id, customer: p.cus, subscription: p.sub, payment_status: 'paid' });
  await event('invoice.paid', paid);
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
  // The end of the period the payment itself names (read back from the provider: asking the clock again here could
  // land in the next second).
  assert.equal(st.period!.resets_at, new Date(stripe.invoices[`in9_${p.k}_1`].lines.data[0].period.end * 1000).toISOString());
  assert.equal(st.period!.resets_at, lot(p, 'plan').expires_at);
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
  // Someone who comes back after the 30 days and tries to send is told why they have none, when it happened and what
  // to do next, and nothing is sent.
  await again(p);
  const e = await simple(p.c, 'late', { recipients: [{ id: 'r', role: 'signer', name: 'Late Signer', email: `late-${p.k}@signers.example` }] });
  const r = await p.c.post(`/envelopes/${e.id}/send`);
  assert.equal(r.status, 402);
  assert.equal(r.data.error, `This needs 1 signature and you have 0 left. 3 signatures you had not used expired on ${expiryMoment(lot(p, 'welcome').expires_at)}; the Plan page shows every date. The monthly plan is $9 for 9 signatures, and every dollar plants 10 mangrove trees. Nothing is charged unless you choose it. Signing your own documents stays free.`);
  // Once something new has arrived, the sentence about the old expiry is gone.
  await subscribe(p, 30);
  assert.equal(credits.lastExpiry(p.id), null);
});

test('putting another person in after the date needs a signature of today\'s: with none, it is refused in plain words and the person on it can still sign', async () => {
  const p = await person('Swap');
  const one = await send(p, `s1-${p.k}@signers.example`);
  const two = await send(p, `s2-${p.k}@signers.example`);
  await send(p, `s3-${p.k}@signers.example`);
  travel(31);
  await again(p);
  assert.deepEqual(sig(p), { balance: 3, held: 3, available: 0 });
  // The three held ones are past their date. They are good for the people they were sent to, and for nobody else.
  const sw = await p.c.post(`/envelopes/${one.id}/correct`, { recipient_id: one.rid, name: 'Somebody Else', email: `else-${p.k}@signers.example` });
  assert.equal(sw.status, 402, JSON.stringify(sw.data));
  assert.equal(sw.data.error, credits.pastDateText(lot(p, 'welcome').expires_at!));
  assert.match(sw.data.error, /^The signature held for this envelope passed its own date on \d+ \w+ \d{4} at \d\d:\d\d UTC\. It stays good for the person and the documents it was sent with/);
  assert.match(sw.data.error, /Nothing was changed\. Add signatures on the Plan page and try again, or leave the envelope as it is: the person on it can still sign\.$/);
  // Another name at the same address is another person too.
  assert.equal((await p.c.post(`/envelopes/${one.id}/correct`, { recipient_id: one.rid, name: 'Quite Another Person' })).status, 402);
  // The full editor: the same answer, and nothing saved.
  const full = (await p.c.get(`/envelopes/${one.id}`)).data.envelope;
  full.recipients[0].email = `else-${p.k}@signers.example`;
  full.recipients[0].name = 'Somebody Else';
  const put = await p.c.put(`/envelopes/${one.id}`, full);
  assert.equal(put.status, 402, JSON.stringify(put.data));
  assert.match(put.data.error, /^The signature held for this envelope passed its own date/);
  // The signer passing it on: refused in words that say nothing of the sender's business, and they can still sign.
  const pass = await new Client().post(`/sign/${tokenFor(two.id, `s2-${p.k}@signers.example`)}/reassign`, { name: 'A Colleague', email: `col-${p.k}@signers.example` });
  assert.equal(pass.status, 403, JSON.stringify(pass.data));
  assert.match(pass.data.error, /^This document cannot be passed on to someone else right now\. You can still sign it yourself\./);
  assert.doesNotMatch(pass.data.error, /signature held|Plan page|expired/);
  // Nothing moved: still three held in the trial, none expired, nobody new on any of them.
  assert.deepEqual(sig(p), { balance: 3, held: 3, available: 0 });
  assert.deepEqual([lot(p, 'welcome').held, lot(p, 'welcome').left, lot(p, 'welcome').expired], [3, 0, 0]);
  assert.equal(db.get('SELECT email FROM recipients WHERE id=?', one.rid).email, `s1-${p.k}@signers.example`);
  // A spelling fix of the same person is not another person, and is never refused.
  assert.equal((await p.c.post(`/envelopes/${one.id}/correct`, { recipient_id: one.rid, name: `Signer  s1-${p.k}@signers.example` })).status, 200);
  // The people it was sent to sign with the held ones, after the date, as before.
  assert.equal((await signAll(one.id, `s1-${p.k}@signers.example`)).status, 200);
  assert.equal((await signAll(two.id, `s2-${p.k}@signers.example`)).status, 200);
  assert.deepEqual([lot(p, 'welcome').used, lot(p, 'welcome').held], [2, 1]);
  balanced(p);
});

test('parking: a month\'s signatures cannot be kept past its end by sending to a placeholder and putting the real person in later', async () => {
  const p = await person('Park');
  await subscribe(p, 20);
  // Nine envelopes to placeholders (the nine of the month, the soonest to expire), and more time for one of them.
  const parked: { id: string; rid: string }[] = [];
  for (let i = 0; i < 9; i++) parked.push(await send(p, `park${i}-${p.k}@signers.example`));
  assert.equal((await p.c.post(`/envelopes/${parked[0].id}/extend`, { days: 365 })).status, 200);
  assert.deepEqual([lot(p, 'plan').held, lot(p, 'plan').left], [9, 0]);
  travel(20 + 1 / 1440);
  await again(p);
  // The month is over. Held ones do not expire while held (the brief's rule 5), and the trial's 3 are still good.
  assert.deepEqual(sig(p), { balance: 12, held: 9, available: 3 });
  const monthEnd = lot(p, 'plan').expires_at!;
  // The real person is put in on the first one: the old month's signature is let go and expires, and the new
  // person is held with one that can pay today (the trial's).
  const sw = await p.c.post(`/envelopes/${parked[0].id}/correct`, { recipient_id: parked[0].rid, name: 'Real Person', email: `real0-${p.k}@signers.example` });
  assert.equal(sw.status, 200, JSON.stringify(sw.data));
  assert.deepEqual(sig(p), { balance: 11, held: 9, available: 2 }, 'the old month paid for nothing new: one of today\'s is held instead');
  assert.deepEqual([lot(p, 'plan').held, lot(p, 'plan').expired, lot(p, 'welcome').held], [8, 1, 1]);
  const h = history(p, 'expired').at(-1);
  assert.match(h.detail, /^1 signature that was held for an envelope was let go after its date had passed, so it expired instead of coming back \(of the 9 signatures of the monthly plan/);
  assert.ok(h.at > monthEnd, 'the line is dated when it was let go, not at the end of the month');
  assert.equal(credits.paidSignatureFor(parked[0].rid), false, 'the new person is held in the trial, not in the paid month');
  assert.equal((await signAll(parked[0].id, `real0-${p.k}@signers.example`)).status, 200);
  assert.deepEqual([lot(p, 'welcome').used, lot(p, 'plan').used], [1, 0], 'signed with one of today\'s');
  // Other documents on the second one, same person: the same thing, through the editor.
  const full = (await p.c.get(`/envelopes/${parked[1].id}`)).data.envelope;
  full.documents[0].file_id = (await upload(p.c, 3)).id;
  const put = await p.c.put(`/envelopes/${parked[1].id}`, full);
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual([lot(p, 'plan').held, lot(p, 'plan').expired, lot(p, 'welcome').held], [7, 2, 1]);
  // A change that is not the documents or the person (the subject) leaves a held one where it is.
  const sub = (await p.c.get(`/envelopes/${parked[2].id}`)).data.envelope;
  sub.subject = 'A better subject';
  assert.equal((await p.c.put(`/envelopes/${parked[2].id}`, sub)).status, 200);
  assert.deepEqual([lot(p, 'plan').held, lot(p, 'plan').expired], [7, 2]);
  // The trial's last one goes the same way, and then there is nothing of today's left: the next change is refused,
  // through every door, and nothing is saved.
  assert.equal((await p.c.post(`/envelopes/${parked[3].id}/correct`, { recipient_id: parked[3].rid, name: 'Real Three', email: `real3-${p.k}@signers.example` })).status, 200);
  assert.equal(sig(p).available, 0);
  const no = await p.c.post(`/envelopes/${parked[4].id}/correct`, { recipient_id: parked[4].rid, name: 'Real Four', email: `real4-${p.k}@signers.example` });
  assert.equal(no.status, 402);
  assert.equal(no.data.error, credits.pastDateText(monthEnd));
  const docs = (await p.c.get(`/envelopes/${parked[5].id}`)).data.envelope;
  const before = docs.documents[0].file_id;
  docs.documents[0].file_id = (await upload(p.c, 4)).id;
  const noDocs = await p.c.put(`/envelopes/${parked[5].id}`, docs);
  assert.equal(noDocs.status, 402, JSON.stringify(noDocs.data));
  assert.equal(noDocs.data.error, credits.pastDateText(monthEnd));
  assert.equal((await p.c.get(`/envelopes/${parked[5].id}`)).data.envelope.documents[0].file_id, before, 'nothing was saved');
  assert.equal((await new Client().post(`/sign/${tokenFor(parked[6].id, `park6-${p.k}@signers.example`)}/reassign`, { name: 'Real Six', email: `real6-${p.k}@signers.example` })).status, 403);
  assert.deepEqual([lot(p, 'plan').held, lot(p, 'plan').expired], [6, 3], 'the refused ones are still held as they were');
  assert.ok(sig(p).available >= 0, 'nobody signs with a signature that was not paid for');
  // The new month arrives: its nine are today's, and the change goes through with one of them.
  await event('invoice.paid', invoice(p, `in9_${p.k}_2`, 30, { billing_reason: 'subscription_cycle' }));
  assert.equal((await p.c.post(`/envelopes/${parked[4].id}/correct`, { recipient_id: parked[4].rid, name: 'Real Four', email: `real4-${p.k}@signers.example` })).status, 200);
  assert.deepEqual([lot(p, 'plan', 0).held, lot(p, 'plan', 0).expired, lot(p, 'plan', 1).held], [5, 4, 1], 'the new person is held in the new month');
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
  for (const f of ['src/app/app/settings/page.tsx', 'src/app/help/page.tsx']) {
    assert.match(readFileSync(f, 'utf8'), /HELD_EXPIRY_TEXT|held_rule/, `${f} explains holds and says what happens after the date`);
  }
  // The price list and the editor say it in a few words of their own, and never that a held one always comes back.
  assert.match(readFileSync('src/app/page.tsx', 'utf8'), /come back, unless their own date has passed by then\./);
  for (const f of ['src/app/page.tsx', 'src/components/editor/StepReview.tsx', 'src/components/sender/UsageMeter.tsx']) assert.doesNotMatch(readFileSync(f, 'utf8'), /comes straight back|come back by themselves\. *<|It comes back if you void/, f);
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
  assert.match(rule, /^The 9 signatures of each month of the monthly plan last until that month ends: at the renewal, or at the end of the paid month if you cancel\. Unused ones expire then, and the next month brings a fresh 9\./);
  assert.doesNotMatch(rule, /Grove|[()]/, 'the plan is called what the Plan page calls it, and the rule has no asides');
  assert.ok(rule.split(/\s+/).length <= 110, `${rule.split(/\s+/).length} words`);
  // The refund rule keeps its meaning for what was not used and has not expired.
  assert.match(refundRuleText(30), /^Signatures you have not used, and that have not expired, are refunded in full within 30 days/);
  assert.match(rule, /Top-up signatures last 12 months from their payment, and we email you 30 and 3 days before if any are unused/);
  assert.match(rule, /The 3 free signatures of a new account last 30 days/);
  assert.match(rule, /The one that ends soonest is always used first/);
  const p = await person('Quoted');
  assert.equal(state(p).expiry_rule, rule);
  assert.match(readFileSync('src/app/app/settings/page.tsx', 'utf8'), /\{b\.expiry_rule\}/, 'the Plan page shows it');
  // The price list says it in one line and links to the whole rule on /help (the first-send flow has a word ceiling).
  assert.match(readFileSync('src/app/page.tsx', 'utf8'), /<li id="expiry"><b>When signatures expire\.<\/b> \{expiryShortText\(\)\} <Link href="\/help#expiry">How signatures expire<\/Link>\.<\/li>/);
  assert.equal(expiryShortText(), "A month's 9 signatures last for that month, top-ups last 12 months, and every date is on your Plan page.");
  assert.match(readFileSync('src/app/help/page.tsx', 'utf8'), /<p id="expiry">/);
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
  assert.match(src, /<b>This month: \{b\.period\.left\} of \{b\.period\.of\} left\.<\/b> \{b\.period\.fresh === 'none'/);
  assert.match(src, /They reset on \{expiryMoment\(b\.period\.resets_at\)\}\./);
  // The long rules are closed until someone asks (research/ux-notes.json "expiry"): the dates are what stays in sight.
  assert.match(src, /<details className="card" data-fold="">\s*<summary[^>]*>How signatures work<\/summary>\s*<ul className="rules"[^>]*>[\s\S]*\{b\.expiry_rule\}[\s\S]*\{b\.held_rule\}[\s\S]*<\/details>/);
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
  assert.match(m, new RegExp(`7 of this month's 9 signatures are still unused\\. If they are not used by the renewal, they expire then, and the renewal brings a fresh 9\\.`));
  // One way of writing the renewal in the email: the reader's day, as in its first line (no second, UTC, moment).
  assert.doesNotMatch(m, /\d\d:\d\d UTC/);
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

// ---- After the skeptic and the simplicity review (tests/out/verify-expiry, tests/out/ux-expiry) ---------------

test('the plan history tells "held and let go after its date" from "expired unused", and dates each when it happened', async () => {
  // All three held when the date passes, one voided two days later: not "expired unused", and not dated at the date.
  const p = await person('Late');
  const one = await send(p, `l1-${p.k}@signers.example`);
  await send(p, `l2-${p.k}@signers.example`);
  await send(p, `l3-${p.k}@signers.example`);
  travel(31);
  assert.deepEqual(sig(p), { balance: 3, held: 3, available: 0 });
  assert.equal(history(p, 'expired').length, 0, 'nothing expired: all three are held');
  travel(2);
  await again(p);
  assert.equal((await p.c.post(`/envelopes/${one.id}/void`, { reason: 'not needed' })).status, 200);
  assert.deepEqual(sig(p), { balance: 2, held: 2, available: 0 });
  const h = history(p, 'expired');
  assert.equal(h.length, 1);
  assert.match(h[0].detail, /^1 signature that was held for an envelope was let go after its date had passed, so it expired instead of coming back \(of the 3 signatures every new account gets/);
  const until = lot(p, 'welcome').expires_at!;
  assert.ok(Date.parse(h[0].at) - Date.parse(until) > 1.5 * DAY, `dated when it was let go (${h[0].at}), not at the lot's date (${until})`);
  assert.equal(db.get("SELECT at FROM credits WHERE account_id=? AND reason='expired'", p.id).at, h[0].at, 'the ledger line carries the same moment');
  balanced(p);

  // Voided before the date, and nobody looked until after it: that one was not held when the date passed.
  const q = await person('Early');
  const e = await send(q, `e1-${q.k}@signers.example`);
  await send(q, `e2-${q.k}@signers.example`);
  travel(5);
  await again(q);
  assert.equal((await q.c.post(`/envelopes/${e.id}/void`, { reason: 'not needed' })).status, 200);
  travel(27);
  assert.deepEqual(sig(q), { balance: 1, held: 1, available: 0 });
  const g = history(q, 'expired');
  assert.equal(g.length, 1);
  assert.match(g[0].detail, /^2 of the 3 signatures every new account gets, 30 days after the account was made \(.*\) expired unused\.$/);
  assert.equal(g[0].at, lot(q, 'welcome').expires_at);
  balanced(q);
});

test('between the end of a month and the renewal payment: the page and the refusal say the new nine are on their way', async () => {
  const p = await person('Between');
  await subscribe(p, 20);
  await used(p, 2, 'b');
  assert.equal(state(p).renewal_pending, false);
  travel(20 + 1 / 1440);
  await again(p);
  let st = state(p);
  assert.equal(st.period, null, 'the old month is over');
  assert.equal(st.renewal_pending, true);
  assert.deepEqual(st.signatures, { balance: 3, held: 0, available: 3 });
  // A send that needs more than is left is refused with the reason and what to do, not just "top up".
  const e = await simple(p.c, 'four', {
    recipients: [1, 2, 3, 4].map((i) => ({ id: `r${i}`, role: 'signer', name: `Signer ${i}`, email: `bw${i}-${p.k}@signers.example` })),
    fields: [1, 2, 3, 4].map((i) => ({ id: `f${i}`, document_id: 'd', recipient_id: `r${i}`, type: 'signature', page: 0, x: 0.1, y: 0.1 + i * 0.15, w: 0.3, h: 0.06 })),
  });
  const no = await p.c.post(`/envelopes/${e.id}/send`);
  assert.equal(no.status, 402);
  assert.match(no.data.error, /^This needs 4 signatures and you have 3 left\. 7 signatures you had not used expired on .*; the Plan page shows every date\. Your new month's 9 arrive when the renewal payment goes through, usually within the hour\. To send before that, top up on the Plan page: \$1 a signature/);
  // The screens say it where the number is: the Plan card, Home, step 3, and the line about the next charge.
  const page = readFileSync('src/app/app/settings/page.tsx', 'utf8');
  assert.match(page, /\{b\.renewal_pending && <p className="plan-line lot-line" role="status"><b>Your new month&apos;s \{P\.monthlySignatures\} signatures arrive when the renewal payment goes through\.<\/b>/);
  assert.match(page, /b\.renews_at && Date\.parse\(b\.renews_at\) <= Date\.now\(\) \? <>The payment for the new month is being taken now/);
  assert.match(readFileSync('src/components/sender/UsageMeter.tsx', 'utf8'), /a\.renewalPending \? <>Your new month&apos;s/);
  assert.match(readFileSync('src/components/editor/StepReview.tsx', 'utf8'), /b\.renewal_pending \? `Your new month's/);
  // The payment arrives: a fresh nine, and nothing is "on its way" any more.
  await event('invoice.paid', invoice(p, `in9_${p.k}_2`, 30, { billing_reason: 'subscription_cycle' }));
  st = state(p);
  assert.equal(st.renewal_pending, false);
  assert.equal(st.period!.left, 9);
  assert.equal((await p.c.post(`/envelopes/${e.id}/send`)).status, 200);
  // A plan that was cancelled has no new month on its way, and an account that never had a plan has none either.
  const c = await person('Ended');
  await subscribe(c, 20);
  db.run('UPDATE accounts SET cancel_at=? WHERE id=?', lot(c, 'plan').expires_at, c.id);
  travel(20 + 1 / 1440);
  assert.equal(state(c).renewal_pending, false);
  assert.equal(state(await person('Never')).renewal_pending, false);
  balanced(p);
});

test('running out because signatures expired is said with the number, where the person first sees it', async () => {
  const p = await person('Back');
  assert.equal(state(p).last_expiry, null);
  travel(31);
  await again(p);
  const st = state(p);
  assert.deepEqual(st.signatures, { balance: 0, held: 0, available: 0 });
  assert.deepEqual(st.last_expiry, { n: 3, at: lot(p, 'welcome').expires_at, source: 'welcome' });
  assert.equal(expiredWords(st.last_expiry), `Your 3 free signatures expired on ${expiryMoment(lot(p, 'welcome').expires_at)}.`);
  assert.equal((await p.c.get('/billing')).data.last_expiry.n, 3, 'GET /billing carries it');
  assert.equal(expiredWords({ n: 1, at: '2026-12-03T14:00:00.000Z', source: 'topup' }), '1 unused top-up signature expired on 3 December 2026 at 14:00 UTC.');
  assert.equal(expiredWords({ n: 7, at: '2026-12-03T14:00:00.000Z', source: 'plan' }), '7 unused signatures of your last plan month expired on 3 December 2026 at 14:00 UTC.');
  assert.equal(expiredWords(null), '');
  // The Plan card, Home and step 3 of the editor each say it once, next to the zero.
  assert.match(readFileSync('src/app/app/settings/page.tsx', 'utf8'), /const gone = s && s\.available <= 0 && !b\.renewal_pending \? expiredWords\(b\.last_expiry\) : '';/);
  assert.match(readFileSync('src/app/app/settings/page.tsx', 'utf8'), /\{gone && <p className="plan-line lot-line" role="status"><b>\{gone\}<\/b> \{grove \? 'Top up below to send again\.' : 'Start the monthly plan below to send again\.'\}<\/p>\}/);
  assert.match(readFileSync('src/components/sender/UsageMeter.tsx', 'utf8'), /<b>None left to send with\.<\/b> \{a\.renewalPending \? [\s\S]{0,200}expiredWords\(a\.lastExpiry\) \? <>\{expiredWords\(a\.lastExpiry\)\}/);
  assert.match(readFileSync('src/components/sender/allowance.ts', 'utf8'), /lastExpiry: billing\?\.last_expiry \|\| null/);
  assert.match(readFileSync('src/components/editor/StepReview.tsx', 'utf8'), /have === 0 && expiredWords\(b\.last_expiry\) \? `\$\{expiredWords\(b\.last_expiry\)\} ` : ''/);
  // Once something new arrives it is no longer the news.
  await subscribe(p, 30);
  assert.equal(state(p).last_expiry, null);
});

test('the renewal reminder with one held signature is written in the singular', async () => {
  const p = await person('One');
  await subscribe(p, 6);
  await send(p, `oh-${p.k}@signers.example`);
  assert.ok((await moneyTimer()).renewals >= 1);
  const m = lastMail(p.email, /^Heads up: your plan renews/)!;
  assert.match(m, /8 of this month's 9 signatures are still unused\. If they are not used by the renewal, they expire then, and the renewal brings a fresh 9\. The 1 signature held for envelopes that are out does not expire while it is held\./);
});

test('the screens: one way of writing a moment on the Plan tab, 44 px targets, the usage line, and nothing extra on the daily path', () => {
  const page = readFileSync('src/app/app/settings/page.tsx', 'utf8');
  const tab = page.slice(page.indexOf('function Billing() {'), page.indexOf('function YourData() {'));
  // Every date on the tab is written by expiryMoment (UTC, and it says so), so two cards never show one moment two ways.
  assert.doesNotMatch(tab, /longMoment\(|fmtDate\(|longDate\(|utcDate\(|toLocale(Date|Time)String/);
  assert.match(tab, /Next charge: <b>\{b\.next_amount \|\| price\} on \{expiryMoment\(b\.renews_at\)\}<\/b>/);
  assert.match(tab, /`Top-up of \$\{utcDay\(l\.at\)\}`/);
  assert.match(tab, /<tr key=\{p\.id\}><td>\{utcDay\(p\.at\)\}<\/td>/, 'the payments table shows the same day as the top-up line');
  assert.match(tab, /Dates and times on this page are in UTC\./);
  // The count has a heading a screen reader can jump to, and the card does not end in a paragraph of rules.
  assert.match(tab, /<h2>Signatures<\/h2>\s*<div className="balance"><b className="num">\{Math\.max\(0, s\.available\)\}<\/b> left to send with<\/div>/);
  assert.doesNotMatch(tab, /The rest is under &quot;How signatures work&quot; below/);
  assert.equal(billing.billingState(acct(db.get('SELECT id FROM accounts LIMIT 1').id)).lots.find((l: any) => l.source === 'welcome')?.label ?? 'Your free signatures', 'Your free signatures');
  // Buttons, link-buttons, boxes and the fold on the tab are at least 44 px tall on a phone.
  assert.match(tab, /<div className="stack plan-tab">/);
  assert.match(readFileSync('src/app/styles/settings.css', 'utf8'), /@media \(max-width: 760px\) \{\s*\.plan-tab \.btn, \.plan-tab \.btn\.sm, \.plan-tab \.linklike, \.plan-tab input, \.plan-tab summary \{ min-height: 44px; \}/);
  // The usage line under the account name: only while signatures are counted, and it leads to the Plan page.
  assert.match(readFileSync('src/components/AppShell.tsx', 'utf8'), /\{typeof me\.billing\?\.signatures\?\.available === 'number' && \(\s*<Link href="\/app\/settings\?tab=billing" className="usage-line"/);
  // Step 3 says nothing about signatures when enough are left (the designer's note): the last thing it returns is nothing.
  const step = readFileSync('src/components/editor/StepReview.tsx', 'utf8');
  const cost = step.slice(step.indexOf('function SignatureCost('), step.indexOf('// Two people on one envelope'));
  assert.match(cost, /\n  return null;\n\}\s*$/);
  assert.doesNotMatch(cost, /Sending holds/);
  // Home shows the count, when it resets and one link; the rules live on the Plan page only.
  const home = readFileSync('src/components/sender/UsageMeter.tsx', 'utf8');
  assert.doesNotMatch(home, /sn-rules|HELD_EXPIRY_TEXT|<li>/);
  assert.match(home, /<Link href=\{PLAN_PAGE\}>How signatures work<\/Link>/);
  assert.match(home, /This month&apos;s signatures \{a\.period\.fresh === 'none' \? 'expire' : 'reset'\} on \{expiryMoment\(a\.period\.resets_at\)\}/);
});
