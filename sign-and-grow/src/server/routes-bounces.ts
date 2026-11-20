import { route, json, type Ctx } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { randomInt } from 'node:crypto';
import { bad, baseUrl, hmac, HttpError, isEmail, now, rateLimit, safeEqual, sha256, str, token } from './util.ts';
import { sendMail } from './mail.ts';
import { checkPassword, hasPassword } from './auth.ts';
import { needCode } from './twostep.ts';
import { fireWebhooks } from './webhooks.ts';
import { audit, assertMayEmail, loadEnvelope, notifyRecipient, notifySender, reportAbuse, senderOf } from './envelopes.ts';
import { find, look } from './routes-sign.ts';
import { bouncedMember } from './groups.ts';
import { welcomeMark } from './routes-trust.ts';
import {
  mailEventsAuth, readEvents, bounceWhy, softBounceDays, forgetSoftDays, noteBounced, forgetBounced, mailStop, mailStopText, sameAddress as same, type MailEvent,
  goneMail, noteComplaint, forgetComplaint,
} from './bounces.ts';
import { abuseSuspendAfter, BOUNCE_MATCH_DAYS, BOUNCE_WARN_DAYS, SOFT_BOUNCE_DAYS } from '../lib/policy.ts';

// What is done when the mail provider says an email did not arrive, was marked as spam, or arrived. How its message
// is read is in bounces.ts. The rules, each in one place below:
//   - A hard bounce of an email to a recipient marks that person, is written to the envelope's record, tells the
//     sender, stops reminders to the address and puts it on the account's do-not-mail list.
//   - A hard bounce of an email to one of our own customers (a login) marks the login. The app then says so on
//     every page, and the other admins of their teams are told.
//   - A soft bounce is noted and stops nothing, until the same address has answered "try later" on SOFT_BOUNCE_DAYS
//     separate days. Then it counts as hard.
//   - A complaint stops every email to that person about that envelope and counts as a report against the sender.
//   - "Delivered" is noted, and is the proof that an address works again.
// Every one of them does its work once, however often the provider repeats itself.

const SYSTEM = { name: 'System' };
const MAX_BODY = 1_048_576; // one megabyte: the largest batch a provider sends is well under it
const MAX_EVENTS = 2000;
const g = globalThis as any;

// ---- Which email is it about -------------------------------------------------------------------

// Only an email that was handed over can have news ('outbox' is the stand-in for that on a machine with no mail server).
const LEFT = "status IN ('sent','outbox')";
// By our own ids when the provider handed one back, and only when the address fits too: a number that happens to
// exist is not enough. Otherwise by the address alone: the newest email to it from the last BOUNCE_MATCH_DAYS that
// has no such news yet, and if every one has, the newest (the news is then a repeat and changes nothing).
function findMail(ev: MailEvent): any {
  if (ev.mail_id) {
    const m = get(`SELECT * FROM emails WHERE id=? AND ${LEFT}`, Number(ev.mail_id));
    if (m && same(m.to_email, ev.email)) return m;
  }
  if (ev.message_id) {
    const m = get(`SELECT * FROM emails WHERE message_id=? AND ${LEFT}`, ev.message_id);
    if (m && same(m.to_email, ev.email)) return m;
  }
  const since = new Date(Date.now() - BOUNCE_MATCH_DAYS * 864e5).toISOString();
  const open = { bounce: "(bounce_kind IS NULL OR bounce_kind='soft')", soft_bounce: 'bounce_kind IS NULL', complaint: 'complained_at IS NULL', delivered: 'delivered_at IS NULL AND bounce_kind IS NULL' }[ev.type];
  const recent = `to_email=? COLLATE NOCASE AND ${LEFT} AND COALESCE(tried_at, at) > ?`;
  return get(`SELECT * FROM emails WHERE ${recent} AND ${open} ORDER BY id DESC LIMIT 1`, ev.email, since) || get(`SELECT * FROM emails WHERE ${recent} ORDER BY id DESC LIMIT 1`, ev.email, since);
}

// The moment the provider named, when it is believable, otherwise now.
const when = (at?: string): string => (at && Date.parse(at) <= Date.now() + 60_000 && Date.parse(at) > Date.now() - 30 * 864e5 ? at : now());
const sentAt = (m: any): string => m.tried_at || m.at;

// The recipients of an envelope an email was for: the one it was written to, while that person still has the
// address it went to, and otherwise everyone on the envelope at that address (two people can share one). Nobody
// when the address is the sender's own: that is an email to a login. An in-person signer is never emailed.
function recipientsOf(e: any, m: any): any[] {
  const exact = m.recipient_id ? e.recipients.filter((r: any) => r.id === m.recipient_id && r.role !== 'inperson' && same(r.email, m.to_email)) : [];
  return exact.length ? exact : e.recipients.filter((r: any) => r.role !== 'inperson' && same(r.email, m.to_email));
}
const names = (rows: any[], m: any): string => (rows.length ? rows.map((r) => `${r.name} <${r.email}>`).join(' and ') : m.to_email);
const firstNames = (rows: any[], m: any): string => (rows.length ? rows.map((r) => r.name).join(' and ') : m.to_email);

// ---- Hard bounce -------------------------------------------------------------------------------

async function hardBounce(m: any, at: string, why: { plain: string; raw: string; full: string }): Promise<'applied' | 'repeat'> {
  if (m.bounce_kind === 'hard') return 'repeat';
  run("UPDATE emails SET bounced_at=?, bounce_kind='hard', bounce_reason=? WHERE id=?", at, why.full.slice(0, 500), m.id);
  forgetSoftDays(m.to_email);
  const e = m.envelope_id ? loadEnvelope(m.envelope_id) : null;
  const own = !!e && same(senderOf(e)?.email, m.to_email);
  if (e && e.kind === 'envelope' && !own) return (await recipientBounce(e, m, at, why), 'applied');
  // An email to one of our own customers: about their plan, their login, or their own envelope.
  const u = get('SELECT * FROM users WHERE email=?', m.to_email);
  if (u) await loginBounce(u, at, why);
  return 'applied';
}

async function recipientBounce(e: any, m: any, at: string, why: { plain: string; raw: string }) {
  const rows = recipientsOf(e, m);
  const fresh = rows.filter((r: any) => !r.bounced_at);
  for (const r of fresh) run('UPDATE recipients SET bounced_at=?, bounce_reason=? WHERE id=?', at, why.plain, r.id);
  // The account's do-not-mail list: a new envelope to this address warns before it goes out.
  noteBounced(e.account_id, m.to_email, why.plain, at);
  const out = e.status === 'sent';
  const said = why.raw ? ` Their mail server said: "${why.raw}".` : '';
  audit(e.id, SYSTEM, 'Email could not be delivered', `Email to ${names(rows, m)} could not be delivered: ${why.plain}.${said} The email was "${str(m.subject, 200)}".${out && fresh.length ? ' Reminders to this address are stopped until the address is corrected or the sender chooses to try again.' : ''}`);
  // A second email that comes back from an address already marked is written down, and nobody is told twice.
  if (rows.length && !fresh.length) return;
  // The address of one member of a signing group, which no recipient row carries: said as such (groups.ts).
  const member = !rows.length && out ? bouncedMember(e.id, m.to_email) : null;
  if (!e.hidden_at)
    await notifySender(e, 'problems', `Could not be delivered: ${e.subject}`, `Our email to ${member?.name || firstNames(rows, m)} did not arrive`, [
      `The email "${m.subject}" to ${m.to_email} could not be delivered: ${why.plain}.${said}`,
      member ? member.line : out && fresh.length ? `No reminders go to this address until you do one of two things. Open the envelope and choose Correct next to ${firstNames(rows, m)} to fix the address: a new email goes out at once. Or, if the address is right and the mailbox works again, choose "Try again" there. You can also copy their signing link from the same page and send it to them yourself.`
        : e.status === 'completed' ? 'The envelope is completed, so there is nothing to send again from here. Download the signed document from the envelope page and send it to them yourself.'
        : out ? 'Open the envelope to see who is on it now. If this person should still get it, add them with the right address.'
        : 'The envelope is closed, so nothing more is sent to them about it.',
      `For the next ${BOUNCE_WARN_DAYS} days, a new envelope to ${m.to_email} shows you this before it goes out.`,
    ]);
  fireWebhooks(e.account_id, 'envelope.updated', e.id, { ...(fresh[0] ? { recipient_id: fresh[0].id } : {}), change: 'email_bounced' });
}

// The login keeps working and we keep writing to it: renewal reminders and receipts are owed whatever became of the
// last one. What changes is that the person is told in the app (GET /me carries the mark), and that the other owners
// and admins of their teams hear it once, because a plan may hang on a mailbox nobody reads.
async function loginBounce(u: any, at: string, why: { plain: string }) {
  if (!run('UPDATE users SET email_bounced_at=?, email_bounce_reason=? WHERE id=? AND email_bounced_at IS NULL', at, why.plain, u.id).changes) return;
  for (const a of all('SELECT a.id, a.name, m.role FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=?', u.id)) {
    const runsIt = a.role === 'owner' || a.role === 'admin';
    for (const o of all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin') AND u.id != ?", a.id, u.id))
      await sendMail({ to: o.email, about: u.id, subject: `Our emails to ${u.name} are not arriving`, heading: `Our emails to ${u.name} come back`,
        lines: [`An email from Sign&Grow to ${u.name} (${u.email}), who is on the team of ${a.name}, could not be delivered: ${why.plain}.`,
          `So ${u.name} is not getting our emails about documents${runsIt ? ', and not the renewal reminders, receipts and other notices about the plan that go to owners and admins' : ''}. The app tells them on every page the next time they open it, and they can move their login to an address that works from there.`,
          `You do not have to do anything. If ${u.name} no longer reads that mailbox, it is worth checking under Settings, Team who looks after this account.`],
        cta: { label: 'Open your team', url: `${baseUrl()}/app/settings?tab=team` } });
  }
}

// ---- Soft bounce, complaint, delivered -----------------------------------------------------------

async function softBounce(m: any, at: string, reason?: string): Promise<'applied' | 'repeat'> {
  if (m.bounce_kind === 'hard') return 'repeat';
  const why = bounceWhy(reason, false);
  const first = !m.bounced_at;
  run("UPDATE emails SET bounced_at=?, bounce_kind='soft', bounce_reason=? WHERE id=?", at, why.full.slice(0, 500), m.id);
  // The same address on SOFT_BOUNCE_DAYS separate days is an address that does not work.
  const days = softBounceDays(m.to_email, at);
  if (days >= SOFT_BOUNCE_DAYS) return hardBounce(m, at, { plain: `${why.plain}, on ${days} separate days`, raw: why.raw, full: `${why.plain}, on ${days} separate days${why.raw ? ` (${why.raw})` : ''}` });
  const e = first && m.envelope_id ? loadEnvelope(m.envelope_id) : null;
  if (e && e.kind === 'envelope' && !same(senderOf(e)?.email, m.to_email))
    audit(e.id, SYSTEM, 'Email not delivered yet', `Email to ${names(recipientsOf(e, m), m)} has not arrived yet: ${why.plain}.${why.raw ? ` Their mail server said: "${why.raw}".` : ''} The email was "${str(m.subject, 200)}". Nothing was stopped: it usually arrives later, and reminders go on.`);
  return 'applied';
}

async function complaint(m: any, at: string): Promise<'applied' | 'repeat'> {
  if (m.complained_at) return 'repeat';
  run('UPDATE emails SET complained_at=? WHERE id=?', at, m.id);
  const e = m.envelope_id ? loadEnvelope(m.envelope_id) : null;
  // About an email that is not about an envelope, or to the sender themselves: noted on the email, nothing more.
  if (!e || e.kind !== 'envelope' || same(senderOf(e)?.email, m.to_email)) return 'applied';
  const rows = recipientsOf(e, m);
  const fresh = rows.filter((r: any) => !r.complained_at);
  if (rows.length && !fresh.length) return 'applied';
  for (const r of fresh) run('UPDATE recipients SET complained_at=? WHERE id=?', at, r.id);
  audit(e.id, SYSTEM, 'Marked as spam', `${names(rows, m)} marked the email "${str(m.subject, 200)}" as spam in their mail program. Nothing more is emailed to them about this envelope unless they ask for it themselves on their signing page.`);
  // It counts against the sending account exactly as the "Report this email" link does: the same list, the same
  // count towards a pause, once for each person and envelope. Someone who is no longer on the envelope counts too.
  for (const r of fresh.length ? fresh : [{ id: '', name: m.to_email, email: m.to_email }])
    await reportAbuse(e, r, { reason: 'spam', detail: 'Marked as spam in their mail program. Reported by the mail provider, not typed by the person.' }, { name: 'Mail provider' });
  if (!e.hidden_at)
    await notifySender(e, 'always', `Marked as spam: ${e.subject}`, `${firstNames(rows, m)} marked our email as spam`, [
      `${names(rows, m)} marked the email "${m.subject}" as spam in their mail program. So we no longer email them about this document: no reminders, no notice when you change it, and no copy when it is completed.`,
      ...(fresh.length ? [`Only ${firstNames(rows, m)} can undo that: their signing page has a button that starts our emails to them again. You can still give them their link yourself. Open the envelope and choose Copy link next to their name.`] : []),
      `It also counts as one report against your account, like the "Report this email" link in our emails does. When ${abuseSuspendAfter()} different recipients have reported an account within 30 days, its sending is paused until a person has looked.`,
    ]);
  fireWebhooks(e.account_id, 'envelope.updated', e.id, { ...(fresh[0] ? { recipient_id: fresh[0].id } : {}), change: 'email_marked_as_spam' });
  return 'applied';
}

// An email that arrives is the proof that its address works. Marks that are older than this email go: on the
// account's do-not-mail list, on every envelope of the account that is still out to that address (each record
// says why, so a mark never vanishes without a word), and on a login with that address. News about an email that
// was sent before the bounce proves nothing and clears nothing.
function delivered(m: any, at: string): 'applied' | 'repeat' {
  if (m.delivered_at) return 'repeat';
  run('UPDATE emails SET delivered_at=? WHERE id=?', at, m.id);
  if (m.bounce_kind === 'hard') return 'applied';
  forgetSoftDays(m.to_email);
  const accountId = m.envelope_id ? get('SELECT account_id a FROM envelopes WHERE id=?', m.envelope_id)?.a : null;
  if (accountId) {
    forgetBounced(accountId, m.to_email, sentAt(m));
    for (const r of all("SELECT r.id, r.name, r.envelope_id FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE e.account_id=? AND e.status='sent' AND lower(r.email)=lower(?) AND r.bounced_at < ?", accountId, m.to_email, sentAt(m))) {
      run('UPDATE recipients SET bounced_at=NULL, bounce_reason=NULL WHERE id=?', r.id);
      audit(r.envelope_id, SYSTEM, 'Address works again', `A later email to ${r.name} <${m.to_email}> reached their mail server, so the address works. Reminders to it are on again.`);
      fireWebhooks(accountId, 'envelope.updated', r.envelope_id, { recipient_id: r.id, change: 'email_works_again' });
    }
  }
  run('UPDATE users SET email_bounced_at=NULL, email_bounce_reason=NULL WHERE lower(email)=lower(?) AND email_bounced_at < ?', m.to_email, sentAt(m));
  return 'applied';
}

/** Applies one piece of news. 'unmatched': it names no email of ours, so nothing is done with it. */
export async function applyMailEvent(ev: MailEvent): Promise<'applied' | 'repeat' | 'unmatched'> {
  const m = findMail(ev);
  if (!m) return 'unmatched';
  const at = when(ev.at);
  if (ev.type === 'delivered') return delivered(m, at);
  if (ev.type === 'complaint') return complaint(m, at);
  if (ev.type === 'soft_bounce') return softBounce(m, at, ev.reason);
  return hardBounce(m, at, bounceWhy(ev.reason, true));
}

// ---- The address the mail provider calls ---------------------------------------------------------

async function readLimited(req: Request): Promise<string> {
  const tooBig = () => bad(`That body is larger than ${MAX_BODY / 1024} KB, which is more than this address reads. Send the events in smaller batches.`, 413);
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) throw tooBig();
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  for (let n = 0; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    if ((n += value.length) > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Amazon SNS asks a new address to prove it wants the messages by fetching a link. Fetching whatever link a message
// names would let anyone who has the secret point this server at any address, so only a link to the SNS service
// itself is fetched: https, a host of the form sns.<region>.amazonaws.com, no redirects, nothing read from the answer.
async function confirmSubscription(raw: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname)) return false;
  try {
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

// POST /mail/events: bounce, complaint and delivery news from the mail provider. Public, and authorised by
// MAIL_EVENTS_TOKEN alone. Without that setting the route does not exist. It never answers 500 for something in the
// message: what it cannot read it says it could not read, so a provider does not send the same thing for days.
route('POST', '/mail/events', async (c) => {
  const auth = mailEventsAuth(c.req, c.url);
  if (auth === 'off') throw new HttpError(404, 'Not found');
  if (auth !== 'ok') {
    // Wrong tries from one address are slowed down. A right one is never counted.
    rateLimit(`mail-events:${c.ip}`, 30, 900_000);
    throw new HttpError(401, 'The secret for mail events is missing or wrong. Send the value of MAIL_EVENTS_TOKEN as ?token=..., as "Authorization: Bearer ...", or as the password of HTTP Basic.');
  }
  const text = await readLimited(c.req);
  // A body that is not JSON is one more shape this server does not know. It is accepted like the others (202),
  // because most providers send again for days whatever they get back that is not a success.
  let body: any, parsed = true;
  try {
    body = JSON.parse(text);
  } catch {
    parsed = false;
  }
  const read = parsed ? readEvents(body) : null;
  if (!read) {
    // Said once in the log, with the names of the top-level fields and nothing of what they hold.
    if (!g.__tsmailEventsUnknown) {
      g.__tsmailEventsUnknown = true;
      const shape = !parsed ? 'not JSON' : Array.isArray(body) ? `a list whose first item has: ${Object.keys(body[0] && typeof body[0] === 'object' ? body[0] : {}).slice(0, 20).join(', ')}` : body && typeof body === 'object' ? `an object with: ${Object.keys(body).slice(0, 20).join(', ')}` : typeof body;
      console.error(`[mail events] A message arrived at /api/mail/events in a shape this server does not know (${shape}). It was accepted and nothing was done with it. Later ones like it are not logged again. The README lists the shapes that are read.`);
    }
    return json({ ok: true, understood: false, note: parsed ? 'This message has a shape this server does not know. It was accepted and nothing was done with it.'
      : 'The body is not JSON, so nothing in it was read. It was accepted and nothing was done with it. This address takes the bounce, complaint and delivery webhooks of the mail provider as JSON.' }, 202);
  }
  if (read.confirm !== undefined) return { ok: true, subscription: (await confirmSubscription(read.confirm)) ? 'confirmed' : 'not confirmed: the link in the message does not lead to Amazon SNS' };
  const done = { applied: 0, repeat: 0, unmatched: 0, failed: 0 };
  for (const ev of read.events.slice(0, MAX_EVENTS)) {
    try {
      done[await applyMailEvent(ev)]++;
    } catch (e: any) {
      // One piece of news that cannot be applied must not make the provider send the whole batch again.
      done.failed++;
      console.error('[mail events] could not apply', ev.type, e?.message);
    }
  }
  return { ok: true, understood: true, events: read.events.length, ...done };
}, 'public');

// ---- What the sender does about it ----------------------------------------------------------------

function mine(c: Ctx, envelopeId: string) {
  const e = loadEnvelope(envelopeId);
  if (!e || e.account_id !== c.account.id || e.kind !== 'envelope' || e.hidden_at || (!c.admin && e.sender_id !== c.user.id)) throw bad('Envelope not found.', 404);
  return e;
}

// "Try again": the sender says the address works now. The mark goes, the address comes off the do-not-mail list,
// reminders are on again, and the request is emailed once more at once. If it comes back again, all of it happens
// again. It is the sender's own word that restarts emails after a bounce. After a complaint it is not theirs to give.
route('POST', '/envelopes/:id/try-again', async (c) => {
  const rid = str((await c.body()).recipient_id);
  const e = mine(c, c.params.id);
  const r = e.recipients.find((x: any) => x.id === rid);
  if (!r) throw bad('Recipient not found.', 404);
  if (mailStop(r) === 'complaint') throw bad(mailStopText(r), 409, { code: 'marked_as_spam' });
  if (!r.bounced_at) throw bad(`No email to ${r.name} has come back, so there is nothing to try again. To remind them, choose Nudge.`, 409);
  if (e.status !== 'sent') throw bad(`This envelope is ${e.status === 'completed' ? 'completed' : 'closed'}, so nothing is emailed again from here.${e.status === 'completed' ? ` Download the signed document and send it to ${r.name} yourself.` : ''}`, 409);
  // An email in the sender's name like any other: none while paused, and none for what reads like a fake notice.
  assertMayEmail(e);
  const has = r.status === 'sent' || r.status === 'viewed' || (r.status === 'completed' && r.role === 'cc');
  // The wait before "not opened yet" starts again with the email that goes out now.
  run(`UPDATE recipients SET bounced_at=NULL, bounce_reason=NULL${has && r.status === 'sent' ? ', sent_at=?, unopened_alerted_at=NULL' : ''} WHERE id=?`, ...(has && r.status === 'sent' ? [now(), r.id] : [r.id]));
  forgetBounced(e.account_id, r.email);
  audit(e.id, c.actor, 'Email tried again', `${r.name} <${r.email}>. The sender said that the address works now. Reminders to it are on again.`);
  const fresh = loadEnvelope(e.id);
  const how = has ? await notifyRecipient(fresh, fresh.recipients.find((x: any) => x.id === r.id)) : false;
  fireWebhooks(e.account_id, 'envelope.updated', e.id, { recipient_id: r.id, change: 'email_tried_again' });
  // delivery: 'sent' (the mail server took it), 'outbox' (this server has no mail server), 'failed' (not taken yet,
  // tried again by the timer), 'waiting' (it is not their turn: the email goes out when it is), 'held' (held back).
  return { ok: true, delivery: how || (has ? 'held' : 'waiting') };
});

// ---- A recipient who marked our email as spam and wants emails again -----------------------------

// Only the person themselves can undo a complaint, and holding the signing link is how they show who they are.
route('POST', '/sign/:token/mail-again', (c) => {
  const { e, r, actor } = find(c, false);
  if (!r.complained_at) return { ok: true, changed: false };
  // The sender can copy this link, so holding it is not enough when the browser (or key) is signed in to the account
  // that sent the envelope: undoing a complaint is the recipient's word alone, unless the address is that person's own.
  if (c.auth && get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', e.account_id, c.user.id) && !same(c.user.email, r.email))
    throw bad(`Only ${r.name} can ask for our emails about this document again, on their own device. You are signed in to the account that sent it, so nothing was changed. You can still send them their link yourself.`, 403);
  run('UPDATE recipients SET complained_at=NULL WHERE id=?', r.id);
  audit(e.id, actor, 'Emails started again', `${r.name} had marked an email about this envelope as spam, and now asked to be emailed about it again.`);
  fireWebhooks(e.account_id, 'envelope.updated', e.id, { recipient_id: r.id, change: 'email_wanted_again' });
  return { ok: true, changed: true };
}, 'public');

// ---- A login whose own address does not work ------------------------------------------------------

// "It works now, try again": the mark goes and one email is sent to try it. If that one comes back too, the mark is
// back with it, so pressing this does not make a dead address look alive for long.
route('POST', '/me/email-works', async (c) => {
  rateLimit(`email-works:${c.user.id}`, 6, 86400_000);
  if (!run('UPDATE users SET email_bounced_at=NULL, email_bounce_reason=NULL WHERE id=? AND email_bounced_at IS NOT NULL', c.user.id).changes) return { ok: true, cleared: false };
  const delivery = await sendMail({ to: c.user.email, subject: 'Emails from Sign&Grow reach you again', heading: 'This is the email you asked us to try',
    lines: ['An earlier email to this address came back, and you told us that the address works again. So we sent this one to try it. If you are reading it, all is well and there is nothing more to do.',
      'If an email to this address comes back again, the app tells you on every page, as it did before.'] });
  return { ok: true, cleared: true, delivery };
});

// Moving a login to another address. Until now a login kept the address it was made with, which left someone whose
// mailbox is gone (or who mistyped it at sign-up) with no way on. Two things are shown before anything changes: that
// the person is the login's owner (its password, when it has one, and its own session), and that they can read the
// new mailbox (a link sent there, opened while signed in to this login). The email to the new address says nothing
// about who asked, because it may reach a stranger.
route('POST', '/me/email', async (c) => {
  const b = await c.body();
  const email = str(b.email, 254).trim().toLowerCase();
  if (!isEmail(email)) throw bad('Enter the new email address in full, like name@example.com.');
  if (same(email, c.user.email)) throw bad(`${email} is the address of this login already. Type the address you want to move to.`);
  if (hasPassword(c.user)) {
    rateLimit(`email-change-pw:${c.user.id}`, 10, 900_000);
    if (!checkPassword(str(b.password, 200), c.user.password_hash)) throw bad('To move your login to another address, type your current password as well. That password is not right, so nothing was changed.', 403, { code: 'password_needed' });
  }
  // With two-step login on, the address (where a reset by email would go) is changed only with a current code too.
  await needCode(c, b.code, 'move your login to another address');
  rateLimit(`email-change:${c.user.id}`, 5, 86400_000);
  if (get('SELECT 1 x FROM users WHERE email=?', email)) throw bad(`There is already a Sign&Grow login with ${email}, so this one cannot move there. Nothing was changed. If that login is yours too, sign in with it instead, or close it first under Settings, Your data.`, 409);
  const t = token();
  const until = new Date(Date.now() + 3600_000).toISOString();
  run('DELETE FROM email_changes WHERE user_id=? OR expires_at < ?', c.user.id, now());
  run('INSERT INTO email_changes (token_hash, user_id, new_email, expires_at) VALUES (?,?,?,?)', sha256(t), c.user.id, email, until);
  const delivery = await sendMail({ to: email, about: c.user.id, subject: 'Confirm your new email address for Sign&Grow', heading: 'Confirm this address', expiresAt: until,
    lines: ['Someone who is signed in to Sign&Grow asked to use this address for their login from now on. If that was you, confirm it with the button below. The link works for one hour, in a browser in which you are signed in to Sign&Grow.',
      'If it was not you, ignore this email. Nothing changes without the confirmation, and nobody gets into anything of yours.'],
    cta: { label: 'Confirm this address', url: `${baseUrl()}/change-email?token=${t}` } });
  return { ok: true, sent_to: email, delivery };
});

route('POST', '/me/email/confirm', async (c) => {
  const t = str((await c.body()).token, 200);
  const row = t ? get('SELECT * FROM email_changes WHERE token_hash=? AND expires_at > ?', sha256(t), now()) : null;
  if (!row) throw bad('This link does not work any more. It works once, for one hour, and a newer request replaces it. Ask for a new one from the notice at the top of the app, or under Settings, Profile.', 410);
  if (row.user_id !== c.user.id) throw bad('This link moves a different Sign&Grow login to a new address. Sign in to that login in this browser and open the link again. Nothing was changed.', 403);
  const old = c.user.email;
  tx(() => {
    if (get('SELECT 1 x FROM users WHERE email=? AND id != ?', row.new_email, c.user.id)) throw bad(`In the meantime a Sign&Grow login was made with ${row.new_email}, so this one cannot move there. Nothing was changed.`, 409);
    // The new address is proven, and whatever was known about the old one is not about this one.
    run('UPDATE users SET email=?, email_verified=1, email_bounced_at=NULL, email_bounce_reason=NULL WHERE id=?', row.new_email, c.user.id);
    // The welcome signatures are given once per address (welcomeMark in routes-trust.ts). The confirmed address this
    // login leaves was welcomed, so a new login made under it now is not welcomed a second time.
    if (c.user.welcomed_at && c.user.email_verified) run('INSERT OR IGNORE INTO welcomed (email_hash, at) VALUES (?,?)', welcomeMark(old), String(c.user.welcomed_at).slice(0, 10));
    run('DELETE FROM email_changes WHERE user_id=?', c.user.id);
    // Links that were mailed to the old address open nothing any more, and other browsers are signed out.
    run('DELETE FROM password_resets WHERE user_id=?', c.user.id);
    run('DELETE FROM sessions WHERE user_id=? AND id != ?', c.user.id, c.auth?.sessionId || '');
  });
  // The old address is told, also when it is the one that bounces: if it still reaches someone, they should know.
  await sendMail({ to: old, subject: 'The email address of your Sign&Grow login was changed', heading: 'Your login uses another address now',
    lines: ['The Sign&Grow login that used this address was moved to another one. From now on our emails go there, and that address signs in.',
      `If you did this, there is nothing more to do. If you did not, someone else has been in your login: write to us through ${baseUrl()}/help and a person will help you get it back.`] });
  return { ok: true, email: row.new_email };
});
