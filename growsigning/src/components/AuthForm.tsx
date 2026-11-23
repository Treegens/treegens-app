'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from './ui';
import { Logo } from './Brand';
// Plain functions and constants only: the rest of that file reads the environment and is for the server.
import { safeNext, signInErrorText, signInNotice, removedText } from '@/lib/signin';
// Why a sign-in rule of the team signed this browser out: only its two known reasons are ever said.
import { signedOutNotice } from '@/lib/signinrules';
import { useSso, SsoChoice } from './SsoSignIn';
import { usePublicT } from './publicLang';
import { PRICING } from '@/lib/impact';
// The rules for a new login (src/lib/signup.ts): no + in the address, and a phone number.
import { plusInEmail } from '@/lib/signup';
import { PhoneField, usePhone, phoneBody, phoneProblem } from './PhoneField';

type Mode = 'login' | 'signup' | 'forgot' | 'reset';
type Provider = { id: string; name: string };
// "Google or Microsoft": the names of the providers, in the page's language.
const listIn = (T: ReturnType<typeof usePublicT>, names: string[]) => names.reduce((a, b) => (a ? T('auth.or_list', { a, b }) : b), '');

export function AuthForm({ mode }: { mode: Mode }) {
  const T = usePublicT();
  const list = (names: string[]) => listIn(T, names);
  const [f, setF] = useState({ name: '', email: '', password: '', code: '' });
  const [q, setQ] = useState<URLSearchParams | null>(null);
  // The phone number of a new login, with the country picker on the country of the browser's language.
  const [phone, setPhone] = usePhone();
  // Said under the email box the moment a + is typed: a new login cannot be made with one.
  const plus = mode === 'signup' && plusInEmail(f.email);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  // Google and Microsoft, when the operator of this server has switched them on. With none, nothing about them shows.
  const [providers, setProviders] = useState<Provider[]>([]);
  // What a sign-in at Google or Microsoft ended with when it did not sign anyone in. It comes back as a code in the
  // address and is said here in words.
  const [cameBack, setCameBack] = useState('');
  // "You were signed out because ...", when a rule of the team did it (src/server/secpolicy.ts).
  const [out, setOut] = useState('');
  // The address of the login this browser is signed in to already, if any. Continuing with Google or Microsoft here
  // would make that person a second login (the server refuses it and sends them to Settings), so the page says where
  // connecting is done instead.
  const [signedInAs, setSignedInAs] = useState('');
  // Invite a friend (src/server/referrals.ts): how many free signatures the invite in the address brings, 0 without
  // one. The server keeps the code in a cookie of this browser, so it also counts after Google or Microsoft. Who sent
  // the invite is never shown.
  const [friend, setFriend] = useState(0);
  // Single sign-on of an organisation (src/server/orgsso.ts): looked up as the person leaves the email box. With it,
  // the password box gives way in place to "Continue with <name> sign-in" (research/ux-notes.json, ds-sso-oidc).
  const sso = useSso(mode, f.email);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setQ(p);
    if (p.get('email')) {
      setF((s) => ({ ...s, email: p.get('email')! }));
      if (mode === 'login' || mode === 'signup') sso.look(p.get('email')!);
    }
    if (p.get('sso_error')) sso.setError(p.get('sso_error')!);
    if (p.get('code')) setF((s) => ({ ...s, code: p.get('code')! }));
    if (p.get('signin_error')) setCameBack(signInErrorText(p.get('signin_error'), p.get('provider')));
    if (mode === 'signup' && p.get('ref') && !p.get('invite')) api(`/public/referrals/${encodeURIComponent(p.get('ref')!)}`).then((r) => setFriend(r?.ok ? Number(r.signatures) || 0 : 0)).catch(() => {});
    if (mode === 'login' || mode === 'signup') {
      api('/auth/providers').then((r) => setProviders(r.providers || [])).catch(() => {});
      api('/me').then((r) => {
        setSignedInAs(r?.user?.email || '');
        // "You were signed out" only when the server says a rule signed this browser out, not because an address says so.
        if (mode === 'login') setOut(signedOutNotice(p.get('out'), r));
      }).catch(() => {});
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
    // The organisation signs this address in: Enter in the email box goes there too.
    if ((mode === 'login' || mode === 'signup') && sso.active) return window.location.assign(sso.startUrl(q));
    // Said here in the same words the server uses, so nobody waits for a refusal they could have read at once.
    if (plus) return setError(T('auth.plus_email'));
    const wrongPhone = mode === 'signup' ? phoneProblem(phone, T.lang) : '';
    if (wrongPhone) return setError(wrongPhone);
    setBusy(true);
    setError('');
    setCameBack('');
    sso.clearError();
    try {
      if (mode === 'login' || mode === 'signup') {
        const r = await api(`/auth/${mode}`, { body: { ...f, ...(mode === 'signup' ? phoneBody(phone) : {}), invite: q?.get('invite') || undefined, ...(mode === 'login' && sso.wayBack ? { way_back: true } : {}) } });
        // Two-step login: no session yet. The second screen asks for the code (src/server/twostep.ts), and whatever
        // the sign-in carries (an invitation, a closing login) is done after it.
        if (r.two_step) return window.location.assign(`/login/two-step${q?.get('next') ? `?next=${encodeURIComponent(q.get('next')!)}` : ''}`);
        // Someone who already has an account accepts a team invitation by signing in: the server does both in one
        // step. What happened on the way in is said on the first screen of the app, never swallowed.
        // A remembered device is the second step: signing in on it stops a reset of two-step login by email.
        const notice = [signInNotice(r), r.reset_stopped ? T('auth.reset_stopped') : ''].filter(Boolean).join(' ');
        try {
          if (r.restored) sessionStorage.setItem('sg_restored', '1');
          if (notice) sessionStorage.setItem('sg_notice', notice);
          // A new login: the app puts the keyboard in the box for the code from our email (ConfirmEmail.tsx).
          if (mode === 'signup') sessionStorage.setItem('sg_signed_up', '1');
        } catch {
          /* storage can be unavailable */
        }
        // Only ever to a path on this site (safeNext), whatever the address bar was given.
        window.location.assign(safeNext(q?.get('next')));
      } else if (mode === 'forgot') {
        await api('/auth/forgot', { body: { email: f.email } });
        // The invitation is not lost by resetting a password, but the reset email does not carry it: the person is
        // told to come back through the invitation email, which is what puts them on the team.
        setDone(`${T('auth.forgot_sent')}${q?.get('invite') ? ` ${T('auth.forgot_invite')}` : ''}`);
      } else {
        const r = await api('/auth/reset', { body: { token: q?.get('token'), password: f.password } });
        // Choosing a password for a login whose address had never been confirmed cuts off a provider that did not
        // stand behind the address. That is said here, so the next sign-in holds no surprise.
        setDone(`${T('auth.changed')}${r.disconnected?.length ? ` ${T('auth.disconnected', { names: r.disconnected.join(T('auth.and')) })}` : ''}${removedText({ ...r.removed, disconnected: undefined }) ? ` ${T('auth.removed', { what: removedText({ ...r.removed, disconnected: undefined }) })}` : ''} ${T('auth.sign_in_now')}${r.two_step ? ` ${T('auth.two_step_after')}` : ''}`);
      }
    } catch (err: any) {
      // Someone whose login was made with Google or Microsoft has no password to get right. The server does not say
      // whether that is the case for this address, so the hint goes to everyone whose password did not match.
      setError(err.message + (mode === 'login' && err.status === 401 && providers.length ? ` ${T('auth.provider_hint', { providers: list(providers.map((p) => p.name)) })}` : ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="authbox">
      <Link href="/" className="logo" style={{ marginBottom: 20 }}><Logo height={26} /></Link>
      <form className="card" onSubmit={submit}>
        <h1 className="serif" style={{ fontSize: 24, marginBottom: 6 }}>{T(`auth.title.${mode}`)}</h1>
        {mode === 'signup' && <p className="muted small">{q?.get('invite') ? T('auth.invited_team') : T('auth.free_start', { trees: String(PRICING.treesPerSignature) })}</p>}
        {mode === 'signup' && friend > 0 && <div className="notice" style={{ marginTop: 10 }} role="status">{T('auth.friend_invited', { count: friend })}</div>}
        {mode === 'login' && q?.get('invite') && <p className="muted small">{T('auth.invited_login')}</p>}
        {mode === 'forgot' && q?.get('invite') && <p className="muted small">{T('auth.invited_forgot')}</p>}
        {mode === 'login' && q?.get('closing') && <div className="notice" style={{ marginTop: 10 }}>{T('auth.closing')}</div>}
        {cameBack && <div className="notice err" style={{ marginTop: 10 }} role="alert">{cameBack}</div>}
        {sso.errorText && !cameBack && <div className="notice err" style={{ marginTop: 10 }} role="alert">{sso.errorText}</div>}
        {out && <div className="notice" style={{ marginTop: 10 }} role="status">{out}</div>}
        {done ? <div className="notice" style={{ margin: '12px 0' }}>{done} <Link href="/login">{T('auth.sign_in')}</Link></div> : (
          <div style={{ marginTop: 14 }}>
            {mode === 'signup' && <label className="f"><span>{T('auth.your_name')}</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoComplete="name" autoFocus /></label>}
            {mode !== 'reset' && <label className="f"><span>{T('auth.email')}</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} onBlur={(e) => (mode === 'login' || mode === 'signup') && sso.look(e.target.value)} required autoComplete="email" readOnly={mode === 'signup' && !!q?.get('invite')} aria-invalid={plus || undefined} /></label>}
            {mode === 'signup' && <p className="auth-plus" role="alert">{plus ? T('auth.plus_email') : ''}</p>}
            {(mode === 'login' || mode === 'signup') && sso.found && <SsoChoice sso={sso} mode={mode} q={q} />}
            {mode !== 'forgot' && !sso.active && <label className="f"><span>{mode === 'reset' ? T('auth.new_password') : T('auth.password')} {mode !== 'login' && <span className="hint">{T('auth.password_hint')}</span>}</span><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={mode === 'login' ? 1 : 8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>}
            {mode === 'signup' && !sso.active && <PhoneField T={T} value={phone} onChange={setPhone} lang={T.lang} />}
            {/* The plan code box shows only when the link brought a code: without one it was a question most people
                could not answer. A code can still be added afterwards on the Plan page. */}
            {mode === 'signup' && !q?.get('invite') && !sso.active && !!q?.get('code') && <label className="f"><span>{T('auth.plan_code')} <span className="hint">{T('auth.plan_code_hint')}</span></span><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} autoComplete="off" /></label>}
            {error && <div className="notice err" style={{ marginBottom: 12 }} role="alert">{error}</div>}
            {!sso.active && <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{T(`auth.button.${mode}`)}</button>}
            {(mode === 'login' || mode === 'signup') && providers.length > 0 && signedInAs && !q?.get('invite') && (
              <div className="auth-alt" role="group" aria-label={T('auth.signed_in_group')}>
                <p className="auth-or" aria-hidden="true"><span>{T('auth.or')}</span></p>
                <p className="notice" style={{ margin: '8px 0 0' }}>{T('auth.signed_in_as', { email: signedInAs, providers: list(providers.map((p) => p.name)) })}</p>
                <a className="btn" href="/app/settings?tab=security">{T('auth.open_security')}</a>
                <button type="button" className="btn" onClick={signOut}>{T('auth.sign_out')}</button>
              </div>
            )}
            {(mode === 'login' || mode === 'signup') && providers.length > 0 && (!signedInAs || !!q?.get('invite')) && sso.found?.password !== 'owner_only' && (
              <div className="auth-alt" role="group" aria-label={mode === 'login' ? T('auth.other_ways_login') : T('auth.other_ways_signup')}>
                <p className="auth-or" aria-hidden="true"><span>{T('auth.or')}</span></p>
                {/* The providers' names in plain text. Real links, so they work by keyboard and without scripts. */}
                {providers.map((p) => <a key={p.id} className="btn" href={startAt(p.id)}>{T('auth.continue_with', { name: p.name })}</a>)}
                <p className="muted small" style={{ margin: '10px 0 0' }}>
                  {mode === 'signup'
                    ? `${T('auth.provider_signup', { providers: list(providers.map((p) => p.name)) })}${q?.get('invite') ? ` ${T('auth.provider_signup_invite')}` : ''}`
                    : T('auth.provider_login', { providers: list(providers.map((p) => p.name)) })}
                </p>
              </div>
            )}
          </div>
        )}
      </form>
      <p className="muted small center" style={{ marginTop: 14 }}>
        {mode === 'login' ? <>{T('auth.new_here')} <Link href={`/signup${q?.get('invite') ? `?invite=${q.get('invite')}&email=${encodeURIComponent(f.email)}` : ''}`}>{T('auth.create')}</Link> · <Link href={`/forgot${q?.get('invite') ? `?invite=${q.get('invite')}&email=${encodeURIComponent(f.email)}` : ''}`}>{T('auth.forgot')}</Link></> : <>{T('auth.have_account')} <Link href={`/login${q?.get('invite') ? `?invite=${q.get('invite')}&email=${encodeURIComponent(f.email)}` : ''}`}>{T('auth.sign_in')}</Link></>}
        {/* Whichever form this is, a person is one click away, also for someone who cannot get in at all. */}
        {' · '}<Link href={mode === 'signup' ? '/help' : '/help?topic=cannot-log-in#contact'}>{mode === 'signup' ? T('auth.help') : T('auth.cannot_get_in')}</Link>
      </p>
    </div>
  );
}
