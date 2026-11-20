'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/components/ui';
import { TOPIC_LABEL, STATUS_FOR_CUSTOMER, standing, whenText, type CustomerRequest } from '@/lib/support';

// One help request as the person who wrote it sees it: where it stands, by when a person will have answered,
// everything written so far, a box to reply and a button to say it is solved. Used under "Your requests" on the
// help page for someone who is signed in, and by the private link from our emails for everyone else.

const when = (iso: string) => whenText(iso);
const offline = 'We could not reach Sign&Grow. Check your connection and try again. What you wrote is still in the box.';

export function RequestView({ r, reply, solved, head = true }: {
  r: CustomerRequest;
  head?: boolean; // false where the reference and the topic already stand right above, as in the list under Help
  reply?: (message: string) => Promise<string | void>; // answers with a sentence to show, if there is more to say than "sent"
  solved?: (notMine: boolean) => Promise<void>;
  linked?: boolean; // opened through the private link, by someone we only know as the holder of that link
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const result = useRef<HTMLDivElement>(null);
  const s = standing(r, when);
  const closed = r.status === 'closed';
  const late30 = closed && !!r.reopen_until && Date.parse(r.reopen_until) < Date.now();

  const run = async (what: string, fn: () => Promise<string | void>, done: string) => {
    if (busy) return;
    setBusy(what);
    setError('');
    setSaid('');
    try {
      setSaid((await fn()) || done);
      if (what === 'reply') setMessage('');
      result.current?.focus();
    } catch (e: any) {
      setError(e?.status ? e.message : offline);
    } finally {
      setBusy('');
    }
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (reply && message.trim()) run('reply', () => reply(message.trim()), closed ? 'Sent. Your request is open again.' : 'Sent. A person will read it.');
  };

  return (
    <div className="rq">
      {head && (
        <div className="rq-head">
          <span className="pub-ref">{r.reference}</span>
          <span className={`badge ${r.status === 'open' ? (r.late ? 'declined' : 'sent') : r.status === 'waiting' ? 'expired' : 'completed'}`}>{r.late ? 'Late' : STATUS_FOR_CUSTOMER[r.status] || r.status}</span>
          <span className="rq-meta">{TOPIC_LABEL[r.topic] || r.topic} · sent {when(r.at)}</span>
        </div>
      )}
      {r.follows && <p className="muted small rq-note">This continues your earlier request <span className="pub-ref">{r.follows}</span>. The person who answers sees both.</p>}

      <div className={`notice rq-state ${s.tone === 'late' ? 'late' : s.tone}`} role="status" style={head ? undefined : { marginTop: 0 }}>
        <b>{s.title}</b>
        {s.text}
      </div>
      {(r.due_at || r.reopen_until) && <p className="muted small rq-note">Times are shown in the time zone of this device.</p>}

      {r.thread && (
        <ol className="rq-thread" aria-label="Everything written on this request, oldest first">
          {r.thread.map((m, i) => (
            <li key={i} className={`rq-msg ${m.from}${m.kind === 'question' ? ' question' : ''}`}>
              <div className="rq-who"><b>{m.from === 'you' ? 'You' : `${m.name || 'A person on our team'}, Sign&Grow`}{m.kind === 'question' ? ' asked' : ''}</b><span>{when(m.at)}</span></div>
              {i === 0 && r.held
                ? <p className="rq-body muted">The first message is with us. It is not repeated here until a person has read it, because anyone can type an email address into our form.</p>
                : <p className="rq-body">{m.body}</p>}
            </li>
          ))}
        </ol>
      )}
      {!r.thread && (
        <>
          {r.message && <ol className="rq-thread" aria-label="What you wrote"><li className="rq-msg you"><div className="rq-who"><b>You</b><span>{when(r.at)}</span></div><p className="rq-body">{r.message}</p></li></ol>}
          <p className="muted small rq-note">The answer goes by email to the address this request was written under. It is shown here only for an email address you have confirmed as your own.</p>
        </>
      )}

      <div ref={result} tabIndex={-1} className="pub-focus" aria-live="polite">
        {said && <div className="notice rq-note" role="status">{said}</div>}
      </div>

      {reply && (
        <form className="rq-reply" onSubmit={send}>
          <label className="f"><span>{closed ? (late30 ? 'Write to us again (this starts a new request, linked to this one)' : 'Not solved after all? Write back (this opens the request again)') : r.status === 'waiting' ? 'Your answer' : r.status === 'answered' ? 'Reply (this opens the request again)' : 'Add something to this request'}</span>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} rows={4} required />
          </label>
          {error && <div className="notice err" role="alert" style={{ marginBottom: 10 }}>{error}</div>}
          <div className="rq-actions">
            <button className="btn primary" disabled={!!busy}>{busy === 'reply' ? 'Sending' : 'Send'}</button>
            {solved && !closed && <button type="button" className="btn" disabled={!!busy} onClick={() => run('solved', () => solved(false), 'Marked as solved. Thank you for telling us.')}>{busy === 'solved' ? 'Saving' : 'This is solved'}</button>}
            {/* Whenever the first message came from someone we do not know: through the link, and also under "Your requests" for a request somebody else typed this address into. */}
            {solved && !closed && r.held && <button type="button" className="pub-link" disabled={!!busy} onClick={() => run('not-mine', () => solved(true), 'Thank you. The request is closed and nothing more will be sent to you about it.')}>I did not write to you</button>}
          </div>
        </form>
      )}
    </div>
  );
}

type View = { kind: 'loading' } | { kind: 'gone'; message: string } | { kind: 'failed' } | { kind: 'deleted' } | { kind: 'ready'; r: CustomerRequest };

// The page behind the private link in our emails. No login: the link itself is the proof that the reader has the
// mailbox the request was written from. It shows that one request and nothing else.
export function LinkedRequest() {
  const { id, key } = useParams<{ id: string; key: string }>();
  const router = useRouter();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [tries, setTries] = useState(0);
  const base = `/public/support/ticket/${encodeURIComponent(id)}/${encodeURIComponent(key)}`;

  useEffect(() => {
    let live = true;
    setView({ kind: 'loading' });
    api(base).then((d) => live && setView({ kind: 'ready', r: d.request })).catch((e) => live && setView(e?.status === 404 ? { kind: 'gone', message: e.message } : { kind: 'failed' }));
    return () => {
      live = false;
    };
  }, [base, tries]);

  if (view.kind === 'loading') return <p className="muted" role="status">Opening your request</p>;
  if (view.kind === 'failed')
    return (
      <div className="card">
        <h1 className="pub-h1" style={{ fontSize: 26 }}>We could not open your request just now</h1>
        <p className="pub-lead">Nothing is wrong with your link. Check your connection and try again.</p>
        <p style={{ marginTop: 16 }}><button className="btn primary" onClick={() => setTries((n) => n + 1)}>Try again</button></p>
      </div>
    );
  if (view.kind === 'gone' || view.kind === 'deleted')
    return (
      <div className="card">
        <h1 className="pub-h1" style={{ fontSize: 26 }}>{view.kind === 'deleted' ? 'This request has been deleted' : 'This link does not open a request'}</h1>
        <p className="pub-lead">{view.kind === 'deleted' ? 'It belonged to an account that was closed, and it was kept only until it was dealt with. Nothing more will be sent about it.' : view.message.replace(/^This link does not open a request\.\s*/, '')}</p>
        <p style={{ marginTop: 16 }}><Link className="btn primary" href="/help#contact">Write to us</Link></p>
      </div>
    );

  const r = view.r;
  return (
    <>
      <header className="pub-top">
        <h1 className="pub-h1">Your request</h1>
        <p className="pub-lead">Everything about this request is on this page. It opens without signing in, for whoever has the link, so do not pass the link on.</p>
      </header>
      <div className="card">
        <RequestView
          r={r}
          linked
          reply={async (message) => {
            const d = await api(`${base}/reply`, { body: { message } });
            // Too long after closing: what was written started a new request, with a link of its own.
            if (d.moved) return router.replace(d.url), `This request was closed too long ago to open again, so we started a new one for you. Its reference is ${d.reference}.`;
            setView({ kind: 'ready', r: d.request });
          }}
          solved={async (notMine) => {
            const d = await api(`${base}/solved`, { body: { not_mine: notMine } });
            setView(d.deleted ? { kind: 'deleted' } : { kind: 'ready', r: d.request });
          }}
        />
      </div>
      <p className="muted small" style={{ marginTop: 16 }}>Replying to our emails does not reach this request. Write here instead. Something else entirely? <Link href="/help">Open the help page</Link>.</p>
    </>
  );
}
