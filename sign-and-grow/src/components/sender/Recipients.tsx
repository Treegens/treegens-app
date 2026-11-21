'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { api, toast, Status, ROLE_LABEL } from '@/components/ui';
import { fail } from './feedback';
import { dayTime, howLong, neverOpened } from './lib';
import { QrDialog } from './QrDialog';
import { IN_PERSON_LOCK } from '@/lib/phone';
import { BackNews, MailStopHint, TryAgainButton, deliveredLine } from './MailNews';
import { ownLink, ownLinkFact, OwnLinkActions } from './OwnLink';
import { WitnessFact, witnessWait } from './WitnessFacts';
import { GroupMembers } from './GroupMembers';
import { actingName } from '@/lib/groups';
import { MorePanel } from './More';
import { dayText } from '@/lib/dates';
import { removedDay } from '@/lib/retention';
import { askedPaper } from '@/lib/disclosure';

export const DONE: Record<string, string> = { signer: 'Signed', inperson: 'Signed', approver: 'Approved', viewer: 'Viewed', cc: 'Copy sent', witness: 'Witnessed' };
const ASK: Record<string, string> = { signer: 'sign', inperson: 'sign', approver: 'approve', viewer: 'view', cc: 'view', witness: 'witness a signature on' };

// A failed email is tried again by the timer: tries so far, when the latest was, and when the next is due. A failed
// one with no next try is final: nobody tries again.
export type Delivery = { to_email: string; recipient_id?: string | null; subject: string; status: 'sent' | 'outbox' | 'failed' | 'queued' | string; error?: string | null; at: string; tries?: number; tried_at?: string | null; next_try_at?: string | null;
  // What the mail provider said afterwards, when this server is told (MailNews.tsx). Empty otherwise.
  delivered_at?: string | null; bounced_at?: string | null; bounce_kind?: string | null; bounce_reason?: string | null; complained_at?: string | null };

/** The most recent email we tried to send to this address about this envelope. The list comes newest first. */
// Prefer the email recorded for this exact person; two people can share one address.
export const lastEmailTo = (deliveries: Delivery[], email: string, recipientId?: string) =>
  (recipientId && deliveries.find((d) => d.recipient_id === recipientId)) || deliveries.find((d) => !d.recipient_id && d.to_email.toLowerCase() === (email || '').toLowerCase())
  || (!recipientId ? deliveries.find((d) => d.to_email.toLowerCase() === (email || '').toLowerCase()) : null) || null;

// The badge says what is true right now. "Sent" is only shown when an email really left for them.
function badge(r: any, envelopeStatus: string, mail: Delivery | null): { s: string; label?: string } {
  const open = envelopeStatus === 'sent';
  if (r.status === 'completed') return { s: 'completed', label: DONE[r.role] };
  // "Sign on paper instead" (src/server/disclosure.ts): a request, not a refusal, so it is not called Declined.
  if (askedPaper(r)) return { s: 'declined', label: 'Asked for paper' };
  if (r.status === 'declined') return { s: 'declined', label: 'Declined' };
  // A witness who said they were not there is not waiting for anything (WitnessFacts.tsx).
  if (r.witness_absent_at && r.status === 'pending') return { s: 'declined', label: 'Was not there' };
  if (r.status === 'pending') return { s: 'pending', label: envelopeStatus === 'draft' ? 'Not sent' : open ? 'Waiting for their turn' : 'Never reached' };
  if (!open) return { s: 'pending', label: r.status === 'viewed' ? 'Opened, did not finish' : 'Did not open' };
  // Everything required has a saved value and Finish was not pressed: nothing is signed, and only a nudge helps.
  if (r.status === 'viewed' && r.progress?.ready) return { s: 'expired', label: 'Filled in, not finished' };
  if (r.status === 'viewed') return { s: 'viewed', label: 'Opened' };
  if (r.role === 'inperson') return { s: 'sent', label: 'Ready to sign in person' };
  // Nothing was sent to someone whose link the sender passes on, so the badge says only what we know (OwnLink.tsx).
  if (ownLink(r)) return { s: neverOpened(r) ? 'expired' : 'sent', label: 'Not opened yet' };
  // What the mail provider told us (MailNews.tsx): the email came back for good, or was marked as spam.
  if (r.complained_at) return { s: 'declined', label: 'Marked as spam' };
  if (r.bounced_at) return { s: 'declined', label: 'Could not be delivered' };
  if (mail?.status === 'failed') return mail.next_try_at ? { s: 'expired', label: 'Email delayed' } : { s: 'declined', label: 'Email failed' };
  if (mail?.status === 'outbox') return { s: 'expired', label: 'Email not delivered' };
  if (neverOpened(r)) return { s: 'expired', label: 'Not opened' };
  // Their mail server took it. That is all it says: not that they read it.
  if (mail && deliveredLine(mail)) return { s: 'sent', label: 'Delivered' };
  return { s: 'sent', label: 'Sent' };
}

function EmailFact({ d, role, purged }: { d: Delivery | null; role: string; purged?: string | null }) {
  if (role === 'inperson') return <>No email goes to them. They sign on your device when you are together. {IN_PERSON_LOCK}</>;
  // Deleting names and answers took our copies of the emails away (src/server/records.ts), not the emails themselves.
  if (!d && purged) return <>Our copies of the emails about it were deleted on {dayText(purged)}.</>;
  if (!d) return <>No email has gone to this address yet.</>;
  const subject = <span className="muted"> &ldquo;{d.subject}&rdquo;</span>;
  const tries = d.tries && d.tries > 1 ? `, on try ${d.tries}` : '';
  if (d.status === 'sent') return <>{deliveredLine(d) || <>Handed to the mail server on {dayTime(d.tried_at || d.at)}{tries}</>}.<BackNews d={d} />{subject}</>;
  if (d.status === 'outbox') return <><b className="sn-bad">Not delivered:</b> this server has no mail server set up.{subject}</>;
  // Not sent yet, and still being tried: say when the next try is. Or final: say that nobody tries again.
  if (d.status === 'failed' && d.next_try_at) return <><b className="sn-bad">Not sent yet.</b> The mail server would not take it on {dayTime(d.tried_at || d.at)}{d.error ? <>: {d.error}</> : null}. We try again around {dayTime(d.next_try_at)}, and you do not have to do anything for that.{subject}</>;
  if (d.status === 'failed') return <><b className="sn-bad">Could not be sent</b>{d.tries && d.tries > 1 ? <> after {d.tries} tries, the last on {dayTime(d.tried_at || d.at)}</> : <> on {dayTime(d.tried_at || d.at)}</>}{d.error ? <>: {d.error}</> : null}. We have stopped trying.{subject}</>;
  return <>Waiting to go out since {dayTime(d.at)}. If it has not left within a quarter of an hour, we try again.{subject}</>;
}

// One card per person: what really happened to their email, when they opened it, when they finished,
// and ways to reach them that do not depend on email.
// `paused` is true while sending is paused on the account: a reminder would be refused, so the button says so.
// What became of a text message about this envelope: a one-time code, the signing link or a reminder. The number is
// only ever masked here, and the text itself is not shown.
export type TextDelivery = { recipient_id?: string | null; kind: 'code' | 'link' | 'reminder' | string; to: string; status: string; error?: string | null; at: string; tries?: number; tried_at?: string | null; next_try_at?: string | null };
const TEXT_KIND: Record<string, string> = { code: 'A one-time code', link: 'The signing link', reminder: 'A reminder' };

function TextFact({ t }: { t: TextDelivery }) {
  const what = `${TEXT_KIND[t.kind] || 'A text'} to ${t.to}`;
  if (t.status === 'sent') return <>{what}: handed to the text message provider on {dayTime(t.tried_at || t.at)}.</>;
  if (t.status === 'outbox') return <>{what}: <b className="sn-bad">not delivered.</b> This machine has no text message provider, so it was only written to the outbox.</>;
  if (t.status === 'failed' && t.next_try_at) return <>{what}: <b className="sn-bad">not sent yet.</b> The provider would not take it on {dayTime(t.tried_at || t.at)}{t.error ? <>: {t.error}</> : null}. We try again around {dayTime(t.next_try_at)}.</>;
  if (t.status === 'failed') return <>{what}: <b className="sn-bad">could not be sent</b>{t.error ? <>: {t.error}</> : null}. We have stopped trying. Check the number with <b>Change person</b>.</>;
  return <>{what}: waiting to go out since {dayTime(t.at)}.</>;
}

/**
 * Opens the signing page for this person in this browser: the sender's own turn, or someone signing in person.
 * The link is asked for at that moment, never taken from one fetched before. The page's main button uses it too.
 */
export async function openToSign(envelopeId: string, r: any, link?: string) {
  const url = link || ((await api(`/envelopes/${envelopeId}/recipient-view`, { body: { recipient_id: r.id } })).url as string);
  // In person the device is about to be in someone else's hands. The account is put away before this page is
  // left, so the Back button does not bring it back (AppShell), and the server locks it when the page opens.
  if (r.role === 'inperson') window.dispatchEvent(new CustomEvent('sg-handed-over', { detail: { signer: r.name, envelope_id: envelopeId } }));
  // In person the page takes this one's place in the history, so the next person on the device does not reach it
  // with Back (and the server shows no private comments there to anyone but who holds the device: handlive.ts).
  if (r.role === 'inperson') window.location.replace(url);
  else window.location.href = url;
}

/** The role of someone who has finished: said as what they were, not as something they still need to do. */
const ROLE_DONE: Record<string, string> = { signer: 'Signer', approver: 'Approver', viewer: 'Viewer', inperson: 'Signed in person', witness: 'Witness' };

// `mainPersonId`: whose "Sign now" is the page's main button already, so their card does not repeat it.
// `remindOne`: whether this person gets a Remind of their own in their More (src/lib/envelopepage.ts, personRemind).
export function Recipients({ envelope: e, deliveries, texts = [], myEmail, onChanged, onCorrect, paused, mainPersonId = '', remindOne, copyAsk, mainCopies = '' }: { envelope: any; deliveries: Delivery[]; texts?: TextDelivery[]; myEmail: string; onChanged: () => void; onCorrect: (r: any) => void; paused?: boolean; mainPersonId?: string; remindOne?: (r: any) => boolean;
  /** The page's main button asked to copy this person's link (n counts the presses). `mainCopies`: whose link that button copies, so their More does not offer the same. */
  copyAsk?: { id: string; n: number } | null; mainCopies?: string }) {
  const ids = useId();
  // Whose More is open. Closed for everyone each time the page opens.
  const [more, setMore] = useState('');
  const moreBtn = useRef<Record<string, HTMLButtonElement | null>>({});
  useEffect(() => {
    if (!more) return;
    const key = (ev: KeyboardEvent) => {
      // A dialog on top (the QR code, Change person) takes Escape for itself.
      if (ev.key !== 'Escape' || document.querySelector('[role="dialog"]')) return;
      moreBtn.current[more]?.focus();
      setMore('');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [more]);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [shown, setShown] = useState('');
  const [busy, setBusy] = useState('');
  const [qr, setQr] = useState(''); // whose QR code is on the screen, if anyone's
  const qrFrom = useRef<HTMLButtonElement | null>(null); // the button that opened it, where the keyboard goes back to
  const out = e.status === 'sent';

  // A correction, a reassignment or a change of role gives a person a new link, and the old one stops working. So the
  // link is asked for again each time it is handed over (Copy link, QR code, share, sign now), never taken from what
  // was fetched before, and a link shown under a name, or a code on the screen, goes when the people change.
  const who = e.recipients.map((r: any) => `${r.id}:${r.email}:${r.name}:${r.role}:${r.phone || ''}`).join('|');
  useEffect(() => {
    setLinks({});
    setShown('');
    setQr('');
  }, [who]);
  useEffect(() => setMore(''), [who]);
  const linkFor = async (r: any) => {
    const { url } = await api(`/envelopes/${e.id}/recipient-view`, { body: { recipient_id: r.id } });
    setLinks((l) => ({ ...l, [r.id]: url }));
    return url as string;
  };
  // The whole name as the sender wrote it. Which word of a name is the one to call someone by differs from country
  // to country (the family name comes first in much of Asia, many people have one name only), so it is not guessed.
  const shareText = (r: any, url: string) => `Hi ${(r.name || '').trim() || 'there'}, here is your personal link to ${r.status === 'completed' ? 'open your copy of' : ASK[r.role] || 'sign'} "${e.subject}": ${url}`;

  async function copy(r: any) {
    setBusy(`copy:${r.id}`);
    try {
      const url = await linkFor(r);
      setShown(r.id);
      try {
        await navigator.clipboard.writeText(url);
        toast(`Link for ${r.name} copied. Paste it into any message to them.`);
      } catch {
        // The link field is inside their More (or, for someone whose link you send yourself, on their card).
        if (!ownLink(r)) setMore(r.id);
        toast('Your browser did not let us copy. The link is shown under their name, so you can select and copy it.', true);
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  }

  // For someone standing next to the sender: their link as a code to scan. Asking for the link is recorded like a copy.
  async function showQr(r: any, from?: HTMLButtonElement) {
    qrFrom.current = from || null;
    setBusy(`qr:${r.id}`);
    try {
      await linkFor(r);
      setQr(r.id);
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  }

  async function shareVia(r: any, how: 'whatsapp' | 'sms') {
    // A new tab has to be opened during the click itself, or browsers block it. It is pointed at WhatsApp once the link is ready.
    const tab = how === 'whatsapp' && !links[r.id] ? window.open('', '_blank') : null;
    setBusy(`${how}:${r.id}`);
    try {
      const text = encodeURIComponent(shareText(r, await linkFor(r)));
      setShown(r.id);
      if (how === 'sms') window.location.href = `sms:?&body=${text}`;
      else if (tab) ((tab.opener = null), (tab.location.href = `https://wa.me/?text=${text}`));
      else window.open(`https://wa.me/?text=${text}`, '_blank', 'noopener');
    } catch (err) {
      tab?.close();
      fail(err);
    } finally {
      setBusy('');
    }
  }

  // The page's main button "Copy the link for <name>" (a server with no mail server): the same copy as in their More.
  const askedN = copyAsk?.n || 0;
  useEffect(() => {
    const r = askedN && copyAsk ? e.recipients.find((x: any) => x.id === copyAsk.id) : null;
    if (r) copy(r);
  }, [askedN]); // eslint-disable-line react-hooks/exhaustive-deps

  async function nudge(r: any) {
    setBusy(`nudge:${r.id}`);
    try {
      const { reminded } = await api(`/envelopes/${e.id}/remind`, { body: { recipient_id: r.id } });
      if (reminded) toast(`Reminder emailed to ${r.name}.`);
      else if (r.muted) toast(`No reminder went out. ${r.name} turned reminders off, so share the link another way.`, true);
      // Not counted as sent: the mail server would not take it. It is tried again by itself, and the card says so.
      else toast(`The reminder to ${r.name} could not be sent just now. We keep trying, and their card below shows how it goes. You can also send them the link yourself.`, true);
      onChanged();
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  }

  async function signNow(r: any) {
    setBusy(`sign:${r.id}`);
    try {
      await openToSign(e.id, r, await linkFor(r));
    } catch (err) {
      fail(err);
      setBusy('');
    }
  }

  return (
    <ol className="sn-people" role="list">
      {e.recipients.map((r: any, i: number) => {
        const turn = out && (r.status === 'sent' || r.status === 'viewed');
        const isMe = r.role !== 'inperson' && r.email.toLowerCase() === myEmail.toLowerCase();
        const mail = r.status === 'pending' ? null : lastEmailTo(deliveries, r.email, r.id);
        // Emails to them stopped: the last one came back for good, or they marked one as spam (MailNews.tsx). Then
        // "it may be in their spam folder" is the wrong advice, and a nudge would be refused.
        const stopped = turn && r.role !== 'inperson' && !!(r.bounced_at || r.complained_at);
        // Someone whose link the sender passes on has no address: no email, no nudge, and their own card (OwnLink.tsx).
        const own = ownLink(r);
        const stale = turn && neverOpened(r) && !stopped && !own;
        // Once they have opened it they clearly have the link, however the email fared.
        const undelivered = turn && r.status === 'sent' && r.role !== 'inperson' && !!mail && (mail.status === 'outbox' || mail.status === 'failed');
        const b = badge(r, e.status, mail);
        // A signing group nobody has taken on has no link of its own: each member's is on its card (GroupMembers.tsx).
        const openGroup = !!r.group_name && !r.claimed_by;
        const reachable = turn && !isMe && r.role !== 'inperson' && !own;
        const before = e.ordered ? e.recipients.filter((x: any) => x.routing_order < r.routing_order && x.status !== 'completed' && x.role !== 'cc') : [];
        const p = r.progress;
        const name = actingName(r) || r.role_name || `Person ${i + 1}`;
        const panelId = `${ids}-more-${i}`;
        const isOpen = more === r.id;
        // What became of the email to them, or why there was none. Said once on the card, and again in their More.
        const emailFact = r.status === 'pending'
          ? (own ? ownLinkFact(r, out, before.map((x: any) => x.name)) : r.role === 'witness' ? witnessWait(r, e) : out ? <>Not sent yet. {before.length ? `It goes out once ${before.map((x: any) => x.name).join(' and ')} ${before.length === 1 ? 'has' : 'have'} finished.` : 'It goes out when their turn comes.'}</> : 'Never sent. The document closed before their turn.')
          : own ? ownLinkFact(r, out, []) : <EmailFact d={mail} role={r.role} purged={e.purged_level === 'personal' ? e.purged_at : null} />;
        const openedFact = <>{r.viewed_at ? <>Opened on {dayTime(r.viewed_at)}.</> : r.status === 'completed' ? 'Opened.' : 'Not opened yet.'}{r.status === 'viewed' && p && p.fields > 0 ? ` ${p.filled} of ${p.fields} ${p.fields === 1 ? 'field' : 'fields'} filled in so far.` : ''}</>;
        // One status line: the latest thing that is true about this person. The rest is in their More.
        const line = e.status === 'draft' ? null
          : r.status === 'completed' && r.role !== 'cc' ? <>{DONE[r.role]} on {dayTime(r.completed_at)}.</>
          : askedPaper(r) ? <>Asked for this document on paper on {dayTime(r.paper_at)}.</>
          : r.status === 'declined' ? <>Declined on {dayTime(r.completed_at)}.{r.decline_reason ? <> They wrote: &ldquo;{r.decline_reason}&rdquo;</> : null}</>
          : r.status === 'viewed' ? openedFact
          // No mail server: the notice above the list says it once, and their badge says it for them.
          : turn && mail?.status === 'outbox' && !own ? null
          // Someone whose link you send yourself, while their card says so with the buttons: not said twice.
          : own && (turn || (r.status === 'completed' && (e.status === 'sent' || e.status === 'completed'))) ? null
          : own && typeof emailFact === 'string' ? emailFact.replace(/^None\. /, '')
          : emailFact;
        // A More is worth its button only when it holds something to do, or facts the card has no room for.
        const acts = turn || (out && r.status === 'pending') || (e.status !== 'draft' && !!r.access_code);
        const hasMore = e.status !== 'draft' && (acts || r.role === 'witness' || texts.some((t) => t.recipient_id === r.id) || !!r.whatsapp_status);
        const settled = (r.status === 'completed' && r.role !== 'cc') || r.status === 'declined';
        const signHere = turn && (isMe || r.role === 'inperson') && r.id !== mainPersonId;
        return (
          <li key={r.id} className={`sn-person${stale || undelivered || stopped ? ' warn' : ''}`} data-item="person">
            <div className="sn-person-head">
              {!!e.ordered && <span className="sn-step" aria-label={`Step ${r.routing_order}`}>{r.routing_order}</span>}
              <div className="grow">
                <div className="sn-person-name">
                  {/* Names removed with the files (records.ts): said once, with the day written out. */}
                  <b>{removedDay(r.name) ? `Name and address removed on ${dayText(removedDay(r.name)!)}` : name}</b>
                  {isMe && <span className="muted"> (you)</span>}
                  <span className="sn-person-email">{own ? 'No email address. You send the link.' : openGroup ? 'A group: every member has their own email' : removedDay(r.email) ? '' : r.email}</span>
                </div>
                <div className="muted small">
                  {r.status === 'completed' ? ROLE_DONE[r.role] || ROLE_LABEL[r.role] : ROLE_LABEL[r.role]}
                  {r.reassigned_from ? ` · handed over by ${r.reassigned_from}` : ''}
                  {r.access_code ? <> · Access code <b className="sn-code">{r.access_code}</b> (give it to them yourself, it is not in the email)</> : null}
                  {r.access_code && r.code_frozen_at ? <> · <b>This code is frozen</b> after too many wrong tries and opens nothing now. Choose Change person, in their More, and set a new one to let them in.</> : null}
                  {/* The check the sender asked for before the document opens, and whether it has been passed. */}
                  {r.verify === 'sms_code' || r.verify === 'email_code' ? <> · Checked with a one-time code by {r.verify === 'sms_code' ? <>text message to <b className="sn-code">{r.phone}</b></> : 'email'}{r.check?.passed_at ? <>, passed on {dayTime(r.check.passed_at)}</> : ', not typed in yet'}</> : null}
                  {r.check?.stopped ? <> · <b>Someone using one of your signing links said this is not their number</b>, so no more texts are sent to it. Choose Change person, in their More, and put in the right number, or confirm it with them if it is right after all, to let them in.</> : null}
                  {r.text_link && r.role !== 'inperson' ? <> · Link also sent by text message{r.verify === 'sms_code' ? '' : <> to <b className="sn-code">{r.phone}</b></>}</> : null}
                  {r.whatsapp ? <> · Link also goes by WhatsApp to <b className="sn-code">{r.phone}</b></> : null}
                </div>
              </div>
              <div className="sn-person-badges">
                <Status s={b.s} label={b.label} />
                {!!r.muted && <span className="badge sn-muted">Turned off reminders</span>}
              </div>
              {hasMore && <MorePanel label={`More for ${name}`} panelId={panelId} open={isOpen} onToggle={() => setMore(isOpen ? '' : r.id)} buttonRef={(el) => { moreBtn.current[r.id] = el; }} />}
            </div>
            {line && <p className="sn-person-line">{line}</p>}
            {/* Nothing left to do for them: the two facts their More would hold, in one small line. */}
            {!hasMore && settled && <p className="muted small sn-person-line">{emailFact} {openedFact}</p>}

            {!!r.group_name && <GroupMembers e={e} r={r} deliveries={deliveries} onChanged={onChanged} />}
            {stale && (
              <p className="sn-hint warn">
                <b>Not opened in {howLong(r.sent_at)}.</b> It may be in their spam folder. {r.muted ? 'Send them the link yourself, from their More.' : 'Remind them, or send the link yourself, from their More.'}
              </p>
            )}
            {/* The case nobody sees from outside: all filled in, Finish not pressed. Said in the server's own count. */}
            {turn && p?.ready && (
              <p className="sn-hint warn">
                <b>Filled in everything but has not pressed Finish.</b> Their answers are saved, and nothing is signed until they press Finish.
                {' '}{r.role === 'inperson' ? 'Open it with Host signing now and let them finish.' : r.muted ? 'They turned reminder emails off, so send them the link yourself and say that one button is left.' : 'A reminder tells them that one button is left.'}
              </p>
            )}
            {!stale && undelivered && mail!.status === 'failed' && (
              <p className="sn-hint warn">
                {mail!.status === 'failed' && mail!.next_try_at ? <>The email has not gone out yet. We keep trying. If the address is wrong, fix it with <b>Change person</b>, or send them the link yourself in the meantime. Both are in their More.</>
                  : mail!.status === 'failed' ? <>The email did not go out and we have stopped trying. Check the address with <b>Change person</b>, or send them the link yourself. Both are in their More.</> : null}
              </p>
            )}
            {reachable && r.muted && !stale ? <p className="sn-hint">They asked for no more reminder emails. You can still send them the link yourself, from their More.</p> : null}
            {stopped && <MailStopHint r={r} />}
            {/* Their link, the only way it reaches them: while it is their turn and for their copy afterwards. */}
            {own && <OwnLinkActions r={r} envelopeStatus={e.status} busy={busy} link={shown === r.id ? links[r.id] || '' : ''}
              onShow={() => linkFor(r).then(() => setShown(r.id)).catch(fail)} onCopy={() => copy(r)} onQr={(el) => showQr(r, el)} onShare={(how) => shareVia(r, how)} />}
            {/* A second person who signs here, or the sender's own turn when the page's main button is someone else's. */}
            {signHere && <div className="sn-person-actions"><button className="btn sm" disabled={!!busy} onClick={() => signNow(r)}>{r.role === 'inperson' ? 'Host signing now' : `${r.role === 'approver' ? 'Review' : r.role === 'viewer' ? 'View' : 'Sign'} now`}</button></div>}

            {isOpen && (
            <div className="sn-person-more" id={panelId} role="group" aria-label={`More for ${name}`}>
            <dl className="sn-facts">
              <div><dt>Email</dt><dd>{emailFact}</dd></div>
              {/* The latest text message to this person, when there was one: what really became of it. */}
              {texts.find((t) => t.recipient_id === r.id) && <div><dt>Text message</dt><dd><TextFact t={texts.find((t) => t.recipient_id === r.id)!} /></dd></div>}
              {/* The latest WhatsApp message (src/server/whatsapp.ts): Sent, Delivered to the phone, or why not. Never "read". */}
              {r.whatsapp_status && <div><dt>WhatsApp</dt><dd>{r.whatsapp_status.to}: <b className={r.whatsapp_status.status === 'failed' || r.whatsapp_status.stopped ? 'sn-bad' : undefined}>{r.whatsapp_status.said}</b>{r.whatsapp_status.error ? <> ({r.whatsapp_status.error})</> : null}{r.whatsapp_status.stopped ? <>. They replied STOP, so nothing more goes to them by WhatsApp from your account. Email is not affected.</> : '.'}</dd></div>}
              {r.status !== 'pending' && r.role !== 'cc' && <div><dt>Opened</dt><dd>{openedFact}</dd></div>}
              {r.status === 'completed' && r.role !== 'cc' && <div><dt>{DONE[r.role]}</dt><dd>On {dayTime(r.completed_at)}.</dd></div>}
              {/* A witness: whose signature, their statement, "not there", and what a challenge would look at (WitnessFacts.tsx). */}
              {r.role === 'witness' && <WitnessFact r={r} e={e} />}
              {askedPaper(r) && <div><dt>Asked for paper</dt><dd>On {dayTime(r.paper_at)}. Send it to them on paper yourself: GrowSigning does not print or post anything.</dd></div>}
              {r.status === 'declined' && !askedPaper(r) && <div><dt>Declined</dt><dd>On {dayTime(r.completed_at)}.{r.decline_reason ? <> They wrote: &ldquo;{r.decline_reason}&rdquo;</> : null}</dd></div>}
            </dl>

            {(turn || (out && r.status === 'pending')) && (
              <div className="sn-person-actions">
                {reachable && r.bounced_at && !r.complained_at && <TryAgainButton envelopeId={e.id} r={r} disabled={!!busy || paused} onDone={onChanged} />}
                {/* The page's main button reminds everyone who waits. One for this person only when it is worth a second control. */}
                {reachable && !r.muted && !stopped && (!remindOne || remindOne(r)) && <button className="btn sm" disabled={!!busy || paused} title={paused ? 'Sending is paused on this account, so no reminders go out. You can still copy the link and send it yourself.' : undefined} onClick={() => nudge(r)}>{busy === `nudge:${r.id}` ? 'Sending…' : `Remind ${r.name}`}</button>}
                {/* A group has no single name or address to correct: only its access code (members: Edit, in the page's More). */}
                {r.group_name ? <button className="btn sm sn-group-btn" disabled={!!busy} onClick={() => onCorrect({ ...r, code_only: true })} aria-label={`Change the access code of ${r.group_name}`}>Access code</button>
                  : <button className="btn sm" disabled={!!busy} onClick={() => onCorrect(r)} aria-label={`Change the name or address of ${r.name}`}>Change person</button>}
              </div>
            )}
            {/* Their link, for the sender to pass on. "WhatsApp" and "Text" here open the sender's own app: we send nothing. */}
            {reachable && !openGroup && <p className="sn-share-h" id={`${panelId}-share`}>Share the link yourself</p>}
            {(turn || (out && r.status === 'pending')) && (
              <div className="sn-person-actions" role="group" aria-labelledby={reachable && !openGroup ? `${panelId}-share` : undefined}>
                {/* A group nobody has taken on has no link of its own: each member's is on its card (GroupMembers.tsx). */}
                {!openGroup && <>
                {reachable && <button className="btn sm" disabled={!!busy} style={mainCopies === r.id ? { display: 'none' } : undefined} onClick={() => copy(r)} aria-label={`Copy signing link for ${r.name}`}>Copy link</button>}
                {reachable && <button className="btn sm qr-tap" disabled={!!busy} onClick={(ev) => showQr(r, ev.currentTarget)} aria-haspopup="dialog" aria-label={`Show a QR code with the signing link for ${r.name}`}>QR code</button>}
                {reachable && <button className="btn sm" disabled={!!busy} onClick={() => shareVia(r, 'whatsapp')} aria-label={`Share link with ${r.name} on WhatsApp`}>WhatsApp</button>}
                {reachable && <button className="btn sm" disabled={!!busy} onClick={() => shareVia(r, 'sms')} aria-label={`Share link with ${r.name} by text message`}>Text</button>}
                </>}
              </div>
            )}
            {/* An access code can still be changed when nothing else can: for someone who has finished, and once the
                envelope is finished or closed. It stands between them and their copy, and a frozen one locks them out. */}
            {!(turn || (out && r.status === 'pending')) && e.status !== 'draft' && !!r.access_code && (
              <div className="sn-person-actions">
                <button className="btn sm" disabled={!!busy} onClick={() => onCorrect({ ...r, code_only: true })} aria-label={`Change the access code of ${r.name}`}>Change the access code</button>
              </div>
            )}
            {shown === r.id && links[r.id] && turn && !own && (
              <label className="sn-link">
                <span>Personal link for {r.name}. Only share it with them.</span>
                <input readOnly value={links[r.id]} onFocus={(ev) => ev.currentTarget.select()} />
              </label>
            )}
            </div>
            )}
            {qr === r.id && links[r.id] && (turn || own) && <QrDialog recipient={r} link={links[r.id]} opener={qrFrom} onClose={() => setQr('')} />}
          </li>
        );
      })}
    </ol>
  );
}
