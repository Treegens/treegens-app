'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, Leaf } from './ui';
// Plain functions and constants only: the rest of that file reads the environment and is for the server.
import { safeNext, signInErrorText, signInNotice, removedText } from '@/lib/signin';

type Mode = 'login' | 'signup' | 'forgot' | 'reset';
type Provider = { id: string; name: string };
const list = (names: string[]) => names.join(' or ');
const TITLE: Record<Mode, string> = { login: 'Welcome back', signup: 'Create your free account', forgot: 'Reset your password', reset: 'Choose a new password' };

export function AuthForm({ mode }: { mode: Mode }) {
  const [f, setF] = useState({ name: '', email: '', password: '', code: '' });
  const [q, setQ] = useState<URLSearchParams | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  // Google and Microsoft, when the operator of this server has switched them on. With none, nothing about them shows.
  const [providers, setProviders] = useState<Provider[]>([]);
  // What a sign-in at Google or Microsoft ended with when it did not sign anyone in. It comes back as a code in the
  // address and is said here in words.
  const [cameBack, setCameBack] = useState('');
  // The address of the login this browser is signed in to already, if any. Continuing with Google or Microsoft here
  // would make that person a second login (the server refuses it and sends them to Settings), so the page says where
  // connecting is done instead.
  const [signedInAs, setSignedInAs] = useState('');
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setQ(p);
    if (p.get('email')) setF((s) => ({ ...s, email: p.get('email')! }));
    if (p.get('code')) setF((s) => ({ ...s, code: p.get('code')! }));
    if (p.get('signin_error')) setCameBack(signInErrorText(p.get('signin_error'), p.get('provider')));
    if (mode === 'login' || mode === 'signup') {
      api('/auth/providers').then((r) => setProviders(r.providers || [])).catch(() => {});
      api('/me').then((r) => setSignedInAs(r?.user?.email || '')).catch(() => {});
    }
  }, [mode]);
  const signOut = () => api('/auth/logout', { method: 'POST' }).then(() => setSignedInAs('')).catch((e) => setError(e.message));
  // The address of a provider's button. An invitation, a code typed into the form and the page to open afterwards
  // travel with it, so nothing is lost on the way through the provider.
  const startAt = (id: string) => {
    const p = new URLSearchParams({ mode });
    if (q?.get('invite')) p.set('invite', q.get('invite')!);
    else if (mode === 'signup' && f.code.trim()) p.set('code', f.code.trim());
    if (q?.get('next')) p.set('next', q.get('next')!);
    return `/api/auth/${id}/start?${p}`;
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setCameBack('');
    try {
      if (mode === 'login' || mode === 'signup') {
        const r = await api(`/auth/${mode}`, { body: { ...f, invite: q?.get('invite') || undefined } });
        // Two-step login: no session yet. The second screen asks for the code (src/server/twostep.ts), and whatever
        // the sign-in carries (an invitation, a closing login) is done after it.
        if (r.two_step) return window.location.assign(`/login/two-step${q?.get('next') ? `?next=${encodeURIComponent(q.get('next')!)}` : ''}`);
        // Someone who already has an account accepts a team invitation by signing in: the server does both in one
        // step. What happened on the way in is said on the first screen of the app, never swallowed.
        // A remembered device is the second step: signing in on it stops a reset of two-step login by email.
        const notice = [signInNotice(r), r.reset_stopped ? 'The reset of your two-step login that was under way has stopped, because you signed in on a device that is remembered for your login.' : ''].filter(Boolean).join(' ');
        try {
          if (r.restored) sessionStorage.setItem('sg_restored', '1');
          if (notice) sessionStorage.setItem('sg_notice', notice);
        } catch {
          /* storage can be unavailable */
        }
        // Only ever to a path on this site (safeNext), whatever the address bar was given.
        window.location.assign(safeNext(q?.get('next')));
      } else if (mode === 'forgot') {
        await api('/auth/forgot', { body: { email: f.email } });
        // The invitation is not lost by resetting a password, but the reset email does not carry it: the person is
        // told to come back through the invitation email, which is what puts them on the team.
        setDone(`If that address has an account, a link to choose a new password is on its way. It works for one hour.${q?.get('invite') ? ' Once you have chosen the new password, open the invitation email again and sign in from its button. That is what puts you on the team.' : ''}`);
      } else {
        const r = await api('/auth/reset', { body: { token: q?.get('token'), password: f.password } });
        // Choosing a password for a login whose address had never been confirmed cuts off a provider that did not
        // stand behind the address. That is said here, so the next sign-in holds no surprise.
        setDone(`Password changed.${r.disconnected?.length ? ` ${r.disconnected.join(' and ')} was disconnected from this login, because this address had not been confirmed before. Once you are signed in you can connect it again under Settings.` : ''}${removedText({ ...r.removed, disconnected: undefined }) ? ` Nobody had confirmed this address before, so anyone could have started this login. ${removedText({ ...r.removed, disconnected: undefined })} We emailed you the same list.` : ''} You can sign in now.${r.two_step ? ' After the password you are asked for the code from your authenticator app, as before: a new password does not change the second step.' : ''}`);
      }
    } catch (err: any) {
      // Someone whose login was made with Google or Microsoft has no password to get right. The server does not say
      // whether that is the case for this address, so the hint goes to everyone whose password did not match.
      setError(err.message + (mode === 'login' && err.status === 401 && providers.length ? ` If you made your login with ${list(providers.map((p) => p.name))}, use that button below instead. To choose a password for it, use "Forgot password".` : ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="authbox">
      <Link href="/" className="logo" style={{ marginBottom: 20 }}><Leaf color="#1f6f43" size={24} /> GrowSigning</Link>
      <form className="card" onSubmit={submit}>
        <h1 className="serif" style={{ fontSize: 24, marginBottom: 6 }}>{TITLE[mode]}</h1>
        {mode === 'signup' && <p className="muted small">{q?.get('invite') ? 'You were invited to join a team.' : 'Free to start. No card needed. Every subscription plants trees.'}</p>}
        {mode === 'login' && q?.get('invite') && <p className="muted small">You were invited to join a team. Sign in and you are on it. Anything you already have on GrowSigning stays as it is.</p>}
        {mode === 'forgot' && q?.get('invite') && <p className="muted small">Your invitation stays valid while you do this. After you have chosen a new password, open the invitation email again and sign in from its button.</p>}
        {mode === 'login' && q?.get('closing') && <div className="notice" style={{ marginTop: 10 }}>Your account is closed and will be deleted in 30 days. Any subscription has been stopped. Changed your mind? Sign in and it comes straight back.</div>}
        {cameBack && <div className="notice err" style={{ marginTop: 10 }} role="alert">{cameBack}</div>}
        {done ? <div className="notice" style={{ margin: '12px 0' }}>{done} <Link href="/login">Sign in</Link></div> : (
          <div style={{ marginTop: 14 }}>
            {mode === 'signup' && <label className="f"><span>Your name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoComplete="name" autoFocus /></label>}
            {mode !== 'reset' && <label className="f"><span>Email</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoComplete="email" readOnly={mode === 'signup' && !!q?.get('invite')} /></label>}
            {mode !== 'forgot' && <label className="f"><span>{mode === 'reset' ? 'New password' : 'Password'} {mode !== 'login' && <span className="hint">(at least 8 characters)</span>}</span><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={mode === 'login' ? 1 : 8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>}
            {mode === 'signup' && !q?.get('invite') && <label className="f"><span>Code <span className="hint">(optional, if you were given one)</span></span><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} autoComplete="off" /></label>}
            {error && <div className="notice err" style={{ marginBottom: 12 }} role="alert">{error}</div>}
            <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Save password'}</button>
            {(mode === 'login' || mode === 'signup') && providers.length > 0 && signedInAs && !q?.get('invite') && (
              <div className="auth-alt" role="group" aria-label="You are signed in already">
                <p className="auth-or" aria-hidden="true"><span>or</span></p>
                <p className="notice" style={{ margin: '8px 0 0' }}>You are signed in as {signedInAs} in this browser. To sign in with {list(providers.map((p) => p.name))} as well, connect it under Settings, Profile: continuing with it here would make you a separate login. To use another login, sign out first.</p>
                <a className="btn" href="/app/settings?tab=profile">Open Settings, Profile</a>
                <button type="button" className="btn" onClick={signOut}>Sign out</button>
              </div>
            )}
            {(mode === 'login' || mode === 'signup') && providers.length > 0 && (!signedInAs || !!q?.get('invite')) && (
              <div className="auth-alt" role="group" aria-label={mode === 'login' ? 'Other ways to sign in' : 'Other ways to create your account'}>
                <p className="auth-or" aria-hidden="true"><span>or</span></p>
                {/* The providers' names in plain text. Real links, so they work by keyboard and without scripts. */}
                {providers.map((p) => <a key={p.id} className="btn" href={startAt(p.id)}>Continue with {p.name}</a>)}
                <p className="muted small" style={{ margin: '10px 0 0' }}>
                  {mode === 'signup'
                    ? `You sign in at ${list(providers.map((p) => p.name))} and need no password here. We take your name, your email address and the id they know you by, and nothing else.${q?.get('invite') ? ' Choose the account with the address you were invited at.' : ''}`
                    : `No GrowSigning login yet? Continuing with ${list(providers.map((p) => p.name))} makes one for you.`}
                </p>
              </div>
            )}
          </div>
        )}
      </form>
      <p className="muted small center" style={{ marginTop: 14 }}>
        {mode === 'login' ? <>New here? <Link href={`/signup${q?.get('invite') ? `?invite=${q.get('invite')}&email=${encodeURIComponent(f.email)}` : ''}`}>Create an account</Link> · <Link href={`/forgot${q?.get('invite') ? `?invite=${q.get('invite')}&email=${encodeURIComponent(f.email)}` : ''}`}>Forgot password?</Link></> : <>Already have an account? <Link href={`/login${q?.get('invite') ? `?invite=${q.get('invite')}&email=${encodeURIComponent(f.email)}` : ''}`}>Sign in</Link></>}
        {/* Whichever form this is, a person is one click away, also for someone who cannot get in at all. */}
        {' · '}<Link href={mode === 'signup' ? '/help' : '/help?topic=cannot-log-in#contact'}>{mode === 'signup' ? 'Help' : 'Cannot get in? Get help'}</Link>
      </p>
    </div>
  );
}
