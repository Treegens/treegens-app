import { all, get, run, tx, saveBlob, readBlob } from './db.ts';
import { bad, id, token, sha256, now, isEmail, str, baseUrl } from './util.ts';
import { sendMail } from './mail.ts';
import { renderEnvelopePdf } from './pdf.ts';
import { fireWebhooks } from './webhooks.ts';
import { sheetsSaved, impactOf, fmtNum, PLANS } from '../lib/impact.ts';

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

export function loadEnvelope(envelopeId: string): any {
  const e = get('SELECT * FROM envelopes WHERE id=?', envelopeId);
  if (!e) return null;
  e.documents = all(
    'SELECT d.id, d.name, d.position, d.file_id, f.pages, f.page_sizes, f.sha256, f.size FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=? ORDER BY d.position',
    envelopeId,
  ).map((d) => ({ ...d, page_sizes: JSON.parse(d.page_sizes) }));
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

// Replaces the whole draft: documents, recipients and fields. The editor sends its full state on every save.
export function saveDraft(e: any, body: any, accountId: string) {
  if (e.status !== 'draft') throw bad('Only drafts and templates can be edited.');
  // The editor makes its own ids so they stay stable between saves. Accept one only if it is well formed and not
  // already used by a different envelope; otherwise hand out a fresh id.
  const keep = (existing: any[], prefix: string, table: string) => {
    const mine = new Set(existing.map((x) => x.id));
    const map = new Map<string, string>();
    const shape = new RegExp(`^${prefix}_[A-Za-z0-9_-]{16}$`);
    return (clientId: any) => {
      const k = String(clientId ?? '');
      if (!map.has(k)) map.set(k, mine.has(k) || (shape.test(k) && !get(`SELECT 1 x FROM ${table} WHERE id=?`, k)) ? k : id(prefix));
      return map.get(k)!;
    };
  };
  const docId = keep(e.documents, 'doc', 'documents');
  const recId = keep(e.recipients, 'rcp', 'recipients');
  const fldId = keep(e.fields, 'fld', 'fields');

  const docs = Array.isArray(body.documents) ? body.documents.slice(0, 30) : [];
  const recs = Array.isArray(body.recipients) ? body.recipients.slice(0, 50) : [];
  const flds = Array.isArray(body.fields) ? body.fields.slice(0, 2000) : [];
  const docPages = new Map<string, number>();

  tx(() => {
    run('UPDATE envelopes SET subject=?, message=?, ordered=?, reminder_days=?, expire_days=?, updated_at=? WHERE id=?',
      str(body.subject ?? e.subject, 200), str(body.message ?? e.message, 5000), body.ordered ? 1 : 0,
      int(body.reminder_days, 0, 60, e.reminder_days), int(body.expire_days, 1, 365, e.expire_days), now(), e.id);
    run('DELETE FROM fields WHERE envelope_id=?', e.id);
    run('DELETE FROM recipients WHERE envelope_id=?', e.id);
    run('DELETE FROM documents WHERE envelope_id=?', e.id);
    docs.forEach((d: any, i: number) => {
      const f = get('SELECT id, pages, name FROM files WHERE id=? AND account_id=?', d.file_id, accountId);
      if (!f) throw bad('A document in this envelope no longer exists. Upload it again.');
      const did = docId(d.id);
      docPages.set(did, f.pages);
      run('INSERT INTO documents (id, envelope_id, file_id, name, position) VALUES (?,?,?,?,?)', did, e.id, f.id, str(d.name || f.name, 200), i);
    });
    recs.forEach((r: any, i: number) => {
      const role = ROLES.includes(r.role) ? r.role : 'signer';
      const email = str(r.email, 254).trim();
      if (email && !isEmail(email)) throw bad(`"${email}" is not a valid email address.`);
      run('INSERT INTO recipients (id, envelope_id, role, role_name, name, email, routing_order, position, access_code, note) VALUES (?,?,?,?,?,?,?,?,?,?)',
        recId(r.id), e.id, role, str(r.role_name, 80) || null, str(r.name, 120).trim(), email, int(r.routing_order, 1, 99, 1), i,
        str(r.access_code, 50).trim() || null, str(r.note, 1000) || null);
    });
    const recIds = new Set(recs.map((r: any) => recId(r.id)));
    for (const f of flds) {
      if (!FIELD_TYPES.includes(f.type)) continue;
      const did = docId(f.document_id);
      if (!docPages.has(did)) continue;
      const rid = f.type === 'note' ? null : recId(f.recipient_id);
      if (rid && !recIds.has(rid)) continue;
      const w = Math.min(1, Math.max(0.005, Number(f.w) || 0.1));
      const h = Math.min(1, Math.max(0.005, Number(f.h) || 0.03));
      const prefilled = ['text', 'number', 'date', 'company', 'title', 'note', 'checkbox', 'radio', 'dropdown'].includes(f.type);
      run('INSERT INTO fields (id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, label, value, options, group_name, validation, readonly) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        fldId(f.id), e.id, did, rid, f.type, int(f.page, 0, docPages.get(did)! - 1, 0),
        Math.min(clamp01(f.x), 1 - w), Math.min(clamp01(f.y), 1 - h), w, h, f.required === false || f.required === 0 ? 0 : 1,
        str(f.label, 120) || null, prefilled ? str(f.value, 4000) || null : null,
        Array.isArray(f.options) ? JSON.stringify(f.options.slice(0, 100).map((o: any) => str(o, 200))) : null,
        str(f.group_name, 80) || null, str(f.validation, 200) || null, f.readonly || f.type === 'note' ? 1 : 0);
    }
  });
}

// Copies an envelope or template into a new draft. Used for templates, cloning, bulk send and PowerForms.
export function copyEnvelope(src: any, o: { accountId: string; senderId: string; kind: 'envelope' | 'template'; subject?: string; message?: string; fill?: Record<string, { name?: string; email?: string }>; extra?: Record<string, any> }): string {
  const eid = id(o.kind === 'template' ? 'tpl' : 'env');
  const t = now();
  tx(() => {
    run('INSERT INTO envelopes (id, account_id, sender_id, kind, subject, message, ordered, reminder_days, expire_days, template_id, powerform_id, bulk_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      eid, o.accountId, o.senderId, o.kind, str(o.subject ?? src.subject, 200), str(o.message ?? src.message, 5000), src.ordered, src.reminder_days, src.expire_days,
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
      const keepValue = f.readonly || f.type === 'note' || src.status === 'draft';
      run('INSERT INTO fields (id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, label, value, options, group_name, validation, readonly) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id('fld'), eid, dmap.get(f.document_id), f.recipient_id ? rmap.get(f.recipient_id) : null, f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.label,
        keepValue && !['signature', 'initials', 'attachment', ...AUTO_TYPES].includes(f.type) ? f.value : null,
        JSON.stringify(f.options || []), f.group_name, f.validation, f.readonly);
    }
  });
  return eid;
}

// ---- Sending and routing -------------------------------------------------------------------

export const billingEnabled = () => !!process.env.STRIPE_SECRET_KEY;

export function usageThisMonth(accountId: string): number {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at >= ?", accountId, start.toISOString()).n;
}

function brandOf(accountId: string) {
  const a = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', accountId);
  return { name: a?.name, color: a?.brand_color, logo: a?.brand_logo };
}
const senderOf = (e: any) => get('SELECT id, name, email FROM users WHERE id=?', e.sender_id);
export const signUrl = (r: any) => `${baseUrl()}/sign/${r.token}`;

export async function sendEnvelope(envelopeId: string, actor: Actor) {
  const e = loadEnvelope(envelopeId);
  if (!e || e.kind !== 'envelope') throw bad('Envelope not found.', 404);
  if (e.status !== 'draft') throw bad('This envelope has already been sent.');
  if (!e.documents.length) throw bad('Add at least one document before sending.');
  if (!e.recipients.length) throw bad('Add at least one recipient before sending.');
  for (const r of e.recipients) {
    if (!r.name) throw bad('Every recipient needs a name.');
    if (!isEmail(r.email)) throw bad(`${r.name} needs a valid email address.`);
    if (ACTS(r.role) && !e.fields.some((f: any) => f.recipient_id === r.id && f.type !== 'note'))
      throw bad(`${r.name} has nothing to sign yet. Place at least one field for them.`);
  }
  if (!e.recipients.some((r: any) => r.role !== 'cc')) throw bad('Add at least one recipient who signs, approves or views.');
  const account = get('SELECT * FROM accounts WHERE id=?', e.account_id);
  if (billingEnabled() && account.plan === 'seedling' && usageThisMonth(account.id) >= PLANS.seedling.envelopesPerMonth)
    throw bad(`The Seedling plan includes ${PLANS.seedling.envelopesPerMonth} envelopes a month. Upgrade to Grove for unlimited sending. Every cent plants trees.`, 402);

  const pages = e.documents.reduce((n: number, d: any) => n + d.pages, 0);
  const t = now();
  tx(() => {
    run("UPDATE envelopes SET status='sent', sent_at=?, updated_at=?, expires_at=?, sheets=?, subject=? WHERE id=?",
      t, t, new Date(Date.now() + e.expire_days * 864e5).toISOString(), sheetsSaved(pages, e.recipients.length),
      e.subject || `Please sign: ${e.documents[0].name}`, e.id);
    for (const r of e.recipients) {
      run('UPDATE recipients SET token=? WHERE id=?', token(), r.id);
      run('INSERT INTO contacts (id, account_id, name, email, created_at) VALUES (?,?,?,?,?) ON CONFLICT(account_id, email) DO NOTHING', id('con'), e.account_id, r.name, r.email, t);
    }
    audit(e.id, actor, 'Envelope sent', `${e.recipients.length} recipient${e.recipients.length === 1 ? '' : 's'}, ${pages} page${pages === 1 ? '' : 's'}`);
  });
  fireWebhooks(e.account_id, 'envelope.sent', e.id);
  await advance(e.id);
}

async function notifyRecipient(e: any, r: any, reminder = false) {
  const sender = senderOf(e);
  const verb = r.role === 'cc' ? 'sent you a copy of' : r.role === 'viewer' ? 'sent you a document to view:' : r.role === 'approver' ? 'asked you to approve' : 'sent you a document to sign:';
  const to = r.role === 'inperson' ? sender.email : r.email;
  await sendMail({
    to,
    subject: `${reminder ? 'Reminder: ' : ''}${e.subject}`,
    heading: r.role === 'inperson' ? `Host an in-person signing for ${r.name}` : `${sender.name} ${verb} ${e.subject}`,
    lines: [
      ...(r.role === 'inperson' ? [`Open the document on your device and hand it to ${r.name} to sign in person.`] : []),
      ...(e.message ? [e.message] : []),
      ...(r.note ? [`Note for you: ${r.note}`] : []),
      ...(r.access_code ? ['You will need the access code the sender gave you to open it.'] : []),
    ],
    cta: { label: r.role === 'cc' ? 'View document' : r.role === 'viewer' ? 'View document' : r.role === 'approver' ? 'Review and approve' : 'Review and sign', url: signUrl(r) },
    envelopeId: e.id,
    brand: brandOf(e.account_id),
    footnote: e.expires_at && r.role !== 'cc' ? `This request expires on ${e.expires_at.slice(0, 10)}.` : undefined,
  });
}

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
      audit(e.id, { name: 'System' }, r.role === 'cc' ? 'Copy sent' : 'Sent to recipient', `${r.name} <${r.email}>`);
      await notifyRecipient(e, { ...r }, false);
    }
    if (!copied) return;
  }
}

export async function buildPdf(e: any, certificate: boolean): Promise<Uint8Array> {
  return renderEnvelopePdf(e, auditTrail(e.id), { certificate, sender: senderOf(e) });
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
  for (const r of fresh.recipients) {
    const to = r.role === 'inperson' ? '' : r.email.toLowerCase();
    if (!to || sent.has(to)) continue;
    sent.add(to);
    await sendMail({ to: r.email, subject: `Completed: ${fresh.subject}`, heading: 'Your document is complete', lines, cta: { label: 'View completed document', url: signUrl(r) }, envelopeId: e.id, brand, attachments });
  }
  if (sender && !sent.has(sender.email.toLowerCase()))
    await sendMail({ to: sender.email, subject: `Completed: ${fresh.subject}`, heading: 'Your document is complete', lines, cta: { label: 'Open envelope', url: `${baseUrl()}/app/envelopes/${e.id}` }, envelopeId: e.id, brand, attachments });
}

export function finalPdf(e: any): Buffer | null {
  return e.final_sha256 ? readBlob(e.final_sha256) : null;
}

async function notifySender(e: any, subject: string, heading: string, lines: string[]) {
  const sender = senderOf(e);
  if (sender) await sendMail({ to: sender.email, subject, heading, lines, cta: { label: 'Open envelope', url: `${baseUrl()}/app/envelopes/${e.id}` }, envelopeId: e.id, brand: brandOf(e.account_id) });
}

async function notifyActive(e: any, subject: string, heading: string, lines: string[]) {
  for (const r of e.recipients)
    if (r.status !== 'pending' && r.role !== 'inperson')
      await sendMail({ to: r.email, subject, heading, lines, envelopeId: e.id, brand: brandOf(e.account_id) });
}

export async function voidEnvelope(e: any, reason: string, actor: Actor) {
  if (e.status !== 'sent') throw bad('Only envelopes that are out for signature can be voided.');
  if (!reason.trim()) throw bad('Give a reason for voiding. Recipients will see it.');
  run("UPDATE envelopes SET status='voided', void_reason=?, updated_at=? WHERE id=?", str(reason, 500), now(), e.id);
  audit(e.id, actor, 'Envelope voided', str(reason, 500));
  fireWebhooks(e.account_id, 'envelope.voided', e.id);
  await notifyActive(e, `Voided: ${e.subject}`, 'This document was voided by the sender', [`Reason: ${reason}`, 'There is nothing more for you to do.']);
}

export async function remindEnvelope(e: any, actor: Actor): Promise<number> {
  if (e.status !== 'sent') throw bad('Reminders only go out while an envelope is waiting for signatures.');
  const waiting = e.recipients.filter((r: any) => r.status === 'sent' || r.status === 'viewed');
  for (const r of waiting) await notifyRecipient(e, r, true);
  run('UPDATE envelopes SET last_reminder_at=? WHERE id=?', now(), e.id);
  audit(e.id, actor, 'Reminder sent', waiting.map((r: any) => r.name).join(', '));
  return waiting.length;
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
  run('UPDATE recipients SET name=?, email=?, access_code=?, token=?, viewed_at=NULL, consent_at=NULL, status=? WHERE id=?',
    name, email, code, token(), r.status === 'pending' ? 'pending' : 'sent', r.id);
  audit(e.id, actor, 'Recipient corrected', `${r.name} <${r.email}> is now ${name} <${email}>`);
  if (r.status !== 'pending') await notifyRecipient(loadEnvelope(e.id), get('SELECT * FROM recipients WHERE id=?', r.id));
}

// ---- Recipient actions ---------------------------------------------------------------------

export function markViewed(e: any, r: any, actor: Actor) {
  if (r.status !== 'sent') return;
  run("UPDATE recipients SET status='viewed', viewed_at=?, ip=?, user_agent=? WHERE id=?", now(), actor.ip || null, (actor.ua || '').slice(0, 300), r.id);
  audit(e.id, actor, 'Viewed', `${r.name} opened the envelope`);
  fireWebhooks(e.account_id, 'recipient.viewed', e.id, { recipient_id: r.id });
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

const okImage = (s: any) => typeof s === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < 700_000;

export async function completeRecipient(e: any, r: any, body: any, actor: Actor) {
  if (e.status !== 'sent') throw bad('This envelope is no longer open for signing.');
  if (r.status !== 'sent' && r.status !== 'viewed') throw bad(r.status === 'completed' ? 'You have already finished this document.' : 'It is not your turn to sign yet.');
  if (!r.consent_at) throw bad('Please agree to use electronic records and signatures first.');
  let verb = 'Viewed';
  if (ACTS(r.role)) {
    const mine = e.fields.filter((f: any) => f.recipient_id === r.id);
    const needsSig = mine.some((f: any) => f.type === 'signature' && (f.required || body.values?.[f.id]));
    const needsIni = mine.some((f: any) => f.type === 'initials' && (f.required || body.values?.[f.id]));
    if (needsSig && !okImage(body.signature_png)) throw bad('Adopt a signature before finishing.');
    if (needsIni && !okImage(body.initials_png)) throw bad('Adopt your initials before finishing.');
    tx(() => {
      applyValues(e, r, body.values || {}, true);
      run('UPDATE recipients SET signature_png=?, initials_png=? WHERE id=?', okImage(body.signature_png) ? body.signature_png : null, okImage(body.initials_png) ? body.initials_png : null, r.id);
    });
    verb = 'Signed';
  } else if (r.role === 'approver') verb = 'Approved';
  const t = now();
  run("UPDATE recipients SET status='completed', completed_at=?, viewed_at=COALESCE(viewed_at, ?), ip=?, user_agent=? WHERE id=?", t, t, actor.ip || null, (actor.ua || '').slice(0, 300), r.id);
  audit(e.id, actor, verb, `${r.name} <${r.email}>`);
  fireWebhooks(e.account_id, 'recipient.completed', e.id, { recipient_id: r.id });
  await advance(e.id);
}

export async function declineRecipient(e: any, r: any, reason: string, actor: Actor) {
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw bad('This envelope is no longer open for signing.');
  if (r.role === 'cc' || r.role === 'viewer') throw bad('Only signers and approvers can decline.');
  if (!reason.trim()) throw bad('Please tell the sender why you are declining.');
  const t = now();
  run("UPDATE recipients SET status='declined', decline_reason=?, completed_at=?, ip=? WHERE id=?", str(reason, 500), t, actor.ip || null, r.id);
  run("UPDATE envelopes SET status='declined', updated_at=? WHERE id=?", t, e.id);
  audit(e.id, actor, 'Declined', `${r.name}: ${str(reason, 500)}`);
  fireWebhooks(e.account_id, 'envelope.declined', e.id, { recipient_id: r.id });
  await notifySender(e, `Declined: ${e.subject}`, `${r.name} declined to sign`, [`Reason: ${reason}`]);
  await notifyActive({ ...e, recipients: e.recipients.filter((x: any) => x.id !== r.id) }, `Declined: ${e.subject}`, 'This document was declined', [`${r.name} declined to sign, so the envelope is closed.`]);
}

export async function reassignRecipient(e: any, r: any, to: { name: string; email: string; reason?: string }, actor: Actor) {
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw bad('This envelope is no longer open for signing.');
  if (r.role !== 'signer' && r.role !== 'approver') throw bad('This role cannot be assigned to someone else.');
  const name = str(to.name, 120).trim();
  const email = str(to.email, 254).trim();
  if (!name || !isEmail(email)) throw bad('Enter the name and email of the person who should sign instead.');
  run("UPDATE recipients SET name=?, email=?, token=?, status='sent', sent_at=?, viewed_at=NULL, consent_at=NULL, access_code=NULL, reassigned_from=? WHERE id=?",
    name, email, token(), now(), `${r.name} <${r.email}>`, r.id);
  audit(e.id, actor, 'Reassigned', `${r.name} <${r.email}> assigned this to ${name} <${email}>${to.reason ? `: ${str(to.reason, 300)}` : ''}`);
  await notifyRecipient(loadEnvelope(e.id), get('SELECT * FROM recipients WHERE id=?', r.id));
  await notifySender(e, `Reassigned: ${e.subject}`, `${r.name} assigned signing to ${name}`, [`${name} <${email}> will sign instead.`, ...(to.reason ? [`Reason: ${to.reason}`] : [])]);
}

// ---- Scheduled work: expirations and automatic reminders -----------------------------------

export async function cronTick(): Promise<{ expired: number; reminded: number }> {
  let expired = 0;
  let reminded = 0;
  const t = now();
  for (const row of all("SELECT id FROM envelopes WHERE status='sent' AND kind='envelope'")) {
    const e = loadEnvelope(row.id);
    if (e.expires_at && e.expires_at < t) {
      run("UPDATE envelopes SET status='expired', updated_at=? WHERE id=?", t, e.id);
      audit(e.id, { name: 'System' }, 'Envelope expired', 'The signing deadline passed');
      fireWebhooks(e.account_id, 'envelope.expired', e.id);
      await notifySender(e, `Expired: ${e.subject}`, 'This envelope expired before everyone signed', ['You can clone it and send it again.']);
      expired++;
    } else if (e.reminder_days > 0) {
      const last = e.last_reminder_at || e.sent_at;
      if (Date.now() - new Date(last).getTime() >= e.reminder_days * 864e5) reminded += (await remindEnvelope(e, { name: 'System' })) ? 1 : 0;
    }
  }
  return { expired, reminded };
}
