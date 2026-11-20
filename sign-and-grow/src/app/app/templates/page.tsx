'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, useLoad, fmtDate, Modal, oops, toast } from '@/components/ui';

export default function Templates() {
  const router = useRouter();
  const [data, reload] = useLoad(() => api('/envelopes?kind=template'));
  const [use, setUse] = useState<any>(null);
  const [fill, setFill] = useState<Record<string, { name: string; email: string }>>({});
  const [busy, setBusy] = useState(false);

  async function start(t: any) {
    const { envelope } = await api(`/envelopes/${t.id}`);
    const open = envelope.recipients.filter((r: any) => !r.email);
    setFill(Object.fromEntries(open.map((r: any) => [r.id, { name: '', email: '' }])));
    setUse({ ...envelope, open });
  }
  async function create(send: boolean) {
    setBusy(true);
    try {
      const { envelope } = await api('/envelopes', { body: { template_id: use.id, recipients: fill, send } });
      toast(send ? 'Sent' : 'Draft created');
      router.push(send ? `/app/envelopes/${envelope.id}` : `/app/envelopes/${envelope.id}/edit`);
    } catch (e) {
      oops(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="pagehead">
        <div><h1 className="serif">Templates</h1><div className="muted">Set a document up once, then send it again in seconds. Shared with your whole team.</div></div>
        <Link href="/app/envelopes/new?kind=template" className="btn primary">New template</Link>
      </div>
      <div className="card pad0">
        {data && data.envelopes.length === 0 ? <div className="empty"><h3>No templates yet</h3>Great for contracts, NDAs, waivers and anything else you send more than once.</div> : (
          <div className="tablewrap"><table className="t">
            <thead><tr><th>Template</th><th>Roles</th><th className="hide-sm">Pages</th><th className="hide-sm">Updated</th><th /></tr></thead>
            <tbody>
              {(data?.envelopes || []).map((t: any) => (
                <tr key={t.id}>
                  <td><b>{t.subject || 'Untitled template'}</b><div className="muted small">by {t.sender}</div></td>
                  <td className="small">{t.recipients.map((r: any) => r.role_name || r.name).filter(Boolean).join(', ') || 'None yet'}</td>
                  <td className="hide-sm num">{t.pages}</td>
                  <td className="hide-sm muted small">{fmtDate(t.updated_at)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn sm primary" onClick={() => start(t).catch(oops)}>Use</button>{' '}
                    <Link className="btn sm" href={`/app/templates/${t.id}/edit`}>Edit</Link>{' '}
                    <button className="btn sm ghost danger" onClick={() => window.confirm('Delete this template?') && api(`/envelopes/${t.id}`, { method: 'DELETE' }).then(reload).catch(oops)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      {use && (
        <Modal title={`Use "${use.subject || 'template'}"`} onClose={() => setUse(null)}>
          {use.open.length === 0 && <p className="muted">Every recipient is already set in this template.</p>}
          {use.open.map((r: any) => (
            <div key={r.id} style={{ marginBottom: 12 }}>
              <b className="small">{r.role_name || 'Recipient'}</b>
              <div className="row" style={{ marginTop: 5 }}>
                <input placeholder="Full name" aria-label={`${r.role_name} name`} value={fill[r.id]?.name || ''} onChange={(e) => setFill({ ...fill, [r.id]: { ...fill[r.id], name: e.target.value } })} />
                <input placeholder="Email" type="email" aria-label={`${r.role_name} email`} value={fill[r.id]?.email || ''} onChange={(e) => setFill({ ...fill, [r.id]: { ...fill[r.id], email: e.target.value } })} />
              </div>
            </div>
          ))}
          <div className="actions">
            <button className="btn" disabled={busy} onClick={() => create(false)}>Review first</button>
            <button className="btn primary" disabled={busy} onClick={() => create(true)}>Send now</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
