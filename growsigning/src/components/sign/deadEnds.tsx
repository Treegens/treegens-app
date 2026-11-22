'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/components/ui';
import { Shell, StateCard, helpHref } from './parts';

// Links that cannot be opened. None of these is a dead end: each one offers the way forward itself.

function Done({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return <div ref={ref} tabIndex={-1} className={`notice sg-confirmed${warn ? ' warn' : ''}`} role="status">{children}</div>;
}

// What "Email me the current link" really did, in words. Only 'sent' says sent. The others say plainly that no
// email is coming, or not yet, and what to do. None of them tells the holder of an old link more than the emails
// they were sent did: no names, no addresses, and not which of the ways of closing a document it was.
const NOT_SENT: Record<string, [string, string]> = {
  delayed: ['Not sent yet.', 'We could not hand the email to the mail server just now. We keep trying for about a day, and it goes to the address this document is assigned to now. If nothing has arrived by tomorrow, reply to the email this link came in and ask the sender to send it again.'],
  waiting: ['Nothing was sent, because it is not this person\'s turn yet.', 'Others sign first. The current link is emailed to the address this document is assigned to as soon as it is their turn. There is nothing to do until then.'],
  removed: ['There is no current link to send.', 'The person this link was for is no longer on the document: the sender changed it after this link was made. There is nothing more for you to do. If you think you should still sign, reply to the email this link came in and ask the sender.'],
  closed: ['There is no current link to send.', 'This document is no longer open for signing: it was cancelled, declined or ran out of time. There is nothing more for you to do. If you think that is a mistake, reply to the email this link came in and ask the sender.'],
  // The person it is with now gets no email from us: the sender passes their link on (src/lib/bysender.ts).
  ask_sender: ['Nothing was sent.', 'We cannot email the current link for this document. Ask the sender for it, the way they reached you before.'],
  unknown: ['We found no current link for this one.', 'Open the link from the newest email about this document. If you cannot find it, use the Help link below: Find my documents sends every document for your address again.'],
};

/** 410: the sender corrected the document or it was passed on, so a newer link exists. */
export function ReplacedLink({ token }: { token: string }) {
  const [state, setState] = useState<'' | 'busy' | 'sent'>('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  async function resend() {
    setState('busy');
    setError('');
    try {
      const r = await api('/public/links/resend', { body: { token } });
      setResult(r?.sent ? 'sent' : NOT_SENT[r?.result] ? r.result : 'unknown');
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
        {state === 'sent' && result !== 'sent' ? (
          <Done warn><b>{NOT_SENT[result][0]}</b> {NOT_SENT[result][1]}</Done>
        ) : state === 'sent' ? (
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
        <p className="muted small sg-after">Still stuck? <a href={helpHref(undefined, 'contact')}>Get help from a person</a>. If you have the email this link came in, the form there asks for its security code, so we know which document you mean.</p>
        {/* The person this link was sent to can still dispute what was done in their place (disputeReplaced in src/server/evidence.ts). */}
        <p className="muted small" style={{ marginTop: 12 }}>Was something signed or passed on in your name that you did not do? The security code in the email this link came in still works for that: type it on our <a href="/check?report=1">check page</a> and choose &ldquo;I did not sign this, or this was not me&rdquo;.</p>
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
        <p className="muted small sg-after">Still stuck? <a href={helpHref(undefined, 'contact')}>Get help from a person</a>. If you have the email this link came in, the form there asks for its security code, so we know which document you mean.</p>
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
        <p className="muted small sg-after">Still stuck? <a href={helpHref(undefined, 'contact')}>Get help from a person</a>. If you have the email this link came in, the form there asks for its security code, so we know which document you mean.</p>
      </StateCard>
    </Shell>
  );
}
