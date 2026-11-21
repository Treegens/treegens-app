import fs from 'node:fs';
import path from 'node:path';
import { route, type Ctx } from './router.ts';
import { all, get, run, tx, readBlob, dataDir } from './db.ts';
import { bad, id, now, isEmail, str, rateLimit, baseUrl, parseCode, shortCode, sha256, hmac, HttpError } from './util.ts';
import { checkPassword, hasPassword } from './auth.ts';
import { sendMail } from './mail.ts';
import { auditTrail, emailMyLinks, resendFromRetired } from './envelopes.ts';
import { loadEnvelope, reportAbuse } from './envelopes.ts';
import { audit, helpAsked, type Actor } from './envelopes.ts';
import { stopBillingFor, pendingRefundLines } from './routes-billing.ts';
import { sameEmail } from './credits.ts';
import { unpaidDailyRecipients, PAID_TRUST_DAYS } from '../lib/policy.ts';
import { advance, emailRefusal, hasNotPaid, dailyCap, PAUSED_MEANS } from './envelopes.ts';
import { CLOSE_GRACE_DAYS, CLOSING_REMINDER_DAYS, MAIL_COPY_DAYS } from '../lib/policy.ts';
import { zipStream, safeName, ZIP_MAX_BYTES, ZIP_MAX_FILES, type ZipEntry } from './zip.ts';
import { memberForCode, memberReported, removedMemberCheck } from './groups.ts';
import { forgetChosen } from './tplroles.ts';
import { dropPayLinksOf } from './paydrop.ts';
import { keepFingerprint, forgetOldFingerprints } from './evidence.ts';
import { commentsText } from './comments.ts';
import { forgetCommentHooks } from './commentrules.ts';
import { attachedFiles, forgetClickwraps } from './clickwrap.ts';
import { rememberGoneMail } from './bounces.ts';
import { forgetArchiveCopies } from './archivemail.ts';
import { stampExport, pruneStampImages } from './stamps.ts';
import { record, securityExport, securityWords } from './seclog.ts';
import { originalShas } from './converted.ts';
import { assertMayClose, forgetRetentionLog } from './records.ts';
import { customCsv } from './customfields.ts';

// Things that exist so nobody gets stuck: help that reaches a person, proof an email is genuine, lost links,
// taking your documents with you, closing an account, and the queue the people running the service work from.

// ---- Help ----------------------------------------------------------------------------------

// The help form, the requests it makes, their threads and the routes for both sides are in routes-support.ts.

// ---- Is this email real? -------------------------------------------------------------------

route('POST', '/public/check', async (c) => {
  rateLimit(`check:${c.ip}`, 30, 3600_000);
  const code = parseCode((await c.body()).code);
  if (code.length !== 12) throw bad('Security codes are 12 letters and numbers, like ABCD-EFGH-JKLM. Check the email and try again.');
  // Each member of a group has a security code of their own in their own emails (memberForCode in groups.ts).
  const r = get('SELECT * FROM recipients WHERE check_code=?', code) || memberForCode(code);
  // A member the sender took out of the group: genuine, and its link no longer opens the document (groups.ts).
  if (r?.member?.removed_at) return removedMemberCheck(r);
  if (!r?.token) {
    // A code from an email we really sent, whose link has since been replaced: the sender corrected the address or
    // the role, the signer passed the document on, or the person was taken off. That email was genuine and is said
    // to be, with why its link no longer works and what to do. Its link is never handed out again.
    const old = get('SELECT * FROM retired_tokens WHERE check_code=? ORDER BY retired_at DESC LIMIT 1', code);
    // A code from an email about a document that was deleted since (by its sender, or with the sender's account).
    // The email was real, and that is all we still know: the document and everything about it are gone.
    const gone = old ? null : get('SELECT at, account_id FROM forgotten_codes WHERE code_hash=?', sha256(code));
    // can_report: whether we still know which account sent it, so the page only offers a report we can file (the
    // account was deleted too, or the code is from before that was kept: then only the contact form helps).
    if (gone) return { genuine: true, deleted: true, deleted_at: gone.at, can_report: !!(gone.account_id && get('SELECT 1 x FROM accounts WHERE id=?', gone.account_id)) };
    if (!old) return { genuine: false };
    const oe = old.envelope_id ? get('SELECT subject, status, sender_id, account_id FROM envelopes WHERE id=?', old.envelope_id) : null;
    const account = oe ? get('SELECT name, suspended_at FROM accounts WHERE id=?', oe.account_id) : null;
    return { genuine: true, replaced: true, why: old.why || 'address', replaced_at: old.retired_at, for_name: old.sent_to || null,
      sender: oe ? get('SELECT name, email FROM users WHERE id=?', oe.sender_id) : null, account: account?.name, paused: !!account?.suspended_at, subject: oe?.subject || null, status: oe?.status || null };
  }
  const e = get('SELECT id, subject, status, sender_id, account_id, sent_at, purged_at FROM envelopes WHERE id=?', r.envelope_id);
  // Its documents were purged (records.ts): the email was real, and the document is gone, as for a deleted one.
  if (e.purged_at) return { genuine: true, deleted: true, deleted_at: e.purged_at, can_report: true };
  const sender = get('SELECT name, email FROM users WHERE id=?', e.sender_id);
  const account = get('SELECT name, suspended_at FROM accounts WHERE id=?', e.account_id);
  return { genuine: true, sender, account: account?.name, paused: !!account?.suspended_at, subject: e.subject, status: e.status, sent_at: r.sent_at || e.sent_at, for_name: r.name, role: r.role, url: `${baseUrl()}/sign/${r.token}` };
}, 'public');

// "Report this email", from the email itself or from the check page. The security code is enough, so nobody has to
// open a link they do not trust in order to report it. It counts exactly like a report made on the signing screen.
route('POST', '/public/check/report', async (c) => {
  rateLimit(`report:${c.ip}`, 10, 3600_000);
  const b = await c.body();
  const code = parseCode(b.code);
  const r = code.length === 12 ? get('SELECT id, envelope_id, token FROM recipients WHERE check_code=?', code) || memberForCode(code) : null;
  let e = r?.token ? loadEnvelope(r.envelope_id) : null;
  // A member of a group reports under their own name and address, not under the group's.
  let who = r?.member ? r : e?.recipients.find((x: any) => x.id === r.id);
  if (!who && code.length === 12) {
    // The code of a genuine email whose link was replaced since (the sender changed the address, say). Whoever
    // holds that email can report it all the same, under the address it was sent to.
    const old = get('SELECT * FROM retired_tokens WHERE check_code=? ORDER BY retired_at DESC LIMIT 1', code);
    const to = old?.envelope_id ? get('SELECT to_email FROM emails WHERE envelope_id=? AND recipient_id=? AND at <= ? ORDER BY id DESC LIMIT 1', old.envelope_id, old.recipient_id, old.retired_at)?.to_email : null;
    e = to ? loadEnvelope(old.envelope_id) : null;
    // The id says whether this was the visitor of a public form (see reportAbuse).
    who = e ? { id: old.recipient_id, name: old.sent_to || to, email: to } : null;
  }
  const gone = !who && code.length === 12 ? get('SELECT * FROM forgotten_codes WHERE code_hash=?', sha256(code)) : null;
  if (gone) {
    // The code of an email whose document was deleted since. Nothing says who it was sent to any more, but the
    // account it came from is known, so the report is filed against that account and counts like any other: voiding
    // and deleting what was sent does not put a sender out of reach of the people who still hold the email. One
    // code is one person, counted once, also when they had reported the document before it was deleted. The code of
    // a public form's visitor stays a visitor's (via_form): it never counts towards a pause, before or after the
    // owner deleted the start, or anyone could pause an account by starting its form and waiting for the tidy-up.
    const account = gone.account_id ? get('SELECT id FROM accounts WHERE id=?', gone.account_id) : null;
    if (!account) throw bad('That code is from an email we really sent, but the document it was about has been deleted since, and nothing is left that says who sent it. So we cannot file a report against it here. If the email worries you, use the contact form on the help page and tell us what it says: a person will look into it.', 404);
    if (!gone.reported) {
      const holder = `the holder of an email about a deleted document (${sha256(code).slice(0, 10)})`;
      await reportAbuse({ id: '', gone: true, account_id: account.id, via_form: !!gone.via_form }, { name: `Someone, as ${holder}`, email: holder }, b, { name: 'Someone holding the email', ip: c.ip, ua: c.ua });
      run('UPDATE forgotten_codes SET reported=1 WHERE code_hash=?', gone.code_hash);
    }
    return { ok: true, deleted: true };
  }
  if (!who) throw bad('We do not recognise that security code, so we cannot tell which email you mean. Use the contact form on the help page and tell us what the email says.', 404);
  await reportAbuse(e, who, b, { name: `${who.name} <${who.email}>`, ip: c.ip, ua: c.ua });
  // A member of a signing group who reports it is emailed nothing more about it, and is told so (groups.ts).
  return memberReported(e, who, { name: `${who.name} <${who.email}>`, ip: c.ip, ua: c.ua }) || { ok: true };
}, 'public');

// ---- Lost or replaced links ----------------------------------------------------------------

// "Email me the current link", asked from a link that was replaced. The answer is honest: "sent" is only true when
// an email really went to whoever holds the document now, and "result" says what happened otherwise ('delayed',
// 'waiting', 'removed', 'closed', 'unknown': see resendFromRetired). Only someone who was sent the replaced link
// can ask, because it is as unguessable as a live one, and they learn nothing their own emails did not tell them.
route('POST', '/public/links/resend', async (c) => {
  rateLimit(`resend:${c.ip}`, 10, 3600_000);
  const result = await resendFromRetired(str((await c.body()).token, 100));
  return { ok: true, sent: result === 'sent', result };
}, 'public');

// Here the answer is deliberately the same whether or not anything was found: an email address can be guessed, so
// nobody may learn from this form who signs what. The page says "if any documents were sent to that address".

route('POST', '/public/links/find', async (c) => {
  rateLimit(`links:${c.ip}`, 10, 3600_000);
  const email = str((await c.body()).email, 254).trim().toLowerCase();
  if (!isEmail(email)) throw bad('Enter the email address the document was sent to.');
  rateLimit(`links:${email}`, 3, 3600_000);
  await emailMyLinks(email);
  return { ok: true };
}, 'public');

// ---- Your documents are yours --------------------------------------------------------------

const csv = (cells: any[]) => cells.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');

// Everything in the account as one ZIP: signed PDFs with certificates, an index, and each audit trail.
// Free on every plan, and it keeps working after a paid plan ends.
route('GET', '/export', (c) => {
  const only = (c.q.get('ids') || '').split(',').filter(Boolean);
  const bulk = c.q.get('bulk');
  const scope = c.admin ? '' : ' AND sender_id=?';
  // A completed envelope its sender deleted is not in the sender's export either: only its recipients still have it.
  const rows = all(`SELECT * FROM envelopes WHERE account_id=? AND kind='envelope' AND status!='draft' AND hidden_at IS NULL${scope} ORDER BY sent_at`, ...(c.admin ? [c.account.id] : [c.account.id, c.user.id]))
    .filter((e) => (!only.length || only.includes(e.id)) && (!bulk || e.bulk_id === bulk));
  if (!rows.length) throw bad('There is nothing to export yet.');
  // "everything": no envelopes or batch picked, so all the caller can export (an admin: the account's; a member: their own).
  record('export.made', { c, details: { everything: !only.length && !bulk, whose: c.admin ? 'account' : 'own', envelopes: rows.length } });

  function* entries(): Generator<ZipEntry> {
    const head = ['envelope_id', 'subject', 'status', 'sent_at', 'completed_at', 'recipients', 'signed_pdf_sha256', 'file'];
    // A column for each custom field these envelopes have, by its name (customfields.ts).
    const custom = customCsv(rows.map((e) => e.id), head);
    const index = [csv([...head, ...custom.head])];
    let bytes = 0, files = 0, skipped = 0;
    // A signed PDF whose stored copy fails its check (src/server/filestore.ts) is left out and named in README.txt,
    // so one damaged file never breaks the ZIP of everything else, and nothing damaged is put in it.
    const unreadable: string[] = [];
    // A locked one (its key was not given to this server) is not damaged and not lost, so it is named apart, with what
    // to do; and a completed envelope whose signed PDF could not be made yet is said too (finalretry.ts).
    const locked: string[] = [];
    const notMade: string[] = [];
    // Envelopes whose documents a retention purge removed (records.ts): only their record is left to export.
    const purged: string[] = [];
    for (const e of rows) {
      const people = all('SELECT name, email, role, status FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', e.id);
      const base = `${(e.completed_at || e.sent_at || e.created_at).slice(0, 10)} ${safeName(e.subject)} ${e.id.slice(-6)}`;
      let file = '';
      let data: Buffer | null = null, failed = false;
      if (e.final_sha256 && files < ZIP_MAX_FILES - 3 && bytes + (e.final_size || 0) < ZIP_MAX_BYTES) {
        try {
          data = readBlob(e.final_sha256);
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          (err.data?.code === 'file_locked' ? locked : unreadable).push(`${e.subject || 'Untitled'} (envelope ${e.id})`);
          failed = true;
        }
      } else if (e.purged_at) purged.push(`${e.subject || 'Untitled'} (envelope ${e.id}), on ${String(e.purged_at).slice(0, 10)}`);
      else if (e.status === 'completed' && !e.final_sha256) notMade.push(`${e.subject || 'Untitled'} (envelope ${e.id})`);
      if (data) {
        file = `signed/${base}.pdf`;
        bytes += data.length;
        files++;
        yield { name: file, data };
      } else if (e.final_sha256 && !failed) skipped++;
      if (files < ZIP_MAX_FILES - 3) {
        files++;
        yield { name: `audit/${base}.json`, data: Buffer.from(JSON.stringify({ envelope: { id: e.id, subject: e.subject, status: e.status, sent_at: e.sent_at, completed_at: e.completed_at }, recipients: people, events: auditTrail(e.id) }, null, 2)) };
      }
      // The questions and comments in full, private ones included: this export is the sender's side (comments.ts).
      const said = files < ZIP_MAX_FILES - 3 ? commentsText(e) : '';
      if (said) (files++, yield { name: `comments/${base}.txt`, data: Buffer.from(said) });
      index.push(csv([e.id, e.subject, e.status, e.sent_at, e.completed_at, people.map((p) => `${p.name} <${p.email}> (${p.role}: ${p.status})`).join('; '), e.final_sha256 || e.purged_sha256, file, ...custom.cells(e.id)]));
    }
    yield { name: 'envelopes.csv', data: Buffer.from('﻿' + index.join('\r\n')) };
    // The team's own stamps (Settings, Stamps), each picture with its name and settings (stamps.ts).
    const stamps = stampExport(c.account.id);
    for (const s of stamps) yield s;
    // The account's security record, for its admins only (seclog.ts).
    if (c.admin) yield* securityExport(c.account.id);
    yield { name: 'README.txt', data: Buffer.from([
      `GrowSigning export for ${c.account.name}, made ${now()}.`, '',
      'signed/        completed documents, each with its certificate of completion',
      'audit/         the full audit trail of every envelope, as JSON',
      'comments/      the questions and comments on an envelope, in full, where anyone wrote any. They are not part of what was signed.',
      ...(stamps.length ? ['stamps/        the stamps your team keeps under Settings, Stamps, as pictures, with their names and settings in stamps/index.csv'] : []),
      ...(c.admin ? [`security/      the security record of the account as it stands now (Settings, Security), oldest first. ${securityWords()}`] : []),
      `envelopes.csv  one row per envelope${custom.head.length ? ', with a column for each detail your account keeps on envelopes' : ''}`,
      '', `Check any signed PDF at ${baseUrl()}/verify. It must be the exact file from this export.`,
      ...(skipped ? ['', `${skipped} signed document(s) did not fit in one ZIP file. Export again with fewer envelopes selected to get them.`] : []),
      ...(unreadable.length ? ['', `${unreadable.length} signed document(s) could not be read from storage and are not in this file. Their stored copy failed its check, so nothing damaged was put in. Their audit trails are here. The people who run this server have been told and can put the files back from a backup; export again later. Not included:`, ...unreadable.map((u) => `  ${u}`)] : []),
      ...(locked.length ? ['', `${locked.length} signed document(s) are locked with an encryption key this server was not given, so they are not in this file. They are not damaged and not lost, and nothing about them was changed. Their audit trails are here. Export again once the people who run this server have set that key. Not included:`, ...locked.map((u) => `  ${u}`)] : []),
      ...(purged.length ? ['', `${purged.length} envelope(s) had their documents purged under the account's retention rule or at someone's request, so only their audit trails are here. envelopes.csv keeps the fingerprint of each signed PDF. Purged:`, ...purged.map((u) => `  ${u}`)] : []),
      ...(notMade.length ? ['', `${notMade.length} completed document(s) have no signed PDF yet, because it could not be made so far. Everyone finished, and their audit trails are here. It is made by itself once it can be; export again then. Not included:`, ...notMade.map((u) => `  ${u}`)] : []),
    ].join('\r\n')) };
  }
  return new Response(zipStream(entries()), { headers: { 'content-type': 'application/zip', 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="growsigning-export-${now().slice(0, 10)}.zip"` } });
});

// A stored file is taken off the disk once nothing points at it any more: no uploaded file, no signed PDF, no copy
// of what someone signed before a correction, and no email that is still waiting to be sent with it attached.
export function removeUnusedBlobs(shas: string[]) {
  // Stamp pictures are kept in the database, not as files: the ones nothing points at any more go too (stamps.ts).
  pruneStampImages();
  for (const sha of new Set(shas.filter(Boolean))) {
    if (get('SELECT 1 x FROM files WHERE sha256=? OR original_sha256=?', sha, sha) || get('SELECT 1 x FROM envelopes WHERE final_sha256=?', sha) || get('SELECT 1 x FROM earlier_signatures WHERE copy_sha256=?', sha) || get('SELECT 1 x FROM emails WHERE payload LIKE ?', `%${sha}%`)) continue;
    fs.rmSync(path.join(dataDir(), 'blobs', sha), { force: true });
  }
}

// What is kept about an envelope beside its own rows: the audit trail (names, email addresses, internet addresses),
// the stored copy of every email about it, replaced links, and the files signers attached. None of that hangs on
// the envelope in the database, so deleting the envelope alone leaves it all behind. Call this inside tx(), before
// the envelopes themselves are deleted, and give the answer to removeUnusedBlobs() once they are gone.
// When one envelope is deleted and its account stays (`account` is false), two things are left alone on purpose.
// An email about it that is still waiting for the mail server, such as the notice that it was voided, is still
// delivered, and the timer removes its copy afterwards. And reports from its recipients stay with the account:
// they count towards pausing a sender, and deleting what was reported must not make them go away.
export function forgetEnvelopes(ids: string[], account = false): string[] {
  const shas: string[] = [];
  for (const eid of ids) {
    // A file a signer attached belongs to no account. It is found through the field it was attached to, now or in
    // a signature that was set aside, and through the envelope whose link it was uploaded with: that also finds a
    // file a signer uploaded and then did not attach (files.via_envelope; uploads from before that was kept are
    // removed by the timer after LOOSE_UPLOAD_DAYS).
    const attached: string[] = [...all("SELECT id FROM files WHERE account_id IS NULL AND via_envelope=? AND id NOT IN (SELECT value FROM fields WHERE type='attachment' AND value IS NOT NULL AND envelope_id!=?)", eid, eid).map((f) => f.id),
      ...all("SELECT value v FROM fields WHERE envelope_id=? AND type='attachment' AND value IS NOT NULL", eid).map((f) => f.v),
      ...all('SELECT answers FROM earlier_signatures WHERE envelope_id=?', eid).flatMap((s) => (JSON.parse(s.answers || '[]') as any[]).filter((a) => a.type === 'attachment').map((a) => a.value))];
    for (const fid of attached) {
      const f = get('SELECT sha256 FROM files WHERE id=? AND account_id IS NULL', fid);
      if (f) (shas.push(f.sha256), run('DELETE FROM files WHERE id=?', fid));
    }
    // A completed one leaves the fingerprint of its signed PDF, its id and its day behind, nothing else (evidence.ts).
    keepFingerprint(eid);
    shas.push(get('SELECT final_sha256 s FROM envelopes WHERE id=?', eid)?.s);
    // The copies of what people signed before a correction go with the envelope too (earlier_signatures.copy_sha256).
    shas.push(...all('SELECT copy_sha256 s FROM earlier_signatures WHERE envelope_id=? AND copy_sha256 IS NOT NULL', eid).map((x) => x.s));
    // The emails about this document are still in people's inboxes, each with its security code. Only a fingerprint
    // of each code is kept, so the check page can still tell their holders the email was real. It says nothing
    // about who or what, and goes after a year (see purge). While the account stays, the fingerprint also keeps
    // the account's id (which names nobody), so the holder of such an email can still report it and the report
    // counts against the sender. `reported` notes that this person had reported the document already, so their
    // report is not counted a second time under the code.
    const owner = account ? null : get('SELECT account_id a FROM envelopes WHERE id=?', eid)?.a;
    // The visitor of a public form typed their own name and address. Their report never counts towards a pause
    // (reportAbuse), and deleting the start must not change that: `via_form` keeps it, and nothing else about them.
    const visitor = get('SELECT form_recipient_id v FROM envelopes WHERE id=? AND powerform_id IS NOT NULL', eid)?.v;
    for (const r of all(`SELECT check_code c, email to_email, id rid FROM recipients WHERE envelope_id=? AND check_code IS NOT NULL AND sent_at IS NOT NULL
        UNION SELECT t.check_code, (SELECT m.to_email FROM emails m WHERE m.envelope_id=? AND m.recipient_id=t.recipient_id AND m.at <= t.retired_at ORDER BY m.id DESC LIMIT 1), t.recipient_id
          FROM retired_tokens t WHERE t.check_code IS NOT NULL AND (t.envelope_id=? OR t.recipient_id IN (SELECT id FROM recipients WHERE envelope_id=?))
        UNION SELECT check_code, email, recipient_id FROM recipient_members WHERE envelope_id=? AND check_code IS NOT NULL AND sent_at IS NOT NULL`, eid, eid, eid, eid, eid)) // the last line: the emails to the members of a group (groups.ts)
      run('INSERT OR IGNORE INTO forgotten_codes (code_hash, at, account_id, reported, via_form) VALUES (?,?,?,?,?)', sha256(r.c), now(), owner,
        r.to_email && get('SELECT 1 x FROM abuse_reports WHERE envelope_id=? AND lower(reporter)=lower(?)', eid, r.to_email) ? 1 : 0, visitor && r.rid === visitor ? 1 : 0);
    run('DELETE FROM audit WHERE envelope_id=?', eid);
    // What was written in the comments, and by whom, also leaves the webhook log (commentrules.ts).
    forgetCommentHooks(eid);
    // News from the mail provider about these emails (a spam complaint) still counts against the account (bounces.ts).
    if (owner) rememberGoneMail(eid, owner);
    run(`DELETE FROM emails WHERE envelope_id=?${account ? '' : ` AND ${NOT_WAITING}`}`, eid);
    forgetArchiveCopies(eid); // our stored copies for the archive addresses (archivemail.ts)
    run('DELETE FROM retired_tokens WHERE envelope_id=? OR recipient_id IN (SELECT id FROM recipients WHERE envelope_id=?)', eid, eid);
    if (account) run('DELETE FROM abuse_reports WHERE envelope_id=?', eid);
  }
  return shas;
}
// An email that is not waiting to be handed to the mail server: it left, it sits in the outbox, or nobody tries again.
const NOT_WAITING = "status!='queued' AND NOT (status='failed' AND next_try_at IS NOT NULL)";

// Everything one person sent in an account passes to another member: envelopes, drafts, templates and bulk sends,
// so the new holder can open, remind and void each batch as well. Every envelope's own record says who handed it to
// whom and why. A retry key on a batch belonged to the person who left and is dropped. Call inside tx(). Answers
// how many envelopes moved.
export function handOver(accountId: string, from: { id: string; name: string; email: string }, toId: string, actor: Actor, why: string): number {
  const to = get('SELECT name, email FROM users WHERE id=?', toId);
  // Their payment links lead to their own payment page, so those go with them and are not handed on (paydrop.ts).
  dropPayLinksOf(accountId, from, actor, why);
  const moved = all('SELECT id FROM envelopes WHERE account_id=? AND sender_id=?', accountId, from.id);
  for (const e of moved) audit(e.id, actor, 'Handed over', `From ${from.name} <${from.email}> to ${to.name} <${to.email}>: ${why}`);
  run('UPDATE envelopes SET sender_id=? WHERE account_id=? AND sender_id=?', toId, accountId, from.id);
  run('UPDATE bulk_batches SET sender_id=?, idem_key=NULL WHERE account_id=? AND sender_id=?', toId, accountId, from.id);
  // Someone who leaves is no longer one of the members chosen to use or change a template here (tplroles.ts).
  forgetChosen(accountId, from.id, actor);
  return moved.length;
}

// How a deleted login's address is remembered for the welcome signatures (table `welcomed`): a fingerprint made with
// the server's own secret. It cannot be turned back into the address, and nobody without the secret can test an
// address against it. wasWelcomed answers whether a login under this address was given them before it was deleted.
export const welcomeMark = (email: string) => hmac(`welcome:${String(email).trim().toLowerCase()}`);
export const wasWelcomed = (email: string): boolean => !!get('SELECT 1 x FROM welcomed WHERE email_hash=?', welcomeMark(email));

// The API keys a person made that still work, each with the account it works for. "team" marks an account the
// person does not own: it goes on without them, and its admins are the ones whose integration breaks.
export const keysOf = (userId: string): any[] => all(`SELECT k.id, k.name, k.prefix, k.scope, k.last_used_at, a.id account_id, a.name account, m.role != 'owner' team
  FROM api_keys k JOIN accounts a ON a.id=k.account_id JOIN memberships m ON m.account_id=k.account_id AND m.user_id=k.user_id
  WHERE k.user_id=? AND k.stopped_at IS NULL ORDER BY k.created_at`, userId);

// How a key is named in an email: what lets someone find it in the list, never the key itself.
export const keyList = (keys: any[], withAccount = false) =>
  keys.map((k) => `"${k.name}" (${k.prefix}..., ${k.last_used_at ? `last used ${k.last_used_at.slice(0, 10)}` : 'never used'})${withAccount ? ` in ${k.account}` : ''}`).join('\n');

// A key hangs on the person who made it. When that person closes their own login, their keys in a team go off with
// them and whatever used those keys breaks, exactly as when an admin removes them. Nobody should learn that from a
// failing integration, so the team's admins are told which keys, why, and what to do: "off" when the closing
// starts, "back" when the person signs in again in time, "stopped" when the login is deleted.
export async function tellTeamsAboutKeys(who: { id: string; name: string }, keys: any[], what: 'off' | 'back' | 'stopped', until = '') {
  const teams = new Map<string, any[]>();
  for (const k of keys) if (k.team) teams.set(k.account_id, [...(teams.get(k.account_id) || []), k]);
  for (const [accountId, theirs] of teams) {
    const team = theirs[0].account;
    const one = theirs.length === 1;
    const n = one ? 'An API key' : `${theirs.length} API keys`;
    const list = keyList(theirs);
    const [state, why, lines] = {
      off: [`${one ? 'is' : 'are'} switched off`, `${who.name} is closing their login`, [`${who.name} is closing their GrowSigning login. The API keys ${who.name} created in ${team} were switched off at that moment:`, list,
        'Anything that uses one of them now gets an error that says so. To carry on, create a new key and put it into the integration.',
        `Nothing is deleted before ${until.slice(0, 10)}. If ${who.name} signs in again before then, the keys work again. If not, they stop for good on that day. You are told by email when either happens.`]],
      back: [`${one ? 'works' : 'work'} again`, `${who.name} kept their login`, [`${who.name} signed in again, so their GrowSigning login is no longer being closed. The API keys ${who.name} created in ${team} work again from that moment:`, list,
        'If you put a new key into an integration in the meantime, the old one is not needed any more. You can revoke it under Settings, API and webhooks.']],
      stopped: ['stopped working', `${who.name} closed their login`, [`${who.name} closed their GrowSigning login, and it has now been deleted. The API keys ${who.name} created in ${team} have stopped for good:`, list,
        'Anything that still uses one of them gets an error that says the key has stopped. To carry on, create a new key and put it into the integration. The stopped keys stay on your list until you clear them.']],
    }[what] as [string, string, string[]];
    for (const a of all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin') AND m.user_id!=?", accountId, who.id))
      await sendMail({ to: a.email, about: who.id, subject: `${n} of ${team} ${state}: ${why}`, heading: `${n} ${state}`, lines, cta: { label: 'Open API keys', url: `${baseUrl()}/app/settings?tab=developers` } });
  }
}
// The same list for the person who is closing, in the email they get about it.
const ownKeyLines = (keys: any[], intro: string) => (keys.length ? [intro, keyList(keys, true),
  ...(keys.some((k) => k.team) ? ['Where a key belongs to a team, the admins of that team have been told by email, because whatever uses it now gets an error.'] : [])] : []);

// Closing an account is separate from cancelling a plan, and says exactly what it removes before it does.
route('GET', '/me/delete', (c) => {
  const owned = all("SELECT a.id, a.name, a.plan, a.cancel_at, (SELECT COUNT(*) FROM memberships x WHERE x.account_id=a.id) members, (SELECT COUNT(*) FROM envelopes e WHERE e.account_id=a.id AND e.kind='envelope') envelopes, (SELECT COUNT(*) FROM envelopes e WHERE e.account_id=a.id AND e.status='sent') in_flight FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role='owner'", c.user.id);
  // The API keys that go off with the login, so nobody finds out from an integration that stopped.
  const keys = keysOf(c.user.id).map((k) => ({ name: k.name, prefix: k.prefix, last_used_at: k.last_used_at, account: k.account, team: !!k.team }));
  return { owned, blocked: owned.filter((a) => a.members > 1).map((a) => a.name), keys };
});

export { CLOSE_GRACE_DAYS };

// Removes a user and every account they own, for good. Answers with the API keys this stopped in teams the person
// only belonged to, so the caller can tell those teams (tellTeamsAboutKeys).
//
// What goes: the login, and for every account the person owns alone the account itself with its envelopes,
// templates, contacts, keys and webhooks (the database removes those with the account), and everything that does
// not hang on the account in the database: uploaded and signed files, files signers attached, audit trails, stored
// copies of emails, replaced links, reports, webhook logs and batch records. What stays is what the accounts need:
// payments, refunds and the signature ledger, with the plan history emptied of its wording (it names people) and
// the link to the receipt removed. A help request that is still open stays until a person has answered it.
export function purgeUser(userId: string): any[] {
  const user = get('SELECT id, name, email, email_verified, created_at FROM users WHERE id=?', userId);
  if (!user) return [];
  // Nothing under a legal hold goes, by this path or any other (records.ts). The attempt is recorded.
  assertMayClose(userId, `Deleting the login of ${user.name}`);
  const owned = all("SELECT a.id FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role='owner'", userId);
  const stopped = keysOf(userId).filter((k) => k.team);
  const shas: string[] = [];
  tx(() => {
    for (const a of owned) {
      // An account other people are in is not deleted over their heads. Closing is refused while others use an
      // account, and nobody can join one that is closing, so this is a last line of defence: the account passes to
      // its longest-standing admin, or else member, and what the person who left sent in it goes to them below.
      const heir = get("SELECT user_id FROM memberships WHERE account_id=? AND user_id!=? ORDER BY role='admin' DESC, created_at LIMIT 1", a.id, userId);
      if (heir) {
        run("UPDATE memberships SET role=CASE WHEN user_id=? THEN 'owner' ELSE 'member' END WHERE account_id=? AND user_id IN (?,?)", heir.user_id, a.id, heir.user_id, userId);
        run('UPDATE accounts SET closing_at=NULL WHERE id=?', a.id);
        continue;
      }
      // A file that was turned into a PDF takes its stored original along (converted.ts).
      shas.push(...originalShas(a.id));
      shas.push(...all('SELECT sha256 s FROM files WHERE account_id=?', a.id).map((r) => r.s), ...forgetEnvelopes(all('SELECT id FROM envelopes WHERE account_id=?', a.id).map((r) => r.id), true));
      run('DELETE FROM abuse_reports WHERE account_id=?', a.id);
      run('DELETE FROM files WHERE account_id=?', a.id);
      // The delivery logs of its webhooks, and also what is left of the log of a webhook that was deleted before
      // delivery logs went with their webhook: those lines are found through the account's envelopes.
      run('DELETE FROM webhook_deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE account_id=?) OR envelope_id IN (SELECT id FROM envelopes WHERE account_id=?)', a.id, a.id);
      run('DELETE FROM bulk_batches WHERE account_id=?', a.id);
      run("UPDATE billing_log SET detail='' WHERE account_id=?", a.id);
      // The ledger of signatures stays (accounts have to be kept), but each "signature used" line is named after
      // the recipient and their address. The address goes; the line keeps a name of its own.
      run("UPDATE credits SET ref = substr(ref, 1, instr(ref, '|')) || id WHERE account_id=? AND reason='signature' AND instr(ref, '|') > 0", a.id);
      run('UPDATE payments SET receipt_url=NULL WHERE account_id=?', a.id);
      // Click-to-agree terms, versions and acceptances go with the account row; our copies of the emails that sent
      // people what they accepted are removed here (clickwrap.ts), and the certificate PDFs attached to them below.
      shas.push(...forgetClickwraps(a.id));
      // The account's retention record keeps what happened to which envelope, without names or words (records.ts).
      forgetRetentionLog(a.id);
      run('DELETE FROM accounts WHERE id=?', a.id);
    }
    // In teams they only belonged to, what they sent passes to the owner so nothing is stranded.
    for (const m of all('SELECT account_id FROM memberships WHERE user_id=?', userId)) {
      const owner = get("SELECT user_id FROM memberships WHERE account_id=? AND role='owner'", m.account_id);
      if (owner) handOver(m.account_id, user, owner.user_id, { name: 'System' }, `${user.name} closed their login`);
    }
    // What they wrote to the help form goes too, each request with its whole thread (the database removes a
    // request's messages with it). A request nobody has answered yet stays until it is answered, and so does one
    // on which we asked them something and wait for their reply (see forgetNow in routes-support.ts), or closing an
    // account would be a way to lose a refund question. Requests are matched by address only when the address was
    // confirmed: signing up with somebody else's proves nothing.
    // A request they wrote while signed in under somebody else's address is not theirs to take along: the answers go
    // to that mailbox, and its owner may have written on it through our link. It stays with that address, with
    // nothing left that ties it to this login (the name too, when it was the login's own), and goes like that
    // address's other requests (supportTick in routes-support.ts).
    run('UPDATE support_requests SET user_id=NULL, account_id=NULL, name=CASE WHEN name=? THEN NULL ELSE name END WHERE user_id=? AND lower(email)!=lower(?)', user.name, userId, user.email);
    // The alerts the software files (routes-billing.ts, evidence.ts, filestore.ts) are kept under the address of
    // whoever answers. They belong to the service, not to that person, and stay when an operator leaves (isAlert in
    // routes-support.ts).
    const theirs = `((user_id=?${user.email_verified ? ' OR lower(email)=lower(?)' : ''}) AND NOT (ref IS NULL AND user_id IS NULL AND COALESCE(name, '')='GrowSigning (automatic alert)'))`;
    const who = user.email_verified ? [userId, user.email] : [userId];
    run(`DELETE FROM support_requests WHERE ${theirs} AND status NOT IN ('open','waiting')`, ...who);
    run(`UPDATE support_requests SET forget=1, user_id=NULL, account_id=NULL WHERE ${theirs}`, ...who);
    // Our stored copies of emails that belong to no envelope and went to the person (sign-up, receipts, reminders,
    // notices). Only the address an email was sent to decides, never what its text says: a help message, a user
    // name or an account name is words a stranger typed, and other customers' copies must not hang on them. An
    // address the login never confirmed proves nothing, so then only copies written since the login was made go,
    // and never one about another login (an invitation somebody sent to that address). Emails about a document
    // somebody else sent them are part of that sender's record and stay with it. A copy that still has to be
    // delivered is left alone (NOT_WAITING) and goes with the others after MAIL_COPY_DAYS.
    run(`DELETE FROM emails WHERE envelope_id IS NULL AND lower(to_email)=lower(?) AND ${NOT_WAITING}${user.email_verified ? '' : ' AND at >= ? AND (about_user IS NULL OR about_user=?)'}`,
      ...(user.email_verified ? [user.email] : [user.email, user.created_at, userId]));
    // Copies of emails to OTHER people that are about the person: an invitation they sent, a notice to a team's
    // admins about their API keys or that they left. Each such email is marked with the login it is about when it
    // is written (emails.about_user), and only that mark decides: never a name or a part of an address, which
    // other customers can share. A copy that still has to be delivered is left alone; it goes with every other
    // copy outside a document's record after MAIL_COPY_DAYS.
    run(`DELETE FROM emails WHERE about_user=? AND envelope_id IS NULL AND ${NOT_WAITING}`, userId);
    run('DELETE FROM password_resets WHERE user_id=?', userId);
    // A sign-in at Google or Microsoft this login started to connect one: it names the login, and goes with it.
    run('DELETE FROM signin_states WHERE user_id=?', userId);
    // Which contacts of a team they had in their own list. The contacts themselves are the team's and stay.
    run('DELETE FROM contact_users WHERE user_id=?', userId);
    // A key they made in a team is on that team's list, not theirs to take along. It stops for good and stays
    // listed as stopped, with the maker's name, so an admin can see what happened to whatever used it. The keys of
    // the accounts deleted above went with those accounts.
    run('UPDATE api_keys SET stopped_at=COALESCE(stopped_at, ?), owner_was=(SELECT name FROM users WHERE id=?) WHERE user_id=?', now(), userId, userId);
    // The welcome signatures are given once per email address. While a login exists its own row says so. When it
    // goes, a keyed fingerprint of the address is what is left to say it (see welcomeMark), with the day. Only for
    // an address that was confirmed: a stranger who signed up with somebody else's address and deleted the login
    // has not used up that person's welcome.
    const welcomed = get('SELECT welcomed_at w FROM users WHERE id=? AND email_verified=1', userId)?.w;
    if (welcomed) run('INSERT OR IGNORE INTO welcomed (email_hash, at) VALUES (?,?)', welcomeMark(user.email), String(welcomed).slice(0, 10));
    run('DELETE FROM users WHERE id=?', userId);
  });
  removeUnusedBlobs(shas);
  return stopped;
}

// How long a file a signer uploaded but never attached to anything is kept.
const LOOSE_UPLOAD_DAYS = 30;
const CLOSED_SUBJECT = 'Your GrowSigning account is closed';

// Run from the timer: accounts whose grace period has passed are removed, and teams hear which keys stopped.
// A week before that, the person is told the day, how to keep the account and how to take a copy of everything
// first, so the deletion never comes as a surprise. Once for each time an account is closed.
export async function purgeClosedAccounts(): Promise<number> {
  const soon = new Date(Date.now() + CLOSING_REMINDER_DAYS * 864e5).toISOString();
  for (const u of all('SELECT id, name, email, closing_at FROM users WHERE closing_at IS NOT NULL AND closing_at > ? AND closing_at <= ? AND (closing_reminded IS NULL OR closing_reminded != closing_at)', now(), soon)) {
    run('UPDATE users SET closing_reminded=? WHERE id=?', u.closing_at, u.id);
    const day = u.closing_at.slice(0, 10);
    const left = Math.max(1, Math.ceil((Date.parse(u.closing_at) - Date.now()) / 864e5));
    const owns = get("SELECT COUNT(*) n FROM memberships WHERE user_id=? AND role='owner'", u.id).n;
    await sendMail({ to: u.email, subject: `Your GrowSigning account will be deleted on ${day}`, heading: `${left === 1 ? 'One day' : `${left} days`} left: your account is deleted on ${day}`,
      lines: [`Hi ${u.name}, you closed your GrowSigning account. On ${day} ${owns ? 'it is deleted for good, with its envelopes, signed documents and audit trails' : 'your login is deleted for good'}. After that day nobody can bring it back, and that includes us.`,
        'To keep the account: sign in before that day. That is all it takes. Everything is there again at once, and nothing is deleted.',
        `To take a copy of everything first: sign in, go to Settings, then Your data, and choose Export everything. You get one ZIP file with every signed PDF, every audit trail and a list of all envelopes. Signing in keeps the account, so close it again afterwards if you still want it gone. That starts a new ${CLOSE_GRACE_DAYS} days.`,
        'If you do nothing, the account is deleted on that day and you will not hear from us again.'],
      cta: { label: 'Sign in to keep my account', url: `${baseUrl()}/login` } });
  }
  const due = all('SELECT id, name FROM users WHERE closing_at IS NOT NULL AND closing_at < ?', now());
  for (const u of due) {
    // A login whose account holds something on legal hold is not deleted (records.ts assertMayClose): it stays
    // closing, the attempt is in the account's record, and signing in again keeps it.
    let stopped: any[];
    try {
      stopped = purgeUser(u.id);
    } catch (e: any) {
      if (e?.data?.code === 'legal_hold') continue;
      throw e;
    }
    await tellTeamsAboutKeys(u, stopped, 'stopped');
  }
  // The email that says an account was deleted is the last thing kept under that address. Its stored copy goes as
  // soon as the mail server has taken it.
  run("DELETE FROM emails WHERE subject=? AND status='sent' AND envelope_id IS NULL", CLOSED_SUBJECT);
  // So does the copy of an email about an envelope that was deleted while that email was still waiting to be sent.
  run(`DELETE FROM emails WHERE envelope_id IS NOT NULL AND ${NOT_WAITING} AND envelope_id NOT IN (SELECT id FROM envelopes)`);
  // Our copy of an email that is not part of a document's record has done its job once it was delivered. It is
  // kept for a while so "did you send me that?" can be answered, then deleted, whoever it was to.
  // A file attached to such an email (the certificate of a click-to-agree acceptance) goes with it, unless something
  // else still points at it (removeUnusedBlobs).
  const oldMail = `envelope_id IS NULL AND ${NOT_WAITING} AND at < ?`, mailCut = new Date(Date.now() - MAIL_COPY_DAYS * 864e5).toISOString();
  const oldFiles = attachedFiles(all(`SELECT payload FROM emails WHERE ${oldMail} AND payload LIKE '%"sha256"%'`, mailCut));
  run(`DELETE FROM emails WHERE ${oldMail}`, mailCut);
  removeUnusedBlobs(oldFiles);
  // The fingerprint of a security code from a deleted document is kept for a year, then that goes too.
  run('DELETE FROM forgotten_codes WHERE at < ?', new Date(Date.now() - 365 * 864e5).toISOString());
  // And so does the fingerprint of a signed PDF whose document was deleted (src/server/evidence.ts).
  forgetOldFingerprints();
  // A delivery log whose webhook is gone belongs to nothing any more. Deleting a webhook takes its log along; this
  // clears what was left behind before that was so.
  run('DELETE FROM webhook_deliveries WHERE webhook_id NOT IN (SELECT id FROM webhooks)');
  // A file a signer uploaded and never attached to a field belongs to no envelope and no account, so nothing else
  // would ever remove it.
  const loose = all(`SELECT id, sha256 FROM files WHERE account_id IS NULL AND created_at < ? AND id NOT IN (SELECT value FROM fields WHERE type='attachment' AND value IS NOT NULL)`, new Date(Date.now() - LOOSE_UPLOAD_DAYS * 864e5).toISOString())
    .filter((f) => !get('SELECT 1 x FROM earlier_signatures WHERE instr(answers, ?) > 0', f.id));
  for (const f of loose) run('DELETE FROM files WHERE id=?', f.id);
  removeUnusedBlobs(loose.map((f) => f.sha256));
  return due.length;
}

// Closing is never an accident you cannot undo: by default everything is kept for 30 days and signing in again
// cancels the closure. Billing stops at once either way. "now: true" deletes immediately for people who want that.
route('POST', '/me/delete', async (c) => {
  const b = await c.body();
  // Someone who signs in with Google or Microsoft may have no password to type. Closing is confirmed with one, so
  // they are told how to get one instead of being told that a password they never had is wrong.
  if (!hasPassword(c.user)) throw bad(`Closing an account is confirmed with your password, and this login has none yet because you sign in another way. Set one first: Settings, Profile, "Email me a link to set a password". Then come back here. Nothing was changed.`, 400, { code: 'no_password' });
  if (!checkPassword(str(b.password, 200), c.user.password_hash)) throw bad('That password is not right.');
  const owned = all("SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role='owner'", c.user.id);
  for (const a of owned)
    if (get('SELECT COUNT(*) n FROM memberships WHERE account_id=?', a.id).n > 1) throw bad(`You own "${a.name}" and other people still use it. Make one of them the owner first (Settings, Team), then close your account.`);
  // Refused, before anything else changes, while something in an account that would go is on legal hold (records.ts).
  assertMayClose(c.user.id, `${c.user.name} <${c.user.email}>`);
  // Stop any billing before anything else, so a closed account can never be charged. Whatever state the plan is in,
  // it is ended on our side at once. When the payment provider does not confirm straight away, the end is queued and
  // tried again by the timer, and a payment that slips through in the meantime is refunded by the software.
  let confirmed = true;
  for (const a of owned) if (!(await stopBillingFor(a))) confirmed = false;
  // Deleting on the spot would take away the account a late payment is matched to and refunded through. So that
  // waits until the provider has confirmed. Closing with the usual days in between does not have to wait.
  if (b.now && !confirmed) throw bad(`The payment provider did not confirm just now that your subscription has ended, so nothing was deleted. Your plan is cancelled on our side and we keep trying until the provider confirms it. Try again in a few minutes. You can also close the account without deleting it at once: it is then deleted after ${CLOSE_GRACE_DAYS} days, and a payment taken in the meantime is refunded by the software.`, 502);
  // Their API keys go off with the login, at once. Read now, while the rows still say whose they are.
  const keys = keysOf(c.user.id);
  // Said in both emails, because "everything is deleted" is only true of what was theirs alone.
  const teams = all("SELECT a.name FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=? AND m.role!='owner'", c.user.id).map((a) => `"${a.name}"`).join(' and ');
  const kept = ['What we keep, because accounts have to be kept: the record of payments, refunds and of signatures bought and used, without your name or your email address. If you ever paid, the payment provider has its own record of that.',
    'A question you sent through the help form that nobody has answered yet is kept until it has been answered, and deleted then.',
    'Documents other people sent you to sign belong to them, so those are not affected.'];
  if (b.now) {
    // A refund still on its way when the account goes: the money still reaches the card, and the email says so,
    // because there is no Plan page any more to show it and no account to send "Refund sent" to.
    const owed = pendingRefundLines(owned.map((a) => a.id));
    // Written before the deletion: the accounts this person owns go with their record, the teams keep the line.
    record('account.closing', { c, member: c.user.id, about: ['user', c.user.id], details: { deleted_now: true, keys_stopped: keys.length } });
    await tellTeamsAboutKeys(c.user, purgeUser(c.user.id), 'stopped');
    await sendMail({ to: c.user.email, subject: CLOSED_SUBJECT, heading: 'Account closed and deleted',
      lines: [owned.length ? `Your login has been deleted, and with it ${owned.map((a) => `"${a.name}"`).join(' and ')} and everything in it: envelopes, drafts and templates, uploaded and signed documents, files signers attached, audit trails, contacts, API keys, webhooks and our copies of the emails about them. Any subscription has been stopped. You will not be charged again.` : 'Your login has been deleted.',
        ...owed,
        ...(teams ? [`What you sent as a member of ${teams} was not deleted. It belongs to that team and has passed to its owner.`] : []),
        ...ownKeyLines(keys, keys.length === 1 ? 'This API key of yours no longer works:' : 'These API keys of yours no longer work:'), ...kept] });
    // Its stored copy is not kept either once the mail server has taken it (see purgeClosedAccounts for the rest).
    run("DELETE FROM emails WHERE subject=? AND status='sent' AND envelope_id IS NULL AND lower(to_email)=lower(?)", CLOSED_SUBJECT, c.user.email);
    return { closed: 'now' };
  }
  const when = new Date(Date.now() + CLOSE_GRACE_DAYS * 864e5).toISOString();
  run('UPDATE users SET closing_at=? WHERE id=?', when, c.user.id);
  for (const a of owned) run('UPDATE accounts SET closing_at=? WHERE id=?', when, a.id);
  record('account.closing', { c, member: c.user.id, about: ['user', c.user.id], details: { deleted_now: false, deletes_at: when, accounts_closing: owned.length, keys_switched_off: keys.length } });
  run('DELETE FROM sessions WHERE user_id=?', c.user.id);
  await tellTeamsAboutKeys(c.user, keys, 'off', when);
  await sendMail({ to: c.user.email, subject: 'Your GrowSigning account is closing', heading: `Your account will be deleted on ${when.slice(0, 10)}`,
    lines: [confirmed ? 'Any subscription has been stopped and you will not be charged again.' : 'Your subscription is cancelled on our side. The payment provider did not confirm it straight away, so we keep trying until it does. If a payment is taken in the meantime, the software refunds it by itself.',
      `Until ${when.slice(0, 10)} nothing is deleted. Changed your mind, or closed it by mistake? Just sign in again and the account comes straight back.`,
      ...ownKeyLines(keys, `${keys.length === 1 ? 'This API key of yours is' : 'These API keys of yours are'} switched off from now. Signing in again before ${when.slice(0, 10)} switches ${keys.length === 1 ? 'it' : 'them'} back on:`),
      owned.length ? `After that date your login and ${owned.map((a) => `"${a.name}"`).join(' and ')} are removed for good, with everything in it: envelopes, signed documents, files signers attached, audit trails and our copies of the emails about them. To take a copy first, sign in, export everything under Settings, Your data, and close the account again.` : 'After that date your login is removed for good.',
      ...(teams ? [`What you sent as a member of ${teams} is not deleted. It belongs to that team and passes to its owner on that date.`] : []),
      ...kept, `We remind you by email ${CLOSING_REMINDER_DAYS} days before that date.`],
    cta: { label: 'Sign in to keep my account', url: `${baseUrl()}/login` } });
  return { closed: 'scheduled', deletes_at: when };
});

// ---- The people running the service --------------------------------------------------------

export const isOperator = (user: any) =>
  !!user?.email_verified && (process.env.OPERATOR_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).includes(String(user.email).toLowerCase());
const operator = (c: Ctx) => {
  if (!isOperator(c.user)) throw new HttpError(404, 'Not found');
};

route('GET', '/operator/queue', (c) => {
  operator(c);
  // Next to every request and report stands the account it is about: its plan, when it was created, and whether a
  // person has cleared it. That is what an operator needs to decide between answering, trusting and pausing. A help
  // request is matched to the account it was written from, or to the one owned by the confirmed address it came from.
  const about = 'a.name account_name, a.plan account_plan, a.created_at account_created_at, a.trusted_at account_trusted_at, a.suspended_at';
  return {
    support: all(`SELECT s.*, a.id about_account, ${about} FROM support_requests s
      LEFT JOIN accounts a ON a.id=COALESCE(s.account_id, (SELECT m.account_id FROM users u JOIN memberships m ON m.user_id=u.id AND m.role='owner' WHERE u.email=s.email AND u.email_verified=1 LIMIT 1))
      WHERE s.status='open' ORDER BY s.at LIMIT 200`),
    // A report stays in the queue when the envelope it was about has been deleted since (envelope_deleted): a sender
    // who voids and deletes what was reported must not make the earlier reports disappear from a person's view.
    // via_form marks a report from the visitor of a public form, which does not count towards the automatic pause.
    // clickwrap_id marks a report made from the page of click-to-agree terms (routes-clickwrap.ts), not about an envelope.
    reports: all(`SELECT r.*, e.subject, e.message, e.id IS NULL envelope_deleted, u.name sender_name, u.email sender_email, a.id about_account, ${about},
        (SELECT k.name FROM clickwraps k WHERE k.id=r.clickwrap_id) clickwrap_name, (SELECT k.slug FROM clickwraps k WHERE k.id=r.clickwrap_id) clickwrap_slug
      FROM abuse_reports r LEFT JOIN envelopes e ON e.id=r.envelope_id LEFT JOIN users u ON u.id=e.sender_id JOIN accounts a ON a.id=r.account_id WHERE r.status='open' ORDER BY r.at LIMIT 200`)
      .map((r) => ({ ...r, envelope_deleted: !!r.envelope_deleted && !r.clickwrap_id, via_form: !!r.via_form })),
    paused: all('SELECT id, name, plan, created_at, trusted_at, suspended_at, suspended_reason FROM accounts WHERE suspended_at IS NOT NULL ORDER BY suspended_at DESC'),
  };
});
// Working a help request (take it, answer, ask, note, close) is POST /operator/support/:id in routes-support.ts.
route('POST', '/operator/reports/:id', async (c) => {
  operator(c);
  run('UPDATE abuse_reports SET status=? WHERE id=?', (await c.body()).status === 'upheld' ? 'upheld' : 'dismissed', c.params.id);
});
// Pausing stops everything that emails a recipient in the account's name: new sends, new or changed recipients,
// reminders and reopening. People keep every document they already have, and can still sign what is out.
// Trusting is the other tool: the refusals for the daily limit and the fake-notice filter promise that a person can
// lift them, and this is how. A trusted account skips both. Reports from recipients count for it like for anyone.
// A reply reaches a person only where the operator set SUPPORT_EMAIL (it becomes the Reply-To). Without it a reply
// goes to the no-reply sender, so the email offers only the contact form.
const mistakeLine = () => `If this is a mistake, ${process.env.SUPPORT_EMAIL ? 'reply to this email or ' : ''}use the contact form at ${baseUrl()}/help and a person will review it.`;
route('POST', '/operator/accounts/:id', async (c) => {
  operator(c);
  const b = await c.body();
  const a = get('SELECT * FROM accounts WHERE id=?', c.params.id);
  if (!a) throw bad('Account not found.', 404);
  const admins = all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", a.id);
  // The call has to say what it wants, as true or false. A body that names neither is a mistake to point out: it
  // used to be read as "lift the pause", which dismissed every open report and told the owner they could send again.
  if (typeof b.trusted !== 'boolean' && typeof b.paused !== 'boolean')
    throw bad('Say what to change: "paused": true (with a "reason") or false, or "trusted": true or false. Nothing was changed.');
  if (typeof b.trusted === 'boolean') {
    run('UPDATE accounts SET trusted_at=? WHERE id=?', b.trusted ? a.trusted_at || now() : null, a.id);
    if (b.trusted !== !!a.trusted_at) record(b.trusted ? 'operator.trusted' : 'operator.untrusted', { accounts: a.id, by: { type: 'operator', id: c.user.id } });
    // Told either way, so a limit never lifts or comes back without a word. The numbers are the ones that apply
    // to this account now: the first-week limit in its first week, and nothing at all when a payment of its own
    // is old enough to have lifted the checks anyway.
    const { cap, firstWeek } = dailyCap(a);
    const again = hasNotPaid({ ...a, trusted_at: null })
      ? `Until the account has a payment that is at least ${PAID_TRUST_DAYS} days old and was not refunded or disputed, it can send to at most ${cap} people a day${firstWeek ? ` (${unpaidDailyRecipients()} a day after its first week)` : ''} and is checked for fake payment notices again.`
      : `For you nothing changes: the account has a payment that is more than ${PAID_TRUST_DAYS} days old and was not refunded or disputed, so the daily limit and the check for fake payment notices do not apply to it.`;
    if (b.trusted !== !!a.trusted_at)
      for (const u of admins)
        await sendMail({ to: u.email, subject: b.trusted ? 'A person has cleared your GrowSigning account' : 'The sending limits apply to your GrowSigning account again', heading: b.trusted ? 'Your account is cleared' : 'Your account is no longer marked as trusted',
          lines: b.trusted ? [`Someone on the GrowSigning team looked at ${a.name} and marked it as trusted. The daily limit on how many people you can send to, and the check for fake payment notices, no longer apply to it.`, 'If something you tried to send was refused, send it again now.']
            : [`Someone on the GrowSigning team removed the trusted mark from ${a.name}. ${again}`, mistakeLine()],
          cta: { label: b.trusted ? 'Open GrowSigning' : 'Contact us', url: b.trusted ? `${baseUrl()}/app` : `${baseUrl()}/help` } });
    if (b.trusted) await releaseHeld(a.id);
    return { trusted: b.trusted };
  }
  const reason = str(b.reason, 300).trim() || 'Paused by the GrowSigning team';
  if (b.paused) run('UPDATE accounts SET suspended_at=?, suspended_reason=? WHERE id=?', now(), reason, a.id);
  else {
    // Lifting a pause means a person has looked at everything reported so far. Those reports do not count again.
    run('UPDATE accounts SET suspended_at=NULL, suspended_reason=NULL, unpaused_at=? WHERE id=?', now(), a.id);
    run("UPDATE abuse_reports SET status='dismissed' WHERE account_id=? AND status='open'", a.id);
  }
  // The reason is the one the admins are emailed below.
  if (b.paused || a.suspended_at) record(b.paused ? 'operator.paused' : 'operator.resumed', { accounts: a.id, by: { type: 'operator', id: c.user.id }, details: b.paused ? { reason } : {} });
  for (const u of admins)
    await sendMail({ to: u.email, subject: b.paused ? 'Sending is paused on your GrowSigning account' : 'Sending is back on for your GrowSigning account', heading: b.paused ? 'Sending is paused' : 'You can send again',
      lines: b.paused ? [`Reason: ${reason.replace(/[.\s]+$/, '')}.`, PAUSED_MEANS, 'You can still open, download and export everything in your account, and people who already have a document can still open, sign and download it.', mistakeLine()]
        : ['A person looked at it and lifted the pause. Sorry for the interruption.', 'Anyone who was waiting further down a signing order while it lasted is being asked now. Reminders start again by themselves.'],
      cta: { label: 'Contact us', url: `${baseUrl()}/help` } });
  if (!b.paused) await releaseHeld(a.id);
});

// What the guard held back for an account (people waiting further down a signing order) goes out as soon as a person
// lifts the pause or clears the account. The timer does the same for everything else, the next time it runs.
async function releaseHeld(accountId: string) {
  for (const row of all("SELECT id FROM envelopes WHERE account_id=? AND status='sent' AND kind='envelope' AND held_at IS NOT NULL", accountId)) {
    const e = loadEnvelope(row.id);
    if (!e || emailRefusal(e, [], { extra: [e.last_change] })) continue;
    run('UPDATE envelopes SET held_at=NULL WHERE id=?', e.id);
    await advance(e.id);
  }
}

// Used by the app shell to decide what to show.
export const trustInfo = (c: Ctx) => ({ operator: isOperator(c.user), support_email: process.env.SUPPORT_EMAIL || null });
