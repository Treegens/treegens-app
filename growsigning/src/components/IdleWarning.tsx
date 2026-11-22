'use client';
// The warning before the account's rule "Sign out after N minutes of no use" signs this browser out
// (src/server/secpolicy.ts). Drawn by AppShell only in an account with that rule; elsewhere it does not exist.
//
//   - A key, a tap, a click or the wheel counts as use: the server is told so at most once every IDLE_PING_SECONDS
//     (POST /api/me/idle/stay). Every other request of the app counts too, on the server.
//   - How long is left is asked quietly (GET /api/me/idle with the x-quiet header, which is not use): when the
//     warning is due, whenever the tab is looked at again, and at the end. Work in another tab moves the end too.
//   - IDLE_WARN_SECONDS before the end, one line and "Stay signed in" appear at the top of the window. It never takes
//     the focus and never blocks the page: pressing any key or tapping anywhere also keeps the browser signed in.
//   - At the end the sign-in page opens, saying why, with the way back to this page.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './ui';
import { IDLE_PING_SECONDS, IDLE_WARN_SECONDS, QUIET_HEADER, leftWords, warnNow, signedOutPath } from '@/lib/signinrules';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

const say = (key: string, vars: Record<string, string | number> = {}) => t(SOURCE_LOCALE, key, vars);
type Left = { minutes: number | null; seconds_left: number | null };

export function IdleWarning({ minutes, account }: { minutes: number; account: string }) {
  // When the server last answered, and when that answer said the end is (this browser's clock).
  const [end, setEnd] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  const lastPing = useRef(0);
  const gone = useRef(false);

  const heard = useCallback((l: Left) => {
    if (l.seconds_left == null) return setEnd(null);
    setEnd(Date.now() + l.seconds_left * 1000);
    setNowMs(Date.now());
  }, []);
  // Signed out (by this rule, another browser, or anything else): the sign-in page, saying why when a rule did it.
  // Any other failure is a network hiccup, and the next look tries again.
  const failedWith = useCallback((e: any) => {
    if (e?.status !== 401 || gone.current) return;
    gone.current = true;
    window.location.assign(signedOutPath(e?.data?.why, `${window.location.pathname}${window.location.search}`));
  }, []);
  const look = useCallback(() => api<Left>('/me/idle', { headers: { [QUIET_HEADER]: '1' } }).then(heard).catch(failedWith), [heard, failedWith]);
  const stay = useCallback(() => {
    lastPing.current = Date.now();
    return api<Left>('/me/idle/stay', { method: 'POST' }).then((l) => (setFailed(false), heard(l))).catch((e) => {
      failedWith(e);
      setFailed(true);
    });
  }, [heard, failedWith]);

  // The first look, and another whenever the tab is looked at again.
  useEffect(() => {
    void look();
    const again = () => document.visibilityState === 'visible' && void look();
    document.addEventListener('visibilitychange', again);
    window.addEventListener('focus', again);
    return () => {
      document.removeEventListener('visibilitychange', again);
      window.removeEventListener('focus', again);
    };
  }, [look, minutes]);

  // Someone working: told to the server, at most once a minute.
  useEffect(() => {
    const used = () => {
      if (Date.now() - lastPing.current < IDLE_PING_SECONDS * 1000) return;
      void stay();
    };
    const opts = { capture: true, passive: true } as const;
    for (const ev of ['keydown', 'pointerdown', 'wheel'] as const) window.addEventListener(ev, used, opts);
    return () => {
      for (const ev of ['keydown', 'pointerdown', 'wheel'] as const) window.removeEventListener(ev, used, opts);
    };
  }, [stay]);

  // The clock: quiet until the warning is due, then every few seconds so the line says how long is left.
  useEffect(() => {
    if (end == null) return;
    const leftMs = end - Date.now();
    // When the warning is due, the server is asked first: work in another tab may have moved the end.
    const wait = leftMs > IDLE_WARN_SECONDS * 1000 ? leftMs - IDLE_WARN_SECONDS * 1000 : Math.min(15_000, Math.max(1000, leftMs + 1500));
    const id = window.setTimeout(() => {
      setNowMs(Date.now());
      if (leftMs > IDLE_WARN_SECONDS * 1000 || end - Date.now() <= 0) void look();
    }, wait);
    return () => window.clearTimeout(id);
  }, [end, nowMs, look]);

  if (end == null) return null;
  const secondsLeft = Math.max(0, Math.round((end - nowMs) / 1000));
  if (!warnNow(secondsLeft)) return null;
  return (
    <div className="idle-warn" role="alert" data-feature="ds-sec-policy">
      <p>{say('rules.warn.text', { left: leftWords(secondsLeft), account, count: minutes })}</p>
      <button type="button" className="btn" onClick={() => void stay()}>{say('rules.warn.stay')}</button>
      {failed && <p className="set-bad">{say('rules.warn.failed')}</p>}
    </div>
  );
}
