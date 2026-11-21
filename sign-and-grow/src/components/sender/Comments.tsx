'use client';
// "Questions and comments" on the sender's envelope page: every thread, who has not been answered, an answer box,
// "Mark as settled", and a new comment for everyone or for one person. The rules (who reads what, who is emailed
// and when) are the server's (src/server/routes-comments.ts); this card says them as they come back.
import { useEffect, useId, useState } from 'react';
import { api, toast, fmtDate } from '@/components/ui';
import { audienceWords } from '@/lib/comments';
import { CommentBody } from '@/components/CommentBody';
import { COMMENT_MAX_CHARS } from '@/lib/policy';
import { fail } from './feedback';

const joinNames = (l: string[]) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);

// What became of the email about one comment of the sender's side, for each person it is for.
// A waiting one says why it waits: the pause, or the ten minutes since the last email to that person.
function newsLine(n: any, mins: number, paused = false): string {
  if (n.mailed_at) return `Emailed to ${n.to} on ${fmtDate(n.mailed_at, true)}.`;
  if (n.not_emailed) return `Not emailed to ${n.to}: ${n.not_emailed}`;
  return paused ? `Waiting to be emailed to ${n.to}: sending is paused on this account, and it goes out by itself once the pause is lifted.`
    : `Waiting to be emailed to ${n.to}. We send at most one email every ${mins} minutes to each person, so it goes with the next one.`;
}

export function EnvelopeComments({ envelope }: { envelope: any }) {
  const e = envelope;
  const ids = useId();
  const [data, setData] = useState<any>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState('');
  const [reply, setReply] = useState('');
  const [text, setText] = useState('');
  const [forWhom, setForWhom] = useState('');
  const [error, setError] = useState('');
  const shown = e.kind === 'envelope' && e.status !== 'draft';

  async function load() {
    try {
      setData(await api(`/envelopes/${e.id}/comments`));
      setProblem('');
    } catch (err: any) {
      setProblem(err?.message || 'The comments could not be loaded just now.');
    }
  }
  useEffect(() => {
    if (shown) load();
  }, [e.id, e.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // The email about new comments links to #comments. This card appears only once its data is here, after the
  // browser looked for the anchor, so it is brought into view then.
  const arrived = !!data;
  // Folded, and closed every time the page opens, unless the person came for it: the email link, or a later tap on one.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (arrived && window.location.hash === '#comments') (setOpen(true), setTimeout(() => document.getElementById('comments')?.scrollIntoView({ block: 'start' }), 0));
  }, [arrived]);

  if (!shown) return null;
  // Closed with nothing written: nothing to show and nothing to do.
  if (data && !data.threads.length && !data.may_write) return null;

  async function post(body: any) {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/envelopes/${e.id}/comments`, { body });
      setData(r);
      const told = (r.told || []).map((n: any) => newsLine(n, r.mail_minutes, r.paused)).join(' ');
      toast(`${r.message}${told ? ` ${told}` : ''}`);
      return true;
    } catch (err: any) {
      setError(err?.message || 'Something went wrong on our side. Nothing was sent. Try again in a moment.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function settle(t: any, on: boolean) {
    setBusy(true);
    try {
      setData(await api(`/envelopes/${e.id}/comments/${t.id}/settle`, { body: { settled: on } }));
      toast(on ? 'Marked as settled. A new comment in it opens it again.' : 'Open again.');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const threads: any[] = data?.threads || [];
  const waiting: any[] = data?.waiting || [];
  return (
    <details className="card sn-fold cm-card" id="comments" data-fold="" open={open} onToggle={(ev) => setOpen((ev.currentTarget as HTMLDetailsElement).open)} aria-labelledby={`${ids}-h`}>
      <summary>
        <span id={`${ids}-h`}>Questions and comments{data ? ` (${threads.length})` : ''}</span>
        {waiting.length > 0 && <span className="cm-tag warn">{waiting.length === 1 ? '1 waits for your answer' : `${waiting.length} wait for your answer`}</span>}
      </summary>
      <div className="sn-fold-in">
      {data?.not_signed && <p className="muted small" style={{ marginTop: 4 }}>{data.not_signed}</p>}
      {problem && <div className="notice err" role="alert">{problem} <button type="button" className="btn sm" onClick={load}>Try again</button></div>}
      {!data && !problem && <p className="muted" role="status">Loading the comments</p>}
      {data && (waiting.length > 0
        ? <p className="notice warn" role="status" style={{ marginTop: 10 }}>Waiting for your answer: <b>{joinNames([...new Set(waiting.map((w) => w.name as string))])}</b>.</p>
        : threads.length > 0 ? <p className="muted" style={{ marginTop: 10 }}>Nobody is waiting for an answer.</p>
        : <p className="muted" style={{ marginTop: 10 }}>Nobody has written anything yet. The people on this document can ask you something from their signing page, and you are emailed when they do.</p>)}

      {threads.map((t, i) => (
        <article key={t.id} className={`cm-thread${t.settled_at ? ' settled' : t.waiting ? ' waiting' : ''}`} aria-label={`Conversation ${i + 1}`} style={{ marginTop: 12 }}>
          <p className="cm-who small">
            {audienceWords(t, 'sender')}{t.pin_words ? ` About ${t.pin_words}.` : ''}
            {t.settled_at ? ` Marked as settled by ${t.settled_by}.` : t.waiting ? ' Waiting for your answer.' : ''}
          </p>
          <ol className="cm-list">
            {t.comments.map((c: any) => (
              <li key={c.id} className={c.by_sender ? 'from-sender' : ''}>
                <div className="cm-meta"><b><bdi>{c.name}</bdi></b>{c.email ? <span className="muted small"> {c.email}</span> : null} <span className="muted small">{fmtDate(c.at, true)}</span></div>
                <CommentBody text={c.body} />
                {c.by_sender && (c.news || []).map((n: any, k: number) => <p key={k} className="muted small cm-news">{newsLine(n, data.mail_minutes, data.paused)}</p>)}
              </li>
            ))}
          </ol>
          {data.may_write && (replyTo === t.id ? (
            <form className="cm-reply" onSubmit={async (ev) => {
              ev.preventDefault();
              if (!reply.trim()) return setError('Type your answer first. Nothing was sent.');
              if (await post({ thread_id: t.id, text: reply })) (setReply(''), setReplyTo(''));
            }}>
              <label className="f"><span>Your answer</span><textarea dir="auto" rows={3} maxLength={COMMENT_MAX_CHARS} value={reply} onChange={(ev) => setReply(ev.target.value)} autoFocus /></label>
              <p className="muted small">{t.private ? `Only ${t.with?.name || 'this person'} can read it${t.with?.emailed ? ', and they are emailed.' : `. ${t.with?.not_emailed || 'They are not emailed. They see it on their signing page.'}`}` : 'Everyone on the envelope can read it on their signing page. Whoever wrote in this conversation is emailed if we can email them, and under your answer it says who was.'}</p>
              <div className="row wrap">
                <button className="btn" disabled={busy}>{busy ? 'Sending' : 'Send answer'}</button>
                <button type="button" className="btn" onClick={() => (setReplyTo(''), setReply(''))}>Cancel</button>
              </div>
            </form>
          ) : (
            <div className="row wrap cm-acts">
              <button type="button" className="btn sm" onClick={() => (setReplyTo(t.id), setReply(''), setError(''))}>Answer<span className="sg-vh"> in conversation {i + 1}</span></button>
              {t.settled_at
                ? <button type="button" className="btn sm" disabled={busy} onClick={() => settle(t, false)}>Open again<span className="sg-vh">: conversation {i + 1}</span></button>
                : <button type="button" className="btn sm" disabled={busy} onClick={() => settle(t, true)}>Mark as settled<span className="sg-vh">: conversation {i + 1}</span></button>}
            </div>
          ))}
        </article>
      ))}

      {error && <div className="notice err" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      {data && !data.may_write && <p className="muted small" style={{ marginTop: 10 }}>This document is no longer out, so these can be read and no longer added to. They are kept with it, and its export and its full record for disputes carry them.</p>}
      {data?.may_write && !replyTo && (
        <form className="cm-new" style={{ marginTop: 14 }} onSubmit={async (ev) => {
          ev.preventDefault();
          if (!text.trim()) return setError('Type your comment first. Nothing was sent.');
          if (!forWhom) return setError('Choose who can read it first. Nothing was sent.');
          if (await post({ text, for: forWhom })) (setText(''), setForWhom(''));
        }}>
          <h3 className="cm-h">Write a comment</h3>
          <label className="f"><span>Your comment</span><textarea dir="auto" rows={3} maxLength={COMMENT_MAX_CHARS} value={text} onChange={(ev) => setText(ev.target.value)} /></label>
          <label className="f"><span>Who can read it</span>
            <select value={forWhom} onChange={(ev) => setForWhom(ev.target.value)} required>
              <option value="">Choose who can read it</option>
              <option value="everyone">Everyone on the document (nobody is emailed)</option>
              {(data.people || []).map((p: any) => <option key={p.id} value={p.id}>Only {p.name} ({p.emailed ? 'they are emailed' : 'not emailed, they see it on their signing page'})</option>)}
            </select>
          </label>
          <button className="btn" disabled={busy}>{busy ? 'Sending' : 'Send comment'}</button>
        </form>
      )}
      </div>
    </details>
  );
}
