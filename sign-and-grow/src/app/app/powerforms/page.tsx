'use client';
import { useState } from 'react';
import { api, useLoad, fmtDate, oops, toast } from '@/components/ui';

export default function PowerForms() {
  const [tpls] = useLoad(() => api('/envelopes?kind=template'));
  const [data, reload] = useLoad(() => api('/powerforms'));
  const [tid, setTid] = useState('');
  const [name, setName] = useState('');
  const link = (slug: string) => `${window.location.origin}/f/${slug}`;

  return (
    <div className="stack">
      <div className="pagehead" style={{ marginBottom: 0 }}><div><h1 className="serif">PowerForms</h1><div className="muted">A public link anyone can open to fill in and sign a template. Put it on your website, in a QR code or in an email.</div></div></div>
      <div className="card">
        <h2 style={{ marginBottom: 12 }}>Create a PowerForm</h2>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <label className="f grow" style={{ margin: 0, minWidth: 200 }}><span>Template</span>
            <select value={tid} onChange={(e) => setTid(e.target.value)}>
              <option value="">Choose a template…</option>
              {(tpls?.envelopes || []).map((t: any) => <option key={t.id} value={t.id}>{t.subject || 'Untitled template'}</option>)}
            </select>
          </label>
          <label className="f grow" style={{ margin: 0, minWidth: 200 }}><span>Name shown to signers</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Volunteer waiver" /></label>
          <button className="btn primary" disabled={!tid} onClick={() => api('/powerforms', { body: { template_id: tid, name } }).then(() => (toast('PowerForm created'), setName(''), setTid(''), reload())).catch(oops)}>Create</button>
        </div>
        <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>The template needs exactly one open signer role. That is the person who fills in the form.</p>
      </div>
      <div className="card pad0">
        {data && data.powerforms.length === 0 ? <div className="empty"><h3>No PowerForms yet</h3>Create one above to collect signatures without sending anything.</div> : (
          <div className="tablewrap"><table className="t">
            <thead><tr><th>Name</th><th>Link</th><th>Signed</th><th>Created</th><th /></tr></thead>
            <tbody>
              {(data?.powerforms || []).map((p: any) => (
                <tr key={p.id}>
                  <td><b>{p.name}</b><div className="muted small">{p.template || 'Template deleted'}</div></td>
                  <td><button className="btn sm" onClick={() => navigator.clipboard.writeText(link(p.slug)).then(() => toast('Link copied'))}>Copy link</button> <a className="small" href={`/f/${p.slug}`} target="_blank" rel="noreferrer">Open</a></td>
                  <td className="num">{p.uses}</td>
                  <td className="muted small">{fmtDate(p.created_at)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn sm ghost" onClick={() => api(`/powerforms/${p.id}`, { method: 'PATCH', body: { active: !p.active } }).then(reload).catch(oops)}>{p.active ? 'Pause' : 'Resume'}</button>
                    <button className="btn sm ghost danger" onClick={() => window.confirm('Delete this PowerForm? The link will stop working.') && api(`/powerforms/${p.id}`, { method: 'DELETE' }).then(reload).catch(oops)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
