'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/components/ui';
import { TWO_STEP_EMAIL_RESET_DAYS, TWO_STEP_RESET_BLOCK_DAYS } from '@/lib/policy';

const moment = (s: string) => new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });

// The link in every email about a reset under way (?stop=...): it stops it, without signing in (POST
// /auth/two-step/email-reset/stop). Here too a person presses the button, so a mail program that opens links to check
// them stops nothing.
function StopView({ token }: { token: string }) {
  const [state, setState] = useState<'ask' | 'busy' | { again: string | null } | { no: string }>('ask');
  const stop = () => {
    setState('busy');
    api('/auth/two-step/email-reset/stop', { body: { token } })
      .then((r) => setState({ again: r.again_from ? moment(r.again_from) : null }))
      .catch((e) => setState({ no: e?.status ? e.message : 'We could not reach GrowSigning, so nothing was stopped. Check your connection and press the button again.' }));
  };
  return (
    <div className="authbox">
      <div className="card twostep">
        <h1 className="serif" style={{ fontSize: 24 }}>Stop the reset of two-step login</h1>
        {state === 'ask' || state === 'busy' ? (
          <>
            <p>A reset by email of your GrowSigning login is under way: when it takes effect, signing in asks for no code from your phone. If you did not ask for it, stop it here. You do not need to sign in.</p>
            <p className="muted small">If you did ask for it because your phone is lost, close this page: stopping it means a new reset can only be asked for {TWO_STEP_RESET_BLOCK_DAYS} days later.</p>
            <button className="btn primary" disabled={state === 'busy'} onClick={stop}>{state === 'busy' ? 'Stopping…' : 'Stop the reset'}</button>
          </>
        ) : 'again' in state ? (
          <div role="status">
            <p><b>The reset was stopped.</b> Two-step login of your login stays on, and we emailed you that it stopped.{state.again ? ` A new reset by email can be asked for from ${state.again}.` : ''}</p>
            <p>Whoever asked for it typed your password and can read your email. Change both now: the password of your GrowSigning login under Settings, Profile (or with &quot;Forgot password&quot; on the sign-in page), and the password of your mailbox.</p>
          </div>
        ) : (
          <p className="notice err" role="alert">{state.no}</p>
        )}
        <p className="muted small" style={{ marginTop: 14 }}><Link href="/login">Sign in</Link> · <Link href="/help?topic=cannot-log-in#contact">Get help</Link></p>
      </div>
    </div>
  );
}

// The link in the email that starts a reset of two-step login by email (POST /auth/two-step/email-reset). It starts
// nothing on its own: a mail program that opens links to check them must not start a reset, so a person presses the
// button.
export function ResetView() {
  const [token, setToken] = useState<string | null>(null);
  const [stopToken, setStopToken] = useState<string | null>(null);
  const [state, setState] = useState<'ask' | 'busy' | { when: string } | { off: true } | { no: string }>('ask');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setToken(q.get('token'));
    setStopToken(q.get('stop'));
  }, []);
  const start = () => {
    setState('busy');
    api('/auth/two-step/email-reset', { body: { token } })
      .then((r) => setState(r.off ? { off: true } : { when: moment(r.takes_effect_at) }))
      .catch((e) => setState({ no: e?.status ? e.message : 'We could not reach GrowSigning, so nothing was started. Check your connection and press the button again.' }));
  };
  if (stopToken) return <StopView token={stopToken} />;
  return (
    <div className="authbox">
      <div className="card twostep">
        <h1 className="serif" style={{ fontSize: 24 }}>Reset two-step login</h1>
        {state === 'ask' || state === 'busy' ? (
          <>
            <p>For a login whose phone with the authenticator app is lost, together with the recovery codes. When you start it, two-step login of your login is switched off {TWO_STEP_EMAIL_RESET_DAYS} days from now. Every day until then we email you, with a link that stops it, and every browser where you are signed in says so on every page. From then on signing in asks for no code, until you set it up again.</p>
            <p className="muted small">Signing in with your code, a recovery code or a remembered device before then stops it, and so does changing your password while signed in, or the Stop button on any page of the app. If you did not ask for this, close this page: nothing has been started.</p>
            {!token ? <p className="notice err" role="alert">This link is not complete. Open it again from the email, or copy the whole link into the address bar.</p>
              : <button className="btn primary" disabled={state === 'busy'} onClick={start}>{state === 'busy' ? 'Starting…' : `Start the reset (${TWO_STEP_EMAIL_RESET_DAYS} days)`}</button>}
          </>
        ) : 'when' in state ? (
          <p role="status">The reset has started. Two-step login of your login will be switched off on {state.when}. We email you every day until then, and every browser where you are signed in is signed out on that day. After that, sign in with your password and set it up again with your new phone under Settings, Profile.</p>
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
