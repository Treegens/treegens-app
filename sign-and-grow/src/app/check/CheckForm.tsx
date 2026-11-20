'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { api, fmtDate, ROLE_LABEL } from '@/components/ui';

type Genuine = { genuine: true; sender: { name: string; email: string } | null; account?: string; paused: boolean; subject: string; status: string; sent_at: string | null; for_name: string; role: string; url: string };
type Answer = Genuine | { genuine: false };

const LENGTH = 12;
// Same reading as the server: letters and numbers only, any case, dashes and spaces ignored.
const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const pretty = (s: string) => clean(s).slice(0, LENGTH).replace(/(.{4})(?=.)/g, '$1-');

// What the envelope's state means for the person holding the email.
const STATE: Record<string, string> = {
  sent: 'Open and waiting for signatures',
  completed: 'Completed. Everyone has finished.',
  voided: 'Voided by the sender. There is nothing to sign.',
  expired: 'The deadline has passed. Open it to ask the sender for more time.',
  declined: 'Declined. This document is closed.',
};

export function CheckForm() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState<(Answer & { code: string }) | null>(null);
  const result = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // A code can arrive in the address: /check?code=ABCD-EFGH-JKLM
  useEffect(() => {
    const given = new URLSearchParams(window.location.search).get('code');
    if (given) setCode(pretty(given));
  }, []);
  useEffect(() => {
    if (answer) result.current?.focus();
  }, [answer]);

  const typed = clean(code).length;

  async function check(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setAnswer(null);
    if (typed !== LENGTH) {
      setError(typed === 0 ? 'Type the security code from the email first. It is in a box near the bottom.' : `A security code has ${LENGTH} letters and numbers, like ABCD-EFGH-JKLM. You have typed ${typed}. Check the email and try again.`);
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api<Answer>('/public/check', { body: { code: clean(code) } });
      setAnswer({ ...r, code: pretty(code) });
    } catch (err: any) {
      setError(!err?.status ? 'We could not reach Sign&Grow. Check your connection and try again.'
        : err.status === 429 ? 'That is a lot of codes in a short time. Wait an hour and try again, or use the help page to reach a person.'
        : err.message);
    } finally {
      setBusy(false);
    }
  }

  function again() {
    setAnswer(null);
    setCode('');
    setError('');
    setTimeout(() => input.current?.focus(), 0);
  }

  return (
    <>
      <form className="card pub-check-form" onSubmit={check} noValidate>
        <label className="f" style={{ marginBottom: 0 }}>
          <span>Security code</span>
          <input
            ref={input} className="pub-code" value={code}
            onChange={(e) => (setCode(e.target.value.slice(0, 24)), setError(''))}
            onBlur={() => setCode((c) => (clean(c).length ? pretty(c) : c))}
            placeholder="ABCD-EFGH-JKLM" autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
            aria-describedby="check-hint" aria-invalid={!!error}
          />
        </label>
        <p id="check-hint" className="muted small" style={{ margin: '8px 0 14px' }}>{LENGTH} letters and numbers. Dashes, spaces and capitals do not matter.</p>
        {error && <div className="notice err" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
        <button className="btn primary lg" disabled={busy}>{busy ? 'Checking' : 'Check this code'}</button>
      </form>

      {answer?.genuine && (
        <div ref={result} tabIndex={-1} role="status" className="card pub-verdict good pub-focus" style={{ marginTop: 18 }}>
          <span className="badge completed">Genuine</span>
          <h2>This email is real</h2>
          <p>Code {answer.code} belongs to an email that Sign&Grow sent. Compare these details with the email you received.</p>
          <dl className="pub-facts">
            <dt>Sent by</dt>
            <dd>{answer.sender?.name || 'The sender'}{answer.sender?.email && <small>{answer.sender.email}{answer.account ? `, ${answer.account}` : ''}</small>}</dd>
            <dt>Sent to</dt>
            <dd>{answer.for_name}<small>{ROLE_LABEL[answer.role] || answer.role}</small></dd>
            <dt>Document</dt>
            <dd>{answer.subject}</dd>
            {answer.sent_at && <><dt>Sent on</dt><dd>{fmtDate(answer.sent_at, true)}</dd></>}
            <dt>Right now</dt>
            <dd>{STATE[answer.status] || answer.status}</dd>
          </dl>
          {answer.paused && <div className="notice warn" style={{ marginBottom: 14 }}><b>Take care with this one.</b> The email did come from Sign&Grow, but sending from this account is paused while a person reviews reports from other recipients. Check with the sender another way before you sign.</div>}
          <div className="pub-actions-row">
            <a href={answer.url} className="btn primary lg">Open the document</a>
            <button type="button" className="btn" onClick={again}>Check another code</button>
          </div>
          <p className="muted small" style={{ marginTop: 16 }}>
            <b>Not expecting this?</b> A real email can still be one you did not ask for. You do not have to sign. Open the document and choose &quot;Report this request&quot;, or <Link href="/help?topic=suspicious#contact">tell us here</Link>. Every report goes to a person.
          </p>
        </div>
      )}

      {answer && !answer.genuine && (
        <div ref={result} tabIndex={-1} role="status" className="card pub-verdict bad pub-focus" style={{ marginTop: 18 }}>
          <span className="badge declined">Not recognised</span>
          <h2>We do not recognise this code</h2>
          <p>Code {answer.code} does not match any email we have sent. First check that you typed it exactly as it appears.</p>
          <p><b>If it still does not match, treat the email as fake.</b> Do not click anything in it, do not open its attachments and do not call any number it gives. Then tell us about it, and a person will look into it.</p>
          <div className="pub-actions-row">
            <Link href="/help?topic=suspicious#contact" className="btn primary">Tell us about this email</Link>
            <button type="button" className="btn" onClick={again}>Try the code again</button>
          </div>
          <p className="muted small" style={{ marginTop: 16 }}>One harmless reason for a mismatch: the sender corrected the document and you were sent a newer email. If you have a later email about the same document, check the code in that one.</p>
        </div>
      )}
    </>
  );
}
