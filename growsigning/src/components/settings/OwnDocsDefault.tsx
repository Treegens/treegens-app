'use client';
// Settings, Sending, an open card: "When people sign" (charter 2.2). Whether new envelopes and templates start with "Each person
// sees only their files" on (src/lib/owndocs.ts). Off for every account until an admin turns it on. Whoever sends
// can still change it for one document on the last step, and documents already out keep what they have.
import { useState } from 'react';
import { api, oops } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { useST } from '@/components/senderLang';
import { useSaved } from './Frame';
import { WhenPeopleSign } from './Switches';
import { PaperSetting } from './PaperSetting';

export function OwnDocsDefault() {
  const me = useMe();
  const T = useST();
  const [on, setOn] = useState<boolean>(!!me.account?.own_docs_default);
  const [said, saved] = useSaved();
  // Only an owner or admin may change the account's defaults (PATCH /account): nobody else is shown a switch they cannot use.
  if (me.role === 'member') return null;
  const flip = (v: boolean) => {
    setOn(v);
    api('/account', { method: 'PATCH', body: { own_docs_default: v } }).then(() => (saved(), me.reload())).catch((e) => (setOn(!v), oops(e)));
  };
  return (
    <section className="card" aria-labelledby="set-owndocs-h" data-item="card" data-feature="ds-visibility">
      <h2 id="set-owndocs-h" style={{ marginBottom: 4 }}>{T('settings.owndocs.title')}</h2>
      <label className="setting-row" style={{ minHeight: 44 }}>
        <input type="checkbox" role="switch" checked={on} aria-describedby="set-owndocs-hint" onChange={(e) => flip(e.target.checked)} />
        <span>
          <b>{T('owndocs.label')}</b> {said}
          <span className="muted small" id="set-owndocs-hint" style={{ display: 'block' }}>{T('settings.owndocs.hint')} {T('owndocs.note')}</span>
        </span>
      </label>
      {/* The other switches of this card: pass it on, questions and comments, ways to sign, the mark (Switches.tsx). */}
      <WhenPeopleSign />
      {/* "People may sign on paper" (PaperSetting.tsx): off until an admin switches it on. */}
      <PaperSetting />
    </section>
  );
}
