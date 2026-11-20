import { all, get, run } from './db.ts';
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

export type CreditReason = 'welcome' | 'plan' | 'code' | 'topup' | 'signature' | 'refund' | 'dispute' | 'adjust';

// Codes that make the monthly plan free. Anyone who enters one gets the plan's signatures every month at no charge.
// Set FREE_PLAN_CODES (comma separated) to change them; the spelling given there is the one shown to people.
export function freeCodes(): Map<string, string> {
  const list = (process.env.FREE_PLAN_CODES ?? 'GROWalition').split(',').map((c) => c.trim()).filter(Boolean);
  return new Map(list.map((c) => [c.toUpperCase(), c]));
}
export const findFreeCode = (typed: any): string | null => freeCodes().get(String(typed ?? '').trim().toUpperCase()) || null;

// An account on a free code gets the plan's signatures for every calendar month (UTC) since the code was entered,
// including months when nobody opened the account. They are written the first time anything looks at the balance
// afterwards. The ledger line is one per month whatever the code, so a month can never be granted twice, and a code
// that has been switched off adds nothing more.
function monthlyCodeGrant(accountId: string) {
  const a = get('SELECT promo_code, promo_at FROM accounts WHERE id=?', accountId);
  if (!a?.promo_code || !findFreeCode(a.promo_code)) return;
  const month = now().slice(0, 7);
  if (get("SELECT 1 x FROM credits WHERE account_id=? AND reason='code' AND ref=?", accountId, month)) return;
  let m = String(a.promo_at || now()).slice(0, 7);
  for (let i = 0; i < 240 && m <= month; i++) {
    grant(accountId, PRICING.monthlySignatures, 'code', m, m === month ? undefined : `${m}-01T00:00:00.000Z`);
    const [y, mo] = m.split('-').map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
}

// Adds a line to the ledger once. The same (reason, ref) can never be applied twice, which makes retries harmless.
export function grant(accountId: string, delta: number, reason: CreditReason, ref: string, at?: string): boolean {
  return run('INSERT OR IGNORE INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,?,?,?)', accountId, delta, reason, ref, at || now()).changes > 0;
}

export function balance(accountId: string): number {
  monthlyCodeGrant(accountId);
  return get('SELECT COALESCE(SUM(delta),0) n FROM credits WHERE account_id=?', accountId).n;
}

// Signatures held for people who have been asked to sign and have not yet finished. A public form holds nothing:
// anyone can start one with a made-up address, and that must not be a way to lock up the owner's balance. A form
// only starts while at least one signature is available, and uses one when its visitor actually signs.
export function reserved(accountId: string): number {
  return get(
    `SELECT COUNT(*) n FROM recipients r JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id
      WHERE e.account_id=? AND e.kind='envelope' AND e.status='sent' AND r.status IN ('pending','sent','viewed')
        AND e.powerform_id IS NULL
        AND (r.role = 'inperson' OR (r.role = 'signer' AND (r.free = 0 OR (r.free IS NULL AND r.email != u.email))))
        AND NOT EXISTS (SELECT 1 FROM credits c WHERE c.account_id = e.account_id AND c.reason = 'signature'
          AND c.ref = r.id || '|' || lower(r.email) || CASE WHEN COALESCE(r.person_gen, 0) > 0 THEN '|' || r.person_gen ELSE '' END)`,
    accountId,
  ).n;
}

export const available = (accountId: string): number => balance(accountId) - reserved(accountId);

export const sameEmail = (a: any, b: any) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

// Does this person's signature cost one? Once a request has gone out the answer is stored on the recipient (free),
// so handing an envelope to another sender, or the sender changing their own address, never turns a free signature
// into a paid one. Before that, and for requests sent before the flag existed, it is the sender's own address that
// decides.
export const sameName = (a: any, b: any) => String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === String(b ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// The sender, as far as paying goes: their address, and their name when it is known.
export type Sender = string | { email: string; name?: string | null };
// Is this recipient the sender signing their own document? Their own address AND their own name: a client entered
// under the sender's address is somebody else, and their signature is paid for like any other.
export const isSelf = (r: any, s: Sender) =>
  r.role === 'signer' && sameEmail(r.email, typeof s === 'string' ? s : s.email) && (typeof s === 'string' || !s.name || sameName(r.name, s.name));

// Signing in person is by definition somebody else signing on the sender's device, so it is never the sender's own
// free signature, whatever address was typed for it.
export const isChargeable = (r: any, sender: Sender) =>
  r.role === 'inperson' || (r.role === 'signer' && (r.free == null ? !isSelf(r, sender) : !r.free));

// One person's signature on one envelope is paid for once. The ledger line is named after the recipient, their
// address and which person on that request they are (person_gen goes up each time the request passes to another
// person: another address, or another name at the same address that is not a spelling of the old one, the test
// "Fix my name" uses). So being asked to sign again after a change costs nothing more, and a different person put in
// their place is a new signature, also at the same address. Lines from before person_gen have no third part, and a
// request that never changed hands still has none, so they keep counting.
export const sigRef = (r: any) => `${r.id}|${String(r.email || '').toLowerCase()}${Number(r.person_gen) > 0 ? `|${Number(r.person_gen)}` : ''}`;
// The request passes to another person: the next one's signature is their own.
export const nextPerson = (r: any) => ({ ...r, person_gen: (Number(r.person_gen) || 0) + 1 });
export const paidFor = (accountId: string, r: any) => !!get("SELECT 1 x FROM credits WHERE account_id=? AND reason='signature' AND ref=?", accountId, sigRef(r));

// How many signatures an envelope still needs: its signers who have not finished, not counting the sender signing
// their own document.
export function needed(e: any, sender: Sender): number {
  return e.recipients.filter((r: any) => isChargeable(r, sender) && r.status !== 'completed' && r.status !== 'declined' && !paidFor(e.account_id, r)).length;
}

export function creditSummary(accountId: string) {
  const b = balance(accountId);
  const held = reserved(accountId);
  return { balance: b, held, available: b - held };
}

// How many of the signatures available right now were paid for, as far as a refund goes. Free signatures (the ones
// every new account gets, and those from a free code) count as used first: the ledger is read in order, and each
// signature used takes a free one while there is one, and a paid one only after that. Signatures held for people
// who have not signed yet are counted the same way. So free signatures that arrive later (a code entered after the
// paid ones were used up) never make a payment that was used up refundable again.
export function paidAvailable(accountId: string): number {
  balance(accountId); // writes this month's code signatures, if any are due
  let free = 0;
  let paid = 0;
  for (const l of all('SELECT delta, reason FROM credits WHERE account_id=? ORDER BY at, id', accountId)) {
    const d = Number(l.delta) || 0;
    if (d > 0) {
      if (l.reason === 'welcome' || l.reason === 'code' || l.reason === 'adjust') free += d;
      else paid += d;
    } else if (l.reason === 'refund' || l.reason === 'dispute') paid += d; // these always go with a payment
    else {
      const fromFree = Math.min(Math.max(0, free), -d);
      free -= fromFree;
      paid += d + fromFree;
    }
  }
  const held = reserved(accountId);
  const heldFromFree = Math.min(Math.max(0, free), held);
  return Math.max(0, paid - (held - heldFromFree));
}
