'use client';
import { useState } from 'react';
import { api, toast } from '@/components/ui';
import { fail } from './feedback';
import { dayTime } from './lib';
import { ConfirmDialog } from './dialogs';
import { groupDoes } from '@/lib/groups';

// The envelope page, for a recipient that is a signing group (src/server/groups.ts): who is in it on this envelope,
// what became of each member's email, who has taken it on, and the two things only the sender can do. Every member
// has a link of their own, so "Copy link" is per member. "Give back to the group" takes the document back from the
// member who has it and clears what they filled in. Who is in the group changes with Edit envelope.

type Delivery = { to_email: string; recipient_id?: string | null; status: string; at: string; tried_at?: string | null; next_try_at?: string | null; bounced_at?: string | null };

export function GroupMembers({ e, r, deliveries, onChanged }: { e: any; r: any; deliveries: Delivery[]; onChanged: () => void }) {
  const [busy, setBusy] = useState('');
  const [shown, setShown] = useState<{ id: string; url: string } | null>(null);
  const [releasing, setReleasing] = useState(false);
  const members: any[] = r.members || [];
  const out = e.status === 'sent';
  const turn = out && (r.status === 'sent' || r.status === 'viewed');
  const open = !r.claimed_by;
  const holder = members.find((m) => m.id === r.claimed_by);

  async function copy(m: any) {
    setBusy(m.id);
    try {
      const { url } = await api(`/envelopes/${e.id}/recipient-view`, { body: { recipient_id: r.id, member_id: m.id } });
      setShown({ id: m.id, url });
      try {
        await navigator.clipboard.writeText(url);
        toast(`Link for ${m.name} copied. It is theirs alone: anything done with it is recorded under their name.`);
      } catch {
        toast('Your browser did not let us copy. The link is shown under their name, so you can select and copy it.', true);
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  }
  const emailOf = (m: any) => deliveries.find((d) => d.recipient_id === r.id && d.to_email.toLowerCase() === m.email.toLowerCase()) || null;
  const fact = (m: any) => {
    if (m.id === r.claimed_by) return r.status === 'completed' ? `${r.role === 'cc' ? 'Read' : 'Acted'} for the group.` : `Has taken it on${r.claimed_at ? ` since ${dayTime(r.claimed_at)}` : ''}.`;
    const d = emailOf(m);
    const mail = !m.sent_at ? (r.status === 'pending' ? 'Emailed when it is the group\'s turn.' : 'Not emailed.') : d?.bounced_at ? 'The email came back. Fix the address with Edit envelope.' : d?.status === 'outbox' ? 'No email went out: no mail server is set up. Copy their link.' : d?.status === 'failed' ? 'The email has not gone out yet.' : 'Emailed.';
    return `${mail}${m.viewed_at ? ` Opened on ${dayTime(m.viewed_at)}.` : ''}${m.muted ? ' Turned off reminders.' : ''}`;
  };

  return (
    <div className="sn-group-card">
      <p className="small" style={{ margin: '0 0 6px' }}>
        <b>{r.group_name}</b>, a group of {members.length} on this envelope.{' '}
        {r.status === 'completed' ? `${r.name} acted for it.` : open ? `Any one of them can ${groupDoes(r.role)} it. Each has their own link, and the first who agrees takes it on.` : `${holder?.name || r.name} has taken it on. The others see that on their own link.`}
      </p>
      <ul aria-label={`Members of ${r.group_name}`}>
        {members.map((m) => (
          <li key={m.id}>
            <span><b>{m.name}</b> <span className="muted">{m.email}</span><br /><span className="muted small">{fact(m)}</span></span>
            {/* While nobody has it, each member's own link can be passed on. Once someone has it, only theirs works. */}
            {turn && open && <button type="button" className="btn sm" disabled={!!busy} onClick={() => copy(m)} aria-label={`Copy the signing link of ${m.name}`}>{busy === m.id ? 'Copying…' : 'Copy link'}</button>}
          </li>
        ))}
      </ul>
      {shown && turn && open && (
        <label className="sn-link">
          <span>Personal link for {members.find((m) => m.id === shown.id)?.name}. Only share it with them.</span>
          <input readOnly value={shown.url} onFocus={(ev) => ev.currentTarget.select()} />
        </label>
      )}
      {turn && !open && (
        <div className="sn-person-actions">
          <button type="button" className="btn sm" onClick={() => setReleasing(true)} aria-label={`Give ${r.group_name} back to the whole group`}>Give back to the group</button>
        </div>
      )}
      {out && r.status !== 'completed' && <p className="muted small" style={{ margin: '6px 0 0' }}>To change who is in {r.group_name} on this envelope, choose Edit envelope. Changing the group under Contacts does not change envelopes already sent.</p>}
      {releasing && (
        <ConfirmDialog title={`Give back to ${r.group_name}`} confirmLabel="Give it back" keepLabel={`Leave it with ${r.name}`} danger={false} onClose={() => setReleasing(false)}
          onConfirm={async () => {
            await api(`/envelopes/${e.id}/recipients/${r.id}/release`, { body: {} });
            toast(`Given back to ${r.group_name}. Every member was emailed their link.`);
            setReleasing(false);
            onChanged();
          }}>
          <p>{r.name} has taken this on and has not finished. If you give it back, every member of {r.group_name} can take it on again, and they are emailed. What {r.name} filled in so far is cleared.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
