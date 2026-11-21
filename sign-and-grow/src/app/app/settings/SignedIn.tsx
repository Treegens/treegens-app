'use client';
import { useState } from 'react';
import { api, useLoad, fmtDate } from '@/components/ui';
import { sessionWords } from '@/lib/policy';
import { sessionShort } from '@/lib/settingsnav';

// Where a person is signed in: every browser that holds a session of theirs, as GET /me/sessions lists them. A
// browser stays signed in while it is used (src/server/auth.ts), so this is also where one that should not be
// signed in any more is ended: a phone that was lost, a computer at work.
type Row = { id: string; device: string; browser: string; signed_in_at: string | null; last_used_at: string | null; signs_out_at: string; current: boolean; handed_over: boolean };

export function SignedIn() {
  const [d, reload, failed] = useLoad<{ sessions: Row[]; days: number; max_days: number; noted_every_minutes: number }>(() => api('/me/sessions'));
  const [busy, setBusy] = useState(false);
  // What the last thing done here led to. It stays on screen, and a screen reader is told.
  const [said, setSaid] = useState<{ text: string; err?: boolean } | null>(null);
  const act = (what: () => Promise<any>) => {
    setBusy(true);
    setSaid(null);
    what().catch((e: any) => setSaid({ text: e?.message || 'Something went wrong. Nothing was changed.', err: true })).finally(() => (setBusy(false), reload()));
  };
  if (failed) return <section className="card"><h2 style={{ marginBottom: 4 }}>Where you are signed in</h2><p className="notice err" role="alert">We could not load this list just now. Reload the page to try again.</p></section>;
  if (!d) return null;
  const others = d.sessions.filter((s) => !s.current);
  const name = (s: Row) => (s.browser === 'unknown browser' && s.device === 'Unknown device' ? 'A browser we could not recognise' : `${s.device}, ${s.browser}`);
  return (
    <section className="card" aria-labelledby="where-h">
      <h2 id="where-h" style={{ marginBottom: 4 }}>Where you are signed in</h2>
      <p className="muted small">{sessionShort(d.days, d.max_days)}</p>
      <details data-fold="">
        <summary className="set-fold">How this works</summary>
        <p className="muted small">
          {sessionWords(d.days, d.max_days)}{' '}
          Signing in on another device does not sign this one out. The device and browser are what the browser told us, and &ldquo;last used&rdquo; is noted at most once every {d.noted_every_minutes} minutes.
        </p>
      </details>
      {said && <div className={`notice${said.err ? ' err' : ''}`} role={said.err ? 'alert' : 'status'} style={{ margin: '10px 0' }}>{said.text}</div>}
      <ul className="ways">
        {d.sessions.map((s) => (
          <li key={s.id}>
            <div className="what">
              <b>{name(s)}</b>{s.current && <> <span className="badge completed">This browser</span></>}
              <div className="muted small">
                {s.signed_in_at ? `Signed in ${fmtDate(s.signed_in_at, true)}.` : 'Signed in before we kept this list.'}{' '}
                {s.current ? 'In use now.' : s.last_used_at ? `Last used ${fmtDate(s.last_used_at, true)}.` : 'Not used since.'}{' '}
                {`Signed out by itself on ${fmtDate(s.signs_out_at)}.`}
                {s.handed_over && ' Locked: it was handed to someone to sign in person, and nobody has typed the password there since.'}
              </div>
            </div>
            {!s.current && (
              <button className="btn" disabled={busy} aria-label={`Sign out ${name(s)}, ${s.last_used_at ? `last used ${fmtDate(s.last_used_at, true)}` : 'not used since it signed in'}`}
                onClick={() => act(() => api(`/me/sessions/${s.id}`, { method: 'DELETE' }).then(() => setSaid({ text: `${name(s)} is signed out. Whoever uses it next has to sign in again.` })))}>Sign out</button>
            )}
          </li>
        ))}
      </ul>
      {others.length === 0
        ? <p className="muted small" style={{ margin: '10px 0 0' }}>This is the only browser you are signed in on.</p>
        : (
          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="btn" style={{ minHeight: 44 }} disabled={busy}
              onClick={() => act(() => api('/me/sessions/sign-out-others', { method: 'POST' }).then((r) => setSaid({ text: `Signed out of ${r.signed_out} other ${r.signed_out === 1 ? 'browser' : 'browsers'}. This one stays signed in.${r.two_step_devices_forgotten ? ` ${r.two_step_devices_forgotten === 1 ? 'One other device' : `${r.two_step_devices_forgotten} other devices`} will be asked for the two-step code again.` : ''}` })))}>Sign out everywhere else</button>
            <span className="muted small">Lost a phone, or used a computer that is not yours? This signs out every browser except this one, and if you use two-step login, no other device skips the code any more. Changing your password signs the other browsers out too.</span>
          </div>
        )}
    </section>
  );
}
