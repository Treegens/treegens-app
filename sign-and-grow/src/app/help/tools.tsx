'use client';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '@/components/ui';

// The self-service tools on the help page. Every one of them works without logging in.

// Billing dates are whole days in UTC, written the same way as in our emails so the two never disagree.
export const billDay = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');

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

// Locked out of the mailbox as well: prove you are the payer with the card that is being charged.
export function StopByCard() {
  const [email, setEmail] = useState('');
  const [last4, setLast4] = useState('');
  const a = useAction<{ account: string; ends_at: string; reference: string }>();
  if (a.done)
    return (
      <Result show>
        <p><b>Renewal stopped for {a.done.account}.</b> You will not be charged again.</p>
        <p>Reference <span className="pub-ref">{a.done.reference}</span></p>
        <p>The plan runs until {billDay(a.done.ends_at)}, because that month is already paid for. No payment is taken after that. The signatures you have left stay yours, and nothing is deleted.</p>
        <p>We emailed this confirmation to the admins of the account. Want the last charge back? See the <a href="#refunds">refund rule</a>.</p>
      </Result>
    );
  return (
    <form
      className="pub-form"
      onSubmit={(e) =>
        a.run(e, () => api('/public/billing/stop-by-card', { body: { email: email.trim(), last4 } }), (err) =>
          explain(err, 'That is too many tries for now. Wait an hour, or use the contact form below and a person will stop it for you.', {
            501: 'This copy of Sign&Grow does not take payments, so there is nothing to stop here. If you see a charge anyway, use the contact form below.',
            502: `${err.message} Nothing was changed. Try again in a minute, or use the contact form below.`,
          }))
      }
    >
      <div className="pub-form-row">
        <label className="f"><span>Email address of the account</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com" /></label>
        <label className="f pub-last4"><span>Last 4 digits of the card</span><input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} onPaste={(e) => (e.preventDefault(), setLast4(e.clipboardData.getData('text').replace(/\D/g, '').slice(-4)))} required inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" placeholder="1234" title="The last four digits of the card being charged" /></label>
        <button className="btn primary" disabled={a.busy}>{a.busy ? 'Stopping' : 'Stop billing'}</button>
      </div>
      <p className="muted small pub-form-hint">Only the last four digits. Never type a full card number here.</p>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
    </form>
  );
}

const TOPIC_LABEL: Record<string, string> = {
  signing: 'Signing a document',
  sending: 'Sending documents',
  billing: 'Billing or a refund',
  'cannot-log-in': 'I cannot log in',
  suspicious: 'Something looks suspicious',
  other: 'Something else',
};

// Reaches a person. Open to everyone: signers, free users, former customers and people who cannot log in.
export function ContactForm() {
  const [f, setF] = useState({ name: '', email: '', topic: 'signing', message: '' });
  const [envelope, setEnvelope] = useState('');
  const [info, setInfo] = useState<{ email: string | null; topics: string[] }>({ email: null, topics: Object.keys(TOPIC_LABEL) });
  const a = useAction<{ reference: string; email: string }>();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  useEffect(() => {
    api('/public/support').then((d) => setInfo({ email: d.email || null, topics: Array.isArray(d.topics) && d.topics.length ? d.topics : Object.keys(TOPIC_LABEL) })).catch(() => {});
    // Other pages can link straight to a filled-in form: /help?topic=suspicious&envelope=env_...#contact
    const q = new URLSearchParams(window.location.search);
    const topic = q.get('topic');
    if (topic) setF((s) => ({ ...s, topic }));
    if (q.get('envelope')) setEnvelope(q.get('envelope')!.slice(0, 60));
    // Someone who is signed in does not have to type who they are.
    api('/me').then((d) => d?.user && setF((s) => ({ ...s, name: s.name || d.user.name || '', email: s.email || d.user.email || '' }))).catch(() => {});
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
  const direct = info.email && <p className="muted small pub-form-hint">Prefer email? Write to <a href={`mailto:${info.email}`}>{info.email}</a>. It reaches the same people.</p>;

  if (a.done)
    return (
      <div className="card pub-sent">
        <Result show>
          <p><b>We got your message.</b> A person will read it and reply by email to {a.done.email}.</p>
          <p>Your reference is <span className="pub-ref">{a.done.reference}</span></p>
          <p>We also emailed you a copy with this reference. Reply to that email if you want to add anything.</p>
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
          const r = await api('/public/support', { body: { name: f.name.trim(), email: f.email.trim(), topic, message: f.message.trim(), envelope_id: envelope || undefined } });
          return { reference: r.reference, email: f.email.trim() };
        }, (err) => explain(err, info.email ? `You have sent several messages in the last hour, and we have them. To add something now, write to ${info.email}.` : 'You have sent several messages in the last hour, and we have them. To add something, reply to the confirmation email we sent you.'))
      }
    >
      <div className="grid g2">
        <label className="f"><span>Your name</span><input value={f.name} onChange={set('name')} autoComplete="name" maxLength={120} /></label>
        <label className="f"><span>Email address <span className="hint">(we reply here)</span></span><input type="email" value={f.email} onChange={set('email')} required autoComplete="email" placeholder="you@example.com" /></label>
      </div>
      <label className="f"><span>What is it about?</span>
        <select value={topic} onChange={set('topic')}>
          {topics.map((t) => <option key={t} value={t}>{TOPIC_LABEL[t] || t}</option>)}
        </select>
      </label>
      <label className="f"><span>What happened, and what do you need? <span className="hint">(a couple of sentences is enough)</span></span>
        <textarea value={f.message} onChange={set('message')} required minLength={10} maxLength={5000} rows={6} />
      </label>
      {envelope && <p className="muted small pub-form-hint">This message will mention envelope <span className="mono">{envelope}</span>. <button type="button" className="pub-link" onClick={() => setEnvelope('')}>Leave it out</button></p>}
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      <div className="pub-contact-foot">
        <button className="btn primary" disabled={a.busy}>{a.busy ? 'Sending' : 'Send to a person'}</button>
        <span className="muted small">You get a reference straight away. No account needed.</span>
      </div>
      {direct}
    </form>
  );
}
