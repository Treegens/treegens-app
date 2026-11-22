'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/components/ui';
import { PAIR_LENGTH, cleanCode, CANNOT_CHECK_ID } from '@/lib/counter';
import '../../styles/counter.css';

// The screen facing the person at a service counter (src/server/counter.ts). The official's screen shows a short
// code; typed or scanned here, it connects this screen to that one person, once. The document opens when the
// official has recorded who they are, and "Next person" clears everything before the next one.
export default function ScreenPage() {
  return <Suspense fallback={null}><Screen /></Suspense>;
}

function forget() {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* storage can be unavailable: nothing was kept there then */
  }
}

function Screen() {
  const q = useSearchParams();
  const [state, setState] = useState<any>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  async function look() {
    try {
      const s = await api('/counter/screen');
      if (s.state === 'ready' && s.url) return window.location.replace(s.url);
      setState(s);
    } catch {
      setState({ state: 'none' });
    }
  }
  async function connect(raw: string) {
    setBusy(true);
    setError('');
    try {
      const s = await api('/counter/screen', { body: { code: raw } });
      // The code leaves the address bar, so it is not in this tab's history for the next person.
      window.history.replaceState(null, '', '/counter/screen');
      if (s.state === 'ready' && s.url) return window.location.replace(s.url);
      setState(s);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      // "Next person": everything this browser kept for the last one goes, here and on the server.
      if (q.get('next') === '1') {
        forget();
        await api('/counter/screen/next', { method: 'POST' }).catch(() => {});
        window.history.replaceState(null, '', '/counter/screen');
        return setState({ state: 'none' });
      }
      const given = q.get('code');
      if (given) return connect(given);
      look();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // While the official checks who they are, this screen asks again every few seconds.
  useEffect(() => {
    if (state?.state !== 'waiting') return;
    const t = setInterval(look, 3000);
    return () => clearInterval(t);
  }, [state?.state]);

  if (!state) return <main className="ct-screen" />;
  return (
    <main className="ct-screen" data-feature="gov-G18">
      <div className="ct-screen-card">
        {state.state === 'waiting' && (
          <>
            <h1>Hello, {state.name}</h1>
            <p role="status">The official is checking who you are. Your document opens here when they are done.</p>
            <p className="muted small">{CANNOT_CHECK_ID}</p>
          </>
        )}
        {state.state === 'done' && (
          <>
            <h1>You have finished</h1>
            <p>Thank you. Please hand the screen back to the official. They give you your receipt.</p>
            <button type="button" className="btn primary" onClick={() => window.location.replace('/counter/screen?next=1')}>Next person</button>
          </>
        )}
        {state.state === 'closed' && (
          <>
            <h1>Signing has stopped</h1>
            <p>This document is no longer open for signing, so nothing was signed here. Please hand the screen back to the official. They tell you what happens next.</p>
            <button type="button" className="btn primary" onClick={() => window.location.replace('/counter/screen?next=1')}>Next person</button>
          </>
        )}
        {state.state === 'none' && (
          <form onSubmit={(e) => (e.preventDefault(), connect(code))}>
            <h1>Sign at the counter</h1>
            <label htmlFor="ct-code"><p>Type the code on the official&apos;s screen.</p></label>
            <input id="ct-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={PAIR_LENGTH + 2} autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-describedby={error ? 'ct-err' : undefined} />
            {error && <p id="ct-err" className="ct-error" role="alert">{error}</p>}
            <button className="btn primary" disabled={busy || !cleanCode(code)}>Connect</button>
            <p className="muted small" style={{ marginTop: 14 }}>{CANNOT_CHECK_ID}</p>
          </form>
        )}
      </div>
    </main>
  );
}
