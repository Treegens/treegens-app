'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, toast } from '@/components/ui';
import { fail } from './feedback';
import { dayTime, joinNames } from './lib';
import { domainOf } from '@/lib/mailnews';

// What the mail provider said about an email after it took it, on a server that is told (MAIL_EVENTS_TOKEN, see
// src/server/routes-bounces.ts), and what the sender can do about it. On a server that is not told, every field here
// is empty and none of this shows: the pages say what they said before. "Delivered" means the recipient's mail
// server took it. Nothing here ever says that someone read an email.

type News = { to_email: string; delivered_at?: string | null; bounced_at?: string | null; bounce_kind?: string | null; bounce_reason?: string | null; complained_at?: string | null };

/** "Delivered to the mail server of example.com on ...", or null when there is no such news, or worse news. */
export const deliveredLine = (d: News) => (d.delivered_at && !d.bounce_kind && !d.complained_at ? <>Delivered to the mail server of {domainOf(d.to_email)} on {dayTime(d.delivered_at)}</> : null);

/** What came back about one email, after the line that says it was handed over. Nothing when nothing came back. */
export function BackNews({ d }: { d: News }) {
  if (d.complained_at) return <> <b className="sn-bad">Marked as spam</b> by the reader on {dayTime(d.complained_at)}.</>;
  if (d.bounce_kind === 'hard') return <> <b className="sn-bad">Could not be delivered</b> on {dayTime(d.bounced_at)}: {d.bounce_reason}.</>;
  if (d.bounce_kind === 'soft') return <> <b>Not delivered yet</b> on {dayTime(d.bounced_at)}: {d.bounce_reason}. That usually sorts itself out, and nothing was stopped.</>;
  return null;
}

/** Why we do not email this person right now, on their card. Null when we do. */
export function MailStopHint({ r }: { r: any }) {
  if (r.complained_at) return (
    <p className="sn-hint warn">
      <b>Marked as spam.</b> {r.name} marked one of our emails for your account as spam, so we do not email them about its documents again, this one included: no reminders, no notice when you change it and no copy when it is completed. Correcting the address or sending a new envelope does not change that. Only they can undo it, with the button on their signing page. You can still send them their link yourself. <Link href="/help#bounced">What this means</Link>
    </p>
  );
  if (r.bounced_at) return (
    <p className="sn-hint warn">
      <b>Could not be delivered:</b> {r.bounce_reason || 'their mail server will not take email for this address'}. No reminders go to {r.email} until you do something. Choose <b>Correct</b> to put in the right address, and a new email goes out at once. If the address is right and the mailbox works again, choose <b>Try again</b>. You can also send them the link yourself. <Link href="/help#bounced">What this means</Link>
    </p>
  );
  return null;
}

/** "Try again": the sender says the address works now. The mark goes and the request is emailed again at once. */
export function TryAgainButton({ envelopeId, r, disabled, onDone }: { envelopeId: string; r: any; disabled?: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const { delivery } = await api(`/envelopes/${envelopeId}/try-again`, { body: { recipient_id: r.id } });
      toast(delivery === 'sent' ? `Emailed ${r.name} again. If it comes back again, we tell you.`
        : delivery === 'outbox' ? `Reminders to ${r.name} are on again, but this server has no mail server, so no email went out. Send them the link yourself.`
        : delivery === 'failed' ? `Reminders to ${r.name} are on again. The mail server would not take the email just now, and we keep trying.`
        : delivery === 'waiting' ? `Reminders to ${r.name} are on again. They are emailed when it is their turn.`
        : `Reminders to ${r.name} are on again, but the email is held back for now. We emailed you why.`, delivery === 'failed' || delivery === 'held');
      onDone();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return <button className="btn sm" style={{ minHeight: 44 }} disabled={disabled || busy} onClick={go} aria-label={`Email ${r.name} again at ${r.email}: the address works now`}>{busy ? 'Sending…' : 'Try again'}</button>;
}

/** On the envelope page, above everything: who is not emailed any more and why. */
export function MailStopLines({ people }: { people: any[] }) {
  const spam = people.filter((r) => r.complained_at);
  const dead = people.filter((r) => r.bounced_at && !r.complained_at);
  return (
    <>
      {dead.length > 0 && <p className="sn-now-sub warn">Our email to {joinNames(dead.map((r) => r.name))} could not be delivered, so no reminders go to {dead.length === 1 ? 'that address' : 'those addresses'}. See below to correct {dead.length === 1 ? 'it' : 'them'} or try again.</p>}
      {spam.length > 0 && <p className="sn-now-sub warn">{joinNames(spam.map((r) => r.name))} marked one of our emails for your account as spam, so we do not email {spam.length === 1 ? 'them' : 'any of them'} about this again. You can still send the link yourself.</p>}
    </>
  );
}

/** The toast after "Send reminder" for everyone: who got one, and who did not and why, so nobody is dropped unsaid. */
export function remindedText(reminded: number, notReminded: { name: string; why: string }[] = [], seeWhere = 'See their cards below.'): { text: string; bad: boolean } {
  // 'reported': a member of a signing group who reported the document is emailed nothing more about it.
  const why = (k: string, n: number) => (k === 'marked_as_spam' ? 'they marked our email as spam' : k === 'reported' ? 'they reported this document' : n === 1 ? 'our last email to them could not be delivered' : 'our emails to them could not be delivered');
  const kinds = [...new Set(notReminded.map((x) => x.why))];
  const of = (k: string) => notReminded.filter((x) => x.why === k).map((x) => x.name);
  const left = !notReminded.length ? '' : kinds.length === 1 ? ` No reminder to ${joinNames(of(kinds[0]))}: ${why(kinds[0], notReminded.length)}.`
    : ` No reminder to ${kinds.map((k) => `${joinNames(of(k))} (${why(k, of(k).length)})`).join(', ')}.`;
  if (reminded) return { text: `Reminder emailed to ${reminded} ${reminded === 1 ? 'person' : 'people'}.${left}`, bad: false };
  return { text: left ? `No reminder went out.${left} ${seeWhere}` :'No reminder went out. Everyone waiting has turned reminders off, so share their links another way.', bad: true };
}
