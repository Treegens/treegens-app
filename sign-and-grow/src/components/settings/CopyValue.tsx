'use client';
// One long value an admin copies into another system (an address, a one-time token), with its own Copy button.
// Used by the SAML part of the Single sign-on card (OrgSaml.tsx) and by Members from your directory (OrgDirectory.tsx).
// The value stays on screen as selectable text, so copying by hand still works where the clipboard does not.
import { useState } from 'react';
import { useST } from '@/components/senderLang';


export function CopyValue({ label, value, button }: { label?: string; value: string; button: string }) {
  const say = useST();
  const [state, setState] = useState<'' | 'done' | 'failed'>('');
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw 0;
      await navigator.clipboard.writeText(value);
      setState('done');
    } catch {
      setState('failed');
    }
  };
  return (
    <div className="small">
      {label && <div>{label}:</div>}
      <code style={{ wordBreak: 'break-all', userSelect: 'all' }}>{value}</code>
      <div className="row wrap" style={{ gap: 8, marginTop: 6 }} aria-live="polite">
        <button type="button" className="btn" style={{ minHeight: 44 }} onClick={copy}>{state === 'done' ? say('saml.copied') : button}</button>
        {state === 'failed' && <span>{say('saml.copy_failed')}</span>}
      </div>
    </div>
  );
}
