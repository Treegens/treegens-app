'use client';
// The page of a completed document: "Checks on the file", folded and closed until asked for. Today it holds one
// thing, the digital seal of the signed PDF (GET /envelopes/:id, `seal`, from sealFacts in src/server/seal.ts).
// Absent when the file carries no seal, so a server without seal settings shows nothing here.
import Link from 'next/link';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

const ui = SOURCE_LOCALE;

export function FileChecks({ seal }: { seal?: { by: string; issuer: string | null; time_stamp: boolean; time_stamp_trusted?: boolean } | null }) {
  if (!seal?.by) return null;
  return (
    <details className="card cf-details" style={{ marginTop: 16 }} data-fold="" data-feature="ds-seal">
      <summary>{t(ui, 'seal.checks.title')}</summary>
      <p style={{ margin: '4px 0 0', overflowWrap: 'anywhere' }}><b>{t(ui, 'seal.sealed_by', { name: seal.by })}</b></p>
      <p className="muted small" style={{ margin: '4px 0 0', overflowWrap: 'anywhere' }}>
        {t(ui, 'seal.checks.what', { name: seal.by })} {t(ui, seal.time_stamp ? (seal.time_stamp_trusted ? 'seal.time.stamp' : 'seal.time.stamp_unchecked') : 'seal.time.clock')} {t(ui, 'seal.checks.not')}
      </p>
      {/* A reader may say "validity unknown": the page says what that means. */}
      <p className="small" style={{ margin: '4px 0 0' }}><Link href="/security/certificate#seal" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>{t(ui, 'seal.checks.more')}</Link></p>
    </details>
  );
}
