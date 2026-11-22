'use client';
// Settings, Sending, an open card: "When people sign" (charter 2.2). Whether new envelopes and templates start with "Each person
// sees only their files" on (src/lib/owndocs.ts). Off for every account until an admin turns it on. Whoever sends
// can still change it for one document on the last step, and documents already out keep what they have.
import { useState } from 'react';
import { api, oops } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { OWN_DOCS_LABEL, OWN_DOCS_NOTE } from '@/lib/owndocs';
import { useSaved } from './Frame';

export function OwnDocsDefault() {
  const me = useMe();
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
      <h2 id="set-owndocs-h" style={{ marginBottom: 4 }}>When people sign</h2>
      <label className="setting-row" style={{ minHeight: 44 }}>
        <input type="checkbox" role="switch" checked={on} aria-describedby="set-owndocs-hint" onChange={(e) => flip(e.target.checked)} />
        <span>
          <b>{OWN_DOCS_LABEL}</b> {said}
          <span className="muted small" id="set-owndocs-hint" style={{ display: 'block' }}>New documents with two or more files start with this on. {OWN_DOCS_NOTE}</span>
        </span>
      </label>
    </section>
  );
}
