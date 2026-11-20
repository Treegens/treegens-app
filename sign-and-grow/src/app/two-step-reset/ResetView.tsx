'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/components/ui';
import { TWO_STEP_EMAIL_RESET_DAYS } from '@/lib/policy';

// The link in the email that starts a reset of two-step login by email (POST /auth/two-step/email-reset). It starts
// nothing on its own: a mail program that opens links to check them must not start a reset, so a person presses the
// button.
export function ResetView() {
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<'ask' | 'busy' | { when: string } | { off: true } | { no: string }>('ask');
  useEffect(() => setToken(new URLSearchParams(window.location.search).get('token')), []);
  const start = () => {
    setState('busy');
    api('/auth/two-step/email-reset', { body: { token } })
      .then((r) => setState(r.off ? { off: true } : { when: new Date(r.takes_effect_at).toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }) }))
      .catch((e) => setState({ no: e?.status ? e.message : 'We could not reach Sign&Grow, so nothing was started. Check your connection and press the button again.' }));
  };
  return (
    <div className="authbox">
      <div className="card twostep">
        <h1 className="serif" style={{ fontSize: 24 }}>Reset two-step login</h1>
        {state === 'ask' || state === 'busy' ? (
          <>
            <p>For a login whose phone with the authenticator app is lost, together with the recovery codes. When you start it, two-step login of your login is switched off {TWO_STEP_EMAIL_RESET_DAYS} days from now. We email you when it starts and every day until then. From then on your password alone signs in, until you set it up again.</p>
            <p className="muted small">Signing in with your code or a recovery code before then stops it, and so does Stop under Settings in a browser where you are still signed in. If you did not ask for this, close this page: nothing has been started.</p>
            {!token ? <p className="notice err" role="alert">This link is not complete. Open it again from the email, or copy the whole link into the address bar.</p>
              : <button className="btn primary" disabled={state === 'busy'} onClick={start}>{state === 'busy' ? 'Starting…' : `Start the reset (${TWO_STEP_EMAIL_RESET_DAYS} days)`}</button>}
          </>
        ) : 'when' in state ? (
          <p role="status">The reset has started. Two-step login of your login will be switched off on {state.when}. We email you every day until then. After that, sign in with your password and set it up again with your new phone under Settings, Profile.</p>
        ) : 'off' in state ? (
          <p role="status">Two-step login is already off for this login, so there is nothing to reset. <Link href="/login">Sign in</Link> with your password.</p>
        ) : (
          <p className="notice err" role="alert">{state.no}</p>
        )}
        <p className="muted small" style={{ marginTop: 14 }}><Link href="/login">Sign in</Link> · <Link href="/help?topic=cannot-log-in#contact">Get help</Link></p>
      </div>
    </div>
  );
}
