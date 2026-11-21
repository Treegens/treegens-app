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
  return (
    <div className="f" data-feature="impact" style={{ margin: '18px 0 0', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
      <label className="check" style={{ minHeight: 44 }}>
        <input type="checkbox" checked={!!d.on} disabled={busy} aria-describedby="trees-record-hint" onChange={(e) => flip(e.target.checked)} /> Trees on the signing record
        <span role="status" className="small" style={{ marginLeft: 8, color: 'var(--green)' }}>{saved ? 'Saved' : ''}</span>
      </label>
      <p className="muted small" id="trees-record-hint" style={{ margin: 0 }}>The signing record of a completed document ends with a box on the paper it saved, as an estimate, and the mangroves its paid signatures fund. Switch this off to leave that box off documents completed from now on. Screens and emails do not change.</p>
    </div>
  );
}
