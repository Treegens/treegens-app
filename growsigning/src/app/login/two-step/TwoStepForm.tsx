'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/components/ui';
import { Logo } from '@/components/Brand';
import { CodeField } from '@/components/TwoStep';
import { safeNext, signInNotice } from '@/lib/signin';
import { TWO_STEP_LOST, TWO_STEP_REMEMBER_DAYS, TWO_STEP_SIGNIN_MINUTES } from '@/lib/policy';

// The second screen of signing in, after the password or after Google or Microsoft (POST /auth/two-step). It shows
// the same thing after a right and a wrong password, because the server answers both the same way: only after the
// code does it say that one of the two was not right, and it never says which.
export function TwoStepForm() {
  const [state, setState] = useState<any>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);
  const [lost, setLost] = useState<'' | 'open' | 'sent'>('');
  // After Google or Microsoft no password was typed, and a reset by email needs it: asked for here (password_asked).
  const [lostPw, setLostPw] = useState('');
  const [busy, setBusy] = useState(false);
  // The page to open afterwards, from the address bar of the password page. Read once the page runs in the browser.
  const [nextPage, setNextPage] = useState<string | null>(null);
  useEffect(() => {
    setNextPage(new URLSearchParams(window.location.search).get('next'));
    api('/auth/two-step').then(setState).catch(() => setState({ waiting: false }));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/auth/two-step', { body: { code, remember } });
      // What the sign-in did on the way (a team joined, a closing login back, Google connected), said on the first
      // screen of the app, as the other sign-in pages do.
      const said = [signInNotice(r),
        r.used === 'recovery' ? `You signed in with a recovery code. ${r.recovery_left === 0 ? 'That was your last one: make new ones now under Settings, Security, Two-step login.' : `${r.recovery_left} ${r.recovery_left === 1 ? 'is' : 'are'} left. You can make new ones under Settings, Security.`}` : '',
        r.reset_stopped ? 'The reset of your two-step login that was under way has stopped, because you signed in with your code.' : ''].filter(Boolean).join(' ');
      try {
        if (r.restored) sessionStorage.setItem('sg_restored', '1');
        if (said) sessionStorage.setItem('sg_notice', said);
      } catch {
        /* storage can be unavailable */
      }
      window.location.assign(safeNext(r.next || nextPage));
    } catch (err: any) {
      setError({ text: err.message, code: err.code });
      if (err.code !== 'two_step_paused') setCode('');
    } finally {
      setBusy(false);
    }
  }
  const sendLost = () => {
    setBusy(true);
    api('/auth/two-step/lost', { body: state?.password_asked ? { password: lostPw } : { asked: true } }).then(() => setLost('sent')).catch((e: any) => setError({ text: e.message, code: e.code })).finally(() => setBusy(false));
  };

  const again = <Link href={`/login${nextPage ? `?next=${encodeURIComponent(nextPage)}` : ''}`}>Start again with your password</Link>;
  return (
    <div className="authbox">
      <Link href="/" className="logo" style={{ marginBottom: 20 }}><Logo height={26} /></Link>
      <div className="card twostep">
        <h1 className="serif" style={{ fontSize: 24, marginBottom: 6 }}>Two-step login</h1>
        {!state ? <p className="muted" role="status">One moment…</p> : !state.waiting ? (
          <>
            <p role="status">This sign-in is no longer waiting for a code. It waits {TWO_STEP_SIGNIN_MINUTES} minutes, only in the browser where it started.</p>
            <p>{again}.</p>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="muted small">{state.via ? `${state.via} has said who you are. Your login also asks` : 'Your login asks, after the password,'} for a code from the authenticator app on your phone.</p>
            {state.paused_until && !error && <div className="notice warn" role="status" style={{ margin: '10px 0' }}>Too many wrong codes were typed for this login, so its second step is paused until {new Date(state.paused_until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. Wait until then, then type the newest code from your app, or a recovery code.</div>}
            <CodeField id="ts-signin" value={code} onChange={setCode} recovery={recovery} autoFocus label={recovery ? 'Recovery code' : 'Code from your authenticator app'} />
            <button type="button" className="btn ghost" style={{ marginBottom: 8 }} onClick={() => (setRecovery(!recovery), setCode(''))}>{recovery ? 'Use the code from the app instead' : 'Use a recovery code instead'}</button>
            <label className="setting-row" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} aria-describedby="ts-remember-hint" />
              <span>Remember this device for {TWO_STEP_REMEMBER_DAYS} days<span id="ts-remember-hint" className="muted small" style={{ display: 'block' }}>Then this browser asks only for your password. Only on a device of your own. You can withdraw it under Settings, Security, &quot;Devices that skip the second step&quot;.</span></span>
            </label>
            {error && (
              <div className="notice err" role="alert" style={{ margin: '12px 0' }}>
                {error.text}
                {(error.code === 'two_step_expired' || error.code === 'wrong_code') && <div style={{ marginTop: 6 }}>{again}.</div>}
              </div>
            )}
            <button className="btn primary" style={{ width: '100%', marginTop: 6 }} disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Sign in'}</button>
            <div style={{ marginTop: 16 }}>
              {lost === '' && <button type="button" className="btn ghost" onClick={() => setLost('open')}>I lost my phone and my recovery codes</button>}
              {lost === 'open' && (
                <div className="ts-rules">
                  <b>Getting in without your phone</b>
                  <ul className="rules">{TWO_STEP_LOST.map((l) => <li key={l}>{l}</li>)}</ul>
                  <p className="small">We email the address of your login what you can do: the link that starts a reset by email, or who on your team can reset it. A reset by email needs the right password.</p>
                  {state.password_asked && (
                    <label className="f" htmlFor="ts-lost-pw"><span>Your password</span>
                      <input id="ts-lost-pw" type="password" autoComplete="current-password" value={lostPw} onChange={(e) => setLostPw(e.target.value)} />
                      <span className="hint">You signed in with {state.via}, so type the password of your GrowSigning login here. If it has none yet, choose one first with &quot;Forgot password&quot; on the sign-in page.</span>
                    </label>
                  )}
                  <button type="button" className="btn" disabled={busy || (state.password_asked && !lostPw)} onClick={sendLost}>Email me what to do</button>
                </div>
              )}
              {lost === 'sent' && (
                <div className="notice" role="status">
                  If the password you typed was right, we sent an email to the address of your login. It says what you can do next. If nothing arrives within a few minutes, the password may not have been right: start again with it.
                </div>
              )}
            </div>
            <p className="muted small" style={{ marginTop: 16 }}>{again} · <Link href="/help?topic=cannot-log-in#contact">Cannot get in? Get help</Link></p>
          </form>
        )}
      </div>
    </div>
  );
}
