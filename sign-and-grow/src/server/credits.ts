import { get, run } from './db.ts';
import { now } from './util.ts';
import { PRICING } from '../lib/impact.ts';

// Signatures are the unit people pay for. One credit is one person signing one envelope.
//   - $9 a month adds 9 signatures to the balance. A top-up adds one per dollar. Every dollar plants 10 mangroves.
//   - Signatures never expire and roll over from month to month.
//   - A signature is only used up when somebody actually signs. Sending holds one back for each signer so nobody is
//     ever stopped halfway; voiding, declining and expiring give them back automatically.
//   - Signing your own document is free. So are approvers, viewers and people who just get a copy.
// The balance is a ledger, so every change can be shown to the customer line by line.

// Without a payment provider connected there is nothing to buy, so nothing is counted.
export const creditsEnabled = () => !!process.env.STRIPE_SECRET_KEY;

export type CreditReason = 'welcome' | 'plan' | 'code' | 'topup' | 'signature' | 'refund' | 'adjust';

// Codes that make the monthly plan free. Anyone who enters one gets the plan's signatures every month at no charge.
// Set FREE_PLAN_CODES (comma separated) to change them; the spelling given there is the one shown to people.
export function freeCodes(): Map<string, string> {
  const list = (process.env.FREE_PLAN_CODES ?? 'GROWalition').split(',').map((c) => c.trim()).filter(Boolean);
  return new Map(list.map((c) => [c.toUpperCase(), c]));
}
export const findFreeCode = (typed: any): string | null => freeCodes().get(String(typed ?? '').trim().toUpperCase()) || null;

// An account on a free code gets this month's signatures the first time anything looks at its balance in a new
// month. The ledger line is unique per month, so it can never be granted twice.
function monthlyCodeGrant(accountId: string) {
  const a = get('SELECT promo_code FROM accounts WHERE id=?', accountId);
  if (!a?.promo_code) return;
  grant(accountId, PRICING.monthlySignatures, 'code', `${a.promo_code}:${now().slice(0, 7)}`);
}

// Adds a line to the ledger once. The same (reason, ref) can never be applied twice, which makes retries harmless.
export function grant(accountId: string, delta: number, reason: CreditReason, ref: string): boolean {
  return run('INSERT OR IGNORE INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,?,?,?)', accountId, delta, reason, ref, now()).changes > 0;
}

export function balance(accountId: string): number {
  monthlyCodeGrant(accountId);
  return get('SELECT COALESCE(SUM(delta),0) n FROM credits WHERE account_id=?', accountId).n;
}

// Signatures held for people who have been asked to sign and have not yet finished.
export function reserved(accountId: string): number {
  return get(
    `SELECT COUNT(*) n FROM recipients r JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id
      WHERE e.account_id=? AND e.kind='envelope' AND e.status='sent' AND r.status IN ('pending','sent','viewed')
        AND r.role IN ('signer','inperson') AND r.email != u.email`,
    accountId,
  ).n;
}

export const available = (accountId: string): number => balance(accountId) - reserved(accountId);

export const isChargeable = (r: any, senderEmail: string) =>
  (r.role === 'signer' || r.role === 'inperson') && String(r.email).toLowerCase() !== String(senderEmail).toLowerCase();

// How many signatures an envelope still needs: its signers who have not finished, not counting the sender signing
// their own document.
export function needed(e: any, senderEmail: string): number {
  return e.recipients.filter((r: any) => isChargeable(r, senderEmail) && r.status !== 'completed' && r.status !== 'declined').length;
}

export function creditSummary(accountId: string) {
  const b = balance(accountId);
  const held = reserved(accountId);
  return { balance: b, held, available: b - held };
}
