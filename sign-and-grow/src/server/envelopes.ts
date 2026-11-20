import { all, get, run, tx, saveBlob, readBlob } from './db.ts';
import { bad, id, token, sha256, now, isEmail, str, baseUrl, checkCode } from './util.ts';
import { sendMail } from './mail.ts';
import { renderEnvelopePdf } from './pdf.ts';
import { fireWebhooks } from './webhooks.ts';
import { sheetsSaved, impactOf, fmtNum, PLANS } from '../lib/impact.ts';
import { DATE_FORMATS } from '../lib/dates.ts';

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

// Writes documents, recipients and fields from the editor's full state. Recipient rows are updated in place, so
// their progress (status, link, consent, signature) survives a correction made after sending.
function writeContent(e: any, body: any, accountId: string, correcting: boolean) {
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

  const docs = Array.isArray(body.documents) ? body.documents.slice(0, 30) : [];
  const recs = Array.isArray(body.recipients) ? body.recipients.slice(0, 50) : [];
  const flds = Array.isArray(body.fields) ? body.fields.slice(0, 2000) : [];
  const docPages = new Map<string, number>();
  const oldRecs = new Set<string>(e.recipients.map((r: any) => r.id));
  const oldFields = new Map<string, any>(e.fields.map((f: any) => [f.id, f]));

  run('UPDATE envelopes SET subject=?, message=?, ordered=?, reminder_days=?, expire_days=?, date_format=?, updated_at=? WHERE id=?',
    str(body.subject ?? e.subject, 200), str(body.message ?? e.message, 5000), body.ordered ? 1 : 0,
    int(body.reminder_days, 0, 60, e.reminder_days), int(body.expire_days, 1, 365, e.expire_days),
    (DATE_FORMATS as readonly string[]).includes(body.date_format) ? body.date_format : e.date_format, now(), e.id);
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
    const role = ROLES.includes(r.role) ? r.role : 'signer';
    const email = str(r.email, 254).trim();
    if (email && !isEmail(email)) throw bad(`"${email}" is not a valid email address.`);
    const vals = [role, str(r.role_name, 80) || null, str(r.name, 120).trim(), email, int(r.routing_order, 1, 99, 1), i, str(r.access_code, 50).trim() || null, str(r.note, 1000) || null];
    if (oldRecs.has(rid)) run('UPDATE recipients SET role=?, role_name=?, name=?, email=?, routing_order=?, position=?, access_code=?, note=? WHERE id=?', ...vals, rid);
    else run('INSERT INTO recipients (role, role_name, name, email, routing_order, position, access_code, note, id, envelope_id) VALUES (?,?,?,?,?,?,?,?,?,?)', ...vals, rid, e.id);
  });
  for (const rid of oldRecs) if (!seen.has(rid)) run('DELETE FROM recipients WHERE id=?', rid);
  for (const f of flds) {
    if (!FIELD_TYPES.includes(f.type)) continue;
    const did = docId(f.document_id);
    if (!docPages.has(did)) continue;
    const rid = f.type === 'note' ? null : recId(f.recipient_id);
    if (rid && !seen.has(rid)) continue;
    const fid = fldId(f.id);
    const old = oldFields.get(fid);
    const w = Math.min(1, Math.max(0.005, Number(f.w) || 0.1));
    const h = Math.min(1, Math.max(0.005, Number(f.h) || 0.03));
    const prefilled = ['text', 'number', 'date', 'company', 'title', 'note', 'checkbox', 'radio', 'dropdown'].includes(f.type);
    // Signatures, initials and attachments are never set by the sender. During a correction, keep what signers put there.
    const value = prefilled ? str(f.value, 4000) || null : correcting && old ? old.value : null;
    run('INSERT INTO fields (id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, label, value, options, group_name, validation, readonly) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      fid, e.id, did, rid, f.type, int(f.page, 0, docPages.get(did)! - 1, 0),
      Math.min(clamp01(f.x), 1 - w), Math.min(clamp01(f.y), 1 - h), w, h, f.required === false || f.required === 0 ? 0 : 1,
      str(f.label, 120) || null, value,
      Array.isArray(f.options) ? JSON.stringify(f.options.slice(0, 100).map((o: any) => str(o, 200))) : null,
      str(f.group_name, 80) || null, str(f.validation, 200) || null, f.readonly || f.type === 'note' ? 1 : 0);
  }
}

// Replaces the whole draft: documents, recipients and fields. The editor sends its full state on every save.
export function saveDraft(e: any, body: any, accountId: string) {
  if (e.status !== 'draft') throw bad('Only drafts and templates can be edited.');
  tx(() => writeContent(e, body, accountId, false));
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

// What can no longer change once someone has finished: the documents, those people, and everything on the page they signed.
function lockedView(x: any, done: any[]): string {
  if (!done.length) return '';
  const ids = new Set(done.map((r) => r.id));
  return JSON.stringify({
    docs: x.documents.map((d: any) => [d.id, d.file_id]),
    people: done.map((r) => {
      const n = x.recipients.find((y: any) => y.id === r.id);
      return n ? [n.id, n.role, n.name, n.email.toLowerCase(), n.routing_order] : null;
    }),
    fields: x.fields.filter((f: any) => !f.recipient_id || ids.has(f.recipient_id))
      .map((f: any) => [f.id, f.document_id, f.recipient_id, f.type, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), f.value ?? '']).sort(byFirst),
  });
}

// What one recipient is being asked to read and fill in. If it changes under them, they are told.
function askView(x: any, recipientId: string): string {
  return JSON.stringify({
    docs: x.documents.map((d: any) => [d.file_id, d.name]),
    fields: x.fields.filter((f: any) => !f.recipient_id || f.recipient_id === recipientId)
      .map((f: any) => [f.id, f.document_id, f.type, f.page, r6(f.x), r6(f.y), r6(f.w), r6(f.h), f.required, f.label ?? '', f.readonly ? f.value ?? '' : '']).sort(byFirst),
  });
}

export function retireToken(r: any) {
  if (r?.token) run('INSERT OR IGNORE INTO retired_tokens (token, recipient_id, retired_at) VALUES (?,?,?)', r.token, r.id, now());
}

// Change an envelope that is already out for signature, without voiding it. Anything goes until someone has
// finished. After that, the documents and whatever finished people signed are locked, and the rest can still change.
export async function correctEnvelope(e: any, body: any, accountId: string, actor: Actor) {
  if (e.kind !== 'envelope' || e.status !== 'sent') throw bad('Only envelopes that are out for signature can be changed.');
  const done = e.recipients.filter((r: any) => r.status === 'completed' && r.role !== 'cc');
  const before = lockedView(e, done);
  const oldById = new Map<string, any>(e.recipients.map((r: any) => [r.id, r]));
  const removed: any[] = [];
  const changedFor: any[] = [];
  let after: any;
  tx(() => {
    writeContent(e, body, accountId, true);
    after = loadEnvelope(e.id);
    if (lockedView(after, done) !== before)
      throw bad(`${done.map((r: any) => r.name).join(' and ')} already finished, so the documents and what they signed are locked. You can still change what the remaining recipients need to do, or void this envelope and send a new one.`, 409);
    assertSendable(after);
    for (const r of after.recipients) {
      const old = oldById.get(r.id);
      if (!old) {
        run('UPDATE recipients SET token=?, check_code=? WHERE id=?', token(), checkCode(), r.id);
        continue;
      }
      if (old.status === 'completed' || old.status === 'pending') continue;
      if (old.email.toLowerCase() !== r.email.toLowerCase() || old.role !== r.role) {
        // A different person or a different job: the old link dies and they are asked afresh when it is their turn.
        retireToken(old);
        run("UPDATE recipients SET status='pending', token=?, check_code=?, sent_at=NULL, viewed_at=NULL, consent_at=NULL, muted=0 WHERE id=?", token(), checkCode(), r.id);
      } else if (askView(e, r.id) !== askView(after, r.id)) changedFor.push(r);
    }
    for (const old of e.recipients) {
      if (after.recipients.some((r: any) => r.id === old.id)) continue;
      retireToken(old);
      if (old.status === 'sent' || old.status === 'viewed') removed.push(old);
    }
    const pages = after.documents.reduce((n: number, d: any) => n + d.pages, 0);
    run('UPDATE envelopes SET sheets=? WHERE id=?', sheetsSaved(pages, after.recipients.length), e.id);
    audit(e.id, actor, 'Envelope corrected', `Now ${after.recipients.length} recipient${after.recipients.length === 1 ? '' : 's'}, ${after.fields.length} field${after.fields.length === 1 ? '' : 's'}, ${pages} page${pages === 1 ? '' : 's'}`);
  });
  const sender = senderOf(e);
  for (const r of removed)
    if (r.role !== 'inperson')
      await sendMail({ to: r.email, subject: `No longer needed: ${e.subject}`, heading: 'You no longer need to sign this', lines: [`${sender.name} changed the document and you are no longer on it. There is nothing more for you to do.`], envelopeId: e.id, brand: brandOf(e.account_id), replyTo: sender.email, fromName: sender.name });
  for (const r of changedFor) await notifyRecipient(after, r, 'updated');
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

// Envelopes that count toward the free plan this month: the ones out for signature and the ones completed.
// Voided, declined and expired envelopes never count, corrections and resends are free, and a public form only
// counts once somebody has actually signed it.
export function usageThisMonth(accountId: string): number {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return get(
    `SELECT COUNT(*) n FROM envelopes e WHERE e.account_id=? AND e.kind='envelope' AND e.sent_at >= ?
       AND (e.status='completed' OR (e.status='sent' AND e.powerform_id IS NULL))
       AND EXISTS (SELECT 1 FROM recipients r JOIN users u ON u.id=e.sender_id WHERE r.envelope_id=e.id AND r.email != u.email)`,
    accountId, start.toISOString(),
  ).n;
}

// When the free allowance starts again.
export function usageResetsAt(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

// Fake payment notices ("your PayPal order, call this number") are the classic way e-signature services get abused.
// A brand-new free account sending one is stopped and told why, with a way to reach a person if it is genuine.
function looksLikeScam(e: any): boolean {
  const text = [e.subject, e.message, ...e.documents.map((d: any) => d.name)].join(' ');
  const money = /\b(invoice|payment|refund|charged|renewal|order (confirmation|number)|transaction|subscription)\b/i.test(text);
  const phone = /(\+?\d[\d\s().-]{8,}\d)/.test(text);
  const brand = /\b(paypal|norton|geek ?squad|mcafee|microsoft|apple|amazon|coinbase|venmo|zelle|best ?buy)\b/i.test(text);
  return money && phone && brand;
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
  // These three checks exist to keep scammers from using the service to send convincing fakes.
  if (!sender?.email_verified) throw bad('Confirm your email address before you send. We emailed you a link when you signed up, and you can resend it from the banner at the top of the app.', 403);
  if (account.suspended_at) throw bad('Sending is paused on this account while we look into a report from a recipient. Contact support and we will sort it out quickly.', 403);
  if (account.plan === 'seedling' && Date.now() - Date.parse(account.created_at) < 7 * 864e5) {
    const cap = Number(process.env.NEW_ACCOUNT_DAILY_RECIPIENTS) || 50;
    const today = get("SELECT COUNT(*) n FROM recipients r JOIN envelopes x ON x.id=r.envelope_id WHERE x.account_id=? AND x.sent_at > ?", e.account_id, new Date(Date.now() - 864e5).toISOString()).n;
    if (today + e.recipients.length > cap) throw bad(`New accounts can send to ${cap} people a day during their first week. Need more right now? Contact support.`, 429);
  }
  if (account.plan === 'seedling' && Date.now() - Date.parse(account.created_at) < 30 * 864e5 && looksLikeScam(e))
    throw bad('This reads like a payment notice from a well-known brand with a phone number to call, which is how scams look. We do not send those from new accounts. If it is genuine, use the contact form and a person will clear it for you.', 422);
  if (billingEnabled() && account.plan === 'seedling' && usageThisMonth(account.id) >= PLANS.seedling.envelopesPerMonth)
    throw bad(`The Seedling plan includes ${PLANS.seedling.envelopesPerMonth} envelopes a month and you have used them all. Nothing extra is ever charged. Upgrade to Grove for unlimited sending, or wait until the 1st.`, 402);

  const pages = e.documents.reduce((n: number, d: any) => n + d.pages, 0);
  const t = now();
  tx(() => {
    run("UPDATE envelopes SET status='sent', sent_at=?, updated_at=?, expires_at=?, sheets=?, subject=? WHERE id=?",
      t, t, new Date(Date.now() + e.expire_days * 864e5).toISOString(), sheetsSaved(pages, e.recipients.length),
      e.subject || `Please sign: ${e.documents[0].name}`, e.id);
    for (const r of e.recipients) {
      run('UPDATE recipients SET token=?, check_code=? WHERE id=?', token(), checkCode(), r.id);
      run('INSERT INTO contacts (id, account_id, name, email, created_at) VALUES (?,?,?,?,?) ON CONFLICT(account_id, email) DO NOTHING', id('con'), e.account_id, r.name, r.email, t);
    }
    audit(e.id, actor, 'Envelope sent', `${e.recipients.length} recipient${e.recipients.length === 1 ? '' : 's'}, ${pages} page${pages === 1 ? '' : 's'}`);
  });
  fireWebhooks(e.account_id, 'envelope.sent', e.id);
  await advance(e.id);
  // The free allowance never ends as a surprise: a heads-up at 80% and again when it is used up.
  if (billingEnabled() && account.plan === 'seedling') {
    const limit = PLANS.seedling.envelopesPerMonth;
    const used = usageThisMonth(account.id);
    if (used === limit || used === Math.ceil(limit * 0.8))
      await sendMail({ to: sender.email, subject: used === limit ? 'You have used this month\'s free envelopes' : `${used} of ${limit} free envelopes used this month`,
        heading: used === limit ? 'That was your last free envelope this month' : 'You are close to this month\'s free limit',
        lines: [`${account.name} has used ${used} of ${limit} envelopes on the free Seedling plan. The count starts again on ${usageResetsAt().slice(0, 10)}.`, 'Nothing extra is ever charged. When the limit is reached, sending simply pauses until the reset or until you choose Grove. Voided, declined and expired envelopes do not count, and signing your own documents is always free.'],
        cta: { label: 'See your plan', url: `${baseUrl()}/app/settings?tab=billing` } });
  }
}

type Notice = 'new' | 'reminder' | 'updated' | 'reopened' | 'expiring' | 'resent';
const NOTICE_PREFIX: Record<Notice, string> = { new: '', reminder: 'Reminder: ', updated: 'Updated: ', reopened: 'Reopened: ', expiring: 'Expires soon: ', resent: '' };

async function notifyRecipient(e: any, r: any, kind: Notice = 'new'): Promise<boolean> {
  if (kind === 'reminder' && r.muted) return false;
  const sender = senderOf(e);
  const verb = r.role === 'cc' ? 'sent you a copy of' : r.role === 'viewer' ? 'sent you a document to view:' : r.role === 'approver' ? 'asked you to approve' : 'sent you a document to sign:';
  const to = r.role === 'inperson' ? sender.email : r.email;
  const deadline = e.expires_at && r.role !== 'cc' ? e.expires_at.slice(0, 10) : '';
  const shared = (e.recipients || []).some((x: any) => x.id !== r.id && x.email.toLowerCase() === r.email.toLowerCase());
  await sendMail({
    to,
    subject: `${NOTICE_PREFIX[kind]}${e.subject}`,
    heading: r.role === 'inperson' ? `Host an in-person signing for ${r.name}` : `${shared ? `For ${r.name}: ` : ''}${sender.name} ${verb} ${e.subject}`,
    lines: [
      ...(shared ? [`More than one person on this document uses this email address. This link is for ${r.name} only.`] : []),
      ...(kind === 'updated' ? [`${sender.name} changed this document after sending it. Please look at it again before you sign.`] : []),
      ...(kind === 'reopened' ? [`${sender.name} gave everyone more time, so you can sign now.`] : []),
      ...(kind === 'expiring' ? [`This request closes on ${deadline}. If you need longer, reply to this email and ask ${sender.name} for more time.`] : []),
      ...(kind === 'resent' ? ['You asked for a fresh link. Here it is.'] : []),
      ...(r.role === 'inperson' ? [`Open the document on your device and hand it to ${r.name} to sign in person.`] : []),
      ...(e.message ? [`${sender.name} wrote:\n${e.message}`] : []),
      ...(r.note ? [`Note for you: ${r.note}`] : []),
      ...(r.access_code ? [`You will need an access code to open it. ${sender.name} will give it to you separately. It is not in this email.`] : []),
      `Sent by ${sender.name} (${sender.email}). Reply to this email to reach them directly.`,
    ],
    cta: { label: r.role === 'cc' ? 'View document' : r.role === 'viewer' ? 'View document' : r.role === 'approver' ? 'Review and approve' : 'Review and sign', url: signUrl(r) },
    envelopeId: e.id,
    brand: brandOf(e.account_id),
    replyTo: sender.email,
    fromName: sender.name,
    code: r.check_code,
    footnote: [deadline && kind !== 'expiring' ? `This request closes on ${deadline}.` : '', kind === 'reminder' ? `Too many reminders? Stop them for this document: ${signUrl(r)}?mute=1` : ''].filter(Boolean).join(' ') || undefined,
  });
  return true;
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
      await notifyRecipient(e, { ...r }, 'new');
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
    await sendMail({ to: r.email, subject: `Completed: ${fresh.subject}`, heading: 'Your document is complete', lines: [...lines, `Keep this email. The link below keeps working for as long as ${sender?.name || 'the sender'} keeps their Sign&Grow account, and the PDF is attached when it is small enough to send. Lost it later? Any time, ${baseUrl()}/help can send your documents to this address again.`], cta: { label: 'View completed document', url: signUrl(r) }, envelopeId: e.id, brand, attachments, replyTo: sender?.email, fromName: sender?.name, code: r.check_code });
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
  run("UPDATE envelopes SET status='voided', void_reason=?, updated_at=? WHERE id=?", str(reason, 500), now(), e.id);
  audit(e.id, actor, 'Envelope voided', str(reason, 500));
  fireWebhooks(e.account_id, 'envelope.voided', e.id);
  await notifyActive(e, `Voided: ${e.subject}`, 'This document was voided by the sender', [`Reason: ${reason}`, 'There is nothing more for you to do.']);
}

// Reminders only ever go to people whose turn it is and who have not finished. Pass a recipient to nudge just them.
// A recipient who asked for no more reminders is never reminded; the sender sees that and can reach them another way.
export async function remindEnvelope(e: any, actor: Actor, recipientId?: string): Promise<number> {
  if (e.status !== 'sent') throw bad('Reminders only go out while an envelope is waiting for signatures.');
  const waiting = e.recipients.filter((r: any) => (r.status === 'sent' || r.status === 'viewed') && (!recipientId || r.id === recipientId));
  const reminded: string[] = [];
  for (const r of waiting) if (await notifyRecipient(e, r, 'reminder')) reminded.push(r.name);
  run('UPDATE envelopes SET last_reminder_at=? WHERE id=?', now(), e.id);
  if (reminded.length) audit(e.id, actor, 'Reminder sent', reminded.join(', '));
  return reminded.length;
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
  if (email.toLowerCase() === r.email.toLowerCase()) {
    // Same person, same inbox: fixing a name or an access code never breaks the link they already have.
    run('UPDATE recipients SET name=?, access_code=? WHERE id=?', name, code, r.id);
    audit(e.id, actor, 'Recipient corrected', `${r.name} is now ${name}${code !== r.access_code ? ', access code changed' : ''}`);
    return;
  }
  retireToken(r);
  run('UPDATE recipients SET name=?, email=?, access_code=?, token=?, check_code=?, viewed_at=NULL, consent_at=NULL, muted=0, unopened_alerted_at=NULL, status=? WHERE id=?',
    name, email, code, token(), checkCode(), r.status === 'pending' ? 'pending' : 'sent', r.id);
  audit(e.id, actor, 'Recipient corrected', `${r.name} <${r.email}> is now ${name} <${email}>`);
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
  const left = e.recipients.filter((x: any) => x.id !== r.id && x.status !== 'completed' && x.role !== 'cc');
  if (left.length) await notifySender(e, 'signed', `${verb}: ${e.subject}`, `${r.name} has ${verb.toLowerCase()} your document`, [`Still waiting on ${left.map((x: any) => x.name).join(', ')}.`]);
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
  await notifySender(e, 'problems', `Declined: ${e.subject}`, `${r.name} declined to sign`, [`Reason: ${reason}`, 'The envelope is closed. You can clone it, change what needs changing and send it again.']);
  await notifyActive({ ...e, recipients: e.recipients.filter((x: any) => x.id !== r.id) }, `Declined: ${e.subject}`, 'This document was declined', [`${r.name} declined to sign, so the envelope is closed.`]);
}

export async function reassignRecipient(e: any, r: any, to: { name: string; email: string; reason?: string }, actor: Actor) {
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw bad('This envelope is no longer open for signing.');
  if (r.role !== 'signer' && r.role !== 'approver') throw bad('This role cannot be assigned to someone else.');
  const name = str(to.name, 120).trim();
  const email = str(to.email, 254).trim();
  if (!name || !isEmail(email)) throw bad('Enter the name and email of the person who should sign instead.');
  retireToken(r);
  run("UPDATE recipients SET name=?, email=?, token=?, check_code=?, status='sent', sent_at=?, viewed_at=NULL, consent_at=NULL, access_code=NULL, muted=0, reassigned_from=? WHERE id=?",
    name, email, token(), checkCode(), now(), `${r.name} <${r.email}>`, r.id);
  audit(e.id, actor, 'Reassigned', `${r.name} <${r.email}> assigned this to ${name} <${email}>${to.reason ? `: ${str(to.reason, 300)}` : ''}`);
  await notifyRecipient(loadEnvelope(e.id), get('SELECT * FROM recipients WHERE id=?', r.id));
  await notifySender(e, 'problems', `Reassigned: ${e.subject}`, `${r.name} assigned signing to ${name}`, [`${name} <${email}> will sign instead.`, ...(to.reason ? [`Reason: ${to.reason}`] : [])]);
}

// ---- Deadlines, lost links, reminders, reports -------------------------------------------------

// Push the deadline out, or reopen an envelope that already expired. No need to start again.
export async function extendEnvelope(e: any, days: any, actor: Actor) {
  if (e.kind !== 'envelope' || (e.status !== 'sent' && e.status !== 'expired')) throw bad('Only envelopes that are waiting for signatures, or that expired, can be given more time.');
  const add = int(days, 1, 365, 30);
  const reopened = e.status === 'expired';
  const from = reopened ? Date.now() : Math.max(Date.now(), Date.parse(e.expires_at || now()));
  const expires = new Date(from + add * 864e5).toISOString();
  run("UPDATE envelopes SET status='sent', expires_at=?, expiry_warned_at=NULL, updated_at=? WHERE id=?", expires, now(), e.id);
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

// Someone opened a link that was replaced (after a correction or reassignment). Send the current one to whoever holds it now.
export async function resendFromRetired(oldToken: string): Promise<boolean> {
  const row = get('SELECT recipient_id FROM retired_tokens WHERE token=?', oldToken);
  const r = row && get('SELECT * FROM recipients WHERE id=?', row.recipient_id);
  if (!r?.token || r.status === 'pending' || r.status === 'declined') return false;
  const e = loadEnvelope(r.envelope_id);
  if (!e || (e.status !== 'sent' && e.status !== 'completed')) return false;
  return notifyRecipient(e, e.recipients.find((x: any) => x.id === r.id) || r, 'resent');
}

// "I cannot find the email": send every open or recently completed document to the address that asks for it.
// Only that inbox receives the links, so asking proves nothing and leaks nothing.
export async function emailMyLinks(email: string): Promise<number> {
  const rows = all(
    `SELECT r.token, r.status my_status, r.role, e.subject, e.status, u.name sender FROM recipients r
       JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id
      WHERE r.email=? AND r.role!='inperson' AND r.token IS NOT NULL AND e.kind='envelope'
        AND ((e.status='sent' AND r.status IN ('sent','viewed')) OR e.status='completed')
      ORDER BY e.updated_at DESC LIMIT 50`, email);
  if (!rows.length) return 0;
  await sendMail({
    to: email, subject: 'Your documents on Sign&Grow', heading: 'Here are your documents',
    lines: ['You asked us to find your documents. These are the ones sent to this email address.'],
    links: rows.map((x) => ({ label: x.subject, url: `${baseUrl()}/sign/${x.token}`, note: `from ${x.sender} · ${x.status === 'completed' ? 'completed' : x.role === 'cc' ? 'your copy' : 'waiting for you'}` })),
    footnote: 'If you did not ask for this, you can ignore it. Nobody else received these links.',
  });
  return rows.length;
}

// A signer can fix the spelling of their own name. It is logged and the sender is told, so nothing changes quietly.
export async function renameSelf(e: any, r: any, newName: string, actor: Actor) {
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw bad('This envelope is no longer open for signing.');
  const name = str(newName, 120).trim();
  if (name.length < 2) throw bad('Type your name as it should appear.');
  if (name === r.name) return;
  run('UPDATE recipients SET name=? WHERE id=?', name, r.id);
  audit(e.id, actor, 'Signer corrected their name', `"${r.name}" is now "${name}"`);
  await notifySender(e, 'problems', `Name corrected: ${e.subject}`, `${r.name} corrected their name to ${name}`, [`The signer at ${r.email} changed how their name is written, from "${r.name}" to "${name}". It is recorded in the audit trail. If this is not who you expected, void the envelope.`]);
}

// Told once per recipient: somebody tried to open a link that no longer works, so the sender can help before being asked.
export async function noteDeadLink(e: any, r: any, why: string) {
  if (r.dead_link_alerted_at || r.status === 'completed') return;
  run('UPDATE recipients SET dead_link_alerted_at=? WHERE id=?', now(), r.id);
  await notifySender(e, 'problems', `Could not open: ${e.subject}`, `${r.name} tried to open your document and could not`, [why]);
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
  const n = get("SELECT COUNT(DISTINCT reporter) n FROM abuse_reports WHERE account_id=? AND status='open' AND at > ?", e.account_id, new Date(Date.now() - 30 * 864e5).toISOString()).n;
  const limit = Number(process.env.ABUSE_SUSPEND_AFTER) || 3;
  let paused = false;
  if (n >= limit && !account.suspended_at) {
    run('UPDATE accounts SET suspended_at=?, suspended_reason=? WHERE id=?', now(), `${n} different recipients reported documents from this account`, account.id);
    paused = true;
    // Never pause silently: say why, what still works, and how to reach a person.
    for (const u of all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", account.id))
      await sendMail({ to: u.email, subject: 'Sending is paused on your Sign&Grow account', heading: 'Sending is paused while we review reports',
        lines: [`${n} different recipients reported documents sent from ${account.name} as suspicious, so new sends are paused until a person has looked.`, 'Everything else still works: you can open, download and export every document, and documents already out can still be signed.', 'If this is a mistake, use the contact form. A person reviews every pause.'],
        cta: { label: 'Contact us', url: `${baseUrl()}/help` } });
  }
  const to = process.env.ABUSE_EMAIL || process.env.SUPPORT_EMAIL;
  const sender = senderOf(e);
  if (to)
    await sendMail({ to, subject: `Report: ${e.subject}`, heading: paused ? 'Account paused after reports' : 'A recipient reported a document', replyTo: r.email,
      lines: [`Envelope ${e.id} from ${sender?.name} <${sender?.email}> (account ${account.name}, ${account.id}).`, `Reported by ${r.name} <${r.email}> as: ${reason}.`, ...(body?.detail ? [`They wrote: ${str(body.detail, 2000)}`] : []), `${n} open report(s) against this account in the last 30 days.${paused ? ' Sending is now paused for it.' : ''}`],
      cta: { label: 'Open the review queue', url: `${baseUrl()}/app/operator` } });
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
    // One warning, three days out, so a deadline never arrives as a surprise.
    if (e.expires_at && !e.expiry_warned_at && Date.parse(e.expires_at) - Date.now() < 3 * 864e5 && Date.parse(e.expires_at) - Date.parse(e.sent_at) > 4 * 864e5) {
      run('UPDATE envelopes SET expiry_warned_at=? WHERE id=?', t, e.id);
      const waiting = e.recipients.filter((r: any) => r.status === 'sent' || r.status === 'viewed');
      for (const r of waiting) await notifyRecipient(e, r, 'expiring');
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
    if (e.reminder_days > 0) {
      const last = e.last_reminder_at || e.sent_at;
      if (Date.now() - new Date(last).getTime() >= e.reminder_days * 864e5) reminded += (await remindEnvelope(e, { name: 'System' })) ? 1 : 0;
    }
  }
  return { expired, reminded, warned, unopened: unopenedAlerts };
}
