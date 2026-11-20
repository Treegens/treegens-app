'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, Leaf } from './ui';

type Mode = 'login' | 'signup' | 'forgot' | 'reset';
const TITLE: Record<Mode, string> = { login: 'Welcome back', signup: 'Create your free account', forgot: 'Reset your password', reset: 'Choose a new password' };

export function AuthForm({ mode }: { mode: Mode }) {
  const [f, setF] = useState({ name: '', email: '', password: '', code: '' });
  const [q, setQ] = useState<URLSearchParams | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setQ(p);
    if (p.get('email')) setF((s) => ({ ...s, email: p.get('email')! }));
    if (p.get('code')) setF((s) => ({ ...s, code: p.get('code')! }));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'login' || mode === 'signup') {
        const r = await api(`/auth/${mode}`, { body: { ...f, invite: q?.get('invite') || undefined } });
        // Someone who already has an account accepts a team invitation by signing in: the server does both in one
        // step. What happened on the way in is said on the first screen of the app, never swallowed.
        const notice = r.invite_error ? `You are signed in, but you did not join the team. ${r.invite_error}`
          : r.joined ? `You have joined ${r.joined}. If you have a workspace of your own, it is still there: switch between them at the bottom of the menu.`
          : r.fresh ? 'You are no longer on a team, so we made you a workspace of your own. Documents sent to you are in your inbox, and a team can invite you again at any time.' : '';
        try {
          if (r.restored) sessionStorage.setItem('sg_restored', '1');
          if (notice) sessionStorage.setItem('sg_notice', notice);
        } catch {
          /* storage can be unavailable */
        }
        const next = q?.get('next');
        window.location.assign(next && next.startsWith('/') && !next.startsWith('//') ? next : '/app');
      } else if (mode === 'forgot') {
        await api('/auth/forgot', { body: { email: f.email } });
        setDone('If that address has an account, a reset link is on its way.');
      } else {
        await api('/auth/reset', { body: { token: q?.get('token'), password: f.password } });
        setDone('Password changed. You can sign in now.');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="authbox">
      <Link href="/" className="logo" style={{ marginBottom: 20 }}><Leaf color="#1f6f43" size={24} /> Sign&Grow</Link>
      <form className="card" onSubmit={submit}>
        <h1 className="serif" style={{ fontSize: 24, marginBottom: 6 }}>{TITLE[mode]}</h1>
        {mode === 'signup' && <p className="muted small">{q?.get('invite') ? 'You were invited to join a team.' : 'Free to start. No card needed. Every subscription plants trees.'}</p>}
        {mode === 'login' && q?.get('invite') && <p className="muted small">You were invited to join a team. Sign in and you are on it. Anything you already have on Sign&Grow stays as it is.</p>}
        {mode === 'login' && q?.get('closing') && <div className="notice" style={{ marginTop: 10 }}>Your account is closed and will be deleted in 30 days. Any subscription has been stopped. Changed your mind? Sign in and it comes straight back.</div>}
        {done ? <div className="notice" style={{ margin: '12px 0' }}>{done} <Link href="/login">Sign in</Link></div> : (
          <div style={{ marginTop: 14 }}>
            {mode === 'signup' && <label className="f"><span>Your name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoComplete="name" autoFocus /></label>}
            {mode !== 'reset' && <label className="f"><span>Email</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoComplete="email" readOnly={mode === 'signup' && !!q?.get('invite')} /></label>}
            {mode !== 'forgot' && <label className="f"><span>{mode === 'reset' ? 'New password' : 'Password'} {mode !== 'login' && <span className="hint">(at least 8 characters)</span>}</span><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={mode === 'login' ? 1 : 8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>}
            {mode === 'signup' && !q?.get('invite') && <label className="f"><span>Code <span className="hint">(optional, if you were given one)</span></span><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} autoComplete="off" /></label>}
            {error && <div className="notice err" style={{ marginBottom: 12 }} role="alert">{error}</div>}
            <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Save password'}</button>
          </div>
        )}
      </form>
      <p className="muted small center" style={{ marginTop: 14 }}>
        {mode === 'login' ? <>New here? <Link href={`/signup${q?.get('invite') ? `?invite=${q.get('invite')}&email=${encodeURIComponent(f.email)}` : ''}`}>Create an account</Link> · <Link href="/forgot">Forgot password?</Link></> : <>Already have an account? <Link href={`/login${q?.get('invite') ? `?invite=${q.get('invite')}&email=${encodeURIComponent(f.email)}` : ''}`}>Sign in</Link></>}
        {/* Whichever form this is, a person is one click away, also for someone who cannot get in at all. */}
        {' · '}<Link href={mode === 'signup' ? '/help' : '/help?topic=cannot-log-in#contact'}>{mode === 'signup' ? 'Help' : 'Cannot get in? Get help'}</Link>
      </p>
    </div>
  );
}
