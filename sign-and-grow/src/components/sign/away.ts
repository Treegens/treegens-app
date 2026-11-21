'use client';
// The signing page of an account whose rule is "Sign out after N minutes of no use" (src/server/secpolicy.ts). The
// page is never covered and nothing pops up on a timer (research/ux-charter.md P9 and 2.6): on the first action
// after a break longer than N minutes, the link is checked again in place (GET /api/sign/:token/away, which looks
// it up exactly as opening the page does), and one line says so. Every answer on the page stays as it is. When the
// link no longer opens (replaced, deleted), or the document is not as the page shows it any more (cancelled, expired,
// corrected, finished in another tab), the page loads again and shows what happened, as it would for anyone opening
// the link now; answers not saved yet are kept by that load. Accounts without the rule get nothing: `minutes` is
// null and no listener is added.
import { useEffect, useRef, useState } from 'react';
import { api } from '@/components/ui';
import { awayTooLong } from '@/lib/signinrules';
import { t } from '@/lib/i18n';

/** How long the line stays before the next action takes it away again. */
const SAID_MS = 30_000;

/** What the page shows now, to compare with the second look. */
export type AwaySeen = { status?: string; version?: number | null; done?: boolean };
type AwayAnswer = { status: string; version: number | null; done: boolean };
/** Whether the second look found the document other than the page shows it. */
export const awayStale = (a: AwayAnswer, seen: AwaySeen): boolean => a.status !== seen.status || (a.version ?? null) !== (seen.version ?? null) || !!a.done !== !!seen.done;

export function useAwayCheck(base: string, minutes: number | null | undefined, locale: unknown, seen: AwaySeen, reload: () => unknown): string {
  const [said, setSaid] = useState('');
  const last = useRef(Date.now());
  const saidAt = useRef(0);
  const asking = useRef(false);
  const again = useRef(reload);
  again.current = reload;
  const shown = useRef(seen);
  shown.current = seen;
  useEffect(() => {
    if (!minutes) return;
    last.current = Date.now();
    const acted = () => {
      const t0 = Date.now();
      const away = awayTooLong(last.current, t0, minutes);
      last.current = t0;
      if (saidAt.current && t0 - saidAt.current > SAID_MS) (saidAt.current = 0), setSaid('');
      if (!away || asking.current) return;
      asking.current = true;
      api<AwayAnswer>(`${base}/away`)
        .then((a) => {
          saidAt.current = Date.now();
          setSaid(t(locale, 'rules.away.checked'));
          if (awayStale(a, shown.current)) again.current();
        })
        .catch(() => again.current())
        .finally(() => (asking.current = false));
    };
    const opts = { capture: true, passive: true } as const;
    window.addEventListener('pointerdown', acted, opts);
    window.addEventListener('keydown', acted, opts);
    return () => {
      window.removeEventListener('pointerdown', acted, opts);
      window.removeEventListener('keydown', acted, opts);
    };
  }, [base, minutes, locale]);
  return said;
}
