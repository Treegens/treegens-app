import { all, get, run, tx, saveBlob, readBlob } from './db.ts';
import { bad, id, token, sha256, now, isEmail, str, baseUrl, checkCode } from './util.ts';
import { sendMail, onMailOutcome, type MailStatus } from './mail.ts';
import { renderEnvelopePdf } from './pdf.ts';
import { fireWebhooks } from './webhooks.ts';
import { sheetsSaved, impactOf, fmtNum, PRICING } from '../lib/impact.ts';
import { creditsEnabled, available, needed, isChargeable, grant, sameEmail } from './credits.ts';
import { DATE_FORMATS } from '../lib/dates.ts';
import { abuseSuspendAfter, newAccountDailyRecipients, unpaidDailyRecipients, powerformIdleHours, ACCESS_CODE_MIN, ACCESS_CODE_TRIES } from '../lib/policy.ts';

export const ROLES = ['signer', 'approver', 'cc', 'viewer', 'inperson'];
export const FIELD_TYPES = ['signature', 'initials', 'date_signed', 'full_name', 'email', 'text', 'number', 'date', 'company', 'title', 'checkbox', 'radio', 'dropdown', 'attachment', 'note'];
const AUTO_TYPES = ['date_signed', 'full_name', 'email'];
const ACTS = (role: string) => role === 'signer' || role === 'inperson';

export type Actor = { name: string; ip?: string; ua?: string };

// ---- Audit trail (hash chained) ------------------------------------------------------------

export function audit(envelopeId: string, actor: Actor, action: string, detail = '') {
  const prev = get('SELECT hash FROM audit WHERE envelope_id=? ORDER BY seq DESC LIMIT 1', envelopeId)?.hash || '';
  const at = now();
  const hash = sha256(JSON.stringify([prev, envelopeId, at, actor.name, action, detail, actor.ip || '']));
  run('INSERT INTO audit (envelope_id, at, actor, action, detail, ip, user_agent, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)',
    envelopeId, at, actor.name, action, detail, actor.ip || null, (actor.ua || '').slice(0, 300) || null, prev, hash);
}

export const auditTrail = (envelopeId: string) => all('SELECT seq, at, actor, action, detail, ip, prev_hash, hash FROM audit WHERE envelope_id=? ORDER BY seq', envelopeId);

export function verifyChain(envelopeId: string): { ok: boolean; events: number; head: string } {
  let prev = '';
  const rows = auditTrail(envelopeId);
  for (const a of rows) {
    const h = sha256(JSON.stringify([prev, envelopeId, a.at, a.actor, a.action, a.detail, a.ip || '']));
    if (a.prev_hash !== prev || a.hash !== h) return { ok: false, events: rows.length, head: prev };
    prev = h;
  }
  return { ok: true, events: rows.length, head: prev };
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
    'SELECT d.id, d.name, d.position, d.file_id, f.pages, f.page_sizes, f.sha256, f.size, f.scan_pages FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=? ORDER BY d.position',
    envelopeId,
    // Which pages are pictures with no text is kept with the file and said wherever the file is listed, so the
    // warning about a scan does not disappear when a draft is opened again.
  ).map((d) => ({ ...d, page_sizes: JSON.parse(d.page_sizes), ...scanFlag(d.scan_pages) }));
  e.recipients = all('SELECT * FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', envelopeId);
  e.fields = all('SELECT * FROM fields WHERE envelope_id=?', envelopeId).map((f) => ({ ...f, options: f.options ? JSON.parse(f.options) : [] }));
  return e;
}

// What a sender sees: no signing tokens, no bulky signature images.
export function publicEnvelope(e: any) {
  return {
    ...e,
    recipients: e.recipients.map(({ token: _t, signature_png, initials_png, user_agent: _u, ...r }: any) => ({ ...r, has_signature: !!signature_png })),
  };
}

export function createEnvelope(account: any, userId: string, kind: 'envelope' | 'template', init: any = {}): string {
  const eid = id(kind === 'template' ? 'tpl' : 'env');
  const t = now();
  run(
    'INSERT INTO envelopes (id, account_id, sender_id, kind, subject, message, reminder_days, expire_days, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    eid, account.id, userId, kind, str(init.subject, 200), str(init.message, 5000), account.default_reminder_days ?? 0, account.default_expire_days ?? 120, t, t,
  );
  return eid;
}

const clamp01 = (n: any) => Math.min(1, Math.max(0, Number(n) || 0));
const int = (n: any, lo: number, hi: number, d: number) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : d);

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

  const docs = Array.isArray(body.documents) ? body.documents : [];
  const recs = Array.isArray(body.recipients) ? body.recipients : [];
  const flds = Array.isArray(body.fields) ? body.fields : [];
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
  run('UPDATE envelopes SET subject=?, message=?, ordered=?, reminder_days=?, expire_days=?, date_format=?, updated_at=?, edit_version=edit_version+1, edited_by=?, edited_at=? WHERE id=?',
    str(body.subject ?? e.subject, 200), str(body.message ?? e.message, 5000), body.ordered ? 1 : 0,
    int(body.reminder_days, 0, 60, e.reminder_days), int(body.expire_days, 1, 365, e.expire_days),
    (DATE_FORMATS as readonly string[]).includes(body.date_format) ? body.date_format : e.date_format, t, by?.name || null, t, e.id);
  run('DELETE FROM fields WHERE envelope_id=?', e.id);
  run('DELETE FROM documents WHERE envelope_id=?', e.id);
  docs.forEach((d: any, i: number) => {
    const f = get('SELECT id, pages, name FROM files WHERE id=? AND account_id=?', d.file_id, accountId);
    if (!f) throw bad('A document in this envelope no longer exists. Upload it again.');
    const did = docId(d.id);
    docPages.set(did, f.pages);
    run('INSERT INTO documents (id, envelope_id, file_id, name, position) VALUES (?,?,?,?,?)', did, e.id, f.id, str(d.name || f.name, 200), i);
  });
  const seen = new Set<string>();
  recs.forEach((r: any, i: number) => {
    const rid = recId(r.id);
    if (seen.has(rid)) return;
    seen.add(rid);
    // A role we do not have is a mistake to point out, not a signer to assume. Leaving the role out means signer.
    if (r.role != null && r.role !== '' && !ROLES.includes(r.role))
      throw bad(`Recipient ${i + 1}${r.name ? ` (${str(r.name, 120)})` : ''} has the role "${str(r.role, 40)}", which does not exist. Use one of: ${ROLES.join(', ')}. Nothing was saved.`);
    const role = ROLES.includes(r.role) ? r.role : 'signer';
    const email = str(r.email, 254).trim();
    // A draft may hold a half-typed address so the rest of the work is never lost; it is checked before sending.
    if (correcting && email && !isEmail(email)) throw bad(`"${email}" is not a valid email address.`);
    const vals = [role, str(r.role_name, 80) || null, str(r.name, 120).trim(), email, int(r.routing_order, 1, 99, 1), i, str(r.access_code, 50).trim() || null, str(r.note, 1000) || null];
    // Someone who has finished stays exactly as they were. A request that would change who they are is refused out
    // loud, never ignored, unless the sender chose to ask them to sign again.
    if (doneIds.has(rid)) {
      const o = oldRecs.get(rid);
      const same = o.role === role && o.name === vals[2] && sameEmail(o.email, email) && o.routing_order === vals[4];
      if (!same && !resign)
        throw bad(`${o.name} has already finished, so their name, email address, role and place in the order can no longer be changed. Nothing was saved. If you did not mean to change them, load the envelope again: their details may be newer than your copy. To change them anyway, send the same request with "resign": true, and ${o.name} is asked to sign again.`, 409, { code: 'sign_again', sign_again: [o.name], changes: [`The name, email address, role or place in the order of ${o.name} <${o.email}>.`] });
      if (same) {
        run('UPDATE recipients SET position=? WHERE id=?', i, rid);
        return;
      }
    }
    if (oldRecs.has(rid)) run('UPDATE recipients SET role=?, role_name=?, name=?, email=?, routing_order=?, position=?, access_code=?, note=? WHERE id=?', ...vals, rid);
    else run('INSERT INTO recipients (role, role_name, name, email, routing_order, position, access_code, note, id, envelope_id) VALUES (?,?,?,?,?,?,?,?,?,?)', ...vals, rid, e.id);
  });
  for (const rid of oldRecs.keys()) if (!seen.has(rid)) run('DELETE FROM recipients WHERE id=?', rid);
  flds.forEach((f: any, i: number) => {
    // A field that cannot be placed is named with its place in the list. It is never dropped without a word.
    const which = `Field ${i + 1}${f?.label ? ` ("${str(f.label, 60)}")` : ''}`;
    if (!FIELD_TYPES.includes(f?.type)) throw bad(`${which} has the type "${str(f?.type, 40)}", which does not exist. Use one of: ${FIELD_TYPES.join(', ')}. Nothing was saved.`);
    const did = docId(f.document_id);
    if (!docPages.has(did)) throw bad(`${which}, a ${f.type} field, points at the document "${str(f.document_id, 60)}", which is not in this envelope. Use the id of one of its documents. Nothing was saved.`);
    const rid = f.type === 'note' ? null : recId(f.recipient_id);
    if (rid && !seen.has(rid))
      throw bad(f.recipient_id ? `${which}, a ${f.type} field, is for the recipient "${str(f.recipient_id, 60)}", who is not on this envelope. Use the id of one of its recipients, or add that person. Nothing was saved.`
        : `${which}, a ${f.type} field, has no recipient_id. Every field except a note belongs to one recipient. Nothing was saved.`);
    const fid = fldId(f.id);
    const old = oldFields.get(fid);
    const w = Math.min(1, Math.max(0.005, Number(f.w) || 0.1));
    const h = Math.min(1, Math.max(0.005, Number(f.h) || 0.03));
    const prefilled = ['text', 'number', 'date', 'company', 'title', 'note', 'checkbox', 'radio', 'dropdown'].includes(f.type);
    // Signatures, initials and attachments are never set by the sender. During a correction, keep what signers put there.
    // During a correction, whatever a signer already entered is kept: an editor that was opened earlier must never
    // wipe it. The sender can still set a value on a field that is empty, on their own read-only fields, and on a
    // field that still holds exactly what the sender put there (prefill).
    const senderOwned = f.type === 'note' || (old ? !!old.readonly : !!f.readonly);
    const answered = correcting && !!old && !senderOwned && old.value != null && old.value !== old.prefill;
    const value = answered ? old.value : prefilled ? str(f.value, 4000) || null : correcting && old ? old.value : null;
    const readonly = f.readonly || f.type === 'note' ? 1 : 0;
    // The sender's own wording in a field its signer may still change. Kept beside the value: see db.ts. A signer
    // who emptied the field did not change what the sender wrote, so a save that leaves it empty keeps the wording.
    const prefill = answered ? old.prefill : prefilled && !readonly ? value ?? (correcting && old && old.value == null ? old.prefill : null) : null;
    run('INSERT INTO fields (id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, label, value, options, group_name, validation, readonly, prefill) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      fid, e.id, did, rid, f.type, int(f.page, 0, docPages.get(did)! - 1, 0),
      Math.min(clamp01(f.x), 1 - w), Math.min(clamp01(f.y), 1 - h), w, h, f.required === false || f.required === 0 ? 0 : 1,
      str(f.label, 120) || null, value,
      Array.isArray(f.options) ? JSON.stringify(f.options.slice(0, 100).map((o: any) => str(o, 200))) : null,
      str(f.group_name, 80) || null, str(f.validation, 200) || null, readonly, prefill);
  });
}

// A save that was made from an older copy than the one stored is refused, so one editor never wipes what another
// just saved (a colleague on a shared template, or a second tab). The editor sends the edit_version it loaded. A
// caller that sends none is not checked. Called inside the transaction that writes, with e read just before it.
function assertFresh(e: any, body: any) {
  if (body.edit_version == null || Number(body.edit_version) === e.edit_version) return;
  const what = e.kind === 'template' ? 'template' : e.status === 'draft' ? 'draft' : 'envelope';
  const who = str(e.edited_by, 200).replace(/\s*<[^>]*>$/, '') || 'Someone';
  throw bad(`${who} saved this ${what} on ${ts(e.edited_at || e.updated_at)}, after you opened it. Your changes were not saved, so nothing of theirs is lost. Load their version and make your changes again, or keep yours as a separate copy.`,
    409, { code: 'stale', edit_version: e.edit_version, edited_by: who, edited_at: e.edited_at || e.updated_at });
}

// Replaces the whole draft: documents, recipients and fields. The editor sends its full state on every save.
// `by` is who is saving an envelope that already exists (PUT). Only then is the copy they worked from checked: a new
// envelope has no earlier copy to be out of date against.
export function saveDraft(e: any, body: any, accountId: string, by?: Actor) {
  if (e.status !== 'draft') throw bad('Only drafts and templates can be edited.');
  tx(() => {
    if (by) assertFresh(e, body);
    writeContent(e, body, accountId, false, by);
  });
}

function assertSendable(e: any) {
  if (!e.documents.length) throw bad('Add at least one document before sending.');
  if (!e.recipients.length) throw bad('Add at least one recipient before sending.');
  for (const r of e.recipients) {
    if (!r.name) throw bad('Every recipient needs a name.');
    if (!isEmail(r.email)) throw bad(`${r.name} needs a valid email address.`);
    if (ACTS(r.role) && !e.fields.some((f: any) => f.recipient_id === r.id && f.type !== 'note'))
      throw bad(`${r.name} has nothing to sign yet. Place at least one field for them.`);
  }
  if (!e.recipients.some((r: any) => r.role !== 'cc')) throw bad('Add at least one recipient who signs, approves or views.');
}

const r6 = (n: number) => Math.round(n * 1e6);
const byFirst = (a: any[], b: any[]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

const ts = (s: any) => String(s ?? '').replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

// The words the sender put on a page: a note, a read-only value, or the value a signer's field starts out with.
// Every signer is shown these from the first time they open the document, whoever the field belongs to.
export const senderText = (f: any): string => (f.type === 'note' || f.readonly ? f.value : f.prefill) ?? '';

// What is printed on the pages whoever fills them in: the files in their order, where every field sits and whose it
// is, the sender's own wording, and how dates are written. Once someone has finished, this only changes if the
// sender chooses to ask the people who finished to sign again.
function printedView(x: any): string {
  return JSON.stringify({
    docs: x.documents.map((d: any) => [d.id, d.file_id]),
    dates: x.date_format ?? '',
    fields: x.fields.map((f: any) => [f.id, f.document_id, f.recipient_id, f.type, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), f.readonly ? 1 : 0, senderText(f)]).sort(byFirst),
  });
}

// Everything a signing screen shows or asks for, for anyone. When a correction changes it, the content version goes up.
function seenView(x: any): string {
  return JSON.stringify({
    docs: x.documents.map((d: any) => [d.id, d.file_id, d.name]),
    dates: x.date_format ?? '',
    fields: x.fields.map((f: any) => [f.id, f.document_id, f.recipient_id, f.type, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), f.readonly ? 1 : 0, senderText(f),
      f.required, f.label ?? '', (f.options || []).join('\n'), f.group_name ?? '', f.validation ?? '']).sort(byFirst),
  });
}

// What one recipient is being asked to read and fill in. If it changes under them, they are told.
function askView(x: any, recipientId: string): string {
  return JSON.stringify({
    docs: x.documents.map((d: any) => [d.file_id, d.name]),
    fields: x.fields.filter((f: any) => !f.recipient_id || f.recipient_id === recipientId)
      .map((f: any) => [f.id, f.document_id, f.type, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), f.required, f.label ?? '', senderText(f)]).sort(byFirst),
    // What the sender wrote in other people's fields is shown to this person as well.
    words: x.fields.filter((f: any) => f.recipient_id && f.recipient_id !== recipientId && senderText(f))
      .map((f: any) => [f.id, f.document_id, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), senderText(f)]).sort(byFirst),
  });
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
function clearAnswers(recipientId: string) {
  run("UPDATE fields SET value=prefill WHERE recipient_id=? AND readonly=0 AND type!='note'", recipientId);
  run('UPDATE recipients SET signature_png=NULL, initials_png=NULL, ip=NULL, user_agent=NULL, seen_version=NULL, signed_before=NULL WHERE id=?', recipientId);
}

const ROLE_WORDS: Record<string, string> = { signer: 'signer', approver: 'approver', cc: 'copy recipient', viewer: 'viewer', inperson: 'in-person signer' };
const listSome = (l: string[], max = 6) => (l.length > max ? `${l.slice(0, max).join(', ')} and ${l.length - max} more` : l.join(', '));

// A correction in words that someone with no account could follow. `people` says who was added, removed or
// replaced, with addresses, and goes to the audit trail only. `content` says what changed on the documents: files
// (with the fingerprints of both), fields and whose they are, and the sender's own wording. It goes to the audit
// trail too, and to the signers who have to look again, so it names people without their addresses.
function describeCorrection(a: any, b: any): { people: string[]; content: string[]; other: string[] } {
  const people: string[] = [], content: string[] = [], other: string[] = [];
  const q = (s: any, max = 300) => `"${str(s, max)}"`;
  const who = (r: any) => `${r.name} <${r.email}>`;
  const pages = (n: number) => `${n} page${n === 1 ? '' : 's'}`;
  if (a.subject !== b.subject) other.push(`Subject changed from ${q(a.subject)} to ${q(b.subject)}.`);
  if (a.message !== b.message) other.push(b.message ? `Message to recipients changed to ${q(b.message, 500)}.` : 'Message to recipients removed.');
  if (!!a.ordered !== !!b.ordered) other.push(b.ordered ? 'Signing in order turned on.' : 'Signing in order turned off, so everyone can sign at once.');
  if (a.reminder_days !== b.reminder_days) other.push(b.reminder_days ? `Automatic reminders set to every ${b.reminder_days} day${b.reminder_days === 1 ? '' : 's'}.` : 'Automatic reminders turned off.');
  if ((a.date_format ?? '') !== (b.date_format ?? '')) content.push(`Dates on the document are now written as ${b.date_format}${a.date_format ? `, not ${a.date_format}` : ''}.`);

  const docA = new Map<string, any>(a.documents.map((d: any) => [d.id, d])), docB = new Map<string, any>(b.documents.map((d: any) => [d.id, d]));
  for (const d of b.documents) {
    const o = docA.get(d.id);
    if (!o) content.push(`Document ${q(d.name)} added (${pages(d.pages)}, SHA-256 ${d.sha256}).`);
    else if (o.file_id !== d.file_id) content.push(`The file of document ${q(d.name)} was replaced. Before: ${pages(o.pages)}, SHA-256 ${o.sha256}. Now: ${pages(d.pages)}, SHA-256 ${d.sha256}.`);
    if (o && o.name !== d.name) content.push(`Document ${q(o.name)} renamed to ${q(d.name)}.`);
  }
  for (const o of a.documents) if (!docB.has(o.id)) content.push(`Document ${q(o.name)} removed (${pages(o.pages)}, SHA-256 ${o.sha256}).`);
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
    const bits: string[] = [];
    if (!sameEmail(o.email, r.email)) people.push(`${who(o)} was replaced by ${who(r)}: the email address changed from ${o.email} to ${r.email}.`);
    else if (o.name !== r.name) bits.push(`name changed from ${q(o.name)} to ${q(r.name)}`);
    if (o.role !== r.role) bits.push(`role changed from ${ROLE_WORDS[o.role]} to ${ROLE_WORDS[r.role]}`);
    if (o.routing_order !== r.routing_order && (a.ordered || b.ordered)) bits.push(`place in the signing order changed from ${o.routing_order} to ${r.routing_order}`);
    if ((o.access_code || '') !== (r.access_code || '')) bits.push(!r.access_code ? 'access code removed' : o.access_code ? 'access code changed' : 'access code added');
    if ((o.note || '') !== (r.note || '')) bits.push('private note changed');
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
  for (const f of b.fields) {
    const o = fldA.get(f.id);
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
    if (o.type === 'note') content.push(`A note was removed from ${where(o, a)}: ${q(senderText(o), 1000)}.`);
    else {
      note(owner(o, a), 'removed', name(o, a));
      if (senderText(o)) content.push(`Wording from the sender removed from ${where(o, a)}: ${q(senderText(o), 1000)}.`);
    }
  }
  for (const [person, l] of per) {
    const bits = [l.added.length ? `added ${listSome(l.added)}` : '', l.moved.length ? `moved or resized ${listSome(l.moved)}` : '', l.removed.length ? `removed ${listSome(l.removed)}` : '', l.set.length ? `changed the settings of ${listSome(l.set)}` : ''].filter(Boolean);
    content.push(`Fields for ${person}: ${bits.join('; ')}.`);
  }
  return { people, content, other };
}

// On an envelope that is signed in order: the people who have the document although someone before them has not
// finished. Follows advance(): a copy at the front of the queue goes out at once and holds nobody up.
function outOfTurn(x: any): any[] {
  if (!x.ordered) return [];
  const waiting = x.recipients.filter((r: any) => r.status !== 'completed' && r.role !== 'cc');
  const turn = Math.min(...waiting.map((r: any) => r.routing_order));
  return waiting.filter((r: any) => (r.status === 'sent' || r.status === 'viewed') && r.routing_order > turn);
}

const finishedHow = (r: any) => (ACTS(r.role) ? 'signed' : r.role === 'approver' ? 'approved' : 'viewed');

// A signature that no longer stands because the sender changed what was signed. It is never thrown away: the audit
// trail says when it was given, from where and what was entered, and the signature itself is kept (earlier_signatures).
function setAside(e: any, o: any, actor: Actor, after?: any) {
  // `after` is the same recipient once the correction is saved: gone, handed to someone at another address, or asked again.
  const removed = !after, passed = !!after && !sameEmail(after.email, o.email);
  const answers = e.fields.filter((f: any) => f.recipient_id === o.id && !f.readonly && f.value != null && f.value !== '')
    .map((f: any) => ({ id: f.id, type: f.type, label: f.label, document_id: f.document_id, page: f.page, value: f.value }));
  run('INSERT INTO earlier_signatures (envelope_id, recipient_id, name, email, role, completed_at, ip, signature_png, initials_png, answers, set_aside_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    e.id, o.id, o.name, o.email, o.role, o.completed_at, o.ip, o.signature_png, o.initials_png, JSON.stringify(answers), now());
  const said = answers.filter((a: any) => a.type !== 'signature' && a.type !== 'initials')
    .map((a: any) => `${a.label || a.type.replace('_', ' ')} on page ${a.page + 1}: ${a.type === 'checkbox' || a.type === 'radio' ? 'ticked' : a.type === 'attachment' ? 'a file' : `"${str(a.value, 300)}"`}`);
  const mark = ACTS(o.role) ? 'signature' : o.role === 'approver' ? 'approval' : 'confirmation';
  audit(e.id, actor, removed || passed ? `Earlier ${mark} set aside` : ACTS(o.role) ? 'Asked to sign again' : o.role === 'approver' ? 'Asked to approve again' : 'Asked to look again',
    `${o.name} <${o.email}> ${finishedHow(o)} on ${ts(o.completed_at)}${o.ip ? ` from ${o.ip}` : ''}. The sender changed the envelope after that, so that ${mark} no longer counts. It is kept on record${o.signature_png ? `, with a signature image whose SHA-256 is ${sha256(o.signature_png)}` : ''}.`
    + `${said.length ? ` What they had entered: ${listSome(said, 40)}.` : ''} ${removed ? 'They were taken off the envelope.' : passed ? `Their place on the envelope went to ${after.name} <${after.email}>.` : `They are asked to look at the changed document and ${ACTS(o.role) ? 'sign' : o.role === 'approver' ? 'approve' : 'confirm'} again.`}`);
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
  const changedFor: any[] = [];
  const held: any[] = [];
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
    const again: any[] = done.filter((o: any) => printed || touched(o));
    if (again.length && body.resign !== true) {
      const names = listSome(again.map((o: any) => o.name), 8);
      const all = [...changes.content, ...changes.people.filter((p) => again.some((o: any) => p.includes(`<${o.email}>`)))];
      const what = `${all.slice(0, 8).join(' ')}${all.length > 8 ? ` And ${all.length - 8} more changes.` : ''}`;
      throw bad(`${names} ${again.length === 1 ? 'has' : 'have'} already finished, and this change touches what they signed. ${what} Nothing was saved. To save it, send the same request with "resign": true. ${names} will then be told what changed and asked to sign again, and the first signature stays on record. Names, email addresses and the order of the people who have not finished can change without that.`,
        409, { code: 'sign_again', sign_again: again.map((o: any) => o.name), changes: all });
    }
    const againIds = new Set<string>(again.map((o: any) => o.id));
    assertSendable(after);
    // A correction is checked like a first send. The fake-notice filter reads the corrected text. Everyone who is
    // added, or whose address changes, counts towards the daily limit, and none of that is allowed while paused.
    assertCodes(after.recipients, oldById);
    const reach = after.recipients.filter((r: any) => !sameEmail(oldById.get(r.id)?.email, r.email)).map((r: any) => r.email);
    assertMayEmail(after, reach, { pause: reach.length > 0 });
    noteReached(after, reach);
    // A new access code starts clean: wrong tries at the old one are forgotten, and a frozen code opens again.
    for (const r of after.recipients) if (oldById.has(r.id) && (oldById.get(r.id).access_code || '') !== (r.access_code || '')) run('UPDATE recipients SET code_fails=0, code_frozen_at=NULL WHERE id=?', r.id);
    const senderEmail = senderOf(e)?.email || '';
    for (const r of after.recipients) {
      const old = oldById.get(r.id);
      // Whether a signature is paid for is settled when a person is added or their address changes, and kept otherwise.
      if (!old || !sameEmail(old.email, r.email) || old.free == null) run('UPDATE recipients SET free=? WHERE id=?', sameEmail(r.email, senderEmail) ? 1 : 0, r.id);
      if (!old) {
        run('UPDATE recipients SET token=?, check_code=? WHERE id=?', token(), checkCode(), r.id);
        continue;
      }
      const otherPerson = !sameEmail(old.email, r.email);
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
        if (!otherPerson) run('UPDATE recipients SET free=1 WHERE id=?', r.id);
        run("UPDATE fields SET value=NULL WHERE recipient_id=? AND type IN ('signature','initials')", r.id);
      } else if (old.status === 'completed') continue;
      if (otherPerson || old.role !== r.role) {
        // A different person or a different job: the old link dies and they are asked afresh when it is their turn.
        // A different person starts with empty fields. The clock for "not opened yet" starts with their own email.
        retireToken(old, otherPerson ? 'address' : 'role');
        if (otherPerson) clearAnswers(r.id);
        run("UPDATE recipients SET status='pending', token=?, check_code=?, sent_at=NULL, viewed_at=NULL, consent_at=NULL, muted=0, unopened_alerted_at=NULL, dead_link_alerted_at=NULL WHERE id=?", token(), checkCode(), r.id);
      } else if (old.status !== 'pending' && !againIds.has(r.id) && askView(e, r.id) !== askView(after, r.id)) changedFor.push(r);
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
    if (creditsEnabled()) {
      // Signers added by this correction need signatures like any others. A change that needs no more than before
      // (a name, a field, a date) is never refused, whatever the balance.
      const more = needed(loadEnvelope(e.id), senderEmail) - needed(e, senderEmail);
      const have = available(e.account_id);
      if (more > 0 && have < 0) throw bad(outOfSignatures(get('SELECT * FROM accounts WHERE id=?', e.account_id), more, have + more), 402);
    }
    const pages = after.documents.reduce((n: number, d: any) => n + d.pages, 0);
    run('UPDATE envelopes SET sheets=? WHERE id=?', sheetsSaved(pages, after.recipients.length), e.id);
    // Signing screens that are open on the old content are told so when they save or finish: see completeRecipient.
    if (seenView(after) !== seenView(e)) run('UPDATE envelopes SET content_version=content_version+1 WHERE id=?', e.id);
    // What the documents changed to, in words that can be passed on to the people who have to look again.
    if (changes.content.length) run('UPDATE envelopes SET last_change=? WHERE id=?', changes.content.join(' ').slice(0, 4000), e.id);
    // The audit trail, and so the certificate, says what was changed and what it meant for the people on the
    // envelope. A save that changed nothing leaves no line.
    const said = [...changes.other, ...changes.people, ...changes.content,
      ...again.filter((o: any) => sameEmail(nowById.get(o.id)?.email, o.email)).map((o: any) => `${o.name} had already ${finishedHow(o)} and is asked to ${ACTS(o.role) ? 'sign' : o.role === 'approver' ? 'approve' : 'look'} again.`),
      ...held.map((r: any) => `${r.name} had the document and now waits, because someone before them in the signing order has not finished.`)];
    if (said.length) audit(e.id, actor, 'Envelope corrected', said.join(' '));
    for (const o of again) setAside(e, o, actor, nowById.get(o.id));
    after = loadEnvelope(e.id);
  });
  const sender = senderOf(e);
  const mail = { envelopeId: e.id, brand: brandOf(e.account_id), replyTo: sender.email, fromName: sender.name };
  for (const r of removed)
    if (r.role !== 'inperson')
      await sendMail({ to: r.email, subject: `No longer needed: ${e.subject}`, heading: r.status === 'completed' ? 'You are no longer on this document' : 'You no longer need to sign this',
        lines: [r.status === 'completed' ? `${sender.name} changed the document and took you off it. What you ${finishedHow(r)} on ${ts(r.completed_at)} is no longer part of it. There is nothing more for you to do.` : `${sender.name} changed the document and you are no longer on it. There is nothing more for you to do.`], ...mail });
  for (const r of held)
    if (r.role !== 'inperson')
      await sendMail({ to: r.email, subject: `Not your turn yet: ${after.subject}`, heading: 'It is not your turn yet',
        lines: [`${sender.name} changed this document, and someone who signs before you now has to finish first. Until they have, the link you have says it is not your turn yet.`, 'You do not need to do anything now. We will email you as soon as it is your turn. Anything you already filled in is kept.'], recipientId: r.id, ...mail });
  for (const r of changedFor) if (!held.some((h) => h.id === r.id)) await notifyRecipient(after, r, 'updated');
  fireWebhooks(e.account_id, 'envelope.corrected', e.id);
  await advance(e.id);
}

// Copies an envelope or template into a new draft. Used for templates, cloning, bulk send and PowerForms.
export function copyEnvelope(src: any, o: { accountId: string; senderId: string; kind: 'envelope' | 'template'; subject?: string; message?: string; fill?: Record<string, { name?: string; email?: string }>; extra?: Record<string, any> }): string {
  const eid = id(o.kind === 'template' ? 'tpl' : 'env');
  const t = now();
  tx(() => {
    run('INSERT INTO envelopes (id, account_id, sender_id, kind, subject, message, ordered, reminder_days, expire_days, date_format, template_id, powerform_id, bulk_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      eid, o.accountId, o.senderId, o.kind, str(o.subject ?? src.subject, 200), str(o.message ?? src.message, 5000), src.ordered, src.reminder_days, src.expire_days, src.date_format,
      src.kind === 'template' ? src.id : src.template_id, o.extra?.powerform_id ?? null, o.extra?.bulk_id ?? null, t, t);
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
    }
    for (const f of src.fields) {
      // Values entered by signers are never copied, only what the sender prefilled.
      // In a draft every value is the sender's. In an envelope that went out, a field a signer could change holds
      // the sender's own wording in prefill, and that is what the copy starts with.
      const keepValue = f.readonly || f.type === 'note' || src.status === 'draft';
      const value = ['signature', 'initials', 'attachment', ...AUTO_TYPES].includes(f.type) ? null : keepValue ? f.value : f.prefill;
      run('INSERT INTO fields (id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, label, value, options, group_name, validation, readonly, prefill) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id('fld'), eid, dmap.get(f.document_id), f.recipient_id ? rmap.get(f.recipient_id) : null, f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.label,
        value, JSON.stringify(f.options || []), f.group_name, f.validation, f.readonly, f.readonly || f.type === 'note' ? null : value);
    }
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
// daily limit on how many people can be newly emailed. They are checked in one place, emailRefusal(), by every path
// where a sender causes an email to a recipient, so a rule can never be walked around through a path that forgot it.

// The filter and the limit apply to accounts that have not paid: the free tier or a plan that is free through a code,
// with no payment on record that was kept, and not cleared by a person (trusted_at, set from the operator queue).
export function hasNotPaid(account: any): boolean {
  if (!account || account.trusted_at) return false;
  if (account.plan !== 'seedling' && !account.promo_code) return false;
  return !get('SELECT 1 x FROM payments WHERE account_id=? AND amount_cents > refunded_cents LIMIT 1', account.id);
}

// Said by every path that is refused while an account is paused, with the reason the pause was really given for.
export function pausedText(account: any): string {
  const why = String(account.suspended_reason || 'it is under review').replace(/[.\s]+$/, '');
  return `Sending is paused on this account. Reason: ${why}. Until a person has looked at it, nothing new goes out: no new envelopes, no new or changed recipients, no reminders and no reopening. People who already have a document can still open, sign and download it, and you can still open, download and export everything. If this is a mistake, use the contact form at ${baseUrl()}/help and a person will review it.`;
}

// Said wherever something is refused because the account is being closed. Nothing new starts in an account that is
// about to be deleted: what was sent, and whoever joined, would be deleted with it. `what` says what was refused.
export function closingText(account: { name: string; closing_at: string }, what: string): string {
  return `${account.name} is being closed and will be deleted on ${String(account.closing_at).slice(0, 10)}. ${what}. If its owner signs in before that day, the account is restored at once and this works again.`;
}

// Fake payment notices ("your PayPal order, call this number") are the classic way e-signature services get abused.
// Text is read the way the eye reads it: accents, full-width and styled letters are flattened (NFKD), characters
// that take no room are dropped, and letters from other alphabets that look like ours count as ours.
const ALIKE_FROM = 'АВЕКМНОРСТУХЅІЈаеорсухѕіјԁһΑΒΕΖΗΙΚΜΝΟΡΤΥΧαεικνορτυ';
const ALIKE_TO = 'ABEKMHOPCTYXSIJaeopcyxsijdhABEZHIKMNOPTYXaeikvoptu';
function plain(s: any): string {
  return String(s ?? '').normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(/[^\x00-\x7f]/g, (ch) => ALIKE_TO[ALIKE_FROM.indexOf(ch)] ?? ch)
    .replace(/(?<=[a-z])I+/g, (m) => 'l'.repeat(m.length)) // a capital I after a small letter reads as a small L: "PayPaI"
    .toLowerCase();
}
// A brand is found whatever stands between its letters ("Pay Pal", "P-a-y-p-a-l") and whichever look-alike digit or
// sign stands in for one ("PayPa1", "Micr0soft"), but not inside a longer word ("pineapple").
const BRANDS = ['PayPal', 'Norton', 'Geek Squad', 'McAfee', 'Microsoft', 'Apple', 'Amazon', 'Coinbase', 'Venmo', 'Zelle', 'Best Buy'];
const STAND_IN: Record<string, string> = { a: 'a@4', b: 'b8', e: 'e3', g: 'g9', i: 'i1!|', l: 'l1|', o: 'o0', s: 's5$', t: 't7', z: 'z2' };
const BRAND_RE: [string, RegExp][] = BRANDS.map((b) => [b, new RegExp(`(?<![a-z])${[...b.toLowerCase().replace(/[^a-z]/g, '')].map((ch) => `[${STAND_IN[ch] || ch}]`).join('[^a-z0-9]{0,3}')}(?![a-z])`)]);
const MONEY_RE = /\b(invoice|payment|refund|charged|renewal|order (confirmation|number)|transaction|subscription)\b/;
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/;
// Some brands are also everyday words or family names. "Apple Tree Nursery" and "Norton Smith" are not posing as
// anyone. "Apple Billing" and "Norton Support" are: nothing stands beside the brand but the words a company uses.
const EVERYDAY = new Set(['Norton', 'Apple', 'Amazon', 'Zelle']);
const COMPANY_WORDS = new Set(('the of from by at via and for no reply noreply inc llc ltd co corp corporation company official team support help helpdesk desk service services customer care center centre '
  + 'billing bill bills payment payments pay account accounts invoice invoices refund refunds order orders security secure protection antivirus lifelock verification alert alerts notice notification notifications '
  + 'department dept admin online store shop id com www prime web cloud music tv tech technical renewal renewals subscription subscriptions member membership receipt receipts statement purchase purchases '
  + 'transaction transactions dispute disputes fraud claims update updates confirmation info mail email us usa uk eu global international group').split(' '));
function posesAs(name: any): string | null {
  const text = plain(name);
  for (const [brand, re] of BRAND_RE) {
    const m = re.exec(text);
    if (!m) continue;
    if (!EVERYDAY.has(brand)) return brand;
    const beside = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`.split(/[^a-z]+/).filter(Boolean);
    if (beside.every((w) => COMPANY_WORDS.has(w))) return brand;
  }
  return null;
}
// The lure itself: money, a phone number to call and a well-known brand, anywhere in the texts that go out together.
function readsLikeLure(texts: any[]): boolean {
  const parts = texts.map(plain);
  const any = (re: RegExp) => parts.some((p) => re.test(p));
  return any(MONEY_RE) && any(PHONE_RE) && BRAND_RE.some(([, re]) => any(re));
}
// Reads everything a recipient will read: the subject, the message, each note to a recipient, the document names, and
// the names the email is sent under (the sender's and the account's, which is also the brand line). Returns what to
// tell the sender when it must not go out, or null.
function fakeNotice(e: any, account: any, sender: any): string | null {
  for (const name of [sender?.name, account?.name]) {
    const brand = posesAs(name);
    if (brand) return `The name "${name}" reads like ${brand}. Emails that seem to come from a well-known company are how people get tricked, so an account that has not paid cannot send under a name like that. Use your own name (Settings, Profile) and the name of your own organisation (Settings, Account). If you really do send for ${brand}, use the contact form at ${baseUrl()}/help and a person will clear your account.`;
  }
  if (readsLikeLure([e.subject, e.message, ...e.recipients.map((r: any) => r.note), ...e.documents.map((d: any) => d.name), sender?.name, account?.name]))
    return `This reads like a payment notice from a well-known brand with a phone number to call, which is how scams look. We do not send those from accounts that have not paid. If it is genuine, use the contact form at ${baseUrl()}/help and a person will clear your account.`;
  return null;
}

// Everyone an account newly emailed in the last 24 hours, with the time of the latest email to each of them.
function reachedToday(accountId: string): Map<string, string> {
  return new Map(all('SELECT lower(email) email, MAX(at) at FROM reached WHERE account_id=? AND at > ? GROUP BY lower(email)', accountId, new Date(Date.now() - 864e5).toISOString()).map((x) => [x.email, x.at]));
}
// The daily limit counts people, however they are reached: a first send, a person added or an address changed by a
// correction, a bulk row, a public form. Writing to someone again who was already reached today is never refused.
function overDailyLimit(account: any, emails: string[]): string | null {
  const firstWeek = Date.now() - Date.parse(account.created_at) < 7 * 864e5;
  const cap = firstWeek ? newAccountDailyRecipients() : unpaidDailyRecipients();
  const have = reachedToday(account.id);
  const fresh = new Set(emails.map((x) => String(x || '').trim().toLowerCase()).filter((x) => x && !have.has(x)));
  const over = have.size + fresh.size - cap;
  if (!fresh.size || over <= 0) return null;
  // Room comes back as the oldest of today's people pass the 24 hour mark.
  const times = [...have.values()].sort();
  const hours = over <= times.length ? Math.max(1, Math.ceil((Date.parse(times[over - 1]) + 864e5 - Date.now()) / 3600_000)) : 0;
  const when = hours ? `There is room for this again in about ${hours} hour${hours === 1 ? '' : 's'}, because the limit looks at the last 24 hours.` : 'That is more than the limit allows in one day, so send to fewer people at a time.';
  const lift = `${billingEnabled() ? 'To lift the limit, pay for anything on the Plan page (the monthly plan is the place to start), or use' : 'To lift the limit, use'} the contact form at ${baseUrl()}/help and a person can lift it for you.`;
  return `${firstWeek ? 'In its first week, an account that has not paid' : 'An account that has not paid'} can send to ${cap} people a day. This account has sent to ${have.size} in the last 24 hours and this would add ${fresh.size}. ${when} ${lift}`;
}
// One line for each person newly emailed, written in the same step as the send or the correction it belongs to.
function noteReached(e: any, emails: string[]) {
  const t = now();
  run('DELETE FROM reached WHERE account_id=? AND at < ?', e.account_id, new Date(Date.now() - 2 * 864e5).toISOString());
  for (const email of new Set(emails.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))) run('INSERT INTO reached (account_id, email, envelope_id, at) VALUES (?,?,?,?)', e.account_id, email, e.id, t);
}

// The one guard. `reach` is the addresses the action would email for the first time; leave it empty for an action
// that only writes to people who already have the document (a reminder, more time). `pause: false` is for a
// correction that changes no person: a paused sender may still fix a typo for people who already have the document.
export function emailRefusal(e: any, reach: string[] = [], o: { pause?: boolean } = {}): { status: number; message: string } | null {
  const account = get('SELECT * FROM accounts WHERE id=?', e.account_id);
  if (!account) return null;
  if (account.suspended_at && o.pause !== false) return { status: 403, message: pausedText(account) };
  if (!hasNotPaid(account)) return null;
  const fake = fakeNotice(e, account, senderOf(e));
  if (fake) return { status: 422, message: fake };
  const over = reach.length ? overDailyLimit(account, reach) : null;
  return over ? { status: 429, message: over } : null;
}
export function assertMayEmail(e: any, reach: string[] = [], o: { pause?: boolean } = {}) {
  const no = emailRefusal(e, reach, o);
  if (no) throw bad(no.message, no.status);
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
const senderOf = (e: any) => get('SELECT id, name, email, email_verified, notify FROM users WHERE id=?', e.sender_id);
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

export async function sendEnvelope(envelopeId: string, actor: Actor) {
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
  const reach = e.recipients.map((r: any) => r.email);
  assertMayEmail(e, reach);
  // A signature is held for every signer so nobody is stopped halfway. It is only used up when they actually sign,
  // and it comes back by itself if the envelope is voided, declined or expires.
  const before = creditsEnabled() ? available(account.id) : Infinity;
  const need = creditsEnabled() ? needed(e, sender.email) : 0;
  // Signing your own documents, approvals and copies cost nothing, so they go out whatever the balance is.
  if (need > 0 && need > before) throw bad(outOfSignatures(account, need, before), 402);

  const pages = e.documents.reduce((n: number, d: any) => n + d.pages, 0);
  const t = now();
  tx(() => {
    run("UPDATE envelopes SET status='sent', sent_at=?, updated_at=?, expires_at=?, sheets=?, subject=? WHERE id=?",
      t, t, new Date(Date.now() + e.expire_days * 864e5).toISOString(), sheetsSaved(pages, e.recipients.length),
      e.subject || `Please sign: ${e.documents[0].name}`, e.id);
    for (const r of e.recipients) {
      run('UPDATE recipients SET token=?, check_code=?, free=? WHERE id=?', token(), checkCode(), r.role === 'signer' && sameEmail(r.email, sender.email) ? 1 : 0, r.id);
      run('INSERT INTO contacts (id, account_id, name, email, created_at) VALUES (?,?,?,?,?) ON CONFLICT(account_id, email) DO NOTHING', id('con'), e.account_id, r.name, r.email, t);
    }
    noteReached(e, reach);
    audit(e.id, actor, 'Envelope sent', `${e.recipients.length} recipient${e.recipients.length === 1 ? '' : 's'}, ${pages} page${pages === 1 ? '' : 's'}`);
  });
  fireWebhooks(e.account_id, 'envelope.sent', e.id);
  await advance(e.id);
  // Running low never comes as a surprise: one email at two signatures left, one at none.
  if (creditsEnabled() && need > 0) {
    const after = before - need;
    for (const mark of [2, 0])
      if (before > mark && after <= mark) {
        // Goes to the people who can buy more (owners and admins) as well as to whoever sent, so a member using the
        // last signature never leaves the team stuck without anyone knowing.
        const buyers = all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", account.id).map((u) => u.email);
        const isBuyer = buyers.some((b) => sameEmail(b, sender.email));
        const more = account.promo_code ? `Your plan is free with the code ${account.promo_code}: ${PRICING.monthlySignatures} more arrive at the start of next month at no charge, and you can top up any time at $${PRICING.topUpUsd} a signature.`
          : account.plan === 'grove' && account.cancel_at ? `Your monthly plan is cancelled, so no more are added by it. Until it ends you can still top up at $${PRICING.topUpUsd} a signature, or keep the plan after all on the Plan page.`
          : account.plan === 'grove' ? `Your plan adds ${PRICING.monthlySignatures} more with each monthly payment, and you can top up any time at $${PRICING.topUpUsd} a signature.`
          : `The monthly plan is $${PRICING.monthlyUsd} for ${PRICING.monthlySignatures} signatures.`;
        for (const to of new Set([sender.email, ...buyers]))
          await sendMail({ to, subject: after <= 0 ? 'You have used all your signatures' : `${after} signature${after === 1 ? '' : 's'} left`,
            heading: after <= 0 ? 'That was your last signature' : `You have ${after} signature${after === 1 ? '' : 's'} left`,
            lines: [`${account.name} has ${Math.max(0, after)} signature${after === 1 ? '' : 's'} left to send${sameEmail(to, sender.email) ? '' : `, after ${sender.name} sent "${e.subject || e.documents[0].name}"`}. Envelopes already out are covered and can still be signed.`,
              more,
              ...(sameEmail(to, sender.email) && !isBuyer ? ['Only an owner or admin of your team can buy more. We have told them too.'] : []),
              `Nothing is ever charged without you choosing it. Every dollar plants ${PRICING.treesPerUsd} mangrove trees.`],
            ...(sameEmail(to, sender.email) && !isBuyer ? {} : { cta: { label: 'See your plan', url: `${baseUrl()}/app/settings?tab=billing` } }) });
        break;
      }
  }
}

type Notice = 'new' | 'reminder' | 'updated' | 'reopened' | 'expiring' | 'resent' | 'again';
const NOTICE_PREFIX: Record<Notice, string> = { new: '', reminder: 'Reminder: ', updated: 'Updated: ', reopened: 'Reopened: ', expiring: 'Expires soon: ', resent: '', again: 'Changed after you finished: ' };

// Answers false when nothing was written (someone who turned reminders off), and otherwise what became of the email:
// the mail server took it, there is no mail server, or the mail server would not take it yet.
async function notifyRecipient(e: any, r: any, kind: Notice = 'new'): Promise<false | MailStatus> {
  if (kind === 'reminder' && r.muted) return false;
  const sender = senderOf(e);
  // Someone who finished once and is asked again because the sender changed the document is told exactly that, by
  // whichever path their turn comes round.
  const before = String(r.signed_before || '').split('\n').filter(Boolean).pop();
  if (kind === 'new' && before && r.status !== 'completed') kind = 'again';
  const redo = ACTS(r.role) ? 'sign' : r.role === 'approver' ? 'approve' : 'confirm';
  const whatChanged = e.last_change ? [`What changed: ${e.last_change}`] : [];
  const verb = r.role === 'cc' ? 'sent you a copy of' : r.role === 'viewer' ? 'sent you a document to view:' : r.role === 'approver' ? 'asked you to approve' : 'sent you a document to sign:';
  const to = r.role === 'inperson' ? sender.email : r.email;
  const deadline = e.expires_at && r.role !== 'cc' ? e.expires_at.slice(0, 10) : '';
  const shared = (e.recipients || []).some((x: any) => x.id !== r.id && x.email.toLowerCase() === r.email.toLowerCase());
  return sendMail({
    to,
    subject: `${NOTICE_PREFIX[kind]}${e.subject}`,
    heading: r.role === 'inperson' ? `Host an in-person signing for ${r.name}` : kind === 'again' ? `${shared ? `For ${r.name}: ` : ''}${sender.name} changed this document after you ${finishedHow(r)} it` : `${shared ? `For ${r.name}: ` : ''}${sender.name} ${verb} ${e.subject}`,
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
      ...(r.role === 'inperson' ? [`Open the document on your device and hand it to ${r.name} to sign in person.`] : []),
      ...(e.message ? [`${sender.name} wrote:\n${e.message}`] : []),
      ...(r.note ? [`Note for you: ${r.note}`] : []),
      ...(r.access_code ? [`You will need an access code to open it. ${sender.name} will give it to you separately. It is not in this email.`] : []),
      `Sent by ${sender.name} (${sender.email}). Reply to this email to reach them directly.`,
    ],
    cta: { label: r.role === 'cc' ? 'View document' : r.role === 'viewer' ? 'View document' : `${r.role === 'approver' ? 'Review and approve' : 'Review and sign'}${kind === 'again' ? ' again' : ''}`, url: signUrl(r) },
    envelopeId: e.id,
    recipientId: r.id,
    brand: brandOf(e.account_id),
    replyTo: sender.email,
    fromName: sender.name,
    code: r.check_code,
    footnote: [deadline && kind !== 'expiring' ? `This request closes on ${deadline}.` : '', kind === 'reminder' ? `Too many reminders? Stop them for this document: ${signUrl(r)}?mute=1` : ''].filter(Boolean).join(' ') || undefined,
  });
}

// What became of an email to someone on an envelope belongs in that envelope's record. The first failed try is
// written down as exactly that, a later try that goes through as "Email sent", and the last failed try as final.
// Then the sender is told (their "when something needs you" setting), because only they can reach the person
// another way. Emails to the sender themselves are tried again like any other, without a line here.
onMailOutcome('envelope', async (m, what) => {
  const e = m.envelope_id && get('SELECT id, subject, account_id, sender_id FROM envelopes WHERE id=?', m.envelope_id);
  if (!e || sameEmail(m.to_email, senderOf(e)?.email)) return;
  const r = m.recipient_id ? get('SELECT name FROM recipients WHERE id=?', m.recipient_id) : null;
  const which = `"${str(m.subject, 200)}" to ${r?.name ? `${r.name} <${m.to_email}>` : m.to_email}`;
  const said = m.error ? ` What went wrong: ${str(m.error, 300).replace(/[.\s]+$/, '')}.` : '';
  const tries = m.tries > 1 ? ` after ${m.tries} tries` : '';
  if (what === 'delayed') audit(e.id, { name: 'System' }, 'Email could not be sent yet', `${which}.${said} It is tried again automatically.`);
  if (what === 'sent') audit(e.id, { name: 'System' }, 'Email sent', `${which}, on try ${m.tries}.`);
  if (what !== 'gave_up') return;
  audit(e.id, { name: 'System' }, 'Email could not be sent', `${which}${tries}.${said} No more tries are made.`);
  await notifySender(e, 'problems', `Email not delivered: ${e.subject}`, `We could not email ${r?.name || m.to_email}`,
    [`The email "${m.subject}" to ${m.to_email} could not be handed to the mail server${tries}, so we have stopped trying.${said}`,
      'Check the address: open the envelope and choose Correct next to their name, and a new email goes out at once. Or copy their signing link from the same page and send it to them yourself.']);
});

// Moves the envelope forward: activates whoever is next and completes it when everyone is done.
export async function advance(envelopeId: string): Promise<void> {
  for (let guard = 0; guard < 200; guard++) {
    const e = loadEnvelope(envelopeId);
    if (!e || e.status !== 'sent') return;
    const open = e.recipients.filter((r: any) => r.status !== 'completed');
    if (!open.length) return completeEnvelope(e);
    const turn = e.ordered ? Math.min(...open.map((r: any) => r.routing_order)) : null;
    const next = open.filter((r: any) => r.status === 'pending' && (turn === null || r.routing_order === turn));
    if (!next.length) return; // waiting on people who already have it
    let copied = false;
    for (const r of next) {
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
      else if (how === 'outbox') audit(e.id, { name: 'System' }, 'Not emailed', `${r.name} <${r.email}>. No mail server is set up, so no email went out. The request is open, and the sender can pass on the signing link.`);
      else if (how !== 'failed') audit(e.id, { name: 'System' }, r.role === 'cc' ? 'Copy sent' : 'Sent to recipient', `${r.name} <${r.email}>`);
    }
    if (!copied) return;
  }
}

// `viewer` is the recipient a copy is made for while others are still signing. They get what their screen shows.
export async function buildPdf(e: any, certificate: boolean, viewer?: string, notice?: { title: string; lines: string[] }): Promise<Uint8Array> {
  return renderEnvelopePdf(e, auditTrail(e.id), { certificate, sender: senderOf(e), viewer, notice });
}

// Someone who signed keeps the right to a copy of what they signed, also when the envelope was later voided,
// declined or ran out of time. That copy must never pass for a finished agreement, so it opens with this: that it
// was not completed by everyone, why, and what the copy shows. Used by the signer's download (routes-sign.ts).
export function notCompletedNotice(e: any, r: any): { title: string; lines: string[] } {
  const sender = senderOf(e);
  const closed = auditTrail(e.id).filter((a: any) => ['Envelope voided', 'Declined', 'Envelope expired'].includes(a.action)).pop();
  const on = closed ? ` on ${ts(closed.at)}` : '';
  const who = e.recipients.find((x: any) => x.status === 'declined');
  const why = e.status === 'voided' ? `${sender?.name || 'The sender'} cancelled (voided) it${on}${e.void_reason ? `, giving this reason: ${e.void_reason}` : ''}.`
    : e.status === 'declined' ? `${who?.name || 'One of the people asked to sign'} declined to sign${on}, which closed it for everyone.`
    : `The deadline passed${on} before everyone had finished.`;
  return {
    title: 'Not completed by everyone',
    lines: [
      `"${e.subject}" was not completed by everyone, so this is not a finished agreement. ${why}`,
      `This copy is for ${r.name}. It shows the document as it stood when it was closed: what ${r.name} ${finishedHow(r)} on ${ts(r.completed_at)}, and what others who had finished by then had filled in. It has no certificate of completion.`,
      `Questions go to ${sender ? `${sender.name} <${sender.email}>` : 'the sender'}. Envelope ${e.id}.`,
    ],
  };
}

async function completeEnvelope(e: any) {
  const t = now();
  run("UPDATE envelopes SET status='completed', completed_at=?, updated_at=? WHERE id=? AND status='sent'", t, t, e.id);
  audit(e.id, { name: 'System' }, 'Envelope completed', 'All recipients have finished');
  const fresh = loadEnvelope(e.id);
  const pdf = await buildPdf(fresh, true);
  const sha = saveBlob(pdf);
  run('UPDATE envelopes SET final_sha256=?, final_size=? WHERE id=?', sha, pdf.length, e.id);
  fireWebhooks(e.account_id, 'envelope.completed', e.id);

  const i = impactOf(fresh.sheets);
  const lines = [
    'Everyone has finished. The signed document and its certificate of completion are ready.',
    `Because this was signed digitally, about ${fmtNum(i.sheets)} sheets of paper and ${fmtNum(i.litresWater)} litres of water were not used.`,
  ];
  const attachments = pdf.length < 8_000_000 ? [{ filename: `${(fresh.subject || 'signed').replace(/[^\w .-]+/g, '_').slice(0, 80)}.pdf`, content: Buffer.from(pdf) }] : undefined;
  const brand = brandOf(e.account_id);
  const sender = senderOf(e);
  const sent = new Set<string>();
  // Everyone on the envelope gets their own email with their own link, also two people who share one address:
  // each of theirs says whose it is, like the request did, so neither is left with the other person's link.
  for (const r of fresh.recipients) {
    const to = r.email.toLowerCase();
    if (!to) continue;
    sent.add(to);
    const shared = fresh.recipients.some((x: any) => x.id !== r.id && sameEmail(x.email, r.email));
    await sendMail({ to: r.email, recipientId: r.id, subject: `Completed: ${fresh.subject}`, heading: `${shared ? `For ${r.name}: ` : ''}Your document is complete`, lines: [...(shared ? [`More than one person on this document uses this email address. This link is for ${r.name} only.`] : []), ...lines, `Keep this email. The link below keeps working for as long as ${sender?.name || 'the sender'} keeps their Sign&Grow account, and the PDF is attached when it is small enough to send. Lost it later? Any time, ${baseUrl()}/help can send your documents to this address again.`], cta: { label: 'View completed document', url: signUrl(r) }, envelopeId: e.id, brand, attachments, replyTo: sender?.email, fromName: sender?.name, code: r.check_code });
  }
  if (sender && !sent.has(sender.email.toLowerCase()) && notifyPrefs(sender).completed)
    await sendMail({ to: sender.email, subject: `Completed: ${fresh.subject}`, heading: 'Your document is complete', lines, cta: { label: 'Open envelope', url: `${baseUrl()}/app/envelopes/${e.id}` }, envelopeId: e.id, brand, attachments });
}

export function finalPdf(e: any): Buffer | null {
  return e.final_sha256 ? readBlob(e.final_sha256) : null;
}

// Emails the sender about their own envelope, if they asked for that kind of news. 'always' is for things that need them to act.
async function notifySender(e: any, key: NotifyKey | 'always', subject: string, heading: string, lines: string[], cta?: { label: string; url: string }) {
  const sender = senderOf(e);
  if (!sender || (key !== 'always' && !notifyPrefs(sender)[key])) return;
  await sendMail({ to: sender.email, subject, heading, lines, cta: cta || { label: 'Open envelope', url: `${baseUrl()}/app/envelopes/${e.id}` }, envelopeId: e.id, brand: brandOf(e.account_id) });
}

async function notifyActive(e: any, subject: string, heading: string, lines: string[]) {
  const sender = senderOf(e);
  for (const r of e.recipients)
    if (r.status !== 'pending' && r.role !== 'inperson')
      await sendMail({ to: r.email, subject, heading, lines, envelopeId: e.id, brand: brandOf(e.account_id), replyTo: sender?.email, fromName: sender?.name });
}

export async function voidEnvelope(e: any, reason: string, actor: Actor) {
  if (e.status !== 'sent') throw bad('Only envelopes that are out for signature can be voided.');
  if (!reason.trim()) throw bad('Give a reason for voiding. Recipients will see it.');
  // Voiding is never refused, also not while paused. But the reason is emailed to everyone who has the document, so
  // it is read like any other words a sender writes to recipients, or it would be one more way to deliver a lure.
  if (readsLikeLure([reason]) && hasNotPaid(get('SELECT * FROM accounts WHERE id=?', e.account_id)))
    throw bad('That reason reads like a payment notice from a well-known brand with a phone number to call, and it would be emailed to everyone on this envelope. Give a plain reason and the envelope is voided.', 422);
  run("UPDATE envelopes SET status='voided', void_reason=?, updated_at=? WHERE id=?", str(reason, 500), now(), e.id);
  audit(e.id, actor, 'Envelope voided', str(reason, 500));
  fireWebhooks(e.account_id, 'envelope.voided', e.id);
  await notifyActive(e, `Voided: ${e.subject}`, 'This document was voided by the sender', [`Reason: ${reason}`, 'There is nothing more for you to do.']);
}

// Reminders only ever go to people whose turn it is and who have not finished. Pass a recipient to nudge just them.
// A recipient who asked for no more reminders is never reminded; the sender sees that and can reach them another way.
export async function remindEnvelope(e: any, actor: Actor, recipientId?: string): Promise<number> {
  if (e.status !== 'sent') throw bad('Reminders only go out while an envelope is waiting for signatures.');
  // A reminder is an email in the sender's name like any other: none while paused, and none for a fake notice.
  assertMayEmail(e);
  const waiting = e.recipients.filter((r: any) => (r.status === 'sent' || r.status === 'viewed') && (!recipientId || r.id === recipientId));
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

// When a signer's address changes to a different person, is the new person's signature free (the sender signing
// their own document) or paid for? Sending to yourself is free, so pointing that request at somebody else afterwards
// has to need a signature like any other, or it would be a way round paying. Returns the new value of `free`.
function takeOverCost(e: any, r: any, newEmail: string): number {
  const senderEmail = senderOf(e)?.email || '';
  const free = sameEmail(newEmail, senderEmail) ? 1 : 0;
  if (creditsEnabled() && ACTS(r.role) && !isChargeable(r, senderEmail) && !free) {
    const have = available(e.account_id);
    if (have < 1) throw bad(outOfSignatures(get('SELECT * FROM accounts WHERE id=?', e.account_id), 1, have), 402);
  }
  return free;
}

// Fix a recipient's name or email while the envelope is out. Old links stop working.
export async function correctRecipient(e: any, recipientId: string, patch: { name?: string; email?: string; access_code?: string }, actor: Actor) {
  if (e.status !== 'sent') throw bad('Only envelopes that are out for signature can be corrected.');
  const r = e.recipients.find((x: any) => x.id === recipientId);
  if (!r) throw bad('Recipient not found.', 404);
  if (r.status === 'completed') throw bad(`${r.name} has already finished and cannot be changed.`);
  const name = str(patch.name ?? r.name, 120).trim();
  const email = str(patch.email ?? r.email, 254).trim();
  if (!name || !isEmail(email)) throw bad('Enter a name and a valid email address.');
  const code = patch.access_code === undefined ? r.access_code : str(patch.access_code, 50).trim() || null;
  // A code that is set or changed must be long enough. A new code starts clean: wrong tries at the old one are
  // forgotten and a frozen code opens again, which is how the sender lets a signer back in.
  const newCode = (code || '') !== (r.access_code || '');
  if (newCode) assertCodes([{ name, access_code: code }]);
  const fresh = 'code_fails=0, code_frozen_at=NULL';
  if (email.toLowerCase() === r.email.toLowerCase()) {
    // Same person, same inbox: fixing a name or an access code never breaks the link they already have.
    run(`UPDATE recipients SET name=?, access_code=?${newCode ? `, ${fresh}` : ''} WHERE id=?`, name, code, r.id);
    audit(e.id, actor, 'Recipient corrected', `${r.name} is now ${name}${code !== r.access_code ? ', access code changed' : ''}`);
    return;
  }
  // A new address is a new person being emailed in the sender's name: not while paused, read by the fake-notice
  // filter, and counted towards the daily limit like a first send.
  assertMayEmail(e, [email]);
  const free = takeOverCost(e, r, email);
  retireToken(r, 'address');
  // A different address is a different person: nothing the first one typed, ticked, uploaded or drew goes with the
  // request, and the wait before "not opened yet" is counted from the email that goes to the new address now.
  clearAnswers(r.id);
  run(`UPDATE recipients SET name=?, email=?, access_code=?, token=?, check_code=?, viewed_at=NULL, consent_at=NULL, muted=0, unopened_alerted_at=NULL, dead_link_alerted_at=NULL, sent_at=?, status=?, free=?, ${fresh} WHERE id=?`,
    name, email, code, token(), checkCode(), r.status === 'pending' ? r.sent_at : now(), r.status === 'pending' ? 'pending' : 'sent', free, r.id);
  noteReached(e, [email]);
  audit(e.id, actor, 'Recipient corrected', `${r.name} <${r.email}> is now ${name} <${email}>. The link sent to ${r.email} stopped working, and anything filled in through it was cleared.`);
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

const VALIDATORS: Record<string, RegExp> = { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, number: /^-?\d+([.,]\d+)?$/, phone: /^[+()\d][\d\s().-]{5,}$/ };

export function applyValues(e: any, r: any, values: Record<string, any>, strict: boolean) {
  const mine = e.fields.filter((f: any) => f.recipient_id === r.id && !f.readonly && !AUTO_TYPES.includes(f.type));
  for (const f of mine) {
    if (!(f.id in values)) continue;
    let v = str(values[f.id], 4000);
    if (f.type === 'checkbox' || f.type === 'radio' || f.type === 'signature' || f.type === 'initials') v = v ? '1' : '';
    if (f.type === 'dropdown' && v && !(f.options || []).includes(v)) v = '';
    if (f.type === 'attachment' && v && !get('SELECT id FROM files WHERE id=? AND account_id IS NULL', v)) v = '';
    f.value = v;
    run('UPDATE fields SET value=? WHERE id=?', v || null, f.id);
  }
  if (!strict) return;
  const groups = new Map<string, { ok: boolean; required: boolean }>();
  for (const f of mine) {
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
      if (re && !re.test(f.value)) throw bad(`"${f.value}" is not valid for ${label}.`);
    }
  }
  for (const [name, gr] of groups) if (gr.required && !gr.ok) throw bad(`Choose an option for ${name}.`);
}

export const okImage = (s: any) => typeof s === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < 700_000;

// Which content version a signer is acting on: the one their screen sent, or else the one the server last gave them.
export const shownVersion = (r: any, body: any): number | null => (body?.version != null && body.version !== '' ? Number(body.version) : r.seen_version ?? null);
// Said to a signer whose screen shows the document as it was before the sender's latest correction.
export const changedSince = (e: any) => bad('The sender changed this document while you had it open. Look at it again before you finish.', 409, { code: 'changed', version: get('SELECT content_version v FROM envelopes WHERE id=?', e.id)?.v });

export async function completeRecipient(e: any, r: any, body: any, actor: Actor) {
  // A second Finish (a double tap, a retry) is a conflict with the first, not a mistake in the request: 409. Asked
  // before anything else, because the first Finish may have completed the whole envelope by now.
  if (r.status === 'completed') throw bad('You have already finished this document.', 409);
  if (e.status !== 'sent') throw bad('This envelope is no longer open for signing.');
  if (r.status !== 'sent' && r.status !== 'viewed') throw bad('It is not your turn to sign yet.');
  if (!r.consent_at) throw bad('Please agree to use electronic records and signatures first.');
  // What is on this person's screen must be what is on the envelope now. The signing screen sends the content
  // version it was given. A caller that sends none is held to the version the server last showed them. If the
  // sender has changed the document since, nothing is signed: the person is told, looks again and finishes then.
  const shown = shownVersion(r, body);
  if (shown != null && shown !== e.content_version) throw changedSince(e);
  let verb = 'Viewed';
  if (ACTS(r.role)) {
    const mine = e.fields.filter((f: any) => f.recipient_id === r.id);
    const needsSig = mine.some((f: any) => f.type === 'signature' && (f.required || body.values?.[f.id]));
    const needsIni = mine.some((f: any) => f.type === 'initials' && (f.required || body.values?.[f.id]));
    if (needsSig && !okImage(body.signature_png)) throw bad('Adopt a signature before finishing.');
    if (needsIni && !okImage(body.initials_png)) throw bad('Adopt your initials before finishing.');
    verb = 'Signed';
  } else if (r.role === 'approver') verb = 'Approved';
  const t = now();
  // Finishing is claimed by one statement that only changes a row while this recipient and the envelope are both
  // still open. e and r were read before this and may be out of date: a second Finish, a decline or a void can have
  // got in since. Whoever comes second changes no row and stops here with nothing written: no values, no audit
  // line, no webhook, no signature used, no email. Nothing is waited for between the claim and the values it
  // guards, and a value that fails its check undoes the claim with the rest.
  tx(() => {
    // The same statement refuses a Finish when the content version has moved on from the one this person was shown
    // (or, for a caller we never showed one, from the one read a moment ago), so a correction that lands between
    // the look and the claim cannot be signed unseen either.
    const claimed = run("UPDATE recipients SET status='completed', completed_at=?, viewed_at=COALESCE(viewed_at, ?), ip=?, user_agent=? WHERE id=? AND status IN ('sent','viewed') AND (SELECT status FROM envelopes WHERE id=recipients.envelope_id)='sent' AND (SELECT content_version FROM envelopes WHERE id=recipients.envelope_id)=?",
      t, t, actor.ip || null, (actor.ua || '').slice(0, 300), r.id, shown ?? e.content_version).changes;
    if (!claimed) {
      const cur = get('SELECT r.status, e.status env FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE r.id=?', r.id);
      if (cur?.env === 'sent' && (cur.status === 'sent' || cur.status === 'viewed')) throw changedSince(e);
      throw bad(cur?.status === 'completed' ? 'You have already finished this document.' : 'This envelope is no longer open for signing.', 409);
    }
    if (!ACTS(r.role)) return;
    applyValues(e, r, body.values || {}, true);
    run('UPDATE recipients SET signature_png=?, initials_png=? WHERE id=?', okImage(body.signature_png) ? body.signature_png : null, okImage(body.initials_png) ? body.initials_png : null, r.id);
  });
  // Someone signing for the second time, after the sender changed the document, is recorded as exactly that.
  audit(e.id, actor, r.signed_before ? `${verb} again` : verb, `${r.name} <${r.email}>`);
  fireWebhooks(e.account_id, 'recipient.completed', e.id, { recipient_id: r.id });
  if (creditsEnabled() && isChargeable(r, senderOf(e)?.email || '')) grant(e.account_id, -1, 'signature', r.id);
  const left = e.recipients.filter((x: any) => x.id !== r.id && x.status !== 'completed' && x.role !== 'cc');
  if (left.length) await notifySender(e, 'signed', `${verb}: ${e.subject}`, `${r.name} has ${verb.toLowerCase()} your document`, [`Still waiting on ${left.map((x: any) => x.name).join(', ')}.`]);
  await advance(e.id);
}

export async function declineRecipient(e: any, r: any, reason: string, actor: Actor) {
  // A second Decline (a double tap, a retry) is a conflict with the first: 409, like a second Finish.
  if (r.status === 'declined') throw bad('This envelope is no longer open for signing.', 409);
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw bad('This envelope is no longer open for signing.');
  if (r.role === 'cc' || r.role === 'viewer') throw bad('Only signers and approvers can decline.');
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
  await notifyActive({ ...e, recipients: e.recipients.filter((x: any) => x.id !== r.id) }, `Declined: ${e.subject}`, 'This document was declined', [`${r.name} declined to sign, so the envelope is closed.`]);
}

export async function reassignRecipient(e: any, r: any, to: { name: string; email: string; reason?: string }, actor: Actor) {
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw bad('This envelope is no longer open for signing.');
  if (r.role !== 'signer' && r.role !== 'approver') throw bad('This role cannot be assigned to someone else.');
  const name = str(to.name, 120).trim();
  const email = str(to.email, 254).trim();
  if (!name || !isEmail(email)) throw bad('Enter the name and email of the person who should sign instead.');
  // Passing a request on emails a new person in the sender's name, so the sender's pause and daily limit hold here
  // too (or a sender could send to themselves and pass each one on). The signer is not told the sender's business.
  if (emailRefusal(e, [email])) throw bad(`This document cannot be passed on to someone else right now. Reply to the email you got and ask ${senderOf(e)?.name || 'the sender'} to send it to the right person.`, 403);
  const free = takeOverCost(e, r, email);
  retireToken(r, 'handed');
  // The new person starts with empty fields: nothing the first one typed, ticked, uploaded or drew is passed on.
  // The wait before the sender hears "not opened yet" starts again with the email that goes out now.
  if (!sameEmail(r.email, email)) clearAnswers(r.id);
  run("UPDATE recipients SET name=?, email=?, token=?, check_code=?, status='sent', sent_at=?, viewed_at=NULL, consent_at=NULL, access_code=NULL, muted=0, unopened_alerted_at=NULL, dead_link_alerted_at=NULL, reassigned_from=?, free=? WHERE id=?",
    name, email, token(), checkCode(), now(), `${r.name} <${r.email}>`, free, r.id);
  noteReached(e, [email]);
  audit(e.id, actor, 'Reassigned', `${r.name} <${r.email}> assigned this to ${name} <${email}>${to.reason ? `: ${str(to.reason, 300)}` : ''}`);
  await notifyRecipient(loadEnvelope(e.id), get('SELECT * FROM recipients WHERE id=?', r.id));
  // The signing screen promises "the sender is told", and who signs is the sender's business whatever their email
  // settings are. So this one is always sent.
  await notifySender(e, 'always', `Reassigned: ${e.subject}`, `${r.name} assigned signing to ${name}`, [`${name} <${email}> will sign instead.`, ...(to.reason ? [`Reason: ${to.reason}`] : [])]);
}

// ---- Deadlines, lost links, reminders, reports -------------------------------------------------

// Push the deadline out, or reopen an envelope that already expired. No need to start again.
export async function extendEnvelope(e: any, days: any, actor: Actor) {
  if (e.kind !== 'envelope' || (e.status !== 'sent' && e.status !== 'expired')) throw bad('Only envelopes that are waiting for signatures, or that expired, can be given more time.');
  // Reopening emails everyone who is waiting, and more time leads to new warnings: neither while paused.
  assertMayEmail(e);
  const add = int(days, 1, 365, 30);
  const reopened = e.status === 'expired';
  if (reopened && creditsEnabled()) {
    // Signatures came back when it expired. Reopening holds them again for whoever still has to sign.
    const need = needed(e, senderOf(e)?.email || '');
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
  audit(e.id, actor, reopened ? 'Envelope reopened' : 'Deadline extended', `New deadline ${expires.slice(0, 10)}`);
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
  audit(e.id, actor, 'More time requested', `${r.name} asked for the deadline to be extended`);
  await notifySender(e, 'always', `More time needed: ${e.subject}`, `${r.name} asked for more time to sign`,
    [e.status === 'expired' ? 'The deadline has passed. You can reopen the envelope and nobody has to start again.' : `The deadline is ${String(e.expires_at).slice(0, 10)}. You can push it back.`],
    { label: 'Give more time', url: `${baseUrl()}/app/envelopes/${e.id}?extend=1` });
}

// Someone opened a link that was replaced (after a correction or reassignment) and asked for the current one. It
// goes to whoever holds the document now, never to the page that asked. The answer says what really happened, so
// the page never says "sent" when nothing was: 'sent', 'delayed' (the mail server would not take it yet, and it is
// tried again), 'waiting' (it is not that person's turn, and they are emailed when it is), 'removed' (the person
// this link was for is no longer on the document), 'closed' (the document is no longer open for signing) or
// 'unknown' (not a link of ours). A replaced link is as unguessable as a live one, so only someone who was sent it
// can ask, and none of these answers tells them more than their own emails did.
export type ResendAnswer = 'sent' | 'delayed' | 'waiting' | 'removed' | 'closed' | 'unknown';
export async function resendFromRetired(oldToken: string): Promise<ResendAnswer> {
  const row = get('SELECT recipient_id FROM retired_tokens WHERE token=?', oldToken);
  if (!row) return 'unknown';
  const r = get('SELECT * FROM recipients WHERE id=?', row.recipient_id);
  const e = r && loadEnvelope(r.envelope_id);
  if (!e) return 'removed';
  if ((e.status !== 'sent' && e.status !== 'completed') || r.status === 'declined') return 'closed';
  if (!r.token || r.status === 'pending') return 'waiting';
  return (await notifyRecipient(e, e.recipients.find((x: any) => x.id === r.id) || r, 'resent')) === 'failed' ? 'delayed' : 'sent';
}

/** How many documents fit in one "Here are your documents" email. */
export const LINKS_PER_EMAIL = 50;
// Where the list stopped for an address that has more documents than fit in one email. Asking again within a day
// carries on from there, so every document can be reached. Kept in memory: after a restart the list starts at the top.
const linksFrom: Map<string, { skip: number; until: number }> = ((globalThis as any).__tslinks ??= new Map());

// "I cannot find the email": send every document that is waiting for this address, every one its people have
// signed (also while others have not finished, and also when it was later cancelled, declined or ran out of
// time), and every completed one, to the address that asks for it. Only that inbox receives the links, so asking
// proves nothing and leaks nothing.
export async function emailMyLinks(email: string): Promise<number> {
  const where = `r.email=? AND r.role!='inperson' AND r.token IS NOT NULL AND e.kind='envelope'
        AND ((e.status='sent' AND r.status IN ('sent','viewed','completed')) OR e.status='completed'
          OR (e.status IN ('voided','declined','expired') AND r.status='completed' AND r.role!='cc'))`;
  const total = get(`SELECT COUNT(*) n FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE ${where}`, email).n;
  if (!total) return 0;
  const key = email.toLowerCase();
  const at = linksFrom.get(key);
  const skip = at && at.until > Date.now() && at.skip < total ? at.skip : 0;
  const rows = all(
    `SELECT r.token, r.name, r.status my_status, r.role, e.subject, e.status, u.name sender FROM recipients r
       JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id
      WHERE ${where} ORDER BY e.updated_at DESC, r.position LIMIT ? OFFSET ?`, email, LINKS_PER_EMAIL, skip);
  const more = total - skip - rows.length;
  if (more > 0) linksFrom.set(key, { skip: skip + rows.length, until: Date.now() + 864e5 });
  else linksFrom.delete(key);
  // When more than one person uses this address (a couple, a shared office inbox), every line says whose link it is.
  const names = new Set(all(`SELECT DISTINCT lower(r.name) n FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE ${where}`, email).map((x) => x.n));
  const state = (x: any) => (x.status === 'completed' ? 'completed'
    : x.status !== 'sent' ? `you ${finishedHow(x)} it, and it was not completed by everyone`
    : x.my_status !== 'completed' ? 'waiting for you' : x.role === 'cc' ? 'your copy' : `you ${finishedHow(x)} it, others have not finished yet`);
  const part = total > LINKS_PER_EMAIL ? ` These are numbers ${skip + 1} to ${skip + rows.length} of ${total}, newest first.` : '';
  await sendMail({
    to: email, subject: 'Your documents on Sign&Grow', heading: 'Here are your documents',
    lines: [`You asked us to find your documents. These are the ones sent to this email address.${part}`,
      ...(names.size > 1 ? ['More than one person uses this address. Each link is for the person named under it, and only for them.'] : []),
      ...(more > 0 ? [`${more} more did not fit in this email. To get them, ask again within a day: enter this address under "Find my documents" at ${baseUrl()}/help once more, and the next email carries on where this one stops.`] : []),
      ...(skip > 0 && more <= 0 ? ['That was the last of them. Asking again starts at the newest.'] : [])],
    links: rows.map((x) => ({ label: x.subject, url: `${baseUrl()}/sign/${x.token}`, note: `${names.size > 1 ? `for ${x.name} · ` : ''}from ${x.sender} · ${state(x)}` })),
    footnote: 'If you did not ask for this, you can ignore it. Nobody else received these links.',
  });
  return rows.length;
}

// Names are compared the way a person reads them: case, accents and stray spaces make no difference.
const nameWords = (s: any): string[] => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// The same word, or the same word with one letter added, dropped, changed or swapped with its neighbour: "Jon" and
// "John", "Smyth" and "Smith". That is what a spelling fix looks like, so it counts as a word in common.
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 3 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rest = (x: number, y: number) => a.slice(i + x) === b.slice(i + y);
  return rest(1, 1) || rest(1, 0) || rest(0, 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(2, 2));
}

// A signer can fix the spelling of their own name. It is logged and the sender is always told, whatever their email
// settings, so a name never changes quietly. "Fixing" a name into somebody else's is not a spelling fix: a name
// that is another recipient's on this envelope, that takes a word from another recipient's name, or that has no
// word in common with the name the sender wrote, is not applied. It goes to the sender as a question, the signer is
// told so, and the name on the document stays as it was. Returns whether the name was changed, and what to say.
export async function renameSelf(e: any, r: any, newName: string, actor: Actor): Promise<{ applied: boolean; name: string; message: string }> {
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw bad('This envelope is no longer open for signing.');
  const name = str(newName, 120).trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw bad('Type your name as it should appear.');
  if (name === r.name) return { applied: true, name, message: '' };
  const sender = senderOf(e);
  // What the sender wrote for this person. An earlier fix of the signer's own does not count as the sender's word.
  const written = r.self_name && r.self_name === r.name && r.sender_name ? r.sender_name : r.name;
  const mine = nameWords(written);
  const words = nameWords(name);
  const others = e.recipients.filter((x: any) => x.id !== r.id);
  const taken = others.find((x: any) => nameWords(x.name).join(' ') === words.join(' ') || nameWords(x.name).some((w) => w.length > 1 && !mine.includes(w) && words.includes(w)));
  if (taken || !words.some((w) => mine.some((m) => sameWord(w, m)))) {
    audit(e.id, actor, 'Name change asked for', `The signer at ${r.email} asked for the name "${r.name}" to be written as "${name}". ${taken ? `That is, or borrows from, the name of ${taken.name}, who is also on this envelope` : `That has no word in common with "${written}", the name the sender wrote`}, so it was not changed and the sender was asked.`);
    await notifySender(e, 'always', `Name change asked for: ${e.subject}`, `${r.name} asked to be named ${name}`,
      [`Someone using the signing link of ${r.name} <${r.email}> asked for the name on the document to be "${name}". ${taken ? `That is, or borrows from, the name of ${taken.name}, who is also on this envelope` : `That is a different name, not another spelling of "${written}"`}, so we did not change it.`,
        `If "${name}" is right, open the envelope, choose Correct next to ${r.name} and type the name yourself. Their link keeps working. If two people share ${r.email}, check that each of them is using the link from the email that carries their own name. If you do nothing, the name stays "${r.name}".`]);
    return { applied: false, name: r.name, message: `We did not change it. "${name}" ${taken ? 'is the name of someone else on this document' : `is a different name from "${r.name}", not another spelling of it`}, so we asked ${sender?.name || 'the sender'} instead, and only they can change it. If you are not ${r.name}, this link is not yours: look for the email with your own name on it, or ask ${sender?.name || 'the sender'}${sender?.email ? ` (${sender.email})` : ''}.` };
  }
  run('UPDATE recipients SET name=?, sender_name=?, self_name=? WHERE id=?', name, written, name, r.id);
  audit(e.id, actor, 'Signer corrected their name', `"${r.name}" is now "${name}"`);
  await notifySender(e, 'always', `Name corrected: ${e.subject}`, `${r.name} corrected their name to ${name}`, [`The signer at ${r.email} changed how their name is written, from "${r.name}" to "${name}". It is recorded in the audit trail. If this is not who you expected, void the envelope.`]);
  return { applied: true, name, message: '' };
}

// Somebody tried to open a link that no longer works (the deadline passed), so the sender can help before being
// asked. Told once for each recipient until the sender does something about it: more time, reopening or sending
// again clears the mark (see extendEnvelope, remindEnvelope and the corrections), and the next time is news again.
export async function noteDeadLink(e: any, r: any, why: string) {
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
  if (!r.access_code || e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw bad('This document is not waiting for an access code.');
  audit(e.id, actor, 'Access code requested', `${r.name} asked the sender for the access code`);
  await notifySender(e, 'always', `Access code needed: ${e.subject}`, `${r.name} cannot open your document`,
    r.code_frozen_at ? [`Their access code was entered wrongly ${ACCESS_CODE_TRIES} times and is frozen, and they asked you for a new one.`, newCodeHow(r)]
      : [`They asked for the access code. It is ${r.access_code}. Give it to them yourself, by phone or message: it is never in our emails.`, 'You can also change the code: open the envelope and choose Correct next to their name.']);
}

// A signer who is unsure can ask before signing, instead of signing blind or giving up.
export async function askSender(e: any, r: any, message: string, actor: Actor) {
  const text = str(message, 2000).trim();
  if (text.length < 3) throw bad('Type your question first.');
  const sender = senderOf(e);
  audit(e.id, actor, 'Question asked', `${r.name} asked the sender a question`);
  await sendMail({ to: sender.email, replyTo: r.email, fromName: r.name, subject: `Question about: ${e.subject}`, heading: `${r.name} has a question before signing`,
    lines: [text, `Reply to this email to answer ${r.name} (${r.email}) directly. If the document needs changing, you can correct it without voiding it.`],
    cta: { label: 'Open envelope', url: `${baseUrl()}/app/envelopes/${e.id}` }, envelopeId: e.id, brand: brandOf(e.account_id) });
}

// A message reached the help form about a problem signing this envelope, from the address of one of its recipients.
// The sender can often fix that faster than anyone (send the link again, correct an address, give more time), and
// a stuck signer may have no working link to ask them with. So the sender is told, if they want news of problems,
// and the envelope's record says so. Anyone can type any address into that form: the writer's words are passed on
// only when `text` is given, which the caller does for a writer whose address is confirmed. Once a day for each
// recipient at most. Answers whether the sender was told.
export async function helpAsked(e: any, r: any, text: string | null, actor: Actor): Promise<boolean> {
  if (e.kind !== 'envelope' || e.status === 'draft') return false;
  const detail = `A message from ${r.email} to the Sign&Grow help form said there is a problem with signing`;
  if (get("SELECT 1 x FROM audit WHERE envelope_id=? AND action='Help requested' AND detail=? AND at > ?", e.id, detail, new Date(Date.now() - 864e5).toISOString())) return false;
  audit(e.id, actor, 'Help requested', detail);
  await notifySender(e, 'problems', `Problem signing: ${e.subject}`, `${r.name} may be stuck on your document`,
    [`Someone writing from ${r.email}, the address of ${r.name} on this envelope, told our help form that there is a problem with signing "${e.subject}".`,
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
export async function reportAbuse(e: any, r: any, body: any, actor: Actor) {
  const reason = ABUSE_REASONS.includes(body?.reason) ? body.reason : 'other';
  if (get('SELECT 1 x FROM abuse_reports WHERE envelope_id=? AND reporter=?', e.id, r.email)) return;
  run('INSERT INTO abuse_reports (id, envelope_id, account_id, reporter, reason, detail, ip, at) VALUES (?,?,?,?,?,?,?,?)', id('abr'), e.id, e.account_id, r.email, reason, str(body?.detail, 2000) || null, actor.ip || null, now());
  audit(e.id, actor, 'Reported as suspicious', `${r.name}: ${reason}`);
  const account = get('SELECT * FROM accounts WHERE id=?', e.account_id);
  // Reports that are still open and reports an operator confirmed as abuse both count: confirming one must never make
  // the automatic pause less likely. Only reports a person dismissed, or looked at before lifting an earlier pause, do not.
  const since = [new Date(Date.now() - 30 * 864e5).toISOString(), account.unpaused_at || ''].sort()[1];
  const n = get("SELECT COUNT(DISTINCT reporter) n FROM abuse_reports WHERE account_id=? AND status IN ('open','upheld') AND at > ?", e.account_id, since).n;
  const limit = abuseSuspendAfter();
  let paused = false;
  if (n >= limit && !account.suspended_at) {
    run('UPDATE accounts SET suspended_at=?, suspended_reason=? WHERE id=?', now(), `${n} different recipients reported documents from this account`, account.id);
    paused = true;
    // Never pause silently: say why, what still works, and how to reach a person.
    for (const u of all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", account.id))
      await sendMail({ to: u.email, subject: 'Sending is paused on your Sign&Grow account', heading: 'Sending is paused while we review reports',
        lines: [`${n} different recipients reported documents sent from ${account.name} as suspicious, so sending is paused until a person has looked: no new envelopes, no new or changed recipients, no reminders and no reopening.`, 'Everything else still works: you can open, download and export every document, and people who already have a document can still open, sign and download it.', 'If this is a mistake, use the contact form. A person reviews every pause.'],
        cta: { label: 'Contact us', url: `${baseUrl()}/help` } });
  }
  const to = process.env.ABUSE_EMAIL || process.env.SUPPORT_EMAIL;
  const sender = senderOf(e);
  if (to)
    await sendMail({ to, subject: `Report: ${e.subject}`, heading: paused ? 'Account paused after reports' : 'A recipient reported a document', replyTo: r.email,
      lines: [`Envelope ${e.id} from ${sender?.name} <${sender?.email}> (account ${account.name}, ${account.id}).`, `Reported by ${r.name} <${r.email}> as: ${reason}.`, ...(body?.detail ? [`They wrote: ${str(body.detail, 2000)}`] : []), `${n} open or confirmed report(s) against this account in the last 30 days.${paused ? ' Sending is now paused for it.' : ''}`],
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
    // A start from a public form costs nothing to make and holds one of the owner's signatures. One that its visitor
    // has left alone for a day is closed, so the signature comes back and a stranger cannot tie up a whole balance by
    // starting and walking away. The visitor loses nothing but the start: the form simply gives them a new one.
    const visitor = e.form_recipient_id && e.recipients.find((r: any) => r.id === e.form_recipient_id);
    if (visitor && (visitor.status === 'sent' || visitor.status === 'viewed')) {
      const touched = get("SELECT MAX(at) at FROM audit WHERE envelope_id=? AND actor != 'System'", e.id)?.at || e.sent_at;
      if (Date.now() - Date.parse(touched) > powerformIdleHours() * 3600_000) {
        run("UPDATE envelopes SET status='expired', expires_at=?, updated_at=? WHERE id=?", t, t, e.id);
        audit(e.id, { name: 'System' }, 'Envelope expired', `Started from a public form and left unfinished for ${powerformIdleHours()} hours`);
        fireWebhooks(e.account_id, 'envelope.expired', e.id);
        expired++;
        continue;
      }
    }
    // Nothing goes to recipients in the name of a sender who is paused, also not from the timer.
    const held = !!emailRefusal(e);
    // One warning, three days out, so a deadline never arrives as a surprise.
    if (e.expires_at && !e.expiry_warned_at && Date.parse(e.expires_at) - Date.now() < 3 * 864e5 && Date.parse(e.expires_at) - Date.parse(e.sent_at) > 4 * 864e5) {
      run('UPDATE envelopes SET expiry_warned_at=? WHERE id=?', t, e.id);
      const waiting = e.recipients.filter((r: any) => r.status === 'sent' || r.status === 'viewed');
      if (!held) for (const r of waiting) await notifyRecipient(e, r, 'expiring');
      await notifySender(e, 'problems', `Expires soon: ${e.subject}`, 'This envelope expires in three days', [`Still waiting on ${waiting.map((r: any) => r.name).join(', ') || 'nobody'}. You can extend the deadline if they need longer.`], { label: 'Extend deadline', url: `${baseUrl()}/app/envelopes/${e.id}?extend=1` });
      warned++;
    }
    // "I never got it": if a request sits unopened, tell the sender once so they can share the link another way.
    const quietMs = (Number(process.env.UNOPENED_ALERT_HOURS) || 48) * 3600_000;
    const unopened = e.recipients.filter((r: any) => r.status === 'sent' && r.role !== 'inperson' && !r.unopened_alerted_at && r.sent_at && Date.now() - Date.parse(r.sent_at) > quietMs);
    if (unopened.length) {
      for (const r of unopened) run('UPDATE recipients SET unopened_alerted_at=? WHERE id=?', t, r.id);
      await notifySender(e, 'problems', `Not opened yet: ${e.subject}`, `${unopened.map((r: any) => r.name).join(', ')} ${unopened.length === 1 ? 'has' : 'have'} not opened your document`,
        ['The email may be sitting in a spam folder or have gone to the wrong address.', 'From the envelope page you can copy their signing link and send it yourself by text or chat, nudge them, or correct the address without voiding anything.']);
      unopenedAlerts += unopened.length;
    }
    if (e.reminder_days > 0 && !held) {
      const last = e.last_reminder_at || e.sent_at;
      if (Date.now() - new Date(last).getTime() >= e.reminder_days * 864e5) reminded += (await remindEnvelope(e, { name: 'System' })) ? 1 : 0;
    }
  }
  return { expired, reminded, warned, unopened: unopenedAlerts };
}
