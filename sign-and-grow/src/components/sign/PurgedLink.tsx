'use client';
// What a signing link says once its envelope was purged (src/server/records.ts): the sender deleted the document,
// nothing is left here to open, and where a copy may still be. In the person's language where it has been translated
// (src/locales), as the browser asks: the link carries nothing else about them any more. The server's own answer is
// PURGED_LINK in src/lib/retention.ts, the same words in English.
import Link from 'next/link';
import { Shell, StateCard } from './parts';
import { t } from '@/lib/i18n';

export function PurgedLink({ day }: { day?: string | null }) {
  const lang = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return (
    <Shell>
      <StateCard tone="stop" title={t(lang, 'sign.purged.title')}>
        <p>{t(lang, 'sign.purged.body')}</p>
        {/* The day in the reader's own format: "21 November 2026", not 2026-11-21. */}
        {day && <p className="muted small">{t(lang, 'sign.purged.day', { day: /^\d{4}-\d{2}-\d{2}/.test(day) ? new Date(`${day.slice(0, 10)}T00:00:00Z`).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : day })}</p>}
        <p className="muted small">{t(lang, 'sign.purged.ask')}</p>
        <p><Link className="btn" href="/help?topic=signing#contact">{t(lang, 'sign.purged.help')}</Link></p>
      </StateCard>
    </Shell>
  );
}
