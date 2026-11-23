'use client';
// Small parts every Settings section shares (research/ux-charter.md, 2.2 and P4):
//   useSaved()   "Saved" next to the control or button that saved, instead of a toast somewhere else on the page.
//   Card         marks one card of a section, so the page can be checked for "at most 4 cards with zero setup".
//   MoreOptions  the one place per section for what is rarely needed. Closed every time the section opens.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useST } from '@/components/senderLang';

/** `[said, saved]`: put `said` next to the control, call `saved()` when the server has answered. */
export function useSaved(given?: string): [ReactNode, () => void] {
  const T = useST();
  const words = given ?? T('settings.saved');
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const saved = useCallback(() => {
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), 6000);
  }, []);
  // The live region is always there, so a screen reader says "Saved" when the word arrives.
  return [<span key="saved" role="status" className="set-saved">{on ? words : ''}</span>, saved];
}

export function Card({ children }: { children: ReactNode }) {
  return <div data-item="card" className="set-card">{children}</div>;
}

export function MoreOptions({ children }: { children: ReactNode }) {
  const T = useST();
  return (
    <details className="set-more" data-more="screen">
      <summary>{T('settings.more_options')}</summary>
      <div className="stack set-more-body">{children}</div>
    </details>
  );
}
