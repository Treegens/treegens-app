'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/components/ui';

// The link in the email that moves a login to a new address (POST /me/email/confirm, src/server/routes-bounces.ts).
// It works only in a browser that is signed in to that login, so a stranger who gets the email can do nothing with it.
// People open it from a phone: every control is at least 44 pixels tall.
const TAP = { minHeight: 44 };

export default function ChangeEmail() {
  const [state, setState] = useState<'wait' | 'signin' | { ok: string } | { no: string }>('wait');
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) return setState({ no: 'This link is not complete. Open it again from the email, or copy the whole link into the address bar.' });
    api('/me/email/confirm', { body: { token } })
      .then((r) => setState({ ok: r.email }))
      .catch((e) => setState(e?.status === 401 ? 'signin' : { no: e?.status ? e.message : 'We could not reach Sign&Grow, so nothing was changed. Check your connection and open the link again.' }));
  }, []);
  const next = typeof window === 'undefined' ? '/app' : `${window.location.pathname}${window.location.search}`;
  return (
    <div className="authbox">
      <div className="card center">
        <h1 className="serif" style={{ fontSize: 24 }}>{state === 'wait' ? 'Changing your address…' : state === 'signin' ? 'Sign in first' : 'ok' in state ? 'Your address is changed' : 'That did not work'}</h1>
        <p className="muted" role="status" style={{ margin: '10px 0 16px' }}>
          {state === 'wait' ? ''
            : state === 'signin' ? 'This link moves a Sign&Grow login to a new email address. It works in a browser that is signed in to that login. Sign in with your current address, and you come straight back here.'
            : 'ok' in state ? `From now on you sign in with ${state.ok}, and our emails go there. Other browsers were signed out, and we told your old address about the change.`
            : state.no}
        </p>
        {state === 'signin' ? <Link href={`/login?next=${encodeURIComponent(next)}`} className="btn primary" style={TAP}>Sign in</Link>
          : state !== 'wait' && <Link href="/app" className="btn primary" style={TAP}>Go to Sign&Grow</Link>}
      </div>
      <p className="muted small center" style={{ marginTop: 14 }}>Did not ask for this? Then close this page. Nothing changes without it. <Link href="/help#contact">Need a hand? Get help</Link></p>
    </div>
  );
}
