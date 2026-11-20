'use client';
import { useEffect, useRef, useState } from 'react';
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

function EmailFact({ d, role }: { d: Delivery | null; role: string }) {
  if (role === 'inperson') return <>No email goes to them. They sign on your device when you are together. {IN_PERSON_LOCK}</>;
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
  if (t.status === 'failed') return <>{what}: <b className="sn-bad">could not be sent</b>{t.error ? <>: {t.error}</> : null}. We have stopped trying. Check the number with <b>Correct</b>.</>;
  return <>{what}: waiting to go out since {dayTime(t.at)}.</>;
}

export function Recipients({ envelope: e, deliveries, texts = [], myEmail, onChanged, onCorrect, paused }: { envelope: any; deliveries: Delivery[]; texts?: TextDelivery[]; myEmail: string; onChanged: () => void; onCorrect: (r: any) => void; paused?: boolean }) {
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
      const link = await linkFor(r);
      // In person the device is about to be in someone else's hands. The account is put away before this page is
      // left, so the Back button does not bring it back (AppShell), and the server locks it when the page opens.
      if (r.role === 'inperson') window.dispatchEvent(new CustomEvent('sg-handed-over', { detail: { signer: r.name, envelope_id: e.id } }));
      // In person the page takes this one's place in the history, so the next person on the device does not reach it
      // with Back (and the server shows no private comments there to anyone but who holds the device: handlive.ts).
      if (r.role === 'inperson') window.location.replace(link);
      else window.location.href = link;
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
        return (
          <li key={r.id} className={`sn-person${stale || undelivered || stopped ? ' warn' : ''}`}>
            <div className="sn-person-head">
              {!!e.ordered && <span className="sn-step" aria-label={`Step ${r.routing_order}`}>{r.routing_order}</span>}
              <div className="grow">
                <div className="sn-person-name">
                  <b>{actingName(r) || r.role_name || `Recipient ${i + 1}`}</b>
                  {isMe && <span className="muted"> (you)</span>}
                  <span className="sn-person-email">{own ? 'No email address. You send the link.' : openGroup ? 'A group: every member has their own email' : r.email}</span>
                </div>
                <div className="muted small">
                  {ROLE_LABEL[r.role]}
                  {r.reassigned_from ? ` · handed over by ${r.reassigned_from}` : ''}
                  {r.access_code ? <> · Access code <b className="sn-code">{r.access_code}</b> (give it to them yourself, it is not in the email)</> : null}
                  {r.access_code && r.code_frozen_at ? <> · <b>This code is frozen</b> after too many wrong tries and opens nothing now. Choose Correct and set a new one to let them in.</> : null}
                  {/* The check the sender asked for before the document opens, and whether it has been passed. */}
                  {r.verify === 'sms_code' || r.verify === 'email_code' ? <> · Checked with a one-time code by {r.verify === 'sms_code' ? <>text message to <b className="sn-code">{r.phone}</b></> : 'email'}{r.check?.passed_at ? <>, passed on {dayTime(r.check.passed_at)}</> : ', not typed in yet'}</> : null}
                  {r.check?.stopped ? <> · <b>Someone using one of your signing links said this is not their number</b>, so no more texts are sent to it. Choose Correct and put in the right number, or confirm it with them if it is right after all, to let them in.</> : null}
                  {r.text_link && r.role !== 'inperson' ? <> · Link also sent by text message{r.verify === 'sms_code' ? '' : <> to <b className="sn-code">{r.phone}</b></>}</> : null}
                </div>
              </div>
              <div className="sn-person-badges">
                <Status s={b.s} label={b.label} />
                {!!r.muted && <span className="badge sn-muted">Turned off reminders</span>}
              </div>
            </div>

            <dl className="sn-facts">
              {r.status === 'pending' && e.status !== 'draft' && (
                <div><dt>Email</dt><dd>{own ? ownLinkFact(r, out, before.map((x: any) => x.name)) : r.role === 'witness' ? witnessWait(r, e) : out ? <>Not sent yet. {before.length ? `It goes out once ${before.map((x: any) => x.name).join(' and ')} ${before.length === 1 ? 'has' : 'have'} finished.` : 'It goes out when their turn comes.'}</> : 'Never sent. The envelope closed before their turn.'}</dd></div>
              )}
              {r.status !== 'pending' && <div><dt>Email</dt><dd>{own ? ownLinkFact(r, out, []) : <EmailFact d={mail} role={r.role} />}</dd></div>}
              {/* The latest text message to this person, when there was one: what really became of it. */}
              {texts.find((t) => t.recipient_id === r.id) && <div><dt>Text message</dt><dd><TextFact t={texts.find((t) => t.recipient_id === r.id)!} /></dd></div>}
              {r.status !== 'pending' && r.role !== 'cc' && (
                <div>
                  <dt>Opened</dt>
                  <dd>
                    {r.viewed_at ? <>On {dayTime(r.viewed_at)}.</> : r.status === 'completed' ? 'Yes.' : 'Not yet.'}
                    {r.status === 'viewed' && p && p.fields > 0 ? ` ${p.filled} of ${p.fields} ${p.fields === 1 ? 'field' : 'fields'} filled in so far.` : ''}
                  </dd>
                </div>
              )}
              {r.status === 'completed' && r.role !== 'cc' && <div><dt>{DONE[r.role]}</dt><dd>On {dayTime(r.completed_at)}.</dd></div>}
              {/* A witness: whose signature, their statement, "not there", and what a challenge would look at (WitnessFacts.tsx). */}
              {r.role === 'witness' && <WitnessFact r={r} e={e} />}
              {r.status === 'declined' && <div><dt>Declined</dt><dd>On {dayTime(r.completed_at)}.{r.decline_reason ? <> They wrote: &ldquo;{r.decline_reason}&rdquo;</> : null}</dd></div>}
            </dl>

            {!!r.group_name && <GroupMembers e={e} r={r} deliveries={deliveries} onChanged={onChanged} />}
            {stale && (
              <p className="sn-hint warn">
                <b>Not opened in {howLong(r.sent_at)}.</b> It may be in their spam folder. {r.muted ? 'Send them the link yourself:' : 'Nudge them, or send the link yourself:'}
              </p>
            )}
            {/* The case nobody sees from outside: all filled in, Finish not pressed. Said in the server's own count. */}
            {turn && p?.ready && (
              <p className="sn-hint warn">
                <b>Filled in everything but has not pressed Finish.</b> Their answers are saved, and nothing is signed until they press Finish.
                {' '}{r.role === 'inperson' ? 'Open it with Host signing now and let them finish.' : r.muted ? 'They turned reminder emails off, so send them the link yourself and say that one button is left.' : 'A nudge tells them that one button is left:'}
              </p>
            )}
            {!stale && undelivered && (
              <p className="sn-hint warn">
                {mail!.status === 'failed' && mail!.next_try_at ? <>The email has not gone out yet. We keep trying. If the address is wrong, fix it with <b>Correct</b>, or send them the link yourself in the meantime.</>
                  : mail!.status === 'failed' ? <>The email did not go out and we have stopped trying. Check the address with <b>Correct</b>, or send them the link yourself.</> : <>No email reached them. Send them the link yourself.</>}
              </p>
            )}
            {reachable && r.muted && !stale ? <p className="sn-hint">They asked for no more reminder emails. You can still send them the link yourself.</p> : null}
            {stopped && <MailStopHint r={r} />}
            {/* Their link, the only way it reaches them: while it is their turn and for their copy afterwards. */}
            {own && <OwnLinkActions r={r} envelopeStatus={e.status} busy={busy} link={shown === r.id ? links[r.id] || '' : ''}
              onShow={() => linkFor(r).then(() => setShown(r.id)).catch(fail)} onCopy={() => copy(r)} onQr={(el) => showQr(r, el)} onShare={(how) => shareVia(r, how)} />}

            {(turn || (out && r.status === 'pending')) && (
              <div className="sn-person-actions">
                {turn && (isMe || r.role === 'inperson') && <button className="btn sm primary" disabled={!!busy} onClick={() => signNow(r)}>{r.role === 'inperson' ? 'Host signing now' : `${r.role === 'approver' ? 'Review' : r.role === 'viewer' ? 'View' : 'Sign'} now`}</button>}
                {reachable && r.bounced_at && !r.complained_at && <TryAgainButton envelopeId={e.id} r={r} disabled={!!busy || paused} onDone={onChanged} />}
                {reachable && !r.muted && !stopped && <button className="btn sm" disabled={!!busy || paused} title={paused ? 'Sending is paused on this account, so no reminders go out. You can still copy the link and send it yourself.' : undefined} onClick={() => nudge(r)} aria-label={`Nudge ${r.name} with a reminder email`}>{busy === `nudge:${r.id}` ? 'Sending…' : 'Nudge'}</button>}
                {/* A group nobody has taken on has no link of its own: each member's is on its card (GroupMembers.tsx). */}
                {!openGroup && <>
                {reachable && <button className="btn sm" disabled={!!busy} onClick={() => copy(r)} aria-label={`Copy signing link for ${r.name}`}>Copy link</button>}
                {reachable && <button className="btn sm qr-tap" disabled={!!busy} onClick={(ev) => showQr(r, ev.currentTarget)} aria-haspopup="dialog" aria-label={`Show a QR code with the signing link for ${r.name}`}>Show QR code</button>}
                {reachable && <button className="btn sm" disabled={!!busy} onClick={() => shareVia(r, 'whatsapp')} aria-label={`Share link with ${r.name} on WhatsApp`}>Share on WhatsApp</button>}
                {reachable && <button className="btn sm" disabled={!!busy} onClick={() => shareVia(r, 'sms')} aria-label={`Share link with ${r.name} by text message`}>Share by text message</button>}
                </>}
                {/* A group has no single name or address to correct: only its access code (members: Edit envelope). */}
                {r.group_name ? <button className="btn sm sn-group-btn" disabled={!!busy} onClick={() => onCorrect({ ...r, code_only: true })} aria-label={`Change the access code of ${r.group_name}`}>Access code</button>
                  : <button className="btn sm" disabled={!!busy} onClick={() => onCorrect(r)} aria-label={`Correct name or email of ${r.name}`}>Correct</button>}
              </div>
            )}
            {/* An access code can still be changed when nothing else can: for someone who has finished, and once the
                envelope is finished or closed. It stands between them and their copy, and a frozen one locks them out. */}
            {!(turn || (out && r.status === 'pending')) && e.status !== 'draft' && !!r.access_code && (
              <div className="sn-person-actions">
                <button className="btn sm" disabled={!!busy} onClick={() => onCorrect({ ...r, code_only: true })} aria-label={`Change the access code of ${r.name}`}>Correct</button>
              </div>
            )}
            {shown === r.id && links[r.id] && turn && !own && (
              <label className="sn-link">
                <span>Personal link for {r.name}. Only share it with them.</span>
                <input readOnly value={links[r.id]} onFocus={(ev) => ev.currentTarget.select()} />
              </label>
            )}
            {qr === r.id && links[r.id] && (turn || own) && <QrDialog recipient={r} link={links[r.id]} opener={qrFrom} onClose={() => setQr('')} />}
          </li>
        );
      })}
    </ol>
  );
}
