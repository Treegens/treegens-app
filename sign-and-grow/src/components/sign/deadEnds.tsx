'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/components/ui';
import { Shell, StateCard } from './parts';

// Links that cannot be opened. None of these is a dead end: each one offers the way forward itself.

function Done({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return <div ref={ref} tabIndex={-1} className="notice sg-confirmed" role="status">{children}</div>;
}

/** 410: the sender corrected the document or it was passed on, so a newer link exists. */
export function ReplacedLink({ token }: { token: string }) {
  const [state, setState] = useState<'' | 'busy' | 'sent'>('');
  const [error, setError] = useState('');
  async function resend() {
    setState('busy');
    setError('');
    try {
      await api('/public/links/resend', { body: { token } });
      setState('sent');
    } catch (e: any) {
      setError(`${e?.message || 'Something went wrong on our side.'} If it keeps happening, use the Help link below and a person will sort it out.`);
      setState('');
    }
  }
  return (
    <Shell>
      <StateCard tone="link" title="This link was replaced by a newer one">
        <p>The document was updated or passed to someone else after this link was made, so this one no longer opens it. Nothing is lost.</p>
        {state === 'sent' ? (
          <Done>
            <b>Sent.</b> The current link is on its way to the email address this document is assigned to now. It can take a minute, and it is worth checking the spam folder. If the document was passed to someone else, they have it and there is nothing more for you to do.
          </Done>
        ) : (
          <>
            <p className="muted">We can email the current link to the address this document is assigned to now.</p>
            {error && <div className="notice err sg-problem" role="alert">{error}</div>}
            <button type="button" className="btn primary lg" onClick={resend} disabled={state === 'busy'}>{state === 'busy' ? 'Sending' : 'Email me the current link'}</button>
          </>
        )}
        <p className="muted small sg-after">Still stuck? <a href="/help">Get help from a person</a>.</p>
      </StateCard>
    </Shell>
  );
}

/** 404: we have never seen this link, usually because it was cut short when copied. */
export function UnknownLink() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'' | 'busy' | 'sent'>('');
  const [error, setError] = useState('');
  async function find(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return setError('Enter the email address the document was sent to.');
    setState('busy');
    setError('');
    try {
      await api('/public/links/find', { body: { email } });
      setState('sent');
    } catch (e: any) {
      setError(e?.message || 'Something went wrong on our side. Try again in a minute.');
      setState('');
    }
  }
  return (
    <Shell>
      <StateCard tone="link" title="We do not recognise this link">
        <p>It may have been cut short when it was copied. Try opening it again straight from the email.</p>
        {state === 'sent' ? (
          <Done>
            <b>Check your inbox.</b> If any documents are waiting for {email.trim()}, we have just emailed a link to each one. It can take a minute, and it is worth checking the spam folder.
          </Done>
        ) : (
          <form className="sg-find" onSubmit={find} noValidate>
            <p className="muted">Or enter your email address and we will send you a link to every document that is waiting for you.</p>
            <label className="f"><span>Your email address</span><input type="email" autoComplete="email" autoCapitalize="off" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error} /></label>
            {error && <div className="notice err sg-problem" role="alert">{error}</div>}
            <button className="btn primary lg" disabled={state === 'busy'}>{state === 'busy' ? 'Sending' : 'Email me my documents'}</button>
          </form>
        )}
        <p className="muted small sg-after">Still stuck? <a href="/help">Get help from a person</a>.</p>
      </StateCard>
    </Shell>
  );
}

/** Anything else: a dropped connection, or a problem on our side. Trying again is nearly always enough. */
export function LoadProblem({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Shell>
      <StateCard tone="warn" title="We could not open this just now">
        <p>{message}</p>
        <p className="muted">Nothing is lost. Check your connection and try again.</p>
        <button type="button" className="btn primary lg" onClick={onRetry}>Try again</button>
        <p className="muted small sg-after">Still stuck? <a href="/help">Get help from a person</a>.</p>
      </StateCard>
    </Shell>
  );
}
