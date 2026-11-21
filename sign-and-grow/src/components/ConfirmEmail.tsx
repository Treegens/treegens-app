'use client';
import { useEffect, useRef, useState } from 'react';
import { api, toast } from './ui';
import { CONFIRM_CODE_DIGITS, CODE_REFUSED, cleanCode } from '@/lib/confirm';

// The name of the message every tab of the app hears when this browser confirmed the address, by the code in one
// tab or by the link in the email (src/app/verify-email/page.tsx). The tab the person signed up in then drops its
// banner by itself.
export const CONFIRMED_SIGNAL = 'growsigning-email-confirmed';

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
      <p className="cc-text"><b id="cc-h">Confirm your email.</b> We sent a 6-digit code to <bdi className="cc-email">{me.user.email}</bdi>. Type it here to start sending.</p>
      <ConfirmCode email={me.user.email} onConfirmed={() => (toast('Email confirmed. You can send now.'), me.reload())} onClosed={me.reload} />
    </section>
  );
}

function ResendLink({ email, label }: { email: string; label: string }) {
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
export function ConfirmCode({ email, onConfirmed, onClosed, compact = false }: { email: string; onConfirmed: () => void; onClosed?: () => void; compact?: boolean }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; err?: boolean } | null>(null);
  const tried = useRef('');

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
        <button className="btn primary cc-go" disabled={busy}>{busy ? 'Checking…' : 'Confirm'}</button>
        <button type="button" className="linklike cc-again" onClick={resend}>Send a new code</button>
      </div>
      {said && <p id="cc-said" className={`cc-said${said.err ? ' err' : ''}`} role={said.err ? 'alert' : 'status'}>{said.text}</p>}
    </form>
  );
}
