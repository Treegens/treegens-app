'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/components/ui';
import { Icon, Sender } from './parts';
import { CALL_ME } from '@/lib/channels';

// The screen that asks for a one-time code before a document opens. The sender chose it: a code by email, or by
// text message to a number they typed. Whoever holds the link sees this, and they may not be the person the
// document is for, so nothing here names the document and the address or number is only ever shown masked (the
// server sends it that way). The rules are the server's (src/server/signercode.ts): this screen only says them.

export type CodeState = {
  kind: 'email_code' | 'sms_code';
  to: string; // masked: "j***@example.com" or "+44 *** *** 4321"
  minutes: number;
  digits: number;
  sent: boolean;
  resend_in: number;
  tries_left: number;
  stopped: boolean;
  shared?: boolean; // the sender passed this link on themselves: we never emailed this person
  call?: boolean; // this server can call the number and read the code out instead (src/server/voice.ts)
  by?: 'text' | 'call'; // how the code that works now reached them
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const howLong = (seconds: number) => (seconds < 90 ? plural(seconds, 'second') : plural(Math.ceil(seconds / 60), 'minute'));

export function CodeCheck({ base, check, env, brand, onOpen }: { base: string; check: CodeState; env: any; brand?: any; onOpen: () => Promise<void> | void }) {
  const sender = env.sender || { name: 'the sender', email: '' };
  const byText = check.kind === 'sms_code';
  const what = byText ? 'text message' : 'email';
  const [sent, setSent] = useState(check.sent);
  const [heard, setHeard] = useState(check.by === 'call'); // the newest code was read out on a call
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'' | 'send' | 'call' | 'check' | 'no_code' | 'not_mine'>('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [stopped, setStopped] = useState(check.stopped);
  const [trouble, setTrouble] = useState(false);
  const [told, setTold] = useState<'' | 'no_code' | 'not_mine'>('');
  // When a new code can be asked for: a moment on this device's clock, counted down once a second.
  const [until, setUntil] = useState(() => Date.now() + check.resend_in * 1000);
  const [left, setLeft] = useState(check.resend_in);
  const input = useRef<HTMLInputElement>(null);
  const problem = useRef<HTMLDivElement>(null);
  const toldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [until]);
  // An error is read out and brought into view, also on a phone where the keyboard covers half the screen.
  useEffect(() => {
    if (error) problem.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  // "We told the sender" replaces the button that was pressed. Reading goes on from that sentence, not from nowhere.
  useEffect(() => {
    if (told) toldRef.current?.focus();
  }, [told]);

  const waitFrom = (e: any) => {
    const s = Number(e?.data?.resend_in);
    if (Number.isFinite(s) && s > 0) setUntil(Date.now() + s * 1000);
  };

  // "Call me with the code": the same code rules, read out on a call to the same number (a landline, or for someone who cannot read a text).
  async function send(by: 'text' | 'call' = 'text') {
    setBusy(by === 'call' ? 'call' : 'send');
    setError('');
    setNote('');
    try {
      const r = await api(by === 'call' ? `${base}/code/call` : `${base}/code`, { method: 'POST' });
      // This browser passed already (another tab did it): simply open the document.
      if (r?.passed) return void (await onOpen());
      setUntil(Date.now() + (r.resend_in || 60) * 1000);
      setCode('');
      // A call is said once, in the line under the heading; the note only adds what is new.
      setNote(`${by === 'call' ? '' : `${sent ? 'A new code' : 'A code'} is on its way to ${check.to}. `}${sent ? 'Only the new one works now.' : ''}${r.delivery === 'outbox' ? ' This is a development server: it was not really sent, and you can read it in the outbox at /dev/outbox.' : ''}`.trim());
      setSent(true);
      setHeard(by === 'call');
      window.setTimeout(() => input.current?.focus(), 50);
    } catch (e: any) {
      waitFrom(e);
      if (e?.code === 'stopped') setStopped(true);
      // A plain "too many attempts" from the general limit on a link names neither a time nor a person. Say both.
      setError(e?.status === 429 && !e?.code ? `This link was used too often in a short time. Wait 10 minutes, then try again. If you need help, you can reach ${sender.name}: ${sender.email}.`
        : e?.message || `We could not send the code. Try again in a minute. If it keeps happening, tell ${sender.name}: ${sender.email}.`);
    } finally {
      setBusy('');
    }
  }

  async function open(e: React.FormEvent) {
    e.preventDefault();
    const digits = code.replace(/\D/g, '');
    if (digits.length !== check.digits) return setError(`The code has ${check.digits} digits. Type all of them.`);
    setBusy('check');
    setError('');
    setNote('');
    try {
      await api(`${base}/code/check`, { body: { code: digits } });
      await onOpen();
    } catch (err: any) {
      setError(err?.status === 429 && !err?.code ? `This link was used too often in a short time. Wait 10 minutes, then try again. If you need help, you can reach ${sender.name}: ${sender.email}.`
        : err?.message || `Something went wrong on our side. Try again in a minute. If it keeps happening, tell ${sender.name}: ${sender.email}.`);
      // A code that no longer works (used up, too old, replaced) is taken out of the box, so the next thing typed is the new one.
      if (['spent', 'expired', 'no_code'].includes(err?.code)) setCode('');
      input.current?.focus();
    } finally {
      setBusy('');
    }
  }

  async function tell(which: 'no_code' | 'not_mine') {
    setBusy(which);
    setError('');
    try {
      const r = await api(`${base}/code/problem`, { body: { what: which } });
      setTold(which);
      if (r?.stopped) setStopped(true);
    } catch (e: any) {
      setError(e?.status === 429 ? `You have already told ${sender.name} today. You can also write to them yourself: ${sender.email}.` : `${e?.message || 'We could not send that.'} You can also write to ${sender.name} yourself: ${sender.email}.`);
    } finally {
      setBusy('');
    }
  }

  const again = left > 0
    ? <p className="muted small sg-code-when">You can ask for a new code in {howLong(left)}.</p>
    : null;
  const toldNote = told && (
    <div ref={toldRef} className="notice sg-confirmed" role="status" tabIndex={-1}>
      <b>Done. We told {sender.name}.</b>{' '}
      {told === 'not_mine'
        ? `No more codes go to ${check.to}. Only ${sender.name} can fix this: they have to put in your number, or choose another way to check that it is you. Until they have, this document stays closed.`
        : `Only ${sender.name} can fix this: they can correct the ${byText ? 'number' : 'address'} or choose another way to check that it is you. Until they have, this document stays closed.`}
      {' '}You do not need to keep this page open. {check.shared ? `The link ${sender.name} gave you keeps working.` : 'The link in your email keeps working.'}
    </div>
  );

  // Someone using this link said the number is not theirs. Nothing more is sent to it, and only the sender can change it.
  if (stopped)
    return (
      <div className="card sg-narrow sg-code">
        <div className="sg-state-icon warn"><Icon name="lock" size={26} /></div>
        <h1 className="serif" id="sg-h1" tabIndex={-1}>We stopped sending codes to this number</h1>
        <p>Someone using a link from {sender.name} told us that {check.to} is not their number, so no more codes go to it. That leaves whoever owns the number alone.</p>
        <p>{sender.name} has been told and has to put in the right number. Until they have, this document cannot be opened. There is nothing you need to do on this page.</p>
        {toldNote}
        <Sender env={env} brand={brand} lead="Ask" />
      </div>
    );

  return (
    <form className="card sg-narrow sg-code" noValidate onSubmit={sent ? open : (e) => (e.preventDefault(), send())}>
      <div className="sg-state-icon lock"><Icon name={byText ? 'lock' : 'mail'} size={26} /></div>
      <h1 className="serif" id="sg-h1" tabIndex={-1}>{!sent ? 'First, a quick check that it is you' : heard ? 'Type the code from the call' : 'Type the code we sent you'}</h1>
      {sent ? (
        heard
          ? <p>We are calling <b className="sg-code-to">{check.to}</b> now. The call reads the {check.digits}-digit code out twice. It works for {check.minutes} minutes.</p>
          : <p>We sent a {check.digits}-digit code by {what} to <b className="sg-code-to">{check.to}</b>. It works for {check.minutes} minutes.</p>
      ) : (
        <p>{sender.name} asked us to check who opens this document. We send a {check.digits}-digit code by {what} to <b className="sg-code-to">{check.to}</b>, and you type it in here.</p>
      )}

      {sent && (
        <label className="f sg-code-box">
          <span>{heard ? 'Code from the call' : `Code from the ${what}`}</span>
          <input ref={input} className="sg-code-input" value={code} onChange={(e) => (setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, check.digits + 2)), setError(''))}
            inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" enterKeyHint="go" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            autoFocus aria-invalid={!!error} aria-describedby="sg-code-says" />
        </label>
      )}
      <div id="sg-code-says" ref={problem}>
        {error && <div className="notice err sg-problem" role="alert">{error}</div>}
        {!error && note && <div className="notice sg-problem" role="status">{note}</div>}
      </div>

      {sent ? (
        <>
          <button className="btn primary lg" disabled={!!busy}>{busy === 'check' ? 'Checking' : 'Open document'}</button>
          <button type="button" className="btn lg sg-code-again" disabled={!!busy || left > 0} onClick={() => send()}>{busy === 'send' ? 'Sending' : 'Send a new code'}</button>
          {byText && check.call && <button type="button" className="btn lg sg-code-again" disabled={!!busy || left > 0} onClick={() => send('call')}>{busy === 'call' ? 'Calling' : CALL_ME}</button>}
          {again}
        </>
      ) : (
        <>
          <button className="btn primary lg" disabled={!!busy || left > 0}>{busy === 'send' ? 'Sending' : 'Send me the code'}</button>
          {again}
        </>
      )}

      {toldNote || (
        <div className="sg-code-trouble">
          <button type="button" className="sg-link sg-code-toggle" aria-expanded={trouble} aria-controls="sg-code-help" onClick={() => setTrouble(!trouble)}>{!sent ? 'Cannot get a code this way?' : heard ? 'No call came?' : 'The code does not arrive?'}</button>
          {trouble && (
            <div id="sg-code-help" className="sg-code-help">
              {byText ? (
                <>
                  <p>{heard ? 'A call can take a minute. Check that the line is free and that your number ends in the digits shown above.' : 'A text can take a minute. Check that your phone has a signal and that your number ends in the digits shown above.'}</p>
                  {/* A landline cannot get a text: before any code is sent, the call is offered here, not next to "Send me the code". */}
                  {!sent && check.call && <div className="sg-code-outs"><button type="button" className="btn" disabled={!!busy || left > 0} onClick={() => send('call')}>{busy === 'call' ? 'Calling' : 'I have a landline: call me with the code'}</button></div>}
                  <p>If it still does not come, or the number is not yours, tell {sender.name}. They typed the number, and only they can change it or choose another way to check that it is you. We cannot change it for you.</p>
                  <div className="sg-code-outs">
                    <button type="button" className="btn" disabled={!!busy} onClick={() => tell('no_code')}>{busy === 'no_code' ? 'Telling them' : 'I do not get the code'}</button>
                    <button type="button" className="btn" disabled={!!busy} onClick={() => tell('not_mine')}>{busy === 'not_mine' ? 'Telling them' : 'This is not my number'}</button>
                  </div>
                  <p className="muted small">After &ldquo;This is not my number&rdquo; we stop sending codes to it at once.</p>
                </>
              ) : (
                <>
                  <p>The code goes to the same mailbox as the email with this link. It can take a minute, and it may be in the spam folder.</p>
                  <p>If it still does not come, tell {sender.name}. Only they can correct the address or choose another way to check that it is you. We cannot change it for you.</p>
                  <div className="sg-code-outs">
                    <button type="button" className="btn" disabled={!!busy} onClick={() => tell('no_code')}>{busy === 'no_code' ? 'Telling them' : 'I do not get the code'}</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
      <Sender env={env} brand={brand} />
    </form>
  );
}
