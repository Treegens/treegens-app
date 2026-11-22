// BILLING_MODE: how this server is paid for. One setting, two values.
//   signatures  (the default, also when unset) the consumer product: signatures are counted, held, used and expire
//               as decided (src/server/credits.ts), and paying goes through Stripe when STRIPE_SECRET_KEY is set.
//   deployment  for a public body that pays one fixed fee a year under a contract (research/government.json, G14):
//               nothing is counted, held or expires, sending has no signature limit and no daily limit on people
//               (the pause and the fake-notice filter stay, cleared by a person), no payment provider is ever
//               called, and the Plan section of Settings is one line about the agreement. Citizens never pay in
//               either mode, and neither do the people who send.
// LICENSE_HOLDER, AGREEMENT_REF and AGREEMENT_UNTIL fill that one line. Each is optional: a part that is not set is
// left out of the sentence, never shown as a blank.
// What it does NOT do: it sends no invoice (governments invoice through their own systems), and it stops nothing on
// AGREEMENT_UNTIL. A date that has passed is said as passed; sending, signing and every document stay as they were.
//
// Reads the environment: server code and server components only. The words are pure and can be shown anywhere.

type Env = Record<string, string | undefined>;

export type BillingMode = 'signatures' | 'deployment';

const raw = (env: Env) => String(env.BILLING_MODE || '').trim().toLowerCase();

export const billingMode = (env: Env = process.env): BillingMode => (raw(env) === 'deployment' ? 'deployment' : 'signatures');

export const isDeploymentBilling = (env: Env = process.env): boolean => billingMode(env) === 'deployment';

/** The settings of the payment provider. In deployment mode they are taken away when the server starts. */
export const PAYMENT_SETTINGS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_GROVE'] as const;

export type Agreement = {
  /** Who holds the contract, as LICENSE_HOLDER says it. */
  holder: string | null;
  /** The contract's reference, AGREEMENT_REF. */
  ref: string | null;
  /** The last day it runs, YYYY-MM-DD, from AGREEMENT_UNTIL. null when unset or not a date. */
  until: string | null;
  /** The last day has passed. Said as such; nothing stops. */
  ended: boolean;
};

// One line of plain text: no control characters, no markup that could matter, at most `max` characters.
const clean = (v: unknown, max = 120): string | null => {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return s || null;
};

/** A real calendar day written YYYY-MM-DD, or null. */
export function dayOf(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

export function agreementOf(env: Env = process.env, today = new Date().toISOString().slice(0, 10)): Agreement {
  const until = dayOf(env.AGREEMENT_UNTIL);
  return { holder: clean(env.LICENSE_HOLDER), ref: clean(env.AGREEMENT_REF, 80), until, ended: !!until && until < today };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 2027-12-31 as "31 December 2027". */
export const dayWords = (day: string): string => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

/** The sentence Settings shows in place of the plan, and the second one that says what it means here. */
export function agreementLine(a: Agreement): string {
  const whose = a.holder ? `${a.holder}'s agreement${a.ref ? ` ${a.ref}` : ''}` : a.ref ? `agreement ${a.ref}` : 'an agreement with the people who run this server';
  const when = !a.until ? '' : a.ended ? `, which was valid until ${dayWords(a.until)}` : `, valid until ${dayWords(a.until)}`;
  const first = `This service is provided under ${whose}${when}.`;
  const after = a.ended ? ' That date has passed. Nothing has stopped or been locked here. Whether the agreement is renewed is for the body that holds it and the people who run this server to settle.' : '';
  return `${first}${after} Nothing is counted or charged per signature here, and people who sign never pay.`;
}

/** What public pages say on a server in deployment mode, where the agreement itself is not named to strangers. */
export const GOV_PUBLIC_LINE = 'This service is provided under an agreement with a public body. Nothing is paid or counted per signature here, and people who sign never pay.';
/** The same on the help page, with what that means for the questions about money. */
export const GOV_HELP = `${GOV_PUBLIC_LINE.replace(/^This service/, 'This GrowSigning service')} There is no plan to cancel, no refund to ask for and no signatures to run out of. Settings, Plan names the agreement for everyone who works here.`;

/** What the server says in its log as it starts, when the setting needs attention. Empty when all is well. */
export function billingModeWarnings(env: Env = process.env): string[] {
  const out: string[] = [];
  const v = raw(env);
  if (v && v !== 'deployment' && v !== 'signatures')
    out.push(`BILLING_MODE is set to "${v.slice(0, 40)}", which this server does not know. It runs as "signatures", the consumer product. The other value is "deployment". Correct the spelling or remove the setting.`);
  if (billingMode(env) !== 'deployment') return out;
  if (!clean(env.LICENSE_HOLDER)) out.push('BILLING_MODE=deployment without LICENSE_HOLDER: Settings says the service is provided under "an agreement with the people who run this server". Set LICENSE_HOLDER (and AGREEMENT_REF, AGREEMENT_UNTIL) to name it.');
  if (String(env.AGREEMENT_UNTIL ?? '').trim() && !dayOf(env.AGREEMENT_UNTIL)) out.push(`AGREEMENT_UNTIL is "${String(env.AGREEMENT_UNTIL).slice(0, 40)}", which is not a date written YYYY-MM-DD. It is left out of what Settings says.`);
  return out;
}
