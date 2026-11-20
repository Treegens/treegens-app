import { route, pdfResponse, type Ctx } from './router.ts';
import { get, run, readBlob } from './db.ts';
import { bad, hmac, now, str, rateLimit, safeEqual } from './util.ts';
import { cookie, readCookie } from './auth.ts';
import { loadEnvelope, markViewed, applyValues, completeRecipient, declineRecipient, reassignRecipient, audit, finalPdf, buildPdf } from './envelopes.ts';
import { fieldDisplayValue } from './pdf.ts';
import { storeUpload } from './routes-envelopes.ts';
import { impactOf } from '../lib/impact.ts';

// Everything here is authorised by the unguessable token in the signing link, plus the access code when one is set.

function find(c: Ctx, needUnlocked = true) {
  rateLimit(`sign:${c.ip}`, 600, 600_000);
  const r = get('SELECT * FROM recipients WHERE token=?', c.params.token);
  if (!r) throw bad('This signing link is not valid any more. Ask the sender for a new one.', 404);
  const e = loadEnvelope(r.envelope_id);
  const locked = !!r.access_code && !safeEqual(readCookie(c.req, `ts_ac_${r.id}`) || '', hmac(`ac:${r.id}:${r.access_code}`));
  if (locked && needUnlocked) throw bad('Enter the access code first.', 401);
  const actor = { name: `${r.name} <${r.email}>`, ip: c.ip, ua: c.ua };
  return { e, r: e.recipients.find((x: any) => x.id === r.id), locked, actor };
}

// Documents are only readable while it is the recipient's turn or after they finished, never once the envelope is closed.
function assertViewable(e: any, r: any) {
  if (['voided', 'expired', 'declined'].includes(e.status)) throw bad('This envelope is closed.', 403);
  if (r.status === 'pending') throw bad('It is not your turn yet.', 403);
}

route('GET', '/sign/:token', (c) => {
  const { e, r, locked, actor } = find(c, false);
  const sender = get('SELECT name, email FROM users WHERE id=?', e.sender_id);
  const a = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', e.account_id);
  const base = {
    brand: a,
    envelope: { id: e.id, subject: e.subject, status: e.status, void_reason: e.void_reason, expires_at: e.expires_at, sender, impact: impactOf(e.sheets) },
    recipient: { id: r.id, name: r.name, email: r.email, role: r.role, status: r.status, consented: !!r.consent_at },
  };
  if (locked) return { ...base, locked: true };
  if (['voided', 'expired', 'declined'].includes(e.status) || r.status === 'pending') return { ...base, locked: false };
  if (e.status === 'sent' && r.status === 'sent') markViewed(e, r, actor);
  const byId = new Map<string, any>(e.recipients.map((x: any) => [x.id, x]));
  return {
    ...base,
    locked: false,
    message: e.message,
    note: r.note,
    recipient: { ...base.recipient, status: r.status === 'sent' ? 'viewed' : r.status, signature_png: r.signature_png, initials_png: r.initials_png },
    documents: e.documents.map((d: any) => ({ id: d.id, name: d.name, pages: d.pages })),
    fields: e.fields.filter((f: any) => f.recipient_id === r.id).map(({ envelope_id: _e, ...f }: any) => f),
    // What others have already filled in, shown read-only so the signer sees the document as it stands.
    others: e.fields.filter((f: any) => f.recipient_id !== r.id).map((f: any) => {
      const o = f.recipient_id ? byId.get(f.recipient_id) : null;
      const done = !f.recipient_id || o?.status === 'completed';
      return {
        id: f.id, document_id: f.document_id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
        value: done ? fieldDisplayValue(f, o) : '',
        image: done && f.value && (f.type === 'signature' || f.type === 'initials') ? (f.type === 'signature' ? o.signature_png : o.initials_png || o.signature_png) : null,
      };
    }).filter((f: any) => f.value || f.image),
  };
}, 'public');

route('POST', '/sign/:token/unlock', async (c) => {
  const { e, r, actor } = find(c, false);
  rateLimit(`code:${r.id}`, 8, 900_000);
  if (!r.access_code || !safeEqual(str((await c.body()).code).trim(), r.access_code)) {
    audit(e.id, actor, 'Access code failed', r.name);
    throw bad('That access code is not right.', 401);
  }
  c.cookies.push(cookie(`ts_ac_${r.id}`, hmac(`ac:${r.id}:${r.access_code}`), 86400, c.secure));
  audit(e.id, actor, 'Access code accepted', r.name);
}, 'public');

route('POST', '/sign/:token/consent', (c) => {
  const { e, r, actor } = find(c);
  if (!r.consent_at) {
    run('UPDATE recipients SET consent_at=? WHERE id=?', now(), r.id);
    audit(e.id, actor, 'Agreed to electronic records and signatures', r.name);
  }
}, 'public');

route('GET', '/sign/:token/doc/:doc', (c) => {
  const { e, r } = find(c);
  assertViewable(e, r);
  const d = e.documents.find((x: any) => x.id === c.params.doc);
  if (!d) throw bad('Document not found.', 404);
  return pdfResponse(readBlob(d.sha256), d.name, true);
}, 'public');

// "Finish later": keep what has been filled in so far.
route('POST', '/sign/:token/save', async (c) => {
  const { e, r } = find(c);
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw bad('This envelope is no longer open for signing.');
  applyValues(e, r, (await c.body()).values || {}, false);
}, 'public');

route('POST', '/sign/:token/upload', async (c) => {
  const { e, r } = find(c);
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw bad('This envelope is no longer open for signing.');
  rateLimit(`upload:${r.id}`, 30, 3600_000);
  return storeUpload(c, null);
}, 'public');

route('POST', '/sign/:token/complete', async (c) => {
  const { e, r, actor } = find(c);
  await completeRecipient(e, r, await c.body(), actor);
  const after = get('SELECT status, sheets FROM envelopes WHERE id=?', e.id);
  return { ok: true, envelope_status: after.status, impact: impactOf(after.sheets) };
}, 'public');

route('POST', '/sign/:token/decline', async (c) => {
  const { e, r, actor } = find(c);
  await declineRecipient(e, r, str((await c.body()).reason, 500), actor);
}, 'public');

route('POST', '/sign/:token/reassign', async (c) => {
  const { e, r, actor } = find(c);
  await reassignRecipient(e, r, await c.body(), actor);
}, 'public');

route('GET', '/sign/:token/download', async (c) => {
  const { e, r } = find(c);
  assertViewable(e, r);
  const done = finalPdf(e);
  return pdfResponse(done || (await buildPdf(e, false)), e.subject || 'document', c.q.get('inline') === '1');
}, 'public');
