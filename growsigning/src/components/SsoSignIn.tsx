'use client';
// The sign-in page's part of an organisation's single sign-on (src/server/orgsso.ts, routes-orgsso.ts). Email and
// password stay on one screen. As the person leaves the email box, its domain is looked up; when the domain signs in
// through its organisation's service, the password box gives way in place to "Continue with <name> sign-in"
// (research/ux-notes.json, ds-sso-oidc). With nothing set up, the lookup answers nothing and the page is as before.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './ui';
import { continueWords, domainOf, ssoErrorText } from '@/lib/orgsso';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

type Found = { name: string; password: 'allowed' | 'owner_only' };
export type Sso = ReturnType<typeof useSso>;

export function useSso(mode: string, email: string) {
  const [looked, setLooked] = useState<{ domain: string; found: Found | null }>({ domain: '', found: null });
  const [usePw, setUsePw] = useState(false);
  const [code, setCode] = useState('');
  const asked = useRef('');
  const look = useCallback((typed: string) => {
    const domain = domainOf(typed);
    if (!domain || asked.current === domain) return;
    asked.current = domain;
    api(`/sso/lookup?${new URLSearchParams({ email: typed.trim() })}`)
      .then((r) => {
        if (asked.current !== domain) return;
        setLooked({ domain, found: r?.sso || null });
        setUsePw(false);
      })
      .catch(() => {});
  }, []);
  // What was found holds for the domain it was found for: typing another address puts the password box back.
  const found = looked.domain && looked.domain === domainOf(email) ? looked.found : null;
  const active = !!found && !usePw;
  return {
    found, active, look, usePw, setUsePw, setError: setCode,
    /** The owner's way back in: the password, asked for as such (the server decides once it is right). */
    wayBack: !!found && found.password === 'owner_only' && usePw,
    errorText: code ? ssoErrorText(code, found?.name) : '',
    clearError: () => setCode(''),
    startUrl: (q: URLSearchParams | null) => {
      const p = new URLSearchParams({ email: email.trim() });
      if (q?.get('invite')) p.set('invite', q.get('invite')!);
      if (q?.get('next')) p.set('next', q.get('next')!);
      return `/api/sso/start?${p}`;
    },
    mode,
  };
}

/** The button and the one link under it. Only ever drawn when the lookup found the person's organisation. */
export function SsoChoice({ sso, mode, q }: { sso: Sso; mode: 'login' | 'signup'; q: URLSearchParams | null }) {
  const f = sso.found!;
  // A login with a password cannot be made at a domain that signs everyone in through its service.
  const passwordOffered = mode === 'login' || f.password === 'allowed';
  const link = { minHeight: 44, padding: '10px 0' } as const;
  // Tab out of the email box was headed for the password box, which has just gone: the keyboard lands on the button.
  const go = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!sso.usePw && (document.activeElement === document.body || document.activeElement === null)) go.current?.focus();
  }, [sso.usePw]);
  return (
    <div data-feature="ds-sso-oidc" className="stack" style={{ gap: 4, marginBottom: 12 }}>
      {!sso.usePw ? (
        <>
          <a ref={go} className="btn primary" style={{ width: '100%' }} href={sso.startUrl(q)}>{continueWords(f.name)}</a>
          {passwordOffered && (
            <button type="button" className="linklike small" style={link} onClick={() => sso.setUsePw(true)}>
              {t(SOURCE_LOCALE, f.password === 'owner_only' ? 'sso.login.owner_way' : 'sso.login.password_instead')}
            </button>
          )}
        </>
      ) : (
        <button type="button" className="linklike small" style={link} onClick={() => sso.setUsePw(false)}>{t(SOURCE_LOCALE, 'sso.login.back', { name: f.name })}</button>
      )}
    </div>
  );
}
