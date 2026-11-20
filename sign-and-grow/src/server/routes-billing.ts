import { route } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, hmac, now, id, isEmail, str, rateLimit, baseUrl, safeEqual, HttpError } from './util.ts';
import { sendMail } from './mail.ts';
import { billingEnabled } from './envelopes.ts';
import { grant, creditSummary, available, findFreeCode } from './credits.ts';
import { PRICING, mangrovesFor } from '../lib/impact.ts';
import { refundDays, dormantStopDays, refundRuleText, newAccountDailyRecipients, unpaidDailyRecipients } from '../lib/policy.ts';

export { refundDays, dormantStopDays };

// How Sign&Grow charges:
//   - $9 a month adds 9 signatures to the balance. Extra signatures are $1 each. Every dollar plants 10 mangroves.
//   - Signatures never expire. One is used only when somebody actually signs.
//   - Month to month. No annual term, no notice period, and nothing is ever charged without an explicit choice.
// And the things people most often say went wrong elsewhere, handled in code rather than in a policy page:
//   - Cancelling is one button. It also works from an email link without logging in, and by card for people locked out.
//   - Every charge is announced a week before and about a day before, and receipted after. The amount shown is the
//     amount charged; if more is taken than we said, the difference goes back by itself.
//   - Unused signatures are refunded automatically on request within the refund window. Nobody has to argue for it.
//   - A charge that arrives after cancellation, on a free plan, or twice for the plan, is refunded by the software
//     itself. If the payment provider is down at that moment it is tried again on the timer until it goes through.
//   - Stopping payment never deletes or locks anything, and signatures already paid for stay usable.
//   - The payment provider does not promise the order of its messages, and sends several in the same second, so
//     nothing here depends on their order and everything about money is done one step at a time (see serial()).

const money = (cents: number, currency = 'usd') => new Intl.NumberFormat('en', { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(cents / 100);
const iso = (unix?: number | null) => (unix ? new Date(unix * 1000).toISOString() : null);
const sid = (x: any): string | null => (typeof x === 'string' ? x : x?.id || null);
const sigs = (n: number) => `${n} signature${n === 1 ? '' : 's'}`;
const PLAN_CENTS = () => PRICING.monthlyUsd * 100;
const PLAN_PRICE = () => money(PLAN_CENTS());
const trees = (cents: number) => `${mangrovesFor(cents / 100).toLocaleString('en')} mangrove trees`;
const planUrl = () => `${baseUrl()}/app/settings?tab=billing`;
const account = (accountId: any) => (accountId ? get('SELECT * FROM accounts WHERE id=?', accountId) : null);

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

// Everything that changes money or a plan runs one at a time. The provider sends "checkout finished", "invoice paid"
// and "subscription updated" within the same second, and people double-click; taking them in turn means each step
// sees what the one before it did. Only entry points (routes, a provider message, a timer item) may call this:
// calling it from inside itself would wait for ever.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

// An answer from the payment provider that is not "yes". `unsure` means we do not know whether it happened (the
// provider could not be reached, timed out, or failed inside): for a refund that difference matters a great deal.
class ProviderError extends HttpError {
  unsure: boolean;
  constructor(message: string, unsure: boolean) {
    super(502, message);
    this.unsure = unsure;
  }
}
const gone = (e: any) => /no such (subscription|invoice|customer)/i.test(e?.message || '');

async function stripe(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string> = {}, idempotencyKey?: string): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1/${path}${method === 'GET' && qs ? `?${qs}` : ''}`, {
      method,
      headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      body: method === 'POST' ? qs : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ProviderError('The payment provider could not be reached just now. Please try again in a minute.', true);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(data?.error?.message || 'The payment provider returned an error.', res.status >= 500);
  return data;
}

// Stripe moved the period end from the subscription to its items in newer API versions. Read either.
const periodEnd = (sub: any): string | null => iso(sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end);
// When is this subscription set to end, if at all? Either "at the end of the period" or a date.
const plannedEnd = (sub: any): string | null => (sub?.cancel_at_period_end ? periodEnd(sub) : iso(sub?.cancel_at));
// The same goes for where an invoice names its subscription, the account it was started for, its price and charge.
const subOf = (o: any): string | null => sid(o.subscription) || sid(o.parent?.subscription_details?.subscription) || sid(o.lines?.data?.[0]?.subscription) || sid(o.lines?.data?.[0]?.parent?.subscription_item_details?.subscription);
const namedAccount = (o: any): string | null => o.subscription_details?.metadata?.account_id || o.parent?.subscription_details?.metadata?.account_id || o.lines?.data?.[0]?.metadata?.account_id || o.metadata?.account_id || null;
const priceOf = (o: any): string | null => sid(o.lines?.data?.[0]?.price) || sid(o.lines?.data?.[0]?.pricing?.price_details?.price) || sid(o.lines?.data?.[0]?.plan) || sid(o.items?.data?.[0]?.price);
const chargeOf = (o: any): string | null => sid(o.payment_intent) || sid(o.charge) || sid(o.payments?.data?.[0]?.payment?.payment_intent) || sid(o.payments?.data?.[0]?.payment?.charge);
const taxOf = (o: any): number => Number(o.tax) || (Array.isArray(o.total_taxes) ? o.total_taxes.reduce((n: number, t: any) => n + (Number(t.amount) || 0), 0) : 0);

// A subscription the provider is charging, or will try to charge again.
const LIVE = ['active', 'trialing', 'past_due'];
const PAID_UP = ['active', 'trialing'];
// Is there something at the payment provider that could still take money for this account's plan? The states are
// listed one by one: anything else (ended, free through a code, never started) is a no.
const hasSub = (a: any) => !!a?.stripe_subscription_id && !a.promo_code && [...LIVE, 'unpaid', 'incomplete', 'paused'].includes(a.subscription_status || '');
const renewing = (a: any) => hasSub(a) && !a.cancel_at;
const newReference = (a: any) => `SG-${a.id.slice(-5).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
const unixNow = () => Math.floor(Date.now() / 1000);

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
  const a = account(accountId);
  for (const u of admins(accountId)) {
    const stop = { label: 'Stop renewing (no login needed)', url: stopUrl(accountId, u.id) };
    await sendMail({
      to: u.email, subject: dated(subject, u.tz), heading: dated(heading, u.tz), lines: lines.map((l) => dated(l, u.tz)),
      cta: cta === 'stop' ? stop : cta,
      links: cta !== 'stop' && a && renewing(a) ? [{ label: 'Do not renew', url: stop.url, note: 'Stops the monthly plan in one click, without logging in.' }] : undefined,
    });
  }
}

// Things only a person can sort out. They go to the support address and to every operator, and are kept in the
// operator queue in the app. With neither address configured nobody can open that queue, so the server says so
// loudly in its log every time.
async function tellOperators(subject: string, lines: string[], accountId?: string | null) {
  const to = [...new Set([process.env.SUPPORT_EMAIL || '', ...(process.env.OPERATOR_EMAILS || '').split(',')].map((s) => s.trim().toLowerCase()).filter(isEmail))];
  run("INSERT INTO support_requests (id, email, name, topic, message, account_id, status, at) VALUES (?,?,?,'billing',?,?,'open',?)",
    id('sup'), to[0] || 'billing-alert@localhost', 'Sign&Grow (automatic alert)', `${subject}\n\n${lines.join('\n')}`.slice(0, 5000), accountId ?? null, now());
  for (const t of to) await sendMail({ to: t, subject, heading: subject, lines, cta: { label: 'Open the queue', url: `${baseUrl()}/app/operator` } });
  if (!to.length) console.error('[billing] NOBODY WAS TOLD (set SUPPORT_EMAIL or OPERATOR_EMAILS):', subject, lines.join(' '));
}

// Links that stop a renewal without logging in. Signed, tied to one admin of one account, valid for 120 days, and
// dead as soon as that person is no longer an admin of the account.
export function stopToken(accountId: string, userId: string, days = 120): string {
  const exp = unixNow() + days * 86400;
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

const refundInFlight = (paymentId: string) => !!get("SELECT 1 x FROM refunds WHERE payment_id=? AND status='pending'", paymentId);

// The refund rule, in one place: within the window, every signature a payment bought that is still unused is refunded
// at the price paid for it. Nobody needs to approve it, and it can be done again later for signatures that come back
// (a voided envelope, say) while the window is open.
function offerFor(acct: any, p: any): Offer | null {
  if (!p || p.account_id !== acct.id || !p.applied_at || (p.kind !== 'plan' && p.kind !== 'topup')) return null;
  const left = p.credits - (p.credits_refunded || 0);
  const owing = p.amount_cents - p.refunded_cents;
  if (left <= 0 || owing <= 0 || refundInFlight(p.id)) return null;
  if ((Date.now() - Date.parse(p.at)) / 864e5 > refundDays()) return null;
  const unused = Math.min(left, Math.max(0, available(acct.id)));
  if (unused <= 0) return null;
  const cents = Math.min(owing, Math.round((owing / left) * unused));
  if (cents <= 0) return null;
  return {
    payment_id: p.id, cents, amount: money(cents, p.currency), signatures: unused, of: p.credits, kind: p.kind, paid_at: p.at,
    reason: unused === p.credits ? `all ${sigs(p.credits)} it bought are still on your balance` : `${unused} of the ${sigs(p.credits)} it bought ${unused === 1 ? 'is' : 'are'} still on your balance`,
  };
}
// What the Plan page offers up front: the latest payment. Earlier ones inside the window are offered next to each
// payment in the list, and are refunded only when that payment is named.
export function refundOffer(acct: any): Offer | null {
  return offerFor(acct, get("SELECT * FROM payments WHERE account_id=? AND kind IN ('plan','topup') ORDER BY at DESC, rowid DESC LIMIT 1", acct.id));
}

// Finds the card charge behind a payment. Top-ups know theirs. A monthly payment learns it when its invoice arrives;
// if it did not, the provider is asked for the invoice's own payment. Only as a last resort is it matched by amount,
// and then only when exactly one charge can be meant: a refund is never sent to a charge picked by guessing.
async function chargeTarget(p: any, acct: any | null): Promise<Record<string, string>> {
  const known = (v: any): Record<string, string> | null => (String(v || '').startsWith('pi_') ? { payment_intent: String(v) } : String(v || '').startsWith('ch_') ? { charge: String(v) } : null);
  if (known(p.charge_id)) return known(p.charge_id)!;
  if (p.kind !== 'topup') {
    const inv = await stripe('GET', `invoices/${p.id}`, { 'expand[]': 'payments' }).catch((e) => (e.unsure ? Promise.reject(e) : stripe('GET', `invoices/${p.id}`).catch(() => null)));
    const found = inv && chargeOf(inv);
    if (found && known(found)) {
      run('UPDATE payments SET charge_id=? WHERE id=?', found, p.id);
      return known(found)!;
    }
  }
  const customer = p.customer_id || acct?.stripe_customer_id;
  const charges = customer ? await stripe('GET', 'charges', { customer, limit: '100' }) : { data: [] };
  const taken = new Set(all('SELECT charge_id FROM payments WHERE charge_id IS NOT NULL AND id!=?', p.id).map((r) => r.charge_id));
  const fits = (charges.data || []).filter((c: any) => c.paid && !c.refunded && c.amount === p.amount_cents && !taken.has(c.id) && !taken.has(sid(c.payment_intent)) && (!c.invoice || sid(c.invoice) === p.id));
  if (fits.length !== 1) throw new ProviderError('We could not find that charge automatically. Use the contact form and a person will refund it by hand.', false);
  run('UPDATE payments SET charge_id=? WHERE id=?', fits[0].id, p.id);
  return { charge: fits[0].id };
}

// Sends one refund to the provider, or finds that an earlier try already went through. The provider is given our
// own reference for it, so "did it happen?" can always be answered by looking. Returns 'done', or 'pending' when the
// provider's answer is unknown (it is then checked again on the timer). Throws when the provider says no.
async function tryRefund(ref: string): Promise<'done' | 'pending'> {
  const r = get('SELECT * FROM refunds WHERE id=?', ref);
  if (!r || r.status !== 'pending') return 'done';
  const p = get('SELECT * FROM payments WHERE id=?', r.payment_id);
  const acct = account(r.account_id);
  try {
    const target = await chargeTarget(p, acct);
    let out: any = null;
    if (r.tries > 0) {
      // An earlier try may have gone through with its answer lost on the way back.
      const list = await stripe('GET', 'refunds', { ...target, limit: '100' });
      out = (list.data || []).find((x: any) => x.metadata?.sg_ref === ref) || null;
    }
    out ||= await stripe('POST', 'refunds', { ...target, amount: String(r.cents), 'metadata[sg_ref]': ref }, `${ref}-${r.tries}`);
    // Recorded once, whoever gets here first (this call, the timer, or the provider's own notice).
    if (run("UPDATE refunds SET status='done', provider_id=?, done_at=? WHERE id=? AND status='pending'", out.id, now(), ref).changes) {
      run('UPDATE payments SET refunded_at=COALESCE(refunded_at, ?), refunded_cents=MIN(amount_cents, refunded_cents+?), credits_refunded=credits_refunded+? WHERE id=?', now(), r.cents, r.signatures, p.id);
      if (acct) {
        log(acct.id, 'refund', `${money(r.cents, p.currency)}: ${r.why}`, out.id);
        await mailAdmins(acct.id, `Refund sent: ${money(r.cents, p.currency)}`, 'Your refund is on its way', [
          `We refunded ${money(r.cents, p.currency)} to the card it was paid with (${r.why}).`,
          `Refund reference: ${out.id}. Banks usually show it within 5 to 10 working days.`,
        ]);
      }
    }
    return 'done';
  } catch (e: any) {
    run('UPDATE refunds SET tries=tries+1, last_at=? WHERE id=?', now(), ref);
    if (e instanceof ProviderError && e.unsure) return 'pending';
    throw e;
  }
}

// Starts a refund: writes it down, takes its signatures off the balance (so they cannot be spent while the money is
// on its way back), then asks the provider.
function openRefund(acct: any | null, p: any, cents: number, signatures: number, why: string, auto: boolean): string {
  const ref = id('rf');
  run("INSERT INTO refunds (id, payment_id, account_id, cents, signatures, why, auto, status, at) VALUES (?,?,?,?,?,?,?,'pending',?)", ref, p.id, acct?.id ?? null, cents, signatures, why, auto ? 1 : 0, now());
  if (acct && signatures > 0) grant(acct.id, -signatures, 'refund', ref);
  return ref;
}
// Undoes a refund the provider refused: the signatures go back on the balance.
function dropRefund(ref: string) {
  const r = get('SELECT * FROM refunds WHERE id=?', ref);
  if (!r || r.status !== 'pending') return;
  run("UPDATE refunds SET status='failed', done_at=? WHERE id=?", now(), ref);
  if (r.account_id) run("DELETE FROM credits WHERE account_id=? AND reason='refund' AND ref=?", r.account_id, ref);
}

// A refund the software owes without being asked (charged after cancelling, charged twice, charged on a free plan,
// charged more than we said). If the provider cannot take it right now it stays open and is tried again on the timer
// until it goes through; a person is told when it keeps failing. It is never written to a log and forgotten.
async function owe(acct: any | null, p: any, cents: number, why: string) {
  const amount = Math.min(cents, p.amount_cents - p.refunded_cents);
  if (amount <= 0) return;
  const ref = openRefund(acct, p, amount, 0, why, true);
  await tryRefund(ref).catch((e) => console.error('[billing] automatic refund will be retried', p.id, e?.message));
}

// Ends a subscription at the provider now. True only when the provider confirms it is gone (or already was).
// With `withdraw`, an invoice that is still waiting to be paid is withdrawn too, so a payment that was failing (or
// had not been taken yet) cannot go through after the customer said stop.
async function endSubscription(subId: string, withdraw = false): Promise<boolean> {
  let sub: any = null;
  try {
    sub = await stripe('DELETE', `subscriptions/${subId}`);
  } catch (e: any) {
    if (!gone(e)) {
      sub = await stripe('GET', `subscriptions/${subId}`).catch(() => null);
      if (sub?.status !== 'canceled' && sub?.status !== 'incomplete_expired') return false;
    }
  }
  if (withdraw && sid(sub?.latest_invoice)) await withdrawInvoice(sid(sub.latest_invoice)!);
  return true;
}
async function withdrawInvoice(invoiceId: string) {
  const inv = await stripe('GET', `invoices/${invoiceId}`).catch(() => null);
  if (inv?.status === 'open') await stripe('POST', `invoices/${inv.id}/void`).catch(() => {});
  else if (inv?.status === 'draft') await stripe('DELETE', `invoices/${inv.id}`).catch(() => {});
}
// For the places where the end must happen whatever the provider answers right now.
async function endOrQueue(subId: string | null, accountId?: string | null): Promise<boolean> {
  if (!subId) return true;
  if (await endSubscription(subId, true)) return true;
  run("INSERT OR IGNORE INTO billing_todo (kind, ref, account_id, detail, at) VALUES ('cancel',?,?,'',?)", subId, accountId ?? null, now());
  return false;
}
// Used when an account is closed: whatever state its plan is in, nothing may be charged afterwards.
export const stopBillingFor = (acct: any): Promise<boolean> => serial(async () => {
  const a = account(acct?.id);
  if (!a || !billingEnabled() || !hasSub(a)) return true;
  const ok = await endOrQueue(a.stripe_subscription_id, a.id);
  run("UPDATE accounts SET plan=CASE WHEN promo_code IS NULL THEN 'seedling' ELSE plan END, subscription_status='canceled', cancel_at=NULL, renews_at=NULL, sub_event_at=? WHERE id=?", unixNow(), a.id);
  log(a.id, 'ended', 'Ended because the account was closed.');
  return ok;
});

// ---- What the Plan page shows ----------------------------------------------------------------

const LEDGER_LABEL: Record<string, string> = { welcome: 'Welcome signatures', plan: 'Monthly plan', code: 'Monthly plan, free with your code', topup: 'Top-up', signature: 'Signature used', refund: 'Refund', adjust: 'Adjustment' };
const PAYMENT_LABEL: Record<string, string> = { plan: 'Monthly plan', topup: 'Top-up' };

// Has this account ever paid for anything it kept? Anti-abuse limits on unpaid accounts stop applying once it has.
const hasPaid = (accountId: string) => !!get("SELECT 1 x FROM payments WHERE account_id=? AND kind IN ('plan','topup') AND amount_cents > refunded_cents LIMIT 1", accountId);

export function billingState(acct: any, user?: any) {
  const enabled = billingEnabled();
  const paid = get("SELECT COALESCE(SUM(amount_cents - refunded_cents),0) cents FROM payments WHERE account_id=? AND kind IN ('plan','topup')", acct.id).cents;
  const limited = (acct.plan === 'seedling' || !!acct.promo_code) && !acct.trusted_at && !hasPaid(acct.id);
  const firstWeek = limited && Date.now() - Date.parse(acct.created_at) < 7 * 864e5;
  const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString();
  const s = enabled ? creditSummary(acct.id) : null;
  const told = acct.renewal_quoted_cents && String(acct.renewal_reminded || '').startsWith((acct.renews_at || '-').slice(0, 10)) ? acct.renewal_quoted_cents : 0;
  return {
    enabled,
    plan: acct.plan,
    status: acct.subscription_status,
    price: PRICING.monthlyUsd,
    pricing: PRICING,
    // Set when the plan is free through a code: nothing is charged, so there is nothing to renew or to end.
    free_with: acct.promo_code || null,
    free_next_at: acct.promo_code ? nextMonth : null,
    renews_at: acct.plan === 'grove' && renewing(acct) ? acct.renews_at : null,
    // What the next charge will really be: the amount we told them for it if a reminder went out, else the plan price.
    next_amount: money(told || PLAN_CENTS()),
    ends_at: acct.plan === 'grove' && !acct.promo_code ? acct.cancel_at : null,
    cancel_ref: acct.cancel_ref || null,
    // A plan that was on and is not any more (as opposed to one that never started).
    ended: acct.plan !== 'grove' && !!get("SELECT 1 x FROM billing_log WHERE account_id=? AND what='started' LIMIT 1", acct.id),
    // A payment that did not go through. Nothing is locked; the page says what to do.
    problem: hasSub(acct) && ['past_due', 'unpaid', 'incomplete', 'paused'].includes(acct.subscription_status) ? acct.subscription_status : null,
    // A card dispute stops payments until a person has looked.
    disputed: !!acct.dispute_at,
    can_cancel: renewing(acct) || (hasSub(acct) && (acct.plan !== 'grove' || !PAID_UP.includes(acct.subscription_status))),
    has_customer: !!acct.stripe_customer_id,
    // What can be sent right now: the balance, minus signatures held for people who have been asked and not signed yet.
    signatures: s,
    short: s && s.available < 0 ? -s.available : 0,
    mangroves: mangrovesFor(paid / 100),
    refund: enabled ? refundOffer(acct) : null,
    refund_days: refundDays(),
    refund_rule: refundRuleText(refundDays()),
    dormant_stop_days: dormantStopDays(),
    // Limits, as numbers, before anybody runs into them.
    limits: { first_week_daily: firstWeek ? newAccountDailyRecipients() : null, unpaid_daily_now: limited && !firstWeek ? unpaidDailyRecipients() : null, new_account_daily: newAccountDailyRecipients(), unpaid_daily: unpaidDailyRecipients(), top_up_max: PRICING.topUpMax, bulk_rows: 500 },
    // Other paid plans this person already manages, so nobody pays twice without noticing.
    other_paid: user ? all("SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role IN ('owner','admin') AND a.id!=?", user.id, acct.id).filter(hasSub).map((r) => r.name) : [],
    payments: all("SELECT * FROM payments WHERE account_id=? AND kind IN ('plan','topup') ORDER BY at DESC, rowid DESC LIMIT 60", acct.id)
      .map((p) => ({
        id: p.id, amount_cents: p.amount_cents, currency: p.currency, at: p.at, receipt_url: p.receipt_url, refunded_at: p.refunded_at, refunded_cents: p.refunded_cents, kind: p.kind, label: PAYMENT_LABEL[p.kind], credits: p.credits,
        amount: money(p.amount_cents, p.currency), refunded: p.refunded_cents ? money(p.refunded_cents, p.currency) : null, refund_pending: refundInFlight(p.id), refundable: enabled ? offerFor(acct, p) : null,
      })),
    ledger: all('SELECT delta, reason, at FROM credits WHERE account_id=? ORDER BY id DESC LIMIT 40', acct.id).map((l) => ({ ...l, label: LEDGER_LABEL[l.reason] || l.reason })),
    history: all('SELECT at, what, ref, detail FROM billing_log WHERE account_id=? ORDER BY id DESC LIMIT 40', acct.id).map((h) => ({ ...h, label: HISTORY_LABEL[h.what] || h.what })),
  };
}

// ---- Cancelling ------------------------------------------------------------------------------

const cancelLines = (a: any, reference: string, by: string, when: string[]) => [
  `Cancellation reference: ${reference}. Cancelled ${by}.`,
  ...when,
  `Your signatures stay yours: the ${sigs(Math.max(0, available(a.id)))} you have left never expire, and signing your own documents is always free.`,
  'Nothing is deleted. Every document, audit trail and receipt stays available to you for as long as the account exists.',
];

// One state change with the payment provider, a reference number, and an email that says when billing stops. The
// answer is only "cancelled" once the provider has confirmed it; if the provider fails, so does this, out loud.
// Callers hold the queue (serial); this reads the account afresh so a second click finds the first one's work.
export async function cancelPlan(acct: any, by: string, quiet = false): Promise<{ ends_at: string; reference: string; ended_now: boolean }> {
  const a = account(acct.id);
  if (!hasSub(a)) throw bad(a.promo_code ? `This plan is free with the code ${a.promo_code}. Nothing is charged for it, so there is nothing to cancel.` : 'There is no monthly plan on this account, so there is nothing to cancel and nothing will be charged.');
  // Already cancelled and paid up: say so again, with the same reference.
  if (a.cancel_at && a.plan === 'grove' && PAID_UP.includes(a.subscription_status) && Date.parse(a.cancel_at) > Date.now()) {
    if (!a.cancel_ref) run('UPDATE accounts SET cancel_ref=? WHERE id=?', newReference(a), a.id);
    return { ends_at: a.cancel_at, reference: account(a.id).cancel_ref, ended_now: false };
  }
  const reference = a.cancel_ref && a.cancel_at ? a.cancel_ref : newReference(a);
  let sub: any;
  try {
    sub = await stripe('POST', `subscriptions/${a.stripe_subscription_id}`, { cancel_at_period_end: 'true' });
  } catch (e: any) {
    // Already gone at the provider: then it is cancelled, and we say so instead of failing.
    if (!gone(e) && (await stripe('GET', `subscriptions/${a.stripe_subscription_id}`).catch(() => null))?.status !== 'canceled') throw e;
    sub = { status: 'canceled' };
  }
  // Paid up means the plan runs to the end of the month that is paid for. Not paid up (the last payment failed, or
  // the new month's payment has been raised but not taken yet) means there is no paid month to run out: it ends
  // today, and the payment that was waiting is withdrawn so it cannot be taken after the customer said stop.
  let waiting = false;
  if (PAID_UP.includes(sub.status) && sid(sub.latest_invoice)) {
    const inv = await stripe('GET', `invoices/${sid(sub.latest_invoice)}`).catch(() => null);
    waiting = inv?.status === 'draft' || inv?.status === 'open';
  }
  if (!PAID_UP.includes(sub.status) || waiting) {
    if (sub.status !== 'canceled' && !(await endSubscription(a.stripe_subscription_id, true)))
      throw bad('The payment provider did not confirm the cancellation just now, so we cannot tell you it is done. Please try again in a minute, or use the contact form and a person will do it.', 502);
    run("UPDATE accounts SET plan='seedling', subscription_status='canceled', cancel_at=NULL, cancel_ref=?, renews_at=NULL, sub_event_at=? WHERE id=?", reference, unixNow(), a.id);
    const why = waiting ? 'The payment for the new month had not been taken yet, so the plan ends today and that payment will not be taken.' : 'The last payment had not gone through, so the plan ends today and that payment will not be tried again.';
    log(a.id, 'cancelled', `Cancelled ${by}. Ended at once: the month had not been paid for.`, reference);
    if (!quiet)
      await mailAdmins(a.id, `Your ${PRICING.planName} plan is cancelled`, 'Cancelled. You will not be charged again.', [...cancelLines(a, reference, by, [why]), 'If a charge ever appears after today, we refund it automatically.'], { label: 'Open the Plan page', url: planUrl() });
    return { ends_at: now(), reference, ended_now: true };
  }
  const ends = plannedEnd(sub) || periodEnd(sub) || a.renews_at || now();
  run('UPDATE accounts SET cancel_at=?, cancel_ref=?, sub_event_at=? WHERE id=?', ends, reference, unixNow(), a.id);
  log(a.id, quiet ? 'auto-stop' : 'cancelled', `Cancelled ${by}.`, reference);
  if (!quiet)
    await mailAdmins(a.id, `Your ${PRICING.planName} plan is cancelled`, 'Cancelled. You will not be charged again.', [
      ...cancelLines(a, reference, by, [`The plan runs until ${day(ends)}, because that month is already paid for. No more payments are taken after that.`]),
      'If a charge ever appears after this date, we refund it automatically.',
    ], { label: 'Changed your mind? Resume', url: planUrl() });
  return { ends_at: ends, reference, ended_now: false };
}

route('GET', '/billing', (c) => billingState(c.account, c.user));

// ---- The free code ---------------------------------------------------------------------------

// A code that makes the monthly plan free. The plan's signatures arrive every month and nothing is ever charged for
// it. Someone who was paying stops paying today: their subscription is ended at the provider before the code counts.
async function redeemNow(accountId: string, typed: any): Promise<string> {
  const code = findFreeCode(typed);
  if (!code) throw bad('We do not recognise that code. Check the spelling and try again.');
  const a = account(accountId);
  if (a.promo_code === code) return code;
  const wasPaying = hasSub(a) && billingEnabled();
  let reference = '';
  if (wasPaying) {
    if (!(await endSubscription(a.stripe_subscription_id, true)))
      throw bad('We could not stop your paid plan with the payment provider just now, so the code was not applied and nothing changed. Please try again in a minute.', 502);
    reference = newReference(a);
    log(a.id, 'cancelled', `Paid subscription ended because the code ${code} made the plan free.`, reference);
  }
  // The old subscription is gone for good, so its id goes too: nothing on this account can be charged for the plan.
  run("UPDATE accounts SET promo_code=?, promo_at=COALESCE(promo_at, ?), promo_missing_since=NULL, plan='grove', subscription_status='free', stripe_subscription_id=NULL, cancel_at=NULL, renews_at=NULL, cancel_ref=COALESCE(?, cancel_ref), sub_event_at=? WHERE id=?",
    code, now(), reference || null, unixNow(), a.id);
  log(a.id, 'code', `Code ${code}: the monthly plan is free.`);
  await mailAdmins(a.id, `Code ${code} accepted: your plan is free`, 'Your monthly plan is free', [
    `${a.name} is on the monthly plan at no charge with the code ${code}. ${sigs(PRICING.monthlySignatures)} are added to your balance at the start of every month, and what you do not use rolls over.`,
    ...(wasPaying ? [
      `Your paid subscription ended today and will not be charged again. Cancellation reference: ${reference}.`,
      `The signatures you already paid for stay yours. ${refundRuleText(refundDays())}`,
    ] : []),
    ...(a.stripe_customer_id ? ['The card you paid with before is still saved in case you top up. You can remove it on the Plan page at any time.'] : []),
    `Nothing is charged for the plan, so there is nothing to cancel. If you need more in a busy month you can top up at ${money(PRICING.topUpUsd * 100)} a signature, and every dollar plants ${PRICING.treesPerUsd} mangrove trees.`,
  ], { label: 'Open the Plan page', url: planUrl() });
  return code;
}
export const redeemCode = (accountId: string, typed: any): Promise<string> => serial(() => redeemNow(accountId, typed));

route('POST', '/billing/redeem', async (c) => {
  rateLimit(`redeem:${c.ip}`, 20, 3600_000);
  await redeemCode(c.account.id, (await c.body()).code);
  return billingState(account(c.account.id), c.user);
}, 'admin');

// When a code is switched off (taken out of FREE_PLAN_CODES), the plans it made free end, and the people on it are
// told. They keep every signature they have. A code has to be missing for three days in a row before that happens,
// so a slip in a deployment does not end everyone's plan; no signatures are added in the meantime.
export const endRemovedCodes = (): Promise<number> => serial(async () => {
  let ended = 0;
  for (const a of all('SELECT * FROM accounts WHERE promo_code IS NOT NULL')) {
    if (findFreeCode(a.promo_code)) {
      if (a.promo_missing_since) run('UPDATE accounts SET promo_missing_since=NULL WHERE id=?', a.id);
      continue;
    }
    if (!a.promo_missing_since) {
      run('UPDATE accounts SET promo_missing_since=? WHERE id=?', now(), a.id);
      continue;
    }
    if (Date.parse(a.promo_missing_since) > Date.now() - 3 * 864e5) continue;
    run("UPDATE accounts SET promo_code=NULL, promo_at=NULL, promo_missing_since=NULL, plan='seedling', subscription_status=NULL, stripe_subscription_id=NULL, cancel_at=NULL, renews_at=NULL WHERE id=?", a.id);
    log(a.id, 'code-ended', `The code ${a.promo_code} is no longer active.`);
    await mailAdmins(a.id, `The code ${a.promo_code} has ended`, 'Your free monthly plan has ended', [
      `The code ${a.promo_code} is no longer active, so ${a.name} no longer gets ${sigs(PRICING.monthlySignatures)} a month for free. Nothing was charged and nothing will be.`,
      `You keep the ${sigs(Math.max(0, available(a.id)))} you have. They never expire, and signing your own documents is always free.`,
      `To keep getting ${sigs(PRICING.monthlySignatures)} a month you can start the monthly plan for ${PLAN_PRICE()} on the Plan page. Every dollar plants ${PRICING.treesPerUsd} mangrove trees.`,
    ], { label: 'Open the Plan page', url: planUrl() });
    ended++;
  }
  return ended;
});

// ---- Paying ----------------------------------------------------------------------------------

const DISPUTED = 'A payment on this account was disputed with the bank, so new payments are switched off until a person has looked. Use the contact form and we will sort it out.';

route('POST', '/billing/checkout', async (c) => {
  if (!billingEnabled() || !process.env.STRIPE_PRICE_GROVE) throw bad('Billing is not set up on this server yet.', 501);
  const a = c.account;
  if (a.promo_code) throw bad(`Your plan is already free with the code ${a.promo_code}. There is nothing to pay.`);
  if (a.dispute_at) throw bad(DISPUTED, 403);
  if (a.plan === 'grove' && renewing(a)) throw bad(`This account is already on the ${PRICING.planName} plan.`);
  // Cancelled but still running: paying again would start a second subscription next to the first.
  if (a.plan === 'grove' && hasSub(a) && a.cancel_at) throw bad('Your plan is cancelled but still running, so there is nothing to pay for yet. Press "Keep the plan after all" on the Plan page and it simply continues, with no new payment today.');
  if (hasSub(a)) throw bad('The last payment for this plan did not go through. Update the card with "Invoices and card" on the Plan page, or cancel the plan first and start again.');
  const s = await stripe('POST', 'checkout/sessions', {
    mode: 'subscription', 'line_items[0][price]': process.env.STRIPE_PRICE_GROVE, 'line_items[0][quantity]': '1',
    client_reference_id: a.id, 'metadata[account_id]': a.id,
    // The subscription carries the account it is for, so its payments find their way home in whatever order the
    // provider reports them.
    'subscription_data[metadata][account_id]': a.id, 'subscription_data[description]': `Sign&Grow monthly plan for ${a.name} (${a.id})`,
    // The commitment, in plain words, on the payment page itself. And always in US dollars, the price we show.
    'custom_text[submit][message]': `${PLAN_PRICE()} today, then ${PLAN_PRICE()} every month until you cancel. Each payment adds ${sigs(PRICING.monthlySignatures)}. No contract and no notice period: cancel in one click. ${refundRuleText(refundDays())}`,
    'adaptive_pricing[enabled]': 'false',
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
  if (a.dispute_at) throw bad(DISPUTED, 403);
  if (a.plan !== 'grove') throw bad(hasSub(a) ? 'Top-ups come with the monthly plan, and the last payment for yours did not go through. Update the card on the Plan page and you can top up again.' : `Top-ups are for accounts on the monthly plan. Start it for ${PLAN_PRICE()} a month and you get ${sigs(PRICING.monthlySignatures)} straight away.`);
  const quantity = Math.round(Number((await c.body()).quantity));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > PRICING.topUpMax) throw bad(`Choose between 1 and ${PRICING.topUpMax} signatures.`);
  const total = money(quantity * PRICING.topUpUsd * 100);
  const s = await stripe('POST', 'checkout/sessions', {
    mode: 'payment', 'line_items[0][quantity]': String(quantity),
    'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(PRICING.topUpUsd * 100),
    'line_items[0][price_data][product_data][name]': `Sign&Grow signature (plants ${PRICING.treesPerUsd} mangrove trees)`,
    'metadata[kind]': 'topup', 'metadata[credits]': String(quantity), 'metadata[account_id]': a.id,
    'payment_intent_data[description]': `Sign&Grow top-up: ${sigs(quantity)} for ${a.name} (${a.id})`, 'payment_intent_data[metadata][account_id]': a.id,
    // The provider makes an invoice for it, marked as a top-up so it is never mistaken for a monthly payment.
    'invoice_creation[enabled]': 'true', 'invoice_creation[invoice_data][metadata][kind]': 'topup', 'invoice_creation[invoice_data][metadata][account_id]': a.id,
    'custom_text[submit][message]': `One payment of ${total} for ${sigs(quantity)}. Nothing recurring, and your plan and its price do not change. ${refundRuleText(refundDays())}`,
    'adaptive_pricing[enabled]': 'false',
    client_reference_id: a.id, success_url: `${baseUrl()}/app/settings?tab=billing&topped=1&session_id={CHECKOUT_SESSION_ID}`, cancel_url: planUrl(),
    ...(a.stripe_customer_id ? { customer: a.stripe_customer_id } : { customer_email: c.user.email }),
  });
  return { url: s.url, quantity, total };
}, 'admin');

// Puts an account on a subscription the provider says is alive and paid. Used by every message that can be the
// first to mention it (finished checkout, first paid invoice, a subscription update, the browser coming back),
// whichever arrives first. The answer says where things stand afterwards:
//   'on'      the account is on this subscription (it may have been already)
//   'dead'    the subscription is not alive: an old checkout replayed, a late message, or one we ended
//   'refused' it must not exist (the plan is free through a code, or the account already pays for another): it has
//             been ended, and its payment is refunded when it is reported
// The provider is always asked for the subscription's state now, unless the caller has just done so.
async function adopt(accountId: string, customer: string | null, subscriptionId: string | null, fresh?: any): Promise<'on' | 'dead' | 'refused'> {
  const a = account(accountId);
  if (!a || !subscriptionId) return 'dead';
  if (customer && !a.stripe_customer_id) run('UPDATE accounts SET stripe_customer_id=? WHERE id=?', customer, a.id);
  if (a.stripe_subscription_id === subscriptionId) {
    if (a.plan === 'grove' && hasSub(a)) return 'on';
    if (a.subscription_status === 'canceled') return 'dead';
  }
  const sub = fresh || (await stripe('GET', `subscriptions/${subscriptionId}`));
  if (!PAID_UP.includes(sub?.status)) return 'dead';
  if (a.promo_code || (hasSub(a) && a.stripe_subscription_id !== subscriptionId && LIVE.includes(a.subscription_status || ''))) {
    await endOrQueue(subscriptionId, a.id);
    if (!a.promo_code) await tellOperators(`A second subscription was started for ${a.name}`, [`Account ${a.id} already pays for subscription ${a.stripe_subscription_id}. The new one (${subscriptionId}) was ended automatically and its payment is refunded when it arrives. Check that nothing else is wrong.`], a.id);
    return 'refused';
  }
  const end = periodEnd(sub);
  run("UPDATE accounts SET plan='grove', stripe_customer_id=COALESCE(?, stripe_customer_id), stripe_subscription_id=?, subscription_status=?, renews_at=COALESCE(?, renews_at), cancel_at=?, cancel_ref=NULL, renewal_reminded=NULL, renewal_quoted_cents=NULL, dormant_kept_for=NULL, plan_started_at=?, sub_event_at=? WHERE id=?",
    customer, subscriptionId, sub.status, end, plannedEnd(sub), now(), unixNow(), a.id);
  log(a.id, 'started', `${PLAN_PRICE()} a month.`, subscriptionId);
  await mailAdmins(accountId, `Welcome to ${PRICING.planName}`, 'Thank you. Your signatures plant mangroves.', [
    `You are on the monthly plan: ${PLAN_PRICE()} a month adds ${sigs(PRICING.monthlySignatures)} to your balance with every payment. That is ${trees(PLAN_CENTS())} planted each month.`,
    ...(end ? [`Next charge: ${PLAN_PRICE()} on ${day(end)}, and every month after that until you cancel. We remind you a week before and again about a day before.`] : []),
    `Signatures never expire, so what you do not use rolls over. Need more? Top up any time at ${money(PRICING.topUpUsd * 100)} a signature.`,
    'It is month to month: no contract, no notice period, and nothing is ever charged unless you choose it. You get a receipt for every payment.',
    refundRuleText(refundDays()),
    'To stop renewing, use the Cancel button on the Plan page or the link below. It works without logging in.',
  ], 'stop');
  return 'on';
}

// Payments that arrived before we knew whose they were (the paid invoice can be reported before the finished
// checkout) are picked up as soon as the customer is known.
async function claimPayments(accountId: string) {
  const a = account(accountId);
  if (!a?.stripe_customer_id) return;
  for (const p of all("SELECT id FROM payments WHERE account_id IS NULL AND customer_id=? AND applied_at IS NULL AND kind IN ('plan','unknown')", a.stripe_customer_id)) {
    const inv = await stripe('GET', `invoices/${p.id}`).catch(() => null);
    if (inv?.id) await applyInvoice(inv);
  }
}

// Records a paid top-up and adds its signatures. Safe to call twice for the same payment.
async function applyTopUp(s: any): Promise<boolean> {
  if (s.metadata?.kind !== 'topup' || s.payment_status !== 'paid') return false;
  const a = account(s.client_reference_id);
  const cents = Number(s.amount_total) || 0;
  const currency = String(s.currency || 'usd').toLowerCase();
  // Never trust the count alone: it can be no more than what was actually paid for.
  const credits = currency === 'usd' ? Math.min(Math.round(Number(s.metadata?.credits)) || 0, Math.floor(cents / (PRICING.topUpUsd * 100))) : 0;
  const fresh = run("INSERT OR IGNORE INTO payments (id, account_id, amount_cents, currency, at, kind, credits, charge_id, customer_id, invoice_id) VALUES (?,?,?,?,?,'topup',?,?,?,?)",
    s.id, a?.id ?? null, cents, currency, now(), credits, sid(s.payment_intent), sid(s.customer), sid(s.invoice)).changes;
  if (!fresh) {
    // Seen before. All that can be new is the link to its invoice.
    if (s.invoice) await topUpReceipt(s.id, sid(s.invoice)!);
    return false;
  }
  const p = get('SELECT * FROM payments WHERE id=?', s.id);
  if (!a || credits < 1) {
    // Money we cannot give signatures for goes straight back, and a person hears about it.
    const why = !a ? 'the account this payment was for has been closed' : currency !== 'usd' ? 'we can only take payments in US dollars' : 'it was too small to buy a signature';
    await owe(a, p, cents, why);
    await tellOperators('A top-up could not be turned into signatures', [`Checkout ${s.id}, ${money(cents, currency)}, customer ${sid(s.customer) || 'unknown'}: ${why}. It is being refunded automatically. Check that it went through.`], a?.id);
    return false;
  }
  grant(a.id, credits, 'topup', s.id);
  run('UPDATE payments SET applied_at=? WHERE id=?', now(), s.id);
  if (s.customer && !a.stripe_customer_id) run('UPDATE accounts SET stripe_customer_id=? WHERE id=?', sid(s.customer), a.id);
  const receipt = s.invoice ? await topUpReceipt(s.id, sid(s.invoice)!) : null;
  await mailAdmins(a.id, `Receipt: ${money(cents, currency)} for ${sigs(credits)}`, `${sigs(credits)} added. Thank you.`, [
    `${money(cents, currency)} for ${a.name}, paid today. You now have ${sigs(Math.max(0, available(a.id)))} to send.`,
    `That plants ${trees(cents)} with Treegens.`,
    'This was a single payment. It does not repeat and does not change your plan. Signatures never expire.',
    refundRuleText(refundDays()),
    `Account: ${a.name}, reference ${a.id}. Receipts go to every owner and admin of the account.`,
  ], receipt ? { label: 'View invoice', url: receipt } : { label: 'Open the Plan page', url: planUrl() });
  return true;
}
// The provider makes an invoice for each top-up. Its link goes on the top-up's own row; it is not a second payment.
async function topUpReceipt(paymentId: string, invoiceId: string, inv?: any): Promise<string | null> {
  inv ||= await stripe('GET', `invoices/${invoiceId}`).catch(() => null);
  const url = inv?.hosted_invoice_url || inv?.invoice_pdf || null;
  if (url) run('UPDATE payments SET receipt_url=COALESCE(receipt_url, ?), invoice_id=COALESCE(invoice_id, ?) WHERE id=?', url, invoiceId, paymentId);
  return url;
}

// A finished checkout, from the provider's message or from the browser coming back, whichever is first.
async function applySession(s: any): Promise<void> {
  if (s.mode === 'payment') return void (await applyTopUp(s));
  const sub = sid(s.subscription);
  if (!sub || !['paid', 'no_payment_required'].includes(s.payment_status ?? 'paid') || !account(s.client_reference_id)) return;
  await adopt(s.client_reference_id, sid(s.customer), sub);
  await claimPayments(s.client_reference_id);
  // The first payment is applied here as well, so the signatures are there the moment checkout finishes.
  if (s.invoice) {
    const inv = await stripe('GET', `invoices/${sid(s.invoice)}`).catch(() => null);
    if (inv?.id) await applyInvoice(inv);
  }
}

// Coming back from checkout: apply the plan or the top-up now instead of waiting for the provider's event to arrive.
// The answer says what was actually applied, so the page never thanks anyone for a payment that did not happen:
// 'plan' or 'topup' when it is all there, 'plan-pending' when the plan is on and its signatures are still on their way.
route('POST', '/billing/sync', async (c) => {
  const sessionId = str((await c.body()).session_id, 200);
  let applied: 'plan' | 'plan-pending' | 'topup' | null = null;
  if (billingEnabled() && /^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    const s = await stripe('GET', `checkout/sessions/${sessionId}`).catch(() => null);
    if (s && s.client_reference_id === c.account.id)
      applied = await serial(async () => {
        await applySession({ ...s, id: s.id || sessionId });
        const a = account(c.account.id);
        if (s.mode === 'payment') return get('SELECT applied_at FROM payments WHERE id=? AND account_id=?', s.id || sessionId, a.id)?.applied_at ? 'topup' : null;
        if (!(a.plan === 'grove' && hasSub(a) && a.stripe_subscription_id === sid(s.subscription))) return null;
        return get("SELECT 1 x FROM payments WHERE account_id=? AND kind='plan' AND applied_at IS NOT NULL AND at > ?", a.id, new Date(Date.now() - 3600_000).toISOString()) ? 'plan' : 'plan-pending';
      });
  }
  return { ...billingState(account(c.account.id), c.user), applied };
}, 'admin');

// The provider's own page, for changing the card or downloading invoices. Available for as long as the account
// exists, also after cancelling.
route('POST', '/billing/portal', async (c) => {
  if (!billingEnabled() || !c.account.stripe_customer_id) throw bad('There is no payment method on this account.');
  const s = await stripe('POST', 'billing_portal/sessions', { customer: c.account.stripe_customer_id, return_url: planUrl() });
  return { url: s.url };
}, 'admin');

route('POST', '/billing/cancel', (c) => serial(() => cancelPlan(c.account, `in the app by ${c.user.name}`)), 'admin');

route('POST', '/billing/resume', (c) => serial(async () => {
  const a = account(c.account.id);
  if (a.promo_code) throw bad(`This plan is free with the code ${a.promo_code}. There is no paid plan to resume.`);
  if (!a.cancel_at || !hasSub(a)) throw bad('This plan is not set to end.');
  let sub: any;
  try {
    sub = await stripe('POST', `subscriptions/${a.stripe_subscription_id}`, { cancel_at_period_end: 'false' });
    if (sub?.status === 'canceled') throw new ProviderError('ended', false);
  } catch (e: any) {
    if (e instanceof ProviderError && e.unsure) throw e;
    // The provider will not take it back. If that is because the plan has already ended, say so and tidy up.
    const real = await stripe('GET', `subscriptions/${a.stripe_subscription_id}`).catch(() => null);
    if (real && real.status !== 'canceled' && !gone(e)) throw e;
    await applySubscription(a, real || { id: a.stripe_subscription_id, status: 'canceled' }, unixNow(), true);
    throw bad('This plan has already ended, so there is nothing to resume. You can start the monthly plan again whenever you like.', 409);
  }
  // Keeping the plan is a decision about this renewal: the "nobody is using it" rule leaves it alone.
  run('UPDATE accounts SET cancel_at=NULL, renews_at=?, dormant_kept_for=?, sub_event_at=? WHERE id=?', periodEnd(sub) || a.renews_at, (periodEnd(sub) || a.renews_at || '').slice(0, 10), unixNow(), a.id);
  log(a.id, 'resumed', `By ${c.user.name}.`, a.cancel_ref || '');
  const next = periodEnd(sub) || a.renews_at;
  await mailAdmins(a.id, `Your ${PRICING.planName} plan continues`, 'The cancellation was undone', [
    `${c.user.name} chose to keep the monthly plan for ${a.name}. ${next ? `The next charge is ${PLAN_PRICE()} on ${day(next)}.` : `It is billed ${PLAN_PRICE()} each month.`} We remind you before it happens.`,
    'To stop it again, use the Cancel button on the Plan page or the link below.',
  ], 'stop');
  return billingState(account(a.id), c.user);
}), 'admin');

// Self-serve refund of whatever has not been used from a payment. Refunding a monthly payment also ends the plan.
// With no payment named, it is the latest one.
route('POST', '/billing/refund', async (c) => {
  const want = str((await c.req.json().catch(() => ({})))?.payment_id, 200);
  return serial(async () => {
    const a = account(c.account.id);
    const offer = want ? offerFor(a, get('SELECT * FROM payments WHERE id=? AND account_id=?', want, a.id)) : refundOffer(a);
    if (!offer) throw bad(`${refundRuleText(refundDays())} There is nothing unused inside that window for this payment right now. If you think that is wrong, use the contact form and a person will look at it.`);
    const p = get('SELECT * FROM payments WHERE id=?', offer.payment_id);
    // Find the card charge before anything changes. If it cannot be found, nothing has happened yet.
    await chargeTarget(p, a);
    let planEnded = false;
    if (p.kind === 'plan' && hasSub(a)) {
      // The plan ends at the provider before any money moves. If that fails, nothing has changed and we say so.
      if (!(await endSubscription(a.stripe_subscription_id, true)))
        throw bad('We could not end the monthly plan with the payment provider just now, so nothing was refunded and nothing changed. Please try again in a minute.', 502);
      run("UPDATE accounts SET plan='seedling', subscription_status='canceled', cancel_at=NULL, renews_at=NULL, sub_event_at=? WHERE id=?", unixNow(), a.id);
      log(a.id, 'ended', 'Ended with the refund of its latest payment.');
      planEnded = true;
    }
    const ref = openRefund(a, p, offer.cents, offer.signatures, offer.reason, false);
    try {
      // 'pending' means the provider did not say whether it went through. The signatures stay off the balance and
      // the timer finds out; the customer is emailed when it is confirmed.
      const state = await tryRefund(ref);
      return { refunded: offer.amount, signatures: offer.signatures, reference: get('SELECT provider_id FROM refunds WHERE id=?', ref)?.provider_id || ref, plan_ended: planEnded, pending: state === 'pending' };
    } catch (e: any) {
      // The provider said no. The signatures go back on the balance.
      dropRefund(ref);
      if (!planEnded) throw e;
      await tellOperators(`A refund failed after the plan was ended: ${a.name}`, [`Account ${a.id}, payment ${p.id}, ${offer.amount}. The provider answered: ${e?.message}. The plan has been ended as part of the refund. Refund it by hand and write to the customer.`], a.id);
      throw bad('The monthly plan has been ended and you will not be charged again, but the payment provider would not make the refund itself. A person here has been told and will refund it by hand and write to you. You do not need to do anything.', 502);
    }
  });
}, 'admin');

// Take every saved payment method off file, at any time. If a plan is renewing it is set to end first, so nothing
// can fail to renew by surprise.
route('POST', '/billing/remove-card', (c) => serial(async () => {
  const a = account(c.account.id);
  if (!a.stripe_customer_id) throw bad('There is no card on this account.');
  const cancelled = hasSub(a) && !(a.cancel_at && PAID_UP.includes(a.subscription_status)) ? await cancelPlan(a, `in the app by ${c.user.name}, with the card removed`) : null;
  const pms = await stripe('GET', `customers/${a.stripe_customer_id}/payment_methods`, { limit: '100' });
  for (const pm of pms.data || []) await stripe('POST', `payment_methods/${pm.id}/detach`);
  if ((pms.data || []).length) log(a.id, 'card-removed', `By ${c.user.name}.`);
  return { removed: (pms.data || []).length, cancelled: !!cancelled };
}), 'admin');

// ---- Without logging in --------------------------------------------------------------------

route('GET', '/public/billing/stop', (c) => {
  const a = account(readStopToken(c.q.get('token')));
  if (!a) throw bad('This link has expired. Use "Find my subscription" below and we will email you a new one.', 410);
  const failing = hasSub(a) && !PAID_UP.includes(a.subscription_status);
  // free_with is set when the plan costs nothing through a code: there is nothing to stop.
  return {
    account: a.name, plan: a.plan, price: PRICING.monthlyUsd, free_with: a.promo_code || null, failing,
    can_cancel: renewing(a) || failing,
    renews_at: a.plan === 'grove' && renewing(a) && !failing ? a.renews_at : null, ends_at: a.promo_code || failing || !hasSub(a) ? null : a.cancel_at, cancel_ref: a.cancel_ref || null, signatures_left: Math.max(0, available(a.id)),
  };
}, 'public');

route('POST', '/public/billing/stop', async (c) => {
  rateLimit(`stop:${c.ip}`, 20, 3600_000);
  const a = account(readStopToken((await c.body()).token));
  if (!a) throw bad('This link has expired. Use "Find my subscription" and we will email you a new one.', 410);
  return serial(() => cancelPlan(a, 'from an email link'));
}, 'public');

// "I am being charged and cannot find where": emails every paid account this address administers, each with a stop link.
route('POST', '/public/billing/find', async (c) => {
  rateLimit(`find:${c.ip}`, 10, 3600_000);
  const email = str((await c.body()).email, 254).trim().toLowerCase();
  if (!isEmail(email)) throw bad('Enter a valid email address.');
  rateLimit(`find:${email}`, 3, 3600_000);
  const u = get('SELECT id, tz FROM users WHERE email=?', email);
  const rows = u ? all("SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role IN ('owner','admin')", u.id).filter(hasSub) : [];
  // Plans this person can see but not manage are named too, with who to ask, so a member is not told "nothing found".
  const others = u ? all("SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role='member'", u.id).filter(hasSub) : [];
  if (rows.length || others.length)
    await sendMail({
      to: email, subject: 'Your Sign&Grow subscriptions', heading: 'Your monthly plans',
      lines: [
        ...(rows.length ? ['You asked which paid plans are tied to this email address. Each link below stops that plan from renewing. No login needed.'] : []),
        ...others.map((a) => `${a.name} has a paid plan (${PLAN_PRICE()} a month) that you are a member of but do not manage. Its owner can stop it: ${admins(a.id).map((x) => x.name).join(', ') || 'see the Team page'}.`),
      ],
      links: rows.map((a) => ({ label: `Stop renewal for ${a.name}`, url: stopUrl(a.id, u.id), note: dated(a.cancel_at ? `already cancelled, ends ${day(a.cancel_at)}` : `${PLAN_PRICE()} a month${a.renews_at ? `, next charge ${day(a.renews_at)}` : ''}`, u.tz) })),
    });
  else
    await sendMail({ to: email, subject: 'Your Sign&Grow subscriptions', heading: 'No paid plans found', lines: ['There is no paid Sign&Grow plan tied to this email address, so we are not charging you.', 'If you see a charge from us anyway, it may be under a different address. On the help page you can stop it with the card instead: the last four digits plus the date and amount of the charge are enough.'], cta: { label: 'Stop it with the card', url: `${baseUrl()}/help#stop-by-card` } });
  return { ok: true };
}, 'public');

// Which accounts were charged on a card? Asked of the payment provider by the card's last four digits, narrowed by
// the date and amount of a charge. Used when the payer does not know which email address the account is under.
// A failure to ask is an error of its own, never "no match".
async function accountsByCard(last4: string, on?: string, cents?: number): Promise<any[]> {
  const q = [`payment_method_details.card.last4:"${last4}"`, 'status:"succeeded"'];
  const t = on ? Math.floor(Date.parse(on) / 1000) : NaN;
  if (Number.isFinite(t)) q.push(`created>${t - 2 * 86400}`, `created<${t + 3 * 86400}`);
  else q.push(`created>${unixNow() - 100 * 86400}`);
  if (cents) q.push(`amount:${cents}`);
  const customers = new Set<string>();
  let page: string | undefined;
  for (let i = 0; i < 5; i++) {
    const found: any = await stripe('GET', 'charges/search', { query: q.join(' AND '), limit: '100', ...(page ? { page } : {}) });
    for (const ch of found.data || []) if (sid(ch.customer)) customers.add(sid(ch.customer)!);
    if (!found.has_more || !found.next_page) break;
    page = found.next_page;
  }
  return [...customers].map((cu) => get('SELECT * FROM accounts WHERE stripe_customer_id=?', cu)).filter(Boolean);
}
const last4Of = (pm: any): string => pm?.[pm?.type]?.last4 || pm?.card?.last4 || '';

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
  const down = 'We could not check that with the payment provider just now, so nothing was changed. Please try again in a minute, or use the contact form and a person will stop it.';
  let rows: any[] = [];
  if (isEmail(email)) {
    rateLimit(`card:${email}`, 5, 3600_000);
    for (const a of all('SELECT DISTINCT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email=? AND a.stripe_customer_id IS NOT NULL', email).filter(hasSub)) {
      const pms = await stripe('GET', `customers/${a.stripe_customer_id}/payment_methods`, { limit: '100' }).catch(() => { throw bad(down, 502); });
      if ((pms.data || []).some((pm: any) => last4Of(pm) === last4)) rows.push(a);
    }
  } else {
    rateLimit(`card4:${last4}`, 5, 3600_000);
    rows = (await accountsByCard(last4, on, cents).catch(() => { throw bad(down, 502); })).filter(hasSub);
    // Without the email address the match has to be unambiguous before anything is stopped.
    if (rows.length > 1) throw bad('More than one plan matches those details. Add the account email address, or use the contact form and a person will sort it out.', 409);
  }
  if (!rows.length) throw bad('Those details do not match a paid plan. Check them against your card statement (a charge from the last few minutes may not show up yet), or use the contact form and a person will help.', 404);
  // Every plan that is paid with that card under that address is stopped, and each one is named.
  return serial(async () => {
    const stopped: any[] = [];
    for (const a of rows) stopped.push({ account: isEmail(email) ? a.name : undefined, ...(await cancelPlan(a, 'by the card holder, without logging in')) });
    return { stopped: true, ...stopped[0], all: stopped };
  });
}, 'public');

// ---- Events from the payment provider ------------------------------------------------------

// The provider signs each message. While its signing secret is being replaced it sends one signature per secret, so
// any of them matching is enough.
export function verifyStripeSignature(raw: string, header: string, secret: string, toleranceSec = 300): boolean {
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string]);
  const t = parts.find(([k]) => k === 't')?.[1];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = hmac(`${t}.${raw}`, secret);
  return parts.some(([k, v]) => k === 'v1' && !!v && safeEqual(expected, v));
}

// The payment a card charge belongs to: by the charge itself, its payment, or its invoice. Only when a monthly
// payment knows none of those is it matched by amount, and then to the payment made closest to the charge.
function paymentForCharge(ch: any, acct: any | null): any | null {
  const byId = get('SELECT * FROM payments WHERE charge_id IN (?,?) OR id=?', ch.id || '-', sid(ch.payment_intent) || '-', sid(ch.invoice) || '-');
  if (byId || !acct) return byId;
  const near = all("SELECT * FROM payments WHERE account_id=? AND charge_id IS NULL AND amount_cents=? AND kind IN ('plan','topup')", acct.id, ch.amount);
  const at = (ch.created || Date.now() / 1000) * 1000;
  return near.sort((x, y) => Math.abs(Date.parse(x.at) - at) - Math.abs(Date.parse(y.at) - at))[0] || null;
}

// Money went back to the customer by a road that was not our own refund (a person in the provider's dashboard, or
// the bank after a dispute). The signatures it paid for that are still unused leave the balance, like any refund.
function takeBack(acct: any | null, p: any, cents: number, ref: string): { taken: number; used: number } {
  const left = p.credits - (p.credits_refunded || 0);
  if (!acct || left <= 0 || !p.applied_at) return { taken: 0, used: 0 };
  const paidFor = Math.min(left, Math.round((cents / p.amount_cents) * p.credits));
  const taken = Math.min(paidFor, Math.max(0, available(acct.id)));
  if (taken > 0 && grant(acct.id, -taken, 'refund', ref)) run('UPDATE payments SET credits_refunded=credits_refunded+? WHERE id=?', taken, p.id);
  return { taken, used: paidFor - taken };
}

// Is this invoice ours at all? The provider account may be shared with other things. It is ours when it names one of
// our accounts, comes from a customer of ours, or is for our price. When none of that can be told it is kept aside
// without counting anywhere, and picked up if a checkout of ours later turns out to be its owner.
function ours(o: any, sub?: any): boolean {
  const price = process.env.STRIPE_PRICE_GROVE;
  return !!namedAccount(o) || !!sub?.metadata?.account_id || (!!price && (priceOf(o) === price || priceOf(sub || {}) === price)) || !!get('SELECT 1 x FROM accounts WHERE stripe_customer_id=?', sid(o.customer) || '-');
}

// A paid invoice: the monthly payment. Each one adds the plan's signatures to the balance, or goes straight back if
// it should never have been taken.
async function applyInvoice(o: any): Promise<void> {
  if (!o?.id || (o.status && o.status !== 'paid')) return;
  const cents = Number(o.amount_paid) || 0;
  const currency = String(o.currency || 'usd').toLowerCase();
  const customer = sid(o.customer);
  // The invoice the provider makes for a top-up is not a payment of its own: it only carries the top-up's receipt.
  if (o.metadata?.kind === 'topup' || o.billing_reason === 'manual') {
    const acctId = o.metadata?.account_id || get('SELECT id FROM accounts WHERE stripe_customer_id=?', customer || '-')?.id;
    const top = get("SELECT id FROM payments WHERE kind='topup' AND (invoice_id=? OR (account_id=? AND amount_cents=? AND invoice_id IS NULL)) ORDER BY at DESC LIMIT 1", o.id, acctId || '-', cents);
    if (top) await topUpReceipt(top.id, o.id, o);
    if (top || o.metadata?.kind === 'topup') return;
  }
  if (cents <= 0) return;
  let S = subOf(o);
  if (!S && !get('SELECT 1 x FROM payments WHERE id=? AND applied_at IS NOT NULL', o.id)) {
    // Some versions of the provider's messages do not say which subscription an invoice is for. Ask.
    const full = await stripe('GET', `invoices/${o.id}`).catch(() => null);
    if (full) S = subOf(full);
  }
  const named = namedAccount(o);
  let a = account(named) || (customer ? get('SELECT * FROM accounts WHERE stripe_customer_id=?', customer) : null);
  let sub: any = null;
  if (!a && !named && S) sub = await stripe('GET', `subscriptions/${S}`).catch(() => null);
  if (!a && sub?.metadata?.account_id) a = account(sub.metadata.account_id);
  const mine = ours(o, sub);
  const gonefor = named || sub?.metadata?.account_id || null; // an account this was for, which no longer exists
  const isPlan = !o.billing_reason || String(o.billing_reason).startsWith('subscription');
  // Signatures follow the money: the plan price buys the plan's signatures, a smaller invoice buys fewer, never more.
  const credits = isPlan && currency === 'usd' ? Math.min(PRICING.monthlySignatures, Math.floor((cents * PRICING.monthlySignatures) / PLAN_CENTS())) : 0;
  const fresh = run('INSERT OR IGNORE INTO payments (id, account_id, amount_cents, currency, at, receipt_url, kind, credits, charge_id, customer_id, subscription_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    o.id, a?.id ?? null, cents, currency, now(), o.hosted_invoice_url || o.invoice_pdf || null, !mine ? 'unknown' : isPlan ? 'plan' : 'other', credits, chargeOf(o), customer, S).changes;
  let p = get('SELECT * FROM payments WHERE id=?', o.id);
  if (p.applied_at) return;
  if (mine && p.kind === 'unknown') run('UPDATE payments SET kind=?, credits=? WHERE id=?', isPlan ? 'plan' : 'other', credits, o.id);
  const done = () => run('UPDATE payments SET applied_at=? WHERE id=?', now(), o.id);
  if (!mine) return; // not known to be ours: kept aside, counted nowhere
  if (!a) {
    if (gonefor) {
      // The account this was for has been closed and deleted. The money goes straight back.
      await endOrQueue(S);
      await owe(null, p, cents, 'the account this payment was for has been closed');
      done();
      await tellOperators('A payment arrived for an account that no longer exists', [`Invoice ${o.id}, ${money(cents, currency)}, customer ${customer}. It is being refunded automatically and the subscription ended. Check that both went through.`]);
    } else if (fresh) {
      // Usually the finished checkout simply has not been reported yet; it is picked up the moment it is.
      await tellOperators('A payment could not be matched to an account yet', [`Invoice ${o.id}, ${money(cents, currency)}, customer ${customer}. If it is the first payment of a new plan it is matched automatically when the checkout is reported. If nobody can be found for it within 3 days it is refunded automatically and you are told again.`]);
    }
    return;
  }
  if (!p.account_id) run('UPDATE payments SET account_id=? WHERE id=?', a.id, o.id);
  if (!p.charge_id) {
    // Remember which card charge this was, so a refund can never be sent to the wrong one.
    await chargeTarget({ ...p, account_id: a.id }, a).catch(() => null);
    p = get('SELECT * FROM payments WHERE id=?', o.id);
  }
  if (!isPlan) {
    done();
    await tellOperators(`An invoice that is not the monthly plan was paid by ${a.name}`, [`Invoice ${o.id}, ${money(cents, currency)}, account ${a.id}. It is not a top-up made in the app either. No signatures were added for it. Find out what it was for.`], a.id);
    return;
  }

  // Should this money have been taken at all?
  let why = '';
  if (currency !== 'usd') why = 'we can only take payments in US dollars';
  else if (a.promo_code) why = `your plan is free with the code ${a.promo_code}, so there is nothing to pay`;
  else if (S && a.stripe_subscription_id !== S) {
    // A subscription we have not been told about yet, or one that should not exist.
    const state = await adopt(a.id, customer, S, sub || undefined);
    if (state !== 'on') why = state === 'refused' ? 'this account already has a monthly plan, so this was a second charge' : 'this plan was already cancelled';
    a = account(a.id);
  } else if (!S && !hasSub(a)) {
    // No subscription named, and the account is on none. The first payment of a new plan waits for its checkout to
    // be reported (it is then settled from there). Anything else on a plan that has ended goes back.
    if (o.billing_reason !== 'subscription_cycle' && a.subscription_status !== 'canceled') return;
    why = 'this plan was already cancelled';
  } else if (a.subscription_status === 'canceled') why = 'this plan was already cancelled';
  else if (a.cancel_at) {
    // Cancelled, and this invoice pays for time after the end of the last paid month.
    const start = (o.lines?.data?.[0]?.period?.start ?? 0) * 1000;
    if (start ? start >= Date.parse(a.cancel_at) - 60_000 : Date.parse(a.cancel_at) < Date.now()) why = 'this plan was already cancelled';
  }
  if (why) {
    run('UPDATE payments SET credits=0 WHERE id=?', o.id);
    done();
    // Whatever charged this must not charge again.
    if (S && (currency !== 'usd' || a.promo_code || a.stripe_subscription_id !== S || a.subscription_status === 'canceled' || a.cancel_at)) await endOrQueue(S, a.id);
    await owe(a, { ...p, credits: 0 }, cents, why);
    return;
  }

  // A payment that got through brings a plan that was on hold back.
  if (a.plan !== 'grove' || a.subscription_status !== 'active')
    run("UPDATE accounts SET plan='grove', subscription_status=CASE WHEN subscription_status='trialing' THEN 'trialing' ELSE 'active' END WHERE id=?", a.id);
  grant(a.id, credits, 'plan', o.id);
  const next = iso(o.lines?.data?.[0]?.period?.end);
  if (next && (!a.renews_at || next > a.renews_at)) run('UPDATE accounts SET renews_at=? WHERE id=?', next, a.id);
  done();

  // The amount charged is the amount we said. At a renewal that is what the reminder said; otherwise it is the plan
  // price (before any tax). If more was taken, the difference goes back.
  const cycle = o.billing_reason === 'subscription_cycle';
  const paidFrom = iso(o.lines?.data?.[0]?.period?.start) || '';
  const reminded = !!paidFrom && String(a.renewal_reminded || '').startsWith(paidFrom.slice(0, 10));
  const said = cycle && reminded && a.renewal_quoted_cents ? a.renewal_quoted_cents : PLAN_CENTS() + taxOf(o);
  if (cents > said) {
    await owe(a, get('SELECT * FROM payments WHERE id=?', o.id), cents - said, `we said ${money(said, currency)} and ${money(cents, currency)} was charged`);
    await tellOperators(`${a.name} was charged more than we told them`, [`Invoice ${o.id}: we said ${money(said, currency)}, the charge was ${money(cents, currency)}. The difference is being refunded automatically. Check the price configured with the payment provider.`], a.id);
  } else if (cents - taxOf(o) !== PLAN_CENTS())
    await tellOperators(`A monthly payment from ${a.name} was not the plan price`, [`Invoice ${o.id} was ${money(cents, currency)}; the plan is ${PLAN_PRICE()}. ${sigs(credits)} were added. Check the price configured with the payment provider.`], a.id);
  if (cycle && paidFrom && !reminded)
    await tellOperators(`${a.name} was renewed without a reminder going out first`, [`Invoice ${o.id}. No renewal reminder is on record for the renewal of ${paidFrom.slice(0, 10)}. Check that the timer (POST /api/cron) is being called at least once an hour and that email is working.`], a.id);

  await mailAdmins(a.id, `Receipt: ${money(cents, currency)} for ${sigs(credits)}`, 'Payment received. Thank you.', [
    `${money(cents, currency)} for ${a.name}, charged today. ${sigs(credits)} added: you now have ${sigs(Math.max(0, available(a.id)))} to send.`,
    `That plants ${trees(Math.min(cents, said))} with Treegens.`,
    ...(next && !a.cancel_at ? [`Next charge: ${PLAN_PRICE()} on ${day(next)}. We remind you a week before and again about a day before.`] : []),
    refundRuleText(refundDays()),
    `Account: ${a.name}, reference ${a.id}. Receipts go to every owner and admin of the account.`,
  ], o.hosted_invoice_url ? { label: 'View invoice', url: o.hosted_invoice_url } : { label: 'Open the Plan page', url: planUrl() });
}

// The reminder before a renewal: once about a week before and once about a day before, each saying exactly what will
// be charged and when, each with a one-click way to stop it. Sent on our own timer; the provider's "upcoming invoice"
// message triggers the same thing and adds the exact amount. Every reminder is written to the plan history, and the
// amount in the latest one is what the charge is held to.
async function remindRenewal(acct: any, cents?: number | null, currency = 'usd'): Promise<boolean> {
  const a = account(acct.id);
  const when = a?.renews_at;
  if (!when || a.plan !== 'grove' || !renewing(a) || !PAID_UP.includes(a.subscription_status || '')) return false;
  const hours = (Date.parse(when) - Date.now()) / 36e5;
  if (hours <= 0 || hours > 7 * 24 + 1) return false;
  const key = when.slice(0, 10);
  const [k, sent = ''] = String(a.renewal_reminded || '').split('|');
  const already = k === key ? sent.split(',').filter(Boolean) : [];
  const told = k === key ? a.renewal_quoted_cents || 0 : 0;
  const amountCents = cents ?? (told || PLAN_CENTS());
  const amount = money(amountCents, currency);
  const stage = hours <= 26 ? '1' : '7';
  const due = !already.includes(stage) && !(stage === '7' && already.includes('1'));
  // The amount went up after we had already said a lower one: say so at once, whatever the stage.
  const raised = already.length > 0 && told > 0 && amountCents > told;
  if (!due && !raised) return false;
  // Nobody should be charged for something they stopped using. After a long quiet spell on the plan the renewal is
  // stopped for them, once, with one click to keep it. Set DORMANT_AUTO_STOP_DAYS=0 to only warn instead.
  const stopAfter = dormantStopDays();
  const since = new Date(Date.now() - stopAfter * 864e5).toISOString();
  if (stopAfter > 0 && a.dormant_kept_for !== key && !already.length && (a.plan_started_at || a.created_at) < since && a.created_at < since
    && get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at > ?", a.id, since).n === 0) {
    const r = await cancelPlan(a, `automatically, because nothing was sent in ${stopAfter} days`, true);
    await mailAdmins(a.id, 'We stopped your renewal so you are not charged for nothing', `You will not be charged on ${day(when)}`, [
      `${a.name} has not sent anything in ${stopAfter} days, so we turned the renewal off rather than charge you again. Reference ${r.reference}.`,
      `You keep the ${sigs(Math.max(0, available(a.id)))} you already have. They never expire.`,
      'If you want to keep the monthly plan (thank you: every dollar plants mangroves), press "Keep the plan after all" on the Plan page. We will not stop this renewal a second time.',
    ], { label: 'Keep my plan', url: planUrl() });
    return true;
  }
  run('UPDATE accounts SET renewal_reminded=?, renewal_quoted_cents=? WHERE id=?', `${key}|${[...new Set([...already, ...(due ? [stage] : [])])].join(',')}`, amountCents, a.id);
  log(a.id, 'reminder', raised && !due ? `The amount changed to ${amount}.` : `${stage === '1' ? 'About a day' : 'About a week'} before: ${amount}.`);
  const left = `You have ${sigs(Math.max(0, available(a.id)))} left at the moment. They roll over either way.`;
  const out = 'To keep planting mangroves, do nothing. To stop, use the link below. It takes one click, needs no login, and works right up to the charge.';
  if (raised && !due)
    await mailAdmins(a.id, `Correction: your plan renews on ${day(when)} for ${amount}, not ${money(told, currency)}`, 'The amount of your next charge changed', [
      `We told you ${money(told, currency)} for ${a.name}. The payment provider now says the charge on ${day(when)} will be ${amount}. That is the full amount, and if more than this is taken we send the difference back.`, left, out,
    ], 'stop');
  else
    await mailAdmins(a.id, stage === '1' ? `Last reminder: your plan renews on ${day(when)} for ${amount}` : `Heads up: your plan renews on ${day(when)} for ${amount}`, stage === '1' ? 'Your plan renews in about a day' : 'Your plan renews soon', [
      `On ${day(when)} we will charge ${amount} for ${a.name} and add ${sigs(PRICING.monthlySignatures)}. That is the full amount: there are no extras, and if more than this is ever taken we send the difference back.`, left, out,
    ], 'stop');
  return true;
}

// On the timer: remind everyone whose plan renews within a week.
export async function renewalReminders(): Promise<number> {
  if (!billingEnabled()) return 0;
  const rows = all("SELECT id FROM accounts WHERE plan='grove' AND promo_code IS NULL AND cancel_at IS NULL AND stripe_subscription_id IS NOT NULL AND renews_at > ? AND renews_at <= ?", now(), new Date(Date.now() + 7 * 864e5).toISOString());
  let n = 0;
  for (const a of rows) if (await serial(() => remindRenewal(a)).catch((e) => (console.error('[billing] reminder failed', a.id, e?.message), false))) n++;
  return n;
}

// How long to wait before the next try of something that keeps failing: at once for the first few, then longer.
const dueAgain = (tries: number, lastAt?: string | null) => tries < 5 || !lastAt || Date.now() - Date.parse(lastAt) > Math.min(6 * 3600_000, 2 ** (tries - 5) * 600_000);

// On the timer: whatever was owed to a customer and could not be done at the time (a refund, ending a subscription)
// is tried again until the provider confirms it, for as long as it takes. After three failures a person is told, and
// again every day it is still open. Payments nobody could be matched to are looked at again, and refunded after three
// days. Accounts whose state may have drifted from the provider's (a lost message) are read back from the provider.
export async function billingRetries(): Promise<number> {
  if (!billingEnabled()) return 0;
  let n = 0;
  for (const r of all("SELECT * FROM refunds WHERE status='pending' ORDER BY at LIMIT 50")) {
    if (!dueAgain(r.tries, r.last_at)) continue;
    const before = r.tries;
    const state = await serial(async () => {
      try {
        return await tryRefund(r.id);
      } catch (e: any) {
        // The provider said no to a refund a customer asked for: undo it and get a person involved.
        if (!r.auto) {
          dropRefund(r.id);
          await tellOperators('A refund a customer asked for was refused by the payment provider', [`Refund ${r.id}, payment ${r.payment_id}${r.account_id ? `, account ${r.account_id}` : ''}: ${e?.message}. Their signatures are back on the balance. Refund it by hand and write to them.`], r.account_id);
          if (r.account_id) await mailAdmins(r.account_id, 'Your refund needs a person', 'We could not send your refund automatically', ['The payment provider would not make the refund you asked for. The signatures are back on your balance, and a person here has been told and will refund it by hand and write to you. You do not need to do anything.']);
        }
        return 'failed';
      }
    });
    if (state === 'done') n++;
    else if (before + 1 === 3 || (before + 1) % 24 === 0)
      await tellOperators('A refund we owe has not gone through yet', [`Refund ${r.id} for payment ${r.payment_id}${r.account_id ? ` (account ${r.account_id})` : ''}, ${(r.cents / 100).toFixed(2)}: ${r.why}. Tried ${before + 1} times. We keep trying; if the provider's dashboard shows why, fix it there or refund it by hand and it will be recorded here.`], r.account_id);
  }
  for (const t of all('SELECT * FROM billing_todo WHERE done_at IS NULL ORDER BY id LIMIT 50')) {
    if (!dueAgain(t.tries, t.last_at)) continue;
    if (await serial(() => endSubscription(t.ref, true)).catch(() => false)) {
      run('UPDATE billing_todo SET done_at=? WHERE id=?', now(), t.id);
      n++;
    } else {
      run('UPDATE billing_todo SET tries=tries+1, last_at=? WHERE id=?', now(), t.id);
      if (t.tries + 1 === 3 || (t.tries + 1) % 24 === 0)
        await tellOperators('A subscription that must end is still alive at the payment provider', [`Subscription ${t.ref}${t.account_id ? ` (account ${t.account_id})` : ''} could not be ended after ${t.tries + 1} tries. We keep trying; end it by hand in the provider's dashboard so it cannot charge.`], t.account_id);
    }
  }
  // Payments of ours that nobody could be matched to.
  for (const p of all("SELECT * FROM payments WHERE account_id IS NULL AND applied_at IS NULL AND kind='plan' AND at < ? LIMIT 20", new Date(Date.now() - 3600_000).toISOString())) {
    await serial(async () => {
      const inv = await stripe('GET', `invoices/${p.id}`).catch(() => null);
      if (inv?.id) await applyInvoice(inv);
      const again = get('SELECT * FROM payments WHERE id=?', p.id);
      if (again.applied_at || again.account_id || Date.parse(again.at) > Date.now() - 3 * 864e5) return;
      run('UPDATE payments SET applied_at=?, credits=0 WHERE id=?', now(), p.id);
      await endOrQueue(again.subscription_id);
      await owe(null, again, again.amount_cents, 'we could not tell which account this payment was for');
      await tellOperators('An unmatched payment was refunded after three days', [`Invoice ${p.id}, ${money(p.amount_cents, p.currency)}, customer ${p.customer_id}. Nobody could be found for it, so it is being refunded and its subscription ended. Check that both went through.`]);
    });
  }
  // Accounts that should have heard from the provider by now: a cancelled plan whose end has passed, or a renewal
  // date that came and went. The provider is asked what is true.
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const twoDaysAgo = new Date(Date.now() - 2 * 864e5).toISOString();
  for (const a of all('SELECT * FROM accounts WHERE stripe_subscription_id IS NOT NULL AND promo_code IS NULL AND ((cancel_at IS NOT NULL AND cancel_at < ?) OR (renews_at IS NOT NULL AND renews_at < ?)) LIMIT 20', hourAgo, twoDaysAgo).filter(hasSub)) {
    await serial(async () => {
      const sub = await stripe('GET', `subscriptions/${a.stripe_subscription_id}`).catch((e) => (gone(e) ? { id: a.stripe_subscription_id, status: 'canceled' } : null));
      if (sub) await applySubscription(account(a.id), sub, unixNow(), sub.status === 'canceled');
    });
  }
  run('DELETE FROM stripe_events WHERE at < ?', new Date(Date.now() - 60 * 864e5).toISOString());
  run("DELETE FROM payments WHERE kind='unknown' AND account_id IS NULL AND at < ?", new Date(Date.now() - 90 * 864e5).toISOString());
  return n;
}

// What the provider says about the subscription an account is on, applied to the account. Used for its messages and
// for reading the state back when a message may have been lost.
async function applySubscription(a: any, o: any, at: number, ended: boolean) {
  const live = !ended && LIVE.includes(o.status);
  const end = periodEnd(o);
  const endsAt = live ? plannedEnd(o) : null;
  run('UPDATE accounts SET plan=?, subscription_status=?, renews_at=?, cancel_at=?, sub_event_at=? WHERE id=?', live ? 'grove' : 'seedling', ended ? 'canceled' : o.status,
    live ? end || a.renews_at : null, endsAt, at || a.sub_event_at || null, a.id);
  if (ended && a.subscription_status !== 'canceled') {
    log(a.id, 'ended', 'The monthly plan ended.', a.cancel_ref || '');
    if (a.plan === 'grove')
      await mailAdmins(a.id, 'Your monthly plan has ended', 'Your plan has ended', ['You will not be charged again. Nothing was deleted: every document, audit trail and receipt is still in your account.', `You still have ${sigs(Math.max(0, available(a.id)))}. They never expire, and signing your own documents is always free. Come back to the monthly plan whenever you like.`]);
  } else if (!live && !ended && a.plan === 'grove')
    await mailAdmins(a.id, 'Your monthly plan is on hold', 'Your plan is on hold because a payment did not go through', [
      'Nothing is locked and nothing is deleted. The signatures you already have stay yours and still work.',
      'To bring the plan back, update the card on the Plan page. To end it for good, press Cancel there: the failed payment is then not tried again.',
    ], { label: 'Open the Plan page', url: planUrl() });
  else if (live && endsAt && !a.cancel_at) {
    // Cancelled somewhere other than here (the provider's own page). Same reference, history line and email.
    const reference = newReference(a);
    run('UPDATE accounts SET cancel_ref=? WHERE id=?', reference, a.id);
    log(a.id, 'cancelled', "Cancelled on the payment provider's page.", reference);
    await mailAdmins(a.id, `Your ${PRICING.planName} plan is cancelled`, 'Cancelled. You will not be charged again.', [
      ...cancelLines(a, reference, "on the payment provider's page", [`The plan runs until ${day(endsAt)}. No more payments are taken after that.`]),
      'If a charge ever appears after this date, we refund it automatically.',
    ], { label: 'Changed your mind? Resume', url: planUrl() });
  } else if (live && !endsAt && a.cancel_at) {
    log(a.id, 'resumed', "On the payment provider's page.", a.cancel_ref || '');
    await mailAdmins(a.id, `Your ${PRICING.planName} plan continues`, 'The cancellation was undone', [`The cancellation of the monthly plan for ${a.name} was undone on the payment provider's page. ${end ? `The next charge is ${PLAN_PRICE()} on ${day(end)}.` : ''} To stop it again, use the link below.`], 'stop');
  }
}

async function handleEvent(ev: any) {
  const o = ev?.data?.object || {};
  const byCustomer = () => (o.customer ? get('SELECT * FROM accounts WHERE stripe_customer_id=?', sid(o.customer)) : null);

  if ((ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') && o.client_reference_id) return applySession(o);

  // A slow payment method (bank debit, pay later) that did not go through in the end.
  if (ev.type === 'checkout.session.async_payment_failed' && o.client_reference_id) {
    if (account(o.client_reference_id))
      await mailAdmins(o.client_reference_id, 'Your payment did not go through', 'A payment failed', ['The payment you started did not go through in the end, so nothing was added and nothing was charged. You can try again from the Plan page whenever you like.'], { label: 'Open the Plan page', url: planUrl() });
    return;
  }

  if (ev.type === 'invoice.paid' || ev.type === 'invoice.payment_succeeded') return applyInvoice(o);

  // Sent by the provider some days before each renewal, with the exact amount it is going to charge.
  if (ev.type === 'invoice.upcoming') {
    const a = byCustomer();
    if (!a || (subOf(o) && subOf(o) !== a.stripe_subscription_id)) return;
    // The renewal is the end of the period we already know. If we do not know it yet, take it from the message.
    const theirs = iso(o.period_end || o.next_payment_attempt);
    if (theirs && (!a.renews_at || Math.abs(Date.parse(a.renews_at) - Date.parse(theirs)) > 3 * 864e5)) run('UPDATE accounts SET renews_at=? WHERE id=?', theirs, a.id);
    await remindRenewal(a, o.amount_due ?? null, o.currency || 'usd');
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
    const a = byCustomer() || account(o.metadata?.account_id);
    if (!a) return;
    if (a.promo_code) {
      // The plan is free through a code, so nothing may be charged for it. A paid subscription that is still alive
      // is ended; one winding down changes nothing.
      if (!ended) await endOrQueue(o.id, a.id);
      return;
    }
    if (a.stripe_subscription_id !== o.id) {
      // Not the subscription this account is on. An old one winding down is none of today's business. One that
      // claims to be alive is checked with the provider (the message may be days old) and taken up only if it
      // really is alive and paid; a second one next to a plan that is already paid for is ended and refunded.
      if (!ended && PAID_UP.includes(o.status) && (await adopt(a.id, sid(o.customer), o.id)) === 'on') await claimPayments(a.id);
      return;
    }
    // Messages can arrive late and out of order. An older one never overwrites what a newer one, or the customer's
    // own click here, already said.
    const at = Number(ev.created) || 0;
    if (at && a.sub_event_at && at < a.sub_event_at) return;
    if (a.subscription_status === 'canceled' && !ended) {
      // We ended this one. If the provider still shows it alive, make sure it is ended there too.
      await endOrQueue(o.id, a.id);
      return;
    }
    await applySubscription(a, o, at, ended);
    return;
  }

  if (ev.type === 'charge.refunded') {
    // Our own refunds come back through here and change nothing: they are already on record, or are recorded now
    // if their answer had been lost. A refund made outside the app (by a person in the provider's dashboard) is
    // recorded too, and takes the unused signatures of that payment with it.
    const a = byCustomer();
    let p = paymentForCharge(o, a);
    if (!p) return;
    for (const r of all("SELECT id FROM refunds WHERE payment_id=? AND status='pending' AND tries > 0", p.id)) await tryRefund(r.id).catch(() => {});
    p = get('SELECT * FROM payments WHERE id=?', p.id);
    const total = Math.min(p.amount_cents, Number(o.amount_refunded ?? o.amount) || 0);
    const extra = total - p.refunded_cents;
    if (extra <= 0 || refundInFlight(p.id)) return;
    run('UPDATE payments SET refunded_at=COALESCE(refunded_at, ?), refunded_cents=? WHERE id=?', now(), total, p.id);
    const acct = account(p.account_id);
    const { taken, used } = takeBack(acct, p, extra, `out:${o.id}:${total}`);
    if (acct) log(acct.id, 'refund', `${money(extra, p.currency)} refunded by the payment provider.${taken ? ` ${sigs(taken)} left the balance with it.` : ''}`);
    await tellOperators(`A refund made outside the app was recorded${acct ? `: ${acct.name}` : ''}`, [`Payment ${p.id}: ${money(extra, p.currency)} went back to the card. ${sigs(taken)} it had paid for were unused and were taken off the balance${used ? `; ${sigs(used)} had already been used and stay used` : ''}.`], acct?.id);
    return;
  }

  // A card dispute means the customer wants out. All further billing stops at once, new payments are switched off
  // until a person has looked, and the unused signatures the disputed payment bought leave the balance, so nobody
  // ends up with the money and the signatures. Small disputes are accepted with the provider rather than fought
  // (ACCEPT_DISPUTES_UP_TO_USD, 0 to leave them all to a person). Disputes on charges that are not ours are left alone.
  if (ev.type === 'charge.dispute.created') {
    const charge = o.charge && billingEnabled() ? await stripe('GET', `charges/${sid(o.charge)}`).catch(() => null) : null;
    const byCharge = charge?.customer ? get('SELECT * FROM accounts WHERE stripe_customer_id=?', sid(charge.customer)) : null;
    const p = charge ? paymentForCharge(charge, byCharge) : null;
    if (!p) return;
    const a = account(p.account_id) || byCharge;
    const amount = Number(o.amount ?? charge?.amount ?? p.amount_cents) || p.amount_cents;
    const limit = process.env.ACCEPT_DISPUTES === '0' ? 0 : (process.env.ACCEPT_DISPUTES_UP_TO_USD === undefined ? 25 : Number(process.env.ACCEPT_DISPUTES_UP_TO_USD) || 0) * 100;
    const accepted = !!o.id && amount <= limit && (await stripe('POST', `disputes/${o.id}/close`).then(() => true).catch(() => false));
    const { taken, used } = takeBack(a, p, p.amount_cents - p.refunded_cents, `dispute:${p.id}`);
    run('UPDATE payments SET refunded_at=COALESCE(refunded_at, ?), refunded_cents=amount_cents WHERE id=?', now(), p.id);
    const forOps = accepted ? 'The dispute was accepted with the payment provider automatically, so the bank returns the money.'
      : `The dispute was NOT accepted automatically (${amount > limit ? 'it is above the amount that is conceded without a person' : 'the provider did not take it'}). Decide in the provider's dashboard whether to accept or answer it.`;
    if (!a) return tellOperators('Card dispute on a payment whose account no longer exists', [`Dispute ${o.id}, payment ${p.id}. ${forOps}`]);
    const hadPlan = hasSub(a);
    const stopped = !hadPlan || (await endOrQueue(a.stripe_subscription_id, a.id));
    run("UPDATE accounts SET dispute_at=?, plan=CASE WHEN promo_code IS NULL THEN 'seedling' ELSE plan END, subscription_status=CASE WHEN promo_code IS NULL THEN 'canceled' ELSE subscription_status END, cancel_at=NULL, renews_at=NULL, sub_event_at=? WHERE id=?", now(), unixNow(), a.id);
    log(a.id, 'dispute', `A payment of ${money(amount, p.currency)} was disputed with the bank. Payments are switched off until a person has looked.${taken ? ` ${sigs(taken)} left the balance with it.` : ''}`, o.id || '');
    await mailAdmins(a.id, 'A payment was disputed, so we stopped billing you', 'A payment was disputed with your bank', [
      `A payment of ${money(amount, p.currency)} to Sign&Grow was disputed with the card's bank. ${accepted ? 'We are not contesting it: the bank returns the money to the card.' : 'A person here will look at it and write to you.'}`,
      ...(hadPlan ? ['Your monthly plan has ended and nothing more will be charged.'] : a.promo_code ? [`Your plan stays free with the code ${a.promo_code}.`] : []),
      taken ? `The ${sigs(taken)} that payment bought and that had not been used have left your balance, as with any refund. You have ${sigs(Math.max(0, available(a.id)))} now.` : 'Your balance is unchanged.',
      'Nothing was deleted. New payments are switched off on this account for now. If the dispute was a mistake, reply to this email or use the contact form and a person will switch them back on.',
    ], { label: 'Contact us', url: `${baseUrl()}/help?topic=billing#contact` });
    await tellOperators(`Card dispute: ${a.name}`, [`Account ${a.name} (${a.id}), dispute ${o.id}, ${money(amount, p.currency)}. Billing was stopped${stopped ? '' : ', but the provider did not confirm the subscription ended (we keep trying)'}. ${forOps} ${sigs(taken)} were taken off the balance; ${sigs(used)} bought with that payment had already been used. New payments stay off until you clear it in the operator queue. The customer has been told in writing.`], a.id);
  }
}

// The provider repeats its messages, and sends several at once. Each one is applied once and in turn; one that
// failed half way is applied again in full, and every step above is safe to repeat.
export const applyStripeEvent = (ev: any): Promise<void> => serial(async () => {
  if (ev?.id && get('SELECT id FROM stripe_events WHERE id=?', ev.id)) return;
  await handleEvent(ev);
  if (ev?.id) run('INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?,?)', ev.id, now());
});

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
  const rows = all("SELECT * FROM accounts WHERE plan='grove' AND promo_code IS NULL AND cancel_at IS NULL AND stripe_subscription_id IS NOT NULL AND (dormant_nudged_at IS NULL OR dormant_nudged_at < ?) AND created_at < ? AND COALESCE(plan_started_at, created_at) < ?", cutoff, cutoff, cutoff)
    .filter((a) => hasSub(a) && get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at > ?", a.id, cutoff).n === 0);
  for (const a of rows) {
    run('UPDATE accounts SET dormant_nudged_at=? WHERE id=?', now(), a.id);
    await mailAdmins(a.id, 'Still using Sign&Grow?', 'You are on the monthly plan but have not sent anything in 60 days', [
      `${a.name} pays ${PLAN_PRICE()} a month and has ${sigs(Math.max(0, available(a.id)))} saved up. Every dollar plants mangroves, and we are grateful. But we would rather you paid on purpose.`,
      'If you are not using it, stop the renewal with the link below. You keep every document and every signature you have already paid for.',
    ], 'stop');
  }
  return rows.length;
}

// ---- For the people running the service --------------------------------------------------------

const operator = (c: any) => {
  const ops = (process.env.OPERATOR_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (!c.user?.email_verified || !ops.includes(String(c.user.email).toLowerCase())) throw new HttpError(404, 'Not found');
};

// Find the account behind a charge from what a caller can read off their card statement.
route('GET', '/operator/billing/lookup', async (c) => {
  operator(c);
  const last4 = str(c.q.get('last4'), 4).replace(/\D/g, '');
  if (last4.length !== 4) throw bad('Enter the last four digits of the card.');
  if (!billingEnabled()) throw bad('Billing is not set up on this server.', 501);
  const cents = Math.round(Number(c.q.get('amount') || 0) * 100) || undefined;
  const rows = await accountsByCard(last4, str(c.q.get('charged_on'), 10) || undefined, cents);
  return { accounts: rows.map((a) => ({ id: a.id, name: a.name, plan: a.plan, status: a.subscription_status, free_with: a.promo_code || null, renews_at: a.renews_at, ends_at: a.cancel_at, disputed: !!a.dispute_at, admins: admins(a.id).map((u) => ({ name: u.name, email: u.email })) })) };
});

// Accounts whose payments are switched off after a card dispute, for the operator page.
route('GET', '/operator/billing/disputed', (c) => {
  operator(c);
  return { accounts: all('SELECT * FROM accounts WHERE dispute_at IS NOT NULL ORDER BY dispute_at DESC LIMIT 100').map((a) => ({ id: a.id, name: a.name, plan: a.plan, free_with: a.promo_code || null, dispute_at: a.dispute_at, signatures: available(a.id), admins: admins(a.id).map((u) => ({ name: u.name, email: u.email })) })) };
});

// After a card dispute payments stay off until a person has looked. This switches them back on.
route('POST', '/operator/billing/accounts/:id/clear-dispute', (c) => {
  operator(c);
  const a = account(c.params.id);
  if (!a) throw bad('Account not found.', 404);
  run('UPDATE accounts SET dispute_at=NULL WHERE id=?', a.id);
  log(a.id, 'dispute', `Payments switched back on by ${c.user.name}.`);
  return { ok: true };
});
