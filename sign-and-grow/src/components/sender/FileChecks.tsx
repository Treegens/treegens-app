'use client';
// The page of a completed document: "Checks on the file", folded and closed until asked for. Today it holds one
// thing, the digital seal of the signed PDF (GET /envelopes/:id, `seal`, from sealFacts in src/server/seal.ts).
// Absent when the file carries no seal, so a server without seal settings shows nothing here.
import Link from 'next/link';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

const ui = SOURCE_LOCALE;

// Also, on a server with a time-stamp service: whether the file can be checked after the seal's certificate expired
// (`long_term`, ltv.ts), in one plain line. Why it could not be is technical (service names, error codes): it stays in
// the History line "Sealed by" and the API, never here. The record's own time stamp is about the history, not the
// file: it is shown in History (History.tsx).
type Seal = { by: string; issuer: string | null; time_stamp: boolean; time_stamp_trusted?: boolean; long_term?: 'B-LT' | 'B-LTA' | null; long_term_missing?: string | null };

// The archive format (`archive_format`, src/server/pdfa.ts), when the account asked for PDF/A: one line, PDF/A only
// when veraPDF passed the stored file, otherwise "not PDF/A" and why in a few words.
type Archive = { pdfa: true; checker: string } | { pdfa: false; why: string };

export function FileChecks({ seal, archive }: { seal?: Seal | null; archive?: Archive | null }) {
  if (!seal?.by && !archive) return null;
  const archiveLine = archive ? <p className="small" data-feature="ds-pdfa" style={{ margin: '4px 0 0', overflowWrap: 'anywhere' }}>{archive.pdfa ? t(ui, 'pdfa.line.passed', { checker: archive.checker }) : t(ui, 'pdfa.line.not', { why: archive.why })}</p> : null;
  if (!seal?.by) return (
    <details className="card cf-details" style={{ marginTop: 16 }} data-fold="" data-feature="ds-pdfa">
      <summary>{t(ui, 'seal.checks.title')}</summary>
      {archiveLine}
    </details>
  );
  return (
    <details className="card cf-details" style={{ marginTop: 16 }} data-fold="" data-feature="ds-seal">
      <summary>{t(ui, 'seal.checks.title')}</summary>
      <p style={{ margin: '4px 0 0', overflowWrap: 'anywhere' }}><b>{t(ui, 'seal.sealed_by', { name: seal.by })}</b></p>
      <p className="muted small" style={{ margin: '4px 0 0', overflowWrap: 'anywhere' }}>
        {t(ui, 'seal.checks.what', { name: seal.by })} {t(ui, seal.time_stamp ? (seal.time_stamp_trusted ? 'seal.time.stamp' : 'seal.time.stamp_unchecked') : 'seal.time.clock')} {t(ui, 'seal.checks.not')}
      </p>
      {seal.long_term && <p className="small" style={{ margin: '4px 0 0', overflowWrap: 'anywhere' }}>{t(ui, 'seal.ltv.on')}</p>}
      {seal.long_term_missing && <p className="small" style={{ margin: '4px 0 0', overflowWrap: 'anywhere' }}>{t(ui, 'seal.ltv.missing')}</p>}
      {archiveLine}
      {/* A reader may say "validity unknown": the page says what that means. */}
      <p className="small" style={{ margin: '4px 0 0' }}><Link href="/security/certificate#seal" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>{t(ui, 'seal.checks.more')}</Link></p>
    </details>
  );
}
