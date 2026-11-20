import { all, get, run, tx, saveBlob, readBlob } from './db.ts';
import { assertCanStore } from './filestore.ts';
import { bad, id, token, sha256, now, isEmail, str, baseUrl, checkCode } from './util.ts';
import { sendMail, onMailOutcome, type MailStatus } from './mail.ts';
import { renderEnvelopePdf, withNotice, senderZone } from './pdf.ts';
import { fireWebhooks } from './webhooks.ts';
import { sheetsSaved, impactOf, fmtNum, PRICING } from '../lib/impact.ts';
import { creditsEnabled, available, needed, isChargeable, isSelf, sigRef, grant, sameEmail, paidFor, creditSummary, nextPerson } from './credits.ts';
import { STANDING_PAYMENT, personGen } from './credits.ts';
import { DATE_FORMATS, momentText, momentForEmail, isDaytime, validZone, REMINDER_DAY_START, isDateValue, DATE_PROBLEM } from '../lib/dates.ts';
import { NUMBER_RULE } from '../lib/numbers.ts';
import { abuseSuspendAfter, newAccountDailyRecipients, unpaidDailyRecipients, powerformIdleHours, powerformSharedIdleMinutes, ACCESS_CODE_MIN, ACCESS_CODE_TRIES } from '../lib/policy.ts';
import { PAID_TRUST_DAYS, paidTrustText, TEAM_INVITES_PER_DAY } from '../lib/policy.ts';
import { posesAs, lureIn } from './fakenotice.ts';
import { saveChecks, copyCheck, assertChecks, checkBits, alsoText, textWaiting, passCheckOn, withCheckLines, publicCheck } from './signercode.ts';
import { sendWarnings, PAPER_AUDIT_ACTION } from './warnings.ts';
import { paperAuditNote } from '../lib/paperwork.ts';
import { strikePlace } from '../lib/strike.ts';
import { stackedFields } from '../lib/stacked.ts';
import { bouncedBefore, bouncedRefusal, bouncedLine } from './bounces.ts';
// A recipient that is a group of people, any one of whom can act (src/server/groups.ts).
import { attachGroups, groupNames, saveGroups, copyGroup, assertGroups, groupReach, groupReachNew, snapshotGroups, settleGroups, groupPeople, notifyMembers, groupLine, groupWords, groupChange, groupsCorrected, memberLinks, assertGroupCorrection, memberMailStop } from './groups.ts';
import { isOpenGroup, whoIs } from '../lib/groups.ts';
// A person whose link the sender passes on themselves, with no email address (src/server/bysender.ts).
import { saveBySender, bySenderProblem, reachKey, reporterKey, copyBySender, bySenderNotice, assertNudgeable, remindThroughSender, untoldLines, unopenedLines, noteNoCopy, senderCopyLines, answerLine } from './bysender.ts';
import { labelOf, signerAt } from '../lib/bysender.ts';
import { carryRules } from './tplroles.ts';
// Around the certificate: the fingerprint in the completion email and the record of each completed copy (evidence.ts).
import { fingerprintLines, noteCopyMailed } from './evidence.ts';
// A witness for one signer: asked straight after that signer, never charged, a statement of their own (witness.ts).
import { saveLocales, copyLocale } from './locales.ts';
import { saveWitnesses, witnessProblem, witnessDue, settleWitnesses, copyWitnesses, forgetNamedWitness, witnessDone, witnessVerb, witnessMailLines, witnessCannot, openNames, withWitnesses, witnessBits, witnessesSetAside, witnessedBy, assertWitnessesAfter, witnessesWaiting } from './witness.ts';
import { waitsForName } from '../lib/witness.ts';
// Conditional fields and formulas: checked when saved, worked out again from what is stored (logic.ts).
import { saveLogic, settleLogic, hiddenOf, copyLogic, logicChanges, assertInputs, oneChoice } from './logic.ts';
import { ruleOf, logicKey } from '../lib/logic.ts';
// A public form's visitor whose start was closed is offered a fresh form, and the owner is not emailed (formstart.ts).
import { closedFormStart, closedStartText } from './formstart.ts';
import { finalsDue, finalFailed, finalMadeLate } from './finalretry.ts';
// A stamp next to a signature: a recipient's own, or the sender's, printed like ink (stamps.ts).
import { isSenderStamp, printedStamp, stampOnSave, copyStamps, stampProblem, stampsSent, stampsFinished, senderStampChange } from './stamps.ts';
import { convertedSent, convertedAdded } from './converted.ts';
import { convertedOf } from '../lib/convert.ts';

export const ROLES =['signer', 'approver', 'cc', 'viewer', 'inperson', 'witness'];
export const FIELD_TYPES = ['signature', 'initials', 'date_signed', 'full_name', 'email', 'text', 'number', 'date', 'company', 'title', 'checkbox', 'radio', 'dropdown', 'attachment', 'note', 'strike', 'stamp'];
// The sender's own marks on a page, which belong to no recipient: words added (a note) and a line through words that
// are printed there (a strike-out, src/lib/strike.ts). Both are wording that everyone signs.
const SENDER_MARK = (type: any) => type === 'note' || type === 'strike';
const AUTO_TYPES = ['date_signed', 'full_name', 'email'];
// A witness signs too: their own fields, a signature, the same Finish. What they cost is a separate question
// (isChargeable in credits.ts counts only signer and inperson), so ACTS never decides money.
const ACTS = (role: string) => role === 'signer' || role === 'inperson' || role === 'witness';

export type Actor = { name: string; ip?: string; ua?: string };

// ---- Audit trail (hash chained) ------------------------------------------------------------

export function audit(envelopeId: string, actor: Actor, action: string, detail = '') {
  const prev = get('SELECT hash FROM audit WHERE envelope_id=? ORDER BY seq DESC LIMIT 1', envelopeId)?.hash || '';
  const at = now();
  const hash = sha256(JSON.stringify([prev, envelopeId, at, actor.name, action, detail, actor.ip || '']));
  run('INSERT INTO audit (envelope_id, at, actor, action, detail, ip, user_agent, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)',
    envelopeId, at, actor.name, action, detail, actor.ip || null, (actor.ua || '').slice(0, 300) || null, prev, hash);
}

export const auditTrail = (envelopeId: string) => all('SELECT seq, at, actor, action, detail, ip, prev_hash, hash, redacted_at FROM audit WHERE envelope_id=? ORDER BY seq', envelopeId);

// A line whose details a retention purge took out (redacted_at, src/server/records.ts) keeps its chain values: it is
// checked for its place in the chain, not recomputed, and said as such (redacted, redacted_on). It counts only when its
// time is the envelope's own purge: any other mark is a changed line like any other.
export function verifyChain(envelopeId: string): { ok: boolean; events: number; head: string; redacted?: number; redacted_on?: string } {
  let prev = '';
  const rows = auditTrail(envelopeId);
  const purged = rows.some((a) => a.redacted_at) ? get('SELECT purged_at p FROM envelopes WHERE id=?', envelopeId)?.p : null;
  let redacted = 0;
  for (const a of rows) {
    if (a.redacted_at && purged && a.redacted_at === purged) {
      if (a.prev_hash !== prev) return { ok: false, events: rows.length, head: prev };
      (prev = a.hash), redacted++;
      continue;
    }
    const h = sha256(JSON.stringify([prev, envelopeId, a.at, a.actor, a.action, a.detail, a.ip || '']));
    if (a.prev_hash !== prev || a.hash !== h) return { ok: false, events: rows.length, head: prev };
    prev = h;
  }
  return { ok: true, events: rows.length, head: prev, ...(redacted ? { redacted, redacted_on: String(purged).slice(0, 10) } : {}) };
}

// ---- Loading and saving --------------------------------------------------------------------

/** How a file's scan flag is given out: is_scan, and scan_pages as a list of page numbers counted from 1. */
export function scanFlag(stored: any): { is_scan: boolean; scan_pages: number[] } {
  let pages: number[] = [];
  try {
    pages = JSON.parse(stored || '[]');
  } catch {
    /* a value we cannot read counts as no flag */
  }
  return { is_scan: pages.length > 0, scan_pages: pages };
}

export function loadEnvelope(envelopeId: string): any {
  const e = get('SELECT * FROM envelopes WHERE id=?', envelopeId);
  if (!e) return null;
  e.documents = all(
    'SELECT d.id, d.name, d.position, d.file_id, f.pages, f.page_sizes, f.sha256, f.size, f.scan_pages, f.converted FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=? ORDER BY d.position',
    envelopeId,
    // Which pages are pictures with no text is kept with the file and said wherever the file is listed, so the
    // warning about a scan does not disappear when a draft is opened again.
  ).map((d) => ({ ...d, page_sizes: JSON.parse(d.page_sizes), ...scanFlag(d.scan_pages), converted: convertedOf(d.converted) }));
  e.recipients = all('SELECT * FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', envelopeId);
  // A recipient that is a group carries its members (without their links): see attachGroups in groups.ts.
  attachGroups(e);
  e.fields = all('SELECT * FROM fields WHERE envelope_id=?', envelopeId).map((f) => ({ ...f, options: f.options ? JSON.parse(f.options) : [], show_when: ruleOf(f) }));
  return e;
}

// What a sender sees: no signing tokens, no bulky signature images.
export function publicEnvelope(e: any) {
  return {
    ...e,
    // publicCheck: the check a sender asked for before the document opens, as words, without the server's own columns.
    // device_hash and witness_saw are the server's own, for the witness's "same device" yes or no (witness.ts).
    recipients: e.recipients.map(({ token: _t, signature_png, initials_png, user_agent: _u, device_hash: _d, witness_saw: _s, ...r }: any) => publicCheck({ ...r, has_signature: !!signature_png }, _t)),
  };
}

export function createEnvelope(account: any, userId: string, kind: 'envelope' | 'template', init: any = {}): string {
  const eid = id(kind === 'template' ? 'tpl' : 'env');
  const t = now();
  run(
    // A new envelope starts with the account's own date format (Settings), like its reminder and deadline defaults.
    'INSERT INTO envelopes (id, account_id, sender_id, kind, subject, message, reminder_days, expire_days, date_format, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    eid, account.id, userId, kind, fit(init.subject, 200, 'The subject'), fit(init.message, 5000, 'The message to recipients'), account.default_reminder_days ?? 0, account.default_expire_days ?? 120,
    (DATE_FORMATS as readonly string[]).includes(account.default_date_format) ? account.default_date_format : null, t, t,
  );
  return eid;
}

const clamp01 = (n: any) => Math.min(1, Math.max(0, Number(n) || 0));
const int = (n: any, lo: number, hi: number, d: number) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : d);
// Nothing in a request is cut short, moved to the nearest allowed value or dropped without a word. Text that is too
// long, a number outside its range and a part that is not the list it should be are refused, and the answer names
// the part and its limit. `what` starts the sentence: "The subject", "Field 2 (\"Amount\"): the value".
const fit = (v: any, max: number, what: string): string => {
  // Text sent as a list or an object would be saved as "[object Object]". That is said, not saved.
  if (v != null && typeof v === 'object') throw bad(`${what} was sent as ${Array.isArray(v) ? 'a list' : 'an object'}, and it has to be text. Nothing was saved.`);
  const s = v == null ? '' : String(v);
  if (s.length > max) throw bad(`${what} is ${fmtNum(s.length)} characters long, and the most that fits is ${fmtNum(max)}. Shorten it and save again. Nothing was saved.`);
  return s;
};
const whole = (v: any, lo: number, hi: number, d: number, what: string): number => {
  if (v == null || v === '') return d;
  if (typeof v === 'boolean' || !Number.isInteger(Number(v)) || Number(v) < lo || Number(v) > hi) throw bad(`${what} must be a whole number from ${lo} to ${hi}, and "${str(v, 40)}" is not. Nothing was saved.`);
  return Number(v);
};
// A yes or no is true or false (1 and 0 do too: the database gives them back that way). Anything else is refused,
// because the word "false" in quotes would otherwise count as yes: a field made read-only, a signing order turned
// on, an envelope sent. Left out, the usual default holds. `what` names the key: '"readonly" of field 2'.
export const yesNo = (v: any, d: boolean, what: string): boolean => {
  if (v == null || v === '') return d;
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  throw bad(`${what} is ${str(JSON.stringify(v), 40)}, and it has to be true or false, written without quotes. Nothing was saved.`);
};
// A place or a size on the page is a number (a share of the page's width or height). A word or a list is refused,
// so a field is never put at the top corner, or given a size nobody asked for. Left out, the usual default holds.
const share = (v: any, what: string): number | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean' || typeof v === 'object' || !Number.isFinite(Number(v))) throw bad(`${what} is ${str(JSON.stringify(v), 40)}, and it has to be a number, as a share of the page from 0 to 1. Nothing was saved.`);
  return Number(v);
};
// A list that is left out of a request stays as it is, like a subject that is left out. One that is sent must be a list.
const listOf = (body: any, key: 'documents' | 'recipients' | 'fields', kept: any[]): any[] => {
  if (body[key] === undefined) return kept;
  if (!Array.isArray(body[key])) throw bad(`"${key}" must be a list, written with square brackets, and it is not. Nothing was saved.`);
  return body[key];
};

// Writes documents, recipients and fields from the editor's full state. Recipient rows are updated in place, so
// their progress (status, link, consent, signature) survives a correction made after sending.
function writeContent(e: any, body: any, accountId: string, correcting: boolean, by?: Actor) {
  // The sender's own choice to change what finished people signed and ask them to sign again. See correctEnvelope.
  const resign = correcting && body.resign === true;
  // The editor makes its own ids so they stay stable between saves. Accept one only if it is well formed and not
  // already used by a different envelope; otherwise hand out a fresh id.
  const keep = (existing: any[], prefix: string, table: string) => {
    const mine = new Set(existing.map((x) => x.id));
    const map = new Map<string, string>();
    const shape = new RegExp(`^${prefix}_[A-Za-z0-9_-]{16}$`);
    return (clientId: any) => {
      const k = String(clientId ?? '');
      if (!k) return id(prefix); // no id given (typical for API callers): every item gets its own
      if (!map.has(k)) map.set(k, mine.has(k) || (shape.test(k) && !get(`SELECT 1 x FROM ${table} WHERE id=?`, k)) ? k : id(prefix));
      return map.get(k)!;
    };
  };
  const docId = keep(e.documents, 'doc', 'documents');
  const recId = keep(e.recipients, 'rcp', 'recipients');
  const fldId = keep(e.fields, 'fld', 'fields');

  const docs = listOf(body, 'documents', e.documents);
  const recs = listOf(body, 'recipients', e.recipients);
  const flds = listOf(body, 'fields', e.fields);
  // Limits are said out loud. Nothing is ever dropped quietly.
  if (docs.length > 30) throw bad('An envelope can hold up to 30 documents. Remove some, or send the rest in a second envelope.');
  if (recs.length > 50) throw bad('An envelope can have up to 50 recipients. For more people, use bulk send so each gets their own copy.');
  if (flds.length > 2000) throw bad('An envelope can have up to 2,000 fields. Remove some fields and save again.');
  const doneIds = new Set<string>(correcting ? e.recipients.filter((r: any) => r.status === 'completed' && r.role !== 'cc').map((r: any) => r.id) : []);
  const docPages = new Map<string, number>();
  const oldRecs = new Map<string, any>(e.recipients.map((r: any) => [r.id, r]));
  const oldFields = new Map<string, any>(e.fields.map((f: any) => [f.id, f]));

  // Every save counts up edit_version and notes who made it, so a later save from an older copy can be told apart.
  // The date format is part of what is printed: once somebody has finished, correctEnvelope decides whether it may change.
  const t = now();
  // A date format we do not have is a mistake to point out. Leaving it out keeps the one the envelope has.
  if (body.date_format != null && body.date_format !== '' && !(DATE_FORMATS as readonly string[]).includes(body.date_format))
    throw bad(`The date format "${str(body.date_format, 40)}" does not exist. Use one of: ${DATE_FORMATS.join(', ')}. Nothing was saved.`);
  // Whatever is left out stays as it is: the subject, the message, and also whether people sign in order. A
  // correction that does not mention the order must never turn it off and email the next person.
  run('UPDATE envelopes SET subject=?, message=?, ordered=?, reminder_days=?, expire_days=?, date_format=?, updated_at=?, edit_version=edit_version+1, edited_by=?, edited_at=?, edited_how=NULL WHERE id=?',
    fit(body.subject ?? e.subject, 200, 'The subject'), fit(body.message ?? e.message, 5000, 'The message to recipients'), yesNo(body.ordered, !!e.ordered, '"ordered"') ? 1 : 0,
    whole(body.reminder_days, 0, 60, e.reminder_days, 'The number of days between reminders (reminder_days)'), whole(body.expire_days, 1, 365, e.expire_days, 'The number of days until the deadline (expire_days)'),
    body.date_format || e.date_format, t, by?.name || null, t, e.id);
  run('DELETE FROM fields WHERE envelope_id=?', e.id);
  run('DELETE FROM documents WHERE envelope_id=?', e.id);
  docs.forEach((d: any, i: number) => {
    const f = get('SELECT id, pages, name FROM files WHERE id=? AND account_id=?', d?.file_id, accountId);
    // Which document it is, so a caller who left the file out, or whose file was deleted, knows which one to fix.
    const doc = `Document ${i + 1}${d?.name ? ` ("${str(d.name, 60)}")` : ''}`;
    if (!f) throw bad(d?.file_id == null || d.file_id === '' ? `${doc} has no "file_id". Upload the file first (POST /files) and use the id you get back. Nothing was saved.`
      : `${doc}: its file no longer exists, or belongs to another account. Upload it again and save. Nothing was saved.`);
    const did = docId(d.id);
    if (docPages.has(did)) throw bad(`Documents ${[...docPages.keys()].indexOf(did) + 1} and ${i + 1} have the same id "${str(d.id, 60)}". Give every document an id of its own, or leave the ids out. Nothing was saved.`);
    docPages.set(did, f.pages);
    run('INSERT INTO documents (id, envelope_id, file_id, name, position) VALUES (?,?,?,?,?)', did, e.id, f.id, fit(d.name || f.name, 200, `The name of document ${i + 1}`), i);
  });
  const seen = new Set<string>();
  // Every recipient as the request named them, with the id they were saved under, for saveChecks below.
  const asked: { rid: string; r: any; i: number }[] = [];
  recs.forEach((r: any, i: number) => {
    if (!r || typeof r !== 'object') throw bad(`Recipient ${i + 1} is not an object with a name and an email address. Nothing was saved.`);
    const rid = recId(r.id);
    // Two people under one id would leave the second one out. That is said, not done.
    if (seen.has(rid)) throw bad(`Recipients ${[...seen].indexOf(rid) + 1} and ${i + 1} have the same id "${str(r.id, 60)}", so the second one${r.name ? ` (${str(r.name, 120)})` : ''} would be left out. Give every recipient an id of their own, or leave the ids out. Nothing was saved.`);
    seen.add(rid);
    asked.push({ rid, r, i });
    // For a group ("group_id") the name and the address on the row are the server's to set: see groupNames in groups.ts.
    r = groupNames(r, oldRecs.get(rid), accountId, correcting, i);
    // A role we do not have is a mistake to point out, not a signer to assume. Leaving the role out means signer.
    if (r.role != null && r.role !== '' && !ROLES.includes(r.role))
      throw bad(`Recipient ${i + 1}${r.name ? ` (${str(r.name, 120)})` : ''} has the role "${str(r.role, 40)}", which does not exist. Use one of: ${ROLES.join(', ')}. Nothing was saved.`);
    const role = ROLES.includes(r.role) ? r.role : 'signer';
    const whom = `recipient ${i + 1}${r.name ? ` (${str(r.name, 120)})` : ''}`;
    const email = fit(r.email, 254, `The email address of ${whom}`).trim();
    // A draft may hold a half-typed address so the rest of the work is never lost; it is checked before sending.
    if (correcting && email && !isEmail(email)) throw bad(`"${email}" is not a valid email address.`);
    const vals = [role, fit(r.role_name, 80, `The role name of ${whom}`) || null, fit(r.name, 120, `The name of recipient ${i + 1}`).trim(), email,
      whole(r.routing_order, 1, 99, 1, `The place in the signing order (routing_order) of ${whom}`), i, fit(r.access_code, 50, `The access code of ${whom}`).trim() || null, fit(r.note, 1000, `The private note for ${whom}`) || null];
    // Someone who has finished stays exactly as they were. A request that would change who they are is refused out
    // loud, never ignored, unless the sender chose to ask them to sign again.
    if (doneIds.has(rid)) {
      const o = oldRecs.get(rid);
      const same = o.role === role && o.name === vals[2] && sameEmail(o.email, email) && o.routing_order === vals[4];
      if (!same && !resign)
        throw bad(`${o.name} has already finished, so their name, email address, role and place in the order can no longer be changed. Nothing was saved. If you did not mean to change them, load the envelope again: their details may be newer than your copy. To change them anyway, send the same request with "resign": true, and ${o.name} is asked to sign again.${witnessedBy(e, o).length ? ` ${witnessedBy(e, o).join(', ')} witnessed their signature and is asked to witness again too.` : ''}`, 409, { code: 'sign_again', sign_again: [o.name, ...witnessedBy(e, o)], changes: [`The name, email address, role or place in the order of ${o.name} <${o.email}>.`] });
      if (same) {
        // The access code and the private note are not part of what they signed, so those are saved like anyone's.
        run('UPDATE recipients SET position=?, access_code=?, note=? WHERE id=?', i, vals[6], vals[7], rid);
        return;
      }
    }
    if (oldRecs.has(rid)) run('UPDATE recipients SET role=?, role_name=?, name=?, email=?, routing_order=?, position=?, access_code=?, note=? WHERE id=?', ...vals, rid);
    else run('INSERT INTO recipients (role, role_name, name, email, routing_order, position, access_code, note, id, envelope_id) VALUES (?,?,?,?,?,?,?,?,?,?)', ...vals, rid, e.id);
  });
  for (const rid of oldRecs.keys()) if (!seen.has(rid)) run('DELETE FROM recipients WHERE id=?', rid);
  // The check each recipient has to pass before the document opens ("verify", "phone", "text_link"): signercode.ts.
  saveChecks(e, asked, oldRecs, correcting);
  // Which recipients are groups, and on an envelope that is out, who their members are ("group_id", "members"): groups.ts.
  saveGroups(e, asked, oldRecs, correcting);
  // Who has no email address because the sender sends their link themselves ("link_by_sender"): bysender.ts.
  saveBySender(e, asked, oldRecs);
  // Whose signature a witness witnesses, and whether that signer names them ("witness_for", "named_by_signer"): witness.ts.
  saveWitnesses(e, asked, oldRecs, correcting);
  // The language each person's screens are in ("locale"), or none for their browser: locales.ts.
  saveLocales(asked, oldRecs, accountId);
  const placed = new Map<string, number>();
  // Each field with the id it was saved under, for its rule and formula once every field is in (logic.ts).
  const logic: { fid: string; f: any; rid: string | null; which: string }[] = [];
  flds.forEach((f: any, i: number) => {
    // A field that cannot be placed is named with its place in the list. It is never dropped without a word.
    const which = `Field ${i + 1}${f?.label ? ` ("${str(f.label, 60)}")` : ''}`;
    if (!FIELD_TYPES.includes(f?.type)) throw bad(`${which} has the type "${str(f?.type, 40)}", which does not exist. Use one of: ${FIELD_TYPES.join(', ')}. Nothing was saved.`);
    const did = docId(f.document_id);
    if (!docPages.has(did)) throw bad(`${which}, a ${f.type} field, points at the document "${str(f.document_id, 60)}", which is not in this envelope. Use the id of one of its documents. Nothing was saved.`);
    // A stamp field with no recipient is the sender's own stamp, like a note belongs to nobody (stamps.ts).
    const rid = SENDER_MARK(f.type) || isSenderStamp(f) ? null : recId(f.recipient_id);
    if (rid && !seen.has(rid))
      throw bad(f.recipient_id ? `${which}, a ${f.type} field, is for the recipient "${str(f.recipient_id, 60)}", who is not on this envelope. Use the id of one of its recipients, or add that person. Nothing was saved.`
        : `${which}, a ${f.type} field, has no recipient_id. Every field except a note and a strike-out belongs to one recipient. Nothing was saved.`);
    const fid = fldId(f.id);
    if (placed.has(fid)) throw bad(`${which} has the same id "${str(f.id, 60)}" as field ${placed.get(fid)}. Give every field an id of its own, or leave the ids out. Nothing was saved.`);
    placed.set(fid, i + 1);
    const old = oldFields.get(fid);
    // A page the document does not have is said. The field is not moved to another page.
    const last = docPages.get(did)! - 1;
    if (f.page != null && f.page !== '' && (!Number.isInteger(Number(f.page)) || Number(f.page) < 0 || Number(f.page) > last))
      throw bad(`${which}, a ${f.type} field, has "page": ${str(JSON.stringify(f.page), 40)}, and its document has ${last + 1} page${last ? 's' : ''}. Pages are counted from 0, so use ${last ? `a whole number from 0 to ${last}` : '0'}. Nothing was saved.`);
    const w = Math.min(1, Math.max(0.005, share(f.w, `${which}: "w"`) || 0.1));
    const h = Math.min(1, Math.max(0.005, share(f.h, `${which}: "h"`) || 0.03));
    const ro = yesNo(f.readonly, false, `${which}: "readonly"`);
    const prefilled = ['text', 'number', 'date', 'company', 'title', 'note', 'checkbox', 'radio', 'dropdown'].includes(f.type);
    // Signatures, initials and attachments are never set by the sender, and a name, an address or a signing date
    // fills itself in. A value sent for one of those is refused, unless it is only what the field holds already
    // (the editor sends every field back as it got it). What a stamp field may be sent with is decided by stampOnSave.
    if (!prefilled && f.type !== 'stamp' && f.value != null && f.value !== '' && String(f.value) !== String(old?.value ?? ''))
      throw bad(`${which}, a ${f.type.replace('_', ' ')} field, was sent with a value. ${f.type === 'strike' ? 'A strike-out is a line through what is printed and holds no words of its own' : f.type === 'signature' || f.type === 'initials' || f.type === 'attachment' ? 'Only the signer can fill that in' : 'That field fills itself in when its signer finishes'}. Leave "value" out. Nothing was saved.`);
    // During a correction, whatever a signer already entered is kept: an editor that was opened earlier must never
    // wipe it. The sender can still set a value on a field that is empty, on their own read-only fields, and on a
    // field that still holds exactly what the sender put there (prefill).
    const senderOwned = SENDER_MARK(f.type) || (old ? !!old.readonly : ro);
    // Someone who has finished gave an answer in every field of theirs, also where they emptied a line or unticked
    // a box that the sender had filled in. That answer is protected exactly like words they typed: this call never
    // puts the sender's value back, whatever the body carries. Where they left the sender's own wording as it was,
    // a change to it is a change to what they signed, and correctEnvelope asks for the sign-again choice.
    const finished = !!old?.recipient_id && doneIds.has(old.recipient_id);
    // Someone who has not finished yet and emptied such a line answered too. A body that carries the sender's wording
    // as it was (an editor opened before, the same request sent again) leaves it empty, or the line would come back
    // unseen. New wording is a change: it replaces the empty line, and the signer is told (content_version).
    const answered = correcting && !!old && !senderOwned && old.value !== old.prefill && (finished || old.value != null || String(f.value ?? '') === String(old.prefill));
    const value = answered ? old.value : prefilled ? fit(f.value, 4000, `${which}: the value`) || null : correcting && old ? old.value : null;
    // A date the sender fills in is held to the rule a signer's is (applyValues): a real day, written year-month-day.
    if (f.type === 'date' && value && !answered && !isDateValue(value)) throw bad(`${which}, a date field, was sent with "${String(value).slice(0, 40)}". A date is taken as a real day written year-month-day, like 2027-03-20, and printed in the envelope's date format. Nothing was saved.`);
    const readonly = ro || SENDER_MARK(f.type) ? 1 : 0;
    // The sender's own wording in a field its signer may still change. Kept beside the value: see db.ts. A signer
    // who emptied the field did not change what the sender wrote, so a save that leaves it empty keeps the wording.
    const prefill = answered ? old.prefill : prefilled && !readonly ? value ?? (correcting && old && old.value == null ? old.prefill : null) : null;
    if (f.options != null && !Array.isArray(f.options)) throw bad(`${which}: "options" must be a list of choices, written with square brackets. Nothing was saved.`);
    if ((f.options || []).length > 100) throw bad(`${which} has ${f.options.length} choices, and the most a field can offer is 100. Remove some and save again. Nothing was saved.`);
    run('INSERT INTO fields (id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, label, value, options, group_name, validation, readonly, prefill) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      fid, e.id, did, rid, f.type, Number(f.page) || 0,
      Math.min(clamp01(share(f.x, `${which}: "x"`)), 1 - w), Math.min(clamp01(share(f.y, `${which}: "y"`)), 1 - h), w, h, yesNo(f.required, true, `${which}: "required"`) ? 1 : 0,
      fit(f.label, 120, `${which}: the label`) || null, value,
      Array.isArray(f.options) ? JSON.stringify(f.options.map((o: any, n: number) => fit(o, 200, `${which}: choice ${n + 1}`))) : null,
      fit(f.group_name, 80, `${which}: the group name`) || null, fit(f.validation, 200, `${which}: the validation rule`) || null, readonly, prefill);
    // What a stamp field holds is decided here from what was there before, never taken from the request (stamps.ts).
    const stamp = f.type === 'stamp' ? stampOnSave(f, old, rid, accountId, which, by, e.fields) : null;
    if (stamp) run('UPDATE fields SET value=?, stamp_id=?, stamp_meta=?, readonly=?, required=COALESCE(?, required) WHERE id=?', stamp.value, stamp.stamp_id, stamp.meta, stamp.readonly, stamp.required, fid);
    logic.push({ fid, f, rid, which });
  });
  // "show_when" and "formula": a loop, a field of another person or a formula that cannot be read is refused here,
  // inside the same transaction, so nothing is saved. Then what is shown and what formulas come to is worked out.
  saveLogic(e, logic);
}

// A save that was made from an older copy than the one stored is refused, so one editor never wipes what another
// just saved (a colleague on a shared template, or a second tab). The editor sends the edit_version it loaded. A
// caller that sends none is not checked. Called inside the transaction that writes, with e read just before it.
function assertFresh(e: any, body: any) {
  if (body.edit_version == null || Number(body.edit_version) === e.edit_version) return;
  const what = e.kind === 'template' ? 'template' : e.status === 'draft' ? 'draft' : 'envelope';
  const who = str(e.edited_by, 200).replace(/\s*<[^>]*>$/, '') || 'Someone';
  // The newer version need not be a save from an editor: see newerVersion. Then the answer says what it was.
  const how = str(e.edited_how, 300);
  throw bad(how ? `${who} ${how} on ${ts(e.edited_at || e.updated_at)}, after you opened it. Your changes were not saved, so that is not undone. Load the ${what} as it is now and make your changes again.`
    : `${who} saved this ${what} on ${ts(e.edited_at || e.updated_at)}, after you opened it. Your changes were not saved, so nothing of theirs is lost. Load their version and make your changes again, or keep yours as a separate copy.`,
    409, { code: 'stale', edit_version: e.edit_version, edited_by: who, edited_at: e.edited_at || e.updated_at, edited_how: how || null });
}

// Every way an envelope changes counts as a newer version, not only a save from the editor: a quick correction of
// one person, a signer passing the document on or fixing their own name, and sending. A save from a copy that was
// loaded before it is then refused (assertFresh) with who did what and when, instead of quietly undoing it.
// `how` finishes the sentence that starts with the person's name: "passed this document on to Mary Deputy".
export function newerVersion(envelopeId: string, by: Actor, how: string) {
  const t = now();
  run('UPDATE envelopes SET edit_version=edit_version+1, edited_by=?, edited_at=?, edited_how=?, updated_at=? WHERE id=?', by.name || null, t, str(how, 300), t, envelopeId);
  // A witness still to be named is called after their signer as the signer is named now (witness.ts).
  openNames(envelopeId);
}

// Replaces the whole draft: documents, recipients and fields. The editor sends its full state on every save.
// `by` is who is saving an envelope that already exists (PUT). Only then is the copy they worked from checked: a new
// envelope has no earlier copy to be out of date against.
export function saveDraft(e: any, body: any, accountId: string, by?: Actor) {
  if (e.status !== 'draft') throw bad('Only drafts and templates can be edited.');
  tx(() => {
    if (by) assertFresh(e, body);
    writeContent(e, body, accountId, false, by);
    // A template is sent again and again (bulk, public forms), and the editor does not save one whose fields cover
    // each other, so neither does the API: refused here, once, instead of at every send made from it.
    if (e.kind === 'template') {
      const t = loadEnvelope(e.id);
      const stacked = stackedFields(t.fields, t.recipients, t.documents);
      if (stacked.length) throw bad(`${stacked.join(' ')} The template was not saved.`);
    }
  });
}

function assertSendable(e: any) {
  if (!e.documents.length) throw bad('Add at least one document before sending.');
  if (!e.recipients.length) throw bad('Add at least one recipient before sending.');
  for (const r of e.recipients) {
    if (!r.name) throw bad('Every recipient needs a name.');
    // A group has no address of its own until one member takes the document on: its members have (groups.ts).
    // So does someone whose link the sender sends themselves, and what cannot work for them is said here (bysender.ts).
    const own = bySenderProblem(r, e);
    if (own) throw bad(own);
    // A witness is there for one signer, and one that signer names has no address until they do (witness.ts).
    const wit = witnessProblem(r, e);
    if (wit) throw bad(wit);
    if (!isOpenGroup(r) && !r.link_by_sender && !(waitsForName(r) && r.named_by_signer) && !isEmail(r.email)) throw bad(`${r.name} needs a valid email address.`);
    if (ACTS(r.role) && !e.fields.some((f: any) => f.recipient_id === r.id && f.type !== 'note'))
      throw bad(`${r.name} has nothing to sign yet. Place at least one field for them.`);
  }
  if (!e.recipients.some((r: any) => r.role !== 'cc')) throw bad('Add at least one recipient who signs, approves or views.');
  // Two fields of one person on top of each other: a finger reaches only the top one, and the signer can never finish.
  // Not for a visitor of a public form that was made before this rule: turning every visitor away helps nobody, and
  // Text view still reaches every field. Its owner is told instead (POST /public/powerforms/:slug/start).
  const stacked = stackedFields(e.fields, e.recipients, e.documents);
  if (stacked.length && !(e.powerform_id && e.status === 'draft')) throw bad(stacked.join(' '));
  // The sender's own stamp has one chosen, and only someone who signs has a stamp to put on (stamps.ts).
  const stamp = stampProblem(e);
  if (stamp) throw bad(stamp);
}

const r6 = (n: number) => Math.round(n * 1e6);
const byFirst = (a: any[], b: any[]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

const ts = (s: any) => String(s ?? '').replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

// The words the sender put on a page: a note, a read-only value, or the value a signer's field starts out with.
// Every signer is shown these from the first time they open the document, whoever the field belongs to.
// A stamp is a picture, not words: its fingerprint is not read as text (printedStamp below says when it changes).
export const senderText = (f: any): string => (f.type === 'stamp' ? '' : (f.type === 'note' || f.readonly ? f.value : f.prefill) ?? '');

// A full name field and an email field print the name and the address the sender gave their owner, also for someone
// who only gets a copy. Those are words on the page like any other the sender wrote: every signer is shown them
// from the first look, and once someone has finished they only change with the sign-again choice. (A signing date
// is not wording. It appears when its signer finishes.)
export const printsName = (f: any): boolean => f.type === 'full_name' || f.type === 'email';
// Everything the sender put on the pages through a field of envelope x: wording, names and addresses.
export const printedWords = (x: any): ((f: any) => string) => {
  // For a group the sender named nobody: who signs is only known when one member finishes. So a group's name and
  // email fields are not wording of the sender's. Like a signing date, they appear when that person has finished.
  // A witness is the same: the signer may name them, or name another one after "I was not there", and changing the
  // witness is not a change to what the signer signed. Their name and address print once they have witnessed.
  const who = new Map<string, any>(x.recipients.map((r: any) => [r.id, r.group_name || r.role === 'witness' ? {} : r]));
  return (f) => (f.type === 'full_name' ? who.get(f.recipient_id)?.name : f.type === 'email' ? who.get(f.recipient_id)?.email : senderText(f)) ?? '';
};

// What is printed on the pages whoever fills them in: the files in their order, where every field sits and whose it
// is, the sender's own wording (names and addresses printed by a field included), and how dates are written. Once
// someone has finished, this only changes if the sender chooses to ask the people who finished to sign again.
function printedView(x: any): string {
  const words = printedWords(x);
  return JSON.stringify({
    docs: x.documents.map((d: any) => [d.id, d.file_id]),
    dates: x.date_format ?? '',
    // logicKey: when a field is shown and what it is worked out from decide what the page says (src/lib/logic.ts).
    // printedStamp: the picture of the sender's own stamp, by its fingerprint. Another picture is another page.
    fields: x.fields.map((f: any) => [f.id, f.document_id, f.recipient_id, f.type, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), f.readonly ? 1 : 0, words(f), logicKey(f), printedStamp(f)]).sort(byFirst),
  });
}

// Everything a signing screen shows or asks for, for anyone. When a correction changes it, the content version goes up.
function seenView(x: any): string {
  const words = printedWords(x);
  return JSON.stringify({
    docs: x.documents.map((d: any) => [d.id, d.file_id, d.name]),
    dates: x.date_format ?? '',
    fields: x.fields.map((f: any) => [f.id, f.document_id, f.recipient_id, f.type, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), f.readonly ? 1 : 0, words(f),
      f.required, f.label ?? '', (f.options || []).join('\n'), f.group_name ?? '', f.validation ?? '', logicKey(f), printedStamp(f)]).sort(byFirst),
  });
}

// What one recipient is being asked to read and fill in. If it changes under them, they are told. Their own name
// is part of it: the screen asks them to sign under that name.
function askView(x: any, recipientId: string): string {
  const words = printedWords(x);
  return JSON.stringify({
    docs: x.documents.map((d: any) => [d.file_id, d.name]),
    me: x.recipients.find((r: any) => r.id === recipientId)?.name ?? '',
    fields: x.fields.filter((f: any) => !f.recipient_id || f.recipient_id === recipientId)
      .map((f: any) => [f.id, f.document_id, f.type, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), f.required, f.label ?? '', words(f), logicKey(f), printedStamp(f)]).sort(byFirst),
    // What the sender wrote in other people's fields is shown to this person as well.
    words: x.fields.filter((f: any) => f.recipient_id && f.recipient_id !== recipientId && words(f))
      .map((f: any) => [f.id, f.document_id, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), words(f)]).sort(byFirst),
  });
}

// The people who have finished, when a change to this person's name or address would change what is printed on
// pages they signed. That is so when the person has a full name field (for the name) or an email field (for the
// address). Such a change needs the sender's sign-again choice, which only correctEnvelope can take.
function signedOverName(e: any, r: any, name: boolean, email: boolean): any[] {
  // A witness's name and address are not on the pages until they have witnessed (printedWords), and then they are done.
  if (r.role === 'witness') return [];
  if (!e.fields.some((f: any) => f.recipient_id === r.id && ((name && f.type === 'full_name') || (email && f.type === 'email')))) return [];
  return e.recipients.filter((x: any) => x.id !== r.id && x.status === 'completed' && x.role !== 'cc');
}

// What the people who have to look again are told changed (last_change). It is the latest change. But while someone
// who was asked to sign again has not done so yet, they are owed everything that changed since they signed, so a
// later change is added to what is already there instead of taking its place. `before` is the envelope as it was.
function changeSaid(before: any, said: string): string {
  const owed = before.last_change && before.recipients.some((r: any) => r.signed_before && r.status !== 'completed');
  return `${owed && !String(before.last_change).includes(said) ? `${before.last_change} ` : ''}${said}`.slice(0, 4000);
}

// A change to one person made outside the editor (a quick correction, a signer fixing their own name) is a change
// like any other. Signing screens that are open on the envelope as it was are told so when they save or finish
// (content_version), what changed is kept in words for them (last_change), and whoever has the document and now
// sees something different is emailed "Updated". `before` is the envelope as it was, `skip` the person who made the
// change themselves or who is being emailed about it anyway.
async function nameChanged(before: any, said: string, skip?: string) {
  run('UPDATE envelopes SET content_version=content_version+1, last_change=? WHERE id=?', changeSaid(before, said), before.id);
  const after = loadEnvelope(before.id);
  for (const r of after.recipients)
    if (r.id !== skip && (r.status === 'sent' || r.status === 'viewed') && askView(before, r.id) !== askView(after, r.id)) await notifyRecipient(after, r, 'updated');
}

// A link that stops working is remembered, and so is the security code of the email that carried it. /check can
// then still say that email was genuine, and why its link stopped: the address or the role was changed, the signer
// handed the document to someone else, or the person was taken off the envelope.
export function retireToken(r: any, why: 'address' | 'role' | 'handed' | 'removed' = 'address') {
  if (r?.token) run('INSERT OR IGNORE INTO retired_tokens (token, recipient_id, retired_at, check_code, envelope_id, sent_to, why) VALUES (?,?,?,?,?,?,?)',
    r.token, r.id, now(), r.check_code || null, r.envelope_id || null, r.name || null, why);
}

// When a request passes to a different person, nothing the first person typed, ticked, uploaded or drew goes with
// it. Fields go back to what the sender put there (which may be nothing), and read-only wording stays as it is.
export function clearAnswers(recipientId: string) {
  run("UPDATE fields SET value=prefill WHERE recipient_id=? AND readonly=0 AND type!='note'", recipientId);
  // A stamp they put on goes with its name and where it came from (stamps.ts).
  run("UPDATE fields SET stamp_id=NULL, stamp_meta=NULL WHERE recipient_id=? AND type='stamp'", recipientId);
  run('UPDATE recipients SET signature_png=NULL, initials_png=NULL, ip=NULL, user_agent=NULL, seen_version=NULL, signed_before=NULL WHERE id=?', recipientId);
  // A witness the first person named and who was not asked yet is theirs too: the next person names their own.
  forgetNamedWitness(recipientId);
}

const ROLE_WORDS: Record<string, string> = { signer: 'signer', approver: 'approver', cc: 'copy recipient', viewer: 'viewer', inperson: 'in-person signer', witness: 'witness' };
const listSome = (l: string[], max = 6) => (l.length > max ? `${l.slice(0, max).join(', ')} and ${l.length - max} more` : l.join(', '));

// A correction in words that someone with no account could follow. `people` says who was added, removed or
// replaced, with addresses, and goes to the audit trail only. `content` says what changed on the documents: files
// (with the fingerprints of both), fields and whose they are, and the sender's own wording. It goes to the audit
// trail too, and to the signers who have to look again, so it names people without their addresses.
// `told` is `content` as it is passed on to the people who sign: the same sentences without the long fingerprints
// of files, followed by anyone whose name is now written differently (their screen asks them to sign under it).
function describeCorrection(a: any, b: any): { people: string[]; content: string[]; other: string[]; told: string[] } {
  const people: string[] = [], content: string[] = [], other: string[] = [], renamed: string[] = [];
  const short = new Map<string, string>();
  const fileLine = (text: (print: (d: any) => string) => string) => {
    const full = text((d) => `, SHA-256 ${d.sha256}`);
    short.set(full, text(() => ''));
    content.push(full);
  };
  const q = (s: any, max = 300) => `"${str(s, max)}"`;
  const who = whoIs; // a person with their address, or a group with its members (src/lib/groups.ts)
  const pages = (n: number) => `${n} page${n === 1 ? '' : 's'}`;
  if (a.subject !== b.subject) other.push(`Subject changed from ${q(a.subject)} to ${q(b.subject)}.`);
  if (a.message !== b.message) other.push(b.message ? `Message to recipients changed to ${q(b.message, 500)}.` : 'Message to recipients removed.');
  if (!!a.ordered !== !!b.ordered) other.push(b.ordered ? 'Signing in order turned on.' : 'Signing in order turned off, so everyone can sign at once.');
  if (a.reminder_days !== b.reminder_days) other.push(b.reminder_days ? `Automatic reminders set to every ${b.reminder_days} day${b.reminder_days === 1 ? '' : 's'}.` : 'Automatic reminders turned off.');
  if ((a.date_format ?? '') !== (b.date_format ?? '')) content.push(`Dates on the document are now written as ${b.date_format}${a.date_format ? `, not ${a.date_format}` : ''}.`);

  const docA = new Map<string, any>(a.documents.map((d: any) => [d.id, d])), docB = new Map<string, any>(b.documents.map((d: any) => [d.id, d]));
  for (const d of b.documents) {
    const o = docA.get(d.id);
    if (!o) fileLine((print) => `Document ${q(d.name)} added (${pages(d.pages)}${print(d)}).`);
    else if (o.file_id !== d.file_id) fileLine((print) => `The file of document ${q(d.name)} was replaced. Before: ${pages(o.pages)}${print(o)}. Now: ${pages(d.pages)}${print(d)}.`);
    if (o && o.name !== d.name) content.push(`Document ${q(o.name)} renamed to ${q(d.name)}.`);
  }
  for (const o of a.documents) if (!docB.has(o.id)) fileLine((print) => `Document ${q(o.name)} removed (${pages(o.pages)}${print(o)}).`);
  const kept = (x: any, y: Map<string, any>) => x.documents.filter((d: any) => y.has(d.id)).map((d: any) => d.id).join();
  if (kept(a, docB) !== kept(b, docA)) content.push('The documents were put in a different order.');

  const recA = new Map<string, any>(a.recipients.map((r: any) => [r.id, r])), recB = new Map<string, any>(b.recipients.map((r: any) => [r.id, r]));
  const place = (r: any) => (b.ordered ? `, place ${r.routing_order} in the signing order` : '');
  for (const r of b.recipients) {
    const o = recA.get(r.id);
    if (!o) {
      people.push(`${who(r)} added as ${ROLE_WORDS[r.role]}${place(r)}.`);
      continue;
    }
    // A group is described by what happened to it and to its members, not by an address it does not have: groups.ts.
    if (o.group_name || r.group_name) {
      people.push(...groupChange(o, r, !!(a.ordered || b.ordered)));
      continue;
    }
    const bits: string[] = [];
    // No address on one side: the sender sends that link themselves (bysender.ts), and the record says so in words.
    if (!sameEmail(o.email, r.email)) people.push(`${who(o)} was replaced by ${who(r)}: the email address changed from ${o.email || 'none'} to ${r.email || 'none'}.`);
    else if (o.name !== r.name) {
      bits.push(`name changed from ${q(o.name)} to ${q(r.name)}`);
      // Where the name is printed by a full name field, the change is said with the page it is on, further down.
      if (!b.fields.some((f: any) => f.recipient_id === r.id && f.type === 'full_name')) renamed.push(`The name ${q(o.name)} is now written ${q(r.name)}.`);
    }
    if (o.role !== r.role) bits.push(`role changed from ${ROLE_WORDS[o.role]} to ${ROLE_WORDS[r.role]}`);
    if (o.routing_order !== r.routing_order && (a.ordered || b.ordered)) bits.push(`place in the signing order changed from ${o.routing_order} to ${r.routing_order}`);
    if ((o.access_code || '') !== (r.access_code || '')) bits.push(!r.access_code ? 'access code removed' : o.access_code ? 'access code changed' : 'access code added');
    if ((o.note || '') !== (r.note || '')) bits.push('private note changed');
    bits.push(...checkBits(o, r), ...witnessBits(o, r, recA, recB));
    if (bits.length) people.push(`${who(r)}: ${bits.join(', ')}.`);
  }
  for (const o of a.recipients) if (!recB.has(o.id)) people.push(`${who(o)}, ${ROLE_WORDS[o.role]}, removed.`);

  // Fields, said per person. The sender's own wording is always quoted in full, because it is part of the deal.
  const fldA = new Map<string, any>(a.fields.map((f: any) => [f.id, f]));
  const fldB = new Map<string, any>(b.fields.map((f: any) => [f.id, f]));
  const many = Math.max(a.documents.length, b.documents.length) > 1;
  const where = (f: any, x: any) => `page ${f.page + 1}${many ? ` of ${q((x === a ? docA : docB).get(f.document_id)?.name, 80)}` : ''}`;
  const name = (f: any, x: any) => `${f.label ? `${q(f.label, 60)} ` : ''}${f.type.replace('_', ' ')} on ${where(f, x)}`;
  // People are called by the name they have after the correction, so one person is one heading.
  const owner = (f: any, _x?: any) => (f.recipient_id ? (recB.get(f.recipient_id) || recA.get(f.recipient_id))?.name || 'someone' : '');
  const per = new Map<string, Record<'added' | 'removed' | 'moved' | 'set', string[]>>();
  const note = (person: string, kind: 'added' | 'removed' | 'moved' | 'set', what: string) => {
    if (!per.has(person)) per.set(person, { added: [], removed: [], moved: [], set: [] });
    per.get(person)![kind].push(what);
  };
  const part = (f: any, x: any) => (f.type === 'note' ? 'as a note' : `in the part for ${owner(f, x)}`);
  const wordsA = printedWords(a), wordsB = printedWords(b);
  for (const f of b.fields) {
    const o = fldA.get(f.id);
    // A name or an address that a field prints is wording on the page too. When it changes, the page says so.
    if (o && printsName(f) && o.type === f.type && wordsA(o) !== wordsB(f)) content.push(`The ${f.type === 'email' ? 'email address' : 'name'} printed on ${where(f, b)} changed from ${q(wordsA(o))} to ${q(wordsB(f))}.`);
    // A strike-out is wording too: the sender's line through what is printed. Said in words of its own.
    if (f.type === 'strike' && (!o || o.type === 'strike')) {
      if (!o) content.push(`The sender struck out wording on ${where(f, b)}.`);
      else if ([o.document_id, o.page, r6(o.x), r6(o.y), r6(o.w), r6(o.h)].join() !== [f.document_id, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h)].join()) content.push(`A strike-out was moved or resized on ${where(f, b)}, so other wording is struck out now.`);
      continue;
    }
    // The sender's own stamp is printed on the page too: put on, changed, moved or taken off (stamps.ts).
    if (isSenderStamp(f) && (!o || isSenderStamp(o))) {
      const said = senderStampChange(b, o, f, where, a, b);
      if (said) content.push(said);
      continue;
    }
    const was = o ? senderText(o) : '', is = senderText(f);
    if (was !== is) content.push(!was ? `New wording from the sender on ${where(f, b)}, ${part(f, b)}: ${q(is, 1000)}.` : !is ? `Wording from the sender removed from ${where(f, b)}: ${q(was, 1000)}.` : `Wording from the sender on ${where(f, b)}, ${part(f, b)}, changed from ${q(was, 1000)} to ${q(is, 1000)}.`);
    if (f.type === 'note' && (!o || o.type === 'note')) {
      if (o && [o.document_id, o.page, r6(o.x), r6(o.y), r6(o.w), r6(o.h)].join() !== [f.document_id, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h)].join()) content.push(`A note was moved to ${where(f, b)}: ${q(is, 1000)}.`);
      continue;
    }
    if (!o) note(owner(f, b), 'added', name(f, b));
    else if (o.recipient_id !== f.recipient_id) (note(owner(o, a), 'removed', name(o, a)), note(owner(f, b), 'added', `${name(f, b)}, which was ${owner(o, a) || 'a note'}'s before`));
    else if (o.type !== f.type) (note(owner(o, a), 'removed', name(o, a)), note(owner(f, b), 'added', name(f, b)));
    else if ([o.document_id, o.page, r6(o.x), r6(o.y), r6(o.w), r6(o.h)].join() !== [f.document_id, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h)].join()) note(owner(f, b), 'moved', o.page === f.page && o.document_id === f.document_id ? name(f, b) : `${name(o, a)} to ${where(f, b)}`);
    else if ([o.required, o.label ?? '', (o.options || []).join('\n'), o.group_name ?? '', o.validation ?? '', o.readonly].join('\u0001') !== [f.required, f.label ?? '', (f.options || []).join('\n'), f.group_name ?? '', f.validation ?? '', f.readonly].join('\u0001')) note(owner(f, b), 'set', name(f, b));
  }
  for (const o of a.fields) {
    if (fldB.has(o.id)) continue;
    if (o.type === 'strike') content.push(`A strike-out was removed from ${where(o, a)}, so the wording under it stands again.`);
    else if (o.type === 'note') content.push(`A note was removed from ${where(o, a)}: ${q(senderText(o), 1000)}.`);
    else if (isSenderStamp(o)) content.push(senderStampChange(a, o, null, where, a, b)!);
    else {
      note(owner(o, a), 'removed', name(o, a));
      if (senderText(o)) content.push(`Wording from the sender removed from ${where(o, a)}: ${q(senderText(o), 1000)}.`);
    }
  }
  // When a field is shown and what a calculated field is worked out from, said in words (logic.ts).
  content.push(...logicChanges(a, b));
  for (const [person, l] of per) {
    const bits = [l.added.length ? `added ${listSome(l.added)}` : '', l.moved.length ? `moved or resized ${listSome(l.moved)}` : '', l.removed.length ? `removed ${listSome(l.removed)}` : '', l.set.length ? `changed the settings of ${listSome(l.set)}` : ''].filter(Boolean);
    content.push(`Fields for ${person}: ${bits.join('; ')}.`);
  }
  return { people, content, other, told: [...content.map((c) => short.get(c) ?? c), ...renamed] };
}

// On an envelope that is signed in order: the people who have the document although someone before them has not
// finished. Follows advance(): a copy at the front of the queue goes out at once and holds nobody up.
function outOfTurn(x: any): any[] {
  if (!x.ordered) return [];
  // A witness takes no place in the order: they follow their own signer, and nobody waits for them (advance).
  const waiting = x.recipients.filter((r: any) => r.status !== 'completed' && r.role !== 'cc' && r.role !== 'witness');
  const turn = Math.min(...waiting.map((r: any) => r.routing_order));
  return waiting.filter((r: any) => (r.status === 'sent' || r.status === 'viewed') && r.routing_order > turn);
}

const finishedHow = (r: any) => (r.role === 'witness' ? 'witnessed' : ACTS(r.role) ? 'signed' : r.role === 'approver' ? 'approved' : 'viewed');

// After a correction: is the person on a request still the one who was there before? The same address, and the same
// name or that name in another spelling (see samePerson).
const sameSigner = (o: any, n: any): boolean => !!n && sameEmail(n.email, o.email) && (n.name === o.name || samePerson(o.name, n.name));

// A signature that no longer stands because the sender changed what was signed. It is never thrown away: the audit
// trail says when it was given, from where and what was entered, and the signature itself is kept (earlier_signatures).
function setAside(e: any, o: any, actor: Actor, after?: any) {
  // `after` is the same recipient once the correction is saved: gone, handed to someone at another address, or asked again.
  const removed = !after, passed = !!after && !sameSigner(o, after);
  const answers = e.fields.filter((f: any) => f.recipient_id === o.id && !f.readonly && f.value != null && f.value !== '')
    .map((f: any) => ({ id: f.id, type: f.type, label: f.label, document_id: f.document_id, page: f.page, value: f.value }));
  run('INSERT INTO earlier_signatures (envelope_id, recipient_id, name, email, role, completed_at, ip, signature_png, initials_png, answers, set_aside_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    e.id, o.id, o.name, o.email, o.role, o.completed_at, o.ip, o.signature_png, o.initials_png, JSON.stringify(answers), now());
  const said = answers.filter((a: any) => a.type !== 'signature' && a.type !== 'initials')
    .map((a: any) => `${a.label || a.type.replace('_', ' ')} on page ${a.page + 1}: ${a.type === 'checkbox' || a.type === 'radio' ? 'ticked' : a.type === 'attachment' ? 'a file' : a.type === 'stamp' ? `a stamp, whose picture has the SHA-256 ${str(a.value, 64)}` : `"${str(a.value, 300)}"`}`);
  const mark = ACTS(o.role) ? 'signature' : o.role === 'approver' ? 'approval' : 'confirmation';
  audit(e.id, actor, removed || passed ? `Earlier ${mark} set aside` : ACTS(o.role) ? 'Asked to sign again' : o.role === 'approver' ? 'Asked to approve again' : 'Asked to look again',
    `${o.name} <${o.email}> ${finishedHow(o)} on ${ts(o.completed_at)}${o.ip ? ` from ${o.ip}` : ''}. The sender changed the envelope after that, so that ${mark} no longer counts. It is kept on record${o.signature_png ? `, with a signature image whose SHA-256 is ${sha256(o.signature_png)}` : ''}.`
    + `${said.length ? ` What they had entered: ${listSome(said, 40)}.` : ''} ${removed ? 'They were taken off the envelope.' : passed ? `Their place on the envelope went to ${whoIs(after)}.` : `They are asked to look at the changed document and ${ACTS(o.role) ? 'sign' : o.role === 'approver' ? 'approve' : 'confirm'} again.`}`);
}

// Change an envelope that is already out for signature, without voiding it. Anything goes until someone has
// finished. After that, names, addresses and the order of the people who are left can still change, but what is
// printed on the documents (the files, the sender's wording, the fields and how dates are written) and the people
// who finished stay as they are, unless the sender chooses to ask those people to sign again. That choice is the
// same request with "resign": true. Without it, such a change is refused with 409 and nothing is saved.
export async function correctEnvelope(e: any, body: any, accountId: string, actor: Actor) {
  if (e.kind !== 'envelope' || e.status !== 'sent') throw bad('Only envelopes that are out for signature can be changed.');
  const done = e.recipients.filter((r: any) => r.status === 'completed' && r.role !== 'cc');
  const oldById = new Map<string, any>(e.recipients.map((r: any) => [r.id, r]));
  const removed: any[] = [];
  // People who had finished and whose place this correction gives to someone at another address. They are told.
  const replaced = new Set<string>();
  // People who had finished and are asked to sign again.
  let asked: any[] = [];
  const changedFor: any[] = [];
  const held: any[] = [];
  // People whose request went to another person at the same address, in words for the record.
  const swapped: string[] = [];
  // Who takes the place of somebody else on a request (another address, or another name at the same address).
  const newPeople: string[] = [];
  let after: any;
  tx(() => {
    assertFresh(e, body);
    writeContent(e, body, accountId, true, actor);
    after = loadEnvelope(e.id);
    const nowById = new Map<string, any>(after.recipients.map((r: any) => [r.id, r]));
    const changes = describeCorrection(e, after);
    // Who would have to sign again: everyone who finished when what is printed changed, and anyone who finished
    // and is themselves changed or taken off.
    const printed = printedView(after) !== printedView(e);
    const touched = (o: any) => {
      const n = nowById.get(o.id);
      return !n || n.role !== o.role || n.name !== o.name || !sameEmail(n.email, o.email) || n.routing_order !== o.routing_order;
    };
    // A witness who finished goes with the signature they saw, and is moved only with the same choice (witness.ts).
    const again: any[] = withWitnesses(done, done.filter((o: any) => printed || touched(o)), nowById);
    if (again.length && body.resign !== true) {
      const names = listSome(again.map((o: any) => o.name), 8);
      const all = [...changes.content, ...changes.people.filter((p) => again.some((o: any) => p.includes(`<${o.email}>`)))];
      const what = `${all.slice(0, 8).join(' ')}${all.length > 8 ? ` And ${all.length - 8} more changes.` : ''}`;
      throw bad(`${names} ${again.length === 1 ? 'has' : 'have'} already finished, and this change touches what they signed. ${what} Nothing was saved. To save it, send the same request with "resign": true. ${names} will then be told what changed and asked to sign again, and the first signature stays on record. Names, email addresses and the order of the people who have not finished can change without that.`,
        409, { code: 'sign_again', sign_again: again.map((o: any) => o.name), changes: all });
    }
    const againIds = new Set<string>(again.map((o: any) => o.id));
    // Whoever is asked to sign again keeps a copy of what they signed (below). While no file can be stored, the
    // correction waits rather than losing that copy (src/server/filestore.ts).
    if (again.length) assertCanStore();
    assertSendable(after);
    // A correction is checked like a first send. The fake-notice filter reads the corrected text, and the words in
    // which the people who have the document are told what changed. Everyone who is added, or whose address
    // changes, counts towards the daily limit, and none of that is allowed while paused.
    assertCodes(after.recipients, oldById);
    // Every member who is added to a group, or comes with a group that is added, is a person newly emailed too.
    // Someone added with no address, whose link the sender passes on, is a new person too (reachKey in bysender.ts).
    const reach = after.recipients.filter((r: any) => !oldById.has(r.id) || !sameEmail(oldById.get(r.id)?.email, r.email)).map(reachKey).filter(Boolean).concat(groupReachNew(e, after));
    assertMayEmail(after, reach, { pause: reach.length > 0, extra: changes.content });
    noteReached(after, reach);
    // A new access code starts clean: wrong tries at the old one are forgotten, and a frozen code opens again.
    for (const r of after.recipients) if (oldById.has(r.id) && (oldById.get(r.id).access_code || '') !== (r.access_code || '')) run('UPDATE recipients SET code_fails=0, code_frozen_at=NULL WHERE id=?', r.id);
    const sender = senderOf(e) || { email: '', name: '' };
    for (const r of after.recipients) {
      const old = oldById.get(r.id);
      // Whether a signature is paid for is settled when a person is added or their address changes, and kept otherwise.
      if (!old || !sameEmail(old.email, r.email) || old.free == null || old.role !== r.role || old.name !== r.name) run('UPDATE recipients SET free=? WHERE id=?', isSelf(r, sender) ? 1 : 0, r.id);
      if (!old) {
        run('UPDATE recipients SET token=?, check_code=? WHERE id=?', token(), checkCode(), r.id);
        continue;
      }
      const otherPerson = !sameEmail(old.email, r.email);
      // The same address under a name that is not the old one in another spelling is another person too: a couple
      // or an office can share an inbox (see samePerson). The link stays, because it went to that inbox. Nothing the
      // first person agreed to, typed, ticked, uploaded or drew stays with it: see below.
      const otherName = !otherPerson && old.name !== r.name && !samePerson(old.name, r.name);
      // Another person is the next person on the request: what the one before paid for or signed is not theirs, so
      // their signature is their own (sigRef in credits.ts), and the check for signatures below counts it.
      if (otherPerson || otherName) {
        // Someone the request had before (renamed away and back) is that person again (personGen in credits.ts).
        const pg = personGen(old, r.name, r.email);
        // The time zone the one before reported is theirs too: the new person starts without it.
        run('UPDATE recipients SET person_gen=?, person_gens=?, tz=NULL, reminder_held_at=NULL WHERE id=?', pg.gen, pg.gens, r.id);
        newPeople.push(`${r.name} in the place of ${old.name}`);
      }
      if (old.status === 'completed' && old.role === 'cc') {
        // Someone who only had a copy. A new address gets its own copy, and a new job means they are asked to do it.
        if (!otherPerson && r.role === 'cc') continue;
        retireToken(old, otherPerson ? 'address' : 'role');
        run("UPDATE recipients SET status='pending', token=?, check_code=?, sent_at=NULL, completed_at=NULL WHERE id=?", token(), checkCode(), r.id);
        continue;
      }
      if (againIds.has(r.id)) {
        // Finished, and asked to sign again. They go back in the queue and are emailed when it is their turn. What
        // they typed is still there for them to check, but each signature has to be placed again. The first one is
        // set aside below, never lost. It was counted when they signed, so signing again never uses a second one.
        run("UPDATE recipients SET status='pending', completed_at=NULL, sent_at=NULL, viewed_at=NULL, unopened_alerted_at=NULL, signed_before=? WHERE id=?",
          [old.signed_before, old.completed_at].filter(Boolean).join('\n'), r.id);
        if (!otherPerson && !otherName) run('UPDATE recipients SET free=1 WHERE id=?', r.id);
        // Their place goes to someone else. The person who signed is told, like someone who is taken off.
        else (replaced.add(old.id), removed.push(old));
        // A stamp is put on again like a signature: the first one is set aside with it (earlier_signatures).
        run("UPDATE fields SET value=NULL WHERE recipient_id=? AND type IN ('signature','initials','stamp')", r.id);
      } else if (old.status === 'completed') continue;
      if (otherPerson || old.role !== r.role) {
        // A different person or a different job: the old link dies and they are asked afresh when it is their turn.
        // A different person starts with empty fields. The clock for "not opened yet" starts with their own email.
        retireToken(old, otherPerson ? 'address' : 'role');
        if (otherPerson) clearAnswers(r.id);
        run("UPDATE recipients SET status='pending', token=?, check_code=?, sent_at=NULL, viewed_at=NULL, consent_at=NULL, muted=0, unopened_alerted_at=NULL, dead_link_alerted_at=NULL WHERE id=?", token(), checkCode(), r.id);
      } else if (old.status !== 'pending' && !againIds.has(r.id) && askView(e, r.id) !== askView(after, r.id)) changedFor.push(r);
      if (otherName) {
        // A signature, initials and answers belong to the person who made them. The new person starts with empty
        // fields and agrees for themselves, like someone at a new address does.
        clearAnswers(r.id);
        run("UPDATE recipients SET consent_at=NULL, viewed_at=NULL, muted=0, status=CASE WHEN status='viewed' THEN 'sent' ELSE status END WHERE id=?", r.id);
        swapped.push(`${r.name} took the place of ${old.name} at the same address. That is another person, so nothing that ${old.name} had agreed to, filled in or signed was kept for them.`);
      }
    }
    for (const old of e.recipients) {
      if (nowById.has(old.id)) continue;
      retireToken(old, 'removed');
      if (old.status === 'sent' || old.status === 'viewed' || againIds.has(old.id)) removed.push(old);
    }
    // The signing order holds for people who already have the document too. Anyone who is now behind a person who
    // has not finished gives the turn back: their link says so, and they are emailed again when it comes round.
    for (const r of outOfTurn(loadEnvelope(e.id))) {
      run("UPDATE recipients SET status='pending', sent_at=NULL, unopened_alerted_at=NULL WHERE id=?", r.id);
      held.push(r);
    }
    // Members get their links, and a group nobody has taken on keeps none of its own: see settleGroups in groups.ts.
    settleGroups(e.id);
    // A witness whose signer is asked to sign again waits for that signature again (witness.ts).
    settleWitnesses(e.id);
    if (creditsEnabled()) {
      // Signers added by this correction need signatures like any others. A change that needs no more than before
      // (a name, a field, a date) is never refused, whatever the balance.
      const more = needed(loadEnvelope(e.id), sender) - needed(e, sender);
      const have = available(e.account_id);
      if (more > 0 && have < 0) throw bad(`${newPeople.length ? `This change puts ${listSome(newPeople)}, and another person signs with a signature of their own, also at the same address. Nothing was saved. ` : ''}${outOfSignatures(get('SELECT * FROM accounts WHERE id=?', e.account_id), more, have + more)}`, 402);
    }
    const pages = after.documents.reduce((n: number, d: any) => n + d.pages, 0);
    run('UPDATE envelopes SET sheets=? WHERE id=?', sheetsSaved(pages, after.recipients.length), e.id);
    // Signing screens that are open on the old content are told so when they save or finish: see completeRecipient.
    // A person's own name is on their screen too (they are asked to sign under it), so a new spelling counts.
    const renamed = after.recipients.some((r: any) => oldById.has(r.id) && oldById.get(r.id).name !== r.name);
    if (seenView(after) !== seenView(e) || renamed) run('UPDATE envelopes SET content_version=content_version+1 WHERE id=?', e.id);
    // What the documents changed to, in words that can be passed on to the people who have to look again. They get
    // it without the long fingerprints of files, which stay in the audit trail.
    if (changes.told.length) run('UPDATE envelopes SET last_change=? WHERE id=?', changeSaid(e, changes.told.join(' ')), e.id);
    // The audit trail, and so the certificate, says what was changed and what it meant for the people on the
    // envelope. A save that changed nothing leaves no line.
    const said = [...changes.other, ...changes.people, ...changes.content,
      ...swapped,
      ...again.filter((o: any) => sameSigner(o, nowById.get(o.id))).map((o: any) => `${o.name} had already ${finishedHow(o)} and is asked to ${ACTS(o.role) ? 'sign' : o.role === 'approver' ? 'approve' : 'look'} again.`),
      ...held.map((r: any) => `${r.name} had the document and now waits, because someone before them in the signing order has not finished.`)];
    if (said.length) audit(e.id, actor, 'Envelope corrected', said.join(' '));
    // A document made from a Word file or the like says what it was made from (converted.ts).
    convertedAdded(e, after, actor);
    for (const o of again) setAside(e, o, actor, nowById.get(o.id));
    witnessesSetAside(e, again, nowById, actor);
    asked =again.filter((o: any) => sameSigner(o, nowById.get(o.id)));
    after = loadEnvelope(e.id);
  });
  // Everyone who is asked to sign again keeps a copy of the document exactly as they signed it: it is made here,
  // from the envelope as it was before this correction, and stored with the signature that was set aside. That is
  // what keeps "you can download what you signed" true after the pages have changed. See earlierCopy.
  for (const o of asked) {
    try {
      const pdf = await buildPdf(e, false, o.id, undefined, false);
      run('UPDATE earlier_signatures SET copy_sha256=? WHERE id=(SELECT MAX(id) FROM earlier_signatures WHERE envelope_id=? AND recipient_id=?)', saveBlob(pdf), e.id, o.id);
    } catch (err: any) {
      console.error('[pdf] could not keep a copy of what was signed before a correction', e.id, err?.message);
    }
  }
  const sender = senderOf(e);
  const mail = { envelopeId: e.id, brand: brandOf(e.account_id), replyTo: sender.email, fromName: sender.name };
  // A paused sender may still put something right for the people who have the document (a correction that changes
  // no person), but nobody is emailed about it: the signing page says what changed, and the record says why no
  // email went out. "Updated" is held back by notifyRecipient itself.
  const quiet = !!get('SELECT suspended_at s FROM accounts WHERE id=?', e.account_id)?.s;
  const unsaid = quiet ? [...removed, ...held, ...changedFor].filter((r: any) => r.role !== 'inperson') : [];
  if (unsaid.length) audit(e.id, { name: 'System' }, 'Change not emailed', `Sending is paused on the account, so nobody was emailed about this change: ${listSome([...new Set(unsaid.map((r: any) => r.name))])}. The signing page shows it.`);
  // groupPeople: for a group nobody has taken on, each member who was sent the document is written to (groups.ts).
  // Nobody without an address is written to: someone whose link the sender passes on is told by the sender, if at all.
  for (const r of quiet ? [] : removed.flatMap(groupPeople))
    if (r.role !== 'inperson' && !r.complained_at && r.email) // nothing more is emailed to someone who marked this envelope's email as spam
      await sendMail({ to: r.email, subject: `No longer needed: ${e.subject}`, heading: r.status === 'completed' ? 'You are no longer on this document' : 'You no longer need to sign this',
        lines: [r.status === 'completed' ? `${sender.name} changed the document and ${replaced.has(r.id) ? 'gave your place on it to someone else' : 'took you off it'}. What you ${finishedHow(r)} on ${ts(r.completed_at)} is no longer part of it${replaced.has(r.id) ? ', and it is kept on record' : ''}. There is nothing more for you to do.` : `${sender.name} changed the document and you are no longer on it. There is nothing more for you to do.`], ...mail });
  for (const r of quiet ? [] : held.flatMap(groupPeople))
    if (r.role !== 'inperson' && !r.complained_at && r.email)
      await sendMail({ to: r.email, subject: `Not your turn yet: ${after.subject}`, heading: 'It is not your turn yet',
        lines: [`${sender.name} changed this document, and someone who signs before you now has to finish first. Until they have, the link you have says it is not your turn yet.`, 'You do not need to do anything now. We will email you as soon as it is your turn. Anything you already filled in is kept.'], recipientId: r.id, ...mail });
  for (const r of changedFor) if (!held.some((h) => h.id === r.id)) await notifyRecipient(after, r, 'updated');
  fireWebhooks(e.account_id, 'envelope.corrected', e.id);
  // Someone who has the document and was just set to get the link by text, or whose number changed, is texted now.
  await textWaiting(e.id);
  // Members added to a group that has the document get their link now, and members taken out are told: groups.ts.
  await groupsCorrected(e, notifyRecipient);
  await advance(e.id);
}

// Copies an envelope or template into a new draft. Used for templates, cloning, bulk send and PowerForms.
export function copyEnvelope(src: any, o: { accountId: string; senderId: string; kind: 'envelope' | 'template'; subject?: string; message?: string; fill?: Record<string, { name?: string; email?: string; locale?: string | null }>; extra?: Record<string, any> }): string {
  const eid = id(o.kind === 'template' ? 'tpl' : 'env');
  const t = now();
  tx(() => {
    // pay_url, pay_kind: the link to the sender's own payment page goes with the copy (src/server/routes-paylink.ts),
    // still as the page of whoever set it (pay_set_by), so it goes when they leave the team (paydrop.ts).
    run('INSERT INTO envelopes (id, account_id, sender_id, kind, subject, message, ordered, reminder_days, expire_days, date_format, template_id, powerform_id, bulk_id, created_at, updated_at, pay_url, pay_kind, pay_set_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      eid, o.accountId, o.senderId, o.kind, str(o.subject ?? src.subject, 200), str(o.message ?? src.message, 5000), src.ordered, src.reminder_days, src.expire_days, src.date_format,
      src.kind === 'template' ? src.id : src.template_id, o.extra?.powerform_id ?? null, o.extra?.bulk_id ?? null, t, t, src.pay_url ?? null, src.pay_kind ?? null, src.pay_url ? src.pay_set_by || src.sender_id : null);
    const dmap = new Map<string, string>();
    const rmap = new Map<string, string>();
    for (const d of src.documents) {
      dmap.set(d.id, id('doc'));
      run('INSERT INTO documents (id, envelope_id, file_id, name, position) VALUES (?,?,?,?,?)', dmap.get(d.id), eid, d.file_id, d.name, d.position);
    }
    for (const r of src.recipients) {
      rmap.set(r.id, id('rcp'));
      const fill = o.fill?.[r.id] || (r.role_name ? o.fill?.[r.role_name] : undefined) || {};
      const email = str(fill.email ?? r.email, 254).trim();
      if (email && !isEmail(email)) throw bad(`"${email}" is not a valid email address.`);
      run('INSERT INTO recipients (id, envelope_id, role, role_name, name, email, routing_order, position, access_code, note) VALUES (?,?,?,?,?,?,?,?,?,?)',
        rmap.get(r.id), eid, r.role, r.role_name, str(fill.name ?? r.name, 120).trim(), email, r.routing_order, r.position, r.access_code, r.note);
      // The check before the document opens goes with the copy, and a filled-in role may bring its own "phone".
      copyCheck(r, rmap.get(r.id)!, fill);
      // A group stays a group in the copy, whoever acted for it on the original (groups.ts).
      copyGroup(r, rmap.get(r.id)!);
      // So does "I will send the link myself", from an envelope to an envelope (bysender.ts).
      copyBySender(r, rmap.get(r.id)!, fill, o.kind);
      // And their language, or the one a bulk row or a form visitor's browser gives (locales.ts).
      copyLocale(r, rmap.get(r.id)!, fill);
    }
    // A witness stays the witness of the same person in the copy, and one the signer names is named afresh (witness.ts).
    copyWitnesses(src, rmap);
    // Which field of the copy is which, so the rules and formulas point at the copy's own fields (copyLogic below).
    const fmap = new Map<string, string>();
    for (const f of src.fields) {
      // Values entered by signers are never copied, only what the sender prefilled.
      // In a draft every value is the sender's. In an envelope that went out, a field a signer could change holds
      // the sender's own wording in prefill, and that is what the copy starts with.
      const keepValue = f.readonly || f.type === 'note' || src.status === 'draft';
      const value = ['signature', 'initials', 'attachment', ...AUTO_TYPES].includes(f.type) ? null : keepValue ? f.value : f.prefill;
      run('INSERT INTO fields (id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, label, value, options, group_name, validation, readonly, prefill) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        fmap.set(f.id, id('fld')).get(f.id), eid, dmap.get(f.document_id), f.recipient_id ? rmap.get(f.recipient_id) : null, f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.label,
        value, JSON.stringify(f.options || []), f.group_name, f.validation, f.readonly, f.readonly || f.type === 'note' ? null : value);
    }
    // The sender's own stamp goes with every copy, with the picture it has (stamps.ts).
    copyStamps(src, fmap);
    // Who may use and change a template, and the lock on its wording, go with every copy (tplroles.ts).
    carryRules(src, eid, o.kind);
    // "Only show when" and formulas go with the copy, and a bulk send row may fill fields they depend on (logic.ts).
    copyLogic(src, fmap, eid, o.extra?.values);
  });
  return eid;
}

// ---- Sending and routing -------------------------------------------------------------------

export const billingEnabled = () => !!process.env.STRIPE_SECRET_KEY;

// Said whenever someone runs out of signatures. Nothing is ever charged without them choosing it.
export function outOfSignatures(account: any, need: number, have: number): string {
  const short = `This needs ${need} signature${need === 1 ? '' : 's'} and you have ${Math.max(0, have)} left.`;
  const how = account.plan === 'grove'
    ? `Top up on the Plan page: $${PRICING.topUpUsd} a signature, and every dollar plants ${PRICING.treesPerUsd} mangrove trees.`
    : `The monthly plan is $${PRICING.monthlyUsd} for ${PRICING.monthlySignatures} signatures, and every dollar plants ${PRICING.treesPerUsd} mangrove trees.`;
  return `${short} ${how} Nothing is charged unless you choose it. Signing your own documents stays free.`;
}

// ---- Keeping scammers and strangers out ----------------------------------------------------
//
// Three rules stand between a new account and somebody's inbox: a pause, a filter for fake payment notices and a
// daily limit on how many people can be newly emailed. They are checked in one place, emailRefusal(). It is asked
// where a sender starts something that emails a recipient (a send, a correction, a reminder, reopening, a bulk
// send, a public form, passing a request on) and again where the email to the next person is written (advance), so
// a name changed after sending, or a pause that arrives while people wait in a signing order, is not walked around.
// Team invitations have the same three rules in a guard of their own (inviteRefusal).

// The filter and the limits apply until an account has earned trust: a payment for the plan or a top-up that is at
// least PAID_TRUST_DAYS old and was neither refunded nor disputed, or a person's word (trusted_at, set from the
// operator queue). Paying does not switch them off at once: nine dollars must not buy a day of fake notices to
// hundreds of people, to be taken back the same evening. The name is from when any payment was enough.
// A payment counts when it stands (STANDING_PAYMENT in credits.ts): a small refund the software sent by itself because
// more was charged than we said does not undo it.
export function hasNotPaid(account: any): boolean {
  if (!account || account.trusted_at) return false;
  return !get(`SELECT 1 x FROM payments WHERE account_id=? AND ${STANDING_PAYMENT} AND at <= ? LIMIT 1`,
    account.id, new Date(Date.now() - PAID_TRUST_DAYS * 864e5).toISOString());
}
// The payment that will lift the checks once it is old enough, if the account has one: the day it was made.
const youngPayment = (account: any): string | null =>
  get(`SELECT MIN(at) at FROM payments WHERE account_id=? AND ${STANDING_PAYMENT}`, account.id)?.at || null;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// How many people this account may newly email in a day while the limit applies to it.
export function dailyCap(account: any): { cap: number; firstWeek: boolean } {
  const firstWeek = Date.now() - Date.parse(account.created_at) < 7 * 864e5;
  return { cap: firstWeek ? newAccountDailyRecipients() : unpaidDailyRecipients(), firstWeek };
}

// What a pause stops, in one sentence that every refusal and every email about a pause uses. It lists what the code
// holds back, no more: see emailRefusal, advance, notifyRecipient, correctEnvelope, voidEnvelope and inviteRefusal.
export const PAUSED_MEANS = 'Until a person has looked at it, nothing a sender starts is emailed to anyone: no new envelopes, no new or changed recipients, no reminders, no reopening, no team invitations, no email about a change to a document, and nobody who is waiting further down a signing order is asked. What recipients do themselves still works and is confirmed to them: signing, declining, the copy when everyone has finished, a link they ask for again. The one exception is a one-time code by text message: no text is sent while paused, so someone whose document asks for one cannot open it until the pause is lifted or you switch them to a code by email (Correct, next to their name). An envelope can still be voided, and the people on it are told so without the reason.';
// Said by every path that is refused while an account is paused, with the reason the pause was really given for.
export function pausedText(account: any): string {
  const why = String(account.suspended_reason || 'it is under review').replace(/[.\s]+$/, '');
  return `Sending is paused on this account. Reason: ${why}. ${PAUSED_MEANS} People who already have a document can still open, sign and download it, and you can still open, download and export everything. If this is a mistake, use the contact form at ${baseUrl()}/help and a person will review it.`;
}

// Said wherever something is refused because the account is being closed. Nothing new starts in an account that is
// about to be deleted: what was sent, and whoever joined, would be deleted with it. `what` says what was refused.
export function closingText(account: { name: string; closing_at: string }, what: string): string {
  return `${account.name} is being closed and will be deleted on ${String(account.closing_at).slice(0, 10)}. ${what}. If its owner signs in before that day, the account is restored at once and this works again.`;
}

// Fake payment notices ("your PayPal order, call this number") are the classic way e-signature services get abused.
// How text is read (look-alike letters, glued and spaced spellings, what counts as a brand, as words about money
// and as a phone number) is in fakenotice.ts. Here: what is read, and what the sender is told.

// A name an email would go out under that reads like a well-known brand, or like the notice itself. Asked wherever a
// name is about to be printed to someone (before an envelope's email, before an invitation, on a public form's page)
// and when a person or an account that the checks apply to is renamed. Sign-up does not ask: a new login emails
// nobody until one of those does. Returns what to tell them, or null.
export function nameRefusal(names: any[]): string | null {
  for (const name of names) {
    const brand = posesAs(name);
    if (brand) return `The name "${str(name, 120)}" reads like ${brand}. Emails that seem to come from a well-known company are how people get tricked, so this account cannot send under a name like that. Use your own name (Settings, Profile) and the name of your own organisation (Settings, Account). If you really do send for ${brand}, use the contact form at ${baseUrl()}/help and a person will clear your account. ${paidTrustText()}`;
  }
  const lure = lureIn(names);
  return lure ? lureText(lure, 'These names read') : null;
}
const lureText = (l: { brand: string; money: string; phone: string }, what = 'This reads') =>
  `${what} like a payment notice from a well-known brand with a phone number to call, which is how scams look. What set this off: the name ${l.brand}, words about money ("${l.money}") and what looks like a phone number (${l.phone}), all in what one person would be sent. If that is not what you mean, take one of the three out. If it is genuine, use the contact form at ${baseUrl()}/help and a person will clear your account. ${paidTrustText()}`;

// Reads everything a recipient is emailed: the subject, the message, each note to a recipient, the document names,
// the sender's own wording on the pages and the labels of fields (a notice about a change quotes both), the names of
// recipients where an email prints them for someone else (people who share an address), and the names the email
// goes out under (the sender's and the account's, which is also the brand line). `extra` is further text that
// would be mailed with it: what a correction changed, the reason for voiding. Returns what to tell the sender when
// it must not go out, or null.
function fakeNotice(e: any, account: any, sender: any, extra: any[] = []): string | null {
  const posing = [sender?.name, account?.name].find((name) => posesAs(name));
  if (posing) return nameRefusal([posing]);
  const shared =e.recipients.filter((r: any) => r.email && e.recipients.some((x: any) => x.id !== r.id && sameEmail(x.email, r.email)));
  // A formula is shown to the signer in words, numbers and all, so it is read too (src/lib/logic.ts).
  const lure = lureIn([e.subject, e.message, ...e.recipients.map((r: any) => r.note), ...e.documents.map((d: any) => d.name), ...(e.fields || []).flatMap((f: any) => [senderText(f), f.label, f.formula]),
    ...shared.map((r: any) => r.name), sender?.name, account?.name, ...extra,
    // The name of a group is printed in every member's email, and a member's name on the other members' screens.
    ...groupWords(e)]);
  return lure ? lureText(lure) : null;
}

// Everyone an account newly emailed in the last 24 hours, with the time of the latest email to each of them. `via`
// keeps three counts apart: the people a sender chose to email (null), the visitors of one public form ('form:' and
// its id) and the people invited to the team ('invite'). A stranger filling in a form does not use up what the
// owner may send, and the other way round.
function reachedToday(accountId: string, via: string | null = null): Map<string, string> {
  return new Map(all('SELECT lower(email) email, MAX(at) at FROM reached WHERE account_id=? AND at > ? AND via IS ? GROUP BY lower(email)', accountId, new Date(Date.now() - 864e5).toISOString(), via).map((x) => [x.email, x.at]));
}
// How many of `emails` would be new today, and when there is room again if that is too many for `cap`.
function roomFor(have: Map<string, string>, emails: string[], cap: number): { fresh: number; when: string } | null {
  const fresh = new Set(emails.map((x) => String(x || '').trim().toLowerCase()).filter((x) => x && !have.has(x)));
  const over = have.size + fresh.size - cap;
  if (!fresh.size || over <= 0) return null;
  // Room comes back as the oldest of today's people pass the 24 hour mark.
  const times = [...have.values()].sort();
  const hours = over <= times.length ? Math.max(1, Math.ceil((Date.parse(times[over - 1]) + 864e5 - Date.now()) / 3600_000)) : 0;
  return { fresh: fresh.size, when: hours ? `There is room for this again in about ${hours} hour${hours === 1 ? '' : 's'}, because the limit looks at the last 24 hours.` : 'That is more than the limit allows in one day' };
}
// Who the limit applies to and how it is lifted, in words. An account that has paid is told the day its payment is
// old enough, so nobody is left to think that paying did nothing.
function limitWords(account: any): { who: string; lift: string } {
  const paid = youngPayment(account);
  const person = `use the contact form at ${baseUrl()}/help and a person can lift it for you.`;
  if (paid) return { who: `An account whose first payment is less than ${PAID_TRUST_DAYS} days old`, lift: `Your payment was made on ${paid.slice(0, 10)}, so the limit goes on ${day(Date.parse(paid) + PAID_TRUST_DAYS * 864e5)}, provided the payment is not refunded or disputed. To have it lifted sooner, ${person}` };
  return { who: dailyCap(account).firstWeek ? 'In its first week, an account that has not paid' : 'An account that has not paid',
    lift: billingEnabled() ? `To lift the limit, pay for anything on the Plan page (the monthly plan is the place to start): the limit goes ${PAID_TRUST_DAYS} days after a payment that is not refunded or disputed. To have it lifted sooner, ${person}` : `To lift the limit, ${person}` };
}
// The daily limit counts people, however a sender reaches them: a first send, a person added or an address changed
// by a correction, a bulk row. Writing to someone again who was already reached today is never refused.
function overDailyLimit(account: any, emails: string[]): string | null {
  const { cap } = dailyCap(account);
  const have = reachedToday(account.id);
  const room = roomFor(have, emails, cap);
  if (!room) return null;
  const { who, lift } = limitWords(account);
  return `${who} can send to ${cap} people a day. This account has sent to ${have.size} in the last 24 hours and this would add ${room.fresh}. ${room.when}${room.when.endsWith('.') ? '' : ', so send to fewer people at a time.'} ${lift}`;
}
// A public form has a limit of its own, as high as the account's: the people who start it are counted for that form
// and not against what the owner may send, so a stranger with made-up addresses can fill a form's day but never
// stop its owner from writing to a customer. Said to the owner, never to the visitor.
function overFormLimit(account: any, formId: string, visitor: string): string | null {
  const { cap } = dailyCap(account);
  const have = reachedToday(account.id, `form:${formId}`);
  const room = roomFor(have, [visitor], cap);
  if (!room) return null;
  const { who, lift } = limitWords(account);
  return `This public form has been started by ${have.size} people in the last 24 hours. ${who} can take ${cap} new people a day on each public form. They are counted for the form alone, so this does not use up what you can send yourself. ${room.when}${room.when.endsWith('.') ? '' : '.'} ${lift}`;
}
// One line for each person newly emailed, written in the same step as the send or the correction it belongs to.
export function noteReached(e: { account_id: string; id?: string }, emails: string[], via: string | null = null) {
  const t = now();
  run('DELETE FROM reached WHERE account_id=? AND at < ?', e.account_id, new Date(Date.now() - 2 * 864e5).toISOString());
  for (const email of new Set(emails.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))) run('INSERT INTO reached (account_id, email, envelope_id, at, via) VALUES (?,?,?,?,?)', e.account_id, email, e.id ?? null, t, via);
}

// The one guard. `reach` is the addresses the action would email for the first time; leave it empty for an action
// that only writes to people who already have the document (a reminder). `pause: false` is for a correction that
// changes no person: a paused sender may still fix a typo, and nobody is emailed about it (see correctEnvelope).
// `extra` is further text that would be mailed. `visitor` is the address typed into a public form, which is counted
// against the form's own limit.
type Guard = { pause?: boolean; extra?: any[]; visitor?: string };
export function emailRefusal(e: any, reach: string[] = [], o: Guard = {}): { status: number; message: string } | null {
  const account = get('SELECT * FROM accounts WHERE id=?', e.account_id);
  if (!account) return null;
  if (account.suspended_at && o.pause !== false) return { status: 403, message: pausedText(account) };
  if (!hasNotPaid(account)) return null;
  const fake = fakeNotice(e, account, senderOf(e), o.extra);
  if (fake) return { status: 422, message: fake };
  const over = (reach.length ? overDailyLimit(account, reach) : null) || (o.visitor && e.powerform_id ? overFormLimit(account, e.powerform_id, o.visitor) : null);
  return over ? { status: 429, message: over } : null;
}
export function assertMayEmail(e: any, reach: string[] = [], o: Guard = {}) {
  const no = emailRefusal(e, reach, o);
  if (no) throw bad(no.message, no.status);
}

// A team invitation is an email to an address the account chose, under the names the account chose, so it has the
// same rules as an envelope: none while paused, no name that reads like a brand or a notice (while the checks apply
// to the account), and a daily limit of its own, which a person lifts by marking the account as trusted.
export function inviteRefusal(account: any, inviter: any, email: string): { status: number; message: string } | null {
  if (account.suspended_at) return { status: 403, message: pausedText(account) };
  const fake = hasNotPaid(account) ? nameRefusal([inviter?.name, account.name]) : null;
  if (fake) return { status: 422, message: fake };
  if (account.trusted_at) return null;
  const have = reachedToday(account.id, 'invite');
  const room = roomFor(have, [email], TEAM_INVITES_PER_DAY);
  return room ? { status: 429, message: `A team can invite ${TEAM_INVITES_PER_DAY} people a day, and this one has invited ${have.size} in the last 24 hours. ${room.when}${room.when.endsWith('.') ? '' : '.'} If you need to invite more people today, use the contact form at ${baseUrl()}/help and a person can lift the limit for you.` } : null;
}
export const noteInvited = (accountId: string, email: string) => noteReached({ account_id: accountId }, [email], 'invite');

// A public form's page prints its name under the account's name to anyone with the link, before they type a thing.
// A form named like the notice itself ("PayPal invoice: payment charged, call ...") would show it, phone number and
// all, on our address, although every start is refused (fakeNotice reads the form's name as the subject). So what
// the page prints is read the same way, and such a page is closed. Returns what to tell the owner, or null.
export function formPageRefusal(account: any, formName: string): string | null {
  if (!account || !hasNotPaid(account)) return null;
  if (posesAs(account.name)) return nameRefusal([account.name]);
  const lure = lureIn([formName, account.name]);
  return lure ? lureText(lure, 'The name of this public form reads') : null;
}

// An access code of one or two characters is guessed in a minute, so a code that is set (or changed) must have a
// few. A draft may hold a half-typed one, like a half-typed address: it is checked here, before anything goes out.
function assertCodes(recipients: any[], before?: Map<string, any>) {
  for (const r of recipients)
    if (r.access_code && r.access_code.length < ACCESS_CODE_MIN && before?.get(r.id)?.access_code !== r.access_code)
      throw bad(`The access code for ${r.name || 'one of the recipients'} is too short. Use at least ${ACCESS_CODE_MIN} characters, or leave it empty for no code.`);
}

function brandOf(accountId: string) {
  const a = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', accountId);
  return { name: a?.name, color: a?.brand_color, logo: a?.brand_logo };
}
export const senderOf = (e: any) => get('SELECT id, name, email, email_verified, notify FROM users WHERE id=?', e.sender_id);
export const signUrl = (r: any) => `${baseUrl()}/sign/${r.token}`;

// Which emails a sender wants about their own envelopes. Quiet by default: one email when it is all done.
const NOTIFY_DEFAULTS = { viewed: false, signed: false, completed: true, problems: true };
export type NotifyKey = keyof typeof NOTIFY_DEFAULTS;
export function notifyPrefs(user: any): Record<NotifyKey, boolean> {
  try {
    const p = JSON.parse(user?.notify || '{}');
    return Object.fromEntries(Object.entries(NOTIFY_DEFAULTS).map(([k, d]) => [k, typeof p[k] === 'boolean' ? p[k] : d])) as any;
  } catch {
    return { ...NOTIFY_DEFAULTS };
  }
}

// `o.anyway` is the sender's answer to the warning about an address that bounced before (see below).
export async function sendEnvelope(envelopeId: string, actor: Actor, o: { anyway?: boolean } = {}) {
  const e = loadEnvelope(envelopeId);
  if (!e || e.kind !== 'envelope') throw bad('Envelope not found.', 404);
  if (e.status !== 'draft') throw bad('This envelope has already been sent.');
  assertSendable(e);
  const account = get('SELECT * FROM accounts WHERE id=?', e.account_id);
  const sender = senderOf(e);
  // Nothing new goes out from an account that is being closed, by any path: the app, a key, a bulk row, a public form.
  if (account.closing_at) throw bad(closingText(account, 'Nothing new can be sent from it'), 403);
  // These checks exist to keep scammers from using the service to send convincing fakes: a confirmed address, then
  // the pause, the fake-notice filter and the daily limit, which every other path that emails a recipient shares.
  if (!sender?.email_verified) throw bad('Confirm your email address before you send. We emailed you a link when you signed up, and you can resend it from the banner at the top of the app.', 403);
  assertCodes(e.recipients);
  // A check by one-time code can work for everyone it was asked for, and the account may text whom it asks to text.
  assertChecks(e);
  // Every group on it still exists and has members (groups.ts).
  assertGroups(e);
  // The visitor of a public form typed their own address. They count against the form's own limit, and everyone
  // else on the envelope (the people the owner put on the template) against what the owner may send. Each member
  // of a group is emailed, so each counts as a person reached.
  const visitor = e.powerform_id ? e.recipients.find((r: any) => r.id === e.form_recipient_id) : null;
  // Someone whose link the sender passes on is reached all the same, so they count too (reachKey in bysender.ts).
  const reach = e.recipients.filter((r: any) => r !== visitor).map(reachKey).concat(groupReach(e));
  assertMayEmail(e, reach, { visitor: visitor?.email });
  // The do-not-mail list (bounces.ts): an address at which an email of this account came back for good in the last
  // weeks is not emailed by a new envelope before the sender has been told. It is a warning with a way on, never a
  // refusal for good and never a quiet drop: the same request with "send_anyway": true goes out, and the record
  // says that the sender was warned. Not asked for a public form, where nobody who could answer is looking. Its
  // owner was told when the email came back.
  const dead = e.powerform_id ? [] : bouncedBefore(e.account_id, e.recipients.filter((r: any) => r.role !== 'inperson').map((r: any) => r.email).concat(groupReach(e)));
  if (dead.length && !o.anyway) {
    const no = bouncedRefusal(dead);
    throw bad(no.message, 409, no.data);
  }
  // A signature is held for every signer so nobody is stopped halfway. It is only used up when they actually sign,
  // and it comes back by itself if the envelope is voided, declined or expires.
  const before = creditsEnabled() ? available(account.id) : Infinity;
  const need = creditsEnabled() ? needed(e, sender) : 0;
  // Signing your own documents, approvals and copies cost nothing, so they go out whatever the balance is.
  if (need > 0 && need > before) throw bad(outOfSignatures(account, need, before), 402);

  const pages = e.documents.reduce((n: number, d: any) => n + d.pages, 0);
  const t = now();
  tx(() => {
    run("UPDATE envelopes SET status='sent', sent_at=?, updated_at=?, expires_at=?, sheets=?, subject=? WHERE id=?",
      t, t, new Date(Date.now() + e.expire_days * 864e5).toISOString(), sheetsSaved(pages, e.recipients.length),
      e.subject || `Please sign: ${e.documents[0].name}`, e.id);
    for (const r of e.recipients) {
      run('UPDATE recipients SET token=?, check_code=?, free=? WHERE id=?', token(), checkCode(), isSelf(r, sender) ? 1 : 0, r.id);
      // A group is no contact: it has no address of its own, and its members are kept with the group.
      if (r.email) run('INSERT INTO contacts (id, account_id, name, email, created_at) VALUES (?,?,?,?,?) ON CONFLICT(account_id, email) DO NOTHING', id('con'), e.account_id, r.name, r.email, t);
    }
    // The members of every group are written down as they are now, each with a link of their own (groups.ts).
    snapshotGroups(e);
    noteReached(e, reach);
    if (visitor) noteReached(e, [visitor.email], `form:${e.powerform_id}`);
    audit(e.id, actor, 'Envelope sent', `${e.recipients.length} recipient${e.recipients.length === 1 ? '' : 's'}, ${pages} page${pages === 1 ? '' : 's'}`);
    // A line the sender drew through printed wording is part of what is sent, so the record names each one.
    for (const f of e.fields.filter((f: any) => f.type === 'strike'))
      audit(e.id, actor, 'Wording struck out', `The sender struck out wording on ${strikePlace(f.page, e.documents.find((d: any) => d.id === f.document_id)?.name)}.`);
    // So is the sender's own stamp: which one, where, and the fingerprint of its picture (stamps.ts).
    stampsSent(e, actor);
    // A document made from a Word file or the like: what it was made from, its fingerprint and the tool (converted.ts).
    convertedSent(e, actor);
    // A word that often means paper, a witness or a notary is needed is written down with the send, and the answer to
    // sending carries it as "warnings". It never stops a send: see src/server/warnings.ts. A visitor of a public
    // form is not the sender, so there the line does not say that the sender was told.
    const warned = sendWarnings(e);
    if (warned.length) audit(e.id, { name: 'System' }, PAPER_AUDIT_ACTION, paperAuditNote(warned, !e.powerform_id));
    // Sent although an address on it bounced before: the record says what the sender was told before choosing that.
    if (dead.length) audit(e.id, actor, 'Sent to an address that bounced before', `${dead.map(bouncedLine).join(' ')} The sender was shown this and chose to send anyway.`);
    // A copy of the draft that is still open in another tab is older than the envelope that went out.
    newerVersion(e.id, actor, 'sent this envelope');
  });
  fireWebhooks(e.account_id, 'envelope.sent', e.id);
  await advance(e.id);
  // Running low never comes as a surprise: one email at two signatures left, one at none. A public form holds
  // nothing when it is started, so for a form this is said when its visitor signs (completeRecipient).
  if (creditsEnabled() && need > 0 && !e.powerform_id) await lowBalanceMail(account, sender, before, before - need, `${sender.name} sent "${e.subject || e.documents[0].name}"`);
}

// The email at two signatures left and the one at none. It goes to the people who can buy more (owners and admins)
// as well as to the person whose envelope or form used them, so a member using the last signature never leaves the
// team stuck without anyone knowing. `did` says what used them ("Ann sent "Lease"", "someone signed your form
// "Join us""); `always` says it to the sender too, for a form, where they did not do it themselves.
export async function lowBalanceMail(account: any, sender: { email: string; name: string }, before: number, after: number, did: string, always = false) {
  for (const mark of [2, 0])
    if (before > mark && after <= mark) {
      const buyers = all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", account.id).map((u) => u.email);
      const isBuyer = buyers.some((b) => sameEmail(b, sender.email));
      const more = account.promo_code ? `Your plan is free with the code ${account.promo_code}: ${PRICING.monthlySignatures} more arrive at the start of next month at no charge, and you can top up any time at $${PRICING.topUpUsd} a signature.`
        : account.plan === 'grove' && account.cancel_at ? `Your monthly plan is cancelled, so no more are added by it. Until it ends you can still top up at $${PRICING.topUpUsd} a signature, or keep the plan after all on the Plan page.`
        : account.plan === 'grove' ? `Your plan adds ${PRICING.monthlySignatures} more with each monthly payment, and you can top up any time at $${PRICING.topUpUsd} a signature.`
        : `The monthly plan is $${PRICING.monthlyUsd} for ${PRICING.monthlySignatures} signatures.`;
      for (const to of new Set([sender.email, ...buyers]))
        await sendMail({ to, subject: after <= 0 ? 'You have used all your signatures' : `${after} signature${after === 1 ? '' : 's'} left`,
          heading: after <= 0 ? 'That was your last signature' : `You have ${after} signature${after === 1 ? '' : 's'} left`,
          lines: [`${account.name} has ${Math.max(0, after)} signature${after === 1 ? '' : 's'} left to send${sameEmail(to, sender.email) && !always ? '' : `, after ${did}`}. Envelopes already out are covered and can still be signed.`,
            more,
            ...(sameEmail(to, sender.email) && !isBuyer ? ['Only an owner or admin of your team can buy more. We have told them too.'] : []),
            `Nothing is ever charged without you choosing it. Every dollar plants ${PRICING.treesPerUsd} mangrove trees.`],
          ...(sameEmail(to, sender.email) && !isBuyer ? {} : { cta: { label: 'See your plan', url: `${baseUrl()}/app/settings?tab=billing` } }) });
      break;
    }
}

type Notice = 'new' | 'reminder' | 'updated' | 'reopened' | 'expiring' | 'resent' | 'again';
const NOTICE_PREFIX: Record<Notice, string> = { new: '', reminder: 'Reminder: ', updated: 'Updated: ', reopened: 'Reopened: ', expiring: 'Expires soon: ', resent: '', again: 'Changed after you finished: ' };

// The last look before a signing email is written, over everything it could print (also what the latest change was).
const mayWrite = (e: any) => emailRefusal(e, [], { extra: [e.last_change] });

// Answers false when nothing was written (someone who turned reminders off, or the guard said no), and otherwise
// what became of the email: the mail server took it, there is no mail server, or the mail server would not take it yet.
export async function notifyRecipient(e: any, r: any, kind: Notice = 'new'): Promise<false | MailStatus> {
  // A group that nobody has taken on yet: every member who can still act gets their own email with their own link,
  // each written by this same function (notifyMembers in groups.ts). Once a member has taken it on, the row is theirs.
  if (isOpenGroup(r) && !r.member) return notifyMembers(e, r, kind, notifyRecipient);
  // Someone whose link the sender passes on is never emailed, whatever the kind. The sender hears what only the
  // sender can pass on (bySenderNotice in bysender.ts), and the caller is answered false: nothing was written.
  if (r.link_by_sender && !r.email) return bySenderNotice(e, r, kind);
  if (kind === 'reminder' && r.muted) return false;
  // Someone who marked our email about this envelope as spam is not emailed about it again, whoever asks, until they
  // ask for that themselves on their signing page (routes-bounces.ts). And no reminder goes to an address the last
  // email came back from, until the sender corrects it or says "try again". The "expires soon" notice is a reminder
  // too, and would only come back. The caller is answered false, as for a reminder that was turned off, and the
  // envelope's record already says why.
  if (r.role !== 'inperson' && (r.complained_at || ((kind === 'reminder' || kind === 'expiring') && r.bounced_at))) return false;
  // Nor a member of a signing group who reported it, also once they have taken it on (memberMailStop in groups.ts).
  if (r.group_name && memberMailStop(r)) return false;
  const sender = senderOf(e);
  // Whoever asked for this email (the sender, the timer, a name a signer changed), the guard has the last word
  // before it is written: nothing goes to a recipient in a paused sender's name, and nothing that reads like a fake
  // notice. Two emails are let through: the one to the sender who hosts an in-person signing, and a fresh link
  // that somebody asked for themselves, for a document they already have.
  if (kind !== 'resent' && r.role !== 'inperson' && !sameEmail(r.email, sender?.email) && mayWrite(e)) return false;
  // Someone who finished once and is asked again because the sender changed the document is told exactly that, by
  // whichever path their turn comes round.
  const before = String(r.signed_before || '').split('\n').filter(Boolean).pop();
  if (kind === 'new' && before && r.status !== 'completed') kind = 'again';
  const redo = ACTS(r.role) ? 'sign' : r.role === 'approver' ? 'approve' : 'confirm';
  const whatChanged = e.last_change ? [`What changed: ${e.last_change}`] : [];
  const verb = r.role === 'witness' ? witnessVerb(e, r) : r.role === 'cc' ? 'sent you a copy of' : r.role === 'viewer' ? 'sent you a document to view:' : r.role === 'approver' ? 'asked you to approve' : 'sent you a document to sign:';
  const to = r.role === 'inperson' ? sender.email : r.email;
  // A deadline is a moment: it is said with its time in UTC, and in this person's own time zone as well once their
  // device has told us which that is, so the email and the signing page name the same moment.
  // Someone who has signed or approved and asks for their link again ("Email me the current link") is not asked to
  // sign: the email says what the link opens now, and its button says "view".
  const done = r.status === 'completed' && (r.role === 'signer' || r.role === 'approver' || r.role === 'witness');
  const deadline = e.expires_at && r.role !== 'cc' && !done ? momentForEmail(e.expires_at, r.tz) : '';
  const shared = (e.recipients || []).some((x: any) => x.id !== r.id && x.email.toLowerCase() === r.email.toLowerCase());
  const mailed = await sendMail({
    to,
    subject: `${NOTICE_PREFIX[kind]}${e.subject}`,
    heading: r.role === 'inperson' ? `Host an in-person signing for ${r.name}` : kind === 'again' ? `${shared ? `For ${r.name}: ` : ''}${sender.name} changed this document after you ${finishedHow(r)} it`
      : done ? `${shared ? `For ${r.name}: ` : ''}Your link to ${e.subject}` : `${shared ? `For ${r.name}: ` : ''}${sender.name} ${verb} ${e.subject}`,
    lines: [
      ...(shared ? [`More than one person on this document uses this email address. This link is for ${r.name} only.`] : []),
      ...(kind === 'again' ? [
        `${r.role === 'inperson' ? `${r.name} ${finishedHow(r)}` : `You ${finishedHow(r)}`} "${e.subject}" on ${ts(before)}. After that, ${sender.name} changed the document, so what was ${finishedHow(r)} then no longer counts. It is kept on record, and so is the change.`,
        ...whatChanged,
        `Please look at the document again and ${redo} again if you agree. Answers given the first time are still filled in to check. If you do not agree, you can decline or ask ${sender.name} a question from the same page.`,
      ] : []),
      ...(kind === 'updated' ? [`${sender.name} changed this document after sending it. Please look at it again before you sign.`, ...whatChanged] : []),
      ...(kind === 'reopened' ? [`${sender.name} gave everyone more time, so you can sign now.`] : []),
      ...(kind === 'expiring' ? [`This request closes on ${deadline}. If you need longer, reply to this email and ask ${sender.name} for more time.`] : []),
      ...(kind === 'resent' ? ['You asked for a fresh link. Here it is.'] : []),
      ...(done ? [e.status === 'completed' ? `You ${finishedHow(r)} this document, and so has everyone else. The link opens the completed document, and you can download it there.`
        : `You have already ${finishedHow(r)} this document, so there is nothing more for you to do. The link opens it as it stands while the others finish.`] : []),
      // "Filled everything in and never pressed Finish": the reminder says that one button is all that is left.
      ...(kind === 'reminder' && fieldProgress(e, r).ready ? [r.role === 'inperson'
        ? `${r.name} filled in everything, but Finish was not pressed, so nothing is signed yet. Open the document, let ${r.name} check it, and press Finish.`
        : `You filled in everything, and what you filled in is saved. One step is left: open the document and press Finish. Until you do, it is not signed and ${sender.name} has not received it.`] : []),
      // The second sentence is the hand-over lock (handover.ts), said before the host opens the link from this email.
      ...(r.role === 'inperson' ? [`Open the document on your device and hand it to ${r.name} to sign in person. If that browser is signed in to Sign&Grow, your account is locked in it while they hold the device, and you type your password to come back.`] : []),
      // To a witness: whose signature, and to open it only if they were there (witness.ts).
      ...witnessMailLines(e, r, kind, sender),
      ...(e.message ? [`${sender.name} wrote:\n${e.message}`] : []),
      ...groupLine(r), // to a member of a group: that it went to the group, and how that works
      ...(r.note ? [`Note for you: ${r.note}`] : []),
      ...(r.access_code ? [`You will need an access code to open it. ${sender.name} will give it to you separately. It is not in this email.`] : []),
      `Sent by ${sender.name} (${sender.email}). Reply to this email to reach them directly.`,
    ],
    cta: { label: done ? (e.status === 'completed' ? 'View completed document' : 'View document') : r.role === 'cc' ? 'View document' : r.role === 'viewer' ? 'View document' : `${r.role === 'approver' ? 'Review and approve' : r.role === 'witness' ? 'Open and witness' : 'Review and sign'}${kind === 'again' ? ' again' : ''}`, url: signUrl(r) },
    envelopeId: e.id,
    recipientId: r.id,
    // An email that asks this person to do something is not delivered late once they have done it: see tooLate in
    // mail.ts. A copy asks nothing, and neither does a link sent again to someone who has finished.
    untilDone: r.role !== 'cc' && r.status !== 'completed',
    brand: brandOf(e.account_id),
    replyTo: sender.email,
    fromName: sender.name,
    code: r.check_code,
    // Someone who cannot open the page where they are is told to ask the sender for a PDF. Not on the email for an
    // in-person signing: that one goes to the sender, who would be asking themselves.
    askForPdf: r.role === 'inperson' ? undefined : sender.name,
    footnote: [deadline && kind !== 'expiring' ? `This request closes on ${deadline}.` : '', kind === 'reminder' ? `Too many reminders? Stop them for this document: ${signUrl(r)}?mute=1` : ''].filter(Boolean).join(' ') || undefined,
  });
  // The same news by text message, for a recipient the sender chose that for: see alsoText in signercode.ts.
  await alsoText(e, r, kind);
  return mailed;
}

// What became of an email to someone on an envelope belongs in that envelope's record. The first failed try is
// written down as exactly that, a later try that goes through as "Email sent", and the last failed try as final.
// Then the sender is told (their "when something needs you" setting), because only they can reach the person
// another way. A notice to the sender (no recipient on it) is tried again like any other, without a line here. An
// email to the sender as one of the people on the envelope (signing their own document, or hosting an in-person
// signing) is on the record like anyone's. Only the extra email about it is left out: it would go to the same address.
onMailOutcome('envelope', async (m, what) => {
  const e = m.envelope_id && get('SELECT id, subject, account_id, sender_id FROM envelopes WHERE id=?', m.envelope_id);
  if (!e) return;
  const own = sameEmail(m.to_email, senderOf(e)?.email);
  const r = m.recipient_id ? get('SELECT name, role, group_name FROM recipients WHERE id=?', m.recipient_id) : null;
  if (own && !r) return;
  const which = `"${str(m.subject, 200)}" to ${r?.role === 'inperson' ? `the sender at ${m.to_email}, who hosts the signing for ${r.name}` : r?.name ? `${r.name} <${m.to_email}>` : m.to_email}`;
  const said = m.error ? ` What went wrong: ${str(m.error, 300).replace(/[.\s]+$/, '')}.` : '';
  const tries = m.tries > 1 ? ` after ${m.tries} tries` : '';
  if (what === 'delayed') audit(e.id, { name: 'System' }, 'Email could not be sent yet', `${which}.${said} It is tried again automatically.`);
  if (what === 'sent') audit(e.id, { name: 'System' }, 'Email sent', `${which}, on try ${m.tries}.`);
  if (what !== 'gave_up') return;
  audit(e.id, { name: 'System' }, 'Email could not be sent', `${which}${tries}.${said} No more tries are made.`);
  if (own) return;
  await notifySender(e, 'problems', `Email not delivered: ${e.subject}`, `We could not email ${r?.name || m.to_email}`,
    [`The email "${m.subject}" to ${m.to_email} could not be handed to the mail server${tries}, so we have stopped trying.${said}`,
      // A member of a group is corrected in the group, not with Correct (which has no single address to change there).
      r?.group_name ? `This address belongs to a member of ${r.group_name}. Every member is emailed separately, so the others are not affected. To correct the address, open the envelope, choose Edit envelope and change that member: a new email goes to the corrected address when you save. Or copy that member's signing link from the envelope page and send it to them yourself.`
        : 'Check the address: open the envelope and choose Correct next to their name, and a new email goes out at once. Or copy their signing link from the same page and send it to them yourself.']);
});

// Moves the envelope forward: activates whoever is next and completes it when everyone is done.
export async function advance(envelopeId: string): Promise<void> {
  for (let guard = 0; guard < 200; guard++) {
    const e = loadEnvelope(envelopeId);
    if (!e || e.status !== 'sent') return;
    const open = e.recipients.filter((r: any) => r.status !== 'completed');
    if (!open.length) return completeEnvelope(e);
    // A witness is asked straight after their own signer has signed, whatever the order says, and holds nobody up.
    // Until then, and while they are unnamed or said they were not there, they wait (witnessDue in witness.ts).
    const turn = e.ordered ? Math.min(...open.filter((r: any) => r.role !== 'witness').map((r: any) => r.routing_order)) : null;
    const next = open.filter((r: any) => r.status === 'pending' && (r.role === 'witness' ? witnessDue(e, r) : turn === null || r.routing_order === turn));
    if (!next.length) return; // waiting on people who already have it
    // This is where the email to the next person is written, so the guard is asked here as well as where the sender
    // clicked. While the account is paused, or while the envelope reads like a fake notice (the sender took a
    // brand's name after sending, say), nobody else is asked: they stay as they are, the record and the sender say
    // why, and they are asked by themselves once the reason is gone (the timer looks, and so does lifting a pause).
    // The sender's own part and an in-person signing email nobody else, so they go ahead.
    const from = senderOf(e);
    const others = next.filter((r: any) => r.role !== 'inperson' && !sameEmail(r.email, from?.email));
    const no = others.length ? mayWrite(e) : null;
    if (no) await noteHeld(e, no, `Not emailed yet: ${listSome(others.map((r: any) => r.name))}.`);
    else if (e.held_at) run('UPDATE envelopes SET held_at=NULL WHERE id=?', e.id);
    let copied = false;
    for (const r of no ? next.filter((r: any) => !others.includes(r)) : next) {
      const t = now();
      if (r.role === 'cc') {
        run("UPDATE recipients SET status='completed', sent_at=?, completed_at=? WHERE id=?", t, t, r.id);
        copied = true;
      } else run("UPDATE recipients SET status='sent', sent_at=? WHERE id=?", t, r.id);
      // The record, and so the certificate, says what happened to the email, not what was meant to happen. "Sent"
      // is only written when the mail server took it. One it would not take is written down by the listener
      // above ("Email could not be sent yet", then "Email sent" when a later try goes through). With no mail
      // server set up nothing is delivered at all, and the record says that too.
      const how = await notifyRecipient(e, { ...r }, 'new');
      // Someone who signs in person is never emailed: the sender hosts it on their own device, and is told so.
      if (r.role === 'inperson') audit(e.id, { name: 'System' }, 'Ready to sign in person', `${r.name}. The sender hosts the signing on their own device.`);
      // Nor is someone whose link the sender passes on. The record says no more than that: not how, not whether it arrived.
      else if (r.link_by_sender && !r.email) audit(e.id, { name: 'System' }, 'Not emailed', `${labelOf(r)}. The sender said they would send the link themselves, so no email went out. The request is open.`);
      else if (how === 'outbox') audit(e.id, { name: 'System' }, 'Not emailed', `${whoIs(r)}. No mail server is set up, so no email went out. The request is open, and the sender can pass on the signing link.`);
      else if (how === false && r.complained_at) audit(e.id, { name: 'System' }, 'Not emailed', `${r.name} <${r.email}>. They marked an earlier email from this account as spam, so no email went out. The request is open, and the sender can pass on the signing link.`);
      else if (how !== 'failed') audit(e.id, { name: 'System' }, r.role === 'cc' ? 'Copy sent' : 'Sent to recipient', whoIs(r)); // a group is named with its members
    }
    if (!copied) return;
  }
}

// `viewer` is the recipient a copy is made for while others are still signing. They get what their screen shows.
// `unfinished`: a copy made while the envelope is still out is marked so across every page (stamp.ts), unless the
// caller wraps it in a mark of its own (the copy kept of what someone signed before a change, see earlierCopy).
export async function buildPdf(e: any, certificate: boolean, viewer?: string, notice?: { title: string; lines: string[] }, unfinished = !certificate): Promise<Uint8Array> {
  // withCheckLines: how each recipient was checked before the document opened, in the words the certificate prints.
  return renderEnvelopePdf(withCheckLines(e), auditTrail(e.id), { certificate, sender: senderOf(e), viewer, notice, unfinished });
}

// Someone who signed keeps the right to a copy of what they signed, also when the envelope was later voided,
// declined or ran out of time. That copy must never pass for a finished agreement, so it opens with this: that it
// was not completed by everyone, why, and what the copy shows. Used by the signer's download (routes-sign.ts).
// `asSigned` is true when the pages behind the notice are the stored copy of what this person signed before the
// sender changed the document (see earlierCopy), and false when they are the document as it stood when it closed.
export function notCompletedNotice(e: any, r: any, asSigned = false): { title: string; lines: string[] } {
  const sender = senderOf(e);
  const closed = auditTrail(e.id).filter((a: any) => ['Envelope voided', 'Declined', 'Envelope expired'].includes(a.action)).pop();
  const on = closed ? ` on ${ts(closed.at)}` : '';
  const who = e.recipients.find((x: any) => x.status === 'declined');
  const why = e.status === 'voided' ? `${sender?.name || 'The sender'} cancelled (voided) it${on}${e.void_reason ? `, giving this reason: ${e.void_reason}` : ''}.`
    : e.status === 'declined' ? `${who?.name || 'One of the people asked to sign'} declined to sign${on}, which closed it for everyone.`
    : `The deadline passed${on} before everyone had finished.`;
  // Someone who signed, was asked to sign again because the sender changed the document, and had not done so when
  // the envelope was closed. Their copy says exactly that, and what the change was.
  const first = r.status === 'completed' ? '' : String(r.signed_before || '').split('\n').filter(Boolean).pop() || '';
  const redo = ACTS(r.role) ? 'sign' : r.role === 'approver' ? 'approve' : 'confirm';
  return {
    title: 'Not completed by everyone',
    lines: [
      `"${e.subject}" was not completed by everyone, so this is not a finished agreement. ${why}`,
      ...(first ? [
        `This copy is for ${r.name}. ${r.name} ${finishedHow(r)} on ${ts(first)}. After that, ${sender?.name || 'the sender'} changed the document and asked ${r.name} to ${redo} again, and the envelope was closed before that happened. So what ${r.name} ${finishedHow(r)} then no longer counts. It is kept on record, together with the change.`,
        asSigned ? `The pages show the document exactly as ${r.name} ${finishedHow(r)} it on ${ts(first)}, before that change. They are not the document as it stood when it was closed. It has no certificate of completion.`
          : `The pages show the document as it stood when it was closed, after the change, with what ${r.name} had filled in and what others who had finished by then had filled in.${ACTS(r.role) ? ` The signature ${r.name} gave is not on them.` : ''} It has no certificate of completion.`,
        ...(e.last_change ? [`What ${sender?.name || 'the sender'} changed last: ${e.last_change}`] : []),
      ] : [`This copy is for ${r.name}. It shows the document as it stood when it was closed: what ${r.name} ${finishedHow(r)} on ${ts(r.completed_at)}, and what others who had finished by then had filled in. It has no certificate of completion.`]),
      `Questions go to ${sender ? `${sender.name} <${sender.email}>` : 'the sender'}. Envelope ${e.id}.`,
    ],
  };
}

// Who keeps the right to a copy after an envelope was voided, declined or ran out of time: everyone who signed,
// approved or confirmed it. That includes someone who did so, was then asked to sign again because the sender
// changed the document, and had not yet done that when it was closed. People who only got a copy do not.
export const keepsCopy = (e: any, r: any): boolean =>
  ['voided', 'expired', 'declined'].includes(e.status) && r.role !== 'cc' && (r.status === 'completed' || !!r.signed_before);

// The document exactly as this person signed it, before the sender changed it and asked them to sign again. It was
// stored when their signature was set aside (correctEnvelope), and it opens with a page that says what it is, so
// it never passes for the document as it is now. `closed` is true when the envelope was voided, declined or ran
// out of time before they signed again. Null when the person has no earlier signature, or no copy was kept for it
// (a signature set aside before copies were kept).
export async function earlierCopy(e: any, r: any, closed: boolean): Promise<Uint8Array | null> {
  const first = r.status === 'completed' ? '' : String(r.signed_before || '').split('\n').filter(Boolean).pop() || '';
  const kept = first && get('SELECT copy_sha256 s FROM earlier_signatures WHERE envelope_id=? AND recipient_id=? AND copy_sha256 IS NOT NULL ORDER BY id DESC LIMIT 1', e.id, r.id);
  if (!kept) return null;
  const sender = senderOf(e);
  const notice = closed ? notCompletedNotice(e, r, true) : {
    title: 'Signed before the document was changed',
    lines: [
      `This copy is for ${r.name}. It shows "${e.subject}" exactly as ${r.name} ${finishedHow(r)} it on ${ts(first)}.`,
      `After that, ${sender?.name || 'the sender'} changed the document and asked ${r.name} to ${ACTS(r.role) ? 'sign' : r.role === 'approver' ? 'approve' : 'confirm'} again. What ${r.name} ${finishedHow(r)} then no longer counts, and it is kept on record together with the change. This copy is that record. It is not the document as it is now, and it is not a finished agreement.`,
      ...(e.last_change ? [`What ${sender?.name || 'the sender'} changed last: ${e.last_change}`] : []),
      `Questions go to ${sender ? `${sender.name} <${sender.email}>` : 'the sender'}. Envelope ${e.id}.`,
    ],
  };
  return withNotice(readBlob(kept.s), e.id, notice, closed ? 'Not completed by everyone' : 'Signed before a change');
}

async function completeEnvelope(e: any) {
  const t = now();
  run("UPDATE envelopes SET status='completed', completed_at=?, updated_at=? WHERE id=? AND status='sent'", t, t, e.id);
  audit(e.id, { name: 'System' }, 'Envelope completed', 'All recipients have finished');
  // Everyone has finished, and that stands whatever happens next. If building the signed copy fails here, the
  // timer builds it again until it succeeds (see buildFinal), instead of leaving the envelope without one.
  const built = await buildFinal(e.id);
  const fresh = loadEnvelope(e.id);
  const pdf = built ? finalPdf(fresh) : null;
  fireWebhooks(e.account_id, 'envelope.completed', e.id);

  const i = impactOf(fresh.sheets);
  const lines = [
    pdf ? 'Everyone has finished. The signed document and its certificate of completion are ready.' : 'Everyone has finished. The signed document and its certificate of completion are being prepared and will be at the link below shortly.',
    `Because this was signed digitally, about ${fmtNum(i.sheets)} sheets of paper and ${fmtNum(i.litresWater)} litres of water were not used.`,
  ];
  const attachments = pdf && pdf.length < 8_000_000 ? [{ filename: `${(fresh.subject || 'signed').replace(/[^\w .-]+/g, '_').slice(0, 80)}.pdf`, content: Buffer.from(pdf) }] : undefined;
  // The fingerprint of the signed PDF, so every person holds a reference of their own outside this service, and
  // what became of each copy, in the record (evidence.ts).
  const copy = !pdf ? 'not-ready' : attachments ? 'attached' : 'too-large';
  lines.splice(1, 0, ...fingerprintLines(fresh, copy));
  const brand = brandOf(e.account_id);
  const sender = senderOf(e);
  const sent = new Set<string>();
  // Everyone on the envelope gets their own email with their own link, also two people who share one address:
  // each of theirs says whose it is, like the request did, so neither is left with the other person's link.
  // A group that only got a copy: every member gets the completed one, with their own link (groupPeople in groups.ts).
  for (const r of fresh.recipients.flatMap(groupPeople)) {
    const to = r.email.toLowerCase();
    // No address: a group nobody took on, or someone whose link the sender passes on (the record says so for them).
    if (!to) {
      noteNoCopy(e, r);
      continue;
    }
    // Someone who marked an email about this envelope as spam gets no copy by email, and the record says so.
    // Their link still opens the completed document.
    if (r.complained_at) {
      audit(e.id, { name: 'System' }, 'Copy not emailed', `${r.name} <${r.email}> marked an earlier email from this account as spam, so the completed copy was not emailed to them. Their signing link opens it.`);
      continue;
    }
    sent.add(to);
    const shared = fresh.recipients.some((x: any) => x.id !== r.id && sameEmail(x.email, r.email));
    noteCopyMailed(e, r, copy, await sendMail({ to: r.email, recipientId: r.id, subject: `Completed: ${fresh.subject}`, heading: `${shared ? `For ${r.name}: ` : ''}Your document is complete`, lines: [...(shared ? [`More than one person on this document uses this email address. This link is for ${r.name} only.`] : []), ...lines, `Keep this email. The link below keeps working for as long as ${sender?.name || 'the sender'} keeps their Sign&Grow account, and the PDF is attached when it is small enough to send. Lost it later? Any time, ${baseUrl()}/help can send your documents to this address again.`], cta: { label: 'View completed document', url: signUrl(r) }, envelopeId: e.id, brand, attachments, replyTo: sender?.email, fromName: sender?.name, code: r.check_code }));
  }
  if (sender && !sent.has(sender.email.toLowerCase()) && notifyPrefs(sender).completed)
    noteCopyMailed(e, { name: sender.name, email: sender.email, sender: true }, copy, await sendMail({ to: sender.email, subject: `Completed: ${fresh.subject}`, heading: 'Your document is complete', lines: [...lines, ...senderCopyLines(fresh)], cta: { label: 'Open envelope', url: `${baseUrl()}/app/envelopes/${e.id}` }, envelopeId: e.id, brand, attachments }));
}

export function finalPdf(e: any): Buffer | null {
  return e.final_sha256 ? readBlob(e.final_sha256) : null;
}

// Builds and stores the signed copy of a completed envelope if it does not have one yet. True when it has one.
export async function buildFinal(envelopeId: string): Promise<boolean> {
  const e = loadEnvelope(envelopeId);
  if (!e || e.status !== 'completed') return false;
  if (e.final_sha256) return true;
  try {
    const pdf = await buildPdf(e, true);
    run('UPDATE envelopes SET final_sha256=?, final_size=? WHERE id=? AND final_sha256 IS NULL', saveBlob(pdf), pdf.length, e.id);
    await finalMadeLate(e).catch((x) => console.error('[pdf] could not tell the sender', x?.message));
    return true;
  } catch (err: any) {
    console.error('[pdf] could not build the signed copy yet', envelopeId, err?.message);
    // Counted, so one that keeps failing waits longer and never holds up the others, and its sender hears (finalretry.ts).
    await finalFailed(e, err).catch((x) => console.error('[pdf] could not record the try', x?.message));
    return false;
  }
}

// Emails the sender about their own envelope, if they asked for that kind of news. 'always' is for things that need them to act.
export async function notifySender(e: any, key: NotifyKey | 'always', subject: string, heading: string, lines: string[], cta?: { label: string; url: string }) {
  const sender = senderOf(e);
  if (!sender || (key !== 'always' && !notifyPrefs(sender)[key])) return;
  await sendMail({ to: sender.email, subject, heading, lines, cta: cta || { label: 'Open envelope', url: `${baseUrl()}/app/envelopes/${e.id}` }, envelopeId: e.id, brand: brandOf(e.account_id) });
}

// Emails for this envelope are being held back by the guard: the next people in a signing order, or a reminder from
// the timer. The record says so and the sender is told, once, until they go out. Nobody loses a reminder or waits in
// a queue without a word.
async function noteHeld(e: any, no: { status: number; message: string }, what: string) {
  if (!run('UPDATE envelopes SET held_at=? WHERE id=? AND held_at IS NULL', now(), e.id).changes) return;
  audit(e.id, { name: 'System' }, 'Held back', `${what} ${no.status === 403 ? 'Sending is paused on the account.' : 'The envelope reads like a fake payment notice, or goes out under a name that reads like a well-known brand.'} It goes out by itself once that is no longer so.`);
  await notifySender(e, 'always', `Held back: ${e.subject}`, 'We are holding back emails about your document', [what, no.message, 'Nothing is lost and nobody has to start again. Once the reason is gone, what was held back goes out by itself the next time our timer runs. People who already have the document can still open and sign it.']);
}

// `bare` leaves the sender's and the account's names off the email, for a notice about an envelope that must not
// carry them (see voidEnvelope).
async function notifyActive(e: any, subject: string, heading: string, lines: string[], bare = false) {
  const sender = senderOf(e);
  // For a group nobody has taken on, every member who was sent the document is told (groupPeople in groups.ts).
  for (const r of e.recipients.flatMap(groupPeople))
    // Not to someone who marked an email about this envelope as spam: nothing more is emailed to them about it.
    // Nor to someone without an address, whose link the sender passes on: their link shows what happened.
    if (r.status !== 'pending' && r.role !== 'inperson' && !r.complained_at && r.email)
      await sendMail({ to: r.email, subject, heading, lines, envelopeId: e.id, ...(bare ? {} : { brand: brandOf(e.account_id), replyTo: sender?.email, fromName: sender?.name }) });
}

export async function voidEnvelope(e: any, reason: string, actor: Actor) {
  if (e.status !== 'sent') throw bad('Only envelopes that are out for signature can be voided.');
  if (!reason.trim()) throw bad('Give a reason for voiding. Recipients will see it.');
  // Voiding is never refused, also not while paused: it is how a sender takes something back. But the notice goes to
  // everyone who has the document, so the reason is read like any other words a sender writes to recipients, and
  // together with the subject it is printed under, or it would be one more way to deliver a lure. That holds for
  // an account the checks apply to and for every account while it is paused.
  const account = get('SELECT * FROM accounts WHERE id=?', e.account_id);
  const checked = !!account.suspended_at || hasNotPaid(account);
  // An envelope that reads like a fake notice as it stands (its sender took a brand's name since) is voided all the
  // same, and its notice says only that: none of the sender's words, and not their names.
  const asItStands = checked ? fakeNotice(e, account, senderOf(e)) : null;
  if (checked && !asItStands && fakeNotice(e, account, senderOf(e), [reason]))
    throw bad('That reason, read together with the subject it would be emailed under, reads like a payment notice from a well-known brand with a phone number to call. It would go to everyone on this envelope. Give a plain reason and the envelope is voided.', 422);
  run("UPDATE envelopes SET status='voided', void_reason=?, updated_at=? WHERE id=?", str(reason, 500), now(), e.id);
  audit(e.id, actor, 'Envelope voided', str(reason, 500));
  fireWebhooks(e.account_id, 'envelope.voided', e.id);
  // While the account is paused nothing a sender writes is emailed, so the notice goes without the reason.
  const quiet = !!account.suspended_at || !!asItStands;
  await notifyActive(e, `Voided: ${asItStands ? 'a document you were sent' : e.subject}`, 'This document was voided by the sender', [...(quiet ? [] : [`Reason: ${reason}`]), 'There is nothing more for you to do.'], !!asItStands);
}

// How far someone has got with their own fields, counted the way their screen counts: a group of radio buttons is
// one thing to do. `ready` is the case a sender most needs to hear about and cannot see: the person opened the
// document, every required thing of theirs has a saved value (their signature included), and Finish was not
// pressed, so nothing is signed. The sender's envelope page says so, and so does the reminder to that person.
export function fieldProgress(e: any, r: any): { fields: number; filled: number; required_left: number; ready: boolean } {
  const things = new Map<string, { filled: boolean; required: boolean }>();
  // A field their own answers hide, and one that works itself out, is nothing for them to do (logic.ts).
  const hide = hiddenOf(e.fields);
  for (const f of e.fields.filter((f: any) => f.recipient_id === r.id && !f.readonly && !AUTO_TYPES.includes(f.type) && !f.formula && !hide.has(f.id))) {
    const key = f.type === 'radio' ? `group:${f.group_name || f.id}` : f.id;
    const it = things.get(key) || { filled: false, required: false };
    things.set(key, { filled: it.filled || !!f.value, required: it.required || !!f.required });
  }
  const list = [...things.values()];
  const required = list.filter((x) => x.required);
  const left = required.filter((x) => !x.filled).length;
  return { fields: list.length, filled: list.filter((x) => x.filled).length, required_left: left, ready: e.status === 'sent' && r.status === 'viewed' && ACTS(r.role) && required.length > 0 && left === 0 };
}

// Reminders only ever go to people whose turn it is and who have not finished. Pass a recipient to nudge just them.
// A recipient who asked for no more reminders is never reminded; the sender sees that and can reach them another way.
export async function remindEnvelope(e: any, actor: Actor, recipientId?: string): Promise<number> {
  if (e.status !== 'sent') throw bad('Reminders only go out while an envelope is waiting for signatures.');
  // A reminder is an email in the sender's name like any other: none while paused, and none for a fake notice.
  assertMayEmail(e);
  const waiting = e.recipients.filter((r: any) => (r.status === 'sent' || r.status === 'viewed') && (!recipientId || r.id === recipientId));
  // Someone whose link the sender passes on has no address: a nudge by hand is refused in words, and the timer's
  // reminder for them goes to the sender (bysender.ts).
  assertNudgeable(e, recipientId, actor);
  await remindThroughSender(e, waiting, actor);
  const reminded: string[] = [];
  for (const r of waiting) {
    // A reminder the mail server would not take is not a reminder sent. The record says so by itself ("Email could
    // not be sent yet") and the timer tries it again, so it is not counted or written down as sent here.
    const how = await notifyRecipient(e, r, 'reminder');
    if (how && how !== 'failed') reminded.push(r.name);
    // Sent again: if their link then cannot be opened, that is news for the sender once more.
    if (how) run('UPDATE recipients SET dead_link_alerted_at=NULL WHERE id=?', r.id);
  }
  run('UPDATE envelopes SET last_reminder_at=? WHERE id=?', now(), e.id);
  if (reminded.length) audit(e.id, actor, 'Reminder sent', reminded.join(', '));
  return reminded.length;
}

// The owner of a public form, and the people who can buy signatures (owners and admins), are told, once a day at
// most, that someone could not sign it for want of a signature, with the numbers as they are. `where` says when:
// at 'start' nothing of the visitor's was kept (they were stopped before filling anything in); at 'finish' what they
// filled in is kept and they are emailed when the form can take their signature. `need` is how many signatures one
// visitor's envelope needs (more than one when the template has other signers too).
export async function formNeedsSignatures(accountId: string, powerformId: string, where: 'start' | 'finish' = 'finish', need = 1): Promise<void> {
  const p = get('SELECT * FROM powerforms WHERE id=?', powerformId);
  if (!p || (p.alerted_at && Date.parse(p.alerted_at) > Date.now() - 864e5)) return;
  run('UPDATE powerforms SET alerted_at=? WHERE id=?', now(), p.id);
  const owner = get('SELECT u.email FROM envelopes t JOIN users u ON u.id=t.sender_id WHERE t.id=?', p.template_id);
  const buyers = all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", accountId).map((u) => u.email);
  const s = creditSummary(accountId);
  const n = (x: number) => `${x} signature${x === 1 ? '' : 's'}`;
  const free = Math.max(0, s.available);
  for (const to of new Set([...(owner ? [owner.email] : []), ...buyers])) {
    const canBuy = buyers.some((b) => sameEmail(b, to));
    await sendMail({ to, subject: `Your form "${p.name}" has run out of signatures`, heading: 'Someone tried to sign your form and could not',
      lines: [`"${p.name}" uses one signature for each person who signs it${need > 1 ? ` (${n(need)} for each visitor, because the form has other signers too)` : ''}, and ${free < 1 ? 'none is' : `only ${free} ${free === 1 ? 'is' : 'are'}`} free right now: you have ${n(Math.max(0, s.balance))} on your balance${s.held > 0 ? `, and ${s.held === 1 ? 'it is' : `${s.held} of them are`} held for envelopes you have out` : ''}.`,
        where === 'start'
          ? 'The person was stopped before they filled anything in, and told that the form cannot take new signatures right now and that it is nothing they did. Nothing of theirs was kept.'
          : 'The person was told that it is nothing they did, and what they filled in is saved. We email them when the form can take their signature, and they finish with the same link.',
        canBuy ? 'Top up or start the monthly plan (or void an envelope you no longer need) and the form takes signatures again at once.' : 'Only an owner or admin of your team can add signatures. We have told them too.'],
      ...(canBuy ? { cta: { label: 'See your plan', url: `${baseUrl()}/app/settings?tab=billing` } } : {}) });
  }
}

// Visitors who were told that what they filled in is saved and that we email them when the form can take their
// signature are emailed once that is so: one email each, oldest first, and no more of them at a time than there are
// signatures free (counting the ones told in the last day who have not finished yet: one who was told and stays away
// does not keep the next one waiting for ever). Run on the timer. The rules of every email in the sender's name hold
// here too: nobody who marked our email as spam, nothing while the account is paused or closing (they are told once
// that is over) or while the form is switched off (they are told once it is on again), and nothing that reads like a
// fake payment notice.
export async function formVisitorsReady(): Promise<number> {
  if (!creditsEnabled()) return 0;
  let told = 0;
  const waiting = all(`SELECT r.*, e.account_id, e.subject, e.expires_at FROM recipients r JOIN envelopes e ON e.id=r.envelope_id
    JOIN powerforms f ON f.id=e.powerform_id JOIN accounts a ON a.id=e.account_id
    WHERE e.powerform_id IS NOT NULL AND e.status='sent' AND r.status IN ('sent','viewed') AND r.form_waits_at IS NOT NULL
      AND f.active=1 AND a.suspended_at IS NULL AND a.closing_at IS NULL AND r.complained_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM mail_complaints c WHERE c.account_id=e.account_id AND c.email=lower(trim(r.email)))
    ORDER BY r.form_waits_at`);
  const room = new Map<string, number>();
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  for (const r of waiting) {
    if (!room.has(r.account_id)) room.set(r.account_id, available(r.account_id) - waiting.filter((x) => x.account_id === r.account_id && x.form_ready_at && x.form_ready_at > dayAgo).length);
    if (r.form_ready_at || !r.email || (room.get(r.account_id) || 0) < 1) continue;
    const env = loadEnvelope(r.envelope_id);
    if (!env || mayWrite(env)) continue;
    room.set(r.account_id, (room.get(r.account_id) || 0) - 1);
    run('UPDATE recipients SET form_ready_at=? WHERE id=?', now(), r.id);
    await sendMail({ to: r.email, subject: `You can finish "${r.subject}" now`, heading: 'The form can take your signature now',
      lines: [`Earlier the form "${r.subject}" could not take your signature. It can now. Everything you filled in is still there: open the link below and press Finish.${r.expires_at ? ` It stays open until ${momentForEmail(r.expires_at, r.tz)}.` : ''}`],
      cta: { label: 'Finish the form', url: signUrl(r) }, envelopeId: r.envelope_id, recipientId: r.id });
    audit(r.envelope_id, { name: 'System' }, 'Visitor told the form can take their signature', `${r.name} <${r.email}> was emailed that the form can take their signature again.`);
    told++;
  }
  return told;
}

// When a signer's address changes to a different person, is the new person's signature free (the sender signing
// their own document) or paid for? Sending to yourself is free, so pointing that request at somebody else afterwards
// has to need a signature like any other, or it would be a way round paying. Returns the new value of `free`.
// `bySigner` is a signer passing the document on: they cannot buy signatures, so they are told who can sort it out.
function takeOverCost(e: any, r: any, newEmail: string, newName: string, bySigner = false): number {
  const sender = senderOf(e) || { email: '', name: '' };
  const free = isSelf({ role: r.role, email: newEmail, name: newName }, sender) ? 1 : 0;
  // A signature that is already paid for by this same person (someone asked to sign again after a change, whose
  // name is being put right) needs nothing more, and stays as it is. Another person, also at the same address, is
  // the next person on the request (nextPerson), and nothing is paid for them yet.
  const same = sameSigner(r, { email: newEmail, name: newName });
  if (paidFor(e.account_id, { ...(same ? r : nextPerson(r, { name: newName, email: newEmail })), email: newEmail })) return r.free ? 1 : free;
  // A witness never uses a signature, whoever is in their place, so nothing is checked for one.
  if (creditsEnabled() && ACTS(r.role) && r.role !== 'witness' && !isChargeable(r, sender) && !free) {
    const have = available(e.account_id);
    if (have < 1 && bySigner) throw bad(`This document cannot be passed on to ${newName} right now: their signature would be a new one, and ${sender.name || 'the sender'} has none free. Nothing was changed. Sign it yourself, or ask ${sender.name || 'the sender'}${sender.email ? ` (${sender.email})` : ''} to put the right person on it.`, 402);
    if (have < 1) throw bad(`${same ? '' : `${newName} is another person than ${r.name}${sameEmail(newEmail, r.email) ? ' (the same address, but not the same name in another spelling)' : ''}, so their signature is a new one. Nothing was changed. `}${outOfSignatures(get('SELECT * FROM accounts WHERE id=?', e.account_id), 1, have)}`, 402);
  }
  return free;
}

// An access code is not part of what anyone signed, and a frozen one keeps its person from everything their link
// still opens: the finished document, or the copy of what they signed on an envelope that was closed afterwards. So
// a new code can be set for as long as the envelope exists, also for someone who has finished and on an envelope
// that is completed, voided, declined or expired. Nothing else changes then, the link stays as it is and nobody is
// emailed: the sender gives the new code to the person themselves, as always.
function lateAccessCode(e: any, r: any, typed: any, actor: Actor) {
  const code = str(typed, 50).trim() || null;
  if ((code || '') === (r.access_code || '')) {
    // Saving the code that is frozen opens nothing, and "saved" would not be true.
    if (r.access_code && r.code_frozen_at) throw bad(`The access code for ${r.name} is frozen after ${ACCESS_CODE_TRIES} wrong tries, and saving the same code again does not open it. Type a different code of at least ${ACCESS_CODE_MIN} characters, then give it to them yourself. Nothing was changed.`);
    return;
  }
  assertCodes([{ name: r.name, access_code: code }]);
  run('UPDATE recipients SET access_code=?, code_fails=0, code_frozen_at=NULL WHERE id=?', code, r.id);
  audit(e.id, actor, 'Recipient corrected', `${r.name}: access code ${code ? 'changed' : 'removed'}`);
  if (e.status === 'sent') newerVersion(e.id, actor, `changed the access code of ${r.name}`);
}

// Fix a recipient's name or email while the envelope is out. Old links stop working.
export async function correctRecipient(e: any, recipientId: string, patch: { name?: string; email?: string; access_code?: string }, actor: Actor) {
  const r = e.recipients.find((x: any) => x.id === recipientId);
  // Only the access code, with the name and the address as they are: see lateAccessCode.
  const late = !!r && e.kind === 'envelope' && e.status !== 'draft' && (e.status !== 'sent' || r.status === 'completed');
  if (late && patch.access_code !== undefined && str(patch.name ?? r.name, 121).trim() === r.name && sameEmail(patch.email ?? r.email, r.email)) return lateAccessCode(e, r, patch.access_code, actor);
  if (e.status !== 'sent') throw bad(late ? `This envelope is no longer out for signature, so the name and the address of ${r.name} can no longer be changed. Nothing was changed. An access code still can be: send "access_code" with the name and the address as they are.` : 'Only envelopes that are out for signature can be corrected.');
  if (!r) throw bad('Recipient not found.', 404);
  // A group has no single name or address to correct here: its members are changed by editing the envelope. Its
  // access code is one for the whole group and can be set here, like anyone's (groups.ts).
  assertGroupCorrection(r, patch);
  if (isOpenGroup(r)) return patch.access_code === undefined ? undefined : lateAccessCode(e, r, patch.access_code, actor);
  if (r.status === 'completed') throw bad(`${r.name} has already finished, so their name and address cannot be changed from here. Nothing was changed. To change those after all, edit the envelope itself (Edit envelope in the app): a new name or address means asking them to sign again, and you are asked first. Their access code can be changed from here: send "access_code" with the name and the address as they are.`);
  const name = fit(patch.name ?? r.name, 120, 'The name').trim();
  const email = fit(patch.email ?? r.email, 254, 'The email address').trim();
  // Someone whose link the sender passes on has no address, and keeps none when only the name or the code changes.
  // An address given for them means we email them from now on (the tick goes, below).
  if (!name || (!isEmail(email) && !(r.link_by_sender && !email))) throw bad(r.link_by_sender && !name ? 'Enter a name.' : 'Enter a name and a valid email address.');
  // A witness who would be the signer, or a party, is refused here as it is when sending (witness.ts).
  assertWitnessesAfter(e, r, name, email);
  const code = patch.access_code === undefined ? r.access_code : str(patch.access_code, 50).trim() || null;
  // A code that is set or changed must be long enough. A new code starts clean: wrong tries at the old one are
  // forgotten and a frozen code opens again, which is how the sender lets a signer back in.
  const newCode = (code || '') !== (r.access_code || '');
  if (newCode) assertCodes([{ name, access_code: code }]);
  // Saving the code that is frozen opens nothing: the signer would still be locked out, and "saved" would not be true.
  if (!newCode && patch.access_code !== undefined && r.access_code && r.code_frozen_at && sameEmail(email, r.email))
    throw bad(`The access code for ${r.name} is frozen after ${ACCESS_CODE_TRIES} wrong tries, and saving the same code again does not open it. Type a different code of at least ${ACCESS_CODE_MIN} characters, then give it to them yourself. Nothing was changed.`);
  // A name or an address that a field prints is wording on the page. Once someone has signed those pages it only
  // changes with the sender's choice to ask them to sign again, and that choice is made by changing the envelope.
  const sameInbox = email.toLowerCase() === r.email.toLowerCase();
  const over = signedOverName(e, r, name !== r.name, !sameInbox);
  if (over.length) {
    const names = listSome(over.map((o: any) => o.name), 8);
    const what = e.fields.some((f: any) => f.recipient_id === r.id && f.type === 'full_name') && name !== r.name ? 'name' : 'email address';
    throw bad(`The ${what} of ${r.name} is printed on the document, and ${names} ${over.length === 1 ? 'has' : 'have'} already finished. Nothing was changed. To change it, edit the envelope itself (Edit envelope in the app, or PUT /envelopes/{id} with "resign": true). ${names} will then be told what changed and asked to sign again.`,
      409, { code: 'sign_again', sign_again: over.map((o: any) => o.name), changes: [`The ${what} of ${r.name}, which is printed on the document.`] });
  }
  const fresh = 'code_fails=0, code_frozen_at=NULL';
  if (sameInbox) {
    // Same inbox: fixing a name or an access code never breaks the link they already have. (Renaming your own free
    // signature to somebody else's name makes it theirs, and then it needs a signature.)
    const free = name !== r.name ? takeOverCost(e, r, email, name) : r.free;
    // The same inbox is not always the same person: a couple or an office can share one. A name that is not the old
    // one in another spelling (samePerson) is somebody else, and a signature, initials and answers belong to the
    // person who made them. So nothing the first one agreed to, typed, ticked, uploaded or drew stays with the
    // request: the new person agrees and signs for themselves, on the same link. A spelling fix keeps everything.
    const other = name !== r.name && !samePerson(r.name, name);
    if (other) clearAnswers(r.id);
    // Another person is the next person on the request: their signature is their own (sigRef in credits.ts).
    // Someone the request had before (renamed away and back) is that person again (personGen in credits.ts).
    const pg = personGen(r, name, r.email);
    // A time zone, like answers and a signature, is the person's own: the new one starts without the old one's
    // (it decides the date printed for them, the times on the certificate and when reminders may wake them).
    run(`UPDATE recipients SET name=?, access_code=?, free=?${newCode ? `, ${fresh}` : ''}${other ? ", person_gen=?, person_gens=?, consent_at=NULL, viewed_at=NULL, muted=0, unopened_alerted_at=NULL, tz=NULL, reminder_held_at=NULL, status=CASE WHEN status='viewed' THEN 'sent' ELSE status END" : ''} WHERE id=?`, name, code, free, ...(other ? [pg.gen, pg.gens] : []), r.id);
    audit(e.id, actor, 'Recipient corrected', `${r.name} is now ${name}${code !== r.access_code ? ', access code changed' : ''}${other ? `. That is another person at the same address, so nothing that ${r.name} had agreed to, filled in or signed was kept` : ''}`);
    newerVersion(e.id, actor, name !== r.name ? `changed the name of ${r.name} to ${name}` : `changed the access code of ${r.name}`);
    // The person is asked to sign under their name, and others may see it printed. A screen that still shows the
    // old one cannot finish, and whoever has the document and sees something different is told.
    if (name !== r.name) await nameChanged(e, `The name "${r.name}" is now written "${name}".`);
    return;
  }
  // A new address is a new person being emailed in the sender's name: not while paused, read by the fake-notice
  // filter, and counted towards the daily limit like a first send.
  assertMayEmail(e, [email]);
  const free = takeOverCost(e, r, email, name);
  retireToken(r, 'address');
  // A different address is a different person: nothing the first one typed, ticked, uploaded or drew goes with the
  // request, and the wait before "not opened yet" is counted from the email that goes to the new address now.
  clearAnswers(r.id);
  // With an address we email them from now on, so a link the sender used to pass on is no longer theirs to pass.
  const pg = personGen(r, name, email);
  // The time zone the first one's device reported is theirs too, so the new person starts without one.
  run(`UPDATE recipients SET name=?, email=?, access_code=?, token=?, check_code=?, viewed_at=NULL, consent_at=NULL, muted=0, unopened_alerted_at=NULL, dead_link_alerted_at=NULL, tz=NULL, reminder_held_at=NULL, sent_at=?, status=?, free=?, link_by_sender=0, person_gen=?, person_gens=?, ${fresh} WHERE id=?`,
    name, email, code, token(), checkCode(), r.status === 'pending' ? r.sent_at : now(), r.status === 'pending' ? 'pending' : 'sent', free, pg.gen, pg.gens, r.id);
  noteReached(e, [email]);
  audit(e.id, actor, 'Recipient corrected', `${labelOf(r)} is now ${name} <${email}>. The link ${r.email ? `sent to ${r.email}` : 'the sender had shared'} stopped working, and anything filled in through it was cleared.`);
  newerVersion(e.id, actor, `changed ${labelOf(r)} to ${name} <${email}>`);
  // Where a field prints this person's name or address, everyone else who has the document sees a different page.
  if (e.fields.some((f: any) => f.recipient_id === r.id && printsName(f))) await nameChanged(e, `${r.name} was replaced by ${name}, and the name and address printed for them changed with that.`, r.id);
  if (r.status !== 'pending') await notifyRecipient(loadEnvelope(e.id), get('SELECT * FROM recipients WHERE id=?', r.id));
}

// ---- Recipient actions ---------------------------------------------------------------------

export function markViewed(e: any, r: any, actor: Actor) {
  if (r.status !== 'sent') return;
  run("UPDATE recipients SET status='viewed', viewed_at=?, ip=?, user_agent=? WHERE id=?", now(), actor.ip || null, (actor.ua || '').slice(0, 300), r.id);
  audit(e.id, actor, 'Viewed', `${r.name} opened the envelope`);
  fireWebhooks(e.account_id, 'recipient.viewed', e.id, { recipient_id: r.id });
  void notifySender(e, 'viewed', `Opened: ${e.subject}`, `${r.name} opened your document`, ['They have not finished yet. Nothing for you to do.']).catch(() => {});
}

// A number is checked by the one rule the signing page uses too (src/lib/numbers.ts): 1.234,56, 1 234,56, 1'234.56
// and 1,23,456 are numbers like 1,234.56 is. Whatever was typed is stored and printed as typed.
const VALIDATORS: Record<string, RegExp> = { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, number: NUMBER_RULE, phone: /^[+()\d][\d\s().-]{5,}$/ };

// `atFinish` is told which of this person's fields are not shown, worked out once from the answers as now stored,
// before anything is checked: the same result then decides what is required, which marks need a picture, and what
// the PDF prints (completeRecipient, logic.ts). Returns that set.
export function applyValues(e: any, r: any, values: Record<string, any>, strict: boolean, atFinish?: (hidden: Set<string>) => void): Set<string> {
  const mine = e.fields.filter((f: any) => f.recipient_id === r.id && !f.readonly && !AUTO_TYPES.includes(f.type));
  // One answer per group of radio buttons: two at once is refused, and one takes the others off (logic.ts).
  values = oneChoice(mine, values);
  // A date field takes a real day as year-month-day, what the date picker sends, so the PDF can print it in the
  // envelope's format. "2026-02-31" would print as 31/02/2026 and "next Tuesday" as itself. Checked before anything
  // is written, so a refused save or Finish changes nothing.
  for (const f of mine) {
    const v = f.type === 'date' && f.id in values && !f.formula ? str(values[f.id], 4000) : '';
    if (v && !isDateValue(v)) throw bad(`"${v.slice(0, 40)}" in ${f.label || 'a date field'}: ${DATE_PROBLEM} Nothing was saved.`);
  }
  for (const f of mine) {
    // A calculated field is the server's to work out: whatever the browser sent for it is not taken (logic.ts). A
    // stamp is put on and taken off by its own request (POST /sign/:token/stamp), never by the answers.
    if (!(f.id in values) || f.formula || f.type === 'stamp') continue;
    let v = str(values[f.id], 4000);
    if (f.type === 'checkbox' || f.type === 'radio' || f.type === 'signature' || f.type === 'initials') v = v ? '1' : '';
    if (f.type === 'dropdown' && v && !(f.options || []).includes(v)) v = '';
    if (f.type === 'attachment' && v && !get('SELECT id FROM files WHERE id=? AND account_id IS NULL', v)) v = '';
    f.value = v;
    run('UPDATE fields SET value=? WHERE id=?', v || null, f.id);
  }
  // What is shown and what every formula comes to, worked out again from what is now stored. A field this person's
  // answers hide loses its answer and is not required, whatever the browser said about it (logic.ts).
  const hidden = settleLogic(e.id, r.id, e.fields);
  atFinish?.(hidden);
  if (!strict) return hidden;
  const groups = new Map<string, { ok: boolean; required: boolean }>();
  for (const f of mine) {
    if (f.formula || hidden.has(f.id)) continue;
    const label = f.label || f.type.replace('_', ' ');
    if (f.type === 'radio') {
      const gkey = f.group_name || f.id;
      const gr = groups.get(gkey) || { ok: false, required: false };
      gr.ok ||= f.value === '1';
      gr.required ||= !!f.required;
      groups.set(gkey, gr);
      continue;
    }
    if (f.required && !f.value) throw bad(`A required field is still empty: ${label}.`);
    const rule = f.type === 'number' ? 'number' : f.validation;
    if (f.value && rule) {
      const re = VALIDATORS[rule] || (() => { try { return new RegExp(`^(?:${rule})$`); } catch { return null; } })();
      if (re && !re.test(f.value)) throw bad(rule === 'number' ? `"${f.value}" does not read as a number for ${label}. Type it as you write it, like 2500, 12.5, 1.234,56 or 1,234.56, with nothing else in the field.` : `"${f.value}" is not valid for ${label}.`);
    }
  }
  for (const [name, gr] of groups) if (gr.required && !gr.ok) throw bad(`Choose an option for ${name}.`);
  return hidden;
}

export const okImage = (s: any) => typeof s === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < 700_000;

// Which content version a signer is acting on: the one their screen sent, or else the one the server last gave them.
export const shownVersion = (r: any, body: any): number | null => (body?.version != null && body.version !== '' ? Number(body.version) : r.seen_version ?? null);
// Said to a signer whose screen shows the document as it was before the sender's latest correction.
export const changedSince = (e: any) => bad('The sender changed this document while you had it open. Look at it again before you finish.', 409, { code: 'changed', version: get('SELECT content_version v FROM envelopes WHERE id=?', e.id)?.v });
// Said to someone who saves, declines, renames or passes on a document that is not theirs to act on right now. A
// person whose turn was taken back is told exactly that, not that the envelope is closed, because it is not.
export const notOpen = (e: any, r: any) => bad(e.status === 'sent' && r.status === 'pending'
  ? 'It is not your turn yet. Someone before you has to finish first, and we will email you when the document is ready for you. Nothing you filled in is lost.'
  : closedFormStart(e, r) ? closedStartText(e) : 'This envelope is no longer open for signing.');

export async function completeRecipient(e: any, r: any, body: any, actor: Actor) {
  // A second Finish (a double tap, a retry) is a conflict with the first, not a mistake in the request: 409. Asked
  // before anything else, because the first Finish may have completed the whole envelope by now.
  if (r.status === 'completed') throw bad('You have already finished this document.', 409, { code: 'already_finished' });
  if (e.status !== 'sent') throw bad(closedFormStart(e, r) ? closedStartText(e) : 'This envelope is no longer open for signing.');
  if (r.status !== 'sent' && r.status !== 'viewed') throw bad('It is not your turn to sign yet.');
  // What is on this person's screen must be what is on the envelope now. The signing screen sends the content
  // version it was given. A caller that sends none is held to the version the server last showed them. If the
  // sender has changed the document since, nothing is signed: the person is told, looks again and finishes then.
  // Asked before consent, because a change can also be what took the consent away (the request now names another
  // person): the page then loads what is true now, and that screen asks for the agreement.
  const shown = shownVersion(r, body);
  if (shown != null && shown !== e.content_version) throw changedSince(e);
  if (!r.consent_at) throw bad('Please agree to use electronic records and signatures first.');
  // What other people filled in that this person's formulas count must be what their screen was given: someone who
  // finished meanwhile changes the result, and then nothing is signed until the person has seen it (logic.ts).
  assertInputs(e, r, body);
  let verb = 'Viewed';
  if (ACTS(r.role)) verb = r.role === 'witness' ? 'Witnessed' : 'Signed';
  else if (r.role === 'approver') verb = 'Approved';
  // A public form holds none of its owner's signatures while people fill it in, so this is the moment that decides:
  // a visitor's signature needs one that is free right now. It never takes one that is held for an envelope the
  // owner has out, and a form never takes the balance below zero. What the visitor filled in is kept, the owner is
  // told (once a day at most), and the same link works again as soon as there is a signature. The start is not
  // closed for being idle while they wait (cronTick), and they are emailed once when the form can take their
  // signature (formVisitorsReady).
  const formCharge = !!e.powerform_id && creditsEnabled() && isChargeable(r, senderOf(e) || '');
  const formWaits = async () => {
    try {
      applyValues(e, r, body.values || {}, false);
    } catch {}
    run('UPDATE recipients SET form_waits_at=?, form_ready_at=NULL WHERE id=?', now(), r.id);
    await formNeedsSignatures(e.account_id, e.powerform_id, 'finish');
    // Promised only to someone we may email (formVisitorsReady keeps the same rules).
    const mailable = !!r.email && !r.complained_at && !get('SELECT 1 x FROM mail_complaints WHERE account_id=? AND email=lower(trim(?))', e.account_id, r.email);
    throw bad(`This form cannot take your signature at the moment. That is nothing you did: the people who run it need to add signatures first, and we have just told them. Everything you filled in is saved, and it stays saved while you wait${e.expires_at ? `, until ${momentForEmail(e.expires_at, r.tz)}` : ''}.${mailable ? ` We email you at ${r.email} once the form can take your signature.` : ''} Then open the same link and press Finish.`, 503, { code: 'form_waits' });
  };
  if (formCharge && !paidFor(e.account_id, r) && available(e.account_id) < 1) await formWaits();
  // The form's signature is taken in the same transaction that claims the Finish, and only while one is free (the
  // check above is the quick answer; this is the one that holds): two visitors finishing at the same moment can
  // never both take the last one, and the balance never goes below zero.
  const FORM_FULL = new Error('form_full');
  let formTook = false;
  const t = now();
  // Finishing is claimed by one statement that only changes a row while this recipient and the envelope are both
  // still open. e and r were read before this and may be out of date: a second Finish, a decline or a void can have
  // got in since. Whoever comes second changes no row and stops here with nothing written: no values, no audit
  // line, no webhook, no signature used, no email. Nothing is waited for between the claim and the values it
  // guards, and a value that fails its check undoes the claim with the rest.
  try { tx(() => {
    // The same statement refuses a Finish when the content version has moved on from the one this person was shown
    // (or, for a caller we never showed one, from the one read a moment ago), so a correction that lands between
    // the look and the claim cannot be signed unseen either.
    const claimed = run("UPDATE recipients SET status='completed', completed_at=?, viewed_at=COALESCE(viewed_at, ?), ip=?, user_agent=? WHERE id=? AND status IN ('sent','viewed') AND (SELECT status FROM envelopes WHERE id=recipients.envelope_id)='sent' AND (SELECT content_version FROM envelopes WHERE id=recipients.envelope_id)=?",
      t, t, actor.ip || null, (actor.ua || '').slice(0, 300), r.id, shown ?? e.content_version).changes;
    if (!claimed) {
      const cur = get('SELECT r.status, e.status env FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE r.id=?', r.id);
      if (cur?.env === 'sent' && (cur.status === 'sent' || cur.status === 'viewed')) throw changedSince(e);
      throw bad(cur?.status === 'completed' ? 'You have already finished this document.' : 'This envelope is no longer open for signing.', 409, cur?.status === 'completed' ? { code: 'already_finished' } : undefined);
    }
    if (formCharge) {
      formTook = grant(e.account_id, -1, 'signature', sigRef(r));
      // None was free after all (another visitor took the last one a moment ago): nothing of this Finish stays.
      if (formTook && available(e.account_id) < 0) throw FORM_FULL;
    }
    if (!ACTS(r.role)) return;
    // Which fields are shown is worked out once, here, from the answers as stored (settleLogic in logic.ts), and the
    // same result decides what is required, which signature and initials need a picture, and what the PDF prints.
    // So nobody finishes as signed with a mark on the page and no picture behind it, whatever the browser claimed.
    applyValues(e, r, body.values || {}, true, (hidden) => {
      const mine = e.fields.filter((f: any) => f.recipient_id === r.id && !hidden.has(f.id));
      if (mine.some((f: any) => f.type === 'signature' && (f.required || f.value)) && !okImage(body.signature_png)) throw bad('Adopt a signature before finishing.');
      if (mine.some((f: any) => f.type === 'initials' && (f.required || f.value)) && !okImage(body.initials_png)) throw bad('Adopt your initials before finishing.');
    });
    run('UPDATE recipients SET signature_png=?, initials_png=? WHERE id=?', okImage(body.signature_png) ? body.signature_png : null, okImage(body.initials_png) ? body.initials_png : null, r.id);
  }); } catch (x) {
    if (x !== FORM_FULL) throw x;
    formTook = false;
    await formWaits();
  }
  // Each stamp they put on: which, where, when and its fingerprint (stamps.ts). A stamp uses no signature.
  if (ACTS(r.role)) stampsFinished(e, r, actor);
  // Someone signing for the second time, after the sender changed the document, is recorded as exactly that.
  audit(e.id, actor, r.signed_before ? `${verb} again` : verb, whoIs(r)); // for a group: the person who acted, and the group
  // A witness with the signer's address or device is marked, before the certificate can be made (witness.ts).
  await witnessDone(e, r, actor);
  fireWebhooks(e.account_id, 'recipient.completed', e.id, { recipient_id: r.id });
  if (creditsEnabled() && isChargeable(r, senderOf(e) || '')) {
    // A public form used its owner's signature in the claim above, not when it was started, so the emails at two left
    // and at none go out from here, as they do for any other send.
    if (!e.powerform_id) grant(e.account_id, -1, 'signature', sigRef(r));
    else if (formTook) {
      const after = available(e.account_id);
      const owner = senderOf(e);
      const form = get('SELECT name FROM powerforms WHERE id=?', e.powerform_id);
      if (owner) await lowBalanceMail(get('SELECT * FROM accounts WHERE id=?', e.account_id), owner, after + 1, after, `${r.name} signed your public form "${form?.name || e.subject}"`, true).catch(() => {});
    }
  }
  const left = e.recipients.filter((x: any) => x.id !== r.id && x.status !== 'completed' && x.role !== 'cc');
  if (left.length) await notifySender(e, 'signed', `${verb}: ${e.subject}`, `${r.name} has ${verb.toLowerCase()} your document`, [`Still waiting on ${left.map((x: any) => x.name).join(', ')}.`]);
  await advance(e.id);
}

export async function declineRecipient(e: any, r: any, reason: string, actor: Actor) {
  // A second Decline (a double tap, a retry) is a conflict with the first: 409, like a second Finish.
  if (r.status === 'declined') throw bad('This envelope is no longer open for signing.', 409);
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw notOpen(e, r);
  if (r.role === 'cc' || r.role === 'viewer') throw bad('Only signers and approvers can decline.');
  // A witness cannot close the document for the people who sign it. Their way out is "I was not there" (witness.ts).
  if (r.role === 'witness') throw bad(witnessCannot(e, r, 'decline'));
  if (!reason.trim()) throw bad('Please tell the sender why you are declining.');
  const t = now();
  // Claimed the same way as finishing: one statement that only changes a row while the recipient and the envelope
  // are both still open, with nothing waited for before it. A decline that comes second, or that crosses a Finish
  // or a void, changes no row and stops here, so there is never a second audit line, webhook or email.
  tx(() => {
    const claimed = run("UPDATE recipients SET status='declined', decline_reason=?, completed_at=?, ip=? WHERE id=? AND status IN ('sent','viewed') AND (SELECT status FROM envelopes WHERE id=recipients.envelope_id)='sent'",
      str(reason, 500), t, actor.ip || null, r.id).changes;
    if (!claimed) throw bad('This envelope is no longer open for signing.', 409);
    run("UPDATE envelopes SET status='declined', updated_at=? WHERE id=?", t, e.id);
  });
  audit(e.id, actor, 'Declined', `${r.name}: ${str(reason, 500)}`);
  fireWebhooks(e.account_id, 'envelope.declined', e.id, { recipient_id: r.id });
  await notifySender(e, 'problems', `Declined: ${e.subject}`, `${r.name} declined to sign`, [`Reason: ${reason}`, 'The envelope is closed. You can clone it, change what needs changing and send it again.']);
  // The notice to the others names who declined, and a name is something the sender wrote: a sender could put
  // themselves on an envelope under a name that carries a lure and decline. So where the checks apply, the name is
  // read with the rest first, and left out when together they read like a fake notice. An envelope that reads
  // like one as it stands (its sender took a brand's name since) gets the notice without the sender's words or names.
  const account = get('SELECT * FROM accounts WHERE id=?', e.account_id);
  const fake = !hasNotPaid(account) ? '' : fakeNotice(e, account, senderOf(e)) ? 'all' : fakeNotice(e, account, senderOf(e), [r.name]) ? 'name' : '';
  await notifyActive({ ...e, recipients: e.recipients.filter((x: any) => x.id !== r.id) }, `Declined: ${fake === 'all' ? 'a document you were sent' : e.subject}`, 'This document was declined',
    [`${fake ? 'One of the people asked to sign' : r.name} declined to sign, so the envelope is closed.`], fake === 'all');
}

export async function reassignRecipient(e: any, r: any, to: { name: string; email: string; reason?: string }, actor: Actor) {
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw notOpen(e, r);
  if (r.role === 'witness') throw bad(witnessCannot(e, r, 'pass'));
  if (r.role !== 'signer' && r.role !== 'approver') throw bad('This role cannot be assigned to someone else.');
  // The sender chose a group: its members are the people who may act. One of them cannot put a stranger in its place.
  if (r.group_name) throw bad(`This document was sent to ${r.group_name}, so it cannot be passed to someone outside the group from here. Nothing was changed. If a colleague in ${r.group_name} should do it, hand it back to the group. If someone else should, ask ${senderOf(e)?.name || 'the sender'}${senderOf(e)?.email ? ` (${senderOf(e).email})` : ''} to change who is on it.`, 409);
  const name = str(to.name, 120).trim();
  const email = str(to.email, 254).trim();
  if (!name || !isEmail(email)) throw bad('Enter the name and email of the person who should sign instead.');
  // Not to a witness on the same document: their own witness would then watch themselves sign (witness.ts).
  assertWitnessesAfter(e, r, name, email, true);
  // Where this person's name or address is printed on pages someone has already signed, another name there would
  // change what that person signed. Only the sender can decide that, by asking them to sign again.
  const over = signedOverName(e, r, true, true);
  if (over.length) {
    const sender = senderOf(e);
    throw bad(`Your name or email address is printed on this document, and ${listSome(over.map((o: any) => o.name), 8)} ${over.length === 1 ? 'has' : 'have'} already finished it, so it cannot be passed on from here. Nothing was changed. Ask ${sender?.name || 'the sender'}${sender?.email ? ` (${sender.email})` : ''} to put the right person on it. They can do that without starting again.`, 409);
  }
  // Passing a request on emails a new person in the sender's name, so the sender's pause and daily limit hold here
  // too (or a sender could send to themselves and pass each one on). The signer is not told the sender's business.
  if (emailRefusal(e, [email])) throw bad(`This document cannot be passed on to someone else right now. Reply to the email you got and ask ${senderOf(e)?.name || 'the sender'} to send it to the right person.`, 403);
  const free = takeOverCost(e, r, email, name, true);
  retireToken(r, 'handed');
  // The new person starts with empty fields: nothing the first one typed, ticked, uploaded or drew is passed on.
  // That holds whatever the address is. A hand-over is to another person by definition, and two people can share
  // one inbox (a family, an office). Someone who only wants their name spelled differently has "Fix my name".
  // The wait before the sender hears "not opened yet" starts again with the email that goes out now.
  clearAnswers(r.id);
  // The new person has an address and is emailed, also when the first one's link was passed on by the sender.
  // Another person is the next person on the request, whose signature is their own (sigRef in credits.ts). The same
  // name (or a spelling of it) at the same address stays the same person, as takeOverCost decided.
  const pg = sameSigner(r, { email, name }) ? null : personGen(r, name, email);
  // The time zone the first one's device reported is theirs, like their answers: the new person's date of signing,
  // certificate times and reminder hours come from their own device, or from the sender's zone until it reports one.
  run(`UPDATE recipients SET name=?, email=?, token=?, check_code=?, status='sent', sent_at=?, viewed_at=NULL, consent_at=NULL, access_code=NULL, muted=0, unopened_alerted_at=NULL, dead_link_alerted_at=NULL, tz=NULL, reminder_held_at=NULL, reassigned_from=?, free=?, link_by_sender=0${pg ? ', person_gen=?, person_gens=?' : ''} WHERE id=?`,
    name, email, token(), checkCode(), now(), labelOf(r), free, ...(pg ? [pg.gen, pg.gens] : []), r.id);
  noteReached(e, [email]);
  audit(e.id, actor, 'Reassigned', `${labelOf(r)} assigned this to ${name} <${email}>${to.reason ? `: ${str(to.reason, 300)}` : ''}${/[.!?]$/.test(str(to.reason, 300).trim()) ? '' : '.'} Nothing that ${r.name} had filled in or signed was passed on.`);
  newerVersion(e.id, actor, `passed this document on to ${name}`);
  // A number the sender typed for the first person is not used for the second, and a check the first passed does
  // not count for the second: see passCheckOn in signercode.ts.
  await passCheckOn(e, r, actor);
  // Where a field prints this person's name or address, everyone else who has the document sees a different page.
  if (e.fields.some((f: any) => f.recipient_id === r.id && printsName(f))) await nameChanged(e, `${r.name} passed the document on to ${name}, and the name and address printed for them changed with that.`, r.id);
  await notifyRecipient(loadEnvelope(e.id), get('SELECT * FROM recipients WHERE id=?', r.id));
  // The signing screen promises "the sender is told", and who signs is the sender's business whatever their email
  // settings are. So this one is always sent.
  await notifySender(e, 'always', `Reassigned: ${e.subject}`, `${r.name} assigned signing to ${name}`, [`${name} <${email}> will sign instead.`, ...(to.reason ? [`Reason: ${to.reason}`] : [])]);
}

// ---- Deadlines, lost links, reminders, reports -------------------------------------------------

// Push the deadline out, or reopen an envelope that already expired. No need to start again.
export async function extendEnvelope(e: any, days: any, actor: Actor) {
  if (e.kind !== 'envelope' || (e.status !== 'sent' && e.status !== 'expired')) throw bad('Only envelopes that are waiting for signatures, or that expired, can be given more time.');
  const add = int(days, 1, 365, 30);
  const reopened = e.status === 'expired';
  // Reopening emails everyone who is waiting, so it is not done while paused or for what reads like a fake notice.
  // More time for an envelope that is still open emails nobody, so it is always allowed: during a review that takes
  // days, the people who "can still sign" must not run past their deadline. (The timer holds its own warnings back.)
  if (reopened) assertMayEmail(e);
  if (reopened && creditsEnabled()) {
    // Signatures came back when it expired. Reopening holds them again for whoever still has to sign.
    const need = needed(e, senderOf(e) || '');
    const have = available(e.account_id);
    // What is free (your own documents, approvals) is never refused, whatever the balance.
    if (need > 0 && need > have) throw bad(outOfSignatures(get('SELECT * FROM accounts WHERE id=?', e.account_id), need, have), 402);
  }
  const from = reopened ? Date.now() : Math.max(Date.now(), Date.parse(e.expires_at || now()));
  const expires = new Date(from + add * 864e5).toISOString();
  run("UPDATE envelopes SET status='sent', expires_at=?, expiry_warned_at=NULL, updated_at=? WHERE id=?", expires, now(), e.id);
  // More time is a new start for "could not open": if the new deadline passes too and someone runs into it, the
  // sender hears about it again, not only the first time ever.
  run('UPDATE recipients SET dead_link_alerted_at=NULL WHERE envelope_id=?', e.id);
  audit(e.id, actor, reopened ? 'Envelope reopened' : 'Deadline extended', `New deadline ${momentText(expires)}`);
  if (reopened) {
    const fresh = loadEnvelope(e.id);
    for (const r of fresh.recipients) if (r.status === 'sent' || r.status === 'viewed') await notifyRecipient(fresh, r, 'reopened');
    await advance(e.id);
  }
  return expires;
}

// A signer who ran out of time asks the sender for more, in one click.
export async function requestExtension(e: any, r: any, actor: Actor) {
  if (r.status === 'completed' || r.status === 'declined' || (e.status !== 'expired' && e.status !== 'sent')) throw bad('This document is not waiting for you.');
  // A start of a public form that was cleared is nobody's but the visitor's to redo, and an envelope its sender
  // removed from their lists has no page left to give more time from: an email would only lead them to an error.
  if (closedFormStart(e, r)) throw bad(closedStartText(e), 409);
  if (e.hidden_at) throw bad(`${senderOf(e)?.name || 'The sender'} has removed this document from their list, so it cannot be opened again from here and we did not ask them for more time. If you still need to sign it, ask them to send it again.`, 409);
  audit(e.id, actor, 'More time requested', `${r.name} asked for the deadline to be extended`);
  // The deadline by the sender's own clock as well, as in "Expires soon". Someone with no address cannot be answered
  // by email, and the sender is told so in the words the question email uses (answerLine in bysender.ts).
  await notifySender(e, 'always', `More time needed: ${e.subject}`, `${r.name} asked for more time to sign`,
    [e.status === 'expired' ? 'The deadline has passed. You can reopen the envelope and nobody has to start again.' : `The deadline is ${momentForEmail(e.expires_at, senderZone(e))}. You can push it back.`,
      ...(r.link_by_sender ? [answerLine(r)] : [])],
    { label: 'Give more time', url: `${baseUrl()}/app/envelopes/${e.id}?extend=1` });
}

// Someone opened a link that was replaced (after a correction or reassignment) and asked for the current one. It
// goes to whoever holds the document now, never to the page that asked. The answer says what really happened, so
// the page never says "sent" when nothing was: 'sent', 'delayed' (the mail server would not take it yet, and it is
// tried again), 'waiting' (it is not that person's turn, and they are emailed when it is), 'removed' (the person
// this link was for is no longer on the document), 'closed' (the document is no longer open for signing) or
// 'unknown' (not a link of ours). A replaced link is as unguessable as a live one, so only someone who was sent it
// can ask, and none of these answers tells them more than their own emails did.
// 'stopped': the person who holds the document now marked an email about it as spam, so none is sent to them.
// 'ask_sender': the person who holds it now has no email address, because the sender passes their link on.
export type ResendAnswer = 'sent' | 'delayed' | 'waiting' | 'removed' | 'closed' | 'unknown' | 'stopped' | 'ask_sender';
export async function resendFromRetired(oldToken: string): Promise<ResendAnswer> {
  const row = get('SELECT recipient_id FROM retired_tokens WHERE token=?', oldToken);
  if (!row) return 'unknown';
  const r = get('SELECT * FROM recipients WHERE id=?', row.recipient_id);
  const e = r && loadEnvelope(r.envelope_id);
  if (!e) return 'removed';
  if ((e.status !== 'sent' && e.status !== 'completed') || r.status === 'declined') return 'closed';
  if (!r.token || r.status === 'pending') return 'waiting';
  // The person it is with now has no address: the sender passes their link on (bysender.ts). Nothing can be emailed.
  if (r.link_by_sender && !r.email) return 'ask_sender';
  const how = await notifyRecipient(e, e.recipients.find((x: any) => x.id === r.id) || r, 'resent');
  // Nothing was written: the holder of an old link is not the person the document is with now, and that person asked
  // not to be emailed about it. The page says that no email is coming, and to ask the sender.
  return how === false ? 'stopped' : how === 'failed' ? 'delayed' : 'sent';
}

/** How many documents fit in one "Here are your documents" email. */
export const LINKS_PER_EMAIL = 50;
// Where the list stopped for an address that has more documents than fit in one email. Asking again within a day
// carries on from there, so every document can be reached. The place is the last line that was sent and not a
// count: a document that arrives or changes in between moves to the top of the list, and a count would then repeat
// an old line and leave the new one out. `top` is the first line of the round, so whatever comes before it now is
// new or has changed since, and leads the next email. Kept in memory: after a restart the list starts at the top.
type LinkPlace = { at: string; env: string; pos: number };
const linksFrom: Map<string, { top: LinkPlace; last: LinkPlace; until: number }> = ((globalThis as any).__tslinks ??= new Map());
const linkPlace = (x: any): LinkPlace => ({ at: x.at, env: x.env, pos: x.pos });
// The order of the list: the latest change first, and one fixed order among lines of the same moment.
const linkBefore = (a: LinkPlace, b: LinkPlace) => (a.at !== b.at ? a.at > b.at : a.env !== b.env ? a.env > b.env : a.pos < b.pos);

// "I cannot find the email": send every document that is waiting for this address, every one its people have
// signed (also while others have not finished, and also when it was later cancelled, declined or ran out of
// time), and every completed one, to the address that asks for it. Only that inbox receives the links, so asking
// proves nothing and leaks nothing.
export async function emailMyLinks(email: string): Promise<number> {
  // A purged envelope (src/server/records.ts) has nothing left to open: its link only says the sender deleted it.
  const where = `r.email=? AND r.role!='inperson' AND r.token IS NOT NULL AND e.kind='envelope' AND e.purged_at IS NULL
        AND ((e.status='sent' AND r.status IN ('sent','viewed','completed')) OR e.status='completed'
          OR (e.status IN ('voided','declined','expired') AND (r.status='completed' OR r.signed_before IS NOT NULL) AND r.role!='cc'))`;
  const every = all(
    `SELECT r.token, r.name, r.status my_status, r.role, r.position pos, e.id env, e.updated_at at, e.subject, e.status, u.name sender FROM recipients r
       JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id
      WHERE ${where} ORDER BY e.updated_at DESC, e.id DESC, r.position`, email);
  const total = every.length;
  // What is waiting for a group this address is a member of, each with this member's own link (groups.ts). They
  // lead every email, because a group's document is the one a colleague may be waiting for.
  const forGroups = memberLinks(email);
  if (!total && !forGroups.length) return 0;
  const key = email.toLowerCase();
  const at = linksFrom.get(key);
  const going = !!at?.last && at.until > Date.now();
  // What is new or has changed since this round began leads the email, then the list carries on after the last line
  // that was sent. When so much is new that it fills an email by itself, or nothing is left after that line, the
  // place means nothing any more and the list starts at the top again.
  const fresh = going ? every.filter((x) => linkBefore(x, at!.top)) : [];
  const rest = going && fresh.length < LINKS_PER_EMAIL ? every.filter((x) => linkBefore(at!.last, x)) : [];
  const on = fresh.length + rest.length > 0 && fresh.length < LINKS_PER_EMAIL;
  const rows = on ? [...fresh, ...rest].slice(0, LINKS_PER_EMAIL) : every.slice(0, LINKS_PER_EMAIL);
  // Of this email's lines, how many carry on the list, and what number the first of them has in the list as it is now.
  const carried = on ? rows.length - fresh.length : rows.length;
  const skip = on ? total - rest.length : 0;
  const more = total - skip - carried;
  if (more > 0) linksFrom.set(key, { top: on && !fresh.length ? at!.top : linkPlace(rows[0]), last: linkPlace(rows[rows.length - 1]), until: Date.now() + 864e5 });
  else linksFrom.delete(key);
  // When more than one person uses this address (a couple, a shared office inbox), every line says whose link it is.
  const names = new Set(all(`SELECT DISTINCT lower(r.name) n FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE ${where}`, email).map((x) => x.n));
  const state = (x: any) => (x.status === 'completed' ? 'completed'
    : x.status !== 'sent' ? `you ${finishedHow(x)} it, and it was not completed by everyone`
    : x.my_status !== 'completed' ? 'waiting for you' : x.role === 'cc' ? 'your copy' : `you ${finishedHow(x)} it, others have not finished yet`);
  const numbers = carried === 1 ? `number ${skip + 1} of ${total}` : `numbers ${skip + 1} to ${skip + carried} of ${total}, newest first`;
  const part = on && fresh.length ? ` The first ${fresh.length === 1 ? 'one' : fresh.length} below ${fresh.length === 1 ? 'is' : 'are'} new, or changed, since the last email.${carried ? ` After ${fresh.length === 1 ? 'it' : 'them'} the list carries on where that email stopped, with ${numbers}.` : ''}`
    : total > LINKS_PER_EMAIL ? ` ${carried === 1 ? 'This is' : 'These are'} ${numbers}.` : '';
  await sendMail({
    to: email, subject: 'Your documents on Sign&Grow', heading: 'Here are your documents',
    lines: [`You asked us to find your documents. These are the ones sent to this email address.${part}`,
      ...(names.size > 1 ? ['More than one person uses this address. Each link is for the person named under it, and only for them.'] : []),
      ...(more > 0 ? [`${more} more did not fit in this email. To get them, ask again within a day: enter this address under "Find my documents" at ${baseUrl()}/help once more, and the next email carries on where this one stops.`] : []),
      ...(on && more <= 0 ? ['That was the last of them. Asking again starts at the newest.'] : [])],
    links: [...forGroups, ...rows.map((x) => ({ label: x.subject, url: `${baseUrl()}/sign/${x.token}`, note: `${names.size > 1 ? `for ${x.name} · ` : ''}from ${x.sender} · ${state(x)}` }))],
    // The line for someone whose network will not open our pages, as in every request to sign (cannotOpenLine). This
    // email is ours and can list several senders, so a reply to it would not reach any of them: it says whose to use.
    footnote: 'If you did not ask for this, you can ignore it. Nobody else received these links. Page will not open where you are? Reply to the email the sender sent you about that document and ask them to send it as a PDF. This list comes from Sign&Grow, not from them, so a reply to it does not reach them.',
  });
  return rows.length + forGroups.length;
}

// Letters of another alphabet that look like a Latin one, each with the Latin letter it reads as: Cyrillic capitals
// and small letters, Greek capitals and small letters, and the dotless i. Written as code points, because nobody can
// tell them apart in a source file either.
const LOOKALIKES = new Map<string, string>([
  ['АВЕКМНОРСТУХЅІЈ', 'ABEKMHOPCTYXSIJ'],
  ['аеорсухѕіј', 'aeopcyxsij'],
  ['ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ', 'ABEZHIKMNOPTYX'],
  ['οιı', 'oii'],
].flatMap(([from, to]) => [...from].map((ch, i): [string, string] => [ch, to[i]])));
// Names are compared the way a person reads them: case, accents and stray spaces make no difference, and a letter
// that looks like a Latin one reads as that one ("Blair" with a Cyrillic first letter is "Blair").
const nameWords = (s: any): string[] => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\x00-\x7f]/g, (ch) => LOOKALIKES.get(ch) ?? ch).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// A word written in two alphabets at once is how one name is made to pass for another. No name is spelled that way.
const mixesAlphabets = (s: string): boolean => s.normalize('NFKD').split(/[^\p{L}\p{M}\p{N}]+/u).some((w) => /\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w));
// The same word, the beginning of it (an initial, "Jo" for "Joe", "Alex" for "Alexander"), or the same word with one
// letter added, dropped, changed or swapped with its neighbour: "Jon" and "John", "Smyth" and "Smith". That is what a
// spelling fix looks like. In a word of one or two letters a changed letter says nothing: "Li" and "Lu" are two names.
function sameWord(a: string, b: string): boolean {
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  if (Math.min(a.length, b.length) < 3 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rest = (x: number, y: number) => a.slice(i + x) === b.slice(i + y);
  return rest(1, 1) || rest(1, 0) || rest(0, 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(2, 2));
}

/**
 * Is `b` the name `a` in another spelling, so that it is plainly still the same person? Every word of the shorter
 * name has a word of its own in the longer one (see sameWord), and the longer one has at most one word more: a
 * middle name or a second family name put in or left out. A word swapped for another is somebody else as far as
 * software can tell: "Alex Rivera" and "Blair Rivera" are two people in one family, at one address.
 * This is the one test for that question. A signer fixing their own name is held to it (renameSelf), and it decides
 * whether a signature and answers stay with a request when the sender changes the name on it (clearAnswers).
 */
export function samePerson(a: any, b: any): boolean {
  let [few, many] = [nameWords(a), nameWords(b)];
  if (few.length > many.length) [few, many] = [many, few];
  if (!few.length || many.length - few.length > 1) return false;
  const left = [...many];
  // Words that are exactly the same pair up first, so an initial never uses up the word that another one needs.
  for (const exact of [true, false])
    few = few.filter((w) => {
      const i = left.findIndex((m) => (exact ? m === w : sameWord(w, m)));
      if (i >= 0) left.splice(i, 1);
      return i < 0;
    });
  return !few.length;
}

// Which writing systems the letters of a name are in. Two names that both have letters and share no writing system
// (one in Cyrillic and one in Latin, one in kanji and one in kana) are "in different scripts".
const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Arabic', 'Hebrew', 'Thai', 'Devanagari', 'Bengali', 'Tamil', 'Telugu', 'Kannada', 'Malayalam',
  'Gujarati', 'Gurmukhi', 'Sinhala', 'Khmer', 'Lao', 'Myanmar', 'Armenian', 'Georgian', 'Ethiopic'].map((n) => [n, new RegExp(`\\p{Script=${n}}`, 'u')] as const);
const scriptsOf = (s: any): Set<string> => new Set([...String(s ?? '')].filter((ch) => /\p{L}/u.test(ch)).map((ch) => SCRIPTS.find(([, re]) => re.test(ch))?.[0] || 'other'));
function scriptsDiffer(a: any, b: any): boolean {
  const x = scriptsOf(a), y = scriptsOf(b);
  return x.size > 0 && y.size > 0 && ![...x].some((n) => y.has(n));
}

// A signer can fix a slip in the spelling of their own name. It is logged and the sender is always told, whatever
// their email settings, so a name never changes quietly. Anything that is not plainly the same person in another
// spelling (see samePerson, measured against the name the sender wrote) is not applied: a name that is, reads like or
// borrows from another recipient's on this envelope, a word written in two alphabets at once, a word swapped for
// another, several words added. Neither is a name that would make the sender's own free signature somebody else's:
// signing your own document is free under your own name and address only (isSelf), so that change is the sender's
// to make with Correct, where it is counted. Nothing is counted or checked against the balance here.
// What is not applied goes to the sender as a question, once for each name asked for, the signer is told so, and
// the name on the document stays as it was. Returns whether the name was changed, and what to say.
export async function renameSelf(e: any, r: any, newName: string, actor: Actor): Promise<{ applied: boolean; name: string; message: string; version?: number }> {
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw notOpen(e, r);
  // Characters nobody sees have no place in a name on a certificate: control characters, marks that turn the
  // direction of the text after them, and spaces without width.
  const name = str(newName, 120).replace(/[\p{Cc}​‎‏‪-‮⁠-⁩﻿]/gu, ' ').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw bad('Type your name as it should appear.');
  if (name === r.name) return { applied: true, name, message: '' };
  const sender = senderOf(e);
  const from = sender?.name || 'the sender';
  // What the sender wrote for this person. An earlier fix of the signer's own does not count as the sender's word.
  const written = r.self_name && r.self_name === r.name && r.sender_name ? r.sender_name : r.name;
  const mine = nameWords(written);
  const words = nameWords(name);
  // The same question is put to the sender once. Asking it again changes nothing, emails nobody and is answered in
  // the same words. `why` finishes "... to be written as X." for the record.
  const ask = async (why: string, lines: string[]) => {
    const detail = `${signerAt(r)} asked for the name "${r.name}" to be written as "${name}". ${why}, so it was not changed and the sender was asked.`;
    if (get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Name change asked for' AND detail=?", e.id, detail)) return;
    audit(e.id, actor, 'Name change asked for', detail);
    await notifySender(e, 'always', `Name change asked for: ${e.subject}`, `${r.name} asked to be named ${name}`, lines);
  };
  const others = e.recipients.filter((x: any) => x.id !== r.id);
  const taken = others.find((x: any) => samePerson(x.name, name) || nameWords(x.name).some((w) => w.length > 1 && !mine.includes(w) && words.includes(w)));
  const mixed = !taken && mixesAlphabets(name);
  // The same letters in the same order, with only what stands between them changed (a space, a hyphen, a dot, an
  // apostrophe), is the same name: "山田 太郎" and "山田太郎", "Mary-Ann" and "Mary Ann", "J.R. Smith" and "JR Smith".
  const respaced = words.length > 0 && mine.join('') === words.join('');
  // A name offered in another writing system (Latin letters for a Cyrillic name, kana or Latin for kanji) may well
  // be the same name. Software cannot tell, so the sender still decides, but nobody is told that it is a different
  // name or "more than a small fix", which would not be true.
  const otherScript = !taken && !mixed && !respaced && scriptsDiffer(written, name);
  if (taken || mixed || (!respaced && !samePerson(written, name))) {
    const why = taken ? `That is, reads like or borrows from the name of ${taken.name}, who is also on this envelope`
      : mixed ? 'That name has a word written in two alphabets at once, which is how one name is made to look like another'
      : otherScript ? `That is in a different script from "${written}", the name the sender wrote. It may be the same name in another script, which software cannot tell`
      : `That is more than a small spelling fix of "${written}", the name the sender wrote`;
    await ask(why, [`Someone using the signing link of ${labelOf(r)} asked for the name on the document to be "${name}". ${why.replace(', the name the sender wrote', '')}, so we did not change it.`,
      `If "${name}" is right, open the envelope, choose Correct next to ${r.name} and type the name yourself. Their link keeps working. If it is another person's name, whatever was filled in or signed under "${r.name}" is cleared, so the new person starts with an empty document.${r.email ? ` If two people share ${r.email}, check that each of them is using the link from the email that carries their own name.` : ''} If you do nothing, the name stays "${r.name}".`]);
    const told = taken ? `"${name}" is, or reads like, the name of someone else on this document`
      : mixed ? `"${name}" has a word written in two alphabets at once, so we cannot tell whose name it is`
      : `Only a small slip can be corrected here, such as a letter missing or two swapped, and "${name}" differs from "${written}"${written !== r.name ? `, the name ${from} wrote,` : ''} by more than that`;
    if (otherScript) return { applied: false, name: r.name, message: `We did not change it ourselves. "${name}" is written in a different script from "${r.name}". This may be the same name in another script, but software cannot tell, so we asked ${from} to confirm it. They can change it without sending the document again, and your link keeps working. You can wait for their answer, or finish under "${r.name}".` };
    return { applied: false, name: r.name, message: `We did not change it. ${told}, so we asked ${from} instead, and only they can change it. If you are not ${r.name}, this link is not yours: look for the email with your own name on it, or ask ${from}${sender?.email ? ` (${sender.email})` : ''}.` };
  }
  // The sender's own free signature stays free under the sender's own name only. Under any other name it is another
  // person's, and making it that is the sender's choice, taken with Correct, where the signature is counted.
  const own = r.role === 'signer' && !isChargeable(r, sender || '') && sameEmail(r.email, sender?.email) && !paidFor(e.account_id, r);
  if (own && !isSelf({ ...r, name }, sender || '')) {
    await ask(`This request is the sender's own signature on their own document, which is free under the name on the sender's account only, and "${name}" is not that name`,
      [`Someone using the signing link of ${labelOf(r)} asked for the name on the document to be "${name}". This request is your own signature on your own document, which is free under the name on your account, "${from}", and under that name only. So we did not change it.`,
        `If "${name}" is another person, open the envelope, choose Correct next to ${r.name} and type the name yourself. It is then that person's signature and is counted like one. If it is you, and only the spelling of your name on your account is off, change your name under Settings first: after that the signing page accepts it and the signature stays free. If you do nothing, the name stays "${r.name}".`]);
    // Whoever reads this is usually the sender: they are told what they can do themselves, and someone else is told
    // whose link this is.
    return { applied: false, name: r.name, message: `We did not change it. This is ${from}'s own document, and signing it is free under the name on their account only, which is "${from}". If you are ${from}: change your name under Settings first, then fix it here and it stays free. Or change it on the envelope with Correct, where it counts as another person's signature. If you are not ${from}, this link is not yours, and we have asked ${from} to put your name on it.` };
  }
  // Where a full name field prints this name on pages someone has already signed, a new spelling changes what that
  // person signed. Only the sender can decide that, by asking them to sign again, so the sender is asked.
  const over = signedOverName(e, r, true, false);
  if (over.length) {
    const names = listSome(over.map((o: any) => o.name), 8);
    await ask(`The name is printed on the document and ${names} ${over.length === 1 ? 'has' : 'have'} already finished`,
      [`${signerAt(r)} asked for their name to be written "${name}" instead of "${r.name}". That name is printed on the document, and ${names} ${over.length === 1 ? 'has' : 'have'} already finished, so we did not change it.`,
        `If "${name}" is right, open the envelope, choose Edit envelope and change the name there. You are then asked whether ${names} should sign again, and nothing is saved until you say yes. If you do nothing, the name stays "${r.name}".`]);
    return { applied: false, name: r.name, message: `We did not change it here. Your name is printed on the document and ${names} ${over.length === 1 ? 'has' : 'have'} already finished, so only ${from} can change it now. We asked them for you. You can wait for their answer, or finish under "${r.name}" if that is close enough.` };
  }
  run('UPDATE recipients SET name=?, sender_name=?, self_name=? WHERE id=?', name, written, name, r.id);
  audit(e.id, actor, 'Signer corrected their name', `"${r.name}" is now "${name}"`);
  newerVersion(e.id, actor, `corrected their name to "${name}"`);
  // Other people who have the document and see this name printed on it are told, and an open screen of theirs has
  // to load the page again before it can finish. The signer's own screen carries on with the new version.
  await nameChanged(e, `The name "${r.name}" is now written "${name}".`, r.id);
  await notifySender(e, 'always', `Name corrected: ${e.subject}`, `${r.name} corrected their name to ${name}`, [`${signerAt(r)} changed how their name is written, from "${r.name}" to "${name}". It is recorded in the audit trail. If this is not who you expected, void the envelope.`]);
  return { applied: true, name, message: '', version: get('SELECT content_version v FROM envelopes WHERE id=?', e.id)?.v };
}

// Somebody tried to open a link that no longer works (the deadline passed), so the sender can help before being
// asked. Told once for each recipient until the sender does something about it: more time, reopening or sending
// again clears the mark (see extendEnvelope, remindEnvelope and the corrections), and the next time is news again.
export async function noteDeadLink(e: any, r: any, why: string) {
  // Not for an envelope its sender removed from their lists (the link in the email would lead to an error), nor for
  // a public form's start that was cleared: the visitor is offered a fresh form, and the owner has nothing to do.
  if (e.hidden_at || closedFormStart(e, r)) return;
  if (r.status === 'completed' || !run('UPDATE recipients SET dead_link_alerted_at=? WHERE id=? AND dead_link_alerted_at IS NULL', now(), r.id).changes) return;
  await notifySender(e, 'problems', `Could not open: ${e.subject}`, `${r.name} tried to open your document and could not`, [why]);
}

// Somebody opened a link that was replaced: the address or the role was corrected, the document was passed on, or
// the person was taken off. The page they see offers the current link. The sender hears about it once for each
// replaced link, while the envelope is still out, because it usually means someone is looking in the wrong email.
export async function noteReplacedLink(oldToken: string, actor: Actor) {
  const old = get('SELECT * FROM retired_tokens WHERE token=? AND alerted_at IS NULL', oldToken);
  const e = old?.envelope_id && get("SELECT id, subject, account_id, sender_id FROM envelopes WHERE id=? AND status='sent'", old.envelope_id);
  if (!e || !run('UPDATE retired_tokens SET alerted_at=? WHERE token=? AND alerted_at IS NULL', now(), oldToken).changes) return;
  const who = old.sent_to || 'Someone';
  const cur = get('SELECT name, email FROM recipients WHERE id=?', old.recipient_id);
  const what = old.why === 'removed' || !cur ? `${who} was taken off this envelope and opened the link they still had. The page told them that this link was replaced. If they should sign after all, add them again by changing the envelope.`
    : old.why === 'handed' ? `${who} passed this document on to ${cur.name} and then opened their own old link. It no longer opens the document, and the page said so. There is nothing to do unless ${who} should sign after all.`
    : old.why === 'role' ? `The link was emailed to ${who} before you changed what they do on this envelope. The page offered to email them the current link at ${cur.email}. There is nothing to do unless they tell you it did not arrive.`
    : `The link was emailed to ${who} before the address was changed to ${cur.email}. The page said the link was replaced and offered to send the current one, which only ever goes to ${cur.email}. If the person at the old address should still sign, correct the address again or add them.`;
  audit(e.id, actor, 'Replaced link opened', `A link that was sent to ${who} and replaced on ${ts(old.retired_at)} was opened. It did not open the document.`);
  await notifySender(e, 'problems', `Old link opened: ${e.subject}`, `${who} opened a link that no longer works`, [what]);
}

const newCodeHow = (r: any) => `To let ${r.name} in, open the envelope, choose Correct next to their name and type a new access code of at least ${ACCESS_CODE_MIN} characters. Then give it to them yourself, by phone or message: it is never in our emails.`;

// A wrong access code. Only wrong tries are counted. After ACCESS_CODE_TRIES of them in total the code is frozen: it
// opens nothing, also not for the right person, until the sender sets a new one, so a code cannot be guessed by
// trying a few every day. The sender is always told about a freeze, whatever their settings, because nobody gets in
// until they act. Returns how many tries are left.
export async function wrongAccessCode(e: any, r: any, actor: Actor): Promise<number> {
  audit(e.id, actor, 'Access code failed', r.name);
  run('UPDATE recipients SET code_fails=code_fails+1 WHERE id=?', r.id);
  const fails = get('SELECT code_fails n FROM recipients WHERE id=?', r.id).n;
  if (fails >= ACCESS_CODE_TRIES && run('UPDATE recipients SET code_frozen_at=? WHERE id=? AND code_frozen_at IS NULL', now(), r.id).changes) {
    audit(e.id, { name: 'System' }, 'Access code frozen', `${r.name}: ${ACCESS_CODE_TRIES} wrong tries`);
    await notifySender(e, 'always', `Access code frozen: ${e.subject}`, `The access code for ${r.name} is frozen`,
      [`It was entered wrongly ${ACCESS_CODE_TRIES} times, so it no longer opens the document, also not for the right person. That keeps it from being guessed.`, newCodeHow(r), 'Nothing else changed. Everyone else can carry on, and nothing that was filled in is lost.']);
  }
  // After three wrong tries the sender is told, because the usual cause is that the code never reached the signer.
  // The count is this alert's own mark: it passes three once for each code, and a new code starts it again. It no
  // longer shares the "could not open" mark, so one of the two never silences the other.
  else if (fails === 3) void notifySender(e, 'problems', `Could not open: ${e.subject}`, `${r.name} tried to open your document and could not`,
    [`They entered the wrong access code three times. Check that you gave them the right one (it is ${r.access_code}), or change it from the envelope page. Their link keeps working.`]).catch(() => {});
  return Math.max(0, ACCESS_CODE_TRIES - fails);
}

// On the locked screen: "I do not have the code", or the code is frozen. One click tells the sender. No code needed.
export async function requestAccessCode(e: any, r: any, actor: Actor) {
  // Also when the envelope is finished or was closed, and for someone who has finished: the code still stands
  // between them and the document or the copy of what they signed, and the sender can still set a new one
  // (lateAccessCode). So the frozen screen never tells anyone to ask for something that cannot be done.
  if (!r.access_code || e.kind !== 'envelope' || e.status === 'draft') throw bad('This document is not waiting for an access code.');
  // Behind the code of a cancelled or declined document there is only a copy for someone who signed it. Anyone else
  // would have the sender hand out a code that opens nothing, so they are told that instead. (An expired one can
  // still be reopened by the sender, so asking there is kept.)
  if ((e.status === 'voided' || e.status === 'declined') && !keepsCopy(e, r))
    throw bad(`This document was ${e.status === 'voided' ? 'cancelled' : 'declined'} before you signed it, so there is nothing behind the access code for you any more. We did not ask ${senderOf(e)?.name || 'the sender'} for it.`);
  audit(e.id, actor, 'Access code requested', `${r.name} asked the sender for the access code`);
  await notifySender(e, 'always', `Access code needed: ${e.subject}`, `${r.name} cannot open your document`,
    r.code_frozen_at ? [`Their access code was entered wrongly ${ACCESS_CODE_TRIES} times and is frozen, and they asked you for a new one.`, newCodeHow(r)]
      : [`They asked for the access code. It is ${r.access_code}. Give it to them yourself, by phone or message: it is never in our emails.`, 'You can also change the code: open the envelope and choose Correct next to their name.']);
}

// A signer who is unsure asks before signing, instead of signing blind or giving up: a private comment, see
// routes-comments.ts. (askSender, the separate email it replaced, is gone: one way to ask.)

// A message reached the help form about a problem signing this envelope, from the address of one of its recipients.
// The sender can often fix that faster than anyone (send the link again, correct an address, give more time), and
// a stuck signer may have no working link to ask them with. So the sender is told, if they want news of problems,
// and the envelope's record says so. Anyone can type any address into that form: the writer's words are passed on
// only when `text` is given, which the caller does for a writer whose address is confirmed. Once a day for each
// recipient at most. Answers whether the sender was told.
// `byCode` is true when the writer was not matched by the address they typed but by the security code of the email
// we sent this recipient: the help link on the signing page and in the signing emails carries it. That person holds
// the email, which is more than typing an address shows, so the record and the sender are told it that way.
// Nobody can be stuck on an envelope that is not open for signing, or after they have finished or declined, and a
// sender who removed the envelope from their lists has no page to fix it from: none of those is told anything.
export const canBeStuck = (e: any, r: any): boolean =>
  e.kind === 'envelope' && (e.status === 'sent' || e.status === 'expired') && !e.hidden_at && r.status !== 'completed' && r.status !== 'declined';
export async function helpAsked(e: any, r: any, text: string | null, actor: Actor, byCode = false): Promise<boolean> {
  if (!canBeStuck(e, r)) return false;
  const typed = `A message from ${r.email} to the Sign&Grow help form said there is a problem with signing`;
  const held = `Someone who holds the email we sent to ${r.email} told the Sign&Grow help form that there is a problem with signing`;
  if (get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Help requested' AND detail IN (?,?) AND at > ?", e.id, typed, held, new Date(Date.now() - 864e5).toISOString())) return false;
  audit(e.id, actor, 'Help requested', byCode ? held : typed);
  await notifySender(e, 'problems', `Problem signing: ${e.subject}`, `${r.name} may be stuck on your document`,
    [byCode ? `Someone who holds the email we sent to ${r.name} (${r.email}) about this envelope used its help link and told our help form that there is a problem with signing "${e.subject}".`
      : `Someone writing from ${r.email}, the address of ${r.name} on this envelope, told our help form that there is a problem with signing "${e.subject}".`,
      ...(text ? [`They wrote:\n${text}`] : []),
      'You can often fix this faster than we can: open the envelope to copy their signing link, send it again, correct a name or an address, or give more time. A person on our side reads the message too.']);
  return true;
}

export function muteReminders(e: any, r: any, actor: Actor) {
  if (r.muted) return;
  run('UPDATE recipients SET muted=1 WHERE id=?', r.id);
  audit(e.id, actor, 'Reminders stopped', `${r.name} asked not to be reminded again`);
}

export const ABUSE_REASONS = ['phishing', 'spam', 'not-for-me', 'other'];

// A recipient says a request looks wrong. Enough different people saying so pauses the sender until a human looks.
// `e.gone` marks a report made with the security code of an email whose document was deleted since: nothing of the
// envelope is left, so `e` holds only the account it came from, and the report counts against that account like any
// other. A sender who sends, voids and deletes must not be out of reach of the people who still hold the email.
export async function reportAbuse(e: any, r: any, body: any, actor: Actor) {
  const reason = ABUSE_REASONS.includes(body?.reason) ? body.reason : 'other';
  // A person with no address, whose link the sender passed on, is counted as the one person they are (reporterKey).
  const reporter = reporterKey(r);
  if (get('SELECT 1 x FROM abuse_reports WHERE envelope_id=? AND account_id=? AND lower(reporter)=lower(?)', e.id, e.account_id, reporter)) return;
  // The visitor of a public form typed their own name and address, so three made-up visitors are not three
  // recipients. Their report is kept and shown to the people who review reports, and never counts towards a pause.
  // After the start was deleted, `e.via_form` says so (forgotten_codes.via_form): deleting must not make it count.
  const viaForm = !!e.via_form || (!!e.powerform_id && !!e.form_recipient_id && r.id === e.form_recipient_id);
  run('INSERT INTO abuse_reports (id, envelope_id, account_id, reporter, reason, detail, ip, at, via_form) VALUES (?,?,?,?,?,?,?,?,?)', id('abr'), e.id, e.account_id, reporter, reason, str(body?.detail, 2000) || null, actor.ip || null, now(), viaForm ? 1 : 0);
  if (!e.gone) audit(e.id, actor, 'Reported as suspicious', `${r.name}: ${reason}`);
  const account = get('SELECT * FROM accounts WHERE id=?', e.account_id);
  // Reports that are still open and reports an operator confirmed as abuse both count: confirming one must never make
  // the automatic pause less likely. Only reports a person dismissed, or looked at before lifting an earlier pause, do not.
  const since = [new Date(Date.now() - 30 * 864e5).toISOString(), account.unpaused_at || ''].sort()[1];
  const n = get("SELECT COUNT(DISTINCT lower(reporter)) n FROM abuse_reports WHERE account_id=? AND status IN ('open','upheld') AND via_form=0 AND at > ?", e.account_id, since).n;
  const limit = abuseSuspendAfter();
  let paused = false;
  if (!viaForm && n >= limit && !account.suspended_at) {
    run('UPDATE accounts SET suspended_at=?, suspended_reason=? WHERE id=?', now(), `${n} different recipients reported documents from this account`, account.id);
    paused = true;
    // Never pause silently: say why, what still works, and how to reach a person.
    for (const u of all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", account.id))
      await sendMail({ to: u.email, subject: 'Sending is paused on your Sign&Grow account', heading: 'Sending is paused while we review reports',
        lines: [`${n} different recipients reported documents sent from ${account.name} as suspicious, so sending is paused until a person has looked. ${PAUSED_MEANS}`, 'Everything else still works: you can open, download and export every document, and people who already have a document can still open, sign and download it.', 'If this is a mistake, use the contact form. A person reviews every pause.'],
        cta: { label: 'Contact us', url: `${baseUrl()}/help` } });
  }
  const to = process.env.ABUSE_EMAIL || process.env.SUPPORT_EMAIL;
  const sender = senderOf(e);
  if (to)
    await sendMail({ to, subject: `Report: ${e.gone ? 'a document that was deleted since' : e.subject}`, heading: paused ? 'Account paused after reports' : 'A recipient reported a document', ...(isEmail(r.email) ? { replyTo: r.email } : {}),
      lines: [e.gone ? `A document that its sender has deleted since, from the account ${account.name} (${account.id}). The report was made with the security code of an email about it.` : `Envelope ${e.id} from ${sender?.name} <${sender?.email}> (account ${account.name}, ${account.id}).`,
        `Reported by ${e.gone ? r.name : labelOf(r)} as: ${reason}.`, ...(body?.detail ? [`They wrote: ${str(body.detail, 2000)}`] : []),
        ...(viaForm ? ['This person came through a public form and typed their own name and address, so the report does not count towards the automatic pause. A person should still look at it.'] : []),
        `${n} open or confirmed report(s) that count against this account in the last 30 days.${paused ? ' Sending is now paused for it.' : ''}`],
      cta: { label: 'Open the review queue', url: `${baseUrl()}/app/operator` } });
  // The pages say a person looks at every report. When nobody is set up to receive one, say so loudly (once) where
  // the people running the service will see it, instead of keeping reports quietly in a table.
  else if (!(process.env.OPERATOR_EMAILS || '').trim() && !(globalThis as any).__tsreportWarned) {
    (globalThis as any).__tsreportWarned = true;
    console.error(`\n[config] A RECIPIENT REPORTED A DOCUMENT AND NOBODY WAS TOLD. The report (envelope ${e.id}) is stored, but neither ABUSE_EMAIL nor SUPPORT_EMAIL is set and OPERATOR_EMAILS is empty, so no person can see it or any later one. Set them.\n`);
  }
}

// ---- Scheduled work: expirations and automatic reminders -----------------------------------

export async function cronTick(): Promise<{ expired: number; reminded: number; warned: number; unopened: number }> {
  let expired = 0;
  let reminded = 0;
  let warned = 0;
  let unopenedAlerts = 0;
  const t = now();
  // A completed envelope whose signed copy could not be built at the time gets it now.
  // The ones that are due, never-tried first, so a few that cannot be built never block the rest (finalretry.ts).
  for (const eid of finalsDue()) await buildFinal(eid);
  for (const row of all("SELECT id FROM envelopes WHERE status='sent' AND kind='envelope'")) {
    const e = loadEnvelope(row.id);
    if (e.expires_at && e.expires_at < t) {
      run("UPDATE envelopes SET status='expired', updated_at=? WHERE id=?", t, e.id);
      audit(e.id, { name: 'System' }, 'Envelope expired', 'The signing deadline passed');
      fireWebhooks(e.account_id, 'envelope.expired', e.id);
      await notifySender(e, 'problems', `Expired: ${e.subject}`, 'This envelope expired before everyone signed', ['You can reopen it with a new deadline. Nobody who already signed has to sign again.'], { label: 'Reopen envelope', url: `${baseUrl()}/app/envelopes/${e.id}?extend=1` });
      expired++;
      continue;
    }
    // A start from a public form costs nothing to make, and while it is unfinished it counts against what the form
    // can still take. One that its visitor has left alone for a day is closed, so a stranger cannot shut a form by
    // starting and walking away. On a form marked as filled in on a shared device that is an hour, because the next
    // person is already waiting. Typing counts as being there (answers are saved as people type). The start is lost:
    // the visitor's link then says it was cleared and offers an empty form to start again, and the owner is not
    // emailed or asked for more time about it (formstart.ts).
    const visitor = e.form_recipient_id && e.recipients.find((r: any) => r.id === e.form_recipient_id);
    // A visitor who pressed Finish while no signature was free was told that what they filled in is kept and that
    // we email them: that start is never closed for being idle (only the envelope's own deadline applies).
    if (visitor && (visitor.status === 'sent' || visitor.status === 'viewed') && !visitor.form_waits_at) {
      const acted = get("SELECT MAX(at) at FROM audit WHERE envelope_id=? AND actor != 'System'", e.id)?.at || e.sent_at;
      const touched = visitor.touched_at && visitor.touched_at > acted ? visitor.touched_at : acted;
      const shared = !!get('SELECT shared_device s FROM powerforms WHERE id=?', e.powerform_id)?.s;
      const idleMs = shared ? powerformSharedIdleMinutes() * 60_000 : powerformIdleHours() * 3600_000;
      if (Date.now() - Date.parse(touched) > idleMs) {
        run("UPDATE envelopes SET status='expired', expires_at=?, updated_at=? WHERE id=?", t, t, e.id);
        audit(e.id, { name: 'System' }, 'Envelope expired', `Started from a public form and left unfinished for ${shared ? `${powerformSharedIdleMinutes()} minutes` : `${powerformIdleHours()} hours`}`);
        fireWebhooks(e.account_id, 'envelope.expired', e.id);
        expired++;
        continue;
      }
    }
    // Nothing goes to recipients in the name of a sender who is paused, also not from the timer.
    const no = mayWrite(e);
    const held = !!no;
    // What was held back while the guard said no (see advance and noteHeld) goes out now that it says yes again.
    if (e.held_at && !no) {
      run('UPDATE envelopes SET held_at=NULL WHERE id=?', e.id);
      await advance(e.id);
      continue;
    }
    // One warning, three days out, so a deadline never arrives as a surprise.
    if (e.expires_at && !e.expiry_warned_at && Date.parse(e.expires_at) - Date.now() < 3 * 864e5 && Date.parse(e.expires_at) - Date.parse(e.sent_at) > 4 * 864e5) {
      run('UPDATE envelopes SET expiry_warned_at=? WHERE id=?', t, e.id);
      const waiting = e.recipients.filter((r: any) => r.status === 'sent' || r.status === 'viewed');
      if (!held) for (const r of waiting) await notifyRecipient(e, r, 'expiring');
      await notifySender(e, 'problems', `Expires soon: ${e.subject}`, 'This envelope expires in three days', [`It closes on ${momentForEmail(e.expires_at, senderZone(e))}. Still waiting on ${[...waiting.map((r: any) => r.name), ...witnessesWaiting(e)].join(', ') || 'nobody'}. You can extend the deadline if they need longer.`, ...untoldLines(waiting)], { label: 'Extend deadline', url: `${baseUrl()}/app/envelopes/${e.id}?extend=1` });
      warned++;
    }
    // "I never got it": if a request sits unopened, tell the sender once so they can share the link another way.
    const quietMs = (Number(process.env.UNOPENED_ALERT_HOURS) || 48) * 3600_000;
    // Not about the sender's own part: someone who has not opened their own document does not need telling.
    const own = get('SELECT email FROM users WHERE id=?', e.sender_id)?.email || '';
    // And not about someone whose email came back or who marked it as spam: the sender was told exactly that when it
    // happened, and "it may be in a spam folder" would be the wrong advice.
    const unopened = e.recipients.filter((r: any) => r.status === 'sent' && r.role !== 'inperson' && !r.unopened_alerted_at && !r.bounced_at && !r.complained_at && r.sent_at && Date.now() - Date.parse(r.sent_at) > quietMs && !sameEmail(r.email, own));
    if (unopened.length) {
      for (const r of unopened) run('UPDATE recipients SET unopened_alerted_at=? WHERE id=?', t, r.id);
      // In the words that fit how each of them got the link: by our email, or from the sender (bysender.ts).
      await notifySender(e, 'problems', `Not opened yet: ${e.subject}`, `${unopened.map((r: any) => r.name).join(', ')} ${unopened.length === 1 ? 'has' : 'have'} not opened your document`, unopenedLines(unopened));
      unopenedAlerts += unopened.length;
    }
    // An automatic reminder that waited for someone's morning (see below) goes out once it is day where they are.
    // If they have finished, turned reminders off or handed the request on since, or the sender has turned automatic
    // reminders off for the envelope, it is simply dropped. One held back because of how the envelope reads is not
    // dropped without a word: the sender is told, as for any reminder (noteHeld).
    for (const r of e.recipients.filter((r: any) => r.reminder_held_at)) {
      if (!isDaytime(t, r.tz)) continue;
      run('UPDATE recipients SET reminder_held_at=NULL WHERE id=?', r.id);
      if (!(e.reminder_days > 0) || r.muted || (r.status !== 'sent' && r.status !== 'viewed') || !r.sent_at || r.sent_at > r.reminder_held_at) continue;
      if (held) {
        if (no!.status !== 403) await noteHeld(e, no!, 'The automatic reminder was not sent.');
        continue;
      }
      const how = await notifyRecipient(e, r, 'reminder');
      if (how && how !== 'failed') {
        audit(e.id, { name: 'System' }, 'Reminder sent', `${r.name}, once it was morning where they are (${r.tz})`);
        reminded++;
      }
    }
    if (e.reminder_days > 0) {
      const last = e.last_reminder_at || e.sent_at;
      const due = Date.now() - new Date(last).getTime() >= e.reminder_days * 864e5;
      // Automatic reminders keep to the signer's daytime once their device has told us their time zone: between
      // 8:00 and 20:00 there. One that falls in their night waits for the morning instead of waking a phone at 3 a.m.
      // Someone whose zone we do not know is reminded as before, at about the hour the envelope was sent. A reminder
      // the sender asks for by hand always goes out at once.
      // Someone whose link the sender passes on gets no email, so their night does not matter: the sender is told.
      const asleep: any[] = due && !held ? e.recipients.filter((r: any) => (r.status === 'sent' || r.status === 'viewed') && !r.muted && !r.link_by_sender && validZone(r.tz) && !isDaytime(t, r.tz)) : [];
      if (asleep.length) {
        // Everyone awake is reminded now, one by one. The people whose link the sender passes on are put to the
        // sender in one email for all of them, as when nobody is asleep, not in one email each.
        const awake = e.recipients.filter((r: any) => (r.status === 'sent' || r.status === 'viewed') && !asleep.includes(r));
        await remindThroughSender(e, awake, { name: 'System' });
        for (const r of awake.filter((r: any) => !r.link_by_sender)) reminded += (await remindEnvelope(e, { name: 'System' }, r.id)) ? 1 : 0;
        for (const r of asleep) run('UPDATE recipients SET reminder_held_at=? WHERE id=?', t, r.id);
        run('UPDATE envelopes SET last_reminder_at=? WHERE id=?', t, e.id);
        audit(e.id, { name: 'System' }, 'Reminder waits for the morning', `${asleep.map((r: any) => `${r.name} (${r.tz})`).join(', ')}: it is night where they are, so the reminder goes out at ${REMINDER_DAY_START}:00 their time.`);
      } else if (due && !held) reminded += (await remindEnvelope(e, { name: 'System' })) ? 1 : 0;
      // A reminder that is due and is held back because of how the envelope reads is not dropped without a word:
      // the sender is told once and the record says why. (A paused account has been told about the pause.)
      else if (due && no!.status !== 403) await noteHeld(e, no!, 'The automatic reminder was not sent.');
    }
  }
  return { expired, reminded, warned, unopened: unopenedAlerts };
}
