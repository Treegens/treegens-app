'use client';
import { api, useLoad } from '@/components/ui';
import { fmtNum, totalWorthShowing } from '@/lib/impact';

export default function Reports() {
  const [r] = useLoad(() => api('/reports/summary'));
  if (!r) return <div className="muted">Loading…</div>;
  const max = Math.max(1, ...r.months.map((m: any) => m.sent));
  const hours = r.avgHours;
  return (
    <div className="stack">
      <div className="pagehead" style={{ marginBottom: 0 }}><h1 className="serif">Reports</h1></div>
      <div className="grid g4 keep2">
        <div className="stat"><div className="k">Envelopes sent</div><div className="v num">{fmtNum(r.sent)}</div></div>
        <div className="stat"><div className="k">Completed</div><div className="v num">{fmtNum(r.completed)}</div><div className="s">{r.completionRate == null ? 'No sends yet' : `${Math.round(r.completionRate * 100)}% completion rate`}</div></div>
        <div className="stat"><div className="k">Average time to complete</div><div className="v num">{hours == null ? '–' : hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} d`}</div></div>
        {/* A total of paper only once it is large enough to mean something (src/lib/impact.ts). */}
        {totalWorthShowing(r.impact.sheets) && <div className="stat green"><div className="k">Sheets of paper not used, estimated</div><div className="v num">{fmtNum(r.impact.sheets)}</div><div className="s">{fmtNum(r.impact.litresWater)} L of water</div></div>}
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 14 }}>Envelopes per month</h2>
        {r.months.length === 0 ? <div className="muted">Send your first document to see activity here.</div> : (
          <div role="img" aria-label="Bar chart of documents sent and completed per month" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', height: 180, overflowX: 'auto' }}>
            {r.months.map((m: any) => (
              <div key={m.month} style={{ flex: '1 0 44px', maxWidth: 80, textAlign: 'center' }} title={`${m.month}: ${m.sent} sent, ${m.completed} completed`}>
                <div className="small num" style={{ fontWeight: 600 }}>{m.sent}</div>
                <div style={{ height: 130, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                  <div style={{ width: '70%', height: `${(m.sent / max) * 100}%`, minHeight: 3, background: '#cfe3d2', borderRadius: '4px 4px 0 0', display: 'flex', alignItems: 'flex-end' }}>
                    <div style={{ width: '100%', height: `${m.sent ? (m.completed / m.sent) * 100 : 0}%`, background: 'var(--green)', borderRadius: '4px 4px 0 0' }} />
                  </div>
                </div>
                <div className="muted small num">{m.month.slice(2)}</div>
              </div>
            ))}
          </div>
        )}
        <div className="row small muted" style={{ marginTop: 10 }}><span className="dot" style={{ background: 'var(--green)' }} /> Completed <span className="dot" style={{ background: '#cfe3d2', marginLeft: 10 }} /> Sent</div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h2 style={{ marginBottom: 10 }}>By status</h2>
          {['draft', 'sent', 'completed', 'declined', 'voided', 'expired'].map((s) => (
            <div key={s} className="row between" style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}><span style={{ textTransform: 'capitalize' }}>{s === 'sent' ? 'Waiting for others' : s}</span><b className="num">{r.byStatus[s] || 0}</b></div>
          ))}
        </div>
        {r.senders.length > 0 && (
          <div className="card">
            <h2 style={{ marginBottom: 10 }}>By team member</h2>
            {r.senders.map((s: any) => <div key={s.name} className="row between" style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}><span>{s.name}</span><span className="num muted small">{s.completed} of {s.sent} completed</span></div>)}
          </div>
        )}
      </div>
    </div>
  );
}
