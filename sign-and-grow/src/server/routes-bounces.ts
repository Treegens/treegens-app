// What the person's role allows (perm.ts): 'see_all' here, where this file once asked for an admin.
import { can } from './perm.ts';
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
import { bouncedMember, complainedMember, memberWantsMail, holderBounceLine } from './groups.ts';
import { welcomeMark } from './routes-trust.ts';
import { archiveNews } from './routes-archive.ts';
import { record } from './seclog.ts';
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
//   - A complaint stops every email to that person from that account, now and later, and counts as a report against
//     the sender. Only the person can take it back.
//   - "Delivered" is noted, and is the proof that an address works again.
// Every one of them does its work once, however often the provider repeats itself.

const SYSTEM = { name: 'System' };
const MAX_BODY = 1_048_576; // one megabyte: the largest batch a provider sends is well under it
const MAX_EVENTS = 5000; // more than a megabyte of real provider events can hold; a batch is never cut short quietly
const g = globalThis as any;

// ---- Which email is it about -------------------------------------------------------------------

// Only an email that was handed over can have news ('outbox' is the stand-in for that on a machine with no mail server).
const LEFT = "status IN ('sent','outbox')";
// Whose email it was: the account whose envelope it was about, or '' for our own emails to a login (an email to the
// sender's own address about their own envelope is one of those). For an envelope that was deleted since, the
// account kept for it (mail_gone), or a mark that matches no other email's.
const OWNER = "CASE WHEN m.envelope_id IS NULL OR lower(m.to_email)=lower(s.email) THEN '' ELSE COALESCE(e.account_id, gm.account_id, '?' || m.id) END";
const ownerOf = (m: any, e: any): string => (!m.envelope_id || (e && same(senderOf(e)?.email, m.to_email)) ? '' : e?.account_id || '?');
// Which emails to an address the news may be about, for each kind: one that has no such news yet.
const OPEN: Record<MailEvent['type'], (m: any) => boolean> = {
  bounce: (m) => (!m.bounce_kind || m.bounce_kind === 'soft') && !m.delivered_at,
  soft_bounce: (m) => !m.bounce_kind && !m.delivered_at,
  not_sent: (m) => !m.bounce_kind && !m.delivered_at,
  complaint: (m) => !m.complained_at,
  delivered: (m) => !m.delivered_at && m.bounce_kind !== 'hard',
};
type Found = { m: any } | { gone: any } | 'unknown_id' | 'ambiguous' | null;
// An email whose envelope was deleted since (it was still waiting for the mail server then) is the kept line's.
const found = (m: any, ev: MailEvent): Found => {
  if (!m.envelope_id || get('SELECT 1 x FROM envelopes WHERE id=?', m.envelope_id)) return { m };
  const gone = goneMail({ mail_id: String(m.id), email: ev.email });
  return gone ? { gone } : 'unknown_id';
};
/**
 * By our own ids when the provider handed one back, and only when the address fits too: a number that happens to
 * exist is not enough. An id that names no email of ours (or one to another address) is never guessed at by the
 * address: the news is logged and left alone, so it cannot land on somebody else's email to the same person. An
 * email of a deleted envelope is still known by its id (mail_gone). Without ids, by the address alone, among the
 * emails to it from the last BOUNCE_MATCH_DAYS, and only when they all have one sender: one account, or our own
 * emails to a login. When two senders wrote to that address, the news cannot be told apart and touches nobody.
 */
function findMail(ev: MailEvent): Found {
  if (ev.mail_id || ev.message_id) {
    for (const [col, v] of [['id', ev.mail_id ? Number(ev.mail_id) : null], ['message_id', ev.message_id]] as const) {
      const m = v ? get(`SELECT * FROM emails WHERE ${col}=? AND ${LEFT}`, v) : null;
      if (m && same(m.to_email, ev.email)) return found(m, ev);
    }
    const gone = goneMail(ev);
    return gone ? { gone } : 'unknown_id';
  }
  const since = new Date(Date.now() - BOUNCE_MATCH_DAYS * 864e5).toISOString();
  const rows = all(`SELECT m.*, ${OWNER} owner FROM emails m LEFT JOIN envelopes e ON e.id=m.envelope_id LEFT JOIN users s ON s.id=e.sender_id LEFT JOIN mail_gone gm ON gm.mail_id=m.id
    WHERE m.to_email=? COLLATE NOCASE AND m.${LEFT} AND COALESCE(m.tried_at, m.at) > ? ORDER BY m.id DESC LIMIT 500`, ev.email, since);
  if (!rows.length) return null;
  if (new Set(rows.map((r) => r.owner)).size > 1) return 'ambiguous';
  // The newest email to it that has no such news yet, and if every one has, the newest (the news is then a repeat).
  // One whose envelope went with its account has nobody left to answer for it.
  const f = found(rows.find(OPEN[ev.type]) || rows[0], ev);
  return f === 'unknown_id' ? null : f;
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

// `escalated`: the address said "try later" on SOFT_BOUNCE_DAYS separate days. The person and the address are marked
// as for a hard bounce, and the email itself stays "not delivered yet": if it arrives after all, that clears them.
async function hardBounce(m: any, at: string, why: { plain: string; raw: string; full: string }, escalated = false): Promise<'applied' | 'repeat'> {
  if (!escalated) {
    if (m.bounce_kind === 'hard') return 'repeat';
    // Our words for the customer; what the mail server wrote, for the people who run the server only.
    run("UPDATE emails SET bounced_at=?, bounce_kind='hard', bounce_reason=?, bounce_said=? WHERE id=?", at, why.plain, why.full.slice(0, 500), m.id);
  }
  const e = m.envelope_id ? loadEnvelope(m.envelope_id) : null;
  const own = !!e && same(senderOf(e)?.email, m.to_email);
  forgetSoftDays(ownerOf(m, e), m.to_email);
  if (e && e.kind === 'envelope' && !own) return (await recipientBounce(e, m, at, why), 'applied');
  // An email to one of our own customers about their own plan, login or envelope. Not one that is about somebody
  // else (an invitation, a notice to a team: emails.about_user), nor one about an envelope of another kind: a mail
  // server that refuses those may be refusing words someone else wrote, which says nothing about this mailbox.
  const u = (m.envelope_id ? own : !m.about_user) ? get('SELECT * FROM users WHERE email=?', m.to_email) : null;
  if (u) await loginBounce(u, at, why);
  return 'applied';
}

async function recipientBounce(e: any, m: any, at: string, why: { plain: string }) {
  const rows = recipientsOf(e, m);
  const fresh = rows.filter((r: any) => !r.bounced_at);
  for (const r of fresh) run('UPDATE recipients SET bounced_at=?, bounce_reason=? WHERE id=?', at, why.plain, r.id);
  // The account's do-not-mail list: a new envelope to this address warns before it goes out.
  noteBounced(e.account_id, m.to_email, why.plain, at);
  const out = e.status === 'sent';
  // In our own words only. What the mail server wrote is never quoted to the sender or in the record: whoever runs
  // that server can write anything there, a fake security notice from us included.
  audit(e.id, SYSTEM, 'Email could not be delivered', `Email to ${names(rows, m)} could not be delivered: ${why.plain}. The email was "${str(m.subject, 200)}".${out && fresh.length ? ' Reminders to this address are stopped until the address is corrected or the sender chooses to try again.' : ''}`);
  // A second email that comes back from an address already marked is written down, and nobody is told twice.
  if (rows.length && !fresh.length) return;
  // The address of one member of a signing group, which no recipient row carries: said as such (groups.ts).
  const member = !rows.length && out ? bouncedMember(e.id, m.to_email) : null;
  if (!e.hidden_at)
    await notifySender(e, 'problems', `Could not be delivered: ${e.subject}`, `Our email to ${member?.name || firstNames(rows, m)} did not arrive`, [
      `The email "${m.subject}" to ${m.to_email} could not be delivered: ${why.plain}.`,
      // The member who took a group's document on: Correct is refused for a group, so it is never the advice (groups.ts).
      member ? member.line : out && fresh.length && rows.length === 1 && holderBounceLine(rows[0]) ? holderBounceLine(rows[0])!
        : out && fresh.length ? `No reminders go to this address until you do one of two things. Open the envelope and choose Correct next to ${firstNames(rows, m)} to fix the address: a new email goes out at once. Or, if the address is right and the mailbox works again, choose "Try again" there. You can also copy their signing link from the same page and send it to them yourself.`
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
        lines: [`An email from GrowSigning to ${u.name} (${u.email}), who is on the team of ${a.name}, could not be delivered: ${why.plain}.`,
          `So ${u.name} is not getting our emails about documents${runsIt ? ', and not the renewal reminders, receipts and other notices about the plan that go to owners and admins' : ''}. The app tells them on every page the next time they open it, and they can move their login to an address that works from there.`,
          `You do not have to do anything. If ${u.name} no longer reads that mailbox, it is worth checking under Settings, Team who looks after this account.`],
        cta: { label: 'Open your team', url: `${baseUrl()}/app/settings?tab=team` } });
  }
}

// ---- Soft bounce, complaint, delivered -----------------------------------------------------------

async function softBounce(m: any, at: string, reason?: string): Promise<'applied' | 'repeat'> {
  // News that comes after the email arrived, or after it came back for good, is old news (providers do not promise
  // the order): it changes nothing and writes nothing.
  if (m.bounce_kind === 'hard' || m.delivered_at) return 'repeat';
  const why = bounceWhy(reason, false);
  const first = !m.bounced_at;
  run("UPDATE emails SET bounced_at=?, bounce_kind='soft', bounce_reason=?, bounce_said=? WHERE id=?", at, why.plain, why.full.slice(0, 500), m.id);
  const e = m.envelope_id ? loadEnvelope(m.envelope_id) : null;
  // The same address on SOFT_BOUNCE_DAYS separate days, to emails of this same sender, is an address that does not work.
  const days = softBounceDays(ownerOf(m, e), m.to_email, at);
  if (days >= SOFT_BOUNCE_DAYS) return hardBounce({ ...m, bounced_at: at }, at, { plain: `${why.plain}, on ${days} separate days`, raw: why.raw, full: `${why.plain}, on ${days} separate days${why.raw ? ` (${why.raw})` : ''}` }, true);
  if (first && e && e.kind === 'envelope' && !same(senderOf(e)?.email, m.to_email))
    audit(e.id, SYSTEM, 'Email not delivered yet', `Email to ${names(recipientsOf(e, m), m)} has not arrived yet: ${why.plain}. The email was "${str(m.subject, 200)}". Nothing was stopped: it usually arrives later, and reminders go on.`);
  return 'applied';
}

// The provider did not send it, because of how our sending is set up there. That is ours to fix and says nothing
// about the person: nothing is stopped, marked or listed. The email reads "not delivered yet" with why, the record
// says it, and the people who run the server read it in the log, with the provider's words.
async function notSent(m: any, at: string, reason?: string): Promise<'applied' | 'repeat'> {
  if (m.bounce_kind || m.delivered_at) return 'repeat';
  const plain = 'our mail provider did not send it, because of a setting on our side, which the people who run this service have been told about';
  run("UPDATE emails SET bounced_at=?, bounce_kind='soft', bounce_reason=?, bounce_said=? WHERE id=?", at, plain, `not sent by the provider (${bounceWhy(reason, false).raw || 'no reason given'})`, m.id);
  console.error(`[mail events] The mail provider did not send email ${m.id}, because of a setting there: "${bounceWhy(reason, false).raw || 'no reason given'}". Nothing was marked on the person. Check the provider's account (its quotas, its unsubscribe list, the headers it accepts).`);
  const e = m.envelope_id ? loadEnvelope(m.envelope_id) : null;
  if (e && e.kind === 'envelope' && !same(senderOf(e)?.email, m.to_email))
    audit(e.id, SYSTEM, 'Email not delivered yet', `Email to ${names(recipientsOf(e, m), m)} was not sent: ${plain}. The email was "${str(m.subject, 200)}". Nothing was stopped. If it is urgent, copy their link and send it to them yourself.`);
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
  // The person's word is kept for the account, not on these rows alone: whatever the sender does next (a correction
  // away and back, "try again", a new envelope), nothing more is emailed to them until they ask for it themselves.
  const marked = noteComplaint(e.account_id, m.to_email, at);
  // A member of a signing group has no recipient row of their own: said as such (groups.ts). The mark just kept for
  // the account is what stops our emails to them, in the group and everywhere else.
  const member = rows.length ? null : complainedMember(e, m.to_email);
  const holder = rows.find((r: any) => r.group_name && r.claimed_by);
  audit(e.id, SYSTEM, 'Marked as spam', member ? member.audit : `${names(rows, m)} marked the email "${str(m.subject, 200)}" as spam in their mail program. Nothing more is emailed to them about this account's documents unless they ask for it themselves on a signing page.`);
  // Other envelopes of the account that are out to the same person stop emailing them too, and each record says why.
  for (const r of marked.filter((x: any) => x.envelope_id !== e.id && x.status === 'sent')) {
    audit(r.envelope_id, SYSTEM, 'Marked as spam', `${r.name} <${r.email}> marked another email from this account as spam in their mail program. Nothing more is emailed to them about this envelope unless they ask for it themselves on a signing page.`);
    fireWebhooks(e.account_id, 'envelope.updated', r.envelope_id, { recipient_id: r.id, change: 'email_marked_as_spam' });
  }
  // It counts against the sending account exactly as the "Report this email" link does: the same list, the same
  // count towards a pause, once for each person and envelope. Someone who is no longer on the envelope counts too.
  for (const r of fresh.length ? fresh : [{ id: '', name: member?.name || m.to_email, email: m.to_email }])
    await reportAbuse(e, r, { reason: 'spam', detail: 'Marked as spam in their mail program. Reported by the mail provider, not typed by the person.' }, { name: 'Mail provider' });
  if (!e.hidden_at)
    await notifySender(e, 'always', `Marked as spam: ${e.subject}`, `${member?.name || firstNames(rows, m)} marked our email as spam`, [
      ...(member ? member.lines : [`${names(rows, m)} marked the email "${m.subject}" as spam in their mail program. So we no longer email them about documents from your account: no reminders, no notice when you change one, and no copy when one is completed. That holds for this envelope, for any other that is out to them, and for new ones.`]),
      // The member who had taken a group's document on: also when it goes back to the group, they get nothing from us.
      ...(holder ? [`${holder.name} had taken this on for ${holder.group_name}. If it goes back to the group, ${holder.name} still gets no emails from us about it, and the other members are not affected.`] : []),
      ...(fresh.length ? [`Only ${firstNames(rows, m)} can undo that: their signing page has a button that starts our emails to them again. You can still give them their link yourself. Open the envelope and choose Copy link next to their name.`] : []),
      `It also counts as one report against your account, like the "Report this email" link in our emails does. When ${abuseSuspendAfter()} different recipients have reported an account within 30 days, its sending is paused until a person has looked.`,
    ]);
  fireWebhooks(e.account_id, 'envelope.updated', e.id, { ...(fresh[0] ? { recipient_id: fresh[0].id } : {}), change: 'email_marked_as_spam' });
  return 'applied';
}

// An email that arrives is the proof that its address works. Marks that are older than this email go: on the
// account's do-not-mail list, on every envelope of the account that is still out to that address (each record
// says why, so a mark never vanishes without a word), and on a login with that address. News about an email that
// was sent before the bounce proves nothing and clears nothing, with one exception: the marks that this very email
// set when it said "try later" on the last of SOFT_BOUNCE_DAYS separate days go, because it has arrived after all.
async function delivered(m: any, at: string): Promise<'applied' | 'repeat'> {
  if (m.delivered_at) return 'repeat';
  // Arriving wins over an earlier "try later": the email no longer reads "not delivered yet". A hard bounce stays.
  run("UPDATE emails SET delivered_at=?, bounce_kind=CASE WHEN bounce_kind='soft' THEN NULL ELSE bounce_kind END WHERE id=?", at, m.id);
  if (m.bounce_kind === 'hard') return 'applied';
  const e = m.envelope_id ? loadEnvelope(m.envelope_id) : null;
  forgetSoftDays(ownerOf(m, e), m.to_email);
  const deferred = m.bounce_kind === 'soft' && m.bounced_at;
  const upTo = deferred && m.bounced_at >= sentAt(m) ? new Date(Date.parse(m.bounced_at) + 1).toISOString() : sentAt(m);
  if (e) {
    forgetBounced(e.account_id, m.to_email, upTo);
    for (const r of all("SELECT r.id, r.name, r.envelope_id FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE e.account_id=? AND e.status='sent' AND lower(r.email)=lower(?) AND r.bounced_at < ?", e.account_id, m.to_email, upTo)) {
      run('UPDATE recipients SET bounced_at=NULL, bounce_reason=NULL WHERE id=?', r.id);
      audit(r.envelope_id, SYSTEM, 'Address works again', `A later email to ${r.name} <${m.to_email}> reached their mail server, so the address works. Reminders to it are on again.`);
      fireWebhooks(e.account_id, 'envelope.updated', r.envelope_id, { recipient_id: r.id, change: 'email_works_again' });
    }
    // The record said it had not arrived yet. It says that it did.
    if (deferred && e.kind === 'envelope' && !same(senderOf(e)?.email, m.to_email))
      audit(e.id, SYSTEM, 'Email delivered', `Email to ${names(recipientsOf(e, m), m)} reached their mail server after all. The email was "${str(m.subject, 200)}".`);
  }
  run('UPDATE users SET email_bounced_at=NULL, email_bounce_reason=NULL WHERE lower(email)=lower(?) AND email_bounced_at < ?', m.to_email, upTo);
  return 'applied';
}

// News about an email of an envelope its sender has deleted since. Nobody is left to mark or tell, but the account
// that sent it is known: a complaint counts against it and is kept for it, and a hard bounce goes on its list.
async function goneNews(gone: any, ev: MailEvent, at: string): Promise<'applied' | 'repeat'> {
  if (ev.type === 'complaint') {
    if (gone.complained_at) return 'repeat';
    run('UPDATE mail_gone SET complained_at=? WHERE mail_id=?', at, gone.mail_id);
    noteComplaint(gone.account_id, ev.email, at);
    await reportAbuse({ id: '', gone: true, account_id: gone.account_id }, { name: ev.email, email: ev.email }, { reason: 'spam', detail: 'Marked as spam in their mail program, about a document that its sender deleted since. Reported by the mail provider, not typed by the person.' }, { name: 'Mail provider' });
    return 'applied';
  }
  if (ev.type === 'bounce') {
    if (gone.bounce_kind === 'hard') return 'repeat';
    run("UPDATE mail_gone SET bounce_kind='hard' WHERE mail_id=?", gone.mail_id);
    noteBounced(gone.account_id, ev.email, bounceWhy(ev.reason, true).plain, at);
  }
  return 'applied';
}

/**
 * Applies one piece of news. 'unmatched': it names no email of ours, or cannot be told apart, so nothing is done
 * with it. `notes` counts why, for the log: an id that names no email, or an address two senders wrote to.
 */
export async function applyMailEvent(ev: MailEvent, notes: { unknown_id: number; ambiguous: number } = { unknown_id: 0, ambiguous: 0 }): Promise<'applied' | 'repeat' | 'unmatched'> {
  const f = findMail(ev);
  if (f === 'unknown_id' || f === 'ambiguous') return (notes[f]++, 'unmatched');
  if (!f) return 'unmatched';
  const at = when(ev.at);
  if ('gone' in f) return goneNews(f.gone, ev, at);
  const m = f.m;
  // A copy for an archive address, or the email asking one to confirm: it counts for that address alone (routes-archive.ts).
  if (m.archive_to) return archiveNews(m, ev, at);
  if (ev.type === 'delivered') return delivered(m, at);
  if (ev.type === 'complaint') return complaint(m, at);
  if (ev.type === 'soft_bounce') return softBounce(m, at, ev.reason);
  if (ev.type === 'not_sent') return notSent(m, at, ev.reason);
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
// itself is fetched: https, a host of the form sns.<region>.amazonaws.com (a region looks like eu-west-1, which no
// S3 bucket host does), no redirects, nothing read from the answer. And only the confirmation for the topic the
// message is about: never an unsubscribe link, nor anything else at that host.
async function confirmSubscription(raw: string, topic = ''): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !/^sns\.[a-z]{2,4}(-[a-z]+)+-\d{1,2}\.amazonaws\.com(\.cn)?$/.test(u.hostname)) return false;
  if (u.searchParams.get('Action') !== 'ConfirmSubscription' || !topic || u.searchParams.get('TopicArn') !== topic) return false;
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
  // Every piece of news in a batch is read, or none: a part cut off quietly would never be sent again.
  const tooMany = () => bad(`That batch holds more than ${MAX_EVENTS} events, which is more than this address reads at once, so none of it was read. Send it in smaller batches.`, 413);
  if (Array.isArray(body) && body.length > MAX_EVENTS) throw tooMany();
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
  if (read.confirm !== undefined) return { ok: true, subscription: (await confirmSubscription(read.confirm, read.topic)) ? 'confirmed' : 'not confirmed: the link in the message is not the confirmation of that topic at Amazon SNS' };
  // Said every time: from now on this address hears nothing from that topic, so bounces go unnoticed.
  if (read.unsubscribed) console.error('[mail events] Amazon SNS says this address was unsubscribed from a topic. No more bounce, complaint or delivery news comes from it until it is subscribed again.');
  if (read.events.length > MAX_EVENTS) throw tooMany();
  const done = { applied: 0, repeat: 0, unmatched: 0, failed: 0 };
  const notes = { unknown_id: 0, ambiguous: 0 };
  const work = (async () => {
    for (const ev of read.events) {
      try {
        done[await applyMailEvent(ev, notes)]++;
      } catch (e: any) {
        // One piece of news that cannot be applied must not make the provider send the whole batch again.
        done.failed++;
        console.error('[mail events] could not apply', ev.type, e?.message);
      }
    }
    if (notes.unknown_id) console.error(`[mail events] ${notes.unknown_id} piece(s) of news named an email of ours by its number or Message-ID, but no such email is here, or it went to another address. They were left alone.`);
    if (notes.ambiguous) console.error(`[mail events] ${notes.ambiguous} piece(s) of news named only an address, and more than one sender here wrote to it in the last ${BOUNCE_MATCH_DAYS} days, so nobody can tell whose email it was about. They were left alone. A provider that hands back our ids (see the README) avoids this.`);
  })();
  // The marks are made at once. Telling people (an email each) can take long with a slow mail server, and a provider
  // that waits too long sends the whole batch again. So after a while the answer goes, and the rest goes on here.
  let timer: any;
  g.__tsmailEventsWork = work; // the tail of the last batch, for a test to wait on
  const finished = await Promise.race([work.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), g.__tsmailEventsAnswerMs ?? 8000)))]);
  clearTimeout(timer);
  if (!finished) return json({ ok: true, understood: true, events: read.events.length, ...done, note: 'Taken. The rest of this batch is being applied, and needs nothing more from you.' }, 202);
  return { ok: true, understood: true, events: read.events.length, ...done };
}, 'public');

// ---- What the sender does about it ----------------------------------------------------------------

function mine(c: Ctx, envelopeId: string) {
  const e = loadEnvelope(envelopeId);
  if (!e || e.account_id !== c.account.id || e.kind !== 'envelope' || e.hidden_at || (!can(c, 'see_all') && e.sender_id !== c.user.id)) throw bad('Envelope not found.', 404);
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

// Only the person themselves can undo a complaint. Holding the signing link does not show that: the sender can copy
// it (Copy link), from any browser or a second login. Reading the mailbox does. So the first call emails a code to
// the address, and a second call with that code undoes the complaint. That email is the one thing we send to someone
// who marked ours as spam, and only when it is asked for on their signing page, at most MAIL_AGAIN_PER_DAY a day.
const MAIL_AGAIN_MINUTES = 30, MAIL_AGAIN_TRIES = 5, MAIL_AGAIN_PER_DAY = 3;
route('POST', '/sign/:token/mail-again', async (c) => {
  find(c, false);
  const code = str((await c.body())?.code, 40).replace(/\D/g, '');
  const { e, r, actor } = look(c, false);
  // A member of a signing group who reported the document is stopped the same way (groups.ts memberReported).
  if (!r.complained_at && !r.reported_at) return { ok: true, changed: false };
  // One code at a time per person. A group's members share one recipient row, so a member's code is kept for that
  // member (member_mail_again) and made for them alone: a code sent to one member's mailbox never starts another
  // member's emails, and one member asking never cancels another's code.
  const slot = `mail-again:${r.id}${r.member ? `:${r.member.id}` : ''}`;
  const [codes, key, kid] = r.member ? ['member_mail_again', 'member_id', r.member.id] : ['mail_again_codes', 'recipient_id', r.id];
  // Signed in to the account that sent it, unless the address is that person's own: the sender, so not even a code is sent.
  if (c.auth && get('SELECT 1 x FROM memberships WHERE account_id=? AND user_id=?', e.account_id, c.user.id) && !same(c.user.email, r.email))
    throw bad(`Only ${r.name} can ask for our emails about this document again, on their own device. You are signed in to the account that sent it, so nothing was changed. You can still send them their link yourself.`, 403);
  if (!code) {
    // Counted for the address and the account, not the link: a sender holding the links of many envelopes to this
    // person must not be able to have more codes sent to someone who asked for no more emails.
    try {
      rateLimit(`mail-again:${e.account_id}:${r.email.toLowerCase()}`, MAIL_AGAIN_PER_DAY, 86400_000);
    } catch {
      throw bad(`We have sent ${MAIL_AGAIN_PER_DAY} codes to ${r.email} today, which is as many as we send in a day. Type the newest one, or try again tomorrow. This link opens the document whenever you like meanwhile.`, 429);
    }
    const k = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const until = new Date(Date.now() + MAIL_AGAIN_MINUTES * 60_000).toISOString();
    run(`INSERT OR REPLACE INTO ${codes} (${key}, code_hash, tries, expires_at) VALUES (?,?,0,?)`, kid, hmac(`${slot}:${k}`), until);
    // Not as one of the envelope's emails to them (no recipient id): those stay stopped until the code is typed. The
    // code is never in the subject, which the sender sees in the envelope's list of emails, and our stored copy loses
    // it once the mail server has taken it (here, and on a later try by the listener in signercode.ts, which knows
    // "... is your code").
    const delivery = await sendMail({ to: r.email, envelopeId: e.id, expiresAt: until, subject: 'Your code to get our emails again', heading: 'Your code to get our emails again',
      lines: [`Someone asked, on the signing page of "${str(e.subject, 200)}", for our emails about it to start again. You had ${r.complained_at ? 'marked one of them as spam' : 'reported this document'}, so we had stopped. If that was you, type this code on that page.`,
        `${k} is your code. It works for ${MAIL_AGAIN_MINUTES} minutes. If you did not ask for it, ignore this email. Nothing changes, and we send you nothing more unless you ask on that page.`] });
    if (delivery === 'sent') run("UPDATE emails SET html=replace(html, ?, '(removed)'), payload=replace(payload, ?, '(removed)') WHERE id=(SELECT MAX(id) FROM emails WHERE envelope_id=? AND expires_at=?)", k, k, e.id, until);
    audit(e.id, actor, 'Code sent to start emails again', `${r.name} <${r.email}> asked on the signing page for our emails again. A code went to that address. Nothing changes until it is typed there.`);
    return { ok: true, code_sent: true, sent_to: r.email, minutes: MAIL_AGAIN_MINUTES, delivery };
  }
  const row = get(`SELECT * FROM ${codes} WHERE ${key}=?`, kid);
  if (!row || row.expires_at <= now()) throw bad('That code has run out, or none was asked for. Ask for a new one with the button.', 410);
  if (row.tries >= MAIL_AGAIN_TRIES) throw bad(`That code was typed wrongly ${MAIL_AGAIN_TRIES} times, so it no longer works. Ask for a new one with the button.`, 429);
  if (!safeEqual(hmac(`${slot}:${code}`), row.code_hash)) {
    run(`UPDATE ${codes} SET tries=tries+1 WHERE ${key}=?`, kid);
    throw bad('That code is not right. Type the 6 digits from our newest email to you. Nothing was changed.', 400, { code: 'wrong_code' });
  }
  run(`DELETE FROM ${codes} WHERE ${key}=?`, kid);
  // The complaint was kept for the account, so it goes for the account: every envelope of it that holds this address.
  const back = forgetComplaint(e.account_id, r.email);
  memberWantsMail(r);
  // The report the mail provider made for them is their own click, which they have now taken back: it no longer
  // counts towards pausing the sender. A report an operator has looked at already stays as they left it.
  run("UPDATE abuse_reports SET status='withdrawn' WHERE account_id=? AND lower(reporter)=lower(?) AND status='open' AND detail LIKE 'Marked as spam in their mail program%'", e.account_id, r.email);
  for (const x of back.length ? back : [{ id: r.id, envelope_id: e.id }]) {
    audit(x.envelope_id, actor, 'Emails started again', `${r.name} <${r.email}> had ${r.complained_at ? 'marked an email from this account as spam' : 'reported this document'}, and now asked to be emailed again, with a code sent to that address.`);
    fireWebhooks(e.account_id, 'envelope.updated', x.envelope_id, { recipient_id: x.id, change: 'email_wanted_again' });
  }
  return { ok: true, changed: true };
}, 'public');

// ---- A login whose own address does not work ------------------------------------------------------

// "It works now, try again": the mark goes and one email is sent to try it. If that one comes back too, the mark is
// back with it, so pressing this does not make a dead address look alive for long.
route('POST', '/me/email-works', async (c) => {
  rateLimit(`email-works:${c.user.id}`, 6, 86400_000);
  if (!run('UPDATE users SET email_bounced_at=NULL, email_bounce_reason=NULL WHERE id=? AND email_bounced_at IS NOT NULL', c.user.id).changes) return { ok: true, cleared: false };
  const delivery = await sendMail({ to: c.user.email, subject: 'Emails from GrowSigning reach you again', heading: 'This is the email you asked us to try',
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
  if (get('SELECT 1 x FROM users WHERE email=?', email)) throw bad(`There is already a GrowSigning login with ${email}, so this one cannot move there. Nothing was changed. If that login is yours too, sign in with it instead, or close it first under Settings, Records and data.`, 409);
  const t = token();
  const until = new Date(Date.now() + 3600_000).toISOString();
  run('DELETE FROM email_changes WHERE user_id=? OR expires_at < ?', c.user.id, now());
  run('INSERT INTO email_changes (token_hash, user_id, new_email, expires_at) VALUES (?,?,?,?)', sha256(t), c.user.id, email, until);
  const delivery = await sendMail({ to: email, about: c.user.id, subject: 'Confirm your new email address for GrowSigning', heading: 'Confirm this address', expiresAt: until,
    lines: ['Someone who is signed in to GrowSigning asked to use this address for their login from now on. If that was you, confirm it with the button below. The link works for one hour, in a browser in which you are signed in to GrowSigning.',
      'If it was not you, ignore this email. Nothing changes without the confirmation, and nobody gets into anything of yours.'],
    cta: { label: 'Confirm this address', url: `${baseUrl()}/change-email?token=${t}` } });
  return { ok: true, sent_to: email, delivery };
});

route('POST', '/me/email/confirm', async (c) => {
  const t = str((await c.body()).token, 200);
  const row = t ? get('SELECT * FROM email_changes WHERE token_hash=? AND expires_at > ?', sha256(t), now()) : null;
  if (!row) throw bad('This link does not work any more. It works once, for one hour, and a newer request replaces it. Ask for a new one from the notice at the top of the app, or under Settings, Profile.', 410);
  if (row.user_id !== c.user.id) throw bad('This link moves a different GrowSigning login to a new address. Sign in to that login in this browser and open the link again. Nothing was changed.', 403);
  const old = c.user.email;
  tx(() => {
    if (get('SELECT 1 x FROM users WHERE email=? AND id != ?', row.new_email, c.user.id)) throw bad(`In the meantime a GrowSigning login was made with ${row.new_email}, so this one cannot move there. Nothing was changed.`, 409);
    // The new address is proven, and whatever was known about the old one is not about this one.
    run('UPDATE users SET email=?, email_verified=1, email_bounced_at=NULL, email_bounce_reason=NULL WHERE id=?', row.new_email, c.user.id);
    // Our copies of what was sent to the old address about this login are now about a login with another address:
    // marked as such, they go when the login does (purgeUser deletes by about_user), not 90 days later.
    run('UPDATE emails SET about_user=? WHERE envelope_id IS NULL AND about_user IS NULL AND to_email=? COLLATE NOCASE', c.user.id, old);
    // The welcome signatures are given once per address (welcomeMark in routes-trust.ts). The confirmed address this
    // login leaves was welcomed, so a new login made under it now is not welcomed a second time.
    if (c.user.welcomed_at && c.user.email_verified) run('INSERT OR IGNORE INTO welcomed (email_hash, at) VALUES (?,?)', welcomeMark(old), String(c.user.welcomed_at).slice(0, 10));
    run('DELETE FROM email_changes WHERE user_id=?', c.user.id);
    // Links that were mailed to the old address open nothing any more, and other browsers are signed out.
    run('DELETE FROM password_resets WHERE user_id=?', c.user.id);
    run('DELETE FROM sessions WHERE user_id=? AND id != ?', c.user.id, c.auth?.sessionId || '');
    // No address in the record, old or new: the login is named by its id (seclog.ts).
    record('email.changed', { c, member: c.user.id, about: ['user', c.user.id] });
  });
  // The old address is told, also when it is the one that bounces: if it still reaches someone, they should know.
  await sendMail({ to: old, about: c.user.id, subject: 'The email address of your GrowSigning login was changed', heading: 'Your login uses another address now',
    lines: ['The GrowSigning login that used this address was moved to another one. From now on our emails go there, and that address signs in.',
      `If you did this, there is nothing more to do. If you did not, someone else has been in your login: write to us through ${baseUrl()}/help and a person will help you get it back.`] });
  return { ok: true, email: row.new_email };
});
