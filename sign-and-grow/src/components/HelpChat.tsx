'use client';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Dialog } from './sign/Dialog';
import { ContactForm } from '@/app/help/tools';
import {
  CHAT_SHORT_AI, CHAT_SHORT_BUILTIN, CHAT_DO_NOT_TYPE, CHAT_KEPT, CHAT_STARTERS, CHAT_KEEP_MESSAGES, CHAT_LINKABLE, HAND_OVER_TEXT,
  handOverTopic, limitText, redact, removedText, screenOf, type ChatLimit, type ChatLine, type ChatScreen, type HandOver, type Removed,
} from '@/lib/chat';

// The help dialog: an AI helper that answers at once (or the built-in answers, where no model is set up or one is not
// there), with "Talk to a person" under every answer, which opens the contact form inside the same dialog with the
// conversation attached. Nothing on the page underneath is touched: on the signing page and in the editor nothing
// that was typed there is lost. The conversation lives in this tab's memory only, and is gone on a reload.
// The server side is src/server/chat.ts; the shared rules and words are src/lib/chat.ts.

type Tool = { id: string; label: string; href: string };
type Msg = {
  role: 'user' | 'assistant';
  content: string;
  sig?: string;
  mode?: 'ai' | 'builtin' | 'error';
  note?: string;
  person?: HandOver | null;
  tools?: Tool[];
  removed?: Removed[];
  /** Entries of Other actions on the signing page that do what the answer says, by key (the server names them). */
  acts?: string[];
  /** Which built-in answer this is, where it is one. A greeting shows the suggested questions again. */
  id?: string | null;
};
/** A control of the page underneath that an answer may offer as a button: the page's own label and its own action. */
export type PageAction = { key: string; label: string; onClick?: () => void };
type Status = { ai: boolean; note: string; do_not_type: string; kept: string };

// One conversation for the site, and one for each signing link, kept while the tab lives. A device handed to someone
// to sign does not show them the host's chat.
const memory = new Map<string, Msg[]>();

/** In place of an answer that was on its way when the dialog closed. */
const STOPPED = 'The answer was stopped when you closed the help, so it is not shown. Ask again, or talk to a person.';
/** Under an answer about an entry of Other actions that this person's list does not have. */
const NOT_IN_LIST = 'Your list on this page does not have that. Choose Talk to a person and say what you need.';
const WHY_NOTE: Record<string, string> = {
  down: 'The AI helper could not be reached just now, so this answer comes from our built-in help.',
  slow: 'The AI helper took too long, so this answer comes from our built-in help.',
  empty: 'The AI helper gave no answer, so this one comes from our built-in help.',
};
const localTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
};
const noteFor = (d: any): string | undefined =>
  d?.why === 'limit' && d.limit?.which ? limitText(d.limit.which as ChatLimit, `${localTime(d.limit.until)} your time`) : WHY_NOTE[d?.why] || d?.note;

// An answer is shown as plain text. Only our own pages become links; anything else a model writes stays text.
const PATHS = /(\/(?:help|check|verify|security)(?:\/[a-z-]+)?(?:#[a-z0-9-]+)?)/g;
function AnswerText({ text, newTab }: { text: string; newTab: boolean }) {
  const clean = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '');
  const parts = clean.split(PATHS);
  return (
    <p className="hc-text">
      {parts.map((p, i) => {
        const linkable = i % 2 === 1 && (CHAT_LINKABLE.has(p) || /^\/help#[a-z0-9-]+$/.test(p));
        return linkable ? <a key={i} href={p} {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}>{p}{newTab && <span className="sg-vh"> (opens in a new tab)</span>}</a> : <span key={i}>{p}</span>;
      })}
    </p>
  );
}

export function HelpChat({ screen, link, code, who, actions, onClose }: {
  screen: ChatScreen;
  /** The signing page's own link secret. It goes to this server only, to count that link's limit. */
  link?: string;
  /** The security code of the signer's emails, so a request written from here names the document. */
  code?: string;
  /** The person the signing page is for, so "Talk to a person" does not ask for their name and address again. */
  who?: { name: string; email: string } | null;
  /**
   * The signing page's own controls, as it shows them right now (Finish later, Ask <sender> for more time, ...). An
   * answer that is about one of them gets a button that closes the help and does what that entry does. The labels
   * stay in the browser: the server only ever names the keys.
   */
  actions?: () => PageAction[];
  onClose: () => void;
}) {
  const key = screen === 'signing' && link ? `sign:${link}` : 'site';
  const [msgs, setMsgs] = useState<Msg[]>(() => memory.get(key) || []);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [view, setView] = useState<'chat' | 'person'>('chat');
  const [attach, setAttach] = useState(true);
  const [spoken, setSpoken] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  // Links leave the page: on the signing page and in the editor they open in a new tab, so nothing is left behind.
  const newTab = screen === 'signing' || screen === 'editor';

  useEffect(() => {
    let live = true;
    fetch(`/api/public/chat${link ? `?link=${encodeURIComponent(link)}` : ''}`, { credentials: 'same-origin' }).then((r) => r.json()).then((d) => live && d && typeof d.ai === 'boolean' && setStatus(d)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    memory.set(key, msgs);
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, key]);

  // Closing the dialog while an answer is on its way stops it: the request is cancelled, so the server stops the
  // model and nothing more is paid for. What is kept for the next time the help opens is the question and, in place
  // of the answer, a plain note. The part that had arrived is not kept: it was not finished and the server did not
  // sign it, so it would not count as the helper's anyway.
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => {
    const ctl = pending.current;
    if (!ctl) return;
    pending.current = null;
    ctl.abort();
    const l = memory.get(key) || [];
    const last = l[l.length - 1];
    if (last?.role === 'assistant' && !last.sig && last.mode !== 'error')
      memory.set(key, [...l.slice(0, -1), { role: 'assistant', content: STOPPED, mode: 'error' }]);
  }, [key]);

  // Read out what arrives, a sentence at a time, so a screen reader does not start again at every word.
  const said = useRef(0);
  const speak = (text: string, final: boolean) => {
    const rest = text.slice(said.current);
    const cut = final ? rest.length : Math.max(rest.lastIndexOf('. '), rest.lastIndexOf('? '), rest.lastIndexOf('! '), rest.lastIndexOf('\n')) + 1;
    if (cut <= 0) return;
    const piece = rest.slice(0, cut).trim();
    said.current += cut;
    if (piece) setSpoken(piece);
  };

  const update = (fn: (m: Msg) => Msg) => setMsgs((l) => [...l.slice(0, -1), fn(l[l.length - 1])]);

  async function send(text: string) {
    const typed = text.trim();
    if (!typed || busy) return;
    const r = redact(typed);
    setInput('');
    const asked: Msg = { role: 'user', content: r.text, removed: r.removed };
    const history = [...msgs.filter((m) => m.mode !== 'error'), asked].slice(-CHAT_KEEP_MESSAGES);
    // An answer goes along only with the question it answered (the server checks the two together).
    while (history.length > 1 && history[0].role === 'assistant') history.shift();
    setMsgs((l) => [...l, asked, { role: 'assistant', content: '' }]);
    said.current = 0;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      update(() => ({ role: 'assistant', content: 'This device is offline, so nothing was sent. Check your connection and ask again.', mode: 'error' }));
      return;
    }
    setBusy(true);
    setSpoken('The helper is answering.');
    const ctl = new AbortController();
    pending.current = ctl;
    try {
      const res = await fetch('/api/public/chat', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ screen, ...(link ? { link } : {}), messages: history.map((m) => ({ role: m.role, content: m.content, ...(m.sig ? { sig: m.sig } : {}) })) }),
      });
      if ((res.headers.get('content-type') || '').includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', text = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            let e: any;
            try {
              e = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            if (e.open) update((m) => ({ ...m, mode: 'ai', person: e.person || null, tools: e.tools || [], removed: e.removed, acts: e.acts || [] }));
            else if (typeof e.d === 'string') {
              text += e.d;
              update((m) => ({ ...m, content: text }));
              speak(text, false);
            } else if (e.done) {
              update((m) => ({ ...m, sig: e.sig, tools: e.tools || m.tools, note: e.cut ? 'The answer stopped part way. Ask again, or talk to a person.' : undefined }));
              speak(text, true);
            } else if (e.fallback) {
              const b = e.fallback;
              update((m) => ({ ...m, content: b.reply, sig: b.sig, mode: 'builtin', note: noteFor(b), person: b.person || m.person, tools: b.tools || [], acts: b.acts || [], id: b.id }));
              setSpoken(`${noteFor(b) || ''} ${b.reply}`.trim());
            }
          }
        }
        // The stream ended without an answer or a stand-in: say so instead of leaving an empty bubble.
        setMsgs((l) => {
          const last = l[l.length - 1];
          return last?.content ? l : [...l.slice(0, -1), { role: 'assistant', content: 'The answer was lost on the way. Ask again, or talk to a person.', mode: 'error' }];
        });
      } else {
        const d = await res.json().catch(() => null);
        if (res.ok && typeof d?.reply === 'string') {
          update(() => ({ role: 'assistant', content: d.reply, sig: d.sig, mode: 'builtin', note: noteFor(d), person: d.person || null, tools: d.tools || [], acts: d.acts || [], id: d.id }));
          setSpoken(`${noteFor(d) || ''} ${d.reply}`.trim());
        } else {
          const words = d?.error || 'Something went wrong on our side. Ask again in a moment, or talk to a person.';
          update(() => ({ role: 'assistant', content: words, mode: 'error' }));
          setSpoken(words);
        }
      }
    } catch {
      // Stopped because the dialog closed: what is kept was written when it closed, and there is no one to tell.
      if (ctl.signal.aborted) return;
      const words = 'We could not reach GrowSigning, so nothing was sent. Check your connection and ask again.';
      update(() => ({ role: 'assistant', content: words, mode: 'error' }));
      setSpoken(words);
    } finally {
      if (pending.current === ctl) pending.current = null;
      if (!ctl.signal.aborted) {
        setBusy(false);
        boxRef.current?.focus({ preventScroll: true });
      }
    }
  }

  const submit = (e: FormEvent) => (e.preventDefault(), send(input));
  const lastAnswer = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content);
  const lastQuestion = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
  const reason = lastAnswer?.person || null;
  const lines: ChatLine[] = msgs.filter((m) => m.content && m.mode !== 'error').map((m) => ({ from: m.role === 'user' ? 'you' : 'helper', text: m.content, ...(m.sig ? { sig: m.sig } : {}) }));
  const toPerson = () => (setAttach(true), setView('person'));
  // What the page underneath can do right now, by key. Asked for at each render, so a label is never an old one.
  const pageActs = actions?.() || [];
  const doAct = (a: PageAction) => {
    onClose();
    a.onClick?.();
  };
  const starters = (
    <div className="hc-starters">
      {CHAT_STARTERS[screen].map((q) => <button key={q} type="button" className="btn sm" onClick={() => send(q)}>{q}</button>)}
    </div>
  );

  const person: ReactNode = (
    <button type="button" className="btn sm hc-person" onClick={toPerson}>Talk to a person</button>
  );

  return (
    <Dialog title={view === 'chat' ? 'Help' : 'Write to a person'} onClose={onClose} wide>
      <div className="hc">
        {view === 'chat' ? (
          <>
            {/* Above the conversation: one line, and only when a model answers. With the built-in answers nothing is
                written by AI, so nothing is said here and the question box is what the person sees first. */}
            {status?.ai && <p className="hc-note hc-top">{CHAT_SHORT_AI}</p>}
            <div className="hc-log" ref={logRef} role="log" aria-live="off" aria-label="Conversation with the helper" tabIndex={0}>
              {msgs.length === 0 && (
                <div className="hc-start">
                  <p className="muted small">{status && !status.ai ? `${CHAT_SHORT_BUILTIN} ` : ''}Ask in your own words{status?.ai ? ', in any language' : ''}. Or choose one:</p>
                  {starters}
                </div>
              )}
              {msgs.map((m, i) => (
                m.role === 'user' ? (
                  <div key={i} className="hc-msg you">
                    <span className="sg-vh">You asked: </span>{m.content}
                    {m.removed && m.removed.length > 0 && <span className="hc-removed">{removedText(m.removed)}</span>}
                  </div>
                ) : (
                  <div key={i} className={`hc-msg helper${m.mode === 'error' ? ' err' : ''}`}>
                    <span className="sg-vh">{m.mode === 'error' ? 'Problem: ' : m.mode === 'builtin' ? 'Built-in help answered: ' : 'The helper answered: '}</span>
                    {m.note && <p className="hc-why">{m.note}</p>}
                    {m.content ? <AnswerText text={m.content} newTab={newTab} /> : <span className="hc-typing" aria-hidden="true"><i /><i /><i /></span>}
                    {m.content && m.person && i === msgs.length - 1 && (
                      <div className="notice warn hc-handover" role="note">
                        <p>{HAND_OVER_TEXT[m.person]}</p>
                        <button type="button" className="btn primary sm" onClick={toPerson}>Talk to a person</button>
                      </div>
                    )}
                    {m.content && m.id === 'hello' && i === msgs.length - 1 && starters}
                    {/* The answer names an entry this person's list does not have (a witness has no Finish later, a
                        document without a deadline no "more time"): say so, instead of sending them to look for it. */}
                    {m.content && actions && (m.acts || []).length > 0 && !pageActs.some((a) => m.acts!.includes(a.key)) && (
                      <p className="hc-why" style={{ margin: '6px 0 0' }}>{NOT_IN_LIST}</p>
                    )}
                    {m.content && (
                      <div className="hc-under">
                        {/* The page's own controls first: they do the thing. Then what there is to read. A person is
                            offered under the latest answer only, so there is one such button on screen. */}
                        {pageActs.filter((a) => (m.acts || []).includes(a.key)).sort((a, b) => m.acts!.indexOf(a.key) - m.acts!.indexOf(b.key)).map((a) => <button key={a.key} type="button" className="btn sm" onClick={() => doAct(a)}>{a.label}</button>)}
                        {(m.tools || []).map((t) => <a key={t.id} className="btn sm" href={t.href} {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}>{t.label}{newTab && <span className="sg-vh"> (opens in a new tab)</span>}</a>)}
                        {i === msgs.length - 1 && !m.person && person}
                      </div>
                    )}
                  </div>
                )
              ))}
            </div>
            <form className="hc-form" onSubmit={submit}>
              <label htmlFor={inputId} className="sg-vh">Your question</label>
              <textarea
                id={inputId} ref={boxRef} data-autofocus value={input} rows={2} maxLength={1500} enterKeyHint="send" placeholder="Type your question"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); } }}
              />
              <button className="btn primary" disabled={busy || !input.trim()}>{busy ? 'Answering' : 'Send'}</button>
            </form>
            <div className="hc-foot">
              {!lastAnswer && person}
              {msgs.length > 0 && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => (setMsgs([]), said.current = 0, boxRef.current?.focus())}>Start again</button>}
              <a className="btn sm ghost" href="/help" {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}>The help page{newTab && <span className="sg-vh"> (opens in a new tab)</span>}</a>
              <details className="hc-kept" data-fold><summary>What we keep</summary>{CHAT_DO_NOT_TYPE} {status?.kept || CHAT_KEPT}</details>
            </div>
          </>
        ) : (
          <div className="hc-person-view">
            <p className="muted small" style={{ marginTop: 0 }}>A person reads every message and answers by email. This works without an account and without signing in.{reason ? ` ${HAND_OVER_TEXT[reason]}` : ''}</p>
            <ContactForm chat={attach && lines.length ? lines : null} onDropChat={() => setAttach(false)} topic={handOverTopic(reason, screen, lastQuestion)} code={code} message={lastQuestion} who={who} />
            <div className="hc-foot"><button type="button" className="btn sm" onClick={() => setView('chat')}>Back to the chat</button></div>
          </div>
        )}
        <div className="sg-vh" aria-live="polite" role="status">{spoken}</div>
      </div>
    </Dialog>
  );
}

/** A Help button that opens the chat. It works out which kind of screen it is on when it is pressed. */
export function HelpChatButton({ className = 'btn sm', children, label }: { className?: string; children?: ReactNode; label?: string }) {
  const [screen, setScreen] = useState<ChatScreen | null>(null);
  return (
    <>
      <button type="button" className={className} aria-haspopup="dialog" aria-label={label} onClick={() => setScreen(screenOf(window.location.pathname, window.location.search))}>
        {children || 'Help'}
      </button>
      {screen && <HelpChat screen={screen} onClose={() => setScreen(null)} />}
    </>
  );
}

/** What a person attached to a help request, for the people who answer it (the operator queue). */
export function AttachedChat({ lines }: { lines: { from: 'you' | 'helper'; text: string; checked: boolean }[] }) {
  return (
    <details className="hc-op" open>
      <summary>Their chat with the helper, before they wrote ({lines.length} message{lines.length === 1 ? '' : 's'})</summary>
      <p className="muted small">As their browser sent it. A line marked &quot;not checked&quot; was not signed by our server, so the helper may never have said it.</p>
      <ol className="hc-attached-list">
        {lines.map((l, i) => <li key={i}><b>{l.from === 'you' ? 'They wrote' : l.checked ? 'Helper' : 'Helper (not checked)'}:</b> {l.text}</li>)}
      </ol>
    </details>
  );
}
