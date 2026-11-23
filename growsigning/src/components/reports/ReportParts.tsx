'use client';
// The Reports page's filters and tables (src/app/app/reports/page.tsx, GET /reports, GET /reports/csv). Dates and
// status in one row; sender, template, folder and a custom field behind "More options", which stays open while one
// of them is set, so nothing that narrows the numbers is ever out of sight; then the button reads "Clear these filters".
import { useState } from 'react';
import { SOURCE_LOCALE, t } from '@/lib/i18n';
import { REPORT_STATUSES, STATUS_WORDS, durationText, finishedText } from '@/lib/reports';

const ui = SOURCE_LOCALE;
export type ReportQuery = { from: string; to: string; status: string; sender: string; template: string; folder: string; field: string; value: string };
export const QUERY_KEYS: (keyof ReportQuery)[] = ['from', 'to', 'status', 'sender', 'template', 'folder', 'field', 'value'];
export const queryString = (q: Partial<ReportQuery>) => new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();

export function ReportFilters({ q, choices, customs, onChange }: { q: ReportQuery; choices: any; customs: string[]; onChange: (p: Partial<ReportQuery>) => void }) {
  const set = !!(q.sender || q.template || q.folder || q.field);
  const [open, setOpen] = useState(set);
  const shown = open || set;
  const hasMore = (choices?.senders?.length || 0) > 1 || (choices?.templates?.length || 0) > 0 || (choices?.folders?.length || 0) > 0 || customs.length > 0;
  return (
    <div className="rp-filters" role="group" aria-label={t(ui, 'reports.filters')}>
      <div className="rp-row">
        <label className="f"><span>{t(ui, 'reports.from')}</span><input type="date" value={q.from} max={q.to || undefined} onChange={(e) => e.target.value && onChange({ from: e.target.value })} /></label>
        <label className="f"><span>{t(ui, 'reports.to')}</span><input type="date" value={q.to} min={q.from || undefined} onChange={(e) => e.target.value && onChange({ to: e.target.value })} /></label>
        <label className="f"><span>{t(ui, 'reports.status')}</span>
          <select value={q.status} onChange={(e) => onChange({ status: e.target.value })}>
            <option value="">{t(ui, 'reports.status_any')}</option>
            {REPORT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_WORDS[s]}</option>)}
          </select>
        </label>
        {/* While one of them is set the panel stays open and the button says what it does: it clears them. Closing
            the panel never changes the numbers by itself. */}
        {hasMore && (set
          ? <button type="button" className="btn sm ghost rp-more" onClick={() => onChange({ sender: '', template: '', folder: '', field: '', value: '' })}>{t(ui, 'reports.clear')}</button>
          : <button type="button" className="btn sm ghost rp-more" data-more="screen" aria-expanded={shown} aria-controls="rp-more" onClick={() => setOpen(!shown)}>{shown ? t(ui, 'reports.fewer') : t(ui, 'reports.more')}</button>)}
      </div>
      {shown && hasMore && (
        <div className="rp-row" id="rp-more">
          {(choices?.senders?.length || 0) > 1 && (
            <label className="f"><span>{t(ui, 'reports.sender')}</span>
              <select value={q.sender} onChange={(e) => onChange({ sender: e.target.value })}>
                <option value="">{t(ui, 'reports.sender_any')}</option>
                {choices.senders.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          {(choices?.templates?.length || 0) > 0 && (
            <label className="f"><span>{t(ui, 'reports.template')}</span>
              <select value={q.template} onChange={(e) => onChange({ template: e.target.value })}>
                <option value="">{t(ui, 'reports.template_any')}</option>
                <option value="none">{t(ui, 'reports.template_none')}</option>
                {choices.templates.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
          )}
          {(choices?.folders?.length || 0) > 0 && (
            <label className="f"><span>{t(ui, 'reports.folder')}</span>
              <select value={q.folder} onChange={(e) => onChange({ folder: e.target.value })}>
                <option value="">{t(ui, 'reports.folder_any')}</option>
                {choices.folders.map((f: string) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
          )}
          {customs.length > 0 && (
            <label className="f"><span>{t(ui, 'reports.field')}</span>
              <select value={q.field} onChange={(e) => onChange({ field: e.target.value, value: '' })}>
                <option value="">{t(ui, 'reports.field_any')}</option>
                {customs.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
          {q.field && <label className="f"><span>{t(ui, 'reports.value', { name: q.field })}</span><input type="search" defaultValue={q.value} onBlur={(e) => e.target.value.trim() !== q.value && onChange({ value: e.target.value.trim() })} onKeyDown={(e) => e.key === 'Enter' && onChange({ value: (e.target as HTMLInputElement).value.trim() })} placeholder={t(ui, 'reports.value_hint')} /></label>}
        </div>
      )}
    </div>
  );
}

/** A table of rows by template or by sender: sent, finished, time to finish, declined. On a phone, one card per row. */
export function ReportTable({ title, first, rows, empty }: { title: string; first: string; rows: any[]; empty: string }) {
  return (
    <section className="card pad0" aria-label={title}>
      <div className="sn-cardhead"><h2>{title}</h2></div>
      {rows.length === 0 ? <div className="empty">{empty}</div> : (
        <div className="tablewrap"><table className="t rp-table">
          <thead><tr><th scope="col">{first}</th><th scope="col" className="num">{t(ui, 'reports.col_sent')}</th><th scope="col" className="num">{t(ui, 'reports.col_finished')}</th><th scope="col" className="num">{t(ui, 'reports.col_time')}</th><th scope="col" className="num">{t(ui, 'reports.col_declined')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" className="rp-name">{r.name}</th>
                <td className="num" data-label={t(ui, 'reports.col_sent')}>{r.sent}</td>
                <td className="num" data-label={t(ui, 'reports.col_finished')}>{finishedText(r.completed, r.sent)}</td>
                <td className="num" data-label={t(ui, 'reports.col_time')}>{durationText(r.median_hours)}</td>
                <td className="num" data-label={t(ui, 'reports.col_declined')}>{r.declined}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
