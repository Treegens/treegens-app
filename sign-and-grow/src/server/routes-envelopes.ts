import { route, json, pdfResponse, type Ctx } from './router.ts';
import { all, get, run, tx, saveBlob, readBlob } from './db.ts';
import { bad, id, token, now, str, rateLimit, isEmail, baseUrl, sha256, HttpError } from './util.ts';
import { inspectPdf, imageToPdf } from './pdf.ts';
import { extractText } from './text.ts';
import { sendMail } from './mail.ts';
import { creditsEnabled, available, isChargeable } from './credits.ts';
import {
  loadEnvelope, publicEnvelope, createEnvelope, saveDraft, copyEnvelope, sendEnvelope, voidEnvelope, remindEnvelope,
  correctRecipient, correctEnvelope, extendEnvelope, auditTrail, verifyChain, buildPdf, finalPdf, audit, signUrl, outOfSignatures,
  advance, assertMayEmail, type Actor,
} from './envelopes.ts';
import { hmac, safeEqual } from './util.ts';
import { cookie, readCookie } from './auth.ts';
import { powerformIdleHours, POWERFORM_OPEN_STARTS } from '../lib/policy.ts';

// ---- Files ---------------------------------------------------------------------------------

export async function storeUpload(c: Ctx, accountId: string | null) {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw bad('Choose a file to upload.');
  if (file.size > 25_000_000) throw bad('That file is larger than 25 MB. Save it with smaller images or split it into parts, then upload again.');
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPdf && !isPng && !isJpg) throw bad('Upload a PDF, PNG or JPEG. Export Word or Google Docs files as PDF first.');
  if (!isPdf) bytes = await imageToPdf(bytes, isPng ? 'image/png' : 'image/jpeg');
  const info = await inspectPdf(bytes);
  if (info.pages > 500) throw bad('That document has more than 500 pages. Split it into smaller documents and add them one by one.');
  const fid = id('fil');
  const name = str(file.name, 200).replace(/\.(pdf|png|jpe?g)$/i, '') || 'Document';
  // Text is kept for the sender's own search. Files uploaded by signers are not indexed.
  const text = isPdf && accountId ? await extractText(bytes) : '';
  run('INSERT INTO files (id, account_id, sha256, name, size, pages, page_sizes, created_at, text) VALUES (?,?,?,?,?,?,?,?,?)', fid, accountId, saveBlob(bytes), name, bytes.length, info.pages, JSON.stringify(info.sizes), now(), text || null);
  // A PDF with no text at all is almost always a scan: it cannot be searched, and screen readers cannot read it.
  return { id: fid, name, pages: info.pages, page_sizes: info.sizes, is_scan: isPdf && !!accountId && !text.trim() };
}

route('POST', '/files', (c) => storeUpload(c, c.account.id));
route('GET', '/files/:id/content', (c) => {
  const f = get('SELECT * FROM files WHERE id=? AND account_id=?', c.params.id, c.account.id);
  if (!f) throw bad('File not found.', 404);
  return pdfResponse(readBlob(f.sha256), f.name, true);
});

// ---- Envelopes and templates ---------------------------------------------------------------

function mine(c: Ctx, envelopeId: string, kind?: string) {
  const e = loadEnvelope(envelopeId);
  if (!e || e.account_id !== c.account.id || (kind && e.kind !== kind)) throw bad('Envelope not found.', 404);
  // Members see what they sent. Admins see the whole account. Templates are shared with the team.
  if (e.kind === 'envelope' && !c.admin && e.sender_id !== c.user.id) throw bad('Envelope not found.', 404);
  return e;
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
  const kind = c.q.get('kind') === 'template' ? 'template' : 'envelope';
  const box = c.q.get('box') || 'all';
  const where = ['e.account_id=?', 'e.kind=?'];
  const p: any[] = [c.account.id, kind];
  if (kind === 'envelope' && !c.admin) (where.push('e.sender_id=?'), p.push(c.user.id));
  const boxes: Record<string, string> = { drafts: "e.status='draft'", sent: "e.status!='draft'", waiting: "e.status='sent'", completed: "e.status='completed'", closed: "e.status IN ('voided','declined','expired')" };
  if (kind === 'envelope' && boxes[box]) where.push(boxes[box]);
  if (c.q.get('folder')) (where.push('e.folder=?'), p.push(c.q.get('folder')));
  if (c.admin && c.q.get('sender')) (where.push('e.sender_id=?'), p.push(c.q.get('sender')));
  const q = (c.q.get('q') || '').trim();
  if (q) {
    // Matches the subject, the envelope id, anyone on it, a document's name, or the words inside the documents.
    where.push(`(e.subject LIKE ? OR e.id = ? OR EXISTS (SELECT 1 FROM recipients r WHERE r.envelope_id=e.id AND (r.name LIKE ? OR r.email LIKE ?))
      OR EXISTS (SELECT 1 FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=e.id AND (d.name LIKE ? OR f.text LIKE ?)))`);
    p.push(`%${q}%`, q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const limit = Math.min(200, Number(c.q.get('limit')) || 100);
  const rows = all(`SELECT e.id, e.kind, e.status, e.subject, e.folder, e.created_at, e.updated_at, e.sent_at, e.completed_at, e.expires_at, e.sheets, e.bulk_id, u.name sender
    FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE ${where.join(' AND ')} ORDER BY e.updated_at DESC LIMIT ? OFFSET ?`, ...p, limit, Number(c.q.get('offset')) || 0);
  for (const e of rows) {
    e.recipients = all('SELECT id, name, email, role, role_name, status, sent_at, muted FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', e.id);
    // True when the latest email to someone who has not opened it yet did not leave. Lets the list flag it.
    e.email_failed = all("SELECT m.status FROM emails m WHERE m.envelope_id=? AND m.id IN (SELECT MAX(id) FROM emails WHERE envelope_id=? GROUP BY COALESCE(recipient_id, to_email))", e.id, e.id).some((m) => m.status === 'failed');
    e.pages = get('SELECT COALESCE(SUM(f.pages),0) n FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=?', e.id).n;
  }
  const folders = all("SELECT DISTINCT folder FROM envelopes WHERE account_id=? AND kind=? AND folder IS NOT NULL AND folder != ''", c.account.id, kind).map((r) => r.folder);
  // Admins can narrow the list to one person's envelopes.
  const senders = c.admin ? all('SELECT DISTINCT u.id, u.name FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE e.account_id=? AND e.kind=? ORDER BY u.name', c.account.id, kind) : [];
  return { envelopes: rows, folders, senders };
});

// Documents addressed to the signed-in user, from any sender.
route('GET', '/inbox', (c) => {
  if (!c.user.email_verified) return { needs_verification: true, items: [] };
  return {
    items: all(`SELECT e.id, e.subject, e.status, e.sent_at, e.completed_at, u.name sender, r.role, r.status my_status, r.token
      FROM recipients r JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id
      WHERE r.email=? AND e.kind='envelope' AND e.status!='draft' AND r.status!='pending' AND r.role!='inperson' ORDER BY e.updated_at DESC LIMIT 100`, c.user.email),
  };
});

route('POST', '/envelopes', async (c) => {
  const b = await c.body();
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
      if (b.documents || b.recipients || b.fields) saveDraft(loadEnvelope(eid), b, c.account.id);
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
      await sendEnvelope(eid, c.actor);
    } catch (e) {
      // "Create and send" either sends or leaves nothing behind. No stray drafts after a refusal, and the key is
      // free again, so the same call can be repeated once the reason for the refusal is fixed.
      run('DELETE FROM envelopes WHERE id=?', eid);
      throw e;
    }
  }
  return { envelope: publicEnvelope(loadEnvelope(eid)) };
});

route('GET', '/envelopes/:id', (c) => {
  const e = mine(c, c.params.id);
  // Whether each email actually left, so "I never got it" can be answered without guessing.
  const deliveries = all('SELECT to_email, recipient_id, subject, status, error, at FROM emails WHERE envelope_id=? ORDER BY id DESC LIMIT 60', e.id);
  // How far each signer has got, so the sender can help someone who is stuck without being able to sign for them.
  const env = publicEnvelope(e);
  for (const r of env.recipients) {
    const theirs = e.fields.filter((f: any) => f.recipient_id === r.id && !f.readonly && !['date_signed', 'full_name', 'email'].includes(f.type));
    r.progress = { fields: theirs.length, filled: theirs.filter((f: any) => f.value).length, required_left: theirs.filter((f: any) => f.required && !f.value).length };
  }
  return { envelope: env, audit: auditTrail(e.id), chain: verifyChain(e.id), deliveries };
});

// Reading a request body means waiting, and while a handler waits another request can send, sign, void or complete
// the same envelope. So a handler that changes what an envelope holds, its deadline or its status reads the body
// first and looks the envelope up after it, with nothing waited for between that look and the change. One that
// looked first would act on a copy that is out of date.

// Drafts are simply saved. An envelope that is already out is corrected in place: no void, no resend, no extra count.
route('PUT', '/envelopes/:id', async (c) => {
  const b = await c.body();
  const e = mine(c, c.params.id);
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
  const b = await c.body();
  if ('folder' in b) run('UPDATE envelopes SET folder=? WHERE id=?', str(b.folder, 80).trim() || null, e.id);
});

route('DELETE', '/envelopes/:id', (c) => {
  const e = mine(c, c.params.id);
  if (e.status === 'sent') throw bad('Void this envelope before deleting it.');
  if (e.kind === 'template' && get('SELECT 1 x FROM powerforms WHERE template_id=?', e.id)) throw bad('A PowerForm still uses this template. Delete the PowerForm first.');
  run('DELETE FROM envelopes WHERE id=?', e.id);
});

route('POST', '/envelopes/:id/send', async (c) => {
  const e = mine(c, c.params.id, 'envelope');
  await sendEnvelope(e.id, c.actor);
  return { envelope: publicEnvelope(loadEnvelope(e.id)) };
});

route('POST', '/envelopes/:id/void', async (c) => {
  // Two Void requests at the same moment, or a void that crosses the last signature: the second one sees the
  // envelope as it now is and is refused, instead of voiding (and emailing everyone about) a copy from before.
  const reason = str((await c.body()).reason, 500);
  await voidEnvelope(mine(c, c.params.id, 'envelope'), reason, c.actor);
});

route('POST', '/envelopes/:id/remind', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return { reminded: await remindEnvelope(mine(c, c.params.id, 'envelope'), c.actor, b?.recipient_id ? str(b.recipient_id) : undefined) };
});

route('POST', '/envelopes/:id/correct', async (c) => {
  const b = await c.body();
  await correctRecipient(mine(c, c.params.id, 'envelope'), str(b.recipient_id), b, c.actor);
});

route('POST', '/envelopes/:id/clone', async (c) => {
  const e = mine(c, c.params.id);
  const b = await c.req.json().catch(() => ({}));
  const kind = b?.kind === 'template' || (e.kind === 'template' && b?.kind !== 'envelope') ? 'template' : 'envelope';
  const eid = copyEnvelope(e, { accountId: c.account.id, senderId: c.user.id, kind, subject: kind === e.kind ? `${e.subject} (copy)`.trim() : e.subject });
  return { id: eid };
});

// Embedded signing: get a signing link for one recipient to open inside your own flow.
route('POST', '/envelopes/:id/recipient-view', async (c) => {
  const rid = str((await c.body()).recipient_id);
  const e = mine(c, c.params.id, 'envelope');
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
  const e = mine(c, c.params.id);
  if (!e.documents.length) throw bad('This envelope has no documents yet.');
  const done = finalPdf(e);
  return pdfResponse(done || (await buildPdf(e, false)), e.subject || 'document', c.q.get('inline') === '1');
});

// ---- Bulk send -----------------------------------------------------------------------------

route('GET', '/bulk', (c) => ({
  batches: all(`SELECT b.id, b.name, b.total, b.created_at, t.subject template,
      (SELECT COUNT(*) FROM envelopes e WHERE e.bulk_id=b.id) created, (SELECT COUNT(*) FROM envelopes e WHERE e.bulk_id=b.id AND e.status='completed') completed
    FROM bulk_batches b LEFT JOIN envelopes t ON t.id=b.template_id WHERE b.account_id=? ORDER BY b.created_at DESC LIMIT 50`, c.account.id),
}));

// Batches that a request in this process is sending right now. A repeat of the call never sends alongside it: it is
// told how far the first has got. The list lives in memory, so it is empty again after a restart, and that is the
// one moment a batch can be left half sent with nobody working on it. A repeat with the same key then finishes it.
const sendingNow: Set<string> = ((globalThis as any).__tsbulk ??= new Set());

// Sends every row of a batch that has not been tried yet, one after another, and writes each outcome to the batch
// record as it happens. It can be run again on a batch that stopped half way: a row that went out is never sent
// again, a copy that was made but not sent is sent, and the rest are made and sent.
async function sendBatch(b: { id: string; account_id: string; sender_id: string; template_id: string }, actor: Actor) {
  sendingNow.add(b.id);
  try {
    // A draft in the batch that no row points at was made in the instant before the process stopped. Its row is
    // still open and makes a new copy, so the old one goes.
    run("DELETE FROM envelopes WHERE bulk_id=? AND status='draft' AND id NOT IN (SELECT envelope_id FROM bulk_rows WHERE bulk_id=? AND envelope_id IS NOT NULL)", b.id, b.id);
    const tpl = loadEnvelope(b.template_id);
    for (const row of all('SELECT position, fill, envelope_id FROM bulk_rows WHERE bulk_id=? AND sent_at IS NULL AND error IS NULL ORDER BY position', b.id)) {
      const set = (what: string, ...p: any[]) => run(`UPDATE bulk_rows SET ${what} WHERE bulk_id=? AND position=?`, ...p, b.id, row.position);
      try {
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
        if (status === 'draft') await sendEnvelope(eid, actor);
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
  return { id: bulkId, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => r.error), pending: results.filter((r) => r.pending).length, results };
}

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
    if (!busy) await sendBatch(prior, c.actor);
    return json(batchResult(prior.id), busy ? 202 : 200, { 'idempotent-replay': 'true' });
  }
  const tpl = mine(c, str(b.template_id), 'template');
  const rows: any[] = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) throw bad('Add at least one row of recipients.');
  if (rows.length > 500) throw bad('Send up to 500 envelopes per batch.');
  const open = tpl.recipients.filter((r: any) => !r.email);
  rows.forEach((row, i) => {
    for (const r of open) {
      const v = row?.[r.role_name || r.id];
      if (!v || !str(v.name).trim() || !isEmail(str(v.email).trim())) throw bad(`Row ${i + 1}: "${r.role_name || 'Recipient'}" needs a name and a valid email.`);
    }
  });
  // A pause, the fake-notice filter and the daily limit refuse the whole batch before anything is written, instead of
  // failing it row by row. Every address in every row counts as a person emailed.
  assertMayEmail({ ...tpl, sender_id: c.user.id }, [...tpl.recipients.map((r: any) => r.email), ...rows.flatMap((row) => open.map((r: any) => str(row[r.role_name || r.id].email).trim()))].filter(Boolean));
  // Check the whole batch against the balance first, so it never stops half way through.
  if (creditsEnabled()) {
    const perRow = tpl.recipients.filter((r: any) => isChargeable({ role: r.role, email: r.email || 'someone-else' }, c.user.email)).length;
    const have = available(c.account.id);
    // A batch that needs none (approvals, viewers, copies) goes out whatever the balance.
    if (perRow > 0 && perRow * rows.length > have) throw bad(outOfSignatures(c.account, perRow * rows.length, have), 402);
  }
  // The batch and every one of its rows are written down together before anything is sent, so the record always
  // says what was asked for and how far it got. Nothing is waited for between the key lookup above and this.
  const made = { id: id('blk'), account_id: c.account.id, sender_id: c.user.id, template_id: tpl.id };
  tx(() => {
    run('INSERT INTO bulk_batches (id, account_id, sender_id, template_id, name, total, created_at, idem_key, request_hash) VALUES (?,?,?,?,?,?,?,?,?)',
      made.id, made.account_id, made.sender_id, tpl.id, str(b.name, 120) || tpl.subject || 'Bulk send', rows.length, now(), idem || null, bodyHash(b));
    rows.forEach((row, i) => run('INSERT INTO bulk_rows (bulk_id, account_id, position, fill) VALUES (?,?,?,?)', made.id, made.account_id, i, JSON.stringify(row)));
  });
  await sendBatch(made, c.actor);
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
  const envelopes = all('SELECT id, status, subject, sent_at, completed_at FROM envelopes WHERE bulk_id=? ORDER BY created_at', b.id);
  for (const e of envelopes) e.recipients = all('SELECT name, email, role, status, viewed_at, completed_at FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', e.id);
  // The record row by row: which rows went out, which could not and why, and which have not been tried yet. The row
  // itself (names and emails as submitted) is shown until it is sent. After that its envelope has them.
  const rows = all('SELECT position, fill, envelope_id, sent_at, error FROM bulk_rows WHERE bulk_id=? ORDER BY position', b.id)
    .map((r) => ({ position: r.position, status: r.sent_at ? 'sent' : r.error ? 'failed' : 'pending', envelope_id: r.envelope_id, sent_at: r.sent_at, error: r.error, row: r.fill ? JSON.parse(r.fill) : null }));
  return { batch: b, envelopes, rows, sending: sendingNow.has(b.id) };
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
  const open = tpl.recipients.filter((r: any) => !r.email);
  if (open.length !== 1 || !['signer', 'approver'].includes(open[0].role)) throw bad('A PowerForm needs a template with exactly one open signer role. Give every other recipient a name and email in the template.');
  return { tpl, open: open[0] };
}

route('GET', '/powerforms', (c) => ({
  powerforms: all('SELECT p.id, p.slug, p.name, p.active, p.uses, p.created_at, t.subject template FROM powerforms p LEFT JOIN envelopes t ON t.id=p.template_id WHERE p.account_id=? ORDER BY p.created_at DESC', c.account.id),
}));
route('POST', '/powerforms', async (c) => {
  const b = await c.body();
  const tpl = mine(c, str(b.template_id), 'template');
  powerformTemplate(tpl.id);
  const pid = id('pwf');
  run('INSERT INTO powerforms (id, account_id, template_id, slug, name, created_at) VALUES (?,?,?,?,?,?)', pid, c.account.id, tpl.id, token(9), str(b.name, 120) || tpl.subject || 'PowerForm', now());
  return { id: pid };
});
route('PATCH', '/powerforms/:id', async (c) => {
  run('UPDATE powerforms SET active=? WHERE id=? AND account_id=?', (await c.body()).active ? 1 : 0, c.params.id, c.account.id);
});
route('DELETE', '/powerforms/:id', (c) => {
  run('DELETE FROM powerforms WHERE id=? AND account_id=?', c.params.id, c.account.id);
});

route('GET', '/public/powerforms/:slug', (c) => {
  const p = get('SELECT * FROM powerforms WHERE slug=? AND active=1', c.params.slug);
  if (!p) throw bad('This form is not available.', 404);
  const a = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', p.account_id);
  const { tpl, open } = powerformTemplate(p.template_id);
  // Said before anyone types their name and address into a form that cannot take them.
  return { name: p.name, role: open.role_name || 'Signer', pages: tpl.documents.reduce((n: number, d: any) => n + d.pages, 0), brand: a, closed: formClosed(p, tpl) };
}, 'public');

// Why an owner cannot send right now (a pause, an address that was never confirmed) is the owner's business. A
// visitor is told only that the form is closed for now, and nothing of theirs is kept.
const FORM_CLOSED = 'This form cannot take new signatures right now. Please contact whoever gave you the link.';
const formClosed = (p: any, tpl: any): boolean => !get('SELECT email_verified v FROM users WHERE id=?', tpl.sender_id)?.v || !!get('SELECT suspended_at s FROM accounts WHERE id=?', p.account_id)?.s;

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
  // Each start holds one of the owner's signatures until it is finished or cleared by the timer, so one device
  // address may only have a few unfinished ones on a form at a time. An address we cannot tell apart is not counted.
  if (c.ip !== 'unknown') {
    const unfinished = get("SELECT COUNT(*) n FROM envelopes e JOIN recipients r ON r.id=e.form_recipient_id WHERE e.powerform_id=? AND e.form_ip=? AND e.status='sent' AND r.status IN ('pending','sent','viewed')", p.id, c.ip).n;
    if (unfinished >= POWERFORM_OPEN_STARTS)
      throw bad(`This form has been started ${POWERFORM_OPEN_STARTS} times from your internet connection and not finished yet. Finish one of those first: the link is in the email we sent each time. Ones that stay unfinished are cleared after ${powerformIdleHours()} hours, and then you can start again here.`, 429);
  }
  // A public form uses one of its owner's signatures for each person who signs. When there are none left the form
  // says so politely, and the owner is told (once a day at most) instead of finding out from a customer.
  if (creditsEnabled() && isChargeable({ role: open.role, email }, get('SELECT email FROM users WHERE id=?', tpl.sender_id)?.email || '') && available(p.account_id) < 1) {
    if (!p.alerted_at || Date.parse(p.alerted_at) < Date.now() - 864e5) {
      run('UPDATE powerforms SET alerted_at=? WHERE id=?', now(), p.id);
      const owner = get('SELECT email FROM users WHERE id=?', tpl.sender_id);
      if (owner) await sendMail({ to: owner.email, subject: `Your form "${p.name}" has run out of signatures`, heading: 'Someone tried to sign your form and could not', lines: [`"${p.name}" needs one signature for each person who signs it, and your balance is empty. They were asked to try again later.`, 'Top up or start the monthly plan and the form works again at once.'], cta: { label: 'See your plan', url: `${baseUrl()}/app/settings?tab=billing` } });
    }
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
  c.cookies.push(cookie(jar, `${eid}.${hmac(`pf:${p.id}:${eid}`)}`, Math.ceil(powerformIdleHours() * 3600), c.secure));
  const me = visitor && get("SELECT token FROM recipients WHERE id=? AND status != 'pending'", visitor.id);
  // If someone else signs first in the routing order, the signer simply gets an email when it is their turn.
  return me ? { url: `${baseUrl()}/sign/${me.token}` } : { queued: true };
}, 'public');
