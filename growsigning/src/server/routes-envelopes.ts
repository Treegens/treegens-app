// What the person's role allows (perm.ts), where this file once asked for an admin.
import { limitedPeople } from './visibility.ts';
import { can } from './perm.ts';
import { route, json, pdfResponse, type Ctx } from './router.ts';
import { all, get, run, tx, saveBlob, readBlob } from './db.ts';
// Send later ("send_at" on POST /envelopes/:id/send) and what a send by hand clears (timing.ts).
import { scheduleSend, clearSchedule } from './timing.ts';
// A person who sends something new from the app has given their phone number (signuprules.ts).
import { phoneBeforeSend } from './signuprules.ts';
import { bad, id, token, now, str, rateLimit, rateWait, isEmail, baseUrl, sha256, HttpError } from './util.ts';
import { inspectPdf, imageToPdf, imagesToPdf } from './pdf.ts';
import { extractPages, textOf } from './text.ts';
import { sendMail } from './mail.ts';
import { creditsEnabled, available, isChargeable } from './credits.ts';
import {
  loadEnvelope, publicEnvelope, createEnvelope, saveDraft, copyEnvelope, sendEnvelope, voidEnvelope, remindEnvelope,
  correctRecipient, correctEnvelope, extendEnvelope, auditTrail, verifyChain, buildPdf, finalPdf, audit, signUrl, senderOf, outOfSignatures,
  advance, assertMayEmail, formNeedsSignatures, type Actor,
} from './envelopes.ts';
import { hmac, safeEqual } from './util.ts';
import { bouncedBefore, bouncedRefusal, bouncedLine, mailStop, mailStopText } from './bounces.ts';
import { correctWithCheck, assertBulkChecks, bulkChecksRefusal, assertFormChecks, textsOf } from './signercode.ts';
import { waOf, correctWithWa } from './whatsapp.ts';
// A recipient that is a group of people, any one of whom can act (src/server/groups.ts).
import { memberLink, memberInbox, groupReach, assertNoGroupCheck, membersNotReminded, assertTemplateGroups } from './groups.ts';
import { assertBySenderCorrection } from './bysender.ts';
import { labelOf } from '../lib/bysender.ts';
import { cookie, readCookie } from './auth.ts';
import { forgetEnvelopes, removeUnusedBlobs } from './routes-trust.ts';
import { CLOSED, senderNotice } from './evidence.ts';
import { sendWarnings } from './warnings.ts';
import { emailRefusal, fieldProgress, formPageRefusal, yesNo } from './envelopes.ts';
import { markPaying } from './collect.ts';
import { PRICING, treesForSignature } from '../lib/impact.ts';
import { showsTrees } from './tenantpolicy.ts';
import { printProblems, unprintable } from './pdftext.ts';
import { shareLinkOf, autoShareLink, dropShareLinks } from './sharelinks.ts';
import { powerformIdleHours, POWERFORM_OPEN_STARTS, POWERFORM_SHARED_OPEN_STARTS, powerformSharedIdleMinutes, MAX_PHOTOS_PER_DOCUMENT } from '../lib/policy.ts';
import { POWERFORM_STARTS_PER_HOUR, POWERFORM_SHARED_STARTS_PER_HOUR } from '../lib/policy.ts';
import { reminderText } from '../lib/policy.ts';
import { keptOnDelete, keptLine } from './deleting.ts';
// Keeping closed envelopes for a set time, legal holds and what a purge left (records.ts).
import { assertNotHeld, holdsFollow, isHeld, retentionFacts } from './records.ts';
// Who may use and change each template, and the lock on its wording (src/server/tplroles.ts).
import { assertMayUse, mayUse, mayChange, maySetRules, changeRefusal, usableSql, markList, accessOf, wordingLock, assertWordingKept, assertMessageKept, cloneOwner, noteCopy, copyIsTheirs, fileHeldBack, templateGoes, assertCorrectionKept, asMember, forRows, askWho } from './tplroles.ts';
// A witness for one signer (src/server/witness.ts): one the signer names is no open role for a bulk row or a form.
import { witnessCorrected, rowFills } from './witness.ts';
import { rowFieldProblem } from './logic.ts';
// A bulk row's "language", and a form visitor's language from their browser (locales.ts).
import { rowLanguageRefusal, assertRowLanguages, visitorLocale, correctionLocale } from './locales.ts';
import { keepText, sealedTextHits } from './searchtext.ts';
import { queueOcr } from './ocr.ts';
import { assertFormNotStacked, tellStackedForm } from './stackedforms.ts';
// Office files and others turned into a PDF on upload, with the original kept (src/server/converted.ts).
import { convertUpload, keepOriginal } from './converted.ts';
import { keepScanPhotos } from './scanphotos.ts';
import { KNOWN_EXT } from '../lib/convert.ts';
import { nameFromFile, listName } from '../lib/docname.ts';
import { record } from './seclog.ts';
// The account's own custom fields (customfields.ts): values on envelopes and templates, bulk columns, the list filter.
import { endsWithinFilter } from './airepo.ts';
import { readCustom, writeCustom, assertBulkCustom, bulkCustomRefusal, applyRowCustom, formCustomProblem, customFilter, attachCustom, customPrintProblems } from './customfields.ts';
import { existingSignatures, sealFacts } from './seal.ts';
import { pdfaFacts } from './pdfa.ts';
import { chainStampFacts } from './auditstamp.ts';
import { signNowFor } from './signnow.ts';
// A form's questions, answered before the document (src/server/webforms.ts).
import { formView, formQuestions, checkAnswers, fillAnswers, dropDraft, resumeAnswers } from './webforms.ts';
import { unlabelledCount } from '../lib/webforms.ts';
import { shareFor, shareFacts, sendForOf, noteSentBy, noteMadeFor, ownersSharingWith, shareLevelsWith } from './shares.ts';
// Fields placed by the words of a document: "anchor" and "auto_tags" (anchors.ts).
import { placeByWords, assertAllPlaced, refuseWordsWithTemplate } from './anchors.ts';
import { framedLink, noteScreenUpload, endScreenOnSend } from './embed.ts';
import { signaturesLost } from '../lib/seal.ts';
import { dayText } from '../lib/dates.ts';
import { assertNoStepRoles } from './agents.ts';
// One envelope from several templates (tplcombine.ts).
import { readTemplateIds, combineTemplates, combinedLine } from './tplcombine.ts';
import { assertStampsAllowed, saveFormLimits, formLimitClosed } from './switches.ts';

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
  // A Word, Excel, PowerPoint, OpenDocument, RTF, text, HTML or TIFF file becomes a PDF first on a server with a
  // converter, and goes on from here exactly as a PDF does. The original is kept with it (src/server/converted.ts).
  const conv = await convertUpload(bytes, file.name, accountId, parts.length);
  if (conv) bytes = conv.pdf;
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
  // "planting-partnership.pdf" becomes "Planting partnership": the name is what the subject, the lists and the
  // downloaded file are called after (src/lib/docname.ts).
  const name = nameFromFile(str(file.name, 200).replace(KNOWN_EXT, '')) || 'Document';
  // Text is kept for the sender's own search. Files uploaded by signers are not indexed.
  const read = isPdf && accountId ? await extractPages(bytes) : [];
  const text = textOf(read);
  // A page with no text is almost always a picture of a page, a scan or a photo: it cannot be searched, and a screen
  // reader cannot read it. A PNG or JPEG is always one. In a PDF every page is looked at, so a scanned page among
  // typed ones is found and named. A PDF nothing could be read from counts as a scan altogether. The answer is kept
  // with the file (scan_pages, counted from 1), so it is said again wherever the file is listed, not only here.
  // Files that signers attach are not looked at.
  const scanPages = !accountId ? [] : !isPdf || !read.some((p) => p.trim()) ? Array.from({ length: info.pages }, (_, i) => i + 1) : read.flatMap((p, i) => (p.trim() ? [] : [i + 1]));
  // With FILE_ENCRYPTION_KEY set the text is kept encrypted like the file itself, never in the clear (searchtext.ts).
  const kept = keepText(fid, text);
  run('INSERT INTO files (id, account_id, sha256, name, size, pages, page_sizes, created_at, text, scan_pages, text_sealed, text_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', fid, accountId, saveBlob(bytes), name, bytes.length, info.pages, JSON.stringify(info.sizes), now(), kept.text, scanPages.length ? JSON.stringify(scanPages) : null, kept.sealed, kept.key);
  const converted = conv ? keepOriginal(fid, conv) : null;
  // Pages that are pictures are read by a machine in the background, when this server is set up for it (ocr.ts).
  const ocr = !!accountId && queueOcr(fid, scanPages);
  // Signatures already in the PDF do not survive in the signed copy, which is made from flattened pages (seal.ts).
  const signed = isPdf && accountId ? await existingSignatures(bytes) : 0;
  // Pictures the sender's browser cleaned come with the photo before cleanup, which is kept (scanphotos.ts).
  const cleaned = !isPdf && !conv ? await keepScanPhotos(fid, form, accountId, parts.length) : [];
  return { id: fid, name, pages: info.pages, page_sizes: info.sizes, size: bytes.length, is_scan: scanPages.length > 0, scan_pages: scanPages, converted, ...(cleaned.length ? { cleaned_pages: cleaned } : {}), ...(ocr ? { ocr: 'queued' } : {}), ...(signed ? { existing_signatures: signed, existing_signatures_note: signaturesLost(signed) } : {}) };
}

route('POST', '/files', async (c) => noteScreenUpload(c, await storeUpload(c, c.account.id)));
route('GET', '/files/:id/content', (c) => {
  const f = get('SELECT * FROM files WHERE id=? AND account_id=?', c.params.id, c.account.id);
  if (!f) throw bad('File not found.', 404);
  // A document of a template that is not for this person is read only through something they can open that holds it
  // (tplroles.ts), the same answer as a file that does not exist.
  let refusal: any = null;
  const opens = (eid: string) => { try { return !!mine(c, eid); } catch (err: any) { if (err?.status === 403) refusal = err; return false; } };
  const uses = all('SELECT DISTINCT d.envelope_id, e.kind FROM documents d JOIN envelopes e ON e.id=d.envelope_id WHERE d.file_id=?', f.id);
  if (fileHeldBack(c, f.id) && !uses.some((d) => opens(d.envelope_id))) throw bad('File not found.', 404);
  // A file that is only in envelopes is read by someone who can open one of them: their own, an admin, or a colleague
  // whose share covers opening files (shares.ts: not 'see'). Their answer when the share is too low; else not found.
  if (uses.length && uses.every((d) => d.kind === 'envelope') && !uses.some((d) => opens(d.envelope_id))) throw refusal || bad('File not found.', 404);
  return pdfResponse(readBlob(f.sha256), f.name, true);
});

// ---- Envelopes and templates ---------------------------------------------------------------

export function mine(c: Ctx, envelopeId: string, kind?: string, o: { removed?: boolean } = {}) {
  const e = loadEnvelope(envelopeId);
  if (!e || e.account_id !== c.account.id || (kind && e.kind !== kind)) throw bad('Envelope not found.', 404);
  // Members see what they sent. Admins see the whole account. Templates are shared with the team.
  // A colleague the sender shared their documents with gets through for what the share's level covers (shares.ts).
  if (e.kind === 'envelope' && !can(c, 'see_all') && e.sender_id !== c.user.id && !shareFor(c, e)) throw bad('Envelope not found.', 404);
  // A template can be for admins only or for chosen members (tplroles.ts). Every way of reading, using, copying or
  // changing a template comes through here, so one who may not use it gets no further, and is told who to ask.
  if (e.kind === 'template') assertMayUse(c, e);
  // An envelope its sender deleted after somebody had signed is gone for the sender: no list, no search, no
  // change. Its recipients still have it, and so does the account: an admin can open it, download it and put it
  // back (the three routes that pass `removed`), and do nothing else to it until it is back.
  if (e.hidden_at && !(o.removed && can(c, 'see_all'))) throw bad('Envelope not found.', 404);
  return e;
}

// Whoever may use a template can read it, copy it and send from it. Changing one is for the person it belongs to and
// for admins, and for the members they chose or the whole team when its rule says so (tplroles.ts), so no member can
// wipe or rewrite what the whole team sends from. Deleting is only ever for the person it belongs to and admins.
export function assertMayChange(c: Ctx, e: any, deleting = false) {
  if (e.kind !== 'template') return;
  if (!mayChange(c, e) || (deleting && !maySetRules(c, e))) throw changeRefusal(c, e, deleting);
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
  if (removed && !can(c, 'see_all')) throw bad('Envelopes that were removed by their sender are shown to the admins of the account only. Ask an admin of your team to look for it and put it back.', 403);
  const kind = c.q.get('kind') === 'template' && !removed ? 'template' : 'envelope';
  const hidden = removed ? 'hidden_at IS NOT NULL' : 'hidden_at IS NULL';
  const where = ['e.account_id=?', 'e.kind=?', `e.${hidden}`];
  const p: any[] = [c.account.id, kind];
  // Members see what they sent, and the folders of what they sent. Templates and their folders are the team's.
  const own = kind === 'envelope' && !can(c, 'see_all');
  // ?shared=1: the documents colleagues share with this person today, in place of their own; ?sender=<id> of one of
  // those colleagues: theirs alone (shares.ts).
  const sharers = own ? ownersSharingWith(c) : [];
  if (kind === 'envelope' && c.q.get('shared') === '1') (where.push('e.sender_id IN (SELECT value FROM json_each(?))'), p.push(JSON.stringify(own ? sharers : ownersSharingWith(c))));
  else if (own && sharers.includes(c.q.get('sender') || '')) (where.push('e.sender_id=?'), p.push(c.q.get('sender')));
  // With nobody chosen, a member someone shares with sees their own and the shared ones together, each shared row
  // marked with its level below, so a colleague's documents are never hidden behind the "Sent by" choice.
  else if (own && sharers.length && !c.q.get('sender')) (where.push('e.sender_id IN (SELECT value FROM json_each(?))'), p.push(JSON.stringify([c.user.id, ...sharers])));
  else if (own) (where.push('e.sender_id=?'), p.push(c.user.id));
  // A template someone may not use is not listed at all, and neither is its folder (tplroles.ts).
  const [usable, usableP] = kind === 'template' ? usableSql(c) : ['', []];
  if (usable) (where.push(usable), p.push(...usableP));
  const boxes: Record<string, string> = { drafts: "e.status='draft'", sent: "e.status!='draft'", waiting: "e.status='sent'", completed: "e.status='completed'", closed: "e.status IN ('voided','declined','expired')" };
  if (kind === 'envelope' && boxes[box]) where.push(boxes[box]);
  if (c.q.get('folder')) (where.push('e.folder=?'), p.push(c.q.get('folder')));
  if (can(c, 'see_all') && c.q.get('sender')) (where.push('e.sender_id=?'), p.push(c.q.get('sender')));
  // ?field=Case number&value=2026/114: only those with that value of a custom field, any value when it is empty.
  customFilter(c.q, where, p);
  // ?ends_within=90: only those with a checked end date in the next 90 days (Key dates, airepo.ts).
  endsWithinFilter(c.q, where, p);
  const q = (c.q.get('q') || '').trim();
  // Every word that was typed has to be found somewhere: in the subject, the folder, on a person or in the name of
  // a role, in a document's name or in the words inside the documents. So "texas progress" finds the template
  // "Texas, conditional waiver, progress payment", whatever stands between the two words. What was typed as a whole
  // still finds an envelope by its id.
  const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length) {
    // A % or _ that was typed is that character, not "anything": "50%" finds "Discount 50% offer" and "%" alone finds
    // only names with a % in them, never every template (ESCAPE, and likeWord below).
    const word = `(e.subject LIKE ? ESCAPE '\\' OR e.folder LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM recipients r WHERE r.envelope_id=e.id AND (r.name LIKE ? ESCAPE '\\' OR r.email LIKE ? ESCAPE '\\' OR r.role_name LIKE ? ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=e.id AND (d.name LIKE ? ESCAPE '\\' OR f.text LIKE ? ESCAPE '\\'))
      OR e.id IN (SELECT value FROM json_each(?)))`;
    const likeWord = (w: string) => `%${w.replace(/[\\%_]/g, '\\$&')}%`;
    // Text kept encrypted (FILE_ENCRYPTION_KEY) cannot be searched by the database: it is opened in memory, for this
    // account only, and the envelopes whose documents hold each word come back as a list (searchtext.ts).
    // A member's own and, with nobody chosen, what colleagues share with them: the same people the list shows.
    const sealed = sealedTextHits(c.account.id, kind, words, own ? [c.user.id, ...sharers] : undefined);
    where.push(`(e.id = ? OR (${words.map(() => word).join(' AND ')}))`);
    p.push(q, ...words.flatMap((w, i) => [...Array(7).fill(likeWord(w)), JSON.stringify(sealed[i])]));
  }
  const limit = Math.min(200, Number(c.q.get('limit')) || 100);
  const rows = all(`SELECT e.id, e.kind, e.status, e.subject, e.folder, e.created_at, e.updated_at, e.sent_at, e.completed_at, e.expires_at, e.sheets, e.bulk_id, e.sender_id, u.name sender, e.hidden_at removed_at, e.ordered, e.send_at, e.send_error, e.paused_at
    FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE ${where.join(' AND ')} ORDER BY e.updated_at DESC LIMIT ? OFFSET ?`, ...p, limit, Number(c.q.get('offset')) || 0);
  for (const e of rows) {
    // bounced_at, complained_at: an email to them came back for good, or they marked one as spam. The list flags both.
    // paper_state: a scan signed on paper that waits for the sender is shown as theirs to look at, without Remind (paper.ts).
    e.recipients = all('SELECT id, name, email, role, role_name, status, sent_at, muted, bounced_at, complained_at, routing_order, wait_hours, completed_at, paper_state FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', e.id);
    // True when the latest email to someone who has not opened it yet did not leave. Lets the list flag it.
    e.email_failed = all("SELECT m.status FROM emails m WHERE m.envelope_id=? AND m.id IN (SELECT MAX(id) FROM emails WHERE envelope_id=? GROUP BY COALESCE(recipient_id, to_email))", e.id, e.id).some((m) => m.status === 'failed');
    e.pages = get('SELECT COALESCE(SUM(f.pages),0) n FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=?', e.id).n;
  }
  // A colleague's row: whose it is and the level of the share, so the list offers only what that level allows.
  if (own && sharers.length) {
    const levels = shareLevelsWith(c);
    for (const e of rows) if (e.sender_id !== c.user.id && levels[e.sender_id]) e.shared_level = levels[e.sender_id];
  }
  // Each row's custom fields, for the column the list can show (customfields.ts).
  attachCustom(rows);
  // Only the folders of what this person can see: a folder name such as "Layoffs 2026" says something by itself.
  const folders = all(`SELECT DISTINCT folder FROM envelopes e WHERE account_id=? AND kind=? AND ${hidden} AND folder IS NOT NULL AND folder != ''${own ? ' AND sender_id=?' : ''}${usable ? ` AND ${usable}` : ''}`, ...(own ? [c.account.id, kind, c.user.id] : [c.account.id, kind]), ...usableP).map((r) => r.folder);
  // Admins can narrow the list to one person's envelopes.
  const senders = can(c, 'see_all') ? all(`SELECT DISTINCT u.id, u.name FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE e.account_id=? AND e.kind=? AND e.${hidden} ORDER BY u.name`, c.account.id, kind)
    // A member someone shares with: themselves and each colleague who shares, so "Sent by" can show theirs (shares.ts).
    : sharers.length ? [{ id: c.user.id, name: c.user.name }, ...sharers.map((id) => ({ id, name: get('SELECT name FROM users WHERE id=?', id)?.name || 'A colleague', shared: true }))] : [];
  // On a template, may_change says whether this person may change it, and access what they may do with it and its
  // rule (use, change, locked), so the page shows the right buttons and an "Admins only" or lock mark (tplroles.ts).
  if (kind === 'template') markList(c, rows);
  // For admins: how many envelopes in the account were removed by their sender, so the list can offer to show them.
  const removedCount = can(c, 'see_all') && kind === 'envelope' ? get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope' AND hidden_at IS NOT NULL", c.account.id).n : undefined;
  return { envelopes: rows, folders, senders, ...(removedCount === undefined ? {} : { removed: removedCount }) };
});

// Documents addressed to the signed-in user, from any sender.
route('GET', '/inbox', (c) => {
  if (!c.user.email_verified) return { needs_verification: true, items: [] };
  return {
    // First what is waiting for a group this person is a member of, each with their own link (memberInbox in groups.ts).
    items: [...memberInbox(c.user.email), ...all(`SELECT e.id, e.subject, e.status, e.sent_at, e.completed_at, u.name sender, r.role, r.status my_status, r.token
      FROM recipients r JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id
      WHERE r.email=? AND e.kind='envelope' AND e.status!='draft' AND e.purged_at IS NULL AND r.status NOT IN ('pending','skipped') AND r.role!='inperson' ORDER BY e.updated_at DESC LIMIT 100`, c.user.email)],
  };
});

route('POST', '/envelopes', async (c) => {
  const b = await c.body();
  // A kind we do not have is a mistake to point out. A misspelled "template" must never become an envelope.
  if (b.kind != null && b.kind !== '' && b.kind !== 'template' && b.kind !== 'envelope')
    throw bad(`"kind" is "${str(b.kind, 40)}", which does not exist. Use "envelope" or "template", or leave it out for an envelope. Nothing was created.`);
  const kind = b.kind === 'template' ? 'template' : 'envelope';
  // A member may not add a stamp field when the admins turned that off (switches.ts).
  assertStampsAllowed(c, b);
  // "send": "false", in quotes, must never email anybody. A yes or no is true or false, or it is refused (yesNo).
  const send = yesNo(b.send, false, '"send"');
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
    // One this person deleted from their lists after somebody signed is still out there for its recipients, so a
    // retry with its key must not send the same thing to them a second time. The key stays used.
    if (!prior && done && get('SELECT 1 x FROM envelopes WHERE id=? AND account_id=? AND sender_id=? AND hidden_at IS NOT NULL', done.envelope_id, c.account.id, c.user.id))
      throw bad(`This Idempotency-Key already made envelope ${done.envelope_id}, which was signed and has been deleted from your lists since. Nothing new was created and nobody was emailed again. To send it once more on purpose, use a new key.`, 409);
    if (prior && done.request_hash && done.request_hash !== bodyHash(b))
      throw bad(`This Idempotency-Key was already used for a different request, which made envelope ${prior.id}. Nothing new was created. Repeat a call with its own key, and use a new key for each new envelope.`, 409);
    if (prior) return new Response(JSON.stringify({ envelope: publicEnvelope(prior) }), { headers: { 'content-type': 'application/json; charset=utf-8', 'idempotent-replay': 'true' } });
  }
  let eid: string;
  // Fields placed by "anchor" and "auto_tags" become ordinary fields before anything is made (anchors.ts). The key
  // is kept with the body as it was sent, so a retry with the same key is still the same request.
  const sentHash = bodyHash(b);
  // "on_behalf_of": made in the name of a colleague who shared sending with this person, or by an admin-scope key
  // (shares.ts). Who pressed Send is kept with it, and recipients read both names.
  const forId = sendForOf(c, b);
  const placing = b.template_id || b.template_ids !== undefined ? refuseWordsWithTemplate(b) : await placeByWords(c.account.id, b);
  if (send && kind === 'envelope') assertAllPlaced(placing);
  // "template_ids": one envelope from two or more templates, one after the other (tplcombine.ts).
  if (b.template_ids !== undefined && b.template_ids !== null) {
    const ids = readTemplateIds(b);
    const tpls = ids.map((x) => mine(c, x, 'template'));
    const fill = b.recipients && !Array.isArray(b.recipients) ? b.recipients : undefined;
    tpls.forEach((t) => assertTemplateGroups(t, [fill || null], !!send));
    const custom = readCustom(c.account.id, tpls[0], { custom_fields: b.custom_fields }, { merge: true });
    eid = combineTemplates(c, tpls, { senderId: forId ?? c.user.id, subject: b.subject, message: b.message, fill });
    writeCustom(eid, custom, c.actor);
    audit(eid, c.actor, 'Started from templates', combinedLine(tpls));
  } else if (b.template_id) {
    const tpl = mine(c, str(b.template_id), 'template');
    // A locked template keeps its own message for whoever may not change it. The subject is the envelope's name.
    assertMessageKept(c, tpl, b.message);
    // A person named for a group's role, and (when sending) a group that is gone, are refused before anything is made (groups.ts).
    assertTemplateGroups(tpl, [b.recipients && !Array.isArray(b.recipients) ? b.recipients : null], !!send && kind === 'envelope');
    // "kind": "template" with a template_id is a copy of the template, held to the same rule as /clone (cloneOwner).
    // "custom_fields" set or empty the ones named, and the template's values stand for the rest (customfields.ts).
    const custom = readCustom(c.account.id, tpl, { custom_fields: b.custom_fields }, { merge: true });
    eid = copyEnvelope(tpl, { accountId: c.account.id, senderId: forId ?? cloneOwner(c, tpl, kind), kind, subject: b.subject, message: b.message, fill: b.recipients && !Array.isArray(b.recipients) ? b.recipients : undefined });
    writeCustom(eid, custom, c.actor);
    if (kind === 'template') noteCopy(c, eid, tpl);
  } else {
    // "custom_fields" and "documents[].fields", checked before anything is made (customfields.ts).
    const custom = readCustom(c.account.id, null, b);
    eid = createEnvelope(c.account, forId ?? c.user.id, kind, b);
    try {
      // Anything the body says about the envelope goes through the same checks as a save, so a setting that cannot
      // be carried out (a date format that does not exist, say) is refused here too and never dropped.
      if (['documents', 'recipients', 'fields', 'ordered', 'date_format', 'reminder_days', 'expire_days'].some((k) => b[k] != null && b[k] !== '')) saveDraft(loadEnvelope(eid), b, c.account.id);
      writeCustom(eid, custom, c.actor);
    } catch (e) {
      // A request that is turned down (a field for a recipient who is not on it, say) leaves no empty draft behind.
      run('DELETE FROM envelopes WHERE id=?', eid);
      throw e;
    }
  }
  // The key row goes when its envelope goes (the database deletes it with the envelope), so a key never points at
  // nothing. REPLACE covers the one case left: a key whose envelope now belongs to somebody else.
  if (idem) run('INSERT OR REPLACE INTO idempotency_keys (account_id, user_id, key, envelope_id, request_hash, at) VALUES (?,?,?,?,?,?)', c.account.id, c.user.id, idem, eid, sentHash, now());
  if (forId) (noteSentBy(c, eid), noteMadeFor(c, eid));
  if (send && kind === 'envelope') {
    try {
      // "send_anyway": the caller has seen that an address on it bounced before, and wants it sent all the same.
      phoneBeforeSend(c);
      noteSentBy(c, eid);
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
  return { envelope: publicEnvelope(made), ...(send && kind === 'envelope' ? { warnings: sendWarnings(made) } : {}), ...(placing ? { anchors: placing } : {}) };
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
  // Pressed Finish and waits for a card payment to be confirmed (collect.ts): said as that, not as "Finish is left".
  markPaying(env.recipients);
  // A template: who can use and change it, and what this person may do with it. An envelope started from a template
  // whose wording is locked for this person: what is locked and who can unlock it, so the editor shows it as locked.
  if (e.kind === 'template') env.access = accessOf(c, e);
  else env.wording_lock = wordingLock(c, e);
  // "Each person sees only their files": who was shown which files, for the sender's page (visibility.ts).
  if (e.kind !== 'template') env.limited_people = limitedPeople(e);
  // Names and wording in a script the signed PDF has no font for, said here so the sender hears it from the
  // envelope page and not from the finished document. Each entry says where the text stands and which characters.
  const print_problems = e.status === 'completed' && (e.final_sha256 || e.purged_at) ? [] : [...printProblems(e, get('SELECT name FROM users WHERE id=?', e.sender_id)), ...customPrintProblems(e.id)];
  // texts: what became of every text message about this envelope, like deliveries for email. Numbers are masked.
  // kept_on_delete: whether deleting it now would only take it out of the lists (deleting.ts), for the delete dialog.
  // retention: how long it is kept, a purge asked for or announced, holds, and what a purge left (records.ts).
  // shared, sent_by_name, first_sender_name: whose it is when it came through a share, who sent it for whom (shares.ts).
  // share_link: the document's readable address, growsigning.com/<name>, when its sender made one (sharelinks.ts).
  if (e.kind !== 'template') env.share_link = shareLinkOf('envelope', e.id);
  return { ...shareFacts(c, e), envelope: env, audit: auditTrail(e.id), chain: verifyChain(e.id), deliveries, texts: textsOf(e.id), whatsapp: waOf(e.id), print_problems, removed_at: e.hidden_at || null, kept_on_delete: keptOnDelete(e), retention: retentionFacts(c, e), seal: sealFacts(e), archive_format: pdfaFacts(e), record_stamp: chainStampFacts(e.id, verifyChain(e.id).ok) };
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
  assertStampsAllowed(c, b, e);
  // Started from a template whose wording is locked for this person: the locked parts stay as they are (tplroles.ts).
  assertWordingKept(c, e, b);
  // "custom_fields" and "documents[].fields", checked before anything is saved and written after (customfields.ts).
  // Fields placed by "anchor" and "auto_tags" (anchors.ts), looked for in the saved documents when the body has none.
  const placing = await placeByWords(c.account.id, b, e);
  const custom = readCustom(c.account.id, e, b);
  // A draft on hold is frozen: saving could empty it, which is deleting by another name (records.ts).
  if (e.kind === 'envelope' && e.status === 'draft') assertNotHeld([e.id], c.actor.name, 'change it');
  // A body that carries the edit_version its sender loaded is refused with 409 when someone has saved since, so a
  // save from an older copy never wipes a colleague's work. A body without it is saved as it always was.
  if (e.kind === 'envelope' && e.status === 'sent') await correctEnvelope(e, b, c.account.id, c.actor);
  else saveDraft(e, b, c.account.id, c.actor);
  writeCustom(e.id, custom, c.actor);
  return { envelope: publicEnvelope(loadEnvelope(e.id)), ...(placing ? { anchors: placing } : {}) };
});

route('POST', '/envelopes/:id/extend', async (c) => {
  const { days } = await c.body();
  return { expires_at: await extendEnvelope(mine(c, c.params.id, 'envelope'), days, c.actor) };
});

route('PATCH', '/envelopes/:id', async (c) => {
  const e = mine(c, c.params.id);
  assertMayChange(c, e);
  const b = await c.body();
  // A hold on the folder it leaves keeps covering it (records.ts).
  if ('folder' in b) (holdsFollow(e.id), run('UPDATE envelopes SET folder=? WHERE id=?', str(b.folder, 80).trim() || null, e.id));
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
  assertMayChange(c, e, true);
  if (e.status === 'sent') throw bad('Void this envelope before deleting it.');
  if (e.kind === 'template' && get('SELECT 1 x FROM powerforms WHERE template_id=?', e.id)) throw bad('A PowerForm still uses this template. Delete the PowerForm first.');
  // Kept for whoever keeps a copy: the same rule as their download (keepsCopy), so a viewer who confirmed, or someone
  // who signed and was then asked to sign again (signed_before), does not lose theirs (deleting.ts).
  // On hold: refused, also when deleting would only take it out of the lists, so a held document stays where the
  // people who hold it look for it. The attempt is recorded (records.ts).
  if (e.kind === 'envelope') assertNotHeld([e.id], c.actor.name, 'delete it');
  if (keptOnDelete(e)) {
    run('UPDATE envelopes SET hidden_at=? WHERE id=?', now(), e.id);
    audit(e.id, c.actor, 'Removed from the sender\'s lists', keptLine(e));
    record('envelope.deleted', { c, about: ['envelope', e.id], details: { status: e.status, kept_for_recipients: true } });
    return { ok: true, kept_for_recipients: true };
  }
  const shas = tx(() => {
    // Whoever a locked template belonged to keeps changing what was started from it once it is gone (tplroles.ts).
    templateGoes(e);
    const s = forgetEnvelopes([e.id]);
    run('DELETE FROM envelopes WHERE id=?', e.id);
    // The id and the state only: the subject and everything else of it is gone with it (seclog.ts).
    record('envelope.purged', { c, about: [e.kind === 'template' ? 'template' : 'envelope', e.id], details: { kind: e.kind, status: e.status } });
    return s;
  });
  // The uploaded documents stay: they are files of the account and other envelopes may use them.
  removeUnusedBlobs(shas);
});

// Puts an envelope its sender removed from their lists back where it was: in the sender's lists, the search, the
// export and the reports. For admins, because the member who removed it cannot see it any more and the account
// must not be the one party to a signed document that cannot get at it. One statement decides, so two calls at the
// same moment leave one line in the record. Checked here rather than by the router's admin level, so an admin's
// "send" key, which can already list and open these, is not told that this is an account setting.
route('POST', '/envelopes/:id/restore', (c) => {
  if (!can(c, 'see_all')) throw bad('Only an admin of the account can put back an envelope that its sender removed. Ask an admin of your team.', 403);
  const e = mine(c, c.params.id, 'envelope', { removed: true });
  if (run('UPDATE envelopes SET hidden_at=NULL WHERE id=? AND hidden_at IS NOT NULL', e.id).changes) {
    audit(e.id, c.actor, 'Put back in the sender\'s lists', 'An admin of the account put this envelope back after it had been removed from the sender\'s lists.');
    record('envelope.restored', { c, about: ['envelope', e.id], details: { status: e.status } });
  }
  return { envelope: publicEnvelope(loadEnvelope(e.id)) };
});

// A send to an address at which an email of this account came back for good in the last weeks is answered 409 with
// "code": "bounced_address" and which address, when and why. Nothing was sent. The same call with a body of
// { "send_anyway": true } sends it. The body is optional: without one the call is what it always was.
route('POST', '/envelopes/:id/send', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const e = mine(c, c.params.id, 'envelope');
  phoneBeforeSend(c);
  // Who pressed Send, now or for later, when it is not the person it belongs to (shares.ts).
  noteSentBy(c, e.id);
  // "send_at": a time to send it later instead of now (timing.ts). It stays a draft until then.
  if (b?.send_at != null && b.send_at !== '') return { send_at: scheduleSend(e, b.send_at, c.actor), envelope: publicEnvelope(loadEnvelope(e.id)) };
  // "sign_now": true from the person the envelope belongs to, when they are the only person on it: no invitation is
  // emailed to them and the answer carries their signing page (signnow.ts). In every other case it changes nothing.
  const now = signNowFor(e, senderOf(e), c.user?.email, b?.sign_now);
  await sendEnvelope(e.id, c.actor, { anyway: b?.send_anyway === true, signNow: now?.id || null });
  // Sent from the sender screen inside an app: that screen ends here (embed.ts).
  endScreenOnSend(c);
  // Sent by hand: a time it was set to go out at is over (timing.ts).
  clearSchedule(e.id);
  const sent = loadEnvelope(e.id);
  const mine_ = now ? sent.recipients.find((r: any) => r.id === now.id) : null;
  return { envelope: publicEnvelope(sent), warnings: sendWarnings(sent), ...(mine_?.token ? { sign_url: signUrl(mine_) } : {}) };
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
  // Someone whose "Only when..." was not met is not on the request at all (routing.ts): said, never a quiet 0.
  const skipped = b?.recipient_id && !one ? e.recipients.find((r: any) => r.id === str(b.recipient_id) && r.status === 'skipped') : null;
  if (skipped) throw bad(`${skipped.name || 'This person'} was not asked, because the rule for them was not met, so there is nothing to remind them of. Nothing was sent. To ask them anyway, add them again with Edit.`, 409, { code: 'not_asked' });
  if (one && mailStop(one)) throw bad(mailStopText(one), 409, { code: mailStop(one) === 'complaint' ? 'marked_as_spam' : 'email_bounced' });
  // Someone whose link the sender passes on has no address at all: named too, so the sender knows to send it again.
  // The member of a signing group who has it and reported it is refused like a person who marked our email as spam.
  // The members of a group nobody has taken on who get no reminder are named, also when only that group is asked.
  const members = membersNotReminded(e, one ? [one] : waiting);
  if (one?.claimed_by && members.length) throw bad(`${one.name} reported this document, so we do not email them about it. Only they can change that, on their signing page. If someone else in ${one.group_name} should act, choose "Give back to the group".`, 409, { code: 'reported' });
  const not_reminded = [...(b?.recipient_id ? [] : waiting.filter((r: any) => mailStop(r) || (r.link_by_sender && !r.email) || (r.place_open && !r.email)).map((r: any) => ({ recipient_id: r.id, name: r.name, why: r.place_open && !r.email ? 'not_named_yet' : r.link_by_sender && !r.email ? 'link_by_sender' : mailStop(r) === 'complaint' ? 'marked_as_spam' : 'email_bounced' }))), ...members];
  return { reminded: await remindEnvelope(e, c.actor, b?.recipient_id ? str(b.recipient_id) : undefined), not_reminded };
});

route('POST', '/envelopes/:id/correct', async (c) => {
  const b = await c.body();
  const e = mine(c, c.params.id, 'envelope');
  // A one-time code or a text message goes to one person, so neither can be asked of a group (groups.ts).
  assertNoGroupCheck(e, str(b.recipient_id), b);
  // Nor a code by email or a texted link for someone who stays without an address (bysender.ts).
  assertBySenderCorrection(e, str(b.recipient_id), b);
  // A check or an access code a locked template gave this person stays (tplroles.ts).
  assertCorrectionKept(c, e, str(b.recipient_id), b);
  // Their language ("locale"): checked first, saved after; another person does not keep the first one's (locales.ts).
  const lang = correctionLocale(e, str(b.recipient_id), b);
  if (lang.only && b.whatsapp === undefined && b.whatsapp_agreed === undefined) {
    const said = lang.apply();
    if (said) audit(e.id, c.actor, 'Recipient corrected', `${e.recipients.find((r: any) => r.id === str(b.recipient_id)).name}: ${said}.`);
    return { ok: true };
  }
  // With their check too ("verify", "phone", "text_link"): correctWithCheck does all of the call or none of it.
  // WhatsApp ("whatsapp": false only) around it: it ends for another person or another number (whatsapp.ts).
  await correctWithWa(e, str(b.recipient_id), b, c.actor, () => correctWithCheck(e, str(b.recipient_id), b, c.actor));
  const said = lang.apply();
  if (said) audit(e.id, c.actor, 'Recipient corrected', `${get('SELECT name FROM recipients WHERE id=?', str(b.recipient_id))?.name}: ${said}.`);
  // A witness who is now another person starts clean, and is asked at once if their signer has signed (witness.ts).
  await witnessCorrected(e.id, str(b.recipient_id), e.recipients.find((r: any) => r.id === str(b.recipient_id)));
  // An address that marked an email of this account as spam keeps that mark through a correction (db.ts), so no email
  // went to it. The answer and the record say so, instead of letting the sender believe one is on its way.
  const after = get('SELECT id, name, email, complained_at FROM recipients WHERE id=?', str(b.recipient_id));
  const was = e.recipients.find((r: any) => r.id === str(b.recipient_id));
  if (after?.complained_at && was && String(was.email || '').toLowerCase() !== String(after.email || '').toLowerCase()) {
    audit(e.id, { name: 'System' }, 'Not emailed', `${after.name} <${after.email}>. This address marked an earlier email from this account as spam, so no email went out. Only that person can start our emails again, on a signing page. The sender can pass on the signing link.`);
    return { ok: true, not_emailed: 'marked_as_spam' };
  }
});

route('POST', '/envelopes/:id/clone', async (c) => {
  const e = mine(c, c.params.id);
  const b = await c.req.json().catch(() => ({}));
  if (b?.kind != null && b.kind !== '' && b.kind !== 'template' && b.kind !== 'envelope')
    throw bad(`"kind" is "${str(b.kind, 40)}", which does not exist. Use "envelope" or "template", or leave it out to copy it as what it is. Nothing was copied.`);
  const kind = b?.kind === 'template' || (e.kind === 'template' && b?.kind !== 'envelope') ? 'template' : 'envelope';
  // A copy keeps the rules of the template it comes from (carryRules). One of a template that is not for everyone or
  // is locked, made by someone who may not set its rules, stays with the person the template belongs to (cloneOwner),
  // so a copy is no way round them. Its history says who made it (noteCopy).
  const senderId = cloneOwner(c, e, kind);
  // A purged envelope has no documents left to copy (records.ts).
  if (e.purged_at) throw bad(`The documents of this envelope were purged on ${dayText(e.purged_at)}, so there is nothing left to copy. Start a new envelope instead.`, 409, { code: 'purged' });
  const eid = copyEnvelope(e, { accountId: c.account.id, senderId, kind, subject: kind === e.kind ? `${e.subject} (copy)`.trim() : e.subject });
  noteCopy(c, eid, e);
  if (senderId !== c.user.id) return { id: eid, belongs_to: get('SELECT name FROM users WHERE id=?', senderId)?.name || null, locked: !!get('SELECT tpl_locked FROM envelopes WHERE id=?', eid)?.tpl_locked };
  return { id: eid };
});

// Embedded signing: get a signing link for one recipient to open inside your own flow.
route('POST', '/envelopes/:id/recipient-view', async (c) => {
  const body = await c.body();
  const rid = str(body.recipient_id);
  const e = mine(c, c.params.id, 'envelope');
  // In a group every member has a link of their own, and "member_id" says whose is wanted (memberLink in groups.ts).
  // "frame_origin": the link for a frame on one of the account's websites, which only that website may show (embed.ts).
  const inFrame = body.frame_origin != null && body.frame_origin !== '';
  const theirs = !inFrame && memberLink(e, rid, body.member_id, c.actor);
  if (theirs) return theirs;
  const r = e.recipients.find((x: any) => x.id === rid);
  const framed = r && inFrame ? framedLink(e, r, body.frame_origin) : null;
  if (!r || !r.token) throw bad('Recipient not found, or the envelope has not been sent.', 404);
  // Handing out the link belongs in the record, but one line a day says it. An integration that asks for the link
  // on every page view must not fill the audit trail, which is printed in full on the certificate. A link that
  // replaced an earlier one (a corrected address, a reassignment) is a new link and gets its own line. One
  // statement decides, so two requests at the same moment still leave one line.
  const first = run(`UPDATE recipients SET link_issued_at=? WHERE id=? AND (link_issued_at IS NULL OR link_issued_at < ?
    OR link_issued_at <= COALESCE((SELECT MAX(retired_at) FROM retired_tokens WHERE recipient_id=recipients.id), ''))`,
    now(), r.id, new Date(Date.now() - 864e5).toISOString()).changes;
  if (first) audit(e.id, c.actor, 'Signing link issued', labelOf(r));
  return { url: framed || signUrl(r) };
});

route('GET', '/envelopes/:id/download', async (c) => {
  const e = mine(c, c.params.id, undefined, { removed: true });
  if (e.purged_at) throw bad(`The documents of this envelope were purged on ${dayText(e.purged_at)} under the account's retention rule or at someone's request. Its record is on the envelope page. A copy someone was emailed or downloaded before is not affected.`, 410, { code: 'purged' });
  if (!e.documents.length) throw bad('This envelope has no documents yet.');
  const done = finalPdf(e);
  // A closed envelope's copy opens with a page that says it was not completed, and is marked across every page, so
  // the signatures already on it never pass for a signed document (senderNotice in evidence.ts).
  return pdfResponse(done || (await buildPdf(e, false, undefined, CLOSED.includes(e.status) ? senderNotice(e) : undefined)), listName(e.subject) || 'document', c.q.get('inline') === '1');
});

// ---- Bulk send -----------------------------------------------------------------------------

// Like envelopes: members see the batches they sent, admins see every batch in the account. A completed envelope
// its sender deleted is not counted.
route('GET', '/bulk', (c) => ({
  batches: all(`SELECT b.id, b.name, b.total, b.created_at, t.subject template,
      (SELECT COUNT(*) FROM envelopes e WHERE e.bulk_id=b.id AND e.hidden_at IS NULL) created, (SELECT COUNT(*) FROM envelopes e WHERE e.bulk_id=b.id AND e.status='completed' AND e.hidden_at IS NULL) completed
    FROM bulk_batches b LEFT JOIN envelopes t ON t.id=b.template_id WHERE b.account_id=?${can(c, 'see_all') ? '' : ' AND b.sender_id=?'} ORDER BY b.created_at DESC LIMIT 50`, ...(can(c, 'see_all') ? [c.account.id] : [c.account.id, c.user.id])),
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
    // One on hold stays, like everything a hold covers (records.ts).
    const orphans = all("SELECT id FROM envelopes WHERE bulk_id=? AND status='draft' AND id NOT IN (SELECT envelope_id FROM bulk_rows WHERE bulk_id=? AND envelope_id IS NOT NULL)", b.id, b.id).map((r) => r.id);
    const onHold = isHeld(orphans);
    for (const oid of orphans) if (!onHold.has(oid)) run("DELETE FROM envelopes WHERE id=? AND status='draft'", oid);
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
          // Who may use the template is asked again for every new copy, like whether the sender is still on the team:
          // a batch repeated with its Idempotency-Key after the template was taken from them sends nothing more.
          const who = asMember(b.account_id, b.sender_id);
          if (who && !mayUse(who, tpl)) throw bad(`Not sent. The template "${str(tpl.subject || 'Untitled template', 120)}" is no longer one the person who started this bulk send may use. Ask ${askWho(tpl)}.`);
          // A row's "fields" fill fields of the template by their label, like the sender's own prefilled values, so a
          // rule that depends on one shows or hides from the first look (fillValues in logic.ts). Whether a column may
          // change the template's own wording is decided for whoever sends the batch (forRows in tplroles.ts).
          const fill = JSON.parse(row.fill);
          eid = copyEnvelope(forRows(who, tpl), { accountId: b.account_id, senderId: b.sender_id, kind: 'envelope', fill, extra: { bulk_id: b.id, values: fill?.fields && typeof fill.fields === 'object' ? fill.fields : null } });
          // A column named like a custom field fills it for this row ("custom_fields", checked before the batch began).
          applyRowCustom(b.account_id, tpl, eid, fill, Number(row.position) || 0);
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
  // A list longer than one batch takes is refused by POST /bulk, so it is counted as it is and refused here in the
  // same words, instead of being counted as its first 500 rows.
  const all_ = Array.isArray(b.rows) ? b.rows.length : 0;
  const tooMany = all_ > 500 ? { status: 400, message: 'Send up to 500 envelopes per batch.' } : null;
  const open = tpl.recipients.filter(rowFills); // a group is filled in by its members, and a witness the signer names by that signer, not by a row or a visitor
  const counted = creditsEnabled();
  const { perRow, need, have } = counted ? batchNeeds(c, tpl, all_) : { perRow: 0, need: 0, have: 0 };
  const short = Math.max(0, need - Math.max(0, have));
  const onPlan = c.account.plan === 'grove';
  const planSignatures = onPlan ? 0 : Math.min(short, PRICING.monthlySignatures);
  const topUp = short - planSignatures;
  const reach = [...tpl.recipients.map((r: any) => r.email), ...groupReach(tpl), ...rows.flatMap((row) => open.map((r: any) => str(row?.[r.role_name || r.id]?.email).trim()))].filter(Boolean);
  // bulkChecksRefusal: a row without the mobile number its role needs, or more text messages than the account may send today.
  const refusal = tooMany || (rows.length ? emailRefusal({ ...tpl, sender_id: c.user.id }, reach) || bulkChecksRefusal(tpl, rows, open) || rowLanguageRefusal(rows, open) || bulkCustomRefusal(c.account.id, tpl, rows) : null);
  return {
    counted, rows: all_, signers_per_row: perRow, need, have: Math.max(0, have), short, plan: c.account.plan,
    cost: counted && short > 0 ? { usd: (onPlan ? 0 : PRICING.monthlyUsd) + topUp * PRICING.topUpUsd, plan_usd: onPlan ? 0 : PRICING.monthlyUsd, plan_signatures: onPlan ? 0 : PRICING.monthlySignatures, top_up: topUp, top_up_usd: topUp * PRICING.topUpUsd } : null,
    refusal: refusal ? { status: refusal.status, message: refusal.message } : null,
    // Whether the envelopes of this batch remind people by themselves: they take the template's setting.
    reminder_days: tpl.reminder_days || 0, reminders: reminderText(tpl.reminder_days),
    // Addresses in this list at which an email of the account came back for good in the last weeks, each with the
    // day and why. Not a refusal: POST /bulk sends to them when it carries "send_anyway": true, and says so otherwise.
    bounced: rows.length ? bouncedBefore(c.account.id, reach).map((x) => ({ email: x.email, bounced_at: x.at, reason: x.reason, line: bouncedLine(x) })) : [],
  };
});

route('POST', '/bulk', async (c) => {
  const b = await c.body();
  phoneBeforeSend(c);
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
  // Each copy of a Send to many goes out by itself, so nobody on it can change it or choose who comes next (agents.ts).
  assertNoStepRoles(tpl, 'bulk');
  const rows: any[] = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) throw bad('Add at least one row of recipients.');
  if (rows.length > 500) throw bad('Send up to 500 envelopes per batch.');
  const open = tpl.recipients.filter(rowFills); // a group is filled in by its members, and a witness the signer names by that signer, not by a row or a visitor
  // A row that names a person for a group's role, or a group that is gone: the whole batch is refused, nothing left behind (groups.ts).
  assertTemplateGroups(tpl, rows, true, true);
  rows.forEach((row, i) => {
    for (const r of open) {
      const v = row?.[r.role_name || r.id];
      if (!v || !str(v.name).trim() || !isEmail(str(v.email).trim())) throw bad(`Row ${i + 1}: "${r.role_name || 'Recipient'}" needs a name and a valid email.`);
    }
    // Fields a row fills ("fields": {"Plan": "Gold"}) are checked for every row before anything is sent (logic.ts).
    const wrong = rowFieldProblem(forRows(c, tpl), row?.fields);
    if (wrong) throw bad(`Row ${i + 1}: ${wrong} Nothing was sent.`);
  });
  // A role the template checks or reaches by text message needs a mobile number ("phone") in every row, and the
  // account must be allowed that many texts today. Refused for the whole batch, like everything below.
  assertBulkChecks(tpl, rows, open);
  // A row's custom fields, and a value for every one the account requires, from the row or the template (customfields.ts).
  assertBulkCustom(c.account.id, tpl, rows);
  // A row's "language" for a role must be one that is switched on, for every row, before anything is sent (locales.ts).
  assertRowLanguages(rows, open);
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
  if (!b || (!can(c, 'see_all') && b.sender_id !== c.user.id)) throw bad('Batch not found.', 404);
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
    // One its sender paused is passed over: it takes no reminders until it is resumed (timing.ts).
    if (e?.status === 'sent' && !e.paused_at) reminded += await remindEnvelope(e, c.actor);
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

export function powerformTemplate(templateId: string) {
  const tpl = loadEnvelope(templateId);
  if (!tpl || tpl.kind !== 'template') throw bad('Template not found.', 404);
  const open = tpl.recipients.filter(rowFills); // a group is filled in by its members, and a witness the signer names by that signer, not by a row or a visitor
  if (open.length !== 1 || !['signer', 'approver'].includes(open[0].role)) throw bad('A PowerForm needs a template with exactly one open signer role. Give every other recipient a name and email in the template.');
  // Anyone can start a public form, as often as they like. A signing group on its template would let any visitor
  // make every member of that group get an email, so a form never sends to a group (groups.ts).
  if (tpl.recipients.some((r: any) => r.group_name || r.group_id))
    throw bad('This form cannot be used while its template names a signing group: anyone who opens a public form could make every member of that group get an email. Its owner can name one person for that role in the template instead.');
  return { tpl, open: open[0] };
}

// A public form sends in the name of the person its template belongs to, uses that account's signatures, and its
// template cannot be deleted while the form exists. So publishing a template as a form, and pausing, changing or
// deleting the form, is for the people who may change the template: the person it belongs to, admins, and whoever
// its rule lets change it (tplroles.ts). Everyone who may use the template sees the forms and can hand out their links.
const mayRunForm = (c: Ctx, tpl: any) => !!tpl && mayChange(c, tpl);
export function assertMayRunForm(c: Ctx, tpl: any, doing: string) {
  if (mayRunForm(c, tpl)) return;
  const owner = (tpl && get('SELECT name FROM users WHERE id=?', tpl.sender_id)?.name) || 'a colleague';
  const chosen = tpl?.tpl_change === 'chosen' ? `${owner}, an admin of your team or a member they chose` : `${owner} or an admin of your team`;
  // A copy of a locked template, or of one not for everyone, stays with its owner (cloneOwner), so a copy is no way to
  // a form of one's own there, and the refusal does not suggest one.
  throw bad(`This template belongs to ${owner}, so only ${chosen} can ${doing}. Nothing was changed. ${tpl?.tpl_locked ? `Its wording is locked, so a copy would be locked in the same way. Ask ${owner} or an admin of your team.` : tpl && !copyIsTheirs(c, tpl) ? `It is not for everyone on the team, so a copy would belong to ${owner} too. Ask ${owner} or an admin of your team.` : 'To have a PowerForm of your own, copy the template and make the PowerForm from your copy.'}`, 403);
}
// How many questions a visitor answers before the document (webforms.ts). A template that cannot be a form has none.
function questionCount(templateId: string): number {
  try {
    const { tpl, open } = powerformTemplate(templateId);
    return formQuestions(tpl, open).length;
  } catch (err) {
    if (err instanceof HttpError) return 0;
    throw err;
  }
}
// How many of the visitor's fields have no label, so the form opens as the document instead of questions (webforms.ts).
function unlabelledOf(templateId: string): number {
  try {
    const { tpl, open } = powerformTemplate(templateId);
    return unlabelledCount(tpl.fields, open.id);
  } catch (err) {
    if (err instanceof HttpError) return 0;
    throw err;
  }
}
// The form a call names, for someone who may change it. The same answer for a form that does not exist and for one
// in another account.
function formToChange(c: Ctx, doing: string) {
  const p = get('SELECT * FROM powerforms WHERE id=? AND account_id=?', c.params.id, c.account.id);
  if (!p) throw bad('That PowerForm does not exist any more. It may have been deleted already.', 404);
  assertMayRunForm(c, get('SELECT * FROM envelopes WHERE id=?', p.template_id), doing);
  return p;
}

// share_link: the form's readable address, growsigning.com/<name> (sharelinks.ts). While it is on, "url" is that
// address, so Copy link and the QR code carry it; the address with the slug keeps working beside it.
const formShare = (p: any) => {
  const share_link = shareLinkOf('form', p.id);
  return { url: share_link?.active ? share_link.url : `${baseUrl()}/f/${p.slug}`, share_link };
};
route('GET', '/powerforms', (c) => ({
  // "uses" counts every start. "signed" is what people finished, and "open" is who is filling one in right now.
  // may_change says whether this person may pause, change or delete the form, and owner whose template it is on.
  powerforms: all(`SELECT p.id, p.slug, p.name, p.active, p.uses, p.shared_device, p.created_at, p.max_signed, p.closes_at, p.closes_day, t.subject template, p.template_id template_ref, u.name owner,
      (SELECT COUNT(*) FROM envelopes e JOIN recipients r ON r.id=e.form_recipient_id WHERE e.powerform_id=p.id AND r.status='completed') signed,
      (SELECT COUNT(*) FROM envelopes e JOIN recipients r ON r.id=e.form_recipient_id WHERE e.powerform_id=p.id AND e.status='sent' AND r.status IN ('pending','sent','viewed')) open
    FROM powerforms p LEFT JOIN envelopes t ON t.id=p.template_id LEFT JOIN users u ON u.id=t.sender_id WHERE p.account_id=? ORDER BY p.created_at DESC`, c.account.id)
    // url is the public address of the form, built from APP_URL like every link in an email and never from a
    // request header. The app copies it and draws the form's QR code from it.
    // A form on a template this person may not use is not listed, like the template itself (tplroles.ts).
    .map(({ template_ref, ...p }) => ({ p, t: get('SELECT * FROM envelopes WHERE id=?', template_ref) }))
    .filter(({ t }) => !t || can(c, 'edit_any_template') || mayUse(c, t))
    // reminders: whether the envelope each visitor starts reminds them by itself, which it takes from the template.
    .map(({ p, t }) => ({ ...p, shared_device: !!p.shared_device, may_change: mayRunForm(c, t), ...formShare(p), reminders: t ? reminderText(t.reminder_days) : null, questions: t ? questionCount(t.id) : 0, unlabelled: t ? unlabelledOf(t.id) : 0 })),
}));
route('POST', '/powerforms', async (c) => {
  const b = await c.body();
  phoneBeforeSend(c);
  const tpl = mine(c, str(b.template_id), 'template');
  assertMayRunForm(c, tpl, 'publish it as a PowerForm');
  // Nobody can change the document or choose who comes next on a form: each visitor fills it in alone (agents.ts).
  assertNoStepRoles(tpl, 'form');
  // A visitor types their own details, so the open role can be checked with a code by email and never by text.
  assertFormChecks(powerformTemplate(tpl.id).open);
  // A form whose every start would be refused because it reads like a fake payment notice (its name is the subject
  // of what visitors are sent) is refused here, with the words that set it off, and not later for each visitor.
  const name = str(b.name, 120) || tpl.subject || 'PowerForm';
  const no = emailRefusal({ ...powerformTemplate(tpl.id).tpl, subject: name }, [], { pause: false });
  if (no) throw bad(`${no.message} The form was not made.`, no.status);
  // A template whose fields cover each other is refused here too, not found out from the first visitor.
  assertFormNotStacked(tpl.id);
  // A visitor cannot fill custom fields in, so a required one needs its value in the template (customfields.ts).
  const noCustom = formCustomProblem(tpl);
  if (noCustom) throw bad(`${noCustom} The form was not made.`);
  const pid = id('pwf');
  run('INSERT INTO powerforms (id, account_id, template_id, slug, name, created_at, shared_device) VALUES (?,?,?,?,?,?,?)', pid, c.account.id, tpl.id, token(9), name, now(), b.shared_device ? 1 : 0);
  // A form is public from the start, so it gets its readable address at once when a free name comes out of its name.
  return { id: pid, share_link: autoShareLink('form', pid, c.account.id, name) };
});
route('PATCH', '/powerforms/:id', async (c) => {
  // Only what the call names is changed, so pausing a form does not also change how it treats a shared device.
  const b = await c.body();
  const form = formToChange(c, 'pause or change this PowerForm');
  // "max_signed" and "closes_at": how many may sign it, and until when (switches.ts).
  saveFormLimits(form, b);
  if (b.active !== undefined) run('UPDATE powerforms SET active=? WHERE id=? AND account_id=?', b.active ? 1 : 0, c.params.id, c.account.id);
  if (b.shared_device !== undefined) run('UPDATE powerforms SET shared_device=? WHERE id=? AND account_id=?', b.shared_device ? 1 : 0, c.params.id, c.account.id);
});
route('DELETE', '/powerforms/:id', (c) => {
  formToChange(c, 'delete this PowerForm');
  run('DELETE FROM powerforms WHERE id=? AND account_id=?', c.params.id, c.account.id);
  dropShareLinks('form', c.params.id);
});

route('GET', '/public/powerforms/:slug', async (c) => {
  const p = get('SELECT * FROM powerforms WHERE slug=? AND active=1', c.params.slug);
  if (!p) throw bad('This form is not available.', 404);
  const a = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', p.account_id);
  const { tpl, open } = powerformTemplate(p.template_id);
  // A page that would print a fake payment notice (a form made before that was refused) is closed, prints neither
  // its name nor the account's, and its owner is told why. See formPageRefusal.
  const posing = formPageRefusal(get('SELECT * FROM accounts WHERE id=?', p.account_id), p.name);
  if (posing) await tellFormOwner(p, tpl.sender_id, posing);
  // A required custom field the template has no value for: closed before anyone types, and its owner is told.
  const noCustom = posing ? null : formCustomProblem(tpl);
  if (noCustom) await tellFormOwner(p, tpl.sender_id, noCustom);
  // Said before anyone types their name and address into a form that cannot take them.
  return { name: posing ? null : p.name, role: open.role_name || 'Signer', pages: tpl.documents.reduce((n: number, d: any) => n + d.pages, 0), brand: posing ? null : a, closed: !!posing || !!noCustom || formClosed(p, tpl) || !!formLimitClosed(p),
    // Closed because it reached the number of signatures it was set up for, or its closing date: said, with whom to ask.
    closed_why: posing || noCustom ? null : formLimitClosed(p), shared_device: !!p.shared_device, trees: showsTrees(p.account_id),
    // Trees the visitor's signature plants (5), for the line at the top of the form page. 0 says nothing: tree words off, or no plans here.
    // Also 0 when the form cannot take this visitor: closed, or its owner has no signature free (the start would be
    // refused), so nobody is promised trees for a signature that cannot be made.
    plants: showsTrees(p.account_id) && creditsEnabled() && !(posing || noCustom || formClosed(p, tpl) || formLimitClosed(p)) && available(p.account_id) >= 1 ? treesForSignature() : 0,
    // The questions the visitor answers before the document (webforms.ts), with what the form page needs to check them.
    ...(posing || noCustom ? { questions: [] } : formView(tpl, open)) };
}, 'public');

// The owner of a form hears why it could not take someone, in plain words and once a day at most. The visitor is
// told only that the form cannot take new signatures right now.
async function tellFormOwner(p: any, ownerId: string, why: string) {
  if (p.alerted_at && Date.parse(p.alerted_at) >= Date.now() - 864e5) return;
  run('UPDATE powerforms SET alerted_at=? WHERE id=?', now(), p.id);
  const owner = get('SELECT email FROM users WHERE id=?', ownerId);
  if (owner) await sendMail({ to: owner.email, subject: `Your form "${p.name}" could not take a signature`, heading: 'Someone tried to sign your form and could not', lines: [`What stopped it: ${why}`, 'They were told only that the form cannot take new signatures right now, and nothing of theirs was kept.'], cta: { label: 'Open your forms', url: `${baseUrl()}/app/powerforms` } });
}

// Why an owner cannot send right now (a pause, an address that was never confirmed, an account that is being
// closed) is the owner's business. A visitor is told only that the form is closed for now, before they type
// anything, and nothing of theirs is kept.
const FORM_CLOSED = 'This form cannot take new signatures right now. Please contact whoever gave you the link.';
export const formClosed = (p: any, tpl: any): boolean => {
  const a = get('SELECT suspended_at s, closing_at c FROM accounts WHERE id=?', p.account_id);
  return !get('SELECT email_verified v FROM users WHERE id=?', tpl.sender_id)?.v || !!a?.s || !!a?.c;
};

// Every start emails an address a stranger typed, so one internet connection may start ordinary public forms only
// so often an hour, all of them together. A form its owner marked as filled in on a shared device has a much larger
// count of its own: a front desk sends everyone through one connection, and two people a minute must not lock it.
// The refusal says what the limit is, how long to wait and what the owner can do.
function formStartLimit(c: Ctx, p: any) {
  const shared = !!p?.shared_device;
  const [key, most] = shared ? [`pfs:${p.id}:${c.ip}`, POWERFORM_SHARED_STARTS_PER_HOUR] : [`pf:${c.ip}`, POWERFORM_STARTS_PER_HOUR];
  try {
    rateLimit(key, most, 3600_000);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 429) throw e;
    const mins = Math.max(1, Math.ceil(rateWait(key, most) / 60_000));
    const wait = `Please try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
    throw bad(shared
      ? `This form has been started ${most} times within an hour from this internet connection, which is as many as a form on a shared device takes in an hour. ${wait} Until then, people can fill it in on their own phones: whoever runs the form can show them its QR code.`
      : `Public forms have been started ${most} times within an hour from your internet connection, which is as many as we allow. ${wait} If many people fill this form in at the same place, ask whoever gave you the link to mark it as used on a shared device: such a form takes up to ${POWERFORM_SHARED_STARTS_PER_HOUR} people an hour.`, 429);
  }
}

route('POST', '/public/powerforms/:slug/start', async (c) => {
  const p = get('SELECT * FROM powerforms WHERE slug=? AND active=1', c.params.slug);
  formStartLimit(c, p);
  if (!p) throw bad('This form is not available.', 404);
  const b = await c.body();
  const name = str(b.name, 120).trim();
  const email = str(b.email, 254).trim();
  if (!name || !isEmail(email)) throw bad('Enter your name and a valid email address.');
  const { tpl, open } = powerformTemplate(p.template_id);
  if (formClosed(p, tpl)) throw bad(FORM_CLOSED, 503);
  const full = formLimitClosed(p);
  if (full) throw bad(full, 403, { code: 'form_closed' });
  // Answers from the form's questions are checked before anything is made (webforms.ts).
  const answers = checkAnswers(p, tpl, open, b.answers);
  // Opening the form twice must not create two envelopes. But an email address proves nothing, because anyone can
  // type somebody else's. So an unfinished start is only handed back to the browser that made it, which has held a
  // cookie since then, and only when the same name and address are typed again. Everyone else, and every other
  // name at a shared address, gets a fresh, empty document.
  const jar = `ts_pf_${p.id}`;
  const [started, seal] = (readCookie(c.req, jar) || '').split('.');
  if (started && seal && safeEqual(seal, hmac(`pf:${p.id}:${started}`))) {
    const again = get("SELECT r.token, r.id FROM envelopes e JOIN recipients r ON r.id=e.form_recipient_id WHERE e.id=? AND e.powerform_id=? AND e.status='sent' AND r.status IN ('sent','viewed') AND r.email=? AND lower(r.name)=lower(?)", started, p.id, email, name);
    if (again) {
      // Answers given again (the person went back to the form to fix one) go into the start they pick up, so what
      // they checked is what they sign (webforms.ts resumeAnswers).
      if (answers) resumeAnswers(started, tpl, open, again.id, answers);
      dropDraft(c, p);
      return { url: `${baseUrl()}/sign/${again.token}`, resumed: true };
    }
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
  // What one visitor's envelope needs is worked out the way sending counts it: the visitor, and anyone else the
  // template has who signs (a colleague who countersigns, say). A start is refused only when what is free does not
  // cover that.
  const owner = get('SELECT email, name FROM users WHERE id=?', tpl.sender_id) || '';
  const need = creditsEnabled() ? tpl.recipients.filter((r: any) => isChargeable(r.id === open.id ? { role: r.role, email, name } : { role: r.role, email: r.email, name: r.name }, owner)).length : 0;
  if (need > 0 && available(p.account_id) < need) {
    await formNeedsSignatures(p.account_id, p.id, 'start', need);
    throw bad('This form cannot take new signatures right now. Please try again a little later, or contact the people who sent you here.', 503);
  }
  const eid = copyEnvelope(tpl, { accountId: p.account_id, senderId: tpl.sender_id, kind: 'envelope', subject: p.name, fill: { [open.id]: { name, email, locale: visitorLocale(c.req) ?? undefined } }, extra: { powerform_id: p.id } });
  // Which recipient is the visitor and which device address started it, so a later visit can be matched to this
  // start by more than an email address, and so unfinished starts can be counted and cleared.
  const visitor = get('SELECT id FROM recipients WHERE envelope_id=? AND position=?', eid, open.position);
  run('UPDATE envelopes SET form_recipient_id=?, form_ip=? WHERE id=?', visitor?.id ?? null, c.ip, eid);
  try {
    if (visitor) fillAnswers(eid, tpl, visitor.id, answers);
  } catch (err) {
    run('DELETE FROM envelopes WHERE id=?', eid);
    throw err;
  }
  try {
    await sendEnvelope(eid, { name: `${name} <${email}> via PowerForm`, ip: c.ip, ua: c.ua });
  } catch (err) {
    // Whatever stopped the send (the owner's daily limit, a rule about what may be sent), no stray draft with the
    // visitor's name and address is left behind, the visitor gets the neutral words, and the owner gets the real
    // reason (once a day at most).
    run('DELETE FROM envelopes WHERE id=?', eid);
    if (!(err instanceof HttpError)) throw err;
    await tellFormOwner(p, tpl.sender_id, err.message);
    throw bad(FORM_CLOSED, 503);
  }
  run('UPDATE powerforms SET uses=uses+1 WHERE id=?', p.id);
  dropDraft(c, p); // what this browser kept of the form's answers is in the envelope now
  // A form made before fields that cover each other were refused takes its visitors, and its owner is told.
  await tellStackedForm(p, tpl.sender_id);
  // The cookie that lets this browser, and nobody else, pick this start up again. It lasts as long as the start can.
  c.cookies.push(cookie(jar, `${eid}.${hmac(`pf:${p.id}:${eid}`)}`, Math.ceil(p.shared_device ? powerformSharedIdleMinutes() * 60 : powerformIdleHours() * 3600), c.secure));
  const me = visitor && get("SELECT token FROM recipients WHERE id=? AND status != 'pending'", visitor.id);
  // If someone else signs first in the routing order, the signer simply gets an email when it is their turn.
  return me ? { url: `${baseUrl()}/sign/${me.token}` } : { queued: true };
}, 'public');
