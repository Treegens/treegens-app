'use client';
// The page behind a document's share link (growsigning.com/<name>): the document's name, who sent it, and "Who are
// you?". The person picks their name, we email a 6-digit code to the address the sender gave for that name, and the
// right code opens their own signing page. The link alone opens nothing. Every rule is the server's
// (src/server/sharelinks.ts); this screen only says them. No address is ever shown here, not even masked.
import { useEffect, useRef, useState } from 'react';
import { api } from '@/components/ui';
import { Mark } from '@/components/Brand';
import { OpenTreesLine } from '@/components/impact/SignerTrees';
import { t } from '@/lib/i18n';
import type { SharePage } from '@/server/sharelinks';

type Person = { key: string; name: string };
type Open = Extract<SharePage, { people: Person[] }>;

export function WhoAreYou({ name, page }: { name: string; page: SharePage | null }) {
  const locale = typeof document !== 'undefined' ? document.documentElement.lang || 'en' : 'en';
  const T = (key: string, vars: Record<string, any> = {}) => t(locale, `share.${key}`, vars);
  const [who, setWho] = useState<Person | null>(null);
  const [sent, setSent] = useState<{ digits: number; minutes: number } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'' | 'send' | 'check'>('');
  const [error, setError] = useState('');
  const [until, setUntil] = useState(0);
  const [left, setLeft] = useState(0);
  const [help, setHelp] = useState(false);
  const head = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  // Each step starts at its heading, so a screen reader says where the person now is.
  useEffect(() => {
    if (who) head.current?.focus();
  }, [who, sent]);

  // Closed, off, renamed, or too many lookups: one plain sentence, and no way in.
  const state = !page ? 'slow' : page.state;
  if (!page || state !== 'open') {
    const open = page && 'people' in page ? (page as Open) : null;
    const sender = open?.sender || T('the_sender');
    return (
      <Frame title={open?.title || null} from={open?.sender ? T('from', { sender: open.sender }) : ''} sentWith={T('sent_with')} helpLabel={T('help')}>
        <h2 className="sl-state">{T(`state.${state}`)}</h2>
        <p className="muted">{T(`state.${state}_body`, { sender })}</p>
      </Frame>
    );
  }
  const open = page as Open;
  const sender = open.sender || T('the_sender');
  const fail = (e: any) => {
    const wait = Number(e?.data?.resend_in);
    if (Number.isFinite(wait) && wait > 0) setUntil(Date.now() + wait * 1000);
    setError(e?.status ? e.message : T('offline'));
  };

  async function send() {
    if (!who) return;
    setBusy('send');
    setError('');
    try {
      const r = await api(`/public/share/${name}/code`, { body: { person: who.key } });
      setSent({ digits: r.digits, minutes: r.minutes });
      setCode('');
      setUntil(Date.now() + (r.resend_in || 60) * 1000);
      window.setTimeout(() => input.current?.focus(), 0);
    } catch (e: any) {
      fail(e);
      // A code sent a moment ago still works: the box to type it in is shown.
      if (e?.data?.code === 'wait' && !sent) setSent({ digits: 6, minutes: 10 });
    } finally {
      setBusy('');
    }
  }
  async function check(ev: React.FormEvent) {
    ev.preventDefault();
    if (!who || !sent) return;
    const digits = code.replace(/\D/g, '');
    if (digits.length !== sent.digits) return void setError(T('code_short', { digits: sent.digits }));
    setBusy('check');
    setError('');
    try {
      const r = await api(`/public/share/${name}/code/check`, { body: { person: who.key, code: digits } });
      // The signing page takes this page's place: Back from it does not bring the code box up again.
      window.location.replace(r.url);
    } catch (e: any) {
      fail(e);
      setBusy('');
    }
  }
  const back = () => (setWho(null), setSent(null), setCode(''), setError(''), setHelp(false));

  return (
    <Frame title={open.title} from={T('from', { sender })} sentWith={T('sent_with')} helpLabel={T('help')}>
      {/* Said on every step, also while the person waits for the code: their signature plants trees. */}
      <OpenTreesLine trees={open.plants} />
      {!who ? (
        open.people.length ? (
          <>
            <h2 className="sl-ask" id="sl-who">{T('who')}</h2>
            <p className="muted sl-hint">{T('who_hint')}</p>
            <ul className="sl-people" aria-labelledby="sl-who">
              {open.people.map((p) => <li key={p.key}><button type="button" className="btn lg sl-person" dir="auto" onClick={() => (setWho(p), setError(''))}>{p.name}</button></li>)}
            </ul>
            {open.later > 0 && <p className="muted small">{T('later', { count: open.later })}</p>}
            <p className="muted small sl-foot">{T('not_listed')}</p>
          </>
        ) : (
          <>
            <h2 className="sl-state">{T('nobody')}</h2>
            <p className="muted">{open.later > 0 ? T('nobody_later') : T('nobody_done')}</p>
          </>
        )
      ) : !sent ? (
        <div className="sg-code">
          <h2 className="sl-ask" ref={head} tabIndex={-1}>{T('is_you', { person: who.name })}</h2>
          <p className="muted sl-hint">{T('send_hint', { sender })}</p>
          {error && <div className="notice err sg-problem" role="alert">{error}</div>}
          <button type="button" className="btn primary lg sl-wide" disabled={!!busy || left > 0} onClick={send}>{busy === 'send' ? T('sending') : T('send_button')}</button>
          {left > 0 && <p className="muted small center" role="status">{T('again_in', { seconds: left })}</p>}
          <button type="button" className="btn lg sl-wide sl-second" disabled={!!busy} onClick={back}>{T('other_button')}</button>
        </div>
      ) : (
        <form className="sg-code" noValidate onSubmit={check}>
          <h2 className="sl-ask" ref={head} tabIndex={-1}>{T('type_code')}</h2>
          <p className="muted sl-hint">{T('code_sent', { digits: sent.digits, minutes: sent.minutes, sender, person: who.name })}</p>
          <label className="f sg-code-box">
            <span>{T('code_label')}</span>
            <input ref={input} className="sg-code-input" value={code} onChange={(e) => (setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, sent.digits + 2)), setError(''))}
              inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" enterKeyHint="go" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={!!error} aria-describedby="sl-says" />
          </label>
          <div id="sl-says">{error && <div className="notice err sg-problem" role="alert">{error}</div>}</div>
          <button className="btn primary lg sl-wide" disabled={!!busy}>{busy === 'check' ? T('checking') : T('open_button')}</button>
          <button type="button" className="btn lg sl-wide sl-second" disabled={!!busy || left > 0} onClick={send}>{busy === 'send' ? T('sending') : T('again_button')}</button>
          {left > 0 && <p className="muted small center" role="status">{T('again_in', { seconds: left })}</p>}
          <details className="sl-help" data-fold="" open={help} onToggle={(e) => setHelp((e.target as HTMLDetailsElement).open)}>
            <summary>{T('no_code_q')}</summary>
            <p className="muted small">{T('no_code_body', { sender })}</p>
            <button type="button" className="btn sl-second" disabled={!!busy} onClick={back}>{T('other_button')}</button>
          </details>
        </form>
      )}
    </Frame>
  );
}

function Frame({ title, from, sentWith, helpLabel, children }: { title: string | null; from: string; sentWith: string; helpLabel: string; children: React.ReactNode }) {
  return (
    <main id="main" className="authbox sl">
      <div className="card">
        <div className="row sl-brand"><Mark size={28} label="" /><span className="muted small">{sentWith}</span></div>
        {title && <h1 className="serif sl-title" dir="auto">{title}</h1>}
        {from && <p className="muted sl-from" dir="auto">{from}</p>}
        {children}
      </div>
      <p className="muted small center sl-helpline"><a href="/help?topic=signing#contact">{helpLabel}</a></p>
    </main>
  );
}
