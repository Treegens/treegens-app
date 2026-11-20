import { route } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, hmac, now, isEmail, str, rateLimit, baseUrl, safeEqual, HttpError } from './util.ts';
import { sendMail } from './mail.ts';
import { billingEnabled } from './envelopes.ts';
import { grant, creditSummary, available, findFreeCode } from './credits.ts';
import { PRICING, mangrovesFor } from '../lib/impact.ts';

// How Sign&Grow charges:
//   - $9 a month adds 9 signatures to the balance. Extra signatures are $1 each. Every dollar plants 10 mangroves.
//   - Signatures never expire. One is used only when somebody actually signs.
//   - Month to month. No annual term, no notice period, and nothing is ever charged without an explicit choice.
// And the things people most often say went wrong elsewhere, handled in code rather than in a policy page:
//   - Cancelling is one button. It also works from an email link without logging in, and by card for people locked out.
//   - Every charge is announced before it happens and receipted after. The amount shown is the amount charged.
//   - Unused signatures from the latest payment are refunded automatically on request. Nobody has to argue for it.
//   - A charge that arrives after cancellation is refunded by the software itself.
//   - Stopping payment never deletes or locks anything, and signatures already paid for stay usable.

export const refundDays = () => Number(process.env.REFUND_DAYS) || 30;
const money = (cents: number, currency = 'usd') => new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
const iso = (unix?: number | null) => (unix ? new Date(unix * 1000).toISOString() : null);
const sigs = (n: number) => `${n} signature${n === 1 ? '' : 's'}`;
const PLAN_PRICE = () => money(PRICING.monthlyUsd * 100);
const trees = (cents: number) => `${mangrovesFor(cents / 100).toLocaleString('en')} mangrove trees`;

async function stripe(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1/${path}${method === 'GET' && qs ? `?${qs}` : ''}`, {
    method,
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? qs : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw bad(data?.error?.message || 'The payment provider returned an error.', 502);
  return data;
}

// Stripe moved the period end from the subscription to its items in newer API versions. Read either.
const periodEnd = (sub: any): string | null => iso(sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end);

const admins = (accountId: string) => all("SELECT u.email, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", accountId);
async function mailAdmins(accountId: string, subject: string, heading: string, lines: string[], cta?: { label: string; url: string }) {
  for (const a of admins(accountId)) await sendMail({ to: a.email, subject, heading, lines, cta });
}

// Links that stop a renewal without logging in. Signed, tied to one account, valid for 120 days.
export function stopToken(accountId: string, days = 120): string {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  return `${accountId}.${exp}.${hmac(`stop:${accountId}:${exp}`).slice(0, 32)}`;
}
export function readStopToken(tok: any): string | null {
  const [accountId, exp, sig] = String(tok ?? '').split('.');
  if (!accountId || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  return safeEqual(sig, hmac(`stop:${accountId}:${exp}`).slice(0, 32)) ? accountId : null;
}
const stopUrl = (accountId: string) => `${baseUrl()}/billing/stop?token=${stopToken(accountId)}`;

// Only the most recent payment can be refunded from the app.
function lastPayment(accountId: string) {
  const p = get('SELECT * FROM payments WHERE account_id=? ORDER BY at DESC, rowid DESC LIMIT 1', accountId);
  return p && !p.refunded_at ? p : null;
}

// The refund rule, in one place: within the window, every signature from the latest payment that has not been used
// is refunded at the price paid for it. Nobody needs to approve it.
export function refundOffer(account: any): { payment_id: string; cents: number; amount: string; signatures: number; of: number; kind: string; reason: string } | null {
  const p = lastPayment(account.id);
  if (!p || !p.credits) return null;
  const ageDays = (Date.now() - Date.parse(p.at)) / 864e5;
  if (ageDays > refundDays()) return null;
  const unused = Math.min(p.credits, Math.max(0, available(account.id)));
  if (unused <= 0) return null;
  const cents = Math.round((p.amount_cents / p.credits) * unused);
  return {
    payment_id: p.id, cents, amount: money(cents, p.currency), signatures: unused, of: p.credits, kind: p.kind,
    reason: unused === p.credits ? `none of its ${sigs(p.credits)} have been used` : `${unused} of its ${sigs(p.credits)} have not been used`,
  };
}

// How long a paid account can go without sending anything before its renewal is stopped for it. 0 turns this off.
export const dormantStopDays = () => (process.env.DORMANT_AUTO_STOP_DAYS === undefined ? 90 : Number(process.env.DORMANT_AUTO_STOP_DAYS) || 0);

const LEDGER_LABEL: Record<string, string> = { welcome: 'Welcome signatures', plan: 'Monthly plan', code: 'Monthly plan, free with your code', topup: 'Top-up', signature: 'Signature used', refund: 'Refund', adjust: 'Adjustment' };

export function billingState(account: any, user?: any) {
  const enabled = billingEnabled();
  const paid = get('SELECT COALESCE(SUM(amount_cents - refunded_cents),0) cents FROM payments WHERE account_id=?', account.id).cents;
  return {
    enabled,
    plan: account.plan,
    status: account.subscription_status,
    price: PRICING.monthlyUsd,
    pricing: PRICING,
    // Set when the plan is free through a code: nothing is charged, so there is nothing to renew or to end.
    free_with: account.promo_code || null,
    renews_at: account.plan === 'grove' && !account.cancel_at && !account.promo_code ? account.renews_at : null,
    ends_at: account.plan === 'grove' && !account.promo_code ? account.cancel_at : null,
    // What can be sent right now: the balance, minus signatures held for people who have been asked and not signed yet.
    signatures: enabled ? creditSummary(account.id) : null,
    mangroves: mangrovesFor(paid / 100),
    refund: enabled ? refundOffer(account) : null,
    refund_days: refundDays(),
    dormant_stop_days: dormantStopDays(),
    // Other paid plans this person already manages, so nobody pays twice without noticing.
    other_paid: user ? all("SELECT a.name FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role IN ('owner','admin') AND a.plan='grove' AND a.promo_code IS NULL AND a.id!=?", user.id, account.id).map((r) => r.name) : [],
    payments: all('SELECT id, amount_cents, currency, at, receipt_url, refunded_at, refunded_cents, kind, credits FROM payments WHERE account_id=? ORDER BY at DESC, rowid DESC LIMIT 60', account.id)
      .map((p) => ({ ...p, amount: money(p.amount_cents, p.currency), refunded: p.refunded_cents ? money(p.refunded_cents, p.currency) : null })),
    ledger: all('SELECT delta, reason, at FROM credits WHERE account_id=? ORDER BY id DESC LIMIT 40', account.id).map((l) => ({ ...l, label: LEDGER_LABEL[l.reason] || l.reason })),
    // Left over from the first pricing model. Always neutral now.
    used: 0, limit: null, resets_at: null,
  };
}

// Cancelling. One state change with the payment provider, a reference number, and an email that says when billing stops.
export async function cancelPlan(account: any, by: string, quiet = false): Promise<{ ends_at: string; reference: string }> {
  if (account.plan !== 'grove' || !account.stripe_subscription_id) throw bad('There is no monthly plan on this account, so there is nothing to cancel and nothing will be charged.');
  if (account.cancel_at) return { ends_at: account.cancel_at, reference: account.cancel_ref || '' };
  const sub = await stripe('POST', `subscriptions/${account.stripe_subscription_id}`, { cancel_at_period_end: 'true' });
  const ends = periodEnd(sub) || account.renews_at || now();
  const reference = `SG-${account.id.slice(-5).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  run('UPDATE accounts SET cancel_at=?, cancel_ref=? WHERE id=?', ends, reference, account.id);
  if (quiet) return { ends_at: ends, reference };
  const left = Math.max(0, available(account.id));
  await mailAdmins(account.id, `Your ${PRICING.planName} plan is cancelled`, 'Cancelled. You will not be charged again.', [
    `Cancellation reference: ${reference}. Cancelled ${by}.`,
    `The plan runs until ${day(ends)}, because that month is already paid for. No more payments are taken after that.`,
    `Your signatures stay yours: the ${sigs(left)} you have left never expire, and signing your own documents is always free.`,
    'Nothing is deleted. Every document, audit trail and receipt stays available to you for as long as the account exists.',
    'If a charge ever appears after this date, we refund it automatically.',
  ], { label: 'Changed your mind? Resume', url: `${baseUrl()}/app/settings?tab=billing` });
  return { ends_at: ends, reference };
}

// Sends money back to where it came from and records it. `cents` may be part of the payment.
async function refundPayment(account: any, p: any, cents: number, signatures: number, why: string): Promise<string> {
  let target: Record<string, string>;
  if (String(p.charge_id || '').startsWith('pi_')) target = { payment_intent: p.charge_id };
  else if (String(p.charge_id || '').startsWith('ch_')) target = { charge: p.charge_id };
  else {
    const charges = await stripe('GET', 'charges', { customer: account.stripe_customer_id, limit: '20' });
    const charge = (charges.data || []).find((c: any) => c.paid && !c.refunded && c.amount === p.amount_cents);
    if (!charge) throw bad('We could not find that charge automatically. Use the contact form and a person will refund it by hand.', 502);
    target = { charge: charge.id };
  }
  const refund = await stripe('POST', 'refunds', { ...target, amount: String(cents) });
  run('UPDATE payments SET refunded_at=?, refunded_cents=refunded_cents+? WHERE id=?', now(), cents, p.id);
  if (signatures > 0) grant(account.id, -signatures, 'refund', p.id);
  await mailAdmins(account.id, `Refund sent: ${money(cents, p.currency)}`, 'Your refund is on its way', [
    `We refunded ${money(cents, p.currency)} to the card it was paid with (${why}).`,
    `Refund reference: ${refund.id}. Banks usually show it within 5 to 10 working days.`,
  ]);
  return refund.id;
}

route('GET', '/billing', (c) => billingState(c.account, c.user));

// A code that makes the monthly plan free. The plan's signatures arrive every month and nothing is ever charged for it.
route('POST', '/billing/redeem', async (c) => {
  rateLimit(`redeem:${c.ip}`, 20, 3600_000);
  const code = findFreeCode((await c.body()).code);
  if (!code) throw bad('We do not recognise that code. Check the spelling and try again.');
  const a = c.account;
  if (a.promo_code !== code) {
    // Someone already paying is never charged again once their plan is free.
    if (a.plan === 'grove' && a.stripe_subscription_id && !a.cancel_at && billingEnabled()) await cancelPlan(a, 'because a free code was added', true);
    run("UPDATE accounts SET promo_code=?, promo_at=?, plan='grove', subscription_status='free' WHERE id=?", code, now(), a.id);
    await mailAdmins(a.id, `Code ${code} accepted: your plan is free`, 'Your monthly plan is free', [
      `${a.name} is on the monthly plan at no charge with the code ${code}. ${sigs(PRICING.monthlySignatures)} are added to your balance every month.`,
      `There is no card on file for it and nothing to cancel. If you need more in a busy month you can top up at ${money(PRICING.topUpUsd * 100)} a signature, and every dollar plants ${PRICING.treesPerUsd} mangrove trees.`,
    ], { label: 'Open the Plan page', url: `${baseUrl()}/app/settings?tab=billing` });
  }
  return billingState(get('SELECT * FROM accounts WHERE id=?', a.id), c.user);
}, 'admin');

route('POST', '/billing/checkout', async (c) => {
  if (!billingEnabled() || !process.env.STRIPE_PRICE_GROVE) throw bad('Billing is not set up on this server yet.', 501);
  const a = c.account;
  if (a.promo_code) throw bad(`Your plan is already free with the code ${a.promo_code}. There is nothing to pay.`);
  if (a.plan === 'grove' && !a.cancel_at) throw bad(`This account is already on the ${PRICING.planName} plan.`);
  const s = await stripe('POST', 'checkout/sessions', {
    mode: 'subscription', 'line_items[0][price]': process.env.STRIPE_PRICE_GROVE, 'line_items[0][quantity]': '1',
    client_reference_id: a.id, success_url: `${baseUrl()}/app/settings?tab=billing&upgraded=1&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${baseUrl()}/app/settings?tab=billing`,
    ...(a.stripe_customer_id ? { customer: a.stripe_customer_id } : { customer_email: c.user.email }),
  });
  return { url: s.url };
}, 'admin');

// Buy extra signatures. A one-off payment, chosen on purpose, with the exact price shown before paying.
// It never changes the plan or the monthly price.
route('POST', '/billing/topup', async (c) => {
  if (!billingEnabled()) throw bad('Billing is not set up on this server yet.', 501);
  const a = c.account;
  if (a.plan !== 'grove') throw bad(`Top-ups are for accounts on the monthly plan. Start it for ${PLAN_PRICE()} a month and you get ${sigs(PRICING.monthlySignatures)} straight away.`);
  const quantity = Math.round(Number((await c.body()).quantity));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > PRICING.topUpMax) throw bad(`Choose between 1 and ${PRICING.topUpMax} signatures.`);
  const s = await stripe('POST', 'checkout/sessions', {
    mode: 'payment', 'line_items[0][quantity]': String(quantity),
    'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(PRICING.topUpUsd * 100),
    'line_items[0][price_data][product_data][name]': `Sign&Grow signature (plants ${PRICING.treesPerUsd} mangrove trees)`,
    'metadata[kind]': 'topup', 'metadata[credits]': String(quantity),
    client_reference_id: a.id, success_url: `${baseUrl()}/app/settings?tab=billing&topped=1&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${baseUrl()}/app/settings?tab=billing`,
    ...(a.stripe_customer_id ? { customer: a.stripe_customer_id } : { customer_email: c.user.email }),
  });
  return { url: s.url, quantity, total: money(quantity * PRICING.topUpUsd * 100) };
}, 'admin');

// Turns the monthly plan on. Used by the provider's event and by the return from checkout, whichever arrives first.
async function activate(accountId: string, customer: string, subscription: string): Promise<boolean> {
  const a = get('SELECT * FROM accounts WHERE id=?', accountId);
  if (!a) return false;
  if (a.plan === 'grove' && a.stripe_subscription_id === subscription && !a.cancel_at) return false;
  run("UPDATE accounts SET plan='grove', stripe_customer_id=?, stripe_subscription_id=?, subscription_status='active', cancel_at=NULL, cancel_ref=NULL WHERE id=?", customer, subscription, accountId);
  await mailAdmins(accountId, `Welcome to ${PRICING.planName}`, 'Thank you. Your signatures plant mangroves.', [
    `You are on the monthly plan: ${PLAN_PRICE()} a month adds ${sigs(PRICING.monthlySignatures)} to your balance with every payment. That is ${trees(PRICING.monthlyUsd * 100)} planted each month.`,
    `Signatures never expire, so what you do not use rolls over. Need more? Top up any time at ${money(PRICING.topUpUsd * 100)} a signature.`,
    'It is month to month: no contract, no notice period, and nothing is ever charged unless you choose it. You get a receipt for every payment and a reminder before each renewal.',
    `Changed your mind? Unused signatures from your latest payment are refunded in full within ${refundDays()} days, from the Plan page, without talking to anyone.`,
    'To stop renewing, use the Cancel button on the Plan page or the link below. It works without logging in.',
  ], { label: 'Stop renewing (no login needed)', url: stopUrl(accountId) });
  return true;
}

// Records a paid top-up and adds its signatures. Safe to call twice for the same payment.
async function applyTopUp(s: any): Promise<boolean> {
  const a = s.client_reference_id ? get('SELECT * FROM accounts WHERE id=?', s.client_reference_id) : null;
  const cents = Number(s.amount_total) || 0;
  // Never trust the count alone: it can be no more than what was actually paid for.
  const credits = Math.min(Math.round(Number(s.metadata?.credits)) || 0, Math.floor(cents / (PRICING.topUpUsd * 100)));
  if (!a || s.metadata?.kind !== 'topup' || s.payment_status !== 'paid' || credits < 1) return false;
  const fresh = run("INSERT OR IGNORE INTO payments (id, account_id, amount_cents, currency, at, kind, credits, charge_id) VALUES (?,?,?,?,?,'topup',?,?)", s.id, a.id, cents, s.currency || 'usd', now(), credits, s.payment_intent || null).changes;
  if (!fresh) return false;
  grant(a.id, credits, 'topup', s.id);
  if (s.customer && !a.stripe_customer_id) run('UPDATE accounts SET stripe_customer_id=? WHERE id=?', s.customer, a.id);
  await mailAdmins(a.id, `Receipt: ${money(cents, s.currency)} for ${sigs(credits)}`, `${sigs(credits)} added. Thank you.`, [
    `${money(cents, s.currency)} for ${a.name}, paid today. You now have ${sigs(Math.max(0, available(a.id)))} to send.`,
    `That plants ${trees(cents)} with Treegens.`,
    `Signatures never expire. Any you have not used are refundable in full within ${refundDays()} days, from the Plan page.`,
  ], { label: 'Open the Plan page', url: `${baseUrl()}/app/settings?tab=billing` });
  return true;
}

// Coming back from checkout: apply the plan or the top-up now instead of waiting for the provider's event to arrive.
route('POST', '/billing/sync', async (c) => {
  const sessionId = str((await c.body()).session_id, 200);
  if (!billingEnabled() || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return billingState(c.account, c.user);
  const s = await stripe('GET', `checkout/sessions/${sessionId}`);
  if (s.client_reference_id === c.account.id) {
    if (s.mode === 'payment') await applyTopUp(s);
    else if (s.subscription && ['paid', 'no_payment_required'].includes(s.payment_status)) {
      await activate(c.account.id, s.customer, s.subscription);
      const sub = await stripe('GET', `subscriptions/${s.subscription}`).catch(() => null);
      if (sub) run('UPDATE accounts SET renews_at=? WHERE id=?', periodEnd(sub), c.account.id);
    }
  }
  return billingState(get('SELECT * FROM accounts WHERE id=?', c.account.id), c.user);
}, 'admin');

// The provider's own page, for changing the card or downloading invoices.
route('POST', '/billing/portal', async (c) => {
  if (!billingEnabled() || !c.account.stripe_customer_id) throw bad('There is no payment method on this account.');
  const s = await stripe('POST', 'billing_portal/sessions', { customer: c.account.stripe_customer_id, return_url: `${baseUrl()}/app/settings?tab=billing` });
  return { url: s.url };
}, 'admin');

route('POST', '/billing/cancel', (c) => cancelPlan(c.account, `in the app by ${c.user.name}`), 'admin');

route('POST', '/billing/resume', async (c) => {
  const a = c.account;
  if (!a.cancel_at || !a.stripe_subscription_id) throw bad('This plan is not set to end.');
  const sub = await stripe('POST', `subscriptions/${a.stripe_subscription_id}`, { cancel_at_period_end: 'false' });
  run('UPDATE accounts SET cancel_at=NULL, cancel_ref=NULL, renews_at=? WHERE id=?', periodEnd(sub) || a.renews_at, a.id);
  return billingState(get('SELECT * FROM accounts WHERE id=?', a.id), c.user);
}, 'admin');

// Self-serve refund of whatever has not been used from the latest payment. Refunding a plan payment also ends the plan.
route('POST', '/billing/refund', async (c) => {
  const a = c.account;
  const offer = refundOffer(a);
  if (!offer) throw bad(`Unused signatures from your latest payment are refunded automatically within ${refundDays()} days. There is nothing unused inside that window right now, but use the contact form and a person will look at it.`);
  const p = get('SELECT * FROM payments WHERE id=?', offer.payment_id);
  const reference = await refundPayment(a, p, offer.cents, offer.signatures, offer.reason);
  if (p.kind === 'plan') {
    if (a.stripe_subscription_id) await stripe('DELETE', `subscriptions/${a.stripe_subscription_id}`).catch(() => {});
    run("UPDATE accounts SET plan='seedling', subscription_status='canceled', cancel_at=NULL, renews_at=NULL WHERE id=?", a.id);
  }
  return { refunded: offer.amount, signatures: offer.signatures, reference, plan_ended: p.kind === 'plan' };
}, 'admin');

// Take the card off file. The plan is set to end first, so nothing can fail to renew by surprise.
route('POST', '/billing/remove-card', async (c) => {
  const a = c.account;
  if (!a.stripe_customer_id) throw bad('There is no card on this account.');
  if (a.plan === 'grove' && !a.cancel_at) await cancelPlan(a, `in the app by ${c.user.name}, with the card removed`);
  const pms = await stripe('GET', 'payment_methods', { customer: a.stripe_customer_id, type: 'card', limit: '20' });
  for (const pm of pms.data || []) await stripe('POST', `payment_methods/${pm.id}/detach`);
  return { removed: (pms.data || []).length };
}, 'admin');

// ---- Without logging in --------------------------------------------------------------------

route('GET', '/public/billing/stop', (c) => {
  const id = readStopToken(c.q.get('token'));
  const a = id && get('SELECT * FROM accounts WHERE id=?', id);
  if (!a) throw bad('This link has expired. Use "Find my subscription" below and we will email you a new one.', 410);
  return { account: a.name, plan: a.plan, price: PRICING.monthlyUsd, renews_at: a.cancel_at ? null : a.renews_at, ends_at: a.cancel_at, signatures_left: Math.max(0, available(a.id)) };
}, 'public');

route('POST', '/public/billing/stop', async (c) => {
  rateLimit(`stop:${c.ip}`, 20, 3600_000);
  const id = readStopToken((await c.body()).token);
  const a = id && get('SELECT * FROM accounts WHERE id=?', id);
  if (!a) throw bad('This link has expired. Use "Find my subscription" and we will email you a new one.', 410);
  return cancelPlan(a, 'from an email link');
}, 'public');

// "I am being charged and cannot find where": emails every paid account this address administers, each with a stop link.
route('POST', '/public/billing/find', async (c) => {
  rateLimit(`find:${c.ip}`, 10, 3600_000);
  const email = str((await c.body()).email, 254).trim().toLowerCase();
  if (!isEmail(email)) throw bad('Enter a valid email address.');
  rateLimit(`find:${email}`, 3, 3600_000);
  const rows = all("SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email=? AND m.role IN ('owner','admin') AND a.plan='grove' AND a.stripe_subscription_id IS NOT NULL", email);
  if (rows.length)
    await sendMail({
      to: email, subject: 'Your Sign&Grow subscriptions', heading: 'Your monthly plans',
      lines: ['You asked which paid plans are tied to this email address. Each link below stops that plan from renewing. No login needed.'],
      links: rows.map((a) => ({ label: `Stop renewal for ${a.name}`, url: stopUrl(a.id), note: a.cancel_at ? `already cancelled, ends ${day(a.cancel_at)}` : `${PLAN_PRICE()} a month${a.renews_at ? `, next charge ${day(a.renews_at)}` : ''}` })),
    });
  else
    await sendMail({ to: email, subject: 'Your Sign&Grow subscriptions', heading: 'No paid plans found', lines: ['There is no paid Sign&Grow plan tied to this email address, so we are not charging you.', 'If you see a charge from us anyway, it may be under a different address. Use the contact form with the date and amount and a person will trace it.'], cta: { label: 'Contact us', url: `${baseUrl()}/help` } });
  return { ok: true };
}, 'public');

// Locked out of the mailbox (old job, deleted address): prove you are the payer with the card instead.
route('POST', '/public/billing/stop-by-card', async (c) => {
  rateLimit(`card:${c.ip}`, 5, 3600_000);
  const b = await c.body();
  const email = str(b.email, 254).trim().toLowerCase();
  const last4 = str(b.last4, 4).replace(/\D/g, '');
  if (!isEmail(email) || last4.length !== 4) throw bad('Enter the account email address and the last four digits of the card being charged.');
  rateLimit(`card:${email}`, 5, 3600_000);
  if (!billingEnabled()) throw bad('Billing is not set up on this server.', 501);
  const rows = all("SELECT DISTINCT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email=? AND a.plan='grove' AND a.stripe_customer_id IS NOT NULL", email);
  for (const a of rows) {
    const pms = await stripe('GET', 'payment_methods', { customer: a.stripe_customer_id, type: 'card', limit: '20' }).catch(() => ({ data: [] }));
    if ((pms.data || []).some((pm: any) => pm.card?.last4 === last4)) {
      const r = await cancelPlan(a, 'by the card holder, without logging in');
      return { stopped: true, account: a.name, ...r };
    }
  }
  throw bad('Those details do not match a paid plan. Check the email address and card, or use the contact form and a person will help.', 404);
}, 'public');

// ---- Events from the payment provider ------------------------------------------------------

export function verifyStripeSignature(raw: string, header: string, secret: string, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) return false;
  return safeEqual(hmac(`${parts.t}.${raw}`, secret), parts.v1);
}

export async function applyStripeEvent(ev: any) {
  const o = ev?.data?.object || {};
  const byCustomer = () => (o.customer ? get('SELECT * FROM accounts WHERE stripe_customer_id=?', o.customer) : null);

  if (ev.type === 'checkout.session.completed' && o.client_reference_id) {
    if (o.mode === 'payment') await applyTopUp(o);
    else await activate(o.client_reference_id, o.customer, o.subscription);
    return;
  }

  // The monthly payment. Each one adds the plan's signatures to the balance.
  if (ev.type === 'invoice.paid' && o.amount_paid > 0) {
    const a = byCustomer();
    const fresh = run("INSERT OR IGNORE INTO payments (id, account_id, amount_cents, currency, at, receipt_url, kind, credits) VALUES (?,?,?,?,?,?,'plan',?)", o.id, a?.id ?? null, o.amount_paid, o.currency || 'usd', now(), o.hosted_invoice_url || o.invoice_pdf || null, PRICING.monthlySignatures).changes;
    if (!a && fresh && process.env.SUPPORT_EMAIL)
      await sendMail({ to: process.env.SUPPORT_EMAIL, subject: 'A payment could not be matched to an account', heading: 'Unmatched payment', lines: [`Invoice ${o.id}, ${money(o.amount_paid, o.currency)}, customer ${o.customer}. Nobody got signatures for this money. Find the payer and either add their signatures or refund it.`] });
    if (!a || !fresh) return;
    const next = iso(o.lines?.data?.[0]?.period?.end);
    // Safety net for "charged after I cancelled": if the plan had already ended, the money goes straight back.
    if (a.plan !== 'grove' || (a.cancel_at && Date.parse(a.cancel_at) < Date.now() - 3600_000)) {
      await refundPayment(a, get('SELECT * FROM payments WHERE id=?', o.id), o.amount_paid, 0, 'this plan was already cancelled').catch((e) => console.error('[billing] automatic refund failed', a.id, e?.message));
      return;
    }
    grant(a.id, PRICING.monthlySignatures, 'plan', o.id);
    if (next) run('UPDATE accounts SET renews_at=? WHERE id=?', next, a.id);
    await mailAdmins(a.id, `Receipt: ${money(o.amount_paid, o.currency)} for ${sigs(PRICING.monthlySignatures)}`, 'Payment received. Thank you.', [
      `${money(o.amount_paid, o.currency)} for ${a.name}, charged today. ${sigs(PRICING.monthlySignatures)} added: you now have ${sigs(Math.max(0, available(a.id)))} to send.`,
      `That plants ${trees(o.amount_paid)} with Treegens.`,
      ...(next && !a.cancel_at ? [`Next charge: ${PLAN_PRICE()} on ${day(next)}. We will remind you before then.`] : []),
      `Not what you wanted? Unused signatures from this payment are refunded in full within ${refundDays()} days, from the Plan page.`,
    ], o.hosted_invoice_url ? { label: 'View invoice', url: o.hosted_invoice_url } : { label: 'Open the Plan page', url: `${baseUrl()}/app/settings?tab=billing` });
    return;
  }

  // Sent by the provider a few days before each renewal. Says exactly what will be charged and when.
  if (ev.type === 'invoice.upcoming') {
    const a = byCustomer();
    if (!a || a.plan !== 'grove' || a.cancel_at) return;
    const when = iso(o.next_payment_attempt || o.period_end);
    // Nobody should be charged for something they stopped using. After a long quiet spell the renewal is stopped for
    // them, with one click to keep it. Set DORMANT_AUTO_STOP_DAYS=0 to only warn instead.
    const stopAfter = dormantStopDays();
    if (stopAfter > 0 && Date.parse(a.created_at) < Date.now() - stopAfter * 864e5
      && get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at > ?", a.id, new Date(Date.now() - stopAfter * 864e5).toISOString()).n === 0) {
      const r = await cancelPlan(a, `automatically, because nothing was sent in ${stopAfter} days`, true);
      await mailAdmins(a.id, 'We stopped your renewal so you are not charged for nothing', `You will not be charged on ${day(when)}`, [
        `${a.name} has not sent anything in ${stopAfter} days, so we turned the renewal off rather than charge you again. Reference ${r.reference}.`,
        `You keep the ${sigs(Math.max(0, available(a.id)))} you already have. They never expire.`,
        'If you want to keep the monthly plan (thank you: every dollar plants mangroves), one click on the Plan page turns it back on.',
      ], { label: 'Keep my plan', url: `${baseUrl()}/app/settings?tab=billing` });
      return;
    }
    const left = Math.max(0, available(a.id));
    const amount = money(o.amount_due ?? PRICING.monthlyUsd * 100, o.currency);
    await mailAdmins(a.id, `Heads up: your plan renews on ${day(when)} for ${amount}`, 'Your plan renews soon', [
      `On ${day(when)} we will charge ${amount} for ${a.name} and add ${sigs(PRICING.monthlySignatures)}. That is the full amount: there are no extras.`,
      `You have ${sigs(left)} left at the moment. They roll over either way.`,
      'To keep planting mangroves, do nothing. To stop, use the link below. It takes one click and needs no login.',
    ], { label: 'Do not renew', url: stopUrl(a.id) });
    return;
  }

  if (ev.type === 'invoice.payment_failed') {
    const a = byCustomer();
    if (a) await mailAdmins(a.id, 'Your monthly payment did not go through', 'A payment failed', [
      'Nothing is locked and nothing is deleted. If the payment keeps failing, the monthly plan simply ends. Every document stays available, and the signatures you already have stay yours.',
      'To keep the plan, update the card on the Plan page.',
    ], { label: 'Open the Plan page', url: `${baseUrl()}/app/settings?tab=billing` });
    return;
  }

  if (ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted') {
    const ended = ev.type === 'customer.subscription.deleted';
    const live = !ended && ['active', 'trialing', 'past_due'].includes(o.status);
    const a = byCustomer();
    if (!a) return;
    if (a.promo_code) {
      // The plan is free through a code. The old paid subscription winding down changes nothing for them.
      if (!live) run('UPDATE accounts SET stripe_subscription_id=NULL, cancel_at=NULL, renews_at=NULL WHERE id=?', a.id);
      return;
    }
    const end = periodEnd(o);
    run('UPDATE accounts SET plan=?, subscription_status=?, renews_at=?, cancel_at=? WHERE id=?', live ? 'grove' : 'seedling', ended ? 'canceled' : o.status,
      live ? end : null, live && o.cancel_at_period_end ? end || a.cancel_at : null, a.id);
    if (!live && a.plan === 'grove')
      await mailAdmins(a.id, 'Your monthly plan has ended', 'Your plan has ended', ['You will not be charged again. Nothing was deleted: every document, audit trail and receipt is still in your account.', `You still have ${sigs(Math.max(0, available(a.id)))}. They never expire, and signing your own documents is always free. Come back to the monthly plan whenever you like.`]);
    return;
  }

  if (ev.type === 'charge.refunded') {
    // A refund made outside the app (for example by a person in the provider's dashboard) is recorded too.
    const a = byCustomer();
    const p = a && get('SELECT * FROM payments WHERE account_id=? AND amount_cents=? AND refunded_cents < ? ORDER BY at DESC, rowid DESC LIMIT 1', a.id, o.amount, o.amount_refunded ?? o.amount);
    if (p) run('UPDATE payments SET refunded_at=COALESCE(refunded_at, ?), refunded_cents=? WHERE id=?', now(), o.amount_refunded ?? o.amount, p.id);
    return;
  }

  // A card dispute means the customer wants out. Stop all further billing at once instead of fighting over it.
  if (ev.type === 'charge.dispute.created') {
    const charge = o.charge && billingEnabled() ? await stripe('GET', `charges/${o.charge}`).catch(() => null) : null;
    const a = charge?.customer ? get('SELECT * FROM accounts WHERE stripe_customer_id=?', charge.customer) : null;
    if (!a) return;
    if (a.stripe_subscription_id) await stripe('DELETE', `subscriptions/${a.stripe_subscription_id}`).catch(() => {});
    run("UPDATE accounts SET plan='seedling', subscription_status='canceled', cancel_at=NULL, renews_at=NULL WHERE id=?", a.id);
    if (process.env.SUPPORT_EMAIL) await sendMail({ to: process.env.SUPPORT_EMAIL, subject: `Card dispute: ${a.name}`, heading: 'A charge was disputed', lines: [`Account ${a.name} (${a.id}). Billing has been stopped automatically. Accept the dispute with the payment provider so the bank releases the money, and write to the customer to confirm.`] });
  }
}

route('POST', '/stripe/webhook', async (c) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(501, 'Billing is not set up.');
  const raw = await c.req.text();
  if (!verifyStripeSignature(raw, c.req.headers.get('stripe-signature') || '', secret)) throw new HttpError(400, 'Bad signature.');
  await applyStripeEvent(JSON.parse(raw));
  return { received: true };
}, 'public');

// Once every two months at most: tell people who pay but do not send, so nobody funds a forgotten plan by accident.
export async function dormancyNudges(): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString();
  const rows = all("SELECT * FROM accounts WHERE plan='grove' AND promo_code IS NULL AND cancel_at IS NULL AND (dormant_nudged_at IS NULL OR dormant_nudged_at < ?) AND created_at < ?", cutoff, cutoff)
    .filter((a) => get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at > ?", a.id, cutoff).n === 0);
  for (const a of rows) {
    run('UPDATE accounts SET dormant_nudged_at=? WHERE id=?', now(), a.id);
    await mailAdmins(a.id, 'Still using Sign&Grow?', 'You are on the monthly plan but have not sent anything in 60 days', [
      `${a.name} pays ${PLAN_PRICE()} a month and has ${sigs(Math.max(0, available(a.id)))} saved up. Every dollar plants mangroves, and we are grateful. But we would rather you paid on purpose.`,
      'If you are not using it, stop the renewal with the link below. You keep every document and every signature you have already paid for.',
    ], { label: 'Stop renewing (no login needed)', url: stopUrl(a.id) });
  }
  return rows.length;
}
