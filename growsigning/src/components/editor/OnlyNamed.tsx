'use client';
// Step 3, More options: "Only the person named may sign" (src/server/delegation.ts). Only when a person on this
// envelope is away today and named someone to sign for them (POST /api/envelopes/:id/away), and then it says who.
// Absent everywhere else, so a send where nobody is away has no new choice. Saves by itself
// (PUT /api/envelopes/:id/only-named). Not on a template: it belongs to one envelope.
import { useEffect, useState } from 'react';
import { api, toast } from '../ui';
import { useMe } from '../AppShell';
import type { Ed } from './shared';
import { ONLY_NAMED, ONLY_NAMED_HINT, awayLine } from '@/lib/delegation';

type Away = { email: string; name: string; delegate: string; role: string };

export function OnlyNamed({ ed }: { ed: Ed }) {
  const me = useMe();
  const [on, setOn] = useState<boolean>(!!(ed.env as any)?.delegate_off);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [away, setAway] = useState<Away[]>([]);
  const allowed = !!me?.delegation && !ed.isTpl && !!ed.env?.id;
  // The people as the editor has them now: asked again when a name, an address or a role changes.
  const people = (ed.rcps || []).map((r: any) => ({ name: r.name || '', email: r.email || '', role: r.role || '', group_id: r.group_id || null }));
  const key = JSON.stringify(people);
  useEffect(() => {
    if (!allowed) return;
    let live = true;
    api(`/envelopes/${ed.env.id}/away`, { body: { people } }).then((r) => live && setAway(r?.away || [])).catch(() => live && setAway([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, ed.env?.id, key]);
  // Shown while it means something: someone here is away, or the box is ticked (so it can be unticked).
  if (!allowed || (!away.length && !on)) return null;
  const flip = async (v: boolean) => {
    setBusy(true);
    setSaved(false);
    try {
      const r = await api(`/envelopes/${ed.env.id}/only-named`, { method: 'PUT', body: { on: v } });
      setOn(!!r.only_named);
      setSaved(true);
    } catch (e: any) {
      toast(e?.message || 'That was not saved. Try again in a moment.', true);
    }
    setBusy(false);
  };
  return (
    <label className="card setting-row" data-feature="ds-delegate" style={{ minHeight: 44, padding: 20 }}>
      <input type="checkbox" checked={on} disabled={busy} aria-labelledby="ed-only-title" aria-describedby="ed-only-hint" onChange={(e) => void flip(e.target.checked)} />
      <span>
        <b id="ed-only-title">{ONLY_NAMED}</b> <span className="small" role="status" style={{ color: 'var(--green)' }}>{saved ? 'Saved' : ''}</span>
        <span className="muted small" id="ed-only-hint" style={{ display: 'block' }}>{away.length ? away.map(awayLine).join(' ') : ONLY_NAMED_HINT}</span>
      </span>
    </label>
  );
}
