'use client';
import { useState } from 'react';
import { api, toast, Status, ROLE_LABEL } from '@/components/ui';
import { fail } from './feedback';
import { dayTime, howLong, neverOpened } from './lib';

export const DONE: Record<string, string> = { signer: 'Signed', inperson: 'Signed', approver: 'Approved', viewer: 'Viewed', cc: 'Copy sent' };
const ASK: Record<string, string> = { signer: 'sign', inperson: 'sign', approver: 'approve', viewer: 'view', cc: 'view' };

export type Delivery = { to_email: string; subject: string; status: 'sent' | 'outbox' | 'failed' | 'queued' | string; error?: string | null; at: string };

/** The most recent email we tried to send to this address about this envelope. The list comes newest first. */
export const lastEmailTo = (deliveries: Delivery[], email: string) => deliveries.find((d) => d.to_email.toLowerCase() === (email || '').toLowerCase()) || null;

// The badge says what is true right now. "Sent" is only shown when an email really left for them.
function badge(r: any, envelopeStatus: string, mail: Delivery | null): { s: string; label?: string } {
  const open = envelopeStatus === 'sent';
  if (r.status === 'completed') return { s: 'completed', label: DONE[r.role] };
  if (r.status === 'declined') return { s: 'declined', label: 'Declined' };
  if (r.status === 'pending') return { s: 'pending', label: envelopeStatus === 'draft' ? 'Not sent' : open ? 'Waiting for their turn' : 'Never reached' };
  if (!open) return { s: 'pending', label: r.status === 'viewed' ? 'Opened, did not finish' : 'Did not open' };
  if (r.status === 'viewed') return { s: 'viewed', label: 'Opened' };
  if (r.role === 'inperson') return { s: 'sent', label: 'Ready to sign in person' };
  if (mail?.status === 'failed') return { s: 'declined', label: 'Email failed' };
  if (mail?.status === 'outbox') return { s: 'expired', label: 'Email not delivered' };
  if (neverOpened(r)) return { s: 'expired', label: 'Not opened' };
  return { s: 'sent', label: 'Sent' };
}

function EmailFact({ d, role }: { d: Delivery | null; role: string }) {
  if (role === 'inperson') return <>No email goes to them. They sign on your device when you are together.</>;
  if (!d) return <>No email has gone to this address yet.</>;
  const subject = <span className="muted"> &ldquo;{d.subject}&rdquo;</span>;
  if (d.status === 'sent') return <>Handed to the mail server on {dayTime(d.at)}.{subject}</>;
  if (d.status === 'outbox') return <><b className="sn-bad">Not delivered:</b> this server has no mail server set up.{subject}</>;
  if (d.status === 'failed') return <><b className="sn-bad">Could not be sent</b> on {dayTime(d.at)}{d.error ? <>: {d.error}</> : null}.{subject}</>;
  return <>Waiting to go out since {dayTime(d.at)}.{subject}</>;
}

// One card per person: what really happened to their email, when they opened it, when they finished,
// and ways to reach them that do not depend on email.
export function Recipients({ envelope: e, deliveries, myEmail, onChanged, onCorrect }: { envelope: any; deliveries: Delivery[]; myEmail: string; onChanged: () => void; onCorrect: (r: any) => void }) {
  const [links, setLinks] = useState<Record<string, string>>({});
  const [shown, setShown] = useState('');
  const [busy, setBusy] = useState('');
  const out = e.status === 'sent';

  const linkFor = async (r: any) => {
    if (links[r.id]) return links[r.id];
    const { url } = await api(`/envelopes/${e.id}/recipient-view`, { body: { recipient_id: r.id } });
    setLinks((l) => ({ ...l, [r.id]: url }));
    return url as string;
  };
  const shareText = (r: any, url: string) => `Hi ${(r.name || '').split(' ')[0] || 'there'}, here is your personal link to ${ASK[r.role] || 'sign'} "${e.subject}": ${url}`;

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
      else toast(`No reminder went out. ${r.name} turned reminders off, so share the link another way.`, true);
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
      window.location.href = await linkFor(r);
    } catch (err) {
      fail(err);
      setBusy('');
    }
  }

  return (
    <ol className="sn-people">
      {e.recipients.map((r: any, i: number) => {
        const turn = out && (r.status === 'sent' || r.status === 'viewed');
        const isMe = r.role !== 'inperson' && r.email.toLowerCase() === myEmail.toLowerCase();
        const mail = r.status === 'pending' ? null : lastEmailTo(deliveries, r.email);
        const stale = turn && neverOpened(r);
        // Once they have opened it they clearly have the link, however the email fared.
        const undelivered = turn && r.status === 'sent' && r.role !== 'inperson' && !!mail && (mail.status === 'outbox' || mail.status === 'failed');
        const b = badge(r, e.status, mail);
        const reachable = turn && !isMe && r.role !== 'inperson';
        const before = e.ordered ? e.recipients.filter((x: any) => x.routing_order < r.routing_order && x.status !== 'completed' && x.role !== 'cc') : [];
        const p = r.progress;
        return (
          <li key={r.id} className={`sn-person${stale || undelivered ? ' warn' : ''}`}>
            <div className="sn-person-head">
              {!!e.ordered && <span className="sn-step" aria-label={`Step ${r.routing_order}`}>{r.routing_order}</span>}
              <div className="grow">
                <div className="sn-person-name">
                  <b>{r.name || r.role_name || `Recipient ${i + 1}`}</b>
                  {isMe && <span className="muted"> (you)</span>}
                  <span className="sn-person-email">{r.email}</span>
                </div>
                <div className="muted small">
                  {ROLE_LABEL[r.role]}
                  {r.reassigned_from ? ` · handed over by ${r.reassigned_from}` : ''}
                  {r.access_code ? <> · Access code <b className="sn-code">{r.access_code}</b> (give it to them yourself, it is not in the email)</> : null}
                </div>
              </div>
              <div className="sn-person-badges">
                <Status s={b.s} label={b.label} />
                {!!r.muted && <span className="badge sn-muted">Turned off reminders</span>}
              </div>
            </div>

            <dl className="sn-facts">
              {r.status === 'pending' && e.status !== 'draft' && (
                <div><dt>Email</dt><dd>{out ? <>Not sent yet. {before.length ? `It goes out once ${before.map((x: any) => x.name).join(' and ')} ${before.length === 1 ? 'has' : 'have'} finished.` : 'It goes out when their turn comes.'}</> : 'Never sent. The envelope closed before their turn.'}</dd></div>
              )}
              {r.status !== 'pending' && <div><dt>Email</dt><dd><EmailFact d={mail} role={r.role} /></dd></div>}
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
              {r.status === 'declined' && <div><dt>Declined</dt><dd>On {dayTime(r.completed_at)}.{r.decline_reason ? <> They wrote: &ldquo;{r.decline_reason}&rdquo;</> : null}</dd></div>}
            </dl>

            {stale && (
              <p className="sn-hint warn">
                <b>Not opened in {howLong(r.sent_at)}.</b> It may be in their spam folder. {r.muted ? 'Send them the link yourself:' : 'Nudge them, or send the link yourself:'}
              </p>
            )}
            {!stale && undelivered && (
              <p className="sn-hint warn">
                {mail!.status === 'failed' ? <>The email did not go out. Check the address with <b>Correct</b>, or send them the link yourself.</> : <>No email reached them. Send them the link yourself.</>}
              </p>
            )}
            {reachable && r.muted && !stale ? <p className="sn-hint">They asked for no more reminder emails. You can still send them the link yourself.</p> : null}

            {(turn || (out && r.status === 'pending')) && (
              <div className="sn-person-actions">
                {turn && (isMe || r.role === 'inperson') && <button className="btn sm primary" disabled={!!busy} onClick={() => signNow(r)}>{r.role === 'inperson' ? 'Host signing now' : `${r.role === 'approver' ? 'Review' : r.role === 'viewer' ? 'View' : 'Sign'} now`}</button>}
                {reachable && !r.muted && <button className="btn sm" disabled={!!busy} onClick={() => nudge(r)} aria-label={`Nudge ${r.name} with a reminder email`}>{busy === `nudge:${r.id}` ? 'Sending…' : 'Nudge'}</button>}
                {reachable && <button className="btn sm" disabled={!!busy} onClick={() => copy(r)} aria-label={`Copy signing link for ${r.name}`}>Copy link</button>}
                {reachable && <button className="btn sm" disabled={!!busy} onClick={() => shareVia(r, 'whatsapp')} aria-label={`Share link with ${r.name} on WhatsApp`}>Share on WhatsApp</button>}
                {reachable && <button className="btn sm" disabled={!!busy} onClick={() => shareVia(r, 'sms')} aria-label={`Share link with ${r.name} by text message`}>Share by text message</button>}
                <button className="btn sm" disabled={!!busy} onClick={() => onCorrect(r)} aria-label={`Correct name or email of ${r.name}`}>Correct</button>
              </div>
            )}
            {shown === r.id && links[r.id] && turn && (
              <label className="sn-link">
                <span>Personal link for {r.name}. Only share it with them.</span>
                <input readOnly value={links[r.id]} onFocus={(ev) => ev.currentTarget.select()} />
              </label>
            )}
          </li>
        );
      })}
    </ol>
  );
}
