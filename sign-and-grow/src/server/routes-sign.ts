import { route, pdfResponse, type Ctx } from './router.ts';
import { get, run, readBlob } from './db.ts';
import { bad, hmac, now, str, rateLimit, safeEqual, HttpError } from './util.ts';
import { cookie, readCookie } from './auth.ts';
import { loadEnvelope, markViewed, applyValues, completeRecipient, declineRecipient, reassignRecipient, audit, finalPdf, buildPdf, requestExtension, muteReminders, reportAbuse, askSender, renameSelf, noteDeadLink, okImage } from './envelopes.ts';
import { fieldDisplayValue } from './pdf.ts';
import { storeUpload } from './routes-envelopes.ts';
import { impactOf } from '../lib/impact.ts';

// Everything here is authorised by the unguessable token in the signing link, plus the access code when one is set.

const sender = (e: any) => get('SELECT name, email FROM users WHERE id=?', e.sender_id) || { name: 'The sender', email: '' };

function find(c: Ctx, needUnlocked = true) {
  rateLimit(`sign:${c.ip}`, 600, 600_000);
  return look(c, needUnlocked);
}

// Reading a request body means waiting, and while a handler waits a second request can finish, decline, reassign or
// void. So a handler that changes something looks the link up twice: `const body = await checkedBody(c)` and then
// `look(c)`. The first look, in here, refuses a bad link, a missing access code or a flood before anything is read.
// The second is the one that is acted on. It must be called in the handler itself, on the line after the await,
// because nothing may be waited for between that look and the change. That is what makes two requests at the same
// moment take turns.
function checkedBody(c: Ctx): Promise<any> {
  find(c);
  return c.body();
}

function look(c: Ctx, needUnlocked = true) {
  const r = get('SELECT * FROM recipients WHERE token=?', c.params.token);
  if (!r) {
    // 410 tells the page this link was replaced, so it can offer to send the current one instead of a dead end.
    if (get('SELECT 1 x FROM retired_tokens WHERE token=?', c.params.token)) throw new HttpError(410, 'This link was replaced by a newer one.');
    throw bad('We do not recognise this link. It may have been copied incompletely.', 404);
  }
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
    envelope: { id: e.id, subject: e.subject, status: e.status, void_reason: e.void_reason, expires_at: e.expires_at, date_format: e.date_format, sender, impact: impactOf(e.sheets) },
    recipient: { id: r.id, name: r.name, email: r.email, role: r.role, status: r.status, consented: !!r.consent_at, muted: !!r.muted },
  };
  if (locked) return { ...base, locked: true };
  if (e.status === 'expired' && r.status !== 'completed') void noteDeadLink(e, r, `The deadline passed on ${String(e.expires_at).slice(0, 10)}. You can reopen the envelope with a new deadline, and nobody who already signed has to sign again.`).catch(() => {});
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
        label: f.label, by: o?.name || null,
        value: done ? fieldDisplayValue(f, o, e.date_format) : '',
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
    // After three wrong tries the sender is told, because the usual cause is that the code never reached the signer.
    const fails = get("SELECT COUNT(*) n FROM audit WHERE envelope_id=? AND action='Access code failed' AND detail=?", e.id, r.name).n;
    if (fails === 3) void noteDeadLink(e, r, `They entered the wrong access code three times. Check that you gave them the right one (it is ${r.access_code}), or change it from the envelope page. Their link keeps working.`).catch(() => {});
    throw bad(`That access code is not right. ${sender(e).name} chose the code and can tell you what it is: ${sender(e).email}. It is not in the email we sent you.`, 401);
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
  // Looked up after the body is in, so a save that crosses Finish can never change what was just signed.
  const b = await checkedBody(c);
  const { e, r } = look(c);
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw bad('This envelope is no longer open for signing.');
  applyValues(e, r, b.values || {}, false);
  // The chosen signature travels with "finish later", so picking up on another device does not mean signing again.
  if (b.signature_png !== undefined || b.initials_png !== undefined)
    run('UPDATE recipients SET signature_png=?, initials_png=? WHERE id=?', okImage(b.signature_png) ? b.signature_png : r.signature_png, okImage(b.initials_png) ? b.initials_png : r.initials_png, r.id);
}, 'public');

route('POST', '/sign/:token/upload', async (c) => {
  const { e, r } = find(c);
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw bad('This envelope is no longer open for signing.');
  rateLimit(`upload:${r.id}`, 30, 3600_000);
  return storeUpload(c, null);
}, 'public');

// Finish (which is also how an approver approves and a viewer confirms), decline, pass on and rename all act on the
// second look. A double tap or a retry finds the first request's work already done and is told so: 409 for a
// second Finish or Decline, 410 for a link that a reassignment has just replaced.
route('POST', '/sign/:token/complete', async (c) => {
  const body = await checkedBody(c);
  const { e, r, actor } = look(c);
  await completeRecipient(e, r, body, actor);
  const after = get('SELECT status, sheets FROM envelopes WHERE id=?', e.id);
  return { ok: true, envelope_status: after.status, impact: impactOf(after.sheets) };
}, 'public');

route('POST', '/sign/:token/decline', async (c) => {
  const body = await checkedBody(c);
  const { e, r, actor } = look(c);
  await declineRecipient(e, r, str(body.reason, 500), actor);
}, 'public');

route('POST', '/sign/:token/reassign', async (c) => {
  const body = await checkedBody(c);
  const { e, r, actor } = look(c);
  await reassignRecipient(e, r, body, actor);
}, 'public');

route('POST', '/sign/:token/name', async (c) => {
  const body = await checkedBody(c);
  const { e, r, actor } = look(c);
  rateLimit(`name:${r.id}`, 5, 3600_000);
  await renameSelf(e, r, body.name, actor);
}, 'public');

// Ran out of time: ask the sender for more instead of starting over.
route('POST', '/sign/:token/request-extension', async (c) => {
  const { e, r, actor } = find(c, false);
  rateLimit(`ext:${r.id}`, 2, 86400_000);
  await requestExtension(e, r, actor);
}, 'public');

route('POST', '/sign/:token/ask', async (c) => {
  const { e, r, actor } = find(c);
  rateLimit(`ask:${r.id}`, 5, 3600_000);
  await askSender(e, r, (await c.body()).message, actor);
}, 'public');

route('POST', '/sign/:token/mute', (c) => {
  const { e, r, actor } = find(c, false);
  muteReminders(e, r, actor);
}, 'public');

// "This looks wrong": goes to a person, and enough reports pause the sender.
route('POST', '/sign/:token/report', async (c) => {
  const { e, r, actor } = find(c, false);
  rateLimit(`report:${c.ip}`, 10, 3600_000);
  await reportAbuse(e, r, await c.body(), actor);
}, 'public');

route('GET', '/sign/:token/download', async (c) => {
  const { e, r } = find(c);
  assertViewable(e, r);
  const done = finalPdf(e);
  return pdfResponse(done || (await buildPdf(e, false)), e.subject || 'document', c.q.get('inline') === '1');
}, 'public');
