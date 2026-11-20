import fs from 'node:fs';
import path from 'node:path';
import { route, type Ctx } from './router.ts';
import { all, get, run, tx, readBlob, dataDir } from './db.ts';
import { bad, id, now, isEmail, str, rateLimit, baseUrl, parseCode, HttpError } from './util.ts';
import { checkPassword } from './auth.ts';
import { sendMail } from './mail.ts';
import { auditTrail, emailMyLinks, resendFromRetired } from './envelopes.ts';
import { zipStream, safeName, ZIP_MAX_BYTES, ZIP_MAX_FILES, type ZipEntry } from './zip.ts';

// Things that exist so nobody gets stuck: help that reaches a person, proof an email is genuine, lost links,
// taking your documents with you, closing an account, and the queue the people running the service work from.

// ---- Help ----------------------------------------------------------------------------------

export const SUPPORT_TOPICS = ['signing', 'sending', 'billing', 'cannot-log-in', 'suspicious', 'other'];

route('GET', '/public/support', () => ({ email: process.env.SUPPORT_EMAIL || null, topics: SUPPORT_TOPICS }), 'public');

// Open to everyone: signers, free users, former customers, and people who cannot log in.
route('POST', '/public/support', async (c) => {
  rateLimit(`support:${c.ip}`, 8, 3600_000);
  const b = await c.body();
  const email = str(b.email || c.user?.email, 254).trim();
  const message = str(b.message, 5000).trim();
  if (!isEmail(email)) throw bad('Enter an email address we can reply to.');
  if (message.length < 10) throw bad('Tell us a little more so we can help on the first reply.');
  const topic = SUPPORT_TOPICS.includes(b.topic) ? b.topic : 'other';
  const sid = id('sup');
  run('INSERT INTO support_requests (id, email, name, topic, message, envelope_id, user_id, account_id, at) VALUES (?,?,?,?,?,?,?,?,?)',
    sid, email, str(b.name || c.user?.name, 120) || null, topic, message, str(b.envelope_id, 60) || null, c.user?.id ?? null, c.account?.id ?? null, now());
  const ref = sid.slice(-8).toUpperCase();
  if (process.env.SUPPORT_EMAIL)
    await sendMail({ to: process.env.SUPPORT_EMAIL, replyTo: email, subject: `[${topic}] ${message.slice(0, 60)}`, heading: `Help request ${ref}`,
      lines: [`From ${str(b.name || c.user?.name, 120) || 'someone'} <${email}>${c.account ? `, account ${c.account.name} (${c.account.plan})` : ', not logged in'}.`, ...(b.envelope_id ? [`About envelope ${str(b.envelope_id, 60)}.`] : []), message],
      cta: { label: 'Open the queue', url: `${baseUrl()}/app/operator` } });
  await sendMail({ to: email, subject: `We got your message (${ref})`, heading: 'A person will reply to you',
    lines: [`Your reference is ${ref}. Reply to this email if you want to add anything.`, 'What you sent us:', message] });
  return { reference: ref };
}, 'public');

// ---- Is this email real? -------------------------------------------------------------------

route('POST', '/public/check', async (c) => {
  rateLimit(`check:${c.ip}`, 30, 3600_000);
  const code = parseCode((await c.body()).code);
  if (code.length !== 12) throw bad('Security codes are 12 letters and numbers, like ABCD-EFGH-JKLM. Check the email and try again.');
  const r = get('SELECT * FROM recipients WHERE check_code=?', code);
  if (!r?.token) return { genuine: false };
  const e = get('SELECT id, subject, status, sender_id, account_id, sent_at FROM envelopes WHERE id=?', r.envelope_id);
  const sender = get('SELECT name, email FROM users WHERE id=?', e.sender_id);
  const account = get('SELECT name, suspended_at FROM accounts WHERE id=?', e.account_id);
  return { genuine: true, sender, account: account?.name, paused: !!account?.suspended_at, subject: e.subject, status: e.status, sent_at: r.sent_at || e.sent_at, for_name: r.name, role: r.role, url: `${baseUrl()}/sign/${r.token}` };
}, 'public');

// ---- Lost or replaced links ----------------------------------------------------------------

// Answers are deliberately the same whether or not anything was found, so nobody can probe who signs what.
route('POST', '/public/links/resend', async (c) => {
  rateLimit(`resend:${c.ip}`, 10, 3600_000);
  await resendFromRetired(str((await c.body()).token, 100));
  return { ok: true };
}, 'public');

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
  const scope = c.admin ? '' : ' AND sender_id=?';
  const rows = all(`SELECT * FROM envelopes WHERE account_id=? AND kind='envelope' AND status!='draft'${scope} ORDER BY sent_at`, ...(c.admin ? [c.account.id] : [c.account.id, c.user.id]))
    .filter((e) => !only.length || only.includes(e.id));
  if (!rows.length) throw bad('There is nothing to export yet.');

  function* entries(): Generator<ZipEntry> {
    const index = [csv(['envelope_id', 'subject', 'status', 'sent_at', 'completed_at', 'recipients', 'signed_pdf_sha256', 'file'])];
    let bytes = 0, files = 0, skipped = 0;
    for (const e of rows) {
      const people = all('SELECT name, email, role, status FROM recipients WHERE envelope_id=? ORDER BY routing_order, position', e.id);
      const base = `${(e.completed_at || e.sent_at || e.created_at).slice(0, 10)} ${safeName(e.subject)} ${e.id.slice(-6)}`;
      let file = '';
      if (e.final_sha256 && files < ZIP_MAX_FILES - 3 && bytes + (e.final_size || 0) < ZIP_MAX_BYTES) {
        const data = readBlob(e.final_sha256);
        file = `signed/${base}.pdf`;
        bytes += data.length;
        files++;
        yield { name: file, data };
      } else if (e.final_sha256) skipped++;
      if (files < ZIP_MAX_FILES - 3) {
        files++;
        yield { name: `audit/${base}.json`, data: Buffer.from(JSON.stringify({ envelope: { id: e.id, subject: e.subject, status: e.status, sent_at: e.sent_at, completed_at: e.completed_at }, recipients: people, events: auditTrail(e.id) }, null, 2)) };
      }
      index.push(csv([e.id, e.subject, e.status, e.sent_at, e.completed_at, people.map((p) => `${p.name} <${p.email}> (${p.role}: ${p.status})`).join('; '), e.final_sha256, file]));
    }
    yield { name: 'envelopes.csv', data: Buffer.from('﻿' + index.join('\r\n')) };
    yield { name: 'README.txt', data: Buffer.from([
      `Sign&Grow export for ${c.account.name}, made ${now()}.`, '',
      'signed/        completed documents, each with its certificate of completion',
      'audit/         the full audit trail of every envelope, as JSON',
      'envelopes.csv  one row per envelope',
      '', `Check any signed PDF at ${baseUrl()}/verify. It must be the exact file from this export.`,
      ...(skipped ? ['', `${skipped} signed document(s) did not fit in one ZIP file. Export again with fewer envelopes selected to get them.`] : []),
    ].join('\r\n')) };
  }
  return new Response(zipStream(entries()), { headers: { 'content-type': 'application/zip', 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="sign-and-grow-export-${now().slice(0, 10)}.zip"` } });
});

function removeUnusedBlobs(shas: string[]) {
  for (const sha of new Set(shas.filter(Boolean))) {
    if (get('SELECT 1 x FROM files WHERE sha256=?', sha) || get('SELECT 1 x FROM envelopes WHERE final_sha256=?', sha)) continue;
    fs.rmSync(path.join(dataDir(), 'blobs', sha), { force: true });
  }
}

// Closing an account is separate from cancelling a plan, and says exactly what it removes before it does.
route('GET', '/me/delete', (c) => {
  const owned = all("SELECT a.id, a.name, a.plan, a.cancel_at, (SELECT COUNT(*) FROM memberships x WHERE x.account_id=a.id) members, (SELECT COUNT(*) FROM envelopes e WHERE e.account_id=a.id AND e.kind='envelope') envelopes, (SELECT COUNT(*) FROM envelopes e WHERE e.account_id=a.id AND e.status='sent') in_flight FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role='owner'", c.user.id);
  return { owned, blocked: owned.filter((a) => a.members > 1).map((a) => a.name) };
});

export const CLOSE_GRACE_DAYS = 30;

// Removes a user and every account they own, for good.
export function purgeUser(userId: string) {
  const owned = all("SELECT a.id FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role='owner'", userId);
  const shas: string[] = [];
  tx(() => {
    for (const a of owned) {
      shas.push(...all('SELECT sha256 s FROM files WHERE account_id=?', a.id).map((r) => r.s), ...all('SELECT final_sha256 s FROM envelopes WHERE account_id=?', a.id).map((r) => r.s));
      run('DELETE FROM files WHERE account_id=?', a.id);
      run('DELETE FROM accounts WHERE id=?', a.id);
    }
    // In teams they only belonged to, their envelopes pass to the owner so nothing is stranded.
    for (const m of all('SELECT account_id FROM memberships WHERE user_id=?', userId)) {
      const owner = get("SELECT user_id FROM memberships WHERE account_id=? AND role='owner'", m.account_id);
      if (owner) run('UPDATE envelopes SET sender_id=? WHERE account_id=? AND sender_id=?', owner.user_id, m.account_id, userId);
    }
    run('DELETE FROM api_keys WHERE user_id=?', userId);
    run('DELETE FROM users WHERE id=?', userId);
  });
  removeUnusedBlobs(shas);
}

// Run from the timer: accounts whose grace period has passed are removed.
export function purgeClosedAccounts(): number {
  const due = all('SELECT id FROM users WHERE closing_at IS NOT NULL AND closing_at < ?', now());
  for (const u of due) purgeUser(u.id);
  return due.length;
}

// Closing is never an accident you cannot undo: by default everything is kept for 30 days and signing in again
// cancels the closure. Billing stops at once either way. "now: true" deletes immediately for people who want that.
route('POST', '/me/delete', async (c) => {
  const b = await c.body();
  if (!checkPassword(str(b.password, 200), c.user.password_hash)) throw bad('That password is not right.');
  const owned = all("SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role='owner'", c.user.id);
  for (const a of owned)
    if (get('SELECT COUNT(*) n FROM memberships WHERE account_id=?', a.id).n > 1) throw bad(`You own "${a.name}" and other people still use it. Make one of them the owner first (Settings, Team), then close your account.`);
  // Stop any billing before anything else, so a closed account can never be charged.
  for (const a of owned) {
    if (a.stripe_subscription_id && process.env.STRIPE_SECRET_KEY && a.plan === 'grove') {
      const res = await fetch(`https://api.stripe.com/v1/subscriptions/${a.stripe_subscription_id}`, { method: 'DELETE', headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }).catch(() => null);
      if (!res || !res.ok) throw bad('We could not stop your subscription with the payment provider just now, so nothing was closed. Try again in a minute, or cancel the plan first.', 502);
      run("UPDATE accounts SET plan='seedling', subscription_status='canceled', cancel_at=NULL, renews_at=NULL WHERE id=?", a.id);
    }
  }
  if (b.now) {
    purgeUser(c.user.id);
    await sendMail({ to: c.user.email, subject: 'Your Sign&Grow account is closed', heading: 'Account closed and deleted', lines: ['Your account and everything in it has been deleted, and any subscription has been stopped. You will not be charged again.', 'Documents other people sent you to sign belong to them, so those are not affected.'] });
    return { closed: 'now' };
  }
  const when = new Date(Date.now() + CLOSE_GRACE_DAYS * 864e5).toISOString();
  run('UPDATE users SET closing_at=? WHERE id=?', when, c.user.id);
  for (const a of owned) run('UPDATE accounts SET closing_at=? WHERE id=?', when, a.id);
  run('DELETE FROM sessions WHERE user_id=?', c.user.id);
  await sendMail({ to: c.user.email, subject: 'Your Sign&Grow account is closing', heading: `Your account will be deleted on ${when.slice(0, 10)}`,
    lines: ['Any subscription has been stopped and you will not be charged again.', `Until ${when.slice(0, 10)} nothing is deleted. Changed your mind, or closed it by mistake? Just sign in again and the account comes straight back.`, 'After that date the account, its documents and its audit trails are removed for good. Export anything you want to keep before then.'],
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
  return {
    support: all("SELECT * FROM support_requests WHERE status='open' ORDER BY at LIMIT 200"),
    reports: all(`SELECT r.*, e.subject, e.message, u.name sender_name, u.email sender_email, a.name account_name, a.suspended_at
      FROM abuse_reports r JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id JOIN accounts a ON a.id=r.account_id WHERE r.status='open' ORDER BY r.at LIMIT 200`),
    paused: all('SELECT id, name, plan, suspended_at, suspended_reason FROM accounts WHERE suspended_at IS NOT NULL ORDER BY suspended_at DESC'),
  };
});
route('POST', '/operator/support/:id', async (c) => {
  operator(c);
  run('UPDATE support_requests SET status=? WHERE id=?', (await c.body()).status === 'open' ? 'open' : 'closed', c.params.id);
});
route('POST', '/operator/reports/:id', async (c) => {
  operator(c);
  run('UPDATE abuse_reports SET status=? WHERE id=?', (await c.body()).status === 'upheld' ? 'upheld' : 'dismissed', c.params.id);
});
// Pausing stops new sends only. People keep every document they already have.
route('POST', '/operator/accounts/:id', async (c) => {
  operator(c);
  const b = await c.body();
  const a = get('SELECT * FROM accounts WHERE id=?', c.params.id);
  if (!a) throw bad('Account not found.', 404);
  if (b.paused) run('UPDATE accounts SET suspended_at=?, suspended_reason=? WHERE id=?', now(), str(b.reason, 300) || 'Paused by the Sign&Grow team', a.id);
  else {
    run('UPDATE accounts SET suspended_at=NULL, suspended_reason=NULL WHERE id=?', a.id);
    run("UPDATE abuse_reports SET status='dismissed' WHERE account_id=? AND status='open'", a.id);
  }
  for (const u of all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", a.id))
    await sendMail({ to: u.email, subject: b.paused ? 'Sending is paused on your Sign&Grow account' : 'Sending is back on for your Sign&Grow account', heading: b.paused ? 'Sending is paused' : 'You can send again',
      lines: b.paused ? [`Reason: ${str(b.reason, 300) || 'a report from a recipient'}.`, 'You can still open, download and export everything in your account. Only new sends are paused.', 'If this is a mistake, reply to this email or use the contact form and a person will review it.'] : ['We reviewed the report and lifted the pause. Sorry for the interruption.'],
      cta: { label: 'Contact us', url: `${baseUrl()}/help` } });
});

// Used by the app shell to decide what to show.
export const trustInfo = (c: Ctx) => ({ operator: isOperator(c.user), support_email: process.env.SUPPORT_EMAIL || null });
