import { route } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, hmac, now, id, isEmail, str, rateLimit, baseUrl, safeEqual, HttpError } from './util.ts';
import { sendMail } from './mail.ts';
import { billingEnabled } from './envelopes.ts';
import { grant, creditSummary, available, findFreeCode } from './credits.ts';
import { PRICING, mangrovesFor } from '../lib/impact.ts';
import { refundDays, dormantStopDays, refundRuleText, newAccountDailyRecipients } from '../lib/policy.ts';

export { refundDays, dormantStopDays };

// How Sign&Grow charges:
//   - $9 a month adds 9 signatures to the balance. Extra signatures are $1 each. Every dollar plants 10 mangroves.
//   - Signatures never expire. One is used only when somebody actually signs.
//   - Month to month. No annual term, no notice period, and nothing is ever charged without an explicit choice.
// And the things people most often say went wrong elsewhere, handled in code rather than in a policy page:
//   - Cancelling is one button. It also works from an email link without logging in, and by card for people locked out.
//   - Every charge is announced a week before and the day before, and receipted after. The amount shown is the amount
//     charged; if more is taken than the reminder said, the difference goes back by itself.
//   - Unused signatures are refunded automatically on request within the refund window. Nobody has to argue for it.
//   - A charge that arrives after cancellation, on a free plan, or twice, is refunded by the software itself. If the
//     payment provider is down at that moment it is tried again on the timer until it goes through.
//   - Stopping payment never deletes or locks anything, and signatures already paid for stay usable.
//   - The payment provider does not promise the order of its messages, so nothing here depends on it.

const money = (cents: number, currency = 'usd') => new Intl.NumberFormat('en', { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(cents / 100);
const iso = (unix?: number | null) => (unix ? new Date(unix * 1000).toISOString() : null);
const sid = (x: any): string | null => (typeof x === 'string' ? x : x?.id || null);
const sigs = (n: number) => `${n} signature${n === 1 ? '' : 's'}`;
const PLAN_CENTS = () => PRICING.monthlyUsd * 100;
const PLAN_PRICE = () => money(PLAN_CENTS());
const trees = (cents: number) => `${mangrovesFor(cents / 100).toLocaleString('en')} mangrove trees`;
const planUrl = () => `${baseUrl()}/app/settings?tab=billing`;

// Dates in emails are written in each reader's own time zone, the same one the Plan page uses in their browser, so
// the email and the page never show different days. day() leaves a marker; dated() fills it in per reader.
const day = (isoDate?: string | null) => (isoDate ? `⦃${isoDate}⦄` : '');
function fmtDay(isoDate: string, tz?: string | null): string {
  const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };
  try {
    if (tz) return new Date(isoDate).toLocaleDateString('en', { ...o, timeZone: tz });
  } catch {}
  return `${new Date(isoDate).toLocaleDateString('en', { ...o, timeZone: 'UTC' })} (UTC)`;
}
const dated = (s: string, tz?: string | null) => s.replace(/⦃([^⦄]+)⦄/g, (_, d) => fmtDay(d, tz));

async function stripe(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string> = {}, idempotencyKey?: string): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1/${path}${method === 'GET' && qs ? `?${qs}` : ''}`, {
    method,
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    body: method === 'POST' ? qs : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw bad(data?.error?.message || 'The payment provider returned an error.', 502);
  return data;
}

// Stripe moved the period end from the subscription to its items in newer API versions. Read either.
const periodEnd = (sub: any): string | null => iso(sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end);
// The same goes for where an invoice names its subscription, the account it was started for, and its charge.
const subOf = (o: any): string | null => sid(o.subscription) || sid(o.parent?.subscription_details?.subscription) || sid(o.lines?.data?.[0]?.subscription) || sid(o.lines?.data?.[0]?.parent?.subscription_item_details?.subscription);
const namedAccount = (o: any): string | null => o.subscription_details?.metadata?.account_id || o.parent?.subscription_details?.metadata?.account_id || o.lines?.data?.[0]?.metadata?.account_id || o.metadata?.account_id || null;
const chargeOf = (o: any): string | null => sid(o.charge) || sid(o.payment_intent) || sid(o.payments?.data?.[0]?.payment?.payment_intent) || sid(o.payments?.data?.[0]?.payment?.charge);

// A subscription the provider is charging, or will try to charge again.
const LIVE = ['active', 'trialing', 'past_due'];
// Is there something at the payment provider that could still take money for this account's plan?
const hasSub = (a: any) => !!a?.stripe_subscription_id && !a.promo_code && !['canceled', 'incomplete_expired', 'free'].includes(a.subscription_status || '');
const renewing = (a: any) => hasSub(a) && !a.cancel_at;

// A line in the account's plan history: what happened, when, and its reference. Kept for as long as the account
// exists, so "I cancelled in March, here is the number" can always be checked.
const log = (accountId: string, what: string, detail = '', ref = '') => run('INSERT INTO billing_log (account_id, at, what, ref, detail) VALUES (?,?,?,?,?)', accountId, now(), what, ref, detail);
const HISTORY_LABEL: Record<string, string> = {
  started: 'Monthly plan started', cancelled: 'Cancelled', resumed: 'Cancellation undone', ended: 'Monthly plan ended', refund: 'Refund sent', code: 'Free code applied',
  'code-ended': 'Free code ended', reminder: 'Renewal reminder sent', 'auto-stop': 'Renewal stopped for you', dispute: 'Card dispute', 'card-removed': 'Card removed', paused: 'Payment failed',
};

type Cta = { label: string; url: string };
const admins = (accountId: string) => all("SELECT u.id, u.email, u.name, u.tz FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", accountId);

// Every email about money goes to all owners and admins, and carries the way out for as long as there is a renewal
// to stop: a link that turns it off without logging in.
async function mailAdmins(accountId: string, subject: string, heading: string, lines: string[], cta?: Cta | 'stop') {
  const a = get('SELECT * FROM accounts WHERE id=?', accountId);
  for (const u of admins(accountId)) {
    const stop = { label: 'Stop renewing (no login needed)', url: stopUrl(accountId, u.id) };
    await sendMail({
      to: u.email, subject: dated(subject, u.tz), heading: dated(heading, u.tz), lines: lines.map((l) => dated(l, u.tz)),
      cta: cta === 'stop' ? stop : cta,
      links: cta !== 'stop' && a && renewing(a) ? [{ label: 'Do not renew', url: stop.url, note: 'Stops the monthly plan in one click, without logging in.' }] : undefined,
    });
  }
}

// Things only a person can sort out. They go to the support address and to every operator, and into the operator
// queue in the app, so they are seen even when no address has been configured.
async function tellOperators(subject: string, lines: string[], accountId?: string | null) {
  const to = [...new Set([process.env.SUPPORT_EMAIL || '', ...(process.env.OPERATOR_EMAILS || '').split(',')].map((s) => s.trim().toLowerCase()).filter(isEmail))];
  run("INSERT INTO support_requests (id, email, name, topic, message, account_id, status, at) VALUES (?,?,?,'billing',?,?,'open',?)",
    id('sup'), to[0] || 'billing-alert@localhost', 'Sign&Grow (automatic alert)', `${subject}\n\n${lines.join('\n')}`.slice(0, 5000), accountId ?? null, now());
  for (const t of to) await sendMail({ to: t, subject, heading: subject, lines, cta: { label: 'Open the queue', url: `${baseUrl()}/app/operator` } });
  if (!to.length) console.error('[billing] needs a person:', subject, lines.join(' '));
}

// Links that stop a renewal without logging in. Signed, tied to one admin of one account, valid for 120 days, and
// dead as soon as that person is no longer an admin of the account.
export function stopToken(accountId: string, userId: string, days = 120): string {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  return `${accountId}.${userId}.${exp}.${hmac(`stop:${accountId}:${userId}:${exp}`).slice(0, 32)}`;
}
export function readStopToken(tok: any): string | null {
  const [accountId, userId, exp, sig] = String(tok ?? '').split('.');
  if (!accountId || !userId || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  if (!safeEqual(sig, hmac(`stop:${accountId}:${userId}:${exp}`).slice(0, 32))) return null;
  return get("SELECT 1 x FROM memberships WHERE account_id=? AND user_id=? AND role IN ('owner','admin')", accountId, userId) ? accountId : null;
}
const stopUrl = (accountId: string, userId: string) => `${baseUrl()}/billing/stop?token=${stopToken(accountId, userId)}`;

// ---- Refunds ---------------------------------------------------------------------------------

type Offer = { payment_id: string; cents: number; amount: string; signatures: number; of: number; kind: string; reason: string; paid_at: string };

// The refund rule, in one place: within the window, every signature a payment bought that has not been used is
// refunded at the price paid for it. Nobody needs to approve it. One self-serve refund per payment.
function offerFor(account: any, p: any): Offer | null {
  if (!p || p.account_id !== account.id || !p.credits || p.self_refund_at || p.refunded_cents >= p.amount_cents) return null;
  if (p.refund_pending_at && Date.parse(p.refund_pending_at) > Date.now() - 10 * 60_000) return null;
  if ((Date.now() - Date.parse(p.at)) / 864e5 > refundDays()) return null;
  const unused = Math.min(p.credits, Math.max(0, available(account.id)));
  if (unused <= 0) return null;
  const cents = Math.round(((p.amount_cents - p.refunded_cents) / p.credits) * unused);
  if (cents <= 0) return null;
  return {
    payment_id: p.id, cents, amount: money(cents, p.currency), signatures: unused, of: p.credits, kind: p.kind, paid_at: p.at,
    reason: unused === p.credits ? `none of its ${sigs(p.credits)} have been used` : `${unused} of its ${sigs(p.credits)} have not been used`,
  };
}
// What the Plan page offers up front: the latest payment. Earlier ones inside the window are offered next to each
// payment in the list, and are refunded only when that payment is named.
export function refundOffer(account: any): Offer | null {
  return offerFor(account, get('SELECT * FROM payments WHERE account_id=? ORDER BY at DESC, rowid DESC LIMIT 1', account.id));
}

// Finds the card charge behind a payment. Top-ups know theirs; a monthly payment may only know its invoice.
async function chargeTarget(customer: string | null, p: any): Promise<Record<string, string>> {
  if (String(p.charge_id || '').startsWith('pi_')) return { payment_intent: p.charge_id };
  if (String(p.charge_id || '').startsWith('ch_')) return { charge: p.charge_id };
  const charges = customer ? await stripe('GET', 'charges', { customer, limit: '20' }) : { data: [] };
  const charge = (charges.data || []).find((c: any) => c.paid && !c.refunded && c.amount === p.amount_cents && (!c.invoice || sid(c.invoice) === p.id));
  if (!charge) throw bad('We could not find that charge automatically. Use the contact form and a person will refund it by hand.', 502);
  run('UPDATE payments SET charge_id=? WHERE id=?', charge.id, p.id);
  return { charge: charge.id };
}

// Sends money back to where it came from and records it. `cents` may be part of the payment. The provider is given a
// key for this exact refund, so a retry after a timeout can never pay out twice.
async function refundPayment(account: any | null, p: any, cents: number, why: string): Promise<string> {
  const target = await chargeTarget(account?.stripe_customer_id || p.customer_id || null, p);
  const refund = await stripe('POST', 'refunds', { ...target, amount: String(cents) }, `sg-refund-${p.id}-${p.refunded_cents || 0}-${cents}`);
  run('UPDATE payments SET refunded_at=?, refunded_cents=MIN(amount_cents, refunded_cents+?) WHERE id=?', now(), cents, p.id);
  if (account) {
    log(account.id, 'refund', `${money(cents, p.currency)}: ${why}`, refund.id);
    await mailAdmins(account.id, `Refund sent: ${money(cents, p.currency)}`, 'Your refund is on its way', [
      `We refunded ${money(cents, p.currency)} to the card it was paid with (${why}).`,
      `Refund reference: ${refund.id}. Banks usually show it within 5 to 10 working days.`,
    ]);
  }
  return refund.id;
}

// A refund the software owes without being asked (charged after cancelling, charged twice, charged on a free plan).
// If the provider cannot take it right now it is queued and tried again on the timer; a person is told if it keeps
// failing. It is never just written to a log and forgotten.
async function owe(account: any | null, p: any, cents: number, why: string) {
  try {
    await refundPayment(account, p, cents, why);
  } catch (e: any) {
    run("INSERT OR IGNORE INTO billing_todo (kind, ref, account_id, detail, at) VALUES ('refund',?,?,?,?)", p.id, account?.id ?? null, JSON.stringify({ cents, why }), now());
    console.error('[billing] automatic refund queued for retry', p.id, e?.message);
  }
}

// Ends a subscription at the provider now. True only when the provider confirms it is gone (or already was).
async function endSubscription(subId: string, voidOpenInvoice = false): Promise<boolean> {
  try {
    const sub = await stripe('DELETE', `subscriptions/${subId}`);
    if (voidOpenInvoice && sid(sub?.latest_invoice)) {
      // A payment that was failing must not be retried after the customer said stop.
      const inv = await stripe('GET', `invoices/${sid(sub.latest_invoice)}`).catch(() => null);
      if (inv?.status === 'open') await stripe('POST', `invoices/${inv.id}/void`).catch(() => {});
    }
    return true;
  } catch (e: any) {
    if (/no such subscription/i.test(e?.message || '')) return true;
    const sub = await stripe('GET', `subscriptions/${subId}`).catch(() => null);
    return sub?.status === 'canceled' || sub?.status === 'incomplete_expired';
  }
}
// For the places where the end must happen whatever the provider answers right now.
async function endOrQueue(subId: string | null, accountId?: string | null): Promise<boolean> {
  if (!subId) return true;
  if (await endSubscription(subId)) return true;
  run("INSERT OR IGNORE INTO billing_todo (kind, ref, account_id, detail, at) VALUES ('cancel',?,?,'',?)", subId, accountId ?? null, now());
  return false;
}
// Used when an account is closed: nothing may be charged afterwards.
export const stopBillingFor = (account: any) => (hasSub(account) && billingEnabled() ? endOrQueue(account.stripe_subscription_id, account.id) : Promise.resolve(true));

// ---- What the Plan page shows ----------------------------------------------------------------

const LEDGER_LABEL: Record<string, string> = { welcome: 'Welcome signatures', plan: 'Monthly plan', code: 'Monthly plan, free with your code', topup: 'Top-up', signature: 'Signature used', refund: 'Refund', adjust: 'Adjustment' };

export function billingState(account: any, user?: any) {
  const enabled = billingEnabled();
  const paid = get('SELECT COALESCE(SUM(amount_cents - refunded_cents),0) cents FROM payments WHERE account_id=?', account.id).cents;
  const unpaid = account.plan === 'seedling' || !!account.promo_code;
  const firstWeek = unpaid && !account.trusted_at && Date.now() - Date.parse(account.created_at) < 7 * 864e5;
  const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString();
  return {
    enabled,
    plan: account.plan,
    status: account.subscription_status,
    price: PRICING.monthlyUsd,
    pricing: PRICING,
    // Set when the plan is free through a code: nothing is charged, so there is nothing to renew or to end.
    free_with: account.promo_code || null,
    free_next_at: account.promo_code ? nextMonth : null,
    renews_at: account.plan === 'grove' && renewing(account) ? account.renews_at : null,
    // What the next charge will really be: the amount the provider quoted for it if we know it, else the plan price.
    next_amount: money(account.renewal_quoted_cents && account.renewal_reminded?.startsWith((account.renews_at || '').slice(0, 10)) ? account.renewal_quoted_cents : PLAN_CENTS()),
    ends_at: account.plan === 'grove' && !account.promo_code ? account.cancel_at : null,
    cancel_ref: account.cancel_ref || null,
    // A payment that did not go through. Nothing is locked; the page says what to do.
    problem: hasSub(account) && ['past_due', 'unpaid', 'incomplete', 'paused'].includes(account.subscription_status) ? account.subscription_status : null,
    can_cancel: renewing(account) || (hasSub(account) && account.plan !== 'grove'),
    has_customer: !!account.stripe_customer_id,
    // What can be sent right now: the balance, minus signatures held for people who have been asked and not signed yet.
    signatures: enabled ? creditSummary(account.id) : null,
    mangroves: mangrovesFor(paid / 100),
    refund: enabled ? refundOffer(account) : null,
    refund_days: refundDays(),
    refund_rule: refundRuleText(refundDays()),
    dormant_stop_days: dormantStopDays(),
    // Limits, as numbers, before anybody runs into them.
    limits: { first_week_daily: firstWeek ? newAccountDailyRecipients() : null, new_account_daily: newAccountDailyRecipients(), top_up_max: PRICING.topUpMax, bulk_rows: 500 },
    // Other paid plans this person already manages, so nobody pays twice without noticing.
    other_paid: user ? all("SELECT a.name FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role IN ('owner','admin') AND a.plan='grove' AND a.promo_code IS NULL AND a.id!=?", user.id, account.id).map((r) => r.name) : [],
    payments: all('SELECT * FROM payments WHERE account_id=? ORDER BY at DESC, rowid DESC LIMIT 60', account.id)
      .map((p) => ({
        id: p.id, amount_cents: p.amount_cents, currency: p.currency, at: p.at, receipt_url: p.receipt_url, refunded_at: p.refunded_at, refunded_cents: p.refunded_cents, kind: p.kind, credits: p.credits,
        amount: money(p.amount_cents, p.currency), refunded: p.refunded_cents ? money(p.refunded_cents, p.currency) : null, refundable: enabled ? offerFor(account, p) : null,
      })),
    ledger: all('SELECT delta, reason, at FROM credits WHERE account_id=? ORDER BY id DESC LIMIT 40', account.id).map((l) => ({ ...l, label: LEDGER_LABEL[l.reason] || l.reason })),
    history: all('SELECT at, what, ref, detail FROM billing_log WHERE account_id=? ORDER BY id DESC LIMIT 40', account.id).map((h) => ({ ...h, label: HISTORY_LABEL[h.what] || h.what })),
  };
}

// ---- Cancelling ------------------------------------------------------------------------------

// One state change with the payment provider, a reference number, and an email that says when billing stops. The
// answer is only "cancelled" once the provider has confirmed it; if the provider fails, so does this, out loud.
export async function cancelPlan(account: any, by: string, quiet = false): Promise<{ ends_at: string; reference: string; ended_now: boolean }> {
  if (!hasSub(account)) throw bad(account.promo_code ? `This plan is free with the code ${account.promo_code}. Nothing is charged for it, so there is nothing to cancel.` : 'There is no monthly plan on this account, so there is nothing to cancel and nothing will be charged.');
  if (account.cancel_at && account.plan === 'grove') return { ends_at: account.cancel_at, reference: account.cancel_ref || '', ended_now: false };
  const reference = `SG-${account.id.slice(-5).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  let sub: any;
  try {
    sub = await stripe('POST', `subscriptions/${account.stripe_subscription_id}`, { cancel_at_period_end: 'true' });
  } catch (e: any) {
    // Already gone at the provider: then it is cancelled, and we say so instead of failing.
    if (!/no such subscription/i.test(e?.message || '') && (await stripe('GET', `subscriptions/${account.stripe_subscription_id}`).catch(() => null))?.status !== 'canceled') throw e;
    sub = { status: 'canceled' };
  }
  // Paid up: the plan runs to the end of the month that is paid for. Not paid up (the last payment failed, or never
  // went through): there is no paid month, so it ends today and the failed payment is not tried again.
  const paidUp = sub.status === 'active' || sub.status === 'trialing';
  if (!paidUp) {
    if (sub.status !== 'canceled' && !(await endSubscription(account.stripe_subscription_id, true)))
      throw bad('The payment provider did not confirm the cancellation just now, so we cannot tell you it is done. Nothing changed. Please try again in a minute, or use the contact form and a person will do it.', 502);
    run("UPDATE accounts SET plan='seedling', subscription_status='canceled', cancel_at=NULL, cancel_ref=?, renews_at=NULL WHERE id=?", reference, account.id);
    log(account.id, 'cancelled', `Cancelled ${by}. Ended at once because the last payment had not gone through.`, reference);
    if (!quiet)
      await mailAdmins(account.id, `Your ${PRICING.planName} plan is cancelled`, 'Cancelled. You will not be charged again.', [
        `Cancellation reference: ${reference}. Cancelled ${by}.`,
        'The last payment had not gone through, so the plan ends today and that payment will not be tried again.',
        `Your signatures stay yours: the ${sigs(Math.max(0, available(account.id)))} you have left never expire, and signing your own documents is always free.`,
        'Nothing is deleted. Every document, audit trail and receipt stays available to you for as long as the account exists.',
        'If a charge ever appears after today, we refund it automatically.',
      ], { label: 'Open the Plan page', url: planUrl() });
    return { ends_at: now(), reference, ended_now: true };
  }
  const ends = periodEnd(sub) || account.renews_at || now();
  run('UPDATE accounts SET cancel_at=?, cancel_ref=? WHERE id=?', ends, reference, account.id);
  log(account.id, quiet ? 'auto-stop' : 'cancelled', `Cancelled ${by}. Runs until ${ends.slice(0, 10)}.`, reference);
  if (quiet) return { ends_at: ends, reference, ended_now: false };
  const left = Math.max(0, available(account.id));
  await mailAdmins(account.id, `Your ${PRICING.planName} plan is cancelled`, 'Cancelled. You will not be charged again.', [
    `Cancellation reference: ${reference}. Cancelled ${by}.`,
    `The plan runs until ${day(ends)}, because that month is already paid for. No more payments are taken after that.`,
    `Your signatures stay yours: the ${sigs(left)} you have left never expire, and signing your own documents is always free.`,
    'Nothing is deleted. Every document, audit trail and receipt stays available to you for as long as the account exists.',
    'If a charge ever appears after this date, we refund it automatically.',
  ], { label: 'Changed your mind? Resume', url: planUrl() });
  return { ends_at: ends, reference, ended_now: false };
}

route('GET', '/billing', (c) => billingState(c.account, c.user));

// ---- The free code ---------------------------------------------------------------------------

// A code that makes the monthly plan free. The plan's signatures arrive every month and nothing is ever charged for
// it. Someone who was paying stops paying today: their subscription is ended at the provider before the code counts.
export async function redeemCode(accountId: string, typed: any): Promise<string> {
  const code = findFreeCode(typed);
  if (!code) throw bad('We do not recognise that code. Check the spelling and try again.');
  const a = get('SELECT * FROM accounts WHERE id=?', accountId);
  if (a.promo_code === code) return code;
  const wasPaying = hasSub(a) && billingEnabled();
  let reference = '';
  if (wasPaying) {
    if (!(await endSubscription(a.stripe_subscription_id, true)))
      throw bad('We could not stop your paid plan with the payment provider just now, so the code was not applied and nothing changed. Please try again in a minute.', 502);
    reference = `SG-${a.id.slice(-5).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    log(a.id, 'cancelled', `Paid subscription ended because the code ${code} made the plan free.`, reference);
  }
  run("UPDATE accounts SET promo_code=?, promo_at=?, plan='grove', subscription_status='free', cancel_at=NULL, renews_at=NULL, cancel_ref=COALESCE(?, cancel_ref) WHERE id=?", code, now(), reference || null, a.id);
  log(a.id, 'code', `Code ${code}: the monthly plan is free.`);
  await mailAdmins(a.id, `Code ${code} accepted: your plan is free`, 'Your monthly plan is free', [
    `${a.name} is on the monthly plan at no charge with the code ${code}. ${sigs(PRICING.monthlySignatures)} are added to your balance at the start of every month, and what you do not use rolls over.`,
    ...(wasPaying ? [
      `Your paid subscription ended today and will not be charged again. Cancellation reference: ${reference}.`,
      `The signatures you already paid for stay yours. ${refundRuleText(refundDays())}`,
      'The card you paid with is still saved in case you top up. You can remove it on the Plan page.',
    ] : []),
    `Nothing is charged for the plan, so there is nothing to cancel. If you need more in a busy month you can top up at ${money(PRICING.topUpUsd * 100)} a signature, and every dollar plants ${PRICING.treesPerUsd} mangrove trees.`,
  ], { label: 'Open the Plan page', url: planUrl() });
  return code;
}

route('POST', '/billing/redeem', async (c) => {
  rateLimit(`redeem:${c.ip}`, 20, 3600_000);
  await redeemCode(c.account.id, (await c.body()).code);
  return billingState(get('SELECT * FROM accounts WHERE id=?', c.account.id), c.user);
}, 'admin');

// When a code is switched off (taken out of FREE_PLAN_CODES), the plans it made free end, and the people on it are
// told. They keep every signature they have.
export async function endRemovedCodes(): Promise<number> {
  const rows = all('SELECT * FROM accounts WHERE promo_code IS NOT NULL').filter((a) => !findFreeCode(a.promo_code));
  for (const a of rows) {
    run("UPDATE accounts SET promo_code=NULL, promo_at=NULL, plan='seedling', subscription_status=NULL WHERE id=?", a.id);
    log(a.id, 'code-ended', `The code ${a.promo_code} is no longer active.`);
    await mailAdmins(a.id, `The code ${a.promo_code} has ended`, 'Your free monthly plan has ended', [
      `The code ${a.promo_code} is no longer active, so ${a.name} no longer gets ${sigs(PRICING.monthlySignatures)} a month for free. Nothing was charged and nothing will be.`,
      `You keep the ${sigs(Math.max(0, available(a.id)))} you have. They never expire, and signing your own documents is always free.`,
      `To keep getting ${sigs(PRICING.monthlySignatures)} a month you can start the monthly plan for ${PLAN_PRICE()}. Every dollar plants ${PRICING.treesPerUsd} mangrove trees.`,
    ], { label: 'Open the Plan page', url: planUrl() });
  }
  return rows.length;
}

// ---- Paying ----------------------------------------------------------------------------------

route('POST', '/billing/checkout', async (c) => {
  if (!billingEnabled() || !process.env.STRIPE_PRICE_GROVE) throw bad('Billing is not set up on this server yet.', 501);
  const a = c.account;
  if (a.promo_code) throw bad(`Your plan is already free with the code ${a.promo_code}. There is nothing to pay.`);
  if (a.plan === 'grove' && renewing(a)) throw bad(`This account is already on the ${PRICING.planName} plan.`);
  // Cancelled but still running: paying again would start a second subscription next to the first.
  if (a.plan === 'grove' && hasSub(a) && a.cancel_at) throw bad('Your plan is cancelled but still running, so there is nothing to pay for yet. Press "Keep the plan after all" on the Plan page and it simply continues, with no new payment today.');
  if (hasSub(a) && a.plan !== 'grove') throw bad('The last payment for this plan did not go through. Update the card with "Invoices and card" on the Plan page, or cancel the plan first and start again.');
  const s = await stripe('POST', 'checkout/sessions', {
    mode: 'subscription', 'line_items[0][price]': process.env.STRIPE_PRICE_GROVE, 'line_items[0][quantity]': '1',
    client_reference_id: a.id, 'metadata[account_id]': a.id,
    // The subscription carries the account it is for, so its payments find their way home in whatever order the
    // provider reports them.
    'subscription_data[metadata][account_id]': a.id, 'subscription_data[description]': `Sign&Grow monthly plan for ${a.name} (${a.id})`,
    // The commitment, in plain words, on the payment page itself.
    'custom_text[submit][message]': `${PLAN_PRICE()} today, then ${PLAN_PRICE()} every month until you cancel. Each payment adds ${sigs(PRICING.monthlySignatures)}. No contract and no notice period: cancel in one click. ${refundRuleText(refundDays())}`,
    success_url: `${baseUrl()}/app/settings?tab=billing&upgraded=1&session_id={CHECKOUT_SESSION_ID}`, cancel_url: planUrl(),
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
  const total = money(quantity * PRICING.topUpUsd * 100);
  const s = await stripe('POST', 'checkout/sessions', {
    mode: 'payment', 'line_items[0][quantity]': String(quantity),
    'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(PRICING.topUpUsd * 100),
    'line_items[0][price_data][product_data][name]': `Sign&Grow signature (plants ${PRICING.treesPerUsd} mangrove trees)`,
    'metadata[kind]': 'topup', 'metadata[credits]': String(quantity), 'metadata[account_id]': a.id,
    'payment_intent_data[description]': `Sign&Grow top-up: ${sigs(quantity)} for ${a.name} (${a.id})`, 'payment_intent_data[metadata][account_id]': a.id,
    'invoice_creation[enabled]': 'true',
    'custom_text[submit][message]': `One payment of ${total} for ${sigs(quantity)}. Nothing recurring, and your plan and its price do not change. ${refundRuleText(refundDays())}`,
    client_reference_id: a.id, success_url: `${baseUrl()}/app/settings?tab=billing&topped=1&session_id={CHECKOUT_SESSION_ID}`, cancel_url: planUrl(),
    ...(a.stripe_customer_id ? { customer: a.stripe_customer_id } : { customer_email: c.user.email }),
  });
  return { url: s.url, quantity, total };
}, 'admin');

// Turns the monthly plan on for a subscription the provider says is alive and paid. Used by every message that can
// be the first to mention it (finished checkout, first paid invoice, a subscription update, the browser coming back),
// whichever arrives first. An old checkout replayed later turns nothing on, because its subscription is no longer alive.
async function adopt(accountId: string, customer: string | null, subscriptionId: string | null, known?: any): Promise<boolean> {
  const a = get('SELECT * FROM accounts WHERE id=?', accountId);
  if (!a || !subscriptionId) return false;
  if (customer && !a.stripe_customer_id) run('UPDATE accounts SET stripe_customer_id=? WHERE id=?', customer, a.id);
  if (a.plan === 'grove' && a.stripe_subscription_id === subscriptionId && hasSub(a)) return false;
  const sub = known || (await stripe('GET', `subscriptions/${subscriptionId}`));
  if (!['active', 'trialing'].includes(sub?.status)) return false;
  // Free through a code, or already paying for another subscription: this one must not exist. It is ended, and its
  // payment is refunded when it is reported.
  const duplicate = hasSub(a) && a.stripe_subscription_id !== subscriptionId && LIVE.includes(a.subscription_status || '');
  if (a.promo_code || duplicate) {
    await endOrQueue(subscriptionId, a.id);
    if (duplicate) await tellOperators(`A second subscription was started for ${a.name}`, [`Account ${a.id} already pays for subscription ${a.stripe_subscription_id}. The new one (${subscriptionId}) was ended automatically and its payment is refunded when it arrives. Check that nothing else is wrong.`], a.id);
    return false;
  }
  const end = periodEnd(sub);
  run("UPDATE accounts SET plan='grove', stripe_customer_id=COALESCE(?, stripe_customer_id), stripe_subscription_id=?, subscription_status=?, renews_at=COALESCE(?, renews_at), cancel_at=?, cancel_ref=NULL, renewal_reminded=NULL, renewal_quoted_cents=NULL WHERE id=?",
    customer, subscriptionId, sub.status, end, sub.cancel_at_period_end ? end : null, a.id);
  log(a.id, 'started', `${PLAN_PRICE()} a month.`, subscriptionId);
  await mailAdmins(accountId, `Welcome to ${PRICING.planName}`, 'Thank you. Your signatures plant mangroves.', [
    `You are on the monthly plan: ${PLAN_PRICE()} a month adds ${sigs(PRICING.monthlySignatures)} to your balance with every payment. That is ${trees(PLAN_CENTS())} planted each month.`,
    ...(end ? [`Next charge: ${PLAN_PRICE()} on ${day(end)}, and every month after that until you cancel. We remind you a week before and again the day before.`] : []),
    `Signatures never expire, so what you do not use rolls over. Need more? Top up any time at ${money(PRICING.topUpUsd * 100)} a signature.`,
    'It is month to month: no contract, no notice period, and nothing is ever charged unless you choose it. You get a receipt for every payment.',
    refundRuleText(refundDays()),
    'To stop renewing, use the Cancel button on the Plan page or the link below. It works without logging in.',
  ], 'stop');
  return true;
}

// Payments that arrived before we knew whose they were (the paid invoice can be reported before the finished
// checkout) are picked up as soon as the customer is known.
async function claimPayments(accountId: string) {
  const a = get('SELECT * FROM accounts WHERE id=?', accountId);
  if (!a?.stripe_customer_id) return;
  for (const p of all("SELECT id FROM payments WHERE account_id IS NULL AND customer_id=? AND applied_at IS NULL AND kind='plan'", a.stripe_customer_id)) {
    const inv = await stripe('GET', `invoices/${p.id}`).catch(() => null);
    if (inv?.id) await applyInvoice(inv);
  }
}

// Records a paid top-up and adds its signatures. Safe to call twice for the same payment.
async function applyTopUp(s: any): Promise<boolean> {
  if (s.metadata?.kind !== 'topup' || s.payment_status !== 'paid') return false;
  const a = s.client_reference_id ? get('SELECT * FROM accounts WHERE id=?', s.client_reference_id) : null;
  const cents = Number(s.amount_total) || 0;
  // Never trust the count alone: it can be no more than what was actually paid for.
  const credits = Math.min(Math.round(Number(s.metadata?.credits)) || 0, Math.floor(cents / (PRICING.topUpUsd * 100)));
  if (credits < 1) return false;
  const fresh = run("INSERT OR IGNORE INTO payments (id, account_id, amount_cents, currency, at, kind, credits, charge_id, customer_id) VALUES (?,?,?,?,?,'topup',?,?,?)", s.id, a?.id ?? null, cents, s.currency || 'usd', now(), credits, sid(s.payment_intent), sid(s.customer)).changes;
  if (!fresh) return false;
  if (!a) {
    // Money for an account that no longer exists goes straight back, and a person hears about it.
    await owe(null, get('SELECT * FROM payments WHERE id=?', s.id), cents, 'the account this payment was for has been closed');
    await tellOperators('A top-up was paid for an account that no longer exists', [`Checkout ${s.id}, ${money(cents, s.currency)}, customer ${sid(s.customer) || 'unknown'}. It is being refunded automatically. Check that it went through.`]);
    return false;
  }
  grant(a.id, credits, 'topup', s.id);
  run('UPDATE payments SET applied_at=? WHERE id=?', now(), s.id);
  if (s.customer && !a.stripe_customer_id) run('UPDATE accounts SET stripe_customer_id=? WHERE id=?', sid(s.customer), a.id);
  const inv = s.invoice ? await stripe('GET', `invoices/${sid(s.invoice)}`).catch(() => null) : null;
  const receipt = inv?.hosted_invoice_url || inv?.invoice_pdf || null;
  if (receipt) run('UPDATE payments SET receipt_url=? WHERE id=?', receipt, s.id);
  await mailAdmins(a.id, `Receipt: ${money(cents, s.currency)} for ${sigs(credits)}`, `${sigs(credits)} added. Thank you.`, [
    `${money(cents, s.currency)} for ${a.name}, paid today. You now have ${sigs(Math.max(0, available(a.id)))} to send.`,
    `That plants ${trees(cents)} with Treegens.`,
    `This was a single payment. It does not repeat and does not change your plan. Signatures never expire.`,
    refundRuleText(refundDays()),
    `Account: ${a.name}, reference ${a.id}. Receipts go to every owner and admin of the account.`,
  ], receipt ? { label: 'View invoice', url: receipt } : { label: 'Open the Plan page', url: planUrl() });
  return true;
}

// A finished checkout, from the provider's message or from the browser coming back, whichever is first.
async function applySession(s: any): Promise<void> {
  if (s.mode === 'payment') return void (await applyTopUp(s));
  const sub = sid(s.subscription);
  if (!sub || !['paid', 'no_payment_required'].includes(s.payment_status ?? 'paid')) return;
  await adopt(s.client_reference_id, sid(s.customer), sub);
  await claimPayments(s.client_reference_id);
  // The first payment is applied here as well, so the signatures are there the moment checkout finishes.
  if (s.invoice) {
    const inv = await stripe('GET', `invoices/${sid(s.invoice)}`).catch(() => null);
    if (inv?.id) await applyInvoice(inv);
  }
}

// Coming back from checkout: apply the plan or the top-up now instead of waiting for the provider's event to arrive.
// The answer says what was actually applied, so the page never thanks anyone for a payment that did not happen.
route('POST', '/billing/sync', async (c) => {
  const sessionId = str((await c.body()).session_id, 200);
  let applied: 'plan' | 'topup' | null = null;
  if (billingEnabled() && /^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    const s = await stripe('GET', `checkout/sessions/${sessionId}`).catch(() => null);
    if (s && s.client_reference_id === c.account.id) {
      await applySession({ ...s, id: s.id || sessionId });
      const a = get('SELECT * FROM accounts WHERE id=?', c.account.id);
      if (s.mode === 'payment') applied = get('SELECT applied_at FROM payments WHERE id=? AND account_id=?', s.id || sessionId, a.id)?.applied_at ? 'topup' : null;
      else applied = a.plan === 'grove' && hasSub(a) && a.stripe_subscription_id === sid(s.subscription) ? 'plan' : null;
    }
  }
  return { ...billingState(get('SELECT * FROM accounts WHERE id=?', c.account.id), c.user), applied };
}, 'admin');

// The provider's own page, for changing the card or downloading invoices. Available for as long as the account
// exists, also after cancelling.
route('POST', '/billing/portal', async (c) => {
  if (!billingEnabled() || !c.account.stripe_customer_id) throw bad('There is no payment method on this account.');
  const s = await stripe('POST', 'billing_portal/sessions', { customer: c.account.stripe_customer_id, return_url: planUrl() });
  return { url: s.url };
}, 'admin');

route('POST', '/billing/cancel', (c) => cancelPlan(c.account, `in the app by ${c.user.name}`), 'admin');

route('POST', '/billing/resume', async (c) => {
  const a = c.account;
  if (a.promo_code) throw bad(`This plan is free with the code ${a.promo_code}. There is no paid plan to resume.`);
  if (!a.cancel_at || !hasSub(a)) throw bad('This plan is not set to end.');
  const sub = await stripe('POST', `subscriptions/${a.stripe_subscription_id}`, { cancel_at_period_end: 'false' });
  run('UPDATE accounts SET cancel_at=NULL, renews_at=? WHERE id=?', periodEnd(sub) || a.renews_at, a.id);
  log(a.id, 'resumed', `By ${c.user.name}. Cancellation ${a.cancel_ref || ''} undone.`.trim());
  return billingState(get('SELECT * FROM accounts WHERE id=?', a.id), c.user);
}, 'admin');

// Self-serve refund of whatever has not been used from a payment. Refunding a monthly payment also ends the plan.
// With no payment named, it is the latest one.
route('POST', '/billing/refund', async (c) => {
  const a = c.account;
  const want = str((await c.req.json().catch(() => ({})))?.payment_id, 200);
  const offer = want ? offerFor(a, get('SELECT * FROM payments WHERE id=? AND account_id=?', want, a.id)) : refundOffer(a);
  if (!offer) throw bad(`${refundRuleText(refundDays())} There is nothing unused inside that window for this payment right now. If you think that is wrong, use the contact form and a person will look at it.`);
  // One refund per payment, claimed before any money moves, so two clicks, two tabs or two servers cannot both pay.
  if (!run('UPDATE payments SET refund_pending_at=? WHERE id=? AND self_refund_at IS NULL AND (refund_pending_at IS NULL OR refund_pending_at < ?)', now(), offer.payment_id, new Date(Date.now() - 10 * 60_000).toISOString()).changes)
    throw bad('A refund for this payment is already on its way. Give it a minute and reload the page.', 409);
  const p = get('SELECT * FROM payments WHERE id=?', offer.payment_id);
  const endsPlan = p.kind === 'plan' && hasSub(a);
  let planEnded = false;
  // The signatures leave the balance first, so they cannot be spent while the money is on its way back.
  grant(a.id, -offer.signatures, 'refund', p.id);
  try {
    if (endsPlan) {
      // The plan ends at the provider before any money moves. If that fails, nothing has changed and we say so.
      if (!(await endSubscription(a.stripe_subscription_id, true)))
        throw bad('We could not end the monthly plan with the payment provider just now, so nothing was refunded and nothing changed. Please try again in a minute.', 502);
      run("UPDATE accounts SET plan='seedling', subscription_status='canceled', cancel_at=NULL, renews_at=NULL WHERE id=?", a.id);
      log(a.id, 'ended', 'Ended with the refund of its latest payment.');
      planEnded = true;
    }
    const reference = await refundPayment(a, p, offer.cents, offer.reason);
    run('UPDATE payments SET self_refund_at=?, refund_pending_at=NULL WHERE id=?', now(), p.id);
    return { refunded: offer.amount, signatures: offer.signatures, reference, plan_ended: planEnded };
  } catch (e: any) {
    run("DELETE FROM credits WHERE account_id=? AND reason='refund' AND ref=?", a.id, p.id);
    run('UPDATE payments SET refund_pending_at=NULL WHERE id=?', p.id);
    if (planEnded) throw bad('The monthly plan has been ended and you will not be charged again, but the refund itself did not go through just now. Nothing is lost: press Refund again in a minute.', 502);
    throw e;
  }
}, 'admin');

// Take the card off file, at any time. If a plan is renewing it is set to end first, so nothing can fail to renew
// by surprise.
route('POST', '/billing/remove-card', async (c) => {
  const a = c.account;
  if (!a.stripe_customer_id) throw bad('There is no card on this account.');
  if (renewing(a)) await cancelPlan(a, `in the app by ${c.user.name}, with the card removed`);
  const pms = await stripe('GET', 'payment_methods', { customer: a.stripe_customer_id, type: 'card', limit: '20' });
  for (const pm of pms.data || []) await stripe('POST', `payment_methods/${pm.id}/detach`);
  if ((pms.data || []).length) log(a.id, 'card-removed', `By ${c.user.name}.`);
  return { removed: (pms.data || []).length };
}, 'admin');

// ---- Without logging in --------------------------------------------------------------------

route('GET', '/public/billing/stop', (c) => {
  const aid = readStopToken(c.q.get('token'));
  const a = aid && get('SELECT * FROM accounts WHERE id=?', aid);
  if (!a) throw bad('This link has expired. Use "Find my subscription" below and we will email you a new one.', 410);
  // free_with is set when the plan costs nothing through a code: there is nothing to stop.
  return {
    account: a.name, plan: a.plan, price: PRICING.monthlyUsd, free_with: a.promo_code || null, can_cancel: renewing(a) || (hasSub(a) && a.plan !== 'grove'),
    renews_at: a.plan === 'grove' && renewing(a) ? a.renews_at : null, ends_at: a.promo_code ? null : a.cancel_at, cancel_ref: a.cancel_ref || null, signatures_left: Math.max(0, available(a.id)),
  };
}, 'public');

route('POST', '/public/billing/stop', async (c) => {
  rateLimit(`stop:${c.ip}`, 20, 3600_000);
  const aid = readStopToken((await c.body()).token);
  const a = aid && get('SELECT * FROM accounts WHERE id=?', aid);
  if (!a) throw bad('This link has expired. Use "Find my subscription" and we will email you a new one.', 410);
  return cancelPlan(a, 'from an email link');
}, 'public');

// "I am being charged and cannot find where": emails every paid account this address administers, each with a stop link.
route('POST', '/public/billing/find', async (c) => {
  rateLimit(`find:${c.ip}`, 10, 3600_000);
  const email = str((await c.body()).email, 254).trim().toLowerCase();
  if (!isEmail(email)) throw bad('Enter a valid email address.');
  rateLimit(`find:${email}`, 3, 3600_000);
  const u = get('SELECT id, tz FROM users WHERE email=?', email);
  const rows = u ? all("SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role IN ('owner','admin') AND a.stripe_subscription_id IS NOT NULL", u.id).filter(hasSub) : [];
  // Plans this person can see but not manage are named too, with who to ask, so a member is not told "nothing found".
  const others = u ? all("SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role='member' AND a.stripe_subscription_id IS NOT NULL", u.id).filter(hasSub) : [];
  if (rows.length || others.length)
    await sendMail({
      to: email, subject: 'Your Sign&Grow subscriptions', heading: 'Your monthly plans',
      lines: [
        ...(rows.length ? ['You asked which paid plans are tied to this email address. Each link below stops that plan from renewing. No login needed.'] : []),
        ...others.map((a) => dated(`${a.name} has a paid plan (${PLAN_PRICE()} a month) that you are a member of but do not manage. Its owner can stop it: ${admins(a.id).map((x) => x.name).join(', ') || 'see the Team page'}.`, u.tz)),
      ],
      links: rows.map((a) => ({ label: `Stop renewal for ${a.name}`, url: stopUrl(a.id, u.id), note: dated(a.cancel_at ? `already cancelled, ends ${day(a.cancel_at)}` : `${PLAN_PRICE()} a month${a.renews_at ? `, next charge ${day(a.renews_at)}` : ''}`, u.tz) })),
    });
  else
    await sendMail({ to: email, subject: 'Your Sign&Grow subscriptions', heading: 'No paid plans found', lines: ['There is no paid Sign&Grow plan tied to this email address, so we are not charging you.', 'If you see a charge from us anyway, it may be under a different address. On the help page you can stop it with the card instead: the last four digits plus the date and amount of the charge are enough.'], cta: { label: 'Stop it with the card', url: `${baseUrl()}/help` } });
  return { ok: true };
}, 'public');

// Which accounts were charged on a card? Asked of the payment provider by the card's last four digits, narrowed by
// the date and amount of a charge. Used when the payer does not know which email address the account is under.
async function accountsByCard(last4: string, on?: string, cents?: number): Promise<any[]> {
  const q = [`payment_method_details.card.last4:${last4}`, "status:'succeeded'"];
  const t = on ? Math.floor(Date.parse(on) / 1000) : NaN;
  if (Number.isFinite(t)) q.push(`created>${t - 2 * 86400}`, `created<${t + 3 * 86400}`);
  else q.push(`created>${Math.floor(Date.now() / 1000) - 100 * 86400}`);
  if (cents) q.push(`amount:${cents}`);
  const found = await stripe('GET', 'charges/search', { query: q.join(' AND '), limit: '50' }).catch(() => ({ data: [] }));
  const customers = [...new Set((found.data || []).map((ch: any) => sid(ch.customer)).filter(Boolean))] as string[];
  return customers.map((cu) => get('SELECT * FROM accounts WHERE stripe_customer_id=?', cu)).filter(Boolean);
}

// Locked out of the mailbox (old job, deleted address), or no idea which address the account is under: prove you are
// the payer with the card instead. Either the account email plus the card's last four digits, or the last four
// digits plus the date and the amount of a charge.
route('POST', '/public/billing/stop-by-card', async (c) => {
  rateLimit(`card:${c.ip}`, 5, 3600_000);
  const b = await c.body();
  const email = str(b.email, 254).trim().toLowerCase();
  const last4 = str(b.last4, 4).replace(/\D/g, '');
  const on = /^\d{4}-\d{2}-\d{2}$/.test(str(b.charged_on, 10)) ? str(b.charged_on, 10) : '';
  const cents = Math.round(Number(String(b.amount ?? '').replace(/[^0-9.]/g, '')) * 100) || 0;
  if (last4.length !== 4 || (!isEmail(email) && !(on && cents)))
    throw bad('Enter the last four digits of the card being charged, and either the account email address or the date and amount of a charge.');
  if (!billingEnabled()) throw bad('Billing is not set up on this server.', 501);
  let rows: any[];
  if (isEmail(email)) {
    rateLimit(`card:${email}`, 5, 3600_000);
    rows = [];
    for (const a of all("SELECT DISTINCT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email=? AND a.stripe_customer_id IS NOT NULL", email).filter(hasSub)) {
      const pms = await stripe('GET', 'payment_methods', { customer: a.stripe_customer_id, type: 'card', limit: '20' }).catch(() => ({ data: [] }));
      if ((pms.data || []).some((pm: any) => pm.card?.last4 === last4)) rows.push(a);
    }
  } else {
    rateLimit(`card4:${last4}`, 5, 3600_000);
    rows = (await accountsByCard(last4, on, cents)).filter(hasSub);
    // Without the email address the match has to be unambiguous before anything is stopped.
    if (rows.length > 1) throw bad('More than one plan matches those details. Add the account email address, or use the contact form and a person will sort it out.', 409);
  }
  if (!rows.length) throw bad('Those details do not match a paid plan. Check them against your card statement, or use the contact form and a person will help.', 404);
  const r = await cancelPlan(rows[0], 'by the card holder, without logging in');
  return { stopped: true, account: isEmail(email) ? rows[0].name : undefined, ...r };
}, 'public');

// ---- Events from the payment provider ------------------------------------------------------

export function verifyStripeSignature(raw: string, header: string, secret: string, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) return false;
  return safeEqual(hmac(`${parts.t}.${raw}`, secret), parts.v1);
}

// The payment a card charge belongs to: by the charge itself, its payment, or its invoice. Only when a monthly
// payment knows none of those is it matched by amount, and then to the payment made closest to the charge.
function paymentForCharge(ch: any, account: any | null): any | null {
  const byId = get('SELECT * FROM payments WHERE charge_id IN (?,?) OR id=?', ch.id || '-', sid(ch.payment_intent) || '-', sid(ch.invoice) || '-');
  if (byId || !account) return byId;
  const near = all('SELECT * FROM payments WHERE account_id=? AND charge_id IS NULL AND amount_cents=?', account.id, ch.amount);
  const at = (ch.created || Date.now() / 1000) * 1000;
  return near.sort((x, y) => Math.abs(Date.parse(x.at) - at) - Math.abs(Date.parse(y.at) - at))[0] || null;
}

// One invoice is settled once, also when the browser coming back and the provider's message race each other.
const settling = new Set<string>();
async function applyInvoice(o: any): Promise<void> {
  if (!o?.id || !(o.amount_paid > 0) || (o.status && o.status !== 'paid') || settling.has(o.id)) return;
  settling.add(o.id);
  try {
    await settleInvoice(o);
  } finally {
    settling.delete(o.id);
  }
}

// A paid invoice: the monthly payment. Each one adds the plan's signatures to the balance, or goes straight back if
// it should never have been taken.
async function settleInvoice(o: any): Promise<void> {
  const cents = o.amount_paid;
  const currency = o.currency || 'usd';
  const S = subOf(o);
  const customer = sid(o.customer);
  const named = namedAccount(o);
  let a = (named && get('SELECT * FROM accounts WHERE id=?', named)) || (customer && get('SELECT * FROM accounts WHERE stripe_customer_id=?', customer)) || null;
  const isPlan = !o.billing_reason || String(o.billing_reason).startsWith('subscription');
  // Signatures follow the money: the plan price buys the plan's signatures, a smaller invoice buys fewer, never more.
  const credits = isPlan ? Math.min(PRICING.monthlySignatures, Math.floor((cents * PRICING.monthlySignatures) / PLAN_CENTS())) : 0;
  const fresh = run('INSERT OR IGNORE INTO payments (id, account_id, amount_cents, currency, at, receipt_url, kind, credits, charge_id, customer_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
    o.id, a?.id ?? null, cents, currency, now(), o.hosted_invoice_url || o.invoice_pdf || null, isPlan ? 'plan' : 'other', credits, chargeOf(o), customer).changes;
  const p = get('SELECT * FROM payments WHERE id=?', o.id);
  if (p.applied_at) return;
  const done = () => run('UPDATE payments SET applied_at=? WHERE id=?', now(), o.id);
  if (!a) {
    if (named) {
      // The account this was for has been closed and deleted. The money goes straight back.
      await owe(null, p, cents, 'the account this payment was for has been closed');
      await endOrQueue(S);
      done();
      await tellOperators('A payment arrived for an account that no longer exists', [`Invoice ${o.id}, ${money(cents, currency)}, customer ${customer}. It is being refunded automatically and the subscription ended. Check that both went through.`]);
    } else if (fresh) {
      // Usually the finished checkout simply has not been reported yet; it is picked up the moment it is.
      await tellOperators('A payment could not be matched to an account yet', [`Invoice ${o.id}, ${money(cents, currency)}, customer ${customer}. If it is the first payment of a new plan it is matched automatically when the checkout is reported. If this is still unmatched in an hour, find the payer and either add their signatures or refund it.`]);
    }
    return;
  }
  if (!p.account_id) run('UPDATE payments SET account_id=? WHERE id=?', a.id, o.id);
  if (!isPlan) {
    done();
    await tellOperators(`An invoice that is not the monthly plan was paid by ${a.name}`, [`Invoice ${o.id}, ${money(cents, currency)}, account ${a.id}. No signatures were added for it. If it was meant to buy signatures, add them or refund it.`], a.id);
    return;
  }

  // Should this money have been taken at all?
  let why = '';
  if (a.promo_code) why = `your plan is free with the code ${a.promo_code}, so there is nothing to pay`;
  else if (S && a.stripe_subscription_id !== S) {
    // A subscription we have not been told about yet, or one that should not exist.
    const sub = await stripe('GET', `subscriptions/${S}`);
    const second = hasSub(a) && LIVE.includes(a.subscription_status || '');
    if (!(await adopt(a.id, customer, S, sub))) why = second ? 'this account already has a monthly plan, so this was a second charge' : 'this plan was already cancelled';
    a = get('SELECT * FROM accounts WHERE id=?', a.id);
  } else if (a.subscription_status === 'canceled' || (!S && a.plan !== 'grove' && !hasSub(a))) why = 'this plan was already cancelled';
  else if (a.cancel_at) {
    // Cancelled, and this invoice pays for time after the end of the last paid month.
    const start = (o.lines?.data?.[0]?.period?.start ?? 0) * 1000;
    if (start ? start >= Date.parse(a.cancel_at) - 60_000 : Date.parse(a.cancel_at) < Date.now()) why = 'this plan was already cancelled';
  }
  if (why) {
    run('UPDATE payments SET credits=0 WHERE id=?', o.id);
    if (S && (a.promo_code || a.stripe_subscription_id !== S || a.subscription_status === 'canceled')) await endOrQueue(S, a.id);
    await owe(a, { ...p, credits: 0 }, cents, why);
    done();
    return;
  }

  // A payment that got through brings a paused plan back.
  if (a.plan !== 'grove' || !LIVE.includes(a.subscription_status || '') || a.subscription_status === 'past_due')
    run("UPDATE accounts SET plan='grove', subscription_status='active' WHERE id=?", a.id);
  grant(a.id, credits, 'plan', o.id);
  const next = iso(o.lines?.data?.[0]?.period?.end);
  if (next && (!a.renews_at || next > a.renews_at)) run('UPDATE accounts SET renews_at=? WHERE id=?', next, a.id);
  done();

  // The amount charged at a renewal is the amount the reminder said. If more was taken, the difference goes back.
  const cycle = o.billing_reason === 'subscription_cycle';
  const quoted = cycle && a.renewal_quoted_cents ? a.renewal_quoted_cents : 0;
  if (quoted && cents > quoted) {
    await owe(a, get('SELECT * FROM payments WHERE id=?', o.id), cents - quoted, `the reminder said ${money(quoted, currency)} and ${money(cents, currency)} was charged`);
    await tellOperators(`${a.name} was charged more than their renewal reminder said`, [`Invoice ${o.id}: reminded ${money(quoted, currency)}, charged ${money(cents, currency)}. The difference is being refunded automatically. Find out why the price changed.`], a.id);
  } else if (cents !== PLAN_CENTS())
    await tellOperators(`A monthly payment from ${a.name} was not the plan price`, [`Invoice ${o.id} was ${money(cents, currency)}; the plan is ${PLAN_PRICE()}. ${sigs(credits)} were added. Check the price configured with the payment provider.`], a.id);
  if (cycle && !String(a.renewal_reminded || '').startsWith((a.renews_at || '-').slice(0, 10)))
    await tellOperators(`${a.name} was renewed without a reminder going out first`, [`Invoice ${o.id}. No renewal reminder is on record for this charge. Check that the timer (POST /api/cron) is being called and that email is working.`], a.id);

  await mailAdmins(a.id, `Receipt: ${money(cents, currency)} for ${sigs(credits)}`, 'Payment received. Thank you.', [
    `${money(cents, currency)} for ${a.name}, charged today. ${sigs(credits)} added: you now have ${sigs(Math.max(0, available(a.id)))} to send.`,
    `That plants ${trees(cents)} with Treegens.`,
    ...(next && !a.cancel_at ? [`Next charge: ${PLAN_PRICE()} on ${day(next)}. We remind you a week before and again the day before.`] : []),
    refundRuleText(refundDays()),
    `Account: ${a.name}, reference ${a.id}. Receipts go to every owner and admin of the account.`,
  ], o.hosted_invoice_url ? { label: 'View invoice', url: o.hosted_invoice_url } : { label: 'Open the Plan page', url: planUrl() });
}

// The reminder before a renewal: once a week before and once the day before, each saying exactly what will be
// charged and when, each with a one-click way to stop it. Sent on our own timer; the provider's "upcoming invoice"
// message triggers the same thing and adds the exact amount. Every reminder is written to the plan history.
async function remindRenewal(a: any, when: string, cents?: number | null, currency = 'usd'): Promise<boolean> {
  if (a.plan !== 'grove' || !renewing(a) || !['active', 'trialing'].includes(a.subscription_status || '')) return false;
  const key = when.slice(0, 10);
  const [k, sent = ''] = String(a.renewal_reminded || '').split('|');
  const already = k === key ? sent.split(',').filter(Boolean) : [];
  if (cents != null) run('UPDATE accounts SET renewal_quoted_cents=? WHERE id=?', cents, a.id);
  const hours = (Date.parse(when) - Date.now()) / 36e5;
  if (hours <= 0) return false;
  const stage = hours <= 36 ? '1' : '7';
  if (already.includes(stage) || (stage === '7' && already.includes('1'))) return false;
  const mark = () => run('UPDATE accounts SET renewal_reminded=? WHERE id=?', `${key}|${[...already, stage].join(',')}`, a.id);
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
    ], { label: 'Keep my plan', url: planUrl() });
    return true;
  }
  const amount = money(cents ?? a.renewal_quoted_cents ?? PLAN_CENTS(), currency);
  mark();
  log(a.id, 'reminder', `${stage === '1' ? 'One day' : 'One week'} before: ${amount} on ${key}.`);
  await mailAdmins(a.id, stage === '1' ? `Tomorrow: your plan renews for ${amount}` : `Heads up: your plan renews on ${day(when)} for ${amount}`, stage === '1' ? 'Your plan renews tomorrow' : 'Your plan renews soon', [
    `On ${day(when)} we will charge ${amount} for ${a.name} and add ${sigs(PRICING.monthlySignatures)}. That is the full amount: there are no extras, and if more than this is ever taken we send the difference back.`,
    `You have ${sigs(Math.max(0, available(a.id)))} left at the moment. They roll over either way.`,
    'To keep planting mangroves, do nothing. To stop, use the link below. It takes one click, needs no login, and works right up to the charge.',
  ], 'stop');
  return true;
}

// On the timer: remind everyone whose plan renews within a week.
export async function renewalReminders(): Promise<number> {
  if (!billingEnabled()) return 0;
  const rows = all("SELECT * FROM accounts WHERE plan='grove' AND promo_code IS NULL AND cancel_at IS NULL AND stripe_subscription_id IS NOT NULL AND renews_at > ? AND renews_at <= ?", now(), new Date(Date.now() + 7 * 864e5).toISOString());
  let n = 0;
  for (const a of rows) if (await remindRenewal(a, a.renews_at).catch((e) => (console.error('[billing] reminder failed', a.id, e?.message), false))) n++;
  return n;
}

// On the timer: whatever was owed to a customer and could not be done at the time (a refund, ending a subscription)
// is tried again until the provider confirms it. After three failures a person is told.
export async function billingRetries(): Promise<number> {
  if (!billingEnabled()) return 0;
  let n = 0;
  for (const t of all('SELECT * FROM billing_todo WHERE done_at IS NULL AND tries < 40 ORDER BY id LIMIT 50')) {
    let ok = false;
    try {
      if (t.kind === 'cancel') ok = await endSubscription(t.ref);
      else {
        const p = get('SELECT * FROM payments WHERE id=?', t.ref);
        const d = JSON.parse(t.detail || '{}');
        if (!p || p.refunded_cents >= p.amount_cents) ok = true;
        else {
          await refundPayment(t.account_id ? get('SELECT * FROM accounts WHERE id=?', t.account_id) : null, p, Math.min(d.cents || p.amount_cents, p.amount_cents - p.refunded_cents), d.why || 'this payment should not have been taken');
          ok = true;
        }
      }
    } catch (e: any) {
      console.error('[billing] retry failed', t.kind, t.ref, e?.message);
    }
    if (ok) {
      run('UPDATE billing_todo SET done_at=? WHERE id=?', now(), t.id);
      n++;
    } else {
      run('UPDATE billing_todo SET tries=tries+1 WHERE id=?', t.id);
      if (t.tries + 1 === 3)
        await tellOperators(t.kind === 'cancel' ? 'A subscription that must end is still alive at the payment provider' : 'A refund we owe keeps failing', [
          t.kind === 'cancel' ? `Subscription ${t.ref}${t.account_id ? ` (account ${t.account_id})` : ''} could not be ended after three tries. We keep trying; end it by hand in the provider's dashboard so it cannot charge.`
            : `Payment ${t.ref}${t.account_id ? ` (account ${t.account_id})` : ''} could not be refunded after three tries. We keep trying; refund it by hand in the provider's dashboard and it will be recorded here.`,
        ], t.account_id);
    }
  }
  run('DELETE FROM stripe_events WHERE at < ?', new Date(Date.now() - 60 * 864e5).toISOString());
  return n;
}

async function handleEvent(ev: any) {
  const o = ev?.data?.object || {};
  const byCustomer = () => (o.customer ? get('SELECT * FROM accounts WHERE stripe_customer_id=?', sid(o.customer)) : null);

  if ((ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') && o.client_reference_id) return applySession(o);

  // A slow payment method (bank debit, pay later) that did not go through in the end.
  if (ev.type === 'checkout.session.async_payment_failed' && o.client_reference_id) {
    if (get('SELECT id FROM accounts WHERE id=?', o.client_reference_id))
      await mailAdmins(o.client_reference_id, 'Your payment did not go through', 'A payment failed', ['The payment you started did not go through in the end, so nothing was added and nothing was charged. You can try again from the Plan page whenever you like.'], { label: 'Open the Plan page', url: planUrl() });
    return;
  }

  if (ev.type === 'invoice.paid' || ev.type === 'invoice.payment_succeeded') return applyInvoice(o);

  // Sent by the provider some days before each renewal, with the exact amount it is going to charge.
  if (ev.type === 'invoice.upcoming') {
    const a = byCustomer();
    const when = iso(o.next_payment_attempt || o.period_end);
    if (a && when) await remindRenewal(a, when, o.amount_due ?? null, o.currency || 'usd');
    return;
  }

  if (ev.type === 'invoice.payment_failed') {
    const a = byCustomer();
    if (a && !a.promo_code) {
      log(a.id, 'paused', 'A monthly payment did not go through.');
      await mailAdmins(a.id, 'Your monthly payment did not go through', 'A payment failed', [
        'Nothing is locked and nothing is deleted. If the payment keeps failing, the monthly plan simply ends. Every document stays available, and the signatures you already have stay yours.',
        'To keep the plan, update the card on the Plan page. To stop it instead, use the link below: the failed payment will then not be tried again.',
      ], { label: 'Open the Plan page', url: planUrl() });
    }
    return;
  }

  if (ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted') {
    const ended = ev.type === 'customer.subscription.deleted' || ['canceled', 'incomplete_expired'].includes(o.status);
    const live = !ended && LIVE.includes(o.status);
    const a = byCustomer() || (o.metadata?.account_id ? get('SELECT * FROM accounts WHERE id=?', o.metadata.account_id) : null);
    if (!a) return;
    if (a.promo_code) {
      // The plan is free through a code, so nothing may be charged for it. A paid subscription that is still alive
      // is ended; one winding down changes nothing.
      if (!ended) await endOrQueue(o.id, a.id);
      return;
    }
    if (a.stripe_subscription_id !== o.id) {
      // Not the subscription this account is on. An old one winding down is none of today's business; a new one
      // that is alive and paid is taken up (or ended and refunded, if the account already pays for another).
      if (!ended && ['active', 'trialing'].includes(o.status)) {
        await adopt(a.id, sid(o.customer), o.id, o);
        await claimPayments(a.id);
      }
      return;
    }
    // Messages can arrive late and out of order. An older one never overwrites what a newer one said.
    const at = Number(ev.created) || 0;
    if (at && a.sub_event_at && at < a.sub_event_at) return;
    if (a.subscription_status === 'canceled' && !ended) {
      // We ended this one. If the provider still shows it alive, make sure it is ended there too.
      await endOrQueue(o.id, a.id);
      return;
    }
    const end = periodEnd(o);
    run('UPDATE accounts SET plan=?, subscription_status=?, renews_at=?, cancel_at=?, sub_event_at=? WHERE id=?', live ? 'grove' : 'seedling', ended ? 'canceled' : o.status,
      live ? end : null, live && o.cancel_at_period_end ? end || a.cancel_at : null, at || a.sub_event_at || null, a.id);
    if (ended && a.subscription_status !== 'canceled') {
      log(a.id, 'ended', 'The monthly plan ended.', a.cancel_ref || '');
      if (a.plan === 'grove')
        await mailAdmins(a.id, 'Your monthly plan has ended', 'Your plan has ended', ['You will not be charged again. Nothing was deleted: every document, audit trail and receipt is still in your account.', `You still have ${sigs(Math.max(0, available(a.id)))}. They never expire, and signing your own documents is always free. Come back to the monthly plan whenever you like.`]);
    } else if (!live && !ended && a.plan === 'grove')
      await mailAdmins(a.id, 'Your monthly plan is on hold', 'Your plan is on hold because a payment did not go through', [
        'Nothing is locked and nothing is deleted. The signatures you already have stay yours and still work.',
        'To bring the plan back, update the card on the Plan page. To end it for good, press Cancel there: the failed payment is then not tried again.',
      ], { label: 'Open the Plan page', url: planUrl() });
    return;
  }

  if (ev.type === 'charge.refunded') {
    // A refund made outside the app (for example by a person in the provider's dashboard) is recorded too. Our own
    // refunds come back through here as well and change nothing, because they are already on record.
    const p = paymentForCharge(o, byCustomer());
    if (p) run('UPDATE payments SET refunded_at=COALESCE(refunded_at, ?), refunded_cents=MIN(amount_cents, MAX(refunded_cents, ?)) WHERE id=?', now(), o.amount_refunded ?? o.amount, p.id);
    return;
  }

  // A card dispute means the customer wants out. Stop all further billing at once and do not fight it: the dispute is
  // accepted with the provider, the customer gets that in writing, and the payment is marked as returned so it cannot
  // be refunded a second time.
  if (ev.type === 'charge.dispute.created') {
    const charge = o.charge && billingEnabled() ? await stripe('GET', `charges/${sid(o.charge)}`).catch(() => null) : null;
    const a = charge?.customer ? get('SELECT * FROM accounts WHERE stripe_customer_id=?', sid(charge.customer)) : null;
    // ACCEPT_DISPUTES=0 leaves the decision to a person; billing is stopped either way.
    const accepted = billingEnabled() && o.id && process.env.ACCEPT_DISPUTES !== '0' ? await stripe('POST', `disputes/${o.id}/close`).then(() => true).catch(() => false) : false;
    const p = charge ? paymentForCharge(charge, a) : null;
    if (p) run('UPDATE payments SET refunded_at=COALESCE(refunded_at, ?), refunded_cents=amount_cents WHERE id=?', now(), p.id);
    const forOps = accepted ? 'The dispute was accepted with the payment provider automatically, so the bank returns the money.' : 'The dispute could NOT be accepted automatically. Accept it by hand with the payment provider so the bank releases the money.';
    if (!a) return tellOperators('Card dispute on a charge we cannot match to an account', [`Dispute ${o.id}, charge ${sid(o.charge)}. ${forOps}`]);
    const stopped = !hasSub(a) || (await endOrQueue(a.stripe_subscription_id, a.id));
    if (!a.promo_code) run("UPDATE accounts SET plan='seedling', subscription_status='canceled', cancel_at=NULL, renews_at=NULL WHERE id=?", a.id);
    log(a.id, 'dispute', 'A charge was disputed with the bank. All billing stopped.', o.id || '');
    await mailAdmins(a.id, 'We stopped all billing on your account', 'A payment was disputed, so we stopped billing you', [
      `A payment${charge?.amount ? ` of ${money(charge.amount, charge.currency)}` : ''} to Sign&Grow was disputed with the card's bank. ${accepted ? 'We are not contesting it: the bank returns the money to the card.' : 'A person here will look at it and write to you. You do not need to do anything.'}`,
      'Your monthly plan has ended and nothing more will be charged. Nothing was deleted, and the signatures you have stay yours.',
      'If this was a mistake you can start the plan again from the Plan page at any time.',
    ], { label: 'Open the Plan page', url: planUrl() });
    await tellOperators(`Card dispute: ${a.name}`, [`Account ${a.name} (${a.id}), dispute ${o.id}. Billing was stopped${stopped ? '' : ', but the provider did not confirm the subscription ended (we keep trying)'}. ${forOps} The customer has been told in writing.`], a.id);
  }
}

// The provider repeats its messages. Each one is applied once; one that failed half way is applied again in full,
// and every step above is safe to repeat.
export async function applyStripeEvent(ev: any) {
  if (ev?.id && get('SELECT id FROM stripe_events WHERE id=?', ev.id)) return;
  await handleEvent(ev);
  if (ev?.id) run('INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?,?)', ev.id, now());
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
  const rows = all("SELECT * FROM accounts WHERE plan='grove' AND promo_code IS NULL AND cancel_at IS NULL AND stripe_subscription_id IS NOT NULL AND (dormant_nudged_at IS NULL OR dormant_nudged_at < ?) AND created_at < ?", cutoff, cutoff)
    .filter((a) => get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at > ?", a.id, cutoff).n === 0);
  for (const a of rows) {
    run('UPDATE accounts SET dormant_nudged_at=? WHERE id=?', now(), a.id);
    await mailAdmins(a.id, 'Still using Sign&Grow?', 'You are on the monthly plan but have not sent anything in 60 days', [
      `${a.name} pays ${PLAN_PRICE()} a month and has ${sigs(Math.max(0, available(a.id)))} saved up. Every dollar plants mangroves, and we are grateful. But we would rather you paid on purpose.`,
      'If you are not using it, stop the renewal with the link below. You keep every document and every signature you have already paid for.',
    ], 'stop');
  }
  return rows.length;
}

// Operators: find the account behind a charge from what a caller can read off their card statement.
route('GET', '/operator/billing/lookup', async (c) => {
  const ops = (process.env.OPERATOR_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (!c.user?.email_verified || !ops.includes(String(c.user.email).toLowerCase())) throw new HttpError(404, 'Not found');
  const last4 = str(c.q.get('last4'), 4).replace(/\D/g, '');
  if (last4.length !== 4) throw bad('Enter the last four digits of the card.');
  if (!billingEnabled()) throw bad('Billing is not set up on this server.', 501);
  const cents = Math.round(Number(c.q.get('amount') || 0) * 100) || undefined;
  const rows = await accountsByCard(last4, str(c.q.get('charged_on'), 10) || undefined, cents);
  return { accounts: rows.map((a) => ({ id: a.id, name: a.name, plan: a.plan, status: a.subscription_status, free_with: a.promo_code || null, renews_at: a.renews_at, ends_at: a.cancel_at, admins: admins(a.id).map((u) => ({ name: u.name, email: u.email })) })) };
});
