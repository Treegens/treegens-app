import { route, pdfResponse, type Ctx } from './router.ts';
import { get, run, readBlob } from './db.ts';
import { bad, hmac, now, str, rateLimit, safeEqual, fmtCode, HttpError } from './util.ts';
import { cookie, readCookie } from './auth.ts';
import { handDevice } from './handover.ts';
import { loadEnvelope, markViewed, applyValues, completeRecipient, declineRecipient, reassignRecipient, audit, finalPdf, buildPdf, requestExtension, muteReminders, reportAbuse, askSender, renameSelf, noteDeadLink, okImage } from './envelopes.ts';
import { fieldDisplayValue, senderZone } from './pdf.ts';
import { validZone, clockIn, formatDateValue, momentText } from '../lib/dates.ts';
import { storeUpload } from './routes-envelopes.ts';
import { impactOf } from '../lib/impact.ts';
import { rateWait } from './util.ts';
import { wrongAccessCode, requestAccessCode } from './envelopes.ts';
import { shownVersion, changedSince } from './envelopes.ts';
import { noteReplacedLink, notCompletedNotice } from './envelopes.ts';
import { printedWords, printsName, notOpen, keepsCopy, earlierCopy } from './envelopes.ts';
import { ACCESS_CODE_TRIES } from '../lib/policy.ts';
import { unprintable } from './pdftext.ts';
import { gateOf, lockedView } from './signercode.ts';
import { CONSENT_VERSION, isConsentVersion, consentAuditNote } from '../lib/policy.ts';
// A recipient that is a group: whose link this is, who has taken the document on, and what a member's link may do.
import { memberOf, asMember, groupFacts, memberOpened, muteMember, takeOn, declineForGroup } from './groups.ts';

// Everything here is authorised by the unguessable token in the signing link, plus the access code when one is set.

const sender = (e: any) => get('SELECT name, email FROM users WHERE id=?', e.sender_id) || { name: 'The sender', email: '' };

// One address can be a whole office signing a bulk send together. So the tight limit is per link and address: one
// person hammering a link never blocks a colleague with a document of their own. The ceiling for an address is only
// there to stop a flood, and is far above what people signing can reach.
export function find(c: Ctx, needUnlocked = true) {
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

export function look(c: Ctx, needUnlocked = true) {
  // The link of one member of a group is kept with the group's members and leads to the group's row (groups.ts).
  const member = memberOf(c.params.token);
  const r = member ? get('SELECT * FROM recipients WHERE id=?', member.recipient_id) : get('SELECT * FROM recipients WHERE token=?', c.params.token);
  if (!r) {
    // 410 tells the page this link was replaced, so it can offer to send the current one instead of a dead end.
    if (get('SELECT 1 x FROM retired_tokens WHERE token=?', c.params.token)) {
      // The sender hears once that this replaced link was opened: it usually means someone is using the wrong email.
      void noteReplacedLink(c.params.token, { name: 'Someone with a replaced link', ip: c.ip, ua: c.ua }).catch(() => {});
      throw new HttpError(410, 'This link was replaced by a newer one.');
    }
    throw bad('We do not recognise this link. It may have been copied incompletely.', 404);
  }
  const e = loadEnvelope(r.envelope_id);
  const locked = !!r.access_code && !safeEqual(readCookie(c.req, `ts_ac_${r.id}`) || '', hmac(`ac:${r.id}:${r.access_code}`));
  if (locked && needUnlocked) throw bad('Enter the access code first.', 401);
  // The one-time code this browser still has to pass, when the sender asked for one (see signercode.ts). A device
  // that passed is remembered by a cookie, the same way a correct access code is.
  const gate = gateOf(c.req, r);
  if (gate && needUnlocked) throw bad('Type the one-time code first.', 401);
  const actor = { name: `${r.name} <${r.email}>`, ip: c.ip, ua: c.ua };
  const out = { e, r: e.recipients.find((x: any) => x.id === r.id), locked, gate, actor };
  // A member acts under their own name, and only as far as the state of their link allows: see asMember.
  return member ? asMember(c, out, member) : out;
}

const CLOSED = ['voided', 'expired', 'declined'];
// Documents are only readable while it is the recipient's turn or after they finished, never once the envelope is
// closed. The one exception is the download of someone who had signed: see GET /sign/:token/download.
function assertViewable(e: any, r: any) {
  if (CLOSED.includes(e.status)) throw bad('This envelope is closed.', 403);
  if (r.status === 'pending') throw bad('It is not your turn yet.', 403);
}

route('GET', '/sign/:token', (c) => {
  const { e, r, locked, gate, actor } = find(c, false);
  // In person: the host's device is about to be in the signer's hands, so the host's account locks in this browser.
  handDevice(c, e, r);
  const sender = get('SELECT name, email FROM users WHERE id=?', e.sender_id);
  const a = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', e.account_id);
  const base = {
    brand: a,
    envelope: { id: e.id, subject: e.subject, status: e.status, void_reason: e.void_reason, expires_at: e.expires_at, date_format: e.date_format, sender, impact: impactOf(e.sheets),
      // For someone who came through a public form on a shared device: where the next person starts.
      next_person: (e.powerform_id && e.form_recipient_id === r.id && get('SELECT slug FROM powerforms WHERE id=? AND active=1 AND shared_device=1', e.powerform_id)?.slug) || null },
    // signed_before: when this person finished, if the sender changed the document after that and asked them to
    // sign again. A closed envelope says so too, because that person still has the right to a copy. earlier_copy:
    // whether the document as they signed it then was kept, so the page only offers that download when it exists.
    // mail_stopped: this person marked an email about the envelope as spam, so nothing more is emailed to them about
    // it. The page says so and offers the one way back, which only they have (POST /sign/:token/mail-again).
    recipient: { id: r.id, name: r.name, email: r.email, role: r.role, status: r.status, consented: !!r.consent_at, muted: !!r.muted, mail_stopped: !!r.complained_at, signed_before: r.status === 'completed' ? null : String(r.signed_before || '').split('\n').filter(Boolean).pop() || null,
      earlier_copy: r.status !== 'completed' && !!r.signed_before && !!get('SELECT 1 x FROM earlier_signatures WHERE envelope_id=? AND recipient_id=? AND copy_sha256 IS NOT NULL', e.id, r.id) },
  };
  // Someone ran into the deadline. The sender is told before anything else is decided here, so an access code that
  // was not typed yet does not keep the news from them: the screen says "expired" before it asks for a code.
  if (e.status === 'expired' && r.status !== 'completed') void noteDeadLink(e, r, `The deadline passed on ${momentText(e.expires_at)}. You can reopen the envelope with a new deadline, and nobody who already signed has to sign again.`).catch(() => {});
  // A frozen code is said straight away, so nobody types the right code into a form that can no longer accept it.
  // Someone who has to type a one-time code is told less than this until they have: see lockedView.
  if (locked || gate) return lockedView({ ...base, locked: true, code_frozen: !!r.code_frozen_at }, r, locked, gate);
  // From here the document is open to this browser, so the Help link on the page may carry the security code of
  // this person's emails: a message to the help form then says which document it is about, and its sender can be
  // told (aboutCode in routes-support.ts). A page that is still locked is not given the code, because the code
  // names the document, and its Help link carries the envelope's id alone, which proves nothing by itself.
  Object.assign(base, { help_code: r.check_code ? fmtCode(r.check_code) : null });
  // A group's document: which group, what this member's link is to it, and who has taken it on (groupFacts in
  // groups.ts). Said only now, behind the access code, like everything else about the document.
  Object.assign(base.recipient, { group: groupFacts(e, r) });
  if (['voided', 'expired', 'declined'].includes(e.status) || r.status === 'pending') return { ...base, locked: false };
  // A member whose colleague has the document, or who was taken out of the group, is told so and shown no more.
  if (r.member && (r.group_state === 'taken' || r.group_state === 'removed')) return { ...base, locked: false };
  if (e.status === 'sent' && r.status === 'sent') markViewed(e, r, actor);
  if (r.member) memberOpened(e, r, actor);
  // The server keeps which content version this screen was given. The screen sends the number back with every save
  // and with Finish, and one that comes from an older version is refused: see completeRecipient.
  if (e.status === 'sent' && r.seen_version !== e.content_version) run('UPDATE recipients SET seen_version=? WHERE id=?', e.content_version, r.id);
  const byId = new Map<string, any>(e.recipients.map((x: any) => [x.id, x]));
  const signedBefore = String(r.signed_before || '').split('\n').filter(Boolean).pop() || null;
  const words = printedWords(e);
  return {
    ...base,
    locked: false,
    version: e.content_version,
    // What the sender's latest correction changed on the documents, in words, for a screen that has to say so.
    changed: e.last_change || null,
    message: e.message,
    note: r.note,
    recipient: { ...base.recipient, status: r.status === 'sent' ? 'viewed' : r.status, signature_png: r.signature_png, initials_png: r.initials_png, signed_before: r.status === 'completed' ? null : signedBefore },
    // sha256 is the fingerprint of the file behind each document. The screen loads the pages again whenever it
    // changes, and Finish waits until the new pages are on it, so nobody signs a file they were not shown.
    documents: e.documents.map((d: any) => ({ id: d.id, name: d.name, pages: d.pages, sha256: d.sha256 })),
    fields: e.fields.filter((f: any) => f.recipient_id === r.id).map(({ envelope_id: _e, ...f }: any) => f),
    // What is on the pages besides this person's own fields, shown read-only so they see the document as it stands.
    // Everything the sender wrote is there from the first look, whoever it is assigned to: a note or a read-only
    // value, and the name or address that a full name or email field prints, also for someone who only gets a copy
    // ('sender'), and a value its owner may still change ('start'). What another person filled in ('signer')
    // appears once that person has finished.
    others: e.fields.filter((f: any) => f.recipient_id !== r.id).map((f: any) => {
      const o = f.recipient_id ? byId.get(f.recipient_id) : null;
      const done = !f.recipient_id || o?.status === 'completed';
      return {
        id: f.id, document_id: f.document_id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
        label: f.label, by: o?.name || null, from: !f.recipient_id || f.readonly || printsName(f) ? 'sender' : done ? 'signer' : 'start',
        // Dates read here as they will on the signed PDF: in the envelope's format, the date of signing by the
        // signer's own calendar.
        value: done ? fieldDisplayValue(f, o, e.date_format, senderZone(e)) : f.type === 'date' ? formatDateValue(words(f), e.date_format) : words(f),
        image: done && f.value && (f.type === 'signature' || f.type === 'initials') ? (f.type === 'signature' ? o.signature_png : o.initials_png || o.signature_png) : null,
      };
      // A strike-out has no words and no picture: it is the sender's line through what is printed, and everyone is shown it.
    }).filter((f: any) => f.value || f.image || f.type === 'strike'),
  };
}, 'public');

// What the locked screen says once a code is frozen. The same words whether it just happened or happened earlier.
const frozenText = (e: any) => `This access code was entered wrongly ${ACCESS_CODE_TRIES} times, so it is frozen and no longer opens the document. ${sender(e).name} has been told and can set a new code. Ask them for the new one.`;

// Only wrong tries count, in two ways. An internet address that gets it wrong a few times within a quarter of an
// hour waits (a right try in between does not wipe the count, and everyone behind the same connection shares it),
// and that touches nobody else: the right code from another connection still opens the document. After
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
  if (wait) throw bad(`That makes ${CODE_TRIES_PER_ADDRESS} wrong codes from your internet connection in a quarter of an hour. Wait ${Math.ceil(wait / 60_000)} minutes and try again, or ask ${sender(e).name} for the code: ${sender(e).email}. Nothing you filled in is lost.`, 429);
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
// The screen also says which wording of the consent text it showed ("wording", see src/lib/policy.ts), and that goes
// into the audit line, so the record names the words this person agreed to and not the words in use today. A screen
// left open across a change of wording sends the older version, and that is what is written. A call that names no
// wording we have shown is recorded as exactly that. Looked up again after the body is in: see checkedBody.
// The time zone the signer's device reports ("tz", sent with consent and with Finish). It decides which calendar day
// the date of signing is, and the certificate prints this person's local time from it. It is kept on the recipient
// and written to the audit trail the first time and whenever it changes, so the zone a date rests on is part of
// the record. A value that is not a time zone is ignored, and the sender's zone or UTC is used as before.
function noteZone(e: any, r: any, tz: any, actor: any) {
  const zone = validZone(tz);
  if (!zone || zone === r.tz || e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) return;
  run('UPDATE recipients SET tz=? WHERE id=?', zone, r.id);
  r.tz = zone;
  audit(e.id, actor, 'Time zone reported', `${r.name}: ${zone} (${clockIn(now(), zone)!.offset} at this moment), as their device says. The date this person signs on is the calendar day there.`);
}

route('POST', '/sign/:token/consent', async (c) => {
  find(c);
  const b = await c.req.json().catch(() => ({}));
  // The first member of a group who agrees takes the document on for the group, and is the recipient from here on.
  // Whoever comes second is told who has it (takeOn in groups.ts).
  const { e, r, actor } = takeOn(look(c));
  noteZone(e, r, b?.tz, actor);
  if (!r.consent_at) {
    run('UPDATE recipients SET consent_at=? WHERE id=?', now(), r.id);
    audit(e.id, actor, 'Agreed to electronic records and signatures', `${r.name}. ${isConsentVersion(b?.wording) ? consentAuditNote(b.wording) : consentAuditNote(CONSENT_VERSION, false)}`);
  }
  return { ok: true, version: e.content_version, wording: CONSENT_VERSION };
}, 'public');

route('GET', '/sign/:token/doc/:doc', (c) => {
  const { e, r } = find(c);
  assertViewable(e, r);
  const d = e.documents.find((x: any) => x.id === c.params.doc);
  if (!d) throw bad('Document not found.', 404);
  return pdfResponse(readBlob(d.sha256), d.name, true);
}, 'public');

// Asked by the signing screen when the review opens, with the answers as they stand: is there a character in this
// person's name or in what they typed that the signed PDF has no font for? They are told before they finish, with
// the field it is in, so nobody learns it from the finished document. Nothing is saved or changed by asking.
route('POST', '/sign/:token/print-check', async (c) => {
  const b = await checkedBody(c);
  const { e, r } = look(c);
  const problems: { field_id: string | null; label: string; chars: string }[] = [];
  const name = unprintable(r.name);
  if (name) problems.push({ field_id: null, label: 'Your name', chars: name });
  for (const f of e.fields.filter((f: any) => f.recipient_id === r.id && !f.readonly && ['text', 'number', 'date', 'company', 'title', 'dropdown'].includes(f.type))) {
    const chars = unprintable(str(b.values?.[f.id] ?? f.value, 4000));
    if (chars) problems.push({ field_id: f.id, label: f.label || f.type.replace('_', ' '), chars });
  }
  return { problems };
}, 'public');

// "Finish later": keep what has been filled in so far.
route('POST', '/sign/:token/save', async (c) => {
  // Looked up after the body is in, so a save that crosses Finish can never change what was just signed.
  const b = await checkedBody(c);
  const { e, r } = look(c);
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw notOpen(e, r);
  // A save from a screen that still shows the document as it was before a correction is not applied. The page
  // loads the new version, keeps the answers that still have a field, and asks the person to look again.
  const shown = shownVersion(r, b);
  if (shown != null && shown !== e.content_version) throw changedSince(e);
  applyValues(e, r, b.values || {}, false);
  // Someone typing is someone who is there: an unfinished start from a public form is not cleared under them.
  run('UPDATE recipients SET touched_at=? WHERE id=?', now(), r.id);
  // The chosen signature travels with "finish later", so picking up on another device does not mean signing again.
  if (b.signature_png !== undefined || b.initials_png !== undefined)
    run('UPDATE recipients SET signature_png=?, initials_png=? WHERE id=?', okImage(b.signature_png) ? b.signature_png : r.signature_png, okImage(b.initials_png) ? b.initials_png : r.initials_png, r.id);
}, 'public');

route('POST', '/sign/:token/upload', async (c) => {
  const { e, r } = find(c);
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw notOpen(e, r);
  rateLimit(`upload:${r.id}`, 30, 3600_000);
  const file = await storeUpload(c, null);
  // The file belongs to no account. It remembers the envelope it came in through, so deleting that envelope or its
  // account removes it also when the signer never attached it to a field.
  run('UPDATE files SET via_envelope=? WHERE id=?', e.id, file.id);
  return file;
}, 'public');

// Finish (which is also how an approver approves and a viewer confirms), decline, pass on and rename all act on the
// second look. A double tap or a retry finds the first request's work already done and is told so: 409 for a
// second Finish or Decline, 410 for a link that a reassignment has just replaced.
route('POST', '/sign/:token/complete', async (c) => {
  const body = await checkedBody(c);
  const { e, r, actor } = look(c);
  noteZone(e, r, body?.tz, actor);
  await completeRecipient(e, r, body, actor);
  const after = get('SELECT status, sheets FROM envelopes WHERE id=?', e.id);
  return { ok: true, envelope_status: after.status, impact: impactOf(after.sheets) };
}, 'public');

route('POST', '/sign/:token/decline', async (c) => {
  const body = await checkedBody(c);
  const { e, r, actor } = look(c);
  // One member of a group declines for the whole group, on record as the person who did (declineForGroup in groups.ts).
  if (r.group_name) return void (await declineForGroup(e, r, str(body.reason, 500), actor));
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
  // The answer says whether the name was changed ("applied"). A name that reads like a different person's is not:
  // it goes to the sender as a question, and "message" says so in words for the signer.
  return renameSelf(e, r, body.name, actor);
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
  // One member of a group stops their own reminders. The others keep getting theirs (groups.ts).
  if (r.member) return void muteMember(e, r, actor);
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
  // Someone who has signed, approved or confirmed can always get a copy of what they put their name to, also after
  // the envelope was voided, declined or ran out of time. That copy opens with a page saying it was not completed
  // by everyone and why. Everyone else is held to the usual rule: nothing once the envelope is closed.
  // That right is not lost when the sender changes the document after the signature and closes it before the
  // person has signed again: they signed, so they keep a copy, and its first page says what happened.
  const keeps = keepsCopy(e, r);
  // What they signed is kept exactly as they signed it. Once the envelope is closed that is the copy they get.
  // While it is still open they get it by asking for it ("?earlier=1", the link in the notice on their page), and
  // it is the only thing they can download while they wait for their turn to sign again. Without that, the
  // download is the document as it is now.
  const waits = e.status === 'sent' && r.status === 'pending' && !!r.signed_before;
  const earlier = keeps || waits || c.q.get('earlier') === '1' ? await earlierCopy(e, r, keeps) : null;
  if (earlier) return pdfResponse(earlier, `${e.subject || 'document'} (as first signed)`, c.q.get('inline') === '1');
  if (!keeps) assertViewable(e, r);
  const done = finalPdf(e);
  // Until everyone has finished, the copy a recipient downloads is made for them: it shows what their screen shows.
  return pdfResponse(done || (await buildPdf(e, false, r.id, keeps ? notCompletedNotice(e, r) : undefined)), e.subject || 'document', c.q.get('inline') === '1');
}, 'public');
