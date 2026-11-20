'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, useLoad, fmtDate, toast } from '@/components/ui';
import { Dialog } from '@/components/sender/Dialog';
import { ConfirmDialog } from '@/components/sender/dialogs';
import { fail } from '@/components/sender/feedback';
import { explain, looksLikeEmail } from '@/components/sender/lib';

export default function Templates() {
  const router = useRouter();
  const [data, reload, error] = useLoad<any>(() => api('/envelopes?kind=template'));
  const [use, setUse] = useState<any>(null);
  const [fill, setFill] = useState<Record<string, { name: string; email: string }>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [deleting, setDeleting] = useState<any>(null);

  async function start(t: any) {
    try {
      const { envelope } = await api(`/envelopes/${t.id}`);
      const open = envelope.recipients.filter((r: any) => !r.email);
      setFill(Object.fromEntries(open.map((r: any) => [r.id, { name: '', email: '' }])));
      setProblem('');
      setUse({ ...envelope, open });
    } catch (e) {
      fail(e);
    }
  }
  async function create(send: boolean) {
    if (send) {
      const gap = use.open.find((r: any) => !fill[r.id]?.name.trim() || !looksLikeEmail((fill[r.id]?.email || '').trim()));
      if (gap) return setProblem(`Add a name and a full email address for ${gap.role_name || 'every recipient'} before sending. To finish it later, choose Review first.`);
    }
    setBusy(true);
    setProblem('');
    try {
      const { envelope } = await api('/envelopes', { body: { template_id: use.id, recipients: fill, send } });
      toast(send ? 'Sent.' : 'Draft created.');
      router.push(send ? `/app/envelopes/${envelope.id}` : `/app/envelopes/${envelope.id}/edit`);
    } catch (e) {
      setProblem(explain(e));
    } finally {
      setBusy(false);
    }
  }

  const rows: any[] = data?.envelopes || [];
  return (
    <div className="sn">
      <div className="pagehead">
        <div><h1 className="serif">Templates</h1><div className="muted">Set a document up once, then send it again in seconds. Shared with your whole team.</div></div>
        <Link href="/app/envelopes/new?kind=template" className="btn primary">New template</Link>
      </div>
      <div className="card pad0">
        {error ? (
          <div className="empty" role="alert"><h3>We could not load your templates</h3>Check your connection, then try again.<div style={{ marginTop: 14 }}><button className="btn" onClick={reload}>Try again</button></div></div>
        ) : !data ? (
          <div className="empty" role="status">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty"><h3>No templates yet</h3>Good for contracts, NDAs, waivers and anything else you send more than once.<div style={{ marginTop: 14 }}><Link href="/app/envelopes/new?kind=template" className="btn primary">Create your first template</Link></div></div>
        ) : (
          <div className="tablewrap"><table className="t sn-list">
            <thead><tr><th>Template</th><th className="hide-sm">Roles</th><th className="hide-sm">Pages</th><th className="hide-sm">Updated</th><th className="hide-sm"><span className="sn-vh">Actions</span></th></tr></thead>
            <tbody>
              {rows.map((t) => {
                const name = t.subject || 'Untitled template';
                const roles = t.recipients.map((r: any) => r.role_name || r.name).filter(Boolean).join(', ') || 'None yet';
                const fillable = t.recipients.some((r: any) => !r.email);
                return (
                  <tr key={t.id}>
                    <td className="sn-main">
                      <b>{name}</b>
                      <div className="muted small">by {t.sender}</div>
                      <div className="muted small sn-only-sm">Roles: {roles} · {t.pages} page{t.pages === 1 ? '' : 's'}</div>
                      <div className="sn-only-sm sn-inlineactions">
                        <button className="btn sm primary" onClick={() => start(t)} aria-label={`Use ${name}`}>Use</button>
                        {fillable && <Link className="btn sm" href={`/app/bulk?template=${t.id}`} aria-label={`Send ${name} to a list`}>Send to a list</Link>}
                        <Link className="btn sm" href={`/app/templates/${t.id}/edit`} aria-label={`Edit ${name}`}>Edit</Link>
                        <button className="btn sm ghost danger" onClick={() => setDeleting(t)} aria-label={`Delete ${name}`}>Delete</button>
                      </div>
                    </td>
                    <td className="small hide-sm">{roles}</td>
                    <td className="hide-sm num">{t.pages}</td>
                    <td className="hide-sm muted small">{fmtDate(t.updated_at)}</td>
                    <td className="sn-rowactions hide-sm">
                      <button className="btn sm primary" onClick={() => start(t)} aria-label={`Use ${name}`}>Use</button>
                      {fillable && <Link className="btn sm" href={`/app/bulk?template=${t.id}`} aria-label={`Send ${name} to a list`}>Send to a list</Link>}
                      <Link className="btn sm" href={`/app/templates/${t.id}/edit`} aria-label={`Edit ${name}`}>Edit</Link>
                      <button className="btn sm ghost danger" onClick={() => setDeleting(t)} aria-label={`Delete ${name}`}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>

      {use && (
        <Dialog title={`Use "${use.subject || 'template'}"`} onClose={() => setUse(null)}>
          <form onSubmit={(e) => (e.preventDefault(), create(true))}>
            {use.open.length === 0 && <p className="muted">Everyone who signs is already set in this template. Send it as it is, or review it first.</p>}
            {use.open.map((r: any, i: number) => (
              <fieldset key={r.id} className="sn-rolefill">
                <legend>{r.role_name || `Recipient ${i + 1}`}</legend>
                <label className="f"><span>Full name</span><input value={fill[r.id]?.name || ''} onChange={(e) => (setProblem(''), setFill({ ...fill, [r.id]: { ...fill[r.id], name: e.target.value } }))} autoComplete="off" data-autofocus={i === 0 ? '' : undefined} /></label>
                <label className="f"><span>Email</span><input type="email" value={fill[r.id]?.email || ''} onChange={(e) => (setProblem(''), setFill({ ...fill, [r.id]: { ...fill[r.id], email: e.target.value } }))} autoComplete="off" /></label>
              </fieldset>
            ))}
            {problem && <div className="notice err" role="alert">{problem}</div>}
            <div className="actions">
              <button type="button" className="btn" disabled={busy} onClick={() => create(false)}>Review first</button>
              <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Working…' : 'Send now'}</button>
            </div>
          </form>
        </Dialog>
      )}

      {deleting && (
        <ConfirmDialog title="Delete this template" confirmLabel="Delete template" onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/envelopes/${deleting.id}`, { method: 'DELETE' });
            toast('Template deleted.');
            setDeleting(null);
            reload();
          }}>
          <p>&ldquo;{deleting.subject || 'Untitled template'}&rdquo; will be removed for your whole team. Envelopes already sent from it are not affected.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
