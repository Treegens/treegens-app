import { route, json, pdfResponse, type Ctx } from './router.ts';
import { all, get, run, tx, saveBlob, readBlob } from './db.ts';
import { bad, id, token, now, str, rateLimit, isEmail, baseUrl, sha256, HttpError } from './util.ts';
import { inspectPdf, imageToPdf, imagesToPdf } from './pdf.ts';
import { extractPages, textOf } from './text.ts';
import { sendMail } from './mail.ts';
import { creditsEnabled, available, isChargeable } from './credits.ts';
import {
  loadEnvelope, publicEnvelope, createEnvelope, saveDraft, copyEnvelope, sendEnvelope, voidEnvelope, remindEnvelope,
  correctRecipient, correctEnvelope, extendEnvelope, auditTrail, verifyChain, buildPdf, finalPdf, audit, signUrl, outOfSignatures,
  advance, assertMayEmail, formNeedsSignatures, type Actor,
} from './envelopes.ts';
import { hmac, safeEqual } from './util.ts';
import { bouncedBefore, bouncedRefusal, bouncedLine, mailStop, mailStopText } from './bounces.ts';
import { correctWithCheck, assertBulkChecks, bulkChecksRefusal, assertFormChecks, textsOf } from './signercode.ts';
// A recipient that is a group of people, any one of whom can act (src/server/groups.ts).
import { memberLink, memberInbox, groupReach, assertNoGroupCheck } from './groups.ts';
import { cookie, readCookie } from './auth.ts';
import { forgetEnvelopes, removeUnusedBlobs } from './routes-trust.ts';
import { sendWarnings } from './warnings.ts';
import { emailRefusal, fieldProgress } from './envelopes.ts';
import { PRICING } from '../lib/impact.ts';
import { printProblems, unprintable } from './pdftext.ts';
import { powerformIdleHours, POWERFORM_OPEN_STARTS, POWERFORM_SHARED_OPEN_STARTS, powerformSharedIdleMinutes, MAX_PHOTOS_PER_DOCUMENT } from '../lib/policy.ts';

// ---- Files ---------------------------------------------------------------------------------

export async function storeUpload(c: Ctx, accountId: string | null) {
  const form = await c.req.formData().catch(() => null);
  // Several "file" parts in one upload are the pages of one paper document, photographed one after the other. They
  // become one document, a page for each picture, in the order they were sent. That only works for pictures.
  const parts = (form?.getAll('file') || []).filter((f): f is File => typeof f !== 'string');
  const file = parts[0];
  if (!file) throw bad('Choose a file to upload.');
  if (parts.length > MAX_PHOTOS_PER_DOCUMENT) throw bad(`One document can be made from up to ${MAX_PHOTOS_PER_DOCUMENT} pictures, and this upload has ${parts.length}. Send fewer at a time and add the rest as a second document.`);
  if (parts.reduce((n, f) => n + f.size, 0) > 25_000_000) throw bad(parts.length > 1 ? 'Together these pictures are larger than 25 MB. Make them smaller or send fewer at a time, then upload again.' : 'That file is larger than 25 MB. Save it with smaller images or split it into parts, then upload again.');
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPdf && !isPng && !isJpg) throw bad('Upload a PDF, PNG or JPEG. Export Word or Google Docs files as PDF first.');
  if (parts.length > 1) {
    const pictures: { bytes: Uint8Array; png: boolean; name: string }[] = [];
    for (const f of parts) {
      const b = f === file ? bytes : new Uint8Array(await f.arrayBuffer());
      const png = b[0] === 0x89 && b[1] === 0x50;
      if (!png && !(b[0] === 0xff && b[1] === 0xd8)) throw bad(`Several files in one upload are joined into one document, a page for each picture. That works for PNG and JPEG pictures only, and "${str(f.name, 200) || 'one of the files'}" is not one. Upload PDFs one at a time. No document was made.`);
      pictures.push({ bytes: b, png, name: str(f.name, 200) });
    }
    bytes = await imagesToPdf(pictures);
  } else if (!isPdf) bytes = await imageToPdf(bytes, isPng ? 'image/png' : 'image/jpeg');
  const info = await inspectPdf(bytes);
  if (info.pages > 500) throw bad('That document has more than 500 pages. Split it into smaller documents and add them one by one.');
  const fid = id('fil');
  const name = str(file.name, 200).replace(/\.(pdf|png|jpe?g)$/i, '') || 'Document';
  // Text is kept for the sender's own search. Files uploaded by signers are not indexed.
  const read = isPdf && accountId ? await extractPages(bytes) : [];
  const text = textOf(read);
  // A page with no text is almost always a picture of a page, a scan or a photo: it cannot be searched, and a screen
  // reader cannot read it. A PNG or JPEG is always one. In a PDF every page is looked at, so a scanned page among
  // typed ones is found and named. A PDF nothing could be read from counts as a scan altogether. The answer is kept
  // with the file (scan_pages, counted from 1), so it is said again wherever the file is listed, not only here.
  // Files that signers attach are not looked at.
  const scanPages = !accountId ? [] : !isPdf || !read.some((p) => p.trim()) ? Array.from({ length: info.pages }, (_, i) => i + 1) : read.flatMap((p, i) => (p.trim() ? [] : [i + 1]));
  run('INSERT INTO files (id, account_id, sha256, name, size, pages, page_sizes, created_at, text, scan_pages) VALUES (?,?,?,?,?,?,?,?,?,?)', fid, accountId, saveBlob(bytes), name, bytes.length, info.pages, JSON.stringify(info.sizes), now(), text || null, scanPages.length ? JSON.stringify(scanPages) : null);
  return { id: fid, name, pages: info.pages, page_sizes: info.sizes, size: bytes.length, is_scan: scanPages.length > 0, scan_pages: scanPages };
}

route('POST', '/files', (c) => storeUpload(c, c.account.id));
route('GET', '/files/:id/content', (c) => {
  const f = get('SELECT * FROM files WHERE id=? AND account_id=?', c.params.id, c.account.id);
  if (!f) throw bad('File not found.', 404);
  return pdfResponse(readBlob(f.sha256), f.name, true);
});

// ---- Envelopes and templates ---------------------------------------------------------------

export function mine(c: Ctx, envelopeId: string, kind?: string, o: { removed?: boolean } = {}) {
  const e = loadEnvelope(envelopeId);
  if (!e || e.account_id !== c.account.id || (kind && e.kind !== kind)) throw bad('Envelope not found.', 404);
  // Members see what they sent. Admins see the whole account. Templates are shared with the team.
  if (e.kind === 'envelope' && !c.admin && e.sender_id !== c.user.id) throw bad('Envelope not found.', 404);
  // An envelope its sender deleted after somebody had signed is gone for the sender: no list, no search, no
  // change. Its recipients still have it, and so does the account: an admin can open it, download it and put it
  // back (the three routes that pass `removed`), and do nothing else to it until it is back.
  if (e.hidden_at && !(o.removed && c.admin)) throw bad('Envelope not found.', 404);
  return e;
}

// Everyone on the team can use every template: read it, copy it, send from it. Changing or deleting one is for
// the person it belongs to and for admins, so no member can wipe or rewrite what the whole team sends from.
function assertMayChange(c: Ctx, e: any) {
  if (e.kind !== 'template' || c.admin || e.sender_id === c.user.id) return;
  const owner = get('SELECT name FROM users WHERE id=?', e.sender_id)?.name || 'a colleague';
  throw bad(`This template belongs to ${owner}. You can use it and copy it, but only ${owner} or an admin of your team can change or delete it. To make your own version, copy it and change the copy.`, 403);
}

// The Idempotency-Key a call came with, or '' when it sent none. The key is kept with a hash of the body, so a
// repeat can be told from a different request that reuses the key by mistake.
function idemKey(c: Ctx): string {
  const key = (c.req.headers.get('idempotency-key') || '').trim();
  if (key.length > 200) throw bad('An Idempotency-Key can be up to 200 characters long. Send a shorter one.');
  return key;
}
const bodyHash = (b: any) => sha256(JSON.stringify(b));

route('GET', '/envelopes', (c) => {
  const box = c.q.get('box') || 'all';
  // box=removed: the envelopes a sender deleted from their own lists after somebody had signed (hidden_at). They
  // are in nobody's ordinary list, search, export or report. The account is a party to those documents too, so
  // its admins can still find them here, and put one back with POST /envelopes/:id/restore. Members cannot.
  const removed = box === 'removed';
  if (removed && !c.admin) throw bad('Envelopes that were removed by their sender are shown to the admins of the account only. Ask an admin of your team to look for it and put it back.', 403);
  const kind = c.q.get('kind') === 'template' && !removed ? 'template' : 'envelope';
  const hidden = removed ? 'hidden_at IS NOT NULL' : 'hidden_at IS NULL';
  const where = ['e.account_id=?', 'e.kind=?', `e.${hidden}`];
  const p: any[] = [c.account.id, kind];
  // Members see what they sent, and the folders of what they sent. Templates and their folders are the team's.
  const own = kind === 'envelope' && !c.admin;
  if (own) (where.push('e.sender_id=?'), p.push(c.user.id));
  const boxes: Record<string, string> = { drafts: "e.status='draft'", sent: "e.status!='draft'", waiting: "e.status='sent'", completed: "e.status='completed'", closed: "e.status IN ('voided','declined','expired')" };
  if (kind === 'envelope' && boxes[box]) where.push(boxes[box]);
  if (c.q.get('folder')) (where.push('e.folder=?'), p.push(c.q.get('folder')));
  if (c.admin && c.q.get('sender')) (where.push('e.sender_id=?'), p.push(c.q.get('sender')));
  const q = (c.q.get('q') || '').trim();
  // Every word that was typed has to be found somewhere: in the subject, the folder, on a person or in the name of
  // a role, in a document's name or in the words inside the documents. So "texas progress" finds the template
  // "Texas, conditional waiver, progress payment", whatever stands between the two words. What was typed as a whole
  // still finds an envelope by its id.
  const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length) {
    const word = `(e.subject LIKE ? OR e.folder LIKE ? OR EXISTS (SELECT 1 FROM recipients r WHERE r.envelope_id=e.id AND (r.name LIKE ? OR r.email LIKE ? OR r.role_name LIKE ?))
      OR EXISTS (SELECT 1 FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=e.id AND (d.name LIKE ? OR f.text LIKE ?)))`;
    where.push(`(e.id = ? OR (${words.map(() => word).join(' AND ')}))`);
    p.push(q, ...words.flatMap((w) => Array(7).fill(`%${w}%`)));
  }
  const limit = Math.min(200, Number(c.q.get('limit')) || 100);
  const rows = all(`SELECT e.id, e.kind, e.status, e.subject, e.folder, e.created_at, e.updated_at, e.sent_at, e.completed_at, e.expires_at, e.sheets, e.bulk_id, e.sender_id, u.name sender, e.hidden_at removed_at
    FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE ${where.join(' AND ')} ORDER BY e.updated_at DESC LIMIT ? OFFSET ?`, ...p, limit, Number(c.q.get('offset')) || 0);
  for (const e of rows) {
    // bounced_at, complained_at: an email to them came back for good, or they marked one as spam. The list flags both.
    e.recipients = all('SELECT id, name, email, role, role_name, status, sent_at, muted, bounced_at, complained_at FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', e.id);
    // True when the latest email to someone who has not opened it yet did not leave. Lets the list flag it.
    e.email_failed = all("SELECT m.status FROM emails m WHERE m.envelope_id=? AND m.id IN (SELECT MAX(id) FROM emails WHERE envelope_id=? GROUP BY COALESCE(recipient_id, to_email))", e.id, e.id).some((m) => m.status === 'failed');
    e.pages = get('SELECT COALESCE(SUM(f.pages),0) n FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=?', e.id).n;
  }
  // Only the folders of what this person can see: a folder name such as "Layoffs 2026" says something by itself.
  const folders = all(`SELECT DISTINCT folder FROM envelopes WHERE account_id=? AND kind=? AND ${hidden} AND folder IS NOT NULL AND folder != ''${own ? ' AND sender_id=?' : ''}`, ...(own ? [c.account.id, kind, c.user.id] : [c.account.id, kind])).map((r) => r.folder);
  // Admins can narrow the list to one person's envelopes.
  const senders = c.admin ? all(`SELECT DISTINCT u.id, u.name FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE e.account_id=? AND e.kind=? AND e.${hidden} ORDER BY u.name`, c.account.id, kind) : [];
  // On a template, may_change says whether this person may change or delete it (their own, or they are an admin).
  if (kind === 'template') for (const e of rows) e.may_change = c.admin || e.sender_id === c.user.id;
  // For admins: how many envelopes in the account were removed by their sender, so the list can offer to show them.
  const removedCount = c.admin && kind === 'envelope' ? get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND hidden_at IS NOT NULL", c.account.id).n : undefined;
  return { envelopes: rows, folders, senders, ...(removedCount === undefined ? {} : { removed: removedCount }) };
});

// Documents addressed to the signed-in user, from any sender.
route('GET', '/inbox', (c) => {
  if (!c.user.email_verified) return { needs_verification: true, items: [] };
  return {
    // First what is waiting for a group this person is a member of, each with their own link (memberInbox in groups.ts).
    items: [...memberInbox(c.user.email), ...all(`SELECT e.id, e.subject, e.status, e.sent_at, e.completed_at, u.name sender, r.role, r.status my_status, r.token
      FROM recipients r JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id
      WHERE r.email=? AND e.kind='envelope' AND e.status!='draft' AND r.status!='pending' AND r.role!='inperson' ORDER BY e.updated_at DESC LIMIT 100`, c.user.email)],
  };
});

route('POST', '/envelopes', async (c) => {
  const b = await c.body();
  // A kind we do not have is a mistake to point out. A misspelled "template" must never become an envelope.
  if (b.kind != null && b.kind !== '' && b.kind !== 'template' && b.kind !== 'envelope')
    throw bad(`"kind" is "${str(b.kind, 40)}", which does not exist. Use "envelope" or "template", or leave it out for an envelope. Nothing was created.`);
  const kind = b.kind === 'template' ? 'template' : 'envelope';
  // A retried or timed-out call with the same Idempotency-Key gets the envelope the first call made instead of
  // sending twice. A key belongs to whoever used it (a person, or the owner of the API key), so two members of a
  // team who pick the same text, say an order number, never see each other's envelope. The same key with a different
  // body is refused, because answering with the first envelope would hide that the new one was never made.
  const idem = idemKey(c);
  if (idem) {
    const done = get('SELECT envelope_id, request_hash FROM idempotency_keys WHERE account_id=? AND user_id=? AND key=?', c.account.id, c.user.id, idem);
    let prior: any = null;
    try {
      prior = done && mine(c, done.envelope_id);
    } catch {
      // The envelope has passed to someone else since. The key starts afresh below.
    }
    if (prior && done.request_hash && done.request_hash !== bodyHash(b))
      throw bad(`This Idempotency-Key was already used for a different request, which made envelope ${prior.id}. Nothing new was created. Repeat a call with its own key, and use a new key for each new envelope.`, 409);
    if (prior) return new Response(JSON.stringify({ envelope: publicEnvelope(prior) }), { headers: { 'content-type': 'application/json; charset=utf-8', 'idempotent-replay': 'true' } });
  }
  let eid: string;
  if (b.template_id) {
    const tpl = mine(c, str(b.template_id), 'template');
    eid = copyEnvelope(tpl, { accountId: c.account.id, senderId: c.user.id, kind, subject: b.subject, message: b.message, fill: b.recipients && !Array.isArray(b.recipients) ? b.recipients : undefined });
  } else {
    eid = createEnvelope(c.account, c.user.id, kind, b);
    try {
      // Anything the body says about the envelope goes through the same checks as a save, so a setting that cannot
      // be carried out (a date format that does not exist, say) is refused here too and never dropped.
      if (['documents', 'recipients', 'fields', 'ordered', 'date_format', 'reminder_days', 'expire_days'].some((k) => b[k] != null && b[k] !== '')) saveDraft(loadEnvelope(eid), b, c.account.id);
    } catch (e) {
      // A request that is turned down (a field for a recipient who is not on it, say) leaves no empty draft behind.
      run('DELETE FROM envelopes WHERE id=?', eid);
      throw e;
    }
  }
  // The key row goes when its envelope goes (the database deletes it with the envelope), so a key never points at
  // nothing. REPLACE covers the one case left: a key whose envelope now belongs to somebody else.
  if (idem) run('INSERT OR REPLACE INTO idempotency_keys (account_id, user_id, key, envelope_id, request_hash, at) VALUES (?,?,?,?,?,?)', c.account.id, c.user.id, idem, eid, bodyHash(b), now());
  if (b.send && kind === 'envelope') {
    try {
      // "send_anyway": the caller has seen that an address on it bounced before, and wants it sent all the same.
      await sendEnvelope(eid, c.actor, { anyway: b.send_anyway === true });
    } catch (e) {
      // "Create and send" either sends or leaves nothing behind. No stray drafts after a refusal, and the key is
      // free again, so the same call can be repeated once the reason for the refusal is fixed.
      run('DELETE FROM envelopes WHERE id=?', eid);
      throw e;
    }
  }
  const made = loadEnvelope(eid);
  // What was sent goes out with what the check before sending found. It is a list to read, never a refusal.
  return { envelope: publicEnvelope(made), ...(b.send && kind === 'envelope' ? { warnings: sendWarnings(made) } : {}) };
});

route('GET', '/envelopes/:id', (c) => {
  // An admin can still open an envelope its sender removed from their lists. The answer says so in removed_at.
  const e = mine(c, c.params.id, undefined, { removed: true });
  // Whether each email actually left, so "I never got it" can be answered without guessing.
  // An email the mail server would not take is tried again by the timer: tries, when the latest one was, and when the
  // next one is due (empty once it left, or when nobody tries any more).
  // What the mail provider said afterwards, on a server that is told (MAIL_EVENTS_TOKEN): delivered_at when the
  // recipient's mail server took it, bounced_at with bounce_kind ('hard' or 'soft') and bounce_reason when it came
  // back, complained_at when the reader marked it as spam. All empty on a server that only knows the hand-over.
  const deliveries = all('SELECT to_email, recipient_id, subject, status, error, at, tries, tried_at, next_try_at, delivered_at, bounced_at, bounce_kind, bounce_reason, complained_at FROM emails WHERE envelope_id=? ORDER BY id DESC LIMIT 60', e.id);
  // How far each signer has got, so the sender can help someone who is stuck without being able to sign for them.
  // Counted the way the signer's own screen counts: a group of radio buttons is one thing to do, not one for each
  // button, so sender and signer see the same "N of M".
  const env = publicEnvelope(e);
  // `ready` marks someone who filled in everything required and has not pressed Finish (fieldProgress in envelopes.ts,
  // the same count the reminder to that person goes by).
  for (const r of env.recipients) r.progress = fieldProgress(e, r);
  // Names and wording in a script the signed PDF has no font for, said here so the sender hears it from the
  // envelope page and not from the finished document. Each entry says where the text stands and which characters.
  const print_problems = e.status === 'completed' && e.final_sha256 ? [] : printProblems(e, get('SELECT name FROM users WHERE id=?', e.sender_id));
  // texts: what became of every text message about this envelope, like deliveries for email. Numbers are masked.
  return { envelope: env, audit: auditTrail(e.id), chain: verifyChain(e.id), deliveries, texts: textsOf(e.id), print_problems, removed_at: e.hidden_at || null };
});

// The same check for text that is not saved yet: the editor asks before sending, with what stands on screen.
// Answers, for each text that holds a character the signed PDF cannot print, where it is and which characters.
route('POST', '/print-check', async (c) => {
  const b = await c.body();
  if (!Array.isArray(b.texts)) throw bad('"texts" must be a list of { "where": "...", "text": "..." }.');
  const problems: { where: string; chars: string }[] = [];
  for (const t of b.texts.slice(0, 3000)) {
    const chars = unprintable(str(t?.text, 4000));
    if (chars) problems.push({ where: str(t?.where, 200), chars });
  }
  return { problems };
});

// Reading a request body means waiting, and while a handler waits another request can send, sign, void or complete
// the same envelope. So a handler that changes what an envelope holds, its deadline or its status reads the body
// first and looks the envelope up after it, with nothing waited for between that look and the change. One that
// looked first would act on a copy that is out of date.

// Drafts are simply saved. An envelope that is already out is corrected in place: no void, no resend, no extra count.
route('PUT', '/envelopes/:id', async (c) => {
  const b = await c.body();
  const e = mine(c, c.params.id);
  assertMayChange(c, e);
  // A body that carries the edit_version its sender loaded is refused with 409 when someone has saved since, so a
  // save from an older copy never wipes a colleague's work. A body without it is saved as it always was.
  if (e.kind === 'envelope' && e.status === 'sent') await correctEnvelope(e, b, c.account.id, c.actor);
  else saveDraft(e, b, c.account.id, c.actor);
  return { envelope: publicEnvelope(loadEnvelope(e.id)) };
});

route('POST', '/envelopes/:id/extend', async (c) => {
  const { days } = await c.body();
  return { expires_at: await extendEnvelope(mine(c, c.params.id, 'envelope'), days, c.actor) };
});

route('PATCH', '/envelopes/:id', async (c) => {
  const e = mine(c, c.params.id);
  assertMayChange(c, e);
  const b = await c.body();
  if ('folder' in b) run('UPDATE envelopes SET folder=? WHERE id=?', str(b.folder, 80).trim() || null, e.id);
});

// Deleting removes a draft, a template or a closed envelope for good, with its audit trail, our copies of its
// emails and the files signers attached. An envelope somebody has signed is different, because it is not only the
// sender's: whoever signed was promised a copy of what they signed for as long as the sender keeps the account.
// That is every completed envelope, and also one that was voided, declined or ran out of time after someone had
// already finished their part. Deleting one of those takes it out of the sender's lists, search, export and
// reports, and every recipient's link, download and "sent to me" list keep working. It is removed for good when
// the account is. Until then the admins of the account can still find it (GET /envelopes?box=removed), open and
// download it, and put it back (POST /envelopes/:id/restore): the account is a party to the document as well.
route('DELETE', '/envelopes/:id', (c) => {
  const e = mine(c, c.params.id);
  assertMayChange(c, e);
  if (e.status === 'sent') throw bad('Void this envelope before deleting it.');
  if (e.kind === 'template' && get('SELECT 1 x FROM powerforms WHERE template_id=?', e.id)) throw bad('A PowerForm still uses this template. Delete the PowerForm first.');
  // Someone who signed and was then asked to sign again (signed_before) signed too, and keeps their copy as well.
  const signed = e.kind === 'envelope' && e.status !== 'draft' && e.recipients.some((r: any) => (r.status === 'completed' || r.signed_before) && ['signer', 'inperson', 'approver'].includes(r.role));
  if (e.kind === 'envelope' && (e.status === 'completed' || signed)) {
    run('UPDATE envelopes SET hidden_at=? WHERE id=?', now(), e.id);
    audit(e.id, c.actor, 'Removed from the sender\'s lists', 'The sender deleted this envelope from their account. Everyone on it keeps their link and their copy.');
    return { ok: true, kept_for_recipients: true };
  }
  const shas = tx(() => {
    const s = forgetEnvelopes([e.id]);
    run('DELETE FROM envelopes WHERE id=?', e.id);
    return s;
  });
  // The uploaded documents stay: they are files of the account and other envelopes may use them.
  removeUnusedBlobs(shas);
});

// Puts an envelope its sender removed from their lists back where it was: in the sender's lists, the search, the
// export and the reports. For admins, because the member who removed it cannot see it any more and the account
// must not be the one party to a signed document that cannot get at it. One statement decides, so two calls at the
// same moment leave one line in the record.
route('POST', '/envelopes/:id/restore', (c) => {
  const e = mine(c, c.params.id, 'envelope', { removed: true });
  if (run('UPDATE envelopes SET hidden_at=NULL WHERE id=? AND hidden_at IS NOT NULL', e.id).changes)
    audit(e.id, c.actor, 'Put back in the sender\'s lists', 'An admin of the account put this envelope back after it had been removed from the sender\'s lists.');
  return { envelope: publicEnvelope(loadEnvelope(e.id)) };
}, 'admin');

// A send to an address at which an email of this account came back for good in the last weeks is answered 409 with
// "code": "bounced_address" and which address, when and why. Nothing was sent. The same call with a body of
// { "send_anyway": true } sends it. The body is optional: without one the call is what it always was.
route('POST', '/envelopes/:id/send', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const e = mine(c, c.params.id, 'envelope');
  await sendEnvelope(e.id, c.actor, { anyway: b?.send_anyway === true });
  const sent = loadEnvelope(e.id);
  return { envelope: publicEnvelope(sent), warnings: sendWarnings(sent) };
});

// The check before sending, for the review step of the editor and for anyone who wants to look before they send:
// words in the subject, a document's name or a document's text that name a kind of document which often needs paper,
// a witness, a notary or a qualified signature. The same list comes back with the answer to sending. It only ever
// warns: `blocks` is always false, and it is there so that no integration has to guess.
route('GET', '/envelopes/:id/warnings', (c) => ({ warnings: sendWarnings(mine(c, c.params.id)), blocks: false }));

route('POST', '/envelopes/:id/void', async (c) => {
  // Two Void requests at the same moment, or a void that crosses the last signature: the second one sees the
  // envelope as it now is and is refused, instead of voiding (and emailing everyone about) a copy from before.
  const reason = str((await c.body()).reason, 500);
  await voidEnvelope(mine(c, c.params.id, 'envelope'), reason, c.actor);
});

route('POST', '/envelopes/:id/remind', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const e = mine(c, c.params.id, 'envelope');
  // No reminder goes to someone whose last email came back, or who marked one as spam (see bounces.ts). Asked for
  // one such person, the call is refused in words that say why and what to do. Asked for everyone, the others are
  // reminded and the answer names who was left out and why, so nobody is dropped without the sender knowing.
  const waiting = e.status === 'sent' ? e.recipients.filter((r: any) => r.status === 'sent' || r.status === 'viewed') : [];
  const one = b?.recipient_id ? waiting.find((r: any) => r.id === str(b.recipient_id)) : null;
  if (one && mailStop(one)) throw bad(mailStopText(one), 409, { code: mailStop(one) === 'complaint' ? 'marked_as_spam' : 'email_bounced' });
  const not_reminded = b?.recipient_id ? [] : waiting.filter((r: any) => mailStop(r)).map((r: any) => ({ recipient_id: r.id, name: r.name, why: mailStop(r) === 'complaint' ? 'marked_as_spam' : 'email_bounced' }));
  return { reminded: await remindEnvelope(e, c.actor, b?.recipient_id ? str(b.recipient_id) : undefined), not_reminded };
});

route('POST', '/envelopes/:id/correct', async (c) => {
  const b = await c.body();
  const e = mine(c, c.params.id, 'envelope');
  // A one-time code or a text message goes to one person, so neither can be asked of a group (groups.ts).
  assertNoGroupCheck(e, str(b.recipient_id), b);
  // With their check too ("verify", "phone", "text_link"): correctWithCheck does all of the call or none of it.
  await correctWithCheck(e, str(b.recipient_id), b, c.actor);
});

route('POST', '/envelopes/:id/clone', async (c) => {
  const e = mine(c, c.params.id);
  const b = await c.req.json().catch(() => ({}));
  if (b?.kind != null && b.kind !== '' && b.kind !== 'template' && b.kind !== 'envelope')
    throw bad(`"kind" is "${str(b.kind, 40)}", which does not exist. Use "envelope" or "template", or leave it out to copy it as what it is. Nothing was copied.`);
  const kind = b?.kind === 'template' || (e.kind === 'template' && b?.kind !== 'envelope') ? 'template' : 'envelope';
  const eid = copyEnvelope(e, { accountId: c.account.id, senderId: c.user.id, kind, subject: kind === e.kind ? `${e.subject} (copy)`.trim() : e.subject });
  return { id: eid };
});

// Embedded signing: get a signing link for one recipient to open inside your own flow.
route('POST', '/envelopes/:id/recipient-view', async (c) => {
  const body = await c.body();
  const rid = str(body.recipient_id);
  const e = mine(c, c.params.id, 'envelope');
  // In a group every member has a link of their own, and "member_id" says whose is wanted (memberLink in groups.ts).
  const theirs = memberLink(e, rid, body.member_id, c.actor);
  if (theirs) return theirs;
  const r = e.recipients.find((x: any) => x.id === rid);
  if (!r || !r.token) throw bad('Recipient not found, or the envelope has not been sent.', 404);
  // Handing out the link belongs in the record, but one line a day says it. An integration that asks for the link
  // on every page view must not fill the audit trail, which is printed in full on the certificate. A link that
  // replaced an earlier one (a corrected address, a reassignment) is a new link and gets its own line. One
  // statement decides, so two requests at the same moment still leave one line.
  const first = run(`UPDATE recipients SET link_issued_at=? WHERE id=? AND (link_issued_at IS NULL OR link_issued_at < ?
    OR link_issued_at <= COALESCE((SELECT MAX(retired_at) FROM retired_tokens WHERE recipient_id=recipients.id), ''))`,
    now(), r.id, new Date(Date.now() - 864e5).toISOString()).changes;
  if (first) audit(e.id, c.actor, 'Signing link issued', `${r.name} <${r.email}>`);
  return { url: signUrl(r) };
});

route('GET', '/envelopes/:id/download', async (c) => {
  const e = mine(c, c.params.id, undefined, { removed: true });
  if (!e.documents.length) throw bad('This envelope has no documents yet.');
  const done = finalPdf(e);
  return pdfResponse(done || (await buildPdf(e, false)), e.subject || 'document', c.q.get('inline') === '1');
});

// ---- Bulk send -----------------------------------------------------------------------------

// Like envelopes: members see the batches they sent, admins see every batch in the account. A completed envelope
// its sender deleted is not counted.
route('GET', '/bulk', (c) => ({
  batches: all(`SELECT b.id, b.name, b.total, b.created_at, t.subject template,
      (SELECT COUNT(*) FROM envelopes e WHERE e.bulk_id=b.id AND e.hidden_at IS NULL) created, (SELECT COUNT(*) FROM envelopes e WHERE e.bulk_id=b.id AND e.status='completed' AND e.hidden_at IS NULL) completed
    FROM bulk_batches b LEFT JOIN envelopes t ON t.id=b.template_id WHERE b.account_id=?${c.admin ? '' : ' AND b.sender_id=?'} ORDER BY b.created_at DESC LIMIT 50`, ...(c.admin ? [c.account.id] : [c.account.id, c.user.id])),
}));

// Batches that a request in this process is sending right now. A repeat of the call never sends alongside it: it is
// told how far the first has got. The list lives in memory, so it is empty again after a restart, and that is the
// one moment a batch can be left half sent with nobody working on it. A repeat with the same key then finishes it.
const sendingNow: Set<string> = ((globalThis as any).__tsbulk ??= new Set());

// Why the rows of a batch that are left are not sent: the person the batch was started by no longer holds it (it
// was handed over), or is no longer a member of the account. '' while they still are both.
function notTheirsAnyMore(b: { id: string; sender_id: string }): string {
  if (get('SELECT 1 x FROM bulk_batches b JOIN memberships m ON m.account_id=b.account_id AND m.user_id=b.sender_id WHERE b.id=? AND b.sender_id=?', b.id, b.sender_id)) return '';
  const heir = get('SELECT u.name FROM bulk_batches b JOIN users u ON u.id=b.sender_id WHERE b.id=? AND b.sender_id!=?', b.id, b.sender_id)?.name;
  return `Not sent. The person who started this bulk send was no longer on the team when this row's turn came, and nothing goes out in the name of someone who has left.${heir ? ` The batch now belongs to ${heir}, who can send this row in a new bulk send from the same template.` : ''}`;
}

// Sends every row of a batch that has not been tried yet, one after another, and writes each outcome to the batch
// record as it happens. It can be run again on a batch that stopped half way: a row that went out is never sent
// again, a copy that was made but not sent is sent, and the rest are made and sent.
// `anyway`: the call said "send_anyway", so a row to an address that bounced before goes out too. Without it such
// a row is not sent and says why (it can only happen when the address came back while this batch was going out).
async function sendBatch(b: { id: string; account_id: string; sender_id: string; template_id: string }, actor: Actor, anyway = false) {
  sendingNow.add(b.id);
  try {
    // A draft in the batch that no row points at was made in the instant before the process stopped. Its row is
    // still open and makes a new copy, so the old one goes.
    run("DELETE FROM envelopes WHERE bulk_id=? AND status='draft' AND id NOT IN (SELECT envelope_id FROM bulk_rows WHERE bulk_id=? AND envelope_id IS NOT NULL)", b.id, b.id);
    const tpl = loadEnvelope(b.template_id);
    for (const row of all('SELECT position, fill, envelope_id FROM bulk_rows WHERE bulk_id=? AND sent_at IS NULL AND error IS NULL ORDER BY position', b.id)) {
      const set = (what: string, ...p: any[]) => run(`UPDATE bulk_rows SET ${what} WHERE bulk_id=? AND position=?`, ...p, b.id, row.position);
      try {
        // Asked again before every row, with nothing waited for between this look and the copy below: a bulk send
        // takes as long as the mail server needs, and in that time the person who started it can be removed from
        // the team, leave it, or have their login deleted. From that moment nothing more goes out on their say-so
        // and no envelope is made in their name. The batch has passed to another member by then (handOver), and
        // every row that is left says why it was not sent.
        const stopped = notTheirsAnyMore(b);
        if (stopped) throw bad(stopped);
        let eid: string = row.envelope_id;
        if (!eid) {
          if (!tpl || tpl.kind !== 'template') throw bad('The template was deleted before this row could be sent.');
          eid = copyEnvelope(tpl, { accountId: b.account_id, senderId: b.sender_id, kind: 'envelope', fill: JSON.parse(row.fill), extra: { bulk_id: b.id } });
          set('envelope_id=?', eid);
        }
        const status = get('SELECT status FROM envelopes WHERE id=?', eid)?.status;
        if (!status) throw bad('The envelope for this row was deleted before it was sent.');
        // No longer a draft means the process stopped just after sending it. advance() only makes sure whoever is
        // next has been asked. Nobody who was already asked is asked again.
        if (status === 'draft') await sendEnvelope(eid, actor, { anyway });
        else await advance(eid);
        set('sent_at=?, fill=NULL', now());
      } catch (e: any) {
        if (!(e instanceof HttpError)) console.error('[bulk]', b.id, row.position, e);
        set('error=?', e instanceof HttpError ? e.message : 'Something went wrong on our side while sending this row. If it was saved as a draft in the batch, open it and send it from there.');
      }
    }
  } finally {
    sendingNow.delete(b.id);
  }
}

// What a batch has done so far, read from its record: the answer to the call that made it and to every repeat.
function batchResult(bulkId: string) {
  const results: any[] = all('SELECT envelope_id, sent_at, error FROM bulk_rows WHERE bulk_id=? ORDER BY position', bulkId)
    .map((r) => (r.sent_at ? { ok: true, id: r.envelope_id } : r.error ? { ok: false, error: r.error } : { ok: false, pending: true }));
  // Every row is a copy of one template, so what the check before sending finds is said once for the batch.
  const tpl = get('SELECT e.id, e.subject FROM bulk_batches b JOIN envelopes e ON e.id=b.template_id WHERE b.id=?', bulkId);
  return { id: bulkId, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => r.error), pending: results.filter((r) => r.pending).length, results, warnings: tpl ? sendWarnings(tpl) : [] };
}

// What a batch holds, counted in one place for the send itself and for the question the bulk page asks before the
// Send button (POST /bulk/check): one signature for each person in the template who signs and is not the sender
// signing under their own name, times the rows. An open role is always somebody else.
function batchNeeds(c: Ctx, tpl: any, rows: number): { perRow: number; need: number; have: number } {
  const perRow = tpl.recipients.filter((r: any) => isChargeable({ role: r.role, email: r.email || 'someone-else', name: r.name }, c.user)).length;
  return { perRow, need: perRow * rows, have: available(c.account.id) };
}

// "What would this batch hold, and would it go out?" Asked by the bulk page while the list is being put together,
// with the body POST /bulk takes, so the price is on screen before the Send button and not in the refusal after it.
// It writes nothing and sends nothing. The numbers are the ones POST /bulk is held to a moment later:
//   need     signatures the batch holds, one for each person who signs (signers_per_row times rows)
//   have     signatures free to send with now (the balance without what is held for envelopes that are out)
//   short    how many are missing. A batch only goes out when this is 0
//   cost     what the missing ones cost on this account's plan. On the monthly plan that is a top-up. On the free
//            plan a top-up needs the monthly plan first, so it is the plan's payment (which brings the month's
//            signatures) plus a top-up for the rest
//   refusal  what POST /bulk would answer because of a pause, the filter for fake notices or the daily limit on
//            people newly emailed, with the same words. null when none of them stands in the way
// counted is false when no payment provider is connected: nothing is counted then, and every batch goes out.
route('POST', '/bulk/check', async (c) => {
  const b = await c.body();
  const tpl = mine(c, str(b.template_id), 'template');
  const rows: any[] = Array.isArray(b.rows) ? b.rows.slice(0, 500) : [];
  const open = tpl.recipients.filter((r: any) => !r.email && !r.group_name); // a group is filled in by its members, not by a row or a visitor
  const counted = creditsEnabled();
  const { perRow, need, have } = counted ? batchNeeds(c, tpl, rows.length) : { perRow: 0, need: 0, have: 0 };
  const short = Math.max(0, need - Math.max(0, have));
  const onPlan = c.account.plan === 'grove';
  const planSignatures = onPlan ? 0 : Math.min(short, PRICING.monthlySignatures);
  const topUp = short - planSignatures;
  const reach = [...tpl.recipients.map((r: any) => r.email), ...groupReach(tpl), ...rows.flatMap((row) => open.map((r: any) => str(row?.[r.role_name || r.id]?.email).trim()))].filter(Boolean);
  // bulkChecksRefusal: a row without the mobile number its role needs, or more text messages than the account may send today.
  const refusal = rows.length ? emailRefusal({ ...tpl, sender_id: c.user.id }, reach) || bulkChecksRefusal(tpl, rows, open) : null;
  return {
    counted, rows: rows.length, signers_per_row: perRow, need, have: Math.max(0, have), short, plan: c.account.plan,
    cost: counted && short > 0 ? { usd: (onPlan ? 0 : PRICING.monthlyUsd) + topUp * PRICING.topUpUsd, plan_usd: onPlan ? 0 : PRICING.monthlyUsd, plan_signatures: onPlan ? 0 : PRICING.monthlySignatures, top_up: topUp, top_up_usd: topUp * PRICING.topUpUsd } : null,
    refusal: refusal ? { status: refusal.status, message: refusal.message } : null,
    // Addresses in this list at which an email of the account came back for good in the last weeks, each with the
    // day and why. Not a refusal: POST /bulk sends to them when it carries "send_anyway": true, and says so otherwise.
    bounced: rows.length ? bouncedBefore(c.account.id, reach).map((x) => ({ email: x.email, bounced_at: x.at, reason: x.reason, line: bouncedLine(x) })) : [],
  };
});

route('POST', '/bulk', async (c) => {
  const b = await c.body();
  // A bulk send takes as long as the mail server needs for every row, which is when a caller gives up and tries
  // again. With an Idempotency-Key the repeat gets the batch the first call made and nobody is sent a second copy.
  // While the first call is still sending, the repeat is answered at once with how far it has got (202). If the
  // process stopped half way, the repeat sends the rows that are left. Like on POST /envelopes, the key belongs to
  // whoever used it, and the same key with a different body is refused.
  const idem = idemKey(c);
  const prior = idem ? get('SELECT * FROM bulk_batches WHERE account_id=? AND sender_id=? AND idem_key=?', c.account.id, c.user.id, idem) : null;
  if (prior) {
    if (prior.request_hash !== bodyHash(b))
      throw bad(`This Idempotency-Key was already used for a different bulk send, which made batch ${prior.id}. Nothing new was sent. Repeat a call with its own key, and use a new key for each new list.`, 409);
    const busy = sendingNow.has(prior.id);
    if (!busy) await sendBatch(prior, c.actor, b.send_anyway === true);
    return json(batchResult(prior.id), busy ? 202 : 200, { 'idempotent-replay': 'true' });
  }
  const tpl = mine(c, str(b.template_id), 'template');
  const rows: any[] = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) throw bad('Add at least one row of recipients.');
  if (rows.length > 500) throw bad('Send up to 500 envelopes per batch.');
  const open = tpl.recipients.filter((r: any) => !r.email && !r.group_name); // a group is filled in by its members, not by a row or a visitor
  rows.forEach((row, i) => {
    for (const r of open) {
      const v = row?.[r.role_name || r.id];
      if (!v || !str(v.name).trim() || !isEmail(str(v.email).trim())) throw bad(`Row ${i + 1}: "${r.role_name || 'Recipient'}" needs a name and a valid email.`);
    }
  });
  // A role the template checks or reaches by text message needs a mobile number ("phone") in every row, and the
  // account must be allowed that many texts today. Refused for the whole batch, like everything below.
  assertBulkChecks(tpl, rows, open);
  // A pause, the fake-notice filter and the daily limit refuse the whole batch before anything is written, instead of
  // failing it row by row. Every address in every row counts as a person emailed.
  assertMayEmail({ ...tpl, sender_id: c.user.id }, [...tpl.recipients.map((r: any) => r.email), ...groupReach(tpl), ...rows.flatMap((row) => open.map((r: any) => str(row[r.role_name || r.id].email).trim()))].filter(Boolean));
  // An address in the list at which an email of this account came back for good in the last weeks: the whole batch
  // waits until the sender has seen which and why, and goes out when the same call carries "send_anyway": true.
  const dead = b.send_anyway === true ? [] : bouncedBefore(c.account.id, [...tpl.recipients.map((r: any) => r.email), ...rows.flatMap((row) => open.map((r: any) => str(row[r.role_name || r.id].email).trim()))]);
  if (dead.length) {
    const no = bouncedRefusal(dead, 'Nothing was sent, to anyone in the list');
    throw bad(no.message, 409, no.data);
  }
  // Check the whole batch against the balance first, so it never stops half way through.
  if (creditsEnabled()) {
    const { perRow, need, have } = batchNeeds(c, tpl, rows.length);
    // A batch that needs none (approvals, viewers, copies) goes out whatever the balance.
    if (perRow > 0 && need > have) throw bad(outOfSignatures(c.account, need, have), 402);
  }
  // The batch and every one of its rows are written down together before anything is sent, so the record always
  // says what was asked for and how far it got. Nothing is waited for between the key lookup above and this.
  const made = { id: id('blk'), account_id: c.account.id, sender_id: c.user.id, template_id: tpl.id };
  tx(() => {
    run('INSERT INTO bulk_batches (id, account_id, sender_id, template_id, name, total, created_at, idem_key, request_hash) VALUES (?,?,?,?,?,?,?,?,?)',
      made.id, made.account_id, made.sender_id, tpl.id, str(b.name, 120) || tpl.subject || 'Bulk send', rows.length, now(), idem || null, bodyHash(b));
    rows.forEach((row, i) => run('INSERT INTO bulk_rows (bulk_id, account_id, position, fill) VALUES (?,?,?,?)', made.id, made.account_id, i, JSON.stringify(row)));
  });
  await sendBatch(made, c.actor, b.send_anyway === true);
  return batchResult(made.id);
});

// A batch is one thing: see everyone's status, nudge the stragglers, or void what is still open, in one go.
function batch(c: Ctx, bulkId: string) {
  const b = get('SELECT * FROM bulk_batches WHERE id=? AND account_id=?', bulkId, c.account.id);
  if (!b || (!c.admin && b.sender_id !== c.user.id)) throw bad('Batch not found.', 404);
  return b;
}
route('GET', '/bulk/:id', (c) => {
  const { idem_key: _k, request_hash: _h, ...b } = batch(c, c.params.id);
  const envelopes = all('SELECT id, status, subject, sent_at, completed_at FROM envelopes WHERE bulk_id=? AND hidden_at IS NULL ORDER BY created_at', b.id);
  for (const e of envelopes) e.recipients = all('SELECT name, email, role, status, viewed_at, completed_at FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', e.id);
  // The record row by row: which rows went out, which could not and why, and which have not been tried yet. The row
  // itself (names and emails as submitted) is shown until it is sent. After that its envelope has them.
  // An envelope of the batch that its sender removed from their lists is not among `envelopes`. Its row says so
  // (removed), and `removed` counts them, so the numbers on the page add up to the rows that were sent.
  const gone = new Set(all('SELECT id FROM envelopes WHERE bulk_id=? AND hidden_at IS NOT NULL', b.id).map((e) => e.id as string));
  const rows = all('SELECT position, fill, envelope_id, sent_at, error FROM bulk_rows WHERE bulk_id=? ORDER BY position', b.id)
    .map((r) => ({ position: r.position, status: r.sent_at ? 'sent' : r.error ? 'failed' : 'pending', envelope_id: r.envelope_id, sent_at: r.sent_at, error: r.error, row: r.fill ? JSON.parse(r.fill) : null, ...(gone.has(r.envelope_id) ? { removed: true } : {}) }));
  return { batch: b, envelopes, rows, removed: gone.size, sending: sendingNow.has(b.id) };
});
// The remind and the void below work through the envelopes that are out for signature one at a time, and each one's
// emails take a while. In that while a signer can finish or decline one further down the list, or a second call can
// get to it first. So every envelope is read again when its turn comes, and one that is no longer out is passed
// over. Stopping at it would leave the rest of the list untouched with part of it already emailed. Nothing is
// waited for between that look and the change, so no envelope is acted on from a copy that is out of date.
route('POST', '/bulk/:id/remind', async (c) => {
  const b = batch(c, c.params.id);
  let reminded = 0;
  for (const row of all("SELECT id FROM envelopes WHERE bulk_id=? AND status='sent'", b.id)) {
    const e = loadEnvelope(row.id);
    if (e?.status === 'sent') reminded += await remindEnvelope(e, c.actor);
  }
  return { reminded };
});
route('POST', '/bulk/:id/void', async (c) => {
  const b = batch(c, c.params.id);
  const reason = str((await c.body()).reason, 500);
  if (!reason.trim()) throw bad('Give a reason for voiding. Recipients will see it.');
  // While the batch is still going out, voiding would only catch the part already sent and the rest would follow.
  if (sendingNow.has(b.id)) throw bad('This batch is still being sent. Wait until it has finished, then void it: that way nobody is missed.', 409);
  // skipped: envelopes that were open when the call began and had closed by their turn. They stay as they are.
  let voided = 0;
  let skipped = 0;
  for (const row of all("SELECT id FROM envelopes WHERE bulk_id=? AND status='sent'", b.id)) {
    const e = loadEnvelope(row.id);
    if (e?.status !== 'sent') {
      skipped++;
      continue;
    }
    await voidEnvelope(e, reason, c.actor);
    voided++;
  }
  return { voided, skipped };
});

// ---- PowerForms: a public link anyone can use to sign a template ---------------------------

function powerformTemplate(templateId: string) {
  const tpl = loadEnvelope(templateId);
  if (!tpl || tpl.kind !== 'template') throw bad('Template not found.', 404);
  const open = tpl.recipients.filter((r: any) => !r.email && !r.group_name); // a group is filled in by its members, not by a row or a visitor
  if (open.length !== 1 || !['signer', 'approver'].includes(open[0].role)) throw bad('A PowerForm needs a template with exactly one open signer role. Give every other recipient a name and email in the template.');
  return { tpl, open: open[0] };
}

// A public form sends in the name of the person its template belongs to, uses that account's signatures, and its
// template cannot be deleted while the form exists. So publishing a template as a form, and pausing, changing or
// deleting the form, is for the people who may change the template: the person it belongs to, and admins. Everyone
// on the team still sees the forms and can hand out their links.
const mayRunForm = (c: Ctx, templateOwner: string | null | undefined) => c.admin || (!!templateOwner && templateOwner === c.user.id);
function assertMayRunForm(c: Ctx, tpl: any, doing: string) {
  if (mayRunForm(c, tpl?.sender_id)) return;
  const owner = (tpl && get('SELECT name FROM users WHERE id=?', tpl.sender_id)?.name) || 'a colleague';
  throw bad(`This template belongs to ${owner}, so only ${owner} or an admin of your team can ${doing}. Nothing was changed. To have a PowerForm of your own, copy the template and make the PowerForm from your copy.`, 403);
}
// The form a call names, for someone who may change it. The same answer for a form that does not exist and for one
// in another account.
function formToChange(c: Ctx, doing: string) {
  const p = get('SELECT * FROM powerforms WHERE id=? AND account_id=?', c.params.id, c.account.id);
  if (!p) throw bad('That PowerForm does not exist any more. It may have been deleted already.', 404);
  assertMayRunForm(c, get('SELECT sender_id FROM envelopes WHERE id=?', p.template_id), doing);
  return p;
}

route('GET', '/powerforms', (c) => ({
  // "uses" counts every start. "signed" is what people finished, and "open" is who is filling one in right now.
  // may_change says whether this person may pause, change or delete the form, and owner whose template it is on.
  powerforms: all(`SELECT p.id, p.slug, p.name, p.active, p.uses, p.shared_device, p.created_at, t.subject template, t.sender_id template_owner, u.name owner,
      (SELECT COUNT(*) FROM envelopes e JOIN recipients r ON r.id=e.form_recipient_id WHERE e.powerform_id=p.id AND r.status='completed') signed,
      (SELECT COUNT(*) FROM envelopes e JOIN recipients r ON r.id=e.form_recipient_id WHERE e.powerform_id=p.id AND e.status='sent' AND r.status IN ('pending','sent','viewed')) open
    FROM powerforms p LEFT JOIN envelopes t ON t.id=p.template_id LEFT JOIN users u ON u.id=t.sender_id WHERE p.account_id=? ORDER BY p.created_at DESC`, c.account.id)
    // url is the public address of the form, built from APP_URL like every link in an email and never from a
    // request header. The app copies it and draws the form's QR code from it.
    .map(({ template_owner, ...p }) => ({ ...p, shared_device: !!p.shared_device, may_change: mayRunForm(c, template_owner), url: `${baseUrl()}/f/${p.slug}` })),
}));
route('POST', '/powerforms', async (c) => {
  const b = await c.body();
  const tpl = mine(c, str(b.template_id), 'template');
  assertMayRunForm(c, tpl, 'publish it as a PowerForm');
  // A visitor types their own details, so the open role can be checked with a code by email and never by text.
  assertFormChecks(powerformTemplate(tpl.id).open);
  const pid = id('pwf');
  run('INSERT INTO powerforms (id, account_id, template_id, slug, name, created_at, shared_device) VALUES (?,?,?,?,?,?,?)', pid, c.account.id, tpl.id, token(9), str(b.name, 120) || tpl.subject || 'PowerForm', now(), b.shared_device ? 1 : 0);
  return { id: pid };
});
route('PATCH', '/powerforms/:id', async (c) => {
  // Only what the call names is changed, so pausing a form does not also change how it treats a shared device.
  const b = await c.body();
  formToChange(c, 'pause or change this PowerForm');
  if (b.active !== undefined) run('UPDATE powerforms SET active=? WHERE id=? AND account_id=?', b.active ? 1 : 0, c.params.id, c.account.id);
  if (b.shared_device !== undefined) run('UPDATE powerforms SET shared_device=? WHERE id=? AND account_id=?', b.shared_device ? 1 : 0, c.params.id, c.account.id);
});
route('DELETE', '/powerforms/:id', (c) => {
  formToChange(c, 'delete this PowerForm');
  run('DELETE FROM powerforms WHERE id=? AND account_id=?', c.params.id, c.account.id);
});

route('GET', '/public/powerforms/:slug', (c) => {
  const p = get('SELECT * FROM powerforms WHERE slug=? AND active=1', c.params.slug);
  if (!p) throw bad('This form is not available.', 404);
  const a = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', p.account_id);
  const { tpl, open } = powerformTemplate(p.template_id);
  // Said before anyone types their name and address into a form that cannot take them.
  return { name: p.name, role: open.role_name || 'Signer', pages: tpl.documents.reduce((n: number, d: any) => n + d.pages, 0), brand: a, closed: formClosed(p, tpl), shared_device: !!p.shared_device };
}, 'public');

// Why an owner cannot send right now (a pause, an address that was never confirmed, an account that is being
// closed) is the owner's business. A visitor is told only that the form is closed for now, before they type
// anything, and nothing of theirs is kept.
const FORM_CLOSED = 'This form cannot take new signatures right now. Please contact whoever gave you the link.';
const formClosed = (p: any, tpl: any): boolean => {
  const a = get('SELECT suspended_at s, closing_at c FROM accounts WHERE id=?', p.account_id);
  return !get('SELECT email_verified v FROM users WHERE id=?', tpl.sender_id)?.v || !!a?.s || !!a?.c;
};

route('POST', '/public/powerforms/:slug/start', async (c) => {
  rateLimit(`pf:${c.ip}`, 20, 3600_000);
  const p = get('SELECT * FROM powerforms WHERE slug=? AND active=1', c.params.slug);
  if (!p) throw bad('This form is not available.', 404);
  const b = await c.body();
  const name = str(b.name, 120).trim();
  const email = str(b.email, 254).trim();
  if (!name || !isEmail(email)) throw bad('Enter your name and a valid email address.');
  const { tpl, open } = powerformTemplate(p.template_id);
  if (formClosed(p, tpl)) throw bad(FORM_CLOSED, 503);
  const owner = get('SELECT email FROM users WHERE id=?', tpl.sender_id);
  // Opening the form twice must not create two envelopes. But an email address proves nothing, because anyone can
  // type somebody else's. So an unfinished start is only handed back to the browser that made it, which has held a
  // cookie since then, and only when the same name and address are typed again. Everyone else, and every other
  // name at a shared address, gets a fresh, empty document.
  const jar = `ts_pf_${p.id}`;
  const [started, seal] = (readCookie(c.req, jar) || '').split('.');
  if (started && seal && safeEqual(seal, hmac(`pf:${p.id}:${started}`))) {
    const again = get("SELECT r.token FROM envelopes e JOIN recipients r ON r.id=e.form_recipient_id WHERE e.id=? AND e.powerform_id=? AND e.status='sent' AND r.status IN ('sent','viewed') AND r.email=? AND lower(r.name)=lower(?)", started, p.id, email, name);
    if (again) return { url: `${baseUrl()}/sign/${again.token}`, resumed: true };
  }
  // Every start makes an envelope in the owner's account and sends an email to an address a stranger typed, so one
  // device address may only have a few unfinished ones on a form at a time: more on a form its owner marked as
  // filled in on a shared device, where they are also cleared much sooner. An address we cannot tell apart is not
  // counted.
  if (c.ip !== 'unknown') {
    const unfinished = get("SELECT COUNT(*) n FROM envelopes e JOIN recipients r ON r.id=e.form_recipient_id WHERE e.powerform_id=? AND e.form_ip=? AND e.status='sent' AND r.status IN ('pending','sent','viewed')", p.id, c.ip).n;
    const most = p.shared_device ? POWERFORM_SHARED_OPEN_STARTS : POWERFORM_OPEN_STARTS;
    const cleared = p.shared_device ? `${powerformSharedIdleMinutes()} minutes` : `${powerformIdleHours()} hours`;
    if (unfinished >= most)
      throw bad(`This form has been started ${most} times from your internet connection and not finished yet. Finish one of those first: ${process.env.SMTP_URL ? 'the link is in the email we sent each time' : 'use the page that opened when you started it'}. Ones that stay unfinished are cleared after ${cleared}, and then you can start again here.${p.shared_device ? '' : ' If many people fill this form in at the same place, ask whoever gave you the link to mark it as used on a shared device.'}`, 429);
  }
  // A public form uses one of its owner's signatures for each person who signs, taken at the moment they finish
  // (see completeRecipient). Starting holds nothing and other people's unfinished starts are not counted, so a
  // stranger who starts and walks away stands in nobody's way. When the owner has none free the form says so
  // before anyone fills it in, and the owner is told (once a day at most) instead of finding out from a customer.
  if (creditsEnabled() && isChargeable({ role: open.role, email, name }, get('SELECT email, name FROM users WHERE id=?', tpl.sender_id) || '') && available(p.account_id) < 1) {
    await formNeedsSignatures(p.account_id, p.id);
    throw bad('This form cannot take new signatures right now. Please try again a little later, or contact the people who sent you here.', 503);
  }
  const eid = copyEnvelope(tpl, { accountId: p.account_id, senderId: tpl.sender_id, kind: 'envelope', subject: p.name, fill: { [open.id]: { name, email } }, extra: { powerform_id: p.id } });
  // Which recipient is the visitor and which device address started it, so a later visit can be matched to this
  // start by more than an email address, and so unfinished starts can be counted and cleared.
  const visitor = get('SELECT id FROM recipients WHERE envelope_id=? AND position=?', eid, open.position);
  run('UPDATE envelopes SET form_recipient_id=?, form_ip=? WHERE id=?', visitor?.id ?? null, c.ip, eid);
  try {
    await sendEnvelope(eid, { name: `${name} <${email}> via PowerForm`, ip: c.ip, ua: c.ua });
  } catch (err) {
    // Whatever stopped the send (the owner's daily limit, a rule about what may be sent), no stray draft with the
    // visitor's name and address is left behind, the visitor gets the neutral words, and the owner gets the real
    // reason (once a day at most).
    run('DELETE FROM envelopes WHERE id=?', eid);
    if (!(err instanceof HttpError)) throw err;
    if (!p.alerted_at || Date.parse(p.alerted_at) < Date.now() - 864e5) {
      run('UPDATE powerforms SET alerted_at=? WHERE id=?', now(), p.id);
      await sendMail({ to: owner.email, subject: `Your form "${p.name}" could not take a signature`, heading: 'Someone tried to sign your form and could not', lines: [`What stopped it: ${err.message}`, 'They were told only that the form cannot take new signatures right now, and nothing of theirs was kept.'], cta: { label: 'Open your forms', url: `${baseUrl()}/app/powerforms` } });
    }
    throw bad(FORM_CLOSED, 503);
  }
  run('UPDATE powerforms SET uses=uses+1 WHERE id=?', p.id);
  // The cookie that lets this browser, and nobody else, pick this start up again. It lasts as long as the start can.
  c.cookies.push(cookie(jar, `${eid}.${hmac(`pf:${p.id}:${eid}`)}`, Math.ceil(p.shared_device ? powerformSharedIdleMinutes() * 60 : powerformIdleHours() * 3600), c.secure));
  const me = visitor && get("SELECT token FROM recipients WHERE id=? AND status != 'pending'", visitor.id);
  // If someone else signs first in the routing order, the signer simply gets an email when it is their turn.
  return me ? { url: `${baseUrl()}/sign/${me.token}` } : { queued: true };
}, 'public');
