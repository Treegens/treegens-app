'use client';
import { api, useLoad, Status, fmtDate } from '@/components/ui';

export default function Inbox() {
  const [data] = useLoad(() => api('/inbox'));
  return (
    <div>
      <div className="pagehead"><div><h1 className="serif">Inbox</h1><div className="muted">Documents other people sent to you.</div></div></div>
      {data?.needs_verification && <div className="notice warn" style={{ marginBottom: 14 }}>Confirm your email address first. Until then we cannot show documents sent to it.</div>}
      <div className="card pad0">
        {data && data.items.length === 0 ? <div className="empty"><h3>Your inbox is empty</h3>When someone sends you a document through Treegens Sign, it appears here as well as in your email.</div> : (
          <div className="tablewrap"><table className="t">
            <thead><tr><th>Subject</th><th>From</th><th>Status</th><th>Received</th><th /></tr></thead>
            <tbody>
              {(data?.items || []).map((i: any) => {
                const open = i.status === 'sent' && (i.my_status === 'sent' || i.my_status === 'viewed');
                return (
                  <tr key={i.id + i.token}>
                    <td><b>{i.subject}</b></td>
                    <td>{i.sender}</td>
                    <td><Status s={i.status} label={open ? 'Needs you' : undefined} /></td>
                    <td className="muted small">{fmtDate(i.sent_at)}</td>
                    <td style={{ textAlign: 'right' }}><a className={`btn sm${open ? ' primary' : ''}`} href={`/sign/${i.token}`}>{open ? (i.role === 'approver' ? 'Review' : i.role === 'viewer' ? 'View' : 'Sign') : 'Open'}</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
