'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, useLoad, Status, fmtDate, Modal, oops, toast, ROLE_LABEL, Leaf } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { fmtNum, fmtTrees, impactOf } from '@/lib/impact';

const DONE: Record<string, string> = { signer: 'Signed', inperson: 'Signed', approver: 'Approved', viewer: 'Viewed', cc: 'Copied' };

export default function EnvelopeDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const me = useMe();
  const [data, reload, error] = useLoad(() => api(`/envelopes/${id}`), [id]);
  const [modal, setModal] = useState<'' | 'void' | 'correct'>('');
  const [reason, setReason] = useState('');
  const [fix, setFix] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      reload();
    } catch (e) {
      oops(e);
    } finally {
      setBusy(false);
    }
  };
  const signNow = (r: any) => act(async () => {
    const { url } = await api(`/envelopes/${id}/recipient-view`, { body: { recipient_id: r.id } });
    window.location.href = url;
  });

  if (error) return <div className="card center"><h2>Envelope not found</h2><p className="muted">It may have been deleted, or it belongs to someone else on your team.</p><Link href="/app/envelopes" className="btn">Back to envelopes</Link></div>;
  if (!data) return <div className="muted">Loading…</div>;
  const e = data.envelope;
  const isTpl = e.kind === 'template';
  const impact = impactOf(e.sheets);
  const pages = e.documents.reduce((n: number, d: any) => n + d.pages, 0);

  return (
    <div className="stack">
      <div className="pagehead" style={{ marginBottom: 0 }}>
        <div>
          <Link href={isTpl ? '/app/templates' : '/app/envelopes'} className="small">← {isTpl ? 'Templates' : 'Envelopes'}</Link>
          <h1 className="serif" style={{ marginTop: 4 }}>{e.subject || 'Untitled'}</h1>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <Status s={e.status} />
            <span className="muted small">Envelope {e.id}{e.sent_at ? ` · sent ${fmtDate(e.sent_at, true)}` : ''}{e.status === 'sent' && e.expires_at ? ` · expires ${fmtDate(e.expires_at)}` : ''}</span>
          </div>
        </div>
        <div className="row wrap">
          {e.status === 'draft' && <Link href={`/app/${isTpl ? 'templates' : 'envelopes'}/${e.id}/edit`} className="btn primary">Continue editing</Link>}
          {e.documents.length > 0 && <a className="btn" href={`/api/envelopes/${e.id}/download?inline=1`} target="_blank" rel="noreferrer">{e.status === 'completed' ? 'View signed PDF' : 'Preview PDF'}</a>}
          {e.status === 'completed' && <a className="btn primary" href={`/api/envelopes/${e.id}/download`}>Download with certificate</a>}
          {e.status === 'sent' && <button className="btn" disabled={busy} onClick={() => act(() => api(`/envelopes/${e.id}/remind`, { method: 'POST' }), 'Reminder sent')}>Send reminder</button>}
          {e.status === 'sent' && <button className="btn danger" onClick={() => setModal('void')}>Void</button>}
          <button className="btn" disabled={busy} onClick={() => act(async () => { const r = await api(`/envelopes/${e.id}/clone`, { body: { kind: 'envelope' } }); router.push(`/app/envelopes/${r.id}/edit`); })}>{isTpl ? 'Use' : 'Clone'}</button>
          {!isTpl && <button className="btn" disabled={busy} onClick={() => act(async () => { const r = await api(`/envelopes/${e.id}/clone`, { body: { kind: 'template' } }); router.push(`/app/templates/${r.id}/edit`); })}>Save as template</button>}
          {e.status !== 'sent' && <button className="btn ghost danger" disabled={busy} onClick={() => window.confirm('Delete this for good? This cannot be undone.') && act(async () => { await api(`/envelopes/${e.id}`, { method: 'DELETE' }); router.push(isTpl ? '/app/templates' : '/app/envelopes'); })}>Delete</button>}
        </div>
      </div>

      {e.status === 'voided' && <div className="notice err">Voided. Reason: {e.void_reason}</div>}
      {e.status === 'completed' && (
        <div className="card row" style={{ background: 'var(--green-soft)', borderColor: '#cfe3d2', alignItems: 'flex-start' }}>
          <Leaf size={26} color="#1f6f43" />
          <div><b>Completed without paper.</b> About {fmtNum(impact.sheets)} sheets, {fmtNum(impact.litresWater)} litres of water and {fmtNum(impact.kgCo2, 2)} kg of CO2e not used ({fmtTrees(impact.trees)} of a tree).</div>
        </div>
      )}

      <div className="card pad0">
        <div style={{ padding: '14px 16px' }}><h2>Recipients</h2></div>
        <div className="tablewrap"><table className="t">
          <thead><tr>{!!e.ordered && <th>Order</th>}<th>Name</th><th>Action</th><th>Status</th><th /></tr></thead>
          <tbody>
            {e.recipients.map((r: any) => {
              const open = e.status === 'sent' && (r.status === 'sent' || r.status === 'viewed');
              const isMe = r.email.toLowerCase() === me.user.email.toLowerCase();
              return (
                <tr key={r.id}>
                  {!!e.ordered && <td className="num">{r.routing_order}</td>}
                  <td><b>{r.name || r.role_name}</b><div className="muted small">{r.email}{r.reassigned_from ? ` · reassigned from ${r.reassigned_from}` : ''}</div></td>
                  <td>{ROLE_LABEL[r.role]}{r.access_code ? <div className="muted small">Access code: {r.access_code}</div> : null}</td>
                  <td>
                    <Status s={r.status} label={r.status === 'completed' ? DONE[r.role] : r.status === 'sent' ? 'Sent' : r.status === 'pending' ? (e.status === 'draft' ? 'Not sent' : 'Waiting for turn') : undefined} />
                    <div className="muted small">{fmtDate(r.completed_at || r.viewed_at || r.sent_at, true)}{r.decline_reason ? ` · ${r.decline_reason}` : ''}</div>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {open && (isMe || r.role === 'inperson') && <button className="btn sm primary" onClick={() => signNow(r)}>{r.role === 'inperson' ? 'Host signing' : 'Sign now'}</button>}{' '}
                    {open && !isMe && r.role !== 'inperson' && <button className="btn sm ghost" onClick={() => act(async () => { const { url } = await api(`/envelopes/${id}/recipient-view`, { body: { recipient_id: r.id } }); await navigator.clipboard.writeText(url); }, 'Signing link copied')}>Copy link</button>}
                    {e.status === 'sent' && r.status !== 'completed' && <button className="btn sm ghost" onClick={() => (setFix({ recipient_id: r.id, name: r.name, email: r.email, access_code: r.access_code || '' }), setModal('correct'))}>Correct</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h2 style={{ marginBottom: 10 }}>Documents</h2>
          {e.documents.map((d: any) => <div key={d.id} className="row between" style={{ padding: '5px 0' }}><span className="truncate">{d.name}</span><span className="muted small">{d.pages} page{d.pages === 1 ? '' : 's'}</span></div>)}
          <div className="muted small" style={{ marginTop: 8 }}>{pages} pages · {e.fields.length} fields · {e.ordered ? 'signed in order' : 'everyone at once'}</div>
          {e.message && <p className="muted" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>&ldquo;{e.message}&rdquo;</p>}
        </div>
        <div className="card">
          <div className="row between"><h2>Audit trail</h2><span className={`badge ${data.chain.ok ? 'completed' : 'declined'}`}>{data.chain.ok ? 'Chain intact' : 'Chain broken'}</span></div>
          <div style={{ marginTop: 10, maxHeight: 320, overflow: 'auto' }}>
            {data.audit.length === 0 && <div className="muted small">Nothing has happened yet.</div>}
            {data.audit.map((a: any) => (
              <div key={a.seq} style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <div className="row between"><b className="small">{a.action}</b><span className="muted small">{fmtDate(a.at, true)}</span></div>
                <div className="muted small">{a.detail}</div>
                <div className="muted mono" style={{ fontSize: 11 }}>{a.actor}{a.ip ? ` · ${a.ip}` : ''} · {a.hash.slice(0, 12)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {modal === 'void' && (
        <Modal title="Void this envelope" onClose={() => setModal('')}>
          <p className="muted">Nobody will be able to sign it any more. Recipients who already have it will be told why.</p>
          <label className="f"><span>Reason</span><textarea value={reason} onChange={(ev) => setReason(ev.target.value)} autoFocus /></label>
          <div className="actions">
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn primary" style={{ background: 'var(--red)', borderColor: 'var(--red)' }} disabled={busy || !reason.trim()} onClick={() => act(() => api(`/envelopes/${e.id}/void`, { body: { reason } }), 'Envelope voided').then(() => setModal(''))}>Void envelope</button>
          </div>
        </Modal>
      )}
      {modal === 'correct' && fix && (
        <Modal title="Correct recipient" onClose={() => setModal('')}>
          <p className="muted">Fix a typo or send it to a different address. The old link stops working and a new email goes out.</p>
          <label className="f"><span>Name</span><input value={fix.name} onChange={(ev) => setFix({ ...fix, name: ev.target.value })} /></label>
          <label className="f"><span>Email</span><input type="email" value={fix.email} onChange={(ev) => setFix({ ...fix, email: ev.target.value })} /></label>
          <label className="f"><span>Access code <span className="hint">(optional)</span></span><input value={fix.access_code} onChange={(ev) => setFix({ ...fix, access_code: ev.target.value })} /></label>
          <div className="actions">
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={() => act(() => api(`/envelopes/${e.id}/correct`, { body: fix }), 'Recipient updated').then(() => setModal(''))}>Save and resend</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
