'use client';
// Click-to-agree terms of the team: a list, the month's count, and a way to start new terms. Each one is worked on at
// /app/agreements/<id>. Only the owner and admins reach this (the routes answer 403 to anyone else).
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, useLoad, fmtDate, oops } from '@/components/ui';
import { NOT_A_SIGNATURE, STATE_LABEL } from '@/lib/clickwrap';
import { useST } from '@/components/senderLang';

export default function Agreements() {
  const T = useST();
  const [data, , error] = useLoad(() => api('/clickwraps'));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  if (error) return <div className="card cw-team"><h1 className="serif">{T('terms.title')}</h1><p style={{ marginTop: 8 }}>{error.status === 403 ? T('terms.admins_only') : error.message}</p></div>;
  return (
    <div className="stack cw-team">
      <div className="pagehead" style={{ marginBottom: 0 }}>
        <div><h1 className="serif">{T('terms.title')}</h1><div className="muted">{T('terms.lede')}</div></div>
      </div>
      {data && <div className="notice">{data.usage.line} {NOT_A_SIGNATURE}</div>}
      <form className="card" onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        api('/clickwraps', { body: { name } }).then((r) => router.push(`/app/agreements/${r.id}`)).catch((err) => (oops(err), setBusy(false)));
      }}>
        <h2 style={{ marginBottom: 12 }}>{T('terms.new')}</h2>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <label className="f grow" style={{ margin: 0, minWidth: 220 }}><span>{T('terms.name')}</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder={T('terms.name_placeholder')} required /></label>
          <button className="btn primary" disabled={!name.trim() || busy}>{T('terms.start')}</button>
        </div>
        <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>{T('terms.nothing_shown')}</p>
      </form>
      <div className="card pad0">
        {data && data.agreements.length === 0 ? <div className="empty"><h3>{T('terms.none')}</h3>{T('terms.none_body')}</div> : (
          <div className="tablewrap"><table className="t">
            <thead><tr><th>{T('terms.col_terms')}</th><th>{T('terms.col_state')}</th><th>{T('terms.col_accepted')}</th><th>{T('terms.col_changed')}</th></tr></thead>
            <tbody>
              {(data?.agreements || []).map((k: any) => (
                <tr key={k.id}>
                  <td className="cw-cell"><Link href={`/app/agreements/${k.id}`}><b>{k.name}</b></Link><div className="muted small">{k.current_version ? T('terms.version', { n: String(k.current_version) }) : T('terms.unpublished')}{k.signed_only ? T('terms.named_only') : ''}</div></td>
                  <td><span className={`cw-state ${k.state}`}>{STATE_LABEL[k.state] || k.state}</span>{k.why && <div className="muted small" style={{ maxWidth: 280, whiteSpace: 'normal' }}>{T('terms.see_why')}</div>}</td>
                  <td className="num">{k.accepted}<div className="muted small">{T('terms.this_month', { count: k.accepted_month })}</div></td>
                  <td className="muted small">{fmtDate(k.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
