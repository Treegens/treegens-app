import { createHash } from 'node:crypto';
import { all, get, run, db } from './db.ts';
import { now } from './util.ts';
import { PRICING } from '../lib/impact.ts';
import { TOPUP_EXPIRY_MONTHS, WELCOME_EXPIRY_DAYS, expiryMoment } from '../lib/policy.ts';

// Signatures are the unit people pay for. One credit is one person signing one envelope.
//   - $9 a month adds 9 signatures. A top-up adds one per dollar. Every dollar plants 10 mangroves, used or not.
//   - Signatures expire (expiryRuleText in src/lib/policy.ts, decided 2026-11-20): a plan month's 9 (and a month's
//     from a free code) at the end of that month, top-ups 12 months after their payment, the trial's 3 thirty days
//     after the account was made. The one that expires soonest is used first.
//   - A signature is only used up when somebody actually signs. Sending holds one back for each signer so nobody is
//     ever stopped halfway; voiding, declining and expiring give them back automatically, unless the held one's own
//     date has passed by then: a held signature does not expire while it is held, and is gone once it is let go.
//   - Signing your own document is free. So are approvers, viewers and people who just get a copy.
// The balance is a ledger, so every change can be shown to the customer line by line. On top of it:
//   credit_lots   each line that brings signatures is a lot, with its source, whether it was paid for, and its expiry
//   credit_draws  each line that takes some away (used, refunded, taken back, expired) says which lot they came from
//   credit_holds  each signature held for someone who has not signed yet is held in one lot
// So for every lot: what it brought = used + held + refunded + expired + left, exactly (ledgerSums). The sum of the
// ledger lines is still the balance, and the balance less what is held is what can be sent with.

// Without a payment provider connected there is nothing to buy, so nothing is counted.
export const creditsEnabled = () => !!process.env.STRIPE_SECRET_KEY;

export type CreditReason = 'welcome' | 'plan' | 'code' | 'topup' | 'signature' | 'refund' | 'dispute' | 'adjust' | 'expired';

// Codes that make the monthly plan free. Anyone who enters one gets the plan's signatures every month at no charge.
// Set FREE_PLAN_CODES (comma separated) to change them; the spelling given there is the one shown to people.
export function freeCodes(): Map<string, string> {
  const list = (process.env.FREE_PLAN_CODES ?? 'GROWalition').split(',').map((c) => c.trim()).filter(Boolean);
  return new Map(list.map((c) => [c.toUpperCase(), c]));
}
export const findFreeCode = (typed: any): string | null => freeCodes().get(String(typed ?? '').trim().toUpperCase()) || null;

// An account on a free code gets the plan's signatures for each calendar month (UTC) it is on the code. They belong
// to that month and expire when it ends, like a paid month's. They are written the first time anything looks at the
// balance in that month. A month nobody looked at needs none: nothing could be sent, held or signed on a public form
// without looking first, and the month's signatures would have expired unused at its end anyway. The ledger line is
// one per month whatever the code, so a month can never be granted twice, and a code that has been switched off adds
// nothing more.
function monthlyCodeGrant(accountId: string) {
  const a = get('SELECT promo_code, promo_at FROM accounts WHERE id=?', accountId);
  if (!a?.promo_code || !findFreeCode(a.promo_code)) return;
  const month = now().slice(0, 7);
  if (String(a.promo_at || now()).slice(0, 7) > month) return;
  grant(accountId, PRICING.monthlySignatures, 'code', month);
}

// ---- Lots: where each signature came from and when it expires ------------------------------------------------

const DAY = 864e5;
const sigsWord = (n: number) => `${n} signature${n === 1 ? '' : 's'}`;
/** The same day and time some months later, in UTC; the 31st becomes the last day of a shorter month. */
export function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d.getUTCDate(), last));
  return t.toISOString();
}
// The first moment of the month after "2026-11", in UTC.
const monthAfter = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString();
};
// The sources that were paid for. The trial, a month free with a code and an adjustment a person made were not.
const PAID_SOURCES = ['plan', 'topup'];

// When the signatures of a new line expire, by its source (expiryRuleText in src/lib/policy.ts). A plan payment
// passes the end of the period it paid for (applyInvoice in routes-billing.ts); this is only the fallback for one
// that does not say. An adjustment a person makes does not expire by itself.
function expiryFor(accountId: string, reason: string, ref: string, at: string): string | null {
  if (reason === 'welcome') {
    const made = get('SELECT created_at FROM accounts WHERE id=?', accountId)?.created_at || at;
    return new Date(Date.parse(made) + WELCOME_EXPIRY_DAYS * DAY).toISOString();
  }
  if (reason === 'code') return /^\d{4}-\d{2}$/.test(ref) ? monthAfter(ref) : addMonths(at, 1);
  if (reason === 'topup') return addMonths(at, TOPUP_EXPIRY_MONTHS);
  if (reason === 'plan') {
    // A line written before lots were kept: its month ended when the next plan payment came, or ends at the renewal.
    const later = get("SELECT MIN(at) at FROM credits WHERE account_id=? AND reason='plan' AND delta > 0 AND at > ?", accountId, at)?.at;
    if (later) return later;
    const renews = get('SELECT renews_at FROM accounts WHERE id=?', accountId)?.renews_at;
    return renews && renews > at ? renews : addMonths(at, 1);
  }
  return null;
}

type Lot = { id: number; account_id: string; source: string; ref: string; qty: number; at: string; expires_at: string | null; paid: number; warned: string; drawn: number; held: number };
const loadLots = (accountId: string): Lot[] =>
  all(`SELECT l.*, COALESCE((SELECT SUM(d.n) FROM credit_draws d WHERE d.lot_id=l.id), 0) drawn,
      (SELECT COUNT(*) FROM credit_holds h WHERE h.lot_id=l.id) held FROM credit_lots l WHERE l.account_id=? ORDER BY l.id`, accountId);
const freeIn = (l: Lot) => l.qty - l.drawn - l.held;
// Could this lot pay for something that began at `t` (a hold from when its envelope was sent, a signature)? Only if
// it had not expired by then. A lot whose date has passed can still pay for what began before that date.
const liveAt = (l: Lot, t: string) => !l.expires_at || l.expires_at > t;
// The order signatures are used in: the one that expires soonest first. On the same moment, a free one before a paid
// one (a refund then covers more), and the older lot first.
const soonest = (x: Lot, y: Lot) => (x.expires_at || '9999').localeCompare(y.expires_at || '9999') || x.paid - y.paid || x.id - y.id;
const addDraw = (creditId: number, lotId: number | null, n: number) => void (n && run('INSERT INTO credit_draws (credit_id, lot_id, n) VALUES (?,?,?)', creditId, lotId, n));
const addLot = (accountId: string, creditId: number, source: string, ref: string, qty: number, at: string, expiresAt: string | null) =>
  run('INSERT OR IGNORE INTO credit_lots (id, account_id, source, ref, qty, at, expires_at, paid) VALUES (?,?,?,?,?,?,?,?)', creditId, accountId, source, ref, qty, at, expiresAt, PAID_SOURCES.includes(source) ? 1 : 0);

// Takes `need` signatures that are free (not held) for line `creditId`, soonest-expiring first, from lots that had
// arrived by `at` (the line's own time) and could pay at `since`. What no lot can pay for is drawn from no lot: the
// account is short by that much, and the next lot to arrive pays for it first (fund).
function takeFree(accountId: string, creditId: number, need: number, since: string, at: string) {
  for (const l of loadLots(accountId).sort(soonest)) {
    if (need <= 0) break;
    const k = Math.min(need, freeIn(l));
    if (k > 0 && liveAt(l, since) && l.at <= at) {
      addDraw(creditId, l.id, k);
      need -= k;
    }
  }
  if (need > 0) addDraw(creditId, null, need);
}

// A line that takes signatures away and did not say from where. A signature takes the one that was held for it,
// when one was; otherwise one that was free when its envelope went out.
function drawLine(accountId: string, creditId: number, need: number, reason: string, ref: string, at: string) {
  let since = at;
  if (reason === 'signature') {
    const key = holdKey(ref);
    const h = get('SELECT * FROM credit_holds WHERE account_id=? AND key=?', accountId, key);
    if (h) {
      run('DELETE FROM credit_holds WHERE account_id=? AND key=?', accountId, key);
      since = h.since < at ? h.since : at;
      if (h.lot_id && need > 0) {
        addDraw(creditId, h.lot_id, 1);
        need--;
      }
    } else {
      const sent = get('SELECT e.sent_at FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE r.id=?', String(ref).split('|')[0])?.sent_at;
      if (sent && sent < at) since = sent;
    }
  }
  if (need > 0) takeFree(accountId, creditId, need, since, at);
}

// A line that gives back what an earlier one took (a dispute the bank decided in our favour): the signatures go back
// to the lots they came from. A lot whose date has passed in the meantime does not get them back for long: they
// expire with it (expireDue), as a held signature does that is let go after its date.
function restoreLine(accountId: string, creditId: number, ref: string, n: number) {
  const from = String(ref).startsWith('dispute-won:') ? get("SELECT id FROM credits WHERE account_id=? AND reason='dispute' AND ref=?", accountId, `dispute:${String(ref).slice('dispute-won:'.length)}`) : null;
  for (const d of from ? all('SELECT lot_id, n FROM credit_draws WHERE credit_id=? AND lot_id IS NOT NULL AND n > 0 ORDER BY id', from.id) : []) {
    if (n <= 0) break;
    const k = Math.min(n, d.n);
    addDraw(creditId, d.lot_id, -k);
    n -= k;
  }
  // Nothing on record to give it back to (a line written by hand): a lot of its own, which does not expire.
  if (n > 0) addLot(accountId, creditId, 'adjust', ref, n, now(), null);
}

// Adds a line to the ledger once. The same (reason, ref) can never be applied twice, which makes retries harmless.
// A line that brings signatures is a lot, with its expiry (`expiresAt`, or the rule for its source). A line that
// takes some away says which lots they came from.
export function grant(accountId: string, delta: number, reason: CreditReason, ref: string, at?: string, expiresAt?: string | null): boolean {
  const when = at || now();
  const r = run('INSERT OR IGNORE INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,?,?,?)', accountId, delta, reason, ref, when);
  if (!r.changes) return false;
  const lineId = Number(r.lastInsertRowid);
  if (delta > 0 && reason === 'dispute') restoreLine(accountId, lineId, ref, delta);
  else if (delta > 0) addLot(accountId, lineId, reason, ref, delta, when, expiresAt === undefined ? expiryFor(accountId, reason, ref, when) : expiresAt);
  else if (delta < 0) {
    if (reason !== 'code') monthlyCodeGrant(accountId);
    drawLine(accountId, lineId, -delta, reason, ref, when);
  }
  return true;
}

// ---- Holds -------------------------------------------------------------------------------------------------

// Signatures held for people who have been asked to sign and have not yet finished. A public form holds nothing:
// anyone can start one with a made-up address, and that must not be a way to lock up the owner's balance. A form
// only starts while at least one signature is available, and uses one when its visitor actually signs.
const HELD = `FROM recipients r JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id
      WHERE e.account_id=? AND e.kind='envelope' AND e.status='sent' AND r.status IN ('pending','sent','viewed')
        AND e.powerform_id IS NULL
        AND (r.role = 'inperson' OR (r.role = 'signer' AND (r.free = 0 OR (r.free IS NULL AND r.email != u.email))))
        AND NOT EXISTS (SELECT 1 FROM credits c WHERE c.account_id = e.account_id AND c.reason = 'signature'
          AND c.ref = r.id || '|' || lower(r.email) || CASE WHEN COALESCE(r.person_gen, 0) > 0 THEN '|' || r.person_gen ELSE '' END)`;
export function reserved(accountId: string): number {
  return get(`SELECT COUNT(*) n ${HELD}`, accountId).n;
}
// A hold is known by a fingerprint of the ledger line its signature will have (sigRef), so no address is kept here.
export const holdKey = (ref: string) => createHash('sha256').update(String(ref)).digest('hex').slice(0, 32);

// Each signature held right now is held in one lot: the soonest-expiring one that was free when its envelope went
// out. One that is let go (voided, declined, out of time, another person put in) goes back to its lot, and if that
// lot's date has passed by then it expires with it instead of coming back.
function syncHolds(accountId: string) {
  const want = new Map<string, string>();
  for (const r of all(`SELECT r.id, r.email, r.person_gen, COALESCE(e.sent_at, ?) since ${HELD}`, now(), accountId)) want.set(holdKey(sigRef(r)), r.since);
  const have = all('SELECT key FROM credit_holds WHERE account_id=?', accountId);
  for (const h of have) if (!want.has(h.key)) run('DELETE FROM credit_holds WHERE account_id=? AND key=?', accountId, h.key);
  const had = new Set(have.map((h) => h.key));
  const fresh = [...want].filter(([k]) => !had.has(k)).sort((x, y) => x[1].localeCompare(y[1]));
  if (!fresh.length) return;
  const lots = loadLots(accountId).sort(soonest);
  for (const [key, since] of fresh) {
    const l = lots.find((x) => liveAt(x, since) && freeIn(x) > 0);
    run('INSERT OR REPLACE INTO credit_holds (account_id, key, lot_id, since) VALUES (?,?,?,?)', accountId, key, l?.id ?? null, since);
    if (l) l.held++;
  }
}

// What no lot could pay for when it happened (more was used or held than there was) is paid for by the next lot
// with room, used signatures first. And a held signature always sits in the soonest-expiring lot that has room, so
// a new month's signatures are used before a top-up's, and nobody loses one that could have been used. A held one
// in a lot whose date has passed stays where it is: that is what keeps it from expiring.
function fund(accountId: string) {
  const t = now();
  const lots = loadLots(accountId).sort(soonest);
  const room = (since: string) => lots.find((l) => liveAt(l, since) && liveAt(l, t) && freeIn(l) > 0);
  for (const d of all('SELECT d.id, d.credit_id, d.n FROM credit_draws d JOIN credits c ON c.id=d.credit_id WHERE c.account_id=? AND d.lot_id IS NULL AND d.n > 0 ORDER BY d.id', accountId)) {
    if (!room(t)) break;
    run('DELETE FROM credit_draws WHERE id=?', d.id);
    let need = d.n;
    for (let l = room(t); l && need > 0; l = room(t)) {
      const k = Math.min(need, freeIn(l));
      addDraw(d.credit_id, l.id, k);
      l.drawn += k;
      need -= k;
    }
    if (need > 0) addDraw(d.credit_id, null, need);
  }
  for (const h of all('SELECT key, since FROM credit_holds WHERE account_id=? AND lot_id IS NULL ORDER BY since', accountId)) {
    const l = lots.find((x) => liveAt(x, h.since) && freeIn(x) > 0);
    if (!l) break;
    run('UPDATE credit_holds SET lot_id=? WHERE account_id=? AND key=?', l.id, accountId, h.key);
    l.held++;
  }
  for (const h of all('SELECT key, lot_id FROM credit_holds WHERE account_id=? AND lot_id IS NOT NULL', accountId)) {
    const cur = lots.find((l) => l.id === h.lot_id);
    if (!cur || !liveAt(cur, t)) continue;
    const better = lots.find((l) => l !== cur && liveAt(l, t) && freeIn(l) > 0 && soonest(l, cur) < 0);
    if (!better) continue;
    run('UPDATE credit_holds SET lot_id=? WHERE account_id=? AND key=?', better.id, accountId, h.key);
    cur.held--;
    better.held++;
  }
}

// What a lot is, in the words of the plan history.
function lotWords(l: Lot): string {
  const until = expiryMoment(l.expires_at);
  if (l.source === 'plan') return `of the ${sigsWord(l.qty)} of the monthly plan for the month that ended on ${until}`;
  if (l.source === 'code') return `of the ${sigsWord(l.qty)} of ${new Date(l.at).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })} that came free with your code, at the end of that month (${until})`;
  if (l.source === 'topup') return `of the ${sigsWord(l.qty)} of the top-up bought on ${expiryMoment(l.at)}, ${TOPUP_EXPIRY_MONTHS} months after that payment (${until})`;
  if (l.source === 'welcome') return `of the ${sigsWord(l.qty)} every new account gets, ${WELCOME_EXPIRY_DAYS} days after the account was made (${until})`;
  return `of ${sigsWord(l.qty)} added on ${expiryMoment(l.at)}, on ${until}`;
}

// Lots whose date has passed: what is left in them that nobody holds expires, with a line in the ledger ('expired')
// and one in the plan history that says how many. A held signature that is let go after its lot's date expires the
// same way, with a line of its own, when it is let go.
function expireDue(accountId: string) {
  const t = now();
  for (const l of loadLots(accountId).filter((x) => x.expires_at && x.expires_at <= t && freeIn(x) > 0)) {
    const n = freeIn(l);
    const before = get("SELECT COUNT(*) n FROM credit_draws d JOIN credits c ON c.id=d.credit_id WHERE d.lot_id=? AND c.reason='expired'", l.id).n;
    const at = before ? t : l.expires_at!;
    const r = run("INSERT OR IGNORE INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,'expired',?,?)", accountId, -n, `lot:${l.id}:${before + 1}`, at);
    if (!r.changes) continue;
    addDraw(Number(r.lastInsertRowid), l.id, n);
    const detail = before
      ? `${sigsWord(n)} that ${n === 1 ? 'was' : 'were'} held for an envelope ${n === 1 ? 'was' : 'were'} let go after ${n === 1 ? 'its' : 'their'} date had passed, so ${n === 1 ? 'it' : 'they'} expired instead of coming back (${lotWords(l)}).`
      : `${n} ${lotWords(l)} expired unused.`;
    run('INSERT INTO billing_log (account_id, at, what, ref, detail) VALUES (?,?,?,?,?)', accountId, at, 'expired', PAID_SOURCES.includes(l.source) ? l.ref : '', detail);
  }
}

// Brings an account's lots up to date: lines from before lots were kept, holds, what nobody could pay for, and what
// has expired. It runs whenever anything looks at the balance and on the timer (expireSignatures), all in one step
// that either happens in full or not at all, also inside a larger transaction.
function backfill(accountId: string) {
  for (const c of all(`SELECT c.* FROM credits c WHERE c.account_id=? AND c.reason != 'expired'
      AND NOT EXISTS (SELECT 1 FROM credit_lots l WHERE l.id=c.id) AND NOT EXISTS (SELECT 1 FROM credit_draws d WHERE d.credit_id=c.id) ORDER BY c.id`, accountId)) {
    if (c.delta > 0 && c.reason === 'dispute') restoreLine(accountId, c.id, c.ref, c.delta);
    else if (c.delta > 0) addLot(accountId, c.id, c.reason, c.ref, c.delta, c.at, expiryFor(accountId, c.reason, c.ref, c.at));
    else if (c.delta < 0) drawLine(accountId, c.id, -c.delta, c.reason, c.ref, c.at);
  }
}
function settle(accountId: string) {
  if (!accountId || !creditsEnabled()) return;
  monthlyCodeGrant(accountId);
  const d = db();
  d.exec('SAVEPOINT sg_settle');
  try {
    backfill(accountId);
    syncHolds(accountId);
    fund(accountId);
    expireDue(accountId);
    d.exec('RELEASE sg_settle');
  } catch (e) {
    d.exec('ROLLBACK TO sg_settle');
    d.exec('RELEASE sg_settle');
    throw e;
  }
}

// The balance: every signature that has not been used, refunded or expired, the held ones included. What can be sent
// with is the balance less what is held (available).
export function balance(accountId: string): number {
  if (creditsEnabled()) settle(accountId);
  else monthlyCodeGrant(accountId);
  return get('SELECT COALESCE(SUM(delta),0) n FROM credits WHERE account_id=?', accountId).n;
}

export const available = (accountId: string): number => balance(accountId) - reserved(accountId);

export const sameEmail = (a: any, b: any) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

// Does this person's signature cost one? Once a request has gone out the answer is stored on the recipient (free),
// so handing an envelope to another sender, or the sender changing their own address, never turns a free signature
// into a paid one. Before that, and for requests sent before the flag existed, it is the sender's own address that
// decides.
// Accents do not make another person: "María García" and "Maria Garcia" are the same name, as on the signing page.
const plainName = (a: any) => String(a ?? '').normalize('NFKD').replace(/\p{M}/gu, '').trim().replace(/\s+/g, ' ').toLowerCase();
export const sameName = (a: any, b: any) => plainName(a) === plainName(b);

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
// Which person on the request `name` at `email` is. recipients.person_gens remembers who each gen was (plain name and
// address), so a request that comes back to someone it had before (renamed to somebody else and back, or corrected
// away and back) is that person's gen again, with what they already paid for; anyone new gets the next gen. The
// answer is the gen and the map to store with it. Gens from before the map was kept are not known, and count as
// other people.
const personKey = (name: any, email: any) => `${plainName(name)}|${String(email ?? '').trim().toLowerCase()}`;
export function personGen(r: any, name: any, email: any): { gen: number; gens: string } {
  let seen: Record<string, string> = {};
  try {
    seen = JSON.parse(r.person_gens || '{}') || {};
  } catch {}
  const cur = Number(r.person_gen) || 0;
  if (!(String(cur) in seen)) seen[String(cur)] = personKey(r.name, r.email);
  const want = personKey(name, email);
  const hit = Object.keys(seen).find((g) => seen[g] === want);
  const gen = hit != null ? Number(hit) : Math.max(cur, ...Object.keys(seen).map(Number)) + 1;
  seen[String(gen)] = want;
  return { gen, gens: JSON.stringify(seen) };
}
// The request passes to another person: the next one's signature is their own (or theirs from before, see personGen).
export const nextPerson = (r: any, to?: { name?: any; email?: any }) => ({ ...r, person_gen: to ? personGen(r, to.name, to.email).gen : (Number(r.person_gen) || 0) + 1 });
export const paidFor = (accountId: string, r: any) => !!get("SELECT 1 x FROM credits WHERE account_id=? AND reason='signature' AND ref=?", accountId, sigRef(r));

// How many signatures an envelope still needs: its signers who have not finished, not counting the sender signing
// their own document.
export function needed(e: any, sender: Sender): number {
  return e.recipients.filter((r: any) => isChargeable(r, sender) && r.status !== 'completed' && r.status !== 'declined' && !paidFor(e.account_id, r)).length;
}

// A payment that has "stood", as far as the limits on accounts that have not paid go (hasNotPaid in envelopes.ts,
// and the Plan page): for the plan or a top-up, applied, not disputed, and not refunded, except for money the
// software sent back by itself because more was charged than we said (the reasons start "we said" or "the price went
// up", see applyInvoice in routes-billing.ts). That small correction is ours, not the customer taking the money back.
// A condition on the `payments` table, for a WHERE clause.
export const STANDING_PAYMENT = `payments.kind IN ('plan','topup') AND payments.applied_at IS NOT NULL AND payments.amount_cents > 0 AND payments.disputed IS NULL
  AND payments.refunded_cents < payments.amount_cents
  AND payments.refunded_cents <= (SELECT COALESCE(SUM(r.cents), 0) FROM refunds r WHERE r.payment_id = payments.id AND r.status = 'done' AND r.auto = 1
    AND (r.why LIKE 'we said %' OR r.why LIKE 'the price went up%'))`;

export function creditSummary(accountId: string) {
  const b = balance(accountId);
  const held = reserved(accountId);
  return { balance: b, held, available: b - held };
}

// ---- What each lot holds, for the Plan page, the API, refunds and the payment code ---------------------------

export type LotView = {
  id: number; source: string; ref: string; paid: boolean; at: string; expires_at: string | null; live: boolean;
  qty: number; used: number; held: number; refunded: number; expired: number; adjusted: number; left: number;
};
// Every lot of an account, oldest first, with where each of its signatures went: used (somebody signed), held (for
// someone who has been asked), refunded (with a refund or a dispute, less what came back when one was won), expired,
// adjusted (a person took some away by hand), and left (unused, not held, and not expired: what can be sent with).
// qty = used + held + refunded + expired + adjusted + left, for every lot, always.
export function lotsOf(accountId: string): LotView[] {
  settle(accountId);
  const by = new Map<string, number>();
  for (const d of all('SELECT d.lot_id, c.reason, SUM(d.n) n FROM credit_draws d JOIN credits c ON c.id=d.credit_id WHERE c.account_id=? AND d.lot_id IS NOT NULL GROUP BY d.lot_id, c.reason', accountId))
    by.set(`${d.lot_id}:${d.reason}`, Number(d.n) || 0);
  const t = now();
  return loadLots(accountId).map((l) => {
    const n = (r: string) => by.get(`${l.id}:${r}`) || 0;
    const used = n('signature');
    const refunded = n('refund') + n('dispute');
    const expired = n('expired');
    const adjusted = n('adjust');
    const live = liveAt(l, t);
    return { id: l.id, source: l.source, ref: l.ref, paid: !!l.paid, at: l.at, expires_at: l.expires_at, live, qty: l.qty, used, held: l.held, refunded, expired, adjusted, left: l.qty - used - refunded - expired - adjusted - l.held };
  });
}
// The lot a payment bought (a plan payment or a top-up), if it bought any.
export const lotOfPayment = (accountId: string, paymentId: string, lots = lotsOf(accountId)): LotView | null =>
  lots.find((l) => l.ref === paymentId && PAID_SOURCES.includes(l.source)) || null;

// The whole account in numbers, so it can be checked that every signature is accounted for: what came in (bought,
// or given: the trial, a free code, an adjustment) equals what was used, is held, was refunded, expired, was
// adjusted away or is left. `short` is what was used or is held beyond what any lot could pay for; the next lot to
// arrive pays for it first. available = left - short, and balance = available + what is held.
export function ledgerSums(accountId: string) {
  const ls = lotsOf(accountId);
  const sum = (f: (l: LotView) => number) => ls.reduce((n, l) => n + f(l), 0);
  const owedUsed = Number(get('SELECT COALESCE(SUM(d.n),0) n FROM credit_draws d JOIN credits c ON c.id=d.credit_id WHERE c.account_id=? AND d.lot_id IS NULL', accountId).n) || 0;
  const owedHeld = Number(get('SELECT COUNT(*) n FROM credit_holds WHERE account_id=? AND lot_id IS NULL', accountId).n) || 0;
  const left = sum((l) => l.left);
  return {
    bought: sum((l) => (l.paid ? l.qty : 0)), given: sum((l) => (l.paid ? 0 : l.qty)),
    used: sum((l) => l.used), held: sum((l) => l.held), refunded: sum((l) => l.refunded), expired: sum((l) => l.expired), adjusted: sum((l) => l.adjusted), left,
    short: owedUsed + owedHeld, available: left - owedUsed - owedHeld,
  };
}

// A self-serve refund takes the payment's own unused signatures that have not expired, and nothing else: that is
// what the refund rule pays back (refundRuleText). The answer is how many were taken.
export function refundFromLot(accountId: string, n: number, ref: string, paymentId: string): number {
  settle(accountId);
  const l = loadLots(accountId).find((x) => x.ref === paymentId && PAID_SOURCES.includes(x.source));
  const k = l && liveAt(l, now()) ? Math.min(n, Math.max(0, freeIn(l))) : 0;
  if (k <= 0) return 0;
  const r = run("INSERT OR IGNORE INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,'refund',?,?)", accountId, -k, ref, now());
  if (!r.changes) return 0;
  addDraw(Number(r.lastInsertRowid), l!.id, k);
  return k;
}

// Money that went back by another road (a refund at the provider, a dispute): the signatures it paid for leave with
// it. That payment's own signatures that are still there go first (unused ones, then held ones: those envelopes can
// still be signed, and the balance then shows what is owed). Ones of that payment that expired are gone already, so
// nothing is taken for them. For the ones that were used, others are taken from what is left (soonest-expiring
// first), as far as the balance goes. The answer: taken, used (could not be taken back) and expired.
export function takeBackLots(accountId: string, paidFor: number, reason: 'refund' | 'dispute', ref: string, paymentId: string): { taken: number; used: number; expired: number } {
  settle(accountId);
  if (paidFor <= 0 || get('SELECT 1 x FROM credits WHERE account_id=? AND reason=? AND ref=?', accountId, reason, ref)) return { taken: 0, used: 0, expired: 0 };
  const t = now();
  const lots = loadLots(accountId).sort(soonest);
  const own = lots.find((l) => l.ref === paymentId && PAID_SOURCES.includes(l.source)) || null;
  const plan: { lot: Lot; n: number; held: number }[] = [];
  // From one lot: its free signatures (only while its date has not passed), or its held ones.
  const takeFrom = (l: Lot, n: number, held: boolean) => {
    const k = Math.min(n, held ? l.held : liveAt(l, t) ? Math.max(0, freeIn(l)) : 0);
    if (k > 0) {
      plan.push({ lot: l, n: k, held: held ? k : 0 });
      l.drawn += k;
      if (held) l.held -= k;
    }
    return k;
  };
  let need = paidFor;
  if (own) {
    need -= takeFrom(own, need, false);
    need -= takeFrom(own, need, true);
  }
  const ownExpired = own ? Number(get("SELECT COALESCE(SUM(d.n),0) n FROM credit_draws d JOIN credits c ON c.id=d.credit_id WHERE d.lot_id=? AND c.reason='expired'", own.id).n) || 0 : 0;
  const expired = Math.min(need, ownExpired);
  need -= expired;
  const fromOwn = paidFor - expired - need;
  const sum = Number(get('SELECT COALESCE(SUM(delta),0) n FROM credits WHERE account_id=?', accountId).n) || 0;
  let cap = Math.max(0, sum - fromOwn);
  for (const held of [false, true])
    for (const l of lots.filter((x) => x !== own)) {
      if (need <= 0 || cap <= 0) break;
      const k = takeFrom(l, Math.min(need, cap), held);
      need -= k;
      cap -= k;
    }
  const taken = plan.reduce((n, p) => n + p.n, 0);
  if (taken > 0) {
    const r = run('INSERT OR IGNORE INTO credits (account_id, delta, reason, ref, at) VALUES (?,?,?,?,?)', accountId, -taken, reason, ref, t);
    const lineId = Number(r.lastInsertRowid);
    for (const p of plan) {
      addDraw(lineId, p.lot.id, p.n);
      // The held ones taken here are held in no lot now: the next one with room pays for them (fund).
      if (p.held) run('UPDATE credit_holds SET lot_id=NULL WHERE rowid IN (SELECT rowid FROM credit_holds WHERE account_id=? AND lot_id=? ORDER BY since DESC LIMIT ?)', accountId, p.lot.id, p.held);
    }
    settle(accountId);
  }
  return { taken, used: need, expired };
}

// Signatures that were set aside and come back (a dispute the bank decided in our favour): back to the lots they
// were taken from. The answer says how many are back to use and how many had passed their date in the meantime and
// are gone with it.
export function restoreTaken(accountId: string, n: number, ref: string): { back: number; gone: number } {
  if (n <= 0 || !grant(accountId, n, 'dispute', ref)) return { back: 0, gone: 0 };
  const line = get("SELECT id FROM credits WHERE account_id=? AND reason='dispute' AND ref=?", accountId, ref);
  const t = now();
  let gone = 0;
  for (const d of all('SELECT d.n, l.expires_at FROM credit_draws d JOIN credit_lots l ON l.id=d.lot_id WHERE d.credit_id=?', line.id)) if (d.expires_at && d.expires_at <= t) gone += -d.n;
  settle(accountId);
  return { back: n - gone, gone };
}
// Of the signatures a line took (a refund that is being undone, say), how many went back to a lot whose date has
// not passed: the ones that are usable again once the line goes.
export function stillLive(accountId: string, reason: string, ref: string): number {
  const line = get('SELECT id FROM credits WHERE account_id=? AND reason=? AND ref=?', accountId, reason, ref);
  if (!line) return 0;
  return Number(get('SELECT COALESCE(SUM(d.n),0) n FROM credit_draws d JOIN credit_lots l ON l.id=d.lot_id WHERE d.credit_id=? AND (l.expires_at IS NULL OR l.expires_at > ?)', line.id, now()).n) || 0;
}
// Writes down that a lot's expiry email for `stage` (days before) went out, so it goes once.
export const markWarned = (lotId: number, stage: string) => {
  const l = get('SELECT warned FROM credit_lots WHERE id=?', lotId);
  if (l && !String(l.warned).split(',').includes(stage)) run('UPDATE credit_lots SET warned=? WHERE id=?', [...String(l.warned).split(',').filter(Boolean), stage].join(','), lotId);
};

// On the timer: every account with a lot whose date has passed and that still has something in it nobody holds.
// Its holds are brought up to date first (settle), so a signature held for an envelope that is out stays held.
// The answer is how many signatures expired.
export function expireSignatures(): number {
  if (!creditsEnabled()) return 0;
  const t = now();
  let n = 0;
  const count = (id: string) => Number(get("SELECT COALESCE(SUM(-delta),0) n FROM credits WHERE account_id=? AND reason='expired'", id).n) || 0;
  for (const r of all(`SELECT DISTINCT l.account_id FROM credit_lots l JOIN accounts a ON a.id=l.account_id WHERE l.expires_at <= ?
      AND l.qty > COALESCE((SELECT SUM(d.n) FROM credit_draws d WHERE d.lot_id=l.id), 0) + (SELECT COUNT(*) FROM credit_holds h WHERE h.lot_id=l.id)`, t)) {
    const before = count(r.account_id);
    settle(r.account_id);
    n += count(r.account_id) - before;
  }
  return n;
}

/**
 * For the note a signer reads about trees (src/app/sign, built by another engineer): true when the signature held
 * or used for this recipient comes from a lot that was paid for, a monthly plan payment or a top-up, and that payment
 * still stands (not refunded in full, not disputed). False for the free signatures of a new account, a month that is
 * free with a code such as GROWalition, an adjustment a person made, a signature no lot could pay for yet, and for a
 * signer who uses none at all: the sender signing their own document under their own name and address, an approver,
 * a viewer, a copy, or a recipient who has not been sent the envelope yet. It reads the account as it stands right
 * now: a held signature sits in the soonest-expiring lot, so the answer can change while it is held (when a new month
 * arrives, say), and is fixed once the person has signed.
 */
export function paidSignatureFor(recipientId: string): boolean {
  const r = get('SELECT r.id, r.email, r.person_gen, e.account_id FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE r.id=?', recipientId);
  if (!r) return false;
  settle(r.account_id);
  const ref = sigRef(r);
  const line = get("SELECT id FROM credits WHERE account_id=? AND reason='signature' AND ref=?", r.account_id, ref);
  const lotId = line
    ? get('SELECT lot_id FROM credit_draws WHERE credit_id=? AND n > 0 AND lot_id IS NOT NULL ORDER BY id LIMIT 1', line.id)?.lot_id
    : get('SELECT lot_id FROM credit_holds WHERE account_id=? AND key=?', r.account_id, holdKey(ref))?.lot_id;
  const l = lotId ? get('SELECT * FROM credit_lots WHERE id=?', lotId) : null;
  if (!l?.paid) return false;
  const p = get('SELECT amount_cents, refunded_cents, disputed FROM payments WHERE id=?', l.ref);
  return !!p && p.amount_cents > 0 && p.refunded_cents < p.amount_cents && (p.disputed == null || p.disputed === 'won');
}
