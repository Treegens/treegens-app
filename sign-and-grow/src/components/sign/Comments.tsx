'use client';
// "Questions and comments" on the signing page: the one way to ask the sender something before signing, and to read
// what is written for everyone on the document. Quiet by design: it opens from the menu or the button next to the
// document and never stands between the person and Finish. What a person may read is decided by the server
// (src/server/comments.ts); this page shows exactly what it is given.
import { useEffect, useId, useRef, useState } from 'react';
import { api, fmtDate } from '@/components/ui';
import { Dialog } from './Dialog';
import { audienceWords } from '@/lib/comments';
import { COMMENT_MAX_CHARS } from '@/lib/policy';

/** How many of this person's own questions wait for an answer. Asked again whenever `on` turns true (the dialog closes). */
export function useMyQuestions(base: string, on: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    let live = true;
    api(`${base}/comments`).then((r) => live && setN(r?.waiting || 0)).catch(() => {});
    return () => {
      live = false;
    };
  }, [base, on]);
  return n;
}

type Doc = { id: string; name: string; pages: number };

export function CommentsDialog({ base, sender, documents, onClose }: { base: string; sender: { name: string; email?: string }; documents: Doc[]; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [problem, setProblem] = useState('');
  const [text, setText] = useState('');
  const [forWhom, setForWhom] = useState<'sender' | 'everyone'>('sender');
  const [about, setAbout] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [reply, setReply] = useState('');
  const said$ = useRef<HTMLDivElement>(null);
  const ids = useId();

  async function load() {
    try {
      setData(await api(`${base}/comments`));
      setProblem('');
    } catch (e: any) {
      setProblem(e?.message || 'The comments could not be loaded just now.');
    }
  }
  useEffect(() => {
    load();
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (said) said$.current?.focus();
  }, [said]);

  // What happens next, in words, once something is sent: who reads it, and where an answer comes.
  const next = (everyone: boolean) => {
    const answer = data?.answers_to ? `Their answer appears here, and we email it to ${data.answers_to}.` : 'Their answer appears here when you open this link again.';
    return everyone ? `Sent. Everyone on this document can read it on their signing page, and ${sender.name} is emailed. ${answer}` : `Sent. Only ${sender.name} and the admins of their account can read it, and ${sender.name} is emailed. ${answer}`;
  };

  async function send(body: any, everyone: boolean) {
    setBusy(true);
    setError('');
    try {
      const r = await api(`${base}/comments`, { body });
      setData(r);
      setSaid(next(everyone));
      return true;
    } catch (e: any) {
      setError(`${e?.message || 'Something went wrong on our side.'}${e?.status >= 500 ? ' Nothing was sent. Try again in a moment.' : ''}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function settle(t: any) {
    setBusy(true);
    try {
      setData(await api(`${base}/comments/${t.id}/settle`, { method: 'POST' }));
      setSaid(`Marked as settled. ${sender.name} can see that, and anyone can still write in it, which opens it again.`);
    } catch (e: any) {
      setError(e?.message || 'That did not work just now. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  const threads: any[] = data?.threads || [];
  const pages = documents.flatMap((d) => Array.from({ length: d.pages || 0 }, (_, p) => ({ value: `${d.id}:${p}`, label: `${documents.length > 1 ? `${d.name}, ` : ''}page ${p + 1}` })));
  const canWrite = !!data?.may_write && data.left > 0;

  return (
    <Dialog title="Questions and comments" wide onClose={onClose}>
      <p className="muted">Ask {sender.name} about anything in the document, or leave a comment. Writing here signs nothing, and you can still finish whenever you are ready.</p>
      {data?.not_signed && <p className="muted small">{data.not_signed}</p>}
      {problem && <div className="notice err" role="alert">{problem} <button type="button" className="btn sm" onClick={load}>Try again</button></div>}
      {!data && !problem && <p className="muted" role="status">Loading the comments</p>}

      {said && <div ref={said$} tabIndex={-1} className="notice sg-confirmed" role="status">{said}</div>}

      {data && (
        <section aria-labelledby={`${ids}-list`} className="cm-threads">
          <h3 id={`${ids}-list`} className="cm-h">{threads.length ? `On this document (${threads.length})` : 'On this document'}</h3>
          {threads.length === 0 && <p className="muted">Nobody has written anything yet.</p>}
          {threads.map((t, i) => {
            const last = t.comments[t.comments.length - 1];
            const mayEnd = (t.private || t.mine) && !t.settled_at && data.may_write;
            return (
              <article key={t.id} className={`cm-thread${t.settled_at ? ' settled' : ''}`} aria-label={`Conversation ${i + 1}`}>
                <p className="cm-who small">
                  {audienceWords(t, 'recipient', sender.name)}{t.pin_words ? ` About ${t.pin_words}.` : ''}
                  {t.settled_at ? ' Marked as settled.' : t.waiting && last?.mine ? ` Waiting for ${sender.name} to answer.` : ''}
                </p>
                <ol className="cm-list">
                  {t.comments.map((c: any) => (
                    <li key={c.id} className={c.by_sender ? 'from-sender' : ''}>
                      <div className="cm-meta"><b><bdi>{c.mine ? 'You' : c.name}</bdi></b>{c.by_sender && c.name !== sender.name ? <span className="muted small">, for {sender.name}</span> : null} <span className="muted small">{fmtDate(c.at, true)}</span></div>
                      <p className="cm-body" dir="auto">{c.body}</p>
                    </li>
                  ))}
                </ol>
                {data.may_write && (replyTo === t.id ? (
                  <form className="cm-reply" onSubmit={async (ev) => {
                    ev.preventDefault();
                    if (!reply.trim()) return setError('Type your reply first. Nothing was sent.');
                    if (await send({ thread_id: t.id, text: reply }, !t.private)) (setReply(''), setReplyTo(''));
                  }}>
                    <label className="f"><span>Your reply</span><textarea dir="auto" rows={3} maxLength={COMMENT_MAX_CHARS} value={reply} onChange={(e) => setReply(e.target.value)} autoFocus /></label>
                    <div className="row wrap">
                      <button className="btn primary" disabled={busy}>{busy ? 'Sending' : 'Send reply'}</button>
                      <button type="button" className="btn" onClick={() => (setReplyTo(''), setReply(''))}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <div className="row wrap cm-acts">
                    {canWrite && <button type="button" className="btn sm" onClick={() => (setReplyTo(t.id), setReply(''), setSaid(''), setError(''))}>Reply<span className="sg-vh"> in conversation {i + 1}</span></button>}
                    {mayEnd && <button type="button" className="btn sm" disabled={busy} onClick={() => settle(t)}>That settles it<span className="sg-vh">: conversation {i + 1}</span></button>}
                  </div>
                ))}
              </article>
            );
          })}
        </section>
      )}

      {error && <div className="notice err sg-problem" role="alert">{error}</div>}

      {data && !data.may_write && <p className="notice">Everyone has finished, so these can be read and no longer added to. They are kept with the document.</p>}
      {data && data.may_write && data.left <= 0 && <p className="notice warn">You have written as many comments on this document as one person can. To say more, email {sender.name}{sender.email ? ` at ${sender.email}` : ''}.</p>}
      {canWrite && !replyTo && (
        <form className="cm-new" onSubmit={async (ev) => {
          ev.preventDefault();
          if (!text.trim()) return setError('Type your question or comment first. Nothing was sent.');
          const [document_id, page] = about ? about.split(':') : [];
          const everyone = forWhom === 'everyone' && data.for_everyone;
          if (await send({ text, for: everyone ? 'everyone' : 'sender', ...(about ? { pin: { document_id, page: Number(page) } } : {}) }, everyone)) (setText(''), setAbout(''));
        }}>
          <h3 className="cm-h">Ask a question or leave a comment</h3>
          <label className="f"><span>Your question or comment</span><textarea dir="auto" data-autofocus rows={4} maxLength={COMMENT_MAX_CHARS} value={text} onChange={(e) => (setText(e.target.value), setSaid(''))} aria-describedby={`${ids}-len`} /></label>
          <p id={`${ids}-len`} className="muted small cm-len">Up to {COMMENT_MAX_CHARS} characters.</p>
          {data.for_everyone ? (
            <fieldset className="cm-for">
              <legend>Who can read it</legend>
              <label className="check"><input type="radio" name={`${ids}-for`} checked={forWhom === 'sender'} onChange={() => setForWhom('sender')} /> <span>Only {sender.name}, and the admins of their account. The other people on this document do not see it.</span></label>
              <label className="check"><input type="radio" name={`${ids}-for`} checked={forWhom === 'everyone'} onChange={() => setForWhom('everyone')} /> <span>Everyone on this document</span></label>
            </fieldset>
          ) : <p className="muted small">Only {sender.name} and the admins of their account can read it.</p>}
          {pages.length > 0 && (
            <label className="f"><span>What is it about? <span className="hint">Optional</span></span>
              <select value={about} onChange={(e) => setAbout(e.target.value)}>
                <option value="">The whole document</option>
                {pages.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
          )}
          <button className="btn primary" disabled={busy}>{busy ? 'Sending' : 'Send'}</button>
        </form>
      )}
      <div className="actions"><button type="button" className="btn" onClick={onClose}>Back to the document</button></div>
    </Dialog>
  );
}

/** Said before Finish, and never in the way of it: this person asked something that nobody has answered yet. */
export function OpenQuestion({ sender, onShow }: { sender: string; onShow: () => void }) {
  return (
    <div className="notice warn sg-problem cm-open" role="status">
      You asked {sender} a question that has not been answered. Finish anyway? <button type="button" className="btn sm" onClick={onShow}>See your question</button>
    </div>
  );
}
