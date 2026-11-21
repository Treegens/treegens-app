// Trees, as the server knows them. Everything here is a claim somebody will read, so it is decided here and nowhere
// else: whether a signature was paid for (and so funds 10 mangroves), whether this is the first time a person signs
// or an account sends, and the counts. The pages only draw what these functions return (src/lib/impactwords.ts has
// the words).
//
// What is counted: one row in impact_signed for every finished signature of a person who signs (role signer, or a
// signer in person). An approver, a viewer, a copy and a witness plant nothing and are told nothing. The row says 10
// when paidSignatureFor (credits.ts) says the signature came out of a payment that still stands, and 0 for a free one:
// the trial, a free code, a sender signing their own document, or a server that takes no payments at all. While the
// signature can still be asked about, it is asked again each time, so a payment that went back later no longer counts.
import { get, all, run } from './db.ts';
import { hmac, now } from './util.ts';
import { paidSignatureFor, paidForecast, creditsEnabled, isChargeable } from './credits.ts';
import { TREES_PER_SIGNATURE, type SignerFacts, type SenderFacts } from '../lib/impactwords.ts';
import { isGovernment } from '../lib/deployment.ts';

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
 * Mangroves that will be planted when this person finishes: 10 for someone who signs and whose signature is held from
 * a payment that stands, 0 for everyone else. This is the line next to Finish and the line in the email.
 */
export function treesAtFinish(r: any): number {
  if (!signs(r) || (r.status !== 'sent' && r.status !== 'viewed')) return 0;
  return paidSignatureFor(r.id) ? TREES_PER_SIGNATURE : 0;
}

/**
 * The same, for the email that asks someone to sign. The email is written a moment after the person's turn began,
 * from a copy of their row that may still say "pending", so the row's status is not asked here: only whether a paid
 * signature is held for them. Nobody who has finished, and nobody who does not sign, gets the line.
 */
export const treesInInvite = (r: any): number => (signs(r) && r.status !== 'completed' && paidSignatureFor(r.id) ? TREES_PER_SIGNATURE : 0);

/** Writes down a finished signature once. Safe to call any number of times, from any path that finishes one. */
export function noteSigned(r: any): void {
  if (!r || !signs(r) || r.status !== 'completed') return;
  const e = get('SELECT account_id FROM envelopes WHERE id=?', r.envelope_id);
  run('INSERT OR IGNORE INTO impact_signed (recipient_id, gen, envelope_id, account_id, who, trees, at) VALUES (?,?,?,?,?,?,?)',
    r.id, genOf(r), r.envelope_id, e?.account_id || null, personOf(r), paidSignatureFor(r.id) ? TREES_PER_SIGNATURE : 0, r.completed_at || now());
}

/**
 * Called by Finish itself (completeRecipient in envelopes.ts), so a paid signature is counted whether or not anyone
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

// What a row counts for today. While its signature can still be asked about (the recipient is there and is the same
// person), the payment is asked again; after that the row stands as it was written.
function standing(row: any): number {
  if (!row.trees) return 0;
  const r = get('SELECT id, person_gen FROM recipients WHERE id=?', row.recipient_id);
  if (!r || genOf(r) !== Number(row.gen)) return row.trees;
  return paidSignatureFor(r.id) ? row.trees : 0;
}
// The newest rows are asked again one by one; a long history beyond that is taken as written.
const RECHECK = 300;
const sumStanding = (rows: any[]) => rows.reduce((s, row, i) => s + (i < RECHECK ? standing(row) : Number(row.trees) || 0), 0);

/** Mangroves funded by the paid signatures finished on one envelope. */
export function treesOnEnvelope(envelopeId: string): number {
  noteEnvelope(envelopeId);
  return sumStanding(all('SELECT * FROM impact_signed WHERE envelope_id=? ORDER BY at DESC', envelopeId));
}

/** Mangroves funded by the paid signatures finished on an account's documents. */
export function treesOfAccount(accountId: string): number {
  return sumStanding(all('SELECT * FROM impact_signed WHERE account_id=? ORDER BY at DESC', accountId));
}

const seen = (key: string) => !!get('SELECT 1 x FROM impact_seen WHERE key=?', key);
const markSeen = (key: string) => void run('INSERT OR IGNORE INTO impact_seen (key, at) VALUES (?,?)', key, now());
// A person who signs is known by their address. One who has none (the sender passed the link on) is known only as
// this one place on this one document.
const signerKey = (r: any) => `s:${personOf(r) || `${r.id}:${genOf(r)}`}`;
// The same person's first signature that plants anything, when an earlier one of theirs was free.
const paidKey = (r: any) => `p:${personOf(r) || `${r.id}:${genOf(r)}`}`;

/**
 * The finished screen of a person who signs: what this signature funds, whether it is their first on this server,
 * whether the first-time picture is still to be shown, and what all their paid signatures fund together. Null for
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
  // anything (someone whose first was free has not seen the seedlings yet). "More" is never said from here: the
  // words say it only when the total is above what this signature funds.
  const firstPaid = trees > 0 && total === trees;
  return {
    trees,
    first: !earlier,
    celebrate: (!earlier && !seen(signerKey(r))) || (firstPaid && !seen(paidKey(r))),
    total,
    sheets: Number(e?.sheets) || 0,
  };
}

/** The first-time picture was drawn for this person: it is not shown again. */
export function signerSaw(r: any): void {
  if (!signs(r) || r.status !== 'completed') return;
  markSeen(signerKey(r));
  // Seedlings were only drawn if this signature was paid for: only then is the planting picture used up.
  const mine = get('SELECT * FROM impact_signed WHERE recipient_id=? AND gen=?', r.id, genOf(r));
  if (mine && standing(mine) > 0) markSeen(paidKey(r));
}

// How long after sending the first-time picture is still offered. Someone who opens their first envelope a week
// later is not congratulated on having just sent it.
const FRESH_MS = 60 * 60 * 1000;

/**
 * The envelope page of a sent envelope: how many of its people sign, for how many of them a paid signature is held
 * or was used (as far as it is known today: someone later in a signing order has none held yet), and whether this
 * is the first thing the account ever sent, seen by the person who sent it within the hour.
 */
export function senderMoment(e: any, userId: string): (SenderFacts & { celebrate: boolean }) | null {
  if (!e || e.kind !== 'envelope' || !e.sent_at) return null;
  const people = (e.recipients || []).filter(signs);
  const paid = people.filter((r: any) => paidSignatureFor(r.id)).length;
  const first = !get("SELECT 1 x FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at IS NOT NULL AND id<>? AND sent_at <= ?", e.account_id, e.id, e.sent_at);
  const fresh = Date.now() - new Date(e.sent_at).getTime() < FRESH_MS;
  return {
    paid,
    // Everyone who signs, the sender included: "every signature" is said only when every one of them is paid for,
    // and a sender signing their own document uses no signature and plants nothing.
    signers: people.length,
    planted: treesOfAccount(e.account_id),
    sheets: Number(e.sheets) || 0,
    celebrate: first && fresh && e.sender_id === userId && !['voided', 'declined', 'expired'].includes(e.status) && !seen(`a:${e.account_id}`),
  };
}

export const senderSaw = (accountId: string) => markSeen(`a:${accountId}`);

/**
 * Before sending: would every signature of this draft come out of a payment that stands? The order signatures are
 * used in is one rule in one place (paidForecast in credits.ts). It is a forecast, used only to decide whether the review
 * step may say that each person who signs plants 10 mangroves; anything short of "all of them" says nothing.
 */
export function allPaidForecast(e: any): boolean {
  if (!creditsEnabled() || !e || e.kind !== 'envelope') return false;
  const sender = get('SELECT email, name FROM users WHERE id=?', e.sender_id);
  const need = (e.recipients || []).filter((r: any) => signs(r) && String(r.email || '').trim() && (!sender || isChargeable(r, sender))).length;
  if (!need || need !== (e.recipients || []).filter(signs).length) return false;
  return paidForecast(e.account_id, need);
}

/** 'Trees on the signing record': on unless an admin switched it off for the account (Settings, Account). */
// Never under DEPLOYMENT_PROFILE=government, whatever the account chose (src/lib/deployment.ts).
export const recordShowsTrees = (accountId: string): boolean => !isGovernment() && !get('SELECT cert_impact_off x FROM accounts WHERE id=?', accountId)?.x;
