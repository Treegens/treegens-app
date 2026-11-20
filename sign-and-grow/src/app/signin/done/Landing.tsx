'use client';
import { useEffect, useRef } from 'react';
import { safeNext, signInNotice, SIGNIN_NOTE_COOKIE, type SignInNote } from '@/lib/signin';

// Where the browser lands after signing in with Google or Microsoft. The server could not talk to this tab on the
// way through the provider, so it left what the sign-in did in a short-lived cookie. This page hands that to the
// app the same way the password form does (it is said on the first screen), clears the cookie, and moves on.
export function Landing() {
  const moved = useRef(false);
  useEffect(() => {
    // Once: a second run would find the cookie gone and start the same move again.
    if (moved.current) return;
    moved.current = true;
    let note: SignInNote = {};
    try {
      // Over https only the cookie with the "__Host-" prefix counts: no other site can have put that one there.
      const https = window.location.protocol === 'https:';
      const name = `${https ? '__Host-' : ''}${SIGNIN_NOTE_COOKIE}`;
      const raw = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
      if (raw) note = JSON.parse(decodeURIComponent(raw.slice(name.length + 1))) || {};
      document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${https ? '; Secure' : ''}`;
    } catch {
      /* a cookie we cannot read says nothing */
    }
    try {
      if (note.restored) sessionStorage.setItem('sg_restored', '1');
      const said = signInNotice(note);
      if (said) sessionStorage.setItem('sg_notice', said);
    } catch {
      /* storage can be unavailable */
    }
    // Only ever to a path on this site, whatever the address bar was given.
    window.location.replace(safeNext(new URLSearchParams(window.location.search).get('next')));
  }, []);
  return (
    <main className="muted center" style={{ padding: 80 }}>
      <p role="status">Signing you in…</p>
      <p className="small"><a href="/app">Continue to Sign&Grow</a> if this page stays.</p>
    </main>
  );
}
