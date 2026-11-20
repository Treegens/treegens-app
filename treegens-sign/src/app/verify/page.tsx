'use client';
import { useState } from 'react';
import { api, fmtDate } from '@/components/ui';
import { PublicNav, PublicFooter } from '@/components/Public';

export default function Verify() {
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);

  async function check(file?: File | null) {
    if (!file) return;
    setBusy(true);
    setError('');
    setRes(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      setRes({ ...(await api('/public/verify', { form: fd })), name: file.name });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PublicNav />
      <main className="wrap" style={{ maxWidth: 760, paddingTop: 24 }}>
        <h1 className="serif" style={{ fontSize: 36 }}>Verify a signed document</h1>
        <p className="muted" style={{ fontSize: 17, margin: '10px 0 22px' }}>Got a PDF that claims to be signed with Treegens Sign? Drop it here. We compare its fingerprint with the one recorded when signing finished. If a single byte was changed, it will not match.</p>
        <label className={`drop${over ? ' over' : ''}`} style={{ display: 'block', padding: 44 }}
          onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={(e) => (e.preventDefault(), setOver(false), check(e.dataTransfer.files[0]))}>
          <input type="file" accept="application/pdf" hidden onChange={(e) => check(e.target.files?.[0])} />
          <b>{busy ? 'Checking…' : 'Drop a PDF here or click to choose one'}</b>
          <div className="muted small">The file is hashed and then discarded. We do not keep it.</div>
        </label>
        {error && <div className="notice err" style={{ marginTop: 16 }}>{error}</div>}
        {res && res.match && (
          <div className="card" style={{ marginTop: 18, borderColor: 'var(--green)' }}>
            <div className="badge completed">Authentic and unchanged</div>
            <h2 style={{ margin: '10px 0 4px' }}>{res.envelope.subject}</h2>
            <div className="muted">Sent by {res.envelope.sender} · completed {fmtDate(res.envelope.completed_at, true)}</div>
            <table className="t" style={{ marginTop: 12 }}><tbody>
              {res.signers.map((s: any, i: number) => <tr key={i}><td style={{ paddingLeft: 0 }}><b>{s.name}</b> <span className="muted small">{s.email}</span></td><td className="muted small" style={{ textAlign: 'right', paddingRight: 0 }}>{s.completed_at ? fmtDate(s.completed_at, true) : ''}</td></tr>)}
            </tbody></table>
            <div className="small" style={{ marginTop: 10 }}>Audit trail: {res.chain.ok ? `intact, ${res.chain.events} events` : 'BROKEN. The history has been altered.'}</div>
            <div className="mono muted" style={{ marginTop: 6 }}>Envelope {res.envelope.id}<br />SHA-256 {res.hash}</div>
          </div>
        )}
        {res && !res.match && (
          <div className="card" style={{ marginTop: 18, borderColor: 'var(--red)' }}>
            <div className="badge declined">No match</div>
            <p style={{ margin: '10px 0 6px' }}><b>{res.name}</b> is not a completed document from this service, or it was changed after signing.</p>
            <p className="muted small" style={{ margin: 0 }}>Make sure you have the original download, not a re-saved, printed or scanned copy. Those have a different fingerprint.</p>
            <div className="mono muted" style={{ marginTop: 8 }}>SHA-256 {res.hash}</div>
          </div>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
