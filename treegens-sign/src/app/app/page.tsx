'use client';
import Link from 'next/link';
import { api, useLoad, Status, fmtDate, Leaf } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { fmtNum, fmtTrees, PLANS } from '@/lib/impact';

export default function Home() {
  const me = useMe();
  const [rep] = useLoad(() => api('/reports/summary'));
  const [recent] = useLoad(() => api('/envelopes?limit=6'));
  const [inbox] = useLoad(() => api('/inbox'));
  const [impact] = useLoad(() => api('/impact'));
  const todo = (inbox?.items || []).filter((i: any) => i.status === 'sent' && (i.my_status === 'sent' || i.my_status === 'viewed') && i.role !== 'cc');
  const s = rep?.byStatus || {};

  return (
    <div className="stack">
      <div className="pagehead" style={{ marginBottom: 0 }}>
        <div>
          <h1 className="serif">Hello, {me.user.name.split(' ')[0]}</h1>
          <div className="muted">Every document you send here is one that never gets printed.</div>
        </div>
        <div className="row">
          <Link href="/app/envelopes/new?self=1" className="btn">Sign a document yourself</Link>
          <Link href="/app/envelopes/new" className="btn primary">Send for signature</Link>
        </div>
      </div>

      {todo.length > 0 && (
        <div className="card" style={{ borderColor: '#e6c56a', background: '#fffaf0' }}>
          <h3 style={{ marginBottom: 8 }}>Waiting for you</h3>
          {todo.map((i: any) => (
            <div key={i.id} className="row between" style={{ padding: '6px 0' }}>
              <div className="grow truncate"><b>{i.subject}</b> <span className="muted small">from {i.sender}</span></div>
              <a className="btn sm primary" href={`/sign/${i.token}`}>{i.role === 'approver' ? 'Review' : i.role === 'viewer' ? 'View' : 'Sign'}</a>
            </div>
          ))}
        </div>
      )}

      <div className="grid g4 keep2">
        <Link href="/app/envelopes?box=drafts" className="stat" style={{ textDecoration: 'none', color: 'inherit' }}><div className="k">Drafts</div><div className="v num">{s.draft || 0}</div></Link>
        <Link href="/app/envelopes?box=waiting" className="stat" style={{ textDecoration: 'none', color: 'inherit' }}><div className="k">Waiting for others</div><div className="v num">{s.sent || 0}</div></Link>
        <Link href="/app/envelopes?box=completed" className="stat" style={{ textDecoration: 'none', color: 'inherit' }}><div className="k">Completed</div><div className="v num">{s.completed || 0}</div></Link>
        <Link href="/app/impact" className="stat green" style={{ textDecoration: 'none' }}>
          <div className="k">Paper saved</div><div className="v num">{impact ? fmtNum(impact.account.sheets) : '…'}</div>
          <div className="s">sheets, or {impact ? fmtTrees(impact.account.trees) : '…'} of a tree</div>
        </Link>
      </div>

      {me.billing.limit != null && (
        <div className="notice row between wrap">
          <span><b>{PLANS.seedling.name} plan:</b> {me.billing.used} of {me.billing.limit} envelopes used this month.</span>
          <Link href="/app/settings?tab=billing" className="btn sm">Upgrade and plant trees</Link>
        </div>
      )}

      <div className="card pad0">
        <div className="row between" style={{ padding: '14px 16px' }}><h2>Recent envelopes</h2><Link href="/app/envelopes">See all</Link></div>
        {recent && recent.envelopes.length === 0 ? (
          <div className="empty"><Leaf size={32} color="#6fb35f" /><h3 style={{ marginTop: 10 }}>Nothing sent yet</h3>Upload a PDF, add who needs to sign and place the fields. It takes about a minute.<div style={{ marginTop: 14 }}><Link href="/app/envelopes/new" className="btn primary">Send your first envelope</Link></div></div>
        ) : (
          <div className="tablewrap"><table className="t"><tbody>
            {(recent?.envelopes || []).map((e: any) => (
              <tr key={e.id} className="click" onClick={() => (window.location.href = e.status === 'draft' ? `/app/envelopes/${e.id}/edit` : `/app/envelopes/${e.id}`)}>
                <td><b>{e.subject || 'Untitled draft'}</b><div className="muted small truncate" style={{ maxWidth: 420 }}>{e.recipients.map((r: any) => r.name).filter(Boolean).join(', ') || 'No recipients yet'}</div></td>
                <td><Status s={e.status} /></td>
                <td className="muted small" style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.updated_at)}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </div>
    </div>
  );
}
