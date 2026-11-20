'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, useLoad, Status, fmtDate, oops, toast } from '@/components/ui';

const BOXES: [string, string][] = [['all', 'All'], ['drafts', 'Drafts'], ['waiting', 'Waiting for others'], ['completed', 'Completed'], ['closed', 'Declined, voided, expired']];

export default function Envelopes() {
  const router = useRouter();
  const [box, setBox] = useState('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState('');
  useEffect(() => {
    setBox(new URLSearchParams(window.location.search).get('box') || 'all');
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const [data, reload] = useLoad(() => api(`/envelopes?box=${box}&q=${encodeURIComponent(query)}&folder=${encodeURIComponent(folder)}`), [box, query, folder]);

  async function move(e: any) {
    const name = window.prompt('Move to folder (leave empty to remove from its folder):', e.folder || '');
    if (name === null) return;
    await api(`/envelopes/${e.id}`, { method: 'PATCH', body: { folder: name } }).then(() => (toast('Moved'), reload())).catch(oops);
  }

  return (
    <div>
      <div className="pagehead">
        <h1 className="serif">Envelopes</h1>
        <Link href="/app/envelopes/new" className="btn primary">New envelope</Link>
      </div>
      <div className="tabs">{BOXES.map(([k, l]) => <button key={k} className={box === k ? 'on' : ''} onClick={() => setBox(k)}>{l}</button>)}</div>
      <div className="row wrap" style={{ marginBottom: 14 }}>
        <input placeholder="Search by subject, recipient or envelope ID" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 380 }} aria-label="Search envelopes" />
        {data && data.folders.length > 0 && (
          <select value={folder} onChange={(e) => setFolder(e.target.value)} style={{ maxWidth: 200 }} aria-label="Folder">
            <option value="">All folders</option>{data.folders.map((f: string) => <option key={f}>{f}</option>)}
          </select>
        )}
      </div>
      <div className="card pad0">
        {data && data.envelopes.length === 0 ? (
          <div className="empty"><h3>No envelopes here</h3>{query ? 'Nothing matches that search.' : 'Envelopes you create will show up in this list.'}</div>
        ) : (
          <div className="tablewrap"><table className="t">
            <thead><tr><th>Subject</th><th>Status</th><th className="hide-sm">Progress</th><th className="hide-sm">Folder</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {(data?.envelopes || []).map((e: any) => {
                const acting = e.recipients.filter((r: any) => r.role !== 'cc');
                return (
                  <tr key={e.id} className="click" onClick={() => router.push(e.status === 'draft' ? `/app/envelopes/${e.id}/edit` : `/app/envelopes/${e.id}`)}>
                    <td><b>{e.subject || 'Untitled draft'}</b><div className="muted small truncate" style={{ maxWidth: 380 }}>To: {e.recipients.map((r: any) => r.name).filter(Boolean).join(', ') || 'nobody yet'}</div></td>
                    <td><Status s={e.status} /></td>
                    <td className="hide-sm num muted small">{e.status === 'draft' ? '' : `${acting.filter((r: any) => r.status === 'completed').length} of ${acting.length} done`}</td>
                    <td className="hide-sm muted small">{e.folder || ''}</td>
                    <td className="muted small" style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.updated_at)}</td>
                    <td onClick={(ev) => ev.stopPropagation()} style={{ whiteSpace: 'nowrap', textAlign: 'right' }}><button className="btn sm ghost" onClick={() => move(e)}>Move</button></td>
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
