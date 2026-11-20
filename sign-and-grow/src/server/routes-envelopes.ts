import { route, pdfResponse, type Ctx } from './router.ts';
import { all, get, run, saveBlob, readBlob } from './db.ts';
import { bad, id, token, now, str, rateLimit, isEmail, baseUrl } from './util.ts';
import { inspectPdf, imageToPdf } from './pdf.ts';
import { extractText } from './text.ts';
import { sendMail } from './mail.ts';
import { creditsEnabled, available, isChargeable } from './credits.ts';
import {
  loadEnvelope, publicEnvelope, createEnvelope, saveDraft, copyEnvelope, sendEnvelope, voidEnvelope, remindEnvelope,
  correctRecipient, correctEnvelope, extendEnvelope, auditTrail, verifyChain, buildPdf, finalPdf, audit, signUrl, outOfSignatures,
} from './envelopes.ts';

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
    e.recipients = all('SELECT name, email, role, role_name, status, sent_at FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', e.id);
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
  // A retried or timed-out call with the same Idempotency-Key gets the first envelope back instead of sending twice.
  const idem = str(c.req.headers.get('idempotency-key'), 200).trim();
  if (idem) {
    const done = get('SELECT envelope_id FROM idempotency_keys WHERE account_id=? AND key=?', c.account.id, idem);
    const prior = done && loadEnvelope(done.envelope_id);
    if (prior) return new Response(JSON.stringify({ envelope: publicEnvelope(prior) }), { headers: { 'content-type': 'application/json; charset=utf-8', 'idempotent-replay': 'true' } });
  }
  let eid: string;
  if (b.template_id) {
    const tpl = mine(c, str(b.template_id), 'template');
    eid = copyEnvelope(tpl, { accountId: c.account.id, senderId: c.user.id, kind, subject: b.subject, message: b.message, fill: b.recipients && !Array.isArray(b.recipients) ? b.recipients : undefined });
  } else {
    eid = createEnvelope(c.account, c.user.id, kind, b);
    if (b.documents || b.recipients || b.fields) saveDraft(loadEnvelope(eid), b, c.account.id);
  }
  if (idem) run('INSERT OR IGNORE INTO idempotency_keys (account_id, key, envelope_id, at) VALUES (?,?,?,?)', c.account.id, idem, eid, now());
  if (b.send && kind === 'envelope') await sendEnvelope(eid, c.actor);
  return { envelope: publicEnvelope(loadEnvelope(eid)) };
});

route('GET', '/envelopes/:id', (c) => {
  const e = mine(c, c.params.id);
  // Whether each email actually left, so "I never got it" can be answered without guessing.
  const deliveries = all('SELECT to_email, subject, status, error, at FROM emails WHERE envelope_id=? ORDER BY id DESC LIMIT 60', e.id);
  // How far each signer has got, so the sender can help someone who is stuck without being able to sign for them.
  const env = publicEnvelope(e);
  for (const r of env.recipients) {
    const theirs = e.fields.filter((f: any) => f.recipient_id === r.id && !f.readonly && !['date_signed', 'full_name', 'email'].includes(f.type));
    r.progress = { fields: theirs.length, filled: theirs.filter((f: any) => f.value).length, required_left: theirs.filter((f: any) => f.required && !f.value).length };
  }
  return { envelope: env, audit: auditTrail(e.id), chain: verifyChain(e.id), deliveries };
});

// Drafts are simply saved. An envelope that is already out is corrected in place: no void, no resend, no extra count.
route('PUT', '/envelopes/:id', async (c) => {
  const e = mine(c, c.params.id);
  if (e.kind === 'envelope' && e.status === 'sent') await correctEnvelope(e, await c.body(), c.account.id, c.actor);
  else saveDraft(e, await c.body(), c.account.id);
  return { envelope: publicEnvelope(loadEnvelope(e.id)) };
});

route('POST', '/envelopes/:id/extend', async (c) => ({ expires_at: await extendEnvelope(mine(c, c.params.id, 'envelope'), (await c.body()).days, c.actor) }));

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
  await voidEnvelope(mine(c, c.params.id, 'envelope'), str((await c.body()).reason, 500), c.actor);
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
  const e = mine(c, c.params.id, 'envelope');
  const rid = str((await c.body()).recipient_id);
  const r = e.recipients.find((x: any) => x.id === rid);
  if (!r || !r.token) throw bad('Recipient not found, or the envelope has not been sent.', 404);
  audit(e.id, c.actor, 'Signing link issued', `${r.name} <${r.email}>`);
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

route('POST', '/bulk', async (c) => {
  const b = await c.body();
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
  // Check the whole batch against the balance first, so it never stops half way through.
  if (creditsEnabled()) {
    const perRow = tpl.recipients.filter((r: any) => isChargeable({ role: r.role, email: r.email || 'someone-else' }, c.user.email)).length;
    const have = available(c.account.id);
    if (perRow * rows.length > have) throw bad(outOfSignatures(c.account, perRow * rows.length, have), 402);
  }
  const bid = id('blk');
  run('INSERT INTO bulk_batches (id, account_id, sender_id, template_id, name, total, created_at) VALUES (?,?,?,?,?,?,?)', bid, c.account.id, c.user.id, tpl.id, str(b.name, 120) || tpl.subject || 'Bulk send', rows.length, now());
  const results: any[] = [];
  for (const row of rows) {
    try {
      const eid = copyEnvelope(tpl, { accountId: c.account.id, senderId: c.user.id, kind: 'envelope', fill: row, extra: { bulk_id: bid } });
      await sendEnvelope(eid, c.actor);
      results.push({ ok: true, id: eid });
    } catch (e: any) {
      results.push({ ok: false, error: e.message });
    }
  }
  return { id: bid, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results };
});

// A batch is one thing: see everyone's status, nudge the stragglers, or void what is still open, in one go.
function batch(c: Ctx, bulkId: string) {
  const b = get('SELECT * FROM bulk_batches WHERE id=? AND account_id=?', bulkId, c.account.id);
  if (!b || (!c.admin && b.sender_id !== c.user.id)) throw bad('Batch not found.', 404);
  return b;
}
route('GET', '/bulk/:id', (c) => {
  const b = batch(c, c.params.id);
  const envelopes = all('SELECT id, status, subject, sent_at, completed_at FROM envelopes WHERE bulk_id=? ORDER BY created_at', b.id);
  for (const e of envelopes) e.recipients = all('SELECT name, email, role, status, viewed_at, completed_at FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', e.id);
  return { batch: b, envelopes };
});
route('POST', '/bulk/:id/remind', async (c) => {
  const b = batch(c, c.params.id);
  let reminded = 0;
  for (const row of all("SELECT id FROM envelopes WHERE bulk_id=? AND status='sent'", b.id)) reminded += await remindEnvelope(loadEnvelope(row.id), c.actor);
  return { reminded };
});
route('POST', '/bulk/:id/void', async (c) => {
  const b = batch(c, c.params.id);
  const reason = str((await c.body()).reason, 500);
  if (!reason.trim()) throw bad('Give a reason for voiding. Recipients will see it.');
  let voided = 0;
  for (const row of all("SELECT id FROM envelopes WHERE bulk_id=? AND status='sent'", b.id)) {
    await voidEnvelope(loadEnvelope(row.id), reason, c.actor);
    voided++;
  }
  return { voided };
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
  return { name: p.name, role: open.role_name || 'Signer', pages: tpl.documents.reduce((n: number, d: any) => n + d.pages, 0), brand: a };
}, 'public');

route('POST', '/public/powerforms/:slug/start', async (c) => {
  rateLimit(`pf:${c.ip}`, 20, 3600_000);
  const p = get('SELECT * FROM powerforms WHERE slug=? AND active=1', c.params.slug);
  if (!p) throw bad('This form is not available.', 404);
  const b = await c.body();
  const name = str(b.name, 120).trim();
  const email = str(b.email, 254).trim();
  if (!name || !isEmail(email)) throw bad('Enter your name and a valid email address.');
  const { tpl, open } = powerformTemplate(p.template_id);
  // Opening the form twice must not create two envelopes: pick up the one this person already started.
  const again = get("SELECT r.token FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE e.powerform_id=? AND e.status='sent' AND r.email=? AND r.status IN ('sent','viewed') ORDER BY e.sent_at DESC LIMIT 1", p.id, email);
  if (again) return { url: `${baseUrl()}/sign/${again.token}`, resumed: true };
  // A public form uses one of its owner's signatures for each person who signs. When there are none left the form
  // says so politely, and the owner is told (once a day at most) instead of finding out from a customer.
  if (creditsEnabled() && available(p.account_id) < 1) {
    if (!p.alerted_at || Date.parse(p.alerted_at) < Date.now() - 864e5) {
      run('UPDATE powerforms SET alerted_at=? WHERE id=?', now(), p.id);
      const owner = get('SELECT email FROM users WHERE id=?', tpl.sender_id);
      if (owner) await sendMail({ to: owner.email, subject: `Your form "${p.name}" has run out of signatures`, heading: 'Someone tried to sign your form and could not', lines: [`"${p.name}" needs one signature for each person who signs it, and your balance is empty. They were asked to try again later.`, 'Top up or start the monthly plan and the form works again at once.'], cta: { label: 'See your plan', url: `${baseUrl()}/app/settings?tab=billing` } });
    }
    throw bad('This form cannot take new signatures right now. Please try again a little later, or contact the people who sent you here.', 503);
  }
  const eid = copyEnvelope(tpl, { accountId: p.account_id, senderId: tpl.sender_id, kind: 'envelope', subject: p.name, fill: { [open.id]: { name, email } }, extra: { powerform_id: p.id } });
  await sendEnvelope(eid, { name: `${name} <${email}> via PowerForm`, ip: c.ip, ua: c.ua });
  run('UPDATE powerforms SET uses=uses+1 WHERE id=?', p.id);
  const me = get("SELECT token, status FROM recipients WHERE envelope_id=? AND email=? AND status != 'pending' LIMIT 1", eid, email);
  // If someone else signs first in the routing order, the signer simply gets an email when it is their turn.
  return me ? { url: `${baseUrl()}/sign/${me.token}` } : { queued: true };
}, 'public');
