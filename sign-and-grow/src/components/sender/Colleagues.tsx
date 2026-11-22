'use client';
// Working for a colleague on the envelope page (src/server/shares.ts):
//   SharedNote      one line at the top: it came through a share, someone sent it for its owner, or it was moved.
//   MoveDialog      "Move to a colleague", from the page's More, a template's More (templates page) and the Documents
//                   list's selection, for the person it belongs to and for admins.
//   moveAllowed     whether More lists it: an account with 2 or more members, the person's own or an admin's.
// The words are in src/lib/shares.ts.
import { useState } from 'react';
import { api, useLoad } from '@/components/ui';
import { ConfirmDialog } from '@/components/sender/dialogs';
import { sharedLine, MOVE_LABEL, MOVE_HINT, type ShareLevel } from '@/lib/shares';

export function SharedNote({ data }: { data: any }) {
  const lines: string[] = [];
  if (data?.shared) lines.push(sharedLine(data.shared.owner, data.shared.level as ShareLevel));
  if (data?.sent_by_name) lines.push(`${data.sent_by_name} sent this for ${data.sent_for_name || 'the person it belongs to'}. The people on it see both names.`);
  if (data?.first_sender_name) lines.push(`First sent by ${data.first_sender_name}, and moved since. Its history says who moved it.`);
  if (!lines.length) return null;
  return (
    <div className="notice" data-feature="ds-colleagues" role="note">
      {lines.map((l) => <p key={l} style={{ margin: 0 }}>{l}</p>)}
    </div>
  );
}

/** More lists "Move to a colleague" only on a team, and only for the person it belongs to or an admin. */
export const moveAllowed = (me: any, e: any, data: any): boolean =>
  Number(me?.members) >= 2 && !data?.shared && !data?.removed_at && (e?.sender_id === me?.user?.id || me?.role === 'owner' || me?.role === 'admin');

/**
 * "Move to a colleague": one envelope or template (`envelope`), or several chosen in a list (`ids`, all of them
 * this person's own or seen as an admin). POST /envelopes/:id/move or POST /envelopes/move.
 */
export function MoveDialog({ envelope, ids, onClose, onDone }: { envelope?: any; ids?: string[]; onClose: () => void; onDone: () => void }) {
  const [d] = useLoad<any>(() => api('/me/shares').catch(() => null), []);
  const [to, setTo] = useState('');
  const people = (d?.colleagues || []).filter((p: any) => !envelope || p.id !== envelope.sender_id);
  const many = !envelope && (ids?.length || 0) > 0;
  return (
    <ConfirmDialog title={many ? `Move ${ids!.length} ${ids!.length === 1 ? 'document' : 'documents'} to a colleague` : MOVE_LABEL} confirmLabel={many ? 'Move them' : 'Move it'} keepLabel="Cancel" danger={false} unchanged="Nothing was moved." onClose={onClose}
      onConfirm={async () => {
        if (!to) throw new Error(`Choose the colleague to move ${many ? 'them' : 'it'} to. Nothing was moved.`);
        if (many) await api('/envelopes/move', { body: { ids, to } });
        else await api(`/envelopes/${envelope.id}/move`, { body: { to } });
        onDone();
      }}>
      <p>{MOVE_HINT}</p>
      <label className="f">
        <span>Move to</span>
        <select value={to} onChange={(ev) => setTo(ev.target.value)} style={{ minHeight: 44 }} aria-label={`Colleague to move ${many ? 'them' : 'it'} to`}>
          <option value="">Choose a colleague</option>
          {people.map((p: any) => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
        </select>
      </label>
    </ConfirmDialog>
  );
}
