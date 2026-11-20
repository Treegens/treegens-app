'use client';
import { useState } from 'react';
import { api } from '@/components/ui';

// Shown on the signing page of someone who marked one of our emails for this sender as spam (mail_stopped, see
// src/server/routes-bounces.ts). We email them nothing more about the sender's documents, and only they can change
// that. Holding this link does not show it is them (the sender can copy it), so a code goes to their mailbox and
// they type it here. Buttons and the field are at least 44 pixels tall, for a thumb.
// Links for which emails were switched on again in this tab. The page is drawn anew at each step, from what it loaded
// first, so this is what keeps the notice from coming back after the person pressed the button.
const switchedOn = new Set<string>();

export function MailAgain({ base, stopped }: { base: string; stopped: boolean }) {
  const [state, setState] = useState<'' | 'busy' | 'sent' | 'done'>('');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  if ((!stopped || switchedOn.has(base)) && state !== 'done') return null;
  if (state === 'done') return <div className="notice sg-top" role="status"><b>Emails are on again.</b> We will email you about this sender&apos;s documents again: reminders while one waits for you, and a copy when it is completed.</div>;
  async function call(body: any, after: string) {
    const was = state;
    setState('busy');
    setError('');
    try {
      const r = await api(`${base}/mail-again`, { method: 'POST', body });
      if (r.code_sent) (setSentTo(r.sent_to || ''), setCode(''), setState('sent'));
      else (switchedOn.add(base), setState('done'));
    } catch (e: any) {
      setState(after === 'sent' || was === 'sent' ? 'sent' : '');
      setError(e?.status ? e.message : 'That did not go through. Check your connection and try again.');
    }
  }
  const asking = state === 'sent' || (state === 'busy' && !!sentTo);
  return (
    <div className="notice sg-top" role="status">
      <p style={{ margin: 0 }}><b>We do not email you about this sender&apos;s documents.</b> You marked one of our emails for them as spam, so we stopped: no reminders, and no copy by email when one is completed. This link still opens the document whenever you like.</p>
      {asking && <p style={{ margin: '8px 0 0' }}>We emailed a code to <b style={{ overflowWrap: 'anywhere' }}>{sentTo}</b>, to be sure it is you. It works for 30 minutes. Not there? Look in your spam folder, and mark it as not spam.</p>}
      {error && <p role="alert" style={{ margin: '8px 0 0' }}>{error}</p>}
      {asking ? (
        <form onSubmit={(e) => (e.preventDefault(), call({ code }, 'sent'))} style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
          <label className="f" style={{ margin: 0, flex: '1 1 160px' }}><span>Code from the email</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={12} style={{ minHeight: 44 }} required />
          </label>
          <button type="submit" className="btn sm" style={{ minHeight: 44 }} disabled={state === 'busy' || !code.trim()}>{state === 'busy' ? 'Checking…' : 'Start emails again'}</button>
          <button type="button" className="btn sm ghost" style={{ minHeight: 44 }} disabled={state === 'busy'} onClick={() => call({}, 'sent')}>Send a new code</button>
        </form>
      ) : (
        <button type="button" className="btn sm" style={{ minHeight: 44, marginTop: 10 }} disabled={state === 'busy'} onClick={() => call({}, '')}>{state === 'busy' ? 'Sending…' : 'Email me about these documents again'}</button>
      )}
    </div>
  );
}
