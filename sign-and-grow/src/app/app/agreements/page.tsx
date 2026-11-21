'use client';
// Click-to-agree terms of the team: a list, the month's count, and a way to start new terms. Each one is worked on at
// /app/agreements/<id>. Only the owner and admins reach this (the routes answer 403 to anyone else).
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, useLoad, fmtDate, oops } from '@/components/ui';
import { NOT_A_SIGNATURE, STATE_LABEL } from '@/lib/clickwrap';

export default function Agreements() {
  const [data, , error] = useLoad(() => api('/clickwraps'));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  if (error) return <div className="card cw-team"><h1 className="serif">Website terms</h1><p style={{ marginTop: 8 }}>{error.status === 403 ? 'Only the owner and the admins of your team manage website terms, because they speak for your website. Ask one of them.' : error.message}</p></div>;
  return (
    <div className="stack cw-team">
      <div className="pagehead" style={{ marginBottom: 0 }}>
        <div><h1 className="serif">Website terms</h1><div className="muted">Terms that visitors of your website accept with one click: on a page of their own, inside a frame on your website, or recorded by your website through the API. Each acceptance is kept with the version and a fingerprint of the exact terms, who (as your website or the visitor gave it), when, the internet address, the browser and the page.</div></div>
      </div>
      {data && <div className="notice">{data.usage.line} {NOT_A_SIGNATURE}</div>}
      <form className="card" onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        api('/clickwraps', { body: { name } }).then((r) => router.push(`/app/agreements/${r.id}`)).catch((err) => (oops(err), setBusy(false)));
      }}>
        <h2 style={{ marginBottom: 12 }}>New terms</h2>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <label className="f grow" style={{ margin: 0, minWidth: 220 }}><span>Name visitors see</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Terms of service" required /></label>
          <button className="btn primary" disabled={!name.trim() || busy}>Start writing</button>
        </div>
        <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>Nothing is shown to anyone until you publish. You write the terms next, or choose a PDF.</p>
      </form>
      <div className="card pad0">
        {data && data.agreements.length === 0 ? <div className="empty"><h3>No website terms yet</h3>Start one above.</div> : (
          <div className="tablewrap"><table className="t">
            <thead><tr><th>Terms</th><th>State</th><th>Accepted</th><th>Changed</th></tr></thead>
            <tbody>
              {(data?.agreements || []).map((k: any) => (
                <tr key={k.id}>
                  <td className="cw-cell"><Link href={`/app/agreements/${k.id}`}><b>{k.name}</b></Link><div className="muted small">{k.current_version ? `Version ${k.current_version}` : 'Not published yet'}{k.signed_only ? ' · only people the website names' : ''}</div></td>
                  <td><span className={`cw-state ${k.state}`}>{STATE_LABEL[k.state] || k.state}</span>{k.why && <div className="muted small" style={{ maxWidth: 280, whiteSpace: 'normal' }}>Open it to see why.</div>}</td>
                  <td className="num">{k.accepted}<div className="muted small">{k.accepted_month} this month</div></td>
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
