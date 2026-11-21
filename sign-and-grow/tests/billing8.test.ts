// Billing, eighth round: what the fourth review of the payment code found (verify:pay-round4). Another product's
// invoice, refund or dispute on a shared provider account never touches our customer; a refund we owe that a person
// sends by hand in parts is settled once they add up, with one true email; no billing email is handed to the mail
// server inside an account's queue; and the lows around cancelling, the stored price, the limits on new accounts,
// public forms and who pays for a signature. Each test fails without its fix.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { boot, Client, signUp, mailTo, upload, signAll, PNG, type Server } from './helpers.ts';
import { stripe, unix } from './stripe-fake.ts';
import { PRICING } from '../src/lib/impact.ts';

let db: Server['db'];
let billing: Server['billing'];
let cron: Server['cron'];
let env: Server['env'];

let evn = 0;
const event = (type: string, object: any, extra: any = {}) => billing.applyStripeEvent({ id: `evt8_${++evn}`, type, created: Math.floor(Date.now() / 1000), data: { object }, ...extra });
const tryEvent = (type: string, object: any, extra: any = {}) => event(type, object, extra).then(() => 'ok', (e: any) => `threw ${e?.message}`);
const acct = (id: string) => db.get('SELECT * FROM accounts WHERE id=?', id);
const pay = (id: string) => db.get('SELECT * FROM payments WHERE id=?', id);
const alerts = () => db.all("SELECT message FROM support_requests WHERE topic='billing' ORDER BY rowid").map((r: any) => r.message as string);
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const subjects = (email: string) => mailTo(email).map((m: any) => m.subject as string);
const lastMail = (email: string, re: RegExp) => {
  const m = mailTo(email).filter((x: any) => re.test(String(x.subject))).at(-1);
  return m ? text(m.html) : null;
};
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const adjust = (id: string, delta: number, ref: string) => db.run("INSERT INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,'adjust',?,?)", id, delta, ref, new Date().toISOString());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const refundsOf = (paymentId: string) => db.all('SELECT * FROM refunds WHERE payment_id=? ORDER BY at, rowid', paymentId);

type Person = { c: Client; id: string; name: string; email: string; cus: string; sub: string; k: number };
let n = 0;
async function person(first: string): Promise<Person> {
  const k = ++n;
  const email = `${first.toLowerCase()}${k}@eight.example`;
  const name = `${first} Tester`;
  const c = await signUp(name, email, `198.51.118.${k}`);
  return { c, id: (await c.get('/me')).data.account.id, name, email, cus: `cus8_${k}`, sub: `sub8_${k}`, k };
}
function invoice(p: Person, inv: string, over: any = {}, chargeOver: any = {}) {
  const o = {
    id: inv, customer: p.cus, subscription: p.sub, amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', hosted_invoice_url: `https://pay.example/${inv}`,
    lines: { data: [{ period: { start: unix(0), end: unix(30) }, metadata: { sg_account: p.id }, price: { id: 'price_grove' } }] }, ...over,
  };
  stripe.invoices[inv] = o;
  stripe.charges.unshift({ id: `ch_${inv}`, paid: true, refunded: false, amount: o.amount_paid, currency: o.currency, customer: o.customer, invoice: inv, last4: '4242', created: unix(0), ...chargeOver });
  return o;
}
const renewal = (p: Person, inv: string, startU: number, over: any = {}) =>
  invoice(p, inv, { billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: startU, end: startU + 30 * 86400 }, metadata: { sg_account: p.id }, price: { id: 'price_grove' } }] }, ...over });
const checkout = (p: Person, over: any = {}) => ({ id: `cs8_${p.k}`, mode: 'subscription', client_reference_id: p.id, customer: p.cus, subscription: p.sub, payment_status: 'paid', ...over });
async function subscribe(p: Person, inv = `in8_${p.k}_1`) {
  Object.assign(stripe.sub(p.sub), { customer: p.cus, metadata: { sg_account: p.id } });
  await event('checkout.session.completed', checkout(p));
  await event('invoice.paid', invoice(p, inv));
}
const state = async (p: Person) => (await p.c.get('/billing')).data;
const bal = async (p: Person) => (await state(p)).signatures;
async function admin(p: Person, tag: string) {
  const email = `${tag}-admin${p.k}@eight.example`;
  await p.c.post('/account/invites', { email, role: 'admin' });
  const adm = new Client();
  adm.ip = `198.51.119.${p.k}`;
  const r = await adm.post('/auth/signup', { name: `${tag} Admin`, email, password: 'correct horse battery', invite: db.get('SELECT token FROM invites WHERE email=?', email)?.token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { c: adm, email };
}
const asOperator = async <T>(p: Person, fn: () => Promise<T>): Promise<T> => {
  process.env.OPERATOR_EMAILS = p.email;
  try {
    return await fn();
  } finally {
    delete process.env.OPERATOR_EMAILS;
  }
};
const day = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

// Public forms.
const sigField = (rid: string, y = 0.5) => ({ id: `f_${rid}`, document_id: 'd', recipient_id: rid, type: 'signature', page: 0, x: 0.1, y, w: 0.3, h: 0.06 });
const textField = (rid: string) => ({ id: `t_${rid}`, document_id: 'd', recipient_id: rid, type: 'text', label: 'Your answer', page: 0, x: 0.5, y: 0.2, w: 0.3, h: 0.03 });
async function form(p: Person, name = 'Join us') {
  const file = await upload(p.c, 1);
  const t = await p.c.post('/envelopes', { kind: 'template', subject: 'Join', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', role_name: 'Member' }], fields: [sigField('r', 0.4), textField('r')] });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const made = await p.c.post('/powerforms', { template_id: t.data.envelope.id, name });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const pf = (await p.c.get('/powerforms')).data.powerforms.find((x: any) => x.id === made.data.id);
  return { slug: pf.slug as string, id: pf.id as string };
}
let ipn = 20;
async function visit(slug: string, name: string, email: string) {
  const v = new Client();
  v.ip = `203.0.118.${ipn++}`;
  const st = await v.post(`/public/powerforms/${slug}/start`, { name, email });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  return { v, tok: String(st.data.url).split('/sign/')[1] };
}
async function finishBody(v: Client, tok: string, answer = 'my answer') {
  await v.post(`/sign/${tok}/consent`);
  const view = (await v.get(`/sign/${tok}`)).data;
  const values: Record<string, string> = {};
  for (const f of view.fields || []) values[f.id] = f.type === 'text' ? answer : '1';
  return { values, signature_png: PNG, initials_png: PNG, version: view.version ?? view.content_version };
}
const finish = async (v: Client, tok: string, answer?: string) => v.post(`/sign/${tok}/complete`, await finishBody(v, tok, answer));
const readyMails = (email: string) => mailTo(email).filter((m: any) => /^You can finish/.test(m.subject)).length;

before(async () => {
  ({ db, billing, cron, env } = await boot());
  process.env.SUPPORT_EMAIL = 'ops8@eight.example';
});
// A provider failure armed by one test never reaches the next.
afterEach(() => {
  stripe.failing.length = 0;
  stripe.losing.length = 0;
  stripe.delayMs = 0;
});

// ---- Another product on a shared provider account (medium) -------------------------------------------------------

async function otherProduct(p: Person, id: string, cents: number, customer = p.cus) {
  const o = { id, customer, subscription: `sub8_other_${id}`, amount_paid: cents, currency: 'usd', status: 'paid', billing_reason: 'subscription_cycle', lines: { data: [{ price: { id: 'price_other_product' }, period: { start: unix(0), end: unix(30) } }] } };
  stripe.invoices[id] = o;
  stripe.charges.unshift({ id: `ch_${id}`, paid: true, refunded: false, amount: cents, currency: 'usd', customer, invoice: id, last4: '4242', created: unix(0) });
  await event('invoice.paid', o);
  return o;
}

test('another product\'s invoice of our own customer: its refund mails nothing, its dispute ends nothing and is never conceded', async () => {
  const p = await person('Shared');
  await subscribe(p);
  await otherProduct(p, 'in8_other_49', 4900);
  // Kept aside with no account of ours on it.
  assert.deepEqual([pay('in8_other_49').kind, pay('in8_other_49').account_id], ['not_ours', null]);
  const mails = mailTo(p.email).length;
  const history = (await state(p)).history.length;
  await event('charge.refunded', stripe.refundByHand('ch_in8_other_49', 4900));
  assert.equal(mailTo(p.email).length, mails, 'no "Refund sent" for a refund of something we did not sell');
  assert.equal((await state(p)).history.length, history);
  // The same customer disputes the other product's charge: our plan, our payments and the dispute are left alone.
  await otherProduct(p, 'in8_other_20', 2000);
  await event('charge.dispute.created', { id: 'dp8_other', charge: 'ch_in8_other_20', amount: 2000, currency: 'usd' });
  assert.equal(stripe.disputesClosed.includes('dp8_other'), false, 'another product\'s dispute is not conceded');
  assert.deepEqual([acct(p.id).plan, acct(p.id).subscription_status, acct(p.id).dispute_at], ['grove', 'active', null]);
  assert.equal(stripe.sub(p.sub).status, 'active');
  assert.equal(mailTo(p.email).length, mails);
  assert.equal((await p.c.post('/billing/topup', { quantity: 5 })).status, 200, 'payments are not switched off');
});

test('a stranger\'s dispute of another product is never conceded by us', async () => {
  const p = await person('Stranger');
  await otherProduct(p, 'in8_stranger', 2000, 'cus8_stranger');
  assert.equal(pay('in8_stranger').kind, 'not_ours');
  const seen = alerts().length;
  await event('charge.dispute.created', { id: 'dp8_stranger', charge: 'ch_in8_stranger', amount: 2000, currency: 'usd' });
  assert.equal(stripe.disputesClosed.includes('dp8_stranger'), false);
  assert.equal(pay('in8_stranger').disputed, null);
  assert.ok(!alerts().slice(seen).some((m) => /account no longer exists/.test(m)));
});

test('an invoice of our customer that names neither our price, our mark nor a subscription of ours is not ours: a person is told', async () => {
  const p = await person('Bare');
  await subscribe(p);
  stripe.sub(p.sub).status = 'canceled'; // subscribed to nothing live, so the invoice cannot be matched to the plan
  const was = (await bal(p)).balance;
  const mails = mailTo(p.email).length;
  const o = { id: 'in8_bare', customer: p.cus, amount_paid: 1500, currency: 'usd', status: 'paid', billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: unix(0), end: unix(30) } }] } };
  stripe.invoices[o.id] = o;
  await event('invoice.paid', o);
  assert.deepEqual([pay('in8_bare').kind, pay('in8_bare').account_id], ['unknown', null]);
  assert.equal((await bal(p)).balance, was);
  assert.equal(mailTo(p.email).length, mails);
  assert.equal(alerts().filter((m) => m.includes('in8_bare') && /could not be told apart/.test(m)).length, 1);
  // Seen again: the person is not told twice.
  await event('invoice.paid', o);
  assert.equal(alerts().filter((m) => m.includes('in8_bare')).length, 1);
});

test('our own refund is never sent to a charge found by its amount; a person is asked and nothing changes', async () => {
  const p = await person('Amount');
  await subscribe(p);
  const inv = `in8_${p.k}_1`;
  db.run('UPDATE payments SET charge_id=NULL WHERE id=?', inv);
  delete stripe.invoices[inv].payment_intent;
  delete stripe.invoices[inv].charge;
  // Our charge is not among the customer's listed charges; another product's $9.00 charge without an invoice is.
  const i = stripe.charges.findIndex((c: any) => c.id === `ch_${inv}`);
  const ours = stripe.charges.splice(i, 1)[0];
  stripe.charges.unshift({ id: 'ch8_other_product', paid: true, refunded: false, amount: 900, currency: 'usd', customer: p.cus, last4: '4242', created: unix(0) });
  const refunds = stripe.refunds.length;
  const seen = alerts().length;
  const r = await p.c.post('/billing/refund', { payment_id: inv });
  stripe.charges.push(ours);
  assert.equal(r.status, 502);
  assert.match(r.data.error, /could not find the card payment for this refund automatically, so nothing was refunded and nothing has changed yet\. A person here has been told/);
  assert.equal(stripe.refunds.length, refunds, 'nothing was sent to the other product\'s charge');
  assert.equal(pay(inv).charge_id, null);
  assert.deepEqual([acct(p.id).plan, (await bal(p)).balance], ['grove', 12], 'the plan goes on and the signatures are back');
  assert.equal(alerts().slice(seen).filter((m) => /A refund a customer asked for needs a person/.test(m)).length, 1);
});

test('a refund reported before its payment is applied waits for it: the payment is applied first, then the refund', async () => {
  const p = await person('Order');
  Object.assign(stripe.sub(p.sub), { customer: p.cus, metadata: { sg_account: p.id } });
  await event('checkout.session.completed', checkout(p));
  const inv = invoice(p, `in8_${p.k}_1`);
  await event('charge.refunded', stripe.refundByHand(`ch_${inv.id}`, 900));
  assert.equal(pay(inv.id).refunded_cents, 900, 'the payment was looked up, applied and then refunded');
  assert.equal((await bal(p)).balance, 3, 'the signatures it bought went with the money');
  assert.ok(subjects(p.email).includes('Refund sent: $9.00'));
  // Its own message comes later and changes nothing.
  await event('invoice.paid', inv);
  assert.equal((await bal(p)).balance, 3);
  assert.equal(pay(inv.id).refunded_cents, 900);
  assert.equal((await state(p)).refund, null, 'not offered again');
});

// ---- A refund we owe, sent by hand in parts (medium) ---------------------------------------------------------------

async function owed(name: string, refusals = 99) {
  const p = await person(name);
  await subscribe(p);
  assert.equal((await p.c.post('/billing/cancel')).status, 200);
  if (refusals) stripe.fail('POST', /^refunds$/, refusals, 'Your card was declined for this refund.', 400);
  const inv = `in8_${p.k}_after`;
  await event('invoice.paid', renewal(p, inv, Math.floor(Date.parse(acct(p.id).cancel_at) / 1000) + 60));
  return { p, inv, ch: `ch_${inv}` };
}
const backdate = (inv: string) => db.run('UPDATE refunds SET last_at=? WHERE payment_id=?', ago(864e5), inv);

test('a refund we owe sent by hand in two parts while ours waits: settled once they add up, one true email', async () => {
  const { p, inv, ch } = await owed('Parts');
  const n0 = mailTo(p.email).length;
  await event('charge.refunded', stripe.refundByHand(ch, 500));
  // Half way: nothing to the customer yet, the person is told what is left, the page says so.
  assert.equal(mailTo(p.email).length, n0);
  assert.ok(alerts().some((m) => m.includes(inv) && /\$5\.00 of it has gone back by hand so far[\s\S]*\$4\.00 is still owed/.test(m)));
  const s = await state(p);
  assert.deepEqual([s.refunds_pending[0].back, s.refunds_pending[0].left], ['$5.00', '$4.00']);
  backdate(inv);
  await cron.tick();
  await event('charge.refunded', stripe.refundByHand(ch, 400));
  for (let i = 0; i < 3; i++) (backdate(inv), await cron.tick());
  const r = refundsOf(inv)[0];
  assert.equal(r.status, 'done');
  assert.equal(pay(inv).refunded_cents, 900);
  const after = mailTo(p.email).slice(n0).map((m: any) => m.subject);
  assert.deepEqual(after.filter((x: string) => /Refund|refund/.test(x)), ['Refund sent: $9.00'], 'told once, never "a person will send" for money that came back');
  assert.match(lastMail(p.email, /^Refund sent/)!, /We refunded \$9\.00 to the card it was paid with \(you were charged after the plan was cancelled\)\. It was sent by a person here in 2 parts: \$5\.00 on .+ and \$4\.00 on .+\. Banks usually show each part/);
  assert.deepEqual((await state(p)).refunds_pending, []);
});

test('with a person after three refusals, then sent by hand in parts: the email at "manual" says what is left, and it settles', async () => {
  const { p, inv, ch } = await owed('Manual');
  await event('charge.refunded', stripe.refundByHand(ch, 300));
  for (let i = 0; i < 3; i++) (backdate(inv), await cron.tick());
  assert.equal(refundsOf(inv)[0].status, 'manual');
  const m = lastMail(p.email, /^A person will send your refund/)!;
  assert.ok(subjects(p.email).includes('A person will send your refund of $6.00'));
  assert.match(m, /We owe you a refund of \$9\.00: you were charged after the plan was cancelled\. So far \$3\.00 of it has gone back to your card, sent by a person here/);
  assert.match(m, /would not send the other \$6\.00 automatically/);
  assert.match((await state(p)).refunds_pending[0].left, /\$6\.00/);
  // The page says the same.
  const page = readFileSync(new URL('../src/app/app/settings/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /r\.by_hand \? <><b>We owe you a refund of \{r\.amount\}[\s\S]*\{r\.back \? <>\{r\.back\} of it has gone back to your card already\. <\/> : ''\}The payment provider would not send \{r\.back \? `the other \$\{r\.left\}` : 'it'\}/);
  await event('charge.refunded', stripe.refundByHand(ch, 600));
  assert.equal(refundsOf(inv)[0].status, 'done');
  assert.match(lastMail(p.email, /^Refund sent/)!, /It was sent by a person here in 2 parts: \$3\.00 on .+ and \$6\.00 on/);
  assert.equal(alerts().filter((x) => x.includes(inv) && /Refund the charge by hand/.test(x)).length, 0, 'the person is told the other $6.00, not the whole charge');
});

test('a refund the customer asked for, part of it sent by hand while ours waits: the rest is sent by us, and the email says both', async () => {
  const p = await person('Asked');
  await subscribe(p);
  const inv = `in8_${p.k}_1`;
  stripe.fail('POST', /^refunds$/, 1, 'busy', 503);
  const r = await p.c.post('/billing/refund');
  assert.deepEqual([r.status, r.data.pending], [200, true]);
  await event('charge.refunded', stripe.refundByHand(`ch_${inv}`, 300));
  backdate(inv);
  await cron.tick();
  assert.equal(refundsOf(inv)[0].status, 'done');
  assert.equal(stripe.refunds.at(-1)!.params.amount, '600', 'only the rest was asked of the provider');
  assert.equal(stripe.refunded(`ch_${inv}`) + 300, 900);
  assert.match(lastMail(p.email, /^Refund sent/)!, /A person here sent \$3\.00 on .+ by hand, and we sent the other \$6\.00 on .+ \(refund reference: re_\d+\)/);
  assert.ok(!subjects(p.email).includes('Your refund needs a person'));
});

test('closing an account at once while a refund we owe is with a person: the closing email says so', async () => {
  const { p, inv } = await owed('Closer');
  for (let i = 0; i < 3; i++) (backdate(inv), await cron.tick());
  assert.equal(refundsOf(inv)[0].status, 'manual');
  const del = await p.c.post('/me/delete', { password: 'correct horse battery', now: true });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  const closing = mailTo(p.email).filter((m: any) => /closed/i.test(m.subject)).map((m: any) => text(m.html)).at(-1)!;
  assert.match(closing, /A refund of \$9\.00 \(reference rf_[\w-]+\) is still owed to the card it was paid with\. The payment provider would not send it automatically, so a person here sends it to the card by hand/);
});

// ---- No email inside an account's queue (medium) ------------------------------------------------------------------

test('a mail server that stalls never holds Cancel: the answer comes first, the emails follow from the outbox', async () => {
  const silent = net.createServer(() => {}); // takes the connection and never greets
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
  const p = await person('Stall');
  await admin(p, 'stall');
  db.run("UPDATE accounts SET plan='grove', stripe_customer_id=?, stripe_subscription_id=?, subscription_status='active', renews_at=?, price_cents=900 WHERE id=?", p.cus, p.sub, new Date(Date.now() + 20 * 864e5).toISOString(), p.id);
  Object.assign(stripe.sub(p.sub), { customer: p.cus, metadata: { sg_account: p.id }, current_period_end: unix(20) });
  process.env.SMTP_URL = `smtp://127.0.0.1:${(silent.address() as net.AddressInfo).port}`;
  (globalThis as any).__tsmail = undefined;
  try {
    // A renewal receipt for two admins is being written, then the owner presses Cancel.
    const receipt = event('invoice.paid', renewal(p, `in8_${p.k}_2`, unix(0)));
    await sleep(50);
    const t = Date.now();
    const c = await p.c.post('/billing/cancel');
    const ms = Date.now() - t;
    assert.equal(c.status, 200, JSON.stringify(c.data));
    assert.ok(ms < 3000, `Cancel answered after ${ms} ms`);
    await receipt;
    // Both emails of both steps are on record, waiting for the mail server, in the order they were written.
    const rows = db.all("SELECT subject, status FROM emails WHERE to_email IN (?, ?) AND (subject LIKE 'Receipt%' OR subject LIKE '%cancelled') ORDER BY id", p.email, `stall-admin${p.k}@eight.example`);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r: any) => r.status === 'queued' || r.status === 'failed'), JSON.stringify(rows));
    // Once the mail server has given up on them they are kept for another try by the timer, as any email.
    await billing.billingMailSent([p.id]);
    const after = db.all("SELECT status, next_try_at FROM emails WHERE to_email=? AND (subject LIKE 'Receipt%' OR subject LIKE '%cancelled')", p.email);
    assert.ok(after.every((r: any) => r.status === 'failed' && r.next_try_at), JSON.stringify(after));
  } finally {
    delete process.env.SMTP_URL;
    (globalThis as any).__tsmail = undefined;
    silent.close();
  }
});

test('a billing email written in a step that the process never handed over is sent by the timer', async () => {
  const { recordMail } = await import('../src/server/mail.ts');
  const id = recordMail({ to: 'left8@eight.example', subject: 'Left in the outbox', heading: 'x', lines: ['x'] });
  db.run('UPDATE emails SET at=? WHERE id=?', ago(20 * 60_000), id);
  await cron.tick();
  assert.equal(db.get('SELECT status FROM emails WHERE id=?', id).status, 'outbox');
});

test('a price notice counts from when its email left, so a run that takes too long never records a notice that cannot hold', async () => {
  const p = await person('Late');
  await subscribe(p);
  const from = day(31);
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  let r: any;
  try {
    // No mail server on a real server: nothing left, nothing is recorded.
    r = await asOperator(p, () => p.c.post('/operator/billing/price-notice', { new_usd: 12, from }));
  } finally {
    process.env.NODE_ENV = was;
  }
  assert.equal(acct(p.id).price_notice_cents, null);
  assert.ok(r.data.not_told.some((x: string) => x.startsWith(acct(p.id).name)));
  // That email leaves much later (the timer tried it again), less than 30 days before the first day.
  db.run("UPDATE emails SET tried_at=? WHERE to_email=? AND subject LIKE 'The price of your GrowSigning plan changes on%'", new Date(Date.parse(`${from}T00:00:00.000Z`) - 20 * 864e5).toISOString(), p.email);
  const again = await asOperator(p, () => p.c.post('/operator/billing/price-notice', { new_usd: 12, from }));
  assert.equal(again.status, 200);
  assert.ok(again.data.too_late.includes(acct(p.id).name), JSON.stringify(again.data));
  assert.equal(acct(p.id).price_notice_cents, null, 'not recorded as notice it is not');
  assert.equal(subjects(p.email).filter((s) => s.startsWith('The price of your GrowSigning plan changes on')).length, 1, 'nobody is emailed twice');
  // The operator page says what that means.
  const page = readFileSync(new URL('../src/app/app/operator/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /out\.too_late\??\.length > 0/);
  assert.match(page, /out\.on_the_way\??\.length > 0/);
});

// ---- Cancelling (low) ---------------------------------------------------------------------------------------------

const pastDue = async (p: Person) => {
  const open = `in8_${p.k}_open`;
  stripe.invoices[open] = { id: open, customer: p.cus, subscription: p.sub, status: 'open', amount_due: 900, amount_remaining: 900, currency: 'usd', hosted_invoice_url: 'https://pay.example/open' };
  Object.assign(stripe.sub(p.sub), { status: 'past_due', latest_invoice: open, customer: p.cus, current_period_end: unix(28) });
  await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'past_due', current_period_end: unix(28), metadata: { sg_account: p.id } }, { created: unix(0) });
  return open;
};

test('Cancel pressed and not confirmed, then the pay page opened and left: the card retry is still sent back', async () => {
  const p = await person('Mark');
  const adm = await admin(p, 'mark');
  await subscribe(p);
  const open = await pastDue(p);
  stripe.fail('DELETE', /^subscriptions\//, 2);
  assert.equal((await p.c.post('/billing/cancel')).status, 502);
  // Another admin presses "Pay the open payment": asked first, with what it means.
  const po = await adm.c.post('/billing/pay-open');
  assert.equal(po.status, 409);
  assert.equal(po.data.code, 'cancel_pressed');
  assert.match(po.data.error, /Cancel was pressed for this plan on .+ and the payment provider has not confirmed it yet, so this payment would not be kept: if it is taken, it is refunded and the plan ends\. Pay it only if you want to keep the plan after all/);
  assert.ok(db.get('SELECT 1 x FROM stripe_events WHERE id=?', `after-stop:${p.id}:${open}`), 'the stop stays');
  // The provider's own retry of the card goes through, nobody having paid on the page.
  Object.assign(stripe.sub(p.sub), { status: 'active' });
  await event('invoice.paid', renewal(p, open, unix(-2), { status_transitions: { paid_at: unix(0) + 60 } }));
  assert.equal(stripe.refunded(`ch_${open}`), 900);
  assert.equal(acct(p.id).plan, 'seedling');
  // The page asks before it sends anyone to pay.
  const page = readFileSync(new URL('../src/app/app/settings/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /e\.code === 'cancel_pressed'[\s\S]*window\.confirm[\s\S]*body: \{ keep: true \}/);
});

test('set to end in the message, not any more in the fresh read: the plan is read as it is, not ended', async () => {
  const p = await person('Undo');
  await subscribe(p);
  await pastDue(p);
  Object.assign(stripe.sub(p.sub), { status: 'unpaid', cancel_at_period_end: false, cancel_at: null });
  await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'past_due', cancel_at_period_end: true, current_period_end: unix(28), metadata: { sg_account: p.id } }, { created: unix(0) + 5 });
  assert.equal(stripe.sub(p.sub).status, 'unpaid', 'not ended at the provider');
  assert.equal(acct(p.id).subscription_status, 'unpaid');
  assert.ok(!subjects(p.email).includes('Your Grove plan is cancelled'));
  assert.ok(subjects(p.email).includes('Your monthly plan is on hold'));
});

test('Cancel pressed again after the plan was taken back on the provider page: the provider is asked, and the late resume changes nothing', async () => {
  const p = await person('Again');
  await subscribe(p);
  const first = await p.c.post('/billing/cancel');
  assert.equal(first.data.why, 'paid');
  stripe.sub(p.sub).cancel_at_period_end = false; // resumed on the provider page; its message is late
  await sleep(1100);
  const resumedAt = Math.floor(Date.now() / 1000);
  await sleep(1100);
  const second = await p.c.post('/billing/cancel');
  assert.equal(second.status, 200);
  assert.notEqual(second.data.reference, first.data.reference, 'a cancellation of its own');
  assert.equal(stripe.sub(p.sub).cancel_at_period_end, true, 'the provider was told again');
  await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'active', cancel_at_period_end: false, current_period_end: stripe.sub(p.sub).current_period_end, metadata: { sg_account: p.id } }, { created: resumedAt });
  assert.ok(acct(p.id).cancel_at, 'still cancelled');
  assert.ok(!subjects(p.email).includes('Your Grove plan continues'));
  const inv = `in8_${p.k}_2`;
  await event('invoice.paid', renewal(p, inv, stripe.sub(p.sub).current_period_end));
  assert.equal(stripe.refunded(`ch_${inv}`), 900);
});

test('Cancel pressed again after its echo ended the plan: the same cancellation is said again, not an error', async () => {
  const p = await person('Echo');
  await subscribe(p);
  const open = await pastDue(p);
  stripe.fail('DELETE', /^subscriptions\//, 1);
  stripe.fail('GET', /^subscriptions\//, 1);
  assert.equal((await p.c.post('/billing/cancel')).status, 502);
  await event('customer.subscription.updated', { id: p.sub, customer: p.cus, status: 'past_due', cancel_at_period_end: true, current_period_end: unix(28), metadata: { sg_account: p.id } }, { created: unix(0) + 5 });
  assert.equal(acct(p.id).subscription_status, 'canceled');
  const again = await p.c.post('/billing/cancel');
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.deepEqual([again.data.reference, again.data.ended_now, again.data.why], [acct(p.id).cancel_ref, true, 'already_ended']);
  assert.equal(stripe.invoices[open].status, 'void');
});

// ---- The stored price (low) ---------------------------------------------------------------------------------------

test('the price written down for an old row is its last full-price payment before its own tax, never the next tax or a discounted month', async () => {
  // Paid $9.72 with $0.72 tax; the provider's early notice since says the next tax is $0.90.
  const a = await person('TaxRow');
  await subscribe(a, `in8_${a.k}_1`);
  db.run("UPDATE payments SET amount_cents=972, tax_cents=NULL WHERE id=?", `in8_${a.k}_1`); // a row from before the tax was kept
  db.run('UPDATE accounts SET price_cents=NULL, renewal_tax_cents=90 WHERE id=?', a.id);
  // The last plan payment was a $4.50 coupon month (4 signatures); the one before it was the full $9.00.
  const b = await person('Coupon');
  await subscribe(b, `in8_${b.k}_1`);
  await event('invoice.paid', renewal(b, `in8_${b.k}_2`, unix(1), { amount_paid: 450 }));
  assert.equal(pay(`in8_${b.k}_2`).credits, 4);
  db.run('UPDATE accounts SET price_cents=NULL WHERE id=?', b.id);
  billing.backfillPrices();
  assert.equal(acct(a.id).price_cents, 900);
  assert.equal(acct(b.id).price_cents, 900);
  // A payment from now on keeps its own tax.
  await event('invoice.paid', renewal(a, `in8_${a.k}_2`, unix(2), { amount_paid: 990, tax: 90 }));
  assert.equal(pay(`in8_${a.k}_2`).tax_cents, 90);
  assert.equal(stripe.refunded(`ch_in8_${a.k}_2`), 0, 'tax on top is allowed: no "price went up" refund');
  await event('invoice.paid', renewal(b, `in8_${b.k}_3`, unix(3)));
  assert.equal(stripe.refunded(`ch_in8_${b.k}_3`), 0, 'the full price after a discounted month is the price');
});

test('the Plan page reads an account whose price is not written down through the same backfill as the money', async () => {
  const p = await person('NullRow');
  await subscribe(p);
  db.run('UPDATE accounts SET price_cents=NULL WHERE id=?', p.id);
  PRICING.monthlyUsd = 12;
  try {
    const s = await state(p);
    assert.deepEqual([s.plan_price, s.next_amount], ['$9.00', '$9.00']);
  } finally {
    PRICING.monthlyUsd = 9;
  }
});

// ---- The limits on new accounts (low) -----------------------------------------------------------------------------

test('a payment we sent a little back from ourselves (charged more than we said) still lifts the limits; the page says the rule without "has not paid"', async () => {
  const p = await person('Overcharge');
  await subscribe(p);
  db.run('UPDATE accounts SET renews_at=?, renewal_reminded=NULL WHERE id=?', new Date(Date.now() + 6 * 864e5).toISOString(), p.id);
  await billing.renewalReminders();
  const inv = `in8_${p.k}_2`;
  await event('invoice.paid', renewal(p, inv, Math.floor(Date.parse(acct(p.id).renews_at) / 1000), { amount_paid: 918 }));
  assert.equal(stripe.refunded(`ch_${inv}`), 18);
  assert.equal(pay(inv).refunded_cents, 18);
  // Only that payment is old enough to lift the limits (the first one is less than 14 days old).
  db.run('UPDATE payments SET at=? WHERE id=?', ago(20 * 864e5), inv);
  db.run('UPDATE accounts SET created_at=? WHERE id=?', ago(30 * 864e5), p.id);
  assert.equal(env.hasNotPaid(acct(p.id)), false);
  assert.equal((await state(p)).limits.lifts_on, null);
  // A refund made by hand, or one the customer asked for, still keeps them on.
  db.run('UPDATE payments SET refunded_cents=refunded_cents+100 WHERE id=?', inv);
  assert.equal(env.hasNotPaid(acct(p.id)), true);
  const page = readFileSync(new URL('../src/app/app/settings/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /an account that has not paid anything can send/);
  assert.match(page, /an account without a payment that has stood for \{b\.limits\.paid_trust_days\} days can send to/);
});

// ---- Public forms (low) -------------------------------------------------------------------------------------------

test('two visitors finishing a form at the same moment with one signature free: one signs, the other is told to wait', async () => {
  for (let t = 0; t < 3; t++) {
    const p = await person(`Race${t}`);
    adjust(p.id, -2, 'leave1'); // 1 free
    const f = await form(p);
    const a = await visit(f.slug, 'Racer One', `r1-${t}@eight.example`);
    const b = await visit(f.slug, 'Racer Two', `r2-${t}@eight.example`);
    const bodies = [await finishBody(a.v, a.tok), await finishBody(b.v, b.tok)];
    const r = await Promise.all([a.v.post(`/sign/${a.tok}/complete`, bodies[0]), b.v.post(`/sign/${b.tok}/complete`, bodies[1])]);
    assert.deepEqual(r.map((x) => x.status).sort(), [200, 503]);
    assert.equal((await bal(p)).balance, 0, 'never below zero');
    // The one who was told to wait kept what they filled in.
    const waiting = db.get("SELECT r.status, r.form_waits_at FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE e.account_id=? AND e.powerform_id IS NOT NULL AND r.status!='completed'", p.id);
    assert.ok(waiting?.form_waits_at);
  }
});

async function waiting(name: string) {
  const p = await person(name);
  adjust(p.id, -2, 'leave1'); // 1 free
  const f = await form(p);
  const vs = [await visit(f.slug, 'First Visitor', `first-${name}@eight.example`), await visit(f.slug, 'Second Visitor', `second-${name}@eight.example`), await visit(f.slug, 'Third Visitor', `third-${name}@eight.example`)];
  const st = [];
  for (const v of vs) st.push((await finish(v.v, v.tok)).status);
  assert.deepEqual(st, [200, 503, 503]);
  return { p, f, vs };
}

test('"You can finish now" is not sent to a visitor who marked us as spam, for a paused account, or for a form that is switched off', async () => {
  const w1 = await waiting('Spam');
  db.run('UPDATE recipients SET complained_at=? WHERE email=?', new Date().toISOString(), 'second-Spam@eight.example');
  db.run('INSERT OR IGNORE INTO mail_complaints (account_id, email, at) VALUES (?,?,?)', w1.p.id, 'second-spam@eight.example', new Date().toISOString());
  adjust(w1.p.id, 5, 'more');
  await cron.tick();
  assert.deepEqual([readyMails('second-Spam@eight.example'), readyMails('third-Spam@eight.example')], [0, 1]);

  const w2 = await waiting('Off');
  db.run('UPDATE powerforms SET active=0 WHERE id=?', w2.f.id);
  adjust(w2.p.id, 5, 'more');
  await cron.tick();
  assert.deepEqual([readyMails('second-Off@eight.example'), readyMails('third-Off@eight.example')], [0, 0]);
  db.run('UPDATE powerforms SET active=1 WHERE id=?', w2.f.id);
  await cron.tick();
  assert.deepEqual([readyMails('second-Off@eight.example'), readyMails('third-Off@eight.example')], [1, 1], 'told once it is on again');

  const w3 = await waiting('Paused');
  db.run("UPDATE accounts SET suspended_at=?, suspended_reason='reports of fake documents' WHERE id=?", new Date().toISOString(), w3.p.id);
  adjust(w3.p.id, 5, 'more');
  await cron.tick();
  assert.deepEqual([readyMails('second-Paused@eight.example'), readyMails('third-Paused@eight.example')], [0, 0]);
});

test('a visitor who was told and stays away does not keep the next one waiting for ever', async () => {
  const w = await waiting('Room');
  adjust(w.p.id, 1, 'one-more');
  await cron.tick();
  assert.deepEqual([readyMails('second-Room@eight.example'), readyMails('third-Room@eight.example')], [1, 0]);
  await cron.tick();
  assert.equal(readyMails('third-Room@eight.example'), 0, 'not while the one told may still come');
  db.run('UPDATE recipients SET form_ready_at=? WHERE email=?', ago(25 * 3600_000), 'second-Room@eight.example');
  await cron.tick();
  assert.equal(readyMails('third-Room@eight.example'), 1);
});

test('the refusal promises an email only to someone we may email', async () => {
  const p = await person('Promise');
  adjust(p.id, -2, 'one'); // one free while they start
  const f = await form(p);
  const v = await visit(f.slug, 'Spam Visitor', 'spam-promise@eight.example');
  const q = await visit(f.slug, 'Plain Visitor', 'plain-promise@eight.example');
  adjust(p.id, -1, 'none'); // and none when they finish
  db.run('INSERT OR IGNORE INTO mail_complaints (account_id, email, at) VALUES (?,?,?)', p.id, 'spam-promise@eight.example', new Date().toISOString());
  const r = await finish(v.v, v.tok);
  assert.equal(r.status, 503);
  assert.doesNotMatch(r.data.error, /We email you at/);
  assert.match((await finish(q.v, q.tok)).data.error, /We email you at plain-promise@eight\.example once the form can take your signature/);
});

// ---- Who pays for a signature (low) -------------------------------------------------------------------------------

async function envelope(p: Person, recipients: any[]) {
  const file = await upload(p.c, 1);
  const made = await p.c.post('/envelopes', { subject: 'Round trip', documents: [{ id: 'd', file_id: file.id }], recipients, fields: recipients.map((r, i) => sigField(r.id, 0.2 + i * 0.15)) });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal((await p.c.post(`/envelopes/${made.data.envelope.id}/send`)).status, 200);
  return made.data.envelope.id as string;
}
const used = (p: Person) => db.get("SELECT COUNT(*) n FROM credits WHERE account_id=? AND reason='signature'", p.id).n;

test('renamed to someone else and straight back: the same person signs again on what they paid for', async () => {
  // Through Edit envelope with sign again.
  const p = await person('RoundTrip');
  adjust(p.id, -1, 'leave2'); // 2 free
  const e = await envelope(p, [{ id: 'r1', role: 'signer', name: 'Ann Smith', email: 'ann.rt8@eight.example' }, { id: 'r2', role: 'signer', name: p.name, email: p.email }]);
  assert.equal((await signAll(e, 'ann.rt8@eight.example')).status, 200);
  for (const name of ['Bob Jones', 'Ann Smith']) {
    const full = (await p.c.get(`/envelopes/${e}`)).data.envelope;
    full.recipients.find((r: any) => r.email === 'ann.rt8@eight.example').name = name;
    assert.equal((await p.c.put(`/envelopes/${e}`, { ...full, resign: true })).status, 200);
  }
  assert.equal((await signAll(e, 'ann.rt8@eight.example')).status, 200);
  assert.equal(used(p), 1, 'Ann paid once');
  // Through Correct.
  const q = await person('RoundTrip2');
  adjust(q.id, -1, 'leave2');
  const e2 = await envelope(q, [{ id: 'r1', role: 'signer', name: 'Ann Smith', email: 'ann.rt9@eight.example' }, { id: 'r2', role: 'signer', name: q.name, email: q.email }]);
  await signAll(e2, 'ann.rt9@eight.example');
  const full = (await q.c.get(`/envelopes/${e2}`)).data.envelope;
  assert.equal((await q.c.put(`/envelopes/${e2}`, { ...full, fields: [...full.fields, { id: 'n1', document_id: full.documents[0].id, type: 'note', value: 'Changed', page: 0, x: 0.5, y: 0.8, w: 0.3, h: 0.03 }], resign: true })).status, 200);
  const rid = db.get('SELECT id FROM recipients WHERE envelope_id=? AND email=?', e2, 'ann.rt9@eight.example').id;
  assert.equal((await q.c.post(`/envelopes/${e2}/correct`, { recipient_id: rid, name: 'Bob Jones' })).status, 200);
  assert.equal((await q.c.post(`/envelopes/${e2}/correct`, { recipient_id: rid, name: 'Ann Smith' })).status, 200);
  await signAll(e2, 'ann.rt9@eight.example');
  assert.equal(used(q), 1);
  // Someone really new still pays: Bob signs as Bob.
  const r = await person('RoundTrip3');
  adjust(r.id, -1, 'leave2');
  const e3 = await envelope(r, [{ id: 'r1', role: 'signer', name: 'Ann Smith', email: 'ann.rt10@eight.example' }, { id: 'r2', role: 'signer', name: r.name, email: r.email }]);
  await signAll(e3, 'ann.rt10@eight.example');
  const f3 = (await r.c.get(`/envelopes/${e3}`)).data.envelope;
  f3.recipients.find((x: any) => x.email === 'ann.rt10@eight.example').name = 'Bob Jones';
  assert.equal((await r.c.put(`/envelopes/${e3}`, { ...f3, resign: true })).status, 200);
  await signAll(e3, 'ann.rt10@eight.example');
  assert.equal(used(r), 2);
});

// ---- Words ---------------------------------------------------------------------------------------------------------

test('the comments and words about these cases say what the code does, and no em dash', () => {
  const src = readFileSync(new URL('../src/server/routes-billing.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /Only as a last resort is it matched by amount/);
  assert.doesNotMatch(src, /cancel_at is only written below, once the\s+\/\/ provider has confirmed both the end and that the month is paid for\.\)\s+if \(a\.cancel_at/);
  for (const f of ['../src/server/routes-billing.ts', '../src/app/app/settings/page.tsx', '../src/app/app/operator/page.tsx', '../src/server/credits.ts']) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /—/, f);
});
