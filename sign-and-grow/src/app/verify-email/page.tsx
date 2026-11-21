'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/components/ui';
import { sayConfirmed } from '@/components/ConfirmEmail';
import { Logo } from '@/components/Brand';

// People open this link from an email, often on a phone: every control is at least 44 pixels tall.
const TAP = { minHeight: 44 };

export default function VerifyEmail() {
  // 'password' and 'signin': the link was opened in a browser that is not signed in to the login it confirms. The
  // link shows that someone can read the mailbox. That they also made the login is shown by its password, or by
  // signing in first, so nobody confirms a login that somebody else made in their name.
  const [state, setState] = useState<'wait' | 'ok' | 'password' | 'signin' | string>('wait');
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = (pw?: string) => {
    setBusy(true);
    return api('/auth/verify', { body: { token: new URLSearchParams(window.location.search).get('token'), ...(pw ? { password: pw } : {}) } })
      // The tab the person signed up in hears it and drops its banner by itself (ConfirmEmail.tsx).
      .then(() => (setState('ok'), sayConfirmed()))
      .catch((e) => {
        if (e.code === 'password_needed') (setState('password'), setWrong(pw ? e.message : ''));
        else if (e.code === 'sign_in_first') setState('signin');
        else setState(e.message);
      })
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    void confirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const asking = state === 'password' || state === 'signin';
  return (
    <div className="authbox">
      {/* People land here from an email and look for whose page it is: the same logo as on the sign-in page. */}
      <Link href="/" className="logo" style={{ marginBottom: 20 }}><Logo height={26} /></Link>
      <div className="card center">
        <h1 className="serif" style={{ fontSize: 24 }}>{state === 'wait' ? 'Confirming…' : state === 'ok' ? 'Email confirmed' : asking ? 'One more step' : 'That did not work'}</h1>
        {state === 'password' && (
          <form onSubmit={(ev) => (ev.preventDefault(), void confirm(password))} style={{ textAlign: 'left', marginTop: 10 }}>
            <p className="muted" style={{ marginBottom: 12 }}>This link confirms the email address of a GrowSigning login. To show that the login is yours, type the password you chose when you signed up.</p>
            <label className="f"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(ev) => setPassword(ev.target.value)} autoFocus style={TAP} /></label>
            {wrong && <p className="notice warn" role="alert" style={{ marginBottom: 12 }}>{wrong}</p>}
            <button className="btn primary" disabled={busy || !password} style={TAP}>{busy ? 'Checking…' : 'Confirm my email'}</button>
            {/* The link for a new password goes to this same mailbox, so choosing one confirms the address too. */}
            <p className="muted small" style={{ marginTop: 12 }}>Forgotten it? <Link href="/forgot">Choose a new password</Link>. We email the link for that to this same address, so it confirms your address too.</p>
            <p className="muted small" style={{ marginTop: 12 }}>Did not sign up for GrowSigning? Then close this page. Nothing is confirmed, and that login can never send anything or see what was sent to you.</p>
          </form>
        )}
        {state === 'signin' && <p className="muted" style={{ margin: '10px 0 16px' }}>This link confirms the email address of a GrowSigning login that has no password, because it was made by signing in with Google or Microsoft. Sign in the same way first, then open the link in the email again in this browser. If you did not sign up for GrowSigning, close this page: nothing was confirmed.</p>}
        {!asking && <p className="muted" style={{ margin: '10px 0 16px' }}>{state === 'ok' ? 'Documents sent to this address now show up under To sign.' : state === 'wait' ? '' : state}</p>}
        {state === 'signin' ? <Link href="/login" className="btn primary" style={TAP}>Sign in</Link> : state !== 'password' && <Link href="/app" className="btn primary" style={TAP}>Go to GrowSigning</Link>}
      </div>
      <p className="muted small center" style={{ marginTop: 14 }}>{state !== 'wait' && state !== 'ok' && !asking ? 'You can ask for a new code or email at the top of the app, once you are signed in. ' : state === 'password' ? 'Signed up in another browser? You can also sign in here first and open the link again. ' : ''}<Link href="/help#contact">Need a hand? Get help</Link></p>
    </div>
  );
}
