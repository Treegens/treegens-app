import { route, pdfResponse, type Ctx } from './router.ts';
import { get, run, readBlob } from './db.ts';
import { bad, hmac, now, str, rateLimit, safeEqual, HttpError } from './util.ts';
import { cookie, readCookie } from './auth.ts';
import { loadEnvelope, markViewed, applyValues, completeRecipient, declineRecipient, reassignRecipient, audit, finalPdf, buildPdf, requestExtension, muteReminders, reportAbuse, askSender, renameSelf, noteDeadLink, okImage } from './envelopes.ts';
import { fieldDisplayValue } from './pdf.ts';
import { storeUpload } from './routes-envelopes.ts';
import { impactOf } from '../lib/impact.ts';
import { rateWait } from './util.ts';
import { wrongAccessCode, requestAccessCode } from './envelopes.ts';
import { senderText, shownVersion, changedSince } from './envelopes.ts';
import { ACCESS_CODE_TRIES } from '../lib/policy.ts';

// Everything here is authorised by the unguessable token in the signing link, plus the access code when one is set.

const sender = (e: any) => get('SELECT name, email FROM users WHERE id=?', e.sender_id) || { name: 'The sender', email: '' };

// One address can be a whole office signing a bulk send together. So the tight limit is per link and address: one
// person hammering a link never blocks a colleague with a document of their own. The ceiling for an address is only
// there to stop a flood, and is far above what people signing can reach.
function find(c: Ctx, needUnlocked = true) {
  rateLimit(`sign:${c.ip}`, 20_000, 600_000);
  rateLimit(`sign:${c.ip}:${c.params.token}`, 600, 600_000);
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
  // A frozen code is said straight away, so nobody types the right code into a form that can no longer accept it.
  if (locked) return { ...base, locked: true, code_frozen: !!r.code_frozen_at };
  if (e.status === 'expired' && r.status !== 'completed') void noteDeadLink(e, r, `The deadline passed on ${String(e.expires_at).slice(0, 10)}. You can reopen the envelope with a new deadline, and nobody who already signed has to sign again.`).catch(() => {});
  if (['voided', 'expired', 'declined'].includes(e.status) || r.status === 'pending') return { ...base, locked: false };
  if (e.status === 'sent' && r.status === 'sent') markViewed(e, r, actor);
  // The server keeps which content version this screen was given. The screen sends the number back with every save
  // and with Finish, and one that comes from an older version is refused: see completeRecipient.
  if (e.status === 'sent' && r.seen_version !== e.content_version) run('UPDATE recipients SET seen_version=? WHERE id=?', e.content_version, r.id);
  const byId = new Map<string, any>(e.recipients.map((x: any) => [x.id, x]));
  const signedBefore = String(r.signed_before || '').split('\n').filter(Boolean).pop() || null;
  return {
    ...base,
    locked: false,
    version: e.content_version,
    // What the sender's latest correction changed on the documents, in words, for a screen that has to say so.
    changed: e.last_change || null,
    message: e.message,
    note: r.note,
    recipient: { ...base.recipient, status: r.status === 'sent' ? 'viewed' : r.status, signature_png: r.signature_png, initials_png: r.initials_png, signed_before: r.status === 'completed' ? null : signedBefore },
    documents: e.documents.map((d: any) => ({ id: d.id, name: d.name, pages: d.pages })),
    fields: e.fields.filter((f: any) => f.recipient_id === r.id).map(({ envelope_id: _e, ...f }: any) => f),
    // What is on the pages besides this person's own fields, shown read-only so they see the document as it stands.
    // Everything the sender wrote is there from the first look, whoever it is assigned to: a note or a read-only
    // value ('sender'), and a value its owner may still change ('start'). What another person filled in ('signer')
    // appears once that person has finished.
    others: e.fields.filter((f: any) => f.recipient_id !== r.id).map((f: any) => {
      const o = f.recipient_id ? byId.get(f.recipient_id) : null;
      const done = !f.recipient_id || o?.status === 'completed';
      return {
        id: f.id, document_id: f.document_id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
        label: f.label, by: o?.name || null, from: !f.recipient_id || f.readonly ? 'sender' : done ? 'signer' : 'start',
        value: done ? fieldDisplayValue(f, o, e.date_format) : senderText(f),
        image: done && f.value && (f.type === 'signature' || f.type === 'initials') ? (f.type === 'signature' ? o.signature_png : o.initials_png || o.signature_png) : null,
      };
    }).filter((f: any) => f.value || f.image),
  };
}, 'public');

// What the locked screen says once a code is frozen. The same words whether it just happened or happened earlier.
const frozenText = (e: any) => `This access code was entered wrongly ${ACCESS_CODE_TRIES} times, so it is frozen and no longer opens the document. ${sender(e).name} has been told and can set a new code. Ask them for the new one.`;

// Only wrong tries count, in two ways. A device address that gets it wrong a few times waits a quarter of an hour,
// and that touches nobody else: the right code from another device still opens the document. After
// ACCESS_CODE_TRIES wrong tries in total the code is frozen for everyone until the sender sets a new one, so a
// short code cannot be worked out by trying a few every day.
const CODE_TRIES_PER_ADDRESS = 5;
const CODE_WAIT_MS = 900_000;
route('POST', '/sign/:token/unlock', async (c) => {
  find(c, false);
  const code = str((await c.body()).code).trim();
  const { e, r, actor } = look(c, false);
  if (!r.access_code) return; // nothing to unlock
  if (r.code_frozen_at) throw bad(frozenText(e), 423);
  const tries = `code:${r.id}:${c.ip}`;
  const wait = rateWait(tries, CODE_TRIES_PER_ADDRESS);
  if (wait) throw bad(`That was ${CODE_TRIES_PER_ADDRESS} wrong codes in a row from this device. Wait ${Math.ceil(wait / 60_000)} minutes and try again, or ask ${sender(e).name} for the code: ${sender(e).email}. Nothing you filled in is lost.`, 429);
  if (!safeEqual(code, r.access_code)) {
    rateLimit(tries, Infinity, CODE_WAIT_MS); // counts this wrong try for this device address
    const left = await wrongAccessCode(e, r, actor);
    if (!left) throw bad(frozenText(e), 423);
    throw bad(`That access code is not right. ${sender(e).name} chose the code and can tell you what it is: ${sender(e).email}. It is not in the email we sent you.${left <= 3 ? ` After ${left} more wrong ${left === 1 ? 'try' : 'tries'} the code is frozen until ${sender(e).name} sets a new one.` : ''}`, 401);
  }
  c.cookies.push(cookie(`ts_ac_${r.id}`, hmac(`ac:${r.id}:${r.access_code}`), 86400, c.secure));
  audit(e.id, actor, 'Access code accepted', r.name);
}, 'public');

// "Ask the sender" on the locked screen: for someone who was never given the code, or whose code is frozen.
route('POST', '/sign/:token/ask-code', async (c) => {
  const { e, r, actor } = find(c, false);
  rateLimit(`askcode:${r.id}`, 2, 86400_000);
  await requestAccessCode(e, r, actor);
}, 'public');

// The screen sends the content version it shows with consent too. Agreeing is about signing on screen, not about
// the wording, so an older version is not refused here: the answer carries the current one, and the page loads the
// document afresh before anything can be signed.
route('POST', '/sign/:token/consent', (c) => {
  const { e, r, actor } = find(c);
  if (!r.consent_at) {
    run('UPDATE recipients SET consent_at=? WHERE id=?', now(), r.id);
    audit(e.id, actor, 'Agreed to electronic records and signatures', r.name);
  }
  return { ok: true, version: e.content_version };
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
  // A save from a screen that still shows the document as it was before a correction is not applied. The page
  // loads the new version, keeps the answers that still have a field, and asks the person to look again.
  const shown = shownVersion(r, b);
  if (shown != null && shown !== e.content_version) throw changedSince(e);
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
  // Until everyone has finished, the copy a recipient downloads is made for them: it shows what their screen shows.
  return pdfResponse(done || (await buildPdf(e, false, r.id)), e.subject || 'document', c.q.get('inline') === '1');
}, 'public');
