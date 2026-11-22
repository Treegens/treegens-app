'use client';
// Settings, Account: 'Trees on the signing record'. On unless an admin switches it off. Off leaves the box "Signed
// without paper" (the paper estimate and the line about mangroves) off the signing record of documents completed
// from then on; screens, emails and the Trees planted page stay as they are. It saves as soon as it changes
// (PUT /api/account/impact-record, src/server/routes-impact.ts). Only admins see the Account settings at all.
import { useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { useST } from '@/components/senderLang';

export function TreesOnRecord() {
  const T = useST();
  const [d, reload] = useLoad<any>(() => api('/account/impact-record').catch(() => null), []);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!d) return null;
  // fixed: the server never puts trees on the record (a government installation), so there is no switch, only why.
  if (d.fixed) return <p className="muted small" data-feature="gov-G01" style={{ margin: '14px 0 0' }}>{T('settings.trees.fixed')}</p>;
  const flip = async (on: boolean) => {
    setBusy(true);
    setSaved(false);
    try {
      await api('/account/impact-record', { method: 'PUT', body: { on } });
      setSaved(true);
    } catch (e: any) {
      toast(`${T.error(e)} ${T('settings.try_again')}`, true);
    }
    reload();
    setBusy(false);
  };
  // Drawn as a switch with its own line, apart from the Save button of the boxes above: it saves as it is flipped.
  return (
    <label className="setting-row" data-feature="impact" style={{ margin: '14px 0 0', minHeight: 44 }}>
      <input type="checkbox" role="switch" checked={!!d.on} disabled={busy || !!d.set_by} aria-labelledby="trees-record-title" aria-describedby={d.set_by ? 'trees-record-by trees-record-hint' : 'trees-record-hint'} onChange={(e) => flip(e.target.checked)} />
      <span>
        <b id="trees-record-title">{T('settings.trees.title')}</b> <span role="status" className="small" style={{ marginLeft: 6, color: 'var(--green)' }}>{saved ? T('settings.saved') : ''}</span>
        {d.set_by && <span className="small" id="trees-record-by" style={{ display: 'block' }}>{T('settings.set_by_below', { who: d.set_by })}</span>}
        <span className="muted small" id="trees-record-hint" style={{ display: 'block' }}>{T('settings.trees.hint')}</span>
      </span>
    </label>
  );
}
