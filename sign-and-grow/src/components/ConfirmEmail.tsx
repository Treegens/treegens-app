'use client';
import { useEffect, useRef, useState } from 'react';
import { api, toast } from './ui';
import { CONFIRM_CODE_DIGITS, CODE_REFUSED, cleanCode } from '@/lib/confirm';

// The name of the message every tab of the app hears when this browser confirmed the address, by the code in one
// tab or by the link in the email (src/app/verify-email/page.tsx). The tab the person signed up in then drops its
// banner by itself.
export const CONFIRMED_SIGNAL = 'growsigning-email-confirmed';
/** Set in this tab's session storage by the sign-up form, and read once by the banner. */
export const JUST_SIGNED_UP = 'sg_signed_up';

/** Tells the other tabs of this browser that the address is confirmed. */
export function sayConfirmed() {
  try {
    const ch = new BroadcastChannel(CONFIRMED_SIGNAL);
    ch.postMessage('confirmed');
    ch.close();
  } catch {
    /* an old browser: the other tabs look again when they are shown */
  }
  try {
    localStorage.setItem(CONFIRMED_SIGNAL, String(Date.now()));
  } catch {
    /* storage can be unavailable */
  }
}

/**
 * Calls `onConfirmed` when another tab or another device confirmed the address: at once for a tab of this browser,
 * when this tab is shown again, and every 15 seconds while it is on screen, for a phone that confirmed it.
 * `check` asks the server and answers whether the address is confirmed now.
 */
export function useConfirmedElsewhere(active: boolean, check: () => void) {
  const latest = useRef(check);
  latest.current = check;
  useEffect(() => {
    if (!active) return;
    const look = () => document.visibilityState === 'visible' && latest.current();
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel(CONFIRMED_SIGNAL);
      ch.onmessage = () => latest.current();
    } catch {}
    const stored = (e: StorageEvent) => e.key === CONFIRMED_SIGNAL && latest.current();
    window.addEventListener('storage', stored);
    window.addEventListener('focus', look);
    document.addEventListener('visibilitychange', look);
    const timer = window.setInterval(look, 15_000);
    return () => {
      ch?.close();
      window.removeEventListener('storage', stored);
      window.removeEventListener('focus', look);
      document.removeEventListener('visibilitychange', look);
      window.clearInterval(timer);
    };
  }, [active]);
}

/**
 * The banner at the top of the app while the address is not confirmed: the code box in place, in the tab the person
 * signed up in. It goes by itself once the address is confirmed, here or anywhere else.
 */
export function ConfirmBanner({ me }: { me: { user: any; reload: () => void } }) {
  const unconfirmed = !me.user.email_verified;
  useConfirmedElsewhere(unconfirmed, me.reload);
  // Straight after signing up the keyboard starts in the code box, once: the next thing to do (AuthForm sets the mark).
  const [fresh] = useState(() => {
    try {
      const was = sessionStorage.getItem(JUST_SIGNED_UP) === '1';
      sessionStorage.removeItem(JUST_SIGNED_UP);
      return was;
    } catch {
      return false;
    }
  });
  if (!unconfirmed) return null;
  // Too many wrong codes were typed for this login (src/server/confirmcode.ts): only the button in the email works now.
  if (me.user.confirm_by_code === false) return (
    <section className="notice warn cc-banner" aria-labelledby="cc-h">
      <p className="cc-text"><b id="cc-h">Confirm your email.</b> Press the button in the email we sent to <bdi className="cc-email">{me.user.email}</bdi>, in this browser. Codes no longer work for this login.</p>
      <ResendLink email={me.user.email} label="Send the email again" />
    </section>
  );
  return (
    <section className="notice warn cc-banner" aria-labelledby="cc-h">
      <p className="cc-text"><b id="cc-h">Confirm your email.</b> We sent a 6-digit code to <bdi className="cc-email">{me.user.email}</bdi>. Type it here. You need it before you can send.</p>
      <ConfirmCode email={me.user.email} focusFirst={fresh} onConfirmed={() => (toast('Email confirmed. You can send now.'), me.reload())} onClosed={me.reload} />
    </section>
  );
}

export function ResendLink({ email, label }: { email: string; label: string }) {
  const [said, setSaid] = useState<{ text: string; err?: boolean } | null>(null);
  return (
    <div className="cc-row">
      <button type="button" className="btn cc-again-btn" onClick={() => api('/auth/resend-verification', { method: 'POST' }).then(() => setSaid({ text: `We sent it again to ${email}. It can take a minute, and may land among spam.` })).catch((e: any) => setSaid({ text: e?.message || 'We could not send it just now. Try again in a minute.', err: true }))}>{label}</button>
      {said && <p className={`cc-said${said.err ? ' err' : ''}`} role={said.err ? 'alert' : 'status'}>{said.text}</p>}
    </div>
  );
}

/**
 * The code box: type the 6 digits from the email, here, in the tab you signed up in. Six digits confirm by
 * themselves; Confirm does the same for anyone who prefers to press it. "Send a new code" emails a new one.
 */
export function ConfirmCode({ email, onConfirmed, onClosed, compact = false, main = false, focusFirst = false }: { email: string; /** Put the keyboard in the box when it appears. */ focusFirst?: boolean; onConfirmed: () => void; onClosed?: () => void; compact?: boolean; /** On a screen of its own, Confirm is the filled button. In the banner it is not: the page under it keeps its one main button. */ main?: boolean }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; err?: boolean } | null>(null);
  const tried = useRef('');
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusFirst) box.current?.focus();
  }, [focusFirst]);

  async function confirm(typed = code) {
    const digits = cleanCode(typed);
    if (!new RegExp(`^[0-9]{${CONFIRM_CODE_DIGITS}}$`).test(digits)) return setSaid({ text: CODE_REFUSED.code_format, err: true });
    if (busy) return;
    tried.current = digits;
    setBusy(true);
    setSaid(null);
    try {
      await api('/auth/verify-code', { body: { code: digits } });
      sayConfirmed();
      onConfirmed();
    } catch (e: any) {
      setSaid({ text: e?.message || 'We could not check the code just now. Try again in a minute.', err: true });
      // No code works for this login any more: the screen says what does (the button in the email).
      if (e?.code === 'code_closed') onClosed?.();
      // A pause was asked for: the same digits may be typed again after it.
      if (e?.code === 'code_wait' || !e?.code) tried.current = '';
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setSaid(null);
    try {
      await api('/auth/resend-verification', { method: 'POST' });
      setCode('');
      tried.current = '';
      setSaid({ text: `We sent a new email to ${email}. It can take a minute, and may land among spam.` });
    } catch (e: any) {
      setSaid({ text: e?.message || 'We could not send it just now. Try again in a minute.', err: true });
    }
  }

  return (
    <form className={`cc${compact ? ' cc-compact' : ''}`} onSubmit={(e) => (e.preventDefault(), void confirm())} aria-label="Confirm your email">
      <div className="cc-row">
        <label className="cc-label">
          <span>Code from the email</span>
          <input
            className="cc-input"
            ref={box}
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={12}
            aria-describedby={said ? 'cc-said' : undefined}
            aria-invalid={said?.err ? true : undefined}
            onChange={(e) => {
              const v = e.target.value;
              setCode(v);
              // All six digits typed or pasted: confirmed at once, and once for the same digits.
              const d = cleanCode(v);
              if (d.length === CONFIRM_CODE_DIGITS && /^[0-9]+$/.test(d) && d !== tried.current) void confirm(v);
            }}
          />
        </label>
        <button className={`btn${main ? ' primary' : ''} cc-go`} disabled={busy}>{busy ? 'Checking…' : 'Confirm'}</button>
        <button type="button" className="linklike cc-again" onClick={resend}>Send a new code</button>
      </div>
      {said && <p id="cc-said" className={`cc-said${said.err ? ' err' : ''}`} role={said.err ? 'alert' : 'status'}>{said.text}</p>}
    </form>
  );
}
