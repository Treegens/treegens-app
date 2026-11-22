'use client';
// The whole document with the person's answers in it, before they sign (ds-web-forms). The button to go on to sign is
// under the last page, so the way to it is through the document. Nothing has been made yet: the envelope is made
// when they press it.
import { useEffect, useRef } from 'react';
import { t } from '@/lib/i18n';
import { PdfDoc } from '@/components/PdfDoc';

export function FormReview({ locale, slug, reviewKey, stamp, busy, msg, onChange, onContinue }: { locale: string; slug: string; reviewKey: string; stamp: number; busy: boolean; msg: string; onChange: () => void; onContinue: () => void }) {
  const w = (k: string) => t(locale, k);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="stack" style={{ width: '100%' }}>
      <div className="card">
        <h2 ref={heading} tabIndex={-1} style={{ fontSize: 20, outline: 'none' }}>{w('form.review.title')}</h2>
        <p style={{ margin: '8px 0 4px' }}>{w('form.answers_fill')}</p>
        <p className="muted small" style={{ margin: 0 }}>{w('form.review.read')}</p>
        <button type="button" className="btn" style={{ minHeight: 44, marginTop: 12 }} onClick={onChange}>{w('form.review.change')}</button>
      </div>
      <div aria-label={w('form.review.title')}>
        <PdfDoc url={`/api/public/powerforms/${slug}/review?k=${encodeURIComponent(reviewKey)}&v=${stamp}`} maxWidth={860} />
      </div>
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>{w('form.answers_fill')} {w('form.nothing_sent')}</p>
        {msg && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{msg}</div>}
        <button className="btn primary" style={{ width: '100%', minHeight: 44 }} disabled={busy} onClick={onContinue}>{busy ? `${w('form.preparing')}…` : w('form.review.continue')}</button>
      </div>
    </div>
  );
}
