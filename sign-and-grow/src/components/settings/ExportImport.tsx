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
import { useST, senderRich } from '@/components/senderLang';

type Report = { imported: Record<string, number>; settings: string[]; not_imported: { what: string; name: string; why: string }[]; refused_out_for_signature: { id: string; subject: string }[]; records: any[] };

/** A time of day and a day, for telling one export from another. */
const madeAt = (iso: string) => ({ time: new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), day: dayText(iso) });
const TALL = { minHeight: 44 } as const;

export function ExportImport() {
  const me = useMe();
  const T = useST();
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
      setError(T.error(e));
    }
    setBusy(false);
  }

  async function bringIn() {
    const files = Array.from(fileRef.current?.files || []);
    if (!files.length) return setError(T(from === 'export' ? 'settings.export.choose_zip' : 'settings.export.choose_docusign'));
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
      setError(T.error(e));
    }
    setBusy(false);
  }

  return (
    <div className="card" data-item="card" id="export">
      <h2>{T('settings.export.title')}</h2>
      <p className="muted" style={{ margin: '6px 0 12px', maxWidth: 640 }}>
        {senderRich(T.lang, 'settings.export.lead', { format: <a href={EXPORT_SCHEMA_PATH}>{T('settings.export.format')}</a> }, { email: me.user.email, count: EXPORT_LINK_DAYS })}
      </p>
      <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
        <button className="btn primary" style={TALL} onClick={exportAll} disabled={busy || !!making}>{T(making ? 'settings.export.making' : 'settings.export.button')}</button>
        {ready && <a className="btn" style={{ ...TALL, whiteSpace: 'normal', height: 'auto', maxWidth: '100%' }} href={ready.download_url}>{T('settings.export.download', madeAt(ready.ready_at))}</a>}
      </div>
      <div role="status" className="small" style={{ marginTop: 8 }}>
        {making ? T('settings.export.making_note', { email: me.user.email }) : failed ? failed.error : ''}
      </div>
      <p className="small muted" style={{ margin: '8px 0 0' }}>{senderRich(T.lang, 'settings.export.only_pdfs', { link: <a href="/api/export">{T('settings.export.only_pdfs_link')}</a> })}</p>

      <details data-fold="" className="set-kept" id="bring-in" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} style={{ marginTop: 16 }}>
        <summary className="set-fold">{T('settings.import.title')}</summary>
        <div className="stack" style={{ marginTop: 10, maxWidth: 640 }}>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small">{T('settings.import.where')}</legend>
            <label className="check" style={{ minHeight: 44 }}><input type="radio" name="from" checked={from === 'export'} onChange={() => setFrom('export')} /> {T('settings.import.from_export')}</label>
            <label className="check" style={{ minHeight: 44 }}><input type="radio" name="from" checked={from === 'docusign'} onChange={() => setFrom('docusign')} /> {T('settings.import.from_docusign')}</label>
          </fieldset>
          <p className="small muted" style={{ margin: 0 }}>
            {T(from === 'export' ? 'settings.import.export_note' : 'settings.import.docusign_note')}
          </p>
          <label className="f"><span>{T(from === 'export' ? 'settings.import.zip_label' : 'settings.import.docusign_label')}</span>
            <input ref={fileRef} type="file" style={TALL} multiple={from === 'docusign'} accept={from === 'export' ? '.zip,application/zip' : '.pdf,.csv,.json,.zip'} />
          </label>
          <div><button className="btn" style={TALL} onClick={bringIn} disabled={busy}>{T(busy ? 'settings.import.busy' : 'settings.import.title')}</button></div>
          <div role="status" aria-live="polite">
            {error && <div className="notice warn">{error}</div>}
            {report && (
              <div className="notice">
                <p style={{ margin: 0 }}><b>{said(report)}</b>{report.settings.length ? ` ${T('settings.import.settings_taken', { list: report.settings.join(', ') })}` : ''}</p>
                {report.refused_out_for_signature.length > 0 && <p style={{ margin: '8px 0 0' }}>{T('settings.import.still_out', { list: report.refused_out_for_signature.map((x) => `"${x.subject}"`).join(', ') })}</p>}
                {report.not_imported.length > 0 && (
                  <details style={{ marginTop: 8 }} open={!Object.values(report.imported).some((n) => n > 0) && !onlyRepeats(report)}>
                    <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>{T('settings.import.not_in', { count: report.not_imported.length })}</summary>
                    <ul className="rules small">{report.not_imported.map((n, i) => <li key={i}><b>{n.what}: {n.name}.</b> {n.why}</li>)}</ul>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      </details>
      {records.length > 0 && <p className="small" style={{ margin: '12px 0 0' }}><Link href="/app/imported" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>{T('imported.link', { count: String(records.length) })}</Link></p>}
    </div>
  );
}
