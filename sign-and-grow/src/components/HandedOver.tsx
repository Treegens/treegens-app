'use client';
import { useState } from 'react';
import { api, Leaf } from './ui';
import { IN_PERSON_LIMITS } from '@/lib/phone';

// The one screen of the app that a browser shows while it is locked: it was handed to someone to sign in person
// (src/server/handover.ts), and until the owner of the account has typed their password nothing of the account is
// shown or can be reached from here. Shown by AppShell in place of every page under /app.
export type Locked = { name: string; has_password: boolean; signer: string | null; envelope_id: string | null; tries_left?: number };

export function HandedOver({ info, onUnlocked }: { info: Locked; onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [out, setOut] = useState(false);
  const next = typeof window === 'undefined' ? '/app' : window.location.pathname;
  const signIn = `/login?next=${encodeURIComponent(next)}`;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    api('/auth/unlock', { body: { password } }).then(() => onUnlocked())
      .catch((err: any) => {
        setPassword('');
        if (err?.code === 'signed_out') setOut(true);
        // Not locked any more (unlocked in another tab, or the session ran out): let the app find out where it stands.
        if (err?.code === 'not_locked') return onUnlocked();
        setError(err?.status ? err.message : 'We could not reach the server, so nothing was checked. Check your connection and try again.');
      })
      .finally(() => setBusy(false));
  };
  return (
    <main className="authbox ho" aria-labelledby="ho-h">
      <div className="row" style={{ justifyContent: 'center', marginBottom: 14, fontWeight: 700 }}><Leaf color="#1f6f43" /> Sign&Grow</div>
      <div className="card">
        <h1 id="ho-h" className="serif" style={{ fontSize: 22, marginBottom: 8 }}>This device was handed to {info.signer || 'someone'} to sign</h1>
        <p className="muted">So that nobody reaches {info.name}&apos;s account by accident, it is locked in this browser. Nothing was signed out anywhere else and nothing is lost.</p>
        {out ? (
          <>
            <p className="notice err" role="alert">{error}</p>
            <a className="btn primary" style={{ width: '100%', minHeight: 48 }} href={signIn}>Go to the sign-in page</a>
          </>
        ) : info.has_password ? (
          <form onSubmit={submit}>
            {/* The browser is asked not to fill this in by itself: whoever holds the device would only have to tap. */}
            <label className="f"><span>I am {info.name}. My password:</span>
              <input type="password" name="unlock" autoComplete="one-time-code" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={error ? 'ho-err' : undefined} aria-invalid={!!error} />
            </label>
            {error && <p id="ho-err" className="notice err" role="alert">{error}</p>}
            <button className="btn primary" style={{ width: '100%', minHeight: 48 }} disabled={busy || !password}>{busy ? 'Checking…' : `I am ${info.name}. Unlock`}</button>
            <p className="muted small" style={{ margin: '12px 0 0' }}><a href="/forgot">Forgot your password?</a> · <a href={signIn}>Sign in another way</a></p>
          </form>
        ) : (
          <>
            <p>This login has no password, because you sign in with Google or Microsoft. Sign in again that way to come back.</p>
            <a className="btn primary" style={{ width: '100%', minHeight: 48 }} href={signIn}>I am {info.name}. Sign in again</a>
          </>
        )}
      </div>
      <details className="ho-more">
        <summary>What this lock covers, and what it does not</summary>
        <p className="small">It covers Sign&Grow in this browser: no envelope, contact or setting of the account opens here until the password is typed. It does not cover:</p>
        <ul className="small">{IN_PERSON_LIMITS.map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
      <p className="muted small center" style={{ marginTop: 14 }}>Not {info.name}? Please hand the device back to them. <a href="/help">Help</a></p>
    </main>
  );
}
