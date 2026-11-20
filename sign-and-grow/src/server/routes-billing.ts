import { route } from './router.ts';
import { all, get, run, fillPrices } from './db.ts';
import { bad, hmac, now, id, isEmail, str, rateLimit, baseUrl, safeEqual, HttpError } from './util.ts';
import { sendMail } from './mail.ts';
import { billingEnabled } from './envelopes.ts';
import { grant, creditSummary, available, balance, findFreeCode, paidAvailable } from './credits.ts';
import { PRICING, mangrovesFor } from '../lib/impact.ts';
import { refundDays, dormantStopDays, refundRuleText, newAccountDailyRecipients, unpaidDailyRecipients, PRICE_NOTICE_DAYS, priceRuleText, priceChangeDay } from '../lib/policy.ts';

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
//     itself. If the payment provider is down at that moment it is tried again on the timer until it goes through;
//     if the provider refuses it three times, a person sends it by hand and the customer is told.
//   - Stopping payment never deletes or locks anything, and signatures already paid for stay usable.
//   - The payment provider does not promise the order of its messages, and sends several in the same second. Each
//     account's messages are applied one at a time (see serial()), and a message that needs an earlier one (the
//     decision on a dispute before the dispute itself) waits for it, so the outcome does not depend on their order.

const money = (cents: number, currency = 'usd') => new Intl.NumberFormat('en', { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(cents / 100);
const iso = (unix?: number | null) => (unix ? new Date(unix * 1000).toISOString() : null);
const sid = (x: any): string | null => (typeof x === 'string' ? x : x?.id || null);
const sigs = (n: number) => `${n} signature${n === 1 ? '' : 's'}`;
const PLAN_CENTS = () => PRICING.monthlyUsd * 100;
const PLAN_PRICE = () => money(PLAN_CENTS());
// The monthly price an account is on, before tax, for a renewal at `at`. An account keeps the price it has been
// paying, whatever the price for new customers is today, until it has been told of a higher one at least
// PRICE_NOTICE_DAYS before the day that price starts (see /operator/billing/price-notice). A lower price needs no
// notice: it simply applies when it is charged.
const noticed = (a: any, at?: string | null): boolean =>
  !!a?.price_notice_cents && !!a.price_notice_from && !!a.price_notice_at && !!at && at >= a.price_notice_from
  && Date.parse(a.price_notice_from) - Date.parse(a.price_notice_at) >= PRICE_NOTICE_DAYS * 864e5 - 3600_000;
const priceFor = (a: any, at?: string | null): number => (noticed(a, at) ? Math.max(a.price_notice_cents, a.price_cents || 0) : a?.price_cents || PLAN_CENTS());
// The price this account's next renewal is charged at (before tax). This, never the price for new customers, is what
// every page and email about an existing plan quotes.
const chargePrice = (a: any): number => priceFor(a, a?.renews_at || now());
// What the next charge will really be: the amount a reminder told them for it if one went out, else that price plus
// the tax added on top last time.
const nextCents = (a: any): number => {
  const told = a?.renewal_quoted_cents && String(a.renewal_reminded || '').startsWith((a.renews_at || '-').slice(0, 10)) ? a.renewal_quoted_cents : 0;
  return told || chargePrice(a) + (a?.renewal_tax_cents || 0);
};
// Every account has the price it is on written down: once when the server starts (fillPrices in db.ts, also used by
// the tests to stand for a restart) and whenever a new subscription is taken up (adopt).
export const backfillPrices = () => fillPrices();
// Did an email leave? Only when the mail server took it. With no mail server it sits in the outbox, which counts
// only on a development server, where the outbox is where people read their mail.
const mailLeft = (status: string) => status === 'sent' || (status === 'outbox' && (process.env.NODE_ENV !== 'production' || process.env.DEV_OUTBOX === '1'));
const trees = (cents: number) => `${mangrovesFor(cents / 100).toLocaleString('en')} mangrove trees`;
const planUrl = () => `${baseUrl()}/app/settings?tab=billing`;
// An account with a subscription always has its price written down (fillPrices does that at start). Should one turn
// up without it anyway (a row restored from an old backup while the server runs), it is written down the same way
// before anything about money reads it, so it is never taken to be on the price for new customers.
const account = (accountId: any) => {
  const a = accountId ? get('SELECT * FROM accounts WHERE id=?', accountId) : null;
  if (!a || a.price_cents != null || !a.stripe_subscription_id) return a;
  fillPrices();
  return get('SELECT * FROM accounts WHERE id=?', accountId);
};

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

// Everything that changes money or a plan runs one at a time for each account. The provider sends "checkout
// finished", "invoice paid" and "subscription updated" within the same second, and people double-click; taking them
// in turn means each step sees what the one before it did. Each account has its own queue, so one customer's slow
// call never holds up another's. The queues live on globalThis because the server is built into more than one
// bundle (the API routes and the built-in timer), and they must share them. Only entry points (routes, a provider
// message, a timer item) may call this: calling it for the same account from inside itself would wait for ever.
const queues: Map<string, Promise<unknown>> = ((globalThis as any).__sgBillingQueues ??= new Map());
function serial<T>(key: string | null | undefined, fn: () => Promise<T> | T): Promise<T> {
  const k = key || 'nobody';
  const next = (queues.get(k) || Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(k, tail);
  void tail.then(() => queues.get(k) === tail && queues.delete(k));
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
  // Without a pinned version the provider answers in whatever version the connected account defaults to, which can
  // change under a running server. A production server says so loudly, once.
  if (!process.env.STRIPE_API_VERSION && process.env.NODE_ENV === 'production' && !(globalThis as any).__sgStripeVersionWarned) {
    (globalThis as any).__sgStripeVersionWarned = true;
    console.error('\n[config] STRIPE_API_VERSION IS NOT SET. Payment calls use whatever API version the Stripe account defaults to. Set it to the version you tested in test mode (and the webhook endpoint to the same), so the shapes the code reads stay the same.\n');
  }
  const qs = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1/${path}${method === 'GET' && qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        // Set STRIPE_API_VERSION to the version this was tested on, so the provider's answers keep that shape.
        ...(process.env.STRIPE_API_VERSION ? { 'stripe-version': process.env.STRIPE_API_VERSION } : {}),
      },
      body: method === 'POST' ? qs : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ProviderError('The payment provider could not be reached just now. Please try again in a minute.', true);
  }
  const data: any = await res.json().catch(() => ({}));
  // 5xx: it may or may not have happened. 429 and 409: too busy, or the same request is still in progress. All three
  // mean "ask again", not "no".
  if (!res.ok) throw new ProviderError(data?.error?.message || 'The payment provider returned an error.', res.status >= 500 || res.status === 429 || res.status === 409);
  return data;
}

// Stripe moved the period end from the subscription to its items in newer API versions. Read either.
const periodEnd = (sub: any): string | null => iso(sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end);
// When is this subscription set to end, if at all? Either "at the end of the period" or a date.
const plannedEnd = (sub: any): string | null => (sub?.cancel_at_period_end ? periodEnd(sub) : iso(sub?.cancel_at));
// The same goes for where an invoice names its subscription, the account it was started for, its price and charge.
const subOf = (o: any): string | null => sid(o.subscription) || sid(o.parent?.subscription_details?.subscription) || sid(o.lines?.data?.[0]?.subscription) || sid(o.lines?.data?.[0]?.parent?.subscription_item_details?.subscription);
// Everything we start at the provider carries the account it is for under a name of our own (sg_account), so a
// subscription or invoice that belongs to something else on the same provider account is never mistaken for ours.
const namedAccount = (o: any): string | null => o.subscription_details?.metadata?.sg_account || o.parent?.subscription_details?.metadata?.sg_account || o.lines?.data?.[0]?.metadata?.sg_account || o.metadata?.sg_account || null;
const wasDeleted = (accountId: any) => !!accountId && !!get('SELECT 1 x FROM deleted_accounts WHERE id=?', accountId);
const priceOf = (o: any): string | null => sid(o.lines?.data?.[0]?.price) || sid(o.lines?.data?.[0]?.pricing?.price_details?.price) || sid(o.lines?.data?.[0]?.plan) || sid(o.items?.data?.[0]?.price);
const chargeOf = (o: any): string | null => sid(o.payment_intent) || sid(o.charge) || sid(o.payments?.data?.[0]?.payment?.payment_intent) || sid(o.payments?.data?.[0]?.payment?.charge);
// The tax the provider adds on top of the price. A price can also have its tax inside it (the provider's "inclusive"
// tax): then what is charged is the price itself and nothing was added, so nothing may be allowed for it either.
// Older API versions flag each tax line `inclusive`, newer ones give `tax_behavior`; the price can carry it too. When
// none of that is given, a line whose price alone already makes up the whole amount has its tax inside.
const taxOf = (o: any): number => {
  const list: any[] = Array.isArray(o.total_taxes) && o.total_taxes.length ? o.total_taxes : Array.isArray(o.total_tax_amounts) ? o.total_tax_amounts : [];
  const total = Number(o.tax) || list.reduce((n: number, t: any) => n + (Number(t.amount) || 0), 0);
  if (!total) return 0;
  const inside = (t: any) => t?.inclusive === true || t?.tax_behavior === 'inclusive';
  const flagged = (ts: any[]) => ts.some((t) => typeof t?.inclusive === 'boolean' || t?.tax_behavior === 'inclusive' || t?.tax_behavior === 'exclusive');
  if (flagged(list)) return Math.max(0, total - list.filter(inside).reduce((n: number, t: any) => n + (Number(t.amount) || 0), 0));
  const line = o.lines?.data?.[0] || {};
  const lineTaxes: any[] = [...(Array.isArray(line.tax_amounts) ? line.tax_amounts : []), ...(Array.isArray(line.taxes) ? line.taxes : [])];
  if (flagged(lineTaxes)) return lineTaxes.some(inside) ? 0 : total;
  const behaviour = line.price?.tax_behavior || line.pricing?.price_details?.tax_behavior;
  if (behaviour === 'inclusive') return 0;
  if (behaviour === 'exclusive') return total;
  const unit = Number(line.price?.unit_amount ?? line.pricing?.unit_amount_decimal ?? line.plan?.amount ?? NaN);
  const charged = Number(o.amount_paid ?? o.amount_due ?? o.total ?? NaN);
  return Number.isFinite(unit) && unit > 0 && unit * (Number(line.quantity) || 1) === charged ? 0 : total;
};

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
  'code-ended': 'Free code ended', reminder: 'Renewal reminder sent', 'reminder-failed': 'Renewal reminder could not be delivered','auto-stop': 'Renewal stopped for you', dispute: 'Card dispute', 'card-removed': 'Card removed', paused: 'Payment failed', price: 'Price change announced',
};

type Cta = { label: string; url: string };
const admins = (accountId: string) => all("SELECT u.id, u.email, u.name, u.tz FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", accountId);

// Every email about money goes to all owners and admins, and carries the way out for as long as there is a renewal
// to stop: a link that turns it off without logging in.
// The answer is what became of each email ('sent', 'outbox' or 'failed'), for the places that must not claim one left.
async function mailAdmins(accountId: string, subject: string, heading: string, lines: string[], cta?: Cta | 'stop', expiresAt?: string): Promise<string[]> {
  const a = account(accountId);
  const out: string[] = [];
  for (const u of admins(accountId)) {
    const stop = { label: 'Stop renewing (no login needed)', url: stopUrl(accountId, u.id) };
    out.push(await sendMail({
      to: u.email, subject: dated(subject, u.tz), heading: dated(heading, u.tz), lines: lines.map((l) => dated(l, u.tz)),
      cta: cta === 'stop' ? stop : cta,
      // An email that is only worth reading before a certain moment is not retried after it.
      ...(expiresAt ? { expiresAt } : {}),
      links: cta !== 'stop' && a && renewing(a) ? [{ label: 'Do not renew', url: stop.url, note: 'Stops the monthly plan in one click, without logging in.' }] : undefined,
    }));
  }
  return out;
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

// 'manual' is a refund the software owes and the provider refused three times: a person sends it by hand.
const refundInFlight = (paymentId: string) => !!get("SELECT 1 x FROM refunds WHERE payment_id=? AND status IN ('pending','manual')", paymentId);

// The refund rule, in one place: within the window, every signature a payment bought that is still unused is refunded
// at the price paid for it. Nobody needs to approve it, and it can be done again later for signatures that come back
// (a voided envelope, say) while the window is open.
function offerFor(acct: any, p: any): Offer | null {
  if (!p || p.account_id !== acct.id || !p.applied_at || (p.kind !== 'plan' && p.kind !== 'topup')) return null;
  const left = p.credits - (p.credits_refunded || 0);
  const owing = p.amount_cents - p.refunded_cents;
  if (left <= 0 || owing <= 0 || refundInFlight(p.id) || p.disputed === 'open' || p.disputed === 'lost') return null;
  if ((Date.now() - Date.parse(p.at)) / 864e5 > refundDays()) return null;
  // Free signatures (welcome, free code) count as used first (paidAvailable), so a code entered later never makes a
  // payment whose signatures were used up refundable again.
  const paidLeft = paidAvailable(acct.id);
  const unused = Math.min(left, paidLeft, Math.max(0, available(acct.id)));
  if (unused <= 0) return null;
  const cents = Math.min(owing, Math.round((owing / left) * unused));
  if (cents <= 0) return null;
  const freeToo = Math.max(0, available(acct.id)) > paidLeft;
  return {
    payment_id: p.id, cents, amount: money(cents, p.currency), signatures: unused, of: p.credits, kind: p.kind, paid_at: p.at,
    // Said in terms of the balance, not of "these very signatures": signatures are not told apart once they are on it.
    reason: unused === p.credits ? `you have enough unused signatures to hand back all ${p.credits} it bought`
      : `you have ${unused} unused ${unused === 1 ? 'signature' : 'signatures'} to hand back out of the ${p.credits} it bought${freeToo ? ' (free signatures, the ones every new account gets and any from a code, count as used first)' : ''}`,
  };
}
// What the Plan page offers up front: the latest payment. Earlier ones inside the window are offered next to each
// payment in the list, and are refunded only when that payment is named.
// For the email that says an account was closed at once: refunds that are still on their way. They go through all
// the same (the timer keeps asking the provider, with or without the account), and a person refunds by hand one the
// provider will not take. Read before the account is deleted, while the rows still name it.
export function pendingRefundLines(accountIds: string[]): string[] {
  if (!accountIds.length) return [];
  const rows = all(`SELECT r.id, r.cents, p.currency FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE r.status='pending' AND r.account_id IN (${accountIds.map(() => '?').join(',')}) ORDER BY r.at`, ...accountIds);
  return rows.map((r) => `A refund of ${money(r.cents, r.currency)} (reference ${r.id}) is still on its way to the card it was paid with. It goes through even though the account is deleted: the payment provider has not confirmed it yet, and we keep asking until it has. If the provider will not take it, a person here refunds it by hand. You do not need to do anything. Banks usually show a refund within 5 to 10 working days.`);
}
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

// Records that a refund has reached the customer: once, whoever gets here first (the call itself, the timer, or the
// provider's own notice). `providerId` is the provider's reference, or 'outside' when the money went back by another
// road while ours was waiting (a person refunded the charge by hand, say).
// Why the software owes a refund nobody asked for, in the words the customer reads (page and email).
export const owedWhy = (why: string) => why === 'this plan was already cancelled' ? 'you were charged after the plan was cancelled'
  : why === 'this account already has a monthly plan, so this was a second charge' ? 'you were charged twice for the monthly plan' : why;
async function settleRefund(ref: string, providerId: string) {
  const r = get('SELECT * FROM refunds WHERE id=?', ref);
  if (!r || !run("UPDATE refunds SET status='done', provider_id=?, done_at=? WHERE id=? AND status IN ('pending','manual')", providerId, now(), ref).changes) return;
  const p = get('SELECT * FROM payments WHERE id=?', r.payment_id);
  run('UPDATE payments SET refunded_at=COALESCE(refunded_at, ?), refunded_cents=MIN(amount_cents, refunded_cents+?), credits_refunded=credits_refunded+? WHERE id=?', now(), r.cents, r.signatures, p.id);
  if (!account(r.account_id)) return;
  log(r.account_id, 'refund', `${money(r.cents, p.currency)}: ${r.why}`, providerId === 'outside' ? '' : providerId);
  await mailAdmins(r.account_id, `Refund sent: ${money(r.cents, p.currency)}`, 'Your refund is on its way', [
    `We refunded ${money(r.cents, p.currency)} to the card it was paid with (${r.auto ? owedWhy(r.why) : r.why}).`,
    `${providerId === 'outside' ? 'It was sent by a person here.' : `Refund reference: ${providerId}.`} Banks usually show it within 5 to 10 working days.`,
  ]);
}

// How much of a charge has gone back so far, as the provider knows it. null when that cannot be told right now.
async function refundedAtProvider(target: Record<string, string>): Promise<number | null> {
  try {
    if (target.charge) return Number((await stripe('GET', `charges/${target.charge}`)).amount_refunded) || 0;
    const list = await stripe('GET', 'charges', { payment_intent: target.payment_intent, limit: '1' });
    return list.data?.[0] ? Number(list.data[0].amount_refunded) || 0 : null;
  } catch {
    return null;
  }
}

// Sends one refund to the provider, or finds that it already went through. The provider is given our own reference
// for it, and is always asked first whether a refund with that reference exists (an earlier try may have gone
// through with its answer lost, or the server may have stopped half way), so nothing is ever sent twice. Returns
// 'done', or 'pending' when the provider's answer is unknown (the timer then asks again). Throws when the provider
// says a clear no and the money has not gone back some other way either.
async function tryRefund(ref: string): Promise<'done' | 'pending'> {
  const r = get('SELECT * FROM refunds WHERE id=?', ref);
  if (!r || r.status !== 'pending') return 'done';
  const p = get('SELECT * FROM payments WHERE id=?', r.payment_id);
  let target: Record<string, string> | null = null;
  try {
    target = await chargeTarget(p, account(r.account_id));
    const list = await stripe('GET', 'refunds', { ...target, limit: '100' });
    // The key stays the same while the provider's answer is unknown, so it can only ever carry the request out once;
    // it changes after a clear refusal, so a later try is looked at afresh.
    const out = (list.data || []).find((x: any) => x.metadata?.sg_ref === ref)
      || (await stripe('POST', 'refunds', { ...target, amount: String(r.cents), 'metadata[sg_ref]': ref }, `${ref}-${r.refused || 0}`));
    await settleRefund(ref, out.id);
    return 'done';
  } catch (e: any) {
    const unsure = e instanceof ProviderError && e.unsure;
    run(`UPDATE refunds SET tries=tries+1, last_at=?${unsure ? '' : ', refused=refused+1'} WHERE id=?`, now(), ref);
    if (unsure) return 'pending';
    // A clear no. If that is because the money has already gone back another way, the refund is done.
    const total = target ? await refundedAtProvider(target) : null;
    if (total !== null && total >= p.refunded_cents + r.cents) {
      await settleRefund(ref, 'outside');
      return 'done';
    }
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
  if (!r || (r.status !== 'pending' && r.status !== 'manual')) return;
  run("UPDATE refunds SET status='failed', done_at=? WHERE id=?", now(), ref);
  if (r.account_id) run("DELETE FROM credits WHERE account_id=? AND reason='refund' AND ref=?", r.account_id, ref);
}

// A refund the software owes without being asked (charged after cancelling, charged twice, charged on a free plan,
// charged more than we said). If the provider cannot be reached it stays open and is tried again on the timer until
// it goes through. If the provider says a clear no three times (it cannot find the charge, say), it needs a person:
// it is marked so, the customer is told once that a person sends it by hand, and the operators are told. It is never
// written to a log and forgotten.
function oweNow(acct: any | null, p: any, cents: number, why: string): string | null {
  const amount = Math.min(cents, p.amount_cents - p.refunded_cents);
  return amount > 0 ? openRefund(acct, p, amount, 0, why, true) : null;
}
const payOwed = async (ref: string | null) => void (ref && (await tryRefund(ref).catch((e) => console.error('[billing] automatic refund will be retried', ref, e?.message))));
const owe = (acct: any | null, p: any, cents: number, why: string) => payOwed(oweNow(acct, p, cents, why));

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
  if (inv?.status === 'open' || inv?.status === 'uncollectible') await stripe('POST', `invoices/${inv.id}/void`).catch(() => {});
  // The provider deletes only drafts that belong to no subscription. A subscription's draft is told never to go
  // ahead by itself instead, so it is not finalized and charged. (Anything taken anyway is refunded: applyInvoice.)
  else if (inv?.status === 'draft') await stripe('DELETE', `invoices/${inv.id}`).catch(() => stripe('POST', `invoices/${inv.id}`, { auto_advance: 'false' }).catch(() => {}));
}
// For the places where the end must happen whatever the provider answers right now.
async function endOrQueue(subId: string | null, accountId?: string | null): Promise<boolean> {
  if (!subId) return true;
  if (await endSubscription(subId, true)) return true;
  run("INSERT OR IGNORE INTO billing_todo (kind, ref, account_id, detail, at) VALUES ('cancel',?,?,'',?)", subId, accountId ?? null, now());
  return false;
}
// Used when an account is closed: whatever state its plan is in, nothing may be charged afterwards.
// The answer is true only when the provider has confirmed that nothing is left to charge.
export const stopBillingFor = (acct: any): Promise<boolean> => serial(acct?.id, async () => {
  const a = account(acct?.id);
  if (!a || !billingEnabled()) return true;
  let ok = true;
  let tried = '';
  if (hasSub(a)) {
    tried = a.stripe_subscription_id;
    ok = await endOrQueue(a.stripe_subscription_id, a.id);
    run("UPDATE accounts SET plan=CASE WHEN promo_code IS NULL THEN 'seedling' ELSE plan END, subscription_status='canceled', cancel_at=NULL, renews_at=NULL, sub_event_at=? WHERE id=?", unixNow(), a.id);
    log(a.id, 'ended', 'Ended because the account was closed.');
  }
  // An ending that an earlier try left with the provider unconfirmed is still open, even though the plan is over
  // on our side. It is tried again now, and "stopped" is not said until every one of them has been confirmed:
  // asking twice must never turn "we could not reach the provider" into "done".
  for (const t of all("SELECT * FROM billing_todo WHERE kind='cancel' AND account_id=? AND done_at IS NULL", a.id)) {
    // The one just ended above needs no second call: its answer is `ok`.
    const ended = t.ref === tried ? ok : await endSubscription(t.ref, true);
    if (ended) run('UPDATE billing_todo SET done_at=? WHERE id=?', now(), t.id);
    else ok = false;
  }
  return ok;
});

// ---- What the Plan page shows ----------------------------------------------------------------

const LEDGER_LABEL: Record<string, string> = { welcome: 'Welcome signatures', plan: 'Monthly plan', code: 'Monthly plan, free with your code', topup: 'Top-up', signature: 'Signature used', refund: 'Refund', dispute: 'Card dispute', adjust: 'Adjustment' };
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
  const pending = all("SELECT r.payment_id, r.cents, r.at, r.tries, r.auto, r.why, r.status, p.currency FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE r.account_id=? AND r.status IN ('pending','manual') ORDER BY r.at", acct.id);
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
    next_amount: money(nextCents(acct)),
    // The monthly price this account is on, and a higher one it has been told about, if any.
    // Today's: once the first day of an announced price has passed, that price.
    plan_price: money(priceFor(acct, now())),
    // A higher price that is still to come. Once its first day has passed it is the price above, not news.
    price_change: acct.price_notice_cents && acct.price_notice_from && acct.price_notice_from > now() && hasSub(acct) && acct.price_notice_cents > (acct.price_cents || PLAN_CENTS())
      ? { now: money(acct.price_cents || PLAN_CENTS()), next: money(acct.price_notice_cents), from: acct.price_notice_from, from_day: priceChangeDay(acct.price_notice_from), told_at: acct.price_notice_at } : null,
    price_rule: priceRuleText(),
    ends_at: acct.plan === 'grove' && !acct.promo_code ? acct.cancel_at : null,
    cancel_ref: acct.cancel_ref || null,
    // A plan that was on and is not any more (as opposed to one that never started).
    // A free code that was on counts: it was a monthly plan too.
    ended: acct.plan !== 'grove' && !!get("SELECT 1 x FROM billing_log WHERE account_id=? AND what IN ('started','code','code-ended') LIMIT 1", acct.id),
    // A payment that did not go through. Nothing is locked; the page says what to do.
    problem: hasSub(acct) && ['past_due', 'unpaid', 'incomplete', 'paused'].includes(acct.subscription_status) ? acct.subscription_status : null,
    // A failed payment can be paid by hand on the provider's page. On hold ('unpaid') that is the only way back.
    can_pay_open: hasSub(acct) && ['past_due', 'unpaid', 'incomplete'].includes(acct.subscription_status),
    // A card dispute stops payments until a person has looked.
    disputed: !!acct.dispute_at,
    can_cancel: renewing(acct) || (hasSub(acct) && (acct.plan !== 'grove' || !PAID_UP.includes(acct.subscription_status))),
    has_customer: !!acct.stripe_customer_id,
    // What can be sent right now: the balance, minus signatures held for people who have been asked and not signed yet.
    signatures: s,
    short: s && s.available < 0 ? -s.available : 0,
    mangroves: mangrovesFor(paid / 100),
    refund: enabled ? refundOffer(acct) : null,
    // Refunds that have been asked for and not confirmed by the provider yet, so the page can say so at the top.
    // `auto`: one the software owes without being asked, with `why` in the customer's words. `by_hand`: the provider
    // refused it three times, so a person sends it.
    refunds_pending: pending.map((r) => ({ payment_id: r.payment_id, amount: money(r.cents, r.currency), since: r.at, auto: !!r.auto, why: r.auto ? owedWhy(r.why) : null, by_hand: r.status === 'manual' })),
    refund_days: refundDays(),
    refund_rule: refundRuleText(refundDays()),
    dormant_stop_days: dormantStopDays(),
    // Limits, as numbers, before anybody runs into them.
    limits: { first_week_daily: firstWeek ? newAccountDailyRecipients() : null, unpaid_daily_now: limited && !firstWeek ? unpaidDailyRecipients() : null, new_account_daily: newAccountDailyRecipients(), unpaid_daily: unpaidDailyRecipients(), top_up_max: PRICING.topUpMax, bulk_rows: 500 },
    // Other paid plans this person already manages, so nobody pays twice without noticing.
    other_paid: user ? all("SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role IN ('owner','admin') AND a.id!=?", user.id, acct.id).filter(hasSub).map((r) => r.name) : [],
    // Only payments that were turned into signatures (or sent back) are listed: one still being worked out is not a payment yet.
    payments: all("SELECT * FROM payments WHERE account_id=? AND kind IN ('plan','topup') AND (applied_at IS NOT NULL OR refunded_cents > 0) ORDER BY at DESC, rowid DESC LIMIT 60", acct.id)
      .map((p) => ({
        id: p.id, amount_cents: p.amount_cents, currency: p.currency, at: p.at, receipt_url: p.receipt_url, refunded_at: p.refunded_at, refunded_cents: p.refunded_cents, kind: p.kind, label: PAYMENT_LABEL[p.kind], credits: p.credits, disputed: p.disputed || null,
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
// `why` says what kind of ending it was: 'paid' (runs to the end of the paid month), 'unpaid' (the last payment had
// failed), 'not_taken' (the new month's payment had not been taken yet) or 'already_ended' (it was over at the provider).
type Cancelled = { ends_at: string; reference: string; ended_now: boolean; why: 'paid' | 'unpaid' | 'not_taken' | 'already_ended' };
// A payment that was raised and not paid when the provider confirmed that the plan stops (the one that was failing,
// or the new month's that had not been taken yet) must never be kept: if it is taken after all (the card is tried
// again, or ending it failed half way), applyInvoice sends it back. Written only once the provider has confirmed the
// stop, and cleared when the cancellation is undone. Kept with the provider's message ids, which are cleared after 60 days.
const stopKey = (accountId: string) => `after-stop:${accountId}:`;
const markStopped = (accountId: string, invoiceId: string | null) => void (invoiceId && run('INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?,?)', `${stopKey(accountId)}${invoiceId}`, now()));
function paidAfterStop(accountId: string, inv: any): boolean {
  const mark = inv?.id ? get('SELECT at FROM stripe_events WHERE id=?', `${stopKey(accountId)}${inv.id}`) : null;
  if (!mark) return false;
  // Paid before the stop (its message only arrived late) is a payment for a month that is paid for, not one after.
  const paidAt = Number(inv.status_transitions?.paid_at) || 0;
  return !paidAt || paidAt * 1000 >= Date.parse(mark.at) - 1000;
}
const unstop = (accountId: string) => run('DELETE FROM stripe_events WHERE substr(id, 1, ?) = ?', stopKey(accountId).length, stopKey(accountId));
// Who pressed Cancel, while the provider has taken the instruction and we have not finished: if its own message about
// the change arrives first, the email names the right place instead of "the payment provider's page".
const byKey = (accountId: string) => `cancel-by:${accountId}:`;
const pressedBy = (accountId: string): string | null =>
  get('SELECT id FROM stripe_events WHERE substr(id, 1, ?) = ? AND at > ? ORDER BY at DESC LIMIT 1', byKey(accountId).length, byKey(accountId), new Date(Date.now() - 864e5).toISOString())?.id.slice(byKey(accountId).length) || null;
const pressedDone = (accountId: string) => run('DELETE FROM stripe_events WHERE substr(id, 1, ?) = ?', byKey(accountId).length, byKey(accountId));
const NOT_CONFIRMED = 'The payment provider did not confirm the cancellation just now, so we cannot tell you it is done. Please try again in a minute, or use the contact form and a person will do it.';

// `known` is the subscription as the provider shows it right now, when the plan was set to end somewhere else (the
// provider's own page): it is then not changed at the provider, only worked out and written down here.
export async function cancelPlan(acct: any, by: string, quiet = false, known?: any): Promise<Cancelled> {
  const a = account(acct.id);
  if (!hasSub(a)) throw bad(a.promo_code ? `This plan is free with the code ${a.promo_code}. Nothing is charged for it, so there is nothing to cancel.` : 'There is no monthly plan on this account, so there is nothing to cancel and nothing will be charged.');
  // Already cancelled and paid up: say so again, with the same reference. (cancel_at is only written below, once the
  // provider has confirmed both the end and that the month is paid for.)
  if (a.cancel_at && a.plan === 'grove' && PAID_UP.includes(a.subscription_status) && Date.parse(a.cancel_at) > Date.now()) {
    if (!a.cancel_ref) run('UPDATE accounts SET cancel_ref=? WHERE id=?', newReference(a), a.id);
    return { ends_at: a.cancel_at, reference: account(a.id).cancel_ref, ended_now: false, why: 'paid' };
  }
  const reference = a.cancel_ref && a.cancel_at ? a.cancel_ref : newReference(a);
  let sub: any = known;
  if (!sub) {
    try {
      sub = await stripe('POST', `subscriptions/${a.stripe_subscription_id}`, { cancel_at_period_end: 'true' });
    } catch (e: any) {
      // Already gone at the provider: then it is cancelled, and we say so instead of failing.
      if (!gone(e) && (await stripe('GET', `subscriptions/${a.stripe_subscription_id}`).catch(() => null))?.status !== 'canceled') throw e;
      sub = { status: 'canceled' };
    }
    if (sub.status !== 'canceled') run('INSERT OR REPLACE INTO stripe_events (id, at) VALUES (?,?)', `${byKey(a.id)}${by}`, now());
  }
  const latest = sid(sub.latest_invoice);
  // Paid up means the plan runs to the end of the month that is paid for. Not paid up (the last payment failed, or
  // the new month's payment has been raised but not taken yet) means there is no paid month to run out: it ends
  // today, and the payment that was waiting is withdrawn so it cannot be taken after the customer said stop.
  let waiting = false;
  if (PAID_UP.includes(sub.status) && latest) {
    // If this cannot be asked we do not guess "it is paid": the answer is "not confirmed, try again", and that payment
    // is not kept if it is taken in the meantime.
    const inv = await stripe('GET', `invoices/${latest}`).catch((e) => {
      if (gone(e)) return null;
      markStopped(a.id, latest);
      throw bad(NOT_CONFIRMED, 502);
    });
    waiting = inv?.status === 'draft' || inv?.status === 'open' || (inv?.status === 'paid' && paidAfterStop(a.id, inv));
  }
  if (!PAID_UP.includes(sub.status) || waiting) {
    if (sub.status !== 'canceled') markStopped(a.id, latest);
    if (sub.status !== 'canceled' && !(await endSubscription(a.stripe_subscription_id, true))) throw bad(NOT_CONFIRMED, 502);
    pressedDone(a.id);
    run("UPDATE accounts SET plan='seedling', subscription_status='canceled', cancel_at=NULL, cancel_ref=?, renews_at=NULL, sub_event_at=? WHERE id=?", reference, unixNow(), a.id);
    const why: Cancelled['why'] = sub.status === 'canceled' ? 'already_ended' : waiting ? 'not_taken' : 'unpaid';
    const said = why === 'already_ended' ? 'The plan had already ended with the payment provider, so there was nothing more to stop.'
      : why === 'not_taken' ? 'The payment for the new month had not been taken yet, so the plan ends today and that payment is withdrawn.'
      : 'The last payment had not gone through, so the plan ends today and that payment will not be tried again.';
    log(a.id, 'cancelled', `Cancelled ${by}. ${why === 'already_ended' ? 'It had already ended.' : 'Ended at once: the month had not been paid for.'}`, reference);
    if (!quiet)
      await mailAdmins(a.id, `Your ${PRICING.planName} plan is cancelled`, 'Cancelled. You will not be charged again.', [...cancelLines(a, reference, by, [said]), 'If a charge ever appears after today, we refund it automatically.'], { label: 'Open the Plan page', url: planUrl() });
    return { ends_at: now(), reference, ended_now: true, why };
  }
  const ends = plannedEnd(sub) || periodEnd(sub) || a.renews_at || now();
  pressedDone(a.id);
  run('UPDATE accounts SET cancel_at=?, cancel_ref=?, sub_event_at=? WHERE id=?', ends, reference, unixNow(), a.id);
  log(a.id, quiet ? 'auto-stop' : 'cancelled', `Cancelled ${by}.`, reference);
  if (!quiet)
    await mailAdmins(a.id, `Your ${PRICING.planName} plan is cancelled`, 'Cancelled. You will not be charged again.', [
      ...cancelLines(a, reference, by, [`The plan runs until ${day(ends)}, because that month is already paid for. No more payments are taken after that.`]),
      'If a charge ever appears after this date, we refund it automatically.',
    ], { label: 'Changed your mind? Resume', url: planUrl() });
  return { ends_at: ends, reference, ended_now: false, why: 'paid' };
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
    ...(a.stripe_customer_id ? ['If a card is still saved from an earlier payment, it stays saved for top-ups. You can remove it on the Plan page at any time.'] : []),
    `Nothing is charged for the plan, so there is nothing to cancel. If you need more in a busy month you can top up at ${money(PRICING.topUpUsd * 100)} a signature, and every dollar plants ${PRICING.treesPerUsd} mangrove trees.`,
  ], { label: 'Open the Plan page', url: planUrl() });
  return code;
}
export const redeemCode = (accountId: string, typed: any): Promise<string> => serial(accountId, () => redeemNow(accountId, typed));

route('POST', '/billing/redeem', async (c) => {
  rateLimit(`redeem:${c.ip}`, 20, 3600_000);
  await redeemCode(c.account.id, (await c.body()).code);
  return billingState(account(c.account.id), c.user);
}, 'admin');

// When a code is switched off (taken out of FREE_PLAN_CODES), the plans it made free end, and the people on it are
// told. They keep every signature they have. A code has to be missing for three days in a row before that happens,
// so a slip in a deployment does not end everyone's plan; no signatures are added in the meantime.
export async function endRemovedCodes(): Promise<number> {
  let ended = 0;
  for (const row of all('SELECT id FROM accounts WHERE promo_code IS NOT NULL')) {
    await serial(row.id, async () => {
      const a = account(row.id);
      if (!a?.promo_code) return;
      if (findFreeCode(a.promo_code)) {
        if (a.promo_missing_since) run('UPDATE accounts SET promo_missing_since=NULL WHERE id=?', a.id);
        return;
      }
      if (!a.promo_missing_since) return void run('UPDATE accounts SET promo_missing_since=? WHERE id=?', now(), a.id);
      if (Date.parse(a.promo_missing_since) > Date.now() - 3 * 864e5) return;
      run("UPDATE accounts SET promo_code=NULL, promo_at=NULL, promo_missing_since=NULL, plan='seedling', subscription_status=NULL, stripe_subscription_id=NULL, cancel_at=NULL, renews_at=NULL WHERE id=?", a.id);
      log(a.id, 'code-ended', `The code ${a.promo_code} is no longer active.`);
      await mailAdmins(a.id, `The code ${a.promo_code} has ended`, 'Your free monthly plan has ended', [
        `The code ${a.promo_code} is no longer active, so ${a.name} no longer gets ${sigs(PRICING.monthlySignatures)} a month for free. Nothing was charged and nothing will be.`,
        `You keep the ${sigs(Math.max(0, available(a.id)))} you have. They never expire, and signing your own documents is always free.`,
        `To keep getting ${sigs(PRICING.monthlySignatures)} a month you can start the monthly plan for ${PLAN_PRICE()} on the Plan page. Every dollar plants ${PRICING.treesPerUsd} mangrove trees.`,
      ], { label: 'Open the Plan page', url: planUrl() });
      ended++;
    });
  }
  return ended;
}

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
  const s = await withCustomer(a, c.user.email, (who) => stripe('POST', 'checkout/sessions', {
    mode: 'subscription', 'line_items[0][price]': String(process.env.STRIPE_PRICE_GROVE), 'line_items[0][quantity]': '1',
    client_reference_id: a.id, 'metadata[sg_account]': a.id,
    // The subscription carries the account it is for, so its payments find their way home in whatever order the
    // provider reports them.
    'subscription_data[metadata][sg_account]': a.id, 'subscription_data[description]': `Sign&Grow monthly plan for ${a.name} (${a.id})`,
    // The price this page shows, kept on the subscription: it is the price the account is on from its first payment.
    'subscription_data[metadata][sg_price_cents]': String(PLAN_CENTS()),
    // The commitment, in plain words, on the payment page itself. And always in US dollars, the price we show.
    'custom_text[submit][message]': `${PLAN_PRICE()} today, then ${PLAN_PRICE()} every month until you cancel. Each payment adds ${sigs(PRICING.monthlySignatures)}. No contract and no notice period: cancel in one click. ${refundRuleText(refundDays())}`,
    'adaptive_pricing[enabled]': 'false',
    success_url: `${baseUrl()}/app/settings?tab=billing&upgraded=1&session_id={CHECKOUT_SESSION_ID}`, cancel_url: planUrl(),
    ...who,
  }));
  return { url: s.url };
}, 'admin');

// Buy extra signatures. A one-off payment, chosen on purpose, with the exact price shown before paying.
// It never changes the plan or the monthly price.
route('POST', '/billing/topup', async (c) => {
  if (!billingEnabled()) throw bad('Billing is not set up on this server yet.', 501);
  const a = c.account;
  if (a.dispute_at) throw bad(DISPUTED, 403);
  if (a.plan !== 'grove') throw bad(hasSub(a) && a.subscription_status === 'paused' ? 'Top-ups come with the monthly plan, and yours is paused with the payment provider. Once it runs again you can top up.' : hasSub(a) ? 'Top-ups come with the monthly plan, and yours is on hold because a payment did not go through. Press "Pay the open payment" on the Plan page (you can use another card there) and you can top up again. A new card on file is not enough by itself.' : `Top-ups are for accounts on the monthly plan. Start it for ${PLAN_PRICE()} a month and you get ${sigs(PRICING.monthlySignatures)} straight away.`);
  const quantity = Math.round(Number((await c.body()).quantity));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > PRICING.topUpMax) throw bad(`Choose between 1 and ${PRICING.topUpMax} signatures.`);
  const total = money(quantity * PRICING.topUpUsd * 100);
  const s = await withCustomer(a, c.user.email, (who) => stripe('POST', 'checkout/sessions', {
    mode: 'payment', 'line_items[0][quantity]': String(quantity),
    'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(PRICING.topUpUsd * 100),
    'line_items[0][price_data][product_data][name]': `Sign&Grow signature (plants ${PRICING.treesPerUsd} mangrove trees)`,
    'metadata[kind]': 'sg_topup', 'metadata[credits]': String(quantity), 'metadata[sg_account]': a.id,
    'payment_intent_data[description]': `Sign&Grow top-up: ${sigs(quantity)} for ${a.name} (${a.id})`, 'payment_intent_data[metadata][sg_account]': a.id,
    // The provider makes an invoice for it, marked as a top-up so it is never mistaken for a monthly payment.
    'invoice_creation[enabled]': 'true', 'invoice_creation[invoice_data][metadata][kind]': 'sg_topup', 'invoice_creation[invoice_data][metadata][sg_account]': a.id,
    'custom_text[submit][message]': `One payment of ${total} for ${sigs(quantity)}. Nothing recurring, and your plan and its price do not change. ${refundRuleText(refundDays())}`,
    'adaptive_pricing[enabled]': 'false',
    client_reference_id: a.id, success_url: `${baseUrl()}/app/settings?tab=billing&topped=1&session_id={CHECKOUT_SESSION_ID}`, cancel_url: planUrl(),
    ...who,
  }));
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
// If the provider no longer knows this account's customer (someone deleted it there), forget it and carry on as a
// new customer, instead of failing for ever.
// A business outside the US often needs its tax number (VAT, GST) and address on the invoice to be able to book
// it. With STRIPE_COLLECT_TAX_ID=1 the payment page asks for both and the provider prints them on the invoice. It
// is off by default because the provider refuses the request unless its own settings allow it: switch it on in
// test mode first and make one payment.
const taxFields = (known: boolean): Record<string, string> => (process.env.STRIPE_COLLECT_TAX_ID === '1'
  ? { 'tax_id_collection[enabled]': 'true', billing_address_collection: 'required', ...(known ? { 'customer_update[name]': 'auto', 'customer_update[address]': 'auto' } : {}) } : {});
async function withCustomer<T>(a: any, email: string, call: (who: Record<string, string>) => Promise<T>): Promise<T> {
  try {
    return await call(a.stripe_customer_id ? { customer: a.stripe_customer_id, ...taxFields(true) } : { customer_email: email, ...taxFields(false) });
  } catch (e: any) {
    if (!a.stripe_customer_id || !/no such customer/i.test(e?.message || '')) throw e;
    run('UPDATE accounts SET stripe_customer_id=NULL WHERE id=?', a.id);
    return call({ customer_email: email, ...taxFields(false) });
  }
}

// `first` is the subscription's first invoice when the caller has it, so the welcome can say what it brought.
async function adopt(accountId: string, customer: string | null, subscriptionId: string | null, fresh?: any, first?: any): Promise<'on' | 'dead' | 'refused'> {
  const a = account(accountId);
  if (!a || !subscriptionId) return 'dead';
  if (customer && !a.stripe_customer_id) run('UPDATE accounts SET stripe_customer_id=? WHERE id=?', customer, a.id);
  if (a.stripe_subscription_id === subscriptionId) {
    if (a.plan === 'grove' && hasSub(a)) return 'on';
    if (a.subscription_status === 'canceled') return 'dead';
  }
  const sub = fresh || (await stripe('GET', `subscriptions/${subscriptionId}`).catch((e) => { if (gone(e)) return { status: 'canceled' }; throw e; }));
  if (!PAID_UP.includes(sub?.status)) return 'dead';
  if (a.promo_code || (hasSub(a) && a.stripe_subscription_id !== subscriptionId && LIVE.includes(a.subscription_status || ''))) {
    await endOrQueue(subscriptionId, a.id);
    if (!a.promo_code) await tellOperators(`A second subscription was started for ${a.name}`, [`Account ${a.id} already pays for subscription ${a.stripe_subscription_id}. The new one (${subscriptionId}) was ended automatically and its payment is refunded when it arrives. Check that nothing else is wrong.`], a.id);
    return 'refused';
  }
  const end = periodEnd(sub);
  run("UPDATE accounts SET plan='grove', stripe_customer_id=COALESCE(?, stripe_customer_id), stripe_subscription_id=?, subscription_status=?, renews_at=COALESCE(?, renews_at), cancel_at=?, cancel_ref=NULL, renewal_reminded=NULL, renewal_quoted_cents=NULL, dormant_kept_for=NULL, plan_started_at=?, sub_event_at=? WHERE id=?",
    customer, subscriptionId, sub.status, end, plannedEnd(sub), now(), unixNow(), a.id);
  // A new subscription starts at the price its checkout showed (kept on it when the checkout was made), whatever an
  // earlier plan of this account cost: a returning customer is never held to the price of a plan that ended, and a
  // notice about that plan's price is about a plan that is over. The same subscription taken up again (back from
  // being on hold, say) keeps the price it had.
  if (a.stripe_subscription_id !== subscriptionId) {
    const shown = Math.round(Number(sub?.metadata?.sg_price_cents)) || PLAN_CENTS();
    run('UPDATE accounts SET price_cents=?, price_notice_cents=NULL, price_notice_from=NULL, price_notice_at=NULL WHERE id=?', shown, a.id);
  }
  const price = money(priceFor(account(a.id), end));
  log(a.id, 'started', `${price} a month.`, subscriptionId);
  // A first invoice of $0 (a discount, a credit or a free trial set up with the payment provider) pays for nothing,
  // and signatures follow the money: the welcome says that this first month brought none, and why.
  let inv0 = first || (sub?.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null);
  if (!inv0 && sid(sub?.latest_invoice)) inv0 = await stripe('GET', `invoices/${sid(sub.latest_invoice)}`).catch(() => null);
  const freeFirst = !!inv0 && inv0.status === 'paid' && (!inv0.billing_reason || inv0.billing_reason === 'subscription_create') && !(Number(inv0.amount_paid) > 0);
  await mailAdmins(accountId, `Welcome to ${PRICING.planName}`, 'Thank you. Your signatures plant mangroves.', [
    `You are on the monthly plan: ${price} a month adds ${sigs(PRICING.monthlySignatures)} to your balance with every payment. That is ${trees(priceFor(account(a.id), end))} planted each month.`,
    ...(freeFirst ? [`Your first invoice came to ${money(0)}, so this first month brought no signatures. Signatures are added only for what is paid, and that invoice paid nothing (a discount, a credit or a free trial set up with the payment provider made it free). Each payment from here on adds them as above.`] : []),
    ...(end ? [`Next charge: ${price} on ${day(end)}, and every month after that until you cancel. We remind you a week before and again about a day before.`] : []),
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
  // Only checkouts that carry our own mark are top-ups of ours.
  if (s.metadata?.kind !== 'sg_topup' || !s.metadata?.sg_account || s.payment_status !== 'paid') return false;
  const a = account(s.metadata.sg_account);
  // An account we have never heard of (as opposed to one that was closed) is not ours to act on.
  if (!a && !wasDeleted(s.metadata.sg_account)) return false;
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
  // The first payment is read first, so the welcome can say what it brought, and applied after, so the signatures
  // are there the moment checkout finishes.
  const inv = s.invoice ? await stripe('GET', `invoices/${sid(s.invoice)}`).catch(() => null) : null;
  await adopt(s.client_reference_id, sid(s.customer), sub, undefined, inv?.id ? inv : undefined);
  await claimPayments(s.client_reference_id);
  if (inv?.id) await applyInvoice(inv);
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
      applied = await serial(c.account.id, async () => {
        await applySession({ ...s, id: s.id || sessionId });
        const a = account(c.account.id);
        if (s.mode === 'payment') return get('SELECT applied_at FROM payments WHERE id=? AND account_id=?', s.id || sessionId, a.id)?.applied_at ? 'topup' : null;
        if (!(a.plan === 'grove' && hasSub(a) && a.stripe_subscription_id === sid(s.subscription))) return null;
        // The checkout's own first payment decides, however long ago it was: a return link opened again a week later
        // (a bookmark, the browser's history) finds it applied and says so, instead of "on their way". Only when the
        // checkout does not name its payment is a plan payment of this subscription asked for instead.
        const first = sid(s.invoice);
        const paidIn = first ? get('SELECT applied_at FROM payments WHERE id=? AND account_id=?', first, a.id)
          : get("SELECT applied_at FROM payments WHERE account_id=? AND kind='plan' AND applied_at IS NOT NULL AND (subscription_id=? OR subscription_id IS NULL) LIMIT 1", a.id, sid(s.subscription));
        return paidIn?.applied_at ? 'plan' : 'plan-pending';
      });
  }
  return { ...billingState(account(c.account.id), c.user), applied };
}, 'admin');

// The provider's own page, for changing the card or downloading invoices. Available for as long as the account
// exists, also after cancelling.
route('POST', '/billing/portal', async (c) => {
  if (!billingEnabled() || !c.account.stripe_customer_id) throw bad('There is no payment method on this account.');
  const s = await stripe('POST', 'billing_portal/sessions', { customer: c.account.stripe_customer_id, return_url: planUrl() }).catch((e) => {
    if (!/no such customer/i.test(e?.message || '')) throw e;
    run('UPDATE accounts SET stripe_customer_id=NULL WHERE id=?', c.account.id);
    throw bad('The payment provider has no card or invoices on file for this account any more. Nothing is being charged.', 404);
  });
  return { url: s.url };
}, 'admin');

// A payment that did not go through is paid on the provider's own page for that invoice, where another card can be
// used. For a plan on hold this is the one thing that brings it back: the provider has stopped trying the card by
// itself, so putting a new card on file changes nothing until the open invoice is paid.
route('POST', '/billing/pay-open', async (c) => {
  const a = account(c.account.id);
  if (!billingEnabled() || !hasSub(a)) throw bad('There is no payment waiting on this account.');
  const down = () => bad('We could not reach the payment provider just now, so the open payment could not be opened. Nothing was charged. Please try again in a minute.', 502);
  const sub = await stripe('GET', `subscriptions/${a.stripe_subscription_id}`, { 'expand[]': 'latest_invoice' }).catch((e) => {
    if (gone(e)) return { id: a.stripe_subscription_id, status: 'canceled', latest_invoice: null };
    throw down();
  });
  let inv = sub.latest_invoice;
  if (typeof inv === 'string') inv = await stripe('GET', `invoices/${inv}`).catch(() => { throw down(); });
  // A payment the provider has given up on (some dunning settings mark it "uncollectible" instead of leaving it open)
  // can still be paid on its page.
  if ((inv?.status === 'open' || inv?.status === 'uncollectible') && inv.hosted_invoice_url) return { url: inv.hosted_invoice_url, amount: money(Number(inv.amount_remaining ?? inv.amount_due ?? 0), inv.currency) };
  // Nothing is open any more: it was paid in the meantime, or withdrawn. The plan is read back so the page shows
  // what is true now instead of offering the same button again.
  const wasFailing = ['past_due', 'unpaid', 'incomplete'].includes(a.subscription_status);
  await serial(a.id, async () => {
    await applySubscription(account(a.id), sub, unixNow(), sub.status === 'canceled' || sub.status === 'incomplete_expired');
    await catchUpInvoice(sub).catch(() => {});
  });
  throw bad(sub.status === 'paused' ? 'This plan is paused with the payment provider, so nothing is waiting to be paid and nothing is charged while it is paused.'
    : !wasFailing ? 'Nothing is waiting to be paid on this plan: its last payment went through.'
    : inv?.status === 'paid' ? 'That payment has gone through in the meantime, so nothing is waiting to be paid. The page now shows where your plan stands.'
    : 'There is no open payment on this plan any more. The page now shows where your plan stands.', 409);
}, 'admin');

route('POST', '/billing/cancel', (c) => serial(c.account.id, () => cancelPlan(c.account, `in the app by ${c.user.name}`)), 'admin');

route('POST', '/billing/resume', (c) => serial(c.account.id, async () => {
  const a = account(c.account.id);
  if (a.promo_code) throw bad(`This plan is free with the code ${a.promo_code}. There is no paid plan to resume.`);
  if (!a.cancel_at || !hasSub(a)) throw bad('This plan is not set to end.');
  let sub: any;
  try {
    sub = await stripe('POST', `subscriptions/${a.stripe_subscription_id}`, { cancel_at_period_end: 'false', cancel_at: '' });
    if (sub?.status === 'canceled') throw new ProviderError('ended', false);
  } catch (e: any) {
    if (e instanceof ProviderError && e.unsure) throw e;
    // The provider will not take it back. Only when it says the plan is over (gone, or cancelled) do we say so and
    // tidy up. Anything else is an error like any other, and nothing changes.
    const real = gone(e) ? null : await stripe('GET', `subscriptions/${a.stripe_subscription_id}`).catch(() => null);
    if (!gone(e) && real?.status !== 'canceled') throw e;
    await applySubscription(a, real || { id: a.stripe_subscription_id, status: 'canceled' }, unixNow(), true);
    throw bad('This plan has already ended, so there is nothing to resume. You can start the monthly plan again whenever you like.', 409);
  }
  // Keeping the plan is a decision about this renewal: the "nobody is using it" rule leaves it alone.
  run('UPDATE accounts SET cancel_at=NULL, renews_at=?, dormant_kept_for=?, sub_event_at=? WHERE id=?', periodEnd(sub) || a.renews_at, (periodEnd(sub) || a.renews_at || '').slice(0, 10), unixNow(), a.id);
  unstop(a.id);
  log(a.id, 'resumed', `By ${c.user.name}.`, a.cancel_ref || '');
  const next = periodEnd(sub) || a.renews_at;
  await mailAdmins(a.id, `Your ${PRICING.planName} plan continues`, 'The cancellation was undone', [
    `${c.user.name} chose to keep the monthly plan for ${a.name}. ${next ? `The next charge is ${money(priceFor(a, next))} on ${day(next)}.` : `It is billed ${money(priceFor(a, null))} each month.`} We remind you before it happens.`,
    'To stop it again, use the Cancel button on the Plan page or the link below.',
  ], 'stop');
  return billingState(account(a.id), c.user);
}), 'admin');

// Self-serve refund of whatever has not been used from a payment. Refunding a monthly payment also ends the plan.
// With no payment named, it is the latest one.
route('POST', '/billing/refund', async (c) => {
  const want = str((await c.req.json().catch(() => ({})))?.payment_id, 200);
  return serial(c.account.id, async () => {
    const a = account(c.account.id);
    const offer = want ? offerFor(a, get('SELECT * FROM payments WHERE id=? AND account_id=?', want, a.id)) : refundOffer(a);
    if (!offer) throw bad(`${refundRuleText(refundDays())} There is nothing unused inside that window for this payment right now. If you think that is wrong, use the contact form and a person will look at it.`);
    const p = get('SELECT * FROM payments WHERE id=?', offer.payment_id);
    // The signatures leave the balance in the same breath as the offer is worked out, before the first call to the
    // provider, so an envelope sent while the refund is on its way cannot hold or use them.
    const ref = openRefund(a, p, offer.cents, offer.signatures, offer.reason, false);
    let planEnded = false;
    try {
      // Find the card charge before anything else changes. If it cannot be found, nothing has happened yet.
      await chargeTarget(p, a);
      if (p.kind === 'plan' && hasSub(a)) {
        // The plan ends at the provider before any money moves. If that fails, nothing has changed and we say so.
        if (!(await endSubscription(a.stripe_subscription_id, true)))
          throw bad('We could not end the monthly plan with the payment provider just now, so nothing was refunded and nothing changed. Please try again in a minute.', 502);
        run("UPDATE accounts SET plan='seedling', subscription_status='canceled', cancel_at=NULL, renews_at=NULL, sub_event_at=? WHERE id=?", unixNow(), a.id);
        log(a.id, 'ended', 'Ended with the refund of its latest payment.');
        planEnded = true;
      }
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
route('POST', '/billing/remove-card', (c) => serial(c.account.id, async () => {
  const a = account(c.account.id);
  if (!a.stripe_customer_id) throw bad('There is no card on this account.');
  const cancelled = hasSub(a) && !(a.cancel_at && PAID_UP.includes(a.subscription_status)) ? await cancelPlan(a, `in the app by ${c.user.name}, with the card removed`) : null;
  const pms = await stripe('GET', `customers/${a.stripe_customer_id}/payment_methods`, { limit: '100' }).catch((e) => {
    if (!/no such customer/i.test(e?.message || '')) throw e;
    run('UPDATE accounts SET stripe_customer_id=NULL WHERE id=?', a.id);
    return { data: [] };
  });
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
    // The price this account is charged, never the price for new customers: this is where someone decides to stop.
    account: a.name, plan: a.plan, price: chargePrice(a) / 100, next_amount: money(nextCents(a)), free_with: a.promo_code || null, failing,
    can_cancel: renewing(a) || failing,
    renews_at: a.plan === 'grove' && renewing(a) && !failing ? a.renews_at : null, ends_at: a.promo_code || failing || !hasSub(a) ? null : a.cancel_at, cancel_ref: a.cancel_ref || null, signatures_left: Math.max(0, available(a.id)),
  };
}, 'public');

route('POST', '/public/billing/stop', async (c) => {
  rateLimit(`stop:${c.ip}`, 20, 3600_000);
  const a = account(readStopToken((await c.body()).token));
  if (!a) throw bad('This link has expired. Use "Find my subscription" and we will email you a new one.', 410);
  return serial(a.id, () => cancelPlan(a, 'from an email link'));
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
  // Plans that are over on our side while the provider has not yet confirmed that the subscription has ended (we keep
  // asking on the timer). Until it has, "we are not charging you" would be a guess.
  const ending = u ? all("SELECT DISTINCT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN billing_todo t ON t.account_id=a.id AND t.kind='cancel' AND t.done_at IS NULL WHERE m.user_id=? AND m.role IN ('owner','admin')", u.id).filter((a) => !hasSub(a)) : [];
  if (rows.length || others.length || ending.length)
    await sendMail({
      to: email, subject: 'Your Sign&Grow subscriptions', heading: 'Your monthly plans',
      lines: [
        ...(rows.length ? ['You asked which paid plans are tied to this email address. Each link below stops that plan from renewing. No login needed.'] : []),
        ...ending.map((a) => `${a.name}: we have ended its monthly plan, and the payment provider has not confirmed that yet. We keep asking it until it does, and you do not need to do anything. If a charge for it comes through in the meantime, it is refunded automatically.`),
        ...others.map((a) => `${a.name} has a paid plan (${money(chargePrice(a))} a month) that you are a member of but do not manage. Its owner can stop it: ${admins(a.id).map((x) => x.name).join(', ') || 'see the Team page'}.`),
      ],
      links: rows.map((a) => ({ label: `Stop renewal for ${a.name}`, url: stopUrl(a.id, u.id), note: dated(!PAID_UP.includes(a.subscription_status) ? `${money(chargePrice(a))} a month, and the last payment did not go through` : a.cancel_at ? `already cancelled, ends ${day(a.cancel_at)}` : `${money(chargePrice(a))} a month${a.renews_at ? `, next charge ${money(nextCents(a))} on ${day(a.renews_at)}` : ''}`, u.tz) })),
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
    // Only the plans this address may stop in the app: as an owner or admin, exactly as with the stop links.
    for (const a of all("SELECT DISTINCT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email=? AND m.role IN ('owner','admin') AND a.stripe_customer_id IS NOT NULL", email).filter(hasSub)) {
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
  const stopped: any[] = [];
  for (const a of rows) stopped.push({ account: isEmail(email) ? a.name : undefined, ...(await serial(a.id, () => cancelPlan(a, 'by the card holder, without logging in'))) });
  return { stopped: true, ...stopped[0], all: stopped };
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
// A payment of ours that does not know its charge yet is matched only when the provider confirms it (the invoice's
// own payment is this charge), never by the amount alone: on a shared provider account another product's charge of
// the same customer can have the same amount, and its refund or dispute must never touch our customer. `doubt` says
// one of ours might be meant and the provider could not tell; then a person decides (tellOperators), nothing is done.
// Not being able to ask at all fails the message, so it is applied again later.
async function paymentForCharge(ch: any, acct: any | null): Promise<{ p: any | null; doubt: boolean }> {
  const byId = get('SELECT * FROM payments WHERE charge_id IN (?,?) OR id=?', ch.id || '-', sid(ch.payment_intent) || '-', sid(ch.invoice) || '-');
  if (byId || !acct) return { p: byId || null, doubt: false };
  // It names an invoice, and that invoice is not one of ours: it is not ours.
  if (sid(ch.invoice)) return { p: null, doubt: false };
  const near = all("SELECT * FROM payments WHERE account_id=? AND charge_id IS NULL AND amount_cents=? AND kind IN ('plan','topup')", acct.id, ch.amount);
  const at = (ch.created || Date.now() / 1000) * 1000;
  let doubt = false;
  for (const p of near.sort((x, y) => Math.abs(Date.parse(x.at) - at) - Math.abs(Date.parse(y.at) - at))) {
    if (p.kind !== 'plan') { doubt = true; continue; }
    const inv = await stripe('GET', `invoices/${p.id}`, { 'expand[]': 'payments' }).catch((e) => (e.unsure ? Promise.reject(e) : stripe('GET', `invoices/${p.id}`).catch((e2) => (e2.unsure ? Promise.reject(e2) : null))));
    const found = inv && chargeOf(inv);
    if (!found) { doubt = true; continue; }
    // Learnt either way, so the next message about it is matched by its id.
    run('UPDATE payments SET charge_id=? WHERE id=? AND charge_id IS NULL', found, p.id);
    if (found === ch.id || found === sid(ch.payment_intent)) return { p: get('SELECT * FROM payments WHERE id=?', p.id), doubt: false };
  }
  return { p: null, doubt };
}

// A card charge that may or may not be one of ours, and the provider could not say which: a person is told, once per
// charge, and nothing is done to any account.
async function unsure(ch: any, what: string, todo: string) {
  if (!run('INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?,?)', `doubt:${ch.dispute || ''}:${ch.id || '-'}`, now()).changes) return;
  const acct = ch.customer ? get('SELECT * FROM accounts WHERE stripe_customer_id=?', sid(ch.customer)) : null;
  await tellOperators(`${what} could not be matched to a payment for sure`, [`${what}${ch.dispute ? ` (${ch.dispute})` : ''} on charge ${ch.id || 'unknown'}, ${money(Number(ch.amount) || 0, ch.currency || 'usd')}, customer ${sid(ch.customer) || 'unknown'}${acct ? ` (account ${acct.name}, ${acct.id})` : ''}. The charge names no invoice of ours, and the payment provider could not confirm that it belongs to one of this customer's payments: it may be something else sold on the same provider account. ${todo}`], acct?.id);
}

// Money went back to the customer by a road that was not our own refund (a person in the provider's dashboard, or
// the bank after a dispute). The signatures it paid for leave the balance, like any refund. That includes ones held
// for envelopes that are out: those can still be signed, and the balance then shows what is owed. Ones that were
// already used stay used; the answer says how many that was.
function takeBack(acct: any | null, p: any, cents: number, ref: string, reason: 'refund' | 'dispute' = 'refund'): { taken: number; used: number } {
  const left = p.credits - (p.credits_refunded || 0);
  if (!acct || left <= 0 || !p.applied_at || cents <= 0) return { taken: 0, used: 0 };
  const paidFor = Math.min(left, Math.round((cents / p.amount_cents) * p.credits));
  const taken = Math.min(paidFor, Math.max(0, balance(acct.id)));
  if (taken > 0 && grant(acct.id, -taken, reason, ref)) run('UPDATE payments SET credits_refunded=credits_refunded+? WHERE id=?', taken, p.id);
  return { taken, used: paidFor - taken };
}

// Is this invoice ours at all? The provider account may be shared with other things. It is ours when it names one of
// our accounts, comes from a customer of ours, or is for our price. When none of that can be told it is kept aside
// without counting anywhere, and picked up if a checkout of ours later turns out to be its owner.
function ours(o: any, sub?: any): boolean {
  if (namedAccount(o) || sub?.metadata?.sg_account) return true;
  const price = priceOf(o) || priceOf(sub || {});
  // A price is named: it is ours only if it is our price, whoever the customer is.
  if (price) return !!process.env.STRIPE_PRICE_GROVE && price === process.env.STRIPE_PRICE_GROVE;
  // Nothing on it says what it is for. A customer of ours is the best evidence left.
  return !!get('SELECT 1 x FROM accounts WHERE stripe_customer_id=?', sid(o.customer) || '-');
}

// A paid invoice: the monthly payment. Each one adds the plan's signatures to the balance, or goes straight back if
// it should never have been taken.
async function applyInvoice(o: any): Promise<void> {
  if (!o?.id || (o.status && o.status !== 'paid')) return;
  const cents = Number(o.amount_paid) || 0;
  const currency = String(o.currency || 'usd').toLowerCase();
  const customer = sid(o.customer);
  // The invoice the provider makes for a top-up is not a payment of its own: it only carries the top-up's receipt.
  // Only an invoice that carries our mark: a one-off invoice of something else sold to the same customer is not a
  // top-up's receipt, even for the same amount. (A top-up's receipt also comes with its own checkout: applyTopUp.)
  if (o.metadata?.kind === 'sg_topup' || (o.billing_reason === 'manual' && o.metadata?.sg_account)) {
    const acctId = o.metadata?.sg_account || get('SELECT id FROM accounts WHERE stripe_customer_id=?', customer || '-')?.id;
    const top = get("SELECT id FROM payments WHERE kind='topup' AND (invoice_id=? OR (account_id=? AND amount_cents=? AND invoice_id IS NULL)) ORDER BY at DESC LIMIT 1", o.id, acctId || '-', cents);
    if (top) await topUpReceipt(top.id, o.id, o);
    if (top || o.metadata?.kind === 'sg_topup') return;
  }
  if (cents <= 0) {
    // Paid in full with nothing to pay (a coupon or a credit at the provider). No money, so no signatures; a person
    // who set that up should know that is what it means.
    if (namedAccount(o) && o.billing_reason !== 'manual' && run("INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?,?)", `zero:${o.id}`, now()).changes)
      await tellOperators('A monthly invoice of $0 was "paid"', [`Invoice ${o.id} for account ${namedAccount(o)}. Signatures follow the money, so none were added. If this account is meant to be free, use a free code instead of a coupon.`], namedAccount(o));
    return;
  }
  let S = subOf(o);
  if (!S && !get('SELECT 1 x FROM payments WHERE id=? AND applied_at IS NOT NULL', o.id)) {
    // Some versions of the provider's messages do not say which subscription an invoice is for. Ask.
    const full = await stripe('GET', `invoices/${o.id}`).catch(() => null);
    if (full) S = subOf(full);
  }
  const named = namedAccount(o);
  let a = account(named) || (customer ? get('SELECT * FROM accounts WHERE stripe_customer_id=?', customer) : null);
  let sub: any = null;
  // An invoice that names a price of its own that is not ours (something else sold on a shared provider account),
  // or that is not for a subscription at all, is never matched to our plan by what its customer is subscribed to.
  const otherPrice = !!priceOf(o) && priceOf(o) !== process.env.STRIPE_PRICE_GROVE;
  const planLike = !o.billing_reason || String(o.billing_reason).startsWith('subscription');
  if (!S && customer && !otherPrice && planLike && !get('SELECT 1 x FROM payments WHERE id=? AND applied_at IS NOT NULL', o.id)) {
    // Not named on the invoice in any shape we know, and not on the invoice read back either. Before deciding
    // that this money pays for no plan (and sending it back), look at what the customer is subscribed to right
    // now: exactly one live subscription of ours is the one this invoice is for.
    const list = await stripe('GET', 'subscriptions', { customer, status: 'all', limit: '20' }).catch(() => null);
    // One that names another account than the invoice does is not this one.
    const live = ((list?.data || []) as any[]).filter((s) => [...LIVE, 'incomplete'].includes(s.status) && ours(s, s) && (!named || !s.metadata?.sg_account || s.metadata.sg_account === named));
    if (live.length === 1) (S = live[0].id), (sub = live[0]);
  }
  if (!a && !named && S && !sub) sub = await stripe('GET', `subscriptions/${S}`).catch(() => null);
  if (!a && sub?.metadata?.sg_account) a = account(sub.metadata.sg_account);
  // The account the subscription itself names is stronger evidence than a provider customer that two of our accounts
  // share (after an operator merged them, say): the payment goes to the account that subscription is for.
  else if (a && !named && sub?.metadata?.sg_account && sub.metadata.sg_account !== a.id && account(sub.metadata.sg_account)) a = account(sub.metadata.sg_account);
  const mine = ours(o, sub);
  // An account this was for and that was closed and deleted since. An id nobody here has ever heard of is not that.
  const gonefor = [named, sub?.metadata?.sg_account].find(wasDeleted) || null;
  const isPlan = !o.billing_reason || String(o.billing_reason).startsWith('subscription');
  // Signatures follow the money: the plan price buys the plan's signatures, a smaller invoice buys fewer, never more.
  // An account that is still on an earlier, lower price gets the full month for that price.
  const fullPrice = Math.min(PLAN_CENTS(), a?.price_cents || PLAN_CENTS());
  const credits = isPlan && currency === 'usd' ? Math.min(PRICING.monthlySignatures, Math.floor((cents * PRICING.monthlySignatures) / fullPrice)) : 0;
  const fresh = run('INSERT OR IGNORE INTO payments (id, account_id, amount_cents, currency, at, receipt_url, kind, credits, charge_id, customer_id, subscription_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    // Not ours: 'not_ours' when it names another price (something else sold on a shared provider account, which is
    // never looked at again), 'unknown' when nothing on it says (it may turn out to be ours once a checkout of ours
    // names its customer).
    o.id, a?.id ?? null, cents, currency, now(), o.hosted_invoice_url || o.invoice_pdf || null, !mine ? (priceOf(o) || priceOf(sub || {}) ? 'not_ours' : 'unknown') : isPlan ? 'plan' : 'other', credits, chargeOf(o), customer, S).changes;
  let p = get('SELECT * FROM payments WHERE id=?', o.id);
  if (p.applied_at) return;
  if (mine && (p.kind === 'unknown' || p.kind === 'not_ours')) run('UPDATE payments SET kind=?, credits=? WHERE id=?', isPlan ? 'plan' : 'other', credits, o.id);
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
    const second = hasSub(a) && LIVE.includes(a.subscription_status || '');
    const state = await adopt(a.id, customer, S, sub || undefined, o);
    if (state !== 'on') {
      // The first payment of a new plan can be reported a moment before the provider calls the subscription active.
      // Then the provider is asked to tell us again, rather than the money being sent back.
      if (state === 'dead' && !second && o.billing_reason === 'subscription_create') {
        const st = (sub || (await stripe('GET', `subscriptions/${S}`).catch(() => null)))?.status;
        if (st === 'incomplete' || st === 'past_due') throw new ProviderError('The subscription for this payment is not active yet.', true);
      }
      why = state === 'refused' || second ? 'this account already has a monthly plan, so this was a second charge' : 'this plan was already cancelled';
    }
    a = account(a.id);
  } else if (!S && !hasSub(a)) {
    // No subscription named, and the account is on none. The first payment of a new plan waits for its checkout to
    // be reported (it is then settled from there). Anything else on a plan that has ended goes back.
    if (o.billing_reason !== 'subscription_cycle' && a.subscription_status !== 'canceled') return;
    why = 'this plan was already cancelled';
  } else if (a.subscription_status === 'canceled') why = 'this plan was already cancelled';
  // The payment that was waiting when the plan was stopped (failing, or the new month's not taken yet), taken anyway.
  else if (paidAfterStop(a.id, o)) why = 'this plan was already cancelled';
  else if (a.cancel_at) {
    // Cancelled, and this invoice pays for time after the end of the last paid month.
    const start = (o.lines?.data?.[0]?.period?.start ?? 0) * 1000;
    if (start ? start >= Date.parse(a.cancel_at) - 60_000 : Date.parse(a.cancel_at) < Date.now()) why = 'this plan was already cancelled';
  }
  // Too small to buy a single signature: nothing to give for it, so it goes back.
  if (!why && credits < 1) why = 'it was too small to buy a signature';
  if (why) {
    // "Dealt with" and "a refund is owed" are written down together, before anything is asked of the provider, so a
    // restart in between cannot leave a charge that is marked done with no refund on record.
    run('UPDATE payments SET credits=0 WHERE id=?', o.id);
    done();
    const owed = oweNow(a, { ...p, credits: 0 }, cents, why);
    // Whatever charged this must not charge again.
    const stopped = !!S && a.stripe_subscription_id === S && a.subscription_status !== 'canceled' && paidAfterStop(a.id, o);
    if (S && (currency !== 'usd' || a.promo_code || a.stripe_subscription_id !== S || a.subscription_status === 'canceled' || a.cancel_at || stopped)) await endOrQueue(S, a.id);
    if (stopped) {
      // The customer had stopped the plan, and ending it at the provider had not gone through when this was taken.
      // It is over here now (the timer keeps at the provider if it did not confirm), and they are told once.
      run("UPDATE accounts SET plan='seedling', subscription_status='canceled', cancel_at=NULL, renews_at=NULL, sub_event_at=? WHERE id=?", unixNow(), a.id);
      log(a.id, 'ended', 'Ended: it had been stopped while a payment was waiting, and that payment was taken afterwards. It is refunded in full.', a.cancel_ref || '');
      await mailAdmins(a.id, 'Your monthly plan has ended', 'Your plan has ended and that payment is coming back', [
        `The monthly plan for ${a.name} had been stopped while a payment of ${money(cents, currency)} was still waiting. That payment went through afterwards, so we are refunding it in full and the plan has ended. You will not be charged again.`,
        `You still have ${sigs(Math.max(0, available(a.id)))}. They never expire. Nothing was deleted: every document, audit trail and receipt is still in your account.`,
      ], { label: 'Open the Plan page', url: planUrl() });
    }
    await payOwed(owed);
    if (why.startsWith('it was too small')) await tellOperators(`An invoice from ${a.name} was too small to buy a signature`, [`Invoice ${o.id}, ${money(cents, currency)}. It is being refunded. Check the price configured with the payment provider.`], a.id);
    return;
  }

  // A payment that got through brings a plan that was on hold back.
  if (a.plan !== 'grove' || a.subscription_status !== 'active')
    run("UPDATE accounts SET plan='grove', subscription_status=CASE WHEN subscription_status='trialing' THEN 'trialing' ELSE 'active' END WHERE id=?", a.id);
  grant(a.id, credits, 'plan', o.id);
  const next = iso(o.lines?.data?.[0]?.period?.end);
  if (next && (!a.renews_at || next > a.renews_at)) run('UPDATE accounts SET renews_at=? WHERE id=?', next, a.id);
  // Remember the tax on this one, so the next reminder can state the full amount without waiting for the provider.
  run('UPDATE accounts SET renewal_tax_cents=? WHERE id=?', taxOf(o), a.id);
  done();

  // The amount charged is the amount we said. At a renewal that is what the reminder said; otherwise it is the plan
  // price (before any tax). If more was taken, the difference goes back.
  const cycle = o.billing_reason === 'subscription_cycle';
  const paidFrom = iso(o.lines?.data?.[0]?.period?.start) || '';
  const reminded = !!paidFrom && String(a.renewal_reminded || '').startsWith(paidFrom.slice(0, 10));
  // And the price itself never goes up without notice: a renewal is held to the price the account was on, unless a
  // higher one was announced at least PRICE_NOTICE_DAYS before it started (priceFor). A first payment is held to
  // the price shown at its checkout, which adopt() wrote down. Tax inside the price adds nothing (taxOf).
  const heldTo = cycle ? priceFor(a, paidFrom) : a.price_cents || PLAN_CENTS();
  const allowed = heldTo + taxOf(o);
  const quoted = cycle && reminded && a.renewal_quoted_cents ? a.renewal_quoted_cents : allowed;
  const said = Math.min(quoted, allowed);
  const unannounced = cycle && cents > said && said === allowed;
  if (cents > said) {
    await owe(a, get('SELECT * FROM payments WHERE id=?', o.id), cents - said, unannounced
      ? `the price went up without the ${PRICE_NOTICE_DAYS} days' notice we promise, so you pay the price you were on: ${money(said, currency)}, not ${money(cents, currency)}`
      : `we said ${money(said, currency)} and ${money(cents, currency)} was charged`);
    await tellOperators(`${a.name} was charged more than we told them`, [`Invoice ${o.id}: we said ${money(said, currency)}, the charge was ${money(cents, currency)}. The difference is being refunded automatically. ${unannounced ? `This account is on ${money(priceFor(a, null))} a month and has not had ${PRICE_NOTICE_DAYS} days' notice of a higher price. Announce a price change on the operator page before changing the price with the payment provider.` : 'Check the price configured with the payment provider.'}`], a.id);
  } else if (cents - taxOf(o) !== heldTo)
    await tellOperators(`A monthly payment from ${a.name} was not the plan price`, [`Invoice ${o.id} was ${money(cents, currency)}; this account's plan is ${money(heldTo)}. ${sigs(credits)} were added. Check the price configured with the payment provider.`], a.id);
  // The price this account is on from here. It starts as the price shown at checkout and only moves at a renewal:
  // up when a higher price that was announced in time has now been charged, down when the provider's own price for
  // the plan is lower. A smaller invoice that is a one-off (a discount, a credit, part of a month) says nothing
  // about next month and changes nothing. A notice that has taken effect has done its job.
  const base = cents - taxOf(o);
  const line = o.lines?.data?.[0] || {};
  const unit = Number(line.price?.unit_amount ?? line.pricing?.unit_amount_decimal ?? line.plan?.amount ?? NaN);
  let nowOn = a.price_cents || PLAN_CENTS();
  if (cycle && base > nowOn && base <= allowed - taxOf(o)) nowOn = base;
  else if (cycle && base < nowOn && unit === base) nowOn = base;
  run('UPDATE accounts SET price_cents=? WHERE id=?', nowOn, a.id);
  if (a.price_notice_cents && nowOn >= a.price_notice_cents) run('UPDATE accounts SET price_notice_cents=NULL, price_notice_from=NULL, price_notice_at=NULL WHERE id=?', a.id);
  // A reminder only counts if an email for it actually left: one that the mail server never took is no reminder.
  const left = reminded && all("SELECT e.status FROM emails e WHERE e.to_email IN (SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')) AND e.at > ? AND (e.subject LIKE 'Heads up: your plan renews%' OR e.subject LIKE 'Last reminder: your plan renews%' OR e.subject LIKE 'Correction: your plan renews%')", a.id, new Date(Date.parse(paidFrom) - 9 * 864e5).toISOString()).some((m) => m.status === 'sent' || m.status === 'outbox');
  if (cycle && paidFrom && !left)
    await tellOperators(`${a.name} was renewed without a reminder reaching them first`, [`Invoice ${o.id}. ${reminded ? 'A reminder was written for' : 'No reminder is on record for'} the renewal of ${paidFrom.slice(0, 10)}${reminded ? ', but no email for it left the mail server' : ''}. Check that the timer (POST /api/cron) is being called at least once an hour and that email is working.`], a.id);

  await mailAdmins(a.id, `Receipt: ${money(cents, currency)} for ${sigs(credits)}`, 'Payment received. Thank you.', [
    `${money(cents, currency)} for ${a.name}, charged today. ${sigs(credits)} added: you now have ${sigs(Math.max(0, available(a.id)))} to send.`,
    `That plants ${trees(Math.min(cents, said))} with Treegens.`,
    ...(next && !a.cancel_at ? [`Next charge: ${money(priceFor(account(a.id), next))} on ${day(next)}. We remind you a week before and again about a day before.`] : []),
    refundRuleText(refundDays()),
    `Account: ${a.name}, reference ${a.id}. Receipts go to every owner and admin of the account.`,
  ], o.hosted_invoice_url ? { label: 'View invoice', url: o.hosted_invoice_url } : { label: 'Open the Plan page', url: planUrl() });
}

// The reminder before a renewal: once about a week before and once about a day before, each saying exactly what will
// be charged and when, each with a one-click way to stop it. Sent on our own timer; the provider's "upcoming invoice"
// message triggers the same thing and adds the exact amount. Every reminder is written to the plan history, and the
// amount in the latest one is what the charge is held to.
async function remindRenewal(acct: any, cents?: number | null, currency = 'usd', tax?: number | null): Promise<boolean> {
  const a = account(acct.id);
  const when = a?.renews_at;
  if (!when || a.plan !== 'grove' || !renewing(a) || !PAID_UP.includes(a.subscription_status || '')) return false;
  const hours = (Date.parse(when) - Date.now()) / 36e5;
  // The provider's own tax for this renewal is kept whenever its notice comes (it can be ten days or more ahead), so
  // the reminders quote it and a change in tax is told before the charge instead of refunded after it.
  if (cents != null && tax != null && hours > 0) run('UPDATE accounts SET renewal_tax_cents=? WHERE id=?', tax, a.id);
  if (hours <= 0 || hours > 7 * 24 + 1) return false;
  const key = when.slice(0, 10);
  const [k, sent = ''] = String(a.renewal_reminded || '').split('|');
  const already = k === key ? sent.split(',').filter(Boolean) : [];
  const told = k === key ? a.renewal_quoted_cents || 0 : 0;
  // What this renewal may cost: the price the account is on (or one it was told of in time) plus tax. The tax is
  // what the provider says it will be this time when it says, and otherwise what it was last time. Tax can change
  // without notice from us; the price cannot.
  const cap = priceFor(a, when) + (tax ?? (a.renewal_tax_cents || 0));
  let amountCents = cents ?? (told || cap);
  if (cents != null && cents - cap >= 50) {
    // The provider is about to charge more than that: the price was raised there without the notice we promise.
    // The customer is told what they will end up paying (the difference comes back when the charge is made), and a
    // person is told now, while there is still time to put the price right.
    amountCents = cap;
    if (run('INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?,?)', `overprice:${a.id}:${key}`, now()).changes)
      await tellOperators(`The next renewal for ${a.name} is set above the price they are on`, [`The payment provider will charge ${money(cents, currency)} on ${key}. This account is on ${money(priceFor(a, when))} a month and has not had ${PRICE_NOTICE_DAYS} days' notice of a higher price. If nothing changes, the difference is refunded automatically when the charge is made. Put the price back with the payment provider, or announce the new price on the operator page and start it after the notice period.`], a.id);
  }
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
  const left = `You have ${sigs(Math.max(0, available(a.id)))} left at the moment. They roll over either way.`;
  const out = 'To keep planting mangroves, do nothing. To stop, use the link below. It takes one click, needs no login, and works right up to the charge.';
  const went = raised && !due
    ? await mailAdmins(a.id, `Correction: your plan renews on ${day(when)} for ${amount}, not ${money(told, currency)}`, 'The amount of your next charge changed', [
      `We told you ${money(told, currency)} for ${a.name}. The payment provider now says the charge on ${day(when)} will be ${amount}. That is the full amount, and if more than this is taken we send the difference back.`, left, out,
    ], 'stop', when)
    : await mailAdmins(a.id, stage === '1' ? `Last reminder: your plan renews on ${day(when)} for ${amount}` : `Heads up: your plan renews on ${day(when)} for ${amount}`, stage === '1' ? 'Your plan renews in about a day' : 'Your plan renews soon', [
      `On ${day(when)} we will charge ${amount} for ${a.name} and add ${sigs(PRICING.monthlySignatures)}. That is the full amount: there are no extras, and if more than this is ever taken we send the difference back.`, left, out,
    ], 'stop', when);
  // The plan history says "sent" only for a reminder whose email left. One the mail server would not take is tried
  // again a few times (never after the renewal), and the history says it could not be delivered.
  const what = raised && !due ? `The amount changed to ${amount}.` : `${stage === '1' ? 'About a day' : 'About a week'} before: ${amount}.`;
  if (went.some(mailLeft)) log(a.id, 'reminder', what);
  else log(a.id, 'reminder-failed', `${what} The mail server did not take it. It is tried again a few times, but never after the renewal.`);
  return true;
}

// On the timer: remind everyone whose plan renews within a week.
export async function renewalReminders(): Promise<number> {
  if (!billingEnabled()) return 0;
  const rows = all("SELECT id FROM accounts WHERE plan='grove' AND promo_code IS NULL AND cancel_at IS NULL AND stripe_subscription_id IS NOT NULL AND renews_at > ? AND renews_at <= ?", now(), new Date(Date.now() + 7 * 864e5).toISOString());
  let n = 0;
  for (const a of rows) if (await serial(a.id, () => remindRenewal(a)).catch((e) => (console.error('[billing] reminder failed', a.id, e?.message), false))) n++;
  return n;
}

// How long to wait before the next try of something that keeps failing: at once for the first few, then longer.
const dueAgain = (tries: number, lastAt?: string | null) => tries < 5 || !lastAt || Date.now() - Date.parse(lastAt) > Math.min(6 * 3600_000, 2 ** (tries - 5) * 600_000);
// A person is told at the third failure, and then once for each further day it stays open.
const tellAgain = (tries: number, at: string, lastAt?: string | null) => tries === 3 || (tries > 3 && !!lastAt && Math.floor((Date.now() - Date.parse(at)) / 864e5) > Math.floor((Date.parse(lastAt) - Date.parse(at)) / 864e5));
const leastRecent = (x: any, y: any) => String(x.last_at || '').localeCompare(String(y.last_at || ''));

// The latest invoice of a subscription, applied if it is paid and we have not applied it: this is how a payment whose
// own message was lost is still found.
async function catchUpInvoice(sub: any) {
  const invId = sid(sub?.latest_invoice);
  if (!invId || get('SELECT 1 x FROM payments WHERE id=? AND applied_at IS NOT NULL', invId)) return;
  const inv = await stripe('GET', `invoices/${invId}`).catch(() => null);
  if (inv?.status === 'paid') await applyInvoice(inv);
}

// On the timer: whatever was owed to a customer and could not be done at the time (a refund, ending a subscription)
// is tried again until the provider confirms it, for as long as it takes, least recently tried first so that one that
// cannot move never keeps the others waiting. A person is told at the third failure and once a day after that.
// Payments that could not be applied are looked at again, and refunded after three days. Accounts whose state may
// have drifted from the provider's (a lost message) are read back from the provider.
export async function billingRetries(): Promise<number> {
  if (!billingEnabled()) return 0;
  let n = 0;
  for (const r of all("SELECT * FROM refunds WHERE status='pending'").filter((x) => dueAgain(x.tries, x.last_at)).sort(leastRecent).slice(0, 50)) {
    const state = await serial(r.account_id || `provider:${r.payment_id}`, async () => {
      try {
        return await tryRefund(r.id);
      } catch (e: any) {
        // The provider said no to a refund a customer asked for: undo it and get a person involved.
        if (!r.auto) {
          dropRefund(r.id);
          await tellOperators('A refund a customer asked for was refused by the payment provider', [`Refund ${r.id}, payment ${r.payment_id}${r.account_id ? `, account ${r.account_id}` : ''}: ${e?.message}. Their signatures are back on the balance. Refund it by hand and write to them.`], r.account_id);
          if (account(r.account_id)) await mailAdmins(r.account_id, 'Your refund needs a person', 'We could not send your refund automatically', ['The payment provider would not make the refund you asked for. The signatures are back on your balance, and a person here has been told and will refund it by hand and write to you. You do not need to do anything.']);
          return 'failed';
        }
        // A refund we owe that the provider has now clearly refused three times (not "could not be reached"): asking
        // again will not change that. It needs a person, the customer is told so once, and the timer stops.
        const again = get('SELECT * FROM refunds WHERE id=?', r.id);
        if (again?.status === 'pending' && (again.refused || 0) >= 3 && run("UPDATE refunds SET status='manual' WHERE id=? AND status='pending'", r.id).changes) {
          const p = get('SELECT currency FROM payments WHERE id=?', r.payment_id);
          await tellOperators('A refund we owe needs a person', [`Refund ${r.id} for payment ${r.payment_id}${r.account_id ? ` (account ${r.account_id})` : ''}, ${money(r.cents, p?.currency)}: ${r.why}. The payment provider refused it ${again.refused} times: ${e?.message}. The software has stopped trying. Refund the charge by hand in the provider's dashboard: that is recorded here as soon as the provider reports it, and the customer gets the usual "Refund sent" email. The customer has been told that a person will send it.`], r.account_id);
          if (account(r.account_id))
            await mailAdmins(r.account_id, `A person will send your refund of ${money(r.cents, p?.currency)}`, 'Your refund is being sent by hand', [
              `We owe you a refund of ${money(r.cents, p?.currency)}: ${owedWhy(r.why)}. The payment provider would not send it automatically, so a person here will send it to the card by hand and write to you when it is on its way. You do not need to do anything.`,
            ], { label: 'Open the Plan page', url: planUrl() });
          return 'manual';
        }
        return 'failed';
      }
    });
    if (state === 'done') n++;
    else if (state === 'pending' || (r.auto && state !== 'manual')) {
      const now_ = get('SELECT tries, at, last_at FROM refunds WHERE id=?', r.id);
      if (now_ && tellAgain(now_.tries, now_.at, r.last_at))
        await tellOperators('A refund we owe has not gone through yet', [`Refund ${r.id} for payment ${r.payment_id}${r.account_id ? ` (account ${r.account_id})` : ''}, ${money(r.cents)}: ${r.why}. Tried ${now_.tries} times. We keep trying. If the provider's dashboard shows why, fix it there, or refund the charge by hand: that is recorded here as soon as the provider reports it, and this stops.`], r.account_id);
    }
  }
  for (const t of all('SELECT * FROM billing_todo WHERE done_at IS NULL').filter((x) => dueAgain(x.tries, x.last_at)).sort(leastRecent).slice(0, 50)) {
    if (await serial(t.account_id || `provider:${t.ref}`, () => endSubscription(t.ref, true)).catch(() => false)) {
      run('UPDATE billing_todo SET done_at=? WHERE id=?', now(), t.id);
      n++;
    } else {
      run('UPDATE billing_todo SET tries=tries+1, last_at=? WHERE id=?', now(), t.id);
      if (tellAgain(t.tries + 1, t.at, t.last_at))
        await tellOperators('A subscription that must end is still alive at the payment provider', [`Subscription ${t.ref}${t.account_id ? ` (account ${t.account_id})` : ''} could not be ended after ${t.tries + 1} tries. We keep trying; end it by hand in the provider's dashboard so it cannot charge.`], t.account_id);
    }
  }
  // Payments that were written down and never turned into signatures or sent back: nobody could be found for them,
  // or working them out failed half way. Each is looked at again. One that is ours and still stuck after three days
  // goes back, and a person is told. One we could not tell was ours is only ever picked up, never refunded. On a
  // provider account shared with something else, what is not ours never takes a place here: an invoice for another
  // price is never looked at again, and one that says nothing is looked at only once its customer is one of ours
  // (until then the checkout that names the customer picks it up). The least recently looked at go first.
  for (const p of all(`SELECT * FROM payments WHERE applied_at IS NULL AND at < ? AND (kind='plan' OR (kind='unknown' AND customer_id IS NOT NULL AND EXISTS (SELECT 1 FROM accounts a WHERE a.stripe_customer_id=payments.customer_id)))
      ORDER BY COALESCE(checked_at, ''), at LIMIT 40`, new Date(Date.now() - 3600_000).toISOString())) {
    run('UPDATE payments SET checked_at=? WHERE id=?', now(), p.id);
    const inv = await stripe('GET', `invoices/${p.id}`).catch(() => null);
    const who = p.account_id || (inv && account(namedAccount(inv))?.id) || get('SELECT id FROM accounts WHERE stripe_customer_id=?', p.customer_id || '-')?.id || `provider:${p.customer_id || p.id}`;
    await serial(who, async () => {
      if (inv?.id) await applyInvoice(inv).catch((e) => console.error('[billing] payment still not applied', p.id, e?.message));
      const again = get('SELECT * FROM payments WHERE id=?', p.id);
      if (!again || again.applied_at || again.kind !== 'plan' || Date.parse(again.at) > Date.now() - 3 * 864e5) return;
      const acct = account(again.account_id);
      run('UPDATE payments SET applied_at=?, credits=0 WHERE id=?', now(), p.id);
      const owed = oweNow(acct, { ...again, credits: 0 }, again.amount_cents, acct ? 'its signatures could not be added' : 'we could not tell which account this payment was for');
      if (again.subscription_id && !(acct && hasSub(acct) && acct.stripe_subscription_id === again.subscription_id)) await endOrQueue(again.subscription_id, acct?.id);
      await payOwed(owed);
      await tellOperators(acct ? `A payment from ${acct.name} could not be applied and was refunded` : 'An unmatched payment was refunded after three days', [`Invoice ${p.id}, ${money(p.amount_cents, p.currency)}, customer ${p.customer_id}${acct ? `, account ${acct.id}` : ''}. ${acct ? 'Its signatures could not be added for three days' : 'Nobody could be found for it'}, so it is being refunded${acct ? '' : ' and its subscription ended'}. Check that it went through.`], acct?.id);
    });
  }
  // Accounts that should have heard from the provider by now: a cancelled plan whose end has passed, or a renewal
  // time that came and went. The provider is asked what is true, at most every six hours for each account.
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const monthAgo = new Date(Date.now() - 32 * 864e5).toISOString();
  const stale = all('SELECT * FROM accounts WHERE stripe_subscription_id IS NOT NULL AND promo_code IS NULL AND ((cancel_at IS NOT NULL AND cancel_at < ?) OR (renews_at IS NOT NULL AND renews_at < ?)) AND (sub_event_at IS NULL OR sub_event_at < ?) ORDER BY COALESCE(sub_event_at, 0) LIMIT 20', hourAgo, threeHoursAgo, unixNow() - 6 * 3600).filter(hasSub);
  // And plans that look fine but have no payment on record for over a month: the message about it may have been lost.
  const unpaid = all("SELECT * FROM accounts a WHERE a.plan='grove' AND a.promo_code IS NULL AND a.stripe_subscription_id IS NOT NULL AND COALESCE(a.plan_started_at, a.created_at) < ? AND (a.invoice_checked_at IS NULL OR a.invoice_checked_at < ?) AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.account_id=a.id AND p.kind='plan' AND p.at > ?) LIMIT 20", monthAgo, dayAgo, monthAgo).filter((a) => hasSub(a) && !stale.some((x) => x.id === a.id));
  for (const a of [...stale, ...unpaid]) {
    await serial(a.id, async () => {
      run('UPDATE accounts SET invoice_checked_at=? WHERE id=?', now(), a.id);
      const sub = await stripe('GET', `subscriptions/${a.stripe_subscription_id}`).catch((e) => (gone(e) ? { id: a.stripe_subscription_id, status: 'canceled' } : null));
      if (!sub) return;
      if (stale.includes(a)) await applySubscription(account(a.id), sub, unixNow(), sub.status === 'canceled' || sub.status === 'incomplete_expired');
      await catchUpInvoice(sub).catch((e) => console.error('[billing] could not catch up on the latest invoice', a.id, e?.message));
    });
  }
  // Messages from the provider that were received and not applied: the server stopped in between, or applying
  // failed. Each is tried again with growing gaps. After three days a person is told and the message is dropped;
  // by then the reconciliation above has read the truth back from the provider for anything that matters.
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  // Only the rows that are due are taken, oldest message first, so rows that are waiting out their gap never hide a
  // newer one behind them however many there are.
  const rows = all('SELECT id, at, tries, last_at FROM stripe_inbox WHERE at < ? ORDER BY at', minuteAgo);
  const old = rows.filter((r) => Date.parse(r.at) < Date.now() - 3 * 864e5);
  const due = rows.filter((r) => !old.includes(r) && !(r.last_at && Date.parse(r.last_at) > Date.now() - Math.min(360, 2 ** Math.min(r.tries, 8)) * 60_000)).slice(0, 100);
  for (const r of old) {
    const row = get('SELECT * FROM stripe_inbox WHERE id=?', r.id);
    if (!row) continue;
    run('DELETE FROM stripe_inbox WHERE id=?', row.id);
    let type = '';
    try { type = JSON.parse(row.body)?.type || ''; } catch {}
    await tellOperators('A message from the payment provider could not be applied for three days', [`Event ${row.id}${type ? ` (${type})` : ''}, received ${row.at}. Last error: ${row.error || 'none recorded'}. It was dropped. Look the event up with the payment provider and check the account it was about.`]);
  }
  for (const r of due) {
    const row = get('SELECT * FROM stripe_inbox WHERE id=?', r.id);
    if (!row) continue;
    let ev: any = null;
    try { ev = JSON.parse(row.body); } catch {}
    if (!ev) { run('DELETE FROM stripe_inbox WHERE id=?', row.id); continue; }
    // One message that takes too long (a provider or mail server that stops answering) does not hold up the rest of
    // the timer: it carries on by itself, and its row stays until it is done.
    const work = settleInbox(ev).then(() => void n++, (e) => console.error('[billing] a provider message still cannot be applied', row.id, e?.message));
    let timer: any;
    await Promise.race([work, new Promise((res) => (timer = setTimeout(res, inboxLimitMs())))]);
    clearTimeout(timer);
  }
  run('DELETE FROM stripe_events WHERE at < ?', new Date(Date.now() - 60 * 864e5).toISOString());
  // Payments kept aside that never turned out to be ours go after 90 days. One whose customer is one of ours is
  // ours to settle, and stays until it is.
  run("DELETE FROM payments WHERE kind IN ('unknown','not_ours') AND account_id IS NULL AND applied_at IS NULL AND at < ? AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.stripe_customer_id=payments.customer_id)", new Date(Date.now() - 90 * 864e5).toISOString());
  return n;
}

// What the provider says about the subscription an account is on, applied to the account. Used for its messages and
// for reading the state back when a message may have been lost.
async function applySubscription(a: any, o: any, at: number, ended: boolean) {
  const live = !ended && LIVE.includes(o.status);
  const end = periodEnd(o);
  const endsAt = live ? plannedEnd(o) : null;
  // Set to end, and not yet worked out here (or the payment is failing now): what that means is decided below from
  // what the provider says right now, and only then is the end written down (cancelPlan). Never from a date we wrote
  // before the provider had answered, so a failed call is tried again with the next message instead of being lost.
  const toEnd = live && !!endsAt && (!a.cancel_at || !PAID_UP.includes(o.status));
  run('UPDATE accounts SET plan=?, subscription_status=?, renews_at=?, cancel_at=?, sub_event_at=? WHERE id=?', live ? 'grove' : 'seedling', ended ? 'canceled' : o.status,
    live ? end || a.renews_at : null, toEnd ? a.cancel_at ?? null : endsAt, at || a.sub_event_at || null, a.id);
  if (ended && a.subscription_status !== 'canceled') {
    log(a.id, 'ended', 'The monthly plan ended.', a.cancel_ref || '');
    if (a.plan === 'grove')
      await mailAdmins(a.id, 'Your monthly plan has ended', 'Your plan has ended', ['You will not be charged again. Nothing was deleted: every document, audit trail and receipt is still in your account.', `You still have ${sigs(Math.max(0, available(a.id)))}. They never expire, and signing your own documents is always free. Come back to the monthly plan whenever you like.`]);
  } else if (!live && !ended && a.plan === 'grove')
    await mailAdmins(a.id, 'Your monthly plan is on hold', 'Your plan is on hold because a payment did not go through', [
      'Nothing is locked and nothing is deleted. The signatures you already have stay yours and still work.',
      'To bring the plan back, open the Plan page and press "Pay the open payment". You can use another card there. A new card on file is not enough by itself: the payment that failed is no longer tried automatically.',
      'To end the plan for good, press Cancel there: the failed payment is then withdrawn and never tried again.',
    ], { label: 'Open the Plan page', url: planUrl() });
  else if (toEnd) {
    // Set to end somewhere other than here (the provider's own page), or the provider's echo of a Cancel pressed here
    // whose answer did not come back. It is worked out exactly as when it is cancelled here, from the subscription as
    // the provider shows it now: paid up runs to the end of the paid month; a failing payment, or a new month whose
    // payment has not been taken, ends today and that payment is withdrawn. If the provider cannot be asked or does
    // not confirm, this fails and the message is applied again later, so the cancellation is never lost. Same
    // reference, history line and one email either way.
    const fresh = await stripe('GET', `subscriptions/${o.id}`).catch((e) => (gone(e) ? { id: o.id, status: 'canceled' } : Promise.reject(e)));
    if (['canceled', 'incomplete_expired'].includes(fresh?.status)) return applySubscription(account(a.id), fresh, at, true);
    // Undone again since: nothing to work out.
    if (!plannedEnd(fresh) && LIVE.includes(fresh?.status)) return;
    // Already cancelled before, and now the payment is failing: the same cancellation, ending sooner.
    await cancelPlan(account(a.id), pressedBy(a.id) || (a.cancel_at ? 'earlier' : "on the payment provider's page"), false, fresh);
  } else if (live && !endsAt && a.cancel_at) {
    unstop(a.id);
    log(a.id, 'resumed', "On the payment provider's page.", a.cancel_ref || '');
    await mailAdmins(a.id, `Your ${PRICING.planName} plan continues`, 'The cancellation was undone', [`The cancellation of the monthly plan for ${a.name} was undone on the payment provider's page. ${end ? `The next charge is ${money(priceFor(a, end))} on ${day(end)}.` : ''} To stop it again, use the link below.`], 'stop');
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
    if (!a || (subOf(o) && subOf(o) !== a.stripe_subscription_id) || (priceOf(o) && priceOf(o) !== process.env.STRIPE_PRICE_GROVE && !namedAccount(o))) return;
    // The renewal is the end of the period we already know. If we do not know it yet, take it from the message.
    const theirs = iso(o.period_end || o.next_payment_attempt);
    if (theirs && (!a.renews_at || Math.abs(Date.parse(a.renews_at) - Date.parse(theirs)) > 3 * 864e5)) run('UPDATE accounts SET renews_at=? WHERE id=?', theirs, a.id);
    await remindRenewal(a, o.amount_due ?? null, o.currency || 'usd', o.amount_due != null ? taxOf(o) : null);
    return;
  }

  if (ev.type === 'invoice.payment_failed') {
    const a = byCustomer();
    // Only a failed payment of the plan this account is on. A declined card at checkout is shown on the payment page
    // itself, and a failed payment of something else is not ours to write about.
    if (a && hasSub(a) && subOf(o) === a.stripe_subscription_id) {
      log(a.id, 'paused', 'A monthly payment did not go through.');
      await mailAdmins(a.id, 'Your monthly payment did not go through', 'A payment failed', [
        'Nothing is locked and nothing is deleted. If the payment keeps failing, the monthly plan simply ends. Every document stays available, and the signatures you already have stay yours.',
        'To keep the plan, update the card on the Plan page. To stop it instead, press Cancel there: the failed payment will then not be tried again.',
      ], { label: 'Open the Plan page', url: planUrl() });
    }
    return;
  }

  if (ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted') {
    const ended = ev.type === 'customer.subscription.deleted' || ['canceled', 'incomplete_expired'].includes(o.status);
    const a = byCustomer() || account(o.metadata?.sg_account);
    if (!a) return;
    // Another subscription of the same customer, for something else sold on the same provider account: not ours.
    if (a.stripe_subscription_id !== o.id && o.metadata?.sg_account !== a.id && priceOf(o) !== process.env.STRIPE_PRICE_GROVE) return;
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
    // Our own refunds come back through here and change nothing: they are already on record. One of ours that was
    // still waiting is settled here: found by our reference, or, when the provider's total already covers it, because
    // the money went back another way (a person refunded it by hand). Anything beyond that is a refund made outside
    // the app; it is recorded too, and takes the signatures of that payment with it.
    const found = await paymentForCharge(o, byCustomer());
    if (found.doubt) return unsure(o, 'A refund at the payment provider', 'Nothing was changed on the account. If it was a refund of a Sign&Grow payment, record it by hand: take the signatures it paid for off the balance and write to the customer.');
    let p = found.p;
    if (!p) return;
    const total = Math.min(p.amount_cents, Number(o.amount_refunded ?? o.amount) || 0);
    // A refund that needs a person (the provider refused it) is settled here too when that person sends it by hand.
    const waiting = all("SELECT * FROM refunds WHERE payment_id=? AND status IN ('pending','manual') ORDER BY at", p.id);
    if (waiting.length) {
      const list = await stripe('GET', 'refunds', { charge: o.id, limit: '100' }).catch(() => ({ data: [] }));
      for (const r of waiting) {
        const hit = (list.data || []).find((x: any) => x.metadata?.sg_ref === r.id);
        if (hit) await settleRefund(r.id, hit.id);
        else if (total >= get('SELECT refunded_cents FROM payments WHERE id=?', p.id).refunded_cents + r.cents) await settleRefund(r.id, 'outside');
      }
    }
    p = get('SELECT * FROM payments WHERE id=?', p.id);
    const extra = total - p.refunded_cents;
    if (extra <= 0 || p.disputed) return;
    run('UPDATE payments SET refunded_at=COALESCE(refunded_at, ?), refunded_cents=? WHERE id=?', now(), total, p.id);
    const acct = account(p.account_id);
    const { taken, used } = takeBack(acct, p, extra, `out:${o.id}:${total}`);
    if (acct) log(acct.id, 'refund', `${money(extra, p.currency)} refunded by the payment provider.${taken ? ` ${sigs(taken)} left the balance with it.` : ''}`);
    await tellOperators(`A refund made outside the app was recorded${acct ? `: ${acct.name}` : ''}`, [`Payment ${p.id}: ${money(extra, p.currency)} went back to the card. ${sigs(taken)} it had paid for were taken off the balance${used ? `; ${sigs(used)} had already been used and stay used` : ''}. The customer has been told by email.`], acct?.id);
    // The customer hears it from us too: what went back, what it did to the balance and why, and whether the plan goes on.
    if (acct) {
      const now_ = account(acct.id);
      await mailAdmins(acct.id, `Refund sent: ${money(extra, p.currency)}`, 'Money went back to your card', [
        `${money(extra, p.currency)} of your ${PAYMENT_LABEL[p.kind]?.toLowerCase() || ''} payment of ${money(p.amount_cents, p.currency)} from ${day(p.at)} was refunded to the card it was paid with. It was sent by a person here, through the payment provider. Banks usually show it within 5 to 10 working days.`,
        taken || used
          ? `Signatures follow the money, so the ${sigs(taken + used)} it paid for went with it: ${taken ? `${sigs(taken)} left your balance` : 'none could leave your balance'}${used ? `, and ${sigs(used)} had already been used and stay used` : ''}. You have ${sigs(Math.max(0, available(acct.id)))} to send now.`
          : 'Your signature balance is unchanged.',
        renewing(now_) && now_.plan === 'grove' && now_.renews_at
          ? `Your monthly plan is not affected and continues: it renews on ${day(now_.renews_at)}, and we remind you before that. To stop it, use the link below.`
          : hasSub(now_) ? 'Your monthly plan is not affected by this refund.' : 'Nothing else changes.',
      ], renewing(now_) ? 'stop' : { label: 'Open the Plan page', url: planUrl() });
    }
    return;
  }

  // The bank could not deliver a refund after all (a closed card, for example). It is undone here, its signatures
  // go back on the balance, and a person takes over.
  if ((ev.type === 'refund.failed' || ev.type === 'refund.updated' || ev.type === 'charge.refund.updated') && o.status === 'failed') {
    const r = get("SELECT * FROM refunds WHERE provider_id=? AND status='done'", o.id || '-');
    if (!r) return;
    run("UPDATE refunds SET status='failed' WHERE id=?", r.id);
    run('UPDATE payments SET refunded_cents=MAX(0, refunded_cents-?), credits_refunded=MAX(0, credits_refunded-?) WHERE id=?', r.cents, r.signatures, r.payment_id);
    if (r.account_id) run("DELETE FROM credits WHERE account_id=? AND reason='refund' AND ref=?", r.account_id, r.id);
    await tellOperators('A refund could not be delivered by the bank', [`Refund ${o.id} for payment ${r.payment_id}${r.account_id ? ` (account ${r.account_id})` : ''}, ${money(r.cents)}. It has been undone here${r.signatures ? ` and its ${sigs(r.signatures)} are back on the balance` : ''}. Find another way to return the money and write to the customer.`], r.account_id);
    if (account(r.account_id)) await mailAdmins(r.account_id, 'Your refund could not be delivered', 'The bank could not deliver your refund', [`The refund of ${money(r.cents)} we sent could not be delivered to the card (banks do this when a card has been closed, for example).${r.signatures ? ` The ${sigs(r.signatures)} are back on your balance for now.` : ''} A person here has been told and will write to you about another way to return the money.`]);
    return;
  }

  // A card dispute means the customer wants out. All further billing stops at once and new payments are switched off
  // until a person has looked. The signatures the disputed payment bought leave the balance, so nobody ends up with
  // the money and the signatures. Small disputes are accepted with the provider rather than fought
  // (ACCEPT_DISPUTES_UP_TO_USD, 0 to leave them all to a person); for larger ones the signatures are set aside until
  // the bank decides, and come back if the payment stands. Disputes on charges that are not ours are left alone.
  if (ev.type === 'charge.dispute.created') {
    // Not being able to ask is a failure of the whole message, so the provider sends it again.
    const charge = o.charge && billingEnabled() ? await stripe('GET', `charges/${sid(o.charge)}`).catch((e) => { if (e instanceof ProviderError && e.unsure) throw e; return null; }) : null;
    const byCharge = charge?.customer ? get('SELECT * FROM accounts WHERE stripe_customer_id=?', sid(charge.customer)) : null;
    const found = await paymentForCharge(charge || { id: sid(o.charge), payment_intent: sid(o.payment_intent) }, byCharge);
    // Nothing is stopped, taken or conceded on a guess: a person looks.
    if (found.doubt) return unsure({ ...(charge || {}), id: sid(o.charge) || charge?.id, dispute: o.id }, 'A card dispute', 'Nothing was stopped, taken off the balance or conceded. If it is about a Sign&Grow payment, handle it in the provider\'s dashboard and on the operator page, and write to the customer.');
    const p = found.p;
    if (!p || p.disputed) return;
    const a = account(p.account_id) || byCharge;
    // A refund of ours that was still on its way for this payment cannot go through now.
    for (const r of all("SELECT id FROM refunds WHERE payment_id=? AND status IN ('pending','manual')", p.id)) dropRefund(r.id);
    const amount = Number(o.amount ?? charge?.amount ?? p.amount_cents) || p.amount_cents;
    const limit = process.env.ACCEPT_DISPUTES === '0' ? 0 : (process.env.ACCEPT_DISPUTES_UP_TO_USD === undefined ? 25 : Number(process.env.ACCEPT_DISPUTES_UP_TO_USD) || 0) * 100;
    const accepted = !!o.id && amount <= limit && (await stripe('POST', `disputes/${o.id}/close`).then(() => true).catch(() => false));
    const { taken, used } = takeBack(a, get('SELECT * FROM payments WHERE id=?', p.id), p.amount_cents - p.refunded_cents, `dispute:${p.id}`, 'dispute');
    // Conceded: the money is going back, so the payment counts as returned. Not conceded: nothing has gone back yet.
    if (accepted) run("UPDATE payments SET disputed='lost', dispute_taken=?, refunded_at=COALESCE(refunded_at, ?), refunded_cents=amount_cents WHERE id=?", taken, now(), p.id);
    else run("UPDATE payments SET disputed='open', dispute_taken=? WHERE id=?", taken, p.id);
    const forOps = accepted ? 'The dispute was accepted with the payment provider automatically, so the bank returns the money.'
      : `The dispute was NOT accepted automatically (${amount > limit ? 'it is above the amount that is conceded without a person' : 'the provider did not take it'}). Decide in the provider's dashboard whether to accept or answer it. If the bank decides the payment stands, the signatures come back by themselves.`;
    if (!a) return tellOperators('Card dispute on a payment whose account no longer exists', [`Dispute ${o.id}, payment ${p.id}. ${forOps}`]);
    const hadPlan = hasSub(a);
    const stopped = !hadPlan || (await endOrQueue(a.stripe_subscription_id, a.id));
    run("UPDATE accounts SET dispute_at=?, plan=CASE WHEN promo_code IS NULL THEN 'seedling' ELSE plan END, subscription_status=CASE WHEN promo_code IS NULL THEN 'canceled' ELSE subscription_status END, cancel_at=NULL, renews_at=NULL, sub_event_at=? WHERE id=?", now(), unixNow(), a.id);
    log(a.id, 'dispute', `A payment of ${money(amount, p.currency)} was disputed with the bank. Payments are switched off until a person has looked.${taken ? ` ${sigs(taken)} ${accepted ? 'left the balance with it' : 'are set aside until the bank decides'}.` : ''}`, o.id || '');
    await mailAdmins(a.id, 'A payment was disputed, so we stopped billing you', 'A payment was disputed with your bank', [
      `A payment of ${money(amount, p.currency)} to Sign&Grow was disputed with the card's bank. ${accepted ? 'We are not contesting it: the bank returns the money to the card.' : 'A person here will look at it and write to you.'}`,
      ...(hadPlan ? ['Your monthly plan has ended and nothing more will be charged.'] : a.promo_code ? [`Your plan stays free with the code ${a.promo_code}.`] : []),
      taken ? (accepted ? `The ${sigs(taken)} that payment bought have left your balance, as with any refund.` : `The ${sigs(taken)} that payment bought are set aside until the bank decides. If the payment stands, they come back.`) + ` You have ${sigs(Math.max(0, available(a.id)))} to send now. Envelopes that are already out can still be signed.` : 'Your balance is unchanged.',
      'Nothing was deleted. New payments are switched off on this account for now. If the dispute was a mistake, reply to this email or use the contact form and a person will switch them back on.',
    ], { label: 'Contact us', url: `${baseUrl()}/help?topic=billing#contact` });
    await tellOperators(`Card dispute: ${a.name}`, [`Account ${a.name} (${a.id}), dispute ${o.id}, ${money(amount, p.currency)}. Billing was stopped${stopped ? '' : ', but the provider did not confirm the subscription ended (we keep trying)'}. ${forOps} ${sigs(taken)} were taken off the balance (including any held for envelopes that are out); ${sigs(used)} bought with that payment had already been used by people signing. New payments stay off until you switch them back on in the operator queue. The customer has been told in writing.`], a.id);
    return;
  }

  // The bank has decided a dispute we did not concede.
  if (ev.type === 'charge.dispute.closed') {
    const ids = [sid(o.charge), sid(o.payment_intent)].filter(Boolean) as string[];
    let invoiceId = '-';
    // A message that names only the charge, for a payment we know by its payment (a top-up): the charge is looked
    // up, as when the dispute was opened.
    if (o.charge && billingEnabled() && !get(`SELECT 1 x FROM payments WHERE charge_id IN (${ids.map(() => '?').join(',')})`, ...ids)) {
      const charge = await stripe('GET', `charges/${sid(o.charge)}`).catch((e) => { if (e instanceof ProviderError && e.unsure) throw e; return null; });
      if (sid(charge?.payment_intent)) ids.push(sid(charge.payment_intent)!);
      invoiceId = sid(charge?.invoice) || '-';
    }
    const mark = ids.length ? ids.map(() => '?').join(',') : "'-'";
    const p = get(`SELECT * FROM payments WHERE disputed='open' AND (charge_id IN (${mark}) OR id=?)`, ...ids, invoiceId);
    if (!p) {
      // The bank decided before we had applied the message that the dispute was opened (it failed and is being tried
      // again). This one waits for it, so the decision is not lost; after three days a person is told (billingRetries).
      if (get(`SELECT 1 x FROM payments WHERE (charge_id IN (${mark}) OR id=?) AND disputed IS NULL`, ...ids, invoiceId))
        throw new ProviderError('The dispute this decides has not been recorded yet. It is applied once it has.', true);
      return;
    }
    const a = account(p.account_id);
    if (o.status === 'lost') {
      run("UPDATE payments SET disputed='lost', refunded_at=COALESCE(refunded_at, ?), refunded_cents=amount_cents WHERE id=?", now(), p.id);
      if (a) log(a.id, 'dispute', 'The bank returned the disputed payment to the card.', o.id || '');
      return tellOperators(`Dispute lost${a ? `: ${a.name}` : ''}`, [`Dispute ${o.id}, payment ${p.id}: the bank returned the money. The signatures set aside for it stay off the balance.`], a?.id);
    }
    // Won, or closed without the money moving: the payment stands, so its signatures come back.
    run("UPDATE payments SET disputed='won', dispute_taken=0, credits_refunded=MAX(0, credits_refunded-?) WHERE id=?", p.dispute_taken, p.id);
    if (a && p.dispute_taken > 0) grant(a.id, p.dispute_taken, 'dispute', `dispute-won:${p.id}`);
    if (a) {
      log(a.id, 'dispute', `The bank decided the disputed payment stands.${p.dispute_taken ? ` ${sigs(p.dispute_taken)} are back on the balance.` : ''}`, o.id || '');
      await mailAdmins(a.id, 'The disputed payment stands', 'The bank has decided the dispute', [
        `The bank decided that the payment of ${money(p.amount_cents, p.currency)} to Sign&Grow stands.${p.dispute_taken ? ` The ${sigs(p.dispute_taken)} it bought are back on your balance.` : ''}`,
        'New payments are still switched off on this account. Reply to this email or use the contact form and a person will switch them back on.',
      ], { label: 'Contact us', url: `${baseUrl()}/help?topic=billing#contact` });
    }
    await tellOperators(`Dispute closed in our favour${a ? `: ${a.name}` : ''}`, [`Dispute ${o.id}, payment ${p.id}: the payment stands${p.dispute_taken ? ` and ${sigs(p.dispute_taken)} went back on the balance` : ''}. Payments are still off for this account; switch them back on in the operator queue if that is right.`], a?.id);
  }
}

// Which account's queue a provider message belongs in, worked out from what we already know (no waiting). A message
// about someone we cannot place yet waits in a queue of its own for that provider customer.
function eventKey(ev: any): string {
  const o = ev?.data?.object || {};
  const t = String(ev?.type || '');
  const byCus = (c: any): string | null => (sid(c) ? get('SELECT id FROM accounts WHERE stripe_customer_id=?', sid(c))?.id || null : null);
  let who: string | null = null;
  if (t.startsWith('checkout.session.')) who = account(o.metadata?.sg_account || o.client_reference_id)?.id || byCus(o.customer);
  else if (t.startsWith('invoice.')) who = account(namedAccount(o))?.id || byCus(o.customer);
  else if (t.startsWith('customer.subscription.')) who = byCus(o.customer) || account(o.metadata?.sg_account)?.id || null;
  else if (t.startsWith('charge.') || t.startsWith('refund.')) {
    const ids = [o.id, sid(o.charge), sid(o.payment_intent)].filter(Boolean);
    const p = ids.length ? get(`SELECT account_id FROM payments WHERE charge_id IN (${ids.map(() => '?').join(',')})`, ...ids) : null;
    const viaRefund = t.includes('refund') && o.id ? get('SELECT account_id FROM refunds WHERE provider_id=?', o.id) : null;
    who = p?.account_id || viaRefund?.account_id || byCus(o.customer);
  }
  return who || `provider:${sid(o.customer) || sid(o.charge) || o.id || 'unknown'}`;
}

// The provider repeats its messages, and sends several at once. Each one is applied once and in turn for its
// account; one that failed half way is applied again in full, and every step above is safe to repeat.
export const applyStripeEvent = async (ev: any): Promise<void> => {
  let key = eventKey(ev);
  // The account may have become known while this message waited (the checkout that names it was ahead of it in
  // another queue). Then it takes its turn there instead. It leaves the first queue before it joins the next one,
  // so no queue ever waits on another (two queues waiting on each other would wait for ever), and it moves at most
  // twice: after that it is applied where it is.
  for (let moves = 0; ; moves++) {
    const from = key;
    const next = await serial(from, async (): Promise<string | null> => {
      const now_ = eventKey(ev);
      if (now_ !== from && moves < 2) return now_;
      if (ev?.id && get('SELECT id FROM stripe_events WHERE id=?', ev.id)) return null;
      await handleEvent(ev);
      if (ev?.id) run('INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?,?)', ev.id, now());
      return null;
    });
    if (!next) return;
    key = next;
  }
};

// Applies a message that is in the inbox and takes it out. A failure is written on its row and the row stays, so
// the timer tries it again (see billingRetries) whether or not the provider does.
async function settleInbox(ev: any): Promise<void> {
  try {
    await applyStripeEvent(ev);
    if (ev?.id) run('DELETE FROM stripe_inbox WHERE id=?', ev.id);
  } catch (e: any) {
    if (ev?.id) run('UPDATE stripe_inbox SET tries=tries+1, last_at=?, error=? WHERE id=?', now(), String(e?.message || e).slice(0, 300), ev.id);
    throw e;
  }
}
// How long the provider's message is worked on before it is answered. The provider waits only so long for an
// answer and counts a late one as a failure, so a message that takes longer (the account's queue is busy, the
// payment provider or the mail server is slow) is answered "received" and finished in the background.
const webhookWaitMs = () => Number(process.env.STRIPE_WEBHOOK_WAIT_MS) || 5000;
// How long the timer waits for one message from its inbox before it goes on with the next (see billingRetries).
const inboxLimitMs = () => 30_000;

route('POST', '/stripe/webhook', async (c) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(501, 'Billing is not set up.');
  const raw = await c.req.text();
  if (!verifyStripeSignature(raw, c.req.headers.get('stripe-signature') || '', secret)) throw new HttpError(400, 'Bad signature.');
  const ev = JSON.parse(raw);
  // Kept before anything else happens, so a message is never lost between "received" and "applied": not by a
  // restart, and not by an error half way.
  if (ev?.id) run('INSERT OR IGNORE INTO stripe_inbox (id, body, at) VALUES (?,?,?)', ev.id, raw, now());
  const work = settleInbox(ev);
  work.catch(() => {}); // a failure after we answered is on the inbox row, not an unhandled error
  let timer: any;
  const late = new Promise<'later'>((r) => (timer = setTimeout(() => r('later'), webhookWaitMs())));
  try {
    // A failure inside the wait is still answered with an error, so the provider sends the message again as well.
    const how = await Promise.race([work.then(() => 'applied' as const), late]);
    return { received: true, applied: how === 'applied' };
  } finally {
    clearTimeout(timer);
  }
}, 'public');

// Once every two months at most: tell people who pay but do not send, so nobody funds a forgotten plan by accident.
export async function dormancyNudges(): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString();
  const rows = all("SELECT * FROM accounts WHERE plan='grove' AND promo_code IS NULL AND cancel_at IS NULL AND stripe_subscription_id IS NOT NULL AND (dormant_nudged_at IS NULL OR dormant_nudged_at < ?) AND created_at < ? AND COALESCE(plan_started_at, created_at) < ?", cutoff, cutoff, cutoff)
    .filter((a) => hasSub(a) && PAID_UP.includes(a.subscription_status) && get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at > ?", a.id, cutoff).n === 0);
  for (const a of rows) {
    run('UPDATE accounts SET dormant_nudged_at=? WHERE id=?', now(), a.id);
    await mailAdmins(a.id, 'Still using Sign&Grow?', 'You are on the monthly plan but have not sent anything in 60 days', [
      `${a.name} pays ${money(chargePrice(a))} a month and has ${sigs(Math.max(0, available(a.id)))} saved up. Every dollar plants mangroves, and we are grateful. But we would rather you paid on purpose.`,
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

// The price rule (priceRuleText in src/lib/policy.ts): nobody on the plan pays a higher monthly price without having
// been told at least PRICE_NOTICE_DAYS before. This is how they are told. It emails every owner and admin of every
// account with a subscription of ours in any state (paid up, failing, on hold, paused), and records the notice on
// the account only once the email has left for every one of them; renewals are then held to it (see applyInvoice).
// It does not change anything with the payment provider: the operator changes the price there for the day given
// here. The day is a calendar day, in UTC, and written the same way everywhere (priceChangeDay). Safe to run again:
// an account that already has this notice is skipped, and one that was not reached is tried again. A notice for the
// same or a lower price than an account pays withdraws a higher one announced before, and the people who were told
// of that are told it is withdrawn. An account that starts the plan later pays the price its checkout shows.
route('POST', '/operator/billing/price-notice', async (c) => {
  operator(c);
  const b = await c.body();
  const cents = Math.round(Number(b.new_usd) * 100);
  if (!Number.isFinite(cents) || cents < 100 || cents > 100_000) throw bad('Enter the new monthly price in dollars, for example 12.');
  const fromAt = Date.parse(str(b.from, 40));
  if (!Number.isFinite(fromAt)) throw bad('Enter the day the new price starts, for example 2027-03-01.');
  // The start of that day in UTC, whatever time came with it.
  const from = `${new Date(fromAt).toISOString().slice(0, 10)}T00:00:00.000Z`;
  const earliest = Date.now() + PRICE_NOTICE_DAYS * 864e5;
  if (Date.parse(from) < earliest) throw bad(`The new price can start on ${new Date(earliest + 864e5).toISOString().slice(0, 10)} at the earliest. Everyone on the plan is promised ${PRICE_NOTICE_DAYS} days' notice, counted from the moment the email goes out.`);
  const out = { told: 0, already_told: 0, not_affected: 0, withdrawn: 0, not_told: [] as string[], new_price: money(cents), from, from_day: priceChangeDay(from) };
  for (const row of all('SELECT id FROM accounts WHERE promo_code IS NULL AND stripe_subscription_id IS NOT NULL ORDER BY created_at')) {
    await serial(row.id, async () => {
      let a = account(row.id);
      if (!a || !hasSub(a)) return;
      // A notice whose first day has passed, and that was given in time, is the price this account is on now: it is
      // written down as that before anything is compared, so a new notice neither withdraws it nor writes over it.
      if (noticed(a, now())) {
        run('UPDATE accounts SET price_cents=MAX(COALESCE(price_cents, 0), price_notice_cents), price_notice_cents=NULL, price_notice_from=NULL, price_notice_at=NULL WHERE id=?', a.id);
        a = account(a.id);
      }
      const nowCents = a.price_cents || PLAN_CENTS();
      const had = a.price_notice_cents && a.price_notice_cents > nowCents ? { cents: a.price_notice_cents, from: a.price_notice_from, at: a.price_notice_at } : null;
      // The same or a lower price needs no notice, and withdraws an earlier notice of a higher one. Whoever was told
      // the price goes up is told that it does not, so nobody stops a plan over a rise that is not coming.
      if (cents <= nowCents) {
        if (a.price_notice_cents) run('UPDATE accounts SET price_notice_cents=NULL, price_notice_from=NULL, price_notice_at=NULL WHERE id=?', a.id);
        if (!had) return void out.not_affected++;
        await mailAdmins(a.id, 'The price of your Sign&Grow plan is not changing after all', 'The price change we announced is withdrawn', [
          `On ${priceChangeDay(had.at)} we told you that from ${priceChangeDay(had.from)} the monthly plan for ${a.name} would cost ${money(had.cents)} a month. That change is withdrawn: the price stays ${money(nowCents)} a month.`,
          'You do not have to do anything. Your plan, your signatures and your documents stay exactly as they are.',
          priceRuleText(),
        ], 'stop');
        log(a.id, 'price', `Told by email that the announced price of ${money(had.cents)} is withdrawn. It stays ${money(nowCents)} a month.`);
        return void out.withdrawn++;
      }
      if (a.price_notice_cents === cents && a.price_notice_from === from && a.price_notice_at) return void out.already_told++;
      const started = now();
      const day_ = priceChangeDay(from);
      await mailAdmins(a.id, `The price of your Sign&Grow plan changes on ${day_}`, 'The price of your monthly plan is changing', [
        `Today ${a.name} pays ${money(nowCents)} a month. From ${day_} the monthly plan costs ${money(cents)} a month. The first renewal on or after that day is the first at the new price. Until then nothing changes.`,
        ...(had ? [`This replaces what we told you on ${priceChangeDay(had.at)} (${money(had.cents)} a month from ${priceChangeDay(had.from)}).`] : []),
        `Each payment still adds ${sigs(PRICING.monthlySignatures)}, and the signatures you already have are not touched.`,
        'You do not have to do anything to stay. If the new price is not for you, stop the plan with the button below or on the Plan page at any time before that renewal. You keep every signature and every document.',
        priceRuleText(),
      ], 'stop');
      // A notice counts only once an email for it has left for every owner and admin: taken by the mail server (the
      // outbox counts only on a development server). Whoever was not reached is named to the operator.
      const people = admins(a.id);
      const rows = all(`SELECT to_email, status FROM emails WHERE at >= ? AND subject LIKE 'The price of your Sign&Grow plan changes on%' AND to_email IN (${people.map(() => '?').join(',') || "''"})`, started, ...people.map((u) => u.email));
      const missed = people.filter((u) => !rows.some((m) => String(m.to_email).toLowerCase() === String(u.email).toLowerCase() && mailLeft(m.status)));
      if (!people.length || missed.length) return void out.not_told.push(people.length ? `${a.name} (${missed.map((u) => u.email).join(', ')})` : `${a.name} (no owner or admin)`);
      run('UPDATE accounts SET price_notice_cents=?, price_notice_from=?, price_notice_at=? WHERE id=?', cents, from, started, a.id);
      log(a.id, 'price', `Told by email that the plan costs ${money(cents)} a month from ${day_} (${money(nowCents)} until then).`);
      out.told++;
    });
  }
  return out;
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
