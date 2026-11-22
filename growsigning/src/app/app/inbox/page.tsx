'use client';
import { api, useLoad, Status, fmtDate } from '@/components/ui';
import { useST } from '@/components/senderLang';
import { howLongIn } from '@/lib/senderlang';

const verb = (role: string) => (role === 'approver' ? 'inbox.review' : role === 'viewer' ? 'inbox.view' : 'inbox.sign');

export default function Inbox() {
  const T = useST();
  const [data, reload, error] = useLoad<any>(() => api('/inbox'));
  const needsMe = (i: any) => i.status === 'sent' && (i.my_status === 'sent' || i.my_status === 'viewed') && i.role !== 'cc';
  // What still needs you comes first, the longest wait at the top.
  const items: any[] = [...(data?.items || [])].sort((a, b) => Number(needsMe(b)) - Number(needsMe(a)) || (needsMe(a) ? String(a.sent_at).localeCompare(String(b.sent_at)) : 0));
  const waiting = items.filter(needsMe).length;

  return (
    <div className="sn">
      <div className="pagehead">
        <div>
          <h1 className="serif">{T('inbox.title')}</h1>
          <div className="muted">{T('inbox.lede')}{waiting > 0 ? ` ${T('inbox.waiting', { count: waiting })}` : ''}</div>
        </div>
      </div>
      {data?.needs_verification && <div className="notice warn" style={{ marginBottom: 14 }}>{T('inbox.confirm_first')}</div>}
      <div className="card pad0">
        {error ? (
          <div className="empty" role="alert"><h3>{T('inbox.load_failed')}</h3>{T('inbox.load_failed_body')}<div style={{ marginTop: 14 }}><button className="btn" onClick={reload}>{T('inbox.try_again')}</button></div></div>
        ) : !data ? (
          <div className="empty" role="status">{T('inbox.loading')}</div>
        ) : items.length === 0 ? (
          <div className="empty"><h3>{T('inbox.none')}</h3>{T('inbox.none_body')}</div>
        ) : (
          <div className="tablewrap"><table className="t sn-list">
            <thead><tr><th>{T('inbox.col_subject')}</th><th className="hide-sm">{T('inbox.col_from')}</th><th className="hide-sm">{T('inbox.col_status')}</th><th className="hide-sm">{T('inbox.col_received')}</th><th><span className="sn-vh">{T('inbox.col_open')}</span></th></tr></thead>
            <tbody>
              {items.map((i) => {
                const open = needsMe(i);
                return (
                  <tr key={i.id + i.token}>
                    <td className="sn-main">
                      <b>{i.subject}</b>
                      <div className="sn-only-sm sn-rowmeta">
                        <Status s={i.status} label={open ? T('inbox.needs_you') : undefined} />
                        <span className="muted small">{T('inbox.from', { name: i.sender, day: fmtDate(i.sent_at) })}</span>
                      </div>
                    </td>
                    <td className="hide-sm">{i.sender}</td>
                    <td className="hide-sm"><Status s={i.status} label={open ? T('inbox.needs_you') : undefined} /></td>
                    <td className="hide-sm muted small">{fmtDate(i.sent_at)}{open && i.sent_at ? <div>{T('inbox.ago', { time: howLongIn(T.lang, i.sent_at) })}</div> : null}</td>
                    <td className="sn-fit"><a className={`btn sm${open ? ' primary' : ''}`} href={`/sign/${i.token}`} aria-label={T('inbox.action_label', { action: T(open ? verb(i.role) : 'inbox.open'), subject: i.subject })}>{T(open ? verb(i.role) : 'inbox.open')}</a></td>
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
