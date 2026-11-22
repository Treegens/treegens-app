'use client';
// Settings, Account, under "AI answers in the help chat": "Let the AI read document text" (PUT /api/account/ai-read,
// src/server/routes-aiassist.ts). Shown only where a model answers for this account: with no model, or with the
// account's AI switch off, there is nothing it could do, so there is no switch. It saves as soon as it is flipped and
// says in one line what it is used for, and under it who gets the text, on which host and in which country.
import { useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { READ_SWITCH, READ_HINT } from '@/lib/aiassist';
import { forgetAssist } from '@/components/editor/DraftMessage';
import { KeyDatesSetting } from './KeyDatesSetting';

export function AiSettings() {
  const me = useMe();
  // Asked only where the account's AI is on (as useAssist does): with zero setup nothing is fetched.
  const on = me?.policy?.ai_helper === 'on';
  const [d, reload] = useLoad<any>(() => (on ? api('/ai/assist').catch(() => null) : Promise.resolve(null)), [on]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  if (!d?.available) return null;
  const flip = async (on: boolean) => {
    setBusy(true);
    setSaved('');
    try {
      const r = await api('/account/ai-read', { method: 'PUT', body: { read: on ? 'on' : 'off' } });
      // Key dates needs this switch, so it went off with it (src/server/aiassist.ts setRead): say so, and drop its
      // entry from the sidebar.
      setSaved(r?.key_dates_stopped ? 'Saved. Key dates and its reminders are off too.' : 'Saved');
      if (r?.key_dates_stopped) me?.reload?.(true);
      forgetAssist();
    } catch (e: any) {
      toast(`${e?.message || 'That was not saved.'} Try again in a moment.`, true);
    }
    reload();
    setBusy(false);
  };
  return (
    <>
    <label className="setting-row" data-feature="ds-ai-assist" style={{ margin: '14px 0 0', minHeight: 44 }}>
      <input type="checkbox" role="switch" checked={!!d.read} disabled={busy} aria-labelledby="ai-read-title" aria-describedby="ai-read-hint" onChange={(e) => flip(e.target.checked)} />
      <span>
        <b id="ai-read-title">{READ_SWITCH}</b> <span role="status" className="small" style={{ marginLeft: 6, color: 'var(--green)' }}>{saved}</span>
        <span className="muted small" id="ai-read-hint" style={{ display: 'block' }}>{READ_HINT}<span style={{ display: 'block' }}>{d.where}</span></span>
      </span>
    </label>
    {/* Key dates, its own switch, only while the AI may read document text (KeyDatesSetting.tsx). */}
    {d.read && <KeyDatesSetting key={String(d.read)} />}
    </>
  );
}
