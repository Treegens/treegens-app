import { route, pdfResponse, type Ctx } from './router.ts';
import { all, get, run, saveBlob, readBlob } from './db.ts';
import { bad, id, token, now, str, rateLimit, isEmail, baseUrl } from './util.ts';
import { inspectPdf, imageToPdf } from './pdf.ts';
import {
  loadEnvelope, publicEnvelope, createEnvelope, saveDraft, copyEnvelope, sendEnvelope, voidEnvelope, remindEnvelope,
  correctRecipient, auditTrail, verifyChain, buildPdf, finalPdf, audit, signUrl,
} from './envelopes.ts';

// ---- Files ---------------------------------------------------------------------------------

export async function storeUpload(c: Ctx, accountId: string | null) {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw bad('Choose a file to upload.');
  if (file.size > 25_000_000) throw bad('Files can be up to 25 MB.');
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPdf && !isPng && !isJpg) throw bad('Upload a PDF, PNG or JPEG. Export Word or Google Docs files as PDF first.');
  if (!isPdf) bytes = await imageToPdf(bytes, isPng ? 'image/png' : 'image/jpeg');
  const info = await inspectPdf(bytes);
  if (info.pages > 500) throw bad('Documents can have up to 500 pages.');
  const fid = id('fil');
  const name = str(file.name, 200).replace(/\.(pdf|png|jpe?g)$/i, '') || 'Document';
  run('INSERT INTO files (id, account_id, sha256, name, size, pages, page_sizes, created_at) VALUES (?,?,?,?,?,?,?,?)', fid, accountId, saveBlob(bytes), name, bytes.length, info.pages, JSON.stringify(info.sizes), now());
  return { id: fid, name, pages: info.pages, page_sizes: info.sizes };
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
  const q = (c.q.get('q') || '').trim();
  if (q) {
    where.push('(e.subject LIKE ? OR e.id = ? OR EXISTS (SELECT 1 FROM recipients r WHERE r.envelope_id=e.id AND (r.name LIKE ? OR r.email LIKE ?)))');
    p.push(`%${q}%`, q, `%${q}%`, `%${q}%`);
  }
  const limit = Math.min(200, Number(c.q.get('limit')) || 100);
  const rows = all(`SELECT e.id, e.kind, e.status, e.subject, e.folder, e.created_at, e.updated_at, e.sent_at, e.completed_at, e.expires_at, e.sheets, e.bulk_id, u.name sender
    FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE ${where.join(' AND ')} ORDER BY e.updated_at DESC LIMIT ? OFFSET ?`, ...p, limit, Number(c.q.get('offset')) || 0);
  for (const e of rows) {
    e.recipients = all('SELECT name, email, role, role_name, status FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', e.id);
    e.pages = get('SELECT COALESCE(SUM(f.pages),0) n FROM documents d JOIN files f ON f.id=d.file_id WHERE d.envelope_id=?', e.id).n;
  }
  const folders = all("SELECT DISTINCT folder FROM envelopes WHERE account_id=? AND kind=? AND folder IS NOT NULL AND folder != ''", c.account.id, kind).map((r) => r.folder);
  return { envelopes: rows, folders };
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
  let eid: string;
  if (b.template_id) {
    const tpl = mine(c, str(b.template_id), 'template');
    eid = copyEnvelope(tpl, { accountId: c.account.id, senderId: c.user.id, kind, subject: b.subject, message: b.message, fill: b.recipients && !Array.isArray(b.recipients) ? b.recipients : undefined });
  } else {
    eid = createEnvelope(c.account, c.user.id, kind, b);
    if (b.documents || b.recipients || b.fields) saveDraft(loadEnvelope(eid), b, c.account.id);
  }
  if (b.send && kind === 'envelope') await sendEnvelope(eid, c.actor);
  return { envelope: publicEnvelope(loadEnvelope(eid)) };
});

route('GET', '/envelopes/:id', (c) => {
  const e = mine(c, c.params.id);
  return { envelope: publicEnvelope(e), audit: auditTrail(e.id), chain: verifyChain(e.id) };
});

route('PUT', '/envelopes/:id', async (c) => {
  const e = mine(c, c.params.id);
  saveDraft(e, await c.body(), c.account.id);
  return { envelope: publicEnvelope(loadEnvelope(e.id)) };
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
  await voidEnvelope(mine(c, c.params.id, 'envelope'), str((await c.body()).reason, 500), c.actor);
});

route('POST', '/envelopes/:id/remind', async (c) => ({ reminded: await remindEnvelope(mine(c, c.params.id, 'envelope'), c.actor) }));

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
  const eid = copyEnvelope(tpl, { accountId: p.account_id, senderId: tpl.sender_id, kind: 'envelope', subject: p.name, fill: { [open.id]: { name, email } }, extra: { powerform_id: p.id } });
  await sendEnvelope(eid, { name: `${name} <${email}> via PowerForm`, ip: c.ip, ua: c.ua });
  run('UPDATE powerforms SET uses=uses+1 WHERE id=?', p.id);
  const me = get("SELECT token, status FROM recipients WHERE envelope_id=? AND email=? AND status != 'pending' LIMIT 1", eid, email);
  // If someone else signs first in the routing order, the signer simply gets an email when it is their turn.
  return me ? { url: `${baseUrl()}/sign/${me.token}` } : { queued: true };
}, 'public');
