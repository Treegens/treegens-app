import fs from 'node:fs';
import path from 'node:path';
import { route, type Ctx } from './router.ts';
import { all, get, run, tx, readBlob, dataDir } from './db.ts';
import { bad, id, now, isEmail, str, rateLimit, baseUrl, parseCode, HttpError } from './util.ts';
import { checkPassword } from './auth.ts';
import { sendMail } from './mail.ts';
import { auditTrail, emailMyLinks, resendFromRetired } from './envelopes.ts';
import { loadEnvelope, reportAbuse } from './envelopes.ts';
import { sameEmail } from './credits.ts';
import { unpaidDailyRecipients } from '../lib/policy.ts';
import { CLOSE_GRACE_DAYS } from '../lib/policy.ts';
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
  // Anyone can type any address into this form. So the acknowledgement only repeats the message to an address we
  // know belongs to the writer: someone signed in, writing from their own confirmed address. Everyone else gets the
  // reference and nothing a stranger wrote, or the form would send any text to any inbox under our name.
  const known = !!c.user?.email_verified && sameEmail(email, c.user.email);
  await sendMail({ to: email, subject: `We got your message (${ref})`, heading: 'A person will reply to you',
    lines: [`Your reference is ${ref}. Reply to this email if you want to add anything.`, ...(known ? ['What you sent us:', message] : ['If you did not write to us, someone typed your address into our help form by mistake. You can ignore this email.'])] });
  return { reference: ref };
}, 'public');

// What you asked and whether it has been answered, for people who are logged in. Requests filed while signed in as
// this user, and requests filed from this user's address once the address is confirmed. Signing up with somebody
// else's address proves nothing, so an unconfirmed address never matches.
route('GET', '/support/mine', (c) => ({ requests: all(`SELECT id, topic, message, status, at FROM support_requests WHERE user_id=?${c.user.email_verified ? ' OR email=?' : ''} ORDER BY at DESC LIMIT 30`, ...(c.user.email_verified ? [c.user.id, c.user.email] : [c.user.id])).map((r) => ({ ...r, reference: r.id.slice(-8).toUpperCase() })) }));

// ---- Is this email real? -------------------------------------------------------------------

route('POST', '/public/check', async (c) => {
  rateLimit(`check:${c.ip}`, 30, 3600_000);
  const code = parseCode((await c.body()).code);
  if (code.length !== 12) throw bad('Security codes are 12 letters and numbers, like ABCD-EFGH-JKLM. Check the email and try again.');
  const r = get('SELECT * FROM recipients WHERE check_code=?', code);
  if (!r?.token) {
    // A code from an email we really sent, whose link has since been replaced: the sender corrected the address or
    // the role, the signer passed the document on, or the person was taken off. That email was genuine and is said
    // to be, with why its link no longer works and what to do. Its link is never handed out again.
    const old = get('SELECT * FROM retired_tokens WHERE check_code=? ORDER BY retired_at DESC LIMIT 1', code);
    if (!old) return { genuine: false };
    const oe = old.envelope_id ? get('SELECT subject, status, sender_id, account_id FROM envelopes WHERE id=?', old.envelope_id) : null;
    const account = oe ? get('SELECT name, suspended_at FROM accounts WHERE id=?', oe.account_id) : null;
    return { genuine: true, replaced: true, why: old.why || 'address', replaced_at: old.retired_at, for_name: old.sent_to || null,
      sender: oe ? get('SELECT name, email FROM users WHERE id=?', oe.sender_id) : null, account: account?.name, paused: !!account?.suspended_at, subject: oe?.subject || null, status: oe?.status || null };
  }
  const e = get('SELECT id, subject, status, sender_id, account_id, sent_at FROM envelopes WHERE id=?', r.envelope_id);
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
  const r = code.length === 12 ? get('SELECT id, envelope_id, token FROM recipients WHERE check_code=?', code) : null;
  let e = r?.token ? loadEnvelope(r.envelope_id) : null;
  let who = e?.recipients.find((x: any) => x.id === r.id);
  if (!who && code.length === 12) {
    // The code of a genuine email whose link was replaced since (the sender changed the address, say). Whoever
    // holds that email can report it all the same, under the address it was sent to.
    const old = get('SELECT * FROM retired_tokens WHERE check_code=? ORDER BY retired_at DESC LIMIT 1', code);
    const to = old?.envelope_id ? get('SELECT to_email FROM emails WHERE envelope_id=? AND recipient_id=? AND at <= ? ORDER BY id DESC LIMIT 1', old.envelope_id, old.recipient_id, old.retired_at)?.to_email : null;
    e = to ? loadEnvelope(old.envelope_id) : null;
    who = e ? { name: old.sent_to || to, email: to } : null;
  }
  if (!who) throw bad('We do not recognise that security code, so we cannot tell which email you mean. Use the contact form on the help page and tell us what the email says.', 404);
  await reportAbuse(e, who, b, { name: `${who.name} <${who.email}>`, ip: c.ip, ua: c.ua });
  return { ok: true };
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
  const bulk = c.q.get('bulk');
  const scope = c.admin ? '' : ' AND sender_id=?';
  const rows = all(`SELECT * FROM envelopes WHERE account_id=? AND kind='envelope' AND status!='draft'${scope} ORDER BY sent_at`, ...(c.admin ? [c.account.id] : [c.account.id, c.user.id]))
    .filter((e) => (!only.length || only.includes(e.id)) && (!bulk || e.bulk_id === bulk));
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
      off: [`${one ? 'is' : 'are'} switched off`, `${who.name} is closing their login`, [`${who.name} is closing their Sign&Grow login. The API keys ${who.name} created in ${team} were switched off at that moment:`, list,
        'Anything that uses one of them now gets an error that says so. To carry on, create a new key and put it into the integration.',
        `Nothing is deleted before ${until.slice(0, 10)}. If ${who.name} signs in again before then, the keys work again. If not, they stop for good on that day. You are told by email when either happens.`]],
      back: [`${one ? 'works' : 'work'} again`, `${who.name} kept their login`, [`${who.name} signed in again, so their Sign&Grow login is no longer being closed. The API keys ${who.name} created in ${team} work again from that moment:`, list,
        'If you put a new key into an integration in the meantime, the old one is not needed any more. You can revoke it under Settings, API and webhooks.']],
      stopped: ['stopped working', `${who.name} closed their login`, [`${who.name} closed their Sign&Grow login, and it has now been deleted. The API keys ${who.name} created in ${team} have stopped for good:`, list,
        'Anything that still uses one of them gets an error that says the key has stopped. To carry on, create a new key and put it into the integration. The stopped keys stay on your list until you clear them.']],
    }[what] as [string, string, string[]];
    for (const a of all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin') AND m.user_id!=?", accountId, who.id))
      await sendMail({ to: a.email, subject: `${n} of ${team} ${state}: ${why}`, heading: `${n} ${state}`, lines, cta: { label: 'Open API keys', url: `${baseUrl()}/app/settings?tab=developers` } });
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
export function purgeUser(userId: string): any[] {
  const owned = all("SELECT a.id FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=? AND m.role='owner'", userId);
  const stopped = keysOf(userId).filter((k) => k.team);
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
    // A key they made in a team is on that team's list, not theirs to take along. It stops for good and stays
    // listed as stopped, with the maker's name, so an admin can see what happened to whatever used it. The keys of
    // the accounts deleted above went with those accounts.
    run('UPDATE api_keys SET stopped_at=COALESCE(stopped_at, ?), owner_was=(SELECT name FROM users WHERE id=?) WHERE user_id=?', now(), userId, userId);
    run('DELETE FROM users WHERE id=?', userId);
  });
  removeUnusedBlobs(shas);
  return stopped;
}

// Run from the timer: accounts whose grace period has passed are removed, and teams hear which keys stopped.
export async function purgeClosedAccounts(): Promise<number> {
  const due = all('SELECT id, name FROM users WHERE closing_at IS NOT NULL AND closing_at < ?', now());
  for (const u of due) await tellTeamsAboutKeys(u, purgeUser(u.id), 'stopped');
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
  // Their API keys go off with the login, at once. Read now, while the rows still say whose they are.
  const keys = keysOf(c.user.id);
  if (b.now) {
    await tellTeamsAboutKeys(c.user, purgeUser(c.user.id), 'stopped');
    await sendMail({ to: c.user.email, subject: 'Your Sign&Grow account is closed', heading: 'Account closed and deleted', lines: ['Your account and everything in it has been deleted, and any subscription has been stopped. You will not be charged again.',
      ...ownKeyLines(keys, keys.length === 1 ? 'This API key of yours no longer works:' : 'These API keys of yours no longer work:'), 'Documents other people sent you to sign belong to them, so those are not affected.'] });
    return { closed: 'now' };
  }
  const when = new Date(Date.now() + CLOSE_GRACE_DAYS * 864e5).toISOString();
  run('UPDATE users SET closing_at=? WHERE id=?', when, c.user.id);
  for (const a of owned) run('UPDATE accounts SET closing_at=? WHERE id=?', when, a.id);
  run('DELETE FROM sessions WHERE user_id=?', c.user.id);
  await tellTeamsAboutKeys(c.user, keys, 'off', when);
  await sendMail({ to: c.user.email, subject: 'Your Sign&Grow account is closing', heading: `Your account will be deleted on ${when.slice(0, 10)}`,
    lines: ['Any subscription has been stopped and you will not be charged again.', `Until ${when.slice(0, 10)} nothing is deleted. Changed your mind, or closed it by mistake? Just sign in again and the account comes straight back.`,
      ...ownKeyLines(keys, `${keys.length === 1 ? 'This API key of yours is' : 'These API keys of yours are'} switched off from now. Signing in again before ${when.slice(0, 10)} switches ${keys.length === 1 ? 'it' : 'them'} back on:`),
      'After that date the account, its documents and its audit trails are removed for good. Export anything you want to keep before then.'],
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
    reports: all(`SELECT r.*, e.subject, e.message, u.name sender_name, u.email sender_email, a.id about_account, ${about}
      FROM abuse_reports r JOIN envelopes e ON e.id=r.envelope_id JOIN users u ON u.id=e.sender_id JOIN accounts a ON a.id=r.account_id WHERE r.status='open' ORDER BY r.at LIMIT 200`),
    paused: all('SELECT id, name, plan, created_at, trusted_at, suspended_at, suspended_reason FROM accounts WHERE suspended_at IS NOT NULL ORDER BY suspended_at DESC'),
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
// Pausing stops everything that emails a recipient in the account's name: new sends, new or changed recipients,
// reminders and reopening. People keep every document they already have, and can still sign what is out.
// Trusting is the other tool: the refusals for the daily limit and the fake-notice filter promise that a person can
// lift them, and this is how. A trusted account skips both. Reports from recipients count for it like for anyone.
route('POST', '/operator/accounts/:id', async (c) => {
  operator(c);
  const b = await c.body();
  const a = get('SELECT * FROM accounts WHERE id=?', c.params.id);
  if (!a) throw bad('Account not found.', 404);
  const admins = all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin')", a.id);
  if ('trusted' in b) {
    run('UPDATE accounts SET trusted_at=? WHERE id=?', b.trusted ? a.trusted_at || now() : null, a.id);
    // Told either way, so a limit never lifts or comes back without a word.
    if (!!b.trusted !== !!a.trusted_at)
      for (const u of admins)
        await sendMail({ to: u.email, subject: b.trusted ? 'A person has cleared your Sign&Grow account' : 'The sending limits apply to your Sign&Grow account again', heading: b.trusted ? 'Your account is cleared' : 'Your account is no longer marked as trusted',
          lines: b.trusted ? [`Someone on the Sign&Grow team looked at ${a.name} and marked it as trusted. The daily limit on how many people you can send to, and the check for fake payment notices, no longer apply to it.`, 'If something you tried to send was refused, send it again now.']
            : [`Someone on the Sign&Grow team removed the trusted mark from ${a.name}. While the account has not paid for anything, it can send to at most ${unpaidDailyRecipients()} people a day and is checked for fake payment notices again. Paying for anything lifts both.`, 'If this is a mistake, reply to this email or use the contact form and a person will review it.'],
          cta: { label: b.trusted ? 'Open Sign&Grow' : 'Contact us', url: b.trusted ? `${baseUrl()}/app` : `${baseUrl()}/help` } });
    return { trusted: !!b.trusted };
  }
  const reason = str(b.reason, 300).trim() || 'Paused by the Sign&Grow team';
  if (b.paused) run('UPDATE accounts SET suspended_at=?, suspended_reason=? WHERE id=?', now(), reason, a.id);
  else {
    // Lifting a pause means a person has looked at everything reported so far. Those reports do not count again.
    run('UPDATE accounts SET suspended_at=NULL, suspended_reason=NULL, unpaused_at=? WHERE id=?', now(), a.id);
    run("UPDATE abuse_reports SET status='dismissed' WHERE account_id=? AND status='open'", a.id);
  }
  for (const u of admins)
    await sendMail({ to: u.email, subject: b.paused ? 'Sending is paused on your Sign&Grow account' : 'Sending is back on for your Sign&Grow account', heading: b.paused ? 'Sending is paused' : 'You can send again',
      lines: b.paused ? [`Reason: ${reason.replace(/[.\s]+$/, '')}.`, 'Until a person has looked at it, nothing new goes out: no new envelopes, no new or changed recipients, no reminders and no reopening.', 'You can still open, download and export everything in your account, and people who already have a document can still open, sign and download it.', 'If this is a mistake, reply to this email or use the contact form and a person will review it.'] : ['A person looked at it and lifted the pause. Sorry for the interruption.'],
      cta: { label: 'Contact us', url: `${baseUrl()}/help` } });
});

// Used by the app shell to decide what to show.
export const trustInfo = (c: Ctx) => ({ operator: isOperator(c.user), support_email: process.env.SUPPORT_EMAIL || null });
