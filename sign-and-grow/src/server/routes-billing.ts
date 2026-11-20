import { route } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, hmac, now, isEmail, str, rateLimit, baseUrl, safeEqual, HttpError } from './util.ts';
import { sendMail } from './mail.ts';
import { billingEnabled, usageThisMonth, usageResetsAt } from './envelopes.ts';
import { PLANS } from '../lib/impact.ts';

// Billing is built around the things people most often say went wrong elsewhere:
//   - Month to month only. No annual term, no notice period, no overage. The free limit is a hard stop, never a bill.
//   - Cancelling is one button. It also works from an email link without logging in, and by card for people locked out.
//   - Every charge is announced before it happens and receipted after. The amount shown is the amount charged.
//   - Refunds are automatic when the rule is met. Nobody has to argue for one.
//   - A charge that arrives after cancellation is refunded by the software itself.
//   - Stopping payment never deletes or locks anything.

export const refundDays = () => Number(process.env.REFUND_DAYS) || 30;
const money = (cents: number, currency = 'usd') => new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
const iso = (unix?: number | null) => (unix ? new Date(unix * 1000).toISOString() : null);

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

// Only the most recent charge can be refunded from the app. Once it has been, there is nothing more to give back.
function lastPayment(accountId: string) {
  const p = get('SELECT * FROM payments WHERE account_id=? ORDER BY at DESC, rowid DESC LIMIT 1', accountId);
  return p && !p.refunded_at ? p : null;
}

// The refund rule, in one place. A charge is refunded in full on request if it is recent, or if nothing was sent since.
export function refundOffer(account: any): { payment_id: string; amount: string; reason: string } | null {
  const p = lastPayment(account.id);
  if (!p) return null;
  const ageDays = (Date.now() - Date.parse(p.at)) / 864e5;
  const sentSince = get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at > ?", account.id, p.at).n;
  if (ageDays <= refundDays()) return { payment_id: p.id, amount: money(p.amount_cents, p.currency), reason: `charged ${Math.max(0, Math.floor(ageDays))} day(s) ago, inside the ${refundDays()}-day window` };
  if (sentSince === 0 && ageDays <= 370) return { payment_id: p.id, amount: money(p.amount_cents, p.currency), reason: 'nothing has been sent since this charge' };
  return null;
}

export function billingState(account: any) {
  const enabled = billingEnabled();
  const limit = account.plan === 'seedling' && enabled ? PLANS.seedling.envelopesPerMonth : null;
  return {
    enabled,
    plan: account.plan,
    status: account.subscription_status,
    price: PLANS[account.plan as keyof typeof PLANS]?.price ?? 0,
    renews_at: account.plan === 'grove' && !account.cancel_at ? account.renews_at : null,
    ends_at: account.plan === 'grove' ? account.cancel_at : null,
    used: usageThisMonth(account.id),
    limit,
    resets_at: usageResetsAt(),
    refund: account.plan === 'grove' || lastPayment(account.id) ? refundOffer(account) : null,
    refund_days: refundDays(),
    payments: all('SELECT id, amount_cents, currency, at, receipt_url, refunded_at FROM payments WHERE account_id=? ORDER BY at DESC LIMIT 60', account.id)
      .map((p) => ({ ...p, amount: money(p.amount_cents, p.currency) })),
  };
}

// Cancelling. One state change with the payment provider, a reference number, and an email that says when billing stops.
export async function cancelPlan(account: any, by: string): Promise<{ ends_at: string; reference: string }> {
  if (account.plan !== 'grove' || !account.stripe_subscription_id) throw bad('There is no paid plan on this account, so there is nothing to cancel and nothing will be charged.');
  if (account.cancel_at) return { ends_at: account.cancel_at, reference: account.cancel_ref || '' };
  const sub = await stripe('POST', `subscriptions/${account.stripe_subscription_id}`, { cancel_at_period_end: 'true' });
  const ends = periodEnd(sub) || account.renews_at || now();
  const reference = `SG-${account.id.slice(-5).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  run('UPDATE accounts SET cancel_at=?, cancel_ref=? WHERE id=?', ends, reference, account.id);
  await mailAdmins(account.id, 'Your Grove plan is cancelled', 'Cancelled. You will not be charged again.', [
    `Cancellation reference: ${reference}. Cancelled ${by}.`,
    `Grove stays active until ${day(ends)}, because that time is already paid for. After that the account moves to the free Seedling plan.`,
    'Nothing is deleted. Every document, audit trail and receipt stays available to you, on the free plan, for as long as the account exists.',
    'If a charge ever appears after this date, we refund it automatically.',
  ], { label: 'Changed your mind? Resume', url: `${baseUrl()}/app/settings?tab=billing` });
  return { ends_at: ends, reference };
}

async function refundPayment(account: any, p: any, why: string): Promise<string> {
  const charges = await stripe('GET', 'charges', { customer: account.stripe_customer_id, limit: '20' });
  const charge = (charges.data || []).find((c: any) => c.paid && !c.refunded && c.amount === p.amount_cents);
  if (!charge) throw bad('We could not find that charge automatically. Use the contact form and a person will refund it by hand.', 502);
  const refund = await stripe('POST', 'refunds', { charge: charge.id });
  run('UPDATE payments SET refunded_at=?, charge_id=? WHERE id=?', now(), charge.id, p.id);
  await mailAdmins(account.id, `Refund sent: ${money(p.amount_cents, p.currency)}`, 'Your refund is on its way', [
    `We refunded ${money(p.amount_cents, p.currency)} in full to the card it was paid with (${why}).`,
    `Refund reference: ${refund.id}. Banks usually show it within 5 to 10 working days.`,
  ]);
  return refund.id;
}

route('GET', '/billing', (c) => billingState(c.account));

route('POST', '/billing/checkout', async (c) => {
  if (!billingEnabled() || !process.env.STRIPE_PRICE_GROVE) throw bad('Billing is not set up on this server yet.', 501);
  const a = c.account;
  if (a.plan === 'grove' && !a.cancel_at) throw bad('This account is already on Grove.');
  const s = await stripe('POST', 'checkout/sessions', {
    mode: 'subscription', 'line_items[0][price]': process.env.STRIPE_PRICE_GROVE, 'line_items[0][quantity]': '1',
    client_reference_id: a.id, success_url: `${baseUrl()}/app/settings?tab=billing&upgraded=1`, cancel_url: `${baseUrl()}/app/settings?tab=billing`,
    ...(a.stripe_customer_id ? { customer: a.stripe_customer_id } : { customer_email: c.user.email }),
  });
  return { url: s.url };
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
  return billingState(get('SELECT * FROM accounts WHERE id=?', a.id));
}, 'admin');

// Self-serve refund. If the rule is met the money goes back straight away, and the paid plan ends now.
route('POST', '/billing/refund', async (c) => {
  const a = c.account;
  const offer = refundOffer(a);
  if (!offer) throw bad(`A refund is automatic within ${refundDays()} days of a charge, or later if nothing was sent since. This charge is outside both, but use the contact form and a person will look at it.`);
  const reference = await refundPayment(a, get('SELECT * FROM payments WHERE id=?', offer.payment_id), offer.reason);
  if (a.stripe_subscription_id) await stripe('DELETE', `subscriptions/${a.stripe_subscription_id}`).catch(() => {});
  run("UPDATE accounts SET plan='seedling', subscription_status='canceled', cancel_at=NULL, renews_at=NULL WHERE id=?", a.id);
  return { refunded: offer.amount, reference };
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
  return { account: a.name, plan: a.plan, price: PLANS.grove.price, renews_at: a.cancel_at ? null : a.renews_at, ends_at: a.cancel_at };
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
  const rows = all("SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN users u ON u.id=m.user_id WHERE u.email=? AND m.role IN ('owner','admin') AND a.plan='grove'", email);
  if (rows.length)
    await sendMail({
      to: email, subject: 'Your Sign&Grow subscriptions', heading: 'Your paid plans',
      lines: ['You asked which paid plans are tied to this email address. Each link below stops that plan from renewing. No login needed.'],
      links: rows.map((a) => ({ label: `Stop renewal for ${a.name}`, url: stopUrl(a.id), note: a.cancel_at ? `already cancelled, ends ${day(a.cancel_at)}` : `${money(PLANS.grove.price * 100)} a month${a.renews_at ? `, next charge ${day(a.renews_at)}` : ''}` })),
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
    run("UPDATE accounts SET plan='grove', stripe_customer_id=?, stripe_subscription_id=?, subscription_status='active', cancel_at=NULL, cancel_ref=NULL WHERE id=?", o.customer, o.subscription, o.client_reference_id);
    await mailAdmins(o.client_reference_id, 'Welcome to Grove', 'Thank you. Your subscription plants trees.', [
      `You are on Grove at ${money(PLANS.grove.price * 100)} a month. It is month to month: no contract, no notice period, no extra charges, ever.`,
      'You get a receipt for every charge and a reminder before each renewal. The amount in the reminder is the amount we charge.',
      `Changed your mind? Any charge is refunded in full within ${refundDays()} days, from the Plan page, without talking to anyone.`,
      'To stop renewing, use the Cancel button on the Plan page or the link below. It works without logging in.',
    ], { label: 'Stop renewing (no login needed)', url: stopUrl(o.client_reference_id) });
    return;
  }

  if (ev.type === 'invoice.paid' && o.amount_paid > 0) {
    const a = byCustomer();
    const fresh = run('INSERT OR IGNORE INTO payments (id, account_id, amount_cents, currency, at, receipt_url) VALUES (?,?,?,?,?,?)', o.id, a?.id ?? null, o.amount_paid, o.currency || 'usd', now(), o.hosted_invoice_url || o.invoice_pdf || null).changes;
    if (!a || !fresh) return;
    const next = iso(o.lines?.data?.[0]?.period?.end);
    // Safety net for "charged after I cancelled": if the plan had already ended, the money goes straight back.
    if (a.plan !== 'grove' || (a.cancel_at && Date.parse(a.cancel_at) < Date.now() - 3600_000)) {
      await refundPayment(a, get('SELECT * FROM payments WHERE id=?', o.id), 'this plan was already cancelled').catch((e) => console.error('[billing] automatic refund failed', a.id, e?.message));
      return;
    }
    if (next) run('UPDATE accounts SET renews_at=? WHERE id=?', next, a.id);
    await mailAdmins(a.id, `Receipt: ${money(o.amount_paid, o.currency)} for Sign&Grow Grove`, 'Payment received. Thank you.', [
      `${money(o.amount_paid, o.currency)} for ${a.name}, charged today. All of it goes to Treegens tree planting.`,
      ...(next && !a.cancel_at ? [`Next charge: ${money(PLANS.grove.price * 100)} on ${day(next)}. We will remind you before then.`] : []),
      `Not what you wanted? Get this charge back in full within ${refundDays()} days from the Plan page.`,
    ], o.hosted_invoice_url ? { label: 'View invoice', url: o.hosted_invoice_url } : { label: 'Open the Plan page', url: `${baseUrl()}/app/settings?tab=billing` });
    return;
  }

  // Sent by the provider a few days before each renewal. Says exactly what will be charged and when.
  if (ev.type === 'invoice.upcoming') {
    const a = byCustomer();
    if (!a || a.plan !== 'grove' || a.cancel_at) return;
    const when = iso(o.next_payment_attempt || o.period_end);
    const quiet = get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at > ?", a.id, new Date(Date.now() - 60 * 864e5).toISOString()).n === 0;
    await mailAdmins(a.id, `Heads up: Grove renews on ${day(when)} for ${money(o.amount_due ?? PLANS.grove.price * 100, o.currency)}`, 'Your plan renews soon', [
      `On ${day(when)} we will charge ${money(o.amount_due ?? PLANS.grove.price * 100, o.currency)} for ${a.name}. That is the full amount: there are no extras.`,
      ...(quiet ? ['You have not sent anything in the last 60 days. If you are not using it, stop the renewal below. You keep every document either way.'] : []),
      'To keep planting trees, do nothing. To stop, use the link below. It takes one click and needs no login.',
    ], { label: 'Do not renew', url: stopUrl(a.id) });
    return;
  }

  if (ev.type === 'invoice.payment_failed') {
    const a = byCustomer();
    if (a) await mailAdmins(a.id, 'Your Grove payment did not go through', 'A payment failed', [
      'Nothing is locked and nothing is deleted. If the payment keeps failing, the account simply moves to the free Seedling plan and every document stays available.',
      'To stay on Grove, update the card on the Plan page.',
    ], { label: 'Open the Plan page', url: `${baseUrl()}/app/settings?tab=billing` });
    return;
  }

  if (ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted') {
    const ended = ev.type === 'customer.subscription.deleted';
    const live = !ended && ['active', 'trialing', 'past_due'].includes(o.status);
    const a = byCustomer();
    if (!a) return;
    const end = periodEnd(o);
    run('UPDATE accounts SET plan=?, subscription_status=?, renews_at=?, cancel_at=? WHERE id=?', live ? 'grove' : 'seedling', ended ? 'canceled' : o.status,
      live ? end : null, live && o.cancel_at_period_end ? end || a.cancel_at : null, a.id);
    if (!live && a.plan === 'grove')
      await mailAdmins(a.id, 'Your Grove plan has ended', 'You are on the free plan now', ['You will not be charged again. Nothing was deleted: every document, audit trail and receipt is still in your account.', `You can still send ${PLANS.seedling.envelopesPerMonth} envelopes a month for free, and come back to Grove whenever you like.`]);
    return;
  }

  if (ev.type === 'charge.refunded') {
    const a = byCustomer();
    if (a) run('UPDATE payments SET refunded_at=COALESCE(refunded_at, ?), charge_id=? WHERE id=(SELECT id FROM payments WHERE account_id=? AND amount_cents=? AND refunded_at IS NULL ORDER BY at DESC LIMIT 1)', now(), o.id, a.id, o.amount);
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

// Once a month at most: tell people who pay but do not use it, so nobody funds a forgotten subscription by accident.
export async function dormancyNudges(): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString();
  const rows = all("SELECT * FROM accounts WHERE plan='grove' AND cancel_at IS NULL AND (dormant_nudged_at IS NULL OR dormant_nudged_at < ?) AND created_at < ?", cutoff, cutoff)
    .filter((a) => get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at > ?", a.id, cutoff).n === 0);
  for (const a of rows) {
    run('UPDATE accounts SET dormant_nudged_at=? WHERE id=?', now(), a.id);
    await mailAdmins(a.id, 'Still using Sign&Grow?', 'You are paying for Grove but have not sent anything in 60 days', [
      `${a.name} is on Grove at ${money(PLANS.grove.price * 100)} a month. Every cent plants trees, and we are grateful. But we would rather you paid on purpose.`,
      'If you are not using it, stop the renewal with the link below. You keep every document, and the free plan stays yours.',
    ], { label: 'Stop renewing (no login needed)', url: stopUrl(a.id) });
  }
  return rows.length;
}
