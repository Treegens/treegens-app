// Ask for a payment, taken here by card while signing, into the sending account's own Stripe account (Stripe
// Connect). The words and number rules are in src/lib/collect.ts, the routes in src/server/routes-collect.ts.
//
// What it promises, and how the code keeps it:
// - GrowSigning is never the merchant. The Checkout session is made on the connected account (a "direct charge", the
//   Stripe-Account header), so the money, the receipt, refunds and disputes are that account's. No fee is taken.
// - GrowSigning never sees card details: the signer pays on Stripe's own hosted page.
// - "Paid" only after Stripe's signed message says the session was paid, for that connected account, and Stripe
//   answers the same when asked again with the session id. Before that: "Payment started, not confirmed".
// - "Pay before finishing": the person's part is not completed by Finish. What they signed is kept here, and their part
//   completes when that confirmation arrives (finishAfterPayment in routes-collect.ts), or when they press Finish again.
// - Nobody is ever stuck: when a payment cannot be asked (the account disconnected Stripe, lost trust or was paused, the
//   amount field is gone) the person is not asked and finishes as usual, and the envelope's history says why.
//
// Mobile money: PayProvider is the shape a second provider has to fill. Only Stripe is built; MOBILE_MONEY is a stub
// that is never set up, so nothing offers it.
import crypto from 'node:crypto';
import { all, get, run, tx } from './db.ts';
import { bad, baseUrl, id, now, safeEqual, str } from './util.ts';
import { audit, applyValues, hasNotPaid, okImage, type Actor } from './envelopes.ts';
import { isDeploymentBilling } from '../lib/billingmode.ts';
import { PAID_TRUST_DAYS } from '../lib/policy.ts';
import { payNotYet } from '../lib/paylink.ts';
import { readNumber, canonOf } from '../lib/logic.ts';
import { momentText } from '../lib/dates.ts';
import { COLLECT_MAX, COLLECT_MIN, certLine, checkFor, disputeLine, isCurrency, moneyText, refundLine, toMinor, type CollectWhen } from '../lib/collect.ts';

// ---- Providers ----------------------------------------------------------------------------------------------------

export type PayProvider = {
  key: string;
  name: string;
  /** Whether the people who run this server set it up. When not, nothing offers it. */
  configured: () => boolean;
};

const platformKey = () => String(process.env.STRIPE_CONNECT_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '').trim();
export const STRIPE: PayProvider = {
  key: 'stripe',
  name: 'Stripe',
  // A server run under a government agreement takes no payments (BILLING_MODE=deployment).
  configured: () => !isDeploymentBilling() && !!String(process.env.STRIPE_CONNECT_CLIENT_ID || '').trim() && !!platformKey() && !!String(process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '').trim(),
};
/** Mobile money (for example M-Pesa's STK push): the place for an adapter. Not built, so never set up. */
export const MOBILE_MONEY: PayProvider = { key: 'mobile_money', name: 'Mobile money', configured: () => false };
export const PROVIDERS = [STRIPE, MOBILE_MONEY];
export const collectOn = () => STRIPE.configured();

/** A call to Stripe. `account`: the connected account it is made on. Throws a sentence a person can act on. */
export async function stripeCall(method: 'GET' | 'POST', url: string, params: Record<string, string> = {}, o: { account?: string; idem?: string } = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetch(`${url}${method === 'GET' && qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        authorization: `Bearer ${platformKey()}`, 'content-type': 'application/x-www-form-urlencoded',
        ...(o.account ? { 'stripe-account': o.account } : {}), ...(o.idem ? { 'idempotency-key': o.idem } : {}),
        ...(process.env.STRIPE_API_VERSION ? { 'stripe-version': process.env.STRIPE_API_VERSION } : {}),
      },
      body: method === 'POST' ? qs : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw bad('Stripe could not be reached just now. Nothing was charged. Try again in a minute.', 503);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const said = str(data?.error?.message || data?.error_description || '', 300);
    throw bad(`Stripe did not accept this${said ? `: "${said}"` : ''}. Nothing was charged. Try again, or ask the people who sent the document.`, res.status >= 500 ? 503 : 502, { stripe: true });
  }
  return data;
}

// ---- The connected Stripe account ------------------------------------------------------------------------------------

export const connectionOf = (accountId: string) => get('SELECT * FROM collect_accounts WHERE account_id=?', accountId);

/**
 * Whether this account may ask signers for money right now, and if not why. The same trust rule as the link to a
 * payment page (payRefusal in routes-paylink.ts): a Pay button from an account nobody knows yet is what scammers want.
 */
export function collectRefusal(accountId: string): string | null {
  const a = get('SELECT * FROM accounts WHERE id=?', accountId);
  if (!a) return 'This account no longer exists.';
  if (a.suspended_at) return 'Sending is paused on this account, so it asks nobody for a payment until a person has lifted the pause.';
  if (a.dispute_at) return 'A card payment of this account was disputed, so it asks nobody for a payment until that is cleared.';
  return hasNotPaid(a) ? payNotYet(PAID_TRUST_DAYS).replace('A link to your own payment page can be shown to signers', 'Payments can be asked for while signing') : null;
}

/** Where Stripe sends the person back after they connect. It has to be listed in the Stripe Connect settings. */
export const callbackUrl = () => `${baseUrl()}/api/collect/callback`;

export function connectUrl(accountId: string, userId: string): string {
  const state = crypto.randomBytes(24).toString('base64url');
  run('DELETE FROM collect_states WHERE at < ?', new Date(Date.now() - 15 * 60_000).toISOString());
  run('INSERT INTO collect_states (state, account_id, user_id, at) VALUES (?,?,?,?)', state, accountId, userId, now());
  const q = new URLSearchParams({ response_type: 'code', client_id: String(process.env.STRIPE_CONNECT_CLIENT_ID), scope: 'read_write', state, redirect_uri: callbackUrl() });
  return `https://connect.stripe.com/oauth/authorize?${q}`;
}

/** The answer of Stripe's connect page: the code, swapped for the connected account's id. Refused unless the same person in the same account started it, less than 15 minutes ago, and only once. */
export async function finishConnect(state: string, code: string, accountId: string, user: any, actorName: string): Promise<any> {
  const row = get('SELECT * FROM collect_states WHERE state=?', state);
  if (!row || row.account_id !== accountId || row.user_id !== user.id || Date.parse(row.at) < Date.now() - 15 * 60_000) throw bad('This answer from Stripe does not belong to a connect you started in the last 15 minutes. Nothing was connected. Start again from Settings.', 400, { code: 'state' });
  run('DELETE FROM collect_states WHERE state=?', state);
  const tok = await stripeCall('POST', 'https://connect.stripe.com/oauth/token', { grant_type: 'authorization_code', code });
  const acct = String(tok?.stripe_user_id || '');
  if (!/^acct_[A-Za-z0-9]+$/.test(acct)) throw bad('Stripe did not say which account was connected. Nothing was connected. Start again from Settings.', 502);
  // The name people see on the Pay screen and on the signing record: the business name in that Stripe account.
  let name = '';
  try {
    const a = await stripeCall('GET', `https://api.stripe.com/v1/accounts/${acct}`);
    name = str(a?.business_profile?.name || a?.settings?.dashboard?.display_name || '', 120).trim();
  } catch {}
  if (!name) name = str(get('SELECT name FROM accounts WHERE id=?', accountId)?.name || 'This account', 120);
  run('INSERT INTO collect_accounts (account_id, stripe_account, name, livemode, connected_by, connected_at) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET stripe_account=excluded.stripe_account, name=excluded.name, livemode=excluded.livemode, connected_by=excluded.connected_by, connected_at=excluded.connected_at',
    accountId, acct, name, tok?.livemode ? 1 : 0, user.id, now());
  return connectionOf(accountId);
}

/** Documents still out for signing that ask for a payment, for the line when an admin disconnects. */
export const openAsking = (accountId: string): number => get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND status='sent' AND collect_currency IS NOT NULL", accountId)?.n || 0;

export async function disconnect(accountId: string): Promise<void> {
  const c = connectionOf(accountId);
  if (!c) return;
  run('DELETE FROM collect_accounts WHERE account_id=?', accountId);
  // Stripe is told too, so this server can no longer act on that account. Failing that, it is gone here all the same.
  await stripeCall('POST', 'https://connect.stripe.com/oauth/deauthorize', { client_id: String(process.env.STRIPE_CONNECT_CLIENT_ID), stripe_user_id: c.stripe_account }).catch(() => {});
}

// ---- The setting on an envelope or a template ------------------------------------------------------------------------

export type CollectSetting = { amount: number | null; field_id: string | null; currency: string; for: string; when: CollectWhen; amount_text: string | null; field_label: string | null; field_gone: boolean };

const labelOf = (f: any) => (f?.label ? String(f.label) : f ? `${f.formula ? 'Calculated' : 'Number'} field on page ${Number(f.page || 0) + 1}` : null);
/** The fields an amount can come from: a number field or a calculated field. */
export const amountFields = (e: any) => (e.fields || []).filter((f: any) => f.type === 'number' || !!f.formula);

export function settingOf(e: any): CollectSetting | null {
  if (!e?.collect_currency) return null;
  const f = e.collect_field ? (e.fields || []).find((x: any) => x.id === e.collect_field) : null;
  return {
    amount: e.collect_amount ?? null, field_id: e.collect_field || null, currency: e.collect_currency, for: e.collect_for || '', when: e.collect_when === 'before' ? 'before' : 'after',
    amount_text: e.collect_amount != null ? moneyText(e.collect_amount, e.collect_currency) : null, field_label: f ? labelOf(f) : null, field_gone: !!e.collect_field && !f,
  };
}

/** Checks what a sender asked for and writes it. Throws a sentence when something is wrong; nothing is saved then. */
export function saveSetting(e: any, b: any): CollectSetting | null {
  if (b == null || b.off === true || b.currency === null) {
    run('UPDATE envelopes SET collect_amount=NULL, collect_field=NULL, collect_currency=NULL, collect_for=NULL, collect_when=NULL WHERE id=?', e.id);
    return null;
  }
  const cur = String(b.currency ?? '').toLowerCase();
  if (!isCurrency(cur)) throw bad(`"${str(b.currency, 10)}" is not a currency offered here. Choose one from the list, like EUR or USD. Nothing was saved.`);
  const why = checkFor(b.for);
  if ('error' in why) throw bad(why.error);
  const when: CollectWhen = b.when === 'before' ? 'before' : b.when === 'after' || b.when == null ? 'after' : (() => { throw bad('"when" is "before" or "after". Nothing was saved.'); })();
  let amount: number | null = null;
  let field: string | null = null;
  if (b.field_id) {
    const f = amountFields(e).find((x: any) => x.id === String(b.field_id));
    if (!f) throw bad('That field is not a number field or a calculated field on this document. Choose one of those, or type a fixed amount. Nothing was saved.');
    field = f.id;
  } else {
    const n = typeof b.amount === 'number' ? b.amount : readNumber(b.amount)?.value;
    const read = typeof b.amount === 'number' ? null : readNumber(b.amount);
    if (read?.ambiguous) throw bad(`"${str(b.amount, 30)}" can be read two ways. Write it with its decimals, like 1234.00. Nothing was saved.`);
    const m = n == null ? null : toMinor(n, cur);
    if (m == null || m < COLLECT_MIN || m > COLLECT_MAX) throw bad(`Type the amount as a number between ${moneyText(COLLECT_MIN, cur)} and ${moneyText(COLLECT_MAX, cur)}, like 25.00. Nothing was saved.`);
    amount = m;
  }
  run('UPDATE envelopes SET collect_amount=?, collect_field=?, collect_currency=?, collect_for=?, collect_when=? WHERE id=?', amount, field, cur, why.text, when, e.id);
  return settingOf({ ...e, collect_amount: amount, collect_field: field, collect_currency: cur, collect_for: why.text, collect_when: when });
}

/** A copy of an envelope or a template asks for the same payment, from its own copy of the amount field (copyEnvelope). */
export function copyCollect(src: any, eid: string, fmap: Map<string, string>) {
  if (!src.collect_currency) return;
  const field = src.collect_field ? fmap.get(src.collect_field) || null : null;
  if (src.collect_field && !field) return;
  run('UPDATE envelopes SET collect_amount=?, collect_field=?, collect_currency=?, collect_for=?, collect_when=? WHERE id=?', src.collect_amount ?? null, field, src.collect_currency, src.collect_for, src.collect_when, eid);
}

// ---- Who is asked, and how much ----------------------------------------------------------------------------------------

const ACTS = (role: string) => role === 'signer' || role === 'inperson';
const onTeam = (e: any, email: any): boolean =>
  !!email && !!get('SELECT 1 x FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND lower(u.email)=lower(?)', e.account_id, String(email));

/** Why this person is not asked to pay, or null when they are. Asked again every time, so a change counts at once. */
export function notAsked(e: any, r: any): string | null {
  if (!e?.collect_currency || !ACTS(r.role)) return 'none';
  if (!collectOn()) return 'off';
  if (onTeam(e, r.email)) return 'team';
  if (!connectionOf(e.account_id)) return 'The account that sent it disconnected its Stripe account, so no payment is asked.';
  const why = collectRefusal(e.account_id);
  return why ? `${why}` : null;
}

export type Amount = { minor: number } | { none: true } | { error: string; mine: boolean };
/** How much this person is asked for, from the fixed amount or from the field as it stands in `fields`. */
export function amountFor(e: any, r: any, fields: any[] = e.fields): Amount {
  if (e.collect_amount != null) return { minor: e.collect_amount };
  const f = fields.find((x: any) => x.id === e.collect_field);
  if (!f) return { error: 'The field that held the amount is no longer on the document, so no payment is asked.', mine: false };
  const mine = f.recipient_id === r.id;
  const name = labelOf(f);
  let n: number | null;
  if (f.formula) n = canonOf(f);
  else {
    if (f.value == null || String(f.value).trim() === '') return { none: true };
    const read = readNumber(f.value);
    if (read?.ambiguous) return { error: `"${f.value}" in ${name} can be read two ways. Write it with its decimals, like 1234.00.`, mine };
    n = read ? read.value : null;
  }
  if (n == null) return f.formula ? { none: true } : { error: `${name} does not hold an amount. Type a number, like 25.00.`, mine };
  if (n === 0) return { none: true };
  const m = toMinor(n, e.collect_currency);
  if (m == null || m < COLLECT_MIN || m > COLLECT_MAX) return { error: `${name} has to be between ${moneyText(COLLECT_MIN, e.collect_currency)} and ${moneyText(COLLECT_MAX, e.collect_currency)}. Change it, then finish again.`, mine };
  return { minor: m };
}

/** This person's payment row, for their current address. */
export const rowOf = (r: any) => get('SELECT * FROM collect_payments WHERE recipient_id=? AND email=?', r.id, String(r.email || '').toLowerCase());

/** Written down once: a payment that was not asked and why, so the sender's page and the history say it. */
export function noteNotAsked(e: any, r: any, why: string, actor: Actor) {
  const t = now();
  const c = connectionOf(e.account_id);
  const done = run('INSERT OR IGNORE INTO collect_payments (id, envelope_id, recipient_id, email, account_id, stripe_account, merchant, amount, currency, for_text, when_to, status, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id('pay'), e.id, r.id, String(r.email || '').toLowerCase(), e.account_id, c?.stripe_account || '', c?.name || '', 0, e.collect_currency, e.collect_for, e.collect_when || 'after', 'not_asked', why, t, t).changes;
  if (done) audit(e.id, actor, 'Payment not asked', `${r.name} was not asked to pay. ${why}`);
}

/** Makes or updates the row for a payment that is to be asked now. */
export function readyRow(e: any, r: any, minor: number, extra: { body?: any; ip?: string; ua?: string } = {}) {
  const c = connectionOf(e.account_id)!;
  const t = now();
  const was = rowOf(r);
  const body = extra.body ? JSON.stringify(extra.body) : null;
  if (!was) {
    run('INSERT INTO collect_payments (id, envelope_id, recipient_id, email, account_id, stripe_account, merchant, amount, currency, for_text, when_to, status, finish_body, finish_ip, finish_ua, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id('pay'), e.id, r.id, String(r.email || '').toLowerCase(), e.account_id, c.stripe_account, c.name, minor, e.collect_currency, e.collect_for, e.collect_when || 'after', 'ready', body, extra.ip || null, extra.ua || null, t, t);
  } else if (was.status !== 'paid') {
    // A changed amount, or another connected account, needs a new Stripe page: the old one is not used again.
    const same = was.amount === minor && was.stripe_account === c.stripe_account && was.currency === e.collect_currency;
    run(`UPDATE collect_payments SET amount=?, currency=?, for_text=?, when_to=?, stripe_account=?, merchant=?, finish_body=COALESCE(?, finish_body), finish_ip=COALESCE(?, finish_ip), finish_ua=COALESCE(?, finish_ua), note=NULL, updated_at=?${same ? '' : ", status='ready', session_url=NULL"} WHERE id=?`,
      minor, e.collect_currency, e.collect_for, e.collect_when || 'after', c.stripe_account, c.name, body, extra.ip || null, extra.ua || null, t, was.id);
    if (was.status === 'not_asked') run("UPDATE collect_payments SET status='ready' WHERE id=?", was.id);
  }
  return rowOf(r);
}

/**
 * Called by Finish (completeRecipient in envelopes.ts) before anything is claimed. For "pay before finishing": until
 * Stripe has confirmed this person's payment, nothing is signed. What they signed is checked as Finish would check
 * it, kept, and the answer is 402 with code "pay_first": the signing page then shows the Pay screen. Nothing is
 * waited for in here: Finish must not wait between its look at the link and its claim (routes-sign.ts).
 */
export function payFirst(e: any, r: any, body: any, actor: Actor): void {
  if (!e.collect_currency || e.collect_when !== 'before') return;
  const no = notAsked(e, r);
  if (no === 'none' || no === 'off' || no === 'team') return;
  if (no) return noteNotAsked(e, r, no, actor);
  const was = rowOf(r);
  // Paid a fixed amount: nothing more to check. Paid an amount from a field: the field must still say what was paid.
  if (was?.status === 'paid' && !e.collect_field) return;
  // Checked as Finish checks it, and undone: the values are only kept, nothing is signed (ROLLBACK).
  const ROLLBACK = new Error('rollback');
  let amount: Amount = { none: true };
  try {
    tx(() => {
      applyValues(e, r, body?.values || {}, true, (hidden) => {
        const mine = e.fields.filter((f: any) => f.recipient_id === r.id && !hidden.has(f.id));
        if (mine.some((f: any) => f.type === 'signature' && (f.required || f.value)) && !okImage(body?.signature_png)) throw bad('Your signature is missing. Make it on the page, then finish again.');
        if (mine.some((f: any) => f.type === 'initials' && (f.required || f.value)) && !okImage(body?.initials_png)) throw bad('Your initials are missing. Add them on the page, then finish again.');
      });
      amount = amountFor(e, r, all('SELECT * FROM fields WHERE envelope_id=?', e.id));
      throw ROLLBACK;
    });
  } catch (x) {
    if (x !== ROLLBACK) throw x;
  }
  const a = amount as Amount;
  if (was?.status === 'paid') {
    if ('minor' in a && a.minor === was.amount) return;
    const f = e.fields.find((x: any) => x.id === e.collect_field);
    throw bad(`You paid ${moneyText(was.amount, was.currency)}, and ${f ? labelOf(f) : 'the amount'} now says something else. Change it back to ${moneyText(was.amount, was.currency)}, then finish again.`, 409, { code: 'paid_other_amount' });
  }
  if ('none' in a) return;
  if ('error' in a) {
    if (a.mine) throw bad(a.error);
    return noteNotAsked(e, r, a.error, actor);
  }
  const keep = { values: body?.values || {}, signature_png: okImage(body?.signature_png) ? body.signature_png : null, initials_png: okImage(body?.initials_png) ? body.initials_png : null,
    version: body?.version ?? null, inputs: body?.inputs ?? null, tz: str(body?.tz, 60) || null };
  readyRow(e, r, a.minor, { body: keep, ip: actor.ip, ua: actor.ua });
  throw bad(`Your signature is ready. Pay ${moneyText(a.minor, e.collect_currency)} to ${connectionOf(e.account_id)!.name} to finish.`, 402, { code: 'pay_first' });
}

// ---- Stripe Checkout ----------------------------------------------------------------------------------------------------

/** The Stripe page for this person's payment: the one already open, or a new one. Never two open at once. */
export async function checkoutFor(e: any, r: any, row: any, actor: Actor): Promise<{ url: string } | { waiting: true }> {
  if (row.session_id && row.status === 'started') {
    const s = await stripeCall('GET', `https://api.stripe.com/v1/checkout/sessions/${row.session_id}`, {}, { account: row.stripe_account });
    // Paid on Stripe's page: never a second page. It counts as paid once Stripe's own message arrives (onStripeEvent).
    if (s?.payment_status === 'paid' || s?.status === 'complete') return { waiting: true };
    if (s?.status === 'open' && s.url) return { url: s.url };
    // Expired or abandoned: a fresh one below, under a new idempotency key.
  }
  const p: Record<string, string> = {
    mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': row.currency,
    'line_items[0][price_data][unit_amount]': String(row.amount), 'line_items[0][price_data][product_data][name]': str(row.for_text || 'Payment', 80),
    success_url: `${baseUrl()}/paid?p=${row.id}`, cancel_url: `${baseUrl()}/paid?p=${row.id}&back=1`,
    client_reference_id: row.id, 'metadata[growsigning_payment]': row.id, 'payment_intent_data[metadata][growsigning_payment]': row.id,
  };
  if (r.email) p.customer_email = r.email;
  const s = await stripeCall('POST', 'https://api.stripe.com/v1/checkout/sessions', p, { account: row.stripe_account, idem: `gs-${row.id}-${row.session_id || 'first'}-${row.amount}` });
  if (!s?.id || !s?.url) throw bad('Stripe did not give a payment page. Nothing was charged. Try again in a minute.', 502);
  run("UPDATE collect_payments SET session_id=?, session_url=?, status='started', updated_at=? WHERE id=? AND status!='paid'", s.id, s.url, now(), row.id);
  audit(e.id, actor, 'Payment started', `${r.name} opened Stripe's page to pay ${moneyText(row.amount, row.currency)} to ${row.merchant}. Not confirmed yet.`);
  return { url: s.url };
}

/**
 * Marks a payment paid, once: only for the session and the connected account named, and only when Stripe, asked
 * with that session id on that account, says it is paid, for the amount and the currency this row asked. Returns the
 * row when it became paid now, or null.
 */
export async function confirmPaid(sessionId: string, stripeAccount: string): Promise<any | null> {
  const row = get('SELECT * FROM collect_payments WHERE session_id=?', sessionId);
  if (!row || row.stripe_account !== stripeAccount || row.status === 'paid') return null;
  const s = await stripeCall('GET', `https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {}, { account: stripeAccount });
  if (s?.payment_status !== 'paid' || Number(s.amount_total) !== row.amount || String(s.currency).toLowerCase() !== row.currency || (s.metadata?.growsigning_payment && s.metadata.growsigning_payment !== row.id)) return null;
  const t = now();
  if (!run("UPDATE collect_payments SET status='paid', paid_at=?, payment_intent=?, updated_at=? WHERE id=? AND status!='paid'", t, str(s.payment_intent?.id || s.payment_intent || '', 100) || null, t, row.id).changes) return null;
  const r = get('SELECT name FROM recipients WHERE id=?', row.recipient_id);
  audit(row.envelope_id, { name: 'Stripe' }, 'Payment confirmed', `${r?.name || 'The signer'}: ${certLine(moneyText(row.amount, row.currency), row.merchant, momentText(t))}`);
  return get('SELECT * FROM collect_payments WHERE id=?', row.id);
}

// ---- Stripe's messages ----------------------------------------------------------------------------------------------------

/** The Stripe-Signature header checked against the raw body: HMAC-SHA256 of "t.body", at most 5 minutes old. */
export function signedByStripe(raw: string, header: string, secret: string, at = Date.now()): boolean {
  const parts = header.split(',').map((x) => x.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v || '');
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(at / 1000 - Number(t)) > 300) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return sigs.some((s) => safeEqual(s, want));
}

/** One message from Stripe, after its signature was checked. Returns what it did, for the answer and the tests. */
export async function onStripeEvent(ev: any): Promise<{ done: string; row?: any }> {
  if (!ev?.id || typeof ev.id !== 'string') return { done: 'ignored' };
  // A message sent again (Stripe retries, or someone replays one) is applied once.
  if (!run('INSERT OR IGNORE INTO collect_events (id, at) VALUES (?,?)', ev.id, now()).changes) return { done: 'duplicate' };
  const acct = String(ev.account || '');
  const o = ev.data?.object || {};
  try {
    switch (ev.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        if (o.payment_status !== 'paid') return { done: 'waiting' };
        const row = await confirmPaid(String(o.id || ''), acct);
        return row ? { done: 'paid', row } : { done: 'ignored' };
      }
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired': {
        const row = get('SELECT * FROM collect_payments WHERE session_id=? AND stripe_account=?', String(o.id || ''), acct);
        if (!row || row.status !== 'started') return { done: 'ignored' };
        run("UPDATE collect_payments SET status='expired', note=?, updated_at=? WHERE id=? AND status='started'", ev.type.endsWith('failed') ? 'The payment did not go through.' : 'The Stripe page closed without a payment.', now(), row.id);
        return { done: 'expired' };
      }
      case 'charge.refunded': {
        const row = get("SELECT * FROM collect_payments WHERE payment_intent=? AND stripe_account=? AND status='paid'", String(o.payment_intent || ''), acct);
        if (!row) return { done: 'ignored' };
        const back = Math.min(row.amount, Math.max(0, Number(o.amount_refunded) || 0));
        if (back <= row.refunded) return { done: 'ignored' };
        const t = now();
        run('UPDATE collect_payments SET refunded=?, refunded_at=?, updated_at=? WHERE id=?', back, t, t, row.id);
        audit(row.envelope_id, { name: 'Stripe' }, 'Payment refunded', refundLine(moneyText(back, row.currency), back >= row.amount, momentText(t)));
        return { done: 'refunded' };
      }
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed': {
        const row = get("SELECT * FROM collect_payments WHERE payment_intent=? AND stripe_account=? AND status='paid'", String(o.payment_intent || ''), acct);
        if (!row) return { done: 'ignored' };
        const status = o.status === 'won' || o.status === 'lost' ? o.status : 'open';
        if (row.dispute === status) return { done: 'ignored' };
        const t = now();
        run('UPDATE collect_payments SET dispute=?, dispute_at=?, updated_at=? WHERE id=?', status, t, t, row.id);
        audit(row.envelope_id, { name: 'Stripe' }, 'Payment disputed', disputeLine(status, momentText(t)));
        return { done: 'disputed' };
      }
      case 'account.application.deauthorized': {
        // The account took this server's access away in Stripe: it is disconnected here too.
        const n = run('DELETE FROM collect_accounts WHERE stripe_account=?', acct).changes;
        return { done: n ? 'disconnected' : 'ignored' };
      }
      default:
        return { done: 'ignored' };
    }
  } catch (x) {
    // Not applied: let Stripe send it again.
    run('DELETE FROM collect_events WHERE id=?', ev.id);
    throw x;
  }
}

// ---- What people read ----------------------------------------------------------------------------------------------------

/** How a payment row reads, for the sender's page, the signer's page and the signing record. */
export function rowWords(row: any): { state: string; line: string; lines: string[] } {
  const amount = moneyText(row.amount, row.currency);
  if (row.status === 'not_asked') return { state: 'not_asked', line: `Not asked to pay. ${row.note || ''}`.trim(), lines: [] };
  if (row.status !== 'paid') return { state: row.status, line: row.status === 'started' ? 'Payment started, not confirmed.' : row.status === 'expired' ? `Not paid yet. ${row.note || ''}`.trim() : `Asked to pay ${amount}. Not paid yet.`, lines: [] };
  const lines = [certLine(amount, row.merchant, momentText(row.paid_at))];
  if (row.refunded) lines.push(refundLine(moneyText(row.refunded, row.currency), row.refunded >= row.amount, momentText(row.refunded_at)));
  if (row.dispute) lines.push(disputeLine(row.dispute, momentText(row.dispute_at)));
  return { state: row.dispute === 'open' || row.dispute === 'lost' ? 'disputed' : row.refunded ? (row.refunded >= row.amount ? 'refunded' : 'partly_refunded') : 'paid', line: lines.join(' '), lines };
}

/** The lines the signing record prints under the envelope: only payments Stripe confirmed. Never "paid" without it. */
export function collectCertLines(e: any): [string, string][] {
  const rows = all("SELECT p.*, r.name rname FROM collect_payments p JOIN recipients r ON r.id=p.recipient_id WHERE p.envelope_id=? AND p.status='paid' ORDER BY p.paid_at", e.id);
  return rows.map((row: any) => ['Payment', `${row.rname}: ${rowWords(row).lines.join(' ')}`]);
}
