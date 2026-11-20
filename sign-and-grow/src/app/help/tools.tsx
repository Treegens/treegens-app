'use client';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '@/components/ui';
import { TOPIC_LABEL, STATUS_FOR_CUSTOMER, whenText, spanText, type CustomerRequest } from '@/lib/support';
import { RequestView } from './RequestView';
import type { ChatLine } from '@/lib/chat';

// The self-service tools on the help page. Every one of them works without logging in.

// Billing dates are written in the reader's own time zone, like the Plan page and our emails, so the three agree.
export const billDay = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

// Turns a failed call into a sentence that says what to do next. Errors without a status never reached the server.
const explain = (e: any, tooMany: string, byStatus: Record<number, string> = {}) =>
  !e?.status ? 'We could not reach Sign&Grow. Check your connection and try again.' : e.status === 429 ? tooMany : byStatus[e.status] || e.message;

function useAction<T>() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<T | null>(null);
  async function run(e: FormEvent, fn: () => Promise<T>, onError: (err: any) => string) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setDone(await fn());
    } catch (err) {
      setError(onError(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, done, run, reset: () => (setDone(null), setError('')) };
}

// Moves keyboard and screen reader focus to a result when it appears.
function useFocusWhen(on: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (on) ref.current?.focus();
  }, [on]);
  return ref;
}

function Result({ show, tone = '', children }: { show: boolean; tone?: '' | 'warn'; children: ReactNode }) {
  const ref = useFocusWhen(show);
  return <div ref={ref} tabIndex={-1} role="status" className={`notice pub-result ${tone}`}>{children}</div>;
}

// "I cannot find the email": sends every open or completed document to the inbox that asks for it.
export function FindDocuments() {
  const [email, setEmail] = useState('');
  const a = useAction<string>();
  if (a.done)
    return (
      <Result show>
        <p><b>Check the inbox of {a.done}.</b> If any documents were sent to that address, an email with a link to each one is on its way. Only that inbox receives it.</p>
        <p>Nothing after a few minutes? Look in the spam folder, then try the address the sender would have used.</p>
        <button type="button" className="pub-link" onClick={a.reset}>Try another address</button>
      </Result>
    );
  return (
    <form className="pub-form" onSubmit={(e) => a.run(e, async () => (await api('/public/links/find', { body: { email: email.trim() } }), email.trim()), (err) => explain(err, 'We have already sent the list to this address a few times in the last hour. Check the inbox and the spam folder, or try again in an hour.'))}>
      <div className="pub-form-row">
        <label className="f"><span>The email address the document was sent to</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com" /></label>
        <button className="btn primary" disabled={a.busy}>{a.busy ? 'Sending' : 'Find my documents'}</button>
      </div>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
    </form>
  );
}

// "I am being charged and cannot find where": emails every paid plan tied to the address, each with a stop link.
// "I wrote to you and lost the email": the private links to that address's requests are sent to it again.
export function FindRequests() {
  const [email, setEmail] = useState('');
  const a = useAction<string>();
  if (a.done)
    return (
      <Result show>
        <p><b>Check the inbox of {a.done}.</b> If anyone wrote to us from that address in the last 90 days, an email with the link to each request is on its way, except any request the address told us it did not write. Only that inbox receives it.</p>
        <p>Nothing after a few minutes? Look in the spam folder. If you wrote from another address, try that one. If nothing comes, write to us again with the form above and mention the reference if you still have it.</p>
        <button type="button" className="pub-link" onClick={a.reset}>Try another address</button>
      </Result>
    );
  return (
    <form className="pub-form" onSubmit={(e) => a.run(e, async () => (await api('/public/support/find', { body: { email: email.trim() } }), email.trim()), (err) => explain(err, 'We have already sent the links to this address a few times today. Check the inbox and the spam folder, or try again tomorrow.'))}>
      <div className="pub-form-row">
        <label className="f"><span>The email address you wrote to us from</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com" /></label>
        <button className="btn" disabled={a.busy}>{a.busy ? 'Sending' : 'Send me the links again'}</button>
      </div>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
    </form>
  );
}

export function FindSubscription({ label = 'Your email address' }: { label?: string }) {
  const [email, setEmail] = useState('');
  const a = useAction<string>();
  if (a.done)
    return (
      <Result show>
        <p><b>Check the inbox of {a.done}.</b> We sent a list of every paid plan tied to that address. Each one has a link that stops it, and the link works without logging in.</p>
        <p>If there is no paid plan under that address, the email says so. Then you are not being charged under it.</p>
        <button type="button" className="pub-link" onClick={a.reset}>Try another address</button>
      </Result>
    );
  return (
    <form className="pub-form" onSubmit={(e) => a.run(e, async () => (await api('/public/billing/find', { body: { email: email.trim() } }), email.trim()), (err) => explain(err, 'We have already emailed this address a few times in the last hour. Check the inbox and the spam folder, or try again in an hour.'))}>
      <div className="pub-form-row">
        <label className="f"><span>{label}</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com" /></label>
        <button className="btn primary" disabled={a.busy}>{a.busy ? 'Sending' : 'Find my subscription'}</button>
      </div>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
    </form>
  );
}

// Locked out of the mailbox as well, or no idea which address the account is under: prove you are the payer with
// the card that is being charged. Either the account's email address, or the date and amount of a charge.
export function StopByCard() {
  const [email, setEmail] = useState('');
  const [last4, setLast4] = useState('');
  const [noEmail, setNoEmail] = useState(false);
  const [on, setOn] = useState('');
  const [amount, setAmount] = useState('');
  const a = useAction<{ account?: string; ends_at: string; reference: string; ended_now?: boolean; why?: string; all?: { account?: string; reference: string }[] }>();
  if (a.done)
    return (
      <Result show>
        <p><b>Renewal stopped{a.done.all && a.done.all.length > 1 ? ` for ${a.done.all.length} plans paid with that card: ${a.done.all.map((x) => x.account).filter(Boolean).join(' and ')}` : a.done.account ? ` for ${a.done.account}` : ''}.</b> You will not be charged again.</p>
        <p>Reference <span className="pub-ref">{(a.done.all && a.done.all.length > 1 ? a.done.all.map((x) => x.reference) : [a.done.reference]).join(', ')}</span></p>
        {a.done.ended_now
          ? <p>{a.done.why === 'not_taken' ? 'The payment for the new month had not been taken yet, so the plan ended today and that payment is withdrawn.' : a.done.why === 'already_ended' ? 'The plan had already ended with the payment provider, so there was nothing more to stop.' : 'The last payment had not gone through, so the plan ended today and that payment will not be tried again.'} The signatures on the account stay, and nothing is deleted.</p>
          : <p>The plan runs until {billDay(a.done.ends_at)}, because that month is already paid for. No payment is taken after that. The signatures on the account stay, and nothing is deleted.</p>}
        <p>We emailed this confirmation to the admins of the account. Want the last charge back? See the <a href="#refunds">refund rule</a>.</p>
      </Result>
    );
  return (
    <form
      className="pub-form"
      onSubmit={(e) =>
        a.run(e, () => api('/public/billing/stop-by-card', { body: noEmail ? { last4, charged_on: on, amount } : { email: email.trim(), last4 } }), (err) =>
          explain(err, 'That is too many tries for now. Wait an hour, or use the contact form below and a person will stop it for you.', {
            501: 'This copy of Sign&Grow does not take payments, so there is nothing to stop here. If you see a charge anyway, use the contact form below.',
            // The server's own words already say what to do when they can. Only a bare answer from the provider gets ours.
            502: /try again/i.test(err.message || '') ? err.message : `${err.message} Try again in a minute, or use the contact form below.`,
          }))
      }
    >
      <div className="pub-form-row">
        {!noEmail && <label className="f"><span>Email address of the account</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com" /></label>}
        <label className="f pub-last4"><span>Last 4 digits of the card</span><input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} onPaste={(e) => (e.preventDefault(), setLast4(e.clipboardData.getData('text').replace(/\D/g, '').slice(-4)))} required inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" placeholder="1234" title="The last four digits of the card being charged" /></label>
        {noEmail && <label className="f"><span>Date of a charge on your statement</span><input type="date" value={on} onChange={(e) => setOn(e.target.value)} required /></label>}
        {noEmail && <label className="f pub-last4"><span>Amount charged</span><input value={amount} onChange={(e) => setAmount(e.target.value)} required inputMode="decimal" placeholder="9.00" title="The amount of that charge, as on your statement" /></label>}
        <button className="btn primary" disabled={a.busy}>{a.busy ? 'Stopping' : 'Stop billing'}</button>
      </div>
      <p className="muted small pub-form-hint">
        Only the last four digits. Never type a full card number here.{!noEmail && " The email address has to be one of the account's owners or admins, the people who can stop the plan in the app."}{' '}
        <button type="button" className="linklike" onClick={() => setNoEmail(!noEmail)}>{noEmail ? 'I know the email address of the account' : 'I do not know which email address the account is under'}</button>
      </p>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
    </form>
  );
}

// What the server says about help: the address, the topics, and the published response times. `reply` is null when
// the people who run this server have set up nobody to answer, and then no time is promised anywhere on the page.
type SupportInfo = { email: string | null; topics: string[]; urgent: string[]; reply: { hours: number; urgent_hours: number } | null; median: { minutes: number; count: number; days: number; late_now: number } | null };
const hoursText = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
};

// How we actually did, next to what we promise: the real median time to a first answer. Shown only when it covers
// enough requests to mean something. The server decides that and sends nothing otherwise.
export function ReplyRecord() {
  const [m, setM] = useState<SupportInfo['median']>(null);
  useEffect(() => {
    api('/public/support').then((d) => setM(d.median || null)).catch(() => {});
  }, []);
  if (!m) return null;
  return (
    <p className="muted small">
      {/* A question back to the writer is a reply from a person, and it is also what stops the clock we promise, so it counts here as it does there. */}
      How we did in the last {m.days} days: of the {m.count} requests that got their first reply from a person in that time (an answer, or a question back to the writer), half had it within {spanText(m.minutes)}.
      {m.late_now > 0 ? ` Right now ${m.late_now === 1 ? 'one request is' : `${m.late_now} requests are`} waiting longer than we promised.` : ' Right now no request is waiting longer than we promised.'}
    </p>
  );
}

// Reaches a person. Open to everyone: signers, free users, former customers and people who cannot log in.
// The help chat opens this same form (src/components/HelpChat.tsx) with its conversation attached (`chat`), a topic
// and the document's security code: the writer sees what is attached and can take it off (`onDropChat`).
export function ContactForm({ chat, onDropChat, topic: firstTopic, code: firstCode, message: firstMessage }: { chat?: ChatLine[] | null; onDropChat?: () => void; topic?: string; code?: string; message?: string } = {}) {
  const [f, setF] = useState({ name: '', email: '', topic: firstTopic || 'signing', message: firstMessage || '' });
  const [envelope, setEnvelope] = useState('');
  // Which document the message is about. The Help link on a signing page and in a signing email brings the security
  // code of that email along (?code=), and someone who came another way can type it. The server says which document
  // the code stands for (`about`), and the form shows that before anything is sent.
  const [code, setCode] = useState('');
  const [about, setAbout] = useState<{ subject: string; sender: string | null; for_name: string; tells_sender: boolean } | null>(null);
  const [codeNote, setCodeNote] = useState('');
  // The signed-in person's confirmed address, if any: what they write is passed on to the sender only from there.
  const [mine, setMine] = useState('');
  const lookUp = (typed: string) => {
    const clean = typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
    setCodeNote('');
    if (clean.length !== 12) return setAbout(null);
    api('/public/support/about', { body: { code: clean } })
      .then((d) => (d?.known ? setAbout(d) : (setAbout(null), setCodeNote(d?.replaced
        ? 'That code is from an email whose link has been replaced by a newer one since. Your message will still say which document you mean.'
        : 'We do not know a document for that code. Check it against the email, or leave the box empty: your message reaches us either way.'))))
      .catch(() => setAbout(null));
  };
  const [info, setInfo] = useState<SupportInfo>({ email: null, topics: Object.keys(TOPIC_LABEL), urgent: [], reply: null, median: null });
  const a = useAction<{ reference: string; email: string; due_at: string | null; reply_hours: number | null }>();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  // The current time, kept fresh, for the "answered by" time shown before sending.
  const [minute, setMinute] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setMinute(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    api('/public/support').then((d) => setInfo({ email: d.email || null, topics: Array.isArray(d.topics) && d.topics.length ? d.topics : Object.keys(TOPIC_LABEL), urgent: d.urgent_topics || [], reply: d.reply || null, median: d.median || null })).catch(() => {});
    // Other pages can link straight to a filled-in form: /help?topic=suspicious&envelope=env_...#contact
    const q = new URLSearchParams(window.location.search);
    const topic = q.get('topic');
    if (topic && !firstTopic) setF((s) => ({ ...s, topic }));
    if (q.get('envelope') && !firstTopic) setEnvelope(q.get('envelope')!.slice(0, 60));
    const startCode = firstCode || (firstTopic ? '' : q.get('code'));
    if (startCode) (setCode(startCode.slice(0, 20)), lookUp(startCode));
    // Someone who is signed in does not have to type who they are.
    api('/me').then((d) => d?.user && (setMine(d.user.email_verified ? d.user.email || '' : ''), setF((s) => ({ ...s, name: s.name || d.user.name || '', email: s.email || d.user.email || '' })))).catch(() => {});
    // Links on this page such as "Report with the contact form" choose the topic on the way down.
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-topic]') as HTMLElement | null;
      if (el?.dataset.topic) setF((s) => ({ ...s, topic: el.dataset.topic! }));
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const topics = info.topics;
  const topic = topics.includes(f.topic) ? f.topic : topics[0];
  // How many hours a person has for this topic, or nothing when no time is promised (see SupportInfo above).
  const replyHours = info.reply ? (info.urgent.includes(topic) ? info.reply.urgent_hours : info.reply.hours) : 0;
  const direct = info.email && <p className="muted small pub-form-hint">Prefer email? Write to <a href={`mailto:${info.email}`}>{info.email}</a>. It reaches the same people.</p>;

  if (a.done)
    return (
      <div className="card pub-sent">
        <Result show>
          <p><b>We got your message.</b> A person will read it and reply by email to {a.done.email}.</p>
          <p>Your reference is <span className="pub-ref">{a.done.reference}</span></p>
          {a.done.due_at && <p><b>A person will have answered by {whenText(a.done.due_at)}</b> (your time). That is within {hoursText(a.done.reply_hours || 0)}, counted in real hours. If we are ever late, your request says so and the whole team is told.</p>}
          <p>We also emailed you this reference, with a private link to your request. Use that link to read the answer, to add something or to see where things stand. It works without signing in. Replying to the email itself does not reach us.</p>
        </Result>
        {info.email && <p className="muted small pub-form-hint">You can also write to <a href={`mailto:${info.email}?subject=${encodeURIComponent(`Reference ${a.done.reference}`)}`}>{info.email}</a>. Mention your reference.</p>}
        <button type="button" className="btn" onClick={() => (a.reset(), setF((s) => ({ ...s, message: '' })))}>Send another message</button>
      </div>
    );

  return (
    <form
      className="card pub-form pub-contact"
      onSubmit={(e) =>
        a.run(e, async () => {
          // The time zone of this browser goes along, so the time in the email is the reader's own time.
          const r = await api('/public/support', { body: { name: f.name.trim(), email: f.email.trim(), topic, message: f.message.trim(), envelope_id: envelope || undefined, code: code.replace(/[^A-Za-z0-9]/g, '').length === 12 ? code : undefined, tz: browserZone() || undefined, chat: chat?.length ? chat : undefined } });
          // "Your requests" below shows the new one straight away for someone who is signed in.
          window.dispatchEvent(new Event('sg-support-sent'));
          return { reference: r.reference, email: f.email.trim(), due_at: r.due_at || null, reply_hours: r.reply_hours || null };
        // Stopped by the allowance for writers we do not know: the server's words say the ways that still reach us.
        }, (err) => err?.code === 'others_limit' ? err.message : explain(err, info.email ? `You have sent several messages, and we have them all. To add something now, use the link in a confirmation email we sent you, or write to ${info.email}.` : 'You have sent several messages, and we have them all. To add something, use the link in a confirmation email we sent you.'))
      }
    >
      <div className="grid g2">
        <label className="f"><span>Your name</span><input value={f.name} onChange={set('name')} autoComplete="name" maxLength={120} /></label>
        <label className="f"><span>Email address <span className="hint">(we reply here)</span></span><input type="email" value={f.email} onChange={set('email')} required autoComplete="email" placeholder="you@example.com" /></label>
      </div>
      <label className="f"><span>What is it about?</span>
        <select value={topic} onChange={set('topic')} aria-describedby={replyHours > 0 ? 'contact-reply-time' : undefined}>
          {topics.map((t) => <option key={t} value={t}>{TOPIC_LABEL[t] || t}</option>)}
        </select>
      </label>
      {/* The actual time, not only a number of hours. It is worked out again every minute while the page is open. */}
      {replyHours > 0 && <p id="contact-reply-time" className="muted small pub-form-hint" style={{ margin: '-6px 0 14px' }}>{info.urgent.includes(topic) ? 'This is urgent for us. ' : ''}Send it now and a person will have answered by <b>{whenText(new Date(minute + replyHours * 3600_000).toISOString())}</b>, your time. That is within {hoursText(replyHours)}, counted in real hours: nights and weekends count too.</p>}
      <label className="f"><span>What happened, and what do you need? <span className="hint">(a couple of sentences is enough)</span></span>
        <textarea value={f.message} onChange={set('message')} required minLength={10} maxLength={5000} rows={6} />
      </label>
      {/* Which document this is about, said before sending, with who else is told and what they are told. */}
      {about ? (
        <div className="notice pub-form-hint" role="status" id="contact-about">
          <p style={{ margin: 0 }}>This message will be about <b>&ldquo;{about.subject || 'a document without a title'}&rdquo;</b>{about.sender ? <>, which {about.sender} sent to {about.for_name}</> : null}. The person who answers you sees which document you mean.</p>
          {about.tells_sender && topic === 'signing' && <p style={{ margin: '6px 0 0' }}>We also tell {about.sender || 'the sender'} that you need help with it, because whoever sent a document can often fix it fastest. {mine && mine.toLowerCase() === f.email.trim().toLowerCase() ? 'What you write here is passed on to them, because you are signed in under this address.' : 'They are told that you asked for help, not what you write here.'}</p>}
          <p style={{ margin: '6px 0 0' }}><button type="button" className="pub-link" onClick={() => (setAbout(null), setCode(''), setEnvelope(''))}>Do not mention the document</button></p>
        </div>
      ) : envelope ? (
        <p className="muted small pub-form-hint" id="contact-about">This message will be about the document you came from, so the person who answers sees which one you mean. If the address above is the one it was sent to and the topic is signing, we also tell its sender that you need help (not what you write here). <button type="button" className="pub-link" onClick={() => setEnvelope('')}>Do not mention the document</button></p>
      ) : topic === 'signing' || topic === 'stuck' ? (
        <label className="f"><span>Security code from the email about the document <span className="hint">(optional: 12 letters and numbers near the bottom of that email)</span></span>
          <input value={code} onChange={(e) => (setCode(e.target.value.slice(0, 20)), lookUp(e.target.value))} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCD-EFGH-JKLM" aria-describedby={codeNote ? 'contact-code-note' : undefined} style={{ maxWidth: 260 }} />
          {codeNote && <span id="contact-code-note" className="hint" role="status">{codeNote}</span>}
        </label>
      ) : null}
      {chat && chat.length > 0 && (
        <div className="notice pub-form-hint hc-attached" id="contact-chat">
          <p style={{ margin: 0 }}><b>Your chat with the helper is attached</b> ({chat.length} message{chat.length === 1 ? '' : 's'}). The person who answers reads it with your message. It is not passed to the sender of a document.</p>
          <details><summary>See what is attached</summary>
            <ol className="hc-attached-list">{chat.map((l, i) => <li key={i}><b>{l.from === 'you' ? 'You' : 'Helper'}:</b> {l.text}</li>)}</ol>
          </details>
          {onDropChat && <p style={{ margin: '6px 0 0' }}><button type="button" className="pub-link" onClick={onDropChat}>Take the chat off</button></p>}
        </div>
      )}
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      <div className="pub-contact-foot">
        <button className="btn primary" disabled={a.busy}>{a.busy ? 'Sending' : 'Send to a person'}</button>
        <span className="muted small">You get a reference straight away. No account needed.</span>
      </div>
      {direct}
    </form>
  );
}

// For someone who is signed in: every request they sent, where it stands, who has it, by when a person will have
// answered, and everything written on it, with a box to reply. So "did my message arrive?" never needs a second
// message. Nobody else sees anything here. Requests written from an address that was never confirmed are not
// listed, because typing an address proves nothing.
export function YourRequests() {
  const [list, setList] = useState<(CustomerRequest & { id: string })[] | null>(null);
  // Which requests are unfolded. Once the reader has opened or closed one it stays that way, also when the list is
  // read again after a reply.
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const load = useRef(() => {});
  useEffect(() => {
    load.current = () => void api('/me').then((d) => (d?.user ? api('/support/mine').then((r) => setList(r.requests || [])) : setList(null))).catch(() => {});
    load.current();
    const again = () => load.current();
    window.addEventListener('sg-support-sent', again);
    return () => window.removeEventListener('sg-support-sent', again);
  }, []);
  if (!list?.length) return null;
  // What one line of the list says before it is opened: the state, and the time that goes with it.
  const line = (r: CustomerRequest) =>
    r.late ? 'We are late with this. Sorry.' : r.status === 'open' ? (r.due_at ? `${r.owner ? `${r.owner} is looking at this` : 'Waiting for us'}: answer by ${whenText(r.due_at)}` : 'Waiting for a person to answer')
      : r.status === 'waiting' ? 'We asked you a question' : r.status === 'answered' ? 'Answered: reply, or mark it as solved' : STATUS_FOR_CUSTOMER[r.status] || r.status;
  return (
    <section className="card" aria-labelledby="your-requests-h" style={{ marginTop: 16 }}>
      <h3 id="your-requests-h">Your requests</h3>
      <p className="muted small" style={{ margin: '4px 0 10px' }}>What you sent us while signed in, or from your confirmed address. Open one to read everything written on it, to reply, or to mark it as solved.</p>
      <ul role="list" className="rq-list">
        {list.map((r, i) => (
          <li key={r.id}>
            <details className="rq-item" open={unfolded[r.id] ?? (list.length === 1 || (i === 0 && r.status !== 'closed') || r.status === 'waiting' || r.late)}
              onToggle={(e) => {
                const open = e.currentTarget.open;
                setUnfolded((s) => (s[r.id] === open ? s : { ...s, [r.id]: open }));
              }}>
              <summary>
                {/* Dates as on every other support screen and email: "Friday 20 November, 14:00". */}
                <span><span className="pub-ref">{r.reference}</span> <span className="muted small">{TOPIC_LABEL[r.topic] || r.topic} · sent {whenText(r.at)}</span></span>
                <span className={`rq-sum-state${r.late ? ' late' : ''}`}>{line(r)}</span>
              </summary>
              <RequestView
                r={r}
                head={false}
                reply={r.can_reply ? async (message) => {
                  const d = await api(`/support/mine/${r.id}/reply`, { body: { message } });
                  load.current();
                  if (d.moved) return `This request was closed too long ago to open again, so we started a new one for you. Its reference is ${d.reference}, and it is in this list.`;
                } : undefined}
                solved={r.can_reply ? async (notMine) => {
                  await api(`/support/mine/${r.id}/solved`, { body: { not_mine: notMine } });
                  load.current();
                } : undefined}
              />
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
