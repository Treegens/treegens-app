'use client';
import { useState } from 'react';
import { api } from '@/components/ui';

// Shown on the signing page of someone who marked our email about this document as spam (mail_stopped, see
// src/server/routes-bounces.ts). We email them nothing more about it, and only they can change that: holding this
// link is how they show it is them. The button is at least 44 pixels tall, for a thumb.
// Links for which emails were switched on again in this tab. The page is drawn anew at each step, from what it loaded
// first, so this is what keeps the notice from coming back after the person pressed the button.
const switchedOn = new Set<string>();

export function MailAgain({ base, stopped }: { base: string; stopped: boolean }) {
  const [state, setState] = useState<'' | 'busy' | 'done' | 'failed'>('');
  if ((!stopped || switchedOn.has(base)) && state !== 'done') return null;
  if (state === 'done') return <div className="notice sg-top" role="status"><b>Emails are on again.</b> We will email you about this document again: reminders while it waits for you, and a copy when it is completed.</div>;
  async function again() {
    setState('busy');
    try {
      await api(`${base}/mail-again`, { method: 'POST' });
      switchedOn.add(base);
      setState('done');
    } catch {
      setState('failed');
    }
  }
  return (
    <div className="notice sg-top" role="status">
      <p style={{ margin: 0 }}><b>We do not email you about this document.</b> You marked one of our emails about it as spam, so we stopped: no reminders, and no copy by email when it is completed. This link still opens it whenever you like.</p>
      {state === 'failed' && <p role="alert" style={{ margin: '8px 0 0' }}>That did not go through. Check your connection and try again.</p>}
      <button type="button" className="btn sm" style={{ minHeight: 44, marginTop: 10 }} disabled={state === 'busy'} onClick={again}>{state === 'busy' ? 'Saving…' : 'Email me about this document again'}</button>
    </div>
  );
}
