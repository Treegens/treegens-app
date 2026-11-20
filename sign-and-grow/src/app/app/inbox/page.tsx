'use client';
import { api, useLoad, Status, fmtDate } from '@/components/ui';
import { howLong } from '@/components/sender/lib';

const verb = (role: string) => (role === 'approver' ? 'Review' : role === 'viewer' ? 'View' : 'Sign');

export default function Inbox() {
  const [data, reload, error] = useLoad<any>(() => api('/inbox'));
  const needsMe = (i: any) => i.status === 'sent' && (i.my_status === 'sent' || i.my_status === 'viewed') && i.role !== 'cc';
  // What still needs you comes first, the longest wait at the top.
  const items: any[] = [...(data?.items || [])].sort((a, b) => Number(needsMe(b)) - Number(needsMe(a)) || (needsMe(a) ? String(a.sent_at).localeCompare(String(b.sent_at)) : 0));
  const waiting = items.filter(needsMe).length;

  return (
    <div className="sn">
      <div className="pagehead">
        <div>
          <h1 className="serif">Inbox</h1>
          <div className="muted">Documents other people sent to you.{waiting > 0 ? ` ${waiting} ${waiting === 1 ? 'is' : 'are'} waiting for you.` : ''}</div>
        </div>
      </div>
      {data?.needs_verification && <div className="notice warn" style={{ marginBottom: 14 }}>Confirm your email address first, with the link we emailed you or the button in the banner above. Until then we cannot show documents sent to it.</div>}
      <div className="card pad0">
        {error ? (
          <div className="empty" role="alert"><h3>We could not load your inbox</h3>Check your connection, then try again.<div style={{ marginTop: 14 }}><button className="btn" onClick={reload}>Try again</button></div></div>
        ) : !data ? (
          <div className="empty" role="status">Loading…</div>
        ) : items.length === 0 ? (
          <div className="empty"><h3>Your inbox is empty</h3>When someone sends you a document through Sign&Grow, it appears here as well as in your email.</div>
        ) : (
          <div className="tablewrap"><table className="t sn-list">
            <thead><tr><th>Subject</th><th className="hide-sm">From</th><th className="hide-sm">Status</th><th className="hide-sm">Received</th><th><span className="sn-vh">Open</span></th></tr></thead>
            <tbody>
              {items.map((i) => {
                const open = needsMe(i);
                return (
                  <tr key={i.id + i.token}>
                    <td className="sn-main">
                      <b>{i.subject}</b>
                      <div className="sn-only-sm sn-rowmeta">
                        <Status s={i.status} label={open ? 'Needs you' : undefined} />
                        <span className="muted small">from {i.sender} · {fmtDate(i.sent_at)}</span>
                      </div>
                    </td>
                    <td className="hide-sm">{i.sender}</td>
                    <td className="hide-sm"><Status s={i.status} label={open ? 'Needs you' : undefined} /></td>
                    <td className="hide-sm muted small">{fmtDate(i.sent_at)}{open && i.sent_at ? <div>{howLong(i.sent_at)} ago</div> : null}</td>
                    <td className="sn-fit"><a className={`btn sm${open ? ' primary' : ''}`} href={`/sign/${i.token}`} aria-label={`${open ? verb(i.role) : 'Open'} ${i.subject}`}>{open ? verb(i.role) : 'Open'}</a></td>
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
