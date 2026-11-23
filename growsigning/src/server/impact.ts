// Trees, as the server knows them. Everything here is a claim somebody will read, so it is decided here and nowhere
// else: whether a signature counts, whether this is the first time a person signs or an account sends, and the
// totals. The pages only draw what these functions return (src/lib/impactwords.ts has the words, and
// treesForSignature in src/lib/impact.ts is the one counting function).
//
// The rule (the owner's decision of 23 November 2026): every signature plants 5 trees. It does not matter where the
// signature came from: the free ones of a new account, the monthly plan, a top-up, a free code, a reward for inviting
// a friend. A signature is one taken from an account's balance, so the only people who sign and plant nothing are a
// sender signing their own document (that uses no signature and has no limit) and anyone on a server that has no
// plans at all. An approver, a viewer, a copy and a witness do not sign, and are told nothing.
//
// What is counted: one row in impact_signed for every finished signature of a person who signs (role signer, or a
// signer in person), written at Finish with the trees of the rule of that day, and never changed afterwards. Rows
// from before the change say what was promised then: 10 for a signature that was paid for, 0 for a free one. Only
// those old rows are still asked whether their payment stands, as they always were.
//
// The totals of an account and of everyone keep the old promise for old money: before the change a total was 10
// mangroves for every dollar paid, whether its signatures were used or not. So a total is
//   10 for every dollar paid before the change that still stands (treesOfOldMoney)
//   + the rows from the change on, except those whose signature was bought with that old money (old_payment),
//     while that payment stands: their trees are in the first part already.
// (Rows from before the change are in the first part too, as the money that paid for them; a free one was 0.)
// Nothing a person was shown before the change goes down because of it, and nothing is counted twice.
import { get, all, run } from './db.ts';
import { hmac, now } from './util.ts';
import { paidSignatureFor, signaturePayment, creditsEnabled, isChargeable } from './credits.ts';
import { treesForSignature, TREES_5_FROM, TREES_BEFORE } from '../lib/impact.ts';
import { type SignerFacts, type SenderFacts } from '../lib/impactwords.ts';

/** Who signs: the only people a tree is ever mentioned to. */
export const signs = (r: any): boolean => r?.role === 'signer' || r?.role === 'inperson';

/** A keyed hash of an address. Rows about a person are kept under this, never under the address itself. */
export const whoOf = (email: any): string | null => {
  const e = String(email ?? '').trim().toLowerCase();
  return e ? hmac(`impact:${e}`) : null;
};

const genOf = (r: any) => Number(r?.person_gen) || 0;

/**
 * Who a finished signature belongs to. Someone who signs in person has no address of their own on the document: the
 * address on their row is the host's, and every walk-in at one desk would share it. So they are nobody we can know
 * again, and their signature is counted for the document and the account only, never added to another person's.
 */
const personOf = (r: any): string | null => (r?.role === 'inperson' ? null : whoOf(r?.email));

/** Does this server take payments at all? Where it does not, nothing is earned and nothing is said about giving. */
export const takesPayments = (): boolean => creditsEnabled();

/**
 * Does this person's signature count? Yes for everyone who signs with a signature from the account's balance,
 * whichever lot it comes from. No for a sender signing their own document, for anyone who does not sign, and on a
 * server without plans. The sender is read from the envelope when the caller does not have them at hand.
 */
export function counts(r: any, sender?: { email: string; name?: string | null } | null): boolean {
  if (!creditsEnabled() || !signs(r)) return false;
  const s = sender ?? get('SELECT u.email, u.name FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE e.id=?', r.envelope_id);
  return !s || isChargeable(r, s);
}

/**
 * Trees that will be planted when this person finishes: 5 for someone whose signature counts, while it is their
 * turn. This is the line on the first screen of the signing page, the line next to Finish and the line in the email.
 */
export function treesAtFinish(r: any): number {
  if (!signs(r) || (r.status !== 'sent' && r.status !== 'viewed')) return 0;
  return counts(r) ? treesForSignature() : 0;
}

/**
 * The same, for the email that asks someone to sign. The email is written a moment after the person's turn began,
 * from a copy of their row that may still say "pending", so the row's status is not asked here. Nobody who has
 * finished, and nobody who does not sign, gets the line.
 */
export const treesInInvite = (r: any): number => (signs(r) && r.status !== 'completed' && counts(r) ? treesForSignature() : 0);

// The trees of a signature finished at `at`, by the rule of that day: from the change on, 5 for every signature that
// counts; before it, what was promised then (a signature finished earlier and only written down now).
const treesNow = (r: any, at: string): number =>
  at < TREES_5_FROM ? treesForSignature({ at, paid: paidSignatureFor(r.id) }) : counts(r) ? treesForSignature({ at }) : 0;

/** Writes down a finished signature once. Safe to call any number of times, from any path that finishes one. */
export function noteSigned(r: any): void {
  if (!r || !signs(r) || r.status !== 'completed') return;
  const e = get('SELECT account_id FROM envelopes WHERE id=?', r.envelope_id);
  const at = r.completed_at || now();
  if (get('SELECT 1 x FROM impact_signed WHERE recipient_id=? AND gen=?', r.id, genOf(r))) return;
  // Bought with money paid before the change: that money's old promise is in the totals already (treesOfOldMoney).
  const paid = at >= TREES_5_FROM ? signaturePayment(r.id) : null;
  run('INSERT OR IGNORE INTO impact_signed (recipient_id, gen, envelope_id, account_id, who, trees, at, old_payment) VALUES (?,?,?,?,?,?,?,?)',
    r.id, genOf(r), r.envelope_id, e?.account_id || null, personOf(r), treesNow(r, at), at, paid && paid.at < TREES_5_FROM ? paid.id : null);
}

/**
 * Called by Finish itself (completeRecipient in envelopes.ts), so a signature is counted whether or not anyone
 * ever opens the finished screen or the signing record, and stays counted when its envelope is cancelled later. It
 * reads the row as it is now, and it never stops a Finish: counting trees is not worth a failed signature.
 */
export function noteFinished(recipientId: string): void {
  try {
    noteSigned(get('SELECT * FROM recipients WHERE id=?', recipientId));
  } catch { /* counted later, when the finished screen or the signing record asks (signerMoment, treesOnEnvelope) */ }
}

/** Every finished signature on an envelope is written down, whichever way it was finished. */
function noteEnvelope(envelopeId: string): void {
  for (const r of all("SELECT * FROM recipients WHERE envelope_id=? AND status='completed' AND role IN ('signer','inperson')", envelopeId)) noteSigned(r);
}

// What a row counts for today. A row of the 5 trees rule stands as it was written: free or paid, the signature
// happened. A row from before the change was a promise about a payment, so while its signature can still be asked
// about (the recipient is there and is the same person), the payment is asked again, as it was then.
function standing(row: any): number {
  if (!row.trees) return 0;
  if (String(row.at) >= TREES_5_FROM) return Number(row.trees) || 0;
  const r = get('SELECT id, person_gen FROM recipients WHERE id=?', row.recipient_id);
  if (!r || genOf(r) !== Number(row.gen)) return row.trees;
  return paidSignatureFor(r.id) ? row.trees : 0;
}
// The newest rows are asked again one by one; a long history beyond that is taken as written.
const RECHECK = 300;
const sumStanding = (rows: any[]) => rows.reduce((s, row, i) => s + (i < RECHECK ? standing(row) : Number(row.trees) || 0), 0);

/** Trees planted by the signatures finished on one envelope. */
export function treesOnEnvelope(envelopeId: string): number {
  noteEnvelope(envelopeId);
  return sumStanding(all('SELECT * FROM impact_signed WHERE envelope_id=? ORDER BY at DESC', envelopeId));
}

/**
 * Trees promised by money paid before the 5 trees rule: 10 for every dollar of it that still stands (less refunds),
 * whether its signatures were used or not. That was the total people were shown then, and it stays.
 */
export function treesOfOldMoney(accountId?: string): number {
  const p = accountId
    ? get("SELECT COALESCE(SUM(amount_cents - refunded_cents),0) cents FROM payments WHERE account_id=? AND kind IN ('plan','topup') AND at < ?", accountId, TREES_5_FROM)
    : get("SELECT COALESCE(SUM(amount_cents - refunded_cents),0) cents FROM payments WHERE account_id IS NOT NULL AND kind IN ('plan','topup') AND at < ?", TREES_5_FROM);
  return Math.max(0, Math.floor(((Number(p?.cents) || 0) / 100) * TREES_BEFORE.perUsd));
}

// A row that is not already counted as old money: a free signature, one bought since the change, or one whose old
// payment went back in full (then the money counts nothing any more, and the signature still happened).
const NOT_IN_OLD_MONEY = '(s.old_payment IS NULL OR NOT EXISTS (SELECT 1 FROM payments p WHERE p.id=s.old_payment AND p.amount_cents - p.refunded_cents > 0))';

/** Trees of an account's documents: old money at its old promise, and every signature since at 5 (see the top). */
export function treesOfAccount(accountId: string): number {
  const rows = get(`SELECT COALESCE(SUM(s.trees),0) n FROM impact_signed s WHERE s.account_id=? AND s.at >= ? AND ${NOT_IN_OLD_MONEY}`, accountId, TREES_5_FROM);
  return treesOfOldMoney(accountId) + (Number(rows?.n) || 0);
}

/** The same for every account on this server: the public total. */
export function treesOfEveryone(): number {
  const rows = get(`SELECT COALESCE(SUM(s.trees),0) n FROM impact_signed s WHERE s.at >= ? AND ${NOT_IN_OLD_MONEY}`, TREES_5_FROM);
  return treesOfOldMoney() + (Number(rows?.n) || 0);
}

const seen = (key: string) => !!get('SELECT 1 x FROM impact_seen WHERE key=?', key);
const markSeen = (key: string) => void run('INSERT OR IGNORE INTO impact_seen (key, at) VALUES (?,?)', key, now());
// A person who signs is known by their address. One who has none (the sender passed the link on) is known only as
// this one place on this one document.
const signerKey = (r: any) => `s:${personOf(r) || `${r.id}:${genOf(r)}`}`;
// The same person's first signature that plants anything, when an earlier one of theirs planted none.
const paidKey = (r: any) => `p:${personOf(r) || `${r.id}:${genOf(r)}`}`;

/**
 * The finished screen of a person who signs: what this signature funds, whether it is their first on this server,
 * whether the first-time picture is still to be shown, and what all their signatures plant together. Null for
 * anyone who does not sign, or has not finished.
 */
export function signerMoment(e: any, r: any): (SignerFacts & { celebrate: boolean }) | null {
  if (!signs(r) || r.status !== 'completed') return null;
  noteSigned(r);
  const mine = get('SELECT * FROM impact_signed WHERE recipient_id=? AND gen=?', r.id, genOf(r));
  if (!mine) return null;
  const who = personOf(r);
  // An earlier finished signature from the same address: one we wrote down (it stays when its envelope is deleted),
  // or one from before this was counted, which is still on its envelope. Signatures made in person are not looked at:
  // the address on those is the host's, not the signer's.
  const earlier = !!who && (
    !!get('SELECT 1 x FROM impact_signed WHERE who=? AND NOT (recipient_id=? AND gen=?) AND at <= ?', who, r.id, genOf(r), mine.at)
    || !!get("SELECT 1 x FROM recipients WHERE lower(email)=lower(?) AND id<>? AND status='completed' AND role='signer' AND completed_at <= ?", String(r.email).trim(), r.id, mine.at));
  const rows = who ? all('SELECT * FROM impact_signed WHERE who=? ORDER BY at DESC', who) : [mine];
  const trees = standing(mine);
  const total = Math.max(trees, sumStanding(rows));
  // The picture: the first time a person signs here, and once more the first time a signature of theirs plants
  // anything (someone whose first planted none has not seen the seedlings yet). "More" is never said from here: the
  // words say it only when the total is above what this signature funds.
  const firstPaid = trees > 0 && total === trees;
  return {
    trees,
    first: !earlier,
    celebrate: (!earlier && !seen(signerKey(r))) || (firstPaid && !seen(paidKey(r))),
    total,
    sheets: Number(e?.sheets) || 0,
    // A sender who signed their own document where plans exist: it used no signature and plants none, and is told so.
    ...(trees < 1 && creditsEnabled() && !counts(r) ? { own: true } : {}),
  };
}

/**
 * The one number the signing page gets with its first answer, so the tree line is on the first screen without a
 * second question: trees that will be planted when this person finishes, or, once they have, the trees of their
 * signature. 0 for anyone who does not sign and on an envelope that was cancelled, declined or has expired.
 */
export function treesShownTo(e: any, r: any): number {
  if (!e || !signs(r) || ['voided', 'expired', 'declined'].includes(e.status)) return 0;
  return r.status === 'completed' ? signerMoment(e, r)?.trees ?? 0 : treesAtFinish(r);
}

/** The first-time picture was drawn for this person: it is not shown again. */
export function signerSaw(r: any): void {
  if (!signs(r) || r.status !== 'completed') return;
  markSeen(signerKey(r));
  // Seedlings were only drawn if this signature plants trees: only then is the planting picture used up.
  const mine = get('SELECT * FROM impact_signed WHERE recipient_id=? AND gen=?', r.id, genOf(r));
  if (mine && standing(mine) > 0) markSeen(paidKey(r));
}

// How long after sending the first-time picture is still offered. Someone who opens their first envelope a week
// later is not congratulated on having just sent it.
const FRESH_MS = 60 * 60 * 1000;

/**
 * The envelope page of a sent envelope: how many of its people sign, how many of their signatures count (everyone
 * but a sender signing their own document), and whether this is the first thing the account ever sent, seen by the person who sent it within the hour.
 */
export function senderMoment(e: any, userId: string): (SenderFacts & { here: number; celebrate: boolean }) | null {
  if (!e || e.kind !== 'envelope' || !e.sent_at) return null;
  const people = (e.recipients || []).filter(signs);
  const sender = get('SELECT email, name FROM users WHERE id=?', e.sender_id);
  const counted = people.filter((r: any) => counts(r, sender)).length;
  const first = !get("SELECT 1 x FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at IS NOT NULL AND id<>? AND sent_at <= ?", e.account_id, e.id, e.sent_at);
  const fresh = Date.now() - new Date(e.sent_at).getTime() < FRESH_MS;
  return {
    counted,
    // Everyone who signs, the sender included: "every signature" is said only when every one of them counts, and a
    // sender signing their own document uses no signature and plants nothing.
    signers: people.length,
    planted: treesOfAccount(e.account_id),
    here: treesOnEnvelope(e.id),
    sheets: Number(e.sheets) || 0,
    celebrate: first && fresh && e.sender_id === userId && !['voided', 'declined', 'expired'].includes(e.status) && !seen(`a:${e.account_id}`),
  };
}

export const senderSaw = (accountId: string) => markSeen(`a:${accountId}`);

/**
 * Before sending: does every signature of this draft count? True when everyone who signs has an address and none of
 * them is the sender signing their own document. Then the review step says that 5 trees are planted for each person
 * who signs; anything short of "all of them" says nothing.
 */
export function allCountForecast(e: any): boolean {
  if (!creditsEnabled() || !e || e.kind !== 'envelope') return false;
  const sender = get('SELECT email, name FROM users WHERE id=?', e.sender_id);
  const people = (e.recipients || []).filter(signs);
  return people.length > 0 && people.every((r: any) => String(r.email || '').trim() && (!sender || isChargeable(r, sender)));
}

/** 'Trees on the signing record': on unless an admin switched it off for the account (Settings, Account). */
// Never under DEPLOYMENT_PROFILE=government, whatever the account chose. The rule is read in one place,
// src/server/tenantpolicy.ts, and this is the same function under the name pdf.ts and routes-impact.ts know.
export { recordShowsTrees } from './tenantpolicy.ts';
