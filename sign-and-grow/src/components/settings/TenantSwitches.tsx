'use client';
// Settings, Account: two switches an owner or admin sets for the whole account (PUT /api/account/policy,
// src/server/routes-tenantpolicy.ts). Each saves as soon as it is flipped, like 'Trees on the signing record', which
// sits right under the trees switch (the wider one comes first, so 'no trees' is found in one place), and each change
// is a line in the account's history (Settings, Security).
// A switch's name is its title alone (aria-labelledby); the hint is its description, read once.
//   Trees on screens and emails   always shown.
//   AI answers in the help chat   shown only on a server where a model answers the chat. Without one there is
//                                 nothing to switch, so there is no switch.
import { useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { TreesOnRecord } from './TreesOnRecord';

type Key = 'impact_display' | 'ai_helper';

export function TenantSwitches() {
  const me = useMe();
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
      // The editor's review step reads the switch from /api/me: it is right on the next screen, without a reload.
      me?.reload();
    } catch (e: any) {
      toast(`${e?.message || 'That was not saved.'} Try again in a moment.`, true);
    }
    reload();
    setBusy(null);
  };
  const row = (key: Key, title: string, hint: string) => (
    <label className="setting-row" data-feature="gov-G01" style={{ margin: '14px 0 0', minHeight: 44 }}>
      <input type="checkbox" role="switch" checked={d[key] === 'on'} disabled={busy !== null || !!d.set_by?.[key]} aria-labelledby={`policy-${key}-title`} aria-describedby={`policy-${key}-hint`} onChange={(e) => flip(key, e.target.checked)} />
      <span>
        <b id={`policy-${key}-title`}>{title}</b> <span role="status" className="small" style={{ marginLeft: 6, color: 'var(--green)' }}>{saved === key ? 'Saved' : ''}</span>
        <span className="muted small" id={`policy-${key}-hint`} style={{ display: 'block' }}>{d.set_by?.[key] ? `${d.set_by[key]}, for every account below it. ` : ''}{hint}</span>
      </span>
    </label>
  );
  return (
    <>
      {row('impact_display', 'Trees on screens and emails', 'Tells the people who sign how much paper their signature saved, and any trees it paid for: next to Finish, after they finish and in emails about the document. Saves by itself.')}
      <TreesOnRecord />
      {d.ai_available && row('ai_helper', 'AI answers in the help chat', `Questions your team types into Help while signed in, and that people type into Help while signing your documents, go to ${d.ai_provider || 'an AI service'}, which writes the answer. Off: Help answers them from the built-in help pages and sends those questions nowhere. Saves by itself.`)}
    </>
  );
}
