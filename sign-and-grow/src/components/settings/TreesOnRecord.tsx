'use client';
// Settings, Account: 'Trees on the signing record'. On unless an admin switches it off. Off leaves the box "Signed
// without paper" (the paper estimate and the line about mangroves) off the signing record of documents completed
// from then on; screens, emails and the Trees planted page stay as they are. It saves as soon as it changes
// (PUT /api/account/impact-record, src/server/routes-impact.ts). Only admins see the Account settings at all.
import { useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';

export function TreesOnRecord() {
  const [d, reload] = useLoad<any>(() => api('/account/impact-record').catch(() => null), []);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!d) return null;
  const flip = async (on: boolean) => {
    setBusy(true);
    setSaved(false);
    try {
      await api('/account/impact-record', { method: 'PUT', body: { on } });
      setSaved(true);
    } catch (e: any) {
      toast(`${e?.message || 'That was not saved.'} Try again in a moment.`, true);
    }
    reload();
    setBusy(false);
  };
  // Drawn as a switch with its own line, apart from the Save button of the boxes above: it saves as it is flipped.
  return (
    <label className="setting-row" data-feature="impact" style={{ margin: '22px 0 0', minHeight: 44 }}>
      <input type="checkbox" role="switch" checked={!!d.on} disabled={busy} aria-describedby="trees-record-hint" onChange={(e) => flip(e.target.checked)} />
      <span>
        <b>Trees on the signing record</b> <span role="status" className="small" style={{ marginLeft: 6, color: 'var(--green)' }}>{saved ? 'Saved' : ''}</span>
        <span className="muted small" id="trees-record-hint" style={{ display: 'block' }}>Adds the paper saved and the mangroves funded to the last page of documents completed from now on. Saves by itself.</span>
      </span>
    </label>
  );
}
