'use client';
// Settings, Sending, inside the card "When people sign": "People may sign on paper" (research/ux-notes.json, ds-paper).
// Off for every account until an admin switches it on; then a person's More in the editor has "How they sign" with the
// paper choices, and the signing page's Other actions has "Sign on paper instead". GET and PUT /api/account/paper
// (src/server/routes-paper.ts). It saves the moment it changes, with "Saved" next to it.
import { useState } from 'react';
import { api, oops } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { useSaved } from './Frame';
import { PAPER_WORDS } from '@/lib/paper';

export function PaperSetting() {
  const me = useMe();
  const admin = me?.role === 'owner' || me?.role === 'admin';
  const [on, setOn] = useState<boolean>(!!me?.paper_signing);
  const [said, saved] = useSaved();
  if (!admin) return null;
  const flip = (v: boolean) => {
    setOn(v);
    api('/account/paper', { method: 'PUT', body: { on: v } }).then(() => (saved(), me.reload?.())).catch((e) => (setOn(!v), oops(e)));
  };
  return (
    <label className="setting-row" data-feature="ds-paper" style={{ margin: '12px 0 0', minHeight: 44 }}>
      <input type="checkbox" role="switch" checked={on} aria-labelledby="sw-paper-t" aria-describedby="sw-paper-h" onChange={(e) => flip(e.target.checked)} style={{ width: 22, height: 22 }} />
      <span>
        <b id="sw-paper-t">{PAPER_WORDS.setting}</b> {said}
        <span className="muted small" id="sw-paper-h" style={{ display: 'block' }}>{PAPER_WORDS.settingHint}</span>
      </span>
    </label>
  );
}
