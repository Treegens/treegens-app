'use client';
// Settings, Account: two switches an owner or admin sets for the whole account (PUT /api/account/policy,
// src/server/routes-tenantpolicy.ts). Each saves as soon as it is flipped, like 'Trees on the signing record' above
// them, and each change is a line in the account's history (Settings, Security).
//   Trees on screens and emails   always shown.
//   AI answers in the help chat   shown only on a server where a model answers the chat. Without one there is
//                                 nothing to switch, so there is no switch.
import { useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';

type Key = 'impact_display' | 'ai_helper';

export function TenantSwitches() {
  const [d, reload] = useLoad<any>(() => api('/account/policy').catch(() => null), []);
  const [busy, setBusy] = useState<Key | null>(null);
  const [saved, setSaved] = useState<Key | null>(null);
  if (!d) return null;
  const flip = async (key: Key, on: boolean) => {
    setBusy(key);
    setSaved(null);
    try {
      await api('/account/policy', { method: 'PUT', body: { [key]: on ? 'on' : 'off' } });
      setSaved(key);
    } catch (e: any) {
      toast(`${e?.message || 'That was not saved.'} Try again in a moment.`, true);
    }
    reload();
    setBusy(null);
  };
  const row = (key: Key, title: string, hint: string) => (
    <label className="setting-row" data-feature="gov-G01" style={{ margin: '14px 0 0', minHeight: 44 }}>
      <input type="checkbox" role="switch" checked={d[key] === 'on'} disabled={busy !== null} aria-describedby={`policy-${key}-hint`} onChange={(e) => flip(key, e.target.checked)} />
      <span>
        <b>{title}</b> <span role="status" className="small" style={{ marginLeft: 6, color: 'var(--green)' }}>{saved === key ? 'Saved' : ''}</span>
        <span className="muted small" id={`policy-${key}-hint`} style={{ display: 'block' }}>{hint}</span>
      </span>
    </label>
  );
  return (
    <>
      {row('impact_display', 'Trees on screens and emails', 'Tells the people who sign what their signature plants and the paper it saved: next to Finish, after they finish and in emails about the document. Saves by itself.')}
      {d.ai_available && row('ai_helper', 'AI answers in the help chat', `Questions your team and the people who sign your documents type into Help go to ${d.ai_provider || 'an AI service'}, which writes the answer. Off: Help answers them from the built-in help pages and sends their questions nowhere. Saves by itself.`)}
    </>
  );
}
