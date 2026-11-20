'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { api, fmtDate, ROLE_LABEL } from '@/components/ui';
import { DISPUTE_DOES, disputeSenderSees } from '@/lib/evidence';

type Genuine = { genuine: true; replaced?: false; sender: { name: string; email: string } | null; account?: string; paused: boolean; subject: string; status: string; sent_at: string | null; for_name: string; role: string; url: string };
// An email we really sent whose link was replaced afterwards. It is genuine and is said to be, without a link to open.
type Replaced = { genuine: true; replaced: true; why: string; replaced_at: string | null; for_name: string | null; sender: { name: string; email: string } | null; account?: string; paused: boolean; subject: string | null; status: string | null };
// An email we really sent about a document that has been deleted since. Only that much is still known.
// can_report is false when the sender's account was deleted too: then nobody is left to file a report against.
type Deleted = { genuine: true; deleted: true; replaced?: false; deleted_at: string; can_report?: boolean };
type Answer = Genuine | Replaced | Deleted | { genuine: false };

// Why the link in a genuine email stopped working, said for the person who is holding that email.
const REPLACED_WHY: Record<string, (who: string) => string> = {
  address: (who) => `After it was sent, ${who} changed the email address this document goes to.`,
  role: (who) => `After it was sent, ${who} changed what the person it was sent to is asked to do with the document.`,
  handed: () => 'After it was sent, the person it was sent to passed the document on to someone else to sign.',
  removed: (who) => `After it was sent, ${who} took the person it was sent to off the document.`,
};

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

// Reporting the email a code came from. It needs the code and nothing else, so nobody has to open a link they do
// not trust in order to report it. It counts exactly like "Report this request" on the signing page.
const REPORT_REASONS: [string, string][] = [
  ['phishing', 'It looks like a scam: it asks for money or passwords, or pretends to be someone else'],
  ['spam', 'It is spam: I did not ask for this and do not know the sender'],
  ['not-for-me', 'It is not meant for me: it was sent to the wrong person'],
  // A dispute, not a report: POST /public/check/dispute marks the envelope and tells its sender (src/server/evidence.ts).
  ['not-me', 'I did not sign this, or this was not me'],
  ['other', 'Something else'],
];
// `sender` is the name the sender is known by, for what a dispute shows them. `dispute: false` where nothing is left
// to mark (a document deleted before anyone disputed it), so the choice is not offered at all.
function ReportEmail({ code, startOpen, sender, dispute = true }: { code: string; startOpen: boolean; sender?: string | null; dispute?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const [state, setState] = useState<'' | 'busy' | 'sent'>('');
  const [error, setError] = useState('');

  async function send(e: FormEvent) {
    e.preventDefault();
    if (state === 'busy') return;
    if (!reason) return setError('Choose what is wrong, then send your report.');
    setState('busy');
    setError('');
    try {
      await (reason === 'not-me' ? api('/public/check/dispute', { body: { code: clean(code), detail } }) : api('/public/check/report', { body: { code: clean(code), reason, detail } }));
      setState('sent');
    } catch (err: any) {
      setState('');
      setError(!err?.status ? 'We could not reach GrowSigning, so your report was not sent. Check your connection and try again.'
        : err.status === 429 ? 'That is a lot of reports in a short time, and this one was not sent. Wait an hour and try again, or use the contact form on the help page.'
        : err.message);
    }
  }

  if (state === 'sent' && reason === 'not-me')
    return <div className="notice" role="status" style={{ marginTop: 16 }}><b>Your dispute is on record.</b> The document is now marked as disputed, for its sender and for anyone who checks it on our Verify page. {sender || 'The sender'} has been told, with what you wrote, and so have the people who run GrowSigning. Nothing was deleted. We do not decide who is right. To hear from a person, write to us on the <Link href="/help?topic=not-me#contact">help page</Link> with the topic &ldquo;I am named on a document I did not sign&rdquo;.</div>;
  if (state === 'sent')
    return <div className="notice" role="status" style={{ marginTop: 16 }}><b>Thank you. Your report is in.</b> You do not need to do anything else. If the email looks like a scam, do not sign it, do not reply to it and do not call any number it gives.</div>;
  if (!open)
    return (
      <p className="muted small" style={{ marginTop: 16 }}>
        <b>Not expecting this?</b> A real email can still be one you did not ask for, and you do not have to sign. <button type="button" className="linklike" onClick={() => setOpen(true)}>Report this email</button> without opening the document.
      </p>
    );
  return (
    <form onSubmit={send} noValidate style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
      <h3 style={{ fontSize: 17, margin: '0 0 6px' }}>{reason === 'not-me' ? 'Dispute this document' : 'Report this email'}</h3>
      {/* A dispute is not a report: it goes to the sender as well, and it never pauses anyone's account. */}
      <p className="muted small" style={{ margin: '0 0 12px' }}>{reason === 'not-me' ? 'You do not have to open the document. A dispute goes to the sender and to the people who run GrowSigning, and it does not pause anyone\'s account. Read below what each of them gets.' : 'You do not have to open the document. The report goes to the people who run GrowSigning, and when several people report the same sender, sending from that account is paused.'}</p>
      <label className="f"><span>What is wrong?</span>
        <select value={reason} onChange={(e) => (setReason(e.target.value), setError(''))} aria-invalid={!!error && !reason}>
          <option value="">Choose one</option>
          {REPORT_REASONS.filter(([value]) => dispute || value !== 'not-me').map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {reason === 'not-me' && <div className="small" id="check-dispute-sees" style={{ margin: '-4px 0 12px' }}><p style={{ margin: '0 0 6px' }}>This is for something that was signed, approved, declined or passed on in your name that you did not do, also on a completed document, and also when the sender changed the address after this email. {DISPUTE_DOES}</p><p style={{ margin: 0 }}>{disputeSenderSees(sender || 'The sender')}</p></div>}
      <label className="f"><span>{reason === 'not-me' ? <>What happened, in your words <span className="hint">(optional; {sender || 'the sender'} will read it)</span></> : <>Anything else we should know <span className="hint">(optional)</span></>}</span><textarea rows={3} maxLength={2000} value={detail} onChange={(e) => setDetail(e.target.value)} {...(reason === 'not-me' ? { 'aria-describedby': 'check-dispute-sees' } : {})} /></label>
      {error && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="pub-actions-row" style={{ marginTop: 0 }}>
        <button className="btn primary" disabled={state === 'busy'}>{state === 'busy' ? 'Sending' : reason === 'not-me' ? 'Send dispute' : 'Send report'}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

export function CheckForm() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState<(Answer & { code: string }) | null>(null);
  const result = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const [wantReport, setWantReport] = useState(false);

  // A code can arrive in the address: /check?code=ABCD-EFGH-JKLM. "Report this email" in a signing email adds
  // report=1: the code is looked up straight away and the report form is open, so reporting takes one more click.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const given = q.get('code');
    if (given) setCode(pretty(given));
    if (q.get('report') !== '1') return;
    setWantReport(true);
    if (given && clean(given).length === LENGTH) lookup(clean(given));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
    await lookup(clean(code));
  }

  async function lookup(wanted: string) {
    setBusy(true);
    setError('');
    try {
      const r = await api<Answer>('/public/check', { body: { code: wanted } });
      setAnswer({ ...r, code: pretty(wanted) });
    } catch (err: any) {
      setError(!err?.status ? 'We could not reach GrowSigning. Check your connection and try again.'
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

      {answer?.genuine && answer.replaced && (
        <div ref={result} tabIndex={-1} role="status" className="card pub-verdict good pub-focus" style={{ marginTop: 18 }}>
          <span className="badge completed">Genuine</span>
          <h2>This email was real, but its link has been replaced</h2>
          <p>Code {answer.code} belongs to an email that GrowSigning really sent{answer.for_name ? ` to ${answer.for_name}` : ''}{answer.subject ? `, about "${answer.subject}"` : ''}. It is not a fake.</p>
          <p>{(REPLACED_WHY[answer.why] || REPLACED_WHY.address)(answer.sender?.name || 'the sender')} That is why the link in that email no longer opens the document{answer.replaced_at ? `. It stopped working on ${fmtDate(answer.replaced_at, true)}` : ''}.</p>
          <p><b>What to do.</b> If you are still meant to sign, look for a newer email about this document and use that one. If there is none, {answer.sender?.email ? <>ask {answer.sender.name} at {answer.sender.email}</> : 'ask the person who sent it'} whether anything is still needed from you. Opening the old link is safe: it only says that it was replaced.</p>
          {answer.paused && <div className="notice warn" style={{ marginBottom: 14 }}><b>Take care with this one.</b> Sending from this account is paused until a person at GrowSigning has reviewed it. Check with the sender another way before you sign anything from them.</div>}
          <div className="pub-actions-row">
            <button type="button" className="btn primary" onClick={again}>Check another code</button>
            <Link href="/help?topic=signing#contact" className="btn">Ask us about this email</Link>
          </div>
          <ReportEmail key={answer.code} code={answer.code} startOpen={wantReport} sender={answer.sender?.name} />
        </div>
      )}

      {answer?.genuine && 'deleted' in answer && (
        <div ref={result} tabIndex={-1} role="status" className="card pub-verdict good pub-focus" style={{ marginTop: 18 }}>
          <span className="badge completed">Genuine</span>
          <h2>This email was real, but the document has been deleted</h2>
          <p>Code {answer.code} belongs to an email that GrowSigning really sent. It is not a fake.</p>
          <p>The document it was about was deleted on {fmtDate(answer.deleted_at, true)}, by its sender or together with the sender&apos;s account. When a document is deleted we delete what we knew about it too, so we can no longer tell you who sent it or what it was called. That is why the link in the email no longer opens anything.</p>
          <p><b>What to do.</b> There is nothing left to sign. If you were expecting this document, ask the person who sent it whether they will send it again. If you had already signed it, the copy that was emailed to you when it was completed is yours to keep.</p>
          {answer.can_report === false
            ? <p>The account that sent it has been deleted as well, so there is nobody left to file a report against. If the email worries you, use &ldquo;Ask us about this email&rdquo; below and tell us what it says: a person will look into it.</p>
            : <p>If the email looked wrong to you, you can still report it below. We no longer know who it was sent to, but we do know which account sent it, and your report is filed against that account, the same as a report about a document that still exists.</p>}
          <div className="pub-actions-row">
            <button type="button" className="btn primary" onClick={again}>Check another code</button>
            <Link href="/help?topic=signing#contact" className="btn">Ask us about this email</Link>
          </div>
          {answer.can_report !== false && <ReportEmail key={answer.code} code={answer.code} startOpen={wantReport} dispute={false} />}
        </div>
      )}

      {answer?.genuine && !answer.replaced && !('deleted' in answer) && (
        <div ref={result} tabIndex={-1} role="status" className="card pub-verdict good pub-focus" style={{ marginTop: 18 }}>
          <span className="badge completed">Genuine</span>
          <h2>This email is real</h2>
          <p>Code {answer.code} belongs to an email that GrowSigning sent. Compare these details with the email you received.</p>
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
          {answer.paused && <div className="notice warn" style={{ marginBottom: 14 }}><b>Take care with this one.</b> The email did come from GrowSigning, but sending from this account is paused until a person at GrowSigning has reviewed it. Check with the sender another way before you sign.</div>}
          <div className="pub-actions-row">
            <a href={answer.url} className="btn primary lg">Open the document</a>
            <button type="button" className="btn" onClick={again}>Check another code</button>
          </div>
          <p className="muted small" style={{ marginTop: 16 }}>The email address is the part we confirmed: the sender proved it is theirs before sending. The names are what the sender typed.</p>
          <ReportEmail key={answer.code} code={answer.code} startOpen={wantReport} sender={answer.sender?.name} />
        </div>
      )}

      {answer && !answer.genuine && (
        <div ref={result} tabIndex={-1} role="status" className="card pub-verdict bad pub-focus" style={{ marginTop: 18 }}>
          <span className="badge declined">Not recognised</span>
          <h2>We do not recognise this code</h2>
          <p>Code {answer.code} does not match any email we have on record. First check that you typed it exactly as it appears.</p>
          <p><b>If it still does not match, treat the email as fake.</b> Do not click anything in it, do not open its attachments and do not call any number it gives. Then tell us about it, and a person will look into it.</p>
          <div className="pub-actions-row">
            <Link href="/help?topic=suspicious#contact" className="btn primary">Tell us about this email</Link>
            <button type="button" className="btn" onClick={again}>Try the code again</button>
          </div>
          <p className="muted small" style={{ marginTop: 16 }}>A code stays on record when the sender corrects an address, changes who signs or takes someone off a document, and for a year after a document is deleted, so those emails are still recognised here.</p>
        </div>
      )}
    </>
  );
}
