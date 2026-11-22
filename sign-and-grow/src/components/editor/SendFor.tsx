'use client';
// Step 3, More options: "Send for <name>" (src/server/shares.ts). Only for someone a colleague shared sending with
// ("Send for me" in Settings, Away and sharing); absent for everyone else. Saves by itself
// (POST /api/envelopes/:id/send-for). Recipients then read "Ben Okoro (sent by Ana Silva)". Not on a template.
import { useState } from 'react';
import { api, useLoad, toast } from '../ui';
import { useMe } from '../AppShell';
import type { Ed } from './shared';
import { sendForLabel, sentByName } from '@/lib/shares';

export function SendFor({ ed }: { ed: Ed }) {
  const me = useMe();
  const [d] = useLoad<any>(() => (ed.isTpl || !ed.env?.id ? Promise.resolve(null) : api('/me/sends-for').catch(() => null)), [ed.env?.id]);
  const [owner, setOwner] = useState<string>(ed.env?.sender_id || me?.user?.id || '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const people: { id: string; name: string }[] = d?.people || [];
  if (ed.isTpl || !ed.env?.id || ed.env?.status !== 'draft' || !people.length) return null;
  const pick = async (to: string) => {
    setBusy(true);
    setSaved(false);
    try {
      const r = await api(`/envelopes/${ed.env.id}/send-for`, { body: { on_behalf_of: to === me.user.id ? '' : to } });
      setOwner(r.sender_id);
      setSaved(true);
    } catch (e: any) {
      toast(e?.message || 'That was not saved. Try again in a moment.', true);
    }
    setBusy(false);
  };
  const chosen = people.find((p) => p.id === owner);
  return (
    <fieldset className="card stack" data-feature="ds-colleagues" style={{ padding: 20, margin: 0 }}>
      <legend><b>Who it is from</b> <span className="small" role="status" style={{ color: 'var(--green)' }}>{saved ? 'Saved' : ''}</span></legend>
      <label className="setting-row" style={{ minHeight: 44, margin: 0 }}>
        <input type="radio" name="ed-send-for" checked={!chosen} disabled={busy} onChange={() => void pick(me.user.id)} />
        <span>From me</span>
      </label>
      {people.map((p) => (
        <label key={p.id} className="setting-row" style={{ minHeight: 44, margin: 0 }}>
          <input type="radio" name="ed-send-for" checked={owner === p.id} disabled={busy} onChange={() => void pick(p.id)} />
          <span>{sendForLabel(p.name)}</span>
        </label>
      ))}
      {chosen && <p className="muted small" style={{ margin: 0 }}>It will belong to {chosen.name}. The people on it read &ldquo;{sentByName(chosen.name, me.user.name)}&rdquo;.</p>}
    </fieldset>
  );
}
