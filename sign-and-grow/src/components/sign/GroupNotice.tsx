'use client';
import { useState } from 'react';
import { api, fmtDate } from '@/components/ui';
import { StateCard, Sender } from './parts';
import { Dialog } from './Dialog';
import { groupInvite, groupTakeOn, groupDeclineNote, groupTakenTitle, groupDid, groupDoes } from '@/lib/groups';

// The signing page of a document that was sent to a signing group ("HR team"): every member has a link of their own,
// and the first who agrees takes it on (src/server/groups.ts). The server sends "recipient.group" with what this
// link is to the group: open, mine, taken, copy or removed. Everything here only says what the server decided.

/** Whether this link belongs to a member whose colleague has the document, or who was taken out of the group. */
export const groupAway = (data: any): boolean => {
  const g = data?.recipient?.group;
  return !!g?.away && (data.envelope.status === 'sent' || data.envelope.status === 'completed' || data.recipient.status === 'declined');
};

/** The whole screen for such a link: who has it, and the one thing this person can do, which is ask the sender. */
export function GroupAway({ data, base }: { data: any; base: string }) {
  const g = data.recipient.group;
  const env = data.envelope;
  const s = env.sender || {};
  const role = data.recipient.role;
  const [asked, setAsked] = useState<'' | 'busy' | 'asked'>('');
  const [error, setError] = useState('');
  async function ask() {
    setAsked('busy');
    setError('');
    try {
      await api(`${base}/take-over`, { body: {} });
      setAsked('asked');
    } catch (e: any) {
      setAsked('');
      setError(e?.message || `We could not reach the server. Check your connection and try again, or write to ${s.name} yourself: ${s.email}.`);
    }
  }
  if (g.state === 'removed')
    return (
      <StateCard tone="stop" title="You no longer need to act on this">
        <p>{s.name} changed who can act on this document{g.name ? ` for ${g.name}` : ''}, and you are no longer one of them. There is nothing for you to do.</p>
        <Sender env={env} brand={data.brand} lead="Questions? Contact" />
      </StateCard>
    );
  const declined = data.recipient.status === 'declined';
  return (
    <StateCard tone={g.done ? 'ok' : declined ? 'stop' : 'wait'} title={declined ? `${g.by} from ${g.name} declined this` : groupTakenTitle(g.by, g.name, g.done, role)}>
      {declined ? <p>{g.by} declined it for {g.name}, so the document is closed for everyone. There is nothing more for you to do.</p>
        : g.done ? <p>{g.by} {groupDid(role)} it for {g.name}{g.done_at ? ` on ${fmtDate(g.done_at, true)}` : ''}. There is nothing left for you to do with this link.</p>
        : <p>This was sent to everyone in {g.name}, and {g.by} agreed to {groupDoes(role)} it first{g.at ? ` on ${fmtDate(g.at, true)}` : ''}. So this link no longer opens the document, and you do not need to do anything.</p>}
      {g.can_ask && (
        <>
          <p>Should you {groupDoes(role)} it instead, for example because {g.by} is away? Only {s.name} can give it back to the whole group. Asking tells them, and changes nothing else.</p>
          {asked === 'asked'
            ? <div className="notice sg-confirmed" role="status"><b>Done. We told {s.name}.</b> If they give it back to {g.name}, you get an email with your link.</div>
            : <div className="row wrap sg-actions sg-group"><button type="button" className="btn primary lg" disabled={asked === 'busy'} onClick={ask}>{asked === 'busy' ? 'Asking' : `Ask ${s.name} to give it back`}</button></div>}
          {error && <div className="notice err sg-problem" role="alert">{error}</div>}
        </>
      )}
      <Sender env={env} brand={data.brand} lead="Questions? Contact" />
    </StateCard>
  );
}

/** On the consent screen of a member, right above the box they tick: what agreeing means for the group. */
export function GroupConsentNote({ data }: { data: any }) {
  const g = data.recipient.group;
  if (!g || g.state !== 'open') return null;
  return (
    <div className="notice sg-gap sg-group" role="note">
      <p style={{ margin: 0 }}>{groupInvite(g.name, g.size, data.recipient.role)}</p>
      <p><b>{groupTakeOn(g.name, data.recipient.role)}</b></p>
    </div>
  );
}

/** Said in the decline dialog of a group's document: one member declining declines for everyone. */
export const groupDeclineText = (data: any): string | undefined => (data?.recipient?.group?.name ? groupDeclineNote(data.recipient.group.name) : undefined);

/** "Hand back to HR team": for the member who took it on, before they finish. What they filled in is not kept. */
export function HandBackDialog({ base, data, onClose, onDone }: { base: string; data: any; onClose: () => void; onDone: () => void }) {
  const g = data.recipient.group;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog title={`Hand back to ${g.name}`} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await api(`${base}/hand-back`, { body: { reason } });
          onDone();
        } catch (err: any) {
          setError(err?.message ? `${err.message}` : 'We could not reach the server. Nothing was handed back. Check your connection and try again.');
        } finally {
          setBusy(false);
        }
      }}>
        <p>The document goes back to everyone in {g.name}, and they are emailed. Any of them can take it on, you too. What you filled in so far is cleared and goes to nobody. {data.envelope.sender?.name} is told.</p>
        {/* The note goes to the sender and into the record only: words typed here never reach the others' inboxes (groups.ts handBack). */}
        <label className="f"><span>Why, for {data.envelope.sender?.name || 'the sender'} <span className="hint">(optional. It goes to {data.envelope.sender?.name || 'the sender'} and into the record, not to the others in {g.name})</span></span><textarea dir="auto" data-autofocus rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {error && <div className="notice err sg-problem" role="alert">{error}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Keep it</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Handing back' : 'Hand it back'}</button>
        </div>
      </form>
    </Dialog>
  );
}
