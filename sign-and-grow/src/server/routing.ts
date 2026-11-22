// "Only when..." on the server (the rules and their words are in src/lib/routing.ts). A person on a document that
// is signed in order can be asked only when an answer of someone earlier in the order is the one the sender chose,
// or only when another person in the same step is not asked ("Manager A when Amount is more than 1000, otherwise
// Officer B"). The rule is checked when the sender saves (writeContent in envelopes.ts calls saveRules), and decided
// from what is stored when the person's step is reached (advance in envelopes.ts calls skipNotAsked). A person whose
// rule is not met is "Not asked": status 'skipped', not emailed, no link, no copy, nothing held for them (a held
// signature is only held for people who are pending, sent or viewed: HELD in credits.ts), and the record and the
// signing record say why. They are never shown as having signed, approved or seen anything.
import { all, get, run } from './db.ts';
import { bad, str, token, checkCode } from './util.ts';
import { audit } from './envelopes.ts';
import { nameOf } from './logic.ts';
import { CONDS, CONDS_FOR, NEEDS_VALUE, RULE_VALUE_MAX, COND_WORDS, readNumber } from '../lib/logic.ts';
import { onlyWhenOf, onlyWhenKey, isInstead, decide, notAskedWhy, hiddenWhy, condWords, TESTABLE, type AnswerRule, type OnlyWhen } from '../lib/routing.ts';
import { isHidden } from '../lib/fieldrules.ts';
import { sendMail } from './mail.ts';
import { senderOf } from './envelopes.ts';
import { groupPeople } from './groups.ts';

/** The status of a person whose rule was not met. */
export const NOT_ASKED = 'skipped';
export const notAsked = (r: any): boolean => r?.status === NOT_ASKED;

const fold = (s: any) => String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const nameOfPerson = (r: any) => String(r?.name || r?.role_name || r?.group_name || 'this person');

type Asked = { rid: string; r: any; i: number };
type Entry = { fid: string; f: any; rid: string | null; which: string };

/** loadEnvelope: each person's rule as an object (or null), never as the JSON text it is stored as. */
export function attachRules(e: any) {
  for (const r of e?.recipients || []) r.only_when = onlyWhenOf(r);
}

/**
 * Saves "only_when" of every person writeContent has just written, inside its transaction, once the fields are in,
 * so a refusal saves nothing. Left out of the request, a person keeps the rule they had; null takes it off. A rule
 * names a field by the id the request gave it, the id it is stored under, or its label when exactly one field that
 * can be asked about has it; "otherwise" names a person by the id the request gave them or their stored id.
 */
export function saveRules(e: any, asked: Asked[], entries: Entry[], oldRecs: Map<string, any>, correcting: boolean) {
  const env = get('SELECT ordered, kind FROM envelopes WHERE id=?', e.id);
  const people = all('SELECT * FROM recipients WHERE envelope_id=?', e.id);
  const byId = new Map<string, any>(people.map((p: any) => [p.id, p]));
  const fields = all('SELECT id, recipient_id, type, label, page, options FROM fields WHERE envelope_id=?', e.id);
  const fieldById = new Map<string, any>(fields.map((f: any) => [f.id, f]));
  const givenField = new Map<string, string>();
  for (const x of entries) if (x.f?.id != null && x.f.id !== '') givenField.set(String(x.f.id), x.fid);
  const givenPerson = new Map<string, string>();
  for (const a of asked) if (a.r?.id != null && a.r.id !== '') givenPerson.set(String(a.r.id), a.rid);
  const NO = 'Nothing was saved, because';

  // The rule each person has after this save, as the request put it (resolved below).
  const wanted = new Map<string, any>();
  for (const a of asked) {
    const raw = a.r && Object.prototype.hasOwnProperty.call(a.r, 'only_when') ? a.r.only_when : undefined;
    if (raw === undefined) {
      const old = oldRecs.get(a.rid);
      if (old?.only_when) wanted.set(a.rid, { kept: true, w: onlyWhenOf(old) });
      continue;
    }
    if (raw === null || raw === '' || raw === false) continue;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw bad(`${NO} "only_when" of ${nameOfPerson(byId.get(a.rid))} is not an object. Send {"field": "<field id or label>", "is": "more_than", "value": "1000"}, {"otherwise": "<person id>"}, or null for someone who is always asked.`);
    wanted.set(a.rid, { kept: false, w: raw });
  }

  const out = new Map<string, OnlyWhen>();
  // Answer rules first, so an "otherwise" can see whether the person it stands in for has one.
  const order = [...wanted.entries()].sort((a, b) => Number(isInstead(onlyWhenOf({ only_when: a[1].w }))) - Number(isInstead(onlyWhenOf({ only_when: b[1].w }))));
  for (const [rid, { w: raw }] of order) {
    const r = byId.get(rid);
    const who = nameOfPerson(r);
    if (!env?.ordered) throw bad(`${NO} ${who} is asked "only when" an earlier answer is given, and this document has no signing order, so nobody signs before ${who}. Turn on "Set signing order" and put the person whose answer counts first, or take the rule off.`);
    if (r.role === 'witness') throw bad(`${NO} ${who} is a witness, and a witness is asked when their signer has signed, whatever the answers. Take the rule off ${who}, or put it on the person they witness.`);
    if (raw && raw.otherwise != null && raw.otherwise !== '') {
      const k = String(raw.otherwise);
      const tid = givenPerson.get(k) || (byId.has(k) ? k : null);
      const t = tid ? byId.get(tid) : null;
      if (!t) throw bad(`${NO} ${who} is asked instead of "${str(k, 60)}", and nobody on this document has that id. Use the id of a person on it, or take the rule off.`);
      if (t.id === rid) throw bad(`${NO} ${who} is asked instead of themselves. Choose the person ${who} stands in for, or take the rule off.`);
      if (t.routing_order !== r.routing_order) throw bad(`${NO} ${who} is asked instead of ${nameOfPerson(t)}, who is at another place in the signing order. Give both the same place, or choose another person.`);
      const tw = out.get(t.id);
      if (!tw || isInstead(tw)) throw bad(`${NO} ${who} is asked instead of ${nameOfPerson(t)}, and ${nameOfPerson(t)} has no rule on an answer, so ${nameOfPerson(t)} is always asked. Give ${nameOfPerson(t)} an "Only when..." first, or take the rule off ${who}.`);
      out.set(rid, { otherwise: t.id });
      continue;
    }
    if (!raw || raw.field == null || raw.field === '') throw bad(`${NO} the rule for ${who} names no field. Say which answer of someone earlier decides it, in "field".`);
    const k = String(raw.field);
    let fid = givenField.get(k) || (fieldById.has(k) ? k : null);
    if (!fid) {
      const named = fields.filter((f: any) => fold(f.label) !== '' && fold(f.label) === fold(k) && TESTABLE(f));
      if (named.length > 1) throw bad(`${NO} the rule for ${who} reads "${str(k, 80)}", and ${named.length} fields have that label. Give them different labels, or name the field by its id.`);
      fid = named[0]?.id || null;
    }
    const gone = !fid && (e.fields || []).find((f: any) => f.id === k);
    if (!fid) throw bad(gone ? `${NO} the rule for ${who} reads '${nameOf(gone)}', and that field is no longer on the document. Choose another answer, or take the rule off.`
      : `${NO} the rule for ${who} reads "${str(k, 80)}", and no field on this document has that id or label. Use the id or label of a field of someone earlier in the order.`);
    const f = fieldById.get(fid);
    const owner = byId.get(f.recipient_id);
    const fname = `'${nameOf(f)}'`;
    if (!TESTABLE(f)) throw bad(`${NO} the rule for ${who} reads ${fname}, a ${f.type.replace('_', ' ')} field. Use a tick box, a radio button, a choice, a text, a number, a date or an attachment.`);
    if (!owner) throw bad(`${NO} the rule for ${who} reads ${fname}, which belongs to nobody. Use an answer of someone earlier in the order.`);
    if (owner.id === rid) throw bad(`${NO} the rule for ${who} reads ${fname}, which ${who} fills in, and that answer is not there yet when it is decided. Use an answer of someone earlier in the order.`);
    if (owner.role === 'witness') throw bad(`${NO} the rule for ${who} reads ${fname}, which a witness fills in, and a witness signs whenever their signer has. Use an answer of a signer earlier in the order.`);
    if (!(Number(owner.routing_order) < Number(r.routing_order))) throw bad(`${NO} the rule for ${who} reads ${fname}, which ${nameOfPerson(owner)} fills in, and ${nameOfPerson(owner)} does not sign before ${who}. Put ${nameOfPerson(owner)} earlier in the signing order, or use an answer of someone who is.`);
    const allowed = CONDS_FOR[f.type];
    if (!(CONDS as readonly string[]).includes(raw.is) || !allowed.includes(raw.is))
      throw bad(`${NO} "is" in the rule for ${who} is ${str(JSON.stringify(raw.is ?? null), 40)}, which cannot be asked of ${fname}. Use one of ${allowed.map((c) => `"${c}" (${COND_WORDS[c](f.type)})`).join(', ')}.`);
    let value: string | undefined;
    if (NEEDS_VALUE.includes(raw.is)) {
      if (raw.value == null || typeof raw.value === 'object' || String(raw.value).trim() === '') throw bad(`${NO} the rule for ${who} compares ${fname} with a value, and "value" is missing. Add the value, like "1000".`);
      value = String(raw.value).trim();
      if (value.length > RULE_VALUE_MAX) throw bad(`${NO} the value in the rule for ${who} is ${value.length} characters long. Shorten it to ${RULE_VALUE_MAX} or fewer.`);
      if (f.type === 'number' && !readNumber(value)) throw bad(`${NO} "${str(value, 60)}" is not a number, so ${fname} cannot be compared with it. Write it like 1000 or 12.5.`);
    }
    out.set(rid, { field: fid, is: raw.is, ...(value != null ? { value } : {}) });
  }

  for (const p of people) {
    const next = out.get(p.id) || null;
    const was = oldRecs.get(p.id);
    const changed = onlyWhenKey({ only_when: next }) !== onlyWhenKey(was || {});
    // Once a person's step is reached, whether they are asked has been decided: their rule stays as it was.
    if (correcting && was && was.status !== 'pending' && changed)
      throw bad(`${NO} ${nameOfPerson(was)} ${notAsked(was) ? 'was already not asked' : 'has already been asked'}, so the rule for them can no longer change. Change the rules of people who have not been reached yet, or leave this one as it is.`);
    run('UPDATE recipients SET only_when=? WHERE id=?', next ? JSON.stringify(next) : null, p.id);
  }
}

/**
 * The field and the words for an answer rule, from the envelope as loadEnvelope gives it. An answer the sender hid
 * from the others (a text field with "hide", lib/fieldrules.ts) is never written out: the record and the certificate
 * go to everyone, so they say only that the hidden answer did or did not meet the rule, and not the rule's value.
 */
function said(e: any, r: any, w: AnswerRule) {
  const d = decide(w, e.fields);
  const fieldName = d.field ? nameOf(d.field) : 'an answer that is no longer on the document';
  if (d.field && isHidden(d.field)) return { met: d.met, why: hiddenWhy(nameOfPerson(r), fieldName, false), asked: hiddenWhy(nameOfPerson(r), fieldName, true) };
  const why = notAskedWhy(nameOfPerson(r), fieldName, d.was, w, d.field?.type || 'text');
  return { met: d.met, why, asked: why.replace(/^(.*?), because /, '$1 is asked, because ') };
}

/**
 * Whether this person had already been asked: a correction can put someone earlier in the order back after a later
 * person was emailed or opened the document (outOfTurn in envelopes.ts gives their turn back, and clears sent_at).
 * Read from what is kept: an email or text written for them, their opening or agreeing, a signature given before,
 * or a line in the record that the request was opened for them without an email.
 */
function askedBefore(e: any, r: any): boolean {
  if (r.viewed_at || r.consent_at || r.signed_before) return true;
  if (get('SELECT 1 x FROM emails WHERE recipient_id=? LIMIT 1', r.id) || get('SELECT 1 x FROM texts WHERE recipient_id=? LIMIT 1', r.id)) return true;
  if (get('SELECT 1 x FROM recipient_members WHERE recipient_id=? AND sent_at IS NOT NULL LIMIT 1', r.id)) return true;
  const name = String(r.name || '');
  return !!name && !!get("SELECT 1 x FROM audit WHERE envelope_id=? AND action IN ('Not emailed', 'Ready to sign in person', 'Sent to recipient') AND instr(detail, ?) > 0 LIMIT 1", e.id, name);
}

/** People not asked in this pass who had been asked before: they are told they are no longer needed (skipNotAsked). */
type Told = { r: any; why: string };

function markNotAsked(e: any, r: any, why: string, told: Told[]) {
  const before = askedBefore(e, r);
  // No link at all: nobody can open the document as this person, and "Find my documents" has nothing to send them.
  if (!run("UPDATE recipients SET status='skipped', skipped_why=?, skipped_was_asked=?, token=NULL WHERE id=? AND status='pending'", why, before ? 2 : null, r.id).changes) return;
  run('UPDATE recipient_members SET token=NULL WHERE recipient_id=?', r.id);
  if (before) {
    // Said as it happened: they had been asked, and are no longer needed. Never "no email was sent" to someone who had one.
    audit(e.id, { name: 'System' }, 'No longer needed', `${why} They had been asked before the document was changed${r.viewed_at ? ' and had opened it' : ''}, and they did not sign or approve it. Their link no longer works.`);
    told.push({ r, why });
  } else audit(e.id, { name: 'System' }, 'Not asked', `${why} No email was sent to them, and they did not sign, approve or see the document.`);
  // A witness of someone who is not asked has nothing to witness.
  for (const w of (e.recipients || []).filter((x: any) => x.role === 'witness' && x.witness_for === r.id && x.status === 'pending'))
    markNotAsked(e, w, `${nameOfPerson(w)}, because ${nameOfPerson(r)}, whose signature they would witness, was not asked.`, told);
}

/**
 * The people who had been asked before and are not needed now get the same notice as a person taken off the
 * document (correctEnvelope): no longer needed, nothing more to do. Their row says whether an email went
 * (skipped_was_asked 1) or could not (2: no address, a spam mark, a group member who reported it, sending paused, no
 * mail server), and the record says the same.
 */
async function tellNoLongerNeeded(e: any, told: Told[]) {
  if (!told.length) return;
  const sender = senderOf(e);
  const quiet = !!get('SELECT suspended_at s FROM accounts WHERE id=?', e.account_id)?.s;
  for (const { r } of told) {
    const to = quiet || r.role === 'inperson' ? [] : groupPeople(r).filter((p: any) => p.email && !p.complained_at);
    let went = 0;
    for (const p of to) {
      const how = await sendMail({ to: p.email, recipientId: r.id, envelopeId: e.id, replyTo: sender?.email, fromName: sender?.name, subject: `No longer needed: ${e.subject}`, heading: 'You no longer need to sign this',
        lines: [`${sender?.name || 'The sender'} changed this document, and it no longer needs you${r.role === 'approver' ? ' to approve it' : ''}. There is nothing more for you to do, and the link you had no longer works.`] });
      if (how !== 'outbox') went++;
    }
    if (went) run('UPDATE recipients SET skipped_was_asked=1 WHERE id=?', r.id);
    audit(e.id, { name: 'System' }, went ? 'No longer needed: emailed' : 'No longer needed: not emailed', went
      ? `${nameOfPerson(r)} was emailed that they no longer need to sign.`
      : `${nameOfPerson(r)} was not emailed that they are no longer needed, ${quiet ? 'because sending is paused on the account' : r.role === 'inperson' ? 'because they sign in person with the sender' : !to.length ? 'because we have no address we may write to for them' : 'because no mail server is set up'}. The sender can tell them.`);
  }
}

/**
 * Called by advance() with the people whose step has been reached. Decides every rule among them from what is
 * stored: everyone before them has finished, so the answers are final. A person whose rule is not met is marked
 * "Not asked" here. True when anyone was, so advance looks at the step again (it may now be empty, and the next one
 * starts). A met rule is written in the record once.
 */
export async function skipNotAsked(e: any, next: any[]): Promise<boolean> {
  const ruled = next.filter((r: any) => onlyWhenOf(r));
  if (!ruled.length) return false;
  let skipped = false;
  const told: Told[] = [];
  const off = new Set<string>();
  for (const r of ruled) {
    const w = onlyWhenOf(r)!;
    if (isInstead(w)) continue;
    const s = said(e, r, w);
    if (!s.met) {
      markNotAsked(e, r, s.why, told);
      off.add(r.id);
      skipped = true;
    } else if (!r.asked_why) {
      const why = s.asked;
      run('UPDATE recipients SET asked_why=? WHERE id=?', why, r.id);
      audit(e.id, { name: 'System' }, 'Asked because of a rule', why);
    }
  }
  for (const r of ruled) {
    const w = onlyWhenOf(r)!;
    if (!isInstead(w)) continue;
    const t = (e.recipients || []).find((x: any) => x.id === w.otherwise);
    const tOff = off.has(w.otherwise) || notAsked(t);
    const tName = nameOfPerson(t);
    if (!tOff) {
      markNotAsked(e, r, `${nameOfPerson(r)}, because ${tName} was asked instead (rule: only if ${tName} is not asked).`, told);
      skipped = true;
    } else if (!r.asked_why) {
      const why = `${nameOfPerson(r)} is asked, because ${tName} was not asked (rule: only if ${tName} is not asked).`;
      run('UPDATE recipients SET asked_why=? WHERE id=?', why, r.id);
      audit(e.id, { name: 'System' }, 'Asked because of a rule', why);
    }
  }
  await tellNoLongerNeeded(e, told);
  return skipped;
}

/**
 * A correction in which someone earlier in the order is asked to sign again (or is put earlier): a person who was
 * not asked and whose step now comes after someone who has not finished is waiting again, and their rule is decided
 * afresh when the step is reached, from the new answers. Called by correctEnvelope inside its transaction.
 */
export function reopenNotAsked(envelopeId: string): string[] {
  const env = get('SELECT ordered FROM envelopes WHERE id=?', envelopeId);
  if (!env?.ordered) return [];
  const people = all('SELECT * FROM recipients WHERE envelope_id=?', envelopeId);
  const open = people.filter((r: any) => r.status !== 'completed' && r.status !== NOT_ASKED && r.role !== 'cc' && r.role !== 'witness');
  if (!open.length) return [];
  const turn = Math.min(...open.map((r: any) => r.routing_order));
  const back: string[] = [];
  for (const r of people.filter((x: any) => notAsked(x) && x.routing_order > turn)) {
    run("UPDATE recipients SET status='pending', skipped_why=NULL, skipped_was_asked=NULL, asked_why=NULL, token=?, check_code=? WHERE id=?", token(), checkCode(), r.id);
    back.push(nameOfPerson(r));
  }
  for (const r of people.filter((x: any) => !notAsked(x) && x.asked_why && x.status === 'pending' && x.routing_order > turn)) run('UPDATE recipients SET asked_why=NULL WHERE id=?', r.id);
  if (back.length) audit(envelopeId, { name: 'System' }, 'Rule to be decided again', `${back.join(', ')} ${back.length === 1 ? 'was' : 'were'} not asked before. Someone earlier in the order has not finished now, so whether ${back.length === 1 ? 'they are' : 'they are'} asked is decided again when their step comes.`);
  return back;
}

/** Each person's rule goes with a copy (a template used, a bulk row, a form, a copy of a document), pointing at the copy's own fields and people. */
export function copyOnlyWhen(src: any, rmap: Map<string, string>, fmap: Map<string, string>) {
  for (const r of src.recipients || []) {
    const w = onlyWhenOf(r);
    if (!w || !rmap.has(r.id)) continue;
    const to: OnlyWhen | null = isInstead(w) ? (rmap.has(w.otherwise) ? { otherwise: rmap.get(w.otherwise)! } : null) : fmap.has(w.field) ? { ...w, field: fmap.get(w.field)! } : null;
    if (to) run('UPDATE recipients SET only_when=? WHERE id=?', JSON.stringify(to), rmap.get(r.id));
  }
}

export { notAskedStatus } from '../lib/routing.ts';

/** The rule in words for the signing record and the sender's page ("Only when 'Amount' is more than 1000"). */
export function ruleLine(e: any, r: any): string | null {
  const w = onlyWhenOf(r);
  if (!w) return null;
  if (isInstead(w)) return `Only when ${nameOfPerson((e.recipients || []).find((x: any) => x.id === w.otherwise))} is not asked`;
  const f = (e.fields || []).find((x: any) => x.id === w.field);
  return `Only when ${f ? nameOf(f) : 'an answer that is no longer on the document'} is ${condWords(w.is, f?.type || 'text', w.value)}`;
}
