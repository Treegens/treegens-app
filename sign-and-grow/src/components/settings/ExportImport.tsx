'use client';
// Settings, Records and data, for owners and admins: "Export everything" (the full export with its schema,
// src/server/exportfull.ts) and, folded under it, "Bring in documents" from another GrowSigning server's export or
// from DocuSign (src/server/importer.ts, importer-docusign.ts). One card, so the section keeps its number of cards.
// The designer's note: research/ux-notes.json, gov-G19.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, useLoad } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { EXPORT_LINK_DAYS, EXPORT_SCHEMA_PATH, importSaid as said, onlyRepeats } from '@/lib/exportfull';
import { dayText } from '@/lib/dates';

type Report = { imported: Record<string, number>; settings: string[]; not_imported: { what: string; name: string; why: string }[]; refused_out_for_signature: { id: string; subject: string }[]; records: any[] };

/** A time of day and a day, for telling one export from another. */
const madeAt = (iso: string) => `${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} on ${dayText(iso)}`;
const TALL = { minHeight: 44 } as const;

export function ExportImport() {
  const me = useMe();
  const [jobs, reloadJobs] = useLoad(() => api('/export/full/jobs'));
  const [recs, reloadRecs] = useLoad(() => api('/imported'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [from, setFrom] = useState<'export' | 'docusign'>('export');
  const fileRef = useRef<HTMLInputElement>(null);
  const making = (jobs?.jobs || []).find((j: any) => j.status === 'making');
  // Only the newest ready export: older ones are deleted on their own after their days.
  const ready = (jobs?.jobs || []).find((j: any) => j.status === 'ready');
  const failed = (jobs?.jobs || [])[0]?.status === 'failed' ? jobs.jobs[0] : null;
  const records: any[] = recs?.records || [];

  // While one is being made, look again every few seconds, so its Download appears without reloading the page.
  useEffect(() => {
    if (!making) return;
    const t = setInterval(reloadJobs, 4000);
    return () => clearInterval(t);
  }, [making, reloadJobs]);
  // A link to "#bring-in" (the empty Documents list) opens the fold.
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(window.location.hash === '#bring-in'), []);

  async function exportAll() {
    setBusy(true);
    setError('');
    try {
      await api('/export/full/jobs', { body: {} });
      reloadJobs();
    } catch (e: any) {
      setError(e.message);
    }
    setBusy(false);
  }

  async function bringIn() {
    const files = Array.from(fileRef.current?.files || []);
    if (!files.length) return setError(from === 'export' ? 'Choose the ZIP file that Export everything made on the other server.' : 'Choose the files you downloaded from DocuSign.');
    setBusy(true);
    setError('');
    setReport(null);
    const form = new FormData();
    for (const f of files) form.append('file', f);
    try {
      setReport(await api(from === 'export' ? '/import/full' : '/import/docusign', { form }));
      if (fileRef.current) fileRef.current.value = '';
      reloadRecs();
    } catch (e: any) {
      setError(e.message);
    }
    setBusy(false);
  }

  return (
    <div className="card" data-item="card" id="export">
      <h2>Take everything with you</h2>
      <p className="muted" style={{ margin: '6px 0 12px', maxWidth: 640 }}>
        One ZIP file with everything in the account: every signed PDF with its full record for disputes, every document, the full history of each, templates, contacts, groups and settings, as data in an open, <a href={EXPORT_SCHEMA_PATH}>published format</a>. Free, as often as you like, also if you stop paying. We email {me.user.email} when it is ready, and it can be downloaded here for {EXPORT_LINK_DAYS} days.
      </p>
      <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
        <button className="btn primary" style={TALL} onClick={exportAll} disabled={busy || !!making}>{making ? 'Putting it together…' : 'Export everything'}</button>
        {ready && <a className="btn" style={{ ...TALL, whiteSpace: 'normal', height: 'auto', maxWidth: '100%' }} href={ready.download_url}>Download the export made at {madeAt(ready.ready_at)}</a>}
      </div>
      <div role="status" className="small" style={{ marginTop: 8 }}>
        {making ? `We are putting it together. You can leave this page: we email ${me.user.email} when it is ready.` : failed ? failed.error : ''}
      </div>
      <p className="small muted" style={{ margin: '8px 0 0' }}>Only the signed PDFs and a spreadsheet? <a href="/api/export">Download those now</a>.</p>

      <details data-fold="" className="set-kept" id="bring-in" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} style={{ marginTop: 16 }}>
        <summary className="set-fold">Bring in documents</summary>
        <div className="stack" style={{ marginTop: 10, maxWidth: 640 }}>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small">Where do they come from?</legend>
            <label className="check" style={{ minHeight: 44 }}><input type="radio" name="from" checked={from === 'export'} onChange={() => setFrom('export')} /> A GrowSigning export (the ZIP file from Export everything)</label>
            <label className="check" style={{ minHeight: 44 }}><input type="radio" name="from" checked={from === 'docusign'} onChange={() => setFrom('docusign')} /> DocuSign (the &ldquo;combined documents with certificate&rdquo; PDFs, the envelope report CSV and template files, or a ZIP of them)</label>
          </fieldset>
          <p className="small muted" style={{ margin: 0 }}>
            {from === 'export'
              ? 'Templates, drafts, contacts, groups and a few plain settings come in ready to use. Finished documents come in as archived records, each marked with where the export says it came from and whether its history and files agree. Documents still out for signature stay where they were sent: they finish there.'
              : 'Finished documents come in as archived records, kept exactly as you downloaded them. A PDF that shows nothing of DocuSign (no envelope ID and no certificate) is left out. Nothing here checks how they were signed, and every record says so. Templates come in with the fields we have; what we have no match for is listed.'}
          </p>
          <label className="f"><span>{from === 'export' ? 'The export ZIP file' : 'Files from DocuSign'}</span>
            <input ref={fileRef} type="file" style={TALL} multiple={from === 'docusign'} accept={from === 'export' ? '.zip,application/zip' : '.pdf,.csv,.json,.zip'} />
          </label>
          <div><button className="btn" style={TALL} onClick={bringIn} disabled={busy}>{busy ? 'Bringing them in…' : 'Bring in documents'}</button></div>
          <div role="status" aria-live="polite">
            {error && <div className="notice warn">{error}</div>}
            {report && (
              <div className="notice">
                <p style={{ margin: 0 }}><b>{said(report)}</b>{report.settings.length ? ` Settings taken over: ${report.settings.join(', ')}.` : ''}</p>
                {report.refused_out_for_signature.length > 0 && <p style={{ margin: '8px 0 0' }}>Not brought in, because they are still out for signature where they were sent. Bring them in once they are finished there: {report.refused_out_for_signature.map((x) => `"${x.subject}"`).join(', ')}.</p>}
                {report.not_imported.length > 0 && (
                  <details style={{ marginTop: 8 }} open={!Object.values(report.imported).some((n) => n > 0) && !onlyRepeats(report)}>
                    <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>{report.not_imported.length === 1 ? '1 thing was not brought in' : `${report.not_imported.length} things were not brought in`}, and why</summary>
                    <ul className="rules small">{report.not_imported.map((n, i) => <li key={i}><b>{n.what}: {n.name}.</b> {n.why}</li>)}</ul>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      </details>
      {records.length > 0 && <p className="small" style={{ margin: '12px 0 0' }}><Link href="/app/imported" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>Documents brought in ({records.length})</Link></p>}
    </div>
  );
}
