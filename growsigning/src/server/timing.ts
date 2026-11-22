// Send later, and pause and resume an envelope that is out (research/docusign-gaps.json, batch "timing"). The wait
// before a person is in waits.ts. The routes are in routes-timing.ts; the timer calls timingTick (cron.ts).
//
// Send later: a draft keeps its status "draft" and gets a time (send_at). Nothing is held or checked for good while it
// waits: at that time the timer sends it through sendEnvelope, with every check a send by hand has (a confirmed
// address, signatures in the balance, the daily limit, a pause on the account, the do-not-mail list). If anything
// stops it, it is not sent, the sender is emailed why, and the draft keeps the reason (send_error) for its page.
//
// Pause: while paused_at is set nobody can fill in, sign, finish or decline (pausedGate, asked by look() in
// routes-sign.ts), nobody further down the order is asked (advance), no reminder goes out, and it does not expire
// (cronTick). Resume moves the deadline on by the time it was paused and emails whoever's turn it is.
import { all, get, run, tx } from './db.ts';
import { bad, now, baseUrl, HttpError } from './util.ts';
import type { Ctx } from './router.ts';
import { loadEnvelope, sendEnvelope, audit, notifySender, notifyRecipient, advance, assertSendable, senderOf, type Actor } from './envelopes.ts';
import { fireWebhooks } from './webhooks.ts';
import { senderZone } from './pdf.ts';
import { momentForEmail } from '../lib/dates.ts';
import { sendAtProblem, spanWords, pausedLinkText, atWords } from '../lib/timing.ts';

const SYSTEM = { name: 'System' };
const titleOf = (e: any) => e.subject || e.documents?.[0]?.name || 'Your document';

/** Set or change the time a draft goes out by itself. */
export function scheduleSend(e: any, sendAt: unknown, actor: Actor) {
  if (e.kind !== 'envelope' || e.status !== 'draft') throw bad('Only a document that has not been sent yet can be sent later. Open its page to see where it stands.', 409, { code: 'not_draft' });
  if (e.powerform_id) throw bad('A document started from a public form goes out when its visitor finishes. Send it now instead.', 409);
  const problem = sendAtProblem(sendAt);
  if (problem) throw bad(problem, 400, { code: 'send_at' });
  // What can be put right now is said now: no file, nobody on it, an unconfirmed address. Everything that can change
  // while it waits (the balance, the daily limit, a pause) is checked when it goes out.
  assertSendable(e);
  if (!senderOf(e)?.email_verified) throw bad('Confirm your email address before you choose a time to send. Type the 6-digit code we emailed you, then choose Send later again.', 403, { code: 'confirm_email' });
  const at = new Date(Date.parse(String(sendAt))).toISOString();
  run('UPDATE envelopes SET send_at=?, send_tried_at=NULL, send_error=NULL, updated_at=? WHERE id=?', at, now(), e.id);
  audit(e.id, actor, 'Send later set', `It goes out by itself at ${momentForEmail(at, senderZone(e))}. Nothing is sent before then, and no signatures are held while it waits.`);
  return at;
}

/** Take the time off a draft: it stays a draft. */
export function cancelSchedule(e: any, actor: Actor) {
  if (e.kind !== 'envelope' || e.status !== 'draft' || !e.send_at) throw bad('This document has no time set to go out. Nothing was changed.', 409);
  run('UPDATE envelopes SET send_at=NULL, send_tried_at=NULL, send_error=NULL, updated_at=? WHERE id=?', now(), e.id);
  audit(e.id, actor, 'Send later cancelled', 'It stays a draft. Nothing was sent.');
}

/** After a send by hand, the time it was set for is over. */
export const clearSchedule = (envelopeId: string) => run('UPDATE envelopes SET send_at=NULL, send_tried_at=NULL, send_error=NULL WHERE id=? AND send_at IS NOT NULL', envelopeId);

/** Drafts whose time has come. A try the server did not finish (it stopped) is taken up again after 10 minutes. */
export async function sendDue(): Promise<{ sent: number; not_sent: number }> {
  let sent = 0;
  let notSent = 0;
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const due = all("SELECT id, send_tried_at FROM envelopes WHERE kind='envelope' AND status='draft' AND send_at IS NOT NULL AND send_at <= ? AND send_error IS NULL AND (send_tried_at IS NULL OR send_tried_at < ?)", now(), stale);
  for (const row of due) {
    // One timer takes it up: a second one running at the same moment finds it taken.
    if (!run('UPDATE envelopes SET send_tried_at=? WHERE id=? AND status=\'draft\' AND send_error IS NULL AND send_tried_at IS ?', now(), row.id, row.send_tried_at).changes) continue;
    const e = loadEnvelope(row.id);
    const sender = senderOf(e);
    try {
      await sendEnvelope(e.id, { name: sender?.name || 'The sender' });
      run('UPDATE envelopes SET send_at=NULL, send_tried_at=NULL WHERE id=?', e.id);
      audit(e.id, SYSTEM, 'Sent at the time chosen', `The sender chose ${momentForEmail(e.send_at, senderZone(e))}.`);
      sent++;
    } catch (err: any) {
      const why = err instanceof HttpError ? String(err.message) : 'Something on our side stopped it. Press Send now to try again, and write to us if it happens again.';
      // Still a draft whatever happened, so it can be put right and sent.
      run('UPDATE envelopes SET send_error=? WHERE id=? AND status=\'draft\'', why.slice(0, 1000), e.id);
      const when = momentForEmail(e.send_at, senderZone(e));
      audit(e.id, SYSTEM, 'Not sent at the time chosen', `It was set to go out at ${when}. ${why}`);
      await notifySender(e, 'always', `Not sent: ${titleOf(e)}`, 'Your document did not go out at the time you chose',
        [`"${titleOf(e)}" was set to go out at ${when}. It did not go out, and nobody was sent anything.`, `Why: ${why}`, 'Open the document, put that right, and press Send now. Or choose a new time.'],
        { label: 'Open the document', url: `${baseUrl()}/app/envelopes/${e.id}` }).catch(() => {});
      notSent++;
    }
  }
  return { sent, not_sent: notSent };
}

/** Pause an envelope that is out. */
export function pauseEnvelope(e: any, actor: Actor, byName: string = actor.name) {
  if (e.kind !== 'envelope' || e.status !== 'sent') throw bad('Only a document that is out for signing can be paused. This one is not out right now, so there is nothing to pause.', 409, { code: 'not_out' });
  if (e.paused_at) throw bad('This document is paused already. Choose Resume when people can sign it again.', 409, { code: 'paused' });
  if (!run("UPDATE envelopes SET paused_at=?, paused_by=?, updated_at=? WHERE id=? AND paused_at IS NULL AND status='sent'", now(), byName.replace(/\s*<[^>]*>$/, ''), now(), e.id).changes)
    throw bad('This document changed a moment ago. Reload the page to see where it stands.', 409);
  audit(e.id, actor, 'Paused', 'Nobody can fill it in, sign, finish or decline it until it is resumed, and no reminders go out. The deadline moves on by the time it is paused. Questions and comments can still be read.');
  fireWebhooks(e.account_id, 'envelope.paused', e.id);
}

/** Resume it: the deadline moves on by the time it was paused, and whoever's turn it is gets an email. */
export async function resumeEnvelope(e: any, actor: Actor): Promise<{ paused_for_ms: number; expires_at: string | null }> {
  if (e.kind !== 'envelope' || !e.paused_at) throw bad('This document is not paused, so there is nothing to resume. Reload the page to see where it stands.', 409, { code: 'not_paused' });
  if (e.status !== 'sent') throw bad('This document is no longer out for signing, so it cannot be resumed. Open its page to see where it stands.', 409, { code: 'not_out' });
  const ms = Math.max(0, Date.now() - Date.parse(e.paused_at));
  const expires = e.expires_at ? new Date(Date.parse(e.expires_at) + ms).toISOString() : null;
  // The warning three days before the deadline is due again when the new deadline is further out than that.
  const rewarn = expires && Date.parse(expires) - Date.now() > 3 * 864e5;
  const done = tx(() => run(`UPDATE envelopes SET paused_at=NULL, paused_by=NULL, paused_ms=paused_ms+?, expires_at=?, last_reminder_at=?, updated_at=?${rewarn ? ', expiry_warned_at=NULL' : ''} WHERE id=? AND paused_at=?`,
    ms, expires, now(), now(), e.id, e.paused_at).changes);
  if (!done) throw bad('This document changed a moment ago. Reload the page to see where it stands.', 409);
  audit(e.id, actor, 'Resumed', `It was paused for ${spanWords(ms)}.${expires ? ` The deadline moved on by the same time, to ${momentForEmail(expires, senderZone(e))}.` : ''} Whoever's turn it is was emailed.`);
  fireWebhooks(e.account_id, 'envelope.resumed', e.id);
  const now_ = loadEnvelope(e.id);
  for (const r of now_.recipients.filter((r: any) => (r.status === 'sent' || r.status === 'viewed') && r.role !== 'cc'))
    await notifyRecipient(now_, r, 'resumed').catch((err: any) => console.error('[timing] resume email', err?.message));
  // Someone further down the order whose wait ended, or whose turn came, while it was paused is asked now.
  await advance(e.id);
  return { paused_for_ms: ms, expires_at: expires };
}

// Everything a signing link can change. Reading the document, its questions and comments, and asking for help stay open.
const BLOCKED = new Set(['consent', 'save', 'upload', 'complete', 'decline', 'reassign', 'name', 'witness', 'witness-statement', 'not-present', 'stamp', 'hand-back', 'take-over', 'decline/paper']);

/** What a paused envelope tells its signing page (GET /sign/:token), or null. */
export function pausedFacts(e: any): { by: string; at: string; text: string } | null {
  if (!e?.paused_at || e.status !== 'sent') return null;
  // The signer knows the sender, so the page names the sender, whoever on the team pressed Pause (that is on record).
  const by = senderOf(e)?.name || 'The sender';
  return { by, at: e.paused_at, text: pausedLinkText(by, atWords(e.paused_at).replace(/^.* on /, '')) };
}

/** Asked by look() in routes-sign.ts: an action the pause stops is refused, in the words the page shows. */
export function pausedGate(c: Ctx, e: any) {
  const p = pausedFacts(e);
  if (!p || c.req.method === 'GET') return;
  // The router also takes a trailing slash, and removing a stamp is DELETE /stamp/:field: both are the same action.
  const rest = new URL(c.req.url).pathname.replace(/^.*?\/sign\/[^/]+\/?/, '').replace(/\/+$/, '');
  if (BLOCKED.has(rest) || BLOCKED.has(rest.split('/')[0])) throw bad(p.text, 409, { code: 'paused', paused_by: p.by, paused_at: p.at });
}

/** The timer: drafts whose time has come, and people whose wait has ended. */
export async function timingTick(): Promise<{ sent: number; not_sent: number; waits_ended: number }> {
  const s = await sendDue();
  let ended = 0;
  // Envelopes out, not paused, with someone still to be asked who has a wait. advance asks them once it is over.
  for (const row of all("SELECT DISTINCT e.id FROM envelopes e JOIN recipients r ON r.envelope_id=e.id WHERE e.status='sent' AND e.kind='envelope' AND e.paused_at IS NULL AND e.ordered=1 AND r.status='pending' AND r.wait_hours > 0")) {
    const before = get("SELECT COUNT(*) n FROM recipients WHERE envelope_id=? AND status='pending'", row.id).n;
    await advance(row.id).catch((err: any) => console.error('[timing] advance', err?.message));
    if (get("SELECT COUNT(*) n FROM recipients WHERE envelope_id=? AND status='pending'", row.id).n < before) ended++;
  }
  return { ...s, waits_ended: ended };
}
