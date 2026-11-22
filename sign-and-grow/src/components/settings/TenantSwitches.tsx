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
import { useST } from '@/components/senderLang';
import { TreesOnRecord } from './TreesOnRecord';

type Key = 'impact_display' | 'ai_helper';

export function TenantSwitches() {
  const me = useMe();
  const T = useST();
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
      toast(`${T.error(e)} ${T('settings.try_again')}`, true);
    }
    reload();
    setBusy(null);
  };
  const row = (key: Key, title: string, hint: string) => (
    <label className="setting-row" data-feature="gov-G01" style={{ margin: '14px 0 0', minHeight: 44 }}>
      <input type="checkbox" role="switch" checked={d[key] === 'on'} disabled={busy !== null || !!d.set_by?.[key]} aria-labelledby={`policy-${key}-title`} aria-describedby={`policy-${key}-hint`} onChange={(e) => flip(key, e.target.checked)} />
      <span>
        <b id={`policy-${key}-title`}>{title}</b> <span role="status" className="small" style={{ marginLeft: 6, color: 'var(--green)' }}>{saved === key ? T('settings.saved') : ''}</span>
        <span className="muted small" id={`policy-${key}-hint`} style={{ display: 'block' }}>{d.set_by?.[key] ? `${T('settings.set_by_below', { who: d.set_by[key] })} ` : ''}{hint}</span>
      </span>
    </label>
  );
  return (
    <>
      {row('impact_display', T('settings.tenant.impact_title'), T('settings.tenant.impact_hint'))}
      <TreesOnRecord />
      {d.ai_available && row('ai_helper', T('settings.tenant.ai_title'), `${T('settings.tenant.ai_hint', { provider: d.ai_provider || T('settings.tenant.ai_service') })}${d.ai_assist ? ` ${T('settings.tenant.ai_draft')}` : ''} ${T('settings.saves_itself')}`)}
    </>
  );
}
