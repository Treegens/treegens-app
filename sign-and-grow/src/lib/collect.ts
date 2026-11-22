// Ask for a payment, taken here by card: the rules and the words the editor, the signing page, the envelope page and
// the server all share. The server keeps it in src/server/collect.ts and src/server/routes-collect.ts.
//
// The money goes into the sending account's own Stripe account. GrowSigning is never the merchant, never sees card
// details (Stripe's own page takes them) and takes no fee. "Paid" is said only after Stripe's message says the
// payment went through and Stripe confirms it again when asked. Before that it is "Payment started, not confirmed".

/** The currencies offered, with how many digits they have after the decimal mark. Stripe counts in the smallest unit. */
export const CURRENCIES: Record<string, number> = {
  eur: 2, usd: 2, gbp: 2, chf: 2, cad: 2, aud: 2, nzd: 2, sek: 2, nok: 2, dkk: 2, pln: 2, czk: 2, huf: 2, ron: 2,
  bgn: 2, isk: 0, jpy: 0, krw: 0, inr: 2, sgd: 2, hkd: 2, myr: 2, php: 2, idr: 2, thb: 2, aed: 2, ils: 2, try: 2,
  zar: 2, kes: 2, ngn: 2, ghs: 2, ugx: 0, tzs: 2, rwf: 0, xof: 0, xaf: 0, mad: 2, egp: 2, brl: 2, mxn: 2, clp: 0,
  cop: 2, pen: 2, ars: 2,
};
export const isCurrency = (c: any): boolean => Object.prototype.hasOwnProperty.call(CURRENCIES, String(c ?? '').toLowerCase());
const digitsOf = (c: string) => CURRENCIES[String(c).toLowerCase()] ?? 2;

/** The smallest and largest amount asked for, in the smallest unit of the currency. Stripe has its own minimums too. */
export const COLLECT_MIN = 50;
export const COLLECT_MAX = 99_999_999;
/** The longest "what it is for". It is printed on Stripe's page, the signing page and the signing record. */
export const COLLECT_FOR_MAX = 80;

/** An amount in the currency's smallest unit, from a number (25 or 25.5 euros). Null when it cannot be one. */
export function toMinor(amount: number, currency: string): number | null {
  if (!Number.isFinite(amount)) return null;
  const d = digitsOf(currency);
  const m = Math.round(amount * 10 ** d);
  // More decimals than the currency has (25.555 euros) is not an amount anybody can pay.
  if (Math.abs(m - amount * 10 ** d) > 1e-6 * Math.max(1, Math.abs(m))) return null;
  return m;
}

/** "25.00 EUR". Plain digits with a dot, the same for everyone, so the signing record reads the same in every language. */
export function moneyText(minor: number, currency: string): string {
  const d = digitsOf(currency);
  const n = Math.abs(minor) / 10 ** d;
  return `${minor < 0 ? '-' : ''}${n.toFixed(d)} ${String(currency).toUpperCase()}`;
}

/** What it is for, cleaned: one line, no web addresses (a link in a payment request is what a scam needs). */
export function checkFor(raw: any): { text: string } | { error: string } {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return { error: 'Say what the payment is for, like "Membership fee" or "Deposit for the hall". Nothing was saved.' };
  if (s.length > COLLECT_FOR_MAX) return { error: `What it is for can be ${COLLECT_FOR_MAX} characters at most, and this is ${s.length}. Make it shorter. Nothing was saved.` };
  if (/https?:|www\.|[a-z0-9-]+\.(com|org|net|io|me|ly|co|app|link)\b/i.test(s)) return { error: 'What it is for cannot hold a web address. Write it in a few plain words. Nothing was saved.' };
  return { text: s };
}

export type CollectWhen = 'before' | 'after';
export const WHEN_WORDS: Record<CollectWhen, string> = {
  before: 'Before they finish: their part is complete once the payment is confirmed',
  after: 'After they finish: signing does not wait for the payment',
};

/** What the sender reads where they set it. */
export const COLLECT_FOR_SENDER = 'Each person who signs pays by card on Stripe\'s own page, into your Stripe account. GrowSigning never sees card details and takes no fee. Nobody on your own team is asked to pay. A payment shows as paid only once Stripe confirms it.';

/** The one line on the document screen, so nobody is surprised by a payment after they sign. */
export function payAhead(o: { amount: string | null; field: string | null; merchant: string; for: string; when: CollectWhen }): string {
  const how = o.amount ? o.amount : `the amount in "${o.field || 'the amount'}"`;
  return o.when === 'before'
    ? `When you finish, you pay ${how} to ${o.merchant} for ${o.for}. Your part is complete once Stripe confirms the payment.`
    : `After you finish, you are asked to pay ${how} to ${o.merchant} for ${o.for}.`;
}

/** The line on the signing record, and on screens, once Stripe confirmed the payment. */
export const certLine = (amount: string, merchant: string, at: string): string => `Payment of ${amount} to ${merchant} confirmed by Stripe at ${at}.`;
export const STARTED = 'Payment started, not confirmed.';
export const STARTED_MORE = 'Stripe has not confirmed it yet. This usually takes a few seconds.';
export const refundLine = (amount: string, all: boolean, at: string): string => all ? `Refunded in full (${amount}) on ${at}, as Stripe reported.` : `${amount} refunded on ${at}, as Stripe reported.`;
export const disputeLine = (status: string, at: string): string => status === 'lost' ? `The card payment was disputed, and the dispute was lost, as Stripe reported on ${at}.`
  : status === 'won' ? `The card payment was disputed, and the dispute was won, as Stripe reported on ${at}.` : `The card payment is disputed, as Stripe reported on ${at}.`;

/** What a signer reads on the Pay screen. */
export const PAY_SAFE = 'You pay on Stripe\'s own page. GrowSigning never sees your card details.';
export const payWho = (merchant: string, account: string): string => `The money goes to ${merchant}${account && account !== merchant ? `, the Stripe account of ${account}` : ''}. Questions about it go to them.`;
