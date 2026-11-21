'use client';
import { Suspense, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, useLoad } from '@/components/ui';
import { fmtNum, totalWorthShowing } from '@/lib/impact';
import { SOURCE_LOCALE, t } from '@/lib/i18n';
import { defaultPeriod, durationText, readDay } from '@/lib/reports';
// Filters, the tables by template and by sender, and the CSV link (src/server/reports.ts, GET /reports).
import { ReportFilters, ReportTable, QUERY_KEYS, queryString, type ReportQuery } from '@/components/reports/ReportParts';
import '../../styles/reports.css';

const ui = SOURCE_LOCALE;
// "21 Nov 2026" and "Nov 2026" for a YYYY-MM-DD day or a YYYY-MM month, in UTC as the report counts them.
const dayWords = (d: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${d}T00:00:00Z`));
const monthWords = (m: string) => new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${m}-01T00:00:00Z`));

export default function ReportsPage() {
  return <Suspense fallback={<div className="muted" role="status">Loading…</div>}><Reports /></Suspense>;
}

// The filters live in the address (?from=&to=&status=...), so the link in the monthly email opens that month and a
// report can be shared with a colleague who may see the same.
function Reports() {
  const params = useSearchParams();
  const router = useRouter();
  const q: ReportQuery = useMemo(() => {
    const d = defaultPeriod();
    const o = Object.fromEntries(QUERY_KEYS.map((k) => [k, params.get(k) || ''])) as ReportQuery;
    return { ...o, from: o.from || d.from, to: o.to || d.to };
  }, [params]);
  const qs = queryString(q);
  const [r, , err] = useLoad<any>(() => api(`/reports?${qs}`), [qs]);
  const [customs] = useLoad<any>(() => api('/custom-fields'), []);
  const change = (p: Partial<ReportQuery>) => router.replace(`/app/reports?${queryString({ ...q, ...p })}`, { scroll: false });
  // A link with days the report cannot use (a mistyped day, or too long a period): the reason, the filters to fix
  // it with (a day that cannot be read starts from the default), and one way back to the usual report.
  if (err && !r) {
    const d = defaultPeriod();
    const fix = { ...q, from: readDay(q.from) || d.from, to: readDay(q.to) || d.to };
    return (
      <div className="stack">
        <div className="pagehead rp-head" style={{ marginBottom: 0 }}><h1 className="serif">Reports</h1></div>
        <div className="notice err" role="alert">{err?.message || t(ui, 'reports.load_failed')} <a href="/app/reports">{t(ui, 'reports.bad_link')}</a></div>
        <ReportFilters q={fix} choices={null} customs={[]} onChange={(p) => change({ ...fix, ...p })} />
      </div>
    );
  }
  if (!r) return <div className="muted" role="status">Loading…</div>;
  const max = Math.max(1, ...r.months.map((m: any) => m.sent));
  const tot = r.totals;
  return (
    <div className="stack">
      <div className="pagehead rp-head" style={{ marginBottom: 0 }}>
        <h1 className="serif">Reports</h1>
        <a className="btn sm" href={`/api/reports/csv?${qs}`} download>{t(ui, 'reports.csv')}</a>
      </div>
      <ReportFilters key={qs} q={q} choices={r.choices} customs={[...(customs?.fields || []).map((f: any) => f.name), ...(customs?.past_names || [])]} onChange={change} />
      {err && <div className="notice err" role="alert">{err.message}</div>}
      <p className="muted small" style={{ margin: 0 }}>{t(ui, 'reports.counted')}</p>
      {/* Nothing sent in the period: one sentence, not the same empty state under every table. */}
      {r.totals.sent === 0 ? <div className="card"><div className="empty">{t(ui, 'reports.empty', { from: dayWords(r.from), to: dayWords(r.to) })}</div></div> : <>
      <div className="grid g4 keep2">
        <div className="stat"><div className="k">{t(ui, 'reports.sent')}</div><div className="v num">{fmtNum(tot.sent)}</div></div>
        <div className="stat"><div className="k">{t(ui, 'reports.finished')}</div><div className="v num">{fmtNum(tot.completed)}</div><div className="s">{tot.sent ? t(ui, 'reports.finished_of', { sent: tot.sent, pct: Math.round((tot.completed / tot.sent) * 100) }) : t(ui, 'reports.none_sent')}</div></div>
        <div className="stat"><div className="k">{t(ui, 'reports.time')}</div><div className="v num">{durationText(tot.median_hours)}</div><div className="s">{t(ui, 'reports.time_hint')}</div></div>
        {/* A total of paper only once it is large enough to mean something (src/lib/impact.ts). */}
        {totalWorthShowing(r.impact.sheets) && <div className="stat green"><div className="k">Sheets of paper not used, estimated</div><div className="v num">{fmtNum(r.impact.sheets)}</div><div className="s">{fmtNum(r.impact.litresWater)} L of water</div></div>}
      </div>

      <ReportTable title={t(ui, 'reports.by_template')} first={t(ui, 'reports.col_template')} rows={r.templates} empty="" />
      {/* By sender once there is more than one sender to compare: a person working alone would only see themselves. */}
      {r.may_see_senders && (r.choices?.senders?.length || 0) > 1 && <ReportTable title={t(ui, 'reports.by_sender')} first={t(ui, 'reports.col_sender')} rows={r.senders} empty="" />}

      <div className="card">
        <h2 style={{ marginBottom: 14 }}>Documents per month</h2>
        {r.months.length === 0 ? null : (
          <div role="img" aria-label="Bar chart of documents sent and finished per month" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', height: 180, overflowX: 'auto' }}>
            {r.months.map((m: any) => (
              <div key={m.month} style={{ flex: '1 0 44px', maxWidth: 80, textAlign: 'center' }} title={`${monthWords(m.month)}: ${m.sent} sent, ${m.completed} finished`}>
                <div className="small num" style={{ fontWeight: 600 }}>{m.sent}</div>
                <div style={{ height: 130, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                  <div style={{ width: '70%', height: `${(m.sent / max) * 100}%`, minHeight: 3, background: '#cfe3d2', borderRadius: '4px 4px 0 0', display: 'flex', alignItems: 'flex-end' }}>
                    <div style={{ width: '100%', height: `${m.sent ? (m.completed / m.sent) * 100 : 0}%`, background: 'var(--green)', borderRadius: '4px 4px 0 0' }} />
                  </div>
                </div>
                <div className="muted small num">{monthWords(m.month)}</div>
              </div>
            ))}
          </div>
        )}
        <div className="row small muted" style={{ marginTop: 10 }}><span className="dot" style={{ background: 'var(--green)' }} /> Finished <span className="dot" style={{ background: '#cfe3d2', marginLeft: 10 }} /> Sent</div>
      </div>

      <div className="rp-status">
        <div className="card">
          <h2 style={{ marginBottom: 10 }}>By status</h2>
          {['sent', 'completed', 'declined', 'voided', 'expired'].map((s) => (
            <div key={s} className="row between" style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}><span className="rp-cap">{s === 'sent' ? 'Waiting for others' : s === 'voided' ? 'cancelled' : s === 'completed' ? 'finished' : s === 'expired' ? 'ran out of time' : s}</span><b className="num">{r.byStatus[s] || 0}</b></div>
          ))}
        </div>
      </div>
      </>}
    </div>
  );
}
