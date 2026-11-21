import { all, get, run } from './db.ts';
import { bad, str, isEmail, token, checkCode, hmac, now } from './util.ts';
import { cookie, readCookie } from './auth.ts';
import { sendMail } from './mail.ts';
import { sameEmail } from './credits.ts';
import { senderZone } from './pdf.ts';
import { passCheckOn } from './signercode.ts';
import { audit, notifySender, senderOf, signUrl, retireToken, samePerson, yesNo, emailRefusal, noteReached, newerVersion, clearAnswers, advance, notOpen, type Actor } from './envelopes.ts';
import { labelOf } from '../lib/bysender.ts';
import { formatDate, validZone, stampText } from '../lib/dates.ts';
import { isWitness, waitsForName, openWitnessName, statementText, marksOf, MARK_WORDS, WHO_MAY_WITNESS, WITNESS_RECORDS, WITNESS_NAMES_MAX, WITNESS_CERT_NOTE, sameDevice, SAME_DEVICE_LIMITS, sameName, PARTY_ROLES } from '../lib/witness.ts';
import { witnessProblem as sharedProblem } from '../lib/witness.ts';

// A witness for one signer (role "witness", recipients.witness_for). The rules and words are in src/lib/witness.ts.
// envelopes.ts, routes-sign.ts and pdf.ts call in here at the places where a witness differs from anyone else:
//   - saving: which signer they witness, and whether that signer names them (named_by_signer)
//   - routing: a witness is asked straight after their signer has signed, and holds nobody up in the signing order
//   - money: none. isChargeable in credits.ts counts only "signer" and "inperson", so a witness never holds or uses
//     a signature, and the ledger is never asked about one
//   - the signer's Finish: an unnamed witness has to be named first; the witness's Finish: their statement first
//   - after the witness's Finish: the same address or the same device as the signer is marked, and the sender told
// Nothing in here calls into envelopes.ts while this module is being loaded, which is what lets the two use each other.

const SYSTEM: Actor = { name: 'System' };
/** The cookie that tells whether a witness finished in the same browser as the person they witnessed. */
const DEVICE_COOKIE = 'ts_dev';

/**
 * The rules of src/lib/witness.ts, and on the server the looser reading of a name that a person would make (another
 * spelling, an initial, a middle name: samePerson). One check for sending, the editor's save of an envelope that is
 * out, a correction and a hand-over. The editor shows the strict part before Send.
 */
export function witnessProblem(r: any, e: any): string | null {
  const said = sharedProblem(r, e);
  if (said || !isWitness(r) || waitsForName(r)) return said;
  const name = String(r.name || '').trim() || 'A witness';
  const target = (e?.recipients || []).find((x: any) => x.id === r.witness_for);
  if (target && sameEmail(r.email, target.email) && samePerson(r.name, target.name)) return `${name} would be the witness of their own signature (the same address, and the same name in another spelling). A witness has to be somebody else.`;
  const party = (e?.recipients || []).find((x: any) => x.id !== r.id && x.id !== target?.id && !isWitness(x) && PARTY_ROLES.includes(x.role) && sameEmail(x.email, r.email) && samePerson(x.name, r.name));
  if (party) return `${name} is the witness for ${target?.name || 'the signer'} and is also on this document as ${party.name}, who ${party.role === 'approver' ? 'approves' : 'signs'} it, so they are a party to it, and a witness should not be. Name somebody else as the witness.`;
  return null;
}

/**
 * POST /envelopes/:id/correct and a signer passing the document on (correctRecipient and reassignRecipient in
 * envelopes.ts): the same rules as sending, for the envelope as it will be after the change, so neither can make a
 * witness who is the signer, or a party. Only a problem this change makes is refused: an envelope that went out under
 * older rules can still be put right. `passing` is the signer handing it on, who is told in words meant for them.
 */
export function assertWitnessesAfter(e: any, r: any, name: string, email: string, passing = false) {
  const after = { ...e, recipients: e.recipients.map((x: any) => (x.id === r.id ? { ...x, name, email } : x)) };
  for (const w of after.recipients.filter(isWitness)) {
    // A witness the person passing it on had named goes with them (forgetNamedWitness), so there is nothing to check.
    if (passing && w.witness_for === r.id && w.status === 'pending' && w.signer_named_at) continue;
    // A witness that already broke a rule before this change (sent before the rule existed) is not held to it here:
    // its words would differ with any change of name, and refusing would stop the sender putting anything right.
    const is = witnessProblem(w, after);
    if (!is || witnessProblem(e.recipients.find((x: any) => x.id === w.id), e)) continue;
    const sender = senderOf(e);
    throw bad(passing ? `This document cannot be passed on to ${name}: ${name} is on it as a witness, and a witness cannot also sign it. Pass it on to someone else, or ask ${sender?.name || 'the sender'}${sender?.email ? ` (${sender.email})` : ''} to change who is on it. Nothing was changed.` : `${is} Nothing was changed.`);
  }
}

/** A role of a template that a bulk row or a form's visitor fills in: no address yet, and nobody else names them. */
export const rowFills = (r: any): boolean => !r.email && !r.group_name && !(isWitness(r) && r.named_by_signer);

/** The witness of this signer, if they have one. */
export const witnessOf = (e: any, signer: any): any => (e?.recipients || []).find((x: any) => isWitness(x) && x.witness_for === signer?.id) || null;
/** The person this witness is there for. */
export const signerOf = (e: any, w: any): any => (e?.recipients || []).find((x: any) => x.id === w?.witness_for) || null;

/** The date the witness says they saw it happen: the signer's own calendar day, in the envelope's date format. */
const signedOn = (e: any, s: any): string => (s?.completed_at ? formatDate(s.completed_at, e.date_format, validZone(s.tz) || senderZone(e)) : '');
/** The statement as it stands now, or '' while there is nothing to have seen yet (the signer has not signed). */
export const currentStatement = (e: any, w: any): string => {
  const s = signerOf(e, w);
  return s?.status === 'completed' ? statementText(s.name, signedOn(e, s)) : '';
};
// A statement is about one signature. When the signer signs again (after a change), the earlier statement saw a
// signature that no longer counts, so it no longer stands and the witness is asked again.
const statementStands = (e: any, w: any): boolean => {
  const s = signerOf(e, w);
  return !!w.witness_said_at && !!s?.completed_at && w.witness_saw === s.completed_at;
};

/**
 * The witnesses an envelope waits for although nobody has been asked: their signer has signed, and the witness said
 * "I was not there" or has not been named yet. In words for the sender's "expires soon" email (cronTick), which
 * otherwise lists only the people who have the document.
 */
export function witnessesWaiting(e: any): string[] {
  return (e?.recipients || []).filter((w: any) => isWitness(w) && w.status === 'pending' && signerOf(e, w)?.status === 'completed' && (w.witness_absent_at || waitsForName(w)))
    .map((w: any) => `a witness for ${signerOf(e, w).name} (${w.witness_absent_at ? `${w.name} said they were not there, and nobody else has been named` : 'not named yet'})`);
}

/** Is it this witness's turn: their signer has signed, they have a name and an address, and they did not say "not there". */
export function witnessDue(e: any, w: any): boolean {
  const s = signerOf(e, w);
  return s?.status === 'completed' && !waitsForName(w) && !w.witness_absent_at;
}

/**
 * Called by writeContent() in envelopes.ts once the recipients of a save are written, inside its transaction. Reads
 * "witness_for" (the id of the person they witness, as the request names that person) and "named_by_signer". Left out,
 * both stay as they were. What cannot work is said when the envelope is sent or corrected (witnessProblem), so a draft
 * can hold a half-made choice. A witness the signer names has no name or address of the sender's: on a draft one that
 * is sent anyway is refused out loud, never dropped. Taking the role away takes both with it.
 */
export function saveWitnesses(e: any, asked: { rid: string; r: any; i: number }[], before: Map<string, any>, correcting: boolean) {
  const ids = new Map<string, string>();
  for (const a of asked) {
    ids.set(a.rid, a.rid);
    if (a.r?.id != null && a.r.id !== '') ids.set(String(a.r.id), a.rid);
  }
  for (const { rid, r, i } of asked) {
    const old = before.get(rid);
    const saved = get('SELECT role, name, email FROM recipients WHERE id=?', rid);
    if (!saved) continue;
    if (saved.role !== 'witness') {
      if (old?.witness_for || old?.named_by_signer) run('UPDATE recipients SET witness_for=NULL, named_by_signer=0 WHERE id=?', rid);
      continue;
    }
    const whom = `Recipient ${i + 1}${r?.name ? ` (${str(r.name, 120)})` : ''}`;
    const given = r?.witness_for === undefined ? old?.witness_for : r.witness_for;
    if (given != null && typeof given === 'object') throw bad(`${whom}: "witness_for" has to be the id of the person they witness, written as text. Nothing was saved.`);
    // An id that names nobody in this request is kept as it was given, so the check before sending can say so.
    const target = given == null || given === '' ? null : ids.get(String(given)) ?? str(given, 80);
    const bySigner = r?.named_by_signer === undefined ? !!old?.named_by_signer : yesNo(r.named_by_signer, false, `"named_by_signer" of recipient ${i + 1}`);
    if (bySigner && !correcting && str(saved.email).trim())
      throw bad(`${whom} is a witness with "named_by_signer": true and also has an email address. Leave the name and the address out, and the person they witness names them on the signing page. Or leave "named_by_signer" out and name the witness yourself. Nothing was saved.`);
    const signer = target ? get('SELECT name FROM recipients WHERE id=? AND envelope_id=?', target, e.id) : null;
    const open = bySigner && !str(saved.email).trim();
    run(`UPDATE recipients SET witness_for=?, named_by_signer=?${open ? ', name=?' : ''} WHERE id=?`, target, bySigner ? 1 : 0, ...(open ? [openWitnessName(signer)] : []), rid);
    // Another person in the witness's place starts with nothing of the one before: no statement, no "not there", no
    // marks, and the sender's choice replaces a name the signer gave. A person the sender names on an envelope that is
    // out is the sender's choice from then on: the signer cannot replace them, unless the request says so.
    if (old && (!sameEmail(old.email, saved.email) || (old.name !== saved.name && !samePerson(old.name, saved.name))))
      run(`UPDATE recipients SET witness_absent_at=NULL, witness_said_at=NULL, witness_statement=NULL, witness_saw=NULL, witness_marks=NULL, signer_named_at=NULL, witness_chosen=NULL${correcting && str(saved.email).trim() && r?.named_by_signer !== true ? ', named_by_signer=0' : ''} WHERE id=?`, rid);
  }
}

/**
 * After a correction (correctEnvelope, next to settleGroups): a witness who had been asked although their signer is
 * waiting again (asked to sign again after a change) gives the turn back, and is asked again once that signer signed.
 */
export function settleWitnesses(envelopeId: string) {
  for (const w of all("SELECT w.id FROM recipients w JOIN recipients s ON s.id=w.witness_for WHERE w.envelope_id=? AND w.role='witness' AND w.status IN ('sent','viewed') AND s.status!='completed'", envelopeId))
    run("UPDATE recipients SET status='pending', sent_at=NULL, unopened_alerted_at=NULL WHERE id=?", w.id);
}

const at = (s: any) => stampText(s);

/**
 * correctEnvelope() in envelopes.ts: who has to sign again. A witness's statement belongs to one signature. When that
 * signature is set aside (its signer is asked to sign again, or their place goes to another person), or the witness is
 * moved to witness somebody else, the witness who finished goes with it: what they saw no longer stands, so the
 * certificate cannot print it under a signature they never saw, and moving them needs the same "resign" choice.
 */
export function withWitnesses(done: any[], again: any[], nowById: Map<string, any>): any[] {
  const ids = new Set(again.map((o) => o.id));
  for (const w of done) if (isWitness(w) && (ids.has(w.witness_for) || nowById.get(w.id)?.witness_for !== w.witness_for)) ids.add(w.id);
  return done.filter((o) => ids.has(o.id));
}

/** The witnesses who finished witnessing this person, by name: they are asked again with them (writeContent). */
export const witnessedBy = (e: any, o: any): string[] => (e?.recipients || []).filter((w: any) => isWitness(w) && w.witness_for === o?.id && w.status === 'completed').map((w: any) => w.name);

/** describeCorrection() in envelopes.ts: a witness who now witnesses another person, in words for the record. */
export function witnessBits(o: any, r: any, before: Map<string, any>, after: Map<string, any>): string[] {
  if (!isWitness(o) || !isWitness(r) || (o.witness_for || null) === (r.witness_for || null)) return [];
  const was = o.witness_for ? before.get(o.witness_for)?.name : null, is = r.witness_for ? after.get(r.witness_for)?.name : null;
  return [`now the witness for ${is || 'nobody yet'}${o.witness_for ? `, no longer for ${was || 'someone who is no longer on the document'}` : ''}`];
}

/**
 * correctEnvelope(), right after the earlier signatures are set aside: each witness among them loses their statement
 * too (it is written to the audit trail here, word for word), and is asked again once their signer has signed.
 */
export function witnessesSetAside(e: any, again: any[], nowById: Map<string, any>, actor: Actor) {
  for (const w of again) {
    const n = nowById.get(w.id);
    if (!isWitness(w) || !n) continue;
    const saw = signerOf(e, w), next = nowById.get(n.witness_for);
    run('UPDATE recipients SET witness_said_at=NULL, witness_statement=NULL, witness_saw=NULL, witness_marks=NULL, device_hash=NULL WHERE id=?', w.id);
    audit(e.id, actor, 'Witness statement set aside', `${labelOf(w)} had stated${w.witness_said_at ? ` on ${at(w.witness_said_at)}` : ''}: "${w.witness_statement || statementText(saw?.name || 'the signer', signedOn(e, saw))}" That was about the signature ${saw?.name || 'the signer'} made on ${at(saw?.completed_at)}, which no longer counts after this change, so the statement no longer counts either. It is kept on record here. ${n.name} is asked to witness again once ${next?.name || 'the person they witness'} has signed${next && saw && next.id === saw.id && next.name === saw.name ? ' again' : ''}.`);
  }
}

/** After POST /envelopes/:id/correct: a witness who is now another person starts clean, and is asked if it is their turn. */
export async function witnessCorrected(envelopeId: string, recipientId: string, before: any) {
  const w = get('SELECT * FROM recipients WHERE id=? AND envelope_id=?', recipientId, envelopeId);
  if (!w || !isWitness(w) || !before) return;
  if (!sameEmail(before.email, w.email) || (before.name !== w.name && !samePerson(before.name, w.name))) {
    // The person the sender puts in the place is the sender's choice: the signer cannot replace them from their link
    // (only after that person, too, says they were not there).
    run('UPDATE recipients SET witness_absent_at=NULL, witness_said_at=NULL, witness_statement=NULL, witness_saw=NULL, witness_marks=NULL, signer_named_at=NULL, witness_chosen=NULL, named_by_signer=0 WHERE id=?', w.id);
    await advance(envelopeId);
  }
}

/** The witness the sender chose, kept while the signer's choice is in the place (witness_chosen), or null. */
const chosenOf = (w: any): { name: string; email: string } | null => {
  try {
    const c = w?.witness_chosen ? JSON.parse(w.witness_chosen) : null;
    return c && typeof c.name === 'string' && typeof c.email === 'string' ? c : null;
  } catch {
    return null;
  }
};

/**
 * copyEnvelope(): a witness stays the witness of the same person in the copy. One the signer named is named afresh.
 * Where the sender chose the witness and the signer named another after "I was not there", the copy has the sender's
 * own choice again: the copy is the sender's, and the signer's choice was for that one signing.
 */
export function copyWitnesses(src: any, rmap: Map<string, string>) {
  for (const r of src.recipients.filter(isWitness)) {
    const to = rmap.get(r.id);
    const target = r.witness_for ? rmap.get(r.witness_for) ?? null : null;
    if (!to) continue;
    run('UPDATE recipients SET witness_for=?, named_by_signer=? WHERE id=?', target, r.named_by_signer ? 1 : 0, to);
    const chosen = !r.named_by_signer ? chosenOf(r) : null;
    if (chosen) run('UPDATE recipients SET name=?, email=? WHERE id=?', chosen.name, chosen.email, to);
    if (r.named_by_signer) run("UPDATE recipients SET name=?, email='' WHERE id=?", openWitnessName(target ? get('SELECT name FROM recipients WHERE id=?', target) : null), to);
  }
}

/**
 * clearAnswers() in envelopes.ts: the request of this signer passes to another person. A witness the first person named
 * and who has not been asked yet is theirs, like what they typed, and the next person names their own. A witness the
 * sender chose stays.
 */
export function forgetNamedWitness(signerId: string) {
  for (const w of all("SELECT * FROM recipients WHERE witness_for=? AND role='witness' AND status='pending' AND signer_named_at IS NOT NULL", signerId)) {
    if (w.sent_at || w.witness_absent_at) retireToken(w, 'removed');
    const s = get('SELECT name FROM recipients WHERE id=?', signerId);
    // In a place the sender filled, the sender's own choice comes back. Otherwise the new person names their own.
    const chosen = !w.named_by_signer ? chosenOf(w) : null;
    run("UPDATE recipients SET name=?, email=?, token=?, check_code=?, sent_at=NULL, viewed_at=NULL, consent_at=NULL, tz=NULL, reminder_held_at=NULL, witness_absent_at=NULL, witness_said_at=NULL, witness_statement=NULL, witness_saw=NULL, witness_marks=NULL, signer_named_at=NULL, witness_chosen=NULL, named_by_signer=?, person_gen=COALESCE(person_gen,0)+1 WHERE id=?",
      chosen ? chosen.name : openWitnessName(s), chosen ? chosen.email : '', token(), checkCode(), chosen ? 0 : 1, w.id);
    audit(w.envelope_id, SYSTEM, 'Witness cleared', `${labelOf(w)} had been named as the witness by the person whose place on the document went to ${s?.name || 'someone else'}. ${chosen ? `The witness is ${chosen.name} <${chosen.email}> again, whom the sender had chosen.` : `${s?.name || 'The new person'} names their own witness.`}`);
  }
}

/**
 * newerVersion() in envelopes.ts, after any change made outside the editor (a hand-over, a correction, a signer fixing
 * their name): a witness still to be named is called after the signer as the signer is named now.
 */
export function openNames(envelopeId: string) {
  for (const w of all("SELECT w.id, w.name, s.name signer FROM recipients w JOIN recipients s ON s.id=w.witness_for WHERE w.envelope_id=? AND w.role='witness' AND w.email=''", envelopeId))
    if (w.name !== openWitnessName({ name: w.signer })) run('UPDATE recipients SET name=? WHERE id=?', openWitnessName({ name: w.signer }), w.id);
}

// ---- The signing page ------------------------------------------------------------------------------------------

type WitnessState = 'open' | 'waiting' | 'asked' | 'absent' | 'done';
const stateOf = (e: any, w: any): WitnessState => (w.status === 'completed' ? 'done' : w.witness_absent_at ? 'absent' : waitsForName(w) ? 'open' : w.status === 'sent' || w.status === 'viewed' ? 'asked' : 'waiting');

/**
 * May this signer name their witness now? Where the sender left it to them: before they finish. Wherever the witness
 * said "I was not there", also one the sender chose: until somebody else has been asked. That right belongs to the
 * "not there" and ends with it: a person the sender puts in the place afterwards is the sender's choice again.
 */
const signerMayName = (w: any): boolean => !!w.named_by_signer || !!w.witness_absent_at;
function mayName(e: any, s: any, w: any): boolean {
  if (e.status !== 'sent' || !signerMayName(w) || w.status !== 'pending' || (Number(w.witness_names) || 0) >= WITNESS_NAMES_MAX) return false;
  return s.status === 'sent' || s.status === 'viewed' || (s.status === 'completed' && (waitsForName(w) || !!w.witness_absent_at));
}

/**
 * What GET /sign/:token says about a witness, behind the access code like everything else about the document. To a
 * signer who has one: who, in which state, and whether they name them. To a witness: whose signature, the statement
 * as they would tick it, whether they did, and whether they said they were not there.
 */
export function witnessFacts(e: any, r: any): Record<string, any> {
  if (isWitness(r)) {
    const s = signerOf(e, r);
    return { witness_of: s ? { name: s.name, signed: s.status === 'completed', statement: currentStatement(e, r) || null, said: statementStands(e, r), said_at: statementStands(e, r) ? r.witness_said_at : null, absent_at: r.witness_absent_at || null, sender_named: !r.signer_named_at, signer_told: signerTold(s) } : null };
  }
  const w = witnessOf(e, r);
  if (!w) return {};
  const open = waitsForName(w);
  return { witness: { id: w.id, name: open ? null : w.name, email: open ? null : w.email, state: stateOf(e, w), named_by_signer: !!w.named_by_signer, may_name: mayName(e, r, w), absent_name: w.witness_absent_at ? w.name : null, done_at: w.completed_at || null } };
}

/** The signer names their witness (POST /sign/:token/witness). Returns what the page shows next. */
export async function nameWitness(e: any, s: any, body: any, actor: Actor) {
  if (isWitness(s)) throw bad('This link is for the witness. Only the person who signs can name a witness.');
  const w = witnessOf(e, s);
  const sender = senderOf(e);
  const from = sender?.name || 'the sender';
  if (!w) throw bad('Nobody witnesses your signature on this document, so there is no witness to name. Nothing was changed.');
  if (e.status !== 'sent') throw notOpen(e, s);
  if (!signerMayName(w)) throw bad(`${from} chose your witness: ${w.name}. To have someone else, ask ${from}${sender?.email ? ` (${sender.email})` : ''}. Nothing was changed.`, 409);
  if ((Number(w.witness_names) || 0) >= WITNESS_NAMES_MAX) throw bad(`A witness has been named ${WITNESS_NAMES_MAX} times for your signature on this document, which is as many times as it can be done here. Ask ${from}${sender?.email ? ` (${sender.email})` : ''} to change the witness for you. Nothing was changed.`, 429);
  if (!mayName(e, s, w)) throw bad(`${w.name} has already been asked to witness your signature, so the witness can no longer be changed here. If that is wrong, ask ${from}${sender?.email ? ` (${sender.email})` : ''}. Nothing was changed.`, 409);
  // Characters nobody sees have no place in a name on a certificate, as in "Fix my name".
  const name = str(body?.name, 120).replace(/[\p{Cc}​-‏‪-‮⁠-⁩﻿]/gu, ' ').trim().replace(/\s+/g, ' ');
  const email = str(body?.email, 254).trim();
  if (name.length < 2 || !isEmail(email)) throw bad('Type the full name and the email address of your witness. Nothing was changed.');
  // A witness has to be somebody else, and not a party to the document: the paragraph on the screen says so, and
  // these are the cases software can see for itself. The same address as the signer is allowed (a household shares
  // one) and marked on the certificate when the witness finishes.
  if (samePerson(name, s.name) && (sameEmail(email, s.email) || sameName(name, s.name))) throw bad('That is your own name. A witness has to be somebody else, who is with you and watches you sign. Nothing was changed.');
  const party = e.recipients.find((x: any) => x.id !== w.id && x.id !== s.id && !isWitness(x) && PARTY_ROLES.includes(x.role) && sameEmail(x.email, email) && samePerson(x.name, name));
  if (party) throw bad(`${party.name} is on this document as a person who ${party.role === 'approver' ? 'approves' : 'signs'} it, so they are a party to it, and a witness should not be. Name someone else. Nothing was changed.`);
  if (sameEmail(email, w.email) && w.name === name && !w.witness_absent_at) return witnessFacts(e, s);
  // A witness is a new person emailed in the sender's name: not while paused, read by the fake-notice filter, and
  // counted towards the daily limit like a person passed a document. For a visitor of a public form it counts
  // against that form's own limit, like the visitor's own address. The signer is not told the sender's business.
  // The name they type is read with the rest: it is the heading of emails in the sender's name and to the sender.
  const viaForm = !!e.powerform_id && e.form_recipient_id === s.id;
  if (viaForm ? emailRefusal(e, [], { visitor: email, extra: [name] }) : emailRefusal(e, [email], { extra: [name] }))
    throw bad(`We cannot email a witness for this document right now. Reply to the email you got and ask ${from} to add your witness. Nothing was changed.`, 403);
  const before = { ...w };
  const known = !waitsForName(w);
  // The person in a place the sender filled is the sender's choice: kept, so a copy or a hand-over can go back to it.
  const senders = known && !w.named_by_signer && !w.signer_named_at;
  // A link a witness before was emailed stops working: their part is over.
  if (known && (w.sent_at || w.witness_absent_at)) retireToken(w, 'removed');
  clearAnswers(w.id);
  // A time zone is the person's own (it decides their date and certificate times): the witness named now reports theirs.
  run(`UPDATE recipients SET name=?, email=?, token=?, check_code=?, status='pending', sent_at=NULL, viewed_at=NULL, consent_at=NULL, muted=0, unopened_alerted_at=NULL, dead_link_alerted_at=NULL, tz=NULL, reminder_held_at=NULL,
      witness_absent_at=NULL, witness_said_at=NULL, witness_statement=NULL, witness_saw=NULL, witness_marks=NULL, signer_named_at=?, witness_names=COALESCE(witness_names,0)+1,
      person_gen=COALESCE(person_gen,0)+?${senders ? ', witness_chosen=?' : ''} WHERE id=?`, name, email, token(), checkCode(), now(), known && !(sameEmail(before.email, email) && samePerson(before.name, name)) ? 1 : 0,
    ...(senders ? [JSON.stringify({ name: before.name, email: before.email })] : []), w.id);
  noteReached(e, [email], viaForm ? `form:${e.powerform_id}` : null);
  audit(e.id, actor, 'Witness named', `${labelOf(s)} named ${name} <${email}> as the witness for their signature${known ? `, in place of ${labelOf(before)}${before.witness_absent_at ? ', who said they were not there' : ''}` : ''}.`);
  newerVersion(e.id, actor, `named ${name} as their witness`);
  // A one-time code the sender asked for goes with the place, and a code the person before passed does not count.
  await passCheckOn(e, before, actor);
  // Whenever a witness who was there before is replaced, and always where it was the sender's choice, the sender hears.
  if (before.witness_absent_at || senders)
    await notifySender(e, 'always', `New witness named: ${e.subject}`, `${s.name} named ${name} as their witness`,
      [`${before.witness_absent_at ? `${before.name} said they were not there when ${s.name} signed. ` : ''}${s.name} has now named ${name} <${email}> as their witness instead${senders ? ` of ${before.name}, whom you had chosen` : ''}${s.status === 'completed' ? ', and we have emailed them' : ', and we email them straight after they sign'}.`, `If nobody else saw ${s.name} sign, a new witness cannot truthfully say they did. If you are not sure, void the envelope and send it again, so that ${s.name} signs with the witness there.`]);
  // Someone who has signed already: the witness is asked now. Before that, they are asked straight after Finish.
  if (s.status === 'completed') await advance(e.id);
  const fresh = get('SELECT * FROM recipients WHERE id=?', w.id);
  return witnessFacts({ ...e, recipients: e.recipients.map((x: any) => (x.id === w.id ? fresh : x)) }, s);
}

/** The witness ticks their statement (POST /sign/:token/witness-statement). `shown` is the text their screen showed. */
export function makeStatement(e: any, w: any, shown: any, actor: Actor) {
  if (!isWitness(w)) throw bad('Only a witness makes this statement.');
  if (e.status !== 'sent' || (w.status !== 'sent' && w.status !== 'viewed')) throw notOpen(e, w);
  const text = currentStatement(e, w);
  if (!text) throw bad('The person you witness has not signed yet, so there is nothing to confirm yet. We email you once they have.', 409);
  if (statementStands(e, w)) return { said: true, statement: w.witness_statement };
  // Only the words the screen showed are recorded, and only if they are still true: a signer who signed again since
  // has another date.
  if (str(shown, 600) !== text) throw bad('The statement on your screen is out of date. Read it again as it is now before you tick it.', 409, { code: 'changed', statement: text });
  const s = signerOf(e, w);
  run('UPDATE recipients SET witness_said_at=?, witness_statement=?, witness_saw=? WHERE id=?', now(), text, s.completed_at, w.id);
  audit(e.id, actor, 'Witness statement', `${labelOf(w)} ticked this statement as their own: "${text}" GrowSigning records the statement and cannot check it.`);
  return { said: true, statement: text };
}

/**
 * Whether "I was not there" reaches the signer by email: not someone who signed in person (the sender hosted that and
 * is told), not someone with no address (the sender passes their link on), not someone who stopped our emails, and
 * not an address the last email came back from. The witness's screen and the sender's email say it as it is.
 */
export const signerTold = (s: any): boolean => !!s && s.role !== 'inperson' && !!String(s.email || '').trim() && !s.complained_at && !s.bounced_at;

/** "I was not there" (POST /sign/:token/not-present). The document stays unwitnessed until another witness signs. */
export async function notPresent(e: any, w: any, note: any, actor: Actor) {
  if (!isWitness(w)) throw bad('Only a witness can say this. If you are not the right person to sign, use "Pass to someone else" or decline.');
  if (w.witness_absent_at) throw bad('You have already told us that you were not there. There is nothing more for you to do.', 409);
  if (e.status !== 'sent' || (w.status !== 'sent' && w.status !== 'viewed')) throw notOpen(e, w);
  const s = signerOf(e, w);
  const sender = senderOf(e);
  const said = str(note, 500).trim();
  // Whoever chose this witness, the signer may now name another (signerMayName). named_by_signer stays the sender's
  // choice: a copy of the envelope, or a witness the sender names next, is the sender's again.
  run("UPDATE recipients SET status='pending', witness_absent_at=?, witness_said_at=NULL, witness_statement=NULL, witness_saw=NULL WHERE id=?", now(), w.id);
  audit(e.id, actor, 'Witness was not there', `${labelOf(w)} said they were not physically present when ${s?.name} signed, so they did not witness it.${said ? ` They wrote: "${said}"` : ''} The document is not witnessed. ${s?.name} can name another witness, and the sender can change the witness.`);
  newerVersion(e.id, actor, 'said they were not there to witness it');
  // The signer is told on their own link, where they can name someone else. Someone who signed in person has no
  // email of their own here: the sender hosted that signing and is told below. What the witness wrote is a stranger's
  // words: it goes to the sender and the record, like a reason for declining, never into the signer's inbox.
  const told = signerTold(s);
  // An address the last email came back from is tried all the same, and the sender is not told it arrived.
  if (s && s.role !== 'inperson' && s.email && !s.complained_at)
    await sendMail({ to: s.email, recipientId: s.id, envelopeId: e.id, replyTo: sender?.email, fromName: sender?.name, code: s.check_code,
      subject: `Your witness was not there: ${e.subject}`, heading: `${w.name} said they did not see you sign`,
      lines: [`${w.name} said that they were not physically with you when you signed "${e.subject}", so they did not sign as your witness. Your own signature is kept, and the document is not witnessed yet.`,
        `If someone else was with you and watched you sign, open your link and name them as your witness. If nobody else saw you sign, ask ${sender?.name || 'the sender'} what to do: a witness has to see the signature being made, so you may have to sign again with a witness there.`,
        WHO_MAY_WITNESS, WITNESS_RECORDS],
      cta: { label: 'Name another witness', url: signUrl(s) } });
  // The sender reads what happened to the signer's email as it is, never "we told them" when we could not.
  const why = !s?.email ? 'we have no email address for them, because you send them their link yourself' : s.complained_at ? 'they marked an earlier email from this account as spam, so we do not email them' : 'the last email to them came back, so ours may not reach them either';
  await notifySender(e, 'always', `Witness was not there: ${e.subject}`, `${w.name} said they were not there when ${s?.name} signed`,
    [`${labelOf(w)} said they were not physically present when ${s?.name} signed "${e.subject}", so they did not witness it.${said ? ` They wrote: "${said}"` : ''} The document is not witnessed and cannot be completed until a witness has signed.`,
      `${s?.role === 'inperson' ? `${s?.name} signed in person on your device, so you can name another witness for them: open the envelope and choose Correct next to ${w.name}.` : told ? `We told ${s?.name}, who can name another witness from their signing link. You can also change the witness yourself: open the envelope and choose Correct next to ${w.name}.` : `We could not tell ${s?.name}: ${why}. Pass on their signing link yourself (they can name another witness there), or change the witness: open the envelope and choose Correct next to ${w.name}.`}`,
      `If nobody else saw ${s?.name} sign, a new witness cannot truthfully say they did. Then void the envelope and send it again, so that ${s?.name} signs with a witness there.`]);
  return { ok: true, signer_told: told };
}

/** Why a witness cannot decline the document or pass it on, and what they can do instead. */
export function witnessCannot(e: any, w: any, what: 'decline' | 'pass'): string {
  const s = signerOf(e, w);
  const who = s?.name || 'the person who signed';
  return `${what === 'decline' ? 'A witness cannot decline the document for the people who sign it' : 'A witness cannot pass this on to someone else: only a person who saw the signature being made can witness it'}. If you did not see ${who} sign, choose "I was not there". That tells ${signerTold(s) ? `${who} and the sender` : 'the sender'}, and ${who} can name the person who was there. Nothing was changed.`;
}

// ---- Finish --------------------------------------------------------------------------------------------------

// The browser a person finished in, kept as a keyed fingerprint of a cookie set on this site only, and only for the
// people this is about: a signer who has a witness, and the witness. The fingerprint is made for one envelope (its id
// is in the key), so the same browser on two envelopes, of one account or of two, gives two values nobody can link.
// It never leaves the server: publicEnvelope leaves it out, and the sender is shown only "same device: yes or no"
// (sameDevice in src/lib/witness.ts). Nothing else reads the cookie. /security says all of this (DEVICE_COOKIE_WORDS).
const deviceOf = (req: Request): string | null => {
  const v = readCookie(req, DEVICE_COOKIE);
  return v && /^[A-Za-z0-9_-]{20,64}$/.test(v) ? v : null;
};

/**
 * Asked by POST /sign/:token/complete before anything is signed. A signer whose witness they name has to have named
 * them, and a witness has to have ticked their statement. Notes the browser for the comparison after the witness signs.
 */
export function beforeFinish(c: { req: Request; cookies: string[]; secure: boolean }, e: any, r: any) {
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) return;
  const w = witnessOf(e, r);
  if (w && waitsForName(w)) throw bad('Name your witness before you finish: the person who is with you now and watches you sign. Their name and email address go in the box above Finish.', 400, { code: 'witness_needed' });
  if (isWitness(r) && !statementStands(e, r)) throw bad('Tick your statement first: that you were physically present and saw the person sign. If you were not there, say so instead.', 400, { code: 'statement_needed', statement: currentStatement(e, r) || null });
  if (!w && !isWitness(r)) return;
  let dev = deviceOf(c.req);
  // Only the signer's browser is given the cookie. The witness's is only read: if it has none, it is not the same.
  if (!dev && !isWitness(r)) {
    dev = token(24);
    c.cookies.push(cookie(DEVICE_COOKIE, dev, 400 * 86400, c.secure));
  }
  run('UPDATE recipients SET device_hash=? WHERE id=?', dev ? hmac(`device:${e.id}:${dev}`) : null, r.id);
}

/**
 * completeRecipient() in envelopes.ts, once a witness's Finish has been claimed and before the envelope can complete:
 * the same email address as the signer, the same browser, or the same internet address and browser are allowed, and
 * marked, because that is what a challenge to the document would look at. The sender is told when it happens.
 */
export async function witnessDone(e: any, w: any, actor: Actor) {
  if (!isWitness(w)) return;
  const me = get('SELECT * FROM recipients WHERE id=?', w.id);
  const s = signerOf(e, w);
  if (!me || !s) return;
  const marks: string[] = [];
  if (sameEmail(me.email, s.email)) marks.push('address');
  // The signer's own name (or a spelling of it) under another address: perhaps a namesake, perhaps the signer.
  else if (samePerson(me.name, s.name)) marks.push('name');
  if (me.device_hash && me.device_hash === s.device_hash) marks.push('device');
  else if (me.ip && me.ip === s.ip && me.user_agent && me.user_agent === s.user_agent) marks.push('network');
  run('UPDATE recipients SET witness_marks=? WHERE id=?', marks.join(',') || null, w.id);
  if (!marks.length) return;
  const words = marks.map((m) => MARK_WORDS[m]).join(' and the ');
  audit(e.id, SYSTEM, 'Witness marked', `${labelOf(me)} witnessed the signature of ${s.name} with the ${words}. That is allowed, and the certificate says so.`);
  await notifySender(e, 'always', `Check the witness: ${e.subject}`, `${me.name} witnessed ${s.name} with the ${words}`,
    [`${me.name} signed as the witness of ${s.name} with the ${words}${marks.includes('network') ? ' (the same internet address and the same kind of browser, which can also be two devices in one place)' : ''}. That is allowed, and the certificate of completion marks it, because it is the first thing someone who challenges the document would look at.${marks.includes('device') ? ` About the device: ${SAME_DEVICE_LIMITS}` : ''}`,
      `If ${me.name} was really with ${s.name}, there is nothing to do. If you have any doubt that a witness was there, ask them before you rely on the document. ${WITNESS_RECORDS}`]);
  void actor;
}

// ---- Emails to a witness (notifyRecipient in envelopes.ts) -------------------------------------------------------

/** The words after the sender's name in the heading: "Olga asked you to witness the signature of Ann Lee on". */
export const witnessVerb = (e: any, w: any): string => `asked you to witness the signature of ${signerOf(e, w)?.name || 'the signer'} on`;

/** The lines of a request to witness. Only for a witness, and only when they are asked to do something. */
export function witnessMailLines(e: any, w: any, kind: string, sender: any): string[] {
  if (!isWitness(w) || w.status === 'completed' || kind === 'resent') return [];
  const s = signerOf(e, w);
  const who = s?.name || 'the signer';
  return [w.signer_named_at ? `${who} has signed "${e.subject}" and named you as their witness.` : `${sender?.name || 'The sender'} named you as the witness for ${who}, who has signed "${e.subject}".`,
    `Open the link only if you were physically with ${who} and watched them sign. The page shows a statement that you were, for you to tick as your own if it is true, and then asks you to sign as witness. If you were not there, say so on the same page: nothing is signed then, and ${signerTold(s) ? `${who} and ${sender?.name || 'the sender'} are` : `${sender?.name || 'the sender'} is`} told.`,
    'Being a witness uses none of your money and needs no account.', WITNESS_RECORDS];
}

// ---- The certificate (pdf.ts) ----------------------------------------------------------------------------------

/** The recipients in the order the certificate lists them: each witness straight after the person they witnessed. */
export function witnessOrder(list: any[]): any[] {
  const witnesses = list.filter((r) => isWitness(r) && list.some((x) => x.id === r.witness_for));
  return list.filter((r) => !witnesses.includes(r)).flatMap((r) => [r, ...witnesses.filter((w) => w.witness_for === r.id)]);
}

/** The lines the certificate adds for a witness, under the signer they witnessed. [label, value] pairs. */
export function witnessCertLines(e: any, r: any, ts: (s: any) => string): [string, string][] {
  if (!isWitness(r)) {
    const w = witnessOf(e, r);
    return w && w.status === 'completed' ? [['Witnessed by', `${w.name}, listed next`]] : [];
  }
  const s = signerOf(e, r);
  const out: [string, string][] = [['Witness for', s ? s.name : 'a person no longer on the document']];
  if (r.witness_statement) out.push(['Their statement', `"${r.witness_statement}"`], ['Statement ticked', ts(r.witness_said_at)]);
  // The device is said as yes or no with what that can show, never as anything that could tell one browser from another.
  const marks = marksOf(r.witness_marks).filter((m) => m !== 'device');
  if (marks.length) out.push(['Marked', `${marks.map((m) => MARK_WORDS[m]).join('; ')}. Allowed, and marked because a challenge would look at it.`]);
  const same = sameDevice(r);
  if (same !== null) out.push(['Same device', `${same ? 'Yes' : 'No'}. ${SAME_DEVICE_LIMITS}`]);
  out.push(['Note', WITNESS_CERT_NOTE]);
  return out;
}
